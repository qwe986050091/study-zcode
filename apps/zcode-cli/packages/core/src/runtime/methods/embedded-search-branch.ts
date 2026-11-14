/**
 * ============================================================================
 * runtime/methods/embedded-search-branch.ts —— 内嵌检索分支对工具面的影响
 * ============================================================================
 *
 * 分支开启时检索走 Bash 内嵌 prelude，内置 Glob/Grep 要从 registry 与
 * provider-visible 工具面里一起摘掉；关闭时保留传统内置工具。
 *
 * 本文件有三处消费同一判定（启用查询 / 注册刷新 / 可见性过滤）。
 * 任何一处单独改判定，都会让 registry 与模型看到的工具面出现分叉：
 * 模型可能调用一个已摘除的工具，或看不到一个仍在 registry 里的工具。
 * ============================================================================
 */
import type { ModelToolContract } from "../deps.js";
import { registerBuiltInTools } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDynamicWorkflowToolsIncluded,
} from "../helpers/tool-allowlist.js";
import { isToolNameDisallowed } from "../../tool/tool-visibility.js";

export function resolveRuntimeEmbeddedSearchEnabled(runtime: AgentRuntimeInternal): boolean {
  const builtInToolAllowlist = resolveBuiltInToolAllowlist(runtime.config);
  // 允许清单缺省（undefined）表示"不限制内置工具"，此时只要 Bash 未被显式禁用就算可用；
  // disallowlist 的优先级高于缺省，任一条件不成立都会退回传统 Glob/Grep 分支。
  const decision = resolveEmbeddedSearchBranchCapability({
    bashAvailable:
      (builtInToolAllowlist === undefined || builtInToolAllowlist.includes("Bash")) &&
      !isToolNameDisallowed("Bash", runtime.config.toolDisallowlist),
  });
  return decision.useEmbeddedSearchBranch;
}

export function refreshBranchAwareBuiltInTools(runtime: AgentRuntimeInternal): void {
  const embeddedSearchEnabled = resolveRuntimeEmbeddedSearchEnabled(runtime);
  // 先按最新分支摘除旧的 Glob/Grep，再整体重注册：registerBuiltInTools 不一定
  // 会覆盖全部旧项，不先 unregister 会让关闭分支后仍残留上一次装配的检索工具。
  if (embeddedSearchEnabled) {
    runtime.registry.unregister("Glob");
    runtime.registry.unregister("Grep");
  }

  // 重装内置工具面。includeSkill/includeAgent 由端口存在性决定：端口缺席时
  // 不注册对应工具，模型也就不会去调用一个没有实现的工具。
  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    embeddedSearchEnabled,
    // 本函数是**第二个**
    // 注册入口，且刻意只传一个精简选项集。对「只有 true 才注册」的门（OffPeak / Cron / Workflow…）
    // 省略是安全的；但动态工作流灰度门的极性相反——「缺席即开启」，省略等于把首次装配剃掉的
    // 十个工具在 shell 快照初始化时原样加回来（registry.register 会覆盖同名项，
    // silentDuplicateWarnings 还把告警吞掉，所以全程无声）。推导因此必须与 runtime-tools.ts
    // 共用同一个 helper，不能在这里重写一遍判断。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime),
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    disallowedTools: runtime.config.toolDisallowlist,
    silentDuplicateWarnings: true,
  });
  // cachedTools 是工具面的缓存事实：registry 已变就必须置空，
  // 否则后续请求继续复用旧工具面，新增/摘除的工具都不会生效。
  runtime.cachedTools = null;
}

export function filterEmbeddedSearchRuntimeVisibleTools(
  runtime: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  // 分支关闭时原样返回：此路径下 registry 仍保留 Glob/Grep，
  // 过滤不能反向隐藏传统工具，否则模型会失去检索能力。
  if (!resolveRuntimeEmbeddedSearchEnabled(runtime)) return tools;
  // 只做"模型可见性"过滤，不改变权限与执行准入：registry 里可能仍有同名工具，
  // 权限判定读的是 registry/权限规则，不依赖这份投影（链路 10 口径）。
  return tools.filter((tool) => tool.name !== "Glob" && tool.name !== "Grep");
}
