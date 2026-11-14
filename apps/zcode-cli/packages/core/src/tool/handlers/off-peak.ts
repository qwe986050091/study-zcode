// INV-01 闲时拒绝边界是本轮 offPeakTurn，不是 automation 轮：守住位置 assertNotOffPeakTurn；改错故障 定时派生的闲时任务被错误拒绝。
// INV-02 拒绝必须抛权限错误且默认不可恢复：守住位置 createCoreError 参数；改错故障 模型无限重试同一调用。
// INV-03 拒绝提示只拼接可选 hint：守住位置 hint 构造；改错故障 提示缺空格或吞掉自定义说明。
// INV-04 端口缺失必须抛配置错误：守住位置 assertOffPeakPort；改错故障 运行时空指针崩溃。
// INV-05 类型断言必须收窄 offPeakPort 非空：守住位置 asserts 签名；改错故障 后续调用仍需重复判空。
// INV-06 业务失败分类只按 errorCategory 分派：守住位置 switch；改错故障 靠 message 猜分类导致文案漂移。
// INV-07 客户端校验细分只按 errorCode 分派：守住位置 四个分支；改错故障 不同校验错误共用一句提示。
// INV-08 未知分类必须回退到通用可行动文案：守住位置 default；改错故障 模型收到空错误。
// INV-09 创建失败必须携带失败阶段与分类上下文：守住位置 createCoreError context；改错故障 无法定位服务端拒绝原因。
// INV-10 创建入口必须先拒绝闲时轮再解析输入：守住位置 handler 首行；改错故障 被拒绝的调用仍消耗解析成本。
// INV-11 创建必须绑定当前会话：守住位置 sessionId 入参；改错故障 任务派发到错误会话。
// INV-12 成功消息只在队列位置存在时附带序号：守住位置 条件模板；改错故障 显示 undefined 队列位置。
// INV-13 列表入口只解析输入并读取端口：守住位置 offPeakListHandler；改错故障 列表操作触发创建副作用。
// INV-14 创建权限固定要求审批：守住位置 offPeakPermission 调用；改错故障 消耗免费额度却无确认。
// INV-15 结果预算对模型与内联使用同一上限：守住位置 offPeakResultBudget；改错故障 模型看到被截断的不同内容。
// INV-16 超时不允许调用方覆盖：守住位置 allowCallOverride；改错故障 单次调用绕过统一上限。
// INV-17 创建与列表共享同一超时与预算对象：守住位置 两个 ToolEntry；改错故障 两个工具行为不一致。
// INV-18 工具面默认延迟加载：守住位置 shouldDefer；改错故障 常驻工具面被低频能力挤占。
//
// 模块职责：实现闲时任务的创建与列表工具，并把 host 业务失败翻译为稳定 CoreError。
// 状态所有权：任务与队列归 host；本文件只持有请求上下文与工具元数据。
// 阅读顺序：先看拒绝与端口断言，再读失败翻译，最后看两个 handler 与 ToolEntry。
// ============================================================
// Off-Peak Tool Handlers
// ============================================================
// 与 cron.ts 兄弟并列。关键差异（勿照抄 cron 的防御方向）：
// - deny 边界是「闲时派发轮」（context.offPeakTurn），不是 automation 轮——
//   cron automation 自动轮明确放行 OffPeakCreate（定时派生闲时任务）。
// - create 走判别联合结果：额度(3103)/资格(3101)等业务失败由 host 分类后跨协议保真，
//   此处翻译为稳定的 CoreError，模型据此向用户转述可行动信息。

