// ============================================================
// project-memory —— project Memory 的“是否启用 / 归属哪个 workspace”判定
// ============================================================
//
// 【职责】把运行时配置翻译成一个明确结论：本会话是否需要 project Memory，
//   若需要，memory 根目录在哪。
//
// 【启用条件（四项全部满足）】
//   1. config.memory.enabled 为真；
//   2. 未被显式关闭（memory.use !== false，兼容旧字段）；
//   3. 已配置 cliStorageRoot（没有存储根就无法落盘）；
//   4. taskType 属于主任务类型（见 isMainMemoryTaskType）。
//   任一项不满足即返回 undefined，调用方据此整体跳过 Memory 链路。
//
// 【为什么按 taskType 分】Subagent / workflow child 等从属任务不应各自
//   对同一个 workspace 再跑 Extraction / Dream / Recall，否则会重复写同一份记忆。
//
// 【副作用】无（纯计算，不建目录、不读文件）。
// 【失败/降级】返回 undefined 表示“链路关闭”，调用方必须按关闭处理而不是报错。
// ============================================================
import type { AgentRuntimeConfig } from "../types.js";
import { resolveProjectMemoryRoot } from "../../memory/project-root.js";

/**
 * 解析本会话是否启用 project Memory 及其 memory 根目录。
 * 输入：runtime 配置与当前会话 workspacePath。
 * 输出：memory 根目录绝对路径；未启用时 undefined。
 * 语义：enabled / use / cliStorageRoot / taskType 四项门禁全部通过后，
 *       再交给 resolveProjectMemoryRoot 按 workspace 身份归类（同 workspace 共享一份记忆）。
 * 副作用：无。
 * 降级：undefined 表示“链路整体关闭”，不抛错。
 */
export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false || !memory.cliStorageRoot) return undefined;
  if (!isMainMemoryTaskType(config.taskType)) return undefined;

  return resolveProjectMemoryRoot({
    cliStorageRoot: memory.cliStorageRoot,
    workspaceIdentity: memory.workspaceIdentity,
    workspacePath,
  });
}

/**
 * 判断 taskType 是否属于需要 project Memory 的主任务类型。
 * 输入：config.taskType（可能为 undefined，表示默认交互会话）。
 * 输出：boolean。interactive / fork / selection_side_chat / workflow_parent 视为主任务；
 *       subagent、workflow child 等从属任务返回 false，避免重复 consolidation。
 * 副作用：无。
 */
export function isMainMemoryTaskType(taskType: AgentRuntimeConfig["taskType"]): boolean {
  return (
    taskType === undefined ||
    taskType === "interactive" ||
    taskType === "fork" ||
    taskType === "selection_side_chat" ||
    taskType === "workflow_parent"
  );
}
