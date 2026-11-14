// INV-01 每个业务码只投影成一个稳定的分类四元组，映射建立后不再被任何调用方改写；守住位置：PROVIDER_BUSINESS_CODE_MAPPINGS 与 getProviderBusinessCodeMapping；改错故障：同一码在不同轮次得到不同重试决策，用户看到重试次数抖动。
// INV-02 只有明确可恢复的码才置 retryable=true，配额耗尽、权限不足、并发上限必须显式写 false；守住位置：四个模板常量及各表项的 retryable 字段；改错故障：终止型错误掉进通用 429 重试分支，额度耗尽后无限重试刷屏。
// INV-03 reason 与 retryReason 来自语义判断而非 HTTP 状态码；守住位置：各映射项的 reason 与 retryReason 字段；改错故障：界面提示网络错误而实际是配额耗尽，用户误判为线路问题。
// INV-04 未知码一律返回 undefined，绝不回落到某个默认映射；守住位置：查表函数的唯一 return 语句；改错故障：provider 新增码被默认当作可重试，产生静默重试风暴。
// INV-05 查表是区分大小写的精确匹配，只有网络分支才做小写归一化；守住位置：表键定义与局部变量 normalizedCode；改错故障：既误杀 rate_limit_error 这类码，也误救本应终止的业务拒绝。
// INV-06 网络业务码的识别顺序先于响应体兜底，分支次序不可交换；守住位置：isRetryableProviderBusinessNetworkFailure 的条件链；改错故障：被包进 providerCode 的 ECONNRESET 降级为未知码，不再重试。
// INV-07 1234 与 network_error、network_error_retryable 等价于传输层断连；守住位置：PROVIDER_NETWORK_BUSINESS_CODES 集合与 normalizedCode 判断；改错故障：可恢复断连被当成业务拒绝，用户需手动重发。
// INV-08 响应体兜底必须先通过 error.type 恰为 api_error 的闸门；守住位置：isProviderBusinessInternalNetworkFailure 的首个判断；改错故障：任意含内部网络错误文案的业务拒绝被误判为可重试。
// INV-09 文案取值按 providerMessage、message、响应体 message 的顺序取首个非空；守住位置：normalizedMessage 的空值合并链；改错故障：优先字段存在但无关时兜底永不命中，或反之误命中。
// INV-10 文案归一化统一去空白并转小写，空串视为缺失；守住位置：normalizeProviderMessage；改错故障：大小写或空白差异导致固定文案集合匹配失败。
// INV-11 超时判定完全委托通用 isTimeoutFailure，不叠加业务码特判；守住位置：isRetryableProviderBusinessTimeoutFailure 的返回语句；改错故障：headers 或 body 超时被业务码短路成终态。
// INV-12 状态码取值顺序为显式入参、错误自带 statusCode、错误自带 responseStatus；守住位置：isRetryableProviderBusinessTimeoutFailure 的空值合并链；改错故障：调用方给出的权威状态码被忽略，超时判定随之漂移。
// INV-13 响应体摘要的链式读取必须容忍 null 与原始类型；守住位置：asRecord 的宽化逻辑；改错故障：畸形响应体抛出类型错误，错误分类本身变成新的崩溃面。
// INV-14 读取 error.type 时归一化，读取 error.message 时保留原始大小写；守住位置：readResponseBodyErrorType 与 readResponseBodyErrorMessage；改错故障：匹配所需的大小写信息被破坏，或日志丢失原始文案。
// INV-15 四个映射模板是模块级只读单例，批量注册只引用不复制；守住位置：TERMINAL 与 RETRYABLE 系列常量及各处注册循环；改错故障：某处就地修改污染其他码的 retryable 判决。
// INV-16 同一码重复注册以最后一次写入为准，重复项必须语义等价；守住位置：各注册循环的写入顺序；改错故障：后写静默覆盖前写，重试语义在无人察觉时改变。
// INV-17 表键一律是字符串，数字码由调用方先转换；守住位置：映射表的键类型与查表入参；改错故障：数字 500 与字符串 500 查不到同一项，终止语义失效。
// INV-18 所有对外判定在不适配时返回 undefined 或 false，而不是抛错；守住位置：三个导出函数的返回类型；改错故障：上游被迫包裹异常处理，错误路径被吞掉或直接崩溃。
//
// 模块职责：把各 provider 的业务码字符串投影成 code、reason、retryReason、retryable 四元组，是自动重试决策的唯一业务码真相源。
// 状态所有权：映射表与四个模板常量均为模块加载期构建的只读单例，调用方只读不写，也不得缓存后自行改字段。
// 阅读顺序：先看接口与四个模板常量，再看主码表的分组注释与批量注册，最后看三个导出判定函数及其私有兜底。
// ============================================================
// Provider 业务码 → 失败分类映射表
// 定位：各 provider（BigModel/Zhipu/OpenAI-compatible）用业务码表达错误，本表把它们统一投影成
// code / reason / retryReason / retryable，是"是否自动重试"的唯一业务码真相源。
// 输入：providerCode 字符串（数字码已由调用方转字符串）。输出：映射项或 undefined（未知码走通用分类）。
// 副作用：模块加载期构建 Map（只读）。失败语义：查不到即 undefined，绝不猜测或抛错。
// 不变量：只有明确可恢复的码才 retryable=true；配额耗尽、权限、并发上限等终止语义必须显式入表，
// 否则会掉进通用 429 重试分支被无限重试。
// ============================================================

