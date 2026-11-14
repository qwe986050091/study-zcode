// 「资源管理器」快照请求的 Host 侧响应器。
//
// 职责：main 发来一次 ResourceUsageSnapshotRequest 时，Host 采样一次整机进程表，向本地
// Agent 要 MCP 子进程映射，按 Host 子树归属后回帖 processes；不保存队列、不做轮询。
// 输入输出：handleRequest(message) 输出经 postMessage 发送的 ResourceUsageSnapshotResult；
// cancelRequest 仅对当前 active 请求生效。
// 副作用：读系统进程表、调用 Agent service、postMessage；同一时刻最多一轮采样。
// 失败语义：所有异常（采样失败、Agent 查询失败、回帖失败）都被吞掉——观测失败不能影响
// Host 生命周期；已有 active 请求时新的请求直接回空 processes，不排队（避免每秒查询堆成 FIFO）。
// 维护的不变量：只有一轮 in-flight；cancel 后 respond 在 aborted 检查处直接返回，不发布迟到结果。

import type { IZCodeAgentService } from "@zcode/services";
import {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type ProcessResourceSampler,
} from "@zcode/services/node";
import {
  HostResponseTypes,
  type HostResourceUsageSnapshotRequestMessage,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";

export interface CreateHostResourceUsageResponderOptions {
  getAgentService: () => Pick<IZCodeAgentService, "collectLocalRuntimeChildProcesses"> | undefined;
  postMessage: (message: HostResourceUsageSnapshotResultResponse) => void;
  hostPid?: number;
  sampler?: ProcessResourceSampler;
  /** Host 直管的内置插件进程（如 Windows CUA Helper）：pid → 插件名 */
  getBuiltinPluginPids?: () => ReadonlyMap<number, string>;
  now?: () => number;
}

export interface HostResourceUsageResponder {
  handleRequest(message: HostResourceUsageSnapshotRequestMessage): Promise<void>;
  cancelRequest(requestId: string): void;
}

/**
 * 资源管理器 Host 侧响应器。
 * 只在 main 发来请求时采样一次：读整机进程表 → 向每个本地 Agent 要 MCP 子进程映射 → 按 Host 子树归属 → 回帖。
 * 最多执行一轮，不保存采样队列；关窗取消后不发布迟到结果。
 */
// 创建资源快照响应器。
// hostPid 默认 process.pid（用于子树归属）；sampler 可注入以复用或替换进程表读取实现。
// getBuiltinPluginPids 提供 Host 直管的内置插件进程（Windows CUA Helper 等），
// 使其即使不在 Agent 子进程映射里也能被正确归属。
export function createHostResourceUsageResponder(
  options: CreateHostResourceUsageResponderOptions,
): HostResourceUsageResponder {
  const hostPid = options.hostPid ?? process.pid;
  const now = options.now ?? Date.now;
  const sampler =
    options.sampler ??
    createProcessResourceSampler({ readTable: createProcessResourceTableReader() });
  let active: { requestId: string; controller: AbortController } | undefined;

  // 执行一轮采样并回帖。
  // 进程表与 Agent 子进程映射并行获取，任一失败按空值降级（samples undefined → processes []）。
  // 采样返回后再次检查 signal.aborted：取消可能发生在两个 await 之间，此时不能发布结果。
  // 失败语义：本函数不抛出（内部 catch 已吸收），回帖仍会执行（除非已 abort）。
  async function respond(
    message: HostResourceUsageSnapshotRequestMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const [samples, agents] = await Promise.all([
      sampler.sample(signal).catch(() => undefined),
      options
        .getAgentService()
        ?.collectLocalRuntimeChildProcesses(signal)
        .catch(() => []) ?? Promise.resolve([]),
    ]);
    if (signal.aborted) return;
    const processes = samples
      ? attributeHostProcessTree({
          samples,
          hostPid,
          agents,
          builtinPluginPids: options.getBuiltinPluginPids?.(),
        })
      : [];
    options.postMessage({
      type: HostResponseTypes.ResourceUsageSnapshotResult,
      requestId: message.requestId,
      sampledAt: now(),
      processes,
    });
  }

  return {
    // 处理一次快照请求。
    // 已有 active 时立刻回一个空结果而不是排队：main 侧展示超时并不代表底层结束，
    // 若排队会把每秒一次的查询变成无界 FIFO，最终拖垮 Host。
    // finally 用 active === current 判断后再清空，避免误清后一个请求的状态。
    async handleRequest(message) {
      let current: typeof active;
      try {
        // Main 展示超时不代表底层结束，不能把每秒查询变成无界 FIFO。
        if (active) {
          options.postMessage({
            type: HostResponseTypes.ResourceUsageSnapshotResult,
            requestId: message.requestId,
            sampledAt: now(),
            processes: [],
          });
          return;
        }
        current = { requestId: message.requestId, controller: new AbortController() };
        active = current;
        await respond(message, current.controller.signal);
      } catch {
        // 观测失败或退出时回帖失败只丢弃本轮，不能以未处理异常影响 Host 生命周期。
      } finally {
        if (current && active === current) active = undefined;
      }
    },
    // 取消指定请求：只 abort 与 requestId 匹配的当前请求，不误伤后续请求。
    // abort 后 respond 的 aborted 检查会阻止迟到回帖，但底层采样无法真正中断。
    cancelRequest(requestId) {
      if (active?.requestId === requestId) active.controller.abort();
    },
  };
}
