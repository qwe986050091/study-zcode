// Bash / 工具执行完成事件的 Host 透传订阅。
//
// 职责：订阅 onDynamicToolExecResource（慢命令完成事实），按 HostResponseTypes.ToolExecResource
// 发给 main；main 按 completionToken 去重后计入资源统计。
// 输入输出：输入 agentService / postMessage / runtimeSurface；输出 IDisposable。
// 副作用：注册监听并逐条 postMessage；Host 不缓存、不合并。
// 失败语义：发送失败只丢弃当前完成事实，不影响 Bash 生命周期与 Agent 通知。
// 维护的不变量：每条完成事实必须保留 completionToken 原值，否则 main 无法跨连接去重。

import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import { HostResponseTypes, type ProcessResourceRuntimeSurface } from "@zcode/shared";

// 订阅工具执行完成事件并转发给 main。
// 返回的 disposable 随 collection / 连接释放，避免 Host 关闭后仍持有监听器。
// 失败语义：postMessage 抛错被吞，仅影响当前这条事实。
export function registerHostToolExecResourceTelemetry(options: {
  agentService: Pick<IZCodeAgentService, "onDynamicToolExecResource">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
}): IDisposable {
  return options.agentService.onDynamicToolExecResource()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.ToolExecResource,
        runtimeSurface: options.runtimeSurface,
        sample,
      });
    } catch {
      // main 退出或通道关闭只丢当前完成事实，不影响 Bash 生命周期。
    }
  });
}
