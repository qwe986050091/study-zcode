// Conversation topic 发布器（传输外壳）。
// CLI 侧权威运行时：内存有界 delta 日志（logEpoch + 保留窗）+ subscribe(base)
// 裁决（resume/snapshot）+ 每订阅者 flush 管线（filter → coalesce → 打帧）。
//
// 职责边界：
// - 本类只做「事件 → 帧」的权威记账，不做网络 IO / 定时器——flush 时机由宿主驱动
//   （host 通道层按 profile.flushWindowMs 调度；测试里手动调用），保持可测的纯推进。
// - 恢复与续流共用一条管线：resume 的初始帧 = 保留窗内 (base.seq, current] 的 delta
//   过该订阅者 profile 过滤再 coalesce，
//   因此「snapshot(W)+续流 ≡ 全量重放」黄金测试可直接覆盖恢复路径。
// - 重订阅 = 替换：同 connectionId 重复 subscribe 即作废旧订阅并清其
//   flush buffer，旧 subscriptionId 不再产帧，客户端按 subId 丢弃旧代际帧。
// 关键口径：
// - seq/logEpoch：seq 取投影 snapshot.seq（即事件记账水位），单调不回退；logEpoch 标识一次权威
//   代际，客户端用 (logEpoch, seq) 判定续传还是全量重放，跨代际一律 snapshot。
// - snapshot 边界：仅订阅 base 不可续、重放窗不足、resync/溢出处发全量；快照只带尾部窗口，
//   更早历史走 rows/range，避免快照随会话无限增长。
// - delta 封闭集合：只有投影定义的有限 op（row.appended/upserted/removed、state.updated 等）；
//   表达不了的变化必须回退 snapshot/resync，不得发明新 op。
// - 多播与背压：每订阅者独立 buffer（profile 过滤→旧消费者编码→coalesce）；溢出不积压，
//   标记 resyncRequired 并在下一帧回 snapshot；inFlight 保证同一订阅逻辑帧顺序，commit 后才推进 sentSeq。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type {
  CommandEnvelope,
  ConversationDelta,
  ConversationRowTarget,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfile,
  DeliveryProfileName,
  QueueItem,
  SubscribeAck,
  ToolCallRow,
  TopicFrameDeliveryKind,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  statePatchSchema,
  PROTOCOL_V4_LIMITS,
  clampWorkflowRunsForLegacy,
  coalesceConversationDeltas,
  filterConversationDeltasForProfile,
  filterConversationRowsForProfile,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import { Buffer } from "node:buffer";
import {
  encodeConversationDeltasForLegacy,
  workflowRunDeltaGrowthUpperBound,
} from "./conversation-workflow-run-deltas.js";
import {
  ProductProjection,
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type SessionConfigSeed,
  type SessionSubagentsSeed,
  type SessionUsageSeed,
  type StableForkCandidateResolution,
} from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

interface LogEntry {
  seq: number;
  deltas: ConversationDelta[];
}

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

/**
 * cold replay 会高频测量临时 delta；TextEncoder 会为每次测量再分配完整 Uint8Array。
 * CLI 已固定运行在 Node，这里对同一 JSON 文本直接计算精确 UTF-8 字节数，不做近似估算。
 */
// 输入任意可 JSON 序列化的值；undefined 返回 0。纯测量、无副作用，用于 payload 闸门而非产品逻辑。
export function coldHydrationJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPlanMarkdown(row: ToolCallRow): boolean {
  if (isRecord(row.input)) {
    const plan = row.input.plan;
    if (typeof plan === "string" && plan.trim().length > 0) return true;
  }
  if (!row.inputText.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(row.inputText);
    return isRecord(parsed) && typeof parsed.plan === "string" && parsed.plan.trim().length > 0;
  } catch {
    return false;
  }
}

interface Subscription {
  subscriptionId: string;
  connectionId: string;
  profile: DeliveryProfile;
  /**
   * 这条订阅认不认得 `workflowRun.*` 键级增量（握手能力位，由可信 host 注入）。
   * false = 旧消费者：增量折成整键 patch、快照裁到旧界（conversation-workflow-run-deltas.ts）。
   */
  workflowRunDeltas: boolean;
  /** flush buffer：push 时已过 profile 过滤与该订阅的编码，flush 时 coalesce 打帧。 */
  buffer: ConversationDelta[];
  bufferBytes: number;
  /** buffer 超限后只保留恢复意图，不继续为慢订阅者积压 delta。 */
  resyncRequired: boolean;
  /** 帧区间记账水位：下一帧 fromSeq（(fromSeq, toSeq] 语义）。 */
  sentSeq: number;
  /** 编码/写入期间保留的稳定 logical frame。 */
  inFlight: TopicFrameReservation<ConversationTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

/**
 * 订阅参数：connectionId 是归属键（重订阅即替换旧代际）；base 是客户端已确认的 (logEpoch,seq)，
 * 缺省/不可续则走 snapshot；deliveryProfile 决定行可见性，缺省 replayable（ws 默认）；
 * workflowRunDeltas 是可信 host 注入的能力位，缺省 false（按旧消费者折整键 patch）。
 * 所有字段由 host 校验后传入，publisher 不再做权限/来源判断。
 */
export interface ConversationSubscribeParams {
  connectionId: string;
  base?: { logEpoch: string; seq: number };
  /** 缺省 replayable（ws 默认；MessagePort 宿主显式传 continuous）。 */
  deliveryProfile?: DeliveryProfileName;
  /**
   * 该连接的 clientHello 声明过认得 `workflowRun.*` 增量。与 deliveryProfile 同族：可信 host
   * 注入，面向 UI 的 subscribe 选不了。缺省 false——能力位缺席一律按旧消费者办。
   */
  workflowRunDeltas?: boolean;
}

/**
 * 订阅结果：ack 声明本次裁决（resume/snapshot）与 logEpoch；reservation 是未提交首帧，
 * 生产 transport 在物理批次全部接受后 commit；rollback 仅撤销尚未 admission 的替换。
 * frame getter 为旧单测兼容面，读取即 commit；生产 gateway 不得通过它绕过投递确认。
 */
export interface ConversationSubscribeResult {
  ack: SubscribeAck;
  reservation: TopicFrameReservation<ConversationTopicFrame> | null;
  /** initial encode 失败且 ACK 未 admission 时，原子恢复被替换的旧 subscription。 */
  rollback(): boolean;
  /** snapshot 帧或 resume 的续传帧；resume 且无新增时为 null（客户端水位已对齐）。 */
  readonly frame: ConversationTopicFrame | null;
}

/**
 * same-sub recovery 请求：base 是客户端实际已应用的 (logEpoch,seq)，null 表示无可用基座；
 * forceSnapshot=true 时无视 base 直接回全量（客户端检测到状态可能损坏/需要重对齐）。
 */
export interface ConversationResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

/**
 * publisher 构造参数：now 是帧 sentAt/时钟估计源；retention 是每 session 保留事件条数
 * （决定 resume 可覆盖区间）；subscriberBufferMaxOps/Bytes 是每订阅者 coalesce 后的双限额，
 * 均被钳位到协议上限。构造后这些值不再变化。
 */
export interface ConversationTopicPublisherOptions {
  /** CLI 时钟（frame.sentAt / clockOffset 估计源）。 */
  now?: () => number;
  /** 事件保留窗（条），默认 PROTOCOL_V4_LIMITS.eventRetentionPerSession。 */
  retention?: number;
  /** 每订阅者 coalesce 后 op 上限；主要用于协议配置与边界测试。 */
  subscriberBufferMaxOps?: number;
  /** 每订阅者 logical deltas payload 的 UTF-8 byte 上限。 */
  subscriberBufferMaxBytes?: number;
}

/**
 * 订阅者缓冲裁决参数：maxOps 是 coalesce 后 op 上限；maxBytes 是逻辑字节下限；
 * snapshotBytesUpperBound 是当前 wire snapshot 的保守上界（缺省 0 = 只按下限）。
 * 三者只影响 buffer 是否 overflow，不改变帧内容。
 */
export interface ConversationSubscriberBufferLimits {
  maxOps?: number;
  /** 字节下限（默认 1MiB）；实际上限见 conversationSubscriberBufferByteLimit。 */
  maxBytes?: number;
  /** 当前 wire snapshot logical frame 的保守上界；缺省 0 = 只按下限裁决。 */
  snapshotBytesUpperBound?: number;
}

/**
 * 投影快照超过 logical frame 上限时抛出的 fail-closed 错误（reasonCode=proto.payloadTooLarge）。
 * 携带测量到的 logicalBytes 供上层记录/告警；不表示数据损坏，也不尝试裁剪后继续发布。
 */
export class ProjectionPayloadTooLargeError extends Error {
  readonly reasonCode = "proto.payloadTooLarge";

