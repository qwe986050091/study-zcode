/* oxlint-disable eslint(max-lines) -- 已发布旧 ZCode config.json 的多版 Provider 结构读取集中在同一边界。 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveBigModelApiOrigin,
  resolveRuntimeZCodeEnv,
} from "@zcode/shared";
import {
  createModelProviderModelConfig,
  getDefaultModelSupportedFormatsFromApiFormat,
  getDefaultModelSupportedFormatsFromEndpoints,
  getDefaultModelProviderEndpointPathForKind,
  getModelProviderModelIds,
  isModelProviderModelConfig,
  legacyModelProviderListSchema,
  mapModelProviderSupportedFormatToKind,
  migrateLegacyModelProviderConfig,
  MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW,
  modelProviderApiFormatSchema,
  modelProviderCatalogSourceIdSchema,
  modelProviderEndpointsSchema,
  modelProviderKindSchema,
  modelProviderReasoningSpecSchema,
  modelProviderSourceSchema,
  modelProviderSystemDisabledReasonSchema,
  normalizeModelProviderBaseUrlForKind,
  normalizeModelProviderConfiguredBaseUrl,
  resolveModelProviderDefaultKind,
  resolveModelProviderContextWindow,
  resolveModelProviderKindApiFormat,
  resolveModelProviderApiFormat,
  resolveModelProviderRuntimeBaseUrl,
  stripLegacyClaudeProviderMappings,
  stripModelProviderReasoningPatches,
  type ModelProviderApiFormat,
  type ModelProviderCatalogSourceId,
  type ModelProviderConfig,
  type ModelProviderEndpoints,
  type ModelProviderKind,
  type ModelProviderModelConfig,
  type ModelProviderModality,
  type ModelProviderReasoningSpec,
  type ModelProviderSource,
  type ModelProviderSystemDisabledReason,
  type ProviderModelMappings,
} from "./legacyModelProviderSerialized.js";
import { getAppConfigDir } from "../paths.js";

// INV-01：本文件只做「读旧 config.json → 规范化成 ModelProviderConfig」，不写文件、不触发迁移提交。
// INV-02：读取必须无损于用户输入：options.baseURL 原样保留路径段，不做 /v1、/responses 裁剪。
// INV-03：只有 ENOENT 允许视为「没有旧配置」；其它 IO/JSON/Schema 错误必须抛出，
// 否则 Importer 会把空配置当成用户意图永久提交。
// INV-04：旧文件中由 Built-in/Catalog 派生的字段不在此补全，由 Registry 按当前版本解析。
// INV-05：兼容优先级固定为「新结构 options.baseURL/kind > 旧 zcode 扩展 > 旧 endpoints」。
// 下面是「协议可推断」的内置 Provider 白名单：只有它们的 baseURL 能反推 kind，
// 其余 Provider 的 baseURL 是用户自由输入，反推会误改协议。
const LEGACY_PRESET_GLM_PROVIDER_IDS = new Set<string>([
  "zai-api",
  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  "bigmodel-api",
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
]);

// 判定只看 id 集合，不看 kind：同一内置 Provider 在不同版本可能被写成 anthropic 或 openai-compatible。
// 只有命中这里的 id 才允许用 baseURL 路径反推协议。
function isLegacyPresetGlmProviderId(providerId: string): boolean {
  // 直接查白名单集合：调用方在拿 baseURL 反推协议前必须先过这一关，漏判会让用户自定义 Provider 的协议被静默改写。
  return LEGACY_PRESET_GLM_PROVIDER_IDS.has(providerId);
}

// 生产环境的 BigModel Coding Plan 固定走 Anthropic 兼容网关；
// 非生产环境由 resolveBigModelApiOrigin 按 ZCODE_ENV 派生，不能用同一个常量。
// 常量单独抽出是为了能在 URL 比较时构造 URL 对象（见下面的 origin 判断）。
// 该地址是「平台默认」，用户显式写入的 baseURL 仍需先经过相同规则归一化。
const BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";

// 归一化 BigModel Coding Plan 的 Anthropic baseURL，三条规则按环境分流：
// 生产：缺失时回落到平台固定地址，且不做域名替换（用户可能用自定义反代）。
// 非生产：缺失时用当前环境的 API origin 派生；若旧值指向生产域名则替换为环境地址，
// 否则测试环境的 Team Plan Key 会打到生产网关并失败。
// 非法 URL 一律回落到环境默认值：历史配置里拼错域名时宁可重置，也不要让请求打空。
// normalizeModelProviderBaseUrlForKind 只做 trim/去尾斜杠，不删除路径段。
// 返回值永远不会为空字符串：调用方可以直接写进 endpoints.baseURL。
// [权衡] 生产信任用户值、测试强制纠偏——这是为避免跨环境凭据泄漏做的非对称处理。
function normalizeBigModelCodingPlanAnthropicBaseUrlForEnv(
  baseUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  // 兜底地址按环境分流：生产用平台固定网关，其它环境用当前环境的 API origin 拼 /api/anthropic。
  // 此处只构造默认值，用户输入要到下面才参与比较，因此不会覆盖显式配置。
  const fallbackBaseUrl =
    resolveRuntimeZCodeEnv(env) === "production"
      ? BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL
      : `${resolveBigModelApiOrigin(env)}/api/anthropic`;
  // kind 固定传 anthropic：该内置 Provider 的默认协议已切换，传错 kind 会按另一套规则处理路径。
  // 空值在这里被兜底填充，所以下面可以放心把结果直接拿去构造 URL 对象。
  const normalizedBaseUrl = normalizeModelProviderBaseUrlForKind(
    baseUrl ?? fallbackBaseUrl,
    "anthropic",
  );
  // 生产分支不做域名纠偏：用户可能配置了自定义反向代理，强行替换回平台地址会让代理直接失效。
  if (resolveRuntimeZCodeEnv(env) === "production") {
    // `||` 在这里兜住规范化后变成空串的情况（例如输入只有空白），保证返回值一定可用。
    return normalizedBaseUrl || fallbackBaseUrl;
  }

  // 非生产分支必须先比较 origin 才能决定是否纠偏，因此要把值冒泡成合法 URL；解析失败落到下面的降级分支。
  try {
    // 两侧都解析成 URL 再比：直接比完整字符串会被路径段差异干扰，只有 origin 才代表真正打到的网关。
    const parsed = new URL(normalizedBaseUrl || fallbackBaseUrl);
    const productionParsed = new URL(BIGMODEL_CODING_PLAN_ANTHROPIC_BASE_URL);
    // 旧配置可能保存生产域名；测试环境的 Team Plan Key 无法调用生产网关。
    return parsed.origin === productionParsed.origin
      ? fallbackBaseUrl
      : normalizedBaseUrl || fallbackBaseUrl;
  } catch {
    // 无协议或拼错域名的历史值不抛错：降级成环境默认地址，让单个坏 Provider 不至于阻断整次迁移。
    return fallbackBaseUrl;
  }
}

// 旧配置固定位于 App 配置目录下的 config.json。
// 不提供自定义路径：迁移只针对「已发布」的单一文件，多路径会让 Importer 的幂等判断失效。
// 每次调用都重新解析目录：测试会替换 App 配置根目录。
// 路径拼接用 join 而不是字符串相加，避免 Windows 分隔符差异。
// 该函数是唯一确定「旧配置在哪」的地方，其它模块不得自行拼路径。
function getZCodeConfigFilePath(): string {
  // 每次调用都重新解析目录：测试会替换 App 配置根目录，缓存路径会让用例之间互相污染。
  return join(getAppConfigDir(), "config.json");
}

// legacy 模型缺失 contextWindow 时使用新模型的默认值，而不是 0：0 会让上下文校验直接失败。
// builtin:zapi 已下线，读取时清除；保留它会让设置页出现一个永远不可用的入口。
const LEGACY_FALLBACK_CONTEXT_WINDOW = MODEL_PROVIDER_NEW_MODEL_CONTEXT_WINDOW;
const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

type JsonObject = Record<string, unknown>;

// config.json 的顶层形状：只声明 provider 表，其余字段 passthrough 保留。
// $schema 仅用于编辑器提示，读取逻辑不依赖它的值。
// 顶层其它键（theme、telemetry 等）由别的模块读取，这里不解释也不丢弃。
// 索引签名保证未来新增顶层键不会让整个文件校验失败。
// provider 缺失等价于「没有可迁移的 Provider」，返回 null 而不是空数组。
interface ZCodeConfigFile {
  $schema?: string;
  provider?: Record<string, ZCodeOpenCodeProviderConfig>;
  [key: string]: unknown;
}

// 旧 Provider 的「平铺存储」形状，同时兼容两代结构：
// 新结构用 api/options.baseURL/kind 作为权威运行态字段；
// 旧结构用 endpoints/apiFormat/zcode.* 作为兜底，只在缺失新字段时读取。
// api 与 options.baseURL 语义相同但来源不同：前者是 opencode 原生字段，后者是 ZCode 写入的。
// enabled/systemDisabledReason 同时存在于顶层与 zcode 扩展，读取时顶层优先。
// models 是 Record 而非数组：旧文件用模型 ID 作键，读取时以键为默认 id。
// 不在此处填默认值：缺省含义（例如 enabled 未设置）由上层按产品策略决定。
interface ZCodeOpenCodeProviderConfig {
  api?: string;
  name?: string;
  env?: string[];
  id?: string;
  kind?: ModelProviderKind;
  npm?: string;
  whitelist?: string[];
  blacklist?: string[];
  options?: JsonObject;
  enabled?: boolean;
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  endpoints?: ModelProviderEndpoints;
  apiFormat?: ModelProviderApiFormat;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  modelsDevProviderId?: string;
  apiKeyRequired?: boolean;
  headers?: Record<string, string>;
  logoUrl?: string;
  apiKeyUrl?: string;
  defaultKind?: ModelProviderKind;
  providerMappings?: ProviderModelMappings;
  createdAt?: number;
  updatedAt?: number;
  models?: Record<string, ZCodeOpenCodeModelConfig>;
  zcode?: ZCodeProviderConfigExtension;
  [key: string]: unknown;
}

// 旧模型的存储形状，混合了 opencode 字段（limit/attachment/tool_call）与 ZCode 扩展（zcode.*）。
// limit.context 与 contextWindow 并存是历史原因：新写入收敛到 limit，旧版本只写顶层。
// reasoning 既可能是布尔开关，也可能是带 variants 的对象，读取时统一折算成 ReasoningSpec。
// modalities 只保留 input/output 两维；缺省表示「由 apiFormat 推导」。
// deleted=true 是墓碑：模型从设置页移除后仍保留记录，用于跨设备同步删除语义。
// zcode 扩展与顶层同名字段重复时以顶层为准（preferOpenCodeFields 决定是否忽略扩展）。
// 未知字段保留但不读取，避免旧版本的实验字段在新版本被误解。
interface ZCodeOpenCodeModelConfig {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean | ZCodeReasoningConfigExtension;
  temperature?: boolean;
  tool_call?: boolean;
  interleaved?: unknown;
  cost?: JsonObject;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: {
    input?: ModelProviderModality[];
    output?: ModelProviderModality[];
  };
  experimental?: boolean;
  status?: string;
  provider?: {
    npm?: string;
    api?: string;
  };
  options?: JsonObject;
  headers?: Record<string, string>;
  variants?: Record<string, JsonObject>;
  kinds?: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  reasoningSpec?: ModelProviderReasoningSpec;
  hasMaxOutputTokens?: boolean;
  priority?: number;
  modified?: boolean;
  deleted?: boolean;
  zcode?: ZCodeModelConfigExtension;
  [key: string]: unknown;
}

// 旧版 reasoning 扩展：variants 是可选档位名列表，defaultVariant 是默认档位。
// aliases 把模型原生档位映射到统一档位名，读取时按原样保留。
// 该结构只用于折算 ReasoningSpec.levels，不参与运行期选择。
interface ZCodeReasoningConfigExtension {
  enabled?: boolean;
  variants?: string[];
  defaultVariant?: string;
  aliases?: Record<string, string>;
}

// ZCode 在旧 Provider 上追加的扩展字段，与顶层字段一一对应。
// 保留双份是为了兼容「早期写在 zcode 里、后期提升到顶层」的两次迁移。
// deletedModels 是 Provider 级墓碑列表：记录用户删除过但文件里仍可能存在的模型 ID。
// endpoints/apiFormat/defaultKind 只作为兜底来源，新结构存在时完全忽略。
// createdAt/updatedAt 只用于稳定排序与冲突判定，缺失时由读取时刻补齐。
// 扩展字段允许 passthrough：旧版本写入的未知键不应导致整个 Provider 被丢弃。
interface ZCodeProviderConfigExtension {
  enabled?: boolean;
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  endpoints?: ModelProviderEndpoints;
  apiFormat?: ModelProviderApiFormat;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  modelsDevProviderId?: string;
  apiKeyRequired?: boolean;
  headers?: Record<string, string>;
  logoUrl?: string;
  apiKeyUrl?: string;
  defaultKind?: ModelProviderKind;
  providerMappings?: ProviderModelMappings;
  createdAt?: number;
  updatedAt?: number;
  deletedModels?: string[];
}

// 模型级 ZCode 扩展，与顶层同名字段互为兜底。
// kinds/modelIdByKind 描述同一模型在不同协议下的 ID，例如 anthropic 与 openai 各一个。
// modified 标记用户是否手动改过：读取时保留，用于决定是否允许 Catalog 覆盖。
// deleted 与 Provider 级 deletedModels 语义相同，二者在规范化时合并。
// reasoning 是结构化推理配置，优先于顶层布尔 reasoning。
interface ZCodeModelConfigExtension {
  kinds?: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  disabledReason?: string;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  reasoning?: ModelProviderReasoningSpec;
  hasMaxOutputTokens?: boolean;
  priority?: number;
  modified?: boolean;
  deleted?: boolean;
}

// 统一的宽松对象 schema：options/cost/variants 结构随协议变化，只要求是对象。
// modality 枚举固定五种，与 ModelProviderModality 类型保持一致，新增值必须两边同步。
// providerMappings 用宽松 record：映射键是模型 ID，值结构由具体 Provider 决定。
// 宽松 schema 的代价是类型不精确，因此读取函数必须自行做窄化（readString/readBoolean 等）。
const jsonObjectSchema = z.record(z.string(), z.unknown());
const zcodeModelProviderModalitySchema = z.enum(["text", "image", "video", "audio", "pdf"]);
const zcodeProviderModelMappingsSchema = z.record(z.string(), z.unknown());

// passthrough 保留未知键：旧版本可能写入 enabled 之外的实验字段，读取时忽略但不报错。
// variants 要求非空字符串：空档位名会让 UI 出现不可点击的选项。
// aliases 是 string→string，禁止嵌套，保证折算成 levels 时是一层映射。
const zcodeReasoningConfigExtensionSchema = z
  .object({
    enabled: z.boolean().optional(),
    variants: z.array(z.string().min(1)).optional(),
    defaultVariant: z.string().min(1).optional(),
    aliases: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

// 模型扩展 schema 与 interface 一一对应，字段全部 optional：缺省即「不覆盖顶层」。
// z.partialRecord 允许只声明部分 kind 的 modelId，未声明的 kind 回落到默认模型 ID。
// priority 用 finite 而不是 positive：负数优先级在旧数据里出现过，读取时保留原值。
const zcodeModelConfigExtensionSchema = z
  .object({
    kinds: z.array(modelProviderKindSchema).optional(),
    defaultKind: modelProviderKindSchema.optional(),
    modelIdByKind: z.partialRecord(modelProviderKindSchema, z.string().min(1)).optional(),
    disabledReason: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    reasoning: modelProviderReasoningSpecSchema.optional(),
    hasMaxOutputTokens: z.boolean().optional(),
    priority: z.number().finite().optional(),
    modified: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .passthrough();

// 模型 schema 是「宽进严出」的边界：z.number().positive() 拒绝 0/负数上下文长度，
// 而不是读取后再纠正，避免把非法值静默改成默认值。
// limit 与 contextWindow 同时声明：读取时按 limit > contextWindow 取值。
// reasoning 用 union：布尔开关与结构化配置在旧文件里都出现过。
// variants 是 record<string, object>：具体档位参数由 Provider 协议解释，本层不做结构假设。
// passthrough 让未知字段进入 model 对象，但不参与规范化输出（zcode 扩展在此一并校验）。
const zcodeOpenCodeModelConfigSchema: z.ZodType<ZCodeOpenCodeModelConfig> = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    reasoning: z.union([z.boolean(), zcodeReasoningConfigExtensionSchema]).optional(),
    limit: z
      .object({
        context: z.number().positive().optional(),
        input: z.number().positive().optional(),
        output: z.number().positive().optional(),
      })
      .optional(),
    contextWindow: z.number().positive().optional(),
    maxOutputTokens: z.number().positive().optional(),
    modalities: z
      .object({
        input: z.array(zcodeModelProviderModalitySchema).optional(),
        output: z.array(zcodeModelProviderModalitySchema).optional(),
      })
      .optional(),
    options: jsonObjectSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    variants: z.record(z.string(), jsonObjectSchema).optional(),
    kinds: z.array(modelProviderKindSchema).optional(),
    defaultKind: modelProviderKindSchema.optional(),
    modelIdByKind: z.partialRecord(modelProviderKindSchema, z.string().min(1)).optional(),
    disabledReason: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsStructuredOutput: z.boolean().optional(),
    reasoningSpec: modelProviderReasoningSpecSchema.optional(),
    hasMaxOutputTokens: z.boolean().optional(),
    priority: z.number().finite().optional(),
    modified: z.boolean().optional(),
    deleted: z.boolean().optional(),
    zcode: zcodeModelConfigExtensionSchema.optional(),
  })
  .passthrough();

// Provider 扩展 schema：deletedModels 要求非空字符串，空 ID 没有删除语义。
// systemDisabledReason 用共享枚举：未知原因会在校验阶段被拒绝，而不是让 UI 拿到无法映射的值。
// providerMappings 只校验是对象，具体映射结构在 stripZCodePrefixedProviderMappings 里处理。
const zcodeProviderConfigExtensionSchema = z
  .object({
    enabled: z.boolean().optional(),
    systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
    endpoints: modelProviderEndpointsSchema.optional(),
    apiFormat: modelProviderApiFormatSchema.optional(),
    source: modelProviderSourceSchema.optional(),
    catalogSourceId: modelProviderCatalogSourceIdSchema.optional(),
    catalogProviderId: z.string().optional(),
    modelsDevProviderId: z.string().optional(),
    apiKeyRequired: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    logoUrl: z.string().optional(),
    apiKeyUrl: z.string().optional(),
    defaultKind: modelProviderKindSchema.optional(),
    providerMappings: zcodeProviderModelMappingsSchema.optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    deletedModels: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

// Provider schema 是整份旧文件能否读取的关键边界：
// models 用 record 而不是 array，与旧文件「用 ID 作键」的结构一致。
// 所有运行态字段都 optional：同一个 Provider 可能只写了 api，也可能只写了 options.baseURL。
// endpoints/apiFormat 在 schema 里保留，但只有新结构字段缺失时才会被读取。
// providerMappings/modelsDevProviderId 属于 Catalog 关联信息，迁移时按来源过滤。
// passthrough 保证旧版本的多余字段不会让整个 Provider 校验失败。
// [权衡] 宽 schema + 读取期窄化，牺牲部分静态类型换取对历史文件的容忍度。
const zcodeOpenCodeProviderConfigSchema: z.ZodType<ZCodeOpenCodeProviderConfig> = z
  .object({
    api: z.string().optional(),
    name: z.string().optional(),
    env: z.array(z.string()).optional(),
    id: z.string().optional(),
    kind: modelProviderKindSchema.optional(),
    npm: z.string().optional(),
    whitelist: z.array(z.string()).optional(),
    blacklist: z.array(z.string()).optional(),
    options: jsonObjectSchema.optional(),
    enabled: z.boolean().optional(),
    systemDisabledReason: modelProviderSystemDisabledReasonSchema.optional(),
    endpoints: modelProviderEndpointsSchema.optional(),
    apiFormat: modelProviderApiFormatSchema.optional(),
    source: modelProviderSourceSchema.optional(),
    catalogSourceId: modelProviderCatalogSourceIdSchema.optional(),
    catalogProviderId: z.string().optional(),
    modelsDevProviderId: z.string().optional(),
    apiKeyRequired: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    logoUrl: z.string().optional(),
    apiKeyUrl: z.string().optional(),
    defaultKind: modelProviderKindSchema.optional(),
    providerMappings: zcodeProviderModelMappingsSchema.optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    models: z.record(z.string(), zcodeOpenCodeModelConfigSchema).optional(),
    zcode: zcodeProviderConfigExtensionSchema.optional(),
  })
  .passthrough();

// 顶层 schema 只约束 provider 表；其余键 passthrough，不使用 strict。
// provider 缺失是合法的：只有元信息的文件视为「无 Provider」，读取返回 null。
// 校验通过后返回 parsed.data：passthrough 已保留未声明的键。
// safeParse 而非 parse：读取器需要把错误转换成不含敏感值的诊断文本。
const zcodeConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    provider: z.record(z.string(), zcodeOpenCodeProviderConfigSchema).optional(),
  })
  .passthrough();

// 统一的字符串窄化：非字符串一律 undefined，字符串则 trim。
// trim 后为空仍返回空串（不是 undefined）：调用方用 `||` 或显式判空决定语义。
// 不做任何大小写或协议归一化，避免在读取阶段改变用户输入。
function readString(value: unknown): string | undefined {
  // 非字符串一律视为未设置：旧文件里数字/布尔混入的情况存在，强转会产出 "123" 这类假有效值。
  return typeof value === "string" ? value.trim() : undefined;
}

// 只接受有限正数：Infinity、NaN、0 与负数都视为「未设置」。
// 该规则用于 contextWindow/maxOutputTokens，避免生成永远无法满足的限制。
function readPositiveNumber(value: unknown): number | undefined {
  // Infinity 与 NaN 也能通过 typeof number，必须先 isFinite 再判正，否则会把永远无法满足的上限写进模型配置。
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// priority 等字段允许负数与 0，因此只要求有限数，不要求正数。
function readFiniteNumber(value: unknown): number | undefined {
  // 不要求正数：旧 priority 数据里出现过 0 与负数，套用正数规则会把合法值误删成未设置。
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// 严格布尔：字符串 "true" 不算，旧文件若写成字符串会被当作未设置。
function readBoolean(value: unknown): boolean | undefined {
  // 不做 "true"/1 的宽松转换：历史读取器把字符串 "false" 当真值，导致模型被错误启用。
  return typeof value === "boolean" ? value : undefined;
}

// 把任意对象窄化成 string→string 的 record，用于 headers。
// 数组与 null 直接拒绝：headers 必须是键值映射，数组会被 Object.entries 拆成下标键。
// 每个键和值都 trim，空键或空值整条丢弃：空 header 名会让 HTTP 客户端抛错。
// 结果为空时返回 undefined 而不是 {}，让调用方用「是否有 headers」判断是否写字段。
// 重复键（trim 后相同）由 Object.fromEntries 后者覆盖，与 HTTP 语义一致。
// 该函数不校验 header 名的合法性，留给下层 HTTP 客户端。
function readStringRecord(value: unknown): Record<string, string> | undefined {
  // 先挡 null 与数组：数组会被 Object.entries 展开成 "0"/"1" 下标键，写进 HTTP 头就是非法名字。
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // flatMap 用空数组表示丢弃单条：空键/空值不进入结果，也就不需要再补一轮后置过滤。
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    // 键要 trim 后再判空：只含空白的 header 名会被 HTTP 客户端拒绝并抛错。
    const normalizedKey = key.trim();
    // 值复用 readString：非字符串 header 值（旧文件里出现过数字）视为无效条目丢弃。
    const normalizedValue = readString(item);
    // as const 固定元组形状，否则 fromEntries 会把宽数组推断成索引类型而丢失键值语义。
    return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
  });
  // 空映射返回 undefined 而非 {}：调用方靠真值判断是否写出 headers 字段，避免落库一个空对象。
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// 从 npm 包名推断协议，作为 kind 缺失时的最后兜底。
// 判定顺序是「越具体越优先」：anthropic → openai-compatible → openai，
// 否则 "@ai-sdk/openai-compatible" 会被 "openai" 抢先匹配成 openai。
// 不区分大小写：旧文件里出现过 "@ai-sdk/Anthropic"。
// 完全无法识别时返回 openai-compatible：未知协议下最保守的选择。
// 该推断只用于旧文件，新结构一律以显式 kind 为准。
function inferModelProviderKindFromOpenCodeProvider(
  provider: ZCodeOpenCodeProviderConfig,
): ModelProviderKind {
  if (provider.kind) {
    // 显式 kind 是权威协议，直接返回：npm 只用来推断没有 kind 的历史文件。
    return provider.kind;
  }
  // 先小写化再匹配：旧文件里包名大小写混杂，直接 includes 会漏掉 "@ai-sdk/Anthropic"。
  const npm = provider.npm?.toLowerCase() ?? "";
  // anthropic 必须先判：包名 "@ai-sdk/openai-compatible" 里也含 "openai"，顺序颠倒会误判成原生 openai。
  if (npm.includes("anthropic")) {
    return "anthropic";
  }
  // 复合包名要排在纯 openai 之前：先消耗掉更具体的 openai-compatible，剩下的才可能是原生包。
  if (npm.includes("openai-compatible")) {
    return "openai-compatible";
  }
  // 走到这里只剩原生 openai 包；再往下就是完全无法识别的包名。
  if (npm.includes("openai")) {
    return "openai";
  }
  // 无法识别时选兼容层：它比原生 openai 适配面更宽，未知 Provider 用它最不容易直接请求失败。
  return "openai-compatible";
}

// 判定旧文件是否已带「新结构运行态字段」，决定是否忽略 zcode 扩展。
// api/npm 也算运行态字段：opencode 原生写法只给这两项。
function hasOpenCodeProviderRuntimeFields(provider: ZCodeOpenCodeProviderConfig): boolean {
  // config.json 的权威运行态字段是 kind/options.baseURL。
  // 旧 endpoints/apiFormat/defaultKind/zcode 可能是历史迁移残留，若继续优先读取会覆盖新配置。
  return Boolean(
    // kind 是显式协议声明，存在即说明该 Provider 已被新版本写过，旧的 zcode 扩展不应再生效。
    provider.kind ||
    // options.baseURL 是新结构里的权威地址字段，优先级高于旧 endpoints。
    readString(provider.options?.baseURL) ||
    // api 是 opencode 原生字段，历史文件只写这一项也算已迁移，不能退回扩展读取。
    readString(provider.api) ||
    // npm 用 trim 判空：空字符串占位在旧文件里存在，不能当成有效运行态字段。
    provider.npm?.trim(),
  );
}

// 决定 Provider 的默认协议，优先级：显式 kind > 运行态字段推断 > defaultKind/zcode 兜底。
// 有运行态字段时优先推断，因为 kind 与 baseURL 冲突时以实际请求地址为准。
// 没有运行态字段时退回 defaultKind（可能是旧版写入的），最后才用 npm 推断。
// 返回值一定是合法 kind：调用方直接把它作为 endpoint paths 的键。
// 该函数不读 baseURL 的路径特征，协议纠偏在 resolvePresetProviderKindFromRuntimeBaseUrl 里。
// 顺序固定，改动会影响所有旧文件的协议判定，属于高风险区域。
function resolveOpenCodeProviderDefaultKind(
  provider: ZCodeOpenCodeProviderConfig,
): ModelProviderKind {
  if (provider.kind) {
    // 显式 kind 直接返回：它是新结构写入的协议声明，任何兜底逻辑都不应覆盖。
    return provider.kind;
  }
  if (readString(provider.options?.baseURL) || readString(provider.api) || provider.npm?.trim()) {
    // 有运行态字段说明已是新结构：协议只能从这些字段推断，defaultKind/zcode 是历史残留，读了会盖掉新配置。
    return inferModelProviderKindFromOpenCodeProvider(provider);
  }
  // 没有运行态字段才回落到旧字段，顺序固定为 defaultKind → zcode.defaultKind → npm 推断。
  // 这里不读 baseURL 路径特征，协议纠偏统一交给 resolvePresetProviderKindFromRuntimeBaseUrl 处理。
  return (
    provider.defaultKind ??
    provider.zcode?.defaultKind ??
    inferModelProviderKindFromOpenCodeProvider(provider)
  );
}

// 只有内置 GLM 系列 Provider 才允许用 baseURL 路径反推协议。
// 返回 undefined 表示「不干预」，调用方回落到 defaultKind。
// 先做小写与 trim：旧文件里出现过大小写混杂的域名。
// 具体路径规则交给 resolveRuntimeBaseUrlPath，非法 URL 会被降级为字符串匹配。
// 该函数不修改 baseURL，只决定协议；baseURL 归一化在 endpoints 处理阶段。
// [权衡] 反推会覆盖用户显式 kind，但只对内置 Provider 生效，避免用户手填的 kind 被静默改动。
function resolvePresetProviderKindFromRuntimeBaseUrl(
  providerId: string,
  baseURL: string | undefined,
): ModelProviderKind | undefined {
  if (!baseURL || !isLegacyPresetGlmProviderId(providerId)) {
    // 非白名单或没有地址时不猜协议：调用方会沿用字段推断出的 defaultKind，避免替用户改配置。
    return undefined;
  }

  // 历史 config.json 可能保存成 kind=anthropic 但 baseURL 指向
  // /coding/paas/v4。ZAI/BigModel 这组内置 provider 的运行协议必须和已知
  // runtime URL 对齐，否则 agent 会用 Anthropic adapter 请求 OpenAI Chat endpoint。
  const normalized = baseURL.trim().toLowerCase();
  if (!normalized) {
    // 全空白视同缺失：不能拿空串去构造 URL，否则只会走到字符串兜底分支做无意义的匹配。
    return undefined;
  }

  // 先取 pathname：域名里可能出现 "anthropic" 字样，直接匹配整串会误判协议。
  const path = resolveRuntimeBaseUrlPath(normalized);

  if (isBigModelCodingPlanLegacyOpenAiRuntime(providerId, normalized)) {
    // BigModel Coding Plan 的默认 runtime 已统一回 Anthropic。
    // 历史落盘的 /coding/paas/v4 不能继续把该内置 provider 推断成 OpenAI-compatible。
    return "anthropic";
  }
  if (path.includes("/coding/paas/v4")) {
    // 这段路径是 OpenAI Chat 兼容端点，按它判定协议，否则 Anthropic 适配器会把请求拼到错误路由。
    return "openai-compatible";
  }
  if (path.includes("/api/anthropic") || path.includes("/zcode-plan/anthropic")) {
    // 两个 Anthropic 网关路径都收敛到 anthropic：内置 Provider 的默认 runtime 已统一到这里。
    return "anthropic";
  }
  // 路径不在已知集合内说明用户换成了自定义反代：不猜协议，交回调用方的默认值。
  return undefined;
}

// 优先取 URL.pathname：这样域名里的 "anthropic" 不会误命中路径规则。
// 非法 URL 退回原字符串小写匹配：历史配置里存在没有协议的裸域名。
// 返回值不带 query/hash，避免 ?redirect=/api/anthropic 干扰判断。
function resolveRuntimeBaseUrlPath(baseURL: string): string {
  try {
    // 只取 pathname：域名、query、hash 都可能带 "anthropic" 等字样，误命中会直接改错协议。
    return new URL(baseURL).pathname.toLowerCase();
  } catch {
    // 非 URL 的历史值继续按原始字符串做保守匹配。
    return baseURL.toLowerCase();
  }
}

// 只针对 BigModel 个人 Coding Plan：旧版本曾把它的 baseURL 写成 /coding/paas/v4。
// 其它 Provider 出现同样路径时不做特殊处理，因为那是用户显式配置。
// 判定同时要求 id 与路径命中，避免把别的 openai-compatible Provider 误迁移成 anthropic。
function isBigModelCodingPlanLegacyOpenAiRuntime(
  providerId: string,
  baseURL: string | undefined,
): boolean {
  if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan) {
    // 只认这一个内置 ID：其它 Provider 用同样路径是用户显式选择，替它迁移等于改用户配置。
    return false;
  }
  const normalized = baseURL?.trim().toLowerCase() ?? "";
  if (!normalized) {
    // 地址缺失或全空白时没有路径可判，直接返回 false 让调用方维持原协议。
    return false;
  }
  // 必须 id 与路径同时命中：同 ID 也可能已被用户改成新 Anthropic 地址，那种情况不需要迁移。
  return resolveRuntimeBaseUrlPath(normalized).includes("/coding/paas/v4");
}

// 把旧文件的 baseURL/endpoints 折算成新结构 endpoints，优先级 options.baseURL > api > 旧 endpoints。
// 有 baseURL 时只生成「当前 kind 的一条 path」，不保留其它协议入口：
// 新结构要求 endpoints 与 defaultKind 一致，多协议入口会让运行时选错适配器。
// BigModel 个人 Coding Plan 即使 baseURL 是旧 /coding/paas/v4 也强制改成 Anthropic 网关，
// 因为该内置 Provider 的默认运行协议已切换，继续用旧地址会 404。
// 普通 Provider 的 baseURL 用 normalizeModelProviderConfiguredBaseUrl 归一化：
// 只 trim/去尾斜杠，不删除 /v1 等路径段——那是用户输入的一部分。
// 没有 baseURL 时原样返回旧 endpoints，交给 normalizeEndpoints 再做折算。
function resolveOpenCodeProviderEndpoints(
  provider: ZCodeOpenCodeProviderConfig,
  defaultKind: ModelProviderKind,
  providerId: string,
): ModelProviderEndpoints {
  // options.baseURL 是新结构权威字段，api 是 opencode 原生写法；前者存在时后者不参与取舍。
  const baseURL = readString(provider.options?.baseURL) ?? readString(provider.api);
  // 有地址就只按当前 kind 生成一条入口，旧 endpoints 全部丢弃，避免多协议入口让运行时选错适配器。
  if (baseURL) {
    if (isBigModelCodingPlanLegacyOpenAiRuntime(providerId, baseURL)) {
      // 旧版本把 BigModel Coding Plan 保存到 OpenAI Chat 的 coding endpoint。
      // 现在该内置 provider 默认使用 Anthropic endpoint，读取时需要把 baseURL 一并迁移。
      return {
        // 传 undefined 强制走环境默认值：旧地址已不可用，保留它会让请求继续打到 OpenAI Chat 端点。
        baseURL: normalizeBigModelCodingPlanAnthropicBaseUrlForEnv(undefined),
        paths: {
          // 固定 /v1/messages：Anthropic 协议下该网关只暴露这一个对话路径。
          anthropic: "/v1/messages",
        },
      };
    }
    if (providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan) {
      // 同一 ID 但已是 Anthropic 地址时仍要过一遍环境归一：测试环境可能残留生产域名导致鉴权失败。
      return {
        // 保留用户路径段，只按环境纠正 origin。
        baseURL: normalizeBigModelCodingPlanAnthropicBaseUrlForEnv(baseURL),
        paths: {
          // 与上一个分支保持同一形状，两条迁移路径产出必须一致。
          anthropic: "/v1/messages",
        },
      };
    }
    // config.json 新结构的 options.baseURL 是用户配置的 runtime baseURL。
    // 读取时不能按 kind 删除 /v1、/responses 等路径段，否则设置页失焦/刷新会改写用户输入。
    const normalizedBaseURL = normalizeModelProviderConfiguredBaseUrl(baseURL);
    return {
      // 只做 trim 与去尾斜杠，路径段原样保留。
      baseURL: normalizedBaseURL,
      paths: {
        // 计算属性键必须用 defaultKind：paths 与 defaultKind 不对应时运行时会找不到该协议的入口。
        [defaultKind]: getDefaultModelProviderEndpointPathForKind(defaultKind),
      },
    };
  }
  // 没有 baseURL 时把旧 endpoints 原样交出去，由 normalizeEndpoints 统一折算，避免两处各写一套规则。
  return provider.endpoints ?? provider.zcode?.endpoints ?? {};
}

// 去掉以 zcode 开头的映射键：那是旧版内部注入的前缀，不是真实模型 ID。
// 大小写不敏感：旧文件里出现过 "ZCode/..."。
// 无映射时返回 undefined，让调用方用条件展开省略该字段而不是写空对象。
function stripZCodePrefixedProviderMappings(
  providerMappings: ProviderModelMappings | undefined,
): ProviderModelMappings | undefined {
  if (!providerMappings) {
    // 无映射直接返回 undefined：调用方用条件展开省略该字段，写空对象会盖掉上层可能存在的映射。
    return undefined;
  }
  const entries = Object.entries(providerMappings ?? {}).filter(
    // 前缀命中即视为旧版内部注入键，不是真实模型 ID；保留会让模型菜单出现无法调用的项。
    ([key]) => !key.toLowerCase().startsWith("zcode"),
  );
  // 过滤后可能为空对象，这里照常返回，调用方会按真值把空对象一并省略。
  return Object.fromEntries(entries);
}

// 把三种历史 reasoning 表示折算成统一的 ModelProviderReasoningSpec。
// preferOpenCodeFields=true 时完全忽略 zcode.reasoningSpec/zcode.reasoning，
// 因为新结构已写入 model.reasoning，旧扩展只是迁移残留。
// reasoning === false 或 undefined 都表示「不支持推理」，返回 undefined。
// enabled === false 是显式关闭：即使有 variants 也不生成 levels。
// variants 为空数组时同样返回 undefined：没有档位的推理配置没有意义。
// levels 的值统一为 {}：具体参数由 Provider 协议层补齐，读取阶段不猜。
// stripModelProviderReasoningPatches 会移除旧 patch 字段，避免把补丁写回新结构。
function openCodeReasoningToModelReasoning(
  model: ZCodeOpenCodeModelConfig,
  options: { preferOpenCodeFields: boolean },
): ModelProviderReasoningSpec | undefined {
  if (!options.preferOpenCodeFields && model.reasoningSpec) {
    // 新结构的 reasoningSpec 是权威值，只清洗旧 patch 字段，不再叠加任何扩展来源。
    return stripModelProviderReasoningPatches(model.reasoningSpec);
  }
  if (!options.preferOpenCodeFields && model.zcode?.reasoning) {
    // 扩展里的 reasoning 与顶层同义，仅在新结构字段缺失时作为兜底来源。
    return stripModelProviderReasoningPatches(model.zcode.reasoning);
  }
  // 只处理顶层布尔/对象两种历史写法：undefined 与 false 都表示不支持推理。
  const reasoning = model.reasoning;
  if (reasoning === undefined || reasoning === false) {
    return undefined;
  }
  // 布尔 true 没有档位信息，因此按空配置折算，只生成空 levels。
  const reasoningConfig = typeof reasoning === "object" ? reasoning : undefined;
  if (reasoningConfig?.enabled === false) {
    // enabled=false 是显式关闭：配置里残留的 variants 也不能用来生成档位。
    return undefined;
  }
  // variants 缺失按空数组处理：没有档位名就无法映射成 levels。
  const variantKeys = reasoningConfig?.variants ?? [];
  if (variantKeys.length === 0) {
    return undefined;
  }
  return {
    // defaultLevel 只在旧配置显式写了 defaultVariant 时出现，避免落一个指向不存在档位的引用。
    ...(reasoningConfig?.defaultVariant ? { defaultLevel: reasoningConfig.defaultVariant } : {}),
    // 档位值统一为 {}：具体参数由协议层补齐，读取阶段猜参数会把错误固化进用户配置。
    levels: Object.fromEntries(variantKeys.map((level) => [level, {}])),
  };
}

// 单个模型的折算入口：把旧字段映射到 createModelProviderModelConfig 的入参。
// zcode 与 zcodeExtensions 分开：前者受 preferOpenCodeFields 影响，后者只用于兜底读取。
// contextWindow 取 limit.context 优先：新结构把上下文写在 limit 里。
// maxOutputTokens 兼容三处来源（limit.output > options.max_tokens > 顶层），
// 因为早期 Provider 只把输出上限存在 options 里。
// hasMaxOutputTokens 是「用户是否显式设置过」的标记：没有该标记时不能把推导值写回。
// kinds 优先顶层（preferOpenCodeFields 为 false 时），再取 zcode 扩展，最后回落到 Provider 默认协议。
// priority/disabledReason/supportsTools 等元信息同时读顶层与扩展，顶层优先。
function openCodeModelToModelProviderModel(
  modelId: string,
  model: ZCodeOpenCodeModelConfig,
  providerDefaultKind: ModelProviderKind,
  options: { preferOpenCodeFields: boolean },
): ModelProviderModelConfig {
  // 新结构优先时把 zcode 置空：下面所有 `zcode?.xxx` 兜底读取会自动失效，不用逐字段判断。
  const zcode = options.preferOpenCodeFields ? undefined : model.zcode;
  // 扩展对象始终保留：hasMaxOutputTokens/priority/modified/deleted 这些标记即使在新结构下也要读。
  const zcodeExtensions = model.zcode;
  // 上下文长度按 limit.context 优先：新结构收敛到 limit，顶层 contextWindow 只是旧版写法。
  // 两者都缺失时保持 undefined，由工厂函数决定默认值，这里不能猜 0。
  const contextWindow =
    readPositiveNumber(model.limit?.context) ?? readPositiveNumber(model.contextWindow);
  // 输出上限按三处来源依次取值：limit.output > options.max_tokens > 顶层 maxOutputTokens。
  // 顺序不能交换：早期 Provider 只在 options 里存过该值，先读顶层会漏掉真实配置。
  const maxOutputTokens =
    readPositiveNumber(model.limit?.output) ??
    readPositiveNumber(model.options?.max_tokens) ??
    readPositiveNumber(model.maxOutputTokens);
  // 早期 provider 配置可能只在 options.max_tokens 或顶层 maxOutputTokens 保存输出值。
  // 读取时按 limit > options > 顶层兼容，写回仍收敛到标准 limit 结构。
  const hasMaxOutputTokens =
    // 顶层标记只在新结构允许时生效：否则它可能是旧迁移残留，会误报「用户设置过」。
    (!options.preferOpenCodeFields ? model.hasMaxOutputTokens : undefined) ??
    // 扩展里的同义标记作为第二来源，覆盖早期两次迁移写入的配置。
    zcode?.hasMaxOutputTokens ??
    // 最后用「是否真的取到值」兜底：取到即视为设置过，没取到则保持 undefined 以免写回推测值。
    maxOutputTokens !== undefined;
  // kinds 取第一个非空来源：顶层 kinds > zcode.kinds > Provider 默认 kind，保证结果至少一项。
  const kinds =
    !options.preferOpenCodeFields && model.kinds?.length
      ? model.kinds
      : zcode?.kinds?.length
        ? zcode.kinds
        : [providerDefaultKind];
  // 统一走工厂函数补齐派生字段，避免本文件与其它 Provider 构造路径出现两套规则。
  return createModelProviderModelConfig({
    // 模型自身 id 优先：Record 的键只是旧文件的默认 id，字段里可能是改名后的显式值。
    id: model.id?.trim() || modelId,
    // name 原样传：空字符串由工厂函数处理，这里二次判空会丢掉「显式置空」的语义。
    name: model.name,
    kinds,
    defaultKind:
      // 顶层 defaultKind 仅新结构下有效，否则可能是旧迁移残留的默认协议。
      (!options.preferOpenCodeFields ? model.defaultKind : undefined) ??
      // 扩展兜底后再回落到 Provider 默认 kind，保证每个模型都有可用协议。
      zcode?.defaultKind ??
      providerDefaultKind,
    contextWindow,
    // 未显式设置过上限时不写该字段：写推导值会让设置页出现用户从未确认的限制。
    maxOutputTokens: hasMaxOutputTokens ? maxOutputTokens : undefined,
    modalities: {
      // 输入/输出缺省保持 undefined，由 apiFormat 推导，这里预设 text 会造出假配置。
      input: model.modalities?.input,
      output: model.modalities?.output,
    },
    // reasoning 折算依赖 preferOpenCodeFields，必须透传 options 而不是在此提前展开。
    reasoning: openCodeReasoningToModelReasoning(model, options),
    // priority 顶层优先、扩展兜底；只接受有限数，NaN 会让排序结果不稳定。
    priority: readFiniteNumber(model.priority) ?? readFiniteNumber(zcodeExtensions?.priority),
    // disabledReason 顶层优先于扩展，扩展里的旧禁用原因不会盖掉新版解禁。
    disabledReason: model.disabledReason ?? zcode?.disabledReason,
    // supportsTools 与 supportsStructuredOutput 都按「顶层 > 扩展」读，两者都缺时由工厂函数按协议推断。
    supportsTools: model.supportsTools ?? zcode?.supportsTools,
    supportsStructuredOutput: model.supportsStructuredOutput ?? zcode?.supportsStructuredOutput,
    // modified 只从扩展读：顶层没有该字段，它表达的是旧版用户手改标记。
    modified: model.modified ?? zcodeExtensions?.modified,
    // deleted 顶层优先于扩展，避免扩展里的旧值覆盖新的墓碑状态。
    deleted: model.deleted ?? zcodeExtensions?.deleted,
  });
}

// 墓碑 ID 归一化：trim、去空、按小写去重，保留首次出现的原始大小写。
// 去重必须大小写不敏感，否则 "GLM-4" 与 "glm-4" 会生成两个墓碑。
// 返回数组而非 Set：后续按顺序插入 models，保持文件中的声明顺序。
// 空串直接丢弃：删除空 ID 没有语义，还会污染 modelKeys。
// 不做模型 ID 的协议映射：墓碑只表达「这个 ID 被删除」。
function normalizeDeletedModelIds(modelIds: readonly string[] | undefined): string[] {
  // 结果用数组保持文件里的声明顺序：顺序决定墓碑插入 models 的位置，进而影响设置页展示。
  const deletedModels: string[] = [];
  // seen 存小写 key：去重必须大小写不敏感，否则 "GLM-4" 与 "glm-4" 会各生成一个墓碑。
  const seen = new Set<string>();
  // 缺失或 null 一律按空列表处理：Provider 级 deletedModels 是可选字段。
  for (const rawModelId of modelIds ?? []) {
    // 先 trim 再去空：旧文件里存在带空格的 ID，带空格写进 models 会导致 ID 永远匹配不上。
    const modelId = rawModelId.trim();
    // 大小写不同视为同一模型：key 小写去重，models 里保留首个入列的原始拼写。
    const key = modelId.toLowerCase();
    // 空 ID 与重复 ID 都跳过：空墓碑没有语义，重复项会让 models 出现两条同名记录。
    if (!modelId || seen.has(key)) {
      continue;
    }
    // 先登记再入列：登记放在 continue 之后，保证被跳过的 ID 不会污染 seen。
    seen.add(key);
    deletedModels.push(modelId);
  }
  // 返回新数组而非 Set：调用方需要按顺序消费，顺序不能丢失。
  return deletedModels;
}

// 墓碑模型必须有最小可用配置：id、kinds、contextWindow、模态缺一不可，
// 否则 Registry 的模型校验会把它过滤掉，删除语义随之丢失。
// modified=true 表示这是本地产生的记录，不是官方同步结果。
// deleted=true 是唯一让 filterDeletedProviderModelsForRead 过滤掉的标记。
function createDeletedModelTombstone(
  modelId: string,
  providerDefaultKind: ModelProviderKind,
): ModelProviderModelConfig {
  // 墓碑也必须走同一个工厂函数：字段形状要与真实模型一致，否则 Registry 校验会把它过滤掉。
  return createModelProviderModelConfig({
    // id 用规范化后的墓碑 ID，与真实模型口径一致，去重逻辑才能正确合并。
    id: modelId,
    kinds: [providerDefaultKind],
    // 上下文用旧模型回退常量：写 0 会让上下文校验失败，墓碑随即从读取结果里消失。
    contextWindow: LEGACY_FALLBACK_CONTEXT_WINDOW,
    // 模态给最小 text/text：墓碑不需要真实能力，但缺字段会被模型校验判为非法。
    modalities: { input: ["text"], output: ["text"] },
    // modified=true 表示这是本地生成记录，不允许 Catalog 同步覆盖它。
    modified: true,
    // deleted=true 是唯一让读取视图过滤掉它的标记，缺了它墓碑会出现在模型菜单里。
    deleted: true,
  });
}

// 旧 Provider → 新 ModelProviderConfig 的主转换函数。
// preferOpenCodeFields 决定「是否信任 zcode 扩展」：新结构字段存在时扩展一律忽略。
// configuredDefaultKind 先由字段推断，再用 baseURL 路径纠偏内置 Provider 的协议。
// endpoints 与 defaultKind 必须一起决定：endpoint 的 paths 以 defaultKind 为键。
// apiKey 从 options.apiKey 读取并 trim；空串是合法值（表示未配置）。
// models 先按文件顺序转换，再追加墓碑：顺序影响设置页展示。
// modelKeys 用规范化后的 id 建集合，避免墓碑与真实模型重复。
// enabled/systemDisabledReason 用「顶层优先、扩展兜底、缺省不写」的三段式展开。
// source 缺省写入 "custom"：旧文件里的自定义 Provider 没有 source 字段。
// 最后统一交给 normalizeProviderForStore 做 endpoints/models/apiFormat 的二次规范化。
function openCodeProviderToModelProviderConfig(
  providerId: string,
  provider: ZCodeOpenCodeProviderConfig,
): ModelProviderConfig {
  // 扩展整体先取出：下面每个字段都要按「顶层 > 扩展」读取，集中取引用避免优先级逻辑散落各处。
  const zcode = provider.zcode;
  // 该开关为真表示这份配置已由新结构写过，所有 zcode 兜底读取随之失效。
  const preferOpenCodeFields = hasOpenCodeProviderRuntimeFields(provider);
  // 基础协议只来自字段推断，作为下面 baseURL 纠偏的默认值。
  const configuredDefaultKind = resolveOpenCodeProviderDefaultKind(provider);
  // options 兜底成空对象：旧 Provider 可能完全没有 options，直接取属性会抛 TypeError。
  const options = provider.options ?? {};
  // 纠偏用地址：options.baseURL 优先于 api，两者语义相同但写入来源不同。
  const configuredRuntimeBaseURL = readString(options.baseURL) ?? readString(provider.api);
  // 路径特征优先于字段推断，且只对内置 GLM 白名单生效；返回 undefined 时沿用原协议。
  const defaultKind =
    resolvePresetProviderKindFromRuntimeBaseUrl(providerId, configuredRuntimeBaseURL) ??
    configuredDefaultKind;
  // endpoints 依赖 defaultKind：paths 的键必须与它一致，因此这一步顺序不能提前。
  const endpoints = resolveOpenCodeProviderEndpoints(provider, defaultKind, providerId);
  // apiKey 缺失时写空串：新结构用空串表达「已读取该 Provider 但未配置密钥」。
  const apiKey = readString(options.apiKey) ?? "";
  // 一次性取时间戳：同一 Provider 的 createdAt/updatedAt 缺省值必须相同，否则排序会抖动。
  const now = Date.now();
  // 先按文件顺序转换真实模型：顺序决定设置页展示，墓碑只能追加在末尾。
  const models = Object.entries(provider.models ?? {}).map(([modelId, model]) =>
    openCodeModelToModelProviderModel(modelId, model, defaultKind, {
      // 偏好开关必须透传到模型层，保证 Provider 与模型两级用同一个开关。
      preferOpenCodeFields,
    }),
  );
  // 模型 ID 统一小写 trim 后建集合：去重口径必须与 normalizeDeletedModelIds 保持一致。
  const modelKeys = new Set(models.map((model) => model.id.trim().toLowerCase()).filter(Boolean));
  // 逐个补墓碑：文件里可能已有同名模型，直接追加会产生同 ID 的两条记录。
  for (const deletedModelId of normalizeDeletedModelIds(zcode?.deletedModels)) {
    const key = deletedModelId.toLowerCase();
    // 真实模型优先于删除记录：命中就跳过，否则会把仍在使用的模型从列表里隐藏掉。
    if (modelKeys.has(key)) {
      continue;
    }
    // 追加最小可用配置，保证删除语义在 Registry 校验后仍然存活。
    models.push(createDeletedModelTombstone(deletedModelId, defaultKind));
    // 立即登记新 key：同一批墓碑出现重复 ID 时不会插入第二次。
    modelKeys.add(key);
  }
  // apiKeyRequired 顶层优先、扩展次之、options 最后：前者是新结构写入的权威值。
  const apiKeyRequired =
    provider.apiKeyRequired ?? zcode?.apiKeyRequired ?? readBoolean(options.apiKeyRequired);
  // 新结构下丢弃整个映射表：那是旧版内部映射，沿用会让模型 ID 被改回旧值。
  const providerMappings = preferOpenCodeFields
    ? undefined
    : stripZCodePrefixedProviderMappings(provider.providerMappings ?? zcode?.providerMappings);
  // 交给落库前规范化：defaultKind/apiFormat/models 的二次收敛统一在那里完成，避免两处规则分叉。
  return normalizeProviderForStore({
    // id 为空时回落到文件键，保证 Provider 始终有可引用标识。
    id: provider.id?.trim() || providerId,
    // name 同理：空名字在设置页无法展示，用 id 兜底比留空更可控。
    name: provider.name?.trim() || providerId,
    // enabled 三段式展开：顶层 > 扩展，都没有时不写字段，由上层按产品策略决定默认值。
    ...(provider.enabled !== undefined
      ? { enabled: provider.enabled }
      : zcode?.enabled !== undefined
        ? { enabled: zcode.enabled }
        : {}),
    // 禁用原因仅在存在时写入：写 undefined 会覆盖上层可能已生成的诊断信息。
    ...((provider.systemDisabledReason ?? zcode?.systemDisabledReason)
      ? {
          systemDisabledReason: provider.systemDisabledReason ?? zcode?.systemDisabledReason,
        }
      : {}),
    // endpoints 已在上面按 defaultKind 收敛，直接传入，规范化阶段不需要再猜协议。
    endpoints,
    apiFormat: preferOpenCodeFields
      // 新结构下必须由 defaultKind 推导：旧 apiFormat 可能与实际地址矛盾，读进来会让运行时选错适配器。
      ? resolveModelProviderKindApiFormat(defaultKind)
      // 旧结构才允许读显式 apiFormat，最后仍回落到 defaultKind 的推导值。
      : (provider.apiFormat ?? zcode?.apiFormat ?? resolveModelProviderKindApiFormat(defaultKind)),
    // source 缺省写 custom：旧文件没有该字段，不写会让 Registry 把 Provider 当成未知来源。
    ...((provider.source ?? zcode?.source)
      ? { source: provider.source ?? zcode?.source }
      : { source: "custom" }),
    // Catalog 关联三字段都只在存在时写入：空值会让 Catalog 按空 ID 去查并直接报错。
    ...((provider.catalogSourceId ?? zcode?.catalogSourceId)
      ? { catalogSourceId: provider.catalogSourceId ?? zcode?.catalogSourceId }
      : {}),
    ...((provider.catalogProviderId ?? zcode?.catalogProviderId)
      ? {
          catalogProviderId: provider.catalogProviderId ?? zcode?.catalogProviderId,
        }
      : {}),
    ...((provider.modelsDevProviderId ?? zcode?.modelsDevProviderId)
      ? {
          modelsDevProviderId: provider.modelsDevProviderId ?? zcode?.modelsDevProviderId,
        }
      : {}),
    // undefined 表示「未知」，不写该字段，交给上层按 Provider 类型判断是否需要鉴权。
    ...(apiKeyRequired !== undefined ? { apiKeyRequired } : {}),
    // headers 三来源：顶层 > 扩展 > options.headers，最后一项是旧版把 header 塞进 options 的写法。
    ...((provider.headers ?? zcode?.headers ?? readStringRecord(options.headers))
      ? {
          headers: provider.headers ?? zcode?.headers ?? readStringRecord(options.headers),
        }
      : {}),
    // logo 与 apiKey 链接仅存在时写入，空串会让设置页渲染出空白图标或死链。
    ...((provider.logoUrl ?? zcode?.logoUrl)
      ? { logoUrl: provider.logoUrl ?? zcode?.logoUrl }
      : {}),
    // apiKey 无条件写入：空串同样是合法值（表示已加载但未配置密钥），省略会丢失这层区分。
    apiKey,
    ...((provider.apiKeyUrl ?? zcode?.apiKeyUrl)
      ? { apiKeyUrl: provider.apiKeyUrl ?? zcode?.apiKeyUrl }
      : {}),
    // defaultKind 必须与上面 endpoints/apiFormat 用同一个值，否则落库后协议与入口会不一致。
    defaultKind,
    // models 已含真实模型与墓碑，规范化阶段只清洗不过滤，删除语义靠 deleted 标记保留。
    models,
    // 映射为空时省略字段：写空对象会让运行时误以为存在一张映射表。
    ...(providerMappings ? { providerMappings } : {}),
    // 时间戳只在旧结构下取原值：新结构字段不参与，缺省统一用 now，避免落库出 undefined 让排序异常。
    createdAt:
      (!preferOpenCodeFields ? (provider.createdAt ?? zcode?.createdAt) : undefined) ?? now,
    updatedAt:
      (!preferOpenCodeFields ? (provider.updatedAt ?? zcode?.updatedAt) : undefined) ?? now,
  });
}

// 读取并校验旧 config.json，是唯一接触磁盘的函数。
// 返回 null 仅表示文件不存在；其它失败一律抛出，且错误信息只含 stage/path/code/field。
// [失败路径] IO 错误按 code 区分：ENOENT → null，其它（EACCES/EISDIR/EMFILE）→ 抛出。
// 早期实现把所有 IO 错误都当成「没有文件」，导致 Importer 提交空配置并永久抹掉用户设置。
// JSON.parse 的错误被丢弃、不通过 cause 传递：错误消息可能回显包含 API Key 的片段。
// schema 校验失败只上报第一个 issue 的路径（截断 256 字符），不上报字段值。
// 读文件用 utf-8 显式编码：Windows 上默认编码不确定。
// 不做 BOM 处理：JSON.parse 遇到 BOM 会失败，这里保持与旧行为一致。
// 该函数不缓存：每次迁移都需要看到最新磁盘内容。
async function readRawZCodeConfigFile(): Promise<ZCodeConfigFile | null> {
  // 每次读取都重新定位文件：该函数不做缓存，迁移必须看到最新磁盘内容。
  const filePath = getZCodeConfigFilePath();
  // 先声明再在 try 内赋值：后续步骤要用到 raw，写在 try 里会因作用域不足而拿不到。
  let raw: string;
  try {
    // 显式指定 utf-8：Windows 默认编码不确定，按系统编码读会把中文 Provider 名解析成乱码。
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 旧读取器把所有失败当作文件不存在，Importer 会因此永久提交空 Personal 配置。
    // 只有 ENOENT 允许初始化空配置；其余错误交给 Repository 保留磁盘并报告失败。
    if (code === "ENOENT") return null;
    // 错误信息只带 stage/path/code，不回显文件内容，避免把配置里的 API Key 写进日志。
    throw new Error(`旧 Provider 配置读取失败 stage=io path=${filePath} code=${code ?? "unknown"}`);
  }
  // 解析结果先按 unknown 持有：schema 校验前不能假定形状，否则会在运行时取到 undefined。
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    // JSON/Zod 原始错误可能包含 API Key 等输入值；不能写入日志或通过 cause 向外传递。
    throw new Error(`旧 Provider 配置解析失败 stage=json path=${filePath}`);
  }
  // 用 safeParse 而不是 parse：后者抛出的 zod 错误会带上 input，存在泄漏密钥的风险。
  const parsed = zcodeConfigFileSchema.safeParse(json);
  if (!parsed.success) {
    // 只取第一个 issue 的路径并截断：路径足以定位字段，值不能外泄，长度上限防止日志被撑爆。
    const field = parsed.error.issues[0]?.path.map(String).join(".").slice(0, 256) ?? "";
    // 校验失败必须抛错：静默返回空配置会让 Importer 提交并永久抹掉用户设置。
    throw new Error(`旧 Provider 配置校验失败 stage=schema path=${filePath} field=${field}`);
  }
  // 返回 parsed.data 而非原始 json：passthrough 已保留未知键，同时保证已知字段有正确类型。
  return parsed.data;
}

// 读取并转换全部 Provider；没有 provider 表时返回 null（区别于「有表但为空」）。
// 转换顺序即文件顺序，applyProviderStoreMigrations 会再做过滤与规范化。
// 单个 Provider 转换失败会中断整次读取：部分迁移比不迁移更危险。
// 返回的数组尚未过滤墓碑模型，过滤发生在面向读取的 readLegacyZCodeConfigProviders。
async function readZCodeConfigProviders(): Promise<ModelProviderConfig[] | null> {
  // 读取失败会直接抛错，这里不 catch：把异常吞掉会让上层误以为迁移成功。
  const config = await readRawZCodeConfigFile();
  if (!config?.provider) {
    // provider 表缺失等价于「没有可迁移的 Provider」；返回 null 与「有表但为空」（返回 []）区分开。
    return null;
  }
  // 按文件顺序转换：Object.entries 保留插入顺序，迁移后的设置页顺序才与旧文件一致。
  const providers = Object.entries(config.provider).map(([providerId, provider]) =>
    openCodeProviderToModelProviderConfig(providerId, provider),
  );
  // 统一的落库边界：过滤退役 Provider 后再规范化一次，返回结果可直接合并进新 store。
  return applyProviderStoreMigrations(providers);
}

// 按 Provider 的 apiFormat/modelSupportedFormats 推导模型可用协议列表。
// 优先用 modelSupportedFormats[modelId]：它可能来自 Built-in 模板，比 apiFormat 更精确。
// 没有 formats 时按 apiFormat 或 endpoints 推导，二者最终都映射到 kind。
// 推导结果去重后仍为空时回落到 Provider 默认 kind，保证 kinds 至少有一项。
function normalizeModelKindsFromProvider(
  provider: Pick<
    ModelProviderConfig,
    "apiFormat" | "defaultKind" | "endpoints" | "modelSupportedFormats"
  >,
  modelId: string,
): ModelProviderKind[] {
  // 优先取按模型 ID 记录的 formats：它可能来自 Built-in 模板，比 Provider 级 apiFormat 更精确。
  const formats =
    provider.modelSupportedFormats?.[modelId] ??
    // 没有按模型的 formats 时按 apiFormat 推导，两者都缺失才退回 endpoints 推导。
    (provider.apiFormat
      ? getDefaultModelSupportedFormatsFromApiFormat(provider.apiFormat)
      : getDefaultModelSupportedFormatsFromEndpoints(provider.endpoints));
  // 逐个 format 映射成 kind，无法映射的返回空数组让 flatMap 直接展平掉。
  const kinds = formats.flatMap((format) => {
    const kind = mapModelProviderSupportedFormatToKind(format);
    // 用空数组表示丢弃：返回 undefined 会在下游留下一个无意义的占位项。
    return kind ? [kind] : [];
  });
  if (kinds.length > 0) {
    // 去重后返回：同一 format 可能由多个来源重复给出，重复协议会让运行时重复尝试适配器。
    return [...new Set(kinds)];
  }

  // 推不出任何 kind 时回落到 Provider 默认协议，保证模型至少有一个可用入口。
  const defaultKind = resolveModelProviderDefaultKind(provider);
  // 默认协议也推不出时返回空数组：调用方会保留原有 kinds，而不是写入非法值。
  return defaultKind ? [defaultKind] : [];
}

// 规范化已是对象形态的模型：trim id/name、修正 contextWindow、去重 kinds 与模态。
// id 为空返回 null：没有 ID 的模型无法被引用，保留会让 Registry 报错。
// 该函数只做「清洗」不做「补全」，缺失字段保持缺失。
function normalizeModelProviderModelConfigEntry(
  model: ModelProviderModelConfig,
): ModelProviderModelConfig | null {
  // 先 trim 再判空：只有空白的 ID 无法被引用，保留会让 Registry 按 ID 查找时直接失败。
  const id = model.id.trim();
  if (!id) {
    return null;
  }

  return {
    // 展开原对象保留未声明字段：该函数只清洗不补全，丢字段会让上层丢失扩展信息。
    ...model,
    // 用 trim 后的 id 覆盖原值，保证与 kinds、映射表里的 ID 口径一致。
    id,
    // name 为空时写 undefined：空字符串在设置页会渲染成空白，而不是回落到 id 展示。
    name: model.name?.trim() || undefined,
    // contextWindow 交给共享 helper：0/负数等非法值会在这里被重置为默认窗口。
    contextWindow: resolveModelProviderContextWindow(model.contextWindow),
    // kinds 去重：重复协议会让运行时在同一模型上重复尝试适配器。
    kinds: [...new Set(model.kinds)],
    modalities: {
      // 两个维度各自去重：重复项会让 UI 的模态标签重复展示。
      input: [...new Set(model.modalities.input)],
      output: [...new Set(model.modalities.output)],
    },
  };
}

// 模型列表规范化，分两条路径：
// 1) 列表里已有对象模型（预置同步 + 用户自定义混合）→ 逐项清洗或补最小配置；
// 2) 全是字符串（纯 legacy 列表）→ 走 migrateLegacyModelProviderConfig 保留旧语义。
// 混合列表不能整表交给 legacy 迁移：对象里的 contextWindow/reasoning 会丢失。
// 字符串模型补 kinds/name 时使用 Provider 级默认值，而不是模型级猜测。
// seen 按规范化后的 id 去重：文件里同时存在字符串 "glm-4" 与对象 {id:"glm-4"} 时只保留第一个。
// legacy 迁移失败时（schema 不匹配）退回 getModelProviderModelIds 的最简构造。
// 不在此处过滤 deleted 模型：读取路径需要墓碑来同步删除状态。
function normalizeProviderModels(provider: ModelProviderConfig): ModelProviderModelConfig[] {
  // 只要出现一个对象模型就走混合路径：对象可能带 contextWindow/reasoning，整表走 legacy 迁移会丢元数据。
  const hasModelConfigs = provider.models.some(isModelProviderModelConfig);
  if (hasModelConfigs) {
    // 预置同步会产生“官方字符串模型 + 用户自定义对象模型”的混合列表。
    // 混合列表不能整表走 legacy 迁移：对象里的 contextWindow/reasoning 等 metadata 会丢失。
    const seen = new Set<string>();
    // flatMap 用空数组表示丢弃：无 ID 与重复 ID 都在回调里直接跳过，不需要外层再过滤。
    return provider.models.flatMap((rawModel) => {
      // 对象取 id，字符串本身就是 id；统一成字符串后再 trim，两种形态才走同一套判空逻辑。
      const rawModelId = isModelProviderModelConfig(rawModel) ? rawModel.id : rawModel;
      const modelId = rawModelId.trim();
      if (!modelId) {
        // 空 ID 无法被引用：写进模型列表会让 Registry 在按 ID 查找时失败。
        return [];
      }

      // 对象走清洗，字符串走最小构造：字符串没有元数据可保留，只能按 Provider 默认值补齐。
      const normalizedModel = isModelProviderModelConfig(rawModel)
        ? normalizeModelProviderModelConfigEntry(rawModel)
        : createModelProviderModelConfig({
            id: modelId,
            name: provider.modelDisplayNames?.[modelId],
            kinds: normalizeModelKindsFromProvider(provider, modelId),
            defaultKind: resolveModelProviderDefaultKind(provider),
          });
      if (!normalizedModel || seen.has(normalizedModel.id)) {
        // 清洗失败或 ID 已出现过都丢弃，保证返回列表内 ID 唯一。
        return [];
      }

      // 先登记再返回：登记必须在判重之后，否则重复项会把自己挡掉。
      seen.add(normalizedModel.id);
      return [normalizedModel];
    });
  }

  // 全是字符串才是真正的 legacy 形态，交给迁移函数保留旧版语义（含默认 kind 推导）。
  const migrated = legacyModelProviderListSchema.safeParse([provider]);
  if (migrated.success) {
    // 迁移结果只留对象模型：字符串会在下游被当成无元数据项，导致 kinds 丢失。
    return migrateLegacyModelProviderConfig(migrated.data[0]!).models.filter(
      isModelProviderModelConfig,
    );
  }

  // schema 不匹配的极旧数据走最简构造，至少保证每个 ID 都有一个可用模型对象。
  const seen = new Set<string>();
  return getModelProviderModelIds(provider).flatMap((modelId) => {
    if (seen.has(modelId)) {
      // 重复 ID 直接丢弃：自定义列表与内置列表可能给出同一个 ID。
      return [];
    }
    seen.add(modelId);
    return [
      createModelProviderModelConfig({
        // 显示名取 Provider 级旁路表：缺失时由工厂函数回落到 id。
        id: modelId,
        name: provider.modelDisplayNames?.[modelId],
        // kinds 与 defaultKind 都从 Provider 级信息推导，与上面两条路径保持同一口径。
        kinds: normalizeModelKindsFromProvider(provider, modelId),
        defaultKind: resolveModelProviderDefaultKind(provider),
      }),
    ];
  });
}

// 判断是否已有新结构 endpoints：baseURL 或 paths 任一存在即视为「规范」。
// 空字符串 trim 后不算：旧文件里出现过 baseURL="" 的占位值。
function hasCanonicalEndpoints(endpoints: ModelProviderEndpoints): boolean {
  // baseURL 要 trim 后非空才算：历史文件里存在 baseURL="" 的占位值，空串不代表已配置。
  return Boolean(endpoints.baseURL?.trim() || endpoints.paths);
}

// 计算落库用的默认协议。已有 defaultKind/apiFormat/规范 endpoints 时直接交给共享 helper。
// 旧 v2 store 可能只有 endpoints.anthropic/openai，新 helper 不再读这些字段，
// 因此必须在迁移边界先把它们折算成 defaultKind。
// 两个旧入口同时存在时优先 anthropic：v2 时代 anthropic 是主协议。
function resolveProviderDefaultKindForStore(provider: ModelProviderConfig): ModelProviderKind {
  if (provider.defaultKind || provider.apiFormat || hasCanonicalEndpoints(provider.endpoints)) {
    // 信息已足够时交给共享 helper：它理解新结构的完整口径，这里不重复实现同一套判断。
    return resolveModelProviderDefaultKind(provider);
  }

  // 旧 v2 store 可能仍只带 endpoints.anthropic/openai。
  // 新运行态 helper 不再读取旧字段，这里必须在迁移边界先推导 defaultKind 再落 runtime endpoint。
  if (provider.endpoints.anthropic?.trim()) {
    // 两个旧入口同时存在时优先 anthropic：v2 时代 anthropic 是主协议，按它迁移才与历史行为一致。
    return "anthropic";
  }
  if (provider.endpoints.openai?.trim()) {
    // 旧字段名 openai 对应的新 kind 是 openai-compatible，两者并非同名，不能直接透传。
    return "openai-compatible";
  }
  // 两个旧入口都没有时回落共享 helper，它会在无信息时给出保守默认值而不是抛错。
  return resolveModelProviderDefaultKind(provider);
}

// 落库前的最终规范化，保证「读旧文件」与「写新结构」后语义一致。
// 顺序：defaultKind → endpoints（依赖 defaultKind）→ apiFormat（依赖两者）→ models（依赖三者）。
// 这个顺序不能调换：apiFormat 由 endpoints 推导，models 的 kinds 又依赖 apiFormat。
// modelDisplayNames/modelSupportedFormats 是旧版旁路表，规范化后清空：
// 它们的信息已并入每个模型对象，继续保留会产生两份事实。
// providerMappings 去掉 legacy claude 映射与 zcode 前缀键，避免旧内部数据进入新结构。
// 展开 ...provider 保留未声明字段（如 future 扩展），显式字段覆盖旧值。
// 对已经是新结构的 Provider 也是幂等的：重复规范化不会改变结果。
// [失败路径] 内部 helper 对非法值降级而不是抛错，单个坏 Provider 不会阻断整次迁移。
function normalizeProviderForStore(provider: ModelProviderConfig): ModelProviderConfig {
  // 先定 defaultKind：下面 endpoints 的 paths 键与 apiFormat 推导都依赖它，顺序不能调换。
  const defaultKind = resolveProviderDefaultKindForStore(provider);
  // 只保留当前 kind 的一条端点：落库结构里 paths 只按 defaultKind 建键，其它入口无处安放。
  const normalizedEndpoints = normalizeEndpoints(provider.endpoints, defaultKind);
  // apiFormat 由 defaultKind 与收敛后的 endpoints 共同推导，必须在上一步之后计算。
  const apiFormat = resolveModelProviderApiFormat({
    apiFormat: provider.apiFormat,
    defaultKind,
    endpoints: normalizedEndpoints,
  });
  // models 的 kinds 依赖 apiFormat，所以放在最后；展开 provider 是为了让模型层看到收敛后的协议。
  const normalizedModels = normalizeProviderModels({
    ...provider,
    apiFormat,
    defaultKind,
    endpoints: normalizedEndpoints,
    modelSupportedFormats: provider.modelSupportedFormats,
  });

  return {
    // 展开保留未声明字段：未来新增的扩展字段不应在迁移时被丢弃。
    ...provider,
    // 显式字段覆盖旧值，必须放在展开之后，否则会被旧值盖回去。
    apiFormat,
    defaultKind,
    endpoints: normalizedEndpoints,
    models: normalizedModels,
    // 两张旁路表的信息已并入模型对象，置空避免同一事实存两份而分叉。
    modelDisplayNames: undefined,
    modelSupportedFormats: undefined,
    // 先去 legacy claude 映射再去 zcode 前缀：前者是更早期格式，先处理才不会漏掉嵌套键。
    providerMappings: stripZCodePrefixedProviderMappings(
      stripLegacyClaudeProviderMappings(provider.providerMappings),
    ),
  };
}

// 迁移边界的最后一道过滤：
// - 移除已下线的 builtin:zapi；
// - 移除「default-* 且 apiKey 为空」的预置模板（用户从未启用）。
// 预置模板不随产品分发，保留它们会占用设置页与模型菜单。
// apiKey 为空字符串（trim 后）才算未启用：只有空白的 Key 视为无效配置。
// 过滤后再统一 normalizeProviderForStore，避免对将被删除的 Provider 做无谓转换。
// 这里不写入 Catalog 补值：旧 Store 不能按模型 ID 从另一份 Catalog 回填并持久化。
// [权衡] 过滤规则写死在迁移边界，新增退役 ID 需要改这里，但能保证每次读取结果一致。
function applyProviderStoreMigrations(providers: ModelProviderConfig[]): ModelProviderConfig[] {
  // default-* 预置模板不随产品分发：空 API Key 表示用户从未启用该供应商。
  // 在迁移边界清掉这些旧预置项，避免刷新后继续占用设置页和模型菜单。
  let next = providers.filter(
    (provider) =>
      // 退役 ID 直接移除：保留它会让设置页出现一个永远不可用的入口。
      provider.id !== RETIRED_ZAPI_PROVIDER_ID &&
      // 预置模板且 apiKey trim 后为空才视为未启用；有 Key 说明用户真正配置过，不能删。
      !(provider.id.startsWith("default-") && provider.apiKey.trim().length === 0),
  );

  // 迁移边界只规范化旧文件里真实存在的值。模型 Properties、Option Specs 与
  // reasoning mapping 由 ZCode Built-in/Personal ModelConfigRules 在 Registry 中解析；
  // 旧 Store 不能再按 Model ID 从另一份 Catalog 补值并把补值持久化回用户文件。
  // 过滤后才规范化：对将被删除的 Provider 做转换没有意义，还会拖慢启动。
  return next.map(normalizeProviderForStore);
}

/** 只读取已发布旧 config.json；更早期的独立 Provider Store 已退出所有迁移链路。 */
// 对外唯一入口：读取已发布旧 config.json 并返回可合并的 Provider 列表。
// 没有旧文件或没有 provider 表时返回空数组（不是 null），调用方无需判空。
// 对外契约里 deletedAt 非空即视为不存在：调用方拿到过滤后的列表，不能靠墓碑 ID 做判断。
// 更早期的独立 Provider Store 已退出迁移链路，因此这里只读 config.json。
export async function readLegacyZCodeConfigProviders(): Promise<ModelProviderConfig[]> {
  // 没有旧文件或没有 provider 表时该值为 null，这里折成空数组，调用方无需区分两种「没有」。
  const configProviders = await readZCodeConfigProviders();
  // 过滤墓碑后返回：对外语义是「已删除的模型不存在」，但文件里的删除记录仍会被保留用于同步。
  return configProviders ? filterDeletedProviderModelsForRead(configProviders) : [];
}

