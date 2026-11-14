// V4 交互弹窗竖切：把 projection.pendingInteractions 落到 PermissionDialog / ElicitationDialog / V4UserInputDialog。
// 只负责挑出本组件能渲染的那一个交互并代为 resolve；不负责投影生成、不负责 Settings/Hooks 页面渲染。
// 也不做 Agent 端超时裁决与答案持久化，权限结果只经命令通道回传。
//
// INV-01 断言：只有 kind 为 permission 或 userInput 的首个交互才会被渲染 —— 守住它的位置：pending 的 find —— 改错故障：workspaceHookReview 抢占后通用弹窗不再出现，带 tool 权限的会话永久挂起
// INV-02 断言：快照的 sessionId 必须与当前 sessionId 相等才可使用 —— 守住它的位置：getCurrentSessionInteractionSnapshot —— 改错故障：task 切换瞬间旧快照误清当前 task 的草稿，用户已填内容丢失
// INV-03 断言：Bot 逐题进度必须覆盖同一 requestId 的投影请求 —— 守住它的位置：resolveV4ElicitationRequest —— 改错故障：Bot 代答后弹窗回退到第一题，答案与题号错位
// INV-04 断言：弹窗 key 必须包含 requestId、题号与答案草稿 —— 守住它的位置：buildV4ElicitationProgressKey —— 改错故障：切题不重建组件，输入框残留上一题的文本
// INV-05 断言：workspaceHookReview 分支只能返回 null，不得降级成通用弹窗 —— 守住它的位置：该 kind 的提前返回 —— 改错故障：同一交互出现两个入口，应答与行内 Trust 状态分叉
// INV-06 断言：每个 interactionId 只允许发出一次自动结束暂停命令 —— 守住它的位置：IntentTracker 的 consumeSnooze —— 改错故障：重复发命令，Agent 侧计时被反复续命
// INV-07 断言：暂停命令失败必须撤销发送占位 —— 守住它的位置：releaseSnooze 的调用点 —— 改错故障：一次网络失败后该交互永远不再补发，自动结束不生效
// INV-08 断言：自动结束未就绪时不得消费本地意图 —— 守住它的位置：sendSnoozeOnce 的首个早退 —— 改错故障：就绪事件晚到一帧即被吞掉，用户操作后不会暂停计时
// INV-09 断言：权限应答必须用 flight 标记单飞 —— 守住它的位置：permissionResponseFlight —— 改错故障：双击同选项发出两条应答，第二条被拒后弹窗显示错误
// INV-10 断言：PermissionDialog 必须按 interactionId 重建 —— 守住它的位置：PermissionDialog 的 key —— 改错故障：连续权限请求复用焦点，回车落到新请求的错误选项
// INV-11 断言：resolveInteraction 必须先登记 registry 再发送 —— 守住它的位置：pendingCommandRegistry.record —— 改错故障：回执丢失后无法对账，命令结果永久未知
// INV-12 断言：只有 accepted、duplicate、noop 视为成功 —— 守住它的位置：accepted 的计算 —— 改错故障：把 rejected 当成功，弹窗关闭但交互仍在服务端挂起
// INV-13 断言：onCommandSettled 必须在 finally 中调用 —— 守住它的位置：resolveInteraction —— 改错故障：抛异常后 commandId 永不结算，pending 指标泄漏
// INV-14 断言：用户输入应答被接受后才清理草稿 —— 守住它的位置：onRespond 里的 removeElicitationDraft —— 改错故障：发送失败却清空草稿，用户被迫全部重填
// INV-15 断言：草稿剪枝只针对快照中已不存在的 requestId —— 守住它的位置：剪枝 effect —— 改错故障：误删仍待处理的问答草稿
// INV-16 断言：Bot 进度命中时必须丢弃本地初始草稿 —— 守住它的位置：initialFormDraft 表达式 —— 改错故障：已作答的题目被旧草稿覆盖
// INV-17 断言：workspaceHookReview 的连接与断开必须成对且按 sessionId 归属 —— 守住它的位置：connect 的 effect —— 改错故障：切换 task 后旧会话的审核请求继续写入 store
// INV-18 断言：任务通知必须拿到已校验的快照 —— 守住它的位置：usePendingInteractionTaskNotifications 入参 —— 改错故障：旧 task 的交互触发错误的系统通知
// INV-19 断言：exitPlanMode 只有应答被接受后才上报 —— 守住它的位置：onPlanInteractionAccepted 调用点 —— 改错故障：手机端依据未落地回执做恢复，状态来回抖动
// INV-20 断言：content 只随权限放行应答透传 —— 守住它的位置：onRespond 的 content 展开 —— 改错故障：拒绝分支携带配置改写，工作流设置被意外修改
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeElicitationRequest, ZCodePermissionOption, ZCodeProvider } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { workflowSessionModelOf } from "@/components/workflow-timeline/workflowRunSettings.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePendingInteractionTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { logger } from "@/logger.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import {
  getTaskUiState,
  getWorkspaceState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";
import {
  pendingPermissionToLegacyRequest,
  pendingUserInputToElicitationRequest,
  pendingUserInputToViewModel,
} from "@/v4/pendingInteractionAdapter.js";
import { V4UserInputDialog } from "@/v4/V4UserInputDialog.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

// [契约] 入参全部由上层 V4 容器注入，组件自身不订阅会话源、不读 transport
// snapshot 允许为 null，表示该 session 暂时没有可用投影，不是异常态
// 新增字段一律可选，避免破坏既有调用点的类型检查
export interface V4InteractionDialogsProps {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  isWebRemoteControl?: boolean;
  provider?: ZCodeProvider;
  snapshot: ConversationSnapshot | null;
  onCommandSettled?: (commandId: string) => void;
  onPlanInteractionAccepted?: (interactionId: string) => void;
}

// 纯函数只做 sessionId 校验，不读 store，便于在单测里直接构造快照
// [失败路径] 不匹配时返回 null 而不抛错：task 切换时快照滞后一帧属于正常竞态
// 返回 null 会让下游剪枝 effect 整体跳过，这是刻意保留的沉默行为
export function getCurrentSessionInteractionSnapshot(
  sessionId: string,
  snapshot: ConversationSnapshot | null,
): ConversationSnapshot | null {
  return snapshot?.sessionId === sessionId ? snapshot : null;
}

// [权衡] 用 requestId 相等判断「同一请求」，而不是整对象深度比较
// Bot 进度携带逐题答案，快照投影只带初始阻塞信息，二者 requestId 相同才是同一请求
// 只有 requestId 相同时才用进度覆盖投影，防止串到另一请求的答案
// [失败路径] 改成无条件优先进度时，尚未代答的请求会被替换成空进度并回退到第一题
export function resolveV4ElicitationRequest(
  projected: ZCodeElicitationRequest | null,
  botProgress: ZCodeElicitationRequest | null,
): ZCodeElicitationRequest | null {
  // Bugfix：V4 snapshot 只保留原始阻塞请求，Bot 代答后的逐题进度必须覆盖同一 request 的投影。
  if (projected && botProgress?.requestId === projected.requestId) {
    return botProgress;
  }
  return projected;
}

// key 由 requestId、当前题号、答案草稿三部分拼成，任一项变化都必须重建 Dialog
// 草稿用 JSON 序列化参与 key，因为对象引用变化不可靠而键序是稳定的
// [权衡] 草稿较大时有序列化开销，但比手工维护版本号更不容易漏掉更新
export function buildV4ElicitationProgressKey(request: ZCodeElicitationRequest): string {
  return `${request.requestId}:${request.currentQuestionIndex ?? 0}:${JSON.stringify(request.answerDrafts ?? {})}`;
}

export interface InteractionAutoResolutionIntentTracker {
  markInteracted(interactionId: string): void;
  consumeSnooze(interactionId: string, autoResolutionReady: boolean): boolean;
  releaseSnooze(interactionId: string): void;
}

// 两个集合的生命周期跟随组件实例，不写入 store，重新挂载即天然重置
// interactedIds 记录用户碰过的交互，sentIds 记录已经发出过暂停命令的交互
// [失败路径] 两者合并成一个集合时，发送失败就再也没有重试机会
export function createInteractionAutoResolutionIntentTracker(): InteractionAutoResolutionIntentTracker {
  const interactedIds = new Set<string>();
  const sentIds = new Set<string>();
  return {
    markInteracted(interactionId) {
      interactedIds.add(interactionId);
    },
    consumeSnooze(interactionId, autoResolutionReady) {
      // 三个条件缺一不可：自动结束已就绪、用户确实交互过、该交互还没发过暂停
      // [并发] 就绪事件与首帧交互可能先后倒置，这里的联合判断让两帧都能安全通过
      // 返回 false 表示暂不发送，调用方不可据此认为暂停已经生效
      if (!autoResolutionReady || !interactedIds.has(interactionId) || sentIds.has(interactionId)) {
        return false;
      }
      sentIds.add(interactionId);
      return true;
    },
    releaseSnooze(interactionId) {
      sentIds.delete(interactionId);
    },
  };
}

/**
 * 竖切：把 projection.pendingInteractions 接到 PermissionDialog / userInput 弹窗。
 * ChatView 删除后若无此组件，带 tool 权限的会话会永久阻塞。
 */
export function V4InteractionDialogs({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isWebRemoteControl = false,
  provider,
  snapshot,
  onCommandSettled,
  onPlanInteractionAccepted,
}: V4InteractionDialogsProps) {
  const { sendCommand } = useV4Conversation();
  const connectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.connect);
  const disconnectWorkspaceHookCommands = useWorkspaceHookReviewStore((state) => state.disconnect);
  const upsertWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.upsert);
  const clearWorkspaceHookReview = useWorkspaceHookReviewStore((state) => state.clear);
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  // task 切换时 sessionId 会先更新，旧 task snapshot 可能再保留一帧。
  // 若直接使用旧 snapshot，会把当前 task 的 renderer-local 问答草稿误判为过期并清理。
  const currentSnapshot = getCurrentSessionInteractionSnapshot(sessionId, snapshot);
  // 工作流确认窗里「会话模型」那一项的名字（与 run 卡「配置」弹层同一个来源）。
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(currentSnapshot?.config),
    [currentSnapshot?.config],
  );
  // Bug 根因：workspaceHookReview 是 Settings/Hooks 处理的特殊交互，不能由通用 Dialog 渲染；
  // 但它可以和 permission/userInput 共存，固定读取 [0] 会遮挡后续真正需要弹窗的交互。
  // 这里只选择本组件可渲染的首个交互，同时保留 permission/userInput 的队列顺序。
  // [契约] pending 是本组件唯一可渲染交互，其余 kind 一律不在这里处理
  // find 的命中顺序就是队列顺序，permission 与 userInput 谁先到谁先弹
  // [失败路径] 改回固定取第 0 个时，首个 workspaceHookReview 会挡住后面真正该弹的交互
  const pending =
    currentSnapshot?.pendingInteractions.find(
      (interaction) =>
        interaction.payload.kind === "permission" || interaction.payload.kind === "userInput",
    ) ?? null;
  const workspaceHookReview = currentSnapshot?.pendingInteractions.find(
    (interaction) => interaction.payload.kind === "workspaceHookReview",
  );
  const notificationEnabled = useZCodeStoreWithDefault((state) => state.notificationEnabled, true);
  const botElicitationProgress = useZCodeSessionStore(
    (state) =>
      getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
        .elicitationRequest,
  );
  const localElicitationDraft = useZCodeSessionStore((state) => {
    if (!pending || pending.payload.kind !== "userInput") return undefined;
    return getTaskUiState(getWorkspaceState(state, workspacePath, workspaceIdentity), sessionId)
      .elicitationFormDraftsByRequestId[pending.interactionId];
  });
  // [契约] 传入已校验的 currentSnapshot，而不是原始 snapshot 引用
  // 通知开关来自全局 store 且默认开启，关闭后仍照常渲染弹窗
  // 通知通道异常不得影响弹窗，由 hook 内部自行吞掉平台错误
  usePendingInteractionTaskNotifications({
    snapshot: currentSnapshot,
    enabled: notificationEnabled,
    platform,
    formatMessage: intl.formatMessage,
  });
  useEffect(() => {
    // [资源] connect 与 cleanup 里的 disconnect 严格成对，且使用同一个 sessionId
    // 依赖数组必须覆盖全部入参，否则切换 workspace 后仍复用旧闭包写旧 store
    // [失败路径] 漏掉 cleanup 时旧会话的审核请求会持续覆盖新会话状态
    connectWorkspaceHookCommands(sessionId, {
      sessionId,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      sendCommand,
      onCommandSettled,
    });
    return () => disconnectWorkspaceHookCommands(sessionId, sendCommand);
  }, [
    connectWorkspaceHookCommands,
    disconnectWorkspaceHookCommands,
    onCommandSettled,
    sendCommand,
    sessionId,
    workspaceIdentity,
    remoteSessionId,
    workspacePath,
  ]);
  useEffect(() => {
    if (!workspaceHookReview || workspaceHookReview.payload.kind !== "workspaceHookReview") {
      clearWorkspaceHookReview(sessionId);
      return;
    }
    // [事务] 先判 payload.kind，再在 upsert 与 clear 之间二选一，两条路径互斥
    // 本组件只把请求交给 store，审核界面由 Settings 行内 Trust 承担
    // [权衡] 软门禁：不自动跳转设置页，避免打断用户当前输入
    upsertWorkspaceHookReview(sessionId, {
      request: workspaceHookReview.payload,
      workspacePath,
      sendCommand,
      onCommandSettled,
    });
    // 软门禁：不再强制跳转 Settings/Hooks。
    // 用户通过 WorkspaceHookPendingBanner 的 [去审核] 按钮主动打开 Hooks 设置。
  }, [
    clearWorkspaceHookReview,
    onCommandSettled,
    sendCommand,
    sessionId,
    upsertWorkspaceHookReview,
    workspaceHookReview,
    workspacePath,
  ]);
  const autoResolutionIntentRef = useRef(createInteractionAutoResolutionIntentTracker());
  const loggedSnoozeSourceIdsRef = useRef(new Set<string>());
  const [permissionResponse, setPermissionResponse] = useState<{
    interactionId: string;
    pending: boolean;
    failed: boolean;
  } | null>(null);
  // [并发] 单飞标记放 ref 不放 state，异步窗口内读取不会拿到过期渲染值
  // 存的是 interactionId 而非布尔值，连续权限请求时旧回调清不掉新请求的标记
  const permissionResponseFlight = useRef<string | null>(null);

  // [契约] answer 的 optionId、freeText、content 均为可选，按交互种类各自取舍
  // [并发] 同一 interactionId 的重复应答由上层单飞标记拦截，这里不再二次去重
  // 命令信封必须由工厂生成，commandId 不能自行拼装
  const resolveInteraction = useCallback(
    async (
      interactionId: string,
      answer: {
        optionId?: string;
        freeText?: string;
        action?: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
      },
    ) => {
      const envelope = createCommandEnvelope({
        type: "resolveInteraction",
        sessionId,
        payload: { interactionId, answer },
      });
      // 权限/freeText/content 不落盘；registry 只持摘要，用于 ACK 丢失后的 query 对账。
      // [事务] record 必须在等待回执之前完成，否则发送成功但回执丢失时将无法对账
      // registry 只存摘要，不落盘、不保留自由文本与权限内容，避免敏感信息进持久层
      // [失败路径] 漏掉这一步不会立刻报错，只会在回执丢失时表现为命令结果永久未知
      pendingCommandRegistry.record(envelope);
      try {
        const ack = await sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        const accepted =
          ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
        // rejected 只记 warn 不抛错，弹窗保持打开让用户重新选择
        // 日志带 reasonCode，用于区分权限过期与协议不支持两类拒绝
        // [权衡] 不自动重试：交互应答不能靠猜，重试应由用户重新操作触发
        if (!accepted) {
          logger.warn("[v4-interaction] resolveInteraction 被拒绝", {
            interactionId,
            status: ack.status,
            reasonCode: ack.reasonCode,
          });
        }
        return accepted;
      // [失败路径] 网络异常一律返回 false，由调用方决定保留弹窗还是展示错误态
      // 失败态统一由 permissionResponse.failed 表达，异常对象不进入渲染层
      } catch (error) {
        logger.error("[v4-interaction] resolveInteraction 失败", { interactionId, error });
        return false;
      } finally {
        onCommandSettled?.(envelope.commandId);
      }
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  // [契约] source 固定为 dialog，服务端据此区分用户操作与自动路径
  // 该命令不是应答，不改变交互状态，只影响 Agent 侧的自动结束计时
  const snoozeAutoResolution = useCallback(
    async (interactionId: string) => {
      return sendInteractionAutoResolutionSnooze({
        sessionId,
        interactionId,
        sendCommand,
        source: "dialog",
        onCommandSettled,
      });
    },
    [onCommandSettled, sendCommand, sessionId],
  );

  // 草稿按 task 维度写入 store，键里同时含 workspacePath 与 workspaceIdentity
  // 直取 getState() 上的写方法，避免把方法塞进依赖导致 effect 反复重建
  const persistElicitationDraft = useCallback(
    (requestId: string, draft: ElicitationFormDraft) => {
      useZCodeSessionStore
        .getState()
        .setTaskElicitationFormDraft(workspacePath, sessionId, requestId, draft, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  // 清理与写入必须走同一 task 维度，漏传 workspaceIdentity 会删到另一身份的草稿
  // 只在应答成功或剪枝时调用，不随渲染顺带清理
  const removeElicitationDraft = useCallback(
    (requestId: string) => {
      useZCodeSessionStore
        .getState()
        .removeTaskElicitationFormDraft(workspacePath, sessionId, requestId, workspaceIdentity);
    },
    [sessionId, workspaceIdentity, workspacePath],
  );

  useEffect(() => {
    // [契约] 快照为空时整体跳过剪枝，宁可留下草稿也不能误删
    // 剪枝基准是快照里的 pendingInteractions，而不是本地草稿表的键
    // 只对 userInput 类型建集合，权限交互没有草稿概念
    if (!currentSnapshot) return;
    const activeRequestIds = new Set(
      currentSnapshot.pendingInteractions
        .filter((interaction) => interaction.payload.kind === "userInput")
        .map((interaction) => interaction.interactionId),
    );
    const taskUiState = getTaskUiState(
      getWorkspaceState(useZCodeSessionStore.getState(), workspacePath, workspaceIdentity),
      sessionId,
    );
    for (const requestId of Object.keys(taskUiState.elicitationFormDraftsByRequestId)) {
      // [失败路径] 请求可能在 task 不可见期间被另一端回答或自动结束，本地草稿必然成为孤儿
      // 删除本身幂等，重复执行不会影响仍然活跃的草稿
      if (!activeRequestIds.has(requestId)) {
        // 请求可能在 task 不可见期间被另一端回答或自动结束；回到该 task 后以
        // snapshot 的 pendingInteractions 为权威清理过期 renderer 草稿。
        removeElicitationDraft(requestId);
      }
    }
  }, [currentSnapshot, removeElicitationDraft, sessionId, workspaceIdentity, workspacePath]);

  const sendSnoozeOnce = useCallback(
    async (interactionId: string, autoResolutionReady: boolean) => {
      // 首个 userInput 与 autoResolution durable event 可能相邻两帧到达。未就绪时保留
      // tracker 意图，但向弹窗返回 false，让后续真实操作仍可重试；就绪后的 effect 会补发。
      // [并发] 未就绪时直接返回 false，但不动 tracker，把意图留给后续 effect 补发
      // 立即返回而不是悬挂 Promise，弹窗才能继续响应后续输入
      // [失败路径] 若在这里消费意图，就绪事件到达后将永远补发不出去
      if (!autoResolutionReady) return false;
      // 返回 true 表示已经处理过，并不代表暂停命令发送成功
      // 已发送过的交互直接视为处理完成，避免 effect 每次重跑都再发一条
      // [权衡] 用可预期的重试次数换取命令数量收敛，避免自动结束被反复续命
      if (!autoResolutionIntentRef.current.consumeSnooze(interactionId, autoResolutionReady)) {
        return true;
      }
      try {
        const accepted = await snoozeAutoResolution(interactionId);
        if (!accepted) autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return accepted;
      // [失败路径] 抛异常同样要撤销占位，否则该交互永久失去补发机会
      // 不向上抛出，暂停失败不能阻断弹窗的其它操作
      } catch {
        autoResolutionIntentRef.current.releaseSnooze(interactionId);
        return false;
      }
    },
    [snoozeAutoResolution],
  );

  useEffect(() => {
    // PermissionRequested 可能先投出 userInput，紧接着 autoResolution durable event 才到。
    // 用户若在这两帧之间完成首个分题操作，先记本地意图，registry 就绪后立即补发一次。
    // [并发] 依赖只放 autoResolution 与 interactionId，其它字段变化不应触发重发
    // effect 每次 pending 切换都会跑，去重全靠 tracker 而不是依赖数组
    // [失败路径] 把整个 pending 放进依赖会在每次快照更新时多发一条暂停命令
    if (pending) {
      void sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
    }
  }, [pending?.autoResolution, pending?.interactionId, sendSnoozeOnce]);

  // 没有可渲染交互时返回 null 而非空片段，避免占位影响上层布局
  // 早退必须位于全部 hook 之后，否则会破坏 hook 调用顺序
  if (!pending) {
    return null;
  }

  // workspaceHookReview 只能由 Settings/Hooks 行内 Trust 处理；绝不降级成通用 Dialog。
  if (pending.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (pending.payload.kind === "permission") {
    // [契约] 新协议 pending 转成旧 PermissionDialog 入参，字段名差异只在这里收敛
    // 展开 pending 而不是重建对象，保持 payload 引用与判等语义一致
    // 工作流会话模型只在确认窗里显示，缺失时按可选属性透传而不是传空串
    const request = pendingPermissionToLegacyRequest(sessionId, {
      ...pending,
      payload: pending.payload,
    });
    return (
      // 连续 permission 会复用输入框焦点状态，按 interaction 重建。
      <PermissionDialog
        key={pending.interactionId}
        request={request}
        workspacePath={workspacePath}
        {...(workspaceIdentity === undefined ? {} : { workspaceIdentity })}
        {...(remoteSessionId === undefined ? {} : { remoteSessionId })}
        {...(workflowSessionModel === undefined ? {} : { workflowSessionModel })}
        isWebRemoteControl={isWebRemoteControl}
        provider={provider}
        responding={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.pending
        }
        responseError={
          permissionResponse?.interactionId === pending.interactionId && permissionResponse.failed
            ? intl.formatMessage({ id: "chat.permission.responseFailed" })
            : undefined
        }
        onRespond={(_requestId, option: ZCodePermissionOption, feedback, content) => {
          if (permissionResponseFlight.current === pending.interactionId) return;
          const interactionId = pending.interactionId;
          permissionResponseFlight.current = interactionId;
          setPermissionResponse({ interactionId, pending: true, failed: false });
          // content：工作流确认窗里改过的设置，只在放行应答上（docs/dynamic-workflow/launch.md
          // 「Adjusting the settings in the window」）。
          void resolveInteraction(interactionId, {
            optionId: option.optionId,
            ...(feedback ? { freeText: feedback } : {}),
            ...(content === undefined ? {} : { content }),
          }).then((accepted) => {
            if (permissionResponseFlight.current !== interactionId) return;
            permissionResponseFlight.current = null;
            setPermissionResponse({ interactionId, pending: false, failed: !accepted });
          });
        }}
      />
    );
  }

  const projectedElicitationRequest = pendingUserInputToElicitationRequest(sessionId, {
    ...pending,
    payload: pending.payload,
  });
  // [契约] 投影请求与 Bot 逐题进度在这里合流，最终只交出一个请求给弹窗
  // 弹窗的 key 与初始草稿都基于合并后的结果计算，不能各自取源
  // [失败路径] 拿到空请求说明投影适配失败，会退到通用输入弹窗兜底
  const elicitationRequest = resolveV4ElicitationRequest(
    projectedElicitationRequest,
    botElicitationProgress,
  );
  if (elicitationRequest) {
    const isExitPlanMode = pending.payload.toolName?.trim().toLowerCase() === "exitplanmode";
    const isAskUserQuestion =
      pending.payload.toolName?.trim().toLowerCase() === "askuserquestion" ||
      pending.autoResolution !== undefined;
    return (
      <ElicitationDialog
        key={buildV4ElicitationProgressKey(elicitationRequest)}
        request={elicitationRequest}
        initialFormDraft={
          botElicitationProgress?.requestId === elicitationRequest.requestId
            ? undefined
            : localElicitationDraft
        }
        onFormDraftChange={persistElicitationDraft}
        autoResolution={isAskUserQuestion ? pending.autoResolution : undefined}
        onFirstInteraction={
          isAskUserQuestion
            ? (source) => {
                if (!loggedSnoozeSourceIdsRef.current.has(pending.interactionId)) {
                  loggedSnoozeSourceIdsRef.current.add(pending.interactionId);
                  logger.debug("[v4-interaction] AskUserQuestion 请求暂停自动结束", {
                    interactionId: pending.interactionId,
                    source,
                  });
                }
                autoResolutionIntentRef.current.markInteracted(pending.interactionId);
                return sendSnoozeOnce(pending.interactionId, Boolean(pending.autoResolution));
              }
            : undefined
        }
        onRespond={(_requestId, action, content) => {
          void resolveInteraction(pending.interactionId, {
            action,
            ...(content ? { content } : {}),
          }).then((accepted) => {
            if (!accepted) return;
            removeElicitationDraft(pending.interactionId);
            if (isExitPlanMode) {
              // Plan 回执 ACK 与 replayable pending 清场是两条异步路径。
              // 这里只上报已接受的 Plan interaction，由手机 pane 在仍读到旧权威状态时触发恢复。
              onPlanInteractionAccepted?.(pending.interactionId);
            }
          });
        }}
      />
    );
  }

  const model = pendingUserInputToViewModel({
    ...pending,
    payload: pending.payload,
  });
  return (
    <V4UserInputDialog
      model={model}
      onSubmit={(answer) => {
        void resolveInteraction(pending.interactionId, answer);
      }}
    />
  );
}
