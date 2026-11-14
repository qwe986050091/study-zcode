/* eslint-disable max-lines -- 已发布旧 Provider store 只在单向 importer 边界建模。 */
// INV-01：本文件是已发布 v1/v2 Provider Store 的序列化契约唯一来源，所有读写方共用同一组 schema。
// INV-02：schema 只做结构与类型校验，不做语义修正；语义修正放在 normalize/migrate 函数里。
// INV-03：v2 的 endpoints 以 baseURL + paths 为权威；anthropic/openai/gemini 三个旧字段只用于读取。
// INV-04：模型删除以 tombstone（deleted=true）持久化，所有对外的模型清单必须过滤 tombstone。
// INV-05：baseURL 是用户输入，除「重复绝对 URL 折叠」与去尾斜杠外不做任何路径裁剪。
// INV-06：kind 与 apiFormat 必须一一对应（anthropic↔messages、openai↔responses、compatible↔chat），
// 二者之间的转换只能走本文件的 kindApiFormat / mapApiFormatToKind。
import { z } from "zod";

export interface ClaudeModelMapping {
  haiku: string;
  sonnet: string;
  opus: string;
  reasoning: string;
}

/**
 * 各 ZCode Agent Provider 的模型槽位映射（按 provider 区分）。
 * 目前只实现 claude，后续扩展其他 provider 时在此加字段。
 */
export interface ProviderModelMappings {
  [provider: string]: unknown;
  /** @deprecated Claude 槽位不再写入 v2 provider store，仅用于读取旧配置后迁移清理。 */
  claude?: ClaudeModelMapping;
}

// endpoints 同时承载两代结构：
// - v2：baseURL（公共前缀）+ paths（按 kind 的 operation 路径）；
// - v1：anthropic/openai/gemini 三个完整 runtime URL。
// 三个旧字段仍参与读取，因为迁移要在旧文件上跑，删掉会让老 Store 解析失败。
// paths 的值可以是相对路径，也可以是历史遗留的绝对 URL（见 joinBaseUrlAndPath）。
export interface ModelProviderEndpoints {
  /** @deprecated 仅用于读取旧 provider 配置；新 store 使用 baseURL + paths。 */
  anthropic?: string;
  /** @deprecated 仅用于读取旧 provider 配置；新 store 使用 baseURL + paths。 */
  openai?: string;
  /** @deprecated Gemini custom provider 已统一走 endpoints.openai + compat，仅保留旧数据兼容读取。 */
  gemini?: string;
  /** v2 catalog endpoint base URL；旧字段保留给迁移期 UI/连通性代码读取。 */
  baseURL?: string;
  /** v2 catalog endpoint paths，key 使用公开 runtime kind。 */
  paths?: Partial<Record<ModelProviderKind, string>>;
}

export type RemoteProviderSchema = "anthropic" | "openai:chat" | "openai:messages" | "gemini";

// 旧版「模型协议能力」枚举比 kind 多一个 gemini，用 responses 表示 OpenAI Responses。
// 与 kind 是多对一关系：openai 映射到 openai-compatible，responses 映射到 openai。
// legacy 枚举只用于迁移读取，v2 的写入路径不再产出它。
export type ModelProviderSupportedFormat = "anthropic" | "openai" | "responses" | "gemini";

export type ModelProviderApiFormat =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

export type ModelProviderCatalogSourceId = "china-llm-zcode-dev";

// 运行期三种协议适配器：
// anthropic = Messages API；openai = Responses API；openai-compatible = Chat Completions。
// 名称里刻意不带 -messages/-responses 后缀，必须与 apiFormat 的命名区分，避免混用。
export type ModelProviderKind = "anthropic" | "openai" | "openai-compatible";

export type ModelProviderModality = "text" | "image" | "video" | "audio" | "pdf";

export interface ProviderOptionsPatch {
  set?: Array<{ path: string[]; value: unknown }>;
  unset?: Array<{ path: string[] }>;
}

// 推理档位配置：levels 的键是档位名，值是「按 kind 的 options patch」。
// patch 只在运行期合并进请求参数，读取/落库时会被 stripModelProviderReasoningPatches 清空。
// defaultLevel 是可选的默认档位名，不做存在性校验（后端可能新增档位）。
// 该结构与 v1 的布尔 reasoning 不兼容，迁移时由 reader 负责折算。
export interface ModelProviderReasoningSpec {
  defaultLevel?: string;
  levels: Record<string, Partial<Record<ModelProviderKind, ProviderOptionsPatch>>>;
}

// 落库前清空每个档位的 patch：patch 是运行期派生物，不是用户输入。
// 保留 defaultLevel 与 levels 的键集合，UI 仍能展示可选档位。
// 返回新对象，不修改入参（入参可能被调用方复用）。
export function stripModelProviderReasoningPatches(
  reasoning: ModelProviderReasoningSpec,
): ModelProviderReasoningSpec {
  return {
    // 只有 reasoning.defaultLevel 存在时才展开该键：落库文件里不出现空的 defaultLevel，
    // 否则读取侧会把它当成「用户显式选择了空档位」，UI 下拉框显示为空选项。
    ...(reasoning.defaultLevel ? { defaultLevel: reasoning.defaultLevel } : {}),
    // levels 保留原有键集合但把每个档位的 patch 换成空对象：patch 由运行时按请求临时生成，
    // 原样写回 store 会把上一次请求的临时参数固化成用户配置。
    levels: Object.fromEntries(Object.keys(reasoning.levels).map((level) => [level, {}])),
  };
}

// Catalog（内置/远端模型目录）的模型事实：描述「官方提供什么」，不含用户修改。
// kinds 是该模型支持的协议集合，defaultKind 是推荐协议（必须在 kinds 内，由读取方保证）。
// modelIdByKind 用于同一模型在不同协议下 ID 不一致的情况。
// contextWindow 必填且为正整数；maxOutputTokens 可选，缺省表示「不限制」。
// reasoning/priority 可选：前者是档位配置，后者用于目录排序。
export interface ModelProviderCatalogModel {
  id: string;
  name?: string;
  kinds: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  modalities: {
    input: ModelProviderModality[];
    output: ModelProviderModality[];
  };
  contextWindow: number;
  maxOutputTokens?: number;
  reasoning?: ModelProviderReasoningSpec;
  priority?: number;
}

export interface ModelProviderCatalogProvider {
  id: string;
  name: string;
  endpoints: {
    baseURL: string;
    paths: Partial<Record<ModelProviderKind, string>>;
  };
  defaultKind?: ModelProviderKind;
  models: ModelProviderCatalogModel[];
}

export interface ModelProviderCatalogFile {
  schemaVersion: "zcode.model-providers.v1";
  providers: ModelProviderCatalogProvider[];
}

// 用户可见的模型配置 = Catalog 事实 + 用户修改标记。
// 继承 CatalogModel 保证 catalog 与 personal 共享同一套字段语义。
// disabledReason 是「模型不可用」的人读原因，与 Provider 级 systemDisabledReason 不同。
// deleted=true 的 tombstone 会保留全部字段，以便跨设备同步删除。
export interface ModelProviderModelConfig extends ModelProviderCatalogModel {
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  modified?: boolean;
  deleted?: boolean;
}

