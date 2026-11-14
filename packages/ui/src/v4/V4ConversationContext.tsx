// INV-01 守住位置：V4ConversationContextValue 的读方法契约。改错故障：在 Provider 内加缓存或重试会让不同 pane 看到不一致的 journal 视图。
// INV-02 守住位置：createContext 的默认值必须是 null。改错故障：给默认对象会掩盖缺 Provider，静态视图误挂取数层并发起无归属请求。
// INV-03 守住位置：useV4Conversation 在 null 时立即抛出。改错故障：静默降级会让无会话宿主带着错误层级继续渲染。
// INV-04 守住位置：useRetainedReadyResolution 只保留 services 引用。改错故障：复制 snapshot 会展示过期会话内容。
// INV-05 守住位置：retain 由 sessionId !== undefined 决定。改错故障：未声明身份的侧面板会在断线后继续调用旧服务。
// INV-06 守住位置：保留槽键由身份优先的 workspace 键、NUL、sessionId 或草稿标记组成。改错故障：只按路径会让同路径不同身份的项目串会话。
// INV-07 守住位置：retained 在渲染期通过条件分支调整。改错故障：搬到 effect 会多渲染一帧旧服务，造成闪断与重复订阅。
// INV-08 守住位置：清理分支仅在 retain 关闭，或非 ready 且 key 变化时触发。改错故障：无条件清空会在短暂断线时丢失仍有效的 services。
// INV-09 守住位置：两个 Provider 都在 ready 之前直接返回 fallback。改错故障：用断连代理建连会订阅失败并污染注册表。
// INV-10 守住位置：一个 bundle 只创建一个 transport 与一个 SessionDataLayer。改错故障：每次渲染重建会丢订阅、丢 snapshot 并泄漏连接。
// INV-11 守住位置：本地媒体转换器只在 remoteSessionId 为 null 时注入。改错故障：远端绝对路径会交给本机 zcode-media，预览全部失效。
// INV-12 守住位置：onRuntimeLifecycle 用可选展开按 transport 能力暴露。改错故障：暴露空实现会让草稿预热误以为存在换代信号。
// INV-13 守住位置：SessionDataLayer 在 bundle 的 effect cleanup 中释放一次。改错故障：不释放泄漏订阅，提前释放让请求落空。
// INV-14 守住位置：pane 数据面从 workspaceConnectionRegistry 租用连接。改错故障：每 pane 新建连接会重复建 runtime 并放大资源。
// INV-15 守住位置：activateRemoteService 只在 useLayoutEffect 中调用。改错故障：渲染期同步更新现有 pane 会触发撕裂与 React 警告。
// INV-16 守住位置：pane 租约在 effect cleanup 中释放，dep 变化时先建新租约再放旧租约。改错故障：先释放会让同 key 的 refCount 落零，关闭 keep-warm。
// INV-17 守住位置：ready 后用解析出的 remoteSessionId 覆盖 pane scope。改错故障：以 __base__ 另建数据层会把终态写进非可见 store。
// INV-18 守住位置：断线横幅读取实时 rpcReady，而不是 retained 的 ready。改错故障：断线时不显示提示，用户会继续对失效连接发请求。
//
// 模块职责：装配 v4 会话的 context、workspace 级 transport 与 SessionDataLayer，并管理 per-pane 连接租约与 services 注入。
// 状态所有权：SessionDataLayer 持有会话内容，workspaceConnectionRegistry 持有连接租约；本文件不缓存业务快照。
// 阅读顺序：先看 context 契约，再看 useRetainedReadyResolution 的保留门禁，最后看两个 Provider 的建连与释放路径。
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  CommandAck,
  CommandEnvelope,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  useWorkspaceServicesResolution,
  type WorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { RemoteConversationAvailability } from "@/v4/RemoteConversationAvailability.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";
import { ConversationTelemetryPaneAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

// 契约层只声明能力，不持有状态：所有读方法都应在实现里直通 transport，不在 Provider 内做缓存或重试。
// layer 是唯一的内容所有者，调用方通过它拿订阅与 snapshot；其余方法都是一次性请求，可重复调用。
// workflow 产物被拆成清单、分页、按块读取三步，是为了冷恢复时按需取字节，不要合并成一次性大对象。
// attachmentPut 是 UI 语义，内部必须走 begin/chunk/commit/abort；调用方不能假设一次 put 只发一个请求。
// onRuntimeLifecycle 声明为可选，缺失表示 transport 不提供存活态信号，调用方必须能接受该能力不存在。
export interface V4ConversationContextValue {
  layer: SessionDataLayer;
  sendCommand(
    envelope: CommandEnvelope,
    context?: { projectId?: string | null },
  ): Promise<CommandAck>;
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /** workflow run 事件日志分页（详情页审计面）；只读、无状态、超时重发安全。 */
  workflowRunEvents(
    params: V4ConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** workflow run 枚举（journal-backed 的重启后发现面）。 */
  workflowRuns(params: V4ConversationWorkflowRunsParams): Promise<V4ConversationWorkflowRunsResult>;
  /**
   * workflow run 的**用户面产物**清单（冷恢复的 durable 读法）。⚠ 术语：artifact = 脚本经
   * `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
   */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** 预置看板的条目分页（cursor = journal sequence）。 */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** 内容产物的字节，一次一块（≤ 512 KiB）；拼接归调用方的 hook。 */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** dwf 脚本 transcript 的清单（files.* / git.* / world.run 行，不带正文）。 */
  workflowRunWorkspace(
    params: V4ConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** 一个工作区节点的有界正文（展开时才取）。 */
  workflowRunNodeResult(
    params: V4ConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  /** UI 高层 put 语义；transport 内部只走 begin/chunk/commit/abort。 */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): ReturnType<ConversationTransport["attachmentRead"]>;
  attachmentReadRange(
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ): ReturnType<ConversationTransport["attachmentReadRange"]>;
  onRuntimeRestart(listener: () => void): () => void;
  /**
   * 承载 transport 暴露 runtime 存活态时才存在（见 ConversationTransport.onRuntimeLifecycle）。
   * unavailable 在 workspace-dispose 当场到达，是草稿预热重建唯一可依赖的换代信号。
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

// 导出 context 本体：静态回放视图用静态 transport 自己
// 装配 value 后直接 Provider 注入，不经 V4ConversationProvider 的 workspace 解析链路。
// context 默认值必须是 null：静态回放视图会自己装配 value 并直接注入，缺 Provider 的场景要能被探测到。
// useHasV4Conversation 只做 null 判定，给回放、静态渲染和转录完成卡决定是否挂取数层。
// 不要改成带默认实现的 context 对象，否则缺 Provider 时不会报错，请求会落到无归属的服务上。
// useV4Conversation 在 null 时立即抛出，这是刻意的硬失败；静默降级会掩盖挂载层级错误。
// 导出 context 本体而不是只导出 hook，是为了让静态 transport 绕过 workspace 解析链路完成注入。
export const V4ConversationContext = createContext<V4ConversationContextValue | null>(null);

export interface V4ConversationProviderProps {
  workspacePath: string;
  workspaceIdentity?: string;
  children: ReactNode;
  /** 显式传入才保留当前会话；未传的侧面板仍在断线时卸载。null 表示草稿。 */
  sessionId?: string | null;
  unavailableFallback?: ReactNode;
  disconnectedBanner?: ReactNode;
}

// 这个 hook 只保留已就绪的 services 引用，不复制 resolution 的 snapshot，避免展示过期会话内容。
// 保留窗口按 workspaceKey 隔离：换项目时旧的 services 必须失效，不能跨项目复用连接与订阅。
// 未声明会话身份的侧面板不会进入保留分支，防止其 debounce 查询在断线后继续调用已释放的服务。
// 返回值只有 ready、保留命中、null 三种；null 由调用方转成 fallback，不能在这里偷偷回落到 base services。
// 必须在渲染期调整 retained：子层挂载前就要拿到正确服务，放到 effect 会晚一帧并造成重复订阅。
function useRetainedReadyResolution(
  workspaceKey: string,
  resolution: WorkspaceServicesResolution,
  retain: boolean,
) {
  const [retained, setRetained] = useState<{
    key: string;
    resolution: WorkspaceServicesResolution;
  } | null>(null);
  // 已挂载的数据层本身就是内容 owner。只保留其服务引用，不复制 snapshot；换项目或首次
  // 挂回前没有 ready 引用，仍由原 rpcReady 门禁阻止远端订阅和本地 fallback。
  // 未声明会话身份的侧面板不留存，避免其 debounce 查询在断线后继续调用旧服务。
  // 第一个分支负责安装：仅当允许保留、rpcReady 且 key 或 services 或 remoteSessionId 变化时才写入。
  // 第二个分支负责清理：retain 关闭，或非 ready 且 workspaceKey 已变，才丢弃旧引用；短暂断线同 key 时仍保留。
  // 这两个条件必须互斥且覆盖所有换代路径，漏掉清理会让旧项目的服务一直留在闭包里。
  // 渲染期 setState 是这里的有意模式：React 会在提交子层前重渲染，从而保证 retained 与本次渲染一致。
  // 比较 services 用引用相等而不是字段比较，服务换新引用就代表连接换代，字段相同也可能绑定不同 runtime。
  if (
    retain &&
    resolution.rpcReady &&
    (retained?.key !== workspaceKey ||
      retained.resolution.services !== resolution.services ||
      retained.resolution.remoteSessionId !== resolution.remoteSessionId)
  ) {
    setRetained({ key: workspaceKey, resolution });
  } else if (retained && (!retain || (!resolution.rpcReady && retained.key !== workspaceKey))) {
    setRetained(null);
  }
  return resolution.rpcReady
    ? resolution
    : retain && retained?.key === workspaceKey
      ? retained.resolution
      : null;
}

// 该组件只在 ready 之后挂载，因此 services 与 remoteSessionId 都可直接使用，内部不再做可用性判断。
// 每个 bundle 对应一个 workspace 的一个 transport 和一个 SessionDataLayer，组件身份变化即整组重建。
// transport 的创建依赖 zcodeAgentService、路径、身份与本地媒体转换器，任一变化都必须重新建连。
// Provider 同时注入 ServiceProvider，保证子树 hook 用的是同一份 services，而不是 shell 当前 workspace 的。
// 此层不渲染横幅，断线提示由外层 RemoteConversationAvailability 统一负责，避免两处状态打架。
function ReadyV4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
  services,
  remoteSessionId,
}: V4ConversationProviderProps & {
  services: IServiceAccessor;
  remoteSessionId: string | null;
}) {
  const { zcodeAgentService } = services;
  const platform = usePlatform();
  // useMemo 内同步建 transport 与 layer，renderer 无 StrictMode，memo 不会双调，不能按双调假设写清理。
  // 本地媒体预览转换器只在 remoteSessionId 为 null 时注入；远端绝对路径必须交给远端媒体服务解析。
  // 曾因把 remoteSessionId 丢弃而把远端路径交给本机 zcode-media，这里用条件展开保持该修复不被回退。
  // value 里每个方法都显式绑定 transport，不能直接展开 transport，否则会暴露未声明的内部字段。
  // onRuntimeLifecycle 用可选展开：transport 不提供时上下文里也没有该键，调用方据此判断能力是否存在。
  const bundle = useMemo(() => {
    const transport = createAgentConversationTransport(zcodeAgentService, {
      workspacePath,
      workspaceIdentity,
      // 主 workspace resolver 已识别远端 endpoint，但这里曾丢弃
      // remoteSessionId，导致远端绝对路径被交给本机 zcode-media。仅本地 endpoint 注入转换器。
      ...(remoteSessionId === null && platform.createLocalMediaPreviewUrl
        ? { createLocalMediaPreviewUrl: platform.createLocalMediaPreviewUrl }
        : {}),
    });
    // SessionDataLayer 是会话内容的唯一 owner，transport 只负责链路；两者生命周期绑定在同一个 bundle。
    // layer 不能在渲染中重建：重建会丢掉已建立的订阅、snapshot 与 pending 状态，表现为列表闪空。
    // value.layer 直接引用这个实例，所有 pane 共享同一份内容视图，不能按组件再包一层缓存。
    // 释放只发生在 bundle 的 effect cleanup，且恰好一次；提前释放会让子组件请求落到已关闭链路。
    const layer = new SessionDataLayer({ transport });
    return {
      layer,
      sendCommand: (envelope: CommandEnvelope, context?: { projectId?: string | null }) =>
        transport.sendCommand(envelope, context),
      fileChanges: (params: V4ConversationFileChangesParams) => transport.fileChanges(params),
      fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
        transport.fileRewindPreview(params),
      workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
        transport.workflowRunEvents(params),
      workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
        transport.workflowRunArtifacts(params),
      workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
        transport.workflowRunArtifactData(params),
      workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
        transport.workflowRunArtifactRead(params),
      workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
        transport.workflowRunWorkspace(params),
      workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
        transport.workflowRunNodeResult(params),
      workflowRuns: (params: V4ConversationWorkflowRunsParams) => transport.workflowRuns(params),
      attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
        transport.attachmentPut(params, options),
      attachmentRead: (params) => transport.attachmentRead(params),
      attachmentReadRange: (params) => transport.attachmentReadRange(params),
      onRuntimeRestart: (listener: () => void) => transport.onRuntimeRestart(listener),
      ...(transport.onRuntimeLifecycle
        ? {
            onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
              transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
          }
        : {}),
    } satisfies V4ConversationContextValue;
  }, [
    platform.createLocalMediaPreviewUrl,
    remoteSessionId,
    workspacePath,
    workspaceIdentity,
    zcodeAgentService,
  ]);

  useEffect(() => {
    return () => {
      bundle.layer.dispose();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <V4ConversationContext.Provider value={bundle}>{children}</V4ConversationContext.Provider>
    </ServiceProvider>
  );
}

/** 每个 workspace 一条 host 连接 + 一个 SessionDataLayer。 */
// 外层 Provider 负责解析 services 与保留门禁，ready 之前直接返回 fallback，绝不创建 transport。
// key 由身份优先的 workspace 键、NUL 分隔符、sessionId 或草稿标记组成，保证不同会话不共享保留槽。
// retain 由 sessionId !== undefined 决定：显式声明会话的宿主才允许在断线时保留当前数据层。
// RemoteConversationAvailability 使用实时的 resolution.rpcReady，而不是 retained 的 ready，横幅才反映当下断线。
// ready 后把解析出的 remoteSessionId 传给内层，避免内外层对远端身份判断不一致。
export function V4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
  sessionId,
  unavailableFallback,
  disconnectedBanner,
}: V4ConversationProviderProps) {
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const ready = useRetainedReadyResolution(
    `${workspaceIdentity?.trim() || workspacePath}\0${sessionId ?? "__draft__"}`,
    resolution,
    sessionId !== undefined,
  );
  if (!ready) {
    return unavailableFallback ?? null;
  }

  return (
    <ReadyV4ConversationProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      services={ready.services}
      remoteSessionId={ready.remoteSessionId}
    >
      <RemoteConversationAvailability available={resolution.rpcReady} banner={disconnectedBanner}>
      {children}
      </RemoteConversationAvailability>
    </ReadyV4ConversationProvider>
  );
}

export function useV4Conversation(): V4ConversationContextValue {
  const ctx = useContext(V4ConversationContext);
  if (!ctx) {
    throw new Error("useV4Conversation 必须在 V4ConversationProvider 内使用");
  }
  return ctx;
}

/**
 * 有没有会话上下文可用。给那些**可以**在没有会话的宿主里渲染的组件（静态渲染、回放、
 * 转录里的完成卡）决定要不要挂上取数的那一层——挂了就得有上下文，没有就画冷态。
 */
export function useHasV4Conversation(): boolean {
  return useContext(V4ConversationContext) !== null;
}

export interface V4PaneConversationProviderProps {
  /** pane 绑定的 primary workspace（连接路由键，docs/v4-split-pane-workbench.md）。 */
  scope: PaneWorkspaceScope;
  children: ReactNode;
  /** 显式传入才保留当前会话；未传的侧面板仍在断线时卸载。null 表示草稿。 */
  sessionId?: string | null;
  unavailableFallback?: ReactNode;
  disconnectedBanner?: ReactNode;
}

/**
 * per-pane 数据面：连接从 workspaceConnectionRegistry 租用
 * （同 endpoint+workspaceKey 的 pane 共享一条 transport + SessionDataLayer，
 * refCount + 30s keep-warm），并把 pane 自己的 services 注入子树——附件上传、
 * sessions-index 守卫等 hook 用 pane 的 accessor，不误用 shell 当前 workspace 的。
 *
 * 远程目标在 session store 尚未注册真实 services 时保持 remote-waiting，不挂载子数据层，
 * 因而不会拿断连代理创建连接或发起订阅；同时绝不回落 base services，也不为 pane
 * 另起独立 runtime（远控保护约束）。重连 ready 后 services 换新引用 → 注册表保持
 * 原 layer/transport 身份，并在 commit 阶段单向激活最新 proxy。
 */
// pane 数据面从 workspaceConnectionRegistry 租用连接，同 endpoint 与 workspaceKey 的 pane 共享 transport 与 layer。
// 远端目标在 session store 未注册真实 services 时保持 remote-waiting，不挂子数据层，也不回落到 base services。
// 重连后 services 换新引用时，注册表保持原 layer 与 transport 身份，只在 commit 阶段单向激活最新 proxy。
// scope 会在 ready 后用解析出的 remoteSessionId 覆盖，防止以 __base__ 另建数据层而把终态写进非可见 store。
export function V4PaneConversationProvider({
  scope,
  children,
  sessionId,
  unavailableFallback,
  disconnectedBanner,
}: V4PaneConversationProviderProps) {
  const targetResolution = useWorkspaceServicesResolution(
    scope.workspacePath,
    scope.remoteSessionId ?? null,
    scope.workspaceIdentity ?? null,
  );
  const ready = useRetainedReadyResolution(
    `${scope.workspaceIdentity?.trim() || scope.workspacePath}\0${sessionId ?? "__draft__"}`,
    targetResolution,
    sessionId !== undefined,
  );
  const resolvedScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(ready?.remoteSessionId ? { remoteSessionId: ready.remoteSessionId } : {}),
    }),
    [scope.workspaceIdentity, scope.workspacePath, ready?.remoteSessionId],
  );
  if (!ready) {
    return unavailableFallback ?? null;
  }

  // 恢复中的远端 pane 可能只有 workspaceIdentity。resolver 已解析出真实
  // remoteSessionId 后若仍把原 scope 传给 registry，会以 __base__ 和远端 endpoint
  // 各建一份数据层，终态可能落到非可见 store。ready 后统一使用解析后的 scope。
  return (
    <ReadyV4PaneConversationProvider scope={resolvedScope} services={ready.services}>
      <RemoteConversationAvailability
        available={targetResolution.rpcReady}
        banner={disconnectedBanner}
      >
      {children}
      </RemoteConversationAvailability>
    </ReadyV4PaneConversationProvider>
  );
}

