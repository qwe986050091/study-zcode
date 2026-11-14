import { randomBytes } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import {
  ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS,
  type ZCodeProcessResourceSample,
} from "@zcode/shared";

/** 采样周期与 app 侧聚合共用 shared 的同一个常量，避免两侧节拍各自漂移。 */
export const ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS = ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS;

let processInstanceToken: string | undefined;

/**
 * 本 CLI 进程的实例标识：首次采样时生成一次，之后整个进程生命周期内不变（sampler 重建也不变）。
 *
 * 只供 app 侧 main 统计「同时存活几个 CLI 进程」与「最大单进程 RSS」。
 *
 * 不含 pid、不出本机；用随机 token 而不是 pid 是隐私红线要求。
 */
function resolveProcessInstanceToken(): string {
  processInstanceToken ??= randomBytes(8).toString("hex");
  return processInstanceToken;
}

interface CpuUsageSnapshot {
  user: number;
  system: number;
}

/** 与 Node `process.memoryUsage()` 同形；本地内存诊断日志需要 heap 细分，协议样本只取 rss。 */
export interface ProcessMemoryUsageSnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface ResourceSamplerTimerHandle {
  unref?(): void;
}

interface ResourceSamplerTimer {
  setInterval(callback: () => void, intervalMs: number): ResourceSamplerTimerHandle;
  clearInterval(handle: ResourceSamplerTimerHandle): void;
}

interface CreateZCodeProcessResourceSamplerOptions {
  /**
   * 第二个参数是本周期完整的内存快照，供进程内本地诊断日志使用；
   * 协议样本自身只带 rss 与 heapUsed 两项内存字段。
   */
  onSample(sample: ZCodeProcessResourceSample, memoryUsage: ProcessMemoryUsageSnapshot): void;
  platform?: ZCodeProcessResourceSample["platform"];
  arch?: ZCodeProcessResourceSample["arch"];
  logicalCpuCount?: number;
  readCpuUsage?: () => CpuUsageSnapshot;
  readMonotonicTimeNs?: () => bigint;
  readMemoryUsage?: () => ProcessMemoryUsageSnapshot;
  /** 运行机物理内存，构造时读一次（同一进程内不会变）。 */
  readTotalMemoryBytes?: () => number;
  /** 本进程运行时长；平台侧按运行时长分桶发现内存随时间增长。 */
  readUptimeSeconds?: () => number;
  /** 只供单测注入可预期的实例标识；生产走进程级随机 token。 */
  instanceToken?: string;
  timer?: ResourceSamplerTimer;
}

export interface ZCodeProcessResourceSampler {
  start(): void;
  stop(): void;
}

interface ResourceSamplerBaseline {
  cpu: CpuUsageSnapshot;
  monotonicTimeNs: bigint;
}

