// ============================================================
// model/runner-generate —— generateText 尝试循环与重试编排
// 定位：执行非流式模型请求，负责准入、逐 attempt 状态事件、失败分类、重试/退避与
//       reasoning 签名修复重试；是 adapter 侧唯一的非流式重试闭环。
// 输入：AiSdkModelTextRequest + resolved + retry 配置 + runtime + statusSink。
// 输出：ModelTextResult（文本/finishReason/usage/reasoning/toolCalls/toolResults/sources/metadata）。
// 副作用：网络请求、进程级准入票据、status 事件、debug 落盘、日志、退避 sleep。
// 失败语义：不可重试或预算耗尽时 throw adapter error（区分 prepare/response/connect 阶段）；
//       abort 立即拒绝（不等 provider settle）；ModelRequestAuthMissing 原样上抛。
// 不变量：每次物理请求结束（成功/失败/抛出）都经 finally 归还准入票据；签名修复只作用于
//       请求副本且只给一次机会；空完成重试有独立计数，不改变 canonical history。
// ============================================================
// ============================================================
// [职责边界] runner-generate：非流式 generateText 的尝试循环与重试编排，adapter 侧唯一的非流式重试闭环。
// 做：准入 → 构造 options → 发起请求 → 归一化结果 → 失败分类 → 重试 / 签名修复 / 放弃。
// 不做：不拼 prompt、不裁剪 context、不写会话历史、不落 transcript、不决定 UI 展示口径。
// 依赖方向：contracts 类型与错误码 ← 本文件 → runner-* 纯工具；工具不得反向依赖本文件。
// 副作用：网络请求、进程级准入票据、status 事件、debug 落盘、日志、退避 sleep。
//
// [阅读顺序] for 三段（准入 / attempt try / catch 决策）→ waitForGenerateTextOrAbort 本地取消边界
// → 两个状态发布辅助函数。
//
// 下列不变量是硬约束：写「优化」前先确认没有踩中，任何一条被破坏都会造成重试风暴或重复计费。
// INV-01 断言：每次物理请求结束都必须归还准入票据 —— 守住它的位置：attempt 的 finally 与退避前的显式 release —— 改错故障：槽位泄漏，后续请求永久排队直到超时。
// INV-02 断言：abortSignal 一旦 abort 必须立即拒绝，不等 provider settle —— 守住它的位置：waitForGenerateTextOrAbort —— 改错故障：runtime 已 Stop 而 verifier 仍悬挂，取消形同虚设。
// INV-03 断言：退避 sleep 之前必须已归还票据 —— 守住它的位置：release 与 sleep 的先后顺序 —— 改错故障：整个退避窗口占着槽位，失败率越高吞吐越差。
// INV-04 断言：usage 只从最终结果取一次，不跨 attempt 累加 —— 守住它的位置：normalizeUsage 调用点 —— 改错故障：重试后的 token 被重复计费，账单与日志同时膨胀。
// INV-05 断言：签名修复只允许一次且只改请求副本 —— 守住它的位置：signatureRepairAttempted 与 requestMessages 的赋值 —— 改错故障：400 无限循环，或 canonical history 被就地改写。
// INV-06 断言：签名修复与鉴权重试不占用普通重试预算 —— 守住它的位置：for 条件里的 Number(signatureRepairAttempted) 与 authRetry.extraAttempts —— 改错故障：一次 400 后预算少一格，可重试的瞬态错误被提前放弃。
// INV-07 断言：空完成重试使用独立计数 —— 守住它的位置：emptyCompletionRetryCount —— 改错故障：空重试吃掉普通预算，真实重试机会被挤掉。
// INV-08 断言：鉴权刷新同一请求只触发一次 —— 守住它的位置：authRetry.claim 的返回值 —— 改错故障：两个并发路径同时刷新，后发凭据覆盖先发。
// INV-09 断言：ModelRequestAuthMissing 必须原样上抛 —— 守住它的位置：catch 开头的类型判断 —— 改错故障：凭据缺失被包装成可重试失败，用户看到无限重试。
// INV-10 断言：错误阶段只在 prepare/response/connect 三处取值 —— 守住它的位置：requestInvocationCompleted 与两处 errorPhase —— 改错故障：本地准备失败被记成 provider 故障，归因与告警全部错位。
// INV-11 断言：业务结束错误必须在归一化之前抛出 —— 守住它的位置：detectProviderBusinessFinishError 的调用顺序 —— 改错故障：200 包装的业务错误被当成成功，空结果继续往下走。
// INV-12 断言：每个 attempt 独立构造请求副本与状态上下文 —— 守住它的位置：attemptRequest 与 createAttemptStatusContext —— 改错故障：上一轮的 header 或序号泄漏到下一轮，状态事件错序。
// INV-13 断言：鉴权刷新只换票据不换模型身份 —— 守住它的位置：resolveModelForAttempt —— 改错故障：重试打到另一个模型，计费与能力判断同时失真。
// INV-14 断言：off-peak queued 不消耗预算且回退 attempt —— 守住它的位置：attempt -= 1 分支 —— 改错故障：排队几次就把预算耗光，真正可重试的错误直接落败。
// INV-15 断言：每个 attempt 最多发布一次 completed 或 failed —— 守住它的位置：成功 return 前的 publishModelStatus 与 catch 里的发布 —— 改错故障：消费方重复计数，进度与耗时翻倍。
// INV-16 断言：准备阶段失败不得落 debug 请求体 —— 守住它的位置：catch 里 options 为 undefined 的分支 —— 改错故障：没发出去的请求被当成已发送留痕，排查时对不上账单。
// INV-17 断言：事件监听必须成对注册与移除 —— 守住它的位置：waitForGenerateTextOrAbort 的 cleanup —— 改错故障：长时间运行后监听器堆积，每次取消触发多次回调。
// INV-18 断言：循环正常退出必须有兜底错误 —— 守住它的位置：for 之后的 throw —— 改错故障：返回 undefined，调用方在下游随机位置崩溃。
import type { Logger, ModelStatusSink, ModelTextResult } from "@zcode/contracts";
import {
  ModelErrorCode,
  ModelProtocolError,
  ModelRetryReason,
  ModelTransportKind as ModelTransportKindValue,
} from "@zcode/contracts";
import { classifyModelFailure, inspectProviderFailure } from "./failure-classifier.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { AiSdkModelAdapterError } from "./errors.js";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import { createGenerateTextOptions } from "./runner-options.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolCalls,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";
import {
  isDevelopmentModelIOEnv,
  recordGenerateTextDebug,
  shouldRecordModelIO,
} from "./runner-debug.js";
import {
  createEmptyContextExceededError,
  getGenerateTextResultMetadata,
  isZeroOutputModelCompletion,
  logGenerateTextDiagnostics,
} from "./runner-diagnostics.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  toAdapterError,
} from "./runner-retry.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
} from "./runner-status.js";
import type { EnvRecord } from "./model-execution.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { AccountRequestRetry } from "./account-request-retry.js";
import { resolveModelForAttempt, RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { retryAllowedByFailurePolicy } from "./workflow-model-failure-policy.js";
import { modelFailureStatusFields, providerRequestIdFromHeaders } from "./runner-telemetry.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import {
  retryAttemptLoopContinues,
  retryBudgetAllows,
  retryBudgetMaxAttempts,
} from "./retry-budget.js";

