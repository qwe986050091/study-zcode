// 职责边界：本文件只实现远控 RPC 传输层的物理切片与重组——schema 校验、精确字节计量、
// canonical base64 编解码、单 assembly 状态机；不负责 relay 鉴权、重连、业务消息语义，
// 也不持有任何 I/O 句柄（D3 接线方负责把 terminal fault 映射为 bridge degraded）。
//
// 不变量（INV）表：
// | 编号 | 断言 | 守住它的位置 | 改错后的故障 |
// | INV-01 | 物理 seq 严格 +1 连续 | expectedPhysicalSeq 的比较分支 | 乱序分片被静默拼接成错误消息 |
// | INV-02 | 同一 messageSeq 的片间 fragmentCount/messageBytes/checksum 一致 | metadataMismatch、checksumMismatch 分支 | 异消息分片混入，长度与校验失真 |
// | INV-03 | 完成消息只保留 digest tombstone | frameFingerprint 与 settledFrameFingerprintsBySeq | 内存随消息数线性增长直至 OOM |
// | INV-04 | terminal fault 后不再推进状态 | this.terminalReason 短路 | 半损坏连接继续消费字节 |
// | INV-05 | foreign identity 先于事务检查拒绝 | hasRawIdentityMismatch 首闸 | 外片清空 owning assembly |
// | INV-06 | 单帧 UTF-8 字节数不超过 maxPhysicalFrameBytes | measureWebRemoteControlRpcRelayEnvelopeBytes | 对端按帧上限拒收 |
// | INV-07 | 每片预算随片数单调收敛 | findDecodedBudget 的二分 low/high | 选出放不下的分片，帧超限 |
// | INV-08 | 空消息不可编码 | bytes.byteLength === 0 分支 | 生成 fragmentCount 为 0 的非法帧 |
// | INV-09 | 分片数不超过 maxFragments | required > maxFragments 分支 | 分片风暴放大 CPU 与内存 |
// | INV-10 | 重组字节数等于 messageBytes | stagedBytes 累计与 lengthMismatch | 静默截断或填充消息 |
// | INV-11 | 重组 crc32 等于分片携带值 | 完成时 crc32WireBytes 比较 | 已损坏消息被交付上层 |
// | INV-12 | messageSeq 逐条递增不跳号 | expectedMessageSeq 与 messageGap 分支 | 丢消息被当作新消息处理 |
// | INV-13 | 到达 MAX_SAFE_INTEGER 只能换 generation | physicalSequenceExhausted/messageSequenceExhausted | seq 回绕后重复投递 |
// | INV-14 | assembly 超时基于 firstSeenAt | expire 与 nextExpiryAt | 半成品永久占用内存 |
// | INV-15 | 上限只能调小不能放大 | boundedPositive 的夹取 | 调用方绕过协议上限 |
// | INV-16 | 所有 envelope schema 均为 strict | 各 z.object().strict() | 额外字段静默透传到业务层 |
// | INV-17 | 输出帧全部冻结 | encode 末尾的 Object.freeze | 下游改写已计入校验和的内容 |
// | INV-18 | 编码函数无 I/O、无重试、无全局状态 | encodeWebRemoteControlRpcTransportMessage | 纯函数产生重复物理 seq
/* eslint-disable max-lines -- raw RPC 的 schema、精确计量、编码与单 assembly 状态机共享同一组物理不变量。 */
import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "./zcode-protocol-v4/core.js";
import {
  crc32WireBytes,
  decodeWireBase64,
  encodeWireBytesBase64,
} from "./zcode-protocol-v4/wire-binary.js";

// [契约] 这组数值是与 relay 和对端共同发布的线上约定，改动等同协议破坏。
// 调用方只能通过 options 调小，放大一律被 boundedPositive 夹回。
// 改错故障：对端按旧上限分片，本端判 envelopeTooLarge 并 terminal 断链。
export const WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS = {
  maxPhysicalFrameBytes: PROTOCOL_V4_LIMITS.maxFrameBytes,
  maxMessageBytes: 16 * 1024 * 1024,
  maxFragments: 64,
  assemblyTimeoutMs: 30_000,
  transportIdMaxChars: PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars,
} as const;

// [契约] seq 类字段必须是安全整数，避免 JSON number 在 2^53 之后丢精度。
// positive/nonnegative 与 max 一起收紧边界，不要改成 z.coerce 接受字符串。
// 改错故障：放宽成 coerce 会让 "1" 这类字符串静默进入线上帧，破坏格式唯一性。
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// [契约] 传输 ID 只允许 URL-safe 字符集，因为它会进入 relay 的 JSON 与日志行。
// 长度上限取自 transportEnvelopeIdMaxChars，不要在此写死数字。
// 改错故障：放宽成任意 string 会让含控制字符的 ID 污染日志与端侧匹配。
export const webRemoteControlRpcTransportIdSchema = z
  .string()
  .min(1)
  .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.transportIdMaxChars)
  .regex(/^[A-Za-z0-9._~-]+$/u);

// [契约] 身份三元组整体比较，bridgeGeneration/recoveryId 缺席与 undefined 等价。
// .strict() 是关键：多余的 identity 字段会让两端对同一条连接理解不同。
// 改错故障：只比 bridgeSessionId 时，旧 generation 的帧会被误认作当前连接。
export const webRemoteControlRpcTransportIdentitySchema = z
  .object({
    bridgeSessionId: webRemoteControlRpcTransportIdSchema,
    bridgeGeneration: nonnegativeSafeIntegerSchema.optional(),
    recoveryId: webRemoteControlRpcTransportIdSchema.optional(),
  })
  .strict();
export type WebRemoteControlRpcTransportIdentity = z.infer<
  typeof webRemoteControlRpcTransportIdentitySchema
>;

// [契约] algorithm 固定 crc32，value 是 8 位小写十六进制，不做大小写归一。
// 校验和只用于检测传输损坏，不承担鉴权，不能拿它替代签名。
// 改错故障：允许大写会让正常帧在 accept 侧被判 checksumMismatch。
export const webRemoteControlRpcTransportChecksumSchema = z
  .object({
    algorithm: z.literal("crc32"),
    value: z.string().regex(/^[0-9a-f]{8}$/u),
  })
  .strict();
