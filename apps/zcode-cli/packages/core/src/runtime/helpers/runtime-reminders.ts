// ============================================================
// runtime-reminders —— 运行时系统提醒的正文构建与注入节奏判定
// ============================================================
//
// 【职责】为三类“按节奏重复注入”的提醒生成正文与判定条件：
//   - runtime_mode：Plan 模式提醒（全量 / 稀疏交替，按 human turn 计）；
//   - todo_reminder：TodoWrite 使用提醒（按 assistant turn 计，需两条件同时满足）；
//   - plan mode exit / date change / output style 等一次性提醒。
//   另含 synthetic 用户消息来源 → RuntimeMessageMetadata 的映射。
//
// 【为什么按节奏而不是每 turn 全量重发】
//   这些提醒是重复性约束，每 turn 重发既浪费 token，又会稀释用户真实指令；
//   所以设“距上次若干 turn”的门槛，并让 Plan 模式的全量版周期性重放。
//
// 【计数口径（两套，不可混用）】
//   - runtime_mode 用 human turns：只数 source=real_user 的用户消息，忽略附件与 synthetic；
//   - todo_reminder 用 assistant turns：从尾部向前数 assistant 消息。
//   两套口径都只读 entries，不写状态；是否真正注入由调用方决定。
//
// 【副作用】无。所有导出函数都是纯计算（输入 entries/config，输出字符串或布尔）。
// 【失败/降级】无可注入内容时返回 null / false，调用方据此跳过注入。
// ============================================================
import {
  legacySyntheticRuntimeMetadata,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";
import type {
  CollaborationMode,
  OutputStylePromptConfig,
  SyntheticUserMessageSource,
  TodoItem,
} from "../deps.js";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import { EXPLORE_AGENT_TYPE } from "../../subagent/explore.js";

// Plan 模式提醒节奏：至少每 5 个人类 turn 重复一次；每 5 次提醒插入一次全量版，
// 其余为稀疏版（只引用“早前的完整说明”），避免长会话里反复粘贴大段流程文本。
export const RUNTIME_MODE_REMINDER_CONFIG = Object.freeze({
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
});

// Plan 阶段 1 最多并行 3 个探索 agent；再多会显著抬高首轮成本。
const planResearchAgentCount = 3;

/**
 * 生成 Plan 模式四阶段工作流说明（全量提醒的主体）。
 * 输入：无。
 * 输出：Markdown 文本。
 * 语义：静态模板，但嵌入 explorer / AskUserQuestion / ExitPlanMode 的真实工具名，
 *   保证与工具注册保持一致。
 * 副作用：无。
 */
function buildPlanWorkflow() {
  return `## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the ${EXPLORE_AGENT_TYPE} subagent type.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused \u2014 avoid proposing new code when suitable implementations already exist.

2. **Launch up to ${planResearchAgentCount} ${EXPLORE_AGENT_TYPE} agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - ${planResearchAgentCount} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns

### Phase 2: Design
Goal: Design an implementation approach.

**Guidelines:**
- Use the context gathered in Phase 1, including relevant files and code paths.
- Account for the user's requirements and constraints.
- Produce a concrete implementation plan that is detailed enough to execute.
- Consider useful perspectives for the task type:
  - New feature: simplicity vs performance vs maintainability
  - Bug fix: root cause vs workaround vs prevention
  - Refactoring: minimal change vs clean architecture

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use ${ASK_USER_QUESTION_TOOL_NAME} to clarify any remaining questions with the user

### Phase 4: Call ${EXIT_PLAN_MODE_TOOL_NAME}
At the very end of your turn, once you have asked the user questions and are happy with your final plan - you should always call ${EXIT_PLAN_MODE_TOOL_NAME} to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the ${ASK_USER_QUESTION_TOOL_NAME} tool OR calling ${EXIT_PLAN_MODE_TOOL_NAME}. Do not stop unless it's for these 2 reasons

**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${ASK_USER_QUESTION_TOOL_NAME} tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`;
}

// 全量提醒：硬性禁止改动 + 完整工作流；用于首次进入或周期性重放。
const PLAN_MODE_FULL_REMINDER = [
  "Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.",
  buildPlanWorkflow(),
];

// 稀疏提醒：只重申只读与收尾要求，指向“早前的完整说明”，控制 token。
const PLAN_MODE_SPARSE_REMINDER = [
  `Plan mode still active (see full instructions earlier in conversation). Read-only. Follow 4-phase workflow. End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`,
];

// 退出 Plan 模式后的“解除限制”提示（一次性）。
const PLAN_MODE_EXIT_REMINDER = [
  "## Exited Plan Mode",
  "",
  `You have exited plan mode. You can now make edits, run tools, and take actions.`,
];

// Todo 提醒门槛：距上次 TodoWrite 且距上次提醒都达到 10 个 assistant turn 才触发；
// 两个条件同时满足，既能避免频繁打扰，又能在“提醒后仍不写”时继续提示。
export const TODO_REMINDER_CONFIG = Object.freeze({
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
});

/**
 * Todo 提醒的计数快照。
 */
export interface TodoReminderTurnCounts {
  /** 距最近一次包含 TodoWrite 工具调用的 assistant turn 数。 */
  turnsSinceLastTodoWrite: number;
  /** 距最近一次 todo_reminder 附件的 assistant turn 数。 */
  turnsSinceLastReminder: number;
}

/**
 * 生成日期变更提醒正文。
 * 输入：上一次 / 当前日期字符串（_previousDate 仅保留签名兼容，不参与文本）。
 * 输出：提醒文本。
 * 语义：明确要求模型不要主动向用户播报日期变化。
 * 副作用：无。
 */
export function buildDateChangeReminderBody(_previousDate: string, currentDate: string): string {
  return `The date has changed. Today's date is now ${currentDate}. DO NOT mention this to the user explicitly because they are already aware.`;
}

/**
 * 把 synthetic 用户消息来源映射为 RuntimeMessageMetadata。
 * 输入：SyntheticUserMessageSource。
 * 输出：决定持久化 / 投影 / 去重行为的元数据。
 * 映射：
 *   background_task / subagent_message / shared_context → legacy（非系统提醒）；
 *   subagent → queued_system_notification；
 *   todo_reminder → todoReminder 专用元数据；
 *   goal-continuation → target_continuation（续写提示，query-local）；
 *   其余已枚举来源按同名 systemReminder 元数据；
 *   未单独枚举的来源兜底为 rewind_notice（保持历史行为）。
 * 副作用：无。
 * 不变量：来源与 metadata.source 必须一一对应，否则持久化 / 去重 / 冷恢复都会错位。
 */
export function runtimeMetadataForSyntheticUserMessageSource(
  source: SyntheticUserMessageSource,
): RuntimeMessageMetadata {
  if (
    source === "background_task" ||
    source === "subagent_message" ||
    source === "shared_context"
  ) {
    return legacySyntheticRuntimeMetadata();
  }
  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal_state_change") {
    return systemReminderRuntimeMetadata("goal_state_change");
  }
  if (source === "agent_listing_delta") {
    return systemReminderRuntimeMetadata(source);
  }
  if (source === "plugin_reference") {
    return systemReminderRuntimeMetadata("plugin_reference");
  }
  if (source === "selection_side_chat") {
    return systemReminderRuntimeMetadata("selection_side_chat");
  }
  if (source === "bot_topic_context") return systemReminderRuntimeMetadata("bot_topic_context");
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  return systemReminderRuntimeMetadata("rewind_notice");
}

