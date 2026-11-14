import type { CompactPhase, CompactTrigger } from "../compact/index.js";
import type { SyntheticUserMessageSource } from "../interfaces/session-store.port.js";

/**
 * 遥测事件 Schema 版本号：标识属性/事件字段口径的契约版本。
 *
 * 生产者：本契约包发布；随每个 telemetry 批次/资源上报。
 * 消费者：服务端解析、版本兼容与回放工具。
 * 不变量：字段增删/语义变化必须升级版本；同一版本内不得改变既有字段口径
 * （尤其是 token、阶段、因果字段）。
 */
export const TELEMETRY_SCHEMA_VERSION = 6 as const;

/**
 * agent 执行操作类型（受控字符串枚举），与模型调用用途词表同值。
 *
 * 生产者：runtime 按流程阶段/调用点选择。
 * 消费者：span 的 operation 维度与跨服务聚合报表。
 * 不变量：值发布后不可改名；新增项必须同时出现在 ModelApiOperation 的映射，
 * 否则模型调用与 agent 执行会分裂成两套 operation。
 */
export const AgentTelemetryOperation = {
  AgentStep: "agent_step",
  ContextCompaction: "context_compaction",
  GoalCompletionVerification: "goal_completion_verification",
  GoalTitleGeneration: "goal_title_generation",
  ProjectMemoryExtract: "project_memory_extract",
  ProjectMemoryDream: "project_memory_dream",
  ProjectMemoryRecall: "project_memory_recall",
  ReadSessionContextExtract: "read_session_context_extract",
  ReadSessionContextSynthesize: "read_session_context_synthesize",
  SessionTitleGeneration: "session_title_generation",
  ToolInternalModelCall: "tool_internal_model_call",
  WebFetchProcessing: "web_fetch_processing",
  WebSearch: "web_search",
  WorkspaceGitCommitMessage: "workspace_git_commit_message",
  WorkspaceGenerateText: "workspace_generate_text",
} as const;

/**
 * 上述常量对象的值联合类型。
 *
 * 生产者：常量对象。
 * 消费者：AgentTurn/Detached 等 trace start 的 operation 字段。
 * 不变量：只做分类，不是模型身份或路由键。
 */
export type AgentTelemetryOperation =
  (typeof AgentTelemetryOperation)[keyof typeof AgentTelemetryOperation];

/**
 * agent 发起方分类：主 agent、子代理、workflow child。
 *
 * 生产者：runtime 按 turn 归属标注。
 * 消费者：actorKind 维度、父子 span 与成本分摊。
 * 不变量：workflow child 独立于 subagent；三者都映射到 agent_step。
 */
export type AgentTelemetryActorKind = "main" | "subagent" | "workflow_child";

/**
 * agent 启动渠道：桌面、独立 CLI、远程 web、自动化、bot。
 *
 * 生产者：入口层在创建 turn 时标注。
 * 消费者：launch surface 维度，用于区分交互来源。
 * 不变量：这是入口渠道，不是运行宿主（runtimeSurface 才是进程形态）。
 */
export type AgentTelemetryLaunchSurface =
  | "desktop"
  | "standalone_cli"
  | "web_remote"
  | "automation"
  | "bot";

/**
 * turn 输入来源：真实用户或合成用户消息（系统注入/继续等）。
 *
 * 生产者：turn 创建时由入口层判定。
 * 消费者：turn span 的 input source 维度；用于区分自动触发。
 * 不变量：合成消息不得伪装成 user，否则会污染用户主动输入统计。
 */
export type AgentTelemetryInputSource = "user" | SyntheticUserMessageSource;

/**
 * 遥测身份状态：已认证、匿名、未知，三值互斥。
 *
 * 生产者：身份快照更新。
 * 消费者：span 的 identity 属性与合规统计。
 * 不变量：unknown 不得当作 anonymous 上报。
 */
export type AgentTelemetryIdentityState = "authenticated" | "anonymous" | "unknown";

/**
 * 运行宿主形态：独立 CLI、桌面本地 host、远程 workspace host。
 *
 * 生产者：进程启动探测。
 * 消费者：资源属性与 runtimeSurface 维度。
 * 不变量：与 ModelApiRuntimeSurface 同义但服务于 agent 遥测；不得与 launch
 * surface 混用。
 */
