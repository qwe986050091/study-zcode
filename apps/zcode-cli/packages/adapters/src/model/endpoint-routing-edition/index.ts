// ==== model/endpoint-routing-edition/index.ts ====
// 定位：endpoint-routing edition（静态版）的工厂入口，把 edition 选项收敛成端口实例。
// 输入：ProviderEndpointRoutingFactoryOptions，当前实现只读取 endpointOrigin。
// 输出：ProviderEndpointRoutingPort；决策结果由 official-coding-plan-gateway 的静态实现给出。
// 副作用：无网络、无 IO，仅创建纯内存对象。
// 失败语义：不主动抛错；非法 origin 的处理下放到 createStaticProviderEndpointRoutingPort。
// 不变量：同一 options 产生等价的静态路由端口，端口无状态、可被多个 fetch 包装复用。
import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";
import { createStaticProviderEndpointRoutingPort } from "../official-coding-plan-gateway.js";

/**
 * 静态版 endpoint-routing 工厂。
 * 把 edition 的配置折叠为单一 endpointOrigin，再委托 official-coding-plan-gateway
 * 生成静态端口；所有请求都被解析到同一 origin，不做账号级动态路由。
 * 返回端口本身不持有可变状态，失败只可能来自 origin 的静态构造过程。
 */
export function createProviderEndpointRoutingPort(
  options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  return createStaticProviderEndpointRoutingPort(options.endpointOrigin);
}
