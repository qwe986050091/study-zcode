// ============================================================
// Todo Tools - session task checklist
// ============================================================
// References: session todo and planning tool behavior
// 生产者：core 的 handlers/todo.ts 从 SessionStorePort 读出/整表写回；消费者：模型面文本
// （formatTodoStateForModel）与 UI 进度面板都读同一份列表，trace/事件里不复制正文。
// 语义：TodoWrite 是**整表替换**——传什么就是之后的事实，没传的旧项被丢弃，不是 merge。
// 身份：TodoItem 没有 id 字段，一项的身份就是它在数组里的位置 + content 文本；因此并发
// 整表替换会丢项（handler 声明 concurrentSafe:false），调用方不能指望"按 id 改一条"。
// 不变量：状态只有 pending/in_progress/completed 三值，不允许自定义状态；schema 曾硬限制
// "最多一个 in_progress"，现已放开（多 subagent 并行需要），旧约束以注释形式留在文件内。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

// 待办状态的三个取值：pending（未开始）、in_progress（进行中）、completed（已完成）。
// 字符串是持久化与 UI 的契约；状态的唯一写入方是 TodoWrite 整表输入，runtime 不代改。
export const TodoStatus = {
  Pending: "pending",
  InProgress: "in_progress",
  Completed: "completed",
} as const;

// 状态联合类型；handler 统计 summary 时按这三个值分桶。
export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

// 优先级三档，仅用于 UI 排序/展示，不参与调度：优先级不会改变工具执行顺序或权限。
export const TodoPriority = {
  High: "high",
  Medium: "medium",
  Low: "low",
} as const;

// 优先级联合类型，与 const 对象同源。
export type TodoPriority = (typeof TodoPriority)[keyof typeof TodoPriority];

// 单项契约：content（简短描述，非空）、status、priority 三个必填字段，未声明 id。
// 这里**不是** strict——但也没有额外键可写；新增字段会同时改变持久化形状与 UI，需先更新 spec。
export const TodoItemSchema = z.object({
  content: z.string().min(1).describe("Brief description of the task"),
  status: z.enum(["pending", "in_progress", "completed"]).describe("Current status of the task"),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level of the task"),
});

// 单项的 TS 投影，被 SessionStorePort、handler 与 UI 共享；clone 语义由消费方负责。
export type TodoItem = z.infer<typeof TodoItemSchema>;

// 只读入参：空对象且 strict，防止旧客户端塞入未知字段被静默接受。
export const TodoReadInputSchema = z.object({}).strict();
// TodoRead 入参类型（空对象）。
export type TodoReadInput = z.infer<typeof TodoReadInputSchema>;

// provider 可见 schema：空对象且禁止额外属性。
export const TodoReadInputJsonSchema = toToolJsonSchema(TodoReadInputSchema);

// 读取结果：`todos` 恒为数组（无清单时是空数组而不是 undefined），UI 与模型都能直接遍历。
export interface TodoReadOutput {
  todos: TodoItem[];
}

// executor 侧读取结果校验；空数组是合法值，不等于"读取失败"。
export const TodoReadOutputSchema = z
  .object({
    todos: z.array(TodoItemSchema),
  })
  .strict();

// 已解析（schema 校验通过）的读取结果类型，供从历史 tool_result 内容回读清单时使用。
export type ParsedTodoReadOutput = z.infer<typeof TodoReadOutputSchema>;

// provider/序列化边界上的读取输出 schema。
export const TodoReadOutputJsonSchema = toToolJsonSchema(TodoReadOutputSchema);

// 写入入参：`todos` 是**完整的新列表**（不是增量 patch）。描述里仍提示"最多一个 in_progress"，
// 但校验层已放开（见下方被注释掉的 superRefine 历史）：多 subagent 并行时硬拒绝会让 TodoWrite
// 失败并连带跳过后续调度组。
export const TodoWriteInputSchema = z
  .object({
    todos: z
      .array(TodoItemSchema)
      .describe("The complete updated todo list. At most one item may be in_progress at a time."),
  })
  .strict();
