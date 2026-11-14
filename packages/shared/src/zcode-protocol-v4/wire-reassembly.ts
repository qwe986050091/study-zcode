// INV-01 全链路校验：守住位置 重组末尾的字节、校验和、UTF-8、JSON 与 schema 五步；改错故障：坏帧被应用到权威状态。
// INV-02 空输入拒绝：守住位置 wires 长度判断；改错故障：取首片时越界抛异常。
// INV-03 上限收紧：守住位置 Math.min 与协议硬上限；改错故障：调用方放宽全局装配上限。
// INV-04 非法上限拒绝：守住位置 有限性与正数判断；改错故障：NaN 上限让所有帧通关。
// INV-05 完整帧同受上限：守住位置 complete 分支的体积检查；改错故障：单片大帧绕过装配上限。
// INV-06 分片数硬上限：守住位置 fragmentCount 判断；改错故障：恶意元数据制造千万级缺失下标。
// INV-07 元数据一致：守住位置 循环内九个字段的比较；改错故障：不同逻辑帧的分片被拼在一起。
// INV-08 下标合法：守住位置 fragmentIndex 的范围判断；改错故障：负数或越界下标进入暂存表。
// INV-09 重复片一致：守住位置 previous 的内容比较；改错故障：冲突分片被静默覆盖。
// INV-10 逐片计费：守住位置 累计字节的即时检查；改错故障：收齐后才统计，暂存内存先被撑爆。
// INV-11 长度相符：守住位置 累计字节与逻辑字节比较；改错故障：截断或填充的载荷通过校验。
// INV-12 缺片可重试：守住位置 incomplete 分支；改错故障：临时缺片被判终态拒绝。
// INV-13 按序拼接：守住位置 按下标取片的循环；改错故障：拼接顺序随到达顺序变化。
// INV-14 校验和最后算：守住位置 拼接完成后的 crc32；改错故障：只覆盖部分字节仍判通过。
// INV-15 严格 UTF-8：守住位置 fatal 解码选项；改错故障：非法字节被替换字符掩盖。
// INV-16 信封复核：守住位置 JSON 解析后的匹配；改错故障：载荷主题与分片主题不一致仍被接受。
// INV-17 拒绝不抛：守住位置 所有失败分支的返回；改错故障：异常冒泡打断接收循环。
// INV-18 结果三态：守住位置 返回联合类型；改错故障：调用方无法区分缺片与拒绝。
//
// 模块职责：把协议物理分片重组为逻辑帧，并在全部校验通过后原子产出可应用的值。
// 状态所有权：无状态；分片表与累计字节都是单次调用内的局部变量。
// 阅读顺序：结果类型 → 编码与信封 → 入口校验 → 完整帧分支 → 分片循环 → 拼接与解码。
// V4 physical wire reassembly：所有 fragment 只进入 staging；bytes、checksum、
// UTF-8、JSON 与 schema 全部通过后，才产出一个可原子 apply 的 logical frame。
import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "./core.js";
import { crc32WireBytes, decodeWireBase64 } from "./wire-binary.js";
import type { TopicFrameDeliveryKind, TopicWireFrame } from "./wire.js";
import { WIRE_FAULT_INVALID_PAYLOAD } from "./wire-fault.js";

// 三种结果：完整帧、缺片（附缺失下标）、拒绝（附原因码）。
// 缺片是可重试状态，拒绝是终态，调用方据此决定重发还是丢弃。
//
export type ReassembleTopicWireFramesResult<F> =
  | { kind: "complete"; frame: F; deliveryKind: TopicFrameDeliveryKind }
  | {
      kind: "incomplete";
      logicalFrameId: string;
      missingIndexes: number[];
    }
  | { kind: "rejected"; reasonCode: string };

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

// `frameMatchesEnvelope` 之前只用编码估算完整帧体积，不参与分片路径。
// 信封匹配同时校验 `topic` 与 `subscriptionId`，避免跨订阅串帧。
// `frame` 非对象或空值直接判不匹配，绝不走原型链读取。
//
function frameMatchesEnvelope(
  frame: unknown,
  wire: { topic: string; subscriptionId: string },
): boolean {
  if (typeof frame !== "object" || frame === null) return false;
  const record = frame as { topic?: unknown; subscriptionId?: unknown };
  return (
    record.topic === wire.topic &&
    record.subscriptionId === wire.subscriptionId
  );
}

