import type {
  SessionEvent,
  TraceContext,
  WorkflowEvent,
  WorkflowGraph,
  WorkflowGraphCollection,
  WorkflowGraphCollectionStatus,
  WorkflowGraphNode,
  WorkflowGraphPlannerResult,
  WorkflowGraphRecord,
  WorkflowRunSnapshot,
} from "@zcode/contracts";

/**
 * ============================================================================
 * workflow/scheduler/types.ts —— 图调度器的接口与依赖契约
 * ============================================================================
 *
 * 【定位】只声明类型，不含实现。把"调度器需要什么能力"（Deps）与
 * "子会话 runner 输入/输出什么"（Activity 族与 Planner 族）分开，便于替换与单测。
 *
 * 【失败/取消口径】所有 I/O 型依赖都接受可选 AbortSignal；取消时由实现抛错，
 * 调度器在 abort 已触发时不再把错误计为节点/planner 失败。
 *
 * 【并发口径】run 选项不直接表达并发上限，实际并发来自 snapshot.strategy.executor。
 * ============================================================================
 */

/**
 * 单节点执行 runner 的输入。
 * 含节点、任务、阶段、提示词、run/activity 标识与可选父会话/追踪上下文。
 * onChildSessionStarted 用于把子会话 sessionId/traceId 回写活动；onEvent 透传
 * 子会话的流式事件。abortSignal 取消时 runner 应尽快结束并抛错。
 */
export interface WorkflowGraphSchedulerActivityInput {
  abortSignal?: AbortSignal;
  activityId: string;
  cwd: string;
  node: WorkflowGraphNode;
  onChildSessionStarted?: (
    event: WorkflowGraphSchedulerChildSessionStartedEvent,
  ) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  parentSessionId?: string;
  phase: string;
  prompt: string;
  runId: string;
  task: string;
  traceContext?: TraceContext;
}

/**
 * 单节点 runner 的结果：模型回复正文 + 子会话标识。
 * response 会被写成节点 Markdown 产物；model/sessionId/traceId/turnId 用于活动链接。
 */
