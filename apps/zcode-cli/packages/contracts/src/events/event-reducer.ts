/**
 * ============================================================================
 * contracts/events/event-reducer.ts —— 事件溯源的会话投影
 * ============================================================================
 *
 * 【定位】SessionProjection 不是"从 message 表拼出来的 UI 状态"，而是把持久化的
 *   SessionEvent 流依次喂给本 reducer 得到的状态快照。同一条 apply 既被 live 增量
 *   更新使用，也被冷启动/恢复时的全量 reduce 使用，所以它是 live 与 cold 路径的
 *   唯一事实来源。
 *
 * 【链路位置】
 *   session store.append(event) ──(live)──▶ apply(projection, event)
 *   readSession(全量事件) ───────(cold)──▶ reduce(events)        → getTaskSnapshot/UI
 *
 * 【每个 handler 必须满足的约束】
 *   - 幂等/可重放：同一事件重复到达（例如恢复重放）不能把计数、数组、状态翻倍或倒退；
 *   - 纯函数：不修改 event/payload，也不原地改 projection，总是返回新对象；
 *   - 未知事件：只推进 updatedAt，不改变语义状态（向前兼容新增事件类型）。
 *
 * 【为什么错误状态也要进 projection】
 *   projection 是重启/恢复链路的数据来源。若 lastError 只存在内存里，重启后用户
 *   看不到失败原因；若只保留文案，遥测与 task meta 又无法区分 provider 拒绝。
 *   因此这里的字段口径必须与 TurnError payload 一一对应。
 *
 * 【维护提示】
 *   新增事件类型时：先加 handler，再确认 (1) 旧数据缺字段时的降级行为，
 *   (2) 重复事件的合并键（verificationId/toolCallId/pendingInputId），
 *   (3) 是否会影响 status（只有 turn 级事件才能把 session 置回 idle）。
 * ============================================================================
 */

import type {
  SessionEvent,
  SessionCreatedPayload,
  SessionCompactedPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDrainedPayload,
  TurnSteerDeliveryChangedPayload,
  TurnSteerQueuedPayload,
  TurnSteerReorderedPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolCallResultPayload,
  ToolCallErrorPayload,
  ToolBatchCompletePayload,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
  BackgroundTaskCompletedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PermissionDeniedPayload,
  ModelCompletePayload,
  SessionModeChangedPayload,
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
} from "./session.events.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";
import { SessionEventType as EventTypes } from "./session.events.js";
import { getModelUsageContextTokens } from "../model/index.js";
import { parseCheckpointCreatedPayload, parseRewindTriggeredPayload } from "../rewind/index.js";
import {
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  failedGoalCompletionVerification,
  parseGoalCompletionVerificationText,
} from "../tools/target.js";
import type {
  ActiveToolCall,
  PendingPermission,
  SessionProjection,
  SessionStatus,
} from "../interfaces/session.port.js";
import {
  applyBackgroundTaskCompleted,
  applyBackgroundTaskStarted,
  applyBackgroundTaskUpdated,
  applyCompactBoundary,
  applyStreamRecoveryAnchorCreated,
  applyStreamingToolLedgerUpdate,
  initialSessionProjection,
} from "./event-reducer-helpers.js";

/**
 * 判断一次 ModelComplete 是否应刷新输入栏的 contextUsed。
 *
 * 只有主会话请求（querySource === "main_turn"）代表"用户当前上下文"；
 * 标题生成、压缩摘要、子代理、工具内部模型调用都只是 sidecar 请求，
 * 它们的 input token 往往是几十到几百，若是覆盖主 session 会让 UI 显示
 * 89/1m 这类误导值。
 *
 * 旧数据兼容：历史事件可能没有 querySource，此时用 stopReason 反推——
 * 标了 tool_internal 的一律不认，其余视为旧版主会话。
 */
function shouldModelCompleteUpdateContextUsed(payload: ModelCompletePayload): boolean {
  if (payload.querySource !== undefined) {
    return payload.querySource === "main_turn";
  }

  // 兼容旧版主会话事件没有 querySource 的历史数据；工具/子任务内部模型调用
  // 过去也可能缺这个字段，但 stopReason 会标成 tool_internal，不能拿来覆盖主 session。
  return payload.stopReason !== "tool_internal";
}

