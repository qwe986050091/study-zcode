// 职责：把一次失败归一化为低基数 telemetry 归因（errorSource + failureReason），
// 供 ARMS 上报与看板聚合使用；本文件只读证据、不生成用户可见文案、不改重试决策。
// 证据强度从高到低：显式 source、稳定传输 code、结构化 reason、provider code、HTTP 状态码、受控文案、关键词。
// [失败路径] 本文件全路径不抛错也不写日志；任何意外输入都退化为空 reason 或 unknown，由上报端容忍。
// INV-01 同一入参必须产出同一归因，函数不得读取模块外可变状态；守住位置：resolveTelemetryAttribution 整体；改错故障：同一故障被拆进多个桶，告警阈值失真
// INV-02 空字符串 failureReason 表示没有失败或未归因，unknown 才表示确已失败但无法归类；守住位置：resolve 的默认参数与末尾 return；改错故障：成功率与失败率之和不再等于 1
// INV-03 explicitSource 一旦存在必须压过任何推断来源；守住位置：resolve 内 errorSource 的取空合并；改错故障：调用方已确认的边界被文案关键词覆盖，故障分桶错位
// INV-04 errorSource 与 failureReason 必须落在同一张集合里，不允许 network reason 配 provider source；守住位置：resolveSourceFromReason 与三张 Set；改错故障：上游可用性看板把本地错误算成供应商故障
// INV-05 结构化 reason 非空且非 unknown 时，不得被 transport code 或 generic provider 分支提前拦截；守住位置：stableTransportAttribution 与 genericProviderAttribution 的门禁条件；改错故障：明确的结构化事实被弱证据改写
// INV-06 transport code 与 generic provider code 只允许修正空或 unknown 的 reason；守住位置：stableTransportAttribution 的三元条件；改错故障：旧 runner 的历史归因被新逻辑覆写，趋势出现断点
// INV-07 generic provider 归因只对 allowlist 内的稳定 code 生效；守住位置：resolveGenericProviderCodeAttribution 的调用点；改错故障：自定义供应商的私有 code 被误判成通用语义
// INV-08 rate_limited 只有在 retryable 为 false 且可信业务 reason 为 quota_exhausted 时才改写；守住位置：套餐终态分支；改错故障：可重试限流被记成额度耗尽，用户被引导去充值
// INV-09 130x/300x 业务码必须同时具备 providerId 才允许按上游语义解释；守住位置：trustedProviderReason 分支；改错故障：其他供应商的同名 code 被误判成套餐到期
// INV-10 legacy envelope 必须是三段式官方错误文案且 code 命中 allowlist；守住位置：resolveLegacyProviderEnvelopeCode 的调用点；改错故障：任意含数字的普通报错被恢复成 provider 事实
// INV-11 413 必须先区分上下文超限与请求体超限，再给出 reason；守住位置：statusCode 413 的两个分支及先后顺序；改错故障：上下文超限被提示成参数错误，用户反复重试
// INV-12 HTTP 状态码判定必须由窄到宽，特例走完才允许进入 5xx 兜底；守住位置：状态码分支链；改错故障：401 被更早的宽分支吞掉，鉴权问题被报成参数问题
// INV-13 受控文案是最低优先级证据，只能在结构证据全部缺席时返回；守住位置：controlledMessageAttribution 分支；改错故障：弱文案覆盖 401 或 1308 等确定事实
// INV-14 关键词正则必须具体模式在前、泛化模式在后，network 先于 provider；守住位置：末尾文案分支链；改错故障：proxy 报错被 provider 关键词抢先匹配，网络故障记到上游
// INV-15 传给正则的 message 必须同时包含 displayMessage 与 error.message，用换行拼接；守住位置：message 拼接处；改错故障：只出现在原始 message 里的证据被漏判，归因退回 unknown
// INV-16 displayMessage 仅用于 402 余额这类面向用户的判断，其余以合并文案为准；守住位置：statusCode 402 分支；改错故障：用户可见文案缺失时余额失败退化成 server_error
// INV-17 所有正则不得带 g 标志，避免 lastIndex 在多次调用间残留；守住位置：模块级 PATTERN 常量；改错故障：连续上报时同一文案时灵时不灵，归因抖动
// INV-18 正则不得出现未闭合分组或嵌套量词等回溯放大结构；守住位置：模块级 PATTERN 常量；改错故障：超长错误文案让上报线程卡死
// INV-19 归因结果只用于观测，不得回流到 UI 提示或重试策略；守住位置：本文件全部 return；改错故障：观测口径调整被用户感知成行为变更
import { requestVerificationErrorAttribution } from "@/request-security-edition/errors.js";
import {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
} from "@zcode/shared";
import {
  isGenericProviderInvalidRequestCode,
  isLocalModelValidationMessage,
  isQuotaMessage,
  resolveControlledUnknownMessageAttribution,
  resolveGenericProviderCodeAttribution,
  resolveKnownProviderCodeFailureReason,
  resolveLegacyProviderEnvelopeCode,
  resolveStableTransportCodeAttribution,
  resolveTrustedProviderCodeFailureReason,
} from "@/lib/chatErrorAttributionEvidence.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

