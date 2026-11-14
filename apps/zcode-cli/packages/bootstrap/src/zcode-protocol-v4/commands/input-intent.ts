// canonical 输入意图（TurnInputIntentMetadata）的构造与来源保真。
//
// 三个入口对应 session_input 账本的不同写入阶段，禁止互相「重建」：
// - inputIntentMetadata：新命令（sendText/sendGoalCommand/compact/首条输入），
//   sourceCommandId = 本次 commandId，admissionSeq 取真实准入序号；
// - inputIntentMetadataFromCanonical：edit/retry 用新 commandId 重发旧意图，
//   provenance 指回原始 command，不改变原 kind/delivery；
// - inputIntentMetadataFromQueueItem：queue 提升，身份继续沿用原 QueueItem 的
//   sourceCommandId/queueItemId，绝不能被 promotion commandId 覆盖。
// 关键字段口径：queueItemId = 账本与 overlay 收口的 key；kind 决定消费语义
// （compact / sendGoalCommand 是 typed intent，不是普通 prompt）。
import type { TurnInputIntentMetadata } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared";
import type {
  AttachmentRef,
  CommandEnvelope,
  CommandPayloadMap,
  QueueItem,
  SubmissionMode,
} from "@zcode/shared/zcode-protocol-v4";
import { commandAdmissionOf } from "./executor.js";

/**
 * canonical 意图的可复用投影（用于 edit/retry 重放）：只保留「用户意图」字段，
 * 不含本次准入的 admissionSeq。sourceCommandId/queueItemId/clientId 都必须
 * 原样带到下一次重发，provenance 才能在多轮编辑后仍指回最初那条输入。
 */
export interface CanonicalCommandIntent {
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: TurnInputIntentMetadata["botGroupSource"];
  kind: "sendText" | "sendGoalCommand";
  text: string;
  modelSelection?: ModelSelection;
  mode?: SubmissionMode;
  planEnabled?: boolean;
  sourceCommandId?: string;
  clientId?: string;
  queueItemId?: string;
  requestedDelivery?: TurnInputIntentMetadata["requestedDelivery"];
  admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
  fallbackReasonCode?: string;
  attachmentRefs?: readonly AttachmentRef[];
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  provenance?: TurnInputIntentMetadata["provenance"];
  source?: TurnInputIntentMetadata["source"];
}

/**
 * 由命令 envelope + handler 决策生成 canonical 输入意图。
 * 输入：envelope（commandId/clientId/type/payload）与 handler 已解算的
 * 文本、投递方式、附件引用、Selection/Mode/Plan、来源元信息。
 * 输出：TurnInputIntentMetadata；sourceCommandId=commandId、queueItemId 取准入锚点，
 * admittedDelivery 在未显式给定时按 requestedDelivery 推导（guide→guide、
 * queue→queue、其余→startNow）。
 * 无 durable 副作用；仅把 payload 的 highspeedMeta 原样透传（用于投影展示加速标记）。
 */
