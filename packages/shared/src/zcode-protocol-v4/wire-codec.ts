// INV-01 三层取大：守住位置 maxBytes；改错故障：只测逻辑 JSON，中继侧超限被拒。
// INV-02 换行计入：守住位置 CLI NDJSON 计量；改错故障：末行换行被漏算，边界超一字节。
// INV-03 最坏头部：守住位置 事件标识长度；改错故障：大标识走入对象序列化后头部被低估。
// INV-04 固定帧头：守住位置 socket 字节；改错故障：通道负载恰好贴线时被拒。
// INV-05 base64 膨胀：守住位置 中继字节；改错故障：中继把二进制再编码后超限。
// INV-06 两层独立：守住位置 组装上限与物理上限；改错故障：用物理预算放行超长逻辑帧。
// INV-07 上限夹紧：守住位置 hardBound；改错故障：调用方传大值绕过协议上限。
// INV-08 非法拒绝：守住位置 非有限与非正值判断；改错故障：负数上限被当成无限预算。
// INV-09 组装早拒：守住位置 逻辑字节判断；改错故障：超长帧先切分再失败，浪费 CPU。
// INV-10 单片优先：守住位置 完整帧测量；改错故障：放得下的帧也被强行分片。
// INV-11 最坏索引：守住位置 二分候选构造；改错故障：估算偏小，实际分片超限。
// INV-12 二分有界：守住位置 上下界；改错故障：分片预算为零时死循环。
// INV-13 零预算报错：守住位置 分片字节判断；改错故障：用零字节循环切片，永远无法完成。
// INV-14 片数封顶：守住位置 分片数检查；改错故障：超大帧生成成千上万片。
// INV-15 失败即抛：守住位置 分片后复测；改错故障：估算漂移导致超限帧被静默下发。
// INV-16 语义不变：守住位置 seq 与 apply 相关字段；改错故障：分片后序号或提交语义改变。
// INV-17 校验覆盖全文：守住位置 校验和计算；改错故障：只校验单片，重组后错误无法发现。
// INV-18 版本一致：守住位置 wireVersion；改错故障：新帧被旧端按旧格式解析。
//
// 模块职责：V4 topic 帧的物理承载计量、分片与编码。
// 状态所有权：无状态；全部结果由入参与调用方提供的测量函数决定。
// 阅读顺序：长度工具 → 三层计量 → 上限守卫 → 分片预算 → 编码主流程。
// V4 physical wire encoder：按调用方真实 JSON/RPC envelope 计量，logical frame
// 超过物理上限时只在 UTF-8 bytes 层分片，不改变 seq/apply 语义。
import { PROTOCOL_V4_LIMITS, V4_WIRE_PROTOCOL_VERSION } from "./core.js";
import { crc32WireBytes, encodeWireBytesBase64 } from "./wire-binary.js";
import type {
  TopicFrameDeliveryKind,
  TopicWireChecksum,
  TopicWireFrame,
  TopicWireFrameCandidate,
} from "./wire.js";

const CHANNEL_EVENT_RESPONSE_TYPE = 204;
const SOCKET_PROTOCOL_HEADER_BYTES = 13;

// 变长整型按每七位一字节累计。
// 负数先经无符号右移，按十字节上限处理。
//
function vqlByteLength(value: number): number {
  let bytes = 1;
  for (let remaining = value >>> 7; remaining > 0; remaining >>>= 7) bytes += 1;
  return bytes;
}

/**
 * 按当前生产三层真实承载计量 topic notification。mobile relay
 * 会把 Channel binary 再 base64，不能只测 CLI 的 logical JSON。
 */