// 空串与 unknown 语义不同：空串表示没有失败或未归因，unknown 表示确已失败但证据不足。
// 两者混用会让成功率与失败率之和不再等于 1，看板出现无法解释的空洞。
// [权衡] 单独保留 unknown 常量而不复用空串，是为了让上报端能区分未知失败与无失败。
const UNKNOWN_FAILURE_REASON = "unknown";

// tool 目前没有任何分支会产出，保留它只为兼容既有消费方对联合类型的穷举。
// [权衡] 用字符串字面量而不是 enum，让上报端拿到的就是可直接序列化的值。
type TelemetryErrorSource = "provider" | "runtime" | "network" | "tool" | "";

// 该结构是 telemetry 的对外契约，字段名一旦外发就不能再改，新增维度只能追加。
// failureReason 必须取自低基数词表，不能塞入含用户输入的自由文本。
interface TelemetryErrorAttribution {
  errorSource: TelemetryErrorSource;
  failureReason: string;
}

// [权衡] 正则集中声明而非就近内联：声明顺序即匹配优先级，散落会让谁先命中不可审计。
// 每个模式都只在单次调用里做一次 test，因此可以安全地共享同一个 RegExp 实例。
const RATE_LIMIT_MESSAGE_PATTERN =
  /error[_ -]?rate[_ -]?limited|rate[_ -]?limit|too many requests|request higher limits|throttl/iu;
// 余额不足要充值、配额耗尽等周期重置，混成一个 reason 会给出错误的自救指引。
const BALANCE_MESSAGE_PATTERN =
  /insufficient\s+(?:balance|funds|credit)|balance\s+(?:is\s+)?(?:insufficient|too\s+low)|余额不足|余额不够/iu;
// 限定 0~24 字符间隔，避免把同一句里相隔很远的 plan 与 expired 误配成套餐到期。
const PLAN_EXPIRED_MESSAGE_PATTERN = /(?:coding|subscription|套餐|plan).{0,24}(?:expired|到期)/iu;
const CONTEXT_MESSAGE_PATTERN =
  /context.{0,32}(?:length|window|exceed|limit)|prompt.{0,24}too long|上下文.{0,16}(?:超|限制)/iu;
const AUTH_MESSAGE_PATTERN =
  /unauthori[sz]ed|authentication|invalid\s+(?:api\s+)?key|access\s+denied|鉴权|认证失败/iu;
const NETWORK_MESSAGE_PATTERN =
  /network|connection|econn(?:reset|refused)|enotfound|tls|proxy|网络|连接失败/iu;
const TIMEOUT_MESSAGE_PATTERN = /timeout|timed out|超时/iu;
const OVERLOAD_MESSAGE_PATTERN = /overload|overloaded|server busy|服务繁忙|过载/iu;
const INVALID_REQUEST_MESSAGE_PATTERN =
  /invalid\s+(?:request|argument|parameter)|bad request|参数错误|请求参数/iu;
const EMPTY_MODEL_RESPONSE_MESSAGE_PATTERN =
  /model\s+(?:returned|returning)\s+no\s+content|模型未返回任何内容/iu;
const PROVIDER_REJECTED_MESSAGE_PATTERN =
  /provider\s+rejected|method\s+not\s+allowed|param(?:eter)?\s+incorrect|参数非法|unsupported\s+parameter/iu;
