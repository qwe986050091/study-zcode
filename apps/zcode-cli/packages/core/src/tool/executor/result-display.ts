// INV-01 display 与 modelContent 两条通道：守住位置 文件头说明；改错故障 展示约束反过来压缩模型上下文。
// INV-02 display 每个字段自带上限：守住位置 各常量；改错故障 单条事件携带数百 KB。
// INV-03 分派按专用到通用：守住位置 createToolResultDisplay 顺序；改错故障 文件 diff 抢走 Bash 结果。
// INV-04 MCP 先于本地工具名：守住位置 mcp 分支位置；改错故障 同名工具显示成错误卡片。
// INV-05 解析失败一律返回未定义：守住位置 safeParse 分支；改错故障 展示构造失败拖垮工具执行。
// INV-06 MCP 元数据缺失直接放弃：守住位置 metadata 判空；改错故障 空工具卡占用界面。
// INV-07 服务器名与工具名都必需：守住位置 双字段判空；改错故障 工具卡无法归因。
// INV-08 官方不可用标识仅官方通道可读：守住位置 official 判断；改错故障 第三方伪造提示诱导购买。
// INV-09 错误标识必须 isError 且 content 为数组：守住位置 三条件与判断；改错故障 正常结果被误判。
// INV-10 JSON 投影超限整体省略：守住位置 boundJsonText；改错故障 半截 JSON 进入持久化。
// INV-11 截断字节数累加记录：守住位置 dropped 归约；改错故障 界面无法判断省略规模。
// INV-12 布尔字段只投影真值：守住位置 展开条件；改错故障 metadata 出现大量假值键。
// INV-13 文本边界避开代理对：守住位置 boundMcpDisplayText；改错故障 持久化出现孤立代理项。
// INV-14 CUA 名称归一化后再识别：守住位置 小写与替换；改错故障 插件命名空间工具不被识别。
// INV-15 媒体按解码后字节计配额：守住位置 base64 长度；改错故障 实际传输体积被低估。
// INV-16 媒体数量有硬上限：守住位置 长度判断；改错故障 一次事件塞入过多截图。
// INV-17 diff 行数与块数双上限：守住位置 两个常量；改错故障 大补丁撑爆历史快照。
// INV-18 半截块后立即停止：守住位置 截断后 break；改错故障 UI 混排完整与残缺块。
//
// 模块职责：把工具输出投影成前端可渲染的有界展示载荷。
// 状态所有权：无状态；全部为纯构造，失败即返回未定义。
// 阅读顺序：先看分派顺序，再看 MCP 与 CUA 投影，最后看 diff 限量。
/**
 * ============================================================================
 * executor/result-display.ts —— 工具结果的"UI 展示投影"
 * ============================================================================
 *
 * 【定位】display 与 modelContent 是两条独立通道:
 *   modelContent  进模型上下文,受 resultBudget 约束;
 *   display       进实时事件 + 持久化 metadata,给前端渲染工具卡。
 * 因此这里的所有字段都必须**自带有界约束**(字符/字节/条数),不能把完整输出、
 * 完整 XML 或 artifact URI 原样塞进 display——那会撑爆事件与历史快照。
 *
 * 【分派顺序】createToolResultDisplay 按"专用工具 → MCP → 通用 diff"依次尝试:
 *   Bash / CUA / node_repl / workflow / MCP / 本地工具消息 / 文件 diff。
 * 专用分支在前,保证同一工具不会被后面的通用分支误判成别种展示。
 *
 * 【失败即 undefined】任一结构化解析失败就返回 undefined,让调用方退回通用卡片;
 * display 是可选增强,任何情况下都不能让工具执行本身因"展示构造失败"而失败。
 * ============================================================================
 */
