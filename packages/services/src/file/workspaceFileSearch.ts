// Host 侧文件搜索候选构建与检索：把 Renderer 的长任务挪到共享 Host，但仍保持可中断。
// 边界：packed 索引格式由 workspaceFileEntriesCodec 定义，本文件只负责分批解码与 top-K 合并。
// 不变量(INV)：每批必须按行边界切分；同分候选保持原索引顺序，分批结果等价于整表排序。
// 改错会怎样：切在 entry 中间会解码失败；顺序不稳定会让排序在分批边界处抖动。
import { setImmediate } from "node:timers/promises";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";

/** 分批解码已有 packed 索引，防止把 Renderer 的长任务简单搬到共享 Host。 */
export async function buildHostFileSearchCandidates(packed: string, rootPath: string) {
// 全量收集后再返回，内存占用与索引规模成正比；这是换取只遍历一次的显式取舍。
  const candidates: WorkspaceFileSearchCandidate[] = [];
// 逐批解码而非一次 split：单批解完主动让出事件循环，避免长时间占用 Host 主线程。
  for (let offset = 0; offset < packed.length; ) {
// 从 128KB 之后找换行，保证每批足够大且切点落在 entry 边界，不会截断半条记录。
    const newline = packed.indexOf("\n", offset + 128_000);
    const end = newline < 0 ? packed.length : newline + 1;
    const entries = unpackWorkspaceFileEntries(packed.slice(offset, end), rootPath);
    for (const candidate of mapWorkspaceFileEntriesToSearchCandidates(entries))
      candidates.push(candidate);
    offset = end;
    await setImmediate();
  }
  return candidates;
}

// top-K 分批合并：每批只保留前 limit 条，因此最终结果与整表排序取前 limit 一致。
// 前提是 filter 对「已排序前缀 + 新批次」使用同一比较器且稳定，同分项不会跨批重排。
export async function searchHostFileCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
): Promise<WorkspaceFileEntry[]> {
  let best: WorkspaceFileSearchCandidate[] = [];
  // top-K 的输入按原索引顺序分批；同分时原序稳定，分批合并与整表排序一致。
// 2048 是单批上限：控制单次排序开销，同时让新的搜索请求能尽快抢占旧查询。
  for (let offset = 0; offset < candidates.length; offset += 2048) {
    best = filterWorkspaceFileSearchCandidates(
      [...best, ...candidates.slice(offset, offset + 2048)],
      query,
      { limit },
    );
    await setImmediate();
  }
  return best.map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
}
