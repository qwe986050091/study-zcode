// Session Store Port：为会话输入、消息和投影提供稳定的存储边界。
// ============================================================
// 【角色边界】本文件只声明持久层能力，不做业务裁决：状态机、同事务边界与 CAS 条件由 core 约定，
// adapter 负责原子实现。任何方法语义变化都必须先改契约，再改调用方。
// 【可选方法】带 ? 的方法表示旧宿主/纯内存实现可以缺席；调用方必须显式降级，
// 降级不得伪造成功，也不得把“方法缺失”当成“空结果”。
// 【跨进程不变量】session_input 账本、message/part、session entry 与 revert 指针是 CLI 重启后
// 恢复队列/分支/历史的唯一事实；写入顺序与原子性优先于吞吐。

import type {
  MessageId,
  PartId,
  ProjectId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./shared.js";
import type {
  CompactBoundaryPayload,
  CompactPhase,
  CompactReason,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  CompactTrigger,
} from "../compact/index.js";
import type {
  ModelId,
  ModelProviderId,
  ModelSelection,
  ModelToolSideEffectScope,
} from "../model/index.js";
import type { TodoItem } from "../tools/todo.js";
import type { SessionGoal, GoalStatus } from "../tools/target.js";
import type { PermissionRuleset } from "./permission.port.js";
import type { CollaborationMode } from "./session.port.js";
import type { EnvInfo } from "./context-source.port.js";

// 会话任务类型闭集：interactive 正常交互；fork/selection_side_chat 是派生会话；
// workflow_parent/workflow_child（含 nested）与 subagent_child 是层级任务。
// 生产者是 createSession(taskType)，消费者是恢复/权限/用量归因；新增值必须同步持久 schema 与投影。
export const SESSION_TASK_TYPES = [
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
] as const;
// 任务类型联合；持久化字段 taskType 必须落在该闭集，旧数据缺省按 interactive 降级。
export type SessionTaskType = (typeof SESSION_TASK_TYPES)[number];

// 会话标题来源闭集：default 占位、first_input 首条输入截取、generated 模型生成、custom 用户改。
// 生产者是 createSession/session-title update，消费者是列表 UI 与 title 同步逻辑；
// expectedTitleSources 用它做 CAS，避免后台生成标题覆盖用户已改的 custom 标题。
export const SESSION_TITLE_SOURCES = ["default", "first_input", "generated", "custom"] as const;
// 标题来源联合；titleSource 与 titleMessageID 一起描述“标题来自哪条消息”，缺省只表示旧数据。
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

// 会话最近一次结果：completed/error/interrupted。由 TurnComplete/TurnError 事件落库，
// 供列表展示与冷启动判断历史任务终态；它不是本轮运行状态（见 SessionStatus）。
export type SessionLastOutcome = "completed" | "error" | "interrupted";

// 消息可见性：user-visible 会出现在 transcript；model-only 只进模型上下文，
// 典型是后台通知/重启提示。生产者是 synthetic notice 持久化，消费者是投影/transcript 渲染。
export const MESSAGE_VISIBILITIES = ["user-visible", "model-only"] as const;
// 可见性联合；缺失按旧消息处理，不得把 model-only 内容直接展示给用户。
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

// synthetic user message 的来源闭集：agent_listing_delta/background_task/fork/goal* /
// plugin_reference/bot_topic_context/rewind/selection_side_chat/subagent*/
// todo_reminder/workflow_launch/shared_context。
// 生产者是各运行时注入点；消费者是投影 origin 映射与 UI 类型识别。新增来源必须同时定义 anchor 映射。
export const SYNTHETIC_USER_MESSAGE_SOURCES = [
  "agent_listing_delta",
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  "plugin_reference",
  "bot_topic_context",
  "rewind",
  "selection_side_chat",
  "subagent",
  "subagent_message",
  "todo_reminder",
  // 中枢直接启动已保存工作流时落的那条 user 消息的来源。
  // 它虽是 synthetic（GUI 用元数据画启动卡而非显示文本），语义上却是用户真实动作：
  // origin=real_user、kind=user_prompt，与其余「运行时注入的提醒」类来源不同档。
  "workflow_launch",
  "shared_context",
] as const;
// synthetic 来源联合；该值会持久化到 message.source，读侧据此决定是否 visible/model-only。
export type SyntheticUserMessageSource = (typeof SYNTHETIC_USER_MESSAGE_SOURCES)[number];

// 消息语义来源（旧读侧口径）：real_user/agent_runtime/system/migration/import。
// 与 v4 anchor.origin 并存不互替；历史消息只读映射，不因新协议回填旧字段。
export type MessageSemanticsOrigin =
  | "real_user"
  | "agent_runtime"
  | "system"
  | "migration"
  | "import";

// 消息语义种类（旧读侧口径）：user_prompt/slash_command/system_reminder/background_notification/
// subagent_notification/todo_reminder/rewind_notice/fork_notice/timeline_event/compact_summary/
// shared_context/assistant_response。生产者是持久化路径，消费者是旧 transcript 渲染。
export type MessageSemanticsKind =
  | "user_prompt"
  | "slash_command"
  | "system_reminder"
  | "background_notification"
  | "subagent_notification"
  | "todo_reminder"
  | "rewind_notice"
  | "fork_notice"
  | "timeline_event"
  | "compact_summary"
  | "shared_context"
  | "assistant_response";

// 旧读侧消息语义：一次写入、随消息持久化，用于历史渲染与归因。
// 新写入必须同时提供 anchor（见 MessageProjectionAnchor）；二者不一致时读侧以 anchor 为准。
export interface MessageSemantics {
  // 语义来源：真实用户/运行时/系统/迁移/导入；决定消息的信任等级与展示方式。
  origin: MessageSemanticsOrigin;
  // 语义种类；决定 transcript 分组与 UI 图标，不参与权限判断。
  kind: MessageSemanticsKind;
  // 原始来源字符串（synthetic source 等）；仅溯源，缺失不影响渲染。
  source?: string;
  // 触发命令名（slash_command）；用于展示与命令幂等关联。
  commandName?: string;
  // UI 可见性：visible/hidden/debug；debug 只应在调试面板展示。
  uiVisibility: "visible" | "hidden" | "debug";
  // provider 可见性：visible 才会进入模型上下文；hidden 仅存档。
  providerVisibility: "visible" | "hidden";
  // transcript 可见性：visible 才进入可回放对话记录；与 uiVisibility 独立。
  transcriptVisibility: "visible" | "hidden";
}

// v4 投影锚点词表（userInput.origin）。
// 与 MessageSemanticsOrigin 并存不互替：semantics.origin 是旧读侧语义，
// anchor.origin 是新协议 row 派生依据；老值由读侧只读映射。
// 生产者是持久化路径（真实用户消息、后台通知、goal 续跑、mailbox、synthetic notice），
// 消费者是 V4 transcript row 派生与 fork 边界判定。
// 闭集：新增来源必须同时定义 semantics 映射与 UI 展示规则，不能只追加字符串。
export const MESSAGE_ANCHOR_ORIGINS = [
  "realUser",
  "backgroundResult",
  "goalContinuation",
  "mailbox",
  "synthetic",
] as const;
// 锚点来源联合；持久化在 message JSON 的 anchor.origin，缺失表示旧数据由读侧映射。
// 该值只做展示/派生，不参与权限或信任判定；信任判定仍以 semantics.origin 为准。
export type MessageAnchorOrigin = (typeof MESSAGE_ANCHOR_ORIGINS)[number];

/**
 * stable fork 的 fork 点 goal 事实。undefined 只表示旧数据；新数据必须显式写 none
 * 或完整快照，避免 fork 时读取 parent 当前 goal 冒充历史状态。
 * 生产者：stable fork resolver 在 commitForkBundle 时固化；
 * 消费者：fork 恢复/续跑，防止父会话 goal 漂移污染 child 边界。
 * none 是显式“无目标”，与字段缺失（旧数据）语义不同，读侧必须区分。
 */
export type StableForkGoalBoundaryMetadata =
  | { kind: "none" }
  | {
      kind: "snapshot";
      // fork 点父会话目标的完整快照；child 只读，不能据此重跑父目标。
      target: SessionGoal;
      // fork 时已存在的目标校验 entry id；child 不得重新校验父目标。
      verificationEntryIds: string[];
    };

/**
 * v4 transcript 锚点（清单）：全部 optional，
 * 走 message JSON blob 的 additive 演进，历史数据留空、读侧宽容降级。
 * sourceCommandId 是命令幂等的 transcript 兜底查重键，
 * 由 v4 command inbox 铺路后写入（接线）。
 * 生产者：message 持久化路径（含 synthetic notice 与 fork copy）；
 * 消费者：V4 投影、cold hydrate、stable fork 边界恢复。
 * 不变量：anchor 一旦写入即随消息持久化，读侧不得用运行时会话状态回填缺失字段。
 */
export interface MessageProjectionAnchor {
  // 该消息所属的运行时轮次；缺失表示历史/合成消息，不能按当前 turn 补写。
  turnId?: TurnId;
  // V4 row 来源词；与 semantics.origin 并存，展示派生以本字段为准。
  origin?: MessageAnchorOrigin;
  // 产生该消息的用户命令 id；transcript 幂等查重键，自动/系统消息缺省。
  sourceCommandId?: string;
  /** 最终 assistant 固化当前 query 的历史轮次，供 cold hydration 精确恢复。 */
  historyRoundCount?: number;
  /** 新数据的 stable fork 固定边界；历史消息缺省，由唯一 resolver 无歧义时惰性补写。 */
  productTurnId?: string;
  // fork 边界内消息的稳定顺序；用于 child 重放，不能按时间戳重排。
  orderedMessageIds?: MessageId[];
  // fork 的边界消息 id；与 orderedMessageIds 一起定义复制的消息集合。
  boundaryMessageId?: MessageId;
  // fork 点的 goal 事实；缺省表示旧数据，不得读取父会话当前目标代替。
  goalBoundary?: StableForkGoalBoundaryMetadata;
}

// 会话元信息：session 行 + 投影身份的持久化形态。生产者是 createSession/updateSession/
// 标题同步/软删除；消费者是 getSession/listSessions、冷恢复与 V4 列表。
// 跨进程不变量：workspaceID 是不透明隔离键，path 只是展示/定位路径，二者不得互推；
// 软删除只写 time.deleted，正文保留但普通列表永远过滤。
export interface SessionInfo {
  // 会话主键；与 eventStore/ledger 的 sessionID 必须一致。
  id: SessionId;
  // 项目隔离键；跨项目不得复用同一 session。
  projectID: ProjectId;
  // workspace identity（不透明隔离键）；缺失表示 legacy/本地未认领，不能由 directory 推断。
  workspaceID?: WorkspaceId;
  // 父会话（fork/subagent/workflow child）；interactive 根会话缺省。
  parentID?: SessionId;
  // 追踪 id；用于日志/遥测串联，不参与业务判定。
  traceID?: TraceId;
  // 任务类型；决定权限、用量归因与 fork 语义。
  taskType: SessionTaskType;
  // 人类可读短标识；用于展示/目录命名，不保证全局唯一。
  slug: string;
  // 项目根目录；用于权限匹配与 checkpoint，不是会话存储目录。
  directory: string;
  // 远端/显式工作路径；与 directory 可不同，缺失表示沿用 directory。
  path?: string;
  // 展示标题；可被 first_input/generated 覆盖，custom 后必须 CAS 保护。
  title: string;
  // 标题来源；与 expectedTitleSources 配合防止后台任务覆盖用户标题。
  titleSource?: SessionTitleSource;
  // 标题所依据的消息 id；与 titleSource 一起定位“标题来自哪条消息”。
  titleMessageID?: MessageId;
  // 写入该会话的宿主版本；仅用于兼容旧数据，不用于运行时路由。
  version: string;
  // 最近一次终态结果；列表展示与冷启动判断用，不代表当前运行状态。
  lastOutcome?: SessionLastOutcome;
  // 分享链接；只影响展示，不改变会话可见性。
  shareURL?: string;
  // 摘要新增行数；来自消息摘要，仅供列表展示。
  summaryAdditions?: number;
  // 摘要删除行数；配合 additions/files 展示。
  summaryDeletions?: number;
  // 摘要涉及文件数；配合 diff 统计展示。
  summaryFiles?: number;
  // 摘要 diff 明细；可选，读侧不得据此重建文件内容。
  summaryDiffs?: FileDiff[];
  // 当前回退指针；append-only 分支的 cut 游标/generation 都在这里。
  revert?: SessionRevert;
  // 会话级权限规则快照；与项目默认权限分离，恢复时必须沿用落盘值。
  permission?: PermissionRuleset;
  // 生命周期时间戳（unix ms）；软删除只写 deleted，不物理删除行。
  time: {
    // 创建时间；不随后续活动变化。
    created: number;
    // 最近活动时间；是否刷新由写入方的 touchSession 决定。
    updated: number;
    // 标题最近更新时间；用于标题同步的先后比较。
    titleUpdated?: number;
    // compact 开始时间；进行中标记，完成后清空。
    compacting?: number;
    // 软删除时间；有值即对普通列表不可见。
    deleted?: number;
  };
}

// 创建会话的持久化输入；id 由调用方预生成，重试/幂等必须复用同一 id。
// 生产者是 createSession 与 fork child 构造；消费者是 adapter 插入 session 行。
// 跨进程不变量：workspaceID 缺失即“未认领”，不得在插入时由 directory 反推；
// titleSource/titleMessageID 首次写入后由标题更新路径 CAS 维护。
export interface CreateSessionInput {
  // 调用方预生成的会话主键；同 id 重复创建必须幂等，不能生成新 id。
  id: SessionId;
  // 项目隔离键。
  projectID: ProjectId;
  // workspace identity；缺失保持 null，等待 claim/repair 路径补写。
  workspaceID?: WorkspaceId;
  // 父会话；fork/subagent/workflow child 必须携带，根会话缺省。
  parentID?: SessionId;
  // 追踪 id；仅遥测串联。
  traceID?: TraceId;
  // 任务类型；缺省由 adapter 按 interactive 落地。
  taskType?: SessionTaskType;
  // 短标识；用于展示与目录命名。
  slug: string;
  // 项目根目录。
  directory: string;
  // 显式工作路径；缺省沿用 directory。
  path?: string;
  // 初始标题；后续可由 first_input/generated/custom 覆盖。
  title: string;
  // 初始标题来源；缺省视为 default 占位。
  titleSource?: SessionTitleSource;
  // 标题依据消息；首条输入前可缺省。
  titleMessageID?: MessageId;
  // 宿主版本号；写库时记录，供兼容判断。
  version: string;
  // 分享链接；可选。
  shareURL?: string;
  // 初始会话级权限快照；缺省回落到项目权限。
  permission?: PermissionRuleset;
  // 可覆盖创建/更新时间；仅导入/迁移用于保持原始时序。
  time?: {
    created?: number;
    updated?: number;
  };
}

/** V4 stable fork resolver 固定的目标 product turn segment。 */
// 生产者：stable fork resolver（conversation fork 提交前完成 remap）；
// 消费者：commitForkBundle 与 child 重放。字段是 product/transcript 双 id，
// 用于把运行时轮次映射到持久消息集合，缺失时 fork 不能猜测顺序。
export interface StableForkTargetMetadata {
  // product 侧轮次 id（V4 视图），与 transcript 轮次一一映射。
  productTurnId: string;
  // 持久化 transcript 轮次 id；恢复时按该值定位消息集合。
  transcriptTurnId: string;
  // 固定顺序的消息 id 列表；禁止按时间戳或落盘顺序重排。
  orderedMessageIds: string[];
  // fork 的边界消息 id；与 orderedMessageIds 一起定义复制范围。
  boundaryMessageId: string;
}

/** 与 child session 同事务落盘的命令幂等事实。 */
// 生产者：fork 命令处理路径，在创建 child 的同一事务中写入；
// 消费者：命令重放/去重与 fork 恢复。sourceCommandId 必须在父/子两侧一致，
// 否则重复 fork 会产生第二个 child。该事实不参与业务裁决，只保证幂等可查。
export interface ForkChildSessionMetadata {
  // 父会话 id；用于校验命令归属，防止跨会话重放。
  parentSessionId: string;
  // 触发 fork 的用户命令 id；全局幂等键。
  sourceCommandId: string;
  // 固定 fork 目标轮次/消息边界。
  forkTarget: StableForkTargetMetadata;
}

// fork 命令的已接受结果；持久化在 commandFact.ack.result，供命令重放还原跳转目标。
// 生产者：v4 command inbox 处理 fork 命令时；消费者：命令幂等回放与 UI 跳转。
// 三种 type 对应 forkAssistant / 选择侧边会话 / 编辑用户 query 的分叉处置，
// 新增分支必须同时定义 ack.result 持久 schema，不能只扩展内存 union。
export type ForkCommandResult =
  // 从 assistant 消息处分叉出新会话。
  | { type: "forkAssistant"; sessionId: string }
  // 创建独立的 selection side session。
  | { type: "createSelectionSideSession"; sessionId: string }
  // 编辑用户 query 并 fork；disposition 固定为 fork。
  | { type: "editUserQuery"; disposition: "fork"; sessionId: string };

/**
 * conversation fork 的唯一原子提交载荷。core 在内存完成 remap；adapter 不参与业务裁决，
 * 只保证 child/copy/goal/entries/input/parent command fact 全有或全无。
 * 生产者：core 的 fork 命令处理（stable/compact-edit fork）；
 * 消费者：adapter 的 commitForkBundle 单事务写入。
 * 不变量：child 与 messages/entries 必须在同一事务内落库；任何一步失败整体回滚，
 * 不允许留下“有 child 无消息”的半个 fork。
 */
export interface ForkCommitBundle {
  // 待创建的 child session 行（含 parentID/title 等）。
  child: CreateSessionInput;
  // 从父会话复制/remap 的消息及 parts；顺序由 forkTarget 固定。
  messages: MessageWithParts[];
  // 随 fork 一并复制的 session entries（目标/配置等）。
  entries: SessionEntryInfo[];
  /** 存储复制来源（目标 ID -> 父记录 ID）；只保留旧磁盘快照，不参与模型选择。 */
  copySources?: { messages: Record<string, string>; parts: Record<string, string> };
  // 父会话 goal 的 fork 快照；缺省表示父无目标或旧路径。
  goal?: { source: SessionGoal; status: GoalStatus };
  // child 的首条输入（admission 记录），与 fork 同事务落库。
  initialInput?: {
    // input/command id；幂等键。
    id: string;
    // 归属 child 会话。
    sessionID: SessionId;
    // 输入种类；由命令面定义。
    kind: string;
    // 投递方式；fork 首条输入通常为 queue/startNow。
    delivery: SessionInputDelivery;
    // 输入载荷；text 必填，其余字段由命令面透传。
    payload: { text: string; [key: string]: unknown };
  };
  // 父命令幂等事实；与 child 同事务写入，防止重复 fork。
  commandFact: {
    // 父会话 id。
    parentSessionId: string;
    // 触发命令 id。
    sourceCommandId: string;
    // 已接受 ack；revisionAtDecision 是决策时的命令 revision。
    ack: {
      commandId: string;
      status: "accepted";
      revisionAtDecision: number;
      result: ForkCommandResult;
    };
    // 附加领域元数据；读侧不得据此改写业务结果。
    metadata: Record<string, unknown>;
  };
}

// 会话增量更新；字段缺省表示“不修改”，null 表示“显式清空”
// （path/titleMessageID/shareURL/summary/revert/permission/timeCompacting）。
// 生产者是标题同步/元数据维护/revert 写入；消费者是 adapter 的 UPDATE 实现。
// 跨进程不变量：title 变更必须带 expectedTitleSources 做 CAS，否则后台生成的
// generated 标题可能覆盖用户 custom；timeUpdated 只能单调推进，不得回退。
export interface UpdateSessionInput {
  // 目标会话；不存在时实现必须报错，不能静默新建。
  id: SessionId;
  // 最近结果；turn 终态时写入。
  lastOutcome?: SessionLastOutcome;
  // 目录修正；legacy 自愈路径使用。
  directory?: string;
  // 工作路径；null 表示清除显式路径回落到 directory。
  path?: string | null;
  // 活动时间推进；必须单调，不得回退。
  timeUpdated?: number;
  // 新标题正文。
  title?: string;
  // 配套标题来源；与 expectedTitleSources 配合做 CAS。
  titleSource?: SessionTitleSource;
  // 标题依据消息；null 表示解除关联。
  titleMessageID?: MessageId | null;
  // CAS 条件：仅当当前 titleSource 落在该集合内才允许改标题；
  // 缺省/空数组表示不限制，后台生成标题必须限定为 default/first_input。
  expectedTitleSources?: readonly SessionTitleSource[];
  // 分享链接；null 表示删除。
  shareURL?: string | null;
  // 摘要统计；null 表示整体清除。
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
    diffs?: FileDiff[];
  } | null;
  // 回退指针；null 表示清除（回到活动分支）。
  revert?: SessionRevert | null;
  // 会话级权限；null 表示回落到项目权限。
  permission?: PermissionRuleset | null;
  // compact 进行中标记；null 表示结束。
  timeCompacting?: number | null;
}

