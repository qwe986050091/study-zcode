// ============================================================
// submit_result Tool - actor terminal structured-result submission
// ============================================================
// 工作流 actor（子 AgentRuntime）用它提交本次 ask 的结构化结果。声明的输入是通用的
// 任意 JSON（单个 `result` 属性）——每个 ask 的具体 schema 不进工具声明，而是随 ask
// 指令消息的 epilogue 下发，以维持 frozen-per-actor 的工具缓存不变式。

// 生产者：core 的 handlers/submit-result.ts（每个 ask 一次转交，阻塞等引擎裁决）；
// 消费者：workflow actor 的模型只看到 provider schema（通用声明或 typed 声明），引擎在
// WorkflowSubmitPort 侧用 per-ask schema 做真正的结构校验。
// 归属不变量：一次提交只属于当前 actor 的当前 ask——`toolCallId` 是引擎与 submit 端口之间
// 的关联键，结果通过 turnControl 结算该 actor 的 turn，不会外溢到兄弟 actor。

import { z } from "zod";
import { TOOL_JSON_SCHEMA_VERSION, toToolJsonSchema } from "./json-schema.js";

// 工具名同时是权限规则 key 与遥测 toolName；actor 侧按它识别"这是终态提交"，改名会破坏
// executor 的结算法则与已持久化的历史行。
export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

// 通用入参契约：对象里只有一个必填 `result`（`unknown`，不约束内部形状），并 `.strict()`。
// 之所以不在这里放 per-ask schema：工具声明要对同一 actor 的所有 ask 保持冻结，才能稳定命中
// provider 的 prompt 缓存；具体形状随 ask 指令的 epilogue 下发，由引擎侧校验。
export const SubmitResultInputSchema = z
  .object({
    // 有意保持通用：不约束 result 的形状。具体 per-ask schema 在 ask 指令 epilogue 里，
    // 由引擎在 WorkflowSubmitPort 侧校验；这样工具声明可跨 ask 冻结、命中 prompt 缓存。
    result: z
      .unknown()
      .describe(
        "The structured result for this ask, matching the JSON schema given in the ask instructions.",
      ),
  })
  .strict();

// handler 与 submit 端口的输入类型；`result` 在此保持 unknown，不做任何业务解释。
export type SubmitResultInput = z.infer<typeof SubmitResultInputSchema>;

// 内建工具表里的通用 provider schema；typed 形态见下面的 typedSubmitResultInputSchema。
export const SubmitResultInputJsonSchema = toToolJsonSchema(SubmitResultInputSchema);

// 构造 typed provider 声明：外层仍是单个必填 `result`、禁止多余键，只是把 per-ask 的结果
// schema 填进 `result` 的位置。它只影响模型可见声明（支持时由 adapter 原生约束），运行时
// zod 校验仍走通用 SubmitResultInputSchema——两条路径的差异是设计，不是遗漏。
/**
 * mono 子代理的 typed 工具声明：`result` 的子 schema 就是该 actor 唯一的 ask 结果 schema。运行时 zod 校验仍是上面的
 * 通用 `SubmitResultInputSchema`——per-ask 形状由引擎在 WorkflowSubmitPort 侧校验，工具声明只是让
 * provider 看到（并在支持时原生约束）它。外层对象与通用声明同形：单个必填 `result`、禁止多余键。
 */
export function typedSubmitResultInputSchema(
  resultSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      result: {
        description: "The structured result for this ask.",
        ...resultSchema,
      },
    },
    required: ["result"],
    additionalProperties: false,
    $schema: TOOL_JSON_SCHEMA_VERSION,
  };
}

// 成功结果的唯一形状：`status` 是字面量 "accepted"，引擎拒绝不会伪装成成功——
// 拒绝路径以 ToolHandlerFailure 走进 error tool_result，模型据此在同一 turn 内修复重试。
// `.strict()` 保证没有第二个键，避免 executor 从额外字段推断出别种结算语义。
export const SubmitResultOutputSchema = z
  .object({
    status: z.literal("accepted"),
  })
  .strict();

// handler 成功路径的返回类型；只有引擎 accept 才能构造出它。
export type SubmitResultOutput = z.infer<typeof SubmitResultOutputSchema>;

// executor 用这份 schema 校验 handler 返回值；目前由 `satisfies` 在编译期已锁住形状，
// 运行时校验是序列化边界上的兜底，不是主要判定。
export const SubmitResultOutputJsonSchema = toToolJsonSchema(SubmitResultOutputSchema);
