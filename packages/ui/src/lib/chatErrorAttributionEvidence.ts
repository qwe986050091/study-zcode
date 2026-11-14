// ZCode 聊天错误归因证据层（chatErrorAttributionEvidence）。
// 职责：把 transcript 回放、provider 包装错误以及自定义 provider 的原始错误码与文案，
// 归一化成一组低基数（low-cardinality）的 TelemetryEvidenceAttribution 证据。
// 输出固定两个字段：errorSource 取 provider/runtime/network，failureReason 取受限枚举字符串。
// 本文件只含纯函数与只读查找表，不读时钟、不读环境、不发网络请求，可被任意重入与并发调用。
//
// 不变量清单（每条给出守卫位置与破坏后果）：
// INV-01 错误来源只允许 provider/runtime/network 三值；守卫在 TelemetryEvidenceAttribution 的联合类型上；放宽成 string 会让遥测看板按未预期维度聚合。
// INV-02 每个分支必须原子返回成对的 source 与 reason；守卫是每处 return 的对象字面量；拆开写会产生 provider 配 timeout 这类矛盾组合。
// INV-03 判定顺序即优先级，首个命中即返回；守卫是主函数 if 链的物理顺序；调序会让「cannot connect to api」被更宽松的规则先吞掉。
// INV-04 runtime 只用于本地或宿主侧可修复问题；守卫是三处显式 runtime 分支；误标会把供应商故障算成用户环境问题。
// INV-05 业务码映射仅对受信 provider 生效；守卫在 resolveTrustedProviderCodeFailureReason 的白名单检查；放开后第三方同号会被误读。
// INV-06 providerId 先 trim 再比对，空串视为缺失；守卫是该函数首个 if；去掉 trim 会让带空格的 id 静默失配。
// INV-07 providerErrorCode 优先于 errorCode；守卫是实参处的逻辑或短路；颠倒后通用码会覆盖更精确的上游码。
// INV-08 映射表外的码返回 undefined 而非兜底值；守卫是 Record 索引取值；加兜底会丢失新码的可观测性。
// INV-09 传输层码比较前统一 trim 加大写；守卫在 resolveStableTransportCodeAttribution；漏归一化时小写码退化为未知。
// INV-10 超时码必须先于普通断连码检查；守卫是同函数两个 if 的先后；顺序反了超时会记成 network_error。
// INV-11 通用码比较前统一 trim 加小写；守卫在 resolveGenericProviderCodeAttribution；大小写不一致会让整表失效。
// INV-12 通用码表的键只放 adapter 归一化后的稳定英文词；守卫是表字面量键；塞入原始文案会让匹配依赖上游措辞。
// INV-13 证据不足必须落到末尾的无条件返回；守卫是主函数最后的 return undefined；删掉会造成隐式返回值与类型崩溃。
// INV-14 旧版信封只接受整串匹配；守卫是 LEGACY_PROVIDER_ENVELOPE_PATTERN 的起止锚点与 u 标志；去掉锚点会从长日志里误抓数字。
// INV-15 信封码需与 errorCode 互相印证；守卫在 resolveLegacyProviderEnvelopeCode 末尾三元表达式；放开后任意错误都能借信封提权。
// INV-16 文案匹配一律大小写不敏感且容许跨行；守卫是各正则的 i、u 标志与空白的松散写法。
// INV-17 中文文案用中文字面量直接匹配；守卫是各正则中的中文片段；文案改写后规则需同步，否则归因回落为未知。
// INV-18 并发上限类文案统一映射 rate_limited；守卫是「并发上限」分支；与 provider_overloaded 混淆会让容量告警与用户限流混在同一面板。
// INV-19 余额不足与配额耗尽必须分开；守卫是 balance、budget 两组相邻分支；合并后无法区分充值与提额两种运营动作。
// INV-20 本地校验文案用 trim 后全等匹配；守卫是 isLocalModelValidationMessage；改成模糊匹配会误判供应商同类文案。
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

/**
 * transcript 和 custom provider 的安全 code/message 证据集中在这里判定：
 * 低基数 allowlist，每条规则原子返回同一份证据决定的 source/reason。
 */
