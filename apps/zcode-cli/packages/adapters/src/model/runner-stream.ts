// ============================================================
// model/runner-stream —— 流式模型请求的 attempt 循环与重试/状态编排
// 定位：驱动 AI SDK streamText 的 fullStream，负责 idle timeout、重试预算、准入票据、
//       空完成/业务错误识别、reasoning 签名修复与 model I/O 记录。
// 输入：request/resolved/retry/model resolver/runtime/statusSink/env/debugDir；输出：ModelStreamEvent 异步流。
// 副作用：发起网络请求、写 model-io、发布状态与遥测、持有准入票据；结束时必须释放。
// 失败语义：已发出可见输出后不再重试；错误统一经 classifyModelFailure/toAdapterError 归一化后抛出。
// 不变量：仅 emittedRetryBoundaryEvent=false 才可重放；每次 attempt 必须 abort 并关闭 iterator；
//          准入票据在 sleep 前或 finally 中归还（幂等）；abort 传播为 cancelled。
// ============================================================
// ============================================================
// 深度注释：不变量表（INV）
// 本文件是「重试正确性」的咽喉：一次写错不会编译失败，而是在线上表现为重复输出、
// 请求洪峰打满 provider 并发、或 fallback 卡死在发送前。下面每条都注明守住它的位置。
// INV-01 只有 emittedRetryBoundaryEvent=false 的 attempt 可被重放；越过 SSE 重试边界后
//   失败只能上抛给 Core 走 stream recovery（守住它的位置：canRetryStreamFailure 的第一道门）。
//   改错了：同一段回复被 yield 两次、工具被执行两次。
// INV-02 每次 attempt 必须 abort + 关闭 iterator，且两者成对出现（守住它的位置：
//   finally 的 !streamReachedNaturalEnd 分支 + closeStreamIteratorBestEffort）。
//   改错了：AI SDK fullStream 的 tee 分支继续持有旧 provider 连接，后续请求卡在发送前。
// INV-03 准入票据幂等归还，且可重试失败必须在 sleep 前归还（守住它的位置：
//   catch 尾部的 admission.release() 与 finally 的兜底 release）。
//   改错了：退避期间仍占并发槽，全局并发被慢 provider 拖死。
// INV-04 reasoning 签名修复只改本次请求副本 requestMessages，绝不写回 canonical history，
//   且每个流最多一次（守住它的位置：repairThinkingSignatureRejection 的守卫与赋值）。
//   改错了：污染历史消息，后续所有轮次都带着被删改的 thinking block。
// INV-05 签名修复 / 鉴权刷新 / off-peak 排队各自占用额外 attempt，不消耗普通 retry 预算；
//   for 条件与 retryBudgetAttempt 的减法必须同步（守住它的位置：for 条件与 retryBudgetAttempt）。
//   改错了：预算少算一档，本该重试的瞬态失败被直接判死。
// INV-06 off-peak queued 时 attempt -= 1，for 自增后原地重试，可无限探测；ticketExpired 不可重试
//   （守住它的位置：两处 if (offPeak?.kind === "queued") 与 ticketExpired 改写）。
//   改错了：排队 429 消耗预算，off-peak 任务在队列里被提前放弃。
// INV-07 空完成重试只对非 compact 请求生效，且受 canRetryEmptyCompletion 限制（守住它的位置：
//   shouldHoldEmptyCompletionEvents 与 suspicious diagnostics 分支）。
//   改错了：compact 请求被重复重放，或同一空响应无限重试。
// INV-08 空完成重试前必须清空 visibleEvents（守住它的位置：shouldHoldEmptyCompletionEvents 分支）。
//   改错了：第一次 attempt 的 start/finish 泄漏到 UI，出现空消息气泡。
// INV-09 compact 的 EPIPE/ECONNRESET/ConnectionClosed/idle timeout 必须先于通用 retryable gate 放行；
//   但已判定 response_body 阶段则不重放（守住它的位置：canRetryStreamFailure 的中间两段）。
//   改错了：陈旧连接不重试，或已提交半截正文被重放。
// INV-10 compact 的 HTTP status 取值优先级：ProviderBusinessError.responseStatus > APICallError.statusCode
//   （守住它的位置：resolveCompactHttpResponseStatus）。改错了：业务码冒充 transport status，阶段误判。
// INV-11 自然 EOF 后的合成错误顺序：provider business error 优先于 generic empty（守住它的位置：
//   runStreamText 结尾的两段 detectProviderBusinessFinishError）。
//   改错了：额度耗尽/403 空流被当成可重试的暂时性空响应。
// INV-12 每个 attempt 的终态 model_request_failed 只能发布一次（守住它的位置：terminalStatusPublished）。
//   改错了：UI 收到两次失败，重试提示闪烁。
// INV-13 流尚未提交输出时消费者提前关闭，必须收口为 Cancelled 失败（守住它的位置：
//   finally 中 !attemptFailed && !terminalStatusPublished 分支）。
//   改错了：fallback 前遗留悬空的 started 状态，客户端一直转圈。
// INV-14 RuntimeHeadersRefreshError 是确定性错误：保留原 message 并禁止重试（守住它的位置：
//   catch 中对 classified 的直接改写）。重试只会得到同样的结果。
// INV-15 ModelRequestAuthMissing 必须原样上抛，不归一化为通用请求失败（守住它的位置：
//   catch 中的 ModelProtocolError 分支）。归一化会丢掉用户可操作的鉴权提示。
// INV-16 TerminalStreamChunkError 必须直接透传 adapterError，不再进入二次分类/重试（守住它的位置：
//   catch 中第一个分支）。二次分类会丢掉已经算好的错误阶段。
// INV-17 无 raw provenance 的 direct tool-call 抛错前，必须先 yield inferred block stop（守住它的位置：
//   catch 中 compactDirectToolCallCommitEvent 分支）。
//   改错了：已被 provider 完整给出的工具调用被当成首事件前失败重放。
// INV-18 idle timeout 随重试次数线性增加，且超时只上报不改变控制流（守住它的位置：
//   resolveModelStreamIdleTimeoutMs 调用与 onTimeout 回调）。
// INV-19 retry-safe 前奏（start）在越过边界前只暂存、不 yield；边界到达后统一 flush（守住它的位置：
//   pendingRetrySafeEvents 与 applyStreamEventsToRetryBoundary）。
//   改错了：重放时 UI 出现重复的 start 元数据。
// INV-20 attempt 清理等待上限 1s，超时只告警、不覆盖原始错误（守住它的位置：
//   STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS 与 Promise.race）。
//
// 阅读顺序：attempt 循环骨架 → 单 chunk 处理 → 错误事件处理 → 重试判定 →
//           失败阶段判定 → 清理与状态发布 → 边界投影与可见性观测。
// ============================================================
import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStatusSink, ModelStreamEvent } from "@zcode/contracts";
import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelProtocolError,
  ModelRetryReason,
  ModelTransportKind as ModelTransportKindValue,
  type ModelRetryBudget,
} from "@zcode/contracts";
import {
  classifyModelFailure,
  findProviderBusinessError,
  inspectProviderFailure,
  type ClassifiedModelFailure,
} from "./failure-classifier.js";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import {
  getErrorCode,
  getHttpResponseStatus,
  getResponseHeaders,
  unwrapRetryError,
} from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { isRetrySafePreludeStreamEvent } from "./stream-retry-boundary.js";
import {
  createLinkedAbortController,
  isModelStreamIdleTimeoutError,
  readNextWithStreamIdleTimeout,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.js";
import {
  createEmptyContextExceededError,
  createStreamDiagnostics,
  isZeroOutputModelCompletion,
  isSuspiciousStreamDiagnostics,
  logIgnoredStreamChunk,
  logStreamDiagnostics,
  logStreamFailureDiagnostics,
  recordStreamChunkDiagnostic,
} from "./runner-diagnostics.js";
import { AiSdkModelAdapterError } from "./errors.js";
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import { createStreamTextOptions } from "./runner-options.js";
import {
  isDevelopmentModelIOEnv,
  recordStreamTextDebug,
  shouldRecordModelIO,
} from "./runner-debug.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import {
  retryAttemptLoopContinues,
  retryBudgetAllows,
  retryBudgetMaxAttempts,
} from "./retry-budget.js";
import { toModelStreamEvent } from "./runner-normalization.js";
import type { EnvRecord } from "./model-execution.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { createRequestVerificationEmptyStreamError } from "./request-security-edition/recovery.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
  publishModelTelemetryMilestone,
} from "./runner-status.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkStreamTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { isRequestVerificationRejection } from "./request-security-edition/recovery.js";
import { AccountRequestRetry } from "./account-request-retry.js";
import { resolveModelForAttempt, RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { retryAllowedByFailurePolicy } from "./workflow-model-failure-policy.js";
import {
  modelFailureStatusFields,
  providerRequestIdFromHeaders,
  readModelFailureErrorPhase,
} from "./runner-telemetry.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";

/** 流失败发生阶段：请求尚未建立 / 响应 body 已开始（决定 compact 是否允许重放）。 */
// 阶段只有两个取值，却决定了 compact 请求失败后能不能重放。
// request_setup 表示请求尚未建立（重试安全）；response_body 表示 body 已开始（重放会重复内容）。
// Core 侧按这个字段决定是否允许 non-stream fallback。
type StreamFailurePhase = "request_setup" | "response_body";

// 单次 attempt 清理（iterator.return + consumeStream）的硬等待上限，避免连接槽被永久占用。
// 1s 是「连接槽释放」与「重试节奏」之间的折中：等太久拖慢重试，等太短让清理半途而废。
// 超时后调用方仍会继续，但底层 reader 可能仍被 AI SDK tee 持有——这是已知的尽力而为边界。
// 不要为了「更干净」把这个值调大：失败 attempt 的清理时间会直接叠加到用户等待上。
const STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * 流式模型调用的主入口：按 attempt 循环执行 streamText，并把 chunk 投影为对外 ModelStreamEvent。
 * 每次尝试：准入 → 解析模型 → 建 options → 读流（idle timeout）→ yield 可见事件 → 发布终态。
 * 重试受 retryBudget 与 emittedRetryBoundaryEvent 双重约束；已提交可见输出后绝不重放。
 * 特殊控制流：空完成重试、off-peak 排队（不消耗预算）、鉴权刷新、reasoning 签名修复各占额外 attempt。
 * 副作用：model-io 落盘、状态/遥测发布；finally 中 abort、关闭 iterator、归还准入票据。
 * 失败语义：可重试错误退避后继续（sleep 前归还票据）；不可重试则抛 toAdapterError。
 */
export async function* runStreamText(input: {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs: number;
  modelIoFullRetentionEnabled: boolean;
}): AsyncGenerator<ModelStreamEvent> {
  // 重试预算档位：只放宽瞬态失败的放弃条件；
  // `emittedRetryBoundaryEvent` 之后不重试的规则不变。状态事件 maxAttempts 以 0 表示无上限。
  // 预算档位只放宽瞬态失败的放弃条件，不改变「已提交输出禁止重放」的硬规则。
  // workflow 流量的预算为 unbounded，此时 maxAttempts 传 0，表示状态事件不设上限。
  // 把预算当成「重试次数」直接比较是错的：它还要经过 retryBudgetAllows 的档位翻译。
  const retryBudget = input.request.modelRetryBudget;
  // 额外 attempt（签名修复/鉴权刷新）必须计入分母，否则进度会显示 2/2 之后又冒出第 3 次请求。
  // 它是纯函数，只影响对外状态文案，不参与真实的重试判定。
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Sse,
  });
  // model-io 只在显式开启时落盘：默认关闭，避免把完整请求/响应（可能含用户隐私）写到磁盘。
  // 该开关同时决定成功与失败两条记录路径，任何一处漏判都会造成样本缺失。
  const recordModelIO = shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  // requestMessages 是本次流内可变的请求副本；签名修复只替换它，绝不回写 input.request。
  // 它跨 attempt 保留：修复后的历史要一直用到本次流结束。
  let requestMessages = input.request.messages;
  let signatureRepairAttempted = false;
  // 鉴权刷新器内部维护自己的 extraAttempts；for 条件与 retryBudgetAttempt 都要把这份偏移算进去。
  // 它的 claim 是幂等的：同一次流内重复触发不会无限增加物理请求。
  const authRetry = new AccountRequestRetry(input.request, input.resolved, input.logger);
  // 空完成重试计数按整条流累计，而不是按 attempt 重置；否则每次 attempt 都能再拿一次机会。
  // 它是 canRetryEmptyCompletion 的上限依据，必须与 retry.maxAttempts 保持独立。
  let emptyCompletionRetryCount = 0;

  for (
    // for 条件同时受预算档位、额外 attempt 与 off-peak 冻结影响。
    // 任何一处改动都要同步下面 retryBudgetAttempt 的减法，否则预算会与实际物理请求数错位。
    // attempt 是物理尝试序号（含额外请求），retryBudgetAttempt 才是普通预算序号——两者不可混用。
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(signatureRepairAttempted) + authRetry.extraAttempts,
    );
    attempt += 1
  ) {
    // retryBudgetAttempt 是物理 attempt 在普通预算里的序号：签名修复与鉴权刷新占用的请求要扣掉。
    // 退避时长、预算判定、状态文案都用这个序号；直接用 attempt 会让额外请求挤占普通重试机会。
    // 减法结果可能小于 1，调用方（calculateRetryDelay 等）必须能接受这种初值。
    const retryBudgetAttempt = attempt - Number(signatureRepairAttempted) - authRetry.extraAttempts;
    const startedAt = Date.now();
    // SSE idle timeout 后的重试如果仍固定首请求窗口，容易被同一段 provider 静默窗口反复打断；
    // core recovery 和 adapter 内部 retry 都统一按重试次数每次增加 30s。
    // 单次 attempt 的 idle 窗口随重试次数递增：provider 的静默窗口有惯性，固定首请求窗口会反复命中同一段。
    // retryNumber 叠加了请求级已重试次数，保证跨层（core recovery + adapter retry）的窗口一致。
    const streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
      baseTimeoutMs: input.streamIdleTimeoutMs,
      retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + retryBudgetAttempt - 1,
    });
    // 以下五个 emitted 与 retry 标记都是「单 attempt 事实」，不能跨 attempt 复用。
    // 它们是 finally 清理与重放判定的唯一依据；漏置位会导致该清理的不清理、该拦的重放。
    let emittedEvent = false;
    // 本 attempt 是否已越过 SSE 重试边界；一旦为 true，本次失败不再重放。
    // 它由 handleStreamChunk 的返回值单调合并，任何分支都不得把它改回 false。
    let emittedRetryBoundaryEvent = false;
    let emittedError = false;
    let retryScheduledFromStreamChunk = false;
    let offPeakQueueHoldFromStreamChunk = false;
    // 越过边界前，start 等前奏只入队不 yield；边界到达后按序 flush，保证 UI 只看到一份元数据。
    // 队列必须在本 attempt 内清空（flush 或 finally 兜底），否则会串到下一次 attempt。
    const pendingRetrySafeEvents: ModelStreamEvent[] = [];
    const diagnostics = createStreamDiagnostics();
    // linked controller 让调用方取消自动传播到本 attempt，同时允许 attempt 结束时单独 abort。
    // cleanup() 负责摘掉对调用方 signal 的监听；长流 + 多次重试时不做会积累 listener。
    // abort 之后 signal.reason 就是错误分类的依据，不要用新 Error 覆盖原始取消原因。
    const attemptAbortController = createLinkedAbortController(input.request.abortSignal);
    // attemptRequest 只替换 abortSignal 与 messages：headers、模型解析等仍走 options。
    // 两处各写一份请求会导致签名修复只作用于其中一条路径。
    const attemptRequest = {
      ...input.request,
      abortSignal: attemptAbortController.signal,
      messages: requestMessages,
    };
    // statusContext 在鉴权刷新/签名修复时会重建，以便 maxAttempts 反映额外机会。
    // 重建只改分母相关字段，requestId 等身份字段必须沿用，否则 UI 会对不上同一次请求。
    let statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(signatureRepairAttempted) + authRetry.extraAttempts),
      },
      attempt,
    );
    // 工具调用增量在 assembler 内聚合；自然 EOF 后必须 flush，否则最后一个 tool-call 会丢。
    // 每个 attempt 一个新实例：上一次 attempt 的半截参数不能带入重试。
    const toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
    // iterator 在 streamText 返回后才赋值；它的存在与否是判断「请求是否已建立」的关键证据。
    // 不要用 streamResult 是否存在代替它：options 创建成功但 streamText 抛错时两者不等价。
    let streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
    // 自然 EOF 与 consumer 提前关闭必须区分：前者不需要 abort，后者必须收口为 cancelled。
    // 这个标记只在 next.done 分支置位，不能在其他地方「推测」为真。
    let streamReachedNaturalEnd = false;
    // attemptFailed 决定 finally 是「无条件 abort + 有界清理」还是「保留既有生命周期」。
    // catch 与 SSE retry 两条路径都要置位，否则旧 provider 请求会与新 attempt 并发。
    let attemptFailed = false;
    // 失败且需要重试时必须等清理完成再进入下一次物理请求；只有 consumer 主动结束时才允许 void 异步清理。
    // 把它设反会让重试与旧连接竞争 provider 并发槽，表现为随机 429。
    let awaitIteratorClose = false;
    // 终态状态只发布一次：catch 发布后 finally 不得重复发，避免 UI 双报错。
    // 成功路径同样要置位，否则 finally 会把正常结束误当成 consumer 提前关闭。
    let terminalStatusPublished = false;
    // 提升到 try 外,使 catch 分支也能拿到 options/result 记录失败 model-io。
    // options/result 提升到 try 外，是为了 catch 里还能写失败 model-io。
    // options 是否存在同时被鉴权刷新用作「请求已提交」的判据，不能当成纯记录变量。
    let options: ReturnType<typeof createStreamTextOptions> | undefined;
    let result: AiSdkStreamTextResult | undefined;
    // 对外上报的 request headers 必须先脱敏；业务判断不能依赖这里的内容。
    // 它们在 options 创建后才可读，因此默认空对象，不能假设每个失败路径都有值。
    let requestHeaders: Record<string, string> = {};
    let requestHeaderCount = 0;
    // resolved 每次 attempt 可能被 resolveModelForAttempt 刷新（鉴权/运行时 header）。
    // 失败分类、off-peak 判定与 model-io 都必须用最新值，不能用 input.resolved 兜底。
    let resolved = input.resolved;
    let timeToFirstProviderEventMs: number | undefined;
    let timeToFirstContentMs: number | undefined;
    let timeToFirstTextMs: number | undefined;
    let streamMaxIdleMs = 0;
    let streamStallCount = 0;
    // streamOutputCommitted 与 emittedRetryBoundaryEvent 互补：前者面向遥测/鉴权判定，后者面向重试闸门。
    // 不要在重试判定里用 streamOutputCommitted 代替 emittedRetryBoundaryEvent，两者口径不同。
    let streamOutputCommitted = false;
    /**
     * 仅在“流尚未提交可见输出 + anthropic + 未修复过”时尝试签名修复。
     * 修复只改本次请求副本，并额外占用一次不消耗普通预算的物理请求。
     */
    const repairThinkingSignatureRejection = (error: unknown): boolean => {
      if (signatureRepairAttempted || resolved.providerKind !== "anthropic") {
        return false;
      }
      const repairedMessages = repairReasoningHistoryAfterSignatureRejection(
        requestMessages,
        error,
      );
      if (!repairedMessages) return false;

      // 签名只对生成它的 thinking block 有效。流尚未提交输出时，只替换
      // 本次请求副本，并给一次不占普通 retry 预算且拥有新 requestId 的物理请求机会；
      // 不能把清理结果写回 canonical history。
      signatureRepairAttempted = true;
      requestMessages = repairedMessages;
      input.logger?.warn("Retrying model stream after thinking signature rejection", {
        attempt,
        event: "model.reasoning_signature_repair.retry",
        maxAttempts: input.retry.maxAttempts + 1 + authRetry.extraAttempts,
        nextAttempt: attempt + 1,
        requestId: statusContext.requestId,
        status: "waiting",
      });
      return true;
    };
    /** 首次看到内容/文本时各发布一次遥测里程碑；已发布过的类型不会重复发布。 */
    const publishVisibleMilestones = async (observation: {
      contentMs?: number;
      textMs?: number;
    }): Promise<void> => {
      if (timeToFirstContentMs === undefined && observation.contentMs !== undefined) {
        timeToFirstContentMs = observation.contentMs;
        await publishModelTelemetryMilestone(
          {
            ...statusContext,
            attempt,
            elapsedMs: observation.contentMs,
            timestamp: new Date(startedAt + observation.contentMs).toISOString(),
            type: "model_first_content",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
      if (timeToFirstTextMs === undefined && observation.textMs !== undefined) {
        timeToFirstTextMs = observation.textMs;
        await publishModelTelemetryMilestone(
          {
            ...statusContext,
            attempt,
            elapsedMs: observation.textMs,
            timestamp: new Date(startedAt + observation.textMs).toISOString(),
            type: "model_first_text",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
    };

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出 / 消费者放弃流都经 finally；退避 sleep 之前先归还）。
    // 等待中被取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        model: { providerId: String(resolved.providerId), modelId: String(resolved.modelId) },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(statusContext, attempt, statusPublishOptions(input)),
      });
    } catch (admitError) {
      attemptAbortController.cleanup();
      const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: Date.now() - startedAt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount,
          requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          streamOutputCommitted,
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
      // 每次 attempt 重新解析模型：鉴权刷新需要新的 API key/header，off-peak 也需要按 attempt 取号。
      // 该调用失败会进入下面的 catch，按普通模型失败分类；它不是「请求已建立」。
      // request 用 authRetry.prepareRequest(attemptRequest)，保证刷新后的凭据进入本次物理请求。
      resolved = await resolveModelForAttempt({
        attempt,
        reason: authRetry.takeReason(),
        request: authRetry.prepareRequest(attemptRequest),
        resolveModel: input.resolveModel,
      });
      // Anthropic 的 metadata.user_id 由环境与会话推导；失败不阻断请求（返回 undefined 即可）。
      // 不要在失败时伪造一个 ID：错误的 user_id 会影响 provider 侧的风控与计费归因。
      const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
        env: input.env,
        providerKind: resolved.providerKind,
        sessionId: statusContext.sessionId,
      });
      // options 是 AI SDK 的最终入参；model-io 记录的就是它，因此不要塞不可序列化的对象。
      // includeModelIO 控制是否在请求体里保留完整消息，和 recordModelIO 是同一开关的两端。
      options = createStreamTextOptions({
        anthropicMetadataUserId,
        env: input.env,
        includeModelIO: recordModelIO,
        request: attemptRequest,
        resolved,
        statusContext,
      });
      // 先脱敏再计数/上报：Authorization 等敏感头不能进入状态事件或日志。
      // 计数用脱敏后的对象，保证 UI 展示的 header 数与真实可用 header 一致。
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
      // 从这一行起请求已真实发出；后面任何失败都带着 transport 事实，阶段判定不再默认 request_setup。
      // 注意 streamText 可能同步抛错（参数/鉴权），此时 iterator 仍为 undefined，属于 prepare 阶段。
      const streamResult = input.runtime.streamText(options);
      result = streamResult;
      // fullStream getter 会 tee 出内部消费分支；因此必须同时关 iterator 与 consumeStream，缺一都会留下连接槽。
      // iterator 一旦创建，就必须由 finally 负责关闭，不能只在失败路径处理。
      streamIterator = streamResult.fullStream[Symbol.asyncIterator]();

      // 读流循环本身不吞错误：idle timeout、abort、provider 异常都会向上抛，由外层 catch 统一分类。
      // 循环内只做「读取 → 单 chunk 处理 → 控制信号合并」，不要在这里加入重试逻辑。
      while (true) {
        const next = await readNextWithStreamIdleTimeout(streamIterator, {
          abortController: attemptAbortController.controller,
          // onTimeout 只做诊断上报；真正的 abort 由 readNextWithStreamIdleTimeout 内部完成。
          // 在这里再 abort 会掩盖原始超时原因，让错误分类退化成普通的 AbortError。
          // stallCount 与 maxIdleMs 只用于遥测，不参与任何重试判定。
          onTimeout: async (error) => {
            streamStallCount += 1;
            streamMaxIdleMs = Math.max(streamMaxIdleMs, error.idleMs);
            await publishModelStatus(
              {
                ...statusContext,
                attempt,
                idleMs: error.idleMs,
                message: error.message,
                requestHeaderCount,
                requestHeaders,
                timeoutMs: error.timeoutMs,
                timestamp: new Date().toISOString(),
                type: "model_stream_stalled",
              },
              statusPublishOptions(input, admission),
            );
          },
          timeoutMs: streamIdleTimeoutMs,
        });
        // 自然 EOF 是唯一不需要 abort 的退出路径；标记后 finally 走「保留既有生命周期」的分支。
        // 不要在这里提前 flush 工具调用：flush 统一放在循环之后，保证所有事件按同一顺序处理。
        if (next.done) {
          streamReachedNaturalEnd = true;
          break;
        }
        // 首个 provider 事件只记一次；它用于区分「连不上」与「连上但很慢」两类体验问题。
        // 该值是遥测口径：不能拿它做超时或重试判断。
        if (timeToFirstProviderEventMs === undefined) {
          timeToFirstProviderEventMs = Date.now() - startedAt;
          await publishModelTelemetryMilestone(
            {
              ...statusContext,
              attempt,
              elapsedMs: timeToFirstProviderEventMs,
              timestamp: new Date(startedAt + timeToFirstProviderEventMs).toISOString(),
              type: "model_first_provider_event",
            },
            { logger: input.logger, statusSink: input.statusSink },
          );
        }

        let event: Awaited<ReturnType<typeof handleStreamChunk>>;
        try {
          // 单个 chunk 的处理全部收敛到 handleStreamChunk：诊断、业务错误、工具聚合与边界暂存都在那里。
          // 外层只消费控制信号：visible、retryScheduled 与 terminal 三个布尔。
          // 把重试逻辑写回这里会与 SSE error chunk 的内部退避重复，造成双重重试。
          event = await handleStreamChunk({
            admission,
            attempt,
            chunk: next.value,
            diagnostics,
            emittedRetryBoundaryEvent,
            input,
            pendingRetrySafeEvents,
            requestHeaderCount,
            requestHeaders,
            repairThinkingSignatureRejection,
            canRecoverProjectToken: (error) => authRetry.canRecoverProjectToken(error),
            retryBudgetAttempt,
            startedAt,
            statusContext,
            toolCallAssembler,
          });
        } catch (error) {
          // provider 直接给完整 tool-call 时没有 raw block provenance，校验抛错前必须先合成 inferred block stop。
          // 否则 Core 会把这次失败误判成「首事件前失败」并重放整个请求。
          // 先 flush 暂存前奏再 yield 边界，保证 UI 看到的事件顺序仍是 start → block stop。
          const directToolCommit = compactDirectToolCallCommitEvent(input.request, next.value);
          if (directToolCommit) {
            // 完整 direct tool-call 已是 provider 事件；name/input 校验即使抛错，
            // 也不能让 adapter 当作首事件前失败再次 SSE 重放。
            emittedRetryBoundaryEvent = true;
            for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
              emittedEvent = true;
              yield pendingEvent;
            }
            // 无 raw message-block provenance 的 provider 可能直接给完整 tool-call。
            // 先把 inferred block stop 交给隐藏 collector，再传播校验错误，避免 HTTP 重放。
            emittedEvent = true;
            yield directToolCommit;
          }
          throw error;
        }
        // finish 之前先做一次上下文超限判定：宁可在这里抛，也不要让 UI 先看到 finish 再收到错误。
        // createEmptyContextExceededError 只在「确实有输出但 usage 超限」时返回错误，避免误伤空回复。
        // 抛出的错误会进入下面的 catch，由统一失败路径发布唯一的终态。
        if (event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish")) {
          const contextError = createEmptyContextExceededError({
            finishReason: diagnostics.finishReason,
            rawFinishReason: diagnostics.rawFinishReason,
            hasAssistantContent: diagnostics.textDeltaChars > 0 || diagnostics.hasReasoningContent,
            toolCallCount: toolCallAssembler.snapshotNormalizedToolCalls().length,
            usage: diagnostics.usage,
          });
          // 先于 yield finish 进入既有 catch，每个请求只发布一个失败终态。
          if (contextError) throw contextError;
        }
        // 空完成重试的三个前提：非 compact、零输出、预算内；缺一不可，否则会误伤合法的空回复。
        // compact 请求不能在这里重试：它的重放必须交给 Core 的 commit boundary。
        // 判断依据来自 diagnostics，而不是可见事件本身——finish 已经被组装进来了。
        const shouldHoldEmptyCompletionEvents =
          !event.emittedError &&
          event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
          input.request.preserveProviderStreamBoundaries !== true &&
          isZeroOutputModelCompletion({
            finishReason: diagnostics.finishReason,
            rawFinishReason: diagnostics.rawFinishReason,
            reasoningLength: diagnostics.reasoningDeltaChars,
            textLength: diagnostics.textDeltaChars,
            toolCallCount: diagnostics.toolCallCount,
            usage: diagnostics.usage,
          }) &&
          canRetryEmptyCompletion({
            abortSignal: input.request.abortSignal,
            attempt,
            maxAttempts: input.retry.maxAttempts,
            retryCount: emptyCompletionRetryCount,
          });
        // 清空而不是丢弃：事件已经由 helper 组装好，这里只阻止它泄漏到 UI。
        // 决定权交给自然 EOF 后的统一判定，避免在循环中途就下「这是空完成」的结论。
        if (shouldHoldEmptyCompletionEvents) {
          // finish 会把已缓存的 start 一并刷给 core；先暂存到自然 EOF，确认这是
          // generic empty 后再重试，避免第一次 attempt 的 finish/start 泄漏到 UI。
          event.visibleEvents.length = 0;
        }
        // 三个标记只做「或」合并，一旦为 true 就不能被后续 chunk 重置。
        // 重放判定依赖这种单调性；改成赋值会让后面的正常 chunk 抹掉已发生的错误事实。
        emittedError = emittedError || event.emittedError;
        emittedEvent = emittedEvent || event.emittedEvent;
        emittedRetryBoundaryEvent = emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

        // SSE error chunk 的重试是正常控制流：必须显式标记失败并等待有界清理。
        // 下一次物理请求不能与旧 attempt 并发；因此这里 break 而不是 continue 内层循环。
        // offPeakQueueHold 要透传，外层据此回退 attempt 计数。
        if (event.retryScheduled) {
          // SSE error chunk 的 retry 是正常控制流，不会进入 catch；
          // 若不显式标记失败，finally 会跳过旧 attempt 的 iterator/tee 清理。
          // 下一次物理请求必须等待本轮 abort 与有界清理后才能启动。
          attemptFailed = true;
          awaitIteratorClose = true;
          retryScheduledFromStreamChunk = true;
          offPeakQueueHoldFromStreamChunk = event.offPeakQueueHold;
          break;
        }
        // 终端错误立即上抛，不再读取后续 chunk；catch 会识别 TerminalStreamChunkError 并原样透传。
        // 不要在这里再包一层 toAdapterError：helper 已经带上了正确的阶段上下文。
        if (event.terminalError) {
          throw event.terminalError;
        }
        // yield 之前先记账：first-content/first-text 与 outputCommitted 必须在事件离开本函数前更新。
        // 否则消费者提前 return 时这些事实会丢，鉴权刷新与遥测都会判错。
        // 记账是 await 的，但 yield 顺序不能因此改变。
        if (event.visibleEvents.length > 0) {
          for (const visibleEvent of event.visibleEvents) {
            const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
            await publishVisibleMilestones(observation);
            streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
            yield visibleEvent;
          }
        }
      }

      if (retryScheduledFromStreamChunk) {
        if (offPeakQueueHoldFromStreamChunk) {
          // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试。
          attempt -= 1;
        }
        continue;
      }

      // 自然 EOF 后 flush assembler：尚未输出的 tool-call 与暂存前奏在这里统一过一遍边界规则。
      // flush 可能把 emittedRetryBoundaryEvent 从 false 翻成 true，后续 finally 的清理强度依赖它。
      // 不要跳过这一步直接 return：最后一个工具调用会永久丢失。
      const flushedEvents = applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent,
        events: toolCallAssembler.flush(),
        pendingRetrySafeEvents,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
      });
      emittedEvent = emittedEvent || flushedEvents.emittedEvent;
      emittedRetryBoundaryEvent =
        emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
      // flush 产生的事件同样要走可见性记账；不要假设它们一定不带内容。
      // tool_call 会被判定为 outputCommitted，这正是空完成重试需要看到的信号。
      if (flushedEvents.visibleEvents.length > 0) {
        for (const visibleEvent of flushedEvents.visibleEvents) {
          const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
          await publishVisibleMilestones(observation);
          streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
          yield visibleEvent;
        }
      }

      // 边界未到达也要兜底 flush 暂存事件：否则自然结束时 start 元数据会永久留在队列里。
      // splice(0) 同时清空队列，避免这些事件被下一次 attempt 重复处理。
      for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
        emittedEvent = true;
        const observation = observeVisibleStreamEvent(pendingEvent, Date.now() - startedAt);
        await publishVisibleMilestones(observation);
        streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
        yield pendingEvent;
      }

      if (!emittedError) {
        // 自然 EOF 后合成的业务错误会通过 TerminalStreamChunkError 直接离开外层 catch；
        // compact 上下文在普通主链路为空，因此必须在合成现场显式保留 stream 阶段。
        // 先识别 provider business error，再考虑 generic empty；否则额度等
        // HTTP 200 空流会被误判成可重试的暂时性空响应。
        // HTTP 200 + 业务错误体是常见形态（额度、风控、内容策略）：它们不会走 error chunk，只能在这里识别。
        // source 优先用 lastFinishChunk，其次用 diagnostics 合成的 finish，保证判定与真实结束帧一致。
        // 识别结果决定是抛终端错误还是继续走空完成重试，顺序不能反。
        const hiddenProviderBusinessError = detectProviderBusinessFinishError({
          providerId: String(statusContext.providerId),
          providerKind: statusContext.providerKind,
          source:
            diagnostics.lastFinishChunk ??
            ({
              type: "finish",
              finishReason: diagnostics.finishReason,
              rawFinishReason: diagnostics.rawFinishReason,
            } satisfies Record<string, unknown>),
        });
        // 业务错误优先级高于 generic empty：先判业务，再判空完成，避免额度耗尽被当成暂时性空响应重试。
        // 安全校验拒绝要原样上抛，交给上层做专门恢复。
        // 其余业务错误统一转 TerminalStreamChunkError，阶段固定为 response_body。
        if (hiddenProviderBusinessError) {
          if (isRequestVerificationRejection(hiddenProviderBusinessError))
            throw hiddenProviderBusinessError;
          const failure = classifyModelFailure(
            hiddenProviderBusinessError,
            input.request.abortSignal,
          );
          throw new TerminalStreamChunkError(
            toAdapterError(hiddenProviderBusinessError, failure, statusContext, attempt, {
              ...compactStreamFailureContext(
                input.request.preserveProviderStreamBoundaries,
                "response_body",
              ),
              errorPhase: "stream",
            }),
          );
        }

        // 可疑诊断（有 finish 但无内容、或只有错误体）才进入第二段兜底；正常短回复不应该被误伤。
        // 第二段兜底先再查一次 lastErrorChunk，再退回「安全校验空流」错误。
        // 只有仍判定为零输出时才进入空完成重试，并且 compact 请求被排除在外。
        if (isSuspiciousStreamDiagnostics(diagnostics)) {
          // 403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束；
          // 若不在 adapter 层终止，core 会误报 “Model returned no text...”。
          const streamEndedWithoutOutputError =
            detectProviderBusinessFinishError({
              providerId: String(statusContext.providerId),
              providerKind: statusContext.providerKind,
              source: diagnostics.lastErrorChunk ?? diagnostics.lastFinishChunk,
            }) ??
            createRequestVerificationEmptyStreamError({
              accountMode: resolved.accountAccess?.mode,
              headers: resolved.headers,
              providerId: String(statusContext.providerId),
              providerKind: resolved.providerKind,
            });
          if (streamEndedWithoutOutputError) {
            if (isRequestVerificationRejection(streamEndedWithoutOutputError))
              throw streamEndedWithoutOutputError;
            const failure = classifyModelFailure(
              streamEndedWithoutOutputError,
              input.request.abortSignal,
            );
            throw new TerminalStreamChunkError(
              toAdapterError(streamEndedWithoutOutputError, failure, statusContext, attempt, {
                ...compactStreamFailureContext(
                  input.request.preserveProviderStreamBoundaries,
                  "response_body",
                ),
                errorPhase: "stream",
              }),
            );
          }

          if (
            input.request.preserveProviderStreamBoundaries !== true &&
            isZeroOutputModelCompletion({
              finishReason: diagnostics.finishReason,
              rawFinishReason: diagnostics.rawFinishReason,
              reasoningLength: diagnostics.reasoningDeltaChars,
              textLength: diagnostics.textDeltaChars,
              toolCallCount: diagnostics.toolCallCount,
              usage: diagnostics.usage,
            }) &&
            canRetryEmptyCompletion({
              abortSignal: input.request.abortSignal,
              attempt,
              maxAttempts: input.retry.maxAttempts,
              retryCount: emptyCompletionRetryCount,
            })
          ) {
            // 响应头读取本身可能 reject（流已销毁）：失败时返回空对象，不影响重试决策。
            // 空完成重试需要它来上报 providerRequestId，缺失也不能阻断重试。
            const responseHeaders = await resolveStreamResponseHeaders(streamResult);
            const completedAt = Date.now();
            // finish 会把 retry-safe 前奏刷成可见事件；空 completion 需在
            // flush 前进入一次 adapter retry，避免 core 把第一次 attempt 当成已完成。
            logStreamDiagnostics({
              attempt,
              diagnostics,
              durationMs: completedAt - startedAt,
              emittedError,
              emittedEvent,
              logger: input.logger,
              outboundHeaders: resolved.headers,
              statusContext,
            });
            // 计数在真正安排重试前自增，保证 canRetryEmptyCompletion 下次看到的是已用次数。
            // 不要在重试失败后再补加：中途取消会让计数永久偏小。
            emptyCompletionRetryCount += 1;
            // 安排重试后直接 continue：不经过 catch 的失败分类，也不发布 model_request_failed。
            // 空完成不是错误终态；发布失败状态会让 UI 闪一次红色错误。
            // streamOutputCommitted 固定为 false，因为这个分支的前提就是零输出。
            await scheduleEmptyCompletionRetry({
              abortSignal: input.request.abortSignal,
              attempt,
              completedAt,
              errorPhase: "stream",
              logger: input.logger,
              requestHeaders,
              requestStatusSink: input.request.statusSink,
              responseHeaders,
              retry: input.retry,
              retryBudgetAttempt,
              startedAt,
              statusContext,
              statusSink: input.statusSink,
              streamOutputCommitted: false,
            });
            continue;
          }
        }
      }

      // 成功路径的诊断日志放在终态发布之前，确保即使发布失败也留下了本次流的证据。
      // 日志内容包含 retry 相关计数，便于回放一次失败为何被判定为不可重试。
      logStreamDiagnostics({
        attempt,
        diagnostics,
        durationMs: Date.now() - startedAt,
        emittedError,
        emittedEvent,
        logger: input.logger,
        outboundHeaders: resolved.headers,
        statusContext,
      });
      // 只有完全无错误才发布 model_request_completed；有 emittedError 说明错误路径已经发过终态。
      // 完成状态携带首事件/首内容/首文本与 idle 统计，是排查「慢但成功」的主要入口。
      // publishModelStatus 可能抛错：此时不会执行到 terminalStatusPublished，finally 会补发 cancelled——
      if (!emittedError) {
        const completedAt = Date.now();
        const responseHeaders = await resolveStreamResponseHeaders(streamResult);
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            durationMs: completedAt - startedAt,
            requestHeaderCount,
            requestHeaders,
            responseHeaderCount: Object.keys(responseHeaders).length,
            responseHeaders,
            providerRequestId: providerRequestIdFromHeaders(responseHeaders),
            finishReason: diagnostics.finishReason,
            usage: diagnostics.usage,
            timeToFirstProviderEventMs,
            timeToFirstContentMs,
            timeToFirstTextMs,
            streamMaxIdleMs: streamMaxIdleMs || undefined,
            streamStallCount,
            streamOutputCommitted,
            timestamp: new Date(completedAt).toISOString(),
            type: "model_request_completed",
          },
          statusPublishOptions(input, admission),
        );
        // 成功终态也要占位：finally 据此跳过 cancelled 收口。
        // 它与失败路径的置位语义相同，都是「本 attempt 的终态已经说过一次」。
        terminalStatusPublished = true;
      }
      // 成功路径的 model-io 记录在 return 之前；失败路径在 catch 里记录，两处都要求 options 已创建。
      // 记录失败不能影响返回：recordStreamTextDebug 内部自行吞掉写盘错误。
      if (recordModelIO && options) {
        await recordStreamTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          isDev,
          normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
          options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusContext.requestId,
          resolved,
          result: streamResult,
          startedAt,
        });
      }
      return;
    } catch (error) {
      // 进入 catch 即视为失败：finally 会无条件 abort，并等待 iterator 清理后再允许重试。
      // 这一行必须在 try 内第一时间执行，不能延后到分类完成之后。
      // 若错误来自消费者取消，attemptFailed 仍为 true，但 awaitIteratorClose 会被单独置为 false。
      attemptFailed = true;
      if (recordModelIO && options) {
        await recordStreamTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          error,
          isDev,
          normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
          options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusContext.requestId,
          resolved,
          result,
          startedAt,
        });
      }
      // 已经由 chunk helper 包装好的终端错误直接透传，避免二次分类/重试。
      // helper 已经把错误分类并包装过：这里只负责透传 adapterError。
      // 任何二次分类都会丢失阶段上下文，并可能把不可重试错误重新变成可重试。
      // 透传前仍要打开 awaitIteratorClose，保证下一次请求不会与旧连接并发。
      if (error instanceof TerminalStreamChunkError) {
        awaitIteratorClose = true;
        throw error.adapterError;
      }
      if (
        error instanceof ModelProtocolError &&
        error.code === ModelErrorCode.ModelRequestAuthMissing
      ) {
        // stream 在 attempt try 内解析请求鉴权，过去会把网络前的类型化
        // 鉴权缺失错误重新归一化为通用请求失败；generate 则直接保留原始协议错误。
        throw error;
      }

      const completedAt = Date.now();
      // 签名修复必须在 classifyModelFailure 之前决定：它会替换 requestMessages，影响下一次物理请求的内容。
      // 已越过重试边界时不再修复：此时请求已产生可见输出，替换历史也无法撤回。
      // 修复成功的判定依赖 providerKind === anthropic 与「每个流最多一次」两个守卫。
      const retryWithRepairedHistory =
        !emittedRetryBoundaryEvent && repairThinkingSignatureRejection(error);
      // 修复占用额外一次物理请求，statusContext 的分母也要同步 +1。
      // 否则 UI 显示 2/2 后仍会出现第 3 次请求，用户会认为重试失控。
      if (retryWithRepairedHistory) {
        statusContext = {
          ...statusContext,
          maxAttempts: statusMaxAttempts(1 + authRetry.extraAttempts),
        };
      }
      // 分类器只看错误本身；abortSignal 用于把「用户取消」识别为 Cancelled，避免被当成可重试失败。
      // 它返回的是可被就地改写的对象，后续 off-peak/header 刷新会在其上覆盖语义。
      const classified = classifyModelFailure(error, input.request.abortSignal);
      // 运行时 Header 刷新失败是确定性错误：保留原始消息并禁止重试。
      // 运行时 header 刷新失败是确定性错误：重试只会得到同样的结果。
      // 直接改写 classified 而不是新建对象，保留分类器算出的 code/status 等上下文字段。
      // 保留原 message 很重要：它通常包含可操作的刷新失败原因。
      if (error instanceof RuntimeHeadersRefreshError) {
        classified.message = error.message;
        classified.retryable = false;
      }
      // off-peak 特判（仅 idle plan provider）：排队 429 豁免预算无限探测；3102 标记落败触发续跑。
      // off-peak 是特例层：排队 429 与票据过期在这里被改写语义，不能交给通用分类器决定。
      // 只有 accountAccess.mode === off-peak 才启用；普通账号的 429 仍走常规退避。
      // 错误必须先 unwrapRetryError，才能看到 provider 真正返回的状态码。
      const offPeak = resolveOffPeakFailureDecision({
        offPeak: resolved.accountAccess?.mode === "off-peak",
        failure: classified,
        error: unwrapRetryError(error),
      });
      // ticketExpired 必须不可重试（票已失效，重试无意义）；queued 必须可重试且带 OffpeakQueued 原因。
      // 两种改写都基于同一份 classified，保留 code/status 供 UI 展示。
      // 不要在这里直接 throw：是否重试仍要交给 resolveStreamFailureDecision 统一裁决。
      const failure: ClassifiedModelFailure =
        offPeak?.kind === "ticketExpired"
          ? {
              ...classified,
              retryable: false,
              message: offPeakTicketExpiredMessage(classified.message),
            }
          : offPeak?.kind === "queued"
            ? {
                ...classified,
                retryable: true,
                retryReason: ModelRetryReason.OffpeakQueued,
              }
            : classified;
      // errorPhase 由错误自身的阶段标记优先，缺失时按 iterator 是否存在推断：没有 iterator 就是 prepare。
      // 这个字段会进入对外的 adapter 错误，影响 Core 选择 fallback 还是直接终结。
      // 不要用 streamOutputCommitted 推断阶段：它只代表「可见输出」，不代表请求是否已建立。
      const errorPhase =
        readModelFailureErrorPhase(error) ?? (streamIterator === undefined ? "prepare" : "stream");
      awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
      const responseHeaders = sanitizeModelNetworkHeaders(
        getResponseHeaders(unwrapRetryError(error)),
      );
      // 决策函数统一处理预算、可见输出、compact 阶段三者；catch 与 error chunk 两条路径必须共用它。
      // 此处传入 streamIteratorCreated 与 streamErrorChunkObserved，阶段判定因此比 error chunk 路径更精确。
      // 决策结果里的 context 会原样并入 adapter 错误，供 Core 做 fallback 决策。
      const failureDecision = resolveStreamFailureDecision({
        attempt: retryBudgetAttempt,
        emittedRetryBoundaryEvent,
        error,
        failure,
        maxAttempts: input.retry.maxAttempts,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
        responseHeaders,
        retryBudget,
        streamIteratorCreated: streamIterator !== undefined,
        streamErrorChunkObserved: Boolean(
          diagnostics.lastErrorChunk || diagnostics.lastFinishChunk,
        ),
      });
      // 鉴权刷新仅在请求尚未提交可见输出、且未越过重试边界时允许；
      // claim 内部同时维护额外的 attempt 预算。
      // 鉴权刷新只允许在「请求已创建但尚未提交可见输出」时发生；已越过边界或 body 已开始都视为不可重放。
      // claim 的第二个参数是「不可刷新」的布尔条件，写反会让刷新在已提交输出后仍然触发。
      // 它内部维护额外 attempt 预算，因此成功后不能忘记重建 statusContext 的分母。
      const retryWithAuth = authRetry.claim(
        error,
        options === undefined ||
          emittedRetryBoundaryEvent ||
          streamOutputCommitted ||
          (input.request.preserveProviderStreamBoundaries === true &&
            failureDecision.context?.streamFailurePhase === "response_body"),
      );
      // 鉴权刷新成功后 continue，不进入退避：它是一次独立的物理请求，不消耗普通预算。
      // 刷新不会关闭当前 iterator 的清理责任——finally 仍会执行。
      // 继续前必须确保旧 attempt 的 abort 已发生，否则两次物理请求会并存。
      if (retryWithAuth) {
        failureDecision.canRetry = true;
        statusContext = {
          ...statusContext,
          maxAttempts: statusMaxAttempts(
            Number(signatureRepairAttempted) + authRetry.extraAttempts,
          ),
        };
      }
      // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
      if (offPeak?.kind === "queued" && !emittedRetryBoundaryEvent) {
        failureDecision.canRetry = true;
      }
      if (retryWithRepairedHistory) {
        failureDecision.canRetry = true;
      }

      // 失败诊断要在发布状态之前写：状态发布本身可能因 sink 异常而中断。
      // 它记录 canRetry 与 emitted* 事实，是复盘「为什么这次没有重试」的第一手材料。
      logStreamFailureDiagnostics({
        attempt,
        canRetry: failureDecision.canRetry,
        diagnostics,
        durationMs: completedAt - startedAt,
        emittedError,
        emittedEvent,
        emittedRetryBoundaryEvent,
        error,
        failure,
        logger: input.logger,
        statusContext,
      });
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
          retryable: failureDecision.canRetry,
          statusCode: failure.statusCode,
          streamOutputCommitted,
          ...modelFailureStatusFields(error, failure, errorPhase),
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_failed",
          ...(error instanceof AiSdkModelAdapterError && error.usage ? { usage: error.usage } : {}),
        },
        {
          ...statusPublishOptions(input, admission),
          failureError: unwrapRetryError(error),
        },
      );
      terminalStatusPublished = true;

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
      // 签名修复在这里同样占额外 attempt：状态里的 maxAttempts 已在上面 +1。
      // 返回 retryScheduled 而不是抛错，让外层循环继续下一次物理请求。
      // 修复分支优先于通用 canRetry 判定，否则修复请求会被预算门挡掉。
      if (retryWithRepairedHistory) {
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

      // 不可重试：记录决策后转换为 adapter 错误上抛，交给 Core 终结本次 turn。
      // 不可重试是终态：toAdapterError 会把内部错误归一化成对外协议错误。
      // 归一化时携带 failureDecision.context（compact 阶段/HTTP status），Core 依赖它决定 fallback。
      // 这里直接 throw，不再发布额外状态：model_request_failed 已在上面发过。
      if (!failureDecision.canRetry) {
        logRetryDelayDecision({
          attempt,
          canRetry: failureDecision.canRetry,
          failure,
          logger: input.logger,
          responseHeaders,
          statusContext,
        });
        throw toAdapterError(error, failure, statusContext, attempt, {
          ...failureDecision.context,
          errorPhase,
        });
      }

      // off-peak 排队用 provider 给的 delayMs；其余走带抖动的指数退避，避免重试风暴同步打点。
      // 重试序号用 retryBudgetAttempt 而不是 attempt，额外请求不会让退避提前升级。
      const delayMs =
        offPeak?.kind === "queued"
          ? offPeak.delayMs
          : calculateRetryDelay(input.retry, retryBudgetAttempt, failure.retryAfterMs);
      logRetryDelayDecision({
        attempt,
        canRetry: failureDecision.canRetry,
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
      // release 必须在 sleep 之前：否则退避的整个窗口都占着并发槽，慢 provider 会把全局并发拖死。
      // finally 里的 release 是幂等兜底，正常路径到这里即可；重复调用不会二次归还。
      // 退避期间不持票：槽位让给别人，重试再准入。
      admission.release();
      try {
        await sleep(delayMs, input.request.abortSignal);
      } catch (sleepError) {
        const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            durationMs: Date.now() - startedAt,
            message: sleepFailure.message,
            reason: sleepFailure.reason,
            requestHeaderCount,
            requestHeaders,
            retryable: false,
            statusCode: sleepFailure.statusCode,
            streamOutputCommitted,
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
        terminalStatusPublished = true;
        throw toAdapterError(sleepError, sleepFailure, statusContext, attempt, {
          errorPhase: "connect",
        });
      }
      // 回退 attempt 抵消 for 的自增：排队等待不属于一次真实尝试，因此不消耗预算。
      // 这样可以无限探测排队位置，直到 provider 放行或票据过期。
      // 只能在 queued 分支回退；ticketExpired 必须走终态。
      if (offPeak?.kind === "queued") {
        // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试，无限探测。
        attempt -= 1;
      }
    // finally 是本文件最重要的清理契约：abort、有界关闭 iterator、归还票据，三者缺一都会泄漏连接或槽位。
    // 成功路径也会进入这里，因此每个动作都必须幂等且能识别「已经自然结束」。
    // 不要在 finally 里抛错：它会覆盖真正的 provider/retry 错误。
    } finally {
      if (
        !streamReachedNaturalEnd &&
        (attemptFailed || input.request.preserveProviderStreamBoundaries === true)
      ) {
        // 普通 stream 的 429 retry 失败若不进入本清理分支，
        // AI SDK fullStream tee 会持有旧 provider 请求，连续重试会让后续物理请求卡在发送前。
        // 失败 attempt 必须无条件中止并释放；普通 consumer 主动提前结束仍保持原语义。
        // 失败 attempt 必须主动 abort：AI SDK 的 tee 分支不会因为外层不再读取就释放底层请求。
        // abort reason 用固定文案，便于日志区分「主动收口」与「调用方取消」。
        // 已经 aborted 时不要重复 abort，保留最初的取消原因。
        if (!attemptAbortController.signal.aborted) {
          attemptAbortController.controller.abort(
            new Error("Model stream attempt ended before natural EOF."),
          );
        }
        if (!attemptFailed && !terminalStatusPublished && !emittedError) {
          // consumer 侧的校验异常只会触发 AsyncIteratorClose，不会回到上面的 catch；
          // 将已启动的物理请求收口为 cancelled，避免 fallback 前遗留悬空 started 状态。
          const completedAt = Date.now();
          await publishModelStatus(
            {
              ...statusContext,
              attempt,
              durationMs: completedAt - startedAt,
              message: "Model stream consumer closed before natural EOF.",
              reason: ModelFailureReasonValue.Cancelled,
              requestHeaderCount,
              requestHeaders,
              retryable: false,
              errorCode: "model_request_cancelled",
              errorPhase: "stream",
              exceptionType: "AbortError",
              streamOutputCommitted,
              timestamp: new Date(completedAt).toISOString(),
              type: "model_request_failed",
            },
            statusPublishOptions(input, admission),
          );
        }
        // 需要重试时必须 await 清理完成；consumer 主动结束时才允许 void——两种语义不能混用。
        // await 分支会带上 result，确保 consumeStream 也被关闭，释放 tee 的另一支。
        // void 分支只关 iterator，避免在消费端已结束的情况下继续等待。
        if (attemptFailed && awaitIteratorClose) {
          await closeStreamIteratorBestEffort(streamIterator, {
            attempt,
            logger: input.logger,
            result,
          });
        } else {
          void closeStreamIteratorBestEffort(streamIterator, {
            attempt,
            logger: input.logger,
          });
        }
      } else if (attemptAbortController.signal.aborted) {
        // 普通 main 保留既有生命周期：只有 caller/idle 已经 abort 时才 best-effort 关闭 iterator。
        void closeStreamIteratorBestEffort(streamIterator, {
          attempt,
          logger: input.logger,
        });
      }
      // cleanup 移除对调用方 signal 的监听；放在 iterator 处理之后，保证清理期间 abort 传播仍有效。
      // 它不负责 abort，只负责摘监听；顺序写反会让清理阶段失去取消能力。
      attemptAbortController.cleanup();
      // 兜底归还（成功 / 抛出 / 消费者提前 return 都到这里）；正常失败路径已在 sleep 前归还，幂等。
      admission.release();
    }
  }
}

