// 协议 v4 实时遥测事实的唯一运行时契约：CLI 上报、桌面消费与会话统计共用这一份判别联合。
// 上行链路把每条事件当作不可信输入，先做结构与字段校验，才允许进入存储与聚合。
// 字段设计遵循只带 id 与计数：不承载 prompt、工具入参、文件内容或 provider 原始 URL。
// 兼容性靠可选字段与字面量判别维持：新增维度只增可选键，删键必须先升 version。
// INV-01 事实总表只能经 discriminatedUnion 的 kind 分派；守住位置：conversationTelemetryFactRuntimeSchema；改错故障：未知 kind 被宽松解析，桌面端把陌生事件并入已有分支，会话指标整体错位。
// INV-02 每个分支对象都以 strict 收尾；守住位置：各 FactSchema 的 strict 收尾；改错故障：runtime 新增的 prompt 或工具入参随事件外带，遥测链路泄露用户内容。
// INV-03 基字段 eventId、eventSeq、occurredAt、sessionId 必填且非空；守住位置：factBaseFields；改错故障：缺序号的事件无法排序去重，同一轮在被消费端重复计数。
// INV-04 version 固定字面量 1；守住位置：factBaseFields.version；改错故障：上游协议升级后旧客户端静默接受新版本，字段语义漂移而无人察觉。
// INV-05 eventSeq 必须是整数且非负；守住位置：factBaseFields.eventSeq；改错故障：负序号或小数进入存储，按序回放时事件顺序被写坏。
// INV-06 时间戳只接受 timestampSchema；守住位置：factBaseFields.occurredAt 与压缩事实的起止时间；改错故障：字符串时间被当数字比较，时长算成负数或 NaN。
// INV-07 providerHostname 不得携带 scheme、端口、路径、凭据或片段；守住位置：providerHostnameSchema 的 refine；改错故障：含 token 的地址被原样写入遥测，凭据随埋点外流。
// INV-08 裸主机名必须拒绝空白、斜杠与方括号；守住位置：providerHostnameSchema 的字符类校验；改错故障：带路径的地址混入，按域名聚合的 provider 统计被拆成多条。
// INV-09 IPv6 只接受方括号包裹形式；守住位置：providerHostnameSchema 的正则前置分支；改错故障：未加括号的地址被当作普通主机名，跨平台解析结果不一致。
// INV-10 主机名要求首尾无空白；守住位置：providerHostnameSchema 的 trim 比较；改错故障：带空格的值落库后按域名分组匹配不上，图表出现空条目。
// INV-11 性能事实的毫秒与字节字段一律非负整数；守住位置：toolPerformanceFactSchema；改错故障：负耗时进入百分位计算，P95 被拉低成失真的乐观值。
// INV-12 commandHash 固定 16 位小写十六进制；守住位置：toolPerformanceFactSchema 的 commandHash；改错故障：明文命令或超长哈希混入，既能反推命令又破坏按哈希去重。
// INV-13 commandName 与 commandCategory 有长度上限；守住位置：toolPerformanceFactSchema 的 max 约束；改错故障：超长命令撑爆埋点批次，后续事件被服务端整批拒收。
// INV-14 turn.started 的 automationId 与 offPeakTaskId 互斥；守住位置：superRefine 首条 addIssue；改错故障：同时归属定时任务与低谷任务的轮次被两套计费口径重复统计。
// INV-15 offPeakRunType 必须依附 offPeakTaskId；守住位置：superRefine 第二条 addIssue；改错故障：孤立的 run 类型无法归属任务，低谷调度看板出现无主记录。
// INV-16 workflow.lifecycle 的 actor-spawned 必须带 agentId 与 childSessionId；守住位置：superRefine 的 phase 分支；改错故障：子代理事件缺主体 id，工作流拓扑图丢节点却仍画出边。
// INV-17 workflow.lifecycle 的 run-settled 必须带 status；守住位置：superRefine 的 run-settled 分支；改错故障：结算事件没有终态，run 在统计里永久停留在进行中。
// INV-18 新增遥测维度只能以可选字段追加，且不得收紧既有枚举；守住位置：各 FactSchema 的可选键与 enum 取值；改错故障：旧 CLI 上报的合法事件在新桌面端被整条拒绝，升级窗口期数据断流。
// INV-19 对外类型只做交集扩展，不得改动运行时形状；守住位置：TurnStartedConversationTelemetryFact 与 conversationTelemetryFactSchema 的 transform；改错故障：后台归属字段被写进 strict 成员，旧 CLI 的后台轮次整条丢失。
import { z } from "zod";
import { sanitizeTelemetrySkillName } from "../telemetry.js";
import { zcodeSyntheticUserMessageSourceSchema } from "../zcode-protocol-legacy-types.js";
import { timestampSchema } from "./core.js";

