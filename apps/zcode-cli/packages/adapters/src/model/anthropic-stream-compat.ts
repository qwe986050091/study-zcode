// ============================================================
// ==== model/anthropic-stream-compat ====
// ============================================================
// 定位：Anthropic 兼容网关的 fetch 层补丁，在请求发送前后修正 AI SDK 与网关之间的
//   消息边界、system 内容形状、thinking 签名与非法 tool_result 形状。
// 输入：被包装的 baseFetch、RequestInit、HTTP Response（SSE 或 JSON）。
// 输出：包裹后的 fetch；请求体可能被重新序列化，响应体可能被流式改写或整体替换。
// 副作用：读取并克隆响应体；网络由 baseFetch 执行；不写文件/数据库。
// 失败语义：任何 JSON/SSE 解析失败都“原样透传”，不因补丁自身缺陷中断上游响应；
//   流式 transform 只丢弃/注入帧，不抛出。
// 不变量：只修改必要的 wire shape（message 拆分、string content、签名 delta），
//   其余事件、顺序、headers/status 保持不变；改写后删除 content-length/content-encoding。

type ProviderFetch = typeof globalThis.fetch;

const SSE_FRAME_SEPARATOR_PATTERN = /\r\n\r\n|\n\n|\r\r/;

/**
 * 创建带 Anthropic 兼容修复的 fetch 包装：请求前修 body，响应后修 stream/JSON。
 * 输入：baseFetch 由调用方提供，保留原有鉴权、代理与重试行为。
 * 输出：同签名的 fetch，response body 可能是经过 TransformStream 的新流。
 * 副作用：请求体仅在确实需要修复时重新 JSON.stringify；响应体对 SSE 采用管道转发。
 * 失败语义：不吞掉 baseFetch 的错误；补丁步骤失败时回退为原始请求/响应。
 */
export function createAnthropicCompatFetch(baseFetch: ProviderFetch): ProviderFetch {
  return async (input, init) => {
    const response = await baseFetch(input, applyAnthropicRequestBodyCompatibility(init));
    return rewriteAnthropicJsonThinkingResponse(filterAnthropicStream(response));
  };
}

/** 语义化别名：该 fetch 同时兼容流式与非流式响应。 */
export const createAnthropicStreamCompatFetch = createAnthropicCompatFetch;

/**
 * 请求体兼容入口：仅在 body 为字符串且能解析为对象时才尝试修复，否则原样返回 init。
 * 输出：需要修复时返回带新 body 的 init 副本；无修复时返回原 init 引用（避免无谓重建）。
 */
function applyAnthropicRequestBodyCompatibility(
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;

  const body = safeParseRecord(init.body);
  if (!body) return init;
  const restoredSelectorBody = restoreMemorySelectorMessageBoundaries(body);
  const restoredSystemBody = restoreMidConversationSystemStringContent(restoredSelectorBody);
  if (restoredSystemBody === body) return init;

  return {
    ...init,
    body: JSON.stringify(restoredSystemBody),
  };
}

/**
 * 把被 AI SDK 合并的 memory selector 首条 user 消息重新拆成两条独立消息。
 * 仅当 output_config 为 selector 的 json_schema 且首条 user 内容恰好是两段固定前缀文本时生效。
 * 输出：符合条件时返回新 body（拆分 messages），否则原样返回。
 * 不变量：拆分后 manifest 与 query 各自独立，满足 provider-visible 基线。
 */
function restoreMemorySelectorMessageBoundaries(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = Array.isArray(body?.messages) ? body.messages : undefined;
  const firstMessage = safeRecord(messages?.[0]);
  const content = Array.isArray(firstMessage?.content) ? firstMessage.content : undefined;
  if (
    !isMemorySelectorOutput(body?.output_config) ||
    firstMessage?.role !== "user" ||
    content?.length !== 2 ||
    !hasTextPrefix(content[0], "Available memories:\n") ||
    !hasTextPrefix(content[1], "Select memories relevant to:\n")
  ) {
    return body;
  }

  // 修复原因：AI SDK 会在发请求前合并连续的 user message；Memory selector 的
  // provider-visible 基线要求 manifest 与当前 query 保持为两个独立 message。
  return {
    ...body,
    messages: [
      { ...firstMessage, content: [content[0]] },
      { role: "user", content: [content[1]] },
      ...messages!.slice(1),
    ],
  };
}

