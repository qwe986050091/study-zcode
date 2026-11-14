import type { AgentRuntimeInternal } from "./internal.js";

/**
 * ============================================================================
 * runtime/permission-grant-recovery.ts —— "已提交但未发布"的权限放行恢复点
 * ============================================================================
 *
 * 【为什么需要】
 *   grantPermissionFullAccess 是"事务提交 → 内存发布 → 事件发布"三段式:
 *   session entry/receipt 已写入代表授权已经 durable,但内存 config 与
 *   SessionModeChanged 事件可能还没落地。若此时进程内又发生 mode 变更
 *   (applyRuntimeExecutionState),新状态会与队列项的 intent 口径冲突。
 *
 * 【口径】
 *   WeakMap 以 runtime 实例为键,只保存在途恢复动作,不复制权限或队列事实,
 *   避免出现"第二份真相";键随 runtime 回收,不需要显式清理。
 *
 * 【不变量】恢复动作必须是幂等的:重复调用最终 publish 同一只事件 id,
 * 不会制造第二个授权或第二次 mode 变更。
 * ============================================================================
 */

// 不保存第二份权限/队列，只记录事务已提交但事件尚未发布的恢复动作。
export const unpublishedPermissionGrants = new WeakMap<
  AgentRuntimeInternal,
  {
    interactionId: string;
    recover: () => Promise<string>;
  }
>();

/**
 * 执行该 runtime 上待发布的权限放行恢复动作。
 *
 * 输入:runtime;输出:Promise<void>(完成即内存与事件都已发布)。
 * 副作用:会重入 grantPermissionFullAccess(读 receipt、补发事件、更新 config)。
 * 降级语义:没有待恢复项时 no-op;恢复本身失败会原样向上抛,由调用方决定
 * 是否中止本次 mode 变更(不允许在权限半发布状态下继续改状态)。
 */
export async function recoverPendingPermissionGrant(runtime: AgentRuntimeInternal): Promise<void> {
  await unpublishedPermissionGrants.get(runtime)?.recover();
}
