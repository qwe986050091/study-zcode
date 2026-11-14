// INV-01 出站 seq 单调递增：守住位置 seq += 1 必须早于 frame 构造；改错故障 序号重复或跳号让对端判定缺口并进入 degraded。
// INV-02 出站帧必须携带 bridgeSessionId：守住位置 frame 字面量固定字段；改错故障 跨会话的帧被对端接受，旧 bridge 请求串入新会话。
// INV-03 bridgeGeneration 与 recoveryId 仅在存在时展开：守住位置 条件展开分支；改错故障 undefined 被序列化，对端按错误代际执行恢复。
// INV-04 发送失败必须缓冲而非丢弃：守住位置 trySendFrame 失败后的 bufferFrame；改错故障 RPC 请求静默丢失，调用方永远等不到响应。
// INV-05 缓冲达上限时整体清空：守住位置 bufferFrame 的长度判定；改错故障 只丢最旧一帧会留下序列空洞，flush 时对端直接报 gap。
// INV-06 缓冲计时器只允许一个在飞：守住位置 startBufferedFrameTimer 的早返回；改错故障 多计时器并发回调，重复上报超时并误清新缓冲。
// INV-07 bufferedFrameTimeoutMs 为 null 表示不设超时：守住位置 启动计时器前的 null 判定；改错故障 null 被当作 0，缓冲帧立刻被清空。
// INV-08 flush 必须严格按队首顺序发送：守住位置 只读 bufferedFrames[0] 且成功后才 shift；改错故障 乱序投递让对端 seq 校验失败。
// INV-09 flush 失败必须保留剩余帧并重启计时：守住位置 trySendFrame 失败分支；改错故障 已缓存帧被丢弃，重连后无法补齐缺口。
// INV-10 degraded 后禁止任何出站发送：守住位置 send 与 trySendFrame 的 degraded 早返回；改错故障 旧 bridge 请求刷进新连接，造成重复执行。
// INV-11 markDegraded 立即丢弃旧缓冲：守住位置 dropBufferedFrames 调用；改错故障 恢复时把旧请求按序刷进新状态，业务出现幽灵操作。
// INV-12 degraded 是单向且幂等的状态：守住位置 markDegraded 的重复调用早返回；改错故障 重复清理与重复回调让上层恢复流程重入。
// INV-13 入站 seq 必须严格等于期望值：守住位置 expectedSeq 比较；改错故障 重复帧被再次派发，上层收到重复响应。
// INV-14 入站缺口直接判定 degraded 并上报：守住位置 seq 不等时先 markDegraded 再 return；改错故障 带缺口继续消费会让后续帧永久错位。
// INV-15 入站帧必须校验 zcode_type 与 bridgeSessionId：守住位置 acceptPayload 的统一早返回；改错故障 其他会话载荷被解包并越权处理。
// INV-16 dispose 后不再发送且释放 Emitter：守住位置 dispose 内先置 disposed；改错故障 销毁后仍向 onMessage 派发，监听方拿到已释放资源。
// INV-17 二进制编码必须分块：守住位置 bytesToBase64 的 chunkSize 循环；改错故障 一次性展开大数组触发调用栈溢出，整帧发送失败。
// INV-18 base64 解码必须逐字节复制：守住位置 base64ToBytes 的回填循环；改错故障 直接把字符串交给 VSBuffer.wrap，类型不符且长度失真。
//
// 模块职责：把 IMessagePassingProtocol 的字节流封装成带 bridgeSessionId 与 seq 的 rpc-frame，并承担重连后的顺序缓冲与缺口检测。
// 状态所有权：seq、inboundSeq、bufferedFrames、degraded 全部归本闭包所有，调用方只能通过 isDegraded 与 getBridgeSessionId 观察。
// 阅读顺序：先看字节转换，再看 bufferFrame 与 flushPendingFrames 的配对，最后看 send 与 acceptPayload 两侧的序号约束。
import { Emitter, VSBuffer, type IMessagePassingProtocol } from "@zcode/rpc";
import type { WebRemoteControlAppPayload, WebRemoteControlRpcFramePayload } from "@zcode/shared";

export {
  ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS,
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type AcknowledgedWebRemoteControlRelayProtocolOptions,
} from "./webRemoteControlAcknowledgedRelayProtocol.js";

export interface WebRemoteControlRelayProtocolOptions {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  sendFrame(frame: WebRemoteControlRpcFramePayload): boolean | void;
  maxBufferedFrames?: number;
  bufferedFrameTimeoutMs?: number | null;
  onBufferedFrameTimeout?(count: number): void;
  onFrameGap?(gap: {
    bridgeSessionId: string;
    seq: number;
    expectedSeq: number;
  }): void;
}

