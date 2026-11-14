// INV-01：迁移只提取「用户输入」——自定义 Provider 的调用配置、成员顺序、contextWindow、启停；
// 旧 Store 里由 Built-in/Catalog/设置页默认值生成的事实一律丢弃。
// INV-02：迁移结果与当前 Built-in 无关，可离线幂等重放，不依赖远端 catalog 版本。
// INV-03：已发布 config.json 会把 builtin:* 标成 custom，身份判断必须先于 source 判断。
// INV-04：迁移不写文件，也不触发 Registry 刷新；落盘与广播由运行时在拿到结果后统一负责。
import { BUILTIN_PROVIDER_TEMPLATE_IDS } from "@zcode/shared";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import {
  isModelProviderModelConfig,
  normalizeModelProviderConfiguredBaseUrl,
  resolveModelProviderApiFormat,
  resolveModelProviderRuntimeBaseUrl,
  type ModelProviderConfig,
  type ModelProviderModelEntry,
} from "./legacyModelProviderSerialized.js";

// 入参只接受旧 Provider 列表：迁移不读文件、不读设置，纯函数便于单测与重放。
interface LegacyPersonalProviderConfigImportInput {
  readonly legacyProviders: readonly ModelProviderConfig[];
}

interface LegacyPersonalModelMember {
  readonly modelId: string;
  readonly contextWindow?: number;
}

/**
 * 从旧 Effective Store 中只提取仍能确认的 Personal 用户意图。
 *
 * 旧 Store 把 Built-in、Catalog enrichment、设置页默认值和用户输入写在同一
 * 个模型对象里。迁移整份对象或与当前 Built-in 求差异，都会把系统生成事实冻结成
 * Personal Overlay；因此这里只保留自定义 Provider 调用配置、成员顺序和 context。
 */
// 逐 Provider 累积规则表：providers 记录调用配置与顺序，models 记录显式设置的 contextWindow。
// 展示类字段（logo/apiKeyUrl 优先取模板）不进入 Personal Overlay，由当前版本的 Built-in 提供。
// 返回冻结对象：调用方拿到后直接交给运行时，不能再被就地修改。
export function importLegacyPersonalProviderConfig(
  input: LegacyPersonalProviderConfigImportInput,
): ProviderConfigLayerUpdate {
// ProviderConfigMap/ModelConfigRules 是规则容器：setRule 同一 providerId 只保留一条，
// 因此重复旧条目会互相覆盖，最后一条胜出。
  let providers = ProviderConfigMap.empty();
  let models = ModelConfigRules.empty();

// 逐条处理而不是先按 id 分组：旧文件顺序即用户可见顺序，避免引入额外排序语义。
  for (const legacy of input.legacyProviders) {
// 空 id 的旧记录无法对应任何 provider，直接跳过而不是造一个空键。
    const providerId = legacy.id.trim();
    if (!providerId) continue;
    // 已发布 config.json 也把 builtin:* 标成 custom；保留身份必须先于 source。
    // 只有按量 API 的 Key 是用户输入，模板关联使用当前身份；旧文件仅为回滚保留，不持续双写。
// builtin:bigmodel / builtin:zai 是唯一允许保留的旧内置项，因为旧文件把用户 API Key 存在同一层；
// 模板 ID 取当前常量而不是硬编码字符串，模板重命名时自动跟随。
    const apiTemplateId =
      providerId === "builtin:bigmodel"
        ? BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel
        : providerId === "builtin:zai"
          ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
          : undefined;
// 只有非空 apiKey 才算用户输入；空 Key 说明用户从未启用该按量 Provider，迁移后保持不存在。
// 这里刻意不带 enabled/systemDisabledReason：带上会复活已被产品下线的入口。
    if (apiTemplateId) {
      const apiKey = legacy.apiKey.trim();
      if (apiKey)
        providers = providers.setRule({
          providerId: apiTemplateId,
          templateId: apiTemplateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey }),
          }),
        });
      continue;
    }
