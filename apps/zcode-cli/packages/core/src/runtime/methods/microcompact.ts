/**
 * ============================================================================
 * runtime/methods/microcompact.ts —— 本地"微压缩"入口(不调用模型)
 * ============================================================================
 *
 * 与 compact.ts 的分工:
 *   microcompact  纯本地裁剪(清理旧工具结果/附件等),便宜、无模型请求、可在每个 step 检查;
 *   compact       真实发起一次摘要请求,昂贵,只在临近窗口上限时触发。
 * 本文件只负责"判断是否需要 + 应用结果 + 落事件",裁剪策略本身在 helpers 里。
 *
 * 【关键约束】
 *   - 应用结果时必须过滤 query-local 的续写提示,否则它们会被写进持久化历史;
 *   - 回写 canonical 历史时只替换对话尾部,前缀始终取 canonical 的最新版本
 *     (配置刷新可能已经换了前缀,整体回写会把刷新撤销)。
 * ============================================================================
 */
import {
  CompactPhase,
  SessionEventType,
  buildDefaultMicrocompactThreshold,
  getAutoCompactThreshold,
  traceContextToLogContext,
} from "../deps.js";
import type {
  AutoCompactPolicyConfig,
  LocalMicrocompactPolicyConfig,
  Model,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import { maybeLocalMicrocompactRuntimeEntries, throwIfTurnAborted } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

export async function microcompactIfNeeded(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: {
    model: Model;
    modelStepIndex: number;
    phase: CompactPhase;
    turnRequestState: TurnRequestState;
  },
): Promise<void> {
  // 与 compact 共享 enabled 开关:关掉压缩就同时关掉本地微压缩,
  // 避免出现"用户禁用压缩但工具结果仍在被悄悄裁剪"的不一致。
  if (this.config.compact?.enabled === false) return;
  // 每个 step 都会调用本函数,已取消的 turn 不应继续做压缩判定。
  throwIfTurnAborted(abortSignal);

  // autoConfig 是"完整压缩"的策略口径:微压缩的默认阈值必须从它派生,
  // 否则两条链路会用两套不同的窗口假设(例如不同的 maxOutputTokens 基线)。
  const autoConfig: AutoCompactPolicyConfig = {
    contextWindow: context.model.properties.contextWindow,
    ...this.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
  };
  const microcompactConfig = resolveLocalMicrocompactConfig(autoConfig);
  // 只有模型支持"对话中途插入 system"时,才允许把压缩提示以 system 形态注入;
  // force 用于明确知道该怎么处理的 provider。不支持时降级为其它注入目标,
  // 避免把 system 消息放到对话中间导致 provider 报错。
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    context.model.properties.supportsMidConversationSystem;
  // 纯本地计算,不发起模型请求:适合每个 model step 前都跑一次。
  const result = maybeLocalMicrocompactRuntimeEntries({
    config: microcompactConfig,
    entries: context.turnRequestState.entries,
    lastAssistantCompletedAtMs: this.lastAssistantCompletedAtMs,
    useMidConversationSystem,
  });

  // 不需要裁剪是每个 step 的常态:这里保持 no-op 语义(不改历史、不发事件),
  // 让调用方可以无条件调用,不必自己重复判断阈值。
  if (!result.payload) {
    this.logger?.debug("Microcompact skipped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.micro.skipped",
      estimatedTokenCount: result.decision.estimatedTokenCount,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      reason: result.decision.reason,
      thresholdTokens: result.decision.thresholdTokens,
      trigger: result.decision.trigger,
    });
    return;
  }

  const recordableEntries = filterOutputTokenContinuationEntries(result.entries);
  // 回写 canonical 历史:canonical 前缀(配置/技能清单等)+ 压缩后的对话尾部。
  // 之所以不能直接用 recordableEntries 整体替换:前缀可能已被刷新更新,
  // 用 turn-local 的旧前缀会撤销刷新。
  this.messageHistory.replaceMessages(
    preserveCanonicalContextPrefix(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
      recordableEntries,
    ),
  );
  // turn-local 数组保留未过滤的 result.entries:本轮 provider 仍需要看到续写提示,
  // 过滤只发生在"写入持久化历史"时。
  context.turnRequestState.entries = result.entries;

  // payload 里带 traceId/turnId,让事件消费方能把微压缩边界归到具体 turn;
  // 边界事件是 UI 展示"此处发生过裁剪"的唯一依据。
  const payload = {
    ...result.payload,
    traceId: turnTraceContext.traceId,
    turnId: turnTraceContext.turnId,
  };
  const event = this.createEvent(SessionEventType.MicrocompactBoundary, payload, turnTraceContext);
  // appendEvent 是"先落 durable event、再广播"的唯一入口:这里 await 失败要让本 step 抛错,
  // 否则会出现"内存历史已裁剪、持久化轨迹却没有边界事件"的不可恢复错位。
  await this.appendEvent(event, turnTraceContext);
  events.push(event);

  this.logger?.info("Microcompact applied", {
    ...traceContextToLogContext(turnTraceContext),
    clearedMessageCount: payload.clearedMessageCount,
    event: "compact.micro.applied",
    modelStepIndex: context.modelStepIndex,
    module: "core.runtime",
    phase: context.phase,
    postMicrocompactTokenCount: payload.postMicrocompactTokenCount,
    preMicrocompactTokenCount: payload.preMicrocompactTokenCount,
    tokensSaved: payload.tokensSaved,
    trigger: payload.trigger,
  });
}

function resolveLocalMicrocompactConfig(
  config: AutoCompactPolicyConfig,
): LocalMicrocompactPolicyConfig {
  // 微压缩的默认阈值从"完整压缩阈值"派生出更低的触发点:
  // 先在便宜的方式下清理一轮,尽量推迟昂贵的摘要请求。
  const fullCompactThreshold = getAutoCompactThreshold(config);
  return {
    ...config.microcompact,
    // enabled 必须显式为 true 才启用:微压缩会改写历史,默认关闭比误开更安全。
    enabled: config.microcompact?.enabled === true,
    thresholdTokens:
      config.microcompact?.thresholdTokens ??
      buildDefaultMicrocompactThreshold(fullCompactThreshold),
  };
}
