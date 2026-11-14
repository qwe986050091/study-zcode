/**
 * ============================================================================
 * http/response-body.ts —— 响应正文读取与大小上限
 * ============================================================================
 *
 * 【定位】把 ResponseLike 的 body 流合并为 Uint8Array，并在读取过程中执行
 * 字节上限（先 content-length 预检、后累计兜底）。
 *
 * 【失败语义】maxResponseBytes 为负、content-length 超限或累计超限都抛
 * HttpClientPortError(code="too_large")；取消抛 cancelled。超限时会先
 * reader.cancel() 释放底层连接，避免继续下载。
 *
 * 【口径】无 body 流（204/304 等）返回空数组；返回值一定是完整正文，
 * 不会返回部分数据。
 * ============================================================================
 */
import { createHttpClientError } from "@zcode/contracts";

/**
 * 读正文所需的最小形状：原生 fetch 的 `Response` 与 adapter 自己读出的 `IncomingResponse` 都满足它。
 * 不要求是 `Response`：后者表示不了 200–599 之外的状态码（network/incoming-response.ts）。
 */
export interface ResponseLike {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * 读取并合并响应正文。
 *
 * 输入 response 只需提供 status/headers/body；maxResponseBytes 是硬上限；
 * signal 用于在分块之间打断长时间下载。返回完整 Uint8Array（空正文为空数组）。
 * 超限/取消都抛 HttpClientPortError，不返回截断内容。
 */
export async function readResponseBody(
  response: ResponseLike,
  maxResponseBytes: number,
  signal: AbortSignal,
  url: string,
): Promise<Uint8Array> {
  if (maxResponseBytes < 0) {
    throw createHttpClientError({
      code: "too_large",
      url,
      status: response.status,
      message: "HTTP response size limit must not be negative",
    });
  }

  // content-length 预检能在下载前就拒绝超大响应，节省带宽；不可信/缺失时靠累计兜底。
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxResponseBytes) {
      throw createHttpClientError({
        code: "too_large",
        url,
        status: response.status,
        message: `HTTP response is too large: content-length=${parsed}, max=${maxResponseBytes}`,
      });
    }
  }

  // 没有正文流只发生在无正文状态（204 / 304 …）：正文就是空的。
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    if (signal.aborted) {
      throw createHttpClientError({
        code: "cancelled",
        url,
        status: response.status,
        message: "HTTP request was cancelled while reading response body",
      });
    }

    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    // 分块累计兜底 content-length 缺失/撒谎的情况；先 cancel 再抛，尽快释放连接。
    if (total > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw createHttpClientError({
        code: "too_large",
        url,
        status: response.status,
        message: `HTTP response is too large: bytes>${maxResponseBytes}`,
      });
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
