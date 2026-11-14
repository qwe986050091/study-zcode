/**
 * ============================================================================
 * runtime/tool-result-settlement/contract.example.ts —— 契约调用示例（可运行的签名样板）
 * ============================================================================
 *
 * 【用途】演示如何在"只拿到 ToolResultSettlement 类型"的情况下正确转调：
 *   通过 ThisParameterType / Parameters 保留 this 与整批参数，settle.call 原样执行。
 *
 * 【边界】不复制历史、不重跑工具、不改错误/取消语义 —— 示例只是类型层面的转发，
 *   真正的结算顺序（先入 Runtime 历史、再等既有持久化）仍由 settleToolResults 保证。
 * ============================================================================
 */
import type { ToolResultSettlement } from "./contract.js";

/**
 * 把原 Runtime 与整批结果交回同一结算方法，不复制历史或再执行工具。
 *
 * 输入：settle（结算方法）、runtime（其 this 类型）、其余整批参数（Parameters 展开）。
 * 输出：settle 的 Promise<void>，错误与取消语义原样透传（不 catch、不包装）。
 * 副作用：与 settle 本身一致（写历史/持久化），本包装不额外产生副作用。
 */
/** 把原 Runtime 与整批结果交回同一结算方法，不复制历史或再执行工具。 */
export function exampleToolResultSettlement(
  settle: ToolResultSettlement,
  runtime: ThisParameterType<ToolResultSettlement>,
  ...args: Parameters<ToolResultSettlement>
): Promise<void> {
  return settle.call(runtime, ...args);
}
