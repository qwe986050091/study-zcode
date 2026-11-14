import { DEFERRED_TOOL_CALL_NAME, type ModelToolContract } from "@zcode/contracts";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";

// 编码只在本次请求内复用；下一请求必须读取当前定义，不能跨请求留下过期 schema。
// 输出形态与 Native 的 tool_reference 展开一致：一行一个 <function>{"description","name","parameters"}。
// 缓存以 tool 对象身份（Map 键）而非名称为键：同一请求内同名不同 schema 的刷新不会串味。
// 失败语义：契约 schema 是纯 JSON，正常不会触发 JSON.stringify 的循环引用错误；
// description 缺省归一为空串，parameters 直接透传 inputSchema（不复制、不校验）。
export function createLocalToolDefinitionRenderer(): (tool: ModelToolContract) => string {
  const definitions = new Map<ModelToolContract, string>();
  return (tool) => {
    // 命中缓存直接复用：同一工具在一条搜索结果里可能被引用多次，避免重复 JSON.stringify。
    let definition = definitions.get(tool);
    if (definition === undefined) {
      definition = `<function>${JSON.stringify({ description: tool.description ?? "", name: tool.name, parameters: tool.inputSchema })}</function>`;
      definitions.set(tool, definition);
    }
    return definition;
  };
}

/**
 * 已加载提醒：同一延迟工具在本轮已被前一批搜索交付过时，只提示"已加载、直接执行"。
 *
 * 口径：names 由调用方以 Set 语义收集（这里不再去重）；提示语内联在 tool result 里，
 * 不作为 attachment 参与 MCS 重排（见函数内原注释）。
 * source=tool_result_warning 是 provider-visible 的 tool_result 通道，wrap 时会转义嵌套标签。
 * 副作用：无。注意：提示不改变"已加载"事实，事实仍由历史里的 tool_reference 决定。
 */
export function localToolsAlreadyLoadedReminder(names: readonly string[]): string {
  // 指引属于当前工具结果，内联包装即可；不作为 attachment 参与 MCS 重排。
  return wrapSystemReminderForSource(
    "tool_result_warning",
    `Tool definitions already available in this conversation: ${names.join(", ")}. Use ${DEFERRED_TOOL_CALL_NAME} with {name, input} to execute these tools. Searching again does not execute them.`,
  );
}

/**
 * 首次搜索成功后的行动指引：明确"立刻用 DeferredToolCall 执行、无需再次 ToolSearch"。
 *
 * 口径：names 是本次新交付的延迟工具名；文案里的 {name, input} 必须与 DeferredToolCall 契约一致，
 * 写错会直接导致模型发起无效调用，这是本文件最主要的维护风险。
 * 单复数只根据 names.length 切换 "Call it/them now"，不影响行为。
 * 副作用：无（纯字符串）；source=tool_result_warning 表示它内联在 tool result 里，不持久化。
 */
export function localToolsLoadedReminder(names: readonly string[]): string {
  // 单复数只是文案差异，不改变后续任何判定。
  const action = names.length === 1 ? "Call it now" : "Call them now";
  return wrapSystemReminderForSource(
    "tool_result_warning",
    `Loaded: ${names.join(", ")}. ${action} with ${DEFERRED_TOOL_CALL_NAME} {"name":"<tool name>","input":{...}}, using the exact tool name and filling input according to its schema above. No additional ToolSearch is needed before calling these tools.`,
  );
}