// 读取视图过滤墓碑：字符串模型无从判断 deleted，因此原样保留。
// 只过滤 deleted === true 的对象模型，modified/其它标记不影响。
// 返回新对象，不修改 Provider 或模型数组。
function filterDeletedProviderModelsForRead(
  providers: ModelProviderConfig[],
): ModelProviderConfig[] {
  return providers.map((provider) => ({
    // 返回新对象而不是原地改：调用方可能还持有原数组用于合并，改动会让迁移结果互相污染。
    ...provider,
    // 字符串模型无从判断 deleted，因此保留；只过滤显式 deleted=true 的对象模型。
    models: provider.models.filter(
      // 必须严格比较 !== true：undefined 与 false 都表示未删除，宽松判空会误删正常模型。
      (model) => !isModelProviderModelConfig(model) || model.deleted !== true,
    ),
  }));
}

// 从旧 endpoints.anthropic/openai 取一条可用的 baseURL，按目标 kind 归一化。
// 目标 kind 对应的入口缺失时退回另一条：旧 store 可能只配了单一协议入口。
// 两条都没有时返回空串，由调用方决定是否写 endpoints。
function resolveLegacyRuntimeBaseUrlForKind(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): string {
  // 按目标 kind 取对应入口：anthropic 用 anthropic 字段，其它协议统一用 openai 入口。
  const rawEndpoint =
    defaultKind === "anthropic" ? endpoints.anthropic?.trim() : endpoints.openai?.trim();
  if (rawEndpoint) {
    // 命中后按 kind 归一化：只去尾斜杠，不裁剪路径段，保留用户输入。
    return normalizeModelProviderBaseUrlForKind(rawEndpoint, defaultKind);
  }
  // 目标入口缺失时退回另一条：旧 store 可能只配了单一协议入口，不退回会直接拿到空串。
  const fallbackEndpoint = endpoints.anthropic?.trim() || endpoints.openai?.trim() || "";
  // 两条都没有时返回空串：调用方据此决定不写 endpoints 字段。
  return fallbackEndpoint
    ? normalizeModelProviderBaseUrlForKind(fallbackEndpoint, defaultKind)
    : "";
}

