/**
 * ============================================================================
 * runtime/helpers/runtime-tools.ts —— 运行时工具面的首次装配（注册表 + hook + executor）
 * ============================================================================
 *
 * 【定位】AgentRuntime 构造阶段调用 initializeRuntimeTooling，一次装配好三样东西：
 *   内置工具注册表、hook runner、tool executor。装配是"按端口在场决定曝光"的纯推导：
 *   每个 deps.xxxPort 是否存在决定对应工具是否注册/透传。
 *
 * 【不变量】工具可见性只在装配时决定一次；后续分支刷新走 methods/embedded-search-branch.ts，
 *   两者必须共用 tool-allowlist.ts 里的同一套推导，否则会出现"刷新后重新注册了已关闭工具"。
 *   browser-use / node_repl 只由 runtimeFeatures 控制，不由端口存在隐式开启。
 *
 * 【不做的事】不执行工具、不处理权限（交给 createToolExecutor）、不写事件表。
 * ============================================================================
 */
import {
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createSessionMailboxHookRegistrations,
  createToolExecutor,
  getCurrentTraceContext,
  registerBuiltInTools,
  traceContextToLogContext,
} from "../deps.js";
import type { HookRunner, SessionId, ToolExecutor, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeDeps } from "../types.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "../methods/embedded-search-branch.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { createRuntimeSessionModePort } from "../session-mode-port.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDisallowedTools,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "./tool-allowlist.js";
import { isStaleBranchRuntimeTaskEvent } from "../methods/runtime-command-generation.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { sessionHasLoadedSkill } from "../../agent/loaded-skills.js";

const DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS = 3_600_000;
const EMPTY_RUNTIME_HOOK_CONFIG = {
  enabled: false,
  events: {},
  maxOutputBytes: 32_768,
  timeoutMs: 60_000,
} as const;

/**
 * runtime 工具面的总装配入口（AgentRuntime 构造期调用一次）。
 *
 * 输入：runtime 实例、外部依赖 deps（端口集合）、sessionId。
 * 输出：{ executor, hookRunner? }。
 * 顺序：先注册内置工具（决定 registry 内容），再建 hook runner（工具事件需要它），
 *   最后建 executor；若宿主已注入 deps.toolExecutor 则直接复用，不再自建。
 * 副作用：注册会改写 runtime.registry（全局可见）；hook runner 可能注册 session mailbox 钩子。
 * 失败语义：不吞异常 —— 装配失败说明 runtime 配置/端口不合法，应让构造过程失败。
 */
export function initializeRuntimeTooling(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): { executor: ToolExecutor; hookRunner?: HookRunner } {
  registerRuntimeBuiltInTools(runtime, deps);
  const hookRunner = createRuntimeHookRunner(runtime, deps, sessionId);
  return {
    executor: deps.toolExecutor ?? createRuntimeToolExecutor(runtime, deps, hookRunner),
    hookRunner,
  };
}

/**
 * 向 runtime.registry 注册内置工具（私有）。
 *
 * 门控口径：除注释里逐项说明的例外，基本遵循"端口在场即注册"；三处特殊：
 *   1) submit_result / escalate 以端口存在为门（与 taskType 无关），因为最可能撞墙的 actor
 *      恰恰是作者没标记的那个；
 *   2) automation / offPeak 在 subagent_child 会话不暴露（子会话不应自行派生任务）；
 *   3) dynamicWorkflow 不能用端口判据 —— 十个工具端口在所有 CLI 都装配齐全，灰度是 Host 的决定。
 * includeNodeRepl / includeBrowserUse 只由 runtimeFeatures 推导，不因 browserControlPort 在场而开启。
 * 副作用：写 runtime.registry；allowedTools / disallowedTools 传入后由注册器做最终求交。
 */
