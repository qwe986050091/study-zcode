/**
 * ============================================================================
 * runtime/methods/config.ts —— runtime 配置面与会话级 getter/setter
 * ============================================================================
 *
 * 两类内容：
 *   1) 纯内存配置读写（mode / planEnabled / language / outputStyle / cwd / 模型选择），
 *      写配置本身不落库；执行态的持久化由 execution-state 统一提交，避免双写路径。
 *   2) 外部子 runtime 的三条接缝：共享 event store、事件只通知不 append、派生交互端口。
 * 口径：workspaceIdentity（workspaceRoot）管身份，workingDirectory 只管执行 cwd（#19）；
 *       工具缓存是"注册表快照 + model 相关投影"，失效必须显式 invalidateToolCache。
 * ============================================================================
 */
import { resolveToolSearchMode } from "../../tool/search/exposure.js";
import type {
  CollaborationMode,
  ExecutionShellSelection,
  Model,
  ModelSelection,
  ModelToolContract,
  PermissionBrokerRequest,
  ProjectId,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  TraceContext,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
} from "../deps.js";
import { isInspectablePermissionBroker, projectIdFromDirectory } from "../helpers/index.js";
import {
  deriveChildClientPorts,
  type ChildClientPortsContext,
  type ClientFacingPorts,
} from "../helpers/child-client-ports.js";
import type { AgentRuntimeConfig, ActiveTurnInfo } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

import { mirrorSubagentInteractionEvent } from "../../subagent/tool-event-mirror.js";
import { orderProviderVisibleToolContracts } from "../../tool/provider-visible-order.js";
import { projectToolModelContract } from "../../tool/model-contract.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { filterEmbeddedSearchRuntimeVisibleTools } from "./embedded-search-branch.js";
import {
  getSessionShellSelection as readSessionShellSelection,
  initializeSessionShellEnvironmentIfNeeded as initializeSessionShellEnvironment,
  type SessionShellEnvironmentCandidate,
} from "./session-shell-environment.js";

export async function setExecutionState(
  this: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean },
  traceContext?: TraceContext,
): Promise<void> {
  // 命令入口复用 execution-state：那里保证"先持久化、再改内存、最后发事件"，这里不重写一遍。
  await applyRuntimeExecutionState(this, input, { source: "command", traceContext });
}

