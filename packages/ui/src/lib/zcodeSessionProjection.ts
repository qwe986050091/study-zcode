/**
 * ============================================================================
 * ui/lib/zcodeSessionProjection.ts —— session 快照/事件 → 旧聊天投影的迁移桥
 * ============================================================================
 *
 * 【定位】把 V4 session snapshot 与 session event 映射成旧 ChatView 时代使用的
 * ZCodeTaskSnapshot / ZCodeStreamEvent。它是一个**迁移桥**，不是新的真相源：
 *   - 输入：CLI 产出的 session snapshot / event（已经是权威投影）；
 *   - 输出：旧 UI 仍认识的 task/message/stream 形状；
 *   - 本文件不重新解释业务事件，也不从消息数组推导 turn/goal/queue 状态。
 *
 * 【两条映射必须对齐】
 *   - snapshot 映射（zcodeSessionSnapshotToZCodeTaskSnapshot）决定"打开页面时看到什么"；
 *   - event 映射（zcodeSessionEventToZCodeStreamEvents / stateUpdated）决定"运行中如何增量更新"。
 *   两者若不同步，会出现"刷新前后状态不一致"的典型 bug。
 *
 * 【迁移判据】当 V4 SessionPane/ConversationProjectionStore 完全覆盖旧 ChatView 的
 * 消费面后，本文件应整体删除，而不是继续加新字段。
 * ============================================================================
 */
// ============================================================================
// INV 不变量表：本文件是「V4 session 投影 → 旧 ChatView 形状」的只读迁移桥。
// 所有条目的共同前提：V4 snapshot/event 已经是权威事实，本文件只做翻译，不做业务裁决。
// ============================================================================
// INV-01：snapshot 映射与 event 映射必须产出同一形状（守住它的位置：zcodeSessionSnapshotToZCodeTaskSnapshot 与 zcodeSessionEventToZCodeStreamEvents）。
//   只改一侧会出现「刷新前对、刷新后错」：运行中靠 event，重开页面靠 snapshot，两侧字段名不一致会静默丢值。
// INV-02：本文件不推导 turn/goal/queue 状态，只消费 shared 已算好的值（守住它的位置：全文对 deriveZCodeTaskStatusFromSessionSnapshot、getZCodeGoalActiveIterationCount 的调用）。
//   一旦在 UI 侧重算，两侧算法漂移就会让同一条消息在运行中与刷新后归属不同 iteration。
// INV-03：traceId 的语义是「一次用户输入到本轮回复结束」；有 inputId 时必须用 inputId（守住它的位置：zcodeSessionEventToZCodeStreamEvents 顶部的 traceId 计算）。
//   退回 protocol traceId 会把同一轮的 chunk、工具调用与 complete 拆成不同的组，消息树出现重复气泡。
// INV-04：activePromptInputIdBySession 是一定会清空的临时状态（守住它的位置：setActivePromptInputId 与 turn.completed/turn.failed 的 clear）。
//   不清会让下一轮没有 inputId 的事件错误归属到上一轮，表现为「新回复追加进旧气泡」。
// INV-05：streamedTurnKeys 只用于判断「本轮是否已经流过正文」，不能用来判定完成（守住它的位置：turn.completed 的 response 分支）。
//   把它当完成标记会在正文流尚未结束时抑制补写，或在重放事件时重复补写。
// INV-06：toolNameById 与 streamingToolInputById 都必须在 turn 边界清空（守住它的位置：turn.completed/turn.failed 的 clear 调用）。
//   残留会让同名 toolId 在下一轮复用旧工具名，流式参数被拼接到上一轮的 JSON 上，产生非法 input。
// INV-07：tool_input_delta 在 background-summary 与高频 active 模式下只累积 tombstone，不下发事件（守住它的位置：shouldMaterializeZCodeStreamingToolInputPreview 的早退）。
//   每个 delta 都物化会让长任务在 renderer 里产生 O(n²) 的 JSON 解析，主线程直接卡死。
// INV-08：tool_call 终态之后必须释放 rawInput 只保留 deltaCount（守住它的位置：kind === "tool_call" 分支的 set）。
//   保留大 JSON 会让并发后台任务的 projection state 长期占住 renderer 内存。
// INV-09：AskUserQuestion 与 ExitPlanMode 的 permission.requested 不投影为权限卡（守住它的位置：permission.requested 分支的 isUserInputBackedPermissionToolName 判定）。
//   它们是 runtime 等待态，真正的卡片来自 interaction/requestUserInput；重复投影会出现两张必须回答的卡片。
// INV-10：elicitation 的 options 必须包含「拒绝」语义的默认项（守住它的位置：createExitPlanModeApprovalQuestions 与 askUserQuestionInputToElicitationQuestions）。
//   缺默认项时用户无法拒绝计划，只能强杀会话。
// INV-11：goal verification 分割线的身份键是 targetId + iteration，不是消息 id（守住它的位置：goalVerificationTimelineIdentityKey）。
//   用消息 id 会让同一轮校验在 snapshot 恢复时被追加第二次，聊天区出现重复分割线。
// INV-12：goal verification 分割线必须按 anchorAssistantMessageId 归位，找不到 anchor 才退化为时间戳插入（守住它的位置：insertGoalVerificationTimelineMessages）。
//   只按时间戳插入会让晚到的 divider 漂到下一条 user query 之后，语义上把校验归错轮次。
// INV-13：normalizeGoalVerificationTimelineMessageOrder 必须「先摘出再重新插入」，不能原地排序（守住它的位置：该函数的 filter + insert 组合）。
//   原地排序只改数组顺序，无法把 divider 从错误轮次移动到正确 anchor 之后。
// INV-14：/goal 命令前缀的恢复只在 target.createdAt 与 objective 同时匹配时进行（守住它的位置：restoreGoalCommandUserMessages 的三个条件）。
//   放宽条件会把普通用户消息改写为 /goal，用户看到自己没输入过的命令。
// INV-15：addGoalObjectiveSnapshotFallback 只在「没有任何 user 消息」时补一条（守住它的位置：messages.some(role === "user") 早退）。
//   无条件补会让每轮 goal continuation 都多一个用户气泡，聊天区被重复的 /goal 刷屏。
// INV-16：session fork 分割线只在 parentSessionId 存在且尚无 fork timeline 时补（守住它的位置：addSessionForkSnapshotFallback 的早退条件）。
//   重复补会在同一位置叠加多条分隔线，且每条都不可跳转。
// INV-17：snapshot 恢复必须把持久 todo 一并投影（守住它的位置：plan: sessionTodosToPlanSteps 与 todoGroups）。
//   只依赖内存里的 plan 事件时，从历史打开会话的 todo 面板永远是空的。
// INV-18：todo 的 id 由下标派生且只在本文件内稳定（守住它的位置：sessionTodosToPlanSteps 与 sessionTodoGroupsToRuntime 的字符串拼接）。
//   改用内容做 id 会在 todo 文本编辑后导致 React key 变化，整个列表重挂载并丢失展开状态。
// INV-19：contextUsage 的优先级固定为 runtime > projection（守住它的位置：snapshot 映射里的 ?? 链）。
//   反过来会让旧 projection 的滞后值盖住 runtime 的实时值，环形进度条停在旧水位。
// INV-20：pendingPermissions 必须过滤掉 user-input 类工具（守住它的位置：snapshot 的 filter 与 pendingElicitations 的反向 filter）。
//   两侧都不过滤会让同一个问题既出现在权限区又出现在问答区，用户回答一次后另一处永久挂起。
// INV-21：模型选择值在 UI 侧统一用 formatModelPickerValue/parseModelPickerValue 往返（守住它的位置：configOptions 与 parseModelPickerValue）。
//   直接拼 provider:model 会与 custom: 前缀的编码冲突，回传后 Protocol 收到非法结构。
// INV-22：task meta 的 model 优先取最近一条消息的 info.model（守住它的位置：resolveTaskMetaModelSelectionFromSnapshot）。
//   settings.model.current 可能被错误 runtimeModel 污染；用消息模型作为下次冷恢复 hint 才能让历史自愈。
// INV-23：thought level 的 currentValue 永不为空（守住它的位置：resolveSettingsThoughtLevelCurrentValue 的三级回退）。
//   `currentValue` 为空时工具栏无档位选中：用户会误以为模型不支持思考档，实际只是投影缺省。
// INV-24：compaction 诊断日志必须去重且有上限（守住它的位置：rememberCompactionProjectionDiagSignature 与 COMPACTION_PROJECTION_DIAG_LIMIT）。
//   snapshot 映射在每次渲染都可能执行，不去重会在几秒内写出上万条同构日志，把真正的时间线证据淹没。
// INV-25：诊断日志只允许记录 id、长度与 timeline 元数据，绝不记录正文（守住它的位置：summarize*ForTimelineDiag 的字段选择）。
//   该日志会进入用户可导出的诊断包，正文属于聊天内容，泄露风险高于排障收益。
// INV-26：turn.started 必须清掉同 turnKey 的 streamed 标记（守住它的位置：turn.started 分支的第一行）。
//   清不掉会让重放/重试的同一 turn 被判定为「已流过正文」，最终回复不再补写，用户看到空气泡。
// INV-27：rewind 控制轮的 response 不得补写成正文（守住它的位置：turn.completed 的 isRewindControlTurn 判定）。
//   rewind 的控制输入不是用户提问，把模型回执显示出来会让时间线出现无法解释的消息。
// INV-28：API retry 状态在收到模型进展时必须被清除（守住它的位置：takeProjectionApiRetryClearOnModelProgress 的调用顺序）。
//   不清除会让输入栏的重试计数在一次成功请求后仍然显示，用户以为一直在重试。
// INV-29：apiRetry 的清除事件必须排在正文 chunk 之前（守住它的位置：modelStreaming 分支的 [clear, streaming] 顺序）。
//   顺序反了会让 UI 先渲染正文再撤销重试条，视觉上出现一次闪烁。
// INV-30：turn.failed 在 compact 阶段必须投影成 compaction 失败而不是 task_error（守住它的位置：turnPhase === "compact" 分支）。
//   投影成 task_error 会让整个会话被标记失败，而实际上只是压缩失败、对话仍可继续。
// INV-31：error attribution 只有 schema 校验通过才透传（守住它的位置：errorAttributionSchema.safeParse）。
//   透传未校验字段会把 adapter 内部结构泄露到 UI，且下游按联合类型分支时可能崩溃。
// INV-32：background task 通知的 tool update 必须附加在 turn.started 之后（守住它的位置：backgroundTaskNotificationToolUpdateFromInput 的返回拼接）。
//   单独发会让 UI 在没有任务上下文时插入一个工具气泡。
// INV-33：goal-continuation 的 model-only 输入只投影 goal_iteration_started，不投影用户消息（守住它的位置：inputVisibility === "model-only" 分支）。
//   投影出来会让用户看到自己从未输入的内部提醒文本。
// INV-34：session.titleUpdated 只在 title 非空时投影（守住它的位置：该 case 的三元返回）。
//   空标题会覆盖已有标题，侧栏出现无名会话。
// INV-35：session.updated 与 streamRecovery.updated 必须共用同一个映射函数（守住它的位置：两处 mapSessionInfoLikePayload 调用）。
//   两套映射会让断流恢复后的重试次数与模型状态来自不同字段，UI 数值跳变。
// INV-36：payload 一律先过 asRecord 再读字段（守住它的位置：所有 map* 函数的入口）。
//   直接读取未校验对象在畸形事件下会抛 TypeError，整个事件流中断。
// INV-37：所有可选字段用条件展开而不是塞 undefined（守住它的位置：遍布全文的 ...(x ? { k: x } : {})）。
//   显式 undefined 会在深合并时覆盖已有值，把上一轮的有效字段清空。
// INV-38：streaming preview 的日志采样必须按行数分桶（守住它的位置：logStreamingToolInputProjection 的 bucket 计算）。
//   每个 delta 都打日志会让大参数工具（写文件）产生数千行同构日志。
// INV-39：projection state 由调用方传入，本文件不持有跨会话单例（守住它的位置：createZCodeSessionEventProjectionState 的导出与使用）。
//   模块级单例会让两个会话的 tool 记忆互相污染，且无法随会话关���释放。
// INV-40：本文件所有函数必须保持纯函数语义（除传入的 state 外不写外部状态）（守住它的位置：全文）。
//   隐式缓存会让「重放同一事件序列」得到不同结果，测试与线上行为不可复现。
// INV-41：合并连续 assistant 消息发生在可见过滤之后、goal 回填之前（守住它的位置：coalesceConsecutiveZCodeAssistants 的嵌套层级）。
//   顺序变化会让回填的分割线被合并进 assistant 气泡，或让合并结果丢失 goalIteration 归属。
// INV-42：pending elicitation 的 messageId/toolCallId 必须从 permission 原样带出（守住它的位置：pending*ToElicitationEvent）。
//   自造 id 会让回答无法与 CLI 侧的等待项配对，用户回答后 CLI 仍卡在等待。
// INV-43：AskUserQuestion 的 input 解析失败时返回空问题列表而不是抛错（守住它的位置：askUserQuestionInputToElicitationQuestions 的 try/catch）。
//   抛错会让整个 session 快照映射失败，一个畸形工具参数就能让聊天页白屏。
// INV-44：ExitPlanMode 的审批卡片必须同时提供 approve 与拒绝项（守住它的位置：createExitPlanModeApprovalQuestions）。
//   只有 approve 时 UI 无法表达拒绝，用户只能关闭整个会话。
// INV-45：contextUsage 的 cache 字段只接受非负整数（守住它的位置：optionalContextCacheUsageFromPayload）。
//   负数或 NaN 会让进度条的百分比变成 NaN，CSS 宽度失效后整个卡片塌陷。
// INV-46：usage 累加只看 model.complete 类型的事件（守住它的位置：isModelCompleteUsagePayload）。
//   把增量 usage 也累加会重复计数，费用展示翻倍。
// INV-47：deriveTitleFromSnapshot 必须回退到可见文本再回退到占位文案（守住它的位置：该函数的 ?? 链）。
//   返回空串会让侧栏出现一条没有文本的会话项，看起来像加载失败。
// INV-48：fromZCodeGoal 必须把未知 status 归一为已知联合值（守住它的位置：isZCodeTaskGoalStatus 守卫）。
//   未知 status 直接透传会让目标卡片的样式映射取不到分支，渲染成默认（通常是失败）颜色。
// INV-49：rewind control turn 的记忆必须随 turn 结束删除（守住它的位置：rememberRewindControlTurn 与 turn.completed 的 delete）。
//   不删除会让同一个 turnKey 在重放时被永久判定为控制轮，真实的模型回复被丢弃。
// INV-50：本文件的改动必须同时跑 snapshot 与 event 两条路径的手工用例（守住它的位置：文件头注释的「两条映射必须对齐」）。
//   只测一侧是本文件历史上绝大多数回归的来源。
/* oxlint-disable eslint(max-lines) -- ZCode session 到当前聊天 projection 的迁移桥需要同时保持 snapshot 和 event 映射一致。 */
import {
  getZCodeAgentAvailableModes as getSharedAgentAvailableModes,
  normalizeAvailableZCodeMode,
  coalesceConsecutiveZCodeAssistants,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  decodeCustomModelValue,
  deriveZCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  getConversationMessageProjectionPolicy,
  getZCodeGoalActiveIterationCount,
  getZCodeGoalIterationByAssistantMessageId,
  getZCodeUserVisibleMessages,
  isMainAgentToolProjectionSource,
  isZCodeGoalContinuationReminderMessage,
  normalizeZCodeApiRetryStatus,
  attachZCodeBackgroundTaskNotificationToRaw,
  collectZCodeBackgroundTaskNotificationsByToolUseId,
  mergeZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskNotificationText,
  parseModelPickerValue as parseSharedModelSelection,
  formatModelPickerValue as formatSharedModelSelection,
  resolveZCodeVisibleSessionTitle,
  textFromZCodeMessageParts,
  ZCODE_AGENT_PROVIDER,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
  appendZCodeStreamingToolInputDelta,
  buildZCodeStreamingToolInputPreview,
  createZCodeToolProjectionMemory,
  ensureZCodeToolProjectionMemory,
  finalizeZCodeToolProjectionInput,
  forgetZCodeToolProjectionMetadata,
  isZCodeModelRetryRecoveryProgressPayload,
  markZCodeStreamingToolInputPreviewMaterialized,
  resolveZCodeToolProjectionMetadata,
  shouldMaterializeZCodeStreamingToolInputPreview,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeTaskNetworkDebugStatusFromPayload,
  type ZCodeApiRetryStatus,
  type ZCodeBackgroundTaskNotificationInfo,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeConfigOption,
  type ZCodePersistedMessage,
  type ZCodePersistedMessagePart,
  type ZCodePersistedToolCall,
  type ZCodeTaskGoal,
  type ZCodeTaskGoalStats,
  type ZCodeTaskTargetChangedAction,
  type ZCodeTaskMode,
  type ZCodeTaskModeInfo,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type ZCodeTaskSnapshot,
  type ZCodeTodoGroup,
  type ZCodeTurnSteerCommandKind,
  type ZCodeTurnSteerSource,
  type ZCodePlanStep,
  type ZCodePromptAttachment,
  type ZCodeUsage,
  type InputId,
  type TraceId,
  type ZCodeMessagePart,
  type ZCodeMessageWithParts,
  type ModelSelection,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodePermissionRequestParams,
  type ZCodeSessionEvent,
  type ZCodeSessionMode,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
  type ZCodeStateUpdatedNotification,
  type ZCodeContextCompactionTimelinePhase,
  type ZCodeContextCompactionTimelineMeta,
  type ZCodeGoalVerification,
  type ZCodeGoalVerificationTimelineMeta,
  type ZCodeTimelineMeta,
  type ZCodeTimelineStatus,
  type ZCodeTimelineTrigger,
  type ZCodeToolProjectionMemory,
  type ZCodeUserInputRequestParams,
  type ZCodeUserInputResponse,
  zcodeContextUsageBreakdownSchema,
} from "@zcode/shared";
import { errorAttributionSchema } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

// [权衡] 这三个 id 是配置项与 Protocol 的契约键，必须与 CLI 侧一致；
// 因此写成常量而不是枚举：它们是跨进程字符串，改名等于协议破坏。
const MODEL_CONFIG_ID = "model";
// [事务] thought_level 是独立配置项，不能与 model 合并：模型切换后档位需要单独保留。
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
// [事务] mode 与 model 分开下发的另一个原因：Plan/Edit 的切换不需要重建会话。
const MODE_CONFIG_ID = "mode";
// [事务] 这类工具名是「permission 与 elicitation 的分界」：名字命中时必须走问答投影（INV-09），
// 一旦拼写与 CLI 不一致，用户会同时看到权限卡与问答卡。
// [权衡] 用字面量而不是从协议包导入：工具名属于稳定协议面，导入反而增加耦合。
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
// [事务] ExitPlanMode 的 permission.requested 同样是等待态，真正的审批问题由快照里的 pending 项补出。
// [失败路径] 若这里漏掉，用户在计划模式下会看到一个「允许 ExitPlanMode」的权限弹窗，
// 批准后却没有进入编辑模式，表现为点了没反应。
const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
// [权衡] 这句文案在 UI 侧固化：CLI 的 permission 描述是给模型看的，不适合直接展示给用户。
const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
// [事务] approve 是拒绝项之外的唯一肯定答案 id；UI 用 id 而不是下标匹配，
// 保证选项顺序变化后审批逻辑仍然正确。
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";
// [资源] 日志按 50 行分桶：流式参数每 delta 都可能增长，逐行打会把日志量放大两个数量级。
// [权衡] 分桶会丢失精确行数，但保留「量级」已足够判断预览是否被错误物化。
const STREAMING_TOOL_INPUT_INFO_LOG_LINE_BUCKET = 50;
// [资源] 这是模块级 Map，必须靠「只记录已跨过的桶」收敛：每个 toolId 至多留下一个整数项。
// [失败路径] 若改成记录每次长度，条目数会随 delta 数增长，长会话下成为内存泄漏点。
// [并发] 多个会话共用同一张表，key 必须带 session/tool 维度，否则同名 toolId 会互相吞日志。
const streamingToolInputProjectionLogBuckets = new Map<string, number>();
// [资源] 诊断签名集合的上限：超过即整体清空，用一次性偶发重复换取内存有界（INV-24）。
const COMPACTION_PROJECTION_DIAG_LIMIT = 200;
// [资源] 去重集合本身也是内存点：用「达到上限就清空」的粗粒度策略，
// 而不是 LRU，因为这里的目标是有界而非高命中率（诊断日志重复几条无妨）。
const compactionProjectionDiagSignatures = new Set<string>();
// [事务] 模式选项在模块加载时求值一次：它来自 shared 的静态表，不随会话变化。
// [权衡] 若放进函数内求值，每次构建 configOptions 都会新建数组，导致 React 引用比较全部失效、工具栏重渲染。
const ZCODE_AGENT_MODE_OPTIONS = getSharedAgentAvailableModes();

// [事务] 这是「会话级事件投影的可变内存」：所有跨事件需要记住的东西都挂在这里，
// 而不是模块级变量（INV-39），这样多个会话、多个渲染实例之间天然隔离。
// [资源] 每个字段都必须有明确的清理点（turn 边界或显式 reset），否则长会话会单调增长。
// [并发] 该对象不做并发保护：调用方保证同一会话的事件按序进入，乱序由上层纠正。
export interface ZCodeSessionEventProjectionState extends ZCodeToolProjectionMemory {
  activePromptInputIdBySession?: Map<string, InputId>;
  rewindControlTurnKeys?: Set<string>;
  activeApiRetrySessionIds?: Set<string>;
  backgroundTaskControlsBySession?: Map<string, ZCodeBackgroundTaskControlItem[]>;
  streamedTurnKeys?: Set<string>;
}

// [事务] 只创建必然需要的三个集合，其余字段（如 backgroundTaskControlsBySession）惰性创建：
// 大多数会话没有后台任务，预先分配只会抬高每个会话的常驻内存。
// [资源] spread 工具记忆的工厂结果而不是共享引用，保证每个会话一份。
export function createZCodeSessionEventProjectionState(): ZCodeSessionEventProjectionState {
  return {
    ...createZCodeToolProjectionMemory(),
    activePromptInputIdBySession: new Map<string, InputId>(),
    activeApiRetrySessionIds: new Set<string>(),
    streamedTurnKeys: new Set<string>(),
  };
}

// [权衡] 两种模式只影响「流式参数是否物化」这一条策略（INV-07）：
// active-live 追求跟手，background-summary 追求不打扰也不耗性能。
// 不把模式扩散成多套映射函数，是为了避免两条代码路径长期漂移。
export type ZCodeSessionProjectionMode = "active-live" | "background-summary";

// [事务] 所有对外的模型值都必须经过这一层编码：UI 只认识字符串，Protocol 只认识结构体（INV-21）。
// 直接透传结构体会让 configOptions 的 currentValue 变成 [object Object]，选择器无法高亮。
export function formatModelPickerValue(ref: ModelSelection | undefined): string {
  return formatSharedModelSelection(ref);
}

// [事务] 从后往前找最近一条带 model 的消息：这是「该会话实际用过什么模型」的唯一证据。
// [失败路径] 找不到时返回 undefined 而不是默认模型，让调用方决定回退策略。
function resolveLatestMessageModelSelection(
  messages: readonly ZCodeMessageWithParts[],
): ModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.info.model;
    if (model) {
      return model;
    }
  }
  return undefined;
}

// [事务] 这里刻意优先消息模型（INV-22）：settings.model.current 会被错误的 runtimeModel 覆盖，
// 而 task meta 会作为下一次冷恢复的 hint，用被污染的值会让错误永久固化。
// [权衡] 该修复只对「有消息历史」的会话生效；全新空会话仍然使用 settings 的当前模型。
function resolveTaskMetaModelSelectionFromSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ModelSelection | undefined {
  // 历史 resume 被错误 runtimeModel 覆盖时，settings.current 会变成 app 当前默认模型，
  // 但消息 info.model 仍记录真实使用的模型。task meta 会作为下次冷恢复 hint，
  // 因此优先用最近消息模型让已污染的历史记录自愈。
  return resolveLatestMessageModelSelection(snapshot.messages) ?? snapshot.settings.model.current;
}

