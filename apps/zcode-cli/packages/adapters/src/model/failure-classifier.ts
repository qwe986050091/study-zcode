// ============================================================
// 深注（INV-01..INV-20）：每条给出不变量 → 守卫位置 → 破坏后果
// INV-01 纯函数性：分类只读入参、不写外部状态；守卫：classifyModelFailure 全局部量；破坏后果：并发下重试计数与状态事件互相污染
// INV-02 取消优先：先判 abort 再判超时/网络；守卫：isAbortFailure 分支位置；破坏后果：用户取消被当成超时重试，白烧配额
// INV-03 取消不可重试：retryable=false 且 isRetryableFailure 再排除；守卫：两处双保险；破坏后果：取消后仍重放请求
// INV-04 retry-after 单次解析全分支透传；守卫：retryAfterMs 常量与各分支字段；破坏后果：限流退避失去 provider 建议值
// INV-05 业务码优先于 HTTP 状态；守卫：classifyProviderBusinessFailure 首段 mappedFailure；破坏后果：403/400 被泛化掩盖真实业务原因
// INV-06 业务错误三载体全覆盖：cause 链、AI SDK 映射、responseBody；守卫：主流程三次调用；破坏后果：同一次失败分类随载体不同而漂移
// INV-07 包装码不算真实码：PROVIDER_BUSINESS_ERROR 视为空；守卫：normalizeProviderCode；破坏后果：真实 BigModel 码无法深挖
// INV-08 直接码为空才做深层回退；守卫：resolveProviderBusinessCode 短路；破坏后果：多余遍历且可能取到更深的错误码
// INV-09 状态码域约束 400~599；守卫：normalizeHttpFailureStatus；破坏后果：1234 这类业务码被误当 HTTP 状态
// INV-10 状态码优先级 入参→statusCode→responseStatus→响应体；守卫：resolveProviderBusinessStatusCode；破坏后果：显式入参被内层旧值覆盖
// INV-11 401/403 一律鉴权失败且不可重试；守卫：两条鉴权分支；破坏后果：坏密钥被反复重试，触发风控
// INV-12 400/422 先分内容超窗再归无效请求；守卫：isContextExceededFailure；破坏后果：可自动压缩上下文的重试被放弃
// INV-13 429 两类原因字段都标 RateLimited；守卫：两条 429 分支；破坏后果：退避策略与告警统计口径不一致
// INV-14 5xx 可重试且两类路径口径一致；守卫：两处 >=500 分支；破坏后果：业务码路径的 5xx 变成不可重试
// INV-15 TLS 失败不可重试；守卫：isTlsFailure 分支；破坏后果：证书错误无限重放，拖死请求队列
// INV-16 网络/代理失败可重试并带 retryAfterMs；守卫：isProxyFailure 与 isNetworkFailure 分支；破坏后果：瞬时抖动被当永久失败
// INV-17 兜底不抛错：未知错误 retryable=false；守卫：函数末尾与业务错误末尾 return；破坏后果：分类器抛错会吞掉原始 error context
// INV-18 环安全：cause 链与响应体遍历都用 WeakSet；守卫：findProviderBusinessError 与 collectNestedRecords；破坏后果：自引用 cause 直接栈溢出
// INV-19 BFS 层序稳定：按层序取首个命中字段；守卫：collectNestedRecords 队列；破坏后果：深层无关 code 抢在外层真实码之前
// INV-20 诊断字段同源：status 事件与最终 error context 都走 inspectProviderFailure；守卫：该函数三段顺序；破坏后果：同一失败两处展示不一致
// ---- INV 清单结束，以下为原有文件头 ----
// ============================================================
// model/failure-classifier —— 失败归一化分类器
// 定位：把 AI SDK / fetch / 流式 / Provider 业务错误统一归并为 ClassifiedModelFailure，
//       供重试策略与状态事件判断“是否可重试、何时重试、如何展示”。
// 输入：任意抛出值（常为 APICallError/RetryError/ProviderBusinessError）+ 可选 abortSignal。
// 输出：纯数据分类结果（code/reason/retryReason/retryable/retryAfterMs/statusCode），不抛错。
// 副作用：无网络/落盘/数据库；仅做解析与结构遍历（带 WeakSet 防环）。
// 失败语义：分类函数本身吞掉不确定性，未知错误落到 retryable=false 的 ModelRequestFailed；
//       Provider 业务码映射优先于通用 HTTP 状态，避免 403/400 被泛化掩盖真实原因。
// 不变量：Cancelled 永远不可重试；retry-after 在同一次归一化中透传到每个返回分支。
// ============================================================
import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason as ModelRetryReasonValue,
  type ModelErrorCode as ModelErrorCodeType,
  type ModelFailureReason,
  type ModelRetryReason,
} from "@zcode/contracts";
import {
  getApiCallResponseBody,
  getErrorCode,
  getResponseHeaders,
  getStatusCode,
  isAbortFailure,
  isContextExceededFailure,
  isNetworkFailure,
  isProviderMarkedRetryable,
  isProxyFailure,
  isTimeoutFailure,
  parseRetryAfterMs,
  unwrapRetryError,
} from "./failure-inspection.js";
import { readMappedAiSdkProviderBusinessError } from "./failure-ai-sdk-provider-error.js";
import { isTlsFailure } from "./failure-tls.js";
import {
  isProviderBusinessError,
  readProviderBusinessFailureFromBody,
  ProviderBusinessError,
} from "./model-execution.js";
import {
  getProviderBusinessCodeMapping,
  isRetryableProviderBusinessNetworkFailure,
  isRetryableProviderBusinessTimeoutFailure,
} from "./failure-provider-business-codes.js";
import { isModelStreamIdleTimeoutError } from "./stream-idle-timeout.js";

