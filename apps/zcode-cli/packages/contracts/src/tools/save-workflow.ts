// ============================================================
// SaveWorkflow Tool - 把一段 dwf 脚本连同元数据存成项目里的可复用定义
// ============================================================
// 本文件只声明入参/输出形状，不编译也不落盘。真实流程在 core 的 handlers/save-workflow.ts：
// validateInput（名字/来源互斥/内联哨兵）→ resolveInput（读 script_path、算落点/覆盖/遮蔽）
// → prepareApproval（能编译才弹确认窗）→ handler（编译 + 落盘）。
// 作用域口径：scope 由模型必填、无默认（project=依赖本仓库，global=不依赖）；落点 path、
// overwrite、shadowing 三个字段由 resolveInput 回填，模型不填，它们只是确认窗要展示的事实。
// 正文来源：script 与 script_path 恰好给一个；script_path 的元数据块会被丢弃，以本次调用的
// description/whenToUse/args 为准——用户批准的是这些字段，不是文件里那份。
// 结果口径：diagnostics 恒在；overwritten 只在真正写盘成功时出现，诊断-only 的结果不给它，
// 避免模型把 ok=false 误读成"覆盖成功"。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { CreateWorkflowDiagnosticSchema } from "./create-workflow.js";
import {
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SavedWorkflowArgsDeclarationSchema,
  SavedWorkflowScopeSchema,
  SavedWorkflowShadowingSchema,
} from "./saved-workflow.js";

// 工具注册名 "SaveWorkflow"，同时是权限规则（permission.patternSources=["toolName"]）、
// 新桌面确认窗富渲染的判别键（按 toolName 读归一化入参）、事件与遥测的投影键。改名会同时
// 打断这三处消费者，必须与 core handler 注册项的 metadata.name 保持一致。
export const SAVE_WORKFLOW_TOOL_NAME = "SaveWorkflow";

/**
 * 「恰好给一个正文来源」的违规说明。字段不叫 `path` 是因为 `path` 已经是本工具**解析回填的
 * 落点**（确认窗与 UI 读它），两个同名字段一个是输入一个是输出，只会让模型把保存目标当成
 * 源文件传进来。
 */
export const SAVE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous.";

// 只对**内联** `script` 生效的拒绝文案：正文已经以 `/* zcode-workflow` 开头时再存一次，
// 会写成"块套块"。`script_path` 来源刻意不查这条——草稿常从已保存定义拷出来，本来就带块，
// 而 resolveInput 会把块丢掉、只留正文，所以对它报错等于禁掉这条路径的主要用法。
/** 模型把自带 frontmatter 的脚本传进来时的业务失败说明。 */
export const SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR =
  "The `script` must be the workflow body only — it already starts with a `/* zcode-workflow` metadata block. Pass the metadata through the `description` / `whenToUse` / `args` fields instead; the block is written for you.";

// 运行时入参 schema，`.strict()` 让多传键成为可见校验错误。字段分三类，读它时必须分清：
// 1) 模型必填：name（文件安全标识，≤64）、description（单行用途）、scope（project/global，无默认）；
// 2) 模型可选：whenToUse、args、run_id（仅溯源），以及正文二选一的 script / script_path；
// 3) resolveInput 回填、模型不填：path（落点）、overwrite（是否覆盖）、shadowing（另一档同名事实）。
// provider 侧看到的是它的 JSON 投影，"恰好一个正文来源"的强制只发生在 core 的 validateInput。
export const SaveWorkflowInputSchema = z
  .object({
    // 名字同时是文件名，1..64 字符；字符集与 "."/".." 的拒绝由 isValidSavedWorkflowName
    // 在 validateInput 里二次把关（schema 只管长度，管不了路径穿越）。
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("File-safe identifier: letters, digits, dot, dash and underscore."),
    // 必填的单行用途，最终原样写进 frontmatter 的 description；列表页展示的就是它。
    description: z
      .string()
      .min(1)
      .describe("One line saying what the workflow does."),
    // 可选的选择判据（何时该用本 workflow）；缺省时 frontmatter 不写这个键，而不是写空串。
    whenToUse: z
      .string()
      .min(1)
      .optional()
      .describe("When this workflow is the right answer."),
    // 可选参数声明表（名字 → 声明）；写入 frontmatter 的 args，运行 saved 源时据此校验。
    args: SavedWorkflowArgsDeclarationSchema.optional().describe(
      "Argument declarations the script reads off `args`.",
    ),
    // 正文来源 A：内联脚本，不能带元数据块（validateInput 按哨兵前缀拒绝）。
    script: z
      .string()
      .optional()
      .describe(
        "The script body, inline, without a metadata block. This OR `script_path`, never both.",
      ),
    /**
     * 正文的第二条来源：一个已经在盘上的文件，
     * 通常是刚跑过的那份草稿。文件带元数据块时**块被丢掉**——元数据由本次调用的字段说了算，
     * 用户批准的是那些字段，不是文件里那一份。
     */
    script_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A file holding the script body, usually a draft a result named. This OR `script`, never both.",
      ),
    // 作用域由**模型**说出，不由系统猜——没有默认值，每次都要判断。判据中性：脚本是否
    // 引用本仓库的东西？是 → project，否 → global。
    scope: SavedWorkflowScopeSchema.describe(
      '"project" when the script depends on this repository; "global" when it depends on nothing in it. Required, no default.',
    ),
    /**
     * 溯源（docs/dynamic-workflow/launch.md「`SaveWorkflow`」）：本定义是从哪次 run 提炼来的。
     * **不是第三条正文来源**——正文仍只能来自 `script` / `script_path`，handler 也不读它。
     * 它唯一的作用是让那次 run 的完成卡认出自己已被保存
     * （docs/dynamic-workflow/transcript-and-notifications.md「Which workflow a run is saved as」），
     * 而这是模型存下来的定义与那次 run 之间**仅有的**持久联系：名字由模型另起，脚本被概括改写过，
     * 两者都联接不回去。
     */
    run_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Provenance only: the id of the run this workflow was distilled from, when saving a workflow that just ran. Pass it whenever you know it; it does not change what is saved.",
      ),
    // ——以下三个字段由 `resolveInput` 解析回填，模型不填——
    // 它们是**确认窗要展示的事实**：这次保存落到哪个文件、是不是一次覆盖、是否遮蔽了另一档。
    // 走入参而不是 display，是因为入参通道对每个客户端版本都是无 schema 的透传，旧桌面与
    // legacy v3 因此也能看到完整内容。
    /** 解析回填：文件落点。 */
    path: z.string().min(1).optional(),
    /** 解析回填：目标已存在，这次批准的是一次**覆盖**。 */
    overwrite: z.boolean().optional(),
    /** 解析回填：另一档已有同名定义（遮蔽事实，供确认窗展示）。缺席 = 无同名。 */
    shadowing: SavedWorkflowShadowingSchema.optional(),
  })
  .strict();

