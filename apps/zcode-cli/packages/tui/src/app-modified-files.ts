// 工具结果中的文件改动统计投影。
// 职责：从 display payload 提取单批统计，并合并进会话累计列表。
// 边界：只做展示统计，不改工作区文件、不触发 diff 计算。
// 副作用：无，均为纯函数；不修改入参数组。
// 降级：非 file_diff(s) 返回空数组；缺路径条目被过滤，非法计数按 0。

import { formatToolFilePath } from "./app-tool-path-display.js";
import { asRecord, numberField, stringField } from "./state.js";

const FILE_DIFF_DISPLAY_KIND = "file_diff";
const FILE_DIFFS_DISPLAY_KIND = "file_diffs";
const MAX_SESSION_MODIFIED_FILES = 100;

// 单个文件的会话内修改统计：additions/deletions 为累计增删行数，filePath 为展示路径。
// 口径：计数为非负整数，未知或非法输入按 0 处理；同一文件重复出现时累加而非覆盖。
export type ModifiedFileStat = {
  additions: number;
  deletions: number;
  filePath: string;
};

// 从工具结果 payload 中提取本次修改的文件统计。
// 输入：payload.result.display.kind 决定解析方式；file_diff 取单个文件，file_diffs 取 files 数组，
// 其它 kind 一律返回空数组（表示该工具不涉及文件修改，而不是解析失败）。
// 输出：已格式化路径且计数非负的 ModifiedFileStat[]，会过滤掉缺少路径的非法项。
// 副作用：无，纯函数；workspaceDirectory 仅用于把绝对路径转成可读展示路径。
export function modifiedFileStatsFromToolResultPayload(
  payload: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): ModifiedFileStat[] {
  const result = asRecord(payload.result);
  const display = asRecord(result.display);
  const kind = stringField(display, "kind");

  if (kind === FILE_DIFF_DISPLAY_KIND) {
    return compactStats([modifiedFileStatFromDisplay(display, workspaceDirectory)]);
  }

  if (kind === FILE_DIFFS_DISPLAY_KIND) {
    const files = Array.isArray(display.files) ? display.files : [];
    return compactStats(
      files.map((file) => modifiedFileStatFromDisplay(asRecord(file), workspaceDirectory)),
    );
  }

  return [];
}

// 把新一批修改统计合并进会话累计列表。
// 输入：current 为已有统计（按最近修改倒序），incoming 为本批统计（可为空数组）。
// 输出：新数组，同路径累加增删数并移到最前，最终截断到 MAX_SESSION_MODIFIED_FILES 条。
// 副作用：无，纯函数；不修改入参数组。
export function applyModifiedFileStats(
  current: ModifiedFileStat[],
  incoming: ModifiedFileStat[],
): ModifiedFileStat[] {
  let next = current;
  for (const stat of incoming) {
    next = upsertModifiedFileStat(next, stat);
  }
  return next.slice(0, MAX_SESSION_MODIFIED_FILES);
}

// 单条 upsert：同路径存在则累加计数，并把该项提到列表首位（“最近修改优先”）。
function upsertModifiedFileStat(
  current: ModifiedFileStat[],
  incoming: ModifiedFileStat,
): ModifiedFileStat[] {
  const existing = current.find((stat) => stat.filePath === incoming.filePath);
  const updated: ModifiedFileStat = {
    additions: (existing?.additions ?? 0) + incoming.additions,
    deletions: (existing?.deletions ?? 0) + incoming.deletions,
    filePath: incoming.filePath,
  };

  return [updated, ...current.filter((stat) => stat.filePath !== incoming.filePath)];
}

// 从 display 记录解析单文件统计；路径为空或无法展示时返回 undefined，由调用方过滤。
// 计数缺失/负数按 0，浮点数向下取整，保证展示值恒为非负整数。
function modifiedFileStatFromDisplay(
  display: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): ModifiedFileStat | undefined {
  const rawPath = stringField(display, "filePath");
  const filePath = formatToolFilePath(rawPath, workspaceDirectory);
  if (!filePath) return undefined;

  return {
    additions: nonNegativeCount(numberField(display, "additions")),
    deletions: nonNegativeCount(numberField(display, "deletions")),
    filePath,
  };
}

// 计数归一：undefined/负数 → 0，其余向下取整；用于所有来自 payload 的数字字段。
function nonNegativeCount(value: number | undefined): number {
  if (value === undefined || value < 0) return 0;
  return Math.floor(value);
}

// 过滤 undefined 项并收窄类型；保留原顺序，空输入返回空数组。
function compactStats(
  stats: Array<ModifiedFileStat | undefined>,
): ModifiedFileStat[] {
  return stats.filter((stat): stat is ModifiedFileStat => stat !== undefined);
}
