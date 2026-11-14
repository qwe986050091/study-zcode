// 插件 UI 采样契约：只声明 Desktop 与插件 UI 之间的 RPC 描述符和参数形状，不含实现。
// INV：Agent 是实例凭证、并发限额与唯一调用终态的所有者，本层必须保持无状态。
// operationId 由调用方生成并在整个采样生命周期内复用，错配会把取消落到别的操作上。
import { ServiceChannels } from "@zcode/shared";
import type { McpAppsSamplingResult } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";
import type { PluginUiPluginScope } from "./contract.js";

export interface PluginUiSamplingParams extends PluginUiPluginScope {
  operationId: string;
  request: import("@zcode/shared/mcp-apps").McpAppsSamplingParams;
}
export interface PluginUiCancelSamplingParams extends PluginUiPluginScope {
  operationId: string;
}

/** 无状态透传；Agent 持有实例凭证、并发限额和唯一调用终态。 */
// INV：sample 与 cancelSampling 都不缓存跨调用状态，结果归属由 Agent 判定。
// 若在此层补缓存或隐式重试，会破坏 Agent 的限额语义并产生重复采样。
export interface IPluginUiSamplingService {
  sample(params: PluginUiSamplingParams): Promise<McpAppsSamplingResult>;
  cancelSampling(params: PluginUiCancelSamplingParams): Promise<{ cancelled: boolean }>;
}
export const IPluginUiSamplingService = createServiceDescriptor<IPluginUiSamplingService>(
  ServiceChannels.PluginUiSampling,
);
