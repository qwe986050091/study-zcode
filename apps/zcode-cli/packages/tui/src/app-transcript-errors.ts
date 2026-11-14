// transcript 错误消息写入层：把运行时失败转成 system 消息并做轻量去重。
// 只处理消息数组，不发起 IO、不写日志；错误文案最终由渲染层按 system 配色展示。

import type { Message } from "./app-model.js";

const ERROR_MESSAGE_PREFIX = "Error:";
const UNKNOWN_ERROR_MESSAGE = "Unknown error";

// 把运行时错误追加为 system 角色的 transcript 消息。
// 输入 message 允许空串（会降级为 "Unknown error"），输出为新数组，不修改原 messages。
// 若末条 system 消息内容已相同则原样返回（引用不变），用于吸收事件流与 Promise catch 的重复上报。
// 纯函数，无 IO/日志；消息统一带 "Error:" 前缀以便视觉识别。
export function appendSystemErrorMessage(messages: Message[], message: string): Message[] {
  const content = formatSystemErrorMessage(message);
  const last = messages.at(-1);
  // runtime error events often arrive before the rejected prompt promise;
  // dedupe the catch-path render so the transcript shows one clear failure.
  if (last?.role === "system" && last.content === content) return messages;
  return [...messages, { content, role: "system" }];
}

// 空消息兜底为 "Unknown error"；已有前缀不重复添加，保持幂等。
function formatSystemErrorMessage(message: string): string {
  const trimmed = message.trim() || UNKNOWN_ERROR_MESSAGE;
  return trimmed.startsWith(ERROR_MESSAGE_PREFIX) ? trimmed : `${ERROR_MESSAGE_PREFIX} ${trimmed}`;
}
