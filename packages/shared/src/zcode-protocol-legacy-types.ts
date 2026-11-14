/* oxlint-disable eslint(max-lines) -- re-home 产物：旧协议消息/会话承重类型集中迁移，保持单文件契约面。 */
// re-home 迁移产物（为删除旧协议树铺路）。
// 本文件承载旧 ZCode Protocol 中仍被存活栈（validation/background-task-notifications/
// v4 投影等）消费的承重类型与 schema：ZCodeSessionInfo / ZCodeMessageWithParts /
// ZCodePermissionResponse / ZCodeInteractionRequestOrigin 及其依赖闭包。
// 旧协议死亡（zcode-protocol/index.ts 删除）后，这是该协议面的唯一幸存面。

// [契约] 职责边界：本文件是旧 ZCode Protocol 的「承重类型幸存面」，只收容仍被存活栈
// （validation、background-task-notifications、v4 投影等）消费的 schema 与类型；
// 它不发请求、不读写存储、不做消息聚合，也不属于新的 zcode-protocol 契约面。
// [契约] 上游来源是已删除的 zcode-protocol 树，这里是它的唯一替身：改名、改形、
// 删字段之前必须全仓搜引用，并同步 CLI contracts 与 v4 mapper，不许「顺手清理」。
// [权衡] 保留 legacy 命名的代价是名字难看、字段看起来冗余；收益是已落盘的历史
// session / message 快照仍能被同一份 strict schema 解析，不必补迁移脚本。
// [失败路径] 为整洁删掉一个「看似没用」的可选字段，历史快照会判未知键或缺失必填，
// 线上表现是老会话打不开、消息列表整段空白，且不能靠重启或重连自愈。
//
// INV-01 断言：本文件只声明 schema、类型与纯判定函数，不得出现 IO、时钟读取或全局状态 —— 守住它的位置：任何新增 export 前的评审 —— 改错故障：同一份协议在不同进程读到不同的「当前时间」，快照不可复现。
// INV-02 断言：每个对象 schema 在收尾处保持 strict，未知键只允许落在 metadata、structured 这类显式放宽字段 —— 守住它的位置：每处对象声明末尾 —— 改错故障：新增字段让老快照整条解析失败，会话恢复直接中断。
// INV-03 断言：历史快照必须能被现网 schema 原样解析，字段只能删「从未落盘」的 —— 守住它的位置：任何字段删除前的基线比对 —— 改错故障：老会话打不开、消息列表整段空白。
// INV-04 断言：可选字段的缺失语义必须显式表达为未知或不适用，不得用默认值伪造事实 —— 守住它的位置：每个可选字段声明旁 —— 改错故障：面板把「未知模型」显示成当前默认模型，展示与事实不符。
// INV-05 断言：字面量联合的每个值都要在消费侧有对应分支，新增值必须同步穷尽 switch —— 守住它的位置：每个 enum 与判别联合的分支表 —— 改错故障：新值落进默认分支被静默丢弃，或按拒绝兜底。
// INV-06 断言：合成消息来源词表必须与 CLI contracts 的 SYNTHETIC_USER_MESSAGE_SOURCES 逐字一致 —— 守住它的位置：新增 source 值处 —— 改错故障：v3 mapper 收窄类型时编译失败，或合成消息被判为非法来源。
// INV-07 断言：workspacePath 负责路径与展示，workspaceIdentity 负责身份，索引键统一取身份优先、路径兜底 —— 守住它的位置：任何建键与去重处 —— 改错故障：远程与本地同路径的两个工作区互相串台。
// INV-08 断言：sessionKind 中 fork 与 workflow_parent 是独立任务，不得沿 parentSessionId 改写项目归属 —— 守住它的位置：归属与隐藏索引判定 —— 改错故障：独立任务被隐藏，或被迫挪进父项目。
// INV-09 断言：只读集合只包含 Agent 与工作流驱动的子会话，selection_side_chat 不在其内 —— 守住它的位置：isReadonlyAgentSessionKind 的集合 —— 改错故障：辅助对话被误设只读，用户无法继续输入。
// INV-10 断言：目标的 summaryTitle 必须可空且默认 null，tokenBudget 的 null 表示不限预算 —— 守住它的位置：目标 schema 的两个字段 —— 改错故障：历史目标恢复失败，或「不限预算」被当成「预算耗尽」。
// INV-11 断言：deliveryKind 的两个值分别对应桌面连续流与手机可回放流，不可合并成一个值 —— 守住它的位置：新增链路语义时 —— 改错故障：重连后出现重复消息或增量缺口。
// INV-12 断言：权限决策四值与 broker 映射一一对应，未知值只能按 deny 兜底 —— 守住它的位置：决策枚举与应答映射表 —— 改错故障：用户点了允许仍被拒，审批看起来失效。
// INV-13 断言：权限应答里只有 decision 必填，permissionUpdates 与 modifiedInput 可以同时缺失 —— 守住它的位置：权限应答 schema —— 改错故障：只回 decision 的历史应答被判缺失，审批流卡在等待态。
// INV-14 断言：工具状态的必填字段随 status 变化，不得为整齐给 pending 补 startedAt —— 守住它的位置：四态分支各自收尾 —— 改错故障：耗时统计把排队时间算进执行时长。
// INV-15 断言：part 数组顺序即渲染顺序，读取路径不得排序、去重或重排 —— 守住它的位置：带 parts 的消息的消费方 —— 改错故障：历史对话里工具卡片与文本段位置错乱。
// INV-16 断言：eventSeq 与 stateRevision 单调不减，是断线重连唯一的对账依据 —— 守住它的位置：runtime 状态写入 —— 改错故障：重连后状态漂移，客户端把旧快照当成最新状态。
//
// [契约] 阅读顺序：常量与词表、会话、消息、part 联合、runtime 状态；
// 正文注释块按同一顺序打标，便于与旧协议树逐段对照。
//
import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

