// 会话分享错误归一化模块：把 Host/HTTP/预检/上传等任意来源的 unknown 错误，
// 收敛为 ConversationShareErrorDetails，并解析 i18n 文案 id 与可展示的问题清单。
// 只做「读取 + 白名单过滤 + 文案映射」，不发起请求、不写 store、不做重试与上报。
//
// 不变量（每一条都对应线上可见故障，不要因为「看起来多余」而删）：
// INV-01 断言：对外暴露的字符串一律经路径与协议头过滤 —— 守住它的位置：sanitizeIssue 的 safeString、getConversationShareErrorDetails 的 diagnostics 过滤器 —— 改错故障：错误弹窗把用户工作区绝对路径显示出来，截图外发即泄露目录结构
// INV-02 断言：任意输入都返回对象且不抛异常 —— 守住它的位置：getConversationShareErrorDetails 的全部读取与 safeParse —— 改错故障：错误态渲染期间二次崩溃，用户只看到白屏，拿不到任何失败原因
// INV-03 断言：字段先读顶层、再读 details 子对象 —— 守住它的位置：getConversationShareErrorDetails 里的 readField —— 改错故障：只写 details 的旧版 Host 丢掉 status 与 requestId，排障工单无法定位
// INV-04 断言：非法 issue 条目直接丢弃，不保留空壳 —— 守住它的位置：sanitizeIssue 的 null 返回与 map 之后的 filter —— 改错故障：问题列表出现空行，渲染 undefined 字段时整块报错
// INV-05 断言：issueCount 保留服务端上报总数，未展示数等于总数减已保留数且不小于零 —— 守住它的位置：getConversationShareErrorDetails 末尾的两个计数 —— 改错故障：被截断的清单被当成完整清单，用户以为只坏了几处
// INV-06 断言：详情对象省略空字段而不写入 undefined —— 守住它的位置：所有返回处的展开条件 —— 改错故障：结构化日志与快照里出现大量 undefined 噪声，键数量随错误随机抖动
// INV-07 断言：文案 id 只来自固定映射，未收录 code 回退到 unknown —— 守住它的位置：resolveConversationShareIssueMessageId —— 改错故障：拼出不存在的翻译 key，界面直接显示 conversationShare.issue.xxx 原文
// INV-08 断言：细分原因文案优先于粗粒度 kind 文案 —— 守住它的位置：resolveConversationSharePublishErrorMessageId 的分支顺序 —— 改错故障：artifact_changed 被统一成通用失败文案，用户不知道该删文件还是直接重试
// INV-09 断言：invalid_contract 且 status 不小于 400 时使用 HTTP 专用文案 —— 守住它的位置：resolveConversationSharePublishErrorMessageId 首分支 —— 改错故障：网关 4xx 被报成协议解析失败，排查方向被带偏
// INV-10 断言：非阻断提示不得复用阻断文案 —— 守住它的位置：WARNING_MESSAGE_IDS 与 resolveConversationShareWarningMessageId —— 改错故障：已跳过文件的提示写成「确认后重试」，用户以为发布没有成功
// INV-11 断言：警告载荷再次做同一套清洗并剔除用户无法处理的 code —— 守住它的位置：sanitizeConversationShareWarnings —— 改错故障：进度提示被篡改后带出路径，或出现无法操作的内联图片告警
// INV-12 断言：productTurnId 仅接受长度 1 到 128 的非空字符串 —— 守住它的位置：sanitizeIssue 的对象构造段 —— 改错故障：用户点「取消选择该轮」定位不到轮次，或空串一次清空全部选择
// INV-13 断言：turnOrdinal 只用于展示，去重后升序 —— 守住它的位置：formatConversationShareErrorSummary —— 改错故障：摘要里同一轮重复出现，轮次顺序与时间线相反
// INV-14 断言：allowedArtifacts 条目的 extensions 与 mimeTypes 必须同时非空 —— 守住它的位置：sanitizeIssue 的 flatMap 分支 —— 改错故障：格式建议列表为空，界面显示空白引导文案
// INV-15 断言：availability 只接受五个已知枚举 —— 守住它的位置：sanitizeIssue 的白名单三元判断 —— 改错故障：自由文本进入 UI 分支，操作按钮落到默认态且点击无响应
// INV-16 断言：rejection 仅在 schema 校验通过时进入详情 —— 守住它的位置：getConversationShareErrorDetails 的 safeParse —— 改错故障：半截 rejection 结构进入 UI，类型专有字段缺失导致渲染分支崩溃
import type { ConversationShareFailureIssue } from "@zcode/services";
import { conversationShareRejectionSchema, type ConversationShareRejection } from "@zcode/shared";

