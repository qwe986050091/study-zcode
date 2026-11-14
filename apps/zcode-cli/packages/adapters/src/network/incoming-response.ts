// ============================================================
// 文件定位：把 Node http.IncomingMessage 转成 adapter 内部响应，再按需转 WHATWG Response。
// 输入输出：输入 IncomingMessage，输出 {status, statusText, headers, body 流或 null}。
// 副作用：无正文状态会 resume 读完消息，让 socket 归还连接池；body 为只读流。
// 失败语义：状态码不裁剪；表示不了（<200 或 >599）时抛 UnsupportedHttpStatusError（TypeError 子类）。
// 不变量：无正文状态绝不给 body；每次转换只消费一次消息，避免流被多方读取。
// ============================================================
import type http from "node:http";
import { Readable } from "node:stream";

/**
 * adapter 自己发请求时（代理、自定义 CA、公网 DNS 校验），把 Node 的 `IncomingMessage` 交给上层的唯一入口
 * （docs/design/v2/model/http-proxy.md「行为」）。
 *
 * 修复原因（2026-09-29 实测）：两处 adapter 都在 `http.request` 的回调里直接
 * `new Response(stream, { status })`。WHATWG `Response` 只收 200–599，204 / 205 / 304 还不许挂正文；
 * LinkedIn 对爬虫回 999，构造函数在回调里抛 RangeError，没人接得住，agent 进程以 uncaughtException
 * 退出，同一工作区的会话和 run 一起断了。所以：状态码原样读出来，无正文状态不给流，能不能变成
 * `Response` 由 {@link toWebResponse} 单独判断、以普通 reject 失败。
 */

/** Fetch 规范的 null body status：这些响应没有正文，`Response` 也不许给它们挂正文。 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);
/** `Response` 能表示的状态码区间（含两端）。 */
const MIN_WEB_RESPONSE_STATUS = 200;
const MAX_WEB_RESPONSE_STATUS = 599;
/** Node 没给状态码时（理论上不会）按网关错误对待，与此前的兜底一致。 */
const MISSING_STATUS = 502;

export const UNSUPPORTED_HTTP_STATUS_CODE = "ZCODE_UNSUPPORTED_HTTP_STATUS";

/** 原样读出的响应：状态码不做任何裁剪，正文是流（无正文状态为 `null`）。 */
export interface IncomingResponse {
  // 原始状态码，范围不限（可含 999 等非标准值）；缺失时为 502。
  status: number;
  // 状态文本；Node 未提供时为空串。
  statusText: string;
  // 响应头；同名多值已合并追加，大小写不敏感。
  headers: Headers;
  // 正文流；无正文状态（101/103/204/205/304）时为 null。
  body: ReadableStream<Uint8Array> | null;
}

/**
 * `Response` 表示不了的状态码。形状跟随原生 fetch 的网络失败（`TypeError`），调用方按错误码而不是文本区分。
 */
export class UnsupportedHttpStatusError extends TypeError {
  // 稳定错误码，调用方可按 code 而非错误文本分支。
  readonly code = UNSUPPORTED_HTTP_STATUS_CODE;

  // status 保留原始值，便于上层日志直接展示“服务器到底回了什么”。
  constructor(readonly status: number) {
    super(
      `HTTP response status ${status} is outside ${MIN_WEB_RESPONSE_STATUS}-${MAX_WEB_RESPONSE_STATUS} and cannot be returned as a fetch Response`,
    );
  }
}

/**
 * 从 IncomingMessage 读出状态、头与正文流；状态码缺失时按 502 兜底。
 * 无正文状态会主动 resume 读取剩余报文，确保 keep-alive 连接可被复用。
 */
export function readIncomingResponse(message: http.IncomingMessage): IncomingResponse {
  const status = message.statusCode ?? MISSING_STATUS;
  const headers = new Headers();
  // Node 头值可能是数组（如 set-cookie）；逐项 append 保留多值语义，而不是覆盖。
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, String(value));
    }
  }
  const nullBody = NULL_BODY_STATUSES.has(status);
  // 无正文状态照样把消息读完，socket 才能回到连接池。
  if (nullBody) message.resume();
  return {
    body: nullBody ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>),
    headers,
    status,
    statusText: message.statusMessage ?? "",
  };
}

/** 交给只认 `Response` 的调用方（proxy-aware fetch）；表示不了的状态码抛 {@link UnsupportedHttpStatusError}。 */
// 这里才做 200–599 校验：让“读响应”与“能否变成 Response”解耦，避免状态码在回调里炸掉进程。
export function toWebResponse(incoming: IncomingResponse): Response {
  if (incoming.status < MIN_WEB_RESPONSE_STATUS || incoming.status > MAX_WEB_RESPONSE_STATUS) {
    throw new UnsupportedHttpStatusError(incoming.status);
  }
  return new Response(incoming.body, {
    headers: incoming.headers,
    status: incoming.status,
    statusText: incoming.statusText,
  });
}
