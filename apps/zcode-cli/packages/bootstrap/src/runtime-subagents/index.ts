import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
  resolveSubagentRuntimeProfiles,
  type SubagentRuntimeConfig,
} from "@zcode/shared";

/** 独立 CLI 的磁盘 loader 复用共享纯解析器，保留原文件配置来源。 */
import type { RuntimeSubagentConfiguration } from "./contract.js";

export function parseRuntimeSubagentConfig(configuration: RuntimeSubagentConfiguration) {
  const profiles: AgentProfile[] = [];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const document of configuration.documents) {
    const result = parseAgentProfileFromMarkdown(document);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (!result.profile) continue;
    profiles.push(
      document.namespace
        ? { ...result.profile, name: `${document.namespace}/${result.profile.name}` }
        : result.profile,
    );
  }
  return {
    ...resolveSubagentRuntimeProfiles(profiles, configuration.state),
    diagnostics,
  };
}

// Host 完成后（kind === "ready"）直接透传快照；非 ready 时返回完全空集而不是上一次结果，
// 因为子代理配置解析失败若沿用旧模板，会把过期 profile 当成当前事实执行。
// 空集的三项必须与 ready 结果同形，调用方才能无分支地继续装配。
/** Host 已完成纯解析；失败回退不能混入旧模板或磁盘覆盖。 */
export function subagentProfilesFromSnapshot(snapshot: SubagentRuntimeConfig) {
  return snapshot.kind === "ready"
    ? snapshot
    : {
        profiles: [],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      };
}