const PROVIDER_SERVER_ERROR_MESSAGE_PATTERN =
  /provider\s+returned\s+(?:a\s+)?server\s+error|internal\s+server\s+error/iu;
const PROVIDER_RATE_LIMIT_MESSAGE_PATTERN =
  /concurrency\s+limit|admission\s+concurrency|model\s+is\s+busy|system\s+is\s+busy/iu;
const ATTACHMENT_INVALID_MESSAGE_PATTERN =
  /(?:image|video)\s+attachments\s+are\s+too\s+large|unable\s+to\s+materialize\s+(?:image|video)\s+attachment\s+path/iu;
const QUEUE_FULL_MESSAGE_PATTERN = /request\s+queue\s+is\s+full/iu;
const CANCELLED_MESSAGE_PATTERN = /turn\s+was\s+cancelled/iu;

// 键是错误 code 的精确值，不做大小写或模糊匹配；同一语义在历史上可能有多种写法，需逐条列出。
// 上游 requestVerification 映射展开在末尾，键冲突时以它为准，覆盖前面手写的同名条目。
// [失败路径] 查表未命中返回 undefined 而非兜底 unknown，否则后面的状态码与文案证据再没有机会生效。
const STABLE_ERROR_ATTRIBUTION: Readonly<
  Record<string, { readonly source: "provider" | "runtime"; readonly reason: string }>
> = {
  model_config_missing: { source: "runtime", reason: "model_config_missing" },
  MODEL_CONFIG_MISSING: { source: "runtime", reason: "model_config_missing" },
  ModelConfigMissing: { source: "runtime", reason: "model_config_missing" },
  StreamRecoveryDiscarded: {
    source: "runtime",
    reason: "stream_recovery_discarded",
  },
  ERR_SQLITE_ERROR: { source: "runtime", reason: "storage_error" },
  INVALID_INPUT: { source: "runtime", reason: "invalid_input" },
  [MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE]: {
    source: "runtime",
    reason: "invalid_input",
  },
  [MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE]: {
    source: "runtime",
    reason: "invalid_input",
  },
  [MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE]: {
    source: "runtime",
    reason: "invalid_input",
  },
  MessageAbortedError: { source: "runtime", reason: "cancelled" },
  StartPlanBusyAutoRetryExhaustedError: {
    source: "provider",
    reason: "rate_limited",
  },
  ...requestVerificationErrorAttribution,
};

// 三张 reason 集合必须与 resolveSourceFromReason 的分支一一对应且互不重叠。
// 新增 reason 时集合、反查分支、看板文案映射三处必须同步修改。
const NETWORK_FAILURE_REASONS = new Set([
  "network_error",
  "proxy_error",
  "stale_connection",
  "stream_idle_timeout",
  "timeout",
  "tls_error",
]);

// runtime 表示 ZCode 自身或本地环境的问题，计入它会虚高上游故障率。
const RUNTIME_FAILURE_REASONS = new Set([
  "compact_rapid_refill_breaker",
  "storage_error",
  "model_config_missing",
  "stream_recovery_discarded",
  "invalid_input",
  "cancelled",
  "provider_not_configured",
]);

// provider 集合只放可归因到上游的失败；quota_exhausted 与 balance_insufficient 的取舍见套餐终态分支。
const PROVIDER_FAILURE_REASONS = new Set([
  "auth_failed",
  "balance_insufficient",
  "context_exceeded",
  "empty_model_response",
  "model_not_found",
  "plan_access_denied",
  "plan_expired",
  "provider_overloaded",
  "quota_exhausted",
  "server_error",
]);

// reason 到 source 的反查必须与三张集合同源，否则会出现集合里认、反查不认的半失效状态。
// 未登记 reason 返回空串而不是 provider：默认塞进 provider 会污染上游可用性指标。
// [权衡] 三次 Set 查找而不是一张大 Map，多一次常数比较换来新增 reason 只改一处集合。
function resolveSourceFromReason(reason: string): TelemetryErrorSource {
  if (NETWORK_FAILURE_REASONS.has(reason)) return "network";
  if (RUNTIME_FAILURE_REASONS.has(reason)) return "runtime";
  if (PROVIDER_FAILURE_REASONS.has(reason)) return "provider";
  return "";
}