/**
 * 把会话中 system 角色消息的单文本 block 数组还原为 string content。
 * 输出：有改动时新 body，否则原引用；只处理 messages[] 内的 system，顶层 system 与
 *   带 cache_control 的 block 不动。
 */
function restoreMidConversationSystemStringContent(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;

  let changed = false;
  const messages = body.messages.map((value) => {
    const message = safeRecord(value);
    if (message?.role !== "system") return value;
    const text = singlePlainTextBlock(message.content);
    if (text === undefined) return value;

    changed = true;
    return { ...message, content: text };
  });

  // 在最终 messages[] 中保留 string content；
  // AI SDK 会将同一纯文本扩成单元素 block array。这里只恢复该 wire shape，顶层
  // system[]、带 cache_control 的 block 和其他 message role 均保持原样。
  return changed ? { ...body, messages } : body;
}

/**
 * 识别“恰好一个纯 text block”的内容数组并取出文本；block 含 type/text 以外字段（如缓存控制）即放弃。
 */
function singlePlainTextBlock(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const block = safeRecord(value[0]);
  if (block?.type !== "text" || typeof block.text !== "string") return undefined;
  if (Object.keys(block).some((key) => key !== "type" && key !== "text")) return undefined;
  return block.text;
}

/** 依据 output_config.format.schema.required 是否含 selected_memories 识别 memory selector 请求。 */
function isMemorySelectorOutput(value: unknown): boolean {
  const outputConfig = safeRecord(value);
  const format = safeRecord(outputConfig?.format);
  const schema = safeRecord(format?.schema);
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return format?.type === "json_schema" && required.includes("selected_memories");
}

/** 判断块是否为以指定前缀开头的 text，用于精确识别 selector 的两段固定提示。 */
function hasTextPrefix(value: unknown, prefix: string): boolean {
  const block = safeRecord(value);
  return block?.type === "text" && typeof block.text === "string" && block.text.startsWith(prefix);
}

/** 仅当 content-type 含 event-stream 时才需要流式改写；其他响应保持原 body。 */
function shouldFilterAnthropicStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

/**
 * 用 TransformStream 包裹 SSE body；无 body 时原样返回。
 * 副作用：返回新 Response，复制原 headers 并删除 content-length/content-encoding
 *   （长度与编码会因改写而失效，保留会误导下游）。
 */