/**
 * 非流式生成主入口：按重试预算循环执行 attempt，直到成功、失败不可重试或预算耗尽。
 * 输入 request/resolved/retry/runtime；输出归一化后的 ModelTextResult。
 * 副作用：准入票据（finally 归还）、网络请求、状态事件、debug 落盘、日志、退避 sleep。
 * 失败语义：abort/准入失败/退避取消都以 adapter error 抛出；业务错误按分类决定是否重试。
 * 不变量：每个 attempt 独立构造 options 与 statusContext；重试延迟前必须先释放准入票据。
 */
// [契约] 入口只接收已解析的 resolved 与 retry 配置，模型解析留在 resolveModel 回调里，重试时可换成新票据
// 该函数不捕获最终错误：不可重试与预算耗尽都抛 adapter error，由 core 决定用户提示
// statusSink 与 request.statusSink 是两条通道，前者给宿主观测，后者给单次请求订阅者，不能合并
// modelIoFullRetentionEnabled 只影响 debug 落盘体积，不改变发往 provider 的内容
export async function runGenerateText(input: {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  modelIoFullRetentionEnabled: boolean;
}): Promise<ModelTextResult> {
  // 重试预算档位：workflow actor 的请求带 unbounded，
  // 只放宽瞬态失败的放弃条件；状态事件里的 maxAttempts 以 0 表示无上限。
  // [契约] retryBudget 来自请求侧，workflow 流量是无上限档，交互流量是有界档，二者放弃条件不同
  // 预算档位只决定「是否还允许重试」，不决定单次延迟，延迟始终由 calculateRetryDelay 统一计算
  // 不要把无上限理解成无限重试：鉴权、签名、空完成各有独立的一次性机会
  // 状态事件里的 maxAttempts 用 0 表示无上限，消费方不得把它当成真实次数展示
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Http,
  });
  const recordModelIO =
    input.request.metadata?.skipTranscript !== true && shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  let requestMessages = input.request.messages;
  let signatureRepairAttempted = false;
  const authRetry = new AccountRequestRetry(input.request, input.resolved, input.logger);
  // [权衡] 空完成重试单独计数，不占普通重试预算，也不改变 for 里 attempt 的语义
  // 它只在 provider 正常 resolve 出零输出时触发，异常路径一律走 catch，两者不能互相兜底
  // 计数上限由 canRetryEmptyCompletion 判定，这里只维护事实，不重复实现规则
  // 每次整轮调用重置为 0，跨轮共享会让后续请求一上来就被判超额
  let emptyCompletionRetryCount = 0;

  // [并发] 循环条件同时看预算、attempt 与两个一次性机会，任一变化都会改变是否继续
  // 条件里的 extraAttempts 是已用掉的物理请求，attempt 与之的差就是还剩多少普通预算
  // 不要在循环体里 break 成功路径：成功靠 return，失败靠 throw，条件只负责自然收口
  // 循环天然顺序执行，禁止并发发多个 attempt，否则状态事件顺序与票据计数都会错乱
  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(signatureRepairAttempted) + authRetry.extraAttempts,
    );
    attempt += 1
  ) {
    // [事务] 它是扣除一次性机会后的真实预算序号，重试延迟与预算判定都用这个值
    // 直接用 attempt 会让签名修复或鉴权重试提前吃掉普通预算，表现为预算突然少一格
    // 该值每轮重算不缓存，因为两个一次性机会的计数会在 catch 中变化
    // 退避延迟按它取值，保证第 N 次普通重试的退避曲线不因一次性机会跳档
    const retryBudgetAttempt = attempt - Number(signatureRepairAttempted) - authRetry.extraAttempts;
    const attemptRequest = { ...input.request, messages: requestMessages };
    const startedAt = Date.now();
    let resolved = input.resolved;
    let statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(signatureRepairAttempted) + authRetry.extraAttempts),
      },
      attempt,
    );
    let options: ReturnType<typeof createGenerateTextOptions> | undefined;
    let requestInvocationCompleted = false;
    let requestHeaders: Record<string, string> = {};
    let requestHeaderCount = 0;

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出都经 finally；退避 sleep 之前先归还）。等待中被
    // 取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    // 取消/准入失败：本地边界立即失败，不进入 provider 响应归因。
    // [资源] 准入变量在 try 之外声明，因为 catch 与 finally 都要访问它，且等待失败时还没有票据
    // 准入前不构造 options：拿不到槽位就不该准备请求，避免无谓的凭据解析与 header 计算
    // 等待中被取消与 sleep 被取消同属 connect 阶段失败，不能记成 provider 响应失败
    // 准入失败直接抛出，不进入重试决策，因为排队超时后再重试只会继续排队
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        model: { providerId: String(resolved.providerId), modelId: String(resolved.modelId) },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(statusContext, attempt, statusPublishOptions(input)),
      });
    } catch (admitError) {
      const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount,
          requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          ...modelFailureStatusFields(admitError, admitFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input),
          failureError: unwrapRetryError(admitError),
        },
      );
      throw toAdapterError(admitError, admitFailure, statusContext, attempt, {
        errorPhase: "connect",
      });
    }

    try {
      // 每次 attempt 重新解析模型句柄：鉴权刷新可能更换票据，但不得更换模型身份。
      // [契约] 重解析只换票据不换模型：把 resolveModel 结果缓存到 attempt 外，鉴权刷新后仍打旧 provider 身份。
      // authRetry.takeReason 读取即消费，重复读会让状态事件丢失真实的刷新原因
      // prepareRequest 产出的请求副本只用于本次 attempt，不能回写 input.request
      // 解析失败属于网络前失败，errorPhase 必须是 prepare，不能算成 provider 响应
      resolved = await resolveModelForAttempt({
        attempt,
        reason: authRetry.takeReason(),
        request: authRetry.prepareRequest(attemptRequest),
        resolveModel: input.resolveModel,
      });
      const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
        env: input.env,
        providerKind: resolved.providerKind,
        sessionId: statusContext.sessionId,
      });
      // [契约] options 在准入成功后才构造，header 与 body 都在此刻定型，重试不复用上一轮对象
      // includeModelIO 只控制是否把原始 IO 带进 debug，不改变发往 provider 的字段
      // anthropicMetadataUserId 依赖 session 与 providerKind，解析失败不得降级成空串静默发出
      // 这里产出的 headers 只用于状态与脱敏展示，真实请求头由 runtime 持有
      options = createGenerateTextOptions({
        anthropicMetadataUserId,
        env: input.env,
        includeModelIO: recordModelIO,
        request: attemptRequest,
        resolved,
        statusContext,
      });
      requestHeaders = sanitizeModelNetworkHeaders(options.headers);
      requestHeaderCount = Object.keys(requestHeaders).length;
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          requestHeaderCount,
          requestHeaders,
          timestamp: new Date(startedAt).toISOString(),
          type: "model_request_started",
        },
        statusPublishOptions(input, admission),
      );

      // 部分非流式 provider/fetch 兼容层收到 AbortSignal 后不会及时 settle
      // generateText promise，导致 runtime 已 Stop，goal verifier 仍要等上游自然返回才收口。
      // adapter 是本地取消契约边界：signal 一旦 abort 就立即拒绝，迟到 provider 结果只丢弃。
      // [失败路径] provider 或 fetch 兼容层收到 AbortSignal 后不一定及时 settle，本地边界必须自己兜底
      // 先拿到 pending promise 再登记监听，顺序反了会漏掉「注册前已 abort」的竞态
      // signal 一旦 abort 就立即 reject，迟到的 provider 结果只丢弃，不允许再写状态或 debug
      // 该边界只负责取消不做超时：超时属于 provider 与上层策略，混进来会让错误归因失真
      const pendingResult = input.runtime.generateText(options);
      // options 构造成功不等于 runtime 已接受请求；同步 setup 异常会在调用点直接抛出。
      // 只有 generateText 调用返回 pending promise 后才进入 response 归因边界，避免把本地 setup 记成 provider。
      requestInvocationCompleted = true;
      const result = await waitForGenerateTextOrAbort(pendingResult, input.request.abortSignal);
      const responseHeaders = sanitizeModelNetworkHeaders(
        getGenerateTextResultMetadata(result)?.response?.headers,
      );
      // [契约] 有的 provider 用 200 加业务错误码表达失败，必须在归一化之前把它转成异常
      // 检测依赖 rawFinishReason 与 response 原文，归一化会丢字段，所以顺序不能换
      // 业务错误一旦成立就抛出，交给下面的 catch 统一分类，不在这里决定是否重试
      // 不要为了少一次异常把它改成返回值，catch 才是唯一的重试决策入口
      const providerBusinessFinishError = detectProviderBusinessFinishError({
        providerId: String(resolved.providerId),
        providerKind: resolved.providerKind,
        source: {
          finishReason: result.finishReason,
          providerMetadata: result.providerMetadata,
          rawFinishReason: (result.providerMetadata as Record<string, unknown> | undefined)
            ?.rawFinishReason,
          response: (result as unknown as { response?: unknown }).response,
        },
      });
      if (providerBusinessFinishError) {
        throw providerBusinessFinishError;
      }
      // [事务] usage 只在这里从最终结果取一次，绝不跨 attempt 累加，重试的前几次不产生账单
      // 优先 totalUsage 再退回 usage：前者含缓存与推理明细，后者在部分 provider 上是残缺的
      // 不要把失败 attempt 的用量手动并进来，provider 已计费的部分由错误对象自带
      // 归一化失败不能让整个请求失败，usage 是观测数据，缺失时应降级而不是抛出
      // 该对象随后进入状态事件与返回值，两处必须是同一份引用，避免出现两套计费口径
      const usage = normalizeUsage(result.totalUsage ?? result.usage);
      const toolCalls = normalizeToolCalls(result, input.logger);
      const toolResults = normalizeToolResults(result, toolCalls);
      const sources = normalizeSources(result);
      const text = input.request.responseJsonSchema
        ? serializeStructuredOutput(result)
        : result.text;
      const reasoning = normalizeReasoning(result.reasoning);
      // [契约] 空完成且疑似上下文超限时要给出可诊断错误，而不是让 core 收到一段空文本
      // 判定同时看 finishReason、rawFinishReason、是否有 assistant 内容与工具调用，缺一都会误判
      // 有 reasoning 但没有 text 不算空完成，思考块本身就是有效产物
      // 该错误必须在空完成重试之前判定，否则会把本可直接失败的请求再打一次
      const contextError = createEmptyContextExceededError({
        finishReason: result.finishReason,
        rawFinishReason: result.rawFinishReason ?? result.providerMetadata?.rawFinishReason,
        hasAssistantContent:
          text.length > 0 ||
          (reasoning ?? []).some(
            (block) => block.text.length > 0 || Object.keys(block.providerOptions ?? {}).length > 0,
          ),
        toolCallCount: toolCalls?.length ?? 0,
        usage,
      });
      if (contextError) throw contextError;
      const reasoningLength = (reasoning ?? []).reduce(
        (total, block) => total + block.text.length,
        0,
      );
      if (
        // [权衡] 该开关为 true 表示调用方要求保留 provider 的原始边界，此时禁用空完成重试
        // 开关只影响「是否重试空完成」，不改变结果归一化，也不改变用量口径
        // 关闭重试是为了避免把有语义的空流当成故障重放，例如显式结束帧
        // 判定放在零输出启发式外层，保证开关优先级高于启发式
        input.request.preserveProviderStreamBoundaries !== true &&
        isZeroOutputModelCompletion({
          finishReason: result.finishReason,
          rawFinishReason:
            result.rawFinishReason ??
            (result.providerMetadata as Record<string, unknown> | undefined)?.rawFinishReason,
          reasoningLength,
          textLength: text.length,
          toolCallCount: toolCalls?.length ?? 0,
          usage,
        }) &&
        canRetryEmptyCompletion({
          abortSignal: input.request.abortSignal,
          attempt,
          maxAttempts: input.retry.maxAttempts,
          retryCount: emptyCompletionRetryCount,
        })
      ) {
        const completedAt = Date.now();
        // 空 completion 是 provider promise 正常 resolve，不会进入异常重试 catch；
        // 必须在 adapter 返回前识别并重试一次，否则 core 只能收到最终空响应错误。
        logGenerateTextDiagnostics({
          attempt,
          completedAt,
          logger: input.logger,
          result,
          startedAt,
          statusContext,
          toolCallCount: toolCalls?.length ?? 0,
          usage,
        });
        // [事务] 自增必须发生在调度重试之前，否则重试回来的空完成仍会被判成第一次
        // 计数只在真正 continue 的分支里增加，其他失败路径不得偷加，否则会提前耗尽机会
        // 空完成是正常 resolve，不会进入 catch，因此日志与状态发布必须在这里自己补齐
        // 重试延迟与状态事件交给 scheduleEmptyCompletionRetry，避免出现两份退避实现
        emptyCompletionRetryCount += 1;
        await scheduleEmptyCompletionRetry({
          abortSignal: input.request.abortSignal,
          attempt,
          completedAt,
          errorPhase: "response",
          logger: input.logger,
          requestHeaders,
          requestStatusSink: input.request.statusSink,
          responseHeaders,
          retry: input.retry,
          retryBudgetAttempt,
          startedAt,
          statusContext,
          statusSink: input.statusSink,
        });
        continue;
      }
      const completedAt = Date.now();

      // [资源] 成功路径的 debug 落盘只在 options 已构造时执行，且受保留开关限制
      // 落盘失败不应影响已经成功的结果，debug 是旁路，不能把用户请求拖下水
      // 这里同时记录原始 result 与归一化后的 toolCalls，便于排查归一化偏差
      recordGenerateTextDebug({
        modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
        attempt,
        debugDir: input.debugDir,
        isDev,
        normalizedToolCalls: toolCalls,
        options,
        recordModelIO,
        request: attemptRequest,
        requestId: statusContext.requestId,
        resolved,
        result,
        startedAt,
      });
      logGenerateTextDiagnostics({
        attempt,
        completedAt,
        logger: input.logger,
        result,
        statusContext,
        startedAt,
        toolCallCount: toolCalls?.length ?? 0,
        usage,
      });
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: completedAt - startedAt,
          finishReason: result.finishReason,
          requestHeaderCount,
          requestHeaders,
          responseHeaderCount: Object.keys(responseHeaders).length,
          responseHeaders,
          providerRequestId: providerRequestIdFromHeaders(responseHeaders),
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_completed",
          usage,
        },
        statusPublishOptions(input, admission),
      );

      return {
        text,
        finishReason: result.finishReason,
        usage,
        reasoning,
        toolCalls,
        toolResults,
        sources,
        providerMetadata: result.providerMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      // 合并后鉴权解析进入 attempt try；与 stream 一致保留网络前凭据缺失的类型化错误。
      if (
        error instanceof ModelProtocolError &&
        error.code === ModelErrorCode.ModelRequestAuthMissing
      )
        throw error;
      const completedAt = Date.now();
      // [失败路径] 分类结果决定重试分支，不允许在别处再写一套「这个错误能不能重试」
      // abort 只影响分类里的取消语义，是否重试仍由预算与策略表共同决定
      // RuntimeHeadersRefreshError 属本地刷新失败，必须强制不可重试，避免用旧 header 再打一次
      // 分类不得吞掉原始错误，后续 toAdapterError 还要靠它保留 cause 与状态码
      const classified = classifyModelFailure(error, input.request.abortSignal);
      if (error instanceof RuntimeHeadersRefreshError) {
        classified.message = error.message;
        classified.retryable = false;
      }
      // off-peak 特判（仅 idle plan provider，见 offpeak-retry.ts）：排队 429 豁免预算、
      // 3102（兼容旧 3001）以稳定标记落败触发 desktop 侧续跑。
      // [契约] off-peak 只对 accountAccess.mode 为 off-peak 的 provider 生效，其他账号走普通路径
      // queued 表示排队中，应无限探测且不消耗预算；ticketExpired 表示票据失效，必须稳定落败
      // 两个特判只在分类之后覆盖 retryable 与 message，不能改写原始状态码与错误码
      // 不要把它实现成通用重试策略：off-peak 的语义是等得起，普通请求等不起
      const offPeak = resolveOffPeakFailureDecision({
        offPeak: resolved.accountAccess?.mode === "off-peak",
        failure: classified,
        error: unwrapRetryError(error),
      });
      const failure: ClassifiedModelFailure =
        offPeak?.kind === "ticketExpired"
          ? {
              ...classified,
              retryable: false,
              message: offPeakTicketExpiredMessage(classified.message),
            }
          : offPeak?.kind === "queued"
            ? { ...classified, retryable: true, retryReason: ModelRetryReason.OffpeakQueued }
            : classified;
      const responseHeaders = sanitizeModelNetworkHeaders(
        getResponseHeaders(unwrapRetryError(error)),
      );
      // [契约] 签名修复只针对 anthropic 且只尝试一次，成功后立刻置位，防止 400 循环
      // 修复只作用于 requestMessages 副本，canonical history 保持原样，除非上层显式提交
      // 修复不命中时返回 undefined，调用方据此判断本轮不能走修复分支，而不是空数组
      // 不能用回退 attempt 的办法复用 requestId，那会让状态事件出现重复序号
      const repairedMessages =
        !signatureRepairAttempted && resolved.providerKind === "anthropic"
          ? repairReasoningHistoryAfterSignatureRejection(requestMessages, error)
          : undefined;
      const retryWithRepairedHistory = repairedMessages !== undefined;
      if (repairedMessages) {
        // 签名只对生成它的 thinking block 有效。明确收到签名校验 400 时，
        // 只替换本次请求副本，并给一次不占普通 retry 预算的物理请求机会；不能通过
        // 回退 attempt 复用 requestId，也不能改写 canonical history。
        signatureRepairAttempted = true;
        requestMessages = repairedMessages;
        statusContext = {
          ...statusContext,
          maxAttempts: statusMaxAttempts(1 + authRetry.extraAttempts),
        };
      }
      // [权衡] 有界预算逐字沿用分类器的 retryable，无上限预算才读策略表，两套语义不能混用
      // 预算判定与策略判定必须同时成立，缺一都会让不该重试的错误被放大成风暴
      // providerErrorCode 取自原始错误而非包装错误，包装层会丢掉业务码
      // off-peak queued 直接短路为可重试，但它不经过预算，因此也不在普通退避曲线上
      const canRetryWithFailurePolicy =
        offPeak?.kind === "queued"
          ? true
          : retryBudgetAllows(retryBudget, retryBudgetAttempt, input.retry.maxAttempts) &&
            // workflow 流量（无上限预算）读策略表而不是分类器的 retryable；有界预算逐字不变。
            retryAllowedByFailurePolicy(
              failure,
              retryBudget,
              inspectProviderFailure(error).providerErrorCode,
            );
      // [并发] 鉴权重试由 AccountRequestRetry 单飞，claim 只在真正需要刷新时返回真且只成功一次
      // options 为 undefined 表示失败发生在准备阶段，此时才允许用凭据缺失触发刷新
      // 鉴权重试不进入退避 sleep，直接 continue，因为延迟对刷新凭据没有意义
      // claim 成功会改变额外尝试计数，后续状态上下文的 maxAttempts 必须重新计算
      const retryWithAuth = authRetry.claim(error, options === undefined);
      if (retryWithAuth)
        statusContext = {
          ...statusContext,
          maxAttempts: statusMaxAttempts(
            Number(signatureRepairAttempted) + authRetry.extraAttempts,
          ),
        };
      // [契约] 三种重试来源取并集：鉴权刷新、签名修复、失败策略，任一成立即可继续
      // 并集不代表可叠加：每轮只会命中其中一条分支，判断顺序决定状态事件里的重试原因
      // 这个布尔值同时用于状态事件的 retryable 与是否抛出，两处必须同源
      // 不要把它提前算到 catch 之外，分类与 off-peak 覆盖都还没发生
      const canRetry = retryWithAuth || retryWithRepairedHistory || canRetryWithFailurePolicy;

      if (options) {
        recordGenerateTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          error,
          isDev,
          normalizedToolCalls: undefined,
          options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusContext.requestId,
          resolved,
          startedAt,
        });
      }
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: completedAt - startedAt,
          message: failure.message,
          reason: failure.reason,
          requestHeaderCount,
          requestHeaders,
          responseHeaderCount: Object.keys(responseHeaders).length,
          responseHeaders,
          retryable: canRetry,
          statusCode: failure.statusCode,
          ...modelFailureStatusFields(error, failure, options ? "response" : "prepare"),
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_failed",
          ...(error instanceof AiSdkModelAdapterError && error.usage ? { usage: error.usage } : {}),
        },
        {
          ...statusPublishOptions(input, admission),
          failureError: unwrapRetryError(error),
        },
      );

      // [失败路径] 放弃前必须先发 model_request_failed 再抛出，顺序反了消费方收不到终态
      // 错误阶段用 requestInvocationCompleted 区分：已调用 generateText 记 response，否则记 prepare
      // toAdapterError 会保留原始 cause 与分类字段，不要在调用前自己拼错误对象
      // 日志里的 canRetry 为假，用于区分预算耗尽与策略禁止这两类放弃
      if (!canRetry) {
        logRetryDelayDecision({
          attempt,
          canRetry,
          failure,
          logger: input.logger,
          responseHeaders,
          statusContext,
        });
        throw toAdapterError(error, failure, statusContext, attempt, {
          errorPhase: requestInvocationCompleted ? "response" : "prepare",
        });
      }

      if (retryWithAuth) {
        await publishRetryScheduledStatus(
          input,
          statusContext,
          attempt,
          0,
          { ...failure, retryReason: ModelRetryReason.AuthRefresh },
          requestHeaders,
          responseHeaders,
        );
        continue;
      }

      // [事务] 签名修复重试不发退避 sleep，立即用修复后的历史重发，因为它不占普通预算
      // 状态事件必须带 admission，修复请求仍持有本轮票据，不能当成无票据重试
      // 修复重试的原因固定为 ReasoningSignatureRepair，便于桌面侧识别并续跑
      // 不要在这里再改 requestMessages，修复结果已在 catch 前半段落定
      if (retryWithRepairedHistory) {
        input.logger?.warn("Retrying model request after thinking signature rejection", {
          attempt,
          event: "model.reasoning_signature_repair.retry",
          maxAttempts: statusContext.maxAttempts,
          nextAttempt: attempt + 1,
          requestId: statusContext.requestId,
          status: "waiting",
        });
        await publishRetryScheduledStatus(
          input,
          statusContext,
          attempt,
          0,
          {
            ...failure,
            retryReason: ModelRetryReason.ReasoningSignatureRepair,
          },
          requestHeaders,
          responseHeaders,
          admission,
        );
        continue;
      }

      const delayMs =
        offPeak?.kind === "queued"
          ? offPeak.delayMs
          : calculateRetryDelay(input.retry, retryBudgetAttempt, failure.retryAfterMs);
      logRetryDelayDecision({
        attempt,
        canRetry,
        delayMs,
        failure,
        logger: input.logger,
        responseHeaders,
        statusContext,
      });

      await publishRetryScheduledStatus(
        input,
        statusContext,
        attempt,
        delayMs,
        failure,
        requestHeaders,
        responseHeaders,
        admission,
      );

      // 退避期间不持票：槽位让给别人，重试再准入。
      // [资源] 退避期间不持票：先把槽位让给别人，sleep 结束再重新准入
      // 这行释放与 finally 里的释放是幂等的，重复调用不会重复归还
      // 如果把它挪到 sleep 之后，整个退避窗口都会占着槽位，失败率越高吞吐越差
      // 释放必须发生在 sleep 之前且在任何 await 之前，保证取消时票据已经归还
      // 释放后不要再访问 admission 的其他字段，语义上它已经不属于本次尝试
      admission.release();
      try {
        // [失败路径] sleep 被 abort 中断属于 connect 阶段取消，不是 provider 响应失败
        // 取消时的状态发布不带 admission，因为票据已在上一行归还，不能重复归还
        // 错误分类仍走 classifyModelFailure，保证取消与准入取消得到同一种错误形态
        // 这里抛出之后不会再回到 for 循环，finally 里的释放是空操作
        await sleep(delayMs, input.request.abortSignal);
      } catch (sleepError) {
        const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
        const sleepResponseHeaders = sanitizeModelNetworkHeaders(
          getResponseHeaders(unwrapRetryError(sleepError)),
        );
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            message: sleepFailure.message,
            reason: sleepFailure.reason,
            requestHeaderCount,
            requestHeaders,
            responseHeaderCount: Object.keys(sleepResponseHeaders).length,
            responseHeaders: sleepResponseHeaders,
            retryable: false,
            statusCode: sleepFailure.statusCode,
            ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
            timestamp: new Date().toISOString(),
            type: "model_request_failed",
          },
          {
            // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
            ...statusPublishOptions(input),
            failureError: unwrapRetryError(sleepError),
          },
        );
        throw toAdapterError(sleepError, sleepFailure, statusContext, attempt, {
          errorPhase: "connect",
        });
      }
      if (offPeak?.kind === "queued") {
        // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试，无限探测。
        attempt -= 1;
      }
    // [资源] finally 是票据归还的最后一道保险：成功返回、失败抛出、continue 都会经过
    // 不要在 finally 里发状态事件或写日志，此时错误上下文已丢失，写出来只会误导
    // 该块必须保持极简，任何可能抛出的操作都会掩盖真正的失败原因
    } finally {
      admission.release();
    }
  }

  throw new AiSdkModelAdapterError(
    ModelErrorCode.ModelRequestFailed,
    "Model request failed before an attempt could complete",
    { context: { requestId: baseStatusContext.requestId } },
  );
}

