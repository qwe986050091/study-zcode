/**
 * 单次扫描 job：持有 AbortController，把 runner 的进度节流成 ≥ throttleMs 一次的快照事件，
 * 终态（complete / cancelled / failed）必发。状态只能 scanning → 终态。
 */
// 依赖只来自 shared 协议与本地端口，本文件不直接触碰文件系统，扫描细节全部由 ScanRunnerPort 承担。
// 这样 job 层可以完全用假 runner 与假时钟测试节流与终态语义，不需要真实磁盘。
import type { StorageRootSpec, StorageUsageSnapshot } from "@zcode/shared";
import type { ScanRunnerPort, StorageScanProgress } from "./ports.js";

// 对外契约：done 是唯一的完成信号，成功与失败都以快照形式 resolve，调用方不需要额外 try/catch。
// cancel 只发出协作式取消信号，不等待 runner 退出；真正的取消结果通过 done 的快照 status 体现。
// cancel 允许重复调用（AbortController 本身幂等），因此不做额外状态判断。
export interface ScanJob {
  readonly jobId: string;
  readonly done: Promise<StorageUsageSnapshot>;
  cancel(): void;
}

// 取消错误在各 Node 版本/实现中既可能是 AbortError 也可能是自定义 Error，统一按 name 判定，避免依赖 instanceof DOMException。
// 只认 name，不读取 message，防止把业务错误里恰好含 abort 字样的情况误判为取消。
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// now/setTimer/clearTimer 可注入，用于测试确定性；生产环境走真实时钟与 setTimeout。
// roots 在开始时即转成零值快照，保证第一次进度事件之前调用方也能拿到完整结构，而不是半成品。
// 该函数不做任何 Promise 等待，立即返回 job 句柄，扫描在后台推进。
export function createScanJob(params: {
  jobId: string;
  roots: StorageRootSpec[];
  runner: ScanRunnerPort;
  now: () => number;
  throttleMs: number;
  emit: (snapshot: StorageUsageSnapshot) => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): ScanJob {
  const { jobId, roots, runner, now, throttleMs, emit } = params;
  const setTimer = params.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = params.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  // 取消信号是 job 与 runner 之间唯一的控制通道，runner 必须自行检查 signal 才能及时停止。
  // startedAt 取创建时刻而非首条进度时刻，便于 UI 展示整体耗时。
  const controller = new AbortController();
  const startedAt = now();
  let latest: StorageUsageSnapshot = {
    jobId,
    status: "scanning",
    startedAt,
    roots: roots.map((root) => ({
      id: root.id,
      path: root.path,
      volume: null,
      bytes: 0,
      fileCount: 0,
      categories: [],
    })),
    errors: [],
  };
  // lastEmitAt 初值为 -Infinity，使第一条进度事件必然立即发送，避免首屏长时间空白。
  // pendingTimer 表示已排队但尚未执行的尾部刷新；settled 用于在终态后丢弃迟到的进度回调。
  let lastEmitAt = -Infinity;
  let pendingTimer: unknown = null;
  let settled = false;

  // flush 同时承担「立即发送」与「定时器回调」两种角色，因此先清空句柄再记录时间，避免重入时重复排期。
  // emit 由调用方实现，可能同步抛错；这里不捕获，因为事件投递失败属于调用方契约问题。
  const flush = () => {
    pendingTimer = null;
    lastEmitAt = now();
    emit(latest);
  };
  // 进度快照整体替换而非增量合并，避免 runner 复用同一数组导致已发出的快照被后续修改。
  // 节流策略：距上次发送已超过窗口则立刻 flush，否则只在「没有挂起定时器」时补一个尾部定时器。
  // 这样高频进度最多产生一次尾部事件，不会因为持续更新而反复重置定时器、饿死输出。
  const onProgress = (progress: StorageScanProgress) => {
    if (settled) return;
    latest = { ...latest, roots: progress.roots, errors: progress.errors };
    const elapsed = now() - lastEmitAt;
    if (elapsed >= throttleMs) {
      flush();
    } else if (pendingTimer == null) {
      pendingTimer = setTimer(flush, throttleMs - elapsed);
    }
  };
  // 所有终态都经过 settle：置 settled、取消挂起的尾部定时器（防止终态后又被旧快照覆盖），再强制发送一次。
  // 终态快照必须发送，即使与上一条进度内容相同，调用方依赖它解锁 UI。
  // 返回值回传给 done，保证 done 的 resolve 值与最后一次 emit 的内容一致。
  const settle = (snapshot: StorageUsageSnapshot) => {
    settled = true;
    if (pendingTimer != null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    latest = snapshot;
    emit(latest);
    return latest;
  };

  // runner 的成功与失败都收敛成快照：成功时按 signal 是否已 abort 区分 complete / cancelled。
  // status 以 signal 为准而不是 runner 的返回值，因为取消可能发生在 runner 正常返回的前一刻。
  // finishedAt 统一在此刻取时，保证终态时间单调且晚于 startedAt。
  const done = runner
    .run({ roots, signal: controller.signal, onProgress })
    .then((progress) =>
      settle({
        ...latest,
        roots: progress.roots,
        errors: progress.errors,
        status: controller.signal.aborted ? "cancelled" : "complete",
        finishedAt: now(),
      }),
    )
    // 失败分支同样先判取消：runner 可能在响应 abort 时抛出 AbortError，不能记成 failed。
    // 真正的失败追加一条 path 为空的错误项（表示整体性失败而不是单文件失败），并保留已有错误列表。
    .catch((error: unknown) =>
      settle({
        ...latest,
        status: isAbortError(error) || controller.signal.aborted ? "cancelled" : "failed",
        finishedAt: now(),
        errors: isAbortError(error)
          ? latest.errors
          : [...latest.errors, { path: "", code: errorCode(error) }],
      }),
    );

  return {
    jobId,
    done,
    cancel: () => controller.abort(),
  };
}

// 错误码优先取 Node 风格对象上的 string code，其次退回 Error.name，最后 UNKNOWN，保证快照里该字段始终可序列化。
function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}
