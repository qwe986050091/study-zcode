// INV-01 会话以会话标识为唯一键：守住位置 会话映射写入；改错故障：按路径存会让同路径不同远端互相覆盖。
// INV-02 路径与身份两套索引并存：身份索引才保证主机加路径的唯一绑定，守住位置 两个索引字段；改错故障：只留路径索引会让跨主机同名路径串会话。
// INV-03 注销会话必须同时清理两套索引：守住位置 注销实现；改错故障：残留索引会让新会话按旧标识取到已销毁的服务。
// INV-04 解绑是幂等的：不存在时返回原状态，守住位置 解绑分支；改错故障：无条件构造新对象会让每次调用都触发订阅者重渲染。
// INV-05 连接浮层按工作区键存放：守住位置 浮层映射；改错故障：按会话存放会让重连期间新旧会话各显示一份状态。
// INV-06 注册前先预分配服务代际：守住位置 注册函数首段；改错故障：迟到的中间代理会把传输切回旧代。
// INV-07 注册换代必须先终结旧附着：守住位置 注册函数的旧会话判断；改错故障：旧端口挂起的请求跨代会永久悬置。
// INV-08 注销时即使无索引也要终结附着：守住位置 注销函数；改错故障：同步早于绑定时，仅靠索引清理无法中止挂起请求。
// INV-09 终结原因统一为断开错误：守住位置 两处终结调用；改错故障：原因不一致会让上层无法按错误类型识别断连。
// INV-10 无服务访问器时返回空而不是抛错：守住位置 按路径与按身份取服务；改错故障：抛错会让渲染期查询直接崩溃。
// INV-11 按路径与按身份的查找互不牵连：守住位置 两个查找函数；改错故障：混用会让未绑定的维度误命中另一维度。
// INV-12 由代理反查会话只用于诊断：守住位置 反查函数；改错故障：把它当路由依据会让旧代代理继续驱动界面。
// INV-13 统一解析顺序为身份、路径、基础服务：守住位置 解析函数分支；改错故障：顺序颠倒会让同路径不同远端取到基础服务。
// INV-14 空白身份与路径视为未提供：守住位置 各处去空白判断；改错故障：把空串当有效键会命中错误条目。
// INV-15 store 只做读写，不做业务校验：守住位置 全部 set 回调；改错故障：在 store 内发请求会让状态更新依赖网络结果。
// INV-16 导出函数是唯一对外入口：外部不直接持有 store 引用做批量写，守住位置 导出清单；改错故障：分散写入让顺序与清理逻辑无法集中审查。
// INV-17 半更新不可见：一次注销要在同一次 set 内返回三张新表，守住位置 注销返回值；改错故障：分多次 set 会让订阅者在中间态读到悬空索引。
// INV-18 基础服务单独存放且可覆盖：重连后新基础服务替换旧值，守住位置 注册基础服务；改错故障：追加而非替换会让旧基础服务继续被解析使用。
//
// 模块职责：维护远端工作区会话、路径与身份索引、连接浮层状态，并提供只读解析入口。
// 状态所有权：全部状态在 store 内；附着终结由外部注入的释放函数完成。
// 阅读顺序：先看会话结构与状态接口，再看待办动作，最后看注册注销与只读解析函数。
import { create } from "zustand";
import type { RemoteTarget, WorkspacePurpose } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { createRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";

// 会话记录把标识、身份、目标与服务访问器绑在一起
// [失败路径] 缺少身份字段时只能按路径索引，跨主机同名路径会串会话
// 目标字段用于重建连接，不参与唯一性判定
// 释放函数由附着方注入，store 不自己构造
// 旧路由标识仅作提示，不参与远端会话路由
export interface RemoteWorkspaceSession {
  sessionId: string;
  sourceServerId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  /** Desktop bind 返回的旧 route tab rekey 提示；不参与 remote session 路由。 */
  previousWorkspaceIdentity?: string;
  target?: RemoteTarget;
  services: IServiceAccessor;
  dispose?: (reason?: Error) => void;
}

export type RemoteWorkspaceConnectionOverlay = "disconnected" | "reconnecting";

// 状态接口把四张表与八个动作写在同一处，便于审阅
// [并发] 动作一律通过函数式更新读取最新状态，避免闭包过期
// 两套索引并存是刻意冗余，换取不同调用点的查询成本
// 连接浮层独立存放，与会话生命周期解耦
// 接口不暴露 set 本身，外部只能经动作修改
interface RemoteWorkspaceSessionState {
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, RemoteWorkspaceSession>;
  sessionIdByWorkspacePath: Record<string, string>;
  // 之前只按 workspacePath 建索引，同路径不同远端会互相覆盖。
  // 这里补充 workspaceIdentity -> session 的映射，保证远程会话按“主机+路径”唯一绑定。
  sessionIdByWorkspaceIdentity: Record<string, string>;
  connectionOverlayByWorkspaceKey: Record<string, RemoteWorkspaceConnectionOverlay>;
  registerBaseServices: (services: IServiceAccessor) => void;
  registerSession: (session: RemoteWorkspaceSession) => void;
  unregisterSession: (sessionId: string) => void;
  bindWorkspacePath: (workspacePath: string, sessionId: string) => void;
  unbindWorkspacePath: (workspacePath: string) => void;
  bindWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  unbindWorkspaceIdentity: (workspaceIdentity: string) => void;
  setConnectionOverlay: (workspaceKey: string, state: RemoteWorkspaceConnectionOverlay) => void;
  clearConnectionOverlay: (workspaceKey: string) => void;
}

// store 创建后立即给出四张空表与全部动作
// [失败路径] 动作内先读后写必须用函数式更新，否则并发注册会丢更新
// registerSession 按 sessionId 覆盖写入，允许同一标识换代。
// unregisterSession 在单次 set 内先清 sessionsById，再清路径与身份两张反查表。
// unbindWorkspacePath 与 unbindWorkspaceIdentity 在键不存在时返回原 state。
export const useRemoteWorkspaceSessionStore = create<RemoteWorkspaceSessionState>()((set) => ({
  baseServices: null,
  sessionsById: {},
  sessionIdByWorkspacePath: {},
  sessionIdByWorkspaceIdentity: {},
  connectionOverlayByWorkspaceKey: {},
  registerBaseServices: (services) =>
    set({
      baseServices: services,
    }),
  registerSession: (session) =>
    set((state) => ({
      sessionsById: {
        ...state.sessionsById,
        [session.sessionId]: session,
      },
    })),
  unregisterSession: (sessionId) =>
    set((state) => {
      const nextSessionsById = { ...state.sessionsById };
      delete nextSessionsById[sessionId];

      const nextSessionIdByWorkspacePath = Object.fromEntries(
        Object.entries(state.sessionIdByWorkspacePath).filter(
          ([, currentSessionId]) => currentSessionId !== sessionId,
        ),
      );

      const nextSessionIdByWorkspaceIdentity = Object.fromEntries(
        Object.entries(state.sessionIdByWorkspaceIdentity).filter(
          ([, currentSessionId]) => currentSessionId !== sessionId,
        ),
      );

      return {
        sessionsById: nextSessionsById,
        sessionIdByWorkspacePath: nextSessionIdByWorkspacePath,
        sessionIdByWorkspaceIdentity: nextSessionIdByWorkspaceIdentity,
      };
    }),
  bindWorkspacePath: (workspacePath, sessionId) =>
    set((state) => ({
      sessionIdByWorkspacePath: {
        ...state.sessionIdByWorkspacePath,
        [workspacePath]: sessionId,
      },
    })),
  unbindWorkspacePath: (workspacePath) =>
    set((state) => {
      if (!(workspacePath in state.sessionIdByWorkspacePath)) {
        return state;
      }

      const nextSessionIdByWorkspacePath = {
        ...state.sessionIdByWorkspacePath,
      };
      delete nextSessionIdByWorkspacePath[workspacePath];

      return {
        ...state,
        sessionIdByWorkspacePath: nextSessionIdByWorkspacePath,
      };
    }),
  bindWorkspaceIdentity: (workspaceIdentity, sessionId) =>
    set((state) => ({
      sessionIdByWorkspaceIdentity: {
        ...state.sessionIdByWorkspaceIdentity,
        [workspaceIdentity]: sessionId,
      },
    })),
  unbindWorkspaceIdentity: (workspaceIdentity) =>
    set((state) => {
      if (!(workspaceIdentity in state.sessionIdByWorkspaceIdentity)) {
        return state;
      }

      const nextSessionIdByWorkspaceIdentity = {
        ...state.sessionIdByWorkspaceIdentity,
      };
      delete nextSessionIdByWorkspaceIdentity[workspaceIdentity];

      return {
        ...state,
        sessionIdByWorkspaceIdentity: nextSessionIdByWorkspaceIdentity,
      };
    }),
  setConnectionOverlay: (workspaceKey, overlay) =>
    set((state) => ({
      connectionOverlayByWorkspaceKey: {
        ...state.connectionOverlayByWorkspaceKey,
        [workspaceKey]: overlay,
      },
    })),
  clearConnectionOverlay: (workspaceKey) =>
    set((state) => {
      if (!(workspaceKey in state.connectionOverlayByWorkspaceKey)) {
        return state;
      }
      const next = { ...state.connectionOverlayByWorkspaceKey };
      delete next[workspaceKey];
      return { connectionOverlayByWorkspaceKey: next };
    }),
}));

// 注册前先为代理服务预分配单调代际，锁定换代顺序
// [失败路径] 不预分配时，迟到的中间代理会把传输切回旧代
// 旧附着必须先终结，挂起的同步请求不能跨代悬置
// [并发] 预分配与终结之间没有等待，保证同一事件内完成换代
// 兼容形态下代理服务可能缺省，此时跳过预分配
export function registerRemoteWorkspaceSession(session: RemoteWorkspaceSession): void {
  // 同一 remoteSessionId 的 proxy 可连续换代，而不同 React consumer 的 effect
  // 提交顺序不可靠。session 注册是权威换代顺序，先在共享 generation 模块预分配
  // 单调代际，避免迟到的中间 proxy 把 transport 从最新代切回去。
  // Web/测试降级 accessor 可能暂未提供 agent transport；真正可订阅时 registry 仍会
  // 按首次观察分配 generation，不能为了预注册破坏这种兼容形态。
  if (session.services.zcodeAgentService) {
    remoteAgentServiceGeneration(session.services.zcodeAgentService);
  }
  const previousSession = useRemoteWorkspaceSessionStore.getState().sessionsById[session.sessionId];
  if (previousSession && previousSession !== session) {
    // 同一 remoteSessionId 的 attachment 换代时，旧 MessagePort 仍可能有挂起 RPC。
    // 先终结旧 transport，确保 provider sync 的 in-flight Promise 不会跨代永久悬置。
    previousSession.dispose?.(createRemoteWorkspaceDisconnectedError());
  }
  useRemoteWorkspaceSessionStore.getState().registerSession(session);
}

export function registerBaseWorkspaceServices(services: IServiceAccessor): void {
  useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
}

// 注销先取出会话再删索引，保证释放函数不丢
// [失败路径] 只清索引不终结附着，会让挂起请求永不返回
// 终结原因统一由 createRemoteWorkspaceDisconnectedError() 给出，便于上层按类型处理。
// 注销与注册对称：都要处理同一 sessionId 的旧附着。
// unregisterRemoteWorkspaceSession() 不检查会话是否存在，缺失时退化为纯清理。
export function unregisterRemoteWorkspaceSession(sessionId: string): void {
  const session = useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId];
  useRemoteWorkspaceSessionStore.getState().unregisterSession(sessionId);
  // 同步可能发生在 workspace bind 之前，无法仅靠索引清理 in-flight。
  // 注入的 disposer 直接终结 attachment，使 ChannelClient 将挂起 RPC fail-closed。
  session?.dispose?.(createRemoteWorkspaceDisconnectedError());
}

