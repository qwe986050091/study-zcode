// ============================================================
// Saved workflows - 保存的 dwf 定义的共享词汇表
// ============================================================
//
// 本模块**只**声明「一个保存的 workflow 是什么」：名字的合法形状、文件落点、参数声明与
// 元数据。三个工具（SaveWorkflow 写、ListSavedWorkflows 读、CreateWorkflow 以 `saved`
// 源运行）都以它为契约，core 侧的 store 也从这里取 schema——元数据形状一旦在写侧与读侧
// 各自演化，症状是「刚保存的 workflow 列不出来」，而那是最难被单侧测试抓住的一类分叉。

import { z } from "zod";

/**
 * 保存文件的扩展名。`.dwf.ts` 而不是 `.ts`：编辑器按 TypeScript 高亮（frontmatter 是块注释，
 * 语法上合法），而 `.dwf` 这一段让扫描不必打开文件就能把它与项目源码区分开。
 */
export const SAVED_WORKFLOW_FILE_EXTENSION = ".dwf.ts";

// 项目档的落点目录：<cwd>/.zcode/workflows。作用域由所在目录推得，frontmatter 不存 scope；
// 与全局档同名时项目档 first-wins（core 的 saved-workflows/store.ts 按 [project, global]
// 顺序查找，命中即停）。这里只是常量，真正的路径拼接在 savedWorkflowPath。
/** 项目作用域的存放目录（相对会话工作目录）。 */
export const SAVED_WORKFLOW_PROJECT_DIR = ".zcode/workflows";

/**
 * 草稿目录（相对会话工作目录）。模型在两次提交之间就地编辑的脚本文件落在这里，是
 * `.zcode/workflows/`（用户保存的定义）的兄弟目录，机器自有、自带 `.gitignore: *`。
 */
export const WORKFLOW_DRAFTS_DIR = ".zcode/workflow-drafts";

/**
 * 全局作用域的存放目录（相对 agent 进程的家目录）。落点 `~/.zcode/workflows/<name>.dwf.ts`
 * ——与 legacy Workflow 工具的用户根同一处，对所有项目可见。
 */
export const SAVED_WORKFLOW_GLOBAL_DIR = ".zcode/workflows";

/**
 * 名字的合法形状。与旧 `Workflow` 工具的解析器同一条模式（script-workflow-tool-port.ts）——
 * 名字要同时当文件名用，所以斜杠、`..`、空白一概不允许：这条正则**就是**路径穿越的防线，
 * 不是风格偏好。
 */
export const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;

// 与 SAVED_WORKFLOW_NAME_PATTERN 一起构成名字合法性：SaveWorkflow 入参 schema 的 .max()
// 与 isValidSavedWorkflowName 的长度检查都读它，store 侧的解析/枚举/移动也以它为准。
/** 名字长度上限。文件名要在各平台都成立，64 远在任何 PATH_MAX 之内且足够描述性。 */
export const SAVED_WORKFLOW_MAX_NAME_CHARS = 64;

/**
 * 作用域。两档：`project` 落在项目的 `.zcode/workflows/`，只在那个项目里可见；`global`
 * 落在 `~/.zcode/workflows/`（agent 进程的家目录），对所有项目可见。一个文件的作用域由它所在的目录推得，frontmatter 不存。
 */
export const SAVED_WORKFLOW_SCOPES = ["project", "global"] as const;

// 作用域的运行时校验面。z.enum 直接从 SAVED_WORKFLOW_SCOPES 取字面量，保证"词汇表"只有
// 一个来源；frontmatter 不存 scope，它的值恒由文件所在目录推得（savedWorkflowRoots）。
export const SavedWorkflowScopeSchema = z.enum(SAVED_WORKFLOW_SCOPES);

// schema 推导的类型，跨契约/工具/store 签名共用。档位只有两个，provider 与持久化侧不得
// 自行扩展第三个值——写入侧用同一枚举选根，读取侧用目录反推，两处必须闭合。
export type SavedWorkflowScope = z.infer<typeof SavedWorkflowScopeSchema>;