// [失败路径] custom: 前缀的解码失败时回退到共享解析器：它至少能处理 provider:model 形式。
// 若在这里抛错，用户在模型选择器里点一下就会让整个设置面板报错。
// [事务] 解码结果必须同时具备 providerId 与 modelName 才算有效（INV-21）。
export function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    // UI 自定义模型值是展示态 custom:provider:model，
    // ZCode Protocol 必须收到严格的 providerId/modelId 结构。
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}

// [事务] 这是旧 UI 的多套模式名 → V4 四种模式的收敛表：yolo/bypassPermissions/dontAsk 合并为 yolo，
// build/default/acceptEdits/autoEdit 合并为 build。
// [失败路径] 未命中的模式返回 undefined 而不是随便挑一个：让调用方保持「未知」而不是误显示为 Edit，
// 后者会让用户以为自己的高危模式被降级了。
// [权衡] 收敛是有损的：回写时无法还原具体旧名，因此本函数只用于只读展示。
export function toZCodeTaskMode(mode: ZCodeTaskMode | undefined): ZCodeSessionMode | undefined {
  switch (mode) {
    case "plan":
      return "plan";
    case "edit":
      return "edit";
    case "guarded":
      return "guarded";
    case "yolo":
    case "bypassPermissions":
    case "dontAsk":
      return "yolo";
    case "auto":
      return "auto";
    case "build":
    case "default":
    case "acceptEdits":
    case "autoEdit":
      return "build";
    default:
      return undefined;
  }
}

// [事务] settings → configOptions 是「一次性全量」映射：Model 与 Mode 恒存在，Thought Level 按 enabled 可选。
// [失败路径] 模型列表为空时仍然返回模型项（options 为空数组），让工具栏显示「无可用模型」而不是凭空少一个控件。
// [权衡] 这里不做排序：available 的顺序由 CLI 决定（通常是推荐序），UI 重排会破坏产品意图。
export function zcodeSessionSettingsToConfigOptions(
  settings: ZCodeSessionSettingsState,
): ZCodeConfigOption[] {
  const configOptions: ZCodeConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      // [事务] currentValue 必须与 options 里的 value 使用同一编码函数，否则选择器找不到匹配项，
      // 表现为下拉框显示空白但功能仍可用（用户以为模型丢了）。
      currentValue: formatModelPickerValue(settings.model.current),
      // [事务] 模型选项的 value 必须再次走 formatModelPickerValue（INV-21）：
      // currentValue 与 options 使用同一编码，选择器才能按字符串相等匹配。
      // [失败路径] 单个模型的 reasoning 缺失时只是不提供档位元数据，不能让整个列表失败。
      options: settings.model.available.map((model) => {
        // [事务] 档位列表只传 value：UI 只需要知道该模型支持哪些档，label 由共享表提供。
        // [失败路径] reasoning 缺失时得到 undefined，条件展开后字段整个不出现（INV-37）。
        const modelThoughtLevels = model.reasoning?.levels.map((level) => level.value);
        // [事务] 默认档位必须同时满足「存在」且「在可用列表里」：
        // 不在列表里的 defaultLevel 是脏数据，透传会让选择器高亮一个不可选项。
        const modelDefaultThoughtLevel =
          model.reasoning?.defaultLevel &&
          modelThoughtLevels?.includes(model.reasoning.defaultLevel)
            ? model.reasoning.defaultLevel
            : undefined;
        return {
          value: formatModelPickerValue(model.ref),
          name: model.label,
          description: model.description,
          modelProviderId: model.ref.providerId,
          modelProviderName: model.providerLabel ?? model.ref.providerId,
          // [事务] 元数据用条件展开：空数组与「不支持思考」是两种语义，不能混为一谈。
          ...(modelThoughtLevels ? { modelThoughtLevels } : {}),
          ...(modelDefaultThoughtLevel ? { modelDefaultThoughtLevel } : {}),
        };
      }),
    },
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      // [事务] 模式 currentValue 也要归一：settings 里可能残留旧模式名（autoEdit 等），
      // 不归一的话下拉框选中项为空，用户会以为模式设置丢了。
      currentValue: normalizeAvailableZCodeMode(settings.mode.current),
      options: getZCodeAgentModeSelectOptions(),
    },
  ];
  // [事务] 只有 enabled 时才追加档位项：不支持的模型不应出现一个永远禁用或空列表的下拉框。
  // [失败路径] available 为空时仍然追加，currentValue 会回退为 ""，至少让用户看到「无档位」。
  if (settings.thoughtLevel.enabled) {
    configOptions.push({
      id: THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: resolveSettingsThoughtLevelCurrentValue(settings.thoughtLevel) ?? "",
      options: settings.thoughtLevel.available.map((level) => ({
        value: level.value,
        name: level.label,
        description: level.description,
      })),
    });
  }
  return configOptions;
}

// [权衡] workspace 级展示只需要 Mode：模型与档位属于会话设置，放在工作区层面会误导用户以为全局生效。
export function zcodeWorkspacePresentationToConfigOptions(
  mode: ZCodeSessionMode,
): ZCodeConfigOption[] {
  return [
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableZCodeMode(mode),
      options: getZCodeAgentModeSelectOptions(),
    },
  ];
}

// [事务] 三级回退 current → defaultLevel → available[0]（INV-23）：保证永远有一个被选中的档位。
// [失败路径] current 不在 available 里时视为未设置：这通常发生在模型切换后旧档位失效，
// 直接透传会让选择器高亮一个不存在的选项。
function resolveSettingsThoughtLevelCurrentValue(
  thoughtLevel: ZCodeSessionSettingsState["thoughtLevel"],
): string | undefined {
  // [资源] 用 Set 做 membership 判定而不是每次 includes：
  // 该函数在每次构建 configOptions 时都会执行，档位多时线性查找会成为可观测开销。
  const thoughtLevelValues = new Set(thoughtLevel.available.map((level) => level.value));
  // [事务] current 不在 available 中时视为未设置（INV-23）：模型切换后旧档位失效是常见情况，
  // 直接把旧值当作选中项会让用户无法通过下拉框改回来。
  const currentThoughtLevel =
    thoughtLevel.current && thoughtLevelValues.has(thoughtLevel.current)
      ? thoughtLevel.current
      : undefined;
  const defaultThoughtLevel =
    thoughtLevel.defaultLevel && thoughtLevelValues.has(thoughtLevel.defaultLevel)
      ? thoughtLevel.defaultLevel
      : undefined;
  // ZCode Protocol 的 defaultLevel 是模型事实，current 为空时表示用户尚未显式修改。
  // 实时模型状态事件也要投影默认值，否则工具栏会拿到空 currentValue，出现没有档位被选中的 UI。
  return currentThoughtLevel ?? defaultThoughtLevel ?? thoughtLevel.available[0]?.value;
}

/**
 * snapshot → 旧 task 快照。
 *
 * 这是"打开页面/恢复"的一次性映射：必须把 V4 的 rows/meta/config/goal 等
 * 全部翻译成旧 UI 认识的字段；任何新字段若只加在 event 映射、没加在这里，
 * 刷新后就会丢失。
 */
// 打开页面/冷恢复的唯一入口（INV-01）：把 V4 snapshot 翻译成旧 task snapshot。
// [事务] 步骤顺序固定：先算 meta 与 goal 归属 → 过滤可见消息 → 逐条转持久消息 → 合并连续 assistant
// → 补回 /goal 与 fork 分割线 → 归一 goal verification 顺序。任一步提前或延后都会改变可见集合。
// [失败路径] 单条消息映射失败不应让整个 snapshot 失败；由各 map 函数内部降级，保证页面能打开。
export function zcodeSessionSnapshotToZCodeTaskSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ZCodeTaskSnapshot {
  // [事务] meta 必须先算出来：它是侧栏一行与下次冷恢复 hint 的唯一来源（INV-22），
  // 后面的消息后处理一律不回写 meta，否则会出现「刷新前后标题/状态不一致」。
  const meta = zcodeSessionSnapshotToTaskMeta(snapshot);
  const activeGoalIterationCount = getSnapshotGoalActiveIterationCount(snapshot);
  // [事务] goal 归属由 shared 依据 target + maxGoalIteration 计算（INV-02），这里只传上下文不重算。
  // [权衡] 传 activeGoalIterationCount 作为上限，是为了阻止历史污染数据产生超大的 iteration 号
  // 把新消息错误归到早期轮次。
  const goalIterationByAssistantMessageId = getZCodeGoalIterationByAssistantMessageId(
    snapshot.messages,
    {
      ...(activeGoalIterationCount > 0 ? { maxGoalIteration: activeGoalIterationCount } : {}),
      target: snapshot.projection.target,
    },
  );
  // [事务] 可见性过滤必须先于一切消息加工：内部提醒、model-only 输入不应该进入后续任何步骤，
  // 否则合并连续 assistant 时会把它们当作正文的一部分。
  const visibleMessages = getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  });
  // [资源] 后台任务通知按 toolUseId 建索引一次，供逐条消息映射复用：
  // 每条消息单独扫描会导致 O(n²)，长会话下打开页面明显卡顿。
  const backgroundTaskNotifications = collectZCodeBackgroundTaskNotificationsByToolUseId(
    snapshot.messages,
  );
  if (snapshot.projection.target) {
    // [资源] 归属诊断只在有 target 时执行（INV-24/25）：它统计的是轮次分布，
    // 不记录任何正文，避免诊断日志变成聊天内容的泄露渠道。
    const assistantGoalIterations = [...goalIterationByAssistantMessageId.values()];
    const goalIterationCounts = assistantGoalIterations.reduce<Record<string, number>>(
      (counts, iteration) => ({
        ...counts,
        [String(iteration)]: (counts[String(iteration)] ?? 0) + 1,
      }),
      {},
    );
    logger.debug("[goalIterationDiag] snapshot projection", {
      assistantGoalIterations: goalIterationCounts,
      // [权衡] 这段诊断只在存在 projection.target 时执行：它用于排查 goal 归属，
      // 无目标会话执行只是白白遍历一遍消息。
      // [资源] 只记录计数与 seq，不记录内容（INV-25）。
      goalContinuationReminderUsers: snapshot.messages.filter(
        (message) =>
          message.info.role === "user" && isZCodeGoalContinuationReminderMessage(message),
      ).length,
      goalStatsIteration: snapshot.goalStats?.iterationCount ?? null,
      rawMessages: snapshot.messages.length,
      sessionId: snapshot.session.sessionId,
      snapshotEventSeq: snapshot.runtime.eventSeq,
      targetId: snapshot.projection.target.targetId,
      visibleMessages: visibleMessages.length,
    });
  }
  // [事务] 四层后处理从内到外依次是：合并连续 assistant → 恢复 /goal 前缀 → 补目标缺失时的首条 user
  // → 补 goal verification 分割线 → 补 fork 分割线 → 重新归位 verification。
  // [失败路径] 顺序不可交换：先补分割线再合并 assistant，会让分割线被吞进气泡里。
  const messages = normalizeGoalVerificationTimelineMessageOrder(
    addSessionForkSnapshotFallback(
      addGoalVerificationTimelineSnapshotFallback(
        addGoalObjectiveSnapshotFallback(
          restoreGoalCommandUserMessages(
            coalesceConsecutiveZCodeAssistants(
              visibleMessages.map((message) =>
                zcodeMessageToZCodePersistedMessage(
                  message,
                  message.info.role === "assistant"
                    ? goalIterationByAssistantMessageId.get(message.info.messageId)
                    : undefined,
                  backgroundTaskNotifications,
                ),
              ),
            ),
            snapshot,
          ),
          snapshot,
        ),
        snapshot,
      ),
      snapshot,
    ),
  );
  // [资源] 诊断必须在全部后处理之后：它统计的是「最终可见集合」，
  // 提前执行会拿到中间态，且去重键（INV-24）会对不上最终结果。
  logCompactionProjectionDiagnostic(snapshot, visibleMessages, messages);
  // [事务] 权限区与问答区互斥（INV-20）：这里先滤掉 user-input 类工具，
  // 下方 pendingElicitations 再用同一判据做反向过滤，保证同一条 pending 只出现一次。
  const pendingPermissions: ZCodePermissionRequest[] = snapshot.projection.pendingPermissions
    .filter((permission) => !isUserInputBackedPermissionToolName(permission.toolName))
    .map((permission) => pendingPermissionToStreamEvent(snapshot.session.sessionId, permission));
  return {
    meta,
    messages,
    // [权衡] fileChanges 恒为空：V4 用 tool part 表达文件改动，旧 UI 的这个字段没有消费者；
    // 强行填充会让侧栏多出一份与工具块重复的清单。
    fileChanges: [],
    configOptions: zcodeSessionSettingsToConfigOptions(snapshot.settings),
    // Bugfix: session/read 已经通过协议返回 `/compact` 等 slashCommands。
    // 历史 task restore 会消费这里投影出的 task snapshot；如果不透传，UI 回填 store 时只能拿到空列表。
    // [事务] slashCommands 必须透传（历史 bug：不透传时回填 store 只能拿到空列表）：
    // 历史 task restore 消费的就是这个字段，缺了它命令面板在旧会话里为空。
    slashCommands: snapshot.slashCommands ?? [],
    runtime: {
      activeTurnKind: snapshot.runtime.activeTurnKind,
      apiRetry: snapshot.runtime.apiRetry ?? null,
      // [事务] 优先级 runtime > projection（INV-19）：runtime 是本次快照的实时值，
      // projection 是上一次事件的落库值，后者可能落后一整轮。
      // [失败路径] 两者都缺失时显式给 undefined，让 UI 隐藏环形图而不是显示 0%。
      contextUsage:
        contextUsageFromRuntime(snapshot.runtime.contextUsage) ??
        contextUsageFromProjection(snapshot.projection) ??
        undefined,
      pendingPermissions,
      // [事务] 后台 bash 任务来自 projection 的全量列表：冷恢复必须一次性还原，
      // 否则重开页面后任务面板为空，而 CLI 侧的任务其实还在跑。
      backgroundBashJobs: parseZCodeBackgroundTaskControlItems(snapshot.projection.backgroundJobs),
      // [事务] 问答卡片的来源是 permission 中 toolName 属于 AskUserQuestion/ExitPlanMode 的项（INV-09）。
      // [失败路径] 映射结果再用类型守卫过滤 null：个别 permission 缺少必要字段时跳过，
      // 不能让一张坏卡片拖垮整个快照。
      pendingElicitations: snapshot.projection.pendingPermissions
        .filter((permission) => isUserInputBackedPermissionToolName(permission.toolName))
        .map((permission) =>
          pendingUserInputBackedPermissionToElicitationEvent(
            snapshot.session.sessionId,
            permission,
          ),
        )
        .filter(
          (event): event is Extract<ZCodeStreamEvent, { type: "elicitation_request" }> =>
            event !== null,
        ),
      // Bugfix: agent 恢复历史 session 时会从 DB 读取 todo；UI 的 todo 面板不能再只依赖
      // 当前 renderer 内存里的 plan 事件，否则从历史打开会丢失持久 todo。
      // [事务] 持久 todo 必须投影（INV-17）：agent 恢复历史会话时会从 DB 读 todo，
      // UI 若只依赖内存 plan 事件，从历史打开的会话会丢失整个待办面板。
      plan: sessionTodosToPlanSteps(snapshot.todos),
      // [事务] 目标统计是可选块：没有 goalStats 时整个字段不出现，
      // 让 UI 的「有目标」判断保持为 false，而不是拿到一个全零对象。
      goalStats: sessionGoalStatsToRuntime(snapshot.goalStats),
      goalVerifications: snapshot.runtime.goalVerifications ?? null,
      goalVerificationTimeline: snapshot.runtime.goalVerificationTimeline ?? null,
      // [事务] todo 分组与 plan 是同一份数据的两种视图，必须同时投影（INV-17）：
      // 只给其中一个会让分组面板或计划面板在历史会话里为空。
      todoGroups: sessionTodoGroupsToRuntime(snapshot.todoGroups),
    },
  };
}

// [事务] compaction part 是协议侧的权威标记，用它判断「这个会话发生过压缩」，
// 而不是看文本里是否出现摘要文案（文案可被用户编辑，不可靠）。
function hasProtocolCompactionPart(message: ZCodeMessageWithParts): boolean {
  return message.parts.some((part) => part.type === "compaction");
}

// [事务] 取第一条 compaction part 的元数据即可：一条消息最多携带一次压缩操作。
// [失败路径] metadata 缺失时用 partId 兜底 operationId，保证诊断日志里的操作仍可定位。
// [权衡] phase/timelineStatus 用 stringValue 读取而不做枚举校验：诊断日志容忍未知值。
function protocolMessageTimelineStatus(message: ZCodeMessageWithParts) {
  for (const part of message.parts) {
    if (part.type !== "compaction") {
      continue;
    }
    const metadata = asRecord(part.metadata);
    return {
      auto: part.auto,
      operationId: stringValue(metadata.operationId) ?? part.partId,
      phase: stringValue(metadata.phase),
      status: stringValue(metadata.timelineStatus),
      summaryMessageId: part.summaryMessageId ?? stringValue(metadata.summaryMessageId),
    };
  }
  return null;
}

// [资源] 摘要只保留身份、时间、part 类型与文本长度（INV-25）：
// 这些字段足以判断「消息在不在、part 有没有丢」，而不泄露正文。
function summarizeProtocolMessageForTimelineDiag(message: ZCodeMessageWithParts, index: number) {
  return {
    index,
    id: message.info.messageId,
    role: message.info.role,
    created: message.info.time.created,
    completed: message.info.time.completed,
    partTypes: message.parts.map((part) => part.type),
    textLength: textFromZCodeMessageParts(message.parts).length,
    compaction: protocolMessageTimelineStatus(message),
  };
}

// [权衡] 对 compaction timeline 保留完整元数据、对其他 timeline 只保留 type：
// `summarizePersistedMessageForTimelineDiag` 的排查目标就是压缩，其余类型没有诊断价值。
function summarizePersistedMessageForTimelineDiag(message: ZCodePersistedMessage, index: number) {
  const timeline = message.syntheticTimeline;
  return {
    index,
    id: message.id ?? null,
    role: message.role,
    timestamp: message.timestamp,
    contentLength: message.content.length,
    thoughtLength: message.role === "assistant" ? (message.thought?.length ?? 0) : 0,
    partTypes: message.role === "assistant" ? (message.parts?.map((part) => part.type) ?? []) : [],
    timeline:
      timeline?.type === "context_compaction"
        ? {
            type: timeline.type,
            operationId: timeline.operationId,
            status: timeline.status,
            trigger: timeline.trigger,
            phase: timeline.phase,
            inputId: timeline.inputId,
            summaryMessageId: timeline.summaryMessageId,
          }
        : timeline
          ? { type: timeline.type }
          : null,
  };
}

// [资源] 只取尾部 12 条：聊天越长，全量打印越可能触发日志截断，反而看不到出问题的那一段。
function lastTimelineDiagItems<T>(
  items: readonly T[],
  mapItem: (item: T, index: number) => unknown,
) {
  const start = Math.max(0, items.length - 12);
  return items.slice(start).map((item, offset) => mapItem(item, start + offset));
}

// [资源] 命中即返回 false（不记录），未命中则写入（INV-24）。
// [失败路径] 达到上限时整体清空再写入当前签名：宁可让旧签名重新出现一次，
// 也不使用无界 Set 把 renderer 内存拖垮。
function rememberCompactionProjectionDiagSignature(signature: string): boolean {
  if (compactionProjectionDiagSignatures.has(signature)) {
    return false;
  }
  compactionProjectionDiagSignatures.add(signature);
  if (compactionProjectionDiagSignatures.size > COMPACTION_PROJECTION_DIAG_LIMIT) {
    compactionProjectionDiagSignatures.clear();
    compactionProjectionDiagSignatures.add(signature);
  }
  return true;
}

// [权衡] 只有「真的发生过压缩」才记录：否则每次快照映射都会写一条日志，
// 在长会话里足以把 info 级日志刷满。
// [事务] 签名由 sessionId + eventSeq + updatedAt + 尾部形状组成：
// 四个维度任一变化都代表状态真的变了，避免把「重新渲染」误判成「状态变化」。
function logCompactionProjectionDiagnostic(
  snapshot: ZCodeSessionStateSnapshot,
  visibleMessages: readonly ZCodeMessageWithParts[],
  projectedMessages: readonly ZCodePersistedMessage[],
) {
  const hasCompaction =
    snapshot.messages.some(hasProtocolCompactionPart) ||
    projectedMessages.some((message) => message.syntheticTimeline?.type === "context_compaction");
  if (!hasCompaction) {
    return;
  }

  // [事务] 尾部签名取最后 8 条的身份/角色/长度/timeline 类型：
  // 这是判断「投影是否丢消息」最灵敏且最便宜的指纹。
  // [失败路径] 用 join 拼字符串而不是 JSON.stringify：避免正文进入签名导致日志泄露正文。
  const projectedTailSignature = projectedMessages
    .slice(-8)
    .map((message) => {
      const timeline = message.syntheticTimeline;
      return [
        message.id ?? "",
        message.role,
        message.content.length,
        timeline?.type ?? "",
        timeline?.type === "context_compaction" ? timeline.status : "",
      ].join(":");
    })
    .join("|");
  const signature = [
    snapshot.session.sessionId,
    snapshot.runtime.eventSeq ?? "no-seq",
    snapshot.session.updatedAt,
    projectedTailSignature,
  ].join("#");
  // [资源] 重复签名直接跳过整段日志构造：注意 logger.info 的参数在调用前就已求值，
  // 因此必须在这里早退，而不是在 logger 内部过滤。
  if (!rememberCompactionProjectionDiagSignature(signature)) {
    return;
  }

  // 修复排查：auto compact 之后曾出现 DB 有 assistant 但 GUI 不显示。
  // 这里只记录消息身份、长度和 timeline 元数据，避免把用户正文落进 UI 日志。
  logger.info("[conversationSessionTimelineDiag] projection compact snapshot", {
    sessionId: snapshot.session.sessionId,
    status: snapshot.session.status,
    eventSeq: snapshot.runtime.eventSeq ?? null,
    rawCount: snapshot.messages.length,
    visibleCount: visibleMessages.length,
    projectedCount: projectedMessages.length,
    rawTail: lastTimelineDiagItems(snapshot.messages, summarizeProtocolMessageForTimelineDiag),
    visibleTail: lastTimelineDiagItems(visibleMessages, summarizeProtocolMessageForTimelineDiag),
    projectedTail: lastTimelineDiagItems(
      projectedMessages,
      summarizePersistedMessageForTimelineDiag,
    ),
  });
}

// [事务] 只恢复被「瘦身」的那一条 /goal 消息：条件是角色 user、时间等于 target.createdAt、
// 正文等于 objective（INV-14）。三个条件缺一不可。
// [失败路径] 没有任何匹配时返回原数组引用，避免下游因引用变化触发无谓重渲染。
function restoreGoalCommandUserMessages(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const target = snapshot.projection.target;
  const objective = target?.objective.trim();
  if (!target || !objective) {
    return messages;
  }

  let changed = false;
  const restored = messages.map((message) => {
    if (
      message.role !== "user" ||
      message.timestamp !== target.createdAt ||
      message.content.trim() !== objective
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      // Bugfix: /goal set 的 agent snapshot 已经持久化了一条可见 user message，
      // 但正文只保留 objective。这里按 target 创建时间恢复命令前缀，避免首轮 query 丢失 "/goal"。
      content: `/goal ${objective}`,
    };
  });

  return changed ? restored : messages;
}

