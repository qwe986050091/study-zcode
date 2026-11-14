import type { RuntimeInputPresentation } from "./runtime-input-presentation.js";

// ============================================================
// Session Ports - Core interfaces for session management
// ============================================================
// 运行时会话契约：eventStore 保存顺序事实，reducer 从事件重放出 SessionProjection，
// runtime 只通过 projection 把状态下发给 CLI/TUI/V4；内存态不得替代事件事实。
// 跨进程不变量：eventSeq 在 live/replay/snapshot 三处必须来自同一个 event store；
// projection 中的每个字段都必须能由已落库事件（而非进程内临时状态）重建。
// 输入相关结构（TurnInputIntentMetadata/PendingSteerInputInfo）会随事件与 message metadata 持久化，
// admission 时固定的字段在队列/guide/重试过程中不得重新读取会话最新值。

import type { ErrorAttribution, SessionEvent } from "../events/session.events.js";
import type {
  InteractionRequestOrigin,
  MessageId,
  QueryId,
  SessionId,
  TurnId,
  TraceId,
} from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { CompactProjectionInfo } from "../compact/index.js";
import type { CheckpointProjectionInfo, RewindProjectionInfo } from "../rewind/index.js";
import type {
  StreamRecoveryAnchorProjectionInfo,
  StreamingToolLedgerProjectionInfo,
} from "../events/stream-recovery.events.js";
import type { SessionGoal } from "../tools/target.js";
import type { GoalCompletionVerificationOutput } from "../tools/target.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "./permission.port.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { ModelSelection } from "../model/model.js";

// -----------------------------------------------
// Collaboration Mode and Risk Level
// -----------------------------------------------

// 协作模式：决定权限收紧/自动执行边界。plan=只规划；build/edit 正常读写；yolo=全自动；
// guarded 只收紧内部派生的 yolo（见 inheritPermissionMode）；auto 由策略自行选择。
// 生产者是 app.setMode / 命令面 / 会话恢复；消费者是权限判断、工具执行与 V4 投影 config.mode。
// 该值会持久化到 session.permission.mode 与 execution_state entry，冷恢复必须沿用落盘值。
export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "guarded" | "auto";

/** 父 guarded 只收紧内部 YOLO 派生；显式的其它子模式保留各自策略。 */
// fork/subagent 继承权限时的唯一收窄规则：父会话 guarded 且解析结果为 yolo → guarded；
// 其它显式子模式（plan/build/edit/auto）保持原样，不能被父模式静默改写。
// 这是纯函数，不读全局状态，保证同一输入在所有派生路径得到相同结果。
export function inheritPermissionMode<T extends CollaborationMode | undefined>(
  parent: CollaborationMode | undefined,
  resolved: T,
): T | "guarded" {
  return parent === "guarded" && resolved === "yolo" ? "guarded" : resolved;
}
// 会话运行状态：idle（可接收）/running（有 active turn）/waiting（等交互或权限）/
// paused（队列暂停）/completed（目标完成）/error（终态失败）。由 reducer 从事件派生，
// 不允许业务层直接改写；UI 与路由（是否可 admission）都读该值。
export type SessionStatus = "idle" | "running" | "waiting" | "paused" | "completed" | "error";
// 风险等级：权限弹窗与交互请求的展示/排序依据；低风险不改变审批语义，只影响提示强度。
export type RiskLevel = "low" | "medium" | "high" | "critical";
// 旧输入投递意图（非 V4 命令面的兼容枚举）：auto 由运行时决定，start_turn 起新轮，
// steer_active_turn 引导当前轮。V4 新路径使用 TurnSteerDeliveryMode，不能混用。
export type InputDelivery = "auto" | "start_turn" | "steer_active_turn";
// steer 被拒绝的结构化原因：空输入、超长、无活跃轮、目标轮不匹配、轮不可引导。
// 生产者是 steerTurn/rejectTurnSteer，消费者是调用方与 TurnSteerRejected 事件；
// 拒绝是返回值而非异常，调用方不得依赖错误文本判断原因。
export type TurnSteerRejectReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "turn_not_steerable"
  | "empty_input"
  | "input_too_large";

// -----------------------------------------------
// Session Event Store Port
// -----------------------------------------------

/** 内存 event store 的驻留规模；只用于本地内存诊断日志。 */
// 统计只描述「当前进程内驻留」的事件规模，不代表持久化总量；不能用于计费或审计。
// 生产者是内存 event store 的 tick/诊断路径，消费者是日志；持久化实现可以完全不提供。
export interface SessionEventStoreStats {
  // 当前驻留的 session 数；用于判断 LRU/淘汰是否生效。
  sessions: number;
  // 当前驻留的事件总数；包含瞬态与 durable 事件。
  events: number;
  /** 按 turn 窗口策略已淘汰的瞬态事件累计数；unbounded 模式恒为 0。 */
  evictedEvents?: number;
  /** 当前仍驻留的瞬态事件数（进行中 turn + 一个滞后 turn）。 */
  retainedTransient?: number;
}