export type ModelProviderModelEntry = string | ModelProviderModelConfig;

export type ModelProviderSource = "builtin" | "models-dev" | "custom" | "workspace";

// 系统自动禁用原因，与「用户手动关闭」互斥：enabled=false 且原因为空才是用户关闭。
// 前四个来自 Coding Plan 权益校验，最后一个表示 OAuth Provider 登录态失效。
// 取值会持久化并跨进程传输，新增值必须同步 availability 与 UI。
export type ModelProviderSystemDisabledReason =
  | "coding_plan_not_authenticated"
  | "coding_plan_not_connected"
  | "coding_plan_auth_failed"
  | "coding_plan_not_entitled"
  | "oauth_provider_inactive";

// 落库的 Provider 配置，v2 的唯一权威形状。
// enabled 缺省视为启用；false 且 systemDisabledReason 为空表示用户手动关闭。
// source 缺省视为 custom：旧文件没有该字段，读出来就是自定义 Provider。
// apiKey 必填但允许空串：空串表示尚未配置，不代表 Provider 不存在。
// catalogSourceId/catalogProviderId 只在来自 Catalog 时存在，用于后续刷新关联。
// modelDisplayNames/modelSupportedFormats 是 v1 遗留旁路表，v2 写入前必须清空。
// createdAt/updatedAt 是毫秒时间戳，用于稳定排序与冲突判定。
// endpoints 与 models 的规范化责任在 reader/normalize 层，本类型只表达能力。
export interface ModelProviderConfig {
  id: string;
  name: string;
  /** 缺省等同启用；false 时仅从聊天框模型列表隐藏，不删除供应商配置。 */
  enabled?: boolean;
  /**
   * 系统自动关闭 provider 的原因。enabled=false 且该字段为空时表示用户手动关闭，
   * 后续权益校验成功也不能自动打开。
   */
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  endpoints: ModelProviderEndpoints;
  apiFormat?: ModelProviderApiFormat;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  modelsDevProviderId?: string;
  apiKeyRequired?: boolean;
  headers?: Record<string, string>;
  logoUrl?: string;
  apiKey: string;
  apiKeyUrl?: string;
  models: ModelProviderModelEntry[];
  defaultKind?: ModelProviderKind;
  /** @deprecated 旧模型显示名 map 只用于 v1 自动迁移。 */
  modelDisplayNames?: Record<string, string>;
  /** @deprecated 旧模型格式 map 只用于 v1 自动迁移。 */
  modelSupportedFormats?: Record<string, ModelProviderSupportedFormat[]>;
  providerMappings?: ProviderModelMappings;
  createdAt: number;
  updatedAt: number;
}

export interface ModelProviderStoreFile {
  schemaVersion: "zcode.model-providers.v2";
  providers: ModelProviderConfig[];
}

// v1 的 Claude 槽位映射 schema：四个槽位都是必填字符串。
// v2 不再写入，但读取旧 providerMappings 时仍需能解析。
const claudeModelMappingSchema = z.object({
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
  reasoning: z.string(),
});

// 允许未知 provider 的槽位映射（catchall）：只有 claude 有严格结构。
// 这样旧文件里未来版本的槽位键不会让整个 Store 校验失败。
const providerModelMappingsSchema = z
  .object({
    claude: claudeModelMappingSchema.optional(),
  })
  .catchall(z.unknown());

const modelSupportedFormatSchema = z.enum(["anthropic", "openai", "responses", "gemini"]);

export const modelProviderApiFormatSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);

export const modelProviderKindSchema = z.enum(["anthropic", "openai", "openai-compatible"]);

export const modelProviderCatalogSourceIdSchema = z.enum(["china-llm-zcode-dev"]);

export const modelProviderModalitySchema = z.enum(["text", "image", "video", "audio", "pdf"]);

const providerOptionsPatchOperationSchema = z.object({
  path: z.array(z.string().min(1)).min(1),
});

export const providerOptionsPatchSchema = z.object({
  set: z.array(providerOptionsPatchOperationSchema.extend({ value: z.unknown() })).optional(),
  unset: z.array(providerOptionsPatchOperationSchema).optional(),
});

// 档位键与 kind 键都要求非空：空档位名会让 UI 出现不可点击的项。
// patch 用 providerOptionsPatchSchema，允许 set/unset 同时为空对象。
export const modelProviderReasoningSpecSchema = z.object({
  defaultLevel: z.string().min(1).optional(),
  levels: z.record(
    z.string().min(1),
    z.partialRecord(modelProviderKindSchema, providerOptionsPatchSchema),
  ),
});

export const modelProviderEndpointPathsSchema = z.partialRecord(
  modelProviderKindSchema,
  z.string(),
);

const modelProviderCatalogEndpointSchema = z.object({
  baseURL: z.string(),
  paths: modelProviderEndpointPathsSchema,
});

// 与 interface 一一对应，整数与正数约束在这里兑现：
// contextWindow 必须为正整数，maxOutputTokens 可选但同样为正整数。
// kinds 允许为空数组：迁移期的模型可能暂时无法判定协议。
// reasoning/priority 约束较弱（optional/finite），排序与合并由运行期处理。
export const modelProviderCatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  kinds: z.array(modelProviderKindSchema),
  defaultKind: modelProviderKindSchema.optional(),
  modelIdByKind: z.partialRecord(modelProviderKindSchema, z.string().min(1)).optional(),
  modalities: z.object({
    input: z.array(modelProviderModalitySchema),
    output: z.array(modelProviderModalitySchema),
  }),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoning: modelProviderReasoningSpecSchema.optional(),
  priority: z.number().finite().optional(),
});

export const modelProviderCatalogProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoints: modelProviderCatalogEndpointSchema,
  defaultKind: modelProviderKindSchema.optional(),
  models: z.array(modelProviderCatalogModelSchema),
});

export const modelProviderCatalogFileSchema = z.object({
  schemaVersion: z.literal("zcode.model-providers.v1"),
  providers: z.array(modelProviderCatalogProviderSchema),
});

