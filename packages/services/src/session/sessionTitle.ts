// 会话标题派生：只依赖首条输入与附件清单，不读取会话历史，保证标题在写入前即可确定。
// 结果必须是单行短文本，长度上限由渠道展示层共同约束。
import type { ZCodePromptAttachment } from "@zcode/shared";

export function deriveSessionTitle(
  content: string,
  attachments: readonly ZCodePromptAttachment[],
): string {
// 有正文时优先用正文前 50 个字符；截断标记只在确实发生截断时追加。
  if (content.length > 0) {
    return content.slice(0, 50) + (content.length > 50 ? "..." : "");
  }

// 正文为空才回退到附件名；没有附件时返回空串，由上层决定占位标题。
  const firstAttachment = attachments[0];
  if (!firstAttachment) {
    return "";
  }

// 多附件只展示首个文件名并附计数，避免标题被长清单撑爆。
  const extraCount = attachments.length - 1;
  return extraCount > 0 ? `${firstAttachment.filename} +${extraCount}` : firstAttachment.filename;
}
