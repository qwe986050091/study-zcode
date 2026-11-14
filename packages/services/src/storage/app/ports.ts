/**
 * app 层端口：storageService 只依赖这些接口，IO 由 adapters 实现并在 desktop host 注入。
 */
// storage 应用层只通过这里声明的端口触达文件系统与扫描/清理实现，自身不 import 任何 Node IO。
// 边界：平台差异由 adapters 承担并在 desktop host 注入；改错会让 app 层直接耦合 fs 实现。
// INV：耗时操作都接受 AbortSignal 并返回失败项集合，而不是抛异常中断整批，保证部分失败仍可用。
import type { StorageCleanCandidate } from "../domain/cleanPlan.js";
import type { StorageCleanScope } from "../domain/storageCatalog.js";
import type {
  StoragePathError,
  StorageRootSpec,
  StorageRootUsage,
  StorageVolume,
} from "@zcode/shared";

// 根目录只是只读快照；调用方不得缓存它做删除决策，磁盘可能在此期间被挂载或卸载。
export interface RootsResolverPort {
  resolveRoots(): Promise<StorageRootSpec[]>;
}

// errors 与 roots 必须同时返回：单个根失败不能让整次扫描变成不可用，UI 需要展示降级结果。
export interface StorageScanProgress {
  roots: StorageRootUsage[];
  errors: StoragePathError[];
}

export interface StorageScanRunRequest {
  roots: StorageRootSpec[];
  signal: AbortSignal;
  /** 运行方按自己的节奏上报；节流由 app 层的 job 负责。 */
  onProgress: (progress: StorageScanProgress) => void;
}

export interface ScanRunnerPort {
  /** 取消时以 AbortError（name === "AbortError"）拒绝。 */
  run(request: StorageScanRunRequest): Promise<StorageScanProgress>;
}

// 返回 null 表示卷不可读（权限不足或已卸载），这是预期内的探测结果，与抛错语义区分。
export interface VolumeProbePort {
  probe(path: string): Promise<StorageVolume | null>;
}

export interface StorageDeleteResult {
  deletedCount: number;
  freedBytes: number;
  failures: StoragePathError[];
}

// listCandidates 与 deleteFiles 必须使用同一 rootPath；keepDirectories 保留目录骨架，避免清理后目录树变化导致索引失配。
export interface FsCleanerPort {
  listCandidates(rootPath: string, scopes: StorageCleanScope[]): Promise<StorageCleanCandidate[]>;
  deleteFiles(
    rootPath: string,
    targets: StorageCleanCandidate[],
    options: { keepDirectories: string[] },
  ): Promise<StorageDeleteResult>;
}
