// 文件头：ZCode Protocol JSON-RPC Agent server 的装配与分派层。
// 职责：方法分派、反向请求登记/重发/清理、post-response outbox、驻留池 lease、shutdown。
// 边界：业务语义在 server-operations / v4-bridge / 各 op 模块，这里只做协议与生命周期编排。
//
// 不变量（INV）：
// INV-01 断言：任一入站消息先过 runtimeResources.assertServing()，关闭后不再处理。
// 守护：handleMessage 首行与 setNotificationSink。
// 改错故障：shutdown 后仍创建 session，运行时被重复启动。
// INV-02 断言：反向请求的 response/error 绝不能落入 request 分派。
// 守护：handleMessage 中 isResponse/isErrorResponse 先于 isRequest 判断。
// 改错故障：应答被当作未知方法拒绝，反向请求永不 resolve。
// INV-03 断言：每个 pending 反向请求在 resolve/reject/abort/timeout/disconnect 后必须清理计时器与监听。
// 守护：cleanupClientRequest 统一 clearTimeout 与 removeEventListener。
// 改错故障：定时器与 abort 监听泄漏，进程无法退出。
// INV-04 断言：同一 pending 重发产生多个 requestKey，必须全部从 Map 删除。
// 守护：cleanupClientRequest 遍历 pending.requestKeys。
// 改错故障：pendingClientRequests 残留旧 id，内存随重发线性增长。
// INV-05 断言：reannounce 间隔指数退避且封顶 10s。
// 守护：scheduleReannounce 的 Math.min(interval*2, MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS)。
// 改错故障：无限增长的重发间隔或高频重发，压垮 client。
// INV-06 断言：连接断开后所有反向请求与前台执行都必须被终止。
// 守护：disconnectClient 依次 reject pending、stopActiveForegroundExecution、abort controllers。
// 改错故障：孤儿 Agent 在 owner 消失后继续写文件。
// INV-07 断言：shutdown 幂等，并发调用复用同一个 promise。
// 守护：shutdownPromise 的早返回分支。
// 改错故障：重复 close runtime，第二次抛错覆盖首次结果。
// INV-08 断言：shutdown 不使用 session/close，避免删除产品会话或发布 session.removed。
// 守护：shutdown 只调用 runtimeResources.close 与 unsubscribe。
// 改错故障：进程退出被上游误认为用户主动删会话。
// INV-09 断言：一个 request 全程持有驻留池 lease，覆盖所有 await。
// 守护：handleRequest 的 acquireOperation 与 finally 中的 release。
// 改错故障：handler 持旧 record 时 sampler 回收 session，请求中途失效。
// INV-10 断言：request id 复用时不能继承未消费的旧 outbox。
// 守护：handleRequest 首行 postResponseOutbox.delete(request.id)。
// 改错故障：新订阅收到上一个请求的 initial frame。
// INV-11 断言：post-response 帧必须在 ACK 行之后按数组顺序写出，成功后才 commit。
// 守护：ZCodeProtocolPostResponseBatch 与 takePostResponseBatch 的调用约定。
// 改错故障：客户端在 ACK 前收到帧，或 commit 早于写盘导致丢帧。
// INV-12 断言：插件取消表与 generateText 取消表彼此隔离。
// 守护：pluginOperationControllers 与 workspaceGenerateTextControllers 两张独立 Map。
// 改错故障：取消插件安装误杀 workspace 模型请求。
// INV-13 断言：同一 operationId 在 generateText 活跃期间不得重复登记。
// 守护：withWorkspaceGenerateTextSignal 的 has(operationId) 抛 -32600。
// 改错故障：新 controller 覆盖旧 controller，首个请求失去取消能力。
// INV-14 断言：controller 只删除自己的登记，不误删后来者。
// 守护：finally 中 get(operationId) === controller 判断。
// 改错故障：先结束的请求删掉后登记的同 id controller。
// INV-15 断言：未知方法统一以 JSON-RPC -32601 拒绝。
// 守护：dispatchRequest 的 default 分支。
// 改错故障：未知方法返回成功，客户端静默丢功能。
// INV-16 断言：v4 gateway 未初始化时以 -32603 失败，而不是空指针。
// 守护：requireV4Gateway 的空值分支。
// 改错故障：server dispose 后访问 gateway 抛 TypeError，协议层无法归因。
// INV-17 断言：反向请求超时/取消使用协议错误码，而不是裸 Error。
// 守护：requestClient 中 PROTOCOL_CLIENT_REQUEST_ERROR_CODES 的 timedOut/cancelled。
// 改错故障：客户端无法区分超时与内部错误。
// INV-18 断言：collectResidencySessionIds 覆盖顶层 sessionId、conversation topic、commands 三处。
// 守护：collectResidencySessionIds 的三段提取。
// 改错故障：批量命令未 touch 驻留池，session 被提前回收。
import { querySessionDebug } from "./session-debug.js";
import { offPeakControlParamsSchema, offPeakControlResultSchema } from "@zcode/shared";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { networkCaptureControlSchema, zcodeProtocolNotifications } from "@zcode/shared";
import {
  zcodePluginsCancelOperationParamsSchema,
  zcodeProtocolMethods,
  zcodeWorkspaceCancelGenerateTextParamsSchema,
  zcodeWorkspaceHookTrustGrantParamsSchema,
} from "@zcode/shared";
import type { BrowserControlPort } from "@zcode/contracts";
import type {
  McpElicitationRequest,
  McpElicitationResult,
  McpServerNotification,
} from "@zcode/contracts";
import { requestMcpElicitation } from "./interaction-broker.js";
import { InMemoryWorkspaceHookPolicyProvider } from "@zcode/core";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolMethod,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import {
  cancelBackgroundTask,
  closeSession,
  compactSession,
  createSession,
  forkSession,
  generateWorkspaceText,
  goalSession,
  getTaskTokenUsage,
  getUsageStats,
  listSessions,
  listSessionSubagents,
  readEvents,
  readMessages,
  readSession,
  resumeSession,
  sendPrompt,
  setMode,
  setModel,
  setThoughtLevel,
  stopSession,
  subscribeSession,
} from "./server-operations.js";
import { listChildProcesses } from "./process-child-processes.js";
import { ProtocolRuntimeResources } from "./runtime-resources.js";
import {
  readWorkspacePresentation,
  testProviderModelConnectivity,
} from "./workspace-model-runtime.js";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
} from "./plugins.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "./plugin-reference-catalog.js";
import { getSkillReferenceCatalog } from "./skill-reference-catalog.js";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "./saved-workflows.js";
import { findSavedWorkflowForRunOp, saveSavedWorkflowFromRunOp } from "./saved-workflows-run.js";
import { listMcpServers } from "./mcp.js";
import {
  callMcpUiTool,
  sampleMcpUi,
  cancelMcpUiSampling,
  cancelMcpUiToolCall,
  listMcpUiResourceTemplates,
  listMcpUiResources,
  claimMcpUiAppToolCall,
  registerMcpUiAppTools,
  resolveMcpUiAppToolCall,
  unregisterMcpUiAppTools,
  readMcpUiResource,
  readMcpUiResourceForUi,
  routeMcpServerNotification,
  subscribeMcpUiResource,
  unsubscribeMcpUiResource,
} from "./mcp-ui/index.js";
import { listPluginUiSurfaces } from "./plugin-ui-surfaces.js";
import { updateInteractionPreferences } from "./interaction-preferences.js";
import { refreshProviderRegistry, updateAccountProviderConfig } from "./account-provider-config.js";
import { updateModelIoPreferences } from "./model-io-preferences.js";
import { updateOffPeakToolPolicy } from "./off-peak-tool-policy.js";
import { updateDynamicWorkflowPolicy } from "./dynamic-workflow-policy.js";
import { grantWorkspaceHookTrustForProtocol } from "./workspace-hook-trust.js";
import {
  V4InteractionRegistry,
  resolveV4InteractionRegistryOptionsFromEnv,
} from "../zcode-protocol-v4/interaction-registry.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { createSessionResidentPoolHost } from "./session-residency.js";
import {
  DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT,
  SessionResidentPool,
} from "./session-resident-pool.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import {
  createProtocolLogger,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  PROTOCOL_CLIENT_REQUEST_ERROR_CODES,
  ProtocolRequestError,
  type ParamsSchema,
  parseParams,
  toProtocolError,
  type ZCodeProtocolClientRequestOptions,
  type ZCodeProtocolAgentDependencies,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createInMemorySessionEventStore } from "@zcode/contracts";