// 基字段四个必填键承担去重、排序与会话归属三项职责，可选键只补充关联，不参与身份判定
// eventId 非空让消费端可以整条去重，重放事件不会被拆成部分合并的半成品
// eventSeq 只在单个会话内有偏序意义，跨会话比较没有语义，消费端不得据此做全局排序
// version 写成字面量而非宽松数字，不兼容升级在解析期即失败，而不是在聚合期产出错值
const factBaseFields = {
  /** 会话创建期采用的 App Memory 开关，不表示记忆读写结果。 */
  memoryEnabled: z.boolean().optional(),
  version: z.literal(1),
  eventId: z.string().min(1),
  eventSeq: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  sessionId: z.string().min(1),
  sourceCommandId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
} as const;

// 主机名字段是脱敏边界：拒绝 scheme、端口、路径、查询、凭据与片段，只留下可聚合的域名
// 白名单式的反例校验比黑名单可靠，任何空白与分隔符都视为调用方拼错了数据
// IPv6 走方括号分支单独放行，否则冒号会被误判成端口分隔而整条事件被拒
// refine 失败时给出人可读原因，CLI 侧据此修正上报，而不必在日志里猜哪一段越界
const providerHostnameSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      /^\[[0-9a-f:.]+\]$/iu.test(value) ||
      (!/[\s/:?#@]/u.test(value) &&
        !value.includes("[") &&
        !value.includes("]") &&
        value.trim() === value),
    "providerHostname must be a hostname without scheme, port, path, query, credentials or fragment",
  );

// 性能块按可选耗时加可选计数组织：字段缺失表示该阶段未发生，与取值为零含义不同
// 所有毫秒字段统一为整数非负，避免小数毫秒在百分位聚合时制造虚假精度
// commandHash 只存固定长度摘要，既不留明文命令，又能按命令做去重与聚类
// 该对象同样 strict，runtime 新增的临时计时字段不会顺带进入遥测载荷
const toolPerformanceFactSchema = z
  .object({
    totalMs: z.number().int().nonnegative().optional(),
    permissionWaitMs: z.number().int().nonnegative().optional(),
    commandRunMs: z.number().int().nonnegative().optional(),
    firstOutputMs: z.number().int().nonnegative().optional(),
    noOutputMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    commandCategory: z.string().max(64).optional(),
    commandName: z.string().max(128).optional(),
    commandCount: z.number().int().nonnegative().optional(),
    commandStatus: z
      .enum(["completed", "failed", "timed_out", "cancelled", "spawn_error", "backgrounded"])
      .optional(),
    commandHash: z
      .string()
      .regex(/^[a-f0-9]{16}$/u)
      .optional(),
    fsReadMs: z.number().int().nonnegative().optional(),
    fsWriteMs: z.number().int().nonnegative().optional(),
    patchMatchMs: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    maxFileBytes: z.number().int().nonnegative().optional(),
    hunkCount: z.number().int().nonnegative().optional(),
    matchAttempts: z.number().int().nonnegative().optional(),
    workspaceKind: z.enum(["local", "remote", "unknown"]).optional(),
  })
  .strict();

