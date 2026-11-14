// 扫描编排层：把 walker（遍历）、domain 累加器（聚合）与卷探测（容量）拼成一次完整扫描。
// 边界：这里不碰 IO 细节，也不持有 UI 状态；进度必须通过回调同步给调用方，自身不留历史。
// 不变量：根之间互不影响——单根的探测或遍历失败只进 errors，不中断其余根，仍返回完整 progress。
// 失败路径：中止由 signal 透传给 walker，不吞异常，交由上层区分「用户取消」与「真实失败」。
/**
 * 进程内扫描 runner：walker + domain 累加器 + 卷探测。
 * Worker 入口（desktop main）与单测都调用这里的 runStorageScan，保证只有一条扫描路径。
 */
import type { StorageScanProgress, VolumeProbePort } from "../app/ports.js";
import type { StoragePathError, StorageRootSpec, StorageRootUsage } from "@zcode/shared";
import { createStorageUsageAccumulator } from "../domain/usageAggregate.js";
import { walkStorageRoot } from "./fsWalker.js";
import { createFsVolumeProbe } from "./volumeProbe.js";

// 依赖全部可注入（probe / now / 上报间隔），使扫描在单测里确定可复现，无需真实磁盘与时序。
// progressIntervalMs 是背压阀：遍历可能每秒产生上万条目，逐条上报会淹掉主线程消息队列。
export interface RunStorageScanOptions {
  roots: StorageRootSpec[];
  signal: AbortSignal;
  onProgress: (progress: StorageScanProgress) => void;
  volumeProbe?: VolumeProbePort;
  /** 上报进度的最小间隔；runner 自己也节流，避免 Worker 向主线程刷消息。默认 300ms。 */
  progressIntervalMs?: number;
  concurrency?: number;
  now?: () => number;
}

// 返回值必须是最终快照，且与最后一次 onProgress 的内容一致，调用方以此判定扫描结束。
// 只有所有根都处理完才返回，所以 errors 非空不代表整体失败，而是部分路径不可读。
export async function runStorageScan(options: RunStorageScanOptions): Promise<StorageScanProgress> {
  // 时钟与卷探测都可注入；缺省用 Date.now 与真实 fs 探测，单测传假实现即可脱离磁盘与时序。
  const now = options.now ?? Date.now;
  const probe = options.volumeProbe ?? createFsVolumeProbe();
  const interval = options.progressIntervalMs ?? 300;
  const errors: StoragePathError[] = [];
  const finished: StorageRootUsage[] = [];
  let lastReportAt = -Infinity;

// 逐根串行：每个根用独立累加器与独立卷信息，避免跨根串味；串行也让进度上报顺序稳定。
// lastReportAt 在闭包外共享，节流跨条目持续生效，不会因条目密集而放大上报次数。
  for (const root of options.roots) {
    // 每个根必须新建累加器与卷信息，避免上一根的统计和容量串到下一根。
    const accumulator = createStorageUsageAccumulator(root);
    const volume = await probe.probe(root.path);
    // report 每次读取 finished 与 errors 的当前快照；lastReportAt 在外层更新，节流对后续条目持续有效。
    const report = () => {
      lastReportAt = now();
      options.onProgress({
        roots: [...finished, accumulator.snapshot(volume)],
        errors: [...errors],
      });
    };
    await walkStorageRoot({
      rootPath: root.path,
      signal: options.signal,
      concurrency: options.concurrency,
      onEntry: (entry) => {
        accumulator.add(entry);
        if (now() - lastReportAt >= interval) report();
      },
      // onError 给错误路径加上根前缀，调用方才能区分同名相对路径属于哪个根；这里只记录错误不返回，继续遍历剩余条目。
      onError: (error) => errors.push({ ...error, path: `${root.id}:${error.path}` }),
    });
    // 根处理完即落一份快照，后续根的进度里也带上它，保证 roots 顺序与 reports 一致。
    finished.push(accumulator.snapshot(volume));
  }
  const progress = { roots: finished, errors };
  // 收尾必须再发一次最终进度，即使节流刚触发过；调用方依赖这次回调确认扫描结束。
  options.onProgress(progress);
  return progress;
}
