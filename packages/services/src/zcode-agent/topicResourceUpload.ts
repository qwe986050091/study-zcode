import {
  V4_METHODS,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  v4AttachmentAbortResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  zcodeTopicResourceReadResultSchema,
  type ZCodePromptAttachment,
  type ZCodeProtocolTrace,
} from "@zcode/shared";
import { uploadBotGroupAttachments } from "./groupAttachmentUpload.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import type { ZCodeAgentSessionTarget } from "./zcodeAgent.js";

/** 反向请求绑定实际 CLI 连接；上传不能再次按路径选择运行时。 */
// [并发] 上传必须复用本次反向请求实际命中的 CLI 连接：
// 再次按路径挑选运行时可能落到另一个进程，读到的资源就不是同一份。
export async function uploadTopicResourceToClient(
// 只依赖 request 能力而不是整个 protocol client，便于测试注入并限制耦合面。
// 调用方无法通过这里拿到订阅或生命周期控制权。
  client: Pick<ZCodeProtocolClient, "request">,
// connectionId 由连接侧下发，作为服务端路由与幂等边界的组成部分。
  connectionId: string,
// target 只提供 session/workspace 归属，不参与运行时选择：
// 真正的传输目标已经由 client 固定。
  target: ZCodeAgentSessionTarget,
// 单个附件对象即可，不在此做批量拆分：批量语义由上层群队列决定。
  attachment: ZCodePromptAttachment,
// [资源] signal 贯穿 begin/chunk/commit/abort 四个请求，
// 任一阶段被取消都会让整条上传停止，不会留下半个附件。
  signal: AbortSignal,
// trace 只用于诊断链路，不参与协议字段。
  trace?: ZCodeProtocolTrace,
) {
// 复用群附件上传实现，避免出现第二套分片与校验逻辑；
// 这里只取第一条结果，因为输入本就只有一个附件。
  const [ref] = await uploadBotGroupAttachments(
    {
// begin 携带文件名、mime、总字节、分片数与 checksum：
// 服务端据此在收到任何分片前就能拒绝超限或损坏的资源。
      attachmentBeginV4: (p) =>
        client.request(
// 每个请求都以 V4_METHODS 常量寻址，并绑定各自的响应 schema：协议错误在请求边界暴露。
          V4_METHODS.attachmentBegin,
          {
            connectionId,
            uploadId: p.uploadId,
            sessionId: p.sessionId,
            fileName: p.fileName,
            mime: p.mime,
            totalBytes: p.totalBytes,
// 总字节与分片数一起下发，便于服务端在 begin 阶段就做一致性预检。
            totalChunks: p.totalChunks,
// checksum 由本地对真实字节计算，服务端可据此拒绝已被替换的内容。
            checksum: p.checksum,
          },
          v4AttachmentBeginResultSchema,
          { signal, trace },
        ),
// 分片只送索引与 base64 数据，不在这一层做重试；
// 重试由上传循环按 nextChunkIndex 推进，保证幂等。
      attachmentChunkV4: (p) =>
        client.request(
          V4_METHODS.attachmentChunk,
          {
            connectionId,
            uploadId: p.uploadId,
            sessionId: p.sessionId,
// 分片索引必须由上传循环提供，客户端不能自行重排或省略。
            chunkIndex: p.chunkIndex,
            dataBase64: p.dataBase64,
          },
          v4AttachmentChunkResultSchema,
          { signal, trace },
        ),
// commit 是唯一的落库确认点：只有它返回成功，上层才会拿到引用。
      attachmentCommitV4: (p) =>
        client.request(
          V4_METHODS.attachmentCommit,
          {
            connectionId,
            uploadId: p.uploadId,
            sessionId: p.sessionId,
          },
          v4AttachmentCommitResultSchema,
          { signal, trace },
        ),
// [失败路径] abort 使用独立请求且不挂 trace/signal：
// 取消路径本身不能因为原 signal 已中止而失效。
      attachmentAbortV4: async (p) => {
        await client.request(
          V4_METHODS.attachmentAbort,
          {
            connectionId,
            uploadId: p.uploadId,
            sessionId: p.sessionId,
          },
          v4AttachmentAbortResultSchema,
        );
      },
    },
    target,
// 以数组形式传入以保持与批量上传同构，便于将来扩展而不改签名。
    [attachment],
    signal,
  );
// 返回值再做一次 schema 校验，确保跨实现传递的引用结构始终合法。
  return zcodeTopicResourceReadResultSchema.parse(ref);
}
