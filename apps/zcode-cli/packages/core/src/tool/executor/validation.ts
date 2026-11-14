/**
 * ============================================================================
 * executor/validation.ts —— 工具输入/输出的 schema 校验
 * ============================================================================
 *
 * 【三个入口】
 *   validateInput                Hook/权限修改后的输入校验(失败只回灌 modelContent);
 *   validateInitialModelToolInput 模型原始参数首次校验(失败时附带 JSON 细节,便于模型自修复);
 *   validateOutput               工具输出校验(先 runtimeOutputSchema,再 outputSchema;
 *                                 失败视为不可恢复的 ToolExecutionFailed)。
 *
 * 【为什么首次校验更"详细"】
 *   模型发出的非法参数需要具体字段/类型提示才能修;而 hook/权限改过的输入属于不同生命周期,
 *   不能再套用"模型原始参数"的解释文案。
 * ============================================================================
 */
import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";
import type { RuntimeInputValidationIssue } from "../input-normalization.js";
import { createInitialInputValidationModelContent } from "../input-validation-model-content.js";
import { validateJsonSchemaValue } from "../json-schema.js";
import type { ToolEntry } from "../types.js";

const INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY = "initialInputValidationModelContent";

/**
 * 校验工具输出。优先级:runtimeOutputSchema(可 safeParse 的运行时 schema)
 * → outputSchema(JSON Schema)。失败抛不可恢复错误,避免坏结果进入模型历史。
 *
 * 三态语义:
 *   - true      → runtime schema 存在且通过,直接返回,不再跑 JSON Schema;
 *   - string[]  → runtime schema 存在但失败,携带 issues 抛错;
 *   - undefined → 没有 runtime schema,继续走 outputSchema。
 * 为什么 recoverable:false:输出不合规说明工具实现或输入有根本问题,
 * 让模型带着坏结果继续对话只会污染历史;必须让这次调用显式失败。
 * errors 截断到 20 条:避免巨大 issue 列表撑爆事件 payload(模型也读不完)。
 */
export function validateOutput(output: unknown, entry: ToolEntry): void {
  const runtimeSchemaValidation = validateRuntimeSchema(output, entry.runtimeOutputSchema);
  // runtime schema 命中即短路：safeParse 的类型收窄比 JSON Schema 更精确，
  // 通过后不再跑 outputSchema，避免同一字段被两套规则重复判定。
  if (runtimeSchemaValidation === true) return;
  // runtime schema 存在但失败：直接抛错，不回落 outputSchema。
  // 回落会让运行时断言的强约束被宽松的 JSON Schema 放过，破坏 handler 的类型假设。
  if (Array.isArray(runtimeSchemaValidation)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Tool output failed runtimeOutputSchema validation",
      {
        context: {
          errors: runtimeSchemaValidation.slice(0, 20),
          toolName: entry.metadata.name,
        },
        recoverable: false,
      },
    );
  }

  const validation = validateJsonSchemaValue(output, entry.outputSchema);
  if (validation.valid) return;

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool output failed outputSchema validation",
    {
      context: {
        errors: validation.errors.slice(0, 20),
        toolName: entry.metadata.name,
      },
      recoverable: false,
    },
  );
}

function validateRuntimeSchema(output: unknown, schema: unknown): true | string[] | undefined {
  // 没有 runtime schema 返回 undefined，让调用方继续走 outputSchema。
  // 返回 undefined 而非 false：三态语义需要区分"无 schema"和"schema 失败"。
  if (!isSafeParseSchema(schema)) return undefined;
  const parsed = schema.safeParse(output);
  if (parsed.success) return true;
  return parsed.error.issues.map((issue) => issue.message);
}

function isSafeParseSchema(schema: unknown): schema is {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ message: string }> } };
} {
  // 鸭子类型而非 instanceof：runtimeOutputSchema 可能来自跨包的 zod 实例，
  // 用 instanceof 会因为双份 zod 拷贝判 false；只检查 safeParse 方法形状即可。
  return (
    typeof schema === "object" &&
    schema !== null &&
    "safeParse" in schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

/** 校验(Hook/权限修改后的)执行输入;失败返回可恢复错误,由调用方回灌模型。 */
export function validateInput(input: unknown, entry: ToolEntry): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  // 通过即返回 undefined：调用方据此判断是否继续执行。
  // 返回 Error 而非抛错：输入校验失败是"可恢复"的，调用方需要把错误回灌模型让其修正，
  // 抛错会被上层 catch 转成不可恢复的 ToolExecutionFailed，模型失去自修复机会。
  if (validation.valid) return undefined;

  // 不附带 initial 校验的详细 modelContent:这份输入不是模型原始声明,
  // 很可能是 hook/权限调整产生的,套用"你写错了参数"的文案会让模型误判责任方。
  // recoverable:true —— 让模型有机会在下一轮换一个调用方式。
  return createInputValidationError(entry, validation.errors);
}

/**
 * 校验模型原始参数(执行开始前第一次校验)。
 * 失败时生成 provider-visible 的详细 modelContent(schema/路径/类型),帮助模型自修复;
 * 该内容通过错误 context 透传,由 executor 写入 ToolCallError。
 *
 * 与 validateInput 共用同一个错误工厂,区别只在是否附带 modelContent:
 * 用一个哨兵 context key 承载详细文案,避免再造一种 CoreErrorType
 * (上层/遥测按类型分桶,新增类型会破坏既有映射)。
 */
export function validateInitialModelToolInput(
  input: unknown,
  entry: ToolEntry,
  runtimeValidationIssues?: readonly RuntimeInputValidationIssue[],
): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  // 首次校验通过即放行：后续 hook/权限改动后会再跑 validateInput，
  // 这里不缓存结果，确保改动后的输入被重新校验。
  if (validation.valid) return undefined;

  // 模型原始参数的首次 schema 失败需要把具体问题回传给模型；Hook 或权限
  // 修改后的输入属于不同生命周期，不能复用这段 provider-visible 内容。
  const modelContent = createInitialInputValidationModelContent(
    entry,
    validation.issues,
    runtimeValidationIssues,
  );
  return createInputValidationError(entry, validation.errors, modelContent);
}

/**
 * 从错误 context 里取出"给模型看的详细校验文案"。
 * 只认 CoreError + ToolExecutionFailed:避免其他来源的 Error 带着同名 key
 * 被误读成 provider-visible 内容。
 */
export function getInitialInputValidationModelContent(error: Error): string | undefined {
  // 只认 CoreError + ToolExecutionFailed：其他错误类型可能碰巧携带同名 context key，
  // 误读会把无关内容塞进 provider-visible 文本，造成提示注入或误导模型。
  if (!isCoreError(error) || error.type !== CoreErrorType.ToolExecutionFailed) {
    return undefined;
  }
  const modelContent = error.context?.[INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY];
  return typeof modelContent === "string" ? modelContent : undefined;
}

function createInputValidationError(
  entry: ToolEntry,
  errors: string[],
  modelContent?: string,
): Error {
  // 统一的输入校验错误:ToolExecutionFailed + recoverable。
  // 选择 ToolExecutionFailed 而非 InvalidInput:上层只对前者做了完整的历史/事件处理,
  // 新增类型会让所有既有分支(遥测分桶、UI 文案)漏掉这类失败。
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool input failed inputSchema validation",
    {
      context: {
        errors: errors.slice(0, 20),
        toolName: entry.metadata.name,
        ...(modelContent === undefined
          ? {}
          : { [INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY]: modelContent }),
      },
      recoverable: true,
    },
  );
}
