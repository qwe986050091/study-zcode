/**
 * ============================================================================
 * executor/impl.ts —— 工具执行器门面(ToolExecutor 的唯一实现入口)
 * ============================================================================
 *
 * 【在 agent 主循环里的位置】
 *   tools.ts executeTools
 *     └─ ToolExecutorImpl.executeSchedule(本文件)
 *          └─ batch-runner.executeToolSchedule(按 parallelGroups 跑批次)
 *               └─ call-runner.executeToolCall(单工具:校验 → hooks → 权限 → handler)
 *
 * 本类只做"依赖装配 + 方法转发",不包含执行细节:
 *   - 所有外部能力(fileSystem/httpClient/subagent/artifactStore 等)通过 deps 注入,
 *     业务代码不直接触碰底层 I/O;
 *   - executeSchedule 用异步生成器逐批产出 batch_start/batch_complete 事件,
 *     调用方(tools.ts)将它们转成 SessionEvent;
 *   - 权限、hooks、输入校验、超时、并发、后台任务等都在下游 runner/handler 层实现。
 * ============================================================================
 */
import type { TraceContext, TurnId } from "@zcode/contracts";
import { createRootTraceContext } from "@zcode/contracts";
import { createDenyPermissionBroker } from "../../permission/broker.js";
import type { ToolSchedule } from "../scheduler.js";
import type {
  ExecutableToolCall,
  ToolBatchEvent,
  ToolEntry,
  ToolExecutionResult,
} from "../types.js";
import { BackgroundTaskTracker } from "./background-tasks.js";
import { executeToolBatch, executeToolSchedule } from "./batch-runner.js";
import { executeToolCall } from "./call-runner.js";
import { runPreToolUseHooks } from "./hook-flow.js";
import { resolveToolPermission } from "./permission-flow.js";
import type {
  ToolBatchExecuteOptions,
  ToolExecuteOptions,
  ToolExecutor,
  ToolExecutorDeps,
  ToolExecutorOptions,
} from "./types.js";
import { validateInput } from "./validation.js";

/**
 * 工具执行器门面实现。
 * 构造时把一组扁平 options 收拢成 deps(端口/超时/工作目录/并发上限等),
 * 并创建 BackgroundTaskTracker(后台任务的生命周期由它统一跟踪)。
 */
export class ToolExecutorImpl implements ToolExecutor {
  private readonly deps: ToolExecutorDeps;
  private readonly backgroundTasks: BackgroundTaskTracker;

