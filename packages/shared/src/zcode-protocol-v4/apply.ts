// INV-01 不可变入口不改入参：守住位置 applyConversationDelta；改错故障 已发布快照被后续事件篡改。
// INV-02 可变累加器只服务未发布快照：守住位置 接口注释与 create；改错故障 订阅者看到半成品。
// INV-03 两套实现语义一致：守住位置 同名 case 分支；改错故障 冷恢复与在线增量结果不同。
// INV-04 未加载 rowId 一律 no-op：守住位置 index === -1 与 undefined 判断；改错故障 被逐出的行被局部复活。
// INV-05 row.delta 按路径分派：守住位置 appendToRow 的 switch；改错故障 文本追加写错字段。
// INV-06 行类型不符即原样返回：守住位置 每个 case 的 kind 判断；改错故障 reasoning 被追加到文本行。
// INV-07 row.removed 从 fromRowId 起裁剪：守住位置 filter 与写指针；改错故障 删除边界偏移一位。
// INV-08 裁掉整条活跃分支要清计数：守住位置 removesEntireActiveBranch；改错故障 UI 误判可加载更早。
// INV-09 state.updated 键级替换：守住位置 展开与 Object.assign；改错故障 深层对象被静默合并。
// INV-10 pluginUi 通知不改快照：守住位置 四个空分支；改错故障 renderer 派发被重复计为状态变更。
// INV-11 workflowRuns 增量规则外置：守住位置 两个转调点；改错故障 两个 twin 各写一份规则而走散。
// INV-12 首行锚点只在空时建立：守住位置 ??= 与 ??；改错故障 追加覆盖已有 firstRowId。
// INV-13 原地删除后重建索引：守住位置 clear 与 forEach；改错故障 后续 upsert 命中错位置。
// INV-14 批量函数只按序归约：守住位置 两个 for 循环；改错故障 合并顺序改变最终语义。
//
// 模块职责：协议 delta 的规范应用语义，同时提供不可变与候选快照原地两套实现。
// 阅读顺序：先看累加器与 appendToRow，再看不可变 switch，最后逐分支对照可变实现。
// Delta 应用语义的规范实现（纯函数）。
// 这是协议语义的一部分：coalesce 的「语义保持」就以本函数为裁判——
// applyAll(s, coalesce(ds)) 必须与 applyAll(s, ds) 逐字节一致（黄金测试）。
// 客户端 store 的 apply 逻辑是本函数的宿主化改写，不得引入额外分支。
import type { StreamablePath } from "./core.js";
import type { ConversationDelta } from "./delta.js";
import type { ConversationRow } from "./rows.js";
import type { ConversationSnapshot } from "./snapshot.js";
import { applyWorkflowRunRemoved, applyWorkflowRunUpdated } from "./workflow-runs-delta.js";

/**
 * 仅供服务端在未发布的候选快照内批量归约使用。
 *
 * 冷恢复逐条调用不可变 apply 时，每次 append/upsert 都复制随历史增长的
 * rows.window，并再次线性查找 rowId，长会话因此退化为 O(N²)。候选快照尚未对外可见，
 * 可以在这条明确的隔离边界内复用同一份数组和增量索引；普通客户端仍使用上面的
 * 不可变语义，避免已发布快照被后续事件篡改。
 */
// 可变累加器只允许在隔离边界内使用。
export interface MutableConversationSnapshotAccumulator {
  snapshot: ConversationSnapshot;
  rowIndexById: Map<number, number>;
}

export function createMutableConversationSnapshotAccumulator(
  snapshot: ConversationSnapshot,
): MutableConversationSnapshotAccumulator {
  // 构造时复制一次窗口，之后原地改写。
  const window = [...snapshot.rows.window];
  return {
    snapshot: {
      ...snapshot,
      rows: { ...snapshot.rows, window },
    },
    rowIndexById: new Map(window.map((row, index) => [row.rowId, index])),
  };
}

// row.delta 只允许作用于流式态行（§4.4.4 不变量，服务端保证）。
// 本函数按协议语义实现为：路径不存在/行不存在时 no-op（§4.3：patch 命中未加载行 = no-op）。
// 文本追加按路径分派，行类型不符即原样返回。
function appendToRow(
  row: ConversationRow,
  path: StreamablePath,
  append: string,
): ConversationRow {
  switch (path) {
    case "text":
      if (row.kind === "assistantText" || row.kind === "reasoning") {
        return { ...row, text: row.text + append };
      }
      return row;
    case "inputText":
      if (row.kind === "toolCall") {
        return { ...row, inputText: row.inputText + append };
      }
      return row;
    case "output.text":
      // 输出文本只在已有 output 时追加。
      if (row.kind === "toolCall" && row.output) {
        return {
          ...row,
          output: { ...row.output, text: row.output.text + append },
        };
      }
      return row;
    case "summaryText":
      if (row.kind === "subagent") {
        return { ...row, summaryText: row.summaryText + append };
      }
      return row;
  }
}