// [契约] 三个本地基础 schema 是全文的原子口径：空串按非法处理，JSON 对象只约束外层形态，时间戳只接受非负整数毫秒。
// [权衡] 不把它们抽到公共文件，是因为它们必须跟随本文件的 legacy 语义；一旦被新协议复用，trim 与最小长度会反过来约束新写入。
// [失败路径] 把 nonEmptyString 换成普通字符串，空的 messageId、sessionId 会通过校验并污染索引键。
const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const timestampMsSchema = z.number().int().nonnegative();
// [契约] deliveryKind 只区分桌面连续链路与手机可回放链路，两个值分别对应 Desktop 实时流与 web 远控恢复流。
// [权衡] 该字段在 runtime 状态里可选：旧快照没有它，按 desktop-continuous 解释；改成必填会让历史桌面快照立刻解析失败。
// [失败路径] 把两个值合并成一个流语义，恢复链路会拿到连续流的增量口径，重连后出现重复消息或缺口。
export const zcodeDeliveryKindSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);
export const zcodeMessageVisibilitySchema = z.enum(["user-visible", "model-only"]);
// [契约] 合成消息来源词表必须与 CLI contracts 逐字一致，app 与 agent 共用同一份承重消息 schema 才能互认来源。
// [权衡] 保留 agent_listing_delta 等当前链路少用的历史项，是因为已落盘的合成消息仍带着这些来源，删项即判非法。
// [失败路径] 少一个 subagent_message，子代理回复会被判为未知来源，v3 mapper 收窄类型时编译失败。
export const zcodeSyntheticUserMessageSourceSchema = z.enum([
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
  // child 回复会作为 model-only synthetic user message 持久化；
  // app/agent 共用的承重消息 schema 必须与 CLI contracts 使用同一来源词表。
  "subagent_message",
  "todo_reminder",
  // 中枢直接启动工作流的启动轮 source；与 contracts 的
  // SYNTHETIC_USER_MESSAGE_SOURCES 保持同一词表，否则 v3 mapper 收窄该 source 会 tsc 失败。
  "workflow_launch",
  "shared_context",
]);
// [契约] workspacePath 负责文件操作与展示，workspaceIdentity 负责身份隔离，workspaceKey 是二者归一后的索引键，三者语义不同不可互换。
// [权衡] workspaceIdentity 与 remoteSessionId 可选，因为本地老会话从未写入过这两项；缺失时身份键回退到 trim 后的路径。
// [失败路径] 只按路径建键，远程与本地同路径的两个工作区会共用索引，任务与会话互相串台。
export const zcodeWorkspaceRefSchema = z
  .object({
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
  })
  .strict();
// [契约] 权限决策四值固定：allow 放行、deny 拒绝、escalate 上交上层审批、modify 携带改写后的入参继续。
// [权衡] modify 与 permissionUpdates 并存，是因为改写入参与持久化规则是两件事；把规则塞进 decision 会让历史应答失去可读性。
// [失败路径] 新增第五个决策值而不更新 broker 映射，界面会拿到未知决策并按 deny 兜底，表现为「点了允许仍被拒」。
export const zcodePermissionDecisionSchema = z.enum(["allow", "deny", "escalate", "modify"]);
export const zcodePermissionRuleBehaviorSchema = z.enum(["allow", "deny", "ask"]);
/** Backward-compatible wire/storage key interpreted only for trusted official CUA tools. */
export const OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME = "zcode:permission-capability:official_cua";
/**
 * workflow 运行确认窗第三选项「Refine」（拒绝并附修改意见）的稳定 optionId。
 * CLI 侧 v4 投影合成选项、broker 应答映射与 GUI 特判共用同一常量；
 * 该选项只在 v4 链路投放。
 */