// 文件变更统计；用于会话摘要与 UI 展示，不参与文件恢复。
// 生产者：turn 完成时的 diff 汇总；消费者：列表摘要、V4 变更面板。
export interface FileDiff {
  // 变更文件路径；重命名时 oldPath/newPath 描述迁移。
  path: string;
  // 新增行数；仅统计文本行，不含二进制内容。
  additions: number;
  // 删除行数；与 additions 一起构成摘要。
  deletions: number;
  // 重命名前路径；缺失表示非重命名。
  oldPath?: string;
  // 重命名后路径；缺失表示非重命名。
  newPath?: string;
}

// 会话回退指针：记录一次 rewind 的目标、范围与分支 cut。生产者是 /rewind 命令与
// workspace file rewind；消费者是冷恢复（resume.ts）与会话列表。
// 不变量：conversation rewind 必须同时推进 branchCutAfterMessageID 与 branchGeneration，
// 二者组成 append-only 活动分支；旧分支的异步结果按 generation 识别并丢弃。
export interface SessionRevert {
  // 被回退到的消息 id（旧入口）；新路径以 targetMessageID/branchCutAfterMessageID 为准。
  messageID: MessageId;
  // 被回退到的 part；缺省表示整条消息。
  partID?: PartId;
  // workspace 快照标识；scope 含 workspace 时用于文件恢复。
  snapshot?: string;
  // 文件 diff；可选，读侧不得据此重建文件内容。
  diff?: string;
  // rewind 种类；conversation_rewind 表示对话分支剪切。
  kind?: "conversation_rewind";
  // 回退范围：conversation / workspace / both；决定是否同时恢复文件。
  scope?: "conversation" | "workspace" | "both";
  // 新语义回退目标消息；冷恢复优先读取该值。
  targetMessageID?: MessageId;
  // 兼容字段：旧实现记录的“回退后新建消息”；新逻辑以 branchCutAfterMessageID 为准。
  createdMessageID?: MessageId;
  // 回退后保留的消息 id 列表；active branch 成员必须连续且顺序稳定。
  keptMessageIDs?: MessageId[];
  /**
   * append-only conversation branch 的 cut 游标：本次 rewind 提交前最后一条持久消息。
   * active branch = keptMessageIDs + 该消息之后新追加的消息。旧 createdMessageID 仅用于兼容。
   * 游标只前进不回退；恢复时若缺失则不能安全重建分支，必须降级为只读历史。
   */
  branchCutAfterMessageID?: MessageId;
  // generation 是分支隔离版本：destructive rewind 后旧分支的异步 tool/stream 结果
  // 必须被丢弃，不能写回新分支；比较以该值为准，不能用时间戳。
  /** 每次 destructive conversation rewind 单调递增，用于隔离旧分支异步结果。 */
  branchGeneration?: number;
}

