// INV-01 请求与 WebSocket 消息使用严格对象：守住位置 全部 strictObject；改错故障 未知字段被静默接受。
// INV-02 HTTP 响应允许多余字段：守住位置 响应侧 z.object；改错故障 服务端新增字段导致旧客户端解析失败。
// INV-03 时间戳必须为非负整数且落在合理上限内：守住位置 unixSeconds；改错故障 毫秒值被当秒接受。
// INV-04 标识符必须非空、长度受限且去除空白后仍非空：守住位置 identifier；改错故障 纯空白标识进入协议。
// INV-05 设备标识按 UTF-8 字节数限制：守住位置 deviceSid；改错故障 多字节字符超出服务端限制。
// INV-06 角色与配对状态只接受固定枚举：守住位置 两个枚举；改错故障 未知状态进入状态机。
// INV-07 错误码覆盖全部已知分类：守住位置 errorCode；改错故障 新错误码被丢弃。
// INV-08 出站消息按类型判别联合：守住位置 outgoingMessage；改错故障 类型与字段组合不匹配。
// INV-09 解析失败统一返回空：守住位置 两个解析函数；改错故障 异常外泄到消息循环。
// INV-10 入站消息同样按类型判别联合：守住位置 incomingMessage；改错故障 控制帧与数据帧混淆。
// INV-11 HTTP 路由表是唯一地址来源：守住位置 常量表；改错故障 调用方各自拼接路径。
// INV-12 请求体只包含声明字段：守住位置 四个请求 schema；改错故障 多余参数被转发到服务端。
// INV-13 令牌格式按 16 字节无填充 Base64URL 校验：守住位置 token 正则；改错故障 非法令牌进入连接。
// INV-14 错误响应的 code 不允许为 0：守住位置 httpError；改错故障 成功与失败响应无法区分。
// INV-15 成功响应 code 必须为字面量 0：守住位置 response 联合；改错故障 错误响应被当成成功。
// INV-16 删除响应允许省略 data：守住位置 delete 响应 schema；改错故障 服务端省略字段时解析失败。
// INV-17 请求与响应 schema 必须按操作名对齐：守住位置 两张映射表；改错故障 操作与校验器错配。
// INV-18 连接错误只保留分类，不携带服务端正文：守住位置 错误类；改错故障 令牌或正文进入日志。
//
// 模块职责：定义 Web 远控中继 V2 的 WebSocket 消息与 HTTP 接口契约，并提供安全解析入口。
// 状态所有权：全部是 schema 与纯解析函数；连接状态归调用方，本模块不持有运行时数据。
// 阅读顺序：先看基础标量，再读出站与入站消息，最后看 HTTP 路由、请求响应与错误分类。
import { z } from "zod";

// 请求与 WebSocket 消息严格校验 V2，HTTP 响应允许新增字段。
const unixSeconds = z.number().int().min(0).max(253_402_300_799);
// 长度上限覆盖会话与设备标识。
// trim 后仍为空视为非法。
// 设备标识额外按 UTF-8 字节数限制。
// 所有标识类字段都复用同一基础校验。
const identifier = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const deviceSid = identifier.refine((value) => new TextEncoder().encode(value).length <= 128);
const meta = z.strictObject({
  name: z.string().optional(),
  platform: z.string().optional(),
  version: z.string().optional(),
});
const role = z.enum(["device", "terminal"]);
const pairStatus = z.enum(["waiting", "matched"]);
const errorCode = z.enum(["AUTH_FAILED", "WRONG_PARAM", "KICKED", "INTERNAL", "DEVICE_OFFLINE"]);
// auth_init 只携带设备标识与可选元数据，类型字段由字面量固定。
// client_ts 允许缺省，服务端按到达时间补齐。
// strictObject 拒绝未声明字段，旧客户端多传的键会直接失败。
const authInit = z.strictObject({
  type: z.literal("auth_init"),
  device_sid: deviceSid,
  meta: meta.optional(),
  client_ts: unixSeconds.optional(),
});

