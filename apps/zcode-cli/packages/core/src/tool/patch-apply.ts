import { normalizeLineEndings } from "./edit-matchers.js";
import type { PatchChunk } from "./patch-parser.js";

interface PatchApplyResult {
  content: string;
}

// 替换指令：[起始行下标, 被替换的旧行数, 新行数组]；统一按行操作，避免字符偏移漂移。
type Replacement = [startIndex: number, oldLineCount: number, newLines: string[]];
// 行比较器；seekSequence 按“严格→宽松”顺序逐个尝试，只有全部失败才算未命中。
type Comparator = (actual: string, expected: string) => boolean;

/**
 * 把结构化 patch 的 chunks 应用到完整文件内容上。
 * 输入：content 为磁盘上的原文；chunks 来自 parseStructuredPatch（oldLines/newLines 已去掉标记）。
 * 输出：{ content }，换行先统一为 LF，末尾保证恰好一个换行（补一个空行再 join）。
 * 失败语义：changeContext 或 oldLines 找不到会抛 Error，消息里带上下文/期望行，
 * 供 apply-patch 包装成 HUNK_NOT_FOUND 并保留可诊断原因；绝不静默跳过 hunk。
 * 副作用：纯内存计算，不读写文件、不改 encoding。
 */
export function derivePatchedContent(content: string, chunks: PatchChunk[]): PatchApplyResult {
  const originalLines = splitLogicalLines(normalizeLineEndings(content));
  const replacements = computeReplacements(originalLines, chunks);
  const nextLines = applyReplacements(originalLines, replacements);
  if (nextLines.length === 0 || nextLines[nextLines.length - 1] !== "") {
    nextLines.push("");
  }
  return { content: nextLines.join("\n") };
}

/**
 * 按顺序把每个 chunk 定位成一条行级替换指令。
 * 输入：lines 是去掉末尾哨兵空行后的原文行；chunks 按模型给出的顺序处理。
 * 输出：按起始行升序排列的 Replacement[]（排序是为了后续从后往前安全应用）。
 * 失败语义：changeContext 或 oldLines 未命中抛 Error，消息包含原始上下文/期望行，
 * 不做“跳过该 hunk 继续”的降级——静默跳过的 patch 会改错位置却报成功。
 * 副作用：无；只读 lines、不改 chunks。
 */
function computeReplacements(lines: string[], chunks: PatchChunk[]): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      // 为什么先找上下文：`@@ 函数名` 用于在重复代码块中消歧；找不到锚点说明
      // 文件内容已漂移，继续按位置猜会改到错误位置，因此直接失败。
      const contextIndex = seekSequence(lines, [chunk.changeContext], lineIndex);
      if (contextIndex === -1) {
        throw new Error(`Failed to find context '${chunk.changeContext}'`);
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      // 纯插入：默认追加到文件末尾；末尾哨兵空行不算内容，所以插入点要落在它之前，
      // 否则会在“最后一个换行”之后再多造一行空行。
      const insertionIndex =
        lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile === true);
    if (found === -1 && pattern[pattern.length - 1] === "") {
      // 为什么重试：模型常在 hunk 末尾多写一个空行（文件末尾换行的惯性），
      // 导致 oldLines 多出一个 "" 而匹配失败；去掉尾部空行再试一次，避免误报 HUNK_NOT_FOUND。
      pattern = pattern.slice(0, -1);
      replacement =
        replacement[replacement.length - 1] === "" ? replacement.slice(0, -1) : replacement;
      found = seekSequence(lines, pattern, lineIndex, chunk.endOfFile === true);
    }

    if (found === -1) {
      // 失败必须带出期望行原文：上层据此生成 HUNK_NOT_FOUND 的可诊断原因，
      // 不能只报“apply 失败”而让模型无从修正。
      throw new Error(`Failed to find expected lines:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push([found, pattern.length, replacement]);
    // 顺序游标前移，保证后续 hunk 只在已匹配位置之后搜索，避免同一段被重复命中。
    lineIndex = found + pattern.length;
  }

  // 升序供 applyReplacements 逆序应用：从后往前 splice 不会让前面的行下标失效。
  return replacements.sort((left, right) => left[0] - right[0]);
}

/**
 * 把排序后的替换指令真正写回行数组。
 * 输入：lines 原文行、replacements 已按起始行升序；输出新数组，不修改入参。
 * 从最后一个替换开始 splice：后面的替换先完成，前面替换的旧行下标始终有效。
 * 纯函数；若替换区间重叠，结果按“后写覆盖先写”的行为由 sort 顺序保证稳定。
 */
function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines];
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const [startIndex, oldLineCount, newLines] = replacements[index]!;
    result.splice(startIndex, oldLineCount, ...newLines);
  }
  return result;
}

/**
 * 在 lines 中从 startIndex 起查找 pattern 的匹配位置。
 * 匹配强度四级递进：完全相等 → 忽略行尾空白 → 忽略首尾空白 → 再做 Unicode 标点归一化。
 * 这样能容忍模型复制时引入的空白/智能引号，但只有全部失败才返回 -1（不猜位置）。
 * eof=true 时先尝试“贴文件末尾”的匹配，用于 `*** End of File` 锚点。
 * 纯函数；pattern 为空直接返回 -1，避免空匹配命中任意位置。
 */
function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1;
  for (const compare of [exactCompare, trimEndCompare, trimCompare, normalizedCompare]) {
    const index = tryMatch(lines, pattern, startIndex, compare, eof);
    if (index !== -1) return index;
  }
  return -1;
}

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  eof: boolean,
): number {
  if (eof) {
    // 为什么优先从尾部试：`*** End of File` 明确表示 hunk 贴着文件末尾，
    // 从后往前匹配可避免把同样的代码块误判成中间位置。
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex && linesMatch(lines, pattern, fromEnd, compare)) return fromEnd;
  }

  for (let index = startIndex; index <= lines.length - pattern.length; index += 1) {
    if (linesMatch(lines, pattern, index, compare)) return index;
  }
  return -1;
}

function linesMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    if (!compare(lines[startIndex + offset] ?? "", pattern[offset] ?? "")) return false;
  }
  return true;
}

function exactCompare(actual: string, expected: string): boolean {
  return actual === expected;
}

function trimEndCompare(actual: string, expected: string): boolean {
  return actual.trimEnd() === expected.trimEnd();
}

function trimCompare(actual: string, expected: string): boolean {
  return actual.trim() === expected.trim();
}

function normalizedCompare(actual: string, expected: string): boolean {
  return normalizeUnicode(actual.trim()) === normalizeUnicode(expected.trim());
}

/**
 * 把各种 Unicode 引号/连字符/省略号/不换行空格归一化成 ASCII 形态。
 * 目的：模型输出经常把源码里的 ASCII 标点“美化”成排版字符，导致严格比较失败；
 * 只在最宽松的匹配级别启用，不会改变实际写回的内容。
 */
function normalizeUnicode(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

/**
 * 按 LF 切行，并去掉末尾的空串哨兵。
 * 输入 content 已统一换行为 LF；保留文件内部空行，只删除“末尾换行产生的最后一个空元素”，
 * 这样行数与磁盘逻辑行一致，替换下标不会整体偏移一行。
 */
function splitLogicalLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