// kind 字面量把该对象钉在联合类型的唯一分支上，删改字面量等于单方面改协议
// backgroundSource 的 workflow 取值晚于另外两个加入，旧客户端缺省即按无后台来源理解
// offPeakRunType 与 scheduledAt 只在特定调度路径出现，缺失是常态，不应当作异常上报
const turnStartedFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("turn.started"),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    inputSource: zcodeSyntheticUserMessageSourceSchema.optional(),
    // `workflow`：dynamic-workflow run 的完成 / 提问通知唤起的独立轮。
    backgroundSource: z.enum(["bash", "subagent", "workflow"]).optional(),
    automationId: z.string().min(1).optional(),
    offPeakTaskId: z.string().min(1).optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    taskTrigger: z.enum(["schedule", "manual"]).optional(),
    scheduledAt: timestampSchema.optional(),
  })
  .strict();

// status 把请求生命周期压成五个离散点，未知取值一律拒绝，而不是猜测它属于哪个阶段
// attempt 与 maxAttempts 必填，重试看板据此判断还会不会重试，缺失就无法区分终态失败
// retryable、statusCode、delayMs 只在失败或重试路径有意义，其余阶段缺失属于正常
const modelRequestStatusFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("model.request.status"),
    requestId: z.string().min(1),
    status: z.enum([
      "model_request_started",
      "model_request_completed",
      "model_request_failed",
      "model_retry_scheduled",
      "model_stream_stalled",
    ]),
    providerId: z.string(),
    modelId: z.string(),
    providerKind: z.string().optional(),
    providerHostname: providerHostnameSchema.optional(),
    transport: z.string(),
    querySource: z.string().optional(),
    queryId: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().optional(),
    reason: z.string().optional(),
    retryable: z.boolean().optional(),
    statusCode: z.number().int().optional(),
    delayMs: z.number().nonnegative().optional(),
    nextAttempt: z.number().int().nonnegative().optional(),
    idleMs: z.number().nonnegative().optional(),
    timeoutMs: z.number().nonnegative().optional(),
  })
  .strict();

// 流式事实只记录通道、长度与首块标记，正文内容永远不进入遥测
// parentToolCallId 可选，用于把子代理输出挂回父工具调用，缺失时按顶层流处理
const streamChunkFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("stream.chunk"),
    channel: z.enum(["thought", "text"]),
    chunkLength: z.number().int().nonnegative(),
    firstChunk: z.boolean(),
    assistantMessageId: z.string().min(1).optional(),
    partId: z.string().min(1).optional(),
    parentToolCallId: z.string().min(1).optional(),
  })
  .strict();

// phase 五态覆盖调度到失败的全过程，完成与失败互斥，消费端按 phase 而不是错误字段判终
// skillName 必须等于脱敏后的安全标识，原文经 sanitizeTelemetrySkillName 往返校验才允许上报
// performance 作为嵌套可选块与生命周期事实同生同灭，避免拆成两类事件后对不齐
// automationId 只承载定时触发归属，与 turn.started 的同名字段保持同一套语义
const toolLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("tool.lifecycle"),
    phase: z.enum(["scheduled", "started", "progress", "completed", "failed"]),
    toolCallId: z.string().min(1),
    toolName: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    parentToolCallId: z.string().min(1).optional(),
    childToolCallId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    agentType: z.string().optional(),
    childSessionId: z.string().min(1).optional(),
    background: z.boolean().optional(),
    skillName: z
      .string()
      .refine(
        (value) => sanitizeTelemetrySkillName(value) === value,
        "skillName must be a bounded, safe resolved Skill identifier",
      )
      .optional(),
    skillQualifiedName: z.string().min(1).optional(),
    skillPluginId: z.string().min(1).optional(),
    pluginId: z.string().min(1).max(256).optional(),
    pluginComponent: z.enum(["skill", "mcp"]).optional(),
    skillSource: z.enum(["agents", "zcode", "bundled", "plugin", "remote"]).optional(),
    performance: toolPerformanceFactSchema.optional(),
    automationId: z.string().min(1).optional(),
  })
  .strict();

