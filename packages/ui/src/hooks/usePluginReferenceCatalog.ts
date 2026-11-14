// INV-01 服务解析只做一次：守住位置 hook 顶部；改错故障 请求与订阅各取一份实例。
// INV-02 结果必须绑定作用域：守住位置 作用域对象比较；改错故障 旧目录回填到新会话。
// INV-03 请求键覆盖全部边界：守住位置 键拼接；改错故障 切换远端仍复用旧进程缓存。
// INV-04 运行时重启推进代次：守住位置 事件订阅；改错故障 新进程继续读旧权威。
// INV-05 非目标工作区事件忽略：守住位置 键比较；改错故障 其他工作区重启导致本页重查。
// INV-06 关闭时返回空状态：守住位置 早退分支；改错故障 菜单关闭后仍展示旧数据。
// INV-07 序号丢弃过期回包：守住位置 序号比较；改错故障 慢请求覆盖新结果。
// INV-08 失败不回退数据源：守住位置 错误分支；改错故障 回退到工作区目录造成越权展示。
// INV-09 错误日志可抑制：守住位置 选项判断；改错故障 高频失败刷屏。
// INV-10 去重仅限同会话：守住位置 会话判断；改错故障 草稿态也进单飞缓存。
// INV-11 缓存请求结算即释放：守住位置 释放调用；改错故障 成功结果永久驻留。
// INV-12 释放不误删新请求：守住位置 身份比较；改错故障 旧请求清掉同键新请求。
// INV-13 清理同时取消与释放：守住位置 effect 收尾；改错故障 卸载后仍写入状态。
// INV-14 结果对象整体替换：守住位置 状态赋值；改错故障 局部更新留下旧字段。
// INV-15 权威来源随结果返回：守住位置 状态字段；改错故障 界面无法区分来源。
// INV-16 加载态先于请求落地：守住位置 发起前赋值；改错故障 首帧显示空列表。
// INV-17 请求参数按存在性拼装：守住位置 条件展开；改错故障 传入未定义字段。
// INV-18 依赖数组覆盖键的构成：守住位置 依赖列表；改错故障 键变了但不重查。
//
// 模块职责：按工作区与会话权威读取插件引用目录，供对话引用选择器使用。
// 状态所有权：作用域对象、运行时代次与请求序号属于 hook，服务由解析结果注入。
// 阅读顺序：先看键与作用域，再看重启订阅，最后看请求与清理。
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodePluginReferenceCatalogEntry,
  ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface PluginReferenceCatalogState {
  entries: ZCodePluginReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: PluginReferenceCatalogState = {
  entries: [],
  authority: null,
  loading: false,
  error: null,
};

interface ScopedPluginReferenceCatalogState {
  scope: object | null;
  value: PluginReferenceCatalogState;
}

const EMPTY_SCOPED_STATE: ScopedPluginReferenceCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

export interface PluginReferenceCatalogOptions {
  preferredRemoteSessionId?: string;
  /** 显式重试代次；菜单重开时重新查询，关闭菜单不清空已加载的目录。 */
  refreshRevision?: number;
  /** 仅合并当前 runtime 内尚未完成的同一 Session 请求；settle 后立即释放。 */
  dedupeSessionRequest?: boolean;
  suppressErrorLog?: boolean;
}

let sessionCatalogRequests = new WeakMap<
  object,
  Map<string, Promise<ZCodePluginsReferenceCatalogResult>>
>();

export function clearPluginReferenceCatalogCacheForTest(): void {
  sessionCatalogRequests = new WeakMap();
}

function releaseSessionCatalogRequest(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  // 成功 Promise 曾永久驻留，并在 Agent runtime 换代后继续冒充新
  // runtime 的 Session authority。缓存只能做挂载期的 in-flight 单飞；旧请求
  // settle/unmount 时也不能误删同 key 下已经替换的新请求。
  if (serviceCache.get(requestKey) !== request) return;
  serviceCache.delete(requestKey);
  if (serviceCache.size === 0) {
    sessionCatalogRequests.delete(services);
  }
}

function releaseSessionCatalogRequestWhenSettled(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  const release = () => releaseSessionCatalogRequest(services, serviceCache, requestKey, request);
  void request.then(release, release);
}

/**
 * Plugin 对话引用 catalog。
 * authority 由 sessionId 决定：null（新建草稿）→ workspace 当前 catalog；
 * 非 null（已有 Session）→ 该 Session 创建时冻结的 session-owned catalog。
 * 异步结果按 `workspaceKey + sessionId + runtime restart 代次 + 请求序号` 校验：key 变化或新请求发出后，
 * 旧 workspace/session/进程代次的返回一律丢弃，不得回填到新目标。
 */
// useWorkspaceServicesResolution 在最外层解析一次，向下复用 services。
// requestScope 是结果新鲜度凭证，旧作用域的结果一律丢弃。
// requestKey 由 workspaceKey、sessionId、remoteSessionId、runtimeRevision 与 refreshRevision 拼成。
// enabled 为 false 时直接返回空状态，不发起请求。
// 返回值只在 scopedState.scope === requestScope 时透出。
export function usePluginReferenceCatalog(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  enabled: boolean,
  options?: PluginReferenceCatalogOptions,
): PluginReferenceCatalogState {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    options?.preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedPluginReferenceCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  // 身份/隔离语义统一 workspaceKey = workspaceIdentity?.trim() || workspacePath。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options?.preferredRemoteSessionId ?? undefined;
  // remote attachment 也是 authority 边界。同一 workspace/session 切换远端 runtime 时
  // 不得复用旧进程冻结的 catalog Promise。
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${sessionId ?? "draft"}|runtime:${runtimeRevision}|refresh:${options?.refreshRevision ?? 0}`;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  useEffect(() => {
    if (!enabled || !workspacePath || !sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // Runtime restart 后 workspace/session/attachment 都可能保持不变；显式推进代次，
      // 让旧 authority 首帧失效并保证新 runtime 必须重新执行 RPC。
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [enabled, rpcReady, services, sessionId, workspaceKey, workspacePath]);
  // 每次 Picker 重新打开、workspace/session/remote attachment 改变，或 services
  // 实例重连时都创建新的请求身份。渲染只接受同一 scope 的结果，因此 effect 尚未
  // 发出新请求的首帧也不会短暂泄露上一 authority 的 catalog。
  // requestScope 用 useMemo 按依赖重建，依赖变化即换新凭证。
  // 渲染只接受 scope 相同的结果，旧权威数据不被复用。
  // effect 未发出新请求的首帧也不会展示上一 authority 的 catalog。
  // 请求体按 remoteSessionId 等字段存在性拼装，缺省不写。
  // sessionId 与 remoteSessionId 都可缺席，缺席时按草稿或本地处理。
  const requestScope = useMemo(
    () => ({}),
    [enabled, remoteSessionId, requestKey, rpcReady, services, workspacePath],
  );

  useEffect(() => {
    if (!enabled || !workspacePath || !rpcReady) {
      return;
    }
    // requestSeqRef 自增序号标识本次请求，用于丢弃过期返回。
    // cancelled 标记在 effect 清理函数里置位。
    // RPC 失败时只写 error，不回退到其他 authority 的数据。
    // 去重缓存只服务挂载期单飞，不跨 scope 复用 Promise。
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: { entries: [], authority: null, loading: true, error: null },
    });
    const params = {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    let request: Promise<ZCodePluginsReferenceCatalogResult>;
    let requestServiceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>> | undefined;
    if (options?.dedupeSessionRequest && sessionId) {
      let serviceCache = sessionCatalogRequests.get(services);
      if (!serviceCache) {
        serviceCache = new Map();
        sessionCatalogRequests.set(services, serviceCache);
      }
      const cached = serviceCache.get(requestKey);
      request = cached ?? services.pluginManagementService.getPluginReferenceCatalog(params);
      requestServiceCache = serviceCache;
      if (!cached) {
        serviceCache.set(requestKey, request);
        releaseSessionCatalogRequestWhenSettled(services, serviceCache, requestKey, request);
      }
    } else {
      request = services.pluginManagementService.getPluginReferenceCatalog(params);
    }
    request
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: {
            entries: result.plugins,
            authority: result.authority,
            loading: false,
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // fail closed：查询失败时 Picker 显示错误态，不回退到其它 authority 的数据。
        if (!options?.suppressErrorLog) {
          logger.warn("[usePluginReferenceCatalog] 拉取 Plugin 引用 catalog 失败", {
            error: message,
            requestKey,
          });
        }
        setScopedState({
          scope: requestScope,
          value: {
            entries: [],
            authority: null,
            loading: false,
            error: message,
          },
        });
      });
    return () => {
      cancelled = true;
      if (requestServiceCache) {
        releaseSessionCatalogRequest(services, requestServiceCache, requestKey, request);
      }
    };
    // requestKey 已涵盖 workspaceKey 与 sessionId 的组合变化。
  }, [
    enabled,
    options?.dedupeSessionRequest,
    options?.suppressErrorLog,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  if (!enabled || !workspacePath || !rpcReady || scopedState.scope !== requestScope) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