// 所有字段可选：调用方面对的是跨进程与 HTTP 的异构错误，任一字段都可能缺席。
// status 与 code 保留数字原值供上层判断 HTTP 码与业务码，不在这里翻译成语义。
// issues 只放通过清洗的条目，issueCount 才是服务端声明的总数，两者不可互相推导。
// 新增字段必须同时补 sanitize 与省略规则，否则会出现「有键但空值」的半成品。
export interface ConversationShareErrorDetails {
  name: string;
  kind: string;
  reasonCode?: string;
  diagnostics?: Record<string, string | number | boolean>;
  status?: number;
  code?: number;
  requestId?: string;
  clientRequestId?: string;
  rejection?: ConversationShareRejection;
  issues?: readonly ConversationShareFailureIssue[];
  issueCount?: number;
  omittedIssueCount?: number;
}

// kind 是服务端的粗分类，只用来兜底文案；同一 kind 下更细的原因交给 BY_REASON。
// 多条 kind 映射到同一文案是有意合并，unsafe_structure 等都属于「会话不可分享」。
// 不要按 UI 直觉新增条目：未收录的 kind 会回退到 publishFailed，不会命中空 key。
// 此表只服务发布失败主路径，issue 级文案在 ISSUE_MESSAGE_IDS，两表不可互用。
const PUBLISH_ERROR_MESSAGE_BY_KIND: Readonly<Record<string, string>> = {
  authentication_required: "conversationShare.error.authenticationRequired",
  feature_disabled: "conversationShare.error.featureDisabled",
  artifact_not_allowed: "conversationShare.error.artifactNotAllowed",
  limit_exceeded: "conversationShare.error.limitExceeded",
  rate_limited: "conversationShare.error.rateLimited",
  network: "conversationShare.error.network",
  service_unavailable: "conversationShare.error.serviceUnavailable",
  safety_check_rejected: "conversationShare.error.safetyCheckRejected",
  safety_check_unavailable: "conversationShare.error.safetyCheckUnavailable",
  not_found: "conversationShare.error.preparationNotFound",
  expired: "conversationShare.error.preparationExpired",
  unsupported_schema_version: "conversationShare.import.unsupportedVersion",
  safety_check_timeout: "conversationShare.error.safetyCheckTimeout",
  invalid_selection: "conversationShare.error.invalidSelection",
  invalid_conversation: "conversationShare.error.invalidConversation",
  unsafe_structure: "conversationShare.error.invalidConversation",
  artifact_protocol_not_ready: "conversationShare.error.invalidConversation",
  invalid_contract: "conversationShare.error.invalidContract",
  disclosure_required: "conversationShare.error.disclosureRequired",
  upload_incomplete: "conversationShare.error.uploadFailed",
  connection_unavailable: "conversationShare.error.connectionUnavailable",
} as const;

