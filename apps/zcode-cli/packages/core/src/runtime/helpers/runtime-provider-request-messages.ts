/**
 * ============================================================================
 * runtime-provider-request-messages.ts —— provider 请求组装的统一入口
 * ============================================================================
 *
 * 【为什么需要"先决策工具、再投影消息"】
 *   ToolSearch 会决定"哪些工具常驻、哪些延迟暴露、哪些加载后从上下文中移除"。
 *   如果消息投影与工具列表各算一次,可能出现"消息里保留了工具引用,但请求 tools 为空"
 *   的不一致(历史 bug)。因此这里先用完整作用域目录做一次 ToolSearch 决策,
 *   再把配套结果(投影消息、工具列表、已加载 toolCallIds、ToolSearch 上下文)一起返回。
 *
 * prepareRuntimeProviderRequest  正常请求/compact 请求共用:决策 + 投影 + 组装
 * buildRuntimeProviderRequestMessages  仅投影消息,供事件记录与 token 估算复用
 *
 * 【返回值口径】
 * - request.messages / request.tools：真正发给 provider 的消息与工具合同，
 *   二者来自同一次 ToolSearch 决策，保证"消息里引用的工具"与"实际暴露的工具"一致；
 * - projection：逐条来源映射与诊断，供事件记录和 token 估算复用；
 * - entries：实际参与请求的条目（prompt 追加前的结果），供调用方回写本地状态；
 * - loadedToolCallIds：本次已加载的工具 id，事件记录重渲染时必须复用，否则会漏提示；
 * - toolSearch：本次决策上下文（mode/reason），用于日志与能力开关判断；
 * - reason：工具暴露决策的原因，便于排查"为什么工具被过滤"。
 * ============================================================================
 */
import { buildToolExposure } from "../../tool/search/exposure.js";
import type { ModelToolContract } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ToolRegistry } from "../../tool/registry.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  buildProviderRequestMessages,
  type ProviderRequestMessageProjectionResult,
} from "./provider-request-messages.js";

/**
 * 请求组装只需要 runtime 配置里的两项能力开关：
 * - midConversationSystem：强制/按模型能力决定是否启用 MCS；
 * - toolSearch：ToolSearch 模式（native/过滤策略）的来源。
 * 用 Pick 是为了让本模块只依赖配置、不依赖完整 AgentRuntimeConfig。
 */
type RequestRuntime = {
  readonly config: Pick<AgentRuntimeConfig, "midConversationSystem" | "toolSearch">;
};

/**
 * 消息投影输入。
 *
 * - entries：本次请求的 turn-local/canonical 条目；
 * - applyCacheControl：是否设置 cache 锚点（正常请求 true，估算 false）；
 * - skipCacheWrite：辅助/compact 请求不写缓存；
 * - model：提供 inputFormat 与 supportsMidConversationSystem 能力；
 * - loadedToolCallIds：已加载工具 id，重渲染时保证成功提示不丢失。
 */
interface MessageProjectionInput {
  entries: readonly RuntimeMessageEntry[];
  applyCacheControl?: boolean;
  skipCacheWrite?: boolean;
  model: Model;
  loadedToolCallIds?: ReadonlySet<string>;
}

// Bug 根因：辅助请求分别组装历史和 tools 时，曾按模型能力保留引用却发送 tools: []。
// 请求准备必须先用完整作用域目录做一次 ToolSearch 决策，再向投影和发送方提供配套结果。
/**
 * 准备一次 provider 请求:工具暴露决策 + 消息投影。
 *
 * @param input.prompt 若传入,会作为最后一条 user 消息追加(compact summary 用);
 *                     若为 undefined,只投影现有历史条目。
 * @param input.applyCacheControl 是否在投影后设置 cache-control 锚点(正常请求 true;
 *                      compact 侧根据场景选择;纯估算场景 false)。
 * @param input.skipCacheWrite 是否跳过缓存写入(辅助请求不应写缓存)。
 * @returns request(真正发给 provider 的消息+工具)、projection(逐条来源映射)、
 *          entries(实际参与请求的条目)、toolSearch(决策上下文)。
 *
 * 顺序不变量:必须先 buildToolExposure,再用其 entries 做消息投影。反过来会让
 * 投影看到被移除的工具引用,而 tools 列表已是过滤后的结果,产生不一致。
 * prompt 只在投影时追加为最后一条 user 消息,不写回 entries,避免污染调用方状态。
 */
export function prepareRuntimeProviderRequest(
  runtime: RequestRuntime,
  input: MessageProjectionInput & {
    tools: readonly ModelToolContract[];
    registry?: Pick<ToolRegistry, "get">;
    prompt?: string;
  },
) {
  const exposure = buildToolExposure({
    model: input.model,
    mode: runtime.config.toolSearch?.mode,
    tools: input.tools,
    registry: input.registry,
    entries: input.entries,
  });
  const projection = buildRuntimeProviderRequestMessages(runtime, {
    entries:
      input.prompt === undefined
        ? exposure.entries
        : [...exposure.entries, { message: { role: "user", content: input.prompt } }],
    model: input.model,
    loadedToolCallIds: exposure.loadedToolCallIds,
    applyCacheControl: input.applyCacheControl,
    skipCacheWrite: input.skipCacheWrite,
  });
  return {
    request: {
      messages: projection.messages,
      tools: exposure.tools,
      toolSearchEnabled: exposure.context.mode === "native",
    },
    projection,
    entries: exposure.entries,
    // 记录过滤 Continue 后会重新渲染，需复用本次有效引用，避免遗漏成功提示或重复扫描历史。
    loadedToolCallIds: exposure.loadedToolCallIds,
    toolSearch: exposure.context,
    reason: exposure.reason,
  };
}

// 仅渲染消息，供已准备请求的记录投影和历史估算复用；不重新猜测工具启用状态。
/**
 * 只做消息投影(带 mid-conversation system 开关),不重新决策工具暴露。
 * 用于"事件记录投影"和"历史 token 估算",保证与已准备请求使用同一渲染口径。
 *
 * MCS 开关:配置 mode=force 时无条件启用;否则仅当模型声明
 * supportsMidConversationSystem 时启用——不支持 MCS 的 provider 收到 role=system
 * 的对话中段消息会报错,因此这里必须 fail safe 到关闭。
 * 副作用:无 IO,只生成投影结果。
 */
export function buildRuntimeProviderRequestMessages(
  runtime: RequestRuntime,
  input: MessageProjectionInput,
): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem =
    runtime.config.midConversationSystem?.mode === "force" ||
    input.model.properties.supportsMidConversationSystem;
  return buildProviderRequestMessages({
    ...input,
    useMidConversationSystem,
  });
}
