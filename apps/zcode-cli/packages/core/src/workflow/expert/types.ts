/**
 * ============================================================================
 * workflow/expert/types.ts —— expert 工作流的对外契约类型（纯声明，无实现）
 * ============================================================================
 *
 * 【定位】只描述 runtime 门面、runtime-context、phase-runner 之间的形状：
 * agent runner 端口、依赖注入、命令参数与命令结果。改字段即改跨模块契约，
 * 需要同步 prompts/phase-runner 与外部调用方，不涉及任何运行时行为。
 *
 * 【通用口径】
 *   - 命令参数都要求 cwd：store 按 cwd 分桶定位 run 目录，缺 cwd 无法查找。
 *   - abortSignal 会一路穿透到子会话与 store 写入；缺省表示该次操作不可取消。
 *   - 定位 run 时 runId 优先（精确匹配），definitionId 只参与"最近一次"查找
 *     （resolveSnapshot → readLatestRun）。
 *   - 结果中的 response 是给人/模型看的文案，snapshot 才是落库事实；snapshot
 *     为空表示"没找到 run"，不能解读成"run 没有状态"。
 *
 * 【别名段】文件末尾的 Workflow* 别名是历史命名兼容：早期只有 expert 一种
 * 工作流，现统一称谓，新旧符号同源，禁止只在一侧新增字段。
 * ============================================================================
 */

import type {
  ExpertWorkflowRunSnapshot,
  SessionEvent,
  TraceContext,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowRunStatus,
  WorkflowStorePort,
} from "@zcode/contracts";

/**
 * 单次阶段/节点子会话的启动参数。
 *
 * 由 phase-runner 或 scheduled-phase 的 scheduler 适配层构造，最终交给
 * ExpertWorkflowAgentRunner.run。除 prompt/task 外的字段都用于"把子会话归位到
 * 本 run 的账本"：activityId 对齐 snapshot.activities，runId 对齐事件与记录。
 * runner 失败应以抛错表达；phase-runner 会先落盘 failed 状态再把错误上抛。
 */
export interface ExpertWorkflowAgentRunInput {
  // 取消信号：来自 registerRunAbortSignal 的内部 controller（或外部 signal 转发）。
  // 已 abort 时 runner 应尽快抛错，phase-runner 不再写 failed 状态而是原样上抛。
  abortSignal?: AbortSignal;
  // 本次活动 id，必须与 snapshot.activities[].activityId 一致，供失败归因与 session link。
  activityId: string;
  // 子会话工作目录；同时决定 store 的 run 目录分桶。
  cwd: string;
  // 子会话建立后的回调：phase-runner 用它把 sessionId/model/traceId/turnId 回填到
  // activity 并落盘、发 workflow_session_linked。回调抛错会让本次 phase 失败。
  onChildSessionStarted?: (event: ExpertWorkflowChildSessionStartedEvent) => void | Promise<void>;
  // 子会话内部 SessionEvent 的透传通道（给 UI 流式展示），不参与持久化。
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  // 父会话 id，写入 activity.parentSessionId，用于还原子代理嵌套关系。
  parentSessionId?: string;
  // 所属阶段 id；必须在 definition.phaseOrder 内，提示词与事件都据此打标。
  phase: string;
  // 本次子会话的完整提示词，由 prompts.ts 的两个 build* 函数构造。
  prompt: string;
  // 所属 run id；事件、graph record 都挂这个 id。
  runId: string;
  // 用户原始任务文本（原样透传，避免子会话自行臆测目标）。
  task: string;
  // 父 trace 上下文；phase-runner 会在其上 createChildTraceContext 注入
  // workflowPhase/workflowActivityId/workflowRunId 等属性。
  traceContext?: TraceContext;
  // 工作流种类（如 expert），写入事件 kind 供 query/UI 过滤。
  workflowKind?: string;
}

/**
 * 子会话"已建立"回执：只在会话真正创建后发出。
 *
 * 只有 sessionId 必填；model/traceId/turnId 可能尚未确定，缺省时调用方应回退
 * 到 activity 上已有值而不是清空（phase-runner 正是这么合并的）。
 */
