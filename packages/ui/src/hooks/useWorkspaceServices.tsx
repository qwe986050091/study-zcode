// INV-01 断连服务单例：守住位置 模块缓存；改错故障 每次渲染新建代理。
// INV-02 命令一律拒绝：守住位置 调用实现；改错故障 断连后仍发 RPC。
// INV-03 事件返回空订阅：守住位置 监听实现；改错故障 释放订阅时崩溃。
// INV-04 代理复用真实分类契约：守住位置 通道代理；改错故障 两套事件规则漂移。
// INV-05 远程目标缺会话即断连：守住位置 空值回退；改错故障 请求误路由到本机。
// INV-06 远程目标不回落本机：守住位置 早退分支；改错故障 远程任务查不到。
// INV-07 未注册时用上下文服务：守住位置 空值合并；改错故障 初始化阶段无服务。
// INV-08 基础服务优先注册值：守住位置 合并顺序；改错故障 远端连接污染本地查询。
// INV-09 远程判定先看标识：守住位置 非空判断；改错故障 路径相同被当本地。
// INV-10 路径相同再看身份：守住位置 相等分支；改错故障 同路径远程误判。
// INV-11 活动页远程元数据兜底：守住位置 标签判断；改错故障 仅路径调用走错主机。
// INV-12 多标签同路径不判定：守住位置 数量判断；改错故障 本地多开被当远程。
// INV-13 无路径直接判本地：守住位置 空值早退；改错故障 空路径触发远程查询。
// INV-14 强制无作用域关闭远程：守住位置 选项判断；改错故障 设置页被绑到远端。
// INV-15 连接态三值：守住位置 三元链；改错故障 就绪判断失真。
// INV-16 等待态不可发 RPC：守住位置 就绪字段；改错故障 重连期反复失败重试。
// INV-17 返回值按依赖记忆：守住位置 记忆化；改错故障 每次渲染触发下游重算。
// INV-18 对外保留解析钩子：守住位置 导出函数；改错故障 调用方无法读连接态。
//
// 模块职责：按工作区身份解析应使用的服务访问器与连接态。
// 状态所有权：会话服务归远端会话库，本模块只做选择与降级。
// 阅读顺序：先看断连代理，再看目标解析，最后看解析钩子。
import type { IServiceAccessor } from "@zcode/services";
import { Event, ProxyChannel, type IChannel } from "@zcode/rpc";
import { useMemo } from "react";
import { useOptionalServices, useServices } from "@/hooks/useServices.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE } from "@/lib/remoteWorkspaceServiceError.js";

let disconnectedRemoteServices: IServiceAccessor | null = null;

interface WorkspaceServiceTargetTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

// disconnectedChannel.call 直接 Promise.reject，命令不会静默挂起。
// createDisconnectedError 把 error.code 设为 REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE。
// disconnectedChannel.listen 统一返回 Event.None，普通事件与动态事件同一套规则。
// serviceProxy 复用 ProxyChannel.toService，事件分类契约与真实 RPC 代理一致。
// getDisconnectedRemoteServices 用模块级 disconnectedRemoteServices 缓存，避免每次新建代理。
function createDisconnectedRemoteServices(): IServiceAccessor {
  const createDisconnectedError = () => {
    const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
      code: string;
    };
    error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
    return error;
  };
  const disconnectedChannel: IChannel = {
    call: () => Promise.reject(createDisconnectedError()),
    listen: () => Event.None,
  };
  // 断连代理曾自行维护普通事件白名单，新增 onAgentRuntimeRestarted 后被误判成
  // RPC 方法并返回 Promise，释放订阅时触发 Promise.dispose 崩溃。这里复用真实 RPC 代理的
  // 事件分类契约：命令明确拒绝，普通/动态事件统一返回空订阅，避免两套规则再次漂移。
  const serviceProxy = ProxyChannel.toService<object>(disconnectedChannel);

  return new Proxy(Object.create(null), {
    get() {
      return serviceProxy;
    },
  }) as IServiceAccessor;
}

