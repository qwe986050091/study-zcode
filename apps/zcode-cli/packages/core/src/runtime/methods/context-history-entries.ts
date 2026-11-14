/**
 * ============================================================================
 * runtime/methods/context-history-entries.ts —— 上下文构建结果 → 历史条目
 * ============================================================================
 *
 * 【定位】ContextBuildResult 是"本次请求要注入什么"的结构化结果；
 * 消息历史只认识 RuntimeMessageEntry。本文件做这一层纯映射，不排序、不裁剪：
 *   - systemMessages → 普通 system 条目；
 *   - metaUserAttachments → system-reminder 形态的附件条目（在 user 侧注入）。
 *
 * 【为什么附件要包成 system-reminder】
 *   这些内容（日期、技能列表、记忆索引等）是系统提供的背景事实，不是用户发言；
 *   包成 reminder 既能让 UI 不把它显示成用户消息，又保留 source 供审计。
 * ============================================================================
 */
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { ContextBuildResult } from "../deps.js";

export function buildContextHistoryEntries(
  contextResult: ContextBuildResult,
): RuntimeMessageEntry[] {
  return [
    ...contextResult.systemMessages.map((message): RuntimeMessageEntry => ({ message })),
    ...contextResult.metaUserAttachments.map((attachment) =>
      systemReminderAttachmentEntry(attachment.source, attachment.content),
    ),
  ];
}