export interface TelemetryEvidenceAttribution {
  errorSource: "provider" | "runtime" | "network";
  failureReason: string;
}

// [权衡] 白名单只含四类内置订阅 provider：业务码是厂商自定义编号，
// 同一数字跨厂商含义不同，因此按 providerId 逐家授权，不做全局开启。
// [失败路径] 新厂商忘记登记时业务码全部返回 undefined，归因停在 provider 加 unknown 且不报错。
const PROVIDER_BUSINESS_CODE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
]);

// 业务码到 failureReason 的映射，键为字符串化数字码，值为低基数枚举。
// [权衡] 不做区间推导（例如 13xx 一律配额），因为同段内既有 rate_limited 也有 plan_expired。
// [失败路径] 写成数字键会被 JS 隐式转字符串，运行可用但类型约束失效。
const PROVIDER_CODE_FAILURE_REASONS: Readonly<Record<string, string>> = {
  "1005": "quota_exhausted",
  "1006": "auth_failed",
  "1120": "server_error",
  "1210": "invalid_request",
  "1211": "model_not_found",
  "1214": "model_not_found",
  "1230": "server_error",
  "1234": "network_error",
  "1261": "context_exceeded",
  "1301": "invalid_request",
  "1302": "rate_limited",
  "1303": "rate_limited",
  "1304": "quota_exhausted",
  "1305": "rate_limited",
  "1308": "quota_exhausted",
  "1309": "plan_expired",
  "1310": "quota_exhausted",
  "1311": "plan_access_denied",
  "1312": "provider_overloaded",
  "1313": "quota_exhausted",
  "1314": "quota_exhausted",
  "1315": "quota_exhausted",
  "1316": "quota_exhausted",
  "1317": "quota_exhausted",
  "1318": "quota_exhausted",
  "1319": "quota_exhausted",
  "1320": "quota_exhausted",
  "1321": "quota_exhausted",
  "2007": "server_error",
  "3001": "invalid_request",
  "3002": "rate_limited",
  "3006": "model_not_found",
  "3007": "auth_failed",
  "3008": "rate_limited",
  "3009": "rate_limited",
  "3010": "rate_limited",
  "1213": "invalid_request",
  "3012": "invalid_request",
  "429": "rate_limited",
};

// 该集合只补 BAD_REQUEST 一个码，且仅在上层已认定为 provider 拒绝时使用。
// [失败路径] 若扩展成所有 4xx，限流与鉴权失败都会被压成 invalid_request。
// `GENERIC_PROVIDER_INVALID_REQUEST_CODES` 是模块级 `Set`：构造一次后按哈希命中，不产生每次调用分配。
// provider 包装可能只保留上游业务码，未带 adapter 的标准 reason；
// 这些 code 的拒绝语义有明确证据，只在 telemetry 边界补为低基数 invalid_request。
const GENERIC_PROVIDER_INVALID_REQUEST_CODES = new Set(["BAD_REQUEST"]);

// 本地校验文案的精确集合，措辞由本仓库 adapter 生成，完全可控。
// [权衡] 因此允许全等匹配换取零误判，供应商同类文案不会命中这里。
// [失败路径] adapter 改文案却未同步本集合时归因退回 unknown，需连同测试一起更新。
const LOCAL_MODEL_VALIDATION_MESSAGES = new Set([
  "maxOutputTokens is outside the model option range",
  "reasoningLevel is not supported by the model",
  "Model does not support tool calls",
  "Model does not support structured output",
  "Model does not support image input",
  "Model does not support PDF input",
]);

// 事件可能只持久化 providerErrorCode，错误文案不重复底层 errno；
// allowlist 若只覆盖少量现场样本，ECONNRESET 等 adapter 已确认的网络码会退化成 provider/unknown。
const STABLE_TRANSPORT_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "EADDRINUSE",
  "ENOBUFS",
  "ENOTCONN",
  "UND_ERR_SOCKET",
]);

const STABLE_TRANSPORT_TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ETIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

