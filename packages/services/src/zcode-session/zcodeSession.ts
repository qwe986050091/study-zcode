// 会话门面的公共契约：外部只依赖这里，具体 runtime 分派由实现方按 workspaceKey 完成。
// INV-01：带工作区语义的入参必须携带 workspacePath，identity 可缺省但不可编造（守住位置：ZCodeSessionWorkspaceTarget）。
// INV-02：expectedRevision 是乐观并发令牌，缺席表示「不校验」，绝不等于「校验为 0」（守住位置：三个 Set* 参数）。
// INV-03：sessionId 预分配只服务导入事务，普通会话必须由 Agent 分配（守住位置：ZCodeSessionCreateParams.sessionId）。
// INV-04：broadcastSnapshot=false 只用于续聊预恢复，防止旧终态快照覆盖本地新输入（守住位置：ResumeParams）。
// 破坏 INV-01 会让远端会话被当成新工作区；破坏 INV-02 会静默覆盖他人的模型改动；
// 破坏 INV-03 会让两条创建路径撞 ID；破坏 INV-04 会让 UI 在用户输入后退回旧状态。
// 本文件只有类型与频道绑定，任何行为改动都应落到实现方，而不是在这里加字段兜底。
import { ServiceChannels } from "@zcode/shared";
import type {
  TraceId,
  ZCodeAgentMcpServer,
  ZCodeDeliveryKind,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodePermissionRequestParams,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
  ZCodeSessionInfo,
  ZCodeSessionImportHistory,
  ZCodeSessionEvent,
  ZCodeSessionMode,
  ZCodeSessionPersistence,
  ZCodeSessionStateSnapshot,
  ZCodeStateUpdatedNotification,
  ZCodeWorkspacePresentation,
} from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type { ProviderRuntimeHeadersUiResponse } from "#src/zcode-agent/zcodeAgent.js";

// [权衡] workspacePath 必填、identity 选填：路径是文件、命令 cwd 与 Git 的落点，
// 任何调用都必须有；identity 只用于身份隔离，纯本地场景允许省略，
// 由下层按 hostId + 路径派生，不允许在这里手写格式。
export interface ZCodeSessionWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type ZCodeSessionReadWorkspacePresentationParams = ZCodeSessionWorkspaceTarget;

export interface ZCodeTaskTarget extends ZCodeSessionWorkspaceTarget {
  sessionId: string;
}

// 创建即可能拉起 runtime 进程：persistence 与 mcpServers 决定进程启动后的存储位置与
// 工具面，创建后再改需要重启会话，因此必须在首次创建时给全。
export interface ZCodeSessionCreateParams extends ZCodeSessionWorkspaceTarget {
  /** 仅导入事务使用的预分配 ID；普通新会话继续由 Agent 分配。 */
  sessionId?: string;
// sessionTraceId 由上层透传，用于把创建动作关联到发起它的那次请求；
// 缺失时由 runtime 自建，调用方不得依赖其具体值。
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZCodeSessionMode;
  model?: ModelSelection;
  persistence?: ZCodeSessionPersistence;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  importedHistory?: ZCodeSessionImportHistory;
}

export interface ZCodeSessionResumeParams extends ZCodeTaskTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  /**
   * 默认广播 resume 得到的历史快照，并让 shadow 订阅请求初始 snapshot。
   * 续聊发送前的 runtime 预恢复会关闭它，避免旧终态快照覆盖本地已开始的新输入运行态。
   */
  broadcastSnapshot?: boolean;
}

export interface ZCodeSessionListParams extends ZCodeSessionWorkspaceTarget {
  limit?: number;
}

// [权衡] 读取用 afterSeq + messageLimit 做增量游标而不是返回全量：会话事件可达上万条，
// 全量返回会撑爆 RPC 帧并拖慢首屏。
export interface ZCodeSessionReadParams extends ZCodeTaskTarget {
  deliveryKind?: ZCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
}

export interface ZCodeSessionMessagesParams extends ZCodeTaskTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZCodeSessionEventsParams extends ZCodeTaskTarget {
  afterSeq?: number;
  limit?: number;
}

// [并发] 三个 Set* 都接受 expectedRevision：UI 与服务端各自持有快照，revision 不符即拒绝，
// 避免后到的旧意图覆盖新状态（INV-02）。
// persistAsWorkspaceLastUsed 表示这次选择同时写回工作区默认值，而不只改当前会话。
export interface ZCodeSessionSetModelParams extends ZCodeTaskTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeSessionSetThoughtLevelParams extends ZCodeTaskTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeSessionSetModeParams extends ZCodeTaskTarget {
  mode: ZCodeSessionMode;
  expectedRevision?: number;
}