// 事件存储边界：append 必须为每条事件分配单调 sequenceNumber 并返回补号后的事件；
// 读侧（replay/冷恢复）依赖该序号重建顺序，不能按时间戳或数组下标排序。
// live sink 只能收到「已落库」的事件，保证 live/replay/snapshot 共享一套 eventSeq。
export interface SessionEventStorePort {
  // 追加并补号；实现必须保证同一 session 内 sequenceNumber 单调且不跳号。
  append(event: SessionEvent): Promise<SessionEvent>;
  // 从 0 起读取全部事件（含瞬态）；冷恢复/重放用，按 sequenceNumber 升序返回。
  getEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  // 读取 sequenceNumber 之后的事件；用于增量补播，必须严格大于入参。
  getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]>;
  // 当前最大序号；无事件时返回 0 或实现约定的起点，空会话不能伪造非零。
  getLatestSequenceNumber(sessionId: SessionId): Promise<number>;
  // 删除某 session 的内存事件；持久化事件不由该接口负责清理。
  deleteSession(sessionId: SessionId): Promise<void>;
  /** 同步、O(sessions) 的只读统计；持久化实现可不提供。 */
  getStats?(): SessionEventStoreStats;
  /**
   * 低频 tick 触发的瞬态事件时间兜底淘汰；
   * 返回淘汰条数。持久化实现可不提供。
   */
  pruneTransientEvents?(nowMs?: number): number;
}

// -----------------------------------------------
// Live Session Event Sink Port
// -----------------------------------------------

// 实时事件消费者：每条已落库事件按 sink 注册顺序通知。
// 生产者是 appendEvent（落库之后），消费者是 UI/遥测/协议桥；单个 sink 失败不得影响其它 sink，
// 也不得回滚已提交的事件。
export interface SessionEventSink {
  // 同步或异步消费事件；抛错由 appendEvent 捕获并降级为 warn，不能中断事件流。
  onSessionEvent(event: SessionEvent): void | Promise<void>;
}

// -----------------------------------------------
// Session Projection Port
// -----------------------------------------------

// 会话投影：reducer 从事件流重放得到的唯一读模型。生产者是 EventReducerPort（reduce/apply），
// 消费者是 CLI/TUI/V4 客户端与 bootstrap 路由（是否 busy、是否可 admission）。
// 跨进程不变量：所有字段必须可由已落库事件重建；进程内临时状态不得出现在投影中，
// 否则冷恢复/live 会出现两套事实。字段缺省表示事件流未提供该能力，不得伪造默认值。
export interface SessionProjection {
  // 会话身份；与 eventStore 的 sessionId 必须一致。
  id: SessionId;
  // 会话创建时间（来自 SessionCreated 事件），不是首次读库时间。
  createdAt: Date;
  // 最近一次会话级活动时间；用于列表排序，不因局部配置更新而漂移。
  updatedAt: Date;
  // 当前协作模式；恢复优先级为 invocation override > 权威 mode 事件 > execution_state entry。
  mode: CollaborationMode;
  // Plan 是否启用；旧记录缺失时按旧 mode 解释，不做历史回填。
  planEnabled?: boolean;
  // 运行状态；由 turn/交互事件派生，是 UI 路由与 admission 的直接依据。
  status: SessionStatus;
  // 已完成的真实用户轮次数；compact summary 不计入，避免压缩后轮次虚增。
  turnCount: number;
  // 会话累计 token 用量；来自 provider/用量事件，缺失时不得用本地估算冒充。
  totalTokenCount: number;
  // 当前上下文已用量（token）：优先 provider 返回的权威 usage，缺失时才允许估算；
  // 与 contextWindow 一起决定 compact 触发与 UI 百分比，不能把估算值当权威预算。
  contextUsed: number;
  // 当前模型上下文窗口（token）：随 ModelSelected/模型能力变化，不能用进程默认窗口替代。
  contextWindow: number;
  // 待处理权限请求；冷恢复后的弹窗依赖它重建，空数组表示无待决请求。
  pendingPermissions: PendingPermission[];
  // 待消费 steer/queue 输入；事件投影是 held queue 的唯一权威（active turn 结束后内存队列消亡）。
  pendingSteerInputs: PendingSteerInputInfo[];
  // 当前在执行的工具调用快照；仅用于 UI 展示，不等同于 streamingToolLedger 的恢复账本。
  activeToolCalls: ActiveToolCall[];
  // 流式工具调用账本（attempt/status/执行时序/recoveryAnchorId）：用于断流恢复时判断
  // 哪些 tool 已提交、哪些仍需收口；与 ToolPart 落盘结果互补，不能只看 part 猜状态。
  streamingToolLedger: StreamingToolLedgerProjectionInfo[];
  // 后台任务（bash/subagent/workflow）及其取消状态；投影来自任务生命周期事件。
  backgroundTasks: BackgroundTaskInfo[];
  // 当前 active turn 身份；无进行中轮次时缺省。重启后不能凭它续跑，只能用于投影关联。
  currentTurnId?: TurnId;
  // 最近一次错误；终态后仍保留供 UI 展示，成功的新轮次不得静默清除历史错误归因。
  lastError?: ErrorInfo;
  // 最近一次 compact 投影（阶段/边界/用量）；用于判断历史是否被压缩以及恢复边界。
  lastCompact?: CompactProjectionInfo;
  // 最近一次 workspace checkpoint；供 /rewind latest 选择目标。
  lastCheckpoint?: CheckpointProjectionInfo;
  // 最近一次流恢复锚点；断流恢复据此判断已提交的工具结果。
  lastStreamRecoveryAnchor?: StreamRecoveryAnchorProjectionInfo;
  // 最近一次回退投影；包含 branchGeneration/cut 游标的活动分支事实。
  lastRewind?: RewindProjectionInfo;
  // 当前会话目标；null/undefined 表示无目标，不能把旧目标当作活动目标续跑。
  target?: SessionGoal | null;
  // 目标完成校验的最终结果列表；用于续跑与 UI 展示，不包含进行中状态。
  targetCompletionVerifications: GoalCompletionVerificationOutput[];
  // 目标校验的时间线投影（started/completed/failed_closed/cancelled）；
  // 与上者互补：这是过程状态，冷恢复后仍要显示轮次分隔线，不能只保留最终结果。
  targetCompletionVerificationTimeline: TargetCompletionVerificationProjectionInfo[];
}