function registerRuntimeBuiltInTools(runtime: AgentRuntimeInternal, deps: AgentRuntimeDeps): void {
  const nodeReplEnabled = runtime.config.runtimeFeatures?.nodeRepl === true;
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    includeSendMessage: runtime.subagentPort?.sendMessage !== undefined,
    includeRespondToCoordinator:
      runtime.config.taskType === "subagent_child" && Boolean(deps.coordinatorResponsePort),
    // submit_result 只在注入了 workflowSubmitPort 的 workflow actor 会话注册。以端口存在为门，
    // 与 taskType 无关：workflow actor 是 workflow_child，其 runtimeScope 目前是 "main"。
    includeSubmitResult: Boolean(deps.workflowSubmitPort),
    // mono 子代理：typed 声明。门仍是端口。
    ...(deps.workflowSubmitSchema === undefined
      ? {}
      : { submitResultSchema: deps.workflowSubmitSchema }),
    // escalate 与 submit_result 同门同理由：端口在场即注册（不做 opt-in：最可能撞墙的 actor 恰是作者没标记的那个）。
    includeEscalate: Boolean(deps.workflowEscalatePort),
    includeWorkflow: Boolean(deps.workflowPort),
    includeAutomation: Boolean(deps.automationPort) && runtime.config.taskType !== "subagent_child",
    // offPeakPort 只在 host 下发 offPeakToolEnabled 时注入（灰度/远程门在 host 端），
    // 端口存在即代表曝光允许；subagent 子会话与 automation 同规则不暴露。
    includeOffPeak: Boolean(deps.offPeakPort) && runtime.config.taskType !== "subagent_child",
    // 动态工作流灰度门：与 off-peak 相反，
    // 这里不能用端口在场做判据——十个工具的端口在任何 CLI 里都装配齐全，灰度是 Host 的决定。
    // 取值收在 tool-allowlist.ts，与分支刷新那个入口共用同一个推导。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime),
    // 修复原因：browserControlPort 只是宿主能力，不应隐式暴露高权限 node_repl。
    // node_repl/browser-use 由 ZCode 官方 browser-use 插件启停推导出的 runtimeFeatures 控制。
    includeNodeRepl: nodeReplEnabled,
    includeBrowserUse: browserUseEnabled,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(runtime),
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // workflow_child 的结构性禁用（CreateWorkflow/SaveWorkflow 因 alwaysAsk 隐形挂起；
    // ResumeWorkflowRun 已免确认但因「child 内不得再编排」仍在列）在 helper
    // 里与 turn 级名单合并，见 tool-allowlist.ts 的根因注释。
    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),
  });
}

/**
 * 创建 hook runner（私有）：按"配置/工作区快照 + executionPort"决定是否启用配置化 runner。
 *
 * 输入：runtime、deps、sessionId。输出：HookRunner 或 undefined（既无配置也无 mailbox 时）。
 * 决策链：
 *   1) 宿主已注入 deps.hookRunner → 直接采用；
 *   2) 否则 config.hooks.enabled 或存在 workspaceHookSnapshot，且 executionPort 在场 →
 *      createConfiguredHookRunner（事件通过 runtime.appendEvent 落库）；
 *   3) 若还有 sessionMailboxPort，则（必要时先建 in-memory runner）注册 mailbox 钩子，
 *      把投递的输入转成 delivery="guide" 的 steer 请求。
 * 副作用：注册钩子会改变 runner 的既有行为；mailbox 输入被拒绝时只打 warn 日志，
 *   不向上抛错（投递失败不应打断会话）。
 * 关键细节：mailbox 的事件回调先过 isStaleBranchRuntimeTaskEvent 过滤，避免把过期分支的事件写进当前表。
 */