// 会话列表过滤条件；字段全部 optional，缺省表示不限。
// 生产者：bootstrap CLI 列表/选择器；消费者：adapter listSessions。
// 不变量：workspaceID 的三态语义不可合并（undefined/null/字符串），
// 否则 legacy 空 identity 与“不过滤”会混淆；软删除行永远不返回。
export interface ListSessionsInput {
  // 项目过滤；缺省跨项目。
  projectID?: ProjectId;
  /** undefined = 不按 identity 过滤；null = 仅本地/legacy 空 identity；字符串 = 精确 workspace identity。 */
  workspaceID?: WorkspaceId | null;
  // 精确目录过滤；与 path 独立。
  directory?: string;
  // 精确工作路径过滤。
  path?: string;
  // 仅根会话（无 parentID）；用于列表主视图。
  roots?: boolean;
  // 任务类型过滤；缺省全部。
  taskTypes?: SessionTaskType[];
  // 最大返回条数；实现按 updated 倒序截断。
  limit?: number;
}

// legacy session workspace 认领：host 提供 task-index allowlist 与 identity。
// 生产者：启动迁移/修复；消费者：adapter claimLegacySessionWorkspace（CAS 写 workspace_id）。
// 不变量：只允许把 workspace_id 从 NULL 写为目标值，不得覆盖已有 identity。
export interface ClaimLegacySessionWorkspaceInput {
  // 待认领的 session id 列表；实现必须逐条校验。
  sessionIDs: SessionId[];
  // 这些 session 已知的目录；必须与库中 directory 精确匹配。
  directory: string;
  // 目标 workspace identity。
  workspaceID: WorkspaceId;
}

// 单条历史 session 的 workspace 修复输入：曾把 remote identity 误写入 directory/path。
// 生产者：启动自愈；消费者：adapter repairLegacyRemoteSessionWorkspace。
// 不变量：只允许 session id + NULL workspace_id + 旧目录精确匹配的单条修复，
// 禁止批量路径迁移，也不得覆盖已存在的 identity。
export interface RepairLegacyRemoteSessionWorkspaceInput {
  // 目标 session。
  sessionID: SessionId;
  // 归属项目。
  projectID: ProjectId;
  // 被误写的旧目录；必须与库中值精确匹配。
  legacyWorkspaceDirectory: string;
  // 目标 workspace identity。
  workspaceID: WorkspaceId;
  // 修复后的工作路径。
  workspacePath: string;
}

// 已有 remote identity 的路径自愈 CAS；只修 directory/path，不碰其它元数据。
// 生产者：路径检测/自愈流程；消费者：adapter repairRemoteSessionPaths。
// 不变量：expectedDirectory/expectedPath 是 CAS 前置条件，不匹配即失败；
// timeUpdated 必须单调，防止并发修复互相覆盖。
export interface RepairRemoteSessionPathsInput {
  // 目标 session。
  sessionID: SessionId;
  // 必须已存在的 workspace identity。
  workspaceID: WorkspaceId;
  // CAS 期望的当前目录。
  expectedDirectory: string;
  // CAS 期望的当前路径；null 表示当前无显式路径。
  expectedPath: string | null;
  // 修复后的目录。
  directory: string;
  // 修复后的路径；null 表示清除显式路径。
  path: string | null;
  // 单调推进的更新时间。
  timeUpdated: number;
}

// 结构化输出约束；text 为自由文本，json_schema 要求模型按 schema 输出。
// 生产者：命令面/subagent 调用；消费者：模型请求与响应解析。retryCount 只影响校验重试，
// 不改变持久消息结构；schema 非法必须在请求前拒绝，不能交给模型兜底。
export type OutputFormat =
  // 自由文本输出。
  | { type: "text" }
  // 按 JSON Schema 输出；retryCount 为校验失败后的重试次数。
  | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };

// 消息摘要（旧读侧展示用）；由 assistant 完成时生成，供列表/回放展示。
// 不参与模型上下文，也不得据此重建消息正文。
export interface MessageSummary {
  // 摘要标题；可缺省。
  title?: string;
  // 摘要正文；可缺省。
  body?: string;
  // 本次消息涉及的文件 diff；空数组表示无变更。
  diffs: FileDiff[];
}

// 消息级上下文快照：记录当次请求的环境信息（cwd/git 等）。
// 生产者：prompt 持久化路径；消费者：冷恢复/回放展示。仅存档，
// 不得用旧快照替代当前环境参与权限或工具执行。
export interface MessageContextSnapshot {
  // 环境信息；字段随 EnvInfo 演进，读侧必须宽容缺失。
  envInfo?: EnvInfo;
}

// 用户消息（transcript 的 user 行）。生产者是 prompt admission/promotion 与 synthetic notice；
// 消费者是模型上下文构造、transcript 渲染与命令幂等查重。
// 跨进程不变量：user message 必须先于 parts 落库；message 是轮次归属的唯一锚点，
// synthetic/visibility/semantics/anchor 必须随消息持久化，读侧不得反推。
export interface UserMessageInfo {
  // 消息主键；由 createMessageId 生成，promotion 时写入账本。
  id: MessageId;
  // 所属会话。
  sessionID: SessionId;
  // 固定角色；user 行不可被改写为 assistant。
  role: "user";
  // 创建时间；用于排序，不能替代 eventSeq。
  time: {
    created: number;
  };
  // 输出格式约束；仅该轮请求生效，不改变后续消息。
  format?: OutputFormat;
  // 消息摘要；展示用，不参与模型上下文。
  summary?: MessageSummary;
  // 产生该消息的 agent 名；用于归因与权限上下文。
  agent: string;
  /** 未绑定会话的合成消息、缺少模型信息的旧消息不伪造请求来源。 */
  modelSelection?: ModelSelection;
  // 旧字段 system prompt 覆盖；新路径不得依赖它重建模型输入。
  system?: string;
  // 工具开关快照；仅记录当次请求意图，不是权限裁决结果。
  tools?: Record<string, boolean>;
  // 请求环境快照；仅存档，不参与当前执行。
  contextSnapshot?: MessageContextSnapshot;
  // 是否为运行时合成的 user 消息；true 时 source 必须给出具体来源。
  synthetic?: boolean;
  // synthetic 来源；非 synthetic 消息缺省。
  source?: SyntheticUserMessageSource;
  // 可见性：model-only 只进模型上下文，不展示给用户。
  visibility?: MessageVisibility;
  // 旧读侧语义；新写入与 anchor 并存，冲突时读侧以 anchor 为准。
  semantics?: MessageSemantics;
  // V4 投影锚点；turn/来源/命令幂等键/分支边界都在这里。
  anchor?: MessageProjectionAnchor;
  // 附加领域语义（如 fork copy provenance、highspeed 元数据）；随消息 JSON 持久化，
  // 读侧不得用运行时状态覆盖，禁止写入 secrets 或大体量二进制。
  metadata?: Record<string, unknown>;
}

// assistant 消息上的错误归因：name 是错误类名，data 是结构化上下文。
// 生产者：模型/工具失败路径；消费者：UI 错误展示与重试判定。仅归因，
// 不得用 data 中的文本替代结构化错误码做路由。
export interface AssistantErrorInfo {
  // 错误类名；用于分类与 UI 图标。
  name: string;
  // 结构化上下文；可能含 provider 错误码，禁止放入 secrets。
  data?: Record<string, unknown>;
}

// token 用量快照；来自 provider usage，缺省字段表示未提供而非 0。
// 生产者：模型响应/步骤完成；消费者：计费展示、compact 触发与用量账本。
// 不变量：total 优先采用 provider 权威总量，不得用本地估算冒充。
export interface TokenUsageInfo {
  // provider 报告的总量；缺失时由各分项推导。
  total?: number;
  // 输入 token。
  input: number;
  // 输出 token。
  output: number;
  // 推理 token；部分 provider 计入 output，读侧需按 provider 口径解释。
  reasoning: number;
  // 缓存读写量；用于成本归因。
  cache: {
    // 缓存命中读取量。
    read: number;
    // 缓存写入量。
    write: number;
  };
}

// assistant 消息（transcript 的 assistant 行）。生产者是模型输出固化；
// 消费者是模型上下文重建、transcript 渲染与 usage 归因。
// 不变量：assistant 消息必须绑定 parentID（其回复的 user 消息），且先于 parts 落库；
// model/provider 元数据缺失只允许出现在历史/合成时间线，新输出不得省略。
export interface AssistantMessageInfo {
  // 消息主键。
  id: MessageId;
  // 所属会话。
  sessionID: SessionId;
  // 固定角色；assistant 行不可改写为 user。
  role: "assistant";
  // 创建/完成时间；completed 缺失表示仍在流式或已中断。
  time: {
    created: number;
    completed?: number;
  };
  // 错误归因；成功消息缺省。
  error?: AssistantErrorInfo;
  // 所属 user 消息；轮次归属与树形回放依赖该字段。
  parentID: MessageId;
  /** 真正模型输出应携带来源；历史恢复的合成时间线允许没有执行模型。 */
  modelId?: ModelId;
  // provider 标识；与 modelId 一起构成实际路由目标。
  providerId?: ModelProviderId;
  // 当时的协作/执行模式字符串；用于历史解释，不是当前模式来源。
  mode: string;
  /** 当前输出对应的 Plan 状态；旧记录缺失时按旧 mode 解释，不回填历史。 */
  planEnabled?: boolean;
  // 产生该输出的 agent 名。
  agent: string;
  // 执行路径快照：cwd 与项目 root；用于回放定位，不参与权限。
  path: {
    cwd: string;
    root: string;
  };
  // 是否为压缩/摘要消息；true 时不作为普通轮次计入。
  summary?: boolean;
  // 该消息成本；来自 provider usage。
  cost: number;
  // token 用量快照。
  tokens: TokenUsageInfo;
  // 结构化输出结果；仅在 OutputFormat=json_schema 时有意义。
  structured?: unknown;
  // 推理强度；记录当时设置，不参与当前路由。
  reasoningLevel?: string;
  // finish reason；缺失表示未正常结束。
  finish?: string;
  // 旧读侧语义；与 anchor 并存，冲突时读侧以 anchor 为准。
  semantics?: MessageSemantics;
  // V4 投影锚点；turn/来源/分支边界。
  anchor?: MessageProjectionAnchor;
  /** 附加领域语义（fork copy 的 forkOrigin provenance 等）。 */
  // 随消息 JSON 持久化，读侧不得用运行时状态覆盖，禁止写入 secrets。
  metadata?: Record<string, unknown>;
}

// 消息联合：user 或 assistant。读侧必须按 role 收窄，不能把两者字段混用；
// 生产端各自只写对应 role 的结构，禁止用 user 行承载 assistant 语义。
export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