// 目标完成校验的时间线投影：由 TargetCompletionVerification 事件持久化与重放。
// 生产者是 core target-completion-verification（同时写 session entry + timeline part），
// 消费者是 V4 投影/恢复 UI。anchor* 指向被校验的 assistant 消息/轮次，缺失时 timeline 无法落位。
export interface TargetCompletionVerificationProjectionInfo {
  // 目标 id；与 SessionGoal 对应。
  targetId: string;
  // 过程状态：started 表示校验已发起但未结束；其余为终态，终态不可回退。
  status: "started" | "completed" | "failed_closed" | "cancelled";
  // 单次校验身份；与 goalIteration 共同定位幂等 part。
  verificationId: string;
  // 校验结果；started 阶段可缺失，终态应携带。
  verification?: GoalCompletionVerificationOutput;
  // 目标迭代序号；同一目标可能多轮校验，用于分组/去重。
  goalIteration?: number;
  // 时间线挂载的 assistant 消息；决定分隔线插在历史中的位置。
  anchorAssistantMessageId?: MessageId;
  // 时间线挂载的轮次；冷恢复按它恢复轮次归属。
  anchorTurnId?: TurnId;
  // 过程开始时间；缺失时由持久 part 的 time.start 兜底。
  startedAt?: Date;
  // 最近更新时间；终态写入时更新，用于幂等覆盖同一 part。
  updatedAt: Date;
}

// 待处理权限请求：内存投影 + 冷恢复弹窗的唯一来源。
// 请求事件必须携带完整的展示信息（display/optionsPolicy），否则恢复后无法重建同一弹窗。
export interface PendingPermission {
  // 审批模式；user-once 表示仅本次允许，不改变持久权限规则。
  approvalMode?: "user-once";
  // 交互请求 id；与 Requested 事件对应，用于决议回填。
  requestId?: string;
  // 触发审批的工具调用；决议必须绑定到该 call，不能串到其它工具。
  toolCallId: string;
  // 工具名；用于展示与权限规则匹配。
  toolName: string;
  // 请求原因/展示文案；缺失时由工具元数据补全，不能作为权限判断依据。
  reason?: string;
  // 风险等级；影响提示强度与排序。
  riskLevel: RiskLevel;
  // 工具输入预览；仅用于展示，权限决议不得基于截断后的输入。
  input?: unknown;
  // 建议的权限更新；用户批准后可原子应用，未批准不得提前生效。
  suggestedPermissionUpdates?: PermissionUpdate[];
  // 请求来源（当前为子代理）；用于把决议回溯到正确的会话/工具调用。
  origin?: InteractionRequestOrigin;
  /** 请求事件携带的 ask 预览；冷恢复重建的会话弹窗仍需带图，所以必须进 projection 状态。 */
  display?: ToolResultDisplayPayload;
  // 选项策略；决定 UI 展示哪些审批按钮，缺失按默认策略。
  optionsPolicy?: PermissionOptionsPolicy;
  // 请求创建时间；用于排序/超时展示，不用于权限有效性判断。
  requestedAt: Date;
}

