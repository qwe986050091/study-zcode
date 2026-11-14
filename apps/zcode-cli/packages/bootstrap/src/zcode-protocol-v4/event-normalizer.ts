/**
 * ============================================================================
 * zcode-protocol-v4/event-normalizer.ts —— 事件字段解释的唯一入口
 * ============================================================================
 *
 * 【定位】ProductProjection 消费的是"canonical conversation fact"，而不是 raw
 * SessionEvent。本文件负责把 live 事件与 cold hydration 合成事件统一成同一种
 * fact：entityId / productTurnId / transcriptMessageId / visibility / origin /
 * placement。
 *
 * 【为什么必须先归一化】
 *   过去 projection 直接从 raw payload 分别猜 messageId、origin 与 visibility：
 *   cold 少一个字段时可见 row 仍会生成，但命令 target 缺失。归一化后 row、target、
 *   action 使用同一份身份事实，避免"看起来有行但点不动"的不一致。
 *
 * 【稳定身份规则】
 *   - 真实用户轮以持久 user messageId 作为 productTurnId；
 *   - legacy 缺 messageId 时才退回 runtime turnId，并通过 diagnostics 暴露降级；
 *   - goal continuation / background wake / workflow launch 只要带持久 messageId，
 *     也必须与 user row 共用同一个 product turn 身份。
 *
 * 【未知事件】一律降级为 passthrough（stateOnly），只更新状态、不生成可见 row；
 *   新增事件类型必须显式在这里补分支，不能依赖 projection 猜 payload。
 *
 * 【身份口径】
 *   entityId 回答"这是哪条实体"，productTurnId 回答"它属于哪一轮"：
 *   - user：两者都优先持久 messageId；legacy 才退回
 *     `legacy:user:<session>:<runtimeTurn>:<eventId>` 并附 diagnostics；
 *   - assistant：text/reasoning 段按 assistantMessageId 收敛，同段后续增量继承
 *     openAssistantSegments；tool 段优先 toolCallId，其余用 partId；
 *   - compact/passthrough：operationId 优先，退回 event id，保证冷热重放同一 marker。
 *
 * 【visibility / origin / placement 口径】
 *   visibility 只表达"是否出现在用户时间线"（visible / modelOnly / stateOnly）；
 *   origin 表达"谁触发或产生"，由 inputSource 唯一映射，不在消费方二次猜测；
 *   placement 固定 trigger / assistantWork / stateOnly，决定行落在哪个 lane。
 *   合成事件与 live 事件走同一个函数，因此这些口径对冷热路径天然一致。
 * ============================================================================
 */
