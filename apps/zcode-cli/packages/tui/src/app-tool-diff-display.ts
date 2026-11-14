// 工具 diff 结果展示层：把 runtime 下发的事件 payload 片段（filePath / structuredPatch / truncated）
// 归一化为 transcript 可渲染的 ToolResultDisplay，并提供带行号与着色的预览行。
// 字段全部按未知类型读取，缺失或不合法时降级为空 hunk、undefined 或 false，不抛异常。

import type {
  ToolResultDisplay,
  ToolResultDisplayHunk,
  ToolResultDisplayLine,
} from "./app-model.js";
import { truncateDisplay } from "./app-terminal-width.js";
import { asRecord, booleanField, numberField, stringField } from "./state.js";

// transcript 内 diff 预览最多展示 12 行，超出部分折叠为截断提示，避免占满会话视口。
const MAX_DIFF_LINES = 12;
// 单行 diff 正文按显示列宽截断到 100 列，防止长行在窄终端横向溢出。
const MAX_DIFF_LINE_WIDTH = 100;

// 把工具结果里的 file_diff display 载荷转换为 transcript 使用的 ToolResultDisplay。
// display 来自任意 JSON：structuredPatch 缺失或字段不完整时按空集合处理，lines 可能为空数组。
// 输出保留完整 unified patch 文本（复制/诊断用）、filePath、结构化 hunk 与 truncated 标记。
// 纯函数，无 IO/日志；畸形 hunk 静默丢弃而不是抛错，保证 hover/渲染不因脏数据中断。
export function formatFileDiffDisplay(display: Record<string, unknown>): ToolResultDisplay {
  const structuredPatch = structuredPatchField(display);
  const lines = formatUnifiedDiffLines(structuredPatch);
  const sourceLineCount = diffSourceLineCount(structuredPatch);
  const truncated = booleanField(display, "truncated") || sourceLineCount > lines.length;

  if (truncated) {
    appendTruncationLine(lines);
  }

  const filePath = stringField(display, "filePath");
  return {
    diff: formatUnifiedPatch(display),
    filePath,
    lines,
    structuredPatch,
    truncated,
  };
}

function appendDiffLine(
  lines: ToolResultDisplayLine[],
  text: string,
  tone: ToolResultDisplayLine["tone"],
): void {
  // 超过上限后静默丢弃，由 appendTruncationLine 统一在同一行上打截断标记。
  if (lines.length >= MAX_DIFF_LINES) return;
  lines.push({ text: truncateDisplay(text, MAX_DIFF_LINE_WIDTH), tone });
}

// 将结构化 hunk 展开为单行号视图：新增行取 newStart 递增，删除/上下文行取 oldStart 递增。
// 输出行数可能少于原始行数，调用方据 sourceLineCount 判定是否截断。
function formatUnifiedDiffLines(structuredPatch: ToolResultDisplayHunk[]): ToolResultDisplayLine[] {
  const lines: ToolResultDisplayLine[] = [];

  for (const hunk of structuredPatch) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const rawLine of hunk.lines) {
      const marker = diffMarker(rawLine);
      const lineLabel = marker === "+" ? String(newLine) : String(oldLine);
      // 窄屏只保留一列行号，避免旧/新双行号把正文挤出可读区域。
      appendDiffLine(lines, `${lineLabel.padStart(4)} ${rawLine}`, toneForDiffMarker(marker));
      if (marker !== "+") oldLine += 1;
      if (marker !== "-") newLine += 1;
    }
  }

  return lines;
}

function appendTruncationLine(lines: ToolResultDisplayLine[]): void {
  // 行数已满时覆盖末行而不是追加，确保总行数恒定不超过 MAX_DIFF_LINES。
  if (lines.length >= MAX_DIFF_LINES) {
    lines[MAX_DIFF_LINES - 1] = { text: "... diff truncated", tone: "meta" };
    return;
  }
  appendDiffLine(lines, "... diff truncated", "meta");
}

function diffMarker(line: string): string {
  return line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ";
}

function toneForDiffMarker(marker: string): ToolResultDisplayLine["tone"] {
  if (marker === "+") return "addition";
  if (marker === "-") return "deletion";
  return "context";
}

function diffSourceLineCount(structuredPatch: ToolResultDisplayHunk[]): number {
  return structuredPatch.reduce<number>((count, hunk) => count + hunk.lines.length, 0);
}

// 重建标准 unified diff 文本；无 hunk 时返回 undefined，调用方据此隐藏复制入口。
// filePath 中的换行会被压成空格，避免多行路径破坏 ---/+++ 头格式。
function formatUnifiedPatch(display: Record<string, unknown>): string | undefined {
  const hunks = arrayField(display, "structuredPatch");
  // 没有 hunk 就没有可展示/可复制的 patch，返回 undefined 与空字符串区分。
  if (hunks.length === 0) return undefined;

  const filePath = sanitizePatchPath(stringField(display, "filePath") ?? "file");
  const patchLines = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const hunk of hunks) {
    const hunkRecord = asRecord(hunk);
    const oldStart = numberField(hunkRecord, "oldStart") ?? 0;
    const oldLines = numberField(hunkRecord, "oldLines") ?? 0;
    const newStart = numberField(hunkRecord, "newStart") ?? 0;
    const newLines = numberField(hunkRecord, "newLines") ?? 0;
    patchLines.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    patchLines.push(...stringArrayField(hunkRecord, "lines"));
  }

  return patchLines.join("\n");
}

function sanitizePatchPath(filePath: string): string {
  return filePath.replace(/[\r\n]/gu, " ");
}

// 只收编 oldStart/oldLines/newStart/newLines 齐全的 hunk；缺字段说明投影数据不可信，直接丢弃而非填 0。
function structuredPatchField(record: Record<string, unknown>): ToolResultDisplayHunk[] {
  return arrayField(record, "structuredPatch").flatMap((hunk) => {
    const hunkRecord = asRecord(hunk);
    const oldStart = numberField(hunkRecord, "oldStart");
    const oldLines = numberField(hunkRecord, "oldLines");
    const newStart = numberField(hunkRecord, "newStart");
    const newLines = numberField(hunkRecord, "newLines");
    const lines = stringArrayField(hunkRecord, "lines");
    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined
    ) {
      return [];
    }
    return [
      {
        lines,
        newLines,
        newStart,
        oldLines,
        oldStart,
      },
    ];
  });
}

// 非数组一律归为空数组，避免上游 JSON 字段类型漂移导致渲染崩溃。
function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

// 过滤非字符串元素，保持行数组的 string 类型收窄。
function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return arrayField(record, key).filter((item): item is string => typeof item === "string");
}
