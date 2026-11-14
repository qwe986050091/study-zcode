/* eslint-disable max-lines -- physical assembly 的 ordinal、预算、校验与释放必须保持单一原子状态机。 */
// V4 incremental physical assembler：ownership 过滤后逐片接纳，只在
// checksum/UTF-8/JSON/schema 全部通过后产出一个 logical frame。
// V4 wire 物理分片重组器：把 ownership 过滤后的 fragment/complete wire 拼成 logical frame。
// 做：ordinal 与 tombstone 检查、预算与并发上限、base64 解码、长度/checksum/UTF-8/JSON/schema 校验。
// 不做：ownership 与订阅过滤（上游完成）、持久化、重放；不解释 frame 的业务语义。
// 依赖：wire-binary（crc32/base64）、wire-codec（信封字节计量）、wire-fault（错误码）。
// 边界：要么产出完整且通过校验的 frame，要么产出 owned typed fault，不存在半成品出口。
//
// INV-01 断言：accept 必须最先 expire(now) 再处理当前 wire —— 守住它的位置：首行 —— 改错故障：超时帧残留到下一片，与新帧拼出错误内容。
// INV-02 断言：ordinal 合法性（安全整数且 ≥1）必须早于任何 map 操作 —— 守住它的位置：第一个 if —— 改错故障：NaN 或负数进入 tombstone，后续所有帧被判为旧帧。
// INV-03 断言：settled 检查必须早于 envelope/base64 与预算检查 —— 守住它的位置：该段位置 —— 改错故障：迟到旧坏片释放正在组装的新帧。
// INV-04 断言：ordinal 小于 settled 时必须静默返回、不产生 fault —— 守住它的位置：第一个 return —— 改错故障：重放旧片刷出大量 fault，decoder 直接关闭 route。
// INV-05 断言：同 ordinal 只有 id 不同才是 ordinalConflict，同 id 必须静默 —— 守住它的位置：嵌套判断 —— 改错故障：正常重传被当冲突，组装中断。
// INV-06 断言：recovery 到达时必须回收同 route 更低 ordinal 的旧 fault —— 守住它的位置：倒序 splice 循环 —— 改错故障：旧 online 超时 fault 关掉 route，丢失紧随的 recovery。
// INV-07 断言：只有 recovery 可以无 fault 取代旧 assembly —— 守住它的位置：deliveryKind !== "recovery" 判断 —— 改错故障：同批 fault 让 decoder fail-close，flight 永不收口。
// INV-08 断言：替换旧 assembly 必须 release 后立刻 settle —— 守住它的位置：相邻两行 —— 改错故障：tombstone 缺失导致旧 ordinal 的帧复活。
// INV-09 断言：deliveryKind 非法必须先 releaseAndSettle 再 fault —— 守住它的位置：该分支 —— 改错故障：不推进 ordinal，同序号的坏片可以无限重试。
// INV-10 断言：complete 分支必须校验 key 白名单且必须真的拥有 frame 属性 —— 守住它的位置：hasOnlyKeys 与 hasOwnProperty —— 改错故障：多余字段或缺失 frame 的 wire 进入 schema 解析。
// INV-11 断言：信封字节超限必须在 schema 解析之前判定 —— 守住它的位置：measureTopicNotificationEnvelopeBytes —— 改错故障：超大 payload 先被 JSON 解析，内存峰值失控。
// INV-12 断言：complete 命中已有 active assembly 时必须释放旧 assembly 并报 metadataMismatch —— 守住它的位置：该分支 —— 改错故障：分片与整帧混拼，内容错乱。
// INV-13 断言：fragment 的 count/kind/logicalBytes/checksum 必须与已有 assembly 完全一致 —— 守住它的位置：比较块 —— 改错故障：不同逻辑帧的片混入同一 assembly，checksum 永不匹配。
// INV-14 断言：新 assembly 必须同时通过并发上限与 staged 预算才可创建 —— 守住它的位置：两个 if —— 改错故障：map 无限增长或累计解码字节超限。
// INV-15 断言：重复 fragmentIndex 必须比对字节：相同静默、不同 fault —— 守住它的位置：previous 分支 —— 改错故障：冲突片覆盖旧片，重组结果不可复现。
// INV-16 断言：decodedBytes 累加不得超过 logicalBytes —— 守住它的位置：该 if —— 改错故障：超长片照样写入，最终长度校验前已浪费预算。
// INV-17 断言：stagedDecodedBytes 必须与 assemblies 内 decodedBytes 严格同步 —— 守住它的位置：累加与 release —— 改错故障：预算泄漏或提前耗尽，后续帧被误拒。
// INV-18 断言：release 必须先校验 assembly 身份 —— 守住它的位置：`if (this.assemblies.get(key) !== assembly) return;` —— 改错故障：重复释放把 stagedDecodedBytes 减成负数。
// INV-19 断言：settle 不得让 tombstone 的 ordinal 回退 —— 守住它的位置：previous 比较 —— 改错故障：迟到旧 fault 把水位拉低，旧帧重放复活。
// INV-20 断言：完成路径必须是先 release 再校验长度/checksum/UTF-8/JSON/schema，最后 settle —— 守住它的位置：命中计数之后的顺序 —— 改错故障：失败时占用未释放或 tombstone 丢失。
//
// 阅读顺序：先看 INV 清单，再看 accept() 里的检查顺序注释。
// 约束：所有失败分支都必须先 release/settle 再 push fault，顺序不可交换。
// 状态机：assemblies 保存 active 分片，settledByRoute 保存 ordinal tombstone，二者不可合并。
import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "./core.js";
import { crc32WireBytes, decodeWireBase64 } from "./wire-binary.js";
import { measureTopicNotificationEnvelopeBytes } from "./wire-codec.js";
import type { TopicFrameDeliveryKind, TopicWireFrameCandidate } from "./wire.js";
import { WIRE_FAULT_INVALID_PAYLOAD } from "./wire-fault.js";