// [权衡] 包装占位码：adapter 只用它表示“这是业务错误外壳”，不携带真实 provider 码。
// 把它当真实码会让 getProviderBusinessCodeMapping 查不到映射，最终落到 5xx 兜底。
// 因此这里保留常量并交给 normalizeProviderCode 统一剔除，而不是在每处调用点判断。
// 该常量与真实业务码字符串同形，比较时必须大小写无关，否则会漏剔除。
// 改动后果：去掉剔除逻辑后，BigModel 数值码（如 1234）再也无法从响应体恢复。
const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";

// [不变量] 分类结果是纯数据契约：调用方（重试器、状态事件、UI）只读，不回调、不持有异常对象。
// 因此这里只暴露可序列化字段，避免把 APICallError 实例泄漏到事件流里。
// [失败路径] statusCode 允许缺省：网络层失败（DNS 解析、连接重置）根本没有 HTTP 响应。
// retryAfterMs 缺省表示 provider 未给出建议值，调用方应使用自身退避曲线而不是当作 0。
// 改动后果：若加入非原始类型字段，状态事件序列化会静默丢字段或改变形状。
export interface ClassifiedModelFailure {
  /** 对外错误码，决定调用方展示与上层补偿策略。 */
  code: ModelErrorCodeType;
  /** 可读错误信息；业务错误优先使用 provider 原文。 */
  message: string;
  /** 失败语义分类（超时/限流/鉴权/取消等）。 */
  reason: ModelFailureReason;
  /** 重试原因分类，供退避/告警统计区分触发来源。 */
  retryReason: ModelRetryReason;
  /** 是否允许重试；Cancelled 恒为 false。 */
  retryable: boolean;
  /** Provider 建议的等待毫秒数（解析自 retry-after），缺省 undefined。 */
  retryAfterMs?: number;
  /** HTTP 状态码（或从响应体深层解析出的等价状态），缺省表示无。 */
  statusCode?: number;
}

// [权衡] 诊断字段与分类结果分离：inspectProviderFailure 只负责取事实，不做重试决策。
// 这样即使分类落到 Unknown，工单里仍能带上 providerRequestId 与原始业务码。
// 三个字段全部可选：命中 ProviderBusinessError、AI SDK 映射错误或响应体扫描任一条即可。
// 改动后果：把这里合并进 ClassifiedModelFailure 会让观测链路强依赖分类是否成功。
export interface ProviderFailureDetails {
  /** Provider 业务错误码（BigModel 数值码会被规范成字符串）。 */
  providerErrorCode?: string;
  /** Provider 返回的错误文案。 */
  providerErrorMessage?: string;
  /** Provider 请求 id，用于对账/工单。 */
  providerRequestId?: string;
}

/**
 * 提取 Provider 诊断字段，供 status 事件与最终 error context 使用。
 * 顺序：cause 链里的 ProviderBusinessError → AI SDK 映射错误 → 响应体业务扫描；
 * 全部未命中返回空对象（不是错误）。无副作用，不抛错。
 */
