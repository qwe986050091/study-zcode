// ============================================================
// ListSavedWorkflows Tool - 枚举本项目保存的 dwf 定义
// ============================================================
//
// 与 ListWorkflowRuns 是**两件事**：那个列的是跑过的 run（历史），这个列的是可以拿来跑的
// 定义（清单）。名字刻意在 "Runs" / "SavedWorkflows" 上分开，因为模型最容易犯的错就是把
// 「有哪些工作流可用」问成「有哪些工作流跑过」。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SavedWorkflowEntrySchema, SavedWorkflowInvalidEntrySchema } from "./saved-workflow.js";

// 工具注册名，同时是权限规则、事件与 UI 投影的判别键；必须与 core handler 注册项的
// metadata.name 一致，改名等于换一个工具。
export const LIST_SAVED_WORKFLOWS_TOOL_NAME = "ListSavedWorkflows";

// 运行时输入 schema：空对象且 strict。刻意没有 cwd，工具恒扫当前会话工作目录；多传字段
// 会在校验层失败而不是被忽略。生产者是模型 tool_call，消费者是 core handler。
export const ListSavedWorkflowsInputSchema = z
  .object({})
  // 与 ListWorkflowRuns 同一条约束：刻意没有 cwd 输入，工具恒扫当前会话的工作目录。
  // 模型无权跨项目扫盘，这同时是 `sideEffectScope: "none"` 成立的前提。
  .strict();

// 运行时推导的输入类型；入参恒为空对象，只用于对齐 handler 签名，不承载业务字段。
export type ListSavedWorkflowsInput = z.infer<typeof ListSavedWorkflowsInputSchema>;

// provider 可见的输入 schema，由空对象 schema 投影；远端校验器据此明确拒绝一切参数。
export const ListSavedWorkflowsInputJsonSchema = toToolJsonSchema(ListSavedWorkflowsInputSchema);

// 输出快照：workflows 是清单，invalid 是"存在但读不出"的文件的指名清单。两者都只含元数据
// 与落点，不含脚本正文——枚举不是读取。快照无分页游标：一个项目的保存定义是低基数实体，
// 一次扫描即可答完；新增/修改后再次调用会拿到新快照，模型不应缓存。
export const ListSavedWorkflowsOutputSchema = z
  .object({
    workflows: z.array(SavedWorkflowEntrySchema),
    /** 读不出来的文件。为空时缺席——一个空数组会让每次调用都挂一个噪音字段。 */
    invalid: z.array(SavedWorkflowInvalidEntrySchema).optional(),
  })
  .strict();

// 输出快照的内部类型；handler 以 satisfies 构造，invalid 为空时会省略该键。
export type ListSavedWorkflowsOutput = z.infer<typeof ListSavedWorkflowsOutputSchema>;

// provider 可见的输出 schema，供回放校验与模型投影；invalid 的可选性在这里与运行时一致。
export const ListSavedWorkflowsOutputJsonSchema = toToolJsonSchema(ListSavedWorkflowsOutputSchema);
