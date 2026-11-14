// ============================================================
// TaskOutput Tool Handler
// ============================================================
// 定位：读取/等待后台任务（bash、agent、dynamic workflow）的输出。它是 runtime-task 注册表
// 对模型暴露的唯一读取口；投影细节在 task-output-projection.ts，本文件只负责"等多久、
// 给什么状态、标记已通知"。
// 两种模式：`block=false`（默认）立即返回快照；`block=true` 以 100ms 轮询直到任务终态或
// timeout 到期。非阻塞模式下任务仍活跃会返回 `not_ready` 而不是伪造成功。
// 失败/降级：task_id 缺失/不存在 → 业务失败（errorCode 1/2），不是抛错；读文件失败在投影层
// 已降级为空串；外层取消直接抛 AbortError，取消优先于"已拿到结果"。
// 不变量（对应总表 #1 与后台任务通知）：`notified` 只在**投影成功之后**置位——先置位会让
// 一次失败的读取永久吞掉后续 completion notification；置位后同一任务不会被重复通知。
// 副作用：`block=true` 时发一条 ToolCallProgress（展示"正在等"）；更新 registry 的 notified
// 字段（内存态，非 durable）。

import {
  CoreErrorType,
  SessionEventType,
  TASK_OUTPUT_ALIASES,
  TASK_OUTPUT_PROVIDER_DESCRIPTION,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputInputSchema,
  TaskOutputResultSchema,
  TaskOutputResultJsonSchema,
  TaskOutputInputJsonSchema,
  createCoreError,
  type TaskOutputInput,
  type TaskOutputResult,
  type TaskOutputTask,
} from "@zcode/contracts";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import { formatPersistedOutputEnvelope } from "../result-persistence-format.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputValidationContext,
  ToolInputValidationResult,
  ToolPersistedModelContentInput,
} from "../types.js";
import {
  formatCompactFileSize,
  projectTask,
  throwIfAborted,
} from "./task-output-projection.js";

// 口径（字符 vs 字节，别混用）：
// - DEFAULT/MAX_LENGTH：模型可见输出的 **UTF-16 字符**数上限，供 TASK_MAX_OUTPUT_LENGTH
//   环境变量覆盖；默认 32k、硬顶 160k。
// - PERSIST_THRESHOLD_CHARS：`maxModelChars`，超过它就落 artifact，只回预览 + 路径。
// - RESULT_BUDGET_BYTES：结果预算的 UTF-8 字节上界（与字符阈值不同单位，两者都参与判定）。
// - PERSIST_PREVIEW_CHARS：落 artifact 后模型仍能看到的前缀字符数（只看开头够定位）。
// - POLL_INTERVAL_MS：阻塞模式的轮询间隔；100ms 是"响应快但不烧 CPU"的折中。
const TASK_OUTPUT_DEFAULT_LENGTH = 32_000;
const TASK_OUTPUT_MAX_LENGTH = 160_000;
const TASK_OUTPUT_PERSIST_THRESHOLD_CHARS = 100_000;
const TASK_OUTPUT_RESULT_BUDGET_BYTES = 400_000;
const TASK_OUTPUT_PERSIST_PREVIEW_CHARS = 2_000;
const TASK_OUTPUT_POLL_INTERVAL_MS = 100;
const TASK_OUTPUT_ERROR_CODE = {
  TASK_ID_REQUIRED: 1,
  TASK_NOT_FOUND: 2,
} as const;

/**
 * TaskOutput 执行体：可选等待，然后返回检索状态 + 任务投影。
 *
 * 输入：task_id + block（默认 false）+ timeout（仅 block 模式有意义，毫秒）。
 * 输出：`{ retrieval_status, task }`，状态取值：
 *   - `not_ready`：非阻塞模式下任务仍 running/pending（附带当前快照，让模型看到进度）；
 *   - `timeout`：阻塞等到期仍未终态（可能附带快照，也可能 task=null，表示任务在等待中消失）；
 *   - `success`：拿到终态任务（附带投影）。
 * 副作用：block 模式先发一条 ToolCallProgress；终态成功时把该任务标为 notified。
 * 失败语义：入参级错误由 validateInput/内联检查提前返回业务失败；registry 缺席抛配置错误；
 *   取消抛 AbortError（且在标记 notified 之前）。
 * 注意顺序：投影 → 再查一次 abort → 才 markTaskNotified。这个顺序是反直觉的：投影本身
 *   不可中断，若在投影前标记，取消/读失败会吞掉本应出现的完成通知。
 */