export interface ExpertWorkflowChildSessionStartedEvent {
  model?: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

/**
 * 子会话终态结果：response 是阶段产物正文（直接写成 artifact），
 * session/model/trace/turn 用于回填 activity 与 phase 的可观测字段。
 * 不携带 token/成本等计量信息，计量由子会话自身的 session 账本负责。
 */
export interface ExpertWorkflowAgentRunResult {
  model?: string;
  response: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
}

/**
 * 子会话执行端口。
 *
 * core 不关心子会话如何启动（前台/后台/是否复用 TUI），只要求 Promise 语义：
 * resolve 即成功、reject 即失败；不允许用空 response 表示失败（否则会把失败
 * 写成一个"成功但无产物"的阶段）。
 */
export interface ExpertWorkflowAgentRunner {
  run(input: ExpertWorkflowAgentRunInput): Promise<ExpertWorkflowAgentRunResult>;
}

/**
 * runtime 依赖注入。
 *
 * 除 agentRunner/store 外都可缺省：id 与时钟默认 randomUUID/Date.now，便于测试
 * 注入确定性实现。onWorkflowEvent 在事件已落库之后回调，抛错会中断当前流程。
 */
export interface ExpertWorkflowRuntimeDeps {
  // 子会话执行端口；runtime 不持有任何模型/工具实现细节。
  agentRunner: ExpertWorkflowAgentRunner;
  // activity id 生成器；默认 `act_<uuid>`，测试可注入递增序列。
  createActivityId?: () => string;
  // run id 生成器；默认 `wf_<kind>_<uuid>`（kind 经 safeRunIdSegment 归一化）。
  createRunId?: () => string;
  // 工作流定义；缺省用内置 expert 定义，构造时统一过 WorkflowDefinitionSchema。
  definition?: WorkflowDefinition;
  // 时钟注入：所有 timestamp 都经它，单次操作内不会出现多个不一致的 now。
  now?: () => Date;
  // 事件已 append 到 store 之后的回调（UI/投影消费）；抛错会中断当前调用链。
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  // 持久化端口：snapshot / event / graph record / artifact 的唯一写入通道。
  store: WorkflowStorePort;
}

/**
 * 发起一个全新 run 的参数。
 *
 * started 后会立即落盘初始快照与图记录，再进入 continueRun；traceContext 用于
 * 生成子 trace，缺失时最外层 run 事件不带 traceId（不建议，排查链会断）。
 */
export interface ExpertWorkflowRunOptions {
  // 外部取消信号；runtime 会转发到一个内部 controller，cancel 命令也复用该 controller。
  abortSignal?: AbortSignal;
  // 工作目录：决定 store 分桶、子会话 cwd 与快照里的 cwd 字段。
  cwd: string;
  // 期望使用的工作流定义 id；用于校验/定位，不匹配由调用方负责拒绝。
  definitionId?: string;
  // 子会话 SessionEvent 透传（UI 流式）；不会写进 workflow 事件账本。
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  // 父会话 id（可选）：写入初始快照，作为后续 activity.parentSessionId 的来源。
  sessionId?: string;
  // 用户原始任务文本，进入快照并原样注入每个阶段的提示词。
  task: string;
  // trace 上下文：用于创建子 trace；缺失则 run 级事件没有 traceId。
  traceContext?: TraceContext;
  // 工作流种类；仅在自定义 definition 时需要显式给出（事件 kind 取 definition.kind）。
  workflowKind?: string;
}

/**
 * 只读查询参数（status/cancel/resume 等）。
 *
 * runId 有值走精确读取；否则按 cwd + kind 取"最近一次"run。两者都缺时只能拿到
 * 该 cwd 下该 kind 的最新记录，后续操作可能作用到非预期 run。
 */
export interface ExpertWorkflowLookupOptions {
  abortSignal?: AbortSignal;
  cwd: string;
  definitionId?: string;
  runId?: string;
  workflowKind?: string;
}

/**
 * 重试参数：决定"从哪个范围重放"。
 *
 * 优先级 nodeId > activityId > phase > snapshot.failure 的 phase/node > currentPhase。
 * 范围为空时会退化为"该阶段所有 failed/active 节点"。onEvent/traceContext 只影响
 * 重放出的子会话，不改变已有历史。
 */
export interface ExpertWorkflowRetryOptions extends ExpertWorkflowLookupOptions {
  activityId?: string;
  nodeId?: string;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  phase?: string;
  traceContext?: TraceContext;
}

/**
 * 列表参数：limit 透传给 store（语义由 store 决定，通常是"最近 N 条"）。
 */
export interface ExpertWorkflowListOptions {
  abortSignal?: AbortSignal;
  cwd: string;
  definitionId?: string;
  limit?: number;
  workflowKind?: string;
}

/**
 * 事件读取参数：按 runId 读整份 events 账本，limit 由 runtime 侧做尾部截取
 * （取最后 N 条；limit=0 或负数会被 Math.max 归零，实际效果是"不过滤"，返回全部）。
 */
export interface ExpertWorkflowEventsOptions {
  abortSignal?: AbortSignal;
  limit?: number;
  runId: string;
}

/**
 * 命令统一返回。
 *
 * response 始终有值（可能是 "No expert workflow found." 这类提示），调用方应先看
 * snapshot/runId 是否存在再渲染；reportPath 只在 complete 阶段写报告后出现，
 * status 是快照的快照（避免调用方再解析 response 文本）。
 */
export interface ExpertWorkflowCommandResult {
  reportPath?: string;
  response: string;
  runId?: string;
  snapshot?: ExpertWorkflowRunSnapshot;
  status?: WorkflowRunStatus;
  traceId?: string;
}

/**
 * 单阶段执行结果：response 是阶段产物正文（用于播种图/更新节点 prompt），
 * snapshot 是已落盘的最新事实（phase 已置 completed/failed）。
 */
export interface ExpertPhaseRunResult {
  response: string;
  snapshot: ExpertWorkflowRunSnapshot;
}

// 历史命名兼容出口：旧调用方仍使用 Workflow* 前缀，两侧指向同一类型。
// 新增字段应只改 Expert* 定义，别名会自动继承，避免两套类型定义漂移。
export type WorkflowAgentRunInput = ExpertWorkflowAgentRunInput;
export type WorkflowAgentRunResult = ExpertWorkflowAgentRunResult;
export type WorkflowAgentRunner = ExpertWorkflowAgentRunner;
export type WorkflowRuntimeDeps = ExpertWorkflowRuntimeDeps;
export type WorkflowRunOptions = ExpertWorkflowRunOptions;
export type WorkflowLookupOptions = ExpertWorkflowLookupOptions;
export type WorkflowRetryOptions = ExpertWorkflowRetryOptions;
export type WorkflowListOptions = ExpertWorkflowListOptions;
export type WorkflowEventsOptions = ExpertWorkflowEventsOptions;
export type WorkflowCommandResult = ExpertWorkflowCommandResult;
