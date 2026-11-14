// ============================================================
// Agent Tool - Subagent orchestration tool
// ============================================================
// 支持基于配置的子代理和异步启动。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import type { ModelUsage } from "../model/index.js";
import { toToolJsonSchema } from "./json-schema.js";

/**
 * 内置子代理类型常量：`general-purpose` 与 `Explore`。它们只是字符串上的约定，
 * 实际可用的类型来自 Settings/Markdown profile，未知类型由 core 报 UNKNOWN_AGENT_TYPE。
 */
export const AgentType = {
  GeneralPurpose: "general-purpose",
  Explore: "Explore",
} as const;

/**
 * 子代理类型是开放字符串而非枚举：profile 可来自设置/技能/插件，契约层不能把
 * 已知集合写死；校验发生在 core 的子代理注册表，未知值返回结构化失败。
 */
export type AgentType = string;

/**
 * Agent 入参：`description` 是 3-5 词的展示标签，`prompt` 是子代理的完整任务，
 * `subagent_type` 缺省走默认代理，`run_in_background` 只决定同步等待还是先回 task 信息。
 * 刻意不接受调用级 model：子代理模型由 Settings/profile 统一决定，否则历史 tool call
 * 会持续携带旧 override 覆盖当前配置。
 */
export const AgentInputSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .optional()
    .describe("The type of specialized agent to use for this task"),
  // subagent 模型由 Settings / Markdown profile 统一决定；若把调用级
  // model 暴露给父模型，历史 tool call 会持续生成旧 override 并覆盖当前配置。
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set to true to run this agent in the background. You will be notified when it completes.",
    ),
});

/** 归一化后的子代理入参；`run_in_background` 缺席等价于前台执行。 */
export type AgentInput = z.infer<typeof AgentInputSchema>;

/** 面对模型的 JSON schema；四个字段均为字符串/布尔，provider 侧无需额外约束。 */
export const AgentInputJsonSchema = toToolJsonSchema(AgentInputSchema);

/** 子代理返回给父代理的文本块；目前只有 text，未来扩展需保持 content 数组形状。 */
export interface AgentTextContentBlock {
  type: "text";
  text: string;
}

/**
 * 前台子代理的完成结果：`status: "completed"` 是判别位，`agentId` 是子代理实例的稳定键
 * （通知/审计/关联父调用都以它为准）；`content` 是子代理最终文本，`totalToolUseCount`/
 * `totalDurationMs`/`totalTokens` 是汇总遥测，`usage` 只在有模型用量时出现。
 */
export interface AgentCompletedOutput {
  status: "completed";
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
}

/**
 * 后台子代理的启动结果：`status: "async_launched"` 且 `isAsync: true` 是判别位。
 * `agentId` 是子代理实例键，`childSessionId` 是子会话恢复键，`backgroundTaskId` 是
 * 任务通知/TaskOutput 的键；三者不能互相顶替。`outputFile` 是增量输出落点，
 * `canReadOutputFile` 只决定模型是否被允许去读（false 时应等通知而不是硬读）。
 */
export interface AgentBackgroundedOutput {
  status: "async_launched";
  isAsync: true;
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  childSessionId: string;
  backgroundTaskId: string;
  outputFile: string;
  canReadOutputFile: boolean;
}

/**
 * Agent 的两态输出联合：前台完成或后台已启动。消费方按 `status` 判别，
 * 不允许出现既无正文又无后台句柄的中间态。
 */
export type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput;

/** 文本块的运行时 schema；`.strict()` 拒绝未知块类型，避免前端静默丢弃内容。 */
export const AgentTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

/**
 * 前台完成态的运行时校验：计数非负，`usage` 是 provider 原始用量对象（逐 provider 形状不一，
 * 故不收窄字段）；校验失败视为 handler 违约而非业务失败。
 */
export const AgentCompletedOutputSchema = z
  .object({
    status: z.literal("completed"),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    content: z.array(AgentTextContentBlockSchema),
    totalToolUseCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    usage: z.record(z.unknown()).optional(),
  })
  .strict();

/** 后台启动态的运行时校验：`isAsync` 钉死为 true，防止前台结果冒充后台句柄。 */
export const AgentBackgroundedOutputSchema = z
  .object({
    status: z.literal("async_launched"),
    isAsync: z.literal(true),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    childSessionId: z.string(),
    backgroundTaskId: z.string(),
    outputFile: z.string(),
    canReadOutputFile: z.boolean(),
  })
  .strict();

/** 输出联合的运行时校验；两支互斥，按 status 收窄。 */
export const AgentOutputSchema = z.union([
  AgentCompletedOutputSchema,
  AgentBackgroundedOutputSchema,
]);

/** 面对模型的 JSON schema；union 投影为 anyOf，客户端按 status 判别（core 输出仍逐支校验）。 */
export const AgentOutputJsonSchema = toToolJsonSchema(AgentOutputSchema);

/**
 * Agent 调用身份：`id` 是 toolCallId，`traceId` 是父子会话共享的顶层 trace；
 * 子代理事件必须带上这两个键，才能把后台完成通知归回原调用。
 */
export interface AgentToolCall {
  id: ToolCallId;
  name: "Agent";
  input: AgentInput;
  traceId: TraceId;
  startedAt: Date;
}

/** Agent 结算：`toolCallId` 回指父调用，`durationMs` 对后台模式只计到启动完成，不等到子代理结束。 */
export interface AgentToolResult {
  toolCallId: ToolCallId;
  output: AgentOutput;
  traceId: TraceId;
  durationMs: number;
}

/**
 * Agent 的结构化错误码：子代理端口缺失、后台模式不可用、类型未知、子运行时失败。
 * 它们由 core 的 handler 返回，文案可读但判别只看字符串码；失败时仍保留调用身份。
 */
export const AgentErrorCode = {
  SUBAGENT_UNAVAILABLE: "agent_subagent_unavailable",
  BACKGROUND_UNAVAILABLE: "agent_background_unavailable",
  UNKNOWN_AGENT_TYPE: "agent_unknown_type",
  CHILD_RUNTIME_FAILED: "agent_child_runtime_failed",
} as const;

/** AgentErrorCode 的值联合；跨进程记录时保持字符串原样。 */
export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
