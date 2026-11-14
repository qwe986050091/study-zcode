/**
 * ============================================================================
 * tool/handlers/deferred-tool-call.ts —— DeferredToolCall 控制入口（占位声明）
 * ============================================================================
 *
 * 【定位】它不是真正的执行器：调度、流式与 executor 在运行前会把这次调用**解包**成
 * "目标工具 + 目标入参"，改用目标 ToolEntry 的 schema/权限/超时执行。本文件只提供
 * 一个可被 registry 识别、可被模型看到的入口声明。
 *
 * 【为什么 handler 永远抛】如果解包漏了任何一条路径（例如新增的调度分支），走到这里
 * 就是接线错误而不是业务结果。显式抛出比"静默按控制工具执行"更安全：后者会让权限
 * 系统只审 `tool.deferred_call`，而目标工具的真实风险等级根本没被评估。
 *
 * 【声明口径】readOnly/concurrentSafe 刻意都为 false：真实属性取决于被解包的目标工具，
 * 控制入口自己不能声称只读；sideEffectScope=system、riskLevel=high 是"未知目标"的上界。
 * ============================================================================
 */

import { z } from "zod";
import {
  DEFERRED_TOOL_CALL_NAME,
  DeferredToolCallInputJsonSchema,
  DeferredToolCallInputSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";

const MAX_CONTROL_RESULT_BYTES = 100_000;

/** 控制层结果上限；目标工具自己的 resultBudget 在解包后仍然生效。 */
export const deferredToolCallEntry: ToolEntry = {
  capability: "Call a deferred tool using its loaded definition",
  metadata: {
    name: DEFERRED_TOOL_CALL_NAME,
    description:
      "Immediately call one deferred tool and return its result. Use ToolSearch to load its complete definition, then pass its exact name and input object. Only deferred tools can be called here; call resident tools directly using their normal tool calls.",
    // 调度前解包并使用目标属性，控制入口本身不声明只读或并发安全。
    readOnly: false,
    concurrentSafe: false,
    destructive: false,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
  },
  inputSchema: DeferredToolCallInputJsonSchema,
  runtimeInputSchema: DeferredToolCallInputSchema,
  outputSchema: {},
  runtimeOutputSchema: z.unknown(),
  permission: {
    permission: "tool.deferred_call",
    reason: "Call a deferred tool",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  timeout: { kind: "none" },
  cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Tool call cancelled" },
  resultBudget: {
    maxInlineBytes: MAX_CONTROL_RESULT_BYTES,
    maxModelBytes: MAX_CONTROL_RESULT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_CONTROL_RESULT_BYTES, direction: "head" },
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
  // 防御性断言：正常链路一定先解包成目标工具；走到 handler 说明解包缺失（见文件头）。
  handler: async () => {
    throw new Error("DeferredToolCall must be resolved before tool execution.");
  },
};