export type WebRemoteControlRpcTransportChecksum = z.infer<
  typeof webRemoteControlRpcTransportChecksumSchema
>;

// [失败路径] 先用长度挡在 maxPhysicalFrameBytes 内再 decode，避免超长串先分配缓冲。
// 回编码必须与原文逐字符相等，才能排除多余填充与 URL-safe 变体。
// 改错故障：只 decode 不回编码，等价帧有多种字节形态，tombstone 去重失效。
function isCanonicalBase64(value: string): boolean {
  // Zod 的后续 refine 不保证在 max issue 后短路；先按 raw string 做硬闸，避免先分配 decoded buffer。
  if (
    value.length < 4 ||
    value.length > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
  ) {
    return false;
  }
  const decoded = decodeWireBase64(value);
  return decoded !== null && decoded.byteLength > 0 && encodeWireBytesBase64(decoded) === value;
}

// [契约] fragmentIndex 从 0 起、fragmentCount 至少 1，二者关系交给 superRefine。
// messageBytes 是整条消息的原始字节数，不是本片字节数，每片都重复携带。
// 字段顺序影响 JSON 文本字节数，进而影响精确计量，不要重排。
export const webRemoteControlRpcTransportFrameSchema = z
  .object({
    zcode_type: z.literal("rpc-frame"),
    bridgeSessionId: webRemoteControlRpcTransportIdSchema,
    bridgeGeneration: nonnegativeSafeIntegerSchema.optional(),
    recoveryId: webRemoteControlRpcTransportIdSchema.optional(),
    seq: positiveSafeIntegerSchema,
    messageSeq: positiveSafeIntegerSchema,
    fragmentIndex: z
      .number()
      .int()
      .nonnegative()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments - 1),
    fragmentCount: z
      .number()
      .int()
      .positive()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments),
    messageBytes: z
      .number()
      .int()
      .positive()
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes),
    checksum: webRemoteControlRpcTransportChecksumSchema,
    // 先做字符串长度硬闸，再进入 decode/refine，避免恶意超长 base64 先分配 decoded buffer。
    dataBase64: z
      .string()
      .min(4)
      .max(WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes)
      .refine(isCanonicalBase64),
  })
  .strict()
  // [契约] 跨字段约束只能放 superRefine，单字段 refine 看不到 fragmentCount。
  // issue 的 path 必须指向具体字段，便于上位层把 reasonCode 映射到提示。
  // 改错故障：缺这条约束时 0 分片或索引越界会一路走到 assembler。
  .superRefine((value, context) => {
    if (value.fragmentIndex >= value.fragmentCount) {
      context.addIssue({
        code: "custom",
        path: ["fragmentIndex"],
        message: "fragmentIndex must be smaller than fragmentCount",
      });
    }
    if (value.fragmentCount > value.messageBytes) {
      context.addIssue({
        code: "custom",
        path: ["fragmentCount"],
        message: "non-empty fragments cannot exceed message bytes",
      });
    }
  });
export type WebRemoteControlRpcTransportFramePayload = z.infer<
  typeof webRemoteControlRpcTransportFrameSchema
>;

// [契约] ack 只带 ackMessageSeq，没有分片概念，绝不能复用 frame 的字段。
// 语义是「已完整收到到该 messageSeq 为止」，不是「收到某个物理帧」。
// 改错故障：回带 seq 会让重传窗口语义与 tombstone 表对不上。
export const webRemoteControlRpcTransportAckSchema = z
  .object({
    zcode_type: z.literal("rpc-frame-ack"),
    bridgeSessionId: webRemoteControlRpcTransportIdSchema,
    bridgeGeneration: nonnegativeSafeIntegerSchema.optional(),
    recoveryId: webRemoteControlRpcTransportIdSchema.optional(),
    ackMessageSeq: positiveSafeIntegerSchema,
  })
  .strict();
export type WebRemoteControlRpcTransportAckPayload = z.infer<
  typeof webRemoteControlRpcTransportAckSchema
>;

// [契约] union 顺序先 frame 后 ack；两者 zcode_type 是字面量，正常数据不会歧义。
// 不要再外包一层 object，会破坏各分支 .strict() 的额外字段检测。
// 改错故障：顺序颠倒时非法 frame 可能被 ack 分支的字段集接受。
export const webRemoteControlRpcTransportPayloadSchema = z.union([
  webRemoteControlRpcTransportFrameSchema,
  webRemoteControlRpcTransportAckSchema,
]);
export type WebRemoteControlRpcTransportPayload = z.infer<
  typeof webRemoteControlRpcTransportPayloadSchema
>;

// [契约] client_ts/server_ts 是可选单调时间戳，只在 relay 侧补齐。
// 本层不校验时间戳单调性：跨端时钟不可信，校验会把正常重连判成非法。
// 改错故障：把 timestamp 设为 required 会让旧 relay 的 envelope 全部 invalid。
export const webRemoteControlRpcRelayEnvelopeSchema = z
  .object({
    type: z.literal("data"),
    payload: webRemoteControlRpcTransportPayloadSchema,
    client_ts: nonnegativeSafeIntegerSchema.optional(),
    server_ts: nonnegativeSafeIntegerSchema.optional(),
  })
  .strict();
export type WebRemoteControlRpcRelayEnvelope = z.infer<
  typeof webRemoteControlRpcRelayEnvelopeSchema
>;

// [契约] terminal=true 表示该方向不可继续，调用方必须重建 bridge generation。
// terminal=false 只用于 foreign identity 这类与本连接无关的帧，可以继续收。
// 改错故障：把 identityMismatch 标成 terminal 会让一条外片打断正常连接。
export interface WebRemoteControlRpcTransportFault {
  reasonCode: string;
  terminal: boolean;
  seq?: number;
  messageSeq?: number;
  expectedSeq?: number;
  expectedMessageSeq?: number;
}

// [契约] 结果只有 accepted/fault 两态，bytes 只在 accepted 时存在。
// JSON 边界解析没有可恢复的中间状态，因此 fault 一律 terminal。
// 改错故障：新增第三种 kind 会迫使所有调用点改 switch，且容易漏分支。
export type ParseWebRemoteControlRpcRelayEnvelopeResult =
  | {
      kind: "accepted";
      bytes: number;
      envelope: WebRemoteControlRpcRelayEnvelope;
    }
  | { kind: "fault"; fault: WebRemoteControlRpcTransportFault };

