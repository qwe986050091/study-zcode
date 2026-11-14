// ============================================================
// AskUserQuestion Tool - user clarification questions
// ============================================================
// References: interactive clarification tool behavior

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

/**
 * 工具名常量：注册表、权限规则、TUI 交互与 display 行渲染都以它查表；
 * 改名等于换一个工具，历史 transcript 的行不会再被识别。
 */
export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
/**
 * header chip 的字符宽度上限（12），同时用于 schema 描述与 UI 截断；
 * 两侧共用一个值，避免模型按描述写满而界面裁掉半句。
 */
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12;

const HTML_PREVIEW_MARKER_PATTERN = /<!doctype\b|<!--|<\/?\s*[a-z][a-z0-9:-]*(?:\s[^<>]*)?>/i;
const HTML_PREVIEW_TAG_PATTERN = /<\/?\s*[a-z][a-z0-9:-]*(?:\s[^<>]*)?>/i;
const HTML_PREVIEW_DOCUMENT_PATTERN = /<!doctype\b|<\/?\s*(?:html|body)\b/i;
const HTML_PREVIEW_SCRIPT_STYLE_PATTERN = /<\/?\s*(?:script|style)\b/i;

/**
 * 单个选项：`label` 是用户看到的短文本，`description` 解释取舍，`preview` 可选且
 * 只在聚焦时渲染。preview 若像 HTML，必须是片段：禁止 doctype/html/body/script/style，
 * 且至少含一个标签——校验在 schema 层完成，交互层不再兜底解析。
 */
export const AskUserQuestionOptionSchema = z
  .object({
    label: z
      .string()
      .describe(
        "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
      ),
    description: z
      .string()
      .describe(
        "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
      ),
    preview: z
      .string()
      .optional()
      .describe(
        "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
      ),
  })
  .strict()
  .superRefine((option, context) => {
    if (option.preview !== undefined) {
      validateAskUserQuestionPreview(option.preview, context);
    }
  });

/** 选项的 TS 视图；preview 已过片段校验，渲染层可直接当受控 HTML 使用。 */
export type AskUserQuestionOption = z.infer<typeof AskUserQuestionOptionSchema>;

/**
 * 一道问题：`question` 原文是跨阶段唯一键（answers/annotations 都以它为键，故全量
 * 问题文本必须唯一，一旦发出即冻结）；`header` 是 chip，`options` 2-4 个且 label 唯一，
 * `multiSelect` 默认 false。客户端会自动补 “Other”，schema 明确拒绝模型自带。
 */
export const AskUserQuestionSchema = z
  .object({
    question: z
      .string()
      .describe(
        'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
      ),
    header: z
      .string()
      .describe(
        'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
      ),
    options: z
      .array(AskUserQuestionOptionSchema)
      .min(2)
      .max(4)
      .describe(
        "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
      ),
    multiSelect: z
      .boolean()
      .default(false)
      .describe(
        "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
      ),
  })
  .strict()
  .superRefine((question, context) => {
    const labels = question.options.map((option) => option.label);
    if (labels.length !== new Set(labels).size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Option labels must be unique within each question",
        path: ["options"],
      });
    }

    if (labels.some((label) => label.trim().toLowerCase() === "other")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Do not include an Other option; clients provide it automatically",
        path: ["options"],
      });
    }
  });

/** 问题的 TS 视图；`multiSelect` 在 zod 层已有 default，运行时读到的是布尔而非 undefined。 */
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;

/**
 * 用户对某道题的附加信息：`preview` 回显所选选项的预览内容，`notes` 是自由文本。
 * 与 answers 同键（问题原文），只由交互层回填，模型不可伪造。
 */
export const AskUserQuestionAnnotationSchema = z
  .object({
    preview: z
      .string()
      .optional()
      .describe("The preview content of the selected option, if the question used previews."),
    notes: z.string().optional().describe("Free-text notes the user added to their selection."),
  })
  .strict();

/** 注解的 TS 视图；两个字段都可缺席，缺席表示用户没提供对应信息。 */
export type AskUserQuestionAnnotation = z.infer<typeof AskUserQuestionAnnotationSchema>;

const AskUserQuestionMetadataSchema = z
  .object({
    source: z
      .string()
      .optional()
      .describe(
        'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
      ),
  })
  .strict();

/**
 * 工具入参（模型发出的“未回答”形态）：1-4 道题，答案与注解均为可选。
 * `answers` 以问题原文为键，值为选中 label 或用户自由文本；`metadata.source`
 * 只用于分析埋点、不展示给用户。问题文本在整批内必须唯一，否则拒绝。
 */
