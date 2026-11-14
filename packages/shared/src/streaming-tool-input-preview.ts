// INV-01 纯追加：守住位置 append 的拼接方式；改错故障：改写入参导致上游状态被篡改。
// INV-02 首块立即物化：守住位置 eager delta 阈值比较；改错故障：首个片段要等到下一次节流才出现。
// INV-03 后台不物化：守住位置 background-summary 分支；改错故障：非活跃任务争抢主线程。
// INV-04 文件类专用窗口：守住位置 isFileStreamingTool 分支；改错故障：Write/Edit 大参数每个 chunk 都做 diff。
// INV-05 双门控：守住位置 增长阈值与时间窗口的组合；改错故障：小输入被无限延迟或大输入频繁解析。
// INV-06 时间预算上限：守住位置 原始长度与上限的比较；改错故障：超大输入仍按时间窗口反复解析。
// INV-07 完整输入优先：守住位置 completeInput 判定；改错故障：已有完整输入仍走半截解析。
// INV-08 完整 JSON 判定：守住位置 parseCompleteJson 的 try；改错故障：解析异常冒泡打断流式渲染。
// INV-09 空预览兜底：守住位置 半截抽取的空结果；改错故障：input 为 undefined 引发读取异常。
// INV-10 键清单覆盖：守住位置 PARTIAL_JSON_STRING_FIELD_KEYS；改错故障：计划或脚本卡片要等结束才出现。
// INV-11 转义成对：守住位置 反斜杠扫描分支；改错故障：转义引号被当作字段结束。
// INV-12 悬空转义清理：守住位置 trimDanglingJsonEscape；改错故障：未闭合片段解析必失败。
// INV-13 解码降级：守住位置 decode 的 catch；改错故障：半截字符串直接丢失，预览空白。
// INV-14 正则转义：守住位置 escapeRegExp；改错故障：字段名中的特殊字符被当作正则元字符。
// INV-15 工具名归一：守住位置 trim 与小写；改错故障：Edit 与 edit 走不同节流路径。
// INV-16 物化标记：守住位置 mark 函数写入的两个时间字段；改错故障：节流窗口永远从零开始。
// INV-17 阈值常量集中：守住位置 文件顶部常量；改错故障：调用方各自硬编码窗口。
// INV-18 无副作用：守住位置 除 mark 外的导出；改错故障：纯函数读取全局时间导致不可测试。
//
// 模块职责：在工具输入尚未完整时提供可渲染的半截 JSON 预览，并控制物化频率。
// 状态所有权：流式状态由调用方持有；本文件只读状态并返回新对象或就地更新标记。
// 阅读顺序：状态与阈值 → 字段清单 → 追加与构建 → 物化判定 → 半截解析与解码。
export interface ZCodeStreamingToolInputState {
  deltaCount?: number;
  lastPreviewAt?: number;
  lastPreviewRawInputLength?: number;
  rawInput: string;
}

export interface ZCodeStreamingToolInputPreview {
  complete: boolean;
  input: unknown;
  rawInput: string;
}

export type ZCodeStreamingToolInputPreviewMode = "active-live" | "background-summary";

// 阈值集中在此：首个 delta 立即物化，后台摘要模式永不物化。
// 文件类工具用一秒窗口，其余工具用 750 毫秒加 8KB 增长双门控。
// 窗口与增长阈值是实时性与开销的取舍点，调小更跟手也更耗 CPU。
//
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT = 1;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 750;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH = 8 * 1024;
export const ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 1_000;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_TIME_BUDGET_MAX_RAW_INPUT =
  ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH;

// 半截 JSON 只抽取字符串字段，优先覆盖路径、正文与命令这些用户可见内容。
// 计划、名字与脚本为计划与工作流卡片服务，让草稿从首个 chunk 就更新。
// 数组顺序不影响结果，只决定预览对象的键顺序。
//
const PARTIAL_JSON_STRING_FIELD_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_path",
  "targetPath",
  "filename",
  "file",
  "content",
  "new_string",
  "newString",
  "new_text",
  "newText",
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "command",
  "description",
  "title",
  "pattern",
  "replacement",
  // ExitPlanMode 的正文位于 plan 字段。把它纳入半截 JSON 预览后，计划卡片与
  // 侧边详情才能从首个流式 chunk 开始更新，而不是等 input_end 才突然出现。
  "plan",
  // CreateWorkflow 的脚本与名字：流式草稿
  // 要在模型还在写脚本时就把站扫出来，半截 script 必须从首个 chunk 起就进预览。
  "name",
  "script",
] as const;

// 追加只做字符串拼接并累加 delta 计数，返回新对象而不改写入参。
// 状态可能为空，首块 delta 到来时按零值与空串起步。
//
export function appendZCodeStreamingToolInputDelta(
  state: ZCodeStreamingToolInputState | undefined,
  delta: string,
): ZCodeStreamingToolInputState {
  return {
    ...state,
    deltaCount: (state?.deltaCount ?? 0) + 1,
    rawInput: `${state?.rawInput ?? ""}${delta}`,
  };
}