import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason as ModelRetryReasonValue,
  type ModelErrorCode as ModelErrorCodeType,
  type ModelFailureReason,
  type ModelRetryReason,
} from "@zcode/contracts";
import { isNetworkFailure, isTimeoutFailure } from "./failure-inspection.js";
import type { ProviderBusinessError } from "./model-execution.js";

/** 单个业务码的完整分类结果；message 可选，用于覆盖默认展示文案。 */
// 字段契约：code 决定上层错误分类与展示文案，message 仅在需要覆盖默认文案时出现。
// reason 供策略表与界面展示使用，retryReason 只在 retryable 为 true 时有实际意义，但类型上始终必填。
// retryable 是终态判决位，某个码一旦显式写 false，任何 HTTP 状态码都不能把它翻回可重试。
// 结构里刻意不含 providerCode 字段，避免映射项反向依赖查表键而形成双真相源。
interface ProviderBusinessCodeMapping {
  /** 对外稳定错误码（ModelErrorCode）。 */
  code: ModelErrorCodeType;
  /** 可选自定义文案；缺省时由上层按 code 生成。 */
  message?: string;
  /** 失败原因分类（用于策略表/UI）。 */
  reason: ModelFailureReason;
  /** 若可重试，重试原因用于状态事件与退避提示。 */
  retryReason: ModelRetryReason;
  /** 是否自动重试；false 表示终态（即使 HTTP 状态看似可重试）。 */
  retryable: boolean;
}

// 部分 OpenAI-compatible provider 会把可恢复的上游网络故障包装成业务码。
// 该集合只收纳被 provider 包装成业务码的上游网络故障码，目前仅 BigModel 的 1234。
// 新增成员前必须确认底层语义确为传输层断连，否则会把真实业务拒绝变成可重试。
const PROVIDER_NETWORK_BUSINESS_CODES = new Set(["1234"]);
const PROVIDER_INTERNAL_NETWORK_MESSAGES = new Set([
  "500 internal network error",
  "internal network error",
  "internal network failure",
]);