const taskOutputHandler: ToolHandler = async (input, context) => {
  const parsed = TaskOutputInputSchema.parse(input) as TaskOutputInput;
  const inputFailure = getTaskOutputInputFailure(parsed, context.runtimeTaskRegistry);
  if (inputFailure) return inputFailure;

  const registry = requireRuntimeTaskRegistry(context);

  const initialTask = registry.get(parsed.task_id);
  if (!initialTask) {
    return taskOutputFailure(
      TASK_OUTPUT_ERROR_CODE.TASK_NOT_FOUND,
      `No task found with ID: ${parsed.task_id}`,
    );
  }

  if (!parsed.block) {
    if (isTaskActive(initialTask.status)) {
      return taskOutputResult("not_ready", await projectTask(initialTask, context));
    }
    const projectedTask = await projectTask(initialTask, context);
    // notified 是完成结果已成功交付的 claim；投影前写入会在读取失败或
    // abort 时吞掉后续 completion notification。异步投影不会被外层取消竞态强制
    // 停止，因此 await 返回后必须再次检查 signal，再提交 claim。
    throwIfAborted(context.abortSignal);
    markTaskNotified(initialTask, context);
    return taskOutputResult("success", projectedTask);
  }

  await emitWaitingProgress(context);
  const task = await waitForTask(parsed.task_id, parsed.timeout, context);
  if (!task) {
    return taskOutputResult("timeout", null);
  }
  if (isTaskActive(task.status)) {
    return taskOutputResult("timeout", await projectTask(task, context));
  }
  const projectedTask = await projectTask(task, context);
  throwIfAborted(context.abortSignal);
  markTaskNotified(task, context);
  return taskOutputResult("success", projectedTask);
};

/**
 * TaskOutput 的工具声明。
 *
 * 口径：`readOnly:true` + `sideEffectScope:"none"`——只读任务输出，但**会**改 registry 的
 *   notified 标志（内存态，不属于对外副作用，因此不影响只读声明）。
 * 预算：策略 `artifact`——大结果落 session 级 artifact，模型只拿预览 + 路径（总表 #4）；
 *   `maxModelChars` 按字符阈值触发落盘，字节预算再兜一层。
 * 超时：`kind:"none"`——等待长度由入参 `timeout` 决定，不叠加工具级墙钟，否则会与
 *   "等 10 分钟的任务"直接冲突；取消由 abort 承担。
 * 兼容：`aliases` 指向历史工具名，旧模型/旧客户端仍能命中同一实现。
 */