// adapter 归一化后的通用码映射，键为小写下划线词，值为完整的 source 加 reason 对。
// [失败路径] 重复键会被后者静默覆盖，TS 对象字面量不报错，只能靠评审与搜索发现。
// [权衡] 值用对象而非数组，保证一次查表就拿到不可分割的证据对。
const GENERIC_PROVIDER_CODE_ATTRIBUTION: Readonly<Record<string, TelemetryEvidenceAttribution>> = {
  service_unavailable: { errorSource: "provider", failureReason: "server_error" },
  server_error: { errorSource: "provider", failureReason: "server_error" },
  upstream_server_error: { errorSource: "provider", failureReason: "server_error" },
  upstream_unavailable: { errorSource: "provider", failureReason: "server_error" },
  upstream_not_found: { errorSource: "provider", failureReason: "model_not_found" },
  no_capacity: { errorSource: "provider", failureReason: "provider_overloaded" },
  stream_read_error: { errorSource: "network", failureReason: "network_error" },
  upstream_http2_stream_error: {
    errorSource: "network",
    failureReason: "network_error",
  },
  request_timeout: { errorSource: "network", failureReason: "timeout" },
  gateway_stream_terminated: { errorSource: "network", failureReason: "network_error" },
  invalid_parameter_error: {
    errorSource: "provider",
    failureReason: "invalid_request",
  },
  invalid_tool_call: { errorSource: "provider", failureReason: "invalid_request" },
  invalid_input: { errorSource: "provider", failureReason: "invalid_request" },
  validation_error: { errorSource: "provider", failureReason: "invalid_request" },
  model_capability_not_supported: {
    errorSource: "provider",
    failureReason: "invalid_request",
  },
  cyber_policy: { errorSource: "provider", failureReason: "invalid_request" },
  request_too_large: { errorSource: "provider", failureReason: "invalid_request" },
  chat_history_too_large: {
    errorSource: "provider",
    failureReason: "context_exceeded",
  },
  model_deprecated: { errorSource: "provider", failureReason: "model_not_found" },
  insufficient_balance: {
    errorSource: "provider",
    failureReason: "balance_insufficient",
  },
  quota_limit: { errorSource: "provider", failureReason: "quota_exhausted" },
  internal_server_error: { errorSource: "provider", failureReason: "server_error" },
  err_invalid_url: { errorSource: "runtime", failureReason: "invalid_input" },
};

// 旧版信封解析只匹配整串，拒绝从更长的堆栈里截取片段。
// [失败路径] 中段长度设了上限，超长文案判为不匹配而非截断，避免把请求体写进遥测。
const LEGACY_PROVIDER_ENVELOPE_PATTERN =
  /^\[(\d{3,6})\]\[[^\]\r\n]{1,500}\]\[[^\]\r\n]{4,160}\](?:\s*\(request id: [^)]+\))?$/u;

// [并发] 纯函数，只读模块级 Set，无共享可变状态，多请求并发调用互不影响。
// trim 后比较，行尾空白不影响判定，返回值直接进入上层分支。
export function isLocalModelValidationMessage(message: string): boolean {
  return LOCAL_MODEL_VALIDATION_MESSAGES.has(message.trim());
}

// 传输层 errno 归因入口，入参是未经归一化的原始 code。
// [失败路径] 带前缀的复合码（例如 ERR_SOCKET_CLOSED）不会命中并返回 undefined，
// 由上层继续走文案规则，这是分层的预期回退而不是漏判。
export function resolveStableTransportCodeAttribution(
  code: string,
): TelemetryEvidenceAttribution | undefined {
  const normalizedCode = code.trim().toUpperCase();
  if (STABLE_TRANSPORT_TIMEOUT_ERROR_CODES.has(normalizedCode)) {
    return { errorSource: "network", failureReason: "timeout" };
  }
  if (STABLE_TRANSPORT_ERROR_CODES.has(normalizedCode)) {
    return { errorSource: "network", failureReason: "network_error" };
  }
  return undefined;
}

// 通用 provider 码查表，未知键与 undefined 统一返回 undefined。
// [权衡] 用空串兜底再查表，避免为缺失值单独分支。
export function resolveGenericProviderCodeAttribution(
  code: string | undefined,
): TelemetryEvidenceAttribution | undefined {
  return GENERIC_PROVIDER_CODE_ATTRIBUTION[code?.trim().toLowerCase() ?? ""];
}

