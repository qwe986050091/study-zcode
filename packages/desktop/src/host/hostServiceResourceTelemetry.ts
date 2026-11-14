// 一份 ServiceCollection 的资源 / 生命周期遥测聚合订阅。
//
// 职责：把 CLI 资源样本、MCP 进程树资源、MCP 生命周期、Bash 完成事实四类事件统一注册到
// 同一个 collection，并返回一个幂等的 dispose 句柄；local Host 与每条远端连接各调用一次。
// 输入输出：输入 services / postMessage / runtimeSurface / telemetrySupported / environmentKey；
// 输出 IDisposable（缺能力或服务时返回 NO_TELEMETRY 空实现）。
// 副作用：向 Agent service 注册四个监听；失败时整体回滚，不留下半条链路。
// 失败语义：telemetrySupported === false 直接跳过（旧 Server 的未知事件异常发生在对端异步
// 读循环，本地 try/catch 保护不到）；注册中途抛错时 disposeAll 并回调 onError，返回空句柄。
// 维护的不变量：attachment（桌面 renderer / 手机远控）不从这里注册，只复用已就绪的
// collection；订阅寿命等于 collection 寿命，dispose 幂等且只生效一次。

import { registerHostToolExecResourceTelemetry } from "./hostToolExecResourceTelemetry.js";
import { registerHostMcpResourceTelemetry } from "./hostMcpResourceTelemetry.js";
import type { IDisposable } from "@zcode/rpc";
import { IZCodeAgentService, type ServiceCollection } from "@zcode/services";
import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import { registerHostAgentResourceTelemetry } from "./hostAgentResourceTelemetry.js";
import { registerHostMcpTelemetry } from "./hostMcpTelemetry.js";

interface RegisterHostServiceResourceTelemetryOptions {
  services: Pick<ServiceCollection, "getOptional">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** 本地默认支持；所有远端须按 server-info 能力声明显式传入。 */
  telemetrySupported?: boolean;
  /** Host 已哈希的运行环境身份，仅透传给 main 的资源分组，不进入 ARMS。 */
  environmentKey?: string;
  onError?(error: unknown): void;
}

const NO_TELEMETRY: IDisposable = { dispose() {} };

// 逐个释放已注册的订阅（后进先出）。
// 单项 dispose 抛错只被吞掉，继续释放其余项——否则连接关闭时会残留监听器并持续泄漏。
// 用 pop 循环清空数组，保证 disposeAll 重复调用是安全的。
function disposeAll(registrations: IDisposable[]): void {
  while (registrations.length > 0) {
    try {
      registrations.pop()?.dispose();
    } catch {
      // 单个订阅释放失败不能拦住其余订阅，否则连接关闭时会残留监听器。
    }
  }
}

// 注册四类遥测并返回统一句柄。
// 前置：telemetrySupported=false（远端 server-info 未声明能力）时直接返回空句柄；取不到
// IZCodeAgentService 时同样返回空句柄（该 collection 没有 Agent，无从订阅）。
// 注册顺序固定：Agent 资源 → MCP 生命周期 → MCP 资源 → Bash 完成；任一失败即回滚全部。
// 失败语义：不抛出，错误交给 onError；返回的句柄 dispose 幂等。
/**
 * 一份 service collection 的资源遥测订阅。转发 CLI 自采资源样本、MCP 进程树资源样本，
 * Bash 慢命令完成事实与 MCP 生命周期遥测。
 *
 * local host services 与每个远端 workspace 连接各自调用一次，`runtimeSurface` 由调用方给出：
 * 本机 CLI 是 local，远端 zcode-server 上的 CLI 是 remote，样本自报的硬件维度由 main 覆盖全局默认值。
 * 订阅寿命等于该 collection 的寿命，远端连接释放时由 handle 调用 `dispose()`，不留监听器。
 * 同一台远端机器有多条 dedicated 连接时会有多份订阅；main 按环境与实例归并 CLI/MCP
 * 最近读数，Bash 完成事实由 main 按 completionToken 去重，避免多连接或多窗口重复计数。
 *
 * attachment（桌面 renderer / 手机远控）不是这里的入口：attachment 只复用已就绪的 collection，
 * 这些事件在 Agent connection scope 被限制为 trusted host relay，不进入会话消息面。
 */
export function registerHostServiceResourceTelemetry(
  options: RegisterHostServiceResourceTelemetryOptions,
): IDisposable {
  // 旧 Server 的未知事件异常发生在对端异步读循环，下面的本地 try/catch 无法保护它；
  // 因此缺能力时必须在获取服务、发送任何 EventListen 之前退出。
  if (options.telemetrySupported === false) {
    return NO_TELEMETRY;
  }
  const agentService = options.services.getOptional(IZCodeAgentService);
  if (!agentService) {
    return NO_TELEMETRY;
  }
  const registrations: IDisposable[] = [];
  try {
    registrations.push(
      registerHostAgentResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostMcpTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
    registrations.push(
      registerHostMcpResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
        environmentKey: options.environmentKey,
      }),
    );
    registrations.push(
      registerHostToolExecResourceTelemetry({
        agentService,
        postMessage: options.postMessage,
        runtimeSurface: options.runtimeSurface,
      }),
    );
  } catch (error) {
    // 遥测订阅失败不能改变 Host 服务初始化或远程连接结果，也不能留下半条链路。
    disposeAll(registrations);
    options.onError?.(error);
    return NO_TELEMETRY;
  }
  let disposed = false;
  return {
    // 先置 disposed 再释放，确保并发/重复 dispose 只执行一次释放逻辑。
    // 释放失败不抛出：Host 关闭路径不应因遥测句柄异常而中断。
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeAll(registrations);
    },
  };
}
