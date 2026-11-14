// INV-01 自动化执行轮禁止一切写工具：守住位置 assertNotAutomationTurn 的四个写 handler；改错故障 定时任务自我复制，指数级放大。
// INV-02 拒绝必须发生在调用自动化端口之前：守住位置 每个 handler 的首个断言；改错故障 拒绝时已产生副作用。
// INV-03 拒绝依据是本轮事实而不是工具可见性：守住位置 context.automationTurn；改错故障 旧入口绕过可见性约束后仍能写。
// INV-04 自动化端口缺失时报配置错误：守住位置 assertAutomationPort；改错故障 精简环境下抛未定义属性异常，模型无法自我纠正。
// INV-05 工具输出必须经投影函数裁剪：守住位置 三个写返回值与列表映射；改错故障 内部存储字段泄漏进上下文。
// INV-06 裁剪必须保留调度规则字段：守住位置 投影函数字段表；改错故障 间隔型任务显示成每小时或每天。
// INV-07 会话内创建固定复用当前会话：守住位置 创建调用的会话参数；改错故障 每次触发新建会话，历史碎片化。
// INV-08 模型标识来自运行时而非工具入参：守住位置 创建调用的模型展开；改错故障 模型可伪造计费主体。
// INV-09 删除未命中返回未删除标记而非报错：守住位置 删除 handler；改错故障 基于过期列表的操作变成失败重试。
// INV-10 删除结果必须回带入参标识：守住位置 返回对象的标识字段；改错故障 模型无法确认删的是哪一条。
// INV-11 四个工具的权限声明共用同一构造函数：守住位置 各入口的权限字段；改错故障 风险等级与审批口径在各工具间漂移。
// INV-12 读工具与写工具的作用域必须不同：守住位置 列表入口与三个写入口；改错故障 只读工具被要求审批。
// INV-13 创建与更新必须串行：守住位置 两个入口的并发安全标记；改错故障 并发写同一清单互相覆盖。
// INV-14 超时与输出上限共用常量：守住位置 四个入口与结果预算；改错故障 单工具私自放宽导致长尾卡死。
// INV-15 写工具默认需要审批：守住位置 审批标记；改错故障 长期驻留的定时任务在无确认下创建。
// INV-16 输入在 handler 内用运行时 schema 二次解析：守住位置 四个 handler 首段；改错故障 类型断言掩盖非法入参。
// INV-17 取消声明必须给出用户可见文案：守住位置 各入口的取消配置；改错故障 取消后界面无反馈。
// INV-18 追踪记录只记摘要，不记录原始提示词：守住位置 追踪配置；改错故障 长提示词进入追踪存储。
//
// 模块职责：实现定时自动化四个增删改查工具的执行体、元数据、权限与资源预算声明。
// 状态所有权：自动化清单归端口背后的存储所有，本文件不缓存任何数据。
// 阅读顺序：先看两道断言与投影函数，再依次读四个 handler，最后看权限、预算与四个工具入口声明。
/**
 * ============================================================================
 * tool/handlers/cron.ts —— 定时自动化（Cron）的 CRUD 工具
 * ============================================================================
 *
 * 【定位】四个工具：CronCreate / CronList / CronUpdate / CronDelete，
 *   全部经 AutomationPort 访问自动化存储；本文件不直接读写配置。
 *
 * 【两条硬约束】
 *   1) automationTurn 内禁止写操作（create/update/delete）：定时任务自己再创建
 *      定时任务会造成指数级放大。provider 的工具 denylist 只是可见性约束，
 *      这里用 executor 传入的"本轮事实"做最终拒绝，且拒绝发生在调用端口之前；
 *   2) AutomationPort 缺失时报 ConfigurationError（readOnly/精简环境）。
 *
 * 【展示口径】toModelAutomation 会裁剪内部字段，只把模型需要的
 *   id/cron/prompt/enabled 等交给 provider，避免内部存储结构泄漏进上下文。
 * ============================================================================
 */