// 待消费 steer/queue 输入在投影中的形态。生产者是 TurnSteerQueued/DeliveryChanged/Reordered 事件，
// 消费者是 held queue 提升、UI 列表与恢复清扫；该结构是 active turn 结束后队列的唯一权威。
export interface PendingSteerInputInfo {
  // 输入身份（admission 时的 pendingInputId/queueItemId）；账本、事件、message 共用同一 id。
  pendingInputId: string;
  // 原始输入文本；编辑后由同 id TurnSteerQueued 原地更新。
  input: string;
  // 预览（截断后的展示用）；不能用于重建模型输入。
  inputPreview: string;
  // UTF-8 字节数；用于超限判断与日志。
  inputSize: number;
  // 命令种类（sendText/sendGoalCommand/compact）；决定消费方式与是否走 goal gate。
  commandKind?: TurnSteerCommandKind;
  // 来源（计划审批反馈/工作流 refine 反馈）；缺省表示普通用户输入。
  source?: TurnSteerSource;
  // 输入呈现类型；随队列持久化，消费时写入 user message metadata。
  inputPresentation?: RuntimeInputPresentation;
  /** 当前排队输入附带的工具隐藏列表；automation busy 入队必须在消费时继续生效。 */
  toolDisallowlist?: readonly string[];
  // 入队时间；用于计算排队时长与 FIFO 展示。
  queuedAt: Date;
  // 目标轮次；无 active turn 时可能是 deferred/最近 assistant turn，恢复时按它分组。
  targetTurnId: TurnId;
  // 入队时的任务链 id；输入消费后必须继续沿该 trace 记录。
  traceId: TraceId;
  // admission 时固定的 intent 快照（modelSelection/mode/admissionSeq 等），后续不得重读会话最新值。
  intent?: TurnInputIntentMetadata;
}

// 活跃工具调用（UI 展示用）：只描述调用状态，不承载已提交结果；结果事实在 ToolPart/ledger。
export interface ActiveToolCall {
  // 工具调用身份；与 provider callID/ToolPart.callID 关联。
  toolCallId: string;
  // 工具名；用于展示与权限/可见性判断。
  toolName: string;
  // 调用状态；pending→running→completed/failed/denied，终态不可回退。
  status: ToolCallStatus;
  // 开始时间；缺失表示尚未真正开始执行。
  startedAt?: Date;
}

// 工具调用状态闭集：denied 与 failed 是不同语义（被权限拒绝 vs 执行失败），UI/统计不得合并。
export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "denied";

// 后台任务状态闭集：lost 表示进程/注册表已失去该任务的控制权，不等同于 failed；
// timed_out 与 cancelled 是不同终态，统计/重试策略必须区分。
export type BackgroundTaskInfoStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

// 后台任务投影：由任务生命周期事件维护，供 UI 展示与取消路由。
// 该结构跨越进程/事件边界；output* 只保留路径与尾部预览，不能把完整输出塞进投影。
export interface BackgroundTaskInfo {
  // 任务身份；取消/查询都按它定位，不能依赖数组下标。
  taskId: string;
  // 触发该任务的工具调用；用于把后台结果回挂到对应 tool part。
  toolCallId?: string;
  // 工具名；用于展示与结果路由。
  toolName?: string;
  // 任务种类：bash 子进程 / subagent 子会话 / workflow 子会话；决定取消与恢复语义。
  taskKind?: "bash" | "subagent" | "workflow";
  // 子会话身份；subagent/workflow 才有，恢复时用于关联子会话历史。
  childSessionId?: string;
  // 是否被阻塞（如等待审批/依赖），以及阻塞原因；仅用于展示与诊断。
  blocked?: boolean;
  blockedReason?: string;
  // 是否可取消；只读/已提交任务不可取消，UI 据此决定是否显示取消按钮。
  cancellable?: boolean;
  // 最近一次取消请求时间；用于去重与展示，不代表任务已终止。
  cancelRequestedAt?: Date;
  // 启动命令/描述；仅用于展示与审计。
  command?: string;
  description?: string;
  // 当前状态；running 之外的终态不可回退。
  status: BackgroundTaskInfoStatus;
  // 子进程 pid；bash 任务才有，进程重启后可能失效。
  pid?: number;
  // 启动/完成时间；completedAt 缺失表示仍在运行。
  startedAt?: Date;
  completedAt?: Date;
  // 输出落盘路径；完整内容在 artifact/文件，不在投影里。
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  // 输出字节数/是否截断；用于判断尾部预览是否完整。
  outputBytes?: number;
  outputTruncated?: boolean;
  // 尾部预览；仅展示用途，不能用于重建模型输入。
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  // 终端 id；交互式任务才有，用于把任务与终端会话关联。
  terminalId?: string;
}

