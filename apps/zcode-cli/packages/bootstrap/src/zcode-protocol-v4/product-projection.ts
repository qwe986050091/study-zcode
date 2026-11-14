/**
 * ============================================================================
 * zcode-protocol-v4/product-projection.ts —— CLI 权威投影的"第二 reducer"
 * ============================================================================
 *
 * 【定位】输入是 CLI 事件日志（SessionEvent，权威事实源），输出是
 * ConversationDelta[]。宿主只转发帧，UI 只 apply frame；产品状态由本文件决定。
 *
 * 【构造保证】快照推进复用协议规范 apply（applyConversationDeltas）：
 *   投影演进与 delta 流逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
 *
 * 【delta 是封闭集合】
 *   row.appended / row.upserted / row.removed / row.delta / state.updated。
 *   state.updated 对键整体替换（禁止深合并）；row.removed 从指定 rowId 起截断。
 *   任何无法用这五种操作无歧义表达的结构变化，必须触发 snapshot/resync，
 *   不允许在客户端新增修补算法，也不允许在这里偷偷发明第六种 delta。
 *
 * 【覆盖范围】session/turn 生命周期、流式文本/思考、tool call 状态机、
 * 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、compact marker、
 * goal 状态机、fork marker、子代理/后台任务/workflow run 的展示投影。
 * 传输外壳（TopicFrame/subscribe）在 gateway 层，不在本文件。
 *
 * 【不变量】
 *   - live 与 cold 必须收敛到同一产品终态（cold 由 transcript-hydration 合成事件）；
 *   - UI 不得从消息数组/最后一条消息/本地 task runtime 重新推导 rows 或 availability；
 *   - 每条用户输入尽量保留 sourceCommandId，它是去重、ACK 重放与 optimistic overlay
 *     收口的共同锚点。
 *
 * 【维护提示】新增事件分支时先写 normalizeConversationEvent 的 fact 分支，
 * 再在 reduce 里加 case；不要直接读 raw payload 猜身份字段。
 * ============================================================================
 */
/**
 * 【补充：本批注释的主干与边界】
 *
 * 事件入口分两条：applyEvent 走 live（normalize → reduce → materialize actions →
 * attachRevision → apply 到 snapshot 并登记索引）；beginHydrationReplay/
 * applyHydrationEvent/completeHydrationReplay 走 cold（只累积到候选 accumulator，
 * 最后由 publisher 决定是否 adopt）。两条路径共用同一 reduce，因此同一份持久事实
 * 必须收敛到同一产品终态。
 *
 * 五种 delta 是本文件的输出语言：row.appended / row.upserted / row.removed /
 * row.delta / state.updated。state.updated 一律整键替换（禁止深合并）；
 * row.removed 从 fromRowId 起截断；row.delta 只表达 path 上的 append。
 * 表达不了的结构变化（例如需要重排/跨行搬迁）只能触发 snapshot/resync，
 * 不在这里发明第六种 op，也不让客户端补算法。
 *
 * revision 由 attachRevision 统一记账：行结构变化 + A 区（control/availability/
 * queue/goal/plan 等）变化各 +1；usage/pendingCommands/workflowRuns 按
 * projection-state 的豁免表处理，避免高频派生数据让 CAS 假失败。
 * ============================================================================
 */
// ============================================================================
// 不变量清单（INV）：本文件的补充约束，与上方「定位/构造保证」并列
// ============================================================================
//
// 【边界】只把 SessionEvent 归约成 ConversationDelta；不广播、不落盘、不判定权限。
//
// INV-01 live 与 cold 必须共用同一次 reduce；任何在 applyHydrationEvent 里另写规则的
//   分支都会让同一份持久事实产出不同产品终态（reduce 是唯一事实→delta 入口）。
// INV-02 行结构变化必须在同一次 materialization 内同时产出 row 与 row.actions/target；
//   拆开（例如先发 row、后发 actions）会出现「入口可见但 target 不可解析」。
// INV-03 所有索引（rowIndexById/messageIdByRowId/toolRowIdByCallId 等）都是 snapshot
//   的派生表，rewind/resync 必须由 snapshot 重建，禁止用索引反推 snapshot。
// INV-04 revision 只在 deltaBumpsRevision 为真时 +1，且必须内联进最后一条 delta；
//   单独发 state.updated 会与客户端 CAS 的「无 revision 即无变化」假设冲突。
// INV-05 usage/pendingCommands/workflowRuns 等高频派生 patch 默认不带 revision；
//   给它们记账会让 CAS 频繁假失败（见 projection-state 的豁免表）。
// INV-06 hydration 期间 seq 必须推进到 event.sequenceNumber；漏掉会让恢复终态的
//   水位落后，后续事件被 gate 当成过期事件丢弃。
// INV-07 applyEventAtomically 必须在候选实例上归约：直接改权威态后校验失败，
//   snapshot 会永久停在无法编码传输的状态。
// INV-08 cloneProjection 必须逐项深拷贝每一个 Map/Set/嵌套对象；漏一项即让候选与
//   权威态共享可变引用，accept 失败时回滚不干净。
// INV-09 SessionCreated 不得产可见 delta（draft 不伪造一轮对话），只记录容量事实；
//   一旦产出 row，草稿会话会出现幽灵消息。
// INV-10 rewind 的 row.removed 从 turnHeader 较小 rowId 起截断整个目标轮；
//   只从锚点行删会留下半轮 header 与孤立 tool row。
// INV-11 被 rewind 的 hook invocationId 必须进墓碑集合，否则迟到 terminal 会把
//   已删行重新 append 回来。
// INV-12 modelChange marker 只在「本轮实际模型身份变化」时于 turnHeader 之前生成；
//   在 onModelSelected 里生成会让草稿态切模型也挂出 marker。
// INV-13 SessionStart Hook 在 Runtime epoch 未建立真实 turn 前必须 pending；
//   提前 append 会落到 turn-unknown 或拆成独立 footer。
// INV-14 TurnComplete 必须同时关流式行、收口在飞 tool row、清 apiRetry；
//   漏任何一项都会让「重新连接中」或 running 卡片残留到下一轮。
// INV-15 stop（cancelled）必须将 active/verifying goal 置 paused 并保留 queue，
//   同时关闭 autoDrain；直接清空会让用户输入丢失且无法解释原因。
// INV-16 controlOnly 轮不得写 session control（尤其 duration=0 的工时）；
//   旧 UI 会把 0 秒格式化成「已工作 1 秒」。
// INV-17 诊断只追加有限条且不进 delta；把诊断混进产品状态会让终态不可复现。
import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
import type {
  AssistantFeedbackUpdatedPayload,
  HighspeedMetricsUpdatedPayload,
  CompactLifecyclePayload,
  DynamicWorkflowRunProgressPayload,
  HookRunLifecyclePayload,
  ModelCompletePayload,
  ModelNetworkStatusPayload,
  ModelSelectedPayload,
  TurnExecutionModelFallbackPayload,
  ModelStreamingPayload,
  ModelUsage,
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PluginUiAppToolCallRequestedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiResourceUpdatedPayload,
  SessionEvent,
  SessionForkedPayload,
  SessionInputPromotedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamingToolLedgerPayload,
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
  ToolCallErrorPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolResultDisplayPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnInputIntentMetadata,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDrainedPayload,
  TurnSteerQueuedPayload,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
} from "@zcode/contracts";
import {
  DEFERRED_TOOL_CALL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  CoreErrorType,
  SessionEventType,
  getModelUsageContextTokens,
} from "@zcode/contracts";
import {
  clearSettledOutputPreviews,
  projectToolActivity,
} from "./product-projection-bash-progress.js";
// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  isHighspeedProviderId,
  isZCodeFileStreamingToolInputPreviewTool,
  isZCodeModelRetryRecoveryProgressPayload,
  parseZCodeBackgroundTaskNotificationText,
  resolveZCodeBackgroundTaskControlKind,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
} from "@zcode/shared";
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";
import type {
  ApiRetryState,
  AssistantTextRow,
  BackgroundWorkSummary,
  ConversationDelta,
  ConversationRow,
  ConversationRowTarget,
  ConversationSnapshot,
  CuaAppIdentity,
  GoalState,
  HookExecutionProjection,
  HookInvocationRow,
  MutableConversationSnapshotAccumulator,
  PendingInteraction,
  QueueItem,
  ReasoningRow,
  RunningSubagentSummary,
  SessionControl,
  SessionUsageState,
  StatePatch,
  SubagentProjectionState,
  SubagentRow,
  TimelineMarkerPayload,
  TimelineMarkerRow,
  ToolCallDisplay,
  ToolCallRow,
  TurnHeaderRow,
  TurnWorkSegment,
  UserInputQuestionPayload,
  UserInputRow,
  WorkflowRunProgressEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  applyConversationDeltas,
  applyConversationDeltasMutable,
  createMutableConversationSnapshotAccumulator,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  workspaceHookReviewRequestPayloadSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  buildProtocolPermissionOptions,
} from "../permission-options.js";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import {
  parseListAppsSnapshot,
  readOfficialCuaAction,
  resolveCuaAppIdentity,
} from "./cua-app-snapshot.js";
import {
  normalizeConversationEvent,
  type CanonicalAssistantSegmentFact,
  type CanonicalConversationFact,
  type CanonicalModelStream,
  type CanonicalOpenSegmentIdentity,
  type CanonicalUserIntentFact,
  type ConversationNormalizationDiagnostic,
} from "./event-normalizer.js";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationQuestions,
} from "./mcp-elicitation.js";
import {
  buildToolOutput,
  buildTurnHeaderRow,
  mapCompactMarkerOrigin,
  mapCompactMarkerStatus,
  mapGoalStatus,
  mapTurnResultToHeaderState,
} from "./projection-rows.js";
import {
  HYDRATION_TRACE_ID,
  computeAvailability,
  computeInputRouting,
  createInitialConversationSnapshot,
  deltaBumpsRevision,
} from "./projection-state.js";

type HookInvocationRowContent = Omit<
  HookInvocationRow,
  | "actions"
  | "createdAt"
  | "createdAtSeq"
  | "entityId"
  | "productTurnId"
  | "rowId"
  | "turnId"
  | "visibility"
>;

interface PendingSessionHookInvocation {
  firstEvent: SessionEvent;
  content: HookInvocationRowContent;
}

// [契约] 解释器白名单用于把 `python script.py` 展示成「python · script.py」，
// 只在标签层面生效，不影响 Hook 是否执行。
// 缺少解释器时退回可执行文件名，而不是拼出错误的脚本文案。
// 集合内容按小写比较（见 hookCommandLabel 的 toLowerCase）。
const HOOK_SCRIPT_RUNNERS = new Set([
  "bash",
  "bun",
  "deno",
  "node",
  "node.exe",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);
// [契约] 该字符串同时是错误码前缀与 UI 归类键，改值会让 ChatErrorBanner
// 无法识别「输入被 Hook 拒绝」这一类错误。
// 只在 UserPromptSubmit executed block 路径使用，其他 Hook 边界不得复用。
// 作为错误 message 前缀时保留可读原因，但归类只看这个常量。
// 不要把它改成 fault.* 形式：它表示归因类别而非故障码。
const USER_PROMPT_HOOK_BLOCK_ERROR_TYPE = "hooks_prompt_block";

// [契约] 仅用于展示：解析双引号内的 JSON 转义，失败则退化为去引号切片。
// 单引号按字面去壳，不做转义解析（与 shell 习惯一致但更保守）。
// 绝不能把结果用于路径解析或执行，展示函数不保证往返一致。
// 空串与不配对的引号原样返回，避免抛错中断 Hook 行渲染。
function unquoteHookDisplayToken(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return token.slice(1, -1);
    }
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  return token;
}

// [契约] 用正则切出引号段与非空白段，保留含空格的可执行路径，
// 比简单 split(" ") 更能处理 Windows 路径。
// [失败路径] 取不到 executable 时返回 undefined，由调用方回落 Hook #N。
// 解释器 + 脚本名只在白名单命中时拼接；`-` 开头的第二段是参数，不当作脚本。
// 结果只用于 displayName，不参与任何生命周期或权限判断。
// 同一命令重复计算是廉价的（每行一次），不要为此加缓存。
function hookCommandLabel(commandDisplay: string): string | undefined {
  const tokens = commandDisplay.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/gu) ?? [];
  const executableToken = tokens[0];
  if (!executableToken) return undefined;
  const executable = unquoteHookDisplayToken(executableToken).split(/[\\/]/u).at(-1);
  if (!executable) return undefined;
  const scriptToken = tokens[1];
  if (!HOOK_SCRIPT_RUNNERS.has(executable.toLowerCase()) || !scriptToken) return executable;
  const script = unquoteHookDisplayToken(scriptToken);
  if (!script || script.startsWith("-")) return executable;
  const scriptName = script.split(/[\\/]/u).at(-1);
  return scriptName ? `${executable} · ${scriptName}` : executable;
}

// [契约] 展示名优先级：statusMessage > pluginName · executable > pluginName
// 或 executable > Hook #N；该顺序保证插件内 Hook 可辨识来源。
// statusMessage 需 trim 后非空才采用，空串不应遮住可执行名。
// hookIndex 只用于最后兜底，且按 1 基展示。
// 不要在展示名里拼 commandDisplay 原文：可能包含敏感参数。
function hookExecutionDisplayName(
  descriptor: NonNullable<HookRunLifecyclePayload["descriptor"]>,
  hookIndex: number,
): string {
  const executable = hookCommandLabel(descriptor.commandDisplay);
  return (
    descriptor.statusMessage?.trim() ||
    (descriptor.pluginName && executable
      ? `${descriptor.pluginName} · ${executable}`
      : descriptor.pluginName || executable) ||
    `Hook #${hookIndex + 1}`
  );
}

/**
 * config 种子：投影初始化/冷恢复后从 runtime 真值注入的初值。
 * 与事件写入路径（ModelSelected / SessionModeChanged）的关系：种子只填「事件尚未
 * 触碰」的字段——日志重放值永远优先（"最终值以日志为准"）。
 */
// [契约] 种子只填「事件尚未触碰」的 config 字段，日志重放值永远优先；
// seedConfig 用三个 touched 守卫实现该优先级，改这里不会改变优先级。
// modelSelection 用 Object.hasOwn 判断，恢复空选择也具语义（不能因 falsy 跳过）。
// permissionGrant 只在 snapshot 为空时补，已授予的权限不得被种子覆盖。
// 新增字段必须同时决定它归属哪个 touched 守卫，否则会出现跨来源抖动。
export interface SessionConfigSeed {
  permissionGrant?: { interactionId: string };
  planEnabled?: boolean;
  modelSelection?: ModelSelectedPayload["modelSelection"];
  provider?: string;
  model?: string;
  thought?: string;
  thoughtLevels?: readonly string[];
  mode?: string;
}

/** 使用量种子：冷恢复时用持久事实补 context 窗口与累计 token；未知容量用 null 表示「不显示分母」。 */
// [契约] maxTokens 允许 null 表示容量未知；此时 UI 不显示分母，但内部仍保留用量。
// cumulative 是 Partial：只补缺失维度，已有累计值优先。
// 该种子只在冷恢复注入，live 路径不得调用 seedUsage。
export interface SessionUsageSeed {
  contextWindow: Omit<NonNullable<SessionUsageState["contextWindow"]>, "maxTokens"> & {
    maxTokens: number | null;
  };
  cumulative?: Partial<SessionUsageState["cumulative"]>;
}

interface ContextWindowProjectionState {
  maxTokens: number | null;
  touchedByEvent: boolean;
  usedTokens: number;
}

/**
 * 子代理 manifest 种子（cold 恢复用）。childSessionIds 是权威集合：仅 store 能证明
 * 某个 child 已持久化为 subagent_child；rows 里可见但不在集合内的旧 ghost 会被
 * 记入 invalidSubagentChildSessionIds 并持续排除，不能只覆盖一次快照。
 * revision 非空时至少从 1 起：renderer 用 0 表示尚未建立权威态。
 */
// [契约] revision 非空时至少从 1：renderer 用 0 表示「尚未建立权威态」，
// 若种子传 0，child tab 会认为永远无法同步而跳过更新。
// childSessionIds 去重后成为 allowed 集合，不在集合内的历史 ghost 被持续排除。
// running 必须按 allowed 过滤，避免已不存在的 child 出现在运行列表。
export interface SessionSubagentsSeed {
  revision: number;
  childSessionIds: string[];
  running: RunningSubagentSummary[];
}

/**
 * running fork 的稳定候选：产品轮身份 + transcript 轮身份 + 起始/边界 messageId。
 * startMessageId 用于恢复父轮起点，boundaryMessageId 是 fork 的精确切点；
 * orderedMessageIds 由 host 再用 session store 权威顺序补齐，投影不越权。
 */
// [契约] productTurnId 与 transcriptTurnId 不能混用：前者用于 rows 分组，
// 后者用于 core 持久化寻址。
// startMessageId 可为 null（找不到 user 行），boundaryMessageId 必须存在，
// 否则 resolution 会是 forkTargetAmbiguous。
// orderedMessageIds 由 host 补齐，投影不得越权读取 session store。
export interface StableForkCandidate {
  productTurnId: string;
  transcriptTurnId: string;
  startMessageId: string | null;
  boundaryMessageId: string;
}

