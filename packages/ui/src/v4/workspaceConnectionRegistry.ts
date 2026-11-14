// INV-01 键由端点与工作区拼成：守住位置 键构造；改错故障 同工作区不同端点复用到同一条连接。
// INV-02 工作区身份优先于路径：守住位置 归一函数；改错故障 改签名后生成两条连接。
// INV-03 本机端点用保留键：守住位置 空值合并；改错故障 远程与本地键撞车。
// INV-04 命中条目先清预热定时器：守住位置 复用分支；改错故障 定时器把活跃连接清掉。
// INV-05 远程条目跨换代复用：守住位置 复用条件；改错故障 每次换代重建连接丢订阅。
// INV-06 本地条目换代则标记失效：守住位置 分支判断；改错故障 旧服务继续被调用。
// INV-07 失效条目无人持有即清场：守住位置 引用判断；改错故障 泄漏整条连接与订阅。
// INV-08 失效条目末位释放即清场：守住位置 释放路径；改错故障 预热窗口让失效连接常驻。
// INV-09 归零后延迟释放：守住位置 定时器设置；改错故障 布局抖动期间反复建连退订。
// INV-10 预热到期先核验仍在注册表：守住位置 身份比较；改错故障 新条目被旧定时器误删。
// INV-11 释放幂等：守住位置 关闭标记；改错故障 重复释放把计数减成负值。
// INV-12 远程租约延迟激活新服务：守住位置 提交阶段；改错故障 渲染期发起远程调用。
// INV-13 激活前校验租约未被释放：守住位置 早退条件；改错故障 已关面板仍替换连接。
// INV-14 代际只向新切换：守住位置 大小比较；改错故障 旧服务覆盖新代。
// INV-15 远程条目必须带可换代连接：守住位置 空值断言；改错故障 换代时静默失效。
// INV-16 媒体地址工厂按需下传：守住位置 展开参数；改错故障 远程条目缺少本地预览。
// INV-17 生命周期日志带统一模块名：守住位置 日志字段；改错故障 无法按模块检索连接事件。
// INV-18 对外只暴露租约与诊断计数：守住位置 导出清单；改错故障 调用方可直接改注册表。
//
// 模块职责：按端点与工作区共享 conversation 连接的引用计数注册表。
// 状态所有权：条目与预热定时器归模块级映射，租约归各面板。
// 阅读顺序：先看键构造，再看获取与换代，最后看释放与预热。
// 按 endpoint + workspaceKey 复用的 conversation 连接注册表（引用计数 + keep-warm）
// ——分屏多 pane 跨 workspace 的连接层。
// 同一 endpoint 同一 workspace 的多个 pane 共享一条 transport + 一个 SessionDataLayer
// （同 session 多 pane 由 layer 内 per-topic refCount 单订阅收口，不触发 CLI
// (connectionId, topic) 重订阅替换）。与 sessionsIndexRegistry 同构，多两点：
// - 30s keep-warm：refCount 归零不立即 dispose（防 pane 关/开、布局调整抖动）；
// - agentService 换代：远程条目保持 layer/transport 身份并单向切换最新 proxy；
//   本地 __base__ 用新 service 重建条目。
import type { IZCodeAgentService } from "@zcode/services";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { ReplaceableConversationTransport } from "@/v4/replaceableConversationTransport.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";

/** 注册表需要的 agentService 窄面（= conversation transport 的依赖面，便于测试注入）。 */
export type WorkspaceConnectionAgentService = Pick<
  IZCodeAgentService,
  | "helloConversationV4"
  | "initializeConversationV4"
  | "subscribeConversationV4"
  | "resyncConversationV4"
  | "unsubscribeConversationV4"
  | "sendConversationCommandV4"
  | "queryConversationCommandsV4"
  | "conversationRowsRangeV4"
  | "conversationPlansV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
  | "conversationWorkflowRunWorkspaceV4"
  | "conversationWorkflowRunNodeResultV4"
  | "conversationFileChangesV4"
  | "conversationFileRewindPreviewV4"
  | "attachmentBeginV4"
  | "attachmentChunkV4"
  | "attachmentCommitV4"
  | "attachmentAbortV4"
  | "attachmentPreviewSourceV4"
  | "attachmentReadV4"
  | "onDynamicConversationFrame"
  | "onDynamicLocalTtftFacts"
  | "onAgentRuntimeRestarted"
