// INV-01 草稿不是事实：守住位置 全部函数；改错故障 前端另存一份可写 Effective Config。
// INV-02 推荐模式直接返回原草稿：守住位置 首个早退；改错故障 每次渲染都重建对象引发抖动。
// INV-03 默认值只由模型推导：守住位置 createProviderModelDraftValues；改错故障 默认值与 Host 规则分叉。
// INV-04 继承配置优先于本地配置：守住位置 inheritedConfig ?? config；改错故障 展示的默认值落后于 Host。
// INV-05 显式覆写集合是唯一豁免：守住位置 overriddenFieldsValue；改错故障 用户改动被默认值覆盖。
// INV-06 输入格式逐字段豁免：守住位置 inputFormatValue.字段名；改错故障 只改了一个子项却整组回填。
// INV-07 投影不修改入参：守住位置 展开复制；改错故障 父组件状态被隐式改写。
// INV-08 恢复是显式动作：守住位置 restoreModelDraft；改错故障 切换开关时静默丢掉编辑。
// INV-09 恢复清除手工配置：守住位置 clearManualModelConfig；改错故障 旧覆盖在下次保存时复活。
// INV-10 恢复保留标识与启用态：守住位置 idValue / enabledValue；改错故障 恢复后模型身份变化。
// INV-11 关闭推荐只补空字段：守住位置 三处 || 兜底；改错故障 用户输入被默认值吞掉。
// INV-12 覆写集合按补丁累加：守住位置 两个 explicit.add；改错故障 改过的字段仍被当作继承。
// INV-13 覆写集合只读返回：守住位置 ReadonlySet；改错故障 调用方就地修改影响后续判断。
// INV-14 关闭推荐时覆写集合为空：守住位置 modelDraftOverrides 早退；改错故障 保存时提交无意义覆盖。
//
// 模块职责：Provider 模型编辑草稿的投影、补丁与恢复，负责推荐配置与用户覆写的边界。
// 阅读顺序：先看字段清单与 projectModelDraft，再看 updateModelDraft，最后看 restore 与 overrides。
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import { clearManualModelConfig } from "@zcode/provider";
import {
  createProviderModelDraftValues,
  type ProviderModelDraftValues,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";

// 可被推荐配置接管的标量字段清单。
const CONFIG_VALUE_FIELDS = [
  "supportsJsonSchemaOutputValue",
  "supportsNativeWebSearchValue",
  "supportsMidConversationSystemValue",
  "reasoningLevelValuesValue",
] as const;

/** 只投影未覆盖控件；Host 是推荐规则的唯一解析者，草稿不保存第二份可写 Effective Config。 */
// 投影只回填未被显式覆写的字段。
export function projectModelDraft(
  draft: ProviderModelDraftValues,
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  // 关闭推荐时不投影，原样返回。
  if (draft.useRecommendedConfigValue === false) return draft;
  // 默认值用继承配置推导，与 Host 同源。
  const defaults = createProviderModelDraftValues({
    ...model,
    personalConfig: {},
    config: model.inheritedConfig ?? model.config,
  });
  // 用户显式改过的字段不参与回填。
  const explicit = new Set(draft.overriddenFieldsValue ?? []);
  const next = { ...draft, inputFormatValue: { ...draft.inputFormatValue } };
  for (const field of CONFIG_VALUE_FIELDS) {
    if (!explicit.has(field)) Object.assign(next, { [field]: defaults[field] });
  }
  for (const field of Object.keys(
    next.inputFormatValue,
  ) as (keyof typeof next.inputFormatValue)[]) {
    if (!explicit.has(`inputFormatValue.${field}`))
      next.inputFormatValue[field] = defaults.inputFormatValue[field];
  }
  return next;
}

// `updateModelDraft` 是补丁入口：推荐切换与记录覆写都在这一处分流。
export function updateModelDraft(
  draft: ProviderModelDraftValues,
  patch: Partial<ProviderModelDraftValues>,
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  if (
    patch.useRecommendedConfigValue !== undefined &&
    patch.useRecommendedConfigValue !== (draft.useRecommendedConfigValue !== false)
  ) {
    // 重新开启推荐等价于恢复：`restoreModelDraft` 直接给出默认投影。
    if (patch.useRecommendedConfigValue) {
      return restoreModelDraft(draft, model);
    }
    // 关闭推荐时先跑 `projectModelDraft` 保留当前投影结果。
    const projected = projectModelDraft(draft, model);
    const inherited = model.inheritedConfig ?? model.config;
    // 只补空的继承输入；错误的非空用户输入保留，让保存指出错误，不以切换模式吞掉编辑。
    return {
      ...projected,
      contextWindowValue:
        projected.contextWindowValue || String(inherited.properties?.contextWindow ?? ""),
      maxOutputTokensValue:
        projected.maxOutputTokensValue || String(inherited.optionSpecs?.maxOutputTokens?.max ?? ""),
      reasoningLevelMapValue:
        projected.reasoningLevelMapValue || inherited.optionSpecs?.reasoningLevel?.map || "",
      useRecommendedConfigValue: false,
    };
  }
  // 在已有覆写基础上更新集合。
  const explicit = new Set(draft.overriddenFieldsValue ?? []);
  for (const field of CONFIG_VALUE_FIELDS) if (field in patch) explicit.add(field);
  // 输入格式按子字段逐个比较。
  if (patch.inputFormatValue) {
    for (const field of Object.keys(
      patch.inputFormatValue,
    ) as (keyof typeof patch.inputFormatValue)[]) {
      if (patch.inputFormatValue[field] !== draft.inputFormatValue[field])
        explicit.add(`inputFormatValue.${field}`);
    }
  }
  return { ...draft, ...patch, overriddenFieldsValue: [...explicit] };
}

/** 恢复是显式草稿动作，即使原本已开启智能配置也要清除可编辑覆盖。 */
// 恢复会重建整份草稿。
export function restoreModelDraft(
  draft: ProviderModelDraftValues,
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  return {
    ...createProviderModelDraftValues({
      ...model,
      config: model.inheritedConfig ?? {},
      personalConfig: clearManualModelConfig(model.personalConfig),
      useRecommendedConfig: true,
    }),
    idValue: draft.idValue,
    enabledValue: draft.enabledValue,
    clearPersonalConfigValue: true,
  };
}

// 保存前把实际覆写汇总成只读集合。
export function modelDraftOverrides(draft: ProviderModelDraftValues): ReadonlySet<string> {
  if (draft.useRecommendedConfigValue === false) return new Set();
  const result = new Set(draft.overriddenFieldsValue ?? []);
  for (const field of [
    "contextWindowValue",
    "maxOutputTokensValue",
    "reasoningLevelMapValue",
  ] as const) {
    // 三个文本字段非空即视为覆写。
    if (draft[field].trim()) result.add(field);
    else result.delete(field);
  }
  return result;
}
