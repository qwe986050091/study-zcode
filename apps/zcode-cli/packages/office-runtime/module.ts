/**
 * office-runtime 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 本文件只描述模块边界，不含运行时代码；id 与 provides 同名表示该模块自洽、不对外暴露子能力。
 */
// 模块声明对象：id 是架构检查使用的稳定标识，requires 为依赖模块列表（空表示不依赖同仓其他模块），
// provides 为对外能力名，publicEntrypoints 是允许跨包导入的入口文件集合。后两项改动必须同步调用方与架构策略。
export const officeRuntimeModule = {
  id: "office-runtime",
  requires: [],
  provides: ["office-runtime"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
