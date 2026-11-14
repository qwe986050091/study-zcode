/**
 * agent-listing.ts —— 可用子代理列表的收集与注入
 *
 * 只有本轮工具集里存在 Agent 工具时才生成列表;列表作为 attachment 注入,
 * 让模型知道哪些子代理可用。appendRuntimeAgentListing 先持久化 synthetic notice,
 * 成功后再提交到权威历史——失败不能让后续请求误判为"已通知过"。
 *
 * 【链路位置】turn-loop 在组装请求前调用；收集本身无 IO，只有工具面里出现 Agent 时才产生内容，
 * 因此"没有子代理可用"时不会凭空多出一条历史。
 * 【三类事实】列表文本先写 durable（synthetic user notice，metadata.runtimeMessage 携带 attachment
 * 元数据），落盘成功后才 commitTurnRequestEntries 改内存态 turnRequestState.entries。
 * 【顺序不变量】必须"先 durable、后内存"：落盘抛错时本轮不提交，下一轮会再发一次；
 * 反过来若先提交内存，写盘失败会让后续请求误以为已经通知过，模型从此看不到子代理列表。
 */
import { createMessageId, type TraceContext } from "@zcode/contracts";
import type { RuntimeAttachmentEntry, RuntimeMessageEntry } from "../../agent/message-history.js";
import { collectAgentListingAttachment } from "../../subagent/listing.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "../methods/embedded-search-branch.js";
import { commitTurnRequestEntries } from "../methods/turn-output-token-continuation.js";
import type { TurnRequestState } from "../methods/turn-loop-state.js";

/** 收集 agent 列表 attachment;没有 Agent 工具时返回 undefined。 */
/**
 * 收集 agent 列表 attachment;没有 Agent 工具时返回 undefined。
 *
 * 职责：把"当前可用子代理定义 + 历史里已出现过的 agent + 本轮工具面"交给
 * subagent/listing 生成一段系统提醒文本，作为 attachment entry 注入请求。
 *
 * 输入：
 * - runtime.getAgentDefinitions() 提供可用代理定义（静态配置）；
 * - entries 是当前 turn-local 历史，用于让 listing 反映已经出现过的代理；
 * - tools 是本轮真实暴露的工具面，只有含 "Agent" 才说明该能力确实可达。
 *
 * 输出：RuntimeAttachmentEntry（metadata.source 为 agent_listing_delta）或 undefined。
 * 副作用：无（纯内存读取）；落盘由调用方 appendRuntimeAgentListing 负责。
 * 失败与降级：不抛错；缺少 Agent 工具直接视为不需要列表。
 */
export function collectRuntimeAgentListing(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  tools: readonly { name: string }[],
): RuntimeAttachmentEntry | undefined {
  if (!tools.some((tool) => tool.name === "Agent")) return undefined;
  return collectAgentListingAttachment({
    definitions: runtime.getAgentDefinitions(),
    entries,
    tools,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(runtime),
  });
}

/** 持久化并提交 agent 列表提醒(先落库,后进权威历史)。 */
/**
 * 持久化并提交 agent 列表提醒(先落库,后进权威历史)。
 *
 * 职责：生成列表 entry → 写成 synthetic user notice（durable）→ 提交到 turnRequestState。
 * 输入输出：入参 state 是本次请求的 turn-local 状态，函数无返回值、原地追加 entry。
 * 副作用：一次 session store 写入（source=agent_listing_delta，metadata 保留 attachment 口径），
 * 以及一次内存态变更（commitTurnRequestEntries）。
 * 失败语义：persistSyntheticUserNoticeForSession 抛错时直接向上冒泡，调用方（turn loop）负责
 * 让本轮失败；绝不吞错继续，否则会生成"历史里没有、但模型以为有"的悬空通知。
 * 不变量：entry 为 undefined（无 Agent 工具）时是 no-op，不产生任何写入。
 */
export async function appendRuntimeAgentListing(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  tools: readonly { name: string }[],
  traceContext: TraceContext,
): Promise<void> {
  const entry = collectRuntimeAgentListing(runtime, state.entries, tools);
  if (!entry) return;
  // 持久化成功后才提交到权威历史，失败不能让后续请求误判为已通知。
  await runtime.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: runtime.sessionId,
    source: "agent_listing_delta",
    text: entry.content,
    metadata: { runtimeMessage: entry.metadata },
    traceContext,
  });
  commitTurnRequestEntries(runtime, state, [entry]);
}
