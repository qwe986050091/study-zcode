// INV-01 展示上限一千：守住位置 展示上限常量；改错故障 巨型仓库列表卡顿。
// INV-02 归一化一次建索引：守住位置 候选构建；改错故障 热路径反复小写化。
// INV-03 候选标识用相对路径：守住位置 标识赋值；改错故障 同路径跨根冲突。
// INV-04 空文本不参与打分：守住位置 空文本判断；改错故障 空名候选恒排第一。
// INV-05 空查询返回零分：守住位置 空查询判断；改错故障 空查询过滤掉全部候选。
// INV-06 前缀命中优先：守住位置 前缀分支；改错故障 子串命中压过前缀。
// INV-07 子串命中加一百：守住位置 偏移计分；改错故障 靠前命中不占优。
// INV-08 子序列兜底加二百：守住位置 初始分；改错故障 模糊命中与精确命中同分。
// INV-09 子序列不命中返回空：守住位置 找不到字符；改错故障 无关候选进入结果。
// INV-10 热路径不重复归一化：守住位置 归一化版本函数；改错故障 每次比较重新小写。
// INV-11 名称分最优：守住位置 三者取最小；改错故障 路径命中压过文件名。
// INV-12 相对路径加权二十五：守住位置 加分常量；改错故障 深层路径压过浅层。
// INV-13 关键词档加三百：守住位置 关键词分；改错故障 跨目录命中落到末尾。
// INV-14 无穷大表示未命中：守住位置 无穷兜底；改错故障 空值参与数值比较。
// INV-15 默认排序稳定：守住位置 原始下标次序；改错故障 同优先级顺序抖动。
// INV-16 目录排在文件之后：守住位置 优先级函数；改错故障 目录占据列表头部。
// INV-17 二分插入依赖全序：守住位置 比较器三段；改错故障 同分项插入位置错乱。
// INV-18 无查询按需拒绝：守住位置 需要查询标志；改错故障 面板初开直接全量返回。
//
// 模块职责：工作区文件搜索的候选构建、模糊打分与 top-K 过滤。
// 状态所有权：无状态；候选与查询由调用方传入。
// 阅读顺序：先看候选与打分，再读热路径版本，最后看排序与二分插入。
import type { WorkspaceFileEntry } from "@zcode/shared";

/**
 * Safety-net cap for virtualized display. Large enough to never feel
 * "incomplete" to users, small enough to keep fuzzy-sort and virtualizer
 * memory in check for enormous monorepos.
 */
export const WORKSPACE_FILE_SEARCH_DISPLAY_CAP = 1000;

export interface WorkspaceFileSearchCandidate {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  type: WorkspaceFileEntry["type"];
  /**
   * 预计算的小写形式：打分热路径不再对每条候选反复 toLowerCase。
   * 放开 node_modules 后候选基数可达数十万，
   * 每键 3-4 次全串 toLowerCase 是卡顿主因之一；索引构建时一次性归一化。
   */
  lowercaseName: string;
  lowercaseRelativePath: string;
  lowercasePath: string;
}

export interface FilterWorkspaceFileSearchCandidatesOptions {
  limit?: number;
  requireQuery?: boolean;
}

export function hasWorkspaceFileSearchQuery(query: string): boolean {
  return query.trim().length > 0;
}

// 每个 WorkspaceFileEntry 只归一化一次，lowercaseRelativePath 供后续多处复用。
// id 直接取 relativePath，保证候选在列表里的身份与路径一致。
// name、path 与 relativePath 三个原始字段都由 entry 原样带入，不做改写。
// lowercaseName、lowercasePath 等字段只在打分时读取，从而省掉每次比较的 toLowerCase 调用。
// map 的结果顺序与 entries 入参一致，调用方可以按索引对齐。
// 该函数只读 entries，返回新数组而不修改入参。
export function mapWorkspaceFileEntriesToSearchCandidates(
  entries: WorkspaceFileEntry[],
): WorkspaceFileSearchCandidate[] {
  return entries.map((entry) => {
    // trim 与原打分函数的归一化保持一致（防御首尾空格文件名），严格行为等价。
    const lowercaseRelativePath = entry.relativePath.trim().toLowerCase();
    return {
      id: entry.relativePath,
      name: entry.name,
      path: entry.path,
      relativePath: entry.relativePath,
      type: entry.type,
      lowercaseName: entry.name.trim().toLowerCase(),
      lowercaseRelativePath,
      lowercasePath: entry.path.trim().toLowerCase(),
    };
  });
}

// 先把 text 与 query 都 trim 再 toLowerCase，两侧归一化规则一致。
// normalizedText 为空直接返回 null，空文本不参与打分。
// normalizedQuery 为空返回 0，空前缀对任何候选都算零分。
// startsWith 命中时返回长度差，前缀越短分数越低。
// indexOf 命中时返回 100 加 substringIndex，子串越靠前越优先。
// 子序列按 searchStart 逐字符推进，间隔累加进 score。
export function scoreWorkspaceFileFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