// [事务] 先把 timeline 按 targetId 过滤再交给 shared 计算：多目标会话的 timeline 混在一起，
// 不过滤会把别的目标的轮次算进当前目标。
function getSnapshotGoalActiveIterationCount(snapshot: ZCodeSessionStateSnapshot): number {
  const targetId = snapshot.projection.target?.targetId;
  const timeline =
    snapshot.runtime.goalVerificationTimeline?.filter(
      (item) => !targetId || item.targetId === targetId,
    ) ?? [];
  return getZCodeGoalActiveIterationCount({
    targetStatus: snapshot.projection.target?.status ?? null,
    timeline,
  });
}

// [事务] 仅在「没有可见 user 消息」且「存在续跑提醒」时补一条 /goal（INV-15）：
// 这是历史恢复时唯一能还原用户原始意图的证据。
// [失败路径] 缺 objective 或缺少续跑提醒时原样返回：宁可少一条消息，也不要凭空造用户输入。
function addGoalObjectiveSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const objective = snapshot.projection.target?.objective.trim();
  if (
    !objective ||
    messages.some((message) => message.role === "user") ||
    !snapshot.messages.some(isZCodeGoalContinuationReminderMessage)
  ) {
    return messages;
  }

  // [事务] 用续跑提醒的时间作为补回消息的时间戳：它最接近原始用户输入的轮次，
  // 用 target.createdAt 会让消息漂到会话最前面。
  const continuationMessage = snapshot.messages.find(isZCodeGoalContinuationReminderMessage);
  // Bugfix: /goal 续跑会把目标包进 model-only system-reminder，shared 可见过滤会正确隐藏内部 XML。
  // 但历史恢复如果没有原始用户 turn，聊天区会只剩 assistant 回复；这里补回用户实际输入的命令形态，
  // 避免首轮 query 被瘦身成 objective 后丢失 "/goal" 上下文。
  return [
    {
      role: "user",
      content: `/goal ${objective}`,
      timestamp:
        continuationMessage?.info.time.created ??
        snapshot.projection.target?.createdAt ??
        snapshot.session.createdAt,
      model: formatModelPickerValue(snapshot.settings.model.current),
    },
    ...messages,
  ];
}

// [事务] fork 分割线补在消息末尾（这是历史 bug 的修复）：旧数据没有落库 notice，
// 只能从 parentSessionId 还原一个不可跳转的分隔线（INV-16）。
// [失败路径] 已有 fork timeline 时直接返回，避免重复分隔线。
function addSessionForkSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const parentSessionId = snapshot.session.parentSessionId;
  if (
    !parentSessionId ||
    messages.some((message) => message.syntheticTimeline?.type === "session_fork")
  ) {
    return messages;
  }

  return [
    ...messages,
    {
      // [权衡] id 以连字符结尾是有意的：它标记这条分割线「没有 targetMessageId」，
      // 点击时不会尝试跳转到一个不存在的消息。
      id: `zcode-timeline-fork-${parentSessionId}-`,
      role: "user",
      content: "",
      timestamp: snapshot.session.createdAt,
      // Bugfix: 旧的纯对话 fork 没有落库 synthetic notice，只能从 session.parentSessionId
      // 恢复一个不可跳转的分割线，避免历史 fork 会话完全看不到来源边界。
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "session_fork",
        display: "separator",
        parentSessionId,
        targetMessageId: "",
      },
    },
  ];
}

// [事务] goal verifier 的生命周期是 agent 事件存储的持久事实，不在消息历史里，
// 因此 snapshot 恢复必须把它补成边界分割线（INV-11/12）。
// [并发] 先算出已存在的身份键再过滤：重放同一快照不会重复追加同一轮校验。
// [失败路径] timeline 为空或全部已存在时返回原数组引用，保持引用稳定。
function addGoalVerificationTimelineSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const timeline = snapshot.runtime.goalVerificationTimeline ?? [];
  if (timeline.length === 0) {
    return messages;
  }

  const existingIds = new Set(
    messages
      .map((message) =>
        message.syntheticTimeline?.type === "goal_verification"
          ? goalVerificationTimelineIdentityKey(message.syntheticTimeline)
          : null,
      )
      .filter((id): id is string => Boolean(id)),
  );
  const timelineMessages = timeline
    .filter((item) => !existingIds.has(goalVerificationTimelineIdentityKey(item)))
    .map<ZCodePersistedMessage>((item) => ({
      id: goalVerificationTimelineMessageId(item),
      role: "assistant",
      content: "",
      timestamp: item.startedAt ?? item.updatedAt,
      // 修复原因：goal verifier lifecycle 是 agent event-store 持久事实，不在 message history 内；
      // snapshot 恢复时必须按 target+iteration 和 anchor 补成边界 divider，避免同一轮校验重复追加或漂到下一轮。
      syntheticTimeline: item,
    }));
  if (timelineMessages.length === 0) {
    return messages;
  }
  return insertGoalVerificationTimelineMessages(messages, timelineMessages);
}

// [事务] 有 iteration 号时用 targetId:iteration 作为身份（INV-11），
// 没有时才退回 verificationId：前者是业务身份，后者是执行身份，
// 同一轮重试会换 verificationId 但 iteration 不变，用后者会导致重复分割线。
function goalVerificationTimelineIdentityKey(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `${item.targetId}:${item.goalIteration}`;
  }
  return `verification:${item.verificationId}`;
}

// [事务] 消息 id 与身份键同构，便于把分隔线反查回 timeline 项；前缀固定避免与其他合成消息冲突。
function goalVerificationTimelineMessageId(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `zcode-goal-verification-${item.targetId}-${item.goalIteration}`;
  }
  return `zcode-goal-verification-${item.verificationId}`;
}

// [事务] 按时间升序逐条插入（INV-12）：先查 anchor，命中则插在 anchor 之后、跳过连续分割线；
// 未命中才按时间戳二分定位。
// [并发] 每次都基于 result 的当前状态查找 anchor，保证多条 divider 的相对顺序稳定。
// [失败路径] anchor 消息可能已被合并（id 不同），此时 findPersistedMessageIndexById 会退化为时间戳插入。
function insertGoalVerificationTimelineMessages(
  messages: ZCodePersistedMessage[],
  timelineMessages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const result = [...messages];
  for (const message of [...timelineMessages].sort(
    (left, right) => left.timestamp - right.timestamp,
  )) {
    const timeline = message.syntheticTimeline;
    const anchorIndex =
      timeline?.type === "goal_verification" && timeline.anchorAssistantMessageId
        ? findPersistedMessageIndexById(result, timeline.anchorAssistantMessageId)
        : -1;
    if (anchorIndex >= 0) {
      result.splice(goalVerificationAnchorInsertIndex(result, anchorIndex), 0, message);
      continue;
    }
    result.splice(timestampInsertIndex(result, message.timestamp), 0, message);
  }
  return result;
}

// [事务] 先摘出所有 verification 分割线，再用同一套插入逻辑归位（INV-13）：
// 因为 agent 历史里持久化的 divider 可能晚于下一条 user query 才到达。
// [权衡] 无分割线时直接返回原数组引用，避免无谓的复制与重渲染。
function normalizeGoalVerificationTimelineMessageOrder(
  messages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const timelineMessages = messages.filter(
    (message) => message.syntheticTimeline?.type === "goal_verification",
  );
  if (timelineMessages.length === 0) {
    return messages;
  }
  // 修复原因：agent history 里已经持久化的 goal verifier divider 可能晚于下一条
  // user query 才到达；snapshot projection 必须重新按 anchor 归位，不能只修 fallback divider。
  return insertGoalVerificationTimelineMessages(
    messages.filter((message) => message.syntheticTimeline?.type !== "goal_verification"),
    timelineMessages,
  );
}

// [事务] 插到 anchor 之后并跳过紧随其后的分割线：同一 assistant turn 可能有多轮校验，
// 保持它们的相对顺序，不能插到中间把已有顺序打乱。
function goalVerificationAnchorInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  anchorIndex: number,
): number {
  let index = anchorIndex + 1;
  while (
    index < messages.length &&
    messages[index]?.syntheticTimeline?.type === "goal_verification"
  ) {
    index += 1;
  }
  return index;
}

// [事务] 找第一条时间更大的消息之前插入，保证整体仍按时间单调；
// [失败路径] 找不到（比所有消息都新）时追加到末尾，而不是返回 -1 让 splice 从尾部插入。
function timestampInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  timestamp: number,
): number {
  const index = messages.findIndex((message) => message.timestamp > timestamp);
  return index >= 0 ? index : messages.length;
}

// [事务] 同时匹配 id 与 mergedMessageIds：连续 assistant 合并后原 id 会消失，
// 只查 id 会让 anchor 永远找不到，分割线全部退化到时间戳插入（INV-12 的兜底路径）。
function findPersistedMessageIndexById(
  messages: readonly ZCodePersistedMessage[],
  messageId: string,
): number {
  return messages.findIndex(
    (message) => message.id === messageId || message.mergedMessageIds?.includes(messageId) === true,
  );
}

// [事务] todo → plan step 的下标 id 只在本文件内稳定（INV-18）：
// 用内容做 id 会在文本编辑后让 React 重新挂载整个列表。
// [失败路径] 空列表返回 null 而不是 []：旧 UI 用 null 表示「没有 todo 面板」，[] 会渲染一个空框。
function sessionTodosToPlanSteps(
  todos: ZCodeSessionStateSnapshot["todos"],
): ZCodePlanStep[] | null {
  if (!todos || todos.length === 0) {
    return null;
  }
  // [事务] id 由下标派生（INV-18）：同一份 todo 在每次快照里得到相同 key，
  // 用内容做 key 会让文本编辑后整个列表重挂载并丢失展开状态。
  return todos.map((todo, index) => ({
    id: `todo-${index}`,
    status: todo.status,
    title: todo.content,
  }));
}

// [事务] 浅拷贝一份：runtime 对象会被 UI 层持有，直接引用 snapshot 内部对象会让后续快照复用时出现别名写入。
function sessionGoalStatsToRuntime(
  stats: ZCodeSessionStateSnapshot["goalStats"],
): ZCodeTaskGoalStats | null {
  return stats ? { ...stats } : null;
}