// [权衡] 每次新建 TextEncoder 有少量开销，换来无共享状态与可重入。
// 必须按 UTF-8 而不是 value.length，否则多字节内容会让字节上限算少。
// 改错故障：用 length 计量时，中文 ID 能绕过 maxPhysicalFrameBytes。
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// [契约] 缺省时间戳取 MAX_SAFE_INTEGER，代表最坏位数上界，用于保守计量。
// null 表示该字段不出现，undefined 表示「用最坏值」，两者必须区分。
// 改错故障：把 null 与 undefined 合并会让计量偏小，实际帧超限。
function relayEnvelopeFor(
  payload: WebRemoteControlRpcTransportPayload,
  timestamps: { clientTimestamp?: number | null; serverTimestamp?: number | null } = {},
): WebRemoteControlRpcRelayEnvelope {
  const clientTimestamp =
    timestamps.clientTimestamp === undefined ? Number.MAX_SAFE_INTEGER : timestamps.clientTimestamp;
  const serverTimestamp =
    timestamps.serverTimestamp === undefined ? Number.MAX_SAFE_INTEGER : timestamps.serverTimestamp;
  return {
    type: "data",
    payload,
    ...(clientTimestamp === null ? {} : { client_ts: clientTimestamp }),
    ...(serverTimestamp === null ? {} : { server_ts: serverTimestamp }),
  };
}

/** 最终 relay JSON（默认同时含最坏 client/server timestamp）的精确 UTF-8 byte 数。 */
// [契约] 这是唯一计量入口，encode 与 accept 必须调同一函数，否则两侧上限不一致。
// 计量对象是最终 JSON 文本，键名、引号、转义都占字节，不能对字段求和。
// 改错故障：手写求和会漏掉转义字符，导致预算偏小、逐帧自检抛 internalEnvelopeError。
export function measureWebRemoteControlRpcRelayEnvelopeBytes(
  payload: WebRemoteControlRpcTransportPayload,
  timestamps?: { clientTimestamp?: number | null; serverTimestamp?: number | null },
): number {
  return utf8Bytes(JSON.stringify(relayEnvelopeFor(payload, timestamps)));
}

// [权衡] 未传值取上限；传非法值抛错；传过大值夹到上限而不是报错。
// [契约] boundedPositive 对过大值夹到上限：兼容历史调用方传极大数，不改变协议语义。
// 改错故障：改成「超限即抛」会让既有调用点在启动期直接崩，而非降级。
function boundedPositive(value: number | undefined, maximum: number, reasonCode: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new WebRemoteControlRpcTransportEncodingError(reasonCode);
  }
  return Math.min(resolved, maximum);
}

// [契约] 返回 null 而不是抛错，调用方用 null 表示「不是本层负载」。
// 不做长度与身份判断，那些依赖连接上下文，属于 assembler 的职责。
// 改错故障：在这里返回 fault 会让纯解析函数依赖连接状态，无法复用与单测。
export function parseWebRemoteControlRpcTransportPayload(
  value: unknown,
): WebRemoteControlRpcTransportPayload | null {
  const result = webRemoteControlRpcTransportPayloadSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** D3 接线时在 JSON.parse 前调用；本切片只提供 standalone primitive。 */
// [契约] 必须在 JSON.parse 之前做字节闸门，否则超大串会先被解析成对象。
// 函数不抛异常，所有失败以 terminal fault 返回，便于 D3 统一映射。
// 改错故障：先 parse 再量长度会让 16MB 上限彻底失去防护意义。
export function parseWebRemoteControlRpcRelayEnvelopeJson(
  rawJson: string,
  options: { maxPhysicalFrameBytes?: number } = {},
): ParseWebRemoteControlRpcRelayEnvelopeResult {
  // [失败路径] 单独 try 包住上限解析，是为了让配置错误与内容错误共用同一 fault 出口。
  // catch 里再判 error 类型，避免把非本类异常吞成 invalidPhysicalLimit。
  // 改错故障：去掉 try 会让非法配置以异常穿透到 relay 的读循环。
  let maxPhysicalFrameBytes: number;
  try {
    maxPhysicalFrameBytes = boundedPositive(
      options.maxPhysicalFrameBytes,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      "remote.rpcFrame.invalidPhysicalLimit",
    );
  } catch (error) {
    return {
      kind: "fault",
      fault: {
        reasonCode:
          error instanceof WebRemoteControlRpcTransportEncodingError
            ? error.reasonCode
            : "remote.rpcFrame.invalidPhysicalLimit",
        terminal: true,
      },
    };
  }
  // [资源] 计量在 parse 之前完成，超限立即返回，不保留 rawJson 的任何派生引用。
  // bytes 随 accepted 结果返回，供上层做窗口计量，不要在此重复计算。
  const bytes = utf8Bytes(rawJson);
  if (bytes > maxPhysicalFrameBytes) {
    return {
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.envelopeTooLarge", terminal: true },
    };
  }
  // [失败路径] 只接受 JSON 字面量；rawJson 来自不可信 relay，绝不能走 eval。
  // catch 不区分解析器细节，避免把内部信息通过 reasonCode 泄漏给对端。
  // 改错故障：把错误 message 拼进 reasonCode 会让它变成不稳定字符串，无法做告警聚合。
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      kind: "fault",
      fault: { reasonCode: "remote.rpcFrame.invalidJson", terminal: true },
    };
  }
  const envelope = webRemoteControlRpcRelayEnvelopeSchema.safeParse(parsed);
  return envelope.success
    ? { kind: "accepted", bytes, envelope: envelope.data }
    : {
        kind: "fault",
        fault: { reasonCode: "remote.rpcFrame.invalidEnvelope", terminal: true },
      };
}

// [契约] reasonCode 是稳定的机器可读码，UI 与告警都依赖它，不要拼接动态内容。
// name 显式赋值，保证跨包日志里能直接看到错误类别。
// 改错故障：改用 message 传原因会让上层只能做字符串匹配。
export class WebRemoteControlRpcTransportEncodingError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = "WebRemoteControlRpcTransportEncodingError";
  }
}

