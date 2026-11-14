// INV-01 入口只启动后台任务：守住位置 返回布尔值含义；改错故障 turn 收尾被模型请求拖住。
// INV-02 不适格仍补兜底标题：守住位置 早退分支；改错故障 UI 退回默认文案。
// INV-03 兜底写入纳入驻留工作：守住位置 跟踪调用；改错故障 进程退出丢标题。
// INV-04 触发上下文在入队时冻结：守住位置 因果捕获；改错故障 异步丢失原始链路。
// INV-05 模型错误转兜底：守住位置 捕获分支；改错故障 后台任务以拒绝收尾。
// INV-06 兜底失败只记警告：守住位置 追踪捕获；改错故障 未处理拒绝冒到进程。
// INV-07 写前重读目标：守住位置 读取校验；改错故障 旧标题写进新目标。
// INV-08 标题未变不写：守住位置 相等比较；改错故障 制造无意义变更广播。
// INV-09 更新带目标标识：守住位置 条件更新参数；改错故障 跨目标误更新。
// INV-10 更新结果再校验：守住位置 三元条件；改错故障 并发覆盖被当成成功。
// INV-11 成功后才广播变更：守住位置 事件记录顺序；改错故障 投影读到未持久化标题。
// INV-12 兜底标题取目标语义：守住位置 归一化函数；改错故障 回退成空标题。
// INV-13 空标题不写盘：守住位置 早退判断；改错故障 目标出现空摘要字段。
// INV-14 已有标题让位兜底：守住位置 非空判断；改错故障 兜底覆盖真实生成结果。
// INV-15 生成前再校验目标：守住位置 请求前读取；改错故障 为已失目标白烧调用。
// INV-16 空响应即回落：守住位置 生成结果判断；改错故障 首轮迭代没有标题。
// INV-17 持久化用生成方链路：守住位置 返回的追踪上下文；改错故障 用量无法按调用链归组。
// INV-18 长标题按上限截断：守住位置 长度分支；改错故障 标题超长撑破布局。
//
// 模块职责：为 Goal 目标生成并持久化摘要标题，模型不可用时回落到目标语义。
// 状态所有权：标题真值在会话存储，本模块只做条件写入与变更广播。
// 阅读顺序：先看入口与兜底调度，再看两条持久化路径，最后看准入与生成函数。
/**
 * ============================================================================
 * goal-summary-title.ts —— Goal 摘要标题的后台生成与兜底
 * ============================================================================
 * 定位：链路 8 的展示层，为 target 生成 summaryTitle（UI 的「第 N 次迭代」标题）。
 * 输入/输出：输入 goal objective + targetID；输出 target.summaryTitle 持久化与 TargetChanged 事件。
 * 关键不变量：写入前重读 target 并校验 targetID，避免 goal 切换后把旧标题写进新 target；
 *       模型失败/空响应回落到目标语义标题，保证 UI 不退回默认文案；后台任务不阻塞 turn 收尾。
 * ============================================================================
 */
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentTelemetryCausation } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  GOAL_SUMMARY_TITLE_QUERY_SOURCE,
  generateTitleCandidate,
  normalizeTitleInput,
} from "./title-generation-sidecar.js";

const FALLBACK_GOAL_SUMMARY_TITLE_MAX_CHARS = 100;