// [事务] 分组内的 todo 也重新分配 id（group.id + 下标），保证跨分组同内容 todo 不会撞 key。
// [权衡] 可选字段用条件展开（INV-37）：显式 undefined 会覆盖 UI 侧的默认值。
function sessionTodoGroupsToRuntime(
  groups: ZCodeSessionStateSnapshot["todoGroups"],
): ZCodeTodoGroup[] | null {
  if (!groups || groups.length === 0) {
    return null;
  }
  // [事务] 分组字段整体透传，只有 todos 重新编号：分组语义由 agent 写入，
  // UI 改写会与 CLI 侧的分组键不一致。
  return groups.map((group) => ({
    id: group.id,
    source: group.source,
    ...(group.goalIteration ? { goalIteration: group.goalIteration } : {}),
    ...(group.targetId ? { targetId: group.targetId } : {}),
    ...(group.startedAt ? { startedAt: group.startedAt } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
    todos: group.todos.map((todo, index) => ({
      id: `${group.id}-todo-${index}`,
      status: todo.status,
      title: todo.content,
    })),
  }));
}

// [事务] task meta 是「侧栏一行」的全部信息：标题、状态、模式、模型、最近错误与目标。
// 它同时是下一次冷恢复的 hint，因此每个字段都必须来自持久事实而非 UI 推断（INV-22）。
// [失败路径] lastError 逐字段条件展开：历史错误可能只有 message，缺 code 时不能写 undefined 覆盖。
export function zcodeSessionSnapshotToTaskMeta(snapshot: ZCodeSessionStateSnapshot): ZCodeTaskMeta {
  // [事务] 这里的 traceId 只为满足类型：task meta 不承载事件归属，
  // 真正的轮次 trace 由 event 通道按 inputId 决定（INV-03）。
  return {
    taskId: snapshot.session.sessionId,
    traceId: generateTraceId(snapshot.session.sessionId),
    // [事务] 标题统一从 deriveTitleFromSnapshot 取（INV-47）：
    // 任何直接读 snapshot.title 的地方都会绕过空标题回退。
    title: deriveTitleFromSnapshot(snapshot),
    workspacePath: snapshot.session.workspace.workspacePath,
    workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    // [事务] 模式走只读收敛（旧名 yolo/bypass 合并为 yolo），只用于展示，不在这里回写 settings。
    mode: fromZCodeMode(snapshot.session.mode),
    // [事务] 模型同样走统一编码（INV-21）：task meta 会被回填进 store 并再次参与选择器匹配。
    model: formatModelPickerValue(resolveTaskMetaModelSelectionFromSnapshot(snapshot)),
    // [事务] 透传原始 current 而不是三级回退值：meta 是持久 hint，
    // 补默认值会让下次冷恢复误以为用户显式选过档位。
    thoughtLevel: snapshot.settings.thoughtLevel.current,
    // [事务] provider 是常量：task meta 属于 ZCode agent 空间，
    // 从快照读取只会引入一个永远相同的可变字段。
    provider: ZCODE_AGENT_PROVIDER,
    // [事务] 任务状态由 shared 计算（INV-02）：UI 侧不重算，否则「运行中/等待回答」的判定会与 CLI 漂移。
    // [失败路径] 该函数内部已处理缺失字段，返回稳定的联合值。
    status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
    // [事务] 错误归属（attribution）只有存在时才带上（INV-31 的上游）：
    // 它是判别式联合，塞 undefined 会让下游的类型收窄失效。
    lastError: snapshot.projection.lastError
      ? {
          code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
    // [事务] target 的 null 要原样保留：转成 undefined 会让 UI 无法区分
    // 「确实没有目标」与「这条快照没带目标字段」（INV-37 的存在性语义）。
    target: snapshot.projection.target
      ? fromZCodeGoal(snapshot.projection.target)
      : snapshot.projection.target,
  };
}

/**
 * session event → 旧 stream event（运行中增量）。
 *
 * 与 snapshot 映射共用同一套投影状态（ZCodeSessionEventProjectionState）：
 *   - activePromptInputIdBySession 把事件归属到正确的输入；
 *   - streamedTurnKeys 防止同一 turn 的重复流式片段；
 *   - backgroundTaskControlsBySession 合并后台任务控制项。
 * 这里只转换已发布的事件，不重新决定业务状态。
 */
// 运行期的唯一事件翻译入口（INV-01/03）：V4 session event → 旧 ChatView 的 stream events。
// [事务] 先确定 traceId/inputId，再按 event 类型分派；所有分支都必须返回数组（可为空），
// 不允许返回 undefined，否则调用方的 push(...events) 会抛错。
// [并发] 这里会读写调用方传入的 state（活动 inputId、工具记忆、轮次标记），
// 因此同一会话的事件必须串行进入；并行调用会让 state 内的 Map 互相覆盖。
// [失败路径] 未知事件类型静默返回空数组而不是抛错：协议向前兼容优先于严格校验。
// 但已知类型里的字段缺失必须降级（asRecord + 默认值），不能让一条坏事件中断整条流。
export function zcodeSessionEventToZCodeStreamEvents(params: {
  event: ZCodeSessionEvent;
  projectionMode?: ZCodeSessionProjectionMode;
  state?: ZCodeSessionEventProjectionState;
  taskId: string;
}): ZCodeStreamEvent[] {
  const { event, state, taskId, projectionMode = "active-live" } = params;
  // [失败路径] 事件本身没有 traceId 时现场生成一个：宁可让这一次事件的归属不可追溯，
  // 也不能返回 undefined 让下游的 traceId 类型约束失效。
  const protocolTraceId = event.traceId ?? generateTraceId(taskId);
  // [事务] 所有分派分支都只读这个归一化对象（INV-36）：
  // 任何直接访问 event.payload.x 的写法，在畸形事件上都会抛 TypeError 并中断整条流。
  const payload = asRecord(event.payload);
  // [事务] inputId 由 CLI 在用户提交时生成并贯穿整轮；它是唯一能跨窗口、跨重连保持稳定的轮次键。
  const inputId = stringValue(payload.inputId);
  // [事务] queryId 只在 steer 场景使用（标记被插队的那次查询），其余事件可缺省。
  const queryId = stringValue(payload.queryId);
  const activePromptInputId = getActivePromptInputId(state, event.sessionId);
  // [资源] 工具记忆按会话惰性创建（INV-39）：state 缺省时这里是 undefined，
  // 因此下面每一处写入都用可选链，保证无状态调用也能完成投影。
  const toolProjectionMemory = ensureProjectionToolMemory(state);
  const toolNameById = toolProjectionMemory?.toolNameById;
  // 修复原因：UI 消费的 traceId 表示一次用户输入到本轮回复结束的轮次标识。
  // runtime trace 只在没有 inputId 时兜底，保证同一轮 chunk、工具调用和 complete 归到同一组。
  // [事务] 事件没带 inputId 时用「当前活动轮次」补齐（INV-03/04）。
  // 这是运行期最关键的一行：缺了它，同一轮的 chunk 会被拆进不同的 trace，
  // UI 上表现为一个回答被拆成多个气泡，且工具归属错乱。
  // [失败路径] 两者都缺失时才退到 protocolTraceId，此时这一轮无法与用户输入关联。
  const eventInputId = inputId ?? activePromptInputId;
  const traceId = eventInputId ?? protocolTraceId;
  // [事务] turnKey 用于标记「本轮是否流过正文 / 是否是 rewind 控制轮」，
  // 因此在没有 turnId 时必须退到 inputId，而不是抛错。
  // [权衡] 用拼接字符串而不是嵌套 Map：只有 set/has/delete 三种操作，扁平结构更省内存。
  const turnKey = `${event.sessionId}:${event.turnId ?? eventInputId ?? traceId}`;

  // [事务] turn.started 是唯一允许「重置本轮记忆」的位置（INV-26）：先清 streamed 标记，
  // 记录可能的 rewind 控制轮，再更新活动 inputId，最后产出 run_started。
  // [失败路径] 顺序反了会让重试的同一 turn 被误判为已流过正文，最终回复不再补写。
  if (event.type === "turn.started") {
    state?.streamedTurnKeys?.delete(turnKey);
    rememberRewindControlTurn(state, turnKey, stringValue(payload.input));
    // [事务] 只有事件真的带了 inputId 才覆盖（INV-04）：
    // 用缺省值覆盖会让下一轮的无 inputId 事件继承一个错误的轮次键。
    if (inputId) {
      setActivePromptInputId(state, event.sessionId, inputId);
    }
    // [事务] run_started 必须最先返回：UI 用它建立本轮容器，
    // 之后的所有增量都挂在它下面（INV-32 的前置条件）。
    const runStartedEvent: ZCodeStreamEvent = {
      type: "task_run_started",
      taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      startedAt: event.timestamp,
    };
    // [事务] 后台任务通知伪装成一次「工具更新」并紧跟 run_started 返回（INV-32）：
    // 单独下发会让 UI 在还没有消息容器时插入一个工具块。
    const taskNotificationToolUpdate = backgroundTaskNotificationToolUpdateFromInput({
      input: stringValue(payload.input),
      taskId,
      traceId,
      inputId: eventInputId,
    });
    if (taskNotificationToolUpdate) {
      return [runStartedEvent, taskNotificationToolUpdate];
    }
    // [事务] goal 续跑是 model-only 输入（INV-33）：只产生 goal_iteration_started，
    // 不产生用户消息，否则用户会看到自己从未输入的内部提示词。
    // [权衡] 仍然返回 run_started：这一轮确实启动了，UI 需要据此展示运行态。
    // [失败路径] targetId 可选展开：无目标时只记录轮次开始，不影响后续归属。
    if (
      stringValue(payload.inputSource) === "goal-continuation" &&
      stringValue(payload.inputVisibility) === "model-only"
    ) {
      return [
        runStartedEvent,
        {
          type: "goal_iteration_started",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(stringValue(payload.targetId) ? { targetId: stringValue(payload.targetId) } : {}),
          startedAt: event.timestamp,
        },
      ];
    }
    return [runStartedEvent];
  }

  // [事务] 三类 timeline 的判定顺序固定为 compact → synthetic part → goal verification：
  // 它们共用同一批 payload 字段，顺序决定哪一条优先被识别。
  // [并发] 命中 timeline 时也置位 streamedTurnKeys：压缩轮不应该在 turn.completed 时补写正文。
  // [失败路径] 都不命中才继续走模型流与 switch 分支。
  const compactTimeline = mapCompactTimelinePayload(taskId, traceId, eventInputId, payload);
  // [事务] 压缩分割线是「整轮的唯一产物」：命中即返回，不再产出任何消息内容。
  if (compactTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [compactTimeline];
  }

  const partTimeline = mapSyntheticTimelinePartPayload(taskId, traceId, eventInputId, payload);
  // [权衡] 历史合成 timeline 与压缩 timeline 互斥：同一条事件不会同时表达两种语义。
  if (partTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [partTimeline];
  }

  const goalVerificationTimeline = mapGoalVerificationTimelinePayload(
    taskId,
    traceId,
    eventInputId,
    event.timestamp,
    payload,
  );
  // [事务] 校验分割线同样独占本轮：它代表 verifier 的动作，而不是模型的正文输出。
  if (goalVerificationTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [goalVerificationTimeline];
  }

  const modelStreaming = mapModelStreaming(
    taskId,
    traceId,
    eventInputId,
    payload,
    toolProjectionMemory,
    projectionMode,
  );
  const apiRetryClearEvent = takeProjectionApiRetryClearOnModelProgress(
    state,
    event.sessionId,
    taskId,
    traceId,
    eventInputId,
    payload,
  );
  // [事务] 模型增量与 apiRetry 清除必须一起返回（INV-29）：
  // 先撤销重试条、再显示新内容，UI 上才不会出现「重试中」与正文并存的闪烁。
  // [并发] 只有正文 chunk 才置位 streamed 标记：思考增量不代表正文已经开始。
  if (modelStreaming) {
    if (modelStreaming.type === "agent_message_chunk") {
      state?.streamedTurnKeys?.add(turnKey);
    }
    return apiRetryClearEvent ? [apiRetryClearEvent, modelStreaming] : [modelStreaming];
  }
  // [事务] 本轮只有清除事件时也要返回：模型可能只是恢复心跳而没有新内容。
  if (apiRetryClearEvent) {
    return [apiRetryClearEvent];
  }

  switch (event.type) {
    // [事务] 工具更新统一交给 mapToolUpdated 处理三态（input/result/error），此处不预处理。
    case "tool.updated":
      return mapToolUpdated(taskId, traceId, eventInputId, payload, toolProjectionMemory);
    // [事务] 权限请求先登记 toolName 记忆：后续 permission.resolved 只带 toolCallId，
    // 需要靠这张表还原是哪个工具，才能决定展示成「允许/拒绝」还是「已回答」。
    // [失败路径] user-input 类工具在这里返回空数组（INV-09）：它们的卡片来自 elicitation 通道。
    case "permission.requested":
      if (stringValue(payload.toolCallId) && stringValue(payload.toolName)) {
        toolNameById?.set(
          stringValue(payload.toolCallId) ?? "",
          stringValue(payload.toolName) ?? "",
        );
      }
      if (isUserInputBackedPermissionToolName(stringValue(payload.toolName))) {
        // 修复原因：AskUserQuestion/ExitPlanMode 的 permission.requested 只是 runtime 等待态；
        // 真正的问题会从 interaction/requestUserInput 映射成 elicitation_request。
        return [];
      }
      return [permissionPayloadToStreamEvent(taskId, traceId, eventInputId, payload)];
    // [事务] 解决事件需要 toolName 记忆来判断「这次解决对应哪张卡片」，
    // 因此 resolve 分支必须晚于 requested 分支处理（协议保证了顺序）。
    case "permission.resolved":
      return permissionResolvedPayloadToStreamEvents(
        taskId,
        traceId,
        eventInputId,
        payload,
        toolNameById,
      );
    // [事务] steer 入队必须原样带出 source（INV：审批反馈与手动 steer 的展示不同）：
    // desktop continuous 的原始事件不经过 service adapter，漏传会全部退化成「手动」。
    // [失败路径] pendingInputId 缺失时退到 eventId：没有它，出队时就无法与入队配对。
    // [权衡] content 允许为空串：某些控制类 steer 只有命令 kind，没有文本。
    case "turn.steerQueued": {
      // 修复原因：desktop continuous 的 raw session event 不经过 service adapter；
      // 这里漏传 source 会把 ExitPlanMode 审批反馈误投影成普通手动 steer。
      const source = turnSteerSourceValue(payload.source);
      return [
        {
          type: "turn_steer_queued",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(queryId ? { queryId } : {}),
          pendingInputId: stringValue(payload.pendingInputId) ?? event.eventId,
          messageId: eventInputId,
          ...(turnSteerCommandKindValue(payload.commandKind)
            ? { commandKind: turnSteerCommandKindValue(payload.commandKind) }
            : {}),
          ...(source ? { source } : {}),
          targetTurnId: stringValue(payload.targetTurnId),
          content: stringValue(payload.input) ?? "",
          raw: payload,
        },
      ];
    }
    // [事务] 出队事件必须带回三组 id（pending/injected/target），少一组都会让 UI 的
    // 「已插队」标记残留或提前消失。
    // [失败路径] queryIds 为空时不带该字段（INV-37），避免覆盖上一批有效值。
    case "turn.steerDrained": {
      return [
        {
          type: "turn_steer_status",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(stringArray(payload.queryIds).length > 0
            ? { queryIds: stringArray(payload.queryIds) }
            : {}),
          status: "drained",
          pendingInputIds: stringArray(payload.pendingInputIds),
          injectedMessageIds: stringArray(payload.injectedMessageIds),
          targetTurnId: stringValue(payload.targetTurnId),
          raw: payload,
        },
      ];
    }
    // [事务] 完成事件是「收口点」：补写正文（条件性）→ 发 task_complete → 清理全部本轮记忆。
    // 清理顺序不能提前，否则补写逻辑读不到 streamed 标记，会重复输出整段回复。
    // [失败路径] 即使没有 response，也必须发 task_complete，否则 UI 永远停在运行中。
    // [资源] 四处 clear/delete（tool input、rewind、streamed、apiRetry、inputId）缺一不可（INV-04/06/49）。
    case "turn.completed": {
      const events: ZCodeStreamEvent[] = [];
      const response = stringValue(payload.response);
      const isRewindControlTurn = state?.rewindControlTurnKeys?.has(turnKey) ?? false;
      // [事务] 补写正文的三重条件（INV-05/27）：有最终文本、不是 rewind 控制轮、本轮没流过正文。
      // 任一条件去掉都会出问题：无条件补写会重复整段回复，忽略 rewind 会显示内部回执，
      // 忽略 streamed 会在已流式输出后再追加一份完整文本。
      if (response && !isRewindControlTurn && !state?.streamedTurnKeys?.has(turnKey)) {
        events.push({
          type: "agent_message_chunk",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          content: response,
        });
      }
      events.push({
        type: "task_complete",
        taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        stopReason: stringValue(payload.resultType) ?? "complete",
        usage: usageFromPayload(payload.usage),
      });
      state?.streamingToolInputById?.clear();
      state?.rewindControlTurnKeys?.delete(turnKey);
      state?.streamedTurnKeys?.delete(turnKey);
      clearProjectionApiRetryState(state, event.sessionId);
      if (eventInputId) {
        clearActivePromptInputId(state, event.sessionId, eventInputId);
      }
      return events;
    }
    // [事务] 失败事件同样要先清理记忆，再决定投影成 compaction 失败还是 task_error（INV-30）。
    // [失败路径] 清理放在分支末尾会让异常路径跳过清理，本轮状态被下一轮继承。
    // [权衡] 错误文案做空值兜底：一条没有 message 的失败事件在 UI 上会渲染成空错误卡片。
    case "turn.failed": {
      state?.streamingToolInputById?.clear();
      state?.rewindControlTurnKeys?.delete(turnKey);
      state?.streamedTurnKeys?.delete(turnKey);
      clearProjectionApiRetryState(state, event.sessionId);
      if (eventInputId) {
        clearActivePromptInputId(state, event.sessionId, eventInputId);
      }
      const errorPayload = asRecord(payload.error);
      if (stringValue(payload.turnPhase) === "compact") {
        return [
          compactFailureToTimelineEvent(
            taskId,
            traceId,
            eventInputId,
            stringValue(errorPayload.message) ?? "ZCode compact failed",
          ),
        ];
      }
      // 修复原因：旧 turn.failed → task_error 投影只保留文案/code/detail，live telemetry
      // 无法看到 adapter 已确认的 provider/network 事实；校验后透传安全归因字段。
      const attribution = errorAttributionSchema.safeParse(errorPayload.attribution);
      return [
        {
          type: "task_error",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          error: stringValue(errorPayload.message) ?? "ZCode session failed",
          code: stringValue(errorPayload.code) ?? stringValue(errorPayload.type),
          detail: stringValue(errorPayload.detail),
          ...(attribution.success ? { attribution: attribution.data } : {}),
        },
      ];
    }
    // [事务] 空标题不投影（INV-34）：否则一次「清空标题」的更新会把已有标题覆盖掉。
    case "session.titleUpdated": {
      const title = stringValue(payload.title);
      return title
        ? [
            {
              type: "session_info_update",
              taskId,
              traceId,
              ...(eventInputId ? { inputId: eventInputId } : {}),
              title,
            },
          ]
        : [];
    }
    // [事务] session.updated 与 streamRecovery.updated 共用一个映射函数（INV-35），
    // 保证两条来源产出的 usage/retry/mode 完全一致。
    case "session.updated":
      return trackProjectionApiRetryEvents(
        state,
        event.sessionId,
        mapSessionInfoLikePayload(taskId, traceId, eventInputId, event.eventId, payload, state),
      );
    // [事务] 断流恢复的进度必须先于后续 model_request_started 生效：
    // 只依赖后者会让部分会话的输入栏重试次数一直不显示。
    case "streamRecovery.updated":
      // 修复原因：SSE 断流恢复的权威进度先通过 streamRecovery.updated 到达。
      // 只依赖后续 model_request_started 会让部分会话看不到输入栏重试次数。
      return trackProjectionApiRetryEvents(
        state,
        event.sessionId,
        mapSessionInfoLikePayload(taskId, traceId, eventInputId, event.eventId, payload, state),
      );
    default:
      return [];
  }
}

// [资源] 惰性初始化工具记忆容器（INV-39）：state 由调用方持有，本函数只补齐缺失的子表。
// [失败路径] state 为 undefined 时返回一个临时对象而不是抛错，保证无状态调用也能投影。
function ensureProjectionToolMemory(
  state: ZCodeSessionEventProjectionState | undefined,
): ZCodeToolProjectionMemory | undefined {
  if (!state) {
    return undefined;
  }
  // 修复原因：前台 useTaskStreamEvents 曾漏初始化这个 Map，导致 Write 输入 delta
  // 每次都从空字符串重新解析，界面只能看到首段和最终完整 tool_call，无法实时递增行数。
  return ensureZCodeToolProjectionMemory(state);
}

// [事务] apiRetry 的清除需要「按会话」记录，而 state 里只有一张扁平 Map，
// 因此用 sessionId 单独维护集合，保证一个会话的重试状态不会清掉另一个会话的。
function ensureProjectionApiRetrySessionIds(
  state: ZCodeSessionEventProjectionState | undefined,
): Set<string> | undefined {
  if (!state) {
    return undefined;
  }
  state.activeApiRetrySessionIds ??= new Set<string>();
  return state.activeApiRetrySessionIds;
}

// [事务] 记录本轮产生的 apiRetry 事件，供「模型已经继续输出」时反向撤销（INV-28）。
// [资源] 只保留最后一次重试：早期重试的 UI 条已被同一条 session_info_update 覆盖，
// 全部保留会让撤销时发出一条已经过期的清除事件。
// [失败路径] 没有 apiRetry 事件时立即从集合中移除会话，避免空集合长期占位。
function trackProjectionApiRetryEvents(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  events: ZCodeStreamEvent[],
): ZCodeStreamEvent[] {
  const apiRetrySessionIds = ensureProjectionApiRetrySessionIds(state);
  if (!apiRetrySessionIds) {
    return events;
  }
  for (const event of events) {
    if (event.type === "session_info_update" && event.apiRetry !== undefined) {
      if (event.apiRetry) {
        apiRetrySessionIds.add(sessionId);
      } else {
        apiRetrySessionIds.delete(sessionId);
      }
    }
  }
  return events;
}

// [事务] 清除分两步：发一条 apiRetry:null 的 session_info_update（让 UI 收起重试条），
// 再从集合里删掉该会话（让后续 chunk 不重复发清除）。
// [失败路径] 顺序反了会导致第二次 chunk 看不到记录，重试条可能残留。
function clearProjectionApiRetryState(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
): void {
  // [资源] 清除只删集合项，不发事件：调用方（clearProjectionApiRetryState）负责产出 apiRetry:null。
  // 这样「更新 UI」与「更新内存」可以分别被测试。
  state?.activeApiRetrySessionIds?.delete(sessionId);
}

// [事务] 「模型有进展」是重试成功的唯一可靠信号：收到正文/思考/工具事件时必须撤销重试条（INV-28）。
// [并发] take 语义（取出即删）保证一次重试只会被清除一次，多个并发 chunk 不会产生多条清除事件。
// [失败路径] 记录不存在时返回空数组，调用方可以无条件展开。
function takeProjectionApiRetryClearOnModelProgress(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "session_info_update" }> | null {
  // [事务] 两个条件缺一不可：会话必须处于重试中，且当前事件必须是「真正的模型进展」。
  // [失败路径] request_started 只代表开始重试，不算进展（否则输入栏会闪一下）。
  // 这条判定是 INV-28 的核心，放宽会让重试条在重试刚开始时就被错误收起。
  if (
    !state?.activeApiRetrySessionIds?.has(sessionId) ||
    !isZCodeModelRetryRecoveryProgressPayload(payload)
  ) {
    return null;
  }
  // 修复原因：普通 adapter retry 的 request_started 只是开始重试，立即清理会让输入栏闪烁；
  // 等到 retry attempt 真正产出模型内容时再清理，才表示用户可见的连接已经恢复。
  // [并发] 先删再返回事件：即使调用方丢弃了返回值，内存状态也已正确；
  // 反过来会让重试条在下次 chunk 时被重复清除。
  state.activeApiRetrySessionIds.delete(sessionId);
  return {
    type: "session_info_update",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    apiRetry: null,
  };
}

// state.updated 的投影入口：它承载的是「会话级状态」而不是消息增量，
// 因此产物多为 session_info_update / usage_update 这类全局事件。
// [事务] 这里不推进任何消息内容，只更新元信息；消息正文一律走 message.* 事件。
// [失败路径] payload 缺字段时逐项条件展开（INV-37），避免 undefined 覆盖 UI 已有值。
export function zcodeStateUpdatedToZCodeStreamEvents(params: {
  notification: ZCodeStateUpdatedNotification;
  settings: ZCodeSessionSettingsState;
  taskId: string;
}): ZCodeStreamEvent[] {
  // [事务] state.updated 是「无消息增量」的全局广播：一次通知同时产出模式、模型状态两类事件，
  // 两者共用一个 traceId，保证 UI 把它们视为同一批更新。
  // [失败路径] 现场生成 traceId（而不是复用上一条消息的）：这批事件不属于任何用户轮次。
  const traceId = generateTraceId(params.taskId);
  return [
    {
      type: "mode_update",
      taskId: params.taskId,
      traceId,
      // [事务] 当前模式必须归一（INV-23 的同源约束）：settings 可能保留旧模式名，
      // 直接下发会让模式菜单没有选中项。
      currentModeId: normalizeAvailableZCodeMode(params.settings.mode.current),
      availableModes: getZCodeAgentAvailableModes(),
    },
    {
      type: "glm_agent_model_state_update",
      taskId: params.taskId,
      traceId,
      version: 1,
      sessionId: params.taskId,
      // [事务] 事件 reason 只允许三种值（thought_level_changed / model_changed / session_initialized）：
      // 其余一律降级为初始化。UI 用它决定是否重置选择器的本地草稿；
      // 未知 reason 若原样透传，会让 UI 的分支落到 default 并丢弃这次更新。
      // [权衡] 这里不读 notification 的其它字段：reason 是唯一被消费的语义。
      reason:
        params.notification.reason === "thought_level_changed"
          ? "thought_level_changed"
          : params.notification.reason === "model_changed"
            ? "model_changed"
            : "session_initialized",
      model: {
        currentValue: formatModelPickerValue(params.settings.model.current),
      },
      thoughtLevel: {
        enabled: params.settings.thoughtLevel.enabled,
        // [事务] 档位当前值同样必须非空（INV-23）：模型切换后旧档位失效时回退到 default/首项。
        currentValue: resolveSettingsThoughtLevelCurrentValue(params.settings.thoughtLevel),
        options: params.settings.thoughtLevel.available.map((option) => ({
          value: option.value,
          name: option.label,
        })),
      },
      // [事务] contextWindow 必须按「当前模型」从 available 里查：直接取 settings 上的值
      // 会在模型切换后短暂显示上一个模型的窗口大小。
      // [失败路径] 查不到时给 0，UI 会隐藏比例而不是显示一个错误的分母。
      contextWindow: {
        tokens:
          // [事务] 上下文窗口按「编码后的模型值」匹配，而不是对象引用（INV-21）：
          // settings 每次更新都会重建对象，引用比较永远不相等，窗口值会退化为 0。
          // [失败路径] 找不到时给 0，UI 据此不显示容量提示，而不是显示一个错误的分母。
          params.settings.model.available.find(
            (option) =>
              formatModelPickerValue(option.ref) ===
              formatModelPickerValue(params.settings.model.current),
          )?.contextWindow ?? 0,
      },
    },
  ];
}

// [事务] 权限请求是「阻塞式」事件：UI 必须弹出可回答的卡片，否则 CLI 会一直等。
// [失败路径] user-input 类工具（AskUserQuestion/ExitPlanMode）在这里返回 null（INV-09），
// 由 elicitation 通道负责；两处都发会让用户面对两张必须回答的卡片。
export function zcodePermissionRequestToZCodeStreamEvent(
  taskId: string,
  request: ZCodePermissionRequestParams,
): ZCodeStreamEvent {
  return {
    type: "permission_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    // [事务] 权限卡描述优先用模型给出的 reason：它是唯一能解释「为什么要这个权限」的文本；
    // 缺失时退回工具名，保证卡片始终有标题。
    description: request.reason || request.toolName,
    kind: request.toolName,
    title: request.toolName,
    options: request.options,
    ...(request.origin ? { origin: request.origin } : {}),
    raw: request,
  };
}

// [事务] 这是真正面向用户的问答请求：必须带 messageId/toolCallId（INV-42），
// 回答时才能被 CLI 精确配对。
// [失败路径] 缺 messageId 时返回 null 而不是自造 id：错配比不显示更糟，
// 用户回答后 CLI 仍卡在等待，且无法从 UI 看出原因。
export function zcodeUserInputRequestToZCodeStreamEvent(
  taskId: string,
  request: ZCodeUserInputRequestParams,
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> {
  // [事务] 问答请求的 options 需要逐层拷贝（INV-42）：上游对象可能被复用或后续修改，
  // 直接透传引用会让已展示的卡片内容在下一轮事件后变化。
  // [失败路径] questions 缺失时得到空数组，后续用 prompt 兜底成单问题。
  const questions =
    request.questions?.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    })) ?? [];
  const firstQuestion = questions[0];
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    // [事务] 旧 UI 的 elicitation 只支持一个问题，因此取 questions[0] 作为主问题，
    // 同时把完整的 questions 一并下发，供新 UI 渲染多问题卡片（两个字段并存是兼容层）。
    // [事务] 消息文本三级回退：结构化问题 → CLI 的 prompt → 固定占位。
    // [失败路径] 绝不返回空串：空标题的问答卡片无法让用户判断要回答什么。
    message: firstQuestion?.question ?? request.prompt ?? "Input required",
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    // [事务] 只在为 true 时下发（INV-37）：显式 false 会覆盖 UI 的默认多选策略。
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    // [事务] schema 与 input 是同一个契约的两种来源（新版/旧版协议），原样保留给需要结构化表单的前端。
    schema: request.schema ?? request.input,
  };
}

// [事务] 回答事件是「解除阻塞」的唯一凭证：即使 UI 已经不显示卡片，也要转发，
// 否则 CLI 侧会一直持有 pending。
// [失败路径] 回答内容为空时仍然转发：空答案本身是有效语义（用户跳过）。
export function zcodeUserInputResponseToZCodeStreamEvent(
  taskId: string,
  response: {
    requestId: string;
    action: ZCodeUserInputResponse["action"];
    content?: Record<string, unknown>;
  },
): Extract<ZCodeStreamEvent, { type: "elicitation_response" }> {
  return {
    type: "elicitation_response",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: response.requestId,
    action: response.action,
    ...(response.content ? { content: response.content } : {}),
  };
}

// [事务] 后台任务通知需要「先建工具气泡、再更新状态」，因此这里构造一个合成的 tool_update（INV-32）。
// [权衡] 只有父任务上下文存在时才合成：没有 turn.started 时插入工具气泡会让它漂在会话顶部。
function backgroundTaskNotificationToolUpdateFromInput(params: {
  input: string | undefined;
  inputId: InputId | undefined;
  taskId: string;
  traceId: TraceId;
}): Extract<ZCodeStreamEvent, { type: "tool_call_update" }> | null {
  // [失败路径] 通知文本不是 JSON 或结构不符时返回 null：这是从工具参数里「捞」通知，
  // 失败是常态，不能让解析异常冒泡打断事件流。
  const parsed = parseZCodeBackgroundTaskNotificationText(params.input);
  if (!parsed) {
    return null;
  }
  // [事务] 通知状态与工具状态是两套枚举，必须经过共享映射；直接透传会让 UI 收到未知状态并渲染成默认样式。
  const status = zcodeBackgroundTaskNotificationToolUpdateStatus(parsed.notification.status);
  // [事务] 后台任务通知是一次「伪工具更新」：toolId 用通知里的 toolUseId，
  // 让 UI 能把状态挂到已经存在的工具块上，而不是新建一个。
  // [失败路径] 没有 toolUseId 的通知在解析阶段就被丢弃，不会走到这里。
  return {
    type: "tool_call_update",
    taskId: params.taskId,
    traceId: params.traceId,
    ...(params.inputId ? { inputId: params.inputId } : {}),
    // [事务] toolUseId 是通知与工具块之间唯一的关联键；它与 parentToolUseId 不同，不能混用。
    toolId: parsed.toolUseId,
    status,
    // [事务] 优先展示完整 result，缺失才用 summary：summary 是给通知列表用的短文本，
    // 在工具详情里显示会丢失关键输出。
    content: parsed.notification.result ?? parsed.notification.summary,
    // 修复原因：ToolLayout 的既有失败 hover 只读取 toolCall.error；notification
    // 原先只更新 status/raw，导致“执行失败”没有可展示的详情。
    // [事务] 只有失败状态才带 error（历史修复点）：成功通知里的 error 字段可能是上一次残留，
    // 带上会让成功的工具显示红色详情。
    ...(status === "failed" && parsed.notification.error
      ? { error: parsed.notification.error }
      : {}),
    // [事务] raw 只带 toolCallId 与通知本体：不复制整个工具输入，避免把上一次的参数带进这一次更新。
    raw: attachZCodeBackgroundTaskNotificationToRaw(
      { toolCallId: parsed.toolUseId },
      parsed.notification,
    ),
  };
}

