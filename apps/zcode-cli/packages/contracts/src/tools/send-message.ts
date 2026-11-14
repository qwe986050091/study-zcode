// ============================================================
// SendMessage Tool 契约 - 主代理与本地子代理之间的显式文字通道
// ============================================================
// 生产者：core 的 handlers/send-message.ts 用 SendMessageInputSchema 做运行时校验，再交给
// SubagentPort 投递；消费者：provider 只看到 SendMessageInputJsonSchema（模型边界），executor
// 用 SendMessageOutputSchema 校验端口返回值并据此生成模型可见文案。
// 存在理由：子代理的普通文本输出不会回流给调用方，跨 agent 的每句话都必须成为一次工具调用。
// 不变量：`to` 必须是 Agent 工具返回的 `agent_<uuid>`；正文 20000 字符上限在 schema 层拦截，
// 端口侧不再二次截断，避免出现"提示投递成功、实际只送达一半"的分裂事实。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 工具在 registry、权限规则、hook matcher 与遥测里共用的名字。改名要四处同步，
// 否则历史权限记忆与审计记录会和实现失去关联。
export const SEND_MESSAGE_TOOL_NAME = "SendMessage";
// 单条消息正文的 UTF-16 字符上限（20k）。入参 schema 与 provider JSON schema 同一数值，
// 模型侧越界会在解析阶段被拒，不会走到端口。
export const SEND_MESSAGE_MAX_CONTENT_CHARS = 20_000;

// 模型入参的运行时契约（`.strict()`：未知键直接判非法，不做静默丢弃）。`to` 是目标本地
// agent 的 ID，寻址解析与投递重试由 SubagentPort 负责，本 schema 只固定形状与长度。
// `summary` 是 UI 预览用的 5~10 词短句，与正文分开存放，避免客户端为了预览而截正文。
export const SendMessageInputSchema = z
  .object({
    to: z
      .string()
      .min(1)
      .max(200)
      .describe("Recipient: local agent ID returned by Agent (format agent_<uuid>)."),
    summary: z
      .string()
      .min(1)
      .max(200)
      .describe("A 5-10 word summary shown as a preview in the UI."),
    message: z
      .string()
      .min(1)
      .max(SEND_MESSAGE_MAX_CONTENT_CHARS)
      .describe("Plain text message content"),
  })
  .strict();

// handler 与端口之间传递的输入类型，字段与上面的 schema 一一对应（无派生字段）。
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

// provider 可见的 JSON schema：由运行时 schema 机械转换而来，两者不手写分离，
// 保证模型看到的约束与执行侧校验永远同源。
export const SendMessageInputJsonSchema = toToolJsonSchema(SendMessageInputSchema);

// 投递结果契约：`status` 只有 success/failed 两种，把"没送达"和"调用本身出错"分开——
// 后者走 ConfigurationError，不会以本形状返回。`messageId` 每次投递恒有，供日志与 UI 关联；
// `agentId` 与 `taskId` 二选一（任务式投递可能没有 agentId），文案层用二者兜底。
// `delivery` 只在成功时出现：queued（入队等待）、steered（插入正在运行的 agent）、
// resumed_background（重启已完成 agent 的后台运行）；缺席时文案按 queued 表述。
export const SendMessageOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    messageId: z.string(),
    agentId: z.string().optional(),
    delivery: z.enum(["queued", "steered", "resumed_background"]).optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    outputFile: z.string().optional(),
    taskId: z.string().optional(),
  })
  .strict();

// 端口返回值的 TypeScript 投影，handler 以 `satisfies` 约束端口实现，避免两侧字段漂移。
export type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

// 输出侧 JSON schema 目前只用于契约对齐/测试；模型可见文本由 handler 的 formatModelContent
// 生成，不走这份 schema 直接序列化。
export const SendMessageOutputJsonSchema = toToolJsonSchema(SendMessageOutputSchema);
