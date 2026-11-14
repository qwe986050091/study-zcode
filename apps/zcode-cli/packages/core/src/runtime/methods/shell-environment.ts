// ============================================================
// runtime/methods/shell-environment.ts —— resume 后 shell 变更提醒的判定与文案
// ============================================================
// 定位：链路 5 冷恢复的提示层：只判断"是否要告诉模型 Bash 现在用哪个 shell"，
//   不写 session 快照，也不决定 shell 选择本身。
// 输入：持久化时的 envInfo.shell + 快照恢复结论 + 当前选择；
// 输出：ShellEnvironmentResumeNoticeKind 或 undefined。
// 关键不变量：restored 表示快照成功沿用，不得再提示（否则破坏"shell 只对新 session 生效"）；
//   只有无可用快照（missing/invalid/stale/fallback）且确有变化时才生成提醒。
// ============================================================
import type { ExecutionShellSelection } from "../deps.js";
import type { BashShellSnapshotRestore } from "./bash-shell-snapshot.js";

export type ShellEnvironmentResumeNoticeKind =
  | "display_change"
  | "windows_git_bash_auto_migration";

export function getShellEnvironmentResumeNoticeKind(options: {
  persistedShell: string | undefined;
  restoreStatus: BashShellSnapshotRestore["status"];
  selection: ExecutionShellSelection | undefined;
}): ShellEnvironmentResumeNoticeKind | undefined {
  // restored 说明会话继续沿用原 shell，不需要提醒；没有选择也无从比较。
  if (!options.selection || options.restoreStatus === "restored") {
    return undefined;
  }

  // auto-detected 的 git-bash 属于升级后的行为迁移，优先级高于普通显示名差异。
  if (isWindowsGitBashAutoMigration(options.selection)) {
    return "windows_git_bash_auto_migration";
  }

  // 只有前后显示名都可用且不同才算变更；任一侧缺失时不产生提醒。
  return hasShellDisplayChanged(options.persistedShell, options.selection)
    ? "display_change"
    : undefined;
}

export function buildShellEnvironmentResumeNotice(
  kind: ShellEnvironmentResumeNoticeKind,
  selection: ExecutionShellSelection,
): string {
  // 文案必须稳定：上层 attachment 去重按 source + content 精确匹配，改字就会重复注入。
  if (kind === "windows_git_bash_auto_migration") {
    return "The Bash tool shell is Git Bash.";
  }

  return `The Bash tool shell is ${selection.display.name}.`;
}

export function hasShellDisplayChanged(
  previousShell: string | undefined,
  selection: ExecutionShellSelection | undefined,
): selection is ExecutionShellSelection {
  const previousDisplayName = normalizeShellDisplayName(previousShell);
  const nextDisplayName = normalizeShellDisplayName(selection?.display.name);
  // 返回类型守卫：true 时把 selection 收窄为非空，调用方可直接当"有 shell"使用。
  return previousDisplayName !== undefined && nextDisplayName !== undefined
    ? previousDisplayName !== nextDisplayName
    : false;
}

function isWindowsGitBashAutoMigration(selection: ExecutionShellSelection): boolean {
  // 只认自动探测的 git-bash；用户显式配置同方言不算"迁移"，不该提示。
  return selection.dialect === "git-bash" && selection.source === "auto-detected";
}

function normalizeShellDisplayName(value: string | undefined): string | undefined {
  // trim 后空串按"未设置"处理，避免 "" 与 undefined 被误判成一次变更。
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
