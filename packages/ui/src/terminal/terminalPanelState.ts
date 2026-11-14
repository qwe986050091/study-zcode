// INV-01 两表分离：守住位置 sessions 与 workspaces；改错故障：工作区状态携带会话对象副本，关闭后残留。
// INV-02 标识唯一：守住位置 新建会话的标识；改错故障：两个会话共用标识，关闭互串。
// INV-03 最小空位：守住位置 编号推导；改错故障：关闭中间编号后新建跳号。
// INV-04 编号可复用：守住位置 从一递增查找；改错故障：编号只增不减，标签序号膨胀。
// INV-05 单一活动：守住位置 活动标识字段；改错故障：多个会话同时被当作活动。
// INV-06 关闭有动作：守住位置 动作判定；改错故障：最后一个会话被当成普通关闭，面板空壳。
// INV-07 缺失即无：守住位置 会话与工作区的存在判断；改错故障：对已删除标识继续操作。
// INV-08 回退有据：守住位置 前一个与首个的顺序；改错故障：关闭活动会话后没有活动项。
// INV-09 退出删记录：守住位置 退出路径的删除；改错故障：最后标签退出后仍保留空工作区。
// INV-10 懒创建：守住位置 存活会话判断；改错故障：每次挂载都新建 PTY。
// INV-11 不可变更新：守住位置 返回新对象；改错故障：就地修改旧状态，订阅方收不到更新。
// INV-12 未变即回：守住位置 早退分支；改错故障：无意义更新触发重渲染。
// INV-13 编号来自事实：守住位置 会话描述符；改错故障：另存计数与事实漂移。
// INV-14 标题归一：守住位置 首个会话分支；改错故障：单标签也带序号。
// INV-15 键唯一：守住位置 工作区键；改错故障：不同工作区共享终端。
// INV-16 外壳可空：守住位置 标签默认值；改错故障：未探测时出现空标签。
// INV-17 顺序稳定：守住位置 标识数组；改错故障：关闭后标签顺序跳动。
// INV-18 纯函数：守住位置 全部导出函数；改错故障：模块内持有可变单例。
//
// 模块职责：管理终端面板的会话与工作区关系，处理编号、关闭、退出与懒创建。
// 状态所有权：状态由调用方持有；本模块只负责变换。
// 阅读顺序：类型 → 会话创建 → 工作区创建 → 编号 → 关闭动作 → 关闭 → 退出 → 确保存在。
import type { IServiceAccessor } from "@zcode/services";
import { createUuid } from "@zcode/shared";

export interface TerminalSessionDescriptor {
  id: string;
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
  index: number;
  shellLabel: string | null;
}

export interface TerminalWorkspaceState {
  sessionIds: string[];
  activeSessionId: string;
}

// 会话表与工作区表分离，工作区只存标识顺序。
// 活动会话标识独立存放，关闭时可单独回退。
//
export interface TerminalPanelState {
  sessions: Record<string, TerminalSessionDescriptor>;
  workspaces: Record<string, TerminalWorkspaceState>;
}

// 新建会话生成新标识，编号由调用方给出。
// createTerminalSession 先把 shellLabel 置空，探测到 shell 后再由 updateTerminalSession 补齐。
//
export function createTerminalSession(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
  index: number;
}): TerminalSessionDescriptor {
  return {
    id: createUuid(),
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: params.index,
    shellLabel: null,
  };
}

// 首个会话编号固定为一。
// 工作区状态初始只含这一个会话并设为活动。
//
export function createWorkspaceTerminalState(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
}): {
  session: TerminalSessionDescriptor;
  workspace: TerminalWorkspaceState;
} {
  const session = createTerminalSession({
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: 1,
  });

  return {
    session,
    workspace: {
      sessionIds: [session.id],
      activeSessionId: session.id,
    },
  };
}