// 后台任务取消结果：cancelled=false 时 status/snapshot 仍描述当前真实状态，
// 调用方不能把「取消失败」当作任务已停止；reason 只用于展示与诊断。
export interface BackgroundTaskCancelResult {
  cancelled: boolean;
  reason?: string;
  snapshot?: BackgroundTaskInfo;
  status: BackgroundTaskInfoStatus;
  taskId: string;
}

// 会话级错误投影：ErrorInfo 只保留结构化归因与可展示文本，不保留原始异常对象。
// attribution 用于区分用户取消/模型错误/工具错误；code/type 供稳定判断，message 仅供展示。
export interface ErrorInfo {
  // 错误归因（如 provider/tool/user）；缺失表示旧记录或未知来源。
  attribution?: ErrorAttribution;
  // 稳定错误码；流程判断应读它，不能匹配 message 文本。
  code?: string;
  // 结构化细节；可能含 provider 原始信息，展示前需脱敏。
  detail?: string;
  // 错误类型（稳定分类）；与 code 一起构成可编程错误身份。
  type: string;
  // 用户可读消息；仅用于展示，不用于流程判断。
  message: string;
}

// -----------------------------------------------
// Event Reducer Port
// -----------------------------------------------

// 事件重放端口：reduce 从空投影重放全量事件，apply 在已有投影上增量应用。
// 生产者是 runtime（rebuildProjection/冷恢复），消费者是 UI/路由；实现必须无副作用、可重复执行，
// 同一事件重复 apply 不得产生不同结果（幂等），否则 live 与 replay 会分叉。
export interface EventReducerPort {
  // 全量重放：输入必须按 sequenceNumber 升序；空数组返回合法的空投影。
  reduce(events: SessionEvent[]): SessionProjection;
  // 增量应用：不修改入参投影（返回新对象），事件顺序必须与 eventStore 一致。
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
}

// -----------------------------------------------
// Session Manager Port
// -----------------------------------------------

// 会话管理端口：进程内 Session 对象的生命周期入口。当前主要用于本地内存装配；
// 持久化事实仍来自 SessionStorePort，这里不做业务裁决，也不缓存跨进程状态。
export interface SessionManagerPort {
  // 创建内存会话：config 只携带运行所需的最小事实，持久化由上层另行完成。
  createSession(config: SessionConfig): Promise<Session>;
  // 冷恢复：必须从 store 重建 projection/history，不能复用旧实例。
  resumeSession(sessionId: SessionId): Promise<Session>;
  // fork：forkPoint 是可选消息游标，缺省按当前活动分支末端复制。
  forkSession(sessionId: SessionId, forkPoint?: number): Promise<Session>;
  // 按 id 取内存会话；不存在返回 null，不能抛错。
  getSession(sessionId: SessionId): Promise<Session | null>;
  // 列出当前进程管理的会话摘要；不包含已淘汰/未装配的历史会话。
  listSessions(): Promise<SessionSummary[]>;
}

// 会话配置：运行时最小事实。contextWindow 只是初始值，后续以 ModelSelected 的权威窗口为准；
// traceId 必须来自上层任务链，不能在会话内重新生成。
export interface SessionConfig {
  // 初始协作模式；冷恢复/显式 override 会覆盖它。
  mode?: CollaborationMode;
  // 初始上下文窗口；仅作为模型能力未知时的占位，不能用于最终预算判断。
  contextWindow?: number;
  // 任务链身份；整个 session 及其子任务都沿用它。
  traceId?: TraceId;
}

// 内存会话句柄：把 eventStore、投影、reducer 绑定在一起。
// 消费者是 runtime/bootstrap；projection 是事件派生结果，不是可直接修改的状态容器。
export interface Session {
  // 会话身份；与 eventStore/store 主键一致。
  id: SessionId;
  // 本进程装配时的配置快照；运行中可变字段以事件/entry 为准。
  config: SessionConfig;
  // 顺序事件事实；所有影响 UI 的状态都必须先写这里。
  eventStore: SessionEventStorePort;
  // 当前事件派生出的读模型；由 reducer 维护。
  projection: SessionProjection;
  // 重放器；必须与 projection 同源，不能使用另一套规则。
  eventReducer: EventReducerPort;
}