export const WORKFLOW_REFINE_PERMISSION_OPTION_ID = "workflowRefine";
// [契约] 规则值只由 toolName 与可选 ruleContent 组成，ruleContent 留空表示工具级全量规则，而不是「无规则」。
// [权衡] ruleContent 保持可选，是为了兼容只按工具名授权的旧条目；改成必填会让老配置文件里的规则全部失效。
// [失败路径] 把 ruleContent 的缺省语义解释成精确匹配空串，工具级规则会退化成永不命中的死规则。
export const zcodePermissionRuleValueSchema = z
  .object({
    toolName: nonEmptyString,
    ruleContent: z.string().optional(),
  })
  .strict();
// [契约] 权限更新当前只有 addRules 一个分支，且 rules 至少一条；这是旧协议唯一被真实消费过的形态。
// [权衡] 用字面量而非开放枚举，是为了让新分支必须显式改动本文件；隐式放宽会让未知 type 静默通过。
// [失败路径] 去掉 rules 的最小长度约束，空更新会被当作有效应答落库，broker 侧再报错时已无法回滚。
export const zcodePermissionUpdateSchema = z
  .object({
    type: z.literal("addRules"),
    behavior: zcodePermissionRuleBehaviorSchema,
    rules: z.array(zcodePermissionRuleValueSchema).min(1),
  })
  .strict();
// [契约] 权限应答只有 decision 必填，reason、modifiedInput、permissionUpdates 全部可选，这是旧协议长期在线的真实形态。
// [权衡] modifiedInput 用 unknown 而非具体对象，因为不同工具的入参形状完全不同；收窄会让未覆盖的工具无法改写参数。
// [失败路径] 把 permissionUpdates 改成必填，只回 decision 的历史应答会被判缺失，审批流卡在等待态。
// [契约] 该 schema 的推断结果即 ZCodePermissionResponse，手写一份同形接口会与运行时校验缓慢分叉。
export const zcodePermissionResponseSchema = z
  .object({
    decision: zcodePermissionDecisionSchema,
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    permissionUpdates: z.array(zcodePermissionUpdateSchema).optional(),
  })
  .strict();
export type ZCodePermissionResponse = z.infer<typeof zcodePermissionResponseSchema>;
// [契约] 会话模式六值是与界面模式选择器、CLI 权限预设共享的稳定词表，新增值必须同时在两侧登记。
// [权衡] 保留 yolo 与 guarded 这类带策略含义的旧名，比改成布尔开关更能表达「谁在批准工具调用」。
// [失败路径] 旧模式改名后，历史会话的 mode 变成非法值，会话列表整体校验失败而无法展示。
export const zcodeSessionModeSchema = z.enum(["plan", "build", "edit", "yolo", "guarded", "auto"]);
export const zcodeSessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "paused",
  "completed",
  "error",
]);
// [契约] sessionKind 登记七种会话形态，其中 fork 与 workflow_parent 是独立任务，即使带 parentSessionId 也不能沿父链改写项目归属。
// [权衡] 子会话细分为 workflow_child、subagent_child、nested_workflow_child，是为了让只读判定与隐藏索引规则各取所需。
// [失败路径] 丢掉 nested_workflow_child，嵌套工作流的子会话会被当成普通子会话，只读与归属同时判错。
export const zcodeSessionKindSchema = z.enum([
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
]);
// 修复原因：只识别 subagent_child 会漏掉工作流与辅助对话的父归属、隐藏索引规则。
// fork 和 workflow_parent 是独立任务，即使有 parentSessionId 也不能沿父链改写项目。
// [契约] 辅助会话等于只读 Agent 子会话加上 selection_side_chat，前者对用户只读，后者仍可继续输入。
// [权衡] 入参放宽为字符串或 undefined 而不收窄成枚举，因为调用方常拿到历史快照里的自由字符串；undefined 一律返回 false。
// [失败路径] 把 fork 算进辅助会话，独立任务会被隐藏索引并从项目侧栏消失。
// [契约] 本函数是纯判定、不读全局，改动必须同时核对只读集合，两个集合不能互相包含。
export function isAuxiliarySessionKind(kind: string | undefined): boolean {
  return isReadonlyAgentSessionKind(kind) || kind === "selection_side_chat";
}

// 辅助对话可继续输入；只有由 Agent / 工作流驱动的子会话对用户只读。
export function isReadonlyAgentSessionKind(kind: string | undefined): boolean {
  return kind === "subagent_child" || kind === "workflow_child" || kind === "nested_workflow_child";
}