// getNextTerminalSessionIndex 只扫描 workspace.sessionIds 推导已用编号，不读任何持久计数。
// 从 1 起递增找第一个未占用的下标，关闭某个终端后它的编号会被下一次新建复用。
// 不持久化 nextIndex 这类派生计数，避免它与 sessionIds 两份状态各说各话。
//
export function getNextTerminalSessionIndex(
  state: TerminalPanelState,
  workspaceKey: string,
): number {
  const workspace = state.workspaces[workspaceKey];
  const usedIndices = new Set(
    workspace?.sessionIds
      .map((sessionId) => state.sessions[sessionId]?.index)
      .filter((index): index is number => typeof index === "number") ?? [],
  );

  // 把 nextIndex 作为只增不减的派生状态保存，会让关闭编号 2 后再新建错误地得到 3。
  // 编号事实已经存在于 session descriptor 中，创建时从现存 session 推导最小空位，避免两份状态漂移。
  for (let index = 1; ; index += 1) {
    if (!usedIndices.has(index)) {
      return index;
    }
  }
}

export function formatTerminalTabTitle(projectName: string, index: number): string {
  return index === 1 ? projectName : `${projectName} ${index}`;
}

export type TerminalSessionCloseAction = "none" | "close-panel" | "close-session";

export interface TerminalSessionExitResult {
  state: TerminalPanelState;
  action: TerminalSessionCloseAction;
}

// 会话与工作区任一缺失都返回无动作。
// 工作区只剩一个会话时关闭整个面板。
//
export function getTerminalSessionCloseAction(
  state: TerminalPanelState,
  sessionId: string,
): TerminalSessionCloseAction {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return "none";
  }

  return workspace.sessionIds.length === 1 ? "close-panel" : "close-session";
}

// 只有关闭会话动作才继续处理。
// 回退到前一个会话，没有则取首个。
//
export function closeTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
): TerminalPanelState {
  if (getTerminalSessionCloseAction(state, sessionId) !== "close-session") {
    return state;
  }

  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace) {
    return state;
  }

  const closingIndex = workspace.sessionIds.indexOf(sessionId);
  const nextSessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
  const fallbackSessionId = nextSessionIds[Math.max(0, closingIndex - 1)] ?? nextSessionIds[0];
  if (!fallbackSessionId) {
    return state;
  }

  const { [sessionId]: _closedSession, ...nextSessions } = state.sessions;
  return {
    sessions: nextSessions,
    workspaces: {
      ...state.workspaces,
      [session.workspaceKey]: {
        sessionIds: nextSessionIds,
        activeSessionId:
          workspace.activeSessionId === sessionId ? fallbackSessionId : workspace.activeSessionId,
      },
    },
  };
}

// 会话仍在工作区时按普通关闭处理。
// 会话已不在 workspace.sessionIds 里时 exitTerminalSession 直接删除记录，下次用时走懒创建。
//
export function exitTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
  activeWorkspaceKey: string,
): TerminalSessionExitResult {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return { state, action: "none" };
  }

  // 最后一个标签由退出路径自行删除记录。
  // 只有退出的是 activeWorkspaceKey 对应会话时才收起面板，其他工作区保持展开。
  //
  if (workspace.sessionIds.length > 1) {
    return {
      state: closeTerminalSession(state, sessionId),
      action: "close-session",
    };
  }

  // PTY 自身已经退出时，最后一个 tab 不能像手动关闭那样只收起面板并保活。
  // 这里同时删除 session/workspace 记录；重新打开该 workspace 时再由 ensure 懒创建新 PTY。
  const { [sessionId]: _exitedSession, ...nextSessions } = state.sessions;
  const { [session.workspaceKey]: _exitedWorkspace, ...nextWorkspaces } = state.workspaces;
  return {
    state: {
      sessions: nextSessions,
      workspaces: nextWorkspaces,
    },
    action: session.workspaceKey === activeWorkspaceKey ? "close-panel" : "close-session",
  };
}

// 已有存活会话时原样返回。
// 否则创建新的工作区会话并写入两张表。
//
export function ensureWorkspaceTerminalState(
  state: TerminalPanelState,
  params: {
    workspaceKey: string;
    services: IServiceAccessor;
    cwd?: string;
  },
): TerminalPanelState {
  const existingWorkspace = state.workspaces[params.workspaceKey];
  if (existingWorkspace?.sessionIds.some((sessionId) => state.sessions[sessionId])) {
    return state;
  }

  const { session, workspace } = createWorkspaceTerminalState(params);
  return {
    sessions: {
      ...state.sessions,
      [session.id]: session,
    },
    workspaces: {
      ...state.workspaces,
      [params.workspaceKey]: workspace,
    },
  };
}
