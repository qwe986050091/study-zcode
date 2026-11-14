// ============================================================================
// ZCode Protocol 共享契约（legacy v1 + v4 wire 并存的唯一事实来源）
// ----------------------------------------------------------------------------
// 定位：app（Host/UI）与 agent（CLI）之间唯一的线协议契约文件。method 名、params/result
// schema、session 事件 envelope 全部在这里声明；两侧运行时校验共用同一份 zod 对象，
// 因此“只改一侧”的改动会在协议边界被 fail-closed 拒绝，而不是在业务深处静默降级。
//
// 分层（从上到下）：① 基础标量与隐私/规模词表；② 各 method 的 params/result；
// ③ session 事件 discriminated union（type → payload 一一对应）；④ 方法名表与最小契约表。
// 四层都遵循同一兼容策略：只增不改。
//
// 为什么几乎每个 schema 都以 .strict() 收尾：
// zod 的默认行为是“忽略未知字段”，那会让新旧两端对同一份载荷产生两种理解——旧端静默
// 丢掉它不认识的语义字段，业务因此走到错误分支却不报错。strict 把不兼容提前到解析点，
// 代价是每加一个字段都必须同步旧端，收益是失配永远表现为“整条消息被拒”而不是“半条生效”。
//
// 不变量表（改动本文件前逐条确认；违反任何一条都会跨进程放大）：
// INV-01：legacy 握手版本恒为 1、V4 wire 版本恒为 3，二者互不代偿（守住它的位置：
//         ZCODE_PROTOCOL_VERSION / ZCODE_PROTOCOL_V4_WIRE_VERSION）。
// INV-02：所有载荷 schema 收尾为 .strict()；未知字段一律解析失败，禁止“先放行再丢弃”
//         （守住它的位置：全文 .strict() 与两个 superRefine 出口）。
// INV-03：新增字段必须 optional 或带 .default()，且语义可缺省；改类型/改上限/改必填
//         等于破坏旧 CLI ↔ 新 Host 的配对（守住它的位置：zcodeSessionCreateParamsSchema
//         等所有 params schema）。
// INV-04：错误码是线上常量，只能新增不能改数值（守住它的位置：zcodeProtocolErrorCodes）。
// INV-05：session 事件是封闭集合：zcodeSessionEventTypeSchema 的每个字面量必须在
//         zcodeSessionEventSchema 里恰好出现一次，漏一个即整类事件被丢弃
//         （守住它的位置：zcodeSessionEventTypeSchema 与 zcodeSessionEventSchema）。
// INV-06：legacy 与 v4 的 display 载荷必须逐字段镜像；v4 加字段而这里不加，strict 会
//         把整条 tool.updated 判为非法（守住它的位置：zcodeCreateWorkflowCausalityGraph*
//         与 zcodeCreateWorkflowToolResultDisplaySchema 的 fill/namePattern）。
// INV-07：遥测类 schema 不得承载路径、凭据、会话标识；mcpId / instanceToken 的正则是
//         最后一道机械防线（守住它的位置：zcodeMcpProcessTelemetryBaseShape.mcpId、
//         zcodeProcessResourceSampleSchema.instanceToken）。
// INV-08：任何可被外部放大（截图、资源、附件、诊断）的字段必须写上界，且上界来源要与
//         传输层帧预算同源（守住它的位置：node_repl images、relay chunk、diagnostics）。
// INV-09：时间点统一走 protocolInstantSchema（ms 数 / ISO 串 / Date）或 timestampMsSchema
//         （纯 ms 整数），禁止在各 method 里另造时间形态（守住它的位置：两者定义处）。
// INV-10：requestId 允许 string 或 int，因为 JSON-RPC 两端历史上都在用；收紧成单形态会
//         让旧客户端整条请求失配（守住它的位置：zcodeProtocolRequestIdSchema）。
// INV-11：topic resource 的 (requestId, taskId, inputId, authorizationId, messageId)
//         必须成组出现，缺一不可授权读取（守住它的位置：zcodeTopicResourceReadParamsSchema）。
// INV-12：relay 的 totalChunks 上界必须由 attachmentMaxBytes / chunkBytes 推导，硬编码
//         会在调整附件上限时悄悄放宽帧预算（守住它的位置：zcodeTopicResourceRelayMetadataSchema）。
// INV-13：摘要字段固定为 sha256:<64 hex> 或 64 位裸 hex，禁止自造摘要格式
//         （守住它的位置：relay checksum、共享上下文 provenance）。
// INV-14：MCP OAuth 的 client_credentials 与 authorization_code 字段集不同，不得合并成
//         一个宽松对象（守住它的位置：zcodeProtocolMcpOAuthSchema）。
// INV-15：MCP server 的 transport 由字段集判别（有 command 即 stdio，有 url 即 http/sse），
//         不引入显式 transport 字段以免出现“两者都有”的矛盾态
//         （守住它的位置：zcodeProtocolMcpServerSchema）。
// INV-16：插件 UI 的一切操作以 (sessionId, pluginId, serverName) + instance/scopeId +
//         generation 作为作用域键；缺 generation 会让旧实例的 dispose 退订掉新实例
//         （守住它的位置：zcodeMcpUiPluginScopeShape、zcodeMcpUiAppToolInstanceShape）。
// INV-17：App-Provided Tool 的回传必须 result 与 error 恰有其一，二者同现视为非法
//         （守住它的位置：zcodeMcpUiResolveAppToolCallParamsSchema 的 refine）。
// INV-18：共享上下文导入必须自带完整指纹证据（projection/artifactSet/markdown 三个
//         sha256 + formatterVersion），否则无法在冷恢复时证明内容未被替换
//         （守住它的位置：zcodeSessionImportHistorySchema）。
// INV-19：expectedRevision 是可选乐观并发栅栏；出现即必须比对，缺席表示调用方不参与
//         冲突检测（守住它的位置：session/send、fork、compact、goal、set* 各 params）。
// INV-20：automation 的 intervalUnit 与 interval 必须成对，且不能与一次性语义
//         （relativeDelayMinutes / recurring=false / maxRuns）同传
//         （守住它的位置：zcodeAutomationCreateParamsSchema 与 Update 的 refine 链）。
// INV-21：Off-Peak 失败必须同时给出 failureStage（在哪一步失败）与 errorCategory
//         （为什么失败），禁止压扁成一条字符串
//         （守住它的位置：zcodeOffPeakCreateResultSchema）。
// INV-22：最小契约表只登记“当前仍有消费方”的方法；不得把已删的 legacy 方法回填进来
//         （守住它的位置：zcodeProtocolSessionMethodContracts）。
// INV-23：事件 seq 的单调性由生产者维护，schema 只校验非负；在协议层做严格连续性校验
//         会把合法的跨进程合并事件判错（守住它的位置：zcodeEventEnvelopeSchema.seq）。
// INV-24：state.updated 的 scope 决定 workspace/sessionId 是否必须存在；三者不一致时
//         投影端会应用到错误的作用域（守住它的位置：zcodeStateUpdatedNotificationSchema）。
// INV-25：存储启动状态 phase=failed 必须带 errorCode，否则 UI 只能显示“未知失败”
//         （守住它的位置：zcodeStorageStartupStateSchema 的 superRefine）。
// INV-26：tool result 的 display.kind 是开放集合，未知 kind 必须放行（只校验已知三种），
//         否则新增一种展示形态会让旧 Host 丢弃整条工具结果
//         （守住它的位置：zcodeToolResultObjectSchema）。
// ============================================================================
import { requestVerificationReasons } from "../request-security-edition/verification-policy.js";
import { zcodeProtocolTraceSchema } from "./trace.js";
// Bot 反向回复的名字解析/待澄清结果与 App、CLI 使用同一严格 schema。
export { channelReplyRequestSchema, channelReplyResultSchema } from "../channel-mention.js";
export { zcodeProtocolTraceSchema, type ZCodeProtocolTrace } from "./trace.js";
import {
  databaseMigrationFactsSchema,
  databaseStartupErrorCodeSchema,
  databaseStartupErrorDetailsSchema,
} from "../database-startup.js";
import {
  MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE,
  MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS,
  MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS,
  mcpAppsAppToolCallResultSchema,
  mcpAppsAppToolDescriptorSchema,
} from "../mcp-apps/appTools.js";
import { mcpAppsSamplingParamsSchema, mcpAppsSamplingResultSchema } from "../mcp-apps/sampling.js";
import { mcpAppInstanceSchema } from "../mcp-apps/instance.js";
export { conversationQuoteSchema, conversationQuotesSchema } from "../conversationSelection.js";
/* oxlint-disable eslint(max-lines) -- ZCode Protocol schema 需要单文件导出，方便 app 与 agent 共享同一份协议契约。 */
// ── 旧协议删除边界──────────────────────
// 剩余 ~257 个导出：旧 ZCode Protocol 方法契约、请求/响应/事件 schema、
// session/workspace state snapshot 投影等（承重类型已迁 zcode-protocol-legacy-types.ts）。
// 已连根删除的死词（词表+schema+两侧实现）：session/steer、session/rewind、
// session/rewindCascade、session/previewFileRewind、session/applyFileRewind、
// prompt/enhance 全簇（含 promptEnhanceResult 通知）、plugins/marketplace/list；
// session/fork 客户端链已删（op+schema 留存 = v4 forkSessionAtMessage 钩子消费）。
// 消费者：services 旧栈（zcodeProtocolClient/zcodeAgent/zcodeAgentService/zcodeSession*）、
// CLI bootstrap 旧协议 server（zcode-protocol/server-operations、plugins、session-mapper 等）、
// UI 旧投影（zcodeSessionProjection 等读路径）。
// 上述旧协议 client/server 组删除时，本文件整体删除。
// 注：外部零消费 schema 多为存活 schema 联合的内部依赖，随宿主文件一起处理，勿单删。
import { z } from "zod";
import { accountProviderUnavailableReasonSchema } from "../account-provider-state.js";
import { bashOutputDisplaySchema } from "../bash-output-display.js";
import { zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import { completeModelPropertiesDataSchema } from "../model-config.js";
import { modelExecutionSchema } from "../model-execution.js";
export type { ModelExecutionSelectionFallback } from "../model-execution.js";
export * from "../off-peak-execution.js";
import { modelSelectionSchema } from "../model-selection.js";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { DYNAMIC_WORKFLOW_MODES } from "../dynamic-workflow-feature.js";
import { errorAttributionSchema } from "../zcode-protocol-v4/snapshot.js";
// 后台详情共享精简的只读响应 schema，不携带命令或计时元数据。
export * from "../background-bash-output.js";
export * from "../process-diagnostic.js";
export { attachmentSourceKindSchema, type AttachmentSourceKind } from "../attachment-source.js";
import { PROTOCOL_V4_LIMITS } from "../zcode-protocol-v4/core.js";

// topic/resource/read 是历史附件在 v4 附件命令面落地前的读取通道。
// 五个 id 构成完整授权链：requestId 去重、taskId 定位会话、inputId 定位用户输入、
// authorizationId 证明这次读取被授权、messageId 锁定具体消息；缺任一项，资源归属就可被
// 别的会话复用。resourceIndex 是消息内序号（非负），越界由读取方转成业务错误。
export const zcodeTopicResourceReadParamsSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    taskId: z.string().min(1).max(256),
    inputId: z.string().min(1).max(256),
    authorizationId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256),
    resourceIndex: z.number().int().nonnegative(),
  })
  .strict();
// bytes 上界与附件总预算同源（PROTOCOL_V4_LIMITS.attachmentMaxBytes）：读取通道不能成为
// 绕过附件预算的旁路。mime 只校验非空与长度，具体白名单由使用方按用途判定——
// 协议层一旦硬编码白名单，新增一种可读类型就得同时升级两侧。
export const zcodeTopicResourceReadResultSchema = z
  .object({
    ref: z.string().min(1),
    fileName: z.string().min(1).max(1024),
    mime: z.string().min(1).max(256),
    bytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
  })
  .strict();
// 取消键刻意只有 (requestId, taskId)：读取可能还没走到 inputId 绑定阶段用户就取消了，
// 若要求 inputId，这类“取消早于绑定”的请求会被协议层拒绝，任务只能一直等到超时。
export const zcodeTopicResourceCancelParamsSchema = z
  .object({ requestId: z.string().min(1).max(256), taskId: z.string().min(1).max(256) })
  .strict();
export const zcodeTopicResourceCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();
// 用 z.infer 导出而不再手写 interface：schema 与类型分叉时，Host 能编译通过但运行期
// 解析失败，属于最难排查的一类错配；推断类型让二者恒等。
export type ZCodeTopicResourceReadParams = z.infer<typeof zcodeTopicResourceReadParamsSchema>;
export type ZCodeTopicResourceReadResult = z.infer<typeof zcodeTopicResourceReadResultSchema>;
export { activeWorkSummarySchema, type ActiveWorkSummary } from "../zcode-protocol-v4/snapshot.js";
// browser-use 命令/结果契约单一来源：agent 构造、协议校验和 main executor 共用同一 schema。
import {
  browserBackendListResultSchema,
  browserSessionContextKindSchema,
} from "../browser-use/backend.js";
import { browserClientModeSchema, browserCommandSchema } from "../browser-use/commands.js";
import { browserCommandResultSchema } from "../browser-use/result.js";
import { appToolSearchModeSchema } from "../app-runtime-preferences.js";
import { integratedTerminalShellSelectionSchema } from "../validationAppSettings.js";
import { zcodeTaskModeSchema } from "../zcode-task-mode-schema.js";
import { OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS } from "../official-mcp-auth.js";
import {
  zcodeSyntheticUserMessageSourceSchema as legacyZcodeSyntheticUserMessageSourceSchema,
  zcodeDeliveryKindSchema,
  zcodeInteractionRequestOriginSchema,
  zcodeMessagePartSchema,
  zcodeMessageVisibilitySchema,
  zcodeMessageWithPartsSchema,
  zcodePermissionDecisionSchema,
  zcodePermissionResponseSchema,
  zcodePermissionUpdateSchema,
  zcodeSessionApiRetryStatusSchema,
  zcodeSessionContextUsageSchema,
  zcodeSessionGoalSchema,
  zcodeSessionGoalVerificationSchema,
  zcodeSessionGoalVerificationTimelineSchema,
  zcodeSessionInfoSchema,
  zcodeSessionKindSchema,
  zcodeSessionModeSchema,
  zcodeSessionRuntimeStateSchema,
  zcodeSessionStatusSchema,
  zcodeToolStateSchema,
  zcodeWorkspaceRefSchema,
} from "../zcode-protocol-legacy-types.js";

export * from "../localTtft.js";
export {
  hookExecutionProjectionSchema,
  hookInvocationRowSchema,
  type HookExecutionProjection,
  type HookInvocationRow,
} from "../zcode-protocol-v4/rows.js";

export {
  sessionsIndexReconcileParamsSchema,
  sessionsIndexReconcileResultSchema,
  type SessionsIndexReconcileParams,
  type SessionsIndexReconcileResult,
} from "../zcode-protocol-v4/sessions-index.js";

// 协议名会被写进 connect 握手与 snapshot.protocol 两处；改名等于让所有旧 host 无法识别
// 对端，属于不可回滚的破坏性变更。
export const ZCODE_PROTOCOL_NAME = "ZCode Protocol" as const;
// legacy 主协议版本固定在 1：老桌面端用字面量 1 做握手断言，提升会让它们整体失联。
export const ZCODE_PROTOCOL_VERSION = 1 as const;
// V4 wire 与 legacy 主协议并存；禁止为了 V4 physical framing 改写 legacy 版本。
export const ZCODE_PROTOCOL_V4_WIRE_VERSION = 3 as const;
// 两个能力开关都是 optional：缺席表示“对端不支持”，调用方必须走降级路径。不要把
// undefined 再折叠成第三态（如 null）——多一层默认值会让“旧端不支持”与“新端显式关闭”
// 在日志里无法区分。
export const zcodeRuntimeCapabilitiesSchema = z.object({
  historyFirst: z.boolean().optional(),
  independentPlanState: z.boolean().optional(),
});
// 只登记有独立语义分支的错误码；通用失败仍走 JSON-RPC 默认码。数值落在 -32000..-32099
// 的保留区间，避免与传输层/解析层错误撞号（INV-04）。
export const zcodeProtocolErrorCodes = {
  sessionUnavailable: -32004,
} as const;

// 共享标量集中定义一次，避免各 schema 各自写 min(1)：顺序必须是先 trim 再 min(1)，
// 反过来 '   ' 能通过长度校验，随后以空串进入下游（会话 id / 插件 id 都按此口径）。
const nonEmptyString = z.string().trim().min(1);
// 工具入参/结果里的自由对象：键值结构不在这里约束，由具体工具的 schema 或处理器校验。
const jsonObjectSchema = z.record(z.string(), z.unknown());
// 毫秒时间戳一律是整型非负，拒绝浮点与负数；需要高精度（带小数）的地方单独声明字段。
const timestampMsSchema = z.number().int().nonnegative();
// 时间点三形态是为了兼容三类生产者：老 CLI 发毫秒数、HTTP 侧发 ISO 串、进程内直接给
// Date。只在新字段上使用；已有字段不得从一种形态改成另一种（INV-09）。
const protocolInstantSchema = z.union([timestampMsSchema, nonEmptyString, z.date()]);

// Tool result display 不受模型文本 budget 约束；Node REPL 图片必须在 Agent/App 协议边界
// 做严格限长，避免截图把 continuous 或 replayable 消息扩成无界载荷。
export const zcodeNodeReplImageToolResultDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

// 同理：CreateWorkflow 的类型检查诊断也是 display 通道，必须在协议边界限长，
// 避免大量诊断把 continuous/replayable 消息扩成无界载荷。
// causalityGraph 在工具输出边界已限长，这里镜像同一组上界（与 v4 rows 保持一致）。
// 图的词汇表刻意很小：step 卡片 + actor 车道 + 一种箭头（runs after，`back` 只标回边）+
// 返回物标记。分析器的 kind / certainty / exact / region 不进载荷。
// 名字只在运行时成形（`` agent(`研究员${i + 1}`) ``）时静态能拿到的形状：第一个洞之前的
// 字面量（head）与最后一个洞之后的字面量（tail）。至少一个在场，两者都已 trim 且含实义字符。
// Bug 修复：这两个字段随 0a8b059f40 落进 contracts 与 v4 镜像，v3 这份漏改——.strict()
// 之下带插值名的工作流会让整个 display 验证失败、图整块消失，所以这里必须与 v4 逐字段对齐。
const zcodeWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// 一条边 = runs after；step 边与阶段边同形，`back` 只标循环回边。
const zcodeWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    back: z.literal(true).optional(),
  })
  .strict();

const zcodeCreateWorkflowCausalityGraphDisplaySchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            // `hole`：开着的留白自己的站点（docs/dynamic-workflow/presentation.md「Holes on the timeline」）；镜像 v4。
            kind: z.enum(["ask", "world-read", "hole"]),
            label: z.string().min(1).max(128),
            // 内联 `agent()` receiver 让 label 落到兜底串时，那个名字的静态形状。
            labelPattern: zcodeWorkflowNamePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // 展开自的站点 id，只出现在 may-set 车道展开的拷贝上（实时叠加的关联键）；
            // 加字段是 additive 的，不带它的旧载荷照常通过 .strict()。
            source: z.string().min(1).max(64).optional(),
            // 作者用 `phase("…")` 标记划入的阶段。
            // 与图的 phases / phaseEdges / exits 同进同退：全在场或全缺席。
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
            // 这个站点是某次补全写进来的：值是那个留白的站点 id；镜像 v4。
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(64),
    lanes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            // `name` 缺席而 agent() 首参是带洞的模板串时的静态形状；与 name 互斥。
            namePattern: zcodeWorkflowNamePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // 参与者与交接；镜像 v4。
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            phase: z.string().min(1).max(64),
            lane: z.string().min(1).max(64),
            steps: z.array(z.string().min(1).max(64)).min(1).max(64),
            member: z
              .object({ index: z.number().int().nonnegative(), of: z.number().int().positive() })
              .strict()
              .optional(),
            many: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(64),
    handoffs: z
      .array(
        zcodeWorkflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // 阶段词汇表：作者施加的分组结构，主画面以它为节点。与 phaseEdges / exits / Step.phase
    // 全有或全无——零标记脚本全缺席，UI 据此退回 step/车道视图。零成员阶段也在表里。
    // `unphased` 无 name，显示名由 UI 本地化。
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // 进入本阶段时还在跑的其他阶段（它们的 strand 尚未 join），阶段表序，不含自己，
            // 为空时缺席。是节点事实而不是边——控制没有从那里转移过来，所以不进 phaseEdges。
            // 时间轴据此把相邻阶段折成一条分叉的「带」，侧栏迷你轨道画成双线段。
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
            // 这个阶段是某次补全写进来的：值是那个留白的站点 id；镜像 v4。
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(zcodeWorkflowEdgeSchema).max(128).optional(),
    // 阶段流（docs/dynamic-workflow/presentation.md「Streams」）：两端互为 alongside 的 data 边，
    // 只有 {from, to}——不是 runs after，不进 phaseEdges、不带 back。与词汇表同进同退。
    phaseStreams: z
      .array(z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).strict())
      .max(128)
      .optional(),
    // 还开着的留白，源码序（docs/dynamic-workflow/authoring.md「Holes」）；镜像 v4。
    holes: z
      .array(
        z
          .object({
            siteId: z.string().min(1).max(64),
            name: z.string().min(1).max(128),
            type: z.string().min(1).max(128),
            phase: z.string().min(1).max(64).optional(),
            tail: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    // 控制流可在其后正常完成的阶段（阶段视图的「阶段 → 返回物」箭头）；组内可为空数组。
    exits: z.array(z.string().min(1).max(64)).max(32).optional(),
    sink: z.array(z.string().min(1).max(64)).max(64).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

// diagnostics 与 causalityGraph 都是 display 通道：不受模型文本 budget 约束，所以必须
// 各自有界（诊断 ≤100 条、message ≤2048 字符、图见上一个 schema）。errorCount 与
// diagnostics.length 不做恒等校验——历史版本存在只报计数不附带明细的载荷。
// fill 字段是“补洞”动作的定位信息，与 v4 逐字段镜像（INV-06）；漏声明会让整个
// tool.updated 被 strict 拒绝，桌面端表现为工具结果突然空白。
export const zcodeCreateWorkflowToolResultDisplaySchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z
          .object({
            line: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            code: z.number().int().nonnegative(),
            message: z.string().min(1).max(2_048),
          })
          .strict(),
      )
      .max(100),
    causalityGraph: zcodeCreateWorkflowCausalityGraphDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    // FillWorkflowHole 行补的是哪处留白（docs/dynamic-workflow/presentation.md「The fill row」）；镜像 v4。
    // 修复原因：dwf-recursive 只给 contracts 与 v4 加了留白字段，v3 的 .strict() 拒掉整条 tool.updated，
    // 桌面端 v3 订阅于是把含留白的 CreateWorkflow / FillWorkflowHole 结果当无效事件丢掉。
    fill: z
      .object({
        siteId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        draftPath: z.string().min(1).max(1_024).optional(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// 工具结果是“自由对象”，但 display 里几种自带结构的大载荷需要独立校验。这里按 kind
// 分派：命中已知 kind 就用对应严格 schema 再解析一遍，未知 kind 直接放行（INV-26）。
// 为什么不用 union：display 只是结果的一个可选子字段，若把整个 result 交给 union，
// 任意一种新 display 形态出现时旧 Host 会连 tool result 一起拒收。
// addIssue 时把 path 前置 display，报错才能指向原始载荷里的真实位置。
const zcodeToolResultObjectSchema = jsonObjectSchema.superRefine((result, context) => {
  const display = result.display;
  if (typeof display !== "object" || display === null || Array.isArray(display)) {
    return;
  }
  const kind = (display as Record<string, unknown>).kind;
  const schemaByKind: Record<string, z.ZodTypeAny> = {
    node_repl_images: zcodeNodeReplImageToolResultDisplaySchema,
    create_workflow: zcodeCreateWorkflowToolResultDisplaySchema,
    bash_output: bashOutputDisplaySchema,
  };
  const schema = typeof kind === "string" ? schemaByKind[kind] : undefined;
  if (!schema) return;
  const parsed = schema.safeParse(display);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ["display", ...issue.path] });
  }
});

// JSON-RPC 允许 id 为字符串或整数，两端历史上两种都在发；收紧成单形态会让一半旧客户端
// 的整条请求在解析阶段失配（INV-10）。注意这里不校验非空——0 与 "" 都是合法关联键。
export const zcodeProtocolRequestIdSchema = z.union([z.string(), z.number().int()]);
export type ZCodeProtocolRequestId = z.infer<typeof zcodeProtocolRequestIdSchema>;

// 远程历史附件仅通过现有连接的私有反向频道传输，单块保持在 RPC 帧预算内。
// 384 KiB 是“单块 + base64 膨胀 + 帧头”仍落在单个 RPC 帧预算内的实测上界。改小会让大附件
// 的往返次数线性上升；改大则可能触发传输层的单帧上限，表现为连接被重置而非报错。
export const TOPIC_RESOURCE_RELAY_CHUNK_BYTES = 384 * 1024;
// 私有反向频道名：附件只走已建立的连接，不新开端口，避免在 NAT/防火墙环境下额外协商。
export const TOPIC_RESOURCE_RELAY_CHANNEL = "host-topic-resource";
// relay 请求在 read 参数之上补齐路由三元组：workspacePath/workspaceIdentity 决定由哪个
// Host 处理，remoteSessionId 决定穿透到哪条远程连接。三者缺一，中继就可能在错误的
// workspace 里读到同名资源（身份隔离失效）。
export const zcodeTopicResourceRelayRequestSchema = zcodeTopicResourceReadParamsSchema
  .extend({
    workspacePath: z.string().min(1).max(4096),
    workspaceIdentity: z.string().min(1).max(4096),
    remoteSessionId: z.string().min(1).max(256),
    trace: zcodeProtocolTraceSchema.optional(),
  })
  .strict();
export type ZCodeTopicResourceRelayRequest = z.infer<typeof zcodeTopicResourceRelayRequestSchema>;
export const zcodeTopicResourceRelayKeySchema = zcodeTopicResourceCancelParamsSchema;
export const zcodeTopicResourceRelayChunkRequestSchema = zcodeTopicResourceRelayKeySchema
  .extend({
    index: z.number().int().nonnegative(),
  })
  .strict();
// totalChunks 的上界由附件总预算 / 单块大小推导（INV-12）：硬编码一个“看起来够大”的数字，
// 在附件上限调整后要么过早拒绝合法文件，要么让 chunk 数量突破接收方的缓冲假设。
// checksum 固定 sha256:<64 hex>，接收方据此判断重组是否完整（INV-13）。
export const zcodeTopicResourceRelayMetadataSchema = z
  .object({
    fileName: z.string().min(1).max(1024),
    mime: z.string().min(1).max(256),
    bytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    totalChunks: z
      .number()
      .int()
      .min(0)
      .max(Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / TOPIC_RESOURCE_RELAY_CHUNK_BYTES)),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
// base64 长度上界 = 原始块大小 / 3 * 4（每 3 字节编成 4 字符）。这里不校验解码后的字节数，
// 因为多一块少一块由 totalChunks 与 checksum 在重组阶段判定；在协议层校验会把“最后一
// 块不足额”这种正常情况误判为非法。
export const zcodeTopicResourceRelayChunkSchema = z
  .object({
    dataBase64: z.string().max((TOPIC_RESOURCE_RELAY_CHUNK_BYTES / 3) * 4),
  })
  .strict();

// 四类报文共用“id/method/params”骨架，但只有 request 带 id 且带 method。params 与 trace
// 都是 unknown：方法级 schema 负责具体形状，信封层只保证字段名与类型不会串味。
export const zcodeProtocolRequestSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
  })
  .strict();
export type ZCodeProtocolRequest = z.infer<typeof zcodeProtocolRequestSchema>;

// 通知没有 id，因此发送方无法感知投递失败；正因如此，通知类事件必须纯增量、可丢弃，
// 需要“是否被接纳”的语义一律走 request/response（见大纲不变量 13）。
export const zcodeProtocolNotificationSchema = z
  .object({
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
  })
  .strict();
export type ZCodeProtocolNotification = z.infer<typeof zcodeProtocolNotificationSchema>;

// result 是 unknown：成功与否由业务 schema 决定，信封层不提供 ok 字段。这条选择让
// “返回空对象”与“返回布尔”都能表达，代价是调用方必须自带结果 schema。
export const zcodeProtocolResponseSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    result: z.unknown(),
  })
  .strict();