// 终止型限流模板：对外仍是速率受限错误码，但 retryable 固定为 false，用于配额耗尽与并发上限。
// retryReason 依旧保留限流原因，让界面能区分被限流与请求非法，同时不触发自动重试。
// [权衡] 配额耗尽更接近额度不足，但沿用 ModelRateLimited 能直接复用前端已有的升级引导分支，不需要前端再加分支。
const TERMINAL_RATE_LIMIT_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRateLimited,
  reason: ModelFailureReasonValue.RateLimited,
  retryReason: ModelRetryReasonValue.RateLimited,
  retryable: false,
};
// 终止型业务模板：原因记为未知、重试原因记为网络错误，但 retryable 为 false。
// 此处的重试原因不承担重试含义，只是复用既有展示枚举的最小可用值，读代码时不要反推。
// [权衡] 没有新增原因枚举，代价是界面无法从原因字段直接看出具体业务动因。
const TERMINAL_BUSINESS_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRequestFailed,
  reason: ModelFailureReasonValue.Unknown,
  retryReason: ModelRetryReasonValue.NetworkError,
  retryable: false,
};
const RETRYABLE_RATE_LIMIT_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRateLimited,
  reason: ModelFailureReasonValue.RateLimited,
  retryReason: ModelRetryReasonValue.RateLimited,
  retryable: true,
};
// 可重试过载模板：provider 明确表示上游过载，退避后重试收益最高。
// 它与终止型模板只差 retryable 一位，复制粘贴时最易改错，评审需逐字段比对。
const RETRYABLE_OVERLOAD_MAPPING: ProviderBusinessCodeMapping = {
  code: ModelErrorCode.ModelRequestFailed,
  reason: ModelFailureReasonValue.ProviderOverloaded,
  retryReason: ModelRetryReasonValue.ProviderOverloaded,
  retryable: true,
};

