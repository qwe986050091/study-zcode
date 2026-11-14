// ============================================================
// OpenAI-compatible system message 兼容折叠
// 定位：core 为 Anthropic cache boundary 会产出多段开头 system，旧式 chat template 只接受一段。
// 输入：ModelInputMessage 数组（只读）。输出：新数组；0/1 段开头 system 时原样复制。
// 副作用：无（不修改入参）。失败语义：无，内容拼接不做类型/长度校验。
// 不变量：折叠后只保留最后一段 system 的 cacheControl；各 block 文本按原顺序直接拼接，
// adapter 不推断、不补写分隔空白（ZCode by design：每个 block 自带左边界）。
// ============================================================

import {
  modelMessageContentToText,
  type ModelInputMessage,
} from "@zcode/contracts";

/**
 * 把连续的开头 system 消息合并为一条（仅兼容协议序列化边界使用）。
 * 输入为空数组或首条不是 system 时返回浅拷贝；开头 system 仅一条时也直接返回拷贝，
 * 避免调用方误改共享数组。非开头位置的 system 消息保持原位、不参与合并。
 */
export function normalizeOpenAiCompatibleSystemMessages(
  messages: readonly ModelInputMessage[],
): ModelInputMessage[] {
  let leadingSystemCount = 0;
  while (messages[leadingSystemCount]?.role === "system") {
    leadingSystemCount += 1;
  }

  if (leadingSystemCount <= 1) {
    return [...messages];
  }

  const leadingSystemMessages = messages.slice(0, leadingSystemCount);
  const lastLeadingSystem = leadingSystemMessages.at(-1);

  // 部分旧式 OpenAI-compatible chat template 只接受一个开头 system。
  // Core 为 Anthropic cache boundary 有意保留多段，因此只在兼容协议序列化边界按原顺序合并。
  // ZCode by design：每个后续 block 自带左边界，adapter 不推断或补写任何空白。
  return [
    {
      role: "system",
      content: leadingSystemMessages
        .map((message) => modelMessageContentToText(message.content))
        .join(""),
      ...(lastLeadingSystem?.cacheControl
        ? { cacheControl: { ...lastLeadingSystem.cacheControl } }
        : {}),
    },
    ...messages.slice(leadingSystemCount),
  ];
}