// [契约] firstPhysicalSeq 由调用方给定，编码器不自己生成 seq，保证与发送队列一致。
// 三个上限都是可选的，实际值一律经 boundedPositive 收敛到契约常量。
// 改错故障：在这里自增全局 seq 会让重发获得新 seq，对端 tombstone 去重失效。
export interface EncodeWebRemoteControlRpcTransportMessageOptions extends WebRemoteControlRpcTransportIdentity {
  firstPhysicalSeq: number;
  messageSeq: number;
  maxPhysicalFrameBytes?: number;
  maxMessageBytes?: number;
  maxFragments?: number;
}

// [契约] 重建对象并逐字段展开，只为丢掉值为 undefined 的键以满足 .strict()。
// 直接 spread 原对象会把 undefined 键带进 strict 校验，被判为多余字段。
// 改错故障：省掉这层会让带 bridgeGeneration: undefined 的合法调用被拒。
function identityFrom(
  value: WebRemoteControlRpcTransportIdentity,
): WebRemoteControlRpcTransportIdentity {
  const parsed = webRemoteControlRpcTransportIdentitySchema.safeParse({
    bridgeSessionId: value.bridgeSessionId,
    ...(value.bridgeGeneration === undefined ? {} : { bridgeGeneration: value.bridgeGeneration }),
    ...(value.recoveryId === undefined ? {} : { recoveryId: value.recoveryId }),
  });
  if (!parsed.success) {
    throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.invalidIdentity");
  }
  return parsed.data;
}

// [契约] 只做安全正整数断言，不做范围夹取；seq 溢出必须显式失败。
// 与 boundedPositive 的分工：seq 类不接受夹取，上限类接受夹取。
// 改错故障：对 seq 夹取会让两条消息共享同一物理序号。
function assertPositiveSafe(value: number, reasonCode: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebRemoteControlRpcTransportEncodingError(reasonCode);
  }
}

// [契约] 4 * ceil(n/3) 是含填充的 base64 字符数，用于预算而不是实际编码。
// 改错故障：低估长度会让 findDecodedBudget 选出放不下的分片。
function base64Length(decodedBytes: number): number {
  return 4 * Math.ceil(decodedBytes / 3);
}

// [契约] shell 只负责拼字段，不做校验；freeze 与计量由调用方负责。
// 字段顺序与 schema 声明顺序保持一致，便于肉眼比对线上 JSON。
// 改错故障：在 shell 里加默认值会让「空 dataBase64 探针」失去意义。
function frameShell(params: {
  identity: WebRemoteControlRpcTransportIdentity;
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: WebRemoteControlRpcTransportChecksum;
  dataBase64: string;
}): WebRemoteControlRpcTransportFramePayload {
  return {
    zcode_type: "rpc-frame",
    ...params.identity,
    seq: params.seq,
    messageSeq: params.messageSeq,
    fragmentIndex: params.fragmentIndex,
    fragmentCount: params.fragmentCount,
    messageBytes: params.messageBytes,
    checksum: params.checksum,
    dataBase64: params.dataBase64,
  };
}

// [权衡] 用二分而非闭式解，因为 envelope 字节数是 base64 长度的阶梯函数。
// 单调性依赖 fixedBytes 与 base64Length 都随 middle 单调不减。
// 改错故障：把 middle 取 floor 会让 high 无法收敛，出现死循环。
function findDecodedBudget(params: {
  identity: WebRemoteControlRpcTransportIdentity;
  endSeq: number;
  messageSeq: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: WebRemoteControlRpcTransportChecksum;
  maxPhysicalFrameBytes: number;
}): number {
  const empty = frameShell({
    identity: params.identity,
    seq: params.endSeq,
    messageSeq: params.messageSeq,
    fragmentIndex: params.fragmentCount - 1,
    fragmentCount: params.fragmentCount,
    messageBytes: params.messageBytes,
    checksum: params.checksum,
    // 这里只用于精确固定 envelope 计量；真正 payload 仍须非空 canonical base64。
    dataBase64: "",
  });
  // [契约] 空 dataBase64 的 shell 只用于测固定开销，绝不能真正发送。
  // 固定开销随 identity 与 seq 的位数变化，所以必须用真实 endSeq 构造。
  // 改错故障：用常量估算固定开销会在 seq 跨位数时低估 1~2 字节。
  const fixedBytes = measureWebRemoteControlRpcRelayEnvelopeBytes(empty);
  let low = 0;
  let high = params.messageBytes;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fixedBytes + base64Length(middle) <= params.maxPhysicalFrameBytes) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** raw Channel bytes -> immutable bounded physical payload batch。 */