// 计算落库用的 runtime baseURL：新 helper 优先，其次 endpoints.baseURL，最后旧入口。
// 新 helper 会按 defaultKind 与 apiFormat 选择正确的入口，并做协议相关归一化。
// endpoints.baseURL 是用户输入，只做去尾斜杠等无损归一化。
// 旧 store 只有 endpoints.anthropic/openai 时，按 defaultKind 取一条旧入口。
// 三步都失败时返回空串，normalizeEndpoints 会因此返回 {}。
// 该函数不抛错：非法 URL 在 normalizeModelProviderBaseUrlForKind 内部降级。
// [权衡] 只保存「当前 kind 的一条」，多协议入口在落库时被丢弃，换取运行时不再做协议猜测。
function resolveRuntimeBaseUrlForStore(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): string {
  const runtimeBaseURL = resolveModelProviderRuntimeBaseUrl(
    {
      // 传 kind 级 apiFormat 而不是 Provider 级值：运行时入口选择只认当前 kind 的协议口径。
      apiFormat: resolveModelProviderKindApiFormat(defaultKind),
      defaultKind,
      endpoints,
    },
    defaultKind,
  );
  if (runtimeBaseURL) {
    // 已经拿到可用地址就直接返回：这一步内部已包含多协议入口的选择与归一化。
    return runtimeBaseURL;
  }

  // helper 失败时退回 endpoints.baseURL：它是用户输入，只做无损归一化（trim/去尾斜杠）。
  const baseURL = endpoints.baseURL?.trim();
  if (baseURL) {
    return normalizeModelProviderBaseUrlForKind(baseURL, defaultKind);
  }

  // 旧 store 可能还只有 endpoints.anthropic/openai。
  // runtime config 只能保存当前 kind 的 baseURL，这里按 defaultKind 取一条旧入口。
  // 三步都取不到时返回空串，normalizeEndpoints 会因此返回 {}，表示该 Provider 没有可执行端点。
  return resolveLegacyRuntimeBaseUrlForKind(endpoints, defaultKind);
}

