// INV-01 稀疏与完整两套 schema 成对存在：守住位置 每个 DataSchema 的稀疏与 complete 组合；改错故障 草稿态被完整校验挡住。
// INV-02 稀疏用 sparseShape 展开完整形状：守住位置 两处展开；改错故障 逐字段手写后与完整版漂移。
// INV-03 完整版只收紧不删键：守住位置 extend 调用；改错故障 新增字段在完整校验里被静默丢弃。
// INV-04 对象一律 strict：守住位置 所有 .strict()；改错故障 拼错的配置键被静默接受。
// INV-05 必填串先 trim 再判空：守住位置 nonBlankRequiredString；改错故障 纯空白通过校验。
// INV-06 必填失败带稳定 issue code：守住位置 refine 的 params；改错故障 UI 只能显示通用错误。
// INV-07 判别联合按 type 分流：守住位置 discriminatedUnion；改错故障 字段交叉组合出非法访问配置。
// INV-08 Personal 允许暂存未成形的 baseUrl：守住位置 personalProviderApiDataSchema；改错故障 编辑中的 endpoint 无法保存。
// INV-09 模型 id 列表只读且可空：守住位置 modelIdsDataSchema；改错故障 调用方原地修改配置对象。
// INV-10 模板配置复用 Provider 稀疏 schema：守住位置 providerTemplateDataSchema；改错故障 模板与实例校验口径分叉。
//
// 模块职责：Provider 配置的稀疏（草稿）与完整（准入）两套 zod 契约。
// 阅读顺序：先看枚举与必填串，再看访问与 API 的成对 schema，最后看 Provider 与模板形状。
import { z } from "zod";
import { sparseShape } from "@zcode/shared/config-schema";

export const providerApiTypeDataSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
export const providerGroupDataSchema = z.enum([
  "standard-personal",
  "zai-family",
  "bigmodel-family",
]);
export const zhipuAccountModeDataSchema = z.enum([
  "start-plan",
  "individual-coding-plan",
  "team-coding-plan",
  "off-peak",
  // 加速卡访问类别；与 zcodeProviderAccountAccessSchema.mode 同值，改动需同步两处。
  "highspeed",
]);
export const providerVisibilityDataSchema = z.enum(["visible", "hidden"]);
export const providerLogoDataSchema = z
  .object({ type: z.literal("builtin"), key: z.string().min(1) })
  .strict();

// trim 后为空即视为缺失，避免只输入空格的配置通过准入。
// issue code 是给 UI 定位字段用的稳定标识，不要随手改名。
// 这里只校验非空，URL 等格式由调用处继续 pipe。
const nonBlankRequiredString = z.string().refine((value) => value.trim().length > 0, {
  message: "必填配置不能为空",
  params: { configIssueCode: "required-field-missing" },
});

// 草稿态允许 apiKey 与管理地址都缺席。
// 访问类型决定后续按哪种方式解释其余字段，因此不可省略。
// apiKey 可空但不允许空串，空串会让下游误判为已配置。
// strict 保证拼错的键在校验期就暴露。
export const apiKeyAccessDataSchema = z
  .object({
    type: z.enum(["api-key", "zhipu-coding-plan-api-key"]),
    apiKey: z.string().nullable().optional(),
    apiKeyManagementUrl: z.string().url().nullable().optional(),
  })
  .strict();
export const completeApiKeyAccessDataSchema = apiKeyAccessDataSchema.extend({
  apiKey: nonBlankRequiredString,
});

// 完整版要求账号类型、模式与权益标记全部在场。
// mode 取值与高速通道共用同一个枚举，新增值要同步访问侧。
// 该形状同时被 sparseShape 展平成草稿版。
export const completeZhipuAccountAccessDataSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    mode: zhipuAccountModeDataSchema,
    entitled: z.boolean(),
  })
  .strict();
export const zhipuAccountAccessDataSchema = z
  .object({
    ...sparseShape(completeZhipuAccountAccessDataSchema.shape),
    type: completeZhipuAccountAccessDataSchema.shape.type,
  })
  .strict();
export const providerAccessDataSchema = z.discriminatedUnion("type", [
  apiKeyAccessDataSchema,
  zhipuAccountAccessDataSchema,
]);
export const completeProviderAccessDataSchema = z.discriminatedUnion("type", [
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
]);

export const completeProviderApiDataSchema = z
  .object({
    type: providerApiTypeDataSchema,
    baseUrl: nonBlankRequiredString.pipe(z.string().url()),
    headers: z.record(z.string(), z.string()).readonly().nullable().optional(),
  })
  .strict();
// 草稿版把 baseUrl 放宽为可空，允许编辑中途保存。
// 其余键仍来自完整形状，避免两版字段集分叉。
// 完整版仍然拒绝非法 URL，准入不受草稿放宽影响。
export const providerApiDataSchema = z
  .object({
    ...sparseShape(completeProviderApiDataSchema.shape),
    baseUrl: z.string().url().nullable().optional(),
  })
  .strict();
// Personal 允许暂存编辑中的 endpoint；完整 schema 仍拒绝，且只影响该 Provider 的准入。
export const personalProviderApiDataSchema = providerApiDataSchema.extend({
  baseUrl: z.string().nullable().optional(),
});

const modelIdsDataSchema = z.array(z.string().min(1)).readonly().nullable().optional();
// [契约] modelIdsDataSchema 同时用于 builtinModelIds 与 personalModelIds：readonly 禁就地改写，nullable 与 optional 兼容缺省配置。
// 分组、logo、访问方式与可见性都可以先不填。
// 完整版只把分组、访问与 API 三处收紧为必填。
// visible 与 hidden 之外的值不应进入持久化。
// strict 让多余键在持久化前就被拒，避免脏数据落盘。
export const providerConfigDataSchema = z
  .object({
    group: providerGroupDataSchema.nullable().optional(),
    logo: providerLogoDataSchema.nullable().optional(),
    access: providerAccessDataSchema.nullable().optional(),
    api: providerApiDataSchema.nullable().optional(),
    builtinModelIds: modelIdsDataSchema,
    personalModelIds: modelIdsDataSchema,
    modelOrder: modelIdsDataSchema,
    visibility: providerVisibilityDataSchema.nullable().optional(),
  })
  .strict();
export const completeProviderConfigDataSchema = providerConfigDataSchema.extend({
  group: providerGroupDataSchema,
  access: completeProviderAccessDataSchema,
  api: completeProviderApiDataSchema,
});

export const providerTemplateNameMapDataSchema = z
  .object({
    "zh-CN": z.string().min(1).optional(),
    "en-US": z.string().min(1).optional(),
  })
  .strict();
export const providerTemplateDataSchema = z
  .object({
    templateId: z.string().min(1),
    templateNameMap: providerTemplateNameMapDataSchema,
    config: providerConfigDataSchema,
  })
  .strict();
