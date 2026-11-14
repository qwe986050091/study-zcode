// INV-01 历史是纯数据不可变更新：守住位置 模块职责；改错故障 引入 React 状态导致多处源。
// INV-02 指针负一表示空历史：守住位置 初始值；改错故障 新历史误判为可后退。
// INV-03 条目身份含工作区身份：守住位置 身份字段比较；改错故障 本地与远端同路径互相覆盖。
// INV-04 相邻重复不入栈：守住位置 入栈前比较；改错故障 连续打开同一目标产生重复项。
// INV-05 入栈截断前进分支：守住位置 切片边界；改错故障 后退后再操作仍能前进到旧分支。
// INV-06 历史上限固定：守住位置 溢出判断；改错故障 长时间使用内存持续增长。
// INV-07 溢出后指针同步偏移：守住位置 游标计算；改错故障 指针指向被丢弃的条目。
// INV-08 自动化条目带标签与标识：守住位置 可选字段展开；改错故障 打开详情丢失所在标签。
// INV-09 插件商店是独立种类：守住位置 种类值；改错故障 与自动化页共用返回目标。
// INV-10 后退判定看指针位置：守住位置 大于零；改错故障 首项仍显示可后退。
// INV-11 前进判定看右端：守住位置 长度比较；改错故障 末项仍显示可前进。
// INV-12 越界条目返回空：守住位置 空值检查；改错故障 返回 undefined 条目给调用方。
// INV-13 后退前进不修改原历史：守住位置 展开复制；改错故障 共享引用被就地改写。
// INV-14 删除任务保留自动化条目：守住位置 过滤条件；改错故障 自动化页从历史消失。
// INV-15 未命中删除原样返回：守住位置 长度比较；改错故障 无变化也产生新对象。
// INV-16 全删后回到初始历史：守住位置 空数组分支；改错故障 指针停在越界位置。
// INV-17 当前项未被删则保持指向：守住位置 索引查找；改错故障 删除其他任务后跳走。
// INV-18 当前项被删则夹到最近位置：守住位置 最小值计算；改错故障 指针越界。
//
// 模块职责：工作区导航的浏览器式前进后退栈，纯数据结构与不可变更新。
// 状态所有权：实例由会话 store 持有，本模块不缓存任何模块级状态。
// 阅读顺序：先看条目类型与身份比较，再看入栈与溢出，最后看前进后退与删除。
/**
 * Workspace 导航历史 —— 浏览器式前进/后退栈
 *
 * 纯数据结构 + 不可变更新函数，不含 React 依赖。
 * 由 zcodeSessionStore 持有实例并驱动 UI 状态。
 */

