/**
 * ============================================================================
 * hooks/workspace-hook-trust-domain.ts —— 工作区 Hook 信任域子聚合
 * ============================================================================
 *
 * 把策略、协调器、信任记录与类型四个模块聚成一个入口,由 index.ts 统一导出;
 * domain 内部可以自由拆分文件,而外部只依赖这一条稳定边界（链路 9）。
 * 纯再导出,没有初始化副作用,导出顺序不影响调用方。
 * ============================================================================
 */
// 策略:单个工作区 policy 的读写与变更通知。
export * from "./workspace-hook-policy.js";
// 协调器:持久记录、撤销墓碑与 securityRevision 的唯一所有者。
export * from "./workspace-hook-trust-coordinator.js";
// 记录构造:把一次审核选择冻结成"授权时快照"的持久记录。
export * from "./workspace-hook-trust-records.js";
// 类型:store 状态与一次快照评估结果的口径。
export type * from "./workspace-hook-trust-types.js";