export type AgentTelemetryRuntimeSurface =
  | "standalone_cli"
  | "desktop_local_host"
  | "remote_workspace_host";

/**
 * 失败错误类别：把异构异常归入有限、低基数的分类，供看板与重试决策。
 *
 * 生产者：各 span writer 的 finishFailed 调用方分类后传入。
 * 消费者：错误分布、SLO 与告警规则。
 * 不变量：category 不是异常类名/消息，禁止自由文本；cancelled 与 timeout
 * 必须区分（前者是主动取消，后者可重试）；未知错误只能归 unknown。
 */
export type AgentTelemetryErrorCategory =
  | "configuration"
  | "authentication"
  | "permission"
  | "rate_limit"
  | "timeout"
  | "network"
  | "provider"
  | "parse"
  | "cancelled"
  | "internal"
  | "unknown";

/**
 * 取消原因：谁/什么触发了取消，用于区分用户主动与系统被动。
 *
 * 生产者：取消信号来源（用户、abort signal、超时、关机、被新请求取代）。
 * 消费者：取消统计与 UI 展示；不用于判断失败。
 * 不变量：superseded 表示被后续请求取代，不是用户取消；unknown 只兜底未知来源。
 */
export type AgentTelemetryCancellationReason =
  | "user"
  | "abort_signal"
  | "timeout"
  | "shutdown"
  | "superseded"
  | "unknown";

/**
 * 放弃原因：span 未以正常终态结束（缺终态、会话关闭、进程关闭）。
 *
 * 生产者：进程/会话关闭时的收尾逻辑。
 * 消费者：数据完整性看板（abandoned 比例）。
 * 不变量：放弃不是失败，不应计入错误率；但必须显式上报以便识别缺口。
 */
export type AgentTelemetryAbandonReason =
  | "missing_terminal"
  | "session_shutdown"
  | "process_shutdown";

/**
 * agent 执行 span 的通用上下文：归属、身份与父子会话关系。
 *
 * 生产者：入口层/turn 创建时组装，向子 span 继承。
 * 消费者：turn/step/tool 等 span 属性与跨服务关联。
 * 字段口径：sessionId 必填；turnId 在 turn 建立后才有；parentSessionId 与
 * parentTurnId 表示 spawn 关系（子代理/workflow child），不是重试关系；
 * queryId 关联一次用户查询；userSubjectId 已脱敏；identityState 缺省由进程
 * 快照补齐。
 * 不变量：session/turn 是业务归属，traceId 才是追踪主键；不得用 sessionId
 * 冒充 traceId 做跨服务串联。
 */
export interface AgentTelemetryExecutionContext {
  /** 发起方分类。 */
  actorKind: AgentTelemetryActorKind;
  /** agent 名称（展示/分组），不是身份主键。 */
  agentName?: string;
  /** 身份状态；缺省由进程级身份快照补齐。 */
  identityState?: AgentTelemetryIdentityState;
  /** 入口渠道。 */
  launchSurface: AgentTelemetryLaunchSurface;
  /** 父会话 ID：子代理/workflow child 所属的会话。 */
  parentSessionId?: string;
  /** 父 turn ID：spawn 来源 turn，不是重试前驱。 */
  parentTurnId?: string;
  /** 本次用户查询 ID，用于把同一 query 的多次 turn/调用串起来。 */
  queryId?: string;
  /** 当前会话 ID（必填），业务归属主键。 */
  sessionId: string;
  /** 当前 turn ID；turn 建立前可为空。 */
  turnId?: string;
  /** 已脱敏的用户主体 ID。 */
  userSubjectId?: string;
}

/**
 * 可跨异步/进程边界保存的因果引用：OTel SpanContext + 业务关联投影。
 *
 * 生产者：`captureCausation()` 在当前 span 上抓取，随任务传递。
 * 消费者：新建 span 时作为 parent/link，或跨进程恢复关联。
 * 字段口径：isRemote/spanId/traceFlags/traceId/traceState 保持 OTel 原义；
 * sessionId/turnId/toolCallId 是 ARMS 无法 Link Join 时的受控查询投影。
 * 不变量：traceId 优先级高于 sessionId；异步任务不得丢失 traceId；
 * 不要用业务 ID 代替 spanId 建立父子关系。
 */
/**
 * 可跨异步/进程边界保存的因果引用。SpanContext 字段保持 OTel 原义；
 * session/turn 只用于 ARMS 无法 Link Join 时的受控查询投影。
 */