// [失败路径] 三段来源按可信度降序：cause 链里的 ProviderBusinessError 最可信（含 requestId），
// 其次是 AI SDK 已解析的映射错误，最后才扫描 responseBody 的深层结构。
// 前一段命中即返回，避免响应体里残留的旧码覆盖真实业务错误。
// 全部未命中返回空对象而不是抛错：观测链路不能因为分类失败而中断原始错误上报。
export function inspectProviderFailure(error: unknown): ProviderFailureDetails {
  const unwrapped = unwrapRetryError(error);
  // 分类链路能读取 AI SDK parsed error，但观测链路只认识 ProviderBusinessError，
  // 导致同一次失败在 status event 与最终 error context 中丢失 provider 诊断字段。
  const businessError =
    findProviderBusinessError(unwrapped) ?? readMappedAiSdkProviderBusinessError(unwrapped);
  if (businessError) {
    return {
      providerErrorCode: resolveProviderBusinessCode(businessError),
      providerErrorMessage: providerBusinessMessage(businessError),
      providerRequestId: businessError.providerRequestId,
    };
  }
  const detected = readProviderBusinessFailureFromBody(getApiCallResponseBody(unwrapped));
  return detected
    ? {
        providerErrorCode:
          typeof detected.providerCode === "number"
            ? String(detected.providerCode)
            : detected.providerCode,
        providerErrorMessage: detected.providerMessage,
        providerRequestId: detected.providerRequestId,
      }
    : {};
}

/**
 * 失败分类主入口：按“明确错误码 → 取消/空闲超时 → Provider 业务错误（三种载体）
 * → 超时/HTTP 状态 → TLS/代理/网络 → provider 自标记可重试 → 未知”的顺序判定。
 * 输入任意抛出值；解包 RetryError 后读取 status/headers/retry-after。
 * 输出完整分类结果，任何输入都有返回值（兜底 retryable=false），无副作用。
 */