export type ZCodeProtocolResponse = z.infer<typeof zcodeProtocolResponseSchema>;

// 错误报文同样带 id，保证请求一定能被 settle；message 走 nonEmptyString（trim 后非空），
// 因为空错误消息在 UI 上只能显示为“未知错误”，等于丢失唯一线索。
// data 保持 unknown：不同方法的补充信息差异过大，统一定义只会逼出大量可选字段。
export const zcodeProtocolErrorSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    error: z
      .object({
        code: z.number().int(),
        message: nonEmptyString,
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodeProtocolError = z.infer<typeof zcodeProtocolErrorSchema>;

// 报文判别顺序有意义：request 与 notification 的唯一差异是 id，response/error 的骨架
// 又能与它们重合一部分。union 按“字段最多的在前”排列，让解析失败时的报错指向更具体的
// 分支；调换顺序不会改变可接受集合，但会显著影响排障可读性。
export const zcodeProtocolMessageSchema = z.union([
  zcodeProtocolRequestSchema,
  zcodeProtocolNotificationSchema,
  zcodeProtocolResponseSchema,
  zcodeProtocolErrorSchema,
]);
export type ZCodeProtocolMessage = z.infer<typeof zcodeProtocolMessageSchema>;

// 通知方法名表：右侧字符串就是线上字节，重命名等于断开所有已连接的客户端。左侧键名只是
// 调用侧常量，可以改；这条“键可变、值不可变”的区分是排查线上失配时的第一条线索。
export const zcodeProtocolNotifications = {
  storageStartup: "startup/storageState",
  providerRuntimeHeadersCancelled: "interaction/providerRuntimeHeadersCancelled",
  mcpTelemetry: "process/mcpTelemetry",
  mcpResourceSamples: "process/mcpResourceSamples",
  toolExecResource: "process/toolExecResource",
  pluginOperationProgress: "plugins/operationProgress",
  processResourceSample: "process/resourceSample",
  processNetworkRequests: "process/networkRequests",
} as const;

/** 启动控制面独立于 task stream；数据库身份不可携带路径/凭据。 */
// 存储启动状态是独立控制面（不挂在 task stream 上）：数据库还没就绪时任务通道本身不可用，
// 启动进度必须能单独送达。databaseId 只允许不透明标识，禁止携带路径或凭据——该通知会
// 被写进日志与 UI，任何路径泄漏都越过隐私红线。
// sequence 单调递增用于丢弃乱序到达的旧快照：重连后可能先收到落后的帧。
// phase=failed 必须带 errorCode（INV-25），否则 UI 只能显示“未知失败”，用户无法自助恢复。
// migration 字段整体可选，是为了让未升级的旧 CLI 仍能解析（字段级兼容而非版本升级）。
// superRefine 只校验这一条跨字段规则：其余组合（例如 phase=ready 却带 errorCode）保留
// 宽松度，避免一个前端版本就把历史通知判非法。
export const zcodeStorageStartupStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
    databaseId: z.string().min(1).max(128),
    databaseKind: z.enum(["session", "tasks-index"]),
    phase: z.enum(["checking", "waiting_for_lock", "migrating", "committing", "ready", "failed"]),
    // 包含锁内、版本 SQL 之前的可选 lastAppliedMigrationId；旧通知仍可解析。
    migration: databaseMigrationFactsSchema.optional(),
    elapsedMs: z.number().nonnegative().finite(),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    errorCode: databaseStartupErrorCodeSchema.optional(),
    ...databaseStartupErrorDetailsSchema.shape,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.phase === "failed" && !state.errorCode)
      context.addIssue({ code: "custom", message: "failed requires errorCode" });
  });
export type ZCodeStorageStartupState = z.infer<typeof zcodeStorageStartupStateSchema>;

// 平台/架构用封闭枚举而不是自由字符串：这两值会进入遥测与设备总量聚合，一旦允许自由
// 文本，同一台机器会因 "win32"/"windows" 混用被统计成两台。新增平台必须两边同时放行。
const zcodeMcpTelemetryPlatformSchema = z.enum([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
]);
const zcodeMcpTelemetryArchSchema = z.enum([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);
// 所有 MCP 事件共用的三元组：架构/平台/发生时刻。occurredAt 用整数毫秒而非 ISO 串，因为
// 这些事件会被批量聚合，字符串时间戳在合流时无法直接比较大小。
const zcodeMcpTelemetryBaseSchema = z
  .object({
    arch: zcodeMcpTelemetryArchSchema,
    occurredAt: z.number().int().nonnegative(),
    platform: zcodeMcpTelemetryPlatformSchema,
  })
  .strict();
// mcpId 的正则是隐私红线的机械保障（INV-07）：builtin 只允许 RFC 3986 非保留字符与 %XX，
// plugin/custom 只允许 12 位十六进制摘要。这两条字符集都不含路径分隔符与冒号分隔的
// 敏感片段，所以“误把 server 命令行当 id 上报”在协议层就过不去。
// mcpIsolation/mcpSource 是枚举而非自由串：它们的取值决定后续是否按会话回收进程。
const zcodeMcpProcessTelemetryBaseShape = {
  mcpId: z
    .string()
    .regex(
      /^(?:builtin:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+(?::(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+)*|(?:plugin|custom):[a-f0-9]{12})$/,
    ),
  mcpInstanceId: nonEmptyString,
  mcpIsolation: z.enum(["session", "workspace"]),
  mcpSource: z.enum(["builtin", "plugin", "custom"]),
} as const;

// 四种事件按 kind 判别，新增 kind 必须同时改这里与消费端的 switch；discriminatedUnion
// 要求每个分支的 kind 都是字面量，缺 literal 会让整个 union 退化成普通 union（解析变慢
// 且报错失去字段上下文）。
// 计数字段统一 max(10_000)：遥测来自外部进程，若不设界，一次异常的上报可以让聚合端
// 分配超预期的数组。memory 事件额外带 orphanSuspected 与 unownedSeconds，用于区分
// “进程还在但已无主”与“进程已退出”——这两种情况的处置不同（前者需要接管，后者只需清理）。
export const zcodeMcpTelemetryEventSchema = z.discriminatedUnion("kind", [
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("process_start"),
      ...zcodeMcpProcessTelemetryBaseShape,
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("process_crash"),
      ...zcodeMcpProcessTelemetryBaseShape,
      affectedSessionCount: z.number().int().nonnegative().max(10_000),
      exitCode: z.number().int().nullable(),
      signal: nonEmptyString.nullable(),
      uptimeMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("session_startup"),
      configuredCount: z.number().int().nonnegative().max(10_000),
      connectedCount: z.number().int().nonnegative().max(10_000),
      failedCount: z.number().int().nonnegative().max(10_000),
      processCount: z.number().int().nonnegative().max(10_000),
      sessionId: nonEmptyString,
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("memory"),
      ...zcodeMcpProcessTelemetryBaseShape,
      memoryKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
      memoryScope: z.enum(["process_tree", "direct_process"]),
      orphanSuspected: z.boolean(),
      ownerSessionCount: z.number().int().nonnegative().max(10_000),
      unownedSeconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
export type ZCodeMcpTelemetryEvent = z.infer<typeof zcodeMcpTelemetryEventSchema>;

/** MCP 每五分钟只探测一次，周期由生产者与设备总量过期判据共用。 */
// 采样周期由生产者与设备总量过期判据共用同一个常量：两侧各写一个 5 分钟会在调整时
// 出现“采样比过期快”或反之，前者造成无谓唤醒，后者让刚采到的数据立刻被判过期。
export const ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60_000;

// instanceToken 限定 [A-Za-z0-9_-]{8,64}：它只用于“同一进程的多次采样”归组，因此不需要
// 也不允许出现路径、pid 或 workspace 标识。processCount/rss/cpu 全部有上界，避免异常值
// 进入聚合后污染均值。
export const zcodeMcpResourceSampleSchema = z
  .object({
    mcpId: zcodeMcpProcessTelemetryBaseShape.mcpId,
    instanceToken: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    sampledAt: z.number().int().nonnegative(),
    intervalMs: z.number().finite().positive(),
    processCount: z.number().int().positive().max(100_000),
    rssKbTotal: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rssKbMaxProcess: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cpuTimeMsDelta: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    uptimeMinutes: z.number().int().nonnegative(),
    platform: zcodeMcpTelemetryPlatformSchema,
    arch: zcodeMcpTelemetryArchSchema,
    logicalCpuCount: z.number().int().positive().max(4_096),
    totalMemoryGb: z.number().int().nonnegative().max(1_048_576),
  })
  .strict();
export type ZCodeMcpResourceSample = z.infer<typeof zcodeMcpResourceSampleSchema>;
// 通知输入有界；main 另按每个上报窗口的 32 个 MCP 分组执行事件额度。
// 单批最多 1024 条，且 main 侧另按上报窗口的 MCP 分组数量施加额度：协议层只挡住“单帧
// 过大”，业务层才挡住“上报过频”。两层缺一不可——只有协议上界时高频小批仍能打满 CPU。
export const zcodeMcpResourceSamplesSchema = z.array(zcodeMcpResourceSampleSchema).max(1_024);

// 15s 采样间隔与 20 个样本上限共同决定 5 分钟的历史窗口；durationMs 的下界也取 15s
// （见 toolExecResource 的 min），因为更短的 bash 不值得采样，硬报会污染分布的长尾。
export const BASH_RESOURCE_SAMPLE_INTERVAL_MS = 15_000;
export const BASH_RESOURCE_MAX_SAMPLES = 20;

/** Bash 子进程的有界完成事实；禁止命令、路径与会话标识进入遥测旁路。 */
// 这是“完成事实”而不是运行细节：toolName 锁死为字面量 bash，schema 里没有任何命令、
// 路径或会话字段（INV-07）。刻意不提供扩展位——一旦允许附带 argv，遥测就成了命令历史的
// 影子副本，无法再向用户承诺“不上传命令”。
// completionToken 可选：同一完成事实可能经多个 Host 转发，随机 uuid 仅供 main 去重；
// 旧 CLI 不带该字段仍要通过，所以是 optional 而不是必填。
// exitKind 四态是封闭集合：超时/被 kill/自身报错在 UI 上的处置完全不同，压成布尔
// success 会让“超时后重试”与“参数错误”无法区分。
export const zcodeToolExecResourceSchema = z
  .object({
    // 同一完成事实可能经多个 Host 转发；随机标识仅供 main 去重，旧 CLI 缺字段仍兼容。
    completionToken: z.string().uuid().optional(),
    platform: zcodeMcpTelemetryPlatformSchema,
    toolName: z.literal("bash"),
    durationMs: z.number().finite().min(BASH_RESOURCE_SAMPLE_INTERVAL_MS),
    exitKind: z.enum(["completed", "timeout", "killed", "error"]),
    treeRssKbPeak: z.number().finite().nonnegative().optional(),
    treeCpuTimeMs: z.number().finite().nonnegative().optional(),
    sampleCount: z.number().int().nonnegative().max(BASH_RESOURCE_MAX_SAMPLES),
    cliRssKb: z.number().finite().nonnegative(),
    systemFreeMemoryKb: z.number().finite().nonnegative(),
  })
  .strict();
export type ZCodeToolExecResource = z.infer<typeof zcodeToolExecResourceSchema>;

// CLI 进程级采样。queue 下四项与 instanceToken 全部 optional：它们是后加的遥测字段，
// 旧 CLI 不会发送；做成必填会把旧进程的样本全部判非法，等于把一条诊断通道变成噪声源
// （也正因如此不需递增握手版本，见字段内注释）。
// intervalMs 上限 7 天：超过一周的样本不可能是“当前负载”，只可能是时钟异常。
export const zcodeProcessResourceSampleSchema = z
  .object({
    platform: z.enum([
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "netbsd",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
    ]),
    arch: z.enum([
      "arm",
      "arm64",
      "ia32",
      "loong64",
      "mips",
      "mipsel",
      "ppc",
      "ppc64",
      "riscv64",
      "s390",
      "s390x",
      "x64",
    ]),
    logicalCpuCount: z.number().int().positive().max(4_096),
    intervalMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1_000),
    cpuCores: z.number().finite().nonnegative().max(4_096),
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /**
     * 以下四项为遥测新增字段，全部可选：旧 CLI 发来的样本仍能通过校验，因此
     * **不递增协议握手版本号**（握手版本是兼容性开关，不是字段版本）。
     */
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    uptimeMinutes: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 365 * 24 * 60)
      .optional(),
    totalMemoryGb: z.number().int().nonnegative().max(1_048_576).optional(),
    /**
     * CLI 进程启动时随机生成的实例标识，仅供 app 侧 main 统计「同时存活几个 CLI 进程」
     * 与「最大单进程 RSS」。不进 ARMS 属性、不含 pid。收紧字符集是隐私红线的机械保障：
     * 路径、workspace 标识这类内容不可能通过校验。
     */
    instanceToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
  })
  .strict();
export type ZCodeProcessResourceSample = z.infer<typeof zcodeProcessResourceSampleSchema>;

// 无参数方法也显式声明空对象并 strict：这样客户端多传一个字段会立刻暴露拼写错误，
// 而不是被静默忽略。
export const zcodeProcessChildProcessesParamsSchema = z.object({}).strict();
// 单个子进程的归属面：pid + server 名 + 来源 + 可选插件名。pid 是整数正数（0 与负数不可能
// 是有效进程号）；pluginName 只对 plugin 来源有意义，custom 来源没有名字，因此可选。
export const zcodeProcessChildProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    serverName: nonEmptyString,
    mcpSource: z.enum(["builtin", "plugin", "custom"]),
    /** 官方/第三方插件的插件名（`plugin:<name>:<key>` 的 name，或官方 host MCP 对应插件）；custom 无 */
    pluginName: nonEmptyString.optional(),
  })
  .strict();
// 列表上界 10_000：正常进程树远小于此，超过即说明采样逻辑本身出问题（例如递归把子进程
// 的子进程重复计入）。这里选择截断上报而不是报错，避免一次异常让整块资源视图消失。
export const zcodeProcessChildProcessesResultSchema = z
  .object({
    processes: z.array(zcodeProcessChildProcessSchema).max(10_000),
  })
  .strict();
export type ZCodeProcessChildProcess = z.infer<typeof zcodeProcessChildProcessSchema>;
export type ZCodeProcessChildProcessesResult = z.infer<
  typeof zcodeProcessChildProcessesResultSchema
>;

export type ZCodeDeliveryKind = z.infer<typeof zcodeDeliveryKindSchema>;
// TurnStarted 与持久 message 必须共用同一来源词表；否则 live event 能通过而 cold
// message 在 app/agent 边界被拒绝，造成 continuous/replayable 语义分叉。
// 持久消息与输入沿用同一 source schema；agent_listing_delta 只作 provider context，不触发新 turn。
// 持久消息与 live 事件必须共用同一份来源词表：TurnStarted 用一套、冷消息用另一套时，
// live 事件能通过而重放的历史消息在 app/agent 边界被拒，continuous 与 replayable 两条
// 链路会出现语义分叉（见上方既有注释）。agent_listing_delta 只作 provider context，
// 不是用户输入来源，因此不在这个 schema 里。
const zcodeTurnInputSourceSchema = legacyZcodeSyntheticUserMessageSourceSchema;
// immediate：消息一产生即落库，进程崩溃最多丢一段流式增量；deferred：攒批写入，吞吐高但
// 崩溃会丢整批。取值由下发方决定，协议只做词表校验——两种模式的下游写入路径必须都能
// 处理，新增第三种取值等于要求两侧同时实现新的落库策略。
export const zcodeSessionPersistenceSchema = z.enum(["immediate", "deferred"]);
export type ZCodeSessionPersistence = z.infer<typeof zcodeSessionPersistenceSchema>;
export type ZCodeWorkspaceRef = z.infer<typeof zcodeWorkspaceRefSchema>;
// 权限选项把“展示文案”和“提交给 agent 的响应”绑在同一个对象里：UI 只回传 optionId 时
// 仍需知道对应 response，因此这里把结构化响应直接随选项下发，避免 UI 自己拼协议载荷。
// options 至少一个（调用方用 min(1) 保证），否则权限请求无法被回答，轮次只能挂死。
export const zcodePermissionOptionSchema = z
  .object({
    optionId: nonEmptyString,
    kind: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    response: zcodePermissionResponseSchema,
  })
  .strict();

// env 用 [{name,value}] 数组而不是 record：record 会丢掉重复键与顺序，而 MCP 启动参数
// 的语义就是“按顺序注入的一组键值”，同名键由后者覆盖是进程侧行为，不能提前在协议层
// 折叠。name 走 nonEmptyString，value 允许空串（显式设为空是合法配置）。
const zcodeProtocolMcpEntrySchema = z
  .object({
    name: nonEmptyString,
    value: z.string(),
  })
  .strict();

// 两种 OAuth 授权类型的必填字段不同（INV-14）：client_credentials 必须有 id+secret，
// authorization_code 允许两者都缺（走动态注册 + 用户浏览器授权）。合并成一个对象会逼出
// “都 optional”，结果两种模式的校验都失效；分成两个 strict 分支才能各自钉住字段。
const zcodeProtocolMcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: nonEmptyString,
      clientSecret: nonEmptyString,
      clientName: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: nonEmptyString.optional(),
      clientSecret: nonEmptyString.optional(),
      clientName: nonEmptyString.optional(),
      redirectPath: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

// transport 由字段集判别（INV-15）：有 command 即 stdio、有 url 即 http/sse。不设显式
// transport 字段，是为了避免“command 与 url 同时出现”这种无法裁决的矛盾态。
// protocolVersion 是三值枚举（legacy/auto/2026-07-28）：auto 让 CLI 在握手时探测，
// 固定值只用于排查“对方迟迟不回应”的兼容问题。timeoutMs 正整数，0 与负数无意义。
// isolation 决定子进程是跟会话回收还是跟 workspace 回收，缺省由 CLI 按 server 来源推断。
export const zcodeProtocolMcpServerSchema = z.union([
  z
    .object({
      name: nonEmptyString,
      command: nonEmptyString,
      args: z.array(z.string()),
      env: z.array(zcodeProtocolMcpEntrySchema),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      alwaysLoad: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      name: nonEmptyString,
      type: z.enum(["http", "sse"]),
      url: nonEmptyString,
      headers: z.array(zcodeProtocolMcpEntrySchema),
      oauth: zcodeProtocolMcpOAuthSchema.optional(),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      alwaysLoad: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ZCodeProtocolMcpServer = z.infer<typeof zcodeProtocolMcpServerSchema>;

// 六态状态机。untrusted 与 failed 分开：前者是“还没决定是否信任”，后者是“尝试过并失败”，
// UI 上前者给授权入口、后者给重试入口。新增状态必须同步所有消费端 switch 的默认分支，
// 否则会落进“未知状态”显示。
export const zcodeMcpServerStatusKindSchema = z.enum([
  "connecting",
  "connected",
  "disabled",
  "disconnected",
  "failed",
  "untrusted",
]);
// 失败原因表：每一项都是可被判定的“阶段 + 原因”，而不是错误文本。调用方按 kind 决定
// 是否可重试（connection_timeout 可、config_invalid 不可），因此这是行为契约而不是
// 诊断字符串；只能追加，不能改既有项的含义。
export const MCP_SERVER_FAILURE_KINDS = [
  "config_invalid",
  "runtime_unavailable",
  "process_start_failed",
  "network_unreachable",
  "connection_timeout",
  "protocol_negotiation_failed",
  "tool_list_failed",
  "unexpected_disconnect",
  "oauth_authorization_failed",
  "official_origin_untrusted",
  "not_authenticated",
  "coding_plan_required",
  "server_not_found",
  "server_unavailable",
  "rate_limited",
  "server_internal_error",
  "protocol_error",
  "status_unavailable",
  "connection_failed",
] as const;
export const mcpServerFailureKindSchema = z.enum(MCP_SERVER_FAILURE_KINDS);
export type McpServerFailureKind = z.infer<typeof mcpServerFailureKindSchema>;
// status 快照是“一次探测的结果”，不是持续事实：updatedAt 用非空字符串（可能来自不同
// 时区的序列化），消费方只做展示与排序，不做时钟运算。
// authorization 只在 oauth 授权进行中出现，携带授权 URL 与开始时间，用于 UI 恢复
// “等待用户在浏览器完成授权”的中间态；其余状态一律缺席。
// error + failureKind 并存：前者给人看（可能含服务端原文），后者给程序分流。
export const zcodeMcpServerStatusSnapshotSchema = z
  .object({
    status: zcodeMcpServerStatusKindSchema,
    transport: z.enum(["stdio", "http", "sse"]),
    toolCount: z.number().int().nonnegative(),
    updatedAt: nonEmptyString,
    error: z.string().optional(),
    failureKind: mcpServerFailureKindSchema.optional(),
    serverRequestId: nonEmptyString.optional(),
    protocolEra: z.enum(["legacy", "modern"]).optional(),
    authorization: z
      .object({
        type: z.literal("oauth_authorization_code"),
        authorizationUrl: nonEmptyString,
        startedAt: nonEmptyString,
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeMcpServerStatusSnapshot = z.infer<typeof zcodeMcpServerStatusSnapshotSchema>;

// connect 会真正拉起/握手 server，status 只读现有快照。默认 connect 是因为调用方通常
// 在“要列工具”时调用；只想要状态的地方必须显式传 status，避免顺手触发一批进程启动。
export const zcodeMcpListModeSchema = z.enum(["connect", "status"]);
export type ZCodeMcpListMode = z.infer<typeof zcodeMcpListModeSchema>;

// mcpServers 由调用方显式下发（而不是服务端读配置）：这样“用哪套 server 配置”这件事
// 只由 workspace 的持有者决定，agent 侧无法偷偷合并本地配置。mode 带 default，缺省
// 等价于 connect，保证旧客户端语义不变。
export const zcodeMcpListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    mode: zcodeMcpListModeSchema.default("connect"),
  })
  .strict();
// statuses 以 server 名为键：key 由调用方下发，服务端只回填同名条目；用 record 而非数组
// 是因为消费端按名字取用（UI 渲染顺序另有来源），数组会引入“同名两项取哪个”的歧义。
export const zcodeMcpListResultSchema = z
  .object({
    statuses: z.record(z.string(), zcodeMcpServerStatusSnapshotSchema),
  })
  .strict();
export type ZCodeMcpListResult = z.infer<typeof zcodeMcpListResultSchema>;

// 插件 UI：UI 发起的 MCP 资源读取与工具调用，
// 按 pluginId 限定 server 归属，agent 侧 fail closed。
// 打开插件 MCP App 实例：scopeId 标出沙箱作用域，ownerWebContentsId 记录发起页面，
// 便于在页面销毁时回收实例。pluginId + serverName 让 agent 侧能校验“这个 server 确实
// 属于该插件”，从而 fail closed 地拒绝跨插件读取（INV-16）。
// accountContext 可选：未登录态也要能打开纯本地资源，缺失即按当前账号处理。
export const zcodeMcpUiOpenInstanceParamsSchema = z
  .object({
    accountContext: z.string().max(256).optional(),
    workspace: zcodeWorkspaceRefSchema,
    sessionId: nonEmptyString,
    pluginId: nonEmptyString,
    serverName: nonEmptyString,
    scopeId: nonEmptyString.max(4096),
    resourceUri: nonEmptyString.max(2048),
    ownerWebContentsId: z.number().int().positive(),
  })
  .strict();
export const zcodeMcpUiOpenInstanceResultSchema = mcpAppInstanceSchema;
export type ZCodeMcpUiOpenInstanceParams = z.infer<typeof zcodeMcpUiOpenInstanceParamsSchema>;
// 插件 UI 的公共作用域片段：instance 标识具体 App 实例，workspace/session/plugin/server
// 四元组把操作钉在“谁的哪一个 server”上。所有 ui* 方法都 spread 这一份，避免某个方法
// 漏掉 sessionId 后变成跨会话可达（INV-16）。
const zcodeMcpUiPluginScopeShape = {
  instance: mcpAppInstanceSchema,

  workspace: zcodeWorkspaceRefSchema,
  sessionId: nonEmptyString,
  pluginId: nonEmptyString,
  serverName: nonEmptyString,
};
// onlyIfIdle 用于页面正常卸载（能等就等，避免打断进行中的调用）；崩溃回收路径不传该
// 标志，直接强制关闭，否则一个卡死的工具调用会让实例永远关不掉、进程泄漏。
export const zcodeMcpUiCloseInstanceParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, onlyIfIdle: z.boolean().optional() })
  .strict();
export const zcodeMcpUiCloseInstanceResultSchema = z.object({ closed: z.boolean() }).strict();
// 宿主侧读 ui:// 资源：结果保留 _meta（其中可能有 csp / prefersBorder 等渲染策略），
// 与插件页面发起的 uiReadResource（刻意剥掉 _meta、受 mime 白名单约束）区分开。
export const zcodeMcpReadResourceParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, uri: nonEmptyString.max(2048) })
  .strict();
export type ZCodeMcpReadResourceParams = z.infer<typeof zcodeMcpReadResourceParamsSchema>;
// 资源内容三选一（text / blob / _meta）不做互斥校验：MCP 规范允许同时给出文本与 blob
// （例如同一资源的两种编码），强行 exclusive 会拒掉合规 server 的返回。
export const zcodeMcpResourceContentSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const zcodeMcpReadResourceResultSchema = z
  .object({ contents: z.array(zcodeMcpResourceContentSchema) })
  .strict();
export type ZCodeMcpReadResourceResult = z.infer<typeof zcodeMcpReadResourceResultSchema>;

/**
 * 插件页面发起的 `resources/read` 代理。
 * 与 `mcp/readResource`（宿主取 ui:// HTML）参数同形，但结果去掉 `_meta`、受 8 MiB 与 mimeType 白名单约束。
 */
// 插件页面读资源：参数与宿主读同形（直接复用同一 schema），但结果去掉 _meta。
// 去掉 _meta 是权限边界——页面不该看到宿主侧的渲染策略与内部标注；结果另受 8MiB 与
// mime 白名单约束（由处理器实现，不在 schema 内，因为白名单需要随用途演进）。
export const zcodeMcpUiReadResourceParamsSchema = zcodeMcpReadResourceParamsSchema;
export type ZCodeMcpUiReadResourceParams = z.infer<typeof zcodeMcpUiReadResourceParamsSchema>;
// 页面侧资源内容：与宿主版结构相同但明确不含 _meta，类型名分开是为了让消费端无法
// 误把带 _meta 的对象当页面结果使用。
export const zcodeMcpUiResourceContentSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
  })
  .strict();
export const zcodeMcpUiReadResourceResultSchema = z
  .object({ contents: z.array(zcodeMcpUiResourceContentSchema) })
  .strict();
export type ZCodeMcpUiReadResourceResult = z.infer<typeof zcodeMcpUiReadResourceResultSchema>;

// 页面发起 sampling：operationId 由宿主生成并随请求/取消成对出现，用于把取消落到
// 具体那一次生成上。request 直接复用 mcp-apps 的 sampling 参数 schema，避免两套定义
// 在模型参数上漂移。
export const zcodeMcpUiSamplingParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    operationId: nonEmptyString.max(128),
    request: mcpAppsSamplingParamsSchema,
  })
  .strict();
// 取消只带作用域 + operationId：不需要重复请求内容，落点由 id 唯一确定；带上原请求
// 反而会让“取消了一个已经开始、内容已变的调用”产生歧义。
export const zcodeMcpUiCancelSamplingParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, operationId: nonEmptyString.max(128) })
  .strict();
export const zcodeMcpUiSamplingResultSchema = mcpAppsSamplingResultSchema;
export type ZCodeMcpUiSamplingParams = z.infer<typeof zcodeMcpUiSamplingParamsSchema>;
export type ZCodeMcpUiCancelSamplingParams = z.infer<typeof zcodeMcpUiCancelSamplingParamsSchema>;

// 页面发起工具调用：callId 由宿主生成，取消时按它精确 abort 到 MCP client。
// arguments 允许缺省（无参工具是常态），但一旦给出必须是对象——数组或标量会让
// server 侧反序列化出难以归因的错误。
export const zcodeMcpUiCallToolParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    toolName: nonEmptyString,
    arguments: z.record(z.string(), z.unknown()).optional(),
    /** 宿主生成的调用 id，配合 `mcp/uiCancelCall` 取消进行中的调用。 */
    callId: nonEmptyString.max(128),
  })
  .strict();
