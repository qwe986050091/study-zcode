import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ZCodePromptAttachment } from "@zcode/shared";
import { PROTOCOL_V4_LIMITS, type AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "#src/zcode-agent/zcodeAgent.js";

// 384 KiB 分片：base64 膨胀后仍低于协议帧上限，同时避免分片过多带来往返开销。
// 该值只影响传输节奏，不改变最终 checksum 的语义。
const CHUNK_BYTES = 384 * 1024;
type UploadAgent = Pick<
  IZCodeAgentService,
  "attachmentBeginV4" | "attachmentChunkV4" | "attachmentCommitV4" | "attachmentAbortV4"
>;

/** 内容寄存在目标 CLI，群队列只保存引用；远端不能直接使用桌面临时路径。 */
// [边界] 桌面路径不得跨端传递：字节必须经 uploadBotGroupAttachments 推过协议，引用只留在群队列。
// 因此这里必须真正把字节推过协议，而不是只转发路径。
export async function uploadBotGroupAttachments(
  agent: UploadAgent,
  target: ZCodeAgentSessionTarget,
  attachments: readonly ZCodePromptAttachment[],
  signal?: AbortSignal,
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const attachment of attachments) {
    signal?.throwIfAborted();
// [失败路径] 三种内容来源按优先级：内联 base64 → 本地路径 → 文本内容；
// 文本只对 kind=file 生效，其他类型没有可上传的字节。
    const data =
      attachment.dataBase64 !== undefined
        ? Buffer.from(attachment.dataBase64, "base64")
        : attachment.localPath
          ? await readFile(attachment.localPath, { signal })
          : attachment.kind === "file" && attachment.textContent !== undefined
            ? Buffer.from(attachment.textContent)
            : null;
// 取不到内容就直接失败，不生成只有元信息的空附件。
    if (!data) throw new Error("Attachment content is unavailable");
// [事务] 大小检查在读入之后、上传之前：既避免无谓分片，也保证服务端不会先收到半份数据。
    if (data.length > PROTOCOL_V4_LIMITS.attachmentMaxBytes)
      throw new Error("Attachment exceeds protocol size limit");
// [并发] 每个附件独立 uploadId：重试或并行上传不会互相覆盖进度。
// target 只带归属字段，uploadId 才是本次传输的身份。
    const common = { ...target, uploadId: randomUUID() };
    const totalChunks = Math.ceil(data.length / CHUNK_BYTES);
// 引用里固定带上真实字节数与本端元信息，供后续展示与校验使用。
    const toRef = (ref: string): AttachmentRef => ({
      ref,
      fileName: attachment.filename,
      mime: attachment.mimeType,
      bytes: data.length,
      ...(attachment.kind === "file" && attachment.sourceKind
        ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
        : {}),
    });
// 上传主体包在 try 中：任何阶段失败都要走 abort，保证服务端不残留半成品。
    try {
      // begin 的确认也可能丢失；从发送起就按 uploadId 清理，不等待确认后才标记。
// begin 返回已提交状态或下一个待传索引，支持断点续传语义。
      const begin = await agent.attachmentBeginV4({
        ...common,
        fileName: attachment.filename,
        mime: attachment.mimeType,
        totalBytes: data.length,
        totalChunks,
        checksum: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      });
      signal?.throwIfAborted();
// [事务] 服务端已提交说明同 uploadId 的传输完成过，直接复用引用，不重复上传字节。
// 这也是重试路径保持幂等的关键。
      if (begin.state === "committed") {
        refs.push(toRef(begin.ref));
        continue;
      }
// [失败路径] 进度越界说明双方对分片数的理解不一致，继续上传只会得到错位的附件。
      if (begin.nextChunkIndex > totalChunks) throw new Error("Invalid attachment upload progress");
// 从服务端给出的索引起继续传，天然支持前一次中断后的续传。
      for (let index = begin.nextChunkIndex; index < totalChunks; index++) {
        signal?.throwIfAborted();
        const chunk = await agent.attachmentChunkV4({
          ...common,
          chunkIndex: index,
          dataBase64: data
            .subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
// 切片按标准分片大小对齐，最后一块自然截断，不做额外填充。
            .toString("base64"),
        });
// 每块都核对推进值，乱序或丢块会立刻暴露而不是等到 commit。
        if (chunk.nextChunkIndex !== index + 1)
          throw new Error("Invalid attachment upload progress");
      }
      // 取消可能在最后一个分块期间发生；提交前再次检查，避免交付已取消的资源。
      signal?.throwIfAborted();
// 提交前已再次检查取消信号，这里返回成功即代表服务端已持久化。
// commit 返回的引用才是最终可信结果，此前的 begin 引用仅用于续传判断。
      const committed = await agent.attachmentCommitV4(common);
      signal?.throwIfAborted();
// 成功的附件按输入顺序累积，返回顺序与入参一一对应。
      refs.push(toRef(committed.ref));
    } catch (error) {
// [资源] 任一步失败都尽力 abort；abort 自身失败不覆盖原始错误。
      await agent.attachmentAbortV4(common).catch(() => undefined);
      throw error;
    }
  }
  return refs;
}
