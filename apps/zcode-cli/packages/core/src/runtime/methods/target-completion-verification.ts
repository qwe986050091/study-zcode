// INV-01 [失败路径] 三道前置门固定在 verifyActiveTargetCompletionForContinuation 顶部：显式关闭、无 sessionStore、status 非 active 各自 return null；把判空改成抛错会让关闭验证的会话无法续跑。
// INV-02 [权衡] 前置返回 null 而不是 passed=true：null 的语义是“本轮不需要验证”，调用方沿用原有续跑；改成 fail-open 会让关闭验证的会话每轮直接判完成。
// INV-03 [事务] 通过后的持久化只发生在 execute：updateTargetStatus 置 complete 后必须紧跟 recordTargetChanged；只写状态不写事件会让 UI 与快照永远停在 running。
// INV-04 [失败路径] completedTarget 的 ?? input.target 兜底固定在 update 表达式上；去掉兜底，store 返回空时返回值与事件里的 target 会变成 undefined 并在续跑循环里崩。
// INV-05 [并发] 模型快照 requestedModelSelection 在 verifyTargetCompletion 开头取一次，createRuntimeModel、请求、重试、usage 共用同一 model；请求前重读会让用户中途切模型把 usage 记到错误 provider。
// INV-06 [资源] 媒体策略投影 projectMessagesForModelMediaPolicy 必须在 prepareRuntimeProviderRequest 之后、发请求之前执行；跳过它会让聚合超限错误进入 fail-open，把未完成误判成完成。
// INV-07 [失败路径] tools 传空数组是裁判契约；模型仍尝试调用工具时 toolCalls.length > 0 走 failOpenGoalCompletionVerification 而不是解析文本，删掉该分支会把格式错误当成未完成无限续跑。
// INV-08 [事务] started 与 completed / failed_closed / cancelled 四个事件共用同一 goalIteration 与 anchor；任一处重算都会让 UI 无法把同一轮验证配对。
// INV-09 [失败路径] 末尾“只有 tool_calls、没有 tool_result”的 assistant 必须由 withoutTrailingPendingAssistantToolCallEntries 剥掉；不剥会让 provider 因配对约束拒绝请求，四类事件只剩 failed_closed。
// INV-10 [失败路径] 该裁剪函数只在“末条是 assistant 且 toolCalls 非空”时切片；删掉 isRuntimeAttachmentEntry 判断会对附件条目误切片，丢掉真实历史。
// INV-11 [失败路径] 取消判定以 abortSignal.aborted 为准，且必须在 catch 内、recordModelUsageFact 之后；提前 return 会让 usage 记为 error 而不是 cancelled。
// INV-12 [失败路径] 取消时返回 failedGoalCompletionVerification（passed=false），不是 fail-open；改成 fail-open 会把用户 Stop 解释成目标完成并落成 complete。
// INV-13 [并发] 取消分支抛出前必须 pauseActiveTargetForCancellation；漏掉这步，resumeSession 后的 sendPrompt 会被当成 goal continuation 继续输出 checkpoint。
// INV-14 [失败路径] 非取消异常走 failOpenGoalCompletionVerification 并保留 error.message；写死字符串会丢失原始故障，日志与 UI 无法区分真完成与故障放行。
// INV-15 [资源] 重试范围只由 START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS 与 isStartPlanBusyStreamRecoveryFailure 共同决定；放宽到全部错误会让鉴权、配额失败也各多发两次请求。
// INV-16 [资源] 尝试次数由 TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS.length + 1 推导，延时为 1000 / 2000 毫秒；改数组长度必须同步 maxAttempts，否则末次会取到 undefined 延时直接抛出。
// INV-17 [失败路径] 每次重试先 sleep 再 throwIfTurnAborted；漏掉取消检查，用户 Stop 之后仍会再发一次请求。
// INV-18 [并发] goalIteration 由 getNextTargetCompletionVerificationIteration 从投影取 max + 1（历史项缺编号时回退 index + 1），只算一次并固定给本次全部事件；分两处计算会让编号漂移。
//
// 模块职责：Goal 自动续跑前的独立裁判调用，读取完整历史、禁用工具、解析结构化判定，并把 passed 结果落成 target 状态与生命周期事件。
// 状态所有权：target 状态唯一写在 execute 的 updateTargetStatus 加 recordTargetChanged；本轮事件、模型快照与重试预算都由 verifyTargetCompletion 局部持有，不回写 session。
// 阅读顺序：先读 verifyActiveTargetCompletionForContinuation 的三道前置与完成落库，再读 verifyTargetCompletion 的请求组装与三条失败分支，最后看重试循环与历史裁剪两个纯函数。
/**
 * ============================================================================
 * runtime/methods/target-completion-verification.ts —— Goal 完成验证(裁判)
 * ============================================================================
 *
 * 在自动续跑前,用一个**独立的模型调用**判断"目标是否已经完成"。它:
 *   - 不携带任何工具(tools: []),只允许输出一段结构化验证结果;
 *   - 复用当前 session 的模型选择快照(请求期间切换模型不影响本次验证);
 *   - 输入是完整历史(去掉末尾"只有 tool_calls、还没有 tool_result"的 assistant,
 *     否则 provider 会因为 tool_use 无配对结果而拒绝请求);
 *   - 结果解析失败 / 模型试图调用工具 / 请求失败 → **fail open**(passed=true),
 *     避免 goal 因裁判链路偶发故障被永久卡住;reason 保留供日志/UI 排查。
 *
 * 【生命周期事件】TargetCompletionVerification:started / completed /
 *   failed_closed / cancelled,都带同一个 goalIteration 与 anchor,
 *   UI 与快照不需要各自推算"第几次验证"。
 *
 * 【取消】用户 Stop 打断 verifier 时,除发 cancelled 事件外还要把 target 置 paused:
 *   否则 resume 后会被当成 goal continuation 自动继续,违背用户停止意图。
 * ============================================================================
 */
