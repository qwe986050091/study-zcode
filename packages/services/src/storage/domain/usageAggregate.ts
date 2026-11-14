/**
 * 扫描条目 → 根目录占用快照的折叠器。纯函数式累加器，可在 Worker 内运行。
 * 保证快照体积有界：每个类别的 entries 只保留 bytes 最大的前 N 项，其余折叠进 STORAGE_MORE_ENTRIES_PATH。
 */
// 本模块不含 IO 与全局状态：输入是扫描条目流，输出是可序列化的占用快照，便于放进 Worker。
// 快照体积必须可控，否则几十万条扫描结果会直接压垮消息通道与前端渲染。
import { classifyStoragePath, getStorageCategoryCleanability } from "./storageCatalog.js";
import {
  STORAGE_CATEGORY_IDS,
  STORAGE_MORE_ENTRIES_PATH,
  type StorageCategoryId,
  type StorageCategoryUsage,
  type StorageEntryUsage,
  type StorageRootSpec,
  type StorageRootUsage,
  type StorageVolume,
} from "@zcode/shared";

// 扫描端只提供最小事实集；类别归属、聚合与折叠全部由累加器推导，避免双份状态。
// mtimeMs 当前只透传预留，不参与排序，保留它是为了让上层能按时间做二次筛选。
export interface StorageScanEntry {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
}

// add 允许高频调用（逐文件），snapshot 只在扫描结束时调用一次，二者生命周期不对称。
// snapshot 可重复调用且不修改内部状态，因此中途取值不会影响最终结果。
// 累加器不可跨根目录复用：rootId 与自定义数据目录判断在创建时已固化。
export interface StorageUsageAccumulator {
  add(entry: StorageScanEntry): void;
  snapshot(volume: StorageVolume | null): StorageRootUsage;
}

// 每类别默认只保留占用最大的 100 项，其余折叠为一行，作为快照体积的上限基准。
// 该值是产品可接受的展示粒度，调大只会增加传输与渲染成本，不改变统计总量。
export const DEFAULT_MAX_ENTRIES_PER_CATEGORY = 100;

// bytes/fileCount 是该类别的真实合计，entries 只是展示用的 Top-N 明细，二者不可互相推导。
// entries 的 key 是归类后的 entryKey（可能合并同名前缀），同一 key 会累加多次出现。
interface CategoryBucket {
  bytes: number;
  fileCount: number;
  entries: Map<string, { bytes: number; fileCount: number }>;
}

// 闭包持有 buckets 与总计，调用方只拿 add/snapshot，无法绕过聚合逻辑直接改状态。
// context 在创建时求值一次，避免每条目重复读取 spec，也保证同一轮扫描的归类口径一致。
// maxEntries 允许上层按场景调小，但不会低于 1，否则折叠行会挤掉全部明细。
export function createStorageUsageAccumulator(
  spec: StorageRootSpec,
  options: { maxEntriesPerCategory?: number } = {},
): StorageUsageAccumulator {
// 缺省走模块常量；显式传入 0 属于调用方错误，这里不做兜底，保持行为可预测。
  const maxEntries = options.maxEntriesPerCategory ?? DEFAULT_MAX_ENTRIES_PER_CATEGORY;
  const context = { rootId: spec.id, hasCustomDataBaseDir: spec.hasCustomDataBaseDir };
  const buckets = new Map<StorageCategoryId, CategoryBucket>();
  let totalBytes = 0;
  let totalFiles = 0;

  return {
// 先归类再累加：内部合计与 entry 明细同时更新，保证总量与 Top-N 明细始终自洽。
// 首次遇到的类别惰性建桶，避免为空的类别提前占用内存。
    add(entry) {
// 归类结果是唯一事实来源，后续所有聚合都基于 categoryId/entryKey，不再回看原始路径。
      const { categoryId, entryKey } = classifyStoragePath(entry.relativePath, context);
      let bucket = buckets.get(categoryId);
      if (!bucket) {
        bucket = { bytes: 0, fileCount: 0, entries: new Map() };
        buckets.set(categoryId, bucket);
      }
      bucket.bytes += entry.bytes;
      bucket.fileCount += 1;
      const current = bucket.entries.get(entryKey);
      if (current) {
        current.bytes += entry.bytes;
        current.fileCount += 1;
      } else {
        bucket.entries.set(entryKey, { bytes: entry.bytes, fileCount: 1 });
      }
// 总计在每条目上直接累加，保证 snapshot 的总量与各分类明细之和一致。
      totalBytes += entry.bytes;
      totalFiles += 1;
    },
// 固定遍历 STORAGE_CATEGORY_IDS 而不是 buckets 的 key，保证输出类别集合稳定且顺序一致。
// [契约] 缺失类别补零值而不是省略：前端拿到的 categories 长度恒等于 STORAGE_CATEGORY_IDS。
    snapshot(volume) {
// 折叠只发生在输出阶段，内部 entries 始终保留全量，因此多次 snapshot 结果一致。
// cleanability 由目录策略集中提供，避免前端各自硬编码可清理判断。
      const categories: StorageCategoryUsage[] = STORAGE_CATEGORY_IDS.map((id) => {
        const bucket = buckets.get(id);
        return {
          id,
          bytes: bucket?.bytes ?? 0,
          fileCount: bucket?.fileCount ?? 0,
          cleanability: getStorageCategoryCleanability(id),
          entries: bucket ? foldEntries(bucket.entries, maxEntries) : [],
        };
      });
      return {
        id: spec.id,
        path: spec.path,
        volume,
        bytes: totalBytes,
        fileCount: totalFiles,
        categories,
      };
    },
  };
}

// 按 bytes 降序、同大小按路径升序排序，保证同一份数据在任何运行环境下顺序稳定。
// 排序会产生全量副本，但折叠本身只在快照时执行一次，成本可接受。
function foldEntries(
  entries: Map<string, { bytes: number; fileCount: number }>,
  maxEntries: number,
): StorageEntryUsage[] {
  const sorted = [...entries.entries()]
    .map(([relativePath, usage]) => ({ relativePath, ...usage }))
    .sort((a, b) => b.bytes - a.bytes || a.relativePath.localeCompare(b.relativePath));
// 未超出上限时原样返回，不追加折叠行，避免前端出现「还有 0 项」的噪声条目。
  if (sorted.length <= maxEntries) return sorted;
  const kept = sorted.slice(0, maxEntries);
  const rest = sorted.slice(maxEntries);
  kept.push({
    relativePath: STORAGE_MORE_ENTRIES_PATH,
    bytes: rest.reduce((sum, item) => sum + item.bytes, 0),
    fileCount: rest.reduce((sum, item) => sum + item.fileCount, 0),
  });
  return kept;
}