/**
 * 结构化输出序列化：从 SDK result.output 取结构化结果并 JSON 字符串化。
 * 缺失或不可序列化直接抛错（视为 provider 未按 schema 返回），不返回空串兜底。
 */
// [契约] 结构化输出只认 result.output，缺失即视为 provider 未按 schema 返回，直接抛错
// 不返回空串兜底：空串会被下游当成合法 JSON 文本，错误被推迟到更难定位的地方
// JSON.stringify 对 undefined 返回 undefined，必须显式判空后再返回
// 该函数是纯函数，不读请求也不做 schema 校验，校验属于上层
function serializeStructuredOutput(result: unknown): string {
  const output = (result as { output?: unknown }).output;
  if (output === undefined) {
    throw new Error("Structured output is unavailable");
  }
  const serialized = JSON.stringify(output);
  if (serialized === undefined) {
    throw new Error("Structured output is unavailable");
  }
  return serialized;
}

/**
 * 等待 generateText 结果，但一旦 abortSignal 触发就立刻拒绝，迟到结果被丢弃。
 * 无 signal 时直接返回原 promise；监听器在 settle 后移除，避免泄漏。
 * 拒绝值优先使用 signal.reason（Error），否则用固定取消文案。
 */
// [契约] 该函数是本地取消边界的唯一实现，所有非流式等待都必须经过它
// 无 signal 时直接返回原 promise，不做额外包装，避免多一层微任务延迟
// 竞态顺序：先判断已取消再注册监听，保证注册前的取消不会漏掉
// 拒绝值优先用 signal.reason，缺失时才用固定文案，保证取消原因可追溯
function waitForGenerateTextOrAbort<T>(
  pending: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (!abortSignal) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(
        abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error("Model request was cancelled."),
      );
    };

    if (abortSignal.aborted) {
      onAbort();
      return;
    }

    // [资源] 监听器必须 once，且 settle 后手动清理，双保险防止重复拒绝
    // 两个 settle 分支都要先清理再 resolve 或 reject，顺序反了会留下悬挂监听
    // pending 的拒绝值必须原样透传，不能在这里包装成 adapter error
    // 一个 signal 可能服务多次尝试，每次都要独立注册与移除，不能缓存监听状态
    abortSignal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** 汇总状态发布参数：观测端口、日志、请求/会话 sink，以及本次尝试的准入票据（若有）。 */