// 协议消息 → 持久消息的翻译核心（INV-01）：消息级字段、parts、usage 与 timeline 都在这里定型。
// [事务] parts 的顺序必须原样保留：文本、工具、timeline 的相对位置决定聊天区的渲染顺序，
// 任何重排都会让工具气泡跑到正文前面。
// [失败路径] 未知 part 类型跳过而不是抛错，保证新协议字段不会让历史会话打不开。
// [权衡] 这里不做可见性判断：过滤已在 snapshot 入口完成，重复判断会让两侧结果不一致。
function zcodeMessageToZCodePersistedMessage(
  message: ZCodeMessageWithParts,
  goalIteration?: number,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedMessage {
  // [事务] tools 与 parts 是两份并行结构：parts 用 toolIndex 指向 tools 的下标，
  // 这样 UI 既能按顺序渲染正文与工具，又能按 toolCallId 单独更新某一个工具。
  // [失败路径] 两者必须同时维护，只 push 一边会让工具块在渲染时取到 undefined。
  const tools: ZCodePersistedToolCall[] = [];
  const parts: ZCodePersistedMessagePart[] = [];
  // [资源] 附件只扫描一次并保存在消息级：逐 part 渲染时再算会让每条消息
  // 重复遍历 parts，长会话打开时开销叠加。
  const attachments = mapPromptAttachmentsFromParts(message.parts);
  // [事务] 只有 user 消息需要判定投影策略（timelineOnly / realUserInput）：
  // goal continuation 这类内部输入在历史里只保留时间线语义，不渲染正文。
  // [权衡] 策略来自共享函数而不是本地判断，保证与 CLI 侧的归类一致（INV-02）。
  // [失败路径] assistant 消息固定为 realUserInput，避免把模型输出误判成内部提示而隐藏。
  const projectionPolicy =
    message.info.role === "user"
      ? getConversationMessageProjectionPolicy(message)
      : "realUserInput";
  let syntheticTimeline: ZCodeTimelineMeta | undefined;
  // [事务] 第一遍只找「合成 timeline」，命中即停止覆盖：一条消息最多承载一个 timeline。
  // 判定顺序 text 前缀 → compaction part → timeline part，因为前缀是历史兼容形态，最不可靠。
  // [资源] 这一遍不构建 parts，避免为每一条消息分配两次数组。
  for (const part of message.parts) {
    if (part.type === "text") {
      if (!syntheticTimeline) {
        const fromText = extractSyntheticTimelineFromTextPart(part);
        if (fromText) {
          syntheticTimeline = fromText;
        }
      }
    } else if (part.type === "compaction" && !syntheticTimeline) {
      syntheticTimeline = synthesizeCompactionTimeline(part);
    } else if (part.type === "timeline" && !syntheticTimeline) {
      syntheticTimeline = synthesizeTimelineFromTimelinePart(part);
    }
  }
  // [事务] 第二遍按原顺序构建 parts（INV-01）：text → content、reasoning → thought、tool → tool-call。
  // [权衡] 顺序必须与 message.parts 完全一致，任何重排都会改变聊天区的视觉顺序。
  // [失败路径] timelineOnly 时正文置空但保留 part 位置，保证时间线锚点不丢。
  for (const part of message.parts) {
    if (part.type === "text") {
      if (projectionPolicy !== "timelineOnly") {
        parts.push({ type: "content", content: part.text });
      }
    // [事务] reasoning 在 parts 里必须保留位置（INV-01）：只写消息级 thought
    // 会让折叠区与正文顺序脱节，思考过程固定漂在回答之前。
    } else if (part.type === "reasoning") {
      parts.push({ type: "thought", content: part.text });
    // [事务] 先记录下标再 push，保证 parts 里的 toolIndex 与 tools 数组同步；
    // 反过来的话读到的是 push 之前的长度，所有工具会错位一格。
    } else if (part.type === "tool") {
      const toolIndex = tools.length;
      // [事务] 把后台任务通知索引传给每条工具映射：这是冷恢复时还原「任务已失败」的唯一来源。
      tools.push(mapToolPart(part, backgroundTaskNotifications));
      parts.push({ type: "tool-call", toolIndex });
    }
  }
  return {
    id: message.info.messageId,
    role: message.info.role,
    // [事务] content 是消息级纯文本摘要（用于搜索、复制与标题），必须与 parts 里的正文同源。
    // [失败路径] timelineOnly 时给空串而不是 undefined：UI 用字符串长度做可见性判断。
    content: projectionPolicy === "timelineOnly" ? "" : textFromParts(message.parts),
    // [事务] 时间戳取创建时间而不是完成时间：时间线排序必须按「消息出现」而非「回复结束」，
    // 长回答用完成时间会整体后移，与用户输入的顺序错乱。
    timestamp: message.info.time.created,
    // 未绑定恢复的历史消息可以没有模型来源；展示消息不能依赖可执行选型。
    // [事务] 历史消息的模型来源可能缺失（旧数据/未绑定恢复），因此允许 undefined；
    // 展示层不能依赖它做可执行选型（INV-22 的输入侧）。
    model: message.info.model ? formatModelPickerValue(message.info.model) : undefined,
    ...(syntheticTimeline ? { syntheticTimeline } : {}),
    ...(attachments ? { attachments } : {}),
    // [事务] assistant 专属字段整体条件展开（INV-37）：user 消息上出现 tools/parts 会让
    // UI 误渲染一个空的工具区或重复正文。
    ...(message.info.role === "assistant"
      ? {
          ...(goalIteration ? { goalIteration } : {}),
          // [事务] 只有完成时间存在时才计算耗时；流式中或中断的消息没有 completed，
          // 用 Date.now() 顶替会让耗时随刷新不断增长。
          durationMs: message.info.time.completed
            ? message.info.time.completed - message.info.time.created
            : undefined,
          // [事务] thought 是 assistant 消息级的推理摘要，与 parts 里的 thought 并存：
          // 前者给折叠区用，后者保证顺序渲染，两者必须来自同一份 parts。
          thought: reasoningFromParts(message.parts),
          // [事务] 空数组归一为 undefined：旧 UI 用「有无」判断是否渲染工具容器，空数组会渲染一个空框。
          tools: tools.length > 0 ? tools : undefined,
          // [事务] 同理，空 parts 归一为 undefined，避免出现没有内容的消息气泡。
          parts: parts.length > 0 ? parts : undefined,
        }
      : {}),
  };
}

// [资源] 附件只从 file part 提取：其他 part 携带的路径可能是工具产物，不应显示为用户附件。
// [失败路径] 单个附件解析失败时跳过该条，不能让整条消息因为一个坏 url 丢失。
function mapPromptAttachmentsFromParts(
  parts: readonly ZCodeMessagePart[],
): ZCodePromptAttachment[] | undefined {
  const attachments = parts
    .filter((part): part is Extract<ZCodeMessagePart, { type: "file" }> => part.type === "file")
    .map(mapPromptAttachmentFromFilePart)
    .filter((attachment): attachment is ZCodePromptAttachment => attachment !== undefined);
  // [事务] 空附件归一为 undefined：UI 用「有无」判断是否渲染附件区，空数组会渲染一个空容器。
  return attachments.length > 0 ? attachments : undefined;
}

// [事务] 附件的三种来源必须区分：base64 data url（内联）、本地绝对路径（用户拖入）、文件名兜底。
// [权衡] 判定顺序是 data url → 绝对路径 → 文件名：前者最明确，后者信息最少。
// [失败路径] 全部缺失时返回 null，调用方据此丢弃该附件而不是渲染一个空占位。
function mapPromptAttachmentFromFilePart(
  part: Extract<ZCodeMessagePart, { type: "file" }>,
): ZCodePromptAttachment | undefined {
  // [事务] MIME 兜底为二进制流：后续的 image 分支依赖它做前缀判断，空 MIME 会让所有附件都被当成普通文件。
  // [事务] 附件元数据来自不可信 JSON（INV-36）：统一 asRecord 后再逐字段取值，
  // 直接读 part.metadata.sizeBytes 会在 metadata 为 null 时抛 TypeError。
  const mimeType = part.mime || "application/octet-stream";
  const metadata = asRecord(part.metadata);
  // [事务] 文件名三级回退：显式 filename → 从 url 取末段 → 固定占位。
  // [失败路径] 绝不返回空串：空文件名会让附件行没有可点击文本。
  const filename = part.filename?.trim() || filenameFromPathLike(part.url) || "attachment";
  // [失败路径] 缺失或非法的大小返回 undefined（INV-37），让 UI 不显示大小而不是显示 0 B。
  const sizeBytes = numberValue(metadata.sizeBytes);
  // [事务] 内联图片只保留 base64 本体，不带 data url 前缀：UI 的 <img src> 会自行拼装，
  // 重复前缀会让图片加载失败且难以看出原因。
  const dataBase64 = dataBase64FromDataUrl(part.url);
  // [事务] 本地路径与 base64 可以并存：远端恢复的附件既有本地缓存也有内联数据，
  // 保留两者让 UI 能优先走本地文件、失败再回退数据。
  const localPath = localPathFromAttachmentPart(part.url, metadata);

  // Bugfix: desktop-continuous 历史恢复走 session projection，不经过 legacy task adapter。
  // file part 若不反投影成 attachments，用户发送过的图片/文件会在恢复 UI 里消失。
  // [事务] 图片与普通文件分成两种 kind：UI 对图片走预览、对文件走下载卡片。
  // [失败路径] 判断只看 MIME 而不是扩展名：远端返回的文件名可能被截断。
  // [权衡] 非图片一律按 file 处理，未知类型也能下载，不会因为嗅探失败而丢附件。
  if (mimeType.startsWith("image/")) {
    return {
      kind: "image",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("audio/")) {
    return {
      kind: "audio",
      filename,
      mimeType,
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("video/")) {
    return {
      kind: "video",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf") {
    return {
      kind: "pdf",
      filename,
      mimeType: "application/pdf",
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  const preview = asRecord(metadata.preview);
  const textContent = !localPath ? stringValue(preview.text) : undefined;
  return {
    kind: "file",
    filename,
    mimeType,
    sizeBytes: sizeBytes ?? 0,
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(textContent !== undefined ? { textContent } : {}),
    ...(localPath ? { localPath } : {}),
  };
}

// [事务] 只接受 base64 编码的 data url：text/plain 等非 base64 形式无法被图片组件消费。
// [权衡] 不做 MIME 白名单校验：服务端已限类型，UI 再拦一次只会让合法格式被误拒。
function dataBase64FromDataUrl(value: string): string | undefined {
  const commaIndex = value.indexOf(",");
  if (value.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const headerParts = value.slice("data:".length, commaIndex).split(";");
  if (headerParts.at(-1)?.trim().toLowerCase() !== "base64") return undefined;
  return value.slice(commaIndex + 1) || undefined;
}

// [事务] 优先用 part 上显式声明的本地路径字段，其次才从 url 解析：
// 用户拖入时 url 可能是 file:// 形式，直接展示给 <img> 在渲染进程会被安全策略拦截。
function localPathFromAttachmentPart(
  url: string,
  metadata: Record<string, unknown>,
): string | undefined {
  const originalUrl = stringValue(metadata.originalUrl);
  if (originalUrl && isAbsolutePathLike(originalUrl)) {
    return originalUrl;
  }
  return isAbsolutePathLike(url) ? url : undefined;
}

// [权衡] 同时接受 POSIX 与 Windows 盘符形式：远端 workspace 的路径可能出现在本地 UI 上，
// 只认 / 开头会让 WSL/Windows 混合环境漏判。
function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

// [事务] 先按两种分隔符切分再取末段：Windows 路径在 POSIX 语义下 split("/") 只会得到整串，
// 附件的显示名会变成完整路径。
function filenameFromPathLike(value: string): string | undefined {
  if (value.startsWith("data:")) {
    return undefined;
  }
  const pathPart = value.split(/[?#]/u)[0] ?? "";
  const segments = pathPart.split(/[\\/]/u).filter(Boolean);
  const filename = segments.at(-1)?.trim();
  return filename && !filename.includes("://") ? filename : undefined;
}

// [事务] 旧协议把 timeline 标记写进 text part 的特定前缀里，这里负责把它「剥离出来」成结构化 timeline。
// [失败路径] 前缀不匹配时返回 null，调用方保留原文本：错误的剥离会吞掉用户可见的正文。
// [权衡] 只识别固定前缀，不做通用解析：这是历史兼容层，宽松匹配会把普通文本误判为标记。
function extractSyntheticTimelineFromTextPart(
  part: Extract<ZCodeMessagePart, { type: "text" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = part.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const forkContext = (metadata as Record<string, unknown>)["forkContext"];
  if (!forkContext || typeof forkContext !== "object") return undefined;
  const ctx = forkContext as Record<string, unknown>;
  if (ctx["kind"] !== "session_fork") return undefined;
  const parentSessionId = typeof ctx["parentSessionId"] === "string" ? ctx["parentSessionId"] : "";
  const targetMessageId = typeof ctx["targetMessageId"] === "string" ? ctx["targetMessageId"] : "";
  const targetCheckpointId =
    typeof ctx["targetCheckpointId"] === "string" ? ctx["targetCheckpointId"] : undefined;
  if (!parentSessionId || !targetMessageId) return undefined;
  return {
    version: 1,
    kind: "synthetic",
    type: "session_fork",
    display: "separator",
    parentSessionId,
    targetMessageId,
    ...(targetCheckpointId ? { targetCheckpointId } : {}),
    ...(typeof ctx["restoredFileCount"] === "number"
      ? { restoredFileCount: ctx["restoredFileCount"] }
      : {}),
  };
}

// [事务] timeline part → UI timeline 的定型点：status/trigger/phase 都必须归一为已知联合值，
// 未知值降级为 undefined，而不是原样透传（INV-48 的同构约束）。
// [失败路径] 缺 partId 时返回 null：没有身份的 timeline 无法去重，重放会产生重复分割线。
function synthesizeTimelineFromTimelinePart(
  part: Extract<ZCodeMessagePart, { type: "timeline" }>,
): ZCodeTimelineMeta | undefined {
  if (part.timelineType !== "session_fork") {
    return undefined;
  }
  const parentSessionId = part.parentSessionId;
  const targetMessageId = part.targetMessageId;
  if (!parentSessionId || !targetMessageId) {
    return undefined;
  }
  return {
    version: 1,
    kind: "synthetic",
    type: "session_fork",
    display: "separator",
    parentSessionId,
    targetMessageId,
    ...(part.targetCheckpointId ? { targetCheckpointId: part.targetCheckpointId } : {}),
    ...(typeof part.restoredFileCount === "number"
      ? { restoredFileCount: part.restoredFileCount }
      : {}),
  };
}

// [事务] compaction 是最复杂的 timeline：它跨越多条消息，需要把 phase/trigger/metadata 组合成一条可折叠的分割线。
// [权衡] 摘要文本只取截断后的前若干字符：完整摘要可能上千字，放进 timeline 会让持久层体积翻倍。
// [失败路径] metadata 缺失时仍然生成 timeline，只是不带统计：压缩发生的「事实」比统计更重要。
function synthesizeCompactionTimeline(
  part: Extract<ZCodeMessagePart, { type: "compaction" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = asRecord(part.metadata);
  const operationId = stringValue(metadata.operationId) ?? part.partId;
  const status = timelineStatusValue(metadata.timelineStatus);
  if (!status && !part.summaryMessageId) {
    // 修复原因：compact 成功后 summary user message 也会携带 compaction 元数据，
    // 但它只是模型上下文边界，不是 UI timeline。只有 lifecycle part 才渲染横线。
    return undefined;
  }
  const trigger = timelineTriggerValue(metadata.trigger) ?? (part.auto ? "auto" : "manual");
  const replace = booleanValue(metadata.replace);
  const reason = part.reason ?? stringValue(metadata.reason);
  const boundaryId = stringValue(metadata.boundaryId) ?? part.summaryMessageId;
  const summaryMessageId = part.summaryMessageId ?? stringValue(metadata.summaryMessageId);
  const preCompactTokenCount = numberValue(metadata.preCompactTokenCount);
  const postCompactTokenCount = numberValue(metadata.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(metadata.truePostCompactTokenCount);
  const attempt = numberValue(metadata.attempt);
  const maxAttempts = numberValue(metadata.maxAttempts);
  const phase = compactionPhaseValue(metadata.phase);
  const startedAt = numberValue(metadata.startedAt);
  const endedAt = numberValue(metadata.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status: status ?? "completed",
    trigger,
    display: "separator",
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(phase ? { phase } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

// [事务] 事件侧的 compact timeline 入口：把 payload 的 phase 映射为 timelineStatus，
// 保证运行中的分割线与冷恢复后的分割线呈现一致（INV-01）。
// [失败路径] phase 非法时返回 null，宁可不显示也不能显示一个错误阶段。
function mapCompactTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const timeline = compactTimelineMetaFromPayload(payload, inputId);
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    // Bugfix: compact lifecycle 是结构化状态事件，不是 assistant 正文。
    // 即使上游误带 text，也不能把内部 summary/prompt 投影到聊天区。
    content: "",
    zcodeTimeline: timeline,
  };
}

// [事务] 历史数据里的「合成 timeline」没有真实 part，只能靠 payload 重建；
// 这条路径主要服务旧会话，缺字段时尽量降级而不是丢弃整个 part。
// [权衡] 与阶段 2 的真实 timeline 映射共用同一套归一函数，避免两套枚举解释。
function mapSyntheticTimelinePartPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const part = asRecord(payload.part);
  if (part.type !== "text") {
    return null;
  }
  const timeline = extractSyntheticTimelineFromTextPart(
    part as Extract<ZCodeMessagePart, { type: "text" }>,
  );
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(part.messageId) ?? stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    content: "",
    // Bugfix: fork notice 是 part.upserted 里的结构化 synthetic text，不是模型正文 delta。
    // 这里提前投成 timeline divider，避免 UI 按普通消息渲染后丢掉横线。
    zcodeTimeline: timeline,
  };
}

// [事务] goal verification 事件的 timeline 化：身份键由 targetId+iteration 决定（INV-11），
// 因此这里必须带 targetId 才能生成可去重的 id。
// [失败路径] targetId 缺失时返回 null：没有目标归属的校验分割线无法归轮次。
function mapGoalVerificationTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  timestamp: number,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const targetId = stringValue(payload.targetId);
  const verificationId = stringValue(payload.verificationId);
  const status = goalVerificationTimelineStatusValue(payload.status);
  if (!targetId || !verificationId || !status) {
    return null;
  }
  const verification = goalVerificationFromRecord(asRecord(payload.verification));
  const goalIteration = positiveIntegerValue(payload.goalIteration);
  const anchorAssistantMessageId = stringValue(payload.anchorAssistantMessageId);
  const anchorTurnId = stringValue(payload.anchorTurnId);
  const startedAt =
    numberValue(payload.startedAt) ?? (status === "started" ? timestamp : undefined);
  const timeline: ZCodeGoalVerificationTimelineMeta = {
    version: 1,
    kind: "synthetic",
    type: "goal_verification",
    display: "separator",
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    updatedAt: timestamp,
  };
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    messageId: goalVerificationTimelineMessageId(timeline),
    content: "",
    zcodeTimeline: timeline,
  };
}

// [事务] 压缩统计用的元信息必须逐字段可选：不同 provider 返回的 usage 结构差异很大，
// 要求全量会让部分 provider 的压缩分割线直接消失。
// [权衡] 数值统一走非负整数归一：负数或 NaN 会让 UI 的百分比与进度条失效。
function compactTimelineMetaFromPayload(
  payload: Record<string, unknown>,
  inputId: InputId | undefined,
): ZCodeContextCompactionTimelineMeta | null {
  const operationId = stringValue(payload.operationId);
  const status = timelineStatusValue(payload.status ?? payload.timelineStatus);
  if (!operationId || !status) {
    return null;
  }
  const trigger = timelineTriggerValue(payload.trigger) ?? "manual";
  const replace = booleanValue(payload.replace);
  const reason = stringValue(payload.reason);
  const boundaryId = stringValue(payload.boundaryId);
  const summaryMessageId = stringValue(payload.summaryMessageId);
  const preCompactTokenCount = numberValue(payload.preCompactTokenCount);
  const postCompactTokenCount = numberValue(payload.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(payload.truePostCompactTokenCount);
  const attempt = numberValue(payload.attempt);
  const maxAttempts = numberValue(payload.maxAttempts);
  const phase = compactionPhaseValue(payload.phase);
  const startedAt = numberValue(payload.startedAt);
  const endedAt = numberValue(payload.endedAt);
  const timeline: ZCodeContextCompactionTimelineMeta = {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status,
    trigger,
    display: "separator",
    ...(inputId ? { inputId } : {}),
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(phase ? { phase } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
  return timeline;
}

// [事务] 压缩失败在 UI 上仍然是一条 timeline，而不是 task_error（INV-30）：
// 会话还能继续对话，把整个任务标红会让用户以为会话废了。
// [失败路径] 错误消息做空值兜底，避免出现一条没有原因的红线。
function compactFailureToTimelineEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  reason: string,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> {
  const operationId = `compact-failed-${inputId ?? traceId}`;
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    content: "",
    zcodeTimeline: {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId,
      status: /abort|cancel|interrupt|stop/i.test(reason) ? "interrupted" : "failed",
      trigger: "manual",
      display: "separator",
      ...(inputId ? { inputId } : {}),
      reason,
      endedAt: Date.now(),
    },
  };
}

// [事务] 冷恢复时的工具消息映射：tool part 只有「已发生」的终态，没有流式增量。
// 因此这里必须补齐 status/content/error，保证与运行中 mapToolUpdated 产生的形状一致（INV-01）。
// [失败路径] 未知工具名保留原名而不是降级为 "tool"：历史消息的工具名是唯一可追溯的证据。
// [权衡] 大输入原样保留：冷恢复只发生一次，省略会让「查看参数」功能在历史会话里失效。
function mapToolPart(
  part: Extract<ZCodeMessagePart, { type: "tool" }>,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedToolCall {
  // [事务] part.state 是工具终态的判别式联合（completed/error/其他），
  // 因此后续分支必须先判 status 再读 title/metadata，直接读字段在类型上就不成立。
  const state = part.state;
  // [事务] 用 callId 关联后台任务通知：这是流式事件与冷恢复快照之间唯一的共同身份。
  // [失败路径] 没有通知时返回 undefined，工具按普通完成态展示。
  const taskNotification = backgroundTaskNotifications?.get(part.callId);
  // 修复原因：ZCode Protocol 的 part.callId 是实时流和终态 snapshot 共同的工具身份。
  // 以前只保存 metadata 会丢掉 toolCallId，手机 replayable 里 result-only 临时工具就无法被终态快照覆盖。
  // [事务] raw 需要同时注入 toolCallId 与后台任务通知（INV：手机 replayable 依赖 toolCallId
  // 把 result-only 临时工具与终态快照对齐）；两步注入的顺序不影响结果，但都不能省。
  // [权衡] 注入的是浅拷贝，不修改原 metadata 对象，避免影响同一 part 的其他消费者。
  const raw = attachZCodeBackgroundTaskNotificationToRaw(
    attachToolCallIdToRaw("metadata" in state ? (state.metadata ?? state) : state, part.callId),
    taskNotification,
  );
  // [事务] completed 不是终态的全部：后台 Agent 的 completed 只表示「已派发」，
  // 若匹配到 failed 通知，必须在这里改判为 failed。
  // 注意不能顺带改变 stopped 等既有恢复语义——那是另一条分支的职责。
  if (state.status === "completed") {
    // 修复原因：background Agent 的 completed 只代表 launch ACK；匹配的 failed
    // notification 才能在本次错误修复中覆盖它，不能顺带改变 stopped 等既有恢复语义。
    // [事务] 通知状态需要先经 UI 状态映射，协议里的 running/succeeded 与工具三态不是同一套枚举。
    // [失败路径] 通知缺失时得到 undefined，此时保持 completed，不做额外改判。
    const notificationStatus = taskNotification?.status
      ? zcodeBackgroundTaskNotificationToolUpdateStatus(taskNotification.status)
      : undefined;
    // [事务] 只有明确的 failed 才覆盖终端状态：pending/running 的通知不能把已完成的工具改回进行中，
    // 否则用户会看到一个永远转圈的工具块。
    const notificationFailed = notificationStatus === "failed";
    return {
      toolName: part.tool,
      title: state.title || part.tool,
      kind: part.tool,
      status: notificationFailed ? "failed" : "completed",
      input: state.input,
      output: state.output,
      // [事务] 失败详情只在有 error 文本时附加：UI 的失败 hover 只读 toolCall.error，
      // 没有它就会出现「执行失败」但没有原因的空提示。
      ...(notificationFailed && taskNotification?.error ? { error: taskNotification.error } : {}),
      raw,
    };
  }
  // [事务] 协议层的 error 直接映射为 failed，并保留 error 文本；
  // 不在这里清空 output：某些工具失败时仍有部分输出，用户需要看到它。
  if (state.status === "error") {
    return {
      toolName: part.tool,
      title: part.tool,
      kind: part.tool,
      status: "failed",
      input: state.input,
      error: state.error,
      raw,
    };
  }
  // [事务] 这是「进行中/未知终态」的工具：不能给 status，让 UI 继续显示运行态；
  // 也不能省略 title，否则工具块会显示成无名卡片。
  return {
    toolName: part.tool,
    title: "title" in state && state.title ? state.title : part.tool,
    kind: part.tool,
    input: state.input,
    raw,
  };
}

// [事务] 把 toolCallId 注入 raw，让 UI 能在同一条消息里定位具体的工具块；
// 已存在时不覆盖，避免改写上游字段。
function attachToolCallIdToRaw(raw: unknown, toolCallId: string): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { toolCallId, raw };
  }
  return {
    ...raw,
    toolCallId:
      typeof (raw as Record<string, unknown>).toolCallId === "string"
        ? (raw as Record<string, unknown>).toolCallId
        : toolCallId,
  };
}

// 模型流式事件的核心映射：text / thinking / usage 三类增量共用一条入口。
// [并发] 必须在处理正文之前先取出 apiRetry 清除（INV-29），保证 UI 先撤销重试条再显示新内容。
// [事务] streamedTurnKeys 在收到第一段非空增量时置位（INV-05）：它只表示「本轮流过正文」，
// 绝不能当作完成信号，否则 turn.completed 的补写逻辑会被错误抑制。
// [失败路径] 空增量不置位也不下发：空 chunk 在 UI 上会产生一次无意义的重渲染。
// [权衡] thinking 与 text 分开产出事件：合并会让「显示思考过程」开关失效。
function mapModelStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  projectionMode: ZCodeSessionProjectionMode = "active-live",
): ZCodeStreamEvent | null {
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  // [事务] 子 agent 的增量会带 parentToolUseId：它是把子工具挂到父工具气泡下的唯一线索，
  // 丢失后子 agent 的正文会平铺到主对话里，层级关系消失。
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  // [事务] 正文增量必须带 assistantMessageId（messageId）：UI 用它把同一段回答的多条 chunk
  // 归到同一个气泡；缺失时只能靠 traceId 兜底，长回答可能被拆成多条。
  // [失败路径] 空 delta 直接返回 null（INV-05）：空 chunk 只会触发一次无意义重渲染。
  if (kind === "text_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_message_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      messageId: stringValue(payload.assistantMessageId),
      content: delta,
    };
  }
  // [事务] 思考增量与正文分开产出（INV：显示思考过程开关）：合并会让开关失效。
  // [权衡] 思考内容不携带 messageId，因为它不参与气泡合并。
  if (kind === "reasoning_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_thought_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      content: delta,
    };
  }
  // [事务] 不是文本/思考增量的一律按工具参数处理：协议目前只有这三类流式 kind，
  // 未知 kind 由下游按 toolId 缺失直接丢弃。
  return mapToolInputStreaming(
    taskId,
    traceId,
    inputId,
    payload,
    toolProjectionMemory,
    projectionMode,
  );
}

// 流式工具参数的映射：这是整个文件里性能最敏感的路径（INV-07/08）。
// [权衡] active-live 且低频时才物化 preview；background-summary 与高频场景只累积 tombstone，
// 因为每个 delta 都做 JSON 解析在长参数工具上会产生 O(n²) 开销，直接卡住 renderer。
// [事务] 终态工具调用只保留 deltaCount，丢掉 rawInput（INV-08）：参数已经完整下发过，
// 留着大 JSON 只会让每个后台任务多占几十 KB。
// [失败路径] toolId 缺失时直接返回空数组：没有身份就无法把增量拼到正确的工具块上。
// [并发] toolName 需要从记忆里回填，因为 delta 事件本身不携带工具名。
function mapToolInputStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  projectionMode: ZCodeSessionProjectionMode = "active-live",
): ZCodeStreamEvent | null {
  const streamingToolInputById = toolProjectionMemory?.streamingToolInputById;
  const toolNameById = toolProjectionMemory?.toolNameById;
  const kind = stringValue(payload.kind);
  // [失败路径] toolId 是工具增量的唯一身份，缺失即返回 null（INV-08 的前置）：
  // 没有它无法把 delta 拼到正确的工具块，硬拼会让两个工具的参数互相污染。
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return null;
  }
  // [事务] 工具名需要记忆回填：delta 事件通常不带 toolName，只有 start 带。
  // 回填后立即写回记忆，保证后续 result/error 分支同样能拿到名字。
  // [失败路径] 都没有时展示为 "tool"：宁可显示通用名，也不要让工具块没有标题。
  const toolName = stringValue(payload.toolName) ?? toolNameById?.get(toolId);
  if (toolName) {
    toolNameById?.set(toolId, toolName);
  }
  // [权衡] 兜底标题固定为 "tool"：它同时用作 kind 与 title，
  // 保证旧 UI 的图标映射与文案都有值，不会渲染出空白标题的卡片。
  const title = toolName ?? "tool";
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const buildRaw = (input: unknown, rawInput: string | undefined) =>
    buildStreamingToolInputRaw(payload, input, rawInput);

  // [事务] start 是唯一「清空并重建」工具参数记忆的时机：
  // 同一 toolId 重放时，旧 buffer 必须被空串覆盖，否则会拼出重复 JSON。
  // [权衡] 同时下发一次空 input 的 tool_call，让 UI 立刻出现工具气泡（用户感知到进展）。
  if (kind === "tool_input_start") {
    streamingToolInputById?.set(toolId, { rawInput: "" });
    logStreamingToolInputProjection({
      inputKeys: [],
      kind,
      projectedType: "tool_call",
      rawInputLength: 0,
      taskId,
      toolId,
      toolName,
      traceId,
    });
    return {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: {},
      toolName,
      kind: title,
      title,
      raw: buildRaw({}, undefined),
    };
  }

  // [事务] delta 只累积 buffer，是否物化由 shouldMaterialize 决定（INV-07）：
  // 物化意味着 JSON.parse + 浅拷贝，长参数工具在后台并发时会把主线程打满。
  // [失败路径] 不物化时返回 null，UI 继续显示上一次预览，参数在终态一次性下发。
  if (kind === "tool_input_delta") {
    // [事务] delta 只做累积：state.rawInput 是「未解析的 JSON 文本」，
    // 任何一次提前解析都可能得到不完整的对象并写进消息树。
    const state = appendZCodeStreamingToolInputDelta(
      streamingToolInputById?.get(toolId),
      stringValue(payload.delta) ?? "",
    );
    streamingToolInputById?.set(toolId, state);
    if (
      !shouldMaterializeZCodeStreamingToolInputPreview(state, {
        mode: projectionMode,
        toolName,
      })
    ) {
      // 性能优化：后台任务和高频 active delta 只更新 tombstone buffer。
      // 完整参数会在预算点、tool_input_end、最终 tool_call 或切回 active 后再落到消息树。
      return null;
    }
    const preview = buildZCodeStreamingToolInputPreview(state.rawInput);
    // [权衡] 允许从半成品参数里推断工具名：delta 事件通常不带 toolName，
    // 这是让工具气泡尽早显示正确图标的唯一线索。
    markZCodeStreamingToolInputPreviewMaterialized(state);
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    // [资源] 日志摘要只含 key 名与长度（INV-25/38）：
    // 工具参数可能是用户源码，写进日志就等于把正文带进了诊断包。
    const previewSummary = readStreamingToolInputPreviewLogSummary(
      preview.input,
      state.rawInput.length,
      state.deltaCount,
    );
    logStreamingToolInputProjection({
      ...previewSummary,
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      ...previewSummary,
      kind,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  // [事务] end 只表示「流式参数结束」，不在这里物化完整 input（性能修复点）：
  // 紧随其后的 tool_call 会带权威 input，重复解析同一份大 JSON 会让长参数工具卡顿。
  // [失败路径] buffer 缺失时用空串兜底并照常下发状态更新，保证 loading 态能够收尾。
  if (kind === "tool_input_end") {
    const state = streamingToolInputById?.get(toolId) ?? { rawInput: "" };
    const previewToolName = toolName ?? title;
    const previewTitle = previewToolName ?? title;
    logStreamingToolInputProjection({
      inputKeys: [],
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      force: true,
      kind,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      // 性能修复：tool_input_end 和紧随其后的 tool_call 过去会连续解析同一份大 JSON。
      // end 只表达流式参数结束，完整 input 由最终 tool_call 一次性 materialize。
      raw: buildRaw(undefined, state.rawInput),
    };
  }

  // [事务] tool_call 是工具参数的终态：优先用 payload.input（权威值），
  // 缺失时才回退到流式 buffer，避免把拼接过程产生的半成品当成最终参数。
  // [资源] 终态后立即清空 buffer（INV-08）：参数已经写进消息树，再留着就是纯内存浪费。
  if (kind === "tool_call") {
    const state = streamingToolInputById?.get(toolId);
    const rawInput = state?.rawInput ?? "";
    const hasCompleteInput = "input" in payload;
    const completeInput = hasCompleteInput ? payload.input : undefined;
    const preview = buildZCodeStreamingToolInputPreview(
      rawInput,
      hasCompleteInput ? completeInput : undefined,
    );
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    // [事务] 只有「完整」参数才写进工具记忆：半成品写入会让后续 result 分支
    // 把一个解析失败的 input 回填进消息树，用户看到的是残缺参数。
    if ((hasCompleteInput || preview.complete) && toolProjectionMemory) {
      finalizeZCodeToolProjectionInput(toolId, preview.input, toolProjectionMemory);
    }
    streamingToolInputById?.set(toolId, {
      // 性能修复：最终 tool_call 后，消息树已经持有完整 input；projection tombstone 不再保留
      // 大 raw JSON，避免长任务并发时后台 state 持续占用 renderer 内存。
      rawInput: "",
      deltaCount: state?.deltaCount,
      lastPreviewAt: Date.now(),
      lastPreviewRawInputLength: rawInput.length,
    });
    const previewSummary = readStreamingToolInputPreviewLogSummary(
      preview.input,
      rawInput.length,
      state?.deltaCount,
    );
    logStreamingToolInputProjection({
      ...previewSummary,
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      ...previewSummary,
      force: true,
      kind,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      // [失败路径] 其余 kind 一律丢弃：协议未来新增的流式类型既不能让投影抛错，
      // 也不能被误当成工具参数（那会在 UI 上凭空生成一个工具块）。
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  return null;
}

// [事务] 预览只截取前若干个 key 与有限长度：它是给人看的缩略图，不是完整的 input。
// [权衡] 截断点固定而不按字符数动态计算，保证同一工具在不同轮次的预览形状一致。
function buildStreamingToolInputRaw(
  payload: Record<string, unknown>,
  input: unknown,
  rawInput: string | undefined,
): Record<string, unknown> {
  return {
    ...payload,
    ...(input !== undefined ? { input } : {}),
    ...(rawInput ? { streamingRawInputLength: rawInput.length } : {}),
  };
}

// [资源] 采样日志：每个 toolId 每个桶只记录一次（INV-38），避免写文件类工具刷屏。
// [失败路径] 日志构造本身包 try/catch：诊断代码绝不能影响投影结果。
function logStreamingToolInputProjection(details: {
  contentLength?: number;
  contentLineCount?: number;
  deltaCount?: number;
  filePath?: string;
  inputKeys: string[];
  kind: string;
  projectedType: "tool_call" | "tool_call_update";
  rawInputLength: number;
  taskId: string;
  toolId: string;
  toolName?: string;
  traceId: TraceId;
}): void {
  logger.debug("[streamingToolInput] projected", {
    ...details,
    event: "ui.zcode_session.streaming_tool_input.projected",
  });
}

// [权衡] 样本只取 key 名与长度，不取 value 片段：value 可能是用户源码，属于正文（INV-25 的同源约束）。
function logStreamingToolInputProjectionSample(details: {
  contentLength?: number;
  contentLineCount?: number;
  deltaCount?: number;
  filePath?: string;
  force?: boolean;
  kind: string;
  taskId: string;
  toolId: string;
  toolName?: string;
}): void {
  const lineCount = details.contentLineCount;
  const bucket =
    lineCount === undefined
      ? -1
      : Math.floor(lineCount / STREAMING_TOOL_INPUT_INFO_LOG_LINE_BUCKET);
  const key = `${details.taskId}:${details.toolId}:projection`;
  if (!details.force && streamingToolInputProjectionLogBuckets.get(key) === bucket) {
    return;
  }
  streamingToolInputProjectionLogBuckets.set(key, bucket);
  if (details.kind === "tool_input_end") {
    streamingToolInputProjectionLogBuckets.delete(key);
  }

  // 性能优化：工具输入投影跟工具调用数量同级，生产 info 落盘会放大深度检索的 renderer 开销。
  // 这里保留 debug 采样，排查时仍能打开细节。
  logger.debug("[streamingToolInput] projection sampled", {
    ...details,
    event: "ui.zcode_session.streaming_tool_input.projection_sampled",
  });
}

// [资源] 摘要读取有固定上限：它运行在高频路径上，不能做递归遍历或深拷贝。
// [失败路径] 非对象输入直接返回空摘要，避免对字符串做属性访问。
function readStreamingToolInputPreviewLogSummary(
  input: unknown,
  rawInputLength: number,
  deltaCount: number | undefined,
) {
  const record = asRecord(input);
  const content = readStringField(record, [
    "content",
    "new_string",
    "newString",
    "new_text",
    "newText",
  ]);
  const filePath = readStringField(record, [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "filename",
    "file",
  ]);
  return {
    ...(content !== undefined
      ? {
          contentLength: content.length,
          contentLineCount: countTextLines(content),
        }
      : {}),
    ...(deltaCount !== undefined ? { deltaCount } : {}),
    ...(filePath ? { filePath } : {}),
    rawInputLength,
  };
}

// [事务] 有些 provider 的 delta 不带工具名，只能从参数形状反推（例如含 file_path 的是写文件）。
// [权衡] 这仅是日志诊断用途，推断结果绝不写回业务字段，避免错误工具名污染 UI。
function inferStreamingToolInputToolName(input: unknown): string | undefined {
  const record = asRecord(input);
  const filePath = readStringField(record, [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "filename",
    "file",
  ]);
  if (!filePath) {
    return undefined;
  }
  if (readStringField(record, ["old_string", "oldString", "old_text", "oldText"])) {
    return "Edit";
  }
  if (
    readStringField(record, ["content", "new_string", "newString", "new_text", "newText"]) !==
    undefined
  ) {
    return "Write";
  }
  return undefined;
}

// [事务] 读取可选字符串的统一入口：非字符串一律视为缺失，杜绝 0/false 被当成有效值。
function readStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

// [资源] 只做换行计数，不切分数组：高频路径上避免为统计分配临时字符串数组。
function countTextLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/u).length;
}

// [资源] key 列表本身也有上限：超长对象（例如整份文件内容作为单 key）不能让日志膨胀。
function inputPreviewKeys(input: unknown): string[] {
  return Object.keys(asRecord(input));
}

// 工具更新事件的三态分派：input（首次调用）、result（终态结果）、error（失败）。
// [事务] 三个分支的产物形状必须一致（INV-01）：否则运行中与冷恢复的工具块会显示不同字段。
// [并发] 依赖 toolProjectionMemory 回填工具名与已下发的 input，因为更新事件本身可能不带这些字段。
// [失败路径] 重复的 input（completeToolInputById 已存在）只更新状态、不再重发 input：
// 重发会让已经渲染的参数区闪一下并回退到旧值。
// [权衡] 终态后调用 forgetZCodeToolProjectionMetadata（INV-08）：既释放内存，也避免下一轮同名工具复用旧名。
// [事务] 主 agent 的工具输出还要额外尝试提取 plan steps，产生第二条 plan 事件。
function mapToolUpdated(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent[] {
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return [];
  }
  // [事务] 每次更新都重新取 parentToolUseId：它由 CLI 逐事件带上，
  // 缓存会让子 agent 在父任务切换后仍挂到旧气泡下。
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const memory = toolProjectionMemory ?? {};
  const toolNameById = memory.toolNameById;
  // [事务] 记忆查询一次性取回工具名与已下发 input：两者必须来自同一时刻，
  // 分开查询会在并发更新下拿到不一致的组合。
  const rememberedTool = resolveZCodeToolProjectionMetadata(payload, toolId, memory);
  const rememberedToolName = rememberedTool.toolName;
  const rememberedInput = rememberedTool.hasInput ? rememberedTool.input : undefined;
  // [事务] 带 input 与 toolName 的更新是「工具开始执行」：这是本轮唯一一次
  // 可以把完整参数写进消息树的时机，之后的更新只改状态。
  // [失败路径] 判据用 in 而不是值判定：input 可以是空对象，空值仍是有效参数。
  if ("input" in payload && "toolName" in payload) {
    const toolName = rememberedToolName ?? "tool";
    toolNameById?.set(toolId, toolName);
    // [事务] 重复的完整 input 只更新状态：重发会让已经渲染的参数区闪回旧值，
    // 用户会误以为参数被服务端改写。
    const duplicateMaterializedInput = memory.completeToolInputById?.has(toolId) ?? false;
    if (duplicateMaterializedInput) {
      return [
        {
          type: "tool_call_update",
          taskId,
          traceId,
          ...(inputId ? { inputId } : {}),
          toolId,
          parentToolUseId,
          toolName,
          kind: toolName,
          status: toolStatusFromPayload(payload),
          raw: omitRepeatedToolInputFromRaw(payload),
        },
      ];
    }
    finalizeZCodeToolProjectionInput(toolId, payload.input, memory);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: payload.input,
      toolName,
      kind: toolName,
      title: toolName,
      raw: payload,
    };
    // [事务] 只有主 agent 的工具输入才提取计划：子 agent 的 TodoWrite 属于它自己的上下文，
    // 投影到主面板会污染用户当前看到的待办。
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolInput({
          title: toolName,
          kind: toolName,
          input: payload.input,
        })
      : null;
    return planSteps
      ? [
          toolEvent,
          {
            type: "plan",
            taskId,
            traceId,
            ...(inputId ? { inputId } : {}),
            steps: planSteps,
          },
        ]
      : [toolEvent];
  }
  // [事务] result 分支只更新状态与输出，不重发 input：参数已在开始分支写进消息树。
  // [失败路径] 工具名缺失时沿用记忆里的值，自造工具名会让标题与实际工具不符。
  // [权衡] 输出按工具类型归一（normalizeToolResultContent），不同工具的 result 结构差异很大。
  if ("result" in payload) {
    const result = asRecord(payload.result);
    const toolName = rememberedToolName;
    const content = normalizeToolResultContent(toolName, result);
    const status = toolResultStatus(toolName, result);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName,
      kind: toolName,
      title: toolName,
      ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
      status,
      content,
      error: stringValue(asRecord(result.error).message),
      raw: payload,
    };
    // [资源] 只有终态才释放工具记忆（INV-08）：进行中释放会让后续 update 失去工具名，
    // 工具块标题退化成 "tool"。
    if (status !== "in_progress") {
      forgetZCodeToolProjectionMetadata(toolId, memory);
    }
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolOutput({
          title: toolName,
          kind: toolName,
          output: content ?? result,
        })
      : null;
    return planSteps
      ? [
          toolEvent,
          {
            type: "plan",
            taskId,
            traceId,
            ...(inputId ? { inputId } : {}),
            steps: planSteps,
          },
        ]
      : [toolEvent];
  }
  // [事务] error 是终态：立即释放记忆（INV-08），但保留已下发的 input，
  // 让失败卡片仍能展示用户当初提交的参数。
  if ("error" in payload) {
    forgetZCodeToolProjectionMetadata(toolId, memory);
    return [
      {
        type: "tool_call_update",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        toolId,
        parentToolUseId,
        toolName: rememberedToolName,
        kind: rememberedToolName,
        title: rememberedToolName,
        ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
        status: "failed",
        error: stringValue(asRecord(payload.error).message) ?? "Tool failed",
        raw: payload,
      },
    ];
  }
  return [
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName: rememberedToolName,
      kind: rememberedToolName,
      title: rememberedToolName,
      // [事务] 这是「仅状态」的进行中更新：input 只有在上游没省略时才回填，
      // 否则大参数会在每条心跳里被重复下发。
      // [失败路径] 没有记忆时 toolName 为 undefined，UI 用运行态占位而不是显示错误。
      ...(rememberedInput !== undefined && payload.inputOmitted !== true
        ? { input: rememberedInput }
        : {}),
      status: "in_progress",
      raw: payload,
    },
  ];
}

// [事务] 结果状态判定必须看的是 result 里的显式标志，不能靠内容里是否出现 error 字符串：
// 工具输出里包含 "error" 这个词是很常见的（例如 grep 结果）。
// [失败路径] 缺状态时默认 completed，而不是 in_progress：否则工具块会永远转圈。
function toolResultStatus(
  toolName: string | undefined,
  result: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  if (result.success === false) {
    return "failed";
  }
  if (isBackgroundAgentLaunchResult(toolName, result)) {
    // 修复原因：Agent 后台启动 ACK 只说明子 agent 已经开始运行；
    // replay/snapshot 投影不能把它当成最终完成，否则运行中会被前端显示为 completed。
    return "in_progress";
  }
  return "completed";
}

// [事务] 后台 agent 启动结果需要识别出来，因为它的终态语义是「已派发」而不是「已完成」。
// [失败路径] 误判会把启动回执渲染成任务完成，用户以为子任务已经结束。
function isBackgroundAgentLaunchResult(
  toolName: string | undefined,
  result: Record<string, unknown>,
): boolean {
  const content = stringValue(result.content);
  if (!content) {
    return false;
  }
  if (
    (isSubagentDispatchToolName(toolName) || toolName === undefined) &&
    isBackgroundAgentLaunchAcknowledgement(content)
  ) {
    return true;
  }
  const parsed = parseJsonRecord(content);
  const parsedStatus = stringValue(parsed?.status);
  return (
    parsed !== null &&
    (isSubagentDispatchToolName(toolName) || stringValue(parsed.agentId) !== undefined) &&
    ((parsedStatus === "backgrounded" && stringValue(parsed.backgroundTaskId) !== undefined) ||
      (parsedStatus === "async_launched" &&
        stringValue(parsed.agentId) !== undefined &&
        stringValue(parsed.outputFile) !== undefined))
  );
}

// [权衡] 同时兼容三种回执文案（当前/上一版/旧版）：历史会话里存的是当时的字符串，
// 只认最新文案会让老会话的后台任务被误判为普通结果。
function isBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  // 修复原因：session projection 可能直接消费 replay/snapshot 结果，不能只依赖消息层兜底；
  // 新的 async_launched ACK 对齐 provider-visible output_file 文案，旧 session 仍保留 outputFile/backgroundTaskId 文案。
  return (
    isLegacyBackgroundAgentLaunchAcknowledgement(content) ||
    isPreviousBackgroundAgentLaunchAcknowledgement(content) ||
    isCurrentBackgroundAgentLaunchAcknowledgement(content)
  );
}

// [权衡] 旧版文案的匹配刻意保持宽松但固定：这是只读兼容判断，不参与任何写入逻辑。
function isLegacyBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.includes("backgroundTaskId:") &&
    content.includes("Runtime will wait for this background Agent")
  );
}

// [事务] 「上一版」与「当前版」分开判断，是为了在文案再次演进时只改一处判定，
// 而不是让三个正则互相覆盖。
function isPreviousBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Agent ") &&
    content.includes(" started in background.") &&
    content.includes("agentId:") &&
    content.includes("outputFile:") &&
    content.includes("You will be notified when the Agent completes.")
  );
}

// [事务] 当前版文案是唯一会由新会话产生的形式，其余两种只用于历史回放。
function isCurrentBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Async agent launched successfully.") &&
    content.includes("agentId:") &&
    content.includes("The agent is working in the background.") &&
    content.includes("notified automatically when it completes")
  );
}