// -----------------------------------------------
// Event Reducer
// -----------------------------------------------

/**
 * 事件 → 会话投影的纯函数归约器。
 *
 * 固化的事实：给定"同一批 SessionEvent"，只能得到唯一的 SessionProjection。
 * 生产者：core 的 appendEvent 在 live 路径逐条调用 apply；resume/冷启动把
 * readSession 读出的全量事件交给 reduce。消费者：UI/TaskSnapshot、remote 投影、
 * 续跑判断都读 projection，而不是另拼一份 message 状态。
 *
 * 跨进程/持久化不变量：handlers 是常量映射表，reducer 本身无状态，可被任意调用点
 * 独立实例化；apply 不得原地修改入参 projection/event，只能返回新对象。事件里
 * 缺失的旧字段必须降级（parse helper/undefined 兜底），不能假设当前版本 schema。
 */
export class EventReducer {
  /**
   * 冷路径：把整条事件流折叠成最终 projection。
   *
   * 初始 id 取首个事件的 sessionId（而不是等 SessionCreated handler），原因是
   * 旧会话可能缺少 session_created 事件；空事件流则退化为 "unknown"，调用方
   * 应视为"没有可恢复的会话"而不是崩溃。
   */
  reduce(events: SessionEvent[]): SessionProjection {
    return events.reduce((projection, event) => this.apply(projection, event), {
      ...initialSessionProjection,
      id: events[0]?.sessionId ?? ("unknown" as any),
    } as SessionProjection);
  }

