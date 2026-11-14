import type { AgentListingDelta } from "../agent/agent-listing-metadata.js";
import { type RuntimeAttachmentEntry, type RuntimeMessageEntry } from "../agent/message-history.js";
import type { AgentDefinitionsSnapshot } from "./definitions.js";
import { formatAgentProfileForPrompt } from "./profile.js";

// 首次公告（此前从未向模型宣布过任何 agent 类型）使用的标题。
const INITIAL_HEADING = "Available agent types for the Agent tool:";
// 增量公告（已有历史公告，仅新增类型）使用的标题。
const ADDED_HEADING = "New agent types are now available for the Agent tool:";
// 类型被移除时的标题；需搭配 ambient 提示，避免模型主动向用户复述。
const REMOVED_HEADING = "The following agent types are no longer available:";
// 移除类公告属于环境上下文，要求模型不要主动复述给用户。
const AMBIENT_CONTEXT_NOTE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";
// 首次公告时附带并发建议：多个独立任务应在同一条消息里并行发起。
const CONCURRENCY_NOTE =
  "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";

// 计算本轮需要下发的 agent 类型清单增量，生成一条 attachment；无需变更时返回 undefined。
// 输入：当前可用 agent 定义、历史消息条目（含此前 delta）、当前工具面。
// 输出：单个 attachment（content 为展示文案，metadata 携带结构化 delta 供后续轮次复用）。
// 纯函数、无 IO；幂等性由历史 delta 的重放保证：已公告过的名称不会重复公告。
// 早退语义：没有 Agent 工具时直接返回 undefined，避免下发无意义的类型清单。
export function collectAgentListingAttachment(input: {
  definitions: AgentDefinitionsSnapshot;
  entries: readonly RuntimeMessageEntry[];
  tools: readonly { name: string }[];
  embeddedSearchEnabled?: boolean;
}): RuntimeAttachmentEntry | undefined {
  // Agent 工具不可用时，子 agent 类型清单没有消费方，跳过计算。
  if (!input.tools.some((tool) => tool.name === "Agent")) return undefined;
  const announced = new Set<string>();
  for (const entry of input.entries) {
    if (entry.kind !== "attachment" || entry.metadata.source !== "agent_listing_delta") continue;
    // 历史写入/恢复边界已校验并复制 delta；本轮新增 delta 由收集器生成。
    // 此处只读名称增删，避免每次请求重复校验并分配临时数组与 Set。
    const delta = entry.metadata.agentListingDelta;
    if (!delta) continue;
    for (const name of delta.addedTypes) announced.add(name);
    for (const name of delta.removedTypes) announced.delete(name);
  }
  const active = input.definitions.activeAgents;
  const current = new Set(active.map((profile) => profile.name));
  // 未公告过的即新增；顺序后续按名称排序，与定义文件顺序无关。
  const added = active.filter((profile) => !announced.has(profile.name));
  // 公告过但已不在当前集合中的视为移除；不存在的名字不会重复累加。
  const removedTypes: string[] = [];
  for (const name of announced) {
    if (!current.has(name)) removedTypes.push(name);
  }
  // 双侧都为空说明清单无变化，返回 undefined 让上层跳过 attachment 注入。
  if (added.length === 0 && removedTypes.length === 0) return undefined;
  added.sort((left, right) => left.name.localeCompare(right.name));
  removedTypes.sort();
  // isInitial 以“公告前是否为空”判定，保证首次下发使用初始化标题与并发提示。
  const delta: AgentListingDelta = {
    addedTypes: added.map((profile) => profile.name),
    addedLines: added.map((profile) => formatAgentProfileForPrompt(profile, input)),
    removedTypes,
    isInitial: announced.size === 0,
    showConcurrencyNote: true,
  };
  return {
    kind: "attachment",
    content: formatAgentListingDelta(delta),
    metadata: { source: "agent_listing_delta", agentListingDelta: delta },
  };
}

// 把结构化 delta 渲染为注入文本：新增段 + 移除段（含 ambient 提示）+ 首次并发提示。
// 段落之间用空行分隔；无新增/无移除时对应段落整体省略，绝不产出空标题。
function formatAgentListingDelta(delta: AgentListingDelta): string {
  const sections: string[] = [];
  if (delta.addedLines.length > 0) {
    sections.push(
      `${delta.isInitial ? INITIAL_HEADING : ADDED_HEADING}\n${delta.addedLines.join("\n")}`,
    );
  }
  if (delta.removedTypes.length > 0) {
    sections.push(
      `${REMOVED_HEADING}\n${delta.removedTypes.map((name) => `- ${name}`).join("\n")}`,
      AMBIENT_CONTEXT_NOTE,
    );
  }
  if (delta.isInitial && delta.showConcurrencyNote) sections.push(CONCURRENCY_NOTE);
  return sections.join("\n\n");
}