import {
  CoreErrorType,
  CronCreateInputJsonSchema,
  CronCreateInputSchema,
  CronCreateOutputJsonSchema,
  CronCreateOutputSchema,
  CronDeleteInputJsonSchema,
  CronDeleteInputSchema,
  CronDeleteOutputJsonSchema,
  CronDeleteOutputSchema,
  CronListInputJsonSchema,
  CronListInputSchema,
  CronListOutputJsonSchema,
  CronListOutputSchema,
  CronUpdateInputJsonSchema,
  CronUpdateInputSchema,
  CronUpdateOutputJsonSchema,
  CronUpdateOutputSchema,
  createCoreError,
  type CronAutomation,
  type CronCreateInput,
  type CronCreateOutput,
  type CronDeleteInput,
  type CronDeleteOutput,
  type CronListOutput,
  type CronUpdateInput,
  type CronUpdateOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const CRON_TOOL_TIMEOUT_MS = 30_000;
const CRON_MODEL_BYTES = 32_000;

/**
 * 定时任务轮次内的写入闸门。
 *
 * 这是一道"按本轮事实"的运行时检查，而不是依赖工具可见性：
 * 旧入口、异常 provider 或直接调用仍可能提交写工具，所以在 handler 层
 * 再拒绝一次，并且不触碰 AutomationPort（拒绝必须发生在副作用之前）。
 */
// 第一道闸门：自动化执行轮内，写工具直接拒绝。
// 拒绝发生在端口调用之前，确保没有副作用。
// 错误类型固定为权限拒绝且不可重试，避免模型反复尝试。
// 错误上下文带上工具名与调用标识，便于审计定位。
// 读工具不经过 assertNotAutomationTurn，自动化轮内仍可列举。
function assertNotAutomationTurn(
  context: ToolExecutionContext,
  toolName: "CronCreate" | "CronUpdate" | "CronDelete",
): void {
  if (!context.automationTurn) return;
  // provider tool denylist 只是可见性约束，旧入口或异常 provider 仍可能直接提交
  // automation 写工具。handler 必须以 executor 传入的本轮事实做最终拒绝，且不能调用端口。
  throw createCoreError(
    CoreErrorType.PermissionDenied,
    `${toolName} is not allowed while running a scheduled automation.`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
      retryable: false,
    },
  );
}

