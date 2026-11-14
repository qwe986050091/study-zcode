/* oxlint-disable eslint(max-lines) -- Share 的错误/预检公共契约与跨 RPC 脱敏规则必须保持在同一边界，避免 UI、Host 和 API 各自漂移。 */
// 分享能力对 RPC / UI / CLI 暴露的公共契约：输入输出类型、错误分类、脱敏规则、门禁实现。
// 这里同时是「跨进程安全边界」：凡是要送到 Renderer 的 issue 都必须经过 sanitize。
// INV-01：任何进入 details 的字符串都不得包含路径分隔符或 URL scheme，否则等于泄漏本机路径（守住它：sanitizeFailureIssue / sanitizeFailureDiagnostics）。
// INV-02：失败分类必须优先用结构化 reasonCode，只有缺省时才回落到消息正则（守住它：inferFailureReasonCode）。
// INV-03：issue 列表对外最多 5 条，且 omittedIssueCount 必须如实反映被截断的数量（守住它：sanitizeConversationShareIssues）。
// INV-04：不支持分享的宿主只能通过 createUnsupportedConversationShareService 生成，不得手写（守住它：该工厂函数）。
// 改错后果：UI 报错文案缺失、同一错误在不同宿主上分类不一致，或把用户本机绝对路径透传到渲染进程日志。
// 类型层的取舍：selection 支持 all/productTurns/rowAnchors 三种粒度，是为了让 UI 的三种选择交互各自表达，
// 而 service 只把它归一到 productTurn 集合，避免三套过滤逻辑在校验处漂移。
import type {
  ConversationShareAccessMode,
  ConversationShareCapabilities,
  ConversationShareContinuation,
  ConversationSharePreview,
  ConversationShareRecord,
  Locale,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { Event as RpcEvent, type Event } from "@zcode/rpc";

import { createServiceDescriptor } from "../descriptors.js";
import type { ConversationShareClientErrorKind } from "./conversationShareHttpClient.js";

export type ConversationShareSelection =
  | { kind: "all" }
  | { kind: "productTurns"; productTurnIds: string[] }
  | { kind: "rowAnchors"; rowIds: number[] };

// operationId 不在此结构中：它由 RPC 层单独传入并绑定进度事件；放进来会让同一 operation 的
// 多次调用在参数上看起来可互换，实际进度流无法复用。
// disclosureAcceptedAt 是必填：发布前必须有一次显式的用户确认，service 不接受隐式默认值。
export interface PublishTextConversationInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  title: string;
  accessMode: ConversationShareAccessMode;
  selection: ConversationShareSelection;
  clientRequestId: string;
  disclosureAcceptedAt: number;
  /** 界面语言；决定返回的 share_url 落在中文站还是英文站。缺省不改写服务端下发的链接。 */
  locale?: Locale;
}

// 预检不需要 title/accessMode/披露确认：它只回答「这份选择能不能分享」，不产生任何远端副作用。
export interface ConversationSharePreflightInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  selection: ConversationShareSelection;
}

// type 用 string 而不是枚举：服务端可新增产物类型，客户端应把它当作不透明标签透传并只做展示。
export interface ConversationShareAllowedArtifact {
  type: string;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  displayName?: string;
}

// 按轮拆分的预检结果：UI 的「取消选择该轮」需要每轮独立的阻断原因，
// 若只给整组聚合结果，用户无法定位是哪一轮挡住了发布。
// rowBudget 是可选：只有算过行数预算的阶段才填，避免调用方把「未计算」误读成「0 行」。
export interface ConversationShareTurnPreflightResult {
  /** 已转换的公开行数；选择变化时可按轮重新聚合，不缓存整组选中项的容量错误。 */
  rowBudget?: { count: number; limit: number };
  productTurnId: string;
  turnFingerprint?: string;
  blockingIssues: readonly ConversationShareFailureIssue[];
  skippableWarnings: readonly ConversationShareFailureIssue[];
  deferredIssues: readonly ConversationShareFailureIssue[];
}