export interface WorkflowGraphSchedulerActivityResult {
  model?: string;
  response: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

/**
 * 子会话启动事件：runner 在真正创建子会话后回调，携带 sessionId 与可选追踪字段。
 */
export interface WorkflowGraphSchedulerChildSessionStartedEvent {
  model?: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

/**
 * 节点执行器能力：给定输入返回一次子会话结果。
 * 实现负责真正的 agent 调用；调度器只关心 Promise 的成败。
 */
export interface WorkflowGraphSchedulerRunner {
  run(input: WorkflowGraphSchedulerActivityInput): Promise<WorkflowGraphSchedulerActivityResult>;
}

/**
 * 集合扩张 planner 的输入。
 * 比节点输入多带 collection 与整图 snapshot，让 planner 看到集合边界与现有节点；
 * 其余字段（abortSignal/prompt/runId/traceContext 等）语义同节点执行。
 */
export interface WorkflowGraphSchedulerPlannerInput {
  abortSignal?: AbortSignal;
  activityId: string;
  collection: WorkflowGraphCollection;
  cwd: string;
  graph: WorkflowGraph;
  onChildSessionStarted?: (
    event: WorkflowGraphSchedulerChildSessionStartedEvent,
  ) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  parentSessionId?: string;
  phase: string;
  prompt: string;
  runId: string;
  snapshot: WorkflowRunSnapshot;
  task: string;
  traceContext?: TraceContext;
}

/**
 * planner 一轮的完整结果：解析出的图扩张 + 子会话元数据与原始 response。
 * 原始 response 会先落成 planner 产物文件，再参与图合入。
 */
export interface WorkflowGraphSchedulerPlannerRunResult extends WorkflowGraphPlannerResult {
  model?: string;
  response: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

/**
 * planner 执行器能力：实现通常先跑子会话，再用 parseWorkflowPlannerResult 解析。
 * 解析失败应抛错，让 collection-planner 计入 planner 失败。
 */
export interface WorkflowGraphSchedulerPlannerRunner {
  run(input: WorkflowGraphSchedulerPlannerInput): Promise<WorkflowGraphSchedulerPlannerRunResult>;
}

/**
 * 调度器的外部依赖集合（全部由调用方注入）。
 * appendEvent/appendGraphRecord 负责持久化事实；writeSnapshot/writeArtifact 负责落盘；
 * now/createActivityId 提供确定性时钟与标识；onWorkflowEvent 是实时订阅回调。
 * plannerRunner 可选：缺省时调度器不做集合扩张，完成判定也不等待集合耗尽。
 */
export interface WorkflowGraphSchedulerDeps {
  appendEvent(event: WorkflowEvent, options?: { signal?: AbortSignal }): Promise<void>;
  appendGraphRecord(
    runId: string,
    record: WorkflowGraphRecord,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  createActivityId: () => string;
  now: () => Date;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  plannerRunner?: WorkflowGraphSchedulerPlannerRunner;
  runner: WorkflowGraphSchedulerRunner;
  writeArtifact(
    runId: string,
    relativePath: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeSnapshot(snapshot: WorkflowRunSnapshot, options?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * 一次调度运行的选项。
 * executableNodeIds 限定本次可派发范围（阶段裁剪）；缺省为全图节点。
 * buildPrompt 可覆盖默认节点提示词；artifactDirectory 指定产物根目录（默认
 * artifacts/exec）。parentSessionId/traceContext 用于子会话归属与追踪传播。
 */
export interface WorkflowGraphSchedulerRunOptions {
  abortSignal?: AbortSignal;
  artifactDirectory?: string;
  buildPrompt?: (input: {
    node: WorkflowGraphNode;
    phase: string;
    snapshot: WorkflowRunSnapshot;
  }) => string;
  cwd: string;
  executableNodeIds?: Iterable<string>;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  parentSessionId?: string;
  phase: string;
  snapshot: WorkflowRunSnapshot;
  traceContext?: TraceContext;
}

/**
 * 调度结束结果。
 * reason：completed=全部完成；error_threshold=连续错误达到上限；deadlock=无 ready
 * 也无 active 且仍有阻塞节点。
 * status：completed=正常收尾；paused=因错误阈值或死锁提前停下，可恢复后重跑。
 */
export interface WorkflowGraphSchedulerRunResult {
  reason: "completed" | "deadlock" | "error_threshold";
  snapshot: WorkflowRunSnapshot;
  status: "completed" | "paused";
}

/**
 * started 信号的载荷：节点已写入 active 快照后的快照副本。
 * 调度器据此把本地 snapshot 指针推进到最新，再继续派发其他节点。
 */
export interface NodeRunStarted {
  snapshot: WorkflowRunSnapshot;
}

/**
 * 单节点本轮结算：nodeId + 是否成功 + 结算后的快照。
 * ok=false 不代表抛错；调度器据它累加/清零 consecutiveErrors。
 */
export interface NodeRunOutcome {
  nodeId: string;
  ok: boolean;
  snapshot: WorkflowRunSnapshot;
}

/**
 * 快照访问器：读当前快照、写回新快照并返回它。
 * node-runner 通过它把 active/completed/failed 快照同步给调度循环；
 * 实现是无锁的闭包变量，依赖调度循环串行 await 保证一致性。
 */
export interface WorkflowGraphSchedulerSnapshotAccess {
  getSnapshot(): WorkflowRunSnapshot;
  setSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot;
}

/**
 * 一轮 planner 扩张的应用结果。
 * addedNodes/addedEdges 是本次增量（用于事件与图记录）；collection 是更新后的集合；
 * snapshot 是已合入增量的新快照（调用方负责持久化）。
 */
export interface AppliedPlannerExpansion {
  addedEdges: WorkflowGraphRecordEdge[];
  addedNodes: WorkflowGraphNode[];
  collection: SchedulerCollection;
  snapshot: WorkflowRunSnapshot;
}

/**
 * 图边类型别名，等价于 WorkflowGraph["edges"][number]（from/to）。
 * 调度器内部统一用这个名字，避免各处重复索引类型。
 */
export type WorkflowGraphRecordEdge = WorkflowGraph["edges"][number];

/**
 * 调度器内部使用的集合形态：在原集合上把默认字段收敛为非可选。
 * analyzedNodeIds=已分析完成节点；plannerRuns=累计轮数；errorCount=累计 planner 失败数（成功不清零）；
 * exhausted/status=关闭状态；nodeIds 为 planner 追加的成员（与节点侧 collectionId 取并集）。
 */
export type SchedulerCollection = WorkflowGraphCollection & {
  analyzedNodeIds: string[];
  errorCount: number;
  exhausted: boolean;
  explorable: boolean;
  nodeIds: string[];
  plannerRuns: number;
  status: WorkflowGraphCollectionStatus;
};

/**
 * 节点执行 Promise：正常 await 得到本轮结算；额外挂 started 供调度器在派发后
 * 立即同步 active 快照。started 必然先于 outcome 完成，失败路径也会先 resolve。
 */
export type WorkflowSchedulerNodePromise = Promise<NodeRunOutcome> & {
  started: Promise<NodeRunStarted>;
};
