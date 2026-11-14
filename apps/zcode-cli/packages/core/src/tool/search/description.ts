/**
 * 拼装 ToolSearch 的模型可见说明文案，Native 与 Local 两种模式共用同一骨架。
 *
 * 输入三段：opening 说明工具用途；callingConvention 说明"加载后如何调用"（两种模式的差异全在这里）；
 * resultNote 追加在"结果格式"句尾，用于强调编码一致或参数归属。
 * 输出是纯字符串常量，无副作用；返回值进 registry 的 metadata.description（由 tool-search.ts 消费），
 * Local 模式会在 buildToolExposure 中被整段替换为 LOCAL_TOOL_SEARCH_DESCRIPTION。
 * 失败语义：不做校验，三段语义冲突只会在模型侧表现为调用方式误解，而不是抛错。
 */
function description(opening: string, callingConvention: string, resultNote: string): string {
  return `${opening}

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. ${callingConvention}

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block${resultNote}

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;
}

/**
 * Native 模式文案：schema 由 provider 依据 tool_reference 展开，模型可像顶层工具一样直接调用。
 *
 * 口径：这也是 tool-search.ts 固定的 metadata.description；Local 模式下会被整体替换，不会发给模型。
 * 维护不变量：文案不得暗示"搜索即执行"——搜索只返回引用，真正执行仍是一次普通 tool call。
 */
export const NATIVE_TOOL_SEARCH_DESCRIPTION = description(
  "Fetches full schema definitions for deferred tools so they can be called.",
  "Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.",
  " — the same encoding as the tool list at the top of this prompt.",
);

// Local 返回的定义描述目标参数，不能把它误读成已注册的直接调用入口。
// Local 模式没有 provider 展开：搜索结果里的 <function> 定义只用于告知参数结构。
// 因此这里显式要求 deferred 工具必须经 DeferredToolCall({name, input}) 执行；
// 常驻工具即使定义由 select: 返回，也必须用普通 tool call 直接调用。
// 末尾示例给出"延迟工具已加载后应如何调用"，避免模型把搜索当成执行、或反复 ToolSearch。
export const LOCAL_TOOL_SEARCH_DESCRIPTION = `${description(
  "Fetches full schema definitions for deferred tools so they can be called using DeferredToolCall.",
  "Call deferred tools through DeferredToolCall with {name, input}. Call resident tools directly using their normal tool calls, even if their definitions were returned by direct selection.",
  ". For deferred tools, parameters describes the input object passed to DeferredToolCall.",
)}

Example (TodoWrite is deferred and already loaded):
<example>
DeferredToolCall({"name":"TodoWrite","input":{"todos":[{"content":"Inspect the implementation","status":"in_progress","priority":"high"}]}})
</example>`;