export function getDisconnectedRemoteServices(): IServiceAccessor {
  if (!disconnectedRemoteServices) {
    disconnectedRemoteServices = createDisconnectedRemoteServices();
  }
  return disconnectedRemoteServices;
}

// resolvedRemoteSessionId 命中 sessionsById 时优先取该会话的 services。
// isRemoteTarget 且查不到服务时返回 getDisconnectedRemoteServices()，不回落本地。
// 本地目标取 unscopedServices 或 baseServices，两者都空才继续下沉。
// unscopedServices 供 user/server 作用域的设置页显式注入 SourceSettingsAttachment。
// 所有分支都为 null 时返回 currentContextServices 兜底。
export function resolveWorkspaceServicesForTarget(params: {
  currentContextServices: IServiceAccessor;
  resolvedRemoteSessionId: string | null;
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, Pick<RemoteWorkspaceSession, "services">>;
  isRemoteTarget: boolean;
  /** 无 workspace 的设置 user/server scope 可显式指定 SourceSettingsAttachment。 */
  unscopedServices?: IServiceAccessor;
}): IServiceAccessor {
  const resolvedServices = params.resolvedRemoteSessionId
    ? (params.sessionsById[params.resolvedRemoteSessionId]?.services ?? null)
    : params.isRemoteTarget
      ? getDisconnectedRemoteServices()
      : (params.unscopedServices ?? params.baseServices);

  if (params.isRemoteTarget && !resolvedServices) {
    return getDisconnectedRemoteServices();
  }

  return resolvedServices ?? params.currentContextServices;
}

export function resolveBaseWorkspaceServices(
  contextServices: IServiceAccessor,
  registeredBaseServices: IServiceAccessor | null,
): IServiceAccessor {
  return registeredBaseServices ?? contextServices;
}

