// INV-01 优先级只看 scope 与 source：守住位置 workspace 优先于 user 优先于其它；改错故障 同名 agent 选错来源。
// INV-02 同名去重保留高优先级：守住位置 严格小于比较；改错故障 后到的低优先级覆盖工作区配置。
// INV-03 名称以小写 trim 为键：守住位置 toLowerCase 与 trim；改错故障 大小写差异产生重复候选。
// INV-04 禁用的 agent 不出现：守住位置 enabled 判空；改错故障 用户关掉的子代理仍能被提及。
// INV-05 空名直接跳过：守住位置 空键分支；改错故障 空字符串键把所有无名项合并。
// INV-06 来源标签与优先级同源不同序：守住位置 两个函数的判断顺序；改错故障 标签与排序自相矛盾。
// INV-07 id 带 subagent 前缀：守住位置 模板字符串；改错故障 与其它 mention provider 撞 id。
// INV-08 描述前挂来源标签：守住位置 description 三元；改错故障 用户无法区分同名来源。
// INV-09 关键词覆盖名称与描述与来源与路径：守住位置 keywords 数组；改错故障 搜索命中率下降。
// INV-10 模型标识为两段拼接：守住位置 modelSelection 三元；改错故障 模型名歧义。
// INV-11 空 query 不做三条截断：守住位置 requireQuery 取 false；改错故障 第四个之后的 agent 被藏起来。
// INV-12 候选按 agents 记忆化：守住位置 第一个 useMemo 依赖；改错故障 每次渲染重建候选。
// INV-13 过滤再按 query 记忆化：守住位置 第二个 useMemo；改错故障 输入每个字符都全量重算。
// INV-14 关闭时只清空 items：守住位置 enabled 三元；改错故障 关闭后仍残留 loading 或 error。
//
// 模块职责：把子代理列表投影成 mention 候选分类结果。
// 阅读顺序：先看优先级与去重，再看单项投影，最后看 hook 的两级记忆化与关闭时的返回。
import { useMemo } from "react";
import type { ZCodeProvider, AgentSummary } from "@zcode/shared";
import { useSubagents } from "@/hooks/useSubagents.js";
import { buildSubagentMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

type SubagentMentionInput = Pick<
  AgentSummary,
  "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
>;

function getSubagentSourcePriority(agent: SubagentMentionInput): number {
  // 工作区定义的子代理优先级最高。
  if (agent.scope === "workspace") {
    return 0;
  }
  // source === "user" 的用户级来源排在第二档，优先级取 1。
  if (agent.source === "user") {
    return 1;
  }
  // 其余来源（plugin、built-in）一律返回 2，排序时与工作区级拉开。
  return 2;
}

function getSubagentSourceLabel(agent: SubagentMentionInput): string {
  if (agent.scope === "workspace") {
    return "Workspace";
  }
  if (agent.source === "plugin") {
    return "Plugin";
  }
  if (agent.source === "built-in") {
    return "Built-in";
  }
  return "User";
}

export function mapSubagentsToMentionItemsForTest(agents: SubagentMentionInput[]): MentionItem[] {
  const uniqueAgentsByName = new Map<string, SubagentMentionInput>();
  for (const agent of agents) {
    // enabled 为 false 的条目在去重前直接跳过，避免占用同名位置。
    if (!agent.enabled) {
      continue;
    }
    // 去重键由 name.trim().toLowerCase() 生成，大小写与首尾空白都归一。
    const key = agent.name.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const current = uniqueAgentsByName.get(key);
    // 严格小于才替换，保证先到的高优先级不被覆盖。
    if (!current || getSubagentSourcePriority(agent) < getSubagentSourcePriority(current)) {
      uniqueAgentsByName.set(key, agent);
    }
  }

  return [...uniqueAgentsByName.values()].map((agent) => {
    // 标签只算一次，供描述与关键词复用。
    const sourceLabel = getSubagentSourceLabel(agent);
    // 模型标识缺失就留空，不写占位符。
    const model = agent.modelSelection
      ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
      : undefined;
    return {
      // 前缀保证与其它 provider 的 id 空间隔离。
      id: `subagent:${agent.id}`,
      category: "subagents",
      label: agent.name,
      // description 非空时把 sourceLabel 前置，用户先看到来源再看描述。
      description: agent.description ? `${sourceLabel} · ${agent.description}` : sourceLabel,
      value: agent.name,
      markdown: buildSubagentMentionMarkdown(agent.name),
      keywords: [
        agent.name,
        agent.description,
        agent.scope,
        agent.source,
        sourceLabel,
        model ?? "",
        agent.path,
      ],
      data: {
        path: agent.path,
        scope: agent.scope,
        source: agent.source,
        model,
      },
    } satisfies MentionItem;
  });
}

export function useSubagentsMentionProvider(
  workspacePath: string | null,
  provider: ZCodeProvider,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  // 数据来源只有这一处，hook 本身不缓存。
  const { agents, loading, error } = useSubagents(workspacePath, provider);

  const allItems = useMemo(() => mapSubagentsToMentionItemsForTest(agents), [agents]);

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        // Bugfix：subagent 候选通常数量很少，空 query 时也是执行入口。
        // 复用通用 mention 的 3 条预览会把第 4 个之后的 agent 藏起来，用户误以为没加载。
        // 空 query 也执行，避免候选被预览条数截断。
        requireQuery: false,
      }),
    [allItems, query],
  );

  return {
    // 关闭只影响候选列表，状态字段照常透传。
    items: enabled ? items : [],
    loading,
    error: error ? new Error(error) : null,
    emptyText,
    title,
  };
}
