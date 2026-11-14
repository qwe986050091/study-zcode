// INV-01 字符串帧先按字节长度校验：守住位置 编码计数；改错故障 多字节字符绕过上限。
// INV-02 二进制帧按字节长度校验：守住位置 长度属性；改错故障 超大帧进入解析。
// INV-03 视图类型同样受限：守住位置 类型判断；改错故障 子数组绕过上限。
// INV-04 Blob 异步读取文本：守住位置 分支返回；改错故障 调用方拿到未解析对象。
// INV-05 未知类型降级为字符串：守住位置 兜底转换；改错故障 抛错中断整条消息链。
// INV-06 超限一律返回空：守住位置 三元分支；改错故障 超限帧被截断后误解析。
// INV-07 字节长度查询覆盖四种形态：守住位置 分支顺序；改错故障 日志统计出现非数字。
// INV-08 解析入口整体捕获：守住位置 异常处理；改错故障 坏帧冒泡打断连接。
// INV-09 解析失败返回空：守住位置 捕获返回值；改错故障 上层把坏帧当成有效消息。
// INV-10 只认 v2 入站消息：守住位置 解析函数；改错故障 旧协议帧混入。
// INV-11 失败对象结构固定：守住位置 工厂函数；改错故障 各处手拼字段漂移。
// INV-12 失败原因类型来自共享契约：守住位置 索引类型；改错故障 新增原因无法编译。
// INV-13 元数据只提取三个字段：守住位置 字段白名单；改错故障 整包载荷泄漏进日志。
// INV-14 非对象载荷返回空表：守住位置 三段判断；改错故障 数组被当成记录读取。
// INV-15 字段类型不对就留空：守住位置 类型判断；改错故障 非字符串进入日志字段。
// INV-16 原始传输候选只认两种类型：守住位置 相等比较；改错故障 普通数据帧被当原始帧。
// INV-17 追踪摘要按消息类型分流：守住位置 分支顺序；改错故障 未知类型缺少类型字段。
// INV-18 摘要不含正文：守住位置 字段选择；改错故障 追踪日志泄漏用户数据。
//
// 模块职责：Web 远控 WebSocket 帧的读取、解析、失败构造与追踪摘要。
// 状态所有权：无状态；全部为纯函数。
// 阅读顺序：先看帧读取与字节长度，再看解析入口，最后看元数据与摘要。
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlFailure,
} from "@zcode/shared";
import {
  parseWebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2OutgoingMessage,
} from "@zcode/shared/web-remote-relay";

// 字符串按 TextEncoder().encode(data).byteLength 计数，不是 length。
// ArrayBuffer 直接取 byteLength，Blob 取 size。
// 未知类型用 String(data) 转成字符串后再计数。
export async function readWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength <=
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
      ? data
      : null;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return new TextDecoder().decode(data as Uint8Array);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.size > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return data.text();
  }
  const text = String(data);
  return new TextEncoder().encode(text).byteLength <=
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ? text
    : null;
}

export function webSocketDataByteLength(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return new TextEncoder().encode(String(data)).byteLength;
}

// 先 readWebSocketData 取帧文本，null 表示超限。
// 超限直接返回 null，不进入 JSON.parse。
// JSON.parse 与 parseWebRemoteControlRelayV2IncomingMessage 一起包在 try 里。
// 坏帧在 catch 里吞掉返回 null，不向上冒泡。
export async function parseRelayMessage(
  data: unknown,
): Promise<WebRemoteControlRelayV2IncomingMessage | null> {
  try {
    const text = await readWebSocketData(data);
    if (text === null) return null;
    return parseWebRemoteControlRelayV2IncomingMessage(JSON.parse(text));
  } catch {
    return null;
  }
}

export function createFailure(
  reason: WebRemoteControlFailure["reason"],
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

export function safePayloadMetadata(payload: unknown): Record<string, string | undefined> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    zcode_type: typeof record.zcode_type === "string" ? record.zcode_type : undefined,
    requestId: typeof record.requestId === "string" ? record.requestId : undefined,
    bridgeSessionId:
      typeof record.bridgeSessionId === "string" ? record.bridgeSessionId : undefined,
  };
}

export function isRawTransportCandidate(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const type = (payload as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

// summarizeRelayMessageForTrace 按 type 只挑安全字段。
// 数据帧的 payload 走 safePayloadMetadata 白名单。
// 未知 type 只保留 type 字段本身。
export function summarizeRelayMessageForTrace(
  message:
    | WebRemoteControlRelayV2IncomingMessage
    | WebRemoteControlRelayV2OutgoingMessage
    | { type: "data"; payload: unknown },
): Record<string, unknown> {
  if (message.type === "pair_status_ack") {
    return { type: message.type, pair_status: message.pair_status };
  }
  if (message.type === "auth_init") {
    return { type: message.type };
  }
  if (message.type === "data") {
    return {
      type: message.type,
      payload: safePayloadMetadata(message.payload),
    };
  }
  if (message.type === "error") {
    return { type: message.type, code: message.code };
  }
  return { type: message.type };
}
