/**
 * workflow-tool-entrypoints 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
// 字段口径：id 是架构检查器的模块身份；requires 只依赖 zcode-cli（执行器、registry 与 ToolEntry 类型）；
// provides 是对外能力名；publicEntrypoints 是允许外部导入的稳定路径白名单。
// 注意：白名单里的三个 handler 必须真实存在且保持公开；contract.ts 是类型/schema 入口。
// 副作用：静态元数据，不注册工具；注册由 handlers/index 或示例函数完成。
// 导出常量：managed 模块的静态元数据，供架构检查器读取，不参与运行时注册。
// id 是检查器身份；requires 仅静态依赖名；provides 是能力名；publicEntrypoints 是稳定导入路径白名单。
// 值为 as const 只读字面量，无 IO/事件/持久化；修改 requires 必须同步 architecture-policy.yaml。
export const workflowToolEntrypointsModule = {
  id: "workflow-tool-entrypoints",
  requires: ["zcode-cli"],
  provides: ["workflow-tool-entrypoints"],
  // 三个 handler 对应 contract 里的三个 ToolEntry；移除任一入口都会让迁移调用方失去稳定路径。
  publicEntrypoints: [
    "../handlers/amend-workflow.ts",
    "../handlers/list-models.ts",
    "../handlers/fill-workflow-hole.ts",
    "contract.ts",
  ],
} as const;
