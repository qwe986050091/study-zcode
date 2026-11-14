// 职责：bot 项目运行时的端口契约——连接句柄、连接注册表与远端目标路由。
// 边界：只路由已存在的 workspace/session/Agent，不创建也不拥有它们。
// INV：连接由 router 之外的所有者创建与关闭；本层只读句柄、只发信号，绝不 dispose。
// 改错后果：越界关闭连接会打断同 workspace 的其他订阅者，表现为远端任务静默失联。
import type { IZCodeTaskService } from "#src/index.js";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import type {
  IZCodeAgentService,
  ZCodeAgentAppRuntimePreferences,
} from "#src/zcode-agent/zcodeAgent.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
export type { IZCodeTaskService, ZCodeAgentAppRuntimePreferences };
// workspaceIdentity 是路由与去重键（可不同于路径），workspacePath 只用于本地文件操作。
// hostId 缺省表示本地连接；远端必须带 hostId，否则会错误命中本地同名 workspace。
export type BotRemoteTarget = { workspacePath: string; workspaceIdentity: string; hostId?: string };
// 订阅必须可释放：连接表变化是长期事件源，泄漏会让旧监听器持续响应过期快照。
export type BotRuntimeSubscription = { dispose(): void };
export interface BotProjectConnection {
  /** 物理连接的代际标识；router 不拥有或关闭该连接。 */
  owner: object;
  taskService: IZCodeTaskService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  agentService: Pick<IZCodeAgentService, "syncAppRuntimePreferences">;
  bindWorkspace(target: BotRemoteTarget): Promise<void>;
}
// 端口把“读绑定目标”与“解析在线连接”解耦：前者是持久化事实，后者是瞬时状态。
// 实现需保证 onConnectionsChanged 不丢事件，且 resolveOnline 不因连接切换返回陈旧句柄。
export interface BotProjectRuntimePort {
  remoteProjectService: Pick<IRemoteProjectService, "readDirectory" | "connectHost">;
  resolveOnline(hostId: string): BotProjectConnection | undefined;
  onConnectionsChanged(listener: () => void): BotRuntimeSubscription;
  readBoundTargets(): Promise<readonly BotRemoteTarget[]>;
  readRuntimePreferences(): Promise<ZCodeAgentAppRuntimePreferences>;
  warn(message: string): void;
}
/** 只路由现有 Source；不创建 workspace/session/Agent，不拥有 accepted queue。 */
export interface BotRemoteRuntimeService {
  isConnected(target: BotRemoteTarget): Promise<boolean>;
  ensureConnected(target: BotRemoteTarget): Promise<{ ok: boolean; message?: string }>;
  getZCodeTaskService(target: BotRemoteTarget): Promise<IZCodeTaskService | null>;
  getModelSelectionService(
    target: BotRemoteTarget,
  ): Promise<Pick<IModelSelectionService, "getView"> | null>;
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
}
