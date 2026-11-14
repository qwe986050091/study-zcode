// MCP 进程树资源样本的 Host 透传订阅。
//
// 职责：订阅 onDynamicMcpResourceSamples，把每批 samples 连同 runtimeSurface（本机 local /
// 远端 remote）与可选 environmentKey 发给 main，供其按环境与实例归并。
// 输入输出：输入 agentService / postMessage / runtimeSurface / environmentKey；输出 IDisposable。
// 副作用：注册监听并逐批 postMessage；不聚合、不缓存。
// 失败语义：发送异常只丢弃当前这批事实，不影响 MCP 生命周期与 Agent 通知分发。
// 维护的不变量：Host 不补字段、不改样本顺序，main 才能按 instanceToken 稳定去重。

import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import { HostResponseTypes, type ProcessResourceRuntimeSurface } from "@zcode/shared";

// 订阅 MCP 资源样本并转发给 main。
// environmentKey 未定义时不写入该键，避免下游把它当成「显式本机环境」。
// 返回 disposable 由上层（hostServiceResourceTelemetry 或连接 scope）统一释放。
export function registerHostMcpResourceTelemetry(options: {
  agentService: Pick<IZCodeAgentService, "onDynamicMcpResourceSamples">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
}): IDisposable {
  return options.agentService.onDynamicMcpResourceSamples()((samples) => {
    try {
      options.postMessage({
        type: HostResponseTypes.McpResourceSamples,
        runtimeSurface: options.runtimeSurface,
        ...(options.environmentKey === undefined ? {} : { environmentKey: options.environmentKey }),
        samples,
      });
    } catch {
      // main 已退出或 IPC 关闭时只丢当前资源事实，不影响 MCP 生命周期。
    }
  });
}