// 权限事实只带请求、工具与决策枚举，不记录用户选择时看到的原始提示文本
// decision 到 resolved 阶段才可能出现，requested 阶段缺失不代表授权被拒
const permissionLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("permission.lifecycle"),
    phase: z.enum(["requested", "resolved", "denied"]),
    requestId: z.string().min(1).optional(),
    toolCallId: z.string().min(1),
    toolName: z.string().optional(),
    childSessionId: z.string().min(1).optional(),
    background: z.boolean().optional(),
    decision: z.enum(["allow", "deny", "escalate", "modify"]).optional(),
  })
  .strict();

// 六项 token 计数全部必填且非负，缺失不能用零填充，否则缓存命中率会被算成满分
// totalTokens 由上报方给出而不在此处求和，两端口径不一致时以它为唯一事实
// providerId 等关联键在增量上可选：没有请求上下文的补账事件同样要能被计入总量
const usageDeltaFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("usage.delta"),
    requestId: z.string().min(1).optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    providerKind: z.string().optional(),
    providerHostname: providerHostnameSchema.optional(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    reasoningTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
  })
  .strict();

// 子代理事实以 agentId 与 childSessionId 为必填主体，缺任一都无法把产物归回父会话
// background 在此必填，是否后台直接决定父轮次能否结束，用默认值会掩盖调度错误
const subagentLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("subagent.lifecycle"),
    phase: z.enum(["spawned", "stopped"]),
    agentId: z.string().min(1),
    agentType: z.string().optional(),
    childSessionId: z.string().min(1),
    parentToolCallId: z.string().min(1).optional(),
    background: z.boolean(),
    status: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

/**
 * 动态工作流子代理的归属事实。由父会话的 workflow run 进度事件派生：
 * - `actor-spawned`：一个子代理会话诞生。`childSessionId` 是 driver 生成的子会话 id，
 *   `sourceCommandId`（基字段）是该 run 的启动输入 id——子代理 step 挂在它下面。
 * - `run-settled`：run 结算即该 run 全部子代理的终态（子代理会话活到 run dispose）。
 *   `status` 是 run 的终态；`stopReason` 只在 `stopped` 时在场。
 * 只带 id 与状态，不带脚本、prompt、结果正文。
 */
// 工作流事实只表达归属与终态，脚本、prompt 与产物正文一律不进入该结构
// status 与 stopReason 分别描述 run 结果与停止来源，在 actor-spawned 阶段两者都可缺失
const workflowLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("workflow.lifecycle"),
    phase: z.enum(["actor-spawned", "run-settled"]),
    runId: z.string().min(1),
    toolCallId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    childSessionId: z.string().min(1).optional(),
    status: z.enum(["completed", "errored", "stopped"]).optional(),
    stopReason: z.enum(["user", "model", "provider", "interrupted", "superseded"]).optional(),
    errorMessage: z.string().optional(),
  })
  .strict();

// 轮次终态只有成功、中断、失败三种，中间态不允许通过该事件补报
// errorCode 与 errorMessage 仅在失败时可信，成功轮次携带它们应视为上报方缺陷
// workflowResultConsumed 是轮次级消费标记，用于区分通知已到达与本轮真的采纳了它
const turnTerminalFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("turn.terminal"),
    status: z.enum(["success", "interrupted", "failed"]),
    resultType: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    tokenCount: z.number().nonnegative().optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    errorRetryable: z.boolean().optional(),
    turnPhase: z.string().optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
    /** 本轮消费过 dynamic-workflow run 的通知（完成 / 提问）；`agent_composition` 的 wf 维度。 */
    workflowResultConsumed: z.boolean().optional(),
  })
  .strict();

// 压缩终态携带前后 token 计数，缺失表示该次压缩未能测量，而不是零消耗
// trigger 把自动、手动与响应式压缩分开，聚合压缩收益时必须先按 trigger 分桶
// attempt 与 maxAttempts 为正整数，重试次数为零没有意义，出现即判定为脏数据
const compactionTerminalFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("compaction.terminal"),
    operationId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    summaryMessageId: z.string().min(1).optional(),
    status: z.enum(["completed", "failed", "interrupted"]),
    trigger: z.enum(["manual", "auto", "partial", "reactive", "session_memory"]),
    compactReason: z.string().optional(),
    reason: z.string().optional(),
    attempt: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    modelName: z.string().optional(),
    modelProvider: z.string().optional(),
  })
  .strict();