/**
 * 遮蔽事实：另一档已有同名定义。保存时算出，供确认窗展示。
 * `hides_global`：这次保存的是项目档，它会在本项目里遮蔽同名的全局档；
 * `hidden_by_project`：这次保存的是全局档，本项目已有同名的项目档会遮蔽它。
 */
export const SAVED_WORKFLOW_SHADOWING = ["hides_global", "hidden_by_project"] as const;

// 遮蔽事实的运行时校验面。它只出现在 SaveWorkflow 的**归一化入参**（确认窗展示），
// 不落盘、不进 frontmatter；列表读取时 first-wins 已经把遮蔽吸收成"同名只留一份"。
export const SavedWorkflowShadowingSchema = z.enum(SAVED_WORKFLOW_SHADOWING);

// schema 推导的类型。两个方向语义不对称：hides_global 是项目档遮同名的全局档，
// hidden_by_project 是全局档被同名的项目档遮——消费者必须结合 scope 判断方向，
// 不能把它当成"有无遮蔽"的布尔值。
export type SavedWorkflowShadowing = z.infer<typeof SavedWorkflowShadowingSchema>;

/**
 * 参数的类型词汇表。三个原语加一个 `json` 兜底：原语能被校验成"传错了"，`json` 明确表示
 * "这里什么都收"，于是「没校验」与「不校验」在声明里就是两件不同的事，而不是同一个洞。
 */
export const SAVED_WORKFLOW_ARG_TYPES = ["string", "number", "boolean", "json"] as const;

// 参数类型的运行时校验面，从 SAVED_WORKFLOW_ARG_TYPES 取字面量。它既是 frontmatter 的
// 持久化词汇表，也是 CreateWorkflow(saved 源) 与 SaveWorkflow 两侧的同一份契约。
export const SavedWorkflowArgTypeSchema = z.enum(SAVED_WORKFLOW_ARG_TYPES);

// schema 推导的类型；`json` 是显式的"不做进一步校验"，与原语"能判对错"在声明层面可区分。
export type SavedWorkflowArgType = z.infer<typeof SavedWorkflowArgTypeSchema>;

// 单个参数的声明，`.strict()` 让拼错的键在读写两侧都成为可见失败（保存的文件会被手改）。
// 字段口径：type 决定运行时校验；description 只作文档；required 缺省为 false；
// default 刻意是 unknown，其类型正确性在**应用默认值之后**与传入值走同一条校验，
// 避免"默认值"与"实参"拥有两套规则。
export const SavedWorkflowArgDeclarationSchema = z
  .object({
    type: SavedWorkflowArgTypeSchema.describe(
      'Value type. "json" accepts any JSON value without further checking.',
    ),
    description: z
      .string()
      .optional()
      .describe("What this argument means, for whoever calls the workflow later."),
    required: z
      .boolean()
      .optional()
      .describe("When true the workflow cannot run without this argument."),
    // `default` 刻意是 unknown 而不是按 `type` 判别的联合：默认值的类型正确性由
    // validateWorkflowArgs 在**应用默认值之后**与传入值走同一条校验，一处规则而不是两处。
    default: z.unknown().optional().describe("Value used when the caller omits this argument."),
  })
  .strict();

// schema 推导的单参数声明类型；saved 源运行时把它与传入 args 做同一条校验，
// 并在同一处应用 default，因此消费者不需要另写一套默认值逻辑。
export type SavedWorkflowArgDeclaration = z.infer<typeof SavedWorkflowArgDeclarationSchema>;

// 参数表：名字 → 声明（z.record 不限键名，调用方按脚本读的 `args.<key>` 取用）。
// 它同时是 frontmatter `args:` 节点、SaveWorkflow 入参 args、SavedWorkflowEntry.args 的
// 唯一形状来源；任一侧单方面加字段都会让另一侧判 invalid。
export const SavedWorkflowArgsDeclarationSchema = z.record(SavedWorkflowArgDeclarationSchema);

// schema 推导的参数表类型；纯数据（可 JSON 序列化），不携带函数或懒加载语义。
export type SavedWorkflowArgsDeclaration = z.infer<typeof SavedWorkflowArgsDeclarationSchema>;

