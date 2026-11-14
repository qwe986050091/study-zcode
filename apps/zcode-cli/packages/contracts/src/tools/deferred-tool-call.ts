import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema } from "../model/index.js";

/**
 * 延迟工具调用的包装名：模型先 ToolSearch 发现工具，再用
 * `DeferredToolCall({name, input})` 发起。调度、流式协调器与 executor 必须都经
 * core 的 resolveDeferredToolCall 解析，否则各层会看到不同工具名。
 */
export const DEFERRED_TOOL_CALL_NAME = "DeferredToolCall";
/**
 * 包装入参：`name` 是目标工具的稳定名，`input` 是它的原始入参对象。
 * 两者由模型原样给出，解析时会按目标工具的 schema 再校验一次；
 * 包装层只是二级入口，不携带权限或身份，失败时保留原 call 的包装身份。
 */
export const DeferredToolCallInputSchema = z
  .object({
    name: z.string().min(1),
    input: z.record(z.unknown()),
  })
  .strict();
/** 面对模型的 JSON schema；用 zodToJsonSchema 而非项目投影，保持 record 的开放形状。 */
export const DeferredToolCallInputJsonSchema = zodToJsonSchema(
  DeferredToolCallInputSchema,
) as JsonSchema;

// 原始目标名称与参数由调用本身保存；仅记录还原模型协议所需的包装标记。
/**
 * 包装关系的还原标记：解析成功后真实调用仍保留原 toolCallId 与 traceId，
 * 只把 name/input 换成目标工具，并种下 `modelCallWrapper: "DeferredToolCall"`。
 * 事件、part 与统计据此仍归到同一次模型声明；消费方不得把标记当成真实工具名。
 */
export const ModelCallWrapperSchema = z.literal(DEFERRED_TOOL_CALL_NAME);
/** 包装标记的 TS 类型；恒为字面量 "DeferredToolCall"。 */
export type ModelCallWrapper = z.infer<typeof ModelCallWrapperSchema>;
