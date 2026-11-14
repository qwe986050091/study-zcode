/**
 * 按 assistant 轮次切分消息序列，供 microcompact / 轮次级压缩决定保留边界。
 * 输入为任意元素数组与两个取值函数，输出保持原始顺序的分组数组（纯函数，无 IO）。
 * 不变量：每条消息只属于一个分组，分组之间不重排；末尾未闭合的分组会正常产出。
 */

// 切分口径：assistant 消息若与上一组 assistant 的 id 不同（或调用方未提供 id）即开启新组，
// 因此工具结果、user 消息总是落在"当前正在进行的轮次"里，不会单独成组。
// assistantIdOf 用于区分同一轮内的多条 assistant 消息（流式分片），避免每条都开新组。
export function groupByAssistantStartedRounds<T>(
  items: readonly T[],
  roleOf: (item: T) => string | undefined,
  assistantIdOf?: (item: T) => string | undefined,
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let lastAssistantId: string | undefined;

  for (const item of items) {
    const role = roleOf(item);
    const assistantId = role === "assistant" ? assistantIdOf?.(item) : undefined;
    // 缺少 id 的 assistant 无法证明属于上一轮，按保守策略视为新轮次，避免把两轮错误合并。
    const startsNewAssistantRound =
      role === "assistant" &&
      current.length > 0 &&
      (assistantId === undefined || assistantId !== lastAssistantId);

    // 先收口旧组再以当前消息开新组，保证每组都以 assistant 消息打头。
    if (startsNewAssistantRound) {
      groups.push(current);
      current = [item];
    } else {
      current.push(item);
    }

    if (role === "assistant") {
      lastAssistantId = assistantId;
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}