/**
 * CLI 经 `v4/telemetry/event` 上送的实时会话事实，供桌面埋点与运行中会话统计消费。
 * 每个分支都 strict，避免新增 runtime 字段时把 prompt、工具输入或 provider URL 意外外带。
 */
// 判别联合按 kind 分派到十个分支，新增事件必须同时登记在此，否则整类事件被拒
// 逐字段约束留在各分支对象内，跨字段与按 phase 的条件必填才上提到 superRefine
// 外层不做字段级降级：任一成员解析失败即整条事件失败，宁可丢一条也不写半真数据
const conversationTelemetryFactRuntimeSchema = z
  .discriminatedUnion("kind", [
    turnStartedFactSchema,
    modelRequestStatusFactSchema,
    streamChunkFactSchema,
    toolLifecycleFactSchema,
    permissionLifecycleFactSchema,
    usageDeltaFactSchema,
    subagentLifecycleFactSchema,
    workflowLifecycleFactSchema,
    turnTerminalFactSchema,
    compactionTerminalFactSchema,
  ])
  // 互斥校验先于依赖校验，自动化与低谷任务同填时优先报互斥，避免两处告警互相覆盖
  // offPeakRunType 的缺失校验带 path，CLI 侧能把错误定位到具体字段而不是整条事件
  // workflow 的两种 phase 共享同一评审入口，条件必填只能在此按 phase 分流
  // 这里的每条 message 都是对外诊断文案，改动会让既有日志检索与告警规则失配
  // 校验失败只产生 issue 而不抛异常，调用方仍能拿到结构化错误做批量上报
  .superRefine((fact, context) => {
    if (fact.kind === "turn.started" && fact.automationId && fact.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automationId and offPeakTaskId are mutually exclusive",
      });
    }
    if (fact.kind === "turn.started" && fact.offPeakRunType && !fact.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offPeakRunType requires offPeakTaskId",
        path: ["offPeakRunType"],
      });
    }
    // discriminatedUnion 的成员必须是裸 ZodObject，按 phase 的条件必填只能写在这里。
    if (
      fact.kind === "workflow.lifecycle" &&
      fact.phase === "actor-spawned" &&
      (!fact.agentId || !fact.childSessionId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actor-spawned requires agentId and childSessionId",
      });
    }
    if (fact.kind === "workflow.lifecycle" && fact.phase === "run-settled" && !fact.status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "run-settled requires status",
        path: ["status"],
      });
    }
  });

// 推断类型是运行时 schema 的镜像，手工维护同形别名会与校验漂移，因此只允许 infer 生成
// 该中间别名仅供内部派生，不对外导出，避免消费端依赖未承诺的形状
type ConversationTelemetryFactBase = z.infer<typeof conversationTelemetryFactRuntimeSchema>;
type TurnStartedConversationTelemetryFact = Extract<
  ConversationTelemetryFactBase,
  { kind: "turn.started" }
> &
  import("../zcode-task-types-core.js").ZCodeBackgroundTurnAttribution;

// 对外类型把 turn.started 单独取出做交集扩展，其余分支原样复用推断结果
// 后台归属字段只存在于类型层，schema 因 strict 无法声明它们，补全由 transform 断言完成
// Exclude 与 Extract 的组合让新增分支自动进入对外类型，无需在此逐条列名
export type ConversationTelemetryFact =
  | Exclude<ConversationTelemetryFactBase, { kind: "turn.started" }>
  | TurnStartedConversationTelemetryFact;

// transform 只做类型断言不做重算，运行时已被 superRefine 完整校验，二次校验会掩盖真实失败点
// 导出的 schema 是对外唯一入口，消费端不应直接引用内部 runtime 联合，否则绕过对外语义
// 断言把后台归属字段补进类型而运行时保持 strict，代价是这两个键不参与校验，须由上游保证
export const conversationTelemetryFactSchema = conversationTelemetryFactRuntimeSchema.transform(
  (fact): ConversationTelemetryFact => fact as ConversationTelemetryFact,
);
