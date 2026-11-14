import {
  createRootTraceContext,
  createTraceId,
  type Logger,
  type LoggerFactory,
  type McpPort,
  type SessionEventStorePort,
  type SessionId,
  type SessionTaskType,
  type SessionStorePort,
  type TraceContext,
} from "@zcode/contracts";
import type { McpTelemetryTracker } from "@zcode/adapters";
import type { WorkspaceHookPolicyProvider } from "@zcode/core";
import type { AccountProviderConfigSnapshot } from "@zcode/provider";
import {
  zcodeProtocolErrorCodes,
  type AppToolSearchMode,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeDeliveryKind,
  type ModelSelection,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolMessage,
  type ZCodeProtocolMethod,
  type ZCodeProtocolNotification,
  type ZCodeProtocolRequest,
  type ZCodeProtocolRequestId,
  type ZCodeProtocolTrace,
  type ZCodeSessionMode,
  type ZCodeSessionPersistence,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeApp, ZCodeAppOptions } from "../app/types.js";
import type { V4InteractionRegistry } from "../zcode-protocol-v4/interaction-registry.js";
import type { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import type { SessionResidentPool, SessionResidentPoolOptions } from "./session-resident-pool.js";
import type { DynamicWorkflowMode } from "@zcode/shared";

/**
 * 协议层可用的参数校验器抽象（zod / 类 zod 均可）。
 * `parse` 成功返回强类型值，失败必须抛错；`parseParams` 依赖该契约转成 -32602。
 */
export interface ParamsSchema<T> {
  parse(input: unknown): T;
}

/**
 * 协议 agent server 的注入依赖。全部为可选/由入口传入，server 不自行读进程全局。
 *
 * 口径：`createZCodeApp` 每个 session 只调用一次（每个 session 独占 app 与 eventStore）；
 * `sessionStore` 与 `mcpPort` 是进程级共享端口；`workspaceHookPolicyProvider` 由受信 Host
 * 管理，workspace/project 配置不得覆盖它（安全顺序）。`syncAccountProviderConfig` /
 * `refreshProviderRegistry` 只影响进程 Provider Registry，不改变已绑定 session 的模型选择。
 * 测试可注入 `createSessionEventStore`、`sessionResidentPoolOptions` 做确定性对照。
 */
export interface ZCodeProtocolAgentDependencies {
  createZCodeApp(options?: Omit<ZCodeAppOptions, "providerRegistry">): ZCodeApp | Promise<ZCodeApp>;
  /**
   * 每个 session record 的内存 event store 工厂。
   * 默认 turn 窗口保留策略；测试可注入 spy 或 unbounded 实现做对照。
   */
  createSessionEventStore?(sessionId: string): SessionEventStorePort;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  loggerFactory?: LoggerFactory;
  mcpPort?: McpPort;
  /** 资源管理器：`process/childProcesses` 读取 MCP 子进程 pid 与插件归属 */
  mcpTelemetry?: Pick<McpTelemetryTracker, "listProcesses">;
  platform?: NodeJS.Platform | string;
  /** 仅用于构造单个 CLI/app-server 的混合 resident 策略；生产默认值由 pool 定义。 */
  sessionResidentPoolOptions?: SessionResidentPoolOptions;
  /** 兼容旧测试/嵌入调用；新代码应通过 sessionResidentPoolOptions 设置 low-water。 */
  sessionResidentTargetCount?: number;
  sessionStore?: SessionStorePort;
  version?: string;
  /** 受信 Host 管理的 Hook policy；workspace/project 配置不得覆盖。 */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** 把 Host 账号状态形成的第三层 Config Overlay 同步给进程 Registry。 */
  syncAccountProviderConfig?: (snapshot: AccountProviderConfigSnapshot) => Promise<boolean>;
  /** 连接测试前主动重读当前进程的 Config Source 并等待 Registry 发布。 */
  refreshProviderRegistry?: (reason: string) => Promise<void>;
}

// 解析后的依赖：只把「必须有默认实现」的两项从可选提升为必填，
// 其余仍沿用原可选口径；调用方不需要关心默认 eventStore / Hook 策略的来源。
export type ZCodeProtocolAgentResolvedDependencies = ZCodeProtocolAgentDependencies & {
  createSessionEventStore(sessionId: string): SessionEventStorePort;
  workspaceHookPolicyProvider: WorkspaceHookPolicyProvider;
};

/**
 * 每 session 的通知序号状态：`lastSeq` 是该 session 全局递增水位，
 * `seqBySourceEventKey` 记录同一来源事件（如某个 toolCallId/partId）已分配过的序号，
 * 用于 source 事件重放时复用而非重复递增，保证客户端按 seq 去重/排序稳定。
 */
export interface ZCodeProtocolEventSequenceState {
  lastSeq: number;
  seqBySourceEventKey: Map<string, number>;
}

// 记录哪些 toolCallId 已经通过流式通道传过完整 input；后续增量/终态事件据此避免重复下发。
export interface ZCodeProtocolToolInputTransmissionState {
  streamedToolCallIdsWithInput: Set<string>;
}

/**
 * 一个活跃 session 的全部 server 侧状态（内存事实源，不含持久化正文）。
 *
 * 字段口径：
 * - `app`：该 session 独占的 ZCodeApp，MCP/execution/fs 端口与 runtime 都由它持有；
 * - `eventStore`：每个 record 自己的内存事件存储（turn 窗口保留策略）；
 * - `persistence` / `deliveryKind`：session 的落盘方式与投递形态（Cron/Bot 等）；
 *    `deliveryKind` 会被 session/read 写入，因此不能拿它判断“是否已订阅流”；
 * - `workspace`：identity 管隔离/去重，path 管文件执行与 cwd；
 * - `protocolEventSequences` / `stateRevision`：客户端对齐用的序号与乐观并发版本；
 * - `traceContext`：session 级 traceId，子 turn/subagent 继承；
 * - `activeAbortController`：当前执行 turn 的取消句柄（stop 方法用它）；
 * - `residencyFinalizationCount`：后台 runner 释放 ready lock 后的收尾引用计数；
 * - `activeAutomationId` / `activeOffPeakTaskId`：本轮派发身份，防止递归创建；
 * - `restoredModelSelection`：冷恢复的“保存意图”，只用于初始投影，不构成执行绑定。
 */
export interface ZCodeProtocolSessionRecord {
  app: ZCodeApp;
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  nativeSearchEnhancementsEnabled: boolean;
  toolSearchMode: AppToolSearchMode;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  createdAt: number;
  deliveryKind?: ZCodeDeliveryKind;
  /**
   * 旧 session/subscribe 没有 unsubscribe RPC；只在真正 subscribe 时置位，不能用
   * 会被 session/read 写入的 deliveryKind 代替。连接结束会销毁整个 CLI 进程。
   */
  legacyStreamSubscribed?: boolean;
  eventStore: SessionEventStorePort;
  parentSessionId?: SessionId;
  persistence: ZCodeSessionPersistence;
  protocolEventSequences: Map<string, ZCodeProtocolEventSequenceState>;
  protocolToolInputTransmissions: Map<string, ZCodeProtocolToolInputTransmissionState>;
  stateRevision: number;
  taskType?: SessionTaskType;
  traceContext: TraceContext;
  unsubscribe?: () => void;
  updatedAt: number;
  lastOutcome?: "completed" | "interrupted" | "error";
  workspace: ZCodeWorkspaceRef;
  activeAbortController?: AbortController;
  /** background runner 释放 ready lock 后，持久化/snapshot/broadcast 尚未完成的引用计数。 */
  residencyFinalizationCount?: number;
  /** 当前正在执行的 automation 派发 turn；只在 turn 运行期间存在，禁止递归 CronCreate。 */
  activeAutomationId?: string;
  /** 当前正在执行的闲时派发 turn；只在 turn 运行期间存在，禁止递归 OffPeakCreate。 */
  activeOffPeakTaskId?: string;
  /** 当前 Bot 入站 turn 的稳定回推地址；只允许 CronCreate 在本轮读取。 */
  activeBotDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  restoreWarning?: { message: string; type: string };
  /** 冷恢复候选只供初始投影；新的选模事件立即清除，不能替代 Runtime 执行绑定。 */
  restoredModelSelection?: ModelSelection;
}

/**
 * server → client 反向请求的选项。`signal` 取消、`timeoutMs` 超时都以
 * PROTOCOL_CLIENT_REQUEST_ERROR_CODES 的稳定错误码失败；`trace` 让反向请求
 * 与发起它的 session trace 关联；`reannounceIntervalMs` 控制重复投递节奏
 * （客户端可能尚未挂载监听，靠周期性重播提高到达率）。
 */
export interface ZCodeProtocolClientRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  trace?: ZCodeProtocolTrace;
  reannounceIntervalMs?: number;
}

