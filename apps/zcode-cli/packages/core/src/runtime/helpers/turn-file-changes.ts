/**
 * ============================================================================
 * runtime/helpers/turn-file-changes.ts —— 单个 turn 的文件变更累计与汇总
 * ============================================================================
 *
 * 【定位】工具执行时（Edit/Write/ApplyPatch 等）把每次写入累计进 turn-local map；
 *   turn 结束时汇总成 TurnFileChangeSummary 供 UI/事件展示。
 *
 * 【口径】同一路径多次写入合并为一条：afterContent 取最后一次，additions/deletions
 *   按每次 patch 的 hunk 行**累加**（不是最终 diff 的行数），writeCount 计数，
 *   toolNames 去重。因此"总计 +N/-M"反映的是过程量，而非净变更。
 *
 * 【降级】有 afterContent 时用真正的 diff 统计（5s 超时防超大文件卡住）；
 *   没有 afterContent 则回落到逐次 patch 的累加值。不抛错。
 * ============================================================================
 */
import { structuredPatch } from "diff";
import type { DiffHunk, TurnFileChangeSummary } from "../deps.js";
import type { RuntimeTurnFileChangeMap } from "../types.js";

const DIFF_TIMEOUT_MS = 5_000;

/**
 * 记录一次文件写入到 turn-local 变更表。
 *
 * 输入：变更 map（会被原地修改）+ 单次写入信息（path/before/after/patch/toolName）。
 * 输出：无返回值；副作用是写 map。
 * 合并口径：首次写入建条目（writeCount=1，toolNames 含本次工具）；
 *   后续写入只更新 afterContent（取最新非 undefined）、累加 fallbackAdditions/Deletions、
 *   累加 writeCount、加入 toolName —— beforeContent 保持**最初**值，因为它代表 turn 起点状态。
 * 注意：fallback 是按每次 patch 统计的，用于 afterContent 缺失时的估算，不是最终净 diff。
 */
export function recordTurnFileChange(
  changes: RuntimeTurnFileChangeMap,
  input: {
    afterContent?: string;
    beforeContent: string | null;
    path: string;
    structuredPatch: DiffHunk[];
    toolName: string;
  },
): void {
  const fallback = countPatchLines(input.structuredPatch);
  const existing = changes.get(input.path);
  if (!existing) {
    changes.set(input.path, {
      afterContent: input.afterContent,
      beforeContent: input.beforeContent,
      fallbackAdditions: fallback.additions,
      fallbackDeletions: fallback.deletions,
      path: input.path,
      toolNames: new Set([input.toolName]),
      writeCount: 1,
    });
    return;
  }

  existing.afterContent = input.afterContent ?? existing.afterContent;
  existing.fallbackAdditions += fallback.additions;
  existing.fallbackDeletions += fallback.deletions;
  existing.toolNames.add(input.toolName);
  existing.writeCount += 1;
}

/**
 * 把 turn-local 变更表汇总成可上报的 TurnFileChangeSummary。
 *
 * 输入：变更 map。输出：汇总对象；map 为空时返回 undefined（没有文件变更就不发事件）。
 * 统计口径：每条目若有 afterContent，用 diffLineStat(before→after) 计算真实增删；
 *   否则回落到 recordTurnFileChange 累计的 fallback 值。items 按 path 字典序排序，
 *   toolNames 排序，保证事件输出稳定可比较。
 * totals：additions/deletions 为各 item 求和，files 为条目数（不是写入次数）。
 * 副作用：无；不修改 map。
 */
export function buildTurnFileChangeSummary(
  changes: RuntimeTurnFileChangeMap,
): TurnFileChangeSummary | undefined {
  if (changes.size === 0) return undefined;

  const items = Array.from(changes.values())
    .map((entry) => {
      const stat =
        entry.afterContent === undefined
          ? {
              additions: entry.fallbackAdditions,
              deletions: entry.fallbackDeletions,
            }
          : diffLineStat(entry.beforeContent ?? "", entry.afterContent, entry.path);
      return {
        additions: stat.additions,
        deletions: stat.deletions,
        path: entry.path,
        toolNames: Array.from(entry.toolNames).sort(),
        writeCount: entry.writeCount,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    files: items.length,
    items,
  };
}

/**
 * 计算 before→after 的真实增删行数（私有）。
 *
 * 调用 diff 库的 structuredPatch 生成 hunk，再交给 countPatchLines 计数。
 * 超时保护：传 DIFF_TIMEOUT_MS（5s），超大文件或病态输入时 diff 库会返回 undefined，
 *   此时按"0 hunk"处理（统计为 0），而不是阻塞 turn 结束。
 * 副作用：无（纯计算）。
 */
function diffLineStat(
  beforeContent: string,
  afterContent: string,
  filePath: string,
): { additions: number; deletions: number } {
  return countPatchLines(
    structuredPatch(filePath, filePath, beforeContent, afterContent, undefined, undefined, {
      timeout: DIFF_TIMEOUT_MS,
    })?.hunks ?? [],
  );
}

/**
 * 统计 hunk 行里的增删（私有）。
 *
 * 口径：只按行首字符判定 —— "+" 计增加、"-" 计删除；"+" 与 "-" 互斥（unified diff 语义），
 *   因此不会把一行同时算作两边。空行/空白行按原样匹配行首字符。
 * 副作用：无。
 */
function countPatchLines(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }

  return { additions, deletions };
}
