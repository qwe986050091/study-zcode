import type { CommandCenterApp } from "./types.js";

// 格式化会话恢复结果：包含 sessionId、目录、消息应用数（已应用/总数）以及分片数与中断工具数。
// 纯字符串拼装，无副作用；数值缺失由 resume 返回值保证齐全，不做兜底。
export function formatResumeResult(
  sessionId: string,
  result: Awaited<ReturnType<CommandCenterApp["resume"]>>,
): string {
  return [
    `Resumed session ${sessionId}.`,
    `Directory: ${result.directory}`,
    `Messages: ${result.appliedMessageCount}/${result.messageCount}; parts: ${result.partCount}; interrupted tools: ${result.interruptedToolCount}`,
  ].join("\n");
}

// 格式化新建会话结果：只含新 sessionId 一行，供 TUI 直接展示。
export function formatNewSessionResult(sessionId: string): string {
  return `Started new session ${sessionId}.`;
}
