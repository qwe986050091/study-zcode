// INV-01 节点状态只允许 pending→active→completed|pending|failed 三种迁移：守住位置 updateGraphNode 调用点；改错故障 节点卡在 active 导致整图永不收敛。
// INV-02 started 必须在 active 快照落盘并发出 node_started 之后才 resolve：守住位置 resolveStarted 调用点；改错故障 调度器读到未落盘快照，重放时状态错位。
// INV-03 所有快照写入与事件追加都必须透传 abortSignal：守住位置 writeSnapshot/appendGraphStatus/emitEvent 参数；改错故障 取消后仍在写盘，留下半结算记录。
// INV-04 事件顺序固定 node_started → workflow_session_linked → artifact_written → node_completed：守住位置 主流程 await 序列；改错故障 订阅者按序断言失败，活动时间线倒序。
// INV-05 失败路径只发 node_failed，不再补发 node_completed：守住位置 catch 分支；改错故障 单次失败被计成一次成功，重试口径失真。
// INV-06 attempts 只在非取消失败时累加：守住位置 catch 内 abortSignal 检查之后；改错故障 用户取消被当成失败重试，耗尽 maxAttempts。
// INV-07 nextStatus 达到 maxAttempts 才落 failed，否则回 pending：守住位置 nextStatus 计算；改错故障 首次失败即终态，重试策略失效。
// INV-08 子会话链接事件只写回仍为 active 的活动：守住位置 onChildSessionStarted 前置判断；改错故障 已结算活动被改写，产物与状态不一致。
// INV-09 产物路径必须经 safeArtifactName 归一：守住位置 writeArtifact 第一个参数；改错故障 节点 id 含路径分隔符时写到目录之外。
// INV-10 完成态活动必须带 artifactPath 且输出路径唯一：守住位置 completedSnapshot 的 outputArtifactPaths；改错故障 下游读不到产物，图执行中断。
// INV-11 完成态优先采用 runner 返回的 traceId/sessionId，缺失才回落：守住位置 completedSnapshot 字段展开顺序；改错故障 追踪链断在节点边界。
// INV-12 失败态活动保留已完成阶段的 sessionId/model/traceId：守住位置 currentActivity 条件展开；改错故障 失败归因丢失会话线索。
// INV-13 输入产物路径在节点启动时快照一次，之后不重算：守住位置 inputArtifactPaths 赋值；改错故障 运行期新增产物被冒充成输入。
// INV-14 traceContext 只在父上下文存在时创建子上下文：守住位置 createChildTraceContext 三目；改错故障 无父链时生成孤立 trace，上报断链。
// INV-15 快照更新一律走 upsertActivity 与 updateGraphNode 组合：守住位置 active/completed/failed 三处；改错故障 活动与节点状态各说一套。
// INV-16 每个事件都携带 nodeId 与 phase：守住位置 emitEvent 负载；改错故障 多阶段同图运行时事件无法归位。
// INV-17 返回值 ok=false 而不是抛错（取消除外）：守住位置 catch 末尾 return；改错故障 调度器把可重试失败当成致命异常，整图中止。
// INV-18 started 挂在 promise 上供调用方 await：守住位置 return 前三行赋值；改错故障 调用方拿不到启动信号，同步快照时序失效。
//
// 模块职责：把一个 ready 图节点跑成一次受控子会话，并负责状态图、活动、产物与事件的成对结算。
// 状态所有权：节点状态与活动由本模块写快照并经 snapshotAccess 回灌；调度器只读快照、只决定下一轮派发。
// 阅读顺序：先看 runWorkflowNode 的参数与 started 契约，再读 active 段、runner 调用与完成段，最后看 catch 的重试判定。
import {
  createChildTraceContext,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
} from "@zcode/contracts";
import { WorkflowSchedulerEventLog } from "./events.js";
import { addArtifact, compactWorkflowPayload, updateGraphNode, upsertActivity } from "./graph.js";
import { buildDefaultNodePrompt, safeArtifactName } from "./prompts.js";
import type {
  NodeRunStarted,
  WorkflowGraphSchedulerDeps,
  WorkflowGraphSchedulerRunOptions,
  WorkflowGraphSchedulerSnapshotAccess,
  WorkflowSchedulerNodePromise,
} from "./types.js";