// 其余 builtin:* 与 account:* 由当前 Built-in Config 与 Account Overlay 重建，
// 迁移进来会把旧版本的系统事实（模型列表、endpoint、禁用原因）冻结成用户配置。
    if (providerId.startsWith("builtin:") || providerId.startsWith("account:")) continue;
    // Built-in 整体由当前 ZCode Built-in Config 与 Account Overlay 重建；models-dev 已
    // 退役，workspace 也不是全局 Personal 输入。只允许旧自定义 Provider 进入新文件。
// models-dev 已退役、workspace 不是全局 Personal 输入；只允许 source=custom 或未标注的旧自定义项。
    if (legacy.source !== undefined && legacy.source !== "custom") continue;

// 成员表按出现顺序收集并按 id 去重：顺序即用户排序，重复条目只保留第一次。
    const members = collectLegacyPersonalModelMembers(legacy.models);
    const modelIds = members.map((member) => member.modelId);
    const providerName = legacy.name.trim();
    providers = providers.setRule({
      providerId,
      // 旧启停是用户意图；遗漏 false 会被统一默认值重新启用，必须保留在规则外层。
      ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
      ...(providerName && providerName !== providerId ? { providerName } : {}),
// config 携带 apiKey/apiFormat/baseUrl/headers：这些是用户实际输入，
// 不迁移会导致升级后请求 401 或打到错误端点。
      config: createPersonalProviderConfig(legacy, modelIds),
    });

// 只有显式 contextWindow 才写 ModelConfigRules：缺省值由 Registry 按模型解析，不能固化。
    for (const member of members) {
      if (member.contextWindow === undefined) continue;
      models = models.setExact(
        providerId,
        member.modelId,
        new ModelConfig({
          properties: new ModelPropertiesConfig({
            contextWindow: member.contextWindow,
          }),
        }),
      );
    }
  }

  return Object.freeze({ providers, models });
}

// 组装 Personal Provider 的调用配置；baseUrl 优先取运行态值，再退到规范化后的用户输入。
// modelOrder 与 personalModelIds 同源，保证旧顺序不会在升级后被打乱。
function createPersonalProviderConfig(
  legacy: ModelProviderConfig,
  modelIds: readonly string[],
): ProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({
      apiKey: legacy.apiKey.trim() || undefined,
      apiKeyManagementUrl: legacy.apiKeyUrl,
    }),
    api: new ProviderApiConfig({
      type: resolveModelProviderApiFormat(legacy),
      baseUrl:
        resolveModelProviderRuntimeBaseUrl(legacy) ||
        normalizeModelProviderConfiguredBaseUrl(legacy.endpoints.baseURL ?? ""),
      headers: legacy.headers,
    }),
    ...(modelIds.length > 0 ? { personalModelIds: modelIds, modelOrder: modelIds } : {}),
  });
}

// 收集成员时同时保留 contextWindow：旧 Store 的 context 是用户显式设置，丢了会让长上下文模型退化。
// tombstone（deleted=true）不进入成员表：迁移只承载「存在的模型」，删除语义留在旧文件里。
function collectLegacyPersonalModelMembers(
  entries: readonly ModelProviderModelEntry[],
): readonly LegacyPersonalModelMember[] {
  const seen = new Set<string>();
  const members: LegacyPersonalModelMember[] = [];

  for (const entry of entries) {
    const modelId = (typeof entry === "string" ? entry : entry.id).trim();
    if (!modelId || seen.has(modelId)) continue;
    if (isModelProviderModelConfig(entry) && entry.deleted === true) continue;
    seen.add(modelId);
    members.push({
      modelId,
      ...(isModelProviderModelConfig(entry) && isPositiveInteger(entry.contextWindow)
        ? { contextWindow: entry.contextWindow }
        : {}),
    });
  }

  return members;
}

// 只接受正整数：0、NaN、字符串形式的上下文长度都不写回，避免生成非法 ModelConfig。
function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}
