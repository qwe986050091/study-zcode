// INV-01 所有上限都是字节数而不是条目数：守住位置 常量对象的字段语义；改错故障 大帧绕过背压。
// INV-02 高水位必须为正安全整数：守住位置 requirePositiveSafeInteger；改错故障 NaN 使比较恒假。
// INV-03 低水位允许为 0 但不得为负：守住位置 requireNonnegativeSafeInteger；改错故障 负水位导致永远触发饱和。
// INV-04 低水位不得超过高水位：守住位置 resolveAcknowledgedRelayLimits 的显式比较；改错故障 背压区间倒挂。
// INV-05 重放缓冲上限只能收紧不能放宽：守住位置 Math.min 与常量；改错故障 调用方传入更大值导致内存膨胀。
// INV-06 重放宽限期同样只能收紧：守住位置 Math.min；改错故障 断线重连窗口被无限延长。
// INV-07 装配超时复用共享传输限制：守住位置 常量引用；改错故障 两端超时不一致。
// INV-08 帧字节必须逐帧校验后才累加：守住位置 measureAcknowledgedRelayBatchBytes 的循环；改错故障 非法帧被计入总数。
// INV-09 非法字节数必须抛错而不是跳过：守住位置 三个条件判断；改错故障 静默少算导致背压失效。
// INV-10 身份匹配要求三个字段全部相等：守住位置 rawIdentityMatches；改错故障 跨会话帧被误接收。
// INV-11 身份匹配必须先排除非对象：守住位置 typeof 与 null 判断；改错故障 空候选触发异常。
// INV-12 原始候选只认两种 zcode_type：守住位置 isRawTransportCandidate；改错故障 普通 RPC 帧被重复处理。
// INV-13 批次外层字节由帧字节求和得出：守住位置 AcknowledgedRelayOutboundBatch 的字段含义；改错故障 背压与实际流量不符。
// INV-14 批次必须携带排队时间与进度游标：守住位置 queuedAt 与 nextFrameIndex；改错故障 重放重复发送已确认帧。
// INV-15 适配器接口继承连接流控：守住位置 extends ConnectionFlowControl；改错故障 上层无法统一施加背压。
// INV-16 降级事件只暴露故障类型：守住位置 onDegraded 泛型；改错故障 内部错误对象泄漏到渲染层。
// INV-17 本文件只声明类型与纯函数，不持有状态：守住位置 模块边界；改错故障 阈值被隐式缓存。
// INV-18 默认值集中在常量对象，便于两端比对：守住位置 as const 常量；改错故障 客户端与服务端各写一份数字。
//
// 模块职责：声明带确认的远控中继协议常量、选项与适配器契约，并提供纯校验函数。
// 状态所有权：无运行时状态；水位、缓冲与超时都由调用方按本文件的解析结果持有。
// 阅读顺序：先看常量与两个水位校验，再读身份与帧校验，最后看上限解析。
import type { ConnectionFlowControl, Event, IMessagePassingProtocol } from "@zcode/rpc";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlRpcTransportFault,
  type WebRemoteControlRpcTransportFramePayload,
  type WebRemoteControlRpcTransportIdentity,
  type WebRemoteControlRpcTransportPayload,
} from "@zcode/shared";

// 饱和高水位为 1 MiB，超过即暂停发送。
// 低水位为 256 KiB，降到此处才恢复。
// 重放缓冲硬上限 8 MiB，防止断线期间无限堆积。
// 宽限期 45 秒，覆盖常见网络抖动。
// assemblyTimeoutMs 直接取 WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.assemblyTimeoutMs，两端同源。
export const ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS = {
  saturationHighWaterMarkBytes: 1024 * 1024,
  saturationLowWaterMarkBytes: 256 * 1024,
  replayBufferMaxBytes: 8 * 1024 * 1024,
  replayBufferGraceMs: 45_000,
  assemblyTimeoutMs: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.assemblyTimeoutMs,
} as const;

export interface AcknowledgedWebRemoteControlRelayProtocolOptions
  extends WebRemoteControlRpcTransportIdentity {
  sendFrame(payload: WebRemoteControlRpcTransportPayload): boolean | void;
  measureFrameBytes?(payload: WebRemoteControlRpcTransportFramePayload): number;
  saturationHighWaterMarkBytes?: number;
  saturationLowWaterMarkBytes?: number;
  replayBufferMaxBytes?: number;
  replayBufferGraceMs?: number;
  assemblyTimeoutMs?: number;
  now?: () => number;
}

export interface AcknowledgedWebRemoteControlRelayProtocolAdapter
  extends ConnectionFlowControl {
  readonly protocol: IMessagePassingProtocol;
  readonly onDegraded: Event<WebRemoteControlRpcTransportFault>;
  acceptPayload(payload: unknown): boolean;
  flushPendingFrames(): boolean;
  replayUnacknowledged(): boolean;
  getBridgeSessionId(): string;
  isDegraded(): boolean;
  markDegraded(reasonCode?: string): void;
  dispose(): void;
}