// [事务] 子 agent 派发工具名决定是否走「后台任务」而非「普通工具」的渲染分支。
function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName === "Agent" || toolName === "Task";
}

// [事务] payload 状态是协议字符串，必须收敛成 UI 的三态联合；未知值按失败处理而不是当作进行中，
// 后者会让工具块永远处于 loading。
// [失败路径] 缺字段时返回 in_progress：这是刚创建工具调用的正常初始态。
function toolStatusFromPayload(
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  switch (stringValue(payload.status)) {
    case "tool_started":
      return "in_progress";
    case "tool_denied":
      return "denied";
    case "tool_result_committed":
    case "tool_call_closed":
    case "tool_queued":
    default:
      return "pending";
  }
}

// [资源] 去掉 raw 里重复的 input 字段：input 已经作为独立字段下发，
// 再在 raw 里保留一份会让消息持久层体积翻倍。
function omitRepeatedToolInputFromRaw(payload: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, ...rest } = payload;
  return {
    ...rest,
    inputOmitted: true,
    inputRef: "tool_call",
  };
}

// [事务] 父工具 id 用于把子 agent 的工具块挂到正确的父气泡下；
// 同时兼容两种字段名（驼峰与 claude 原始格式），因为不同 provider 写法不同。
function parentToolUseIdFromToolPayload(payload: Record<string, unknown>): string | null {
  // 修复原因：前端 replay/snapshot projection 可能绕过 services adapter；
  // 这里和服务层保持同一套 parentToolCallId -> parentToolUseId 归一规则。
  return (
    stringValue(payload.parentToolUseId) ??
    stringValue(payload.parentToolCallId) ??
    rawClaudeParentToolUseId(payload)
  );
}

// [失败路径] 只从 raw 的约定位置读取，读不到就返回 null：猜测父 id 会把工具挂错层级。
function rawClaudeParentToolUseId(raw: unknown): string | null {
  const meta = asRecord(raw)._meta;
  const claudeCode = asRecord(meta).claudeCode;
  return stringValue(asRecord(claudeCode).parentToolUseId) ?? null;
}

// [事务] 工具结果内容在协议里可能是字符串、数组或对象，UI 统一成字符串或结构化块。
// [失败路径] 空结果返回 undefined 而不是空串：UI 用 undefined 判断「无输出」，空串会渲染一个空框。
// [权衡] 不在这里截断长输出：折叠由 UI 负责，提前截断会让「查看全部」失效。
function normalizeToolResultContent(
  toolName: string | undefined,
  result: Record<string, unknown>,
): unknown {
  const content = result.content;
  const agentActivity = parseAgentActivityResultContent(toolName, content);
  return agentActivity ?? stringValue(content);
}

