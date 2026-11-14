import type { ToolRegistry } from "../registry.js";
import type { ChannelReplyTool } from "./contract.js";

/** 只登记既有 ToolEntry；实际发送仍通过公共工具执行链。 */
// 职责：演示"把外部已构造好的 ReplyToChannel ToolEntry 登记进 registry"的最小写法。
// 注意：它不是生产装配入口（当前无生产代码引用本函数），不要据此认为渠道工具由本文件注册。
// 口径：entry 必须是完整 ToolEntry；本函数不做 schema 校验、不改 metadata、不包装 handler。
// 副作用：registry.register 对同名工具是覆盖并 console.warn；注册还会清理/重建别名映射。
// 失败语义：不抛错也不吞错——重复注册只告警，调用方需自行保证装配幂等。
export function exampleChannelReplyTool(
  registry: Pick<ToolRegistry, "register">,
  entry: ChannelReplyTool,
): void {
  registry.register(entry);
}