import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RespondToCoordinatorOutputSchema,
  MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS,
  MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  CUA_TARGET_APP_DISPLAY_META_KEY,
  cuaTargetAppDisplaySchema,
  nodeReplCuaAppDisplaySchema,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageOutputSchema,
  TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS,
  TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputResultSchema,
  TASK_STOP_TOOL_NAME,
  TaskStopOutputSchema,
  type DiffHunk,
  type NodeReplCuaAppDisplay,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import { createBashResultDisplay } from "./bash-result-display.js";
import { countPatchLines } from "../diff.js";
import { boundDisplayText } from "./display-text.js";
import { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { createWorkflowObservationDisplay } from "./workflow-observation-display.js";

// 拆到 create-workflow-display.ts 后保持既有导出面（handlers/create-workflow.ts 仍从这里 import）。
export { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { isRecord } from "./utils.js";
import { parseOfficialMcpToolError, type OfficialMcpToolErrorCode } from "@zcode/shared";
import {
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_WIDGET_META_MAX_BYTES,
  type McpToolDisplayUi,
  type McpToolUiDescriptor,
} from "@zcode/shared/mcp-apps";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "@zcode/zcode-cua/request-access-contract";

// display 侧的硬上限:与 modelContent 的 resultBudget 无关,独立约束事件/快照体积。
// diff 块数上限八。
// MAX_DISPLAY_DIFF_LINES 取 160 行。
// MAX_DISPLAY_DIFF_HUNKS 与 MAX_DISPLAY_DIFF_LINES 两个上限独立生效。
// 两个上限只约束 display 通道的体积。
// 与 modelContent 的 resultBudget 无关。
const MAX_DISPLAY_DIFF_HUNKS = 8;
const MAX_DISPLAY_DIFF_LINES = 160;
const MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES = 4 * 1024;
const MAX_TASK_STOP_DISPLAY_FIELD_BYTES = 16 * 1024;
// 单张内联图 base64 上限:超过的截图不进 display,避免一条事件携带数百 KB 文本。
export const MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES = 200 * 1024;
const MAX_NODE_REPL_DISPLAY_IMAGES = 2;

export interface McpToolDisplayMetadata {
  serverName: string;
  toolName: string;
  description?: string;
  official?: boolean;
  pluginId?: string;
  ui?: McpToolUiDescriptor;
}

export function createMcpToolDisplay(
  metadata: McpToolDisplayMetadata | undefined,
  output?: unknown,
): ToolResultDisplayPayload | undefined {
  if (!metadata) return undefined;
  // metadata 缺失直接返回 undefined：display 是可选增强，不能因为没有 MCP 元数据就报错。
  const serverName = boundMcpDisplayText(metadata.serverName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  const toolName = boundMcpDisplayText(metadata.toolName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  // serverName/toolName 任一为空都返回 undefined：MCP 工具卡必须能定位到具体 server+tool，
  // 缺任何一个都会让 UI 无法渲染或归因错误。
  if (!serverName || !toolName) return undefined;
  const description = metadata.description
    ? boundMcpDisplayText(metadata.description, MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS)
    : undefined;
  const unavailable = metadata.official ? readOfficialMcpUnavailable(output) : undefined;
  const ui = createMcpToolDisplayUi(metadata, output);
  return {
    kind: "mcp_tool",
    serverName,
    toolName,
    ...(description ? { description } : {}),
    ...(unavailable ? { unavailable } : {}),
    ...(ui ? { ui } : {}),
  };
}

/**
 * MCP App 元数据投影。任何 MCP server 的工具只要声明了 ui 资源就存在（归属看 serverName）；
 * pluginId 只做展示 / 键位，非插件 server 用 serverName 顶替。structuredContent / _meta 以 JSON 文本
 * 进入持久化 metadata，超限截断并置 truncated，UI 据此提示"结构化结果被截断"。
 */
function createMcpToolDisplayUi(
  metadata: McpToolDisplayMetadata,
  output: unknown,
): McpToolDisplayUi | undefined {
  if (!metadata.ui) return undefined;
  // 没有 ui 声明就没有可投影的 App 元数据，直接返回 undefined。
  const pluginId = boundMcpDisplayText(
    metadata.pluginId ?? metadata.serverName,
    MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  );
  // pluginId 为空说明 serverName/pluginId 都无效，无法定位 UI 资源归属。
  if (!pluginId) return undefined;
  const record = isRecord(output) ? output : undefined;
  // 三个 JSON 字段都按 UTF-8 字节封顶；超限整个省略（不产生半截 JSON），记 truncatedBytes。
  const structured = boundJsonText(
    record?.structuredContent,
    MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  );
  const meta = boundJsonText(record?._meta, MCP_APPS_WIDGET_META_MAX_BYTES);
  const content = boundJsonText(
    Array.isArray(record?.content) ? record.content : undefined,
    MCP_APPS_CONTENT_MAX_BYTES,
  );
  const dropped = [structured, meta, content].filter(
    (item): item is { truncated: true; bytes: number } => item?.truncated === true,
  );
  const truncatedBytes = dropped.reduce((sum, item) => sum + item.bytes, 0);
  return {
    pluginId,
    resourceUri: metadata.ui.resourceUri,
    ...(metadata.ui.preferredDisplayMode
      ? { preferredDisplayMode: metadata.ui.preferredDisplayMode }
      : {}),
    ...(metadata.ui.prefersBorder !== undefined
      ? { prefersBorder: metadata.ui.prefersBorder }
      : {}),
    ...(metadata.ui.csp ? { csp: metadata.ui.csp } : {}),
    ...(structured && !structured.truncated ? { structuredContent: structured.text } : {}),
    ...(meta && !meta.truncated ? { widgetMeta: meta.text } : {}),
    ...(content && !content.truncated ? { content: content.text } : {}),
    ...(dropped.length > 0 ? { truncated: true, truncatedBytes } : {}),
    // H06：MCP isError 的调用在 v4 行上仍是 success（模型视角已完成），页面与面板要靠这个字段区分。
    ...(record?.isError === true ? { isError: true as const } : {}),
    ...(metadata.ui.surface ? { surface: metadata.ui.surface } : {}),
    // 4b-1：只投影 true；false / 缺省都不占字段。
    ...(metadata.ui.showInline === true ? { showInline: true as const } : {}),
  };
}

/** JSON 文本按 UTF-8 字节封顶：≤ 上限返回文本，超限只返回字节数（不截断字符串）。 */
function boundJsonText(
  value: unknown,
  maxBytes: number,
): { text: string; truncated: false } | { truncated: true; bytes: number } | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof text !== "string") return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  return { truncated: true, bytes };
}

/**
 * 官方 Server MCP 在配额耗尽 / 无 Coding Plan 时把结构化标识渲染进 tool error content 的
 * JSON 文本（服务端 `ToolError.Error()`）。这里只读该标识，不解析普通错误文案。
 *
 * 仅在 `metadata.official` 为真时才会走到，而该标记只对 **http** 官方 MCP 置位——那种形态的
 * 响应来自已校验 origin 的 ZCode 后端。stdio 官方 MCP 与第三方 MCP 塞同样的 payload 一律忽略：
 * 它们的结果由插件进程自己产出，可以伪造一条 Coding Plan 提示误导用户去购买。
 */
function readOfficialMcpUnavailable(
  output: unknown,
): { code: OfficialMcpToolErrorCode } | undefined {
  if (!isRecord(output) || output.isError !== true || !Array.isArray(output.content)) {
    // 三个条件必须同时满足：必须是错误结果且 content 是数组才能解析官方 MCP 错误标识。
    // 任一不满足直接返回 undefined，避免把正常结果或非数组 content 误判为不可用。
    return undefined;
  }
  for (const block of output.content) {
    // 只处理 text 类型的 block：官方 MCP 错误标识以文本形式嵌入，
    // 其他类型（image/resource）不可能包含该标识，直接跳过。
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const parsed = parseOfficialMcpToolError(block.text);
    // 命中即返回：同一个 content 里不会有多个错误标识，找到第一个就够了。
    if (parsed) return { code: parsed.code };
  }
  return undefined;
}

// Bash 分支最先短路。
// CUA 按名字子串识别。
// node_repl 与工作流依次尝试。
// MCP 分支优先于本地工具名。
// 全部未命中才走通用 diff。
export function createToolResultDisplay(
  toolName: string,
  output: unknown,
  options?: {
    officialCua?: boolean;
    mcp?: McpToolDisplayMetadata;
  },
): ToolResultDisplayPayload | undefined {
  // Bash 最先:它的输出形态与其他工具差异最大,且有自己的限长/截断逻辑。
  if (toolName === "Bash") return createBashResultDisplay(output);

  // CUA 按"名字含 computer_use"识别,兼容直接命名与 plugin 命名空间两种前缀。
  const cuaToolName = readCuaToolName(toolName);
  if (cuaToolName) {
    return createCuaToolResultDisplay(cuaToolName, output, options?.officialCua === true);
  }

  const nodeReplDisplay = createNodeReplDisplay(toolName, output);
  if (nodeReplDisplay) return nodeReplDisplay;

  const createWorkflow = createCreateWorkflowDisplay(toolName, output);
  if (createWorkflow) return createWorkflow;

  const workflowObservation = createWorkflowObservationDisplay(toolName, output);
  if (workflowObservation) return workflowObservation;

  if (options?.mcp) {
    // 结果级构造：官方 MCP 的不可用标识只能从本次结果里读，因此把 output 一起传进去。
    // MCP 放在本地工具消息之前:同名工具若来自 MCP server,应该显示为 MCP 工具卡,
    // 而不是被 SEND_MESSAGE 等本地分支截走。
    return createMcpToolDisplay(options.mcp, output);
  }

  if (toolName === SEND_MESSAGE_TOOL_NAME) {
    const parsed = SendMessageOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    // display 不经过 tool result budget，必须在进入实时事件和持久化 metadata 前单独限长。
    const error =
      parsed.data.error === undefined
        ? undefined
        : boundDisplayText(parsed.data.error, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    const message =
      parsed.data.message === undefined
        ? undefined
        : boundDisplayText(parsed.data.message, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    return {
      kind: "local_agent_message",
      status: parsed.data.status,
      ...(error !== undefined ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  if (toolName === TASK_STOP_TOOL_NAME) {
    const parsed = TaskStopOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const command =
      parsed.data.command === undefined
        ? undefined
        : boundDisplayText(parsed.data.command, MAX_TASK_STOP_DISPLAY_FIELD_BYTES);
    const message = boundDisplayText(
      compactTaskStopDisplayMessage(parsed.data),
      MAX_TASK_STOP_DISPLAY_FIELD_BYTES,
    );
    const truncated = command?.truncated === true || message.truncated;
    return {
      kind: "task_stop",
      taskId: parsed.data.task_id,
      taskType: parsed.data.task_type,
      ...(command !== undefined ? { command: command.value } : {}),
      message: message.value,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === TASK_OUTPUT_TOOL_NAME) {
    const parsed = TaskOutputResultSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const taskStatus = parsed.data.task?.status
      .trim()
      .slice(0, TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS);
    const fullOutput = parsed.data.task?.output.trimEnd();
    const hasOutput = fullOutput !== undefined && fullOutput.trim().length > 0;
    const truncated = hasOutput && fullOutput.length > TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS;

    // UI display 是独立于 provider content 的有界投影；禁止把完整 TaskOutput XML
    // 或结果对象塞进实时事件和持久化 metadata。
    return {
      kind: "task_output",
      retrievalStatus: parsed.data.retrieval_status,
      ...(taskStatus ? { taskStatus } : {}),
      ...(hasOutput ? { output: fullOutput.slice(0, TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS) } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === RESPOND_TO_COORDINATOR_TOOL_NAME) {
    const parsed = RespondToCoordinatorOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    return {
      kind: "respond_to_coordinator",
      status: parsed.data.status,
    };
  }

  // 通用兜底:任何 output 只要带 filePath + structuredPatch 就按文件 diff 展示
  // (Edit/Write 等工具走这条)。先过滤出合法 hunk 再计数,坏数据不会污染 additions/deletions。
  if (!isRecord(output)) return undefined;
  const filePath = output.filePath;
  const structuredPatch = output.structuredPatch;
  if (typeof filePath !== "string" || !Array.isArray(structuredPatch)) {
    return undefined;
  }

  const hunks = structuredPatch.filter(isDiffHunk);
  if (hunks.length === 0) return undefined;

  const { additions, deletions } = countPatchLines(hunks);
  const { patch: boundedPatch, truncated } = boundDiffHunks(hunks);
  return {
    kind: "file_diff",
    filePath,
    additions,
    deletions,
    structuredPatch: boundedPatch,
    truncated,
  };
}

// 先 trim() 掉首尾空白。
// 空串按 undefined 处理，视为未提供。
// 再按 maxChars 字符数截断。
// 截断点落在高位代理时 slice(0, -1) 回退一位。
// 保证返回值可安全 JSON.stringify()。
function boundMcpDisplayText(value: string, maxChars: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bounded = trimmed.slice(0, maxChars);
  // MCP discovery 是外部输入，直接 slice 可能在 UTF-16 surrogate pair
  // 中间截断，生成无法稳定跨事件、持久化和 replayable snapshot 的字符串。
  // 若边界落在高位 surrogate 后，丢弃这个半字符，保证 display 始终可安全序列化。
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  // 高位 surrogate（0xD800-0xDBFF）后面必须跟低位 surrogate 才能组成完整码点；
  // slice 在高位后截断会产生孤立高位代理，JSON.stringify 会把它变成 \uD800 转义，
  // 跨事件/持久化 replay 时可能不一致。丢掉这个半字符保证字符串始终可安全序列化。
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

const MAX_CUA_DISPLAY_FIELD_BYTES = 32 * 1024;
const MAX_CUA_INLINE_MEDIA_BYTES = 256 * 1024;
const MAX_CUA_INLINE_MEDIA_TOTAL_BYTES = 512 * 1024;

function readCuaToolName(toolName: string): string | undefined {
  // 兼容两种 CUA 工具命名：直接的 `mcp__computer_use__<action>` 与 plugin
  // 命名空间形式 `mcp__plugin_zcode-cua_computer-use__<action>`。
  // 归一化（小写 + `-`→`_`）后：名字包含 `computer_use`，且 action 是最后一个 `__` 之后的子串。
  const normalized = toolName.trim().toLowerCase().replaceAll("-", "_");
  if (!normalized.includes("computer_use")) return undefined;
  const lastSep = normalized.lastIndexOf("__");
  if (lastSep === -1) return undefined;
  const action = normalized.slice(lastSep + "__".length);
  return action.length > 0 ? action : undefined;
}

function createCuaToolResultDisplay(
  toolName: string,
  output: unknown,
  officialCua: boolean,
): ToolResultDisplayPayload {
  const result = isRecord(output) ? output : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  const structuredContent = result.structuredContent;
  const structuredRecord = isRecord(structuredContent) ? structuredContent : undefined;
  const errorRecord = isRecord(structuredRecord?.error) ? structuredRecord.error : undefined;
  const structuredJson =
    structuredContent === undefined
      ? undefined
      : boundDisplayText(safeJson(structuredContent), MAX_CUA_DISPLAY_FIELD_BYTES);
  const boundedText = text ? boundDisplayText(text, MAX_CUA_DISPLAY_FIELD_BYTES) : undefined;
  // artifact URI 只在 Agent 本地可读，直接投影会让多端 UI 收到无法渲染的媒体。
  // 在受控读取 API 建立前，display 只承载可直接渲染的内联图片。
  const media: Array<{ mimeType: string; data: string }> = [];
  let inlineMediaBytes = 0;
  let mediaTruncated = false;
  for (const item of content) {
    if (!isRecord(item)) continue;
    let projectedMedia: { mimeType: string; data: string } | undefined;
    let decodedBytes = 0;
    if (
      item.type === "image" &&
      typeof item.mimeType === "string" &&
      typeof item.data === "string"
    ) {
      // decodedBytes 是 base64 解码后的真实字节:base64 文本比原图大 33%,
      // 用解码后字节判断配额才准确(否则会低估实际传输体积)。
      decodedBytes = Buffer.byteLength(item.data, "base64");
      projectedMedia = { mimeType: item.mimeType, data: item.data };
    }
    if (!projectedMedia) continue;
    // media 配额只约束真实媒体，前置 text block 不能吞掉截图位置。
    // 最多 4 张:超过的标记 truncated,UI 据此提示"部分截图已省略"。
    if (media.length >= 4) {
      mediaTruncated = true;
      break;
    }
    // 单张超限(256KB)或累计超限(512KB)都跳过该图:
    // 不能把超大截图塞进 display 事件,否则一条事件会携带数 MB 文本。
    if (
      decodedBytes > MAX_CUA_INLINE_MEDIA_BYTES ||
      inlineMediaBytes + decodedBytes > MAX_CUA_INLINE_MEDIA_TOTAL_BYTES
    ) {
      mediaTruncated = true;
      continue;
    }
    inlineMediaBytes += decodedBytes;
    media.push(projectedMedia);
  }
  const truncated =
    mediaTruncated || structuredJson?.truncated === true || boundedText?.truncated === true;
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const targetApp = officialCua
    ? cuaTargetAppDisplaySchema.safeParse(meta?.[CUA_TARGET_APP_DISPLAY_META_KEY])
    : undefined;
  const permissionStatus =
    officialCua && toolName === "request_access"
      ? cuaRequestAccessStatusSchema.safeParse(meta?.[CUA_REQUEST_ACCESS_STATUS_META_KEY])
      : undefined;

  // MCP modelContent 会把 structuredContent 展平成文本；在展平前生成独立、有限长的
  // display，才能让实时事件和历史会话稳定区分 CUA 错误与结构化结果。
  return {
    kind: "cua",
    schemaVersion: 1,
    toolName,
    status: result.isError === true ? "failed" : "success",
    ...(structuredJson ? { structuredContent: structuredJson.value } : {}),
    ...(boundedText ? { text: boundedText.value } : {}),
    ...(typeof errorRecord?.code === "string" ? { errorCode: errorRecord.code } : {}),
    ...(typeof errorRecord?.suggested_action === "string"
      ? { suggestedAction: errorRecord.suggested_action }
      : {}),
    ...(targetApp?.success ? { targetApp: targetApp.data } : {}),
    ...(permissionStatus?.success ? { permissionStatus: permissionStatus.data } : {}),
    ...(media.length > 0 ? { media } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

/**
 * 读取宿主写入的 CUA 目标应用身份。
 *
 * 只认 `zcode/nodeReplCuaApp`：producer 自己的 `zcode.cua/app-associations-v1` 也可能出现在
 * `_meta` 里，但那个键经模型可写的 `nodeRepl.setResponseMeta` /
 * `nodeRepl.emitStructuredResult` 同样能到达，宿主已在 toMcpRunResult 里把它删掉。这里不做
 * 第二次兜底解析，避免把已经判定为不可信的来源重新接回展示面。
 */
function readNodeReplCuaApp(output: Record<string, unknown>): NodeReplCuaAppDisplay | undefined {
  const meta = isRecord(output._meta) ? output._meta : undefined;
  const parsed = nodeReplCuaAppDisplaySchema.safeParse(
    meta?.[ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

function createNodeReplDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== "js" && toolName !== "mcp__node_repl__js") return undefined;
  if (!isRecord(output)) return undefined;

  const candidates = [
    ...(Array.isArray(output.images) ? output.images : []),
    ...(Array.isArray(output.content) ? output.content : []),
  ];
  const images: Array<{ base64: string; mimeType: string }> = [];
  let truncated = false;

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const mimeType = candidate.mimeType;
    const encoded = candidate.base64 ?? candidate.data;
    if (
      // MIME 类型必须匹配 image/* 正则:防止非图片数据(如 PDF base64)被当成图片渲染。
      typeof mimeType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/iu.test(mimeType) ||
      typeof encoded !== "string"
    ) {
      continue;
    }
    // 去掉 data: URI 前缀:node_repl 可能返回 data:image/png;base64,xxx 格式,
    // display 只需要纯 base64 部分(前缀由 UI 根据 mimeType 自行拼接)。
    const base64 = encoded.startsWith("data:")
      ? encoded.slice(Math.max(0, encoded.indexOf(",") + 1))
      : encoded;
    if (
      base64.length === 0 ||
      // 单张 base64 超过 200KB 不进 display:避免一条事件携带数百 KB 文本。
      Buffer.byteLength(base64, "utf8") > MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES
    ) {
      truncated = true;
      continue;
    }
    // 最多 2 张:超过的标记 truncated,UI 据此提示"部分截图已省略"。
    if (images.length >= MAX_NODE_REPL_DISPLAY_IMAGES) {
      truncated = true;
      continue;
    }
    images.push({ base64, mimeType });
  }

  // 纯动作 cell（点击、输入）没有截图，但仍要把 App 身份投影给工具卡的 leading icon；
  // 因此不能再以「有图」作为产出 display 的唯一条件。
  const app = readNodeReplCuaApp(output);
  if (images.length === 0 && !app) return undefined;
  return {
    kind: "node_repl_images",
    ...(images.length > 0 ? { images } : {}),
    ...(app ? { app } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function compactTaskStopDisplayMessage(output: {
  command?: string;
  message: string;
  task_id: string;
}): string {
  if (output.command === undefined) {
    return output.message;
  }

  // TaskStop 的标准成功文案会把 command 再拼进括号；display 已有
  // 独立 command 字段，结果行只保留停止结论。
  const standardMessage = `Successfully stopped task: ${output.task_id} (${output.command})`;
  return output.message === standardMessage
    ? `Successfully stopped task: ${output.task_id}`
    : output.message;
}

function isDiffHunk(value: unknown): value is DiffHunk {
  // 防御性校验:structuredPatch 来自工具输出(可能是第三方 MCP),
  // 任何一个字段缺失或类型错误都不能当作合法 hunk，否则 countPatchLines 会读到 NaN。
  if (!isRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

// 先按 MAX_DISPLAY_DIFF_HUNKS 切分。
// 再按 remainingLines 分配行配额。
// 行配额耗尽时立刻把 truncated 置 true。
// 遇到超出配额的半截块就 break，停止追加。
function boundDiffHunks(hunks: DiffHunk[]): { patch: DiffHunk[]; truncated: boolean } {
  const bounded: DiffHunk[] = [];
  let remainingLines = MAX_DISPLAY_DIFF_LINES;
  let truncated = hunks.length > MAX_DISPLAY_DIFF_HUNKS;

  for (const hunk of hunks.slice(0, MAX_DISPLAY_DIFF_HUNKS)) {
    // remainingLines <= 0 说明行配额已用完，后续 hunk 全部截断。
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    // 只取前 remainingLines 行：保证 display 总 diff 行数不超过 MAX_DISPLAY_DIFF_LINES（160）。
    const lines = hunk.lines.slice(0, remainingLines);
    bounded.push({ ...hunk, lines });
    remainingLines -= lines.length;
    // 该 hunk 被截断（取的行数少于总行数）时标记 truncated 并停止，
    // 避免半截 hunk 与后续完整 hunk 混合导致 UI 显示不一致。
    if (lines.length < hunk.lines.length) {
      truncated = true;
      break;
    }
  }

  return { patch: bounded, truncated };
}