  constructor(options: ToolExecutorOptions) {
    this.deps = {
      agentTelemetry: options.agentTelemetry,
      agentTelemetryActorKind: options.agentTelemetryActorKind,
      registry: options.registry,
      permissionService: options.permissionService,
      // 为什么：缺省 broker 是 deny-all 而不是 allow——没有显式注入审批能力时默认拒绝，
      // 这就是权限链的 fail-closed 基线，不能改成"放行以便调试"。
      permissionBroker: options.permissionBroker ?? createDenyPermissionBroker(),
      emitEvent: options.emitEvent,
      enqueueBackgroundTaskNotification: options.enqueueBackgroundTaskNotification,
      shouldEnqueueBackgroundTaskNotification: options.shouldEnqueueBackgroundTaskNotification,
      sessionId: options.sessionId,
      turnId: options.turnId,
      // 300_000 是工具级超时（毫秒），只作缺省；单个工具可在注册时覆盖。
      defaultTimeoutMs: options.defaultTimeoutMs ?? 300000,
      permissionTimeoutMs: options.permissionTimeoutMs,
      logger: options.logger,
      backgroundTaskControlPort: options.backgroundTaskControlPort,
      executionPort: options.executionPort,
      browserControlPort: options.browserControlPort,
      browserDocumentationRoot: options.browserDocumentationRoot,
      fileSystemPort: options.fileSystemPort,
      httpClientPort: options.httpClientPort,
      imageProcessorPort: options.imageProcessorPort,
      pdfDocumentPort: options.pdfDocumentPort,
      model: options.model,
      embeddedSearchBackend: options.embeddedSearchBackend,
      nativeSearchEnhancementsEnabled: options.nativeSearchEnhancementsEnabled,
      skillPort: options.skillPort,
      subagentPort: options.subagentPort,
      coordinatorResponsePort: options.coordinatorResponsePort,
      workflowSubmitPort: options.workflowSubmitPort,
      workflowEscalatePort: options.workflowEscalatePort,
      artifactStore: options.artifactStore,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      topicResourcePort: options.topicResourcePort,
      sessionStore: options.sessionStore,
      sessionModePort: options.sessionModePort,
      workflowPort: options.workflowPort,
      dynamicWorkflowRunPort: options.dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort: options.dynamicWorkflowSnippetPort,
      modelCatalogPort: options.modelCatalogPort,
      runtimeTaskRegistry: options.runtimeTaskRegistry,
      readFileState: options.readFileState ?? new Map(),
      hasLoadedSkill: options.hasLoadedSkill,
      subagentBackgroundBashMaxMs: options.subagentBackgroundBashMaxMs,
      bashShellSelection: options.bashShellSelection,
      getBashShellSelection: options.getBashShellSelection,
      // 最后兜底 "." 而不是抛错：Bash 等工具在测试/嵌入场景可无 cwd 运行；
      // 真实 CLI 入口一定会传 getWorkingDirectory。
      getWorkingDirectory: options.getWorkingDirectory ?? (() => options.workingDirectory ?? "."),
      setWorkingDirectory: options.setWorkingDirectory,
      // 优先级：显式 getWorkspaceRoot → workspaceRoot → getWorkingDirectory → workingDirectory
      // → "."。workspace root 用于路径归一化与 checkpoint，不能和运行时 cwd 混为一谈。
      getWorkspaceRoot:
        options.getWorkspaceRoot ??
        (() =>
          options.workspaceRoot ??
          options.getWorkingDirectory?.() ??
          options.workingDirectory ??
          "."),
      workspaceIdentity: options.workspaceIdentity,
      remoteSessionId: options.remoteSessionId,
      clientMode: options.clientMode,
      deliveryKind: options.deliveryKind,
      getMemoryRoot: options.getMemoryRoot,
      // 缺省 main：只有 subagent/monitor 等需要区分通知策略的调用方才会覆盖。
      runtimeScope: options.runtimeScope ?? "main",
      traceContext: options.traceContext,
      // 缺省 build：协作模式影响权限与 hook 判定，必须有确定的初始值。
      getMode: options.getMode ?? (() => options.mode ?? "build"),
      // 缺省并发 10：并行组内同时执行的工具上限；带副作用的工具仍由调度层串行化。
      maxConcurrency: options.maxConcurrency ?? 10,
      hookRunner: options.hookRunner,
    };
    this.backgroundTasks = new BackgroundTaskTracker(this.deps);
  }

  /**
   * 复用工具权限链给 MCP App 做"预授权"：校验 → PreToolUse hook → 权限判定，
   * 成功时返回**审批后的执行输入**，不执行 handler、不做模型结果投影。
   *
   * 校验跑两遍：hook 可能 rewrite input，改写后的输入必须再过一次 schema/语义校验，
   * 否则 hook 可以绕过原本的入参约束。
   *
   * 失败语义：全部以抛错表达（校验失败、hook deny/prevent、权限拒绝、signal 已中止），
   * 调用方不会拿到半成品输入。副作用：可能触发审批交互与会话事件；不改 registry。
   */
  async authorizeAppTool(
    toolCall: ExecutableToolCall,
    entry: ToolEntry,
    options?: ToolExecuteOptions,
  ): Promise<unknown> {
    options?.signal?.throwIfAborted();
    const trace =
      options?.traceContext ??
      this.deps.traceContext ??
      createRootTraceContext({ sessionId: this.deps.sessionId });
    const mode = this.deps.getMode();
    const invalid = validateInput(toolCall.input, entry);
    if (invalid) throw new Error(invalid.message);
    const hooks = await runPreToolUseHooks(
      this.deps,
      toolCall,
      toolCall.input,
      entry,
      mode,
      trace,
      options?.signal,
    );
    if (hooks.preventContinuation || hooks.permissionBehavior === "deny")
      throw new Error(hooks.stopReason ?? "Tool denied by host hook");
    const input = hooks.updatedInput ?? toolCall.input;
    const updatedInvalid = validateInput(input, entry);
    if (updatedInvalid) throw new Error(updatedInvalid.message);
    const decision = await resolveToolPermission(
      this.deps,
      toolCall,
      entry,
      input,
      hooks,
      mode,
      trace,
      options?.signal,
    );
    options?.signal?.throwIfAborted();
    if (!decision.allowed)
      throw new Error(decision.result.error?.message ?? "Tool denied by host policy");
    return decision.executionInput;
  }

