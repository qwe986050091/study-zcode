/**
 * IStorageService 实现：扫描 job、最近快照、清理的唯一 owner。
 * 不做 IO；根目录、遍历、删除、系统定位全部通过 ports 注入。
 */
import { Emitter } from "@zcode/rpc";
import type { IStorageService } from "../contract.js";
import { planStorageClean } from "../domain/cleanPlan.js";
import { getStorageCategoryCleanability, getStorageCleanScopes } from "../domain/storageCatalog.js";
import type { StorageRootId, StorageRootSpec, StorageUsageSnapshot } from "@zcode/shared";
import type { FsCleanerPort, RootsResolverPort, ScanRunnerPort } from "./ports.js";
import { createScanJob, type ScanJob } from "./scanJob.js";

// 依赖全部声明为端口：根目录解析、扫描执行与删除动作可分别替换，服务不感知系统差异。
export interface StorageServiceDependencies {
  roots: RootsResolverPort;
  scanRunner: ScanRunnerPort;
  cleaner: FsCleanerPort;
  now?: () => number;
  /** 进度事件最小间隔，默认 300ms。 */
  progressThrottleMs?: number;
}

// 默认节流值取 300ms：进度事件过密会放大 IPC 与渲染压力，过疏则扫大目录时进度条明显卡顿。
export const DEFAULT_STORAGE_PROGRESS_THROTTLE_MS = 300;

// 采用工厂函数而非 class：三处外部能力全部由 ports 注入，服务自身不触碰文件系统，便于替换实现与单测。
// 每个实例独占 job、快照与节流状态，多窗口或多根目录场景下互不干扰；调用方需自行保证 dispose。
export function createStorageService(deps: StorageServiceDependencies): IStorageService {
  const now = deps.now ?? Date.now;
  const throttleMs = deps.progressThrottleMs ?? DEFAULT_STORAGE_PROGRESS_THROTTLE_MS;
  const progressEmitter = new Emitter<StorageUsageSnapshot>();
  let currentJob: ScanJob | null = null;
  let latestSnapshot: StorageUsageSnapshot | null = null;
  let latestJobId: string | null = null;
  let jobCounter = 0;

  // 取消是同步且幂等的：只清空持有并通知 ScanJob 停止，不等待其真正收尾。
  function cancelCurrentJob(): void {
    currentJob?.cancel();
    currentJob = null;
  }

  // 根目录缺失按不可恢复错误处理：继续执行会以错误路径遍历或删除，宁可让调用方进入失败态。
  async function resolveRoot(rootId: StorageRootId): Promise<StorageRootSpec> {
    const root = (await deps.roots.resolveRoots()).find((candidate) => candidate.id === rootId);
    if (!root) throw new Error(`storage root not available: ${rootId}`);
    return root;
  }

  return {
    // 单实例同时只允许一个扫描：新扫描先取消旧的，避免两路遍历并发写同一份快照。
    async startScan() {
      cancelCurrentJob();
      const jobId = `scan-${++jobCounter}`;
      latestJobId = jobId;
      // 每次扫描重新解析根目录，用户可能在两次扫描间新增目录；解析失败直接抛出而不是用空集假装成功。
      const roots = await deps.roots.resolveRoots();
      const job = createScanJob({
        jobId,
        roots,
        runner: deps.scanRunner,
        now,
        throttleMs,
        emit: (snapshot) => {
          // 用 currentJob 判断会在用户主动 cancelScan 后（currentJob 已清空）丢掉取消态快照。
          // 这里按「最近一次启动的 job」判断：旧 job 被新 job 取代后发出的尾包不能覆盖新 job 的快照。
          if (jobId === latestJobId) {
            latestSnapshot = snapshot;
          }
          progressEmitter.fire(snapshot);
        },
      });
      // 登记发生在 emit 绑定之后，保证首个进度事件也已走「最新 job」判定，不会漏写快照。
      currentJob = job;
      // 收尾时比对 jobId 再清引用，避免旧 job 完成覆盖新 job 的持有关系；不 await 以免阻塞启动返回。
      void job.done.then(() => {
        if (currentJob?.jobId === jobId) currentJob = null;
      });
      return { jobId };
    },

    async cancelScan(jobId) {
      // 只允许取消当前 job：迟到的旧 jobId 直接忽略，防止误停用户刚发起的新扫描。
      if (currentJob?.jobId !== jobId) return;
      cancelCurrentJob();
    },

    async getSnapshot() {
      // 快照只反映最近一次启动的 job；读路径不做 IO 也不触发重算，尚未扫描时返回 null。
      return latestSnapshot;
    },

    onScanProgress: progressEmitter.event,

    async clean(request) {
      // 前置门禁放在最前：未知或受保护类别在触碰磁盘前就失败，杜绝误删用户数据。
      if (getStorageCategoryCleanability(request.categoryId) === "none") {
        throw new Error(`storage category is not cleanable: ${request.categoryId}`);
      }
      // 清理会改变磁盘内容，进行中的扫描结果会失真；先取消，UI 在清理后重新扫描。
      cancelCurrentJob();
      const root = await resolveRoot(request.rootId);
      // 作用域与可清理性来自同一静态目录，保证「能展示」与「能删除」的类别集合始终一致。
      const scopes = getStorageCleanScopes(request.categoryId);
      // 先枚举后决策：删除阶段只接受计划给出的路径，防止清单与删除之间范围被隐式放大。
      const candidates = await deps.cleaner.listCandidates(root.path, scopes);
      // [契约] planStorageClean 是纯函数：candidates 与 now 一次性传入，删除副作用只发生在后续执行阶段。
      // hasCustomDataBaseDir 参与判定，避免把用户自定义数据目录里的内容当作可清理缓存。
      const plan = planStorageClean({
        categoryId: request.categoryId,
        candidates,
        context: { rootId: root.id, hasCustomDataBaseDir: root.hasCustomDataBaseDir },
        now: now(),
      });
      // 删除范围严格限定为计划目标，并保留各作用域目录本身：目录重建成本高，部分运行期逻辑也依赖其存在。
      // 端口抛出的错误不在此吞掉，交由调用方判断是整体失败还是部分清理。
      const result = await deps.cleaner.deleteFiles(root.path, plan.targets, {
        keepDirectories: scopes.map((scope) => scope.prefix),
      });
      // 删除数量以文件系统端口的结果为准，仅补上计划阶段被跳过的条目数，便于 UI 解释差异。
      return { ...result, skippedCount: plan.skippedCount };
    },

    dispose() {
      cancelCurrentJob();
      // dispose 后不再允许任何事件外泄；重复调用安全，因为取消与释放都接受空状态。
      progressEmitter.dispose();
    },
  };
}