// 把各种旧 endpoints 形态收敛成 { baseURL, paths: { [defaultKind]: 默认路径 } }。
// 没有可用的 baseURL 时返回空对象，表示「该 Provider 没有可执行端点」。
// paths 只保留当前 kind：运行时按 defaultKind 选 adapter，多余入口只会造成歧义。
// 默认路径由共享 helper 提供，保证与内置 Provider 的路径口径一致。
function normalizeEndpoints(
  endpoints: ModelProviderEndpoints,
  defaultKind: ModelProviderKind,
): ModelProviderEndpoints {
  // 先算出一条可用的 runtime 地址：它已按 defaultKind 做过协议相关的归一化。
  const runtimeBaseURL = resolveRuntimeBaseUrlForStore(endpoints, defaultKind);
  if (!runtimeBaseURL) {
    // 空串表示没有任何可用端点：返回 {} 而不是带空 baseURL 的对象，避免下游拼出相对路径。
    return {};
  }
  return {
    // 只保存当前 kind 的地址，旧的多协议入口在这一步被丢弃。
    baseURL: runtimeBaseURL,
    paths: {
      // 计算属性键用 defaultKind：运行时按它选 adapter，键与 defaultKind 必须一致。
      [defaultKind]: getDefaultModelProviderEndpointPathForKind(defaultKind),
    },
  };
}