// 文本 part：消息正文的最小持久单元。生产者是流式/最终正文固化；
// 消费者是模型上下文与 transcript。不变量：part 必须挂在已落库的 messageID 下，
// 不得先于 message 写入；synthetic/ignored 决定读侧是否展示或送模型。
export interface TextPart {
  // part 主键；与 messageID 联合定位。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "text";
  // 正文内容；流式期间可被覆盖更新。
  text: string;
  // 是否为运行时合成文本；true 时通常 ignored。
  synthetic?: boolean;
  // 是否忽略（不送模型/不展示）；与 synthetic 独立。
  ignored?: boolean;
  // 流式时间窗；end 缺失表示未结束。
  time?: {
    start: number;
    end?: number;
  };
  // 附加展示/领域元数据；随 part JSON 持久化，不得影响模型输入结构。
  metadata?: Record<string, unknown>;
}

// 推理 part：模型 reasoning 文本的持久单元。生产者是推理流固化；
// 消费者是 UI 折叠展示与可选上下文回放。通常不进入普通模型上下文，
// 是否送模型由读侧策略决定；part 必须挂在已落库 messageID 下。
export interface ReasoningPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "reasoning";
  // 推理文本。
  text: string;
  // 附加元数据；不得写入 provider 原始密钥。
  metadata?: Record<string, unknown>;
  // 推理时间窗；end 缺失表示仍在流式。
  time: {
    start: number;
    end?: number;
  };
}

// 文件 part 的来源描述：file/symbol/resource 三种引用；text 是引用处的原文片段与偏移。
// 生产者：prompt 附件/工具读取路径；消费者：模型上下文重建与 UI 溯源。
// 偏移 start/end 以原始文本为准，不得在读取时重新裁剪后回写。
export type FilePartSource =
  | {
      // 整文件引用。
      type: "file";
      // 文件路径（相对项目根或绝对路径，由生产者决定）。
      path: string;
      // 引用处原文与字符偏移。
      text: { value: string; start: number; end: number };
    }
  | {
      // 符号引用（函数/类等）。
      type: "symbol";
      // 符号所在文件路径。
      path: string;
      // 符号范围；结构由语言服务定义，读侧不得强转。
      range: unknown;
      // 符号名。
      name: string;
      // 符号种类编号；由语言服务定义。
      kind: number;
      // 引用处原文与偏移。
      text: { value: string; start: number; end: number };
    }
  | {
      // 外部资源引用（MCP resource 等）。
      type: "resource";
      // 提供该资源的客户端名。
      clientName: string;
      // 资源 URI；作为恢复定位键。
      uri: string;
      // 引用处原文与偏移。
      text: { value: string; start: number; end: number };
    };

// 附件存储元数据：记录附件如何存放、能否恢复以及预览信息。
// 生产者：附件 externalize/materialize 路径；消费者：模型请求重建与断流恢复。
// 不变量：recoverability 是恢复决策依据，不能仅凭 url 猜测；preview 只用于展示/兜底，
// 不得冒充完整附件内容。
export interface AttachmentStorageMetadata {
  // 原始字节数；用于配额与截断判断。
  sizeBytes?: number;
  // 内容 sha256；用于去重与完整性校验，不用于加密。
  sha256?: string;
  // 图片变换信息；非图片附件缺省。
  image?: {
    // 允许的最大边长。
    maxDimension?: number;
    // 原始宽度。
    originalWidth?: number;
    // 原始高度。
    originalHeight?: number;
    // 变换后宽度。
    width?: number;
    // 变换后高度。
    height?: number;
    // 是否发生缩放。
    resized?: boolean;
    // 变换后字节数。
    transformedSizeBytes?: number;
  };
  // 存储形态：inline 内联、artifact 归档、local/remote 引用、仅元数据。
  storageKind?: "inline" | "artifact" | "local_ref" | "remote_ref" | "metadata_only";
  // artifact 存储 URI；storageKind=artifact 时使用。
  artifactUri?: string;
  // 原始远端 URL；仅溯源，不作为恢复来源。
  originalUrl?: string;
  // 路径引用首次发送时的完整说明；恢复时必须原样复用，不能用 preview 代替。
  /** 路径引用首次发送的完整说明；恢复时原样复用，不能用文件内容 preview 代替。 */
  pathReferenceText?: string;
  // 可恢复等级：provider_ready 可直接重发；rebuildable 可重建；preview_only/metadata_only/missing 不可恢复原文。
  recoverability?: "provider_ready" | "rebuildable" | "preview_only" | "metadata_only" | "missing";
  // 预览内容；仅在无法恢复原文时用于展示。
  preview?: {
    // 预览文本。
    text?: string;
    // 是否被截断。
    truncated?: boolean;
    // 截断前原始字节数。
    originalBytes?: number;
    // 预览起始行。
    startLine?: number;
    // 原始总行数。
    totalLines?: number;
    // 是否因 token 上限被截断。
    truncatedByTokenCap?: boolean;
    // 部分视图提示文案；UI 原样展示。
    partialViewNotice?: string;
  };
  // 失败错误码；用于恢复策略选择。
  errorCode?: string;
}

// 文件 part：附件/图片/引用的持久单元。url 指向附件内容（artifact 或原始 URL），
// metadata 记录存储与可恢复性。生产者：附件 externalize；消费者：模型请求重建。
// 不变量：part 必须挂在已落库 messageID 下；恢复时按 metadata.recoverability 决定
// 能否重发，不能仅凭 url 猜测内容仍在。
export interface FilePart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "file";
  // MIME 类型；用于 provider 能力判断。
  mime: string;
  // 原始文件名；仅展示与引用，不用于路径解析。
  filename?: string;
  // 内容定位 URL（artifact/file/远端）；读侧必须结合 metadata 判断可用性。
  url: string;
  // 引用来源（整文件/符号/资源）。
  source?: FilePartSource;
  // 存储与可恢复性元数据；恢复决策的唯一依据。
  metadata?: AttachmentStorageMetadata;
}

// agent part：用户显式 @agent 的持久记录。生产者是 prompt 解析；
// 消费者是 UI 展示与路由提示。agent 名只做上下文提示，不改变权限模式；
// 真正执行 agent 由运行时决定，不能仅凭该 part 提升权限。
export interface AgentPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "agent";
  // agent 名；大小写/别名由解析层规范化。
  name: string;
  // 在原文中的位置；用于高亮，缺失表示整段输入。
  source?: {
    // 引用原文。
    value: string;
    // 起始偏移。
    start: number;
    // 结束偏移。
    end: number;
  };
}

// 压缩 part：记录一次上下文压缩的触发、边界与 token 变化。
// 生产者：compact 流程（同时写 compact entry/timeline）；消费者：冷恢复判断历史边界。
// 不变量：boundaryId/operationId 是幂等键，重试必须复用；压缩是追加 part，
// 不得回写或删除被压缩的原始消息。
export interface CompactionPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "compaction";
  // 是否自动触发；false 表示用户手动 /compact。
  auto: boolean;
  // 触发原因分类。
  trigger?: CompactTrigger;
  // 压缩阶段（开始/完成等）。
  phase?: CompactPhase;
  // 压缩原因。
  compactReason?: CompactReason;
  // 是否因上下文溢出触发。
  overflow?: boolean;
  // 保留的尾部起始消息 id（旧字段）。
  tail_start_id?: MessageId;
  // 压缩边界载荷；冷恢复据此切分历史。
  compactBoundary?: CompactBoundaryPayload;
  // 本次操作 id；重试幂等键。
  operationId?: string;
  // 时间线展示状态。
  timelineStatus?: CompactTimelineStatus;
  // 时间线展示形态（分隔线/worklog）。
  timelineDisplay?: CompactTimelineDisplay;
  // 时间线文案；UI 原样展示。
  timelineText?: string;
  // 是否以该压缩替换旧摘要。
  replace?: boolean;
  // 失败/跳过原因；成功时缺省。
  reason?: string;
  // 压缩边界 id；与 operationId 一起定位。
  boundaryId?: string;
  // 摘要消息 id；指向生成的 compact summary。
  summaryMessageId?: MessageId;
  // 压缩前 token 数；用于展示压缩比。
  preCompactTokenCount?: number;
  // 估算压缩后 token 数。
  postCompactTokenCount?: number;
  // provider 权威压缩后 token 数；缺失表示未返回。
  truePostCompactTokenCount?: number;
  // 当前尝试次数。
  attempt?: number;
  // 最大尝试次数。
  maxAttempts?: number;
  // 压缩时间窗；end 缺失表示未结束。
  time?: {
    start?: number;
    end?: number;
  };
}

// 时间线 part 的展示形态：separator 只画分隔线，worklog 进工作日志面板。
// 生产者：compact/goal/fork/model-change 等时间线写入；消费者：V4/transcript UI。
// 展示形态只影响 UI，不改变该 part 是否进入模型上下文（timeline 默认不进入）。
export type TimelinePartDisplay = "separator" | "worklog";

// 时间线过程状态；前五个是已知闭集，末尾 string 为向前兼容的扩展值。
// 生产者：各时间线写入方；消费者：UI 状态样式与恢复判断。终态不得回退。
export type TimelinePartStatus =
  // 已发起、未结束。
  | "started"
  // 正常完成。
  | "completed"
  // 失败终止。
  | "failed"
  // 被中断（流中断/进程退出）。
  | "interrupted"
  // 主动取消。
  | "cancelled"
  // 扩展状态；读侧必须能容忍未知值。
  | string;

// 时间线里的模型选择快照：在 ModelSelection 基础上加 label 供 UI 展示。
// 生产者：model-change 时间线；消费者：历史展示。label 仅展示，不参与路由。
export interface TimelineModelSelection extends ModelSelection {
  // 展示用模型名；缺失时 UI 回落到 modelId。
  label?: string;
}

// 所有时间线 part 的公共基座：锚定到某条消息/轮次，供 UI 插线与冷恢复定位。
// 生产者：compact/goal/fork/model-change 等运行时事件；消费者：V4 时间线渲染与恢复。
// 不变量：timeline part 默认只做展示/审计，不进入模型上下文；anchor 指向的消息
// 必须存在，fork copy 降级时本地 anchor 必须清空、原引用降级到 origin*。
export interface TimelinePartBase {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 宿主消息 id；时间线 part 仍然挂在某条消息下。
  messageID: MessageId;
  // 固定类型判别符。
  type: "timeline";
  // 展示形态：分隔线或工作日志。
  display: TimelinePartDisplay;
  // 过程状态；终态不可回退。
  status?: TimelinePartStatus;
  // 插线所锚定的消息；缺失表示按 messageID 自身位置。
  anchorMessageId?: MessageId;
  // 插线所锚定的轮次；跨进程恢复按它归属。
  anchorTurnId?: TurnId;
  /** 用户命令产生的 marker 查重锚点；auto/system marker 缺省。 */
  // 命令幂等：同一 sourceCommandId 的 marker 不得重复插入。
  sourceCommandId?: string;
  /**
   * fork copy 降级 provenance：anchor 指向未被复制的消息/父轮时，
   * 本地 anchor 必须清空（不得参与 child 落位），原引用降级到 origin* 仅供溯源。
   */
  // originAnchor* 只用于展示溯源，禁止被 fork child 当作有效落位锚点。
  originAnchorMessageId?: MessageId;
  originAnchorTurnId?: TurnId;
  // 时间窗；end 缺失表示未结束。
  time?: {
    start?: number;
    end?: number;
  };
}