// measureTopicNotificationEnvelopeBytes 分别算 cliNdjsonBytes / channelSocketBytes / mobileRelayBytes，取 maxBytes 作保守上限。
// CLI 走 NDJSON，一行一个 envelope，末尾换行也计入。
// Channel 走二进制，外层再套 socket 帧头。
// 手机中继把二进制再 base64，体积按四分之三膨胀估算。
// 固定头部按最坏标识长度计算，宁可高估不可低估。
//
export function measureTopicNotificationEnvelopeBytes(wire: TopicWireFrameCandidate): {
  cliNdjsonBytes: number;
  channelSocketBytes: number;
  mobileRelayBytes: number;
  maxBytes: number;
} {
  const cliNdjsonBytes =
    utf8JsonByteLength({
      method: "v4/conversation/frame",
      params: wire,
    }) + 1;

  // 事件标识超过三十一位后序列化会走对象形态。
  // 按最大安全整数的 JSON 长度计算最坏头部。
  // 负载头由标签、长度与类型码依次拼出。
  // socket 协议在通道负载外再加固定十三字节帧头。
  // 中继固定字段沿用最坏序列与恢复标识。
  //
  const wireJsonBytes = utf8JsonByteLength(wire);
  // @zcode/rpc serialization：Array tag+length+[EventFire,id]，再加 Object tag+length+JSON。
  // ChannelClient 的 id 无 31-bit wrap；超过 signed int 后 serialize 会走 Object JSON
  // fallback。因此按 Number.MAX_SAFE_INTEGER 的 16-byte JSON 形态计算最坏 header。
  const maxEventIdJsonBytes = String(Number.MAX_SAFE_INTEGER).length;
  const maxEventIdSerializedBytes = 1 + vqlByteLength(maxEventIdJsonBytes) + maxEventIdJsonBytes;
  const channelHeaderBytes =
    1 +
    vqlByteLength(2) +
    1 +
    vqlByteLength(CHANNEL_EVENT_RESPONSE_TYPE) +
    maxEventIdSerializedBytes;
  const channelPayloadBytes = channelHeaderBytes + 1 + vqlByteLength(wireJsonBytes) + wireJsonBytes;
  // SocketProtocol/PersistentProtocol 在 Channel payload 外再加固定 13-byte frame header。
  const channelSocketBytes = channelPayloadBytes + SOCKET_PROTOCOL_HEADER_BYTES;
  // topic encoder 继续用 legacy 单片 outer 作为保守 logical budget；production 已不发送该形态，
  // Channel payload 会再经 acknowledged raw adapter 独立分片并按最终 JSON 精确计量。
  // 两层预算分别约束 topic logical frame 与 relay physical frame，不能互相替代。
  // base64 长度按向上取整的四分之三倍计算。
  // 空数据仍占零字节，不额外补齐。
  // 返回值四个字段全部为字节数，单位一致。
  // 两层预算分别约束逻辑帧与中继物理帧，不能互相替代。
  //
  const dataBase64Bytes = 4 * Math.ceil(channelPayloadBytes / 3);
  const transportId = "x".repeat(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars);
  const mobileRelayFixedBytes = utf8JsonByteLength({
    type: "data",
    payload: {
      zcode_type: "rpc-frame",
      bridgeSessionId: transportId,
      bridgeGeneration: Number.MAX_SAFE_INTEGER,
      recoveryId: transportId,
      seq: Number.MAX_SAFE_INTEGER,
      dataBase64: "",
    },
    client_ts: Number.MAX_SAFE_INTEGER,
    server_ts: Number.MAX_SAFE_INTEGER,
  });
  const mobileRelayBytes = mobileRelayFixedBytes + dataBase64Bytes;
  return {
    cliNdjsonBytes,
    channelSocketBytes,
    mobileRelayBytes,
    maxBytes: Math.max(cliNdjsonBytes, channelSocketBytes, mobileRelayBytes),
  };
}

export function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export class TopicWireFrameEncodingError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "TopicWireFrameEncodingError";
  }
}

// hardBound 的 value 缺省时回落 maximum，即调用方不传就用协议上限。
// !Number.isFinite 或 <=0 时直接抛 TopicWireFrameEncodingError，不做静默修正。
// 返回值 Math.min(Math.floor(resolved), maximum)，向下取整并夹到上限。
//
function hardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TopicWireFrameEncodingError(`proto.invalidLimit.${name}`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

export interface EncodeTopicWireFramesOptions<F> {
  deliveryKind: TopicFrameDeliveryKind;
  topic: string;
  subscriptionId: string;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  maxPhysicalFrameBytes?: number;
  maxAssemblyBytes?: number;
  measurePhysicalFrameBytes(wire: TopicWireFrame<F>): number;
}

function makeFragment<F>(params: {
  options: EncodeTopicWireFramesOptions<F>;
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: TopicWireChecksum;
  dataBase64: string;
}): TopicWireFrame<F> {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "fragment",
    deliveryKind: params.options.deliveryKind,
    logicalFrameId: params.options.logicalFrameId,
    logicalFrameOrdinal: params.options.logicalFrameOrdinal,
    topic: params.options.topic,
    subscriptionId: params.options.subscriptionId,
    fragmentIndex: params.fragmentIndex,
    fragmentCount: params.fragmentCount,
    logicalBytes: params.logicalBytes,
    checksum: params.checksum,
    dataBase64: params.dataBase64,
  };
}