// [契约] 纯函数：只读输入、返回冻结数组，不做 I/O、不重试、不写全局状态。
// 输出片数由内容与上限共同决定，调用方不能用「预期片数」反推预算。
// 改错故障：在这里重试或补帧会让同一条消息产生重复物理 seq。
export function encodeWebRemoteControlRpcTransportMessage(
  bytes: Uint8Array,
  options: EncodeWebRemoteControlRpcTransportMessageOptions,
): readonly WebRemoteControlRpcTransportFramePayload[] {
  // [契约] 身份先归一化一次，后续所有帧共用该结果，避免逐帧重复校验。
  // 归一化失败立即抛错，不进入分片循环，避免产生半批帧。
  // 改错故障：逐帧重新解析 identity 会让 64 片做 64 次 schema 校验。
  const identity = identityFrom(options);
  assertPositiveSafe(options.firstPhysicalSeq, "remote.rpcFrame.invalidPhysicalSeq");
  assertPositiveSafe(options.messageSeq, "remote.rpcFrame.invalidMessageSeq");
  const maxPhysicalFrameBytes = boundedPositive(
    options.maxPhysicalFrameBytes,
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
    "remote.rpcFrame.invalidPhysicalLimit",
  );
  const maxMessageBytes = boundedPositive(
    options.maxMessageBytes,
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes,
    "remote.rpcFrame.invalidMessageLimit",
  );
  const maxFragments = boundedPositive(
    options.maxFragments,
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments,
    "remote.rpcFrame.invalidFragmentLimit",
  );
  // [失败路径] 空消息没有合法表示：fragmentCount 至少 1 且 dataBase64 必须非空。
  // 允许空消息会生成 fragmentCount=0 或空 base64，两者都被 schema 拒绝。
  // 改错故障：改成发送空片会让对端在 decode 处判 invalidBase64 并断链。
  if (bytes.byteLength === 0) {
    throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.emptyMessage");
  }
  if (bytes.byteLength > maxMessageBytes) {
    throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.messageTooLarge");
  }
  // [契约] crc32 只算原始 bytes，不算 base64 文本；所有分片共享同一个值。
  // freeze 保证同一对象被多帧共享时不会被下游改写。
  // 改错故障：对 base64 文本算校验和会在编码变体上产生不同结果。
  const checksum = Object.freeze({
    algorithm: "crc32" as const,
    value: crc32WireBytes(bytes),
  });

  // [权衡] 用不动点迭代求片数：片数变多会抬高 seq 位数，从而压缩每片预算。
  // 循环必然收敛：required 随 fragmentCount 单调不减，且有 maxFragments 上界。
  // 改错故障：只算一次 required 会在跨位数时少分一片，末片超限。
  let fragmentCount = 1;
  let decodedBudget = 0;
  for (;;) {
    const endSeq = options.firstPhysicalSeq + fragmentCount - 1;
    if (!Number.isSafeInteger(endSeq) || endSeq > Number.MAX_SAFE_INTEGER) {
      throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.sequenceOverflow");
    }
    // [契约] 预算必须用 endSeq（最后一片的 seq）计算，那才是位数最坏的帧。
    // 用 firstPhysicalSeq 会低估后几片的 envelope 字节数。
    // 改错故障：低估后循环仍能通过，但逐帧自检会抛 internalEnvelopeError。
    decodedBudget = findDecodedBudget({
      identity,
      endSeq,
      messageSeq: options.messageSeq,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      maxPhysicalFrameBytes,
    });
    if (decodedBudget < 1) {
      throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.envelopeTooLarge");
    }
    const required = Math.ceil(bytes.byteLength / decodedBudget);
    if (required > maxFragments) {
      throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.fragmentLimitExceeded");
    }
    if (required <= fragmentCount) break;
    fragmentCount = required;
  }

  // [资源] 帧在循环内累积，任何一帧自检失败都整体抛出，不返回部分结果。
  // 分片用 subarray 视图切片，encodeWireBytesBase64 必须立即消费，不能留引用。
  // 改错故障：返回部分帧会让调用方发出半条消息，触发对端 physicalGap。
  const frames: WebRemoteControlRpcTransportFramePayload[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * decodedBudget;
    const end = Math.min(bytes.byteLength, start + decodedBudget);
    const payload = frameShell({
      identity,
      seq: options.firstPhysicalSeq + fragmentIndex,
      messageSeq: options.messageSeq,
      fragmentIndex,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(bytes.subarray(start, end)),
    });
    if (
      // [契约] 逐帧自检是最后一道闸：预算算错时在这里失败，而不是把坏帧发出去。
      // 同时跑一次 schema safeParse，保证 encode 产物一定能被 accept 侧解析。
      // 改错故障：删掉自检会让计量 bug 变成线上断链，且难以定位到编码侧。
      measureWebRemoteControlRpcRelayEnvelopeBytes(payload) > maxPhysicalFrameBytes ||
      !webRemoteControlRpcTransportFrameSchema.safeParse(payload).success
    ) {
      throw new WebRemoteControlRpcTransportEncodingError("remote.rpcFrame.internalEnvelopeError");
    }
    frames.push(Object.freeze(payload));
  }
  return Object.freeze(frames);
}

// [契约] ActiveAssembly 是「进行中」的唯一可变状态，完成后整对象丢弃。
// frameFingerprintsBySeq 在完成时会转成 tombstone 表，不要提前清空。
// 改错故障：把 fragments 存成 base64 字符串会让内存翻倍且 decode 重复。
interface ActiveAssembly {
  messageSeq: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: WebRemoteControlRpcTransportChecksum;
  firstSeenAt: number;
  stagedBytes: number;
  fragments: Uint8Array[];
  frameFingerprintsBySeq: Map<number, SettledFrameFingerprint>;
}

interface SettledFrameFingerprint {
  messageSeq: number;
  value: string;
}

// [契约] incomplete 不是错误，调用方应继续等待；duplicate 需要回 ack。
// ackMessageSeq 为 null 表示尚无已完成消息，此时不能回 ack 0。
// 改错故障：把 incomplete 当 fault 会让多片消息在第一片就断链。
export type WebRemoteControlRpcTransportAssemblyEvent =
  | { kind: "incomplete"; messageSeq: number; receivedFragments: number }
  | { kind: "duplicate"; ackMessageSeq: number | null }
  | { kind: "complete"; messageSeq: number; bytes: Uint8Array }
  | { kind: "fault"; fault: WebRemoteControlRpcTransportFault };

// [契约] now 可注入用于测试超时；生产默认 Date.now，不要换成 performance.now。
// initialPhysicalSeq/initialMessageSeq 用于重连续传，必须来自已确认的 ack。
// 改错故障：重连时归零 seq 会让新帧被对端当成旧重复而静默丢弃。
export interface WebRemoteControlRpcTransportAssemblerOptions {
  identity: WebRemoteControlRpcTransportIdentity;
  initialPhysicalSeq?: number;
  initialMessageSeq?: number;
  maxPhysicalFrameBytes?: number;
  maxMessageBytes?: number;
  maxFragments?: number;
  timeoutMs?: number;
  now?: () => number;
}

// [契约] 三个字段都用 === 比较（含 undefined），不做深比较也不忽略缺省。
// 这里比较已解析的 frame，与 hasRawIdentityMismatch 的原始对象路径不同。
function sameIdentity(
  expected: WebRemoteControlRpcTransportIdentity,
  frameValue: WebRemoteControlRpcTransportFramePayload,
): boolean {
  return (
    frameValue.bridgeSessionId === expected.bridgeSessionId &&
    frameValue.bridgeGeneration === expected.bridgeGeneration &&
    frameValue.recoveryId === expected.recoveryId
  );
}

