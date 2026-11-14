// ============================================================
// 文件定位：单条 Bash 命令的进程树资源遥测（RSS 峰值 / CPU 累计 / 耗时）。
// 输入输出：输入进程组 id 与回调；finish(exitKind) 时上报一份 ZCodeToolExecResource 样本。
// 副作用：复用 1s 共享轮询采样 /proc|ps（非 Windows），结束时调用 onComplete（可能走 IPC）。
// 失败语义：采样失败只丢当前样本；finish 前的任何异常都不改变 Bash 的退出码与输出。
// 不变量：finish 同步封口且幂等；迟到的采样结果不得修改已上报的摘要；CPU 只累加增量。
// ============================================================
import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import {
  BASH_RESOURCE_MAX_SAMPLES,
  BASH_RESOURCE_SAMPLE_INTERVAL_MS,
  type ZCodeToolExecResource,
} from "@zcode/shared";
import { createProcessProbe, type ProcessProbe } from "../device/process-probe.js";

import { subscribeBashOutputProgress } from "./bash-progress-poller.js";
import { DEFAULT_PROGRESS_INTERVAL_MS } from "./execution-utils.js";

const BYTES_PER_KB = 1024;

interface BashResourceTelemetryOptions {
  // Bash 子进程的进程组 id（用作负 PGID 采样）；缺省则不采样。
  processGroupId?: number;
  platform?: NodeJS.Platform;
  probe?: Pick<ProcessProbe, "sampleProcessGroup">;
  // 封口时唯一一次上报；出错被吞，不回流到命令结果。
  onComplete: (sample: ZCodeToolExecResource) => void;
  // CLI 自身 RSS / 系统空闲内存（KB），由调用方注入以免遥测直接读全局。
  readContext?: () => Pick<ZCodeToolExecResource, "cliRssKb" | "systemFreeMemoryKb">;
}

/** 每条命令独占状态与探针失败预算；finish 同步封口，绝不等待遥测 IO。 */
// 采样最多 BASH_RESOURCE_MAX_SAMPLES 次，且最小间隔受 BASH_RESOURCE_SAMPLE_INTERVAL_MS 约束。
// 只上报峰值 RSS 与累计 CPU（Windows 两者都没有，故省略字段而不是填 0）。
export function createBashResourceTelemetry(options: BashResourceTelemetryOptions): {
  finish(exitKind: ZCodeToolExecResource["exitKind"]): void;
} {
  const platform = options.platform ?? process.platform;
  const startedAt = performance.now();
  const probe = options.probe ?? createProcessProbe({ platform });
  const cpuByPid = new Map<number, number>();
  let finished = false;
  let lastSampleElapsedMs = 0;
  let attempts = 0;
  let sampleCount = 0;
  let treeRssKbPeak = 0;
  let treeCpuTimeMs = 0;
  let unsubscribe: (() => void) | undefined;

  const sample = async () => {
    const elapsedMs = performance.now() - startedAt;
    if (finished || elapsedMs - lastSampleElapsedMs < BASH_RESOURCE_SAMPLE_INTERVAL_MS) return;
    lastSampleElapsedMs = elapsedMs;
    attempts += 1;
    try {
      const rows = await probe.sampleProcessGroup(options.processGroupId!);
      // 根退出时已封口；不能让迟到的 /proc 或 ps 结果修改已发送的摘要。
      if (finished || !rows?.length) return;
      sampleCount += 1;
      let rssKb = 0;
      for (const row of rows) {
        rssKb += row.rssKb;
        if (row.cpuTimeMs === undefined) continue;
        const previous = cpuByPid.get(row.pid) ?? 0;
        treeCpuTimeMs += Math.max(0, row.cpuTimeMs - previous);
        cpuByPid.set(row.pid, row.cpuTimeMs);
      }
      treeRssKbPeak = Math.max(treeRssKbPeak, rssKb);
    } catch {
      // 遥测失败只丢当前样本，不能改变 Bash 的退出、输出与超时行为。
    } finally {
      if (attempts === BASH_RESOURCE_MAX_SAMPLES) unsubscribe?.();
    }
  };
  if (platform !== "win32" && options.processGroupId !== undefined) {
    // 复用 Bash 已有的一秒共享轮询；按命令起点门控，错相位至多延后一轮，绝不提前采样。
    unsubscribe = subscribeBashOutputProgress(DEFAULT_PROGRESS_INTERVAL_MS, sample);
  }

  return {
    finish(exitKind) {
      // 封口只做一次；封口后所有在飞采样都按“已结束”丢弃。
      if (finished) return;
      finished = true;
      unsubscribe?.();
      cpuByPid.clear();
      const durationMs = performance.now() - startedAt;
      if (durationMs < BASH_RESOURCE_SAMPLE_INTERVAL_MS) return;
      try {
        const context = options.readContext?.() ?? {
          cliRssKb: process.memoryUsage.rss() / BYTES_PER_KB,
          systemFreeMemoryKb: freemem() / BYTES_PER_KB,
        };
        options.onComplete({
          // 多连接和多窗口可能重复转发同一事实；在命令封口后只生成一次，供 main 按身份去重。
          completionToken: randomUUID(),
          platform,
          toolName: "bash",
          durationMs,
          exitKind,
          sampleCount,
          ...context,
          ...(platform === "win32" ? {} : { treeRssKbPeak, treeCpuTimeMs }),
        });
      } catch {
        // IPC 已关闭或上下文读取失败时只丢通知，不影响命令结果。
      }
    },
  };
}