export interface AcknowledgedRelayOutboundBatch {
  readonly messageSeq: number;
  readonly frames: readonly WebRemoteControlRpcTransportFramePayload[];
  readonly outerBytes: number;
  readonly queuedAt: number;
  nextFrameIndex: number;
}

// 非安全整数包含 NaN 与 Infinity，一律拒绝。
// value 为 0 或负数时同样抛出 Error。
// Error 消息只拼 name，不回显 value 的具体数值。
// 返回 number 供 resolveAcknowledgedRelayLimits 直接比较，调用方不再重复校验。
export function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function requireNonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

// bridgeSessionId、bridgeGeneration 与 recoveryId 三个字段必须同时相等。
// candidate 必须是 object 且非 null，数组与原始值直接返回 false。
// rawIdentityMatches 不抛出，供消息入口按布尔值快速过滤。
// 字段读取经 Record<string, unknown> 索引签名，避免类型断言扩散。
export function rawIdentityMatches(
  identity: WebRemoteControlRpcTransportIdentity,
  candidate: unknown,
): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  return (
    value.bridgeSessionId === identity.bridgeSessionId &&
    value.bridgeGeneration === identity.bridgeGeneration &&
    value.recoveryId === identity.recoveryId
  );
}

export function isRawTransportCandidate(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const type = (candidate as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

// measureAcknowledgedRelayBatchBytes 逐帧测量，任一帧非法即整批抛出。
// 单帧上限取 WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes。
// 返回的 total 作为 outerBytes 供外层背压判断。
// frameBytes 为零或负数时直接抛错，不参与求和。
// measureFrameBytes 由调用方注入，测试可替换实现。
export function measureAcknowledgedRelayBatchBytes(
  frames: readonly WebRemoteControlRpcTransportFramePayload[],
  measureFrameBytes: (frame: WebRemoteControlRpcTransportFramePayload) => number,
): number {
  let total = 0;
  for (const frame of frames) {
    const frameBytes = measureFrameBytes(frame);
    if (
      !Number.isSafeInteger(frameBytes) ||
      frameBytes <= 0 ||
      frameBytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      throw new Error("invalid final envelope byte count");
    }
    total += frameBytes;
  }
  return total;
}

export interface AcknowledgedRelayResolvedLimits {
  highWaterMarkBytes: number;
  lowWaterMarkBytes: number;
  replayBufferMaxBytes: number;
  replayBufferGraceMs: number;
  assemblyTimeoutMs: number;
}

// 先解析 highWaterMarkBytes，作为 lowWaterMarkBytes 的上界。
// 低水位允许为 0，表示降到零才恢复。
// lowWaterMarkBytes 大于 highWaterMarkBytes 时直接抛出 Error。
// replayBufferMaxBytes、replayBufferGraceMs 与 assemblyTimeoutMs 都与常量取 Math.min。
// 返回的 AcknowledgedRelayResolvedLimits 字段与内部契约一一对应。
export function resolveAcknowledgedRelayLimits(
  options: AcknowledgedWebRemoteControlRelayProtocolOptions,
): AcknowledgedRelayResolvedLimits {
  const highWaterMarkBytes = requirePositiveSafeInteger(
    options.saturationHighWaterMarkBytes ??
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.saturationHighWaterMarkBytes,
    "saturationHighWaterMarkBytes",
  );
  const lowWaterMarkBytes = requireNonnegativeSafeInteger(
    options.saturationLowWaterMarkBytes ??
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.saturationLowWaterMarkBytes,
    "saturationLowWaterMarkBytes",
  );
  if (lowWaterMarkBytes > highWaterMarkBytes) {
    throw new Error("saturationLowWaterMarkBytes must not exceed high watermark");
  }
  return {
    highWaterMarkBytes,
    lowWaterMarkBytes,
    replayBufferMaxBytes: Math.min(
      requirePositiveSafeInteger(
        options.replayBufferMaxBytes ??
          ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.replayBufferMaxBytes,
        "replayBufferMaxBytes",
      ),
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.replayBufferMaxBytes,
    ),
    replayBufferGraceMs: Math.min(
      requirePositiveSafeInteger(
        options.replayBufferGraceMs ??
          ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.replayBufferGraceMs,
        "replayBufferGraceMs",
      ),
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.replayBufferGraceMs,
    ),
    assemblyTimeoutMs: Math.min(
      requirePositiveSafeInteger(
        options.assemblyTimeoutMs ??
          ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.assemblyTimeoutMs,
        "assemblyTimeoutMs",
      ),
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.assemblyTimeoutMs,
    ),
  };
}