export function bindRemoteWorkspacePath(workspacePath: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.getState().bindWorkspacePath(workspacePath, sessionId);
}

export function unbindRemoteWorkspacePath(workspacePath: string): void {
  useRemoteWorkspaceSessionStore.getState().unbindWorkspacePath(workspacePath);
}

export function bindRemoteWorkspaceIdentity(workspaceIdentity: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.getState().bindWorkspaceIdentity(workspaceIdentity, sessionId);
}

export function unbindRemoteWorkspaceIdentity(workspaceIdentity: string): void {
  useRemoteWorkspaceSessionStore.getState().unbindWorkspaceIdentity(workspaceIdentity);
}

export function setRemoteWorkspaceConnectionState(
  workspaceKey: string,
  state: RemoteWorkspaceConnectionOverlay,
): void {
  useRemoteWorkspaceSessionStore.getState().setConnectionOverlay(workspaceKey, state);
}

export function clearRemoteWorkspaceConnectionState(workspaceKey: string): void {
  useRemoteWorkspaceSessionStore.getState().clearConnectionOverlay(workspaceKey);
}

export function getRemoteWorkspaceConnectionState(
  workspaceKey: string,
): RemoteWorkspaceConnectionOverlay | undefined {
  return useRemoteWorkspaceSessionStore.getState().connectionOverlayByWorkspaceKey[workspaceKey];
}

