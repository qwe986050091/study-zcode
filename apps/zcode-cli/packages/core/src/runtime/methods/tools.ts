/**
 * ============================================================================
 * tools.ts —— 工具调度/执行的 runtime 适配层
 * ============================================================================
 *
 * 【职责】
 *   把 runtime 的 ToolCall 转成调度器/执行器能理解的输入,再把执行器的流式批次事件
 *   转发成 SessionEvent;它不实现任何具体工具,也不直接做权限判断(权限在 executor 内)。
 *
 *   scheduleTools   → 根据工具的 readOnly/concurrentSafe/sideEffectScope 生成并行分组
 *   executeTools    → 调用 ToolExecutor.executeSchedule,边跑边发 ToolBatchComplete
 *   emitToolScheduledEvents → 为每个工具发 ToolCallScheduled(UI 工具卡片)
 *   emitFileMutationCheckpoint / emitPermissionRequest / resolvePermission
 *                   → 工具生命周期中的副作用事件(文件 checkpoint、权限审批)
 * ============================================================================
 */
import {
  RewindScope,
  SessionEventType,
  getCurrentTraceContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  MessageId,
  PermissionBrokerResult,
  SessionEvent,
  ToolCallId,
  TraceContext,
  ToolCall,
  ToolDependency,
  ToolSchedule,
  ExecutableToolCall,
  ToolExecutionResult,
} from "../deps.js";
import {
  isResolvablePermissionBroker,
  getFileMutationCheckpointCandidate,
  WORKSPACE_CHECKPOINT_CONTENT_TYPE,
  stringifyWorkspaceCheckpointArtifact,
  throwIfTurnAborted,
  createTurnCancelledError,
  isTurnCancellationError,
  findParallelGroupIndex,
  recordTurnFileChange,
} from "../helpers/index.js";
import type {
  PermissionDecisionResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createMcpToolDisplay } from "../../tool/executor/result-display.js";

/**
 * 生成工具执行调度:把每个工具的能力声明转成 ToolDependency,交给 scheduler 分组。
 *
 * 调度只决定"哪些工具可以并行/必须串行",不执行工具、不做权限判断。
 * readOnly 的判定同时要求 metadata.readOnly 为真且 sideEffectScope === "none",
 * 避免"只读但会触碰外部世界"的工具被错误并行。
 */
export async function scheduleTools(
  this: AgentRuntimeInternal,
  toolCalls: ToolCall[],
): Promise<ToolSchedule> {
  const dependencies: ToolDependency[] = toolCalls.map((tc) => {
    const entry = this.registry.get(tc.name);
    const metadata = entry?.metadata;
    const sideEffectScope = entry?.permission?.sideEffectScope ?? metadata?.sideEffectScope;
    return {
      toolCallId: tc.id as ToolCallId,
      toolName: tc.name,
      dependsOn: [],
      readOnly:
        // readOnly 判定必须同时满足 metadata.readOnly && sideEffectScope==="none":
        // 只声明 readOnly 但副作用范围非 none 的工具仍可能有外部影响,不能当作只读调度。
        // 维护不变量#3:权限只能收紧——调度层用更严格的 sideEffectScope 覆盖 metadata 声明,
        // 不允许工具自报 readOnly 就跳过副作用隔离。
        metadata?.readOnly === undefined
          ? undefined
          : metadata.readOnly && sideEffectScope === "none",
      destructive: metadata?.destructive,
      concurrentSafe: metadata?.concurrentSafe,
      sideEffectScope,
    };
  });

  return this.toolScheduler.schedule(dependencies);
}

/**
 * 执行工具调度:消费 ToolExecutor 的异步生成器,把 batch 事件转成 SessionEvent。
 *
 * 执行器返回两种事件:
 *   batch_start    一批工具即将执行(用于把 part 标为 running)
 *   batch_complete 一批工具执行完毕(这里转成 ToolBatchComplete 事件)
 * 生成器 done 时返回全部结果;调用方(turn-tools.ts)负责 settlement。
 */