export type { ZCodeProtocolAgentDependencies, ZCodeProtocolSessionRecord };

import { closeMcpUiInstance, openMcpUiInstance, validateMcpUiInstance } from "./mcp-ui/index.js";
// [并发] 重发间隔硬上限 10s，避免退避无限增长导致响应迟到。
// 只在 reannounceIntervalMs 被显式传入且为正数时生效。
// 调整它会改变 host 冷启动时的重连节奏，需同步客户端超时。
const MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS = 10_000;

// [契约] 出站消息只允许 notification 或 server→client request 两种形态。
// response 由 handleRequest 直接返回，不走 messageSink。
// 往联合类型里加 response 会绕过 outbox 的 ACK 顺序保证。
type ZCodeProtocolOutboundMessage = ZCodeProtocolNotification | ZCodeProtocolRequest;

/**
 * Trust store 落盘后各 session 的 coordinator
 * 内存镜像（仅创建时 load）不会自动更新，已信任 Hook 继续被拒、banner pendingCount
 * 停留旧值。pretrust 授权成功后按 workspaceKey 通知所有匹配的活跃 session 重载。
 * 独立导出为纯调度函数（不触网、不发事件），便于回归测试直接构造 sessions Map。
 */
// [契约] 独立纯调度函数：按 workspaceKey 通知活跃 session 重载 trust 镜像。
// 不触网、不发协议事件，便于回归测试直接构造 sessions Map。
// 返回 Promise.all，单个 reload 失败会向上冒泡到 grant 分支。
export async function notifyWorkspaceHookTrustGrantSessions(input: {
  grantedWorkspaceKey?: string;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
}): Promise<void> {
  // [失败路径] 取不到 workspaceKey 时跳过通知，而不是通知全部 session。
  // 这是“宁可少刷新也不要跨 workspace 污染”的落点。
  // grant 本身仍返回 accepted，通知失败不改变授权结果。
  if (!input.grantedWorkspaceKey) return;
  await Promise.all(
    [...input.sessions.values()]
      .filter((record) => record.workspace.workspaceKey === input.grantedWorkspaceKey)
      .map((record) => record.app.reloadWorkspaceHookTrust()),
  );
}

// 把协议入参里可能出现的 sessionId 形态（顶层 sessionId、conversation topic、
// 批量 commands）统一收集为驻留池可识别的 id 集合，用于冷恢复闸门与 LRU touch。
// [契约] 从弱类型 params 中尽力收集 sessionId，用于冷恢复闸门与 LRU touch。
// 只做宽松提取，不做 schema 校验；校验在各 op 层完成。
// 返回去重数组，顺序不保证，调用方不得依赖。
function collectResidencySessionIds(params: unknown): string[] {
  if (!params || typeof params !== "object") return [];
  const candidate = params as {
    commands?: unknown;
    sessionId?: unknown;
    topic?: unknown;
  };
  const sessionIds = new Set<string>();
  if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) {
    sessionIds.add(candidate.sessionId);
  }
  if (typeof candidate.topic === "string") {
    const topicSessionId = parseConversationTopic(candidate.topic);
    if (topicSessionId) sessionIds.add(topicSessionId);
  }
  // [契约] 批量命令逐个提取 sessionId，覆盖“一次请求多会话”的形态。
  // 非对象 command 直接跳过，不抛错。
  // 漏掉这一段会让批量操作中的 session 被驻留池提前回收。
  if (Array.isArray(candidate.commands)) {
    for (const command of candidate.commands) {
      if (!command || typeof command !== "object") continue;
      const sessionId = (command as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        sessionIds.add(sessionId);
      }
    }
  }
  return [...sessionIds];
}

// [契约] 插件 operationId 取自 params.operationId，trim 后非空才算有效。
// 无效 id 视为不可取消，直接执行而不登记 controller。
// 与 getOperationId 实现相同但分开存在，避免两类取消共享命名空间时被误改。
function getPluginOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

// [契约] generateText 的 operationId 提取规则与插件侧一致。
// 插件侧有同名 getOperationId 副本，改这里的裁剪规则必须同步另一处，否则 cancel 键会一边命中一边落空。
// 空字符串不算有效 id，避免 cancel 时命中空键。
function getOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

// [契约] 一个 batch 绑定一组 initial frame 与它们的提交回调。
// commit 由写出方在全部 write 成功后调用，server 不主动 commit。
// messages 为只读视图，take 之后即从 outbox 移除。
export interface ZCodeProtocolPostResponseBatch {
  readonly messages: readonly ZCodeProtocolOutboundMessage[];
  commit(): boolean;
}

// [资源] pending 记录聚合了 resolve/reject、超时、重发与 abort 四类资源。
// requestKeys 必须能容纳同一个逻辑请求的多个重发 id。
// 新增字段要同步 cleanupClientRequest，否则泄漏。
interface PendingClientRequest<T> {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
  resultSchema: ParamsSchema<T>;
  requestKeys: Set<string>;
  signal?: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  reannounceTimer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

// [契约] server 实例是协议会话的唯一 owner：sessions Map、取消表、outbox 都在这里。
// 构造时注入 deps 并建立 runtimeResources 与 v4Gateway，之后不可替换。
// 同一进程只应存在一个实例，多实例会争抢 stdin 与 runtime。
export class ZCodeProtocolAgentServer {
  // [资源] 网络抓包器在字段初始化时创建，早于构造函数体。
  // 回调经 messageSink 转发为 processNetworkRequests 通知，sink 未挂时静默丢弃。
  // 不要在构造前访问 this.context，字段初始化顺序不允许。
  private readonly networkCapture = createNodeNetworkCapture("cli", (batch) => {
    this.messageSink?.({
      method: zcodeProtocolNotifications.processNetworkRequests,
      params: batch,
    });
  });
  private readonly runtimeResources: ProtocolRuntimeResources;
  // [并发] 关闭 promise 缓存，实现 shutdown 幂等。
  // 第一次调用创建 promise，后续调用直接复用同一个。
  // 清空该字段会让并发 shutdown 重复 close runtime。
  private shutdownPromise?: Promise<void>;
  readonly browserControlPort: BrowserControlPort;
  /**
   * 官方 MCP 身份头端口所需的最小上下文。
   * MCP 连接池的构造早于 server，需要在 server 就绪后回填闭包持有的引用——
   * 与 v4Gateway 同样的构造顺序收口方式。只暴露 requestClient，不外泄整个 context。
   */
  /** MCP server 发起的 elicitation/create → 用户提问。 */
  // [契约] MCP elicitation 转发到 interaction-broker，由它统一走用户提问通道。
  // signal 透传给 broker，取消语义由 broker 决定。
  // 不要在这里自行实现重试，elicitation 必须一次一问。
  requestMcpElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult> {
    return requestMcpElicitation(this.context, request, options);
  }