// maybeStartGoalSummaryTitleGeneration 的入口只负责判断、调度与返回，模型调用由驻留工作执行。
// generateTitleCandidate 与写盘都放进驻留工作，入口不 await 模型请求。
// shouldAttemptGoalSummaryTitleGeneration 不通过时仍写兜底标题，返回 false 表示没有启动模型请求。
// 兜底与生成都先走 normalizeTitleInput，再共用同一套写前校验。
// 返回值表示是否启动生成，不承诺 summaryTitle 已落库。
export function maybeStartGoalSummaryTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  targetID: string,
  options?: { traceContext?: TraceContext },
): boolean {
  const traceContext = options?.traceContext ?? this.rootTraceContext;
  // 前置条件不满足时仍补一条兜底标题：保证 UI 有可读标题，但返回 false 表示没有启动模型请求。
  if (!shouldAttemptGoalSummaryTitleGeneration(this, input, targetID)) {
    this.logger?.debug("Goal summary title generation skipped", {
      ...traceContextToLogContext(traceContext),
      event: "goal_summary_title_generation.skipped",
      module: "core.runtime",
      reason: "not_eligible",
      targetId: targetID,
    });
    // 兜底写盘算 residency blocking work：runtime 要等它结束才判定空闲，避免进程退出丢标题。
    // 这里不 await，失败只记日志，不能反向阻塞 turn。
    void this.trackResidencyBlockingWork(
      persistFallbackGoalSummaryTitle.call(this, {
        objective: input,
        reason: "generation_not_eligible",
        targetID,
        traceContext,
      }),
    ).catch((error) => {
      logGoalSummaryFallbackFailure(this, error, targetID, traceContext);
    });
    return false;
  }

  // 与 Session Title 一致：后台任务在入队时冻结触发 Span，而不是依赖之后的
  // AsyncLocalStorage 恰好仍保留原 Context。
  const causation = this.agentTelemetry.captureCausation();
  // catch 把模型错误转成兜底写入，确保 track 的 promise 不会以 reject 收尾（否则只剩未处理拒绝）。
  const generation = generateAndPersistGoalSummaryTitle
    .call(this, input, targetID, traceContext, causation)
    .catch(async (error) => {
      this.logger?.warn("Goal summary title generation failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "goal_summary_title_generation.failed",
        module: "core.runtime",
        status: "failed",
        targetId: targetID,
      });
      await persistFallbackGoalSummaryTitle.call(this, {
        objective: input,
        reason: "model_error",
        targetID,
        traceContext,
      });
    });
  void this.trackResidencyBlockingWork(generation).catch((error) => {
    logGoalSummaryFallbackFailure(this, error, targetID, traceContext);
  });
  // 返回值只表示「异步生成已启动」，标题是否真正写入由后台任务决定。
  return true;
}

function logGoalSummaryFallbackFailure(
  runtime: AgentRuntimeInternal,
  error: unknown,
  targetID: string,
  traceContext: TraceContext,
): void {
  // 兜底持久化自身的失败也只记 warn：没有更上层能处理，标题缺失不能影响 turn。
  runtime.logger?.warn("Goal summary title fallback persistence failed", {
    ...traceContextToLogContext(traceContext),
    errorMessage: error instanceof Error ? error.message : String(error),
    event: "goal_summary_title_generation.fallback_failed",
    module: "core.runtime",
    status: "failed",
    targetId: targetID,
  });
}

// persistGeneratedGoalSummaryTitle 写前用 targetID 重读，不信任调用方快照。
// 重读的 targetID 与入参不一致时记 stale_target_before_write 并丢弃本次结果。
// 新旧标题相同视为已完成，跳过 goal_summary_title_generation 广播。
// 写入只走 updateTargetIf 的条件更新，不做读改写。
// 条件更新返回 false 时只记日志，不回滚已写入字段。
export async function persistGeneratedGoalSummaryTitle(
  this: AgentRuntimeInternal,
  input: {
    targetID: string;
    title: string;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 写前重读：生成期间 target 可能被切换/暂停替换，必须用 store 的权威值做校验。
  const previousTarget = await this.sessionStore?.readTarget({ sessionID: this.sessionId });
  if (!previousTarget || previousTarget.targetID !== input.targetID) {
    // target 已换或已不存在：丢弃这次生成结果，绝不把旧标题写进新 target。
    this.logger?.debug("Goal summary title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "goal_summary_title_generation.skipped",
      module: "core.runtime",
      reason: "stale_target_before_write",
      targetId: input.targetID,
    });
    return;
  }
  if (previousTarget.summaryTitle === input.title) {
    // 标题没变就不写：避免制造一次无意义的 TargetChanged（下游会刷新 UI/投影）。
    this.logger?.debug("Goal summary title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "goal_summary_title_generation.skipped",
      module: "core.runtime",
      reason: "unchanged_title",
      targetId: input.targetID,
      titleLength: input.title.length,
    });
    return;
  }

  // 带上 targetID 的条件更新由 store 保证原子性；返回值仍需再校验一次。
  const updatedTarget = await this.sessionStore?.updateTargetSummaryTitle({
    sessionID: this.sessionId,
    summaryTitle: input.title,
    targetID: input.targetID,
  });
  if (
    !updatedTarget ||
    updatedTarget.targetID !== input.targetID ||
    updatedTarget.summaryTitle !== input.title
  ) {
    // 并发写入/目标切换发生在 update 内部：只跳过事件，不覆盖 store 已返回的真实结果。
    this.logger?.debug("Goal summary title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "goal_summary_title_generation.skipped",
      module: "core.runtime",
      reason: "target_changed_during_write",
      targetId: input.targetID,
    });
    return;
  }

  this.logger?.info("Goal summary title generation completed", {
    ...traceContextToLogContext(input.traceContext),
    event: "goal_summary_title_generation.completed",
    module: "core.runtime",
    status: "completed",
    targetId: input.targetID,
    titleLength: input.title.length,
  });

  // 持久化后用 TargetChanged 广播标题变化：V4 投影/冷恢复据此更新，而不是靠模型回调。
  await this.recordTargetChanged({
    action: "summary_updated",
    previousTarget,
    source: "runtime",
    target: updatedTarget,
    traceContext: input.traceContext,
  });
}