// reasonCode 比 kind 更贴近失败点，解析文案时优先级高于 BY_KIND。
// 键名必须与服务端下发的 reasonCode 完全一致，含大小写，这里不做归一化。
// 未收录的 reasonCode 不会报错，只会退回 kind 文案，允许服务端先行扩展字段。
// 区分 artifact 系列是为了告诉用户「改文件」，而不是笼统地让他重试。
const PUBLISH_ERROR_MESSAGE_BY_REASON: Readonly<Record<string, string>> = {
  running_turn: "conversationShare.error.runningTurn",
  streaming_row: "conversationShare.error.streamingRow",
  active_tool_call: "conversationShare.error.activeToolCall",
  active_subagent: "conversationShare.error.activeSubagent",
  input_attachment: "conversationShare.error.inputAttachment",
  inline_tool_image: "conversationShare.error.inlineToolImage",
  unsupported_timeline: "conversationShare.error.unsupportedTimeline",
  unsafe_url: "conversationShare.error.unsafeUrl",
  missing_product_turn: "conversationShare.error.missingProductTurn",
  invalid_selection: "conversationShare.error.invalidSelection",
  artifact_type_not_allowed: "conversationShare.error.artifactTypeNotAllowed",
  artifact_extension_missing: "conversationShare.error.artifactExtensionMissing",
  artifact_outside_workspace: "conversationShare.error.artifactOutsideWorkspace",
  artifact_changed: "conversationShare.error.artifactChanged",
  artifact_read_failed: "conversationShare.error.artifactReadFailed",
  artifact_size_limit: "conversationShare.error.artifactSizeLimit",
  artifact_manifest: "conversationShare.error.artifactManifest",
  no_shareable_content: "conversationShare.error.noShareableContent",
  payload_limit: "conversationShare.error.payloadLimit",
} as const;

// 诊断字段走白名单而不是黑名单：新增字段默认不可见，避免误带路径或凭据。
// 即使键在白名单，值仍要过路径与协议头过滤，键与值是两道独立闸门。
// expectedBytes 与 actualBytes 等数值用于对照提示，不接受字符串形式的数字。
// 删条目会让依赖该字段的排查链路失去维度，改动前先查调用方。
const SAFE_DIAGNOSTIC_KEYS = new Set([
  "rowKind",
  "rowId",
  "field",
  "artifactType",
  "extension",
  "phase",
  "expectedBytes",
  "actualBytes",
]);

