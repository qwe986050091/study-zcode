// ============================================================
// AskUserQuestion Tool Handler
// ============================================================
//
// 【定位】本文件不发起任何交互：提问与等待答案由 executor / 交互层完成，handler 只断言
//   "答案已注入"并整形结果。所以缺 answers 时抛的是 recoverable 的 ToolExecutionFailed，
//   而不是在 handler 里阻塞等待——否则整个工具调用链会被一次提问挂住。
//
// 【输入/输出口径】questions 是问题数组（question/header/options/multiSelect/preview）；
//   answers 以「问题原文」为键（question → 选中 label 或用户自由文本），annotations 携带
//   preview/notes。空 answers 表示用户跳过；此时结果文案明确要求模型不得臆造用户偏好。
//
// 【副作用与权限】无文件/命令/网络副作用；sideEffectScope=userInteraction，needsApproval
//   为真（每次提问都可能打断用户），requiresUserInteraction 让 executor 走交互通道。
// ============================================================

import {
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionAnsweredInputSchema,
  AskUserQuestionInputJsonSchema,
  AskUserQuestionInputSchema,
  AskUserQuestionOutputJsonSchema,
  AskUserQuestionOutputSchema,
  CoreErrorType,
  createCoreError,
  type AskUserQuestionOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_ASK_USER_QUESTION_MODEL_BYTES = 100_000;

const ASK_USER_QUESTION_DESCRIPTION =
  [
    "Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.",
    "",
    "Usage notes:",
    '- Users will always be able to select "Other" to provide custom text input',
    "- Use multiSelect: true to allow multiple answers to be selected for a question",
    '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
    "",
    'Plan mode note: To switch into plan mode, use EnterPlanMode (not this tool). Once in plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?", "Should I proceed?", or otherwise reference "the plan" in questions — the user cannot see the plan until you call ExitPlanMode for approval.',
    "",
    "Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.",
    "",
    "Preview feature:",
    "Use the optional `preview` field on options when presenting concrete artifacts that users need to visually compare:",
    "- ASCII mockups of UI layouts or components",
    "- Code snippets showing different implementations",
    "- Diagram variations",
    "- Configuration examples",
    "",
    "Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).",
  ].join("\n") + "\n";

/**
 * handler 只接受"已回答"形态的输入：answers 由交互层回填到同一个 input 上。
 * 解析失败即视为"用户还没给答案就进了执行"，按可恢复失败返回，让 executor 把调用
 * 交回交互通道，而不是把缺失字段当参数错误。
 */
const askUserQuestionHandler: ToolHandler = async (input, context) => {
  const parsed = AskUserQuestionAnsweredInputSchema.safeParse(input);

  if (!parsed.success) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "AskUserQuestion requires user answers before execution",
      {
        context: {
          issues: parsed.error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path,
          })),
          toolCallId: context.toolCallId,
          toolName: ASK_USER_QUESTION_TOOL_NAME,
        },
        recoverable: true,
      },
    );
  }

  return {
    questions: parsed.data.questions,
    answers: parsed.data.answers ?? {},
    ...(parsed.data.annotations ? { annotations: parsed.data.annotations } : {}),
  } satisfies AskUserQuestionOutput;
};

/**
 * 入口口径：inputSchema 是"未回答"形态（questions 必填、answers 可选），runtimeInputSchema
 * 是"已回答"形态——两者并列是刻意的，前者给模型与权限预览，后者给 handler 运行时断言。
 * resultBudget 用 truncate 而非 artifact：答案本来就小，落盘反而把用户答案变成间接引用。
 * trace.propagateToAdapters=false：本工具不经过任何 adapter，没有下游 span 可挂。
 */
export const askUserQuestionToolEntry: ToolEntry = {
  capability:
    "Ask the user multiple-choice clarification questions and continue with their answers",
  requiresUserInteraction: true,
  metadata: {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: ASK_USER_QUESTION_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    requiresUserInteraction: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    sideEffectScope: "userInteraction",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: askUserQuestionHandler,
  formatModelContent: formatAskUserQuestionModelContent,
  inputSchema: AskUserQuestionInputJsonSchema,
  outputSchema: AskUserQuestionOutputJsonSchema,
  runtimeInputSchema: AskUserQuestionInputSchema,
  runtimeOutputSchema: AskUserQuestionOutputSchema,
  permission: {
    permission: "userInteraction.askQuestion",
    reason: "AskUserQuestion pauses execution to collect answers from the user",
    riskLevel: "low",
    sideEffectScope: "userInteraction",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    maxModelBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
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
    userVisibleMessage: "AskUserQuestion was cancelled before answers were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatAskUserQuestionModelContent(output: unknown): string {
  const result = output as AskUserQuestionOutput;
  if (Object.keys(result.answers).length === 0) {
    return "The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.";
  }
  const answersText = Object.entries(result.answers)
    .map(([questionText, answer]) => {
      const annotation = result.annotations?.[questionText];
      const parts = [`"${questionText}"="${answer}"`];
      if (annotation?.preview) {
        parts.push(`selected preview:\n${annotation.preview}`);
      }
      if (annotation?.notes) {
        parts.push(`user notes: ${annotation.notes}`);
      }
      return parts.join(" ");
    })
    .join(", ");

  // 部分作答是常态（用户可跳过单题）。这里显式告诉模型"哪几题没答"，是为了阻止它把
  // 未回答的题当成用户默认同意——文案里直接禁止 invent user preferences。
  const unansweredCount = result.questions.filter(
    (question) => !(question.question in result.answers),
  ).length;
  if (unansweredCount > 0) {
    return `The user answered some questions and skipped ${unansweredCount}. Provided answers: ${answersText}. Continue with the provided answers and use your best judgment for the unanswered questions; do not invent user preferences.`;
  }

  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`;
}