export interface TopicWireAssemblyFault {
  /** 缺失/伪值本身也必须成为 owned typed fault，此时不能伪造用途。 */
  deliveryKind?: TopicFrameDeliveryKind;
  reasonCode: string;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  topic: string;
  subscriptionId: string;
}

export type TopicWireAssemblyEvent<F> =
  | { kind: "complete"; frame: F; deliveryKind: TopicFrameDeliveryKind }
  | { kind: "fault"; fault: TopicWireAssemblyFault };

export interface TopicWireFrameAssemblerOptions {
  maxAssemblyBytes?: number;
  maxFragments?: number;
  maxConcurrentAssemblies?: number;
  maxStagedDecodedBytes?: number;
  timeoutMs?: number;
  maxPhysicalFrameBytes?: number;
}

interface FragmentAssembly {
  deliveryKind: TopicFrameDeliveryKind;
  logicalFrameId: string;
  logicalFrameOrdinal: number;
  topic: string;
  subscriptionId: string;
  fragmentCount: number;
  logicalBytes: number;
  checksum: { algorithm: "crc32"; value: string };
  fragments: Array<Uint8Array | undefined>;
  receivedCount: number;
  decodedBytes: number;
  firstSeenAt: number;
}

interface SettledLogicalFrame {
  logicalFrameId: string;
  logicalFrameOrdinal: number;
}

type FragmentWireCandidate = Extract<TopicWireFrameCandidate, { kind: "fragment" }>;
type ValidatedFragmentWire = FragmentWireCandidate & {
  fragmentIndex: number;
  fragmentCount: number;
  logicalBytes: number;
  checksum: { algorithm: string; value: string };
  dataBase64: string;
};

// [契约] complete wire 的字段白名单是封闭集合，多一个字段即视为协议错误。
// [失败路径] 放宽白名单会让新客户端的试验字段静默通过，跨版本语义漂移。
// [权衡] 用 Set 而不是 zod strict object：这里只做键检查，payload 由 frameSchema 负责。
// [边界] 白名单增删必须与 wire.ts 的候选类型同步。
// [资源] 模块级常量只读，避免每帧重建集合。
const COMPLETE_WIRE_KEYS = new Set([
  "wireVersion",
  "kind",
  "deliveryKind",
  "logicalFrameId",
  "logicalFrameOrdinal",
  "topic",
  "subscriptionId",
  "frame",
]);
// [契约] fragment 白名单必须覆盖 index/count/bytes/checksum/data 全部字段。
// [失败路径] 漏一个键会让合法分片被判 metadataMismatch，整条流永远凑不齐。
// [权衡] 白名单与 COMPLETE 独立维护：两者字段语义不同，合并会放宽校验。
// [边界] 该检查只验键集合，不验值类型。
// [资源] 与 COMPLETE 同样保持模块级只读。
const FRAGMENT_WIRE_KEYS = new Set([
  "wireVersion",
  "kind",
  "deliveryKind",
  "logicalFrameId",
  "logicalFrameOrdinal",
  "topic",
  "subscriptionId",
  "fragmentIndex",
  "fragmentCount",
  "logicalBytes",
  "checksum",
  "dataBase64",
]);
const CHECKSUM_KEYS = new Set(["algorithm", "value"]);