function filterAnthropicStream(response: Response): Response {
  if (!shouldFilterAnthropicStream(response)) {
    return response;
  }

  const body = response.body;
  if (!body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Response(body.pipeThrough(createAnthropicStreamCompatTransform()), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * 非流式 JSON 响应中的无签名 thinking 块就地清洗，避免 AI SDK 按原生 schema 校验失败。
 * 输入：Response；仅 JSON content-type 才处理。
 * 输出：无改动时原 Response（不消耗 body）；有改动时克隆并重建文本响应。
 * 失败语义：JSON 解析失败直接原样返回，不抛错。
 */
async function rewriteAnthropicJsonThinkingResponse(response: Response): Promise<Response> {
  if (!shouldRewriteAnthropicJson(response)) {
    return response;
  }

  const text = await response.clone().text();
  const parsed = safeParseRecord(text);
  if (!parsed) {
    return response;
  }

  const sanitized = sanitizeJsonThinkingBlocks(parsed);
  if (!sanitized.changed) {
    return response;
  }

  return cloneTextResponse(response, JSON.stringify(sanitized.value));
}

/** content-type 含 application/json 或 +json 才视为可解析的 JSON 响应。 */
function shouldRewriteAnthropicJson(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json") || contentType.includes("+json");
}

/** 用新文本重建 Response；删除内容相关 headers，保留 status/statusText 与原 content-type。 */
function cloneTextResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * 删除 JSON 响应 content 中的无签名 thinking 块。
 * 输出：{changed, value}；changed=false 时 value 即入参引用，调用方无需重建响应。
 */
function sanitizeJsonThinkingBlocks(value: Record<string, unknown>): {
  changed: boolean;
  value: Record<string, unknown>;
} {
  if (!Array.isArray(value.content)) {
    return { changed: false, value };
  }

  const content = value.content.filter((block) => !isUnsignedThinkingBlock(block));
  if (content.length === value.content.length) {
    return { changed: false, value };
  }

  return {
    changed: true,
    value: {
      ...value,
      content,
    },
  };
}

/**
 * 是否为 type=thinking 且既无 signature 也无 redactedData 的块；这类块无法被 AI SDK 校验。
 * 有任一签名字段则保留，交由上层正常解析。
 */
function isUnsignedThinkingBlock(value: unknown): boolean {
  const block = safeRecord(value);
  if (block?.type !== "thinking") {
    return false;
  }

  // 部分 Anthropic-compatible 服务在非流式 JSON 中返回无签名
  // thinking block。AI SDK 会按 Anthropic 原生 schema 校验 signature 并拒绝
  // 整个响应；这里删除不可校验的思考块，保留 text/usage/stop_reason 继续解析。
  return typeof block.signature !== "string" && typeof block.redactedData !== "string";
}

interface AnthropicStreamCompatState {
  /** 已收到 thinking start 中签名、但尚未见到原生 signature_delta 的块下标 -> 签名。 */
  pendingThinkingSignatures: Map<number, string>;
  /** 需要在 stop 前整体丢弃的 content block 下标（非标准 tool_result）。 */
  suppressedIndexes: Set<number>;
}

/**
 * 创建按 SSE 帧处理的 TransformStream：跨 chunk 拼接完整帧后再决定丢弃/注入/透传。
 * 不变量：state 在每个 message_start 重置，保证不同消息的签名与抑制标记不串扰。
 */
function createAnthropicStreamCompatTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: AnthropicStreamCompatState = {
    pendingThinkingSignatures: new Map(),
    suppressedIndexes: new Set(),
  };
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      pending = emitCompleteFrames(pending, controller, encoder, state);
    },
    flush(controller) {
      pending += decoder.decode();
      pending = emitCompleteFrames(pending, controller, encoder, state);
      if (pending.length > 0) {
        emitFrame(pending, "", controller, encoder, state);
      }
    },
  });
}

/**
 * 从待处理文本中切出所有完整 SSE 帧并逐帧发射，返回仍未闭合的尾部残片。
 * 不变量：帧分隔符原样随帧输出，保证下游按原始换行风格解析。
 */
function emitCompleteFrames(
  input: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicStreamCompatState,
): string {
  let pending = input;
  for (;;) {
    const match = SSE_FRAME_SEPARATOR_PATTERN.exec(pending);
    if (!match) {
      return pending;
    }

    const separator = match[0] ?? "";
    const frame = pending.slice(0, match.index);
    pending = pending.slice(match.index + separator.length);
    emitFrame(frame, separator, controller, encoder, state);
  }
}

/**
 * 按 decideFrame 结果输出一帧：false 丢弃（抑制块），对象则先注入合成 signature_delta 再输出原帧。
 * 副作用：向 controller 入队 0~2 个编码后的 Uint8Array。
 */
function emitFrame(
  frame: string,
  separator: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: AnthropicStreamCompatState,
): void {
  const decision = decideFrame(frame, state);
  if (decision === false) {
    return;
  }

  if (decision !== true) {
    controller.enqueue(encoder.encode(createSignatureDeltaFrame(decision, separator)));
  }
  controller.enqueue(encoder.encode(`${frame}${separator}`));
}