export type ZCodeMcpUiCallToolParams = z.infer<typeof zcodeMcpUiCallToolParamsSchema>;
/** 取消页面发起的工具调用（卡片卸载、会话切换）；agent 侧 abort 到 MCP client。 */
export const zcodeMcpUiCancelCallParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, callId: nonEmptyString.max(128) })
  .strict();
export type ZCodeMcpUiCancelCallParams = z.infer<typeof zcodeMcpUiCancelCallParamsSchema>;
export const zcodeMcpUiCancelCallResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type ZCodeMcpUiCancelCallResult = z.infer<typeof zcodeMcpUiCancelCallResultSchema>;
/** 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe 代理。 */
export const zcodeMcpUiListResourcesParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, cursor: nonEmptyString.max(2048).optional() })
  .strict();
export type ZCodeMcpUiListResourcesParams = z.infer<typeof zcodeMcpUiListResourcesParamsSchema>;
const zcodeMcpUiResourceDescriptorSchema = z
  .object({
    uri: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    // MCP Resource 的标准字段；规范把资源级 csp / prefersBorder 放在这里，宿主读 HTML 项缺 _meta 时回退用。
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
// 列表结果带上 nextCursor：MCP 的分页游标是不透明字符串，协议层不做解析，只透传；
// 消费方拿到 undefined 即表示“没有更多”，不能把空串当结束标志。
export const zcodeMcpUiListResourcesResultSchema = z
  .object({
    resources: z.array(zcodeMcpUiResourceDescriptorSchema),
    nextCursor: z.string().optional(),
  })
  .strict();
export type ZCodeMcpUiListResourcesResult = z.infer<typeof zcodeMcpUiListResourcesResultSchema>;
// 资源模板用 uriTemplate 而非 uri：模板里的 {} 占位由 page 侧展开，宿主只做转发。
// 这里刻意不校验模板语法——不同 server 的扩展语法并不一致，校验会把合法模板判错。
export const zcodeMcpUiListResourceTemplatesResultSchema = z
  .object({
    resourceTemplates: z.array(
      z
        .object({
          uriTemplate: z.string(),
          name: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        })
        .strict(),
    ),
    nextCursor: z.string().optional(),
  })
  .strict();
export type ZCodeMcpUiListResourceTemplatesResult = z.infer<
  typeof zcodeMcpUiListResourceTemplatesResultSchema
>;
/** 订阅者身份 = 会话 + 沙箱作用域 + 实例代际（initId）；dispose 只退订本代际，新实例不受影响。 */
// 订阅作用域比普通 ui 调用多一层 scopeId + generation（INV-16）：订阅是长生命周期的，
// 页面重载后新实例会拿到更大的 generation，旧实例的 dispose 只退订自己那一代，不会把
// 新实例的订阅一起摘掉（否则表现为“页面刚加载就收不到资源变更”）。
export const zcodeMcpUiResourceSubscriptionParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    scopeId: nonEmptyString.max(256),
    generation: z.number().int().nonnegative(),
    uri: nonEmptyString.max(2048),
  })
  .strict();
export type ZCodeMcpUiResourceSubscriptionParams = z.infer<
  typeof zcodeMcpUiResourceSubscriptionParamsSchema
>;
export const zcodeMcpUiResourceSubscriptionResultSchema = z.object({}).strict();
/**
 * App-Provided Tools：实例身份 = 会话 + 沙箱作用域 + 代际（与资源订阅同一三元组）。
 * 登记按实例整体替换；调用认领 / 回传按 callId 幂等。
 */
// App-Provided Tools 的实例身份复用订阅三元组（session + scopeId + generation）：
// 登记按实例整体替换，因此“谁替换了谁”必须由 generation 判定，而不是靠调用顺序。
const zcodeMcpUiAppToolInstanceShape = {
  ...zcodeMcpUiPluginScopeShape,
  scopeId: nonEmptyString.max(256),
  generation: z.number().int().nonnegative(),
};
// 登记是“整体替换”：tools 数组即该实例当前的完整工具集，未出现的旧工具会被注销。
// 上限来自 mcp-apps 常量，避免页面一次注册上千个工具把模型工具表撑爆。
export const zcodeMcpUiRegisterAppToolsParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    tools: z.array(mcpAppsAppToolDescriptorSchema).max(MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE),
  })
  .strict();
export type ZCodeMcpUiRegisterAppToolsParams = z.infer<
  typeof zcodeMcpUiRegisterAppToolsParamsSchema
>;
// 回传的 tools 是该实例“已被宿主接受”的最终清单：name 是模型可见名，modelName 是内部
// 唯一名。之所以要把结果回给页面，是因为重名工具会被宿主改名或剔除，页面若按自己声明的
// 原名构造调用会全部落空；这份回执是页面唯一能感知差异的通道。
export const zcodeMcpUiRegisterAppToolsResultSchema = z
  .object({ tools: z.array(z.object({ name: z.string(), modelName: z.string() }).strict()) })
  .strict();
export type ZCodeMcpUiRegisterAppToolsResult = z.infer<
  typeof zcodeMcpUiRegisterAppToolsResultSchema
>;
// 注销必须带 scopeId + generation：只用一个 scopeId 时，页面重载后的新实例与旧实例路径
// 相同，旧实例晚到的注销会把新实例刚注册的工具删掉（竞态的方向取决于卸载顺序）。
export const zcodeMcpUiUnregisterAppToolsParamsSchema = z
  .object(zcodeMcpUiAppToolInstanceShape)
  .strict();
export type ZCodeMcpUiUnregisterAppToolsParams = z.infer<
  typeof zcodeMcpUiUnregisterAppToolsParamsSchema
>;
export const zcodeMcpUiUnregisterAppToolsResultSchema = z
  .object({ removed: z.number().int().nonnegative() })
  .strict();
export type ZCodeMcpUiUnregisterAppToolsResult = z.infer<
  typeof zcodeMcpUiUnregisterAppToolsResultSchema
>;
// “认领”是宿主 → 页面的方向：宿主先查到工具属于哪个实例，再把调用投递给该页面，
// 页面回 accepted 表示愿意执行。区分认领与执行两步，是为了让页面在不可用时能迅速拒绝，
// 宿主据此立刻走错误路径，而不是等到超时。
export const zcodeMcpUiClaimAppToolCallParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    callId: nonEmptyString.max(MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS),
  })
  .strict();
export type ZCodeMcpUiClaimAppToolCallParams = z.infer<
  typeof zcodeMcpUiClaimAppToolCallParamsSchema
>;
export const zcodeMcpUiAppToolAcceptedResultSchema = z.object({ accepted: z.boolean() }).strict();
export type ZCodeMcpUiAppToolAcceptedResult = z.infer<typeof zcodeMcpUiAppToolAcceptedResultSchema>;
// 回传必须 result 与 error 恰有其一（INV-17）：两者同时出现时无法判定模型该看到成功还是
// 失败；两者都缺则调用永远悬挂。superRefine 把这条互斥规则变成解析期错误，而不是让
// 下游写 if/else 猜。
// callId 幂等：页面重复回传同一 callId 只应生效一次，宿主按 id 去重（见参数侧说明）。
export const zcodeMcpUiResolveAppToolCallParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    callId: nonEmptyString.max(MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS),
    result: mcpAppsAppToolCallResultSchema.optional(),
    error: z
      .object({ message: z.string().max(MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.result === undefined) !== (value.error === undefined), {
    message: "exactly one of result or error is required",
  });
export type ZCodeMcpUiResolveAppToolCallParams = z.infer<
  typeof zcodeMcpUiResolveAppToolCallParamsSchema
>;
// 结果形状与 MCP CallToolResult 对齐：content 是数组（允许一个调用返回多段内容），
// structuredContent 给结构化消费方，isError 是 MCP 语义的“工具自报失败”而非传输失败。
// _meta 在此处保留：它是 server 回给页面的附加信息，不是宿主内部状态。
export const zcodeMcpUiCallToolResultSchema = z
  .object({
    content: z.array(z.record(z.string(), z.unknown())),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ZCodeMcpUiCallToolResult = z.infer<typeof zcodeMcpUiCallToolResultSchema>;

// 导入消息的 id 由导入方指定而非重新生成：重放同一份历史时 id 必须稳定，否则去重失效，
// 同一条消息会在会话里出现两次。role 收敛为 user/assistant——tool 结果走 part，不占 role。
export const zcodeSessionImportMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: timestampMsSchema.optional(),
  })
  .strict();
export type ZCodeSessionImportMessage = z.infer<typeof zcodeSessionImportMessageSchema>;

// 导入历史按 source 判别：fresh 表示原样导入、sharedContext 表示附带证据链的跨项目共享。
// discriminatedUnion 而不是 optional 字段，是因为两种来源的必填项差异很大；用可选字段
// 会让“sharedContext 缺 sha256”这种非法组合蒙混过关，冷恢复时就无法证明内容未被替换
// （INV-18）。provenance 里的三个摘要与 formatterVersion 必须成组出现，缺一即视为不完整。
export const zcodeSessionImportHistorySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("claudeCode"),
      title: z.string().optional(),
      createdAt: timestampMsSchema.optional(),
      updatedAt: timestampMsSchema.optional(),
      messages: z.array(zcodeSessionImportMessageSchema).min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("sharedContext"),
      title: z.string().trim().min(1),
      createdAt: timestampMsSchema.optional(),
      markdown: z.string().min(1),
      provenance: z
        .object({
          shareId: z.string().trim().min(1),
          contextId: z.string().trim().min(1).optional(),
          shareUrl: z.string().url().optional(),
          status: z.enum(["pending", "reserved", "attached", "discarded"]).optional(),
          projectionSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          artifactSetSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          formatterVersion: z.literal(1),
          markdownSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          installedArtifacts: z.array(
            z
              .object({
                artifactId: z.string().trim().min(1),
                workspaceRelativePath: z.string().trim().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict(),
]);
export type ZCodeSessionImportHistory = z.infer<typeof zcodeSessionImportHistorySchema>;

// 思考档位是模型能力的投影：label 给人看、value 才是发给模型的值。这里不校验 value 的
// 取值范围，因为各 provider 的枚举不同，校验应由模型元数据在运行时完成。
export const zcodeThoughtLevelOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
  })
  .strict();
export const zcodeModelReasoningOptionsSchema = z
  .object({
    levels: z.array(zcodeThoughtLevelOptionSchema),
    defaultLevel: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeModelReasoningOptions = z.infer<typeof zcodeModelReasoningOptionsSchema>;

// 从完整模型属性里 pick 出协议需要的子集：pick 而不是重新声明，保证底层字段改名时
// 这里编译期就会报错，而不是运行期静默变成 undefined。
export const zcodeModelFormatPropertiesSchema = completeModelPropertiesDataSchema.pick({
  inputFormat: true,
  outputFormat: true,
});
export type ZCodeModelFormatProperties = z.infer<typeof zcodeModelFormatPropertiesSchema>;

// 模型选项是“可选的展示项 + 能力开关”的组合体：此处若把某能力写成必填，未上报该能力的
// 旧模型会整条消失在下拉框里。因此新能力一律 optional，缺省按“不支持”处理。
export const zcodeModelOptionSchema = z
  .object({
    ref: modelSelectionSchema,
    label: nonEmptyString,
    providerLabel: nonEmptyString.optional(),
    description: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoning: zcodeModelReasoningOptionsSchema.optional(),
    properties: zcodeModelFormatPropertiesSchema,
    disabledReason: z.string().optional(),
  })
  .strict();
export type ZCodeModelOption = z.infer<typeof zcodeModelOptionSchema>;

// 账号权限按 planKind 判别：个人/团队/企业三类的额度字段不同，用 discriminatedUnion
// 能让“企业账号却带个人配额”这种错配在解析期就被拒，而不是在 UI 里显示成 0。
export const zcodeAccountAccessSchema = z.discriminatedUnion("planKind", [
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("start-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("individual-coding-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("team-coding-plan"),
      productId: nonEmptyString,
      organizationId: nonEmptyString,
      projectId: nonEmptyString,
    })
    .strict(),
]);
export type ZCodeAccountAccess = z.infer<typeof zcodeAccountAccessSchema>;

/** Active Model 固定的账号访问类别；当前商品和 Team scope 由账号服务在请求期解析。 */
// provider 维度的账号权限：account 整体可选（未登录也要能配置本地 provider），
// 一旦存在就必须是上面那个判别联合——不能用宽松对象兜底，否则 UI 拿到半截 plan 信息。
export const zcodeProviderAccountAccessSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    // `highspeed` 指加速卡这一账号访问类别（隐藏 Provider + 免签网关），与模型名
    // GLM-5.1-Highspeed 无关，仅字面重合。见 docs/highspeed/highspeed-access-mode-migration.md。
    mode: z.enum([
      "start-plan",
      "individual-coding-plan",
      "team-coding-plan",
      "off-peak",
      "highspeed",
    ]),
    entitled: z.boolean(),
  })
  .strict();
export type ZCodeProviderAccountAccess = z.infer<typeof zcodeProviderAccountAccessSchema>;

export type ZCodeSessionMode = z.infer<typeof zcodeSessionModeSchema>;
export type ZCodeSessionKind = z.infer<typeof zcodeSessionKindSchema>;
export type ZCodeSessionGoal = z.infer<typeof zcodeSessionGoalSchema>;

// 单条 Todo：id 稳定用于原地更新（否则每次状态变化都会新增一行），content 走
// nonEmptyString 以免出现空行占位。优先级/状态是词表枚举，新增取值要同步所有渲染分支。
export const zcodeSessionTodoItemSchema = z
  .object({
    content: nonEmptyString,
    status: z.enum(["pending", "in_progress", "completed"]),
    priority: z.enum(["high", "medium", "low"]),
  })
  .strict();
export const zcodeSessionGoalStatsSchema = z
  .object({
    timeUsedSeconds: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    iterationCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeSessionGoalStats = z.infer<typeof zcodeSessionGoalStatsSchema>;
export type ZCodeSessionGoalVerification = z.infer<typeof zcodeSessionGoalVerificationSchema>;
export type ZCodeSessionGoalVerificationTimeline = z.infer<
  typeof zcodeSessionGoalVerificationTimelineSchema
>;

// Todo 分组：groups 内再嵌 items，是“计划 → 子项”两级结构。层级固定为两级而不是递归，
// 因为 UI 只渲染两层；递归结构会让深层计划在某次渲染中直接消失。
export const zcodeSessionTodoGroupSchema = z
  .object({
    id: nonEmptyString,
    source: z.enum(["goal_iteration", "session"]),
    goalIteration: z.number().int().positive().optional(),
    targetId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema.optional(),
    todos: z.array(zcodeSessionTodoItemSchema),
  })
  .strict();
export type ZCodeSessionTodoGroup = z.infer<typeof zcodeSessionTodoGroupSchema>;

// 会话设置快照：model / thoughtLevel / mode / persistence 等字段全部可选，表示“尚未确定”，
// 由消费端回退到默认值。把某字段改成必填会让较早的 agent 发来的快照整条被拒，UI 因此
// 显示“设置不可用”，但底层会话其实完全正常。
export const zcodeSessionSettingsStateSchema = z
  .object({
    model: z
      .object({
        // 未绑定是合法恢复状态；不能为满足协议而伪造模型或阻断历史读取。
        current: modelSelectionSchema.optional(),
        available: z.array(zcodeModelOptionSchema),
        lastUsed: modelSelectionSchema.optional(),
      })
      .strict(),
    thoughtLevel: z
      .object({
        enabled: z.boolean(),
        current: nonEmptyString.optional(),
        defaultLevel: nonEmptyString.optional(),
        available: z.array(zcodeThoughtLevelOptionSchema),
      })
      .strict(),
    mode: z
      .object({
        current: zcodeSessionModeSchema,
      })
      .strict(),
    permission: z
      .object({
        mode: zcodeSessionModeSchema.optional(),
        rulesRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionSettingsState = z.infer<typeof zcodeSessionSettingsStateSchema>;
// 待决权限是快照的一部分（而不是只存在于事件流）：重连或冷启动后 UI 必须能重建“还有一个
// 权限请求没回答”，否则用户会看到会话卡住却没有任何可点的按钮。
// 这里保留完整 options，是为了让快照与 permission/requested 事件同构，UI 只写一份渲染。
export const zcodePendingPermissionSchema = z
  .object({
    requestId: nonEmptyString,
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown().optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
    requestedAt: timestampMsSchema,
  })
  .strict();
export type ZCodePendingPermission = z.infer<typeof zcodePendingPermissionSchema>;

// 进行中的工具调用也是快照字段：崩溃恢复后 UI 需要知道“哪次调用没回来”，
// 并据此展示为中断而不是永久 spinner。toolName 保留原始名，便于用户判断影响面。
export const zcodeActiveToolCallSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    status: z.enum(["pending", "running", "completed", "failed", "denied"]),
    startedAt: timestampMsSchema.optional(),
  })
  .strict();
export type ZCodeActiveToolCall = z.infer<typeof zcodeActiveToolCallSchema>;

// 会话投影 = 可由事件流重建出的“当前视图”之超集：messages、todos、settings、待决权限、
// 进行中工具调用、usage 等。它存在的意义是让新连接的客户端不必重放全部历史就能渲染，
// 因此这里新增字段必须是“可从历史推导的冗余”，不能塞入只在某一瞬间成立的状态。
// 字段全部可选：不同版本的 agent 提供的投影粒度不同，缺项由消费端按默认值补齐。
export const zcodeSessionProjectionSchema = z
  .object({
    sessionId: nonEmptyString,
    status: zcodeSessionStatusSchema,
    mode: zcodeSessionModeSchema,
    turnCount: z.number().int().nonnegative(),
    totalTokenCount: z.number().int().nonnegative(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    currentTurnId: nonEmptyString.optional(),
    pendingPermissions: z.array(zcodePendingPermissionSchema),
    activeToolCalls: z.array(zcodeActiveToolCallSchema),
    backgroundJobs: z.array(jsonObjectSchema),
    target: zcodeSessionGoalSchema.nullable().optional(),
    lastError: z
      .object({
        type: nonEmptyString,
        code: nonEmptyString.optional(),
        message: nonEmptyString,
        detail: z.string().optional(),
        attribution: errorAttributionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionProjection = z.infer<typeof zcodeSessionProjectionSchema>;
export type ZCodeToolState = z.infer<typeof zcodeToolStateSchema>;
// 斜杠命令来自扩展目录，name 与 description 都直接展示给用户；source 标明来源（内置/
// 插件/项目），用于在重名时决定谁覆盖谁——协议层只透传，不实现优先级。
export const zcodeSlashCommandSchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    inputHint: z.string().optional(),
    source: z.enum(["builtin", "custom"]).optional(),
  })
  .strict();
export type ZCodeSessionApiRetryStatus = z.infer<typeof zcodeSessionApiRetryStatusSchema>;
export type ZCodeSessionContextUsage = z.infer<typeof zcodeSessionContextUsageSchema>;
// 流式类型词表：start/delta/end/error 是四种不可合并的语义。用 kind 而不是布尔
// “是否结束”，是为了让消费端一个 switch 就能穷尽处理，漏一种会在编译期暴露。
export const zcodeModelStreamingKindSchema = z.enum([
  "start",
  "finish",
  "error",
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
]);
// 流式载荷按 kind 三态（delta / usage / done）：usage 可能在中途单独出现，done 必须
// 携带终止原因。把 usage 并入 delta 会让“只统计不产出”的帧看起来像空增量。
export const zcodeModelStreamingEventPayloadSchema = z
  .object({
    assistantMessageId: z.string().optional(),
    delta: z.string().optional(),
    done: z.boolean().optional(),
    input: z.unknown().optional(),
    kind: zcodeModelStreamingKindSchema,
    partId: z.string().optional(),
    providerExecuted: z.boolean().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();
// 会话状态快照（session/state）：projection + 会话元信息的一次性合并，用于首帧渲染。
// 与 session/subscribe 的关系是“先给全量、再走增量”，因此这里必须自洽：任何字段都不能
// 依赖后续事件才能解释，否则首帧会渲染出中间态。
export const zcodeSessionStateSnapshotSchema = z
  .object({
    protocol: z
      .object({
        name: z.literal(ZCODE_PROTOCOL_NAME),
        version: z.literal(ZCODE_PROTOCOL_VERSION),
      })
      .strict(),
    session: zcodeSessionInfoSchema,
    settings: zcodeSessionSettingsStateSchema,
    projection: zcodeSessionProjectionSchema,
    runtime: zcodeSessionRuntimeStateSchema,
    messages: z.array(zcodeMessageWithPartsSchema),
    goalStats: zcodeSessionGoalStatsSchema.optional(),
    todos: z.array(zcodeSessionTodoItemSchema).optional(),
    todoGroups: z.array(zcodeSessionTodoGroupSchema).optional(),
    slashCommands: z.array(zcodeSlashCommandSchema).optional(),
  })
  .strict();
export type ZCodeSessionStateSnapshot = z.infer<typeof zcodeSessionStateSnapshotSchema>;

// 事件信封：sessionId 锁定归属、seq 提供排序（只校验非负，单调性由生产者保证，见 INV-23）、
// ts 供展示。信封刻意不带 session 事件的具体 type——由内层 payload 自己判别，避免同一条
// 事件出现“信封 type 与 payload type 不一致”的第二事实源。
export const zcodeEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    seq: z.number().int().nonnegative(),
    traceId: nonEmptyString.optional(),
    timestamp: timestampMsSchema,
    deliveryKind: zcodeDeliveryKindSchema.optional(),
  })
  .strict();

// Computer Use 事件与普通会话事件是两个独立流：它们复用同一个外层信封，但 payload 用
// 自己的 kind 判别。这样 UI 可以只订阅自己关心的那条流，而不必解析另一类事件。
const zcodeComputerUseOperationEventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    sequenceNumber: z.number().int().nonnegative(),
    sessionId: nonEmptyString,
    timestamp: timestampMsSchema,
  })
  .strict();

const zcodeComputerUseTurnStartedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-started"),
  turnId: nonEmptyString,
});
const zcodeComputerUseTurnCompletedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-completed"),
  turnId: nonEmptyString,
});
const zcodeComputerUseTurnFailedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-failed"),
  turnId: nonEmptyString,
});
const zcodeComputerUseToolScheduledEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-scheduled"),
  turnId: nonEmptyString,
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  // 这个 cell 是否在用 Computer Use。只表达布尔事实，不再携带动作名——旧的
  // operationAction 靠从模型源码里抽取动作名得到，SDK 面一变就整体失配（见
  // bootstrap/src/zcode-protocol/computer-use-operation-event.ts 的 usesComputerUse）。
  // 只挂在 scheduled 上：ToolCallStartedPayload 没有 input，start 时已拿不到模型源码。
  computerUse: z.literal(true).optional(),
});
const zcodeComputerUseToolStartedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-started"),
  turnId: nonEmptyString.optional(),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString.optional(),
});
const zcodeComputerUseSessionClosedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("session-closed"),
});

// 七种 Computer Use 事件按 kind 封闭判别：turn 级（started/completed/failed）、tool 级
// （scheduled/started）与 session 级（closed）。新增 kind 必须在下方 union 同步登记，
// 否则该事件会被当作未知类型整条丢弃（表现为操作进度突然停住）。
export const zcodeComputerUseOperationEventSchema = z.discriminatedUnion("kind", [
  zcodeComputerUseTurnStartedEventSchema,
  zcodeComputerUseTurnCompletedEventSchema,
  zcodeComputerUseTurnFailedEventSchema,
  zcodeComputerUseToolScheduledEventSchema,
  zcodeComputerUseToolStartedEventSchema,
  zcodeComputerUseSessionClosedEventSchema,
]);
export type ZCodeComputerUseOperationEvent = z.infer<typeof zcodeComputerUseOperationEventSchema>;

// 会话事件类型全集（INV-05）：这个枚举是“事件流能表达什么”的封闭定义，任何一处
// z.literal 与之失配，对应事件类就会在解析阶段整体消失。新增类型需同时改：
// ① 本枚举；② zcodeSessionEventSchema 的 union 分支；③ 消费端 switch。
export const zcodeSessionEventTypeSchema = z.enum([
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "userInput.requested",
  "userInput.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
]);
export type ZCodeSessionEventType = z.infer<typeof zcodeSessionEventTypeSchema>;

