// ============================================================
// Option Map 请求体注入（fetch 包装）
// 定位：reasoning / max-output 等字段由 model-option-map 编译结果决定，必须在 SDK 序列化后、
// 发送前改写 JSON body，避免 SDK 参数表成为第二真相源。
// 输入：底层 fetch + 编译后的 maps + 调用参数值 + 可选 capture（回填最终 body 供调试）。
// 输出：新的 fetch；每次调用读 body→apply→JSON.stringify 后转发。
// 副作用：可能替换 Request 对象并写 capture.body（调试观测）。失败语义：body 非 JSON 文本/非对象时
// 抛错 fail-closed，宁可失败也不静默发出缺字段的请求。
// 不变量：非 RequestInfo 且无 body 的调用原样透传；patch 只发生一次，不累加。
// ============================================================

import type {
  CompiledModelOptionMaps,
  JsonObject,
  ModelOptionValues,
} from "@zcode/model-option-map";

type ProviderFetch = typeof globalThis.fetch;

/** 调试用：apply 后的最终请求体；未捕获时 undefined（调用方按"未知"处理）。 */
export interface RawRequestBodyCapture {
  body?: JsonObject;
}

/**
 * 构造带 Option Map 注入的 fetch。
 * 没有可读 body 的请求直接透传（如 GET 或 SDK 自带流式 body 的非常规调用）；
 * 有 body 时必然改写并重新构造 Request，保证 Content-Length 等派生头与正文一致。
 */
export function createModelOptionMapFetch(input: {
  readonly capture?: RawRequestBodyCapture;
  readonly fetch: ProviderFetch;
  readonly maps: CompiledModelOptionMaps;
  readonly values: ModelOptionValues;
}): ProviderFetch {
  return async (request, init) => {
    const bodyText = await readRequestBody(request, init);
    if (bodyText === undefined) return input.fetch(request, init);
    const body = parseJsonObject(bodyText);
    const patched = input.maps.apply(body, input.values);
    if (input.capture) input.capture.body = patched;
    const patchedBody = JSON.stringify(patched);
    if (request instanceof Request) {
      return input.fetch(new Request(request, { ...init, body: patchedBody }));
    }
    return input.fetch(request, { ...init, body: patchedBody });
  };
}

/**
 * 读取请求体文本。
 * init.body 为字符串时直接使用；为 Request 时 clone 后读取（不消费原 body）；
 * 两者都没有则 undefined，表示该调用不需要 Option Map。
 */
async function readRequestBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  // Option Map 是 reasoning/max-output 的唯一请求字段权威。若 SDK 改成非文本 Body 却静默
  // 跳过 Patch，请求仍会发出但丢失两个 Option；因此有 Body 时必须 fail-closed。
  if (init?.body !== undefined && init.body !== null) {
    throw new Error("Model option maps require a JSON text request body.");
  }
  if (request instanceof Request) return request.clone().text();
  return undefined;
}

/** 解析并校验 body 必须是 JSON 对象（非数组/null）；否则抛错，阻止缺字段请求被发出。 */
function parseJsonObject(body: string): JsonObject {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model option maps require a JSON object request body.");
  }
  return parsed as JsonObject;
}
