// ==== model/provider-endpoint-routing-fetch.ts ====
// 定位：在 fetch 层插入 endpoint-routing 决策，把请求改写到端口解析出的 URL 并附加路由头。
// 输入：原始 fetch、路由端口、可选 apiKeyId；每次调用再接收 fetch 的 (input, init)。
// 输出：可替换 globalThis.fetch 的函数；未路由时行为与原始 fetch 完全一致。
// 副作用：可能发起一次 routingPort.resolve（可能含网络），并改写 Request URL/headers。
// 失败语义：URL 解析失败或端口未命中都退回原始 fetch；resolve 抛错直接冒泡给调用方。
// 不变量：改写只在 routed=true 时发生；host 头始终被移除，路由头覆盖同名请求头。
import type { ProviderEndpointRoutingPort, TraceContext } from "@zcode/contracts";

const TRACE_HEADER = "x-zcode-trace-id";

/** 与原生 fetch 同构的类型别名，便于整体替换全局 fetch。 */
export type ProviderEndpointRoutingFetch = typeof globalThis.fetch;

/**
 * 基于路由端口包装 fetch。
 * 每个请求先解析真实 URL，再询问 routingPort 是否需要改写到别的 endpoint；
 * 命中时重写 input 并合并路由决策头，未命中或无法解析时原样转发。
 * apiKeyId 只能来自账号 owner 的配置，不从模型 PAT/手工 Key 推导，避免越权路由。
 * 返回的闭包无共享可变状态；决策失败会直接抛错，不做静默降级。
 */
export function createProviderEndpointRoutingFetch(options: {
  fetch: ProviderEndpointRoutingFetch;
  routingPort: ProviderEndpointRoutingPort;
  apiKeyId?: string;
}): ProviderEndpointRoutingFetch {
  return async (input, init) => {
    const requestUrl = readRequestUrl(input);
    if (!requestUrl) {
      // 非 Request/URL/可解析字符串时无法判定归属，保守直通，避免误改写。
      return await options.fetch(input, init);
    }

    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    // 配置接口只接受账号 owner 返回的 ID，禁止从模型 PAT 或手工 Key 推导。
    const apiKeyId = options.apiKeyId;
    const decision = await options.routingPort.resolve(requestUrl, {
      ...(apiKeyId ? { apiKeyId } : {}),
      signal: signal ?? undefined,
      trace: readTraceContext(input, init),
    });
    if (!decision.routed) {
      // 端口未命中表示该请求不属于本 edition 的转发目标，保持原始 URL 与头。
      return await options.fetch(input, init);
    }

    const rewrittenInput = rewriteInput(input, decision.url);
    return await options.fetch(rewrittenInput, routedRequestInit(input, init, decision.headers));
  };
}

/**
 * 合并路由决策头并构造最终 init。
 * 以原 init 头或 Request 头为基底，删除 host（避免目标 endpoint 校验失败），
 * 再用决策头覆盖同名项；完全无头时直接复用原 init，减少无谓分配。
 */
function routedRequestInit(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  init: Parameters<ProviderEndpointRoutingFetch>[1],
  decisionHeaders: Readonly<Record<string, string>> | undefined,
): Parameters<ProviderEndpointRoutingFetch>[1] {
  const inputHeaders = input instanceof Request ? input.headers : undefined;
  if (!init?.headers && !inputHeaders && !decisionHeaders) {
    return init;
  }
  const headers = new Headers(init?.headers ?? inputHeaders);
  headers.delete("host");
  for (const [name, value] of Object.entries(decisionHeaders ?? {})) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

/**
 * 从 fetch 的多种入参形态中提取绝对 URL。
 * 解析失败返回 undefined，让调用方走直通分支而不是中断请求。
 */
function readRequestUrl(input: Parameters<ProviderEndpointRoutingFetch>[0]): string | undefined {
  try {
    if (input instanceof Request) {
      return input.url;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return new URL(String(input)).href;
  } catch {
    return undefined;
  }
}

/**
 * 按原始入参类型把目标 URL 写回。
 * Request 用 (url, request) 重建以保留 body/method/signal；URL/字符串直接替换。
 */
function rewriteInput(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  targetUrl: string,
): Parameters<ProviderEndpointRoutingFetch>[0] {
  if (input instanceof Request) {
    return new Request(targetUrl, input);
  }
  if (input instanceof URL) {
    return new URL(targetUrl);
  }
  return targetUrl;
}

/**
 * 从请求头读取 trace id 并包装成 TraceContext。
 * 缺失或空白时返回 undefined，保证下游 tracing 不把空串当有效 trace。
 */
function readTraceContext(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  init: Parameters<ProviderEndpointRoutingFetch>[1],
): TraceContext | undefined {
  const traceId = readRequestHeaders(input, init).get(TRACE_HEADER)?.trim();
  return traceId ? { traceId: traceId as TraceContext["traceId"] } : undefined;
}

/** 以 init.headers 优先、Request.headers 兜底，构造新的 Headers 快照。 */
function readRequestHeaders(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  init: Parameters<ProviderEndpointRoutingFetch>[1],
): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}