>;

export interface WorkspaceConnectionScope {
  /** = pane 绑定的 primary workspace（连接路由键）。 */
  workspacePath: string;
  workspaceIdentity?: string;
  /** endpoint 维度：remote shard 的 remoteSessionId；缺省 = 本机 __base__。 */
  remoteSessionId?: string;
}

/** pane 持有的连接租约；release 幂等。 */
/**
 * useSavedWorkflowLauncher 的推断返回类型包含 lease，声明生成要求保留可命名的导出。
 * @lintignore
 */
export interface WorkspaceConnectionLease {
  readonly layer: SessionDataLayer;
  readonly transport: ConversationTransport;
  /** React commit 后激活本租约携带的远程 service；本地租约为 no-op。 */
  activateRemoteService(): void;
  release(): void;
}

interface RegistryEntry {
  key: string;
  agentService: WorkspaceConnectionAgentService;
  agentServiceGeneration: number;
  transport: ConversationTransport;
  replaceableTransport: ReplaceableConversationTransport | null;
  layer: SessionDataLayer;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
  /** 本地 service 换代后被移出注册表的旧条目：末位 lease release 时立即 dispose。 */
  stale: boolean;
}

const registry = new Map<string, RegistryEntry>();

/** 本机 endpoint 的保留键（与 sessionsIndexRegistry / task list shardKey 口径一致）。 */
export const LOCAL_WORKSPACE_CONNECTION_ENDPOINT = "__base__";

/** 引用归零后延迟释放窗口（ms）；与 SessionDataLayer keep-warm 同标度。 */
export const WORKSPACE_CONNECTION_KEEP_WARM_MS = 30_000;

/** 注册表条目键 = endpoint + workspaceKey（同 workspaceKey 不同 endpoint 不共用）。 */
// buildWorkspaceConnectionKey 优先取 scope.workspaceIdentity，缺失时才回退 scope.workspacePath。
// 本机端点用 LOCAL_WORKSPACE_CONNECTION_ENDPOINT（"__base__"）占位，scope.remoteSessionId 缺省即视为本机。
// 条目键由端点和 workspaceKey 以空格拼接，同 workspaceKey 不同 endpoint 不共用条目。
// workspaceIdentity 走 trim 归一，workspacePath 原样拼接，由调用方保证路径已归一。
export function buildWorkspaceConnectionKey(scope: WorkspaceConnectionScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return `${scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT} ${workspaceKey}`;
}

function disposeEntry(entry: RegistryEntry): void {
  if (entry.keepWarmTimer !== null) {
    clearTimeout(entry.keepWarmTimer);
    entry.keepWarmTimer = null;
  }
  entry.layer.dispose();
}

