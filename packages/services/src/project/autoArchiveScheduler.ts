// 任务自动归档调度器：由 Host 启动首轮扫描并按固定间隔重复，是 archiveInactive 的唯一触发者。
// 边界：只读策略与索引查询，不改任务内容；归档后仅在确有变更时通过 afterChange 广播。
// INV：扫描串行执行，进行中的调用合并为一次补扫；dispose 后不再读写，也不排队。
// 改错后果：把归档挂到 UI 读取或点击路径上，会让刚清未读的任务立刻消失，出现「点了打不开」。
import type { AutoArchiveInput, ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { ProjectTaskRef } from "#src/project/contract.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

/**
 * 扫描只读一次设置 + 一次索引小查询，代价可忽略；5 分钟让刚超期或刚失去保护的任务
 * 很快离开列表，又不会像挂在点击上那样「点开即消失」。
 */
export const TASK_AUTO_ARCHIVE_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/** 变更后需要立即补扫的设置键。 */
const TASK_AUTO_ARCHIVE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "taskAutoArchiveEnabled",
  "taskAutoArchiveOlderThanDays",
]);

// 只有命中 TASK_AUTO_ARCHIVE_SETTING_KEYS 的变更才触发补扫，避免无关设置引起全量归档事务。
export function shouldRescanTaskAutoArchive(keys: readonly string[]): boolean {
  return keys.some((key) => TASK_AUTO_ARCHIVE_SETTING_KEYS.has(key));
}

export interface TaskAutoArchiveSchedulerOptions {
  /** 读取当前策略；返回 null 表示自动归档关闭。 */
  readPolicy(): Promise<AutoArchiveInput | null>;
  repository(): Promise<Pick<ProjectRepositoryContract, "archiveInactive">>;
  /** 至少归档一条后调用，负责广播项目变更；没有变化时不调用。 */
  afterChange(): Promise<void>;
  intervalMs?: number;
}

export interface TaskAutoArchiveScheduler {
  /** 立即扫描一次并按固定间隔重复；重复调用无效。 */
  start(): void;
  /** 串行扫描；扫描进行中的调用合并为一次补扫。返回本次归档的任务。 */
  scan(): Promise<ProjectTaskRef[]>;
  dispose(): void;
}

/**
 * 自动归档的唯一触发者。
 *
 * Bug 根因（2026-09-14）：此前 archiveInactive 挂在项目服务 readTree 上，而侧栏每次
 * taskListVersion 变化都会重新 readTree。点开一条旧未读任务 → CAS 清未读 → 列表刷新 →
 * readTree 顺手归档了刚刚变成「无未读」的这条任务 → 项目树 false→true 清理详情，用户感知
 * 为「点了打不开」。归档判定不能由任何 UI 读取或点击触发，所以收口为 Host 定时扫描：
 * 启动首轮 + 固定间隔 + 自动归档设置变更后补扫。
 */
export function createTaskAutoArchiveScheduler(
  options: TaskAutoArchiveSchedulerOptions,
): TaskAutoArchiveScheduler {
  // logger 带固定作用域，便于按 task-auto-archive 过滤该调度器的告警。
  const log = createServiceLogger("task-auto-archive");
  // 测试用 intervalMs 覆盖默认 5 分钟；生产不传，保证扫描节奏与常量一致。
  const intervalMs = options.intervalMs ?? TASK_AUTO_ARCHIVE_SCAN_INTERVAL_MS;
  // timer 只在 start 之后存在，判空即可挡住重复 start。
  let timer: ReturnType<typeof setInterval> | null = null;
  // disposed 一旦置位不复位；释放后的 scan 直接返回空数组，不再读策略与索引。
  let disposed = false;
  // running 是当前扫描，queued 是撞车时的补扫，两者共同把归档事务串成一条链并合并等待者。
  let running: Promise<ProjectTaskRef[]> | null = null;
  let queued: Promise<ProjectTaskRef[]> | null = null;

  const runOnce = async (): Promise<ProjectTaskRef[]> => {
    // 每轮都重读策略而不是缓存：设置变更后下一轮必须立刻生效，缓存只能等重启。
    const policy = await options.readPolicy();
    // 关闭自动归档或已释放时什么也不做；disposed 在 await 之后复查，覆盖等待期间被 dispose 的情况。
    if (!policy || disposed) return [];
    // repository 每次现取：仓储可能在运行期被替换，缓存实例会把写打到旧库。
    const archived = (await options.repository()).archiveInactive(policy);
    // archiveInactive 单次调用即一个写事务；本调度器不重试，失败留给下一轮扫描，
    // 已归档的部分不会回滚，因此重扫必须依赖归档判定自身幂等。
    // 无变化就提前返回，不调用 afterChange，避免一次无意义的项目广播唤醒全部订阅者。
    if (archived.length === 0) return archived;
    log.info(undefined, `自动归档 ${archived.length} 条任务`, {
      cutoff: policy.cutoff,
      taskIds: archived.map((task) => task.taskId),
    });
    // 只有真的归档了才广播；空广播会让侧栏重渲染并可能触发新的归档判定。
    await options.afterChange();
    // 返回归档结果供手动扫描与测试核对，不依赖广播的副作用。
    return archived;
  };

  const scan = (): Promise<ProjectTaskRef[]> => {
    if (disposed) return Promise.resolve([]);
    // 首个调用直接起 runOnce 并登记 Promise；并发的后来者只能等待或排队，不会各开一次事务。
    if (!running) {
      running = runOnce().finally(() => {
        running = null;
      });
      return running;
    }
    // 设置变更与定时器可能撞在同一轮：进行中的扫描读的是旧策略，结束后必须再扫一次；
    // 多个等待者共享同一次补扫，避免排队重复写事务。
    // 补扫串在 running 之后：进行中的扫描读的是旧策略，结束后必须再扫一轮才能覆盖新设置。
    queued ??= running
      .catch(() => [])
      .then(() => {
        // 先置空再重入 scan：让补扫重新登记到 running；否则后来者会接到已完成的 Promise 而漏掉这次设置变更。
        queued = null;
        return scan();
      });
    // 所有等待者共享同一个补扫 Promise，避免同一次设置变更触发多次写事务。
    return queued;
  };

  const scanInBackground = () => {
    // 定时器回调不能 await，失败必须在这里吞掉，否则会变成 unhandled rejection 且下一轮照旧。
    void scan().catch((error) => {
      // 只记 warn 不重试：失败留给下一个间隔，连续重试会在故障时放大写压力。
      log.warn(undefined, "自动归档扫描失败，等待下一轮", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return {
    start() {
      // timer 已存在或已 dispose 就直接返回，重复 start 不会叠出两条间隔。
      if (timer || disposed) return;
      // 启动先扫一轮再挂间隔：等满 5 分钟才首扫会让启动瞬间已超期的任务继续留在列表。
      scanInBackground();
      // 间隔回调不 await，重叠由 scan 内部的 running/queued 合并。
      timer = setInterval(scanInBackground, intervalMs);
      // unref 让定时器不阻止进程退出；测试进程不会因为它挂住。
      timer.unref?.();
    },
    scan,
    dispose() {
      // 先置位再清定时器：进行中的扫描在下一处 await 后会看到 true，不再访问仓储。
      disposed = true;
      // 清定时器但不等待进行中的扫描：它可能在 dispose 后落库，runOnce 只在读策略前判活。
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