import {
  CoreErrorType,
  createCoreError,
  OffPeakCreateInputJsonSchema,
  OffPeakCreateInputSchema,
  OffPeakCreateOutputJsonSchema,
  OffPeakCreateOutputSchema,
  OffPeakListInputJsonSchema,
  OffPeakListInputSchema,
  OffPeakListOutputJsonSchema,
  OffPeakListOutputSchema,
  type OffPeakCreateInput,
  type OffPeakCreateOutcome,
  type OffPeakCreateOutput,
  type OffPeakListOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const OFF_PEAK_TOOL_TIMEOUT_MS = 30_000;
const OFF_PEAK_MODEL_BYTES = 32_000;

/**
 * 闲时派发轮的 handler 级拒绝（turn denylist 之外的第二层纵深）。
 * provider denylist 只是可见性约束；异常 provider 仍可能直接提交。handler 以
 * executor 传入的本轮事实做最终拒绝。注意：刻意不检查 automationTurn（cron 轮放行）。
 * SendMessage / Workflow 复用本函数——它们会绕开本轮 modelExecution 重新启动子 Agent
 * 并落到用户套餐；拒绝时给模型可恢复的替代路径提示。
 */
// assertNotOffPeakTurn 只看 context.offPeakTurn：非闲时轮直接 return；闲时轮用 createCoreError(CoreErrorType.PermissionDenied, ...) 抛出，recoverable 取 options.recoverable ?? false，上下文只带 context.toolCallId 与 toolName；SendMessage/Workflow 复用它来拦子 Agent 绕路。
export function assertNotOffPeakTurn(
  context: ToolExecutionContext,
  toolName: string,
  options?: { hint?: string; recoverable?: boolean },
): void {
  if (!context.offPeakTurn) return;
  const hint = options?.hint ? ` ${options.hint}` : "";
  throw createCoreError(
    CoreErrorType.PermissionDenied,
    `${toolName} is not allowed while running an idle-time task.${hint}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: options?.recoverable ?? false,
      retryable: false,
    },
  );
}

// assertOffPeakPort 用 asserts context is ToolExecutionContext & { offPeakPort: NonNullable<...> } 把存在性检查变成类型收窄：offPeakPort 缺失时抛 CoreErrorType.ConfigurationError，后续代码才能直接调 context.offPeakPort.create/list 而不判空。
function assertOffPeakPort(
  context: ToolExecutionContext,
  toolName: "OffPeakCreate" | "OffPeakList",
): asserts context is ToolExecutionContext & {
  offPeakPort: NonNullable<ToolExecutionContext["offPeakPort"]>;
} {
  if (context.offPeakPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `OffPeakPort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

/** 业务失败翻译为模型可转述的稳定错误；分类驱动文案，禁止靠 message 猜。 */
// throwOffPeakCreateFailure 按 outcome.errorCategory 分支生成 detail：quota_3103 与 eligibility_3101 各自给出可行动说明，client_validation 再按 outcome.errorCode 细分为 model_not_allowed/session_bound/offpeak_disabled，抛出时把 failureStage、errorCategory、errorCode 写进 context。
function throwOffPeakCreateFailure(
  context: ToolExecutionContext,
  outcome: Extract<OffPeakCreateOutcome, { ok: false }>,
): never {
  const detail = (() => {
    switch (outcome.errorCategory) {
      case "quota_3103":
        return "The idle-time task quota is used up for now. Tell the user the free quota is exhausted and they can retry later or review tasks in Automations.";
      case "eligibility_3101":
        return "The current account has no eligible Coding Plan connection for idle-time tasks. Tell the user to select a ZAI/BigModel Coding Plan connection first.";
      case "client_validation":
        if (outcome.errorCode === "model_not_allowed") {
          return "The requested model is not in the idle-time allowed model list. Omit the model field to use the default allowed model.";
        }
        if (outcome.errorCode === "session_bound") {
          return "This session already has a pending idle-time task. Tell the user to wait for it to finish or cancel it in Automations before creating another one here.";
        }
        if (outcome.errorCode === "offpeak_disabled") {
          return "Idle-time tasks are not enabled for this account right now. Tell the user the feature is unavailable; do not retry with different parameters.";
        }
        return "The idle-time task input was rejected by validation.";
      case "network":
        return "The idle-time ticket service is unreachable. Tell the user to retry later.";
      default:
        return "Creating the idle-time task failed. Tell the user to retry from the Automations page.";
    }
  })();
  throw createCoreError(CoreErrorType.ToolExecutionFailed, detail, {
    context: {
      toolCallId: context.toolCallId,
      toolName: "OffPeakCreate",
      failureStage: outcome.failureStage,
      errorCategory: outcome.errorCategory,
      errorCode: outcome.errorCode,
    },
    recoverable: false,
    retryable: false,
  });
}

/**
 * 输入口径（OffPeakCreateInput）：
 * - title/prompt：prompt 必须是"最终工作说明"，不能要求 run 再去创建任务/自动化；
 *   任务稍后在本会话无人值守继续，prompt 可引用已有上下文，但仍要写清交付物。
 * - permissionMode/model/thoughtLevel：仅在用户显式要求时才设；缺省走全自动 + 默认允许模型。
 * - 不含工作区路径/身份：绑定的是当前 session，路径由 host 侧补齐。
 * 副作用：消耗一次免费闲时额度并在服务端排队；成功返回 task（含 queuePosition）与确认文案。
 */
// offPeakCreateHandler 的顺序固定：先 assertNotOffPeakTurn(context, "OffPeakCreate")，再 OffPeakCreateInputSchema.parse，再 assertOffPeakPort；create 固定传 sessionId: context.sessionId，失败交 throwOffPeakCreateFailure，成功消息按 task.queuePosition 是否为 number 决定是否带序号。
export const offPeakCreateHandler: ToolHandler = async (input, context) => {
  assertNotOffPeakTurn(context, "OffPeakCreate");
  const parsed = OffPeakCreateInputSchema.parse(input) as OffPeakCreateInput;
  assertOffPeakPort(context, "OffPeakCreate");

  const outcome = await context.offPeakPort.create(parsed, {
    // 本会话即闲时任务的绑定会话，派发时 resume 本会话执行（对齐 CronCreate targetTaskId）。
    sessionId: context.sessionId,
  });
  if (!outcome.ok) {
    throwOffPeakCreateFailure(context, outcome);
  }
  return {
    task: outcome.task,
    message:
      typeof outcome.task.queuePosition === "number"
        ? `Created idle-time task ${outcome.task.offPeakTaskId} (#${outcome.task.queuePosition} in queue).`
        : `Created idle-time task ${outcome.task.offPeakTaskId}.`,
  } satisfies OffPeakCreateOutput;
};

// offPeakListHandler 只调 OffPeakListInputSchema.parse(input) 校验结构、不读字段，随后 assertOffPeakPort(context, "OffPeakList")；context.offPeakPort.list() 的结果原样放进 OffPeakListOutput，不在这里二次排序。
export const offPeakListHandler: ToolHandler = async (input, context) => {
  OffPeakListInputSchema.parse(input);
  assertOffPeakPort(context, "OffPeakList");

  const tasks = await context.offPeakPort.list();
  return { tasks } satisfies OffPeakListOutput;
};

// offPeakPermission 固定返回 riskLevel: "medium" 与 sideEffectScope: "workspace"，patternSources 同时含 "toolName" 与 "input"；needsApproval 为 true 时 alwaysAllowPatternSources 置 undefined，禁止按工具名永久放行。
function offPeakPermission(
  permission: string,
  reason: string,
  needsApproval: boolean,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "medium" as const,
    sideEffectScope: "workspace" as const,
    needsApproval,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: needsApproval ? undefined : ["toolName"],
    denyPriority: "beforeAsk" as const,
  };
}

const offPeakResultBudget = {
  maxInlineBytes: OFF_PEAK_MODEL_BYTES,
  maxModelBytes: OFF_PEAK_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: OFF_PEAK_MODEL_BYTES,
    direction: "head" as const,
  },
};

const offPeakTimeout = {
  defaultMs: OFF_PEAK_TOOL_TIMEOUT_MS,
  maxMs: OFF_PEAK_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

/**
 * 入口口径：shouldDefer=true（默认不进常驻工具面，经 ToolSearch 加载）；
 * needsApproval 恒为 true —— 创建会消耗有限的免费额度，必须过确认窗；
 * concurrentSafe=false：同一会话的重复创建要串行，避免并发抢同一份待派发槽位。
 * permission 规则取 toolName+input，供按工具名整体放行或按入参细分。
 */
export const offPeakCreateToolEntry: ToolEntry = {
  capability: "Create an idle-time task queued for free off-peak execution",
  metadata: {
    shouldDefer: true,
    name: "OffPeakCreate",
    description:
      "Create a one-off idle-time task in the current workspace: it takes a queue ticket immediately and later runs unattended in THIS session (with the full conversation history) when the server grants off-peak compute, at no plan-quota cost. There is no guaranteed start time. Unlike CronCreate (recurring or clock-scheduled work), use this for deferrable work the user wants done cheaply 'when compute is idle'. The prompt must describe the final work directly and must never ask the run to create, schedule, or configure another idle-time task or automation.",
    modelInstructions: [
      "Use this only when the user explicitly asks for idle-time/off-peak execution (闲时任务/闲时执行/低峰跑), or explicitly accepts deferring the work to the free idle-time queue.",
      "Choose CronCreate instead for anything time-scheduled or recurring ('every day at 9', 'in 10 minutes'). OffPeakCreate has no clock: the server decides when the task starts.",
      "The task later continues THIS conversation unattended with the full history available, so prompt may refer to context already established here; still state the expected deliverable explicitly because nobody will answer questions during the run.",
      "By default the task runs in full-automatic mode with the default allowed model at the highest reasoning level. Only set permissionMode/model/thoughtLevel when the user explicitly asks for confirmation-gated execution, a specific model, or a lower reasoning effort.",
      "Do not include workspace paths or identities in the input; the current session workspace is used.",
      "Keep title concise and task-descriptive without file paths.",
      "Creation consumes a limited free take-number quota. If creation fails with a quota error, relay the limit to the user instead of retrying.",
      "After a successful creation, reply with only a brief confirmation; the UI renders a task card with a link to the Automations page for edits.",
      "Never call OffPeakCreate from within an idle-time task run, and never write a prompt asking the run to create more idle-time tasks or automations.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: OFF_PEAK_TOOL_TIMEOUT_MS,
    maxOutputBytes: OFF_PEAK_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: offPeakCreateHandler,
  inputSchema: OffPeakCreateInputJsonSchema,
  outputSchema: OffPeakCreateOutputJsonSchema,
  runtimeInputSchema: OffPeakCreateInputSchema,
  runtimeOutputSchema: OffPeakCreateOutputSchema,
  permission: offPeakPermission(
    "offpeak.create",
    "OffPeakCreate queues an unattended idle-time task and consumes a free take-number quota",
    true,
  ),
  resultBudget: offPeakResultBudget,
  timeout: offPeakTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "OffPeakCreate was cancelled before the idle-time task was created",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const offPeakListToolEntry: ToolEntry = {
  capability: "List idle-time tasks for the current workspace",
  metadata: {
    shouldDefer: true,
    name: "OffPeakList",
    description:
      "List idle-time tasks in the current workspace with status and queue position. Read-only.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: OFF_PEAK_TOOL_TIMEOUT_MS,
    maxOutputBytes: OFF_PEAK_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: offPeakListHandler,
  inputSchema: OffPeakListInputJsonSchema,
  outputSchema: OffPeakListOutputJsonSchema,
  runtimeInputSchema: OffPeakListInputSchema,
  runtimeOutputSchema: OffPeakListOutputSchema,
  permission: {
    permission: "offpeak.read",
    reason: "OffPeakList only reads idle-time tasks for this workspace",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: offPeakResultBudget,
  timeout: offPeakTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "OffPeakList was cancelled before idle-time tasks were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
