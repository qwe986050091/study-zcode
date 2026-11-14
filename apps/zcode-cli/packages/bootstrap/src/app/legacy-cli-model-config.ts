import { z } from "zod";

// ============================================================
// 旧 CLI 用户配置（~/.zcode/config.json 一代）的私有解析边界
// ============================================================
// 只负责把“已发布的旧 JSON”校验成一份窄投影，供 personal-provider-importer 一次性迁入当前
// Config；这里不做任何 Config 决策，也不回写文件。字段用 zod 严格校验、未知字段 passthrough，
// 因为旧文件由不同版本的 CLI 写出，拒绝未知键会让整份升级输入无法读取。
// 旧 provider 的 models 允许 `id` 与键名两种身份、contextWindow 与 limit.context 两种口径，
// 具体取哪份由导入器决定（见 collectLegacyCliModelMembers）。

const stringRecordSchema = z.record(z.string(), z.string());
const unknownRecordSchema = z.record(z.string(), z.unknown());
const positiveNumberSchema = z.number().finite().positive();

const reasoningCapabilitySchema = z.object({
  enabled: z.boolean().optional(),
  levels: z.array(z.string().min(1)).optional(),
  defaultLevel: z.string().min(1).optional(),
  providerOptionsByLevel: z.record(z.string(), unknownRecordSchema).optional(),
});

const providerModelSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    attachment: z.boolean().optional(),
    reasoning: z.union([z.boolean(), reasoningCapabilitySchema]).optional(),
    tool_call: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    supportsImages: z.boolean().optional(),
    supportsPdf: z.boolean().optional(),
    supportsVideo: z.boolean().optional(),
    supportsToolCall: z.boolean().optional(),
    supportsJsonSchemaOutput: z.boolean().optional(),
    contextWindow: positiveNumberSchema.optional(),
    maxOutputTokens: positiveNumberSchema.optional(),
    limit: z
      .object({
        context: positiveNumberSchema.optional(),
        output: positiveNumberSchema.optional(),
      })
      .optional(),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])).optional(),
      })
      .optional(),
    options: unknownRecordSchema.optional(),
    headers: stringRecordSchema.optional(),
  })
  .passthrough();

const providerSchema = z
  .object({
    kind: z.enum(["anthropic", "openai", "openai-compatible"]),
    name: z.string().min(1).optional(),
    npm: z.never().optional(),
    options: z
      .object({
        // 已发布配置用空字符串表示尚未填写 Key，不能因此拒绝整份升级输入。
        apiKey: z.string().optional(),
        baseURL: z.string().min(1).optional(),
        apiKeyRequired: z.boolean().optional(),
        headers: stringRecordSchema.optional(),
      })
      .passthrough()
      .optional(),
    headers: stringRecordSchema.optional(),
    models: z.record(z.string(), providerModelSchema).optional(),
  })
  .passthrough();

const modelSelectionSchema = z.string().refine((value) => parseModelTarget(value) !== undefined, {
  message: "Model references must use provider/model format",
});
const legacyRootSchema = z
  .object({
    provider: z.record(z.string(), providerSchema).optional(),
    model: z
      .union([
        modelSelectionSchema,
        z
          .object({
            main: modelSelectionSchema.optional(),
            lite: modelSelectionSchema.optional(),
          })
          .strict()
          .refine((value) => value.main !== undefined || value.lite !== undefined),
      ])
      .optional(),
    small_model: z.never().optional(),
  })
  .passthrough();

type LegacyRoot = z.infer<typeof legacyRootSchema>;
/** 旧文件里 `provider.<id>` 条目的已校验形状（kind 决定 API 类型，models 以键名为默认 id）。 */
export type LegacyCliProvider = NonNullable<LegacyRoot["provider"]>[string];

/**
 * 旧配置解析后的唯一可用投影：`main` / `lite` 已拆成 `{provider, model}`，provider 原样保留
 * 已校验条目。所有字段都可缺席——旧文件可以只有 provider、只有 model，或两者都没有。
 * 解析结果只允许立即交给导入器，不进入 runtime 配置层，避免旧格式渗进新 Config 的类型面。
 */
export interface LegacyCliModelConfigProjection {
  readonly model?: {
    readonly main?: { readonly provider: string; readonly model: string };
    readonly lite?: { readonly provider: string; readonly model: string };
  };
  readonly provider?: Readonly<Record<string, LegacyCliProvider>>;
}

/** 已发布旧 CLI JSON 的最小私有解析边界；结果只能立即导入当前 Config。 */
/**
 * 输入是未经信任的 `unknown`（整份文件 JSON），先过 zod：provider kind / 模型引用格式 /
 * positive 数字等结构错误直接 throw（ZodError），由调用方决定是否把整次迁移放弃。
 * `model` 容忍两种已发布形状：字符串（单 main）与 `{main?, lite?, small_model}`；字符串只当
 * main。provider/model 的引用必须是 `provider/model`（第一段斜杠后整段是模型 id）。
 * 输出字段缺席表示旧文件没写，绝不用空对象占位——否则导入器会造出半份 Personal 配置。
 */
export function parseLegacyCliModelConfig(value: unknown): LegacyCliModelConfigProjection {
  const parsed = legacyRootSchema.parse(value);
  const rawModel = parsed.model;
  const main =
    typeof rawModel === "string" ? parseModelTarget(rawModel) : parseModelTarget(rawModel?.main);
  const lite = typeof rawModel === "object" ? parseModelTarget(rawModel?.lite) : undefined;
  const model = main || lite ? { ...(main ? { main } : {}), ...(lite ? { lite } : {}) } : undefined;
  return {
    ...(model ? { model } : {}),
    ...(parsed.provider ? { provider: parsed.provider } : {}),
  };
}

function parseModelTarget(value: string | undefined) {
  if (!value) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const provider = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  if (!provider || !model) return undefined;
  return {
    provider,
    model,
  };
}