export const taskOutputToolEntry: ToolEntry = {
  aliases: TASK_OUTPUT_ALIASES,
  capability: "read output/logs from a background task",
  maxModelChars: TASK_OUTPUT_PERSIST_THRESHOLD_CHARS,
  metadata: {
    shouldDefer: true,
    name: TASK_OUTPUT_TOOL_NAME,
    searchHint: "read output/logs from a background task",
    description: TASK_OUTPUT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskOutputHandler,
  validateInput: validateTaskOutputInput,
  formatModelContent: formatTaskOutputModelContent,
  formatPersistedModelContent: formatPersistedTaskOutputModelContent,
  inputSchema: TaskOutputInputJsonSchema,
  outputSchema: TaskOutputResultJsonSchema,
  runtimeInputSchema: TaskOutputInputSchema,
  runtimeOutputSchema: TaskOutputResultSchema,
  permission: {
    permission: "taskOutput",
    reason: "TaskOutput reads a background task from the current runtime",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    maxModelBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: TASK_OUTPUT_RESULT_BUDGET_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  resultArtifactContentType: "text/plain",
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TaskOutput was cancelled while waiting for the task",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// 业务失败的统一形状：`result:false` + 数字 errorCode，由 call-runner 转成 error tool_result，
// 模型可据此改参数重试（与抛异常不同，后者被视为基础设施故障）。
function taskOutputFailure(errorCode: number, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

// 入参校验钩子：executor 在 hook/权限之前调用。这里用 parse 而非 safeParse 是因为 schema
// 本身已在前一层保证；随后复用 getTaskOutputInputFailure，保证"校验失败"与"handler 内失败"
// 给出完全相同的 code/message，模型不会看到两套口径。
function validateTaskOutputInput(
  input: unknown,
  context: ToolInputValidationContext,
): ToolInputValidationResult {
  const parsed = TaskOutputInputSchema.parse(input) as TaskOutputInput;
  return getTaskOutputInputFailure(parsed, context.runtimeTaskRegistry) ?? { result: true };
}

/**
 * 共享的入参级失败判定：缺 task_id（code 1）或 registry 里查无此任务（code 2）。
 *
 * registry 缺席时**不**报 not found——那是装配问题，留给 requireRuntimeTaskRegistry 抛
 * 配置错误；把"没有 registry"误报成"任务不存在"会诱导模型去改 task_id。
 */
function getTaskOutputInputFailure(
  input: TaskOutputInput,
  registry: ToolInputValidationContext["runtimeTaskRegistry"],
): ToolHandlerFailure | undefined {
  if (!input.task_id) {
    return taskOutputFailure(TASK_OUTPUT_ERROR_CODE.TASK_ID_REQUIRED, "Task ID is required");
  }
  if (registry && !registry.get(input.task_id)) {
    return taskOutputFailure(
      TASK_OUTPUT_ERROR_CODE.TASK_NOT_FOUND,
      `No task found with ID: ${input.task_id}`,
    );
  }
  return undefined;
}

/**
 * 把结果渲染成模型可见的 XML 式文本块。
 *
 * 结构：`<retrieval_status>` 恒在，其余块按 task 是否存在与字段是否存在拼装（空 output 不
 * 输出 `<output>`，避免给模型一个"输出为空"的错误暗示）。
 * 截断口径：只有存在 `outputFile`（真实可回读的完整文件）时才截断并提示"完整输出在路径"；
 * 没有文件时保留原文，交给外层 artifact 机制处理——把 task_id 伪装成可读路径会误导模型。
 * `exitCode` 用 != null 判断，0 是有效退出码，不能被 truthiness 吞掉。
 */
export function formatTaskOutputModelContent(output: unknown): string {
  const parsed = TaskOutputResultSchema.parse(output);
  const blocks = [`<retrieval_status>${parsed.retrieval_status}</retrieval_status>`];
  const task = parsed.task;
  if (task) {
    blocks.push(`<task_id>${task.task_id}</task_id>`);
    blocks.push(`<task_type>${task.task_type}</task_type>`);
    blocks.push(`<status>${task.status}</status>`);
    if (task.exitCode !== undefined && task.exitCode !== null) {
      blocks.push(`<exit_code>${task.exitCode}</exit_code>`);
    }
    if (task.output.trim()) {
      // 没有真实完整文件时，task_id 不是可读取路径，不能把它伪装成
      // “Full output”；此时保留原文，由外层的大结果 artifact 机制继续处理。
      const content = (
        task.outputFile ? truncateTaskOutput(task.output, task.outputFile) : task.output
      ).trimEnd();
      blocks.push(`<output>\n${content}\n</output>`);
    }
    if (task.error) {
      blocks.push(`<error>${task.error}</error>`);
    }
  }
  return blocks.join("\n\n");
}

/**
 * 截断单条任务的可见输出，保留**尾部**（结论通常在最后）。
 *
 * 口径：`maxLength` 是字符数（不是字节），由 `resolveTaskOutputLength` 从环境变量解析，
 * 默认 32000、硬顶 160000。生成的前缀"[Truncated. Full output: <path>]"也计入预算：
 * `tailLength = maxLength - prefix.length` 极端情况下可能 <=0，此时 `slice(-tailLength)`
 * 退化成"从开头切"，可能仍超出预算——这是已知边界，依赖路径长度远小于 32k 的现实假设。
 * 只在确知 outputFile 时调用；没有真实路径就交给 artifact 机制，不伪造"完整输出"。
 */
export function truncateTaskOutput(
  output: string,
  outputPath: string,
  configuredValue = process.env.TASK_MAX_OUTPUT_LENGTH,
): string {
  const maxLength = resolveTaskOutputLength(configuredValue);
  if (output.length <= maxLength) return output;

  const prefix = `[Truncated. Full output: ${outputPath}]\n\n`;
  const tailLength = maxLength - prefix.length;
  return prefix + output.slice(-tailLength);
}

/**
 * 解析 `TASK_MAX_OUTPUT_LENGTH`，返回字符上限。
 *
 * 非法值（空、非数字、<=0）一律回默认 32000 而非报错：这是展示口径，不是安全边界，
 * 为一个坏环境变量让整个 TaskOutput 失败没有收益。合法值再与 160000 取 min，防止有人
 * 用一个超大值把整段日志灌进上下文。
 */
export function resolveTaskOutputLength(
  configuredValue = process.env.TASK_MAX_OUTPUT_LENGTH,
): number {
  if (!configuredValue) return TASK_OUTPUT_DEFAULT_LENGTH;
  const parsed = Number.parseInt(configuredValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return TASK_OUTPUT_DEFAULT_LENGTH;
  return Math.min(parsed, TASK_OUTPUT_MAX_LENGTH);
}

/**
 * 结果已落 artifact 时，给模型看的信封：预览 + 原始大小 + 持久化路径。
 * 复用 task-output-projection 的紧凑大小格式化，保证同一份结果在 UI 与模型侧口径一致。
 * `originalBytes` 这里按字符长度传入（历史口径），只用于信封展示，不参与真实字节预算。
 */
function formatPersistedTaskOutputModelContent(input: ToolPersistedModelContentInput): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatCompactFileSize,
    originalBytes: input.content.length,
    persistedPath: input.persistedPath,
    previewChars: TASK_OUTPUT_PERSIST_PREVIEW_CHARS,
  });
}

/**
 * 阻塞等待任务离开 running/pending，最长 `timeoutMs`。
 *
 * 返回值语义（三种，别只看 truthy）：
 *   - 任务对象且已终态 → 成功路径；
 *   - `undefined` → 轮询中发现任务从 registry 消失（调用方报 timeout + task=null）；
 *   - 超时后**再取一次** registry：可能刚好终态，也可能仍是活跃任务（调用方报 timeout +
 *     当前快照）。最后这一次读取不能省——它把"最后一刻完成"从超时误报里救回来。
 * 取消：每轮先查 abort，取消优先于任何已观察到的完成。
 */
async function waitForTask(
  taskId: string,
  timeoutMs: number,
  context: ToolExecutionContext,
): Promise<RuntimeTaskSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(context.abortSignal);
    const task = context.runtimeTaskRegistry?.get(taskId);
    if (!task) return undefined;
    if (!isTaskActive(task.status)) return task;
    await delay(TASK_OUTPUT_POLL_INTERVAL_MS);
  }
  return context.runtimeTaskRegistry?.get(taskId);
}

