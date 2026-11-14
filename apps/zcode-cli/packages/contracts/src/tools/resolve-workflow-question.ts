// ============================================================
// ResolveWorkflowQuestion Tool - 主代理回答 actor 升级上来的阻塞问题
// ============================================================
// 见端口 `DynamicWorkflowRunPort.resolveQuestion`
// （interfaces/dynamic-workflow-run.port.ts）。
//
// 只收 qid 而不收 `(run_id, question_id)` 对：qid 全局唯一（跨 run），多 run 并发时让模型
// 自己配对是错配的温床。失败走 ToolHandlerFailure（core 侧），所以本输出只有成功形。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 工具注册名，同时是权限规则、事件与 UI 投影的判别键；必须与 core handler 注册项一致。
export const RESOLVE_WORKFLOW_QUESTION_TOOL_NAME = "ResolveWorkflowQuestion";

// 回答 workflow run 阻塞问题的入参：只收 question_id 与 answer。qid 全局唯一（跨 run），
// 因此不需要 run_id 配对——多 run 并发时让模型自己配对是错配的温床。strict 让多余字段
// 成为可见错误，避免把 run_id 之类的旧参数混进来。
export const ResolveWorkflowQuestionInputSchema = z
  .object({
    // snake_case 照 GetWorkflowRun 的 run_id / ResumeWorkflowRun 的 run_id：在模型眼里这是
    // 同一族的不透明标识键。
    question_id: z
      .string()
      .min(1)
      .describe(
        "The question ID from the escalation notification, or from GetWorkflowRun's pending questions (looks like `dwfq-...`)",
      ),
    // 回答正文，原样投递给提问的子代理；不做改写，因为它可能包含指令/代码片段。
    answer: z
      .string()
      .min(1)
      .describe("The answer text, delivered verbatim to the subagent that asked"),
  })
  .strict();

// 入参类型；qid 与 answer 都是必填字符串。
export type ResolveWorkflowQuestionInput = z.infer<typeof ResolveWorkflowQuestionInputSchema>;

// provider 可见的入参 schema；描述里点明 qid 形如 dwfq-...，来源可以是升级通知或 run 详情。
export const ResolveWorkflowQuestionInputJsonSchema = toToolJsonSchema(
  ResolveWorkflowQuestionInputSchema,
);

// 成功输出：ok 是字面量 true（失败走 ToolHandlerFailure，不进本 schema），qid 回显这次回答
// 的问题键，response 是给模型的确认文案。全字段必填、无 optional——成功形只有一种。
export const ResolveWorkflowQuestionOutputSchema = z
  .object({
    // 恒为 true；本 schema 只描述成功回答。
    ok: z.literal(true),
    // 被回答的问题 id，原样回显；让模型/UI 确认回答落到了哪个问题。
    qid: z.string().min(1),
    /** 给模型的确认文案（散文不是契约字段，schema 只保证在场）。 */
    response: z.string(),
  })
  .strict();

// 输出类型；handler 用 satisfies 构造。
export type ResolveWorkflowQuestionOutput = z.infer<typeof ResolveWorkflowQuestionOutputSchema>;

// provider 可见的输出 schema，用于跨进程回放校验。
export const ResolveWorkflowQuestionOutputJsonSchema = toToolJsonSchema(
  ResolveWorkflowQuestionOutputSchema,
);