export type WebRemoteControlRelayV2Role = z.infer<typeof role>;
export type WebRemoteControlRelayV2PairStatus = z.infer<typeof pairStatus>;
export type WebRemoteControlRelayV2ErrorCode = z.infer<typeof errorCode>;
export type WebRemoteControlRelayV2Meta = z.infer<typeof meta>;
export type WebRemoteControlRelayV2AuthInit = z.infer<typeof authInit>;

const pairStatusQuery = z.strictObject({
  type: z.literal("pair_status_query"),
  client_ts: unixSeconds.optional(),
});
const outgoingData = z.strictObject({
  type: z.literal("data"),
  payload: z.json(),
  client_ts: unixSeconds.optional(),
});
const outgoingMessage = z.discriminatedUnion("type", [authInit, pairStatusQuery, outgoingData]);
export type WebRemoteControlRelayV2PairStatusQuery = z.infer<typeof pairStatusQuery>;
export type WebRemoteControlRelayV2OutgoingData = z.infer<typeof outgoingData>;
export type WebRemoteControlRelayV2OutgoingMessage = z.infer<typeof outgoingMessage>;

// safeParse 不抛异常，解析失败只返回 null。
// 成功时返回按 type 判别的联合类型，调用方无需再收窄。
// 失败统一返回 null，重连或忽略由调用方决定。
export function parseWebRemoteControlRelayV2OutgoingMessage(
  value: unknown,
): WebRemoteControlRelayV2OutgoingMessage | null {
  const result = outgoingMessage.safeParse(value);
  return result.success ? result.data : null;
}

const authAck = z.strictObject({
  type: z.literal("auth_ack"),
  device_sid: deviceSid,
  terminal_sid: z.string().optional(),
  pair_status: pairStatus,
  server_ts: unixSeconds.optional(),
});
const pairStatusAck = z.strictObject({
  type: z.literal("pair_status_ack"),
  terminal_sid: z.string().optional(),
  pair_status: pairStatus,
  server_ts: unixSeconds.optional(),
});
const incomingData = z.strictObject({
  type: z.literal("data"),
  payload: z.json(),
  server_ts: unixSeconds.optional(),
});
const relayError = z.strictObject({
  type: z.literal("error"),
  code: errorCode,
  message: z.string().optional(),
  server_ts: unixSeconds.optional(),
});
const incomingMessage = z.discriminatedUnion("type", [
  authAck,
  pairStatusAck,
  incomingData,
  relayError,
]);
export type WebRemoteControlRelayV2AuthAck = z.infer<typeof authAck>;
export type WebRemoteControlRelayV2PairStatusAck = z.infer<typeof pairStatusAck>;
export type WebRemoteControlRelayV2IncomingData = z.infer<typeof incomingData>;
export type WebRemoteControlRelayV2Error = z.infer<typeof relayError>;
export type WebRemoteControlRelayV2IncomingMessage = z.infer<typeof incomingMessage>;

// 入站解析同样走 safeParse，失败只返回 null。
// 数据帧与错误帧靠 type 字面量区分，无需嗅探载荷。
// 解析失败返回 null 而不透传原始载荷，避免未校验数据进入上层。
export function parseWebRemoteControlRelayV2IncomingMessage(
  value: unknown,
): WebRemoteControlRelayV2IncomingMessage | null {
  const result = incomingMessage.safeParse(value);
  return result.success ? result.data : null;
}

export const WEB_REMOTE_CONTROL_RELAY_V2_HTTP = {
  register: { method: "POST", path: "/api/v1/remote/device" },
  list: { method: "GET", path: "/api/v1/remote/device" },
  delete: { method: "POST", path: "/api/v1/remote/device/delete" },
  token: { method: "POST", path: "/api/v1/remote/token" },
} as const;
export const WEB_REMOTE_CONTROL_RELAY_V2_WS_PATH = "/api/v1/remote/ws2";
export type WebRemoteControlRelayV2HttpOperation = keyof typeof WEB_REMOTE_CONTROL_RELAY_V2_HTTP;