// 错误明细：code 是给程序分流的稳定枚举，message 给人看，details 保持 unknown 供特定
// 方法补充结构化信息。三者分工明确——把结构化信息塞进 message 会让 UI 只能正则解析，
// 把 code 换成文本则会破坏调用方的分支判断。
export const zcodeProtocolErrorDetailSchema = z
  .object({
    type: nonEmptyString,
    message: nonEmptyString,
    stack: z.string().optional(),
    code: z.string().optional(),
    detail: z.string().optional(),
    underlyingErrorMessage: z.string().optional(),
    underlyingErrorDetail: z.string().optional(),
    attribution: errorAttributionSchema.optional(),
    retryable: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .strict();
// session/created：只带“新会话的初始渲染参数”（mode + contextWindow），不带历史。
// 让“创建成功”与“快照可用”解耦：UI 收到 created 就能切过去并开始订阅，不必等一次
// 可能较慢的全量读取；contextWindow 随事件下发，避免 UI 再发一轮元数据查询。
export const zcodeSessionCreatedEventPayloadSchema = z
  .object({
    mode: zcodeSessionModeSchema,
    contextWindow: z.number().int().nonnegative(),
  })
  .strict();
// session/resumed：恢复既有会话。与 created 分开而不是共用一个事件 + 标志位，是因为
// 两者在 UI 上的副作用不同（恢复要重建历史滚动位置，创建要清空输入框）。
export const zcodeSessionResumedEventPayloadSchema = z
  .object({
    directory: nonEmptyString,
    interruptedToolCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    partCount: z.number().int().nonnegative(),
    recoveredCompactTimelineCount: z.number().int().nonnegative().optional(),
    recoveredSteerInputCount: z.number().int().nonnegative().optional(),
    resumedTodoCount: z.number().int().nonnegative().optional(),
  })
  .strict();
// 标题可由 agent 自动生成后回填，因此这是“更新”而不是“创建时确定”：UI 侧必须支持
// 原地改名且不重置会话列表排序（排序键不是 title）。
export const zcodeSessionTitleUpdatedEventPayloadSchema = z
  .object({
    messageID: nonEmptyString.optional(),
    previousTitle: z.string(),
    source: z.enum(["default", "first_input", "generated", "custom"]),
    title: z.string(),
  })
  .strict();
// turn/started 是“一轮开始”的唯一权威信号：UI 据此清空流式缓冲、创建助手占位消息。
// inputSource 同时承载用户输入来源与 steer 来源（见上方既有说明），务必保持同一词表，
// 否则实时事件能过、重放历史被拒。
// 这里不下发 prompt 原文：正文走 message/part 增量，重复携带会让大输入在每条事件里膨胀。
export const zcodeTurnStartedEventPayloadSchema = z
  .object({
    // CLI 的高精度执行时间可含小数；漏声明会使 strict 校验丢弃整条开始事件，Bot 因此无法清空上一轮回复。
    executionStartedAt: z.number().nonnegative().optional(),
    turnNumber: z.number().int().nonnegative(),
    input: z.string(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    inputSource: zcodeTurnInputSourceSchema.optional(),
    inputVisibility: zcodeMessageVisibilitySchema.optional(),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    targetId: nonEmptyString.optional(),
    messageId: nonEmptyString.optional(),
    foregroundExecutionId: nonEmptyString.optional(),
    intent: jsonObjectSchema.optional(),
    originMeta: jsonObjectSchema.optional(),
    // runtime 会透传后台唤醒来源，strict schema 必须同步声明以免丢弃整条事件。
    backgroundSource: z.enum(["bash", "subagent"]).optional(),
    attachments: z.array(jsonObjectSchema).optional(),
  })
  .strict();
const zcodeTurnSteerSourceSchema = z.enum(["plan_approval_feedback", "workflow_refine_feedback"]);
const zcodeTurnSteerCommandKindSchema = z.enum(["sendText", "sendGoalCommand", "compact"]);
const zcodeTurnSteerDeliverySchema = z.enum(["queue", "guide"]);

// steer 入队：用户在生成过程中追加指令。queue 与 guide 的区别是“排队等下个边界”还是
// “立即插入当前上下文”，因此必须显式带 delivery，不能由 UI 猜测。
export const zcodeTurnSteerQueuedEventPayloadSchema = z
  .object({
    pendingInputId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    input: z.string(),
    inputPreview: z.string(),
    inputSize: z.number().int().nonnegative(),
    commandKind: zcodeTurnSteerCommandKindSchema.optional(),
    source: zcodeTurnSteerSourceSchema.optional(),
    toolDisallowlist: z.array(nonEmptyString).optional(),
    delivery: zcodeTurnSteerDeliverySchema.optional(),
    targetTurnId: nonEmptyString,
    queueLength: z.number().int().nonnegative(),
    intent: jsonObjectSchema.optional(),
  })
  .strict();
// steer 出队：表示某条已入队的指令被真正消费（拼进提示或写入历史）。没有这个事件，
// 队列长度只能靠 UI 自己推算，一旦漏收 queued 就会永久显示“还有待处理指令”。
export const zcodeTurnSteerDrainedEventPayloadSchema = z
  .object({
    pendingInputIds: z.array(nonEmptyString),
    queryIds: z.array(nonEmptyString).optional(),
    targetTurnId: nonEmptyString,
    injectedMessageIds: z.array(nonEmptyString),
    drainedInputs: z
      .array(
        z
          .object({
            pendingInputId: nonEmptyString,
            messageId: nonEmptyString,
            text: z.string(),
            delivery: zcodeTurnSteerDeliverySchema.optional(),
            intent: jsonObjectSchema.optional(),
            toolDisallowlist: z.array(nonEmptyString).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
// turn/completed 携带 usage 与终止原因：UI 据此结算 token 展示并把输入框恢复可用。
// 与 turn/failed 分离而不是共用一个事件 + ok 字段，是为了让“正常结束”这条最高频路径
// 不必携带错误分支的可选字段（strict 下每个可选字段都是维护成本）。
export const zcodeTurnCompletedEventPayloadSchema = z
  .object({
    response: z.string(),
    tokenCount: z.number().int().nonnegative(),
    usage: z.unknown().optional(),
    toolCallCount: z.number().int().nonnegative(),
    historyRoundCount: z.number().int().nonnegative().optional(),
    duration: z.number().nonnegative(),
    // runtime turn.completed 会附带 cacheStats，协议 schema 之前漏掉该字段。
    // strict 校验失败会让桌面端丢掉终态事件，表现为消息已完成但 UI 一直没有回复。
    cacheStats: z
      .object({
        totalMessages: z.number().int().nonnegative(),
        cachedMessages: z.number().int().nonnegative(),
        lastCacheHit: z.boolean(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    inputId: nonEmptyString.optional(),
    resultType: z.enum([
      "success",
      // "cancelled": 用户主动中断属于正常结束，复用 turn.completed 上报，避免被映射成 turn.failed。
      "cancelled",
      "error_max_turns",
      "error_max_budget",
      "error_during_execution",
      "error_max_tool_calls",
    ]),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();
// turn/failed：失败必须能被归类（error.type + retryable），否则 UI 只能给一个红色横幅。
// 该事件是可重试判定的唯一来源——不要由 UI 根据错误文本猜，文本会随 provider 变化。
export const zcodeTurnFailedEventPayloadSchema = z
  .object({
    error: zcodeProtocolErrorDetailSchema,
    turnPhase: z.string(),
    inputId: nonEmptyString.optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();
// message/upserted 承载消息头的最终状态（role、时间、统计），正文由 part 系列增量维护。
// 用 “upsert” 而非 “created”，是因为同一 id 会被多次修订（例如元信息补全），
// 消费端按 id 覆盖即可，不需要区分首现与更新。
export const zcodeMessageUpsertedEventPayloadSchema = z
  .object({
    content: z.string(),
    attachments: z.array(z.unknown()).optional(),
    toolCalls: z.array(z.unknown()).optional(),
    type: z.string().optional(),
    compactBoundary: z.unknown().optional(),
  })
  .strict();
// 删除是硬删除：撤回、重放纠错都走这里。协议层不带原因码，因为删除后没有可回滚的
// 中间态，原因只用于日志——把它塞进事件会让协议多一个无法校验的自由文本字段。
export const zcodeMessageRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();
// part 增量是流式的唯一高频通道：delta 只追加，不做替换。若允许“替换语义”，
// 丢一帧就会让后续内容错位；只追加则丢帧最多是局部缺字，且可由 upserted 修正。
export const zcodeMessagePartDeltaEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    field: z.enum(["text", "reasoning", "input", "output"]).optional(),
    delta: z.string(),
  })
  .strict();
// part 全量写入：用于流式结束后的校正与工具结果的整块落盘。它是 delta 的“纠偏器”，
// 因此必须携带完整内容而不是 diff——delta 丢帧后唯一能自愈的路径就是这里。
export const zcodeMessagePartUpsertedEventPayloadSchema = z
  .object({
    part: zcodeMessagePartSchema,
  })
  .strict();
// part 删除：工具结果重试、内容撤回时使用。按 (messageId, partId) 定位，
// 不支持按类型批量删除——批量删除会让一条畸形事件清空整条消息的多个片段。
export const zcodeMessagePartRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();
// 工具调用事件的公共底座：id + 名称 + 参数。抽出来是为了让 update/output/error 三类
// 分支共享同一组定位字段，消费端可以先用底座字段把事件归位到某次调用，再按 kind 处理。
const zcodeToolCallBasePayloadSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: z.string().optional(),
    parentToolCallId: nonEmptyString.optional(),
    source: z.enum(["subagent"]).optional(),
    agentId: nonEmptyString.optional(),
    agentType: nonEmptyString.optional(),
    // subagent mirror 会携带后台归因；strict schema 漏字段会让 session/event 整条被丢弃。
    background: z.boolean().optional(),
    childSessionId: nonEmptyString.optional(),
    childToolCallId: nonEmptyString.optional(),
    description: z.string().optional(),
  })
  .strict();

// 工具调用按 kind 判别：update（进度/部分输出）、output（最终结果）、error（失败）。
// 三者分开而不用一个“状态 + 可选字段”的对象，是因为 output 与 error 的载荷形状差异大，
// 合并后 strict 会逼出大量互斥可选字段，反而更容易发出自相矛盾的事件。
// display 只出现在 output 分支，且经过 zcodeToolResultObjectSchema 的 kind 分派校验。
export const zcodeToolUpdatedEventPayloadSchema = z.discriminatedUnion("kind", [
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("scheduled"),
      // 修复：CLI 调度事件已携带所属消息 ID；漏声明会让严格校验丢弃整条事件。
      assistantMessageId: nonEmptyString.optional(),
      toolName: nonEmptyString,
      input: z.unknown().optional(),
      inputByteLength: z.number().int().nonnegative().optional(),
      inputOmitted: z.boolean().optional(),
      inputRef: z.literal("model_stream").optional(),
      dependencies: z.array(nonEmptyString).optional(),
      parallelGroupIndex: z.number().int().nonnegative().optional(),
      canRunParallel: z.boolean().optional(),
      schedule: jsonObjectSchema.optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("started"),
      startedAt: protocolInstantSchema,
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("progress"),
      elapsedMs: z.number().nonnegative().optional(),
      pid: z.number().int().optional(),
      stdoutBytes: z.number().int().nonnegative().optional(),
      stderrBytes: z.number().int().nonnegative().optional(),
      outputBytes: z.number().int().nonnegative().optional(),
      outputPreview: executionOutputPreviewSchema.optional(),
      stdoutTail: z.string().optional(),
      stderrTail: z.string().optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("result"),
      result: zcodeToolResultObjectSchema,
      duration: z.number().nonnegative(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("error"),
      error: zcodeProtocolErrorDetailSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch"),
      toolCallIds: z.array(nonEmptyString),
      successCount: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("raw"),
      payload: jsonObjectSchema,
    })
    .strict(),
]);
// 权限请求必须自带可选项（options 至少一项），否则用户无路可走；同时保留 toolName 与
// 入参摘要，让 UI 在弹出确认前就能展示“正在请求什么”。requestId 是回答时的唯一键。
export const zcodePermissionRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    reason: z.string(),
    input: z.unknown(),
    suggestedPermissionUpdates: z.array(zcodePermissionUpdateSchema).optional(),
    approvalMode: z.literal("user-once").optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();
// 权限解决事件把“用户选了什么”回灌给所有观察者（包括其他窗口），因此必须带
// optionId 与最终 response：只有其中之一时，其他窗口无法知道是否该关闭自己的弹窗。
export const zcodePermissionResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    decision: zcodePermissionDecisionSchema.optional(),
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    inputSummary: z.unknown().optional(),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();
// 用户输入请求：一次携带完整 questions 列表，减少“问一个等一个”的往返。协议只保证
// 形状（每题有 id 与 options），题目之间的依赖由发起方自己编排——协议层做依赖校验
// 会把可并行的问卷强行串行化。requestId 用于和 resolved 配对，缺失时按 toolCallId 配对。
export const zcodeUserInputRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    prompt: z.string(),
    inputType: z.enum(["text", "choice", "confirm"]).optional(),
    choices: z.array(z.string()).optional(),
  })
  .strict();
// 无论用户回答还是取消，都必须落一条 resolved：只有 resolved 能让发起方区分“用户还没答”
// 与“回答消息丢了”。cancelled=true 与空 answers 不是同义——前者表示用户主动放弃，
// 后者可能是只答了部分题目；压成一种会让 UI 把放弃误判成“还有题待答”。
export const zcodeUserInputResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    value: z.unknown().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();
// 会话关闭是事件流的终点信号：此后不应再有该 sessionId 的事件。带 reason 让 UI 区分
// “用户主动关闭”与“进程回收/崩溃恢复”，后者需要提示会话可恢复，前者不需要。
export const zcodeSessionClosedEventPayloadSchema = z
  .object({
    reason: z.string().optional(),
  })
  .strict();

// 泛型工厂：把 “type 字面量 + payload schema” 组装成统一的 {type, payload} 事件体，
// 并让 type 与 payload 在类型层一一对应（传错组合会编译失败）。用工厂而不是为每个事件
// 手写 extend，是为了让所有事件的 envelope 结构逐字节一致——任何一处结构差异都会在
// strict 校验下变成“某一类事件悄悄消失”，而不是解析报错。
function zcodeSessionEventEnvelopeFor<T extends ZCodeSessionEventType>(
  type: T,
  payload: z.ZodTypeAny,
) {
  return zcodeEventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: payload.optional(),
  });
}

// 会话事件总表（INV-05）：每个分支都必须是上面工厂的产物，且 type 必须出现在
// zcodeSessionEventTypeSchema 中。漏登记一个分支的后果不是报错，而是该类事件在解析时
// 被判为未知类型并被整条丢弃——表现为“某些界面元素永远不更新”。
// 这里不按“高频在前”排序：判别靠唯一字面量 type，顺序只影响报错信息里先试哪个分支。
export const zcodeSessionEventSchema = z.discriminatedUnion("type", [
  zcodeSessionEventEnvelopeFor("session.created", zcodeSessionCreatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.resumed", zcodeSessionResumedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.updated", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("session.titleUpdated", zcodeSessionTitleUpdatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.closed", zcodeSessionClosedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.started", zcodeTurnStartedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.steerQueued", zcodeTurnSteerQueuedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.steerDrained", zcodeTurnSteerDrainedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.completed", zcodeTurnCompletedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.failed", zcodeTurnFailedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("message.upserted", zcodeMessageUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("message.removed", zcodeMessageRemovedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.started", zcodeMessagePartUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.delta", zcodeMessagePartDeltaEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.upserted", zcodeMessagePartUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.removed", zcodeMessagePartRemovedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("model.streaming", zcodeModelStreamingEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("tool.updated", zcodeToolUpdatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("permission.requested", zcodePermissionRequestedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("permission.resolved", zcodePermissionResolvedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("userInput.requested", zcodeUserInputRequestedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("userInput.resolved", zcodeUserInputResolvedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("checkpoint.created", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("rewind.triggered", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("streamRecovery.updated", jsonObjectSchema),
]);
export type ZCodeSessionEvent = z.infer<typeof zcodeSessionEventSchema>;

// 历史事件分页：nextCursor 是不透明游标，只由服务端解释。协议层不校验“事件必须按 seq
// 升序”——一条乱序数据不应该让整页被拒；排序由消费端在合并时按 seq 处理（见 INV-23）。
export const zcodeSessionEventsResultSchema = z
  .object({
    events: z.array(zcodeSessionEventSchema),
  })
  .strict();
// 消息分页：判断“是否还有更多”只能看 nextCursor，不能看数组是否为空——最后一页可能
// 恰好落在空窗口上。消息体不含流式增量，读取方拿到的是稳定态，避免半截文本被渲染。
export const zcodeSessionMessagesResultSchema = z
  .object({
    messages: z.array(zcodeMessageWithPartsSchema),
  })
  .strict();
// 状态更新通知的 scope 决定必填项（INV-24）：workspace 级必须带 workspace 标识、
// session 级必须带 sessionId；两者都带时以 session 为准。若允许“都缺”，投影会被应用到
// 当前活跃会话——在多窗口场景下就是渲染出一份别人的状态。
// 不用 discriminatedUnion，是因为 scopes 里还存在同时覆盖多层的合法形态。
export const zcodeStateUpdatedNotificationSchema = z
  .object({
    type: z.literal("state.updated"),
    scope: z.enum(["server", "workspace", "session"]),
    workspace: zcodeWorkspaceRefSchema.optional(),
    sessionId: nonEmptyString.optional(),
    revision: z.number().int().nonnegative(),
    reason: z.string().optional(),
    patch: z.unknown(),
  })
  .strict();
export type ZCodeStateUpdatedNotification = z.infer<typeof zcodeStateUpdatedNotificationSchema>;

// 订阅参数：sessionId 必填，sinceSeq 可选。不带 sinceSeq 表示“从现在开始”，
// 带它表示断线续传——服务端据此只补发漏掉的事件。两者的差别必须在协议里显式表达，
// 否则重连时无法区分“全新订阅”与“补发”，会导致要么重复渲染、要么漏事件。
export const zcodeSessionSubscribeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zcodeDeliveryKindSchema,
    afterSeq: z.number().int().nonnegative().optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export type ZCodeSessionSubscribeParams = z.infer<typeof zcodeSessionSubscribeParamsSchema>;

// 订阅确认：accepted 表示当前连接已接入事件流，subscribedFromSeq 告诉客户端“从哪一条
// 开始会收到”。客户端据此校准本地游标，否则续传窗口的首尾会各丢或多一条。
export const zcodeSessionSubscribeResultSchema = z
  .object({
    sessionId: nonEmptyString,
    eventSeq: z.number().int().nonnegative(),
    events: z.array(zcodeSessionEventSchema),
    snapshot: zcodeSessionStateSnapshotSchema.optional(),
  })
  .strict();
// 会话列表：sessions 只含元信息（标题、时间、状态），不含消息体。列表页可能同时存在
// 上百个会话，携带正文会让一次刷新产生数量级更大的传输；需要正文的场景走按 id 读取。
export const zcodeSessionListResultSchema = z
  .object({
    sessions: z.array(zcodeSessionInfoSchema),
  })
  .strict();

// 子会话公共底座：id 与父会话 id 构成归属关系。抽公共字段是为了让 running/ended 两个
// 分支不会各自演进——父会话回收子会话时按这两个字段定位，字段漂移会导致残留子进程。
const zcodeSessionSubagentBaseSchema = z
  .object({
    childSessionId: nonEmptyString,
    agentId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    subagentType: nonEmptyString,
    title: nonEmptyString,
    summary: z.string().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

// running 分支：运行中的子会话只有“最近活动时间”这类摘要信息，不能要求输出内容——
// 要求了就只能在运行期填占位符，反而让 UI 无法区分“还没输出”与“输出为空”。
export const zcodeSessionRunningSubagentSchema = zcodeSessionSubagentBaseSchema.extend({
  status: z.enum(["running", "waiting", "blocked"]),
});
export type ZCodeSessionRunningSubagent = z.infer<typeof zcodeSessionRunningSubagentSchema>;

// ended 分支必须带结束原因：缺了它，UI 只能显示“已结束”，用户无法判断该重试还是该放弃，
// 也无法在日志里把“正常完成”与“被父会话终止”区分开。
export const zcodeSessionEndedSubagentSchema = zcodeSessionSubagentBaseSchema.extend({
  status: z.enum(["success", "failed", "cancelled", "lost"]),
});
export type ZCodeSessionEndedSubagent = z.infer<typeof zcodeSessionEndedSubagentSchema>;

// 结果按 running / ended 两组返回，而不是一个带 status 的数组：这样 UI 直接渲染两块，
// 不必先过滤再分组；也避免“已结束”的条目在列表中反复换位造成视觉跳动。
export const zcodeSessionSubagentsResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    childSessionIds: z.array(nonEmptyString),
    running: z.array(zcodeSessionRunningSubagentSchema),
    ended: z
      .object({
        total: z.number().int().nonnegative(),
        items: z.array(zcodeSessionEndedSubagentSchema),
        nextCursor: nonEmptyString.optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodeSessionSubagentsResult = z.infer<typeof zcodeSessionSubagentsResultSchema>;
/** 服务端 feature key 的取值域在协议里的 zod 形态（packages/shared/src/dynamic-workflow-feature.ts）。 */
// 动态工作流模式直接引用共享常量 DYNAMIC_WORKFLOW_MODES，而不是在这里重抄字面量：
// 两侧各写一份必然漂移，漂移的后果是某个模式在 UI 里可选、agent 却判为非法。
export const zcodeDynamicWorkflowModeSchema = z.enum(DYNAMIC_WORKFLOW_MODES);

// 建会话参数：归属由 workspace 描述（内含项目路径），必须由调用方显式给出——让服务端
// 自己推断目录会出现在多窗口场景下把会话建到错误项目的问题。sessionId 可选，允许调用方
// 预留 id 以便后续关联；新增字段一律 optional（INV-03），否则旧 CLI 的整条请求会被拒。
export const zcodeSessionCreateParamsSchema = z
  .object({
    additionalDirectories: z.array(nonEmptyString).max(256).optional(),
    sessionId: nonEmptyString.optional(),
    workspace: zcodeWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    mode: zcodeSessionModeSchema.optional(),
    model: modelSelectionSchema.optional(),
    persistence: zcodeSessionPersistenceSchema.optional(),
    thoughtLevel: nonEmptyString.optional(),
    titleGenerationEnabled: z.boolean().optional(),
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    importedHistory: zcodeSessionImportHistorySchema.optional(),
    // host 只按本地服务装配/远程/端形态决定是否注册工具，不读取灰度；
    // 缺省不下发 = 不注册；灰度与套餐准入在实际创建的 Host handler 校验。
    offPeakToolEnabled: z.boolean().optional(),
    // 动态工作流灰度：与 offPeakToolEnabled 同一
    // 模式——host 裁决后下发，缺省不下发 = 不注册工作流工具簇（fail-closed）。
    dynamicWorkflowEnabled: z.boolean().optional(),
    // 灰度 mode 随布尔同行下发（launch.md「On demand: activation」）：`onDemand` 让 CLI 把十个
    // 工具推迟到会话首次 `/workflow` 才注册；缺席 = 按布尔行事（alwaysOn），供旧 Host 配对。
    dynamicWorkflowMode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZCodeSessionCreateParams = z.infer<typeof zcodeSessionCreateParamsSchema>;

// 恢复会话：sessionId 必填，workspace 可选但一旦给出就是归属校验——服务端据此确认该
// 会话确实属于这个 workspace，防止任何窗口凭 id 读到别的项目历史（跨项目越权读取）。
// additionalDirectories 用于恢复时重新挂载会话曾用过的额外目录，缺失即按历史记录还原。
export const zcodeSessionResumeParamsSchema = z
  .object({
    additionalDirectories: z.array(nonEmptyString).max(256).optional(),
    sessionId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema.optional(),
    // 旧 session 尚无 runtime/model_selection entry 时，由同 task 的索引元数据提供迁移 hint。
    thoughtLevel: nonEmptyString.optional(),
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // 冷恢复重建 runtime 时必须沿用 create 的工具面约束（否则会绕过 allow/deny，尤其 CUA 会话）。
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    // 与 create 同语义；resume 不带会导致冷恢复丢 Off-Peak 工具面。
    offPeakToolEnabled: z.boolean().optional(),
    // 与 create 同语义；resume 不带会导致冷恢复丢工作流工具簇。
    dynamicWorkflowEnabled: z.boolean().optional(),
    dynamicWorkflowMode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZCodeSessionResumeParams = z.infer<typeof zcodeSessionResumeParamsSchema>;

// 列表参数：directory 可选——省略表示“所有 workspace”。limit 可选是因为全量列表在
// 长期使用后可能上千条，调用方需要能主动截断；截断语义由服务端实现，协议只透传。
export const zcodeSessionListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema.optional(),
    sessionIds: z.array(nonEmptyString).min(1).max(64).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionListParams = z.infer<typeof zcodeSessionListParamsSchema>;

// 子会话查询必须带父会话 sessionId：子会话列表本质上是父会话的内部结构，
// 不带父 id 的查询会让任意窗口枚举到别人的子任务（信息泄漏），也无法判断回收时机。
export const zcodeSessionSubagentsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    endedCursor: nonEmptyString.optional(),
    endedLimit: z.number().int().positive().max(100).default(20),
  })
  .strict();
export type ZCodeSessionSubagentsParams = z.infer<typeof zcodeSessionSubagentsParamsSchema>;

// 统计窗口用 range 枚举而不是起止时间戳：把“最近 7/30 天”这类窗口在协议层归一，
// 两端才不会对“一天从几点开始”各有一套理解。timeZone 由调用方显式给出，因为同一账号
// 可能跨时区使用，服务端不能假定本机时区。
export const zcodeUsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export const zcodeUsageStatsResultSchema = appUsageSnapshotSchema;
// 按 sessionId 汇总该会话的 token 消耗：入参只保留这一个字段，是为了让高频刷新的用量
// 面板不必构造窗口参数；更细的时间切片走 usage 统计那条链路，两者职责不重叠。
export const zcodeTaskTokenUsageParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();
// 分阶段计数：input/output/cache 分开而不是只给总量，因为缓存命中与未命中的成本差一个
// 数量级。“未发生”用字段缺席表达，不要补 0——补 0 后“没调用”与“用了 0 token”无法区分。
export const zcodeTaskTokenUsageResultSchema = z
  .object({
    sessionId: nonEmptyString,
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type ZCodeTaskTokenUsageResult = z.infer<typeof zcodeTaskTokenUsageResultSchema>;

// 读取会话：includeMessages 默认关闭。打开它等于把整段历史一次性拉进内存与 IPC，
// 而绝大多数调用方只想要会话元信息；需要正文的调用方应先分页读消息，再按需拼装。
export const zcodeSessionReadParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zcodeDeliveryKindSchema.optional(),
    messageLimit: z.number().int().positive().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
    // "index"：仅 task index resync 使用，返回剥离 tool/reasoning/data URL 大载荷的同结构 snapshot，
    // 结果禁止回写 UI 状态；缺省等同 "full"。
    contentProfile: z.enum(["full", "index"]).optional(),
  })
  .strict();
export type ZCodeSessionReadParams = z.infer<typeof zcodeSessionReadParamsSchema>;

// 消息分页只用 messageId 作游标，不用下标偏移：会话在并发追加时长度不断变化，
// 偏移量会导致翻页过程中重复读到或整条漏读。游标是不透明值，由服务端解释方向。
export const zcodeSessionMessagesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterMessageId: nonEmptyString.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionMessagesParams = z.infer<typeof zcodeSessionMessagesParamsSchema>;

// 事件分页只用 seq 作游标：同一毫秒内可能产生多条事件，用时间戳做续传会同时漏读或
// 重复读取这一段。seq 由生产者单调分配（见 INV-23），是唯一可靠的顺序键。
export const zcodeSessionEventsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionEventsParams = z.infer<typeof zcodeSessionEventsParamsSchema>;

// 运行时偏好作用域两态：runtime-materialization（执行侧物化配置）与 user-execution
// （用户执行策略）。二者写入的是不同持久层，选错不会报错、只会静默不生效，
// 因此协议要求调用方显式给出，不接受“按当前上下文自动推断”。
export const zcodeSessionRuntimePreferencesScopeSchema = z.enum([
  "runtime-materialization",
  "user-execution",
]);
export type ZCodeSessionRuntimePreferencesScope = z.infer<
  typeof zcodeSessionRuntimePreferencesScopeSchema
>;

// subagents/readRuntimeConfig 返回 Host 已解析的完整快照或显式内置回退，不再传 Markdown。
export {
  subagentRuntimeConfigSchema,
  type SubagentRuntimeConfig,
} from "../subagent-runtime-config.js";
// 只按 sessionId 读取子代理运行配置：运行配置在会话内唯一，不需要再带 agentId；
// 多一层 id 参数只会逼调用方猜该填哪一个，填错还会读到空配置。
export const zcodeSubagentsReadRuntimeConfigParamsSchema = z
  .object({ sessionId: nonEmptyString })
  .strict();

export const ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS = 15_000;

// 请求运行时偏好：overrides 只影响本次回答的解析结果，不写回任何持久层。
// 这种“只读覆盖”让 UI 能在不改变用户设置的前提下试探某种配置的实际效果。
export const zcodeSessionRequestRuntimePreferencesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    scope: zcodeSessionRuntimePreferencesScopeSchema,
  })
  .strict();
export type ZCodeSessionRequestRuntimePreferencesParams = z.infer<
  typeof zcodeSessionRequestRuntimePreferencesParamsSchema
>;

export const DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY = "preflight-v1" as const;

// 3.12.2：legacy 仅为旧协议接收兼容；Runtime 一律归一为上面的共享默认策略。
// 两种上下文预算策略并存：legacy 按历史长度粗略估算，preflight-v1 先探测模型真实窗口
// 再分配。字面量固定是因为 UI 需要按取值展示不同提示；新增策略属于能力升级，必须走
// 能力协商而不是默认切换——否则同一份历史在两端会得到不同的截断结果。
export const zcodeModelContextBudgetStrategySchema = z.enum(["legacy", "preflight-v1"]);
export type ZCodeModelContextBudgetStrategy = z.infer<typeof zcodeModelContextBudgetStrategySchema>;

// 运行时偏好结果全部带默认值，这是本文件里唯一允许“用 default 兜底”的地方：偏好是
// 纯读接口，旧 agent 不认识新字段时给出保守默认（关闭增强、策略取共享默认）比整条失败
// 更符合预期。注意 default 与 optional 的差别——default 会把值真正补齐，消费端拿到的是
// 确定值；optional 则要求每个消费端各写一次回退逻辑。
export const zcodeSessionRuntimePreferencesResultSchema = z
  .object({
    additionalDirectories: z.array(nonEmptyString).max(256).optional(),
    nativeSearchEnhancementsEnabled: z.boolean(),
    toolSearchMode: appToolSearchModeSchema.default("off"),
    subagentRuntimeConfigEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().default(false),
    askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
    integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
    // 兼容旧 Host：缺少字段时在协议解析边界使用当前默认策略。
    modelContextBudgetStrategy: zcodeModelContextBudgetStrategySchema.default(
      DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    ),
  })
  .strict();
export type ZCodeSessionRuntimePreferencesResult = z.infer<
  typeof zcodeSessionRuntimePreferencesResultSchema
>;

/**
 * App 在提交 prompt 前只读采集的 IAB 可见状态。该字段只用于 provider-visible
 * ambient context，不进入用户可见 transcript；内容有界，禁止携带页面正文或凭据。
 */
// 上界即隐私边界：tabCount 最多 100、currentUrl 最多 4096 字符，且不提供任何
// “页面标题/正文/选择器”字段。ambient context 会进入 provider 可见上下文，所以字段集
// 本身就是承诺——多加一个自由文本字段，就等于把浏览器内容带进了模型输入。
export const zcodeBrowserAmbientContextSchema = z
  .object({
    tabCount: z.number().int().positive().max(100),
    currentUrl: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();
export type ZCodeBrowserAmbientContext = z.infer<typeof zcodeBrowserAmbientContextSchema>;

// send 的三条跨字段规则（superRefine）都是“无法在字段级表达”的组合约束：
// ① automationId 与 offPeakTaskId 互斥——一次提交不可能同时由定时任务和错峰任务发起，
//    同时给出说明调用方搞混了两条链路，继续执行会在错误的账本上计费；
// ② offPeakRunType 只能依附于 offPeakTaskId——单独出现意味着任务身份丢失，恢复时会新建
//    一个错峰任务而不是续跑；
// ③ modelExecution 必须伴随 modelSelection——执行参数离开选择结果就没有解释主体。
// 这三条都用 addIssue（而不是 refine 抛错）以便报错带上 path，UI 才能精确高亮字段。
// content 允许空串：纯附件消息是合法输入，空内容不是错误。
export const zcodeSessionSendParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    modelExecution: modelExecutionSchema.optional(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    content: z.string(),
    attachments: z.array(jsonObjectSchema).optional(),
    browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedProviderRevision: nonEmptyString.optional(),
    automationId: nonEmptyString.optional(),
    offPeakTaskId: nonEmptyString.optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.automationId && payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automationId and offPeakTaskId are mutually exclusive",
      });
    }
    if (payload.offPeakRunType && !payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offPeakRunType requires offPeakTaskId",
        path: ["offPeakRunType"],
      });
    }
    if (payload.modelExecution && !payload.modelSelection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelExecution requires modelSelection",
        path: ["modelExecution"],
      });
    }
  });
// accepted 固定为字面量 true：失败一律走 response.error，不在这里表达“接受了但没生效”。
// stateRevision 回传提交后的版本号，供调用方把后续更新对齐——这正是 expectedRevision
// 乐观并发栅栏的配对方（INV-19）。
export const zcodeSessionSendResultSchema = z
  .object({
    sessionId: nonEmptyString,
    accepted: z.literal(true),
    stateRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeSessionSendResult = z.infer<typeof zcodeSessionSendResultSchema>;

// 历史定位点四态：turn（轮次序号）、message（消息 id）、checkpoint（显式检查点）、
// latestCheckpoint（隐含检查点）。前三种需要调用方精确知道位置，最后一种让“从最近一次
// 可回滚点分叉”免于先查目录再分叉；它也是 fork 的默认值。
export const zcodeSessionHistoryTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("turn"),
      turnIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      messageId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("checkpoint"),
      checkpointId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("latestCheckpoint"),
    })
    .strict(),
]);
export type ZCodeSessionHistoryTarget = z.infer<typeof zcodeSessionHistoryTargetSchema>;

// fork 的 target 带 default(latestCheckpoint)：不给定位点时按“最近检查点”分叉，这是
// 唯一不依赖调用方猜测的语义。没有这个默认值，调用方要么自己先查最新的点（多一次往返，
// 且查完到真正分叉之间可能又产生了新检查点），要么在两侧各自实现一套兜底。
export const zcodeSessionForkParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    target: zcodeSessionHistoryTargetSchema.default({
      kind: "latestCheckpoint",
    }),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionForkParams = z.infer<typeof zcodeSessionForkParamsSchema>;

// fork 结果同时回传新的 sessionId 与“落点”：targetMessageId 与 targetCheckpointId 都是
// 可选的，因为按轮次或按消息分叉时不存在检查点 id。回传 snapshot 是为了让 UI 不必再发
// 一次读取就能渲染分叉出来的会话，否则用户会看到一次明显的空白切换。
export const zcodeSessionForkResultSchema = z
  .object({
    forkedSessionId: nonEmptyString,
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: nonEmptyString.optional(),
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
  })
  .strict();
export type ZCodeSessionForkResult = z.infer<typeof zcodeSessionForkResultSchema>;

// compact 参数里的 instructions 是“压缩指引”，不是新提示词：它只影响摘要如何取舍，
// 不会被当成用户输入注入对话。expectedRevision 可选，给出即参与并发冲突检测（INV-19）。
export const zcodeSessionCompactParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    instructions: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionCompactParams = z.infer<typeof zcodeSessionCompactParamsSchema>;

// compact.state 只区分 accepted / already_running：压缩是幂等操作，重复请求不该报错，
// 但调用方仍需要知道“是我触发的，还是已经有人在压”。operationId 用于把这些状态串到
// 后续流式事件上；不带它时 UI 只能靠时间窗猜测，容易串到别的操作。
export const zcodeSessionCompactResultSchema = z
  .object({
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
    compact: z
      .object({
        state: z.enum(["accepted", "already_running"]),
        inputId: nonEmptyString.optional(),
        operationId: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionCompactResult = z.infer<typeof zcodeSessionCompactResultSchema>;

// 六种目标动作：show 只读、set 增量（保留未提及的部分）、replace 全量替换、pause/resume
// 控制自动轮次、clear 清空。set 与 replace 必须分开——把两者合成一个“写入”，用户改一个
// 字段就会把目标里的其余条件清掉，而这类破坏是不可撤销的。
export const zcodeSessionGoalActionSchema = z.enum([
  "show",
  "set",
  "replace",
  "pause",
  "resume",
  "clear",
]);
export type ZCodeSessionGoalAction = z.infer<typeof zcodeSessionGoalActionSchema>;

// objective 对 set/replace 必填、对 show/pause/resume/clear 无意义，但这里不做条件校验：
// 该规则属于业务语义，放进 schema 会让“只想改一句目标但动作写错”的请求在协议层被拒，
// 而真正的错误提示应来自 agent 的业务校验（能区分具体动作给出更准的文案）。
export const zcodeSessionGoalParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    action: zcodeSessionGoalActionSchema,
    objective: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionGoalParams = z.infer<typeof zcodeSessionGoalParamsSchema>;

// startedTurn 表示这次动作是否顺带开启了一轮自动执行：set 目标后可能立即起跑，
// UI 据此决定是显示“已保存”还是切到运行态；缺省表示未起跑。
export const zcodeSessionGoalResultSchema = z
  .object({
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
    startedTurn: z.boolean().optional(),
  })
  .strict();
export type ZCodeSessionGoalResult = z.infer<typeof zcodeSessionGoalResultSchema>;

// stop 只带 sessionId、没有 turnId：中断语义是“让这个会话回到空闲”，不针对某一轮。
// 带上 turnId 反而会引入“用户点停止时那一轮刚好结束”的竞态——请求会被判为无效而
// 什么都不做，用户看到的却是按钮点了没反应。
export const zcodeSessionStopParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();
// 后台任务七态：spawn_error 是“压根没起来”（命令不存在、权限不足），lost 是“起来后
// 失去联系”（进程被外部杀掉、pty 断开）。两者都表现为“没有输出”，但处置完全不同：
// 前者要报配置错误，后者要提示产物可能不完整。合并会丢失这个关键区分。
const zcodeBackgroundTaskInfoStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "lost",
]);

// 后台任务快照：几乎所有运行态字段都是 optional，因为任务在不同阶段能提供的信息不同
// （刚 spawn 时还没有 pid 与输出路径）。stdout/stderr 各有 bytes + tail + persistedPath：
// tail 用于轻量展示，完整内容落盘后靠路径读取，避免把整个输出塞进状态通知。
// outputTruncated 显式标注截断，防止 UI 把“只看到尾部”误当作全部输出。
export const zcodeBackgroundTaskInfoSchema = z
  .object({
    taskId: nonEmptyString,
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    taskKind: z.enum(["bash", "subagent"]).optional(),
    blocked: z.boolean().optional(),
    blockedReason: z.string().optional(),
    cancellable: z.boolean().optional(),
    cancelRequestedAt: protocolInstantSchema.optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    status: zcodeBackgroundTaskInfoStatusSchema,
    pid: z.number().int().positive().optional(),
    startedAt: protocolInstantSchema.optional(),
    completedAt: protocolInstantSchema.optional(),
    outputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    outputTruncated: z.boolean().optional(),
    outputTail: z.string().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    stderrTail: z.string().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stdoutTail: z.string().optional(),
    terminalId: nonEmptyString.optional(),
  })
  .strict();
export const zcodeSessionCancelBackgroundTaskParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
  })
  .strict();
export type ZCodeSessionCancelBackgroundTaskParams = z.infer<
  typeof zcodeSessionCancelBackgroundTaskParamsSchema
>;

export const zcodeSessionCancelBackgroundTaskResultSchema = z
  .object({
    cancelled: z.boolean(),
    reason: z.string().optional(),
    snapshot: zcodeBackgroundTaskInfoSchema.optional(),
    status: zcodeBackgroundTaskInfoStatusSchema,
    taskId: nonEmptyString,
  })
  .strict();
export type ZCodeSessionCancelBackgroundTaskResult = z.infer<
  typeof zcodeSessionCancelBackgroundTaskResultSchema
>;

// persistAsWorkspaceLastUsed 默认 true：用户手动切模型几乎总是希望“下次新会话也用这个”，
// 默认 false 会让设置看起来没被记住。需要“只对本次生效”的调用方显式传 false。
// expectedRevision 可选，给出即参与乐观并发（INV-19）。
export const zcodeSessionSetModelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    model: modelSelectionSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();
export type ZCodeSessionSetModelParams = z.infer<typeof zcodeSessionSetModelParamsSchema>;

// thoughtLevel 是 optional 而不是必填：缺席表示“清除档位、回到模型默认”，
// 这与“设为空字符串”必须区分——后者会被当成一个非法档位写进历史。
export const zcodeSessionSetThoughtLevelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    thoughtLevel: nonEmptyString.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();
export type ZCodeSessionSetThoughtLevelParams = z.infer<
  typeof zcodeSessionSetThoughtLevelParamsSchema
>;

// mode 没有 optional 分支：会话任何时刻都有且只有一个模式，不允许“清除”。
// 与 thoughtLevel 的差异不是疏忽，而是两种设置的真实语义不同（档位可空、模式不可空）。
export const zcodeSessionSetModeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    mode: zcodeSessionModeSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionSetModeParams = z.infer<typeof zcodeSessionSetModeParamsSchema>;

// expectedPersistence 让关闭方先声明“我以为它是哪种落库模式”：deferred 模式下关闭前必须
// 先刷批，若实际模式与预期不符，说明状态已经漂移，此时直接关会丢最近的增量。
export const zcodeSessionCloseParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    expectedPersistence: zcodeSessionPersistenceSchema.optional(),
  })
  .strict();
export type ZCodeSessionCloseParams = z.infer<typeof zcodeSessionCloseParamsSchema>;
export const zcodeSessionCloseResultSchema = z
  .object({
    closed: z.boolean().optional(),
  })
  .strict();
export type ZCodeSessionCloseResult = z.infer<typeof zcodeSessionCloseResultSchema>;
// 工作区展示信息是“打开项目时渲染首屏”的最小集合：当前模式 + 可用斜杠命令。
// 只带 workspace 引用而不带路径，避免把绝对路径写进 UI 状态与日志。
export const zcodeWorkspaceReadPresentationParamsSchema = z
  .object({ workspace: zcodeWorkspaceRefSchema })
  .strict();
// 展示结果只回三项：workspace 引用（回显，便于多窗口匹配）、mode、slashCommands。
// 刻意不含目录树或文件列表——那类数据体量大且时效性强，应走专门的读取方法。
export const zcodeWorkspacePresentationSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    mode: zcodeSessionModeSchema,
    slashCommands: z.array(zcodeSlashCommandSchema),
  })
  .strict();
export type ZCodeWorkspacePresentation = z.infer<typeof zcodeWorkspacePresentationSchema>;
// 信任授权的摘要固定为 64 位小写十六进制 sha256：这是“用户批准的那份 hook 内容”的唯一
// 标识。允许其它摘要形态会让同一个 bundle 在不同端算出不同值，信任永远无法命中。
const workspaceHookSha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
// 两个摘要必须同时给出：bundleDigest 锁定“哪些 hook 文件被打包”，hookDeclarationDigest
// 锁定“声明的执行内容”。只钉一个会留下替换窗口——攻击者可以在声明不变的情况下换掉
// bundle 里的可执行体，或反之。这正是防 TOCTOU 的最小证据集。
export const zcodeWorkspaceHookTrustGrantParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    bundleDigest: workspaceHookSha256DigestSchema,
    hookDeclarationDigest: workspaceHookSha256DigestSchema,
  })
  .strict();
export type ZCodeWorkspaceHookTrustGrantParams = z.infer<
  typeof zcodeWorkspaceHookTrustGrantParamsSchema
>;
// 六种拒绝原因分别对应“策略禁止 / bundle 变了 / 快照不匹配 / 策略要求预信任 /
// 信任库损坏 / 配置不可读”。UI 需要靠它给不同处置建议（去设置里改策略、重新确认、
// 修复信任库），因此不能压扁成一条“授权失败”。
export const zcodeWorkspaceHookTrustGrantReasonCodeSchema = z.enum([
  "workspace_hooks_blocked_by_policy",
  "workspace_hooks_bundle_changed",
  "workspace_hooks_snapshot_mismatch",
  "workspace_hooks_policy_requires_pretrust",
  "workspace_hooks_trust_store_corrupt",
  "workspace_hooks_config_unreadable",
]);
export type ZCodeWorkspaceHookTrustGrantReasonCode = z.infer<
  typeof zcodeWorkspaceHookTrustGrantReasonCodeSchema
>;
// accepted 与 reasonCode 是条件关系：接受时不需要原因，拒绝时必须给出（由业务保证）。
// 协议层不在这里强制互斥，是因为旧 CLI 存在“接受也回一个信息性 reasonCode”的行为，
// 强行约束会让这类版本整体失配。
export const zcodeWorkspaceHookTrustGrantResultSchema = z
  .object({
    accepted: z.boolean(),
    reasonCode: zcodeWorkspaceHookTrustGrantReasonCodeSchema.optional(),
  })
  .strict();
export type ZCodeWorkspaceHookTrustGrantResult = z.infer<
  typeof zcodeWorkspaceHookTrustGrantResultSchema
>;
const zcodeWorkspaceModelToolCallSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    input: z.unknown(),
  })
  .strict();
// 四种角色按 role 判别：tool 消息必须带 toolCallId（否则无法与发起它的 assistant
// toolCall 配对，模型侧会把它当成一段孤立文本）；assistant 的 toolCalls 可选，
// 因为纯文本回复是常态。
const zcodeWorkspaceModelMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z.array(zcodeWorkspaceModelToolCallSchema).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.string(),
      toolCallId: nonEmptyString,
      toolName: nonEmptyString,
      isError: z.boolean().optional(),
    })
    .strict(),
]);
// inputSchema 是自由 JSON Schema（键值对象），协议层不做结构校验：不同 provider 的
// 工具描述扩展不同，统一约束会拒掉合法工具；具体校验由模型适配层完成。
const zcodeWorkspaceModelToolSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

// prompt 与 messages 二选一（refine 保证至少一个）：prompt 适合单轮补全，messages 适合
// 多轮带工具调用。两者都给时不报错，由实现决定合并策略——协议层裁决反而会限制用法。
// querySource 必填：它决定这次生成记到哪类来源的账上，缺失会让用量统计无法归因。
export const zcodeWorkspaceGenerateTextParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
    prompt: nonEmptyString.optional(),
    messages: z.array(zcodeWorkspaceModelMessageSchema).min(1).optional(),
    tools: z.array(zcodeWorkspaceModelToolSchema).optional(),
    querySource: nonEmptyString,
    maxOutputTokens: z.number().int().positive().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict()
  .refine((value) => value.prompt !== undefined || value.messages !== undefined, {
    message: "prompt 或 messages 至少需要提供一个",
  });
// usage 内所有计数都是 optional 且允许小数：不同 provider 的报告粒度不同（有的只给总量、
// 有的给缓存分项），强制必填会迫使实现造假数据。finishReason 可选以兼容旧 app-server，
// 但新实现必须返回——它是判断“被截断还是自然结束”的唯一依据。
export const zcodeWorkspaceGenerateTextResultSchema = z
  .object({
    text: z.string(),
    selection: modelSelectionSchema,
    toolCalls: z.array(zcodeWorkspaceModelToolCallSchema).optional(),
    // 可选以兼容仍在运行的旧 app-server；新 CLI 始终返回结构化结束原因。
    finishReason: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheWriteTokens: z.number().nonnegative().optional(),
        reasoningTokens: z.number().nonnegative().optional(),
        serverToolUse: z
          .object({
            webSearchRequests: z.number().nonnegative().optional(),
            webFetchRequests: z.number().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeWorkspaceGenerateTextParams = z.infer<
  typeof zcodeWorkspaceGenerateTextParamsSchema
>;
export type ZCodeWorkspaceModelMessage = z.infer<typeof zcodeWorkspaceModelMessageSchema>;
export type ZCodeWorkspaceModelTool = z.infer<typeof zcodeWorkspaceModelToolSchema>;
export type ZCodeWorkspaceGenerateTextResult = z.infer<
  typeof zcodeWorkspaceGenerateTextResultSchema
>;
// 取消只认 operationId：生成请求本身不携带可比较的内容，靠 id 定位才能精确中断；
// 回传同一个 `operationId` 让调用方确认取消落在哪一次操作上，并发多次生成时尤其重要。
export const zcodeWorkspaceCancelGenerateTextParamsSchema = z
  .object({ operationId: nonEmptyString })
  .strict();
export const zcodeWorkspaceCancelGenerateTextResultSchema = z
  .object({ operationId: nonEmptyString, cancelled: z.boolean() })
  .strict();

// 连通性测试必须带 workspace：凭据、代理与区域设置都是工作区级的，只给模型选择会在
// 错误的账号下探测并得出“可用/不可用”的错误结论。成功用 literal(true)，失败归 error。
export const zcodeProviderTestModelConnectivityParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
  })
  .strict();
export const zcodeProviderTestModelConnectivityResultSchema = z
  .object({ success: z.literal(true) })
  .strict();
export type ZCodeProviderTestModelConnectivityParams = z.infer<
  typeof zcodeProviderTestModelConnectivityParamsSchema
>;
export type ZCodeProviderTestModelConnectivityResult = z.infer<
  typeof zcodeProviderTestModelConnectivityResultSchema
>;

// 两个版本号缺一不可：revision 是账号配置自身的版本（用于回执与幂等），
// basedOnZCodeBuiltinRevision 声明本次修改基于哪一版内置 provider 基线。少了后者，
// 旧进程的修改会静默覆盖掉内置目录的更新，且无法事后判断覆盖发生在哪一版上。
// providers 保持 unknown：字段校验由 @zcode/provider 负责（见上方既有注释），协议只约束信封。
export const zcodeProviderUpdateAccountConfigParamsSchema = z
  .object({
    revision: nonEmptyString,
    basedOnZCodeBuiltinRevision: nonEmptyString,
    // Provider Config 的字段校验由 @zcode/provider 负责；协议层只约束可传输信封。
    providers: z.record(z.string(), z.unknown()),
    // 账号状态与 Overlay 必须一起传递，否则 Worker 会丢失非当前套餐的执行门禁。
    states: z.record(
      z.string(),
      z
        .object({
          availability: z.enum(["available", "pending", "unavailable", "unknown"]),
          entitled: z.boolean(),
          unavailableReason: accountProviderUnavailableReasonSchema.optional(),
          current: z.boolean().optional(),
          connectionKey: z.string().optional(),
          effectiveAt: z.number().finite().optional(),
        })
        .strict(),
    ),
  })
  .strict();
// status 只有 received / unchanged：调用方据 unchanged 跳过重渲染。receivedRevision
// 只证明“这批数据已收到”，不代表配套 Built-in 已就位（见既有注释），
// 因此它不是“可以开始使用新 provider”的信号，只是幂等回执。
export const zcodeProviderUpdateAccountConfigResultSchema = z
  .object({
    // 收到账号结果不代表配套 Built-in 已到达；应用版本只能读取 Registry 快照。
    receivedRevision: nonEmptyString,
    providerCount: z.number().int().nonnegative(),
    status: z.enum(["received", "unchanged"]),
  })
  .strict();
export type ZCodeProviderUpdateAccountConfigResult = z.infer<
  typeof zcodeProviderUpdateAccountConfigResultSchema
>;
/** Worker 从所属 Environment 的正式 Config Store 重建进程内 Provider Registry。 */
// reason 是必填的自由文本，用于审计“为什么重建 registry”：没有它时线上只能看到一次
// 无故重建，无法判断是用户操作、配置变更还是故障恢复触发的。
export const zcodeProviderRefreshRegistryParamsSchema = z
  .object({
    reason: nonEmptyString,
  })
  .strict();
export const zcodeProviderRefreshRegistryResultSchema = z
  .object({
    refreshed: z.literal(true),
  })
  .strict();
export type ZCodeProviderRefreshRegistryParams = z.infer<
  typeof zcodeProviderRefreshRegistryParamsSchema
>;
export type ZCodeProviderRefreshRegistryResult = z.infer<
  typeof zcodeProviderRefreshRegistryResultSchema
>;
// 交互偏好单独成 schema：以后加开关只改这里，update 方法的参数形状不变，
// 旧调用方不会被强制升级。
export const zcodeInteractionPreferencesSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
  })
  .strict();
export type ZCodeInteractionPreferences = z.infer<typeof zcodeInteractionPreferencesSchema>;

// 传整个 preferences 对象而不是“只传改动的字段”：偏好是整体替换语义，
// 增量更新需要额外记录“哪些字段未提及”，一旦两端理解不同就会出现设置互相覆盖。
export const zcodeWorkspaceUpdateInteractionPreferencesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    preferences: zcodeInteractionPreferencesSchema,
  })
  .strict();