// [契约] 只允许 allowed 中的键存在，不检查缺失键（缺失由后续必填校验负责）。
// [失败路径] 改成 some 会把「全部命中」逻辑反转成「任一命中」。
// [权衡] every 在空对象上返回 true，这是刻意的：空对象交给下一层校验。
// [边界] 该函数不认识 prototype，只遍历自有可枚举键。
function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

// [契约] 只有 initial/online/recovery 三个值是合法投递类型。
// [失败路径] 用 Boolean 或字符串强转会让 ""、"INITIAL" 混进状态机。
// [边界] 返回 null 是显式非法信号，调用方必须终止该 wire。
function parseDeliveryKind(value: unknown): TopicFrameDeliveryKind | null {
  return value === "initial" || value === "online" || value === "recovery" ? value : null;
}

// [契约] 该谓词只做类型收窄：键白名单、四个数值/字符串字段、checksum 对象形状。
// [失败路径] 少校验 checksum 非数组会让后续取 algorithm 时抛 TypeError。
// [权衡] 类型收窄而不是深校验：具体取值范围留给后面的显式 if，便于分别映射错误码。
// [边界] 不在此处校验 fragmentCount 与 logicalBytes 的关系。
// [并发] `hasValidFragmentInner` 只读入参，任何阶段调用都不会与组装状态竞争。
function hasValidFragmentInner(wire: FragmentWireCandidate): wire is ValidatedFragmentWire {
  if (
    !hasOnlyKeys(wire, FRAGMENT_WIRE_KEYS) ||
    typeof wire.fragmentIndex !== "number" ||
    typeof wire.fragmentCount !== "number" ||
    typeof wire.logicalBytes !== "number" ||
    typeof wire.dataBase64 !== "string" ||
    typeof wire.checksum !== "object" ||
    wire.checksum === null ||
    Array.isArray(wire.checksum) ||
    !hasOnlyKeys(wire.checksum, CHECKSUM_KEYS)
  ) {
    return false;
  }
  const checksum = wire.checksum as Record<string, unknown>;
  return typeof checksum.algorithm === "string" && typeof checksum.value === "string";
}