export interface AgentTelemetryCausation {
  /** 该 span context 是否来自远端。 */
  isRemote: boolean;
  /** OTel span ID，用于建立父子/链接关系。 */
  spanId: string;
  /** OTel trace flags（采样/随机位）。 */
  traceFlags: number;
  /** OTel trace ID，跨服务追踪主键。 */
  traceId: string;
  /** 可选的 W3C trace state。 */
  traceState?: string;
  /** 业务会话投影；仅用于受控查询，不替代 traceId。 */
  sessionId?: string;
  /** 业务 turn 投影；仅用于受控查询。 */
  turnId?: string;
  /** 工具调用投影；工具内新建 span 时用于关联。 */
  toolCallId?: string;
}

/**
 * 遥测作用域：可捕获因果、并在该上下文中执行回调，保证异步不丢 traceId。
 *
 * 生产者：各 span writer 实现（基于 AsyncLocalStorage/OTel context）。
 * 消费者：runtime 在启动子任务/工具/流迭代时用 run 包裹。
 * 不变量：run 必须在同步/异步回调期间恢复上下文；captureCausation 在无有效
 * span context 时返回 undefined，调用方不得伪造。
 */
export interface AgentTelemetryScope {
  /** 抓取当前上下文的因果引用；无有效 span 时返回 undefined。 */
  captureCausation(): AgentTelemetryCausation | undefined;
  /** 在捕获的遥测上下文中执行回调（异步期间保持 trace 归属）。 */
  run<T>(execute: () => T): T;
}

/**
 * 创建一个 turn span 的输入：归属上下文与因果模式。
 *
 * 生产者：入口层在用户/合成 turn 开始时构造。
 * 消费者：AgentExecutionTelemetryPort.startTurn。
 * 字段口径：context 必填；causation 是来源 span（父/链接）；causationMode
 * "child" 表示成为父 span 的子 span，否则作为 linked root（新 trace 根 + link）；
 * inputSource 区分真实用户与合成输入；turnNumber 是会话内递增序号。
 * 不变量：causationMode 缺省按 linked_root 处理；不得在 child 模式下再添加
 * spawned_by link，避免双重因果。
 */
export interface AgentTurnTraceStart {
  /** turn 归属上下文（会话/身份/父子关系）。 */
  context: AgentTelemetryExecutionContext;
  /** 来源因果引用；无外部来源时缺省。 */
  causation?: AgentTelemetryCausation;
  /** 因果模式：child 继承父 trace；linked_root 建立新根并链接来源。 */
  causationMode?: "child" | "linked_root";
  /** 输入来源（真实用户/合成消息）。 */
  inputSource?: AgentTelemetryInputSource;
  /** 会话内 turn 序号，从 1 开始。 */
  turnNumber: number;
}

/**
 * 创建一个 step span 的输入：step 是 turn 内的一次 agent 循环。
 *
 * 生产者：agent loop 在每次 step 开始时构造。
 * 消费者：AgentExecutionTelemetryPort.startStep；父 span 取当前活动 writer。
 * 字段口径：stepId 在 turn 内唯一；stepIndex 从 0/1 递增，用于排序。
 * 不变量：step 必须依附当前 turn/step 上下文，不能跨 turn 复用 writer。
 */
export interface AgentStepTraceStart {
  /** step 稳定 ID，用于与模型/工具 span 关联。 */
  stepId: string;
  /** step 序号，用于时间线排序。 */
  stepIndex: number;
}

/**
 * 创建一个工具执行 span 的输入：归属于当前 step，并携带工具调用 ID。
 *
 * 生产者：tool runtime 在调度一次工具调用前构造。
 * 消费者：AgentExecutionTelemetryPort.startTool。
 * 字段口径：registeredToolName 是注册名（不是显示名）；toolCallId 与模型
 * tool_call 事件一致，用于父子关联。
 * 不变量：同一 toolCallId 只能有一个执行 span；provider 侧执行的工具不应
 * 再创建本地执行 span。
 */
export interface ToolTraceStart {
  /** 注册工具名，用于工具维度聚合。 */
  registeredToolName: string;
  /** 本次调用 ID，与模型 tool_call 的 id 一致。 */
  toolCallId: string;
}