export type ZCodeWorkspaceUpdateInteractionPreferencesParams = z.infer<
  typeof zcodeWorkspaceUpdateInteractionPreferencesParamsSchema
>;

// snoozedInteractionCount 表示当前被该偏好自动静音/自动处理的交互数量：
// 只回显开关值（`enabled`）时用户看不到影响范围，所以额外返回 `snoozedInteractionCount`。
export const zcodeWorkspaceUpdateInteractionPreferencesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    snoozedInteractionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeWorkspaceUpdateInteractionPreferencesResult = z.infer<
  typeof zcodeWorkspaceUpdateInteractionPreferencesResultSchema
>;

// fullRetentionEnabled 控制是否完整保留模型输入输出：关闭时可节省存储与隐私暴露面，
// 但会失去事后复现问题的能力。协议只传开关，不传保留时长——时长属于存储策略，
// 放在这里会把一个隐私开关变成一组需要两端同步的复杂参数。
export const zcodeModelIoPreferencesSchema = z
  .object({
    fullRetentionEnabled: z.boolean(),
  })
  .strict();
export type ZCodeModelIoPreferences = z.infer<typeof zcodeModelIoPreferencesSchema>;

// 与交互偏好同构：workspace + 完整 preferences 对象，整体替换而非增量。
export const zcodeWorkspaceUpdateModelIoPreferencesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    preferences: zcodeModelIoPreferencesSchema,
  })
  .strict();
export type ZCodeWorkspaceUpdateModelIoPreferencesParams = z.infer<
  typeof zcodeWorkspaceUpdateModelIoPreferencesParamsSchema
>;

// updatedSessionCount 回传受影响的历史会话数量：用户需要知道这个开关是只影响新会话，
// 还是把既有会话的记录也一并清理/补齐。
export const zcodeWorkspaceUpdateModelIoPreferencesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    fullRetentionEnabled: z.boolean(),
    updatedSessionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeWorkspaceUpdateModelIoPreferencesResult = z.infer<
  typeof zcodeWorkspaceUpdateModelIoPreferencesResultSchema
>;

// 错峰工具策略是纯开关（enabled），没有 mode 之类的附加维度：它的语义是“错峰任务
// 是否允许使用工具”，越界与否由执行侧判定，协议层不需要表达更多。
export const zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateOffPeakToolPolicyParams = z.infer<
  typeof zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema
>;

export const zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateOffPeakToolPolicyResult = z.infer<
  typeof zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema
>;

// 动态工作流灰度门禁：workspace 级事实，
// 与 Off-Peak 同一套 host→CLI 同步模式；旧 CLI method-not-found → host 降级忽略。
export const zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
    // launch.md「On demand: activation」：mode 与布尔同行；缺席时 CLI 按布尔行事（alwaysOn）。
    mode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZCodeWorkspaceUpdateDynamicWorkflowPolicyParams = z.infer<
  typeof zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema
>;

// 结果只回显 enabled：调用方已经知道 workspace，回传它只是让通知能自证归属，
// 多回字段没有额外信息量，反而增加两侧不同步的机会。
export const zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateDynamicWorkflowPolicyResult = z.infer<
  typeof zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema
>;

// 权限请求：riskLevel 四档决定 UI 的强调程度与默认聚焦项；options 至少一项（min(1)），
// 否则请求无法被回答，整轮只能挂起直到超时。input 保持 unknown——各工具入参形状差异
// 极大，协议层只保证“有内容可展示”，具体渲染由 UI 按 toolName 决定。
// requestId 必填且是 resolve 的唯一键，缺失会让请求无法被精确回答（因此这里与事件侧
// 的 optional requestId 不同：事件只是通知，这里是行动的入口）。
export const zcodePermissionRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
  })
  .strict();
export type ZCodePermissionRequestParams = z.infer<typeof zcodePermissionRequestParamsSchema>;

/** Agent 请求 app 枚举当前 workspace/session 可达且已完成握手的 browser backend。 */
// 列 backend 的四个路由键：workspaceKey 定位工作区容器、workspacePath 定位目录、
// workspaceIdentity 区分同一路径的不同工作区实例（例如不同分支的 worktree）、
// remoteSessionId 指向远程连接。四者共同决定“问谁要 backend”，少一个就可能问到
// 另一台机器或另一个 worktree 上。这里不校验 browser 是否存在——本方法就是来问的。
export const zcodeBrowserListParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema,
    sessionContext: browserSessionContextKindSchema,
  })
  .strict();
export type ZCodeBrowserListParams = z.infer<typeof zcodeBrowserListParamsSchema>;

// 结果直接复用 browser 后端的共享 schema：列表里每个 backend 都带代际与能力标记，
// 调用方在真正执行前必须把代际原样带回，否则会落到已被替换的实例上。
export const zcodeBrowserListResultSchema = browserBackendListResultSchema;
export type ZCodeBrowserListResult = z.infer<typeof zcodeBrowserListResultSchema>;

/** Agent 把一条 browser-use 命令发送给 app 执行。 */
// 执行时必须带 browserId + browserGeneration：两者构成“哪一代浏览器实例”的定位，
// 缺 generation 时命令可能落到刷新后重建的实例上，表现为作用在错误页面或直接失联。
// 工作区四键在这里是 optional（与 list 不同）：省略表示沿用当前会话绑定的工作区，
// 这允许常见路径只传命令；显式给出的值会覆盖会话绑定。
// requestId 必填并参与 pending 表：重复 id 由结果里的 duplicate_request_id 拒绝（见下方）。
export const zcodeBrowserExecuteParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    browserId: nonEmptyString.optional(),
    browserGeneration: z.number().int().nonnegative().optional(),
    workspaceKey: nonEmptyString.optional(),
    workspacePath: nonEmptyString.optional(),
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema.optional(),
    sessionContext: browserSessionContextKindSchema.optional(),
    command: browserCommandSchema,
  })
  .strict();
export type ZCodeBrowserExecuteParams = z.infer<typeof zcodeBrowserExecuteParamsSchema>;

// browser command result 是 app/agent 的同源协议结果；其中 duplicate_request_id 用于在真正维护
// pending/running 生命周期的边界拒绝 correlation key 冲突，不能依赖上游 UUID 概率保证。
// 结果形状完全由共享的 browserCommandResultSchema 决定，协议层不额外包一层：
// 多包一层会迫使两侧对“成功/失败”各写一次映射，错误码也因此出现两套。
export const zcodeBrowserExecuteResultSchema = browserCommandResultSchema;
export type ZCodeBrowserExecuteResult = z.infer<typeof zcodeBrowserExecuteResultSchema>;

// 选项的 value 是提交值、label 是展示值，两者分开：把 label 当提交值会让“改文案”
// 变成破坏性变更（历史答案里存的是旧 label）。preview 可选，用于富文本/代码片段预览。
export const zcodeUserInputOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();
// 每道题至少一个选项（min(1)）：没有选项的题目在 UI 上无法作答，只能被跳过，
// 而“跳过”与“答了空”在结果里无法区分。multiSelect 可选，缺省按单选处理。
export const zcodeUserInputQuestionSchema = z
  .object({
    question: nonEmptyString,
    header: nonEmptyString,
    options: z.array(zcodeUserInputOptionSchema).min(1),
    multiSelect: z.boolean().optional(),
  })
  .strict();
export type ZCodeUserInputQuestion = z.infer<typeof zcodeUserInputQuestionSchema>;

