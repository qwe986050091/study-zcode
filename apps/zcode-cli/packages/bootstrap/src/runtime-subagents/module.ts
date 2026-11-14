/**
 * cli-subagent-config 模块清单（architecture-governance managed 模块）。
 * 层：domain。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
// 模块清单只描述依赖/导出面；requires 为 shared，运行时由独立 CLI 侧 loader 注入配置。
export const cliSubagentConfigModule = {
  id: "cli-subagent-config",
  requires: ["shared"],
  provides: ["cli-subagent-config"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
