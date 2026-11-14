/**
 * ============================================================================
 * runtime/methods/plugin-reference.ts —— 插件引用 reminder 的 turn-start 注入
 * ============================================================================
 * 【输入/输出】本轮 userInput + toolDisallowlist → 冻结 catalog ∩ live 能力 → reminder 文本。
 * 【写入】先写 messageHistory attachment，再落一条 model-only synthetic notice（durable）。
 * 【关键不变量】#17 live/cold 必须同终态：只写内存会让冷恢复丢 reminder、前缀缓存错位。
 * 【失败语义】对话 fail open（不阻塞本轮）；能力注入 fail closed（异常不写兜底内容）。
 * ============================================================================
 */
// plugin_reference reminder 的 turn-start 注入。
// 契约：解析 canonical text → 冻结 catalog →
// 与 live Skill/MCP/Subagent inventory 取交集 → 生成本轮 model-only reminder。
// 失败语义：对话 fail open（任何异常都不阻塞本轮），能力注入 fail closed（异常时不注入）。
import { toMcpToolName } from "../../mcp/index.js";
import {
  buildPluginReferenceReminderBody,
  extractPluginReferences,
  type LivePluginMcpServer,
  type LivePluginSkill,
  type LivePluginSubagent,
} from "../../plugin-reference/index.js";
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

async function collectLiveMcpServers(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  toolDisallowlist: readonly string[] | undefined,
): Promise<LivePluginMcpServer[]> {
  // 没有 MCP 端口 = 本进程不具备 MCP 能力；返回空集合，让 reminder 不声称任何 server。
  if (!runtime.mcpPort) return [];
  // initializeMcp 幂等；turn loop 的首个 provider 请求前本来就会等它，
  // 这里提前 await 不增加额外等待。引用绝不触发 connect/reconnect/OAuth——只读取现状。
  await runtime.initializeMcp(traceContext);
  // 读实时 status 判断 connected；读启动快照决定 provider 可见工具数，两者口径不同。
  const statuses = await runtime.mcpPort.status();
  // 启动快照可能仍在进行；这里 await 同一 promise，失败交给外层 fail open。
  const snapshot = runtime.mcpStartupPromise ? await runtime.mcpStartupPromise : undefined;
  const registeredToolNames = new Set(runtime.getTools().map((tool) => tool.name));
  // 与 turn-loop 的 provider 工具过滤保持完全相同的“完整工具名”语义；
  // 带参数的执行规则不会把整个工具从 provider 工具表移除，不能在 reminder 侧扩大解释。
  const turnDisallowedToolNames = new Set(toolDisallowlist ?? []);
  const providerVisibleToolCounts = new Map<string, number>();
  for (const descriptor of snapshot?.tools ?? []) {
    // provider-visible = 启动快照里的 tool 先通过 Session 全局 allow/disallow 注册过滤，
    // 再通过本轮 toolDisallowlist。根因：只看 registry 会把“本轮隐藏、全局仍注册”的
    // MCP tool 误算成可见能力，reminder 会声称一个 provider 实际拿不到的 server。
    // 先按 registry 全名匹配：不在 Session 注册表里的 tool 根本不会发给 provider。
    const toolName = toMcpToolName(descriptor);
    if (!registeredToolNames.has(toolName)) continue;
    // 再按本轮 disallow 剔除：它只影响 visible，但 provider 实际拿不到，不能计入可见能力。
    if (turnDisallowedToolNames.has(toolName)) continue;
    providerVisibleToolCounts.set(
      descriptor.serverName,
      (providerVisibleToolCounts.get(descriptor.serverName) ?? 0) + 1,
    );
  }
  // connected 用实时 status，不用启动快照：启动成功但后来掉线的 server 不算可用能力；
  // 计数缺省 0 表示该 server 当前没有任何 provider 可见工具。
  return Object.entries(statuses).map(([serverName, status]) => ({
    serverName,
    connected: status.status === "connected",
    providerVisibleToolCount: providerVisibleToolCounts.get(serverName) ?? 0,
  }));
}