// 多 subagent / 并行任务下需要允许多个 in_progress，旧的 schema 硬拒绝会让
// TodoWrite 失败并触发后续调度组被跳过；先整段注释保留，便于回滚或对比。
// .superRefine((input, context) => {
//   const inProgressCount = input.todos.filter((todo) => todo.status === "in_progress").length;
//   if (inProgressCount <= 1) return;
//   context.addIssue({
//     code: z.ZodIssueCode.custom,
//     message: "At most one todo can be in_progress",
//     path: ["todos"],
//   });
// });

// TodoWrite 入参类型；写回 store 时原样提交这个数组，不做逐项合并。
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

// provider 可见的写入 schema，模型据此知道每次要发送整张表。
export const TodoWriteInputJsonSchema = toToolJsonSchema(TodoWriteInputSchema);

// 状态计数：total 是本次列表长度，其余三项按 status 互斥统计；未知状态不计入任何一类，
// 所以三项之和可能小于 total（schema 已限值，属防御性口径）。
export interface TodoSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

// 写入结果：`oldTodos` 是写前快照（模型/UI 靠它判断"计划是否真的变了"），`todos` 是本次
// 落库的列表，`summary` 是计数。两者都返回是为了省掉一次紧跟其后的 TodoRead。
export interface TodoWriteOutput {
  oldTodos: TodoItem[];
  todos: TodoItem[];
  summary: TodoSummary;
}

// summary 的运行时镜像；四个计数都是非负整数。
export const TodoSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  })
  .strict();

// executor 侧写入结果校验：三个字段都必须存在，`oldTodos` 不能省略（空数组表示"原来没有"）。
export const TodoWriteOutputSchema = z
  .object({
    oldTodos: z.array(TodoItemSchema),
    todos: z.array(TodoItemSchema),
    summary: TodoSummarySchema,
  })
  .strict();

// 已解析的写入结果类型，用于从持久化的 tool_result 内容回读清单。
export type ParsedTodoWriteOutput = z.infer<typeof TodoWriteOutputSchema>;

// 写入输出的 provider/序列化边界 schema。
export const TodoWriteOutputJsonSchema = toToolJsonSchema(TodoWriteOutputSchema);

// 读取调用结构：`traceId` 关联同一条任务链，`startedAt` 供耗时归因；name 是字面量。
export interface TodoReadToolCall {
  id: ToolCallId;
  name: "TodoRead";
  input: TodoReadInput;
  traceId: TraceId;
  startedAt: Date;
}

// 写入调用结构；与读取同形，`name` 用来在事件流里区分两种会话状态操作。
export interface TodoWriteToolCall {
  id: ToolCallId;
  name: "TodoWrite";
  input: TodoWriteInput;
  traceId: TraceId;
  startedAt: Date;
}

// 类型守卫：用于把事件/历史里的工具名收窄到 todo 两种。`undefined` 返回 false，
// 因此可安全用于可选字段；只认精确名，不做前缀或大小写匹配。
export function isTodoToolName(value: string | undefined): value is "TodoRead" | "TodoWrite" {
  return value === "TodoRead" || value === "TodoWrite";
}

// 从一条已完成工具的 modelContent 回读清单：先按 TodoRead 输出试解析，再按 TodoWrite 输出
// 试解析，任一成功即返回**拷贝**（调用方改动不会污染历史记录）。
// 返回 undefined 表示"这段内容不是 todo 结果"或 JSON 不合法——两种情况对调用方等价，
// 由它决定回退到别的来源；这里不抛错，避免把一次回放变成失败。
export function todoItemsFromToolResultContent(content: string): TodoItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  const readResult = TodoReadOutputSchema.safeParse(parsed);
  if (readResult.success) {
    return cloneTodos(readResult.data.todos);
  }

  const writeResult = TodoWriteOutputSchema.safeParse(parsed);
  if (writeResult.success) {
    return cloneTodos(writeResult.data.todos);
  }

  return undefined;
}

// 渲染给模型的待办状态：带 "(authoritative)" 前缀，序号从 1 开始，每行
// `[status][priority] content`。空清单返回空串——不制造一个"当前没有待办"的提示段落，
// 否则每轮都会在提示词里重复一句无信息量的话。
export function formatTodoStateForModel(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return "";
  }

  return [
    "Current session todo state (authoritative):",
    ...todos.map(
      (todo, index) => `${index + 1}. [${todo.status}][${todo.priority}] ${todo.content}`,
    ),
  ].join("\n");
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}