// 408 与 504 是网关与请求超时，属于传输层；其余状态码都来自上游 HTTP 响应，归 provider。
// 这里不看响应体，只给粗归因，更细的判定留给后续 reason 与文案分支。
function resolveSourceFromStatusCode(statusCode: number): TelemetryErrorSource {
  return statusCode === 408 || statusCode === 504 ? "network" : "provider";
}

// 这是兜底证据通道：只有前面的结构化证据都不足以定 source 时才会被调用。
// 判定顺序按证据强度递减：状态码、provider code、附件与取消、队列满、网络、上游文案。
// [失败路径] 全部不命中返回空串，调用方必须容忍空 source，不允许在这里擅自猜成 provider。
function resolveSourceFromAdditionalEvidence(params: {
  error: ZCodeUiError;
  displayMessage: string;
}): TelemetryErrorSource {
  const statusCode = params.error.attribution?.statusCode;
  if (statusCode !== undefined) {
    return resolveSourceFromStatusCode(statusCode);
  }
  // 带有非空 provider code，说明错误确实穿过了上游协议层，足以判定为 provider。
  if (params.error.attribution?.providerErrorCode?.trim()) {
    return "provider";
  }

  const message = `${params.displayMessage}\n${params.error.message}`;
  if (ATTACHMENT_INVALID_MESSAGE_PATTERN.test(message)) {
    return "runtime";
  }
  if (CANCELLED_MESSAGE_PATTERN.test(message)) {
    return "runtime";
  }
  // 队列满属于容量问题而非上游拒绝，显式返回空串，让上层保留未知而不误报 provider。
  if (QUEUE_FULL_MESSAGE_PATTERN.test(message)) {
    return "";
  }
  if (
    NETWORK_MESSAGE_PATTERN.test(message) ||
    TIMEOUT_MESSAGE_PATTERN.test(message) ||
    /epipe|certificate|socket/iu.test(message)
  ) {
    return "network";
  }
  if (
    EMPTY_MODEL_RESPONSE_MESSAGE_PATTERN.test(message) ||
    PROVIDER_SERVER_ERROR_MESSAGE_PATTERN.test(message) ||
    PROVIDER_RATE_LIMIT_MESSAGE_PATTERN.test(message) ||
    BALANCE_MESSAGE_PATTERN.test(message) ||
    PLAN_EXPIRED_MESSAGE_PATTERN.test(message) ||
    RATE_LIMIT_MESSAGE_PATTERN.test(message) ||
    CONTEXT_MESSAGE_PATTERN.test(message) ||
    AUTH_MESSAGE_PATTERN.test(message) ||
    OVERLOAD_MESSAGE_PATTERN.test(message) ||
    isQuotaMessage(message) ||
    /provider|model\s+request|upstream/iu.test(message)
  ) {
    return "provider";
  }
  return "";
}

