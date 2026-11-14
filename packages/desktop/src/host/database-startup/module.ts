/**
 * host-database-startup 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
// 模块清单只描述依赖与公开入口，不执行任何逻辑。
// requires / provides 必须与 architecture-policy.yaml 双向一致（检查器会比对），
// publicEntrypoints 之外的实现文件不属于模块对外面。
export const hostDatabaseStartupModule = {
  id: "host-database-startup",
  requires: ["project-storage", "shared", "desktop"],
  provides: ["host-database-startup"],
  publicEntrypoints: [
    "contract.ts",
    "tasksStorageWorker.ts",
    "hostDatabaseStartup.ts",
    "storagePreparationProcesses.ts",
  ],
} as const;