export interface WorkflowNodeRunnerRuntime {
  createActivityId: () => string;
  eventLog: WorkflowSchedulerEventLog;
  runner: WorkflowGraphSchedulerDeps["runner"];
  writeArtifact: WorkflowGraphSchedulerDeps["writeArtifact"];
  writeSnapshot: WorkflowGraphSchedulerDeps["writeSnapshot"];
}

/**
 * ============================================================================
 * workflow/scheduler/node-runner.ts —— 单个图节点的执行与结算
 * ============================================================================
 *
 * 【定位】调度器派发一个 ready 节点时调用：标记 active → 跑 runner 子会话 →
 * 落产物 → 标记 completed；失败则累加 attempts 并决定是重排 pending 还是 failed。
 *
 * 【事件顺序】node_started →（可选 workflow_session_linked）→ artifact_written →
 * node_completed；失败路径只发 node_failed。所有事件先落库再回调订阅者。
 *
 * 【重试口径】maxAttempts 由调度器传入（当前实现传的是 strategy 的
 * maxConsecutiveErrors）。attempts 达到上限才置 failed，否则回到 pending 由
 * 下一轮调度重新派发；取消（abort）不计数，直接向上抛。
 * ============================================================================
 */

/**
 * 启动一个节点的执行，返回带 started 的 Promise。
 * started 在 active 快照写盘并发出 node_started 后 resolve，调度器用它同步快照。
 * 输出 NodeRunOutcome：ok 表示本轮成功；失败时返回 ok=false 而不是抛错，
 * 由调度器累计 consecutiveErrors 并决定暂停；唯一例外是 abortSignal 已触发时抛错。
 * 副作用：写快照、追加状态图记录、发事件、运行子会话、写节点产物文件。
 */
