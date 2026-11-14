// ============================================================
// OpenAI Responses 非流式 JSON 兼容修补
// 定位：部分 Responses-compatible 服务在 compact 等非流式响应里缺字段，AI SDK 会拒绝整个 200 响应。
// 输入：底层 fetch。输出：新 fetch；仅在"非流式 JSON 且确有可修补字段"时替换 Response。
// 副作用：读取并复制响应体（clone），重建 Response 并删除 content-length/content-encoding。
// 失败语义：JSON 解析失败/形态不符时原样返回原始 Response，不影响正常路径。
// 不变量：流式（event-stream）响应与出错响应一律不触碰；只在确需修补时 changed=true。
// ============================================================

import { randomUUID } from "node:crypto";

type ProviderFetch = typeof globalThis.fetch;

/**
 * 包装 fetch：先取原始响应，非 2xx 或 SSE 直接透传；否则尝试 JSON 修补。
 * 修补仅发生在 normalize 返回非 undefined 时；重建 Response 前必须删掉 content-length/
 * content-encoding，否则与新的正文长度/编码不一致会导致下游解析失败。
 */
export function createOpenAIResponsesJsonCompatFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.ok || isEventStream(response)) {
      return response;
    }

    const body = await parseJsonObject(response);
    if (!body) {
      return response;
    }

    const normalized = normalizeOpenAIResponsesJson(body);
    if (!normalized) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");

    return new Response(JSON.stringify(normalized), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

/**
 * 修补 Responses JSON：为缺失 id 的 message 补 `msg_<uuid>`，为缺 annotations 的 output_text 补空数组。
 * 返回 undefined 表示无可修补内容（调用方应原样透传，避免无意义地重建响应）；
 * 返回新对象时只替换 output 字段，其余字段保持引用不变。
 */
export function normalizeOpenAIResponsesJson(value: unknown): Record<string, unknown> | undefined {
  const response = asRecord(value);
  if (!response || !Array.isArray(response.output)) {
    return undefined;
  }

  const responseId =
    typeof response.id === "string" && response.id.length > 0 ? response.id : undefined;
  let changed = false;
  const output = response.output.map((item) => {
    const message = asRecord(item);
    if (message?.type !== "message") {
      return item;
    }

    let normalizedMessage = message;
    if (message.id === undefined && responseId) {
      // 部分 Responses-compatible 服务在非流式 compact 响应里省略
      // message.id，AI SDK 会在读取正文前拒绝整个 HTTP 200 响应。
      normalizedMessage = {
        ...normalizedMessage,
        id: `msg_${randomUUID()}`,
      };
      changed = true;
    }

    if (!Array.isArray(message.content)) {
      return normalizedMessage;
    }

    let contentChanged = false;
    const content = message.content.map((itemContent) => {
      const outputText = asRecord(itemContent);
      if (outputText?.type !== "output_text" || outputText.annotations !== undefined) {
        return itemContent;
      }

      contentChanged = true;
      return { ...outputText, annotations: [] };
    });

    if (!contentChanged) {
      return normalizedMessage;
    }

    changed = true;
    return { ...normalizedMessage, content };
  });

  return changed ? { ...response, output } : undefined;
}

/** 识别 SSE：content-type 含 event-stream 即视为流式，绝不缓冲改写。 */
function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

/** clone 后解析 JSON 对象；解析失败或非对象返回 undefined（交由上游按原始响应处理）。 */
async function parseJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(JSON.parse(await response.clone().text()));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