export interface WebRemoteControlRelayProtocolAdapter {
  protocol: IMessagePassingProtocol;
  acceptPayload(payload: WebRemoteControlAppPayload): void;
  flushPendingFrames(): boolean;
  dropBufferedFrames(): number;
  getBridgeSessionId(): string;
  isDegraded(): boolean;
  markDegraded(): void;
  dispose(): void;
}

// 必须分块的原因：String.fromCharCode 通过展开实参接收数据，单帧较大时一次性展开会超出引擎的实参上限。
// chunkSize 取 0x8000 是保守值，既能摊薄拼接成本，也不接近各引擎的实参上限。
// 返回值交给 btoa，因此这里只能产出单字节范围的字符串，高位字节已在 fromCharCode 中按字节保留。
//
// 不要改成 Buffer 或 TextDecoder：两端运行环境不同，只有这对函数能保证逐字节往返。
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// atob 产出的是按字符编码的字符串，必须逐字节写入定长数组，不能直接把字符串当成字节序列使用。
// 先按 binary.length 分配再回填，保证长度与解码结果严格一致，VSBuffer.wrap 不会做二次校验。
// 循环内用 charCodeAt 而不是 codePointAt，base64 解码结果始终落在单字节范围内。
// 返回的 Uint8Array 每帧独立分配，不要复用或缓存，避免上层持有后与后续解码互相污染。
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function createWebRemoteControlRelayProtocol({
  bridgeSessionId,
  bridgeGeneration,
  recoveryId,
  sendFrame,
  maxBufferedFrames = 50,
  bufferedFrameTimeoutMs = 5_000,
  onBufferedFrameTimeout,
  onFrameGap,
}: WebRemoteControlRelayProtocolOptions): WebRemoteControlRelayProtocolAdapter {
  const onMessage = new Emitter<VSBuffer>();
  let disposed = false;
  let degraded = false;
  let seq = 0;
  let inboundSeq = 0;
  let bufferedFrameTimer: ReturnType<typeof setTimeout> | undefined;
  const bufferedFrames: WebRemoteControlRpcFramePayload[] = [];

  function clearBufferedFrameTimer(): void {
    if (!bufferedFrameTimer) {
      return;
    }
    clearTimeout(bufferedFrameTimer);
    bufferedFrameTimer = undefined;
  }

  function startBufferedFrameTimer(): void {
    if (bufferedFrameTimer || bufferedFrames.length === 0) {
      return;
    }
    if (bufferedFrameTimeoutMs === null) {
      return;
    }
    bufferedFrameTimer = setTimeout(() => {
      bufferedFrameTimer = undefined;
      const timedOutCount = bufferedFrames.length;
      bufferedFrames.length = 0;
      onBufferedFrameTimeout?.(timedOutCount);
    }, bufferedFrameTimeoutMs);
  }

  // buffer 达到上限时整体清空而非丢最旧一帧，让缺口对对端显式暴露。
  // 丢弃计数包含当前待入队的这一帧，因此上报值比既有缓冲长度多一。
  // 清空后必须同步停掉计时器，否则空缓冲仍会触发一次超时回调。
  // 入队成功后立刻尝试启动计时器，若已有在飞计时器则由它继续覆盖整批帧。
  // 超时回调里直接清空 length 而不是替换数组，避免遗留旧数组引用继续被写入。
  // 两个阈值是独立保险：maxBuffered 防内存膨胀，stallTimeout 防链路长时间无进展。
  function bufferFrame(frame: WebRemoteControlRpcFramePayload): void {
    if (bufferedFrames.length >= maxBufferedFrames) {
      const droppedCount = bufferedFrames.length + 1;
      bufferedFrames.length = 0;
      clearBufferedFrameTimer();
      onBufferedFrameTimeout?.(droppedCount);
      return;
    }
    bufferedFrames.push(frame);
    startBufferedFrameTimer();
  }

  function trySendFrame(frame: WebRemoteControlRpcFramePayload): boolean {
    if (degraded) {
      return false;
    }
    return sendFrame(frame) !== false;
  }

  // 返回值语义是「是否已排空」，degraded 或空缓冲时返回 false 表示没有推进，而不是发送失败。
  // 必须只取队首元素，发送成功后才 shift，任何批量清空都会让失败点之后的数据丢失。
  // 队首为空属于数组被外部改写的异常态，此时清计时器并返回 true，避免陷入死循环。
  // 发送失败时保留整个剩余队列并重启计时器，等待下一次 send 或 paired 触发重试。
  // 不要在 flush 内部递归调用自身，重入会让同一帧被计数两次并打乱 seq 顺序。
  // 排空后必须清计时器，遗留计时器会在下一批帧上提前触发超时并误报丢弃。
  function flushPendingFrames(): boolean {
    if (disposed || degraded || bufferedFrames.length === 0) {
      return false;
    }
    while (bufferedFrames.length > 0) {
      const frame = bufferedFrames[0];
      if (!frame) {
        clearBufferedFrameTimer();
        return true;
      }
      if (!trySendFrame(frame)) {
        startBufferedFrameTimer();
        return false;
      }
      bufferedFrames.shift();
    }
    clearBufferedFrameTimer();
    return true;
  }

  function dropBufferedFrames(): number {
    const droppedCount = bufferedFrames.length;
    bufferedFrames.length = 0;
    clearBufferedFrameTimer();
    return droppedCount;
  }

  function markDegraded(): void {
    if (degraded) {
      return;
    }
    degraded = true;
    // Bugfix: 手机硬恢复期间旧 bridge 的 RPC frame 已经无法判断幂等性。
    // 这里进入 degraded 后立即丢弃旧 buffer，避免 paired/send-ready 恢复时把旧请求刷到新状态里。
    dropBufferedFrames();
  }

  const protocol: IMessagePassingProtocol = {
    onMessage: onMessage.event,
    // 这是唯一的出站入口，disposed 与 degraded 都必须在自增序号之前拦截，否则序号会被空转消耗。
    // seq 只增不减，且必须先自增再构造 frame，保证帧体携带的就是本次序号。
    // bridgeGeneration 与 recoveryId 用条件展开，缺省时不能留下 undefined 字段污染对端解析。
    // 已有缓冲时新帧只能排队，不能插队直发，否则对端观察到的 seq 顺序被打乱。
    // 直接发送失败不是错误而是信号：transport 处于 suspect 窗口，先缓冲等待 paired 恢复。
    // sendFrame 的返回类型允许 void，所以只有显式 false 才视为失败，undefined 按成功处理。
    send(buffer) {
      if (disposed) {
        return;
      }
      if (degraded) {
        return;
      }
      seq += 1;
      const frame = {
        zcode_type: "rpc-frame",
        bridgeSessionId,
        ...(bridgeGeneration !== undefined ? { bridgeGeneration } : {}),
        ...(recoveryId ? { recoveryId } : {}),
        seq,
        dataBase64: bytesToBase64(buffer.buffer),
      } satisfies WebRemoteControlRpcFramePayload;
      if (bufferedFrames.length > 0) {
        bufferFrame(frame);
        flushPendingFrames();
        return;
      }
      // Bugfix: relay suspect 窗口内 sendFrame 可能返回 false。
      // RPC 帧不能静默丢弃，先短暂缓冲，等 transport 恢复 paired 后再按序 flush。
      if (!trySendFrame(frame)) {
        bufferFrame(frame);
      }
    },
    drain: () => Promise.resolve(),
  };

  return {
    protocol,
    flushPendingFrames,
    dropBufferedFrames,
    getBridgeSessionId: () => bridgeSessionId,
    isDegraded: () => degraded,
    markDegraded,
    // 入站与出站共享同一套序号语义，但 inboundSeq 只由成功消费的帧推进。
    // 重复帧（seq 小于等于 inboundSeq）静默丢弃，重连重放时这是常态而非异常。
    // 严格等于 expectedSeq 才消费，缺口意味着中间帧永久丢失，继续消费会让后续帧全部错位。
    // 判定缺口后先 markDegraded 再上报 onFrameGap，保证上层回调观察到的一致状态是已降级。
    // 上报时 seq 与 expectedSeq 成对给出，调用方不应自行推算缺口区间。
    // 载荷解包放在最后，任何校验失败都不能触发 onMessage 事件。
    acceptPayload(payload) {
      if (
        disposed ||
        degraded ||
        payload.zcode_type !== "rpc-frame" ||
        payload.bridgeSessionId !== bridgeSessionId
      ) {
        return;
      }
      const expectedSeq = inboundSeq + 1;
      if (payload.seq <= inboundSeq) {
        return;
      }
      if (payload.seq !== expectedSeq) {
        markDegraded();
        onFrameGap?.({
          bridgeSessionId,
          seq: payload.seq,
          expectedSeq,
        });
        return;
      }
      inboundSeq = payload.seq;
      onMessage.fire(VSBuffer.wrap(base64ToBytes(payload.dataBase64)));
    },
    // dispose 只做一次，重复调用不应产生副作用，Emitter 的释放本身是幂等的。
    // 必须先置 disposed 再清资源，避免清理过程中新的 send 或 acceptPayload 重新写入缓冲。
    // 这里直接清空数组而不走 dropBufferedFrames，是销毁语义：不需要再上报丢弃数量。
    // onMessage 释放之后不得再派发，否则监听方会拿到已释放的订阅并可能抛错。
    // 计时器与数组必须同时清理，只清其一会让回调在销毁后仍访问缓冲。
    dispose() {
      disposed = true;
      bufferedFrames.length = 0;
      clearBufferedFrameTimer();
      onMessage.dispose();
    },
  };
}