// 归因优先级是本文件的全部设计：越靠前的分支证据越强，越靠后越依赖易误判的文案。
// 顺序不可随意调整，任何提前返回都会让后面更可靠的证据失效。
// [权衡] 长 if 链而不是查表：分支之间有互斥与非对称条件，表驱动反而难以表达先后依赖。
// [失败路径] 调用方可能在错误对象上完全没有 attribution，此时全部分支退化为 code 与文案判定。
export function resolveTelemetryAttribution(params: {
  error: ZCodeUiError;
  displayMessage: string;
}): TelemetryErrorAttribution {
  // 修复原因：adapter 的 unknown 可能是保守的产品运行时分类，不能代表 ARMS 缺少上游证据；
  // 这里仅在 telemetry 边界按 provider code/status/可见文案补全低基数归因，不改变重试或 UI 行为。
  // 显式 source 由适配器在边界处写入，表示调用方已经确认了故障发生的位置。
  // 它只在 resolve 里参与取空合并，不会被任何推断分支提前消费。
  const explicitSource = params.error.attribution?.source;
  const providerId = params.error.attribution?.providerId?.trim();
  // 可信业务码要求同时具备 providerId，否则同一个 code 在不同供应商下语义完全不同。
  // 缺 providerId 时该值为空串，后续只能退回状态码与受控文案证据。
  const trustedProviderBusinessCode = providerId
    ? params.error.attribution?.providerErrorCode?.trim() || params.error.code?.trim() || ""
    : "";
  const trustedProviderReason = resolveTrustedProviderCodeFailureReason({
    providerId: params.error.attribution?.providerId,
    providerErrorCode: params.error.attribution?.providerErrorCode,
    errorCode: params.error.code,
  });
  // 所有返回都经此收敛，保证 errorSource 的取空逻辑只有一份实现。
  // inferredSource 只是默认值，显式 source 存在时永远不参与取值。
  const resolve = (
    failureReason: string,
    inferredSource: TelemetryErrorSource = "",
  ): TelemetryErrorAttribution => ({
    errorSource: explicitSource ?? inferredSource,
    failureReason,
  });
  // 结构化 reason 是适配器给出的半成品分类，空串与 unknown 都视为没有有效分类。
  // 只有它既非空也非 unknown，才会进入下面那条独占的 reason 分支链。
  const structuredReason = params.error.attribution?.reason?.trim();
  const message = `${params.displayMessage}\n${params.error.message}`;
  // transport code 统一大写后比较，避免大小写差异让同一 socket 错误走进不同分支。
  // 取 providerErrorCode 优先于 error.code：前者来自协议层，后者可能被外层改写。
  const transportErrorCode = (
    params.error.attribution?.providerErrorCode ??
    params.error.code ??
    ""
  )
    .trim()
    .toUpperCase();
  // [权衡] 只在 reason 缺失或为 unknown 时才计算传输归因，多一层条件换来不覆写结构化事实。
  // 传输 code 是比文案更硬的证据，因此排在 generic provider 与 reason 分支之前。
  const stableTransportAttribution =
    !structuredReason || structuredReason === UNKNOWN_FAILURE_REASON
      ? resolveStableTransportCodeAttribution(transportErrorCode)
      : undefined;
  // 命中即直接返回：此时 reason 本就没有可信值，不存在覆盖风险。
  if (stableTransportAttribution) {
    // Bug 原因：旧 runner 只按 response boundary 写入 provider source，但 EPIPE 等稳定 socket
    // code 是更强的传输证据；只纠正空/unknown reason，绝不覆盖已有明确结构化归因。
    return stableTransportAttribution;
  }
  // generic 归因额外要求显式 source 为 provider，因为 allowlist code 本身并不携带故障边界。
  // [失败路径] 显式 source 为空时不进入该分支，宁可留 unknown 也不把本地错误记到上游。
  const genericProviderAttribution =
    explicitSource === "provider" &&
    (!structuredReason || structuredReason === UNKNOWN_FAILURE_REASON)
      ? resolveGenericProviderCodeAttribution(params.error.attribution?.providerErrorCode)
      : undefined;
  // 仅消费 allowlist 内的 code，未登记 code 继续下探，避免把供应商私有词表当通用语义。
  if (genericProviderAttribution) {
    // Bug 原因：custom provider 的稳定语义 code 已经是低基数证据，旧逻辑只认识 BAD_REQUEST，
    // 导致 server/network/invalid 等明确失败统一沉入 unknown；这里只消费 allowlist code。
    return genericProviderAttribution;
  }
  // 进入此分支意味着 reason 已经是可信分类，剩下的问题只是把它翻译成 source。
  // 分支内部的优先级是 network、runtime、套餐终态、最后才是通用反查加兜底证据。
  if (structuredReason && structuredReason !== UNKNOWN_FAILURE_REASON) {
    const unambiguousSource = resolveSourceFromReason(structuredReason);
    // response boundary 只能证明调用已进入 provider 链路，不能覆盖更窄的传输与本地边界。
    if (unambiguousSource === "network" || unambiguousSource === "runtime") {
      // Bug 原因：response boundary 只能证明调用已进入 provider 链路，不能覆盖 network/runtime
      // reason 自身携带的更窄边界；否则 EPIPE 和本地 provider 配置错误会被写进 provider 桶。
      return { errorSource: unambiguousSource, failureReason: structuredReason };
    }
    if (
      explicitSource === "provider" &&
      structuredReason === "rate_limited" &&
      params.error.attribution?.retryable === false &&
      trustedProviderReason === "quota_exhausted"
    ) {
      // Bug 原因：adapter 的 reason 同时承担运行时失败分类，终态套餐额度码因此统一落成
      // rate_limited；telemetry 只对可信 builtin + 非重试事实规范为业务根因 quota_exhausted。
      // 适配器把终态额度失败也写成 rate_limited，这里用非重试事实与可信业务 reason 才敢改写。
      // [失败路径] 任一条不满足就落回通用分支保持 rate_limited，避免把可重试限流误报成额度耗尽。
      return { errorSource: "provider", failureReason: "quota_exhausted" };
    }
    // Bug 原因：旧实现先归一化 reason，再把所有非空 reason 统一反推成 provider，
    // 会把 proxy_error/provider_not_configured 等已知事实归错桶。source 必须使用同一份证据解析；
    // invalid_request/rate_limited 等歧义 reason 缺少上游证据时保持空值。
    return resolve(
      structuredReason,
      resolveSourceFromReason(structuredReason) || resolveSourceFromAdditionalEvidence(params),
    );
  }

  if (
    // 旧 transcript 的请求前校验没有 attribution，只剩稳定 code 与 ZCode 自己生成的精确文案。
    // 必须同时满足 code 匹配、无显式 source、文案命中本地校验，才敢判定为 runtime 的 invalid_request。
    params.error.code?.trim() === "invalid_model_request" &&
    !explicitSource &&
    isLocalModelValidationMessage(params.error.message)
  ) {
    // Bug 原因：旧 transcript 的请求前 capability / option 校验只有稳定 code/message，
    // 没有经过 runner 写入 attribution；仅匹配 ZCode 自身生成的精确文案，避免误收 provider 400。
    return { errorSource: "runtime", failureReason: "invalid_request" };
  }

  // legacy envelope 是旧版本持久化的三段式官方错误文案，解析失败时返回空值。
  // [权衡] 只在严格 envelope 命中时恢复事实，宽松匹配会把普通含数字的报错误认成 provider 错误。
  const legacyProviderCode = resolveLegacyProviderEnvelopeCode(
    params.error.code,
    params.error.message,
  );
  const legacyProviderReason = resolveKnownProviderCodeFailureReason(legacyProviderCode);
  if (legacyProviderReason) {
    // Bug 原因：旧 transcript 只持久化了 AiSdkModelAdapterError 的三段式官方错误文案；
    // 严格 envelope + allowlist code 足以恢复低基数事实，但 1234 表示网络失败，不能把
    // provider envelope 的载体来源误当成失败边界，否则会产生 provider/network_error。
    return {
      errorSource: resolveSourceFromReason(legacyProviderReason) || "provider",
      failureReason: legacyProviderReason,
    };
  }

  // 该查表的 code 与上游错误码同域，命中即给出确定来源，不再看状态码。
  // [失败路径] code 为空串时返回 undefined，让后续分支继续，不把空 code 当成未知命中。
  const stableAttribution = STABLE_ERROR_ATTRIBUTION[params.error.code?.trim() ?? ""];
  if (stableAttribution) {
    return resolve(stableAttribution.reason, stableAttribution.source);
  }

  // 修复原因：130x/300x 等业务码是 BigModel/Z.AI 的 provider 局部词表，不能把自定义
  // provider 的同名 code 误归因为套餐到期或配额耗尽；缺少 provider 身份时也只能退回
  // HTTP 状态码/受控文案证据，避免把通用 error.code 当成全局业务码。
  // 可信业务 reason 依赖 providerId 白名单，只对内置供应商的局部词表生效。
  // [权衡] 放在状态码之前，因为 130x/300x 比 HTTP 状态携带更精确的业务含义。
  if (trustedProviderReason) {
    return resolve(trustedProviderReason, "provider");
  }
  if (
    params.error.attribution?.source === "provider" &&
    isGenericProviderInvalidRequestCode(trustedProviderBusinessCode)
  ) {
    return resolve("invalid_request", "provider");
  }

  const statusCode = params.error.attribution?.statusCode;
  if (
    statusCode === 413 &&
    /chat history.{0,80}(?:message limit|too large)|input token.{0,80}(?:exceed|limit)|context.{0,80}(?:exceed|limit)/iu.test(
      message,
    )
  ) {
    return resolve("context_exceeded", "provider");
  }
  // 走到这里说明 413 不是上下文超限，按请求体与附件超限归为参数非法。
  if (statusCode === 413 && /request body|payload limit|attachment|tool input/iu.test(message)) {
    return resolve("invalid_request", "provider");
  }
  if (statusCode === 405) {
    return resolve("invalid_request", "provider");
  }
  if (statusCode === 402 && BALANCE_MESSAGE_PATTERN.test(params.displayMessage)) {
    return resolve("balance_insufficient", "provider");
  }
  if (statusCode === 401 || statusCode === 403) {
    return resolve("auth_failed", "provider");
  }
  // 超时优先归到 network 而不是 provider，否则上游延迟会表现成供应商错误率上升。
  if (statusCode === 408 || statusCode === 504) {
    return { errorSource: "network", failureReason: "timeout" };
  }
  if (statusCode === 429) return resolve("rate_limited", "provider");
  if (statusCode === 404 || statusCode === 410) {
    return resolve("model_not_found", "provider");
  }
  if (statusCode === 400 || statusCode === 422) {
    return resolve("invalid_request", "provider");
  }
  // 用区间兜底而不是枚举 500 与 502，避免上游新增状态码时漏归因而退回 unknown。
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return resolve("server_error", "provider");
  }

  // 受控文案是最弱的结构化证据：它来自已知模板，但仍可能被更早的硬事实推翻。
  // [失败路径] provider 类型的受控归因只在没有显式 source 或显式 source 也是 provider 时才采纳。
  const controlledMessageAttribution = resolveControlledUnknownMessageAttribution(message);
  if (
    controlledMessageAttribution &&
    (controlledMessageAttribution.errorSource !== "provider" ||
      explicitSource === undefined ||
      explicitSource === "provider")
  ) {
    // Bug 原因：受控文案是最低优先级证据；若在 trusted provider code、legacy envelope 或
    // HTTP status 之前返回，弱文案会覆盖 401/1308 等更可靠的结构化事实。
    return controlledMessageAttribution;
  }

  if (EMPTY_MODEL_RESPONSE_MESSAGE_PATTERN.test(message)) {
    return resolve("empty_model_response", "provider");
  }
  if (PROVIDER_REJECTED_MESSAGE_PATTERN.test(message)) {
    return resolve("invalid_request", resolveSourceFromAdditionalEvidence(params));
  }
  if (PROVIDER_SERVER_ERROR_MESSAGE_PATTERN.test(message)) {
    return resolve("server_error", "provider");
  }
  if (PROVIDER_RATE_LIMIT_MESSAGE_PATTERN.test(message)) {
    return resolve("rate_limited", "provider");
  }
  if (ATTACHMENT_INVALID_MESSAGE_PATTERN.test(message)) {
    return resolve("invalid_input", "runtime");
  }
  if (QUEUE_FULL_MESSAGE_PATTERN.test(message)) {
    return resolve("rate_limited");
  }
  if (CANCELLED_MESSAGE_PATTERN.test(message)) {
    return resolve("cancelled", "runtime");
  }
  if (BALANCE_MESSAGE_PATTERN.test(message)) {
    return resolve("balance_insufficient", "provider");
  }
  if (PLAN_EXPIRED_MESSAGE_PATTERN.test(message)) {
    return resolve("plan_expired", "provider");
  }
  if (RATE_LIMIT_MESSAGE_PATTERN.test(message)) {
    return resolve("rate_limited", "provider");
  }
  if (CONTEXT_MESSAGE_PATTERN.test(message)) {
    return resolve("context_exceeded", "provider");
  }
  if (AUTH_MESSAGE_PATTERN.test(message)) {
    return resolve("auth_failed", "provider");
  }
  if (NETWORK_MESSAGE_PATTERN.test(message)) {
    return resolve("network_error", "network");
  }
  if (TIMEOUT_MESSAGE_PATTERN.test(message)) {
    return resolve("timeout", "network");
  }
  if (OVERLOAD_MESSAGE_PATTERN.test(message)) {
    return resolve("provider_overloaded", "provider");
  }
  if (isQuotaMessage(message)) {
    return resolve("quota_exhausted", "provider");
  }
  if (INVALID_REQUEST_MESSAGE_PATTERN.test(message)) {
    return resolve("invalid_request");
  }

  return resolve(
    structuredReason || (params.error.attribution ? UNKNOWN_FAILURE_REASON : ""),
    resolveSourceFromAdditionalEvidence(params),
  );
}
