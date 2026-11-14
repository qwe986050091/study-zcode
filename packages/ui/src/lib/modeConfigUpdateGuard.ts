// INV-01 保护窗口仅三秒：守住位置 TTL 常量；改错故障 后续真实切换被吞掉。
// INV-02 保护按工作区隔离：守住位置 状态键；改错故障 多工作区互相误伤。
// INV-03 模式名归一化后比较：守住位置 normalizeModeId；改错故障 前后空格导致不匹配。
// INV-04 过期即删除：守住位置 读取时判断；改错故障 陈旧守卫长期生效。
// INV-05 空任务或空模式不登记：守住位置 早退；改错故障 无意义守卫拦截回包。
// INV-06 登记记录任务与模式：守住位置 set 调用；改错故障 无法判断是否同一任务。
// INV-07 带模式清除才精确删除：守住位置 模式比较；改错故障 误删其它切换的守卫。
// INV-08 不带模式清除整工作区：守住位置 undefined 分支；改错故障 残留守卫。
// INV-09 回包模式一致即确认：守住位置 ack 比较；改错故障 守卫永不释放。
// INV-10 确认后删除守卫：守住位置 清除调用；改错故障 后续合法回包被拦截。
// INV-11 任务不一致即放行：守住位置 任务比对；改错故障 其它任务的配置更新被丢弃。
// INV-12 当前模式不一致即放行：守住位置 模式比对；改错故障 用户手动切换被回滚。
// INV-13 回包已回到目标即放行并清除：守住位置 相等分支；改错故障 保护窗口一直挂着。
// INV-14 仅当回包是另一模式才保留：守住位置 末尾布尔；改错故障 无害更新被拦截。
// INV-15 无守卫默认放行：守住位置 空值早退；改错故障 所有配置更新被拒。
// INV-16 状态键复用统一选择器：守住位置 resolveWorkspaceStateKey；改错故障 身份与路径口径分裂。
// INV-17 只存内存不持久化：守住位置 模块级 Map；改错故障 重启后仍拦截。
// INV-18 测试重置入口独立：守住位置 resetForTest；改错故障 单测之间互相污染。
//
// 模块职责：在本地发起模式切换后短暂拦截并发配置回包，避免刚切好的模式被旧响应回滚。
// 状态所有权：模块级 Map 按工作区保存守卫，过期或确认后删除。
// 阅读顺序：先看归一化与读取，再看登记与清除，最后看配置更新是否保留当前模式。
import { resolveWorkspaceStateKey } from "@/store/zcodeSessionStoreSelectors.js";

interface PendingModeSwitchGuard {
  taskId: string;
  modeId: string;
  expiresAt: number;
}

// Bugfix: 保护窗口只覆盖“本地 setMode 刚发起后的并发回包”，窗口过长会吞掉后续真实 mode 变更。
const PENDING_MODE_SWITCH_GUARD_TTL_MS = 3000;
const pendingModeSwitchGuardByWorkspaceKey = new Map<string, PendingModeSwitchGuard>();

function normalizeModeId(modeId: string | null | undefined): string | null {
  if (typeof modeId !== "string") {
    return null;
  }
  const normalized = modeId.trim();
  return normalized.length > 0 ? normalized : null;
}

// 先用 resolveWorkspaceStateKey 求 workspaceKey。
// guard 不存在时返回 null。
// expiresAt 不晚于 Date.now() 时删除并返回 null。
// 未过期时原样返回 guard。
function readPendingModeSwitchGuard(
  workspacePath: string,
  workspaceIdentity?: string,
): PendingModeSwitchGuard | null {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  const guard = pendingModeSwitchGuardByWorkspaceKey.get(workspaceKey);
  if (!guard) {
    return null;
  }
  if (guard.expiresAt <= Date.now()) {
    pendingModeSwitchGuardByWorkspaceKey.delete(workspaceKey);
    return null;
  }
  return guard;
}