import type {
  BackgroundResultOriginMeta,
  HighspeedMessageMetadata,
  ModelStreamingPayload,
  SessionEvent,
  SyntheticUserMessageSource,
  TurnAttachmentMeta,
  TurnInputIntentMetadata,
  TurnStartedPayload,
  WorkflowLaunchMeta,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";

export type CanonicalConversationVisibility = "visible" | "modelOnly" | "stateOnly";
export type CanonicalConversationOrigin =
  | "realUser"
  | "backgroundResult"
  | "goalContinuation"
  | "mailbox"
  | "synthetic"
  | "workflowLaunch"
  | "assistant"
  | "system";

export interface CanonicalConversationPlacement {
  lane: "trigger" | "assistantWork" | "stateOnly";
  relation: "withinProductTurn" | "none";
}

export interface ConversationNormalizationDiagnostic {
  code:
    | "normalizer.user.missingTranscriptMessageId"
    | "normalizer.assistant.missingTranscriptMessageId";
  eventId: string;
}

interface CanonicalConversationFactBase {
  event: SessionEvent;
  entityId: string;
  productTurnId: string;
  runtimeTurnId: string;
  transcriptMessageId: string | null;
  visibility: CanonicalConversationVisibility;
  origin: CanonicalConversationOrigin;
  placement: CanonicalConversationPlacement;
  diagnostics: readonly ConversationNormalizationDiagnostic[];
}

export interface CanonicalUserIntentFact extends CanonicalConversationFactBase {
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: import("@zcode/shared").BotGroupInputSource;
  semanticKind: "userIntent";
  visibility: "visible" | "modelOnly";
  origin:
    | "realUser"
    | "backgroundResult"
    | "goalContinuation"
    | "mailbox"
    | "synthetic"
    | "workflowLaunch";
  input: string;
  intentText: string;
  intentKind: "sendText" | "sendGoalCommand";
  turnNumber: number;
  executionKind: "agent" | "controlOnly";
  turnHeaderOrigin:
    | "userInput"
    | "backgroundResult"
    | "goalContinuation"
    | "editRerun"
    | "workflowLaunch";
  originMeta?: BackgroundResultOriginMeta;
  /**
   * 中枢直接启动已保存工作流的启动轮元数据（`inputSource === "workflow_launch"` 时在场）。
   * 活投影据它在 turnHeader / userInput 两行上画启动卡；与消息 metadata 里的同一份对齐（冷热同形）。
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** `input` 从此下标起是引擎附加文本。 */
  epilogueStart?: number;
  sourceCommandId?: string;
  foregroundExecutionId?: string;
  clientId?: string;
  highspeed?: HighspeedMessageMetadata;
  attachments?: readonly CanonicalTurnAttachment[];
  queueItemId?: string;
  admissionSeq?: number;
  admittedAt?: number;
  requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: readonly { kind: "shared_context_import"; context_id: string }[];
  fallbackReasonCode?: string;
  modelSelection?: TurnInputIntentMetadata["modelSelection"];
  mode?: TurnInputIntentMetadata["mode"];
  planEnabled?: boolean;
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  source?: TurnInputIntentMetadata["source"];
}

export interface CanonicalTurnAttachment extends Omit<AttachmentRef, "ref"> {
  ref?: string;
}

export interface CanonicalModelStream {
  kind: ModelStreamingPayload["kind"];
  delta: string;
  done: boolean;
  assistantResponseId?: string;
  transcriptPartId?: string;
  toolCallId?: ModelStreamingPayload["toolCallId"];
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export interface CanonicalAssistantSegmentFact extends CanonicalConversationFactBase {
  semanticKind: "assistantSegment";
  visibility: "visible";
  origin: "assistant";
  stream: CanonicalModelStream;
}

export interface CanonicalPassthroughFact extends CanonicalConversationFactBase {
  semanticKind: "passthrough";
  sourceCommandId?: string;
}

export type CanonicalConversationFact =
  | CanonicalUserIntentFact
  | CanonicalAssistantSegmentFact
  | CanonicalPassthroughFact;

export interface NormalizeConversationEventContext {
  productTurnId?: string;
  openAssistantSegments?: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>>;
}

export interface CanonicalOpenSegmentIdentity {
  entityId: string;
  transcriptMessageId: string | null;
}

/**
 * live SessionEvent 与 cold hydration 合成事件的唯一字段解释入口。
 *
 * 过去 ProductProjection 直接从 raw payload 分别猜 messageId、origin 与
 * visibility；cold 少一个字段时可见 row 仍会生成，但命令 target 缺失。normalizer
 * 先生成自包含 canonical fact，让 row、target、actions 使用同一份身份事实。
 */
export function normalizeConversationEvent(
  event: SessionEvent,
  context: NormalizeConversationEventContext = {},
): CanonicalConversationFact {
  const runtimeTurnId = runtimeTurnIdOf(event);
  // 调用方未指定 product turn 时退回 runtime turn，仅作展示分组兜底。
  const productTurnId = context.productTurnId ?? runtimeTurnId;
  if (event.type === SessionEventType.TurnStarted) {
    return normalizeTurnStarted(event, event.payload as TurnStartedPayload, {
      runtimeTurnId,
      productTurnId,
    });
  }
  if (event.type === SessionEventType.ModelStreaming) {
    return normalizeModelStreaming(event, event.payload as ModelStreamingPayload, {
      runtimeTurnId,
      productTurnId,
      openAssistantSegments: context.openAssistantSegments,
    });
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    const payload = event.payload as Record<string, unknown>;
    // operationId 是 compact marker 在冷热路径的共同身份；缺失时退回 event id，
    // 至少保证该事实可被重放，而不是静默丢失。
    const operationId =
      typeof payload.operationId === "string" && payload.operationId.length > 0
        ? payload.operationId
        : String(event.id);
    // messageId 只用于展示/寻址；缺失保持 null，不猜测归属消息。
    const transcriptMessageId =
      typeof payload.messageId === "string" && payload.messageId.length > 0
        ? payload.messageId
        : null;
    return {
      semanticKind: "passthrough",
      event,
      entityId: operationId,
      productTurnId,
      runtimeTurnId,
      transcriptMessageId,
      visibility: "visible",
      origin: "system",
      placement: { lane: "assistantWork", relation: "withinProductTurn" },
      diagnostics: [],
      ...(typeof payload.sourceCommandId === "string"
        ? { sourceCommandId: payload.sourceCommandId }
        : {}),
    };
  }
  return {
    semanticKind: "passthrough",
    event,
    entityId: String(event.id),
    productTurnId,
    runtimeTurnId,
    transcriptMessageId: null,
    visibility: "stateOnly",
    origin: "system",
    placement: { lane: "stateOnly", relation: "none" },
    diagnostics: [],
  };
}

/**
 * TurnStarted → canonical userIntent fact。
 *
 * 输入：live TurnStarted 或 hydration 合成 TurnStarted，payload 形状相同。
 * 身份：productTurnId 以持久 messageId 为准；legacy 缺 messageId 才保留 runtime
 *   turnId，并通过 diagnostics 让降级可观测；entityId 遵循同一优先级。
 * 输出：展示/命令所需的 intent、附件、queue admission、originMeta 等字段。
 * 无副作用：只解释字段，不写持久层、不合成事件；可选字段畸形按缺席处理。
 */
function normalizeTurnStarted(
  event: SessionEvent,
  payload: TurnStartedPayload,
  ids: { runtimeTurnId: string; productTurnId: string },
): CanonicalUserIntentFact {
  const transcriptMessageId = payload.messageId ? String(payload.messageId) : null;
  const origin = userInputOrigin(payload.inputSource);
  // live 使用 runtime turnId、cold 使用 hydrate-turn-N；即使二者指向
  // 同一条持久 user message，过去仍生成不同 productTurnId，导致行分组与命令边界
  // 在恢复前后漂移。真实用户轮以持久 user messageId 作为稳定 product turn 身份；
  // legacy 缺 messageId 时才保留 runtime fallback，并通过 diagnostics 暴露降级。
  // 可见 user、goal continuation、background wake 都是 product-turn trigger；
  // 只要有持久 messageId 就必须共用它，不能只稳定 realUser。
  const productTurnId = transcriptMessageId ?? ids.productTurnId;
  const diagnostics: ConversationNormalizationDiagnostic[] = transcriptMessageId
    ? []
    : [
        {
          code: "normalizer.user.missingTranscriptMessageId",
          eventId: String(event.id),
        },
      ];
  return {
    semanticKind: "userIntent",
    event,
    entityId:
      transcriptMessageId ??
      `legacy:user:${String(event.sessionId)}:${ids.runtimeTurnId}:${String(event.id)}`,
    productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: payload.inputVisibility === "model-only" ? "modelOnly" : "visible",
    origin,
    placement: { lane: "trigger", relation: "withinProductTurn" },
    diagnostics,
    input: payload.input,
    intentText: payload.intent?.text ?? payload.input,
    intentKind: payload.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
    turnNumber: payload.turnNumber,
    executionKind: payload.executionKind ?? "agent",
    turnHeaderOrigin: turnHeaderOrigin(payload.inputSource),
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    ...(payload.workflowLaunch ? { workflowLaunch: payload.workflowLaunch } : {}),
    ...(payload.epilogueStart === undefined ? {} : { epilogueStart: payload.epilogueStart }),
    ...((payload.intent?.sourceCommandId ?? payload.inputId)
      ? { sourceCommandId: payload.intent?.sourceCommandId ?? payload.inputId }
      : {}),
    ...(payload.foregroundExecutionId
      ? { foregroundExecutionId: payload.foregroundExecutionId }
      : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    ...(payload.intent?.highspeed ? { highspeed: payload.intent.highspeed } : {}),
    ...(payload.intent?.queueItemId ? { queueItemId: payload.intent.queueItemId } : {}),
    ...(payload.intent?.admissionSeq !== undefined
      ? { admissionSeq: payload.intent.admissionSeq }
      : {}),
    ...(payload.intent?.admittedAt !== undefined ? { admittedAt: payload.intent.admittedAt } : {}),
    ...(payload.intent?.requestedDelivery
      ? { requestedDelivery: payload.intent.requestedDelivery }
      : {}),
    ...(payload.intent?.admittedDelivery
      ? { admittedDelivery: payload.intent.admittedDelivery }
      : {}),
    ...(payload.intent?.sharedContextRefs
      ? { sharedContextRefs: payload.intent.sharedContextRefs }
      : {}),
    ...(payload.intent?.fallbackReasonCode
      ? { fallbackReasonCode: payload.intent.fallbackReasonCode }
      : {}),
    ...(payload.intent?.modelSelection ? { modelSelection: payload.intent.modelSelection } : {}),
    ...(payload.intent?.mode ? { mode: payload.intent.mode } : {}),
    ...(payload.intent?.planEnabled !== undefined
      ? { planEnabled: payload.intent.planEnabled }
      : {}),
    ...(payload.intent?.inputOrigin ? { inputOrigin: payload.intent.inputOrigin } : {}),
    ...(payload.intent?.conversationQuotes
      ? { conversationQuotes: payload.intent.conversationQuotes }
      : {}),
    ...(payload.intent?.botGroupSource ? { botGroupSource: payload.intent.botGroupSource } : {}),
    ...(payload.intent?.provenance ? { provenance: payload.intent.provenance } : {}),
    ...(payload.intent?.source ? { source: payload.intent.source } : {}),
    ...normalizeAttachments(payload),
  };
}

/**
 * ModelStreaming → canonical assistantSegment fact。
 *
 * 身份：assistantMessageId 优先；非 *_start 的增量继承当前打开段的实体，
 *   使同一段的 start/delta/end 在冷热路径落在同一 row。tool 段实体优先
 *   toolCallId，text/reasoning 段优先 transcriptPartId。
 * 降级：text_start 缺 assistantMessageId 时发 diagnostic 但仍产出可见段；
 *   partId/toolName/input 原样透传给 reducer，normalizer 不做产品过滤。
 * 无副作用：不更新 openAssistantSegments（由调用方 / reducer 维护）。
 */
function normalizeModelStreaming(
  event: SessionEvent,
  payload: ModelStreamingPayload,
  ids: {
    runtimeTurnId: string;
    productTurnId: string;
    openAssistantSegments: NormalizeConversationEventContext["openAssistantSegments"];
  },
): CanonicalAssistantSegmentFact {
  const lane = assistantStreamLane(payload.kind);
  const openSegment =
    lane === "text" || lane === "reasoning" ? ids.openAssistantSegments?.[lane] : undefined;
  const inheritsOpenSegment = !isAssistantStreamStart(payload.kind);
  const inheritedSegment = inheritsOpenSegment ? openSegment : undefined;
  const transcriptMessageId = payload.assistantMessageId
    ? String(payload.assistantMessageId)
    : (inheritedSegment?.transcriptMessageId ?? null);
  // text 段缺持久 assistantMessageId 时无法与 live row 对齐，必须显式诊断。
  const identityRequired =
    payload.kind === "text_start" || (payload.kind === "text_delta" && !transcriptMessageId);
  const diagnostics: ConversationNormalizationDiagnostic[] =
    identityRequired && !transcriptMessageId
      ? [
          {
            code: "normalizer.assistant.missingTranscriptMessageId",
            eventId: String(event.id),
          },
        ]
      : [];
  const transcriptPartId = payload.partId ? String(payload.partId) : undefined;
  // tool 段优先 toolCallId；text/reasoning 段优先 partId。
  const toolEntityId = payload.toolCallId ? String(payload.toolCallId) : undefined;
  const intrinsicEntityId =
    lane === "tool" ? (toolEntityId ?? transcriptPartId) : (transcriptPartId ?? toolEntityId);
  return {
    semanticKind: "assistantSegment",
    event,
    entityId:
      transcriptMessageId ??
      inheritedSegment?.entityId ??
      intrinsicEntityId ??
      `legacy:assistant:${String(event.sessionId)}:${ids.runtimeTurnId}:${transcriptPartId ?? String(event.id)}`,
    productTurnId: ids.productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: "visible",
    origin: "assistant",
    placement: { lane: "assistantWork", relation: "withinProductTurn" },
    diagnostics,
    stream: {
      kind: payload.kind,
      delta: payload.delta,
      done: payload.done,
      ...(transcriptMessageId ? { assistantResponseId: transcriptMessageId } : {}),
      ...(transcriptPartId ? { transcriptPartId } : {}),
      ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
      // 空字符串是空工具名恢复的有效原始事实；truthy 判断会把它抹成
      // undefined，导致后续产品态过滤误把该调用物化成一个空名工具行。
      ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.providerExecuted !== undefined
        ? { providerExecuted: payload.providerExecuted }
        : {}),
    },
  };
}

/** 按 kind 前缀分 lane；只用于开段继承与实体优先级，不改变事件语义。 */
function assistantStreamLane(
  kind: ModelStreamingPayload["kind"],
): "text" | "reasoning" | "tool" | "other" {
  if (kind?.startsWith("text_")) return "text";
  if (kind?.startsWith("reasoning_")) return "reasoning";
  if (kind?.startsWith("tool_") || kind === "tool_call") return "tool";
  return "other";
}

/** *_start 是段的身份源头，必须自带 assistantMessageId，不能继承上一段。 */
function isAssistantStreamStart(kind: ModelStreamingPayload["kind"]): boolean {
  return kind === "text_start" || kind === "reasoning_start" || kind === "tool_input_start";
}

/** runtime turn 身份：显式 turnId > TurnStarted 的 turnNumber > "turn-unknown"。 */
function runtimeTurnIdOf(event: SessionEvent): string {
  if (event.turnId) return String(event.turnId);
  if (event.type === SessionEventType.TurnStarted) {
    const payload = event.payload as TurnStartedPayload;
    return `turn-${payload.turnNumber}`;
  }
  return "turn-unknown";
}

/**
 * 附件口径：完整 ConversationInputIntent.attachmentRefs 优先（含稳定 ref），
 * 只有 legacy TurnStarted 才退回 payload.attachments 的三元展示字段。
 * 返回新数组，避免投影侧修改持久 payload。
 */
function normalizeAttachments(payload: TurnStartedPayload): {
  attachments?: readonly CanonicalTurnAttachment[];
} {
  if (payload.intent?.attachmentRefs && payload.intent.attachmentRefs.length > 0) {
    return { attachments: payload.intent.attachmentRefs.map((attachment) => ({ ...attachment })) };
  }
  if (!payload.attachments || payload.attachments.length === 0) return {};
  return { attachments: payload.attachments.map(normalizeAttachment) };
}

/** legacy 附件只有展示字段；ref 缺失保持缺席，不用空串伪造稳定引用。 */
function normalizeAttachment(attachment: TurnAttachmentMeta): CanonicalTurnAttachment {
  return {
    ...(attachment.ref ? { ref: attachment.ref } : {}),
    fileName: attachment.fileName,
    mime: attachment.mime,
    bytes: attachment.bytes,
  };
}

/** turnHeader 只决定轮标题呈现方式，不参与行可见性；未知来源按普通用户输入。 */
function turnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["turnHeaderOrigin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    // 中枢直接启动：turnHeader 与 userInput 同用 workflowLaunch origin，UI 据此画启动卡而非用户气泡。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "userInput";
  }
}

/**
 * origin 由 inputSource 唯一映射：mailbox/synthetic 虽可能是 trigger 行，
 * 也不能升级成 realUser；未知来源默认 realUser 以兼容旧事件。
 */
function userInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      // child 回复是 mailbox runtime carrier，不是真实用户输入；
      // live/cold 即使都隐藏它，也必须保留相同 canonical origin。
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    // 中枢直接启动：用户在中枢里的真实动作，可见 user row 但以启动卡呈现（origin 区分它与普通气泡）。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "realUser";
  }
}
