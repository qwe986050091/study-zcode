/**
 * channel-reply-tool 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
// 字段口径：id 是架构检查器的模块身份（必须与 architecture-policy.yaml 条目一致）；
// requires 声明跨模块依赖（shared 提供 schema，zcode-cli 提供 ToolEntry 与执行器）；
// provides 是对外能力名；publicEntrypoints 是允许外部导入的稳定路径白名单。
// 注意：白名单同时列 handler 与 contract —— 迁移时可以改实现路径，但不能把两者移出白名单，
// 否则架构检查会判为跨模块直连内部实现。
// 副作用：本对象只是静态元数据，不注册工具；真正注册由 handlers/index 或示例函数完成。
export const channelReplyToolModule = {
  id: "channel-reply-tool",
  requires: ["shared", "zcode-cli"],
  provides: ["channel-reply-tool"],
  // handler 是既有工具实现入口，contract.ts 是 schema/类型入口；两者都允许外部导入。
  publicEntrypoints: ["../handlers/reply-to-channel.ts", "contract.ts"],
} as const;