export interface ZCodeSessionRespondProviderRuntimeHeadersParams extends ZCodeTaskTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

// 订阅是长驻通道：includeSnapshot 决定是否先补一帧全量，afterSeq 决定从哪个序号续传，
// 两者共同保证重连后既不重复也不丢事件。
export interface ZCodeSessionSubscribeParams extends ZCodeTaskTarget {
  deliveryKind: ZCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
// [权衡] 只有后台会话允许合并事件：mode 固定为 background-summary，intervalMs 为合并窗口；
// 前台会话不传该字段，保证每帧按原序到达。
// 合并后消费者拿到的是摘要而非单条事件，因此不能用于需要逐条回放的场景。
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// [并发] 事件流混合四类语义：会话数据、权限请求、用户输入与状态快照。
// 权限/输入请求必须即时转发、不得合并；snapshot 只在订阅起始或恢复时出现，
// 消费者看到它应重置本地状态而不是继续叠加。
export type ZCodeSessionServiceEvent =
  | { type: "session.event"; event: ZCodeSessionEvent }
  | { type: "state.updated"; notification: ZCodeStateUpdatedNotification }
  | { type: "permission.request"; request: ZCodePermissionRequestParams }
  | { type: "userInput.request"; request: ZCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: ZCodeUserInputResponse;
    }
  | { type: "providerRuntimeHeaders.request"; request: ZCodeProviderRuntimeHeadersRequestParams }
  | { type: "snapshot"; snapshot: ZCodeSessionStateSnapshot };

// [失败路径] initialize 不抛错，用 available + reasonCode 表达不可用：
// provider_not_ready 属于正常状态，调用方据此禁用入口而不是无限重试。
export interface ZCodeSessionInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

// [并发] generation 每次进程重启递增、identity 标识进程实例：调用方缓存 runtime 句柄时
// 必须两者同时比对，只看 identity 会把已退出的进程当成活的。
export interface ZCodeSessionWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

// 方法分四组：工作区生命周期（initialize / getWorkspaceRuntimeIdentity）、
// 会话生命周期（create / resume / list / read / close）、状态写入（Set*）、
// 交互回流（respondProviderRuntimeHeaders）。
export interface IZCodeSessionService {
  initializeWorkspace(params: ZCodeSessionWorkspaceTarget): Promise<ZCodeSessionInitializeResult>;
  getWorkspaceRuntimeIdentity(
    params: ZCodeSessionWorkspaceTarget,
  ): Promise<ZCodeSessionWorkspaceRuntimeIdentity>;
  readWorkspacePresentation(
    params: ZCodeSessionReadWorkspacePresentationParams,
  ): Promise<ZCodeWorkspacePresentation>;
  createSession(params: ZCodeSessionCreateParams): Promise<ZCodeSessionStateSnapshot>;
  resumeSession(params: ZCodeSessionResumeParams): Promise<ZCodeSessionStateSnapshot>;
  listSessions(params: ZCodeSessionListParams): Promise<ZCodeSessionInfo[]>;
  readSession(params: ZCodeSessionReadParams): Promise<ZCodeSessionStateSnapshot>;
  readSessionMessages(params: ZCodeSessionMessagesParams): Promise<ZCodeMessageWithParts[]>;
  readSessionEvents(params: ZCodeSessionEventsParams): Promise<ZCodeSessionEvent[]>;
// [事务] 草稿会话先以 deferred 形式存在，promote 才真正落库；
// closeDeferredDraftSession 返回 boolean，表示是否确有草稿被关闭，
// 供上层决定要不要回滚已创建的 workspace 绑定。
  promoteDeferredDraftSession(params: ZCodeTaskTarget): Promise<void>;
  closeSession(params: ZCodeTaskTarget): Promise<void>;
  closeDeferredDraftSession(params: ZCodeTaskTarget): Promise<boolean>;
  setModel(params: ZCodeSessionSetModelParams): Promise<ZCodeSessionStateSnapshot>;
  setThoughtLevel(params: ZCodeSessionSetThoughtLevelParams): Promise<ZCodeSessionStateSnapshot>;
  setMode(params: ZCodeSessionSetModeParams): Promise<ZCodeSessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: ZCodeSessionRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  // M5 删波次 2：onDynamicSessionEvent（旧 session/subscribe 词表的 renderer 订阅面）
  // 已删除——v4 UI 走 agentService 的 conversation/sessions-index 帧通道，
  // 该方法在 renderer 侧已无任何调用者（grep packages/ui packages/desktop 为零）。
}

export const IZCodeSessionService = createServiceDescriptor<IZCodeSessionService>(
  ServiceChannels.ZCodeSession,
);
