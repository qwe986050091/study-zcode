// CLI（Agent 进程）资源样本的 Host 透传订阅。
//
// 职责：把 IZCodeAgentService 的 onDynamicProcessResourceSample 事件原样转成 HostResponseTypes
// .AgentResourceSample 发给 main，用于 main 侧的资源归并与角色归属。
// 输入输出：输入 agentService / postMessage / runtimeSurface / 可选 environmentKey；
// 输出 IDisposable，调用方负责在连接或 Host 关闭时 dispose。
// 副作用：注册服务事件监听；每次样本触发一次 parentPort postMessage。
// 失败语义：发送失败（main 已退出 / IPC 关闭）只丢弃当前样本，绝不向 Agent 通知链抛错。
// 维护的不变量：Host 不做统计、不持有窗口——样本字段（lane / heap / uptime / instanceToken）
// 由 services 打标后原样透传，避免 Host 与 main 两套口径。

import type { IDisposable } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";

interface RegisterHostAgentResourceTelemetryOptions {
  agentService: Pick<IZCodeAgentService, "onDynamicProcessResourceSample">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
}

// 订阅 CLI 资源样本并转发给 main。
// environmentKey 只在定义时才写入消息体（undefined 键会破坏下游「是否本机」的判断）。
// 返回的 disposable 必须被调用方持有；重复注册会产生重复样本。
// 失败语义：postMessage 抛错被吞掉，仅影响当前样本。
/**
 * CLI 资源样本的 Host 转发。
 *
 * Host 只做透传：样本的 lane 已由 services 在解析协议通知时按所属进程管理器打好，
 * heap / uptime / 运行机内存 / instanceToken 等新字段一并原样送给 main，
 * 由 main 决定角色归属与聚合。Host 不做任何统计，也不持有窗口。
 */
export function registerHostAgentResourceTelemetry(
  options: RegisterHostAgentResourceTelemetryOptions,
): IDisposable {
  return options.agentService.onDynamicProcessResourceSample()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.AgentResourceSample,
        runtimeSurface: options.runtimeSurface,
        ...(options.environmentKey === undefined ? {} : { environmentKey: options.environmentKey }),
        sample,
      });
    } catch {
      // main 已退出或 IPC 不可用时只丢当前样本，禁止影响 Agent service 通知分发。
    }
  });
}