// revision + logEpoch 是这次读取的水位快照：发布阶段必须带上它，服务端据此拒绝陈旧的写入。
// capabilitiesFingerprint 让发布端判断「预检时的能力」与「发布时的能力」是否还是同一份。
export interface ConversationSharePreflightResult {
  revision: number;
  logEpoch: string;
  capabilitiesFingerprint: string;
  blockingIssues: readonly ConversationShareFailureIssue[];
  skippableWarnings: readonly ConversationShareFailureIssue[];
  deferredIssues: readonly ConversationShareFailureIssue[];
  supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  turnResults: readonly ConversationShareTurnPreflightResult[];
}

// 前四个来自 HTTP 客户端，后三个是本层独有的本地失败：
// connection_unavailable 表示 Host attachment 身份不可信；safety_check_timeout 表示服务端安全检查未在窗口内定稿。
export type ConversationShareServiceErrorKind =
  | ConversationShareClientErrorKind
  | "artifact_protocol_not_ready"
  | "connection_unavailable"
  | "invalid_selection"
  | "safety_check_timeout";

// reasonCode 是可机器判断的细分原因，与 issue.code 的区别是：
// reasonCode 描述「为什么整体失败」，issue.code 描述「哪一项内容有问题」。
// 新增值必须同步 inferFailureReasonCode 的映射，否则只会落到 invalid_conversation 兜底。
// artifact_size_limit 与 artifact_read_failed 刻意分开：前者是确定阻断，后者不确定、可能只是暂时读不到。
export type ConversationShareFailureReasonCode =
  | "running_turn"
  | "streaming_row"
  | "active_tool_call"
  | "active_subagent"
  | "input_attachment"
  | "input_attachment_unavailable"
  | "inline_tool_image"
  | "unsupported_timeline"
  | "unsafe_url"
  | "missing_product_turn"
  | "invalid_selection"
  | "artifact_type_not_allowed"
  | "artifact_extension_missing"
  | "artifact_outside_workspace"
  | "artifact_changed"
  | "content_unavailable"
  | "artifact_read_failed"
  // 已知容量超限：附件真实大小超过服务端 max_artifact_bytes 或通道可搬运上限。
  // 与 artifact_read_failed（不确定）不同，它在选择阶段就是确定阻断。
  | "artifact_size_limit"
  | "artifact_manifest"
  | "payload_limit"
  | "no_shareable_content"
  | "stale_conversation"
  | "artifact_protocol_not_ready"
  | "invalid_conversation";

// issue code 是「单项问题」的闭集：既包含服务端错误类别，也包含内容级原因码，
// 这样 UI 只需按一个字段决定文案与是否可重试。
export type ConversationShareFailureIssueCode =
  | "authentication_required"
  | "network"
  | "service_unavailable"
  | "rate_limited"
  | "feature_disabled"
  | "connection_unavailable"
  | "invalid_contract"
  | "disclosure_required"
  | ConversationShareFailureReasonCode
  | "rows_limit"
  | "artifact_count_limit"
  | "artifact_total_size_limit"
  | "payload_size_limit"
  | "upload_incomplete"
  | "unknown";

// scope 决定问题挂在哪一层：conversation 级别通常阻断整次发布，
// artifact 级别多数可降级为 warning，UI 据此决定是「必须处理」还是「提示即可」。
// actual/limit 只在容量类问题里有意义；allowedFormats 与 allowedArtifacts 用于给出可操作建议。
// availability 表达「文件还在不在」，避免 UI 把权限问题误报成文件已被删除。
export interface ConversationShareFailureIssue {
  code: ConversationShareFailureIssueCode;
  scope: "conversation" | "turn" | "artifact" | "transport";
  rowId?: number;
  turnOrdinal?: number;
  /**
   * 问题所属的 product turn 身份。
   *
   * UI 的「取消选择该轮」曾用 turnOrdinal 去索引自己的 per-query 列表，
   * 而 turnOrdinal 是 service 按全部 turnHeader 编号的序号，两套编号在含系统上下文轮
   * 或多 steer query 的会话里必然错位，导致取消到别的轮次。轮次定位必须按身份，
   * turnOrdinal 只用于展示文案。
   */
  productTurnId?: string;
  artifactDisplayName?: string;
  artifactType?: string;
  extension?: string;
  mimeType?: string;
  actual?: number;
  limit?: number;
  retryAfterMs?: number;
  phase?: ConversationSharePublishProgress["phase"] | "downloading" | "installing" | "committing";
  allowedFormats?: readonly string[];
  allowedArtifacts?: readonly ConversationShareAllowedArtifact[];
  availability?:
    | "not_found"
    | "permission_denied"
    | "connection_unavailable"
    | "changed"
    | "unknown";
}