  /** MCP server 通知 → 会话 live 事件 / agent 日志。 */
  // [契约] MCP server 通知只路由到 v4 live 事件与 agent 日志。
  // 同步返回，不阻塞 MCP 连接池。
  // 路由失败在 routeMcpServerNotification 内部消化，不向连接池抛出。
  handleMcpNotification(notification: McpServerNotification): void {
    routeMcpServerNotification(this.context, notification);
  }

  get officialMcpAuthRequestContext(): Pick<ZCodeProtocolAgentServerContext, "requestClient"> {
    return this.context;
  }

  // [并发] sink 是可空的热插拔出口，disconnectClient 与 shutdown 会清空它。
  // 所有写出都写 this.messageSink?.()，不要缓存局部引用。
  // 缓存会让断开后的消息写进已关闭的 transport。
  private messageSink?: (message: ZCodeProtocolOutboundMessage) => void;
  // [契约] 记录客户端断开原因，后续反向请求直接以该错误失败。
  // setNotificationSink 重新挂载时清空，表示新的连接已就绪。
  // 不要用它判断进程是否退出，那是 shutdownPromise 的职责。
  private clientDisconnectError?: Error;
  private readonly context: ZCodeProtocolAgentServerContext;
  private readonly logger;
  // [资源] 反向请求登记表，键是 “server-<n>” 字符串化 id。
  // 同一 pending 可能有多个键（重发），清理时必须全删。
  // 表无上限，靠 timeout/abort/disconnect 收敛。
  private readonly pendingClientRequests = new Map<string, PendingClientRequest<unknown>>();
  // [资源] 插件写操作的可取消句柄，按 operationId 索引。
  // 与 generateText 表完全隔离，取消互不影响（INV-12）。
  // 结束路径必须 delete，否则同 id 后续请求会被误 abort。
  private readonly pluginOperationControllers = new Map<string, AbortController>();
  // [资源] workspace 生成文本请求的取消句柄表。
  // 活跃期禁止重复 operationId（INV-13），结束后才允许复用。
  // disconnect/shutdown 会遍历 abort 并 clear 整表。
  private readonly workspaceGenerateTextControllers = new Map<string, AbortController>();
  /**
   * subscribe initial frame 按 JSON-RPC request id 隔离。connection 必须先 take，
   * 再写 response line，最后按数组顺序写 notification，不能靠 microtask 猜时序。
   */
  private readonly postResponseOutbox = new Map<
    ZCodeProtocolRequestId,
    ZCodeProtocolPostResponseBatch
  >();
  // [并发] 反向请求 id 单调递增，进程内唯一，不复用。
  // id 转字符串作为 pending 键，重发沿用同一 id。
  // 回绕到已存在 id 会串号，实际不会在单进程生命周期内发生。
  private nextClientRequestId = 1;

  // [契约] 构造函数只做装配：runtime、logger、context、v4Gateway、驻留池。
  // 顺序敏感：logger 与 context 必须在 gateway 之前就绪。
  // 不要在这里启动 IO 或注册全局监听，入口层负责。
  constructor(deps: ZCodeProtocolAgentDependencies) {
    // [资源] runtimeResources 包装 createZCodeApp，延迟创建并在 close 时释放。
    // context 中的 deps.createZCodeApp 被替换为 runtimeResources.create。
    // 绕过它直接调用 deps.createZCodeApp 会跳过生命周期管理。
    this.runtimeResources = new ProtocolRuntimeResources(deps.createZCodeApp);
    const resolvedDeps = {
      ...deps,
      createZCodeApp: this.runtimeResources.create,
      // 默认 turn 窗口保留策略。
      createSessionEventStore:
        deps.createSessionEventStore ?? (() => createInMemorySessionEventStore()),
      workspaceHookPolicyProvider:
        deps.workspaceHookPolicyProvider ?? new InMemoryWorkspaceHookPolicyProvider(),
    };
    // [契约] logger 在 context 之前创建，供后续所有分支使用。
    // shutdown/disconnect 中的 warn 依赖它，缺失只能静默。
    // 不要改用 console，协议层日志有统一格式与落盘策略。
    this.logger = createProtocolLogger(resolvedDeps);
    this.context = {
      assertServing: () => this.runtimeResources.assertServing(),
      deps: resolvedDeps,
      logger: this.logger,
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
        // 动态工作流灰度门 fail-closed：Host 必须显式 workspace/updateDynamicWorkflowPolicy
        // 才开启。
        dynamicWorkflowEnabled: false,
      },
      notify: (notification) => this.messageSink?.(notification),
      requestClient: (method, params, resultSchema, options) =>
        this.requestClient(method, params, resultSchema, options),
      sessions: new Map<string, ZCodeProtocolSessionRecord>(),
      // 交互应答登记表（broker 反向请求 × v4 resolveInteraction 命令的汇合点）。
      v4Interactions: new V4InteractionRegistry(
        resolveV4InteractionRegistryOptionsFromEnv(deps.env ?? process.env),
      ),
    };
    // v4 通道：gateway 闭包持有 context 做帧出口与命令副作用，构造完立即挂回。
    // [事务] v4Gateway 构造于 context 就绪之后，并立即回填到 context。
    // gateway 闭包持有 context 做帧出口与命令副作用。
    // 未回填时 requireV4Gateway 会以 -32603 拒绝，而不是崩溃。
    this.context.v4Gateway = createConversationV4Gateway(this.context);
    // [契约] browserControlPort 是唯一的浏览器控制入口，同样依赖已就绪的 context。
    // 构造顺序与 v4Gateway 同源：context 先完成，再挂端口。
    // 外部不要直接构造 broker，否则会出现第二个控制通道。
    this.browserControlPort = createProtocolBrowserControlBroker(this.context);
    const sessionResidentTargetCount =
      deps.sessionResidentPoolOptions?.targetCount ?? deps.sessionResidentTargetCount;
    const sessionResidentHighWaterCount =
      deps.sessionResidentPoolOptions?.highWaterCount ??
      (sessionResidentTargetCount === undefined
        ? undefined
        : Math.max(DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT, sessionResidentTargetCount));
    // 单 CLI resident session 池：协议 request release 主动收敛，资源 sampler 只作兜底。
    this.context.sessionResidentPool = new SessionResidentPool(
      createSessionResidentPoolHost(this.context),
      {
        ...deps.sessionResidentPoolOptions,
        // legacy target 曾同时覆盖 high/low，导致迟滞窗口塌为 0；只覆盖 low。
        // 仅配置 target 且超过默认 high 时抬升隐式 high，显式非法组合仍由 pool 拒绝。
        highWaterCount: sessionResidentHighWaterCount,
        targetCount: sessionResidentTargetCount,
      },
    );
  }