// prompt 与 questions 都可选，但至少要有一种可呈现内容：questions 走结构化问卷，
// prompt+input 走自由输入/表单。schema 字段留给“自定义表单描述”，协议层不解析它——
// 解析会让协议随表单语法演进，而表单本就属于调用方与 UI 之间的约定。
export const zcodeUserInputRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    prompt: z.string().optional(),
    questions: z.array(zcodeUserInputQuestionSchema).min(1).optional(),
    input: z.unknown().optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    schema: z.unknown().optional(),
  })
  .strict();
export type ZCodeUserInputRequestParams = z.infer<typeof zcodeUserInputRequestParamsSchema>;

// 回答三态必须区分：accept（用户作答）、decline（用户明确拒绝回答）、cancel（放弃本次
// 交互，例如关闭面板）。三者若合并成“没有 content”，发起方就无法决定是重问、跳过，
// 还是把这一轮当作被用户中止。content 只在 accept 时有意义。
export const zcodeUserInputResponseSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: jsonObjectSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ZCodeUserInputResponse = z.infer<typeof zcodeUserInputResponseSchema>;

// reason 枚举直接取自 requestVerificationReasons（跨包共享）：凭据刷新是审计敏感操作，
// 两端的“为什么刷新”必须用同一套词表，否则日志里同一原因会出现多种写法，无法聚合。
export const zcodeProviderRuntimeHeadersRequestReasonSchema = z.enum(requestVerificationReasons);
// expectedAccountScope 与 rejectedProjectTokenFingerprint 都是 64 位十六进制指纹，
// 不是明文令牌。前者声明“这次应当取到哪个账号范围的凭据”，后者记录上一次被服务端拒绝的
// 项目令牌，避免原样重试同一条已被拒的凭据（那只会放大失败与限流）。
// 两者都 optional：首次获取时没有可比对象，但一旦给出就必须是完整摘要，不能被截断。
export const zcodeProviderRuntimeHeadersRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspace: zcodeWorkspaceRefSchema,
    modelSelection: modelSelectionSchema,
    providerId: nonEmptyString,
    accountAccess: zcodeProviderAccountAccessSchema.optional(),
    expectedAccountScope: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    rejectedProjectTokenFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reason: zcodeProviderRuntimeHeadersRequestReasonSchema,
  })
  .strict();
export type ZCodeProviderRuntimeHeadersRequestParams = z.infer<
  typeof zcodeProviderRuntimeHeadersRequestParamsSchema
>;

/** 请求取消只作用于同 workspace/session 的这一轮凭据刷新。 */
export const zcodeProviderRuntimeHeadersCancelledSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema,
  })
  .strict();
export type ZCodeProviderRuntimeHeadersCancelled = z.infer<
  typeof zcodeProviderRuntimeHeadersCancelledSchema
>;

// 成功分支必须携带 requestAuth（见既有注释）：凭据刷新是“合并重接”语义，调用方不能
// 依赖旧 Registry 已被写入，否则在并发刷新时会拿到上一版凭据。
// discriminatedUnion 用 headersApplied 判别，而不是 ok 布尔：布尔无法表达
// “成功但无需应用任何 header”这种中间态。
export const zcodeProviderRuntimeHeadersResponseSchema = z.discriminatedUnion("headersApplied", [
  z
    .object({
      headersApplied: z.literal(true),
      // 合并重接：成功必须携带当前请求的鉴权材料，不依赖旧 Registry 已被写入。
      requestAuth: z
        .object({
          apiKey: nonEmptyString.optional(),
          apiKeyId: z.string().trim().min(1).optional(),
          accountScope: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          headers: z.record(nonEmptyString, nonEmptyString).optional(),
        })
        .strict(),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      headersApplied: z.literal(false),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
]);
export type ZCodeProviderRuntimeHeadersResponse = z.infer<
  typeof zcodeProviderRuntimeHeadersResponseSchema
>;

// ── 官方 Server MCP 鉴权──
// Agent 进程不是用户身份权威：它把 (pluginId, mcpKey, targetOrigin) 报给 host，由 host
// 解析当前 Coding Plan 凭证并回传本次请求的身份头。请求侧不含任何秘密。
// 与 interaction/requestProviderRuntimeHeaders 同类：Agent 发起、host 自动响应、零 UI。
// 三元组 (pluginId, mcpKey, targetOrigin) 是身份解析的输入，本身不含任何秘密（见上方注释：
// host 才是身份权威）。targetOrigin 单独列出，是因为 host 要拿它做二次校验——只按 pluginId
// 发头，等于允许任意 origin 借用官方凭证。
export const zcodeOfficialMcpAuthHeadersRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    mcpKey: nonEmptyString,
    targetOrigin: nonEmptyString,
  })
  .strict();
export type ZCodeOfficialMcpAuthHeadersRequestParams = z.infer<
  typeof zcodeOfficialMcpAuthHeadersRequestParamsSchema
>;

/**
 * 失败原因必须可枚举，避免调用方按文本分流；因此响应不含 errorMessage。
 *
 * `official_mcp_origin_untrusted` 是 host 侧二次校验的拒绝原因：`targetOrigin` 不等于当前
 * ZCode API origin。判定只看 origin，`pluginId` / `mcpKey` 仅用于日志归属。与"未登录/无凭据"
 * 分开，才能在排查时区分"被拒绝"和"没身份"。
 */
// 失败原因只保留枚举（见 JSDoc）：调用方据此分流，不解析错误文本。origin 不可信与
// “没有身份”必须是两个值——前者说明请求被主动拒绝，后者说明用户还没登录，
// 两者的处置完全不同（前者要报安全拒绝，后者要引导登录）。
export const zcodeOfficialMcpAuthFailureReasonSchema = z.enum(
  OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS,
);

// 用 ok 判别而不是“headers 是否存在”：成功但 headers 为空（无需附加任何头）是合法结果，
// 用存在性判别会把它误判成失败。headers 的键值都限定为非空字符串，防止出现空头名。
export const zcodeOfficialMcpAuthHeadersResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      headers: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: zcodeOfficialMcpAuthFailureReasonSchema,
    })
    .strict(),
]);
export type ZCodeOfficialMcpAuthHeadersResponse = z.infer<
  typeof zcodeOfficialMcpAuthHeadersResponseSchema
>;

// ── Plugin management (list + enable/disable) ──
// 镜像 @zcode/contracts 的 PluginMetadata, 仅保留 UI 需要的可序列化字段。
// 插件配置值只允许三种标量：它要能被 JSON 往返、能被 UI 表单直接编辑、能按值比较是否
// 变更。允许对象/数组会让“是否改动过”退化成深比较，而配置比较发生在启动热路径上。
export const zcodePluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type ZCodePluginOptionValue = z.infer<typeof zcodePluginOptionValueSchema>;
// 配置作用域两态：user（全局）与 workspace（项目）。它同时决定覆盖顺序——workspace 覆盖
// user。任何写入都必须带上来源作用域，否则清理时无法判断该删哪一层。
export const zcodePluginScopeSchema = z.enum(["user", "workspace"]);
export type ZCodePluginScope = z.infer<typeof zcodePluginScopeSchema>;
// hook 详情：type 区分壳命令与长驻进程，shell 允许 true（默认 shell）或显式路径，
// 因此用 union 而不是布尔。runnable 是“当前是否可执行”的快照（未信任、缺文件都会 false），
// 与信任状态分开表达，UI 才能给出准确原因而不是笼统的“不可用”。
// sourcePath 只用于本机展示与信任比对，不用于跨端定位。
export const zcodePluginHookDetailSchema = z
  .object({
    event: nonEmptyString,
    matcher: z.string().optional(),
    type: z.enum(["command", "process"]),
    command: nonEmptyString,
    args: z.array(z.string()).optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string()]).optional(),
    timeout: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    statusMessage: z.string().optional(),
    sourcePath: z.string(),
    runnable: z.boolean(),
  })
  .strict();
// 用户可配置项的描述：sensitive 决定 UI 是否掩码显示（令牌类字段），required 只影响
// 表单校验提示，不参与运行时拒绝——否则一个缺省字段就能让插件整体加载失败。
// default 仅在用户未配置时使用，不能反过来写回配置（那会让“未配置”与“配成默认值”混淆）。
export const zcodePluginUserConfigOptionSchema = z
  .object({
    default: zcodePluginOptionValueSchema.optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    title: z.string().optional(),
    type: z.enum(["string", "number", "boolean", "directory", "file"]).optional(),
  })
  .strict();
export type ZCodePluginUserConfigOption = z.infer<typeof zcodePluginUserConfigOptionSchema>;

// 组件类型与详情弹窗/市场详情共用的分组顺序保持一致：agent / command / skill / hook / mcp。
// 注意：这三个 schema 必须定义在 zcodePluginInfoSchema 之前，因为后者（.strict()）的 components 字段引用了它们。
// 组件类型枚举：顺序即 UI 分组顺序（见上方注释）。枚举值同时被 CLI 的枚举逻辑与
// 详情弹窗使用，新增类型必须两侧同步，否则新组件会落进“未知分组”而不显示。
export const zcodePluginComponentKindSchema = z.enum(["agent", "command", "skill", "hook", "mcp"]);
export type ZCodePluginComponentKind = z.infer<typeof zcodePluginComponentKindSchema>;

// 单个组件条目只带 name + 可选 description：不在这里携带 frontmatter 全文，
// 否则详情接口会把整份声明塞进列表响应，插件多时列表首屏会明显变慢。
export const zcodePluginComponentItemSchema = z
  .object({
    name: nonEmptyString,
    // 描述来自组件 frontmatter（SKILL.md / command / agent）或 manifest；缺失时省略，不伪造。
    description: z.string().optional(),
  })
  .strict();
// 分组是 kind + items 的组合，而不是以 kind 为键的 record：record 会丢失顺序，
// 而 UI 需要按固定顺序渲染。空分组允许存在，让“这类组件一个都没有”也能显式表达。
export const zcodePluginComponentGroupSchema = z
  .object({
    kind: zcodePluginComponentKindSchema,
    items: z.array(zcodePluginComponentItemSchema),
  })
  .strict();
export type ZCodePluginComponentGroup = z.infer<typeof zcodePluginComponentGroupSchema>;

// UI 入口（沙箱页面）：id 与 resourceUri 都有长度上界，防止一个畸形清单让宿主持有超大
// 字符串并写进 IPC。title 允许“单语言字符串或按语言分组的 map”，是因为插件清单两种写法
// 都常见。availability 固定为 session：这类页面只在会话内可用，不是常驻面板。
export const zcodePluginUiSurfaceSchema = z
  .object({
    pluginId: nonEmptyString,
    pluginName: nonEmptyString,
    id: nonEmptyString.max(128),
    title: z.union([nonEmptyString, z.record(z.string(), z.string())]),
    icon: z.string().optional(),
    // 运行时 namespaced server 名（plugin:<name>:<server>），可直接用于 mcp/uiReadResource。
    server: nonEmptyString,
    resourceUri: nonEmptyString.max(2048),
    availability: z.literal("session"),
  })
  .strict();
export type ZCodePluginUiSurface = z.infer<typeof zcodePluginUiSurfaceSchema>;

// declaredMcpServerNames 与 hostMcpServerNames / mcpServerNames 不能合并：前者是插件
// 清单里“声明要用的”名字，后者是宿主实际物化出来的名字（带 plugin:<name>: 前缀）。
// 两者不一致正是“声明了但没生效”的唯一判据，详情页要据此提示用户。
export const zcodePluginInfoSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    source: nonEmptyString,
    marketplace: nonEmptyString,
    // manifest（plugin.json）的作者/主页回退字段；商店 listing 缺失时详情页信息区用它兜底。
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    skillCount: z.number().int().nonnegative().optional(),
    skillRootCount: z.number().int().nonnegative(),
    commandRootCount: z.number().int().nonnegative(),
    // 权威组件清单（名称 + 可选描述），由 CLI 对插件根目录枚举得出，与启用态无关。
    // 详情 UI 直接展示，取代旧的「数量取协议、名称靠 UI 侧 join」脆弱方案。optional 兼容旧 payload。
    components: z.array(zcodePluginComponentGroupSchema).optional(),
    uiSurfaces: z.array(zcodePluginUiSurfaceSchema).optional(),
    declaredMcpServerNames: z.array(z.string()).optional(),
    hostMcpServerNames: z.array(z.string()).optional(),
    mcpServerNames: z.array(z.string()),
    hookDetails: z.array(zcodePluginHookDetailSchema).optional(),
    rootPath: z.string(),
    userConfig: z.record(z.string(), zcodePluginUserConfigOptionSchema).optional(),
    configuredOptions: z.record(z.string(), zcodePluginOptionValueSchema).optional(),
    // 缺省表示 package 可用；missing 用于保留已声明但目标 Host 尚未物化的配置行。
    packageStatus: z.literal("missing").optional(),
    rootSource: zcodePluginScopeSchema.optional(),
    enabledSource: zcodePluginScopeSchema.optional(),
    optionSources: z.record(z.string(), zcodePluginScopeSchema).optional(),
  })
  .strict();
export type ZCodePluginInfo = z.infer<typeof zcodePluginInfoSchema>;

// 诊断项是“能加载但不完美”的说明（缺图标、清单字段多余、组件重复），它不参与
// 校验成败：把它当成错误会让一个无关紧要的告警挡住整个插件。severity 让 UI 决定
// 是否折叠展示，source 指回具体文件，便于用户自行修复。
export const zcodePluginDiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(["warning", "error"]).optional(),
    pluginId: z.string().optional(),
  })
  .strict();
export type ZCodePluginDiagnostic = z.infer<typeof zcodePluginDiagnosticSchema>;

// 列表参数保持最小：插件规模有限，引入分页会让 UI 与 CLI 各写一套游标逻辑，
// 而收益只在极端装机量下才出现。空对象也显式 .strict()，多传字段立刻暴露拼写错误。
export const zcodePluginsListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    configScope: zcodePluginScopeSchema.optional(),
  })
  .strict();
// 列表结果只回摘要，不复用详情结构：详情里含组件清单、hook 明细、rootPath 等大字段，
// 若列表也带上，每次打开插件面板都要搬运整份元数据，插件一多首屏就明显变慢。
export const zcodePluginsListResultSchema = z
  .object({
    plugins: z.array(zcodePluginInfoSchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsListResult = z.infer<typeof zcodePluginsListResultSchema>;

// ── 插件 UI 面板入口──
// 工作区级只读投影：已启用插件清单 `ui.surfaces[]` 的合法条目；插件启停后 host 重新拉取。
// UI 入口查询按会话过滤：入口是否可见取决于该会话里对应 MCP server 是否已握手，
// 因此不带会话就会列出“当前打不开”的入口，用户点进去只会看到空白页。
export const zcodePluginsListUiSurfacesParamsSchema = z
  .object({ workspace: zcodeWorkspaceRefSchema })
  .strict();
export type ZCodePluginsListUiSurfacesParams = z.infer<
  typeof zcodePluginsListUiSurfacesParamsSchema
>;
// 入口结果只含 availability=session 的项，且数量由插件侧清单决定；这里不设额外上限，
// 因为每条都已经过长度约束，限制条数反而会让部分插件的入口无声消失。
export const zcodePluginsListUiSurfacesResultSchema = z
  .object({ surfaces: z.array(zcodePluginUiSurfaceSchema) })
  .strict();
export type ZCodePluginsListUiSurfacesResult = z.infer<
  typeof zcodePluginsListUiSurfacesResultSchema
>;

// ── Plugin 对话引用 catalog（docs/plugin-reference-mention.md）──
// Session-scoped 只读投影：带 sessionId → 该 Session 创建时冻结的身份 catalog；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。身份与能力字段保持
// identifiers-only，不携带 rootPath/配置等；可选 icon/displayName(I18n)/description(I18n)
// 仅供 UI 展示与 Picker 搜索，不参与身份、权限或 runtime reminder。
// 引用目录条目描述“某个插件/技能被谁引用、当前是否可用”。status 必须可选地表达
// missing/disabled：只给布尔 available 会把“没装”和“装了但被禁用”压成同一种状态，
// 用户因此不知道该去安装还是去启用。
export const zcodePluginReferenceCatalogEntrySchema = z
  .object({
    // 仅 referenceCatalogWithCategory 返回；旧入口保持原结构。
    category: nonEmptyString.optional(),
    pluginId: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    icon: z.string().optional(),
    // 商店 listing 的 display-only 本地化显示名投影（沿 icon 先例）：让 Picker 能按
    // 中文显示名搜索/展示；locale 解析复用 shared 的 plugin-display-name helper。
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    // 仅供 Picker 展示，不进入能力身份或 model-only reminder。
    description: z.string().optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean(),
    // 非空 = 与其他 enabled Plugin 共享 manifest name 的 V1 fail closed 冲突：
    // Picker 禁选并展示原因，runtime 解析按 ambiguous 跳过。
    conflictingPluginIds: z.array(nonEmptyString),
    skillQualifiedNames: z.array(nonEmptyString),
    mcpServerNames: z.array(nonEmptyString),
    // 旧 Host 不投影该字段时按空数组兼容；只有新 Agent 会把它用于 reminder live 交集。
    subagentNames: z.array(nonEmptyString).default([]),
  })
  .strict();
export type ZCodePluginReferenceCatalogEntry = z.infer<
  typeof zcodePluginReferenceCatalogEntrySchema
>;

export const zcodePluginsReferenceCatalogParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // 已有 Session 的 Picker 必须带 sessionId 才能拿到 session-owned catalog；
    // session 不存在时按协议错误 fail closed，禁止静默回退 workspace authority。
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodePluginsReferenceCatalogParams = z.infer<
  typeof zcodePluginsReferenceCatalogParamsSchema
>;
// 目录结果带回溯源信息（来源目录与版本），让调用方能判断“该不该重新拉取”：
// 只有条目而没有版本时，任何刷新都只能全量重取，插件多时会反复打满 IO。
export const zcodePluginsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    plugins: z.array(zcodePluginReferenceCatalogEntrySchema),
  })
  .strict();
export type ZCodePluginsReferenceCatalogResult = z.infer<
  typeof zcodePluginsReferenceCatalogResultSchema
>;

// ── Skill 对话引用 catalog──
// 新草稿读取 workspace 当前目录；已有 Session 读取 AgentRuntime 首次 context
// 初始化时冻结的发现结果。该协议只承载 Composer 的只读引用投影，不替代 Settings
// 的 Skill 管理接口，也不持久化 runtime 快照。
// 技能目录条目与插件目录条目刻意分离：技能可能来自插件、项目目录或内置，来源维度
// 不同；合成一个条目会让“同一技能被多处提供”时的优先级无处表达。
export const zcodeSkillReferenceCatalogEntrySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string(),
    path: nonEmptyString,
    scope: z.enum(["workspace", "user", "plugin"]),
    enabled: z.literal(true),
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeSkillReferenceCatalogEntry = z.infer<typeof zcodeSkillReferenceCatalogEntrySchema>;

export const zcodeSkillsReferenceCatalogParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // 带 sessionId 时必须命中该进程内的 resident Session；未知 Session fail closed，
    // 禁止回退到 workspace 当前目录而把新 Skill 泄漏进旧对话。
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeSkillsReferenceCatalogParams = z.infer<
  typeof zcodeSkillsReferenceCatalogParamsSchema
>;
// 技能目录结果与插件目录同构（条目 + 溯源），便于 UI 用同一套列表组件渲染；
// `zcodeSkillsReferenceCatalogResultSchema` 与插件目录不合并：两者失效条件与刷新代价差别很大。
export const zcodeSkillsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    skills: z.array(zcodeSkillReferenceCatalogEntrySchema),
  })
  .strict();
export type ZCodeSkillsReferenceCatalogResult = z.infer<
  typeof zcodeSkillsReferenceCatalogResultSchema
>;

// ── 已保存工作流的 GUI 中枢──
// workspace 级、无会话的五个方法，照 skills/referenceCatalog 的先例：每次调用现扫
// `<cwd>/.zcode/workflows/`（挂载时快照会漏掉手改的文件）。形状与 @zcode/contracts 的
// saved-workflow.ts 逐字对齐——依赖方向是 contracts → shared，所以这里结构化地再声明一遍，
// 而不是 import；两边的 strict 形状由 bootstrap 侧的协议测试互相钉住。
// 工作流参数类型四态：string / number / boolean / json。json 兜底复杂结构，
// 但不单独拆出 array 与 object，是为了让声明侧保持简单——校验交给运行时参数解析。
export const zcodeSavedWorkflowArgTypeSchema = z.enum(["string", "number", "boolean", "json"]);
export type ZCodeSavedWorkflowArgType = z.infer<typeof zcodeSavedWorkflowArgTypeSchema>;
// 单个参数声明：type 决定 UI 控件，required 决定是否允许缺省，default 只在缺省时使用。
// 这里不校验“required 与 default 同时存在”的矛盾组合——真实清单里这种写法很常见，
// 语义按“required 优先”处理，由运行时解释而不是在协议层拒绝整份工作流。
export const zcodeSavedWorkflowArgDeclarationSchema = z
  .object({
    type: zcodeSavedWorkflowArgTypeSchema,
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();
export type ZCodeSavedWorkflowArgDeclaration = z.infer<
  typeof zcodeSavedWorkflowArgDeclarationSchema
>;
// 参数集合用 record（键=参数名）：查参数是热路径，record 的 O(1) 查表比数组线性搜索更
// 合适。代价是顺序不保证，因此 UI 必须按名字排序后再渲染，不能依赖插入顺序。
export const zcodeSavedWorkflowArgsDeclarationSchema = z.record(
  z.string(),
  zcodeSavedWorkflowArgDeclarationSchema,
);
export type ZCodeSavedWorkflowArgsDeclaration = z.infer<
  typeof zcodeSavedWorkflowArgsDeclarationSchema
>;
// 工作流元信息只含声明性字段（名称、描述、参数），不含执行体：执行体在磁盘文件里，
// 通过路径引用。这样列表接口不会因为某个工作流写得很大而变慢，也避免把代码塞进 IPC。
export const zcodeSavedWorkflowMetaSchema = z
  .object({
    description: nonEmptyString,
    whenToUse: nonEmptyString.optional(),
    args: zcodeSavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();
export type ZCodeSavedWorkflowMeta = z.infer<typeof zcodeSavedWorkflowMetaSchema>;
// 作用域两档：项目档落 `<cwd>/.zcode/workflows/`、全局档落 agent 机器的 `~/.zcode/workflows/`。作用域由文件所在目录推得，frontmatter 不存 scope。
// 同名时 project 覆盖 global（见下方 shadowing schema），因此这两个值必须精确，
// 不能出现“继承”之类的第三态——第三态会让覆盖顺序需要在三个层次间裁决。
export const zcodeSavedWorkflowScopeSchema = z.enum(["project", "global"]);
export type ZCodeSavedWorkflowScope = z.infer<typeof zcodeSavedWorkflowScopeSchema>;
// 列表条目带 scope 与来源路径：UI 需要显示“这条来自项目目录还是全局目录”，
// 否则用户在不同仓库看到同名工作流时会以为配置错乱。路径只用于本机展示。
export const zcodeSavedWorkflowEntrySchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    whenToUse: z.string().optional(),
    args: zcodeSavedWorkflowArgsDeclarationSchema.optional(),
    scope: zcodeSavedWorkflowScopeSchema,
    path: nonEmptyString,
  })
  .strict();
export type ZCodeSavedWorkflowEntry = z.infer<typeof zcodeSavedWorkflowEntrySchema>;
// 坏文件只进 invalid、不中断列表：一个 frontmatter 语法错误不应该让整个工作流面板变空。
// path + reason 两项是“用户能自己修”的最小信息集；不带堆栈，因为这里不是日志通道。
export const zcodeSavedWorkflowInvalidEntrySchema = z
  .object({ path: nonEmptyString, reason: nonEmptyString })
  .strict();
export type ZCodeSavedWorkflowInvalidEntry = z.infer<typeof zcodeSavedWorkflowInvalidEntrySchema>;
/** 名字非法 / 未找到 / frontmatter 坏 / 读错——与 core store 的 resolve 失败四态逐字对应。 */
export const zcodeSavedWorkflowFailureReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "parse_error",
  "read_error",
]);
export type ZCodeSavedWorkflowFailureReason = z.infer<typeof zcodeSavedWorkflowFailureReasonSchema>;
// 失败载荷用 ok: literal(false) 而不用抛错：这四类失败都是“用户可理解的常规结果”
// （名字非法、没找到、frontmatter 坏、读不了），抛错会让调用方被迫用 try/catch 分支，
// 而 catch 里拿不到 reason。detail 只作补充，不承担主文案——主文案由 reason 在前端映射。
const zcodeSavedWorkflowFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: zcodeSavedWorkflowFailureReasonSchema,
    detail: z.string().optional(),
  })
  .strict();

// global 档仍要求 workspace 必填，只是把它降级为“载体运行时”（见行内注释）：两档共用
// 同一入参形状，处理器内部才不会出现两条可选参数分支；若改成 optional，每次取用都要
// 先判空，而这个判空在所有档位都成立却没有意义。
export const zcodeWorkflowsListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // 缺省即 `project`（本项目档）。给 `global` 时改扫本机 `~/.zcode/workflows/`；此时 `workspace`
    // 仍必填，但只是**载体运行时**——协议处理器对全局档不读它的路径。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsListParams = z.infer<typeof zcodeWorkflowsListParamsSchema>;
// dir 即使目录尚不存在也必须返回（见行内注释）：GUI 的文件监听要挂在这个路径上，
// 先监听再不存在的目录，才能在该目录被创建的第一时间收到变更；返回 null 会让监听
// 只能等到下一次全量刷新，用户新建的工作流不会立刻出现。
export const zcodeWorkflowsListResultSchema = z
  .object({
    workflows: z.array(zcodeSavedWorkflowEntrySchema),
    invalid: z.array(zcodeSavedWorkflowInvalidEntrySchema),
    // 扫过的目录（本地绝对路径），即使目录还不存在也回：GUI 的文件监听靠它 watch。
    dir: nonEmptyString,
  })
  .strict();
export type ZCodeWorkflowsListResult = z.infer<typeof zcodeWorkflowsListResultSchema>;

export const zcodeWorkflowsGetParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    // 缺省 `project`；`global` 时只查本机全局根。`workspace` 语义同 list（全局档只当载体）。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsGetParams = z.infer<typeof zcodeWorkflowsGetParamsSchema>;
// 用 union 而不是“ok 布尔 + 一堆可选字段”：成功分支的 meta/script 与失败分支的 reason
// 字段集完全不同。若合并，成功分支里 reason 是否为空、失败分支里 script 是否存在都变成
// 隐含约定，消费端必须自写一致性检查——而那一刻它已经在用错的数据了。
export const zcodeWorkflowsGetResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      path: nonEmptyString,
      scope: zcodeSavedWorkflowScopeSchema,
      meta: zcodeSavedWorkflowMetaSchema,
      /** 脚本本体（frontmatter 之后逐字节），即被类型检查与执行的那一份。 */
      script: z.string(),
    })
    .strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsGetResult = z.infer<typeof zcodeWorkflowsGetResultSchema>;

export const zcodeWorkflowsUpdateMetaParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    meta: zcodeSavedWorkflowMetaSchema,
    // 缺省 `project`；`global` 时只写本机全局根那一份。`workspace` 语义同 list。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsUpdateMetaParams = z.infer<typeof zcodeWorkflowsUpdateMetaParamsSchema>;
export const zcodeWorkflowsUpdateMetaResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsUpdateMetaResult = z.infer<typeof zcodeWorkflowsUpdateMetaResultSchema>;

export const zcodeWorkflowsDeleteParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    // 缺省 `project`；`global` 时按 scope 选根删除（不再写死 roots[0]）。`workspace` 语义同 list。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsDeleteParams = z.infer<typeof zcodeWorkflowsDeleteParamsSchema>;
export const zcodeWorkflowsDeleteResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsDeleteResult = z.infer<typeof zcodeWorkflowsDeleteResultSchema>;

