/**
 * 清理计划：给定类别与候选文件列表，决定哪些能删。纯函数，删除动作由 adapters 执行。
 */
// 清理计划（纯函数）：根据类别与候选文件决定可删除集合与跳过数量。
// INV-1 不可清理类别直接全跳过；INV-2 候选必须重新分类且未被保护；
// INV-3 logs 只清非当天文件；INV-4 subagent 会话需整组静默超过 24 小时。
// 本文件不执行删除，也不访问文件系统。
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  isProtectedStoragePath,
  type StorageCatalogContext,
} from "./storageCatalog.js";
import type { StorageCategoryId } from "@zcode/shared";

// 候选条目：bytes 用于统计释放空间，mtimeMs 用于活动与当天判断。
export interface StorageCleanCandidate {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

// 计划结果：targets 是最终可删集合，skippedCount 用于向用户解释为什么没清干净。
export interface StorageCleanPlan {
  targets: StorageCleanCandidate[];
  skippedCount: number;
}

/** 子代理产物：会话目录 24 小时内有更新就整个跳过，避免删掉进行中 subagent 的 transcript。 */
export const SUBAGENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

// 入口无副作用；now 显式传入而不是取 Date.now()，保证跨时区与单测可复现。
// 返回的 skippedCount 以全部候选为分母，包含被类别与保护规则过滤掉的部分。
export function planStorageClean(params: {
  categoryId: StorageCategoryId;
  candidates: StorageCleanCandidate[];
  context: StorageCatalogContext;
  now: number;
}): StorageCleanPlan {
  const { categoryId, candidates, context, now } = params;
// [边界] cleanability=none 时直接返回空 targets：skippedCount 记为全部候选，不做逐条判定。
  if (getStorageCategoryCleanability(categoryId) === "none") {
    return { targets: [], skippedCount: candidates.length };
  }
  // 候选来自按前缀枚举，可能混入其他类别（如 cli/plugins 下的 cache）；只保留分类一致且未受保护的。
  const owned = candidates.filter(
    (candidate) =>
      classifyStoragePath(candidate.relativePath, context).categoryId === categoryId &&
      !isProtectedStoragePath(candidate.relativePath),
  );
// 先得到属于本类别且未受保护的集合，再按类别追加时间维度过滤。
  let targets = owned;
// 日志保留当天：同日文件仍在写入，删除会造成活跃日志丢失。
  if (categoryId === "logs") {
    targets = owned.filter((candidate) => !isSameLocalDay(candidate.mtimeMs, now));
  } else if (categoryId === "subagentTranscripts") {
    // 活动判定如果只看 owned（已按类别过滤，只剩 transcript.jsonl），会漏掉同目录下
    // 刚写入的 metadata/output 文件，把进行中 subagent 的 transcript 判成不活跃。这里用全部候选算活动时间。
    targets = filterInactiveSessionDirs(owned, candidates, now);
  }
// skippedCount 用原始候选数减去最终目标数，天然覆盖所有过滤原因。
  return { targets, skippedCount: candidates.length - targets.length };
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 会话目录 = 前三段（cli/agents/sess_x）；任一文件在活动窗口内则整组跳过。 */
// 活动判定使用全部候选（含同目录 metadata/output），避免只看 transcript 造成误判。
function filterInactiveSessionDirs(
  targets: StorageCleanCandidate[],
  allCandidates: StorageCleanCandidate[],
  now: number,
): StorageCleanCandidate[] {
  const latestBySession = new Map<string, number>();
  const sessionKey = (path: string) => path.split("/").slice(0, 3).join("/");
  for (const candidate of allCandidates) {
    const key = sessionKey(candidate.relativePath);
    latestBySession.set(key, Math.max(latestBySession.get(key) ?? 0, candidate.mtimeMs));
  }
  return targets.filter(
    (candidate) =>
      now - (latestBySession.get(sessionKey(candidate.relativePath)) ?? 0) >
      SUBAGENT_ACTIVE_WINDOW_MS,
  );
}