import {
  SessionEventType,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  createChildTraceContext,
  failOpenGoalCompletionVerification,
  failedGoalCompletionVerification,
  formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationText,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  GoalCompletionVerificationOutput,
  Model,
  SessionEvent,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import { prepareRuntimeProviderRequest, throwIfTurnAborted } from "../helpers/index.js";
import { projectMessagesForModelMediaPolicy } from "../helpers/media-budget.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel } from "./runtime-model.js";
import { isStartPlanBusyStreamRecoveryFailure } from "./streaming-recovery.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { runTargetCompletionVerificationWithTelemetry } from "./target-completion-verification-telemetry.js";

export interface TargetCompletionVerificationResult {
  target: SessionGoal;
  verification: GoalCompletionVerificationOutput;
}

// 验证请求最多 3 次尝试(首次 + 两次延迟重试),且只对 Start Plan 的
// 瞬时并发 busy 码重试:这类失败重试即可恢复,直接 fail-open 会把可恢复并发
// 误判成"目标已完成"。
// 重试预算只有两条延时，配合首次尝试共 3 次，不对外暴露配置项。
// [资源] 只对 Start Plan 两条 provider id 且被判为瞬时 busy 的错误重试，判据是 isStartPlanBusyStreamRecoveryFailure。
// 把范围放宽到全部错误会让鉴权失败、配额不足也各多发两次请求，放大故障成本。
// 直接 fail-open 会把可恢复的 admission 并发误判成目标已完成，这是设置重试的全部理由。
// [权衡] 延时固定 1 秒与 2 秒，不做指数退避：次数少且发生在用户已看到迭代之后，长等待比多一次请求更伤体验。
// 调整数组必须同步 maxAttempts 推导与日志里的 maxAttempts 字段，否则重试次数与观测值不一致。
const TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS = new Set([
  "account:bigmodel-start-plan",
  "account:zai-start-plan",
]);

// 对外契约只有两种返回：null 表示本次不验证，Result 表示已得出判定并可能已写入完成状态。
// execute 是唯一把 passed=true 转成持久状态的地方，verifyTargetCompletion 自身不触碰 target。
// [事务] 顺序固定为先 updateTargetStatus 成功、再 recordTargetChanged；反过来会让事件先宣告完成而存储仍是 active。
// [失败路径] passed=false 时直接返回 target 与 verification，不写 store；这条早退是“未完成继续跑”的唯一出口。
// [并发] 整个 execute 交给 runTargetCompletionVerificationWithTelemetry 包装，事件顺序与耗时由 telemetry 统一收口。
// [资源] 返回值里的 target 可能是 store 回填的新对象，调用方不能假定它仍是入参那个引用。
// target 与 verification 成对返回，调用方据此同时更新 UI 与续跑决策，不要只取其一。
// 修改返回结构要同步 telemetry 包装与所有调用点，尤其是按 passed 分支的续跑逻辑。
export async function verifyActiveTargetCompletionForContinuation(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<TargetCompletionVerificationResult | null> {
  // 三个前置:显式关闭验证、没有 store、目标已非 active 时都不跑裁判。
  // 返回 null 表示"本次不需要/无法验证",调用方按原有续跑逻辑处理。
  // 三道前置互不替代，全部在这里短路，且都发生在任何事件与模型调用之前。
  // [权衡] enabled === false 只认显式关闭；未配置时验证默认开启，改成 falsy 判断会让缺省配置静默禁用裁判。
  // 没有 sessionStore 直接返回 null，因为后续 updateTargetStatus 与事件写入都依赖它。
  // status 非 active 时返回 null：已完成或已取消的 target 再验证只会重复写状态。
  // [失败路径] 前置自身抛错会冒泡给调用方而不是 fail-open，因为此时还没有进入裁判链路。
  // 新增前置必须排在这三条之后，保证“不验证”的语义先于任何副作用。
  // 这里不记录事件，被跳过的验证在 UI 上不可见，排障要靠上层续跑日志。
  if (this.config.targetCompletionVerification?.enabled === false) return null;
  if (!this.sessionStore) return null;
  if (input.target.status !== "active") return null;

  const execute = async (): Promise<TargetCompletionVerificationResult> => {
    const events: SessionEvent[] = [];
    const verification = await verifyTargetCompletion.call(this, {
      abortSignal: input.abortSignal,
      events,
      target: input.target,
      traceContext: input.traceContext,
    });

    if (!verification.passed) {
      return {
        target: input.target,
        verification,
      };
    }

    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    // 通过后立即把 target 置 complete 并落 TargetChanged:
    // 这是"完成"的唯一持久事实,UI/续跑循环都以它为准。
    // 不变量 12：fail-open（裁判链路自身失败）也返回 passed=true，因此同样会
    // 走到这里把 target 标记 complete。这个取舍防的是"verifier 偶发故障让 goal 永久卡住"，
    // 风险是"模型实际未完成但被误判完成"——reason 字段保留供日志/UI 排查。
    // 这里是完成状态的唯一写入点，也是 fail-open 与真完成在持久层无法区分的根源。
    // [事务] updateTargetStatus 与 recordTargetChanged 必须成对；只写状态不写事件会让快照与 UI 停在 running。
    // [失败路径] fail-open 同样返回 passed=true，因此也走到这里把 target 标 complete；取舍是宁可误完成也不让 goal 永久卡死。
    // [权衡] reason 是区分“真完成”与“故障放行”的唯一线索，写入前不要清空 verification。
    // previousTarget 在写入前读取，供 TargetChanged 描述前值；挪到写入后会让事件里的 previous 等于新值。
    // completedTarget 缺省回退 input.target，避免 store 返回空时把 undefined 传给事件与返回值。
    // source 固定为 runtime，表示状态由运行时推进而不是用户手动操作。
    const completedTarget =
      (await this.sessionStore!.updateTargetStatus({
        sessionID: this.sessionId,
        status: "complete",
      })) ?? input.target;
    await this.recordTargetChanged({
      action: "status_updated",
      previousTarget,
      source: "runtime",
      target: completedTarget,
      traceContext: input.traceContext,
    });

    return {
      target: completedTarget,
      verification,
    };
  };
  return runTargetCompletionVerificationWithTelemetry(this, input, execute);
}

async function verifyTargetCompletion(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    target: SessionGoal;
    traceContext: TraceContext;
  },
): Promise<GoalCompletionVerificationOutput> {
  // 目标验证期间也允许切换 session 默认模型；请求、重试和 usage 必须共用
  // 验证开始时的模型快照，不能在 provider 返回后重新读取 Session Selection。
  // 模型快照在此刻固定，后续 createRuntimeModel、请求、重试与 usage 全部复用它。
  // [并发] 请求期间切换 session 默认模型不影响本次验证；重新读取会让同一次验证跨两个模型。
  // modelTraceContext 由输入 traceContext 派生，并补齐 model、querySource、targetId 三个属性。
  // verificationId 取 spanId，缺失时回退 traceId，保证四个生命周期事件共享同一标识。
  // foregroundExecutionId 只在存在时展开，避免把 undefined 写进事件字段。
  // [事务] started 事件在任何 provider 请求之前发出，使 UI 能在首个 token 前展示验证中状态。
  const requestedModelSelection = this.getSessionModelSelection();
  const model = createRuntimeModel(this, { selection: requestedModelSelection });
  const modelTraceContext = createChildTraceContext(input.traceContext, {
    attributes: {
      model: `${model.providerId}/${model.modelId}`,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      targetId: input.target.targetID,
    },
  });
  const verificationId = modelTraceContext.spanId ?? modelTraceContext.traceId;
  const foregroundExecutionId = this.activeForegroundExecution?.foregroundExecutionId;
  const goalIteration = await getNextTargetCompletionVerificationIteration.call(
    this,
    input.target.targetID,
  );
  const anchor = targetCompletionVerificationAnchor.call(this, input.traceContext);
  await this.appendEvent(
    this.createEvent(
      SessionEventType.TargetCompletionVerification,
      {
        ...anchor,
        ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
        goalIteration,
        status: "started",
        targetId: input.target.targetID,
        verificationId,
      },
      modelTraceContext,
    ),
    modelTraceContext,
  );
  const prepared = prepareRuntimeProviderRequest(this, {
    // 末尾若是"只有 tool_calls、没有 tool_result"的 assistant,直接去掉:
    // 带着它发请求会破坏 provider 的 tool_use/tool_result 配对约束,验证必然失败。
    entries: withoutTrailingPendingAssistantToolCallEntries(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
    ),
    prompt: formatGoalCompletionVerificationPrompt(input.target),
    // 裁判不允许使用工具:它只输出结构化判定,调用工具说明输出不可信。
    tools: [],
    applyCacheControl: true,
    model,
  });
  // verifier 直接消费完整历史但曾绕过正常请求的媒体策略；只补 capability
  // 仍会让聚合超限失败进入 fail-open。请求前统一执行能力和预算投影。
  const messages = projectMessagesForModelMediaPolicy(
    prepared.request.messages,
    model.properties.inputFormat,
  ).messages;
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      messages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      toolCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  input.events.push(modelRequestEvent);
  const modelStartedAt = Date.now();
  const networkEventStartIndex = input.events.length;

  try {
    const result = await generateTargetCompletionVerificationText.call(this, {
      abortSignal: input.abortSignal,
      events: input.events,
      request: { ...prepared.request, messages },
      model,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(input.abortSignal);
    const toolCalls = this.extractToolCallsFromResult(result);
    const modelCompleteEvent = this.createEvent(
      SessionEventType.ModelComplete,
      {
        content: result.text,
        querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
        stopReason: result.finishReason,
        toolCallCount: toolCalls.length,
        usage: result.usage,
      },
      modelTraceContext,
    );
    await this.appendEvent(modelCompleteEvent, modelTraceContext);
    input.events.push(modelCompleteEvent);
    await recordModelUsageFact(this, {
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: toolCalls.length,
      traceContext: modelTraceContext,
    });
    const verification =
      // 模型若试图调用工具,说明它没有按要求输出判定 → fail open,
      // 而不是把一次格式错误当成"目标未完成"继续续跑。
      toolCalls.length > 0
        ? failOpenGoalCompletionVerification(
            "The completion verifier attempted to call tools instead of returning a verification result.",
          )
        : parseGoalCompletionVerificationText(result.text);
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "completed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return verification;
  } catch (error) {
    await recordModelUsageFact(this, {
      error,
      events: input.events,
      model,
      networkEventStartIndex,
      querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
      startedAt: modelStartedAt,
      status: input.abortSignal?.aborted ? "cancelled" : "error",
      traceContext: modelTraceContext,
    });
    if (input.abortSignal?.aborted) {
      const preserveQueueAutoDrainOnCancel =
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      await this.appendEvent(
        this.createEvent(
          SessionEventType.TargetCompletionVerification,
          {
            ...anchor,
            ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
            goalIteration,
            status: "cancelled",
            targetId: input.target.targetID,
            ...(preserveQueueAutoDrainOnCancel ? { preserveQueueAutoDrainOnCancel: true } : {}),
            // 取消时返回 failed（passed=false）：调用方看到 passed=false 且无 nextAction
            // 会直接停止续跑，不会把"用户取消"误当成"目标完成"。
            verification: failedGoalCompletionVerification(
              "Completion verifier request was cancelled.",
            ),
            verificationId,
          },
          modelTraceContext,
        ),
        modelTraceContext,
      );
      // 用户 Stop 或队列“立即发送”打断 goal verifier 时，当前没有普通
      // executeTurn 的取消收口路径会暂停 target。如果仍保持 active，后续
      // resumeSession + sendPrompt 会被 agent 当成 goal continuation，普通用户消息会继续输出 checkpoint。
      await this.pauseActiveTargetForCancellation(modelTraceContext);
      throw error;
    }
    this.logger?.warn("Goal completion verification failed open", {
      ...traceContextToLogContext(modelTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.completion_verification.failed_open",
      module: "core.runtime",
      status: "failed",
      targetId: input.target.targetID,
    });
    // 非取消的请求失败 → fail-open（passed=true）：裁判链路自身故障不应让 goal 永久卡住。
    // 调用方收到 passed=true 会把 target 标 complete（见 execute 里的状态写入）。
    // reason 保留原始错误，供日志和 UI 区分"真完成"与"故障放行"。
    const verification = failOpenGoalCompletionVerification(
      error instanceof Error
        ? `Completion verifier request failed: ${error.message}`
        : "The completion verifier could not confirm that every goal requirement is complete.",
    );
    await this.appendEvent(
      this.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          ...anchor,
          ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
          goalIteration,
          status: "failed_closed",
          targetId: input.target.targetID,
          verification,
          verificationId,
        },
        modelTraceContext,
      ),
      modelTraceContext,
    );
    return verification;
  }
}

function targetCompletionVerificationAnchor(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): { anchorAssistantMessageId?: string; anchorTurnId?: string } {
  const anchorAssistantMessageId = this.latestAssistantMessageId;
  const anchorTurnId = this.latestAssistantTurnId ?? traceContext.turnId;
  return {
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
  };
}

async function generateTargetCompletionVerificationText(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    request: ReturnType<typeof prepareRuntimeProviderRequest>["request"];
    model: Model;
    traceContext: TraceContext;
  },
) {
  // 循环从 1 到 maxAttempts 闭区间，attempt 同时用作日志值与延时下标。
  // [失败路径] 不可重试错误立即 rethrow，保持原始错误类型，供上层识别取消与 provider 故障。
  // [资源] 每次重试先 sleep 再 throwIfTurnAborted，用户 Stop 后不会再发下一次请求。
  // 循环正常结束（理论不可达）抛显式错误，避免函数静默返回 undefined。
  // 重试复用同一个 model 与 request，只在 invocation 内刷新 runtime headers。
  const maxAttempts = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const invocationContext = {
        metadata: traceContextToLogContext(input.traceContext),
        modelCall: {
          operation: "goal_completion_verification" as const,
        },
        statusSink: this.createModelStatusSink(input.traceContext, input.events),
        traceContext: input.traceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
          abortSignal: input.abortSignal,
          model: input.model,
          traceContext: input.traceContext,
        }),
      };
      return await runWithModelInvocationContext(invocationContext, () =>
        input.model.generateText({
          abortSignal: input.abortSignal,
          ...input.request,
          // Verifier 继承已绑定的思考配置，不能套用低成本辅助调用的降档和封顶策略。
          options: { maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max },
        }),
      );
    } catch (error) {
      const retryDelayMs = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS[attempt - 1];
      if (
        input.abortSignal?.aborted ||
        retryDelayMs === undefined ||
        !isTargetVerifierStartPlanBusyFailure(error, input.model.providerId)
      ) {
        throw error;
      }

      // 目标完成验证发生在用户已看到 assistant 迭代之后；Start Plan busy
      // 是 admission 瞬时并发。先短暂重试，避免直接走 fail-open 把可恢复并发误当完成。
      this.logger?.warn("Goal completion verification retrying after Start Plan busy", {
        ...traceContextToLogContext(input.traceContext),
        attempt,
        event: "target.completion_verification.retry_start_plan_busy",
        maxAttempts,
        module: "core.runtime",
        retryDelayMs,
        status: "waiting",
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      throwIfTurnAborted(input.abortSignal);
    }
  }

  throw new Error("Goal completion verification retry loop exhausted unexpectedly.");
}