// 只允许标量：嵌套结构无法用「是否含路径」简单判定，放进来等于给脱敏留后门。
export type ConversationShareFailureDiagnosticValue = string | number | boolean;
export type ConversationShareFailureDiagnostics = Readonly<
  Record<string, ConversationShareFailureDiagnosticValue>
>;

// [失败路径] 这是兼容旧调用点的兜底：多数 throw 点已显式传 reasonCode，
// 但构造 ConversationShareServiceError 的第三方代码可能只给消息，
// 此时按消息关键字归类，宁可归到 invalid_conversation 也不要抛「未知错误」。
// 正则刻意用大小写不敏感匹配，因为消息大小写与措辞在历史上变动过；新增措辞要在这里补一条。
function inferFailureReasonCode(message: string): ConversationShareFailureReasonCode {
  if (/Running turns/iu.test(message)) return "running_turn";
  if (/Streaming rows/iu.test(message)) return "streaming_row";
  if (/Active tool calls/iu.test(message)) return "active_tool_call";
  if (/Active subagents|subagent detail/iu.test(message)) return "active_subagent";
  if (/attachments?|public input contains local write identity/iu.test(message)) {
    return "input_attachment";
  }
  if (/Inline tool images/iu.test(message)) return "inline_tool_image";
  if (/Timeline|fork|checkpoint|summary references/iu.test(message)) {
    return "unsupported_timeline";
  }
  if (/Local and inline URLs/iu.test(message)) return "unsafe_url";
  if (/missing its product turn|product turn identity/iu.test(message)) {
    return "missing_product_turn";
  }
  if (/Selected product turns|selected row|selection/iu.test(message)) {
    return "invalid_selection";
  }
  if (/not allowed by server capabilities/iu.test(message)) return "artifact_type_not_allowed";
  if (/extension is missing/iu.test(message)) return "artifact_extension_missing";
  if (/outside the workspace/iu.test(message)) return "artifact_outside_workspace";
  if (/changed after|file changed|size\/mtime/iu.test(message)) return "artifact_changed";
  // 本地/远程 artifact source 的兜底消息是 "artifact cannot be read"，
  // 旧正则只覆盖 ended|source|chunk|readable，读失败因此被误判为 invalid_conversation。
  if (/artifact (?:ended|source|chunk|readable|cannot be read)/iu.test(message)) {
    return "artifact_read_failed";
  }
  if (/artifact (?:identifiers|manifest|acknowledgement|missing)/iu.test(message)) {
    return "artifact_manifest";
  }
  if (/payload|too many rows|too many artifacts/iu.test(message)) return "payload_limit";
  return "invalid_conversation";
}

// details 同时承担「构造入参」和「跨 RPC 载荷」两个角色，所以 cause 单独标注了不外发；
// 构造函数会把其余字段重新过滤一遍，调用方即使塞了路径也不会泄漏。
export interface ConversationShareFailureDetails {
  requestId?: string;
  status?: number;
  code?: number;
  reasonCode?: ConversationShareFailureReasonCode;
  diagnostics?: ConversationShareFailureDiagnostics;
  issues?: readonly ConversationShareFailureIssue[];
  issueCount?: number;
  omittedIssueCount?: number;
  /** 仅用于 host 侧诊断的底层错误；绝不进入发给 Renderer 的 details。 */
  cause?: unknown;
}