// 在 catalog 模型上追加「用户修改」字段；extend 保证两份 schema 不会漂移。
// deleted 是墓碑标记，读取时必须保留，过滤发生在清单投影层。
export const modelProviderModelConfigSchema = modelProviderCatalogModelSchema.extend({
  disabledReason: z.string().optional(),
  supportsTools: z.boolean().optional(),
  supportsStructuredOutput: z.boolean().optional(),
  modified: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

export const modelProviderSourceSchema = z.enum(["builtin", "models-dev", "custom", "workspace"]);

export const modelProviderSystemDisabledReasonSchema = z.enum([
  "coding_plan_not_authenticated",
  "coding_plan_not_connected",
  "coding_plan_auth_failed",
  "coding_plan_not_entitled",
  "oauth_provider_inactive",
]);

// v1 schema：三个字段都带 default("")，因此解析结果一定有值。
// 默认空串是刻意的：迁移函数用 trim 判空来决定是否生成对应 kind 的入口。
// 该 schema 只服务 v1 文件，v2 不使用。
const legacyModelProviderEndpointsSchema = z.object({
  anthropic: z.string().default(""),
  openai: z.string().default(""),
  gemini: z.string().default(""),
});

// v2 schema 在 v1 基础上把三个旧字段改成 optional，并新增 baseURL/paths。
// 旧三个字段仍保留为 optional：v2 文件可能由早期版本写出，不兼容会让整份 Store 校验失败。
// paths 用 partialRecord：只声明实际可用的 kind，缺省即「不支持」。
// 该 schema 保持宽松、不做互斥校验，避免旧文件因多入口被拒。
export const modelProviderEndpointsSchema = legacyModelProviderEndpointsSchema.extend({
  anthropic: z.string().optional(),
  openai: z.string().optional(),
  gemini: z.string().optional(),
  baseURL: z.string().optional(),
  paths: modelProviderEndpointPathsSchema.optional(),
});

// v1 Provider schema：models 是纯字符串数组，metadata 存在旁路 map 里。
// models 默认 []：旧文件可能没有 models 字段，等价于空列表。
// modelDisplayNames/modelSupportedFormats 是 v1 的核心事实来源，迁移时必须读取。
// endpoints 用 v1 schema（三字段必填、默认空串），保证迁移函数不需要判空。
// 没有 catalogSourceId/catalogProviderId/defaultKind：这些是 v2 才引入的。
// 解析成功不代表可以原样落库，必须经过 migrateLegacyModelProviderConfig。
export const legacyModelProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
  endpoints: legacyModelProviderEndpointsSchema,
  apiFormat: modelProviderApiFormatSchema.optional(),
  source: modelProviderSourceSchema.optional(),
  modelsDevProviderId: z.string().optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  logoUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyUrl: z.string().optional(),
  models: z.array(z.string()).default([]),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelSupportedFormats: z.record(z.string(), z.array(modelSupportedFormatSchema)).optional(),
  providerMappings: providerModelMappingsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const legacyModelProviderListSchema = z.array(legacyModelProviderConfigSchema);

// v2 Provider schema：models 是对象数组，metadata 内联在每个模型上。
// 与 legacy 的差异就是迁移要做的事情，这里不做额外校验。
// models 默认 []：允许一个尚未配置模型的 Provider 存在。
// endpoints 用 v2 schema：baseURL/paths 与旧三字段可以同时出现。
// 保留 modelDisplayNames/modelSupportedFormats 以便读取旧 v2 文件后清理。
export const modelProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
  endpoints: modelProviderEndpointsSchema,
  apiFormat: modelProviderApiFormatSchema.optional(),
  source: modelProviderSourceSchema.optional(),
  catalogSourceId: modelProviderCatalogSourceIdSchema.optional(),
  catalogProviderId: z.string().optional(),
  modelsDevProviderId: z.string().optional(),
  apiKeyRequired: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  logoUrl: z.string().optional(),
  apiKey: z.string(),
  apiKeyUrl: z.string().optional(),
  defaultKind: modelProviderKindSchema.optional(),
  models: z.array(modelProviderModelConfigSchema).default([]),
  modelDisplayNames: z.record(z.string(), z.string()).optional(),
  modelSupportedFormats: z.record(z.string(), z.array(modelSupportedFormatSchema)).optional(),
  providerMappings: providerModelMappingsSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const modelProviderListSchema = z.array(modelProviderConfigSchema);

// v2 文件级 schema：providers 用数组而不是 record，顺序即展示顺序的一部分。
// schemaVersion 是字面量，读到其它版本会在校验阶段失败，由调用方决定迁移策略。
export const modelProviderStoreFileSchema = z.object({
  schemaVersion: z.literal("zcode.model-providers.v2"),
  providers: modelProviderListSchema,
});

// 展示顺序单独存放：它不属于任何 Provider，避免把全局排序写进单个 Provider。
// providerIds 要求非空字符串，空 ID 没有排序语义。
export const modelProviderDisplayOrderStateSchema = z.object({
  providerIds: z.array(z.string().min(1)),
  updatedAt: z.number().int().nonnegative(),
});

// 删除 v1 的 claude 槽位，其余键（包括未知的后续 provider）原样保留。
// 无映射时返回 undefined，让调用方用条件展开省略字段。
// 该函数在落库前调用，保证 v1 数据不会再次写入。
export function stripLegacyClaudeProviderMappings(
  providerMappings: ProviderModelMappings | undefined,
): ProviderModelMappings | undefined {
  if (!providerMappings) {
    return undefined;
  }
  const { claude: _legacyClaudeMapping, ...remainingMappings } = providerMappings;
  // v2 store 不再持久化旧 Claude 槽位，但 providerMappings 本身要保留给
  // 后续 ZCode CLI 等 provider 的槽位配置；这里只删历史子字段，未知后续 key 原样保留。
  return remainingMappings;
}

// 新模型默认上下文 200k，与设置页 MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW 的取值一致。
// legacy 缺省值复用同一个常量：两处不一致会让 Agent Registry 与 UI 显示不同上限。
// 1M 是特殊模型的上限常量，供 Catalog/UI 判断「是否已到最大档」。
export const MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW = 200_000;
// 老配置和缺 metadata 的模型没有可靠 catalog 事实时，应和设置页新增模型
// 使用同一个保守默认值，避免 agent registry 与 UI 新增模型出现 128k/200k 分歧。
const LEGACY_MODEL_CONTEXT_WINDOW = MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW;
export const MODEL_ONE_MILLION_CONTEXT_WINDOW = 1_000_000;

// 上下文长度归一化：非有限数与非数字都回落 LEGACY_MODEL_CONTEXT_WINDOW（200k）。
// 有限数用 Math.floor 向下取整：小数上下文长度没有意义，取整后才是真实上限。
// 0 与负数同样回落 LEGACY_MODEL_CONTEXT_WINDOW，否则会生成不可能满足的限制。
// 不做上限截断：1M 以上的模型应保留真实 contextWindow 值。
export function resolveModelProviderContextWindow(contextWindow: number | undefined): number {
  // typeof 检查与 Number.isFinite 必须成对：NaN 与 Infinity 都是 number 类型，
  // 只判 typeof 会让它们越过 Math.floor，最终把 NaN 写进 catalog 上限。
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
    return LEGACY_MODEL_CONTEXT_WINDOW;
  }

  // Math.floor 向下取整而不四舍五入：contextWindow 是硬上限，向上取整会让请求越过真实容量。
  const normalized = Math.floor(contextWindow);
  return normalized > 0 ? normalized : LEGACY_MODEL_CONTEXT_WINDOW;
}

export function isModelProviderModelConfig(
  model: ModelProviderModelEntry,
): model is ModelProviderModelConfig {
  // typeof null 也是 object，必须补 model !== null：否则 null 会被当成对象并读 .id 崩溃。
  return typeof model === "object" && model !== null;
}

// 对外模型 ID 列表：字符串模型直接 trim，对象模型取 id。
// 必须过滤 tombstone：聊天框/CLI 不应再看到已删除模型。
// 过滤后再 trim 并丢弃空 ID，保证返回值可直接作为键使用。
// 顺序保持原数组顺序：它同时表达用户排序。
export function getModelProviderModelIds(
  provider: Pick<ModelProviderConfig, "models"> | null | undefined,
): string[] {
  // provider 为 null 或 undefined 时直接返回空数组：调用方常把可选字段原样传进来，
  // 这里抛 TypeError 会让整个模型列表接口失败，而不是显示「该 Provider 无模型」。
  if (!provider) {
    return [];
  }

  return (
    provider.models
      // 模型删除现在以 tombstone 保留在 provider.models 中用于持久化和远端合并；
      // 所有可选/下发模型目录都必须把 tombstone 当成不存在，避免聊天框和 CLI 继续看到已删模型。
      // deleted !== true 而不是 !model.deleted：旧文件可能把 deleted 写成字符串 "false"，
      // 宽松比较会把仍在使用的模型过滤掉，所以只认严格的布尔 true。
      .filter((model) => !isModelProviderModelConfig(model) || model.deleted !== true)
      // 字符串与对象两种历史形态都要 trim：v1 存的是字符串数组，v2 存的是带 id 的对象。
      .map((model) => (isModelProviderModelConfig(model) ? model.id.trim() : model.trim()))
      .filter((modelId) => modelId.length > 0)
  );
}

function uniqueModelProviderKinds(kinds: readonly ModelProviderKind[]): ModelProviderKind[] {
  // Set 去重后还原成数组：chips 渲染时重复的 kind 会出现两个不可区分的按钮。
  return [...new Set(kinds)];
}

// 旧格式 → 运行期 kind 的映射，注意两处「跨名」：
// openai → openai-compatible（旧 openai 指 Chat Completions），responses → openai。
// gemini 返回 null：v2 不支持该协议，由调用方转成 disabledReason。
export function mapModelProviderSupportedFormatToKind(
  format: ModelProviderSupportedFormat,
): ModelProviderKind | null {
  // switch 覆盖 ModelProviderSupportedFormat 的四个取值，返回值因此允许 null；
  // 新增取值时必须补映射，否则函数会走到末尾返回 undefined，与声明的返回类型不符。
  switch (format) {
    case "anthropic":
      return "anthropic";
    // openai 映射到 openai-compatible：旧枚举里的 openai 指 Chat Completions，
    // v2 的 kind=openai 专指 Responses API，两个名字的语义正好交叉，写反会打到错误端点。
    case "openai":
      return "openai-compatible";
    case "responses":
      return "openai";
    case "gemini":
      return null;
  }
}

// 模型对象的唯一构造函数，保证所有创建路径产出同一形状。
// 模态默认 ["text"]：缺省不是「未知」，而是纯文本模型。
// kinds 去重但不去空：空 kinds 是合法状态（未知协议），由调用方补充或标 disabled。
// contextWindow 走统一归一化，避免各处自行兜底。
// maxOutputTokens 用真值判断：0 视为未设置（0 没有实际意义）。
// priority 允许 0 与负数，因此用 !== undefined 而不是真值判断。
// supportsTools/supportsStructuredOutput/modified/deleted 用 !== undefined：
// 显式 false 是有效信息，不能被当成缺省丢掉。
// 所有字符串字段都 trim，name 为空时省略而不是写空串。
export function createModelProviderModelConfig(params: {
  id: string;
  name?: string;
  kinds?: readonly ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: {
    input?: readonly ModelProviderModality[];
    output?: readonly ModelProviderModality[];
  };
  reasoning?: ModelProviderReasoningSpec;
  priority?: number;
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  modified?: boolean;
  deleted?: boolean;
}): ModelProviderModelConfig {
  // new Set 去重后再展开：调用方可能传入重复模态，重复项会让 UI 出现两个相同标签；
  // 这里不排序，保持入参顺序，展示优先级交给上层决定。
  const inputModalities: ModelProviderModality[] = [
    ...new Set(params.modalities?.input ?? (["text"] satisfies ModelProviderModality[])),
  ];
  const outputModalities: ModelProviderModality[] = [
    ...new Set(params.modalities?.output ?? (["text"] satisfies ModelProviderModality[])),
  ];
  return {
    // id 必填且 trim：空 id 会让 provider.models 的 key 冲突，按 id 合并时互相覆盖。
    id: params.id.trim(),
    name: params.name?.trim() || undefined,
    kinds: uniqueModelProviderKinds([...(params.kinds ?? [])]),
    ...(params.defaultKind ? { defaultKind: params.defaultKind } : {}),
    modalities: {
      input: inputModalities,
      output: outputModalities,
    },
    // contextWindow 统一走 resolveModelProviderContextWindow，不在本函数里再写 200k 常量，
    // 否则设置页与 legacy 迁移各写一份默认值，agent registry 会读到不同上限。
    contextWindow: resolveModelProviderContextWindow(params.contextWindow),
    // maxOutputTokens 用真值判断：0 与 undefined 都表示「不限制」，写 0 会让下游算出零预算。
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    // priority 用 !== undefined 判断：0 是合法排序值，真值判断会把它当缺省丢掉；
    // Number.isFinite 顺带挡掉 NaN，否则 sort 比较器会被 NaN 污染成不稳定顺序。
    ...(params.priority !== undefined && Number.isFinite(params.priority)
      ? { priority: params.priority }
      : {}),
    ...(params.disabledReason ? { disabledReason: params.disabledReason } : {}),
    ...(params.supportsTools !== undefined ? { supportsTools: params.supportsTools } : {}),
    ...(params.supportsStructuredOutput !== undefined
      ? { supportsStructuredOutput: params.supportsStructuredOutput }
      : {}),
    ...(params.modified !== undefined ? { modified: params.modified } : {}),
    ...(params.deleted !== undefined ? { deleted: params.deleted } : {}),
  };
}

// 默认协议解析，优先级固定为：
// 1) 显式 defaultKind；
// 2) paths 中存在的 kind，顺序 openai-compatible → openai → anthropic；
// 3) apiFormat 映射。
// paths 的判定顺序不能改成 anthropic 优先：同时存在多入口时 compatible 是最宽松的默认。
// switch 覆盖全部 apiFormat 取值，因此返回值一定非空。
export function resolveModelProviderDefaultKind(
  provider: Pick<ModelProviderConfig, "apiFormat" | "defaultKind" | "endpoints">,
): ModelProviderKind {
  // 显式 defaultKind 优先于一切推导：用户在设置页选过的协议不能被 paths 顺序覆盖。
  if (provider.defaultKind) {
    return provider.defaultKind;
  }

  const paths = provider.endpoints.paths;
  // compatible 排第一：多入口并存时它是最宽松的协议，回落到 openai 会丢掉部分自定义模型。
  if (paths?.["openai-compatible"] !== undefined) {
    return "openai-compatible";
  }
  if (paths?.openai !== undefined) {
    return "openai";
  }
  if (paths?.anthropic !== undefined) {
    return "anthropic";
  }

  // paths 全空才走 apiFormat：这里调用 resolveModelProviderApiFormat 而不是直读 provider.apiFormat，
  // 让只有旧 apiFormat、没有 paths 的 v1 数据也能落到正确 kind。
  const apiFormat = resolveModelProviderApiFormat(provider);
  // switch 三个分支穷尽 ModelProviderApiFormat，非空返回值由编译器保证。
  switch (apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
  }
}

// kind 到 apiFormat 的唯一映射：anthropic 对应 messages、openai 对应 responses。
// 反向映射在 mapModelProviderApiFormatToKind，两个函数必须保持对称。
export function resolveModelProviderKindApiFormat(kind: ModelProviderKind): ModelProviderApiFormat {
  // kind 到 apiFormat 是单向映射：anthropic 对应 messages，openai 对应 responses。
  // 这里写反会让落库 apiFormat 与默认协议互相矛盾，重连后端点地址跟着改变。
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
      return "openai-chat-completions";
  }
}