// schema 推导的内部类型。注意它包含 resolveInput 回填的 path/overwrite/shadowing，
// 因此 handler 拿到的 input 是"模型字段 + 解析回填字段"的并集，而不是模型的原始入参。
export type SaveWorkflowInput = z.infer<typeof SaveWorkflowInputSchema>;

// provider 可见的入参 JSON Schema，由运行时 schema 投影（归一化逻辑不投影）。因此模型看到
// 的 path/overwrite/shadowing 仍是可选字段，它们只为让旧桌面与 legacy v3 在确认窗里也能
// 读到"落到哪、是否覆盖"；真正强制"只有一个正文来源"的是 runtimeInputSchema 之外的 validateInput。
export const SaveWorkflowInputJsonSchema = toToolJsonSchema(SaveWorkflowInputSchema);

/**
 * 输出与 CreateWorkflow 的诊断形状共用一个 schema：两个工具跑的是**同一个**类型检查器，
 * 让模型在两处看到不同形状的诊断只会教它写两套解析。
 *
 * `overwritten` 只在真写了文件时出现——诊断-only 的结果没有"覆盖了没有"可言，发一个
 * `false` 会让模型以为落盘成功了。
 */
export const SaveWorkflowOutputSchema = z
  .object({
    // 类型检查器的诊断（与 CreateWorkflow 共用 CreateWorkflowDiagnosticSchema 形状）；
    // 空数组表示编过。编不过时整份输出仍走"成功返回"，只是 ok=false 且没有写盘。
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    // 脚本是否通过语法/类型检查。false 时**一个字节都没有写**，overwritten 也不会在场。
    ok: z.boolean(),
    // 给模型的一句人话（已保存/已替换 + 落点 + 如何再跑）；formatModelContent 只回显它。
    response: z.string(),
    // 原样回显模型给的 name（不是文件名；文件名由 path 给出）。
    name: z.string().min(1),
    // 实际落盘的作用域，与入参 scope 一致（resolveInput 只按它选根，不切档）。
    scope: SavedWorkflowScopeSchema,
    /** 文件落点（未写成时是**本该**写到的位置，让模型能把错误说清楚）。 */
    path: z.string().min(1),
    overwritten: z.boolean().optional(),
  })
  .strict();

// schema 推导的输出类型，handler 用 satisfies 构造。不变量：overwritten 只在 ok=true 且
// 文件确实写入成功后出现；诊断-only 的结果必须省略该键，避免模型把 ok=false 读成"覆盖成功"。
export type SaveWorkflowOutput = z.infer<typeof SaveWorkflowOutputSchema>;

// provider/回放侧的输出 JSON Schema。字段演进必须与运行时 schema 同步：formatModelContent
// 在 schema 不匹配时只回固定占位（落盘已发生，不能因序列化失败把成功改写成工具失败）。
export const SaveWorkflowOutputJsonSchema = toToolJsonSchema(SaveWorkflowOutputSchema);
