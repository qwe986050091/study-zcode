// 文件变更摘要：把持久化的 change 快照折叠成“每轮”或“整任务”的统计。
import type {
  ZCodePersistedFileChange,
  ZCodeTaskChangeSummary,
  ZCodeTaskChangedFileSummary,
  ZCodeTaskMeta,
} from "@zcode/shared";
import { computeLineChangeStat } from "@zcode/shared";

// 跨轮聚合中间态：保留最初内容与最终内容，用于计算整任务 diff。
// writeCount 与 lastTurnIndex 只做展示，不参与 diff 计算。
interface AggregatedFileChange {
  path: string;
  originalContent: string | null;
  finalContent: string;
  writeCount: number;
  lastTurnIndex: number;
}

/**
 * 按轮次分组构建文件变更摘要。
 * 每个轮次独立计算 diff，用于在每条 assistant 消息下方显示该轮的文件改动。
 */
// 输入为空时返回空 Map，调用方无需判空。
// 结果以 turnIndex 为键，天然按轮次去重。
// 只读入参，不修改快照数组本身。
// 每轮在 turn.snapshots 内部独立算 diff，轮次之间不共享状态：前一轮的写入不会改变后一轮的摘要。
// 快照先按路径聚合再算 diff，同文件只产出一条。
export function buildPerTurnChangeSummaries(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): Map<number, ZCodeTaskChangeSummary> {
  const result = new Map<number, ZCodeTaskChangeSummary>();
  if (!fileChanges || fileChanges.length === 0) {
    return result;
  }

  for (const turn of fileChanges) {
// 没有快照的轮次不产生摘要条目。
    if (turn.snapshots.length === 0) {
      continue;
    }

    // Aggregate snapshots by path so that the same file edited multiple times
    // within one turn produces a single entry (original before → final after).
// 同一轮内按路径聚合：首次写入记录 before，后续只更新 after 与次数。
// 因此同一文件多次编辑只产生一条摘要。
    const turnFileMap = new Map<
      string,
      { beforeContent: string | null; afterContent: string; writeCount: number }
    >();
    for (const snapshot of turn.snapshots) {
// 已存在说明本轮再次写同一文件，只更新最终内容。
      const existing = turnFileMap.get(snapshot.path);
      if (existing) {
// afterContent 始终取最新一次写入的结果。
        existing.afterContent = snapshot.afterContent;
        existing.writeCount += snapshot.writeCount;
      } else {
// beforeContent 取该文件在本轮第一次写入前的内容。
        turnFileMap.set(snapshot.path, {
          beforeContent: snapshot.beforeContent,
          afterContent: snapshot.afterContent,
          writeCount: snapshot.writeCount,
        });
      }
    }

    let added = 0;
    let removed = 0;
// 逐文件计算行级 diff，并累加本轮总增删。
// 最终按路径字典序排序，保证展示顺序稳定。
    const files: ZCodeTaskChangedFileSummary[] = Array.from(turnFileMap.entries())
      .map(([path, file]) => {
// diff 计算复用 shared 实现，保证与 UI 其它位置口径一致。
        const fileStat = computeLineChangeStat(file.beforeContent, file.afterContent);
        added += fileStat.added;
        removed += fileStat.removed;
        return {
          path,
          added: fileStat.added,
          removed: fileStat.removed,
          writeCount: file.writeCount,
          lastTurnIndex: turn.turnIndex,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

// fileCount 使用聚合后的文件数，而不是快照条数。
// added/removed 是本轮所有文件之和。
    result.set(turn.turnIndex, {
      fileCount: files.length,
      added,
      removed,
      files,
    });
  }

  return result;
}

// 整任务摘要：跨轮聚合同一文件，使用最初 before 与最后 after 计算总 diff。
// 没有任何写入时返回 undefined。
// 与 buildPerTurnChangeSummaries 的唯一差别是聚合范围（跨轮 vs 按轮），两者都返回 ZCodeTaskChangeSummary，字段一致。
export function buildTaskChangeSummary(
  fileChanges: readonly ZCodePersistedFileChange[] | undefined,
): ZCodeTaskChangeSummary | undefined {
  if (!fileChanges || fileChanges.length === 0) {
    return undefined;
  }

// 以路径为键跨轮合并，保持首次出现顺序。
  const changedFileMap = new Map<string, AggregatedFileChange>();

  for (const turn of fileChanges) {
    for (const snapshot of turn.snapshots) {
      const existing = changedFileMap.get(snapshot.path);
      if (existing) {
// 后续轮次只覆盖 finalContent、累加 writeCount、推进 lastTurnIndex，并保持条目身份不变，不会重复计入 files。
        existing.finalContent = snapshot.afterContent;
        existing.writeCount += snapshot.writeCount;
// 最后写入轮次用于展示“最近改动在何时”。
        existing.lastTurnIndex = turn.turnIndex;
        continue;
      }

// 首次出现时把 originalContent 与 finalContent 一起写入，后续轮次只改这两个字段，不会新建条目。
// lastTurnIndex 随每次写入推进。
      changedFileMap.set(snapshot.path, {
        path: snapshot.path,
        originalContent: snapshot.beforeContent,
        finalContent: snapshot.afterContent,
        writeCount: snapshot.writeCount,
        lastTurnIndex: turn.turnIndex,
      });
    }
  }

// 全为空快照时视为无变更。
  if (changedFileMap.size === 0) {
    return undefined;
  }

  let added = 0;
  let removed = 0;
// 逐文件计算整任务 diff，累加总增删后按路径排序。
  const files: ZCodeTaskChangedFileSummary[] = Array.from(changedFileMap.values())
    .map((file) => {
// 用 originalContent 与 finalContent 直接算总 diff，跳过中间轮次：中间状态对整任务结果没有意义。
      const fileStat = computeLineChangeStat(file.originalContent, file.finalContent);
      added += fileStat.added;
      removed += fileStat.removed;
      return {
        path: file.path,
        added: fileStat.added,
        removed: fileStat.removed,
        writeCount: file.writeCount,
        lastTurnIndex: file.lastTurnIndex,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    fileCount: files.length,
    added,
    removed,
    files,
  };
}
