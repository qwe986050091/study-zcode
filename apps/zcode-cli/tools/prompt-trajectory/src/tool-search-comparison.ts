/**
 * 文件职责：构造 ToolSearch 的“离线比较视图”。
 * 输入是完整消息数组，输出是过滤掉搜索公告与工具引用块后的副本；
 * 纯函数、无副作用、不写盘。仅供轨迹追加判定使用，绝不作为最终输出内容。
 * 不变量：输出的消息顺序与输入一致，且不修改输入对象（通过浅拷贝重建数组/对象）。
 */

import type { JsonObject, OpenAiMessage } from "./types.js";

const REMOVED_REFERENCE_TEXTS = new Set([
  "[Tool references removed - tools no longer available]",
  "[Tool references removed - tool search not enabled]",
]);
const ANNOUNCEMENT_PREFIX = "<system-reminder>\n";
const ANNOUNCEMENT_SUFFIX = "\n</system-reminder>";
const TOOL_SEARCH_LOADED_TEXT = "Tool loaded.";
// 当前公告不再推断连接原因；离线工具同时识别新旧文案，避免关闭搜索后误判历史断链。
const ANNOUNCEMENT_HEADINGS = [
  /^The following deferred tools are (?:now )?available via ToolSearch\./u,
  /^The following deferred tools are no longer available(?: \(their MCP server disconnected\))?\./u,
  /^\d+ deferred tools are no longer available(?: \(MCP server disconnected\))?:/u,
  /^\d+ deferred tools? (?:is|are) available again \((?:MCP server reconnected — )?names announced earlier in this conversation\):/u,
];

/**
 * 输入输出口径：输入按时间序的消息数组，输出同序、同条数（除非整条消息被公告掏空）的副本。
 * 过滤规则：移除 ToolSearch 成功结果里的 tool_reference 与“已移除引用”占位文本，
 * 移除独立成条的搜索公告，并在出现“Tool loaded.”占位时按搜索结果配对消费。
 * 失败语义：结构不合法（缺 role/content 数组）时原样保留该消息，不抛错、不猜测修复。
 * 不变量：空白 user 消息若原来就为空必须保留，避免过滤改变消息计数掩盖真实差异。
 */
/** 仅创建离线比较视图；最终轨迹必须继续使用原始请求，不输出这里过滤后的内容。 */
export function toolSearchComparisonMessages(
  messages: readonly OpenAiMessage[],
): readonly OpenAiMessage[] {
  const searchCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        isObject(block) &&
        block.type === "tool_use" &&
        block.name === "ToolSearch" &&
        typeof block.id === "string"
      ) {
        searchCallIds.add(block.id);
      }
    }
  }
  let pendingLoaded = 0;
  return messages.flatMap((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      pendingLoaded = 0;
      return [message];
    }
    const content = message.content
      .filter((block) => {
        if (isObject(block) && block.type === "tool_result") {
          if (
            typeof block.tool_use_id === "string" &&
            searchCallIds.has(block.tool_use_id) &&
            block.is_error !== true &&
            Array.isArray(block.content) &&
            block.content.some((item) => isObject(item) && item.type === "tool_reference")
          )
            pendingLoaded++;
          return true;
        }
        // 成功提示派生在整批结果之外；只按有效搜索结果计数忽略，不能全局删除同名正文。
        if (
          pendingLoaded > 0 &&
          isObject(block) &&
          block.type === "text" &&
          block.text === TOOL_SEARCH_LOADED_TEXT
        ) {
          // 每个成功搜索结果只消费一次占位提示，防止后续同名正文被误删。
          pendingLoaded--;
          return false;
        }
        pendingLoaded = 0;
        return !isAnnouncement(block);
      })
      .map((block: unknown) => {
        if (
          !isObject(block) ||
          block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string" ||
          !searchCallIds.has(block.tool_use_id) ||
          !Array.isArray(block.content)
        )
          return block;
        return {
          ...block,
          content: block.content.filter(
            (item: unknown) =>
              !isObject(item) ||
              (item.type !== "tool_reference" &&
                !(
                  item.type === "text" &&
                  typeof item.text === "string" &&
                  REMOVED_REFERENCE_TEXTS.has(item.text)
                )),
          ),
        };
      });
    // 公告独占一条 user 时，关闭/恢复会使消息数变化；普通空消息仍保留并参与比较。
    return content.length === 0 && message.content.length > 0 ? [] : [{ ...message, content }];
  });
}

function isAnnouncement(block: unknown): boolean {
  if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return false;
  const value = block.text;
  return (
    value.startsWith(ANNOUNCEMENT_PREFIX) &&
    value.endsWith(ANNOUNCEMENT_SUFFIX) &&
    ANNOUNCEMENT_HEADINGS.some((heading) => heading.test(value.slice(ANNOUNCEMENT_PREFIX.length)))
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
