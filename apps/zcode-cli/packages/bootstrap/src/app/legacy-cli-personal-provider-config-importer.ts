// INV-01 只消费已校验投影：守住位置 专用解析器输出；改错故障 迁移逻辑读未类型化字段。
// INV-02 内置映射只保留密钥：守住位置 模板分支；改错故障 旧静态配置覆盖新模板。
// INV-03 账号来源一律不迁：守住位置 前缀跳过；改错故障 账号凭据被写进个人层。
// INV-04 非自定义来源不迁：守住位置 来源判断；改错故障 内置提供方被复制成自定义。
// INV-05 无法表达时整体失败：守住位置 无认证检查；改错故障 静默丢字段造成半份配置。
// INV-06 迁移全有或全无：守住位置 异常转空值；改错故障 半份写入阻止未来重迁。
// INV-07 文件缺失不是错误：守住位置 缺失判断；改错故障 首次启动被当成故障。
// INV-08 结构非法照常抛出：守住位置 其余错误分支；改错故障 配置损坏被静默吞掉。
// INV-09 默认只取主模型：守住位置 字段选择；改错故障 轻量模型变成用户默认。
// INV-10 已下线标识直接丢弃：守住位置 常量比较；改错故障 启动即选中不存在的提供方。
// INV-11 结果对象冻结：守住位置 冻结调用；改错故障 调用方就地改写污染缓存。
// INV-12 已删除模型不迁移：守住位置 删除标记；改错故障 幽灵模型出现在选择器。
// INV-13 标识重复只保留首个：守住位置 已见集合；改错故障 模型顺序列表出现重复。
// INV-14 缺标识时退回键名：守住位置 空值合并；改错故障 模型无标识无法被选择。
// INV-15 输出上限按固定优先级：守住位置 候选数组；改错故障 缺上下文时丢掉上限。
// INV-16 只保留正整数字段：守住位置 类型守卫；改错故障 零或小数进入正式配置。
// INV-17 头部合并忽略空值：守住位置 过滤后合并；改错故障 未定义覆盖已有头。
// INV-18 空头部不落配置：守住位置 长度判断；改错故障 出现空对象字段。
//
// 模块职责：把旧 CLI 用户配置中的显式提供方与默认模型迁移到个人层。
// 状态所有权：无状态；输入是整份旧文件，输出是冻结的配置层增量。
// 阅读顺序：先看迁移主循环，再看读取与默认选择，最后看成员收集与工具函数。
import { readFile } from "node:fs/promises";
import { BUILTIN_PROVIDER_TEMPLATE_IDS } from "@zcode/shared";
import { getDefaultConfigPath } from "@zcode/adapters/config";
import {
  parseLegacyCliModelConfig,
  type LegacyCliModelConfigProjection,
} from "./legacy-cli-model-config.js";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderApiType,
  type ProviderConfigLayerUpdate,
  type ModelSelection,
} from "@zcode/provider";

interface LegacyCliPersonalProviderConfigImportInput {
  readonly input: unknown;
}

const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

class UnsupportedLegacyCliProviderConfigError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`旧 CLI Provider ${providerId} 含有正式 Config 尚不能表达的执行字段`);
    this.name = "UnsupportedLegacyCliProviderConfigError";
    this.providerId = providerId;
  }
}

function resolveLegacyProviderApiType(
  kind: "anthropic" | "openai" | "openai-compatible" | undefined,
): ProviderApiType {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
    case undefined:
      return "openai-chat-completions";
  }
  return "openai-chat-completions";
}

/** 把旧 CLI 用户文件中的显式 Provider 定义迁移到新的 Personal Overlay。 */
// 只消费 parseLegacyCliModelConfig 的已校验投影，不再读原始结构。
// 内置映射只保留按量密钥 apiKey，账号型字段不进迁移结果。
// 账号（account）与 builtin 来源一律跳过。
// 旧格式无法表达无认证请求时整体失败，不做部分迁移。
// 返回值走 Object.freeze()，调用方就地改写会抛 TypeError。
export function importLegacyCliPersonalProviderConfig(
  input: LegacyCliPersonalProviderConfigImportInput,
): ProviderConfigLayerUpdate {
  const runtimePatch = parseLegacyCliModelConfig(input.input);
  // 通用 ZCodeConfigFileSchema 刻意把旧 provider 留在 passthrough unknown，
  // 迁移器却从该结果取类型，导致 Bootstrap build 无法证明 model/provider 结构。
  // 这里只消费专用旧格式 parser 的已校验投影，保持兼容逻辑封闭在读取边界。
  let providers = ProviderConfigMap.empty();
  let models = ModelConfigRules.empty();

  for (const [rawProviderId, provider] of Object.entries(runtimePatch.provider ?? {})) {
    const providerId = rawProviderId.trim();
    if (!providerId) continue;
    // Standalone 也会读取旧 Desktop 写出的 builtin:* / source=custom。
    // 与 Desktop 导入一致：旧内置静态配置和账号凭据不迁，按量 API 只留下 Key。
    const templateId =
      providerId === "builtin:bigmodel"
        ? BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel
        : providerId === "builtin:zai"
          ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
          : undefined;
    if (templateId) {
      const apiKey = provider.options?.apiKey?.trim();
      if (apiKey)
        providers = providers.setRule({
          providerId: templateId,
          templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey }),
          }),
        });
      continue;
    }
    if (providerId.startsWith("builtin:") || providerId.startsWith("account:")) continue;
    if (provider.source !== undefined && provider.source !== "custom") continue;
    if (requiresUnsupportedNoAuthentication(provider)) {
      throw new UnsupportedLegacyCliProviderConfigError(providerId);
    }
    const members = collectLegacyCliModelMembers(provider);
    const modelIds = members.map((member) => member.modelId);
    const providerName = provider.name?.trim();
    providers = providers.setRule({
      providerId,
      providerName: providerName && providerName !== providerId ? providerName : undefined,
      config: new ProviderConfig({
        group: "standard-personal",
        access: new ApiKeyAccessConfig({
          apiKey: provider.options?.apiKey,
        }),
        api: new ProviderApiConfig({
          type: resolveLegacyProviderApiType(provider.kind),
          baseUrl: provider.options?.baseURL,
          headers: mergeHeaders(provider.headers, provider.options?.headers),
        }),
        ...(modelIds.length > 0 ? { personalModelIds: modelIds, modelOrder: modelIds } : {}),
      }),
    });
    for (const member of members) {
      if (member.contextWindow === undefined && member.maxOutputTokens === undefined) continue;
      models = models.setExact(
        providerId,
        member.modelId,
        new ModelConfig({
          ...(member.contextWindow !== undefined
            ? { properties: new ModelPropertiesConfig({ contextWindow: member.contextWindow }) }
            : {}),
          ...(member.maxOutputTokens !== undefined
            ? {
                optionSpecs: new ModelOptionSpecsConfig({
                  maxOutputTokens: { max: member.maxOutputTokens },
                }),
              }
            : {}),
        }),
      );
    }
  }

  // 默认选择与 Provider 由同一次旧文件读取生成，只在 Personal 文件首次创建时导入。
  // 后续清空默认不能再次读取旧 main，也不能先创建半份配置阻止剩余字段迁移。
  const defaultModelSelection = importLegacyCliConfiguredDefault(input.input) ?? undefined;
  return Object.freeze({ providers, models, defaultModelSelection });
}