// 压缩时间线：把一次 compact 作为分隔线/worklog 插入 transcript。
// 生产者：compact 流程；消费者：UI 历史边界展示与冷恢复。
// 不变量：operationId/boundaryId/summaryMessageId 是幂等定位键；
// 同一压缩事件重放必须覆盖同一 part，不能重复插线。
export interface ContextCompactionTimelinePart extends TimelinePartBase {
  // 固定时间线子类型。
  timelineType: "context_compaction";
  // 本次压缩操作 id；幂等键。
  operationId: string;
  // 触发原因分类。
  trigger: CompactTrigger;
  // 压缩阶段；缺失表示旧数据。
  phase?: CompactPhase;
  // 压缩原因。
  compactReason?: CompactReason;
  // 压缩边界 id；用于切分历史。
  boundaryId?: string;
  // 摘要消息 id；指向 compact summary。
  summaryMessageId?: MessageId;
  // 压缩前 token 数。
  preCompactTokenCount?: number;
  // 估算压缩后 token 数。
  postCompactTokenCount?: number;
  // provider 权威压缩后 token 数。
  truePostCompactTokenCount?: number;
  // 当前尝试次数。
  attempt?: number;
  // 最大尝试次数。
  maxAttempts?: number;
  // 失败/跳过原因。
  reason?: string;
}

// 目标校验时间线：每次目标完成校验在历史中留一条过程记录。
// 生产者：target-completion-verification；消费者：V4/恢复 UI。
// 不变量：verificationId 是幂等键，goalIteration 用于同目标多轮分组；
// 终态结果写入同一 part，不另起一条。
export interface GoalVerificationTimelinePart extends TimelinePartBase {
  // 固定时间线子类型。
  timelineType: "goal_verification";
  // 目标 id。
  targetId: string;
  // 单次校验 id；幂等键。
  verificationId: string;
  // 目标迭代序号；同目标多轮校验时分组。
  goalIteration?: number;
  // 校验结果快照；缺失表示仍在进行。
  verification?: {
    // 是否通过。
    passed: boolean;
    // 判定理由；UI 原样展示。
    reason: string;
    // 建议下一步；null/缺省表示无。
    nextAction?: string | null;
  };
}

// fork 时间线：标记 child 历史中“从父会话分叉”的位置。
// 生产者：fork 提交路径；消费者：UI 分隔线与恢复。
// 不变量：parentSessionId/targetMessageId 在 child 中只读；不得据此重新复制父消息。
export interface SessionForkTimelinePart extends TimelinePartBase {
  // 固定时间线子类型。
  timelineType: "session_fork";
  // 来源父会话 id。
  parentSessionId: SessionId;
  // 分叉目标消息 id；指向父会话中被 fork 的消息。
  targetMessageId: MessageId;
  // 分叉时的 checkpoint id；可选，用于文件恢复。
  targetCheckpointId?: string;
  // 恢复的文件数；仅展示。
  restoredFileCount?: number;
}

// 模型切换时间线：记录一次运行中模型选择变化。
// 生产者：模型选择变更路径；消费者：UI 展示与用量归因。
// 不变量：toModel 可能因回滚降级缺失配置，读侧不得因此丢弃整条历史；
// fromModel/toModel 只描述变化，不改变当前路由。
export interface ModelChangeTimelinePart extends TimelinePartBase {
  // 固定时间线子类型。
  timelineType: "model_change";
  // 切换前模型；首次选择时缺省。
  fromModel?: TimelineModelSelection;
  // 回滚再升级后模型配置可缺失；不能因此丢掉整条历史内容。
  /** 回滚再升级后模型配置可缺失；不能因此丢掉整条历史内容。 */
  toModel?: TimelineModelSelection & { label: string };
}

// 时间线 part 联合；读侧按 timelineType 收窄。timeline 默认不进入模型上下文，
// 只用于 transcript 分隔线与工作日志展示，不得据此重建用户/助手正文。
// 新增类型必须同时扩展该 union 与 TimelinePartDraft 模板，并定义 UI 映射。
export type TimelinePart =
  // 一次上下文压缩。
  | ContextCompactionTimelinePart
  // 一次目标完成校验。
  | GoalVerificationTimelinePart
  // 一次会话分叉。
  | SessionForkTimelinePart
  // 一次模型切换。
  | ModelChangeTimelinePart;

// 时间线 part 的写入草稿：去掉持久化时由 adapter 生成的 id/messageID/sessionID/type，
// 生产者只提供业务字段。条件类型保持联合分布，新增时间线类型自动获得草稿形态。
export type TimelinePartDraft = TimelinePart extends infer Part
  ? Part extends TimelinePart
    ? Omit<Part, "id" | "messageID" | "sessionID" | "type">
    : never
  : never;

// 子任务 part：记录一次 task 工具派发的 subagent 任务参数。
// 生产者：task 工具调用；消费者：transcript 展示与恢复（用于解释子代理产出）。
// 不变量：该 part 只描述“派发过什么”，不代表子代理仍在运行；运行态由事件/任务投影维护。
export interface SubtaskPart {
  // part 主键。
  id: PartId;
  // 所属会话（父会话）。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "subtask";
  // 派发给子代理的 prompt；恢复时不得重新执行。
  prompt: string;
  // 任务简述；用于 UI 标题。
  description: string;
  // 目标 agent 名。
  agent: string;
  // 指定模型；缺省表示由子代理配置决定。
  model?: {
    // provider 标识。
    providerId: ModelProviderId;
    // 模型标识。
    modelId: ModelId;
  };
  // 触发命令（若来自 slash command）。
  command?: string;
}

// 重试 part：记录一次模型请求失败与重试尝试。生产者：请求重试路径；
// 消费者：UI 错误/重试展示与用量归因。attempt 单调递增，不复用同一 part 覆盖历史。
export interface RetryPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "retry";
  // 第几次尝试；从 1 起单调递增。
  attempt: number;
  // 失败归因。
  error: AssistantErrorInfo;
  // 记录时间。
  time: {
    created: number;
  };
}

// 步骤开始 part：标记一次模型步骤/工具批次的起点。生产者：步骤调度；
// 消费者：transcript 步骤分隔与恢复对账。snapshot 是可选 checkpoint 标识，
// 不参与步骤身份判定；步骤身份由 part id 决定。
export interface StepStartPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "step-start";
  // 步骤开始时的 workspace 快照标识；可选。
  snapshot?: string;
}

// 步骤结束 part：记录一次步骤的结束原因、成本与 token。
// 生产者：步骤调度收口；消费者：用量归因与 transcript 展示。
// 不变量：与对应 step-start 属于同一消息；reason 是终态，不得在后续步骤中被覆盖。
export interface StepFinishPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "step-finish";
  // 结束原因（stop/tool_calls/error 等）；由运行时定义。
  reason: string;
  // 结束时的 workspace 快照标识；可选。
  snapshot?: string;
  // 该步骤成本。
  cost: number;
  // 该步骤 token 用量。
  tokens: TokenUsageInfo;
}

// 快照 part：记录一次 workspace 快照标识，供 rewind/恢复定位。
// 生产者：checkpoint 写入路径；消费者：恢复与文件 rewind。快照标识只做定位，
// 不得用 part 自身重建文件内容。
export interface SnapshotPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "snapshot";
  // 快照标识；实现相关，读侧不得解析其结构。
  snapshot: string;
}

// patch part：记录一次文件补丁的文件集合与内容 hash。
// 生产者：文件编辑工具/补丁应用；消费者：transcript 变更展示与恢复对账。
// 不变量：files 是本次补丁涉及路径；hash 用于幂等/去重，不能替代真实 diff。
export interface PatchPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "patch";
  // 补丁内容 hash；幂等/去重键。
  hash: string;
  // 涉及文件路径列表；顺序稳定但不用于恢复。
  files: string[];
}

// 工具状态四态之一：pending 表示参数已声明但尚未获准/开始执行。
// 生产者：工具调用解析/权限等待；消费者：UI 与断流恢复。pending 不是终态，
// 恢复时必须结合 streamingToolLedger 判断是否已被丢弃。
export interface ToolStatePending {
  // 固定状态判别符。
  status: "pending";
  // 解析出的工具入参。
  input: Record<string, unknown>;
  // 原始参数文本；用于展示/重放解析，不得回写覆盖 input。
  raw: string;
}

// 工具状态四态之一：running 表示工具已开始执行但未收口。
// 生产者：工具执行开始；消费者：UI 进度与断流恢复。running 必须有 time.start，
// 且不能在没有终态的情况下被当作成功结果送模型。
export interface ToolStateRunning {
  // 固定状态判别符。
  status: "running";
  // 实际执行的工具入参。
  input: Record<string, unknown>;
  // 进度标题；仅展示。
  title?: string;
  // 执行期元数据；可增量更新，不得写入 secrets。
  metadata?: Record<string, unknown>;
  // 开始时间；必须存在。
  time: {
    start: number;
  };
}

// 工具状态四态之一：completed 表示工具成功收口，output 是送模型的结果正文。
// 生产者：工具执行完成；消费者：模型上下文、UI、用量账本。completed 是终态；
// compacted 记录输出被压缩/截断的时间，attachments 是工具产出的附件 part。
export interface ToolStateCompleted {
  // 固定状态判别符。
  status: "completed";
  // 实际执行的工具入参。
  input: Record<string, unknown>;
  // 结果正文；送模型与展示的唯一权威字段。
  output: string;
  // 展示标题。
  title: string;
  // 结果元数据；随 part JSON 持久化。
  metadata: Record<string, unknown>;
  // 执行时间窗；compacted 表示输出被压缩的时间。
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  // 工具产出的附件；作为独立 FilePart 持久化。
  attachments?: FilePart[];
}

// 工具状态四态之一：error 表示工具失败收口。error 是展示/归因文本，
// 不是结构化错误码；恢复与重试判定必须结合 metadata/事件，不得解析 error 文本。
// error 是终态，不得在同一次调用中回退为 running。
export interface ToolStateError {
  // 固定状态判别符。
  status: "error";
  // 实际执行的工具入参。
  input: Record<string, unknown>;
  // 失败信息文本；仅供展示与归因。
  error: string;
  // 结构化错误元数据；可选。
  metadata?: Record<string, unknown>;
  // 执行时间窗；失败也必须给出 end。
  time: {
    start: number;
    end: number;
  };
}

// 工具状态联合；四个状态构成单次调用生命周期 pending → running → completed|error。
// 读侧按 status 收窄，不允许把 pending/running 当成功结果；终态不得回退。
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

// 工具调用 part：一次工具调用的持久记录。生产者：工具执行路径（含流式增量更新）；
// 消费者：模型上下文、transcript、断流恢复与用量账本。
// 不变量：callID 在会话内唯一并回填到 tool result；state 只能沿四态单向推进；
// declarationIndex 表示同一 assistant 内的声明顺序，旧记录缺失时不得用落盘顺序替代。
export interface ToolPart {
  // part 主键。
  id: PartId;
  // 所属会话。
  sessionID: SessionId;
  // 所属消息；必须已存在。
  messageID: MessageId;
  // 固定类型判别符。
  type: "tool";
  // 工具调用 id；与工具结果/事件对账。
  callID: string;
  /** 同一 assistant 内本地工具的声明序号；旧记录可缺失，不能用落盘顺序代替。 */
  // 声明序号用于还原模型原始调用顺序；不是数据库插入序，也不是时间序。
  declarationIndex?: number;
  // 工具名；用于权限匹配与展示。
  tool: string;
  // 当前状态及结果；四态单向推进。
  state: ToolState;
  // 附加领域元数据；随 part JSON 持久化，不得影响 state 判定。
  metadata?: Record<string, unknown>;
}

