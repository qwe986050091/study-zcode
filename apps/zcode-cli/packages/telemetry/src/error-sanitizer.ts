// INV-01 类型标识只允许安全字符：守住位置 标识清洗；改错故障 上报字段被注入换行。
// INV-02 类型缺失有固定兜底：守住位置 空值合并链；改错故障 出现空类型无法聚合。
// INV-03 原因只在有独立嵌套时产出：守住位置 链长度判断；改错故障 同一条错误被记两遍。
// INV-04 链长有硬上限：守住位置 深度循环；改错故障 环状 cause 让进程卡死。
// INV-05 认领覆盖整条链：守住位置 逐对象登记；改错故障 父层重复记录同一正文。
// INV-06 认领不延长生命周期：守住位置 弱引用集合；改错故障 错误对象无法回收。
// INV-07 首次认领就返回清洗结果：守住位置 早退分支；改错故障 上游拿不到任何错误信息。
// INV-08 正文先截断再清洗：守住位置 切片顺序；改错故障 超长响应耗尽处理器时间。
// INV-09 URL 只留主机与清洗路径：守住位置 地址重建；改错故障 查询参数里的令牌外泄。
// INV-10 认证头统一抹除：守住位置 请求头规则；改错故障 Bearer 令牌进入日志。
// INV-11 查询参数里的密钥同样抹除：守住位置 参数规则；改错故障 api key 明文上报。
// INV-12 常见密钥前缀单独识别：守住位置 前缀匹配；改错故障 云厂商密钥漏网。
// INV-13 邮箱与本地路径去标识：守住位置 两条替换；改错故障 用户目录与账号外泄。
// INV-14 控制字符压成空白：守住位置 末段替换；改错故障 日志出现不可见字符。
// INV-15 正文最终仍有长度上限：守住位置 返回前切片；改错故障 单条事件撑爆上报。
// INV-16 空正文返回缺失：守住位置 空串归一；改错故障 出现空消息字段。
// INV-17 错误码只去噪不做白名单：守住位置 控制字符清洗；改错故障 业务错误码被丢弃。
// INV-18 非对象输入安全降级：守住位置 记录归一；改错故障 原始值读取属性时崩溃。
//
// 模块职责：把任意异常压成可上报的最小错误描述，并避免同一错误重复记账。
// 状态所有权：仅认领集合是模块级状态，且为弱引用不持有业务对象。
// 阅读顺序：先看主清洗入口，再看正文规则链，最后看对象链与各字段清洗。
const MAX_ERROR_MESSAGE_CHARS = 2_048;
const MAX_ERROR_CHAIN_DEPTH = 8;
const claimedErrorObjects = new WeakSet<object>();

export interface SanitizedTelemetryError {
  cause?: {
    code?: string;
    message?: string;
    type: string;
  };
  code?: string;
  message?: string;
  type: string;
}