function createRuntimeHookRunner(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): HookRunner | undefined {
  let hookRunner =
    deps.hookRunner ??
    ((runtime.config.hooks?.enabled || deps.workspaceHookSnapshot) && deps.executionPort
      ? createConfiguredHookRunner({
          config: runtime.config.hooks ?? EMPTY_RUNTIME_HOOK_CONFIG,
          emitEvent: async (event) => {
            await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
          },
          executionPort: deps.executionPort,
          getWorkingDirectory: () => runtime.workingDirectory,
          logger: runtime.logger,
          workspaceHookAdmission: deps.workspaceHookAdmission,
          workspaceHookSnapshot: deps.workspaceHookSnapshot,
        })
      : undefined);

  if (!deps.sessionMailboxPort) {
    return hookRunner;
  }

  hookRunner ??= createInMemoryHookRunner({
    emitEvent: async (event) => {
      if (isStaleBranchRuntimeTaskEvent(runtime, event)) return;
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    logger: runtime.logger,
  });
  for (const hook of createSessionMailboxHookRegistrations({
    enqueuePendingInput: async (input, traceContext) => {
      const result = await runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: traceContext.turnId,
        input,
        traceContext,
      });
      if (result.kind === "rejected") {
        runtime.logger?.warn("Session mailbox input was not queued", {
          ...traceContextToLogContext(traceContext),
          event: "session.mailbox.queue_rejected",
          module: "core.runtime",
          reason: result.reason,
          status: "completed",
        });
      }
    },
    mailbox: deps.sessionMailboxPort,
    sessionId,
  })) {
    if ("register" in hookRunner && typeof hookRunner.register === "function") {
      hookRunner.register(hook);
    }
  }
  return hookRunner;
}

/**
 * 创建 tool executor（私有）：把 runtime 能力面与 deps 端口逐项透传给 createToolExecutor。
 *
 * 输入：runtime、deps、hookRunner（可能 undefined，工具执行时无 hook 可跑）。
 * 输出：ToolExecutor。
 * 口径要点：
 *   - browserControlPort / browserDocumentationRoot 仅在 browser-use 双门（feature + 端口）全通过时给，
 *     避免宿主只装配了端口就隐式放开浏览器能力；
 *   - hasLoadedSkill 探针只在 skillPort 存在时注入：没有 Skill 工具装不上技能，探针在场只会让门永远关着；
 *   - subagentBackgroundBashMaxMs 仅 subagent_child 生效，主 runtime 传 undefined；
 *   - runtimeScope 由 taskType 推导，决定工具内部对"主/子"语义的分支。
 * 副作用：无（只组装对象）；executor 真正执行的副作用在工具 handler 内。
 */
function createRuntimeToolExecutor(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  hookRunner: HookRunner | undefined,
): ToolExecutor {
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  return createToolExecutor({
    agentTelemetry: runtime.agentTelemetry.port,
    agentTelemetryActorKind: runtime.agentTelemetry.actorKind,
    registry: runtime.registry,
    permissionService: runtime.permissionService,
    permissionBroker: runtime.permissionBroker,
    emitEvent: async (event) => {
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    enqueueBackgroundTaskNotification: (notification) => {
      runtime.enqueueBackgroundTaskNotification(notification);
    },
    shouldEnqueueBackgroundTaskNotification: (input) =>
      shouldEnqueueRuntimeBackgroundTaskNotification(runtime, input),
    logger: runtime.logger,
    backgroundTaskControlPort: {
      stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
    },
    executionPort: deps.executionPort,
    browserControlPort: browserUseEnabled ? deps.browserControlPort : undefined,
    browserDocumentationRoot: browserUseEnabled
      ? runtime.config.runtimeFeatures?.browserDocumentationRoot
      : undefined,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    // 合并删除旧模型连接时曾漏掉此端口；Read 分页渲染与整份 PDF 页数检查仍依赖宿主注入。
    pdfDocumentPort: deps.pdfDocumentPort,
    embeddedSearchBackend: runtime.config.embeddedSearchBackend,
    nativeSearchEnhancementsEnabled: runtime.config.nativeSearchEnhancementsEnabled,
    skillPort: deps.skillPort,
    subagentPort: runtime.subagentPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    artifactStore: deps.artifactStore,
    automationPort: deps.automationPort,
    offPeakPort: deps.offPeakPort,
    topicResourcePort: deps.topicResourcePort,
    sessionStore: deps.sessionStore,
    sessionModePort: createRuntimeSessionModePort(runtime),
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: runtime.runtimeTaskRegistry,
    readFileState: runtime.readFileState,
    // 工作流创作工具的技能门（tool/handlers/workflow-skill-gate.ts）：按模型此刻看得见的历史回答
    // 「读过技能没有」。只在会话真有 Skill 工具时给探针——没有 skillPort 的会话装不上那个技能，
    // 门若仍然在场就成了一道谁也过不去的墙。
    ...(deps.skillPort === undefined
      ? {}
      : {
          hasLoadedSkill: (skillName: string) =>
            sessionHasLoadedSkill(runtime.messageHistory.borrowReadOnlyRuntimeEntries(), skillName),
        }),
    subagentBackgroundBashMaxMs:
      runtime.config.taskType === "subagent_child"
        ? normalizeSubagentBackgroundBashMaxMs(runtime.config.subagents?.backgroundBashMaxMs)
        : undefined,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    hookRunner,
    getWorkingDirectory: () => runtime.workingDirectory,
    setWorkingDirectory: runtime.setWorkingDirectory.bind(runtime),
    getWorkspaceRoot: () => runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity?.toString(),
    remoteSessionId: runtime.config.remoteSessionId,
    clientMode: runtime.config.clientMode,
    deliveryKind: runtime.config.deliveryKind,
    getMemoryRoot: () =>
      deps.memoryRoot ?? resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot),
    runtimeScope: runtime.config.taskType === "subagent_child" ? "subagent" : "main",
    permissionTimeoutMs: runtime.config.permissionTimeoutMs,
    sessionId: runtime.sessionId,
    traceContext: runtime.rootTraceContext,
    getMode: () => runtime.config.mode ?? "build",
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
  });
}

