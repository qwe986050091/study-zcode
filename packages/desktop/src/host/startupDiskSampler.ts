// 启动阶段磁盘余量采样器。
//
// 职责：对若干 workspace 路径每 2s 采样一次可用空间，按「文件系统（dev）身份」聚合为
// StartupDiskSummary，并记录基线以来的最大可用量跌幅；供启动期容量提示使用。
// 输入输出：addPath(path) 登记路径；sample() 采样一轮并回调 onSample(snapshot())；
// snapshot() 输出不含内部 path/baseline 的公开摘要。
// 副作用：周期 setInterval、stat/statfs 系统调用、onSample 回调；最多登记 8 个 scope。
// 失败语义：探测失败（满盘 / 权限 / 路径消失）只把 quality 降为 partial 并保留旧值，
// 不抛出；尺寸超过 Number.MAX_SAFE_INTEGER 时抛错（避免精度丢失后的错误结论）。
// 维护的不变量：busy 保证同一时刻只有一轮探测；scope 身份变化（dev 变）时迁移计数并降级
// quality；sealBaseline 后新 scope 的 baseline 为 null，不再计算跌幅峰值。

import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { StartupDiskSummary } from "@zcode/shared";

const SAMPLE_INTERVAL_MS = 2000;
type Probe = (path: string) => Promise<{ scope: string; availableBytes: number }>;
type Scope = StartupDiskSummary & { path: string; baseline: number | null };

// 创建探测函数：把任意路径解析到「实际存在的祖先目录 + 其文件系统 dev 哈希」。
// 首次解析结果按原 path 缓存（含 dev），之后每轮只做 statfs，避免重复 stat 链。
// 逐级 dirname 上溯，遇到非 ENOENT 或已到根目录时抛出（ENOENT 才继续向上）。
// 返回 scope（dev 哈希）+ availableBytes；负数按 0 处理，超出安全整数范围直接抛错。
/** 仅查询已知目录元数据；dev 只在首次解析时读取，周期内只做 statfs。 */
// 路径解析失败要区分「路径暂时不存在（可上溯）」与「真实 IO 错误（必须抛出）」；
// 只有 ENOENT 才继续向上找祖先，其他错误立即冒泡，避免把权限/磁盘错误静默吞掉。
function createProbe(): Probe {
  const resolved = new Map<string, { path: string; scope: string }>();
  return async (path) => {
    let location = resolved.get(path);
    if (!location) {
      let parent = dirname(path);
      for (;;) {
        try {
          const info = await stat(parent, { bigint: true });
          location = {
            path: parent,
            scope: createHash("sha256").update(String(info.dev)).digest("hex"),
          };
          resolved.set(path, location);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent)
            throw error;
          parent = dirname(parent);
        }
      }
    }
    const info = await statfs(location.path, { bigint: true });
    const bytes = info.bavail * info.bsize;
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Storage size exceeds safe numeric range");
    return { scope: location.scope, availableBytes: Number(bytes > 0n ? bytes : 0n) };
  };
}