/**
 * 尽力关闭流 iterator 与 AI SDK 的 consumeStream 分支，最多等待 1s。
 * 清理失败或超时只告警，不能覆盖原始 provider/retry 错误。
 */
// 清理是尽力而为：任何清理异常都只能告警，绝不能覆盖原始 provider/retry 错误。
// 函数本身不抛错，调用方因此可以安全地在 finally 中 await 它。
// 1s 上限来自 STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS，超时后放弃等待并记录操作名。
async function closeStreamIteratorBestEffort(
  streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined,
  options: { attempt: number; logger?: Logger; result?: AiSdkStreamTextResult },
): Promise<void> {
  // 两个清理操作都要做：iterator.return 结束外层迭代，consumeStream 释放 tee 的另一支。
  // 用 Promise.resolve().then 延迟启动，避免同步 throw 逃出 allSettled 的捕获范围。
  // 没有可清理项时立即返回，不创建定时器。
  const cleanupOperations: Array<{ name: string; promise: Promise<unknown> }> = [];
  if (streamIterator?.return) {
    cleanupOperations.push({
      name: "iterator.return",
      promise: Promise.resolve().then(() => streamIterator.return?.()),
    });
  }
  // 只 return 外层 iterator 不够：AI SDK 会把另一支保存在 baseStream，reader 与连接槽仍被保留。
  // 不 cancel baseStream 就是「连续重试后请求卡在发送前」的根因。
  // consumeStream 可能永久 pending，因此必须与超时 race。
  if (options.result?.consumeStream) {
    cleanupOperations.push({
      name: "result.consumeStream",
      // AI SDK fullStream getter 会 tee 并把另一支保存在 baseStream；
      // 只等待外层 iterator.return() 仍可能让底层 reader/连接槽继续被保留。
      promise: Promise.resolve().then(() => options.result?.consumeStream()),
    });
  }
  if (cleanupOperations.length === 0) return;

  // race 必须能取消定时器：否则成功清理后事件循环还会被 1s 定时器拖住。
  // 定时器句柄放在闭包外，Promise.race 结束后统一 clear。
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.allSettled(cleanupOperations.map((operation) => operation.promise)).then((results) => ({
      results,
      type: "settled" as const,
    })),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ type: "timed_out" }), STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  // 超时只告警并返回：继续等待可能永久阻塞，而重试必须尽快开始。
  // 日志记录具体卡住的操作名，便于区分 iterator.return 与 consumeStream。
  // 超时不视为失败终态，不改变上层重试决策。
  if (outcome.type === "timed_out") {
    options.logger?.warn("Model stream attempt cleanup timed out", {
      attempt: options.attempt,
      cleanupOperations: cleanupOperations.map((operation) => operation.name),
      event: "model.stream_attempt_cleanup.timeout",
      status: "waiting",
      timeoutMs: STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS,
    });
    return;
  }

  // 逐个操作记录失败名与消息，便于定位是 return 还是 consumeStream 卡住。
  // allSettled 保证一个操作失败不影响另一个的等待结果。
  // 失败只告警：清理失败不能升级成用户可见错误。
  const failures = outcome.results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            errorMessage:
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            operation: cleanupOperations[index]?.name,
          },
        ]
      : [],
  );
  if (failures.length > 0) {
    // 异步清理失败或超时只能降级告警，不能覆盖原始 provider/retry 错误。
    options.logger?.warn("Model stream attempt cleanup failed", {
      attempt: options.attempt,
      event: "model.stream_attempt_cleanup.failed",
      failures,
      status: "failed",
    });
  }
}