// 业务码查表的底层实现，只返回 failureReason，不含 errorSource。
// [权衡] 拆分是为了让调用方决定来源，避免在此硬编码 provider。
export function resolveKnownProviderCodeFailureReason(
  code: string | undefined,
): string | undefined {
  return PROVIDER_CODE_FAILURE_REASONS[code?.trim() ?? ""];
}

// 受信 provider 业务码解析：先验白名单，再取码，最后查表，三步不可交换。
// [失败路径] providerId 缺失时返回 undefined 而非 provider 加 unknown，使上层能区分来源不可信与码未知。
// [并发] 无缓存无 I/O，单次成本为两次 trim 加一次 Set 命中。
export function resolveTrustedProviderCodeFailureReason(params: {
  providerId: string | undefined;
  providerErrorCode: string | undefined;
  errorCode: string | undefined;
}): string | undefined {
  const providerId = params.providerId?.trim();
  if (!providerId || !PROVIDER_BUSINESS_CODE_PROVIDER_IDS.has(providerId)) {
    return undefined;
  }
  return resolveKnownProviderCodeFailureReason(
    params.providerErrorCode?.trim() || params.errorCode?.trim(),
  );
}

// 判断 code 是否属于已登记的通用非法请求码，大小写无关，只做单值判定。
export function isGenericProviderInvalidRequestCode(code: string): boolean {
  return GENERIC_PROVIDER_INVALID_REQUEST_CODES.has(code.trim().toUpperCase());
}

// 从旧版信封文案提取业务码，并要求 errorCode 能与之互相印证。
// [失败路径] errorCode 缺失时只有 AiSdkModelAdapterError 分支能通过，其余返回 undefined。
// [资源] 正则带 u 且无全局标志，exec 不保留 lastIndex，可安全重复调用。
export function resolveLegacyProviderEnvelopeCode(
  errorCode: string | undefined,
  message: string,
): string | undefined {
  const envelopeCode = LEGACY_PROVIDER_ENVELOPE_PATTERN.exec(message.trim())?.[1];
  if (!envelopeCode) return undefined;
  const normalizedErrorCode = errorCode?.trim();
  return normalizedErrorCode === "AiSdkModelAdapterError" || normalizedErrorCode === envelopeCode
    ? envelopeCode
    : undefined;
}

// 宽口径配额文案探测，供上层粗筛，命中不代表可以直接确定 source。
// [失败路径] 只有数字额度而无关键词时不会命中，需依赖业务码分支补齐。
export function isQuotaMessage(message: string): boolean {
  return /quota|usage\s+limit|limit\s+exhausted|exceed(?:ed)?\s+(?:the\s+)?(?:limit|quota)|额度|用量上限|使用量上限|使用上限/iu.test(
    message,
  );
}