// 白名单而非黑名单：diagnostics 是自由键的对象，只有明确知道含义的键才允许外发，
// 这样将来有人往 diagnostics 里塞 fileName/workspacePath 时默认会被丢掉，而不是默认泄漏。
// 值还要再过一次「不含路径分隔符且不超长」的检查，防止 errno 位置被塞入路径。
const SAFE_FAILURE_DIAGNOSTIC_KEYS = new Set([
  "rowKind",
  "rowId",
  "field",
  "artifactType",
  "extension",
  "phase",
  "expectedBytes",
  "actualBytes",
  "errno",
]);

const MAX_FAILURE_ISSUES = 5;

// [失败路径] 返回 null 的分支已被移除：早期版本只要 displayName 含路径就整条丢弃，
// 结果 UI 只剩一个 code 而没有任何定位信息；现在改为只剥离那个字段。
// 保留 rowId/turnOrdinal/productTurnId：它们是本机序号与 ID，不含路径，可用于定位。
function sanitizeFailureIssue(
  issue: ConversationShareFailureIssue,
): ConversationShareFailureIssue | null {
  const safeString = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && !/[\\/]|:\/\//u.test(value) ? value : undefined;
  const safeMimeType = (value: string | undefined): string | undefined =>
    value && value.length <= 128 && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(value)
      ? value
      : undefined;
// 逐个字段做「长度 + 无路径」双重校验，而不是整体 JSON 序列化后一次判断：
// 后者无法区分「字段值含斜杠」与「结构本身有斜杠」，会把合法 issue 误杀。
  const artifactDisplayName = issue.artifactDisplayName?.trim();
  // displayName 含路径/URL 或超长时，整条 issue 返回 null 会被过滤——脱敏目标是
  // 不泄露路径，而不是丢掉整条诊断信息。改为只剥离该字段，保留 code/scope 等定位信息。
  const safeArtifactDisplayName =
    artifactDisplayName &&
    artifactDisplayName.length <= 128 &&
    !/[\\/]|:\/\//u.test(artifactDisplayName)
      ? artifactDisplayName
      : undefined;
// allowedFormats 是给人看的标签（如 IMAGE (.png)），同样要过滤，
// 因为它可能被上游拼进用户提供的文件名。
  const allowedFormats = issue.allowedFormats
    ?.map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 128 && !/[\\/]|:\/\//u.test(value));
// 能力列表来自服务端，理论上安全，但这里仍按同一规则收紧：
// 只要有一层不可信输入能影响它，就不能假设它一定干净。
  const allowedArtifacts = issue.allowedArtifacts
    ?.map((artifact) => ({
      type: artifact.type.trim(),
      extensions: artifact.extensions
        .map((extension) => extension.trim().replace(/^\./u, ""))
        .filter((extension) => extension.length > 0 && extension.length <= 32),
      mimeTypes: artifact.mimeTypes
        .map((mimeType) => mimeType.trim().toLowerCase())
        .filter((mimeType) => /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(mimeType)),
      ...(artifact.displayName &&
      artifact.displayName.length <= 64 &&
      !/[\\/]|:\/\//u.test(artifact.displayName)
        ? { displayName: artifact.displayName.trim() }
        : {}),
    }))
    .filter(
      (artifact) =>
        artifact.type.length > 0 &&
        !/[\\/]|:\/\//u.test(artifact.type) &&
        artifact.extensions.length > 0,
    );
  return {
    code: issue.code,
    scope: issue.scope,
    ...(issue.rowId === undefined ? {} : { rowId: issue.rowId }),
    ...(issue.turnOrdinal === undefined ? {} : { turnOrdinal: issue.turnOrdinal }),
    ...(typeof issue.productTurnId === "string" && issue.productTurnId.length > 0
      ? { productTurnId: issue.productTurnId }
      : {}),
    ...(safeArtifactDisplayName ? { artifactDisplayName: safeArtifactDisplayName } : {}),
    ...(safeString(issue.artifactType) ? { artifactType: safeString(issue.artifactType) } : {}),
    ...(safeString(issue.extension) ? { extension: safeString(issue.extension) } : {}),
    ...(safeMimeType(issue.mimeType) ? { mimeType: safeMimeType(issue.mimeType) } : {}),
    ...(issue.actual === undefined ? {} : { actual: issue.actual }),
    ...(issue.limit === undefined ? {} : { limit: issue.limit }),
    ...(issue.retryAfterMs === undefined ? {} : { retryAfterMs: issue.retryAfterMs }),
    ...(issue.phase === undefined ? {} : { phase: issue.phase }),
    ...(allowedFormats && allowedFormats.length > 0 ? { allowedFormats } : {}),
    ...(allowedArtifacts && allowedArtifacts.length > 0 ? { allowedArtifacts } : {}),
    ...(issue.availability === undefined ? {} : { availability: issue.availability }),
  };
}