// 输入完全不可信：可能来自被改写的 progress 载荷，也可能是旧版 Host 的残留结构。
// 输出要么是结构完整的 issue，要么是 null，不做部分字段的猜测性补全。
// code 与 scope 只做存在性校验，具体取值由 ISSUE_MESSAGE_IDS 的联合类型兜底。
function sanitizeIssue(issue: unknown): ConversationShareFailureIssue | null {
  // 非对象与数组一律拒绝：数组会被当成对象取下标，产生一堆 undefined 字段。
  // 这里提前返回而不是抛错，保证一条坏数据不会拖垮整批 issues 的解析。
  // code 与 scope 缺失时整条丢弃，因为后续任何 UI 分支都依赖这两个键。
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;
  const value = issue as Record<string, unknown>;
  if (typeof value.code !== "string" || typeof value.scope !== "string") return null;
  // 同时拦截反斜杠、正斜杠与协议头，覆盖 Windows 路径与 URL 两种泄露形态。
  // 长度上限 128 防止超长字符串撑坏布局，或被塞入日志注入内容。
  // 只判断「是否可疑」，不做转义，合法值必须原样保留给展示层。
  const safeString = (candidate: unknown): string | undefined =>
    typeof candidate === "string" && candidate.length <= 128 && !/[\\/]|:\/\//u.test(candidate)
      ? candidate
      : undefined;
  const safeMimeType = (candidate: unknown): string | undefined =>
    typeof candidate === "string" &&
    candidate.length <= 128 &&
    /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(candidate)
      ? candidate
      : undefined;
  const artifactDisplayName = safeString(value.artifactDisplayName);
  const allowedFormats = Array.isArray(value.allowedFormats)
    ? value.allowedFormats.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length <= 128 && !/[\\/]|:\/\//u.test(entry),
      )
    : undefined;
  // 每一项都要独立校验 type、extensions 与 mimeTypes，单项失败只丢该项。
  // 类型字段不接受路径分隔符，避免把文件名伪装成类型展示给用户。
  // extensions 与 mimeTypes 必须同时非空，否则该项对用户没有任何指导价值。
  // displayName 可选且单独限长，缺失时由调用方回退到 type 标签。
  const allowedArtifacts = Array.isArray(value.allowedArtifacts)
    ? value.allowedArtifacts.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const artifact = entry as Record<string, unknown>;
        if (
          typeof artifact.type !== "string" ||
          artifact.type.length === 0 ||
          artifact.type.length > 64 ||
          /[\\/]|:\/\//u.test(artifact.type)
        ) {
          return [];
        }
        const extensions = Array.isArray(artifact.extensions)
          ? artifact.extensions.filter(
              (item): item is string =>
                typeof item === "string" && item.length <= 32 && !/[\\/]|:\/\//u.test(item),
            )
          : [];
        const mimeTypes = Array.isArray(artifact.mimeTypes)
          ? artifact.mimeTypes.filter(
              (item): item is string =>
                typeof item === "string" && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(item),
            )
          : [];
        // 任一列表为空则整条丢弃：只剩扩展名或只剩 MIME 的建议无法渲染成一句话。
        // 返回空数组而不是 undefined，保持 flatMap 回调的返回类型一致。
        if (extensions.length === 0 || mimeTypes.length === 0) return [];
        return [
          {
            type: artifact.type,
            extensions,
            mimeTypes,
            ...(typeof artifact.displayName === "string" &&
            artifact.displayName.length <= 64 &&
            !/[\\/]|:\/\//u.test(artifact.displayName)
              ? { displayName: artifact.displayName }
              : {}),
          },
        ];
      })
    : undefined;
  // 只接受五个枚举；收到其他值时省略整个字段，而不是原样透传脏值。
  // 省略可让 UI 走默认分支，比透传后触发未知状态更安全。
  // permission_denied 与 not_found 在文案上必须区分，二者对应不同操作。
  const availability =
    value.availability === "not_found" ||
    value.availability === "permission_denied" ||
    value.availability === "connection_unavailable" ||
    value.availability === "changed" ||
    value.availability === "unknown"
      ? value.availability
      : undefined;
  return {
    code: value.code as ConversationShareFailureIssue["code"],
    scope: value.scope as ConversationShareFailureIssue["scope"],
    ...(typeof value.rowId === "number" ? { rowId: value.rowId } : {}),
    ...(typeof value.turnOrdinal === "number" ? { turnOrdinal: value.turnOrdinal } : {}),
    // productTurnId 是「取消选择该轮」的唯一可靠定位依据（turnOrdinal 只用于文案）。
    ...(typeof value.productTurnId === "string" &&
    value.productTurnId.length > 0 &&
    value.productTurnId.length <= 128
      ? { productTurnId: value.productTurnId }
      : {}),
    ...(artifactDisplayName ? { artifactDisplayName } : {}),
    ...(safeString(value.artifactType) ? { artifactType: safeString(value.artifactType) } : {}),
    ...(safeString(value.extension) ? { extension: safeString(value.extension) } : {}),
    ...(safeMimeType(value.mimeType) ? { mimeType: safeMimeType(value.mimeType) } : {}),
    ...(typeof value.actual === "number" ? { actual: value.actual } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
    ...(typeof value.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {}),
    ...(value.phase === "collecting" ||
    value.phase === "uploading" ||
    value.phase === "checking" ||
    value.phase === "complete"
      ? { phase: value.phase }
      : {}),
    ...(allowedFormats && allowedFormats.length > 0 ? { allowedFormats } : {}),
    ...(allowedArtifacts && allowedArtifacts.length > 0 ? { allowedArtifacts } : {}),
    ...(availability === undefined ? {} : { availability }),
  };
}

// 只认非 null 的对象；Error 实例本身也是对象，可直接按记录读取。
// 不做原型链检查，跨进程 structured clone 之后的对象同样可用。
function readRecord(error: unknown): Record<string, unknown> | null {
  return error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
}