// 可被 abort 感知不到的定时器：每轮最多阻塞 100ms，因此取消最坏延迟约 100ms，
// 换来不必为等待单独维护 AbortSignal 监听与清理。
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// 只有 running/pending 算"未就绪"；其它状态（completed/failed/cancelled/lost 等）都算终态，
// 其中 lost 也会走成功路径，因为"任务失联"本身就是要告诉模型的结果。
const isTaskActive = (status: string): boolean => status === "running" || status === "pending";

/**
 * 把任务标为"完成通知已交付"。
 *
 * 用 update + 条件合并保持幂等：已经是 notified 就原样返回，避免触发无意义的状态广播。
 * 必须在投影成功之后调用——这是后台任务通知不被吞掉的唯一保证（见文件头不变量）。
 */
function markTaskNotified(task: RuntimeTaskSnapshot, context: ToolExecutionContext): void {
  context.runtimeTaskRegistry?.update(task.taskId, (current) =>
    current.notified ? current : { ...current, notified: true },
  );
}

/**
 * 阻塞等待前发一条 ToolCallProgress，让 UI 知道这次调用在等而不是卡死。
 *
 * `elapsedMs: 0` 是起点语义（后续进度由外层自己按时间推进）；`sequenceNumber: 0` 是占位，
 * 事件序号由 event store 侧统一分配。没有 emitEvent 端口时静默跳过——展示能力缺失不该
 * 让等待本身失败。
 */
async function emitWaitingProgress(context: ToolExecutionContext): Promise<void> {
  if (!context.emitEvent) return;

  await context.emitEvent({
    id: crypto.randomUUID() as never,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId as never,
      toolName: TASK_OUTPUT_TOOL_NAME,
      elapsedMs: 0,
    },
  });
}

// 构造 `{retrieval_status, task}`：task 允许为 null（超时且任务已消失），
// 但状态码必须恒有值——模型靠它决定是继续等、还是读输出。
function taskOutputResult(
  retrievalStatus: TaskOutputResult["retrieval_status"],
  task: TaskOutputTask | null,
): TaskOutputResult {
  return {
    retrieval_status: retrievalStatus,
    task,
  };
}

// 取 registry 或抛配置错误。返回非空类型，后续调用点不必再判空；
// recoverable:false 表示这是宿主装配问题，重试该工具没有意义。
function requireRuntimeTaskRegistry(context: ToolExecutionContext) {
  const registry = context.runtimeTaskRegistry;
  if (registry) return registry;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    "Runtime task registry is not configured for TaskOutput",
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: TASK_OUTPUT_TOOL_NAME,
      },
      recoverable: false,
    },
  );
}