function isTargetVerifierStartPlanBusyFailure(error: unknown, providerId: string): boolean {
  return (
    START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS.has(providerId) &&
    isStartPlanBusyStreamRecoveryFailure(error)
  );
}

async function getNextTargetCompletionVerificationIteration(
  this: AgentRuntimeInternal,
  targetId: string,
): Promise<number> {
  const projection = await this.rebuildProjection();
  const targetTimeline = projection.targetCompletionVerificationTimeline.filter(
    (item) => item.targetId === targetId,
  );
  const latestIteration = targetTimeline.reduce(
    (maxIteration, item, index) => Math.max(maxIteration, item.goalIteration ?? index + 1),
    0,
  );
  // goal 迭代由 verifier lifecycle 推进，而不是普通 turn 或用户继续次数。
  // runtime 在 started/completed/failed_closed/cancelled 上固定同一个编号，UI 与 snapshot 才不会各自猜。
  return latestIteration + 1;
}

// 这是历史裁剪的唯一实现：仅当末条是 assistant 且带非空 toolCalls 时才丢弃它。
// [失败路径] 保留这条会让 provider 因 tool_use 无配对 tool_result 拒绝请求，验证全部失败并 fail-open。
// attachment 条目先判，避免把附件包装误当成待配对的 assistant。
// 其余情况原样返回同一数组引用，不复制历史，请求构造没有额外开销。
function withoutTrailingPendingAssistantToolCallEntries(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  const last = entries.at(-1);
  if (
    !last ||
    isRuntimeAttachmentEntry(last) ||
    last?.message.role !== "assistant" ||
    !last.message.toolCalls ||
    last.message.toolCalls.length === 0
  ) {
    return entries;
  }
  return entries.slice(0, -1);
}