export async function executeTools(
  this: AgentRuntimeInternal,
  toolCalls: ToolCall[],
  schedule: ToolSchedule,
  options?: ExecuteToolsOptions,
): Promise<ExecuteToolsResult> {
  const executableCalls: ExecutableToolCall[] = toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    input: tc.input,
    modelCallWrapper: tc.modelCallWrapper,
  }));
  // trace 优先用调用方传入的 modelTraceContext;没有则回退当前 AsyncLocalStorage 上下文。
  const traceContext = options?.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;
  const events: SessionEvent[] = [];

  this.logger?.debug("executeTools: executing schedule", {
    toolCalls: executableCalls.length,
    parallelGroups: schedule.parallelGroups.length,
  });

  const generator = this.executor.executeSchedule(executableCalls, schedule, {
    automationTurn: options?.automationTurn,
    offPeakTurn: options?.offPeakTurn,
    signal: options?.signal,
    traceContext,
    subagentModelOverride: options?.subagentModelOverride,
    model: options?.model,
    toolSearch: options?.toolSearch,
  });
  let results: ToolExecutionResult[] = [];

  while (true) {
    const next = await generator.next();
    if (next.done) {
      // 生成器结束:value 是全部工具结果(含取消/失败/权限拒绝)。
      results = next.value;
      break;
    }

    if (next.value.type === "batch_start") {
      // 批次开始:通知调用方(用于把 pending part 更新为 running)。
      await options?.onBatchStart?.(next.value.toolCallIds);
      continue;
    }

    if (next.value.type === "batch_complete") {
      // 批次完成:发 ToolBatchComplete 事件(成功/失败计数供 UI 与统计使用)。
      // 维护不变量#1:批次完成意味着该批所有 tool_call 都已有结果(成功/失败/拒绝),
      // appendEvent 先落库再入数组,保证事件顺序与持久化一致。
      const batchResults = next.value.results;
      const batchCompleteEvent = this.createEvent(
        SessionEventType.ToolBatchComplete,
        {
          toolCallIds: batchResults.map((result) => result.toolCallId as ToolCallId),
          successCount: batchResults.filter((result) => result.success).length,
          errorCount: batchResults.filter((result) => !result.success).length,
        },
        traceContext,
      );
      await this.appendEvent(batchCompleteEvent, traceContext);
      events.push(batchCompleteEvent);
    }
  }

  this.logger?.debug("executeTools: completed", { resultCount: results.length });
  return { results, events };
}

/**
 * 为每个待执行工具发 ToolCallScheduled 事件。
 * 事件里包含依赖、并行分组、是否可并行、MCP 展示信息与完整调度表,
 * 让 UI 在执行前就能渲染工具卡片与"等待/并发"状态。
 * 空名工具会被跳过:它们只用于让模型收到 registry-miss 结果,不建立产品生命周期。
 */
export async function emitToolScheduledEvents(
  this: AgentRuntimeInternal,
  toolCalls: ToolCall[],
  schedule: ToolSchedule,
  assistantMessageId: MessageId,
  traceContext: TraceContext,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const toolCallById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));

  for (const item of schedule.items) {
    const toolCall = toolCallById.get(item.toolCallId as string);
    if (!toolCall) continue;
    if (toolCall.name.trim().length === 0) {
      // 把空名投影成普通字符串再发 scheduled 事件，会与合法同名工具发生身份碰撞。
      // 空名只需要 registry-miss result 完成模型恢复，不建立产品工具生命周期。
      continue;
    }
    const event = this.createEvent(
      SessionEventType.ToolCallScheduled,
      {
        // toolCallId/assistantMessageId 用于把卡片挂回 assistant;
        // dependencies/parallelGroupIndex/canRunParallel 让 UI 展示"等谁/能否并发";
        // display 来自 MCP registry(不是合成名),保证 pending→running→stop 全生命周期可展示;
        // schedule 携带完整分组表,便于前端重放调度顺序。
        toolCallId: item.toolCallId,
        assistantMessageId,
        toolName: toolCall.name,
        input: toolCall.input,
        dependencies: item.dependencies,
        parallelGroupIndex: findParallelGroupIndex(schedule, item.toolCallId),
        canRunParallel: item.canRunParallel,
        // MCP 名称来自 registry discovery，而不是合成的 provider tool name。
        // 在 scheduled 阶段携带，保证 pending/permission/running/stop 全生命周期可展示。
        display: createMcpToolDisplay(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
        schedule: {
          parallelGroups: schedule.parallelGroups,
          executionOrder: schedule.executionOrder,
        },
      },
      traceContext,
    );
    await this.appendEvent(event, traceContext);
    events.push(event);
  }

  return events;
}

/**
 * 若工具结果是"文件突变"(如 Write/Edit),写出 workspace checkpoint artifact 并
 * 发 CheckpointCreated 事件,使用户可以回滚该次修改。
 *
 * 设计约束:
 *   - 只有成功的工具结果才生成 checkpoint;
 *   - checkpoint 是 best-effort:失败只记录 warn,不影响工具结果本身(结果已落库);
 *   - 用户取消时立即终止并抛取消错误,避免在已取消的 turn 里继续写 artifact。
 */
