// INV-01 内存按工作区隔离：守住位置 键构造；改错故障 不同工作区共用同一侧栏。
// INV-02 键为空即无状态：守住位置 空值判断；改错故障 出现全局共享的假工作区。
// INV-03 读取不改变语义：守住位置 归一化副本；改错故障 调用方拿到可变共享对象。
// INV-04 读取算一次访问：守住位置 触碰函数；改错故障 热工作区被当作最旧淘汰。
// INV-05 容量上限固定：守住位置 常量与裁剪；改错故障 长时间运行内存无界增长。
// INV-06 淘汰从最旧开始：守住位置 迭代顺序；改错故障 淘汰最近使用的状态。
// INV-07 默认值覆盖全部字段：守住位置 默认对象；改错故障 缺字段导致读取方崩溃。
// INV-08 侧栏状态写入前归一：守住位置 归一调用；改错故障 非法标签进入内存。
// INV-09 对话级记录浅合并：守住位置 合并分支；改错故障 只写一个对话就清掉其他对话。
// INV-10 完整视图整块替换：守住位置 patch 分支；改错故障 旧快照覆盖新状态。
// INV-11 收起偏好按对话存储：守住位置 键选择；改错故障 一个对话的偏好在全局生效。
// INV-12 草稿使用固定键：守住位置 空值兜底；改错故障 草稿偏好写入未定义键。
// INV-13 完整视图读取无副作用：守住位置 直接查表；改错故障 渲染期改变 LRU 顺序。
// INV-14 自动打开只消费一次：守住位置 记录集合；改错故障 同一调用重复打开侧栏。
// INV-15 自动打开同步登记：守住位置 写入位置；改错故障 并发锚点同时通过检查。
// INV-16 删除整块视图即移除键：守住位置 删除分支；改错故障 空记录常驻。
// INV-17 测试清理只清内存：守住位置 专用函数；改错故障 测试之间状态串味。
// INV-18 已废弃字段仅用于读取：守住位置 类型注释；改错故障 新代码继续写入旧字段。
//
// 模块职责：按工作区缓存对话侧栏的展开、视图、浏览器与自动打开记录。
// 状态所有权：全部状态在模块级 Map 中，按最近使用淘汰。
// 阅读顺序：先看状态结构与默认值，再看读取与写入，最后看对话级偏好的专用入口。
import type { GitChangeSourceId } from "@zcode/shared";
import type { SidePaneFullViewState } from "@/side-pane-full-view/contract.js";
import {
  normalizeWorkspaceSidePaneState,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

export interface TaskSidePaneMemoryState {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
  /** 对话级展开/收起偏好；tabs 本身仍按 workspace 复用。 */
  sidePaneCollapsedByOwner: Record<string, boolean>;
  /** 对话级完整视图状态（docs/ui/side-pane-full-view.md）；缺省表示普通视图。 */
  sidePaneFullViewByOwner: Record<string, SidePaneFullViewState>;
  /** 工具调用的自动打开已消费记录；不随消息行卸载清空。 */
  pluginUiAutoOpenKeys: ReadonlySet<string>;
  activeGitSourceId: GitChangeSourceId;
  browserUrls: Record<string, string>;
  /** @deprecated 旧版单浏览器 tab 的 URL，保留用于读取历史内存状态。 */
  browserUrl: string | null;
}

const DEFAULT_TASK_SIDE_PANE_MEMORY_STATE: TaskSidePaneMemoryState = {
  sidePaneState: null,
  isSidePaneCollapsed: true,
  sidePaneCollapsedByOwner: {},
  sidePaneFullViewByOwner: {},
  pluginUiAutoOpenKeys: new Set(),
  activeGitSourceId: "unstaged",
  browserUrls: {},
  browserUrl: null,
};

export const TASK_SIDE_PANE_MEMORY_MAX_ENTRIES = 50;

const DRAFT_SIDE_PANE_OWNER_KEY = "__draft__";

// taskSidePaneMemory 用 workspaceIdentity 或 workspacePath 作索引键。
// buildTaskSidePaneMemoryKey() 返回 null 表示没有可用工作区。
// touchTaskSidePaneMemoryEntry() 先 delete 再 set，写入即提升到 LRU 头部。
// pruneTaskSidePaneMemory() 在 size > TASK_SIDE_PANE_MEMORY_MAX_ENTRIES 时从 Map 头部淘汰。
// DEFAULT_TASK_SIDE_PANE_MEMORY_STATE 只读共享，读取方不得就地修改。
const taskSidePaneMemory = new Map<string, TaskSidePaneMemoryState>();

function touchTaskSidePaneMemoryEntry(
  key: string,
  state: TaskSidePaneMemoryState,
): TaskSidePaneMemoryState {
  taskSidePaneMemory.delete(key);
  taskSidePaneMemory.set(key, state);
  return state;
}

function pruneTaskSidePaneMemory(): void {
  while (taskSidePaneMemory.size > TASK_SIDE_PANE_MEMORY_MAX_ENTRIES) {
    const oldestKey = taskSidePaneMemory.keys().next().value;
    if (!oldestKey) {
      return;
    }

    taskSidePaneMemory.delete(oldestKey);
  }
}

export function buildTaskSidePaneMemoryKey({
  workspacePath,
  workspaceIdentity,
  taskId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
}): string | null {
  // side pane 的语义是“当前 workspace 右侧辅助工作区”，
  // 不是 task 自己的私有上下文。之前把 taskId 拼进 key 之后，
  // 同一 workspace 下切换 task 会命中一份全新的 side pane 内存，
  // 导致用户正在看的 browser / git / code viewer 像是被“切任务顺手清空”。
  // 这里改回只按 workspace 身份隔离，让同 workspace 的 task 共用同一份 side pane 状态。
  void taskId;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return workspaceKey.trim() ? workspaceKey : null;
}

// key 为 null 时 readTaskSidePaneMemoryState() 直接返回默认值。
// taskSidePaneMemory 中没有该 key 时同样返回默认值。
// sidePaneState 先过 normalizeWorkspaceSidePaneState() 再返回。
// sidePaneCollapsedByOwner 用展开运算浅合并，不整块替换。
// 命中的读取也会 touch，算一次 LRU 访问。
export function readTaskSidePaneMemoryState(key: string | null): TaskSidePaneMemoryState {
  if (!key) {
    return DEFAULT_TASK_SIDE_PANE_MEMORY_STATE;
  }

  const state = taskSidePaneMemory.get(key);
  if (!state) {
    return DEFAULT_TASK_SIDE_PANE_MEMORY_STATE;
  }

  const normalizedState = {
    ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE,
    ...state,
    sidePaneState: normalizeWorkspaceSidePaneState(state.sidePaneState),
    sidePaneCollapsedByOwner: {
      ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.sidePaneCollapsedByOwner,
      ...state.sidePaneCollapsedByOwner,
    },
    sidePaneFullViewByOwner: { ...state.sidePaneFullViewByOwner },
  };
  return touchTaskSidePaneMemoryEntry(key, normalizedState);
}

// key 为 null 时 saveTaskSidePaneMemoryState() 直接 return。
// 合并顺序固定为默认值、旧 state、patch 三层。
// sidePaneFullViewByOwner 只允许专用入口整体替换，不走 patch 合并。
// 写入后立即调用 pruneTaskSidePaneMemory() 裁剪。
export function saveTaskSidePaneMemoryState(
  key: string | null,
  patch: Partial<TaskSidePaneMemoryState>,
): void {
  if (!key) {
    return;
  }

  // side pane memory 是 renderer 模块级缓存，长期切换大量 workspace 时旧 key
  // 如果永不淘汰会持续持有 tabs、browser URL、diff patch 等状态。这里用简单 LRU 上限
  // 保留最近访问的 workspace 状态，避免长时间运行时 Map 无界增长。
  const nextState = {
    ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE,
    ...taskSidePaneMemory.get(key),
    ...patch,
    sidePaneCollapsedByOwner: {
      ...DEFAULT_TASK_SIDE_PANE_MEMORY_STATE.sidePaneCollapsedByOwner,
      ...taskSidePaneMemory.get(key)?.sidePaneCollapsedByOwner,
      ...patch.sidePaneCollapsedByOwner,
    },
    // 完整视图记录由专用写入口整体替换，普通 patch 只保留已有记录，避免旧快照覆盖新状态。
    sidePaneFullViewByOwner:
      patch.sidePaneFullViewByOwner ?? taskSidePaneMemory.get(key)?.sidePaneFullViewByOwner ?? {},
  };
  nextState.sidePaneState = normalizeWorkspaceSidePaneState(nextState.sidePaneState);
  touchTaskSidePaneMemoryEntry(key, nextState);
  pruneTaskSidePaneMemory();
}

export function getSidePaneCollapsedPreference(
  state: TaskSidePaneMemoryState,
  ownerTaskId: string | null | undefined,
): boolean | undefined {
  return state.sidePaneCollapsedByOwner[ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY];
}

export function saveTaskSidePaneCollapsedPreference(
  key: string | null,
  ownerTaskId: string | null | undefined,
  isSidePaneCollapsed: boolean,
): void {
  if (!key) return;

  const state = readTaskSidePaneMemoryState(key);
  const ownerKey = ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY;
  saveTaskSidePaneMemoryState(key, {
    isSidePaneCollapsed,
    sidePaneCollapsedByOwner: {
      ...state.sidePaneCollapsedByOwner,
      [ownerKey]: isSidePaneCollapsed,
    },
  });
}

/** 渲染期读取：不触碰 LRU 顺序，保证 render 无副作用。 */
export function peekTaskSidePaneFullView(
  key: string | null,
  ownerTaskId: string | null | undefined,
): SidePaneFullViewState | null {
  if (!key) return null;
  return (
    taskSidePaneMemory.get(key)?.sidePaneFullViewByOwner[
      ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY
    ] ?? null
  );
}

export function saveTaskSidePaneFullView(
  key: string | null,
  ownerTaskId: string | null | undefined,
  value: SidePaneFullViewState | null,
): void {
  if (!key) return;
  const ownerKey = ownerTaskId ?? DRAFT_SIDE_PANE_OWNER_KEY;
  const next = { ...taskSidePaneMemory.get(key)?.sidePaneFullViewByOwner };
  if (value) {
    next[ownerKey] = value;
  } else {
    delete next[ownerKey];
  }
  saveTaskSidePaneMemoryState(key, { sidePaneFullViewByOwner: next });
}

export function clearTaskSidePaneMemoryStateForTest(): void {
  taskSidePaneMemory.clear();
}

export function claimPluginUiSidePaneAutoOpen(
  workspaceKey: string | null,
  requestKey: string,
): boolean {
  if (!workspaceKey) return false;
  const state = readTaskSidePaneMemoryState(workspaceKey);
  if (state.pluginUiAutoOpenKeys.has(requestKey)) return false;
  // 根因：行内 useRef 在会话切换/虚拟卸载后丢失，旧 fullscreen 结果会覆盖已保存的收起状态。
  // 与侧栏偏好共用同一内存 owner；同步消费也保证同一调用的多个锚点只触发一次。
  saveTaskSidePaneMemoryState(workspaceKey, {
    pluginUiAutoOpenKeys: new Set([...state.pluginUiAutoOpenKeys, requestKey]),
  });
  return true;
}
