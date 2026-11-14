// ============================================================
// 模型 tool call 名称归一化（adapter 侧）
// 定位：provider/SDK 返回的 tool 名不可信，这里是进入 core 之前的最后一道口径统一。
// 输入：unknown 原始值；context 携带 toolCallId 与 providerExecuted 供判断闭合能力。
// 输出：非空字符串（trim 后）或空字符串（仅当 client 执行且 toolCallId 可闭合）。
// 失败语义：抛 AiSdkModelAdapterError(InvalidModelResponse)，context 原样带上供错误归因。
// 副作用：纯函数，无网络与状态写入。
// 不变量：绝不伪造 tool 名；空名只有在能被同 id 的 tool error 闭合时才放行。
// ============================================================

import { ModelErrorCode } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";

/**
 * 统一 tool call 名称口径：trim 后非空即直接使用。
 * 空名不是无条件错误：client 执行的调用只要带可用 toolCallId，就原样返回空串，
 * 让 core 能回一条同 id 的 tool error 闭合该调用；否则抛 InvalidModelResponse。
 * source 为 provider 执行时不允许空名，因为 adapter 无法替 provider 闭合调用。
 */
export function normalizeModelToolName(
  value: unknown,
  context: Record<string, unknown>,
): string {
  if (typeof value === "string") {
    const toolName = value.trim();
    if (toolName) {
      return toolName;
    }

    const toolCallId = context.toolCallId;
    const hasClosableToolCallId =
      typeof toolCallId === "string" && toolCallId.trim().length > 0;
    if (context.providerExecuted !== true && hasClosableToolCallId) {
      // client-executed 的空名调用仍可用原 id 闭合。在 Adapter
      // 直接抛错的话，模型收不到同 id 的 tool error，整个 turn 因而停止。
      return value;
    }
  }

  throw new AiSdkModelAdapterError(
    ModelErrorCode.InvalidModelResponse,
    "Model returned an invalid tool call: tool name is empty.",
    { context },
  );
}
