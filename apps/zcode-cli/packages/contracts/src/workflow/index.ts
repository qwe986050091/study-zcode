// ============================================================
// Workflow Contracts —— durable workflow run（expert 工作流）的运行时契约
// ============================================================
//
// 【定位】把 run 快照、阶段/节点/活动/会话链接、事件与图记录固化成 zod schema，
// 读写两侧都做运行时校验，使调度器恢复、UI 展示与落盘事实使用同一份词汇。
//
// 【生产者】core/src/workflow 的 ExpertWorkflowRuntime（start/resume/retry/cancel）、
// WorkflowGraphScheduler 与 lifecycle 纯函数；【消费者】adapters 的 NodeWorkflowStore
// （events.jsonl / graph.jsonl / run.json / index.json）以及 app 层的 run 列表与状态投影。
//
// 【不变量】snapshot.schemaVersion 固定为 1；时间戳一律 ISO 字符串；artifact/report
// 路径相对 run 根目录；events 与 graph 记录只追加，run.json 是可重建的派生快照。
// WorkflowDefinition 在建 run 时落库，恢复时按同一 schema 读回，避免代码升级后
// 旧 run 的策略/阶段语义漂移。脚本工作流（agent() 调用的持久化）见 ./script.ts。
// ============================================================

import { z } from "zod";

export * from "./script.js";

// 工作流家族标识（当前内置为 "expert"）。写进 snapshot.kind、event.kind 与
// index.json 的 run 行，listRuns 按 kind 过滤；扩充新家族时必须保持既有值稳定，
// 否则历史 run 会在列表与恢复入口被静默过滤掉。
export const WorkflowKindSchema = z.string().min(1);
// 家族标识的类型镜像，只能来自上面的 schema，不允许另行手写字符串字面量。
export type WorkflowKind = z.infer<typeof WorkflowKindSchema>;

// 阶段 id，必须与 WorkflowDefinition.phases[].phase 及 phaseOrder 严格一致。
// 落库后复用于 snapshot.currentPhase、阶段快照、节点 phase 与事件 phase；
// 不做大小写或别名归一，重命名等同于破坏历史 run 的阶段引用。
export const WorkflowPhaseIdSchema = z.string().min(1);
// 阶段 id 的类型镜像，取值来源与校验规则完全由上面的 schema 决定。
export type WorkflowPhaseId = z.infer<typeof WorkflowPhaseIdSchema>;

// run 级生命周期状态。completed/failed/cancelled 是终态，恢复入口据此短路；
// paused 表示调度器停止派发（错误阈值或死锁），快照仍可 resume；
// pending 是创建后未开始的初始态，running 由 start/resume/retry 写入。
export const WorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
// run 状态的类型镜像；判断终态请用枚举值比较，不要按字符串前缀或文本匹配。
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

// 节点状态，同时复用于阶段快照与活动快照（三者共享同一生命周期词汇）。
// 调度器只把 cancelled/completed/failed/skipped 视为依赖已终结；active/pending
// 不是终态，恢复时 active 会被 reconcile 重置为 pending 以便重放。
export const WorkflowNodeStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
// 节点/阶段/活动共用的状态类型镜像，跨三者传递时无需再做枚举转换。
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatusSchema>;

// 可探索集合（collection）的调度状态：active 可继续派发/规划，draining 表示不再
// 新增节点、等待收尾，exhausted 表示不再规划。写入 collection 记录与调度派生态，
// 是 planner 停止条件的唯一事实来源（不看节点总数推断）。
export const WorkflowGraphCollectionStatusSchema = z.enum(["active", "draining", "exhausted"]);
// 集合状态的类型镜像，供 planner 与派生态分支使用同一取值集合。
export type WorkflowGraphCollectionStatus = z.infer<typeof WorkflowGraphCollectionStatusSchema>;

// 内置 expert 工作流的固定阶段顺序（clarify → … → complete）。这些字面量已随旧
// 快照落库，属于恢复兼容面：只允许在 phaseOrder 末尾追加，不要重命名或复用旧值。
// 阶段行为（agent/scheduled_graph/critic/complete）由 WorkflowPhaseDefinition 决定。
export const ExpertWorkflowPhaseSchema = z.enum([
  "clarify",
  "task_analysis",
  "arch_decompose",
  "env_setup",
  "meta_prompt",
  "exec",
  "final_critic",
  "complete",
]);
// expert 阶段名的类型镜像；与字符串字面量比较时依赖本枚举，避免拼写漂移。
export type ExpertWorkflowPhase = z.infer<typeof ExpertWorkflowPhaseSchema>;

// 调度策略参数，随 WorkflowDefinition 一起落库进 run.json 与 graph meta 记录。
// executor.maxConcurrentLoops / maxConsecutiveErrors 由 WorkflowGraphScheduler 直接读取；
// frontierTarget、maxPlannerRuns 由 collection-planner 消费，reactLoop.maxRounds 限制
// 单个子代理的 ReAct 轮次，finalCritic.maxIterations 限制验收打回次数。
// 调整默认值等于改变旧 run 的恢复行为，必须同步 spec 与兼容性说明。
export const WorkflowStrategySchema = z.object({
  clarify: z.object({
    confidenceThreshold: z.number(),
    maxRounds: z.number().int().positive(),
    minRounds: z.number().int().nonnegative(),
  }),
  executor: z.object({
    drainingChangeHours: z.number().positive(),
    frontierTarget: z.number().int().positive(),
    maxConcurrentLoops: z.number().int().positive(),
    maxConsecutiveErrors: z.number().int().positive(),
    maxPlannerRuns: z.number().int().positive(),
  }),
  finalCritic: z.object({
    maxIterations: z.number().int().positive(),
  }),
  reactLoop: z.object({
    maxRounds: z.number().int().positive(),
  }),
});
// 策略的类型镜像；snapshot.strategy 与 graph meta 记录都按这份结构读写。
export type WorkflowStrategy = z.infer<typeof WorkflowStrategySchema>;

// 历史命名别名：早期只服务 expert 工作流，现统一由 WorkflowStrategy 表达；
// 保留导出仅为兼容既有引用，新代码应使用 WorkflowStrategy。
export const ExpertWorkflowStrategySchema = WorkflowStrategySchema;
// 类型层面的历史别名，与 WorkflowStrategy 完全同源。
export type ExpertWorkflowStrategy = WorkflowStrategy;