/**
 * 从用户级旧 CLI 配置文件读一次并迁移；文件不存在回 `null`（不是错误，首次安装的常态）。
 *
 * 失败语义：结构非法（JSON / zod）会抛给调用方；`UnsupportedLegacyCliProviderConfigError` 回
 * `null`——正式 Config 还表达不了旧执行字段时保留旧链路，避免写半份 Personal 文件后阻止未来重迁
 * （迁移是全有或全无）。`readFile` 的其他 IO 错误照常抛出，不在这里吞掉。
 */
export async function readLegacyCliPersonalProviderConfig(input: {
  readonly filePath?: string;
}): Promise<ProviderConfigLayerUpdate | null> {
  const filePath = input.filePath ?? getDefaultConfigPath();
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return importLegacyCliPersonalProviderConfig({ input: raw });
  } catch (error) {
    if (isFileNotFound(error)) return null;
    // 迁移必须是全有或全无。正式 Config 尚不能表达旧执行字段时保留旧链路，
    // 不写一个部分 Personal 文件阻止未来版本重新迁移。
    if (error instanceof UnsupportedLegacyCliProviderConfigError) return null;
    throw error;
  }
}

/** 旧 CLI 用户文件中的 main model 只迁移为 Environment 默认选择。 */
/**
 * 输入是整份旧文件；输出冻结的 `{providerId, modelId}` 或 `null`（没写 main / 未通过旧格式
 * 校验 / 指向已下线的 `builtin:zapi`）。只读 main：lite 不是用户可见的默认，`small_model`
 * 属于旧内部字段。调用方用它初始化 Environment 默认，而不是 Personal 层的“保存意图”。
 */
// 只读 parsed.model.main，lite 与 small_model 都不看。
// provider 等于 RETIRED_ZAPI_PROVIDER_ID 时返回 null。
// main 缺失就返回 null，不猜默认模型。
// 返回 Object.freeze({ providerId, modelId })，与入参解耦。
// 是否首次导入由 importLegacyCliConfiguredDefault 的调用方判断。
export function importLegacyCliConfiguredDefault(input: unknown): ModelSelection | null {
  const main = parseLegacyCliModelConfig(input).model?.main;
  if (!main || main.provider === RETIRED_ZAPI_PROVIDER_ID) return null;
  return Object.freeze({
    providerId: main.provider,
    modelId: main.model,
  });
}

type LegacyCliProvider = NonNullable<LegacyCliModelConfigProjection["provider"]>[string];

interface LegacyCliModelMember {
  readonly modelId: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

// 已删除（deleted）的模型不进 members 列表。
// modelId 缺失时回落到对象键名，保证每条都有标识。
// 重复 modelId 只保留首个，后者丢弃。
// 输出上限 maxOutputTokens 按固定优先级取值。
function collectLegacyCliModelMembers(
  provider: LegacyCliProvider,
): readonly LegacyCliModelMember[] {
  const seen = new Set<string>();
  const members: LegacyCliModelMember[] = [];
  for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
    if (model.deleted === true) continue;
    const modelId = (model.id ?? modelKey).trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const contextWindow = model.contextWindow ?? model.limit?.context;
    // 评测仍使用旧 CLI 文件显式设定预算；仅在首次导入保留数值，map 由正式规则继承。
    // 沿用 limit > options > 顶层优先级，不能因缺少 context 而丢掉独立输出上限。
    const maxOutputTokens = [
      model.limit?.output,
      model.options?.max_tokens,
      model.maxOutputTokens,
    ].find(isPositiveInteger);
    members.push({
      modelId,
      ...(isPositiveInteger(contextWindow) ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
  }
  return members;
}

function mergeHeaders(
  ...values: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const result = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(result).length > 0 ? result : undefined;
}

function requiresUnsupportedNoAuthentication(provider: LegacyCliProvider): boolean {
  return provider.options?.apiKeyRequired === false;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}