/**
 * 从条目尾部向前统计两种“距上次”的 turn 数。
 * 输入：runtime 条目序列。
 * 输出：TodoReminderTurnCounts。
 * 语义：只把 assistant 消息记为一个 turn；遇到最近的 todo_reminder 附件、
 *   或含 TodoWrite 的 assistant 消息即记录；两值都确定后提前终止。
 * 副作用：无。降级：找不到时用“当前总 assistant turn 数”兜底。
 */
export function getTodoReminderTurnCounts(
  entries: readonly RuntimeMessageEntry[],
): TodoReminderTurnCounts {
  let assistantTurnsAfterCurrentEntry = 0;
  let turnsSinceLastTodoWrite: number | undefined;
  let turnsSinceLastReminder: number | undefined;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (turnsSinceLastReminder === undefined && entry.metadata?.source === "todo_reminder") {
      turnsSinceLastReminder = assistantTurnsAfterCurrentEntry;
    }
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }

    // 附件不构成 turn：只参与 source 判定，不增加计数。
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role !== "assistant") continue;

    if (
      turnsSinceLastTodoWrite === undefined &&
      entry.message.toolCalls?.some((toolCall) => toolCall.name === "TodoWrite")
    ) {
      turnsSinceLastTodoWrite = assistantTurnsAfterCurrentEntry;
    }
    assistantTurnsAfterCurrentEntry++;
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }
  }

  return {
    turnsSinceLastReminder: turnsSinceLastReminder ?? assistantTurnsAfterCurrentEntry,
    turnsSinceLastTodoWrite: turnsSinceLastTodoWrite ?? assistantTurnsAfterCurrentEntry,
  };
}