// 最后的受控文案兜底，只在 source 与 reason 都有明确证据时才返回。
// [失败路径] 整条 if 链走完仍未命中就返回 undefined，表示有错误但证据不足，由上层决定是否上报 unknown。
// [事务] 每个分支返回新对象字面量，调用方改写返回值不会污染模块级表。
export function resolveControlledUnknownMessageAttribution(
  message: string,
): TelemetryEvidenceAttribution | undefined {
  // 错峰券过期属于本地票据状态问题，归 runtime，它不来自 provider 拒绝。
  // [失败路径] 归到 provider 会把用户引导去联系厂商，而不是重新领券。
  if (/off-peak-ticket-expired/iu.test(message)) {
    return { errorSource: "runtime", failureReason: "offpeak_ticket_expired" };
  }
  if (
    /cannot connect to api:.*(?:self-signed certificate|ssl routines:.*key_usage_bit_incorrect)/iu.test(
      message,
    )
  ) {
    return { errorSource: "network", failureReason: "tls_error" };
  }
  // 空错误体的连接失败说明请求未到达对端，归 network 而非 provider。
  // 该分支必须排在同前缀的 TLS 与 EACCES 规则之后，否则会先被吞掉（见 INV-03）。
  if (/cannot connect to api:\s*(?:\n|$)/iu.test(message)) {
    return { errorSource: "network", failureReason: "network_error" };
  }
  if (/cannot connect to api:.*(?:connect|write|read)\s+eacces/iu.test(message)) {
    return { errorSource: "network", failureReason: "network_error" };
  }
  if (
    // [并发] 流式中断规则集中于此：DNS 失败、缺终止标记、响应截断与中文流式失败共用出口。
    // 只有「上游流式响应长时间无数据」升级为 stream_idle_timeout，其余归 network_error。
    // [失败路径] 新增流中断类型放错到后面 server_error 段，会被误判成供应商故障。
    /cannot connect to api:.*getaddrinfo\s+(?:enoent|ebusy|eai_again|enotfound)/iu.test(message) ||
    /upstream stream (?:ended|disconnected|terminated|closed).*(?:without a terminal marker|before terminal|before completion|unexpected eof|before \[done\])/iu.test(
      message,
    ) ||
    /upstream truncated response without stop reason/iu.test(message) ||
    /server disconnected without sending a response/iu.test(message) ||
    /responses\s+流式调用失败/iu.test(message) ||
    /codex responses websocket stream error/iu.test(message) ||
    /engine protocol predict request failed:\s*fetch failed/iu.test(message) ||
    /the model provider encountered a streaming error/iu.test(message) ||
    /上游流式响应长时间无数据/iu.test(message) ||
    /(?:^|\n)stream_read_error(?:\n|$)/iu.test(message)
  ) {
    return {
      errorSource: "network",
      failureReason: /长时间无数据/iu.test(message) ? "stream_idle_timeout" : "network_error",
    };
  }
  if (
    // 有明确停顿时长证据时直接判定 stream_idle_timeout，与上一条形成兼容双保险。
    /model stream stalled:\s*no event received for \d+ms|codebuddy cli produced no stream output for \d+ms/iu.test(
      message,
    )
  ) {
    return { errorSource: "network", failureReason: "stream_idle_timeout" };
  }
  // 套餐权限不足：文案很长且可能夹带链接，用有限跨度避免跨段误匹配。
  // [失败路径] 跨度放得过宽会把后续无关段落里的 plan limited 也算命中。
  if (/user is not allowed to access.{0,160}(?:action plan limited|plan limited)/iu.test(message)) {
    return { errorSource: "provider", failureReason: "plan_access_denied" };
  }
  // 授权缺失与下面的 forbidden 分成两条，因为两者对应的运营动作不同。
  // 归 provider 的 auth_failed：凭证由 provider 侧签发，不是本地配置问题。
  if (/authorization not found/iu.test(message)) {
    return { errorSource: "provider", failureReason: "auth_failed" };
  }
  if (
    /upstream access forbidden|do not have access to (?:this|the requested) resource/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "auth_failed" };
  }
  if (
    /auth_unavailable:\s*no auth available|model provider is missing an api key/iu.test(message)
  ) {
    return { errorSource: "runtime", failureReason: "provider_not_configured" };
  }
  if (
    // 请求体与工具调用类拒绝统一归 invalid_request，理由是对端明确判定请求不合法。
    // [失败路径] 此段与 server_error 段相邻，新增规则插错位置会改变优先级（见 INV-03）。
    /failed to deserialize the json body.*(?:unknown variant|expected)/iu.test(message) ||
    /field\s+reasoningeffort\s+invalid/iu.test(message) ||
    /function call is not supported for this model/iu.test(message) ||
    /model is not a vlm/iu.test(message) ||
    /engine protocol predict request returned 400:.*(?:invalid_request_error|failed to parse grammar)/iu.test(
      message,
    ) ||
    /model returned invalid tool input/iu.test(message) ||
    /failed to generate a valid tool call/iu.test(message) ||
    /model rejected this request.*(?:input|parameter)/iu.test(message) ||
    /tool call id.*must be/iu.test(message) ||
    /litellm\.badrequesterror:.*invalid_request_error/iu.test(message) ||
    /media item count was exceeded/iu.test(message) ||
    /残缺、非法或不存在的工具调用/iu.test(message)
  ) {
    return { errorSource: "provider", failureReason: "invalid_request" };
  }
  if (
    // 供应商侧 5xx、崩溃与内部错误归 provider 的 server_error，与 network 断流严格区分。
    // [权衡] 中英文同义提示并列覆盖，避免只命中一种语言导致漏判。
    /upstream service temporarily unavailable|model service is temporarily unavailable|the service is temporarily unavailable/iu.test(
      message,
    ) ||
    /服务暂时不可用/iu.test(message) ||
    /责任方[:：]服务端/iu.test(message) ||
    /the model has crashed/iu.test(message) ||
    /fatal exception in the backend generation thread/iu.test(message) ||
    /\[500\]\[操作失败\]/iu.test(message) ||
    /502\s+服务响应内容异常/iu.test(message) ||
    /流式推理过程中发生内部错误/iu.test(message) ||
    /a server error occurred/iu.test(message) ||
    /engine protocol predict stream returned an error:.*(?:"code":500|"type":"server_error"|errordevicelost)/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "server_error" };
  }
  // 容量不足归 provider_overloaded，与 rate_limited 分开：前者是全局容量，后者是单用户频率。
  // [失败路径] 合并后扩容决策会失去数据支撑。
  if (/\bat capacity\b|high demand.{0,120}capacity|no capacity/iu.test(message)) {
    return { errorSource: "provider", failureReason: "provider_overloaded" };
  }
  if (/业务申请资源不足.*申请扩容/iu.test(message)) {
    return { errorSource: "provider", failureReason: "provider_overloaded" };
  }
  if (/请求过于频繁/iu.test(message)) {
    return { errorSource: "provider", failureReason: "rate_limited" };
  }
  if (
    // 单会话并发与并发上限都映射为 rate_limited（见 INV-18）。
    // [并发] 这类错误常在客户端批量重试时成簇出现，归因稳定才能做退避统计。
    /session\s+[^\s]+\s+is already in flight|并发(?:数)?(?:已)?达到上限|并发上限/iu.test(message)
  ) {
    return { errorSource: "provider", failureReason: "rate_limited" };
  }
  // 凭证冷却期也是频率闸门的一种，与 rate_limited 同归，提示用户稍后重试。
  if (/credentials?.*cooling down/iu.test(message)) {
    return { errorSource: "provider", failureReason: "rate_limited" };
  }
  if (
    // 余额与欠费类文案归 balance_insufficient，与配额耗尽分开（见 INV-19）。
    // [失败路径] 归错会让用户反复重试而不是去充值。
    /balance greater than \$?0|account.*in arrears|top up the account|failure to pay past invoices|credit已耗尽|balance_depleted|福利版模型.*需先充值/iu.test(
      message,
    )
  ) {
    return { errorSource: "provider", failureReason: "balance_insufficient" };
  }
  if (/budget has been exceeded|预算已用尽|daily cost limit reached/iu.test(message)) {
    return { errorSource: "provider", failureReason: "quota_exhausted" };
  }
  if (/"type":"notfounderror".*model.*does not exist/iu.test(message)) {
    return { errorSource: "provider", failureReason: "model_not_found" };
  }
  // 上下文超限仅在中文提示出现时兜底，英文侧依赖业务码 1261 与通用码 chat_history_too_large。
  if (/达到对话长度上限/iu.test(message)) {
    return { errorSource: "provider", failureReason: "context_exceeded" };
  }
  if (/没有可用套餐.*(?:订购|续费)|暂无生效套餐.*激活订阅/iu.test(message)) {
    return { errorSource: "provider", failureReason: "plan_access_denied" };
  }
  if (/无api调用权限.*未订阅.*(?:codeplan|资源包)/iu.test(message)) {
    return { errorSource: "provider", failureReason: "plan_access_denied" };
  }
  // 穷尽所有受控规则仍未命中：显式返回 undefined，表示证据不足而非「没有错误」。
  // [失败路径] 调用方必须区分 undefined 与具体 reason，否则未知错误会被计入成功路径。
  // 这是 INV-13 的守卫点，也是本文件唯一的总兜底出口。
  // [权衡] 宁可漏报也不臆造 reason，未知错误由上层单独计数并人工归因。
  return undefined;
}