// findFragmentByteBudget 在 logicalBytes 与 maxPhysicalFrameBytes 之间二分最大分片。
// 候选帧按最坏分片序号与总片数构造，因此二分结果只会偏大。
// 二分不可行时返回 0，由调用方转成 TopicWireFrameEncodingError。
//
function findFragmentByteBudget<F>(params: {
  options: EncodeTopicWireFramesOptions<F>;
  logicalBytes: number;
  checksum: TopicWireChecksum;
  maxPhysicalFrameBytes: number;
}): number {
  let low = 1;
  let high = Math.min(params.logicalBytes, params.maxPhysicalFrameBytes);
  let best = 0;
  // 使用最坏索引位数测量，实际 fragment 的 envelope 只会更小。
  const worstCount = params.logicalBytes;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const dataBase64 = "A".repeat(4 * Math.ceil(candidate / 3));
    const wire = makeFragment({
      options: params.options,
      fragmentIndex: Math.max(0, worstCount - 1),
      fragmentCount: worstCount,
      logicalBytes: params.logicalBytes,
      checksum: params.checksum,
      dataBase64,
    });
    if (params.options.measurePhysicalFrameBytes(wire) <= params.maxPhysicalFrameBytes) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return best;
}

export function encodeTopicWireFrames<F>(
  frame: F,
  options: EncodeTopicWireFramesOptions<F>,
): TopicWireFrame<F>[] {
  const maxPhysicalFrameBytes = hardBound(
    options.maxPhysicalFrameBytes,
    PROTOCOL_V4_LIMITS.maxFrameBytes,
    "maxPhysicalFrameBytes",
  );
  const maxAssemblyBytes = hardBound(
    options.maxAssemblyBytes,
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    "maxAssemblyBytes",
  );
  const logical = encodeJson(frame);
  if (logical.byteLength > maxAssemblyBytes) {
    throw new TopicWireFrameEncodingError("proto.frameAssemblyTooLarge");
  }

  const complete: TopicWireFrame<F> = {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: options.deliveryKind,
    logicalFrameId: options.logicalFrameId,
    logicalFrameOrdinal: options.logicalFrameOrdinal,
    topic: options.topic,
    subscriptionId: options.subscriptionId,
    frame,
  };
  if (options.measurePhysicalFrameBytes(complete) <= maxPhysicalFrameBytes) {
    return [complete];
  }

  const checksum: TopicWireChecksum = {
    algorithm: "crc32",
    value: crc32WireBytes(logical),
  };
  const chunkBytes = findFragmentByteBudget({
    options,
    logicalBytes: logical.byteLength,
    checksum,
    maxPhysicalFrameBytes,
  });
  if (chunkBytes < 1) {
    throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
  }
  const fragmentCount = Math.ceil(logical.byteLength / chunkBytes);
  if (fragmentCount > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments) {
    throw new TopicWireFrameEncodingError("proto.frameFragmentCountExceeded");
  }

  const frames: TopicWireFrame<F>[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * chunkBytes;
    const end = Math.min(start + chunkBytes, logical.byteLength);
    const wire = makeFragment({
      options,
      fragmentIndex,
      fragmentCount,
      logicalBytes: logical.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(logical.subarray(start, end)),
    });
    if (options.measurePhysicalFrameBytes(wire) > maxPhysicalFrameBytes) {
      // physical 上限包含调用方真实 envelope；任何估算漂移都必须
      // fail closed，不能把超限 frame 交给下游再静默截断。
      throw new TopicWireFrameEncodingError("proto.frameEnvelopeTooLarge");
    }
    frames.push(wire);
  }
  return frames;
}
