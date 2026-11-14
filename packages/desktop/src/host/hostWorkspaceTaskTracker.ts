// 按 workspace 统计运行中的 Host 任务数，并向 main 上报计数变化。
//
// 职责：以 workspaceKey 为维度维护 activeTaskIds 集合与全局总数；begin/finish 成对使用，
// clearWorkspace 在 workspace 关闭时兜底清理。每次计数变化都回调 report。
// 输入输出：createHostWorkspaceTaskTracker(report) 返回 { begin, finish,
// getRunningTaskCount, getTotalRunningTaskCount, clearWorkspace }；begin 返回是否真正新增。
// 副作用：写内部 Map 与全局计数；触发 report 回调。
// 失败语义：不抛出；重复 begin 返回 false、未知 task 的 finish/clear 为 no-op。
// 维护的不变量：计数只随 begin/finish 变化，不能把 sendPrompt 的 resolve(ACK) 当成任务结束；
// totalRunningTaskCount 单调非负（finish/clear 都用 Math.max(0, ...) 兜底）。

import { resolveWorkspaceKey } from "@zcode/shared";

export interface HostWorkspaceTaskContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface HostWorkspaceTaskCountEvent extends HostWorkspaceTaskContext {
  runningTaskCount: number;
}

// 创建 workspace 任务计数器。
// entries 以 resolveWorkspaceKey(context) 为键：同一物理工作区在不同 identity 下不应重复计数。
// reportEntry 只上报当前 entry 的计数，删表后不补零（调用方按最后一次事件理解）。
export function createHostWorkspaceTaskTracker(
  report: (event: HostWorkspaceTaskCountEvent) => void,
): {
  begin: (taskId: string, context: HostWorkspaceTaskContext) => boolean;
  finish: (taskId: string, context: HostWorkspaceTaskContext) => void;
  getRunningTaskCount: (context: HostWorkspaceTaskContext) => number;
  getTotalRunningTaskCount: () => number;
  clearWorkspace: (context: HostWorkspaceTaskContext) => void;
} {
  const entries = new Map<
    string,
    { context: HostWorkspaceTaskContext; activeTaskIds: Set<string> }
  >();
  let totalRunningTaskCount = 0;

  // 上报某 workspace 当前的运行任务数（含 context 供 main 定位）。
  function reportEntry(entry: {
    context: HostWorkspaceTaskContext;
    activeTaskIds: Set<string>;
  }): void {
    report({ ...entry.context, runningTaskCount: entry.activeTaskIds.size });
  }

  return {
    getRunningTaskCount(context) {
      return entries.get(resolveWorkspaceKey(context))?.activeTaskIds.size ?? 0;
    },

    getTotalRunningTaskCount() {
      return totalRunningTaskCount;
    },

    // 开始一个任务：已存在同 taskId 时返回 false（幂等，防止重复计数）。
    // 首次出现该 workspace 时新建 entry；新增后立即上报，main 据此展示运行中。
    begin(taskId, context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey) ?? {
        context,
        activeTaskIds: new Set<string>(),
      };
      if (entry.activeTaskIds.has(taskId)) {
        return false;
      }
      entry.activeTaskIds.add(taskId);
      totalRunningTaskCount += 1;
      entries.set(workspaceKey, entry);
      reportEntry(entry);
      return true;
    },

    // 结束任务：只减一次（delete 返回 false 时直接返回），计数归零后删除 entry。
    // 不能把 sendPrompt resolve 当结束信号，任务只由 task ready 事件收尾（见下方原注释）。
    finish(taskId, context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey);
      if (!entry?.activeTaskIds.delete(taskId)) {
        return;
      }
      totalRunningTaskCount = Math.max(0, totalRunningTaskCount - 1);
      if (entry.activeTaskIds.size === 0) {
        entries.delete(workspaceKey);
      }
      // sendPrompt resolve 只是 ACK，不能代表 Agent 已空闲。计数只由 task ready
      // 事件结束，避免共享 WSL Host 在关闭 workspace 时误杀仍在执行工具的 Agent。
      reportEntry(entry);
    },

    // workspace 关闭时的兜底清理：整表删除并扣减其全部 active 任务数。
    // 用于共享 Host（如 WSL Pool）中 workspace 被销毁但任务未逐个 finish 的场景。
    clearWorkspace(context) {
      const workspaceKey = resolveWorkspaceKey(context);
      const entry = entries.get(workspaceKey);
      if (!entry) {
        return;
      }
      entries.delete(workspaceKey);
      totalRunningTaskCount = Math.max(0, totalRunningTaskCount - entry.activeTaskIds.size);
      entry.activeTaskIds.clear();
      reportEntry(entry);
    },
  };
}
