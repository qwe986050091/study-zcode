// ============================================================
// Read File State Helpers
// ============================================================

import { platform as currentPlatform } from "node:process";
import { normalizeToolPathForComparison } from "./path-normalization.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

type ReadFileStatePlatform = NodeJS.Platform;

/**
 * 生成“文件路径”级别的 read-state 键。
 * 输入：filePath 原始路径 + 可选平台（默认当前平台）；输出比较键（非可回写路径）。
 * 仅做路径归一化（Windows 盘符/扩展前缀、NFC），不折叠大小写、不解析符号链接。
 * 纯函数；同一文件不同写法（c:/、C:\、/c/）会落到同一个键。
 */
export function createReadFileStatePathKey(
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return normalizeToolPathForComparison(filePath, platform);
}

/**
 * 生成 Map 的完整 read-state 键：路径键 + offset + limit，用 `\0` 分隔避免拼接歧义。
 * 口径：offset 缺省按 1（Read 的行号从 1 开始）；limit 缺省用空串表示“读到文件末尾”。
 * 因此 `Read(file)` 与 `Read(file, offset=1, limit=undefined)` 共用同一条 entry。
 * 纯函数；键只用于查表，消费者仍以 entry.path 作为对外路径。
 */
export function createReadFileStateKey(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return [
    createReadFileStatePathKey(filePath, platform),
    String(offset ?? 1),
    limit === undefined ? "" : String(limit),
  ].join("\0");
}

/**
 * 查找某文件“严格完整读取”的最新 read-state。
 * 严格条件：isPartialView=false、offset<=1、limit=undefined（模型确实看过全文）。
 * 输出最新一条匹配；没有则 undefined。消费者是 Write 等需要“全文已读”前提的工具。
 * 纯函数；按 readAt 选择，不看 mtime（是否过期由调用方用 mtimeMs/revisionId 判定）。
 */
export function findStrictFullReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;

  return findLatestReadFileStateByPath(readFileState, filePath, platform, (entry) =>
    isStrictFullReadState(entry),
  );
}

/**
 * 查找某文件可用于编辑校验的最新 read-state（允许 partial view）。
 * 与 findStrictFullReadFileState 的差别：这里不拒绝 range Read，只按 readAt 取最新；
 * 真正的 partial view 拒绝由 Edit 消费者按 isPartialView 自行判断。
 * 返回 undefined 表示该文件从未被读过（read-before-edit 事实缺失）。
 */
export function findEditableReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  return findLatestReadFileState(readFileState, filePath, platform);
}

/**
 * 查找某文件的最新 read-state（不区分 full/partial、来源工具）。
 * 判定依据：同一路径键下 readAt 最大者；readAt 相同则后遍历到的条目胜出（Map 顺序）。
 * 消费者包括 resume 诊断与 memory recall：只关心“最近一次读取”，不在此处判 stale。
 * 纯函数；不做 mtime 比较，也不解析符号链接。
 */
export function findLatestReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;

  // 优先返回 full Read 会让 Bash/formatter 改完文件后即使模型按提示重新
  // range Read，Edit/Write 仍拿旧 full Read 做 mtime 校验并持续误报 stale。这里按
  // 单文件最新 read-state 语义选择基准；真正的 partial view 由消费者单独拒绝。
  return findLatestReadFileStateByPath(readFileState, filePath, platform, () => true);
}

/**
 * 把 mtime 归一成整数毫秒（向下取整）。
 * 为什么取整：不同 adapter/平台可能给出小数毫秒，而持久化与比较需要稳定等值；
 * undefined 原样返回，表示“没有 freshness 事实”，不能当作 0 参与 stale 判定。
 */
export function normalizeReadFileStateMtimeMs(mtimeMs: number | undefined): number | undefined {
  if (mtimeMs === undefined) return undefined;
  return Math.floor(mtimeMs);
}

/**
 * 在 Map 中线性扫描同一路径键的条目，返回 readAt 最新且通过 accepts 的一条。
 * 复杂度 O(n)：每次比较都重新归一化 entry.path，避免依赖调用方是否预存好键。
 * 注意：`readAt < latestReadAt` 才跳过，因此相同时间戳时后遍历者胜出（Map 插入顺序）。
 */
function findLatestReadFileStateByPath(
  readFileState: ReadFileStateMap,
  filePath: string,
  platform: ReadFileStatePlatform,
  accepts: (entry: ReadFileStateEntry) => boolean,
): ReadFileStateEntry | undefined {
  const pathKey = createReadFileStatePathKey(filePath, platform);
  let latest: ReadFileStateEntry | undefined;
  let latestReadAt = Number.NEGATIVE_INFINITY;
  for (const entry of readFileState.values()) {
    if (createReadFileStatePathKey(entry.path, platform) !== pathKey) continue;
    if (!accepts(entry)) continue;
    const readAt = entry.readAt.getTime();
    if (readAt < latestReadAt) continue;
    latest = entry;
    latestReadAt = readAt;
  }
  return latest;
}

/** 严格完整读取判定：非 partial、起点不晚于第 1 行、且没有行数上限。 */
function isStrictFullReadState(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}