/**
 * frontmatter 里的元数据体。`.strict()` 让「拼错一个键」成为一条可见的 invalid 行，而不是
 * 一个被静默丢弃的字段——保存的文件是用户会手改的，错字必须能被指出来。
 */
export const SavedWorkflowMetaSchema = z
  .object({
    // 必填的用途描述，是列表与选择判据的主要来源；空串不合法。
    description: z.string().min(1),
    // 可选的选择判据；缺省时序列化不写出该键，而不是写一个空串。
    whenToUse: z.string().min(1).optional(),
    // 可选参数表，形状即 SavedWorkflowArgsDeclarationSchema；运行 saved 源时据此校验实参。
    args: SavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();

// schema 推导的元数据类型，等于 frontmatter 的 YAML 体。serializeSavedWorkflow 按
// description → whenToUse → args 的固定键序写出，保证同一内容重复保存逐字节一致。
export type SavedWorkflowMeta = z.infer<typeof SavedWorkflowMetaSchema>;

// 列表行的运行时形状（只读投影）：元数据 + 落点 + 作用域，**不含 script/source**，
// 因为枚举不等于读取，列表不应把正文带进模型上下文。
// 字段口径：name 是文件名去掉 .dwf.ts；path 是 absolute 落点（first-wins 后实际生效的那份）；
// scope 由所在目录推得；whenToUse/args 缺省时省略键，而不是给 undefined。
/** 列表里的一行：元数据 + 落点，**不含脚本正文**（枚举不是读取）。 */
export const SavedWorkflowEntrySchema = z
  .object({
    // 调用名（文件名去扩展名），已通过 isValidSavedWorkflowName。
    name: z.string().min(1),
    description: z.string(),
    whenToUse: z.string().optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
    // 实际生效的作用域；同名两档时它由 first-wins 的那一份决定。
    scope: SavedWorkflowScopeSchema,
    // 绝对落点，消费者可直接用来读文件或展示；不得重新拼接。
    path: z.string().min(1),
  })
  .strict();

// schema 推导的列表行类型；生产者是 core 的 listSavedWorkflows（深度 1、按名排序、
// 同名 first-wins），消费者是 ListSavedWorkflows 工具与宿主 UI。
export type SavedWorkflowEntry = z.infer<typeof SavedWorkflowEntrySchema>;

/**
 * 一个存在但读不出来的文件。列表**不因为一个坏文件而失败**：用户手改坏了一个 frontmatter
 * 时，其余 workflow 必须照常可用，而那个坏文件必须被指名道姓，否则它只是消失了。
 */
export const SavedWorkflowInvalidEntrySchema = z
  .object({
    // 出问题的文件绝对路径；目录本身不可读时是那个目录。
    path: z.string().min(1),
    // 人类可读原因（缺 frontmatter、YAML 坏、文件名非法、读失败等）；不映射成工具错误码。
    reason: z.string().min(1),
  })
  .strict();

// schema 推导的坏文件行类型；工具把它原样投影给模型，让用户能看到"哪个文件坏了"，
// 而不是让整份列表因为一个错字消失。
export type SavedWorkflowInvalidEntry = z.infer<typeof SavedWorkflowInvalidEntrySchema>;

// 名字是否可用作文件名，是路径穿越的**唯一**防线：先卡长度 1..64，再卡字符集
// （只允许字母/数字/./-/_），最后拒绝 "." 与 ".." 这类目录项。保存、解析、枚举、移动
// 四条路径都先调用它再拼路径（core saved-workflows/store.ts），顺序不能反。
// 纯函数；不访问文件系统，也不做 Unicode 归一化——非 ASCII 名字在设计上不接受。
/** 名字是否可用作文件名（即是否可能指向一个保存的 workflow）。 */
export function isValidSavedWorkflowName(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_MAX_NAME_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  // `.` 与 `..` 通过了上面的字符集检查却是目录项，不是名字。
  return name.replaceAll(".", "").length > 0;
}
