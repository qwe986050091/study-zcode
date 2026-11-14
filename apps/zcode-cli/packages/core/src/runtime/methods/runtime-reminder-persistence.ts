/**
 * runtime-reminder-persistence.ts —— 隐藏提醒(system reminder)的持久化
 *
 * 隐藏提醒对模型可见、对 UI/transcript 隐藏(visibility=model-only)。
 * 普通收集与 compact 重建共用这套落盘逻辑:正文与 runtime metadata 写入同一 text part,
 * 保证冷恢复后 provider 看到的内容与当时一致。
 * 落盘失败时会尝试回滚已写入的消息(尽力而为,不覆盖原错误)。
 */
import {
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  modelMessageContentToText,
  traceContextToLogContext,
  type MessageId,
  type MessageProjectionAnchor,
  type Model,
  type TraceContext,
} from "@zcode/contracts";
import {
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 普通收集和 compact 共用隐藏提醒落盘，正文与 runtime metadata 写入同一 text part。 */
export async function persistRuntimeReminderMessage(
  this: AgentRuntimeInternal,
  entry: RuntimeMessageEntry,
  traceContext: TraceContext,
  options: { created?: number; model?: Model; anchor?: MessageProjectionAnchor } = {},
): Promise<MessageId | undefined> {
  if (!this.sessionStore || !entry.metadata) return;
  const content = isRuntimeAttachmentEntry(entry)
    ? entry.content
    : entry.metadata.toolSearchAnnouncement
      ? modelMessageContentToText(entry.message.content)
      : undefined;
  if (content === undefined) return;

  const created = options.created ?? Date.now();
  const messageID = createMessageId();
  try {
    await this.persistMessage(
      {
        id: messageID,
        sessionID: this.sessionId,
        role: "user",
        time: { created },
        agent: this.config.agentName ?? "zcode-agent",
        metadata: reminderPartMetadata(entry.metadata),
        modelSelection: resolvePersistedReminderModel(this, options.model),
        ...(options.anchor ? { anchor: options.anchor } : {}),
        semantics: {
          origin: "agent_runtime",
          kind: "system_reminder",
          source: entry.metadata.source,
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        system: this.config.systemPrompt,
        synthetic: true,
        tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
        visibility: "model-only",
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "text",
        text: content,
        synthetic: true,
        time: { start: created, end: created },
        metadata: reminderPartMetadata(entry.metadata),
      },
      traceContext,
    );
    return messageID;
  } catch (error) {
    await removeRuntimePersistenceMessagesBestEffort.call(this, [messageID], traceContext);
    throw error;
  }
}

export function resolvePersistedReminderModel(runtime: AgentRuntimeInternal, model?: Model) {
  if (model) return { providerId: model.providerId, modelId: model.modelId };
  const selection = runtime.getSessionModelSelection();
  return selection
    ? {
        providerId: createModelProviderId(selection.providerId),
        modelId: createModelId(selection.modelId),
      }
    : undefined;
}

export async function removeRuntimePersistenceMessagesBestEffort(
  this: AgentRuntimeInternal,
  messageIds: readonly MessageId[],
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;
  for (const rollbackMessageId of new Set(messageIds)) {
    try {
      await this.sessionStore.removeMessage({
        sessionID: this.sessionId,
        messageID: rollbackMessageId,
      });
    } catch (cleanupError) {
      this.logger?.warn("Runtime message persistence cleanup failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        event: "runtime.persistence.cleanup_failed",
        messageId: rollbackMessageId,
        module: "core.runtime",
      });
    }
  }
}

function reminderPartMetadata(runtimeMessage: RuntimeMessageMetadata): Record<string, unknown> {
  return { runtimeMessage, source: runtimeMessage.source, visibility: "model-only" };
}
