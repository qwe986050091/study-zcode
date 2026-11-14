/**
 * conversation-recording-app 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
// 模块清单只描述依赖/导出面，不含运行时逻辑：requires 与 architecture-policy.yaml 必须一致。
export const conversationRecordingAppModule = {
  id: "conversation-recording-app",
  requires: ["zcode-cli"],
  provides: ["conversation-recording-app"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