// [契约] 会话目标的 summaryTitle 用可空加默认 null 兜底：旧版持久化目标没有该字段，读取时补 null 而不是报错。
// [权衡] tokenBudget 允许 null 表示不限预算，tokensUsed 与 timeUsedSeconds 必须非负；把 null 改成 0 会让「不限」变成「已用尽」。
// [失败路径] 去掉默认 null，历史目标快照恢复时会因缺失字段整条失败，用户看到目标进度归零。
// [契约] activeInputId 与两个 activeRun 时间戳可空且可选，表示当前没有在途输入或运行；三者要么同现、要么同缺。
export const zcodeSessionGoalSchema = z
  .object({
    sessionId: nonEmptyString,
    targetId: nonEmptyString,
    objective: nonEmptyString,
    // 旧版持久化 session target 不包含 summaryTitle。
    // 协议读取历史 snapshot 时补 null，避免老会话恢复失败。
    summaryTitle: z.string().min(1).nullable().default(null),
    status: z.enum(["active", "paused", "budget_limited", "complete"]),
    tokenBudget: z.number().int().positive().nullable(),
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative(),
    activeInputId: nonEmptyString.nullable().optional(),
    activeRunStartedAtMs: timestampMsSchema.nullable().optional(),
    activeRunLastSeenAtMs: timestampMsSchema.nullable().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
  })
  .strict();
export const zcodeSessionGoalVerificationSchema = z
  .object({
    nextAction: z.string().nullable().optional(),
    passed: z.boolean(),
    reason: z.string(),
  })
  .strict();
// [契约] 该时间线项是合成消息，version、kind、type、display 四个字面量固定，用于渲染分隔条而不是正文。
// [权衡] updatedAt 必填而 startedAt 可选，因为历史项只保证最后一次更新时间；补成必填会让旧项无法回放。
// [失败路径] 允许 status 出现词表外的值，前端分隔条拿不到样式分支，时间线出现空白行。
export const zcodeSessionGoalVerificationTimelineSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("synthetic"),
    type: z.literal("goal_verification"),
    display: z.literal("separator"),
    targetId: nonEmptyString,
    verificationId: nonEmptyString,
    status: z.enum(["started", "completed", "failed_closed", "cancelled"]),
    verification: zcodeSessionGoalVerificationSchema.optional(),
    goalIteration: z.number().int().positive().optional(),
    anchorAssistantMessageId: nonEmptyString.optional(),
    anchorTurnId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema,
  })
  .strict();
// [契约] sessionInfo 是会话列表与恢复的承重结构，sessionId、workspace、sessionKind、mode、status、createdAt、updatedAt 缺一不可。
// [权衡] parentSessionId、traceId、titleSource、model、target 全部可选，因为不同来源写入的会话字段并不一致；收紧会打断历史会话。
// [失败路径] 把 model 改成必填，未绑定模型的旧会话整条解析失败，侧栏会话列表直接空掉。
// [契约] 该 schema 的推断类型即 ZCodeSessionInfo，供校验与 v4 投影共用，不允许另写一份同形接口。
export const zcodeSessionInfoSchema = z
  .object({
    sessionId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    traceId: nonEmptyString.optional(),
    sessionKind: zcodeSessionKindSchema,
    title: z.string(),
    titleSource: z.enum(["default", "first_input", "generated", "custom"]).optional(),
    mode: zcodeSessionModeSchema,
    status: zcodeSessionStatusSchema,
    model: modelSelectionSchema.optional(),
    target: zcodeSessionGoalSchema.nullable().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
  })
  .strict();