// [契约] route 键固定为 topic + NUL + subscriptionId。
// [失败路径] 用冒号连接会被 topic 内的冒号拼出歧义键，导致跨订阅串帧。
// [权衡] NUL 不可能出现在 topic 或 subscriptionId 中，天然免转义。
// [边界] 该键只用于内存 map，不参与任何持久化。
function routeKey(topic: string, subscriptionId: string): string {
  return `${topic}\0${subscriptionId}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// [契约] 解出的 frame 必须与信封的 topic/subscriptionId 完全一致。
// [失败路径] 跳过该检查会让 A 主题的 payload 通过 B 订阅的信封投递。
// [权衡] 只比对两个路由字段，不比对 ordinal：ordinal 由外层状态机负责。
// [边界] frame 非对象或为 null 时直接返回 false。
function frameMatchesEnvelope(
  frame: unknown,
  wire: { topic: string; subscriptionId: string },
): boolean {
  if (typeof frame !== "object" || frame === null) return false;
  const value = frame as { topic?: unknown; subscriptionId?: unknown };
  return value.topic === wire.topic && value.subscriptionId === wire.subscriptionId;
}

// [契约] 未传值时取编译期上限，传入值只能向下裁剪，永不可放大。
// [失败路径] 允许配置超过 PROTOCOL_V4_LIMITS 会让对端用协议内合法参数打爆内存。
// [权衡] 非法值直接抛 RangeError 而不是回落默认：配置错误必须早失败。
// [边界] 取整用 floor，0 与负数都被拒绝。
// [资源] `hardBound` 只在构造期执行一次，运行期不再重复做上限计算。
function hardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

export class TopicWireFrameAssembler<F> {
  private readonly assemblies = new Map<string, FragmentAssembly>();
  /** 每 route 的单调 ordinal tombstone；不会像 bounded id LRU 一样淘汰后复活旧帧。 */
  // [契约] tombstone 必须是单调水位，不能像 LRU 一样淘汰后复活旧帧。
  // [失败路径] 换成有界 id 缓存会让驱逐后的旧 ordinal 重新被接纳，重放攻击面打开。
  // [权衡] 每 route 只存一条记录：内存是路由数级，不随帧数增长。
  // [边界] 该表只在 clear() 与 discard() 时删除。
  // [并发] 单线程事件循环内读写，不需要额外加锁。
  private readonly settledByRoute = new Map<string, SettledLogicalFrame>();
  private stagedDecodedBytes = 0;
  private readonly maxAssemblyBytes: number;
  private readonly maxFragments: number;
  private readonly maxConcurrentAssemblies: number;
  private readonly maxStagedDecodedBytes: number;
  private readonly timeoutMs: number;
  private readonly maxPhysicalFrameBytes: number;

  // [契约] 六个上限全部经 hardBound 收敛，构造后不可再改。
  // [失败路径] 直接把 options 存成字段会让运行期放大上限。
  // [权衡] 逐项赋值而非对象展开：每一项都需要独立的名字用于错误信息。
  // [边界] 构造不做任何 IO，也不预分配分片数组。
  constructor(
    private readonly frameSchema: z.ZodType<F>,
    options: TopicWireFrameAssemblerOptions = {},
  ) {
    this.maxAssemblyBytes = hardBound(
      options.maxAssemblyBytes,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
      "maxAssemblyBytes",
    );
    this.maxFragments = hardBound(
      options.maxFragments,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments,
      "maxFragments",
    );
    this.maxConcurrentAssemblies = hardBound(
      options.maxConcurrentAssemblies,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxConcurrent,
      "maxConcurrentAssemblies",
    );
    this.maxStagedDecodedBytes = hardBound(
      options.maxStagedDecodedBytes,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxStagedBytes,
      "maxStagedDecodedBytes",
    );
    this.timeoutMs = hardBound(
      options.timeoutMs,
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs,
      "timeoutMs",
    );
    this.maxPhysicalFrameBytes = hardBound(
      options.maxPhysicalFrameBytes,
      PROTOCOL_V4_LIMITS.maxFrameBytes,
      "maxPhysicalFrameBytes",
    );
  }

  // [契约] 每次调用返回的事件数组可能同时包含 expire 产生的 fault 与本帧结果。
  // [失败路径] 丢弃 expire 的事件会让消费方永远不知道该 route 已超时。
  // [并发] now 由调用方注入，保证测试与批量重放的时间可控。
  // [权衡] 单入口而非 acceptFragment/acceptComplete：顺序检查必须在同一段内生效。
  // [边界] 本函数不修改入参 wire。
  accept(wire: TopicWireFrameCandidate, now = Date.now()): TopicWireAssemblyEvent<F>[] {
    const events = this.expire(now);
    const key = routeKey(wire.topic, wire.subscriptionId);
    if (
      !Number.isSafeInteger(wire.logicalFrameOrdinal) ||
      wire.logicalFrameOrdinal < 1
    ) {
      events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }

    // ordinal 淘汰检查必须早于 envelope/base64：迟到旧坏片不得释放正在组装的新帧。
    // [契约] tombstone 检查必须先于 envelope、base64、预算与 schema。
    // [失败路径] 放到后面会让迟到的旧坏片先释放当前正在组装的新帧。
    // [契约] ordinal 更小一律静默返回，不产生 fault。
    // [失败路径] 为旧片报 fault 会让 decoder 判定链路故障并关闭 route。
    // [并发] 读 tombstone 与后续写入之间没有 await，不会出现中间态。
    const settled = this.settledByRoute.get(key);
    if (settled) {
      if (wire.logicalFrameOrdinal < settled.logicalFrameOrdinal) return events;
      if (wire.logicalFrameOrdinal === settled.logicalFrameOrdinal) {
        if (wire.logicalFrameId !== settled.logicalFrameId) {
          events.push(this.fault(wire, "proto.frameAssemblyOrdinalConflict"));
        }
        return events;
      }
    }

    const deliveryKind = parseDeliveryKind(wire.deliveryKind);
    // [契约] recovery 首片到达时必须回收同 route 更低 ordinal 的旧 fault。
    // [失败路径] 不回收会让旧 online 的超时 fault 关掉 route，紧随的 recovery 被丢弃。
    // [权衡] 只过滤同 topic+subscriptionId 且 ordinal 更低的 fault，不误伤其它 route。
    // [边界] recovery 自身的坏片仍会产生带 recovery kind 的 typed fault。
    // [并发] 倒序遍历 splice，保证删除后索引不跳项。
    if (deliveryKind === "recovery") {
      // accept() 先 expire 再接当前 wire。若旧 online 恰在 recovery 首片到达的
      // 同次调用超时，向 consumer 上报旧 fault 会关掉 route 并丢失已接 recovery
      // fragment。更高 ordinal 的权威 recovery 已取代旧 assembly，过滤该旧 fault；
      // recovery 自身若坏，后续仍会产生带 recovery kind 的 typed fault。
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
          event?.kind === "fault" &&
          event.fault.topic === wire.topic &&
          event.fault.subscriptionId === wire.subscriptionId &&
          event.fault.logicalFrameOrdinal < wire.logicalFrameOrdinal
        ) {
          events.splice(index, 1);
        }
      }
    }
    // [契约] 同一 route 同时只能有一个 active assembly，新 ordinal 必须替换旧的。
    // [失败路径] 允许并存会让两帧的分片混进同一数组，checksum 永不可能匹配。
    // [契约] 同 ordinal 同 id 视为重复片，继续走下面的去重逻辑。
    // [失败路径] 同 ordinal 不同 id 必须 release+settle 并报冲突，不能静默丢弃。
    // [权衡] 只有 recovery 可以无 fault 取代旧帧，见下面的显式分支。
    const current = this.assemblies.get(key);
    if (current) {
      if (wire.logicalFrameOrdinal < current.logicalFrameOrdinal) return events;
      if (wire.logicalFrameOrdinal === current.logicalFrameOrdinal) {
        if (wire.logicalFrameId !== current.logicalFrameId) {
          this.release(key, current);
          this.settle(key, current);
          events.push(this.fault(wire, "proto.frameAssemblyOrdinalConflict"));
          return events;
        }
      } else {
        this.release(key, current);
        this.settle(key, current);
        // same-sub recovery 本来就是权威替换残缺旧帧；若仍把旧 online
        // assembly 作为同批 fault 上报，decoder 会 fail-close 并丢掉紧随其后的完整
        // recovery，flight 永远无法收口。只有权威 recovery 可无 fault supersede。
        if (deliveryKind !== "recovery") {
          events.push(this.fault(current, "proto.frameAssemblySuperseded"));
        }
      }
    }

    if (deliveryKind === null) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }

    // [契约] complete 路径的检查顺序固定：键白名单 → 信封大小 → 无冲突 → 逻辑大小 → 路由匹配 → schema。
    // [失败路径] 把 schema 提前会在超大 payload 上先付出解析成本。
    // [契约] 每个失败分支都必须 releaseAndSettle 或 settle，禁止裸 return。
    // [权衡] complete 也要过 maxAssemblyBytes，与分片路径共用同一预算口径。
    // [边界] 成功后必须 settle 再 push complete，保证 tombstone 先落地。
    if (wire.kind === "complete") {
      if (
        !hasOnlyKeys(wire, COMPLETE_WIRE_KEYS) ||
        !Object.prototype.hasOwnProperty.call(wire, "frame")
      ) {
        this.releaseAndSettle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
        return events;
      }
      if (measureTopicNotificationEnvelopeBytes(wire).maxBytes > this.maxPhysicalFrameBytes) {
        this.releaseAndSettle(key, wire);
        events.push(this.fault(wire, "proto.frameEnvelopeTooLarge"));
        return events;
      }
      // [契约] 整帧到达时若已有分片组装，必须释放旧 assembly 并报 metadataMismatch。
      // [失败路径] 直接接纳整帧会让旧分片预算泄漏到永远。
      // [权衡] 报错而不是静默替换：整帧与分片混用是协议违约，抛 `metadataMismatch` 让调用方重取。
      // [边界] 该分支返回前已经 settle 旧 assembly。
      const active = this.assemblies.get(key);
      if (active) {
        this.release(key, active);
        this.settle(key, active);
        events.push(this.fault(active, "proto.frameAssemblyMetadataMismatch"));
        return events;
      }
      const logicalBytes = new TextEncoder().encode(JSON.stringify(wire.frame)).byteLength;
      if (logicalBytes > this.maxAssemblyBytes) {
        this.settle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyTooLarge"));
        return events;
      }
      if (!frameMatchesEnvelope(wire.frame, wire)) {
        this.settle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
        return events;
      }
      const parsed = this.frameSchema.safeParse(wire.frame);
      if (!parsed.success) {
        this.settle(key, wire);
        events.push(this.fault(wire, WIRE_FAULT_INVALID_PAYLOAD));
        return events;
      }
      this.settle(key, wire);
      events.push({ kind: "complete", frame: parsed.data, deliveryKind });
      return events;
    }

    if (!hasValidFragmentInner(wire)) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }
    if (measureTopicNotificationEnvelopeBytes(wire).maxBytes > this.maxPhysicalFrameBytes) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameEnvelopeTooLarge"));
      return events;
    }

    // [契约] 分片数是硬上限，超过即拒绝，不做截断。
    // [失败路径] 截断会让后续 fragmentIndex 越界，错误码从 count 变成 metadata，误导排查。
    // [权衡] count 与 logicalBytes 分别设限：一个是数组长度，一个是字节总量。
    // [边界] 该检查在解码 base64 之前，避免为必被拒的帧分配内存。
    if (wire.fragmentCount > this.maxFragments) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameFragmentCountExceeded"));
      return events;
    }
    if (wire.logicalBytes > this.maxAssemblyBytes) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyTooLarge"));
      return events;
    }
    if (
      !Number.isInteger(wire.fragmentCount) ||
      wire.fragmentCount < 1 ||
      !Number.isInteger(wire.fragmentIndex) ||
      wire.fragmentIndex < 0 ||
      wire.fragmentIndex >= wire.fragmentCount ||
      !Number.isInteger(wire.logicalBytes) ||
      wire.logicalBytes < 1 ||
      wire.fragmentCount > wire.logicalBytes ||
      wire.checksum.algorithm !== "crc32" ||
      !/^[0-9a-f]{8}$/u.test(wire.checksum.value)
    ) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }

    const decoded = decodeWireBase64(wire.dataBase64);
    if (!decoded) {
      this.releaseAndSettle(key, wire);
      events.push(this.fault(wire, "proto.frameAssemblyInvalidBase64"));
      return events;
    }

    // [契约] 已有 assembly 时必须逐项比对 count/kind/logicalBytes/checksum。
    // [失败路径] 放过任何一项不一致都会让两帧的片拼在一起，最终 checksum 报错而非指出根因。
    // [契约] 新建 assembly 前必须同时通过并发上限与 staged 预算。
    // [失败路径] 先建后查会让超限帧短暂占用预算，挤掉合法帧。
    // [权衡] 分片数组按 count 预分配 undefined，用占位表达「未到达」。
    let assembly = this.assemblies.get(key);
    if (assembly) {
      if (
        assembly.fragmentCount !== wire.fragmentCount ||
        assembly.deliveryKind !== deliveryKind ||
        assembly.logicalBytes !== wire.logicalBytes ||
        assembly.checksum.algorithm !== wire.checksum.algorithm ||
        assembly.checksum.value !== wire.checksum.value
      ) {
        this.release(key, assembly);
        this.settle(key, assembly);
        events.push(this.fault(wire, "proto.frameAssemblyMetadataMismatch"));
        return events;
      }
    } else {
      if (this.assemblies.size >= this.maxConcurrentAssemblies) {
        this.settle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyConcurrentLimit"));
        return events;
      }
      if (this.stagedDecodedBytes + decoded.byteLength > this.maxStagedDecodedBytes) {
        this.settle(key, wire);
        events.push(this.fault(wire, "proto.frameAssemblyBudgetExceeded"));
        return events;
      }
      assembly = {
        deliveryKind,
        logicalFrameId: wire.logicalFrameId,
        logicalFrameOrdinal: wire.logicalFrameOrdinal,
        topic: wire.topic,
        subscriptionId: wire.subscriptionId,
        fragmentCount: wire.fragmentCount,
        logicalBytes: wire.logicalBytes,
        checksum: { algorithm: "crc32", value: wire.checksum.value },
        fragments: Array.from(
          { length: wire.fragmentCount },
          () => undefined as Uint8Array | undefined,
        ),
        receivedCount: 0,
        decodedBytes: 0,
        firstSeenAt: now,
      };
      this.assemblies.set(key, assembly);
    }

    // [契约] 重复 index 必须做字节比对：相同则静默返回，不同则 fault 并丢弃整帧。
    // [失败路径] 直接覆盖会让重传的脏片替换掉合法片，重组结果不可复现。
    // [权衡] 用 `bytesEqual` 逐字节比较而不是哈希：单片大小有限，逻辑更直观。
    // [边界] 静默返回时不得再次累加 decodedBytes。
    // [并发] 比对与写入之间没有 await，不会竞争。
    const previous = assembly.fragments[wire.fragmentIndex];
    if (previous) {
      if (!bytesEqual(previous, decoded)) {
        this.release(key, assembly);
        this.settle(key, assembly);
        events.push(this.fault(wire, "proto.frameAssemblyFragmentConflict"));
      }
      return events;
    }
    if (this.stagedDecodedBytes + decoded.byteLength > this.maxStagedDecodedBytes) {
      this.release(key, assembly);
      this.settle(key, assembly);
      events.push(this.fault(wire, "proto.frameAssemblyBudgetExceeded"));
      return events;
    }
    if (assembly.decodedBytes + decoded.byteLength > assembly.logicalBytes) {
      this.release(key, assembly);
      this.settle(key, assembly);
      events.push(this.fault(wire, "proto.frameAssemblyLengthMismatch"));
      return events;
    }
    assembly.fragments[wire.fragmentIndex] = decoded;
    assembly.receivedCount += 1;
    assembly.decodedBytes += decoded.byteLength;
    this.stagedDecodedBytes += decoded.byteLength;
    // [契约] 只有在收齐全部片时才进入拼装与校验阶段。
    // [失败路径] 提前拼装会得到长度不足的 buffer，被误报为 lengthMismatch。
    // [权衡] 用计数而不是遍历检查 undefined：计数在同一步累加，成本恒定。
    // [边界] 未收齐时必须原样返回本次 expire 事件，不额外 push。
    if (assembly.receivedCount !== assembly.fragmentCount) return events;

    this.release(key, assembly);
    if (assembly.decodedBytes !== assembly.logicalBytes) {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyLengthMismatch"));
      return events;
    }
    const logical = new Uint8Array(assembly.decodedBytes);
    let offset = 0;
    for (const fragment of assembly.fragments) {
      if (!fragment) {
        this.settle(key, assembly);
        events.push(this.fault(assembly, "proto.frameAssemblyLengthMismatch"));
        return events;
      }
      logical.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (crc32WireBytes(logical) !== assembly.checksum.value) {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyChecksumMismatch"));
      return events;
    }
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(logical);
    } catch {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyInvalidUtf8"));
      return events;
    }
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyInvalidJson"));
      return events;
    }
    if (!frameMatchesEnvelope(value, assembly)) {
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyMetadataMismatch"));
      return events;
    }
    const parsed = this.frameSchema.safeParse(value);
    if (!parsed.success) {
      this.settle(key, assembly);
      events.push(this.fault(assembly, WIRE_FAULT_INVALID_PAYLOAD));
      return events;
    }
    this.settle(key, assembly);
    events.push({ kind: "complete", frame: parsed.data, deliveryKind: assembly.deliveryKind });
    return events;
  }

  // [契约] 超时判定基于 firstSeenAt，不是最后一片到达时间。
  // [失败路径] 用滑动窗口会让慢速攻击者无限续命，预算永不释放。
  // [并发] 遍历中直接 release 当前项，Map 允许安全删除。
  // [边界] 超时后必须 settle，防止旧 ordinal 在超时后复活。
  expire(now = Date.now()): TopicWireAssemblyEvent<F>[] {
    const events: TopicWireAssemblyEvent<F>[] = [];
    for (const [key, assembly] of this.assemblies) {
      if (now - assembly.firstSeenAt < this.timeoutMs) continue;
      this.release(key, assembly);
      this.settle(key, assembly);
      events.push(this.fault(assembly, "proto.frameAssemblyTimedOut"));
    }
    return events;
  }

  // [契约] discard 是「该路由彻底作废」：释放内存并清掉 tombstone。
  // [失败路径] 只删 assembly 不删 tombstone，重连后新订阅的同序号帧会被永久静默。
  // [权衡] 订阅切换时才调用，重放防护因此可以重置。
  // [边界] 该操作不产生任何事件。
  discard(topic: string, subscriptionId: string): void {
    const key = routeKey(topic, subscriptionId);
    const assembly = this.assemblies.get(key);
    if (assembly) this.release(key, assembly);
    this.settledByRoute.delete(key);
  }

  /** fault 后释放该 route 的 active bytes，但保留 ordinal tombstone 防旧 replay 复活。 */
  // [契约] abort 释放 active 字节但保留 tombstone，用于 fault 后的清理。
  // [失败路径] 连 tombstone 一起删会让已判死的 ordinal 重新可接纳。
  // [权衡] 没有 active assembly 时直接返回，不写 tombstone。
  // [边界] 与 discard 的差别就在是否保留水位。
  abort(topic: string, subscriptionId: string): void {
    const key = routeKey(topic, subscriptionId);
    const assembly = this.assemblies.get(key);
    if (!assembly) return;
    this.release(key, assembly);
    this.settle(key, assembly);
  }

  clear(): void {
    this.assemblies.clear();
    this.settledByRoute.clear();
    this.stagedDecodedBytes = 0;
  }

  getStats(): { assemblies: number; stagedDecodedBytes: number } {
    return { assemblies: this.assemblies.size, stagedDecodedBytes: this.stagedDecodedBytes };
  }

  get nextExpiryAt(): number | null {
    let next: number | null = null;
    for (const assembly of this.assemblies.values()) {
      const expiresAt = assembly.firstSeenAt + this.timeoutMs;
      if (next === null || expiresAt < next) next = expiresAt;
    }
    return next;
  }

  // [契约] 必须先确认 map 中的当前值就是传入的 assembly，否则直接返回。
  // [失败路径] 跳过身份校验会在重复释放时把 stagedDecodedBytes 减成负数。
  // [契约] 删除 map 与扣减预算必须在同一同步段完成。
  // [失败路径] 只扣预算不删 map 会让下一片继续写进已释放的 assembly。
  // [资源] 预算只在这里扣减，是唯一出口。
  private release(key: string, assembly: FragmentAssembly): void {
    if (this.assemblies.get(key) !== assembly) return;
    this.assemblies.delete(key);
    this.stagedDecodedBytes -= assembly.decodedBytes;
  }

  // [契约] tombstone 只前进不后退：已有更高 ordinal 时直接 return。
  // [失败路径] 允许回退会让迟到的旧 fault 拉低水位，旧帧重新可接纳。
  // [权衡] 同 ordinal 直接覆盖 id：id 冲突已在上层报错，这里不再判。
  // [边界] 该函数不释放 assembly，只更新水位。
  // [并发] 同步写入，调用方必须保证在同一 tick 内完成判断与写入。
  private settle(
    key: string,
    frame: Pick<FragmentAssembly, "logicalFrameId" | "logicalFrameOrdinal">,
  ): void {
    const previous = this.settledByRoute.get(key);
    if (previous && previous.logicalFrameOrdinal > frame.logicalFrameOrdinal) return;
    this.settledByRoute.set(key, {
      logicalFrameId: frame.logicalFrameId,
      logicalFrameOrdinal: frame.logicalFrameOrdinal,
    });
  }

  // [契约] 只有在 active 与传入帧的 ordinal+id 都一致时才释放。
  // [失败路径] 无条件 release 会误删同 route 上更新的 assembly。
  // [权衡] 覆盖「可能没有 active」的场景，避免调用方重复写判空。
  // [边界] 无论是否释放，都必须 settle。
  private releaseAndSettle(
    key: string,
    frame: Pick<FragmentAssembly, "logicalFrameId" | "logicalFrameOrdinal">,
  ): void {
    const active = this.assemblies.get(key);
    if (
      active &&
      active.logicalFrameOrdinal === frame.logicalFrameOrdinal &&
      active.logicalFrameId === frame.logicalFrameId
    ) {
      this.release(key, active);
    }
    this.settle(key, frame);
  }

  // [契约] fault 必须携带 topic/subscriptionId/ordinal，缺失则消费方无法归属 route。
  // [失败路径] deliveryKind 非法时不能伪造，必须省略该字段。
  // [权衡] reasonCode 由调用点给出，本函数不做映射，保证错误码可追溯。
  // [边界] 只构造事件，不修改任何状态。
  // [并发] 纯函数，可安全用于已释放 assembly 的归因。
  private fault(
    source: {
      deliveryKind?: unknown;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
    },
    reasonCode: string,
  ): TopicWireAssemblyEvent<F> {
    const deliveryKind = parseDeliveryKind(source.deliveryKind);
    return {
      kind: "fault",
      fault: {
        ...(deliveryKind === null ? {} : { deliveryKind }),
        reasonCode,
        logicalFrameId: source.logicalFrameId,
        logicalFrameOrdinal: source.logicalFrameOrdinal,
        topic: source.topic,
        subscriptionId: source.subscriptionId,
      },
    };
  }
}