// 这是所有调用方的唯一入口：错误结构差异都收敛在这里，别在组件里二次判断。
// name 优先取记录上的显式值，退而取 Error.name，最后固定为 UnknownError。
// kind 缺省为 unknown，保证下游映射总能命中兜底分支。
// 全程不使用 throw，任何异常输入都要产出可渲染的详情对象。
export function getConversationShareErrorDetails(error: unknown): ConversationShareErrorDetails {
  const record = readRecord(error);
  const nestedDetails = readRecord(record?.details);
  // 顶层优先、details 兜底，兼容新旧两代 Host 的扁平与嵌套两种写法。
  // 用空值合并而非逻辑或，避免把 0 或空串这类合法值误判为缺失。
  // 只读不改，两个来源都不做原地写入，防止污染原始错误对象。
  const readField = (key: string): unknown => record?.[key] ?? nestedDetails?.[key];
  const name =
    typeof record?.name === "string"
      ? record.name
      : error instanceof Error
        ? error.name
        : "UnknownError";
  const kind = typeof record?.kind === "string" ? record.kind : "unknown";
  const reasonCodeValue = readField("reasonCode");
  const reasonCode = typeof reasonCodeValue === "string" ? reasonCodeValue : undefined;
  // 诊断对象必须是纯对象，数组会被拆成下标键，这里直接跳过。
  // `diagnostics` 逐键过滤：白名单之外的一律不进入结果，减少跨端日志差异面。
  // 字符串值再做一层路径检查，数字与布尔原样保留。
  // 过滤后为空则不输出该字段，避免空对象让 UI 误以为存在诊断信息。
  const rawDiagnostics = readField("diagnostics");
  const diagnostics: Record<string, string | number | boolean> = {};
  if (rawDiagnostics && typeof rawDiagnostics === "object" && !Array.isArray(rawDiagnostics)) {
    // 这里的 key 来自对端，只用于白名单比对，不能拼进文案或查询串。
    // 只接受原始类型，嵌套对象与数组一律忽略，防止深层结构进入渲染。
    // 值是字符串时仍按路径规则过滤，白名单不构成信任传递。
    for (const [key, value] of Object.entries(rawDiagnostics)) {
      if (!SAFE_DIAGNOSTIC_KEYS.has(key)) continue;
      if (
        (typeof value === "string" && !/[\\/]|:\/\//u.test(value)) ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        diagnostics[key] = value;
      }
    }
  }
  const statusValue = readField("status");
  const codeValue = readField("code");
  const status = typeof statusValue === "number" ? statusValue : undefined;
  const code = typeof codeValue === "number" ? codeValue : undefined;
  const requestIdValue = readField("requestId");
  const requestId =
    typeof requestIdValue === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestIdValue)
      ? requestIdValue
      : undefined;
  const clientRequestIdValue = readField("clientRequestId");
  const clientRequestId =
    typeof clientRequestIdValue === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(clientRequestIdValue)
      ? clientRequestIdValue
      : undefined;
  const rawIssues = readField("issues");
  const issues = (Array.isArray(rawIssues) ? rawIssues : [])
    .map(sanitizeIssue)
    .filter((issue): issue is ConversationShareFailureIssue => issue !== null);
  // issueCount 缺省时才回退到实际保留条数，服务端给了总数就以总数为准。
  // omittedIssueCount 只反映被截断的数量，保底为零，不出现负数。
  // 两个计数与 issues 长度可以不一致，UI 必须分别展示而不是互相推导。
  // 不在此处补全被丢弃的 issue，占位数据会污染「取消选择」的定位。
  const issueCountValue = readField("issueCount");
  const issueCount = typeof issueCountValue === "number" ? issueCountValue : issues.length;
  const omittedIssueCountValue = readField("omittedIssueCount");
  const omittedIssueCount =
    typeof omittedIssueCountValue === "number"
      ? omittedIssueCountValue
      : Math.max(0, issueCount - issues.length);
  // 用 safeParse 而不是 parse，校验失败只少一个字段，不能让整个错误态失败。
  // schema 由 shared 包维护，前端不重复定义字段形状。
  // 校验通过才写入，避免半截结构让下游按类型分支时读到 undefined。
  const rejection = conversationShareRejectionSchema.safeParse(readField("rejection"));
  return {
    name,
    kind,
    ...(rejection.success ? { rejection: rejection.data } : {}),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(Object.keys(diagnostics).length === 0 ? {} : { diagnostics }),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
    ...(issues.length === 0 ? {} : { issues }),
    ...(issueCount === 0 ? {} : { issueCount }),
    ...(omittedIssueCount === 0 ? {} : { omittedIssueCount }),
  };
}

