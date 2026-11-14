// INV-01 纯函数：守住位置 全部导出；改错故障 归约过程中改写投影行。
// INV-02 未完成不产出结果：守住位置 pending 与 in_progress 早退；改错故障 面板显示占位结果。
// INV-03 stopped 走 cancelled 通道：守住位置 isPluginUiToolCancelled；改错故障 被停止的工具伪装成成功。
// INV-04 结构化内容优先数组：守住位置 rawContent 分支；改错故障 图片与资源块丢失。
// INV-05 非对象内容块在此过滤：守住位置 filter 类型守卫；改错故障 宿主收到非法块。
// INV-06 截断只写 _meta：守住位置 mergedMeta；改错故障 内容被替换成提示文本。
// INV-07 isError 合并两种来源：守住位置 展开三元；改错故障 失败结果在面板上显示为成功。
// INV-08 surface 三重匹配：守住位置 kind / surface / pluginId；改错故障 同插件多 surface 串数据。
// INV-09 binding 校验服务与资源：守住位置 serverName 与 resourceUri；改错故障 同名 surface 跨服务污染。
// INV-10 latest 只按 rowId 前进：守住位置 比较链；改错故障 旧行覆盖新行。
// INV-11 同 rowId 状态变化也更新：守住位置 第二个或条件；改错故障 状态标签停在旧值。
// INV-12 result 只由成功且非 isError 覆盖：守住位置 双条件；改错故障 失败结果替换掉上一份好数据。
// INV-13 无变化返回原对象：守住位置 末尾三元；改错故障 宿主每次归约都重发 tool-result。
// INV-14 merge 与 reduce 同一新优规则：守住位置 mergePluginUiSurfaceFeed；改错故障 两条路径收敛到不同快照。
//
// 模块职责：MCP Apps 面板的工具行投喂，包含结果构造、surface 归约与快照合并。
// 阅读顺序：先看输入与结果构造，再看 surface 匹配与归约，最后看合并函数。
import type { McpAppsToolResultPayload } from "@zcode/shared/mcp-apps";
import { MCP_APPS_TRUNCATED_META_KEY } from "@zcode/shared/mcp-apps";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { PluginUiPresentation } from "../contract.js";
import { parseJsonText, readPluginUiPresentation } from "./readPluginUiPresentation.js";

/** 内联卡片与侧栏共用的 legacy ChatToolCall 子集（toolCallRowAdapter 输出）。 */
export interface PluginUiLegacyToolCall {
  status: string;
  input: unknown;
  output?: unknown;
}

// 只有普通对象才作为输入返回。
export function readPluginUiToolInput(
  toolCall: PluginUiLegacyToolCall | null,
): Record<string, unknown> | undefined {
  return toolCall &&
    typeof toolCall.input === "object" &&
    toolCall.input !== null &&
    !Array.isArray(toolCall.input)
    ? (toolCall.input as Record<string, unknown>)
    : undefined;
}

/** 被停止的工具不再伪装成普通结果，而是走 ui/notifications/tool-cancelled。 */
// 停止是唯一改走 cancelled 通道的状态。
export function isPluginUiToolCancelled(toolCall: PluginUiLegacyToolCall | null): boolean {
  return toolCall?.status === "stopped";
}

/**
 * 工具行 → MCP Apps tool-result 通知载荷。legacy 状态词表：pending / in_progress / completed / failed / stopped；
 * 未完成不产出；stopped 不产出（改发 cancelled 通知）。structuredContent / widgetMeta 从 display.ui 的 JSON 文本恢复。
 */
export function buildPluginUiToolResult(
  toolCall: PluginUiLegacyToolCall | null,
  presentation: PluginUiPresentation | null,
): McpAppsToolResultPayload | undefined {
  // `toolCall` 或 `presentation` 缺一即返回 undefined：上游没有可下发的工具结果。
  if (!toolCall || !presentation) return undefined;
  // 未完成不产出结果。
  if (toolCall.status === "pending" || toolCall.status === "in_progress") return undefined;
  if (isPluginUiToolCancelled(toolCall)) return undefined;
  const structured = parseJsonText(presentation.structuredContent);
  const meta = parseJsonText(presentation.widgetMeta);
  // H12：优先用 agent 投影的原始 content 数组（图片 / 资源块不丢）；没有时退回纯文本。
  // 优先使用 agent 投影的原始内容数组。
  const rawContent = parseJsonText(presentation.content);
  // 数组内的非对象块在这里丢弃。
  const content = Array.isArray(rawContent)
    ? (rawContent.filter(
        (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
      ) as Array<Record<string, unknown>>)
    : typeof toolCall.output === "string"
      ? [{ type: "text", text: toolCall.output }]
      : [];
  const baseMeta =
    typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  // H12：超限字段已被 agent 省略；页面从 _meta["zcode/truncated"].bytes 得知并可用 tools/call 重取。
  // 截断只写 _meta，不改内容。
  const mergedMeta = presentation.truncated
    ? { ...baseMeta, [MCP_APPS_TRUNCATED_META_KEY]: { bytes: presentation.truncatedBytes ?? 0 } }
    : baseMeta;
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    // 两种失败来源合并成一个标志。
    ...(toolCall.status === "failed" || presentation.isError ? { isError: true } : {}),
    ...(Object.keys(mergedMeta).length > 0 ? { _meta: mergedMeta } : {}),
  };
}