// [契约] 只有 candidate 出现任一 identity 键时才判定，避免把非本层帧当 foreign。
// 该判断必须早于 timeout 与 terminal 检查，否则外片会触发本连接的 expire 副作用。
// 改错故障：改成全字段比较会把缺省键的正常帧判成 mismatch。
function hasRawIdentityMismatch(
  expected: WebRemoteControlRpcTransportIdentity,
  candidate: unknown,
): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  const identityKeys = ["bridgeSessionId", "bridgeGeneration", "recoveryId"] as const;
  if (!identityKeys.some((key) => key in value)) return false;
  return (
    value.bridgeSessionId !== expected.bridgeSessionId ||
    value.bridgeGeneration !== expected.bridgeGeneration ||
    value.recoveryId !== expected.recoveryId
  );
}

// [资源] tombstone 只保存 digest，不保存 decoded 或 base64，内存不随消息数增长。
// 数组元素顺序即指纹协议，改动顺序等于让重启前后的 tombstone 不可比。
// 改错故障：把 checksum 换成整段 bytes 会让单条消息的 tombstone 达到 MB 级。
function frameFingerprint(
  frameValue: WebRemoteControlRpcTransportFramePayload,
  decoded: Uint8Array,
): SettledFrameFingerprint {
  return {
    messageSeq: frameValue.messageSeq,
    // 完成后的 tombstone 只保留有界 metadata + fragment digest，不保留整段 base64。
    value: JSON.stringify([
      frameValue.bridgeSessionId,
      frameValue.bridgeGeneration ?? null,
      frameValue.recoveryId ?? null,
      frameValue.seq,
      frameValue.messageSeq,
      frameValue.fragmentIndex,
      frameValue.fragmentCount,
      frameValue.messageBytes,
      frameValue.checksum.algorithm,
      frameValue.checksum.value,
      decoded.byteLength,
      crc32WireBytes(decoded),
    ]),
  };
}

function sameFingerprint(left: SettledFrameFingerprint, right: SettledFrameFingerprint): boolean {
  return left.value === right.value;
}

/** 每方向一个实例；任何 terminal fault 后由 04D-2 映射为 bridge degraded。 */
// [并发] 每方向一个实例，实例内部无锁；跨方向共享会交错 expectedSeq。
// 一个实例同时只允许一个 active assembly，新 messageSeq 必须等旧的完成或失败。
// 改错故障：复用同一实例会让两条消息的分片互相判 metadataMismatch。
export class WebRemoteControlRpcTransportAssembler {
  // [契约] 构造期固定身份与上限，运行期不再读 options，避免半途换协议。
  // 上限一经确定即用于所有帧判断，不能让单帧携带的上限覆盖实例上限。
  // 改错故障：允许逐帧覆盖上限会让攻击者用小上限帧把连接判超时。
  private readonly identity: WebRemoteControlRpcTransportIdentity;
  private readonly maxPhysicalFrameBytes: number;
  private readonly maxMessageBytes: number;
  private readonly maxFragments: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private expectedPhysicalSeq: number;
  private expectedMessageSeq: number;
  private lastCompletedMessageSeq: number;
  private physicalSequenceExhausted = false;
  private messageSequenceExhausted = false;
  private settledFrameFingerprintsBySeq = new Map<number, SettledFrameFingerprint>();
  private active: ActiveAssembly | null = null;
  private terminalReason: string | null = null;

  // [契约] 构造即校验；非法配置抛错而不是降级默认值，避免静默放宽协议。
  // lastCompletedMessageSeq 初始为 expectedMessageSeq - 1，保证首个 ack 有定义。
  // 改错故障：初始值设 0 会让第一条消息前的 ackMessageSeq 变成 null。
  constructor(options: WebRemoteControlRpcTransportAssemblerOptions) {
    this.identity = identityFrom(options.identity);
    this.expectedPhysicalSeq = options.initialPhysicalSeq ?? 1;
    this.expectedMessageSeq = options.initialMessageSeq ?? 1;
    assertPositiveSafe(this.expectedPhysicalSeq, "remote.rpcFrame.invalidPhysicalSeq");
    assertPositiveSafe(this.expectedMessageSeq, "remote.rpcFrame.invalidMessageSeq");
    this.lastCompletedMessageSeq = this.expectedMessageSeq - 1;
    this.maxPhysicalFrameBytes = boundedPositive(
      options.maxPhysicalFrameBytes,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      "remote.rpcFrame.invalidPhysicalLimit",
    );
    this.maxMessageBytes = boundedPositive(
      options.maxMessageBytes,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxMessageBytes,
      "remote.rpcFrame.invalidMessageLimit",
    );
    this.maxFragments = boundedPositive(
      options.maxFragments,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxFragments,
      "remote.rpcFrame.invalidFragmentLimit",
    );
    this.timeoutMs = boundedPositive(
      options.timeoutMs,
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.assemblyTimeoutMs,
      "remote.rpcFrame.invalidTimeout",
    );
    this.now = options.now ?? Date.now;
  }

  // [资源] 只有存在 active 时才有到期时间；null 表示调用方无需设定时器。
  // 到期时间基于 firstSeenAt，不是最后一片到达时间，防止慢速滴入拖住内存。
  get nextExpiryAt(): number | null {
    return this.active ? this.active.firstSeenAt + this.timeoutMs : null;
  }

  // [失败路径] terminal 时同步清空 active 并记录 terminalReason，之后所有帧复读该原因。
  // fault 事件始终带上 expectedSeq/expectedMessageSeq，便于对端定位缺口。
  // 改错故障：terminal 时只置标志不清 active，会让内存与状态长期不一致。
  private fault(
    reasonCode: string,
    terminal: boolean,
    frameValue?: Partial<WebRemoteControlRpcTransportFramePayload>,
  ): WebRemoteControlRpcTransportAssemblyEvent {
    if (terminal) {
      this.terminalReason = reasonCode;
      this.active = null;
    }
    return {
      kind: "fault",
      fault: {
        reasonCode,
        terminal,
        ...(typeof frameValue?.seq === "number" ? { seq: frameValue.seq } : {}),
        ...(typeof frameValue?.messageSeq === "number"
          ? { messageSeq: frameValue.messageSeq }
          : {}),
        expectedSeq: this.expectedPhysicalSeq,
        expectedMessageSeq: this.expectedMessageSeq,
      },
    };
  }