// 摘要只暴露标题 id、问题数与轮次，具体条目由调用方另行渲染。
// issueCount 取详情里的总数，其次是实际条目数，缺失时为零。
// 轮次用 Set 去重后升序，保持与时间线一致的阅读顺序。
// 轮次只用于文案定位，不能替代 productTurnId 作为操作参数。
export function formatConversationShareErrorSummary(error: unknown): {
  titleId: string;
  issueCount: number;
  turnOrdinals: number[];
} {
  const details = getConversationShareErrorDetails(error);
  return {
    titleId: "conversationShare.error.summary",
    issueCount: details.issueCount ?? details.issues?.length ?? 0,
    turnOrdinals: [
      ...new Set(
        (details.issues ?? []).flatMap((issue) =>
          issue.turnOrdinal === undefined ? [] : [issue.turnOrdinal],
        ),
      ),
    ].sort((left, right) => left - right),
  };
}

// 键集合必须与 ConversationShareFailureIssue 的 code 联合类型完全一致。
// 新增 code 时先补这里，否则运行时会退回 unknown 文案。
// 多个 code 共用一条文案是有意合并，不要按名词拆分制造重复翻译。
// 删除条目会让 resolveConversationShareFallbackIssueCode 的存在性判定失效。
const ISSUE_MESSAGE_IDS: Readonly<Record<ConversationShareFailureIssue["code"], string>> = {
  authentication_required: "conversationShare.error.authenticationRequired",
  network: "conversationShare.error.network",
  service_unavailable: "conversationShare.error.serviceUnavailable",
  rate_limited: "conversationShare.error.rateLimited",
  feature_disabled: "conversationShare.error.featureDisabled",
  connection_unavailable: "conversationShare.error.connectionUnavailable",
  invalid_contract: "conversationShare.issue.invalidServiceResponse",
  disclosure_required: "conversationShare.error.disclosureRequired",

  artifact_type_not_allowed: "conversationShare.issue.artifactTypeNotAllowed",
  artifact_extension_missing: "conversationShare.issue.artifactExtensionMissing",
  artifact_outside_workspace: "conversationShare.issue.artifactOutsideWorkspace",
  artifact_changed: "conversationShare.issue.artifactChanged",
  content_unavailable: "conversationShare.issue.contentUnavailable",
  artifact_read_failed: "conversationShare.issue.artifactReadFailed",
  input_attachment: "conversationShare.issue.inputAttachment",
  input_attachment_unavailable: "conversationShare.issue.inputAttachmentUnavailable",
  inline_tool_image: "conversationShare.issue.inlineToolImage",
  running_turn: "conversationShare.issue.runningTurn",
  streaming_row: "conversationShare.issue.streamingRow",
  active_tool_call: "conversationShare.issue.activeToolCall",
  active_subagent: "conversationShare.issue.activeSubagent",
  unsupported_timeline: "conversationShare.issue.unsupportedTimeline",
  unsafe_url: "conversationShare.issue.unsafeUrl",
  missing_product_turn: "conversationShare.issue.missingProductTurn",
  invalid_selection: "conversationShare.issue.invalidSelection",
  invalid_conversation: "conversationShare.issue.invalidConversation",
  artifact_protocol_not_ready: "conversationShare.issue.invalidConversation",
  payload_limit: "conversationShare.issue.payloadSizeLimit",
  stale_conversation: "conversationShare.issue.staleConversation",
  rows_limit: "conversationShare.issue.rowsLimit",
  artifact_count_limit: "conversationShare.issue.artifactCountLimit",
  artifact_size_limit: "conversationShare.issue.artifactSizeLimit",
  artifact_total_size_limit: "conversationShare.issue.artifactTotalSizeLimit",
  payload_size_limit: "conversationShare.issue.payloadSizeLimit",
  artifact_manifest: "conversationShare.issue.artifactManifest",
  no_shareable_content: "conversationShare.issue.noShareableContent",
  upload_incomplete: "conversationShare.issue.uploadIncomplete",
  unknown: "conversationShare.issue.unknown",
};