// type 先取 record.type，再退回 record.name 与 error.name。
// sanitizeErrorIdentifier 只放行安全字符并限制长度。
// code 与 message 分别清洗，互不覆盖。
// cause 链上没有独立嵌套对象时不产出 reason 字段。
// 返回值只带 code/message/type 中实际存在的字段。
export function sanitizeTelemetryError(error: unknown): SanitizedTelemetryError {
  const record = objectRecord(error);
  const type =
    sanitizeErrorIdentifier(
      stringValue(record.type) ??
        stringValue(record.name) ??
        (error instanceof Error ? error.name : undefined),
    ) ?? "UnknownError";
  const code = sanitizeErrorCode(stringValue(record.code));
  const message = sanitizeErrorMessage(
    error instanceof Error ? error.message : stringValue(record.message),
  );
  const chain = errorObjectChain(error);
  // 修复原因：链包含输入本身；没有独立嵌套对象时不能把同一个错误重复登记为 cause。
  const cause = chain.length > 1 ? sanitizeCause(chain[chain.length - 1]!) : undefined;
  return {
    ...(cause ? { cause } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    type,
  };
}

/**
 * 同一个源异常会沿 Attempt -> Call -> Step -> Turn 冒泡。错误正文只应记录在最靠近
 * 来源、最先认领它的 Span；父层继续记录 outcome/failure_stage，但不复制同一份正文。
 *
 * 包装错误的 cause 链也参与认领：AdapterError(cause=ProviderError) 不会在上层重新覆盖
 * Provider Attempt 已记录的原始错误。WeakSet 不延长异常对象生命周期。
 */
export function claimSanitizedTelemetryError(error: unknown): SanitizedTelemetryError | undefined {
  const objects = errorObjectChain(error);
  if (objects.length === 0) return sanitizeTelemetryError(error);
  const alreadyClaimed = objects.some((candidate) => claimedErrorObjects.has(candidate));
  for (const candidate of objects) claimedErrorObjects.add(candidate);
  return alreadyClaimed ? undefined : sanitizeTelemetryError(error);
}

// sanitizeErrorMessage 先做 4 KiB 有界截断，再跑正则清洗。
// URL 只保留协议、主机与清洗后的路径。
// Authorization 头与查询参数统一替换为占位符。
// 密钥按 sk/rk/pk、ghp、AKIA、AIza 前缀正则识别并替换为 {secret}。
// 控制字符与连续空白最后压平成单空格（trim）。
export function sanitizeErrorMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // 错误可能携带整段响应正文；先做有界截断再正则清洗，避免 Telemetry 为恶意或异常
  // Provider 消息承担无界 CPU/内存成本。
  const sanitized = value
    .slice(0, 4_096)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, sanitizeUrl)
    .replace(
      /(\bauthorization\b["']?\s*[:=])\s*(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session|x-arms-license-key)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session|x-arms-license-key)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}")
    .replace(/\b[A-Za-z0-9]{4,32}@[0-9a-f]{12,}\b/giu, "{secret}")
    .replace(/\b[^/@\s]+@[^/@\s]+\.[^/@\s]+\b/gu, "{email}")
    .replace(
      /\/(?:Users|home|root|workspace|workspaces|Volumes)\/[^/\s]+(?:\/[^\s:;,)\]}]+)*/gu,
      "/{path}",
    )
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:;,)\]}]+/gu, "/{path}")
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s:;,)\]}]+)*/gu, "{path}")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.slice(0, MAX_ERROR_MESSAGE_CHARS) || undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// errorObjectChain 只接受对象，数组与原始值不入链。
// 深度上限为 MAX_ERROR_CHAIN_DEPTH，防止环形引用。
// 见过的对象记入 seen，不再重复入链。
// 嵌套字段按 cause、adapterError、error 的顺序取第一个可用对象，由 find 返回。
// claimedErrorObjects 的认领机制与这里共用同一条链。
function errorObjectChain(error: unknown): object[] {
  const result: object[] = [];
  const seen = new Set<object>();
  let current = error;
  for (
    let depth = 0;
    depth < MAX_ERROR_CHAIN_DEPTH && current && typeof current === "object";
    depth += 1
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    result.push(current);
    const record = current as Record<string, unknown>;
    // 部分流包装器使用 adapterError/error；沿单条优先链复用同一认领机制，避免父 Span 重复记录。
    current = [record.cause, record.adapterError, record.error].find(
      (nested) => nested && typeof nested === "object",
    );
  }
  return result;
}

function sanitizeCause(record: object): SanitizedTelemetryError["cause"] | undefined {
  const value = record as Record<string, unknown>;
  const type = sanitizeErrorIdentifier(stringValue(value.type) ?? stringValue(value.name));
  const code = sanitizeErrorCode(stringValue(value.code));
  const message = sanitizeErrorMessage(stringValue(value.message));
  if (!type && !code && !message) return undefined;
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    type: type ?? "UnknownError",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeErrorIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value.trim().slice(0, 128);
  return /^[A-Za-z0-9_.:-]+$/u.test(sanitized) ? sanitized : undefined;
}

function sanitizeErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 128);
  return sanitized || undefined;
}

function sanitizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const route = parsed.pathname
      .split("/")
      .map((segment) => sanitizeRouteSegment(segment))
      .join("/");
    return `${parsed.protocol}//${parsed.host}${route}`;
  } catch {
    return "{url}";
  }
}

function sanitizeRouteSegment(segment: string): string {
  if (!segment) return segment;
  if (
    /@/u.test(segment) ||
    /^\d{7,}$/u.test(segment) ||
    /^[0-9a-f]{16,}$/iu.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)
  ) {
    return "{segment}";
  }
  return segment.slice(0, 128);
}