export async function persistFallbackGoalSummaryTitle(
  this: AgentRuntimeInternal,
  input: {
    objective: string;
    reason: string;
    targetID: string;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 兜底标题来自目标语义（原 objective）；归一化后为空则没有可写内容。
  const title = fallbackGoalSummaryTitle(input.objective);
  // 空标题不写：宁可保持缺省，也不制造一个空 summaryTitle。
  if (!title) return;

  // 与生成路径同一套写前校验：兜底也必须确认 target 仍是同一个，避免写到新目标上。
  const previousTarget = await this.sessionStore?.readTarget({ sessionID: this.sessionId });
  if (!previousTarget || previousTarget.targetID !== input.targetID) {
    // stale target：这次兜底作废，不能污染已切换的目标。
    this.logger?.debug("Goal summary title fallback skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "goal_summary_title_generation.fallback_skipped",
      module: "core.runtime",
      reason: "stale_target_before_write",
      targetId: input.targetID,
    });
    return;
  }
  if (previousTarget.summaryTitle?.trim()) {
    // summaryTitle 非空时兜底让位：生成结果优先，兜底只负责填空缺。
    this.logger?.debug("Goal summary title fallback skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "goal_summary_title_generation.fallback_skipped",
      module: "core.runtime",
      reason: "existing_title",
      targetId: input.targetID,
    });
    return;
  }

  // 兜底同样走原子条件更新；返回不匹配时只跳过事件，不覆盖 store 的真实结果。
  const updatedTarget = await this.sessionStore?.updateTargetSummaryTitle({
    sessionID: this.sessionId,
    summaryTitle: title,
    targetID: input.targetID,
  });
  if (
    !updatedTarget ||
    updatedTarget.targetID !== input.targetID ||
    updatedTarget.summaryTitle !== title
  ) {
    // 并发/目标切换：store 返回的真实值优先，本次兜底不再广播。
    this.logger?.debug("Goal summary title fallback skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "goal_summary_title_generation.fallback_skipped",
      module: "core.runtime",
      reason: "target_changed_during_write",
      targetId: input.targetID,
    });
    return;
  }

  // 兜底成功也留 info：与 reason（not_eligible/model_error/empty…）一起解释标题来源。
  this.logger?.info("Goal summary title fallback persisted", {
    ...traceContextToLogContext(input.traceContext),
    event: "goal_summary_title_generation.fallback_persisted",
    module: "core.runtime",
    reason: input.reason,
    status: "completed",
    targetId: input.targetID,
    titleLength: title.length,
  });

  // 持久化后用 TargetChanged 广播标题变化：V4 投影/冷恢复据此更新，而不是靠模型回调。
  await this.recordTargetChanged({
    action: "summary_updated",
    previousTarget,
    source: "runtime",
    target: updatedTarget,
    traceContext: input.traceContext,
  });
}