export function resolveConversationShareIssueMessageId(
  issue: ConversationShareFailureIssue,
): string {
  return ISSUE_MESSAGE_IDS[issue.code] ?? ISSUE_MESSAGE_IDS.unknown;
}

// 只收录「可跳过、不阻断发布」的 code，其余继续走 issue 文案。
// 同一 code 在阻断与警告两种语境下语气不同，不能共用一个 key。
// content_unavailable 仍复用 issue 文案，因为该问题对用户没有操作差异。
// 这是 Partial 映射，缺失键由 resolveConversationShareWarningMessageId 兜底。
/**
 * 非阻断提示用独立文案：issue 版是「请确认文件仍存在后重试」的阻断语气，
 * warning 版要表达「已跳过、发布照常完成」。
 */
const WARNING_MESSAGE_IDS: Readonly<
  Partial<Record<ConversationShareFailureIssue["code"], string>>
> = {
  artifact_type_not_allowed: "conversationShare.warning.artifactTypeSkipped",
  artifact_changed: "conversationShare.warning.artifactChangedSkipped",
  content_unavailable: "conversationShare.issue.contentUnavailable",
  artifact_read_failed: "conversationShare.warning.artifactSkipped",
  input_attachment: "conversationShare.warning.inputAttachmentSkipped",
  input_attachment_unavailable: "conversationShare.warning.inputAttachmentUnavailable",
};

const ARTIFACT_TYPE_LABELS: Readonly<Record<string, { zh: string; en: string }>> = {
  pdf: { zh: "PDF", en: "PDF" },
  pptx: { zh: "PPT", en: "PowerPoint" },
  docx: { zh: "Word 文档", en: "Word document" },
  xlsx: { zh: "Excel 表格", en: "Excel spreadsheet" },
  image: { zh: "图片", en: "image" },
  html: { zh: "HTML", en: "HTML" },
  md: { zh: "Markdown", en: "Markdown" },
  text: { zh: "纯文本", en: "plain text" },
  video: { zh: "视频", en: "video" },
  audio: { zh: "音频", en: "audio" },
};

// 先去掉前导点再转小写，让 .PDF、Pdf 与 pdf 命中同一个标签。
// locale 只区分 en-US 与其他，其余语言统一使用中文标签。
// 未收录的类型回退为大写原值，保留用户可识别的扩展名。
// 不做截断，标签长度由调用方布局控制。
function artifactLabel(value: string, locale: string): string {
  const key = value.replace(/^\./u, "").toLowerCase();
  return ARTIFACT_TYPE_LABELS[key]?.[locale === "en-US" ? "en" : "zh"] ?? value.toUpperCase();
}

// 依次取类型、扩展名、MIME，最后兜底为「文件」。
// 兜底值刻意不参与本地化映射，保证任何语言下都不是空串。
// `formatConversationShareArtifactType` 只负责展示，不校验类型是否合法。
export function formatConversationShareArtifactType(
  issue: ConversationShareFailureIssue,
  locale: string,
): string {
  const value = issue.artifactType || issue.extension || issue.mimeType || "文件";
  return artifactLabel(value, locale);
}

// 优先用服务端给出的 artifact 清单，逐项取 displayName 或 type。
// 标签去重后再拼接，避免同一类型因大小写差异重复出现。
// 分隔符随 locale 变化：英文用逗号加空格，中文用顿号。
// 两处兜底分别对应「能给格式」与「完全拿不到」，文案不可合并。
export function formatConversationShareAllowedArtifacts(
  issue: ConversationShareFailureIssue,
  locale: string,
): string {
  if (issue.allowedArtifacts && issue.allowedArtifacts.length > 0) {
    const labels = issue.allowedArtifacts.map((artifact) =>
      artifactLabel(artifact.displayName || artifact.type, locale),
    );
    return [...new Set(labels)].join(locale === "en-US" ? ", " : "、");
  }
  if (issue.allowedFormats && issue.allowedFormats.length > 0) {
    return issue.allowedFormats.join(locale === "en-US" ? ", " : "、");
  }
  return locale === "en-US" ? "temporarily unavailable" : "暂时无法获取";
}