// apiFormat → kind 的反向映射，用于从旧 apiFormat 推导运行期协议。
// 三个取值全覆盖，保证返回值非空。
export function mapModelProviderApiFormatToKind(
  apiFormat: ModelProviderApiFormat,
): ModelProviderKind {
  // 反向映射必须与 resolveModelProviderKindApiFormat 严格对称，否则同一 provider
  // 经过 kind→apiFormat→kind 一轮往返后会变成另一种协议。
  switch (apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
  }
}

// 每种 kind 的默认 operation 路径，与 runtime SDK 自行追加的路径一致。
// openai 用 /responses（不是 /v1/responses）：/v1 属于 baseURL。
// 该路径只在迁移出单一入口时使用，用户自定义的 paths 优先级更高。
export function getDefaultModelProviderEndpointPathForKind(kind: ModelProviderKind): string {
  // 返回值不带 baseURL：调用方先取 runtime base，再用 joinBaseUrlAndPath 拼完整地址。
  switch (kind) {
    case "anthropic":
      return "/v1/messages";
    case "openai":
      // openai 只追加 /responses：/v1 已包含在 baseURL 里，重复写会得到 /v1/v1/responses。
      return "/responses";
    case "openai-compatible":
      return "/chat/completions";
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    // new URL 可能抛异常，必须包在 try 里：paths 中可能存着相对路径或手写错串。
    const parsed = new URL(value);
    // 只认 http 与 https：file:、data: 不是 API 端点，放行会让请求层拿到不可发送的地址。
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// 折叠「完整 runtime URL 被当作 path 再拼一次」的历史脏值：
// https://host/path/https://host/path → https://host/path。
// 只折叠完全相同的两段 URL，避免误伤 /v1 与 /beta 这类合法的深层路径。
// 非 http(s) 或非法 URL 原样返回（仅 trim/去尾斜杠），不做进一步猜测。
// 用 marker 第二次出现的位置切分，保证只折叠一次重复而不做循环收敛。
function collapseDuplicatedAbsoluteRuntimeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  // 先 trim 再去尾斜杠，后续切分依赖「无尾斜杠」这个形态，
  // 否则 firstUrl 与 secondUrl 的比较会因结尾斜杠数量不同而永远不相等。
  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return normalized;
    }
    // marker 只含协议与 host 而不含 path：重复拼接 bug 复制整段 URL 时 host 会重复出现。
    const marker = `${parsed.protocol}//${parsed.host}`;
    // 从 marker.length 处开始找第二次出现：从 0 开始会命中第一次，把正常 URL 误判成重复。
    const secondMarkerIndex = normalized.indexOf(marker, marker.length);
    if (secondMarkerIndex < 0) {
      return normalized;
    }

    const firstUrl = normalized.slice(0, secondMarkerIndex).replace(/\/+$/, "");
    const secondUrl = normalized.slice(secondMarkerIndex).replace(/\/+$/, "");
    // 只有两段完全相等才折叠：host 相同但 path 不同的地址是合法的多路径端点，
    // 强行合并会把 /v1 与 /beta 两个入口压成一个，其中一批模型直接失效。
    if (firstUrl === secondUrl) {
      // 旧设置页保存时可能把 runtime baseURL 当作 path 再拼一次，
      // 形成 https://host/path/https://host/path；这里只折叠完全重复的安全形态。
      return firstUrl;
    }
  } catch {
    return normalized;
  }

  return normalized;
}