export function findToolRowById(
  rows: readonly ConversationRow[],
  toolCallId: string,
): ToolCallRow | null {
  const row = rows.find(
    (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === toolCallId,
  );
  return row && row.kind === "toolCall" ? row : null;
}

/** 面板投喂快照里的一条工具行摘要。 */
export interface PluginUiSurfaceFeedEntry {
  rowId: number;
  toolCallId: string;
  status: ToolCallRow["status"];
  presentation: PluginUiPresentation;
  input: Record<string, unknown> | undefined;
}

/**
 * 面板（surface）投喂快照。`latest` 是该 surface 最新一条工具行（任意状态，投喂 tool-input、
 * 判断 cancelled）；`result` 是最后一次成功结果，running / failed / cancelled / MCP isError 不覆盖它——面板在下一次成功前
 * 一直显示上一份好结果。两者只按 rowId 单调前进，投影窗口被裁掉旧行时快照仍在。
 */
export interface PluginUiSurfaceFeed {
  latest: PluginUiSurfaceFeedEntry | null;
  result: (PluginUiSurfaceFeedEntry & { toolResult: McpAppsToolResultPayload }) | null;
}

export const EMPTY_PLUGIN_UI_SURFACE_FEED: PluginUiSurfaceFeed = { latest: null, result: null };

// v4 status → buildPluginUiToolResult 用的 legacy 词表（与 v4/toolCallRowAdapter 的 STATUS_MAP 同义，
// 这里不引 adapter：domain 只依赖协议行类型）。
const LEGACY_STATUS: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

function readSurfacePresentation(
  row: ToolCallRow,
  surfaceId: string,
  pluginId: string,
): PluginUiPresentation | null {
  const display = row.display;
  if (
    // 三类身份必须同时匹配。
    display?.kind !== "mcp_tool" ||
    display.ui?.surface !== surfaceId ||
    display.ui.pluginId !== pluginId
  )
    return null;
  return readPluginUiPresentation({ display });
}

function toSurfaceFeedEntry(
  row: ToolCallRow,
  presentation: PluginUiPresentation,
): PluginUiSurfaceFeedEntry {
  return {
    rowId: row.rowId,
    toolCallId: row.toolCallId,
    status: row.status,
    presentation,
    input: readPluginUiToolInput({ status: row.status, input: row.input }),
  };
}

/**
 * 纯归约：把一批投影行并进快照。同一 rowId 只在状态变化时更新 `latest`；`result` 在成功行首次出现时构造一次，
 * 之后同 rowId 不重建（保持引用稳定，宿主据引用判断是否重发 tool-result）。无变化时返回原对象。
 */
export function reducePluginUiSurfaceFeed(
  previous: PluginUiSurfaceFeed,
  rows: readonly ConversationRow[],
  surfaceId: string,
  pluginId: string,
  binding?: { serverName?: string; resourceUri: string },
): PluginUiSurfaceFeed {
  let latest = previous.latest;
  let result = previous.result;
  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    const presentation = readSurfacePresentation(row, surfaceId, pluginId);
    if (
      !presentation ||
      (binding &&
        // 绑定校验防止同 surface 跨服务串流。
        (presentation.serverName !== binding.serverName ||
          presentation.resourceUri !== binding.resourceUri))
    )
      continue;
    if (
      !latest ||
      // latest 只按 rowId 前进。
      row.rowId > latest.rowId ||
      (row.rowId === latest.rowId && row.status !== latest.status)
    ) {
      latest = toSurfaceFeedEntry(row, presentation);
    }
    // MCP isError 的调用在 v4 行上是 success（模型视角已完成），对面板来说是失败：不覆盖上一份好结果。
    if (
      row.status === "success" &&
      // MCP isError 不覆盖上一份好结果。
      !presentation.isError &&
      (!result || row.rowId > result.rowId)
    ) {
      const toolResult = buildPluginUiToolResult(
        { status: LEGACY_STATUS[row.status], input: row.input, output: row.output?.text },
        presentation,
      );
      if (toolResult) result = { ...toSurfaceFeedEntry(row, presentation), toolResult };
    }
  }
  // 无变化返回原对象，保持引用稳定。
  return latest === previous.latest && result === previous.result ? previous : { latest, result };
}

/** 两份快照按 rowId 取新（store 合并用）：谁的行更新用谁的。 */
export function mergePluginUiSurfaceFeed(
  current: PluginUiSurfaceFeed,
  candidate: PluginUiSurfaceFeed,
): PluginUiSurfaceFeed {
  const latest =
    candidate.latest &&
    (!current.latest ||
      candidate.latest.rowId > current.latest.rowId ||
      (candidate.latest.rowId === current.latest.rowId &&
        candidate.latest.status !== current.latest.status))
      ? candidate.latest
      : current.latest;
  const result =
    candidate.result && (!current.result || candidate.result.rowId > current.result.rowId)
      ? candidate.result
      : current.result;
  return latest === current.latest && result === current.result ? current : { latest, result };
}