function assertAutomationPort(
  context: ToolExecutionContext,
  toolName: "CronCreate" | "CronList" | "CronUpdate" | "CronDelete",
): asserts context is ToolExecutionContext & {
  automationPort: NonNullable<ToolExecutionContext["automationPort"]>;
} {
  if (context.automationPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `AutomationPort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

// 输出投影只保留模型决策需要的字段。
// 调度规则字段必须保留，间隔型任务的真实周期全靠它。
// 运行历史与内部标识按需透出，避免上下文膨胀。
// 返回新对象而不是就地裁剪，保持源数据不变。
function toModelAutomation(automation: CronAutomation): CronAutomation {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    // 工具输出曾在此处重新投影 automation 时遗漏 scheduleRule，导致 CronCreate /
    // CronUpdate / CronList 虽收到真实间隔仍只展示兼容 cron，错误显示成每小时或每天。
    scheduleRule: automation.scheduleRule,
  };
}

/**
 * 输入口径（CronCreateInput，四个写工具里字段最多）：
 * - 时间表达三分：delayMinutes（"从现在起 N 分钟后"一次性，由宿主真实时钟锚定）、
 *   cronExpr（5 字段、用户本地时区的墙钟）、intervalUnit + interval（每 N 分钟/小时/天…，
 *   由 scheduleRule 承载，不走 cron 的字段上限）。
 * - recurring/maxRuns：recurring=true 无限；recurring=false 时必须配 maxRuns（默认 1）。
 * - title 必须保留用户原始时间短语；prompt 必须是可直接无人值守执行的最终工作说明。
 * - 工作区、session、model 都不在 input 里：handler 用本轮事实补齐（见下），防止模型伪造。
 * 副作用：写入自动化存储并立即排队；成功后返回裁剪过的 automation 与确认文案。
 */
// cronCreateHandler 先过轮次闸门，再校验入参与端口，顺序不可交换。
// model 与 sessionId 由运行时补齐，入参只描述任务本身。
// 返回 message 带 automationId，便于模型后续引用。
// automationPort.create 负责持久化并立即排队，失败直接抛出。
export const cronCreateHandler: ToolHandler = async (input, context) => {
  assertNotAutomationTurn(context, "CronCreate");
  const parsed = CronCreateInputSchema.parse(input) as CronCreateInput;
  assertAutomationPort(context, "CronCreate");

  const automation = await context.automationPort.create(parsed, {
    // 会话内创建定时任务时模型来自当前 runtime，而不是模型可控的工具入参。
    ...(context.model ? { model: `${context.model.providerId}/${context.model.modelId}` } : {}),
    // 会话内创建的 cron 固定复用当前 session，后续触发不再新建 session。
    sessionId: context.sessionId,
  });
  return {
    automation: toModelAutomation(automation),
    message: `Created automation ${automation.automationId}.`,
  } satisfies CronCreateOutput;
};

// cronListHandler 只校验 automationPort，不做过期数据过滤。
// list 结果逐项走 toModelAutomation，保证字段口径与创建一致。
// 返回结构固定为 automations 数组，空列表也是合法结果。
// cronListHandler 可在自动化轮内安全调用，因为它是只读的。
export const cronListHandler: ToolHandler = async (input, context) => {
  CronListInputSchema.parse(input);
  assertAutomationPort(context, "CronList");

  const automations = await context.automationPort.list();
  return {
    automations: automations.map(toModelAutomation),
  } satisfies CronListOutput;
};

// cronUpdateHandler 同样先过 assertNotAutomationTurn，防止任务改写自身定义。
// 更新只接受定义字段，运行历史与 sessionId 绑定不可改。
// 返回 toModelAutomation 结果与确认文案，供界面刷新卡片。
// automationPort.update 未命中时由端口层决定报错或返回原值。
export const cronUpdateHandler: ToolHandler = async (input, context) => {
  assertNotAutomationTurn(context, "CronUpdate");
  const parsed = CronUpdateInputSchema.parse(input) as CronUpdateInput;
  assertAutomationPort(context, "CronUpdate");

  const automation = await context.automationPort.update(parsed);
  return {
    automation: toModelAutomation(automation),
    message: `Updated automation ${automation.automationId}.`,
  } satisfies CronUpdateOutput;
};

/**
 * 删除口径：`deleted=false` 是"当前工作区找不到该 id"，属于业务结果而不是失败——
 * 模型可能基于过期列表操作，这里让它可以如实转述而不是重试删除。
 */
// cronDeleteHandler 同样受 assertNotAutomationTurn 约束。
// 未找到返回未删除标记，属于业务结果而非异常。
// 文案区分「已删除」与「当前工作区未找到」两种情形。
// 回带入参标识，保证模型转述时指代明确。
export const cronDeleteHandler: ToolHandler = async (input, context) => {
  assertNotAutomationTurn(context, "CronDelete");
  const parsed = CronDeleteInputSchema.parse(input) as CronDeleteInput;
  assertAutomationPort(context, "CronDelete");

  const deleted = await context.automationPort.delete(parsed);
  return {
    deleted,
    id: parsed.id,
    message: deleted
      ? `Deleted automation ${parsed.id}.`
      : `Automation ${parsed.id} was not found in the current workspace.`,
  } satisfies CronDeleteOutput;
};

// 写工具的权限声明集中在这里，避免四处复制漂移。
// 风险等级固定中等、作用域固定工作区。
// cronPermission 的风险等级固定中等，作用域固定工作区。
function cronPermission(
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

const cronResultBudget = {
  maxInlineBytes: CRON_MODEL_BYTES,
  maxModelBytes: CRON_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: CRON_MODEL_BYTES,
    direction: "head" as const,
  },
};

const cronTimeout = {
  defaultMs: CRON_TOOL_TIMEOUT_MS,
  maxMs: CRON_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

/**
 * 入口口径：shouldDefer=true（按需经 ToolSearch 加载，避免常驻工具面过大）；
 * needsApproval=true（创建会长期驻留并反复触发，属于工作区级副作用）；
 * concurrentSafe=false：同一会话的创建/更新必须串行，避免并发写同一份自动化清单。
 */
export const cronCreateToolEntry: ToolEntry = {
  capability: "Create a scheduled automation for the current workspace",
  metadata: {
    shouldDefer: true,
    name: "CronCreate",
    searchHint: "schedule a recurring or one-shot prompt",
    // 二阶调度要求应在工具 contract 中直接约束模型；自然语言不能靠关键词或正则可靠判定，
    // automation 执行轮的 mutation tool denylist 才是阻止递归修改任务定义的权限边界。
    description:
      "Create a persistent scheduled automation in the current workspace. It uses the host's real current clock for relative delayMinutes schedules, or a standard 5-field cron expression in the user's local timezone for absolute/recurring schedules, and survives app restarts. The prompt must describe the final scheduled work directly and must never ask the run to create, schedule, or configure another automation or call CronCreate.",
    modelInstructions: [
      "Use this only when the user explicitly asks to schedule future automatic work.",
      "Interpret cron in the user's local timezone using fields: minute hour day-of-month month day-of-week. Do not convert to UTC.",
      // '8分钟后上课提醒' 既是相对延迟又是一次性提醒；旧指令里“一次性提醒就 pin
      // 绝对月日时分”的措辞覆盖了相对延迟规则，模型据此自算出 '29 7 29 7 *' 这类固定日历 cron。
      // 模型对“现在”的时刻常是陈旧的，自算的一次性时刻一旦刚过去就被 host 静默滚到下一年。
      // 修复：任何“从现在起 N 后”的表达（含小时、中英文）一律走 delayMinutes；pin 绝对 cron 只
      // 用于用户明确点名的墙钟日期，且显式声明相对一次性必须改用 delayMinutes。
      "For any schedule expressed as a delay from now — 'in 3 minutes' sets delayMinutes=3, '8分钟后' sets delayMinutes=8, 'in 2 hours' sets delayMinutes=120, 'later'/'稍后' — set delayMinutes to the total whole minutes, omit cron, set recurring=false, and omit maxRuns. The host anchors to its real current clock; never infer the current time or convert a relative delay into a cron or clock time yourself.",
      "Use '*/20 * * * *' for every 20 minutes, '0 * * * *' for hourly, and '0 9 * * 1-5' for weekdays at 09:00.",
      // 只用 cron 表达“每 N 单位”会受字段上限影响，且即使 N 未越界也会变成墙钟对齐，
      // 与 UI 自定义重复从保存时刻锚定的语义不一致。所有每 N 单位统一用 carrier + scheduleRule。
      "For every N minutes/hours/days/weeks/months/years, always set intervalUnit (minute|hourly|daily|weekly|monthly|yearly) and interval together. interval must be an integer from 1 to 200, including values cron could express directly. Supply a legal 5-field compatible cron only for time-of-day/day/weekday/month slots; never put an out-of-range step in cron. Examples: every 20 minutes -> intervalUnit='minute', interval=20, cron='* * * * *'; every 31 hours at minute 49 -> intervalUnit='hourly', interval=31, cron='49 * * * *'; every 40 days at 09:00 -> intervalUnit='daily', interval=40, cron='0 9 * * *'. Omit intervalUnit/interval only for ordinary calendar cron schedules, such as weekdays at 09:00.",
      "Pin minute, hour, day-of-month, and month in cron only for an absolute wall-clock date the user names outright, such as 'tomorrow at 9am' or 'on July 30 at 20:00'; set recurring=false and omit maxRuns (the default limit is 1). A relative one-shot such as '8分钟后' or 'in 2 hours' must use delayMinutes instead, because a self-computed one-shot time that has just passed silently rolls a full year forward.",
      "For exactly N scheduled runs, set recurring=false and maxRuns=N. recurring=true is indefinite and must not be combined with maxRuns.",
      "Automations persist in the current workspace until the user deletes them. Finite automations become completed and retain their history; they are not session-only or auto-deleted.",
      "Honor exact user-provided times without adding jitter or shifting the schedule.",
      "Do not include workspace paths or identities in the input; the current session workspace is used.",
      "Always set title and preserve the user's natural-language schedule phrase verbatim in it. The title may be concise, but must not omit timing such as '每20分钟', '每天早上9点', or 'every Friday'.",
      "Write prompt as a complete instruction that can run later without relying on unstated conversation context.",
      "Write the final work directly in prompt. Never ask the scheduled run to create, schedule, or configure another automation, and never ask it to call CronCreate.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronCreateHandler,
  inputSchema: CronCreateInputJsonSchema,
  outputSchema: CronCreateOutputJsonSchema,
  runtimeInputSchema: CronCreateInputSchema,
  runtimeOutputSchema: CronCreateOutputSchema,
  permission: cronPermission(
    "automation.create",
    "CronCreate creates a scheduled background automation for this workspace",
    true,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronCreate was cancelled before the automation was created",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronListToolEntry: ToolEntry = {
  capability: "List scheduled automations for the current workspace",
  metadata: {
    shouldDefer: true,
    name: "CronList",
    searchHint: "list active cron jobs",
    description: "List scheduled automations in the current workspace.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: cronListHandler,
  inputSchema: CronListInputJsonSchema,
  outputSchema: CronListOutputJsonSchema,
  runtimeInputSchema: CronListInputSchema,
  runtimeOutputSchema: CronListOutputSchema,
  permission: {
    permission: "automation.read",
    reason: "CronList only reads scheduled automations for this workspace",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronList was cancelled before automations were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronUpdateToolEntry: ToolEntry = {
  capability: "Update a scheduled automation in the current workspace",
  metadata: {
    shouldDefer: true,
    name: "CronUpdate",
    description:
      "Update selected definition fields of an existing scheduled automation in the current workspace while preserving its id and run history.",
    modelInstructions: [
      "Use CronList first when the automation id is not already known. Never guess an automation id.",
      "Always pass title on every CronUpdate. Rewrite it so it describes the task after the update and keeps the user's natural-language schedule phrase consistent with cron; for example, changing every 5 minutes to every 6 minutes must also update the title.",
      "Apart from the required synchronized title, only pass fields the user asked to change. Omitted fields preserve their existing values.",
      "Interpret cron in the user's local timezone using five fields: minute hour day-of-month month day-of-week. Do not convert to UTC.",
      // 更新“每 N 单位”时同样必须使用 carrier；否则小间隔会退化为墙钟 cron，长间隔会生成非法 cron。
      "To create or change every N minutes/hours/days/weeks/months/years, pass intervalUnit and interval together for every N-unit schedule. interval must be an integer from 1 to 200 even when cron could express N. Also pass a legal compatible cron with only the time/day/weekday/month slot; for example, every 40 days at 09:00 uses intervalUnit='daily', interval=40, cron='0 9 * * *'. Omit the pair only when preserving or using an ordinary calendar cron schedule.",
      "Use numeric maxRuns only with recurring=false. Setting recurring=true clears any old finite limit automatically; never combine recurring=true with a numeric maxRuns.",
      "CronUpdate cannot change workspace, session binding, model, provider, mode, thought level, run count, history, or enabled state.",
      "Do not simulate an update by deleting and recreating the automation.",
      "After a successful update, reply with only a brief confirmation. Do not restate the automation fields in a fenced code block or simulate a text file because the UI renders the updated automation card.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronUpdateHandler,
  inputSchema: CronUpdateInputJsonSchema,
  outputSchema: CronUpdateOutputJsonSchema,
  runtimeInputSchema: CronUpdateInputSchema,
  runtimeOutputSchema: CronUpdateOutputSchema,
  permission: cronPermission(
    "automation.update",
    "CronUpdate changes a scheduled background automation in this workspace",
    true,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronUpdate was cancelled before the automation was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronDeleteToolEntry: ToolEntry = {
  capability: "Delete a scheduled automation from the current workspace",
  metadata: {
    shouldDefer: true,
    name: "CronDelete",
    searchHint: "cancel a scheduled cron job",
    description: "Delete a scheduled automation from the current workspace by automation id.",
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronDeleteHandler,
  inputSchema: CronDeleteInputJsonSchema,
  outputSchema: CronDeleteOutputJsonSchema,
  runtimeInputSchema: CronDeleteInputSchema,
  runtimeOutputSchema: CronDeleteOutputSchema,
  permission: cronPermission(
    "automation.delete",
    "CronDelete removes a scheduled background automation from this workspace",
    true,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronDelete was cancelled before the automation was deleted",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