// 主码表是模块内唯一写入点：先由字面量初始化，再由后续循环批量补齐稀疏的码。
// 键刻意保持字符串，数字码由调用方转换后再查，避免数字与字符串两种键分叉。
// PROVIDER_BUSINESS_CODE_MAPPINGS 的字面量段按语义分组（服务端错误 / 鉴权与配额 / 并发上限 / 恢复类 / 终止类），顺序不会影响后续循环补齐。
// [失败路径] 同一键重复出现不会报错，后者静默覆盖前者，新增码前必须先全局搜索该键。
const PROVIDER_BUSINESS_CODE_MAPPINGS = new Map<string, ProviderBusinessCodeMapping>([
  [
    // 500 作为业务码时按服务端错误处理并允许重试，与 HTTP 500 的通用策略保持一致。
    // 500 不进入 TERMINAL_BUSINESS_MAPPING，因为上游服务端错误多为瞬时故障，重试成本低于误判终态。
    // 若将来某 provider 用 500 表达配额耗尽，必须就地改成终止模板，不能依赖通用兜底。
    "500",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1006",
    {
      code: ModelErrorCode.ProviderNotConfigured,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
    },
  ],
  [
    "1005",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "3006",
    {
      code: ModelErrorCode.ModelNotFound,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "3001",
    {
      code: ModelErrorCode.InvalidModelRequest,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    // 3007 归为鉴权失败而非参数非法，说明该码表达的是凭证或权限问题。
    // 它与 1006 一样不可重试，区别在错误码：1006 提示未配置，3007 提示请求无效。
    "3007",
    {
      code: ModelErrorCode.InvalidModelRequest,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
    },
  ],
  // 3008/3009/3010：并发上限，与配额耗尽 1005 类似但不走 refresh-quota，而是走升级横幅。
  [
    "3008",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "3009",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  // 3010：当前模型并发上限。保留为非自动重试的 rate limited，由 UI 引导切换模型或升级。
  [
    // 3010 是当前模型并发上限，即使等待也可能立刻再次失败，因此不做自动重试。
    // 三字段必须同时成立：code=ModelRateLimited、retryReason=RateLimited、retryable=false，缺一项就退回可重试路径。
    // [失败路径] 若误改为可重试，并发打满时重试之间会互相加剧拥塞，形成自激。
    "3010",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  // BigModel 文档里的恢复类错误需要显式入表；同时把 1261 标成超窗，
  // 长期配额、套餐权限、公平使用限制和 provider 明确终止型业务码则显式终止，避免 generic 429 兜底误重试。
  [
    "1120",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1230",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
  [
    "1234",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
    },
  ],
  [
    "1261",
    {
      code: ModelErrorCode.ModelContextExceeded,
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    // 1113、1309、1311 这类终止码的重试原因仍写网络错误，只是为了满足必填字段。
    // 是否重试只看 retryable，不要从重试原因反推，否则会得出相反结论。
    // 这三类码没有明确的可恢复语义，宁可快速失败，把原始信息完整交给用户判断。
    "1113",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1302",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1303",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1305",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "1304",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1308",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1309",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1310",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "1311",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
    },
  ],
  [
    "1312",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ProviderOverloaded,
      retryReason: ModelRetryReasonValue.ProviderOverloaded,
      retryable: true,
    },
  ],
  [
    "1313",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
    },
  ],
  [
    "3002",
    {
      code: ModelErrorCode.ModelRateLimited,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
    },
  ],
  [
    "2007",
    {
      code: ModelErrorCode.ModelRequestFailed,
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
    },
  ],
]);

// 这些 code 均来自 provider 官方文档，且语义需要用户充值、调整套餐或等待长期额度重置。
// 只消费 AI SDK / 既有 ProviderBusinessError 已暴露的 code，不在这里解析厂商原始 response 字段。
// insufficient_quota 曾落入通用 429 重试；其终止语义不能再依赖 Retry-After 时长。
// 这一段用循环批量注册终止型限流码，码值全部来自各 provider 官方文档。
// 列表里字符串码与数字码混排，因为表键统一为字符串，注册方式无需区分类型。
// [权衡] 用循环替代重复字面量，减少手抄字段错误，代价是码值与语义不再就地相邻。
for (const code of [
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
  "2056",
  "20097",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, TERMINAL_RATE_LIMIT_MAPPING);
}

for (const code of ["1008", "1314", "1315"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, TERMINAL_BUSINESS_MAPPING);
}

// rate_limit_reached_error 与 rate_limit_error 表达可恢复的瞬时限流，允许退避重试。
// 与终止型限流只差模板选择，命名相近而语义相反，改动时必须对照相邻注释。
for (const code of ["rate_limit_reached_error", "rate_limit_error"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, RETRYABLE_RATE_LIMIT_MAPPING);
}

for (const code of ["engine_overloaded_error", "overloaded_error"]) {
  PROVIDER_BUSINESS_CODE_MAPPINGS.set(code, RETRYABLE_OVERLOAD_MAPPING);
}

/** 按 providerCode 精确查表；返回 undefined 表示未知业务码，调用方应走通用分类而非默认重试。 */
// 导出面只暴露查表与两个可重试判定，码表本身不对外，防止调用方绕过投影直接读字段。
// 返回类型显式包含 undefined，强制调用方处理未知码分支，而不是假定总能取到映射。
// 该函数是纯查表，无 I O、无缓存、无副作用，可在任意上下文同步调用。
export function getProviderBusinessCodeMapping(
  providerCode: string,
): ProviderBusinessCodeMapping | undefined {
  return PROVIDER_BUSINESS_CODE_MAPPINGS.get(providerCode);
}

/**
 * 判断被包装成业务错误的网络故障是否仍应重试：依次检查 providerCode 是否本身是网络错误码、
 * 是否属于少数 provider 的网络业务码（如 1234）、是否 network_error(_retryable)，
 * 最后回退到响应体 error.type=api_error 且 message 命中内部网络错误集合的情形。
 * 全部不中返回 false，避免把真实业务拒绝误当断连重试。
 */
export function isRetryableProviderBusinessNetworkFailure(
  error: ProviderBusinessError,
  providerCode: string | undefined,
): boolean {
  if (providerCode) {
    // AI SDK 的 SSE error chunk 会把底层 ECONNRESET 包进 ProviderBusinessError.providerCode。
    // 这本质仍是传输层断连，必须沿用网络错误重试语义，而不是落成 unknown。
    if (isNetworkFailure(providerCode)) {
      return true;
    }
    if (PROVIDER_NETWORK_BUSINESS_CODES.has(providerCode)) {
      return true;
    }

    const normalizedCode = providerCode.toLowerCase();
    if (normalizedCode === "network_error" || normalizedCode === "network_error_retryable") {
      return true;
    }
  }

  return isProviderBusinessInternalNetworkFailure(error);
}

/**
 * 判断被包装成业务错误的超时是否仍应重试：直接复用通用 isTimeoutFailure，
 * statusCode 优先用调用方显式值，其次 error 自带 statusCode/responseStatus。
 * 这里不做业务码特判，因为超时语义与 provider 业务无关。
 */
// 超时判定完全委托通用超时检查，本模块只负责补齐状态码来源。
// 这里不做业务码特判，因为超时是传输层语义，与 provider 用什么码表达无关。
// [权衡] 委托让行为与其他链路一致，代价是无法针对单个 provider 调优判定细节。
export function isRetryableProviderBusinessTimeoutFailure(
  error: ProviderBusinessError,
  providerCode: string | undefined,
  statusCode?: number,
): boolean {
  // AI SDK/SSE error chunk 可能把底层 headers/body timeout 包进 ProviderBusinessError.providerCode。
  // 这类错误没有真正的 provider 业务语义，必须保留普通 timeout 的可重试语义。
  return isTimeoutFailure(
    error,
    providerCode,
    statusCode ?? error.statusCode ?? error.responseStatus,
  );
}

/**
 * 兜底识别"内部网络错误"：响应体 error.type 必须恰为 api_error，
 * 且 providerMessage/message/响应体 message 任一归一化后命中固定文案集合。
 */
// 兜底判定的第一道闸门是响应体 error.type 必须恰为 api_error，否则直接返回 false。
// 第二道是文案命中固定集合，两者同时成立才算内部网络错误，宁可漏判也不误判。
// 取文案时按 providerMessage、message、响应体 message 的顺序取第一个非空值。
function isProviderBusinessInternalNetworkFailure(error: ProviderBusinessError): boolean {
  if (readResponseBodyErrorType(error.responseBodySummary) !== "api_error") {
    return false;
  }

  const normalizedMessage =
    normalizeProviderMessage(error.providerMessage) ??
    normalizeProviderMessage(error.message) ??
    normalizeProviderMessage(readResponseBodyErrorMessage(error.responseBodySummary));
  // 空值降级：三段文案全为空时返回 false，不把没有信息当成网络错误。
  // 该函数只做只读判断，不修改错误对象，也不缓存归一化结果。
  return normalizedMessage ? PROVIDER_INTERNAL_NETWORK_MESSAGES.has(normalizedMessage) : false;
}

/** 读取 responseBodySummary.error.type 并归一化；缺失/非字符串返回 undefined。 */
function readResponseBodyErrorType(summary: unknown): string | undefined {
  return normalizeProviderMessage(asRecord(asRecord(summary).error).type);
}

/** 读取 responseBodySummary.error.message（保留原大小写，供日志/兜底匹配）。 */
function readResponseBodyErrorMessage(summary: unknown): string | undefined {
  return stringValue(asRecord(asRecord(summary).error).message);
}

function normalizeProviderMessage(value: unknown): string | undefined {
  const text = stringValue(value)?.trim().toLowerCase();
  return text && text.length > 0 ? text : undefined;
}

/** 只保留非空字符串（不改大小写，供展示）；非字符串返回 undefined。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 宽化为可索引对象：null/原始类型返回空对象，保证链式读取安全（数组仍按对象看待）。 */
// 宽化读取：null 与原始类型统一返回空对象，保证后续属性访问永不抛错。
// 数组仍按对象处理，因为数组上没有 error 字段，读取结果自然是 undefined。
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