/**
 * 处理单个 fullStream chunk：先记录诊断，再把 provider business error / error chunk 转入错误路径；
 * 其余 chunk 经 toolCallAssembler 投影为 ModelStreamEvent，并按 retry-safe 边界决定暂存还是可见。
 * 返回值同时携带“是否已可见输出/是否已发 retry/是否终止”等控制信号，供外层 attempt 循环决策。
 */
async function handleStreamChunk(input: {
  /** 本次尝试的准入：错误块的退避 sleep 之前先归还。 */
  admission: AttemptAdmission;
  attempt: number;
  chunk: TextStreamPart<ToolSet>;
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  emittedRetryBoundaryEvent: boolean;
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    resolved: ResolvedAiSdkModel;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  };
  pendingRetrySafeEvents: ModelStreamEvent[];
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  canRecoverProjectToken: (error: unknown) => boolean;
  retryBudgetAttempt: number;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  toolCallAssembler: StreamingToolCallAssembler;
}): Promise<{
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  retryScheduled: boolean;
  /** off-peak 排队重试：外层 for 冻结 attempt 预算。 */
  offPeakQueueHold: boolean;
  terminalError?: TerminalStreamChunkError;
  visibleEvents: ModelStreamEvent[];
}> {
  // 先记账再处理：即使后续抛错，诊断里也保留了最后一个 chunk 的形态。
  // 诊断对象是纯统计，不持有 chunk 引用，避免长流内存增长。
  // 它同时更新 finishReason/usage，后面的空完成与业务错误判定都依赖这些值。
  recordStreamChunkDiagnostic(input.diagnostics, input.chunk);
  // 只有 compact 且是真实 provider 事件（非 ping）才算越过边界；AI SDK 本地合成的 start 不算。
  // 退回 false 会让 Core 误以为还能重放，造成重复内容。
  // 这个标记与 providerBoundaryEvent 分开：前者是布尔事实，后者是可选语义投影。
  const providerEventObserved =
    input.input.request.preserveProviderStreamBoundaries === true &&
    isRawProviderRetryBoundaryEvent(input.chunk);
  // 边界事件只投影结构信息（block start/stop、stop_reason），不搬运正文，避免和正文事件重复。
  // 非 compact 请求完全不生成边界事件，保持既有可见事件序列不变。
  const providerBoundaryEvent = input.input.request.preserveProviderStreamBoundaries
    ? toProviderStreamBoundaryEvent(input.chunk)
    : undefined;
  const emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent || providerEventObserved;
  // chunk 级业务错误优先于普通事件投影：它决定这次流是否应以业务失败收口。
  // source 直接用当前 chunk，因为业务错误通常就藏在 finish/raw 帧里。
  // 命中后统一交给 handleStreamErrorEvent，与 error chunk 路径共享重试判定。
  const providerBusinessFinishError = detectProviderBusinessFinishError({
    providerId: String(input.statusContext.providerId),
    providerKind: input.statusContext.providerKind,
    source: input.chunk,
  });
  if (providerBusinessFinishError) {
    return handleStreamErrorEvent(
      { ...input, emittedRetryBoundaryEvent },
      providerBusinessFinishError,
    );
  }
  // 投影失败（返回 undefined）不一定是错误：raw/未知 chunk 属于正常噪声。
  // error 类型的投影要单独识别并转入错误路径，不能当普通事件 yield。
  // toModelStreamEvent 只做形态转换，重试判断留在上层。
  const event = toModelStreamEvent(input.chunk);
  if (event?.type === "error") {
    return handleStreamErrorEvent({ ...input, emittedRetryBoundaryEvent }, event.error);
  }
  // 非可见事件默认只记 ignored 日志；唯一例外是真实 provider 边界。
  // 边界事件需要立即结束 SSE 重试窗口，并 flush 已暂存的 synthetic start。
  // 不要在这里把未知 chunk 当成错误：很多 provider 会发送心跳/注释帧。
  if (!event) {
    // 非可见事件（raw/未知 chunk）默认忽略；只有真实 provider 边界事件例外。
    if (providerEventObserved) {
      // raw provider event 只用于结束 compact SSE retry；它本身不属于
      // 可见正文；只投影 response/block/stop 的语义边界，并立即刷出已暂存的 synthetic start。
      return applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        events: providerBoundaryEvent ? [providerBoundaryEvent] : [],
        pendingRetrySafeEvents: input.pendingRetrySafeEvents,
        providerEventObserved: true,
        preserveProviderStreamBoundaries: true,
      });
    }
    logIgnoredStreamChunk({
      attempt: input.attempt,
      chunk: input.chunk,
      logger: input.input.logger,
      statusContext: input.statusContext,
    });
    return streamChunkResult();
  }

  return applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    events: input.toolCallAssembler.handle(event),
    pendingRetrySafeEvents: input.pendingRetrySafeEvents,
    providerEventObserved,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
  });
}

