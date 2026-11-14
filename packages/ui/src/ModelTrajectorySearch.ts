// INV-01 原始偏移：守住位置 归一化数组；改错故障：高亮落在错误的原始字符区间。
// INV-02 空白折叠：守住位置 连续空白合并；改错故障：匹配结果被多余空格打断。
// INV-03 偏移跟随：守住位置 合并时的结束下标更新；改错故障：空白区间右侧越界或截断。
// INV-04 大小写归一：守住位置 逐字符转换；改错故障：跨语言大小写匹配失败。
// INV-05 一对一映射：守住位置 字符扩展时的循环；改错故障：转换后长度变化的字符偏移错位。
// INV-06 空查询早退：守住位置 索引构建的前置判断；改错故障：空查询返回大量空匹配。
// INV-07 键唯一：守住位置 匹配键拼装；改错故障：同字段多次出现时键冲突。
// INV-08 字段来源：守住位置 目标字段枚举；改错故障：正文与工具名命中无法区分。
// INV-09 输入消息展开：守住位置 消息遍历；改错故障：只搜最后一条消息。
// INV-10 响应缺失：守住位置 响应判空；改错故障：没有响应时抛错。
// INV-11 推理文本：守住位置 推理段目标；改错故障：推理内容不可搜索。
// INV-12 工具调用展开：守住位置 工具调用遍历；改错故障：工具参数不可搜索。
// INV-13 工具输出优先：守住位置 结果分支；改错故障：工具结果被当作输入搜索。
// INV-14 工具输入次选：守住位置 调用分支；改错故障：工具调用参数被丢弃。
// INV-15 文本回落：守住位置 普通文本分支；改错故障：纯文本消息搜不到。
// INV-16 元数据字段：守住位置 工具名与标识目标；改错故障：按工具名搜索无结果。
// INV-17 高亮上下文：守住位置 揭示上下文默认值；改错故障：点击匹配后无法定位。
// INV-18 纯函数：守住位置 索引与匹配函数；改错故障：读外部状态导致同输入不同结果。
//
// 模块职责：为模型轨迹构建可高亮的搜索索引，并把归一化位置映射回原始文本区间。
// 状态所有权：无状态；索引与匹配结果均为新对象，揭示上下文只存匹配键。
// 阅读顺序：匹配结构 → 揭示上下文 → 索引构建 → 目标展开 → 文本归一化。
import { createContext } from "react";
import type { ZCodeModelTrajectoryMessage, ZCodeModelTrajectoryRecord } from "@zcode/services";
import {
  trajectoryToolCallInputs,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
} from "@/ModelTrajectoryToolPayload.js";

// 字段枚举：正文、工具名与工具标识，三类结果在界面上可区分。
// 字段值会写进匹配键，改动枚举等于改动键格式。
// 枚举同时用于匹配键与界面标签。
//
export type TrajectorySearchField = "content" | "tool-name" | "tool-id";

// 匹配结构：记录所在调用、字段、第几次命中与原始区间。
// 键由展开键、字段、命中序号与起点拼成，保证同一位置唯一。
// 原始区间用于高亮，原文保留避免重复切片。
//
export interface TrajectorySearchMatch {
  key: string;
  callKey: string;
  callIndex: number;
  expansionKey: string;
  field: TrajectorySearchField;
  fieldMatchIndex: number;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
}

// 索引：查询串加全部匹配，空查询返回空索引。
// 查询串保存归一化后的结果，供高亮切分复用。
//
export interface TrajectorySearchIndex {
  query: string;
  matches: TrajectorySearchMatch[];
}

export interface TrajectorySearchTimelineItem {
  key: string;
  record: ZCodeModelTrajectoryRecord;
  inputMessages: ZCodeModelTrajectoryMessage[];
}

interface SearchTarget {
  callKey: string;
  callIndex: number;
  expansionKey: string;
  field: TrajectorySearchField;
  text: string;
}

// `TrajectorySearchRevealContext` 存当前要滚动到的匹配键，null 表示没有。
// 上下文默认空值，由轨迹视图在点击匹配时写入。
// `TrajectorySearchRevealContext` 同一时刻只保存一个键，不保留历史。
//
export const TrajectorySearchRevealContext = createContext<string | null>(null);

// 索引构建：先归一化查询并去掉首尾空白，空查询直接返回空索引。
// 每个搜索目标独立查找，命中项展开成带字段与区间的匹配。
// 匹配键包含命中序号，同一字段多处出现也不会冲突。
//
export function buildTrajectorySearchIndex(
  items: readonly TrajectorySearchTimelineItem[],
  query: string,
): TrajectorySearchIndex {
  const normalizedQuery = normalizeTrajectorySearchText(query).text.trim();
  if (!normalizedQuery) return { query: "", matches: [] };

  const matches: TrajectorySearchMatch[] = [];
  for (const target of buildSearchTargets(items)) {
    const sourceMatches = findTrajectoryTextMatches(target.text, normalizedQuery);
    sourceMatches.forEach(({ sourceStart, sourceEnd }, fieldMatchIndex) => {
      matches.push({
        ...target,
        key: `${target.expansionKey}:${target.field}:${fieldMatchIndex}:${sourceStart}`,
        fieldMatchIndex,
        sourceStart,
        sourceEnd,
        sourceText: target.text,
      });
    });
  }
  return { query: normalizedQuery, matches };
}