// 准入先过配置开关，再过存储可用性，最后按会话类型排除。
// config 显式关闭只停模型生成，不停 fallbackGoalSummaryTitle 的兜底。
// 子代理与后台任务（isSubagent / background）不参与目标标题。
// targetID 为空或 input.trim() 为空时都不发起请求。
// 所有条件通过后才调用 generateTitleCandidate。
function shouldAttemptGoalSummaryTitleGeneration(
  runtime: AgentRuntimeInternal,
  input: string,
  targetID: string,
): boolean {
  // 标题生成被显式关闭：不能再发模型请求，但仍允许兜底。
  if (runtime.config.titleGeneration?.enabled === false) return false;
  // 没有 titleGeneration 配置（provider/模型未就绪）：生成必然失败，直接跳过。
  if (!runtime.config.titleGeneration) return false;
  // 没有 session store 就无处持久化标题，生成结果只能丢。
  if (!runtime.sessionStore) return false;
  // 子代理会话不生成目标标题：标题属于父会话的 UI/目标语义。
  if (runtime.config.parentSessionId) return false;
  // 只有 interactive 任务需要；后台/子任务没有对应的目标投影。
  if (runtime.config.taskType && runtime.config.taskType !== "interactive") return false;
  // 空 targetID 无法定位写入对象，空 objective 也没有模型输入。
  if (targetID.trim().length === 0) return false;
  return normalizeTitleInput(input).length > 0;
}

async function generateAndPersistGoalSummaryTitle(
  this: AgentRuntimeInternal,
  input: string,
  targetID: string,
  traceContext: TraceContext,
  causation?: AgentTelemetryCausation,
): Promise<void> {
  // 请求前校验一次：避免为一个已经消失/切换的 target 白烧模型调用。
  const currentTarget = await this.sessionStore?.readTarget({ sessionID: this.sessionId });
  if (!currentTarget || currentTarget.targetID !== targetID) {
    // 目标已变化：放弃生成，外层会把这次空手而归当作「无标题」处理。
    this.logger?.debug("Goal summary title generation skipped", {
      ...traceContextToLogContext(traceContext),
      event: "goal_summary_title_generation.skipped",
      module: "core.runtime",
      reason: "stale_target_before_request",
      targetId: targetID,
    });
    return;
  }

  this.logger?.info("Goal summary title generation started", {
    ...traceContextToLogContext(traceContext),
    event: "goal_summary_title_generation.started",
    module: "core.runtime",
    status: "started",
    targetId: targetID,
  });

  // 真正的模型调用（sidecar 负责 provider/超时/无工具）；失败由外层 catch 转兜底。
  const generated = await generateTitleCandidate.call(this, input, {
    causation,
    querySource: GOAL_SUMMARY_TITLE_QUERY_SOURCE,
    traceContext,
  });
  // 模型返回空标题（空响应/被过滤）→ 用目标语义兜底，保证第一轮迭代仍有标题。
  if (!generated) {
    // 第一轮迭代标题只读 target.summaryTitle；标题模型空响应时也要写入目标语义兜底，
    // 否则 UI 只能退回“第 1 次迭代”，看起来像 summaryTitle 丢失。
    await persistFallbackGoalSummaryTitle.call(this, {
      objective: input,
      reason: "empty_model_title",
      targetID,
      traceContext,
    });
    return;
  }

  // 用生成结果的 traceContext 关联这次模型请求，而不是入口 trace，便于按调用链归组。
  await persistGeneratedGoalSummaryTitle.call(this, {
    targetID,
    title: generated.title,
    traceContext: generated.traceContext,
  });
}

function fallbackGoalSummaryTitle(objective: string): string | null {
  const normalized = normalizeTitleInput(objective);
  // 归一化后为空：没有可回退的语义，返回 null 让调用方跳过写入。
  if (!normalized) return null;
  // 未超界直接使用原文（已归一化），不做无意义改写。
  if (normalized.length <= FALLBACK_GOAL_SUMMARY_TITLE_MAX_CHARS) return normalized;
  // 超长截到上限并补 ...；先 trim 避免省略号前留下空格。
  return `${normalized.slice(0, FALLBACK_GOAL_SUMMARY_TITLE_MAX_CHARS - 3).trim()}...`;
}
