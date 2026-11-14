// ============================================================
// escalate Tool - actor 把阻塞问题升级给主代理
// ============================================================
// 与 `submit_result` 完全同构地注入 actor 会话
// （端口在场即注册、`tools:"none"` 下仍由 core 补回），但两者结算的是不同的东西：
// submit 结算**这次 ask 的结果**，escalate 结算**一次问答**。
//
// 输出形状刻意是「带判别位的扁平对象」而不是 union：两支都是普通工具结果（不是错误），
// 模型读到的只有一段文本，判别位 `status` 只服务日志与结果投影。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

/**
 * 工具名常量：workflow actor 会话按它注入（端口在场即注册，`tools:"none"` 下由 core 补回），
 * 也是升级问题与 submit_result 共用注入机制中的另一个入口名。
 */
export const ESCALATE_TOOL_NAME = "escalate";

/**
 * 升级入参：`question` 必须是单个聚焦、可一句话回答的问题；`context` 是已经试过什么、
 * 卡在哪里的证据。一次调用只结一次问答，多问会拆成多次调用；两条文本都进主代理可见面。
 */
export const EscalateInputSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .describe(
        "The single focused question that unblocks you. One question per call, answerable in a sentence.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "What you already tried and where exactly you are stuck — the evidence the answerer needs.",
      ),
  })
  .strict();

/** 升级入参的 TS 视图；context 可缺席，表示没有额外证据可给。 */
export type EscalateInput = z.infer<typeof EscalateInputSchema>;

/** 面对模型的 JSON schema；handler 还会在运行时把 question 交给升级端口排队。 */
export const EscalateInputJsonSchema = toToolJsonSchema(EscalateInputSchema);

/**
 * 一次升级的结局。
 *
 * - `answered`：`message` 是主代理给出的答案原文，`qid` 是这次问答的全局唯一 id。
 * - `refused`：`message` 是陈述现状与下一步的文案（预算已尽 / 无在飞 ask），`reason` 是
 *   判别键。**这不是错误**——把「预算已尽」渲染成 error tool_result 会让模型当成可重试的
 *   故障，反复撞同一堵墙，而那正是本特性要消灭的行为。
 */
export const EscalateOutputSchema = z
  .object({
    status: z.enum(["answered", "refused"]),
    message: z.string(),
    /** `answered` 才在场。 */
    qid: z.string().optional(),
    /** `refused` 才在场。 */
    reason: z.enum(["budget_exhausted", "no_active_ask"]).optional(),
  })
  .strict();

/** 升级输出的 TS 视图；answered 时 qid 在场，refused 时 reason 在场，二者按 status 收窄。 */
export type EscalateOutput = z.infer<typeof EscalateOutputSchema>;

/**
 * 面对模型的 JSON schema；`refused` 仍是普通工具结果而非错误，这样模型不会把
 * “预算已尽/无在飞 ask”当成可重试故障反复撞墙。
 */
export const EscalateOutputJsonSchema = toToolJsonSchema(EscalateOutputSchema);