/**
 * 判断是否应在本 turn 注入 Todo 提醒。
 * 输入：entries。
 * 输出：boolean。
 * 语义：两个门槛必须同时达到（TURNS_SINCE_WRITE 与 TURNS_BETWEEN_REMINDERS）。
 * 副作用：无。
 */
export function shouldBuildTodoReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  const counts = getTodoReminderTurnCounts(entries);
  return (
    counts.turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    counts.turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  );
}

/**
 * 生成 Todo 提醒正文。
 * 输入：当前 todo 列表。
 * 输出：提醒文本；列表非空时附带现有 todos 的编号清单。
 * 副作用：无。
 * 语义：措辞上明确“温和提醒、不适用可忽略”，避免强迫模型写 todo。
 */
export function buildTodoReminderBody(todos: readonly TodoItem[]): string {
  const lines = [
    "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
  ];
  if (todos.length > 0) {
    const currentTodos = `[${formatTodoListForReminder(todos).join("\n")}]`;
    lines.push("", "Here are the existing contents of your todo list:", "", currentTodos);
  }
  return lines.join("\n");
}

/**
 * 生成 Plan 模式提醒正文（全量或稀疏）。
 * 输入：entries、当前协作模式、planEnabled（默认 mode === "plan"）。
 * 输出：提醒文本；不需要注入时 null。
 * 语义：仅在 Plan 模式生效；距上次 runtime_mode 提醒不足 5 个人类 turn 时不重复；
 *   按已注入次数决定本次用全量版还是稀疏版（每 5 次一次全量）。
 * 副作用：无。
 */
export function buildRuntimeModeReminderBody(
  entries: readonly RuntimeMessageEntry[],
  mode: CollaborationMode,
  planEnabled = mode === "plan",
): string | null {
  if (!planEnabled) return null;

  const { foundRuntimeModeReminder, humanTurnsSinceReminder } =
    getRuntimeModeReminderTurnCount(entries);
  if (
    foundRuntimeModeReminder &&
    humanTurnsSinceReminder < RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  ) {
    return null;
  }

  const nextReminderCount = countRuntimeModeReminders(entries) + 1;
  const reminderLines =
    nextReminderCount % RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1
      ? PLAN_MODE_FULL_REMINDER
      : PLAN_MODE_SPARSE_REMINDER;
  return reminderLines.join("\n");
}

/**
 * 生成“已退出 Plan 模式”提醒正文（一次性）。
 * 输出：解除只读限制的文本。副作用：无。
 */
export function buildPlanModeExitReminderBody(): string {
  return PLAN_MODE_EXIT_REMINDER.join("\n");
}

/**
 * 生成 output style 提醒正文。
 * 输入：输出样式配置。
 * 输出：简短提醒；未配置或 prompt 空白时 null。
 * 语义：只提醒“遵循该样式”，具体正文由样式 prompt 负责，避免重复注入。
 * 副作用：无。
 */
export function buildRuntimeOutputStyleReminderBody(
  outputStyle: OutputStylePromptConfig | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) {
    return null;
  }

  return `${outputStyle.name} output style is active. Remember to follow the specific guidelines for this style.`;
}

/**
 * 把 todo 列表格式化为 “序号. [status] content” 行。
 * 输入：todos。输出：string[]。副作用：无。
 */
function formatTodoListForReminder(todos: readonly TodoItem[]): string[] {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`);
}

/**
 * 统计“距上次 runtime_mode 提醒”的人类 turn 数。
 * 输入：entries。
 * 输出：{ foundRuntimeModeReminder, humanTurnsSinceReminder }。
 * 语义：从尾部向前，遇到 runtime_mode 附件即停；只把 source=real_user 的
 *   user 消息计入人类 turn（附件与 synthetic 用户消息不算）。
 * 副作用：无。
 */
function getRuntimeModeReminderTurnCount(entries: readonly RuntimeMessageEntry[]): {
  foundRuntimeModeReminder: boolean;
  humanTurnsSinceReminder: number;
} {
  let humanTurnsSinceReminder = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "runtime_mode") {
      return { foundRuntimeModeReminder: true, humanTurnsSinceReminder };
    }
    // 附件占条目位置但不是人类发言，不能计入 turn。
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "user" && entry.metadata?.source === "real_user") {
      humanTurnsSinceReminder++;
    }
  }
  return { foundRuntimeModeReminder: false, humanTurnsSinceReminder };
}

/**
 * 统计历史中已注入的 runtime_mode 提醒次数（用于全量 / 稀疏交替）。
 * 输入：entries。输出：次数。副作用：无。
 */
function countRuntimeModeReminders(entries: readonly RuntimeMessageEntry[]): number {
  return entries.reduce(
    (count, entry) => count + (entry.metadata?.source === "runtime_mode" ? 1 : 0),
    0,
  );
}