// [事务] agent 活动结果是嵌套 JSON 字符串，需要解析两层才能拿到真正的消息体。
// [失败路径] 任一层解析失败都返回 null，调用方回退为原始文本展示；
// 抛错会让一个格式异常的子 agent 结果毁掉整个父消息。
// [权衡] 限制递归深度：恶意/异常数据可能构造极深嵌套，导致解析栈溢出。
function parseAgentActivityResultContent(
  toolName: string | undefined,
  content: unknown,
): { kind: "agent_activity"; content: string; thought?: string } | null {
  if (typeof content !== "string" || content.trim().length === 0) {
    return null;
  }
  const parsed = parseJsonRecord(content);
  if (!parsed) {
    return null;
  }
  const isAgentResult =
    toolName === "Agent" ||
    toolName === "Task" ||
    stringValue(parsed.agentId) !== undefined ||
    stringValue(parsed.agentType) !== undefined;
  if (!isAgentResult) {
    return null;
  }
  const output = agentTextFromContentField(parsed.content);
  if (!output) {
    return null;
  }
  const thought = stringValue(parsed.thought);
  return {
    kind: "agent_activity",
    content: output,
    ...(thought ? { thought } : {}),
  };
}

// [失败路径] JSON.parse 包 try/catch 且要求结果是普通对象：数组与字面量一律视为不可用。
function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

// [事务] content 字段可能是字符串或块数组，统一抽出可展示文本；
// [失败路径] 无法识别的形状返回 undefined，让调用方保留原始 JSON 而不是显示 [object Object]。
function agentTextFromContentField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((item) => stringValue(asRecord(item).text))
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return text || undefined;
}

// [事务] 权限请求的 payload → UI 权限卡；选项必须完整保留（allow/deny/always 等），
// 否则用户只能做有限选择，某些工具会永远无法放行。
// [失败路径] 缺 requestId 时返回 null：没有身份的回答无法被 CLI 配对（INV-42）。
function permissionPayloadToStreamEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): ZCodeStreamEvent {
  return {
    type: "permission_request",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    // [事务] requestId 优先用协议值，旧版事件只有 toolCallId 可用：
    // 两者都没有时给 "unknown"，保证卡片可渲染但不可回答，而不是整条事件丢失。
    requestId: stringValue(payload.requestId) ?? stringValue(payload.toolCallId) ?? "unknown",
    description:
      stringValue(payload.reason) ?? stringValue(payload.toolName) ?? "Permission required",
    kind: stringValue(payload.toolName) ?? "tool",
    title: stringValue(payload.toolName),
    // [事务] 选项来自 payload 而不是本地枚举：不同工具的权限项不同，
    // 自造选项会让用户点到一个 CLI 无法识别的决策。
    options: permissionOptionsFromPayload(payload),
    ...(payload.origin ? { origin: payload.origin as ZCodePermissionRequest["origin"] } : {}),
    raw: payload,
  };
}

// [事务] 权限被解决时需要同时产生「权限卡消失」与「工具继续/终止」两类效果，
// 顺序必须是先解除卡片再推进工具，否则 UI 会短暂显示「已回答但仍等待」。
// [失败路径] 解决的是已不存在的请求时仍要下发解除事件：UI 可能因刷新而保留了卡片。
// [权衡] 这里可能返回多条事件，因此接口是数组而不是单事件。
function permissionResolvedPayloadToStreamEvents(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolNameById?: Map<string, string>,
): ZCodeStreamEvent[] {
  const toolCallId = stringValue(payload.toolCallId);
  // [事务] 解决事件可能不带工具名：必须回查 requested 时登记的记忆（INV-06），
  // 否则分不清它是普通权限还是问答通道的解决。
  const toolName =
    stringValue(payload.toolName) ?? (toolCallId ? toolNameById?.get(toolCallId) : undefined);
  // [权衡] decision 缺省时按允许处理：旧协议只在拒绝时显式给值，
  // 把缺省当拒绝会让所有老会话的授权行为失效。
  const decision = stringValue(payload.decision);
  // [事务] requestId 三级回退：新版带 requestId，旧版只有 toolCallId；
  // 最后的 "unknown" 只保证类型成立，UI 侧会因此无法回答（可接受的降级）。
  const requestId = stringValue(payload.requestId) ?? toolCallId ?? "unknown";

  // [事务] 问答类工具的「解决」不是权限回答，而是 elicitation 的 accept/decline（INV-09）：
  // 走错通道会让问答卡片永远停在等待态。
  if (isUserInputBackedPermissionToolName(toolName)) {
    return [
      {
        type: "elicitation_response",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        requestId,
        action: decision === "deny" ? "decline" : "accept",
      },
    ];
  }

  // [事务] 权限回答必须是「结构完整」的对象：UI 的决策联合类型不接受缺字段，
  // 因此这里显式构造而不是展开原 payload。
  // [失败路径] 决策值来自白名单，未知值在上游已被归一为拒绝，防止误放行。
  const permissionResponse = {
    type: "permission_response",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    requestId,
    optionId: decision ?? "allow",
    response: {
      decision: decision === "deny" ? "deny" : "allow",
    },
  } as Extract<ZCodeStreamEvent, { type: "permission_response" }>;

  // [失败路径] 只有「拒绝且知道工具身份」才补发失败更新：允许时工具会自己产出 result，
  // 在这里抢发失败会让真实输出被覆盖。
  if (decision !== "deny" || !toolCallId) {
    return [permissionResponse];
  }

  // 修复原因：Plan mode 等运行时拒绝会先发 permission.resolved，
  // 但不一定有对应 tool.updated(error) 实时事件；只清权限请求会让已 started 的工具卡一直转。
  return [
    permissionResponse,
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId: toolCallId,
      parentToolUseId: parentToolUseIdFromToolPayload(payload),
      status: "failed",
      toolName,
      kind: toolName,
      title: toolName,
      error: stringValue(payload.reason) ?? "Permission denied",
      raw: payload,
    },
  ];
}

// [事务] 冷恢复时把持久 pending 项还原成权限卡：这是「刷新后仍能看到待回答」的唯一来源。
// [失败路径] user-input 类 pending 必须返回 null（INV-20），交给 elicitation 还原。
function pendingPermissionToStreamEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    description: permission.reason || permission.toolName,
    kind: permission.toolName,
    title: permission.toolName,
    options: permission.options,
    ...(permission.origin ? { origin: permission.origin } : {}),
    raw: permission,
  };
}

// [事务] 选项 id 与 label 必须成对保留：UI 回传的是 id，展示的是 label，
// 缺 label 时用户面对一串机器 id，缺 id 时回答无法被识别。
function permissionOptionsFromPayload(payload: Record<string, unknown>): ZCodePermissionOption[] {
  return Array.isArray(payload.options) ? (payload.options as ZCodePermissionOption[]) : [];
}

type PendingElicitationQuestion = {
  question: string;
  header: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
};

// [事务] 把「以 permission 形式存在的问答」翻译成 elicitation（INV-09/42）：
// messageId 与 toolCallId 必须原样带出，回答才能命中 CLI 的等待项。
// [失败路径] 缺少任一 id 时返回 null，而不是生成合成 id。
function pendingUserInputBackedPermissionToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> | null {
  // [事务] 冷恢复时的 pending 问答必须先判工具名（INV-09/20）：
  // AskUserQuestion 的 input 结构固定，用它生成完整的 questions 列表。
  // [失败路径] 解析失败时回退到通用 elicitation（单问题），保证卡片仍可回答。
  if (isAskUserQuestionToolName(permission.toolName)) {
    return pendingAskUserQuestionToElicitationEvent(taskId, permission);
  }
  // [事务] 计划审批走固定问题集合（INV-44）：approve + 拒绝两项，
  // 不能沿用模型给的 questions（ExitPlanMode 的 input 里没有问答结构）。
  if (isExitPlanModeToolName(permission.toolName)) {
    return pendingExitPlanModeToElicitationEvent(taskId, permission);
  }
  return null;
}

// [事务] AskUserQuestion 的 input 是模型自由构造的 JSON，必须防御式解析（INV-43）。
// [失败路径] 解析失败时返回空问题列表而不是抛错：一个坏参数不能让整个会话打不开。
// [权衡] 问题文本做 length 截断：超长问题会把卡片撑破，但截断不影响回答。
function pendingAskUserQuestionToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> | null {
  // [事务] 把模型自由构造的 input 转成受控问题列表（INV-43）：
  // 该函数内部吞掉所有解析异常，这里不需要额外 try/catch。
  // [权衡] 空列表也在后续被替换成单问题降级，避免渲染一张没有问题的卡片。
  const questions = askUserQuestionInputToElicitationQuestions(permission.input);
  if (questions.length === 0) {
    return null;
  }
  const firstQuestion = questions[0];
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    message: firstQuestion?.question ?? permission.reason,
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    questions,
    ...(permission.origin ? { origin: permission.origin } : {}),
    schema: permission.input,
  };
}

// [事务] 计划审批固定两个选项：approve 与拒绝（INV-44），拒绝项必须带默认 id，
// 保证 UI 不依赖顺序也能正确回传。
// [失败路径] 没有 plan 文本时仍然生成卡片：空计划也需要用户明确响应，否则会话卡死。
function pendingExitPlanModeToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> {
  const questions = createExitPlanModeApprovalQuestions();
  const firstQuestion = questions[0];
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    message: firstQuestion.question,
    header: firstQuestion.header,
    options: firstQuestion.options,
    questions,
    ...(permission.origin ? { origin: permission.origin } : {}),
    schema: { interaction: "plan_approval", toolName: permission.toolName },
  };
}

// [资源] 后台任务面板状态按 sessionId 惰性建缓存，且只在真正出现后台任务时创建：
// 大多数会话没有后台任务，预分配会让每个会话多一张 Map。
function ensureProjectionBackgroundTaskControlsCache(
  state: ZCodeSessionEventProjectionState | undefined,
): Map<string, ZCodeBackgroundTaskControlItem[]> | null {
  if (!state) {
    return null;
  }
  state.backgroundTaskControlsBySession ??= new Map();
  return state.backgroundTaskControlsBySession;
}

// [事务] 覆盖写而不是合并：快照里的 backgroundJobs 是权威全量列表，
// 合并会让已结束的任务残留在面板里。
function setProjectionBackgroundTaskControls(
  state: ZCodeSessionEventProjectionState | undefined,
  taskId: string,
  jobs: ZCodeBackgroundTaskControlItem[],
) {
  ensureProjectionBackgroundTaskControlsCache(state)?.set(taskId, jobs);
}

// [事务] 事件驱动的后台任务同步入口：把最新的 job 列表整体写进 projection state，
// 供后续 session.updated 复用，避免 UI 每次重渲染都重新解析事件。
export function syncZCodeSessionBackgroundTaskProjection(
  state: ZCodeSessionEventProjectionState | undefined,
  taskId: string,
  jobs: ZCodeBackgroundTaskControlItem[],
) {
  setProjectionBackgroundTaskControls(state, taskId, jobs);
}

// [事务] 冷恢复时的同构入口（INV-01/35）：snapshot 的 backgroundJobs 与事件流使用同一形状，
// 保证刷新前后后台任务面板内容一致。
// [失败路径] 解析失败的条目被丢弃，不让一条坏数据清空整个面板。
export function syncZCodeSessionBackgroundTaskProjectionFromSnapshot(
  state: ZCodeSessionEventProjectionState | undefined,
  snapshot: ZCodeSessionStateSnapshot,
) {
  // Bugfix: 单 task completion 是增量 payload，必须以同一订阅收到的完整 snapshot
  // 作为 merge 基线；否则切走/切回后新 projection state 会把 peer running task 清掉。
  syncZCodeSessionBackgroundTaskProjection(
    state,
    snapshot.session.sessionId,
    parseZCodeBackgroundTaskControlItems(snapshot.projection.backgroundJobs),
  );
}

// [事务] 单条任务更新：按 jobId 就地替换，未命中则追加；
// 这是高频路径（每个任务状态变化一次），所以不做全量 diff。
// [失败路径] payload 缺 jobId 时返回 null，调用方不产生事件。
function updateProjectionBackgroundTaskControlsFromPayload(
  state: ZCodeSessionEventProjectionState | undefined,
  taskId: string,
  payload: Record<string, unknown>,
): ZCodeBackgroundTaskControlItem[] | null {
  const parsedJobs = parseZCodeBackgroundTaskControlItems([payload]);
  if (parsedJobs.length === 0) {
    return null;
  }
  const cache = ensureProjectionBackgroundTaskControlsCache(state);
  if (!cache) {
    return parsedJobs;
  }
  const nextJobs = mergeZCodeBackgroundTaskControlItems(cache.get(taskId) ?? [], parsedJobs);
  cache.set(taskId, nextJobs);
  return nextJobs;
}

// [事务] 计划审批的固定问题集合（INV-44）：approve 选项 id 必须与 CLI 约定一致，
// 否则用户的批准会被当成未知回答。
// [权衡] 拒绝项使用通用 id 而不是枚举，因为 CLI 只区分「批准」与「其余」。
function createExitPlanModeApprovalQuestions(): [PendingElicitationQuestion] {
  return [
    {
      header: "Plan",
      options: [
        {
          description: "Exit plan mode and start implementation.",
          label: "Approve",
          value: EXIT_PLAN_MODE_APPROVAL_APPROVE,
        },
      ],
      question: EXIT_PLAN_MODE_APPROVAL_QUESTION,
    },
  ];
}

// [事务] 模型给的 questions 是任意 JSON：只接受数组，逐项校验 title/options（INV-43）。
// [失败路径] 非数组、空数组都返回 []，UI 会退化为「无需回答」，而不是白屏。
// [权衡] 选项超过上限时截断：卡片高度有限，超出部分用户也点不到。
function askUserQuestionInputToElicitationQuestions(input: unknown): PendingElicitationQuestion[] {
  type ElicitationOption = PendingElicitationQuestion["options"][number];
  const questions = asRecord(input).questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) => {
      const record = asRecord(question);
      const questionText = stringValue(record.question);
      const header = stringValue(record.header) ?? questionText;
      const rawOptions = Array.isArray(record.options) ? record.options : [];
      const options: ElicitationOption[] = rawOptions
        .map((option) => {
          const optionRecord = asRecord(option);
          const label = stringValue(optionRecord.label);
          if (!label) {
            return null;
          }
          const description = stringValue(optionRecord.description);
          const parsedOption: ElicitationOption = {
            value: label,
            label,
            ...(description ? { description } : {}),
          };
          return parsedOption;
        })
        .filter((option): option is ElicitationOption => option !== null);
      if (!questionText || !header || options.length === 0) {
        return null;
      }
      const parsedQuestion: PendingElicitationQuestion = {
        question: questionText,
        header,
        options,
        ...(record.multiSelect === true ? { multiSelect: true } : {}),
      };
      return parsedQuestion;
    })
    .filter((question): question is PendingElicitationQuestion => question !== null);
}

// 会话级信息事件的多产物映射（INV-35）：session.updated 与 streamRecovery.updated 共用。
// [事务] 一条 payload 可能同时更新校验、用量、标题、重试、模式、目标与后台任务，
// 因此按固定顺序累积事件：顺序即 UI 的应用顺序。
// [失败路径] 任何单个子字段异常都只跳过该事件，不影响其余产物。
function mapSessionInfoLikePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
  state: ZCodeSessionEventProjectionState | undefined,
): ZCodeStreamEvent[] {
  // [事务] session_info 是一类「多产物」事件：一条 payload 可能同时携带目标校验、用量、
  // 网络调试、标题、重试、模式、目标变更与后台任务，因此这里累积成数组而不是返回单事件。
  // [权衡] 顺序即 UI 应用顺序：先校验与用量，再标题/重试/模式，最后目标与后台任务。
  const events: ZCodeStreamEvent[] = [];
  const goalVerification = goalVerificationFromPayload(payload);
  // [事务] 校验状态必须在用量之前下发：verifier 的结论会决定这一轮是否计入目标轮次，
  // UI 依赖它先建立轮次边界再渲染用量。
  if (goalVerification) {
    events.push({
      type: "goal_verification_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      verification: goalVerification,
    });
  }
  const tokenUsageDelta = taskTokenUsageDeltaFromPayload(
    taskId,
    traceId,
    inputId,
    eventId,
    payload,
  );
  // [事务] 用量增量只在 model.complete 时产生（INV-46）：重复累加会让费用翻倍。
  if (tokenUsageDelta) {
    events.push(tokenUsageDelta);
  }
  // [权衡] 网络调试是附加诊断：它不参与任何业务判断，
  // 因此缺失或结构异常时直接跳过，不能让诊断字段影响主链路可用性。
  const networkDebugStatus = zcodeTaskNetworkDebugStatusFromPayload({
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(eventId ? { eventId } : {}),
    payload,
  });
  // [权衡] 网络调试状态是可选诊断：没有就跳过，不能因为它缺失而影响其他事件。
  if (networkDebugStatus) {
    events.push(networkDebugStatus);
  }
  // [事务] 上下文用量必须同时有 used 与 size 才下发（INV-19）：
  // 只有一半的进度条比没有更误导用户。
  // [失败路径] cost 允许缺失，用 null 表示未知计费，而不是 0（0 会被展示为免费）。
  const contextUsage = contextUsageFromPayload(payload);
  if (contextUsage) {
    events.push({
      type: "usage_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      used: contextUsage.used,
      size: contextUsage.size,
      cost: contextUsage.cost ?? null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    });
  }
  // [事务] 标题同理只在非空时下发（INV-34）：空串是「清空」信号，这里选择不响应，
  // 因为标题清空没有产品语义，覆盖只会让侧栏出现无名会话。
  const title = stringValue(payload.title);
  if (title) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      title,
    });
  }
  // [事务] 注意判据是 !== undefined 而不是 truthy（INV-28）：
  // apiRetry 为 null 是「清除重试条」的有效指令，用 truthy 判断会把它吞掉。
  const apiRetry = apiRetryFromSessionInfoPayload(payload);
  if (apiRetry !== undefined) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      apiRetry,
    });
  }
  // [事务] 模式变更必须带上 availableModes：EnterPlanMode 通过 bootstrap 投影成 session.updated，
  // 只给 currentModeId 会让菜单仍停留在进入 plan 之前的模式。
  // [失败路径] mode 字符串做归一化，未知值不会让下拉框崩掉。
  const mode = stringValue(payload.mode);
  if (mode) {
    events.push({
      type: "mode_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      // Bugfix: EnterPlanMode 写入的 SessionModeChanged 会经 bootstrap 投影成 session.updated；
      // 这里把 mode payload 转成 UI 现有事件，避免菜单仍显示进入 plan 前的模式。
      currentModeId: normalizeAvailableZCodeMode(mode as ZCodeSessionMode),
      availableModes: getZCodeAgentAvailableModes(),
    });
  }
  // [事务] 目标变更用「字段存在性」判定而不是值判定：target 可以为 null（清空目标），
  // 用 truthy 判断会把「清除目标」漏掉，UI 会一直显示旧目标。
  // [权衡] source 只有 "tool" 与 "runtime" 两种，未知值按 runtime 处理。
  if ("target" in payload && ("action" in payload || "source" in payload)) {
    const targetAction = normalizeTargetChangedAction(stringValue(payload.action));
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      target: {
        action: targetAction,
        source: stringValue(payload.source) === "tool" ? "tool" : "runtime",
        target: payload.target ? fromZCodeGoal(payload.target as never) : null,
        previousTarget: payload.previousTarget
          ? fromZCodeGoal(payload.previousTarget as never)
          : undefined,
      },
    });
  }
  const projection = asRecord(payload.projection);
  // [事务] backgroundJobs 是「全量列表」语义：每次到达都整体覆盖 projection 缓存，
  // 与单条 update 分支互补（INV：全量优先于增量）。
  // [失败路径] 单条坏数据只被逐条丢弃，不会因为一条畸形记录把整块全量列表变成空面板。
  if (Array.isArray(projection.backgroundJobs)) {
    const jobs = parseZCodeBackgroundTaskControlItems(projection.backgroundJobs);
    setProjectionBackgroundTaskControls(state, taskId, jobs);
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs,
    });
  }
  // [事务] 增量更新排在全量之后：同一条 payload 同时携带两者时以增量覆盖全量，
  // 保证最新的单条状态不会被稍旧的全量列表盖回去。
  const backgroundJobUpdate = updateProjectionBackgroundTaskControlsFromPayload(
    state,
    taskId,
    payload,
  );
  if (backgroundJobUpdate) {
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs: backgroundJobUpdate,
    });
  }
  return events;
}

// [事务] 目标变更动作是 UI 侧联合类型，协议可能新增未知动作；
// 未知一律归一为 updated，而不是丢弃整条事件，保证目标内容仍能刷新。
function normalizeTargetChangedAction(action: string | undefined): ZCodeTaskTargetChangedAction {
  switch (action) {
    case "status_updated":
    case "cleared":
    case "usage_accounted":
    case "run_started":
    case "run_finished":
    case "summary_updated":
      return action;
    case "set":
    default:
      return "set";
  }
}

// [事务] 校验状态是嵌套结构，且可能以字符串 JSON 形式出现；两种都接受，统一成对象。
// [失败路径] 缺少 targetId 或 iteration 时返回 null：没有身份的校验记录无法归轮次（INV-11）。
// [权衡] status 用 isZCodeTaskGoalStatus 收窄，未知状态降级为 running。
function goalVerificationFromPayload(
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "goal_verification_update" }>["verification"] | null {
  // [事务] querySource 是识别校验事件的唯一判据：模型正常输出里也可能出现同名字段，
  // 靠 content 猜会让普通回复被误判成校验结论。
  if (stringValue(payload.querySource) !== "target_completion_verification") {
    return null;
  }
  // [失败路径] 没有 content 就没有结论：返回 null 让本轮校验不投影，
  // 一条空白分割线比没有分割线更容易误导用户。
  const content = stringValue(payload.content);
  if (!content) {
    return null;
  }
  const parsed = parseJsonObjectFromText(content);
  if (!parsed) {
    // 修复原因：历史/实时投影可能只拿到 verifier 的原始模型文本；格式错误属于裁判链路故障，
    // 与 contracts 层保持 fail-open，避免恢复后又把已完成 goal 显示成未完成。
    return {
      passed: true,
      reason: "The completion verifier did not return valid JSON.",
    };
  }
  const reason =
    stringValue(parsed.reason)?.trim() ||
    "The completion verifier could not confirm that every goal requirement is complete.";
  const nextAction = stringValue(parsed.nextAction)?.trim();
  return {
    ...(nextAction ? { nextAction } : {}),
    passed: parsed.passed === true,
    reason,
  };
}

// [失败路径] 文本不是 JSON 或解析结果不是对象时返回 null，绝不让异常逃逸到事件循环。
function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
  // [事务] 先剥掉 markdown 代码围栏再解析：verifier 的输出常被包成 ```json 块，
  // 直接 JSON.parse 会失败并触发 fail-open，把未完成的校验误判为通过。
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // [权衡] 用首尾花括号切片而不是正则提取：模型常在 JSON 前后附带解释文字，
  // 截取最外层对象容错率最高，也不会误吞多个并列对象。
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// [事务] token 用量只累加 model.complete 事件（INV-46）：增量事件也带 usage 时重复累加会让费用翻倍。
// [失败路径] 缺 used/size 时返回 null，UI 保留上一次的环形进度而不是跳到 0。
// [权衡] cache 与 breakdown 逐项条件展开（INV-37），避免 undefined 覆盖已有细分统计。
function taskTokenUsageDeltaFromPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "task_token_usage_delta" }> | null {
  if (!isModelCompleteUsagePayload(payload)) {
    return null;
  }
  const usage = usageFromPayload(payload.usage);
  if (!usage || usage.totalTokens <= 0) {
    return null;
  }
  const querySource = stringValue(payload.querySource);
  const queryId = stringValue(payload.queryId);
  // 修复原因：累计 Token 要跟随每次模型完成实时更新，而不是等 task_complete 的整轮汇总；
  // eventId 是 protocol 流的稳定单事件标识，用它去重可避免前后台 monitor 重复记账。
  const eventKey =
    eventId ??
    `${traceId}:${inputId ?? "no-input"}:${queryId ?? "no-query"}:${querySource ?? "unknown"}:${usage.inputTokens}:` +
      `${usage.outputTokens}:${usage.totalTokens}`;
  return {
    type: "task_token_usage_delta",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(queryId ? { queryId } : {}),
    eventKey,
    ...(eventId ? { eventId } : {}),
    ...(querySource ? { querySource } : {}),
    usage,
  };
}