/** 应用单条 delta，返回新快照（入参不被修改）。 */
export function applyConversationDelta(
  snapshot: ConversationSnapshot,
  delta: ConversationDelta,
): ConversationSnapshot {
  switch (delta.op) {
    // row.appended 同时更新 rows.total 与 rows 首行锚点，两者必须同增。
    case "row.appended":
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window: [...snapshot.rows.window, delta.row],
          totalCount: snapshot.rows.totalCount + 1,
          firstRowId: snapshot.rows.firstRowId ?? delta.row.rowId,
        },
      };
    case "row.upserted": {
      const index = snapshot.rows.window.findIndex(
        (row) => row.rowId === delta.row.rowId,
      );
      // §4.3：未加载 rowId = no-op（被逐出的行只能经 rows/range 取回）。
      // 未加载的 rowId 一律 no-op。
      if (index === -1) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = delta.row;
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "row.removed": {
      const window = snapshot.rows.window.filter(
        (row) => row.rowId < delta.fromRowId,
      );
      const removed = snapshot.rows.window.length - window.length;
      // 从首行开始裁剪时必须重置整条活跃分支，否则 activeBranch 会指向已删行。
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window,
          // rewind 首轮后 rowId 继续单调递增；若保留旧 firstRowId，UI 会把
          // 旧分支留下的 rowId 空洞误判成“加载更早”。全量和尾窗都必须在从首行
          // 开始裁剪时清空 active-branch 分页锚点与计数，下一次 append 再建立新首行。
          // 整条分支裁剪后计数归零。
          totalCount: removesEntireActiveBranch
            ? 0
            : Math.max(0, snapshot.rows.totalCount - removed),
          firstRowId: removesEntireActiveBranch ? null : snapshot.rows.firstRowId,
        },
      };
    }
    case "row.delta": {
      const index = snapshot.rows.window.findIndex(
        (row) => row.rowId === delta.rowId,
      );
      const target = snapshot.rows.window[index];
      if (index === -1 || target === undefined) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = appendToRow(target, delta.path, delta.append);
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    // state.updated 按键级整体替换，绝不深合并旧值。
    case "state.updated":
      // 键级整体替换：patch 中在场的键覆盖，绝不深合并。
      return { ...snapshot, ...delta.patch };
    case "pluginUi.resourceUpdated":
    case "pluginUi.resourceListChanged":
    case "pluginUi.instanceClosed":
    // live-only 通知不改变快照。
    case "pluginUi.appToolCall":
      // live-only 通知 / 信箱投递：不改变快照，由 renderer 另行派发。
      return snapshot;
    // workflowRuns 是唯一开了增量口子的状态键（delta.ts 的注释讲了为什么）。规则整份住在
    // workflow-runs-delta.ts：两个 twin 都只转调它，两边的语义因此没有走散的余地。
    case "workflowRun.updated":
      return {
        ...snapshot,
        // 增量规则外置，两个 twin 只转调。
        workflowRuns: applyWorkflowRunUpdated(snapshot.workflowRuns, delta),
      };
    case "workflowRun.removed":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunRemoved(snapshot.workflowRuns, delta),
      };
  }
}

/** 按序应用一串 delta。 */
export function applyConversationDeltas(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationSnapshot {
  let current = snapshot;
  for (const delta of deltas) {
    current = applyConversationDelta(current, delta);
  }
  return current;
}

/**
 * 在未发布候选快照上原地应用单条 delta；语义必须与 applyConversationDelta 一致。
 * 调用者不得把 accumulator.snapshot 暴露给订阅者后继续调用本函数。
 */
export function applyConversationDeltaMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  delta: ConversationDelta,
): void {
  const snapshot = accumulator.snapshot;
  switch (delta.op) {
    case "row.appended":
      accumulator.rowIndexById.set(delta.row.rowId, snapshot.rows.window.length);
      snapshot.rows.window.push(delta.row);
      snapshot.rows.totalCount += 1;
      snapshot.rows.firstRowId ??= delta.row.rowId;
      return;
    case "row.upserted": {
      const index = accumulator.rowIndexById.get(delta.row.rowId);
      if (index === undefined) return;
      snapshot.rows.window[index] = delta.row;
      return;
    }
    case "row.removed": {
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      let writeIndex = 0;
      for (const row of snapshot.rows.window) {
        if (row.rowId >= delta.fromRowId) continue;
        snapshot.rows.window[writeIndex] = row;
        writeIndex += 1;
      }
      const removed = snapshot.rows.window.length - writeIndex;
      snapshot.rows.window.length = writeIndex;
      snapshot.rows.totalCount = removesEntireActiveBranch
        ? 0
        : Math.max(0, snapshot.rows.totalCount - removed);
      snapshot.rows.firstRowId = removesEntireActiveBranch ? null : snapshot.rows.firstRowId;
      // 删除后重建索引，保证后续 upsert 命中。
      accumulator.rowIndexById.clear();
      snapshot.rows.window.forEach((row, index) => accumulator.rowIndexById.set(row.rowId, index));
      return;
    }
    case "row.delta": {
      const index = accumulator.rowIndexById.get(delta.rowId);
      if (index === undefined) return;
      const target = snapshot.rows.window[index];
      if (target === undefined) return;
      snapshot.rows.window[index] = appendToRow(target, delta.path, delta.append);
      return;
    }
    case "state.updated":
      // 与不可变实现相同：patch 在场键整体替换，不能深合并。
      Object.assign(snapshot, delta.patch);
      return;
    case "pluginUi.resourceUpdated":
    case "pluginUi.resourceListChanged":
      return;
    // 与不可变实现调同一个纯函数：workflowRuns 是状态键不是 rows 窗口，没有「原地追加」可优化，
    // 而 accumulator.snapshot 本来就是候选快照自己的对象，赋一个新容器不会碰到已发布的快照。
    case "workflowRun.updated":
      // 赋新容器，不触碰已发布快照。
      snapshot.workflowRuns = applyWorkflowRunUpdated(snapshot.workflowRuns, delta);
      return;
    case "workflowRun.removed":
      snapshot.workflowRuns = applyWorkflowRunRemoved(snapshot.workflowRuns, delta);
  }
}

/** 按序原地应用一串 delta，仅适用于未发布的候选快照。 */
export function applyConversationDeltasMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) applyConversationDeltaMutable(accumulator, delta);
}