// steer 输入请求：steerTurn/enqueueDeferredInput 的统一入参。
// 调用方（CLI 命令面/协调者/子代理）只表达意图；admission 会把它固化为 PendingTurnInput/intent。
export interface TurnSteerInput {
  /** 临时执行的选型不可成为普通 Session 续跑默认；不包含请求凭据。 */
  modelSelectionScope?: "execution";
  /** 仅加速卡输入携带普通模型快照，不含凭据；用于接纳时更新 Session。 */
  highspeedFallbackSelection?: ModelSelection;
  // 输入正文；空文本但带附件/引用时仍可受理（hasSteerInput 会判断）。
  input: string;
  // 旧版输入 id；V4 以 intent.queueItemId/pendingInputId 为准。
  inputId?: string;
  // 本次输入的查询 id；drain 后切换模型请求归因，缺省由 runtime 生成。
  queryId?: QueryId;
  // 期望的目标轮次；不匹配时拒绝 steer，避免把输入投给错误轮次。
  expectedTurnId?: TurnId;
  // 命令种类；决定消费通道（goal/compact 不参与普通 guide drain）。
  commandKind?: TurnSteerCommandKind;
  // 来源（审批反馈/工作流 refine）；缺省是普通用户 steer。
  source?: TurnSteerSource;
  // 呈现类型；最终写入 message metadata。
  inputPresentation?: RuntimeInputPresentation;
  // 投递语义；缺省由调用路径决定（steer 路径缺省 queue，deferred 缺省 queue）。
  delivery?: TurnSteerDeliveryMode;
  // admission 时固定的 intent；一旦入队，后续消费不得重新读取最新选择。
  intent?: TurnInputIntentMetadata;
  // 尚未 resolve 的附件；消费时与普通 turn 共用 resolver。
  attachments?: PendingTurnAttachment[];
  // 账本/事件/消息共用的稳定输入 id；缺省由 runtime 生成。
  pendingInputId?: string;
  // 任务链上下文；必须由调用方传入，不能在此新造 trace。
  traceContext?: TraceContext;
  /** 当前输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
}

// 命令种类：sendText=普通输入；sendGoalCommand=目标命令（走 goal gate）；
// compact=压缩命令（不参与普通 guide 内联消费，由专门路径处理）。
export type TurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
// 输入来源：计划审批反馈 / 工作流 refine 反馈；用于区分系统代发与用户亲手输入。
export type TurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * 输入投递语义：
 * - "queue"：排队的未来意图，消费时切新 product turn（每条一轮，自己的回复/工时/edit 范围）；
 * - "guide"：对进行中工作的补充引导，内联在当前轮，不切轮。
 * runtime 注入机制两者相同（boundary 注入），差异只在产品呈现与账本语义。
 */
// 产品层差异是硬约束：queue 在 transcript 中是新 user 轮次（有自己的回复与 edit 范围），
// guide 只是当前轮的补充上下文，不能据此切轮/记账；冷恢复按持久 metadata 还原同一切分。
export type TurnSteerDeliveryMode = "guide" | "queue";

// 加速卡消息的持久化元数据：由 admission 写入 user message.metadata.highspeed，
// 消费端（transcript/投影/统计）据此展示加速效果与回退原因；禁止写入 provider 凭据。
// 该结构跨进程落盘，schemaVersion=1 是唯一格式版本，新增字段必须保持向后兼容（可选）。
/** message.data metadata.highspeed 的持久化契约；不包含运行时凭据。 */
export interface HighspeedMessageMetadata {
  // 持久化格式版本；当前仅 1，读侧遇到其它版本应降级为无 highspeed 信息。
  schemaVersion: 1;
  // 加速卡/任务身份；用于与 Host 侧卡片对账，不代表模型请求身份。
  cardId: string;
  taskId: string;
  // provider/model 是卡片上的展示值，不是本次真实请求的 provider client 句柄。
  provider: string;
  model: string;
  // 卡片签发/过期时间（unix ms）；过期后不得继续按加速语义执行。
  issuedAt: number;
  expiresAt: number;
  // 加速速率与耗时统计；仅用于展示，缺失表示未采集。
  regularTps?: number;
  outputTokens?: number;
  durationMs?: number;
  savedDurationMs?: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  // 实际回退发生时间；仅真正回退后写入。
  fallbackAt?: number;
  // 回退原因闭集；流程判断应读该结构，不能匹配展示文案。
  fallbackReason?:
    | "highspeed_card_expired"
    | "highspeed_request_failed"
    | "highspeed_selection_unavailable";
}

/** 协议无关的输入 intent metadata；bootstrap v4 在事件边界组装为 ConversationInputIntent。 */
// 输入来源（插件 UI 代发 / GenUI 触发）：缺省表示用户亲手输入。
// 这两种来源会在 message 上保留 pluginId/toolCallId 或 path，供审计与 UI 回链。
export type TurnInputSourceMetadata =
  | { kind: "pluginUi"; pluginId: string; toolCallId: string }
  | { kind: "genUi"; path: string; title?: string };

// 输入 intent：admission 时固化的完整上下文，随 TurnSteerQueued 事件与 user message metadata 持久化。
// 生产者是 CLI/bootstrap 的 admission（含 Host 注入的 bot/授权信息），消费者是 steer/drain/transcript hydration。
// 不变量：modelSelection/mode/admissionSeq 一旦写入即冻结，队列/guide/重试不得重新读取 Composer 或
// Session 最新选择；否则同一输入在 live 与恢复后会使用不同模型/模式，破坏幂等与审计。
export interface TurnInputIntentMetadata {
  // Plan 是否在本次提交时启用；与 mode 一起固定，消费时不得读当前会话的 plan 状态。
  planEnabled?: boolean;
  // 引用块：text 是展示正文，path/messageId/sender* 是来源锚点；sentAt 为 ISO 串。
  // 落库时已展开成最终文本，这里仅保留溯源信息，不能据此重新解析用户输入。
  conversationQuotes?: Array<{
    text: string;
    path?: string;
    senderName?: string;
    senderId?: string;
    messageId?: string;
    sentAt?: string;
  }>;
  // 发起端：desktop/mobile；仅用于展示与归因，不参与权限判定。
  inputOrigin?: "desktop" | "mobile";
  // 机器人群组来源：由 Host 在入队时注入的可信上下文（bot/群/话题/发送者）。
  // 该结构跨进程持久化，模型不可写；authorizationId 固定资源授权版本，历史读取不得换新。
  botGroupSource?: {
    // 机器人自身身份（名称/openId）；用于展示“谁在回复”，不用于授权。
    botIdentity?: { name: string; openId?: string };
    // 是否 @ 了机器人；决定该消息是否应触发任务。
    mentionedBot?: boolean;
    // 渠道应用 id 与结构化内容块；跨端协议原始载荷，消费端只读。
    appId?: string;
    contentParts?: import("@zcode/shared").ChannelContentPart[];
    // 群内消息列表：messageId/sender* 用于溯源，attachmentIndexes 定位附件引用；
    // contentParts 是协议内容块，不应在恢复时重新解析成新文本。
    messages?: Array<{
      mentionedBot?: boolean;
      messageId: string;
      senderId: string;
      senderName: string;
      text: string;
      attachmentIndexes: number[];
      contentParts?: import("@zcode/shared").ChannelContentPart[];
    }>;
    /** 入队时由 Host 注入，历史资源请求不能借用后续重新授权的版本。 */
    authorizationId?: string;
    // 机器人/渠道/群/话题身份；授权与回复目标都必须来自这些可信字段，模型不能指定。
    botId: string;
    provider: "feishu" | "lark";
    chatId: string;
    threadId?: string;
    rootMessageId?: string;
    // 话题上下文快照：checkpoint 是抓取起点，hasGap 表示中间消息缺失；
    // 有 gap 时不能把该片段当作完整历史，恢复/展示需要明确提示。
    topicContext?: {
      checkpoint: string;
      hasGap: boolean;
      messages: Array<{
        id: string;
        chatId: string;
        threadId: string;
        senderId: string;
        senderType: "user" | "app";
        text: string;
        createdAt: number;
        kind: string;
        deleted?: boolean;
      }>;
    };
    // 当前消息发送者与消息 id；用于把输入挂到具体人/消息，不用于权限判断。
    senderId: string;
    senderName: string;
    messageId: string;
  };
  // 命令幂等身份：sourceCommandId 由 CLI admission 分配，是 transcript 去重/回放的稳定键；
  // queueItemId 与 pendingInputId 对应，clientId 标识发起端；三者缺一都会让编辑重发丢关联。
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  // 命令种类；与 TurnSteerCommandKind 一致，决定消费通道。
  kind: TurnSteerCommandKind;
  /** transcript hydration 贯穿完整 ConversationInputIntent 的 canonical command text。 */
  text?: string;
  /** Admission 时固定；Queue/Guide 后续不得重新读取 Composer 或 Session 最新选择。 */
  modelSelection?: ModelSelection;
  /** 与本次用户 Submission 一起固定的协作模式。 */
  mode?: "build" | "edit" | "plan" | "yolo" | "guarded";
  // 会话内 admission 单调序号（账本 admitted_sequence 同源）；用于 FIFO/恢复排序，
  // 不是全局序号，也不能用时间戳替代（同毫秒并发会失去稳定顺序）。
  admissionSeq: number;
  // admission 完成时间（unix ms）；用于排队时长与审计，不参与排序。
  admittedAt: number;
  // 调用方请求的投递意图 vs admission 实际采纳的投递：requestedDelivery 保留用户/上游原意，
  // admittedDelivery 才是本输入真正走的车道；guide 回退为 queue 时两者会不同。
  requestedDelivery: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery: "startNow" | "queue" | "guide";
  // 采纳时的队列位置（从 0 开始）；重排会原地更新，drain 后写入 transcript 的 intent 必须保留最新值。
  queuePosition?: number;
  // guide 回退/降级的结构化原因码（如 guide.noToolBoundary）；仅用于诊断，不改投递语义。
  fallbackReasonCode?: string;
  // 附件引用快照：ref 是 artifact 引用，fileName/mime/bytes 是元数据；
  // previewRef/sourceKind/messageCount 用于恢复展示，不能代替真实附件内容。
  attachmentRefs?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
    sourceKind?: "clipboard-text" | "topic-history";
    messageCount?: number;
  }>;
  // 加速卡持久化元数据；与 message.metadata.highspeed 同源，不包含凭据。
  highspeed?: HighspeedMessageMetadata;
  // 共享上下文导入引用：context_id 指向 session entry 中的 pending/reserved 记录；
  // promotion 同事务会把它标成 attached，消费端不得凭该引用重新导入。
  sharedContextRefs?: Array<{
    kind: "shared_context_import";
    context_id: string;
  }>;
  /** edit/retry 重建的新 command 对原始 canonical input cause 的稳定追溯。 */
  // 新 command 必须保留原始 sourceCommandId（及可选 queueItemId/clientId），
  // 否则编辑重发会被当成另一条用户输入，幂等/去重与审计链断裂。
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  /** 插件 UI 代发（MCP Apps ui/message）的来源；用户亲自输入时缺省。 */
  // 该来源只用于审计与 UI 回链，不能据此提升权限或跳过 admission。
  source?: TurnInputSourceMetadata;
}