/**
 * 把一组事件按 SSE retry 边界过滤：未越过首个真实 provider 事件前的 start 等前奏先暂存；
 * 一旦越过边界，先刷出暂存事件，再输出当前事件。返回可见事件与 emitted 标记。
 */
function applyStreamEventsToRetryBoundary(input: {
  emittedRetryBoundaryEvent: boolean;
  events: ModelStreamEvent[];
  pendingRetrySafeEvents: ModelStreamEvent[];
  providerEventObserved?: boolean;
  preserveProviderStreamBoundaries?: boolean;
}): ReturnType<typeof streamChunkResult> {
  let emittedEvent = false;
  let emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent;
  const visibleEvents: ModelStreamEvent[] = [];

  if (input.providerEventObserved && !emittedRetryBoundaryEvent) {
    visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    emittedRetryBoundaryEvent = true;
  }

  for (const event of input.events) {
    emittedEvent = true;
    // AI SDK 的 start 在读取 provider stream 前本地合成，不能冒充首个 provider event；
    // compact 一旦收到其余真实事件就停止 SSE retry，再由 Core 的 block commit 决定能否 HTTP fallback。
    const retrySafePrelude =
      isRetrySafePreludeStreamEvent(event) &&
      (!input.preserveProviderStreamBoundaries || event.type === "start");
    if (retrySafePrelude && !emittedRetryBoundaryEvent) {
      input.pendingRetrySafeEvents.push(event);
      continue;
    }

    if (!emittedRetryBoundaryEvent) {
      visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    }
    visibleEvents.push(event);
    emittedRetryBoundaryEvent = true;
  }

  return streamChunkResult({
    emittedEvent,
    emittedRetryBoundaryEvent,
    visibleEvents,
  });
}