// 空输入直接拒绝，避免下方取首片时越界。
// 上限取调用方值与协议硬上限的较小者，调用方无法放宽全局限制。
// 非有限或非正的上限判为非法参数，而不是静默夹到默认值。
//
export function reassembleTopicWireFrames<F>(
  wires: readonly TopicWireFrame<unknown>[],
  frameSchema: z.ZodType<F>,
  options: { maxAssemblyBytes?: number } = {},
): ReassembleTopicWireFramesResult<F> {
  if (wires.length === 0) {
    return { kind: "rejected", reasonCode: "proto.frameAssemblyEmpty" };
  }
  const first = wires[0]!;
  const requestedMaxAssemblyBytes =
    options.maxAssemblyBytes ?? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes;
  if (!Number.isFinite(requestedMaxAssemblyBytes) || requestedMaxAssemblyBytes <= 0) {
    return { kind: "rejected", reasonCode: "proto.invalidLimit.maxAssemblyBytes" };
  }
  const maxAssemblyBytes = Math.min(
    Math.floor(requestedMaxAssemblyBytes),
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
  );

  // 单片完整帧要求数组长度为 1 且信封自洽，否则视为元数据错配。
  // 完整帧同样受装配上限约束，否则可绕过权威状态上限。
  // 体积按 UTF-8 编码字节估算，不能用字符数。
  // schema 校验失败返回无效载荷，与分片路径使用同一原因码。
  //
  if (first.kind === "complete") {
    if (wires.length !== 1 || !frameMatchesEnvelope(first.frame, first)) {
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyMetadataMismatch",
      };
    }
    if (encodeJson(first.frame).byteLength > maxAssemblyBytes) {
      // complete 与 fragment 是同一个 logical frame 的两种物理
      // 承载，只限制 fragment 会允许接收端绕过 16 MiB 权威状态上限。
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyTooLarge",
      };
    }
    const parsed = frameSchema.safeParse(first.frame);
    return parsed.success
      ? { kind: "complete", frame: parsed.data, deliveryKind: first.deliveryKind }
      : { kind: "rejected", reasonCode: WIRE_FAULT_INVALID_PAYLOAD };
  }

  if (
    first.fragmentCount >
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments
  ) {
    // 修复原因：fragmentCount 曾只受 logicalBytes 约束，恶意元数据可在
    // 缺片路径制造千万级 missingIndexes，先用协议硬上限阻断无界分配。
    return {
      kind: "rejected",
      reasonCode: "proto.frameFragmentCountExceeded",
    };
  }
  if (first.logicalBytes > maxAssemblyBytes) {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyTooLarge",
    };
  }

  const fragments = new Map<number, Uint8Array>();
  let decodedByteTotal = 0;
  // 逐片校验元数据一致性：逻辑帧标识、序号、投递类型、主题与订阅都必须相同。
  // 分片数不得超过逻辑字节数，下标必须落在有效区间。
  // 重复分片内容一致则跳过，不一致直接拒绝，避免静默覆盖。
  // 数据段必须能 base64 解码，失败即拒绝整帧。
  //
  for (const wire of wires) {
    if (
      wire.kind !== "fragment" ||
      wire.logicalFrameId !== first.logicalFrameId ||
      wire.logicalFrameOrdinal !== first.logicalFrameOrdinal ||
      wire.deliveryKind !== first.deliveryKind ||
      wire.topic !== first.topic ||
      wire.subscriptionId !== first.subscriptionId ||
      wire.fragmentCount !== first.fragmentCount ||
      wire.logicalBytes !== first.logicalBytes ||
      wire.checksum.algorithm !== first.checksum.algorithm ||
      wire.checksum.value !== first.checksum.value ||
      wire.fragmentCount > wire.logicalBytes ||
      wire.fragmentIndex < 0 ||
      wire.fragmentIndex >= wire.fragmentCount
    ) {
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyMetadataMismatch",
      };
    }
    const decoded = decodeWireBase64(wire.dataBase64);
    if (!decoded) {
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyInvalidBase64",
      };
    }
    const previous = fragments.get(wire.fragmentIndex);
    if (previous) {
      if (
        previous.byteLength !== decoded.byteLength ||
        previous.some((byte, index) => byte !== decoded[index])
      ) {
        return {
          kind: "rejected",
          reasonCode: "proto.frameAssemblyFragmentConflict",
        };
      }
      continue;
    }
    const nextDecodedByteTotal = decodedByteTotal + decoded.byteLength;
    if (nextDecodedByteTotal > maxAssemblyBytes) {
      // 总字节不能到所有分片收齐后才统计；每接纳一片就
      // 检查，使 staging assembly 的累计内存始终受协议上限约束。
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyTooLarge",
      };
    }
    if (nextDecodedByteTotal > first.logicalBytes) {
      return {
        kind: "rejected",
        reasonCode: "proto.frameAssemblyLengthMismatch",
      };
    }
    fragments.set(wire.fragmentIndex, decoded);
    decodedByteTotal = nextDecodedByteTotal;
  }

  // 缺失下标按序补齐，供调用方精准重发而不是整帧重传。
  // 只缺片不算错误，收齐后仍要过长度、校验和与解码。
  // 缺片结果携带逻辑帧标识，便于调用方按帧聚合重发。
  //
  const missingIndexes: number[] = [];
  for (let index = 0; index < first.fragmentCount; index += 1) {
    if (!fragments.has(index)) missingIndexes.push(index);
  }
  if (missingIndexes.length > 0) {
    return {
      kind: "incomplete",
      logicalFrameId: first.logicalFrameId,
      missingIndexes,
    };
  }
  if (decodedByteTotal !== first.logicalBytes) {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyLengthMismatch",
    };
  }

  // 按序号拼接逻辑字节，顺序由下标决定而不是到达顺序。
  // 拼接完再算校验和，早算会漏掉后续分片的影响。
  // 累计字节在接纳每一片时就检查上限，暂存内存始终受控。
  //
  const logical = new Uint8Array(decodedByteTotal);
  let offset = 0;
  for (let index = 0; index < first.fragmentCount; index += 1) {
    const fragment = fragments.get(index)!;
    logical.set(fragment, offset);
    offset += fragment.byteLength;
  }
  if (crc32WireBytes(logical) !== first.checksum.value) {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyChecksumMismatch",
    };
  }

  // UTF-8 用严格模式解码，非法字节序列直接拒绝。
  // JSON 解析后再校验信封与 schema，两步都不通过就返回无效载荷。
  //
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(logical);
  } catch {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyInvalidUtf8",
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyInvalidJson",
    };
  }
  if (!frameMatchesEnvelope(value, first)) {
    return {
      kind: "rejected",
      reasonCode: "proto.frameAssemblyMetadataMismatch",
    };
  }
  const parsed = frameSchema.safeParse(value);
  return parsed.success
    ? { kind: "complete", frame: parsed.data, deliveryKind: first.deliveryKind }
    : { kind: "rejected", reasonCode: WIRE_FAULT_INVALID_PAYLOAD };
}
