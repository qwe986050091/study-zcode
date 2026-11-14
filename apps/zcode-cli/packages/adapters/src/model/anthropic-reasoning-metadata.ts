// ============================================================
// Anthropic reasoning block 的 providerOptions 投影
// 定位：Anthropic 协议要求 thinking block 带 signature 才能回传；签名缺失时不能直接删除块。
// 输入：reasoning 内容块 + providerKind。输出：可直接交给 SDk 的 providerOptions 包装（或空对象）。
// 副作用：无（纯函数，返回新对象）。失败语义：不抛错；形态非法时按空对象处理。
// 不变量：仅对 anthropic 补空签名；已有 signature/redactedData 的块原样透传，绝不覆盖真实签名。
// ============================================================

import type { ModelReasoningContentBlock } from "@zcode/contracts";

type ReasoningTransformOptions = {
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
};
type ReasoningProviderOptions =
  | { providerOptions: Record<string, unknown> }
  | Record<string, never>;

/**
 * 生成 reasoning 块的 providerOptions。
 * 非 anthropic provider 直接透传（有则包装，无则空对象）；
 * anthropic 已有签名/redactedData 时同样透传；两者都没有时补 `signature: ""`，
 * 用序列化器支持的空签名表示"保留的 unsigned block"，避免历史 thinking 被静默删除。
 */
export function providerOptionsForReasoningBlock(
  block: ModelReasoningContentBlock,
  options: ReasoningTransformOptions,
): ReasoningProviderOptions {
  const providerOptions = objectProviderOptions(block.providerOptions);
  if (options.providerKind !== "anthropic") {
    return block.providerOptions ? { providerOptions: block.providerOptions } : {};
  }

  if (hasAnthropicReasoningMetadata(block.providerOptions)) {
    return { providerOptions: block.providerOptions };
  }

  // 把“没有 signature”直接等同于“不兼容”会让同模型历史里的
  // unsigned thinking 在 provider 序列化前被静默删除。跨模型、孤立和尾部清理由请求级
  // history normalization 决定；这里用 serializer 支持的空签名表示保留的 unsigned block。
  return {
    providerOptions: {
      ...providerOptions,
      anthropic: {
        ...anthropicProviderOptions(block.providerOptions),
        signature: "",
      },
    },
  };
}

/** 是否已带 anthropic 签名元数据（signature 或 redactedData 任一为字符串即算）。 */
function hasAnthropicReasoningMetadata(
  providerOptions: unknown,
): providerOptions is Record<string, unknown> {
  const anthropicOptions = anthropicProviderOptions(providerOptions);
  return (
    typeof anthropicOptions.signature === "string" ||
    typeof anthropicOptions.redactedData === "string"
  );
}

/** 归一成对象：null/数组/原始类型一律视为空对象，保证展开运算安全。 */
function objectProviderOptions(providerOptions: unknown): Record<string, unknown> {
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    return {};
  }

  return providerOptions as Record<string, unknown>;
}

/** 取 providerOptions.anthropic 子对象；缺失或形态非法时返回空对象（不臆造默认签名）。 */
function anthropicProviderOptions(providerOptions: unknown): Record<string, unknown> {
  if (!providerOptions || typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    return {};
  }

  const anthropicOptions = (providerOptions as Record<string, unknown>).anthropic;
  if (
    !anthropicOptions ||
    typeof anthropicOptions !== "object" ||
    Array.isArray(anthropicOptions)
  ) {
    return {};
  }

  return anthropicOptions as Record<string, unknown>;
}
