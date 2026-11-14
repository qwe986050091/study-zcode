// ============================================================
// memory/recall/index —— Semantic Recall 的公共入口与单会话配额
// ============================================================
//
// 【定位】recall 子模块的 barrel：统一导出 manifest/selector/content 的 API，
//   并集中维护“单会话召回状态”（manifest 缓存、已召回路径、字符配额）。
//
// 【读写边界】本文件不读写磁盘；状态只存在于当前会话内存。
// 【配额口径】单会话召回正文累计上限 61440 字符（约 60k），
//   按 content.length 计（不是字节），与注入体积近似对应。
// 【失效口径】state 随会话生命周期存在；进程重启或会话切换即重置，
//   manifest 缓存也随之失效。
// 【失败语义】所有函数不抛错；配额只阻止新增召回，不回收已注入内容。
// ============================================================
import type { RecalledMemory, MemoryRecallState } from "./types.js";

// 公共 API 再导出：调用方只从 memory/recall/index 引入，避免依赖内部文件布局。

export { formatMemoryManifest, getMemoryRecallManifest, scanMemoryManifest } from "./manifest.js";
export {
  buildMemorySelectorRequest,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  isMemoryRecallQueryEligible,
  runMemorySelector,
} from "./selector.js";
export { formatRelevantMemoryAttachment, readRecalledMemories } from "./content.js";
export type {
  MemoryManifestEntry,
  MemoryRecallState,
  MemoryRecallType,
  MemorySelectorResult,
  RecalledMemory,
} from "./types.js";

// 单会话召回正文的累计字符上限（约 60k），防止多轮召回挤占上下文预算。
export const MEMORY_RECALL_SESSION_CHARACTER_LIMIT = 61_440;

/**
 * 创建一份新的会话召回状态。
 * 输出：字符计数 0、已召回路径为空 Set、无 manifest 与选择器对话缓存。
 * 副作用：无。
 */
export function createMemoryRecallState(): MemoryRecallState {
  return {
    recalledContentCharacters: 0,
    recalledPaths: new Set(),
  };
}

/**
 * 是否还允许发起下一轮召回。
 * 口径：累计字符严格小于上限；已达上限后不再调用 selector 与读文件，
 * 但已注入内容保持原样（不做回收）。
 */
export function canStartMemoryRecall(state: MemoryRecallState): boolean {
  return state.recalledContentCharacters < MEMORY_RECALL_SESSION_CHARACTER_LIMIT;
}

/**
 * 把成功注入的召回结果记入会话状态。
 * 输入：会话状态与本次召回列表。
 * 输出：无（原地修改 state）。
 * 副作用：向 recalledPaths 加路径、累加 content.length。
 * 不变量：路径去重由 Set 保证；字符计数按“注入正文长度”计，
 *   与 canStartMemoryRecall 的判定单位一致。
 */
export function recordRecalledMemories(
  state: MemoryRecallState,
  memories: readonly RecalledMemory[],
): void {
  for (const memory of memories) {
    state.recalledPaths.add(memory.filePath);
    state.recalledContentCharacters += memory.content.length;
  }
}