export async function emitFileMutationCheckpoint(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messageId: MessageId;
    result: ToolExecutionResult;
    toolMessageId?: MessageId;
    traceContext: TraceContext;
  },
): Promise<void> {
  if (!this.artifactStore || !options.result.success) return;

  const candidate = getFileMutationCheckpointCandidate(options.result.output);
  if (!candidate) return;

  try {
    throwIfTurnAborted(options.abortSignal);
    // 把"文件修改前后的内容 + patch"写成 artifact(供 rewind 使用);
    // artifactStore 是唯一的外部存储入口,业务层不直接写盘。
    const artifact = await this.artifactStore.writeToolResultArtifact(
      {
        sessionId: this.sessionId,
        turnId: options.traceContext.turnId,
        toolCallId: options.result.toolCallId,
        toolName: options.result.toolName,
        content: stringifyWorkspaceCheckpointArtifact(candidate, options.result),
        contentType: WORKSPACE_CHECKPOINT_CONTENT_TYPE,
        retention: "session",
        trace: options.traceContext,
      },
      { signal: options.abortSignal },
    );
    throwIfTurnAborted(options.abortSignal);

    const event = this.createEvent(
      SessionEventType.CheckpointCreated,
      {
        checkpointId: `checkpoint_${crypto.randomUUID()}`,
        messageId: options.messageId,
        targetMessageId: options.messageId,
        toolMessageId: options.toolMessageId,
        scope: RewindScope.Workspace,
        snapshotRef: artifact.uri,
        diffRef: artifact.uri,
        fileCount: 1,
      },
      options.traceContext,
    );
    await this.appendEvent(event, options.traceContext);
    options.events.push(event);
    recordTurnFileChange(this.currentTurnFileChanges, {
      afterContent: candidate.content,
      beforeContent: candidate.originalFile,
      path: candidate.filePath,
      structuredPatch: candidate.structuredPatch,
      toolName: options.result.toolName,
    });

    this.logger?.debug("Workspace checkpoint created", {
      ...traceContextToLogContext(options.traceContext),
      event: "checkpoint.created",
      fileCount: 1,
      module: "core.runtime",
      status: "completed",
      toolCallId: options.result.toolCallId,
      toolName: options.result.toolName,
    });
  } catch (error) {
    if (isTurnCancellationError(error, options.abortSignal)) {
      throw createTurnCancelledError(error);
    }

    this.logger?.warn("Workspace checkpoint creation failed", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "checkpoint.create.failed",
      filePath: candidate.filePath,
      module: "core.runtime",
      status: "failed",
      toolCallId: options.result.toolCallId,
      toolName: options.result.toolName,
    });
  }
}

/**
 * 发 PermissionRequested 事件:工具需要用户审批时的 UI 入口。
 * 真正的等待/决定由 permission broker 完成;这里只负责事件,不阻塞执行。
 */
export async function emitPermissionRequest(
  this: AgentRuntimeInternal,
  toolCallId: ToolCallId,
  toolName: string,
  riskLevel: string,
): Promise<void> {
  const traceContext = getCurrentTraceContext() ?? this.rootTraceContext;
  const event = this.createEvent(
    SessionEventType.PermissionRequested,
    {
      toolCallId,
      toolName,
      riskLevel: riskLevel as "low" | "medium" | "high" | "critical",
      reason: `Tool ${toolName} requires approval`,
      input: {},
    },
    traceContext,
  );
  await this.appendEvent(event, traceContext);
}

/**
 * 把用户/宿主对权限请求的决定送回 broker,并补发 PermissionResolved 事件。
 * 若 broker 已能直接 resolve(通常说明请求仍在等待),则不再重复发事件;
 * 否则(例如请求已超时/失联)仍以事件形式让 UI 收口,避免悬挂的审批卡。
 */
export async function resolvePermission(
  this: AgentRuntimeInternal,
  toolCallId: ToolCallId,
  decision: PermissionDecisionResult,
): Promise<void> {
  const brokerResult: PermissionBrokerResult = {
    decision: decision.allowed ? "allow" : "deny",
    reason: decision.reason,
    modifiedInput: decision.modifiedInput,
    permissionUpdates: decision.permissionUpdates,
    resolvedAt: new Date(),
  };

  if (isResolvablePermissionBroker(this.permissionBroker)) {
    // broker 仍持有该请求(用户正在确认窗):直接 resolve,由 broker 唤醒等待方;
    // 此时不再重复发事件,避免 UI 出现两个终态。
    // 维护不变量#3:resolvePermission 只把用户/系统决策透传给 broker,不放宽 deny;
    // 若 broker 返回 false(请求已失效),走事件兜底让 UI 收口。
    const resolved = this.permissionBroker.resolvePermission(toolCallId, brokerResult);
    if (resolved) return;
  }

  const traceContext = getCurrentTraceContext() ?? this.rootTraceContext;
  const event = this.createEvent(
    SessionEventType.PermissionResolved,
    {
      toolCallId,
      decision: brokerResult.decision,
      reason: brokerResult.reason,
      modifiedInput: brokerResult.modifiedInput,
    },
    traceContext,
  );
  await this.appendEvent(event, traceContext);
}