/** queue 内保留尚未 resolve 的附件描述；消费时与普通 turn 使用同一 resolver。 */
// 入队时不落 artifact，只保存解析所需描述；drain 时若解析失败必须按该输入失败处理，
// 不能静默丢弃附件或把空内容当作用户输入。
export interface PendingTurnAttachment {
  // 附件种类；video/pdf/url 等非文本类型由 resolver 决定如何进入模型上下文。
  type: "file" | "image" | "video" | "pdf" | "url";
  // 文件路径或内联内容；二者至少有一个，具体由 type/resolver 解释。
  path?: string;
  content?: string;
  // 来源标记：剪贴板文本/话题历史；用于恢复展示，不改变解析逻辑。
  sourceKind?: "clipboard-text" | "topic-history";
  messageCount?: number;
  // 可选的展示元数据；不可作为真实文件大小的权威值。
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

// 内存态 pending 输入（active turn 的待消费项）。与持久 PendingSteerInputInfo 字段同构，
// 但这里不承载投影语义；active turn 结束后该对象即消亡，权威转为事件投影。
export interface PendingTurnInput {
  // 输入身份；必须与账本/事件/最终 message 使用同一个 id。
  id: string;
  // 原始输入文本；编辑会原地覆盖。
  input: string;
  // 入队时间（Date，内存态）；用于排队时长，持久事件用时间戳。
  queuedAt: Date;
  // 任务链身份；消费后继续沿用它记录模型请求。
  traceId: TraceId;
  // 本次输入的查询 id；drain 后归因切换。
  queryId?: QueryId;
  // 命令种类；决定是否走 goal/compact 等专用通道。
  commandKind?: TurnSteerCommandKind;
  // 来源；缺省为普通用户输入。
  source?: TurnSteerSource;
  // 呈现类型；最终落到 message metadata。
  inputPresentation?: RuntimeInputPresentation;
  // 投递车道；缺省按 queue，guide 由命令面显式标注。
  delivery?: TurnSteerDeliveryMode;
  // admission 时固化的 intent；消费时不得重新读取会话最新模型/模式。
  intent?: TurnInputIntentMetadata;
  // 未解析附件；drain 时统一 resolve。
  attachments?: PendingTurnAttachment[];
  /** 当前 pending input drain 后不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  // 目标轮次；无 active turn 时可能是 deferred/最近 assistant turn。
  turnId: TurnId;
}

// steer 调用结果：queued 返回消费身份与队列长度；rejected 返回结构化原因与可选 activeTurnId。
// 生产者是 steerTurn/enqueueDeferredInput，消费者是 CLI 命令面；rejected 不是异常，调用方必须处理。
export type TurnSteerResult =
  | {
      kind: "queued";
      pendingInputId: string;
      queueLength: number;
      turnId: TurnId;
    }
  | {
      activeTurnId?: TurnId;
      kind: "rejected";
      reason: TurnSteerRejectReason;
    };

// 会话列表摘要：只用于列表展示与排序，不包含消息内容/权限/目标等详情。
// 生产者是 SessionManager/SessionStore 的 list，消费者是 UI；它不是冷恢复的权威快照。
export interface SessionSummary {
  // 会话身份；读取详情需另行 getSession/resume。
  id: SessionId;
  // 创建/更新时间（事件/存储派生）；用于列表排序。
  createdAt: Date;
  updatedAt: Date;
  // 当前协作模式；仅展示，不能作为权限判断依据。
  mode: CollaborationMode;
  // 运行状态；列表用于区分活跃/完成/错误。
  status: SessionStatus;
  // 真实用户轮次数；compact summary 不计入。
  turnCount: number;
}
