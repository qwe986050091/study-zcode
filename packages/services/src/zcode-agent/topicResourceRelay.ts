// 主题资源中转：把本地已落盘的附件按协议 v4 切片回传给远端。
// 只做有界缓存与校验，不参与任何业务决策。
import { createHash } from "node:crypto";
import {
  TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
  zcodeTopicResourceRelayRequestSchema,
  zcodeTopicResourceRelayKeySchema,
  zcodeTopicResourceRelayChunkRequestSchema,
  zcodeTopicResourceRelayMetadataSchema,
  type ZCodeTopicResourceRelayRequest,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

// reply 可选：宿主环境不一定提供回执通道；validate 与 read 都必须可被 signal 打断，
// 因为传输随时可能因超时、取消或连接销毁而中止。
export interface TopicResourceRelayDependencies {
  reply?(
    request: import("@zcode/shared").ChannelReplyHostRequest,
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
// [事务] validate 会在 begin 前后各调用一次：读取可能耗时，期间任务归属或权限
// 可能已变化，因此交出字节前必须再确认一次。
  validate(request: ZCodeTopicResourceRelayRequest, signal: AbortSignal): Promise<void>;
  read(
    request: ZCodeTopicResourceRelayRequest,
    signal: AbortSignal,
  ): Promise<ZCodePromptAttachment>;
}
// 单条传输的完整状态：timer 负责 120s 硬超时，data 在 begin 成功后才出现。
// controller 供取消与销毁统一打断正在进行的 validate/read。
interface Transfer {
  request: ZCodeTopicResourceRelayRequest;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  data?: Buffer;
}

/** 只缓存有界附件字节；过载直接拒绝，不构成第二份执行队列。每条远程连接独立持有。 */
// [并发] 每个远程连接各自持有一个 relay 实例，transfers 不存在跨连接共享，
// 因此 requestId 的冲突范围仅限单连接，不会互相踩踏。
export function createTopicResourceRelay(deps: TopicResourceRelayDependencies) {
// ID 是 requestId 而不是 taskId：同一任务可能先后发起多次传输，
// 用 requestId 才能让取消与释放精确命中某一代。
  const transfers = new Map<string, Transfer>();
  let disposed = false;
// [资源] 唯一释放路径：删除条目、清定时器、中断信号并立即丢弃字节引用，
// 让 Buffer 尽快可回收；所有失败分支都必须经由这里收口。
  const release = (id: string, expected?: Transfer) => {
    const entry = transfers.get(id);
    // 取消后同 ID 可重新开始；旧读取的迟到异常不能删除新的传输。
// expected 是代际校验：同 ID 被重新 begin 后，旧读取的迟到回调不得删除新条目。
    if (!entry || (expected && entry !== expected)) return;
    transfers.delete(id);
    clearTimeout(entry.timer);
    entry.controller.abort(new Error("Topic resource transfer closed"));
    entry.data = undefined;
  };
// 统一入口校验：schema 先归一化入参，再要求任务归属一致；
// 归属不符按不可用处理，不向调用方泄露「存在但属于别人」。
  const lookup = (value: unknown) => {
    const key = zcodeTopicResourceRelayKeySchema.parse(value);
    const entry = transfers.get(key.requestId);
// [失败路径] 连接已销毁、条目已被释放、或 taskId 不匹配，三者都归为同一个错误，
// 避免调用方据此探测其他任务的传输。
    if (disposed || !entry || entry.request.taskId !== key.taskId)
      throw new Error("Topic resource transfer unavailable");
    entry.controller.signal.throwIfAborted();
    return entry;
  };
  return {
// begin 负责一次完整读取：限流 → 落盘读取 → base64 往返校验 → 计算元数据。
// 任一步失败都会立刻释放条目，不留下半成品。
    async begin(value: unknown) {
// [并发] 同连接最多两条并发传输，且同一 requestId 不允许重复 begin：
// 后者通常意味着调用方重试没带新 id 或状态机错乱，直接拒绝比猜测更安全。
      const request = zcodeTopicResourceRelayRequestSchema.parse(value);
      if (disposed) throw new Error("Topic resource connection closed");
// 上限是 2 而不是 1：允许在大附件传输时插入一条小的元数据回执类传输，
// 但又不给连接侧留出无限堆积缓存的空间。
      if (transfers.has(request.requestId))
        throw new Error("Topic resource request already active");
      if (transfers.size >= 2) throw new Error("Topic resource transfer busy");
      const controller = new AbortController();
      const entry: Transfer = {
        request,
        controller,
        timer: setTimeout(() => release(request.requestId), 120_000),
      };
      transfers.set(request.requestId, entry);
      try {
        await deps.validate(request, controller.signal);
        controller.signal.throwIfAborted();
        const attachment = await deps.read(request, controller.signal);
        controller.signal.throwIfAborted();
// 先按 base64 长度做上界预检，避免为大文件先分配 Buffer 才发现超限。
        const encoded = attachment.dataBase64;
        if (
          encoded === undefined ||
          encoded.length > Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / 3) * 4
        )
          throw new Error("Topic resource exceeds transfer limit");
        const data = Buffer.from(encoded, "base64");
// [失败路径] 往返比对拒绝非规范 base64（含非法填充）；只信任解码后可逆的字节，
// 否则后续分片与 checksum 会建立在被静默篡改的数据上。
        if (data.toString("base64") !== encoded) throw new Error("Invalid topic resource encoding");
// [事务] 元数据在字节就绪后才生成：totalChunks 与 checksum 都基于真实长度，
// 远端据此校验每个分片，避免把截断文件当成完整附件。
        const metadata = zcodeTopicResourceRelayMetadataSchema.parse({
          fileName: attachment.filename,
          mime: attachment.mimeType,
          bytes: data.length,
          totalChunks: Math.ceil(data.length / TOPIC_RESOURCE_RELAY_CHUNK_BYTES),
          checksum: `sha256:${createHash("sha256").update(data).digest("hex")}`,
        });
        await deps.validate(request, controller.signal);
        controller.signal.throwIfAborted();
// 只有全部校验通过才挂载字节；挂载前的中断不会让远端看到可读的分片。
        entry.data = data;
        return metadata;
      } catch (error) {
        release(request.requestId, entry);
        throw error;
      }
    },
// chunk 是只读取片：每次仍重新 validate，防止长传输期间权限被撤销后继续外泄。
// 任何异常都立即释放整条传输，避免远端在错误状态下反复重试。
    async chunk(value: unknown) {
      const { index, ...key } = zcodeTopicResourceRelayChunkRequestSchema.parse(value);
      const entry = lookup(key);
      try {
        await deps.validate(entry.request, entry.controller.signal);
        entry.controller.signal.throwIfAborted();
        const data = entry.data;
// [失败路径] 未就绪或越界索引都视为不可用：不返回空片，
// 让远端明确失败而不是把空数据拼进附件。
        if (!data || index >= Math.ceil(data.length / TOPIC_RESOURCE_RELAY_CHUNK_BYTES))
          throw new Error("Topic resource chunk unavailable");
        return {
          dataBase64: data
            .subarray(
              index * TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
              (index + 1) * TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
            )
            .toString("base64"),
        };
      } catch (error) {
        release(key.requestId, entry);
        throw error;
      }
    },
// finish 是终态确认：只在数据就绪且归属仍有效时返回 completed，
// 无论成功与否都在 finally 中释放，保证连接侧不会残留条目。
    async finish(value: unknown) {
      const entry = lookup(value);
      try {
        if (!entry.data) throw new Error("Topic resource is not ready");
        await deps.validate(entry.request, entry.controller.signal);
        entry.controller.signal.throwIfAborted();
        return { completed: true as const };
      } finally {
        release(entry.request.requestId, entry);
      }
    },
// cancel 是幂等的：不存在或归属不符返回 false，不抛错，
// 便于调用方在清理路径上无条件调用。
    cancel(value: unknown) {
      const key = zcodeTopicResourceRelayKeySchema.parse(value);
      if (transfers.get(key.requestId)?.request.taskId !== key.taskId) return false;
      release(key.requestId);
      return true;
    },
// [资源] 销毁先置位再逐条释放：disposed 让 lookup/begin 立刻失败，
// 后续迟到的 read 回调无法再创建新条目。
    dispose() {
      disposed = true;
      for (const key of transfers.keys()) release(key);
    },
  };
}