// 阶段派发行为：agent 跑固定子会话，scheduled_graph 进入图调度器，critic 跑验收
// 评审（可打回节点），complete 收尾写报告并置完成。由 core 的 phase-runner 分发，
// 持久化在定义里，恢复时按定义而非按当前代码默认值决定行为。
export const WorkflowPhaseBehaviorSchema = z.enum([
  "agent",
  "scheduled_graph",
  "critic",
  "complete",
]);
// 阶段行为的类型镜像，phase-runner 的 switch 分支以它为准。
export type WorkflowPhaseBehavior = z.infer<typeof WorkflowPhaseBehaviorSchema>;

// 从阶段产物播种执行阶段图：targetPhase 是图归属阶段，gateAfterPhase 是允许播种
// 的最早前置阶段（产物在 gate 之后才可被消费）。产物解析出 WorkflowGraphSeed，
// 经 applyWorkflowGraphSeed 校验重复节点/未知边/自环/成环后才进入 snapshot.graph。
export const WorkflowGraphSeedSourceSchema = z.object({
  gateAfterPhase: WorkflowPhaseIdSchema.optional(),
  targetPhase: WorkflowPhaseIdSchema,
});
// 播种来源的类型镜像，字段语义与定义落库值一一对应。
export type WorkflowGraphSeedSource = z.infer<typeof WorkflowGraphSeedSourceSchema>;

// 单个阶段的定义：artifactPath 相对 run 目录，description/title 供 prompt 与 UI；
// seedGraphFromArtifact / nodePromptsFromArtifact 表示该阶段产物会驱动后续图的节点
// 播种或 prompt 更新（解析失败视为该阶段失败，不静默忽略）；
// behavior 默认 agent。phase 必须出现在 phaseOrder 中，由定义 schema 统一校验。
export const WorkflowPhaseDefinitionSchema = z.object({
  artifactPath: z.string().optional(),
  behavior: WorkflowPhaseBehaviorSchema.default("agent"),
  description: z.string().min(1),
  nodePromptsFromArtifact: z
    .object({
      targetPhase: WorkflowPhaseIdSchema,
    })
    .optional(),
  phase: WorkflowPhaseIdSchema,
  seedGraphFromArtifact: WorkflowGraphSeedSourceSchema.optional(),
  title: z.string().min(1),
});
// 阶段定义的类型镜像，定义仓库与 runtime 的 phase map 都由它派生。
export type WorkflowPhaseDefinition = z.infer<typeof WorkflowPhaseDefinitionSchema>;

// 工作流定义：建 run 时先 parse 再持久化，恢复时 NodeWorkflowDefinitionStore 用同一
// schema 读回并校验 definitionId 与文件名一致。superRefine 强制 phases 无重复、
// phaseOrder 无重复/未知项，且每个 phase 都出现在 phaseOrder 中，避免"定义可读但
// 调度器无从排序"的半坏状态；definitionVersion 用于区分同 id 的语义版本。
export const WorkflowDefinitionSchema = z
  .object({
    definitionId: z.string().min(1),
    definitionVersion: z.string().min(1),
    description: z.string().optional(),
    kind: WorkflowKindSchema,
    phaseOrder: z.array(WorkflowPhaseIdSchema).min(1),
    phases: z.array(WorkflowPhaseDefinitionSchema).min(1),
    strategy: WorkflowStrategySchema,
    title: z.string().min(1),
  })
  .superRefine((definition, context) => {
    const seenPhases = new Set<string>();
    for (const phase of definition.phases) {
      if (seenPhases.has(phase.phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workflow phase definition: ${phase.phase}`,
          path: ["phases"],
        });
      }
      seenPhases.add(phase.phase);
    }

    const seenOrder = new Set<string>();
    for (const phase of definition.phaseOrder) {
      if (seenOrder.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workflow phase order entry: ${phase}`,
          path: ["phaseOrder"],
        });
      }
      seenOrder.add(phase);
      if (!seenPhases.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflow phaseOrder references unknown phase: ${phase}`,
          path: ["phaseOrder"],
        });
      }
    }

    for (const phase of seenPhases) {
      if (!seenOrder.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflow phase definition is missing from phaseOrder: ${phase}`,
          path: ["phases"],
        });
      }
    }
  });
// 定义的类型镜像；运行时只按已落库的定义执行，不回读代码常量覆盖。
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// 阶段/节点产物元数据。path 相对 run 根目录（writeArtifact 会 normalize 并拒绝越界
// 路径），createdAt 为 ISO 字符串；phase 可选，缺失表示 run 级产物（如 report）。
// 同一 path 重复写入时由 addArtifact 去重并保留最新一条，因此 artifacts 是"当前
// 产物清单"而不是追加日志。contentType 供 UI 选择渲染方式。
export const WorkflowArtifactSchema = z.object({
  contentType: z.string(),
  createdAt: z.string(),
  label: z.string(),
  path: z.string(),
  phase: WorkflowPhaseIdSchema.optional(),
});
// 产物元数据的类型镜像；调用方只消费路径与展示信息，不直接读 artifact 内容。
export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>;

