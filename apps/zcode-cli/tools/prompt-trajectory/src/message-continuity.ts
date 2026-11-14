/**
 * 文件职责：判断相邻请求的消息历史是否“仅追加”，并把响应摘要与补录的 assistant 回复对齐。
 * 纯函数、无副作用；只做比较与克隆，不修改输入。
 * 核心不变量：任何非追加变化（截断、中间改写、角色替换）都必须判为断链，宁可多切轨迹也不误合并。
 */

import { isDeepStrictEqual } from "node:util";
import { toolSearchComparisonMessages } from "./tool-search-comparison.js";
import type { JsonObject, OpenAiMessage, TrajectoryDerivationOptions } from "./types.js";

/**
 * 判断 next 是否在 previous 基础上只做追加。
 * 输入：两版消息数组（按时间序），可选派生选项；options.ignoreToolSearchChanges 为 true 时
 * 先映射到 ToolSearch 离线比较视图再比较，仅影响判定，不改写原数组。
 * 输出：true 表示可归入同一轨迹；false 表示历史被截断或改写，需要新开轨迹。
 * 允许的例外：最后一条 user 消息可以因相邻合并而追加 content（见 isUserContentAppend）。
 * 失败语义：不抛错；结构异常按“不相等”处理。
 * 复杂度：O(n) 逐条深比较，n 为消息条数。
 */
export function isAppendOnly(
  previous: readonly OpenAiMessage[],
  next: readonly OpenAiMessage[],
  options: TrajectoryDerivationOptions = {},
): boolean {
  if (options.ignoreToolSearchChanges) {
    previous = toolSearchComparisonMessages(previous);
    next = toolSearchComparisonMessages(next);
  }
  // 长度缩短只可能是压缩或历史改写，直接断链，不能当成追加。
  if (next.length < previous.length) return false;
  return previous.every(
    (message, index) =>
      isTrajectoryMessageEqual(message, next[index]) ||
      (index === previous.length - 1 && isUserContentAppend(message, next[index])),
  );
}

/**
 * 用下一次请求中记录到的 assistant 回复补全当前摘要。
 * 输入：summary 为流式响应拼出的摘要；previous/next 为相邻请求的消息数组；
 * options 与派生阶段使用同一套比较口径（含 ToolSearch 忽略开关）。
 * 输出：仅当 next 相对 previous 纯追加、且追加位置恰好是 assistant 时才返回该消息的深拷贝；
 * 其他情况原样返回 summary。
 * 副作用：无；返回的深拷贝可被调用方安全修改，不会污染记录中的原始对象。
 * 失败语义：next 不是合法消息数组、角色不符、内容不一致时一律回退 summary，不抛错。
 * 维护不变量：thinking/redacted_thinking 块不参与相等比较，因为它们只存在于摘要或原始回复一侧。
 */
export function completeAssistantMessage(
  summary: OpenAiMessage,
  previous: readonly OpenAiMessage[],
  next: unknown,
  options: TrajectoryDerivationOptions,
): OpenAiMessage {
  if (!Array.isArray(next) || !next.every(isMessage)) return summary;
  const before = options.ignoreToolSearchChanges
    ? toolSearchComparisonMessages(previous)
    : previous;
  const after = options.ignoreToolSearchChanges ? toolSearchComparisonMessages(next) : next;
  if (!isAppendOnly(before, after)) return summary;
  // 追加位置固定为旧长度处；不是 assistant 说明回复尚未落盘，保持摘要避免臆造。
  const recorded = after[before.length];
  if (recorded?.role !== "assistant" || !Array.isArray(recorded.content)) return summary;
  // response 摘要没有 thinking/签名；公告过滤可能改变索引，必须在同一比较视图中定位回复。
  const comparable = {
    ...recorded,
    content: recorded.content.filter((block: unknown) => {
      if (!block || typeof block !== "object") return true;
      const { type } = block as JsonObject;
      return type !== "thinking" && type !== "redacted_thinking";
    }),
  };
  return isTrajectoryMessageEqual(summary, comparable) ? structuredClone(recorded) : summary;
}

function isMessage(value: unknown): value is OpenAiMessage {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as JsonObject).role === "string"
  );
}

function isUserContentAppend(previous: OpenAiMessage, next: OpenAiMessage): boolean {
  if (previous.role !== "user" || next.role !== "user") return false;
  const { content: before, ...previousFields } = previous;
  const { content: after, ...nextFields } = next;
  if (!Array.isArray(before) || !Array.isArray(after) || after.length <= before.length)
    return false;
  // 相邻 user 合并会扩展最后一条消息；仅接受旧 block 原样保留的追加，不能掩盖历史改写。
  return (
    isTrajectoryMessageEqual(previousFields, nextFields) &&
    isDeepStrictEqual(removeCacheControl(before), removeCacheControl(after.slice(0, before.length)))
  );
}

/**
 * 比较两条消息在“轨迹语义”上是否相等。
 * 口径：递归移除 cache_control 后做深度严格比较；缓存标记属协议漂移，不应导致断链。
 * 输出：布尔值，不抛错；对象键顺序不影响结果，数组顺序参与比较。
 * 副作用：无，不修改入参；仅返回用于比较的临时副本。
 */
export function isTrajectoryMessageEqual(previous: OpenAiMessage, next: OpenAiMessage): boolean {
  // Anthropic 缓存标记会漂移；只在比较时忽略，输出仍保留最新请求的原始值。
  return isDeepStrictEqual(removeCacheControl(previous), removeCacheControl(next));
}

function removeCacheControl(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(removeCacheControl);
  const result: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key !== "cache_control") result[key] = removeCacheControl(nestedValue);
  }
  return result;
}