// 消息 part 联合；顺序由持久化顺序决定，不能按 id/时间戳重排。
// 新增 part 类型必须同时扩展该 union、读侧收窄与模型上下文过滤规则。
export type MessagePart =
  // 正文。
  | TextPart
  // 推理。
  | ReasoningPart
  // 附件/文件引用。
  | FilePart
  // @agent 标记。
  | AgentPart
  // 压缩。
  | CompactionPart
  // 时间线（默认不送模型）。
  | TimelinePart
  // 子任务派发。
  | SubtaskPart
  // 重试记录。
  | RetryPart
  // 步骤开始。
  | StepStartPart
  // 步骤结束。
  | StepFinishPart
  // 快照。
  | SnapshotPart
  // 文件补丁。
  | PatchPart
  // 工具调用。
  | ToolPart;

// 消息与 parts 的组合，是持久层读取 transcript 的最小单元。
// 不变量：message 先落库、parts 随后增量落库；parts 按持久化顺序返回，
// 同一 messageID 下不允许出现孤儿 part；message 被删除时其 parts 一并清理。
export interface MessageWithParts {
  // 消息本体（user/assistant）。
  info: MessageInfo;
  // 消息的全部 parts（按持久化顺序）。
  parts: MessagePart[];
}

/** 分享导入的单事务载荷：新 session、唯一 model-only 上下文和 provenance 全有或全无。 */
// 生产者：shared context 导入命令；消费者：adapter commitSharedContextImportBundle。
// 不变量：contextMessage 必须是 model-only，不得在 UI 展示；provenance entry 与
// session 同事务落库，失败整体回滚，不允许留下无来源的上下文消息。
export interface SharedContextImportCommitBundle {
  // 待创建的新会话。
  session: CreateSessionInput;
  // 唯一的 model-only 上下文消息。
  contextMessage: MessageWithParts;
  // 导入来源 entry；用于审计与恢复。
  provenance: SessionEntryInfo;
}

// 分享导入状态机：pending → reserved → attached，或任意未终态 → discarded。
// 生产者：导入/消费路径；消费者：transition CAS 与恢复清理。
// attached/discarded 是终态，不得回退；reserved 表示已被某个消费方预留。
export type SharedContextImportStatus = "pending" | "reserved" | "attached" | "discarded";

// 分享导入状态迁移请求；expectedStatus 是 CAS 条件（单值或集合），status 是目标态。
// 生产者：导入消费/清理路径；消费者：adapter transitionSharedContextImport。
// 不变量：迁移必须 compare-and-set，返回 false 表示未命中，不得强行覆盖；
// sourceId 记录触发迁移的 queue/input/message 身份，用于审计与恢复对账。
export interface SharedContextImportTransition {
  // 归属会话。
  sessionID: SessionId;
  // 导入上下文 id；幂等键。
  contextId: string;
  // CAS 期望的当前状态（可接受多个合法前置态）。
  expectedStatus: SharedContextImportStatus | readonly SharedContextImportStatus[];
  // 目标状态。
  status: SharedContextImportStatus;
  /** queue/input identity or accepted user message identity for audit/recovery. */
  // 触发迁移的输入/消息身份；仅审计，不参与状态判定。
  sourceId?: string;
}

// session entry 类型常量：每个值对应一类会话级事实（目标校验/配置/快照等）。
// 生产者是运行时各写入点；消费者是恢复/投影与 fork 复制。值是持久化字符串，
// 一经发布不得重命名；读侧必须容忍未知 type（见 SessionEntryInfo.type）。
// 目标完成校验 entry：记录一次目标校验的最终结果与锚点。
export const SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION =
  "target_completion_verification" as const;
// shell 选择 entry：记录会话内 bash shell 偏好；恢复时不得回落到宿主默认。
export const SESSION_ENTRY_BASH_SHELL_SELECTION = "runtime/bash_shell_selection" as const;
// 模型选择 entry：记录会话权威模型选择；读写为公共 ModelSelection。
export const SESSION_ENTRY_MODEL_SELECTION = "runtime/model_selection" as const;
// 执行状态 entry：记录协作模式/Plan 等执行配置，冷恢复的唯一来源。
export const SESSION_ENTRY_EXECUTION_STATE = "runtime/execution_state" as const;
// 自动决议 entry：记录用户输入的自动裁决结果，供审计与重放。
export const SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION =
  "runtime/user_input_auto_resolution" as const;
// workspace checkpoint entry：记录一次 workspace 快照，供 /rewind latest 选择。
export const SESSION_ENTRY_WORKSPACE_CHECKPOINT = "runtime/workspace_checkpoint" as const;
// 文件回退 entry：记录一次 workspace 文件 rewind 的目标与结果。
export const SESSION_ENTRY_WORKSPACE_FILE_REWIND = "runtime/workspace_file_rewind" as const;
// 动态工作流激活 entry：本会话已按需激活动态工作流工具面。
/** 动态工作流工具面已在本会话激活（docs/dynamic-workflow/launch.md「On demand: activation」）。 */
export const SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION =
  "runtime/dynamic_workflow_activation" as const;

// 已知 session entry 类型闭集；仅用于枚举/校验，读侧仍须接受未知 type。
// 新增已知类型必须同时定义 payload 结构与投影映射，不能只加常量。
export const SESSION_ENTRY_TYPES = [
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
] as const;

// session entry 类型联合；只保证已知值可枚举，实际 entry.type 允许扩展字符串。
// 读侧不得对未知类型报错，应保留 entry 并在需要时忽略。
export type SessionEntryType = (typeof SESSION_ENTRY_TYPES)[number];

// 会话级事实 entry：目标校验、模型/shell 选择、执行状态、checkpoint 等。
// 生产者：运行时各写入点（saveSessionEntry）；消费者：冷恢复、投影与 fork 复制。
// 不变量：type 是持久字符串，读侧必须接受未知值；data 是逻辑 payload 而非 DB JSON；
// touchSession=false 的配置写入不得刷新会话活动时间。
export interface SessionEntryInfo {
  // entry 主键；在会话内唯一，重写同 id 视为更新。
  id: string;
  // 所属会话。
  sessionID: SessionId;
  // 已知类型或扩展字符串；读侧必须宽容未知值。
  type: SessionEntryType | string;
  // session entry 既承载用户/工具活动，也承载 session-local 配置快照。
  // 配置恢复或切换只应更新 entry 自己的版本，不能把任务活动时间伪装成“刚刚”。
  // false 时只更新 entry.time.updated，不推进 session.time.updated。
  touchSession?: boolean;
  // entry 自身时间；与 session 活动时间独立。
  time: {
    // 首次写入时间。
    created: number;
    // 最近更新时间；touchSession 控制是否同步到 session。
    updated: number;
  };
  /**
   * 逻辑 payload，不等同于数据库 JSON。runtime/model_selection 的读写为公共
   * ModelSelection（无选择沿用 null）；SQLite adapter 负责 modelSelection 包装，
   * 旧平铺字段仅供一次性迁移/回滚，不能暴露给普通消费者或复制到 fork 子记录。
   */
  // data 由 consumer 按 type 解释；不得假设它已经是 DB 列结构或可直接 stringify 回写。
  data: unknown;
}

// ── session_input 账本──
// 输入的 durable 生命周期：admitted（已接受，排队/待注入）→ promoted（已消费成
// transcript user message，与消息持久化同事务）/ cancelled（用户删除队列项等）/
// discarded（session_resumed=重启不保留队列；user_cleared=heldQueue 清空发送）/
// failed（已接受但运行时无法启动；保留终态，重启时禁止再改写成 discarded）。
// id = input/command id（admission 时即存在）；promoted_message_id 是 nullable 外键——
// messageId 在 drain 时才生成。startNow 也必须先经过 durable admission：即使 CLI 在 ACK 后、
// user message 原子 promotion 前崩溃，恢复端也能把输入明确标成 discarded。
// 账本与 message 分层：账本是“输入是否已被接受/消费”的事实，message 是“对话内容”；
// 二者只通过 promoted_message_id 关联，不得用 message 是否存在反推账本状态。
// 生产者：admission（saveSessionInput）、promotion、settle；消费者：恢复清扫与队列重放。
// 投递方式：startNow 立即尝试启动新一轮（仍须先 durable admission）；guide 注入当前轮；
// queue 作为独立后续轮排队。三者共享注入机制，但产品语义与账本位置不同。
export type SessionInputDelivery = "startNow" | "guide" | "queue";

// 账本状态机：admitted → promoted；admitted → cancelled/discarded/failed。promoted 是唯一成功终态，
// 其余为失败/放弃终态；终态不得回退（settleSessionInput 只更新 admitted 行）。
export type SessionInputStatus = "admitted" | "promoted" | "cancelled" | "discarded" | "failed";

// 单条输入账本记录；id 是 input/command id，promotedMessageID 在 drain 时才生成。
// 生产者：saveSessionInput/updateSessionInputs/promoteSessionInput/settleSessionInput；
// 消费者：恢复清扫、队列 UI 与命令幂等。admittedSequence/promotedSequence 是账本序，
// 不是消息序，不能与 event sequenceNumber 混用。
export interface SessionInputRecord {
  // input/command id；admission 时即存在，重入按该 id 幂等。
  id: string;
  // 所属会话；跨会话 id 不唯一，更新必须带 sessionID。
  sessionID: SessionId;
  // 输入种类（prompt/steer/command 等）；由命令面定义，账本不解释。
  kind: string;
  // 投递方式；决定恢复时是启动、注入还是继续排队。
  delivery: SessionInputDelivery;
  // 输入载荷；text 必填，其余字段由命令面透传，账本不裁剪。
  payload: { text: string; [key: string]: unknown };
  // 会话内 admission 序号；单调递增，listSessionInputs 按它排序。
  admittedSequence: number;
  // promotion 序号；仅 promoted 记录有值，单调递增。
  promotedSequence?: number;
  // 成功 promotion 生成的 user message id；nullable 外键，drain 前不存在。
  promotedMessageID?: MessageId;
  // 当前状态；只能从 admitted 进入任一终态。
  status: SessionInputStatus;
  // 终态原因（user_removed/session_resumed/user_cleared 等）；promoted 时通常缺省。
  statusReason?: string;
  // 账本时间；created 为 admission 时间，updated 为最近状态变更时间。
  time: { created: number; updated: number };
}

// 用量归因来源：main_turn 正常轮次、compact 压缩请求、session_title 标题生成、
// goal_completion_verification 目标校验、subagent/workflow_child 派生任务、unknown 兜底。
// 生产者：模型请求入口；消费者：用量聚合/报表。未知值用 unknown，不得丢弃记录。
export type UsageQuerySource =
  // 主对话轮次。
  | "main_turn"
  // 上下文压缩请求。
  | "compact"
  // 会话标题生成。
  | "session_title"
  // 目标完成校验。
  | "goal_completion_verification"
  // 子代理任务。
  | "subagent"
  // workflow 子任务。
  | "workflow_child"
  // 兜底；无法归因时使用。
  | "unknown";

// 记录生命周期：running 表示已开始未收口；completed/error/cancelled 为终态。
// 生产者：请求/工具/轮次生命周期；消费者：报表与对账。终态不得回退。
export type UsageStatus = "running" | "completed" | "error" | "cancelled";

