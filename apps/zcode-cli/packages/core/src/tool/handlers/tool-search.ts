// ============================================================
// ToolSearch Tool Handler
// ============================================================
// 定位：延迟工具（deferred tool）的发现入口。工具面被裁剪成"常驻 + 按需加载"之后，模型
// 只能通过本工具找到未加载的工具名，再由 provider 展开其 schema（链路 10）。
// 职责：检查 ToolSearch 是否启用 → 在**当前已允许**的 catalog 里检索 → 返回匹配名 +
//   延迟工具总数。它只做可见性检索，不替代权限：命中不等于允许执行。
// 输入输出：query + max_results → {query, matches, total_deferred_tools}；matches 是工具名
//   字符串，不含 schema（schema 由 provider 用 tool_reference 展开）。
// 失败：未启用/端口缺席 → 抛普通 Error（配置问题，由 executor 转成 error tool_result）；
//   取消优先于检索，先检查 abort。
// 反直觉：本工具本身**不**延迟（没有 shouldDefer）——否则模型要先加载搜索器才能搜索。

import { NATIVE_TOOL_SEARCH_DESCRIPTION } from "../search/description.js";
import {
  TOOL_SEARCH_NAME,
  ToolSearchInputJsonSchema,
  ToolSearchInputSchema,
  ToolSearchOutputJsonSchema,
  ToolSearchOutputSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import { searchTools } from "../search/search.js";

// 结果预算 100KB：匹配项只是工具名，实际远小于此；超时 10s 固定——检索是纯内存操作，
// 超时只可能意味着实现异常。
const MAX_SEARCH_RESULT_BYTES = 100_000;
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * ToolSearch 的工具声明。
 *
 * 口径：只读、并发安全、无副作用、无需审批——检索 catalog 不改变任何事实。
 * 输出形态：`matches` 是工具名列表，`total_deferred_tools` 统计 **catalog 里全部** deferred
 *   工具（不是命中数），让模型知道"还有多少没加载"。
 * 失败：`context.toolSearch` 缺席或 enabled=false 时抛 Error；这里不用 CoreError 是因为
 *   这是"宿主没给能力"的通用配置缺失，与具体业务失败无关。
 * 注意：`abortSignal?.throwIfAborted()` 放在最前——已取消的调用不该再触发一次检索。
 */
export const toolSearchToolEntry: ToolEntry = {
  capability: "Search available tools and load their definitions",
  metadata: {
    name: TOOL_SEARCH_NAME,
    // 模型侧说明使用固定文案；schema 展开由 provider 处理，客户端仍只返回真实引用。
    description: NATIVE_TOOL_SEARCH_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxOutputBytes: MAX_SEARCH_RESULT_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  inputSchema: ToolSearchInputJsonSchema,
  outputSchema: ToolSearchOutputJsonSchema,
  runtimeInputSchema: ToolSearchInputSchema,
  runtimeOutputSchema: ToolSearchOutputSchema,
  // 检索本身是同步纯函数；handler 写成 async 只是为了与 ToolHandler 契约一致。
  handler: async (input, context) => {
    context.abortSignal?.throwIfAborted();
    if (!context.toolSearch?.enabled)
      throw new Error("ToolSearch is not enabled for this request.");
    const { query, max_results } = ToolSearchInputSchema.parse(input);
    const catalog = context.toolSearch.catalog;
    return {
      query,
      matches: searchTools(query, catalog, max_results),
      total_deferred_tools: catalog.filter((tool) => tool.deferred).length,
    };
  },
  // 有命中时转成 tool_reference 块（provider 负责展开 schema，客户端只回真实引用）；
  // 零命中时回一句文本而不是空数组——空 modelContent 会让部分 provider 报无效消息。
  formatModelContent: (output) => {
    const { matches } = ToolSearchOutputSchema.parse(output);
    return matches.length > 0
      ? matches.map((toolName) => ({ type: "tool_reference" as const, toolName }))
      : "No matching deferred tools found";
  },
  permission: {
    permission: "tool.search",
    reason: "Search the current allowed tool catalog",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEARCH_RESULT_BYTES,
    maxModelBytes: MAX_SEARCH_RESULT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_SEARCH_RESULT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: SEARCH_TIMEOUT_MS, maxMs: SEARCH_TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ToolSearch was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