function ReadyV4PaneConversationProvider({
  scope,
  services,
  children,
}: Pick<V4PaneConversationProviderProps, "scope" | "children"> & {
  services: IServiceAccessor;
}) {
  const agentService = services.zcodeAgentService;
  const platform = usePlatform();

  // 与 V4ConversationProvider 相同的 useMemo 同步建连模式（renderer 无 StrictMode，
  // memo 双调不存在）；dep 变化时先建新租约再在 effect cleanup 释放旧租约——
  // 同 key 时 refCount 不落零，keep-warm 兜住跨 key 抖动。
  const bundle = useMemo(() => {
    const lease = acquireWorkspaceConnection(
      {
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
      },
      agentService,
      scope.remoteSessionId ? undefined : platform.createLocalMediaPreviewUrl,
    );
    return {
      lease,
      value: {
        layer: lease.layer,
        sendCommand: (envelope: CommandEnvelope, context?: { projectId?: string | null }) =>
          lease.transport.sendCommand(envelope, context),
        fileChanges: (params: V4ConversationFileChangesParams) =>
          lease.transport.fileChanges(params),
        fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
          lease.transport.fileRewindPreview(params),
        workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
          lease.transport.workflowRunEvents(params),
        workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
          lease.transport.workflowRunArtifacts(params),
        workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
          lease.transport.workflowRunArtifactData(params),
        workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
          lease.transport.workflowRunArtifactRead(params),
        workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
          lease.transport.workflowRunWorkspace(params),
        workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
          lease.transport.workflowRunNodeResult(params),
        workflowRuns: (params: V4ConversationWorkflowRunsParams) =>
          lease.transport.workflowRuns(params),
        attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
          lease.transport.attachmentPut(params, options),
        attachmentRead: (params) => lease.transport.attachmentRead(params),
        attachmentReadRange: (params) => lease.transport.attachmentReadRange(params),
        onRuntimeRestart: (listener: () => void) => lease.transport.onRuntimeRestart(listener),
        ...(lease.transport.onRuntimeLifecycle
          ? {
              onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
                lease.transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
            }
          : {}),
      } satisfies V4ConversationContextValue,
    };
  }, [
    agentService,
    platform.createLocalMediaPreviewUrl,
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.remoteSessionId,
  ]);

  useLayoutEffect(() => {
    // acquire 发生在 render，只负责稳定租约；远端 proxy 换代引发的 store 更新和
    // 重订阅必须等到 commit，避免在渲染阶段同步更新现有 pane。
    bundle.lease.activateRemoteService();
  }, [bundle]);

  useEffect(() => {
    return () => {
      bundle.lease.release();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <ConversationTelemetryPaneAttachment services={services} scope={scope}>
        <V4ConversationContext.Provider value={bundle.value}>
          {children}
        </V4ConversationContext.Provider>
      </ConversationTelemetryPaneAttachment>
    </ServiceProvider>
  );
}
