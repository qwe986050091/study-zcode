/**
 * ============================================================================
 * runtime/methods/reasoning-stream.ts —— reasoning delta 的块合并工具
 * ============================================================================
 *
 * 流式响应把 thinking 拆成按到达顺序推送的 delta：多数 provider 会给块 id
 * （如 thinking block 序号），兼容实现则可能完全不给。本文件负责把同一 id
 * 的 delta 合并进同一个 reasoning 块，使后续 tool_result 请求能重放 thinking。
 *
 * 关键口径：reasoning 数组才是块顺序的唯一事实，Map 只是查找索引；
 * 两个结构必须同时写入，否则会出现"可见但不可追加"或"可追加但不可见"的块。
 * ============================================================================
 */
import type { ModelReasoningContentBlock } from "../deps.js";

// 无 id 的 delta 全部并入同一个匿名块：reasoning 在消息内是"一段 thinking"，
// 每来一个 delta 就新建块会把同一段思考拆碎，重放顺序也就无法还原。
const DEFAULT_REASONING_STREAM_ID = "__zcode_default_reasoning__";

export function getOrCreateReasoningBlock(input: {
  id?: string;
  providerMetadata?: Record<string, unknown>;
  reasoning: ModelReasoningContentBlock[];
  reasoningById: Map<string, ModelReasoningContentBlock>;
}): ModelReasoningContentBlock {
  const id = input.id ?? DEFAULT_REASONING_STREAM_ID;
  const existing = input.reasoningById.get(id);
  // 幂等命中：同一 id 会被 start 与多个 delta 反复触达，返回既有块而不是新建，
  // 新建会让后续文本落到另一个块，tool_result 重放时 thinking 顺序就断了。
  if (existing) {
    return existing;
  }

  // Anthropic-compatible providers can emit thinking deltas without a
  // distinct start event. Preserve the block so later tool_result requests can
  // replay assistant thinking alongside tool_use.
  // 索引与顺序数组必须同时登记：Map 决定后续 delta 能否合并，
  // 数组决定最终发给 provider 的块顺序；只写一个会让另一个视图失真。
  const block: ModelReasoningContentBlock = {
    type: "reasoning",
    text: "",
    // providerMetadata 原样挂到 providerOptions：重放时必须保留 provider 私有字段，
    // 本层不做白名单筛选，避免不同 provider 的 thinking 元信息被丢掉。
    providerOptions: input.providerMetadata,
  };
  input.reasoningById.set(id, block);
  input.reasoning.push(block);
  return block;
}
