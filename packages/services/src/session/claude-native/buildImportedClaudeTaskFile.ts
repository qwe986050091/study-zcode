// 把 Claude 导入源转换成 ZCode legacy 快照结构：只保留可迁移内容。
// 任务 ID 必须稳定可复现，重复导入同一会话应落到同一 taskId。
import { createHash } from "node:crypto";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { generateTraceId } from "@zcode/shared";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";
import type { LegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
import {
  DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS,
  filterImportedClaudeTaskFilePaths,
} from "#src/session/claude-native/importedClaudeTaskFileFilter.js";

// taskId = sha256(claude:workspace:session) 前 24 位，再拼固定前缀。
// 哈希输入包含 workspace，避免不同项目下同名 session 互相覆盖。
export function buildImportedClaudeTaskId(workspacePath: string, sessionId: string): string {
// 取前 24 个十六进制字符，在碰撞概率与可读长度之间折中。
// 哈希算法与截断长度一经发布不可修改，否则同一会话会生成新 ID。
  const digest = createHash("sha256")
    .update(`claude:${workspacePath}:${sessionId}`)
    .digest("hex")
    .slice(0, 24);
  return `claude-import-${digest}`;
}

// 标题优先级：源标题 > 首条非空用户消息 > 固定兜底文案。
// 这样即使用户在 Claude 侧没设置标题，导入后仍可读。
function deriveImportedTaskTitle(
  fallbackTitle: string | undefined,
  messages: ClaudeNativeImportedSessionSource["messages"],
): string {
// 源标题只有 trim 后非空才算有效，纯空白视为未设置。
  const explicitTitle = fallbackTitle?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

// 只取第一条内容非空的 user 消息，assistant 内容不能作为标题来源。
  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );
  return firstUserMessage ? deriveSessionTitle(firstUserMessage.content, []) : "Imported session";
}

// 主构建函数：生成 meta 与消息副本，再按显式路径清洗运行态字段。
// filterPaths 默认使用导入专用清单，调用方可传更严格的路径集合。
export function buildImportedClaudeTaskFile(
  source: ClaudeNativeImportedSessionSource,
  filterPaths: readonly string[] = DEFAULT_IMPORTED_CLAUDE_TASK_FILTER_PATHS,
  taskIdOverride?: string,
): LegacyTaskSessionFile {
// 空消息直接拒绝：没有内容的快照无法渲染，也没有续聊价值。
  if (source.messages.length === 0) {
    throw new Error(`[claude-native] external session ${source.sessionId} 没有可导入的可见消息`);
  }

// 调用方已创建任务时复用其 taskId；否则按内容确定性生成。
  const taskId =
    taskIdOverride ?? buildImportedClaudeTaskId(source.workspacePath, source.sessionId);
// traceId 由 taskId 派生，保证同一任务在日志中可稳定关联。
  const traceId = generateTraceId(taskId);
  const createdAt = Number.isFinite(source.createdAt) ? source.createdAt : source.updatedAt;
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : createdAt;

// 迁移任务统一标记 completed/default，模型只在源提供时写入。
  const meta: ZCodeTaskMeta = {
    taskId,
    traceId,
    title: deriveImportedTaskTitle(source.title, source.messages),
    workspacePath: source.workspacePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    mode: "default",
    migrationSource: "claudeCode",
    status: "completed",
    ...(source.model ? { model: source.model } : {}),
  };

  const taskFile: LegacyTaskSessionFile = {
    meta,
    messages: [...source.messages],
  };

  // Claude 原生 session 的 mode/model/provider 是来源端运行态，
  // 直接落入 ZCode snapshot 会在恢复时污染当前 workspace 的运行时选择。
  // 这里按显式 path 列表清洗，保留正文和 migrationSource 供列表识别迁移来源。
  return filterImportedClaudeTaskFilePaths(taskFile, filterPaths);
}