/**
 * 命令类别：对 shell 执行内容做粗分类，供风险/统计使用。
 *
 * 生产者：命令执行层根据命令内容分类。
 * 消费者：command span 属性与审批策略。
 * 不变量：分类不是安全证明；other 表示无法归类，不得默认成安全类别。
 */
export type CommandCategory =
  | "shell"
  | "git"
  | "package_manager"
  | "build"
  | "test"
  | "file"
  | "network"
  | "other";

/**
 * shell 种类：bash/zsh/sh/powershell/cmd/other。
 *
 * 生产者：命令执行层探测。
 * 消费者：command span 属性与跨平台排查。
 * 不变量：other 表示未知 shell，不得推断为 POSIX。
 */
export type CommandShellKind = "bash" | "zsh" | "sh" | "powershell" | "cmd" | "other";

/**
 * 创建命令执行 span 的输入：命令的安全名称、类别与沙箱状态。
 *
 * 生产者：工具（如 shell 工具）在启动命令前构造。
 * 消费者：ToolExecutionSpanWriter.startCommand。
 * 字段口径：safeName 必须是脱敏/截断后的命令名，禁止原始命令全文；
 * commandCount 允许一次调用多条命令；sandboxed 表示是否在沙箱执行；
 * shellKind 缺省表示未识别。
 * 不变量：不得上报命令参数、环境变量或工作目录绝对路径。
 */
export interface CommandTraceStart {
  /** 粗分类。 */
  category: CommandCategory;
  /** 本次调用包含的命令条数。 */
  commandCount: number;
  /** 脱敏后的命令名（不是完整命令行）。 */
  safeName: string;
  /** 是否在沙箱内执行。 */
  sandboxed: boolean;
  /** shell 类型；缺省为未识别。 */
  shellKind?: CommandShellKind;
}

/**
 * 创建 context compaction span 的输入：记录触发来源、阶段与预算事实。
 *
 * 生产者：compaction 流程在开始/每次外层尝试时构造。
 * 消费者：AgentExecutionTelemetryPort.startCompaction。
 * 字段口径：phase 是压缩阶段；trigger 是触发来源；modelMode 区分流式/非流式；
 * thresholdTokens 与 policyContextWindowTokens 是策略值；tokenSource 标明
 * token 数是估算还是 provider usage；outerAttempt/maxAttempts 表达外层重试；
 * recoveredFromLogicalCallId 表示从失败的逻辑调用恢复。
 * 不变量：这些是观测事实，不得据此改变压缩策略。
 */
export interface CompactionTraceStart {
  /** 外层最大尝试数；缺省表示沿用默认策略。 */
  maxAttempts?: number;
  /** 压缩模型调用方式：流式或非流式。 */
  modelMode: "streaming" | "non_streaming";
  /** 外层尝试序号。 */
  outerAttempt?: number;
  /** 压缩阶段（来自 compact 模块）。 */
  phase: CompactPhase;
  /** 策略中的上下文窗口 token 上限。 */
  policyContextWindowTokens?: number;
  /** 从哪个失败逻辑调用恢复而来。 */
  recoveredFromLogicalCallId?: string;
  /** 触发压缩的阈值 token。 */
  thresholdTokens?: number;
  /** token 来源：估算或 provider 实际 usage。 */
  tokenSource?: "estimate" | "provider_usage";
  /** 触发来源（来自 compact 模块）。 */
  trigger: CompactTrigger;
  /** 触发压缩的 step 序号。 */
  triggeringStepIndex?: number;
}

/**
 * 游离操作的执行方式：前台、排队、后台。
 *
 * 生产者：调度层在启动 detached 操作时标注。
 * 消费者：detached operation span 属性与延迟分析。
 * 不变量：background 不代表允许丢失终态；仍需 finish/abandon。
 */
export type DetachedExecutionKind = "foreground" | "queued" | "background";

/**
 * 游离操作的触发者：用户、turn、工具、调度器、恢复流程、其他。
 *
 * 生产者：调度/恢复入口。
 * 消费者：trigger 维度与成本归因。
 * 不变量：recovery 表示故障恢复触发的重放，不是用户新请求。
 */
export type DetachedTrigger = "user" | "turn" | "tool" | "scheduler" | "recovery" | "other";