  /** 低频 sampler 兜底入口；正常收敛由每个协议 request 的 operation lease 释放触发。 */
  // [并发] 低频 sampler 的兜底入口，正常收敛靠每个 request 的 lease 释放。
  // 池未初始化时可选链静默跳过。
  // 不要把它当成主回收路径，频繁调用会打断活跃 session。
  rebalanceResidentSessions(): void {
    this.context.sessionResidentPool?.rebalance();
  }

  /**
   * 借同一 60s 节拍做 event store 的时间兜底淘汰：
   * subagent 子 session 只有一个 turn，等不到下一个 turn_started，只能按时间清。返回淘汰条数。
   */
  // [资源] 借 60s 节拍按时间淘汰 event store 中的 transient 事件。
  // subagent 子 session 只有一个 turn，等不到下一次 turn_started。
  // 返回淘汰条数，供诊断日志汇总。
  pruneSessionEventStores(nowMs: number = Date.now()): number {
    let evicted = 0;
    for (const record of this.context.sessions.values()) {
      evicted += record.eventStore.pruneTransientEvents?.(nowMs) ?? 0;
    }
    return evicted;
  }

  /** 同一 60s 节拍：释放已终态、无订阅者、无 record 的 detached subagent child publisher。 */
  // [资源] 判 detached 的三个条件必须同时成立：已终态、无订阅者、无 record，缺一条都不释放引用。
  // 委托 v4Gateway 执行，gateway 缺失时返回 0。
  // 过早回收会让重连客户端丢失补帧来源。
  pruneDetachedChildPublishers(nowMs: number = Date.now()): number {
    return this.context.v4Gateway?.pruneDetachedChildPublishers(nowMs) ?? 0;
  }

  /**
   * 内存诊断计数器，随 60s 资源采样写本地日志。
   * 只读 Map.size / 数组长度，不触碰 session 状态；持久化 event store 不提供 getStats 时计 0。
   */
  // [资源] 只读 Map.size 与 stats 计数，不触碰 session 状态。
  // 持久化 event store 不提供 getStats 时按 0 计。
  // v4 计数以 v4. 前缀合并，键名冲突会覆盖同名顶层计数。
  collectMemoryDiagnostics(): Record<string, number> {
    let eventRows = 0;
    let eventEvicted = 0;
    let eventTransientRetained = 0;
    for (const record of this.context.sessions.values()) {
      const stats = record.eventStore.getStats?.();
      eventRows += stats?.events ?? 0;
      eventEvicted += stats?.evictedEvents ?? 0;
      eventTransientRetained += stats?.retainedTransient ?? 0;
    }
    const counters: Record<string, number> = {
      sessions: this.context.sessions.size,
      eventRows,
      eventEvicted,
      eventTransientRetained,
    };
    const v4 = this.context.v4Gateway?.collectMemoryDiagnostics();
    if (v4) {
      for (const [key, value] of Object.entries(v4)) {
        counters[`v4.${key}`] = value;
      }
    }
    return counters;
  }

  // [契约] 挂载新连接出口，同时清除上一次断开错误。
  // 先 assertServing，避免 shutdown 后再挂 sink。
  // sink 只保存引用，不做缓冲；未连接期间的消息由调用方丢弃。
  setNotificationSink(sink: (message: ZCodeProtocolOutboundMessage) => void): void {
    this.runtimeResources.assertServing();
    this.clientDisconnectError = undefined;
    this.messageSink = sink;
  }

  // [失败路径] 连接断开是进程级终止边界，必须同步取消全部前台执行。
  // 顺序：停抓包 → 记错误 → reject pending → stop 会话执行 → abort 各类 controller。
  // 只做一半会让旧 Agent 成为孤儿继续写文件。
  disconnectClient(error: Error): void {
    this.networkCapture.setCaptureId(null);
    this.clientDisconnectError = error;
    // 连接关闭后反向请求已不可能收到响应，必须先结束 pending，
    // 否则正在物化 Session 的 handler 会阻塞 connection 的关闭流程。
    // [并发] 先快照再去重遍历，避免 reject 过程中修改 Map 影响迭代。
    // 同一 pending 有多个键，Set 保证只 reject 一次。
    // 直接遍历 Map.values() 在删除时会跳过元素。
    const pendingRequests = new Set(this.pendingClientRequests.values());
    for (const pending of pendingRequests) {
      this.cleanupClientRequest(pending);
      pending.reject(error);
    }
    // Bug 原因：Server Core 被 SIGKILL 后，Agent 的 stdin 虽然收到 EOF，但连接关闭
    // 只拒绝了反向请求，没有打断已经进入 Bash/工具循环的前台执行。transport 会继续
    // 等待该请求自然结束，旧 Agent 因而成为 PPID 1 的孤儿并在新 Core generation 之外
    // 继续写文件。协议 owner 消失就是本进程全部前台执行的终止边界，必须同步取消。
    for (const record of this.context.sessions.values()) {
      try {
        record.app.runtime.stopActiveForegroundExecution?.({
          reason: "ZCode Protocol owner disconnected",
        });
      } catch (cause) {
        this.logger?.warn("Failed to stop foreground execution after protocol disconnect", {
          errorType: cause instanceof Error ? cause.name : typeof cause,
          sessionId: record.app.sessionId,
        });
      }
      record.activeAbortController?.abort(error);
    }
    // [资源] 断开时中止所有 in-flight 生成文本请求。
    // abort 使用连接错误对象，客户端可据此归因。
    // 随后 clear 整表，防止残留 controller 被后续 cancel 命中。
    for (const controller of this.workspaceGenerateTextControllers.values()) {
      controller.abort(error);
    }
    this.workspaceGenerateTextControllers.clear();
    for (const controller of this.pluginOperationControllers.values()) {
      controller.abort(error);
    }
    this.pluginOperationControllers.clear();
  }

  /** 进程资源关闭，不使用会删除产品会话/发布 session.removed 的 session/close。 */
  // [事务] 关闭顺序：缓存 promise → close runtime → disconnect → 清 sink/outbox → 取消全部 operation → unsubscribe。
  // close 的 promise 被缓存并最终返回，保证调用方等到真正结束。
  // 不调用 session/close，避免删除产品会话。
  shutdown(): Promise<void> {
    // shutdown 幂等：并发调用复用同一个关闭 promise，避免重复关 runtime。
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runtimeResources.close();
    const error = new Error("ZCode Protocol runtime stopping");
    this.disconnectClient(error);
    this.messageSink = undefined;
    this.clearPostResponseMessages();
    for (const controller of this.pluginOperationControllers.values()) controller.abort(error);
    for (const controller of this.workspaceGenerateTextControllers.values())
      controller.abort(error);
    for (const record of this.context.sessions.values()) {
      record.activeAbortController?.abort(error);
      try {
        record.unsubscribe?.();
      } catch {
        this.logger?.warn("Session unsubscribe failed during protocol shutdown", {
          event: "zcode_protocol.session.unsubscribe.failed",
        });
      }
    }
    return this.shutdownPromise;
  }

  /** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */
  // [事务] app drain 有界结束后释放 v4 投影，并清空 sessions Map。
  // 即使某个 app.close 挂起也必须执行，因此不 await。
  // 清空 sessions 后旧 record 不可再被协议访问。
  disposeProjections(): void {
    this.context.v4Gateway?.dispose();
    this.context.sessions.clear();
  }