// 每个操作声明独立请求 schema。
// register 与 delete 只收必要标识，多余字段被 strictObject 拒绝。
// list 请求是空 strictObject，严格模式下也不接受额外字段。
// token 请求只需 role，角色枚举决定签发范围。
const httpRequests = {
  register: z.strictObject({ device_mid: identifier }),
  list: z.strictObject({}),
  delete: z.strictObject({ device_sid: identifier }),
  token: z.strictObject({ role }),
};
// 服务端新增响应字段应向后兼容；z.object 校验已声明字段并剥离未知字段，嵌套对象同理。
const device = z.object({
  device_sid: deviceSid,
  device_mid: identifier,
  online: z.boolean(),
  created_at: unixSeconds,
  meta: z.object(meta.shape),
});
const token = z.object({
  // 16 字节无填充 Base64URL 的末字符只能使用高两位。
  token: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/),
  expires_in: z.number().int().positive(),
});
const httpError = z.object({
  code: z
    .number()
    .int()
    .refine((value) => value !== 0),
  msg: z.string(),
  data: z.null().optional(),
});
function response<T extends z.ZodType>(data: T) {
  return z.union([z.object({ code: z.literal(0), msg: z.string(), data }), httpError]);
}
// 成功与错误响应组成 z.union，调用方按 code 分支。
// list 响应复用 device 数组，避免两套字段定义漂移。
// delete 响应允许 data 省略，对应 Go 的 omitempty 行为。
// device 用 z.object 而非 strict，服务端新增字段不会让旧客户端失败。
const httpResponses = {
  register: response(device),
  list: response(z.array(device)),
  // Go Response.Data 带 omitempty：删除成功/失败可能省略 data。
  delete: response(z.null().optional()),
  token: response(token),
};
export type WebRemoteControlRelayV2Device = z.infer<typeof device>;
export type WebRemoteControlRelayV2Token = z.infer<typeof token>;
export type WebRemoteControlRelayV2HttpError = z.infer<typeof httpError>;
export type WebRemoteControlRelayV2HttpRequest<K extends WebRemoteControlRelayV2HttpOperation> =
  z.infer<(typeof httpRequests)[K]>;
export type WebRemoteControlRelayV2HttpResponse<K extends WebRemoteControlRelayV2HttpOperation> =
  z.infer<(typeof httpResponses)[K]>;

const requestSchemas: {
  [K in WebRemoteControlRelayV2HttpOperation]: z.ZodType<WebRemoteControlRelayV2HttpRequest<K>>;
} = httpRequests;
const responseSchemas: {
  [K in WebRemoteControlRelayV2HttpOperation]: z.ZodType<WebRemoteControlRelayV2HttpResponse<K>>;
} = httpResponses;

// 按操作名从映射表取出对应 schema。
// safeParse 失败返回 null，不向调用方抛异常。
// 泛型 K 与操作名绑定，返回值类型随操作自动收窄。
// 响应解析复用同一套模式，只把映射表换成 responseSchemas。
export function parseWebRemoteControlRelayV2HttpRequest<
  K extends WebRemoteControlRelayV2HttpOperation,
>(operation: K, value: unknown): WebRemoteControlRelayV2HttpRequest<K> | null {
  const schema: z.ZodType<WebRemoteControlRelayV2HttpRequest<K>> = requestSchemas[operation];
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseWebRemoteControlRelayV2HttpResponse<
  K extends WebRemoteControlRelayV2HttpOperation,
>(operation: K, value: unknown): WebRemoteControlRelayV2HttpResponse<K> | null {
  const schema: z.ZodType<WebRemoteControlRelayV2HttpResponse<K>> = responseSchemas[operation];
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

/** HTTP 错误只保留分类，避免 JWT、token URL 或服务端正文进入日志与 renderer。 */
export class WebRemoteControlV2ConnectionError extends Error {
  constructor(
    readonly reason: "auth-required" | "relay-unavailable",
    readonly retryable = false,
  ) {
    super(reason);
    this.name = "WebRemoteControlV2ConnectionError";
  }
}