export const AskUserQuestionInputSchema = z
  .object({
    questions: z
      .array(AskUserQuestionSchema)
      .min(1)
      .max(4)
      .describe("Questions to ask the user (1-4 questions)"),
    answers: z
      .record(z.string())
      .optional()
      .describe("User answers collected by the permission component"),
    annotations: z
      .record(AskUserQuestionAnnotationSchema)
      .optional()
      .describe(
        "Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.",
      ),
    metadata: AskUserQuestionMetadataSchema.optional().describe(
      "Optional metadata for tracking and analytics purposes. Not displayed to user.",
    ),
  })
  .strict()
  .superRefine((input, context) => {
    const questions = input.questions.map((question) => question.question);
    if (questions.length !== new Set(questions).size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question texts must be unique",
        path: ["questions"],
      });
    }
  });

/** 入参的 TS 视图；answers/annotations 的键是运行时冻结的问题原文。 */
export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

/**
 * “已回答”形态的运行时校验，handler 只接受这一形态：`answers` 字段必须存在
 * （可以是空对象，表示用户跳过），但任何空字符串答案都拒绝。
 * 冻结键仍是问题原文；permission 阶段尚未回填答案时缺字段，handler 因此不得执行。
 */
export const AskUserQuestionAnsweredInputSchema = AskUserQuestionInputSchema.superRefine(
  (input, context) => {
    // 问题用于可选澄清，用户可以完整、部分或零回答；只有 answers 字段
    // 完全缺失才表示 permission 阶段尚未完成，必须阻止 handler 提前执行。
    if (input.answers === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Answers have not been collected yet",
        path: ["answers"],
      });
      return;
    }
    for (const [question, answer] of Object.entries(input.answers)) {
      if (answer.trim().length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Blank answer is not allowed for question: ${question}`,
          path: ["answers", question],
        });
      }
    }
  },
);

/**
 * 输出：原样带回问题列表、答案与可选注解，三者都以问题原文为键。
 * 零答案合法（用户跳过），模型文案必须区分“跳过”与“未回答”，不得臆造偏好。
 */
export const AskUserQuestionOutputSchema = z
  .object({
    questions: z.array(AskUserQuestionSchema).min(1).max(4),
    answers: z.record(z.string()).describe("User answers keyed by question text."),
    annotations: z
      .record(AskUserQuestionAnnotationSchema)
      .optional()
      .describe("Optional per-question annotations keyed by question text."),
  })
  .strict();

/** 输出的 TS 视图；answers 恒在场（可为空对象），annotations 按需出现。 */
export type AskUserQuestionOutput = z.infer<typeof AskUserQuestionOutputSchema>;

/**
 * 面对模型的入参 JSON schema：multiSelect 带 default false，但仍被投影进 required。
 * 这是 provider 可见面的刻意口径（见下方 withRequiredDefaultedMultiSelect）；运行时
 * Zod default 继续容忍旧调用省略，两侧并不矛盾。
 */
export const AskUserQuestionInputJsonSchema = withRequiredDefaultedMultiSelect(
  toToolJsonSchema(AskUserQuestionInputSchema),
);

/** 面对模型的输出 JSON schema；只做投影，不改变运行时校验口径。 */
export const AskUserQuestionOutputJsonSchema = toToolJsonSchema(AskUserQuestionOutputSchema);

function withRequiredDefaultedMultiSelect<T extends Record<string, unknown>>(schema: T): T {
  const questionItem = readSchemaPath(schema, ["properties", "questions", "items"]) as
    | Record<string, unknown>
    | undefined;
  if (!questionItem) return schema;

  const required = questionItem.required;
  if (!Array.isArray(required)) return schema;

  // provider-visible schema 中 multiSelect 有 default false，
  // 但仍出现在 required 中；运行时 Zod default 继续允许旧调用省略该字段。
  if (!required.includes("multiSelect")) {
    required.push("multiSelect");
  }
  return schema;
}

function readSchemaPath(schema: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = schema;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateAskUserQuestionPreview(preview: string, context: z.RefinementCtx): void {
  if (!HTML_PREVIEW_MARKER_PATTERN.test(preview)) {
    return;
  }

  if (HTML_PREVIEW_DOCUMENT_PATTERN.test(preview)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "HTML preview must be a fragment without html, body, or doctype",
      path: ["preview"],
    });
  }

  if (HTML_PREVIEW_SCRIPT_STYLE_PATTERN.test(preview)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "HTML preview cannot contain script or style tags",
      path: ["preview"],
    });
  }

  if (!HTML_PREVIEW_TAG_PATTERN.test(preview)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "HTML preview must contain an HTML tag",
      path: ["preview"],
    });
  }
}