// 50 条是“一屏看得完”的量级：运行历史表只增不减，上限设大只会让一次面板打开把整张
// 结果集拉进内存并序列化，而用户并不会滚到第 200 条。需要更早的历史必须显式翻页。
export const ZCODE_WORKFLOWS_RUNS_MAX_LIMIT = 50;
// limit 在这里是必填（文件内其它列表方法的 limit 多为可选）：运行历史是持续增长的表，
// 给默认值等于允许“打开面板”触发一次无界查询；强制调用方写下一个数，才能让每次查询的
// 代价在调用点就可见。上界见 ZCODE_WORKFLOWS_RUNS_MAX_LIMIT。
export const zcodeWorkflowsRunsParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** 只要这个名字的 run（`dwf_run.name` 字面等值）；缺省即本项目全部 run。 */
    name: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(ZCODE_WORKFLOWS_RUNS_MAX_LIMIT),
    // 缺省 `project`：只查 `dwf_run.cwd === workspacePath` 的 run。`global` 时**不**按 cwd 过滤，
    // 跨所有项目取该名字的运行历史（全局工作流在任何项目里跑，历史因此跨 cwd）；结果行带 `cwd`
    // 供 GUI 标项目。`workspace` 语义同 list（全局档只当载体）。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsRunsParams = z.infer<typeof zcodeWorkflowsRunsParamsSchema>;
// 三终态词汇：errored = 脚本之错，stopped = 被停下（可恢复）。
// 五态而不是三态：pending 与 running 分开表达“已入队未起跑”，否则刚创建的行会被当成
// 正在执行；errored 与 stopped 分开表达“脚本之错”与“被外部停下”（见行内注释），
// 这决定 UI 是提示改脚本还是提供恢复入口。
export const zcodeSavedWorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
]);
export type ZCodeSavedWorkflowRunStatus = z.infer<typeof zcodeSavedWorkflowRunStatusSchema>;
// 停止来源五态：user / model / provider 是“有主体主动停”，interrupted 是进程级中断
// （宿主机断开、崩溃恢复），superseded 是被同一名字的新一次运行顶替。后两者绝不能
// 显示成“用户取消”，否则用户会以为自己误操作，实际是系统侧事件。
export const zcodeSavedWorkflowRunStopReasonSchema = z.enum([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);
// 老版本写入的行必然缺新增列，因此 parentSessionId / toolCallId / cwd / artifacts
// 全部是 optional（见各行注释）：这是跨版本读旧库的唯一兼容手段。不要给它们加 default——
// 默认值会把“老行没有这个信息”伪装成“有且为空”，日后无法区分历史缺失与真实空值。
export const zcodeSavedWorkflowRunSchema = z
  .object({
    runId: nonEmptyString,
    name: z.string().optional(),
    status: zcodeSavedWorkflowRunStatusSchema,
    // `status === "stopped"` 才在场。
    stopReason: zcodeSavedWorkflowRunStopReasonSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
    /** 发起它的会话与 CreateWorkflow 工具调用：有这两个才能从中枢打开实例详情。老行可缺。 */
    parentSessionId: z.string().optional(),
    toolCallId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    // 实际运行的项目目录（`dwf_run.cwd`）。全局档的 `workflows/runs` 跨 cwd 查询，GUI 用它给
    // 每行标项目；项目档变体里它恒等于 workspacePath，GUI 可忽略。老行可缺。
    cwd: z.string().optional(),
    // 这次运行发布的**用户面产物**：中枢的运行历史行在
    // 状态词之后画一串 kind chips，详情页头部的「最近产物」条取最近一次 completed run 的这一份。
    // ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是脚本的顶层返回值。
    // 只带 chip 画得下的字段（≤ 8 件，取最新版的元数据）；字节与条目经 v4 查询按需读。
    // optional，照上面 `cwd` 的先例：老 CLI 不发，少一个键是退化不是错误。
    artifacts: z
      .array(
        z
          .object({
            id: nonEmptyString,
            kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
            title: z.string().optional(),
            version: z.number(),
            contentType: z.string().optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type ZCodeSavedWorkflowRun = z.infer<typeof zcodeSavedWorkflowRunSchema>;
// truncated 必须用“多取一条”的判定得出（见行内注释），不能用 length === limit：
// 恰好整页时后者会误报“还有更多”，UI 于是显示一个点进去为空的“加载更多”。
export const zcodeWorkflowsRunsResultSchema = z
  .object({
    runs: z.array(zcodeSavedWorkflowRunSchema),
    /** 为真时才在场：还有更多 run 没进这一页（多取一条判定，不是 length === limit）。 */
    truncated: z.literal(true).optional(),
  })
  .strict();
export type ZCodeWorkflowsRunsResult = z.infer<typeof zcodeWorkflowsRunsResultSchema>;

// workflows/move：把本机全局根的同名文件搬到 `workspace` 项目根。**只此一向**：项目→全局不是搬文件而是模型的概括（「提升为
// 全局」在该项目开新会话、经 SaveWorkflow 另存），所以没有 `to` 参数。同机同用户，rename 优先、EXDEV
// 回落 copy+unlink；逐字节搬，不改内容（frontmatter 不存 scope）；`move` 不覆盖——目标已存在即拒绝
// （覆盖是 SaveWorkflow 经确认窗才有的动作，不变式 7）。`workspace` 既是载体运行时也是目标项目。
// 只有 workspace + name，没有 to/目标档：move 的方向被固定为“全局 → 当前项目”（见行内
// 注释）。反方向不是搬文件而是“另起会话再 SaveWorkflow”的概括动作，协议层若留一个 to
// 参数，就会诱导调用方以为存在一条对称的搬运路径。
export const zcodeWorkflowsMoveParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
  })
  .strict();
export type ZCodeWorkflowsMoveParams = z.infer<typeof zcodeWorkflowsMoveParamsSchema>;
// 失败分支用局部枚举而不是共享的四态：搬运比读取多两个真实失败点（目标已存在、写入
// 失败），套用共享词表就只能把它们压进 read_error，UI 因此无法给出“换个名字”的建议。
export const zcodeWorkflowsMoveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      /** 源落点路径（全局根，搬走前）。 */
      from: nonEmptyString,
      /** 目标落点路径（项目根，搬到处）。 */
      to: nonEmptyString,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // target_exists：目标档已有同名（move 不覆盖）；not_found：源档没有这个名字；
      // read_error / write_error：搬运时的 I/O 失败；invalid_name：名字先验没过。
      reason: z.enum(["invalid_name", "not_found", "target_exists", "read_error", "write_error"]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type ZCodeWorkflowsMoveResult = z.infer<typeof zcodeWorkflowsMoveResultSchema>;

// ── 从一次 run 保存工作流（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
// run, and running it again」）──
// 完成卡的「直接保存」走这条：**不收脚本，只收 runId**——要写的那份正文是这次 run 实际执行的
// 脚本，agent 从 journal 记录（`scriptText`）里读。脚本不经 GUI 走一圈有两个后果值得写下来：
// 修订过的 run 存下的是**结算它的**那一份，而工具行入参被快照裁成预览的老对话也照样存得出
// 同样的字节。名字合法性、覆盖、遮��与类型检查全部复用 SaveWorkflow 的同一套实现（不变式 3）。
/** 另一档已有同名定义（遮蔽事实）；与 contracts 的 SavedWorkflowShadowing 逐字对齐。 */
// 两向关系而不是一个布尔：hides_global 表示“项目档遮住了全局同名”，
// hidden_by_project 表示“全局档被项目同名遮住”。查询方向不同（列项目档 vs 列全局档）
// 会得到相反的值，用布尔会让调用方无法判断当前看的是哪一侧。
export const zcodeSavedWorkflowShadowingSchema = z.enum(["hides_global", "hidden_by_project"]);
export type ZCodeSavedWorkflowShadowing = z.infer<typeof zcodeSavedWorkflowShadowingSchema>;

// 只收 runId、不收脚本文本（见行内注释）：正文由 agent 从 journal 的 scriptText 读出，
// 因此保存的字节与真正执行的那份一致。若让 GUI 传脚本，修订过的 run 会存成“UI 手上的
// 旧快照”，而工具行入参被裁成预览的老对话则根本传不出完整脚本。
// overwrite 缺省即拒绝覆盖：覆盖必须是用户显式决定，不能是保存动作的副作用。
export const zcodeWorkflowsSaveParamsSchema = z
  .object({
    // 两用：既是载体运行时，也是这次 run 的项目——journal 在它那里，项目根也在它那里。
    // 全局档同样带它（与 list/get 的「全局只当载体」不同）：脚本必须从这个 agent 的 journal 读。
    workspace: zcodeWorkspaceRefSchema,
    runId: nonEmptyString,
    name: nonEmptyString,
    meta: zcodeSavedWorkflowMetaSchema,
    // 缺省 `project`。
    scope: zcodeSavedWorkflowScopeSchema.optional(),
    // 只有 GUI 已经把覆盖警告摆给用户看过时才为 true；缺省即「目标已存在就拒绝」——
    // 覆盖是用户的决定，不是一次保存的副作用（与 `workflows/move` 不覆盖同一条纪律）。
    overwrite: z.boolean().optional(),
  })
  .strict();
export type ZCodeWorkflowsSaveParams = z.infer<typeof zcodeWorkflowsSaveParamsSchema>;
// overwritten 是“写入那一刻重新判定”的结果（见行内注释），不能回抄入参：入参的
// overwrite 只是许可，实际是否发生覆盖取决于目标当时是否存在。回抄会让 UI 显示
// “已覆盖”而实际只是新建，或反之。
export const zcodeWorkflowsSaveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      scope: zcodeSavedWorkflowScopeSchema,
      path: nonEmptyString,
      /** 写的那一刻重新判定，不回抄入参里的 `overwrite`（与 SaveWorkflow 的 `overwritten` 同源）。 */
      overwritten: z.boolean(),
      shadowing: zcodeSavedWorkflowShadowingSchema.optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // run_not_found：journal 里没有这条 run；script_missing：老记录没存脚本原文；
      // target_exists：目标已存在而调用方没说覆盖；compile_failed：类型检查没过，一个字节都没写。
      reason: z.enum([
        "invalid_name",
        "run_not_found",
        "script_missing",
        "target_exists",
        "compile_failed",
        "write_error",
      ]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type ZCodeWorkflowsSaveResult = z.infer<typeof zcodeWorkflowsSaveResultSchema>;

// ── 一次 run 对应哪个已保存工作流 ──
// 完成卡的「已保存」芯片与「再次运行」都问这一个问题，而答案**推导得来、不记在卡上**：重开
// 会话、换一个窗口保存、在对话里保存，都走同一条判定。判定住在 agent 一侧，因为两份事实
// （run 的 journal 记录与磁盘上的定义）都在那里；返回解析好的 entry，用户后来删掉的那一份
// 因此会自动不再算数。
/** 转写自对话的候选：模型用 `SaveWorkflow` 存过、并在入参里认领了这次 run。 */
// 候选由调用方（对话侧）提供，因为它掌握“模型保存时认领了哪次 run”这一事实；协议只做
// 形状与条数约束。candidates 缺席时保底退化为按脚本指纹/名字匹配（见下方 params）。
export const zcodeWorkflowsForRunCandidateSchema = z
  .object({ name: nonEmptyString, scope: zcodeSavedWorkflowScopeSchema.optional() })
  .strict();
export type ZCodeWorkflowsForRunCandidate = z.infer<typeof zcodeWorkflowsForRunCandidateSchema>;
/** 候选上界：一次 run 在一段对话里被存过的次数远小于它。 */
// 8 条上界与“一次会话里保存过几次”同量级：候选是线性比对，且每条都要读盘校验存在性，
// 放宽到几十条会让“打开完成卡”变成一次批量 IO。
export const ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES = 8;
// candidates 可选：省略时只用脚本指纹与名字两条规则匹配。之所以不强制传，
// 是因为“重开会话后打开完成卡”这种场景里，对话侧的候选列表已经丢失，
// 但磁盘上的定义还在——此时仍应能推导出对应工作流。
export const zcodeWorkflowsForRunParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    runId: nonEmptyString,
    candidates: z
      .array(zcodeWorkflowsForRunCandidateSchema)
      .max(ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES)
      .optional(),
  })
  .strict();
export type ZCodeWorkflowsForRunParams = z.infer<typeof zcodeWorkflowsForRunParamsSchema>;
// entry 缺席表示“这次 run 还没有对应的已保存工作流”，这是合法结果而非错误。
// match 只用于诊断与测试（见行内注释）：UI 不应按命中规则改变渲染，否则同一份定义
// 会因命中路径不同而显示成两种状态。
export const zcodeWorkflowsForRunResultSchema = z
  .object({
    /** 命中的定义；缺席即这次 run 还没有对应的已保存工作流。 */
    entry: zcodeSavedWorkflowEntrySchema.optional(),
    /** 命中的是哪一条规则（诊断与测试用；UI 只看 entry 在不在）。 */
    match: z.enum(["candidate", "script", "name"]).optional(),
    /** 这次 run 跑时用的实参（journal 原样），供「再次运行」预填实参窗。 */
    runArgs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ZCodeWorkflowsForRunResult = z.infer<typeof zcodeWorkflowsForRunResultSchema>;

// 推荐 Prompt 的可信插件解析：UI 不拆解 stableId，也不从旧目录快照推断可安装性。
// 五态让 UI 为每种情况给出不同动作：ready 可直接引用、disabled 引导启用、missing 引导
// 安装、conflict 要求用户二选一、unavailable 说明当前环境不支持。若只有“可用/不可用”，
// 五种处置会退化成同一句“无法使用”，用户无从下手。
export const zcodePluginSuggestedReferenceStatusSchema = z.enum([
  "ready",
  "disabled",
  "missing",
  "conflict",
  "unavailable",
]);
export type ZCodePluginSuggestedReferenceStatus = z.infer<
  typeof zcodePluginSuggestedReferenceStatusSchema
>;
// 插件操作状态机：checking / refreshing / installing / enabling 是进行中，
// cancelling 与 cancelled 必须分开——“已请求取消”不代表已停下，此时释放资源会让
// 后台仍在写的文件被抢占。complete / failed 是终态，UI 据此关闭进度条。
export const zcodePluginOperationStateSchema = z.enum([
  "checking",
  "refreshing",
  "installing",
  "enabling",
  "cancelling",
  "cancelled",
  "complete",
  "failed",
]);
export type ZCodePluginOperationState = z.infer<typeof zcodePluginOperationStateSchema>;
// 只播报 refreshing 这一个中间态（state 固定字面量）：其余状态由调用的返回值一次性给出，
// 全都做成事件会让“一次安装”产生七八条通知，而 UI 真正需要的只是“还在拉取”的提示。
export const zcodePluginOperationProgressNotificationSchema = z
  .object({
    operationId: nonEmptyString,
    state: z.literal("refreshing"),
  })
  .strict();
export type ZCodePluginOperationProgressNotification = z.infer<
  typeof zcodePluginOperationProgressNotificationSchema
>;
// stableId 不拆解（见行内注释）：它是不透明引用，拆分逻辑会随目录格式演进。
// operationId 让后续“取消/进度”能落到这一次解析上；clientMode 与 deliveryKind 分开，
// 因为前者是 UI 形态（桌面/远程），后者是分发渠道（内置/市场），二者组合才决定候选来源。
export const zcodePluginsResolveSuggestedReferenceParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    stableId: nonEmptyString,
    operationId: nonEmptyString,
    clientMode: zcodeDeliveryKindSchema,
    deliveryKind: zcodeDeliveryKindSchema,
  })
  .strict();
export type ZCodePluginsResolveSuggestedReferenceParams = z.infer<
  typeof zcodePluginsResolveSuggestedReferenceParamsSchema
>;
// operationId 可选：启停是快操作，不要求可取消；强行必填会让所有调用方构造一个假 id。
// scope 可选表示“按插件当前所在作用域修改”，显式给出则用于跨档启用（例如在项目内启用
// 一个全局插件），两者语义不同，因此不能只保留一种。
export const zcodePluginsSetEnabledParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    enabled: z.boolean(),
    operationId: nonEmptyString.optional(),
    scope: zcodePluginScopeSchema.optional(),
  })
  .strict();
// 回传完整 plugin 摘要而不只是 enabled：调用方（设置页）需要在一次往返后重绘该行，
// 否则还要再发一次 overview 才能拿到最新的 hookDetails / updateStatus。
// enabled 是“写入后的实际值”，可能因策略或依赖未满足而与人参不同，因此必须回读。
export const zcodePluginsSetEnabledResultSchema = z
  .object({
    plugin: zcodePluginInfoSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodePluginsSetEnabledResult = z.infer<typeof zcodePluginsSetEnabledResultSchema>;

// 商店信息（Store Listing）：目录条目携带的展示性元数据（显示名/icon/分类/作者/链接/hero/
// 示例提示词），全部可选，UI 缺失时按降级矩阵处理（字母头像/隐藏区块/省略信息行）。
// i18n 采用 `<字段>I18n` map，locale 解析复用 shared 的 plugin-display-name helper。
// 全部字段 optional（见行内注释）：清单里缺什么就降级什么，不能因为少一个 icon 让整个
// 插件从商店里消失。i18n 采用“基础字段 + <字段>I18n map”双轨而不是只留 map：
// 只有 map 时，遇到未覆盖的 locale 就无值可回退，UI 只能显示空标题。
export const zcodePluginStoreListingSchema = z
  .object({
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    publisherType: z.enum(["official", "community"]).optional(),
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    privacyPolicy: z.string().optional(),
    termsOfService: z.string().optional(),
    heroImage: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    examplePromptsI18n: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * 需要付费套餐才好用的插件：市场目录条目声明 `requiresPaidPlan: true`，
     * UI 在标题右侧展示提示图标。描述的是「使用条件」而非「插件是收费商品」——
     * 不参与安装门禁与计费，命名也不绑定具体套餐商品名。
     */
    requiresPaidPlan: z.boolean().optional(),
  })
  .strict();
export type ZCodePluginStoreListing = z.infer<typeof zcodePluginStoreListingSchema>;

// superRefine 只对“可行动”的三态（ready/disabled/missing）要求可信安装身份：
// 这三种状态在 UI 上都会渲染出安装/启用按钮，缺 marketplace 或 pluginName 时按钮点下去
// 只能构造一个空请求。unavailable/conflict 不要求，因为它们本来就不提供安装入口。
export const zcodePluginsResolveSuggestedReferenceResultSchema = z
  .object({
    stableId: nonEmptyString,
    status: zcodePluginSuggestedReferenceStatusSchema,
    marketplace: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    sourceTrust: z.literal("official").optional(),
    // 官方 Marketplace listing 的可选展示投影；不参与身份、安装或权限判断。
    icon: z.string().optional(),
    listing: zcodePluginStoreListingSchema.optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "ready" && value.status !== "disabled" && value.status !== "missing") {
      return;
    }
    if (!value.marketplace || !value.pluginName || value.sourceTrust !== "official") {
      context.addIssue({
        code: "custom",
        message: "actionable suggested Plugin results require trusted install identity",
      });
    }
  });
export type ZCodePluginsResolveSuggestedReferenceResult = z.infer<
  typeof zcodePluginsResolveSuggestedReferenceResultSchema
>;

// refreshFailure 整体可选：目录刷新失败只让“可安装列表”变旧，不影响本地已装插件运行，
// 因此它是摘要上的一个污点标记，而不是让整个 overview 失败。code/failedAt/message 三件套
// 分开存，是为了让 UI 既能显示时间也能按 code 归类，而不是解析一段错误文本。
export const zcodePluginMarketplaceSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    source: jsonObjectSchema,
    description: z.string().optional(),
    lastUpdated: z.string().optional(),
    pluginCount: z.number().int().nonnegative(),
    isOfficial: z.boolean().optional(),
    // 目录顶层 featured 策展名单（商店「公开」分段 Featured 区）。
    featured: z.array(z.string()).optional(),
    refreshFailure: z
      .object({
        code: z.string(),
        failedAt: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodePluginMarketplaceSummary = z.infer<typeof zcodePluginMarketplaceSummarySchema>;

// installed 是“同一份投影里的状态位”，而不是拆成两个列表：可安装与已安装共用一个行组件，
// 拆开后同一插件会在两个列表里出现两次，用户无法判断点哪一行才是当前生效的那份。
// componentTypes 用字符串数组而非封闭枚举，因为目录侧的组件类型可能先于客户端更新。
export const zcodeAvailablePluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    installed: z.boolean(),
    componentTypes: z.array(z.string()).optional(),
    listing: zcodePluginStoreListingSchema.optional(),
  })
  .strict();
export type ZCodeAvailablePluginSummary = z.infer<typeof zcodeAvailablePluginSummarySchema>;

// installPath 可选：内置插件没有安装目录。updateStatus 三态里 version-changed 表示
// “本地版本与目录版本不一致但不一定可升级”（例如本地被手工改过），
// 与 update-available 分开，UI 才能分别提示“可更新”与“已被修改”。
export const zcodeInstalledPluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    scope: zcodePluginScopeSchema,
    installPath: z.string().optional(),
    installedAt: z.string().optional(),
    componentTypes: z.array(z.string()).optional(),
    hookDetails: z.array(zcodePluginHookDetailSchema).optional(),
    updateStatus: z.enum(["none", "update-available", "version-changed"]).optional(),
    latestVersion: z.string().optional(),
    listing: zcodePluginStoreListingSchema.optional(),
  })
  .strict();
export type ZCodeInstalledPluginSummary = z.infer<typeof zcodeInstalledPluginSummarySchema>;

// configScope 可选：省略时按当前默认档返回完整概览；显式传值用于“项目视角”查看
// 该项目下实际生效的启用状态。它只影响读的口径，不改变任何配置。
export const zcodePluginsOverviewParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    configScope: zcodePluginScopeSchema.optional(),
  })
  .strict();
// capability.supported 必须显式表达“当前构建根本不支持插件系统”：只回空数组时，
// UI 会把它渲染成“一个插件都没装”，用户于是反复尝试添加市场却毫无反馈。
// restorableBuiltins 单独一组，是因为内置插件被卸载后需要“恢复”而不是“安装”。
export const zcodePluginsOverviewResultSchema = z
  .object({
    marketplaces: z.array(zcodePluginMarketplaceSummarySchema),
    availablePlugins: z.array(zcodeAvailablePluginSummarySchema),
    installedPlugins: z.array(zcodeInstalledPluginSummarySchema),
    restorableBuiltins: z.array(zcodeAvailablePluginSummarySchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
    capability: z
      .object({
        supported: z.boolean(),
        reason: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodePluginsOverviewResult = z.infer<typeof zcodePluginsOverviewResultSchema>;

// source 是用户输入的目录地址（URL/路径/内置标识），由服务端解析并归一；
// 协议层只做非空校验，不在这里判定形态——形态随分发渠道扩展而变，写死在协议里
// 会让新渠道的地址在旧客户端被直接拒掉。dryRun 用于先探测合法性而不落盘。
export const zcodePluginsMarketplaceAddParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    source: nonEmptyString,
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
// 移除不带 dryRun / operationId：它是本地即时操作（删一条配置），既没有可预演的远程
// 副作用，也不会长时间运行到需要取消。多给这两个参数只会让调用方以为它是异步任务。
export const zcodePluginsMarketplaceRemoveParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    marketplace: nonEmptyString,
  })
  .strict();
// marketplace 可选表示“更新全部市场”：单个更新与全量刷新共用同一方法，
// 是为了让调用方只处理一种返回形状；operationId 可选，全量刷新耗时长时可传以便取消。
export const zcodePluginsMarketplaceUpdateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    marketplace: nonEmptyString.optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
// 三个字段全部 optional，因为三种操作的返回粒度不同：add 回单个 marketplace，
// update 全量时回整个列表，remove 只回 diagnostics。合并成一个必填形状会迫使
// 各操作填充无意义字段，消费端还要判断“这个字段这次有没有意义”。
export const zcodePluginsMarketplaceMutationResultSchema = z
  .object({
    marketplace: zcodePluginMarketplaceSummarySchema.optional(),
    marketplaces: z.array(zcodePluginMarketplaceSummarySchema).optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema).optional(),
  })
  .strict();
export type ZCodePluginsMarketplaceMutationResult = z.infer<
  typeof zcodePluginsMarketplaceMutationResultSchema
>;

// (pluginName, marketplace) 共同定位一个可安装插件：同名插件可能出现在多个市场，
// 只按名字装会装到非预期的来源（供应链风险）。scope 可选表示按默认档安装。
export const zcodePluginsInstallParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
    scope: zcodePluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
// 取消只认 operationId，且必填：调用方拿不到 id 时不应该“猜一个”去取消，
// 那可能停掉另一个正在写入的安装。空对象也 strict，避免多传字段造成误解。
export const zcodePluginsCancelOperationParamsSchema = z
  .object({
    operationId: nonEmptyString,
  })
  .strict();
export type ZCodePluginsCancelOperationParams = z.infer<
  typeof zcodePluginsCancelOperationParamsSchema
>;

// cancelled=false 是合法结果而不是错误：操作可能在取消到达前刚好完成，或 operationId
// 已经过期。把它做成错误会让“点取消晚了一步”弹出一个失败提示，而实际安装是成功的。
export const zcodePluginsCancelOperationResultSchema = z
  .object({
    operationId: nonEmptyString,
    cancelled: z.boolean(),
  })
  .strict();
export type ZCodePluginsCancelOperationResult = z.infer<
  typeof zcodePluginsCancelOperationResultSchema
>;
// 两组定位方式二选一：pluginId 用于已安装项，pluginName + marketplace 用于“只在目录里
// 见过”的候选。协议层不做互斥校验，是因为旧客户端曾同时传过二者（以 pluginId 为准），
// 收紧会让它们的卸载请求整体被拒。
// removeCache 缺省保留下载缓存：用户重装同一版本时不必再次下载，只有显式要求才清理。
export const zcodePluginsUninstallParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    removeCache: z.boolean().optional(),
  })
  .strict();
// dependencyClosure 回传本次一并装进来的依赖名：用户点“安装 A”却多了 B、C 时，
// 必须能解释来源，否则会以为装错了。返回名称而非完整摘要，是为了避免结果随依赖数量膨胀。
export const zcodePluginsInstallResultSchema = z
  .object({
    installedPlugins: z.array(zcodeInstalledPluginSummarySchema),
    dependencyClosure: z.array(z.string()),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsInstallResult = z.infer<typeof zcodePluginsInstallResultSchema>;

// removedPlugin 可选：卸载完成后该插件的元信息可能已不可读（内置项走的是“恢复出厂”
// 路径，磁盘上不再有摘要）。强制必填会迫使实现拼一份假摘要出来。
export const zcodePluginsUninstallResultSchema = z
  .object({
    removedPlugin: zcodeInstalledPluginSummarySchema.optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsUninstallResult = z.infer<typeof zcodePluginsUninstallResultSchema>;

// pluginId 与 marketplace 都可选，分别表示“更新这一个”与“更新该市场下的全部”。
// 只保留一个参数就无法表达批量更新；而给一个 all 布尔，又会让“全部”与“某个 id”
// 同时成立时产生歧义。
export const zcodePluginsUpdateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
  })
  .strict();
// 恢复内置只按 pluginId，不带 scope：内置插件属于构建产物，没有“用户档/项目档”之分，
// 它的启用状态才分档。带上 scope 会让人误以为可以把内置插件恢复到某个作用域里。
export const zcodePluginsRestoreBuiltinParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
  })
  .strict();
export const zcodePluginsRestoreBuiltinResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsRestoreBuiltinResult = z.infer<
  typeof zcodePluginsRestoreBuiltinResultSchema
>;

// options 是“要写入的键值”，clearOptionKeys 是“要显式删除的键”。两者分开而不是用
// “缺席即删除”：配置是多层合并的（用户档 + 项目档），一次提交里缺席的键可能只是想
// 沿用上一层，若按删除处理就会把上层配置一起抹掉。
export const zcodePluginsConfigureParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    options: jsonObjectSchema,
    clearOptionKeys: z.array(nonEmptyString).optional(),
    scope: zcodePluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export const zcodePluginsConfigureResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsConfigureResult = z.infer<typeof zcodePluginsConfigureResultSchema>;

// 重置只带 pluginId + scope，不接受“只重置某几个键”：那等价于 configure 的
// clearOptionKeys，两种方法做同一件事会让调用方在“删掉整个档”和“删几个键”之间
// 选错，而两者都是不可撤销的。
export const zcodePluginsResetConfigParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    scope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export type ZCodePluginsResetConfigParams = z.infer<typeof zcodePluginsResetConfigParamsSchema>;

// 三种定位方式（已安装名 + 市场、裸 source）互斥但 schema 不做校验：校验属于
// “本次构建支持哪种来源”的业务判断，写进协议会让新增来源类型需要同时改两端，
// 而这里只负责把用户的输入原样送达。
export const zcodePluginsValidateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    source: nonEmptyString.optional(),
  })
  .strict();