function statusPublishOptions(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    resolved?: Pick<ResolvedAiSdkModel, "requestObservations">;
    statusSink?: ModelStatusSink;
  },
  admission?: AttemptAdmission,
) {
  return {
    requestObservations: input.resolved?.requestObservations,
    logger: input.logger,
    requestStatusSink: input.request.statusSink,
    statusSink: input.statusSink,
    // 本次尝试的准入票据也是它的状态事件汇。
    ...(admission?.ticket === undefined ? {} : { admissionTicket: admission.ticket }),
  };
}

/**
 * 发布 model_retry_scheduled 事件：携带 delayMs/nextAttempt、重试原因与本次失败诊断字段。
 * 调用方保证此时仍有（或无需）准入票据；发布失败按 sink 语义处理，不影响重试决策。
 */
async function publishRetryScheduledStatus(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    statusSink?: ModelStatusSink;
  },
  statusContext: ReturnType<typeof createStatusContext>,
  attempt: number,
  delayMs: number,
  failure: ReturnType<typeof classifyModelFailure>,
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
  admission?: AttemptAdmission,
): Promise<void> {
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      delayMs,
      message: failure.message,
      nextAttempt: attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(requestHeaders).length,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      statusCode: failure.statusCode,
      errorCode: failure.code,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    statusPublishOptions(input, admission),
  );
}
