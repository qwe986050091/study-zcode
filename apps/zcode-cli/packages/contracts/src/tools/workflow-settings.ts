// ============================================================
// 确认窗里可调的两项 run 设置（CreateWorkflow / AmendWorkflow 共用）
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// 两个 schema，一去一回：
//   - `WorkflowAdjustableSettingsSchema`：`resolveInput` 回填进入参的事实，告诉确认窗「这个 agent 会应用
//     你在窗里改的值」以及本机天花板。
//   - `WorkflowSettingsAdjustmentSchema`：用户按 Allow 时应答 `content` 里带回来的改动。
//
// 回填块走**入参通道**而不是 `create_workflow` display：display 的字段集是冻结的（见
// tool-result-metadata.ts 上的警告），多一个键会让严格解析它的客户端把整块连图一起丢掉；入参通道对
// 每个客户端版本都没有 schema。旧客户端不认这块就照旧画纯文本条件行，旧 agent 不写这块，新客户端
// 也就不提供一个它会丢掉的改动。
//
// 三态是两侧唯一共享的语义：键缺席 = 用户没改，`null` = 回到默认，有值 = 用户设定。
// 回填块（WorkflowAdjustableSettings / WorkflowModelBindings）只读可信——由 resolveInput
// 覆盖写入，模型的 JSON schema 看不到它；应答块（WorkflowSettingsAdjustment）不可信——
// 来自客户端，解析侧只取认得的键，任何不认识的内容都被丢弃而不是让整份改动作废。
// 本文件不负责执行改动：解析结果交给 run 侧回填，键名 `concurrency_ceiling` 是历史遗留
// 的读侧名字，写侧对应 `max_concurrency`，两侧不要"顺手改名"。

import { z } from "zod";

/** 规范形 `providerId/modelId[$level]` 的长度上限（团队套餐的 providerId 是 UUID）。 */
const WORKFLOW_SETTINGS_MAX_MODEL_CHARS = 512;

/**
 * `resolveInput` 回填的「确认窗可调」事实。与 `script_line_offset`、`AmendWorkflow.predecessor` 同一个
 * 姿态：解析结果而不是可填的参数，模型的 JSON schema 不列它，模型硬填会被无条件覆盖。
 */
export const WorkflowAdjustableSettingsSchema = z
  .object({
    /** 宿主有模型目录、能解析确认窗里选的模型。false 时确认窗只让调上界，模型那一行是一句话。 */
    subagent_model: z.boolean(),
    /**
     * 默认并发 D（键名早于「默认并发」这个概念，为兼容旧端保留）；端口说不出来时缺席。它不是上限：
     * 步进器没有上界，只拿它写「默认 N」的提示与判「等于默认 = 不设自己的界」。
     */
    concurrency_ceiling: z.number().int().positive().optional(),
  })
  .strict();

// 回填块的 TS 投影：`subagent_model` 是"本机能否解析确认窗所选模型"的能力位，不是模型名；
// `concurrency_ceiling` 是展示用的默认并发读数（可能缺席），不代表硬上限。两个字段都只增不改。
export type WorkflowAdjustableSettings = z.infer<typeof WorkflowAdjustableSettingsSchema>;

// 绑定表条目上限（64）：只用来让"脚本点名的模型"这张表在 display/确认窗里有界，
// 不代表运行期实际并发或模型数量上限。超过时整个 record refine 失败，而不是静默截断。
/** 一个脚本最多能点名多少个不同的模型名（绑定表的条目上限）。远超任何真实脚本，只为让表有界。 */
export const WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES = 64;
/** 脚本里一个模型名的长度上限（名字是模型 id 或 `providerId/modelId[$level]`）。 */
const WORKFLOW_MODEL_NAME_MAX_CHARS = 512;

/**
 * 脚本点名的模型 → 规范形（docs/dynamic-workflow/launch.md「Models the script names」）：键是脚本
 * **逐字**写下的名字（不 trim：运行期 persona 里带的就是这个串），值是 `providerId/modelId[$level]`。
 *
 * 与 {@link WorkflowAdjustableSettingsSchema} 同一个姿态、同一条通道：`resolveInput` 回填进入参，
 * 模型的 JSON schema 不列它，模型硬填会被无条件覆盖。确认窗不逐名画它（脚本的选择就是作者模型的
 * 决定），只据它在场把模型那一句改口成「子代理默认运行在」；应答里也没有改它的字段。
 */
export const WorkflowModelBindingsSchema = z
  .record(
    z.string().min(1).max(WORKFLOW_MODEL_NAME_MAX_CHARS),
    z.string().trim().min(1).max(WORKFLOW_SETTINGS_MAX_MODEL_CHARS),
  )
  .refine((bindings) => Object.keys(bindings).length <= WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES, {
    message: `at most ${WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES} model names`,
  });

// 绑定表的 TS 投影：键是脚本逐字写下的模型名（不 trim），值是规范形 `providerId/modelId[$level]`。
// 键集合只来自解析脚本的结果，不来自模型或用户输入；同名模型天然只占一条，值恒为规范形。
export type WorkflowModelBindings = z.infer<typeof WorkflowModelBindingsSchema>;

/**
 * 用户在确认窗里改过的设置，即 Allow 应答的 `content`。用工具自己的字段名与三态：省略 = 没改，
 * `null` = 回到默认（会话模型 / 默认并发），值 = 设定——与 `AmendWorkflow` 模型面的三态逐字同规，
 * 所以 agent 侧只有一套解析。
 *
 * 刻意**不** strict：应答来自客户端，broker 只取认得的两个键、丢掉其余，而不是因为一个它不认识的
 * 键就把用户的两项改动一起作废。
 */
export const WorkflowSettingsAdjustmentSchema = z.object({
  subagent_model: z
    .string()
    .trim()
    .min(1)
    .max(WORKFLOW_SETTINGS_MAX_MODEL_CHARS)
    .nullable()
    .optional(),
  max_concurrency: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional(),
});

// 应答改动的 TS 投影。两个键都是三态（缺省/ null / 值），解析后只保留用户真正改过的键；
// 空对象不会被返回（parse 归一成 undefined），调用方只需要判断有无改动，不必再判空。
export type WorkflowSettingsAdjustment = z.infer<typeof WorkflowSettingsAdjustmentSchema>;

// 解析客户端 Allow 应答里的 `content`。输入未知、可能来自旧版客户端，返回 undefined 表示：
// 形状不合法，或一个认得的键都没有——两者都按"用户没改"处理，不抛错、不部分应用。
// 由于 schema 非 strict，多余的键在 parse 阶段即被剥离，不会进入返回值。
/** 解析一份应答 `content`：认得的键组成的改动；不合形状或一个键都没有即 `undefined`。 */
export function parseWorkflowSettingsAdjustment(
  content: unknown,
): WorkflowSettingsAdjustment | undefined {
  const parsed = WorkflowSettingsAdjustmentSchema.safeParse(content);
  if (!parsed.success) return undefined;
  const adjustment: WorkflowSettingsAdjustment = {};
  if (parsed.data.subagent_model !== undefined) {
    adjustment.subagent_model = parsed.data.subagent_model;
  }
  if (parsed.data.max_concurrency !== undefined) {
    adjustment.max_concurrency = parsed.data.max_concurrency;
  }
  return Object.keys(adjustment).length === 0 ? undefined : adjustment;
}