// 单次逻辑模型请求的用量记录（一次逻辑请求可含多次 attempt）。
// 生产者：模型请求埋点；消费者：成本/性能报表与恢复对账。
// 不变量：logicalRequestId 在逻辑请求内稳定，attemptIndex 区分重试；终态记录必须
// 携带 completedAt；rawUsage/providerMetadata 仅存档，不得参与业务判定。
export interface ModelUsageRecord {
  // 本次 attempt 的记录 id；唯一。
  id: string;
  // 逻辑请求 id；跨 attempt 稳定，用于把重试聚合为一次请求。
  logicalRequestId: string;
  // attempt 序号；从 0/1 起由埋点约定，同 logicalRequestId 内唯一。
  attemptIndex?: number;
  // 所属会话。
  sessionID: SessionId;
  // 所属轮次；非轮次请求（标题等）缺省。
  turnID?: TurnId;
  // 追踪 id。
  traceID?: TraceId;
  // span id；用于链路追踪。
  spanID?: string;
  // 产出/关联的 assistant 消息。
  assistantMessageID?: MessageId;
  // 对应 user 消息。
  parentUserMessageID?: MessageId;
  // 归因来源；未知用 unknown。
  querySource: UsageQuerySource | string;
  // provider 标识；允许字符串扩展。
  providerId: ModelProviderId | string;
  // 模型标识；允许字符串扩展。
  modelId: ModelId | string;
  // 推理强度。
  reasoningLevel?: string;
  // 执行 agent。
  agent?: string;
  // 当时模式。
  mode?: string;
  // 会话任务类型。
  taskType?: SessionTaskType;
  // 记录状态；running 不得作为最终报表输入。
  status: UsageStatus;
  // 请求开始时间（unix ms）。
  startedAt: number;
  // 首个 token 到达时间；用于 TTFT。
  firstTokenAt?: number;
  // 完成时间；终态必须存在。
  completedAt?: number;
  // 总耗时。
  durationMs?: number;
  // 首 token 延迟。
  timeToFirstTokenMs?: number;
  // provider 结束原因。
  finishReason?: string;
  // 工具调用数。
  toolCallCount?: number;
  // 输入 token。
  inputTokens?: number;
  // 输出 token。
  outputTokens?: number;
  // 推理 token。
  reasoningTokens?: number;
  // 缓存写入 token。
  cacheCreationInputTokens?: number;
  // 缓存读取 token。
  cacheReadInputTokens?: number;
  // provider 报告总量；权威值。
  providerTotalTokens?: number;
  // 本地计算总量；仅缺失 providerTotalTokens 时参考。
  computedTotalTokens?: number;
  // 重试次数。
  retryCount?: number;
  // 是否可重试。
  retryable?: boolean;
  // 是否用户取消。
  cancelledByUser?: boolean;
  // 是否上下文超限。
  contextExceeded?: boolean;
  // 错误分类/错误码/错误信息；仅归因。
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  // provider 原始用量；只存档，结构随 provider 变化。
  rawUsage?: unknown;
  // provider 附加元数据；只存档。
  providerMetadata?: unknown;
}

// 单轮用量汇总；由同 turnID 的模型/工具记录聚合（或增量 upsert）。
// 生产者：轮次生命周期埋点；消费者：轮次报表与成本展示。
// 不变量：turnID 在会话内唯一；终态必须写 completedAt；token 字段口径与 ModelUsageRecord 一致。
export interface TurnUsageRecord {
  // 所属会话。
  sessionID: SessionId;
  // 轮次 id；会话内唯一。
  turnID: TurnId;
  // 追踪 id。
  traceID?: TraceId;
  // 该轮的 user 消息。
  userMessageID?: MessageId;
  // 轮次状态；running 不进入最终报表。
  status: UsageStatus;
  // 开始时间。
  startedAt: number;
  // 首次模型请求开始时间。
  firstModelStartAt?: number;
  // 首 token 时间。
  firstTokenAt?: number;
  // 完成时间；终态必须存在。
  completedAt?: number;
  // 总时长。
  durationMs?: number;
  // 首 token 延迟。
  timeToFirstTokenMs?: number;
  // 模型请求次数。
  modelRequestCount?: number;
  // 模型重试次数。
  modelRetryCount?: number;
  // 工具调用次数。
  toolCallCount?: number;
  // 工具错误次数。
  toolErrorCount?: number;
  // 输入 token。
  inputTokens?: number;
  // 输出 token。
  outputTokens?: number;
  // 推理 token。
  reasoningTokens?: number;
  // 缓存写入 token。
  cacheCreationInputTokens?: number;
  // 缓存读取 token。
  cacheReadInputTokens?: number;
  // 本地计算总量。
  computedTotalTokens?: number;
  // 是否可重试。
  retryable?: boolean;
  // 是否用户取消。
  cancelledByUser?: boolean;
  // 是否上下文超限。
  contextExceeded?: boolean;
  // 错误分类/错误码。
  errorType?: string;
  errorCode?: string;
}

// 单次工具调用用量记录；记录耗时、输出体量与审批结果。
// 生产者：工具执行埋点；消费者：工具报表与风险统计。
// 不变量：toolCallID 与 ToolPart.callID 对应；sideEffectScope/destructive 是执行前
// 判定快照，不得用结果反推；approvalStatus 只记录结果，不替代权限规则。
export interface ToolUsageRecord {
  // 记录 id；唯一。
  id: string;
  // 所属会话。
  sessionID: SessionId;
  // 所属轮次；工具可能跨轮，缺省表示无轮次归属。
  turnID?: TurnId;
  // 追踪 id。
  traceID?: TraceId;
  // 工具调用 id；与 ToolPart.callID 对齐。
  toolCallID: ToolCallId | string;
  // 工具名。
  toolName: string;
  // 副作用范围快照。
  sideEffectScope?: ModelToolSideEffectScope | string;
  // 是否只读。
  readOnly?: boolean;
  // 是否破坏性。
  destructive?: boolean;
  // 审批结果；none/requested/allowed/denied。
  approvalStatus?: "none" | "requested" | "allowed" | "denied";
  // 执行状态。
  status: UsageStatus;
  // 开始时间。
  startedAt: number;
  // 首个输出时间。
  firstOutputAt?: number;
  // 完成时间；终态必须存在。
  completedAt?: number;
  // 总时长。
  durationMs?: number;
  // 首输出延迟。
  timeToFirstOutputMs?: number;
  // 进程退出码；非进程工具缺省。
  exitCode?: number;
  // 输出总字节。
  outputBytes?: number;
  // stdout 字节。
  stdoutBytes?: number;
  // stderr 字节。
  stderrBytes?: number;
  // 输出是否被截断。
  truncated?: boolean;
  // 重试次数。
  retryCount?: number;
  // 是否可重试。
  retryable?: boolean;
  // 是否用户取消。
  cancelledByUser?: boolean;
  // 错误分类/错误码/错误信息。
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
}

// 应用级用量查询窗口；左开右闭 (since, until]，并按 tzOffsetMs 归本地日。
// 生产者：CLI 用量报表；消费者：adapter queryAppUsage。窗口/时区必须由调用方固定，
// 实现不得使用宿主当前时区，否则跨机器报表不可比。
export interface AppUsageQueryInput {
  /** 含 (since, until] 的下界（unix ms）。 */
  since: number;
  /** 上界（unix ms），通常为 now。 */
  until: number;
  /** 调用端时区相对 UTC 的固定偏移（ms），用于按本地日归桶。 */
  tzOffsetMs: number;
}

// 应用级用量总量：token 分项、请求/错误数与平均 TTFT。
// 生产者：UsageStorePort.queryAppUsage 聚合；消费者：用量报表总览。
// null 表示无样本（如无首 token 记录），不得用 0 冒充。
export interface AppUsageTotalsRow {
  // 总 token 数。
  totalTokens: number;
  // 输入 token 总数。
  inputTokens: number;
  // 输出 token 总数。
  outputTokens: number;
  // 推理 token 总数。
  reasoningTokens: number;
  // 缓存写入 token 总数。
  cacheCreationTokens: number;
  // 缓存读取 token 总数。
  cacheReadTokens: number;
  // 模型请求总数。
  modelRequestCount: number;
  // 模型错误总数。
  modelErrorCount: number;
  // 平均首 token 延迟；无样本为 null。
  avgTimeToFirstTokenMs: number | null;
}

// 轮次维度汇总：会话/轮次数、平均轮次时长与最长会话。
// 生产者：用量聚合；消费者：报表。avg 为 null 表示无样本。
export interface AppUsageTurnTotalsRow {
  // 窗口内会话数。
  totalSessions: number;
  // 窗口内轮次数。
  totalTurns: number;
  // 平均轮次时长；无样本为 null。
  avgTurnDurationMs: number | null;
  // 最长会话时长。
  longestSessionMs: number;
}

// 工具维度汇总：调用与错误总数。生产者：用量聚合；消费者：报表。
export interface AppUsageToolTotalsRow {
  // 工具调用总数。
  toolCallCount: number;
  // 工具错误总数。
  toolErrorCount: number;
}

// 按模型聚合的用量行；modelId 为 null 表示历史记录缺少模型信息。
// 生产者：用量聚合；消费者：模型分布报表。
export interface AppUsageModelRow {
  // 模型 id；null 表示未知。
  modelId: string | null;
  // 总 token。
  totalTokens: number;
  // 输入 token。
  inputTokens: number;
  // 输出 token。
  outputTokens: number;
  // 请求次数。
  requestCount: number;
}

// 按工具聚合的行；avgDurationMs 为 null 表示无完成样本。
// 生产者：用量聚合；消费者：工具耗时报表。
export interface AppUsageToolRow {
  // 工具名；由埋点记录。
  toolName: string;
  // 调用次数。
  callCount: number;
  // 错误次数。
  errorCount: number;
  // 平均耗时；无样本为 null。
  avgDurationMs: number | null;
}

// 按本地日聚合的行；dayIndex 是相对窗口起点的日偏移，不是绝对日期。
// 生产者：用量聚合；消费者：趋势图。跨时区结果不可直接比较。
export interface AppUsageDayRow {
  // 本地日偏移（0 = 窗口首日）。
  dayIndex: number;
  // 当日总 token。
  totalTokens: number;
  // 当日轮次数。
  turnCount: number;
  // 当日工具调用数。
  toolCallCount: number;
}

// 按本地日 + 模型聚合的行；用于堆叠/分组趋势图。
// 生产者：用量聚合；消费者：报表。modelId 为 null 表示未知模型。
export interface AppUsageDayModelRow {
  // 本地日偏移。
  dayIndex: number;
  // 模型 id；null 表示未知。
  modelId: string | null;
  // 该日该模型 token 数。
  totalTokens: number;
}

// 应用级用量查询结果；所有行由同一窗口/时区口径聚合，
// 调用方不得混用不同窗口的结果。生产者：queryAppUsage；消费者：CLI 报表。
export interface AppUsageQueryResult {
  // 总量。
  totals: AppUsageTotalsRow;
  // 轮次汇总。
  turnTotals: AppUsageTurnTotalsRow;
  // 工具汇总。
  toolTotals: AppUsageToolTotalsRow;
  // 模型分布。
  models: AppUsageModelRow[];
  // 工具耗时分布。
  tools: AppUsageToolRow[];
  // 按日趋势。
  days: AppUsageDayRow[];
  // 按日 + 模型趋势。
  dayModels: AppUsageDayModelRow[];
}

// 单会话用量查询输入；sessionID 必须存在，实现不得跨会话聚合。
export interface TaskUsageQueryInput {
  // 目标会话。
  sessionID: SessionId;
}

// 单会话用量结果；inputBaselineBySource 记录各来源的输入基线，用于增量归因。
// 生产者：queryTaskUsage；消费者：会话详情/成本面板。
export interface TaskUsageQueryResult {
  // 会话 id；与查询入参一致。
  sessionID: SessionId;
  // 总 token。
  totalTokens: number;
  // 输入 token。
  inputTokens: number;
  // 输出 token。
  outputTokens: number;
  // 推理 token。
  reasoningTokens: number;
  // 缓存写入 token。
  cacheCreationTokens: number;
  // 缓存读取 token。
  cacheReadTokens: number;
  // 模型请求数。
  modelRequestCount: number;
  // 模型错误数。
  modelErrorCount: number;
  // 按来源的输入基线；用于区分新增输入与历史基线。
  inputBaselineBySource: Record<string, number>;
}