  /** 一次性取走某 request 的 post-response messages；重复 take 返回空数组。 */
  // [契约] 返回的是数组副本，调用方 push / splice 不会回写 outbox；要保留失败重试能力请改用 takePostResponseBatch。
  // 内部先 take batch 再 commit，语义等价于“取走即提交”。
  // 需要写成功后再提交的调用方应改用 takePostResponseBatch。
  takePostResponseMessages(requestId: ZCodeProtocolRequestId): ZCodeProtocolOutboundMessage[] {
    const batch = this.takePostResponseBatch(requestId);
    batch?.commit();
    return [...(batch?.messages ?? [])];
  }

  /** production NDJSON 取完整 batch；只有全部 write 成功后才调 commit。 */
  // [事务] 取出即从 outbox 删除，保证同一 batch 只被一个写出方持有。
  // commit 由调用方在全部 write 成功后触发。
  // 丢弃 batch 前必须确保不会再有写出方使用它。
  takePostResponseBatch(requestId: ZCodeProtocolRequestId): ZCodeProtocolPostResponseBatch | null {
    const batch = this.postResponseOutbox.get(requestId) ?? null;
    this.postResponseOutbox.delete(requestId);
    return batch;
  }

  /** connection close / server dispose 时释放尚未写出的 initial frame 引用。 */
  // [资源] clearPostResponseMessages 在 connection close 与 dispose 两处调用，clear 之后表内 batch 全部不可恢复。
  // 直接 clear 整表，不逐个 commit。
  // 被丢弃的 batch 对应的订阅仍需由 gateway 侧清理。
  clearPostResponseMessages(): void {
    this.postResponseOutbox.clear();
  }