/** raw chunk 是否代表真实 provider 事件；ping 不算（避免把心跳当成首个事件而放弃重试）。 */
// ping 是心跳不是内容：把它当首个 provider 事件会让本该重试的连接静默失败。
// 只认 raw 类型；其他类型的边界由 AI SDK 的语义事件负责。
function isRawProviderRetryBoundaryEvent(chunk: TextStreamPart<ToolSet>): boolean {
  if (chunk.type !== "raw") {
    return false;
  }
  const rawValue = chunk.rawValue;
  return !(
    rawValue !== null &&
    typeof rawValue === "object" &&
    (rawValue as { type?: unknown }).type === "ping"
  );
}

/**
 * 把 Anthropic 原始 SSE 事件投影为 compact_stream_boundary 语义边界。
 * 只有 message/content block/stop 等结构事件会被投影；无法识别的 raw 事件返回 undefined。
 */
// 只识别 Anthropic SSE 的结构事件；未知 raw 返回 undefined，绝不猜测语义。
// 投影字段全部做类型收窄，缺失时用 null，保证对外事件结构稳定。
// 不要在这里附带正文：边界事件只用于 commit/fallback 判定。
function toProviderStreamBoundaryEvent(
  chunk: TextStreamPart<ToolSet>,
): ModelStreamEvent | undefined {
  if (chunk.type !== "raw" || chunk.rawValue === null || typeof chunk.rawValue !== "object") {
    return undefined;
  }
  const rawEvent = chunk.rawValue as {
    content_block?: { type?: unknown };
    delta?: { stop_reason?: unknown; type?: unknown };
    index?: unknown;
    type?: unknown;
  };
  if (rawEvent.type === "message_start") {
    return {
      boundary: "provider_response_start",
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_start") {
    return {
      blockType:
        typeof rawEvent.content_block?.type === "string" ? rawEvent.content_block.type : null,
      boundary: "provider_content_block_start",
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_delta") {
    return {
      boundary: "provider_content_block_delta",
      deltaType: typeof rawEvent.delta?.type === "string" ? rawEvent.delta.type : null,
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_stop") {
    return {
      boundary: "provider_content_block_stop",
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "message_delta") {
    const stopReason = rawEvent.delta?.stop_reason;
    return {
      boundary: "provider_stop_reason",
      present: Boolean(stopReason),
      type: "compact_stream_boundary",
    };
  }
  return undefined;
}

/**
 * 无 raw block provenance 的 provider 直接给出完整 tool-call 时，合成 inferred block stop 边界，
 * 让 compact 侧明确“已有完整工具输入”，从而不再把该错误当成首事件前失败重放。
 */
function compactDirectToolCallCommitEvent(
  request: AiSdkModelTextRequest,
  chunk: TextStreamPart<ToolSet>,
): ModelStreamEvent | undefined {
  if (!request.preserveProviderStreamBoundaries || chunk.type !== "tool-call") {
    return undefined;
  }
  return {
    boundary: "inferred_content_block_stop",
    type: "compact_stream_boundary",
  };
}

/**
 * SSE error chunk 的生命周期：鉴权拒绝/可恢复 token 直接上抛；签名拒绝尝试修复；
 * 其余分类后决定重试（退避 sleep 前归还准入票据）或返回 TerminalStreamChunkError。
 * 该函数不会 throw 可重试错误，而是通过返回值通知外层 attempt 循环继续。
 */
// 该函数不抛可重试错误，而是用返回值通知外层继续循环。
// 只有不可重试或终端错误才包装成 TerminalStreamChunkError 返回给外层。
// 这样 SSE error chunk 的退避可以复用同一套状态发布与票据归还逻辑。
async function handleStreamErrorEvent(
  input: Parameters<typeof handleStreamChunk>[0],
  error: unknown,
): Promise<Awaited<ReturnType<typeof handleStreamChunk>>> {
  // 安全校验拒绝与可恢复 token 必须立即上抛，不能进入重试/分类流程。
  // 安全校验拒绝与可恢复 token 必须原样上抛：它们要由上层做专门恢复。
  // 进入通用重试/分类会丢失恢复所需的原始错误类型。
  // 这里的 throw 会穿过外层 catch 的 TerminalStreamChunkError 分支之前，属于有意的快速通道。
  if (isRequestVerificationRejection(error) || input.canRecoverProjectToken(error)) throw error;
  const retryWithRepairedHistory =
    !input.emittedRetryBoundaryEvent && input.repairThinkingSignatureRejection(error);
  const statusContext = retryWithRepairedHistory
    ? {
        ...input.statusContext,
        maxAttempts: retryBudgetMaxAttempts(
          input.input.request.modelRetryBudget,
          input.input.retry.maxAttempts + 1,
        ),
      }
    : input.statusContext;
  const classified = classifyModelFailure(error, input.input.request.abortSignal);
  // off-peak 特判：SSE 首块即错（尚无可见输出）时的排队 429 同样豁免预算重试。
  // SSE 首块即错的排队 429 同样豁免预算；此处与 catch 路径保持一致的判定顺序。
  // off-peak 模式从 resolved.accountAccess 读取，必须用本次 attempt 的最新解析结果。
  // 错误先 unwrap，避免包装层掩盖 provider 状态码。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: input.input.resolved.accountAccess?.mode === "off-peak",
    failure: classified,
    error: unwrapRetryError(error),
  });
  // 与 catch 路径同构：ticketExpired 改写成不可重试，queued 改写成可重试。
  // queued 要带 OffpeakQueued 原因，UI 才能显示「排队中」而不是普通失败。
  // 改写基于同一份 classified，保留 code/status。
  const failure: ClassifiedModelFailure =
    offPeak?.kind === "ticketExpired"
      ? {
          ...classified,
          retryable: false,
          message: offPeakTicketExpiredMessage(classified.message),
        }
      : offPeak?.kind === "queued"
        ? {
            ...classified,
            retryable: true,
            retryReason: ModelRetryReason.OffpeakQueued,
          }
        : classified;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  // error chunk 已证明 body 开始，因此传入 streamErrorChunkObserved=true。
  // 阶段判定不会再退回 request_setup，compact 请求因此不会重复重放。
  // 决策与 catch 路径共用，保证两条错误入口的行为一致。
  const failureDecision = resolveStreamFailureDecision({
    attempt: input.retryBudgetAttempt,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget: input.input.request.modelRetryBudget,
    streamErrorChunkObserved: true,
  });
  // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
  if (offPeak?.kind === "queued" && !input.emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }
  await publishModelStatus(
    {
      ...statusContext,
      attempt: input.attempt,
      durationMs: Date.now() - input.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: input.emittedRetryBoundaryEvent,
      ...modelFailureStatusFields(error, failure, "stream"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input.input, input.admission),
      failureError: unwrapRetryError(error),
    },
  );

  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input.input,
      statusContext,
      input.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      input.requestHeaders,
      responseHeaders,
      input.admission,
    );
    return streamChunkResult({
      emittedError: true,
      retryScheduled: true,
    });
  }

  // 不可重试时记录决策并返回 TerminalStreamChunkError；外层 catch 会原样透传 adapterError。
  // 这里不 release 票据：finally 会统一归还，提前归还会让状态事件汇错位。
  // context 中携带 errorPhase=stream，供 Core 区分 body 阶段失败。
  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt: input.attempt,
      canRetry: failureDecision.canRetry,
      failure,
      logger: input.input.logger,
      responseHeaders,
      statusContext,
    });
    return streamChunkResult({
      emittedError: true,
      terminalError: new TerminalStreamChunkError(
        toAdapterError(error, failure, statusContext, input.attempt, {
          ...failureDecision.context,
          errorPhase: "stream",
        }),
      ),
    });
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.input.retry, input.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.input.logger,
    responseHeaders,
    statusContext,
  });

  await publishRetryScheduledStatus(
    input.input,
    statusContext,
    input.attempt,
    delayMs,
    failure,
    input.requestHeaders,
    responseHeaders,
    input.admission,
  );
  // 退避期间不持票：这次尝试到此结束，槽位让给别人。
  input.admission.release();
  // Note: AI SDK can surface pre-output APICallError as an error chunk;
  // retry it here so protocol clients still receive the normal apiRetry status updates.
  try {
    await sleep(delayMs, input.input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.input.request.abortSignal);
    // SSE error chunk 在 helper 内等待 retry；取消发生时 iterator 仍存在，
    // 外层仅按 iterator 判断会误记为 stream。先在真实等待边界写入 connect 事实。
    throw toAdapterError(sleepError, sleepFailure, statusContext, input.attempt, {
      errorPhase: "connect",
    });
  }
  return streamChunkResult({
    emittedError: true,
    retryScheduled: true,
    offPeakQueueHold: offPeak?.kind === "queued",
  });
}

