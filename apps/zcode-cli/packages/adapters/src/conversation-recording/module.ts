/*
 * ============================================================
 * conversation-recording / module.ts —— 架构治理模块清单
 *
 * 定位：向 architecture-governance 声明本模块的依赖与公开入口，不承载运行逻辑。
 * 输入输出：静态导出常量；requires/provides/publicEntrypoints 必须与
 * architecture-policy.yaml 保持一致，检查器会校验两者。
 * 副作用：无（纯常量）。
 * 失败语义：无运行时失败路径；声明漂移由架构检查命令报错。
 * 不变量：publicEntrypoints 只暴露 index.ts 与 contract.ts，内部实现文件不算公开面。
 * ============================================================
 */
/**
 * conversation-recording 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const conversationRecordingModule = {
  id: "conversation-recording",
  requires: ["zcode-cli"],
  provides: ["conversation-recording"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