/**
 * 协议 server 的运行时上下文，所有 handler 的共享入口。
 *
 * 所有权/顺序口径：
 * - `sessions` 是本进程活跃 session 的唯一登记表；不在表中的一律视为不可用（或需冷恢复）；
 * - `sessionResidentPool` 负责容量与冷恢复，协议请求须持 operation lease，禁止与回收交错；
 * - `v4Gateway`/`v4Interactions` 是并存的 V4 通道与交互汇合点；gateway 由闭包持有 context，
 *   因此 ctx 先构造、server 构造后立即赋值（故为可选）；
 * - `notify` 是单向 server→client 通知，`requestClient` 是带 id 的反向请求；
 * - `appRuntimePreferences` 是 Host 同步的灰度/门禁，缺省 fail-closed。
 */
export interface ZCodeProtocolAgentServerContext {
  /** 进程退出期间，迟到的异步物化不能重新登记 session。 */
  assertServing?: () => void;
  deps: ZCodeProtocolAgentResolvedDependencies;
  logger?: Logger;
  appRuntimePreferences: {
    askUserQuestionAutoResolutionEnabled: boolean;
    modelIoFullRetentionEnabled: boolean;
    /** host 同步的 Off-Peak 工具面门禁；缺省 false（fail-closed），供 v4 冷恢复等无 host 参数的路径读取。 */
    offPeakToolEnabled: boolean;
    /**
     * host 同步的动态工作流灰度门。
     * 缺省 false（fail-closed）：不认识该方法的旧 Host 或还没来得及同步的启动窗口里，
     * 工作流工具面、`/workflow` 与 dynamic-workflows 技能一律不露出。
     */
    dynamicWorkflowEnabled: boolean;
    /**
     * 与 dynamicWorkflowEnabled 同行到达的灰度 mode（launch.md「On demand: activation」）。
     * 缺席（旧 Host 只发布尔）= alwaysOn；`onDemand` 让 createRecord 写 runtimeConfig.dynamicWorkflowToolsOnDemand。
     */
    dynamicWorkflowMode?: DynamicWorkflowMode;
  };
  // 竖切：v4 conversation 通道（订阅/帧/命令），与旧 session/* 方法并存。
  // 构造顺序问题（gateway 闭包持有 context）用可选字段收口，server 构造完立即赋值。
  v4Gateway?: ConversationV4Gateway;
  // v4 前向命令 resolveInteraction 与反向请求（permission/AskUserQuestion）的汇合点。
  // broker 注册 deferred、v4 命令面投递应答（同一实例经 binder 注入 V4CommandCoreHost）。
  v4Interactions: V4InteractionRegistry;
  // 单 CLI resident session 池。冷恢复入口经 waitForDeactivation 等待旧 app.close 收尾，
  // 协议请求则持有 operation lease，禁止异步 handler 与容量回收交错。
  sessionResidentPool?: SessionResidentPool;
  sessions: Map<string, ZCodeProtocolSessionRecord>;
  /** 仅覆盖异步创建窗口，结束即释放；输入命令仍由 CommandInbox 排队。 */
  sessionCreationIds?: Set<string>;
  notify(notification: ZCodeProtocolNotification): void;
  requestClient<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T>;
}