// normalizeModeId 归一 modeId，taskId 只做 trim。
// normalizedModeId 或 normalizedTaskId 为空时直接 return。
// 以 workspaceKey 为键写入，expiresAt 加 TTL。
export function markPendingModeSwitchGuard(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  modeId: string;
}): void {
  const normalizedModeId = normalizeModeId(params.modeId);
  const normalizedTaskId = params.taskId.trim();
  if (!normalizedModeId || normalizedTaskId.length === 0) {
    return;
  }

  const workspaceKey = resolveWorkspaceStateKey(
    params.workspacePath,
    params.workspaceIdentity,
  );
  pendingModeSwitchGuardByWorkspaceKey.set(workspaceKey, {
    taskId: normalizedTaskId,
    modeId: normalizedModeId,
    expiresAt: Date.now() + PENDING_MODE_SWITCH_GUARD_TTL_MS,
  });
}

// params.modeId 不是字符串时删整个 workspaceKey。
// 带 modeId 时只有 guard.modeId 相等才删除。
// normalizedModeId 为空或不匹配时保留 guard。
export function clearPendingModeSwitchGuard(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  modeId?: string;
}): void {
  const workspaceKey = resolveWorkspaceStateKey(
    params.workspacePath,
    params.workspaceIdentity,
  );
  if (typeof params.modeId !== "string") {
    pendingModeSwitchGuardByWorkspaceKey.delete(workspaceKey);
    return;
  }

  const guard = pendingModeSwitchGuardByWorkspaceKey.get(workspaceKey);
  const normalizedModeId = normalizeModeId(params.modeId);
  if (!guard || !normalizedModeId || guard.modeId !== normalizedModeId) {
    return;
  }
  pendingModeSwitchGuardByWorkspaceKey.delete(workspaceKey);
}

// 先调用 readPendingModeSwitchGuard 取 guard。
// guard.modeId 等于 normalizedModeId 才算确认。
// 确认后调用 clearPendingModeSwitchGuard 清除。
export function ackPendingModeSwitchGuardFromModeUpdate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  modeId: string | null | undefined;
}): void {
  const guard = readPendingModeSwitchGuard(
    params.workspacePath,
    params.workspaceIdentity,
  );
  const normalizedModeId = normalizeModeId(params.modeId);
  if (!guard || !normalizedModeId || guard.modeId !== normalizedModeId) {
    return;
  }
  clearPendingModeSwitchGuard({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
}

// guard.taskId 与 activeTaskId 不相等时返回 false。
// currentModeId 与 guard.modeId 不一致时返回 false。
// incomingModeId 已等于 guard.modeId 时清除并返回 false。
export function shouldPreserveModeAgainstConfigUpdate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activeTaskId: string | null;
  currentModeId: string | null;
  incomingModeId: string | null;
}): boolean {
  const guard = readPendingModeSwitchGuard(
    params.workspacePath,
    params.workspaceIdentity,
  );
  if (!guard) {
    return false;
  }

  const normalizedActiveTaskId = params.activeTaskId?.trim() ?? "";
  if (normalizedActiveTaskId.length === 0 || guard.taskId !== normalizedActiveTaskId) {
    return false;
  }

  const normalizedCurrentModeId = normalizeModeId(params.currentModeId);
  const normalizedIncomingModeId = normalizeModeId(params.incomingModeId);

  if (normalizedIncomingModeId === guard.modeId) {
    // Bugfix: 运行态已经回到本次切换目标 mode，说明保护窗口可关闭，避免后续合法回包被继续拦截。
    clearPendingModeSwitchGuard({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      modeId: normalizedIncomingModeId ?? undefined,
    });
    return false;
  }

  if (!normalizedCurrentModeId || normalizedCurrentModeId !== guard.modeId) {
    return false;
  }

  return Boolean(
    normalizedIncomingModeId &&
      normalizedIncomingModeId !== normalizedCurrentModeId,
  );
}

export function resetPendingModeSwitchGuardForTest(): void {
  pendingModeSwitchGuardByWorkspaceKey.clear();
}