/**
 * 判定 compact 流失败发生在 request_setup 还是 response_body。
 * 优先级：未创建 iterator → setup；已越过重试边界 → body；HTTP 2xx → body；error chunk → body。
 */
// 阶段判定有严格优先级：iterator 未创建 > 已越过边界 > HTTP status > error chunk > content-type。
// 顺序写反会把「body 已开始」误判成 setup，导致重放重复内容。
// 没有硬证据时返回 undefined，让 Core 保持既有 fallback 语义。
function classifyStreamFailurePhase(input: {
  emittedRetryBoundaryEvent: boolean;
  httpResponseStatus?: number;
  responseHeaders: Record<string, string>;
  streamErrorChunkObserved?: boolean;
  streamIteratorCreated?: boolean;
}): StreamFailurePhase | undefined {
  if (input.streamIteratorCreated === false) {
    return "request_setup";
  }
  if (input.emittedRetryBoundaryEvent) {
    return "response_body";
  }

  const responseStatus = input.httpResponseStatus;
  if (responseStatus !== undefined) {
    if (responseStatus >= 200 && responseStatus < 300) {
      return "response_body";
    }
    if (responseStatus >= 300 && responseStatus < 600) {
      return "request_setup";
    }
  }

  if (input.streamErrorChunkObserved) {
    // error chunk 本身证明 stream body 已开始；其中的 ProviderBusinessError.statusCode
    // 可能只是业务分类，不能反推成 HTTP request setup。明确 transport status 仍由上面的分支优先。
    return "response_body";
  }

  const contentType = readHeader(input.responseHeaders, "content-type")?.toLowerCase();
  if (contentType?.includes("text/event-stream")) {
    return "response_body";
  }
  return undefined;
}