  // [并发] expire 是唯一的时间驱动入口，必须由同一时钟源调用，不能与 accept 抢跑。
  // 未到期返回 null 而不是 incomplete，避免调用方把轮询当成协议事件。
  // 改错故障：在 expire 里重置 firstSeenAt 会让超时永远不触发。
  expire(now: number = this.now()): WebRemoteControlRpcTransportAssemblyEvent | null {
    if (!this.active || now - this.active.firstSeenAt < this.timeoutMs) return null;
    return this.fault("remote.rpcFrame.assemblyTimeout", true, {
      messageSeq: this.active.messageSeq,
    });
  }

  // [契约] accept 是唯一状态推进点；所有拒绝都走 fault 出口，便于统一计数。
  // 检查顺序有语义：identity → terminal → expire → base64 → schema → 上限 → 序号。
  // 改错故障：把 expire 提到 identity 之前，外片会打断本连接的 assembly。
  accept(candidate: unknown, now: number = this.now()): WebRemoteControlRpcTransportAssemblyEvent {
    // foreign identity 必须先于本连接的 timeout、schema 与 base64 工作拒绝，否则坏外片会清空 owning assembly。
    if (hasRawIdentityMismatch(this.identity, candidate)) {
      return this.fault("remote.rpcFrame.identityMismatch", false);
    }
    // [契约] 终态后重复调用必须返回同一个 reasonCode，不能产生新的副作用。
    // 这里再走 fault 只为带上当前帧的 seq 信息，便于日志定位。
    // 改错故障：终态后返回 null 会让调用方误以为帧被静默接受。
    if (this.terminalReason) return this.fault(this.terminalReason, true);
    const expired = this.expire(now);
    if (expired) return expired;

    // [失败路径] 在 schema 之前先取 dataBase64 做长度与 canonical 硬闸，成本最低。
    // 此处 invalidBase64 是 terminal：说明对端编码实现有问题，继续收只会重复失败。
    // 改错故障：只依赖 schema 的 refine 会让超长 base64 先进入 decode 并分配内存。
    const rawBase64 =
      typeof candidate === "object" && candidate !== null && "dataBase64" in candidate
        ? (candidate as { dataBase64?: unknown }).dataBase64
        : undefined;
    if (
      typeof rawBase64 === "string" &&
      (rawBase64.length > this.maxPhysicalFrameBytes || !isCanonicalBase64(rawBase64))
    ) {
      return this.fault("remote.rpcFrame.invalidBase64", true);
    }
    // [契约] schema 失败一律 terminal invalidMetadata，不做字段级修复。
    // 用 safeParse 而非 parse，是为了让异常路径也走 fault 事件，保持单一出口。
    // 改错故障：对非法帧做「宽松修复」会让后续 fingerprint 与对端不一致。
    const parsed = webRemoteControlRpcTransportFrameSchema.safeParse(candidate);
    if (!parsed.success) return this.fault("remote.rpcFrame.invalidMetadata", true);
    const frameValue = parsed.data;
    if (!sameIdentity(this.identity, frameValue)) {
      return this.fault("remote.rpcFrame.identityMismatch", false, frameValue);
    }
    // [资源] 先按声明值拒绝超大消息，再分配任何重组缓冲。
    // 声明值不可信，后续仍靠 stagedBytes 与完成时字节数做二次校验。
    // 改错故障：只信 stagedBytes 会让攻击者先声明小值再发大量分片。
    if (frameValue.messageBytes > this.maxMessageBytes) {
      return this.fault("remote.rpcFrame.messageTooLarge", true, frameValue);
    }
    if (frameValue.fragmentCount > this.maxFragments) {
      return this.fault("remote.rpcFrame.fragmentLimitExceeded", true, frameValue);
    }
    if (measureWebRemoteControlRpcRelayEnvelopeBytes(frameValue) > this.maxPhysicalFrameBytes) {
      return this.fault("remote.rpcFrame.envelopeTooLarge", true, frameValue);
    }

    // [资源] decode 结果只在本帧生命周期内使用，push 进 fragments 后不再复制。
    // decoded 为空视为非法，即使 schema 已要求 dataBase64 非空。
    const decoded = decodeWireBase64(frameValue.dataBase64);
    if (!decoded || decoded.byteLength === 0) {
      return this.fault("remote.rpcFrame.invalidBase64", true, frameValue);
    }
    const fingerprint = frameFingerprint(frameValue, decoded);

    // [并发] active 内命中说明是同一 assembly 的重传，指纹相同才允许判 duplicate。
    // 指纹不同即 conflictingDuplicate 并 terminal：同 seq 不同内容无法判定真值。
    // 改错故障：直接按 duplicate 放行会让对端以为已收到，实际数据已损坏。
    const activeFingerprint = this.active?.frameFingerprintsBySeq.get(frameValue.seq);
    if (activeFingerprint) {
      if (!sameFingerprint(activeFingerprint, fingerprint)) {
        return this.fault("remote.rpcFrame.conflictingDuplicate", true, frameValue);
      }
      return {
        kind: "duplicate",
        ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null,
      };
    }
    // [契约] 已 settled 的 seq 只有指纹完全一致才算 duplicate，否则是跨消息冲突。
    // physicalSequenceExhausted 分支单独处理：max seq 上允许不同 messageSeq 的重复。
    // 改错故障：把 settled 命中一律当 duplicate 会掩盖 seq 复用攻击。
    const settledFingerprint = this.settledFrameFingerprintsBySeq.get(frameValue.seq);
    if (settledFingerprint) {
      if (sameFingerprint(settledFingerprint, fingerprint)) {
        return {
          kind: "duplicate",
          ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null,
        };
      }
      if (
        this.physicalSequenceExhausted &&
        frameValue.messageSeq !== settledFingerprint.messageSeq
      ) {
        return this.fault("remote.rpcFrame.physicalSequenceExhausted", true, frameValue);
      }
      return this.fault("remote.rpcFrame.conflictingDuplicate", true, frameValue);
    }

    // [契约] 小于期望且未命中 tombstone，说明是很久以前的重传，直接回 duplicate。
    // 这里不回 fault：重传窗口外的旧帧可能来自网络重复，不应断链。
    // 改错故障：改成 terminal 会让一次 ACK 丢失引发双向重连风暴。
    if (frameValue.seq < this.expectedPhysicalSeq) {
      return {
        kind: "duplicate",
        ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null,
      };
    }
    if (this.physicalSequenceExhausted) {
      return this.fault("remote.rpcFrame.physicalSequenceExhausted", true, frameValue);
    }
    if (this.messageSequenceExhausted && !this.active) {
      return this.fault("remote.rpcFrame.messageSequenceExhausted", true, frameValue);
    }
    // [失败路径] 跳号即 physicalGap，terminal：缺失帧无法靠等待补齐（本层无重排缓存）。
    // 不做乱序缓存是权衡结果：协议要求发送端按序，缓存会引入无界内存。
    // 改错故障：加乱序缓存等于在本层再造一套重传逻辑，与 ack 语义冲突。
    if (frameValue.seq > this.expectedPhysicalSeq) {
      return this.fault("remote.rpcFrame.physicalGap", true, frameValue);
    }
    // [契约] messageSeq 逐条递增，且只有上一条完成后才推进期望值。
    // 与 physicalSeq 不同：active 期间的 messageSeq 必须保持不变。
    // 改错故障：允许跳号会让未完成消息的后续分片被当成新消息首片。
    if (frameValue.messageSeq !== this.expectedMessageSeq) {
      return this.fault("remote.rpcFrame.messageGap", true, frameValue);
    }

    if (
      frameValue.seq === Number.MAX_SAFE_INTEGER &&
      frameValue.fragmentIndex + 1 < frameValue.fragmentCount
    ) {
      return this.fault("remote.rpcFrame.physicalSequenceExhausted", true, frameValue);
    }

    // [契约] 分片索引必须严格等于已收片数，即禁止乱序也禁止重复。
    // 用 fragments.length 而不是独立计数器，保证「已收片」与「索引」不会脱节。
    // 改错故障：用 fragmentCount 推算索引会在中途插入时误判 metadataMismatch。
    const expectedFragmentIndex = this.active?.fragments.length ?? 0;
    if (frameValue.fragmentIndex !== expectedFragmentIndex) {
      return this.fault("remote.rpcFrame.fragmentGap", true, frameValue);
    }
    if (
      this.active &&
      (frameValue.fragmentCount !== this.active.fragmentCount ||
        frameValue.messageBytes !== this.active.messageBytes)
    ) {
      return this.fault("remote.rpcFrame.metadataMismatch", true, frameValue);
    }
    if (this.active && frameValue.checksum.value !== this.active.checksum.value) {
      return this.fault("remote.rpcFrame.checksumMismatch", true, frameValue);
    }
    // [事务] 只有首个合法分片才创建 assembly，之前的任何拒绝都不留下半成品。
    // 创建时固定 messageSeq/fragmentCount/messageBytes/checksum，后续片必须完全一致。
    // 改错故障：在 schema 通过时就建 assembly，非法帧会占用超时资源。
    if (!this.active) {
      this.active = {
        messageSeq: frameValue.messageSeq,
        fragmentCount: frameValue.fragmentCount,
        messageBytes: frameValue.messageBytes,
        checksum: frameValue.checksum,
        firstSeenAt: now,
        stagedBytes: 0,
        fragments: [],
        frameFingerprintsBySeq: new Map(),
      };
    }
    // [资源] 累计字节超声明值立即 lengthMismatch，防止分片无限撑大内存。
    // 该检查在 push 之前，保证 active.fragments 永远不超过声明长度。
    // 改错故障：先 push 再检查会让单次攻击就分配超过 messageBytes 的缓冲。
    if (this.active.stagedBytes + decoded.byteLength > this.active.messageBytes) {
      return this.fault("remote.rpcFrame.lengthMismatch", true, frameValue);
    }
    this.active.fragments.push(decoded);
    this.active.frameFingerprintsBySeq.set(frameValue.seq, fingerprint);
    this.active.stagedBytes += decoded.byteLength;
    // [契约] 在最大 seq 收口后置 physicalSequenceExhausted，但本消息仍算合法完成。
    // 后续消息必须新 bridge generation，因为 seq 无法再自增。
    // 改错故障：直接自增会让 seq 变成 2^53，JSON 侧丢精度并表现为重复序号。
    if (frameValue.seq === Number.MAX_SAFE_INTEGER) {
      // 本消息可在最大 seq 收口，但任何后继消息都必须新 bridge generation。
      this.physicalSequenceExhausted = true;
    } else {
      this.expectedPhysicalSeq += 1;
    }

    if (this.active.fragments.length < this.active.fragmentCount) {
      return {
        kind: "incomplete",
        messageSeq: frameValue.messageSeq,
        receivedFragments: this.active.fragments.length,
      };
    }
    if (this.active.stagedBytes !== this.active.messageBytes) {
      return this.fault("remote.rpcFrame.lengthMismatch", true, frameValue);
    }
    const completedBytes = new Uint8Array(this.active.messageBytes);
    let offset = 0;
    for (const fragment of this.active.fragments) {
      completedBytes.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (crc32WireBytes(completedBytes) !== this.active.checksum.value) {
      return this.fault("remote.rpcFrame.checksumMismatch", true, frameValue);
    }
    const completedAssembly = this.active;
    const messageSeq = completedAssembly.messageSeq;
    // [事务] 完成是原子的：先整体替换 tombstone 表，再清 active、推进 messageSeq。
    // 替换而不是合并，保证 tombstone 只覆盖最近一条消息的物理 seq。
    // 改错故障：合并会让表随消息数增长，最终 OOM。
    this.settledFrameFingerprintsBySeq = new Map(completedAssembly.frameFingerprintsBySeq);
    this.active = null;
    this.lastCompletedMessageSeq = messageSeq;
    if (messageSeq === Number.MAX_SAFE_INTEGER) {
      this.messageSequenceExhausted = true;
    } else {
      this.expectedMessageSeq += 1;
    }
    return { kind: "complete", messageSeq, bytes: completedBytes };
  }
}