/** server → client 请求失败的协议错误码；server.ts 抛出，适配层按码翻译，不在业务逻辑中散落字面量。 */
export const PROTOCOL_CLIENT_REQUEST_ERROR_CODES = {
  /** 没有 ZCode Protocol client 挂载，无法投递请求。 */
  noClientAttached: -32020,
  /** 请求在收到应答前被取消。 */
  cancelled: -32021,
  /** 请求等待应答超时。 */
  timedOut: -32022,
} as const;

/**
 * 协议错误载体：`code` 直接作为 JSON-RPC error.code 写出，`data` 承载可诊断上下文。
 * 只在 server 内部抛；transport 不认识它时统一走 toProtocolError。
 */
export class ProtocolRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProtocolRequestError";
  }
}

// 判别式辅助：id+method = 请求（需要应答），method 无 id = 通知（无应答），
// id+result/error = 反向应答。三者互斥，transport 按此分流。
export function isRequest(message: ZCodeProtocolMessage): message is ZCodeProtocolRequest {
  return "method" in message && "id" in message;
}

// 只有 method 没有 id：客户端单向通知，server 不写应答。
export function isNotification(
  message: ZCodeProtocolMessage,
): message is ZCodeProtocolNotification {
  return "method" in message && !("id" in message);
}