// [并发] 本函数不持有调度器锁：调用方必须保证同一 node.id 不会被并发派发两次。
// 参数 snapshotAccess 是唯一快照出入口，runtime 负责写盘、发事件与产物落盘。
// maxAttempts 由调度器按 strategy 传入，本层不读取任何全局重试配置。
// 返回的 thenable 同时带 started 字段，供调度器在 node_started 之后同步快照。
// [资源] 每次调用都会新建 activityId，活动粒度是「一次派发尝试」而非「一个节点」。
export function runWorkflowNode(
  snapshotAccess: WorkflowGraphSchedulerSnapshotAccess,
  node: WorkflowGraphNode,
  options: WorkflowGraphSchedulerRunOptions,
  maxAttempts: number,
  runtime: WorkflowNodeRunnerRuntime,
): WorkflowSchedulerNodePromise {
  let resolveStarted: (value: NodeRunStarted) => void = () => {};
  const started = new Promise<NodeRunStarted>((resolve) => {
    resolveStarted = resolve;
  });
  // 启动信号独立成 promise，避免调用方为了拿到快照而 await 整轮节点执行。
  // 异步主体立即开始执行，因此 active 结算发生在返回给调用方之前。
  // [并发] started 只会 resolve 一次，重复 resolve 由 Promise 语义天然忽略。
  // [失败路径] 主体内任何异常都不会漏出，catch 统一转成 ok=false 的结算。
  // promise 对象在末尾补 started 字段后返回，类型见 WorkflowSchedulerNodePromise。
  const promise = (async () => {
    const initialSnapshot = snapshotAccess.getSnapshot();
    const activityId = runtime.createActivityId();
    const startedAt = runtime.eventLog.timestamp();
    const inputArtifactPaths = initialSnapshot.artifacts.map((artifact) => artifact.path);
    const traceContext = options.traceContext
      ? createChildTraceContext(options.traceContext, {
          attributes: {
            workflowActivityId: activityId,
            workflowKind: initialSnapshot.kind,
            workflowNodeId: node.id,
            workflowPhase: options.phase,
            workflowRunId: initialSnapshot.runId,
          },
          sessionId: options.traceContext.sessionId,
        })
      : undefined;
    const activeSnapshot = upsertActivity(
      updateGraphNode(initialSnapshot, node.id, {
        error: undefined,
        status: "active",
      }),
      {
        activityId,
        inputArtifactPaths,
        kind: "agent_session",
        nodeId: node.id,
        outputArtifactPaths: [],
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        startedAt,
        status: "active",
        traceId: traceContext?.traceId,
      },
      runtime.eventLog.timestamp(),
    );
    await runtime.writeSnapshot(activeSnapshot, { signal: options.abortSignal });
    snapshotAccess.setSnapshot(activeSnapshot);
    await runtime.eventLog.appendGraphStatus(
      activeSnapshot,
      node.id,
      options.phase,
      "active",
      options.abortSignal,
    );
    await runtime.eventLog.emitEvent(activeSnapshot, "node_started", {
      message: `Node started: ${node.title}`,
      nodeId: node.id,
      phase: options.phase,
      signal: options.abortSignal,
    });
    resolveStarted({ snapshot: activeSnapshot });

    // 从这里进入「已启动」阶段：active 快照与 node_started 均已落盘。
    // [事务] 完成态的图节点更新、活动更新、产物登记三步合并成一次快照写入。
    // 其中任一步抛错都会落到 catch，由重试逻辑决定回 pending 还是 failed。
    // AbortError 不在这里结算：取消由 abortSignal 一路透传，本层只把它抛给调度器。
    try {
      // runner 负责真正的子会话生命周期，本层只提供节点、提示词与追踪上下文。
      // prompt 优先用调用方注入的 buildPrompt，缺省时回落到模板构造。
      // [资源] abortSignal 一路透传，取消会中断子会话而不是等它自然结束。
      // 返回的 model/sessionId/turnId 会写进完成态活动，供界面与遥测关联。
      const result = await runtime.runner.run({
        abortSignal: options.abortSignal,
        activityId,
        cwd: options.cwd,
        node,
        // 子会话在 runner 内部创建后才回调到这里，参数只带会话标识与可选模型。
        // [并发] 回调可能晚于节点结算到达，因此每次都用最新快照重新定位活动。
        // 只更新仍为 active 的活动，已完成或已失败的活动保持原样。
        // 写盘与事件顺序与主流程一致：先写快照，再发 workflow_session_linked。
        // 事件负载走 compactWorkflowPayload，避免把整段会话元数据写进状态图。
        onChildSessionStarted: async (event) => {
          // 只把子会话链接写回仍处于 active 的活动；失败/完成后的迟到事件丢弃，
          // 避免把已结算的活动改写成"又启动了新会话"。
          const latestSnapshot = snapshotAccess.getSnapshot();
          const currentActivity = latestSnapshot.activities.find(
            (activity) => activity.activityId === activityId,
          );
          if (!currentActivity || currentActivity.status !== "active") return;
          const childStartedSnapshot = upsertActivity(
            latestSnapshot,
            {
              ...currentActivity,
              ...(event.model ? { model: event.model } : {}),
              sessionId: event.sessionId,
              traceId: event.traceId ?? currentActivity.traceId,
              turnId: event.turnId ?? currentActivity.turnId,
            },
            runtime.eventLog.timestamp(),
          );
          await runtime.writeSnapshot(childStartedSnapshot, { signal: options.abortSignal });
          snapshotAccess.setSnapshot(childStartedSnapshot);
          await runtime.eventLog.emitEvent(childStartedSnapshot, "workflow_session_linked", {
            message: `Workflow session linked: ${event.sessionId}`,
            nodeId: node.id,
            payload: compactWorkflowPayload({
              activityId,
              model: event.model,
              sessionId: event.sessionId,
              traceId: event.traceId,
              turnId: event.turnId,
            }),
            phase: options.phase,
            signal: options.abortSignal,
          });
        },
        onEvent: options.onEvent,
        parentSessionId: options.parentSessionId,
        phase: options.phase,
        prompt: options.buildPrompt
          ? options.buildPrompt({ node, phase: options.phase, snapshot: activeSnapshot })
          : buildDefaultNodePrompt(activeSnapshot, node, options.phase),
        runId: activeSnapshot.runId,
        task: activeSnapshot.task,
        traceContext,
      });
      // 产物目录默认 artifacts/exec，可由调用方按阶段覆盖。
      // [失败路径] 写盘失败会抛进 catch，节点按重试口径回 pending 或 failed。
      // 返回的 relativePath 是快照里唯一允许持久化的产物标识。
      // 完成态活动同时登记 inputs 与 outputs 两份产物清单，形成可追溯的边。
      const artifact = await runtime.writeArtifact(
        activeSnapshot.runId,
        `${options.artifactDirectory ?? "artifacts/exec"}/${safeArtifactName(node.id)}.md`,
        result.response,
        { signal: options.abortSignal },
      );
      const latestSnapshot = snapshotAccess.getSnapshot();
      const completedSnapshot = addArtifact(
        upsertActivity(
          updateGraphNode(latestSnapshot, node.id, {
            attempts: node.attempts,
            error: undefined,
            status: "completed",
          }),
          {
            activityId,
            artifactPath: artifact.relativePath,
            completedAt: runtime.eventLog.timestamp(),
            inputArtifactPaths,
            kind: "agent_session",
            nodeId: node.id,
            outputArtifactPaths: [artifact.relativePath],
            parentSessionId: options.parentSessionId,
            phase: options.phase,
            ...(result.model ? { model: result.model } : {}),
            sessionId: result.sessionId,
            startedAt,
            status: "completed",
            traceId: result.traceId ?? traceContext?.traceId,
            turnId: result.turnId,
          },
          runtime.eventLog.timestamp(),
        ),
        {
          contentType: "text/markdown",
          createdAt: runtime.eventLog.timestamp(),
          label: node.title,
          path: artifact.relativePath,
          phase: options.phase,
        },
        runtime.eventLog.timestamp(),
      );
      await runtime.writeSnapshot(completedSnapshot, { signal: options.abortSignal });
      snapshotAccess.setSnapshot(completedSnapshot);
      await runtime.eventLog.appendGraphStatus(
        completedSnapshot,
        node.id,
        options.phase,
        "completed",
        options.abortSignal,
      );
      await runtime.eventLog.emitEvent(completedSnapshot, "artifact_written", {
        message: `Artifact written: ${artifact.relativePath}`,
        nodeId: node.id,
        phase: options.phase,
        signal: options.abortSignal,
      });
      await runtime.eventLog.emitEvent(completedSnapshot, "node_completed", {
        message: `Node completed: ${node.title}`,
        nodeId: node.id,
        phase: options.phase,
        signal: options.abortSignal,
      });
      return { nodeId: node.id, ok: true, snapshot: completedSnapshot };
    // [失败路径] 这里承担全部「非取消」失败的结算：累加 attempts、写快照、发 node_failed。
    // 取消检查必须放在累加之前，保证中止不计入重试次数。
    // failed 是终态但仍解锁下游依赖，整图完成判定由调度器另行处理。
    // 失败活动沿用启动时记录的 sessionId/model/traceId，便于跨层归因。
    } catch (error) {
      if (options.abortSignal?.aborted) {
        throw error;
      }
      const attempts = (node.attempts ?? 0) + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 未达上限回到 pending（下一轮调度重派）；达到上限才落 failed 终态。
      // 注意：failed 仍然解锁下游依赖，但不计入"整图完成"。
      const nextStatus: WorkflowNodeStatus = attempts >= maxAttempts ? "failed" : "pending";
      const latestSnapshot = snapshotAccess.getSnapshot();
      const currentActivity = latestSnapshot.activities.find(
        (activity) => activity.activityId === activityId,
      );
      const failedSnapshot = upsertActivity(
        updateGraphNode(latestSnapshot, node.id, {
          attempts,
          error: errorMessage,
          status: nextStatus,
        }),
        {
          activityId,
          completedAt: runtime.eventLog.timestamp(),
          error: errorMessage,
          inputArtifactPaths,
          kind: "agent_session",
          ...(currentActivity?.model ? { model: currentActivity.model } : {}),
          nodeId: node.id,
          outputArtifactPaths: [],
          parentSessionId: options.parentSessionId,
          phase: options.phase,
          ...(currentActivity?.sessionId ? { sessionId: currentActivity.sessionId } : {}),
          startedAt,
          status: nextStatus,
          traceId: currentActivity?.traceId ?? traceContext?.traceId,
          ...(currentActivity?.turnId ? { turnId: currentActivity.turnId } : {}),
        },
        runtime.eventLog.timestamp(),
      );
      await runtime.writeSnapshot(failedSnapshot, { signal: options.abortSignal });
      snapshotAccess.setSnapshot(failedSnapshot);
      await runtime.eventLog.appendGraphStatus(
        failedSnapshot,
        node.id,
        options.phase,
        nextStatus,
        options.abortSignal,
      );
      await runtime.eventLog.emitEvent(failedSnapshot, "node_failed", {
        message: errorMessage,
        nodeId: node.id,
        payload: { attempts, retry: nextStatus === "pending" },
        phase: options.phase,
        signal: options.abortSignal,
      });
      return { nodeId: node.id, ok: false, snapshot: failedSnapshot };
    }
  })() as WorkflowSchedulerNodePromise;
  promise.started = started;
  return promise;
}