// [不变量] 判定顺序即优先级，顺序被改动会直接改变线上重试行为：
// 明确错误码 → 取消 → 流空闲超时 → 业务错误三载体 → 超时/HTTP → TLS/代理/网络 → provider 自标记 → 未知。
// 业务错误必须早于通用 HTTP 分支，否则 403 携带的业务码会被显示成通用鉴权失败。
// [事务] 全程无网络、无落盘：只读解包后的对象字段与响应头，可安全重放与并发调用。
// [并发] 不修改入参 error，也不缓存分类结果，多个调用方各自计算，互不干扰。
export function classifyModelFailure(
  error: unknown,
  abortSignal?: AbortSignal,
): ClassifiedModelFailure {
  const unwrapped = unwrapRetryError(error);
  const statusCode = getStatusCode(unwrapped);
  const code = getErrorCode(unwrapped);
  const headers = getResponseHeaders(unwrapped);
  // [资源] retry-after 只解析一次并在本次归一化内复用到所有返回分支，
  // 保证同一失败在 429、5xx、网络分支上给出同一个等待值，不会因分支不同而抖动。
  // 解析失败（非数字、非法单位、负数）时返回 undefined，交由调用方退避曲线兜底。
  // [权衡] 不做上限截断：provider 给出超长等待时由重试器决定是否封顶，这里保持事实值。
  const retryAfterMs = parseRetryAfterMs(headers);

  if (code === ModelErrorCode.InvalidModelResponse) {
    return {
      code: ModelErrorCode.InvalidModelResponse,
      message:
        unwrapped instanceof Error ? unwrapped.message : "Model returned an invalid response.",
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (code === ModelErrorCode.InvalidModelRequest) {
    return {
      code: ModelErrorCode.InvalidModelRequest,
      message:
        unwrapped instanceof Error ? unwrapped.message : "Model request configuration is invalid.",
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  // [并发] 取消判定同时看错误形状与调用方传入的 abortSignal：
  // AI SDK 有时只抛 AbortError 而不带 signal 状态，只看错误会漏判，只看 signal 会漏掉已发生的取消。
  // [不变量] 取消分支固定 retryable=false 且 reason=Cancelled，后续 isRetryableFailure 还会再排除一次。
  // 改动后果：取消被归为可重试会让用户主动中断的请求继续占用配额并延迟 UI 收起。
  if (isAbortFailure(unwrapped, abortSignal)) {
    return {
      code: ModelErrorCode.ModelRequestCancelled,
      message: "Model request was cancelled.",
      reason: ModelFailureReasonValue.Cancelled,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  // [失败路径] 流空闲超时单独成类：响应已开始但中途停止，语义更接近可续传的超时而非网络失败。
  // reason 与 retryReason 同时标 StreamIdleTimeout，供告警区分首字节前超时与流中途停滞。
  // 该分支可重试且携带 retryAfterMs，避免空转等待被当成永久失败。
  // 改动后果：并入通用超时后，流停滞的统计口径会与连接超时混在一起，难以定位。
  if (isModelStreamIdleTimeoutError(unwrapped)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message: unwrapped.message,
      reason: ModelFailureReasonValue.StreamIdleTimeout,
      retryReason: ModelRetryReasonValue.StreamIdleTimeout,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // fetch 层提前抛出的 ProviderBusinessError 不走 APICallError，
  // retry-after 必须在业务错误归一化时继续传下去。
  // [失败路径] 载体一：fetch 层直接抛出的 ProviderBusinessError 不走 APICallError，
  // 因此必须先从 cause 链里找出它，再交给业务错误归一化；找不到时传原值并由内部类型守卫返回 undefined。
  // [不变量] retry-after 在这里继续透传，业务错误分支不能丢掉上游解析出的等待值。
  // 改动后果：漏掉这一步会让带业务码的 403/400 落到通用 HTTP 分支，错误文案与重试性都会失真。
  const providerBusinessFailure = classifyProviderBusinessFailure(
    findProviderBusinessError(unwrapped) ?? unwrapped,
    statusCode,
    retryAfterMs,
  );
  if (providerBusinessFailure) {
    return providerBusinessFailure;
  }

  // AI SDK 的请求错误保留在 APICallError.data.error，流式 SSE 错误则直接提供
  // 已解析的 error 对象；这里统一消费这两种 AI SDK 输出，不新增 provider 原始响应旁路。
  const aiSdkErrorFailure = classifyProviderBusinessFailure(
    readMappedAiSdkProviderBusinessError(unwrapped),
    statusCode,
    retryAfterMs,
  );
  if (aiSdkErrorFailure) {
    return aiSdkErrorFailure;
  }

  // AI SDK 有时把 403 JSON（如 3007）包成 APICallError，不走 ProviderBusinessError；
  // 若在通用 403 鉴权分支之前不解析 responseBody，会误显示 “Provider authentication failed.”。
  const apiCallBodyFailure = classifyProviderBusinessFailureFromApiCallBody(
    unwrapped,
    statusCode,
    retryAfterMs,
  );
  if (apiCallBodyFailure) {
    return apiCallBodyFailure;
  }

  if (isTimeoutFailure(unwrapped, code, statusCode)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message: "Model request timed out.",
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 429) {
    return {
      code: ModelErrorCode.ModelRateLimited,
      message: "Provider rate limited the model request.",
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 529) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider is overloaded.",
      reason: ModelFailureReasonValue.ProviderOverloaded,
      retryReason: ModelRetryReasonValue.ProviderOverloaded,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // [权衡] 通用鉴权分支只处理没有业务码可讲的情况：统一归 ProviderNotConfigured 并禁止重试。
  // 401 与 403 合并：两者对调用方的处置相同（重新配置凭据），区分只会增加分支而无收益。
  // retryReason 仍标 AuthRefresh，提示上层需要刷新凭据而不是稍后重试。
  // 改动后果：改成可重试会让失效密钥被反复打向 provider，放大风控与配额消耗。
  if (statusCode === 401 || statusCode === 403) {
    return {
      code: ModelErrorCode.ProviderNotConfigured,
      message: "Provider authentication failed.",
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
      statusCode,
    };
  }

  // [失败路径] 400/422 先区分内容超窗再归为无效请求：超窗可自动压缩上下文后成功，语义不同。
  // 判定依赖 isContextExceededFailure 读取错误文案与响应体特征，不依赖状态码本身。
  // 两个分支都不可重试：原样重放同样请求只会得到同样结果。
  // 改动后果：把超窗并入 InvalidModelRequest 会让调用方放弃可自动恢复的压缩重试。
  if (statusCode === 400 || statusCode === 422) {
    const contextExceeded = isContextExceededFailure(unwrapped);
    return {
      code: contextExceeded
        ? ModelErrorCode.ModelContextExceeded
        : ModelErrorCode.InvalidModelRequest,
      message: contextExceeded
        ? "Model request exceeded the provider context window."
        : "Provider rejected the model request.",
      reason: contextExceeded
        ? ModelFailureReasonValue.ContextExceeded
        : ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isContextExceededFailure(unwrapped)) {
    return {
      code: ModelErrorCode.ModelContextExceeded,
      message: "Model request exceeded the provider context window.",
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider returned a server error.",
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (isTlsFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "TLS validation failed for the provider request.",
      reason: ModelFailureReasonValue.TlsError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isProxyFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Proxy connection failed for the provider request.",
      reason: ModelFailureReasonValue.ProxyError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (isNetworkFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Network connection failed for the provider request.",
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // [失败路径] 兜底路径不抛错：所有已知形态都未命中时，仍返回结构完整的 ModelRequestFailed。
  // 是否可重试取决于 provider 自定义标记（响应头或错误体里的显式 retryable），默认 false。
  // reason 随标记在 ServerError 与 Unknown 之间切换，便于统计未知但 provider 认为可重试的比例。
  // 改动后果：兜底默认改为 true 会让真正不可恢复的错误进入无限重试。
  const retryable = isProviderMarkedRetryable(unwrapped);
  return {
    code: ModelErrorCode.ModelRequestFailed,
    message: retryable
      ? "Provider marked the model request as retryable."
      : "Model request failed.",
    reason: retryable ? ModelFailureReasonValue.ServerError : ModelFailureReasonValue.Unknown,
    retryReason: retryable ? ModelRetryReasonValue.ServerError : ModelRetryReasonValue.NetworkError,
    retryable,
    retryAfterMs,
    statusCode,
  };
}

/** 可重试判定：既要求 retryable，又排除取消（取消即使被标 retryable 也不得重放）。 */
// [不变量] 对外可重试判定是双条件与：分类结果 retryable 为真，且 reason 不是 Cancelled。
// 第二重判断是防御性冗余：即使某条分支错误地给出 retryable=true，取消也绝不会被重放。
// [并发] 纯函数，不读时钟、不读配置，多个重试循环可同时判断同一结果。
// 调用方应使用本函数而不是直接读 failure 的 retryable，否则会绕过取消保护。
// 改动后果：删除 Cancelled 检查会让取消态在分支重构后悄悄变成可重试。
export function isRetryableFailure(failure: ClassifiedModelFailure): boolean {
  return failure.retryable && failure.reason !== ModelFailureReasonValue.Cancelled;
}

/**
 * 从 APICallError 的 responseBody 中识别业务错误（AI SDK 未包成 ProviderBusinessError 的情况）。
 * 命中则复用统一的业务错误分类；未命中返回 undefined 让主流程继续走通用 HTTP 分支。
 */
function classifyProviderBusinessFailureFromApiCallBody(
  error: unknown,
  statusCode?: number,
  retryAfterMs?: number,
): ClassifiedModelFailure | undefined {
  const body = getApiCallResponseBody(error);
  const detected = readProviderBusinessFailureFromBody(body);
  if (!detected) {
    return undefined;
  }

  return classifyProviderBusinessFailure(
    new ProviderBusinessError({
      providerCode: detected.providerCode,
      providerId: "unknown",
      providerKind: "openai-compatible",
      providerMessage: detected.providerMessage,
      providerRequestId: detected.providerRequestId,
      responseBodySummary: detected.responseBodySummary,
      responseStatus: statusCode ?? detected.statusCode,
      statusCode: statusCode ?? detected.statusCode,
    }),
    statusCode ?? detected.statusCode,
    retryAfterMs,
  );
}

/**
 * 业务错误归一化：先查显式业务码映射（最高优先级），再依次判超窗/可重试超时/
 * 401·403/404/400·422/429/可重试网络/5xx，最后兜底 Unknown（不可重试）。
 * 非业务错误返回 undefined，交由调用方继续分类。
 */
// [不变量] 业务错误内部优先级：显式业务码映射 → 内容超窗 → 可重试业务超时 →
// 401/403 → 404 → 400/422 → 429 → 可重试网络 → 5xx → 兜底 Unknown（不可重试）。
// 显式映射排最前：provider 的业务码语义比 HTTP 状态更精确，不能被状态码分支抢先。
// [失败路径] 非业务错误返回 undefined，由调用方继续走通用分类，绝不在本函数内抛错。
// 兜底 Unknown 一律不可重试，避免未知业务码触发无界重试风暴。
function classifyProviderBusinessFailure(
  error: unknown,
  statusCode?: number,
  retryAfterMs?: number,
): ClassifiedModelFailure | undefined {
  if (!isProviderBusinessError(error)) {
    return undefined;
  }

  const message = providerBusinessMessage(error);
  const providerCode = resolveProviderBusinessCode(error);
  const effectiveStatusCode = resolveProviderBusinessStatusCode(error, statusCode);
  const mappedFailure = providerCode ? getProviderBusinessCodeMapping(providerCode) : undefined;
  if (mappedFailure) {
    return {
      code: mappedFailure.code,
      message: mappedFailure.message ?? message,
      reason: mappedFailure.reason,
      retryReason: mappedFailure.retryReason,
      retryable: mappedFailure.retryable,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (isContextExceededFailure(error)) {
    return {
      code: ModelErrorCode.ModelContextExceeded,
      message: "Model request exceeded the provider context window.",
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }
  if (isRetryableProviderBusinessTimeoutFailure(error, providerCode, effectiveStatusCode)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message,
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }
  const retryReason =
    effectiveStatusCode !== undefined && effectiveStatusCode >= 500
      ? ModelRetryReasonValue.ServerError
      : ModelRetryReasonValue.NetworkError;

  if (effectiveStatusCode === 401 || effectiveStatusCode === 403) {
    return {
      code: ModelErrorCode.ProviderNotConfigured,
      message,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 404) {
    return {
      code: ModelErrorCode.ModelNotFound,
      message,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 400 || effectiveStatusCode === 422) {
    return {
      code: ModelErrorCode.InvalidModelRequest,
      message,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 429) {
    return {
      code: ModelErrorCode.ModelRateLimited,
      message,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (isRetryableProviderBusinessNetworkFailure(error, providerCode)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message,
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode !== undefined && effectiveStatusCode >= 500) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message,
      reason: ModelFailureReasonValue.ServerError,
      retryReason,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  return {
    code: ModelErrorCode.ModelRequestFailed,
    message,
    reason: ModelFailureReasonValue.Unknown,
    retryReason,
    retryable: false,
    retryAfterMs,
    statusCode: effectiveStatusCode,
  };
}

/**
 * 沿 cause 链查找 ProviderBusinessError；带 WeakSet 防止循环 cause 导致无限递归。
 * 只在 cause 上递归（AI SDK 常见的二次包装位置），不遍历任意属性。
 */
// [并发] 递归只看 cause 一条链，属于线性深度优先；不遍历任意属性，避免扫到无关大对象。
// [资源] seen 是调用级 WeakSet：只记录本次遍历过的对象，不阻止其被回收，也不跨调用共享。
// 遇到自引用 cause（cause 指回自身）直接返回 undefined，防止无限递归。
// 改动后果：去掉环检测后，包装库一旦形成 cause 环就会栈溢出并吞掉原始错误。
export function findProviderBusinessError(
  error: unknown,
  seen = new WeakSet<object>(),
): ProviderBusinessError | undefined {
  if (isProviderBusinessError(error)) {
    return error;
  }
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  // AI SDK 可能把 fetch 层抛出的 ProviderBusinessError 包在 cause 里；
  // 若只看外层 APICallError，会丢掉 providerCode/message/responseHeaders。
  const cause = (error as { cause?: unknown }).cause;
  return cause && cause !== error ? findProviderBusinessError(cause, seen) : undefined;
}

/**
 * 规范化 provider 业务码：数值截断转字符串、字符串 trim 后保留大小写；
 * 包装层占位码 PROVIDER_BUSINESS_ERROR 视为“无真实码”，返回 undefined 以继续深挖响应体。
 */
function normalizeProviderCode(value: ProviderBusinessError["providerCode"]): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return normalized.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE ? undefined : normalized;
}

function providerBusinessMessage(error: ProviderBusinessError): string {
  return error.providerMessage ?? error.message ?? "Provider returned a business error.";
}

/**
 * 取业务错误码：优先直接字段；外层只是包装码时回退到 responseBodySummary 深层扫描，
 * 以恢复被二次包装吞掉的真实 BigModel 码（如 1234/1261）。
 */
function resolveProviderBusinessCode(error: ProviderBusinessError): string | undefined {
  const direct = normalizeProviderCode(error.providerCode);
  if (direct) {
    return direct;
  }

  // ProviderBusinessError 可能被 AI SDK/adapter 二次包装，外层 code 是包装类型，
  // 真实 BigModel 码（如 1234/1261）只保留在 responseBodySummary 的深层结构里。
  return readNestedProviderCode(error.responseBodySummary);
}

/**
 * 取有效 HTTP 状态：入参 → error.statusCode → error.responseStatus → 响应体深层；
 * 只接受 400~599，避免把业务码误当状态码。
 */
function resolveProviderBusinessStatusCode(
  error: ProviderBusinessError,
  statusCode: number | undefined,
): number | undefined {
  return (
    normalizeHttpFailureStatus(statusCode) ??
    normalizeHttpFailureStatus(error.statusCode) ??
    normalizeHttpFailureStatus(error.responseStatus) ??
    readNestedStatusCode(error.responseBodySummary)
  );
}

/**
 * 深层读取业务码：依次尝试 providerCode、error_code、code 字段，最后兜底
 * BigModel 文案前缀形式 "[1234][..."；全空返回 undefined。
 */
function readNestedProviderCode(value: unknown): string | undefined {
  const records = collectNestedRecords(value);
  const providerCode = firstNormalizedRecordValue(records, "providerCode");
  if (providerCode) return providerCode;

  const errorCode = firstNormalizedRecordValue(records, "error_code");
  if (errorCode) return errorCode;

  const code = firstNormalizedRecordValue(records, "code");
  if (code) return code;

  return firstBracketedProviderCode(records);
}

/** 从响应体深层结构里找第一个合法 HTTP 状态（statusCode/status/responseStatus）。 */
function readNestedStatusCode(value: unknown): number | undefined {
  const records = collectNestedRecords(value);
  for (const key of ["statusCode", "status", "responseStatus"] as const) {
    for (const record of records) {
      const statusCode = numberProperty(record, key);
      if (normalizeHttpFailureStatus(statusCode) !== undefined) {
        return statusCode;
      }
    }
  }
  return undefined;
}

function firstNormalizedRecordValue(
  records: readonly Record<string, unknown>[],
  key: string,
): string | undefined {
  for (const record of records) {
    const code = normalizeProviderCode(record[key] as ProviderBusinessError["providerCode"]);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function firstBracketedProviderCode(
  records: readonly Record<string, unknown>[],
): string | undefined {
  for (const record of records) {
    const code =
      readBigModelBracketedProviderCode(record.message) ??
      readBigModelBracketedProviderCode(record.providerMessage);
    if (code) {
      return code;
    }
  }
  return undefined;
}

/**
 * 广度优先收集响应体中所有对象（含数组元素），WeakSet 防环；
 * 返回顺序与层级遍历一致，供后续按优先级取第一个命中字段。
 */
// [资源] 广度优先遍历响应体的全部对象：队列加 WeakSet 保证每个对象最多入队一次，
// 因此时间复杂度与响应体节点数线性相关，不会因共享引用指数膨胀。
// 数组元素被展开入队但不作为记录返回，只返回普通对象，供按字段名取值复用。
// [权衡] 不做深度上限：响应体来自 provider 且节点数有限，加深度限制反而会漏掉真实码。
function collectNestedRecords(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    result.push(record);
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return result;
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// [权衡] 只承认 400~599 才是 HTTP 失败状态：低于 400 属于成功或重定向，不应进入失败分类。
// 上界 599 排除 BigModel 的四位业务码（如 1234、3007）被误当状态码。
// 非数字、NaN、Infinity 一律返回 undefined，让调用方继续尝试下一来源。
// 改动后果：放宽范围会让业务码污染 statusCode 字段并误导退避策略。
function normalizeHttpFailureStatus(value: number | undefined): number | undefined {
  return value !== undefined && value >= 400 && value <= 599 ? value : undefined;
}

/** 解析 BigModel 风格文案前缀码：仅匹配开头四位数字且紧跟下一个 "[..."，避免误取其他数字。 */
function readBigModelBracketedProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.trim().match(/^\[(\d{4})\](?=\[)/);
  return match?.[1];
}
