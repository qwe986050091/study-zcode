// ============================================================
// Todo Tool Handlers
// ============================================================
// 定位：会话级任务清单（todo list）的读写工具。清单是模型给自己看的工作计划，也是用户看到
// 的进度面板；它只存在于 sessionStore，不进模型消息历史、不落工作区。
// 语义：TodoWrite 是**全量替换**（每次必须传完整列表），不是增量 patch；TodoRead 只读。
// 失败：SessionStorePort 缺席 → ConfigurationError（不可恢复装配错误）；store 读写异常向上
// 冒泡，由 executor 转成 error tool_result。
// 不变量：写之前先读 oldTodos 并随结果返回——模型与 UI 都靠这份 diff 判断"计划是否真的变了"；
// 列表里的状态取值只有 pending/in_progress/completed，不允许自定义状态。

import {
  CoreErrorType,
  TodoReadInputJsonSchema,
  TodoReadInputSchema,
  TodoReadOutputJsonSchema,
  TodoReadOutputSchema,
  TodoWriteInputJsonSchema,
  TodoWriteInputSchema,
  TodoWriteOutputJsonSchema,
  TodoWriteOutputSchema,
  createCoreError,
  type TodoItem,
  type TodoReadOutput,
  type TodoWriteInput,
  type TodoWriteOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

// 模型可见结果的字节上限（inline/model/preview 共用）。清单通常只有十几条，
// 100KB 只是与同类会话内工具对齐的上界。
const MAX_TODO_MODEL_BYTES = 100_000;

/**
 * 读取当前会话清单。
 *
 * 输入：空对象（仍 parse 一次，防止未知字段被静默接受）。
 * 输出：`{ todos }`，store 原样返回（空清单由 store 决定是 [] 还是 undefined）。
 * 副作用：无；失败：store 缺席抛不可恢复配置错误，读取异常向上冒泡。
 */
export const todoReadHandler: ToolHandler = async (input, context) => {
  TodoReadInputSchema.parse(input);

  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for TodoRead",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "TodoRead",
        },
        recoverable: false,
      },
    );
  }

  return {
    todos: await context.sessionStore.readTodos({ sessionID: context.sessionId }),
  } satisfies TodoReadOutput;
};

/**
 * 全量替换当前会话清单。
 *
 * 输入：`{ todos }`，每个元素含 content/status/priority；本次列表就是之后的事实，
 *   没传的旧项会被丢弃（不是合并）。
 * 输出：`{ oldTodos, todos, summary }`——oldTodos 供模型自检"我改了什么"，
 *   summary 是各状态计数，避免模型为了统计再读一遍。
 * 副作用：写 sessionStore（durable，随会话恢复）；先读后写，读失败时不会留下半更新状态。
 * 失败：store 缺席/读写异常的处理与 TodoRead 相同。
 */
export const todoWriteHandler: ToolHandler = async (input, context) => {
  const { todos } = TodoWriteInputSchema.parse(input) as TodoWriteInput;

  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for TodoWrite",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "TodoWrite",
        },
        recoverable: false,
      },
    );
  }

  const oldTodos = await context.sessionStore.readTodos({ sessionID: context.sessionId });
  await context.sessionStore.updateTodos({ sessionID: context.sessionId, todos });

  return {
    oldTodos,
    todos,
    summary: summarizeTodos(todos),
  } satisfies TodoWriteOutput;
};

/**
 * TodoRead 的工具声明。
 *
 * 口径：readOnly / sideEffectScope:"none" / 无需审批——只读会话状态，不产生外部副作用。
 * 预算与超时：100KB + 30s，均不可覆盖；只记摘要而不记录完整清单内容（清单可能含用户
 *   未公开的计划）。
 */
export const todoReadToolEntry: ToolEntry = {
  capability: "Read the current session todo list without modifying external state",
  metadata: {
    shouldDefer: true,
    name: "TodoRead",
    description: "Read the current session todo list",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_TODO_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: todoReadHandler,
  inputSchema: TodoReadInputJsonSchema,
  outputSchema: TodoReadOutputJsonSchema,
  runtimeInputSchema: TodoReadInputSchema,
  runtimeOutputSchema: TodoReadOutputSchema,
  permission: {
    permission: "todo.read",
    reason: "TodoRead only reads session-local task state",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TODO_MODEL_BYTES,
    maxModelBytes: MAX_TODO_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TODO_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TodoRead was cancelled before todo state was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/**
 * TodoWrite 的工具声明。
 *
 * 反直觉：`readOnly:true` 但确实会改状态。这里的 readOnly 指"不产生工作区/外部副作用"
 *   （权限、sandbox、并发判定用），真正的写入落在 session 作用域，由 `sideEffectScope:"session"`
 *   与 `permission:"todo.write"` 表达；preview 类能力（如文件 diff）不适用。
 * 并发：`concurrentSafe:false`——两次全量替换交错会产生丢项，必须串行。
 */
export const todoWriteToolEntry: ToolEntry = {
  capability:
    "Replace the current session todo list to track multi-step task progress and resume state",
  metadata: {
    shouldDefer: true,
    name: "TodoWrite",
    searchHint: "manage the session task checklist",
    description: `Create and update a task list for the current session. The list is rendered to the user as your working plan.

- Each todo has \`content\`, \`status\` ("pending" | "in_progress" | "completed"), and \`priority\` ("high" | "medium" | "low").
- Send the full list each call; it replaces the previous one.
- Keep one item \`in_progress\` at a time and mark it \`completed\` when done.`,
    readOnly: true,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_TODO_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: todoWriteHandler,
  inputSchema: TodoWriteInputJsonSchema,
  outputSchema: TodoWriteOutputJsonSchema,
  runtimeInputSchema: TodoWriteInputSchema,
  runtimeOutputSchema: TodoWriteOutputSchema,
  permission: {
    permission: "todo.write",
    reason: "TodoWrite only updates session-local task state for progress tracking",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TODO_MODEL_BYTES,
    maxModelBytes: MAX_TODO_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TODO_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TodoWrite was cancelled before todo state was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// 计数口径：total 是本次列表长度，其余三个按 status 互斥统计；未知状态不计入任何一类，
// 因此 pending+inProgress+completed 可能小于 total（schema 已限制取值，属于防御性写法）。
function summarizeTodos(todos: TodoItem[]) {
  return {
    total: todos.length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    completed: todos.filter((todo) => todo.status === "completed").length,
  };
}