function hasRemoteWorkspaceMetadata(tab: WorkspaceServiceTargetTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

// workspaceIdentity 或 preferredRemoteSessionId 去空后非空即判远程。
// workspacePath 为空时返回 false，没有路径就没有 workspace 可判。
// activeWorkspacePath 与 workspacePath 相同时，再看 activeWorkspaceIdentity 是否非空。
// activeTab 的远程元数据由 hasRemoteWorkspaceMetadata 判定，兜住 path-only 调用。
// workspaceTabs 里同路径标签多于一个时返回 false，不猜是哪台主机。
export function resolveWorkspaceServiceIsRemoteTarget(params: {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  preferredRemoteSessionId?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeTab?: WorkspaceServiceTargetTab | null;
  workspaceTabs?: readonly WorkspaceServiceTargetTab[];
}): boolean {
  if (params.workspaceIdentity?.trim() || params.preferredRemoteSessionId?.trim()) {
    return true;
  }

  const workspacePath = params.workspacePath?.trim();
  if (!workspacePath) {
    return false;
  }

  if (params.activeWorkspacePath === params.workspacePath) {
    if (params.activeWorkspaceIdentity?.trim()) {
      return true;
    }

    // 日志里远程 SSH workspace 已经恢复成 tab，但草稿预热入口一度只拿到
    // workspacePath，导致 /mnt/... 被当成本地 workspace 走 base services 并在 Windows 上 spawn 本地 agent。
    // 这里用当前 tab 的远程元数据兜住这类 path-only 调用，避免远程目标误回落到本机 host。
    if (
      params.activeTab?.workspacePath === params.workspacePath &&
      hasRemoteWorkspaceMetadata(params.activeTab)
    ) {
      return true;
    }
  }

  const matchingTabs = (params.workspaceTabs ?? []).filter(
    (tab) => tab.workspacePath === params.workspacePath,
  );
  return matchingTabs.length === 1 && hasRemoteWorkspaceMetadata(matchingTabs[0]);
}

export function useBaseWorkspaceServices(): IServiceAccessor {
  const contextServices = useServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // App 会在当前激活 workspace 外层再套一层 ServiceProvider。
  // 激活远端 tab 后，useServices() 读到的是远端 host；但 timeline/search/workspace
  // 这类跨 workspace 查询里的本地 shard 必须继续查本机 host。
  // 这里优先使用 renderer 启动时注册的根 services，避免远端连接污染本地任务列表。
  return resolveBaseWorkspaceServices(contextServices, registeredBaseServices);
}

export function useOptionalBaseWorkspaceServices(): IServiceAccessor | null {
  const contextServices = useOptionalServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // usage entitlement 等 app-global 能力曾从当前 workspace ServiceProvider
  // 取服务；远端 tab 在 attachment ready 前会得到断连代理并产生无效 RPC。base host 才是
  // app-global 权威；Web/SSR 未注册 base services 时保留原有 context/null 降级语义。
  return registeredBaseServices ?? contextServices;
}

export interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

// isRemoteTarget 但 resolvedRemoteSessionId 缺失时返回断连服务，保持 disconnected 态。
// forceUnscoped 为真时按本地无作用域解析，忽略远程元数据。
// connectionKind 由会话是否可用推出 local-ready 或 remote-waiting。
// 等待态禁止发 RPC。
// 结果按依赖记忆。
export function useWorkspaceServicesResolution(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  options?: { unscopedServices?: IServiceAccessor; forceUnscoped?: boolean },
): WorkspaceServicesResolution {
  const currentContextServices = useServices();
  const resolvedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const inferredRemoteTarget = useTabStore((state) =>
    resolveWorkspaceServiceIsRemoteTarget({
      workspacePath,
      workspaceIdentity,
      preferredRemoteSessionId,
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      activeTab: (() => {
        const activeTab = state.activeTabId
          ? state.tabs.find((tab) => tab.id === state.activeTabId)
          : null;
        return activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
      })(),
      workspaceTabs: state.tabs.filter(isWorkspaceTab),
    }),
  );
  const isRemoteTarget = options?.forceUnscoped ? false : inferredRemoteTarget;
  const effectiveRemoteSessionId = options?.forceUnscoped ? null : resolvedRemoteSessionId;
  const resolvedServices = useRemoteWorkspaceSessionStore((state) =>
    resolveWorkspaceServicesForTarget({
      currentContextServices,
      resolvedRemoteSessionId: effectiveRemoteSessionId,
      baseServices: state.baseServices,
      sessionsById: state.sessionsById,
      isRemoteTarget,
      unscopedServices: options?.unscopedServices,
    }),
  );
  const connectionKind = isRemoteTarget
    ? effectiveRemoteSessionId
      ? "remote-ready"
      : "remote-waiting"
    : "local-ready";

  // 远程 SSH host 断开后，若在 resolvedRemoteSessionId 为空时回退到 baseServices，
  // /root 这类远程 task 会被本机 host 查询并报“task 不存在”。远程目标缺少 session 时必须保持断连态，
  // 由上面的断连代理给出可恢复错误，而不是把请求误路由到本机 workspace。
  // 启动重连期仅有 tab 元数据、真实 remote services 尚未注册时属于 remote-waiting；
  // 调用方必须暂停 workspace RPC，断连代理只保留为最终越界保护，不能把预期等待态当失败重试。
  return useMemo(
    () => ({
      services: resolvedServices,
      remoteSessionId: effectiveRemoteSessionId,
      isRemoteTarget,
      connectionKind,
      rpcReady: connectionKind !== "remote-waiting",
    }),
    [connectionKind, effectiveRemoteSessionId, isRemoteTarget, resolvedServices],
  );
}

export function useWorkspaceServices(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
  options?: { unscopedServices?: IServiceAccessor; forceUnscoped?: boolean },
): IServiceAccessor {
  return useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
    options,
  ).services;
}