  constructor(readonly logicalBytes: number) {
    super(
      `conversation projection exceeds ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
    );
    this.name = "ProjectionPayloadTooLargeError";
  }
}

// 运行中正文必须给 TurnError/TurnComplete 的 bounded terminal patch 留出空间；否则正文
// 恰好占满 16MiB 后，停止 turn 的终态本身也无法进入可传输 snapshot。
export const PROJECTION_TERMINAL_RESERVE_BYTES = 64 * 1024;

// row.actions 的 schema 只有 4 个 true 布尔值和一个短枚举；含 JSON key/父级包装不足
// 128 bytes。批量 checkpoint 之间按 wire tail 的每行完整预留，保证延迟 materialize
// 不会让 payload 上界低估。
const HYDRATION_ACTION_BYTES_PER_WIRE_ROW = 128;
const HYDRATION_EVENT_WIRE_OVERHEAD_BYTES = 64;
// logical snapshot frame 中 sequence number 同时出现在 frame.toSeq 与 snapshot.seq。
const HYDRATION_SEQUENCE_NUMBER_OCCURRENCES = 2;

function hydrationSequenceNumberBytes(sequenceNumber: number): number {
  return String(sequenceNumber).length * HYDRATION_SEQUENCE_NUMBER_OCCURRENCES;
}

/**
 * 追加缓冲的两态结果：buffered = 已合并的 deltas 与 wire 字节数；overflow = 双限额任一超限，
 * 调用方应清空缓冲并转 snapshot 恢复（不得保留部分增量）。
 */
export type ConversationSubscriberBufferResult =
  | {
      kind: "buffered";
      deltas: ConversationDelta[];
      encodedBytes: number;
    }
  | { kind: "overflow" };

function nonNegativeHardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

/**
 * subscriber buffer 的实际字节上限 = min(max(下限, snapshot 上界), 16MiB - 64KiB)（05 §3）。
 * 修复原因：overflow 的意义是用更小的 snapshot 换掉积压 delta；旧实现固定 1MiB，单条大
 * delta（如 3MiB bash 输出的 tool row upsert）就会降级为 snapshot，而 snapshot 因同一行仍在
 * 尾部窗口只会更大，还让客户端整份替换、丢掉已分页的历史行，turn navigator 随即全量重新
 * 分页——长 session 中每轮循环一次。外层钳位给帧外壳留出 assembly 余量，deltas 帧仍 <=16MiB。
 */
// 纯函数；floorBytes/snapshotBytesUpperBound 均由调用方给定，不做最大值之外的额外裁决。
export function conversationSubscriberBufferByteLimit(
  floorBytes: number,
  snapshotBytesUpperBound: number,
): number {
  return Math.min(
    Math.max(floorBytes, snapshotBytesUpperBound),
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES,
  );
}

/**
 * profile filter 后的 delta 进入此纯函数；先与现有 buffer 合并并 coalesce，
 * 再按 op/UTF-8 bytes 双限额裁决——限额必须真正执行，只存裸 delta[] 不裁决的话，
 * 慢订阅者会持续堆积并最终生成不可控的大帧。
 */
// 输入 current/incoming 均不被修改；输出 buffered 携带 coalesce 后 deltas 与 wire 字节数，
// overflow 表示调用方必须清缓冲并标记 resyncRequired（不保留半截增量）。
// 限额先钳位到协议上限，再与快照上界取大，避免“单条大 delta 反而导致更大的 snapshot”。
export function appendConversationSubscriberBuffer(
  current: readonly ConversationDelta[],
  incoming: readonly ConversationDelta[],
  limits: ConversationSubscriberBufferLimits = {},
): ConversationSubscriberBufferResult {
  const maxOps = nonNegativeHardBound(
    limits.maxOps,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
    "maxOps",
  );
  const maxBytes = nonNegativeHardBound(
    limits.maxBytes,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    "maxBytes",
  );
  const byteLimit = conversationSubscriberBufferByteLimit(
    maxBytes,
    limits.snapshotBytesUpperBound ?? 0,
  );
  const deltas = coalesceConversationDeltas([...current, ...incoming]);
  if (deltas.length > maxOps) return { kind: "overflow" };
  const encodedBytes = utf8JsonByteLength({ kind: "deltas", deltas });
  if (encodedBytes > byteLimit) return { kind: "overflow" };
  return { kind: "buffered", deltas, encodedBytes };
}

/**
 * 单个 conversation topic 的权威发布器：持有投影、有界 delta 日志、订阅者与帧记账。
 *
 * 输入：live SessionEvent（ingest/rehydrate）、订阅/恢复请求、宿主 flush 驱动。
 * 输出：snapshot 或 deltas 帧 reservation；快照只含尾部窗口，历史分页走 rows/range。
 * 副作用：仅内存（projection/log/buffer），不做网络 IO、不落盘、不启定时器；flush 时机由宿主决定。
 * 失败与降级：投影超限抛 ProjectionPayloadTooLargeError（fail-closed）；订阅者缓冲溢出不积压，
 * 标记 resyncRequired 后下一帧回 snapshot；重放窗不足/断档/跨 epoch 一律 snapshot。
 * 不变量：seq 单调；每订阅只保留一个 inFlight 逻辑帧，commit 后才推进 sentSeq；重订阅替换旧代际。
 */
export class ConversationTopicPublisher {
  readonly topic: string;
  private projection: ProductProjection;
  private readonly now: () => number;
  private readonly retention: number;
  private readonly subscriberBufferMaxOps: number;
  private readonly subscriberBufferMaxBytes: number;
  /** 有界日志：seq 升序；resume 只在 (floorSeq, currentSeq] 内合法。 */
  private readonly log: LogEntry[] = [];
  /** 保留窗下界：base.seq < floorSeq 的恢复请求已无法无损续传 → 只能 snapshot。 */
  private floorSeq = 0;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscriptionIdByConnection = new Map<string, string>();
  private nextSubscriptionSerial = 1;
  private nextLogicalFrameSerial = 1;
  /** 当前 snapshot logical frame 的保守上界；流式追加只累计增量，逼近上限才精确序列化。 */
  private wireSnapshotBytesUpperBound: number;

  /**
   * 初始化 topic 权威：空投影、空日志、seq=0，并按当前 wire snapshot 预算初始保守上界。
   * sessionId/logEpoch 一经构造不可变；options 只影响时钟、保留窗与订阅者限额。
   * 构造阶段会精确测量一次快照（唯一一次全量序列化）。
   */
  constructor(
    private readonly sessionId: string,
    private readonly logEpoch: string,
    options: ConversationTopicPublisherOptions = {},
  ) {
    this.topic = `conversation/${sessionId}`;
    this.projection = new ProductProjection(sessionId, logEpoch);
    this.now = options.now ?? Date.now;
    this.retention = options.retention ?? PROTOCOL_V4_LIMITS.eventRetentionPerSession;
    this.subscriberBufferMaxOps = nonNegativeHardBound(
      options.subscriberBufferMaxOps,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
      "subscriberBufferMaxOps",
    );
    this.subscriberBufferMaxBytes = nonNegativeHardBound(
      options.subscriberBufferMaxBytes,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
      "subscriberBufferMaxBytes",
    );
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /**
   * 返回投影内部的全量快照（只读产物，调用方不得原地修改）。
   * 与 wire snapshot 不同：这里 rows 不被 tail window 截断，seq/revision 是权威水位。
   */
  getSnapshot(): ConversationSnapshot {
    return this.projection.getSnapshot();
  }

  /** 初始化只变化几次，沿既有 snapshot 恢复边界发布，不引入第二份事件流。 */
  // 副作用：更新投影 + 重算 wire 上界 + 记一条 state.updated delta 并扇出到订阅者；
  // seq 由投影推进（不复用事件序号），delta 表达的是整份控制态 patch，避免遗漏子字段。
  setRuntimeInitialization(
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
  ): void {
    this.projection.setRuntimeInitialization(state);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
    this.appendDeltas(this.currentSeq, [
      { op: "state.updated", patch: statePatchSchema.parse(this.getSnapshot()) },
    ]);
  }

  /**
   * 精确测量当前 wire snapshot 的 logical TopicFrame 字节数（含帧外壳，不是裸 snapshot）。
   * 测试/闸门共用口径；只读、无副作用，每次调用都会完整序列化一次。
   */
  /** 测试/闸门共用的 logical TopicFrame 字节口径（不是裸 snapshot 大小）。 */
  getWireSnapshotLogicalBytes(): number {
    return this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /**
   * 把 rowId 解析为稳定 fork 候选（委托投影）；只读判定，不修改任何状态。
   * 返回是否可 fork 及锚点信息，失败候选由调用方转为用户可见错误。
   */
  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    return this.projection.resolveStableForkCandidate(rowId);
  }

  /** config 种子注入：直改投影初值，不产 delta / 不进事件日志。语义见 ProductProjection.seedConfig。 */
  // 用于 cold hydration 前补齐 config 初值；必须重算 wire 上界，避免后续闸门低估快照大小。
  seedConfig(seed: SessionConfigSeed): void {
    this.projection.seedConfig(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** 分享导入提示是静态只读元数据，不进入 delta/revision；可在 hydration 后幂等补种。 */
  // 仅当值真实变化时投影才更新；本方法总是重算 wire 上界，因此可安全重复调用。
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    this.projection.seedSharedContextImport(source);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** usage 种子注入：冷恢复用持久化 token 水位覆盖 transcript 合成的 0 占位。 */
  // 不产 delta、不推进 seq；只影响后续 snapshot/delta 中的 usage 字段与 wire 上界。
  seedUsage(seed: SessionUsageSeed): void {
    this.projection.seedUsage(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** cold hydration 的 store-verified subagent manifest，不产 delta。 */
  // 只补投影初值并重算 wire 上界；manifest 变化不会以 delta 形式广播，后续靠 snapshot 对齐。
  seedSubagents(seed: SessionSubagentsSeed): void {
    this.projection.seedSubagents(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /**
   * 下发用快照：rows 只带尾部窗口（snapshotTailWindowRows），
   * totalCount/firstRowId 保留全序口径——客户端以 `window[0].rowId === firstRowId`
   * 判定已到顶，更早历史经 rows/range 游标拉取。投影内部快照保持全量
   * （rows/range 数据源 + findRow/messageId 锚点都依赖它），只在打帧边界截断。
   */
  /**
   * 下发用快照（continuous profile）：rows 只带尾部窗口，totalCount/firstRowId 保留全序口径。
   * 私有语义：投影内部快照仍全量（rows/range 与锚点查询都依赖它），只在打帧边界截断。
   * 只读；结果对象是浅拷贝，不修改投影。
   */
  private getWireSnapshot(snapshot = this.projection.getSnapshot()): ConversationSnapshot {
    return this.getWireSnapshotForProfile(DELIVERY_PROFILES.continuous, snapshot);
  }

  /**
   * 按 deliveryProfile 过滤行可见性，再裁到 snapshotTailWindowRows。
   * 先过滤后统计 totalCount/firstRowId，保证客户端以 window[0] 判断“已到顶”与 profile 口径一致；
   * 只做对象浅拷贝与数组切片，无副作用。
   */
  private getWireSnapshotForProfile(
    profile: DeliveryProfile,
    snapshot = this.projection.getSnapshot(),
  ): ConversationSnapshot {
    const visibleRows = filterConversationRowsForProfile(snapshot.rows.window, profile);
    const visibleSnapshot: ConversationSnapshot = {
      ...snapshot,
      rows: {
        ...snapshot.rows,
        window: visibleRows,
        totalCount: visibleRows.length,
        firstRowId: visibleRows[0]?.rowId ?? null,
      },
    };
    const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
    if (visibleRows.length <= limit) return visibleSnapshot;
    return {
      ...visibleSnapshot,
      rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-limit) },
    };
  }

  /**
   * 一个订阅者的快照帧：profile 决定行可见性，能力位决定 `workflowRuns` 发全量还是旧界。
   *
   * 快照与增量必须同一档：一个收着旧界整键 patch 的客户端，如果快照里突然来了 512 个节点，
   * 它的 `.max(256)` 会让**整帧**解析失败（已知键上的解析错误不会只剥掉一个键）。
   */
  /**
   * 一个订阅者的快照帧：profile 决定行可见性，能力位决定 workflowRuns 发全量还是旧界。
   * 旧消费者（workflowRunDeltas=false）必须同时裁快照与增量，否则整帧 schema 解析失败。
   * 只读投影；仅在需要裁剪时才创建新 snapshot 对象。
   */
  private getWireSnapshotForSubscription(subscription: Subscription): ConversationSnapshot {
    const snapshot = this.getWireSnapshotForProfile(subscription.profile);
    if (subscription.workflowRunDeltas || snapshot.workflowRuns === undefined) return snapshot;
    const workflowRuns = clampWorkflowRunsForLegacy(snapshot.workflowRuns);
    return workflowRuns === snapshot.workflowRuns ? snapshot : { ...snapshot, workflowRuns };
  }

  /**
   * 一批 delta 的**每订阅者**编码：profile 过滤 + 旧消费者的整键折叠。
   *
   * 折叠取的是**当前**投影状态，所以恢复回放上历史增量会折成终态——中间态被跳过，终态一致，
   * 与 coalesce 的既有行为同规（conversation-workflow-run-deltas.ts 的文件头）。
   */
  /**
   * 一批 delta 的每订阅者编码：profile 过滤 + 旧消费者的整键折叠。
   * 折叠取当前投影状态（不是历史中间态），因此在恢复回放时历史增量会折成终态，与 coalesce 同规。
   * 纯函数式处理入参；返回只读列表，不修改订阅者 buffer（调用方决定合并/溢出）。
   */
  private encodeDeltasForSubscription(
    deltas: readonly ConversationDelta[],
    subscription: Subscription,
  ): readonly ConversationDelta[] {
    const filtered = filterConversationDeltasForProfile(deltas, subscription.profile);
    if (subscription.workflowRunDeltas) return filtered;
    return encodeConversationDeltasForLegacy(filtered, this.projection.getSnapshot().workflowRuns);
  }

  /**
   * 输入 admission 的候选 projection：用完整 QueueItem 表达同一份 intent，覆盖文本与附件引用。
   * QueueItem 元数据不小于立即启动后的 user row，因此通过此闸门的输入不会在后续首次
   * snapshot 才变成不可传输。此方法只读，不写 admission / event log。
   */
  /**
   * 输入 admission 的候选 projection 字节测量：把待准入输入按 QueueItem 形态并入快照再测。
   *
   * 输入：命令信封 + admission 坐标；只接受 createSession/sendText/sendGoalCommand/compact，
   * 其它命令返回 null（不参与该闸门）。
   * 输出：候选 logical frame 字节数或 null；只读，不写 admission/事件日志/投影。
   * 口径：QueueItem 元数据不小于立即启动后的 user row，因此通过闸门的输入不会在首次 snapshot
   * 时才变成不可传输；这是“准入前可传输性”的保守上界。
   */
  measureInputAdmissionProjectionBytes(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): number | null {
    const raw = envelope.payload as {
      text?: string;
      displayText?: string;
      attachments?: QueueItem["attachments"];
      firstInput?: { text: string; attachments?: QueueItem["attachments"] };
    };
    const input = envelope.type === "createSession" ? raw.firstInput : raw;
    if (
      !input ||
      (envelope.type !== "createSession" &&
        envelope.type !== "sendText" &&
        envelope.type !== "sendGoalCommand" &&
        envelope.type !== "compact")
    ) {
      return null;
    }
    const snapshot = this.projection.getSnapshot();
    const queueItem: QueueItem = {
      sourceCommandId: envelope.commandId,
      queueItemId: admission.queueItemId,
      clientId: envelope.clientId || "cli",
      kind:
        envelope.type === "compact"
          ? "compact"
          : envelope.type === "sendGoalCommand"
            ? "sendGoalCommand"
            : "sendText",
      text:
        envelope.type === "compact"
          ? "/compact"
          : envelope.type === "sendGoalCommand"
            ? raw.displayText?.trim() || `/goal ${(input.text ?? "").trim()}`
            : (input.text ?? ""),
      attachments: input.attachments ?? [],
      delivery: { requested: "queue", admitted: "queue" },
      order: {
        admissionSeq: admission.admissionSeq,
        queuePosition: snapshot.queue.items.length,
      },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: admission.admittedAt,
    };
    const candidate: ConversationSnapshot = {
      ...snapshot,
      queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
    };
    return this.measureWireSnapshotBytes(this.getWireSnapshot(candidate));
  }

  /**
   * 用“最长常规表示”的帧外壳测量快照 logical 字节：subscriptionId/时间/seq 都取可产生的最大值，
   * 避免只算 payload 导致上界偏低。
   * 纯测量、无副作用；只序列化传入的 snapshot，不触发投影变更。
   */
  private measureWireSnapshotBytes(snapshot: ConversationSnapshot): number {
    // subscriptionId/时间/seq 使用本 publisher 可产生的最长常规表示，确保测量不是只算 payload。
    const frame: ConversationTopicFrame = {
      topic: this.topic,
      subscriptionId: `sub-${this.logEpoch}-${Number.MAX_SAFE_INTEGER}`,
      fromSeq: 0,
      toSeq: snapshot.seq,
      sentAt: Number.MAX_SAFE_INTEGER,
      payload: { kind: "snapshot", snapshot },
    };
    return utf8JsonByteLength(frame);
  }

  /**
   * rows/range（游标制）：取 rowId < beforeRowId 的最后 limit 行
   * （rowId 升序返回）。数据源 = 投影全量行（事件重放/transcript hydration 已灌入），
   * 与订阅流出自同一归约，天然满足「与全量重放前缀逐字节一致」。
   * 只读、无状态、超时重发安全；atLogEpoch 供客户端陈旧读整体丢弃。
   */
  getRowsRange(
    params: { beforeRowId?: number; limit: number },
    deliveryProfile: DeliveryProfileName = "replayable",
  ): V4ConversationRowsRangeResult {
    const snapshot = this.projection.getSnapshot();
    const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
    const visibleRows = filterConversationRowsForProfile(
      snapshot.rows.window,
      DELIVERY_PROFILES[deliveryProfile],
    );
    const eligible =
      params.beforeRowId === undefined
        ? visibleRows
        : visibleRows.filter((row) => row.rowId < (params.beforeRowId as number));
    const rows = eligible.slice(-limit);
    return {
      rows,
      atSeq: snapshot.seq,
      atRevision: snapshot.revision,
      atLogEpoch: this.logEpoch,
      hasMore: eligible.length > rows.length,
    };
  }

  /**
   * 返回当前有效分支里的完整终态计划目录。
   * wire snapshot 只保留 tail window；renderer 扫描可见 rows 会漏掉早期计划，
   * edit/retry 后还可能保留已经被权威 projection 裁掉的旧目录项。
   */
  getPlans(): V4ConversationPlansResult {
    const snapshot = this.projection.getSnapshot();
    const plans = snapshot.rows.window
      .filter(
        (row): row is ToolCallRow =>
          row.kind === "toolCall" &&
          row.toolName === "ExitPlanMode" &&
          TERMINAL_PLAN_STATUSES.has(row.status) &&
          hasPlanMarkdown(row),
      )
      .toSorted((left, right) => right.rowId - left.rowId);
    return {
      plans,
      atSeq: snapshot.seq,
      atLogEpoch: this.logEpoch,
    };
  }

  /** rowId → 权威 messageId（forkAssistant/editUserQuery 桥接翻译）。 */
  // 只读查询；找不到返回 null，由调用方决定是否报 proto.staleTarget 一类错误。
  getMessageIdForRow(rowId: number): string | null {
    return this.projection.getMessageIdForRow(rowId);
  }

  /**
   * 解析行操作（edit/retry/fork 等）的权威目标：把客户端 rowId 翻译成投影内稳定锚点。
   * 只读判定；不可操作时返回失败原因，不修改投影、不产生 delta。
   */
  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    return this.projection.resolveRowActionTarget(target, action);
  }

  /** rowId → 同一 product turn 内所有 transcript messageId。 */
  // 只读；用于 edit/retry 时把整轮消息找回，缺失返回空数组而不是抛错。
  getMessageIdsForTurnRow(rowId: number): string[] {
    return this.projection.getMessageIdsForTurnRow(rowId);
  }

  /** fork 目标必须是所属轮最后一段 assistantText。 */
  // 只读判定；用于拒绝“fork 到中间段”导致的分支语义不完整。
  isLatestAssistantSegmentRow(rowId: number): boolean {
    return this.projection.isLatestAssistantSegmentRow(rowId);
  }

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
  // 只读；不满足时返回 false，由命令层给出用户可见的原因。
  isLatestRetryAssistantRow(rowId: number): boolean {
    return this.projection.isLatestRetryAssistantRow(rowId);
  }

  /** latestQueryEditOnly：只有最后一轮 realUser userInput row 可 edit。 */
  // 只读判定；编辑更早轮次会改变后续历史语义，因此这里严格限定最新一轮。
  isLatestEditableUserRow(rowId: number): boolean {
    return this.projection.isLatestEditableUserRow(rowId);
  }

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
  // 只读；找不到返回 null，调用方不得用 rowId 猜 turn 归属。
  getTurnIdForRow(rowId: number): string | null {
    return this.projection.getTurnIdForRow(rowId);
  }

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段）。 */
  // 只读诊断计数；不改变投影，也不因计数 >0 自动触发修复或重放。
  getDroppedContentStreamEventCount(): number {
    return this.projection.getDroppedContentStreamEventCount();
  }

  /** rowId → 其 turn 的 rewind 锚点 messageId（editUserQuery user 行定位）。 */
  // 只读；没有 rewind 锚点时返回 null，调用方应拒绝该编辑而不是回退到更早轮次。
  getTurnRewindAnchor(rowId: number): string | null {
    return this.projection.getTurnRewindAnchor(rowId);
  }

  /** 当前权威记账水位（投影 snapshot.seq）；所有帧的 toSeq 都以它为上限。 */
  private get currentSeq(): number {
    return this.projection.getSnapshot().seq;
  }

  /** 应用权威事件：投影推进 + 日志记账 + 扇出到各订阅者 flush buffer。 */
  // 输入必须是 store 已持久化的既有事件（live 与 rehydrate 都走这里，保证同源归约）。
  // 副作用：只在内存追加 deltaLog/projection；不 flush、不发送帧，flush 由宿主显式驱动。
  // 返回是否产生变化（false 表示事件被投影判为 no-op，不推进 seq、不污染重放窗）。
  ingest(event: SessionEvent): void {
    const projectionLimit =
      event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
        ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
        : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
    const streamingAppend = this.projection.establishedStreamingAppend(event);
    const streamingUpperBound =
      streamingAppend === null ? null : utf8JsonByteLength(streamingAppend) + 64;
    let deltas: ConversationDelta[] | null;
    if (
      streamingUpperBound !== null &&
      this.wireSnapshotBytesUpperBound + streamingUpperBound <= projectionLimit
    ) {
      deltas = this.projection.applyEvent(event);
      this.wireSnapshotBytesUpperBound += streamingUpperBound;
    } else {
      let candidateBytes = 0;
      let nextUpperBound = 0;
      deltas = this.projection.applyEventAtomically(event, (snapshot, produced) => {
        // dwf 快路径：这条事件只产键级增量时，它们的字节数就是快照增长的上界（一条 upsert
        // 最多把自己那点内容加进去，removed 只会让快照变小），不必把整份快照再序列化一遍
        // ——那一次 JSON.stringify 是每条引擎事件都要付的 MB 级开销，也是这次改造的另一半。
        // 判据用的是**实际产出**而不是预演，所以 diff 退化出的整键 patch 自然落回精确路径。
        const growth = workflowRunDeltaGrowthUpperBound(produced);
        if (growth !== null && this.wireSnapshotBytesUpperBound + growth <= projectionLimit) {
          nextUpperBound = this.wireSnapshotBytesUpperBound + growth;
          return true;
        }
        candidateBytes = this.measureWireSnapshotBytes(this.getWireSnapshot(snapshot));
        nextUpperBound = candidateBytes;
        return candidateBytes <= projectionLimit;
      });
      if (deltas === null) throw new ProjectionPayloadTooLargeError(candidateBytes);
      this.wireSnapshotBytesUpperBound = nextUpperBound;
    }
    this.appendDeltas(event.sequenceNumber, deltas);
  }

  /**
   * 记录一批已归属某个 seq 的 delta，并向所有订阅者扇出。
   *
   * 口径：log 每条含完整 delta 列表（batch），seq 来自投影事件号；超 retention 淘汰最旧并推进
   * floorSeq（resume 起点低于 floorSeq 即断档）。deltas 为空只记账不扇出。
   * 背压：每订阅者先按 profile/能力位编码再 coalesce；溢出时丢弃其 pending、置 resyncRequired，
   * 不阻塞其他订阅者，也不回滚已记账数据。
   */
  private appendDeltas(seq: number, deltas: ConversationDelta[]): void {
    this.log.push({ seq, deltas });
    while (this.log.length > this.retention) {
      const evicted = this.log.shift();
      if (evicted) this.floorSeq = evicted.seq;
    }
    if (deltas.length === 0) return;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.resyncRequired) continue;
      const filtered = this.encodeDeltasForSubscription(deltas, subscription);
      const next = appendConversationSubscriberBuffer(
        subscription.buffer,
        filtered,
        this.subscriberBufferLimits(),
      );
      if (next.kind === "overflow") {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
        continue;
      }
      subscription.buffer = next.deltas;
      subscription.bufferBytes = next.encodedBytes;
    }
  }

  /**
   * 在现有 publisher 内重物化 projection，保留 connection-owned subscriptions。
   *
   * gateway 过去 delete publisher 后新建实例，projection 虽恢复了，旧实例
   * 的 subscription registry / ownership / in-flight reservation 却一起丢失。重物化属于
   * 同一 topic authority 的状态替换，只应让既有订阅 resync，不应换 publisher 身份。
   */
  // 失败不落地：候选 publisher 不承接订阅，完整 replay（含逻辑大小校验）成功后才 adopt；
  // 任一步抛错则当前 projection/log/订阅缓冲保持原样（strict fallback 只影响候选）。
  // 成功后所有既有订阅 buffer 清空、sentSeq=0、inFlight 作废，强制下一次 flush 回 snapshot。
  // 已发布 runtimeInitialization 时用 seq+1/revision+1 承接，禁止同一 epoch 倒退。
  rehydrate(
    events: readonly SessionEvent[],
    options: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void } = {},
  ): void {
    // 重放不能先清空当前 projection/log/subscription delivery，再逐条 replay：
    // 任一普通 reducer 异常都会把 topic 留在半重放状态。候选 publisher 不承接订阅，
    // 完整 replay（含 logical size 校验）成功后才一次 adopt 权威数据面。
    let candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
      now: this.now,
      retention: this.retention,
      subscriberBufferMaxOps: this.subscriberBufferMaxOps,
      subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
    });
    const usedBatchHydration = candidate.tryBatchHydration(events);
    if (!usedBatchHydration) {
      // 保守上界超限不代表权威 projection 一定超限；重新从空候选走原逐事件原子
      // admission，保留 16MiB fail-closed 与“拒绝单个 oversize 后继续终态”的旧语义。
      candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
        now: this.now,
        retention: this.retention,
        subscriberBufferMaxOps: this.subscriberBufferMaxOps,
        subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
      });
      for (const event of events) {
        try {
          candidate.ingest(event);
        } catch (error) {
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          if (!options.onPayloadTooLarge) throw error;
          options.onPayloadTooLarge(error);
        }
      }
    }

    const previous = this.projection.getSnapshot();
    if (previous.runtimeInitialization) {
      // 首帧已对外发布，最终恢复不得让同一 epoch 的 seq/revision 倒退。
      candidate.projection.setRuntimeInitialization(
        previous.runtimeInitialization,
        previous.seq + 1,
        previous.revision + 1,
      );
    }
    this.projection = candidate.projection;
    const current = this.getSnapshot();
    if (
      previous.runtimeInitialization &&
      previous.rows.window.length === current.rows.window.length &&
      previous.rows.window.every(
        (row, index) =>
          row.rowId === current.rows.window[index]?.rowId &&
          row.kind === current.rows.window[index]?.kind,
      )
    ) {
      // 正常初始化只补控制/摘要，不能用尾窗 snapshot 丢掉用户已分页读出的历史与滚动锚点。
      // 真正改变历史结构（如 compact 修复）仍走既有完整 snapshot 边界。
      const deltas: ConversationDelta[] = [
        { op: "state.updated", patch: statePatchSchema.parse(current) },
      ];
      current.rows.window.forEach((row, index) => {
        if (JSON.stringify(row) !== JSON.stringify(previous.rows.window[index]))
          deltas.push({ op: "row.upserted", row });
      });
      this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
      this.appendDeltas(current.seq, deltas);
      return;
    }

    if (usedBatchHydration || previous.runtimeInitialization) {
      // 批量重放会把派生 actions 延迟到最终 materialization；若允许客户端
      // 用逐事件旧快照的中间 base 续这份日志，batch 从未持有的旧 canEdit/canRetry 无法被
      // 定点撤销。rehydrate 本来就要求所有现有订阅 resync，因此在当前 seq 建立 snapshot
      // recovery boundary；此后新事件仍从该水位正常 resume，不改变 replayable 恢复语义。
      this.log.splice(0, this.log.length);
      this.floorSeq = candidate.currentSeq;
    } else {
      // strict fallback 没有延迟 materialization，完整保留原有 retained-log 恢复语义。
      this.log.splice(0, this.log.length, ...candidate.log);
      this.floorSeq = candidate.floorSeq;
    }
    this.wireSnapshotBytesUpperBound = candidate.wireSnapshotBytesUpperBound;
    for (const subscription of this.subscriptions.values()) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      subscription.sentSeq = 0;
      // adopt 后旧 projection 上预留的帧不可再 commit；失败 replay 从未触碰该 reservation。
      subscription.inFlight = null;
    }
  }

  /**
   * 冷恢复快路径：只修改尚未发布的 candidate。协议 wire snapshot 固定只含末尾 60 行，
   * 因此 row 更新只累计仍在 tail 的 delta，再给尚未 materialize 的 actions 按行预留
   * 完整 schema 上界；已滑出 tail 的保守增长在触及 payload limit 时通过精确测量消除。
   * 最终只做一次全行 actions 收敛，整体成本随事件/行数线性增长。
   */
  // 返回 false = 保守上界证明超限，调用方改用逐事件原子路径（不是数据错误）。
  // 只改传入的 candidate（其 projection/log 尚未发布），不触碰现有订阅或权威状态。
  // 中途超限立即返回，不留下半重放：candidate 会被调用方丢弃并重建。
  private tryBatchHydration(events: readonly SessionEvent[]): boolean {
    this.projection.beginHydrationReplay();
    let measuredBytes = this.wireSnapshotBytesUpperBound;
    let measuredSequenceNumberBytes = hydrationSequenceNumberBytes(
      this.projection.getSnapshot().seq,
    );
    let encodedGrowthSinceMeasurement = 0;

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const deltas = this.projection.applyHydrationEvent(event);
      const finalEvent = index === events.length - 1;
      const projectionLimit = this.projectionLimitForEvent(event);
      const mustMeasureSnapshot = finalEvent || deltas.some((delta) => delta.op === "row.removed");

      if (finalEvent) this.projection.completeHydrationReplay();
      const snapshot = this.projection.getSnapshot();
      if (!mustMeasureSnapshot && deltas.length > 0) {
        let wireRowIds: Set<number> | undefined;
        const wireDeltas = deltas.filter((delta) => {
          if (delta.op === "state.updated" || delta.op === "row.appended") return true;
          if (delta.op === "row.removed") return false;
          // 4b-2：插件资源通知只走实时增量，不进冷启动测量。
          if (
            delta.op === "pluginUi.resourceUpdated" ||
            delta.op === "pluginUi.resourceListChanged" ||
            delta.op === "pluginUi.appToolCall" ||
            delta.op === "pluginUi.instanceClosed"
          )
            return false;
          // 键级增量作用在状态键上，不在 60 行 wire tail 里——没有「已滑出窗口所以不计」这一说，
          // 与 state.updated 同规一律计入。
          if (delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed") return true;
          wireRowIds ??= new Set(
            snapshot.rows.window
              .slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
              .map((row) => row.rowId),
          );
          const rowId = delta.op === "row.upserted" ? delta.row.rowId : delta.rowId;
          return wireRowIds.has(rowId);
        });
        if (wireDeltas.length > 0) {
          encodedGrowthSinceMeasurement +=
            coldHydrationJsonByteLength({ kind: "deltas", deltas: wireDeltas }) +
            HYDRATION_EVENT_WIRE_OVERHEAD_BYTES;
        }
      }

      const actionBytesUpperBound = finalEvent
        ? 0
        : Math.min(snapshot.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows) *
          HYDRATION_ACTION_BYTES_PER_WIRE_ROW;
      const currentSequenceNumberBytes = hydrationSequenceNumberBytes(snapshot.seq);
      const sequenceNumberGrowth = Math.max(
        0,
        currentSequenceNumberBytes - measuredSequenceNumberBytes,
      );
      let upperBound =
        measuredBytes +
        encodedGrowthSinceMeasurement +
        sequenceNumberGrowth +
        actionBytesUpperBound;
      if (mustMeasureSnapshot || upperBound > projectionLimit) {
        // 保守 delta 累计值一旦超限就直接回退 strict 的话，重复 upsert
        // 即使未增大 snapshot 也会误回退；固定 32-event 重测还会反复序列化 checkpoint。
        measuredBytes = this.measureWireSnapshotBytes(this.getWireSnapshot());
        measuredSequenceNumberBytes = currentSequenceNumberBytes;
        encodedGrowthSinceMeasurement = 0;
        upperBound = measuredBytes + actionBytesUpperBound;
      }
      if (upperBound > projectionLimit) return false;
    }

    if (events.length === 0) {
      this.projection.completeHydrationReplay();
      measuredBytes = this.measureWireSnapshotBytes(this.getWireSnapshot());
    }
    this.wireSnapshotBytesUpperBound = measuredBytes;
    return true;
  }

  /**
   * 事件级 projection 上限：turn 终态给完整 logicalFrameAssemblyMaxBytes，
   * 其它事件预留 PROJECTION_TERMINAL_RESERVE_BYTES，保证“终态事件写入后仍不超帧上限”。
   * 纯查表，不测量、不修改状态。
   */
  private projectionLimitForEvent(event: SessionEvent): number {
    return event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
      ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
  }

  /**
   * 订阅裁决：base.logEpoch 匹配且 base.seq 在保留窗内 → resume，
   * 否则 snapshot。同 connectionId 重订阅 = 替换旧订阅并清其 flush buffer。
   */
  // 便捷入口：subscribeReserved 后立即 commit 首帧（等价本地 transport 已接受）；
  // 生产 gateway 必须改用 subscribeReserved，等物理批次全接受再 commit。
  // base.seq==当前水位时不产帧，但仍返回新订阅身份；旧订阅 buffer 直接丢弃。
  subscribe(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const result = this.subscribeReserved(params);
    result.reservation?.commit();
    return result;
  }

  /** 生产 gateway 入口：初始帧也必须等 physical batch 全接受才 commit。 */
  /**
   * 生产订阅入口：先替换同连接旧订阅并预留首帧，由调用方在物理投递成功后 commit。
   *
   * 裁决：base.logEpoch 必须匹配本代际且 canResumeFrom(base.seq) 才 resume，否则 snapshot；
   * base.seq==currentSeq 时不产帧。deliveryProfile 决定本订阅行可见性，workflowRunDeltas 决定
   * 是否按旧消费者折整键 patch（可信 host 注入，缺省 false）。
   * rollback：仅当首帧仍在途且订阅身份未变时恢复旧订阅（含旧 sentSeq/inFlight），否则 false。
   */
  subscribeReserved(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const previousId = this.subscriptionIdByConnection.get(params.connectionId);
    const previousSubscription =
      previousId === undefined ? undefined : this.subscriptions.get(previousId);
    if (previousId !== undefined) this.subscriptions.delete(previousId);

    const profile = DELIVERY_PROFILES[params.deliveryProfile ?? "replayable"];
    const subscription: Subscription = {
      subscriptionId: `sub-${this.logEpoch}-${this.nextSubscriptionSerial++}`,
      connectionId: params.connectionId,
      profile,
      workflowRunDeltas: params.workflowRunDeltas === true,
      buffer: [],
      bufferBytes: 0,
      resyncRequired: false,
      sentSeq: 0,
      inFlight: null,
      nextLogicalFrameOrdinal: 1,
    };
    this.subscriptions.set(subscription.subscriptionId, subscription);
    this.subscriptionIdByConnection.set(params.connectionId, subscription.subscriptionId);
    const rollback = (): boolean => {
      // initial reservation commit 后 replacement 已 admission，禁止迟到 rollback。
      if (
        subscription.inFlight === null ||
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        this.subscriptionIdByConnection.get(params.connectionId) !== subscription.subscriptionId
      ) {
        return false;
      }
      this.subscriptions.delete(subscription.subscriptionId);
      if (previousId !== undefined && previousSubscription) {
        this.subscriptions.set(previousId, previousSubscription);
        this.subscriptionIdByConnection.set(params.connectionId, previousId);
      } else {
        this.subscriptionIdByConnection.delete(params.connectionId);
      }
      return true;
    };

    const base = params.base;
    const resumable =
      base !== undefined &&
      base.logEpoch === this.logEpoch &&
      base.seq >= this.floorSeq &&
      base.seq <= this.currentSeq;

    if (!resumable) {
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        false,
        "initial",
      );
      return this.subscribeResult(this.ackFor(subscription, "snapshot"), reservation, rollback);
    }

    // resume：保留窗内 (base.seq, current] 重放，与在线续流同一条 filter→编码→coalesce 管线。
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(
        this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
        subscription,
      ),
    );
    if (base.seq === this.currentSeq) {
      subscription.sentSeq = base.seq;
      return this.subscribeResult(this.ackFor(subscription, "resume"), null, () => false);
    }
    subscription.sentSeq = base.seq;
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.currentSeq,
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "initial",
    );
    return this.subscribeResult(this.ackFor(subscription, "resume"), reservation, rollback);
  }

  /**
   * 取消订阅并清理 connection→subscription 归属；传 connectionId 时校验归属，防跨连接误删。
   * 只清 registry/buffer/inFlight 引用，不发送帧；已在途的 reservation commit 会因身份失配返回 false。
   */
  unsubscribe(subscriptionId: string, connectionId?: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (connectionId !== undefined && subscription.connectionId !== connectionId) {
      return;
    }
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
      this.subscriptionIdByConnection.delete(subscription.connectionId);
    }
  }

  /**
   * 订阅是否存在；传 connectionId 时同时校验归属。
   * 只读查询，供 gateway 路由/dispose 时确认帧落点。
   */
  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return Boolean(
      subscription && (connectionId === undefined || subscription.connectionId === connectionId),
    );
  }

  /** Resident 回收判定：仍有任一订阅者时该会话不可被去激活。 */
  /**
   * 是否仍有订阅者。Resident 回收/工作区去激活据此判断 publisher 可否释放；
   * 只读、无副作用。
   */
  hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  /**
   * 反查订阅所属 connectionId；不存在返回 null。
   * 只用于帧路由，不校验权限（鉴权在 host/connection 层完成）。
   */
  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
  }

  /**
   * 排空一个订阅者的 flush buffer 打成一帧（宿主按 flushWindowMs 驱动）。
   * 无新内容返回 null；帧区间 (sentSeq, currentSeq] 覆盖中途被过滤掉的 seq，
   * 保证客户端 `frame.fromSeq === store.seq` 的连续性判定不受 profile 过滤影响。
   */
  /**
   * 为订阅预留下一帧：已有在途帧则复用（保持逻辑帧顺序）；已对齐水位返回 null；
   * 否则按 deltaLog 生成 (sentSeq,currentSeq] 的 deltas 帧，断档/超限时退化为 snapshot。
   * resyncRequired 的订阅在此直接回 snapshot 并清除标记。
   * 只读订阅状态，不 commit、不推进 sentSeq；重复调用无新 delta 时稳定返回同一 reservation。
   */
  reserveFlush(subscriptionId: string): TopicFrameReservation<ConversationTopicFrame> | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    if (subscription.inFlight) return subscription.inFlight;
    if (subscription.resyncRequired) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      return this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        true,
        "online",
      );
    }
    if (subscription.buffer.length === 0 && subscription.sentSeq === this.currentSeq) {
      return null;
    }
    const deltas = subscription.buffer;
    const frame: ConversationTopicFrame = {
      ...this.frameShell(subscription),
      fromSeq: subscription.sentSeq,
      toSeq: this.currentSeq,
      payload: { kind: "deltas", deltas },
    };
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    return this.reserveFrame(subscription, frame, false, "online");
  }

  /** 旧单测便利面；生产 gateway 必须 reserve 后在 emit-all 成功才 commit。 */
  // 便捷入口：reserveFlush 后立即 commit；commit 失败（订阅被替换/删除）时返回 null，不抛错。
  flush(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.reserveFlush(subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * 活跃订阅 same-sub 恢复：客户端 base 是唯一恢复起点，不能拿 sentSeq
   * 猜客户端已应用到哪里。新 recovery admission 会作废旧 reservation；迟到 commit
   * 因 inFlight 身份不再匹配而返回 false。
   */
  // 恢复前先作废在途首帧并清 pending；rollback 只能回到 recovery 开始前的 sentSeq/buffer。
  // base.seq 已对齐当前水位时仍发空 deltas 帧，明确告诉客户端无需追赶。
  resyncReserved(
    subscriptionId: string,
    request: ConversationResyncRequest,
  ): ConversationSubscribeResult | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;

    const previous = {
      buffer: subscription.buffer,
      bufferBytes: subscription.bufferBytes,
      resyncRequired: subscription.resyncRequired,
      sentSeq: subscription.sentSeq,
      inFlight: subscription.inFlight,
    };

    // 旧 resync 会先 commit 当前 reservation，再基于服务端 sentSeq 发 snapshot，
    // 这会把客户端未收到的帧误记为已送达。same-sub recovery 必须直接 supersede。
    subscription.inFlight = null;
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    subscription.resyncRequired = false;

    const base = request.base;
    const resumable =
      !request.forceSnapshot &&
      base !== null &&
      base.logEpoch === this.logEpoch &&
      base.seq >= this.floorSeq &&
      base.seq <= this.currentSeq;

    if (!resumable) {
      subscription.sentSeq = 0;
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        false,
        "recovery",
      );
      return this.subscribeResult(
        this.ackFor(subscription, "snapshot"),
        reservation,
        this.resyncRollback(subscription, reservation, previous),
      );
    }

    subscription.sentSeq = base.seq;
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(
        this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
        subscription,
      ),
    );
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.currentSeq,
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "recovery",
    );
    return this.subscribeResult(
      this.ackFor(subscription, "resume"),
      reservation,
      this.resyncRollback(subscription, reservation, previous),
    );
  }

  /**
   * recovery 回滚：只在本次 reservation 仍是订阅在途帧且订阅身份未变时，
   * 恢复 recovery 前的 sentSeq/inFlight；否则 false（已被新 recovery 取代）。
   */
  private resyncRollback(
    subscription: Subscription,
    reservation: TopicFrameReservation<ConversationTopicFrame>,
    previous: Pick<
      Subscription,
      "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
    >,
  ): () => boolean {
    let rolledBack = false;
    return (): boolean => {
      if (rolledBack) return true;
      if (
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      const recoveryBuffer = subscription.buffer;
      const recoveryResyncRequired = subscription.resyncRequired;
      const merged = appendConversationSubscriberBuffer(
        previous.buffer,
        recoveryBuffer,
        this.subscriberBufferLimits(),
      );
      if (merged.kind === "overflow" || previous.resyncRequired || recoveryResyncRequired) {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
      } else {
        subscription.buffer = merged.deltas;
        subscription.bufferBytes = merged.encodedBytes;
        subscription.resyncRequired = false;
      }
      subscription.sentSeq = previous.sentSeq;
      subscription.inFlight = previous.inFlight;
      rolledBack = true;
      return true;
    };
  }

  /**
   * 当前订阅者缓冲限额：maxOps/maxBytes 来自构造参数，snapshotBytesUpperBound 是最近一次
   * 测量/候选投影的 wire 上界。只读；保证 buffer 不会长成比 snapshot 还大的“负收益增量”。
   */
  private subscriberBufferLimits(): ConversationSubscriberBufferLimits {
    return {
      maxOps: this.subscriberBufferMaxOps,
      maxBytes: this.subscriberBufferMaxBytes,
      snapshotBytesUpperBound: this.wireSnapshotBytesUpperBound,
    };
  }

  /** 溢出降级（05 §两级背压）：清缓冲、回发 snapshot 帧重对齐。 */
  // forceSnapshot 走 resyncReserved，base=null；若已有在途 snapshot 则 commit 失败返回 null。
  resync(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.resyncReserved(subscriptionId, {
      base: null,
      forceSnapshot: true,
    })?.reservation;
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * 把帧包装成 reservation 并挂到订阅 inFlight（每订阅同一时刻至多一个逻辑帧）。
   *
   * commit：仅在订阅仍是同一对象且 inFlight 仍是本 reservation 时推进 sentSeq=frame.toSeq；
   * 重复 commit 幂等 true；身份失配 false，迟到帧被丢弃。snapshotRecovery 提交后若水位又前进，
   * 置 resyncRequired，要求下一次再发最新 snapshot，避免“快照后漏增量”。
   * 同时分配单调 logicalFrameId/Ordinal，供宿主按逻辑帧顺序投递与去重；不发送任何 IO。
   */
  private reserveFrame(
    subscription: Subscription,
    frame: ConversationTopicFrame,
    snapshotRecovery: boolean,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<ConversationTopicFrame> {
    let committed = false;
    const reservation: TopicFrameReservation<ConversationTopicFrame> = {
      deliveryKind,
      logicalFrameId: `${subscription.subscriptionId}-lf-${this.nextLogicalFrameSerial++}`,
      logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
      frame,
      commit: () => {
        if (committed) return true;
        if (
          this.subscriptions.get(subscription.subscriptionId) !== subscription ||
          subscription.inFlight !== reservation
        ) {
          return false;
        }
        subscription.sentSeq = frame.toSeq;
        subscription.inFlight = null;
        if (snapshotRecovery) {
          // snapshot 在途时 resyncRequired 会停止收 delta。
          // 若权威水位又推进，下一 reservation 必须再发最新 snapshot。
          subscription.resyncRequired = this.currentSeq > frame.toSeq;
        }
        committed = true;
        return true;
      },
    };
    subscription.inFlight = reservation;
    return reservation;
  }

  /**
   * 组装订阅结果：ack、reservation、rollback，以及兼容旧单测的 frame getter。
   * frame getter 读取即 commit；生产 gateway 只应读 reservation，避免绕过物理投递确认。
   */
  private subscribeResult(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<ConversationTopicFrame> | null,
    rollback: () => boolean,
  ): ConversationSubscribeResult {
    return {
      ack,
      reservation,
      rollback,
      // 兼容旧 publisher 单测：读 frame 即表示本地 transport 已接受。
      // 生产 gateway 只读 reservation，不会触发该 getter。
      get frame() {
        reservation?.commit();
        return reservation?.frame ?? null;
      },
    };
  }

  /**
   * 构造订阅 ack：subscriptionId + 本次裁决 mode（resume/snapshot）+ 当前 logEpoch。
   * 纯构造，无副作用；logEpoch 让客户端识别跨代际并丢弃旧基座。
   */
  private ackFor(subscription: Subscription, mode: SubscribeAck["mode"]): SubscribeAck {
    return {
      subscriptionId: subscription.subscriptionId,
      mode,
      logEpoch: this.logEpoch,
    };
  }

  /**
   * 帧外壳：topic/subscriptionId/sentAt 三字段；sentAt 取注入的 now，便于测试与时钟口径统一。
   * 纯构造，不读订阅缓冲、不推进 seq。
   */
  private frameShell(
    subscription: Subscription,
  ): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt"> {
    return {
      topic: this.topic,
      subscriptionId: subscription.subscriptionId,
      sentAt: this.now(),
    };
  }
}