/** 仅在 compact 且已判定失败阶段时补充 streamFailurePhase/httpResponseStatus 上下文。 */
function compactStreamFailureContext(
  preserveProviderStreamBoundaries: boolean | undefined,
  streamFailurePhase: StreamFailurePhase | undefined,
  httpResponseStatus?: number,
): Record<string, unknown> | undefined {
  if (preserveProviderStreamBoundaries !== true || !streamFailurePhase) {
    return undefined;
  }
  return {
    ...(httpResponseStatus !== undefined ? { httpResponseStatus } : {}),
    streamFailurePhase,
  };
}

/**
 * 统一计算“本次失败是否可重试”以及 compact 所需的阶段上下文。
 * 非 compact 请求不计算阶段（保持既有重试语义）；compact 请求额外判定 request_setup/response_body。
 */
// 非 compact 请求不计算阶段，保持既有重试语义。
// 只有 compact 才需要 request_setup/response_body 的区分，避免影响普通对话。
// 返回的 context 会并入 adapter 错误，字段名必须与 Core 侧读取的一致。
function resolveStreamFailureDecision(input: {
  attempt: number;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  maxAttempts: number;
  preserveProviderStreamBoundaries?: boolean;
  responseHeaders: Record<string, string>;
  retryBudget?: ModelRetryBudget;
  streamErrorChunkObserved?: boolean;
  streamIteratorCreated?: boolean;
}): { canRetry: boolean; context?: Record<string, unknown> } {
  const httpResponseStatus = input.preserveProviderStreamBoundaries
    ? resolveCompactHttpResponseStatus(input.error)
    : undefined;
  const streamFailurePhase = input.preserveProviderStreamBoundaries
    ? classifyStreamFailurePhase({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        httpResponseStatus,
        responseHeaders: input.responseHeaders,
        streamErrorChunkObserved: input.streamErrorChunkObserved,
        streamIteratorCreated: input.streamIteratorCreated,
      })
    : undefined;

  return {
    canRetry: canRetryStreamFailure({
      attempt: input.attempt,
      emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
      error: input.error,
      failure: input.failure,
      httpResponseStatus,
      maxAttempts: input.maxAttempts,
      preserveProviderStreamBoundaries: input.preserveProviderStreamBoundaries,
      retryBudget: input.retryBudget,
      streamFailurePhase,
    }),
    context: compactStreamFailureContext(
      input.preserveProviderStreamBoundaries,
      streamFailurePhase,
      httpResponseStatus,
    ),
  };
}

