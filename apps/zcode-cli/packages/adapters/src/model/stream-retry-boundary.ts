// ============================================================
// 流式重试安全边界（哪些 chunk 在断流重试时可以整段丢弃）
// 定位：adapter 在首个"已提交输出"出现前允许透明重试；本文件定义该边界集合。
// 输入：单条 ModelStreamEvent。输出：布尔值——true 表示可进入"前奏缓冲"、断流后可丢弃。
// 副作用：无。失败语义：无（纯判定）。
// 不变量：非空 text/reasoning delta 一旦出现即视为已输出，再 retry 会产生重复 token，
// 因此只有空 delta 与结构性边界事件（start/end/tool_input_*）才算 retry-safe。
// ============================================================

import type { ModelStreamEvent } from "@zcode/contracts";

// Note: these events are buffered, not yielded, until a committed stream boundary appears.
// If a network reset happens first, the partial tool-input attempt can be discarded.
// 非空 reasoning_delta 是用户感知的首个输出 token，不能等待正文或工具边界才释放。
const RETRY_SAFE_PRELUDE_STREAM_EVENT_TYPES = new Set<ModelStreamEvent["type"]>([
  "start",
  "text_start",
  "text_end",
  "reasoning_start",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
]);

/**
 * 判断该事件是否属于"可丢弃前奏"。
 * 结构性边界事件（start/text_start/text_end/reasoning_start/reasoning_end/tool_input_*）不携带
 * 用户可见内容，断流后重新请求不会造成重复输出；text/reasoning delta 仅有空串时同理。
 * 返回 false 意味着重试必须升级为可见失败，不能静默抹掉已输出 token。
 */
export function isRetrySafePreludeStreamEvent(event: ModelStreamEvent): boolean {
  // SDK 把纯签名转成空 reasoning_delta；将其视为已输出会停止 adapter retry，
  // 而 core 无文本、无完整工具调用时也无法恢复。空 delta 随前奏暂存，成功时保留签名原序释放。
  if (event.type === "reasoning_delta" || event.type === "text_delta") {
    return event.text.length === 0;
  }
  return RETRY_SAFE_PRELUDE_STREAM_EVENT_TYPES.has(event.type);
}
