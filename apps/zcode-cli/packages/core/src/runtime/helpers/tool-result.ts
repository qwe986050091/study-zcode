import { modelMessageContentToText } from "../deps.js";
import { isBashOutputProviderError } from "../../tool/handlers/bash-model-content.js";
import type { ModelMessageContent, ToolCallId, ToolSchedule, ToolExecutionResult } from "../deps.js";

/**
 * 零值 token 用量对象，用作"尚无用量"的占位与累加初值。
 * 纯函数；total 故意缺席（区别于 0），让下游能分辨"未统计"与"统计为 0"。
 */
export function emptyTokenUsageInfo(): ReturnType<typeof toTokenUsageInfo> {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

/**
 * 把模型 usage（可能字段全缺）归一成事件/UI 用的固定形状。
 * total 仅在入参提供时透传（undefined 表示 provider 未给 total，不合成）；
 * 其余字段统一补 0，保证下游加法与展示不需要再判空。纯函数，无副作用。
 */
export function toTokenUsageInfo(usage?: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
} {
  return {
    total: usage?.totalTokens,
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.reasoningTokens ?? 0,
    cache: {
      read: usage?.cacheReadTokens ?? 0,
      write: usage?.cacheWriteTokens ?? 0,
    },
  };
}

/**
 * 把任意工具入参收敛成 record：对象原样返回，**数组与标量**都包成 { value }。
 * 这样 tool part / 事件 payload 的 input 字段始终是对象，避免下游按类型分叉。
 * 纯函数；不深拷贝。
 */
export function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

/**
 * 把工具结果投影成"给人看/给日志看"的字符串，优先级：
 *   modelContent（字符串或内容块→文本） > 失败时的 error.message > 字符串 output
 *   > 空 output 的 "" > 其余 JSON 序列化（不可序列化时退回 ""）。
 * 纯函数；不做截断、不落盘、不抛错。注意它不等于模型实际收到的内容——
 * 模型可见版本走 modelContentForToolResult。
 */
export function stringifyToolResultOutput(result: ToolExecutionResult): string {
  if (result.modelContent !== undefined) {
    return typeof result.modelContent === "string"
      ? result.modelContent
      : modelMessageContentToText(result.modelContent);
  }
  if (!result.success && result.error?.message) return result.error.message;
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined) return "";
  return JSON.stringify(result.output) ?? "";
}

/**
 * 取"模型真正收到的 tool result 内容"：有 modelContent 就原样（含结构化块），
 * 否则退回 stringifyToolResultOutput 的字符串。纯函数、无降级分支。
 */
export function modelContentForToolResult(result: ToolExecutionResult): ModelMessageContent {
  if (result.modelContent !== undefined) return result.modelContent;
  return stringifyToolResultOutput(result);
}

/**
 * 判定工具结果是否应标记为 error（决定 tool part 终态与模型侧 is_error）。
 * 优先级：success=false 直接 error；否则若 output 是 record，先看显式
 * isError/is_error 布尔；Bash 特例按 provider 错误或 interrupted 判定；其余视为成功。
 * 纯函数；显式字段优先于启发式，避免成功工具被误标。
 */
export function isErrorForToolResult(result: ToolExecutionResult): boolean {
  if (!result.success) return true;
  if (!isRecord(result.output)) return false;

  const explicitIsError = result.output.isError ?? result.output.is_error;
  if (typeof explicitIsError === "boolean") return explicitIsError;

  if (result.toolName === "Bash" && typeof result.output.interrupted === "boolean") {

    if (isBashOutputProviderError(result.output)) return true;
    return result.output.interrupted;
  }

  return false;
}

/**
 * 估算用的宽松序列化：优先 JSON.stringify，遇到循环引用/不可序列化时退回 String()。
 * 只用于体积/预算估算，不参与模型内容生成，因此允许信息损失。
 */
export function stringifyForEstimation(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 MCP 工具名 `mcp__<server>__<tool...>`。
 * 输入：原始工具名；输出：serverName 与把剩余段用 "__" 重新拼回的 toolName，
 *   保留工具名内部可能存在的双下划线。
 * 失败语义：非 mcp__ 前缀、server 为空、tool 为空都返回 undefined（非 MCP 工具）。
 * 纯函数；不要用它替代 registry 的 name 解析（别名归一化另有入口）。
 */
export function parseMcpToolName(
  name: string,
): { serverName: string; toolName: string } | undefined {
  if (!name.startsWith("mcp__")) {
    return undefined;
  }
  const [, serverName, ...toolParts] = name.split("__");
  if (!serverName || toolParts.length === 0) {
    return undefined;
  }
  return {
    serverName,
    toolName: toolParts.join("__"),
  };
}

/**
 * 查询某 toolCall 在调度计划里所属的并行组下标；不在任何组时返回 -1。
 * 纯查询，不修改 schedule；调用方据 -1 判定"未纳入调度"。
 */
export function findParallelGroupIndex(schedule: ToolSchedule, toolCallId: ToolCallId): number {
  return schedule.parallelGroups.findIndex((group) => group.includes(toolCallId));
}