const defaultTimer: ResourceSamplerTimer = {
  setInterval(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

// 保留四位小数，避免浮点噪声进入协议与聚合统计（KB/核占比都足够精度）。
function roundResourceMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * 读数不可用时该字段直接缺席（协议里两项都是可选），不用 0 冒充。
 * 读数本身抛错由外层的采样 try/catch 兜（红线 6「失败即丢」）。
 */
function toRoundedUnit(value: number, divisor: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.round(value / divisor) : undefined;
}

/**
 * 创建进程资源采样器（start/stop 显式控制，不自动启动）。
 *
 * - 首次 tick 只建立 CPU/时间基线，不产样本；之后按两次 tick 的真实间隔计算 CPU 核数占比，
 *   因此 intervalMs 是实测值而非定时器标称值（定时器漂移不会污染 cpuPercent）；
 * - 任何读数异常/基线回退（elapsed<=0、cpuDelta<0）都只跳过当前周期并重置基线，
 *   异常不会冒泡到 agent 主循环；onSample 抛错也只丢弃本次样本；
 * - totalMemoryGb 在构造时读一次（物理内存不会变），用于远端样本覆盖桌面机值；
 * - instanceToken 进程级稳定、不含 pid，仅用于聚合同时存活进程数。
 */
export function createZCodeProcessResourceSampler(
  options: CreateZCodeProcessResourceSamplerOptions,
): ZCodeProcessResourceSampler {
  const platform = options.platform ?? (process.platform as ZCodeProcessResourceSample["platform"]);
  const arch = options.arch ?? (process.arch as ZCodeProcessResourceSample["arch"]);
  const logicalCpuCount = Math.max(
    1,
    Math.min(4_096, Math.trunc(options.logicalCpuCount ?? availableParallelism())),
  );
  const readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
  const readMonotonicTimeNs = options.readMonotonicTimeNs ?? (() => process.hrtime.bigint());
  // 一次 memoryUsage() 同时拿到 rss 与 heap 细分；单独的 memoryUsage.rss() 在 Linux 上
  // 也要读 /proc，合并成一次调用不增加成本。
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const readUptimeSeconds = options.readUptimeSeconds ?? (() => process.uptime());
  const instanceToken = options.instanceToken ?? resolveProcessInstanceToken();
  // 运行机物理内存构造时读一次：远端 CLI 的样本要用它覆盖桌面机的 total_memory_gb。
  const totalMemoryGb = toRoundedUnit(
    (options.readTotalMemoryBytes ?? (() => totalmem()))(),
    1024 ** 3,
  );
  const timer = options.timer ?? defaultTimer;
  let baseline: ResourceSamplerBaseline | undefined;
  let timerHandle: ResourceSamplerTimerHandle | undefined;

  const readBaseline = (): ResourceSamplerBaseline => ({
    cpu: readCpuUsage(),
    monotonicTimeNs: readMonotonicTimeNs(),
  });

  const sample = (): void => {
    try {
      const nextBaseline = readBaseline();
      if (!baseline) {
        baseline = nextBaseline;
        return;
      }
      const elapsedNs = nextBaseline.monotonicTimeNs - baseline.monotonicTimeNs;
      const cpuDeltaUs =
        nextBaseline.cpu.user - baseline.cpu.user + (nextBaseline.cpu.system - baseline.cpu.system);
      if (elapsedNs <= 0n || cpuDeltaUs < 0) {
        baseline = nextBaseline;
        return;
      }
      const intervalMs = Math.round(Number(elapsedNs) / 1_000_000);
      if (intervalMs <= 0) {
        baseline = nextBaseline;
        return;
      }
      const cpuCores = cpuDeltaUs / (Number(elapsedNs) / 1_000);
      const memoryUsage = readMemoryUsage();
      const rssKb = memoryUsage.rss / 1_024;
      const uptimeMinutes = toRoundedUnit(readUptimeSeconds(), 60);
      baseline = nextBaseline;
      const resourceSample: ZCodeProcessResourceSample = {
        platform,
        arch,
        logicalCpuCount,
        intervalMs,
        cpuCores: roundResourceMetric(cpuCores),
        cpuPercent: roundResourceMetric((cpuCores / logicalCpuCount) * 100),
        rssKb: roundResourceMetric(rssKb),
        heapUsedKb: roundResourceMetric(memoryUsage.heapUsed / 1_024),
        instanceToken,
        ...(uptimeMinutes === undefined ? {} : { uptimeMinutes }),
        ...(totalMemoryGb === undefined ? {} : { totalMemoryGb }),
      };
      try {
        options.onSample(resourceSample, memoryUsage);
      } catch {
        // 上报端关闭或背压时只丢当前样本，不能把异常带回 Agent 主循环。
      }
    } catch {
      // 进程指标 API 异常只跳过当前周期，保留最近一次成功基线供后续恢复。
    }
  };

  return {
    start() {
      if (timerHandle) {
        return;
      }
      try {
        baseline = readBaseline();
      } catch {
        baseline = undefined;
      }
      try {
        timerHandle = timer.setInterval(sample, ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS);
      } catch {
        timerHandle = undefined;
        return;
      }
      try {
        timerHandle.unref?.();
      } catch {
        // unref 不可用时仍保留 timer owner，确保 stop 可以回收定时器。
      }
    },
    stop() {
      if (!timerHandle) {
        return;
      }
      const handle = timerHandle;
      timerHandle = undefined;
      baseline = undefined;
      try {
        timer.clearInterval(handle);
      } catch {
        // sampler 清理失败不能阻塞 CLI 既有退出流程。
      }
    },
  };
}
