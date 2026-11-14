import { createHash } from "node:crypto";
import type { TurnAttachment } from "@zcode/core";
import type {
  InputHistoryAttachment,
  InputHistoryEntry,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
} from "@zcode/contracts";
import type { PromptInput } from "./types.js";

/**
 * 把两种输入形态（裸字符串 / `{text, attachments}`）归一成内部形状。
 *
 * 输出 `attachments` 只原样搬运，不做任何 I/O；字符串输入不带附件。纯函数，不校验空文本——
 * 空输入的业务判定在上层 admission，这里只负责形态。
 */
export function normalizePromptInput(input: PromptInput): {
  text: string;
  attachments?: TurnAttachment[];
} {
  if (typeof input === "string") {
    return { text: input };
  }
  return {
    text: input.text,
    attachments: input.attachments,
  };
}

/**
 * TurnAttachment → 旧 InputHistory 契约的显式投影（只保留该端口支持的字段）。
 *
 * video 被丢弃：InputHistory 端口没有对应成员，强行扩契约会让存储行为与类型分裂。path /
 * content 按存在性带上；没有任何可投影附件时回 `undefined` 而非空数组，让历史条目保持“无附件”。
 */
export function projectInputHistoryAttachments(
  attachments: TurnAttachment[] | undefined,
): InputHistoryAttachment[] | undefined {
  const projected: InputHistoryAttachment[] = [];
  for (const attachment of attachments ?? []) {
    // TurnAttachment 新增 video 后曾直接扩大 legacy InputHistory contract；
    // 这里显式投影该端口真正支持的类型，避免类型契约与存储行为分裂。PDF 已加入该端口，
    // 以便 input history 也保留 durable artifact ref。
    if (attachment.type === "video") continue;
    projected.push({
      type: attachment.type,
      ...(attachment.path !== undefined ? { path: attachment.path } : {}),
      ...(attachment.content !== undefined ? { content: attachment.content } : {}),
    });
  }
  return projected.length > 0 ? projected : undefined;
}

/**
 * 把内联 data URL 的图片 / PDF 附件外置成 durable artifact，返回新的附件数组。
 *
 * 只处理 `type ∈ {image, pdf}` 且 content 以 `data:` 开头的项；写入走 artifactStore 的
 * writeToolResultArtifact（retention=session，工具名标记来源，toolCallId 由序号 + 内容摘要生成，
 * 保证同一次输入内稳定）。成功时 `content` 替换为 `zcode-artifact://` uri。
 * 失败语义：没有 store、或写入抛错时**不阻断输入**，退化为去掉内联 content 的附件（至少不让
 * 巨量 base64 进上下文）；空数组归一为 undefined。
 */
export async function externalizePromptAttachments(
  attachments: TurnAttachment[] | undefined,
  options: {
    artifactStore?: ToolArtifactStorePort;
    sessionId: SessionId;
    traceContext: TraceContext;
  },
): Promise<TurnAttachment[] | undefined> {
  const externalized = await Promise.all(
    (attachments ?? []).map(async (attachment, index): Promise<TurnAttachment> => {
      if (!isInlineImageAttachment(attachment)) return attachment;
      if (!options.artifactStore) return attachmentWithoutInlineContent(attachment);

      try {
        const artifact = await options.artifactStore.writeToolResultArtifact({
          content: attachment.content,
          contentType: "text/plain",
          retention: "session",
          sessionId: options.sessionId,
          toolCallId: attachmentArtifactCallId(attachment, index),
          toolName: `prompt-attachment:${attachment.type}`,
          trace: options.traceContext,
        });
        return {
          ...attachment,
          content: artifact.uri,
        };
      } catch {
        return attachmentWithoutInlineContent(attachment);
      }
    }),
  );

  return externalized.length > 0 ? externalized : undefined;
}

/**
 * 读取历史条目时把 `zcode-artifact://` 附件还原成内联内容。
 *
 * 输入是已落库的历史条目（可能为 null）与可选 store；只对 content 以协议前缀开头的附件读字节。
 * 失败语义：没有 store 时原样返回；单个附件读取失败时退化为去掉 content（历史条目仍可展示，
 * 不让一条坏引用拖垮整段历史）。返回新对象，不改入参。
 */
export async function materializeInputHistoryEntry(
  entry: InputHistoryEntry | null,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<InputHistoryEntry | null> {
  if (!entry?.attachments || !artifactStore) return entry;
  const attachments = await Promise.all(
    entry.attachments.map(async (attachment): Promise<InputHistoryAttachment> => {
      if (!attachment.content?.startsWith("zcode-artifact://")) return attachment;
      try {
        const artifact = await artifactStore.readToolResultArtifact({ uri: attachment.content });
        return {
          ...attachment,
          content: artifact.content,
        };
      } catch {
        return attachmentWithoutInlineContent(attachment);
      }
    }),
  );
  return {
    ...entry,
    attachments,
  };
}

function isInlineImageAttachment(
  attachment: TurnAttachment,
): attachment is TurnAttachment & { content: string } {
  return (
    (attachment.type === "image" || attachment.type === "pdf") &&
    attachment.content?.startsWith("data:") === true
  );
}

function attachmentWithoutInlineContent<T extends TurnAttachment | InputHistoryAttachment>(
  attachment: T,
): T {
  const { content: _content, ...rest } = attachment;
  return rest as T;
}

function attachmentArtifactCallId(
  attachment: TurnAttachment & { content: string },
  index: number,
): string {
  const digest = createHash("sha256").update(attachment.content).digest("hex").slice(0, 16);
  return `prompt-attachment-${index + 1}-${digest}`;
}