export function updateConfig(
  this: AgentRuntimeInternal,
  patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
): void {
  if (patch.mode !== undefined || patch.planEnabled !== undefined) {
    const previous = resolveExecutionState(this.config);
    // patch 是增量而不是全量：缺省字段沿用 previous，避免"只改 mode 却把 planEnabled 清空"。
    const next = resolveExecutionState(patch, previous);
    Object.assign(this.config, next);
    // 只有 planEnabled 翻转才置提醒位；下一轮注入"当前约束"后由下游清除。
    if (previous.planEnabled !== next.planEnabled)
      this.needsPlanModeExitReminder = !next.planEnabled;
  }
  if (patch.language !== undefined) {
    this.config.language = patch.language;
    // 有 active turn 时不重建前缀：system prompt 已随请求发出，中途改写会造成同轮口径分裂。
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
  if ("outputStyle" in patch) {
    // 用 in 而不是 !== undefined：显式清空（undefined）也是一次有效变更。
    this.config.outputStyle = patch.outputStyle;
    // 同上，只在没有进行中的 turn 时才允许重构上下文前缀。
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
}

export function initializeSessionShellEnvironmentIfNeeded(
  this: AgentRuntimeInternal,
  selection: SessionShellEnvironmentCandidate,
): boolean {
  return initializeSessionShellEnvironment(this, selection);
}

export function getSessionShellSelection(
  this: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return readSessionShellSelection(this);
}

export function getMode(this: AgentRuntimeInternal): CollaborationMode {
  // 未显式设置时按 build 处理：这是唯一允许写入工作区的默认协作模式。
  return this.config.mode ?? "build";
}

export function getPlanEnabled(this: AgentRuntimeInternal): boolean {
  // planEnabled 可能只存在于 session entry 恢复出的 config，必须走 resolve 归一到布尔。
  return resolveExecutionState(this.config).planEnabled;
}

export function getSessionModelSelection(this: AgentRuntimeInternal): ModelSelection | undefined {
  // 返回克隆：调用方修改返回值不得影响 runtime 内部选择（否则并发请求会串模型）。
  return this.sessionModelSelection && cloneModelSelection(this.sessionModelSelection);
}

export function setSessionModelSelection(
  this: AgentRuntimeInternal,
  selection: ModelSelection | undefined,
): void {
  // 恢复/配置刷新可以清除失效选择；未绑定不应借用默认模型，也不影响正在执行的 Active Model。
  this.sessionModelSelection = selection && cloneModelSelection(selection);
}

export function getProjectId(this: AgentRuntimeInternal): ProjectId {
  // Bash cd 会改变执行 cwd，但 project identity 不能随工具内 cwd 漂移。
  // 因此身份始终由 workspaceRoot 推导（不变量 #19：身份与执行路径分离）。
  return projectIdFromDirectory(this.workspaceRoot);
}

export function setWorkingDirectory(this: AgentRuntimeInternal, cwd: string): void {
  // Bash cwd 持久化只应影响当前 runtime 会话，不能改变工作区身份。
  this.workingDirectory = cwd;
}

export async function ensureSessionPersistedForExternalActivity(
  this: AgentRuntimeInternal,
  input: string,
  options?: { traceContext?: TraceContext },
): Promise<void> {
  // 外部活动（如子运行时）写事件前必须先把会话本体落库，否则事件缺少会话主键。
  await this.ensureSessionPersisted(input, options?.traceContext ?? this.rootTraceContext);
}

export function getActiveTurnInfo(this: AgentRuntimeInternal): ActiveTurnInfo | undefined {
  const activeTurn = this.activeTurn;
  // 没有进行中的 turn 时返回 undefined 而不是空对象：调用方据此区分"空闲"与"字段缺失"。
  if (!activeTurn) return undefined;
  // queueLength 是当前 turn 的 pendingInputs，不含 runtime FIFO；两个队列是不同事实。
  return {
    kind: activeTurn.kind,
    ...(activeTurn.inputId === undefined ? {} : { inputId: activeTurn.inputId }),
    queueLength: activeTurn.pendingInputs.length,
    steerable: activeTurn.steerable,
    turnId: activeTurn.turnId,
  };
}

export function getTools(this: AgentRuntimeInternal, model?: Model): ModelToolContract[] {
  // 缓存只保"注册表可见工具 + 排序"，与 model 无关；model 相关过滤各自在返回前做。
  if (this.cachedTools === null) {
    this.cachedTools = filterRuntimeVisibleTools.call(this, this.registry.toContracts());
  }
  return this.cachedTools
    .filter(
      (tool) =>
        (tool.name !== "ToolSearch" && tool.name !== "DeferredToolCall") ||
        !model ||
        // toolSearch 关闭时隐藏这两个入口：否则模型会调用一个在本轮不生效的检索机制。
        resolveToolSearchMode(model, this.config.toolSearch?.mode) !== "off",
    )
    .filter((tool) => tool.name !== "WebSearch" || shouldExposeWebSearch.call(this, model))
    .map((tool) =>
      // 投影放在最后按 model 现算：同一份缓存可服务不同模型，且不把 model 事实写进缓存。
      projectToolModelContract(tool, this.registry.get(tool.name), {
        model,
      }),
    );
}

export function invalidateToolCache(this: AgentRuntimeInternal): void {
  // 置 null 而不是删除：下次 getTools 同步重建，避免注册表变化后继续返回旧快照。
  this.cachedTools = null;
}

export function getToolRegistry(this: AgentRuntimeInternal): ToolRegistry {
  return this.registry;
}

export function getToolExecutor(this: AgentRuntimeInternal): ToolExecutor {
  return this.executor;
}

export function subscribeEvents(this: AgentRuntimeInternal, sink: SessionEventSink): () => void {
  this.eventSinks.add(sink);
  // 返回取消订阅函数：调用方（UI/协议连接）断开时必须能移除 sink，否则泄漏并持续投递。
  return () => {
    this.eventSinks.delete(sink);
  };
}

/**
 * 外部子 runtime 的接缝（一）：交出本 runtime 的会话事件 store。
 *
 * 在 class 外构造的子 runtime（bootstrap 的 dwf actor / legacy script workflow）必须与父
 * runtime 共享同一个 store，否则子会话事件只落在一个谁都读不到的私有 store 里，v4 的
 * `loadPersistedEvents(childSessionId)` 恒为空——transcript 永久空白。子事件仍按子自己的
 * sessionId 落库，两条会话在同一个 store 里互不覆盖（`subagent.ts:280` 的
 * `eventStore: this.eventStore` 是同一条约定）。
 */
export function getSessionEventStore(this: AgentRuntimeInternal): SessionEventStorePort {
  // 直接返回共享 store（不复制）：子会话事件必须落在父 runtime 能读到的同一实例上。
  return this.eventStore;
}

/**
 * 外部子 runtime 的接缝（二）：把子会话的原始事件扇出给本 runtime 的外部 sink 集。
 *
 * 语义与 `subagent.ts:338` 的 `notifyEventSinks(event, {...trace, sessionId: childSessionId})`
 * 完全一致：保留子 sessionId（协议层按它路由到 detached live session），只通知、不 append。
 *
 * 子 runtime 必须在**构造期**把这个调用装成自己的 `deps.eventSink`：
 * `ensureSessionPersistedForExternalActivity` 把 SessionTitleUpdated 写成 sequenceNumber 1，
 * 而 v4 网关只排水连续 seq——构造之后才挂的订阅从 seq 2 起，会永远等一个再也不会来的 seq 1。
 */
export async function notifyExternalChildSessionEvent(
  this: AgentRuntimeInternal,
  input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
    interactionOrigin?: ChildClientPortsContext;
  },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  // 只通知、绝不 append：子 runtime 已经按自己的 sessionId 把这条事件落库了，
  // 再走父 runtime 的 append 链路会造成同一事件在共享 store 里出现两份。
  await this.notifyEventSinks(input.event, { ...traceContext, sessionId: input.childSessionId });
  // 没有交互来源时不做镜像：普通工具活动只属于子会话 timeline。
  if (input.interactionOrigin === undefined) return;
  // Bug 根因（2026-09-23 实机）：guarded dwf actor 的权限请求经父 broker 到了桌面，但 V4 的
  // 确认窗只从**父会话**实时投影的 PermissionRequested 生成；这条事件只在子会话里，窗不出现，
  // actor 永久等待。与 core subagent 同款镜像（只镜像交互，父 timeline 不收工具活动），同样只通知不 append。
  const mirrored = mirrorSubagentInteractionEvent(input.event, {
    ...input.interactionOrigin,
    parentSessionId: this.sessionId,
  });
  // 事件不是可镜像的交互类型（如普通消息）→ 保持静默，不伪造父侧事件。
  if (mirrored === undefined) return;
  // 用父 sessionId 再通知一次，投影侧才会为父会话生成确认窗；依旧只通知、不 append。
  await this.notifyEventSinks(mirrored, { ...traceContext, sessionId: this.sessionId });
}

/**
 * 外部子 runtime 的接缝（三）：铸造子 runtime 的**对外交互**端口。
 *
 * 子 runtime 的账本身份（子 sessionId）不是协议客户端能应答的身份。dwf actor 与 legacy
 * workflow child 过去直接从 `appOptions` 取 `providerRuntimeHeadersPort` / `permissionBroker`，
 * 于是带着 `sess_dwf-…`去问桌面；桌面回包路径上的 `requireSession` 抛错、response 永不发出，
 * 子代理在首个模型请求前永久挂起（8 个子代理、80 分钟无任何事件）。core 内建 subagent 当时靠
 * 两个私有 wrapper 绕开，三处装配两错一对——说明规则散落在调用点就一定会漂。
 *
 * 修法：派生收敛到 `deriveChildClientPorts`，且只能由**父 runtime** 调用——`parentSessionId`
 * 由父自己填，调用方给不了错的值。任何在 class 外构造子 runtime 的装配（dwf actor、legacy
 * workflow child）必须经这里取端口。
 */
export function createChildClientPorts(
  this: AgentRuntimeInternal,
  context: ChildClientPortsContext,
): ClientFacingPorts {
  // 只转发存在的端口：缺席的端口在 deriveChildClientPorts 内部会降级，而不是伪造实现。
  return deriveChildClientPorts(
    {
      ...(this.permissionBroker === undefined ? {} : { permissionBroker: this.permissionBroker }),
      ...(this.providerRuntimeHeadersPort === undefined
        ? {}
        : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
    },
    // parentSessionId 恒取父自己的 sessionId：调用方给不了错值，这是修掉"子代理带自身 id 问桌面"的关键。
    { ...context, parentSessionId: this.sessionId },
  );
}

export function getContextBuilder(this: AgentRuntimeInternal): ContextBuilder {
  // 懒建：没有 builder 时用"仅配置"快照兜底，保证任何 getter 调用方都不会拿到 undefined。
  if (!this.contextBuilder) {
    this.contextBuilder = this.createContextBuilderFromSnapshot(
      this.createConfigOnlyContextSnapshot(this.workingDirectory),
      undefined,
      { persistEnvInfo: false },
    );
  }
  // 这个 getter 只能提供同步预览 builder，不能初始化 messageHistory。
  // 否则首轮 executeTurn 会跳过异步 context source 解析，导致真实 workspace context 丢失。
  return this.contextBuilder;
}

export function getPendingPermissionRequests(
  this: AgentRuntimeInternal,
): PermissionBrokerRequest[] {
  // broker 未实现 inspectable 接口时返回空数组：读取 pending 不得因可选端口缺席而抛错。
  if (!isInspectablePermissionBroker(this.permissionBroker)) return [];
  return this.permissionBroker.listPendingRequests();
}

export async function getProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  // 每次现重建：投影是"由事件归约出来的结果"，不能返回可能过期的缓存快照。
  return this.rebuildProjection();
}

export function getSessionId(this: AgentRuntimeInternal): SessionId {
  return this.sessionId;
}

function filterRuntimeVisibleTools(
  this: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  // 先按内嵌检索分支裁剪可见集合，再统一排序：可见性决定"有哪些"，顺序只影响最终输出。
  const visibleTools = filterEmbeddedSearchRuntimeVisibleTools(this, tools);
  // provider-visible 工具顺序属于最终输出边界；toolset 只决定可见工具集合。
  return orderProviderVisibleToolContracts(visibleTools);
}

function shouldExposeWebSearch(this: AgentRuntimeInternal, model?: Model): boolean {
  // 无 Model 的调用只枚举完整注册表，供持久化和 UI 元数据使用；真实执行始终传入
  // 当前 Active Model，并只读取其冻结的完整能力事实。
  if (!model) return true;
  return model.properties.supportsNativeWebSearch;
}
import { resolveExecutionState } from "@zcode/shared";