// 先查警告专用表，再回退到 issue 表，最后落到 unknown。
// 回退链保证任何 code 都能得到可渲染文案。
// 不要在这里临时改语气，文案差异属于翻译资源。
export function resolveConversationShareWarningMessageId(
  issue: ConversationShareFailureIssue,
): string {
  return WARNING_MESSAGE_IDS[issue.code] ?? resolveConversationShareIssueMessageId(issue);
}

/** Host 侧已脱敏，这里仍复用同一套校验兜底，避免 progress 载荷被改动后泄漏路径。 */
// Host 侧已脱敏，这里仍复用 sanitizeIssue，防止 progress 载荷中途被改写。
// 非数组直接返回空数组，进度载荷可能整体缺失。
// 剔除 inline_tool_image 与 unsupported_timeline：这两类在警告语境下用户无法处理。
// 返回值只读，调用方不应再追加或重排。
export function sanitizeConversationShareWarnings(
  value: unknown,
): readonly ConversationShareFailureIssue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(sanitizeIssue)
    .filter(
      (issue): issue is ConversationShareFailureIssue =>
        issue !== null &&
        issue.code !== "inline_tool_image" &&
        issue.code !== "unsupported_timeline",
    );
}

// 先看 reasonCode 是否属于已知 issue code，这是最精确的映射。
// 再按 kind 做语义映射：invalid_conversation 与 artifact_not_allowed 各自对应。
// kind 本身也是 issue code 时直接采用，覆盖登录态缺失等预检早期失败。
// 全部落空才返回 unknown，保证调用方永远拿得到 code。
export function resolveConversationShareFallbackIssueCode(
  details: ConversationShareErrorDetails,
): ConversationShareFailureIssue["code"] {
  const reasonCode = details.reasonCode as ConversationShareFailureIssue["code"] | undefined;
  if (reasonCode && Object.prototype.hasOwnProperty.call(ISSUE_MESSAGE_IDS, reasonCode)) {
    return reasonCode;
  }
  if (details.kind === "invalid_conversation") return "invalid_conversation";
  if (details.kind === "artifact_not_allowed") return "artifact_type_not_allowed";
  if (details.kind === "limit_exceeded") return "payload_limit";
  if (details.kind === "upload_incomplete") return "upload_incomplete";
  // 预检可能在读取 capabilities 前因缺少登录态失败，不能把已知 kind 丢成 unknown。
  if (Object.prototype.hasOwnProperty.call(ISSUE_MESSAGE_IDS, details.kind)) {
    return details.kind as ConversationShareFailureIssue["code"];
  }
  return "unknown";
}

// invalid_contract 且带 4xx 或 5xx 状态时走 HTTP 文案，先于 reason 与 kind。
// reasonCode 优先于 kind：细分原因更接近用户该做的事。
// 最后按 kind 查表，未收录的 kind 回退到 publishFailed。
// 顺序不可调整，改动会让同一错误在不同入口显示不同文案。
export function resolveConversationSharePublishErrorMessageId(error: unknown): string {
  const { kind, reasonCode, status } = getConversationShareErrorDetails(error);
  if (kind === "invalid_contract" && status !== undefined && status >= 400)
    return "conversationShare.error.invalidContractHttp";
  if (reasonCode && PUBLISH_ERROR_MESSAGE_BY_REASON[reasonCode]) {
    return PUBLISH_ERROR_MESSAGE_BY_REASON[reasonCode];
  }
  return PUBLISH_ERROR_MESSAGE_BY_KIND[kind] ?? "conversationShare.publishFailed";
}