export function inputIntentMetadata(
  envelope: CommandEnvelope,
  options: {
    text: string;
    inputOrigin?: "desktop" | "mobile";
    conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
    botGroupSource?: TurnInputIntentMetadata["botGroupSource"];
    requestedDelivery: TurnInputIntentMetadata["requestedDelivery"];
    admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
    fallbackReasonCode?: string;
    attachmentRefs?: readonly AttachmentRef[];
    modelSelection?: ModelSelection;
    mode?: SubmissionMode;
    planEnabled?: boolean;
    sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
    source?: TurnInputIntentMetadata["source"];
  },
): TurnInputIntentMetadata {
  const admission = commandAdmissionOf(envelope);
  const highspeed =
    envelope.type === "sendText"
      ? (envelope.payload as CommandPayloadMap["sendText"]).highspeedMeta
      : undefined;
  return {
    ...(options.inputOrigin ? { inputOrigin: options.inputOrigin } : {}),
    ...(options.conversationQuotes ? { conversationQuotes: options.conversationQuotes } : {}),
    ...(options.botGroupSource ? { botGroupSource: options.botGroupSource } : {}),
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind:
      envelope.type === "compact"
        ? "compact"
        : envelope.type === "sendGoalCommand"
          ? "sendGoalCommand"
          : "sendText",
    // live intent 过去只带 kind/来源，projection 只能回退可见 command 文案；
    // goal 的 displayText（如 `/GoAl replace X`）不是 runtime 已解析的 canonical objective。
    text: options.text,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.planEnabled !== undefined ? { planEnabled: options.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: options.requestedDelivery,
    admittedDelivery:
      options.admittedDelivery ??
      (options.requestedDelivery === "guide"
        ? "guide"
        : options.requestedDelivery === "queue"
          ? "queue"
          : "startNow"),
    ...(options.fallbackReasonCode ? { fallbackReasonCode: options.fallbackReasonCode } : {}),
    ...(options.attachmentRefs ? { attachmentRefs: [...options.attachmentRefs] } : {}),
    ...(options.sharedContextRefs ? { sharedContextRefs: [...options.sharedContextRefs] } : {}),
    ...(highspeed ? { highspeed } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
}

/**
 * edit/retry 重发时重建 canonical 意图：身份换成新 commandId（幂等锚点必须更新），
 * 语义字段（kind/delivery/来源/quotes/附件）沿用原 canonical 值。
 * provenance 优先取 canonical 已有值，否则用原始 sourceCommandId/queueItemId/clientId
 * 补一条，保证「这条新命令是某条旧输入的编辑」这一事实不丢。
 * 无副作用。
 */
/** edit/retry 以新 commandId 重建，但保留原 canonical kind/delivery/cause。 */
export function inputIntentMetadataFromCanonical(
  envelope: CommandEnvelope,
  canonical: CanonicalCommandIntent,
  text = canonical.text,
): TurnInputIntentMetadata {
  const admission = commandAdmissionOf(envelope);
  const originalSourceCommandId =
    canonical.provenance?.sourceCommandId ?? canonical.sourceCommandId;
  return {
    ...(canonical.inputOrigin ? { inputOrigin: canonical.inputOrigin } : {}),
    ...(canonical.conversationQuotes ? { conversationQuotes: canonical.conversationQuotes } : {}),
    ...(canonical.botGroupSource ? { botGroupSource: canonical.botGroupSource } : {}),
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || canonical.clientId || "cli",
    kind: canonical.kind,
    text,
    ...(canonical.modelSelection ? { modelSelection: canonical.modelSelection } : {}),
    ...(canonical.mode ? { mode: canonical.mode } : {}),
    ...(canonical.planEnabled !== undefined ? { planEnabled: canonical.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: canonical.requestedDelivery ?? "startNow",
    admittedDelivery: canonical.admittedDelivery ?? "startNow",
    ...(canonical.fallbackReasonCode ? { fallbackReasonCode: canonical.fallbackReasonCode } : {}),
    ...(canonical.attachmentRefs ? { attachmentRefs: [...canonical.attachmentRefs] } : {}),
    ...(canonical.sharedContextRefs ? { sharedContextRefs: [...canonical.sharedContextRefs] } : {}),
    ...(canonical.source ? { source: canonical.source } : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.queueItemId ? { queueItemId: canonical.queueItemId } : {}),
            ...(canonical.clientId ? { clientId: canonical.clientId } : {}),
          },
        }
      : {}),
  };
}

/**
 * queue 提升时由原 QueueItem 还原意图（sendQueuedNow / auto-drain 共用）。
 * 关键口径：sourceCommandId 与 queueItemId 全部取自 item，admissionSeq 取
 * item.order.admissionSeq（权威排队顺序），text 允许由调用方换成解析后的
 * objective/canonical 文本，但其余身份字段一律不得重建。
 * 无副作用；不读取会话当前可变状态。
 */
/** sendQueuedNow 只能转换原 QueueItem，禁止用 promotion commandId 重建来源。 */
export function inputIntentMetadataFromQueueItem(
  item: QueueItem,
  canonicalText: string,
): TurnInputIntentMetadata {
  return {
    ...(item.inputOrigin ? { inputOrigin: item.inputOrigin } : {}),
    ...(item.conversationQuotes ? { conversationQuotes: item.conversationQuotes } : {}),
    ...(item.botGroupSource ? { botGroupSource: item.botGroupSource } : {}),
    sourceCommandId: item.sourceCommandId,
    queueItemId: item.queueItemId,
    clientId: item.clientId,
    kind: item.kind,
    text: canonicalText,
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
    ...(item.mode ? { mode: item.mode } : {}),
    ...(item.planEnabled !== undefined ? { planEnabled: item.planEnabled } : {}),
    admissionSeq: item.order.admissionSeq,
    admittedAt: item.admittedAt,
    requestedDelivery: item.delivery.requested,
    admittedDelivery: item.delivery.admitted,
    ...(item.order.queuePosition !== undefined ? { queuePosition: item.order.queuePosition } : {}),
    ...(item.delivery.fallbackReasonCode
      ? { fallbackReasonCode: item.delivery.fallbackReasonCode }
      : {}),
    attachmentRefs: item.attachments,
    ...(item.sharedContextRefs ? { sharedContextRefs: [...item.sharedContextRefs] } : {}),
    ...(item.highspeed ? { highspeed: item.highspeed } : {}),
    ...(item.source ? { source: item.source } : {}),
    // 提升只改变调度状态；重试／编辑原始输入的来源关联不能在此丢失。
    ...(item.provenance ? { provenance: { ...item.provenance } } : {}),
  };
}