/**
 * 把 issue 列表裁剪并清洗成可安全跨 RPC 的载荷，返回被省略的条数。
 * 非阻断 warning 与阻断 issue 共用同一套脱敏规则。
 */
// 先截断再清洗：被截断的条数用原始长度减清洗后长度计算，
// 因此 issueCount 是「真实总数」而非「洗后剩余数」，UI 可以据此提示还有更多问题。
// 阻断与 warning 共用本函数，防止两套脱敏规则出现差异导致 warning 泄路径。
export function sanitizeConversationShareIssues(issues: readonly ConversationShareFailureIssue[]): {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount: number;
} {
// 先 slice 后 map：清洗是逐条独立操作，先截断可以避免对永远不会外发的条目做无谓处理。
  const sanitized = issues
    .slice(0, MAX_FAILURE_ISSUES)
    .map(sanitizeFailureIssue)
    .filter((issue): issue is ConversationShareFailureIssue => issue !== null);
  return {
    issues: sanitized,
    issueCount: issues.length,
    omittedIssueCount: Math.max(0, issues.length - sanitized.length),
  };
}

// 返回 undefined 而不是空对象：调用方用「有无」判断是否写进 details，
// 空对象会让 details 出现一个无意义的 diagnostics: {}。
// 数字与布尔不检查长度，因为它们不可能是路径。
function sanitizeFailureDiagnostics(
  diagnostics: ConversationShareFailureDiagnostics | undefined,
): ConversationShareFailureDiagnostics | undefined {
  if (!diagnostics) return undefined;
// 只保留白名单键；键名可能是动态拼接的，所以不能靠类型系统保证。
  const safe: Record<string, ConversationShareFailureDiagnosticValue> = {};
  for (const [key, value] of Object.entries(diagnostics)) {
    if (!SAFE_FAILURE_DIAGNOSTIC_KEYS.has(key)) continue;
    if (typeof value === "string" && (/[\\/]|:\/\//u.test(value) || value.length > 128)) continue;
    safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

// 本层唯一的错误类型：所有失败都必须归一到这里，才能保证 RPC 序列化时字段稳定。
// kind 决定 UI 的处理分支（重试 / 升级 / 换选择），reasonCode 决定文案细节。
// details 是真正过线的东西；类上的其它字段是宿主侧自用的便利访问器。
export class ConversationShareServiceError extends Error {
  readonly kind: ConversationShareServiceErrorKind;
  readonly requestId?: string;
  readonly status?: number;
  readonly code?: number;
  readonly reasonCode: ConversationShareFailureReasonCode;
  readonly diagnostics?: ConversationShareFailureDiagnostics;
  readonly issues?: readonly ConversationShareFailureIssue[];
  readonly issueCount: number;
  readonly omittedIssueCount: number;
  /** 通过现有 RPC details 字段传给 Renderer 的安全错误载荷。 */
  readonly details?: ConversationShareFailureDetails;

  constructor(
    kind: ConversationShareServiceErrorKind,
    message: string,
    details: ConversationShareFailureDetails = {},
  ) {
// [权衡] 用展开语法而不是 super(message, { cause })：后者在旧运行时会把 undefined 写成
// cause: undefined，某些序列化器会把它变成字符串 "undefined"，反而制造噪音。
// [失败路径] status/code 只在是安全整数时才赋值：HTTP 层可能传来 NaN，留着会污染分类逻辑。
// reasonCode 缺省时才推断；显式传入优先，因为调用点掌握的消息上下文比正则更准确。
// 构造末尾把 details 重新组装一遍，是因为 this.* 已过滤，直接展开入参会把原始值带出去。
    super(message, ...(details.cause === undefined ? [] : [{ cause: details.cause }]));
    this.name = "ConversationShareServiceError";
    this.kind = kind;
    const requestId = details.requestId?.trim();
    if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      this.requestId = requestId;
    }
// 用 Number.isSafeInteger 而不是 typeof number：NaN 与 Infinity 能通过 typeof，
// 却会让 classifyConversationShareError 之类的分支得到不可预期结果。
    if (Number.isSafeInteger(details.status)) this.status = details.status;
    if (Number.isSafeInteger(details.code)) this.code = details.code;
    this.reasonCode = details.reasonCode ?? inferFailureReasonCode(message);
// 先过滤再决定是否赋值：undefined 与空对象在 details 组装时的语义不同，这里保留 undefined。
    const diagnostics = sanitizeFailureDiagnostics(details.diagnostics);
    if (diagnostics) {
      this.diagnostics = diagnostics;
    }
    const sanitized = sanitizeConversationShareIssues(details.issues ?? []);
    this.issueCount = sanitized.issueCount;
    this.omittedIssueCount = sanitized.omittedIssueCount;
    if (sanitized.issues.length > 0) {
      this.issues = sanitized.issues;
    }
// 这里只从 this.* 取值，绝不展开原始 details：cause 与未过滤字段必须被结构性排除，
// 而不是依赖调用方自觉。
    const safeDetails: ConversationShareFailureDetails = {
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.code === undefined ? {} : { code: this.code }),
      reasonCode: this.reasonCode,
      ...(this.diagnostics === undefined ? {} : { diagnostics: this.diagnostics }),
      ...(this.issues === undefined ? {} : { issues: this.issues }),
      ...(this.issueCount > 0 ? { issueCount: this.issueCount } : {}),
      ...(this.issueCount > 0 ? { omittedIssueCount: this.omittedIssueCount } : {}),
    };
    if (Object.keys(safeDetails).length > 0) {
      this.details = safeDetails;
    }
  }
}

// 发布进度按 phase 单调推进：collecting → uploading → checking → complete，
// completedArtifacts 只在 uploading/checking 阶段有意义，UI 需按 phase 决定是否显示计数。
export interface ConversationSharePublishProgress {
  operationId: string;
  phase: "collecting" | "uploading" | "checking" | "complete";
  completedArtifacts: number;
  totalArtifacts: number;
  /**
   * 非阻断提示：发布照常继续，但这些结果物被跳过（例如正文引用的文件已不存在）。
   * 已过 sanitizeConversationShareIssues 脱敏，可安全跨 RPC。
   */
  warnings?: readonly ConversationShareFailureIssue[];
  omittedWarningCount?: number;
}

// 导入进度同理，但 downloading 阶段的 completedArtifacts 是已下载并写盘的个数，可用于断点提示。
export interface ConversationShareImportProgress {
  operationId: string;
  phase: "downloading" | "installing" | "committing" | "complete";
  completedArtifacts: number;
  totalArtifacts: number;
}

// targetWorkspaceKind 与 targetWorkspaceIdentity 分开传：前者决定「要不要落到默认 workspace」，
// 后者是身份 key。两者混用会让远端 workspace 被误判成本地路径。
export interface ImportConversationShareInput {
  shareCode: string;
  clientRequestId: string;
  /** 当前 renderer 捕获的目标；Deep Link 本身不得携带路径或 identity。 */
  targetWorkspacePath?: string;
  targetWorkspaceIdentity?: string;
  targetWorkspaceKind?: "local" | "remote";
  /** 界面语言；决定导入会话的标题前缀。回链本身固定存规范路径。 */
  locale?: Locale;
}

/** 导入时落盘的公开 rows 副本；会话里的只读块靠它渲染，不回源。 */
// contextId 是「这次导入」的稳定标识，marker/会话 provenance/只读块都用它关联；
// shareId 是「这次分享」的标识，一个 share 可能被导入多次，二者不可互换。
export interface ImportedConversationShare {
  contentBlocks?: unknown[];
  shareId: string;
  contextId: string;
  title: string;
  rows: ConversationRow[];
  /**
   * 本端渲染不了、已跳过的行数（副本里有新 row kind，或 formatVersion 比本端新）。
   * >0 时只读块顶部必须出软提示，否则用户会以为内容丢了。
   */
  unsupportedRowCount: number;
  artifacts: Array<{
    artifactId: string;
    displayName: string;
    mimeType?: string;
    workspaceRelativePath?: string;
  }>;
}

// reused=true 表示命中幂等缓存或历史 marker，此时 sessionId 是既有会话；
// fallbackReason 告诉 UI 为什么最终落到默认/远端 workspace，便于给出「已存到默认位置」提示。
export interface ImportConversationShareResult {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  contextId: string;
  shareUrl: string;
  title: string;
  reused: boolean;
  fallbackReason?: "remote_workspace" | "default_workspace";
}

// 服务接口刻意保持扁平：所有方法都以 input 对象传参，新增可选字段不会破坏已部署的调用方。
// preflight 与 publish 必须成对实现同一套内容校验，否则预检说能发、发布却失败，
// 这是本模块最容易被改坏的契约，两边都复用了同一组 sanitize/collect 函数。
export interface IConversationShareService {
  getCapabilities(): Promise<ConversationShareCapabilities>;
  preflight(input: ConversationSharePreflightInput): Promise<ConversationSharePreflightResult>;
  publish(
    input: PublishTextConversationInput,
    operationId: string,
  ): Promise<ConversationShareRecord>;
  onDynamicPublishProgress(operationId: string): Event<ConversationSharePublishProgress>;
  importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult>;
  onDynamicImportProgress(operationId: string): Event<ConversationShareImportProgress>;
  /** 读取导入时落盘的公开 rows；找不到返回 null（会话里就不渲染只读块）。 */
  getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null>;
  getPreview(shareCode: string): Promise<ConversationSharePreview>;
  getContinuation(input: {
    shareCode: string;
    clientRequestId: string;
  }): Promise<ConversationShareContinuation>;
}

// 运行时用 Symbol 描述符承载 channel：类型与通道名绑定在同一处，避免手写字符串拼错。
export const IConversationShareService = createServiceDescriptor<IConversationShareService>(
  ServiceChannels.ConversationShare,
);

/**
 * 分享能力不可用时的统一门禁实现。
 *
 * 每个不支持分享的宿主（desktop-attached remote、server remote 等）都要拒绝全部
 * 写操作并返回空事件流。手写会让 IConversationShareService 新增方法时漏改某个宿主，
 * 所以由这里集中生成。
 */
// 工厂集中生成门禁实现：新增接口方法时这里会因缺少属性而编译失败，
// 从而逼着每个不支持分享的宿主显式决定「拒绝」还是「返回空」。
// onRejected 钩子只记录动作名，不接收参数，避免把可能含路径的入参写进审计日志。
export function createUnsupportedConversationShareService(options: {
  message: string;
  /** 可选审计钩子：宿主想记录被拒绝的动作名时传入。 */
  onRejected?: (action: string) => void;
}): IConversationShareService {
// 失败用 feature_disabled 而不是 unknown：UI 据此显示「当前环境不支持分享」，
// 而不是给一个「重试」按钮让用户反复点。
  const reject = (action: string) => async (): Promise<never> => {
    options.onRejected?.(action);
    throw new ConversationShareServiceError("feature_disabled", options.message);
  };
// 返回 RpcEvent.None 而不是抛错：订阅发生在组件挂载阶段，抛错会让整个页面渲染失败。
  const noEvents = () => RpcEvent.None;
  return {
    getCapabilities: reject("getCapabilities"),
    preflight: reject("preflight"),
    publish: reject("publish"),
    onDynamicPublishProgress: noEvents,
    importShare: reject("importShare"),
    onDynamicImportProgress: noEvents,
    // 只读查询：不可用环境下返回 null 而不是抛错，会话里就是不渲染只读块。
    getImportedConversation: async () => null,
    getPreview: reject("getPreview"),
    getContinuation: reject("getContinuation"),
  };
}