/**
 * 游离操作的目标类别：会话、目标、工作区、项目记忆、其他。
 *
 * 生产者：调度入口按业务对象标注。
 * 消费者：targetKind 维度与资源归属分析。
 * 不变量：other 只兜底未建模对象，不得用于掩盖已有类别。
 */
export type DetachedTargetKind = "session" | "goal" | "workspace" | "project_memory" | "other";

/**
 * 创建游离操作 span 的输入：不属于 turn/step 主链路的独立操作。
 *
 * 生产者：调度器/后台任务在启动标题、记忆、web 处理等操作时构造。
 * 消费者：AgentExecutionTelemetryPort.startDetachedOperation。
 * 字段口径：operation 排除 agent_step/context_compaction（它们有专用入口）；
 * executionKind 表示前台/排队/后台；chunkCount/chunkIndex 表达分片处理；
 * goalIteration 表示目标循环轮次；targetKind 是业务对象类别。
 * 不变量：detached span 可以没有父 turn，但必须带 sessionId；不得据此把
 * 后台任务算进主 turn 延迟。
 */
export interface DetachedOperationTraceStart {
  /** 来源因果引用；后台恢复/跨进程时用于保持 traceId。 */
  causation?: AgentTelemetryCausation;
  /** 归属上下文（至少包含 sessionId）。 */
  context: AgentTelemetryExecutionContext;
  /** 前台/排队/后台执行方式。 */
  executionKind: DetachedExecutionKind;
  /** 操作类型；排除 step/compaction。 */
  operation: Exclude<AgentTelemetryOperation, "agent_step" | "context_compaction">;
  /** 触发者。 */
  trigger: DetachedTrigger;
  /** 分片总数（若按块处理）。 */
  chunkCount?: number;
  /** 当前分片序号。 */
  chunkIndex?: number;
  /** 目标循环轮次。 */
  goalIteration?: number;
  /** 目标业务对象类别。 */
  targetKind?: DetachedTargetKind;
}

/**
 * turn 级失败阶段：定位失败发生在 setup / agent loop / finalize 的哪一段。
 *
 * 生产者：turn 执行器在最终失败时分类。
 * 消费者：AgentTurnSpanWriter.finishFailed 与 turn 失败看板。
 * 不变量：unhandled 只兜底流程级未知错误；已知阶段不得折叠。
 */
export type TurnFailureStage = "setup" | "agent_loop" | "finalize" | "unhandled";

/**
 * step 级失败阶段：prepare/model/tool/commit 四段 + 兜底。
 *
 * 生产者：agent loop 在 step 失败时分类。
 * 消费者：step span 的失败属性与模型/工具错误归因。
 * 不变量：model 与 tool 失败要区分，便于判断是 provider 还是执行器问题。
 */
export type StepFailureStage = "prepare" | "model" | "tool" | "commit" | "unhandled";

/**
 * 工具执行失败阶段：从查找/校验/权限到 handler/hook/序列化。
 *
 * 生产者：tool runtime 在工具调用失败时分类。
 * 消费者：tool span 失败属性与审批/校验问题排查。
 * 不变量：permission 失败表示未获授权，不是执行器异常；serialize 失败表示
 * 结果无法安全落盘/回填。
 */
export type ToolFailureStage =
  | "lookup"
  | "validation"
  | "permission"
  | "pre_hook"
  | "handler"
  | "post_hook"
  | "serialize"
  | "unhandled";

/**
 * 命令执行失败阶段：准备/启动/执行/超时/收集输出。
 *
 * 生产者：命令执行层在失败时分类。
 * 消费者：command span 失败属性；区分启动失败与运行超时。
 * 不变量：timeout 是独立阶段，不得与 execute 或 unhandled 混用。
 */
export type CommandFailureStage =
  | "prepare"
  | "spawn"
  | "execute"
  | "timeout"
  | "collect_output"
  | "unhandled";

/**
 * 压缩失败阶段：准备/模型/解析/提交/回退。
 *
 * 生产者：compaction 流程在失败时分类。
 * 消费者：compaction span 失败属性与压缩成功率分析。
 * 不变量：fallback 表示压缩模型回退本身失败；parse 表示模型输出不可用。
 */
export type CompactionFailureStage =
  | "prepare"
  | "model"
  | "parse"
  | "commit"
  | "fallback"
  | "unhandled";