// 目标展开：输入消息、推理、回复正文与工具调用各自生成可搜索文本。
// 没有响应时只返回输入侧目标。
// 工具调用的参数与结果都通过消息目标展开。
//
function buildSearchTargets(items: readonly TrajectorySearchTimelineItem[]): SearchTarget[] {
  return items.flatMap((item, callIndex) => {
    const targets = item.inputMessages.flatMap((message, messageIndex) =>
      messageTargets(item.key, callIndex, `${item.key}:input:${messageIndex}`, message),
    );
    const response = item.record.response;
    if (!response) return targets;
    if (response.reasoningText) {
      targets.push(
        contentTarget(item.key, callIndex, `${item.key}:output:reasoning`, response.reasoningText),
      );
    }
    if (response.text) {
      targets.push(contentTarget(item.key, callIndex, `${item.key}:output:message`, response.text));
    }
    response.toolCalls.forEach((toolCall, toolCallIndex) => {
      targets.push(
        ...messageTargets(
          item.key,
          callIndex,
          `${item.key}:output:${toolCall.kind}:${toolCallIndex}`,
          { role: "assistant", parts: [toolCall] },
        ),
      );
    });
    return targets;
  });
}

function messageTargets(
  callKey: string,
  callIndex: number,
  expansionKey: string,
  message: ZCodeModelTrajectoryMessage,
): SearchTarget[] {
  const metadata = trajectoryToolMetadata(message);
  const content = message.parts.some((part) => part.kind === "tool-result")
    ? trajectoryToolOutputs(message).join("\n\n")
    : message.parts.some((part) => part.kind === "tool-call")
      ? trajectoryToolCallInputs(message).join("\n\n")
      : message.parts
          .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
          .join("\n\n");
  return [
    ...(content ? [contentTarget(callKey, callIndex, expansionKey, content)] : []),
    ...(metadata.names
      ? [{ callKey, callIndex, expansionKey, field: "tool-name" as const, text: metadata.names }]
      : []),
    ...(metadata.ids
      ? [{ callKey, callIndex, expansionKey, field: "tool-id" as const, text: metadata.ids }]
      : []),
  ];
}

function contentTarget(
  callKey: string,
  callIndex: number,
  expansionKey: string,
  text: string,
): SearchTarget {
  return { callKey, callIndex, expansionKey, field: "content", text };
}

// 文本查找：在归一化文本上顺序查找，命中后从结束位置继续。
// 原始区间由归一化映射表回填，边界缺失时退回起点。
// `findTrajectoryTextMatches` 的 while 循环在查不到时立即结束。
//
export function findTrajectoryTextMatches(
  source: string,
  normalizedQuery: string,
): Array<{ sourceStart: number; sourceEnd: number }> {
  const normalizedSource = normalizeTrajectorySearchText(source);
  const matches: Array<{ sourceStart: number; sourceEnd: number }> = [];
  let searchStart = 0;
  while (searchStart < normalizedSource.text.length) {
    const matchStart = normalizedSource.text.indexOf(normalizedQuery, searchStart);
    if (matchStart === -1) break;
    const matchEnd = matchStart + normalizedQuery.length;
    const sourceStart = normalizedSource.starts[matchStart] ?? 0;
    matches.push({
      sourceStart,
      sourceEnd: normalizedSource.ends[matchEnd - 1] ?? sourceStart,
    });
    searchStart = matchEnd;
  }
  return matches;
}

// 文本归一化：连续空白折叠成一个空格，其余字符逐字转小写。
// 每个输出字符记录对应的原始起点与终点，供高亮回填。
// 大小写转换可能改变字符长度，按扩展后的每个字符分别登记区间。
//
export function normalizeTrajectorySearchText(source: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let inWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      if (!inWhitespace) {
        text += " ";
        starts.push(index);
        ends.push(index + 1);
        inWhitespace = true;
      } else {
        ends[ends.length - 1] = index + 1;
      }
      continue;
    }
    inWhitespace = false;
    const normalizedCharacter = character.toLocaleLowerCase();
    text += normalizedCharacter;
    for (let offset = 0; offset < normalizedCharacter.length; offset += 1) {
      starts.push(index);
      ends.push(index + 1);
    }
  }
  return { text, starts, ends };
}
