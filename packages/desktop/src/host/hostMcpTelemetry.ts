// MCP 生命周期遥测的 Host 透传订阅（启动 / 关闭 / 失败等事件，不是资源样本）。
//
// 职责：订阅 onDynamicMcpTelemetry 并按 HostResponseTypes.McpTelemetry 发给 main，
// 用于 MCP 生命周期统计与诊断。
// 输入输出：输入 agentService / postMessage / runtimeSurface；输出 IDisposable。
// 副作用：注册监听；事件触发时 postMessage。
// 失败语义：发送失败只丢当前遥测，不影响 MCP 生命周期。
// 维护的不变量：事件对象原样透传，Host 不重写 type / 时间戳等字段。

import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";

interface RegisterHostMcpTelemetryOptions {
  agentService: Pick<IZCodeAgentService, "onDynamicMcpTelemetry">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
}

// 订阅 MCP 生命周期事件并转发给 main。
// 返回的 disposable 需要随 Host 服务或远端连接一起释放，否则会残留监听器。
export function registerHostMcpTelemetry(options: RegisterHostMcpTelemetryOptions): IDisposable {
  return options.agentService.onDynamicMcpTelemetry()((event) => {
    try {
      options.postMessage({
        type: HostResponseTypes.McpTelemetry,
        runtimeSurface: options.runtimeSurface,
        event,
      });
    } catch {
      // main 已退出或 IPC 不可用时只丢当前遥测，不影响 MCP 生命周期。
    }
  });
}