function releaseEntry(entry: RegistryEntry): void {
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    logger.lifecycle.info("v4 workspace connection lease released", {
      event: "v4.workspace_connection.release",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      status: "completed",
    });
    return;
  }
  if (entry.stale) {
    // 已被换代移出注册表：没有新消费者会再命中它，立即清场。
    disposeEntry(entry);
    logger.lifecycle.info("v4 stale workspace connection disposed", {
      event: "v4.workspace_connection.stale_disposed",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
    return;
  }
  // 关 pane ≠ 停 session：延迟退订，防布局抖动期间反复建连/退订。
  entry.keepWarmTimer = setTimeout(() => {
    if (registry.get(entry.key) === entry) {
      registry.delete(entry.key);
    }
    entry.layer.dispose();
    logger.lifecycle.info("v4 workspace connection keep-warm expired", {
      event: "v4.workspace_connection.keep_warm_expired",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
  }, WORKSPACE_CONNECTION_KEEP_WARM_MS);
  logger.lifecycle.info("v4 workspace connection lease released", {
    event: "v4.workspace_connection.release",
    keepWarmMs: WORKSPACE_CONNECTION_KEEP_WARM_MS,
    key: entry.key,
    module: "ui.v4.workspace_connection_registry",
    refCount: 0,
    status: "keep_warm",
  });
}

/**
 * 取/建某 endpoint+workspace 的共享 conversation 连接，refCount++。
 * agentService 由调用方（V4PaneConversationProvider 经 useWorkspaceServicesResolution）解析；
 * 调用方只在 local-ready / remote-ready 时进入本层。remote-waiting 不会拿断连代理
 * 创建 registry entry，同时仍禁止回落 base services 或为 pane 另起独立 runtime。
 */
// acquireWorkspaceConnection 命中同 agentService 或远程条目时只 refCount += 1，并清掉 keepWarmTimer。
// isRemote 为真时跨 service 换代继续复用同一条目，只有本地 __base__ 换代才失效。
// 本地换代把旧条目置 stale 并从 registry 移出，未清场的部分交给其末位 release 处理。
// 旧条目 refCount <= 0 时立即 disposeEntry，仍被持有则等最后一次 release 清场。
// 租约 release 以 released 标志保证幂等，重复调用不再扣减 refCount。
export function acquireWorkspaceConnection(
  scope: WorkspaceConnectionScope,
  agentService: WorkspaceConnectionAgentService,
  createLocalMediaPreviewUrl?: (path: string) => string,
): WorkspaceConnectionLease {
  const key = buildWorkspaceConnectionKey(scope);
  const existing = registry.get(key);
  const incomingServiceGeneration = remoteAgentServiceGeneration(agentService);
  const isRemote =
    (scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT) !==
    LOCAL_WORKSPACE_CONNECTION_ENDPOINT;
  let entry: RegistryEntry;
  if (existing && (existing.agentService === agentService || isRemote)) {
    existing.refCount += 1;
    if (existing.keepWarmTimer !== null) {
      clearTimeout(existing.keepWarmTimer);
      existing.keepWarmTimer = null;
    }
    entry = existing;
    logger.lifecycle.info("v4 workspace connection reused", {
      event: "v4.workspace_connection.reused",
      isRemote,
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      serviceGeneration: incomingServiceGeneration,
      status: "completed",
    });
  } else {
    if (existing) {
      // 本地 __base__ service 换代：旧条目失效移出；
      // 无人持有则立即清场，有人持有则由其末位 release 清场。
      registry.delete(key);
      existing.stale = true;
      if (existing.refCount <= 0) {
        disposeEntry(existing);
      }
    }
    const initialTransport = createAgentConversationTransport(agentService, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(createLocalMediaPreviewUrl ? { createLocalMediaPreviewUrl } : {}),
    });
    const replaceableTransport = isRemote
      ? new ReplaceableConversationTransport(initialTransport)
      : null;
    const transport = replaceableTransport ?? initialTransport;
    entry = {
      key,
      agentService,
      agentServiceGeneration: incomingServiceGeneration,
      transport,
      replaceableTransport,
      layer: new SessionDataLayer({ transport }),
      refCount: 1,
      keepWarmTimer: null,
      stale: false,
    };
    registry.set(key, entry);
    logger.lifecycle.info("v4 workspace connection created", {
      event: "v4.workspace_connection.created",
      isRemote,
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 1,
      serviceGeneration: incomingServiceGeneration,
      status: "completed",
    });
  }

  let released = false;
  return {
    layer: entry.layer,
    transport: entry.transport,
    activateRemoteService: () => {
      if (
        released ||
        !isRemote ||
        entry.stale ||
        entry.agentService === agentService ||
        incomingServiceGeneration <= entry.agentServiceGeneration
      ) {
        return;
      }
      // acquire 会在 React render 中执行；若此处同步 replace，会经
      // runtimeRestart listener 更新外部 store 并发起 RPC。租约只捕获候选 service，
      // 由 Provider 在 commit 阶段显式激活，同时保持 generation 单向切换。
      if (!entry.replaceableTransport) {
        throw new Error("远程 conversation registry 条目缺少可换代 transport");
      }
      entry.agentService = agentService;
      entry.agentServiceGeneration = incomingServiceGeneration;
      entry.replaceableTransport.replace(
        createAgentConversationTransport(agentService, {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        }),
      );
    },
    release: () => {
      if (released) return;
      released = true;
      releaseEntry(entry);
    },
  };
}

/** 仅测试/诊断用：当前注册的连接条目数（不含已换代失效、待存量租约释放的旧条目）。 */
// workspaceConnectionRegistrySize 直接返回 registry.size，即当前仍登记的条目数。
// 已 stale、等待存量租约释放的旧条目已移出 registry，不计入该数值。
// 该函数仅供测试与诊断使用，业务代码不应依赖其读数。
export function workspaceConnectionRegistrySize(): number {
  return registry.size;
}