// 阶段进度投影：status 复用节点状态词汇；startedAt/completedAt/error 记录该阶段
// 最近一次执行；sessionId/turnId/traceId/activityId 指到子会话与 trace，供 UI 跳转
// 与排障。artifactPath 是该阶段产物（相对 run 目录）。恢复时 active 阶段会被重置为
// pending 并写入 error 说明原因，避免新进程继续等待已消失的执行体。
export const WorkflowPhaseSnapshotSchema = z.object({
  artifactPath: z.string().optional(),
  activityId: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  startedAt: z.string().optional(),
  status: WorkflowNodeStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
// 阶段快照的类型镜像，snapshot.phases 与生命周期变换函数共用它。
export type WorkflowPhaseSnapshot = z.infer<typeof WorkflowPhaseSnapshotSchema>;

// 活动类型：普通 agent 会话，以及图调度中的 planner/subplanner/actor/critic 子会话。
// 参与 sessionLink 的作用域与 attempt 计数（scope 里包含 kind），也用于分类展示；
// 新增取值会改变历史活动的去重口径，需同步 deriveWorkflowSessionLinks 与 UI 分组。
export const WorkflowActivityKindSchema = z.enum([
  "agent_session",
  "planner_agent",
  "subplanner_agent",
  "actor_agent",
  "critic_agent",
]);
// 活动类型的类型镜像，活动快照与调度器派发逻辑共享同一枚举。
export type WorkflowActivityKind = z.infer<typeof WorkflowActivityKindSchema>;

// 子会话链接状态：starting/running/retrying_model/waiting_permission 是进行中，
// completed/failed/cancelled 是终态。由 deriveWorkflowSessionLinks 从活动状态映射
// （active→running、skipped→cancelled、pending→starting），供 UI 显示子会话当前
// 是在等模型重试还是等权限，而不是只有"在跑/没在跑"两种。
export const WorkflowSessionLinkStatusSchema = z.enum([
  "starting",
  "running",
  "retrying_model",
  "waiting_permission",
  "completed",
  "failed",
  "cancelled",
]);
// 会话链接状态的类型镜像，UI 与恢复逻辑按枚举值判断终态。
export type WorkflowSessionLinkStatus = z.infer<typeof WorkflowSessionLinkStatusSchema>;

// 失败归一化分类，用于恢复建议与 UI 文案。必须由失败发生边界（provider/tool/
// 权限/取消等）显式归类，不依赖错误文本匹配；cancelled 表示用户或上层主动取消，
// unknown 是兜底值。分类决定 recoveryActions 的候选集，改变枚举需同步失败归类逻辑。
export const WorkflowFailureKindSchema = z.enum([
  "network",
  "rate_limit",
  "timeout",
  "auth",
  "provider",
  "model_context",
  "configuration",
  "permission",
  "tool",
  "cancelled",
  "unknown",
]);
// 失败分类的类型镜像；结构化比较用枚举值，不要解析 message 文本。
export type WorkflowFailureKind = z.infer<typeof WorkflowFailureKindSchema>;

// 结构化的 run 级失败事实：kind 是稳定分类，message 可展示；recoverable 表示当前
// 状态还能否继续推进（例如可换模型重试的 provider 错误），retryable 表示同一操作
// 能否原样重试，两者不等价。activityId/nodeId/phase/sessionId/turnId/traceId 定位
// 失败点，missing 时表示失败发生在 run 级（如定义读取失败）。
export const WorkflowFailureSchema = z.object({
  activityId: z.string().optional(),
  code: z.string().optional(),
  kind: WorkflowFailureKindSchema,
  message: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  recoverable: z.boolean(),
  retryable: z.boolean(),
  sessionId: z.string().optional(),
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
// 失败事实的类型镜像；snapshot.failure 只在非正常结束时存在。
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;

// 面向用户的恢复动作选项（是候选，不是已执行动作）：retry 用原模型重跑、
// retry_with_current_model 在模型变更后重跑、skip_node 跳过失败节点、cancel 终止 run。
// destructive 提示该动作会丢弃已完成节点成果；label 直接作为 UI 按钮文案，
// activityId/nodeId/phase 指明动作作用范围。
export const WorkflowRecoveryActionSchema = z.object({
  action: z.enum(["retry", "retry_with_current_model", "skip_node", "cancel"]),
  activityId: z.string().optional(),
  destructive: z.boolean().optional(),
  label: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema.optional(),
});
// 恢复动作的类型镜像；snapshot.recoveryActions 缺省为空数组，表示无可选项。
export type WorkflowRecoveryAction = z.infer<typeof WorkflowRecoveryActionSchema>;

// 活动到子会话的持久链接：attempt 是同一 phase+node+kind 作用域内的第几次尝试
// （由 deriveWorkflowSessionLinks 按 activities 数组顺序递增），parentSessionId 支持
// 嵌套子代理，runId 保证跨 run 不串。sessionId 可选：活动尚未建立会话时只有占位
// 链接，UI 不应据此假定子会话已存在。
export const WorkflowSessionLinkSchema = z.object({
  activityId: z.string(),
  attempt: z.number().int().positive(),
  completedAt: z.string().optional(),
  kind: WorkflowActivityKindSchema,
  model: z.string().optional(),
  nodeId: z.string().optional(),
  parentSessionId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  runId: z.string(),
  sessionId: z.string().optional(),
  startedAt: z.string(),
  status: WorkflowSessionLinkStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
// 会话链接的类型镜像；snapshot.sessionLinks 是活动快照的派生投影，不是独立事实源。
export type WorkflowSessionLink = z.infer<typeof WorkflowSessionLinkSchema>;

// 一次活动（通常是一个子会话/agent 调用）的快照：status 复用节点状态词汇，
// inputArtifactPaths/outputArtifactPaths 记录读写的产物（相对 run 目录），
// startedAt/completedAt 为 ISO；同一 activityId 重复写入由 upsertActivity 覆盖为最新。
// kind 决定它是 planner/actor/critic 中的哪类，model 记录实际使用的模型。
export const WorkflowActivitySnapshotSchema = z.object({
  activityId: z.string(),
  artifactPath: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  inputArtifactPaths: z.array(z.string()).default([]),
  kind: WorkflowActivityKindSchema,
  model: z.string().optional(),
  nodeId: z.string().optional(),
  outputArtifactPaths: z.array(z.string()).default([]),
  parentSessionId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  startedAt: z.string(),
  status: WorkflowNodeStatusSchema,
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
// 活动快照的类型镜像；恢复时只重置 active 活动，终态活动保持原样供审计。
export type WorkflowActivitySnapshot = z.infer<typeof WorkflowActivitySnapshotSchema>;

// 调度图节点：kind=phase 是阶段占位，kind=task 是实际执行单元；dependsOn 与显式边
// 共同构成入边（deriveWorkflowSchedulerState 取并集去重）；attempts 记录执行次数，
// reopenAttempts 记录 critic 打回次数（受策略上限约束，取消/恢复不会清空历史）。
// status 是唯一权威进度位；collectionId 可选，集合归属由集合 nodeIds 与节点字段共同
// 表达，派生时取并集。
export const WorkflowGraphNodeSchema = z.object({
  collectionId: z.string().optional(),
  id: z.string(),
  attempts: z.number().int().nonnegative().optional(),
  dependsOn: z.array(z.string()).default([]),
  description: z.string().optional(),
  error: z.string().optional(),
  kind: z.enum(["phase", "task"]).default("phase"),
  phase: WorkflowPhaseIdSchema.optional(),
  prompt: z.string().optional(),
  reopenAttempts: z.number().int().nonnegative().optional(),
  status: WorkflowNodeStatusSchema,
  title: z.string(),
});
// 图节点的类型镜像；调度、生命周期变换与快照持久化都复用它。
export type WorkflowGraphNode = z.infer<typeof WorkflowGraphNodeSchema>;

// 有向依赖边（from 完成后才解锁 to）。与 node.dependsOn 冗余但语义一致：
// 派生调度态时两者合并去重，播种时额外校验自环、未知端点与成环。
export const WorkflowGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});
// 依赖边的类型镜像；graph.jsonl 的 edge 记录与播种结果共用它。
export type WorkflowGraphEdge = z.infer<typeof WorkflowGraphEdgeSchema>;

// 可探索集合：planner 围绕 goal/metric 持续扩张的子图分区。nodeIds 是显式成员，
// 节点自身 collectionId 也会被并入（派生时取并集）；frontierTarget 是期望保持的在飞
// 节点数，plannerRuns/errorCount 是预算与失败计数，exhausted 表示不再规划。
// analyzedNodeIds 记录已参与分析的节点，避免同一节点被反复分析。
export const WorkflowGraphCollectionSchema = z.object({
  analyzedNodeIds: z.array(z.string()).optional(),
  collectionId: z.string(),
  errorCount: z.number().int().nonnegative().optional(),
  exhausted: z.boolean().optional(),
  explorable: z.boolean().optional(),
  frontierTarget: z.number().int().positive().optional(),
  goal: z.string().optional(),
  lastCompletionAt: z.string().optional(),
  lastGraphChangeAt: z.string().optional(),
  metric: z.string().optional(),
  nodeIds: z.array(z.string()).optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  plannerRuns: z.number().int().nonnegative().optional(),
  status: WorkflowGraphCollectionStatusSchema.optional(),
  title: z.string().optional(),
});
// 集合的类型镜像；collection 记录、派生态与图快照共享同一结构。
export type WorkflowGraphCollection = z.infer<typeof WorkflowGraphCollectionSchema>;

// run 的完整图快照（节点 + 边 + 可选集合），随 run.json 持久化。恢复、调度状态推导
// 与 UI 图视图都以它为唯一输入，不直接解析 graph.jsonl 的内部记录格式；
// collections 可缺省（旧 run 或纯阶段图）。
export const WorkflowGraphSchema = z.object({
  collections: z.array(WorkflowGraphCollectionSchema).optional(),
  edges: z.array(WorkflowGraphEdgeSchema),
  nodes: z.array(WorkflowGraphNodeSchema),
});
// 图的类型镜像；deriveWorkflowSchedulerState 的输入即此结构。
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

// planner LLM 输出的节点草案：只描述 id/title/prompt/dependsOn/collectionId，
// 不携带 status/attempts（执行态由 applyWorkflowGraphSeed 初始化为 pending）。
// kind 默认 task：planner 产出的是任务，而不是阶段占位。
export const WorkflowGraphPlannerNodeSchema = z.object({
  collectionId: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  description: z.string().optional(),
  id: z.string(),
  kind: z.enum(["phase", "task"]).default("task"),
  phase: WorkflowPhaseIdSchema.optional(),
  prompt: z.string().optional(),
  title: z.string(),
});
// planner 节点的类型镜像，同样用于播种产物里的节点描述。
export type WorkflowGraphPlannerNode = z.infer<typeof WorkflowGraphPlannerNodeSchema>;

// planner 一轮的输出：nodes/edges 默认空数组；collectionNodeIds 限定本轮归属集合；
// exhausted 表示 planner 认为集合已无可扩展项，调度器据此停止继续规划。
// reasoning 仅用于诊断展示，不参与调度判断。
export const WorkflowGraphPlannerResultSchema = z.object({
  collectionNodeIds: z.array(z.string()).optional(),
  edges: z.array(WorkflowGraphEdgeSchema).default([]),
  exhausted: z.boolean().optional(),
  nodes: z.array(WorkflowGraphPlannerNodeSchema).default([]),
  reasoning: z.string().optional(),
});
// planner 输出的类型镜像；解析失败的输出按本轮规划失败处理，不静默降级为空结果。
export type WorkflowGraphPlannerResult = z.infer<typeof WorkflowGraphPlannerResultSchema>;

// 从阶段产物播种的集合草案：nodeIds 默认空数组，实际成员还会并入节点侧
// collectionId 匹配的节点；phase 缺省时由调用方注入当前阶段。explorable 决定该集合
// 是否交给 planner 继续扩张。
export const WorkflowGraphSeedCollectionSchema = z.object({
  collectionId: z.string(),
  explorable: z.boolean().optional(),
  frontierTarget: z.number().int().positive().optional(),
  goal: z.string().optional(),
  metric: z.string().optional(),
  nodeIds: z.array(z.string()).default([]),
  phase: WorkflowPhaseIdSchema.optional(),
  title: z.string().optional(),
});
// 播种集合的类型镜像；applyWorkflowGraphSeed 会补齐 phase 并校验成员存在。
export type WorkflowGraphSeedCollection = z.infer<typeof WorkflowGraphSeedCollectionSchema>;

// 阶段产物播种的完整图：applyWorkflowGraphSeed 会拒绝重复节点/集合、引用未知端点的
// 边、自环与成环，并为节点补 status=pending、phase=当前阶段、kind 默认 task。
// reasoning 只做诊断。播种是"增量合并"：已存在的节点/集合不会被覆盖。
export const WorkflowGraphSeedSchema = z.object({
  collections: z.array(WorkflowGraphSeedCollectionSchema).default([]),
  edges: z.array(WorkflowGraphEdgeSchema).default([]),
  nodes: z.array(WorkflowGraphPlannerNodeSchema).default([]),
  reasoning: z.string().optional(),
});
// 播种图的类型镜像；生命周期函数与阶段产物解析共用它。
export type WorkflowGraphSeed = z.infer<typeof WorkflowGraphSeedSchema>;

// critic/阶段产物对节点 prompt 的更新项：refine 要求至少带 prompt/description/title
// 之一，避免空更新；id 必须是图中已存在节点，且节点归属阶段需与更新目标阶段一致
// （否则 applyWorkflowNodePromptUpdates 会报错而不是跨阶段改 prompt）。
export const WorkflowNodePromptUpdateSchema = z
  .object({
    description: z.string().min(1).optional(),
    id: z.string().min(1),
    prompt: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .refine(
    (update) =>
      update.description !== undefined || update.prompt !== undefined || update.title !== undefined,
    {
      message: "Workflow node prompt update must include prompt, description, or title",
    },
  );
// 节点 prompt 更新项的类型镜像；同 id 重复出现在一批更新中会被拒绝。
export type WorkflowNodePromptUpdate = z.infer<typeof WorkflowNodePromptUpdateSchema>;

// 一批节点 prompt 更新，nodes 默认空数组；applyWorkflowNodePromptUpdates 对空集合
// 直接返回 changed=false，既不写快照也不发事件。
export const WorkflowNodePromptUpdateSetSchema = z.object({
  nodes: z.array(WorkflowNodePromptUpdateSchema).default([]),
  reasoning: z.string().optional(),
});
// 更新集合的类型镜像；阶段产物解析失败按阶段失败处理。
export type WorkflowNodePromptUpdateSet = z.infer<typeof WorkflowNodePromptUpdateSetSchema>;

// critic 打回建议的严重度：critical/major/minor，用于展示与排序；
// 是否真正重开节点由 reopenProposals 加 maxReopens 决定，severity 本身不触发动作。
export const WorkflowCriticSeveritySchema = z.enum(["critical", "major", "minor"]);
// critic 严重度的类型镜像；仅在 critic 结果与 UI 之间传递。
export type WorkflowCriticSeverity = z.infer<typeof WorkflowCriticSeveritySchema>;

// critic 建议重开的节点：nodeId 必填且需存在于图中，reason 会写入节点 error 供追溯；
// severity 可选，缺省不参与排序。真正重开受 maxReopens 约束，超限时 critic 失败而不是
// 无限打回。
export const WorkflowCriticReopenProposalSchema = z.object({
  nodeId: z.string().min(1),
  reason: z.string().min(1),
  severity: WorkflowCriticSeveritySchema.optional(),
});
// 重开建议的类型镜像；critic-loop 消费它调用 reopenWorkflowGraphNode。
export type WorkflowCriticReopenProposal = z.infer<typeof WorkflowCriticReopenProposalSchema>;

// critic 本轮结论：verdict=pass/fail 必须显式给出（不提供默认值，避免"缺字段即通过"）；
// acceptanceGaps 是未满足的验收点，reopenProposals 是建议重开的节点。
// reasoning 默认空串，仅用于展示与诊断。
export const WorkflowCriticResultSchema = z.object({
  acceptanceGaps: z.array(z.string()).default([]),
  reasoning: z.string().default(""),
  reopenProposals: z.array(WorkflowCriticReopenProposalSchema).default([]),
  verdict: z.enum(["pass", "fail"]),
});
// critic 结论的类型镜像；critic-loop 据此决定继续重开还是结束阶段。
export type WorkflowCriticResult = z.infer<typeof WorkflowCriticResultSchema>;

// durable run 文档（run.json）：schemaVersion 固定 1，是恢复兼容的唯一版本标识。
// graph 是完整聚合，phases/activities/sessionLinks 是投影（sessionLinks 由活动派生后
// 随快照写入，不是独立事实源）。strategy 随 run 落库，保证恢复时使用建 run 时的参数
// 而不是当前代码默认值；failure/recoveryActions/pauseReason 记录终止或暂停原因；
// reportPath 相对 run 目录。读取端（NodeWorkflowStore.readRun）与写入端都做 parse，
// 阻止半坏 JSON 进入调度循环。
export const WorkflowRunSnapshotSchema = z.object({
  activities: z.array(WorkflowActivitySnapshotSchema).default([]),
  artifacts: z.array(WorkflowArtifactSchema),
  completedAt: z.string().optional(),
  createdAt: z.string(),
  currentPhase: WorkflowPhaseIdSchema.optional(),
  cwd: z.string(),
  definitionId: z.string().min(1).optional(),
  definitionVersion: z.string().min(1).optional(),
  graph: WorkflowGraphSchema,
  kind: WorkflowKindSchema,
  phaseOrder: z.array(WorkflowPhaseIdSchema),
  phases: z.array(WorkflowPhaseSnapshotSchema),
  failure: WorkflowFailureSchema.optional(),
  pauseReason: z.string().optional(),
  reportPath: z.string().optional(),
  recoveryActions: z.array(WorkflowRecoveryActionSchema).default([]),
  runId: z.string(),
  schemaVersion: z.literal(1),
  sessionId: z.string().optional(),
  sessionLinks: z.array(WorkflowSessionLinkSchema).default([]),
  startedAt: z.string().optional(),
  status: WorkflowRunStatusSchema,
  strategy: WorkflowStrategySchema,
  task: z.string(),
  traceId: z.string().optional(),
  updatedAt: z.string(),
});
// run 快照的类型镜像；生命周期纯函数以它为输入输出（TSnapshot extends 它）。
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;

// 历史命名别名：早期只有 expert 工作流，现统一为 WorkflowRunSnapshot；
// 保留导出仅为兼容既有引用，新旧符号共享同一份校验规则。
export const ExpertWorkflowRunSnapshotSchema = WorkflowRunSnapshotSchema;
// 快照类型的历史别名，与 WorkflowRunSnapshot 完全同源。
export type ExpertWorkflowRunSnapshot = WorkflowRunSnapshot;

// 事件类型词汇：run/阶段/节点/图/planner/critic 各层级的生命周期与进度。
// 生产者为 ExpertWorkflowRuntime、WorkflowGraphScheduler 与 collection-planner/critic-loop；
// 写入 events.jsonl 后不可修改，消费方（onWorkflowEvent → UI/projection）必须容忍未知
// payload 字段；新增类型只追加，不复用旧值的语义。
export const WorkflowEventTypeSchema = z.enum([
  "run_started",
  "run_completed",
  "run_failed",
  "workflow_paused",
  "workflow_retry_started",
  "workflow_session_linked",
  "run_cancelled",
  "phase_started",
  "phase_completed",
  "phase_failed",
  "artifact_written",
  "graph_updated",
  "node_started",
  "node_completed",
  "node_failed",
  "frontier_changed",
  "executor_paused",
  "executor_completed",
  "planner_started",
  "planner_completed",
  "planner_failed",
  "graph_expanded",
  "collection_exhausted",
  "critic_started",
  "critic_passed",
  "critic_failed",
  "node_reopened",
  "critic_iteration_limit_reached",
]);
// 事件类型的类型镜像；调度器 emitEvent 与 UI 分支都以它为准。
export type WorkflowEventType = z.infer<typeof WorkflowEventTypeSchema>;

// 事件信封：runId+timestamp(ISO)+type 是跨进程定位键；payload 为 record<unknown>，
// 具体形状由 type 决定（本 schema 不做联合校验，避免一次收紧把历史 payload 打回）；
// kind/phase/nodeId 是冗余索引，便于按 run/阶段/节点过滤。事件流 append-only，
// 消费方不得依赖事件 id 的稳定性。
export const WorkflowEventSchema = z.object({
  kind: WorkflowKindSchema,
  message: z.string().optional(),
  nodeId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  phase: WorkflowPhaseIdSchema.optional(),
  runId: z.string(),
  timestamp: z.string(),
  type: WorkflowEventTypeSchema,
});
// 事件信封的类型镜像；appendEvent 会先 parse 再写 JSONL。
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

// graph.jsonl 的追加记录（discriminatedUnion by recordType）：
// meta 记录建 run 时的定义版本、phaseOrder、strategy 与 schemaVersion，是恢复时重建
// 调度参数的权威来源；node/edge/collection 记录图结构的增量；op 记录状态迁移与
// graph_expanded 等操作（可带 nodeIds/edgeIds 便于回放）。消费方按追加顺序回放，
// 不能假设"任意截断后仍能得到一致图"。
export const WorkflowGraphRecordSchema = z.discriminatedUnion("recordType", [
  z.object({
    recordType: z.literal("meta"),
    createdAt: z.string(),
    definitionId: z.string().min(1).optional(),
    definitionVersion: z.string().min(1).optional(),
    phaseOrder: z.array(WorkflowPhaseIdSchema),
    runId: z.string(),
    schemaVersion: z.literal(1),
    strategy: WorkflowStrategySchema,
  }),
  z.object({
    recordType: z.literal("node"),
    node: WorkflowGraphNodeSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    recordType: z.literal("edge"),
    edge: WorkflowGraphEdgeSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    recordType: z.literal("collection"),
    collection: WorkflowGraphCollectionSchema,
    runId: z.string(),
    timestamp: z.string(),
  }),
  z.object({
    collectionId: z.string().optional(),
    edgeIds: z.array(z.string()).optional(),
    recordType: z.literal("op"),
    nodeId: z.string().optional(),
    nodeIds: z.array(z.string()).optional(),
    phase: WorkflowPhaseIdSchema.optional(),
    payload: z.record(z.unknown()).optional(),
    runId: z.string(),
    status: WorkflowNodeStatusSchema.optional(),
    timestamp: z.string(),
    type: z.string(),
  }),
]);
// 图记录的类型镜像；appendGraphRecord 与回放逻辑共用同一判别联合。
export type WorkflowGraphRecord = z.infer<typeof WorkflowGraphRecordSchema>;

// 由图派生出的节点调度视图（不持久化）：incoming 是 dependsOn 与入边的并集，
// blockedBy 只保留"依赖缺失或未终结"的入边，ready=pending 且无阻塞；
// collectionIds 是集合显式成员与节点 collectionId 的并集。派生结果随图变化重算，
// 不写入 snapshot。
export const WorkflowSchedulerDerivedNodeSchema = z.object({
  blockedBy: z.array(z.string()),
  collectionIds: z.array(z.string()).default([]),
  incoming: z.array(z.string()),
  node: WorkflowGraphNodeSchema,
  outgoing: z.array(z.string()),
  ready: z.boolean(),
});
// 派生节点的类型镜像；调度器用来判断 ready/blocked，不参与持久化。
export type WorkflowSchedulerDerivedNode = z.infer<typeof WorkflowSchedulerDerivedNodeSchema>;

// 派生出的集合状态：frontier = 该集合内 active + pending 节点数（不是节点总数），
// 用于和 frontierTarget 比较决定是否继续规划；exhausted/status 来自 collection 记录，
// errorCount/plannerRuns 缺省补 0。派生值不回写 collection，避免与持久事实分叉。
export const WorkflowSchedulerCollectionStateSchema = z.object({
  activeNodeIds: z.array(z.string()),
  collection: WorkflowGraphCollectionSchema,
  completedNodeIds: z.array(z.string()),
  errorCount: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  failedNodeIds: z.array(z.string()),
  frontier: z.number().int().nonnegative(),
  frontierTarget: z.number().int().positive().optional(),
  pendingNodeIds: z.array(z.string()),
  plannerRuns: z.number().int().nonnegative(),
  readyNodeIds: z.array(z.string()),
  status: WorkflowGraphCollectionStatusSchema,
});
// 派生集合状态的类型镜像；planner 与派生态按同一份 frontier 口径判断。
export type WorkflowSchedulerCollectionState = z.infer<
  typeof WorkflowSchedulerCollectionStateSchema
>;

// 派生态的"正在执行的活动"投影：只保留定位所需字段（activityId/phase/sessionId/
// turnId/traceId/nodeId），不复制 prompt/result 等大字段，避免高频派生态膨胀。
export const WorkflowSchedulerActiveActivitySchema = z.object({
  activityId: z.string(),
  nodeId: z.string().optional(),
  phase: WorkflowPhaseIdSchema,
  sessionId: z.string().optional(),
  traceId: z.string().optional(),
  turnId: z.string().optional(),
});
// 活动投影的类型镜像；run 级派生态的 activeActivities 用它表达。
export type WorkflowSchedulerActiveActivity = z.infer<typeof WorkflowSchedulerActiveActivitySchema>;

// run 级派生调度态：counts 按节点状态统计，blockedNodes/readyNodeIds 直接来自图派生；
// 纯图派生时 activeActivities/activeChildSessionIds 为空，由
// deriveWorkflowRunSchedulerState 用快照活动补齐。该结构仅供展示/决策，不入库。
export const WorkflowSchedulerStateSchema = z.object({
  activeActivities: z.array(WorkflowSchedulerActiveActivitySchema),
  activeChildSessionIds: z.array(z.string()),
  activeNodeIds: z.array(z.string()),
  blockedNodes: z.array(
    z.object({
      blockedBy: z.array(z.string()),
      nodeId: z.string(),
    }),
  ),
  counts: z.object({
    active: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  collectionStates: z.array(WorkflowSchedulerCollectionStateSchema).default([]),
  nodes: z.array(WorkflowSchedulerDerivedNodeSchema),
  readyNodeIds: z.array(z.string()),
});
// 派生调度态的类型镜像；core 的调度器与快照派生都从这里取字段。
export type WorkflowSchedulerState = z.infer<typeof WorkflowSchedulerStateSchema>;

// 依赖"已终结"的唯一判定集合：skipped/cancelled 也算完成，因此它们会解锁下游；
// active/pending 不在集合内，依赖它们的节点保持 blocked。不要按"非 failed 即可"
// 之类的反推写法扩展，否则 deadlock 判定会失真。
const TERMINAL_DEPENDENCY_STATUSES = new Set<WorkflowNodeStatus>([
  "cancelled",
  "completed",
  "failed",
  "skipped",
]);

// 纯函数：把图（节点 + 边 + 集合）推导成调度视图，不做 I/O，也不读持久化事件。
// 关键口径：入边 = dependsOn ∪ edges，去重后作为 incoming；依赖不存在或状态不在
// TERMINAL_DEPENDENCY_STATUSES 时进入 blockedBy；只有 pending 且无阻塞才算 ready。
// 集合成员 = collection.nodeIds ∪ 节点侧 collectionId 匹配项；frontier 计 active+pending。
// 调用方（core 调度器派发/死锁判定与快照派生）必须看到同一份 ready 口径。
export function deriveWorkflowSchedulerState(graph: WorkflowGraph): WorkflowSchedulerState {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incomingById = new Map<string, string[]>();
  const outgoingById = new Map<string, string[]>();

  for (const node of graph.nodes) {
    incomingById.set(node.id, [...node.dependsOn]);
    outgoingById.set(node.id, []);
  }

  for (const edge of graph.edges) {
    incomingById.set(edge.to, [...(incomingById.get(edge.to) ?? []), edge.from]);
    outgoingById.set(edge.from, [...(outgoingById.get(edge.from) ?? []), edge.to]);
  }

  const collections = graph.collections ?? [];
  const collectionIdsByNodeId = new Map<string, string[]>();
  for (const collection of collections) {
    for (const nodeId of collection.nodeIds ?? []) {
      const collectionIds = collectionIdsByNodeId.get(nodeId) ?? [];
      collectionIds.push(collection.collectionId);
      collectionIdsByNodeId.set(nodeId, collectionIds);
    }
  }
  for (const node of graph.nodes) {
    if (!node.collectionId) continue;
    const collectionIds = collectionIdsByNodeId.get(node.id) ?? [];
    if (!collectionIds.includes(node.collectionId)) {
      collectionIds.push(node.collectionId);
      collectionIdsByNodeId.set(node.id, collectionIds);
    }
  }

  const nodes = graph.nodes.map((node) => {
    const incoming = [...new Set(incomingById.get(node.id) ?? [])];
    const blockedBy = incoming.filter((dependencyId) => {
      const dependency = nodesById.get(dependencyId);
      return !dependency || !TERMINAL_DEPENDENCY_STATUSES.has(dependency.status);
    });
    return {
      blockedBy,
      collectionIds: collectionIdsByNodeId.get(node.id) ?? [],
      incoming,
      node,
      outgoing: [...new Set(outgoingById.get(node.id) ?? [])],
      ready: node.status === "pending" && blockedBy.length === 0,
    };
  });

  const activeNodeIds = nodes
    .filter((entry) => entry.node.status === "active")
    .map((entry) => entry.node.id);
  const blockedNodes = nodes
    .filter((entry) => entry.node.status === "pending" && entry.blockedBy.length > 0)
    .map((entry) => ({ blockedBy: entry.blockedBy, nodeId: entry.node.id }));
  const readyNodeIds = nodes.filter((entry) => entry.ready).map((entry) => entry.node.id);
  const collectionStates = collections.map((collection) => {
    const nodeIds = [
      ...new Set([
        ...(collection.nodeIds ?? []),
        ...graph.nodes
          .filter((node) => node.collectionId === collection.collectionId)
          .map((node) => node.id),
      ]),
    ];
    const activeCollectionNodeIds = nodeIds.filter(
      (nodeId) => nodesById.get(nodeId)?.status === "active",
    );
    const pendingNodeIds = nodeIds.filter((nodeId) => nodesById.get(nodeId)?.status === "pending");
    const completedNodeIds = nodeIds.filter(
      (nodeId) => nodesById.get(nodeId)?.status === "completed",
    );
    const failedNodeIds = nodeIds.filter((nodeId) => nodesById.get(nodeId)?.status === "failed");
    const readyCollectionNodeIds = readyNodeIds.filter((nodeId) => nodeIds.includes(nodeId));
    return {
      activeNodeIds: activeCollectionNodeIds,
      collection,
      completedNodeIds,
      errorCount: collection.errorCount ?? 0,
      exhausted: collection.exhausted ?? false,
      failedNodeIds,
      frontier: activeCollectionNodeIds.length + pendingNodeIds.length,
      frontierTarget: collection.frontierTarget,
      pendingNodeIds,
      plannerRuns: collection.plannerRuns ?? 0,
      readyNodeIds: readyCollectionNodeIds,
      status: collection.status ?? "active",
    };
  });

  return {
    activeActivities: [],
    activeChildSessionIds: [],
    activeNodeIds,
    blockedNodes,
    counts: {
      active: activeNodeIds.length,
      blocked: blockedNodes.length,
      completed: nodes.filter((entry) => entry.node.status === "completed").length,
      failed: nodes.filter((entry) => entry.node.status === "failed").length,
      pending: nodes.filter((entry) => entry.node.status === "pending").length,
      ready: readyNodeIds.length,
      total: nodes.length,
    },
    collectionStates,
    nodes,
    readyNodeIds,
  };
}

// 在图派生之上叠加快照活动：status=active 的活动转为 activeActivities，其 sessionId
// 去空后成为 activeChildSessionIds（供"还有哪些子会话在跑"的展示与并发控制）。
// 图派生结果原样透传，因此本函数与 deriveWorkflowSchedulerState 的 ready/counts 口径一致。
export function deriveWorkflowRunSchedulerState(
  snapshot: WorkflowRunSnapshot,
): WorkflowSchedulerState {
  const state = deriveWorkflowSchedulerState(snapshot.graph);
  const activeActivities = snapshot.activities
    .filter((activity) => activity.status === "active")
    .map((activity) => ({
      activityId: activity.activityId,
      ...(activity.nodeId ? { nodeId: activity.nodeId } : {}),
      phase: activity.phase,
      ...(activity.sessionId ? { sessionId: activity.sessionId } : {}),
      ...(activity.traceId ? { traceId: activity.traceId } : {}),
      ...(activity.turnId ? { turnId: activity.turnId } : {}),
    }));

  return {
    ...state,
    activeActivities,
    activeChildSessionIds: activeActivities
      .map((activity) => activity.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== undefined),
  };
}

// 把活动列表投影成会话链接（UI 的"子任务树"与恢复时的父/子会话索引）。
// attempt 的 scope 固定为 `phase + (nodeId ?? "phase:<phase>") + kind`，按 activities
// 的数组顺序自增：同一节点同一类活动第一次 attempt=1，重跑/重试撞到同一 scope 就 +1。
// 因此 attempt 只在"活动按时间顺序追加"的前提下稳定；若上游按批次乱序重建 activities，
// attempt 会重新分配，不能当作跨快照的持久标识。status 经
// workflowSessionLinkStatusFromActivity 映射，sessionId/traceId 逐项可选透传。
export function deriveWorkflowSessionLinks(
  snapshot: Pick<WorkflowRunSnapshot, "activities" | "runId">,
): WorkflowSessionLink[] {
  const attemptByScope = new Map<string, number>();
  return snapshot.activities.map((activity) => {
    const scope = [
      activity.phase,
      activity.nodeId ?? `phase:${activity.phase}`,
      activity.kind,
    ].join(":");
    const attempt = (attemptByScope.get(scope) ?? 0) + 1;
    attemptByScope.set(scope, attempt);
    return {
      activityId: activity.activityId,
      attempt,
      ...(activity.completedAt ? { completedAt: activity.completedAt } : {}),
      kind: activity.kind,
      ...(activity.model ? { model: activity.model } : {}),
      ...(activity.nodeId ? { nodeId: activity.nodeId } : {}),
      ...(activity.parentSessionId ? { parentSessionId: activity.parentSessionId } : {}),
      phase: activity.phase,
      runId: snapshot.runId,
      ...(activity.sessionId ? { sessionId: activity.sessionId } : {}),
      startedAt: activity.startedAt,
      status: workflowSessionLinkStatusFromActivity(activity.status),
      ...(activity.traceId ? { traceId: activity.traceId } : {}),
      ...(activity.turnId ? { turnId: activity.turnId } : {}),
    };
  });
}

// 节点状态 → 会话链接状态的唯一映射点：active 叫 running，skipped 与 cancelled 一并
// 归到 cancelled（会话层不区分"跳过了"和"取消了"，两者都不再有子会话产出），
// pending（含未知值兜底）一律 starting。不要在调用处各自写三元表达式，否则多处投影
// 会对同一活动给出不同状态。
function workflowSessionLinkStatusFromActivity(
  status: WorkflowNodeStatus,
): WorkflowSessionLinkStatus {
  switch (status) {
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "skipped":
      return "cancelled";
    case "pending":
    default:
      return "starting";
  }
}

// run 列表项的稳定投影（index.json / listRuns 的返回形状）：只含定位与展示所需字段，
// 不含 graph、activities、artifacts。生产者是 NodeWorkflowStore 建索引时的 upsert，
// 消费者是 app 的 /workflows 列表与"最近一次 run"选取；因此 task 与 cwd 在 list 阶段
// 必须已落盘，状态变更要同步刷新 status/updatedAt，否则列表与 run.json 会不一致。
export interface WorkflowRunListItem {
  completedAt?: string;
  createdAt: string;
  cwd: string;
  kind: WorkflowKind;
  runId: string;
  status: WorkflowRunStatus;
  task: string;
  updatedAt: string;
}

// 工作流持久化端口：core 的 runtime/scheduler 只依赖这组方法，具体落盘格式由 adapters
// 的 NodeWorkflowStore 实现（run.json 原子写、events.jsonl/graph.jsonl 追加、index.json 索引）。
// 关键不变量：appendEvent/appendGraphRecord 是纯追加（顺序即事实顺序，不得改写已有行）；
// writeSnapshot 覆盖 run.json，必须自洽地由事件与图记录可重建；writeArtifact/writeReport
// 只接受相对 run 根的路径且不得越界；readRun/readLatestRun 返回 null 表示不存在而非抛错，
// 以便恢复流程区分"没有 run"与"读坏了"。
export interface WorkflowStorePort {
  appendEvent(event: WorkflowEvent, options?: { signal?: AbortSignal }): Promise<void>;
  appendGraphRecord(
    runId: string,
    record: WorkflowGraphRecord,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  listRuns(
    options?: { cwd?: string; kind?: WorkflowKind; limit?: number },
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunListItem[]>;
  readEvents(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowEvent[]>;
  readLatestRun(
    options?: { cwd?: string; kind?: WorkflowKind },
    signalOptions?: { signal?: AbortSignal },
  ): Promise<WorkflowRunSnapshot | null>;
  readRun(runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowRunSnapshot | null>;
  writeArtifact(
    runId: string,
    relativePath: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeReport(
    runId: string,
    content: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ path: string; relativePath: string }>;
  writeSnapshot(snapshot: WorkflowRunSnapshot, options?: { signal?: AbortSignal }): Promise<void>;
}

// 定义读取端口：run 创建时把 WorkflowDefinition 落库，恢复时按 definitionId 读回同一份
// 阶段顺序/策略，而不是用当前代码里的默认定义覆盖。readDefinition 返回 null 表示该
// 定义不存在（例如跨机器恢复或定义被删除），调用方需据此决定是否拒绝恢复，
// 不得静默回退到内置定义导致旧 run 的阶段语义漂移。
export interface WorkflowDefinitionStorePort {
  listDefinitions(options?: { signal?: AbortSignal }): Promise<WorkflowDefinition[]>;
  readDefinition(
    definitionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowDefinition | null>;
}