  // [契约] 入站消息总入口：先 assertServing，再按 response/error/request/notification 四类分派。
  // response 先于 request 判断，防止反向应答误入方法分派（INV-02）。
  // 未知 notification 只记 debug 日志并返回 undefined。
  async handleMessage(
    message: ZCodeProtocolMessage,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined> {
    this.runtimeResources.assertServing();
    // 反向请求的应答先按 id 汇合到 pending，不能误入 request 分派分支。
    // [契约] 正常应答按 id 汇合到 pendingClientRequests。
    // 找不到 pending 时静默丢弃，说明对应请求已超时或取消。
    // 不要在这里做 schema 校验，resolveClientRequest 已经 parse。
    if (isResponse(message)) {
      this.resolveClientRequest(message.id, message.result);
      return undefined;
    }
    // [失败路径] 错误应答包装成 ProtocolRequestError 后 reject 对应 pending。
    // 保留原始 code/message/data，便于客户端区分业务错误。
    // 找不到 pending 同样静默丢弃，不抛给传输层。
    if (isErrorResponse(message)) {
      this.rejectClientRequest(
        message.id,
        new ProtocolRequestError(message.error.code, message.error.message, message.error.data),
      );
      return undefined;
    }
    if (isRequest(message)) {
      return await this.handleRequest(message);
    }
    if (isNotification(message)) {
      if (message.method === zcodeProtocolMethods.processNetworkCapture) {
        const control = networkCaptureControlSchema.safeParse(message.params);
        if (control.success) this.networkCapture.setCaptureId(control.data.captureId);
        return undefined;
      }
      this.logger?.debug("ZCode Protocol notification ignored", {
        event: "zcode_protocol.notification.ignored",
        method: message.method,
        module: "bootstrap.zcode_protocol",
      });
    }
    return undefined;
  }

  // [事务] 每个 request 的生命周期：清旧 outbox → 取驻留 lease → 分派 → ok/fail → finally 释放 lease。
  // catch 中再次清 outbox，确保失败请求不残留帧。
  // toProtocolError 统一把异常归一为协议错误。
  private async handleRequest(
    request: ZCodeProtocolRequest,
  ): Promise<ZCodeProtocolError | ZCodeProtocolResponse> {
    // request id 可在前一请求完成后复用；新请求不能继承未消费的旧 outbox。
    // [契约] 请求 id 可复用，新请求必须先丢弃未消费的旧 batch（INV-10）。
    // 这是幂等分派的前置条件。
    // 删除后旧订阅的 initial frame 由 gateway 侧重新生成。
    this.postResponseOutbox.delete(request.id);
    let releaseResidencyOperation: (() => void) | undefined;
    try {
      // subscribe hydration、workspace 配置与 resume 都可能跨 await。若只看
      // session 当前状态，sampler 会在 handler 持有旧 record 时把它关闭。进程级 lease
      // 覆盖整个 request；能识别的 sessionIds 额外用于冷恢复闸门与 LRU touch。
      releaseResidencyOperation = await this.context.sessionResidentPool?.acquireOperation(
        collectResidencySessionIds(request.params),
      );
      const result = await this.dispatchRequest(request);
      return this.ok(request.id, result);
    } catch (error) {
      this.postResponseOutbox.delete(request.id);
      const protocolError = toProtocolError(error);
      return this.fail(request.id, protocolError.code, protocolError.message, protocolError.data);
    } finally {
      releaseResidencyOperation?.();
    }
  }

  // 方法分派表：v4 conversation 通道、旧 session 系列通道与插件/工作流/usage 命令
  // 全部分发到各自 op 层，统一共享 this.context；未知方法按 JSON-RPC -32601 拒绝。
  // [契约] 方法分派表：v4 通道、旧 session 通道、插件/工作流/usage 命令统一共享 this.context。
  // 新增方法必须同时登记方法名常量与 case 分支，否则落到 default。
  // 各 case 只做参数透传，业务校验在 op 层。
  private async dispatchRequest(request: ZCodeProtocolRequest) {
    switch (request.method) {
      // ── v4 conversation 通道（竖切，与旧 session/* 并存）──
      case V4_METHODS.connectionFlow: {
        this.requireV4Gateway().setConnectionFlowState(request.params);
        return {};
      }
      // [事务] 同一 subscribe 方法按 topic 前缀分派：sessions-index / workspace-config / conversation。
      // dispatch 返回 initialWires 与 commit，写入 postResponseOutbox 等待 ACK 后写出。
      // ack 之外的字段一律不返回，保持 strict ACK-only。
      case V4_METHODS.conversationSubscribe: {
        // 同一 subscribe 方法按 topic 前缀分派：
        // sessions-index/* → 列表订阅；workspace-config/* → 配置目录订阅；否则 conversation。
        const gateway = this.requireV4Gateway();
        const topic = (request.params as { topic?: unknown } | null)?.topic;
        let dispatch;
        if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
          dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
        } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
          dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
        } else {
          dispatch = await gateway.subscribeReserved(request.params);
        }
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }
      case V4_METHODS.conversationResync: {
        // same-sub recovery 与 subscribe 共用确定性 post-response outbox；公共
        // response 仍 strict ACK-only，physical recovery 只能在 ACK line 后发送。
        const dispatch = this.requireV4Gateway().resyncReserved(request.params);
        if (dispatch.initialWires.length > 0) {
          this.postResponseOutbox.set(request.id, {
            messages: dispatch.initialWires.map((wire) => ({
              method: V4_NOTIFICATIONS.conversationFrame,
              params: wire,
            })),
            commit: dispatch.commit,
          });
        }
        return { ack: dispatch.ack };
      }
      // [契约] 取消订阅必须 topic + subscriptionId + connectionId 精确命中。
      // 禁止按裸 subId 跨 conversation/sessions-index/workspace-config 广撒网。
      // 命中失败由 gateway 静默处理，不向客户端报错。
      case V4_METHODS.conversationUnsubscribe: {
        // topic + subscriptionId + connectionId 精确命中唯一 publisher；禁止按裸
        // subId 对 conversation/sessions-index/workspace-config 广撒网。
        this.requireV4Gateway().unsubscribe(request.params);
        return {};
      }
      // ── 行分页 query（独立分支，便于与帧分派改动合并）──
      case V4_METHODS.conversationRowsRange:
        return await this.requireV4Gateway().rowsRange(request.params);
      case V4_METHODS.conversationPlans:
        return await this.requireV4Gateway().plans(request.params);
      case V4_METHODS.backgroundBashOutput:
        return await this.requireV4Gateway().backgroundBashOutput(request.params);
      // [失败路径] 生命周期只存在于驻留 runtime：record 缺失时直接返回 accepted:false。
      // 换票不能恢复冷会话，也不能重放原始输入。
      // 结果统一过 offPeakControlResultSchema，避免返回未声明字段。
      case V4_METHODS.offPeakControl: {
        const params = offPeakControlParamsSchema.parse(request.params);
        const record = this.context.sessions.get(params.sessionId);
        // 生命周期只存在于驻留 runtime；换票不能恢复冷会话或重放原始输入。
        return offPeakControlResultSchema.parse(
          record ? await record.app.runtime.controlOffPeakExecution(params) : { accepted: false },
        );
      }
      case V4_METHODS.conversationFileChanges:
        return await this.requireV4Gateway().fileChanges(request.params);
      case V4_METHODS.conversationFileRewindPreview:
        return await this.requireV4Gateway().fileRewindPreview(request.params);
      // workflow run 事件日志分页（只读、无状态、超时重发安全；新方法天然偏斜安全）。
      case V4_METHODS.conversationWorkflowRunEvents:
        return await this.requireV4Gateway().workflowRunEvents(request.params);
      // dwf run 枚举（重启后的发现查询）。
      case V4_METHODS.conversationWorkflowRuns:
        return await this.requireV4Gateway().workflowRuns(request.params);
      // dwf 用户面产物的三个读面。同族：只读、无状态、
      // 超时重发安全；ArtifactRead 的授权在宿主端口侧，网关只校参数与分块。
      case V4_METHODS.conversationWorkflowRunArtifacts:
        return await this.requireV4Gateway().workflowRunArtifacts(request.params);
      case V4_METHODS.conversationWorkflowRunArtifactData:
        return await this.requireV4Gateway().workflowRunArtifactData(request.params);
      case V4_METHODS.conversationWorkflowRunArtifactRead:
        return await this.requireV4Gateway().workflowRunArtifactRead(request.params);
      // dwf 工作区 transcript 的两个读面。同族。
      case V4_METHODS.conversationWorkflowRunWorkspace:
        return await this.requireV4Gateway().workflowRunWorkspace(request.params);
      case V4_METHODS.conversationWorkflowRunNodeResult:
        return await this.requireV4Gateway().workflowRunNodeResult(request.params);
      // 附件只能走小 RPC transaction，禁止 full-data attachment/put 单行。
      case V4_METHODS.attachmentBegin:
        return await this.requireV4Gateway().attachmentBegin(request.params);
      case V4_METHODS.attachmentChunk:
        return await this.requireV4Gateway().attachmentChunk(request.params);
      case V4_METHODS.attachmentCommit:
        return await this.requireV4Gateway().attachmentCommit(request.params);
      case V4_METHODS.attachmentAbort:
        await this.requireV4Gateway().attachmentAbort(request.params);
        return {};
      case V4_METHODS.attachmentRead:
        return await this.requireV4Gateway().attachmentRead(request.params);
      case V4_METHODS.conversationAttachmentRead:
        return await this.requireV4Gateway().conversationAttachmentRead(request.params);
      case V4_METHODS.conversationAttachmentStat:
        return await this.requireV4Gateway().conversationAttachmentStat(request.params);
      case V4_METHODS.attachmentPreviewSource:
        return await this.requireV4Gateway().attachmentPreviewSource(request.params);
      // ── usage query（additive）：与旧 usage/stats、session/usage 同一数据访问
      // 层（usage store 聚合），仅换 v4 名字空间——不经 v4Gateway（无会话投影依赖），
      // 也不经旧 op 分派（无桥）。旧 case 保留到旧词删除（老 host 版本兼容）。──
      case V4_METHODS.usageStats:
        return await getUsageStats(this.context, request.params);
      case V4_METHODS.conversationUsage:
        return await getTaskTokenUsage(this.context, request.params);
      case V4_METHODS.command:
        return this.requireV4Gateway().handleCommand(request.params);
      case V4_METHODS.commandsQuery:
        return this.requireV4Gateway().queryCommands(request.params);
      case V4_METHODS.sessionsIndexReconcile:
        return this.requireV4Gateway().reconcileSessions(request.params);
      // 旧 session 系列通道：生命周期、读面与写面都委托 server-operations op。
      case zcodeProtocolMethods.sessionCreate:
        return await createSession(this.context, request.params, request.trace);
      case zcodeProtocolMethods.sessionResume:
        return await resumeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionList:
        return await listSessions(this.context, request.params);
      case zcodeProtocolMethods.sessionSubagents:
        return await listSessionSubagents(this.context, request.params);
      case zcodeProtocolMethods.sessionRead:
        return await readSession(this.context, request.params);
      case zcodeProtocolMethods.sessionMessages:
        return await readMessages(this.context, request.params);
      case zcodeProtocolMethods.sessionEvents:
        return await readEvents(this.context, request.params);
      case zcodeProtocolMethods.sessionSubscribe:
        return await subscribeSession(this.context, request.params);
      case zcodeProtocolMethods.sessionSend:
        return await sendPrompt(this.context, request.params);
      case zcodeProtocolMethods.sessionStop:
        return await stopSession(this.context, request.params);
      case zcodeProtocolMethods.sessionCancelBackgroundTask:
        return await cancelBackgroundTask(this.context, request.params);
      case zcodeProtocolMethods.sessionFork:
        return await forkSession(this.context, request.params);
      case zcodeProtocolMethods.sessionCompact:
        return await compactSession(this.context, request.params);
      case zcodeProtocolMethods.sessionGoal:
        return await goalSession(this.context, request.params);
      case zcodeProtocolMethods.sessionSetModel:
        return await setModel(this.context, request.params);
      case zcodeProtocolMethods.sessionSetThoughtLevel:
        return await setThoughtLevel(this.context, request.params);
      case zcodeProtocolMethods.sessionSetMode:
        return await setMode(this.context, request.params);
      case zcodeProtocolMethods.sessionClose:
        return await closeSession(this.context, request.params);
      case zcodeProtocolMethods.workspaceReadPresentation:
        return await readWorkspacePresentation(this.context, request.params);
      // [事务] 授权成功后才通知同 workspace 的活跃 session 重载 trust 镜像。
      // workspaceKey 用 safeParse 尽力提取，失败则跳过通知（grant 已 parse 过）。
      // 通知失败会向上冒泡，但授权结果已经落盘，属可重试场景。
      case zcodeProtocolMethods.workspaceHookTrustGrant: {
        const grantResult = await grantWorkspaceHookTrustForProtocol(request.params, {
          appVersion: this.context.deps.version,
          policyProvider: this.context.deps.workspaceHookPolicyProvider,
        });
        if (grantResult.accepted) {
          await notifyWorkspaceHookTrustGrantSessions({
            // dispatch 层的 params 是弱类型；grant 内部已用同一 schema parse 过，这里
            // safeParse 只为取出 workspaceKey 做匹配，失败即跳过通知（防御，正常必成功）。
            grantedWorkspaceKey: zcodeWorkspaceHookTrustGrantParamsSchema.safeParse(request.params)
              .success
              ? zcodeWorkspaceHookTrustGrantParamsSchema.parse(request.params).workspace
                  .workspaceKey
              : undefined,
            sessions: this.context.sessions,
          });
        }
        return grantResult;
      }
      case zcodeProtocolMethods.providerUpdateAccountConfig:
        return await updateAccountProviderConfig(this.context, request.params);
      case zcodeProtocolMethods.providerRefreshRegistry:
        return await refreshProviderRegistry(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateInteractionPreferences:
        return await updateInteractionPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateModelIoPreferences:
        return await updateModelIoPreferences(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy:
        return await updateOffPeakToolPolicy(this.context, request.params);
      case zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy:
        return await updateDynamicWorkflowPolicy(this.context, request.params);
      case zcodeProtocolMethods.workspaceGenerateText:
        return await this.withWorkspaceGenerateTextSignal(request, (signal) =>
          generateWorkspaceText(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.workspaceCancelGenerateText:
        return this.cancelWorkspaceGenerateText(request.params);
      case zcodeProtocolMethods.providerTestModelConnectivity:
        return await testProviderModelConnectivity(this.context, request.params);
      case zcodeProtocolMethods.mcpList:
        return await listMcpServers(this.context, request.params);
      case zcodeProtocolMethods.mcpReadResource:
        return await readMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiOpenInstance:
        return openMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiValidateInstance:
        return validateMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCloseInstance:
        return closeMcpUiInstance(this.context, request.params);
      case zcodeProtocolMethods.mcpUiSampling:
        return sampleMcpUi(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCancelSampling:
        return cancelMcpUiSampling(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCallTool:
        return await callMcpUiTool(this.context, request.params);
      case zcodeProtocolMethods.mcpUiCancelCall:
        return await cancelMcpUiToolCall(this.context, request.params);
      case zcodeProtocolMethods.mcpUiReadResource:
        return await readMcpUiResourceForUi(this.context, request.params);
      case zcodeProtocolMethods.mcpUiListResources:
        return await listMcpUiResources(this.context, request.params);
      case zcodeProtocolMethods.mcpUiListResourceTemplates:
        return await listMcpUiResourceTemplates(this.context, request.params);
      case zcodeProtocolMethods.mcpUiSubscribeResource:
        return await subscribeMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiUnsubscribeResource:
        return await unsubscribeMcpUiResource(this.context, request.params);
      case zcodeProtocolMethods.mcpUiRegisterAppTools:
        return await registerMcpUiAppTools(this.context, request.params);
      case zcodeProtocolMethods.mcpUiUnregisterAppTools:
        return await unregisterMcpUiAppTools(this.context, request.params);
      case zcodeProtocolMethods.mcpUiClaimAppToolCall:
        return await claimMcpUiAppToolCall(this.context, request.params);
      case zcodeProtocolMethods.mcpUiResolveAppToolCall:
        return await resolveMcpUiAppToolCall(this.context, request.params);
      // 插件管理：带 operationId 的安装/市场/解析写操作走可取消包装，查询类直通。
      case zcodeProtocolMethods.pluginsList:
        return await listPlugins(this.context, request.params);
      case zcodeProtocolMethods.pluginsReferenceCatalogWithCategory:
        return await getPluginReferenceCatalog(this.context, request.params, true);
      case zcodeProtocolMethods.pluginsReferenceCatalog:
        return await getPluginReferenceCatalog(this.context, request.params);
      case zcodeProtocolMethods.pluginsListUiSurfaces:
        return await listPluginUiSurfaces(this.context, request.params);
      case zcodeProtocolMethods.skillsReferenceCatalog:
        return await getSkillReferenceCatalog(this.context, request.params);
      case zcodeProtocolMethods.workflowsList:
        return await listSavedWorkflowsOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsGet:
        return await getSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsUpdateMeta:
        return await updateSavedWorkflowMetaOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsDelete:
        return await deleteSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsRuns:
        return await listSavedWorkflowRunsOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsMove:
        return await moveSavedWorkflowOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsSave:
        return await saveSavedWorkflowFromRunOp(this.context, request.params);
      case zcodeProtocolMethods.workflowsForRun:
        return await findSavedWorkflowForRunOp(this.context, request.params);
      case zcodeProtocolMethods.pluginsResolveSuggestedReference:
        return await this.withPluginOperationSignal(request, (signal) =>
          resolveSuggestedPluginReference(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsSetEnabled:
        return await this.withPluginOperationSignal(request, (signal) =>
          setPluginEnabled(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsOverview:
        return await getPluginsOverview(this.context, request.params);
      case zcodeProtocolMethods.processChildProcesses:
        return listChildProcesses(this.context.deps.mcpTelemetry?.listProcesses() ?? []);
      case zcodeProtocolMethods.runtimeCapabilities:
        return { independentPlanState: true, historyFirst: true };
      case zcodeProtocolMethods.pluginsMarketplaceAdd:
        return await this.withPluginOperationSignal(request, (signal) =>
          addPluginMarketplace(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsMarketplaceRemove:
        return await removePluginMarketplace(this.context, request.params);
      case zcodeProtocolMethods.pluginsMarketplaceUpdate:
        return await this.withPluginOperationSignal(request, (signal) =>
          updatePluginMarketplace(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsInstall:
        return await this.withPluginOperationSignal(request, (signal) =>
          installPlugin(this.context, request.params, signal),
        );
      case zcodeProtocolMethods.pluginsCancelOperation:
        return this.cancelPluginOperation(request.params);
      case zcodeProtocolMethods.pluginsUninstall:
        return await uninstallPlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsUpdate:
        return await updatePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsRestoreBuiltin:
        return await restoreBuiltinPlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsConfigure:
        return await configurePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsResetConfig:
        return await resetPluginConfig(this.context, request.params);
      case zcodeProtocolMethods.pluginsValidate:
        return await validatePlugin(this.context, request.params);
      case zcodeProtocolMethods.pluginsDescribe:
        return await describePlugin(this.context, request.params);
      case zcodeProtocolMethods.usageStats:
        return await getUsageStats(this.context, request.params);
      case zcodeProtocolMethods.sessionDebug:
        return querySessionDebug(this.context, request.params);
      case zcodeProtocolMethods.sessionUsage:
        return await getTaskTokenUsage(this.context, request.params);
      // [失败路径] 未知方法统一 -32601，禁止返回成功空对象。
      // 错误 message 带方法名，便于客户端定位版本偏斜。
      // 新增 case 提在 default 之前，default 必须保持最后。
      default:
        throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
    }
  }

  // v4 gateway 在构造末尾回填；缺失说明 server 已 dispose 或尚未完成初始化。
  // [失败路径] gateway 缺失说明 server 已 dispose 或尚未完成初始化，抛 -32603。
  // 协议层不能出现 TypeError，否则客户端无法归因。
  // 返回类型由 context 收窄，调用方无需再判空。
  private requireV4Gateway() {
    if (!this.context.v4Gateway) {
      throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
    }
    return this.context.v4Gateway;
  }

  // [资源] 有 operationId 才登记 controller 并支持取消，无 id 直接执行。
  // finally 只删除自己登记的 controller（INV-14）。
  // pluginOperationControllers 与 generateText 表隔离，取消不串扰。
  private async withPluginOperationSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getPluginOperationId(request.params);
    // 无 operationId 表示不可取消，直接执行；有则登记 controller 供 cancel 命中。
    if (!operationId) return await run();

    const controller = new AbortController();
    this.pluginOperationControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.pluginOperationControllers.get(operationId) === controller) {
        this.pluginOperationControllers.delete(operationId);
      }
    }
  }

  private cancelPluginOperation(rawParams: unknown) {
    const params = parseParams(zcodePluginsCancelOperationParamsSchema, rawParams);
    const controller = this.pluginOperationControllers.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    // 插件同步的可取消能力必须保留在 V4 server；仅按 operationId 中止对应链路。
    controller.abort();
    this.pluginOperationControllers.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }

  // [并发] 活跃期同 operationId 重复登记直接 -32600 拒绝。
  // 拒绝而非覆盖，保证首个请求的取消能力不被夺走。
  // 请求结束后 finally 释放，之后才允许复用同 id。
  private async withWorkspaceGenerateTextSignal<T>(
    request: ZCodeProtocolRequest,
    run: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operationId = getOperationId(request.params);
    // generateText 用独立 controller 表，避免与插件安装类 operation 的取消互相串扰。
    if (!operationId) return await run();

    if (this.workspaceGenerateTextControllers.has(operationId)) {
      // 重复 operationId 会覆盖首个请求的 AbortController，导致首个请求失去取消能力。
      // 活跃 operationId 必须保持唯一；请求结束后 finally 会释放，之后才允许复用。
      throw new ProtocolRequestError(
        -32600,
        `Workspace generate operation is already active: ${operationId}`,
      );
    }

    const controller = new AbortController();
    this.workspaceGenerateTextControllers.set(operationId, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.workspaceGenerateTextControllers.get(operationId) === controller) {
        this.workspaceGenerateTextControllers.delete(operationId);
      }
    }
  }

  // [失败路径] 未命中 controller 时返回 cancelled:false，不抛错。
  // 命中则 abort(AbortError) 并立即 delete，避免二次取消。
  // 取消与请求自身的 finally 竞争时，靠 get===controller 判断收敛。
  private cancelWorkspaceGenerateText(rawParams: unknown) {
    const params = parseParams(zcodeWorkspaceCancelGenerateTextParamsSchema, rawParams);
    const controller = this.workspaceGenerateTextControllers.get(params.operationId);
    if (!controller) return { operationId: params.operationId, cancelled: false };
    controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
    this.workspaceGenerateTextControllers.delete(params.operationId);
    return { operationId: params.operationId, cancelled: true };
  }

  private ok(id: ZCodeProtocolRequestId, result: unknown): ZCodeProtocolResponse {
    return { id, result };
  }

  private fail(
    id: ZCodeProtocolRequestId,
    code: number,
    message: string,
    data?: unknown,
  ): ZCodeProtocolError {
    return { error: { code, data, message }, id };
  }

  // [并发] 反向请求：先登记 pending 再写出，reannounce 按指数退避重发。
  // 三处早退：已断开、无 sink、signal 已 abort。
  // 所有收敛路径（回包/超时/abort/断开）最终都走同一个 cleanup。
  private requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    if (this.clientDisconnectError) {
      throw this.clientDisconnectError;
    }
    if (!this.messageSink) {
      throw new ProtocolRequestError(
        PROTOCOL_CLIENT_REQUEST_ERROR_CODES.noClientAttached,
        `No ZCode Protocol client is attached for ${method}`,
      );
    }

    // 反向请求先登记 pending 再写出；reannounce 在 host 未应答时按指数退避重发，
    // 间隔封顶 10s，直到回包、超时或 abort 触发同一 cleanup。
    return new Promise<T>((resolve, reject) => {
      let active = true;
      const pending: PendingClientRequest<T> = {
        method,
        reject,
        resolve,
        resultSchema,
        requestKeys: new Set(),
        signal: options?.signal,
      };
      // [资源] 唯一清理闭包，置 active=false 并调用 cleanupClientRequest。
      // 计时器与监听都在 cleanupClientRequest 中释放。
      // 新增资源释放点必须接进这里，否则超时路径会泄漏。
      const cleanup = () => {
        active = false;
        this.cleanupClientRequest(pending);
      };
      pending.abortHandler = () => {
        cleanup();
        reject(
          new ProtocolRequestError(
            PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled,
            `Client request cancelled: ${method}`,
          ),
        );
      };
      if (options?.signal?.aborted) {
        pending.abortHandler();
        return;
      }
      if (options?.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          cleanup();
          reject(
            new ProtocolRequestError(
              PROTOCOL_CLIENT_REQUEST_ERROR_CODES.timedOut,
              `Client request timed out: ${method}`,
              {
              timeoutMs: options.timeoutMs,
              },
            ),
          );
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", pending.abortHandler, { once: true });
      const sendClientRequest = () => {
        if (!active) {
          return;
        }
        const id = `server-${this.nextClientRequestId++}`;
        const key = String(id);
        pending.requestKeys.add(key);
        this.pendingClientRequests.set(key, pending as PendingClientRequest<unknown>);
        this.messageSink?.({
          id,
          method,
          params,
          ...(options?.trace ? { trace: options.trace } : {}),
        });
      };
      sendClientRequest();
      const reannounceIntervalMs =
        options?.reannounceIntervalMs !== undefined &&
        Number.isFinite(options.reannounceIntervalMs) &&
        options.reannounceIntervalMs > 0
          ? Math.floor(options.reannounceIntervalMs)
          : undefined;
      if (reannounceIntervalMs !== undefined) {
        let nextReannounceIntervalMs = reannounceIntervalMs;
        const scheduleReannounce = () => {
          pending.reannounceTimer = setTimeout(() => {
            if (!active) {
              return;
            }
            sendClientRequest();
            nextReannounceIntervalMs = Math.min(
              nextReannounceIntervalMs * 2,
              MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS,
            );
            scheduleReannounce();
          }, nextReannounceIntervalMs);
        };
        scheduleReannounce();
      }
    });
  }

  private resolveClientRequest(id: ZCodeProtocolRequestId, result: unknown): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    try {
      pending.resolve(pending.resultSchema.parse(result));
    } catch (error) {
      pending.reject(
        error instanceof Error ? error : new Error(`Invalid response: ${pending.method}`),
      );
    }
  }

  private rejectClientRequest(id: ZCodeProtocolRequestId, error: Error): void {
    const key = String(id);
    const pending = this.pendingClientRequests.get(key);
    if (!pending) {
      return;
    }
    this.cleanupClientRequest(pending);
    pending.reject(error);
  }

  // [资源] 统一释放：timeout、reannounceTimer、abort 监听、全部 requestKey。
  // requestKey 可能多个，必须全删（INV-04）。
  // 该函数必须幂等，可能因重发与竞态被多次调用。
  private cleanupClientRequest<T>(pending: PendingClientRequest<T>): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.reannounceTimer) {
      clearTimeout(pending.reannounceTimer);
    }
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    // 同一 pending 因重发会登记多个 requestKey，必须全部删除，避免 Map 残留。
    for (const requestKey of pending.requestKeys) {
      this.pendingClientRequests.delete(requestKey);
    }
    pending.requestKeys.clear();
  }
}
