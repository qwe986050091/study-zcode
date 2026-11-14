/* ============================================================
 * MCP 资源采样遥测（adapters/src/mcp/resource-telemetry.ts）
 *
 * 定位：定时探测 MCP 子进程树的 CPU/RSS，产出 ZCodeMcpResourceSample 事件。
 * 输入：进程视图 getProcesses()、平台/架构、可选探针与定时器（便于测试）。
 * 输出：经 onResourceSamples 上报的分组样本；纯旁路，不改变 MCP 生命周期。
 * 副作用：创建 interval 定时器（unref）、调用 OS 进程探针；无文件/网络 IO。
 * 失败语义：采样或回调失败全部吞掉并清空 CPU 基线，绝不影响连接；定时器不可用则
 * 静默降级为“无采样”。
 * 不变量：CPU 基线只保留上一次采样、跨失败窗口不累计；同一 OS 进程只计一次；
 * stop() 递增 generation，使在途采样结果作废，避免关闭后仍上报。
 * ============================================================ */

import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS, type ZCodeMcpResourceSample } from "@zcode/shared";
import {
  createProcessProbe,
  type ProcessProbe,
  type ProcessProbeSample,
  type ProcessTreeScope,
} from "../device/process-probe.js";

/**
 * 定时器抽象：只要求 setInterval/clearInterval，handle 支持 unref。
 * 注入目的：测试可用假定时器；unref 保证定时器不阻止 Agent 进程退出。
 */
interface TimerHandle {
  unref?(): void;
}
export interface McpResourceTimer {
  clearInterval(handle: TimerHandle): void;
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
}

/**
 * 被采样的 MCP 进程视图。
 *
 * instanceId：进程实例唯一 id（重启后变化），用作 CPU 基线键；
 * mcpId：MCP 配置身份（跨实例稳定），样本按它聚合；
 * pid：OS 进程 id；startedAt：启动 epoch ms，用于 uptimeMinutes；
 * isCurrent()：探针 await 期间实例是否仍存活（false 时不得贡献样本）；
 * observed()：把本次采样交回 tracker，由 tracker 决定是否上报/清理登记。
 */
export interface McpResourceProcess {
  instanceId: string;
  mcpId: string;
  pid: number;
  startedAt: number;
  /** 探针 await 期间重启或注销的旧实例不能贡献资源或修改 tracker。 */
  isCurrent(): boolean;
  observed(
    samples: readonly ProcessProbeSample[] | undefined,
    sampledAt: number,
    scope: ProcessTreeScope,
  ): void;
}

/**
 * tracker 构造参数：平台/架构用于事件口径；now 可注入；
 * getProcesses 每次采样现取（不缓存进程表）；onResourceSamples 为上报出口；
 * processProbe / logicalCpuCount / totalMemoryGb / timer 均为测试与宿主注入点。
 */
export interface McpResourceTelemetryOptions {
  arch: ZCodeMcpResourceSample["arch"];
  platform: ZCodeMcpResourceSample["platform"];
  now(): number;
  getProcesses(): McpResourceProcess[];
  onResourceSamples?(samples: ZCodeMcpResourceSample[]): void;
  processProbe?: ProcessProbe;
  logicalCpuCount?: number;
  totalMemoryGb?: number;
  timer?: McpResourceTimer;
}

/**
 * 创建资源采样器。
 *
 * sampleNow()：立即采样一次（并发调用时后到者直接返回，不排队）；
 * start()：启动 interval（幂等，重复调用不新增定时器）；
 * stop()：递增 generation 并清空基线，使在途结果失效后清理定时器。
 * 副作用：可能启动 OS 探针与定时器；失败一律吞掉，保证旁路不影响 MCP。
 */