// ok 与 compatibility 必须分开：ok=false 表示“清单本身不合法”，此时 compatibility
// 三组可能都为空；ok=true 但某个组件落在 unsupported 里，表示“能装但有一部分跑不了”。
// 若只给 ok，用户会以为安装成功即可用，实际少了一半功能却没有任何提示。
export const zcodePluginsValidateResultSchema = z
  .object({
    ok: z.boolean(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
    compatibility: z
      .object({
        runnable: z.array(z.string()),
        diagnosticOnly: z.array(z.string()),
        unsupported: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type ZCodePluginsValidateResult = z.infer<typeof zcodePluginsValidateResultSchema>;

// plugins/describe：按需枚举单个插件的组件「名称 + 描述」。
// 已安装插件读本地缓存目录；未安装候选按需解析/临时 clone 源后枚举再清理。
// 未安装候选也要能 describe（见行内注释），因此定位用 name + marketplace 而不是
// pluginId：此时还没有安装记录，拿不到 id。两者都必填，缺一个就会解析到错误来源。
export const zcodePluginsDescribeParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
  })
  .strict();
// metadata 是“商店 listing 缺失时的兜底”（见行内注释），因此单独一组而不是塞进
// listing：listing 描述的是市场侧的展示信息，metadata 来自插件包内的 plugin.json，
// 两者来源不同，混在一起后 UI 无法判断某个字段是否可信。
export const zcodePluginsDescribeResultSchema = z
  .object({
    components: z.array(zcodePluginComponentGroupSchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema).optional(),
    // 插件包内 plugin.json 的展示性回退字段；未安装候选详情页信息区在商店 listing 缺失时兜底。
    metadata: z
      .object({
        author: z.string().optional(),
        authorUrl: z.string().optional(),
        homepage: z.string().optional(),
        version: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodePluginsDescribeResult = z.infer<typeof zcodePluginsDescribeResultSchema>;

// scheduleRule 是调度的权威定义：cron 表达不了“每 50 小时/每 40 天”这类真实间隔。
// anchorAt 是 epoch 毫秒锚点，让“每 N 小时”有确定起点——没有锚点，重启后相位会漂移，
// 用户会看到任务在一天里不断换时间跑。hour/minute 用 0-23/0-59 的整数范围校验，
// 越界表示上游生成逻辑出错，应当在解析期暴露。weekdays 用 0-6（周日为 0），
// monthDays 用 1-31；两者只在对应 unit 下有意义，协议层不做跨字段校验。
export const zcodeAutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
export type ZCodeAutomationScheduleRuleProtocol = z.infer<typeof zcodeAutomationScheduleRuleSchema>;

/** 会话侧长间隔周期 carrier 的 unit 枚举（与 scheduleRule.unit 同集）。 */
// 与 scheduleRule.unit 同集（见上方 JSDoc）：两处枚举必须逐字一致，任何一边新增取值
// 都会让“会话侧归一化”与“调度器解析”对同一个周期产生两种理解。
export const zcodeAutomationIntervalUnitSchema = z.enum([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

// 快照里的 scheduleRule 可选，是为了兼容未写入该字段的旧记录（见行内注释：缺省回退解析
// cronExpr）。runCount / maxRuns 由调度器维护，协议层只读——让客户端可写会让“已跑次数”
// 变成可以被伪造的计数。lifecycleStatus 四态与 enabled 正交：enabled=false 是人工暂停，
// completed 是达到 maxRuns 自然结束，二者在 UI 上的恢复入口不同。
export const zcodeAutomationProtocolSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zcodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: timestampMsSchema.optional(),
    lastRunAt: timestampMsSchema.optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    // 自定义重复规则；缺省时调度回退到解析 cronExpr。会话卡片必须读到本字段才能展示
    // cron 无法表达的真实间隔（如每50小时、每40天，兼容 cronExpr 只是 0 * * * *）。
    scheduleRule: zcodeAutomationScheduleRuleSchema.optional(),
  })
  .strict();
export type ZCodeAutomationProtocol = z.infer<typeof zcodeAutomationProtocolSchema>;

// relativeDelayMinutes 上限 525_600（约一年）：再长的“延迟”实质是定时任务，应改用 cron /
// scheduleRule；不设上限会让调度器为一条记录维护一个跨越多年的定时器。cronExpr 仍然必填，
// 因为它同时充当“展示用的兼容表达式”（见行内注释），不是可选装饰。
// intervalUnit 与 interval 必须同时给或同时缺（refine 见下方）：只给一个时，归一化逻辑
// 会拿另一个字段的默认值凑出一个用户从未要求的周期，而且这个错误在创建成功后才显现——
// 用户以为设的是“每 3 小时”，实际跑的是默认值。
export const zcodeAutomationCreateParamsSchema = z
  .object({
    title: z.string().optional(),
    cronExpr: nonEmptyString,
    relativeDelayMinutes: z.number().int().positive().max(525_600).optional(),
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zcodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().optional(),
    // 会话侧自定义重复 carrier：每 N 分钟/小时/天/周/月/年均通过此字段归一化为权威 scheduleRule，
    // cronExpr 仅作合法兼容展示。
    intervalUnit: zcodeAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  // intervalUnit 与 interval 必须配对提交（只传一个无法确定真实间隔）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // 周期 carrier 与一次性相对延迟语义冲突，禁止同传。
  .refine((input) => input.intervalUnit === undefined || input.relativeDelayMinutes === undefined, {
    message: "intervalUnit cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });
export type ZCodeAutomationCreateProtocolParams = z.infer<typeof zcodeAutomationCreateParamsSchema>;

export const zcodeAutomationCreateResultSchema = z
  .object({ automation: zcodeAutomationProtocolSchema })
  .strict();
export type ZCodeAutomationCreateProtocolResult = z.infer<typeof zcodeAutomationCreateResultSchema>;

// 更新是“只改给出的部分”，因此字段全 optional；但它不能复用 create 的 refine 语义：
// 更新时只改 intervalUnit 而不改 interval 是合法意图（沿用原间隔值），
// 若套用“必须成对”的规则，用户就永远改不了单位。
export const zcodeAutomationUpdateParamsSchema = z
  .object({
    automationId: nonEmptyString,
    title: nonEmptyString.optional(),
    cronExpr: nonEmptyString.optional(),
    prompt: nonEmptyString.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().nullable().optional(),
    // 会话侧自定义重复 carrier（同 create 侧语义）。
    intervalUnit: zcodeAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.cronExpr !== undefined ||
      input.prompt !== undefined ||
      input.recurring !== undefined ||
      input.maxRuns !== undefined ||
      input.intervalUnit !== undefined,
    { message: "automation update requires at least one field" },
  )
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "clearing maxRuns requires recurring=true",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit 与 interval 必须配对提交（同 create 侧语义）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );
export type ZCodeAutomationUpdateProtocolParams = z.infer<typeof zcodeAutomationUpdateParamsSchema>;
export const zcodeAutomationUpdateResultSchema = z
  .object({ automation: zcodeAutomationProtocolSchema })
  .strict();
export type ZCodeAutomationUpdateProtocolResult = z.infer<typeof zcodeAutomationUpdateResultSchema>;

// 列表无参数（空对象 strict）：自动化任务按当前 workspace 归属由运行时上下文决定，
// 不接受调用方指定 workspace——否则一个窗口就能枚举到别的项目的定时任务。
export const zcodeAutomationListParamsSchema = z.object({}).strict();
export type ZCodeAutomationListProtocolParams = z.infer<typeof zcodeAutomationListParamsSchema>;
export const zcodeAutomationListResultSchema = z
  .object({ automations: z.array(zcodeAutomationProtocolSchema) })
  .strict();
export type ZCodeAutomationListProtocolResult = z.infer<typeof zcodeAutomationListResultSchema>;

export const zcodeAutomationCheckTaskBindingParamsSchema = z
  .object({ targetTaskId: nonEmptyString })
  .strict();
export type ZCodeAutomationCheckTaskBindingProtocolParams = z.infer<
  typeof zcodeAutomationCheckTaskBindingParamsSchema
>;
export const zcodeAutomationCheckTaskBindingResultSchema = z
  .object({ bound: z.boolean() })
  .strict();
export type ZCodeAutomationCheckTaskBindingProtocolResult = z.infer<
  typeof zcodeAutomationCheckTaskBindingResultSchema
>;

// 删除只按 automationId，不要求回传任务内容：身份已经足够，回传内容反而会诱导实现
// “校验内容一致才删除”，而内容在运行过程中可能被调度器更新，导致用户永远删不掉。
export const zcodeAutomationDeleteParamsSchema = z
  .object({ automationId: nonEmptyString })
  .strict();
export type ZCodeAutomationDeleteProtocolParams = z.infer<typeof zcodeAutomationDeleteParamsSchema>;
export const zcodeAutomationDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();
export type ZCodeAutomationDeleteProtocolResult = z.infer<typeof zcodeAutomationDeleteResultSchema>;

// ---- Off-Peak（闲时任务）会话内创建协议----
// 与 automation 兄弟并列（独立域，禁止互相复用标记/表）。workspace 由 host 端从
// 当前 session 注入，不进协议参数（对称 automation/create）。permissionMode 只开放产品
// 四档词表（D29-4）；缺省解析在 host 端（D49-4：yolo / allowed_models 末位 / 最高推理档）。
export const zcodeOffPeakPermissionModeSchema = z.enum([
  "build",
  "edit",
  "plan",
  "yolo",
  "guarded",
]);
export type ZCodeOffPeakProtocolPermissionMode = z.infer<typeof zcodeOffPeakPermissionModeSchema>;

// Off-Peak 创建参数：任务描述与执行窗口分离，窗口用 mode 枚举而不是时间戳，
// 让“错峰”策略留在服务端解释；客户端只声明意愿。prompt 走 nonEmptyString，
// 因为空提示会生成一个无意义的错峰任务，而且它会在夜间被真实计费。
export const zcodeOffPeakCreateParamsSchema = z
  .object({
    title: nonEmptyString,
    prompt: nonEmptyString,
    permissionMode: zcodeOffPeakPermissionModeSchema.optional(),
    model: nonEmptyString.optional(),
    thoughtLevel: nonEmptyString.optional(),
    // 会话内创建绑定当前会话（对齐 automation/create 的 targetTaskId），由 CLI 端口填入。
    boundSessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeOffPeakCreateProtocolParams = z.infer<typeof zcodeOffPeakCreateParamsSchema>;

// 协议侧任务快照：轮尾卡片与 OffPeakList 的最小字段面。
// 不暴露 serverTicketId（跨边界禁带）。
export const zcodeOffPeakTaskSnapshotSchema = z
  .object({
    offPeakTaskId: nonEmptyString,
    title: z.string(),
    status: z.enum(["queued", "paused", "running", "completed", "failed", "cancelled"]),
    queuePosition: z.number().int().positive().optional(),
    sessionId: nonEmptyString.optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeOffPeakTaskProtocolSnapshot = z.infer<typeof zcodeOffPeakTaskSnapshotSchema>;

// 失败分类跨协议保真（镜像 shared OffPeakTaskCreateResult 的判别联合，错误不降级为字符串）。
// model 白名单预校失败复用 client_validation 分类 + errorCode "model_not_allowed"，不扩分类枚举。
// 创建结果用 ok 判别（见 INV-21）：失败分支必须同时给出 failureStage 与 errorCategory，
// 一个说“在哪一步失败”（提交/排队/执行），一个说“为什么失败”（配额/权限/超时）。
// 只有其中一个时，UI 要么无法定位重试点，要么无法给出可执行的处置建议。
export const zcodeOffPeakCreateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: zcodeOffPeakTaskSnapshotSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      failureStage: z.enum(["client_validation", "ticket_request", "local_persist"]),
      errorCategory: z.enum([
        "client_validation",
        "eligibility_3101",
        "quota_3103",
        "network",
        "invalid_response",
        "local_persist",
        "unknown",
      ]),
      errorCode: z.string(),
    })
    .strict(),
]);
export type ZCodeOffPeakCreateProtocolResult = z.infer<typeof zcodeOffPeakCreateResultSchema>;

// Off-Peak 列表同样无参数（空对象 strict）：错峰任务归属于当前账号与运行时上下文，
// 任何过滤条件都应由服务端从上下文推导，而不是让调用方传入可伪造的账号标识。
export const zcodeOffPeakListParamsSchema = z.object({}).strict();
export type ZCodeOffPeakListProtocolParams = z.infer<typeof zcodeOffPeakListParamsSchema>;
export const zcodeOffPeakListResultSchema = z
  .object({ tasks: z.array(zcodeOffPeakTaskSnapshotSchema) })
  .strict();
export type ZCodeOffPeakListProtocolResult = z.infer<typeof zcodeOffPeakListResultSchema>;

// 方法名总表：右侧字符串是线上 method 名，左侧键只是调用侧常量（同 notifications 的纪律）。
// 这张表必须与各 params/result schema 的命名一一对应：多登记一个没有 schema 的方法，
// 会让调用方发出一个永远得不到校验的请求；少登记一个实现，则表现为“方法不存在”。
// 新增方法只能追加，不能改动既有字符串——改名等于让所有已部署客户端立刻失联。
export const zcodeProtocolMethods = {
  runtimeCapabilities: "runtime/capabilities",
  computerUseOperationEvent: "computer-use/operation-event",
  sessionCreate: "session/create",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionSubagents: "session/subagents",
  sessionRequestRuntimePreferences: "session/requestRuntimePreferences",
  subagentsReadRuntimeConfig: "subagents/readRuntimeConfig",
  sessionRead: "session/read",
  sessionMessages: "session/messages",
  sessionEvents: "session/events",
  sessionDebug: "session/debug",
  sessionSubscribe: "session/subscribe",
  // @deprecated（部分）：send 主路径已收敛 v4 sendText；仅剩 adapter 附件
  // 回退分支消费（v4 attachmentRef 上传/寄存命令面未建模），待附件命令面落地后移除。
  sessionSend: "session/send",
  // @deprecated：host 客户端方法已删（stop 已收敛 v4 stop 命令）。
  // wire case 留兼容（transport bypass 名单仍引用），随旧词整体删除时一并移除。
  sessionStop: "session/stop",
  // @deprecated：host 客户端方法已删（已收敛 v4 cancelBackgroundWork 命令）。
  // wire case 留兼容，随旧词整体删除时一并移除。
  sessionCancelBackgroundTask: "session/cancelBackgroundTask",
  // @deprecated：host 客户端方法已删（v4 forkAssistant 原生 handler 经
  // forkSessionAtMessage 钩子直调 server-operations.forkSession op）。wire case 与
  // fork params/result schema 保留＝op 存活面；fork record 归 v4 原生重写。
  sessionFork: "session/fork",
  sessionCompact: "session/compact",
  sessionGoal: "session/goal",
  sessionClose: "session/close",
  // setModel 仍被 zcodeSessionService 的 desktop 旧链路消费；replayable
  // switchModelConfig 已直接由目标 Environment Registry 解析 Selection。
  sessionSetModel: "session/setModel",
  // replayable facade 的思考深度/模式已收敛 v4 switchModelConfig/
  // switchCollaborationMode；剩余消费 = zcodeSessionService（desktop 旧链路，随
  // 桌面 v4 UI 收口清零）与 setMode 的 auto 值残留（v4 值域刻意排除 auto）。
  sessionSetThoughtLevel: "session/setThoughtLevel",
  sessionSetMode: "session/setMode",
  workspaceReadPresentation: "workspace/readPresentation",
  workspaceHookTrustGrant: "workspace/hooks/trustGrant",
  // 进程级 Account Provider Config 与 workspace 运行目录分离。
  providerUpdateAccountConfig: "provider/updateAccountConfig",
  providerRefreshRegistry: "provider/refreshRegistry",
  workspaceUpdateInteractionPreferences: "workspace/updateInteractionPreferences",
  workspaceUpdateModelIoPreferences: "workspace/updateModelIoPreferences",
  // Off-Peak 工具面门禁是 workspace 级事实（灰度 + 本地/远程），由 host 在 agent 就绪时同步；
  // CLI 对 legacy create/resume 与 v4 冷恢复统一读取。旧 CLI method-not-found → host 降级忽略。
  workspaceUpdateOffPeakToolPolicy: "workspace/updateOffPeakToolPolicy",
  // 动态工作流灰度门禁：同 Off-Peak 的同步模式。
  workspaceUpdateDynamicWorkflowPolicy: "workspace/updateDynamicWorkflowPolicy",
  // LLM 执行面在 CLI，直连不可行；消费仅 services 内部
  // （commit message），待 v4 workspace 查询/命令面覆盖后移除。
  workspaceGenerateText: "workspace/generateText",
  workspaceCancelGenerateText: "workspace/cancelGenerateText",
  providerTestModelConnectivity: "provider/testModelConnectivity",
  mcpList: "mcp/list",
  mcpReadResource: "mcp/readResource",
  mcpUiOpenInstance: "mcp/uiOpenInstance",
  mcpUiCloseInstance: "mcp/uiCloseInstance",
  mcpUiValidateInstance: "mcp/uiValidateInstance",
  mcpUiSampling: "mcp/uiSampling",
  mcpUiCancelSampling: "mcp/uiCancelSampling",
  mcpUiCallTool: "mcp/uiCallTool",
  mcpUiCancelCall: "mcp/uiCancelCall",
  mcpUiReadResource: "mcp/uiReadResource",
  mcpUiListResources: "mcp/uiListResources",
  mcpUiListResourceTemplates: "mcp/uiListResourceTemplates",
  mcpUiSubscribeResource: "mcp/uiSubscribeResource",
  mcpUiUnsubscribeResource: "mcp/uiUnsubscribeResource",
  // App-Provided Tools：页面工具登记 / 注销，与模型调用的认领 / 回传（信箱投递走 v4 live 增量）。
  mcpUiRegisterAppTools: "mcp/uiRegisterAppTools",
  mcpUiUnregisterAppTools: "mcp/uiUnregisterAppTools",
  mcpUiClaimAppToolCall: "mcp/uiClaimAppToolCall",
  mcpUiResolveAppToolCall: "mcp/uiResolveAppToolCall",
  pluginsList: "plugins/list",
  pluginsReferenceCatalog: "plugins/referenceCatalog",
  pluginsListUiSurfaces: "plugins/listUiSurfaces",
  pluginsReferenceCatalogWithCategory: "plugins/referenceCatalogWithCategory",
  skillsReferenceCatalog: "skills/referenceCatalog",
  // 已保存工作流的 GUI 中枢：workspace 级、无会话。
  workflowsList: "workflows/list",
  workflowsGet: "workflows/get",
  workflowsUpdateMeta: "workflows/updateMeta",
  workflowsDelete: "workflows/delete",
  workflowsRuns: "workflows/runs",
  // 在项目档 / 全局档之间移动同名文件。
  workflowsMove: "workflows/move",
  // 完成卡的「直接保存」与「已保存」判定（docs/dynamic-workflow/transcript-and-notifications.md）：
  // 前者按 runId 从 journal 取脚本落盘，后者回答「这次 run 对应哪个已保存工作流」。
  workflowsSave: "workflows/save",
  workflowsForRun: "workflows/forRun",
  pluginsResolveSuggestedReference: "plugins/resolveSuggestedReference",
  pluginsSetEnabled: "plugins/setEnabled",
  pluginsOverview: "plugins/overview",
  pluginsMarketplaceAdd: "plugins/marketplace/add",
  pluginsMarketplaceRemove: "plugins/marketplace/remove",
  pluginsMarketplaceUpdate: "plugins/marketplace/update",
  pluginsInstall: "plugins/install",
  pluginsCancelOperation: "plugins/cancelOperation",
  pluginsUninstall: "plugins/uninstall",
  pluginsUpdate: "plugins/update",
  pluginsRestoreBuiltin: "plugins/restoreBuiltin",
  pluginsConfigure: "plugins/configure",
  pluginsResetConfig: "plugins/resetConfig",
  pluginsValidate: "plugins/validate",
  pluginsDescribe: "plugins/describe",
  automationCreate: "automation/create",
  topicResourceRead: "topic/resource/read",
  channelReply: "bot/channel/reply",
  topicResourceCancel: "topic/resource/cancel",
  automationUpdate: "automation/update",
  automationCheckTaskBinding: "automation/checkTaskBinding",
  automationList: "automation/list",
  automationDelete: "automation/delete",
  // Off-Peak 会话内创建：与 automation 兄弟并列的独立方法族。
  offPeakCreate: "offPeak/create",
  offPeakList: "offPeak/list",
  // @deprecated：host 消费已清零（zcodeAgentService 改走 v4/usage/stats）。
  // 仅剩 CLI server 的 wire 兼容 case；随旧词整体删除时一并移除。
  usageStats: "usage/stats",
  // ZCode Protocol 对 agent 只暴露 session-first 方法；task 是 UI 投影概念，不能泄露进协议方法名。
  // @deprecated：host 已改走 v4/conversation/usage；后续与 usage/stats 一并移除。
  sessionUsage: "session/usage",
  // 资源管理器：CLI 回报其 MCP 子进程 pid 与插件归属（纯内存，无 I/O），采样在 Host 侧完成。
  processChildProcesses: "process/childProcesses",
  processNetworkCapture: "process/networkCapture",
  interactionRequestPermission: "interaction/requestPermission",
  interactionRequestUserInput: "interaction/requestUserInput",
  interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
  interactionRequestOfficialMcpAuthHeaders: "interaction/requestOfficialMcpAuthHeaders",
  // browser-use 反向请求由 agent 发起，host 转给 main 中的 CDP executor。
  interactionBrowserList: "interaction/browserList",
  interactionBrowserExecute: "interaction/browserExecute",
} as const;

export type ZCodeProtocolMethod = (typeof zcodeProtocolMethods)[keyof typeof zcodeProtocolMethods];

// 空结果 schema 单独导出，供“成功但无返回体”的方法复用：每次各写一个 z.object({}) 会
// 出现有人 strict、有人不 strict 的分裂，前者能挡住多传字段，后者不能。
// strict 在这里不是形式主义——它让“调用方以为某个方法会返回东西”这种误解立刻暴露。
export const zcodeProtocolEmptyResultSchema = z.object({}).strict();

// 最新 V4 主链已不再依赖旧版全量方法表；这里仅保留仍被兼容测试和 browser broker
// 消费的最小契约集合，避免重新引入已移除的 legacy 方法。
// 最小契约表（INV-22）：只登记“当前仍有消费方”的方法及其 capability 要求。
// 不允许把已删除的 legacy 方法回填——这张表是能力协商的输入，回填会让旧端误以为
// 服务端仍支持某个方法，于是发出请求并卡在等待上；也不能把它当文档用。
export const zcodeProtocolSessionMethodContracts = {
  [zcodeProtocolMethods.mcpUiOpenInstance]: {
    params: zcodeMcpUiOpenInstanceParamsSchema,
    result: zcodeMcpUiOpenInstanceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCloseInstance]: {
    params: zcodeMcpUiCloseInstanceParamsSchema,
    result: zcodeMcpUiCloseInstanceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiValidateInstance]: {
    params: zcodeMcpUiCloseInstanceParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.workspaceHookTrustGrant]: {
    params: zcodeWorkspaceHookTrustGrantParamsSchema,
    result: zcodeWorkspaceHookTrustGrantResultSchema,
  },
  [zcodeProtocolMethods.mcpList]: {
    params: zcodeMcpListParamsSchema,
    result: zcodeMcpListResultSchema,
  },
  [zcodeProtocolMethods.mcpReadResource]: {
    params: zcodeMcpReadResourceParamsSchema,
    result: zcodeMcpReadResourceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiSampling]: {
    params: zcodeMcpUiSamplingParamsSchema,
    result: zcodeMcpUiSamplingResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCancelSampling]: {
    params: zcodeMcpUiCancelSamplingParamsSchema,
    result: zcodeMcpUiCancelCallResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCallTool]: {
    params: zcodeMcpUiCallToolParamsSchema,
    result: zcodeMcpUiCallToolResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCancelCall]: {
    params: zcodeMcpUiCancelCallParamsSchema,
    result: zcodeMcpUiCancelCallResultSchema,
  },
  [zcodeProtocolMethods.mcpUiReadResource]: {
    params: zcodeMcpUiReadResourceParamsSchema,
    result: zcodeMcpUiReadResourceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiListResources]: {
    params: zcodeMcpUiListResourcesParamsSchema,
    result: zcodeMcpUiListResourcesResultSchema,
  },
  [zcodeProtocolMethods.mcpUiListResourceTemplates]: {
    params: zcodeMcpUiListResourcesParamsSchema,
    result: zcodeMcpUiListResourceTemplatesResultSchema,
  },
  [zcodeProtocolMethods.mcpUiSubscribeResource]: {
    params: zcodeMcpUiResourceSubscriptionParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.mcpUiUnsubscribeResource]: {
    params: zcodeMcpUiResourceSubscriptionParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.mcpUiRegisterAppTools]: {
    params: zcodeMcpUiRegisterAppToolsParamsSchema,
    result: zcodeMcpUiRegisterAppToolsResultSchema,
  },
  [zcodeProtocolMethods.mcpUiUnregisterAppTools]: {
    params: zcodeMcpUiUnregisterAppToolsParamsSchema,
    result: zcodeMcpUiUnregisterAppToolsResultSchema,
  },
  [zcodeProtocolMethods.mcpUiClaimAppToolCall]: {
    params: zcodeMcpUiClaimAppToolCallParamsSchema,
    result: zcodeMcpUiAppToolAcceptedResultSchema,
  },
  [zcodeProtocolMethods.mcpUiResolveAppToolCall]: {
    params: zcodeMcpUiResolveAppToolCallParamsSchema,
    result: zcodeMcpUiAppToolAcceptedResultSchema,
  },
  [zcodeProtocolMethods.interactionBrowserList]: {
    params: zcodeBrowserListParamsSchema,
    result: zcodeBrowserListResultSchema,
  },
  [zcodeProtocolMethods.interactionBrowserExecute]: {
    params: zcodeBrowserExecuteParamsSchema,
    result: zcodeBrowserExecuteResultSchema,
  },
} as const satisfies Partial<
  Record<ZCodeProtocolMethod, { params: z.ZodTypeAny; result: z.ZodTypeAny }>
>;

export type ZCodeProtocolSessionMethodContract =
  (typeof zcodeProtocolSessionMethodContracts)[keyof typeof zcodeProtocolSessionMethodContracts];

// 启动入口的独立存储命令与严格结果 schema，和 CLI 共用一份契约。
export {
  STORAGE_MIGRATION_COMMAND,
  storageMigrationReportSchema,
} from "../sqlite-migrations/contract.js";

/** 仅存储准备子进程的私有控制帧，原始路径不进入业务事件或遥测。 */
// 存储准备帧按 method 判别：path_ready / preparation 两类帧共用同一通道但语义不同，
// 用 discriminatedUnion 而不是“type + 可选字段”，是为了让消费端一个 switch 穷尽处理，
// 漏一种会在编译期暴露，而不是在运行期静默吞掉一帧（那会让存储初始化永远停在半途）。
export const zcodeStoragePreparationFrameSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("startup/storagePath"),
      params: z.object({ path: z.string().min(1).max(32768) }).strict(),
    })
    .strict(),
  z
    .object({ method: z.literal("startup/storagePrepared"), params: z.object({}).strict() })
    .strict(),
  z
    .object({ method: z.literal("startup/storageState"), params: zcodeStorageStartupStateSchema })
    .strict(),
]);
// reuse=true 表示复用已存在的数据库文件（本次启动不新建）；它是“已就绪”帧的一部分，
// 而不是单独事件，因为复用与否只影响紧随其后的状态帧，独立播报只会多一次往返。
// path 的上界与前一个帧保持一致，避免两条路径校验规则出现一个能过、一个不能过的分裂。
export const zcodeStoragePathReadySchema = z
  .object({ method: z.literal("startup/storagePathReady"), reuse: z.boolean().optional() })
  .strict();

// 桌面本地 TTFT 的严格事实合同；检查点不能替代实际内容帧。
export { localTtftFactsSchema } from "../localTtft.js";
// 群来源由可信 Host 注入，V4 命令与持久化输入使用相同运行时校验。
export {
  botIdentitySchema,
  botTopicInputMessageSchema,
  botGroupInputSourceSchema,
  type BotGroupInputSource,
} from "../bots.js";
export {
  botTopicContextSchema,
  botTopicMessageSchema,
  type BotTopicHistoryBatch,
  type BotTopicMessage,
} from "../bots.js";
