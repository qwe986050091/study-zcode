// ============================================================
// Provider Endpoint Routing Port - 模型 transport 的 endpoint 决策边界
// ============================================================
// 模型请求在真正发出前经过这里：把 provider 配置里的请求 URL 映射成实际网关 URL，
// 并给出需要附加的请求头。routed=false 表示原样透传（不改 URL、不附加头）。
// 决策是**每次请求**的即时结果，不是可缓存的配置；实现可以刷新远端配置，
// 但不得修改/持久化 provider 的 baseURL，也不得把上一次的决策复用给下一次。

import type { TraceContext } from "../tracing/tracer.js";

// 路由决策。url 在 routed=false 时仍必须回填原始 requestUrl（便于调用方统一处理）；
// headers 只在需要改写时给出，调用方负责删除 host 头后再合并；
// routed 是唯一控制流标志，不可用 url 是否变化来推断。
export interface ProviderEndpointRoutingDecision {
  headers?: Readonly<Record<string, string>>;
  routed: boolean;
  url: string;
}

// 解析选项。apiKeyId 是账号 owner 返回的 ID（禁止从模型 PAT/手工 Key 推导），
// 决定该请求能否享受账号级路由；signal 用于中止远端配置查询——取消后不得返回
// 过期决策；trace 仅日志关联，不参与路由规则。
export interface ProviderEndpointRoutingResolveOptions {
  apiKeyId?: string;
  signal?: AbortSignal;
  trace?: TraceContext;
}

// 路由端口。resolve 必须是无状态的一次性查询：同一 requestUrl 在不同时间可以
// 得到不同决策（远端配置可刷新），调用方不得跨请求缓存结果。
// 实现不得修改或持久化 provider baseURL——该端口只做单次请求的改写建议。
// 失败时应返回 routed=false 让请求走原路径，而不是抛错阻断模型调用。
/**
 * 模型 provider transport 的动态 endpoint 决策边界。
 *
 * 实现可以按需刷新远端配置，但不得修改或持久化 provider baseURL。
 */
export interface ProviderEndpointRoutingPort {
  resolve(
    requestUrl: string,
    options?: ProviderEndpointRoutingResolveOptions,
  ): Promise<ProviderEndpointRoutingDecision>;
}