/**
 * 决定单帧命运：true=原样透传；false=丢弃；对象=需要补一个 signature_delta。
 * 输入：SSE 帧文本 + 可变 state（记录 thinking 签名与待抑制下标）。
 * 不变量：message_start 时清空 state；非 JSON/[DONE]/无 index 的帧一律透传，避免误伤协议帧。
 */
function decideFrame(
  frame: string,
  state: AnthropicStreamCompatState,
): boolean | { index: number; signature: string } {
  const data = readSseData(frame);
  if (data === undefined || data === "[DONE]") {
    return true;
  }

  const parsed = safeParseRecord(data);
  if (!parsed) {
    return true;
  }

  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  if (type === "message_start") {
    state.pendingThinkingSignatures.clear();
    state.suppressedIndexes.clear();
    return true;
  }

  const index = typeof parsed.index === "number" ? parsed.index : undefined;
  if (index === undefined) {
    return true;
  }

  if (type === "content_block_start") {
    const block = safeRecord(parsed.content_block);
    if (
      block?.type === "thinking" &&
      typeof block.signature === "string" &&
      block.signature.length > 0
    ) {
      state.pendingThinkingSignatures.set(index, block.signature);
    }

    // Some Anthropic-compatible APIs expose provider-internal image tool results as
    // assistant-side bare tool_result blocks. AI SDK rejects that non-standard shape.
    if (block?.type === "tool_result") {
      state.suppressedIndexes.add(index);
      return false;
    }
  }

  if (type === "content_block_delta" && safeRecord(parsed.delta)?.type === "signature_delta") {
    state.pendingThinkingSignatures.delete(index);
  }

  let missingSignatureDelta: { index: number; signature: string } | undefined;
  if (type === "content_block_stop") {
    const signature = state.pendingThinkingSignatures.get(index);
    state.pendingThinkingSignatures.delete(index);
    if (signature) {
      // 部分 Anthropic-compatible 服务把最终签名直接放在 thinking start，
      // 但 AI SDK 只从 signature_delta 读取签名；仅在缺少原生 delta 时补成标准事件。
      missingSignatureDelta = { index, signature };
    }
  }

  if (state.suppressedIndexes.has(index)) {
    if (type === "content_block_stop") {
      state.suppressedIndexes.delete(index);
    }
    return false;
  }

  return missingSignatureDelta ?? true;
}

/**
 * 构造标准 content_block_delta/signature_delta 帧，行尾风格与相邻分隔符保持一致。
 * separator 为空（flush 尾帧）时退回 "\n\n"，保证生成帧自身合法。
 */
function createSignatureDeltaFrame(
  value: { index: number; signature: string },
  separator: string,
): string {
  const frameSeparator = separator || "\n\n";
  const lineEnding =
    frameSeparator === "\r\n\r\n" ? "\r\n" : frameSeparator === "\r\r" ? "\r" : "\n";
  const data = JSON.stringify({
    type: "content_block_delta",
    index: value.index,
    delta: { type: "signature_delta", signature: value.signature },
  });
  return `event: content_block_delta${lineEnding}data: ${data}${frameSeparator}`;
}

/**
 * 提取 SSE 帧中的 data 行并按协议用 "\n" 连接；无 data 行返回 undefined（如纯注释/事件行）。
 */
function readSseData(frame: string): string | undefined {
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (!rawLine.startsWith("data:")) {
      continue;
    }

    let value = rawLine.slice("data:".length);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    dataLines.push(value);
  }

  return dataLines.length === 0 ? undefined : dataLines.join("\n");
}

/** 解析 JSON 并收窄为普通对象；解析失败或形状非对象返回 undefined（调用方据此透传）。 */
function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return safeRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** 仅接受非 null、非数组的对象；其余值返回 undefined，供各解析步骤统一防御。 */
function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
