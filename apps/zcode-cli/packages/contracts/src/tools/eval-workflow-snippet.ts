// ============================================================
// EvalWorkflowSnippet Tool - 同步编译并运行一段动态工作流片段（scratch facade）
// ============================================================
// 工作流创作的实验通道：
// 同一条编译 / lowering / 沙箱 / world-read 执行面，内存 journal，完全瞬态。

import { z } from "zod";
import { CreateWorkflowDiagnosticSchema } from "./create-workflow.js";
import { toToolJsonSchema } from "./json-schema.js";

/**
 * 工具名常量：注册表、display 诊断投影与动态工作流技能门按它查表。
 * 这是创作的实验通道，与 CreateWorkflow 的编译/执行面同源，但完全瞬态。
 */
export const EVAL_WORKFLOW_SNIPPET_TOOL_NAME = "EvalWorkflowSnippet";

/** snippet 墙钟缺省 60s；上限 600s（测真实构建类检查需要余量）。 */
/**
 * snippet 的墙钟三档：缺省 60s、下限 1s、上限 600s。core 的 handler 按
 * `timeoutMs` 解析后交给 harness；契约层同时用它生成模型描述与运行时校验，
 * 上限给真实构建类检查留余量，但不得再放大。
 */
export const EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS = 60_000;
export const EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS = 600_000;
export const EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS = 1_000;

/** 「恰好给一段片段」的违规说明（与另外三个工具同一种语气）。 */
/**
 * 来源 XOR 的违规文案：`code`（内联）与 `path`（整文件）必须恰好给一个。
 * 文案直接进模型可见错误，由 entry.validateInput 在模型入参上执行；
 * 片段没有保存定义那套语义，所以 `path` 文件是整段代码，不剥离元数据块。
 */
export const EVAL_WORKFLOW_SNIPPET_SOURCE_ERROR =
  "Provide exactly one snippet source: `code` for the snippet inline, or `path` for a file holding it. Passing both, or neither, is ambiguous.";

/**
 * EvalWorkflowSnippet 入参：`code` 或 `path` 恰好一个，`timeoutMs` 可选且被
 * 1s~600s 夹住。片段在内存 journal 上同步执行，不产生 run、不写工作区；
 * 与 CreateWorkflow 不同，这里不接受 args / 并发 / 模型等启动设定。
 */
export const EvalWorkflowSnippetInputSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .optional()
      .describe("The snippet, inline. This OR `path`, never both."),
    /**
     * 片段的第二条来源。**整个文件就是代码**：
     * 片段没有保存定义那套语义，一段恰好以 `/* zcode-workflow` 开头的文件也不该被当成声明块剥掉。
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe("A file holding the snippet, read whole. This OR `code`, never both."),
    timeoutMs: z
      .number()
      .int()
      .min(EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS)
      .max(EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS)
      .optional()
      .describe("Wall clock for the whole snippet, in ms. Default 60000, at most 600000."),
  })
  .strict();

/** 片段入参的 TS 视图；code/path 的 XOR 由 validateInput 保证，schema 只做单字段校验。 */
export type EvalWorkflowSnippetInput = z.infer<typeof EvalWorkflowSnippetInputSchema>;

/** 面对模型的 JSON schema；timeoutMs 的上下限写在字段描述里，运行时仍按 zod 夹取。 */
export const EvalWorkflowSnippetInputJsonSchema = toToolJsonSchema(EvalWorkflowSnippetInputSchema);

/**
 * 输出的三条界：log 条数 100、单条 2048 字符、顶层返回物序列化 256 KiB。
 * 全部在协议边界生效（service 侧截断并标注），保证瞬时执行也不会把
 * continuous/replayable 消息扩成无界载荷。
 */
// logs 的界（协议边界上的所有载荷有界）：条数 × 单条长度，超出在 service 侧截断并标注。
export const EVAL_WORKFLOW_SNIPPET_MAX_LOGS = 100;
export const EVAL_WORKFLOW_SNIPPET_MAX_LOG_CHARS = 2_048;
/** 顶层返回值序列化上限（harness 不量 artifact 体积——这道界属于 service/工具层）。 */
export const EVAL_WORKFLOW_SNIPPET_MAX_ARTIFACT_BYTES = 256 * 1024;

/**
 * 片段执行结果：`ok` 只在编译干净且正常 return 时为 true（诊断在场、超时、抛错、
 * 触达 cap 都是 false）；`logs` 按到达序且有界，`response` 是模型可见文本
 * （产物序列化 / 诊断列表 / 结构化失败），`durationMs` 是本次同步执行墙钟。
 */
export const EvalWorkflowSnippetOutputSchema = z
  .object({
    /** 编译干净且脚本正常 return 为 true；诊断在场或运行失败（超时 / 抛错 / cap）为 false。 */
    ok: z.boolean(),
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    /** 引擎 `log()` 事件按到达序捕获（有界；截断时最后一条是标注）。 */
    logs: z.array(z.string().max(EVAL_WORKFLOW_SNIPPET_MAX_LOG_CHARS)),
    /** 面向模型的文本：产物序列化 / 诊断列表 / 结构化失败（错误码 + message）。 */
    response: z.string(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

/** 片段输出的 TS 视图；诊断复用 CreateWorkflow 的形状，日志与产物都已按界裁剪。 */
export type EvalWorkflowSnippetOutput = z.infer<typeof EvalWorkflowSnippetOutputSchema>;

/** 面对模型的 JSON schema；与运行时 schema 同源，display 只投影诊断与短文本。 */
export const EvalWorkflowSnippetOutputJsonSchema = toToolJsonSchema(
  EvalWorkflowSnippetOutputSchema,
);