function collectLivePluginSkills(runtime: AgentRuntimeInternal): LivePluginSkill[] {
  const skills: LivePluginSkill[] = [];
  for (const skill of runtime.skillLoadOutcome?.skills ?? []) {
    // 内置 skill 不属于 plugin 引用可解析的目标，混入会让 reminder 声称并不存在的来源。
    if (skill.source !== "plugin") continue;
    // 缺 provenance 的 skill 无法回溯归属，按 fail closed 跳过而不是猜 plugin 名。
    if (!skill.pluginName || !skill.qualifiedName) continue;
    skills.push({
      qualifiedName: skill.qualifiedName,
      pluginName: skill.pluginName,
      rootPath: skill.rootPath,
      source: skill.source,
    });
  }
  return skills;
}

function collectLivePluginSubagents(runtime: AgentRuntimeInternal): LivePluginSubagent[] {
  const subagents: LivePluginSubagent[] = [];
  for (const profile of runtime.getAgentDefinitions().activeAgents) {
    const name = profile.name.trim();
    const path = profile.path?.trim();
    // Plugin profile 由 bootstrap 从 Markdown 成功解析后才进入 config，且一定携带 path。
    // 无 path 的内置/inline profile 无法做 provenance 回溯，按 fail closed 跳过。
    if (!name || !path) continue;
    subagents.push({ name, path });
  }
  return subagents;
}

export async function injectPluginReferenceReminderFromTurn(
  this: AgentRuntimeInternal,
  userInput: string,
  traceContext: TraceContext,
  toolDisallowlist?: readonly string[],
): Promise<void> {
  // 无引用是绝对主路径：不 touch MCP/skills，零开销返回。
  const extraction = extractPluginReferences(userInput);
  if (extraction.references.length === 0) {
    if (extraction.invalidCount > 0) {
      this.logger?.debug("Plugin reference parse rejected invalid destinations", {
        ...traceContextToLogContext(traceContext),
        event: "plugin_reference.parse.invalid",
        invalidCount: extraction.invalidCount,
        module: "core.runtime",
      });
    }
    return;
  }

  const startedAt = Date.now();
  // 从这里起任何异常都收敛为 fail open：reminder 是增强能力，不能反过来让本轮请求失败。
  try {
    const liveMcpServers = await collectLiveMcpServers(this, traceContext, toolDisallowlist);
    const liveSkills = collectLivePluginSkills(this);
    const liveSubagents = collectLivePluginSubagents(this);
    const result = buildPluginReferenceReminderBody({
      references: extraction.references,
      catalog: this.config.pluginReferenceCatalog,
      liveSkills,
      liveMcpServers,
      liveSubagents,
    });
    // 每轮与消息流同数量级 → 必须 debug（生产 no-op），只输出受控标识与计数。
    this.logger?.debug("Plugin reference reminder resolved", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "plugin_reference.reminder.resolved",
      invalidCount: extraction.invalidCount,
      mcpServerCount: result.diagnostics.mcpServerCount,
      module: "core.runtime",
      referenceCount: extraction.references.length,
      resolvedPluginIds: result.diagnostics.resolvedPluginIds,
      skillCount: result.diagnostics.skillCount,
      subagentCount: result.diagnostics.subagentCount,
      skipped: result.diagnostics.skipped,
      truncated: result.diagnostics.truncated || extraction.truncatedCount > 0,
    });
    // 正文为空 = 引用解析成功但 live 能力一个都没匹配上；注入空 reminder 只会制造空 attachment。
    if (!result.body) return;
    // 先写内存态让本轮立刻可见，同源 durable 事实由下面的 notice 补齐。
    this.messageHistory.addAttachment("plugin_reference", result.body);
    // 根因：只写 runtime attachment 会让热会话保留 reminder、cold resume 却丢失，
    // 历史消息序列因此错位并破坏 provider 前缀缓存。先注入再以 model-only notice
    // 原文落库，通用 hydration 会按同一 source 重建 attachment，UI 不产生用户气泡。
    await this.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      sessionId: this.sessionId,
      source: "plugin_reference",
      text: result.body,
      traceContext,
    });
  } catch (error) {
    // 对话 fail open：reminder 生成失败不影响本轮发送；能力注入 fail closed：不写任何兜底内容。
    this.logger?.debug("Plugin reference reminder generation failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      event: "plugin_reference.reminder.failed",
      module: "core.runtime",
      referenceCount: extraction.references.length,
    });
  }
}