/**
 * 重试判定核心：已发出可见输出、预算耗尽、用户取消都禁止重试；
 * compact 的 EPIPE/ConnectionClosed 需先于通用 gate 放行；最终 response_body 阶段不重放，
 * 交给 Core 按 commit boundary 决定是否 non-stream fallback。
 */
// 这里是重试的最终裁决点：可见输出、预算、取消、stale 连接、策略表、compact 阶段依次过闸。
// 顺序不可调整：stale 连接必须先于通用 retryable 放行，否则 EPIPE 永远不会重试。
// workflow 流量读策略表而不是分类器的 retryable，并发上限错误在这里应被视为可重试。
function canRetryStreamFailure(input: {
  attempt: number;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  httpResponseStatus?: number;
  maxAttempts: number;
  preserveProviderStreamBoundaries?: boolean;
  retryBudget?: ModelRetryBudget;
  streamFailurePhase?: StreamFailurePhase;
}): boolean {
  // workflow 流量（无上限预算）不读分类器的 retryable，读策略表：只有确定性的模型侧错误
  // 才不重试；3008/3009/3010 这类并发上限在这里是 retry。
  const providerCode = inspectProviderFailure(input.error).providerErrorCode;
  // 可见输出已发出后绝不重放（交给 core 的 stream recovery）；预算门在 unbounded 下恒开。
  if (
    input.emittedRetryBoundaryEvent ||
    !retryBudgetAllows(input.retryBudget, input.attempt, input.maxAttempts)
  ) {
    return false;
  }

  if (input.failure.reason === ModelFailureReasonValue.Cancelled) {
    return false;
  }

  if (
    input.preserveProviderStreamBoundaries === true &&
    isCompactStaleStreamFailure(input.error, input.httpResponseStatus)
  ) {
    // compact 请求允许重试 EPIPE/ConnectionClosed；它们不在通用
    // model failure retryable 集合中，必须先于通用 gate 判定。
    return true;
  }

  if (!retryAllowedByFailurePolicy(input.failure, input.retryBudget, providerCode)) {
    return false;
  }

  // setup failure 保留既有 adapter/API retry；compact 的 SSE protocol/business body error
  // 不再重放，耗尽后的 non-stream fallback 由 Core 按 commit boundary 处理。
  return (
    input.preserveProviderStreamBoundaries !== true || input.streamFailurePhase !== "response_body"
  );
}

/** 取 transport 层硬证据的 HTTP status：优先 ProviderBusinessError.responseStatus，再退回 APICallError。 */
// ProviderBusinessError.responseStatus 是 fetch 层硬证据；外层 statusCode 可能已被业务码覆盖。
// 必须先 unwrapRetryError，才能看到原始 provider 错误对象。
// 找不到任何 status 时返回 undefined，阶段判定会继续看 error chunk 与 content-type。
function resolveCompactHttpResponseStatus(error: unknown): number | undefined {
  const unwrapped = unwrapRetryError(error);
  // ProviderBusinessError.responseStatus 是 fetch 层保留的 transport status；外层
  // APICallError/statusCode 可能已被业务码覆盖，因此必须优先使用这一硬证据。
  return findProviderBusinessError(unwrapped)?.responseStatus ?? getHttpResponseStatus(unwrapped);
}

/** compact 流失败是否属于“陈旧连接”类：idle timeout / ECONNRESET / EPIPE / ConnectionClosed。 */
// idle timeout/ECONNRESET/EPIPE/ConnectionClosed 是「连接已死」而非「模型拒绝」，可安全重试。
// 一旦有明确 HTTP status，就不再按陈旧连接处理：那说明服务端已经明确答复。
// provider 业务码也可能携带 stale 语义，需要同时检查。
function isCompactStaleStreamFailure(
  error: unknown,
  httpResponseStatus: number | undefined,
): boolean {
  const unwrapped = unwrapRetryError(error);
  if (isModelStreamIdleTimeoutError(unwrapped)) {
    return true;
  }

  if (isCompactStaleCode(getErrorCode(unwrapped))) {
    return true;
  }
  if (httpResponseStatus !== undefined) {
    return false;
  }

  const providerCode = findProviderBusinessError(unwrapped)?.providerCode;
  return isCompactStaleCode(typeof providerCode === "number" ? String(providerCode) : providerCode);
}

// 比较前统一 trim + 大写：不同 runtime 的错误码大小写不一致。
// 只认三个明确的连接中断码，不要把超时/限流混进来。
function isCompactStaleCode(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  return normalized === "ECONNRESET" || normalized === "EPIPE" || normalized === "CONNECTIONCLOSED";
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

/** 把 chunk 处理结果归一为完整结构，调用方只需覆盖关心的字段。 */
// 默认值即「无事件、无错误、无重试」；调用方只覆盖关心的字段。
// visibleEvents 每次新建数组，避免不同 chunk 共享可变状态。
// terminalError 是可选项，存在时必须由外层立即上抛。
function streamChunkResult(
  overrides: Partial<{
    /** 本 chunk 是否已报错（影响终态日志与 model-io）。 */
    emittedError: boolean;
    /** 是否已向消费者 yield 过事件。 */
    emittedEvent: boolean;
    /** 是否已越过 SSE 重试边界（一旦为 true 不允许重放）。 */
    emittedRetryBoundaryEvent: boolean;
    /** 是否已在 helper 内完成退避并安排重试。 */
    retryScheduled: boolean;
    /** off-peak 排队重试：外层 for 冻结 attempt 预算。 */
    offPeakQueueHold: boolean;
    /** 需要外层立即上抛的终端错误。 */
    terminalError?: TerminalStreamChunkError;
    /** 本次应 yield 给消费者的可见事件。 */
    visibleEvents: ModelStreamEvent[];
  }> = {},
) {
  return {
    emittedError: false,
    emittedEvent: false,
    emittedRetryBoundaryEvent: false,
    retryScheduled: false,
    offPeakQueueHold: false,
    visibleEvents: [],
    ...overrides,
  };
}

/** 组装 publishModelStatus 的公共上下文；admission 票据（存在时）作为本次尝试的状态事件汇。 */
// 准入票据就是本次尝试的状态事件汇：有票时状态事件随票归集。
// 无票（如退避期间取消）时直接走 sink，不能凭空造票。
// 三处 sink（request/status/admission）优先级由 publishModelStatus 决定，这里只透传。
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

/** 发布 model_retry_scheduled 状态；delayMs 为该次退避时长，nextAttempt 供 UI 展示。 */
// 重试状态统一从这里发布，保证 reason/delayMs/nextAttempt 三个字段在所有路径上一致。
// delayMs 为 0 表示无需等待（鉴权刷新/签名修复），UI 不应显示倒计时。
// nextAttempt 只是展示用，真实序号仍由 for 循环控制。
async function publishRetryScheduledStatus(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    retry: ResolvedAiSdkModelRetryOptions;
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

/**
 * 根据可见事件推断首内容/首文本耗时与“输出已提交”标记。
 * block stop 与 tool_call 视为提交；start 类事件只算首内容时间，不算提交。
 */
// 提交判定按事件类型固定：block stop/tool_call 视为提交，start 类只算首内容时间。
// 把 start 当成提交会让鉴权刷新与重试提前失效——这是最容易写错的一处。
// compact 边界事件只在 block start 时算首内容，在 block stop 时算提交。
function observeVisibleStreamEvent(
  event: ModelStreamEvent,
  elapsed: number,
): { contentMs?: number; textMs?: number; outputCommitted: boolean } {
  switch (event.type) {
    case "text_delta":
      return {
        contentMs: elapsed,
        textMs: event.text ? elapsed : undefined,
        outputCommitted: true,
      };
    case "reasoning_delta":
    case "tool_input_delta":
    case "tool_call":
      return { contentMs: elapsed, outputCommitted: true };
    case "text_start":
    case "reasoning_start":
    case "tool_input_start":
      return { contentMs: elapsed, outputCommitted: false };
    case "compact_stream_boundary":
      return {
        contentMs: event.boundary === "provider_content_block_start" ? elapsed : undefined,
        outputCommitted:
          event.boundary === "provider_content_block_stop" ||
          event.boundary === "inferred_content_block_stop",
      };
    default:
      return { outputCommitted: false };
  }
}

/** 尽力读取聚合的 response headers 并脱敏；promise 失败或无 headers 时返回空对象。 */
// 响应头读取失败不影响任何控制流：超时、已销毁的流都按空对象处理。
// 读取后立即脱敏，确保后续日志与状态事件不会泄漏敏感头。
// 这是唯一的响应头入口，不要在别处直接访问 result.response。
async function resolveStreamResponseHeaders(
  result: AiSdkStreamTextResult,
): Promise<Record<string, string>> {
  try {
    const response = await (result as unknown as { response?: Promise<unknown> }).response;
    return sanitizeModelNetworkHeaders((response as { headers?: unknown } | undefined)?.headers);
  } catch {
    return {};
  }
}
