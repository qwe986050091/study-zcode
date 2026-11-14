// relay 客户端：通过 reverse RPC 从对端取回资源，并在本地重新校验完整性。
// 对端数据一律不可信，checksum 与分片长度都要自己算一遍。
import { createHash } from "node:crypto";
import { CancellationTokenSource, type IChannel } from "@zcode/rpc";
import {
  TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
  zcodeTopicResourceRelayRequestSchema,
  zcodeTopicResourceRelayMetadataSchema,
  zcodeTopicResourceRelayChunkSchema,
  type ZCodePromptAttachment,
} from "@zcode/shared";

// 鉴权单独成一次调用：读取前后都可能需要它，复用同一份参数校验。
export async function validateTopicResourceFromRelay(
  channel: Pick<IChannel, "call">,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  const request = zcodeTopicResourceRelayRequestSchema.parse(value);
  signal.throwIfAborted();
  const cancellation = new CancellationTokenSource();
  const abort = () => cancellation.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
// [事务] 取消通过 CancellationTokenSource 桥接 AbortSignal：
// RPC 层只认 token，本地调用方只认 signal，两者必须一一对应。
    const result = await channel.call<{ valid?: boolean }>("validate", request, cancellation.token);
    signal.throwIfAborted();
// [失败路径] 只有显式 true 才算通过：缺字段或异常返回都按未授权处理，
// 不能把「没说不」当成允许。
    if (result?.valid !== true) throw new Error("Topic resource authorization unavailable");
  } finally {
    signal.removeEventListener("abort", abort);
    cancellation.dispose();
  }
}

/** 单个 reverse RPC 只传一块，避免把完整 base64 附件塞进有帧上限的现有 stdio 连接。 */
// 读取分四步：begin 拿元数据 → 逐块取 → 本地校验 → finish 收口。
export async function readTopicResourceFromRelay(
  channel: Pick<IChannel, "call">,
  value: unknown,
  signal: AbortSignal,
): Promise<ZCodePromptAttachment> {
  const request = zcodeTopicResourceRelayRequestSchema.parse(value);
// 后续 chunk/finish/cancel 都只带这个最小键，避免重复传递完整请求。
  const key = { requestId: request.requestId, taskId: request.taskId };
  signal.throwIfAborted();
  const cancellation = new CancellationTokenSource();
  const abort = () => cancellation.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
// 元数据先过 schema 再使用：总字节、分片数与 checksum 都来自对端。
    const metadata = zcodeTopicResourceRelayMetadataSchema.parse(
      await channel.call("begin", request, cancellation.token),
    );
    signal.throwIfAborted();
// [失败路径] 分片数必须与字节数自洽：对端自报的分片数不可单独信任，
// 否则可以用少量分片声明一个巨大文件。
    if (metadata.totalChunks !== Math.ceil(metadata.bytes / TOPIC_RESOURCE_RELAY_CHUNK_BYTES))
      throw new Error("Invalid topic resource chunk count");
// 先全部收在内存再拼接：附件上限由协议层约束，不需要落临时文件。
// hash 与 chunks 同步推进，避免二次遍历。
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
// [并发] 逐块串行而不是并发：块序号必须严格递增，
// 乱序到达会被误判为长度不符，串行是最稳的语义。
    for (let index = 0; index < metadata.totalChunks; index++) {
      signal.throwIfAborted();
      const { dataBase64 } = zcodeTopicResourceRelayChunkSchema.parse(
        await channel.call("chunk", { ...key, index }, cancellation.token),
      );
      signal.throwIfAborted();
      const bytes = Buffer.from(dataBase64, "base64");
// 每块的期望长度由剩余字节推导，最后一块允许短于标准分片。
      const expected = Math.min(
        TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
        metadata.bytes - index * TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
      );
// [失败路径] 长度与 base64 往返同时校验：任一不符都说明数据被截断或篡改。
      if (bytes.length !== expected || bytes.toString("base64") !== dataBase64)
        throw new Error("Invalid topic resource chunk encoding or size");
// 只有校验通过的块才进入缓冲与摘要，坏块不会污染 checksum。
      chunks.push(bytes);
      hash.update(bytes);
    }
// [事务] 全量 checksum 是最终闸门：逐块正确但整体被重排也必须在这里被拒绝。
    if (`sha256:${hash.digest("hex")}` !== metadata.checksum)
      throw new Error("Topic resource checksum mismatch");
// finish 让对端释放传输状态；只有它确认完成才算交付成功。
    const result = await channel.call<{ completed?: boolean }>("finish", key, cancellation.token);
    signal.throwIfAborted();
// 对端未确认完成时不得返回附件：否则本地持有的是对端仍可回收的数据。
    if (result?.completed !== true) throw new Error("Topic resource completion unavailable");
// 返回统一的 file 形态，附上已校验的字节与元信息，供上层直接当附件使用。
    return {
      kind: "file",
      filename: metadata.fileName,
      mimeType: metadata.mime,
      sizeBytes: metadata.bytes,
      dataBase64: Buffer.concat(chunks, metadata.bytes).toString("base64"),
    };
  } catch (error) {
    // 清理不用已取消的 token；远端还有自己的 TTL 与断连回收，清理丢失不能交付半文件。
// [资源] 失败时尽力通知对端释放；即便通知丢失，对端仍有 TTL 与断连回收兜底。
    void channel.call("cancel", key).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    cancellation.dispose();
  }
}
