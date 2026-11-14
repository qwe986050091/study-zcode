/**
 * ============================================================================
 * runtime/methods/input-intent-persistence.ts —— 输入意图的"一次固化"
 * ============================================================================
 *
 * 【问题】一次用户输入包含很多隐含状态：投递方式（queue/guide）、排队位置、
 * 来源命令、模型/模式意图、附件、高速卡等。如果只持久化 text + 零散 metadata，
 * 冷恢复时必须重新推断这些状态，结果极易与 live 投影不一致
 * （例如 UI 显示"已插入本轮"，重启后却变成"排队等待下一轮"）。
 *
 * 【做法】在 admission/drain 两个边界一次性把完整事实固化成 JSON：
 *   - delivery.requested/admitted/fallbackReasonCode；
 *   - order.admissionSeq/queuePosition；
 *   - steer.state（notRequested / steering / guided / fellBack）；
 *   - dispatch.state（queued / drained）。
 * 之后所有消费者只读，不再猜测。
 *
 * 【群任务授权】ensureGroupTaskPermissionScope：bot 群来源的任务必须在工具执行前
 * 把会话权限 scope 收紧为 session；正文不能携带/改写这个可信 metadata。
 * ============================================================================
 */

import type { SessionStorePort, SessionId } from "@zcode/contracts";
import type { TurnInputIntentMetadata } from "../deps.js";

/**
 * 把 runtime 的协议无关参数组装成 transcript/ledger 共用的完整输入事实。
 *
 * 只分别保存 text 与一组 metadata 的话，恢复端必须再次推断 delivery、
 * steer 和 dispatch，容易让 live projection 与 cold snapshot 出现不同状态。这里在
 * admission/drain 边界一次性固化，后续消费者只能读取，不能重新猜测。
 */
export function buildPersistedConversationInputIntent(
  text: string,
  intent: TurnInputIntentMetadata | undefined,
  dispatchState: "queued" | "drained",
): Record<string, unknown> | undefined {
  // 没有 intent 就不写空对象：历史里出现空的 conversationInputIntent 会让 hydration
  // 误判为"有意图但字段缺失"，比完全不写更容易产生 live/cold 不一致。
  if (!intent) return undefined;

  // fallbackReasonCode 优先于 admittedDelivery：一旦投递降级，admitted 值已不可信，
  // 必须以 fellBack 记录"实际发生过降级"，否则 UI 会显示成正常的 guide/queue。
  const steer = intent.fallbackReasonCode
    ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
    : intent.admittedDelivery === "guide"
      ? { state: dispatchState === "drained" ? "guided" : "steering" }
      : { state: "notRequested" };

  return {
    ...(intent.inputOrigin ? { inputOrigin: intent.inputOrigin } : {}),
    ...(intent.conversationQuotes ? { conversationQuotes: intent.conversationQuotes } : {}),
    ...(intent.botGroupSource ? { botGroupSource: intent.botGroupSource } : {}),
    sourceCommandId: intent.sourceCommandId,
    queueItemId: intent.queueItemId,
    clientId: intent.clientId,
    kind: intent.kind,
    // goal 的 message text 可以是 `/goal ...` 展示文案；admission 已持有 runtime
    // 解析后的 canonical objective，持久化必须优先使用它以保证 live/cold 等价。
    text: intent.text ?? text,
    attachments: intent.attachmentRefs ?? [],
    ...(intent.modelSelection ? { modelSelection: intent.modelSelection } : {}),
    ...(intent.mode ? { mode: intent.mode } : {}),
    ...(intent.planEnabled !== undefined ? { planEnabled: intent.planEnabled } : {}),
    ...(intent.sharedContextRefs ? { sharedContextRefs: intent.sharedContextRefs } : {}),
    delivery: {
      requested: intent.requestedDelivery,
      admitted: intent.admittedDelivery,
      ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq: intent.admissionSeq,
      ...(intent.queuePosition !== undefined ? { queuePosition: intent.queuePosition } : {}),
    },
    steer,
    dispatch: { state: dispatchState },
    admittedAt: intent.admittedAt,
    ...(intent.highspeed ? { highspeed: intent.highspeed } : {}),
    ...(intent.provenance ? { provenance: intent.provenance } : {}),
    ...(intent.source ? { source: intent.source } : {}),
  };
}

/**
 * 群任务授权收紧。
 *
 * 只有 intent.botGroupSource 存在才触发；缺少 store/session 时直接抛错，
 * 不允许"没有持久化也照样跑群任务"——那会以默认权限执行，等于绕过授权边界。
 * scope 已是 session 时幂等返回；否则写入 version=1 的最小权限快照。
 */
export async function ensureGroupTaskPermissionScope(
  store: SessionStorePort | undefined,
  sessionId: SessionId,
  intent: TurnInputIntentMetadata | undefined,
): Promise<void> {
  // 非群来源任务保持现状：scope 收紧只针对 bot 群来源，普通会话不能被静默改写权限。
  if (!intent?.botGroupSource) return;
  if (!store) throw new Error("Group task permission scope requires persistence");
  const session = await store.getSession(sessionId);
  if (!session) throw new Error("Group task permission scope requires a persisted session");
  // 幂等：已是 session 就不再写，避免每次 drain 都 bump 权限 revision（会让审批记忆失效）。
  if (session.permission?.scope === "session") return;
  await store.updateSession({
    id: sessionId,
    permission: { version: 1, scope: "session", mode: "build" },
  });
}