export type ZCodeSessionInfo = z.infer<typeof zcodeSessionInfoSchema>;
// [契约] 交互请求来源只描述子代理：kind 恒为 subagent，agentId、agentType、childSessionId、parentSessionId 必填。
// [权衡] childTurnId、parentToolCallId、parentTurnId 可选，因为子会话的首个请求可能还没有轮次或工具调用上下文。
// [失败路径] 把 parentToolCallId 改成必填，父工具刚发起子代理时的首个交互请求会被判非法，审批弹窗不出现。
export const zcodeInteractionRequestOriginSchema = z
  .object({
    kind: z.literal("subagent"),
    agentId: nonEmptyString,
    agentType: nonEmptyString,
    childSessionId: nonEmptyString,
    childTurnId: nonEmptyString.optional(),
    description: z.string().optional(),
    parentSessionId: nonEmptyString,
    parentToolCallId: nonEmptyString.optional(),
    parentTurnId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeInteractionRequestOrigin = z.infer<typeof zcodeInteractionRequestOriginSchema>;
// [契约] 消息时间只有 created 必填、completed 可选：completed 缺失即表示该消息仍在生成或未收尾。
// [失败路径] 很多消费方靠 completed 是否缺失判断流式状态，给它补默认值会让流式消息被误判为已完成。
const messageTimeSchema = z
  .object({
    created: timestampMsSchema,
    completed: timestampMsSchema.optional(),
  })
  .strict();
// [契约] token 用量的 input、output、reasoning 与 cache 内的读、写计数全部必填，只有 total 可选。
// [权衡] total 可选是因为旧记录只落分项、由消费方自行求和；补成必填会让历史用量记录无法读取。
// [失败路径] 把 reasoning 改成可选，成本统计会把推理 token 当成 0，账单与面板长期对不上。
export const zcodeTokenUsageSchema = z
  .object({
    total: z.number().int().nonnegative().optional(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    cache: z
      .object({
        read: z.number().int().nonnegative(),
        write: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
// [契约] 语义用 origin 与 kind 两个正交维度描述消息：origin 说谁产生，kind 说它在时间线里扮演什么角色。
// [权衡] source 与 commandName 保持自由字符串，因为斜杠命令与迁移来源的命名由外部决定；收窄成枚举会挡住新命令。
// [失败路径] 三种可见性若取同一套枚举，界面可见性的 debug 档会被当成 hidden，调试消息彻底消失。
export const zcodeMessageSemanticsSchema = z
  .object({
    origin: z.enum(["real_user", "agent_runtime", "system", "migration", "import"]),
    kind: z.enum([
      "user_prompt",
      "slash_command",
      "system_reminder",
      "background_notification",
      "subagent_notification",
      "todo_reminder",
      "rewind_notice",
      "fork_notice",
      "timeline_event",
      "compact_summary",
      "shared_context",
      "assistant_response",
    ]),
    source: z.string().optional(),
    commandName: z.string().optional(),
    uiVisibility: z.enum(["visible", "hidden", "debug"]),
    providerVisibility: z.enum(["visible", "hidden"]),
    transcriptVisibility: z.enum(["visible", "hidden"]),
  })
  .strict();
// [契约] 用户消息的 role 固定为 user，messageId、sessionId、time、agent 必填，agent 表示产生该轮的执行体。
// [权衡] model 可选且缺失时不借用默认模型补写：旧消息或未绑定会话的合成消息本就没有模型信息，补写等于伪造事实。
// [失败路径] 给 model 加默认值，历史用户消息会显示成「用了当前默认模型」，与当时的实际执行体不符。
// [契约] synthetic、source、visibility 是可选的合成标记组合，只有 synthetic 为真时才会出现 source；缺失按真实用户消息处理。
export const zcodeUserMessageInfoSchema = z
  .object({
    messageId: nonEmptyString,
    sessionId: nonEmptyString,
    role: z.literal("user"),
    time: messageTimeSchema,
    agent: nonEmptyString,
    // 旧消息或未绑定会话的合成消息可能没有请求来源；不借默认模型补写。
    model: modelSelectionSchema.optional(),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    synthetic: z.boolean().optional(),
    source: zcodeSyntheticUserMessageSourceSchema.optional(),
    visibility: zcodeMessageVisibilitySchema.optional(),
    semantics: zcodeMessageSemanticsSchema.optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict();
// [契约] 助手消息的 parentMessageId、path 下的 cwd 与 root、cost、tokens 必填，缺一项就无法还原该轮目录与成本。
// [权衡] model、finish、error、semantics、structured 可选；error 只在失败轮出现，structured 的形状由调用方决定。
// [失败路径] 把 error 改成必填，正常轮次会被迫写空对象，错误面板会误报「有错误但无信息」。
// [契约] finish 保持自由字符串而非枚举，因为结束原因由各 provider 定义，收窄会让新 provider 的停因无法落库。
export const zcodeAssistantMessageInfoSchema = z
  .object({
    messageId: nonEmptyString,
    sessionId: nonEmptyString,
    role: z.literal("assistant"),
    time: messageTimeSchema,
    parentMessageId: nonEmptyString,
    agent: nonEmptyString,
    model: modelSelectionSchema.optional(),
    path: z
      .object({
        cwd: nonEmptyString,
        root: nonEmptyString,
      })
      .strict(),
    cost: z.number().nonnegative(),
    tokens: zcodeTokenUsageSchema,
    finish: z.string().optional(),
    error: jsonObjectSchema.optional(),
    semantics: zcodeMessageSemanticsSchema.optional(),
    structured: z.unknown().optional(),
  })
  .strict();
// [契约] 消息主体按 role 判别为用户与助手两支，判别键必须与两支内部的 role 字面量完全对应。
// [权衡] 用判别联合而非普通联合，是为了让解析失败能指出是哪个 role 分支不匹配；代价是新增角色必须同时改判别键表。
// [失败路径] 未来新增第三个 role 却只加分支不改消费方的穷尽 switch，默认分支会把新消息整条丢弃。
export const zcodeMessageInfoSchema = z.discriminatedUnion("role", [
  zcodeUserMessageInfoSchema,
  zcodeAssistantMessageInfoSchema,
]);
export type ZCodeMessageInfo = z.infer<typeof zcodeMessageInfoSchema>;
// [契约] part 公共底座只含 partId、sessionId、messageId 三个定位键，所有分支都继承它，不允许某分支另建一套定位字段。
// [权衡] 底座故意不收尾为 strict，由各分支扩展后再收尾，避免继承链上重复声明造成的语义歧义。
// [失败路径] 把 partId 从底座挪到各分支，漏改一个分支就会让该类型 part 的 id 变成可选，前端 key 退化为下标。
const partBaseSchema = z.object({
  partId: nonEmptyString,
  sessionId: nonEmptyString,
  messageId: nonEmptyString,
});
// [契约] 工具状态按 status 判别为 pending、running、completed、error 四态，每态的必填字段就是该态已确认的事实。
// [权衡] running 的 title 与 metadata 可选，completed 的 title 与 metadata 必填，这是历史落盘的真实差异，不能为整齐统一。
// [失败路径] 把 error 分支的 metadata 改成必填，失败工具的旧记录会解析失败，错误卡片不再渲染。
// [契约] startedAt 与 completedAt 只在对应阶段出现，不能给 pending 补 startedAt，否则耗时统计会把排队时间算进执行。
export const zcodeToolStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      input: jsonObjectSchema,
      raw: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("running"),
      input: jsonObjectSchema,
      title: z.string().optional(),
      metadata: jsonObjectSchema.optional(),
      startedAt: timestampMsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      input: jsonObjectSchema,
      output: z.string(),
      title: z.string(),
      metadata: jsonObjectSchema,
      startedAt: timestampMsSchema,
      completedAt: timestampMsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      input: jsonObjectSchema,
      error: z.string(),
      metadata: jsonObjectSchema.optional(),
      startedAt: timestampMsSchema,
      completedAt: timestampMsSchema,
    })
    .strict(),
]);
// [契约] 时间线里的模型选择在公共模型选择 schema 上只追加可选 label，其余字段口径必须与主链路一致。
// [失败路径] 另写一份独立模型 schema，时间线展示的 provider 与真实执行模型会分叉，模型切换记录出现错配。
const zcodeTimelineModelSelectionSchema = modelSelectionSchema.extend({
  label: z.string().optional(),
});
const zcodeTimelinePartTimeSchema = z
  .object({
    start: timestampMsSchema.optional(),
    end: timestampMsSchema.optional(),
  })
  .strict();
// [契约] 时间线 part 用 timelineType 区分上下文压缩、目标校验、会话分叉与模型切换四类事件，display 决定渲染成分隔条还是工作日志。
// [权衡] 四类事件的字段并集放在同一个 strict 对象里且大多可选，这是旧协议的真实形状；拆成子联合会改变落盘结构。
// [失败路径] 把 trigger、phase、compactReason 收窄成必填，非压缩类时间线事件会被迫写空值，语义变得不可信。
// [契约] fromModel 与 toModel 只在模型切换事件出现，且目标的 label 收紧为非空串，表示切换目标必须可读。
export const zcodeTimelinePartSchema = partBaseSchema
  .extend({
    type: z.literal("timeline"),
    timelineType: z.enum([
      "context_compaction",
      "goal_verification",
      "session_fork",
      "model_change",
    ]),
    display: z.enum(["separator", "worklog"]),
    status: z.string().optional(),
    anchorMessageId: nonEmptyString.optional(),
    anchorTurnId: nonEmptyString.optional(),
    time: zcodeTimelinePartTimeSchema.optional(),
    operationId: z.string().optional(),
    trigger: z.enum(["manual", "auto", "partial", "reactive", "session_memory"]).optional(),
    phase: z.enum(["standalone_turn", "pre_request", "mid_turn", "reactive"]).optional(),
    compactReason: z.string().optional(),
    boundaryId: z.string().optional(),
    summaryMessageId: nonEmptyString.optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    attempt: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
    targetId: z.string().optional(),
    verificationId: z.string().optional(),
    goalIteration: z.number().int().nonnegative().optional(),
    verification: z
      .object({
        passed: z.boolean(),
        reason: z.string(),
        nextAction: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: z.string().optional(),
    restoredFileCount: z.number().int().nonnegative().optional(),
    fromModel: zcodeTimelineModelSelectionSchema.optional(),
    toModel: zcodeTimelineModelSelectionSchema
      .extend({
        label: nonEmptyString,
      })
      .optional(),
  })
  .strict();
// [契约] part 联合按 type 判别，覆盖文本、推理、文件、工具、步起、步止、快照、补丁、压缩、时间线、子代理、代理、重试共十三支。
// [权衡] 每个分支都扩展公共底座后再 strict，保证未知键报错；代价是新增 part 类型必须同时改这里与前端渲染映射。
// [失败路径] 少登记一支，历史消息里该类型 part 会让整条消息解析失败，表现为正文只剩前后两段。
// [契约] 文本分支的 synthetic 与 ignored 可选，表示该段是否由系统合成、是否被下游忽略；缺失按正常用户可见文本处理。
export const zcodeMessagePartSchema = z.discriminatedUnion("type", [
  partBaseSchema
    .extend({
      type: z.literal("text"),
      text: z.string(),
      synthetic: z.boolean().optional(),
      ignored: z.boolean().optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("reasoning"),
      text: z.string(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("file"),
      mime: nonEmptyString,
      filename: z.string().optional(),
      url: nonEmptyString,
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("tool"),
      callId: nonEmptyString,
      tool: nonEmptyString,
      state: zcodeToolStateSchema,
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  partBaseSchema
    .extend({ type: z.literal("step-start"), snapshot: z.string().optional() })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("step-finish"),
      reason: z.string(),
      snapshot: z.string().optional(),
      cost: z.number().nonnegative(),
      tokens: zcodeTokenUsageSchema,
    })
    .strict(),
  partBaseSchema.extend({ type: z.literal("snapshot"), snapshot: z.string() }).strict(),
  partBaseSchema
    .extend({
      type: z.literal("patch"),
      hash: nonEmptyString,
      files: z.array(z.string()),
    })
    .strict(),
  partBaseSchema
    .extend({
      type: z.literal("compaction"),
      auto: z.boolean(),
      reason: z.string().optional(),
      summaryMessageId: nonEmptyString.optional(),
      metadata: jsonObjectSchema.optional(),
    })
    .strict(),
  // [契约] 时间线分支以整体引用方式并入 part 联合，而不是复制字段，保证时间线只有一份权威定义。
  // [失败路径] 若在此处再写一遍时间线字段，两处会缓慢漂移，同一事件的校验结果随调用路径不同而不同。
  zcodeTimelinePartSchema,
  partBaseSchema
    .extend({
      type: z.literal("subagent"),
      prompt: z.string(),
      description: z.string(),
      agent: nonEmptyString,
      model: modelSelectionSchema.optional(),
      command: z.string().optional(),
    })
    .strict(),
  partBaseSchema.extend({ type: z.literal("agent"), name: nonEmptyString }).strict(),
  partBaseSchema
    .extend({
      type: z.literal("retry"),
      attempt: z.number().int().nonnegative(),
      error: jsonObjectSchema,
    })
    .strict(),
]);
export type ZCodeMessagePart = z.infer<typeof zcodeMessagePartSchema>;
// [契约] 一条消息等于 info 主体加 parts 有序数组，数组顺序就是渲染顺序，读取时不允许重排。
// [权衡] parts 用普通数组而非按类型分组的对象，是为了保留流式追加的原始次序；分组会丢失交错信息。
// [失败路径] 给 parts 加去重或排序，工具卡片与文本段的相对位置会变，历史对话看起来像被重排过。
export const zcodeMessageWithPartsSchema = z
  .object({
    info: zcodeMessageInfoSchema,
    parts: z.array(zcodeMessagePartSchema),
  })
  .strict();
export type ZCodeMessageWithParts = z.infer<typeof zcodeMessageWithPartsSchema>;
// [契约] api_retry 状态记录重试轮次、上限、延迟与错误状态码，kind 恒为字面量 api_retry。
// [失败路径] 把 errorStatus 改成必填，网络层异常（没有 HTTP 状态）的重试会被判非法，重试提示从界面上消失。
export const zcodeSessionApiRetryStatusSchema = z
  .object({
    kind: z.literal("api_retry"),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    retryDelayMs: z.number().int().nonnegative(),
    errorStatus: z.number().int().nonnegative().nullable(),
    error: z.string(),
  })
  .strict();
// [契约] 上下文缓存用量同时给出本轮的输入、缓存读、缓存写与累计总量，hitRate 可为 null 表示样本不足。
// [权衡] 最新命中率、请求计数与三个累计字段可选，是分阶段上线留下的差异；收紧会打断旧 runtime 的写入。
// [失败路径] 把 hitRate 的 null 改成 0，样本不足会被展示成「命中率为零」，用户误以为缓存失效。
export const zcodeSessionContextCacheUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    latestHitRate: z.number().nonnegative().nullable().optional(),
    hitRateRequestCount: z.number().int().nonnegative().optional(),
    totalInputTokens: z.number().int().nonnegative().optional(),
    totalCacheReadTokens: z.number().int().nonnegative().optional(),
    totalCacheWriteTokens: z.number().int().nonnegative().optional(),
    hitRate: z.number().nonnegative().nullable(),
  })
  .strict();
// [契约] 上下文占用来源固定七项：系统提示、元用户上下文、技能、工具提示、系统工具 schema、MCP 工具 schema、消息。
// [权衡] 来源用枚举而非自由标签，是为了让前端能穷尽配色与排序；新增来源必须同时补渲染分支。
// [失败路径] 新增来源而前端未覆盖，占用明细会缺一行，总和与 used 对不上，用户看到无法解释的差额。
export const zcodeContextUsageBreakdownSourceSchema = z.enum([
  "system_prompt",
  "meta_user_context",
  "skills",
  "tool_prompt",
  "system_tool_schemas",
  "mcp_tool_schemas",
  "messages",
]);
export const zcodeContextUsageBreakdownItemSchema = z
  .object({
    source: zcodeContextUsageBreakdownSourceSchema,
    chars: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeContextUsageBreakdownItem = z.infer<typeof zcodeContextUsageBreakdownItemSchema>;
export const zcodeContextUsageBreakdownSchema = z.array(zcodeContextUsageBreakdownItemSchema);
// [契约] 上下文用量以 used 与 size 为核心，size 必须为正；cost、cache、breakdown 都是可选附加信息。
// [权衡] cost 允许整块为 null 或缺失，因为部分 provider 不返回金额；补 0 会把「未知」说成「免费」。
// [失败路径] 把 breakdown 改成必填，旧 runtime 不写明细的会话会解析失败，用量面板整块空白。
export const zcodeSessionContextUsageSchema = z
  .object({
    used: z.number().int().nonnegative(),
    size: z.number().int().positive(),
    cost: z
      .object({
        amount: z.number().nonnegative(),
        currency: nonEmptyString,
      })
      .strict()
      .nullable()
      .optional(),
    cache: zcodeSessionContextCacheUsageSchema.optional(),
    breakdown: zcodeContextUsageBreakdownSchema.optional(),
  })
  .strict();
// [契约] runtime 状态只承载可重放的事件序号与修订号：eventSeq 与 stateRevision 必须单调不减，是断线重连的对账依据。
// [权衡] deliveryKind、activeTurnId、apiRetry、contextUsage、目标校验等全部可选，因为不同链路与阶段写入的字段并不相同。
// [失败路径] 把 pendingRequestIds 改成可选，空列表与「字段缺失」将无法区分，重连后未决审批会被当作不存在。
// [契约] activeTurnKind 只允许 regular、compact、rewind 三值，时间线里的其它事件类型不得混入这里。
export const zcodeSessionRuntimeStateSchema = z
  .object({
    eventSeq: z.number().int().nonnegative(),
    stateRevision: z.number().int().nonnegative(),
    deliveryKind: zcodeDeliveryKindSchema.optional(),
    activeTurnId: nonEmptyString.optional(),
    activeTurnKind: z.enum(["regular", "compact", "rewind"]).optional(),
    pendingRequestIds: z.array(nonEmptyString),
    apiRetry: zcodeSessionApiRetryStatusSchema.nullable().optional(),
    contextUsage: zcodeSessionContextUsageSchema.optional(),
    goalVerifications: z.array(zcodeSessionGoalVerificationSchema).optional(),
    goalVerificationTimeline: z.array(zcodeSessionGoalVerificationTimelineSchema).optional(),
  })
  .strict();
export type ZCodeSessionRuntimeState = z.infer<typeof zcodeSessionRuntimeStateSchema>;
// [契约] 在途轮次类型从 schema 推断再收窄，避免手写字面量联合与运行时校验分叉。
// [失败路径] 手写一份独立的三种轮次，新增第四种轮次时这里不会报错，消费方的穷尽分支静默漏掉。
export type ZCodeSessionActiveTurnKind = NonNullable<ZCodeSessionRuntimeState["activeTurnKind"]>;
// [契约] 该纯函数只拼接文本分段，丢弃推理、工具等其它 part，用于生成搜索与标题所需的纯文本。
// [权衡] 入参声明为只读数组，允许调用方直接传冻结的 parts；函数不修改入参也不缓存结果。
// [失败路径] 把推理内容也拼进来，思考文本会进入标题与搜索索引，用户侧看到本不该暴露的推理内容。
export function textFromZCodeMessageParts(parts: readonly ZCodeMessagePart[]): string {
  return parts
    .filter((part): part is Extract<ZCodeMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}