// [事务] 只认 model.complete：这是协议里唯一保证 usage 是「本轮最终值」的事件类型。
function isModelCompleteUsagePayload(payload: Record<string, unknown>): boolean {
  if (!("usage" in payload)) {
    return false;
  }
  return (
    stringValue(payload.stopReason) !== undefined ||
    "contextWindow" in payload ||
    stringValue(payload.querySource) !== undefined
  );
}

// [事务] 重试信息有两种形态：进行中（带 attempt/max）与已清除（显式 null）。
// 必须区分「字段缺失」与「值为 null」（INV-28）：前者表示本条消息不涉及重试，后者表示要清除重试条。
// [失败路径] 非法 attempt 值按 0 处理，UI 显示「重试中」而不是崩溃。
function apiRetryFromSessionInfoPayload(
  payload: Record<string, unknown>,
): ZCodeApiRetryStatus | null | undefined {
  if ("apiRetry" in payload) {
    return normalizeZCodeApiRetryStatus(payload.apiRetry);
  }

  // [事务] 旧协议把重试状态放在 runtime 里，新协议放在顶层：两条都要读，
  // 只读一处会让部分会话的输入栏永远看不到重试计数。
  const runtimeRetry = normalizeZCodeApiRetryStatus(asRecord(payload.runtime).apiRetry);
  if (runtimeRetry !== undefined) {
    return runtimeRetry;
  }

  // [事务] _meta.zcode 是 adapter 透传通道：桌面 continuous 与手机 replayable 的包装层不同，
  // 少了这一路会让其中一端看不到重试状态。
  const metaRetry = normalizeZCodeApiRetryStatus(asRecord(asRecord(payload._meta).zcode).apiRetry);
  if (metaRetry !== undefined) {
    return metaRetry;
  }

  // [失败路径] 断流恢复与网络状态放在最后尝试：它们的结果更不精确，
  // 提前命中会覆盖上面更权威的字段。
  return (
    zcodeApiRetryFromStreamRecoveryPayload(payload) ??
    zcodeApiRetryFromModelNetworkStatusPayload(payload)
  );
}

type ContextUsageUpdate = Pick<
  Extract<ZCodeStreamEvent, { type: "usage_update" }>,
  "used" | "size" | "cost" | "cache" | "breakdown"
>;

// [事务] projection 里的 usage 是落库快照，字段名与 runtime 不同，需要逐项归一（INV-19 的后备来源）。
// [失败路径] used/size 任一缺失即视为不可用：只有一半的进度条比没有更误导。
function contextUsageFromProjection(
  projection: ZCodeSessionStateSnapshot["projection"],
): ContextUsageUpdate | null {
  if (projection.contextWindow <= 0 || projection.contextUsed <= 0) {
    return null;
  }
  return {
    used: projection.contextUsed,
    size: projection.contextWindow,
    cost: null,
  };
}

// [事务] runtime 的 usage 是本次会话的实时值，优先级高于 projection（INV-19）。
// [失败路径] size 为 0 时视为不可用，避免出现除零得到 Infinity 的百分比。
function contextUsageFromRuntime(
  runtimeUsage: ZCodeSessionStateSnapshot["runtime"]["contextUsage"] | undefined,
): ContextUsageUpdate | null {
  if (!runtimeUsage || runtimeUsage.size <= 0 || runtimeUsage.used <= 0) {
    return null;
  }
  // Bugfix: session resume 时 protocol projection 可能还没重放主轮次 usage。
  // runtime.contextUsage 来自持久化 assistant token 记录，应优先用于恢复旧 task UI。
  return {
    used: runtimeUsage.used,
    size: runtimeUsage.size,
    cost: runtimeUsage.cost ?? null,
    ...(runtimeUsage.cache ? { cache: runtimeUsage.cache } : {}),
    ...(runtimeUsage.breakdown ? { breakdown: runtimeUsage.breakdown } : {}),
  };
}

// [事务] 会话信息事件里的 usage 优先级为 runtime > projection > payload（INV-19）。
// [失败路径] 三个来源都不可用时返回 null，UI 隐藏环形图而不是显示 0%。
// [权衡] cost 单独处理：它可以缺省（未知计费），但 used/size 必须同时存在。
function contextUsageFromPayload(payload: Record<string, unknown>): ContextUsageUpdate | null {
  const projection = asRecord(payload.projection);
  const usage = asRecord(payload.usage);
  // [事务] 分子分母必须来自同一来源（INV-19）：contextWindow 优先取 payload，
  // 缺失才回退 projection，交错取值会算出超过 100% 的占比。
  const size = numberValue(payload.contextWindow ?? projection.contextWindow);
  const explicitUsed = numberValue(payload.contextUsed ?? projection.contextUsed);
  const useModelUsageForContext = shouldUseModelUsageForContext(payload);
  const modelUsageUsed = useModelUsageForContext ? contextUsageTokensFromPayload(usage) : undefined;
  const used =
    modelUsageUsed ??
    // 修复原因：主轮次模型返回 usage 时必须以真实网络 token 统计为准；
    // context window 是 input + output 共享窗口，不能再只用 inputTokens 渲染 meter。
    // projection.contextUsed 是 runtime 估算/恢复事实源，只在缺少 usage 时兜底。
    explicitUsed;
  if (size === undefined || size <= 0) {
    return null;
  }
  // Bugfix: ZCode Protocol session.updated 承载的是 projection 事实源；
  // 旧 task UI 只认识 usage_update，必须在迁移桥里把 contextUsed/contextWindow 显式转出来。
  // used=0 只表示初始化或异常兜底，不能渲染成可用的 context meter。
  if (used === undefined || used <= 0) {
    return null;
  }
  return {
    used,
    size,
    cost: null,
    ...(useModelUsageForContext ? optionalContextCacheUsageFromPayload(payload, usage) : {}),
    ...(useModelUsageForContext ? optionalContextUsageBreakdownFromPayload(payload) : {}),
  };
}

// [事务] breakdown 是可选的细分统计，缺失时返回 undefined 而不是空对象，
// 让 UI 能区分「没有细分」与「细分为 0」。
function optionalContextUsageBreakdownFromPayload(
  payload: Record<string, unknown>,
): Pick<ContextUsageUpdate, "breakdown"> {
  const parsed = zcodeContextUsageBreakdownSchema.safeParse(payload.contextUsageBreakdown);
  return parsed.success && parsed.data.length > 0 ? { breakdown: parsed.data } : {};
}

// [事务] 不同 provider 用不同字段表示同一个 token 数（input/output/total），逐个回退直到命中。
// [失败路径] 全部缺失返回 undefined，由调用方决定是否放弃这条 usage。
function contextUsageTokensFromPayload(usage: Record<string, unknown>): number | undefined {
  // [事务] input 侧存在两个历史字段名，先归一再判 0：
  // 0 不是有效值（初始化/异常），必须继续走后面的回退分支。
  const inputTokens = positiveIntegerValue(usage.inputTokens ?? usage.input);
  if (inputTokens !== undefined) {
    // 修复原因：AI SDK v6 已把 Anthropic cache read/write 并入 inputTokens。
    // projection 兼容层只加 output，避免 replayable 恢复时把 cache read 重复计入 context meter。
    return inputTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0);
  }

  const totalTokens = positiveIntegerValue(usage.totalTokens ?? usage.total);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  // [权衡] 只有缓存计数的 provider 用「缓存读写 + output」近似上下文占用：
  // 这是估算，但比直接显示 0% 更接近真实水位。
  const cacheTokens =
    (nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0) +
    (nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0);
  return cacheTokens > 0
    ? cacheTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0)
    : undefined;
}

// [事务] cache 只接受非负整数（INV-45）：负数或 NaN 会让百分比变成 NaN，卡片宽度失效。
function optionalContextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): Pick<ContextUsageUpdate, "cache"> {
  const cache = contextCacheUsageFromPayload(payload, usage);
  return cache ? { cache } : {};
}

// [事务] 只有「模型级完整用量」才代表上下文水位，工具级或增量用量不代表整窗占用。
function shouldUseModelUsageForContext(payload: Record<string, unknown>): boolean {
  const querySource = stringValue(payload.querySource);
  // 修复原因：只有主会话模型请求的 inputTokens 才代表当前可见上下文。
  // 标题、压缩、prompt enhance 等 sidecar 请求即使带 contextWindow，也不能覆盖输入栏 context meter。
  return querySource === undefined || querySource === "main_turn";
}

// [事务] cache 命中率的分子分母必须来自同一次请求，混用不同事件的字段会算出超过 100% 的命中率。
// [失败路径] 分母为 0 或缺失时返回 undefined，UI 隐藏命中率而不是显示 NaN%。
// [权衡] 命中率不做四舍五入，交给 UI 决定精度。
function contextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): ContextUsageUpdate["cache"] {
  // [事务] 聚合 cacheHit 是准事实源：字段齐全且自带命中率，
  // 只有它为空时才回退到逐字段统计，避免两套口径混用。
  const aggregate = asRecord(payload.cacheHit);
  if (Object.keys(aggregate).length > 0) {
    const inputTokens = nonNegativeIntegerValue(aggregate.inputTokens) ?? 0;
    const cacheReadTokens = nonNegativeIntegerValue(aggregate.cacheReadTokens) ?? 0;
    const cacheWriteTokens = nonNegativeIntegerValue(aggregate.cacheWriteTokens) ?? 0;
    const latestHitRate = numberValue(aggregate.latestHitRate);
    const hitRate = numberValue(aggregate.hitRate);
    const hitRateRequestCount = nonNegativeIntegerValue(aggregate.hitRateRequestCount);
    const totalInputTokens = nonNegativeIntegerValue(aggregate.totalInputTokens);
    const totalCacheReadTokens = nonNegativeIntegerValue(aggregate.totalCacheReadTokens);
    const totalCacheWriteTokens = nonNegativeIntegerValue(aggregate.totalCacheWriteTokens);
    return {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(latestHitRate !== undefined ? { latestHitRate: Math.max(0, latestHitRate) } : {}),
      ...(hitRateRequestCount !== undefined ? { hitRateRequestCount } : {}),
      ...(totalInputTokens !== undefined ? { totalInputTokens } : {}),
      ...(totalCacheReadTokens !== undefined ? { totalCacheReadTokens } : {}),
      ...(totalCacheWriteTokens !== undefined ? { totalCacheWriteTokens } : {}),
      hitRate: hitRate !== undefined ? Math.max(0, hitRate) : null,
    };
  }

  const hasCacheRead = "cachedReadTokens" in usage || "cacheReadTokens" in usage;
  const hasCacheWrite = "cachedWriteTokens" in usage || "cacheWriteTokens" in usage;
  const hasHitRate = "cacheHitRate" in usage || "hitRate" in usage;
  if (!hasCacheRead && !hasCacheWrite && !hasHitRate) {
    return undefined;
  }
  const inputTokens = nonNegativeIntegerValue(usage.inputTokens ?? usage.input) ?? 0;
  const cacheReadTokens =
    nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0;
  const cacheWriteTokens =
    nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0;
  const explicitHitRate = numberValue(usage.cacheHitRate ?? usage.hitRate);
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    latestHitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
    // 修复原因：context usage 的缓存命中率是 agent/app 协议字段；
    // projection 兼容层只做一次归一化，避免 UI 组件各自重复推导。
    hitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
  };
}

// [事务] 只拼接 text part，忽略 thinking 与工具：标题与摘要不应包含模型的内部推理。
function textFromParts(parts: readonly ZCodeMessagePart[]): string {
  return textFromZCodeMessageParts(parts);
}

// [权衡] 推理文本只在存在时返回，空串归一为 undefined，让 UI 用「有无」判断是否渲染折叠区。
function reasoningFromParts(parts: readonly ZCodeMessagePart[]): string | undefined {
  // [资源] 先过滤再拼接：直接遍历全部 part 会为每个非推理 part 分配中间数组，
  // 长消息在渲染路径上会放大这个开销。
  const text = parts
    .filter(
      (part): part is Extract<ZCodeMessagePart, { type: "reasoning" }> => part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

// [事务] 标题的三级回退：会话标题 → 首条用户文本 → 占位文案（INV-47）。
// [失败路径] 绝不返回空串：侧栏会用空字符串渲染出一个看不见的条目，用户以为会话丢了。
function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

// [事务] V4 模式 → 旧 UI 模式的反向收敛；未命中的模式回退 build，这是最安全的只读展示值。
function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

// [事务] 选项对象每次新建：它只被放进 configOptions，生命周期短，缓存反而需要处理失效。
function getZCodeAgentModeSelectOptions(): NonNullable<ZCodeConfigOption["options"]> {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

// [事务] 返回浅拷贝：调用方（如 mode_update 事件）可能修改数组，共享同一引用会让下一次读取被污染。
function getZCodeAgentAvailableModes(): ZCodeTaskModeInfo[] {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({ ...mode }));
}

// [事务] 目标对象需要把 status 归一为已知联合值（INV-48），否则 UI 的样式映射取不到分支。
// [失败路径] 迭代号缺失时补 0，保证进度条可渲染。
function fromZCodeGoal(goal: unknown): ZCodeTaskGoal {
  const record = asRecord(goal);
  // [事务] 时间字段同时兼容 time.created 与 createdAt：旧目标对象没有 time 容器，
  // 只读一种会让历史目标的时间线回落到 1970。
  const time = asRecord(record.time);
  // [事务] status 必须先取出再收窄：直接内联 read+guard 会让「未知状态」
  // 与「状态缺失」落到同一分支，前者应该降级而后者应是空值。
  const status = stringValue(record.status);
  return {
    sessionID: stringValue(record.sessionID) ?? stringValue(record.sessionId) ?? "",
    targetID: stringValue(record.targetID) ?? stringValue(record.targetId) ?? "",
    objective: stringValue(record.objective) ?? "",
    summaryTitle: stringValue(record.summaryTitle) ?? null,
    status: isZCodeTaskGoalStatus(status) ? status : "active",
    tokenBudget: typeof record.tokenBudget === "number" ? record.tokenBudget : null,
    tokensUsed: numberValue(record.tokensUsed) ?? 0,
    timeUsedSeconds: numberValue(record.timeUsedSeconds) ?? 0,
    activeInputId: stringValue(record.activeInputId) ?? null,
    activeRunStartedAtMs: numberValue(record.activeRunStartedAtMs) ?? null,
    activeRunLastSeenAtMs: numberValue(record.activeRunLastSeenAtMs) ?? null,
    time: {
      created: numberValue(time.created) ?? numberValue(record.createdAt) ?? 0,
      updated: numberValue(time.updated) ?? numberValue(record.updatedAt) ?? 0,
    },
  };
}

// [事务] 这个守卫是目标状态唯一白名单；新增状态必须同时改这里与 UI 样式表。
function isZCodeTaskGoalStatus(status: string | undefined): status is ZCodeTaskGoal["status"] {
  return (
    status === "active" ||
    status === "paused" ||
    status === "budget_limited" ||
    status === "complete"
  );
}

// [事务] 用量结构有三套命名（input/output、prompt/completion、total），逐项归一成 UI 统一形状。
// [失败路径] 全部缺失返回 undefined，调用方保持上一次展示值。
function usageFromPayload(value: unknown): ZCodeUsage | undefined {
  const usage = asRecord(value);
  // [失败路径] 空对象视为「没有用量」：返回全零对象会让 UI 把这一步的
  // 费用与用量清零，看起来像是一次回退。
  if (Object.keys(usage).length === 0) {
    return undefined;
  }
  const inputTokens = numberValue(usage.inputTokens ?? usage.input) ?? 0;
  const outputTokens = numberValue(usage.outputTokens ?? usage.output) ?? 0;
  // [事务] reasoning token 单列而不叠加进 output：部分 provider 已把它计入 output，
  // 再加一次会让费用虚高。
  const reasoningTokens = numberValue(usage.reasoningTokens ?? usage.reasoning);
  const cachedInputTokens = numberValue(usage.cachedReadTokens ?? usage.cacheReadTokens);
  const cachedWriteInputTokens = numberValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens);
  // [权衡] input 缺失但 cache 有值时用缓存读写之和顶替：部分 provider 只上报缓存计数，
  // 直接记 0 会让用量统计凭空少一大截。
  const inputSideTokens =
    inputTokens > 0 ? inputTokens : (cachedInputTokens ?? 0) + (cachedWriteInputTokens ?? 0);
  // [事务] total 优先用协议给的值：它可能包含 reasoning 等未单列的 token，
  // 用 input+output 重算会与账单对不上。
  const totalTokens =
    numberValue(usage.totalTokens ?? usage.total) ?? inputSideTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens,
  };
}

// [事务] 活动 inputId 的读入口（INV-03/04）：事件不带 inputId 时用它补齐，
// 保证同一轮的所有增量共享同一个 trace。
function getActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
): InputId | undefined {
  return state?.activePromptInputIdBySession?.get(sessionId);
}

// [事务] 新的 inputId 到达即覆盖旧值：这是「新的一轮开始」的信号。
// [资源] 覆盖而不是追加，保证这张表的大小等于会话数，不随轮次增长。
function setActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  inputId: InputId,
): void {
  if (!state) {
    return;
  }
  const map = state.activePromptInputIdBySession ?? new Map<string, InputId>();
  map.set(sessionId, inputId);
  state.activePromptInputIdBySession = map;
}

// [事务] 只在 turn.completed/turn.failed 时清理（INV-04）：清理早了会让本轮尾部事件丢失归属，
// 清理晚了会让下一轮的无 inputId 事件错误续到上一轮。
function clearActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  inputId: InputId,
): void {
  if (state?.activePromptInputIdBySession?.get(sessionId) === inputId) {
    state.activePromptInputIdBySession.delete(sessionId);
  }
}

// [事务] rewind 的控制输入没有可展示内容，必须记住它的 turnKey，等 turn.completed 时抑制补写（INV-27）。
// [资源] 记录随 turn 结束删除（INV-49）：不删会让重放的同一 turn 被永久当作控制轮。
function rememberRewindControlTurn(
  state: ZCodeSessionEventProjectionState | undefined,
  turnKey: string,
  input: string | undefined,
): void {
  if (!state) {
    return;
  }
  const rewindControlTurnKeys = state.rewindControlTurnKeys ?? new Set<string>();
  // 修复原因：编辑/重试会通过内部 `/rewind conversation <messageId>` 控制命令回滚上下文。
  // 该命令的 TurnComplete.response 只是协议 ACK，不是 assistant 回复；不能合成聊天气泡。
  if (isConversationRewindControlInput(input)) {
    rewindControlTurnKeys.add(turnKey);
  } else {
    rewindControlTurnKeys.delete(turnKey);
  }
  state.rewindControlTurnKeys = rewindControlTurnKeys;
}

// [权衡] 用固定文本匹配而不是结构化标记：该输入由 CLI 内部生成，协议里没有额外字段可用。
function isConversationRewindControlInput(input: string | undefined): boolean {
  const normalized = input?.trim();
  if (!normalized?.startsWith("/rewind ")) {
    return false;
  }
  const [scope, target, ...rest] = normalized.slice("/rewind ".length).trim().split(/\s+/);
  return (
    rest.length === 0 &&
    Boolean(target) &&
    (scope === "conversation" || scope === "message" || scope === "both")
  );
}

// [事务] 所有 payload 读取的第一道闸（INV-36）：非对象一律归一为空对象，杜绝 TypeError。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// [事务] 空串视为缺失：协议里空串常表示「未设置」，透传会让 UI 用空值覆盖已有内容。
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// [事务] 校验状态 → timeline 状态的映射只在这里定义，snapshot 与 event 两条路径共用（INV-01）。
// [失败路径] 未知状态映射为 undefined，而不是猜一个，避免显示错误的绿/红分割线。
function goalVerificationTimelineStatusValue(
  value: unknown,
): ZCodeGoalVerificationTimelineMeta["status"] | undefined {
  return value === "started" ||
    value === "completed" ||
    value === "failed_closed" ||
    value === "cancelled"
    ? value
    : undefined;
}

// [事务] 从任意对象重建校验记录：字段名兼容两种命名，缺失的身份字段直接判定为不可用。
// [失败路径] targetId 与 iteration 必须同时存在，否则返回 null（INV-11）。
function goalVerificationFromRecord(record: Record<string, unknown>): ZCodeGoalVerification | null {
  const reason = stringValue(record.reason)?.trim();
  if (!reason) {
    return null;
  }
  const nextAction = stringValue(record.nextAction)?.trim();
  return {
    ...(nextAction ? { nextAction } : {}),
    passed: record.passed === true,
    reason,
  };
}

// [事务] 工具名比较统一走这里，避免各处硬编码大小写不一致（INV-09 的实现点之一）。
function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === ASK_USER_QUESTION_TOOL_NAME;
}

// [事务] ExitPlanMode 同样属于「permission 只做等待态」的集合，必须与问答通道互斥。
function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === EXIT_PLAN_MODE_TOOL_NAME;
}

// [事务] 这是 INV-09/20 的唯一判据：命中即表示该 permission 不应投影成权限卡，
// 而是由 elicitation 通道用 user-input 的语义呈现。
// [失败路径] 新增此类工具时必须加进这里，否则用户会看到无法回答的权限卡。
function isUserInputBackedPermissionToolName(value: string | undefined): boolean {
  return isAskUserQuestionToolName(value) || isExitPlanModeToolName(value);
}

// [事务] 只接受有限数字：NaN/Infinity 一旦进入进度计算就会污染整块 UI。
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// [事务] 向下取整并夹紧到 0（INV-45）：token 计数不接受小数与负数。
function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// [事务] 上下文窗口等分母必须为正：0 会让百分比变成 Infinity，进而让样式宽度非法。
function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// [事务] 只接受真正的布尔值，不做 truthy 转换：字符串 "false" 不应被当成 true。
function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// [事务] timeline 状态白名单：未知值返回 undefined，让调用方选择不显示而不是显示一个错误状态。
function timelineStatusValue(value: unknown): ZCodeTimelineStatus | undefined {
  return value === "started" ||
    value === "retrying" ||
    value === "skipped" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : undefined;
}

// [事务] trigger 决定分割线的文案（自动/手动），未知值降级为 undefined 后由 UI 取默认文案。
function timelineTriggerValue(value: unknown): ZCodeTimelineTrigger | undefined {
  return value === "manual" ||
    value === "auto" ||
    value === "reactive" ||
    value === "partial" ||
    value === "session_memory"
    ? value
    : undefined;
}

// [事务] 压缩阶段映射到 UI 的 timeline 阶段；不在白名单内的值一律丢弃（INV-30 的输入侧防护）。
function compactionPhaseValue(value: unknown): ZCodeContextCompactionTimelinePhase | undefined {
  return value === "standalone_turn" ||
    value === "pre_request" ||
    value === "mid_turn" ||
    value === "reactive"
    ? value
    : undefined;
}

// [事务] 只保留字符串项并丢弃其余类型：UI 用这些字符串做 key，非字符串会导致 React key 重复。
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// [事务] 转向来源决定消息是谁触发的（用户/系统），未知值降级为 undefined 由 UI 兜底。
function turnSteerSourceValue(value: unknown): ZCodeTurnSteerSource | undefined {
  return value === "plan_approval_feedback" || value === "workflow_refine_feedback"
    ? value
    : undefined;
}

// [事务] 命令种类只有白名单内的值才会被渲染成可操作项，其余按普通文本处理。
function turnSteerCommandKindValue(value: unknown): ZCodeTurnSteerCommandKind | undefined {
  return value === "sendGoalCommand" || value === "sendText" || value === "compact"
    ? value
    : undefined;
}
