// 共享 help 表（BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES）是保留字、TUI 候选与 App 目录的
// 唯一来源；这里再并入 compress/plan 两个「由本地 UI 提供但名字必须留住」的入口。
// 保留名解析与自定义命令解析共用下方归一化规则，避免大小写/斜杠差异绕过保留判定。
import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } from "@zcode/shared";

/**
 * App `/` 面板与加号菜单按本顺序展示（UI 不维护排序白名单）。`workflow` 紧随 `goal`：两者都是
 * 「开启一段工作」的入口（docs/ui/chat-composer-action-menu.md「工作流入口」）；它受灰度门约束，
 * 由 zcode-protocol/slash-commands.ts 在装配时剔除。
 */
export const APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES = [
  "goal",
  "workflow",
  "compact",
  "init",
] as const;

// Plan 由 Composer 本地操作提供，保留名称以防自定义命令接管该入口。
const EXTRA_RESERVED_SLASH_COMMAND_NAMES = ["compress", "plan"] as const;

const RESERVED_SLASH_COMMAND_NAMES = new Set(
  BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.flatMap((entry) => [
    entry.name,
    ...(entry.aliases ?? []),
  ]).concat([...EXTRA_RESERVED_SLASH_COMMAND_NAMES]),
);

// 归一化口径：trim、去掉全部前导斜杠、小写。与 custom-commands.ts 的 normalizeCommandName 一致。
export function normalizeZCodeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

/**
 * 是否为保留名（内置命令名及其别名，外加 compress/plan）。命中意味着自定义命令解析必须
 * 返回 undefined：保留名不是「UI 隐藏」，而是拒绝展开，防止同名文件覆盖内置语义或灰度门。
 * 归一化后再查表，`/WORKFLOW`、`//plan` 同样命中。
 */
export function isReservedZCodeSlashCommandName(name: string): boolean {
  return RESERVED_SLASH_COMMAND_NAMES.has(normalizeZCodeSlashCommandName(name));
}