// 拼接 baseURL 与 operation path，处理四种边界：
// - path 为空 → 直接返回 base；
// - path 是绝对 URL（旧数据把完整地址存进 paths）→ 忽略 base，避免拼出双 URL；
// - base 为空 → 返回 path；
// path 为空时直接返回 base；斜杠重复或缺失则补成恰好一个分隔符。
function joinBaseUrlAndPath(baseURL: string, path: string): string {
  // 两个入参都先 trim：配置文件里常见尾随空格，直接拼接会得到带空格的 URL，
  // fetch 会在 DNS 解析阶段报 ENOTFOUND，且错误信息很难定位到配置。
  const trimmedBase = baseURL.trim();
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return trimmedBase;
  }
  if (isAbsoluteHttpUrl(trimmedPath)) {
    // 旧 endpoints.paths 可能已保存成完整 runtime baseURL。
    // 这种情况下不能再叠加 endpoints.baseURL，否则会写回重复 URL。
    return trimmedPath;
  }
  if (!trimmedBase) {
    return trimmedPath;
  }
  // 这是「base 与 path 各带一个斜杠」的分支，去掉 base 的那个而不是 path 的：
  // path 开头斜杠属于调用方约定，保留它才能保证 URL 的 pathname 以斜杠起始。
  if (trimmedBase.endsWith("/") && trimmedPath.startsWith("/")) {
    return `${trimmedBase.slice(0, -1)}${trimmedPath}`;
  }
  // 两边都没有斜杠时补一个：遗漏会拼出 https://hostv1/messages 这种 host 被污染的值。
  if (!trimmedBase.endsWith("/") && !trimmedPath.startsWith("/")) {
    return `${trimmedBase}/${trimmedPath}`;
  }
  return `${trimmedBase}${trimmedPath}`;
}