/** scoreWorkspaceFileFuzzyMatch 的热路径版本：text/query 均为已归一化（trim+lower）输入。 */
function scoreNormalizedFuzzyMatch(normalizedText: string, normalizedQuery: string): number | null {
  if (!normalizedText) {
    return null;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

// normalizedQuery 为空时返回 0，空查询不进入打分。
// nameScore 不额外加权，名称命中与路径命中用同一套分数。
// relativePathScore 命中后加 25，只保留相对路径这一档。
// keywordScore 的 300 档覆盖 query 跨目录段子序列命中的场景。
// bestScore 取三者最小值，Number.POSITIVE_INFINITY 表示该侧未命中。
export function getWorkspaceFileSearchCandidateScore(
  candidate: WorkspaceFileSearchCandidate,
  query: string,
): number | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const nameScore = scoreNormalizedFuzzyMatch(candidate.lowercaseName, normalizedQuery);
  const relativePathScore = scoreNormalizedFuzzyMatch(
    candidate.lowercaseRelativePath,
    normalizedQuery,
  );
  const pathScore = scoreNormalizedFuzzyMatch(candidate.lowercasePath, normalizedQuery);
  // relativePath 打分只计 +25 档；更高的 +100 档恒被同一打分的 +25 项压制，属于死代码；
  // keywords 项（+300）保留，覆盖"query 跨目录段子序列命中"的场景。
  const keywordScore = Math.min(
    relativePathScore !== null ? relativePathScore + 300 : Number.POSITIVE_INFINITY,
    pathScore !== null ? pathScore + 300 : Number.POSITIVE_INFINITY,
  );
  const bestScore = Math.min(
    nameScore ?? Number.POSITIVE_INFINITY,
    relativePathScore !== null ? relativePathScore + 25 : Number.POSITIVE_INFINITY,
    keywordScore,
  );

  return Number.isFinite(bestScore) ? bestScore : null;
}

function applyWorkspaceFileSearchLimit<T>(items: T[], limit?: number): T[] {
  if (!Number.isFinite(limit)) {
    return items;
  }

  const safeLimit = Math.max(0, Math.trunc(limit ?? 0));
  return items.slice(0, safeLimit);
}

function getDefaultWorkspaceFileSearchPriority(candidate: WorkspaceFileSearchCandidate): number {
  return candidate.type === "directory" ? 1 : 0;
}

function sortDefaultWorkspaceFileSearchCandidates(
  candidates: WorkspaceFileSearchCandidate[],
): WorkspaceFileSearchCandidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      priority: getDefaultWorkspaceFileSearchPriority(candidate),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ candidate }) => candidate);
}

interface ScoredWorkspaceFileSearchCandidate {
  candidate: WorkspaceFileSearchCandidate;
  index: number;
  score: number;
}

function compareScoredWorkspaceFileSearchCandidates(
  left: ScoredWorkspaceFileSearchCandidate,
  right: ScoredWorkspaceFileSearchCandidate,
): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }
  if (left.index !== right.index) {
    return left.index - right.index;
  }
  return left.candidate.name.localeCompare(right.candidate.name);
}

/**
 * 大 workspace（数万候选）下 top-K 插入点曾用 findIndex 线性扫，最坏
 * O(候选数 × limit)（65k 候选 × 1000 ≈ 6500 万次比较，实测单键 155ms 同步阻塞
 * 主线程，@ 面板键入时整窗冻结）。compareScoredWorkspaceFileSearchCandidates 按
 * (score, index) 严格全序（index 单次遍历内唯一），二分查找插入点安全，
 * 单次过滤降到 O(n log K)。
 */
function findInsertionIndexByBinarySearch(
  bestMatches: ScoredWorkspaceFileSearchCandidate[],
  scored: ScoredWorkspaceFileSearchCandidate,
): number {
  let low = 0;
  let high = bestMatches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const midItem = bestMatches[mid];
    if (midItem !== undefined && compareScoredWorkspaceFileSearchCandidates(scored, midItem) < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low === bestMatches.length ? -1 : low;
}

// normalizedQuery 为空时走 sortDefaultWorkspaceFileSearchCandidates 的默认排序。
// requireQuery 为真且没有查询时直接返回空数组。
// bestMatches 按 getWorkspaceFileSearchCandidateScore 升序维护，头部是最优项。
// bestMatches 末尾即当前最差项，超限时只需要和它比较。
// 超限时 pop 掉末项，再把新候选按 findInsertionIndexByBinarySearch 插入。
export function filterWorkspaceFileSearchCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  options: FilterWorkspaceFileSearchCandidatesOptions = {},
): WorkspaceFileSearchCandidate[] {
  const effectiveLimit = options.limit ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return options.requireQuery
      ? []
      : applyWorkspaceFileSearchLimit(
          sortDefaultWorkspaceFileSearchCandidates(candidates),
          effectiveLimit,
        );
  }

  const bestMatches: ScoredWorkspaceFileSearchCandidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const score = getWorkspaceFileSearchCandidateScore(candidate, normalizedQuery);
    if (score === null) {
      continue;
    }

    const scored = { candidate, index, score };
    // 快速路径：数组按序维护，末尾即当前最差；已满且 scored 不优于末尾时必然落选，
    // 跳过查找与 splice（宽匹配 query 下大多数候选走这条分支）。
    const worst = bestMatches[bestMatches.length - 1];
    if (
      worst !== undefined &&
      bestMatches.length >= effectiveLimit &&
      compareScoredWorkspaceFileSearchCandidates(scored, worst) >= 0
    ) {
      continue;
    }

    const insertionIndex = findInsertionIndexByBinarySearch(bestMatches, scored);
    if (insertionIndex === -1) {
      if (bestMatches.length < effectiveLimit) {
        bestMatches.push(scored);
      }
      continue;
    }

    bestMatches.splice(insertionIndex, 0, scored);
    if (bestMatches.length > effectiveLimit) {
      bestMatches.pop();
    }
  }

  return bestMatches.map(({ candidate }) => candidate);
}