/**
 * browser-use 是否启用（私有）：双门 AND —— runtimeFeatures.browserUse === true 且注入了 browserControlPort。
 *
 * 只在 feature 为 true 时把端口交给 executor；两者缺一即整块能力关闭，
 * 不允许"端口在场"单独成为曝光依据（高权限能力的显式 opt-in 原则）。
 */
function resolveRuntimeBrowserUseEnabled(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): boolean {
  return (
    runtime.config.runtimeFeatures?.browserUse === true && deps.browserControlPort !== undefined
  );
}

/**
 * 判断一条后台任务通知是否应真正入队（私有）。
 *
 * 输入：runtime + 通知输入（status/taskId/toolName/traceContext）。
 * 输出：true = 入队；false = 抑制（并打一条 info 日志说明原因）。
 * 抑制规则：
 *   1) runtime 正在 shutdown —— 通知已无意义，且可能延长进程生命周期；
 *   2) shouldSuppressSealedSubagentBashNotification 判定为"已封口子代理的后台 Bash 通知"：
 *      子会话已终结/结果已被消费，再投递只会产生重复或错序的用户可见消息。
 * 副作用：只写日志，不修改任何状态；漏判/误判不抛错。
 */
function shouldEnqueueRuntimeBackgroundTaskNotification(
  runtime: AgentRuntimeInternal,
  input: {
    status: string;
    taskId: string;
    toolName: string;
    traceContext: TraceContext;
  },
): boolean {
  if (runtime.shuttingDown) {
    runtime.logger?.info?.("Suppressed background task notification during runtime shutdown", {
      ...traceContextToLogContext(input.traceContext),
      event: "runtime.background_task_notification.shutdown_suppressed",
      module: "core.runtime",
      taskId: input.taskId,
      taskStatus: input.status,
      toolName: input.toolName,
    });
    return false;
  }
  const registryTask = runtime.runtimeTaskRegistry.get(input.taskId);
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: runtime.config.taskType === "subagent_child",
      notificationSealed: runtime.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: input.toolName,
    })
  ) {
    return true;
  }
  runtime.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(input.traceContext),
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: runtime.backgroundTaskNotificationSealReason,
    taskId: input.taskId,
    taskStatus: input.status,
    toolName: input.toolName,
  });
  return false;
}

/**
 * 归一化子代理后台 Bash 的超时上限（私有）。
 *
 * 输入：配置值（可能 undefined / NaN / Infinity / 负数）。输出：正整数毫秒值。
 * 降级：任何非法值统一回落到 DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS（1 小时），
 *   并做 floor 截断，保证下游拿到的总是有限整数；不抛错。
 */
function normalizeSubagentBackgroundBashMaxMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS;
  }
  return Math.trunc(value);
}