// 已给出完整输入时直接判完成，不再尝试解析原始文本。
// 否则先按完整 JSON 解析，成功即完成，失败才退回半截字段抽取。
// 抽取不到任何字段时返回空对象，保证输入字段永远可读。
//
export function buildZCodeStreamingToolInputPreview(
  rawInput: string,
  completeInput?: unknown,
): ZCodeStreamingToolInputPreview {
  if (completeInput !== undefined) {
    return {
      complete: true,
      input: completeInput,
      rawInput,
    };
  }

  const parsed = parseCompleteJson(rawInput);
  if (parsed.ok) {
    return {
      complete: true,
      input: parsed.value,
      rawInput,
    };
  }

  return {
    complete: false,
    input: readPartialJsonObjectPreview(rawInput) ?? {},
    rawInput,
  };
}

// 后台摘要模式一律不物化，避免非活跃任务争抢主线程。
// 首个 delta 立即物化，让用户在等待期就看到首个片段。
// 文件类工具只按一秒时间窗口节流，不受增长提前触发。
// 其余工具先看原始输入增长是否越过 8KB，再看 750 毫秒窗口。
// 小输入在时间窗口内才物化，超过预算上限后改由增长控制。
//
export function shouldMaterializeZCodeStreamingToolInputPreview(
  state: ZCodeStreamingToolInputState,
  options: {
    mode?: ZCodeStreamingToolInputPreviewMode;
    now?: number;
    toolName?: string;
  } = {},
): boolean {
  if (options.mode === "background-summary") {
    return false;
  }
  const deltaCount = state.deltaCount ?? 0;
  if (deltaCount <= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT) {
    return true;
  }
  const lastPreviewAt = state.lastPreviewAt ?? 0;
  if (isZCodeFileStreamingToolInputPreviewTool(options.toolName)) {
    // 性能修复：Write/Edit 的半截 JSON 会触发全量内容恢复和行级 diff。
    // 大字节 chunk 不能绕过一秒窗口，否则模型输出越快，UI 反而更新越频繁。
    return (
      (options.now ?? Date.now()) - lastPreviewAt >=
      ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
    );
  }
  const lastPreviewRawInputLength = state.lastPreviewRawInputLength ?? 0;
  const rawGrowth = state.rawInput.length - lastPreviewRawInputLength;
  if (rawGrowth >= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH) {
    return true;
  }
  const intervalElapsed =
    (options.now ?? Date.now()) - lastPreviewAt >=
    ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS;
  if (!intervalElapsed) {
    return false;
  }
  // 性能修复：大 Write/Edit 参数通常会被 provider 以 4KB 左右的慢速 chunk 推送。
  // 若只按时间预算，active 任务仍会每个 chunk 解析累计 JSON；超过小输入范围后改由 raw growth 控制。
  return state.rawInput.length <= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_TIME_BUDGET_MAX_RAW_INPUT;
}

// 工具名先 trim 再小写，write 与 edit 视为文件类。
// 未知或缺省工具名不算文件类，走通用节流路径。
//
export function isZCodeFileStreamingToolInputPreviewTool(toolName?: string): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "write" || normalized === "edit";
}

export function markZCodeStreamingToolInputPreviewMaterialized(
  state: ZCodeStreamingToolInputState,
  now = Date.now(),
): void {
  state.lastPreviewAt = now;
  state.lastPreviewRawInputLength = state.rawInput.length;
}

function parseCompleteJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function readPartialJsonObjectPreview(rawInput: string): Record<string, string> | null {
  const preview: Record<string, string> = {};
  for (const key of PARTIAL_JSON_STRING_FIELD_KEYS) {
    const value = readPartialJsonStringField(rawInput, key);
    if (value !== undefined) {
      preview[key] = value;
    }
  }
  return Object.keys(preview).length > 0 ? preview : null;
}

// 按字段名定位起始引号，逐字符扫描到闭合引号或输入末尾。
// 反斜杠转义成对保留，避免把转义引号误判为结束。
// 扫描结束时仍在转义态则补一个反斜杠，再交给解码。
//
function readPartialJsonStringField(rawInput: string, key: string): string | undefined {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`).exec(rawInput);
  if (!match) {
    return undefined;
  }

  let encoded = "";
  let escaped = false;
  let closed = false;
  for (let index = match.index + match[0].length; index < rawInput.length; index += 1) {
    const char = rawInput[index] ?? "";
    if (escaped) {
      encoded += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      closed = true;
      break;
    }
    encoded += char;
  }
  if (escaped) {
    encoded += "\\";
  }

  return decodeJsonStringSegment(encoded, closed);
}

// 闭合片段按完整 JSON 字符串解析，失败再走尽力而为的替换。
// 未闭合片段先裁掉悬空的 unicode 或反斜杠转义，避免解析必失败。
//
function decodeJsonStringSegment(encoded: string, closed: boolean): string {
  const normalized = closed ? encoded : trimDanglingJsonEscape(encoded);
  try {
    return JSON.parse(`"${normalized}"`) as string;
  } catch {
    return decodeJsonStringSegmentBestEffort(normalized);
  }
}

function trimDanglingJsonEscape(value: string): string {
  return value.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
}

function decodeJsonStringSegmentBestEffort(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
