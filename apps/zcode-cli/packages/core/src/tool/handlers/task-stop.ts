// ============================================================
// TaskStop Tool Handler
// ============================================================
// 定位：终止一个正在运行的后台任务（bash / agent / workflow run），是 TaskOutput 与
// BackgroundTask 通知链路的对偶操作。
// 职责：解析 task_id（兼容旧的 shell_id）→ 检查 BackgroundTaskControlPort → 调用
//   stopBackgroundTask(strict:true) → 把结果映射成 TaskStopOutput 或可预期业务失败。
// 副作用：请求 runtime 终止任务；任务自己的终态通知由端口发出（initiator="model" 决定措辞）。
// 失败语义：四类失败都抛 ToolExecutionFailed（recoverable:true，模型可改 ID 重试）：
//   缺参(1)、不支持取消(1)、任务存在但不在运行(3)、ID 查无此任务(1)。
// 不变量：strict:true = 不做 ID 前缀/模糊匹配；"查找失败"绝不表述成"已停止"，否则模型会
//   把一次没生效的停止当成成功。

import {
  CoreErrorType,
  TASK_STOP_TOOL_NAME,
  TaskStopInputJsonSchema,
  TaskStopInputSchema,
  TaskStopOutputJsonSchema,
  TaskStopOutputSchema,
  createCoreError,
  type TaskStopInput,
  type TaskStopOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

// 模型可见结果的字节上限（inline/model/preview 共用）。输出只有一行 message + 少量字段，
// 100KB 只与同类任务工具对齐，不构成实际约束。
const MAX_TASK_STOP_MODEL_BYTES = 100_000;
// 查找失败时附带的解释：模型很容易把"找不到 ID"读成"任务已经结束"，
// 这句话明说两者不等价，并要求使用任务启动时返回的完整 ID。
const TASK_STOP_LOOKUP_FAILURE_GUIDANCE =
  "This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.";

// provider 请求直接使用 metadata.description，内部短说明会让模型看不到
// 参数、返回值和使用时机。capability 继续保留短说明。
const TASK_STOP_PROVIDER_DESCRIPTION = [
  "",
  "- Stops a running background task by its ID",
  "- Takes a task_id parameter identifying the task to stop",
  "- Returns a success or failure status",
  "- Use this tool when you need to terminate a long-running task",
  "",
].join("\n");

/**
 * 停止后台任务。
 *
 * 输入：task_id（旧字段 shell_id 作为别名同受支持）；两者都缺 → code 1 业务失败。
 * 输出：`{message, task_id, task_type, command?}`；task_type 在端口不返回时回落
 *   "background_task"，避免模型看到 undefined。
 * 副作用：通过控制端口终止任务，并触发其终态通知；本 handler 不等待任务进程真正退出
 *   （端口的 stop 返回即视为已受理）。
 * 失败语义：端口缺席 → 不可恢复配置错误；其余为可恢复业务失败，code 3 专指"任务存在但
 *   不在运行"，让模型能区分"已经结束"与"ID 打错"。
 */
const taskStopHandler: ToolHandler = async (input, context) => {
  const parsed = TaskStopInputSchema.parse(input) as TaskStopInput;
  const taskId = parsed.task_id ?? parsed.shell_id;
  if (!taskId) {
    throw taskStopError("Missing required parameter: task_id", 1, {
      toolCallId: context.toolCallId,
    });
  }

  if (!context.backgroundTaskControlPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Background task control is not configured for TaskStop",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: TASK_STOP_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const result = await context.backgroundTaskControlPort.stopBackgroundTask(taskId, {
    // 模型自己停的：终态通知会说「stopped by you」，而不是把它写成用户的决定。
    initiator: "model",
    strict: true,
    traceContext: context.traceContext,
  });
  if (!result.ok) {
    if (result.reason === "background_task_not_running") {
      throw taskStopError(
        `Task ${taskId} is not running (status: ${result.status ?? "unknown"})`,
        3,
        {
          status: result.status,
          taskId,
          taskType: result.type,
          toolCallId: context.toolCallId,
        },
      );
    }
    if (result.reason === "background_task_cancel_not_supported") {
      throw taskStopError(`Task ${taskId} cannot be stopped`, 1, {
        reason: result.reason,
        status: result.status,
        taskId,
        taskType: result.type,
        toolCallId: context.toolCallId,
      });
    }
    // 单纯提示未找到任务容易被模型误读为已停止；明确查找失败不代表终态，并要求使用完整 ID。
    throw taskStopError(`Invalid task ID "${taskId}". ${TASK_STOP_LOOKUP_FAILURE_GUIDANCE}`, 1, {
      reason: result.reason,
      taskId,
      taskType: result.type,
      toolCallId: context.toolCallId,
    });
  }

  const taskType = result.type ?? "background_task";
  const output: TaskStopOutput = {
    message: `Successfully stopped task: ${result.taskId} (${result.command ?? taskType})`,
    task_id: result.taskId,
    task_type: taskType,
    ...(result.command ? { command: result.command } : {}),
  };
  return output;
};

/**
 * TaskStop 的工具声明。
 *
 * aliases：KillShell / KillBash 是历史名字，保留它们让旧模型与旧客户端不用改 prompt 即可命中。
 * 口径：`concurrentSafe:true`（停不同任务互不影响）、`sideEffectScope:"session"`（只作用于
 *   当前 runtime 的后台任务）、无需审批（停止自己启动的任务是低风险自愈动作）。
 * 预算/超时：100KB + 10s 固定；stop 是控制面操作，不该被大输出或长等待拖住。
 */
export const taskStopToolEntry: ToolEntry = {
  aliases: ["KillShell", "KillBash"],
  capability: "Stop a running background task by ID",
  metadata: {
    shouldDefer: true,
    name: TASK_STOP_TOOL_NAME,
    searchHint: "kill a running background task",
    description: TASK_STOP_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10000,
    maxOutputBytes: MAX_TASK_STOP_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskStopHandler,
  formatModelContent: formatTaskStopModelContent,
  inputSchema: TaskStopInputJsonSchema,
  outputSchema: TaskStopOutputJsonSchema,
  runtimeInputSchema: TaskStopInputSchema,
  runtimeOutputSchema: TaskStopOutputSchema,
  permission: {
    permission: "backgroundTask.stop",
    reason: "TaskStop stops a running background task in the current runtime",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TASK_STOP_MODEL_BYTES,
    maxModelBytes: MAX_TASK_STOP_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TASK_STOP_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10000,
    maxMs: 10000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TaskStop was cancelled before the stop request completed",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// 成功结果以紧凑 JSON 回给模型：字段少且稳定，JSON 比自由文本更利于模型精确引用 task_id。
function formatTaskStopModelContent(output: unknown): string {
  return JSON.stringify(TaskStopOutputSchema.parse(output));
}

/**
 * 构造可恢复的工具失败。
 *
 * code 口径：1 = 参数/能力问题（缺 ID、该任务类型不支持取消、查无此任务）；3 = 任务存在
 *   但当前不在运行。数字码与 message 同时给出，模型与调用方都能不靠文本判断。
 * `recoverable:true` 表示改参数/换 ID 后重试有意义；真正的装配错误不经过这里。
 */
function taskStopError(message: string, code: 1 | 3, context: Record<string, unknown>): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    context: {
      ...context,
      code,
      toolName: TASK_STOP_TOOL_NAME,
    },
    recoverable: true,
  });
}
