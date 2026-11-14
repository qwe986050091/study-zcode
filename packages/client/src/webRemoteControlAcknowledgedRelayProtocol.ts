// 职责边界：本文件实现「可确认送达」的 Web 远控 RPC 中继协议，只做帧级排序、重放与背压，不解码业务语义。
// 它把一条 IMessagePassingProtocol 消息切成 transport 帧并按 messageSeq 成批排队，收到 rpc-frame-ack 后才释放重放缓冲。
// 不负责：帧编解码与结构校验（@zcode/shared）、批次存储与压缩（AcknowledgedRelayBatchQueue）、
// 时钟与宽限期策略（AcknowledgedRelayDeadline）、桥接会话建立与鉴权（上层 attachment）。
// 上游入口：protocol.send 进入 reserveMessage，relay 转发进入 acceptPayload，恢复流程进入 replayUnacknowledged。
// 下游出口：sendFrame 把 payload 写回传输层，onMessage 把重组完成的整条消息交给上层。
//
// INV 表（断言 —— 守住它的位置 —— 改错故障）：
// INV-01 断言：每批 messageSeq 只增不减，且只能被整体确认一次 —— 守住它的位置：reserveMessage 分配与 outboundBatches.releaseThrough —— 改错故障：重放缓冲被重复释放，在窗字节永久偏移。
// INV-02 断言：ack 必须严格大于 lastAckedMessageSeq 才生效 —— 守住它的位置：processAck 的单调性早退分支 —— 改错故障：迟到 ack 回退确认水位，已释放批次被再次记账。
// INV-03 断言：ack 不可能超过 highestFullySentMessageSeq —— 守住它的位置：processAck 的 futureAck 判定 —— 改错故障：确认从未写出的帧，重连补偿时凭空丢失数据。
// INV-04 断言：任一时刻未确认字节数不超过 replayBufferMaxBytes —— 守住它的位置：reserveMessage 发送前的 admission —— 改错故障：本端内存无界增长，且被迫中途丢帧。
// INV-05 断言：整批 admission 必须早于首片发送 —— 守住它的位置：outerBytes 计量先于 append 与 flush —— 改错故障：对端收到半条 RPC，后续序号全部错位。
// INV-06 断言：physicalSeq 连续且只由上一批末片推进 —— 守住它的位置：nextPhysicalSeq 的赋值点 —— 改错故障：分片重组串帧，跨消息拼出脏 payload。
// INV-07 断言：同一消息的所有帧共享一个 messageSeq —— 守住它的位置：编码时绑定的 messageSeq 参数 —— 改错故障：ack 无法定位整批，重放缓冲永不释放。
// INV-08 断言：重放只从队首未确认批次开始 —— 守住它的位置：replayUnacknowledged 调用 resetReplay —— 改错故障：已确认帧被重发，对端判定序号冲突。
// INV-09 断言：待发 ack 只保留最大序号，且同一时刻至多一条 —— 守住它的位置：queueAck 的覆盖分支 —— 改错故障：确认回退，对端重传已消费的消息。
// INV-10 断言：发送回调重入期间不处理入站帧 —— 守住它的位置：acceptPayload 的 outboundCallDepth 判断 —— 改错故障：send 栈帧内嵌套解码与派发，状态被重入破坏。
// INV-11 断言：组装超时只由 assembler.nextExpiryAt 驱动 —— 守住它的位置：scheduleAssemblyTimer —— 改错故障：定时器泄漏，或用固定间隔掩盖真实丢帧。
// INV-12 断言：终态降级后所有入口都必须早退 —— 守住它的位置：各方法首行的 disposed 与 degraded 判断 —— 改错故障：降级后仍在发送，本端与对端状态分叉。
// INV-13 断言：降级与 dispose 都清空重放缓冲、在途 ack 与组装器 —— 守住它的位置：enterDegraded 与 dispose 的清理段 —— 改错故障：已释放对象仍被定时器或队列引用，内存泄漏。
// INV-14 断言：饱和按高水位进入、按低水位退出 —— 守住它的位置：updateSaturationAfterReserve 与 processAck —— 改错故障：背压抖动或永不解除，发送端被饿死。
//
// 帧类型：rpc-frame 为数据帧，携带 identity 与 seq；rpc-frame-ack 只带 ackMessageSeq，不占序号也不进重放窗口。
// 状态骨架：lastAckedMessageSeq 不大于 highestFullySentMessageSeq，后者不大于 nextMessageSeq 减一，未确认区间恒等于重放队列内容。
// nextPhysicalSeq 只在整批写完时推进，因此重放期间物理序号会重复出现，对端必须按 messageSeq 去重。
// 断线重连由上层重建实例并调用 replayUnacknowledged 补偿，本文件只保证重建瞬间状态自洽。
// 未知帧类型、身份不符或解析失败的载荷一律拒绝，宁可降级也不做前向兼容猜测。
// 饱和与排空只影响发送侧背压，不改变 ack 语义，也不允许越过 admission 上限。
// 阅读顺序：字段 → 构造函数（限额与超时）→ reserveMessage（写入）→ flushPendingFrames（发送）→ 入站 → processAck。
import { Emitter, VSBuffer, type IMessagePassingProtocol } from "@zcode/rpc";
import {
  WebRemoteControlRpcTransportAssembler,
  WebRemoteControlRpcTransportEncodingError,
  encodeWebRemoteControlRpcTransportMessage,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
  parseWebRemoteControlRpcTransportPayload,
  type WebRemoteControlRpcTransportFault,
  type WebRemoteControlRpcTransportFramePayload,
  type WebRemoteControlRpcTransportIdentity,
  type WebRemoteControlRpcTransportPayload,
} from "@zcode/shared";
import { AcknowledgedRelayBatchQueue } from "./webRemoteControlAcknowledgedRelayBatchQueue.js";
import { AcknowledgedRelayDeadline } from "./webRemoteControlAcknowledgedRelayDeadline.js";
import {
  ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type AcknowledgedWebRemoteControlRelayProtocolOptions,
  isRawTransportCandidate,
  measureAcknowledgedRelayBatchBytes,
  rawIdentityMatches,
  resolveAcknowledgedRelayLimits,
} from "./webRemoteControlAcknowledgedRelayProtocolTypes.js";
export {
  ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type AcknowledgedWebRemoteControlRelayProtocolOptions,
} from "./webRemoteControlAcknowledgedRelayProtocolTypes.js";
// [契约] 协议实例是重放状态的唯一所有者：序号、在窗字节与批次队列都只在这里推进，外部不得旁路修改。
// [契约] 对外只暴露 IMessagePassingProtocol 四个成员与 replay / acceptPayload / flush 三个显式动作。
class AcknowledgedRelayProtocol implements AcknowledgedWebRemoteControlRelayProtocolAdapter {
  private readonly identity: WebRemoteControlRpcTransportIdentity;
  private readonly sendFrame: AcknowledgedWebRemoteControlRelayProtocolOptions["sendFrame"];
  private readonly measureFrameBytes: NonNullable<
    AcknowledgedWebRemoteControlRelayProtocolOptions["measureFrameBytes"]
  >;
  private readonly highWaterMarkBytes: number;
  private readonly lowWaterMarkBytes: number;
  private readonly replayBufferMaxBytes: number;
  private readonly assemblyTimeoutMs: number;
  private readonly now: () => number;
  private readonly deadline: AcknowledgedRelayDeadline;
  private readonly onMessageEmitter = new Emitter<VSBuffer>();
  private readonly saturatedEmitter = new Emitter<void>();
  private readonly drainedEmitter = new Emitter<void>();
  private readonly degradedEmitter = new Emitter<WebRemoteControlRpcTransportFault>();
  private assembler: WebRemoteControlRpcTransportAssembler | null;
  private readonly outboundBatches = new AcknowledgedRelayBatchQueue();
  private queuedInbound: unknown[] = [];
  // [并发] 待发 ack 只保存一个序号：同一时刻至多一条 ack 在途，避免确认风暴与乱序。
  // [并发] pendingAckQueuedAt 与序号同生共死，供 deadline 判断 ack 是否长期未写出。
  private pendingAckMessageSeq: number | null = null;
  private pendingAckQueuedAt: number | null = null;
  // [契约] 物理序号按帧递增，与 messageSeq 正交：一个 messageSeq 对应连续的一段 physicalSeq。
  // [契约] 初始值从 1 开始，0 留给「未发送」与「空批次」这类哨兵语义。
  private nextPhysicalSeq = 1;
  private nextMessageSeq = 1;
  private highestFullySentMessageSeq = 0;
  // [契约] lastAckedMessageSeq 是本端认可的确认水位，单调不回退，重复或迟到的 ack 直接早退。
  // [契约] 它与 highestFullySentMessageSeq 共同界定「可确认区间」，任何越界 ack 都视为协议错误。
  // [权衡] 只记录最大确认值，不记录逐条确认集合，换取常数级内存，代价是必须按序整批确认。
  private lastAckedMessageSeq = 0;
  // [资源] 在窗字节数覆盖已入队但未确认的全部 outer bytes，是 admission 与背压的唯一计量口径。
  // [资源] 它只由 reserveMessage 增加、processAck 减少，降级与 dispose 时直接归零。
  private unacknowledgedByteCount = 0;
  private saturated = false;
  private disposed = false;
  private degraded = false;
  private flushing = false;
  private outboundCallDepth = 0;
  private assemblyTimer: ReturnType<typeof setTimeout> | undefined;
  readonly onSaturated = this.saturatedEmitter.event;
  readonly onDrained = this.drainedEmitter.event;
  readonly onDegraded = this.degradedEmitter.event;
  // [契约] protocol.send 只做预约，不做同步写穿：数据先入重放队列，再由 flush 循环逐帧写出。
  // [契约] protocol.onMessage 暴露的是重组完成的整条消息，不是单个 transport 帧。
  // [权衡] drain 直接 resolve：真实背压通过 onSaturated 与 onDrained 事件表达，避免调用方被 Promise 阻塞。
  readonly protocol: IMessagePassingProtocol = {
    onMessage: this.onMessageEmitter.event,
    send: (buffer) => this.reserveMessage(buffer.buffer),
    drain: () => Promise.resolve(),
  };
  // [契约] 构造函数只归一 identity 并解析 limits 与绑定时钟，既不发送任何帧也不置 degraded 标志。
  // [契约] 身份字段缺省时就省略对应键，保证身份比较按「存在且相等」而不是按 undefined 参与匹配。
  constructor(options: AcknowledgedWebRemoteControlRelayProtocolOptions) {
    this.identity = {
      bridgeSessionId: options.bridgeSessionId,
      ...(options.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: options.bridgeGeneration }),
      ...(options.recoveryId === undefined ? {} : { recoveryId: options.recoveryId }),
    };
    this.sendFrame = options.sendFrame;
    this.measureFrameBytes =
      options.measureFrameBytes ?? measureWebRemoteControlRpcRelayEnvelopeBytes;
    const limits = resolveAcknowledgedRelayLimits(options);
    this.highWaterMarkBytes = limits.highWaterMarkBytes;
    this.lowWaterMarkBytes = limits.lowWaterMarkBytes;
    this.replayBufferMaxBytes = limits.replayBufferMaxBytes;
    this.assemblyTimeoutMs = limits.assemblyTimeoutMs;
    this.now = options.now ?? Date.now;
    // [失败路径] deadline 观察两个来源：队首未确认批次与待发 ack，任一长期滞留都会触发降级。
    // [失败路径] 回调返回的 oldest 与 pendingAck 必须来自实时状态，不能用快照，否则宽限期会被误判。
    // [并发] refresh 只在状态推进时调用，避免轮询式心跳掩盖真实的停滞。
    // [权衡] 宽限期交给独立对象管理，本文件不内嵌定时器比较，便于测试注入时钟。
    this.deadline = new AcknowledgedRelayDeadline(
      limits.replayBufferGraceMs,
      this.now,
      () => {
        const oldest = this.outboundBatches.oldest;
        return {
          oldestData: oldest
            ? { queuedAt: oldest.queuedAt, messageSeq: oldest.messageSeq }
            : null,
          pendingAck:
            this.pendingAckQueuedAt === null || this.pendingAckMessageSeq === null
              ? null
              : { queuedAt: this.pendingAckQueuedAt, messageSeq: this.pendingAckMessageSeq },
        };
      },
      (fault) => this.enterDegraded(fault),
    );
    this.assembler = this.createAssembler();
  }
  get unacknowledgedBytes(): number {
    return this.unacknowledgedByteCount;
  }
  getBridgeSessionId(): string {
    return this.identity.bridgeSessionId;
  }
  isDegraded(): boolean {
    return this.degraded;
  }
  markDegraded(reasonCode = "remote.rpcFrame.manuallyDegraded"): void {
    this.enterDegraded({ reasonCode, terminal: true });
  }
  private createAssembler(): WebRemoteControlRpcTransportAssembler {
    return new WebRemoteControlRpcTransportAssembler({
      identity: this.identity,
      timeoutMs: this.assemblyTimeoutMs,
      now: this.now,
    });
  }
  // [事务] reserveMessage 是写入侧的唯一事务边界：编码、计量、admission、入队、触发发送一次完成。
  // [事务] 任何一步失败都进入终态降级，绝不留下「已入队但未计量」或「已计量但未入队」的中间态。
  // [契约] 被拒绝的消息不消耗 messageSeq 与 physicalSeq，序号只在成功入队后推进。
  // [并发] 入口先看 disposed、degraded 与超时，三者任一成立就直接丢弃，不再排队。
  private reserveMessage(bytes: Uint8Array): void {
    if (this.disposed || this.degraded || this.deadline.check()) return;
    let frames: readonly WebRemoteControlRpcTransportFramePayload[];
    try {
      // [契约] 编码时一次性绑定身份、首片物理序号与本条 messageSeq，后续分片不得再次改写。
      // [契约] messageSeq 取自 nextMessageSeq，physicalSeq 取自 nextPhysicalSeq，两者都在成功入队后才递增。
      // [契约] 所有分片天然共享同一 messageSeq，ack 才能以整批为单位释放重放缓冲。
      // [失败路径] 编码异常统一归为编码失败并降级，因为此时对端尚未收到任何分片，无法自愈。
      frames = encodeWebRemoteControlRpcTransportMessage(bytes, {
        ...this.identity,
        firstPhysicalSeq: this.nextPhysicalSeq,
        messageSeq: this.nextMessageSeq,
      });
    // [失败路径] 编码错误保留原始 reasonCode（如超限、非法载荷），其余异常折叠为 encodingFailed。
    // [失败路径] 降级标记为 terminal：本实例不再复用，恢复必须由上层重建。
    } catch (error) {
      this.enterDegraded({
        reasonCode:
          error instanceof WebRemoteControlRpcTransportEncodingError
            ? error.reasonCode
            : "remote.rpcFrame.encodingFailed",
        terminal: true,
      });
      return;
    }
    let outerBytes = 0;
    try {
      outerBytes = measureAcknowledgedRelayBatchBytes(frames, this.measureFrameBytes);
    } catch {
      this.enterDegraded({ reasonCode: "remote.rpcFrame.outerMeterFailed", terminal: true });
      return;
    }
    // [资源] 这是重放窗口的唯一闸门：整批 outer bytes 必须一次性纳入上限判断，不允许逐片放行。
    // [资源] 判断先于 append 与首次发送，保证对端永远不会看到「半条 RPC」。
    // [资源] 超限即终态降级并带上 messageSeq，方便日志定位是哪条消息撑爆窗口。
    // [权衡] 窗口按字节而非条数计量，避免大帧与小帧混跑时条数上限失真。
    if (this.unacknowledgedByteCount + outerBytes > this.replayBufferMaxBytes) {
      // Bugfix：必须在首片发送前对整批 final outer bytes 做 admission，不能给对端留下半条 RPC。
      this.enterDegraded({
        reasonCode: "remote.rpcFrame.replayBufferExceeded",
        terminal: true,
        messageSeq: this.nextMessageSeq,
      });
      return;
    }
    const messageSeq = this.nextMessageSeq;
    // [契约] 末片物理序号决定下一批起点，中间分片不推进 nextPhysicalSeq。
    // [契约] 空批在编码阶段就会失败，因此此处取末片是安全的，不需要空数组兜底。
    const lastFrame = frames.at(-1)!;
    this.outboundBatches.append({
      messageSeq,
      frames,
      outerBytes,
      queuedAt: this.now(),
      nextFrameIndex: 0,
    });
    this.unacknowledgedByteCount += outerBytes;
    this.nextMessageSeq += 1;
    this.nextPhysicalSeq = lastFrame.seq + 1;
    this.updateSaturationAfterReserve();
    this.deadline.refresh();
    this.flushPendingFrames();
  }
  // [资源] 饱和只做单向置位：越过高水位才触发 onSaturated，且不重复触发。
  // [资源] 解除饱和只发生在 processAck 看到低水位，保证高低水位之间有明确滞回。
  private updateSaturationAfterReserve(): void {
    if (!this.saturated && this.unacknowledgedByteCount > this.highWaterMarkBytes) {
      this.saturated = true;
      this.saturatedEmitter.fire();
    }
  }
  private invokeSend(payload: WebRemoteControlRpcTransportPayload): boolean {
    this.outboundCallDepth += 1;
    try {
      return this.sendFrame(payload) !== false;
    } catch {
      this.enterDegraded({ reasonCode: "remote.rpcFrame.sendFailed", terminal: true });
      return false;
    } finally {
      this.outboundCallDepth -= 1;
    }
  }
  // [并发] flush 是唯一的发送驱动，ack 优先于数据：先清 ack 再发数据帧，缩短对端等待。
  // [并发] flushing 标志把重入折叠为直接返回 false，避免 send 回调内再次 flush 造成帧交错。
  // [契约] 返回值表示「本地已排空且无待发 ack」，上层可据此决定是否等待 onDrained。
  // [失败路径] 发送被拒、降级或超时都会中断本轮，但已写出的分片保留在批次进度里，等待重放补偿。
  flushPendingFrames(): boolean {
    if (this.disposed || this.degraded || this.deadline.check()) return false;
    if (this.flushing) return false;
    this.flushing = true;
    let locallyDrained = true;
    try {
      // [并发] 循环条件是本端仍可用；降级会在发送回调内同步发生，因此每轮都必须重新判断。
      // [并发] 超时检查放在循环顶部，保证长时间连续发送也会及时让位给宽限期判定。
      while (!this.disposed && !this.degraded) {
        if (this.deadline.check()) {
          locallyDrained = false;
          break;
        }
        // [契约] ack 帧不占 messageSeq、不进入重放队列，因此不会被对端再次确认。
        // [契约] 成功写出后仅在序号未被新 ack 覆盖时才清空，避免丢掉期间累积的更大确认。
        // [并发] 每次 ack 写出后立即尝试排空入站队列，让收到的消息尽快上抛，而不是等本轮数据发完。
        if (this.pendingAckMessageSeq !== null) {
          const ackMessageSeq = this.pendingAckMessageSeq;
          const accepted = this.invokeSend({
            zcode_type: "rpc-frame-ack",
            ...this.identity,
            ackMessageSeq,
          });
          if (!accepted || this.degraded || this.disposed) {
            locallyDrained = false;
            break;
          }
          if (this.pendingAckMessageSeq === ackMessageSeq) {
            this.pendingAckMessageSeq = null;
            this.pendingAckQueuedAt = null;
            this.deadline.refresh();
          }
          this.drainQueuedInbound();
          continue;
        }
        // [并发] 只有队首到 nextUnsent 之间的批次可被写出，已确认的前缀不会再被触碰。
        // [契约] 批次内按 nextFrameIndex 顺序逐片发送，中途中断后从断点续发而不是整批重来。
        // [契约] 重放时 resetReplay 会把未确认批次的帧下标归零，形成完整重传。
        const batch = this.outboundBatches.nextUnsent;
        if (!batch) break;
        const frame = batch.frames[batch.nextFrameIndex]!;
        const accepted = this.invokeSend(frame);
        if (!accepted || this.degraded || this.disposed) {
          locallyDrained = false;
          break;
        }
        batch.nextFrameIndex += 1;
        if (batch.nextFrameIndex === batch.frames.length) {
          this.highestFullySentMessageSeq = Math.max(
            this.highestFullySentMessageSeq,
            batch.messageSeq,
          );
          // [契约] 只有整批最后一片写出后，最高完整发送水位才推进，并移动下一批候选。
          // [契约] 部分写出的批次仍留在未发送区间内，ack 也不可能越过它。
          this.outboundBatches.advanceUnsent();
        }
        this.drainQueuedInbound();
      }
    } finally {
      this.flushing = false;
    }
    if (!this.disposed && !this.degraded) this.drainQueuedInbound();
    return locallyDrained && this.pendingAckMessageSeq === null;
  }
  // [失败路径] 断线重连补偿入口：先把所有未确认批次的帧下标归零，再走同一套 flush 流程。
  // [失败路径] 重放不重建序号，仍用原 messageSeq，让对端按序号去重并补齐缺口。
  // [权衡] 重放不区分对端是否已收到，以重复帧换实现简单，去重责任交给对端组装器。
  replayUnacknowledged(): boolean {
    if (this.disposed || this.degraded || this.deadline.check()) return false;
    this.outboundBatches.resetReplay();
    return this.flushPendingFrames();
  }
  // [失败路径] 入站第一道闸：非原始 transport 候选（如已封装事件）直接拒绝，不进入解码。
  // [失败路径] 第二道闸：身份整组匹配，bridgeSessionId、bridgeGeneration 与 recoveryId 任一不符即丢弃。
  // [并发] 发送回调执行期间到达的帧先入队，避免在 send 内部重入解码与事件派发。
  // [契约] 超时后返回 true 但不处理：视为已过期，避免上层把超时误判为拒绝并重试。
  acceptPayload(payload: unknown): boolean {
    if (this.disposed || this.degraded || !isRawTransportCandidate(payload)) return false;
    if (!rawIdentityMatches(this.identity, payload)) return false;
    if (this.deadline.check()) return true;
    if (this.outboundCallDepth > 0) {
      this.queuedInbound.push(payload);
      return true;
    }
    this.processInbound(payload);
    return true;
  }
  // [并发] 排空只在没有发送重入且实例可用时进行，防止在 send 栈帧内派发消息。
  // [并发] 逐条 shift 处理，处理过程中若降级则立即停止，剩余队列由降级清理丢弃。
  private drainQueuedInbound(): void {
    if (this.outboundCallDepth > 0 || this.disposed || this.degraded) return;
    while (this.queuedInbound.length > 0 && !this.disposed && !this.degraded) {
      this.processInbound(this.queuedInbound.shift());
    }
  }

  // [契约] 入站先解析再分流：ack 帧走确认路径，数据帧交给组装器按身份与序号重组。
  // [契约] 组装结果四种：fault、incomplete、duplicate、complete，每种都有独立的后续动作。
  // [契约] 只有 complete 才向上派发消息并回 ack；duplicate 只在带确认号时补 ack，用于修复丢失的确认。
  // [失败路径] 非终态 fault 只丢弃当前帧且不回 ack，让对端超时后重放，而不是本端猜测。
  private processInbound(candidate: unknown): void {
    const payload = parseWebRemoteControlRpcTransportPayload(candidate);
    // [失败路径] 未知消息拒绝策略：解析失败即终态降级，不做前向兼容，避免把未知帧当数据帧重组。
    // [失败路径] 这里覆盖未知 zcode_type、缺字段、类型不符等所有结构性问题。
    // [权衡] 选择降级而非忽略，是为了让协议版本错配立刻暴露，代价是一次连接报废。
    // [事务] 降级会同时清空重放缓冲与待发 ack，因此不会留下半处理的入站状态。
    if (!payload) {
      this.enterDegraded({ reasonCode: "remote.rpcFrame.invalidPayload", terminal: true });
      return;
    }
    // [契约] ack 帧只有 ackMessageSeq 一个有效载荷，不参与组装，也不需要回 ack。
    // [契约] 分流发生在身份校验之后，因此跨会话的 ack 不会污染本实例的水位。
    // [并发] ack 处理是纯状态推进，不触发发送，避免确认风暴引发递归 flush。
    if (payload.zcode_type === "rpc-frame-ack") {
      this.processAck(payload.ackMessageSeq);
      return;
    }
    const result = this.assembler?.accept(payload, this.now());
    if (!result) return;
    // [失败路径] 组装器返回 fault 时按 terminal 区分：终态直接降级，非终态仅丢弃当前帧。
    // [失败路径] 非终态 fault 常见于单帧损坏，等待对端重放即可恢复，不必立即报废实例。
    // [契约] 组装器内部的序号与超时状态由它自己维护，本文件只负责把结果转成降级决策。
    if (result.kind === "fault") {
      if (result.fault.terminal) this.enterDegraded(result.fault);
      return;
    }
    // [并发] 未收齐时启动组装定时器，定时器只按 assembler.nextExpiryAt 设定，不按固定轮询。
    // [失败路径] 超时到期由组装器 expire 统一裁决，避免本文件重复实现过期逻辑。
    // [权衡] 同一时刻只保留一个定时器，新帧到达时若已有定时器则不重置，减少系统调用。
    if (result.kind === "incomplete") {
      this.scheduleAssemblyTimer();
      return;
    }
    // [契约] 重复帧不重复上抛，避免上层把同一条消息执行两次。
    // [契约] 若组装器给出 ackMessageSeq，说明该消息曾完整收到但确认丢失，这里补发一次 ack。
    // [失败路径] 补发走 queueAck 的合并逻辑，不会绕过待发 ack 的单槽约束。
    if (result.kind === "duplicate") {
      if (result.ackMessageSeq !== null) this.queueAck(result.ackMessageSeq);
      return;
    }
    this.clearAssemblyTimer();
    try {
      this.onMessageEmitter.fire(VSBuffer.wrap(result.bytes));
    } catch {
      this.enterDegraded({
        reasonCode: "remote.rpcFrame.deliveryFailed",
        terminal: true,
        messageSeq: result.messageSeq,
      });
      return;
    }
    this.queueAck(result.messageSeq);
  }
  private queueAck(messageSeq: number): void {
    if (this.disposed || this.degraded) return;
    if (this.pendingAckMessageSeq === null) {
      this.pendingAckMessageSeq = messageSeq;
      this.pendingAckQueuedAt = this.now();
      this.deadline.refresh();
    } else if (messageSeq > this.pendingAckMessageSeq) {
      this.pendingAckMessageSeq = messageSeq;
    }
    this.flushPendingFrames();
  }
  // [契约] ack 处理三步：单调性早退、越界检查、整批释放，顺序不可交换。
  // [契约] 释放按 messageSeq 前缀进行，ack 之前的批次整体出队，ack 之后的一律保留。
  // [资源] 释放字节数与批次计数由队列返回，本文件只做水位扣减并记录确认水位。
  // [并发] 每次有效 ack 都刷新 deadline，因为确认代表对端仍在消费，不算停滞。
  private processAck(ackMessageSeq: number): void {
    if (ackMessageSeq <= this.lastAckedMessageSeq) return;
    // [失败路径] ack 越过 highestFullySentMessageSeq 属于协议错误：对端确认了本端尚未写出的消息。
    // [失败路径] 唯一可能是序号被伪造、串会话或状态错乱，因此按终态降级处理。
    // [权衡] 不做「容忍并截断」，因为截断会掩盖真实的序号分叉，后续更难定位。
    // [契约] 该判断放在释放之前，保证错误 ack 不会先污染水位再被发现。
    if (ackMessageSeq > this.highestFullySentMessageSeq) {
      this.enterDegraded({
        reasonCode: "remote.rpcFrame.futureAck",
        terminal: true,
        messageSeq: ackMessageSeq,
      });
      return;
    }
    const { releasedBytes } = this.outboundBatches.releaseThrough(ackMessageSeq);
    this.unacknowledgedByteCount = Math.max(0, this.unacknowledgedByteCount - releasedBytes);
    this.lastAckedMessageSeq = ackMessageSeq;
    this.deadline.refresh();
    if (this.saturated && this.unacknowledgedByteCount <= this.lowWaterMarkBytes) {
      this.saturated = false;
      this.drainedEmitter.fire();
    }
  }
  private scheduleAssemblyTimer(): void {
    if (this.assemblyTimer || !this.assembler?.nextExpiryAt) return;
    const deadline = this.assembler.nextExpiryAt;
    this.assemblyTimer = setTimeout(() => {
      this.assemblyTimer = undefined;
      const result = this.assembler?.expire(this.now());
      if (result?.kind === "fault") this.enterDegraded(result.fault);
    }, Math.max(0, deadline - this.now()));
  }
  private clearAssemblyTimer(): void {
    if (this.assemblyTimer) clearTimeout(this.assemblyTimer);
    this.assemblyTimer = undefined;
  }
  private enterDegraded(fault: WebRemoteControlRpcTransportFault): void {
    if (this.disposed || this.degraded) return;
    this.degraded = true;
    this.deadline.dispose();
    this.clearAssemblyTimer();
    this.outboundBatches.clear();
    this.queuedInbound = [];
    this.pendingAckMessageSeq = null;
    this.pendingAckQueuedAt = null;
    this.unacknowledgedByteCount = 0;
    this.saturated = false;
    this.assembler = null;
    this.degradedEmitter.fire(fault);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deadline.dispose();
    this.clearAssemblyTimer();
    this.outboundBatches.clear();
    this.queuedInbound = [];
    this.pendingAckMessageSeq = null;
    this.pendingAckQueuedAt = null;
    this.unacknowledgedByteCount = 0;
    this.assembler = null;
    this.onMessageEmitter.dispose();
    this.saturatedEmitter.dispose();
    this.drainedEmitter.dispose();
    this.degradedEmitter.dispose();
  }
}
export function createAcknowledgedWebRemoteControlRelayProtocol(
  options: AcknowledgedWebRemoteControlRelayProtocolOptions,
): AcknowledgedWebRemoteControlRelayProtocolAdapter {
  return new AcknowledgedRelayProtocol(options);
}