/**
 * 游离操作失败阶段：调度/执行/提交。
 *
 * 生产者：后台任务执行器在失败时分类。
 * 消费者：detached span 失败属性。
 * 不变量：schedule 失败表示任务未被启动；execute 失败表示运行中出错。
 */
export type DetachedFailureStage = "schedule" | "execute" | "commit" | "unhandled";

/**
 * turn span 写入口：以 turn 为粒度记录结果类型、失败阶段与取消。
 *
 * 生产者：AgentExecutionTelemetryPort.startTurn 返回。
 * 消费者：turn 执行器在各终态调用 finish*。
 * 生命周期：恰好一次 finishCompleted/finishFailed/finishCancelled。
 * 不变量：resultType 只表达 turn 产出形态，不是错误原因；writer 失败不得
 * 中断 turn。
 */
export interface AgentTurnSpanWriter extends AgentTelemetryScope {
  /** turn 成功完成；resultType 表达最终产出形态。 */
  finishCompleted(resultType?: "assistant_message" | "tool_request" | "no_output" | "other"): void;
  /** turn 失败；stage 为 turn 级阶段。 */
  finishFailed(
    stage: TurnFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  /** turn 被取消。 */
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

/**
 * step span 写入口：step 的完成原因可区分“正常完成/请求工具/触发压缩/丢弃”。
 *
 * 生产者：AgentExecutionTelemetryPort.startStep 返回。
 * 消费者：agent loop 在每个 step 终态调用。
 * 生命周期：finishCompleted/finishDiscarded/finishFailed/finishCancelled 互斥且一次。
 * 不变量：discarded 表示 step 产物被丢弃（如被 steer/取消接管），不是失败。
 */
export interface AgentStepSpanWriter extends AgentTelemetryScope {
  /** step 完成；terminalReason 说明为何结束。 */
  finishCompleted(
    terminalReason:
      | "model_completed"
      | "tool_requested"
      | "turn_completed"
      | "compaction_requested",
  ): void;
  /** step 产物被丢弃（非错误）。 */
  finishDiscarded(): void;
  /** step 失败；stage 为 step 级阶段。 */
  finishFailed(
    stage: StepFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  /** step 被取消。 */
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

/**
 * 工具执行 span 写入口：记录审批、输出预算与嵌套命令 span。
 *
 * 生产者：AgentExecutionTelemetryPort.startTool 返回。
 * 消费者：tool runtime 在权限/执行/输出阶段调用。
 * 生命周期：finishCompleted/finishDenied/finishFailed/finishCancelled 互斥且一次；
 * startCommand 可创建子 span。
 * 不变量：finishDenied 与 finishFailed 不同——拒绝不是错误；输出字节数只记录
 * 有界统计，不得保存原始输出。
 */
export interface ToolExecutionSpanWriter extends AgentTelemetryScope {
  /** 标记已发起权限请求。 */
  markPermissionRequested(): void;
  /** 记录权限判定结果。 */
  setPermissionDecision(decision: "granted" | "denied" | "not_required"): void;
  /** 记录输出字节数（截断前后口径由实现统一）。 */
  setOutputBytes(bytes: number): void;
  /** 标记输出是否被预算截断。 */
  setOutputTruncated(truncated: boolean): void;
  /** 为工具内部执行的命令创建子 span。 */
  startCommand(input: CommandTraceStart): CommandExecutionSpanWriter;
  /** 工具成功完成。 */
  finishCompleted(): void;
  /** 工具被拒绝（用户/策略/不可用），不是执行失败。 */
  finishDenied(reason: "user_denied" | "policy_denied" | "unavailable" | "unknown"): void;
  /** 工具执行失败。 */
  finishFailed(
    stage: ToolFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  /** 工具被取消。 */
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

/**
 * 命令执行 span 写入口：记录首输出、退出码/信号、超时与转后台。
 *
 * 生产者：ToolExecutionSpanWriter.startCommand 返回。
 * 消费者：命令执行层在生命周期节点调用。
 * 生命周期：finishCompleted/finishFailed/finishCancelled/finishBackgrounded 互斥。
 * 不变量：exitCode 与 signal 是进程事实；timedOut 是独立布尔，不替代失败阶段；
 * finishBackgrounded 表示转后台继续运行，不是终态失败。
 */
export interface CommandExecutionSpanWriter extends AgentTelemetryScope {
  /** 标记收到首个输出。 */
  markFirstOutput(): void;
  /** 标记已请求终止（取消/超时/关机）。 */
  markTerminationRequested(reason: "cancelled" | "timeout" | "shutdown"): void;
  /** 记录进程退出码。 */
  setExitCode(exitCode: number): void;
  /** 记录终止信号（如 SIGKILL）。 */
  setSignal(signal: string): void;
  /** 记录输出字节数。 */
  setOutputBytes(bytes: number): void;
  /** 标记是否因超时终止。 */
  setTimedOut(timedOut: boolean): void;
  /** 命令成功完成。 */
  finishCompleted(): void;
  /** 命令执行失败。 */
  finishFailed(
    stage: CommandFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  /** 命令被取消。 */
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
  /** 命令转入后台继续运行（非终态）。 */
  finishBackgrounded(): void;
}

/**
 * 上下文压缩 span 写入口：记录压缩模型 token、回退与丢弃。
 *
 * 生产者：AgentExecutionTelemetryPort.startCompaction 返回。
 * 消费者：compaction 流程在完成/失败/回退时调用。
 * 生命周期：finishCompleted/finishDiscarded/finishFailed/finishCancelled 互斥。
 * 不变量：token 只记录 provider usage 或明确的估算口径；discarded 表示压缩
 * 结果未采用，不是失败。
 */
export interface ContextCompactionSpanWriter extends AgentTelemetryScope {
  /** 记录压缩请求输入 token。 */
  setInputTokens(tokens: number): void;
  /** 记录压缩请求输出 token。 */
  setOutputTokens(tokens: number): void;
  /** 记录压缩模型已回退到其他目标。 */
  markFallbackSelected(reason: string): void;
  /** 压缩成功完成。 */
  finishCompleted(): void;
  /** 压缩结果被丢弃（未采用）。 */
  finishDiscarded(): void;
  /** 压缩失败。 */
  finishFailed(
    stage: CompactionFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  /** 压缩被取消。 */
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

/**
 * 游离操作 span 写入口：记录结果类型与终态。
 *
 * 生产者：AgentExecutionTelemetryPort.startDetachedOperation 返回。
 * 消费者：后台任务执行器在终态调用。
 * 生命周期：finishCompleted/finishFailed/finishCancelled 互斥且一次。
 * 不变量：resultType 只表达产出形态；后台任务仍必须显式收尾。
 */
export interface DetachedOperationSpanWriter extends AgentTelemetryScope {
  /** 记录结果类型（文本/布尔/元数据/其他）。 */
  setResultType(resultType: "text" | "boolean" | "metadata" | "other"): void;
  /** 操作成功完成。 */
  finishCompleted(): void;
  /** 操作失败。 */
  finishFailed(
    stage: DetachedFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  /** 操作被取消。 */
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

/**
 * agent 执行遥测端口：runtime 创建各类 span 的唯一入口。
 *
 * 生产者：telemetry runtime 实现，注入 core/bootstrap。
 * 消费者：turn/step/tool/command/compaction/detached 流程。
 * 不变量：所有 start* 必须返回可安全调用的 writer（遥测关闭时返回 NOOP），
 * 不得因遥测异常中断主链路；captureCausation 在没有活动 span 时返回 undefined；
 * abandonSession 只清理未收尾 span，不做业务裁决。
 */
export interface AgentExecutionTelemetryPort {
  /** 抓取当前活动 span 的因果引用；无有效上下文返回 undefined。 */
  captureCausation(): AgentTelemetryCausation | undefined;
  /** 开启 context compaction span。 */
  startCompaction(input: CompactionTraceStart): ContextCompactionSpanWriter;
  /** 开启游离操作 span（标题/记忆/web 处理等）。 */
  startDetachedOperation(input: DetachedOperationTraceStart): DetachedOperationSpanWriter;
  /** 开启 step span（父 span 为当前活动 turn/step）。 */
  startStep(input: AgentStepTraceStart): AgentStepSpanWriter;
  /** 开启工具执行 span。 */
  startTool(input: ToolTraceStart): ToolExecutionSpanWriter;
  /** 开启 turn span（根或链接根/子 span）。 */
  startTurn(input: AgentTurnTraceStart): AgentTurnSpanWriter;
  /** 放弃某 session 下所有未收尾的 span。 */
  abandonSession(sessionId: string): void;
}