// 用量存储边界：写侧按记录 id 幂等，读侧按窗口/会话聚合。
// 生产者：模型/轮次/工具埋点；消费者：CLI 报表与成本面板。
// 不变量：upsert 必须以业务主键（logicalRequestId/turnID/toolCallID）去重，
// 不得因重试产生重复计费；prune 只清理历史，不得删除 running 记录。
export interface UsageStorePort {
  // 写入单次模型请求 attempt；按 id/logicalRequestId+attemptIndex 幂等。
  recordModelUsage(input: ModelUsageRecord): Promise<void>;
  // 按 sessionID+turnID 增量 upsert 轮次汇总。
  upsertTurnUsage(input: TurnUsageRecord): Promise<void>;
  // 按记录 id / toolCallID 幂等写入工具用量。
  upsertToolUsage(input: ToolUsageRecord): Promise<void>;
  // 清理 beforeTime 之前的已完成记录；running 记录必须保留。
  pruneUsage(input?: { beforeTime?: number }): Promise<void>;
  // 按窗口聚合应用级用量。
  queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult>;
  // 单会话聚合用量。
  queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult>;
}

// 本地设置存储：保存项目级权限模式等宿主偏好，与 session 级权限分离。
// 生产者：启动/模式切换；消费者：权限解析默认值。实现可同步或异步返回，
// 调用方必须同时兼容 Promise 与直接值；不得把项目默认当成会话已固定权限。
export interface LocalSettingStorePort {
  // 读取项目权限模式；无设置返回 null（不是 undefined）。
  getProjectPermissionMode(
    projectID: ProjectId,
  ): CollaborationMode | null | Promise<CollaborationMode | null>;
  // 保存项目权限模式并返回生效值；实现需保证同项目覆盖写。
  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode | Promise<CollaborationMode>;
}

// 会话持久层统一边界：覆盖 session 元数据、message/part、session entry、session_input 账本。
// 生产者是 core runtime（message-persistence/steering/resume/events）与 bootstrap；
// 消费者是各类 adapter（SQLite / 内存 / 文件）。本接口不做业务裁决，只声明能力。
// 可选方法（带 ?）表示旧宿主可以缺席；调用方必须显式降级并保持账本/消息一致性，
// 不得把“方法缺失”当成成功、空结果或“无需记账”。
// 跨进程不变量：session_input 账本与 message/part 是重启后恢复队列和 transcript 的唯一事实。
export interface SessionStorePort {
  // 插入 session 行；id 由入参决定，同 id 重复创建必须幂等。
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  /** legacy 兼容原语；V4 stable/compact-edit fork 禁止调用，统一走 commitForkBundle。 */
  // 实现只写 child + 元数据，不保证消息集合原子；因此不能用于新 fork 路径。
  createForkedSessionWithMetadata?(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo>;
  /** V4 stable/compact-edit fork 的唯一事务入口。legacy workspace fork 不调用。 */
  // 必须把 child/messages/entries/goal/initialInput/commandFact 放在同一事务内。
  commitForkBundle?(bundle: ForkCommitBundle): Promise<SessionInfo>;
  // 分享导入单事务入口：session + model-only context message + provenance 全有或全无。
  commitSharedContextImportBundle?(bundle: SharedContextImportCommitBundle): Promise<SessionInfo>;
  // 分享导入状态 CAS；返回 false 表示前置状态不匹配，调用方不得覆盖重试。
  transitionSharedContextImport?(input: SharedContextImportTransition): Promise<boolean>;
  // 增量更新 session 元数据；title 变更必须遵循 expectedTitleSources CAS。
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  /** 只写一次删除时间；正文保留，普通列表永不返回软删除行。 */
  // 重复调用不得改写已存在的删除时间；恢复/会话正文仍可按 id 读取。
  softDeleteSession?(sessionID: SessionId, timeDeleted?: number): Promise<void>;
  // 按 id 读取 session；已软删除仍可读取，不存在返回 null（不是抛错）。
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  // 按过滤条件列出 session；必须过滤软删除，并按 updated 倒序（limit 截断）。
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  /**
   * 用 host task-index allowlist 为旧远端 session 补写 workspace identity。
   * 实现必须同时校验 id、directory 与 workspace_id is null，禁止覆盖已有 identity。
   * 返回成功认领的行数；未命中（id/目录/identity 不匹配）不计入。
   */
  claimLegacySessionWorkspace?(input: ClaimLegacySessionWorkspaceInput): Promise<number>;
  /**
   * 修复曾把 remote identity 写入 directory/path 的单条历史 session。
   * 实现必须校验 session id、NULL workspace_id 及旧目录精确匹配，禁止批量路径迁移。
   * 返回是否命中并修复；false 表示 CAS 条件不满足，不得扩大为批量迁移。
   */
  repairLegacyRemoteSessionWorkspace?(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean>;
  /**
   * 已有 remote identity 的维护性路径自愈 CAS。
   * 实现只能更新 directory、path 和单调 time_updated，禁止写回其它 session 元数据。
   * 返回 boolean 表示 CAS 是否命中；失败时不得回写其它字段。
   */
  repairRemoteSessionPaths?(input: RepairRemoteSessionPathsInput): Promise<boolean>;
  // 写入/覆盖消息；message 必须先于 parts 落库，按 id upsert。
  // copyFrom 仅用于 fork 复制（来源记录映射），不得跨会话伪造来源。
  saveMessage(input: MessageInfo, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  // 删除消息；实现必须级联删除其 parts，不得留下孤儿 part。
  removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void>;
  // 写入/覆盖 part；message 必须已落库，按 part id upsert（流式覆盖同一 part）。
  savePart(input: MessagePart, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  // 删除单条 part；不得删除 message 本身。
  removePart(input: { sessionID: SessionId; messageID: MessageId; partID: PartId }): Promise<void>;
  // 读取单条消息及其 parts；不存在返回 null，parts 按持久化顺序。
  messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null>;
  // 读取会话全部消息及 parts，按持久化顺序返回；软删除会话仍可按 id 读取。
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  // 写入/覆盖 session entry；touchSession 控制是否刷新 session 活动时间。
  saveSessionEntry?(input: SessionEntryInfo): Promise<void>;
  // 按类型读取 entry；type 缺省返回全部，未知 type 原样返回。
  sessionEntries?(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]>;
  // ── session_input 账本（可选方法，旧宿主可不实现）──
  // 可选：旧宿主可完全不实现账本；调用方必须降级为内存队列，且重启后队列不可恢复。
  // 以下方法的顺序即生命周期：saveSessionInput(admission) → updateSessionInputs(编辑/重排)
  // → promoteSessionInput(原子消费) / markSessionInputPromoted(补记) → settleSessionInput(终态)。
  /** admission：输入已被接受（排队/待注入），durable 记账。幂等（同 id 重入更新 payload）。 */
  // 必须在返回前 durable 落库；返回即表示“已接受”，调用方才能向用户 ACK。
  // 同 id 重入更新 payload，但不得把终态记录回退为 admitted。
  saveSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void>;
  /** 审批完全访问：execution、固定队列权限和幂等 receipt 同一事务；无 schema migration。 */
  // queueItemIds 指被固定为完全访问的队列项；receipt 幂等，重复提交不得重复生效。
  commitPermissionFullAccess?(input: {
    sessionID: SessionId;
    queueItemIds: string[];
    execution: SessionEntryInfo;
    receipt: SessionEntryInfo;
    signal?: AbortSignal;
  }): Promise<void>;
  /** queue 编辑/重排的 durable 原子更新；只允许修改 admitted 记录。 */
  // id 必须存在于同 session 且 status=admitted；不得修改终态记录；queuePosition 重排需稳定。
  updateSessionInputs?(input: {
    sessionID: SessionId;
    updates: Array<{
      delivery?: SessionInputDelivery;
      id: string;
      intent?: import("./session.port.js").TurnInputIntentMetadata;
      text?: string;
      queuePosition?: number;
    }>;
  }): Promise<void>;
  /**
   * promotion（原子性硬要求）：账本置 promoted + user message/parts
   * 持久化在同一事务——杜绝「queue 已消费但 transcript 无 user message」的孤儿窗口。
   */
  // 事务内先写 message 再写 parts，最后 CAS 更新账本（admitted→promoted）；
  // id 已 promoted 时幂等返回，不得重复生成 message。
  promoteSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void>;
  /**
   * 非原子 promotion 标记：message 持久化已在别处完成的路径（background wake 的
   * synthetic notice）只补账本状态。新路径应优先用 promoteSessionInput（原子）。
   */
  // 仅更新 status=admitted 的账本行并写 promotedMessageID；不写 message/parts。
  // 调用方必须先持久化 message；新路径禁止用它替代原子 promotion。
  markSessionInputPromoted?(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void>;
  /** 终态收口：cancelled（user_removed 等）/ discarded（session_resumed / user_cleared）。 */
  // 只更新 admitted 行；已 promoted 的迟到 discard 不得回退状态（保留成功事实）。
  // reason 原样落 statusReason（user_removed/session_resumed/user_cleared 等）。
  settleSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void>;
  // 按 admittedSequence 升序返回；status 缺省返回全部。用于恢复清扫/队列展示。
  listSessionInputs?(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]>;
  /** global createSession.firstInput 查重：由 queue_<sourceCommandId> 找回真实 session。 */
  // 按 input/command id 全局查找；返回 null 表示从未 admission，不得伪造记录。
  getSessionInputById?(id: string): Promise<SessionInputRecord | null>;
  // 读取会话待办；不存在返回空数组（不是 null）。
  readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]>;
  // 覆盖写入会话待办；数组顺序即展示顺序，不接受增量语义。
  updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void>;
  // 读取当前目标；无目标返回 null，不得返回旧目标冒充当前。
  readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  // 创建或覆盖目标；返回权威目标快照（含 status/tokenBudget）。
  setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal>;
  // fork 时复制目标；必须生成新 target id，不共享父目标状态。
  cloneTargetForFork?(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal>;
  // 仅在无目标时创建；已有目标返回 null，不得静默覆盖。
  createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null>;
  // 更新目标状态；终态不得回退。
  updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null>;
  // 记录目标续跑开始；inputID 是本次 run 的幂等键。
  startTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null>;
  // 更新 run 心跳；seenAtMs 必须单调，不得回退。
  heartbeatTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null>;
  // 结束 run；endedAtMs 与 status 同写，tokensUsedDelta 为增量。
  finishTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null>;
  // 重启时恢复被中断的 run；不得重复启动同一 inputID。
  recoverInterruptedTargetRun?(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  // 累加目标用量；delta 为增量，实现需原子累加。
  accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null>;
  // 更新目标摘要标题；仅展示字段，不改变目标状态。
  updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null>;
  // 清除当前目标；返回是否确有目标被清除。
  clearTarget(input: { sessionID: SessionId }): Promise<boolean>;
  // 读取项目权限；无设置返回 null。
  getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null>;
  // 覆盖保存项目权限并返回生效值。
  saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset>;
  // 写入回退指针；conversation rewind 必须同时推进 branchCutAfterMessageID/branchGeneration。
  setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  // 清除回退指针，回到活动分支。
  clearRevert(sessionID: SessionId): Promise<void>;
}
