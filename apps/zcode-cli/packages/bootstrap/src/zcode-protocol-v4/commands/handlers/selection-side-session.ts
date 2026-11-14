// 选区侧边会话组：createSelectionSideSession。
// 在父会话之外创建一个只承接选区追问的 child 会话（selection_side_chat），
// 可选立即提交首条输入；child 有独立 CommandInbox/queue，不污染父会话运行态。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { commandAdmissionOf } from "../executor.js";
import { inputIntentMetadata } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/**
 * createSelectionSideSession：创建选区侧边会话，可选提交首条输入。
 * 输入：envelope（父 sessionId）+ payload.firstInput（text/modelSelection 可选）。
 * 输出：ACK.result 携带 child 的 sessionId（导航锚点）与可选 input
 * （delivery/inputId/messageId）；这是客户端跳转到侧边会话的唯一权威来源。
 * 副作用：宿主创建 child record 并注册；首条输入复用父 envelope 但指向 child，
 * 经同一 session_input 账本 admission 后 startPromptTurn（durable 写入落在 child）。
 * 失败：宿主能力缺失直接抛；首条输入失败时若已 admission 则尝试 cancelInputCommand，
 * 取消失败只 warn（重启后仍按 discarded 收口），原始错误继续上抛，不伪造成功。
 * 维护的不变量：child 首条输入绝不经父 CommandInbox；父 queue 与运行态不受影响。
 */
async function createSelectionSideSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const payload = envelope.payload as CommandPayloadMap["createSelectionSideSession"];
  const record = requireRecord(host, envelope.sessionId);
  if (!host.createSelectionSideSession) {
    throw new Error("v4 createSelectionSideSession requires host capability");
  }
  const result = await host.createSelectionSideSession(record.app.sessionId, {
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    ...(payload.firstInput?.modelSelection
      ? { modelSelection: payload.firstInput.modelSelection }
      : {}),
  });
  const childSessionId = result.sessionId;
  const firstInput = payload.firstInput;
  if (!firstInput) {
    return { type: "createSelectionSideSession", sessionId: childSessionId };
  }

  // child 已在 host 中注册后再启动首条输入；输入只落到 child，父会话的
  // CommandInbox/queue 不参与这次 admission，因此不会改变父 turn 的运行态。
  const childRecord = requireRecord(host, childSessionId);
  const admission = commandAdmissionOf(envelope);
  // gateway 不会把 createSelectionSideSession 当成父会话的输入命令；handler 直接把
  // 同一条 envelope 指向 child，复用 session_input 账本而不污染父 queue。
  const durableAdmission =
    (await host.admitInputCommand?.(envelope, childSessionId, admission)) ?? null;
  try {
    const started = await startPromptTurn(host, childRecord, {
      content: firstInput.text,
      inputId: envelope.commandId,
      intent: inputIntentMetadata(envelope, {
        text: firstInput.text,
        requestedDelivery: "startNow",
      }),
    });
    const input = {
      delivery: started.admission.kind === "queued" ? ("queue" as const) : ("startNow" as const),
      inputId: envelope.commandId,
      ...(started.messageId ? { messageId: started.messageId } : {}),
    };
    return {
      type: "createSelectionSideSession",
      sessionId: childSessionId,
      ...(input ? { input } : {}),
    };
  } catch (error) {
    if (durableAdmission) {
      try {
        await host.cancelInputCommand?.(
          childSessionId,
          admission.queueItemId,
          "fault.command.inputRejected",
        );
      } catch (cancelError) {
        host.logger?.warn?.("v4 selection side first input cancellation failed", {
          cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
          inputError: error instanceof Error ? error.message : String(error),
          queueItemId: admission.queueItemId,
          sessionId: childSessionId,
        });
      }
    }
    throw error;
  }
}

/** 本组原生命令注册表（选区侧边会话），供 handlers/index.ts 合并。 */
export const selectionSideSessionHandlers = {
  createSelectionSideSession,
};