  /**
   * 热路径/单步重放：按 event.type 分发到 handler。
   *
   * 未知事件只推进 updatedAt：这样旧版本读到新版本写入的事件时仍能正常恢复，
   * 只是该事件的语义字段暂时不可见（向前兼容的代价，而不是直接报错）。
   */
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
    const handler = this.handlers[event.type];
    if (handler) {
      return handler(projection, event);
    }
    return {
      ...projection,
      updatedAt: event.timestamp,
    };
  }

  private handlers: Record<
    string,
    (projection: SessionProjection, event: SessionEvent) => SessionProjection
  > = {
    // 会话诞生：重置 id/模式/上下文窗口，并把状态显式落到 idle。
    // 重复重放时这些字段会被同一条事件覆盖成相同值，因此是幂等的。
    [EventTypes.SessionCreated]: (p, e) => {
      const payload = e.payload as SessionCreatedPayload;
      return {
        ...p,
        id: e.sessionId,
        mode: payload.mode,
        planEnabled: payload.planEnabled ?? payload.mode === "plan",
        contextWindow: payload.contextWindow,
        createdAt: e.timestamp,
        updatedAt: e.timestamp,
        status: "idle" as SessionStatus,
      };
    },

    [EventTypes.TurnStarted]: (p, e) => {
      return {
        ...p,
        currentTurnId: e.turnId,
        // 上一轮 provider 失败会写入 projection.lastError；新一轮消息被接受后，
        // 旧错误不再是当前任务事实。必须在源头清理，避免 readSession/getTaskSnapshot 反复恢复旧横幅。
        lastError: undefined,
        turnCount: p.turnCount + 1,
        status: "running" as SessionStatus,
        updatedAt: e.timestamp,
      };
    },

    // 两个压缩入口：
    //   - session_compacted：持久化的终态事件（payload 里带 compactBoundary 快照）；
    //   - compact_boundary：兼容旧版/流式的边界事件。
    // 二者都委托同一个 helper，保证 live 与 cold 得到同一套 boundary 字段。
    [EventTypes.SessionCompacted]: (p, e) => {
      const payload = e.payload as SessionCompactedPayload;
      return applyCompactBoundary(p, payload.compactBoundary, e.timestamp);
    },

    // 模式切换（plan/normal/yolo）。
    // permissionGrant 是"用户在权限弹窗里一次性放行整批排队输入"的授权结果：
    // 对应队列项的 intent.mode 必须就地升级成 yolo，否则 runtime 冷重建后
    // 这些输入会退回只读模式，用户明明授权了却仍被拦住。
    [EventTypes.SessionModeChanged]: (p, e) => {
      const payload = e.payload as SessionModeChangedPayload;
      return {
        ...p,
        ...(payload.permissionGrant
          ? {
              pendingSteerInputs: p.pendingSteerInputs.map((item) =>
                payload.permissionGrant!.queueItemIds.includes(item.pendingInputId) && item.intent
                  ? { ...item, intent: { ...item.intent, mode: "yolo" as const } }
                  : item,
              ),
            }
          : {}),
        mode: payload.mode,
        planEnabled: payload.planEnabled ?? payload.mode === "plan",
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.CompactBoundary]: (p, e) => {
      return applyCompactBoundary(p, e.payload, e.timestamp);
    },

    // checkpoint：只保留"最近一次"指针（lastCheckpoint），历史 checkpoint 由
    // checkpoint store 自己维护。用 parse helper 而不是裸 cast，是为了兼容旧
    // payload 形状的字段缺省。
    [EventTypes.CheckpointCreated]: (p, e) => {
      const payload = parseCheckpointCreatedPayload(e.payload);
      return {
        ...p,
        lastCheckpoint: {
          checkpointId: payload.checkpointId,
          compactBoundaryId: payload.compactBoundaryId,
          coveredByCompact: payload.coveredByCompact,
          createdAt: e.timestamp,
          fileCount: payload.fileCount,
          messageId: payload.messageId,
          targetMessageId: payload.targetMessageId,
          toolMessageId: payload.toolMessageId,
          scope: payload.scope,
          snapshotRef: payload.snapshotRef,
        },
        updatedAt: e.timestamp,
      };
    },

    // rewind 与 checkpoint 对称：projection 只记最近一次回滚的目标与策略，
    // 供 UI/下次恢复判断"当前时间线是否已被回退过"。
    [EventTypes.RewindTriggered]: (p, e) => {
      const payload = parseRewindTriggeredPayload(e.payload);
      return {
        ...p,
        lastRewind: {
          compactBoundaryId: payload.compactBoundaryId,
          reason: payload.reason,
          rewindId: payload.rewindId,
          scope: payload.scope,
          strategy: payload.strategy,
          targetCheckpointId: payload.targetCheckpointId,
          targetMessageId: payload.targetMessageId,
          triggeredAt: e.timestamp,
        },
        updatedAt: e.timestamp,
      };
    },

    // 只有 turn_complete 能把 session 置回 idle 并累加总 token；
    // tool_batch_complete 不算（见下方 handler 注释），否则工具批次之间
    // 会话会被错误地显示成"空闲"。
    [EventTypes.TurnComplete]: (p, e) => {
      const payload = e.payload as TurnCompletePayload;
      return {
        ...p,
        status: "idle" as SessionStatus,
        totalTokenCount: p.totalTokenCount + payload.tokenCount,
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.ModelComplete]: (p, e) => {
      const payload = e.payload as ModelCompletePayload;
      if (payload.querySource === GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE) {
        return {
          ...p,
          targetCompletionVerifications: [
            ...p.targetCompletionVerifications,
            parseGoalCompletionVerificationText(payload.content),
          ],
          updatedAt: e.timestamp,
        };
      }
      // 输入栏 context usage 只代表主会话发给 provider 的最新上下文。
      // 标题生成、压缩摘要、子代理和工具内部模型调用都不是当前主 session 的可见上下文，
      // 如果用它们的 usage 覆盖 projection，UI 会显示成 89/1m 这类 sidecar 小请求。
      if (!shouldModelCompleteUpdateContextUsed(payload)) {
        return {
          ...p,
          updatedAt: e.timestamp,
        };
      }
      // AI SDK v6 的 provider input 已经是 total input（含 cache read/write）；
      // 这里通过统一 helper 计算 context used，避免各处重复理解 cache breakdown。
      const contextUsed = getModelUsageContextTokens(payload.usage);
      return {
        ...p,
        ...(contextUsed !== undefined ? { contextUsed } : {}),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.StreamingToolLedgerUpdated]: (p, e) => {
      return applyStreamingToolLedgerUpdate(
        p,
        e.payload as StreamingToolLedgerPayload,
        e.timestamp,
      );
    },

    [EventTypes.StreamRecoveryAnchorCreated]: (p, e) => {
      return applyStreamRecoveryAnchorCreated(
        p,
        e.payload as StreamRecoveryAnchorPayload,
        e.timestamp,
      );
    },

    // 目标（goal）变更。只有"换成了不同 targetID"才清空历史校验记录；
    // 同一目标的编辑（改描述、改状态）必须保留已累计的校验时间线，
    // 否则用户每改一次目标文案，UI 上的完成校验进度就被抹掉。
    [EventTypes.TargetChanged]: (p, e) => {
      const payload = e.payload as TargetChangedPayload;
      const targetChanged =
        payload.action === "set" && payload.previousTarget?.targetID !== payload.target?.targetID;
      return {
        ...p,
        target: payload.target,
        targetCompletionVerifications: targetChanged ? [] : p.targetCompletionVerifications,
        targetCompletionVerificationTimeline: targetChanged
          ? []
          : p.targetCompletionVerificationTimeline,
        updatedAt: e.timestamp,
      };
    },

    // 目标完成校验的生命周期事件（started / completed / failed_closed / cancelled）。
    // 合并键是"target + goalIteration"，而不是 verificationId：
    // started 与 completed 可能是两次不同 id 的尝试，但 UI 上属于同一轮校验，
    // 必须合并成一条时间线条目；只有 failed_closed/cancelled 才额外补一条摘要，
    // 因为它们没有对应的 model_complete 结果事件。
    [EventTypes.TargetCompletionVerification]: (p, e) => {
      const payload = e.payload as TargetCompletionVerificationPayload;
      const existing = p.targetCompletionVerificationTimeline.find(
        (item) =>
          item.verificationId === payload.verificationId ||
          (payload.goalIteration !== undefined &&
            item.targetId === payload.targetId &&
            item.goalIteration === payload.goalIteration),
      );
      const startedAt =
        existing?.startedAt ?? (payload.status === "started" ? e.timestamp : undefined);
      // goal 校验的 UI 身份是 target + iteration；verificationId 只是单次尝试。
      // started/completed 或恢复重放如果只按 verificationId 合并，会把同一轮目标校验追加成多条横线。
      const goalIteration =
        payload.goalIteration ??
        existing?.goalIteration ??
        p.targetCompletionVerificationTimeline.length + 1;
      const nextTimelineItem = {
        targetId: payload.targetId,
        status: payload.status,
        verificationId: payload.verificationId,
        ...(payload.verification ? { verification: payload.verification } : {}),
        goalIteration,
        ...((payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId)
          ? {
              anchorAssistantMessageId:
                payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId,
            }
          : {}),
        ...((payload.anchorTurnId ?? existing?.anchorTurnId)
          ? { anchorTurnId: payload.anchorTurnId ?? existing?.anchorTurnId }
          : {}),
        ...(startedAt ? { startedAt } : {}),
        updatedAt: e.timestamp,
      };
      const nextTimeline = existing
        ? p.targetCompletionVerificationTimeline.map((item) =>
            item === existing ? nextTimelineItem : item,
          )
        : [...p.targetCompletionVerificationTimeline, nextTimelineItem];
      return {
        ...p,
        // failed_closed/cancelled 没有 model_complete 结果事件，必须把 lifecycle 结论补进摘要账本；
        // 正常 completed 继续由既有 model_complete 投影，避免新旧事件把同一次校验计两遍。
        targetCompletionVerifications:
          payload.status === "failed_closed" || payload.status === "cancelled"
            ? [
                ...p.targetCompletionVerifications,
                payload.verification ??
                  failedGoalCompletionVerification(
                    "The completion verifier did not return a persisted result.",
                  ),
              ]
            : p.targetCompletionVerifications,
        targetCompletionVerificationTimeline: nextTimeline,
        updatedAt: e.timestamp,
      };
    },

    // 轮次失败：状态置 error，并把错误完整投影到 lastError。
    // attribution（provider/network 等归因）必须保留，它是 live 与 cold
    // 两条路径的共同事实，缺失会让遥测误判为普通应用错误。
    // 注意：这条错误会在下一次 TurnStarted 时被清掉，不会跨轮残留。
    [EventTypes.TurnError]: (p, e) => {
      const payload = e.payload as TurnErrorPayload;
      return {
        ...p,
        status: "error" as SessionStatus,
        // projection 是重启/恢复链路的数据来源，必须保留真实 provider/subagent 根因。
        lastError: {
          type: payload.error.type,
          ...(payload.error.code ? { code: payload.error.code } : {}),
          message: payload.error.message,
          ...(payload.error.detail ? { detail: payload.error.detail } : {}),
          // TurnError 的 provider/network 归因是 live 与 cold projection 的共同事实；
          // 旧 reducer 只保留文案和 code，导致后续 task meta/telemetry 无法区分 provider 拒绝。
          ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
        },
        updatedAt: e.timestamp,
      };
    },

    // steering 入队（含"编辑排队项"）：同 pendingInputId 重发时按"就地更新"处理。
    // 累加型字段（queuedAt、数组位置）保留旧值，内容型字段以新 payload 为准；
    // 这样编辑器改文案不会把该输入当成新入场排到队尾。
    [EventTypes.TurnSteerQueued]: (p, e) => {
      const payload = e.payload as TurnSteerQueuedPayload;
      const existingIndex = p.pendingSteerInputs.findIndex(
        (item) => item.pendingInputId === payload.pendingInputId,
      );
      const existing = existingIndex >= 0 ? p.pendingSteerInputs[existingIndex] : undefined;
      const next = {
        pendingInputId: payload.pendingInputId,
        input: payload.input,
        inputPreview: payload.inputPreview,
        inputSize: payload.inputSize,
        commandKind: payload.commandKind ?? existing?.commandKind,
        source: payload.source ?? existing?.source,
        inputPresentation: payload.inputPresentation ?? existing?.inputPresentation,
        intent: payload.intent ?? existing?.intent,
        toolDisallowlist: payload.toolDisallowlist ?? existing?.toolDisallowlist,
        // editQueueItem 会以同 id 重发 queued 事件；编辑不是重新 admission，
        // 必须保留原排队时间和数组位置，否则 runtime 冷重建会把它移到队尾。
        queuedAt: existing?.queuedAt ?? e.timestamp,
        targetTurnId: payload.targetTurnId,
        traceId: e.traceId,
      };
      return {
        ...p,
        pendingSteerInputs:
          existingIndex >= 0
            ? p.pendingSteerInputs.map((item, index) => (index === existingIndex ? next : item))
            : [...p.pendingSteerInputs, next],
        updatedAt: e.timestamp,
      };
    },

    // 投递策略变更（steer 立即插入 vs queue 等下一轮）。
    // payload.intent 存在时整包替换；否则只改写 admittedDelivery/fallbackReasonCode，
    // 保留原有 intent 的其它字段（例如 mode、来源命令信息）。
    [EventTypes.TurnSteerDeliveryChanged]: (p, e) => {
      const payload = e.payload as TurnSteerDeliveryChangedPayload;
      return {
        ...p,
        pendingSteerInputs: p.pendingSteerInputs.map((item) =>
          item.pendingInputId === payload.pendingInputId
            ? {
                ...item,
                intent:
                  payload.intent ??
                  (item.intent
                    ? {
                        ...item.intent,
                        admittedDelivery: payload.admittedDelivery,
                        fallbackReasonCode: payload.fallbackReasonCode,
                      }
                    : undefined),
              }
            : item,
        ),
        updatedAt: e.timestamp,
      };
    },

    // 队列重排：按 orderedPendingInputIds 重排"已知项"，未出现在列表里的项
    // 原序追加在尾部（兼容并发新增/已删除 id 的旧快照）。
    // 重排后统一回写 queuePosition，保证 UI 与 runtime 看到的顺序一致。
    [EventTypes.TurnSteerReordered]: (p, e) => {
      const payload = e.payload as TurnSteerReorderedPayload;
      const byId = new Map(p.pendingSteerInputs.map((item) => [item.pendingInputId, item]));
      const orderedIds = new Set(payload.orderedPendingInputIds);
      const ordered = payload.orderedPendingInputIds.flatMap((id) => {
        const item = byId.get(id);
        return item ? [item] : [];
      });
      const rest = p.pendingSteerInputs.filter((item) => !orderedIds.has(item.pendingInputId));
      return {
        ...p,
        pendingSteerInputs: [...ordered, ...rest].map((item, queuePosition) => ({
          ...item,
          ...(item.intent ? { intent: { ...item.intent, queuePosition } } : {}),
        })),
        updatedAt: e.timestamp,
      };
    },

    // 已投递给模型（drained）：从待队列移除。与 discarded 的区别是语义：
    // drained 表示"输入已被本轮消费"，discarded 表示"用户主动撤回"，
    // 两者在 projection 上都只是出队，差别由上层审计/遥测使用事件类型区分。
    [EventTypes.TurnSteerDrained]: (p, e) => {
      const payload = e.payload as TurnSteerDrainedPayload;
      return {
        ...p,
        pendingSteerInputs: p.pendingSteerInputs.filter(
          (item) => !payload.pendingInputIds.includes(item.pendingInputId),
        ),
        updatedAt: e.timestamp,
      };
    },

    // 用户撤回/系统清理：与 drained 一样只做出队；不存在于队列里的 id 是 no-op。
    [EventTypes.TurnSteerDiscarded]: (p, e) => {
      const payload = e.payload as TurnSteerDiscardedPayload;
      return {
        ...p,
        pendingSteerInputs: p.pendingSteerInputs.filter(
          (item) => !payload.pendingInputIds.includes(item.pendingInputId),
        ),
        updatedAt: e.timestamp,
      };
    },

    // ── 工具调用生命周期：scheduled → started → result/error → batch_complete ──
    // projection 只保留"当前活跃"的工具调用，用于 UI 实时状态；
    // 已完成明细由 message/part 持久化承载，不在这里重复存。
    [EventTypes.ToolCallScheduled]: (p, e) => {
      const payload = e.payload as ToolCallScheduledPayload;
      const newToolCall: ActiveToolCall = {
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        status: "pending",
      };
      return {
        ...p,
        activeToolCalls: [...p.activeToolCalls, newToolCall],
        updatedAt: e.timestamp,
      };
    },

    // 开始执行：用 payload.startedAt（事件发生时刻），而不是 e.timestamp，
    // 便于流恢复时还原真实的执行起点。
    [EventTypes.ToolCallStarted]: (p, e) => {
      const payload = e.payload as ToolCallStartedPayload;
      return {
        ...p,
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId
            ? { ...tc, status: "running", startedAt: payload.startedAt }
            : tc,
        ),
        updatedAt: e.timestamp,
      };
    },

    // 工具返回：success=false 也走这条（业务失败但模型仍可继续），
    // 与 ToolCallError（执行链异常/中止）区分开来，二者都落 failed 状态。
    [EventTypes.ToolCallResult]: (p, e) => {
      const payload = e.payload as ToolCallResultPayload;
      return {
        ...p,
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId
            ? { ...tc, status: payload.result.success ? "completed" : "failed" }
            : tc,
        ),
        updatedAt: e.timestamp,
      };
    },

    // 执行链异常：只改状态，不写 lastError（工具失败不等于整个 turn 失败）。
    [EventTypes.ToolCallError]: (p, e) => {
      const payload = e.payload as ToolCallErrorPayload;
      return {
        ...p,
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId ? { ...tc, status: "failed" } : tc,
        ),
        updatedAt: e.timestamp,
      };
    },

    // 批次收尾：只清理本批次涉及的工具调用。
    // 注意这里**不**把 status 置 idle：工具批次结束后 turn 还会发起 follow-up
    // 模型请求，session 仍在 running；只有 turn_complete 才是真正的结束。
    [EventTypes.ToolBatchComplete]: (p, e) => {
      const payload = e.payload as ToolBatchCompletePayload;
      const activeToolCalls = p.activeToolCalls.filter(
        (tc) => !payload.toolCallIds.includes(tc.toolCallId as any),
      );
      return {
        ...p,
        activeToolCalls,
        // a tool batch can finish before the turn makes its follow-up model request.
        // Only turn_complete moves the session projection back to idle.
        updatedAt: e.timestamp,
      };
    },

    // ── 后台任务：started/updated/completed 由 helper 统一维护 ──
    // helper 负责"按 taskId upsert + 保留旧字段"的合并规则；
    // projection 只存任务摘要（状态/进度），完整日志与产物在后台任务存储里。
    [EventTypes.BackgroundTaskStarted]: (p, e) => {
      const payload = e.payload as BackgroundTaskStartedPayload;
      return applyBackgroundTaskStarted(p, payload, e.timestamp);
    },

    [EventTypes.BackgroundTaskUpdated]: (p, e) => {
      const payload = e.payload as BackgroundTaskUpdatedPayload;
      return applyBackgroundTaskUpdated(p, payload, e.timestamp);
    },

    [EventTypes.BackgroundTaskCompleted]: (p, e) => {
      const payload = e.payload as BackgroundTaskCompletedPayload;
      return applyBackgroundTaskCompleted(p, payload, e.timestamp);
    },

    // ── 权限弹窗生命周期 ──
    // requested：把请求完整快照进 pendingPermissions（含 UI 展示字段与策略），
    // 这样冷启动后仍能重建弹窗，而不是只看到"有工具卡住"。
    [EventTypes.PermissionRequested]: (p, e) => {
      const payload = e.payload as PermissionRequestedPayload;
      const newPending: PendingPermission = {
        input: payload.input,
        reason: payload.reason,
        requestId: payload.requestId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        ...(payload.approvalMode ? { approvalMode: payload.approvalMode } : {}),
        ...(payload.suggestedPermissionUpdates
          ? { suggestedPermissionUpdates: payload.suggestedPermissionUpdates }
          : {}),
        ...(payload.origin ? { origin: payload.origin } : {}),
        ...(payload.display ? { display: payload.display } : {}),
        ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
        riskLevel: payload.riskLevel,
        requestedAt: e.timestamp,
      };
      return {
        ...p,
        pendingPermissions: [...p.pendingPermissions, newPending],
        updatedAt: e.timestamp,
      };
    },

    // resolved：用户给出决定。按 toolCallId（而不是 requestId）清理，
    // 因为同一工具调用可能先后触发多次请求（rewrite 重判），
    // 用 requestId 过滤会残留旧的弹窗项。
    // 同步更新工具状态：allow→completed，deny→denied。
    [EventTypes.PermissionResolved]: (p, e) => {
      const payload = e.payload as PermissionResolvedPayload;
      let toolStatus: ActiveToolCall["status"] = "completed";
      if (payload.decision === "deny") {
        toolStatus = "denied";
      }

      return {
        ...p,
        pendingPermissions: p.pendingPermissions.filter(
          (pp) => pp.toolCallId !== payload.toolCallId,
        ),
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId ? { ...tc, status: toolStatus } : tc,
        ),
        updatedAt: e.timestamp,
      };
    },

    // denied：权限层直接拒绝（无需用户交互，如策略/信任态不满足）。
    // 与 resolved(deny) 的投影结果一致；保留两个事件类型是为了区分
    // "用户拒绝"与"系统拒绝"两种来源。
    [EventTypes.PermissionDenied]: (p, e) => {
      const payload = e.payload as PermissionDeniedPayload;
      return {
        ...p,
        pendingPermissions: p.pendingPermissions.filter(
          (pp) => pp.toolCallId !== payload.toolCallId,
        ),
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId ? { ...tc, status: "denied" } : tc,
        ),
        updatedAt: e.timestamp,
      };
    },
  };
}

// -----------------------------------------------
// Utility Functions
// -----------------------------------------------

/**
 * 便捷包装：每次调用新建一个无状态 reducer 再折叠全量事件。
 *
 * 消费方是冷恢复/离线快照（例如 resume 读完整事件流后只需终态）；不要把它
 * 放进逐事件热路径，否则每条事件都会重新构造 handlers 映射表。空事件流返回
 * id="unknown" 的基线投影，调用方必须据此判断"无会话可恢复"，不能当成有效会话。
 */
// 便捷包装：每次新建 reducer。reducer 本身无状态（handlers 只是固定映射表），
// 因此这两个导出可以安全地在任意线程/调用点独立使用。
export function reduce(events: SessionEvent[]): SessionProjection {
  return new EventReducer().reduce(events);
}

/**
 * 便捷包装：对单条事件做一次纯 apply。
 *
 * 生产者在 live 事件落库后调用，把同一条 event 喂给内存 projection；消费结果
 * 即 UI/远程投影看到的最新状态。它不写 store、不做副作用，重复调用同一
 * (projection,event) 必须得到相同结果——这是事件重放幂等的前提。
 */
export function apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
  return new EventReducer().apply(projection, event);
}