// 反向成功应答：id 与 result 同时存在（result 可能为 null，故用 in 判定）。
export function isResponse(
  message: ZCodeProtocolMessage,
): message is { id: ZCodeProtocolRequestId; result: unknown } {
  return "id" in message && "result" in message;
}

// 反向失败应答：id + error，与 result 互斥；由 transport 直接交给 pending 的 requestClient。
export function isErrorResponse(message: ZCodeProtocolMessage): message is {
  id: ZCodeProtocolRequestId;
  error: { code: number; message: string; data?: unknown };
} {
  return "id" in message && "error" in message;
}

/**
 * 从 zod（或类 zod）校验错误里提炼可读的字段级摘要，附到 "Invalid params" 消息里。
 * 原来只回 "Invalid params" 不说哪个字段错，模型（如 browser evaluate 误传函数、
 * 坐标为 NaN 等）无从自纠、会反复瞎试。这里用鸭子类型读 ZodError.issues（不引 zod 依赖），
 * 拼成 `expression: Expected string, received function` 这类可操作提示。
 */
function summarizeParamsError(error: unknown): string | undefined {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return undefined;
  }
  const parts = issues.slice(0, 5).map((issue) => {
    const path =
      Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message ?? "invalid"}`;
  });
  const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : "";
  return parts.join("; ") + more;
}

/**
 * 统一参数校验入口：成功返回强类型参数，失败一律抛 ProtocolRequestError(-32602)。
 * 错误消息附字段级摘要（最多 5 条 issues），让模型能自纠；raw zod error 放进 data。
 * 这是 handler 第一个可失败点，调用方不需要再自行 try/catch 校验。
 */
export function parseParams<T>(schema: ParamsSchema<T>, params: unknown): T {
  try {
    return schema.parse(params);
  } catch (error) {
    const detail = summarizeParamsError(error);
    throw new ProtocolRequestError(
      -32602,
      detail ? `Invalid params — ${detail}` : "Invalid params",
      error,
    );
  }
}

/**
 * 乐观并发校验：客户端若带 expectedRevision，必须等于 record.stateRevision，
 * 否则 -32009 且 data 同时给出期望值与实际值。`undefined` 表示不做校验（老客户端兼容）。
 */
export function assertExpectedRevision(
  record: ZCodeProtocolSessionRecord,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== record.stateRevision) {
    throw new ProtocolRequestError(-32009, "Session state revision mismatch", {
      actualRevision: record.stateRevision,
      expectedRevision,
    });
  }
}

/**
 * 任意异常 → 协议 error 对象（供 server 写 response）。三类处理：
 * ProtocolRequestError 保留 code/data；普通 Error 固定 -32603，但把 name/stack 与
 * 稳定业务 code 放进 data（UI 可据此本地化）；其余值转字符串。
 * 刻意不透传 error.context：上游上下文不保证 JSON-safe，避免错误响应二次失败。
 */
export function toProtocolError(error: unknown): {
  code: number;
  data?: unknown;
  message: string;
} {
  if (error instanceof ProtocolRequestError) {
    return { code: error.code, data: error.data, message: error.message };
  }
  if (error instanceof Error) {
    const businessCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      code: -32603,
      // ModelProtocolError 等业务错误的 code 需要跨 JSON-RPC 保留给 UI。
      // 外层仍是 JSON-RPC internal error，稳定业务 code 放在 data.code 供横幅本地化。
      // 不透传 error.context：上游上下文不保证 JSON-safe，错误响应不能因诊断信息二次失败。
      data: {
        name: error.name,
        stack: error.stack,
        ...(businessCode ? { code: businessCode } : {}),
      },
      message: error.message,
    };
  }
  return {
    code: -32603,
    message: String(error),
  };
}

/**
 * 为一次协议会话生成 root traceId。traceId 位于 sessionId 之上，不能由 sessionId
 * 派生（否则分支/重试无法区分）；复用 contracts 的 UUID 实现保持双端格式一致。
 */
export function createProtocolTraceId(_sessionId: SessionId): TraceContext["traceId"] {
  // Bugfix: traceId 是 session 之上的观测链路，不应由 sessionId 拼出来。
  // 这里复用 agent/contracts 的 UUID 算法，保证 app 和 agent 两端 trace 格式一致。
  return createTraceId();
}

/**
 * 构造 session 的根 trace context。客户端传来 trace 时沿用其 traceId/spanId/parentId，
 * 否则新建。`parentId` 会同时映射为 parentSpanId（协议侧只有单一 parent 概念），
 * 保证跨进程调用链可还原。
 */
export function createProtocolRootTraceContext(
  sessionId: SessionId,
  trace?: ZCodeProtocolTrace,
): TraceContext {
  const context = createRootTraceContext({
    sessionId,
    traceId: (trace?.traceId ?? createProtocolTraceId(sessionId)) as TraceContext["traceId"],
  });
  if (trace?.spanId) {
    context.spanId = trace.spanId;
  }
  if (trace?.parentId) {
    context.parentId = trace.parentId;
    context.parentSpanId = trace.parentId;
  }
  return context;
}

// 反向投影：把内部 TraceContext 收敛回协议只暴露的 trace 字段，
// 缺省字段不写空值，避免客户端把 "undefined" 当作显式父级。
export function protocolTraceFromTraceContext(context: TraceContext): ZCodeProtocolTrace {
  return {
    traceId: context.traceId,
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...((context.parentId ?? context.parentSpanId)
      ? { parentId: context.parentId ?? context.parentSpanId }
      : {}),
  };
}

/**
 * 按 sessionId 取活跃 record；不存在时写 warn 诊断并抛 -32001（sessionUnavailable）。
 * 诊断字段刻意区分「冷会话未恢复」与「ID 已失效」：带 operation、deliveryKind、
 * hasSessionStore、activeSessionCount，便于判断 UI 读早了还是索引带来了脏引用。
 * 注意这里只查内存 sessions，不触发冷恢复——恢复由调用方显式走 pool。
 */
export function requireSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  options: { deliveryKind?: ZCodeDeliveryKind; operation?: string } = {},
): ZCodeProtocolSessionRecord {
  const record = context.sessions.get(sessionId);
  if (!record) {
    // 诊断：readSession 只读取活跃 runtime；记录缺失时要区分“冷会话尚未恢复”和“ID 已失效”，
    // 不能只留下相同的错误文本，否则无法判断 UI 是读早了还是 task index 带来了脏引用。
    context.logger?.warn("ZCode Protocol session runtime missing", {
      activeSessionCount: context.sessions.size,
      event: "zcode_protocol.session.require_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      operation: options.operation ?? "unknown",
      ...(options.deliveryKind ? { deliveryKind: options.deliveryKind } : {}),
      sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session is not active: ${sessionId}`,
    );
  }
  return record;
}

// 创建协议层 logger（module 固定为 bootstrap.zcode_protocol）。
// 未注入 loggerFactory 时返回 undefined，调用点统一用可选链，避免为测试伪造 logger。
export function createProtocolLogger(deps: ZCodeProtocolAgentDependencies): Logger | undefined {
  return deps.loggerFactory?.createLogger("zcode").child({
    module: "bootstrap.zcode_protocol",
  });
}