// [契约] 浅拷贝 options，避免种子对象与 snapshot 共享引用后被外部修改。
// options 缺省时不写 undefined 键，保持稀疏形状，便于 sameSparseModelSelection 比较。
// 只复制已知字段，不展开未知键：未知键属于日志事件，不应通过种子进入投影。
function cloneSparseModelSelection(
  selection: ModelSelectedPayload["modelSelection"],
): ModelSelectedPayload["modelSelection"] {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

// [契约] 只比较 providerId/modelId/reasoningLevel 三项；其他 options 视为展示细节，
// 不参与「是否变化」判定，避免等价配置反复触发 upsert。
// [权衡] 两侧都缺省视为相等（left === right），空选择是明确语义。
// 只比较一侧缺失时返回 false：有→无也是一次真实变化，必须写回。
// 该函数决定 seedConfig 是否标记 changed，进而决定是否替换 snapshot，
// 放宽比较会让种子反复覆盖同一个对象。
function sameSparseModelSelection(
  left: ModelSelectedPayload["modelSelection"] | undefined,
  right: ModelSelectedPayload["modelSelection"] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

/**
 * fork 候选解析结果。失败分支的 reasonCode 与 availability 的 guard id 同源：
 * forkAssistantOnly（不是 assistant 行）、forkTargetNotStable（轮次未成功收口/
 * 不是最后一段）、forkTargetAmbiguous（缺 messageId）、compactOperationLock
 * （compact 正在占用结构）。命令层据此回 ACK 拒绝，UI 不得自行放宽。
 */
// [契约] 失败 reasonCode 与 availability guard id 同源，命令层直接回 ACK，
// UI 不得自行放宽或改写这些码。
// 四个码分别表示：非 assistant 行、轮次未稳定收口、缺 messageId、compact 占用。
// 顺序有意义：compactOperationLock 最先返回，因为结构锁优先于行级判定。
export type StableForkCandidateResolution =
  | { ok: true; candidate: StableForkCandidate }
  | {
      ok: false;
      reasonCode:
        | "guard.forkAssistantOnly"
        | "guard.forkTargetNotStable"
        | "guard.forkTargetAmbiguous"
        | "guard.compactOperationLock";
    };

/**
 * 可编辑用户轮的 canonical target。
 *
 * entityId 是跨 materialization 的稳定身份；productTurnId/transcriptMessageId 把
 * 产品展示与持久 message 对齐；intent 保存重跑所需的完整命令意图（文本、附件、
 * 投递方式、模型/模式、provenance 等），保证 edit/retry 不依赖当前 UI 状态。
 * coveredByStableCompact 标记该目标已被稳定 compact 覆盖，edit 需要额外裁决。
 */
// [契约] entityId 是跨 materialization 的稳定身份，rowId 只是本次物化的临时地址。
// intent 必须保存重跑所需的完整意图（文本、附件、投递方式、模型/模式、provenance），
// 否则 edit/retry 会退化为依赖当前 UI 状态，刷新后无法复现。
// coveredByStableCompact 标记目标已被稳定 compact 覆盖，edit 需要额外裁决。
// 新增 intent 字段必须同步 normalize 与 resolver，缺一会出现「能编辑但重跑丢参数」。
export interface ConversationEditTarget {
  entityId: string;
  productTurnId: string;
  transcriptMessageId: string;
  coveredByStableCompact: boolean;
  intent: {
    inputOrigin?: "desktop" | "mobile";
    conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
    botGroupSource?: CanonicalUserIntentFact["botGroupSource"];
    kind: "sendText" | "sendGoalCommand";
    text: string;
    sourceCommandId?: string;
    clientId?: string;
    attachments?: CanonicalUserIntentFact["attachments"];
    queueItemId?: string;
    admissionSeq?: number;
    admittedAt?: number;
    requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
    admittedDelivery?: "startNow" | "queue" | "guide";
    fallbackReasonCode?: string;
    modelSelection?: TurnInputIntentMetadata["modelSelection"];
    mode?: TurnInputIntentMetadata["mode"];
    planEnabled?: boolean;
    provenance?: CanonicalUserIntentFact["provenance"];
  };
}

/**
 * V3 行动作的封闭集合：fork / 编辑用户输入 / 重试轮次 / 文件回滚及其预览 /
 * 文件变更查询 / assistant 反馈 / highspeed 指标。新增动作必须同时扩展
 * row.actions 的 schema 与命令层 resolver，不能由 UI 自造入口。
 */
// [契约] 动作是封闭集合，新增必须同时扩展 row.actions schema 与命令层 resolver；
// UI 不得自造入口，否则会出现「按钮可点但服务端拒绝」。
// 列出顺序不影响行为，行为由 resolveRowActionTarget 的分支顺序决定。
// 动作与行类型的对应关系写死在 resolver，不要在此处编码。
export type ConversationRowTargetAction =
  | "forkAssistant"
  | "editUserQuery"
  | "retryTurn"
  | "applyFileRewind"
  | "fileChanges"
  | "fileRewindPreview"
  | "setAssistantFeedback"
  | "setHighspeedMetrics";

/**
 * 行动作解析结果。staleTarget 表示 rowId 已被 rewind/替换或 entityId 不再匹配；
 * guard.actionUnavailable 表示当前 projection 的 row.actions 不允许该动作。
 * 两种失败都必须由命令层转成结构化拒绝，禁止 fallback 到按位置/文本猜测。
 */
// [契约] stale 与 rejected 必须区分：前者目标已被 rewind/替换，后者当前门禁不允许。
// 两种失败都禁止 fallback 到按位置或文本猜测，否则会操作到错误的历史行。
// 成功分支携带 messageId/messageIds，UI 不暴露这些内部锚点。
export type ConversationRowTargetResolution =
  | {
      ok: true;
      action: ConversationRowTargetAction;
      row: ConversationRow;
      editTarget?: ConversationEditTarget;
      messageId?: string;
      messageIds?: string[];
    }
  | {
      ok: false;
      status: "stale" | "rejected";
      reasonCode: "proto.staleTarget" | "guard.actionUnavailable";
    };

// 旧事件没有 retryable 字段；保持历史 UI 的可重试语义，但新事件必须尊重显式 false。
const LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK = true;

// [契约] 把 provider 重试原因归一到稳定的 fault.* 码，UI 按码选择文案与可恢复性。
// offpeak_queued 归入 rateLimited：语义都是「上游让我们等」，属于可恢复。
// auth_refresh/reasoning_signature_repair 归入 requestFailed，避免暴露内部修复机制。
// switch 必须穷举联合类型；新增 reason 时漏 case 会编译失败，这是刻意的。
// 这些码只用于展示与分类，不参与重试决策。
function modelRetryReasonCode(
  reason: Extract<ModelNetworkStatusPayload, { type: "model_retry_scheduled" }>["reason"],
): string {
  switch (reason) {
    case "rate_limited":
      return "fault.provider.rateLimited";
    // off-peak 排队（429/3105）语义上就是"上游让我们等"，UI 归入限流可恢复形态。
    case "offpeak_queued":
      return "fault.provider.rateLimited";
    case "provider_overloaded":
    case "server_error":
      return "fault.provider.serverError";
    case "timeout":
      return "fault.network.timeout";
    case "stream_idle_timeout":
      return "fault.network.sseStalled";
    case "stale_connection":
      return "fault.network.sseDisconnected";
    case "network_error":
      return "fault.network.unreachable";
    case "auth_refresh":
    case "reasoning_signature_repair":
      return "fault.provider.requestFailed";
  }
}

// [契约] 流恢复失败同样归一到 fault.*，与 modelRetryReasonCode 共用展示语义。
// provider_stream_error 映射为 sseDisconnected，而不是 serverError，便于区分断流。
// unknown 与 provider_turn_failed 合并为 requestFailed，避免暴露无法解释的细节。
// 两套映射表不要合并：输入联合不同，合并会引入不可能的分支。
function streamRecoveryReasonCode(
  failureKind: StreamRecoveryStartedPayload["failureKind"],
): string {
  switch (failureKind) {
    case "provider_timeout":
      return "fault.network.timeout";
    case "provider_network_error":
      return "fault.network.unreachable";
    case "provider_stream_error":
      return "fault.network.sseDisconnected";
    case "provider_turn_failed":
    case "unknown":
      return "fault.provider.requestFailed";
  }
}

// [契约] 非有限值或 <=0 一律回落，保证下游计数（hookCount 等）不会出现 NaN/负数。
// 向下取整而非四舍五入：协议字段是计数，小数属于异常输入。
// 不回落到 1：fallback 由调用方决定，0 是合法兜底。
function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

interface FileToolInputPreviewState {
  lastPublishedAt: number | null;
  pendingAppend: string;
}

interface HighspeedToolInterval {
  startedAt: number;
  endedAt?: number;
}

type TurnModelBaseline =
  | { kind: "silentInitial" }
  | { kind: "sourceLess" }
  | { kind: "known"; provider: string; model: string; thought: string };

/**
 * 会话产品投影的可变状态机。
 *
 * 两个入口必须区分：
 *   - applyEvent：live 增量，直接从事件推进 snapshot；
 *   - applyHydrationEvent：cold 重放，只写 hydrationAccumulator，最后
 *     completeHydrationReplay 一次性产出 delta 并替换 snapshot。
 *
 * 内部大量索引（rowIdByMessageId / toolRowIdByCallId / subagentRowIdByAgentId 等）
 * 都是 snapshot 的派生索引，不是第二份事实源：rewind/resync 时必须由
 * snapshot 重建，不能反向用索引修补 snapshot。
 */
// [契约] 单会话单实例，所有可变状态都是字段；不要做成跨会话共享的单例。
// 两个入口（applyEvent / applyHydrationEvent）语义不同，见各方法注释。
// 字段分为事实、派生索引与游标三类；新增字段时必须能说明它属于哪一类，
// 以及 resync 后如何重建。
// 该类不做 IO、不加锁；并发安全由调用方（publisher）串行化保证。
export class ProductProjection {
  private snapshot: ConversationSnapshot;
  // reducer 内部的 rowId 查找必须与 rows.window 同步；冷恢复过去每次 find 都扫描全表，
  // tool/turn 终态越多退化越明显。普通归约增量维护，rewind 才重建。
  // [契约] rowId → rows.window 下标，必须与 window 同步；普通归约增量维护，
  // rewind 后整体重建，否则 findRow 会返回错行。
  // 该表是纯派生索引，不是事实源：任何不一致都应重建，不能反向修补 window。
  // 冷恢复时直接接管 accumulator 的同一张表，避免重复构建。
  // 新增删除行的路径必须同时维护它，否则会出现幽灵下标。
  private rowIndexById = new Map<number, number>();
  private hydrationAccumulator: MutableConversationSnapshotAccumulator | null = null;
  private nextRowId = 1;
  // [契约] 当前正在流的 assistant 正文行；新 turn / 真实边界必须置 null，
  // 否则下一轮 delta 会追加到上一轮的 row。
  // reasoning 行独立记录：正文与思考可以交错到达，不能共用一个游标。
  // 这两个游标是优化与定位用的派生状态，resync 后可重建。
  private streamingTextRowId: number | null = null;
  private streamingReasoningRowId: number | null = null;
  // output-token Continue 是同一 product turn 内的请求级恢复，不应泄漏成新的正文行。
  // 这里只保留上一条满足 length/zero-tool/视觉紧邻条件的 text row，任何真实边界都会清空。
  // [契约] output-token Continue 是同一 product turn 内的请求级恢复，
  // 必须复用上一条 text row，不能泄漏成新的正文行。
  // 只有满足 length/zero-tool/视觉紧邻的条件才保留；任何真实边界都要清空。
  // 清空点包括新 turn、tool call、compact、turn 终态；漏一个就会把续写拼到旧段。
  // 它同时决定 outputContinuationRowIdByMessageId 的别名登记。
  private outputContinuationTextRowId: number | null = null;
  // [契约] toolCallId → tool rowId，用于 started/progress/result/error 的状态机推进。
  // 同 callId 重复 started 不能新建行，必须 upsert（重放与冷热交叠都会发生）。
  // rewind 删除行后必须清理对应键，否则迟到事件会写进已删除的 row。
  // 该表在 cloneProjection 中必须复制，漏掉会让候选写入丢失工具状态。
  private toolRowIdByCallId = new Map<string, number>();
  // [契约] list_apps 的最近快照，用于把后续 action 的 app 序号解析成稳定身份。
  // 必须随原子候选一起复制；漏复制会让成功的 list_apps 在提交时丢失。
  // 只保留最近一次快照，不做历史累积，避免无限增长。
  private latestListAppsSnapshot = new Map<number, CuaAppIdentity>();
  // snapshot 是权威状态；该 Set 只是 TurnComplete 缺终态兜底的派生索引，避免每轮扫描全表。
  // [契约] 在飞的前台 tool call 集合，仅用于 TurnComplete 缺终态时的兜底收口。
  // snapshot 才是权威状态；该 Set 只是避免每轮扫描全表的派生索引。
  // tool result/error 与 turn 收口都必须移除，否则会被重复 upsert。
  // 后台/子代理 tool 不进该集合：它们的生命周期由各自事件收口。
  private openForegroundToolCallIds = new Set<string>();
  private fileToolInputPreviewByCallId = new Map<string, FileToolInputPreviewState>();
  private subagentRowIdByAgentId = new Map<string, number>();
  private hookRowIdByInvocationId = new Map<string, number>();
  // resume SessionStart 没有 turnId；先保留在 CLI projection，下一条真实 user-intent
  // TurnStarted 到达后再分配 rowId/turnId。不得构造 session-hooks:* synthetic turn。
  // [契约] resume SessionStart 没有 turnId，必须暂存到 pending，等下一条真实
  // user-intent TurnStarted 再分配 rowId/turnId。
  // 不得构造 session-hooks:* 合成 turn：那会伪造一轮对话并破坏 fork 锚点。
  // Runtime epoch 切换（SessionResumed）必须清空：旧 pending 不能挂到新 Runtime。
  // clone 时必须深拷贝 content.executions，否则候选修改会污染权威态。
  private pendingSessionHookInvocations = new Map<string, PendingSessionHookInvocation>();
  // rewind 后 async Hook 的 terminal 仍可能迟到；保留 invocation 墓碑，避免被删旧分支
  // 因找不到原 row 而被 terminal-only 兼容路径重新 append。
  // [契约] rewind 后 async Hook 的终态仍可能迟到；墓碑保证不会因找不到原行
  // 而被 terminal-only 兼容路径重新 append。
  // 只增不减：invocationId 是一次性的，复活它没有语义。
  // 该集合必须随 clone 复制，否则原子提交会丢掉墓碑。
  // 与 pendingSessionHookInvocations 的清理是两件事：前者清队列，后者留墓碑。
  private rewoundHookInvocationIds = new Set<string>();
  // 冷恢复 transcript 可能含旧版本先发布、后持久化失败的 ghost child。store seed 后
  // 必须持续排除，而不是只覆盖一次 snapshot；否则下一条无关事件会从历史 row 再物化它。
  // [契约] 冷恢复 transcript 可能含旧版先发布、后持久化失败的 ghost child。
  // store seed 后必须持续排除，而不是只覆盖一次快照；否则下一条无关事件会从
  // 历史 row 再次物化它。
  // 合法 resume（SubagentSpawned）会把 id 从集合中移除，恢复资格。
  private invalidSubagentChildSessionIds = new Set<string>();
  // rowId → 权威 messageId 侧表。forkAssistant/editUserQuery 的命令载荷用 rowId
  // 定位，但旧 fork/rewind operations 用 messageId（history target）——桥接层经本表翻译。
  // 不进 row schema（客户端只发 rowId，messageId 是服务端内部锚点，避免污染冻结的行结构）。
  // [契约] rowId → 权威 messageId 的桥接表：命令载荷用 rowId 定位，core 用 messageId。
  // 不进 row schema：客户端只发 rowId，messageId 是服务端内部锚点，
  // 写进行结构会污染冻结协议。
  // 未知 rowId 返回 null，桥接层据此回 rejected，不得按位置猜测。
  // rewind 清理 rowId >= fromRowId 的键，避免悬挂映射。
  private messageIdByRowId = new Map<number, string>();
  // Continue 复用 rowId 后，动作锚点推进到最后一条 assistant message；旧 partial messageId
  // 仍需能命中同一 row，供 compact coverage、rewind 和整轮文件事实恢复使用。
  // [契约] Continue 复用 rowId 后，旧 partial messageId 仍需命中同一 row，
  // 供 compact coverage、rewind 与整轮文件事实恢复使用。
  // 该表是别名表，不是第二份 rowId 索引；主索引仍是 messageIdByRowId。
  // rewind 时按 rowId 一同清理，避免别名指向已删行。
  private outputContinuationRowIdByMessageId = new Map<string, number>();
  private entityIdByRowId = new Map<number, string>();
  // canonical command target 只按稳定实体身份寻址；rowId 仅是本次 materialization 的
  // transient lookup，刷新/replay 后变化也不会改变 target identity。
  // [契约] canonical command target 只按稳定 entityId 寻址；rowId 仅是本次物化的
  // 临时查找键，刷新/replay 后变化不影响 target 身份。
  // 历史记录可以保留，但 resolver 必须先过 currentEditableEntityId 门禁，
  // 否则 entityId 直查能绕过 latest-only 语义。
  // resolver 返回浅拷贝，防止桥接层直接改投影内部 intent。
  private editTargetByEntityId = new Map<string, ConversationEditTarget>();
  private currentEditableEntityId: string | null = null;
  private stableCompactCoverageBoundaryRowId: number | null = null;
  private turnHeaderRowIdByTurnId = new Map<string, number>();
  private compactMarkerRowIdByOperationId = new Map<string, number>();
  // goal verify boundary 身份 = targetId_goalIteration
  // （verificationId 仅 attempt alias——同 iteration 重试携带新 verificationId，
  // 旧实现按 verificationId keying 会长出第二个 marker）。
  // [契约] key 必须是 targetId_goalIteration，而不是 verificationId：
  // 同 iteration 重试会携带新 verificationId，按它 keying 会长出第二个 marker。
  // marker 的 rowId 一旦登记，重试只能 upsert 原行。
  // iteration 推进时才允许新 key，这是 marker 去重的唯一依据。
  private goalVerifyMarkerRowIdByLifecycleKey = new Map<string, number>();
  // queue drain 在同一 runtimeTurn 内切出新的
  // product turn。runtimeTurnId → 当前 productTurnId 映射；后续事件行经 turnIdOf
  // 归入最新 productTurn。steer（guide）不切轮，内联当前轮。
  // [契约] queue drain 会在同一 runtimeTurn 内切出新的 product turn，
  // 该映射决定后续事件归入哪个产品轮。
  // 1:1 时不必存映射（turnId 相同）；只有切轮后才写入，减少无意义条目。
  // 新 TurnStarted 必须先 delete 再按需 set，避免上一轮的切分残留。
  // 反向映射 runtimeTurnIdByProductTurnId 用于命令层回查，两者必须同时维护。
  private productTurnIdByRuntimeTurnId = new Map<string, string>();
  private runtimeTurnIdByProductTurnId = new Map<string, string>();
  private productTurnSplitOrdinalByRuntimeTurnId = new Map<string, number>();
  private currentProductTurnStartedAtMs: number | null = null;
  // Highspeed 分享需要的真实耗时由 CLI 事件聚合，避免 renderer 离场后丢失拆分数据。
  private highspeedModelDurationByTurnId = new Map<string, number>();
  private highspeedToolIntervalsByTurnId = new Map<string, Map<string, HighspeedToolInterval>>();
  // 投递语义侧表：TurnSteerQueued 时按事件 payload（或 followupMode 兜底）记录，
  // drain 时决定切轮 vs 内联；账本落地后以账本为准。
  // [契约] TurnSteerQueued 时按 payload（或 followupMode 兜底）记录投递语义，
  // drain 时决定切轮还是内联当前轮。
  // 账本落地后以账本为准，该侧表只是未落地输入的临时记忆。
  // drain/discard 后必须删除对应键，否则重放会按旧语义切错轮。
  private deliveryByPendingInputId = new Map<string, "guide" | "queue">();
  private currentTurnId: string | null = null;
  // 当前 runtime turn 是否由 model-only TurnStarted 建立（manual /compact、
  // goal continuation 等维护 turn）。SessionStart 摘要的 pending 归位不得以维护
  // turn 为收口目标，必须等下一条 user-visible 真实 turn。
  // [契约] 标记当前 runtime turn 是否由 model-only TurnStarted 建立（manual /compact、
  // goal continuation 等维护轮）。
  // SessionStart 摘要的 pending 归位不得以维护轮为收口目标；
  // 它必须等下一条 user-visible 真实 turn。
  // TurnComplete 后必须复位，避免影响下一次归属判断。
  private currentTurnStartedModelOnly = false;
  // contextWindow=null 时协议不暴露分母与已用量，但 reducer 仍需保留最新 context 用量，
  // 以便 registry 后续恢复已知容量时原子重建 usage，而不是错误归零。
  // [契约] 即使 contextWindow=null（UI 不显示分母），也必须保留最新 usedTokens 事实。
  // 这样 registry 后续恢复已知容量时可以原子重建 usage，而不是把用量归零。
  // touchedByEvent 是「日志权威容量」的守卫：种子只能补用量，不能覆盖 maxTokens。
  // rewind/resync 不重置它：容量事实与行结构无关。
  // usedTokens 在 ModelComplete/Compact 时写入，迟到的恢复种子必须被拒绝。
  private contextWindowState: ContextWindowProjectionState = {
    maxTokens: null,
    touchedByEvent: false,
    usedTokens: 0,
  };
  // modelChange marker 在「下一个 turn 开始时」生成。
  // silentInitial 保持普通 Main 首轮静默；sourceLess 表示显式 ∅→X；known 保存上一轮
  // 实际使用的 provider/model。thought 只随基线记录，不触发模型身份变化。
  // [契约] 三态基线：silentInitial（普通首轮静默）、sourceLess（显式 ∅→X）、
  // known（上一轮实际 provider/model）。
  // thought 只随基线记录，不触发模型身份变化；思考深度变化不是 modelChange。
  // marker 只在下一轮开始时按身份差异生成，不能在 onModelSelected 里生成。
  // resync 后可从历史行重建；不要把它当成持久事实写盘。
  private lastTurnModel: TurnModelBaseline = { kind: "silentInitial" };
  // 种子守卫：事件（权威日志）触碰过的 config 区块不再接受种子覆盖。
  private configModelTouchedByEvent = false;
  // 旧 ModelSelected 不含能力集合；独立守卫允许 runtime seed 补齐旧日志，
  // 又避免后续种子覆盖新事件已原子发布的模型能力。
  private configThoughtLevelsTouchedByEvent = false;
  private configModeTouchedByEvent = false;
  // assistant 守恒：非运行期拒收的正文流计数（gateway 据此置 stale）。
  // [契约] assistant 守恒诊断：非运行期被拒收的正文流事件累计数。
  // >0 表示投影可能缺段，host 应触发重新 hydration，而不是让 UI 自行补齐。
  // 只增不减，直到新的 hydration 重建实例；不要在每个 turn 开始时归零。
  // 该计数不产 delta、不进 snapshot，仅通过 getter 暴露给 publisher。
  private droppedContentStreamEventCount = 0;
  // 读取期 legacy fallback 必须可观测；否则 normalizer 缺字段后仍会退化为“可见但不可寻址”。
  // [契约] 归一化诊断必须有界（只保留近期有限条），否则长会话会无界增长。
  // 诊断不改变产品终态，也不进 delta；它只用于 host 判定是否需要 rehydrate。
  // append 顺序即发生顺序，不要排序去重：重复诊断本身是信号。
  // getter 返回只读视图，调用方不得就地修改数组。
  private normalizationDiagnostics: ConversationNormalizationDiagnostic[] = [];

  // [契约] 只建立初始空快照；不读盘、不订阅、不产生任何 delta。
  // logEpoch 进入 snapshot 后不可变，用于识别跨 epoch 的过期 base。
  // 构造后必须先 seed（config/usage/subagents）再 apply 事件，顺序影响优先级。
  // 不要在构造函数里做 hydration：冷恢复必须显式走 begin/apply/complete。
  constructor(sessionId: string, logEpoch: string) {
    this.snapshot = createInitialConversationSnapshot(sessionId, logEpoch);
  }

  /**
   * 返回当前已提交快照的直接引用（不 clone，保证高频读取 O(1)）。
   * 调用方只允许读：写入必须经 applyEvent/applyEventAtomically，否则 revision/seq
   * 与 delta 流会失配。冷恢复与 live 都读这一个出口，UI 不得另从消息数组推导 rows。
   */
  // [契约] 返回直接引用，不 clone：高频读取必须 O(1)。
  // 调用方只允许读；写入必须经 applyEvent/applyEventAtomically，
  // 否则 revision/seq 与 delta 流失配。
  // 冷恢复与 live 都读这一个出口；UI 不得另从消息数组推导 rows。
  // 需要隔离的调用方自行浅拷贝，不要在 getter 里统一 clone。
  getSnapshot(): ConversationSnapshot {
    return this.snapshot;
  }

  /**
   * 更新 runtimeInitialization（loading/awaitingLogin/ready/failed 等生命周期）。
   *
   * 这是 A 区字段，必须与 run phase 分开：初始化失败不应把会话判成 turn 失败。
   * seq/revision 至少推进到 minimum，防止仍有旧 baseRevision 的客户端绕过门禁；
   * 直接整对象替换，不深合并。不产 delta、不广播。
   */
  /** 生命周期状态独立于 run phase；更新必须推进水位，避免旧 base 漏掉门禁。 */
  // [事务] runtimeInitialization 是 A 区字段，与 run phase 分离：初始化失败
  // 不等于 turn 失败，不要顺手改 phase。
  // seq/revision 至少推进到 minimum，防止仍有旧 baseRevision 的客户端绕过门禁。
  // 整对象替换、不深合并，也不产 delta、不广播。
  // minimum 默认取当前 +1，保证即使状态未变也推进水位。
  setRuntimeInitialization(
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
    minimumSeq = this.snapshot.seq + 1,
    minimumRevision = this.snapshot.revision + 1,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      runtimeInitialization: state,
      seq: Math.max(this.snapshot.seq, minimumSeq),
      revision: Math.max(this.snapshot.revision, minimumRevision),
    };
  }

  /**
   * assistant 守恒诊断：被 normalize 拒收的正文流事件累计数。
   * >0 表示投影可能缺段，host 应触发重新 hydration，而不是让 UI 自行补齐。
   */
  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段，需重 hydration）。 */
  // [契约] 只读计数，供 host 判断是否需要重新 hydration；不参与 UI 渲染。
  // 不要在这里复位计数：读数与清零分离，避免调用方顺序依赖。
  getDroppedContentStreamEventCount(): number {
    return this.droppedContentStreamEventCount;
  }

  /**
   * 归一化诊断（丢事件原因、未知 payload 等）的只读视图。
   * 只保留近期有限条，避免长会话无界增长；诊断不改变产品终态，也不进 delta。
   */
  // [契约] 返回内部数组的只读视图而非拷贝：诊断读取频率低，拷贝反而增加分配。
  // 类型上 readonly 是唯一约束，调用方不得强转后修改。
  getNormalizationDiagnostics(): readonly ConversationNormalizationDiagnostic[] {
    return this.normalizationDiagnostics;
  }

  /**
   * 有界增量估算：若该 ModelStreaming 事件确定只是向既有 streaming 行追加文本/推理/
   * 工具输入，返回可追加的字符串；否则返回 null，强制走候选快照精确校验。
   *
   * 返回 "" 是特殊语义：仍在窗口内（文件输入预览节流），本轮不广播但事件已被接受。
   * 仅对 running 会话成立；窗口累计 suffix 必须计入上界，否则低估下一份 wire snapshot。
   * 这是 publisher 的优化路径，不改变 reduce 的产品语义。
   */
  /** 仅供 publisher 的有界增量估算；返回 null 表示必须走候选快照精确校验。 */
  // [契约] 这是 publisher 的有界增量估算优化，不改变 reduce 的产品语义；
  // 返回 null 表示必须走候选快照精确校验。
  // 返回空串是特殊语义：仍在文件输入预览节流窗口内，本轮不广播但事件已被接受。
  // 仅对 running 会话成立：非运行期追加会被 gate 拒绝，不能估算。
  // 上界必须包含 pendingAppend 累计 suffix，否则会低估下一份 wire snapshot。
  establishedStreamingAppend(event: SessionEvent): string | null {
    if (event.type !== SessionEventType.ModelStreaming || !this.isRunning()) return null;
    const payload = event.payload as ModelStreamingPayload;
    if (payload.kind === "text_delta" && this.streamingTextRowId !== null) return payload.delta;
    if (payload.kind === "reasoning_delta" && this.streamingReasoningRowId !== null) {
      return payload.delta;
    }
    if (
      payload.kind === "tool_input_delta" &&
      this.toolRowIdByCallId.has(String(payload.toolCallId))
    ) {
      const state = this.fileToolInputPreviewByCallId.get(String(payload.toolCallId));
      if (state) {
        if (
          state.lastPublishedAt !== null &&
          this.ms(event) - state.lastPublishedAt <
            ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
        ) {
          return "";
        }
        // 上界估算必须包含窗口内累计 suffix；只算当前 delta 会低估下一份 wire snapshot。
        return `${state.pendingAppend}${payload.delta}`;
      }
      return payload.delta;
    }
    return null;
  }

  /**
   * config 种子注入。
   *
   * 初始快照 config 曾写死空 provider/model +
   * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
   * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
   * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
   * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
   * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
   *
   * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
   * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
   * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
   */
  // [事务] 种子直改 snapshot.config，不产 delta、不递增 revision/seq：
  // draft 的「无可见 delta」裁决必须保持。
  // 三个 touched 守卫保证日志（事件）优先；种子只填未被事件触碰的区块。
  // 幂等：可在 ensurePublisher / hydration 后重复调用，changed 为假时不替换对象。
  // modelSelection 用 Object.hasOwn：恢复空选择也是明确语义，不能因 falsy 跳过。
  // 为什么需要它：ModelSelected 只在切模型时补发，SessionCreated 刻意不产 delta，
  // runtime 真值否则永远进不了投影。
  seedConfig(seed: SessionConfigSeed): void {
    const config = { ...this.snapshot.config };
    let changed = false;
    if (!config.permissionGrant && seed.permissionGrant) {
      config.permissionGrant = seed.permissionGrant;
      changed = true;
    }
    if (!this.configModelTouchedByEvent) {
      if (
        Object.hasOwn(seed, "modelSelection") &&
        !sameSparseModelSelection(config.modelSelection, seed.modelSelection)
      ) {
        // 恢复的空选择也有明确语义，不能因为 falsy 而保留历史事件里的旧选型。
        config.modelSelection = seed.modelSelection
          ? cloneSparseModelSelection(seed.modelSelection)
          : undefined;
        changed = true;
      }
      if (seed.provider !== undefined && config.provider !== seed.provider) {
        config.provider = seed.provider;
        changed = true;
      }
      if (seed.model !== undefined && config.model !== seed.model) {
        config.model = seed.model;
        changed = true;
      }
      if (seed.thought !== undefined && config.thought !== seed.thought) {
        config.thought = seed.thought;
        changed = true;
      }
    }
    const seedThoughtLevels = seed.thoughtLevels;
    if (
      !this.configThoughtLevelsTouchedByEvent &&
      seedThoughtLevels !== undefined &&
      (config.thoughtLevels.length !== seedThoughtLevels.length ||
        config.thoughtLevels.some((value, index) => value !== seedThoughtLevels[index]))
    ) {
      config.thoughtLevels = [...seedThoughtLevels];
      changed = true;
    }
    if (!this.configModeTouchedByEvent && seed.mode && config.mode !== seed.mode) {
      config.mode = seed.mode;
      changed = true;
    }
    if (
      !this.configModeTouchedByEvent &&
      seed.planEnabled !== undefined &&
      config.planEnabled !== seed.planEnabled
    ) {
      config.planEnabled = seed.planEnabled;
      changed = true;
    }
    if (changed) {
      this.snapshot = { ...this.snapshot, config };
    }
  }

  /**
   * 导入分享上下文的来源只读种子。
   *
   * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
   * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
   * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
   */
  /**
   * 注入 sharedContextImport 展示元数据（标题等），仅在事件尚未建立该区块时生效。
   * 保留 source 原样，避免冷恢复把不同来源合并成一种；不产 delta、不记 revision。
   */
  // [契约] shared_context 是 provider-only message，不应物化为用户气泡；
  // 来源标记通过 snapshot additive 字段下发，供 Desktop 显示持久提示。
  // 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
  // 标题为空直接返回：空提示没有展示价值，也不应占用字段。
  // source 原样保留，冷恢复不得把不同来源合并成一种。
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    const title = source?.title.trim();
    if (!title) return;
    if (
      this.snapshot.sharedContextImport?.title === title &&
      (source as { contextId?: string }).contextId ===
        (this.snapshot.sharedContextImport as { contextId?: string }).contextId &&
      (source as { status?: string }).status ===
        (this.snapshot.sharedContextImport as { status?: string }).status
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      sharedContextImport: {
        ...source,
        title,
      },
    };
  }

  /**
   * 注入持久化 usage 种子（上下文窗口水位 + 累计 token）。
   *
   * 守卫顺序即优先级：已有真实 usedTokens（来自 ModelComplete/Compact）时拒绝迟到种子；
   * 事件已触碰过 maxTokens 时只允许补更准确的 usedTokens，绝不覆盖日志权威容量或
   * 重新显示 null。未知容量（maxTokens=null）仍保留内部用量事实，只是 UI 不显示分母。
   * 直改 snapshot，不产 delta/revision。
   */
  // [事务] 守卫顺序即优先级：已有真实 usedTokens → 拒绝迟到种子。
  // touchedByEvent 为真时只允许补更准确的 usedTokens，绝不覆盖日志权威 maxTokens，
  // 也不把已知容量重新变成 null。
  // 未知容量（maxTokens=null）仍保留内部用量事实，只是 UI 不显示分母。
  // 直改 snapshot，不产 delta/revision；重复调用等价。
  // 非法 usedTokens（非有限/<=0）直接返回，不做截断补偿。
  seedUsage(seed: SessionUsageSeed): void {
    const current = this.snapshot.usage;
    const currentContextWindow = current.contextWindow;
    if (currentContextWindow) {
      this.contextWindowState.usedTokens = currentContextWindow.usedTokens;
    }
    // 未知容量也有内部用量事实；迟到的恢复种子不能覆盖真实 ModelComplete/Compact 水位。
    if (this.contextWindowState.usedTokens > 0) {
      return;
    }
    const seededContextWindow = seed.contextWindow;
    if (!Number.isFinite(seededContextWindow.usedTokens) || seededContextWindow.usedTokens <= 0) {
      return;
    }
    const cumulative = {
      inputTokens: seed.cumulative?.inputTokens ?? current.cumulative.inputTokens,
      outputTokens: seed.cumulative?.outputTokens ?? current.cumulative.outputTokens,
      cacheReadTokens: seed.cumulative?.cacheReadTokens ?? current.cumulative.cacheReadTokens,
      cacheWriteTokens: seed.cumulative?.cacheWriteTokens ?? current.cumulative.cacheWriteTokens,
    };
    if (this.contextWindowState.touchedByEvent) {
      // 同类守卫：显式 ModelSelected.contextWindow（含 null）是日志权威容量，
      // hydration seed 只能补回更准确的 token 事实，不得覆盖 maxTokens 或重新显示 null。
      this.contextWindowState.usedTokens = seededContextWindow.usedTokens;
      this.snapshot = {
        ...this.snapshot,
        usage: {
          contextWindow: currentContextWindow
            ? {
                ...currentContextWindow,
                usedTokens: seededContextWindow.usedTokens,
              }
            : null,
          cumulative,
        },
      };
      return;
    }
    if (
      seededContextWindow.maxTokens !== null &&
      (!Number.isFinite(seededContextWindow.maxTokens) || seededContextWindow.maxTokens <= 0)
    ) {
      return;
    }

    // 合成历史事件只有零用量占位；种子补真实水位，未知容量不妨碍内部保留 token。
    this.contextWindowState.usedTokens = seededContextWindow.usedTokens;
    this.contextWindowState.maxTokens = seededContextWindow.maxTokens;
    this.snapshot = {
      ...this.snapshot,
      usage: {
        contextWindow:
          seededContextWindow.maxTokens === null
            ? null
            : { ...seededContextWindow, maxTokens: seededContextWindow.maxTokens },
        cumulative,
      },
    };
  }

  /**
   * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
   * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
   * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
   */
  // [事务] 这是冷恢复发布前的权威替换：transcript 只能恢复可见 row，
  // 只有 session store 能证明 child 已持久化为 subagent_child。
  // 先算 invalid 集合再过滤 running：顺序反了会让 ghost 进入运行列表。
  // revision 至少为 1（只要存在 child），否则 renderer 认为权威态未建立。
  // endedTotal 由 childSessionIds - running 推导，不接受外部传入。
  seedSubagents(seed: SessionSubagentsSeed): void {
    const childSessionIds = [...new Set(seed.childSessionIds)];
    const allowed = new Set(childSessionIds);
    this.invalidSubagentChildSessionIds = new Set(
      this.snapshot.rows.window.flatMap((row) =>
        row.kind === "subagent" && row.childSessionId && !allowed.has(row.childSessionId)
          ? [row.childSessionId]
          : [],
      ),
    );
    const running = seed.running.filter((item) => allowed.has(item.childSessionId));
    this.snapshot = {
      ...this.snapshot,
      subagents: {
        // 非空 cold manifest 必须至少从 1 开始；renderer 用 0 区分尚未建立权威态，
        // 否则旧 session 的 stateRevision=0 会让 child tab 失效同步被永久跳过。
        revision: Math.max(childSessionIds.length > 0 ? 1 : 0, Math.floor(seed.revision)),
        childSessionIds,
        running,
        endedTotal: Math.max(0, childSessionIds.length - running.length),
      },
    };
  }

  /**
   * rowId → 权威 messageId。桥接层执行 forkAssistant/editUserQuery 时把命令载荷的
   * 内部 rowId 翻译成 core 需要的 messageId。未知 rowId（非 assistant/user 行、
   * 或迟到）返回 null，桥接层据此回 rejected。
   */
  getMessageIdForRow(rowId: number): string | null {
    return this.messageIdByRowId.get(rowId) ?? null;
  }

  /**
   * rowId → 稳定 entityId；未知行返回 null。
   * 与 messageId 并列，用于跨 rewind/materialization 仍可寻址的行级动作与去重。
   */
  getEntityIdForRow(rowId: number): string | null {
    return this.entityIdByRowId.get(rowId) ?? null;
  }

  /**
   * 以 rowId 解析可编辑用户轮：先要求它是「当前最新可编辑行」，再按 entityId 取
   * canonical target。任何一步不满足返回 null，调用方必须回结构化拒绝。
   * 返回副本（intent 也拷贝），防止调用方改动投影内部状态。
   */
  // [契约] 先要求该行是「当前最新可编辑行」，再按 entityId 取 canonical target；
  // 任何一步不满足返回 null，调用方必须回结构化拒绝。
  // 不遍历 rows 找「最近的 user 行」：那会让历史轮重新获得编辑入口。
  // 返回副本（intent 也拷贝），防止调用方改动投影内部状态。
  resolveEditTarget(rowId: number): ConversationEditTarget | null {
    if (!this.isLatestEditableUserRow(rowId)) return null;
    const entityId = this.entityIdByRowId.get(rowId);
    return entityId ? this.resolveEditTargetByEntityId(entityId) : null;
  }

  /**
   * 按 entityId 解析编辑目标；只有「当前可编辑实体」才放行，历史/已被 rewind
   * 替换的目标返回 null。返回浅拷贝，避免桥接层直接改 intent。
   */
  // [契约] 只有 currentEditableEntityId 才放行；历史或被 rewind 替换的 target 返回 null。
  // 该门禁是防止 entityId 直查绕过 latest-only 语义的唯一拦截点。
  // 返回浅拷贝；不要在这里做额外可用性判断，可用性由 row.actions 表达。
  resolveEditTargetByEntityId(entityId: string): ConversationEditTarget | null {
    if (entityId !== this.currentEditableEntityId) return null;
    const target = this.editTargetByEntityId.get(entityId);
    return target ? { ...target, intent: { ...target.intent } } : null;
  }

  /**
   * V3 行动作的唯一解析器：先校验 rowId 与 entityId 同时命中当前投影，再按动作
   * 读取同一份 row.actions / row.fileChanges，最后补齐命令所需的 messageId。
   *
   * stale 与 rejected 必须区分：前者目标已失效（rewind/替换），后者当前门禁不允许。
   * retryTurn 需要同轮 realUser 行的 editTarget 作为重跑意图来源；文件回滚走
   * getMessageIdsForTurnRow 覆盖多段 assistant，UI 不暴露内部 messageId。
   * 纯读取，不产 delta；失败一律结构化返回。
   */
  /**
   * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
   * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
   * 不得再各自按位置、phase 或文本重算。
   */
  // [契约] V3 行动作的唯一解析器：rowId 与 entityId 必须同时命中当前投影。
  // stale（已失效）与 rejected（门禁不允许）必须区分，命令层据此选择 ACK 语义。
  // 可用性直接读同一次 materialization 生成的 row.actions，handler/preview
  // 不得再各自按位置、phase 或文本重算。
  // retryTurn 需要同轮 realUser 行的 editTarget；文件回滚走 getMessageIdsForTurnRow。
  // 纯读取，不产 delta；失败一律结构化返回，不抛异常。
  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    const row = this.findRow(target.rowId);
    if (!row || this.entityIdByRowId.get(target.rowId) !== target.entityId) {
      return { ok: false, status: "stale", reasonCode: "proto.staleTarget" };
    }
    if (action === "editUserQuery") {
      const editTarget = this.resolveEditTargetByEntityId(target.entityId);
      if (row.actions?.canEdit !== true || !row.actions.editDisposition || !editTarget) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, editTarget };
    }
    if (action === "retryTurn") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      const userRow = this.snapshot.rows.window.find(
        (candidate) =>
          candidate.turnId === row.turnId &&
          candidate.kind === "userInput" &&
          candidate.origin === "realUser",
      );
      const userEntityId = userRow ? this.entityIdByRowId.get(userRow.rowId) : undefined;
      const editTarget = userEntityId ? this.editTargetByEntityId.get(userEntityId) : undefined;
      if (row.actions?.canRetry !== true || !messageId || !editTarget) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId, editTarget };
    }
    if (action === "forkAssistant") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      if (row.actions?.canFork !== true || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (action === "setAssistantFeedback") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      if (row.kind !== "assistantText" || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (action === "setHighspeedMetrics") {
      const messageId = this.messageIdByRowId.get(row.rowId);
      if (row.kind !== "userInput" || !row.highspeed || !messageId) {
        return {
          ok: false,
          status: "rejected",
          reasonCode: "guard.actionUnavailable",
        };
      }
      return { ok: true, action, row, messageId };
    }
    if (row.kind !== "turnHeader") {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    if (
      (action === "applyFileRewind" || action === "fileRewindPreview") &&
      (!row.fileChanges || row.actions?.canRewindFiles !== true)
    ) {
      return {
        ok: false,
        status: "rejected",
        reasonCode: "guard.actionUnavailable",
      };
    }
    return {
      ok: true,
      action,
      row,
      messageIds: this.getMessageIdsForTurnRow(row.rowId),
    };
  }

  /**
   * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
   * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
   */
  // [契约] 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
  // messageId，覆盖多段 assistant 与多个 checkpoint；UI 不暴露内部 messageId。
  // model-only turn 不生成可见 userInput row，必须把 row.turnId 本身作为精确锚点，
  // 否则会漏掉 checkpoint 使用的隐藏 user messageId。
  // Continue 别名（outputContinuationRowIdByMessageId）也要并入，否则续写段丢锚点。
  // 返回去重数组，顺序不保证；调用方不得按位置解释。
  getMessageIdsForTurnRow(rowId: number): string[] {
    const row = this.findRow(rowId);
    if (!row) return [];
    const messageIds = new Set<string>();
    const runtimeTurnId = this.runtimeTurnIdByProductTurnId.get(row.turnId);
    // Bug 原因：model-only turn 不生成可见 userInput row，过去只扫描 row 会漏掉
    // checkpoint 使用的隐藏 user messageId。新 turn 有持久消息时 productTurnId
    // 就是该 messageId；把它作为精确锚点后无需扩大 runtime turn 的兜底范围。
    if (runtimeTurnId && runtimeTurnId !== row.turnId) {
      messageIds.add(row.turnId);
    }
    for (const candidate of this.snapshot.rows.window) {
      if (candidate.turnId !== row.turnId) continue;
      const messageId = this.messageIdByRowId.get(candidate.rowId);
      if (messageId) messageIds.add(messageId);
    }
    for (const [messageId, continuationRowId] of this.outputContinuationRowIdByMessageId) {
      const continuationRow = this.findRow(continuationRowId);
      if (continuationRow?.turnId === row.turnId) messageIds.add(messageId);
    }
    return [...messageIds];
  }

  /**
   * core 侧强校验：
   * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
   * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
   */
  /**
   * 判断该行是否是「最新一轮 assistant 的最后一个可见段」。
   * 条件含轮次成功收口、非 compact 覆盖、没有仍在 streaming 的后继段；
   * 仅此状态允许 fork。纯读取，供 fork 候选解析与 UI 门禁使用。
   */
  // [契约] 判断该行是否为其 turn 的最后一段 assistantText（从尾部向前找）。
  // 只比较同 turnId 的 assistantText，不看别的 kind，保证 fork 切点精确。
  // 反向扫描是 O(window)，调用频率低，不要为它加额外索引。
  // 返回 false 时不区分「不是 assistant」与「不是最后一段」，resolver 会细化 reasonCode。
  isLatestAssistantSegmentRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    if (row?.kind !== "assistantText") return false;
    for (let index = this.snapshot.rows.window.length - 1; index >= 0; index -= 1) {
      const candidate = this.snapshot.rows.window[index]!;
      if (candidate.kind === "assistantText" && candidate.turnId === row.turnId) {
        return candidate.rowId === rowId;
      }
    }
    return false;
  }

  /**
   * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
   * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
   */
  /**
   * 解析 running fork 的稳定候选：要求该行是最新 assistant 段、所属轮次成功收口、
   * 且能拿到 boundary/start messageId 与 transcriptTurnId。
   *
   * 失败分支返回与 availability 同源的 reasonCode（forkAssistantOnly /
   * forkTargetNotStable / forkTargetAmbiguous / compactOperationLock），
   * 命令层直接用它回 ACK；离线或 messageId 缺失时不得降级为按 rowId 猜测切点。
   */
  // [契约] 先查 compact 锁：compact 占用结构时任何 fork 都不可用，优先返回专用码。
  // 要求行存在、assistantText、state=complete、canFork、turnHeader=completedSuccess，
  // 且是最新段；任一不满足都归为 forkTargetNotStable。
  // boundaryMessageId 缺失归为 forkTargetAmbiguous，离线时不得按 rowId 猜切点。
  // startMessageId 允许 null（找不到 user 行），但不会因此拒绝 fork。
  // transcriptTurnId 优先 runtime 映射，缺失时退回 productTurnId（1:1 情形）。
  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    if (this.snapshot.control.activeWorks.some((work) => work.kind === "compact")) {
      return { ok: false, reasonCode: "guard.compactOperationLock" };
    }
    const row = this.findRow(rowId);
    if (row?.kind !== "assistantText") {
      return { ok: false, reasonCode: "guard.forkAssistantOnly" };
    }
    const headerRowId = this.turnHeaderRowIdByTurnId.get(row.turnId);
    const header = headerRowId === undefined ? undefined : this.findRow(headerRowId);
    if (
      row.state !== "complete" ||
      row.actions?.canFork !== true ||
      header?.kind !== "turnHeader" ||
      header.state !== "completedSuccess" ||
      !this.isLatestAssistantSegmentRow(rowId)
    ) {
      return { ok: false, reasonCode: "guard.forkTargetNotStable" };
    }
    const boundaryMessageId = this.messageIdByRowId.get(rowId);
    if (!boundaryMessageId) {
      return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
    }
    const startMessageId =
      this.snapshot.rows.window
        .filter((candidate) => candidate.turnId === row.turnId && candidate.kind === "userInput")
        .map((candidate) => this.messageIdByRowId.get(candidate.rowId))
        .find((messageId): messageId is string => Boolean(messageId)) ?? null;
    return {
      ok: true,
      candidate: {
        productTurnId: row.turnId,
        transcriptTurnId: this.runtimeTurnIdByProductTurnId.get(row.turnId) ?? row.turnId,
        startMessageId,
        boundaryMessageId,
      },
    };
  }

  /** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */
  /**
   * 判断该行是否可作为「重试」的 assistant 目标：最新一轮、已收口、未被 compact
   * 覆盖，且存在可用的 messageId。复用了最新段判定，UI 与命令层口径一致。
   */
  // [契约] retry 只能指向全时间线最新且有 realUser cause 的 assistantText；
  // 该判定与 materializeCommandRowActions 的 latestRetryable 必须保持同口径。
  // 缺少 messageId 一律不可重试：重跑需要持久锚点，而不是 rowId。
  // 不要在此追加 header 状态判断，materialization 已保证一致性。
  isLatestRetryAssistantRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    return Boolean(
      row?.kind === "assistantText" &&
      row.actions?.canRetry === true &&
      this.messageIdByRowId.has(rowId),
    );
  }

  /** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */
  /**
   * 判断该行是否是当前唯一可编辑的用户输入行（realUser、同轮、非合成来源）。
   * 同一时刻只允许一个编辑目标，避免用户在旧轮上编辑造成 transcript 分叉歧义。
   */
  // [契约] 只有 realUser 的 userInput 行可编辑；合成来源（background/goal/subagent）
  // 没有可重跑的原始意图。
  // 同一时刻只允许一个编辑目标，避免用户在旧轮编辑导致 transcript 分叉歧义。
  // messageId 必须存在；缺失时 UI 即使显示也可能被 resolver 拒绝。
  // 该函数不检查 compact 覆盖，覆盖状态由 row.actions.editDisposition 表达。
  isLatestEditableUserRow(rowId: number): boolean {
    const row = this.findRow(rowId);
    return Boolean(
      row?.kind === "userInput" &&
      row.origin === "realUser" &&
      row.actions?.canEdit === true &&
      this.messageIdByRowId.has(rowId),
    );
  }

  /** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */
  /**
   * 行所属的产品轮 turnId；行不存在返回 null。产品 turnId 是 rows 分组与
   * edit/retry/fork 的共同锚点，跨 runtime turn 分片时仍保持稳定。
   */
  // [契约] 产品 turnId 是 rows 分组与 edit/retry/fork 的共同锚点，
  // 跨 runtime turn 分片时仍保持稳定。
  // 行不存在返回 null，调用方不得用 runtimeTurnId 兜底猜测。
  getTurnIdForRow(rowId: number): string | null {
    return this.findRow(rowId)?.turnId ?? null;
  }

  // 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。
  /**
   * live 路径：归一化 → reduce → 物化 command row actions → 绑定 revision。
   *
   * 返回的 delta 必须是"可被客户端按顺序 apply"的最小集合；
   * 任何需要重排/删除整段结构的操作都在这里转成 snapshot 触发信号。
   */
  /**
   * live 事件入口：经 normalize 成 canonical fact 后走一次完整归约并原地提交。
   *
   * 输出是本次事件产出的 delta 数组，已统一绑定 seq/revision 并登记了所有索引；
   * 返回空数组表示事件被接受但无可见变化（也可能是被守卫拒收，见诊断计数）。
   * 失败/未知 payload 不抛异常、不产 delta，由 normalize 降级并记录诊断；
   * 结构性变化一律通过现有五种 delta 表达，表达不了则上层触发 snapshot/resync。
   * 副作用：修改自身 snapshot、索引与流式游标；不直接广播，发布由 publisher 负责。
   */
  // [事务] live 入口：归一化 → reduce → 物化 command actions → 绑定 revision → 提交。
  // 返回的 delta 必须是客户端可按序 apply 的最小集合，并已绑定 seq/revision。
  // 空数组表示事件被接受但无可见变化，也可能是被守卫拒收（见诊断计数）。
  // 不抛异常：未知 payload 由 normalize 降级并记录诊断。
  // 副作用仅限本实例状态；广播由 publisher 负责，不要在这里发帧。
  applyEvent(event: SessionEvent): ConversationDelta[] {
    return this.applyEventInternal(event, true);
  }

  // 冷恢复批量路径只允许在尚未发布的候选 projection 上使用；begin 后 rows.window
  // 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
  /**
   * cold 重放开始：后续 applyHydrationEvent 只累积到 hydrationAccumulator，
   * 不直接改 snapshot。这样 live 事件在重建窗口内仍可正常推进，
   * 最后 completeHydrationReplay 再合并并产出一次性 delta。
   */
  // [事务] cold 重放只能发生在尚未发布的候选 projection 上；
  // begin 后 rows.window 原地推进，避免每个事件复制增长数组。
  // 重复 begin 直接抛错：并发 hydration 会破坏 accumulator 与索引的一致性。
  // 接管 accumulator 的 rowIndexById，避免重放期间重建索引。
  // begin 不改变对外可见 snapshot 语义，publisher 在完整校验通过前不会 adopt。
  beginHydrationReplay(): void {
    if (this.hydrationAccumulator) throw new Error("hydration replay already active");
    this.hydrationAccumulator = createMutableConversationSnapshotAccumulator(this.snapshot);
    this.snapshot = this.hydrationAccumulator.snapshot;
    this.rowIndexById = this.hydrationAccumulator.rowIndexById;
  }

  /**
   * cold 重放单事件：必须处于 begin 之后；只把归约结果累积进 accumulator，
   * 不改已发布 snapshot。materializeActions=false，命令 actions 统一在 complete 时
   * 收敛，避免批量期间反复重算。返回的 delta 与 live 同样经 revision 记账，
   * 但此时尚未提交给客户端。
   */
  // [事务] 必须处于 begin 之后；否则抛错而不是静默降级为 live。
  // materializeActions=false：批量期间不重算命令 actions，complete 时统一收敛。
  // delta 仍经 revision 记账，但此时尚未提交给客户端。
  // 与 live 共用 applyEventInternal，保证同一事实收敛到同一终态。
  applyHydrationEvent(event: SessionEvent): ConversationDelta[] {
    if (!this.hydrationAccumulator) throw new Error("hydration replay is not active");
    return this.applyEventInternal(event, false);
  }

  /**
   * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
   * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
   */
  // [事务] 把批量期间延迟的 command actions 一次性收敛并 apply 到 accumulator。
  // actions 不单独递增 revision：触发它变化的结构/guard 事件已经记账。
  // 完成后清空 accumulator，后续事件回到 live 路径。
  // 未 begin 就调用会抛错；重复调用同样抛错。
  completeHydrationReplay(): ConversationDelta[] {
    if (!this.hydrationAccumulator) throw new Error("hydration replay is not active");
    const deltas = this.materializeCommandRowActions([]);
    applyConversationDeltasMutable(this.hydrationAccumulator, deltas);
    this.hydrationAccumulator = null;
    return deltas;
  }

  /**
   * live 与 cold 共用的归约主干。
   *
   * 顺序固定：先按事件类型走专用 handler（feedback/highspeed/modelFallback），
   * 其余 normalize 成 canonical fact 并收集诊断 → reduce 产出基础 delta →
   * 需要时镜像 subagent 投影 → live 才 materialize 命令 actions → 清预览 →
   * attachRevision → 提交（accumulator 或不可变 snapshot）→ 更新工具索引。
   * 关键不变量：row、命令 target 与 actions 必须在同一次 materialization 事务里生成，
   * 否则会出现「入口可见但 target 不可解析」；hydration 期间 seq 也推进到事件序号，
   * 保证冷恢复终态与 live 等价。
   */
  // [事务] live 与 cold 共用的归约主干，顺序固定且不可交换：
  // 专用 handler → normalize/reduce → subagent 镜像 → materialize actions → 清预览 →
  // attachRevision → 提交（accumulator 或不可变 snapshot）→ 更新工具索引。
  // row、命令 target 与 actions 必须在同一次 materialization 事务里生成，
  // 否则会出现「入口可见但 target 不可解析」。
  // hydration 期间 seq 也推进到事件序号，保证冷恢复终态与 live 等价。
  private applyEventInternal(
    event: SessionEvent,
    materializeActions: boolean,
  ): ConversationDelta[] {
    if (event.type === SessionEventType.SubagentSpawned) {
      const childSessionId = this.stringPayload(
        event.payload as Record<string, unknown>,
        "childSessionId",
      );
      // live spawn 已经过 core persist-before-publish 闸门；若它是旧 ghost 的合法 resume，
      // 以新事件恢复资格。hydration 期间 seed 尚未建立排除集合，不会误放历史引用。
      if (childSessionId) this.invalidSubagentChildSessionIds.delete(childSessionId);
    }
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    const productTurnId =
      event.type === SessionEventType.TurnStarted
        ? undefined
        : (this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId);
    const reduced =
      event.type === SessionEventType.AssistantFeedbackUpdated
        ? this.onAssistantFeedbackUpdated(event)
        : event.type === SessionEventType.HighspeedMetricsUpdated
          ? this.onHighspeedMetricsUpdated(event)
          : event.type === SessionEventType.TurnExecutionModelFallback
            ? this.onTurnExecutionModelFallback(event)
            : (() => {
                const fact = normalizeConversationEvent(event, {
                  productTurnId,
                  openAssistantSegments: this.openAssistantSegments(),
                });
                this.normalizationDiagnostics.push(...fact.diagnostics);
                return this.reduce(fact);
              })();
    const subagentDeltas = this.shouldMaterializeSubagentProjection(reduced)
      ? this.materializeSubagentProjection(reduced)
      : [];
    const reducedWithSubagents = [...reduced, ...subagentDeltas];
    // row、命令 target 与 actions 必须属于同一个 materialization transaction。
    // 旧实现只维护 side-map/最新行判断，UI action 由别处推断，cold/tool-only/failed
    // 轮会出现“入口可见但 target 不可解析”，新目标出现后旧入口也不会撤销。
    const deltas = materializeActions
      ? [...reducedWithSubagents, ...this.materializeCommandRowActions(reducedWithSubagents)]
      : reducedWithSubagents;
    const finalDeltas = this.attachRevision(clearSettledOutputPreviews(deltas));
    if (this.hydrationAccumulator) {
      applyConversationDeltasMutable(this.hydrationAccumulator, finalDeltas);
      this.snapshot.seq = event.sequenceNumber;
    } else {
      const previousRowsLength = this.snapshot.rows.window.length;
      this.snapshot = {
        ...applyConversationDeltas(this.snapshot, finalDeltas),
        seq: event.sequenceNumber,
      };
      this.updateRowIndexAfterImmutableApply(previousRowsLength, finalDeltas);
    }
    this.updateToolIndexesAfterDeltas(finalDeltas);
    return finalDeltas;
  }

  /**
   * 在独立候选投影上归约事件，校验通过后才原子提交。
   *
   * projection 超过 logical frame assembly 上限时，如果先修改当前实例再等
   * wire encoder 报错，权威内存态会永久停在“无法发 snapshot”的状态。候选实例同时
   * 隔离 snapshot 与 reducer 的各类 side-map；拒绝时当前实例完全不变，客户端仍可从
   * 最后一个可传输 snapshot 恢复。
   *
   * `accept` 同时拿到这条事件**实际产出**的 delta：有些事件类别可以只按 delta 的字节数给出
   * 一个可靠上界，不必把整份候选快照再序列化一遍（publisher 的 ingest 快路径）。传的是实际
   * 产出而不是预演，正是因为预演算不准——投影在 reducer 之上还叠了 subagent 镜像与命令
   * actions 的 materialization，少算一条就把 16MiB 闸门算松了。
   */
  // [事务] 在独立候选投影上归约，accept 通过后才原子 adopt；拒绝时当前实例完全不变。
  // 为什么需要：超过 wire frame 上限时若先改权威态再等编码报错，
  // 内存态会永久卡在「无法发 snapshot」。
  // accept 拿到该事件实际产出的 delta（不是预演），供 publisher 做体积上界判断。
  // 返回 null 表示被拒绝，调用方必须按未发生处理，不得重试同一事件到同一实例。
  // 该路径会深拷贝全部索引，成本高于 applyEvent，只用于实时发布。
  applyEventAtomically(
    event: SessionEvent,
    accept: (snapshot: ConversationSnapshot, deltas: readonly ConversationDelta[]) => boolean,
  ): ConversationDelta[] | null {
    const candidate = this.cloneProjection();
    const deltas = candidate.applyEvent(event);
    if (!accept(candidate.snapshot, deltas)) return null;
    this.adoptProjection(candidate);
    return deltas;
  }

  // 深拷贝 snapshot 与必要的派生索引；只用于原子应用/回滚，不在普通事件路径调用。
  /**
   * 深拷贝当前投影（snapshot + 全部 side-map/游标/计数），供 applyEventAtomically 的
   * 候选实例使用。必须逐项复制每一个 Map/Set（含嵌套 highspeed 间隔），漏一个字段
   * 就会让候选与权威态分叉；这是“先试算、校验通过再 adopt”的隔离基础。
   */
  // [事务] 深拷贝 snapshot 与全部 side-map/游标/计数，供候选实例试算。
  // 必须逐项复制每个 Map/Set（含 highspeed 的嵌套 Map 与 fileToolInputPreview 条目），
  // 漏一个字段就会让候选与权威态共享可变引用，accept 失败时回滚不干净。
  // snapshot 本身复用引用是安全的：后续归约走不可变替换，不就地修改。
  // hydrationAccumulator 强制为 null：候选不能继承进行中的批量会话。
  private cloneProjection(): ProductProjection {
    const clone = Object.create(ProductProjection.prototype) as ProductProjection;
    clone.snapshot = this.snapshot;
    clone.rowIndexById = new Map(this.rowIndexById);
    clone.hydrationAccumulator = null;
    clone.nextRowId = this.nextRowId;
    clone.streamingTextRowId = this.streamingTextRowId;
    clone.streamingReasoningRowId = this.streamingReasoningRowId;
    clone.outputContinuationTextRowId = this.outputContinuationTextRowId;
    clone.toolRowIdByCallId = new Map(this.toolRowIdByCallId);
    // 实时发布逐事件走原子 clone；遗漏该侧表会让成功的 list_apps 快照在提交时丢失。
    clone.latestListAppsSnapshot = new Map(this.latestListAppsSnapshot);
    clone.openForegroundToolCallIds = new Set(this.openForegroundToolCallIds);
    clone.fileToolInputPreviewByCallId = new Map(
      [...this.fileToolInputPreviewByCallId].map(([toolCallId, state]) => [
        toolCallId,
        { ...state },
      ]),
    );
    clone.subagentRowIdByAgentId = new Map(this.subagentRowIdByAgentId);
    clone.hookRowIdByInvocationId = new Map(this.hookRowIdByInvocationId);
    clone.pendingSessionHookInvocations = new Map(
      [...this.pendingSessionHookInvocations].map(([invocationId, pending]) => [
        invocationId,
        {
          firstEvent: pending.firstEvent,
          content: {
            ...pending.content,
            executions: pending.content.executions.map((execution) => ({ ...execution })),
          },
        },
      ]),
    );
    clone.rewoundHookInvocationIds = new Set(this.rewoundHookInvocationIds);
    clone.invalidSubagentChildSessionIds = new Set(this.invalidSubagentChildSessionIds);
    clone.messageIdByRowId = new Map(this.messageIdByRowId);
    clone.outputContinuationRowIdByMessageId = new Map(this.outputContinuationRowIdByMessageId);
    clone.entityIdByRowId = new Map(this.entityIdByRowId);
    clone.editTargetByEntityId = new Map(this.editTargetByEntityId);
    clone.currentEditableEntityId = this.currentEditableEntityId;
    clone.stableCompactCoverageBoundaryRowId = this.stableCompactCoverageBoundaryRowId;
    clone.turnHeaderRowIdByTurnId = new Map(this.turnHeaderRowIdByTurnId);
    clone.compactMarkerRowIdByOperationId = new Map(this.compactMarkerRowIdByOperationId);
    clone.goalVerifyMarkerRowIdByLifecycleKey = new Map(this.goalVerifyMarkerRowIdByLifecycleKey);
    clone.productTurnIdByRuntimeTurnId = new Map(this.productTurnIdByRuntimeTurnId);
    clone.runtimeTurnIdByProductTurnId = new Map(this.runtimeTurnIdByProductTurnId);
    clone.productTurnSplitOrdinalByRuntimeTurnId = new Map(
      this.productTurnSplitOrdinalByRuntimeTurnId,
    );
    clone.currentProductTurnStartedAtMs = this.currentProductTurnStartedAtMs;
    clone.highspeedModelDurationByTurnId = new Map(this.highspeedModelDurationByTurnId);
    clone.highspeedToolIntervalsByTurnId = new Map(
      [...this.highspeedToolIntervalsByTurnId].map(([turnId, intervals]) => [
        turnId,
        new Map([...intervals].map(([toolCallId, interval]) => [toolCallId, { ...interval }])),
      ]),
    );
    clone.deliveryByPendingInputId = new Map(this.deliveryByPendingInputId);
    clone.currentTurnId = this.currentTurnId;
    clone.currentTurnStartedModelOnly = this.currentTurnStartedModelOnly;
    clone.contextWindowState = { ...this.contextWindowState };
    clone.lastTurnModel = { ...this.lastTurnModel };
    clone.configModelTouchedByEvent = this.configModelTouchedByEvent;
    clone.configThoughtLevelsTouchedByEvent = this.configThoughtLevelsTouchedByEvent;
    clone.configModeTouchedByEvent = this.configModeTouchedByEvent;
    clone.droppedContentStreamEventCount = this.droppedContentStreamEventCount;
    clone.normalizationDiagnostics = [...this.normalizationDiagnostics];
    return clone;
  }

  /**
   * 原子 adopt：把候选实例的全部状态/索引引用一次性接管到当前实例（快照与 Map
   * 由候选独占，无需再拷贝），并清空 hydrationAccumulator。
   * 只在候选事件归约与 wire 体积校验都通过后调用；失败路径绝不走到这里，
   * 从而保证权威内存态不会卡在“无法发 snapshot”的状态。
   */
  // [事务] 一次性接管候选的全部引用，避免二次拷贝；候选状态此后独占。
  // 只在归约与 wire 体积校验都通过后调用；失败路径绝不走到这里。
  // 必须逐字段赋值——漏一个会让新快照搭配旧索引，出现幽灵行。
  // adopt 后清空 hydrationAccumulator，防止旧 accumulator 继续指向被替换的 snapshot。
  private adoptProjection(candidate: ProductProjection): void {
    this.snapshot = candidate.snapshot;
    this.rowIndexById = candidate.rowIndexById;
    this.hydrationAccumulator = null;
    this.nextRowId = candidate.nextRowId;
    this.streamingTextRowId = candidate.streamingTextRowId;
    this.streamingReasoningRowId = candidate.streamingReasoningRowId;
    this.outputContinuationTextRowId = candidate.outputContinuationTextRowId;
    this.toolRowIdByCallId = candidate.toolRowIdByCallId;
    this.latestListAppsSnapshot = candidate.latestListAppsSnapshot;
    this.openForegroundToolCallIds = candidate.openForegroundToolCallIds;
    this.fileToolInputPreviewByCallId = candidate.fileToolInputPreviewByCallId;
    this.subagentRowIdByAgentId = candidate.subagentRowIdByAgentId;
    this.hookRowIdByInvocationId = candidate.hookRowIdByInvocationId;
    this.pendingSessionHookInvocations = candidate.pendingSessionHookInvocations;
    this.rewoundHookInvocationIds = candidate.rewoundHookInvocationIds;
    this.invalidSubagentChildSessionIds = candidate.invalidSubagentChildSessionIds;
    this.messageIdByRowId = candidate.messageIdByRowId;
    this.outputContinuationRowIdByMessageId = candidate.outputContinuationRowIdByMessageId;
    this.entityIdByRowId = candidate.entityIdByRowId;
    this.editTargetByEntityId = candidate.editTargetByEntityId;
    this.currentEditableEntityId = candidate.currentEditableEntityId;
    this.stableCompactCoverageBoundaryRowId = candidate.stableCompactCoverageBoundaryRowId;
    this.turnHeaderRowIdByTurnId = candidate.turnHeaderRowIdByTurnId;
    this.compactMarkerRowIdByOperationId = candidate.compactMarkerRowIdByOperationId;
    this.goalVerifyMarkerRowIdByLifecycleKey = candidate.goalVerifyMarkerRowIdByLifecycleKey;
    this.productTurnIdByRuntimeTurnId = candidate.productTurnIdByRuntimeTurnId;
    this.runtimeTurnIdByProductTurnId = candidate.runtimeTurnIdByProductTurnId;
    this.productTurnSplitOrdinalByRuntimeTurnId = candidate.productTurnSplitOrdinalByRuntimeTurnId;
    this.currentProductTurnStartedAtMs = candidate.currentProductTurnStartedAtMs;
    this.highspeedModelDurationByTurnId = candidate.highspeedModelDurationByTurnId;
    this.highspeedToolIntervalsByTurnId = candidate.highspeedToolIntervalsByTurnId;
    this.deliveryByPendingInputId = candidate.deliveryByPendingInputId;
    this.currentTurnId = candidate.currentTurnId;
    this.currentTurnStartedModelOnly = candidate.currentTurnStartedModelOnly;
    this.contextWindowState = candidate.contextWindowState;
    this.lastTurnModel = candidate.lastTurnModel;
    this.configModelTouchedByEvent = candidate.configModelTouchedByEvent;
    this.configThoughtLevelsTouchedByEvent = candidate.configThoughtLevelsTouchedByEvent;
    this.configModeTouchedByEvent = candidate.configModeTouchedByEvent;
    this.droppedContentStreamEventCount = candidate.droppedContentStreamEventCount;
    this.normalizationDiagnostics = candidate.normalizationDiagnostics;
  }

  /**
   * 基于本事件归约后的 prospective rows 原子生成 edit/retry actions。
   * action=true 必须蕴含命令层同 revision 下能解析出持久 message target；最新目标
   * 改变时同时 upsert 旧、新两行，客户端不需要按数组位置补推断。
   */
  /**
   * 重新计算并注入行级 command actions / target 元数据（可编辑、可重试、可 fork、
   * 文件回滚、反馈、highspeed）。
   *
   * 这是同一 reducer 的派生 materialization：不新增业务事实，只把当前 projection
   * 的可操作性写回 row。因此它不单独递增 revision——触发变化的结构/guard 事件
   * 已经记账；批量 hydration 在 complete 时统一收敛一次。
   */
  // [契约] 同一 reducer 的派生 materialization：不新增业务事实，只把可操作性写回 row。
  // 因此不单独递增 revision——触发变化的结构/guard 事件已经记账。
  // prospective 必须用 applyConversationDeltas 现算，不能读 this.snapshot：
  // 本事件的 delta 尚未提交，读旧快照会得出上一帧的 actions。
  // latest-only 语义集中在这里：可编辑/可重试/可 fork 的行只在最后一次物化中被标记，
  // 其余行必须 delete 旧 action，否则历史入口不会撤销。
  // edit action 与 resolver 共用 canonical target authority，避免「显示可编辑但提交被拒」。
  private materializeCommandRowActions(reduced: ConversationDelta[]): ConversationDelta[] {
    const prospective = applyConversationDeltas(this.snapshot, reduced);
    const rows = prospective.rows.window;
    const rowById = new Map(rows.map((row) => [row.rowId, row]));
    const latestAssistantRowIdByTurn = new Map<string, number>();
    for (const row of rows) {
      if (row.kind !== "assistantText") continue;
      const current = latestAssistantRowIdByTurn.get(row.turnId);
      if (current === undefined || row.rowId > current) {
        latestAssistantRowIdByTurn.set(row.turnId, row.rowId);
      }
    }
    const compactActive = prospective.control.activeWorks.some((work) => work.kind === "compact");
    const completionBlockingActive = prospective.control.activeWorks.length > 0;
    let latestEditable: ConversationRow | undefined;
    let latestAssistant: AssistantTextRow | undefined;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (
        !latestEditable &&
        !compactActive &&
        row.kind === "userInput" &&
        row.origin === "realUser"
      ) {
        latestEditable = row;
      }
      if (!latestAssistant && row.kind === "assistantText") {
        latestAssistant = row;
      }
      if (latestEditable && latestAssistant) break;
    }
    // 旧逻辑只按“最新完整 assistant”挑 retry，background result 的
    // synthetic turn 因此会错误获得入口；若只在 find 条件里过滤 synthetic，又会跳过
    // 最新 background assistant，让更早真实用户轮的 retry 复活。这里必须先锁定全时间线
    // 最新 assistant，再校验同轮 realUser canonical cause，保证普通 retry 不跨轮回退。
    const latestRetryable = (() => {
      if (
        completionBlockingActive ||
        !latestAssistant ||
        latestAssistant.state !== "complete" ||
        !this.messageIdByRowId.has(latestAssistant.rowId)
      ) {
        return undefined;
      }
      const headerId = this.turnHeaderRowIdByTurnId.get(latestAssistant.turnId);
      const header = headerId === undefined ? undefined : rowById.get(headerId);
      if (header?.kind !== "turnHeader" || header.state === "running") return undefined;
      const canonicalUserRow = rows.find(
        (row) =>
          row.turnId === latestAssistant.turnId &&
          row.kind === "userInput" &&
          row.origin === "realUser",
      );
      const canonicalUserEntityId = canonicalUserRow
        ? this.entityIdByRowId.get(canonicalUserRow.rowId)
        : undefined;
      if (!canonicalUserEntityId || !this.editTargetByEntityId.has(canonicalUserEntityId)) {
        return undefined;
      }
      return latestAssistant;
    })();
    const latestEditableEntityId =
      latestEditable === undefined
        ? null
        : (this.entityIdByRowId.get(latestEditable.rowId) ?? null);
    // edit action 与命令 resolver 必须共用 canonical target authority。过去 drain 分支只
    // 登记 messageId，UI 因而显示 Edit，但提交必被 resolver 以 actionUnavailable 拒绝。
    const latestEditableRowId =
      latestEditable &&
      latestEditableEntityId &&
      this.messageIdByRowId.has(latestEditable.rowId) &&
      this.editTargetByEntityId.has(latestEditableEntityId)
        ? latestEditable.rowId
        : null;
    // entity target 历史表会保留旧记录；仅撤销 row action 不足以阻止
    // entityId 直查绕过 latest-only 语义。当前可编辑 authority 与 actions 在同一次
    // materialization 中更新，resolver 不再遍历 rows，也不把 rowId 当 canonical key。
    this.currentEditableEntityId = latestEditableRowId === null ? null : latestEditableEntityId;
    const latestRetryableRowId = latestRetryable?.rowId ?? null;
    const deltas: ConversationDelta[] = [];

    for (const row of rows) {
      if (row.kind !== "turnHeader" && row.kind !== "userInput" && row.kind !== "assistantText")
        continue;
      const nextActions = { ...row.actions };
      if (row.kind === "turnHeader") {
        const canRewindFiles =
          !completionBlockingActive &&
          prospective.pendingInteractions.length === 0 &&
          row.state !== "running" &&
          row.fileChanges?.state === "active";
        if (canRewindFiles) nextActions.canRewindFiles = true;
        else delete nextActions.canRewindFiles;
      } else if (row.kind === "userInput") {
        if (row.rowId === latestEditableRowId) {
          nextActions.canEdit = true;
          nextActions.editDisposition = "rewind";
        } else {
          delete nextActions.canEdit;
          delete nextActions.editDisposition;
        }
      } else {
        if (row.rowId === latestRetryableRowId) nextActions.canRetry = true;
        else delete nextActions.canRetry;
        const headerId = this.turnHeaderRowIdByTurnId.get(row.turnId);
        const header = headerId === undefined ? undefined : rowById.get(headerId);
        const canFork =
          !compactActive &&
          row.state === "complete" &&
          header?.kind === "turnHeader" &&
          header.state === "completedSuccess" &&
          latestAssistantRowIdByTurn.get(row.turnId) === row.rowId &&
          this.messageIdByRowId.has(row.rowId);
        if (canFork) nextActions.canFork = true;
        else delete nextActions.canFork;
      }
      const actions = Object.keys(nextActions).length > 0 ? nextActions : undefined;
      if (JSON.stringify(actions) === JSON.stringify(row.actions)) continue;
      const nextRow: ConversationRow = { ...row, actions };
      if (!actions) delete nextRow.actions;
      deltas.push({ op: "row.upserted", row: nextRow });
    }
    return deltas;
  }

  // revision 递进：本事件含任一结构性 delta → revision +1，
  // 且携带规则要求 deltas 中必含 state.updated.revision。
  /**
   * 为每条 delta 绑定 seq/revision 并汇总本次事件的 revision 增量。
   *
   * 记账口径：行结构变化按 delta 各自的 revision 声明累加；state.updated 只按
   * projection-state 的 REVISION_BEARING_PATCH_KEYS 判定（usage/pendingCommands/
   * workflowRuns 豁免）。sv 固定 +1。row.delta（纯文本追加）不推进 revision。
   * 只包装 delta 元数据，不改内容；snapshot 的 revision 在该返回值上再统一提交。
   */
  // [事务] 只有存在 deltaBumpsRevision 的 delta 才整体 +1，并内联到最后一条 delta。
  // state.updated 只按 projection-state 的 REVISION_BEARING_PATCH_KEYS 判定；
  // usage/pendingCommands/workflowRuns 豁免，避免高频派生数据造成 CAS 假失败。
  // row.delta（纯文本追加）不推进 revision，保证流式追加不打断客户端缓存。
  // 若最后一条已是 state.updated，则合并 patch 而不是再追加一条，避免同帧双 revision。
  private attachRevision(deltas: ConversationDelta[]): ConversationDelta[] {
    if (!deltas.some(deltaBumpsRevision)) return deltas;
    const revision = this.snapshot.revision + 1;
    const last = deltas[deltas.length - 1];
    if (last?.op === "state.updated") {
      return [...deltas.slice(0, -1), { op: "state.updated", patch: { ...last.patch, revision } }];
    }
    return [...deltas, { op: "state.updated", patch: { revision } }];
  }

  /**
   * 按 canonical fact 的 semanticKind 分派到具体 onXxx。
   *
   * reduce 只负责"事实 → delta"，不负责发帧、不负责 revision；
   * 需要跨事件维护的状态（streaming row、open tool、pending hook）放在实例字段，
   * 且必须能从 snapshot 重建（resync 后仍正确）。
   */
  /**
   * canonical fact 分派器：按 fact.kind 路由到对应 on* handler。
   *
   * 每个 handler 只依赖 fact 与当前投影，返回最小可 apply 的 delta 集合；
   * 未知/不应出现的 kind 返回空数组而非抛异常（normalize 已负责降级诊断）。
   * 结构重排、跨行迁移等五种 delta 表达不了的变化在这里不硬编码，
   * 由上层根据不一致信号发 snapshot/resync。
   */
  // [契约] canonical fact 分派器：每个 handler 只依赖 fact 与当前投影，
  // 返回最小可 apply 的 delta 集合。
  // 未知/不应出现的 kind 返回空数组而不抛错：normalize 已负责降级并记诊断。
  // 结构重排、跨行迁移等五种 delta 表达不了的变化不在这里硬编码，
  // 由上层根据不一致信号发 snapshot/resync。
  // TurnStarted 只在 semanticKind=userIntent 时处理；model-only 轮不建可见轮次。
  private reduce(fact: CanonicalConversationFact): ConversationDelta[] {
    const event = fact.event;
    switch (event.type) {
      case SessionEventType.SessionCreated:
        return this.onSessionCreated(event);
      case SessionEventType.SessionResumed:
        return this.onSessionResumed(event);
      case SessionEventType.SessionTitleUpdated:
        return this.onSessionTitleUpdated(event);
      case SessionEventType.TurnStarted:
        if (fact.semanticKind !== "userIntent") return [];
        return [
          ...this.onTurnStarted(fact),
          // model-only 维护 turn（manual /compact、goal continuation）没有资格
          // 承载 SessionStart 摘要；pending 保持到下一条 user-visible 真实 turn。
          ...(this.currentTurnStartedModelOnly
            ? []
            : this.flushPendingSessionHookInvocations(fact.productTurnId)),
        ];
      case SessionEventType.ModelStreaming: {
        if (fact.semanticKind !== "assistantSegment") return [];
        const shouldClearApiRetry =
          this.acceptsActiveModelEvent(event) &&
          isZCodeModelRetryRecoveryProgressPayload(
            event.payload as unknown as Record<string, unknown>,
          );
        const streamingDeltas = this.onModelStreaming(fact);
        return shouldClearApiRetry
          ? [...streamingDeltas, ...this.setApiRetry(null)]
          : streamingDeltas;
      }
      case SessionEventType.ModelNetworkStatus:
        return this.onModelNetworkStatus(event);
      case SessionEventType.StreamRecoveryStarted:
        return this.onStreamRecoveryStarted(event);
      case SessionEventType.StreamRecoveryTailDiscarded:
        return this.onStreamRecoveryTailDiscarded(event);
      case SessionEventType.StreamRecoveryRetryStarted:
        return this.onStreamRecoveryRetryStarted(event);
      case SessionEventType.ModelSelected:
        return this.onModelSelected(event);
      case SessionEventType.ModelComplete:
        return this.onModelComplete(event);
      case SessionEventType.ToolCallScheduled:
        return this.onToolCallScheduled(event);
      case SessionEventType.StreamingToolLedgerUpdated:
        return this.onStreamingToolIdentity(event);
      case SessionEventType.ToolCallStarted:
        return this.onToolCallActivity(event);
      case SessionEventType.ToolCallProgress:
        return this.onToolCallProgress(event);
      case SessionEventType.ToolCallResult:
        return this.onToolCallResult(event);
      case SessionEventType.ToolCallError:
        return this.onToolCallError(event);
      case SessionEventType.PermissionRequested:
        return this.onPermissionRequested(event);
      case SessionEventType.PermissionResolved:
        return this.onPermissionResolved(event);
      case SessionEventType.PermissionDenied:
        return this.onPermissionDenied(event);
      case SessionEventType.PluginUiResourceUpdated: {
        // live-only，不改快照；renderer 按 subscribers 派发给沙箱实例。
        const payload = event.payload as PluginUiResourceUpdatedPayload;
        return [
          {
            op: "pluginUi.resourceUpdated",
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            uri: payload.uri,
            subscribers: payload.subscribers,
          },
        ];
      }
      case SessionEventType.PluginUiResourceListChanged: {
        const payload = event.payload as PluginUiResourceListChangedPayload;
        return [
          {
            op: "pluginUi.resourceListChanged",
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            subscribers: payload.subscribers,
          },
        ];
      }
      case SessionEventType.PluginUiInstanceClosed: {
        const payload = event.payload as PluginUiResourceListChangedPayload;
        return [{ op: "pluginUi.instanceClosed", ...payload }];
      }
      case SessionEventType.PluginUiAppToolCallRequested: {
        // App-Provided Tools 信箱：live-only，投递给 subscribers 里唯一的实例。
        const payload = event.payload as PluginUiAppToolCallRequestedPayload;
        return [
          {
            op: "pluginUi.appToolCall",
            activity: payload.activity,
            ...(payload.cancelled ? { cancelled: true } : {}),
            pluginId: payload.pluginId,
            serverName: payload.serverName,
            subscribers: payload.subscribers,
            callId: payload.callId,
            toolName: payload.toolName,
            arguments: payload.arguments,
          },
        ];
      }
      case SessionEventType.UserInputAutoResolutionUpdated:
        return this.onUserInputAutoResolutionUpdated(event);
      case SessionEventType.WorkspaceHookReviewRequested:
        return this.onWorkspaceHookReviewRequested(event);
      case SessionEventType.WorkspaceHookReviewSettled:
        return this.onWorkspaceHookReviewSettled(event);
      case SessionEventType.WorkspaceHookReviewSuperseded:
        return this.onWorkspaceHookReviewSuperseded(event);
      case SessionEventType.WorkspaceHookAdmissionUpdated:
        return this.onWorkspaceHookAdmissionUpdated(event);
      case SessionEventType.HookRunStarted:
      case SessionEventType.HookRunProgress:
      case SessionEventType.HookRunCompleted:
      case SessionEventType.HookRunFailed:
      case SessionEventType.HookRunBlocked:
        return this.onHookRunLifecycle(event);
      case SessionEventType.TurnSteerQueued:
        return this.onTurnSteerQueued(event);
      case SessionEventType.TurnSteerDeliveryChanged:
        return this.onTurnSteerDeliveryChanged(event);
      case SessionEventType.TurnSteerDispatchChanged:
        return this.onTurnSteerDispatchChanged(event);
      case SessionEventType.TurnSteerDrained:
        return this.onTurnSteerDrained(event);
      case SessionEventType.TurnSteerDiscarded:
        return this.onTurnSteerDiscarded(event);
      case SessionEventType.SessionInputPromoted:
        return this.onSessionInputPromoted(event);
      case SessionEventType.TurnSteerReordered:
        return this.onTurnSteerReordered(event);
      case SessionEventType.QueueAutoDrainChanged:
        return this.onQueueAutoDrainChanged(event);
      case SessionEventType.FollowupModeChanged:
        return this.onFollowupModeChanged(event);
      case SessionEventType.SessionModeChanged:
        return this.onSessionModeChanged(event);
      case SessionEventType.TurnComplete:
        return this.onTurnComplete(event);
      case SessionEventType.TurnError:
        return this.onTurnError(event);
      case SessionEventType.CompactStarted:
      case SessionEventType.CompactCompleted:
      case SessionEventType.CompactFailed:
        return this.onCompactLifecycle(event);
      case SessionEventType.TargetChanged:
        return this.onTargetChanged(event);
      case SessionEventType.TargetCompletionVerification:
        return this.onTargetVerification(event);
      case SessionEventType.SessionForked:
        return this.onSessionForked(event);
      case SessionEventType.RewindTriggered:
        return this.onRewindTriggered(event);
      case SessionEventType.BackgroundTaskStarted:
      case SessionEventType.BackgroundTaskUpdated:
      case SessionEventType.BackgroundTaskCompleted:
        return this.onBackgroundTaskLifecycle(event);
      case SessionEventType.DynamicWorkflowRunProgress:
        return this.onDynamicWorkflowRunProgress(event);
      case SessionEventType.SubagentSpawned:
        return this.onSubagentSpawned(event);
      case SessionEventType.SubagentMessage:
        return this.onSubagentMessage(event);
      case SessionEventType.SubagentStopped:
        return this.onSubagentStopped(event);
      default:
        return [];
    }
  }

  /**
   * Runtime epoch 切换时收口遗留的 running session Hook：统一改 failed/cancelled 并
   * 补 endedAt/durationMs，防止旧 epoch 的 pending 调用挂到新 Runtime 的下一轮。
   * 同时淘汰旧 epoch 无法再解析的 workspaceHookReview 与 admission 提示。
   * 新 Runtime 会重新产生自己的 SessionStart 生命周期，这里不复活任何行。
   */
  /** A persisted started-only Hook cannot still be running after a real runtime resume. */
  // [事务] Runtime epoch 切换的收口点：旧 epoch 的 pending Hook 必须清空，
  // 否则会挂到新 Runtime 的下一轮。
  // 遗留 running session Hook 统一改 failed/cancelled 并补 endedAt/durationMs；
  // 新 Runtime 会重新产生自己的 SessionStart 生命周期，这里不复活任何行。
  // workspaceHookReview 与 admission 提示属于旧 Runtime controller，必须淘汰：
  // reviewFlowId/generation 只在单 controller 内单调，跨 epoch 后会冲突。
  // 只产 row.upserted 与 state.updated，不触碰 config/usage。
  private onSessionResumed(event: SessionEvent): ConversationDelta[] {
    const endedAt = this.ms(event);
    const deltas: ConversationDelta[] = [];
    // Runtime epoch 切换前尚未归位的 session Hook 不得附着到新 epoch 的下一轮；
    // 新 Runtime 会重新产生自己的 resume SessionStart lifecycle。
    this.pendingSessionHookInvocations.clear();
    for (const row of this.snapshot.rows.window) {
      if (row.kind !== "hookInvocation" || row.state !== "running") continue;
      const executions = row.executions.map(
        (execution): HookExecutionProjection =>
          execution.state === "running"
            ? {
                ...execution,
                state: "failed",
                outcome: "cancelled",
                endedAt,
                durationMs: Math.max(0, endedAt - execution.startedAt),
              }
            : execution,
      );
      deltas.push({
        op: "row.upserted",
        row: {
          ...row,
          state: "failed",
          executions,
          endedAt,
          durationMs: Math.max(0, endedAt - row.startedAt),
        },
      });
    }
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    );
    if (pendingInteractions.length !== this.snapshot.pendingInteractions.length) {
      // reviewFlowId/generation 只在单个 Runtime controller 内单调。
      // Runtime 重启后旧 Requested 会先被 replay，而新 flow 又从 generation=1 开始；
      // SessionResumed 是明确的新 Runtime epoch 边界，必须先淘汰旧 Runtime 无法再解析的审核。
      deltas.push({ op: "state.updated", patch: { pendingInteractions } });
    }
    // 软门禁:resume 后 activate 会重新上报 admission 状态。
    // epoch 清理时置 null,避免旧 Runtime 的提示条残留到新 Runtime 接管前。
    if (this.snapshot.workspaceHookAdmission !== null) {
      deltas.push({ op: "state.updated", patch: { workspaceHookAdmission: null } });
    }
    return deltas;
  }

  /**
   * Hook 调用生命周期（started/progress/completed/failed/blocked）→ hookInvocation 行。
   *
   * 行按 invocationId 去重；execution 以 kind 标识，pending session hook 需等
   * turnId 可解析后再 flush，避免归到 turn-unknown。blocked 会额外产出
   * hookBlockError 交互块；终态不允许被迟到的 progress 复活。
   */
  // [契约] Hook 生命周期 → hookInvocation 行；行按 invocationId 去重，execution 按
  // hookRunId 去重并用 hookIndex 排序。
  // 被 rewind 的 invocationId 直接忽略，防止迟到事件复活已删行。
  // 不可见（clientVisible=false）或 internal 来源的 Hook 在首次出现时就被丢弃；
  // 但有历史的行继续更新，避免中途改变可见性。
  // pending session Hook 等 turnId 可解析后 flush，不能落到 turn-unknown。
  // 终态不允许被迟到的 progress 复活：状态由事件类型决定，不由已有状态回退。
  private onHookRunLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as HookRunLifecyclePayload;
    const hookInvocationId = payload.hookInvocationId;
    const hookCount = payload.hookCount;
    if (
      !hookInvocationId ||
      !payload.hookRunId ||
      !Number.isInteger(hookCount) ||
      (hookCount ?? 0) <= 0 ||
      !Number.isInteger(payload.hookIndex) ||
      payload.hookIndex < 0
    ) {
      return [];
    }
    if (this.rewoundHookInvocationIds.has(hookInvocationId)) return [];

    const rowId = this.hookRowIdByInvocationId.get(hookInvocationId);
    const existing = rowId === undefined ? undefined : this.findRow(rowId);
    const existingRow = existing?.kind === "hookInvocation" ? existing : undefined;
    const pending = this.pendingSessionHookInvocations.get(hookInvocationId);
    const previousExecutions = existingRow?.executions ?? pending?.content.executions ?? [];
    const previousExecution = previousExecutions.find(
      (execution) => execution.hookRunId === payload.hookRunId,
    );
    const descriptor = payload.descriptor;
    if (
      !previousExecution &&
      (descriptor?.clientVisible !== true || descriptor.sourceKind === "internal")
    ) {
      return [];
    }
    const state = this.hookExecutionState(event.type);
    const startedAt =
      typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt)
        ? payload.startedAt
        : (previousExecution?.startedAt ?? this.ms(event));
    const endedAt = state === "running" ? undefined : this.ms(event);
    const durationMs =
      typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
        ? Math.max(0, payload.durationMs)
        : endedAt === undefined
          ? undefined
          : Math.max(0, endedAt - startedAt);
    const outcome = this.hookExecutionOutcome(event.type, payload.outcome);
    const didExecute =
      previousExecution?.didExecute === true || event.type === SessionEventType.HookRunStarted;
    const sourceKind = previousExecution?.sourceKind ?? descriptor?.sourceKind;
    if (sourceKind === undefined || sourceKind === "internal") return [];
    const blockReason = payload.blockReason ?? previousExecution?.blockReason;
    const execution: HookExecutionProjection = {
      hookRunId: String(payload.hookRunId),
      hookIndex: payload.hookIndex,
      didExecute,
      state,
      ...(outcome ? { outcome } : {}),
      ...(blockReason ? { blockReason } : {}),
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      displayName:
        previousExecution?.displayName ??
        (descriptor
          ? hookExecutionDisplayName(descriptor, payload.hookIndex)
          : `Hook #${payload.hookIndex + 1}`),
      sourceKind,
      ...(previousExecution?.pluginName || descriptor?.pluginName
        ? { pluginName: previousExecution?.pluginName ?? descriptor?.pluginName }
        : {}),
      ...(payload.toolName || previousExecution?.toolName
        ? { toolName: payload.toolName ?? previousExecution?.toolName }
        : {}),
    };
    const byRunId = new Map(
      previousExecutions.map((candidate) => [candidate.hookRunId, candidate]),
    );
    byRunId.set(execution.hookRunId, execution);
    const executions = [...byRunId.values()].toSorted(
      (left, right) => left.hookIndex - right.hookIndex,
    );
    const rowState = this.hookInvocationState(executions, hookCount as number);
    const invocationStartedAt = Math.min(...executions.map((candidate) => candidate.startedAt));
    const invocationEndedAt =
      rowState === "running"
        ? undefined
        : Math.max(...executions.map((candidate) => candidate.endedAt ?? candidate.startedAt));

    const content: HookInvocationRowContent = {
      kind: "hookInvocation",
      hookInvocationId,
      hookEventName: payload.hookEventName,
      hookCount: hookCount as number,
      state: rowState,
      startedAt: invocationStartedAt,
      ...(invocationEndedAt !== undefined
        ? {
            endedAt: invocationEndedAt,
            durationMs: Math.max(0, invocationEndedAt - invocationStartedAt),
          }
        : {}),
      lane: this.hookInvocationLane(payload.hookEventName),
      ...(payload.toolCallId ? { anchorToolCallId: String(payload.toolCallId) } : {}),
      executions,
    };

    if (existingRow) {
      const blockErrorDelta = this.hookBlockErrorDelta(event, payload, didExecute, blockReason);
      return [
        {
          op: "row.upserted",
          row: {
            ...existingRow,
            ...content,
          },
        },
        ...(blockErrorDelta ? [blockErrorDelta] : []),
      ];
    }

    if (
      pending ||
      !event.turnId ||
      // 维护 turn 排除只属于 SessionStart——首条输入即 /compact 时
      // SessionStart Hook 携带 compact turnId 到达，不能直挂，先入 pending 等
      // 真实 turn。model-only ≠ 维护 turn：background_task / subagent_message /
      // goal continuation 轮同样是 model-only，但它们是会真实跑工具的 agent 轮，
      // 其 PreToolUse/PostToolUse/Stop 必须按 event.turnId 直挂原轮（与 cold
      // merge 归属对齐），否则会被 pending 吞掉、错误堆到下一个用户轮。
      (payload.hookEventName === "SessionStart" &&
        (this.currentTurnId === null || this.currentTurnStartedModelOnly))
    ) {
      // startup SessionStart 虽可能已经携带 runtime turnId，但此时 TurnStarted 尚未建立
      // runtimeTurnId -> productTurnId 映射；提前 append 会把它拆成独立 footer。
      this.pendingSessionHookInvocations.set(hookInvocationId, {
        firstEvent: pending?.firstEvent ?? event,
        content,
      });
      return [];
    }

    const turnId = this.turnIdOf(event);
    const rowBase = this.rowBase(event, turnId, hookInvocationId);
    const row: HookInvocationRow = {
      ...rowBase,
      ...content,
    };
    this.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
    const blockErrorDelta = this.hookBlockErrorDelta(event, payload, didExecute, blockReason);
    return [{ op: "row.appended", row }, ...(blockErrorDelta ? [blockErrorDelta] : [])];
  }

  /**
   * UserPromptSubmit 的 executed block 是当前输入的可见错误，但不是 task 失败。
   * 将它投影到 transient lastError，让 ChatErrorBanner 直接展示原因；下一轮 TurnStarted
   * 会按既有生命周期清理它。admission-only block 和工具边界 block 仍只保留在 Hook 摘要。
   */
  /**
   * UserPromptSubmit 的已执行 block → transient lastError（state.updated），
   * 让 ChatErrorBanner 直接展示当前输入被拒的原因；下一轮 TurnStarted 会清理。
   * 只对 UserPromptSubmit + didExecute + 有 blockReason 生效，其余返回 null；
   * admission-only block 与工具边界 block 不在此升级，只留在 Hook 摘要。
   */
  // [契约] 只把 UserPromptSubmit 的「已执行 block」升级为 lastError；
  // admission-only block 与工具边界 block 仍只保留在 Hook 摘要。
  // 必须同时满足：HookRunBlocked + UserPromptSubmit + didExecute + 有 blockReason。
  // 错误 message 前缀固定为 hooks_prompt_block，UI 据此归类并展示原因。
  // detail 拼接 block 原因与可选诊断，不包含完整 stdout/stderr 以免泄漏。
  // 该 lastError 是 transient：下一轮 TurnStarted 会按既有生命周期清理。
  private hookBlockErrorDelta(
    event: SessionEvent,
    payload: HookRunLifecyclePayload,
    didExecute: boolean,
    blockReason: string | undefined,
  ): ConversationDelta | null {
    if (
      event.type !== SessionEventType.HookRunBlocked ||
      payload.hookEventName !== "UserPromptSubmit" ||
      !didExecute ||
      !blockReason
    ) {
      return null;
    }
    const diagnosticMessage = [payload.stderrPreview, payload.errorMessage, payload.stdoutPreview]
      .map((value) => value?.trim())
      .find((value) => value && value !== blockReason);
    const displayReason = diagnosticMessage ?? blockReason;
    const message =
      displayReason === USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
        ? USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
        : `${USER_PROMPT_HOOK_BLOCK_ERROR_TYPE}: ${displayReason}`;
    const detail = [
      `Hook block reason: ${blockReason}`,
      ...(diagnosticMessage ? [`Hook error: ${diagnosticMessage}`] : []),
    ].join("\n");
    return {
      op: "state.updated",
      patch: this.controlPatch({
        lastError: {
          code: "fault.runtime.hookBlocked",
          message,
          recoverable: false,
          at: this.ms(event),
          source: "runtime",
          traceId: String(event.traceId),
          ...(detail ? { detail } : {}),
          attribution: {
            source: "runtime",
            reason: "hook_blocked",
          },
        },
      }),
    };
  }

  /**
   * 把等待 turnId 的 session Hook 调用归位：turnId 可解析后，为其产出 hookInvocation
   * 行（或挂到既有行）并清空 pending 表。避免 SessionStart 等事件落到 turn-unknown。
   * 只消费内部 pending 队列，不重复处理已归位调用。
   */
  // [事务] 把等待 turnId 的 session Hook 一次性归位到给定 product turn，
  // 然后清空 pending 表，避免重复 append。
  // 使用 pending.firstEvent 的 rowBase，保留原始时间戳与 seq 锚点。
  // 只在真实 user-visible turn 建立后调用；model-only 维护轮不触发。
  // 该函数不做 visible/sourceKind 过滤，过滤已在入队时完成。
  private flushPendingSessionHookInvocations(turnId: string): ConversationDelta[] {
    if (this.pendingSessionHookInvocations.size === 0) return [];
    const deltas: ConversationDelta[] = [];
    for (const [hookInvocationId, pending] of this.pendingSessionHookInvocations) {
      const row: HookInvocationRow = {
        ...this.rowBase(pending.firstEvent, turnId, hookInvocationId),
        ...pending.content,
      };
      this.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
      deltas.push({ op: "row.appended", row });
    }
    this.pendingSessionHookInvocations.clear();
    return deltas;
  }

  private hookExecutionState(eventType: SessionEvent["type"]): HookExecutionProjection["state"] {
    if (eventType === SessionEventType.HookRunFailed) return "failed";
    if (
      eventType === SessionEventType.HookRunCompleted ||
      eventType === SessionEventType.HookRunBlocked
    ) {
      return "completed";
    }
    return "running";
  }

  private hookExecutionOutcome(
    eventType: SessionEvent["type"],
    outcome: HookRunLifecyclePayload["outcome"],
  ): HookExecutionProjection["outcome"] {
    if (outcome) return outcome;
    if (eventType === SessionEventType.HookRunCompleted) return "success";
    if (eventType === SessionEventType.HookRunBlocked) return "blocked";
    if (eventType === SessionEventType.HookRunFailed) return "failed";
    return undefined;
  }

  // [契约] 行级状态由执行数推导：execution 少于 hookCount 或有 running → running；
  // 否则任一 failed → failed，其余 completed。
  // hookCount 是权威总数，不能用 executions.length 替代：Hook 可能被跳过而不发事件。
  // 该推导保证行终态不会先于最后一个 execution 落地。
  private hookInvocationState(
    executions: readonly HookExecutionProjection[],
    hookCount: number,
  ): HookInvocationRow["state"] {
    if (
      executions.length < hookCount ||
      executions.some((execution) => execution.state === "running")
    ) {
      return "running";
    }
    return executions.some((execution) => execution.state === "failed") ? "failed" : "completed";
  }

  private hookInvocationLane(
    eventName: HookRunLifecyclePayload["hookEventName"],
  ): HookInvocationRow["lane"] {
    if (eventName === "PreToolUse" || eventName === "PermissionRequest") return "toolBefore";
    if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "toolAfter";
    return "assistantWork";
  }

  /**
   * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
   * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
   * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
   * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
   * 由 transcript 合成 hydration 兜底重建。
   * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
   */
  /**
   * 处理 rewind/edit/retry 的 live 截断：RewindTriggered 带 targetMessageId → 反查 rowId →
   * 从该行所属 product turn 的首行（turnHeader，取较小 rowId）起整段 row.removed，
   * 因此锚点行与整个目标轮都会被移除，而不是只删其后行。
   *
   * 同时清理与 fromRowId 之后的 messageId/entity/tool/hook/continuation 索引；
   * 被删 hook 的 invocationId 记入 rewoundHookInvocationIds，防止迟到事件把行补回。
   * workspace/file_summary_rewind 是例外：不删行，只把该轮 fileChanges 标 reverted。
   * 反查不到 messageId / 无已提交 branchGeneration 时返回空，由冷恢复 hydration 兜底；
   * 截断点只认 branchGeneration 与 messageId，缺失时整轮交给冷恢复重建。
   */
  // [事务] live 截断：targetMessageId → rowId → 从该轮 turnHeader 起整段 row.removed。
  // 同时清理 fromRowId 之后的 messageId/entity/editTarget/tool 索引，避免悬挂映射。
  // 被删 hook 的 invocationId 记入墓碑，防止迟到 terminal 补回行。
  // workspace/file_summary_rewind 是例外：不删行，只把该轮 fileChanges 标 reverted。
  // 反查不到 messageId 或无已提交 branchGeneration 时返回空，由冷恢复 hydration 兜底；
  // 因此 onRewindTriggered 不发明本地补丁：缺 messageId 时宁可交空数组，也不按相邻行猜截断点。
  private onRewindTriggered(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      targetMessageId?: string;
      scope?: string;
      branchCutAfterMessageId?: string;
      branchGeneration?: number;
      createdMessageId?: string;
      reason?: string;
    };
    if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
      const targetMessageId = payload.targetMessageId;
      if (!targetMessageId) return [];
      const targetRowId = this.rowIdForMessageId(targetMessageId);
      if (targetRowId === null) return [];
      const targetRow = this.findRow(targetRowId);
      if (!targetRow) return [];
      const headerRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId);
      const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
      if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
      return [
        {
          op: "row.upserted",
          row: {
            ...headerRow,
            fileChanges: {
              ...headerRow.fileChanges,
              state: "reverted",
            },
          },
        },
      ];
    }
    // 新语义只消费带 branchGeneration/cut 的已提交 conversation rewind；createdMessageId
    // 仅兼容旧 transcript。失败/冲突不发事件，因此不会制造 UI 假截断。
    const applied =
      (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
      payload.createdMessageId !== undefined;
    if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = this.rowIdForMessageId(targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = this.findRow(targetRowId);
    if (!targetRow) return [];
    // 从该行所属 turn 的首行起移除（整段 turn 被 rewind/edit/retry 替换）。
    const turnHeaderRowId = this.turnHeaderRowIdByTurnId.get(targetRow.turnId) ?? targetRowId;
    const fromRowId = Math.min(turnHeaderRowId, targetRowId);
    // 清理被移除行的 messageId/tool 索引，避免悬挂映射。
    for (const [rowId] of this.messageIdByRowId) {
      if (rowId >= fromRowId) this.messageIdByRowId.delete(rowId);
    }
    for (const [messageId, rowId] of this.outputContinuationRowIdByMessageId) {
      if (rowId >= fromRowId) this.outputContinuationRowIdByMessageId.delete(messageId);
    }
    for (const [rowId, entityId] of this.entityIdByRowId) {
      if (rowId >= fromRowId) {
        this.entityIdByRowId.delete(rowId);
        this.editTargetByEntityId.delete(entityId);
      }
    }
    for (const [hookInvocationId, rowId] of this.hookRowIdByInvocationId) {
      if (rowId >= fromRowId) {
        this.rewoundHookInvocationIds.add(hookInvocationId);
        this.hookRowIdByInvocationId.delete(hookInvocationId);
      }
    }
    return [{ op: "row.removed", fromRowId }];
  }

  /** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */
  // [契约] 先查 Continue 别名表，再做线性反查；行数有界，无需额外索引。
  // 别名优先保证旧 partial messageId 能命中复用后的 row。
  // 找不到返回 null，调用方必须放弃操作，不得按位置猜测。
  private rowIdForMessageId(messageId: string): number | null {
    const continuationRowId = this.outputContinuationRowIdByMessageId.get(messageId);
    if (continuationRowId !== undefined) return continuationRowId;
    for (const [rowId, mid] of this.messageIdByRowId) {
      if (mid === messageId) return rowId;
    }
    return null;
  }

  /**
   * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
   * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
   * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
   */
  /**
   * 解析文件回滚锚点：从该行向前查找第一个带 messageId 的行，返回其权威 messageId。
   * 供 rewind 命令确定截断边界；找不到时返回 null，命令层据此拒绝而非猜测位置。
   * 只读 snapshot，不产 delta。
   */
  // [契约] 从该行所属 turn 内取第一个带 messageId 的行作为截断边界；
  // 同 turn assistant 的 messageId 只作为旧事件兼容 fallback。
  // canEdit 不得依赖该 fallback：必须由 user row 自身的 exact target 驱动。
  // 找不到返回 null，命令层据此拒绝，而不是猜测位置。
  getTurnRewindAnchor(rowId: number): string | null {
    return this.rewindAnchorForRows(this.snapshot.rows.window, rowId);
  }

  private rewindAnchorForRows(rows: readonly ConversationRow[], rowId: number): string | null {
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (!row) return null;
    const turnId = row.turnId;
    for (const [candidateRowId, messageId] of this.messageIdByRowId) {
      const candidate = rows.find((item) => item.rowId === candidateRowId);
      if (candidate && candidate.turnId === turnId) return messageId;
    }
    return null;
  }

  /**
   * real-user row 的展示身份与命令身份必须原子登记。
   * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
   * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
   */
  // [契约] real-user row 的展示身份与命令身份必须原子登记：entityId、messageId、
  // editTarget 三者缺一都会造成 UI 与 resolver 结论相反。
  // 没有 editTarget 时只登记 entityId，不写空的 messageId 映射。
  // TurnSteerDrained 曾漏写 edit target，导致可编辑入口与提交校验不一致——
  // 任何新路径都必须复用本方法，而不是分别 set 三张表。
  private registerCanonicalUserRowTarget(
    rowId: number,
    entityId: string,
    editTarget?: ConversationEditTarget,
  ): void {
    this.entityIdByRowId.set(rowId, entityId);
    if (!editTarget) return;
    this.messageIdByRowId.set(rowId, editTarget.transcriptMessageId);
    this.editTargetByEntityId.set(entityId, editTarget);
  }

  // ── 生命周期 ──

  /**
   * SessionCreated 刻意不产可见 delta：新会话仍是 draft，不伪造一轮对话。
   * 仅把 payload.contextWindow 记入内部容量状态（供后续 usage 展示分母），
   * 不触碰 rows/usage/revision；缺省时置 null 表示容量未知。
   */
  // [契约] 刻意不产可见 delta：新会话仍是 draft，不伪造一轮对话。
  // 只把 payload.contextWindow 记入内部容量状态，供后续 usage 展示分母；
  // 缺省置 null 表示容量未知。
  // 不触碰 rows/usage/revision，也不设置 phase：draft 语义由 snapshot 初值表达。
  private onSessionCreated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { contextWindow?: number };
    this.contextWindowState.maxTokens = payload.contextWindow ?? null;
    // draft 语义：会话实体已存在、无 row；phase 保持 draft，无可见 delta。
    return [];
  }

  // renameSession / 自动标题：SessionTitleUpdated(title, source) → 更新 meta。
  // custom（用户重命名）优先级最高，已 custom 后不再被 generated 覆盖（与 core titleSource 一致）。
  /**
   * 会话标题更新：只 patch meta.title/titleSource，属于 A 区状态变化（revision +1）。
   * titleSource 归一为 default/generated/custom（first_input 并入 generated）；
   * 用户显式 custom 后不再被自动 generated 覆盖，值未变则幂等返回空。
   * 不改变任何 row 的内容与顺序。
   */
  // [契约] 只 patch meta.title/titleSource，属于 A 区状态变化（revision +1）。
  // titleSource 归一为 default/generated/custom：first_input 并入 generated，
  // 因为二者都属「非用户显式」。
  // 已 custom 后不再被 generated 覆盖，与 core titleSource 语义一致。
  // 值未变时返回空，保持幂等；不修改任何 row 的内容与顺序。
  private onSessionTitleUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      title?: string;
      source?: string;
    };
    const title = payload.title ?? "";
    // core 的 titleSource 有 4 值（default/first_input/generated/custom）；投影 meta 归一为
    // default/generated/custom（first_input 归入 generated：都属"非用户显式"）。
    const source: "default" | "generated" | "custom" =
      payload.source === "custom"
        ? "custom"
        : payload.source === "default"
          ? "default"
          : "generated";
    const prev = this.snapshot.meta;
    if (prev.titleSource === "custom" && source === "generated") return [];
    if (prev.title === title && prev.titleSource === source) return [];
    return [
      {
        op: "state.updated",
        patch: { meta: { title, titleSource: source } },
      },
    ];
  }

  /**
   * 新一轮开始：确定产品 turnId/transcript 映射，创建 turnHeader 与 userInput 行，
   * 推进 phase/control，转移或清空 queue，并登记 edit target。
   *
   * 输入是 canonical user intent fact（已归一化来源/附件/模型/模式），不是 raw payload。
   * 合成来源（background/goal/subagent/plugin）不产生 realUser 可编辑目标；
   * model-only turn 跳过 userInput 行，但仍保留可回滚的 transport message 锚点。
   * 副作用：重置流式游标、当前轮字段；产出以 row.appended 为主。
   */
  // [事务] 新一轮的建轮点：确定 product/transcript 映射、重置流式游标、
  // 创建 turnHeader 与（可见时）userInput row，并登记 edit target。
  // 输入是 canonical user intent fact，不是 raw payload：身份字段已由 normalize 裁决。
  // model-only 轮跳过 userInput row，但仍保留可回滚的 transport 锚点。
  // modelChange marker 必须在 turnHeader 之前落盘，且只按实际身份差异生成；
  // 不能在 onModelSelected 里生成，否则草稿态切模型会挂出 marker。
  // 稿态离开与 control 推进由 executionKind 分支控制：controlOnly 不写 session control。
  private onTurnStarted(fact: CanonicalUserIntentFact): ConversationDelta[] {
    const event = fact.event;
    const runtimeTurnId = fact.runtimeTurnId;
    const turnId = fact.productTurnId;
    this.currentTurnId = runtimeTurnId;
    this.currentTurnStartedModelOnly = fact.visibility === "modelOnly";
    // 新 runtimeTurn：product turn 映射归零（1:1），工时基准 = 本轮起点。
    this.productTurnIdByRuntimeTurnId.delete(runtimeTurnId);
    if (turnId !== runtimeTurnId) this.productTurnIdByRuntimeTurnId.set(runtimeTurnId, turnId);
    this.runtimeTurnIdByProductTurnId.set(turnId, runtimeTurnId);
    this.productTurnSplitOrdinalByRuntimeTurnId.delete(runtimeTurnId);
    this.currentProductTurnStartedAtMs = this.ms(event);
    this.streamingTextRowId = null;
    this.streamingReasoningRowId = null;
    this.outputContinuationTextRowId = null;

    // background Agent 的 ToolCallResult 只是 launch ACK，先把工具行收口成
    // success；子 Agent 的真实终态随后只作为 model-only task-notification 开新轮。
    // V4 过去没有按 tool-use-id 消费这条权威事实，因此 429 后卡片会永久停在 completed。
    const deltas: ConversationDelta[] = this.applyBackgroundTaskNotification(fact);
    const sharedContextRef = fact.sharedContextRefs?.[0];
    if (
      sharedContextRef &&
      this.snapshot.sharedContextImport &&
      "contextId" in this.snapshot.sharedContextImport &&
      this.snapshot.sharedContextImport.contextId === sharedContextRef.context_id &&
      (this.snapshot.sharedContextImport.status === "pending" ||
        this.snapshot.sharedContextImport.status === "reserved")
    ) {
      const sharedContextImport = {
        ...this.snapshot.sharedContextImport,
        status: "attached" as const,
      };
      this.snapshot = { ...this.snapshot, sharedContextImport };
      deltas.push({ op: "state.updated", patch: { sharedContextImport } });
    }
    // marker 时机：只有当
    // 本轮实际使用的 provider/model 身份与上一轮不同时，才在 turnHeader 之前落
    // modelChange marker。普通首轮 silentInitial 不产 marker；显式 sourceLess 边界
    // 生成“正在使用”marker。思考深度变化只更新 config.thought，不是模型身份变化。
    // Bug 背景：旧实现在 onModelSelected（切换动作时）即落 marker，草稿态预热会话
    // 切一次模型就会在首条消息上方挂出 [modelChange]。
    const config = this.snapshot.config;
    const hasModel = config.provider !== "" && config.model !== "";
    if (hasModel && this.lastTurnModel.kind === "sourceLess") {
      deltas.push({
        op: "row.appended",
        row: {
          ...this.rowBase(
            event,
            turnId,
            `model-initial:${turnId}:${config.provider}/${config.model}`,
          ),
          kind: "timelineMarker",
          lane: "lightBoundary",
          marker: {
            type: "modelChange",
            toProvider: config.provider,
            toModel: config.model,
            toThought: config.thought,
          },
        },
      });
    } else if (
      hasModel &&
      this.lastTurnModel.kind === "known" &&
      (this.lastTurnModel.provider !== config.provider || this.lastTurnModel.model !== config.model)
    ) {
      deltas.push({
        op: "row.appended",
        row: {
          ...this.rowBase(
            event,
            turnId,
            `model-change:${turnId}:${this.lastTurnModel.provider}/${this.lastTurnModel.model}->${config.provider}/${config.model}`,
          ),
          kind: "timelineMarker",
          // lane 由投影裁决（UI 不得按 marker type 自行推断落位语义）。
          lane: "lightBoundary",
          marker: {
            type: "modelChange",
            fromProvider: this.lastTurnModel.provider,
            fromModel: this.lastTurnModel.model,
            toProvider: config.provider,
            toModel: config.model,
            toThought: config.thought,
          },
        },
      });
    }
    if (hasModel) {
      this.lastTurnModel = {
        kind: "known",
        provider: config.provider,
        model: config.model,
        thought: config.thought,
      };
    }
    const headerBase = this.rowBase(event, turnId, turnId);
    const header: TurnHeaderRow = {
      ...headerBase,
      kind: "turnHeader",
      origin: fact.turnHeaderOrigin,
      executionKind: fact.executionKind,
      ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
      ...(fact.originMeta ? { originMeta: fact.originMeta } : {}),
      ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
      state: "running",
      startedAt: headerBase.createdAt,
    };
    this.turnHeaderRowIdByTurnId.set(turnId, header.rowId);
    deltas.push({ op: "row.appended", row: header });

    // model-only 输入（goal continuation 等）不产生可见 userInput row。
    if (fact.visibility === "visible") {
      const rowBase = this.rowBase(event, turnId, fact.entityId);
      const rootSourceCommandId = fact.provenance?.sourceCommandId ?? fact.sourceCommandId;
      const attachments = fact.attachments?.map((attachment, index) => ({
        ...attachment,
        ref: attachment.ref ?? `turn-attachment/${rowBase.rowId}/${index}`,
      }));
      const row: UserInputRow = {
        ...rowBase,
        kind: "userInput",
        text:
          fact.conversationQuotes || fact.botGroupSource
            ? (fact.intentText ?? fact.input)
            : fact.input,
        origin: fact.origin,
        ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
        ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
        ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
        ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
        ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
        ...(fact.clientId ? { clientId: fact.clientId } : {}),
        ...(fact.highspeed ? { highspeed: fact.highspeed } : {}),
        ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
        ...(fact.epilogueStart === undefined ? {} : { epilogueStart: fact.epilogueStart }),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(fact.source ? { source: fact.source } : {}),
      };
      // workspace checkpoint 以 user messageId 为 targetMessageId。
      // 普通 TurnStarted 也要登记 userInput row 的内部锚点，否则文件摘要 query
      // 只能找到 assistant messageId，展开列表会查不到该轮 checkpoint。
      this.registerCanonicalUserRowTarget(
        row.rowId,
        fact.entityId,
        fact.transcriptMessageId
          ? {
              entityId: fact.entityId,
              productTurnId: fact.productTurnId,
              transcriptMessageId: fact.transcriptMessageId,
              coveredByStableCompact: false,
              intent: {
                kind: fact.intentKind,
                text: fact.intentText,
                ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
                ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
                ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
                ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
                ...(fact.clientId ? { clientId: fact.clientId } : {}),
                ...(fact.attachments ? { attachments: fact.attachments } : {}),
                ...(fact.queueItemId ? { queueItemId: fact.queueItemId } : {}),
                ...(fact.admissionSeq !== undefined ? { admissionSeq: fact.admissionSeq } : {}),
                ...(fact.admittedAt !== undefined ? { admittedAt: fact.admittedAt } : {}),
                ...(fact.requestedDelivery ? { requestedDelivery: fact.requestedDelivery } : {}),
                ...(fact.admittedDelivery ? { admittedDelivery: fact.admittedDelivery } : {}),
                ...(fact.fallbackReasonCode ? { fallbackReasonCode: fact.fallbackReasonCode } : {}),
                ...(fact.modelSelection ? { modelSelection: fact.modelSelection } : {}),
                ...(fact.mode ? { mode: fact.mode } : {}),
                ...(fact.planEnabled !== undefined ? { planEnabled: fact.planEnabled } : {}),
                ...(fact.provenance ? { provenance: fact.provenance } : {}),
              },
            }
          : undefined,
      );
      deltas.push({
        op: "row.appended",
        row,
      });
    }

    if (fact.executionKind === "agent") {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          phase: "running",
          sessionEnded: false,
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: "assistant",
          activeWorks: [
            {
              kind: fact.origin === "goalContinuation" ? "goalContinuation" : "primaryTurn",
              ...(fact.foregroundExecutionId
                ? { foregroundExecutionId: fact.foregroundExecutionId }
                : {}),
              // 自动中断必须关联实际执行输入，不能由客户端按最后一条消息猜测。
              ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
              startedAt: this.ms(event),
            },
          ],
          // 新一轮被接受后，旧错误不再是当前事实（与旧 reducer 同一裁决）。
          lastError: null,
          apiRetry: null,
        }),
      });
    }
    // /goal 的可见 query 用 controlOnly turn 建立 live 时间线身份，
    // 但真实执行属于紧随其后的 goalContinuation。若控制轮也推进 running，连续链路
    // 会短暂生成第二份 activeWorks，恢复投影也会出现伪造的工作生命周期。
    return deltas;
  }

  /**
   * 后台任务通知文本（`<task-notification>`）不是用户输入：解析出 toolUseId/status 后
   * 直接收口对应既有 tool row，不创建 turnHeader/userInput。
   * 解析失败或找不到行则忽略（迟到通知不能凭空造行）；failed→error、stopped→cancelled、
   * 其余→success，并补 endedAt/output/error。只产 row.upserted。
   */
  // [契约] 后台任务通知不是用户输入：解析 toolUseId/status 后直接收口既有 tool row，
  // 不创建 turnHeader/userInput。
  // 解析失败或找不到行时忽略：迟到通知不能凭空造行。
  // 状态映射 failed→error、stopped→cancelled、其余→success，并补 endedAt/payload。
  // 只有 error 写 next.error，其他状态必须 delete 旧 error，避免残留失败标记。
  private applyBackgroundTaskNotification(fact: CanonicalUserIntentFact): ConversationDelta[] {
    const parsed = parseZCodeBackgroundTaskNotificationText(fact.input);
    if (!parsed) return [];
    const row = this.findToolRow(parsed.toolUseId);
    if (!row) return [];

    const notificationStatus = zcodeBackgroundTaskNotificationToolUpdateStatus(
      parsed.notification.status,
    );
    const status: ToolCallRow["status"] =
      notificationStatus === "failed"
        ? "error"
        : notificationStatus === "stopped"
          ? "cancelled"
          : "success";
    const content =
      parsed.notification.result ?? parsed.notification.summary ?? parsed.notification.error;
    const next: ToolCallRow = {
      ...row,
      status,
      ...(content
        ? {
            output: buildToolOutput({ success: status === "success", content }, parsed.toolUseId),
          }
        : {}),
      endedAt: this.ms(fact.event),
    };
    if (status === "error") {
      next.error = {
        code: "fault.runtime.backgroundTaskFailed",
        message: parsed.notification.error ?? content ?? "Background task failed.",
      };
    } else {
      delete next.error;
    }
    return [{ op: "row.upserted", row: next }];
  }

  /**
   * 轮次成功/取消/失败的统一收口。
   *
   * 顺序：关流式行（success=complete，其余=interrupted）→ 收口在飞 foreground tool →
   * upsert turnHeader（补 activeMs/historyRoundCount/highspeed）→ 成功轮标记稳定 fork
   * 锚点 → state.updated 推进 phase/activeWorks/apiRetry/lastError，并按裁决处理
   * goal（cancelled 时 active/verifying → paused）与 queue（cancelled 且保留策略未置位
   * 时 autoDrain=false + pauseReason=stopped）。
   * controlOnly 轮不碰 session control，只收口可见轮次与 draft 离场。
   */
  // [事务] 轮次终态的统一收口，顺序不可交换：
  // 关流式行 → 收口在飞 foreground tool → upsert turnHeader → 成功轮标记 fork 锚点 →
  // state.updated 推进 phase/activeWorks/apiRetry/lastError。
  // cancelled 时 active/verifying goal 置 paused；queue 原样保留并关闭 autoDrain，
  // pauseReason=stopped 只用于 UI 解释，不参与路由裁决。
  // controlOnly 轮只收口可见轮次与 draft 离场，绝不写 session control。
  // 收口后必须复位 currentTurnId 与 currentTurnStartedModelOnly，避免下一轮归属错误。
  private onTurnComplete(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnCompletePayload;
    this.outputContinuationTextRowId = null;
    const headerState = mapTurnResultToHeaderState(payload.resultType);
    const header = this.turnHeaderForEvent(event);
    if (header?.executionKind === "controlOnly") {
      // controlOnly 没有 Agent 工时；尤其不能把 duration=0 下发给旧 UI，后者会为了
      // 可读性把 0 秒格式化成“已工作 1 秒”。这里只收口可见轮次，不碰 session control——
      // 除了 draft 的离场（见 leaveDraftAfterControlOnlyTurn）。
      const deltas = [
        ...this.upsertTurnHeader(event, headerState, undefined, payload.historyRoundCount),
        ...this.leaveDraftAfterControlOnlyTurn(
          payload.resultType === "success" ? "completedSuccess" : "completedInterrupted",
        ),
      ];
      this.currentTurnId = null;
      // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
      this.currentTurnStartedModelOnly = false;
      return deltas;
    }
    const phase: SessionControl["phase"] =
      payload.resultType === "success"
        ? "completedSuccess"
        : payload.resultType === "cancelled"
          ? "completedInterrupted"
          : "error";
    const streamClose = payload.resultType === "success" ? "complete" : "interrupted";
    const activeMs = this.activeMsForCompletion(event, payload.duration);

    // stopPausesActiveGoalTarget：stop 作用于任何 foreground work 时，
    // active/verifying 的 goal 强制进入 paused，等待显式 resumeGoal。
    const goal = this.snapshot.goal;
    const pausedGoal: GoalState | undefined =
      payload.resultType === "cancelled" &&
      (goal?.status === "active" || goal?.status === "verifying")
        ? { ...goal, status: "paused" }
        : undefined;

    // stopKeepsQueueAndDisablesAutoDrain（stop 效果）：中断后 queue 原样保留
    // 且不自动消费 → 形成暂停队列；pauseReason 只用于 UI 解释原因，不参与路由裁决。
    const heldQueue =
      payload.resultType === "cancelled" &&
      payload.preserveQueueAutoDrainOnCancel !== true &&
      this.snapshot.queue.items.length > 0 &&
      (this.snapshot.queue.autoDrain || this.snapshot.queue.pauseReason !== "stopped")
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "stopped" as const,
          }
        : undefined;

    const deltas: ConversationDelta[] = [
      ...this.closeStreamingRows(streamClose),
      // turn 终态一并收口在飞的 foreground tool row（收口不变量：被 profile
      // 过滤的 inputText 流必须被不可过滤的 row.upserted 蕴含，见 profiles.ts）。
      ...this.closeOpenToolRows(event, payload.resultType === "cancelled" ? "cancelled" : "error"),
      ...this.upsertTurnHeader(
        event,
        headerState,
        activeMs,
        payload.historyRoundCount,
        this.highspeedTimingForTurn(this.turnIdOf(event), activeMs),
      ),
      ...(payload.resultType === "success" ? this.markStableForkAssistant(event) : []),
      {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase,
            sessionEnded: phase !== "error",
            canStop: false,
            stopState: "idle",
            stopTargetKind: "unknown",
            activeWorks: [],
            // 旧 V4 reducer 没有消费 ModelNetworkStatus，补投影后若 turn
            // 直接进入终态仍不清理，会让“重新连接中”残留到下一轮。
            apiRetry: null,
          },
          pausedGoal,
          heldQueue,
        ),
      },
    ];
    this.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    this.currentTurnStartedModelOnly = false;
    return deltas;
  }

  /**
   * draft 只有一种离场方式：第一轮收口。phase `draft` 的定义是「纯内存、从未有过真实内容、CLI 重启即
   * 消失」；一条 controlOnly 轮一旦收口，会话已有一段持久化的可见历史，再叫 draft 就与
   * 冷恢复矛盾——store 种子会给它一个终态 phase，而活投影却停在 draft。中枢直接启动
   * 的会话只有一条 controlOnly 启动轮，活投影 phase 恒为 draft，sessions-index 摘要因此被 task-index
   * syncer 当 draft 丢弃，侧栏要等重启才出现。所以 controlOnly 收口只在**会话仍是 draft**时推进 phase
   * （成功 → completedSuccess，取消 → completedInterrupted，失败 → error）；非 draft 会话上的控制轮
   * 照旧不碰 session control（goal 的可见 query 轮不得伪造 running / 工时，见 onTurnStarted）。
   */
  private leaveDraftAfterControlOnlyTurn(
    phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
  ): ConversationDelta[] {
    if (this.snapshot.control.phase !== "draft") return [];
    return [
      {
        op: "state.updated",
        patch: this.controlPatch({
          phase,
          sessionEnded: phase !== "error",
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
        }),
      },
    ];
  }

  /**
   * TurnError 收口：关流式/工具行、turnHeader=failed、phase=error、lastError 透传
   * provider/network 归因（不再一律 runtime），并清理 apiRetry。
   * 结束的是当前 turn 而非已 accepted 的 future input：现有 queue 原样转
   * error-paused（autoDrain=false），等显式恢复，避免旧逻辑先 Discard 造成用户消息丢失。
   * controlOnly 错误同样只走 draft 离场，不伪造会话级错误。
   */
  private onTurnError(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnErrorPayload;
    this.outputContinuationTextRowId = null;
    if (this.turnHeaderForEvent(event)?.executionKind === "controlOnly") {
      const deltas = [
        ...this.upsertTurnHeader(event, "failed"),
        ...this.leaveDraftAfterControlOnlyTurn("error"),
      ];
      this.currentTurnId = null;
      // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
      this.currentTurnStartedModelOnly = false;
      return deltas;
    }
    // TurnError 结束的是当前 turn，
    // 不是已经 accepted 的 future input。旧 reducer 没有 terminal queue patch，core 为了
    // 防止 error 后悬挂只能先发 TurnSteerDiscarded，造成用户消息丢失；现在把现有 queue
    // 原样转成 error-paused，等待显式 setAutoDrain(true) 恢复 FIFO。
    const heldQueue =
      this.snapshot.queue.items.length > 0
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "error" as const,
          }
        : undefined;
    return [
      ...this.closeStreamingRows("interrupted"),
      ...this.closeOpenToolRows(event, "error"),
      ...this.upsertTurnHeader(
        event,
        "failed",
        undefined,
        undefined,
        this.highspeedTimingForTurn(this.turnIdOf(event)),
      ),
      {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: "error",
            sessionEnded: false,
            canStop: false,
            stopState: "idle",
            stopTargetKind: "unknown",
            activeWorks: [],
            // 事件侧尚未携带 fault.* 分类，先透传错误类型，待补齐分类后再细化映射。
            lastError: {
              code: payload.error.code ?? payload.error.type ?? "fault.runtime.unknown",
              message: payload.error.message,
              recoverable: payload.error.retryable ?? LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
              at: this.ms(event),
              // 旧投影把所有 TurnError 都写成 runtime，丢失 adapter 已识别的 provider/network 事实。
              source: payload.error.attribution?.source ?? "runtime",
              traceId: String(event.traceId),
              ...(payload.error.detail ? { detail: payload.error.detail } : {}),
              ...(payload.error.underlyingErrorMessage
                ? { underlyingErrorMessage: payload.error.underlyingErrorMessage }
                : {}),
              ...(payload.error.underlyingErrorDetail
                ? { underlyingErrorDetail: payload.error.underlyingErrorDetail }
                : {}),
              ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
            },
            // 同 onTurnComplete：终态是重试生命周期的兜底清理边界。
            apiRetry: null,
          },
          undefined,
          heldQueue,
        ),
      },
    ];
  }

  // ── 流式输出 ──

  /**
   * 模型网络/重试状态 → A 区 apiRetry。
   *
   * 只有 active turn 的事件被接受（acceptsActiveModelEvent），否则丢弃，避免迟到
   * 状态污染下一轮。model_retry_scheduled 建重试倒计时；stream_recovery 复用重连
   * 原因码；completed 清理；retryable 的 failed 保持现状等后续进展，防止标签闪退。
   * 同时顺带累计 highspeed modelDurationMs，普通 provider 的超时不得计入。
   */
  private onModelNetworkStatus(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as ModelNetworkStatusPayload;
    if (
      (payload.querySource === undefined || payload.querySource === "main_turn") &&
      (payload.type === "model_request_completed" || payload.type === "model_request_failed") &&
      // 加速卡按 family 拆成了多个隐藏 Provider（zai/bigmodel），不能再和单个常量比较，
      // 否则 BigModel 账号的加速轮会被判成普通轮、节省时间恒为 0。
      isHighspeedProviderId(payload.providerId) &&
      payload.durationMs !== undefined
    ) {
      // Bug 根因：混合 Turn 卡过期后会切到普通 provider，旧逻辑把普通模型的重试/超时
      // 也累计进 Highspeed modelDurationMs，导致节省时间按高速倍率放大数小时。
      const turnId = this.turnIdOf(event);
      this.highspeedModelDurationByTurnId.set(
        turnId,
        (this.highspeedModelDurationByTurnId.get(turnId) ?? 0) + Math.max(0, payload.durationMs),
      );
    }
    switch (payload.type) {
      case "model_retry_scheduled": {
        const attempt = positiveInteger(payload.attempt, 1);
        const maxAttempts = Math.max(
          positiveInteger(payload.maxAttempts, attempt + 1),
          attempt + 1,
        );
        return this.setApiRetry({
          attempt,
          maxAttempts,
          nextRetryAt: this.ms(event) + nonNegativeInteger(payload.delayMs, 0),
          reasonCode: modelRetryReasonCode(payload.reason),
        });
      }
      case "model_request_started":
        if (payload.streamRecovery) {
          return this.setApiRetry(
            this.streamRecoveryApiRetry(
              payload.streamRecovery.retryNumber,
              payload.streamRecovery.maxRetries,
              this.ms(event),
              this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
            ),
          );
        }
        // adapter attempt=2+ 只说明重试请求已发出，不代表连接恢复；
        // 保持当前状态，等首个有效 text/reasoning/tool 进展再清理，避免标签闪退。
        return positiveInteger(payload.attempt, 1) <= 1 ? this.setApiRetry(null) : [];
      case "model_request_completed":
        return this.setApiRetry(null);
      case "model_request_failed":
        return payload.retryable ? [] : this.setApiRetry(null);
      case "model_stream_stalled":
      case "model_first_provider_event":
      case "model_first_content":
      case "model_first_text":
      // 准入等待的两端是 runtime 观测，不是 UI 状态：
      // 不映射成重试/等待标签。
      case "model_request_queued":
      case "model_request_admitted":
      case "model_request_observation":
        return [];
    }
  }

  /**
   * 流恢复开始：在 A 区建立 recovery 状态（进行中/第几次），供 UI 显示“重连中”。
   * 只改 control，不触碰 rows；后续尾部丢弃/重试开始都以此状态为参照。
   */
  private onStreamRecoveryStarted(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as StreamRecoveryStartedPayload;
    return this.setApiRetry(
      this.streamRecoveryApiRetry(
        payload.retryNumber,
        payload.maxRetries,
        this.ms(event),
        streamRecoveryReasonCode(payload.failureKind),
      ),
    );
  }

  /**
   * 流恢复时丢弃已发出的尾部：把对应 streaming 行回退到丢弃点（可能截断文本或
   * 整段移除），并清理流式游标。只处理仍处于打开状态的段；已收口段不可回改。
   * 若无法用既有 delta 精确表达截断，交由上层 snapshot/resync。
   */
  private onStreamRecoveryTailDiscarded(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    // Bug 原因：Core 已用 tail_discarded 切断失败 assistant attempt，但旧 V4 投影忽略该事件，
    // 下一次 reasoning/text 到达时会把旧行误收口为 complete。这里必须先标 interrupted，
    // 让恢复流用新 assistant identity 打开新行，避免 UI 看起来像一次连续完整输出。
    // Bug 原因：断流时已由 tool_input_start 打开、但还没等到 tool_call 定稿的工具行也属于
    // 被作废的 tail——core 只为已提交的工具合成终态，这些行没人收口；恢复请求会用新的
    // toolCallId 再开一行，UI 于是并排出现两张「正在编写工作流」。已提交（running /
    // pendingApproval）的行不在此列，它们的终态由 executor 自己发布。
    return [
      ...this.closeStreamingRows("interrupted"),
      ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
    ];
  }

  private onStreamRecoveryRetryStarted(event: SessionEvent): ConversationDelta[] {
    if (!this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as StreamRecoveryRetryStartedPayload;
    return this.setApiRetry(
      this.streamRecoveryApiRetry(
        payload.retryNumber,
        payload.maxRetries,
        this.ms(event),
        this.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
      ),
    );
  }

  private streamRecoveryApiRetry(
    retryNumber: number,
    maxRetriesValue: number,
    nextRetryAt: number,
    reasonCode: string,
  ): ApiRetryState {
    const attempt = positiveInteger(retryNumber, 1);
    const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
    return {
      attempt,
      maxAttempts: maxRetries + 1,
      nextRetryAt,
      reasonCode,
    };
  }

  /**
   * 写/清 A 区 apiRetry。状态相同返回空，避免重复 revision；不同则整键替换
   * （传 null 即清除）。仅由网络状态/重试/流恢复路径调用。
   */
  private setApiRetry(apiRetry: ApiRetryState | null): ConversationDelta[] {
    const current = this.snapshot.control.apiRetry;
    if (
      current === apiRetry ||
      (current !== null &&
        apiRetry !== null &&
        current.attempt === apiRetry.attempt &&
        current.maxAttempts === apiRetry.maxAttempts &&
        current.nextRetryAt === apiRetry.nextRetryAt &&
        current.reasonCode === apiRetry.reasonCode)
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: this.controlPatch({ apiRetry }),
      },
    ];
  }

  /**
   * 判断模型类事件是否属于当前活动轮：事件 turnId 必须等于 currentTurnId。
   * 否则视为迟到/旧轮事件丢弃，防止重试状态或流式内容污染新轮。
   */
  private acceptsActiveModelEvent(event: SessionEvent): boolean {
    if (!this.isRunning()) return false;
    // stop/新一轮后旧请求可能迟到；仅凭 session 级状态会让旧 turn 的
    // retry/progress 覆盖当前输入栏。当前 runtime turn 已知时必须按 turnId 隔离。
    return (
      this.currentTurnId === null ||
      event.turnId === undefined ||
      String(event.turnId) === this.currentTurnId
    );
  }

  /**
   * assistant 段流式入口：按 payload.kind 分派 text/reasoning/tool_input。
   *
   * text_delta 在既有行上产 row.delta（不推进 revision）；新段则先收口上一条
   * 再 row.appended。reasoning 与 text 各自维护独立游标，可交错输出。
   * tool_input_start/delta/end 走工具行流式输入；tool_call 到达时 materialize 行。
   * 只有 active turn 的事件被接受，迟到段不得补进旧轮。
   */
  private onModelStreaming(fact: CanonicalAssistantSegmentFact): ConversationDelta[] {
    const event = fact.event;
    // 迟到终态不复活：非运行期到达的流式事件一律拒收。
    // assistant 守恒：正文类拒收不是无害丢弃——投影建立晚于
    // TurnStarted（订阅中途建 publisher）时，整段回复会静默消失直到刷新
    // （「回复整段消失」的 live 向量）。计数暴露给 gateway：置 stale 标记，
    // 下次订阅强制重新 hydration 从持久事实补齐。
    if (!this.isRunning()) {
      const dropped = fact.stream;
      if (
        dropped.kind === "text_start" ||
        dropped.kind === "text_delta" ||
        dropped.kind === "reasoning_start" ||
        dropped.kind === "reasoning_delta"
      ) {
        this.droppedContentStreamEventCount += 1;
      }
      return [];
    }
    const payload = fact.stream;
    switch (payload.kind) {
      case "text_start":
        return this.openTextRow(event, fact);
      case "text_delta": {
        const open = this.streamingTextRowId === null ? this.openTextRow(event, fact) : [];
        return [
          ...open,
          {
            op: "row.delta",
            rowId: this.streamingTextRowId as number,
            path: "text",
            append: payload.delta,
          },
        ];
      }
      case "text_end":
        return this.closeTextRow("complete");
      case "reasoning_start":
        return this.openReasoningRow(event, fact);
      case "reasoning_delta": {
        const open =
          this.streamingReasoningRowId === null ? this.openReasoningRow(event, fact) : [];
        return [
          ...open,
          {
            op: "row.delta",
            rowId: this.streamingReasoningRowId as number,
            path: "text",
            append: payload.delta,
          },
        ];
      }
      case "reasoning_end":
        return this.closeReasoningRow();
      case "tool_input_start":
        return this.openToolRow(event, payload, fact.entityId);
      case "tool_input_delta": {
        return this.appendStreamingToolInput(event, payload);
      }
      case "tool_input_end":
        return this.flushStreamingToolInput(String(payload.toolCallId ?? ""));
      case "tool_call":
        return this.finalizeStreamingToolInput(event, payload);
      default:
        return [];
    }
  }

  /**
   * 打开 assistantText 行：先 close 当前 text 段，再判断是否是 output-token Continue。
   *
   * Continue 场景（同一 turn、紧邻最后一行、有 continuation 游标）复用原 rowId，
   * 只把 state 改回 streaming 并刷新 entityId/responseId/messageId，避免 runtime 为
   * 每次 provider 请求换 assistantMessageId 时把一句话拆成多行；否则分配新 rowId
   * 并 row.appended。两种路径都维护 messageIdByRowId / outputContinuation 索引，
   * 确保 fork 锚点与冷恢复一致。
   */
  private openTextRow(
    event: SessionEvent,
    fact: CanonicalAssistantSegmentFact,
  ): ConversationDelta[] {
    const close = this.closeTextRow("complete");
    const continuationRowId = this.outputContinuationTextRowId;
    this.outputContinuationTextRowId = null;
    const continuationRow =
      continuationRowId === null ? undefined : this.findRow(continuationRowId);
    const currentTurnId = this.turnIdOf(event);
    const lastVisibleRow = this.snapshot.rows.window.at(-1);
    if (
      continuationRow?.kind === "assistantText" &&
      continuationRow.turnId === currentTurnId &&
      lastVisibleRow?.rowId === continuationRow.rowId
    ) {
      // runtime 的 output-token Continue 会为每次 provider 请求创建新的
      // assistantMessageId；旧投影因此把一句话拆成 history partial + 轮尾正文。length
      // 已经在 ModelComplete 上提供精确资格，这里只重新打开紧邻的同 turn text row，
      // 让外部 continuous/replayable 客户端都只观察到一条持续增长的 assistant。
      const {
        actions: _actions,
        assistantResponseId: _assistantResponseId,
        feedback: _feedback,
        ...continuedBase
      } = continuationRow;
      const row: AssistantTextRow = {
        ...continuedBase,
        entityId: fact.entityId,
        ...(fact.stream.assistantResponseId
          ? { assistantResponseId: fact.stream.assistantResponseId }
          : {}),
        state: "streaming",
      };
      this.streamingTextRowId = row.rowId;
      this.entityIdByRowId.set(row.rowId, fact.entityId);
      const previousMessageId = this.messageIdByRowId.get(row.rowId);
      if (previousMessageId) {
        this.outputContinuationRowIdByMessageId.set(previousMessageId, row.rowId);
      }
      if (fact.transcriptMessageId) {
        this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
      }
      return [...close, { op: "row.upserted", row }];
    }

    // 不变量：非 output-token Continue 的新段必然新 rowId；已有 streaming 行先收口。
    const row: AssistantTextRow = {
      ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
      kind: "assistantText",
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      text: "",
      state: "streaming",
    };
    this.streamingTextRowId = row.rowId;
    this.entityIdByRowId.set(row.rowId, fact.entityId);
    // forkAssistant 锚点：assistant 行 → 权威 messageId（provider 流首帧即带）。
    if (fact.transcriptMessageId) {
      this.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.appended", row }];
  }

  /**
   * 收口当前 streaming text 行：把 state 置 complete/interrupted 并清游标。
   * 只 upsert 状态，不改文本；无打开段时返回空数组（幂等，可在多处兜底调用）。
   */
  private closeTextRow(state: "complete" | "interrupted"): ConversationDelta[] {
    if (this.streamingTextRowId === null) return [];
    const row = this.findRow(this.streamingTextRowId);
    this.streamingTextRowId = null;
    if (row?.kind !== "assistantText") return [];
    return [{ op: "row.upserted", row: { ...row, state } }];
  }

  /**
   * assistant 反馈（赞/踩）→ 按 entityId 命中 assistantText 行，增量写/删 feedback。
   * null 表示撤销：无 feedback 时幂等返回空；其余值相同也返回空，避免无意义 revision。
   * 只 upsert 该行，不改变文本或轮次状态。
   */
  private onAssistantFeedbackUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as AssistantFeedbackUpdatedPayload;
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is AssistantTextRow =>
        candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
    );
    if (!row) return [];
    if (payload.feedback === null) {
      if (row.feedback === undefined) return [];
      const { feedback: _removedFeedback, ...withoutFeedback } = row;
      return [{ op: "row.upserted", row: withoutFeedback }];
    }
    if (row.feedback === payload.feedback) return [];
    return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
  }

  /**
   * highspeed 终态指标 → userInput 行。必须字段级合并（只增不删）：
   * payload 来自 transcript raw metadata，不含 live 投影刚写入的 fallbackAt；
   * 整体替换会清空降级 Toast 依赖字段，并造成 live 与 cold/replay 不一致。
   */
  private onHighspeedMetricsUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as HighspeedMetricsUpdatedPayload;
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is UserInputRow =>
        candidate.kind === "userInput" && candidate.entityId === payload.entityId,
    );
    if (!row) return [];
    // Bug 根因：终态指标更新曾整体替换 row.highspeed。payload 来自 transcript 原始 metadata + 耗时字段，
    // 不含 live 投影刚由 TurnExecutionModelFallback 写入的 fallbackAt；降级 Toast 依赖的字段被清空，
    // live 与 cold/replay 的结果也不一致。指标更新是增量补充：字段级合并、只增不删（spec §5）。
    return [
      {
        op: "row.upserted",
        row: { ...row, highspeed: { ...row.highspeed, ...payload.highspeed } },
      },
    ];
  }

  /**
   * 执行期模型降级（fallback）→ 更新 config 的当前模型选择，并在 userInput 行
   * 记录 fallbackAt 等降级事实，供 UI 展示 Toast 且不丢失后续 highspeed 合并。
   * 只改 A 区 config 与目标行；不重建轮次。
   */
  private onTurnExecutionModelFallback(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnExecutionModelFallbackPayload;
    // Bug 根因：fallback 会作废当前 assistant attempt，但旧投影只更新输入行元数据，仍把旧模型的
    // text/reasoning row 留在 streaming；原模型续流时这些内容会被误标 complete，缺少 text_start 时
    // 甚至直接拼到同一行。未定稿的 tool input 同样不会收到 tool_call，必须随废弃 attempt 一起收口。
    // 已提交执行的工具不在这里处理，它们由 core 的 tool_abandoned 事件收口。
    const discardedStreamDeltas = this.acceptsActiveModelEvent(event)
      ? [
          ...this.closeStreamingRows("interrupted"),
          ...this.closeOpenToolRows(event, "cancelled", (row) => row.status === "inputStreaming"),
        ]
      : [];
    // 卡过期与其他加速请求失败都投影到同一张加速输入行：fallbackAt 触发一次性提示，
    // fallbackReason 让 Renderer 区分“卡已到期”与“加速服务不可用”两种文案。
    const turnId = this.turnIdOf(event);
    const row = this.snapshot.rows.window.find(
      (candidate): candidate is UserInputRow =>
        candidate.kind === "userInput" &&
        // Bug 根因：cold hydration 会重建 product turnId，不能再拿 runtime turnId
        // 关联已持久化的输入；inputId/sourceCommandId 才是跨恢复稳定身份。
        (candidate.turnId === turnId ||
          (payload.inputId !== undefined && candidate.sourceCommandId === payload.inputId)) &&
        candidate.highspeed !== undefined,
    );
    if (!row?.highspeed) return discardedStreamDeltas;
    return [
      ...discardedStreamDeltas,
      {
        op: "row.upserted",
        row: {
          ...row,
          highspeed: {
            ...row.highspeed,
            fallbackAt: event.timestamp.getTime(),
            fallbackReason: payload.reason,
          },
        },
      },
    ];
  }

  /**
   * 打开 assistantReasoning 行：与 text 相同的段语义，但使用独立游标。
   * 先收口上一条 reasoning；新行以 row.appended 加入，并绑定 entityId 供反馈/恢复找回。
   */
  private openReasoningRow(
    event: SessionEvent,
    fact: CanonicalAssistantSegmentFact,
  ): ConversationDelta[] {
    const close = this.closeReasoningRow();
    const row: ReasoningRow = {
      ...this.rowBase(event, this.turnIdOf(event), fact.entityId),
      kind: "reasoning",
      // Bug 原因：canonical stream 已携带 assistant response 身份，但旧投影只在正文与工具行
      // 保存它，UI 因而无法把同 response 的 reasoning 确定性归入 CUA Group。
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      text: "",
      state: "streaming",
    };
    this.streamingReasoningRowId = row.rowId;
    this.entityIdByRowId.set(row.rowId, fact.entityId);
    return [...close, { op: "row.appended", row }];
  }

  /**
   * 收口当前 reasoning 行（默认 complete，中断路径传 interrupted）。
   * 无打开段时幂等返回空；只改状态，不删除已产出的推理内容。
   */
  private closeReasoningRow(state: "complete" | "interrupted" = "complete"): ConversationDelta[] {
    if (this.streamingReasoningRowId === null) return [];
    const row = this.findRow(this.streamingReasoningRowId);
    this.streamingReasoningRowId = null;
    if (row?.kind !== "reasoning") return [];
    return [{ op: "row.upserted", row: { ...row, state } }];
  }

  /**
   * 一次性收口正文与推理两个流式游标，通常在 turn 终态/中断/新段开启前调用。
   * 两段各自 upsert，顺序稳定；已关闭的游标为 null，不重复产 delta。
   */
  private closeStreamingRows(state: "complete" | "interrupted"): ConversationDelta[] {
    return [...this.closeTextRow(state), ...this.closeReasoningRow(state)];
  }

  // turn 终态收口所有 foreground 未终态 tool row（迟到终态不复活由 isRunning 闸保证）；
  // `only` 让 stream recovery 只收口未定稿的那一部分。
  /**
   * turn 收口时关闭所有“在飞”的 foreground tool 行。
   *
   * 条件由 openForegroundToolCallIds 判定，排除已转后台/已终态的行，避免把后台任务
   * 误标中断或复活已结束行。inputStreaming/pendingApproval/running 统一置
   * cancelled/error 并清空预览；这是“收口不变量”的一部分——被 profile 过滤的
   * inputText 流必须由不可过滤的 row.upserted 蕴含，见 profiles.ts。
   */
  private closeOpenToolRows(
    event: SessionEvent,
    status: "cancelled" | "error",
    only?: (row: ToolCallRow) => boolean,
  ): ConversationDelta[] {
    if (this.openForegroundToolCallIds.size === 0) return [];
    const openRows: ToolCallRow[] = [];
    for (const toolCallId of this.openForegroundToolCallIds) {
      const row = this.findToolRow(toolCallId);
      // 派生索引不能成为第二份权威状态；收口前始终以当前 snapshot row 复核。
      if (!row || !this.isOpenForegroundToolRow(row)) continue;
      if (only && !only(row)) continue;
      openRows.push(row);
    }
    if (openRows.length === 0) return [];
    // Set 可能因迟到 reopen 改变插入顺序；rowId 单调递增，排序后保持旧 timeline delta 顺序。
    if (openRows.length > 1) {
      openRows.sort((left, right) => left.rowId - right.rowId);
    }
    const deltas: ConversationDelta[] = [];
    const closedToolCallIds = new Set<string>();
    for (const row of openRows) {
      const next: ToolCallRow = {
        ...row,
        status,
        inputText: `${row.inputText ?? ""}${this.takePendingStreamingToolInput(row.toolCallId)}`,
        endedAt: this.ms(event),
      };
      delete next.approvalInteractionId;
      if (status === "error") {
        // executor 早退或事件缺失时，旧投影只在 stop 路径收口工具；
        // success/error turn 会留下运行态行，cold snapshot 缺 header 后被 UI 误判为 thinking。
        next.error = {
          code: "fault.runtime.toolLifecycleIncomplete",
          message: "Tool call ended without a terminal event.",
        };
      } else {
        delete next.error;
      }
      closedToolCallIds.add(row.toolCallId);
      deltas.push({ op: "row.upserted", row: next });
    }

    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (interaction) =>
        !(
          (interaction.payload.kind === "permission" || interaction.payload.kind === "userInput") &&
          typeof interaction.payload.toolCallId === "string" &&
          closedToolCallIds.has(interaction.payload.toolCallId)
        ),
    );
    if (pendingInteractions.length !== this.snapshot.pendingInteractions.length) {
      deltas.push({ op: "state.updated", patch: { pendingInteractions } });
    }
    return deltas;
  }

  private isOpenForegroundToolRow(row: ToolCallRow): boolean {
    return (
      row.backgrounded !== true &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    );
  }

  /**
   * apply 之后同步维护所有 side-map：toolCallId→rowId、subagent/agent、hook
   * invocation、message/entity 身份、流式游标、open foreground 集合。
   *
   * 只读取 delta 中的行结构与 row.removed 截断点，不重新扫描整个 window，
   * 保证长会话下每次事件摊销 O(delta)。索引必须可从 snapshot 重建（resync 后正确），
   * 因此任何新增索引都要同时在这里和 clone/adopt 路径登记。
   */
  private updateToolIndexesAfterDeltas(deltas: readonly ConversationDelta[]): void {
    for (const delta of deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") {
        if (delta.row.kind !== "toolCall") continue;
        if (this.isOpenForegroundToolRow(delta.row)) {
          this.openForegroundToolCallIds.add(delta.row.toolCallId);
        } else {
          this.openForegroundToolCallIds.delete(delta.row.toolCallId);
        }
        continue;
      }
      if (delta.op !== "row.removed") continue;
      for (const [toolCallId, rowId] of this.toolRowIdByCallId) {
        if (rowId < delta.fromRowId) continue;
        // Bug 原因：rewind 过去只删 rows/message 索引，旧 toolCallId 仍会阻止新分支
        // 重新打开同 id 的流式工具；open tracker 也会留下已经不存在的 row。
        this.toolRowIdByCallId.delete(toolCallId);
        this.openForegroundToolCallIds.delete(toolCallId);
        this.fileToolInputPreviewByCallId.delete(toolCallId);
      }
      this.pruneRemovedSubagentIndexes();
    }
  }

  private pruneRemovedSubagentIndexes(): void {
    for (const [agentId, rowId] of this.subagentRowIdByAgentId) {
      if (this.findRow(rowId)?.kind === "subagent") continue;
      // Bug 原因：rewind 只重建 rowIndex，旧 agent alias 仍会被后续每次 subagent
      // materialization 枚举。仅在 row.removed 已应用后按权威 snapshot 清理一次，
      // 避免长会话随已删除历史持续增长；普通事件不会扫描该索引。
      this.subagentRowIdByAgentId.delete(agentId);
    }
  }

  // ── tool call 状态机 ──

  /**
   * 创建/取得 ToolCallRow（按 toolCallId 去重），初始状态由 payload 推导：
   * inputStreaming（尚在流式拼输入）、pendingApproval（需权限）、running（已调度）。
   * 已存在则 upsert 更新状态/元信息，不重复 append；同时登记 openForeground 集合
   * 与 mcp 展示元信息。工具行是时间线锚点，必须自包含（名称/参数/状态）。
   */
  private openToolRow(
    event: SessionEvent,
    payload: CanonicalModelStream,
    entityId?: string,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    if (
      toolCallId === "" ||
      shouldHideInvalidToolCallFromProduct(payload.toolName) ||
      this.toolRowIdByCallId.has(toolCallId)
    ) {
      return [];
    }
    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
      toolCallId,
      toolName: payload.toolName ?? "",
      status: "inputStreaming",
      inputText: "",
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    if (isZCodeFileStreamingToolInputPreviewTool(row.toolName)) {
      this.fileToolInputPreviewByCallId.set(toolCallId, {
        lastPublishedAt: null,
        pendingAppend: "",
      });
    }
    if (entityId) this.entityIdByRowId.set(row.rowId, entityId);
    return [{ op: "row.appended", row }];
  }

  /**
   * 工具输入流式追加：只对仍无结构化 input 的既有行生效，产出 row.delta
   * path=inputText，因此不推进 revision。
   * 文件类工具（Write/Edit 等）走节流预览：pendingAppend 累积，间隔不足时返回空，
   * 既控制 wire 体积又保证尾部不丢；非文件工具直接逐 delta 下发。
   */
  private appendStreamingToolInput(
    event: SessionEvent,
    payload: CanonicalModelStream,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    if (rowId === undefined || this.findToolRow(toolCallId)?.input !== undefined) return [];
    const state = this.fileToolInputPreviewByCallId.get(toolCallId);
    if (!state) {
      return [{ op: "row.delta", rowId, path: "inputText", append: payload.delta }];
    }

    state.pendingAppend += payload.delta;
    const now = this.ms(event);
    if (
      state.lastPublishedAt !== null &&
      now - state.lastPublishedAt < ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
    ) {
      return [];
    }

    const append = state.pendingAppend;
    state.pendingAppend = "";
    state.lastPublishedAt = now;
    return append === "" ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
  }

  /**
   * 输入流结束（tool_input_end）：把节流窗口里残留的 pendingAppend 一次性补发为
   * 一条 row.delta，并清理该工具的预览状态。空 append 或行不存在时幂等返回空。
   */
  private flushStreamingToolInput(toolCallId: string): ConversationDelta[] {
    const append = this.takePendingStreamingToolInput(toolCallId);
    if (append === "") return [];
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    return rowId === undefined ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
  }

  private takePendingStreamingToolInput(toolCallId: string): string {
    const state = this.fileToolInputPreviewByCallId.get(toolCallId);
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    return state?.pendingAppend ?? "";
  }

  /**
   * tool_call 到达：用完整结构化 input 定稿工具行，并清掉流式预览状态。
   *
   * 若行已有 input（已 scheduled 或已定稿），迟到原始流不得覆盖执行身份，直接忽略；
   * 否则补 inputText/input/assistantResponseId（保留既有 toolName 优先级）。
   * 隐藏类无效工具不物化，避免 UI 时间线出现不可执行的占位行。
   * 注意 replayable 会过滤 row.delta(inputText)，所以定稿 upsert 必须携带完整文本。
   */
  private finalizeStreamingToolInput(
    event: SessionEvent,
    payload: CanonicalModelStream,
  ): ConversationDelta[] {
    const toolCallId = String(payload.toolCallId ?? "");
    if (toolCallId === "") return [];
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
    const inputText = stringifyToolInput(payload.input);
    const existing = this.findToolRow(toolCallId);
    // scheduled 或完整 tool_call 已定稿输入；迟到原始流不能覆盖执行身份。
    if (existing?.input !== undefined) return [];
    if (existing) {
      return [
        {
          op: "row.upserted",
          row: {
            ...existing,
            ...(payload.assistantResponseId
              ? { assistantResponseId: payload.assistantResponseId }
              : {}),
            toolName: existing.toolName || payload.toolName || "",
            inputText,
            input: payload.input,
          },
        },
      ];
    }

    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
      toolCallId,
      toolName: payload.toolName ?? "",
      status: "inputStreaming",
      inputText,
      input: payload.input,
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    return [{ op: "row.appended", row }];
  }

  /**
   * 流式工具身份闭合：断流恢复可能直接给 deferred 包装行补真实 toolName/input，
   * 不经过 ToolCallScheduled。这里只补齐身份字段，不触发 Todo 等业务副作用，
   * 也不重置既有 status/error；仅当当前行仍是 deferred 包装名时生效。
   */
  private onStreamingToolIdentity(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.acceptsActiveModelEvent(event)) return [];
    const payload = event.payload as StreamingToolLedgerPayload;
    if (
      payload.status !== "tool_call_closed" ||
      payload.input === undefined ||
      payload.toolName === DEFERRED_TOOL_CALL_NAME ||
      shouldHideInvalidToolCallFromProduct(payload.toolName)
    )
      return [];
    const row = this.findToolRow(String(payload.toolCallId));
    if (row?.toolName !== DEFERRED_TOOL_CALL_NAME) return [];
    // 断流恢复可能直接提交工具错误而不经过 scheduled；目标身份取 Core 已闭合的调用，
    // 只补齐包装行，不触发 scheduled 的 Todo 等业务更新，也不重置已有状态和错误。
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          toolName: payload.toolName,
          input: payload.input,
          inputText: stringifyToolInput(payload.input),
        },
      },
    ];
  }

  /**
   * 工具调度：定稿工具名/完整 input/assistantResponseId，复用已有流式行或新建行，
   * 并同步从 tool input 推导 plan（todoPlanDeltas）。CUA 工具额外解析 app 身份，
   * mcp_tool 展示元信息一并写入。
   * 只对 active turn 生效；subagent 镜像事件与无效工具不物化。已有行的 upsert
   * 必须携带完整 inputText（replayable 过滤 row.delta 后仍能恢复终态）。
   */
  private onToolCallScheduled(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallScheduledPayload;
    const toolCallId = String(payload.toolCallId);
    this.fileToolInputPreviewByCallId.delete(toolCallId);
    if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
    const inputText = stringifyToolInput(payload.input);
    const cuaAction = readOfficialCuaAction(payload.toolName);
    const cuaApp =
      cuaAction && cuaAction !== "list_apps"
        ? resolveCuaAppIdentity(payload.input, this.latestListAppsSnapshot)
        : undefined;
    const existing = this.findToolRow(toolCallId);
    const planDeltas = this.todoPlanDeltas(
      event,
      extractPlanStepsFromToolInput({
        title: payload.toolName,
        kind: payload.toolName,
        input: payload.input,
      }),
    );
    if (existing) {
      // replayable 会过滤 row.delta(inputText)，定稿 upsert 必须携带完整 inputText。
      // 否则断线恢复只能看到结构化 input，丢失 v4 row 的输入文本终态。
      return [
        {
          op: "row.upserted",
          row: {
            ...existing,
            toolName: payload.toolName,
            ...(payload.assistantMessageId
              ? { assistantResponseId: String(payload.assistantMessageId) }
              : {}),
            inputText,
            input: payload.input,
            ...(cuaApp ? { cuaApp } : {}),
            ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
          },
        },
        ...planDeltas,
      ];
    }
    const row: ToolCallRow = {
      ...this.rowBase(event, this.turnIdOf(event), toolCallId),
      kind: "toolCall",
      ...(payload.assistantMessageId
        ? { assistantResponseId: String(payload.assistantMessageId) }
        : {}),
      toolCallId,
      toolName: payload.toolName,
      status: "inputStreaming",
      inputText,
      input: payload.input,
      ...(cuaApp ? { cuaApp } : {}),
      ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
    };
    this.toolRowIdByCallId.set(toolCallId, row.rowId);
    return [{ op: "row.appended", row }, ...planDeltas];
  }

  /**
   * 工具活动/启动事件：委托 projectToolActivity 把既有 Bash/MCP 行推进到 running
   * 或补输出预览；不改工具行集合，也不负责 revision。
   */
  private onToolCallActivity(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallStartedPayload;
    this.recordHighspeedToolStarted(
      this.turnIdOf(event),
      String(payload.toolCallId),
      this.ms(event),
    );
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row) return [];
    return projectToolActivity(event, row);
  }

  /**
   * MCP `notifications/progress`（A8）→ 行上的 progress。只在 running 时写：
   * 终态之后迟到的进度通知不能把 success/error 行重新点亮；bash 的 stdout 字节进度不在这里消费。
   */
  /**
   * 工具进度：只更新仍为 running 的行；终态后迟到的进度一律丢弃，防止行被重新点亮。
   *
   * Bash 与 MCP 共用 payload 但语义不同：Bash 交给 projectToolActivity 维护尾部输出
   * 预览，MCP 解析 fraction=progress/total 与 message（截 200 字），分别写
   * row.progress，避免两种展示互相覆盖。无有效字段时幂等返回空。
   */
  private onToolCallProgress(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallProgressPayload;
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row || row.status !== "running") return [];
    // 两个分支共用 ToolCallProgress：Bash 尾窗与 MCP 百分比必须分别投影，避免合并后互相覆盖。
    if (row.toolName === "Bash") return projectToolActivity(event, row);
    const total =
      typeof payload.total === "number" && Number.isFinite(payload.total) && payload.total > 0
        ? payload.total
        : undefined;
    const fraction =
      total !== undefined &&
      typeof payload.progress === "number" &&
      Number.isFinite(payload.progress)
        ? Math.min(1, Math.max(0, payload.progress / total))
        : undefined;
    const message =
      typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message.trim().slice(0, 200)
        : undefined;
    if (fraction === undefined && message === undefined && total === undefined) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          progress: {
            ...(fraction !== undefined ? { fraction } : {}),
            ...(total !== undefined ? { total } : {}),
            ...(message !== undefined ? { message } : {}),
            updatedAt: this.ms(event),
          },
        },
      },
    ];
  }

  /**
   * 工具结果终态：success/error，写 output（统一截断档）、display、endedAt，清 progress。
   * 成功且为 list_apps 时先更新 app 身份快照，供后续 CUA 操作解析 app；失败结果不得
   * 清空旧快照。错误补 fault.runtime.toolFailed 或 payload 自带 code。
   * 成功结果还会尝试从输出推导 plan（todoPlanDeltas），失败不推导。
   * 行不存在时忽略（迟到结果不造行）；只产 row.upserted + 可能的 state.updated。
   */
  private onToolCallResult(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallResultPayload;
    const toolCallId = String(payload.toolCallId);
    this.recordHighspeedToolEnded(
      this.turnIdOf(event),
      toolCallId,
      this.ms(event),
      payload.duration,
    );
    const row = this.findToolRow(toolCallId);
    if (!row) return [];
    const success = payload.result.success;
    if (success && readOfficialCuaAction(row.toolName) === "list_apps") {
      // 摘要身份必须来自 Agent 已观察到的成功事实；失败结果不能清空旧快照。
      const snapshot = parseListAppsSnapshot(payload.result.content, payload.result.display);
      if (snapshot) this.latestListAppsSnapshot = snapshot;
    }
    const display = toProtocolToolCallDisplay(payload.result.display);
    const next: ToolCallRow = {
      ...row,
      status: success ? "success" : "error",
      // 终态清除运行中进度（R7）。
      progress: undefined,
      output: buildToolOutput(payload.result, toolCallId),
      ...(display ? { display } : {}),
      endedAt: this.ms(event),
    };
    if (!success) {
      next.error = {
        code: payload.result.error?.type ?? "fault.runtime.toolFailed",
        message: payload.result.error?.message ?? "Tool execution failed.",
      };
    }
    const planDeltas = success
      ? this.todoPlanDeltas(
          event,
          extractPlanStepsFromToolOutput({
            title: row.toolName,
            kind: row.toolName,
            output: payload.result.content,
          }),
        )
      : [];
    return [{ op: "row.upserted", row: next }, ...planDeltas];
  }

  /**
   * TodoWrite 同时投影 live plan 与当前 goal iteration。
   * V4 之前只保留 tool row，右上角摘要无法在 live/cold 恢复后重建每轮 action/status。
   * 轮次只由 verifier boundary 推进；TodoWrite 只更新当前打开轮次，不能自行加一轮。
   */
  /**
   * TodoWrite 输入/输出 → live plan（state.updated）与 goal 当前 iteration。
   *
   * 无 goal 时只更新 plan；有 goal 时按当前状态决定写第几轮（verifying/verified/failed
   * 视为已完成轮，否则 iteration+1），但绝不自行推进轮次——轮次只由 verifier boundary
   * 推进，TodoWrite 只能更新当前打开轮。旧 iteration 同号条目被替换后重新排序。
   * state.updated 的 plan/goal 均整键替换；plan 属 revision-bearing。
   */
  private todoPlanDeltas(
    event: SessionEvent,
    steps: ReturnType<typeof extractPlanStepsFromToolInput>,
  ): ConversationDelta[] {
    if (!steps) return [];
    const items = steps.map((step, index) => ({
      id: step.id || `todo-${index + 1}`,
      content: step.title,
      status:
        step.status === "in_progress"
          ? ("inProgress" as const)
          : step.status === "completed"
            ? ("completed" as const)
            : ("pending" as const),
    }));
    const updatedAt = this.ms(event);
    const goal = this.snapshot.goal;
    if (!goal) {
      return [{ op: "state.updated", patch: { plan: { items, updatedAt } } }];
    }

    const iteration =
      goal.status === "verifying" || goal.status === "verified" || goal.status === "failed"
        ? Math.max(1, goal.iteration)
        : Math.max(1, goal.iteration + 1);
    const iterations = [
      ...goal.iterations.filter((entry) => entry.iteration !== iteration),
      { iteration, items, updatedAt },
    ].sort((left, right) => left.iteration - right.iteration);
    return [
      {
        op: "state.updated",
        patch: {
          goal: { ...goal, iterations },
          plan: { items, updatedAt },
        },
      },
    ];
  }

  /**
   * 工具错误终态：区分 ToolCancelled 与真实 error——Stop 会先发 tool_cancelled，
   * 若写成 error，随后只收口 running 行的 turn reducer 无法纠正为 stopped。
   * 同时结束 highspeed 计时、清 progress 与预览。行不存在时忽略。
   */
  private onToolCallError(event: SessionEvent): ConversationDelta[] {
    if (this.isMirroredSubagentToolEvent(event) || !this.isRunning()) return [];
    const payload = event.payload as ToolCallErrorPayload;
    this.recordHighspeedToolEnded(this.turnIdOf(event), String(payload.toolCallId), this.ms(event));
    const row = this.findToolRow(String(payload.toolCallId));
    if (!row) return [];
    const cancelled =
      payload.error.type === CoreErrorType.ToolCancelled || payload.error.code === "TOOL_CANCELLED";
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          // Stop 会先产生 tool_cancelled，再产生 cancelled turn；若先把工具
          // 终态写成 error，后续只收口 running row 的 turn reducer 无法纠正为 stopped。
          status: cancelled ? "cancelled" : "error",
          progress: undefined,
          ...(cancelled
            ? { error: undefined }
            : { error: { code: payload.error.type, message: payload.error.message } }),
          endedAt: this.ms(event),
        },
      },
    ];
  }

  // ── 权限交互（阻塞交互 → 状态）──

  /**
   * 权限请求：创建 pendingInteraction（permission），并把对应 tool row 推进到
   * pendingApproval，附上可选项/默认选项/scope 等展示信息。
   * 同一 toolCallId 已有交互时不重复创建；只对 active turn 生效。
   * 行与交互必须在同一事务产出，保证「入口可见即可解析 target」。
   */
  private onPermissionRequested(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionRequestedPayload;
    const toolCallId = String(payload.toolCallId);
    const interactionId = payload.requestId ?? `perm-${toolCallId}`;
    const interaction = this.createPendingInteractionFromPermissionEvent(
      event,
      payload,
      toolCallId,
      interactionId,
    );
    const deltas: ConversationDelta[] = [];
    const row = this.findToolRow(toolCallId);
    if (row) {
      deltas.push({
        op: "row.upserted",
        row: {
          ...row,
          status: "pendingApproval",
          approvalInteractionId: interactionId,
        },
      });
    }
    deltas.push({
      op: "state.updated",
      patch: {
        pendingInteractions: [...this.snapshot.pendingInteractions, interaction],
      },
    });
    return deltas;
  }

  private createPendingInteractionFromPermissionEvent(
    event: SessionEvent,
    payload: PermissionRequestedPayload,
    toolCallId: string,
    interactionId: string,
  ): PendingInteraction {
    if (isAskUserQuestionToolName(payload.toolName)) {
      // AskUserQuestion 的 permission_requested 只是 runtime 等待态；
      // v4 UI 需要结构化 questions 才能回填 answers，而不是 Allow/Deny 权限弹窗。
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: { toolName: payload.toolName },
          questions: readAskUserQuestionPayloadQuestions(payload.input),
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    if (payload.toolName === MCP_ELICITATION_TOOL_NAME) {
      // MCP elicitation：requestedSchema → 结构化问题，
      // 与 broker 用同一映射，v4 UI 复用 ElicitationDialog。
      const elicitation = isPlainRecord(payload.input) ? payload.input : {};
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: {
            interaction: MCP_ELICITATION_INTERACTION,
            serverName: elicitation.serverName,
            requestedSchema: elicitation.requestedSchema,
          },
          questions: mcpElicitationQuestions(payload.reason, elicitation.requestedSchema),
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    if (isExitPlanModeToolName(payload.toolName)) {
      // ExitPlanMode 复用 userInput/elicitation 通道承载计划审批反馈；
      // 普通 permission payload 无法表达 approve/custom feedback 的业务语义。
      return {
        interactionId,
        kind: "userInput",
        anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
        createdAt: this.ms(event),
        payload: {
          kind: "userInput",
          prompt: payload.reason,
          freeText: true,
          toolCallId,
          toolName: payload.toolName,
          traceId: event.traceId,
          input: payload.input,
          schema: { interaction: "plan_approval", toolName: payload.toolName },
          questions: [createExitPlanModeApprovalQuestion(payload.reason)],
          ...(payload.origin ? { origin: payload.origin } : {}),
        },
      };
    }
    const askDisplay = toProtocolToolCallDisplay(payload.display);
    return {
      interactionId,
      kind: "permission",
      anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: this.ms(event),
      payload: {
        kind: "permission",
        toolCallId,
        toolName: payload.toolName,
        summary: payload.reason,
        detail: payload.input,
        freeText: true,
        ...(payload.approvalMode !== "user-once" &&
        payload.fullAccessSupported === true &&
        !payload.origin &&
        !payload.optionsPolicy
          ? {
              fullAccessOption: {
                optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
                label: "Full access",
                kind: "custom" as const,
                response: { decision: "deny" as const, reason: "Full access requires V4 approval" },
              },
            }
          : {}),
        ...(payload.origin ? { origin: payload.origin } : {}),
        ...(askDisplay ? { display: askDisplay } : {}),
        options: [
          ...buildProtocolPermissionOptions({
            approvalMode: payload.approvalMode,
            input: payload.input,
            suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
            ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
            toolName: payload.toolName,
          }).map((option) => ({
            optionId:
              option.kind === "allow_once"
                ? "allowOnce"
                : option.kind === "allow_always"
                  ? "allowAlways"
                  : option.optionId,
            label: option.name,
            // 会话免确认的 kind 映到闭集里的 allowAlways（排序槽位 / 样式与 always allow 同），
            // optionId 原样 allowSession——broker 靠它精确命中，GUI 靠 name 本地化。
            kind:
              option.kind === "allow_once"
                ? ("allowOnce" as const)
                : option.kind === "allow_always" ||
                    option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND
                  ? ("allowAlways" as const)
                  : ("deny" as const),
            response: option.response,
          })),
          // workflow Refine 只在 v4 投放（legacy 选项列表刻意不含，见 session-mapper 注释）。
          // 静态 response 是普通 deny：任何不认识该
          // optionId 的消费面（无 freeText 的应答）都退化为拒绝，反馈升级只发生在
          // interaction-broker 对 freeText 的特判里。
          ...(payload.toolName === CREATE_WORKFLOW_TOOL_NAME ||
          payload.toolName === AMEND_WORKFLOW_TOOL_NAME
            ? [
                {
                  optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
                  label: "Refine",
                  kind: "custom" as const,
                  response: { decision: "deny" as const, reason: "Denied" },
                },
              ]
            : []),
        ],
      },
    };
  }

  /**
   * 权限批准：把工具行推进到 running 并移除交互；未找到行时仍尝试清理交互，
   * 避免 stale 卡片残留。重复落定幂等。
   */
  private onPermissionResolved(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionResolvedPayload;
    return this.settlePermission(
      String(payload.toolCallId),
      payload.decision === "deny" ? "cancelled" : "running",
    );
  }

  /**
   * 权限拒绝：工具行置 cancelled 并移除交互；不产生 error，因为这是用户裁决而非执行故障。
   */
  private onPermissionDenied(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as PermissionDeniedPayload;
    return this.settlePermission(String(payload.toolCallId), "cancelled");
  }

  /**
   * Workspace hook 审核请求：创建 workspaceHookReview 交互（含 reviewFlowId/generation），
   * 同一 flow 的新 generation 会替换旧请求；旧 Runtime 的请求在 SessionResumed 时清除。
   * 只维护交互集合，不创建工具行。
   */
  private onWorkspaceHookReviewRequested(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewRequestedPayload;
    const request = workspaceHookReviewRequestPayloadSchema.parse(payload.request);
    const current = this.snapshot.pendingInteractions.find(
      (item) => item.payload.kind === "workspaceHookReview",
    );
    if (current?.payload.kind === "workspaceHookReview") {
      const verdict = verdictWorkspaceHookReviewRequest(current.payload, request);
      // 跨 flow 只能在 onSessionResumed 已清空旧 review 后接管（epoch 应用策略在
      // onSessionResumed）；其余 stale/replay/conflict 均不得覆盖或延长当前 authority。
      if (verdict !== "same_flow_advance") {
        return [];
      }
    }
    const interaction: PendingInteraction = {
      interactionId: request.interactionId,
      kind: "workspaceHookReview",
      anchorRowId: null,
      createdAt: request.createdAt,
      payload: request,
    };
    // 同 flow 的更高 generation 是唯一合法替换；Runtime 重启的跨 flow 接管必须先经过
    // SessionResumed 清旧 authority。这里仍原子替换，避免历史异常状态残留多个 review。
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (item) => item.payload.kind !== "workspaceHookReview",
    );
    pendingInteractions.push(interaction);
    return [{ op: "state.updated", patch: { pendingInteractions } }];
  }

  /**
   * Workspace hook 审核落定：移除对应交互（按 interactionId/flow 匹配）。
   * 幂等；不改变 hookInvocation 行，行状态由 hook 生命周期事件独立维护。
   */
  private onWorkspaceHookReviewSettled(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewSettledPayload;
    return this.removeWorkspaceHookReview(payload.interactionId);
  }

  /**
   * Workspace hook 审核被新请求取代：移除旧交互，避免同一 flow 出现两张卡片。
   */
  private onWorkspaceHookReviewSuperseded(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookReviewSupersededPayload;
    return this.removeWorkspaceHookReview(payload.interactionId);
  }

  private removeWorkspaceHookReview(interactionId: string): ConversationDelta[] {
    const pendingInteractions = this.snapshot.pendingInteractions.filter(
      (item) =>
        !(item.payload.kind === "workspaceHookReview" && item.interactionId === interactionId),
    );
    return pendingInteractions.length === this.snapshot.pendingInteractions.length
      ? []
      : [{ op: "state.updated", patch: { pendingInteractions } }];
  }

  /**
   * 软门禁:处理 WorkspaceHookAdmissionUpdated 事件。
   *
   * pendingCount > 0 → 写入 snapshot.workspaceHookAdmission(提示条出现);
   * pendingCount === 0 → 置 null(提示条消失)。
   */
  private onWorkspaceHookAdmissionUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as WorkspaceHookAdmissionUpdatedPayload;
    const workspaceHookAdmission =
      payload.pendingCount === 0
        ? null
        : {
            pendingCount: payload.pendingCount,
            bundleDigest: payload.bundleDigest,
            ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
          };
    return [{ op: "state.updated", patch: { workspaceHookAdmission } }];
  }

  /**
   * 通用阻塞交互的自动裁决结果（如命令确认）：把 resolution 写回 pendingInteraction，
   * 保留卡片供 UI 展示“已自动处理”，不直接删除。找不到交互时幂等返回空。
   */
  private onUserInputAutoResolutionUpdated(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
    let changed = false;
    const pendingInteractions = this.snapshot.pendingInteractions.map((interaction) => {
      if (
        interaction.interactionId !== payload.interactionId ||
        interaction.payload.kind !== "userInput"
      ) {
        return interaction;
      }
      changed = true;
      return {
        ...interaction,
        autoResolution: payload.autoResolution,
      };
    });
    return changed ? [{ op: "state.updated", patch: { pendingInteractions } }] : [];
  }

  /**
   * 权限落定：更新工具行状态（approved→running、denied→cancelled）并移除对应
   * pendingInteraction。只处理已存在的行/交互，幂等；迟到的重复落定不改终态。
   */
  private settlePermission(toolCallId: string, status: ToolCallRow["status"]): ConversationDelta[] {
    const deltas: ConversationDelta[] = [];
    const row = this.findToolRow(toolCallId);
    if (row) {
      const next: ToolCallRow = { ...row, status };
      delete next.approvalInteractionId;
      deltas.push({ op: "row.upserted", row: next });
    }
    const remaining = this.snapshot.pendingInteractions.filter(
      (item) =>
        !(
          (item.payload.kind === "permission" || item.payload.kind === "userInput") &&
          item.payload.toolCallId === toolCallId
        ),
    );
    if (remaining.length !== this.snapshot.pendingInteractions.length) {
      deltas.push({
        op: "state.updated",
        patch: { pendingInteractions: remaining },
      });
    }
    return deltas;
  }

  // ── turn-steer 队列──

  /**
   * 输入入队/原地编辑：把 pendingInput 投影成 QueueItem（含完整 intent、delivery、
   * order、highspeed、toolDisallowlist），并以 state.updated 整键替换 queue。
   *
   * 同 id 重入 = editQueueItem 原地更新（保位），新 id = 追加；绝不能 filter+append
   * 把编辑项移到队尾，破坏 queueContentIndependence 的位置语义。
   * 旧事件缺 intent/delivery 时按 followupMode 兜底，但不得读取当前会话补值。
   * 投递侧表 deliveryByPendingInputId 同步维护，供 drain 时确定是否拆轮。
   */
  private onTurnSteerQueued(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerQueuedPayload;
    const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
    const existingIndex = this.snapshot.queue.items.findIndex(
      (item) => item.queueItemId === queueItemId,
    );
    const existing = existingIndex >= 0 ? this.snapshot.queue.items[existingIndex] : undefined;
    // queued 事件的 admittedDelivery 只能是 queue/guide。若读到早期或损坏事件里的
    // startNow，必须以实际 queue delivery 为准，不能让投影声称输入已立即启动。
    const admittedDelivery: "queue" | "guide" =
      payload.intent?.admittedDelivery === "queue" || payload.intent?.admittedDelivery === "guide"
        ? payload.intent.admittedDelivery
        : (payload.delivery ??
          (existing?.delivery.admitted === "queue" || existing?.delivery.admitted === "guide"
            ? existing.delivery.admitted
            : this.snapshot.config.followupMode === "guide"
              ? "guide"
              : "queue"));
    const requestedDelivery =
      payload.intent?.requestedDelivery ?? existing?.delivery.requested ?? admittedDelivery;
    const fallbackReasonCode =
      payload.intent?.fallbackReasonCode ?? existing?.delivery.fallbackReasonCode;
    // Bug 根因：队列投影曾漏掉 intent.highspeed，自动和手动提升都因此把有效卡误判为不存在。
    const highspeed = payload.intent?.highspeed ?? existing?.highspeed;
    const nextItem: QueueItem = {
      queueItemId,
      kind:
        payload.intent?.kind === "compact" || payload.commandKind === "compact"
          ? ("compact" as const)
          : payload.intent?.kind === "sendGoalCommand" || payload.commandKind === "sendGoalCommand"
            ? ("sendGoalCommand" as const)
            : (existing?.kind ?? ("sendText" as const)),
      text: payload.input,
      sourceCommandId:
        payload.intent?.sourceCommandId ??
        existing?.sourceCommandId ??
        payload.inputId ??
        payload.pendingInputId,
      clientId: payload.intent?.clientId ?? existing?.clientId ?? "cli",
      attachments: payload.intent?.attachmentRefs ?? existing?.attachments ?? [],
      ...((payload.intent?.source ?? existing?.source)
        ? { source: payload.intent?.source ?? existing?.source }
        : {}),
      // QueueItem 同时是提升执行的输入，不只是 UI 展示；漏字段会让新 Turn 沿用旧权限／模型。
      // 旧的正文编辑事件可能没有 intent，只能保留同项原事实，不能读取当前 Session 补值。
      modelSelection: payload.intent?.modelSelection ?? existing?.modelSelection,
      mode: payload.intent?.mode ?? existing?.mode,
      planEnabled: payload.intent?.planEnabled ?? existing?.planEnabled,
      sharedContextRefs: payload.intent?.sharedContextRefs ?? existing?.sharedContextRefs,
      provenance: payload.intent?.provenance ?? existing?.provenance,
      // 排队事件和原地编辑都必须保留可信接入来源，不能在 UI 投影时丢掉发送者。
      ...((payload.intent?.inputOrigin ?? existing?.inputOrigin)
        ? { inputOrigin: payload.intent?.inputOrigin ?? existing?.inputOrigin }
        : {}),
      ...((payload.intent?.conversationQuotes ?? existing?.conversationQuotes)
        ? { conversationQuotes: payload.intent?.conversationQuotes ?? existing?.conversationQuotes }
        : {}),
      ...((payload.intent?.botGroupSource ?? existing?.botGroupSource)
        ? { botGroupSource: payload.intent?.botGroupSource ?? existing?.botGroupSource }
        : {}),
      delivery: {
        requested: requestedDelivery,
        admitted: admittedDelivery,
        ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
      },
      order: {
        admissionSeq:
          payload.intent?.admissionSeq ?? existing?.order.admissionSeq ?? event.sequenceNumber,
        queuePosition:
          payload.intent?.queuePosition ??
          existing?.order.queuePosition ??
          Math.max(0, (payload.queueLength ?? 1) - 1),
      },
      steer:
        !payload.intent && !payload.delivery && existing
          ? existing.steer
          : fallbackReasonCode
            ? { state: "fellBack", reasonCode: fallbackReasonCode }
            : admittedDelivery === "guide"
              ? { state: "steering" }
              : { state: "notRequested" },
      dispatch: { state: "queued" },
      ...(highspeed ? { highspeed } : {}),
      ...(payload.toolDisallowlist ? { toolDisallowlist: [...payload.toolDisallowlist] } : {}),
      admittedAt: payload.intent?.admittedAt ?? existing?.admittedAt ?? this.ms(event),
    };
    // 投递语义侧表：payload 未带（旧 runtime 事件）时按当前 followupMode 兜底。
    this.deliveryByPendingInputId.set(payload.pendingInputId, admittedDelivery);
    // 同 id 重入 = editQueueItem 原地更新（保位）；新 id = 追加。旧逻辑 filter+append
    // 会把编辑项移到队尾，破坏 queueContentIndependence 的位置语义。
    const items =
      existingIndex >= 0
        ? this.snapshot.queue.items.map((item, index) =>
            index === existingIndex ? nextItem : item,
          )
        : [...this.snapshot.queue.items, nextItem];
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  /**
   * 投递调度态变化（queued / reserved 等）：只更新已存在 queue item 的 dispatch，
   * 不改变队列顺序或内容。目标 id 不在队列中时忽略（迟到/已消费事件）。
   */
  private onTurnSteerDispatchChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDispatchChangedPayload;
    if (
      !this.snapshot.queue.items.some(
        (candidate) => candidate.queueItemId === payload.pendingInputId,
      )
    ) {
      return [];
    }
    const dispatch =
      payload.state === "queued"
        ? ({ state: "queued" } as const)
        : ({
            state: payload.state,
            reservationId: payload.reservationId,
          } as const);
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({
          ...this.snapshot.queue,
          items: this.snapshot.queue.items.map((candidate) =>
            candidate.queueItemId === payload.pendingInputId
              ? { ...candidate, dispatch }
              : candidate,
          ),
        }),
      },
    ];
  }

  /**
   * 投递裁决变化（requested→admitted，可能 fallback）：更新既有 item 的 delivery
   * 与 steer=fellBack，并刷新投递侧表。只对仍在队列中的项生效。
   */
  private onTurnSteerDeliveryChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDeliveryChangedPayload;
    const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
    if (!this.snapshot.queue.items.some((item) => item.queueItemId === queueItemId)) {
      return [];
    }
    this.deliveryByPendingInputId.set(payload.pendingInputId, payload.admittedDelivery);
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({
          ...this.snapshot.queue,
          items: this.snapshot.queue.items.map((item) =>
            item.queueItemId === queueItemId
              ? {
                  ...item,
                  delivery: {
                    requested: payload.requestedDelivery,
                    admitted: payload.admittedDelivery,
                    fallbackReasonCode: payload.fallbackReasonCode,
                  },
                  steer: {
                    state: "fellBack",
                    reasonCode: payload.fallbackReasonCode,
                  },
                }
              : item,
          ),
        }),
      },
    ];
  }

  /**
   * queue/guide 被消费：为每条输入生成 realUser userInput 行，并从 queue 删除。
   *
   * 文本/messageId 优先取事件自带的 drainedInputs，不再依赖内存 queue 状态；旧事件
   * 回退查表。delivery=queue 表示 product turn 边界 → splitProductTurn；guide 则内联
   * 当前轮、标记 guided 并开 guided work segment。带 messageId 的项注册完整 canonical
   * edit target，缺 messageId 只可展示，不暴露无法执行的 edit action。
   * 这是 row.appended + 可能的 turnHeader upsert/state.updated 的混合路径。
   */
  private onTurnSteerDrained(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDrainedPayload;
    const runtimeTurnId = String(
      payload.targetTurnId ?? event.turnId ?? this.currentTurnId ?? "turn-unknown",
    );
    // drain 事实优先自带文本/messageId（drainedInputs），
    // 投影不再依赖内存 queue 状态取文本——旧实现查不到 queue item 就静默 continue，
    // 用户输入从 queue 消失后也不进 history。旧事件（无 drainedInputs）回退查表。
    const items =
      payload.drainedInputs ??
      payload.pendingInputIds.flatMap((pendingInputId, index) => {
        const queueItem = this.snapshot.queue.items.find(
          (candidate) => candidate.queueItemId === pendingInputId,
        );
        if (!queueItem) return [];
        const intent: TurnInputIntentMetadata = {
          sourceCommandId: queueItem.sourceCommandId,
          queueItemId: queueItem.queueItemId,
          clientId: queueItem.clientId,
          kind: queueItem.kind,
          text: queueItem.text,
          ...(queueItem.modelSelection ? { modelSelection: queueItem.modelSelection } : {}),
          ...(queueItem.mode ? { mode: queueItem.mode } : {}),
          ...(queueItem.planEnabled !== undefined ? { planEnabled: queueItem.planEnabled } : {}),
          admissionSeq: queueItem.order.admissionSeq,
          admittedAt: queueItem.admittedAt,
          requestedDelivery: queueItem.delivery.requested,
          admittedDelivery: queueItem.delivery.admitted,
          queuePosition: queueItem.order.queuePosition,
          ...(queueItem.delivery.fallbackReasonCode
            ? { fallbackReasonCode: queueItem.delivery.fallbackReasonCode }
            : {}),
          attachmentRefs: queueItem.attachments,
        };
        return [
          {
            pendingInputId,
            messageId: payload.injectedMessageIds?.[index],
            text: queueItem.text,
            delivery: this.deliveryByPendingInputId.get(pendingInputId),
            intent,
          },
        ];
      });

    const deltas: ConversationDelta[] = [];
    for (const item of items) {
      const delivery =
        item.delivery ?? this.deliveryByPendingInputId.get(item.pendingInputId) ?? "queue";
      // queue 消费 = product turn 边界（每条一轮：收口上一段
      // header、开新 turnHeader、后续 assistant 归新轮）；guide steer 内联当前轮。
      if (delivery === "queue") {
        deltas.push(
          ...this.splitProductTurn(
            event,
            runtimeTurnId,
            item.messageId ? String(item.messageId) : undefined,
          ),
        );
      }
      const messageId = item.messageId ? String(item.messageId) : null;
      const entityId = messageId ?? item.pendingInputId;
      const productTurnId = this.turnIdOf(event);
      const rootSourceCommandId =
        item.intent?.provenance?.sourceCommandId ?? item.intent?.sourceCommandId;
      const row = {
        ...this.rowBase(event, productTurnId, entityId),
        kind: "userInput" as const,
        text:
          item.intent?.conversationQuotes || item.intent?.botGroupSource
            ? (item.intent.text ?? item.text)
            : item.text,
        origin: "realUser" as const,
        ...(delivery === "guide" ? { guided: true as const } : {}),
        ...(item.intent?.sourceCommandId ? { sourceCommandId: item.intent.sourceCommandId } : {}),
        ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
        ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
        ...(item.intent?.conversationQuotes
          ? { conversationQuotes: item.intent.conversationQuotes }
          : {}),
        ...(item.intent?.botGroupSource ? { botGroupSource: item.intent.botGroupSource } : {}),
        ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
        ...(item.intent?.highspeed ? { highspeed: item.intent.highspeed } : {}),
        ...(item.intent?.attachmentRefs?.length ? { attachments: item.intent.attachmentRefs } : {}),
        ...(item.intent?.source ? { source: item.intent.source } : {}),
      };
      // queue/guide 消费后的 real-user row 与普通 TurnStarted 共用完整 canonical target；
      // 缺 messageId 的旧事件仍只可展示，不暴露无法执行的 edit action。
      this.registerCanonicalUserRowTarget(
        row.rowId,
        entityId,
        messageId && item.intent?.kind !== "compact"
          ? {
              entityId,
              productTurnId,
              transcriptMessageId: messageId,
              coveredByStableCompact: false,
              intent: {
                kind: item.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
                text: item.intent?.text ?? item.text,
                ...(item.intent?.sourceCommandId
                  ? { sourceCommandId: item.intent.sourceCommandId }
                  : {}),
                ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
                ...(item.intent?.conversationQuotes
                  ? { conversationQuotes: item.intent.conversationQuotes }
                  : {}),
                ...(item.intent?.botGroupSource
                  ? { botGroupSource: item.intent.botGroupSource }
                  : {}),
                ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
                ...(item.intent?.attachmentRefs ? { attachments: item.intent.attachmentRefs } : {}),
                ...(item.intent?.queueItemId ? { queueItemId: item.intent.queueItemId } : {}),
                ...(item.intent?.admissionSeq !== undefined
                  ? { admissionSeq: item.intent.admissionSeq }
                  : {}),
                ...(item.intent?.admittedAt !== undefined
                  ? { admittedAt: item.intent.admittedAt }
                  : {}),
                ...(item.intent?.requestedDelivery
                  ? { requestedDelivery: item.intent.requestedDelivery }
                  : {}),
                ...(item.intent?.admittedDelivery
                  ? { admittedDelivery: item.intent.admittedDelivery }
                  : {}),
                ...(item.intent?.fallbackReasonCode
                  ? { fallbackReasonCode: item.intent.fallbackReasonCode }
                  : {}),
                ...(item.intent?.modelSelection
                  ? { modelSelection: item.intent.modelSelection }
                  : {}),
                ...(item.intent?.mode ? { mode: item.intent.mode } : {}),
                ...(item.intent?.planEnabled !== undefined
                  ? { planEnabled: item.intent.planEnabled }
                  : {}),
                ...(item.intent?.provenance ? { provenance: item.intent.provenance } : {}),
              },
            }
          : undefined,
      );
      if (delivery === "guide") {
        deltas.push(...this.openGuidedWorkSegment(event, row.entityId ?? item.pendingInputId));
      }
      deltas.push({ op: "row.appended", row });
      this.deliveryByPendingInputId.delete(item.pendingInputId);
    }
    return [...deltas, ...this.removeQueueItems(payload.pendingInputIds)];
  }

  /**
   * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
   * 收口上一段 productTurn 的 header（工时按边界拆分，加和 = 总工时），
   * 映射 runtimeTurnId → 新 productTurnId，开新 turnHeader。
   */
  /**
   * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
   *
   * 收口上一段 productTurn 的 turnHeader（state=completedSuccess、endedAt/activeMs，
   * workSegments 一并收口；工时按边界拆分，加和等于总工时），重映射
   * runtimeTurnId → 新 productTurnId，并建立新 header。只产 row.upserted/appended，
   * 不改 runtime 事实；后续 assistant 自动归入新轮。
   */
  private splitProductTurn(
    event: SessionEvent,
    runtimeTurnId: string,
    promotedUserMessageId?: string,
  ): ConversationDelta[] {
    const deltas: ConversationDelta[] = [];
    const previousProductTurnId =
      this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
    const headerRowId = this.turnHeaderRowIdByTurnId.get(previousProductTurnId);
    const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
    if (headerRow?.kind === "turnHeader") {
      const endedAt = this.ms(event);
      deltas.push({
        op: "row.upserted",
        row: {
          ...headerRow,
          state: "completedSuccess",
          endedAt,
          activeMs: Math.max(
            0,
            endedAt - (this.currentProductTurnStartedAtMs ?? headerRow.startedAt),
          ),
          ...(headerRow.workSegments
            ? {
                workSegments: this.completeWorkSegments(headerRow.workSegments, endedAt),
              }
            : {}),
        },
      });
    }
    const ordinal = (this.productTurnSplitOrdinalByRuntimeTurnId.get(runtimeTurnId) ?? 0) + 1;
    this.productTurnSplitOrdinalByRuntimeTurnId.set(runtimeTurnId, ordinal);
    // 旧实现用 runtimeTurnId + 本次进程内 ordinal 造 productTurnId；
    // cold hydration 会改用 hydrate-turn-N，同一条 queue 输入恢复前后无法保持身份。
    // promotion 已产生持久 user messageId，新 product turn 必须直接使用该权威身份；
    // 只有 legacy drain 缺 messageId 时才保留 ordinal fallback。
    const productTurnId = promotedUserMessageId ?? `${runtimeTurnId}~q${ordinal}`;
    this.productTurnIdByRuntimeTurnId.set(runtimeTurnId, productTurnId);
    this.runtimeTurnIdByProductTurnId.set(productTurnId, runtimeTurnId);
    this.currentProductTurnStartedAtMs = this.ms(event);
    const header = buildTurnHeaderRow(this.rowBase(event, productTurnId, productTurnId), {
      turnNumber: 0,
      input: "",
    });
    this.turnHeaderRowIdByTurnId.set(productTurnId, header.rowId);
    deltas.push({ op: "row.appended", row: header });
    return deltas;
  }

  // 工时按边界拆分：drain 切过轮的 runtimeTurn，最后一段 productTurn 的工时
  // = 最后一次边界到完成，不再用整段 runtime duration（否则两段加和超真实时长）。
  /**
   * 计算 turn 收口的有效工时：优先用当前 product turn 起点到事件的墙钟差（跨
   * queue 拆分后各段可加和）；起点未知时回退 runtime duration。返回 undefined
   * 表示不计工时（controlOnly），避免旧 UI 把 0 秒格式化成一秒。
   */
  private activeMsForCompletion(event: SessionEvent, runtimeDuration?: number): number | undefined {
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    // 稳定 user messageId 映射并不代表发生过 queue drain 切段；只有 split ordinal
    // 存在时才按边界时间计算最后一段工时。否则 cold 合成事件的展示时间戳跨度很小，
    // 会错误覆盖 transcript 已计算好的整轮 duration。
    if (!this.productTurnSplitOrdinalByRuntimeTurnId.has(runtimeTurnId)) return runtimeDuration;
    if (this.currentProductTurnStartedAtMs === null) return runtimeDuration;
    return Math.max(0, this.ms(event) - this.currentProductTurnStartedAtMs);
  }

  /**
   * 输入被丢弃：按 pendingInputId 从 queue 移除，并清投递侧表。
   * 只改 A 区 queue，不触碰已物化行；幂等（不存在时返回空）。
   */
  private onTurnSteerDiscarded(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TurnSteerDiscardedPayload;
    return this.removeQueueItems(payload.pendingInputIds);
  }

  /**
   * 输入被提升为真实排队执行（sendQueuedNow）：这是 user message 与 session_input
   * 同事务提交后的 durable signal，因此可以安全从 queue 投影移除该项。
   * 专门兜底 TurnSteerDiscarded 在链路边界丢失、UI 留下 promoting 幽灵项的场景。
   */
  private onSessionInputPromoted(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as SessionInputPromotedPayload;
    // sendQueuedNow 启动成功后，显式 TurnSteerDiscarded(promoted)
    // 可能在进程/链路边界丢失，使 UI 永久留下 promoting 幽灵项。
    // SessionInputPromoted 只在 user message + session_input 同事务提交后产生，
    // 因此它才是可以安全移除 queue 投影的 durable commit signal。
    return this.removeQueueItems([payload.pendingInputId]);
  }

  /**
   * 队列重排：按 orderedPendingInputIds 排序，未列出的项保持原相对序追加（防丢），
   * 并重写每项 queuePosition。顺序无变化时幂等返回空，避免无意义 revision。
   * 只改 A 区 queue，不触碰已物化行。
   */
  /** v4 queue 重排：按 orderedPendingInputIds 重排 queue rows（未列出的项保持相对顺序追加）。 */
  private onTurnSteerReordered(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { orderedPendingInputIds?: string[] };
    const order = payload.orderedPendingInputIds ?? [];
    const byId = new Map(this.snapshot.queue.items.map((item) => [item.queueItemId, item]));
    const ordered = order
      .map((id) => byId.get(id))
      .filter((item): item is (typeof this.snapshot.queue.items)[number] => item !== undefined);
    // 未在 order 里出现的项（防丢）追加保持原相对序。
    const orderedIds = new Set(order);
    const rest = this.snapshot.queue.items.filter((item) => !orderedIds.has(item.queueItemId));
    const reordered = [...ordered, ...rest];
    const items = reordered.map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
    // 顺序无变化则不产 delta（幂等）。
    if (
      items.length === this.snapshot.queue.items.length &&
      items.every((item, index) => item === this.snapshot.queue.items[index])
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  /**
   * setAutoDrain：翻转 queue.autoDrain 授权位。autoDrain 影响 held 派生
   * （heldQueueInputRequiresChoice）与 A 区可用性，故统一走 queuePatch 重算。
   * true 时清除 pauseReason；false 时置 manual。状态未变且无需重算时幂等返回空。
   */
  // setAutoDrain：queue.autoDrain 授权位翻转。autoDrain 影响 held 派生
  // （heldQueueInputRequiresChoice）与 A 区可用性 → 走 queuePatch 统一重算。
  private onQueueAutoDrainChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { autoDrain?: boolean };
    const autoDrain = payload.autoDrain ?? true;
    if (
      this.snapshot.queue.autoDrain === autoDrain &&
      (autoDrain || this.snapshot.queue.pauseReason === "manual")
    ) {
      return [];
    }
    const queue = { ...this.snapshot.queue, autoDrain };
    if (autoDrain) {
      delete queue.pauseReason;
    } else {
      queue.pauseReason = "manual";
    }
    return [
      {
        op: "state.updated",
        patch: this.queuePatch(queue),
      },
    ];
  }

  /**
   * setFollowupMode：config.followupMode 翻转（queue|guide）。它是 running 时
   * enqueue vs guide 的路由授权位，属于 A 区，故同一次 state.updated 里重算
   * availability 与 inputRouting（整键替换）。同值幂等。
   */
  // setFollowupMode：config.followupMode 翻转。followupMode 是 running 时
  // enqueue vs guide 的路由授权位（computeInputRouting）→ 改 config 后同步重算 A 区。
  private onFollowupModeChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as { mode?: "queue" | "guide" };
    const mode: "queue" | "guide" = payload.mode === "guide" ? "guide" : "queue";
    if (this.snapshot.config.followupMode === mode) return [];
    const nextConfig: ConversationSnapshot["config"] = {
      ...this.snapshot.config,
      followupMode: mode,
    };
    const context = this.deriveContext({});
    return [
      {
        op: "state.updated",
        patch: {
          config: nextConfig,
          availability: computeAvailability(context),
          inputRouting: computeInputRouting(context, mode),
        },
      },
    ];
  }

  /**
   * 协作模式切换：写 config.mode/planEnabled/planTransition，覆盖命令面与
   * enterPlanMode/exitPlanMode 工具路径（source=tool），UI 选择器因此能跟随工具切换。
   * 带 permissionGrant 时同时把指定 queue item 的 mode 改为 yolo，并记录 grant。
   * 日志一旦给出 mode 就标记 touched，种子不再覆盖。同值且无 grant 时幂等返回空。
   */
  /**
   * switchCollaborationMode：SessionModeChanged → config.mode。
   * 事件来源覆盖命令面（source=command）与 plan 工具路径（enterPlanMode/exitPlanMode，
   * source=tool）——两条路径共用这条投影，UI 的模式选择器因此也能跟随工具驱动的模式切换。
   */
  private onSessionModeChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      mode?: string;
      planEnabled?: boolean;
      source?: string;
      toolCallId?: string;
      permissionGrant?: { interactionId: string; queueItemIds: string[] };
    };
    const mode = typeof payload.mode === "string" ? payload.mode : "";
    // 日志事件触碰过 mode 后，种子不再覆盖（同值 return 也算触碰——日志有权威值）。
    if (mode) this.configModeTouchedByEvent = true;
    if (!mode) return [];
    const planEnabled = payload.planEnabled ?? mode === "plan";
    const planTransition =
      payload.source === "tool" && payload.toolCallId
        ? { toolCallId: payload.toolCallId, planEnabled }
        : this.snapshot.config.planTransition;
    if (
      this.snapshot.config.mode === mode &&
      this.snapshot.config.planEnabled === planEnabled &&
      planTransition === this.snapshot.config.planTransition &&
      !payload.permissionGrant
    )
      return [];
    return [
      {
        op: "state.updated",
        patch: {
          ...(payload.permissionGrant
            ? this.queuePatch({
                ...this.snapshot.queue,
                items: this.snapshot.queue.items.map((item) =>
                  payload.permissionGrant!.queueItemIds.includes(item.queueItemId)
                    ? { ...item, mode: "yolo" as const }
                    : item,
                ),
              })
            : {}),
          config: {
            ...this.snapshot.config,
            mode,
            planEnabled,
            planTransition,
            ...(payload.permissionGrant
              ? { permissionGrant: { interactionId: payload.permissionGrant.interactionId } }
              : {}),
          },
        },
      },
    ];
  }

  /**
   * Subagent row 与摘要投影在同一个 event transaction 内 materialize。
   * 旧 UI 在 spawn 后另查 session/subagents；7 个并发 child 中查询若恰好落在
   * 最后一个 session 持久化前，就会永久缓存 6，直到切换 Session 才重查。现在 renderer
   * 只消费这里随 row 一起提交的完整态，不再存在事件/查询双时钟。
   */
  /**
   * 判断本次基础归约是否需要再镜像 subagent 投影：只有涉及父子行/生命周期
   * 增量时才触发，避免普通 tool/stream 事件做无谓扫描。返回 false 时跳过
   * materializeSubagentProjection，保持事件摊销成本。
   */
  private shouldMaterializeSubagentProjection(reduced: readonly ConversationDelta[]): boolean {
    // 性能问题根因：cold hydration 曾让 checkpoint 等无关事件也扫描全部历史 rows。
    // 这里只在尚未发布的 batch accumulator 内按 materializer 的真实输入准入；live 与
    // strict fallback 仍走原路径，batch 之后直接写权威 manifest 的 store seed 不受影响。
    if (!this.hydrationAccumulator) return true;

    for (const delta of reduced) {
      switch (delta.op) {
        case "row.appended":
        case "row.upserted":
          if (delta.row.kind === "subagent" || this.findRow(delta.row.rowId)?.kind === "subagent") {
            return true;
          }
          break;
        case "row.delta":
          if (this.findRow(delta.rowId)?.kind === "subagent") return true;
          break;
        case "row.removed":
          // 后缀删除可能同时移除 subagent row；不为判定再预扫描一次 rows。
          return true;
        case "state.updated":
          if (
            delta.patch.pendingInteractions !== undefined ||
            delta.patch.backgroundWorks !== undefined
          ) {
            return true;
          }
          break;
        case "pluginUi.resourceUpdated":
        case "pluginUi.resourceListChanged":
        case "pluginUi.instanceClosed":
        case "pluginUi.appToolCall":
        // 非行 op：只动 workflowRuns 状态键，与 subagent 行投影的输入没有交集。
        case "workflowRun.updated":
        case "workflowRun.removed":
          break;
        default: {
          const exhaustiveDelta: never = delta;
          return exhaustiveDelta;
        }
      }
    }
    return false;
  }

  /**
   * 在同一次事件事务里重建 subagent 摘要与 subagent 行镜像。
   *
   * 输入是本次 reduced delta；输出额外的 row.upserted（摘要态变化）+ state.updated
   * （snapshot.subagents 整键替换）。只收集 rowId 索引里有效的 subagent 行，按时间线
   * 顺序恢复，排除 invalidSubagentChildSessionIds 中的幽灵 child。
   * revision 只在 manifest 真正变化时递增，避免每个 child 事件都触发 CAS。
   */
  private materializeSubagentProjection(
    reduced: readonly ConversationDelta[],
  ): ConversationDelta[] {
    const previous: SubagentProjectionState = this.snapshot.subagents ?? {
      revision: 0,
      childSessionIds: [],
      running: [],
      endedTotal: 0,
    };
    const previousRunningById = new Map(
      previous.running.map((item) => [item.childSessionId, item]),
    );
    const latestRowByChildId = new Map<string, SubagentRow>();
    const collectSubagentRow = (row: SubagentRow | null): void => {
      if (row?.childSessionId && !this.invalidSubagentChildSessionIds.has(row.childSessionId)) {
        latestRowByChildId.set(row.childSessionId, row);
      }
    };
    // 性能问题根因：旧实现先复制完整 rows 数组，再扫描所有普通 conversation rows。
    // subagentRowIdByAgentId 已是 reducer 查找用的派生索引；这里按 rowId 去重，并通过
    // rowIndexById 恢复当前时间线顺序；row.removed 应用后会清理已失效的 alias。
    const currentRowIds = new Set(this.subagentRowIdByAgentId.values());
    for (const delta of reduced) {
      if (delta.op === "row.upserted") {
        if (delta.row.kind === "subagent" || this.findRow(delta.row.rowId)?.kind === "subagent") {
          currentRowIds.add(delta.row.rowId);
        }
      } else if (delta.op === "row.delta" && this.findRow(delta.rowId)?.kind === "subagent") {
        currentRowIds.add(delta.rowId);
      }
    }
    const currentRows: Array<{ rowIndex: number; row: ConversationRow }> = [];
    for (const rowId of currentRowIds) {
      const rowIndex = this.rowIndexById.get(rowId);
      const row = rowIndex === undefined ? undefined : this.snapshot.rows.window[rowIndex];
      if (rowIndex !== undefined && row !== undefined) currentRows.push({ rowIndex, row });
    }
    currentRows.sort((left, right) => left.rowIndex - right.rowIndex);
    for (const { row } of currentRows) {
      collectSubagentRow(this.prospectiveSubagentRow(row, reduced, 0));
    }
    for (let index = 0; index < reduced.length; index += 1) {
      const delta = reduced[index]!;
      if (delta.op !== "row.appended") continue;
      collectSubagentRow(this.prospectiveSubagentRow(delta.row, reduced, index + 1));
    }

    let pendingInteractions = this.snapshot.pendingInteractions;
    let backgroundWorks = this.snapshot.backgroundWorks;
    for (const delta of reduced) {
      if (delta.op !== "state.updated") continue;
      if (delta.patch.pendingInteractions !== undefined) {
        pendingInteractions = delta.patch.pendingInteractions;
      }
      if (delta.patch.backgroundWorks !== undefined) {
        backgroundWorks = delta.patch.backgroundWorks;
      }
    }
    const waitingChildIds = new Set<string>();
    // workspace-hook-trust 新增的 hook review 交互 payload 没有 origin 字段，跳过守卫避免误读。
    for (const interaction of pendingInteractions) {
      if (!("origin" in interaction.payload)) continue;
      const origin = interaction.payload.origin;
      if (origin?.kind === "subagent") waitingChildIds.add(origin.childSessionId);
    }
    const blockedChildIds = new Set(
      backgroundWorks.flatMap((work) =>
        work.kind === "subagent" && work.status === "running" && work.blocked && work.childSessionId
          ? [work.childSessionId]
          : [],
      ),
    );

    const childSessionIds = [...latestRowByChildId.keys()];
    const running: RunningSubagentSummary[] = [];
    for (const [childSessionId, row] of latestRowByChildId) {
      if (row.status !== "running") continue;
      const previousItem = previousRunningById.get(childSessionId);
      const title = previousItem?.title || row.summaryText.trim() || row.subagentType;
      running.push({
        childSessionId,
        agentId: row.entityId,
        ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
        subagentType: row.subagentType,
        title,
        status: waitingChildIds.has(childSessionId)
          ? "waiting"
          : blockedChildIds.has(childSessionId)
            ? "blocked"
            : "running",
        ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
      });
    }
    running.sort(
      (left, right) =>
        (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
        right.childSessionId.localeCompare(left.childSessionId),
    );
    const endedTotal = childSessionIds.length - running.length;
    const semanticState = { childSessionIds, running, endedTotal };
    if (
      JSON.stringify(semanticState) ===
      JSON.stringify({
        childSessionIds: previous.childSessionIds,
        running: previous.running,
        endedTotal: previous.endedTotal,
      })
    ) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: {
          subagents: {
            revision: previous.revision + 1,
            ...semanticState,
          },
        },
      },
    ];
  }

  /**
   * 预测某行在本批 delta 应用后的样子（只处理 subagent 行），用于在同一次事务里
   * 计算摘要而不真正 apply。index 指出该行来自 reduced 的哪个位置，保证连续
   * append 的顺序正确；非 subagent 行返回 null。
   */
  private prospectiveSubagentRow(
    row: ConversationRow,
    reduced: readonly ConversationDelta[],
    startIndex: number,
  ): SubagentRow | null {
    let prospective: ConversationRow | null = row;
    for (let index = startIndex; index < reduced.length && prospective; index += 1) {
      const delta = reduced[index]!;
      switch (delta.op) {
        case "row.appended":
        case "state.updated":
        case "pluginUi.resourceUpdated":
        case "pluginUi.resourceListChanged":
        case "pluginUi.instanceClosed":
        case "pluginUi.appToolCall":
        // 非行 op：改不了这一行的 prospective 形态。
        case "workflowRun.updated":
        case "workflowRun.removed":
          break;
        case "row.upserted":
          if (delta.row.rowId === prospective.rowId) prospective = delta.row;
          break;
        case "row.delta":
          if (
            delta.rowId === prospective.rowId &&
            delta.path === "summaryText" &&
            prospective.kind === "subagent"
          ) {
            prospective = {
              ...prospective,
              summaryText: prospective.summaryText + delta.append,
            };
          }
          break;
        case "row.removed":
          if (prospective.rowId >= delta.fromRowId) prospective = null;
          break;
        default: {
          const exhaustiveDelta: never = delta;
          return exhaustiveDelta;
        }
      }
    }
    return prospective?.kind === "subagent" ? prospective : null;
  }

  // ── subagent 行镜像──
  // schema/UI 已有 subagent row，但旧 reducer 未消费 Subagent* 事件；
  // cold hydration 即使合成事件也无法恢复下钻行。这里让 live/cold 共用同一状态机。

  /**
   * 子代理启动：在父时间线创建/更新 subagent 行（含 childSessionId、任务摘要、
   * 状态 running、模型/模式等），并登记 subagentRowIdByAgentId 索引。
   * 若该 childSessionId 曾被判为幽灵，合法 resume 会先从排除集合移除，再恢复资格。
   * 只对父会话可见；子代理自己的工具事件由镜像路径处理，不重复建行。
   */
  private onSubagentSpawned(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const agentId = this.subagentAgentId(payload, event);
    const existing = this.findSubagentLifecycleRow(agentId, payload, event);
    if (existing) this.subagentRowIdByAgentId.set(agentId, existing.rowId);
    const childSessionId = this.stringPayload(payload, "childSessionId");
    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    const resumedBackgroundWork = this.resumedSubagentBackgroundWorkDelta(
      event,
      payload,
      agentId,
      childSessionId,
    );
    if (
      existing?.status === "running" &&
      (!childSessionId || childSessionId === existing.childSessionId) &&
      (!parentToolCallId || parentToolCallId === existing.parentToolCallId) &&
      (payload.background !== true || existing.backgrounded === true)
    ) {
      return resumedBackgroundWork ? [resumedBackgroundWork] : [];
    }
    if (existing) {
      const row: SubagentRow = {
        ...existing,
        status: "running",
        summaryText:
          this.stringPayload(payload, "description") ??
          this.stringPayload(payload, "prompt") ??
          existing.summaryText,
        // resume 事件携带的是 SendMessage call id，但 parentToolCallId 是 row 的创建锚点；
        // 已存在的锚点不能作为生命周期字段被覆盖，否则 UI 无法再关联原 Agent 行。
        ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        ...(payload.background === true ? { backgrounded: true as const } : {}),
        ...(payload.background === true ? { workId: agentId } : {}),
        startedAt: this.ms(event),
      };
      delete row.endedAt;
      return [
        { op: "row.upserted", row },
        ...(resumedBackgroundWork ? [resumedBackgroundWork] : []),
      ];
    }
    const row: SubagentRow = {
      ...this.rowBase(event, this.turnIdOf(event), agentId),
      kind: "subagent",
      ...(this.stringPayload(payload, "parentToolCallId")
        ? { parentToolCallId: this.stringPayload(payload, "parentToolCallId") }
        : {}),
      subagentType: this.stringPayload(payload, "agentType") ?? "subagent",
      status: "running",
      summaryText:
        this.stringPayload(payload, "description") ??
        this.stringPayload(payload, "summaryText") ??
        this.stringPayload(payload, "prompt") ??
        "",
      ...(this.stringPayload(payload, "childSessionId")
        ? { childSessionId: this.stringPayload(payload, "childSessionId") }
        : {}),
      ...(payload.background === true ? { backgrounded: true as const } : {}),
      ...(payload.background === true ? { workId: agentId } : {}),
      startedAt: this.ms(event),
    };
    this.subagentRowIdByAgentId.set(agentId, row.rowId);
    return [{ op: "row.appended", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
  }

  private resumedSubagentBackgroundWorkDelta(
    event: SessionEvent,
    payload: Record<string, unknown>,
    agentId: string,
    childSessionId: string | undefined,
  ): ConversationDelta | undefined {
    if (payload.background !== true || payload.resumed !== true || !childSessionId) {
      return undefined;
    }

    // SendMessage resume 直接进入 subagent port，不经过 Agent tool executor，
    // 因而不会产生 tracker 的 BackgroundTaskStarted。SubagentSpawned 已是单一启动事实，
    // 这里在同一次 V4 transaction 内补齐可取消 work，避免再引入第二个可失败事件。
    const previous = this.snapshot.backgroundWorks;
    const existing = previous.find((work) => work.workId === agentId);
    const title =
      this.stringPayload(payload, "description") ??
      this.stringPayload(payload, "prompt") ??
      existing?.title ??
      agentId;
    if (
      existing?.status === "running" &&
      existing.kind === "subagent" &&
      existing.title === title &&
      existing.childSessionId === childSessionId &&
      existing.cancellable === true
    ) {
      return undefined;
    }
    const next: BackgroundWorkSummary = {
      workId: agentId,
      kind: "subagent",
      title,
      status: "running",
      startedAt: this.ms(event),
      cancellable: true,
      anchorRowId: existing?.anchorRowId ?? null,
      childSessionId,
    };
    const backgroundWorks = existing
      ? previous.map((work) => (work.workId === agentId ? next : work))
      : [...previous, next];
    return { op: "state.updated", patch: { backgroundWorks } };
  }

  /**
   * 子代理回信：把 summaryText 增量追加到对应 subagent 行的 summaryText 字段
   * （row.delta，不推进 revision），让父时间线实时看到 child 的汇报。
   * 找不到 subagent 行或文本为空时幂等返回空；不创建新行、不改变轮次与 edit target。
   * 已停止/无效 child 的迟到消息仍可展示，但不再计入 running 摘要。
   */
  private onSubagentMessage(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const row = this.findSubagentRow(this.subagentAgentId(payload, event));
    const append =
      this.stringPayload(payload, "summaryText") ??
      this.stringPayload(payload, "text") ??
      this.stringPayload(payload, "message");
    if (!row || !append) return [];
    return [{ op: "row.delta", rowId: row.rowId, path: "summaryText", append }];
  }

  /**
   * 子代理停止：把 subagent 行收口为 stopped/failed/completed（带 endedAt/结果摘要），
   * 并从 running manifest 移除；已终态的行不被迟到事件复活。
   * 索引保留以便后续 mailbox/历史查询，不删除可见行。
   */
  private onSubagentStopped(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as Record<string, unknown>;
    const agentId = this.subagentAgentId(payload, event);
    const existing = this.findSubagentLifecycleRow(agentId, payload, event);
    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    const status = this.mapSubagentStatus(this.stringPayload(payload, "status"));
    const summaryText =
      this.stringPayload(payload, "summaryText") ??
      this.stringPayload(payload, "result") ??
      this.stringPayload(payload, "error") ??
      this.stringPayload(payload, "description") ??
      existing?.summaryText ??
      "";
    const row: SubagentRow = existing
      ? {
          ...existing,
          status,
          summaryText,
          endedAt: this.ms(event),
          // resumed child 的终态同样属于原 Agent row，只在旧 row 缺失锚点时补齐。
          ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
          ...(this.stringPayload(payload, "childSessionId")
            ? { childSessionId: this.stringPayload(payload, "childSessionId") }
            : {}),
        }
      : {
          ...this.rowBase(event, this.turnIdOf(event), agentId),
          kind: "subagent",
          ...(this.stringPayload(payload, "parentToolCallId")
            ? {
                parentToolCallId: this.stringPayload(payload, "parentToolCallId"),
              }
            : {}),
          subagentType: this.stringPayload(payload, "agentType") ?? "subagent",
          status,
          summaryText,
          ...(this.stringPayload(payload, "childSessionId")
            ? { childSessionId: this.stringPayload(payload, "childSessionId") }
            : {}),
          ...(payload.background === true ? { backgrounded: true as const } : {}),
          ...(payload.background === true ? { workId: agentId } : {}),
          endedAt: this.ms(event),
        };
    this.subagentRowIdByAgentId.set(agentId, row.rowId);
    return [{ op: existing ? "row.upserted" : "row.appended", row }];
  }

  // cancelBackgroundWork：后台任务生命周期（BackgroundTaskStarted/Updated/Completed）
  // → 维护 snapshot.backgroundWorks（后台工作面读它渲染 + cancel 入口）。
  // taskId≡workId 无需翻译；status 归一到 summary 的 4 值封闭枚举。
  /**
   * 后台任务生命周期（started/updated/completed）→ tool row 的后台态与
   * backgroundWorks 清单。转后台后行不再属于 foreground 收口集合，turn 结束时
   * 不得被标中断；完成/失败时补终态、输出、endedAt。
   * 只更新既有行与 A 区清单；找不到对应工具时忽略。
   */
  private onBackgroundTaskLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as {
      taskId?: string;
      toolName?: string;
      taskKind?: string;
      command?: string;
      description?: string;
      status?: string;
      cancellable?: boolean;
      blocked?: boolean;
      childSessionId?: string;
    };
    const workId = payload.taskId;
    if (!workId) return [];
    const prev = this.snapshot.backgroundWorks;
    const existing = prev.find((work) => work.workId === workId);
    const legacyKind = resolveZCodeBackgroundTaskControlKind(payload);
    // 新事件使用 runtime 的显式 taskKind；旧事件统一走 shared resolver，
    // 不能再在 reducer 内散落 Agent/Task/subagent 字符串分支。
    // "workflow" 是 workflow run（此前错标成 bash）；legacy resolver 里没有对应值，因为
    // legacy `Workflow` 工具刻意仍归 bash——两者是不同的东西，共用类别会让面板混在一起。
    const kind: BackgroundWorkSummary["kind"] =
      payload.taskKind === "subagent"
        ? "subagent"
        : payload.taskKind === "bash"
          ? "bash"
          : payload.taskKind === "workflow"
            ? "workflow"
            : legacyKind === "agent"
              ? "subagent"
              : legacyKind === "bash"
                ? "bash"
                : (existing?.kind ?? "bash");
    // 事件 status（running/completed/failed/timed_out/cancelled/spawn_error/lost）
    // → summary status（running/resultPending/failed/cancelled）。
    const rawStatus = payload.status ?? "running";
    const status: "running" | "resultPending" | "failed" | "cancelled" =
      rawStatus === "running"
        ? "running"
        : rawStatus === "cancelled"
          ? "cancelled"
          : rawStatus === "completed"
            ? "resultPending"
            : "failed";
    const title =
      payload.description?.trim() ||
      payload.command?.trim() ||
      existing?.title ||
      payload.toolName ||
      workId;
    const next: BackgroundWorkSummary = {
      workId,
      kind,
      title,
      status,
      startedAt: existing?.startedAt ?? this.ms(event),
      ...(status === "running" ? {} : { endedAt: this.ms(event) }),
      ...(typeof payload.cancellable === "boolean"
        ? { cancellable: payload.cancellable }
        : existing?.cancellable !== undefined
          ? { cancellable: existing.cancellable }
          : {}),
      ...(typeof payload.blocked === "boolean"
        ? { blocked: payload.blocked }
        : existing?.blocked !== undefined
          ? { blocked: existing.blocked }
          : {}),
      anchorRowId: existing?.anchorRowId ?? null,
      ...(payload.childSessionId
        ? { childSessionId: payload.childSessionId }
        : existing?.childSessionId
          ? { childSessionId: existing.childSessionId }
          : {}),
    };
    // 幂等：内容无变化不产 delta。
    if (
      existing &&
      existing.status === next.status &&
      existing.title === next.title &&
      existing.kind === next.kind &&
      existing.cancellable === next.cancellable &&
      existing.blocked === next.blocked &&
      existing.childSessionId === next.childSessionId
    ) {
      return [];
    }
    const backgroundWorks = existing
      ? prev.map((work) => (work.workId === workId ? next : work))
      : [...prev, next];
    return [{ op: "state.updated", patch: { backgroundWorks } }];
  }

  // ── dwf 实时运行态：DynamicWorkflowRunProgress → workflowRuns 状态键 ──
  // 一条引擎 RunEvent 一条会话事件，归约成键级整体替换的权威态。走 reducer 而不是侧通道，
  // 所以持久、可回放、冷恢复免费（先例：subagents 键）。
  //
  // 归约本体在 @zcode/shared 的 workflow-runs-reducer（与状态 schema 同居）：TUI 镜像要用
  // 同一份归约，两处各写一份就是两个时钟（docs/dynamic-workflow/launch.md「The inline card」）。
  // 留在这里的只有投影的非纯部分——从事件信封取载荷、把新旧状态之差发成键级增量。
  /**
   * 动态 workflow run 进度 → 仅更新 workflowRuns 状态键（live-only 派生数据）。
   * 该键在 revision 记账中豁免，不会推进 CAS 水位；不创建行、不参与冷恢复终态。
   */
  private onDynamicWorkflowRunProgress(event: SessionEvent): ConversationDelta[] {
    // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值就是"两边形状不漂移"
    // 的编译期闸（shared 不得反向依赖 contracts，所以入参类型只能结构化定义）。
    const envelope: WorkflowRunProgressEnvelope =
      event.payload as DynamicWorkflowRunProgressPayload;
    const prior = this.snapshot.workflowRuns;
    const workflowRuns = reduceWorkflowRunsState(prior, envelope);
    // null = 语义无变化（无效事件或同一条事件重放）：不产 delta，revision 不抬。
    if (workflowRuns === null) return [];
    // 发**差**而不是整键：一条引擎事件只动一个节点，整键重发是每事件 O(N) 字节、一条 run
    // 全程 O(N²)（workflow-runs-delta.ts 的文件头讲了这笔账怎么变成节点上界和 UI 卡死的）。
    // `applyAll(prior, diff(prior, next))` 与 next **逐字节**一致是被 property 测试钉住的契约，
    // 所以 applyEventInternal 把这串 delta 应用回去之后，this.snapshot.workflowRuns 仍是 next。
    return diffWorkflowRunsState(prior, workflowRuns);
  }

  /**
   * 按 item id 从 queue 移除并重写 queuePosition；只改 A 区 queue（经 queuePatch
   * 重算 availability/inputRouting），不触碰已物化 rows。无匹配项时返回空。
   * 同步清理投递侧表，防止后续同 id 事件误判投递方式。
   */
  private removeQueueItems(ids: readonly string[]): ConversationDelta[] {
    const idSet = new Set(ids);
    for (const id of ids) this.deliveryByPendingInputId.delete(id);
    const items = this.snapshot.queue.items
      .filter((item) => !idSet.has(item.queueItemId))
      .map((item, index) =>
        item.order.queuePosition === index
          ? item
          : { ...item, order: { ...item.order, queuePosition: index } },
      );
    if (items.length === this.snapshot.queue.items.length) return [];
    return [
      {
        op: "state.updated",
        patch: this.queuePatch({ ...this.snapshot.queue, items }),
      },
    ];
  }

  // ── config / usage ──

  /**
   * 模型选型：更新 config（provider/model/modelSelection/thought/thoughtLevels）与
   * usage.contextWindow 容量，并在 registry fallback 时写 modelTransition。
   *
   * 选型事件只表达意向，不落 modelChange marker（marker 归 onTurnStarted 按与上一轮
   * 实际选型比较后裁决）。显式 contextWindow=null 是清除窗口的权威事实，必须清空；
   * 缺省才保留旧值。traceId 为 hydration 哨兵时不算“日志触碰”，seedConfig 仍可收口。
   * 无 config/窗口/transition 变化时幂等返回空。属于 A 区整键替换。
   */
  private onModelSelected(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as ModelSelectedPayload;
    // Bug 原因：把 fresh child 身份另存为 pending side state 后，原子投影 clone/adopt
    // 漏复制该字段，实时 marker 会消失。显式 null 直接复用模型基线表达 ∅→X，
    // 公共投影不再识别 Subagent 身份；后续选型只更新 config，不覆盖上一轮实际模型。
    if (payload.previousModelSelection === null) {
      this.lastTurnModel = { kind: "sourceLess" };
    }
    const prev = this.snapshot.config;
    const provider = payload.modelSelection.providerId;
    const model = payload.modelSelection.modelId;
    const thought =
      payload.effectiveReasoningLevel ?? payload.modelSelection.options?.reasoningLevel ?? "";
    const modelSelection = cloneSparseModelSelection(payload.modelSelection);
    const thoughtLevels = payload.supportedThoughtLevels
      ? [...payload.supportedThoughtLevels]
      : prev.thoughtLevels;
    const contextWindow =
      payload.contextWindow === null
        ? null
        : payload.contextWindow !== undefined
          ? positiveInteger(payload.contextWindow, 0) || undefined
          : undefined;
    // Bug 原因：旧事件只更新 config，runtime 虽已切到新模型，历史 usage 的 maxTokens
    // 仍停在源模型，直到下一次 ModelComplete 才偶然校准。窗口属于已应用模型能力，
    // 必须在同一个 ModelSelected 中提交；usedTokens 仍保留历史上下文事实。
    if (contextWindow !== undefined) {
      this.contextWindowState.touchedByEvent = true;
      this.contextWindowState.maxTokens =
        contextWindow !== null && contextWindow > 0 ? contextWindow : null;
    }
    const previousContextWindow = this.snapshot.usage.contextWindow;
    if (previousContextWindow) {
      this.contextWindowState.usedTokens = previousContextWindow.usedTokens;
    }
    const contextWindowChanged =
      contextWindow !== undefined &&
      (contextWindow === null
        ? previousContextWindow !== null
        : previousContextWindow === null || previousContextWindow.maxTokens !== contextWindow);
    // 日志事件触碰过模型选型后，种子不再覆盖（同值 return 也算触碰）。
    // 冷恢复合成的 ModelSelected（HYDRATION_TRACE_ID）例外：它只是从 message 事实
    // 重建历史选型供 modelChange marker 使用，不是权威选型动作；重放后 seedConfig
    // 仍以 runtime 真值（resume 已回写的上次/草稿选型）收口。
    if (String(event.traceId) !== HYDRATION_TRACE_ID) {
      this.configModelTouchedByEvent = true;
      if (payload.supportedThoughtLevels !== undefined) {
        this.configThoughtLevelsTouchedByEvent = true;
      }
    }
    // 选型事件只更新 config，不在选型时落 modelChange
    // marker——切换动作是意向，marker 归 onTurnStarted 按「与上一轮实际选型不同」
    // 裁决（见彼处注释与 Bug 背景）。
    const configChanged = !(
      prev.provider === provider &&
      prev.model === model &&
      sameSparseModelSelection(prev.modelSelection, modelSelection) &&
      prev.thought === thought &&
      prev.thoughtLevels.length === thoughtLevels.length &&
      prev.thoughtLevels.every((value, index) => value === thoughtLevels[index])
    );
    const modelTransition =
      payload.origin === "registryFallback" &&
      payload.previousModelSelection != null &&
      (payload.previousModelSelection.providerId !== provider ||
        payload.previousModelSelection.modelId !== model)
        ? {
            eventId: String(event.id),
            origin: payload.origin,
            from: {
              provider: payload.previousModelSelection.providerId,
              model: payload.previousModelSelection.modelId,
            },
            to: { provider, model },
          }
        : undefined;
    if (!configChanged && !contextWindowChanged && modelTransition === undefined) {
      return [];
    }
    return [
      {
        op: "state.updated",
        patch: {
          ...(configChanged
            ? { config: { ...prev, modelSelection, provider, model, thought, thoughtLevels } }
            : {}),
          // Bug 原因：仅投影 config 会丢失“由 registry fallback 触发”的来源，
          // renderer 无法安全地区分自动恢复和显式/历史切换。保留事件 ID 与起止身份，
          // 具体 toast 仍只由客户端在实时 online delivery 边界触发。
          ...(modelTransition ? { modelTransition } : {}),
          ...(contextWindowChanged
            ? {
                usage: {
                  ...this.snapshot.usage,
                  // Bug 原因：null 是 registry 清除显式窗口的权威事件，必须清空整个
                  // usage.contextWindow；字段缺失才保留旧事件兼容语义。
                  contextWindow:
                    contextWindow === null
                      ? null
                      : previousContextWindow
                        ? { ...previousContextWindow, maxTokens: contextWindow }
                        : {
                            usedTokens: this.contextWindowState.usedTokens,
                            maxTokens: contextWindow,
                            autoCompactThresholdTokens: null,
                          },
                },
              }
            : {}),
        },
      },
    ];
  }

  /**
   * 单次模型往返完成：累计 usage、校准 contextWindow，并给 turnHeader 补
   * outputTokens/fileChanges。
   *
   * 只有主会话往返（querySource=main_turn，或缺省且 stopReason!=tool_internal）才能
   * 覆盖会话级 context 水位；subagent 的 usage 不是主水位，但其 fileChanges 仍投影到
   * child 自己的 header。length 截断且无 tool call 时记录 continuation 锚点，
   * 下一次 text_start 可续接同一行。终态同时清 apiRetry，避免“重新连接中”残留。
   * usage 的 state.updated 整键替换且不推进 revision（豁免高频派生）。
   */
  private onModelComplete(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as ModelCompletePayload;
    const retryClearDeltas = this.acceptsActiveModelEvent(event) ? this.setApiRetry(null) : [];
    // 与旧 reducer 同一裁决：只有主会话往返才能覆盖 context 水位。
    const isMainTurn =
      payload.querySource !== undefined
        ? payload.querySource === "main_turn"
        : payload.stopReason !== "tool_internal";
    if (isMainTurn) this.outputContinuationTextRowId = null;
    if (
      isMainTurn &&
      payload.stopReason?.trim().toLowerCase() === "length" &&
      payload.toolCallCount === 0
    ) {
      const lastVisibleRow = this.snapshot.rows.window.at(-1);
      if (
        lastVisibleRow?.kind === "assistantText" &&
        lastVisibleRow.turnId === this.turnIdOf(event) &&
        lastVisibleRow.state === "complete"
      ) {
        this.outputContinuationTextRowId = lastVisibleRow.rowId;
      }
    }
    // subagent ModelComplete 的 usage 仍不是主会话水位，但它携带的
    // fileChanges 是 child session 自己的 workspace 事实，必须独立投影到 child turn header。
    const supportsFileChangeSummary = isMainTurn || payload.querySource === "subagent";
    const usage = payload.usage as ModelUsage;
    const deltas: ConversationDelta[] = [];
    const turnId = this.turnIdOf(event);
    const headerRowId = this.turnHeaderRowIdByTurnId.get(turnId);
    const headerRow = headerRowId !== undefined ? this.findRow(headerRowId) : undefined;
    if (headerRow?.kind === "turnHeader") {
      const fileChanges =
        supportsFileChangeSummary && payload.fileChanges && payload.fileChanges.files > 0
          ? {
              fileChanges: {
                additions: payload.fileChanges.additions,
                deletions: payload.fileChanges.deletions,
                files: payload.fileChanges.files,
                // Bug 根因：该条件对象随后与 headerRow 展开合并，TS 会把字面量扩宽为
                // string，导致 CLI 启动前构建无法满足 TurnFileChangeSummary 契约。
                state: "active" as const,
              },
            }
          : {};
      if (isMainTurn || "fileChanges" in fileChanges) {
        deltas.push({
          op: "row.upserted",
          row: {
            ...headerRow,
            ...fileChanges,
            // Bug 根因：Renderer 观察 running 快照的时机不可靠，continuous 可合并更新，
            // replayable 也可能首次恢复即终态。单 Turn token 必须在权威事件投影中累计。
            ...(isMainTurn
              ? { outputTokens: (headerRow.outputTokens ?? 0) + (usage.outputTokens ?? 0) }
              : {}),
          },
        });
      }
    }
    if (!isMainTurn) return [...deltas, ...retryClearDeltas];
    const usedTokens = getModelUsageContextTokens(usage) ?? 0;
    this.contextWindowState.usedTokens = usedTokens;
    const maxTokens = payload.contextWindow ?? this.contextWindowState.maxTokens;
    const cumulative = this.snapshot.usage.cumulative;
    deltas.push({
      op: "state.updated",
      patch: {
        usage: {
          // Bug 原因：registry 已显式清除窗口时，缺少 contextWindow 的 ModelComplete
          // 过去会用 0 重建对象，破坏未知容量语义。token 继续在侧状态和累计值中更新。
          contextWindow:
            maxTokens === null
              ? null
              : {
                  usedTokens,
                  maxTokens,
                  autoCompactThresholdTokens:
                    this.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                  ...(payload.cacheHit ? { cache: payload.cacheHit } : {}),
                  ...(payload.contextUsageBreakdown && payload.contextUsageBreakdown.length > 0
                    ? { breakdown: payload.contextUsageBreakdown }
                    : {}),
                },
          cumulative: {
            inputTokens: cumulative.inputTokens + (usage.inputTokens ?? 0),
            outputTokens: cumulative.outputTokens + (usage.outputTokens ?? 0),
            cacheReadTokens: cumulative.cacheReadTokens + (usage.cacheReadTokens ?? 0),
            cacheWriteTokens: cumulative.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
          },
        },
      },
    });
    // ModelComplete 是缺少 network completed 事件时的成功兜底，不能让重试提示悬挂。
    deltas.push(...retryClearDeltas);
    return deltas;
  }

  // ── compact marker（compact 命令效果）──
  // 同一 operationId 全生命周期占同一 marker row：running → success/failed/noop/cancelled。
  // 归属：marker 落在事件到达时的行尾，客户端零归属逻辑。

  /**
   * compact 生命周期：同一 operationId 全程复用同一条 timelineMarker 行
   * （running → success/failed/noop/cancelled），终态保留已知 token 计数、summaryRef。
   *
   * success 时用 tailStart/anchor messageId 定位覆盖边界，把边界之前的 edit target
   * 标记 coveredByStableCompact，后续 edit 需额外裁决；marker 落在事件到达时的行尾，
   * 客户端零归属逻辑。只更新既有 marker/状态，不重排 rows。
   */
  private onCompactLifecycle(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as CompactLifecyclePayload & {
      anchorMessageId?: string;
      tailStartMessageId?: string;
    };
    const existingRowId = this.compactMarkerRowIdByOperationId.get(payload.operationId);
    const existingRow = existingRowId !== undefined ? this.findRow(existingRowId) : undefined;
    const prev =
      existingRow?.kind === "timelineMarker" && existingRow.marker.type === "compact"
        ? existingRow.marker
        : undefined;

    const status = mapCompactMarkerStatus(payload.status);
    if (status === "success") {
      const coverageMessageId = payload.tailStartMessageId ?? payload.anchorMessageId;
      const coverageRowId = coverageMessageId ? this.rowIdForMessageId(coverageMessageId) : null;
      if (coverageRowId !== null) {
        this.stableCompactCoverageBoundaryRowId = Math.max(
          this.stableCompactCoverageBoundaryRowId ?? 0,
          coverageRowId,
        );
        for (const [rowId, entityId] of this.entityIdByRowId) {
          if (rowId > this.stableCompactCoverageBoundaryRowId) continue;
          const target = this.editTargetByEntityId.get(entityId);
          if (target && !target.coveredByStableCompact) {
            this.editTargetByEntityId.set(entityId, {
              ...target,
              coveredByStableCompact: true,
            });
          }
        }
      }
    }
    const tokensAfter =
      payload.truePostCompactTokenCount ?? payload.postCompactTokenCount ?? prev?.tokensAfter;
    const marker: TimelineMarkerPayload = {
      type: "compact",
      origin: prev?.origin ?? mapCompactMarkerOrigin(payload.trigger),
      status,
      // 终态事件才带 token 计数；upsert 时保留已知值（retry 不清零）。
      ...(payload.preCompactTokenCount !== undefined || prev?.tokensBefore !== undefined
        ? { tokensBefore: payload.preCompactTokenCount ?? prev?.tokensBefore }
        : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      // summary 全文按 ref 拉（同 toolOutput/get）；以 summaryMessageId 占位。
      ...(payload.summaryMessageId !== undefined || prev?.summaryRef
        ? {
            summaryRef:
              payload.summaryMessageId !== undefined
                ? String(payload.summaryMessageId)
                : prev?.summaryRef,
          }
        : {}),
    };

    const deltas: ConversationDelta[] = [];
    if (existingRow?.kind === "timelineMarker") {
      deltas.push({
        op: "row.upserted",
        row: {
          ...existingRow,
          marker,
          ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
        },
      });
    } else {
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.turnIdOf(event), String(payload.operationId)),
        kind: "timelineMarker",
        lane: "assistantWork",
        marker,
        ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
      };
      this.compactMarkerRowIdByOperationId.set(payload.operationId, row.rowId);
      deltas.push({ op: "row.appended", row });
    }

    // compacting 进出 activeWorks（guard 同源派生：compactOperationLock /
    // compactingAcceptsFutureInput 由此驱动，与 formal-proof evaluateCompacting 对齐）。
    const otherWorks = this.snapshot.control.activeWorks.filter((work) => work.kind !== "compact");
    if (status === "running") {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          activeWorks: [...otherWorks, { kind: "compact", startedAt: this.ms(event) }],
          canStop: true,
          stopState: "stoppable",
          stopTargetKind: otherWorks.length > 0 ? "mixed" : "compact",
        }),
      });
    } else {
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch({
          activeWorks: otherWorks,
          ...(otherWorks.length === 0
            ? {
                canStop: false,
                stopState: "idle" as const,
                stopTargetKind: "unknown" as const,
              }
            : {}),
        }),
      });
    }

    // compact 成功 → context 水位立即回落（usage.contextWindow 更新）。
    if (status === "success" && tokensAfter !== undefined) {
      this.contextWindowState.usedTokens = tokensAfter;
      const maxTokens =
        this.snapshot.usage.contextWindow?.maxTokens ?? this.contextWindowState.maxTokens;
      deltas.push({
        op: "state.updated",
        patch: {
          usage: {
            ...this.snapshot.usage,
            contextWindow:
              maxTokens === null
                ? null
                : {
                    usedTokens: tokensAfter,
                    maxTokens,
                    autoCompactThresholdTokens:
                      this.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                  },
          },
        },
      });
    }
    return deltas;
  }

  // ── goal 状态机──

  /**
   * 目标（target）变更：把最新目标整键写入 control.target（A 区，revision +1）。
   * 目标可能来自用户设置/生成器/历史恢复；旧目标不保留在 control，历史由事件日志负责。
   * 不触碰 rows，也不在此推导 goal 状态。
   */
  private onTargetChanged(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TargetChangedPayload;
    switch (payload.action) {
      case "set": {
        if (!payload.target) return [];
        // 新目标：iteration/verifications 归零。
        // goalSet 是 stateOnly——不产 timeline row（旧实现
        // 的 goalSet marker 是「进 window 渲染 null」的隐形行，污染 turn 分组判定），
        // 目标展示归 goal 面板/状态区。
        const goal: GoalState = {
          targetId: payload.target.targetID,
          objective: payload.target.objective,
          summaryTitle: payload.target.summaryTitle,
          timeUsedSeconds: payload.target.timeUsedSeconds,
          activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
          status: mapGoalStatus(payload.target.status),
          iteration: 0,
          verifications: [],
          iterations: [],
        };
        return [{ op: "state.updated", patch: this.goalPatch(goal) }];
      }
      case "cleared": {
        if (!this.snapshot.goal) return [];
        return [{ op: "state.updated", patch: this.goalPatch(null) }];
      }
      default: {
        // status_updated / run_started / run_finished / usage_accounted / summary_updated：
        // 同步刷新计时与摘要标题。旧实现只比较 status，会吞掉 1 秒以上 run accounting
        // 和 summaryTitle 更新，导致刷新前后的 UI 不一致。
        const goal = this.snapshot.goal;
        if (!goal || !payload.target) return [];
        const nextGoal: GoalState = {
          ...goal,
          targetId: payload.target.targetID,
          objective: payload.target.objective,
          summaryTitle: payload.target.summaryTitle,
          timeUsedSeconds: payload.target.timeUsedSeconds,
          activeRunStartedAtMs: payload.target.activeRunStartedAtMs ?? null,
          status: mapGoalStatus(payload.target.status),
        };
        if (
          nextGoal.targetId === goal.targetId &&
          nextGoal.objective === goal.objective &&
          nextGoal.summaryTitle === goal.summaryTitle &&
          nextGoal.timeUsedSeconds === goal.timeUsedSeconds &&
          nextGoal.activeRunStartedAtMs === goal.activeRunStartedAtMs &&
          nextGoal.status === goal.status
        ) {
          return [];
        }
        return [{ op: "state.updated", patch: this.goalPatch(nextGoal) }];
      }
    }
  }

  /**
   * 目标完成校验（verifier boundary）：推进 goal.status/iteration、写验证结果，
   * 并在时间线维护 verify marker（按 lifecycleKey 去重复用同一行）。
   *
   * 这是唯一允许推进 goal 轮次的入口；TodoWrite 只能更新当前轮。
   * 验证通过/未满足/失败决定 active→verified/active/paused 等后续可用性；
   * 只产 row.upserted + state.updated（goal 整键替换）。
   */
  private onTargetVerification(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as TargetCompletionVerificationPayload;
    const goal = this.snapshot.goal;
    // goal verify boundary 不依赖 goal 状态在场。
    // 冷恢复合成事件流没有 TargetChanged → goal 为 null，旧实现在此整条丢弃
    // verification 事实，刷新后 goalVerify marker 消失。现在 marker
    // 恒生成/恒更新；goal 状态 patch 仍只在 goal 在场时生效。

    if (payload.status === "started") {
      const iteration = payload.goalIteration ?? (goal ? goal.iteration + 1 : 1);
      const lifecycleKey = this.goalVerifyLifecycleKey(payload, iteration);
      const verifyingGoal = goal ? { ...goal, status: "verifying" as const, iteration } : undefined;
      const otherWorks = this.snapshot.control.activeWorks.filter(
        (work) => work.kind !== "goalVerifier",
      );
      const controlDelta: ConversationDelta = {
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: "running",
            sessionEnded: false,
            activeWorks: [
              ...otherWorks,
              {
                kind: "goalVerifier",
                ...(payload.foregroundExecutionId
                  ? { foregroundExecutionId: payload.foregroundExecutionId }
                  : {}),
                startedAt: this.ms(event),
              },
            ],
            canStop: true,
            stopState: "stoppable",
            stopTargetKind: otherWorks.length > 0 ? ("mixed" as const) : ("goalVerifier" as const),
            lastError: null,
            apiRetry: null,
          },
          verifyingGoal,
        ),
      };
      // GV-identity：同 targetId+iteration 的重试（新 verificationId）复用同一 marker
      // 行回到 running，不长出第二个 marker。
      const existingRowId = this.goalVerifyMarkerRowIdByLifecycleKey.get(lifecycleKey);
      const existingRow = existingRowId !== undefined ? this.findRow(existingRowId) : undefined;
      if (existingRow?.kind === "timelineMarker") {
        return [
          {
            op: "row.upserted",
            row: {
              ...existingRow,
              marker: { type: "goalVerify", iteration, outcome: "running" },
            },
          },
          controlDelta,
        ];
      }
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.goalVerifyTurnId(payload, event), lifecycleKey),
        kind: "timelineMarker",
        lane: "turnTailBoundary",
        marker: { type: "goalVerify", iteration, outcome: "running" },
      };
      this.goalVerifyMarkerRowIdByLifecycleKey.set(lifecycleKey, row.rowId);
      return [{ op: "row.appended", row }, controlDelta];
    }

    // 终态：completed（pass/notSatisfied 是有效结论）/ failed_closed（验证过程失败）
    // / cancelled（被 stop：过程未产出结论 → marker=failed(detail=cancelled)，goal 回 paused）。
    const iteration = payload.goalIteration ?? goal?.iteration ?? 1;
    const outcome: "pass" | "notSatisfied" | "failed" =
      payload.status === "completed"
        ? payload.verification?.passed
          ? "pass"
          : "notSatisfied"
        : "failed";
    const goalStatus: GoalState["status"] =
      payload.status === "cancelled"
        ? "paused"
        : payload.status === "failed_closed"
          ? "failed"
          : outcome === "pass"
            ? "verified"
            : "notSatisfied";

    const deltas: ConversationDelta[] = [];
    const lifecycleKey = this.goalVerifyLifecycleKey(payload, iteration);
    const markerRowId = this.goalVerifyMarkerRowIdByLifecycleKey.get(lifecycleKey);
    let anchorRowId: number | null = null;
    const markerRow = markerRowId !== undefined ? this.findRow(markerRowId) : undefined;
    const terminalMarker: TimelineMarkerPayload = {
      type: "goalVerify",
      iteration,
      outcome,
      ...(payload.status === "cancelled"
        ? { detail: "cancelled" }
        : payload.verification?.reason
          ? { detail: payload.verification.reason }
          : {}),
    };
    if (markerRow?.kind === "timelineMarker") {
      anchorRowId = markerRow.rowId;
      deltas.push({
        op: "row.upserted",
        row: { ...markerRow, marker: terminalMarker },
      });
    } else {
      // GV-terminal-only：boundary 按 lifecycleKey upsert——任一生命周期
      // 事件先到都能创建实体。旧实现终态找不到 started marker 就整条丢弃（冷恢复
      // 后到达的终态、started 事件丢帧都触发）。
      const row: TimelineMarkerRow = {
        ...this.rowBase(event, this.goalVerifyTurnId(payload, event), lifecycleKey),
        kind: "timelineMarker",
        lane: "turnTailBoundary",
        marker: terminalMarker,
      };
      this.goalVerifyMarkerRowIdByLifecycleKey.set(lifecycleKey, row.rowId);
      anchorRowId = row.rowId;
      deltas.push({ op: "row.appended", row });
    }

    const hadGoalVerifierWork = this.snapshot.control.activeWorks.some(
      (work) => work.kind === "goalVerifier",
    );
    const shouldPatchControl = hadGoalVerifierWork || this.snapshot.goal?.status === "verifying";
    const otherWorks = this.snapshot.control.activeWorks.filter(
      (work) => work.kind !== "goalVerifier",
    );
    const terminalPhase: SessionControl["phase"] =
      payload.status === "cancelled"
        ? "completedInterrupted"
        : payload.status === "failed_closed"
          ? "error"
          : "completedSuccess";
    const heldQueue =
      payload.status === "cancelled" &&
      payload.preserveQueueAutoDrainOnCancel !== true &&
      this.snapshot.queue.items.length > 0
        ? {
            ...this.snapshot.queue,
            autoDrain: false,
            pauseReason: "stopped" as const,
          }
        : undefined;

    // goal 不在场（冷恢复合成流）：marker 行仍要保留；只有当前 live control
    // 确实处于 verifier work 时才收口 control，避免 terminal-only 历史事实把 draft
    // 冷恢复快照误推进成 completed。
    if (!goal) {
      if (!shouldPatchControl) return deltas;
      deltas.push({
        op: "state.updated",
        patch: this.controlPatch(
          {
            phase: terminalPhase,
            sessionEnded: terminalPhase !== "error",
            activeWorks: otherWorks,
            ...(otherWorks.length === 0
              ? {
                  canStop: false,
                  stopState: "idle" as const,
                  stopTargetKind: "unknown" as const,
                }
              : {
                  stopTargetKind: "mixed" as const,
                }),
          },
          undefined,
          heldQueue,
        ),
      });
      return deltas;
    }

    // verifications 只记结论（cancelled 不是结论，不入摘要）；最近 N 条。
    const verifications =
      payload.status === "cancelled"
        ? goal.verifications
        : [
            ...goal.verifications,
            {
              iteration,
              outcome,
              at: this.ms(event),
              anchorRowId,
              ...(payload.verification?.reason ? { reason: payload.verification.reason } : {}),
              ...(payload.verification?.nextAction
                ? { nextAction: payload.verification.nextAction }
                : {}),
            },
          ].slice(-PROTOCOL_V4_LIMITS.goalVerificationsRetained);

    const nextGoal = {
      ...goal,
      status: goalStatus,
      iteration,
      verifications,
    };
    deltas.push({
      op: "state.updated",
      patch: shouldPatchControl
        ? this.controlPatch(
            {
              phase: terminalPhase,
              sessionEnded: terminalPhase !== "error",
              activeWorks: otherWorks,
              ...(otherWorks.length === 0
                ? {
                    canStop: false,
                    stopState: "idle" as const,
                    stopTargetKind: "unknown" as const,
                  }
                : {
                    stopTargetKind: "mixed" as const,
                  }),
            },
            nextGoal,
            heldQueue,
          )
        : this.goalPatch(nextGoal),
    });
    return deltas;
  }

  /** goal verify boundary 身份：targetId_goalIteration。 */
  /**
   * goal 验证 marker 的去重键：由 target 轮次/iteration/turn 等组合而成，
   * 同一生命周期内重复事件复用同一行，避免时间线出现多张验证卡。
   */
  private goalVerifyLifecycleKey(
    payload: TargetCompletionVerificationPayload,
    iteration: number,
  ): string {
    return payload.targetId ? `${payload.targetId}_${iteration}` : payload.verificationId;
  }

  // 落位：优先 anchorAssistantMessageId（解析到已渲染
  // 行的所属轮——fork copy 后是 remap 过的 child local id）；次选 anchorTurnId
  // （必须是已知轮，未知 id 不得当 turnId 用——否则会长出幽灵 turn 分组，
  // fork 前的父 runtime turnId 就是典型）；最后按事件归属。
  private goalVerifyTurnId(
    payload: TargetCompletionVerificationPayload,
    event: SessionEvent,
  ): string {
    const anchorMessageId = payload.anchorAssistantMessageId
      ? String(payload.anchorAssistantMessageId)
      : null;
    if (anchorMessageId) {
      const rowId = this.rowIdForMessageId(anchorMessageId);
      const row = rowId !== null ? this.findRow(rowId) : undefined;
      if (row) return row.turnId;
    }
    const anchorTurnId = payload.anchorTurnId ? String(payload.anchorTurnId) : null;
    if (anchorTurnId) {
      const mapped = this.productTurnIdByRuntimeTurnId.get(anchorTurnId) ?? anchorTurnId;
      if (this.turnHeaderRowIdByTurnId.has(mapped)) return mapped;
    }
    return this.turnIdOf(event);
  }

  // ── fork marker（forkAssistant 命令效果）──

  /**
   * 会话分叉事件：父会话不产任何 delta（fork 关系只在 sessions 树/列表体现，
   * 父时间线不显示 forkCreated，也避免旧实现以 nextRowId-1 近似锚点污染 turn 分组）。
   *
   * 子会话在首部追加一条 turnTailBoundary/forkNotice marker，记录 parentSessionId；
   * payload 不携带父 rowId，先以 0 占位，由传输外壳按 transcript 锚点补齐。
   * 只产一条 row.appended，不重建快照、不改 control。
   */
  private onSessionForked(event: SessionEvent): ConversationDelta[] {
    const payload = event.payload as SessionForkedPayload;
    const isParent = String(payload.originalSessionId) === this.snapshot.sessionId;
    if (isParent) {
      // 父时间线不显示 forkCreated——fork 关系只在 sessions
      // 树/列表体现。旧实现以 nextRowId-1 近似锚点产 row，且 UI 渲染为 null
      // （隐形行污染 turn 分组）；child 首部 forkNotice 保留不变。
      return [];
    }
    // child 首部 forkNotice（forkTimelineIsBoundary）：事件 payload 不携带
    // parent 侧 rowId，先以 0 占位；transcript 锚点 → rowId 映射随传输外壳补齐。
    const row: TimelineMarkerRow = {
      ...this.rowBase(
        event,
        this.turnIdOf(event),
        `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
      ),
      kind: "timelineMarker",
      lane: "turnTailBoundary",
      marker: {
        type: "forkNotice",
        parentSessionId: String(payload.originalSessionId),
        parentRowId: 0,
      },
    };
    return [{ op: "row.appended", row }];
  }

  // ── 内部工具 ──

  /**
   * 构造 control（可选 goal/queue）变更的 StatePatch，并从同一份上下文重算
   * availability 与 inputRouting。
   *
   * goal 传 undefined = 不动；传 null/对象 = 随 patch 整键替换。queue 同理。
   * compacting/goalVerifying 不由 phase 表达，必须从 activeWorks 派生后传入；
   * 任何 control/goal/queue 变化都要走这里，禁止单独改 control 而漏算 A 区派生。
   */
  // goal 传 undefined = 不动 goal；传 null/对象 = 随本 patch 一并替换（availability 同源派生）。
  // queue 传 undefined = 不动 queue；held 派生（heldQueueInputRequiresChoice）依赖
  // queue.items.length + autoDrain，所以任何 control/goal/queue 变化都从同一处重算 A 区。
  private controlPatch(
    control: Partial<SessionControl>,
    goal?: GoalState | null,
    queue?: ConversationSnapshot["queue"],
  ): StatePatch {
    const next: SessionControl = { ...this.snapshot.control, ...control };
    const nextGoal = goal === undefined ? this.snapshot.goal : goal;
    const nextQueue = queue ?? this.snapshot.queue;
    const context = {
      phase: next.phase,
      goalStatus: nextGoal?.status ?? null,
      // compacting 不是独立 phase（封闭枚举），从 activeWorks 派生。
      compacting: next.activeWorks.some((work) => work.kind === "compact"),
      goalVerifying: next.activeWorks.some((work) => work.kind === "goalVerifier"),
      queueLength: nextQueue.items.length,
      autoDrain: nextQueue.autoDrain,
    };
    return {
      control: next,
      ...(goal === undefined ? {} : { goal }),
      ...(queue === undefined ? {} : { queue }),
      availability: computeAvailability(context),
      inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
    };
  }

  /**
   * 仅 goal 变化时的 patch：goal 整键替换（或 null 清空），availability 依同一 goal
   * 重新派生；phase/activeWorks 不变，因此不产 control/inputRouting。属 A 区变化。
   */
  // goal 单独变化时的 patch（availability 与 goal 同源，phase/activeWorks 不变）。
  private goalPatch(goal: GoalState | null): StatePatch {
    return {
      goal,
      availability: computeAvailability(this.deriveContext({ goal })),
    };
  }

  /**
   * 仅 queue 变化时的 patch：queue 整键替换，并因长度/autoDrain 影响 held 派生，
   * 同步重算 availability 与 inputRouting。phase/goal/activeWorks 保持不变。
   */
  // queue 单独变化时的 patch：queue 长度/autoDrain 影响 held 派生 → 同步重算 A 区。
  private queuePatch(queue: ConversationSnapshot["queue"]): StatePatch {
    const context = this.deriveContext({ queue });
    return {
      queue,
      availability: computeAvailability(context),
      inputRouting: computeInputRouting(context, this.snapshot.config.followupMode),
    };
  }

  /**
   * 汇总 availability/inputRouting 所需的派生上下文（phase、goal status、
   * compacting/goalVerifying 从 activeWorks 推导、queue 长度与 autoDrain）。
   * overrides 允许在提交前用 prospect 的 goal/queue 计算，确保派生与 patch 同源。
   */
  private deriveContext(overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  }) {
    const goal = overrides.goal === undefined ? this.snapshot.goal : overrides.goal;
    const queue = overrides.queue ?? this.snapshot.queue;
    return {
      phase: this.snapshot.control.phase,
      goalStatus: goal?.status ?? null,
      compacting: this.snapshot.control.activeWorks.some((work) => work.kind === "compact"),
      goalVerifying: this.snapshot.control.activeWorks.some((work) => work.kind === "goalVerifier"),
      queueLength: queue.items.length,
      autoDrain: queue.autoDrain,
    };
  }

  /**
   * 收口 turnHeader：置终态 state、endedAt、activeMs（可选）、historyRoundCount 与
   * highspeed 计时；行不存在时返回空（controlOnly/未知轮不伪造）。
   * activeMs 必须由调用方按边界计算并保证各段之和等于总工时；null/undefined 表示
   * 该轮不计工时（controlOnly 尤其不能下发 0 秒）。只产一条 row.upserted。
   */
  private upsertTurnHeader(
    event: SessionEvent,
    state: "completedSuccess" | "completedInterrupted" | "failed",
    activeMs?: number,
    historyRoundCount?: number,
    highspeedTiming?: {
      modelDurationMs: number;
      toolDurationMs: number;
      otherDurationMs: number;
    },
  ): ConversationDelta[] {
    const row = this.turnHeaderForEvent(event);
    if (!row) return [];
    const endedAt = this.ms(event);
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          state,
          endedAt,
          ...(activeMs !== undefined ? { activeMs } : {}),
          ...highspeedTiming,
          ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
          ...(row.workSegments
            ? {
                workSegments: this.completeWorkSegments(row.workSegments, endedAt),
              }
            : {}),
        },
      },
    ];
  }

  private recordHighspeedToolStarted(turnId: string, toolCallId: string, startedAt: number): void {
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
    intervals.set(toolCallId, { startedAt });
    this.highspeedToolIntervalsByTurnId.set(turnId, intervals);
  }

  private recordHighspeedToolEnded(
    turnId: string,
    toolCallId: string,
    endedAt: number,
    durationMs?: number,
  ): void {
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId) ?? new Map();
    const existing = intervals.get(toolCallId);
    const startedAt = existing?.startedAt ?? Math.max(0, endedAt - Math.max(0, durationMs ?? 0));
    intervals.set(toolCallId, {
      startedAt,
      endedAt: Math.max(
        startedAt,
        existing && durationMs !== undefined ? startedAt + durationMs : endedAt,
      ),
    });
    this.highspeedToolIntervalsByTurnId.set(turnId, intervals);
  }

  private highspeedTimingForTurn(
    turnId: string,
    activeMs?: number,
  ): { modelDurationMs: number; toolDurationMs: number; otherDurationMs: number } | undefined {
    const modelDurationMs = this.highspeedModelDurationByTurnId.get(turnId);
    const intervals = this.highspeedToolIntervalsByTurnId.get(turnId);
    if (modelDurationMs === undefined && intervals === undefined) return undefined;
    const sorted = [...(intervals?.values() ?? [])]
      .filter((interval) => interval.endedAt !== undefined)
      .sort((left, right) => left.startedAt - right.startedAt);
    let toolDurationMs = 0;
    let unionEnd = -1;
    for (const interval of sorted) {
      const start = Math.max(0, interval.startedAt);
      const end = Math.max(start, interval.endedAt ?? start);
      if (start > unionEnd) toolDurationMs += end - start;
      else if (end > unionEnd) toolDurationMs += end - unionEnd;
      unionEnd = Math.max(unionEnd, end);
    }
    const model = Math.max(0, modelDurationMs ?? 0);
    const otherDurationMs = Math.max(
      0,
      (activeMs ?? model + toolDurationMs) - model - toolDurationMs,
    );
    this.highspeedModelDurationByTurnId.delete(turnId);
    this.highspeedToolIntervalsByTurnId.delete(turnId);
    return { modelDurationMs: model, toolDurationMs, otherDurationMs };
  }

  /**
   * guide steer 内联当前轮时开启一个 guided work segment（记录触发 entityId 与起点），
   * 供工时拆分与 UI 的分段工作指示使用。只改目标行的 workSegments，不拆轮。
   */
  private openGuidedWorkSegment(event: SessionEvent, triggerEntityId: string): ConversationDelta[] {
    const row = this.turnHeaderForEvent(event);
    if (!row || row.executionKind === "controlOnly") return [];
    const startedAt = this.ms(event);
    const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
      {
        segmentId: `${row.turnId}:initial`,
        startedAt: row.startedAt,
      },
    ];
    // 旧 UI 为整个 product turn 只维护一个折叠状态，accepted guide 只能
    // 作为普通行插入，无法恢复独立工作区。分段边界必须由 CLI 记录，React 不能按邻接行猜。
    const workSegments = [
      ...this.completeWorkSegments(existingSegments, startedAt),
      {
        segmentId: triggerEntityId,
        triggerEntityId,
        startedAt,
      },
    ];
    return [{ op: "row.upserted", row: { ...row, workSegments } }];
  }

  private completeWorkSegments(
    segments: readonly TurnWorkSegment[],
    endedAt: number,
  ): TurnWorkSegment[] {
    return segments.map((segment, index) =>
      index === segments.length - 1 && segment.endedAt === undefined
        ? {
            ...segment,
            endedAt,
            activeMs: Math.max(0, endedAt - segment.startedAt),
          }
        : segment,
    );
  }

  private turnHeaderForEvent(event: SessionEvent): TurnHeaderRow | undefined {
    const rowId = this.turnHeaderRowIdByTurnId.get(this.turnIdOf(event));
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "turnHeader" ? row : undefined;
  }

  /**
   * 标记最后一条 assistant 段为稳定 fork 锚点（成功收口后调用），写 row.actions
   * 可 fork 标志并记录 messageId 映射；只更新该行，不改变轮次。
   * 中间段绝不获得 fork 入口，防止直接命令面 fork 到半截时间线。
   */
  private markStableForkAssistant(event: SessionEvent): ConversationDelta[] {
    const turnId = this.turnIdOf(event);
    const rows = this.snapshot.rows.window;
    const headerRowId = this.turnHeaderRowIdByTurnId.get(turnId);
    const headerIndex = headerRowId === undefined ? undefined : this.rowIndexById.get(headerRowId);
    const startIndex = headerIndex === undefined ? 0 : headerIndex + 1;
    let row: AssistantTextRow | undefined;
    // 性能问题根因：旧实现每个成功 turn 都复制并反转完整历史 rows，冷恢复会累积为
    // 近似 O(turns * rows) 的分配与扫描。当前 turn 的行只会出现在自身 header 之后。
    for (let index = rows.length - 1; index >= startIndex; index -= 1) {
      const candidate = rows[index];
      if (candidate?.kind !== "assistantText" || candidate.turnId !== turnId) continue;
      row = candidate;
      break;
    }
    if (!row || !this.messageIdByRowId.has(row.rowId)) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          state: "complete",
          actions: { ...row.actions, canFork: true },
        },
      },
    ];
  }

  /**
   * 运行态闸门：phase 为 running/prewarming。所有“只应在轮内发生”的事件
   * （流式/工具/进度/结果）必须经此判定，迟到终态不得复活已收口行。
   * 注意它不检查 currentTurnId：phase 是权威水位，turnId 仅用于归属。
   */
  private isRunning(): boolean {
    const phase = this.snapshot.control.phase;
    return phase === "running" || phase === "prewarming";
  }

  private isMirroredSubagentToolEvent(event: SessionEvent): boolean {
    const payload = event.payload as unknown as Record<string, unknown>;
    // Bug 原因：child tool lifecycle 会镜像到父 runtime，但它不是父 session 的工具事实。
    // V4 过去把 mirror 当普通 ToolCallRow，导致 main timeline 展示 child 的 Read/Bash，
    // 并让 replayable snapshot 同样带上脏 row。完整工具历史只应由 child topic 物化。
    return payload.source === "subagent";
  }

  private openAssistantSegments(): Partial<
    Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>
  > {
    const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
    const text = this.openSegmentIdentity(this.streamingTextRowId);
    const reasoning = this.openSegmentIdentity(this.streamingReasoningRowId);
    if (text) segments.text = text;
    if (reasoning) segments.reasoning = reasoning;
    return segments;
  }

  private openSegmentIdentity(rowId: number | null): CanonicalOpenSegmentIdentity | null {
    if (rowId === null) return null;
    const entityId = this.entityIdByRowId.get(rowId);
    if (!entityId) return null;
    return {
      entityId,
      transcriptMessageId: this.messageIdByRowId.get(rowId) ?? null,
    };
  }

  /**
   * 行基础字段生成：分配单调 rowId、绑定 turnId、entityId（默认 event.id）、
   * createdAt/createdSeq，并登记 entityIdByRowId。所有新行都必须经此入口，
   * 保证 rowId/seq 单调与冷恢复排序一致；其余索引由具体 handler 或 apply 后维护。
   */
  private rowBase(event: SessionEvent, turnId: string, entityId = String(event.id)) {
    const rowId = this.nextRowId++;
    this.entityIdByRowId.set(rowId, entityId);
    return {
      rowId,
      turnId,
      entityId,
      productTurnId: turnId,
      visibility: "visible" as const,
      createdAt: this.ms(event),
      createdAtSeq: event.sequenceNumber,
    };
  }

  private turnIdOf(event: SessionEvent): string {
    const runtimeTurnId = String(event.turnId ?? this.currentTurnId ?? "turn-unknown");
    // queue drain 切轮后，同一 runtimeTurn 的后续事件行归入最新 productTurn。
    return this.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
  }

  private ms(event: SessionEvent): number {
    return event.timestamp.getTime();
  }

  private findRow(rowId: number): ConversationRow | undefined {
    const index = this.rowIndexById.get(rowId);
    return index === undefined ? undefined : this.snapshot.rows.window[index];
  }

  /**
   * 不可变 apply 后的索引增量维护：按“apply 前 window 长度”定位本次新增行，
   * 只把 append/upsert 的行写入 rowIndexById，并处理 row.removed 的索引清理。
   * 不重扫全量 rows，长会话下保持 O(新增 delta)。索引必须与 snapshot 同步，
   * 否则后续 findRow/流式游标会指向错误位置。
   */
  private updateRowIndexAfterImmutableApply(
    previousRowsLength: number,
    deltas: readonly ConversationDelta[],
  ): void {
    if (deltas.some((delta) => delta.op === "row.removed")) {
      this.rowIndexById = new Map(
        this.snapshot.rows.window.map((row, index) => [row.rowId, index]),
      );
      return;
    }
    let nextIndex = previousRowsLength;
    for (const delta of deltas) {
      if (delta.op !== "row.appended") continue;
      this.rowIndexById.set(delta.row.rowId, nextIndex);
      nextIndex += 1;
    }
  }

  private findToolRow(toolCallId: string): ToolCallRow | undefined {
    const rowId = this.toolRowIdByCallId.get(toolCallId);
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "toolCall" ? row : undefined;
  }

  private findSubagentRow(agentId: string): SubagentRow | undefined {
    const rowId = this.subagentRowIdByAgentId.get(agentId);
    if (rowId === undefined) return undefined;
    const row = this.findRow(rowId);
    return row?.kind === "subagent" ? row : undefined;
  }

  private findSubagentLifecycleRow(
    agentId: string,
    payload: Record<string, unknown>,
    event: SessionEvent,
  ): SubagentRow | undefined {
    const exact = this.findSubagentRow(agentId);
    if (exact) return exact;

    const parentToolCallId = this.stringPayload(payload, "parentToolCallId");
    if (!parentToolCallId) return undefined;
    const turnId = this.turnIdOf(event);
    // 晚订阅 hydration 无法从后台 Agent 的文本 tool output 恢复真实 agentId，
    // 会先用 toolCallId 合成一条 SubagentRow。后到的 live lifecycle 携带真实 agentId，
    // 旧逻辑因此追加第二行，UI 又会让无 childSessionId 的合成行抢占配对。父 tool call
    // 在同一 turn 内是稳定唯一身份，这里将真实事件归并回合成行并补齐 childSessionId。
    return this.snapshot.rows.window.find(
      (row): row is SubagentRow =>
        row.kind === "subagent" &&
        row.turnId === turnId &&
        row.parentToolCallId === parentToolCallId,
    );
  }

  private subagentAgentId(payload: Record<string, unknown>, event: SessionEvent): string {
    return (
      this.stringPayload(payload, "agentId") ??
      this.stringPayload(payload, "childSessionId") ??
      this.stringPayload(payload, "parentToolCallId") ??
      `subagent-${event.sequenceNumber}`
    );
  }

  private stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private mapSubagentStatus(status: string | undefined): SubagentRow["status"] {
    switch (status) {
      case "completed":
      case "success":
        return "success";
      case "cancelled":
      case "stopped":
        return "cancelled";
      default:
        return "failed";
    }
  }
}

function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === "AskUserQuestion";
}

/**
 * 把 core 的 tool display 收窄成 v4 协议能承载的那几种 kind。
 *
 * 这份白名单原先在每个投影点各写一份内联判断，引入
 * create_workflow display 时漏改了其中一份，实时投影把图整个丢掉、而 hydration 路径没过滤，
 * 于是桌面端只有重载之后才看得到。收成一个谓词后，所有投影点共用同一份名单。
 */
function toProtocolToolCallDisplay(
  display: ToolResultDisplayPayload | undefined,
): ToolCallDisplay | undefined {
  if (!display) return undefined;
  switch (display.kind) {
    case "node_repl_images":
    case "task_output":
    case "respond_to_coordinator":
    case "mcp_tool":
    case "create_workflow":
    // 观察类工作流工具的五个 display kind——shared 侧 toolCallDisplaySchema 已同步加
    // 成员，这里放行后 UI 才能在 row.display 上拿到结构化载荷。
    case "get_workflow_run":
    case "list_workflow_runs":
    case "eval_workflow_snippet":
    case "saved_workflow_list":
    case "list_models":
    // ResumeWorkflowRun 的恢复卡。
    case "resume_workflow_run":
      return display;
    default:
      return undefined;
  }
}

function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === "ExitPlanMode";
}

function createExitPlanModeApprovalQuestion(reason: string): UserInputQuestionPayload {
  return {
    question: reason,
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
  };
}

function readAskUserQuestionPayloadQuestions(input: unknown): UserInputQuestionPayload[] {
  const rawQuestions = readRawAskUserQuestions(input);
  return rawQuestions
    .map(normalizeAskUserQuestionPayloadQuestion)
    .filter((question): question is UserInputQuestionPayload => question !== null);
}

function readRawAskUserQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  if (Array.isArray(input.questions)) {
    return input.questions;
  }
  return typeof input.question === "string" && Array.isArray(input.options) ? [input] : [];
}

function normalizeAskUserQuestionPayloadQuestion(value: unknown): UserInputQuestionPayload | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const question = nonEmptyString(value.question);
  const header = nonEmptyString(value.header) ?? question;
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map(normalizeAskUserQuestionPayloadOption)
    .filter((option): option is UserInputQuestionPayload["options"][number] => option !== null);
  if (!question || !header || options.length === 0) {
    return null;
  }
  return {
    question,
    header,
    options,
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  };
}

function normalizeAskUserQuestionPayloadOption(
  value: unknown,
): UserInputQuestionPayload["options"][number] | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const label = nonEmptyString(value.label) ?? nonEmptyString(value.value);
  const optionValue = nonEmptyString(value.value) ?? label;
  if (!label || !optionValue) {
    return null;
  }
  return {
    value: optionValue,
    label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.preview === "string" ? { preview: value.preview } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
