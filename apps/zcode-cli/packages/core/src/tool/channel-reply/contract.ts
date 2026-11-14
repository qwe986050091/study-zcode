import type { ToolEntry } from "../types.js";
// schema 口径：输入/结果 schema 直接再导出 @zcode/shared 的定义，执行器 validation 阶段读的就是这一份；
// 本文件不得新增第二份 schema，否则同一工具会出现两套真相。
export { channelReplyPartsSchema, channelReplyResultSchema } from "@zcode/shared";

/** 复用原工具入口；执行输入绑定、发送、取消和错误继续由 handler 与 Host 端口负责。 */
// 本文件只做类型/schema 再导出，不新增运行时行为，也不复制工具配置（权限、超时、结果预算仍属原 ToolEntry）。
// 输入输出校验由 @zcode/shared 的两个 schema 承担，因此这里不写 parse/validate 逻辑。
// ChannelReplyTool 是 ToolEntry 的别名而非新接口：deferred 分类、只读/并发属性、取消语义全部沿用原声明。
// 失败语义：注册、绑定、发送失败都发生在 handler 与 Host 端口层，本层不捕获、不降级。
// 维护不变量：公开导入路径必须稳定，调用方不应绕过 contract 直接 import handler 内部实现。
export type ChannelReplyTool = ToolEntry;