// 磁盘采样器：按文件系统 scope 记录最小可用量与跌幅峰值。
// 状态：scopes（scopeId → 摘要）、sealed（已封基线路径）、timer、busy、stopped。
// 生命周期：addPath → start 周期采样 → stop 永久停止（stopped 后 addPath/sample 均 no-op）。
// 失败语义：所有探测异常都内部消化（最多把 quality 降为 partial），不向调用方抛出。
export class StartupDiskSampler {
  private readonly probe: Probe;
  private readonly scopes = new Map<string, Scope>();
  private readonly sealed = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  constructor(
    private readonly options: {
      probe?: Probe;
      onSample?: (summary: StartupDiskSummary[]) => void;
    } = {},
  ) {
    this.probe = options.probe ?? createProbe();
  }
  // 登记一个路径并尽量在本次调用内完成首次探测（建立 scope 与 baseline）。
  // 上限 8 个 scope：启动期提示只需覆盖少量工作区，避免无界系统探测。
  // busy 时直接返回：首次探测由正在运行的 sample 负责，登记项以 unknown scope 先占位。
  // 失败语义：探测失败保留 unknown 占位（后续周期会重试），不抛出。
  async addPath(path: string): Promise<void> {
    if (this.scopes.size >= 8 || this.stopped) return;
    const unknownKey = createHash("sha256").update(path).digest("hex");
    const unknown: Scope = {
      path,
      scopeId: unknownKey,
      baseline: null,
      observedAvailableDropPeakBytes: null,
      minAvailableBytes: null,
      quality: "unknown",
      sampledAt: null,
    };
    this.scopes.set(unknownKey, unknown);
    // 准备只短暂等待基线；慢探测继续异步运行，结果到达时据 sealBaseline 判定是否完整。
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.probe(path);
      if (this.stopped) return;
      this.scopes.delete(unknownKey);
      const existing = this.scopes.get(result.scope);
      if (existing) this.record(existing, result.availableBytes);
      else
        this.scopes.set(result.scope, {
          ...unknown,
          scopeId: result.scope,
          baseline: this.sealed.has(path) ? null : result.availableBytes,
          minAvailableBytes: result.availableBytes,
          sampledAt: Date.now(),
          observedAvailableDropPeakBytes: this.sealed.has(path) ? null : 0,
          quality: this.sealed.has(path) ? "partial" : "complete",
        });
    } catch {
      /* 满盘/权限错误不要求再次读取故障磁盘才能显示失败。 */
    } finally {
      this.busy = false;
    }
  }
  // 封存基线：之后才出现的 scope 不再有 baseline，因此不计算「相对启动时的跌幅」。
  // 用于启动完成节点——后续新增的 workspace 不参与启动期容量判定。
  sealBaseline(path: string): void {
    this.sealed.add(path);
  }
  // 启动 2s 周期采样（unref 语义未显式设置，由调用方在合适时机 stop）。
  // 幂等：已有 timer 或已 stopped 时不重复创建。
  start(): void {
    if (!this.timer && !this.stopped)
      this.timer = setInterval(() => {
        void this.sample();
      }, SAMPLE_INTERVAL_MS);
  }
  // 执行一轮采样：逐个 scope 探测，scopeId 变化时迁移记录，结束后回调 onSample。
  // 与 addPath 共用 busy 标志，保证同一时刻只有一轮探测（避免 statfs 并发争抢与 Map 竞争）。
  // 失败语义：单个 scope 失败只降级 quality，继续处理其余 scope；stop 后中途 break。
  async sample(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const scope of [...this.scopes.values()]) {
        if (this.stopped) break;
        try {
          const result = await this.probe(scope.path);
          if (!this.stopped) {
            if (scope.scopeId !== result.scope) {
              this.scopes.delete(scope.scopeId);
              const existing = this.scopes.get(result.scope);
              if (existing) {
                this.record(existing, result.availableBytes);
                continue;
              }
              scope.scopeId = result.scope;
              scope.quality = "partial";
              this.scopes.set(result.scope, scope);
            }
            this.record(scope, result.availableBytes);
          }
        } catch {
          if (scope.quality === "complete") scope.quality = "partial";
        }
      }
      if (!this.stopped) this.options.onSample?.(this.snapshot());
    } finally {
      this.busy = false;
    }
  }
  // 记录一次可用量读数：更新最小值、采样时间；有 baseline 时同步更新跌幅峰值。
  // 跌幅峰值只在 minAvailableBytes 下探时增大（Math.max(0, baseline - min)），不会因回升而减小。
  private record(scope: Scope, available: number): void {
    scope.minAvailableBytes = Math.min(scope.minAvailableBytes ?? available, available);
    scope.sampledAt = Date.now();
    if (scope.baseline !== null)
      scope.observedAvailableDropPeakBytes = Math.max(0, scope.baseline - scope.minAvailableBytes);
  }
  // 输出公开摘要：剔除内部字段 path 与 baseline（它们只是采样器的工作变量）。
  // 返回新对象，调用方无法通过摘要修改内部状态。
  snapshot(): StartupDiskSummary[] {
    return [...this.scopes.values()].map(({ path: _path, baseline: _baseline, ...summary }) => ({
      ...summary,
    }));
  }
  // 永久停止：置 stopped 并清定时器；之后 addPath/sample 均不再工作（不可重启）。
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