/** 一个 tracker 一个定时器和探针；CPU 基线只活到下次采样，不保存历史序列。 */
export function createMcpResourceTelemetry(options: McpResourceTelemetryOptions) {
  const probe = options.processProbe ?? createProcessProbe({ platform: options.platform });
  const logicalCpuCount = options.logicalCpuCount ?? Math.max(1, cpus().length);
  const totalMemoryGb = options.totalMemoryGb ?? Math.round(totalmem() / 1024 ** 3);
  const instanceToken = randomUUID();
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: TimerHandle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  let handle: TimerHandle | undefined;
  let generation = 0;
  let inFlight = false;
  let previousAt: number | undefined;
  let previous = new Map<string, Map<number, number>>();

  const sampleNow = async (): Promise<void> => {
    // 上一轮探针尚未返回时直接跳过：并发采样会重复执行 ps 且污染 CPU 基线。
    if (inFlight) return;
    const processes = options.getProcesses();
    if (processes.length === 0) {
      previous.clear();
      previousAt = undefined;
      return;
    }
    inFlight = true;
    const sampleGeneration = generation;
    const sampledAt = options.now();
    try {
      probe.reset();
      const trees = await probe.sampleProcessTrees(processes.map((entry) => entry.pid));
      // 探针 await 期间发生 stop()：generation 已递增，本轮结果属于已关闭的 tracker，必须丢弃。
      if (sampleGeneration !== generation) return;
      if (!trees) {
        previous.clear();
        previousAt = undefined;
        return;
      }
      const intervalMs =
        previousAt === undefined
          ? ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS
          // 首轮用标称间隔；之后用真实采样间隔，避免定时器漂移把 CPU delta 算成错误速率。
          : Math.max(1, sampledAt - previousAt);
      const next = new Map<string, Map<number, number>>();
      const groups = new Map<string, ZCodeMcpResourceSample>();
      const seenPids = new Set<number>();
      for (const entry of processes) {
        if (!entry.isCurrent()) continue;
        const tree = trees.get(entry.pid);
        entry.observed(tree, sampledAt, probe.treeScope);
        if (!tree?.length) continue;
        const group = groups.get(entry.mcpId) ?? {
          mcpId: entry.mcpId,
          instanceToken,
          sampledAt,
          intervalMs,
          processCount: 0,
          rssKbTotal: 0,
          rssKbMaxProcess: 0,
          cpuTimeMsDelta: 0,
          uptimeMinutes: 0,
          platform: options.platform,
          arch: options.arch,
          logicalCpuCount,
          totalMemoryGb,
        };
        const baseline = new Map<number, number>();
        for (const sample of tree) {
          // 共享根或嵌套根只计一次，防止同一 OS 进程污染应用总量。
          if (seenPids.has(sample.pid)) continue;
          seenPids.add(sample.pid);
          group.processCount += 1;
          group.rssKbTotal += sample.rssKb;
          group.rssKbMaxProcess = Math.max(group.rssKbMaxProcess, sample.rssKb);
          if (sample.cpuTimeMs !== undefined) {
            baseline.set(sample.pid, sample.cpuTimeMs);
            const old = previous.get(entry.instanceId)?.get(sample.pid);
            if (old !== undefined) group.cpuTimeMsDelta += Math.max(0, sample.cpuTimeMs - old);
          }
        }
        next.set(entry.instanceId, baseline);
        group.uptimeMinutes = Math.max(
          group.uptimeMinutes,
          Math.floor(Math.max(0, sampledAt - entry.startedAt) / 60_000),
        );
        if (group.processCount > 0) groups.set(entry.mcpId, group);
      }
      previous = next;
      previousAt = sampledAt;
      // 分组后仍为空（例如所有进程的树都不可见）时不上报空事件。
      if (groups.size > 0) options.onResourceSamples?.([...groups.values()]);
    } catch {
      // 采样/通知失败不能影响 MCP 生命周期，也不能把跨失败窗口的 CPU 时间算成五分钟均值。
      previous.clear();
      previousAt = undefined;
    } finally {
      inFlight = false;
    }
  };
  return {
    sampleNow,
    /** 启动周期性采样；已有定时器时幂等返回。定时器创建或 unref 失败按旁路降级。 */
    start() {
      if (handle) return;
      try {
        handle = timer.setInterval(() => {
          void sampleNow();
        }, ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS);
        handle.unref?.();
      } catch {
        // 保持原 tracker 的旁路语义：定时器不可用不能阻断 MCP 连接。
      }
    },
    /** 停止采样：先递增 generation 作废在途结果，再清基线并清理定时器。 */
    stop() {
      generation += 1;
      previous.clear();
      previousAt = undefined;
      const activeHandle = handle;
      handle = undefined;
      try {
        if (activeHandle) timer.clearInterval(activeHandle);
      } catch {
        // 清理失败不阻断 Agent 退出；上面的代际已使在途结果失效。
      }
    },
  };
}