// 按 kind 剥掉「operation 路径后缀」，把完整请求地址还原成 SDK baseURL。
// anthropic 兼容 /v1/messages 与 /messages 两种历史写法，按长的先匹配。
// openai 只剥 /responses：用户填的 /v1 必须保留，否则运行时拼出的地址会缺版本段。
// compatible 只剥 /chat/completions。
// 后缀匹配不区分大小写，但命中后立即 break，保证只剥掉一层后缀。
// 最后统一去尾斜杠，保证拼接时不会出现双斜杠。
export function normalizeModelProviderBaseUrlForKind(
  baseURL: string,
  kind: ModelProviderKind,
): string {
  // suffixes 用 Record 而不是 Partial：新增 kind 时这里会编译报错，
  // 避免新协议静默沿用空后缀、把 operation 路径留在 baseURL 里。
  const suffixes: Record<ModelProviderKind, string[]> = {
    anthropic: ["/v1/messages", "/messages"],
    // OpenAI Responses 的 SDK baseURL 通常包含 /v1，运行时只会追加 /responses。
    // 不能把 /v1/responses 整段剥掉，否则用户填写 https://host/v1 会被展示/落盘成 https://host。
    openai: ["/responses"],
    "openai-compatible": ["/chat/completions"],
  };
  // 先做通用清理再削后缀：顺序反了会把刚削掉的路径又当成重复段参与 URL 折叠。
  let normalized = normalizeModelProviderConfiguredBaseUrl(baseURL);
  for (const suffix of suffixes[kind]) {
    // 大小写不敏感：用户手写 /V1/Messages 也应被识别，否则 SDK 会再追加一次 /v1/messages。
    if (normalized.toLowerCase().endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }
  return normalized.replace(/\/+$/, "");
}

// 与 normalizeModelProviderBaseUrlForKind 的分工：这里不按 apiFormat 裁剪路径，只做 URL 层安全清理。
// 配置写入（设置页）与旧文件迁移都必须走这里，保证「用户填什么就是什么」。
// 折叠重复 URL 是为了修复历史 bug，不属于语义裁剪。
export function normalizeModelProviderConfiguredBaseUrl(baseURL: string): string {
  // 设置页和 config.json 的 Base URL 是用户显式配置值，不能按 API 格式
  // 自动删除 /v1、/responses 或 /chat/completions 等路径段；这里只做安全的重复 URL 折叠和收尾清理。
  return collapseDuplicatedAbsoluteRuntimeBaseUrl(baseURL).replace(/\/+$/, "");
}

// 计算某个 kind 的实际 SDK baseURL：
// baseURL 与 paths 都为空的 Provider 返回 ""，表示没有可执行端点。
// 只有 paths 显式声明了该 kind 才认为协议可用：否则 OpenAI-only Provider 会被误判成支持 Anthropic。
// 拼接后再按 kind 剥掉 operation 后缀：catalog 的 baseURL+path 是完整地址，而 SDK 需要 base。
// 不剥会导致重复追加（详见 joinBaseUrlAndPath 后的注释）。
// kind 缺省由 apiFormat 推导，调用方不必显式传入。
// 返回值可能为空串，调用方需自行决定回退（见 resolveModelProviderBaseUrl）。
export function resolveModelProviderRuntimeBaseUrl(
  provider: Pick<ModelProviderConfig, "apiFormat" | "defaultKind" | "endpoints">,
  kind = mapModelProviderApiFormatToKind(resolveModelProviderApiFormat(provider)),
): string {
  const baseURL = provider.endpoints.baseURL?.trim() ?? "";
  // paths 缺省成空对象而不是 undefined：下面直接下标访问，省掉每处可选链。
  const paths = provider.endpoints.paths ?? {};
  if (!provider.endpoints.baseURL?.trim() && !provider.endpoints.paths) {
    return "";
  }
  // baseURL 只是公共前缀，只有 paths 显式声明的 kind 才代表可用协议。
  // 否则 OpenAI-only provider 会被错误探测/同步成 Anthropic 可用。
  if (paths[kind] === undefined) {
    return "";
  }
  // catalog 的 baseURL + path 表示完整请求地址，而 OpenAI/Anthropic
  // runtime SDK 接收的是 API base URL，会自行追加 /chat/completions、/responses 或 /messages。
  // 若直接透传完整请求地址，真实发送会拼成 .../chat/completions/chat/completions。
  return normalizeModelProviderBaseUrlForKind(joinBaseUrlAndPath(baseURL, paths[kind] ?? ""), kind);
}

// 从 endpoints 推导「声明的协议集合」，顺序固定 anthropic → openai → compatible。
// baseURL 或 paths 存在才进入判定：只有旧三字段时返回空数组（由 legacy 迁移处理）。
// 只认 paths 的键，不看 baseURL 的路径特征：路径特征不可靠。
// 返回空数组表示「没有声明任何可用协议」，不能被当成「支持全部协议」。
export function getModelProviderEndpointKinds(
  endpoints: ModelProviderEndpoints,
): ModelProviderKind[] {
  // 返回顺序固定 anthropic → openai → compatible，调用方靠首个元素推导默认协议。
  const kinds: ModelProviderKind[] = [];
  const paths = endpoints.paths;
  // 两个条件任一成立才进入判定：只有旧三字段时直接返回空数组，
  // 那批数据的协议由 migrateLegacyModelProviderConfig 负责，不在这里猜。
  if (endpoints.baseURL?.trim() || paths) {
    if (paths?.anthropic !== undefined) {
      kinds.push("anthropic");
    }
    if (paths?.openai !== undefined) {
      kinds.push("openai");
    }
    if (paths?.["openai-compatible"] !== undefined) {
      kinds.push("openai-compatible");
    }
    return kinds;
  }
  return [];
}

function pathFromModelProviderEndpointUrl(url: URL): string {
  // pathname 为 "/" 必须折成空串并去掉尾部斜杠，否则运行期拼接会出现 "//chat/completions"；
  // search 原样保留，签名端点的 query 是端点身份的一部分，丢掉会让旧配置迁移后全部 401。
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${path}${url.search}`;
}

// 把旧版「每个 kind 一条完整 runtime URL」收敛成 v2 的 baseURL + paths。
// 先按 kind 归一化 URL 并丢弃空值：空端点不产生 paths 键。
// 所有端点同源时提取 origin 作为 baseURL，path 只留 pathname+search。
// 不同源时 baseURL 留空，paths 保存绝对 URL，由 joinBaseUrlAndPath 在运行期识别。
// 这样既保留「同源可共享前缀」的常见形态，又不破坏跨域自定义端点。
// 无任何端点时返回 {}，表示该 Provider 没有可执行入口。
function buildEndpointsFromLegacyRuntimeBaseUrls(
  entries: Array<[ModelProviderKind, string]>,
): ModelProviderEndpoints {
  // flatMap 同时完成归一化与丢空值：返回空数组的条目被剔除，
  // 因此后面 parsedEntries[0] 一定对应一个真实端点。
  const normalizedEntries = entries.flatMap(([kind, rawUrl]) => {
    const url = normalizeModelProviderBaseUrlForKind(rawUrl, kind);
    return url ? [{ kind, url }] : [];
  });
  // 没有任何非空端点时返回 {}：调用方据此判断该 Provider 没有可执行入口，
  // 而不是拿到 baseURL 为空、paths 为空的半成品。
  if (normalizedEntries.length === 0) {
    return {};
  }

  const parsedEntries = normalizedEntries.map((entry) => {
    try {
      // 解析失败不抛错而是标记 parsed: null：单个非法 URL 只影响它自己，
      // 抛出去会让整个 Provider 迁移失败，用户全部模型一起消失。
      return { ...entry, parsed: new URL(entry.url) };
    } catch {
      return { ...entry, parsed: null };
    }
  });
  // 以第一个端点作同源基准：迁移数据里 anthropic 通常排在最前，
  // 用它的 origin 作 baseURL 能让最常见的单协议配置得到最短的 paths。
  const firstParsed = parsedEntries[0]?.parsed;
  const canShareOrigin =
    firstParsed && parsedEntries.every((entry) => entry.parsed?.origin === firstParsed.origin);

  return {
    ...(canShareOrigin ? { baseURL: firstParsed.origin } : {}),
    paths: Object.fromEntries(
      parsedEntries.map((entry) => [
        entry.kind,
        // 同源时只写 pathname 与 search，跨域时保留完整 URL：两种形态都能被 joinBaseUrlAndPath 识别。
        canShareOrigin && entry.parsed ? pathFromModelProviderEndpointUrl(entry.parsed) : entry.url,
      ]),
    ) as Partial<Record<ModelProviderKind, string>>,
  };
}

// v1 的默认协议：apiFormat 优先，其次 endpoints 是否存在。
// openai 端点映射成 openai-compatible：v1 时代 openai 指 Chat Completions。
// 两者都没有时返回 anthropic：v1 的默认主链路，保证迁移结果一定有 kind。
// 该函数只在迁移链路里使用，新代码判断运行协议要走 resolveModelProviderDefaultKind。
function resolveLegacyModelProviderDefaultKind(
  provider: Pick<z.infer<typeof legacyModelProviderConfigSchema>, "apiFormat" | "endpoints">,
): ModelProviderKind {
  // apiFormat 优先于端点存在性：v1 里 apiFormat 是用户显式选择，端点只是历史残留。
  switch (provider.apiFormat) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-responses":
      return "openai";
    case "openai-chat-completions":
      return "openai-compatible";
    // undefined 单独成一支是刻意的：没有 apiFormat 的旧文件要走端点推断，
    // 直接返回兜底值会让这类配置全部被当成 anthropic。
    case undefined:
      break;
  }

  if (provider.endpoints.anthropic?.trim()) {
    return "anthropic";
  }
  // openai 端点映射成 openai-compatible：v1 的 openai 指 Chat Completions，
  // v2 的 openai 是 Responses API，两者不能混用。
  if (provider.endpoints.openai?.trim()) {
    return "openai-compatible";
  }
  return "anthropic";
}

function getDefaultModelSupportedFormatsFromLegacyEndpoints(
  endpoints: Pick<ModelProviderEndpoints, "anthropic" | "openai">,
): ModelProviderSupportedFormat[] {
  // 只读 anthropic 与 openai 两个字段：gemini 在 v2 没有对应 kind，
  // 调用方会在 kinds 为空且 formats 含 gemini 时写 disabledReason。
  const formats: ModelProviderSupportedFormat[] = [];
  if (endpoints.anthropic?.trim()) {
    formats.push("anthropic");
  }
  if (endpoints.openai?.trim()) {
    formats.push("openai");
  }
  return formats;
}

// v1 Provider → v2 ModelProviderConfig 的完整迁移。
// endpoints 先按历史形态收集（可能同时有 anthropic 与 openai），再收敛成单一 baseURL+paths。
// openai 端点的 kind 取决于 defaultKind：defaultKind=openai 时保留 openai，否则记为 compatible。
// 模型 kinds 优先取 modelSupportedFormats，其次 apiFormat，最后旧 endpoints。
// kinds 为空且 formats 含 gemini 时写入 disabledReason：v2 不支持 gemini，但要保留模型可见性。
// defaultKind 取「模型支持的默认协议」：不在 kinds 内时退到第一个 kind。
// 可选字段用条件展开而不是写 undefined：避免落库出现显式 undefined 键。
// providerMappings 在迁移时删除 claude 槽位，未知槽位保留。
// createdAt/updatedAt 原样保留，不重置为当前时间。
export function migrateLegacyModelProviderConfig(
  provider: z.infer<typeof legacyModelProviderConfigSchema>,
): ModelProviderConfig {
  // defaultKind 先算一次：openai 端点登记成哪种 kind、每个模型的默认协议都依赖它，
  // 提前算也避免在 map 回调里重复走 switch。
  const defaultKind = resolveLegacyModelProviderDefaultKind(provider);
  // 旧 provider 可能同时配置 Anthropic 与 OpenAI，迁移阶段先保留历史路径，
  // 后续服务层存储边界会按 runtime config 收敛为单一 kind。
  // 用数组而不是对象保留端点顺序：buildEndpointsFromLegacyRuntimeBaseUrls 以第一个端点定 origin。
  const legacyEntries: Array<[ModelProviderKind, string]> = [];
  // trim 后判空：v1 schema 用 default("") 兜底，空串表示该端点从未配置，不能生成 paths 键。
  const anthropicEndpoint = provider.endpoints.anthropic?.trim();
  if (anthropicEndpoint) {
    legacyEntries.push(["anthropic", anthropicEndpoint]);
  }
  const openaiEndpoint = provider.endpoints.openai?.trim();
  if (openaiEndpoint) {
    // openai 端点的 kind 取决于 defaultKind：用户默认选 Responses 才记成 openai，
    // 否则按 compatible 处理，避免把 Chat Completions 地址当成 Responses 端点。
    legacyEntries.push([defaultKind === "openai" ? "openai" : "openai-compatible", openaiEndpoint]);
  }
  // 端点收敛只做一次：baseURL 与 paths 是后续所有推导的唯一来源，
  // 在 map 回调里重算会得到与 provider 级不一致的端点。
  const endpoints = buildEndpointsFromLegacyRuntimeBaseUrls(legacyEntries);
  // models 是纯字符串数组，元数据要从旁路 map 取：modelDisplayNames 与 modelSupportedFormats
  // 在 v2 不再持久化，但迁移时必须读全，否则模型名和协议会一起丢失。
  const migratedModels = provider.models.map((modelId) => {
    const formats =
      // 三级回落：旁路 map → apiFormat 推导 → 旧端点推导，任一命中即可；
      // 全部缺失时 formats 为空数组，模型以「无协议」状态可见而不是被丢弃。
      provider.modelSupportedFormats?.[modelId] ??
      (provider.apiFormat
        ? getDefaultModelSupportedFormatsFromApiFormat(provider.apiFormat)
        : getDefaultModelSupportedFormatsFromLegacyEndpoints(provider.endpoints));
    const kinds = uniqueModelProviderKinds(
      formats.flatMap((format) => {
        const kind = mapModelProviderSupportedFormatToKind(format);
        return kind ? [kind] : [];
      }),
    );
    // 只有 kinds 为空且 formats 含 gemini 才写 disabledReason：其它空 kinds 是「协议未知」，
    // 模型仍应可编辑，不该因 kinds 为空就被永久标成不可用。
    const disabledReason =
      kinds.length === 0 && formats.includes("gemini")
        ? "legacy gemini format is not supported by zcode.model-providers.v2"
        : undefined;

    return createModelProviderModelConfig({
      id: modelId,
      name: provider.modelDisplayNames?.[modelId],
      kinds,
      // kinds 不含全局 defaultKind 时退到首个 kind：留一个不属于 kinds 的默认协议会让运行时
      // 选到未声明路径的端点，请求直接 404。
      defaultKind: kinds.includes(defaultKind) ? defaultKind : kinds[0],
      disabledReason,
    });
  });

  return {
    id: provider.id,
    name: provider.name,
    ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
    ...(provider.systemDisabledReason
      ? { systemDisabledReason: provider.systemDisabledReason }
      : {}),
    endpoints,
    apiFormat: provider.apiFormat,
    source: provider.source,
    modelsDevProviderId: provider.modelsDevProviderId,
    apiKeyRequired: provider.apiKeyRequired,
    headers: provider.headers,
    logoUrl: provider.logoUrl,
    apiKey: provider.apiKey,
    apiKeyUrl: provider.apiKeyUrl,
    defaultKind,
    models: migratedModels,
    // 迁移即清理 claude 槽位：v2 的 providerMappings 只保留未知 provider 的后续配置。
    providerMappings: stripLegacyClaudeProviderMappings(provider.providerMappings),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

// v1 文件 → v2 StoreFile 的入口：先整体 schema 校验，再逐个迁移。
// 校验失败直接抛出：部分迁移会产生「一半 v1 一半 v2」的危险文件。
// 输出固定 schemaVersion="zcode.model-providers.v2"。
export function migrateLegacyModelProviderListToStoreFile(raw: unknown): ModelProviderStoreFile {
  // 先 parse 整个数组再逐个迁移：parse 失败会在这里抛出，
  // 不会留下「前几个已迁移、后面还是 v1 形状」的混合文件。
  const providers = legacyModelProviderListSchema.parse(raw);
  return {
    schemaVersion: "zcode.model-providers.v2",
    providers: providers.map(migrateLegacyModelProviderConfig),
  };
}

// 从 v2 endpoints 推导旧格式集合，供迁移/兼容层复用。
// 注意两处跨名：compatible → "openai"（Chat Completions），openai → "responses"（Responses API）。
// 只有 baseURL 或 paths 存在时才推导；只有旧三字段时返回空数组。
// 顺序固定 anthropic → openai → responses，保证输出稳定。
export function getDefaultModelSupportedFormatsFromEndpoints(
  endpoints: Partial<
    Pick<ModelProviderEndpoints, "anthropic" | "openai" | "gemini" | "baseURL" | "paths">
  >,
): ModelProviderSupportedFormat[] {
  // 输出顺序固定 anthropic → openai → responses，调用方可能直接取首个作为默认协议。
  const formats: ModelProviderSupportedFormat[] = [];
  const paths = endpoints.paths;
  if (endpoints.baseURL?.trim() || paths) {
    if (paths?.anthropic !== undefined) {
      formats.push("anthropic");
    }
    if (paths?.["openai-compatible"] !== undefined) {
      formats.push("openai");
    }
    if (paths?.openai !== undefined) {
      // openai 的 path 对应 responses：v2 的 kind=openai 就是 Responses API，
      // 这里返回的是旧枚举名，名字与 kind 不同属于历史命名而不是笔误。
      formats.push("responses");
    }
    return formats;
  }
  return [];
}

export function getDefaultModelSupportedFormatsFromApiFormat(
  apiFormat: ModelProviderApiFormat,
): ModelProviderSupportedFormat[] {
  // 与 resolveModelProviderApiFormat 互为反函数：三个取值必须补齐，
  // 漏分支会让迁移写出缺 formats 的模型。
  switch (apiFormat) {
    case "anthropic-messages":
      return ["anthropic"];
    case "openai-responses":
      return ["responses"];
    case "openai-chat-completions":
      return ["openai"];
  }
}

// apiFormat 解析：显式合法值优先，其次 defaultKind，最后 paths 特征。
// 显式值只接受三个合法枚举，拼写错误的字符串会被忽略并落到下面的推断分支。
// paths 判定顺序 anthropic → openai → compatible：旧迁移数据多为 anthropic 主链路。
// 全部缺失时返回 anthropic-messages，保证调用方一定有可用格式。
export function resolveModelProviderApiFormat(
  provider: Pick<ModelProviderConfig, "apiFormat" | "endpoints"> &
    Partial<Pick<ModelProviderConfig, "defaultKind">>,
): ModelProviderApiFormat {
  if (
    // 逐个 === 比较同时完成类型收窄：命中后返回的是 ModelProviderApiFormat 而不是 string，
    // 调用方拿到 ModelProviderApiFormat 后无需再断言一次。
    provider.apiFormat === "anthropic-messages" ||
    provider.apiFormat === "openai-chat-completions" ||
    provider.apiFormat === "openai-responses"
  ) {
    return provider.apiFormat;
  }

  // 没有显式 apiFormat 时先看 defaultKind：它是 v2 写入的权威字段，比 paths 特征可靠。
  if (provider.defaultKind) {
    return resolveModelProviderKindApiFormat(provider.defaultKind);
  }

  // 旧迁移数据可能同时声明多个协议，未显式 defaultKind/apiFormat 时
  // 仍按 Anthropic-compatible 主链路优先，避免 Anthropic 协议 provider 被误切到 OpenAI。
  // paths 判定顺序 anthropic 优先：旧迁移数据多是 anthropic 主链路，
  // 改成 compatible 优先会让这批用户在升级后被动换协议。
  if (provider.endpoints.paths?.anthropic !== undefined) {
    return "anthropic-messages";
  }

  if (provider.endpoints.paths?.openai !== undefined) {
    return "openai-responses";
  }

  if (provider.endpoints.paths?.["openai-compatible"] !== undefined) {
    return "openai-chat-completions";
  }

  // 兜底返回 anthropic-messages：没有 paths、没有 apiFormat 的空 Provider 也要有可用格式，
  // 否则调用方拿到 undefined 会在拼 URL 时抛 TypeError。
  return "anthropic-messages";
}

// 面向 UI/连通性代码的「展示用 baseURL」：优先返回运行期 SDK baseURL。
// 设置页输入框展示的是 SDK baseURL，内部 endpoints.baseURL 可能只是公共前缀，必须还原。
// 因此必须结合固定 operation path 还原，否则用户会看到不完整的地址。
// 运行期无法推导时退回 endpoints.baseURL 并做 kind 相关归一化。
// 最终仍为空时返回空串，由调用方决定是否提示「未配置」。
export function resolveModelProviderBaseUrl(
  provider: Pick<ModelProviderConfig, "apiFormat" | "endpoints"> &
    Partial<Pick<ModelProviderConfig, "defaultKind">>,
): string {
  // kind 由 apiFormat 推导而不是读 defaultKind：这里要的是当前实际使用的协议，
  // defaultKind 只是偏好，可能指向一个没有 paths 的协议。
  const kind = mapModelProviderApiFormatToKind(resolveModelProviderApiFormat(provider));
  const runtimeBaseURL = resolveModelProviderRuntimeBaseUrl(provider, kind);
  if (runtimeBaseURL) {
    // 修复原因：设置页输入框展示的是 SDK/runtime baseURL。
    // 内部 endpoints.baseURL 只是公共前缀时，必须结合固定 operation path 还原展示值。
    return runtimeBaseURL;
  }
  const baseURL = provider.endpoints.baseURL?.trim();
  if (baseURL) {
    // Bugfix: 早期设置页会把 Chat Completions 的完整请求地址保存进 baseURL。
    // Base URL 输入框应展示 SDK 的 API base URL，避免用户再次保存时延续错误形态。
    return normalizeModelProviderBaseUrlForKind(baseURL, kind);
  }
  return resolveModelProviderRuntimeBaseUrl(provider, kind);
}

/** 连通性测试错误分类 */