// getRemoteWorkspaceSession() 按 sessionId 直接取，未命中返回 null 而不是抛错。
// [失败路径] 若 getRemoteWorkspaceSession() 抛错，渲染期查询会把整棵界面带崩。
// findRemoteWorkspaceSessionIdForAgentService() 只用于 scope 诊断，不能作为路由依据。
// getRemoteWorkspaceServicesForPath() 与 ...ForIdentity() 是两个独立入口，互不回退。
// 两个入口在未绑定时都返回 null，兜底交由上层决定。
export function getRemoteWorkspaceSession(sessionId: string): RemoteWorkspaceSession | null {
  return useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId] ?? null;
}

/** 当前在册代理的远程 session 身份；旧代代理不匹配，仅用于 scope 诊断。 */
export function findRemoteWorkspaceSessionIdForAgentService(agentService: object): string | null {
  for (const session of Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById)) {
    if (session.services.zcodeAgentService === agentService) {
      return session.sessionId;
    }
  }
  return null;
}

export function getRemoteWorkspaceServicesForPath(workspacePath: string): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspacePath[workspacePath];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRemoteWorkspaceServicesForIdentity(
  workspaceIdentity: string,
): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspaceIdentity[workspaceIdentity];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRegisteredBaseWorkspaceServices(): IServiceAccessor | null {
  return useRemoteWorkspaceSessionStore.getState().baseServices;
}

// 统一解析顺序固定：身份优先、路径其次、基础服务兜底
// [失败路径] 顺序颠倒会让同路径不同远端取到基础服务
// workspaceIdentity 空白字符串视为未提供，避免命中空键条目。
// 兜底返回 getRegisteredBaseWorkspaceServices()，保证调用方拿到可用访问器。
// resolveRegisteredWorkspaceServices() 不做连通性校验，只回答当前登记了谁。
export function resolveRegisteredWorkspaceServices(params: {
  workspacePath?: string;
  workspaceIdentity?: string;
}): IServiceAccessor | null {
  if (params.workspaceIdentity?.trim()) {
    return (
      getRemoteWorkspaceServicesForIdentity(params.workspaceIdentity) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  if (params.workspacePath?.trim()) {
    return (
      getRemoteWorkspaceServicesForPath(params.workspacePath) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  return getRegisteredBaseWorkspaceServices();
}