  /**
   * 执行单个工具调用：把 deps 与共享的 BackgroundTaskTracker 交给 call-runner。
   *
   * 失败不会抛给调用方：call-runner 把所有错误收口成 `ToolExecutionResult`（success=false，
   * 带稳定 error.type/code），保证每个 tool_call 都有配对结果。副作用由工具自身与下游
   * 权限/hook/后台任务层承担；本方法不额外做状态记录。
   */
  execute(
    toolCall: ExecutableToolCall,
    options?: ToolExecuteOptions,
  ): Promise<ToolExecutionResult> {
    return executeToolCall(this.deps, this.backgroundTasks, toolCall, options);
  }

  trackExternalBackgroundTask(
    toolCall: ExecutableToolCall,
    output: Record<string, unknown>,
    traceContext: TraceContext,
    turnId?: TurnId,
  ): Promise<void> {
    // 与 submit 路径同一个 tracker 实例、同一条 trackBackgroundTask：resume 重臂的行为
    // 按构造等于工具启动路径的行为，两条路径不可能漂移（见 ToolExecutor 接口注释）。
    return this.backgroundTasks.trackBackgroundTask(toolCall, output, traceContext, turnId);
  }

  /**
   * 批量执行（同一批次内按 `maxConcurrency` 并行），结果顺序由 batch-runner 保证与入参一致。
   *
   * 该方法不做调度分组；并行组划分是上层 `executeSchedule` / scheduler 的职责。
   * 失败同样以结果对象返回，不抛错。
   */
  executeBatch(
    toolCalls: ExecutableToolCall[],
    options?: ToolBatchExecuteOptions,
  ): Promise<ToolExecutionResult[]> {
    return executeToolBatch(
      this.deps,
      (toolCall, executeOptions) => {
        return this.execute(toolCall, executeOptions);
      },
      toolCalls,
      options,
    );
  }

  /**
   * 执行完整调度:把 batch-runner 的异步生成器原样透传。
   * 生成器产出:batch_start(batch 即将执行)→ batch_complete(batch 结果)→
   * 最终 done 返回全部 ToolExecutionResult。
   * 这样上层可以在 batch 边界做 UI 更新,而不用等全部结束。
   */
  async *executeSchedule(
    toolCalls: ExecutableToolCall[],
    schedule: ToolSchedule,
    options?: ToolBatchExecuteOptions,
  ): AsyncGenerator<ToolBatchEvent, ToolExecutionResult[], void> {
    return yield* executeToolSchedule(
      this.deps,
      (batchToolCalls, batchOptions) => this.executeBatch(batchToolCalls, batchOptions),
      toolCalls,
      schedule,
      options,
    );
  }
}

/**
 * 工具执行器工厂：把扁平 options 交给 ToolExecutorImpl 归一化成 deps。
 *
 * 只做装配，不缓存、不复用实例——每个 runtime/会话应各自创建，避免 tracker 与
 * runtimeTaskRegistry 跨会话串线。返回的接口是 `ToolExecutor`，调用方不依赖实现类。
 */
export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  return new ToolExecutorImpl(options);
}