// WorkspaceNavEntryBase 统一带 workspacePath 字段。
// 远端工作区再带 workspaceIdentity 隔离键。
// workspaceIdentity 缺省即本地路径。
// 基础接口只声明 workspacePath 与 workspaceIdentity。
interface WorkspaceNavEntryBase {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TaskNavEntry extends WorkspaceNavEntryBase {
  kind: "task";
  taskId: string;
}

// "workflow" 是自动化页的顶级「工作流」标签；
// scheduled / idle 仍是「自动化」标签内部的胶囊。
export type AutomationsNavigationTab = "scheduled" | "idle" | "workflow";

export type OpenAutomationsMain = (
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
) => void;

export interface AutomationsNavEntry extends WorkspaceNavEntryBase {
  kind: "automations";
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export interface PluginStoreNavEntry extends WorkspaceNavEntryBase {
  kind: "plugin-store";
}

export type WorkspaceNavEntry = TaskNavEntry | AutomationsNavEntry | PluginStoreNavEntry;

export interface TaskNavigationHistory {
  entries: WorkspaceNavEntry[];
  /** 当前指针，指向 entries 中的索引；-1 表示空 */
  cursor: number;
}

// MAX_HISTORY 定死为 50，防止无限增长。
// 溢出时从 entries 头部丢弃最旧项。
// cursor 随丢弃量同步回退。
const MAX_HISTORY = 50;

export function createTaskNavigationHistory(): TaskNavigationHistory {
  return { entries: [], cursor: -1 };
}

export function isTaskNavEntry(
  entry: WorkspaceNavEntry,
): entry is TaskNavEntry {
  return entry.kind === "task";
}

export function isAutomationsNavEntry(
  entry: WorkspaceNavEntry,
): entry is AutomationsNavEntry {
  return entry.kind === "automations";
}

export function isPluginStoreNavEntry(entry: WorkspaceNavEntry): entry is PluginStoreNavEntry {
  return entry.kind === "plugin-store";
}

function isSameNavEntry(
  left: WorkspaceNavEntry,
  right: WorkspaceNavEntry,
): boolean {
  if (
    left.kind !== right.kind ||
    left.workspacePath !== right.workspacePath ||
    left.workspaceIdentity !== right.workspaceIdentity
  ) {
    return false;
  }

  if (left.kind === "task") return left.taskId === (right as TaskNavEntry).taskId;
  if (left.kind === "automations") {
    const rightAutomations = right as AutomationsNavEntry;
    return (
      left.automationId === rightAutomations.automationId &&
      left.automationTab === rightAutomations.automationTab
    );
  }
  return true;
}

// cursor 为 -1 时 current 为 null，跳过重复判断。
// pushEntry() 先 slice 截掉 cursor 之后的前进分支。
// 超过 MAX_HISTORY 时按 overflow 裁掉最旧条目。
function pushEntry(
  history: TaskNavigationHistory,
  entry: WorkspaceNavEntry,
): TaskNavigationHistory {
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null;

  // 相邻去重：历史回放或连续打开同一目标时不重复入栈。
  if (current && isSameNavEntry(current, entry)) {
    return history;
  }

  // 截断 cursor 之后的前进历史，保持浏览器式导航语义。
  const next = [...history.entries.slice(0, history.cursor + 1), entry];
  if (next.length > MAX_HISTORY) {
    const overflow = next.length - MAX_HISTORY;
    return {
      entries: next.slice(overflow),
      cursor: next.length - overflow - 1,
    };
  }

  return { entries: next, cursor: next.length - 1 };
}

/** 用户主动选择/创建 task 时调用。 */
export function pushNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  // 远程 workspace 的导航不能只记路径。
  // 同一路径在本地/远端或多台远端机器上可能同时存在，必须把身份隔离键一起入栈。
  return pushEntry(history, {
    kind: "task",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    taskId,
  });
}

/** 用户主动打开 Automations 主视图或指定详情时调用。 */
export function pushAutomationsNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
  automationId?: string,
  automationTab?: AutomationsNavigationTab,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "automations",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(automationId ? { automationId } : {}),
    ...(automationTab ? { automationTab } : {}),
  });
}

export function pushPluginStoreNavEntry(
  history: TaskNavigationHistory,
  workspacePath: string,
  workspaceIdentity?: string,
): TaskNavigationHistory {
  return pushEntry(history, {
    kind: "plugin-store",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

export function canGoBack(history: TaskNavigationHistory): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: TaskNavigationHistory): boolean {
  return history.cursor < history.entries.length - 1;
}

/** 后退一步，返回新的 history 和目标 entry。 */
export function goBack(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoBack(history)) {
    return null;
  }

  const nextCursor = history.cursor - 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/** 前进一步，返回新的 history 和目标 entry。 */
export function goForward(
  history: TaskNavigationHistory,
): { history: TaskNavigationHistory; entry: WorkspaceNavEntry } | null {
  if (!canGoForward(history)) {
    return null;
  }

  const nextCursor = history.cursor + 1;
  const entry = history.entries[nextCursor];
  if (!entry) {
    return null;
  }

  return {
    history: { ...history, cursor: nextCursor },
    entry,
  };
}

/**
 * 从历史中移除指定 taskId 的所有 task 条目（task 被删除时调用）。
 * Automations 条目不属于 task 生命周期，必须原样保留。
 */
// 只过滤 isTaskNavEntry() 命中的条目。
// 长度未变即未命中，直接返回 history 原对象。
// 当前项被删时 cursor 夹到 filtered.length - 1。
export function removeTaskFromHistory(
  history: TaskNavigationHistory,
  taskId: string,
): TaskNavigationHistory {
  const currentEntry =
    history.cursor >= 0 ? history.entries[history.cursor] : null;
  const filtered = history.entries.filter(
    (entry) => !isTaskNavEntry(entry) || entry.taskId !== taskId,
  );

  if (filtered.length === history.entries.length) {
    return history;
  }

  if (filtered.length === 0) {
    return createTaskNavigationHistory();
  }

  // 当前条目未被删除时保持指向它；被删时沿用旧位置选择最近目标。
  const currentEntryIndex = currentEntry ? filtered.indexOf(currentEntry) : -1;
  const cursor =
    currentEntryIndex >= 0
      ? currentEntryIndex
      : Math.min(history.cursor, filtered.length - 1);

  return { entries: filtered, cursor };
}
