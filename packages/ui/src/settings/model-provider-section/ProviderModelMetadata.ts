/* oxlint-disable eslint(max-lines) -- Model Config 弹窗的 Draft、校验与稀疏 Overlay 必须共享同一字段映射，避免 UI 产生第二套规则。 */
// ProviderModelMetadata —— 模型元数据在「推荐基线 → 有效配置 → 稀疏 Overlay → Draft」之间的唯一字段映射层。
// 职责：createProviderModelDraftValues 把 ProviderSettingsFormModel 投影成编辑器初值；resolveProviderModelDraftCommit 把 Draft 归一为
// 「有效 config + 最小 personalConfig」两套结果。纯函数，无 IO、无状态、无缓存，也不渲染任何 UI。
// 边界：不判断模型是否存在、不触发 Provider 目录刷新、不落库；未知模型只走缺省值与兜底分支，不在本文件抛错。
//
// INV 表（每条都锚定本文件的真实行，改动前先看「守住它的位置」）：
// INV-01 断言：Draft 的数值输入只承载 Personal Overlay，继承值仅作 placeholder —— 守住它的位置：createProviderModelDraftValues 的 contextWindowValue 与 maxOutputTokensValue —— 改错故障：未编辑的继承值被当成显式覆盖写回 Overlay。
// INV-02 断言：inputFormat 缺省为「仅文本」，即 supportsText 为 true、image/video/audio/pdf 为 false —— 守住它的位置：createProviderModelDraftValues 的 inputFormatValue 字面量 —— 改错故障：属性缺失的旧模型被判为不支持文本，提交时直接命中 invalid。
// INV-03 断言：overriddenFieldsValue 只记录 personalConfig 中非 null 的叶子 —— 守住它的位置：personalDraftFieldKeys —— 改错故障：覆盖标记与真实 Overlay 脱钩，提交时凭空写回用户没碰过的能力位。
// INV-04 断言：clearPersonalConfigValue 仅在存在 inheritedConfig 时重置比较基线 —— 守住它的位置：resolveProviderModelDraftCommit 的首个分支 —— 改错故障：无推荐基线的模型被清空后失去全部可回落值，或重置吞掉重置后的新编辑。
// INV-05 断言：modelId 去空白后为空即 invalid/id，归一只有 trim 一步 —— 守住它的位置：modelId 与首个 invalid 返回 —— 改错故障：空 ID 落进配置，模型列表出现无法定位的条目。
// INV-06 断言：contextWindow 优先取 Draft 输入，空输入回落 inherited，两者皆空即 invalid —— 守住它的位置：contextWindow 三元表达式与 null 判断 —— 改错故障：推荐模式丢上限，或固定模式留空通过校验。
// INV-07 断言：maxOutputTokens 空输入表示不覆盖，但固定模式必须显式填写 —— 守住它的位置：maxOutputTokens 的 undefined 分支 —— 改错故障：固定模式保存出没有输出上限的模型。
// INV-08 断言：推理档位先 trim、再判空、再判重 —— 守住它的位置：reasoningLevelValues 的 map 与 Set.size 比较 —— 改错故障：重复档位进入映射校验，报出与 UI 不对应的错误字段。
// INV-09 断言：推理映射为空时回落 inherited 的 map，再由 EnumOptionSpecConfig 完整校验 —— 守住它的位置：effectiveReasoningMap 与 validateComplete 调用 —— 改错故障：空映射被当作合法配置，或跳过校验写入半截映射。
// INV-10 断言：requiresMfjsToolSchema、outputFormat、supportsToolCall 只从现有 config 透传 —— 守住它的位置：effectiveProperties 的前三个字段 —— 改错故障：系统字段被编辑器默认值覆盖，工具调用能力静默丢失。
// INV-11 断言：Draft 的 supportsText 不参与有效 inputFormat 合并 —— 守住它的位置：effectiveProperties.inputFormat 只展开 image/video/pdf —— 改错故障：文本能力被草稿层改写，与 supportsText 校验分支自相矛盾。
// INV-12 断言：personalProperties 中与 inherited 相等的叶子一律删除 —— 守住它的位置：applySparseLeaf 的相等删除分支 —— 改错故障：Overlay 膨胀成完整副本，推荐配置升级无法透传。
// INV-13 断言：布尔三态「未触碰」必须保留原稀疏值，不能因有效值默认而写入 false —— 守住它的位置：resolvePersonalBoolean 的 value === currentEffective 分支 —— 改错故障：用户没动过开关却产生覆盖，重置推荐后仍被旧 false 拦住。
// INV-14 断言：跟随推荐模式不物化编辑器托管字段，只有固定模式走 extractManualModelConfig —— 守住它的位置：personalConfig 的 useRecommendedConfig 三元 —— 改错故障：切换模式时把整套有效配置冻结进 Overlay，重置失效。
//
// 合并优先级（自上而下，命中即停）：Draft 显式输入 → 当前有效 config → inherited 推荐基线 → 类型缺省（文本 true、其余 false）。
// 空输入不是值：数值清空表示撤销覆盖，布尔 undefined 表示未触碰，空数组与空映射按 invalid 处理。
// 展示归一：Draft 一律存字符串（数值与映射），提交时才解析；UI 不参与任何合并规则。
// 稀疏读写统一走 assignMutable/deleteMutable，避免动态键在 TS 索引签名上失配。
// 本文件与 providerSettingsFormTypes、@zcode/provider 的 extractManualModelConfig 共用同一字段映射，禁止另起一套规则。
// 阅读顺序：Draft 生成 → commit 校验 → personal 稀疏合并 → optionSpecs 归一 → 布尔三态辅助。
// 新增能力位的四处同步点：DraftValues 字段、overriddenFieldsValue 键名、effectiveProperties 透传、buildPersonalProperties 稀疏分支。
// 提交结果是纯数据：持久化与刷新由调用方负责，本文件不缓存上一次结果。
// `ProviderModelMetadata` 的导出面只有两个函数与两个类型，其余均为内部实现。
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import type { ModelInputFormatData } from "@zcode/shared/model-config";
import {
  EnumOptionSpecConfig,
  extractManualModelConfig,
  clearManualModelConfig,
  type ModelConfigObject,
} from "@zcode/provider";

// [契约] 别名而非新结构：Draft 的输入格式与 @zcode/shared 的 ModelInputFormatData 必须同构。
// 多一层镜像类型会让 UI 与提交解析的字段名分叉，新增能力位应先改共享类型。
// 此处不做字段裁剪，裁剪只发生在 createProviderModelDraftValues 的显式字面量里。
export type ProviderModelInputFormatDraft = ModelInputFormatData;

export interface ProviderModelDraftValues {
  idValue: string;
  contextWindowValue: string;
  maxOutputTokensValue: string;
  inputFormatValue: ProviderModelInputFormatDraft;
  enabledValue?: boolean;
  useRecommendedConfigValue?: boolean;
  /** 仅在本次 Draft 从固定模式切回推荐模式时清空已有 Overlay。 */
  clearPersonalConfigValue?: boolean;
  /** 字段来源是用户意图，不依赖整份表单是否有效或数值是否恰好等于推荐。 */
  overriddenFieldsValue?: readonly string[];
  supportsJsonSchemaOutputValue?: boolean;
  supportsNativeWebSearchValue?: boolean;
  supportsMidConversationSystemValue?: boolean;
  reasoningLevelValuesValue: readonly string[];
  reasoningLevelMapValue: string;
}

// [契约] 提交结果只有两种：commit 携带完整模型，invalid 只带字段名。
// field 枚举与 UI 报错位置一一对应，不允许返回通用错误字符串。
// 新增校验分支必须同步扩展该联合类型，否则调用方无法定位到具体输入框。
export type ProviderModelDraftCommitResult =
  | { status: "commit"; model: ProviderSettingsFormModel }
  | {
      status: "invalid";
      field:
        | "id"
        | "contextWindow"
        | "maxOutputTokens"
        | "inputFormat"
        | "reasoningLevelValues"
        | "reasoningLevelMap";
    };

// [契约] 纯投影：同一个 Model 必得同一个 Draft，不读全局状态、不写 personalConfig。
// 数据来源有意分裂：数值与覆盖标记取 personalConfig，能力开关与档位取 config。
// 调用方只应把它当作「打开编辑器的初值」，编辑过程状态由 Draft 自身承载。
// 任何在此处加校验的改动，都会把「修复入口」变成「拦截入口」。
export function createProviderModelDraftValues(
  model: ProviderSettingsFormModel,
): ProviderModelDraftValues {
  // 配置不完整时编辑器就是修复入口，不能在打开前抛错；数值保留空输入，能力控件用保守初值。
  // [资源] properties 可能整体缺省，空对象兜底让后续可选链不必层层判空。
  // [失败路径] 配置不完整时编辑器仍须可打开，这里不抛错、不回退到 inherited 以外的来源。
  // inputFormat 取自有效 config 而非 personalConfig：展示的是能力现状，不是覆盖差异。
  const properties = model.config.properties ?? {};
  const inputFormat = properties?.inputFormat;
  return {
    idValue: model.modelId,
    // 编辑器只把 Personal Overlay 当作真实输入；继承值由 UI 作为 placeholder 展示。
    // [契约] 只有 Personal Overlay 的 contextWindow 进入输入框，继承值不复制、由 UI 作 placeholder。
    // == null 同时覆盖 undefined 与 null，避免把历史脏数据当 0 回填。
    contextWindowValue:
      model.personalConfig.properties?.contextWindow == null
        ? ""
        : String(model.personalConfig.properties.contextWindow),
    maxOutputTokensValue:
      model.personalConfig.optionSpecs?.maxOutputTokens?.max == null
        ? ""
        : String(model.personalConfig.optionSpecs.maxOutputTokens.max),
    inputFormatValue: {
      // [契约] 未知模型兜底：没有任何 inputFormat 属性时按「仅文本」处理，这是最保守的可提交组合。
      // [权衡] 不用 false 兜底：文本是提交校验强制要求的能力，缺省 false 会让所有旧模型无法保存。
      // image/video/audio/pdf 相反，缺省 false，避免凭空声明未经验证的能力。
      supportsText: inputFormat?.supportsText ?? true,
      supportsImage: inputFormat?.supportsImage ?? false,
      supportsVideo: inputFormat?.supportsVideo ?? false,
      supportsAudio: inputFormat?.supportsAudio ?? false,
      supportsPdf: inputFormat?.supportsPdf ?? false,
    },
    enabledValue: model.config.enabled !== false,
    useRecommendedConfigValue: model.useRecommendedConfig !== false,
    clearPersonalConfigValue: false,
    // [契约] 覆盖标记来自真实 Overlay，而不是「Draft 值是否等于推荐值」的猜测。
    // [权衡] 相等即覆盖的推断在大小写与数值格式差异下会误判，因此以键是否存在为准。
    // 该数组是提交时决定是否写回布尔与档位的唯一依据。
    overriddenFieldsValue: personalDraftFieldKeys(model.personalConfig),
    supportsJsonSchemaOutputValue: properties.supportsJsonSchemaOutput ?? false,
    supportsNativeWebSearchValue: properties.supportsNativeWebSearch ?? false,
    supportsMidConversationSystemValue: properties.supportsMidConversationSystem ?? false,
    reasoningLevelValuesValue: [...(model.config.optionSpecs?.reasoningLevel?.values ?? [])],
    reasoningLevelMapValue:
      typeof model.personalConfig.optionSpecs?.reasoningLevel?.map === "string"
        ? model.personalConfig.optionSpecs.reasoningLevel.map
        : "",
  };
}

// [契约] 键名约定：布尔能力加 Value 后缀，输入格式用 inputFormatValue.<子键>，档位用 reasoningLevelValuesValue。
// 只收集非 null 叶子，故显式 false 算覆盖、缺键不算，与 Overlay 的稀疏语义一致。
// [权衡] 字符串拼键而非集中常量，是为了让 Draft 字段名与标记名在同一处可读；改动须两处同步。
// 不比较值是否等于 inherited：显式写入的相等值仍应保留为覆盖。
function personalDraftFieldKeys(config: ModelConfigObject): string[] {
  const result: string[] = [];
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    if (config.properties?.[key] != null) result.push(`${key}Value`);
  }
  if (config.optionSpecs?.reasoningLevel?.values != null) result.push("reasoningLevelValuesValue");
  for (const [key, value] of Object.entries(config.properties?.inputFormat ?? {})) {
    if (value != null) result.push(`inputFormatValue.${key}`);
  }
  return result;
}

// [契约] 数值输入的唯一解析口：只接受十进制整数且严格大于 0。
// [失败路径] 空串返回 null 表示未填写，非法值同样返回 null，由调用方按语境区分「回落」与「报错」。
// [权衡] 不用 parseInt：它会接受 12abc；Number 配 Number.isInteger 才能拒绝尾随字符与小数。
function parsePositiveIntegerDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// [事务] Draft 到 Model 的唯一写入口：先归一有效配置，再反推最小 Overlay，两步共用同一份中间值。
// [契约] currentModel 只读；重置分支用局部重绑定产生新对象，不修改调用方引用。
// [失败路径] 任一字段不合法即提前返回 invalid，绝不产出「部分提交」的模型。
// 校验顺序固定为 id → contextWindow → maxOutputTokens → inputFormat → 档位 → 映射，UI 的报错定位依赖该顺序。
export function resolveProviderModelDraftCommit({
  currentModel,
  draft,
}: {
  currentModel: ProviderSettingsFormModel;
  draft: ProviderModelDraftValues;
}): ProviderModelDraftCommitResult {
  // [事务] 切回推荐模式的重置发生在校验之前，让后续归一基于干净基线。
  // [契约] 只有存在 inheritedConfig 才重置：无推荐基线的模型清空后没有可回落值。
  // [失败路径] 重置只改比较基线、不清最终 personalConfig，否则重置后的新编辑会被一并吞掉。
  if (draft.clearPersonalConfigValue && currentModel.inheritedConfig) {
    // 切回推荐只重置比较基线，不能在最终提交时无条件清空，否则会吞掉重置后的新编辑。
    currentModel = {
      ...currentModel,
      personalConfig: clearManualModelConfig(currentModel.personalConfig),
      config: { ...currentModel.inheritedConfig, enabled: currentModel.config.enabled },
    };
  }
  const modelId = draft.idValue.trim();
  if (!modelId) {
    return { status: "invalid", field: "id" };
  }

  // [契约] undefined 视为「跟随推荐」，与表单缺省一致；只有显式 false 才进入固定模式。
  // [并发] inherited 只在该模式下可见，固定模式看不到推荐值，避免两条来源同时写有效配置。
  // [失败路径] 调用方漏传该字段时退化为跟随推荐而非报错，这是有意的兼容取向。
  const useRecommendedConfig = draft.useRecommendedConfigValue !== false;
  const inherited = useRecommendedConfig ? currentModel.inheritedConfig : undefined;
  // [契约] 三态归一：有输入则解析，空输入在推荐模式下回落 inherited，两者都空才是错误。
  // [失败路径] 固定模式留空必然得到 null，随后命中 invalid/contextWindow。
  // [权衡] 回落放在归一阶段而非展示阶段，保证 Draft 永远是用户真实输入。
  const contextWindow = draft.contextWindowValue.trim()
    ? parsePositiveIntegerDraft(draft.contextWindowValue)
    : (inherited?.properties?.contextWindow ?? null);
  // [失败路径] 未知模型且无推荐基线的典型入口：此处拒绝，而不是写入 0 或猜测值。
  // [契约] contextWindow 是必填项，下游请求预算依赖它，缺省可能造成超额计费。
  if (contextWindow === null) {
    return { status: "invalid", field: "contextWindow" };
  }

  // [契约] 与 contextWindow 不同，空输入得到 undefined（表示不覆盖），合法性由配置模式决定。
  // [失败路径] 固定模式下 undefined 直接 invalid：固定配置必须自带输出上限。
  // [权衡] 此处不回落到 inherited，固定模式的语义就是不引用推荐值。
  const maxOutputTokens = draft.maxOutputTokensValue.trim()
    ? parsePositiveIntegerDraft(draft.maxOutputTokensValue)
    : undefined;
  if (maxOutputTokens === null || (!useRecommendedConfig && maxOutputTokens === undefined)) {
    return { status: "invalid", field: "maxOutputTokens" };
  }

  // [契约] 文本能力是硬约束：纯多模态配置在 UI 无处校验，只能在此拒绝。
  // [失败路径] 只报告 inputFormat，不细分到 supportsText，保持报错位置稳定。
  if (!draft.inputFormatValue.supportsText) {
    return { status: "invalid", field: "inputFormat" };
  }

  // [契约] 档位先逐个 trim，再按「非空 + 无重复」校验，两个步骤顺序不可交换。
  // [失败路径] 空数组、含空白项、含重复项共用同一个 invalid/reasoningLevelValues，避免 UI 分支爆炸。
  // [契约] 保序：数组顺序即展示顺序，判重靠 Set.size 而非排序后比较。
  const reasoningLevelValues = draft.reasoningLevelValuesValue.map((value) => value.trim());
  if (
    reasoningLevelValues.length === 0 ||
    reasoningLevelValues.some((value) => !value) ||
    new Set(reasoningLevelValues).size !== reasoningLevelValues.length
  ) {
    return { status: "invalid", field: "reasoningLevelValues" };
  }
  const inheritedReasoning = inherited?.optionSpecs?.reasoningLevel;
  const reasoningLevelMap = draft.reasoningLevelMapValue.trim();
  // [契约] 映射回落在推荐基线上进行，使「只覆盖档位、不改映射」成为常见路径。
  // [失败路径] 两者都空则得到 undefined，紧接着的校验返回 invalid/reasoningLevelMap。
  // [事务] validateComplete 的结论只用于放行或拒绝，不在此修补映射内容。
  const effectiveReasoningMap = reasoningLevelMap || inheritedReasoning?.map;
  if (
    !effectiveReasoningMap ||
    new EnumOptionSpecConfig({
      values: reasoningLevelValues,
      map: effectiveReasoningMap,
    }).validateComplete(["optionSpecs", "reasoningLevel"]).length > 0
  ) {
    return { status: "invalid", field: "reasoningLevelMap" };
  }
  const effectiveEnabled = draft.enabledValue ?? currentModel.config.enabled ?? true;
  const currentEffectiveEnabled = currentModel.config.enabled ?? true;
  // [契约] 有效配置 = 系统字段透传 + 编辑器可编辑字段归一，两类字段在这一层合流。
  // 系统字段 requiresMfjsToolSchema、outputFormat、supportsToolCall 原样搬运，草稿无权产生它们的值。
  // [资源] 展开现有 inputFormat 后再覆盖三个能力位，保留 supportsText、supportsAudio 等未在 UI 暴露的位。
  const effectiveProperties = {
    // 系统字段不由编辑草稿产生；手动保存统一按可编辑 schema 提取。
    requiresMfjsToolSchema: currentModel.config.properties?.requiresMfjsToolSchema,
    contextWindow,
    inputFormat: {
      ...currentModel.config.properties?.inputFormat,
      supportsImage: draft.inputFormatValue.supportsImage,
      supportsVideo: draft.inputFormatValue.supportsVideo,
      supportsPdf: draft.inputFormatValue.supportsPdf,
    },
    outputFormat: currentModel.config.properties?.outputFormat,
    supportsToolCall: currentModel.config.properties?.supportsToolCall,
    supportsJsonSchemaOutput:
      draft.supportsJsonSchemaOutputValue ??
      currentModel.config.properties?.supportsJsonSchemaOutput ??
      false,
    supportsNativeWebSearch:
      draft.supportsNativeWebSearchValue ??
      currentModel.config.properties?.supportsNativeWebSearch ??
      false,
    supportsMidConversationSystem:
      draft.supportsMidConversationSystemValue ??
      currentModel.config.properties?.supportsMidConversationSystem ??
      false,
  };
  // [契约] 反推 Overlay 只看交互叶子；与 inherited 相等的值删除，Overlay 保持稀疏。
  // 传入 current/inherited/currentEffective/effective 四份快照，避免函数内部回读可能已重绑定的模型。
  // [事务] 结果随后还会被布尔覆盖与输入格式差异二次补充，顺序不可颠倒。
  const personalProperties = buildPersonalProperties({
    current: currentModel.personalConfig.properties,
    inherited: inherited?.properties,
    currentEffective: currentModel.config.properties,
    effective: effectiveProperties,
  });
  // 数值显式填写即是覆盖；即使与推荐相等也保留，清空输入才表示撤销覆盖。
  // [契约] 显式输入即覆盖，即使数值恰好等于推荐也保留；只有清空输入才表示撤销。
  // [权衡] 用「输入是否非空」判断，而不是与 inherited 比较，避免推荐值变更后覆盖意外消失。
  // [失败路径] 空输入走 deleteMutable，恢复为继承而不是写入 null。
  if (draft.contextWindowValue.trim())
    assignMutable(personalProperties, "contextWindow", contextWindow);
  else deleteMutable(personalProperties, "contextWindow");
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    if (draft.overriddenFieldsValue?.includes(`${key}Value`))
      assignMutable(personalProperties, key, effectiveProperties[key]);
  }
  for (const key of ["supportsImage", "supportsVideo", "supportsPdf"] as const) {
    if (
      draft.overriddenFieldsValue?.includes(`inputFormatValue.${key}`) ||
      draft.inputFormatValue[key] !== currentModel.config.properties?.inputFormat?.[key]
    ) {
      assignMutable(personalProperties, "inputFormat", {
        ...personalProperties.inputFormat,
        [key]: draft.inputFormatValue[key],
      });
    }
  }
  // [契约] Overlay 以现有 personalConfig 为底，只在有差异时增删键，绝不整体重建。
  // properties 与 optionSpecs 都采用「空则删键」，保证顶层键数量能代表是否存在覆盖。
  // [资源] 展开而非就地修改，避免污染调用方持有的模型对象。
  const sparsePersonalConfig: ModelConfigObject = {
    ...currentModel.personalConfig,
    ...resolvePersonalBoolean(
      "enabled",
      effectiveEnabled,
      currentEffectiveEnabled,
      inherited?.enabled,
      currentModel.personalConfig.enabled,
    ),
    ...(Object.keys(personalProperties).length > 0 ? { properties: personalProperties } : {}),
  };
  if (Object.keys(personalProperties).length === 0)
    deleteMutable(sparsePersonalConfig, "properties");

  const inheritedMaxOption = inherited?.optionSpecs?.maxOutputTokens;
  // Option Spec 不再拥有 default；该输入框唯一表达模型硬上限 max。
  const currentEffectiveMaxOption = {
    ...currentModel.config.optionSpecs?.maxOutputTokens,
  };
  // [契约] undefined 表示不覆盖，此时有效配置回落到 inherited 或直接删键。
  // [权衡] Option Spec 不设 default：输入框唯一表达的是模型硬上限 max。
  // [失败路径] 数值已在校验段通过，此处不再判空，避免双重校验得出相反结论。
  const resolvedMaxOutputSpec =
    maxOutputTokens === undefined
      ? undefined
      : {
          ...currentEffectiveMaxOption,
          max: maxOutputTokens,
        };
  const personalOptionSpecs = { ...currentModel.personalConfig.optionSpecs };
  applyPersonalReasoning({
    target: personalOptionSpecs,
    values: reasoningLevelValues,
    map: reasoningLevelMap,
    currentEffective: currentModel.config.optionSpecs?.reasoningLevel?.values ?? undefined,
    inherited: inheritedReasoning,
    currentPersonal: currentModel.personalConfig.optionSpecs?.reasoningLevel,
  });
  if (draft.overriddenFieldsValue?.includes("reasoningLevelValuesValue")) {
    personalOptionSpecs.reasoningLevel = {
      ...personalOptionSpecs.reasoningLevel,
      values: [...reasoningLevelValues],
    };
  }
  if (reasoningLevelMap)
    personalOptionSpecs.reasoningLevel = {
      ...personalOptionSpecs.reasoningLevel,
      map: reasoningLevelMap,
    };
  if (resolvedMaxOutputSpec !== undefined) {
    const currentPersonalMax = currentModel.personalConfig.optionSpecs?.maxOutputTokens;
    personalOptionSpecs.maxOutputTokens = {
      ...(currentPersonalMax?.map === undefined ? {} : { map: currentPersonalMax.map }),
      max: resolvedMaxOutputSpec.max,
    };
  } else {
    const currentPersonalMap = currentModel.personalConfig.optionSpecs?.maxOutputTokens?.map;
    if (currentPersonalMap === undefined) deleteMutable(personalOptionSpecs, "maxOutputTokens");
    else personalOptionSpecs.maxOutputTokens = { map: currentPersonalMap };
  }
  if (Object.keys(personalOptionSpecs).length > 0) {
    assignMutable(sparsePersonalConfig, "optionSpecs", personalOptionSpecs);
  } else {
    deleteMutable(sparsePersonalConfig, "optionSpecs");
  }
  // [契约] 有效档位总是写入完整 values 与已解析 map，即使全部来自推荐值。
  // max 三级回落：Draft 解析值 → inherited max → 删除键，与 properties 的 contextWindow 口径一致。
  // [事务] 该对象最终整体替换 config.optionSpecs，不做增量合并。
  const effectiveOptionSpecs = { ...currentModel.config.optionSpecs };
  effectiveOptionSpecs.reasoningLevel = {
    values: [...reasoningLevelValues],
    map: effectiveReasoningMap,
  };
  if (resolvedMaxOutputSpec !== undefined) {
    effectiveOptionSpecs.maxOutputTokens = resolvedMaxOutputSpec;
  } else if (inheritedMaxOption !== undefined) {
    effectiveOptionSpecs.maxOutputTokens = inheritedMaxOption;
  } else {
    deleteMutable(effectiveOptionSpecs, "maxOutputTokens");
  }
  // [权衡] 跟随推荐模式直接提交稀疏 Overlay；固定模式才把编辑器托管字段物化。
  // [契约] 两条路径都以 sparsePersonalConfig 为输入，区别仅在是否用有效配置补齐可编辑叶子。
  // [失败路径] 物化只提取可编辑叶子，隐藏的请求映射不会被旧草稿冻结。
  const personalConfig = useRecommendedConfig
    ? sparsePersonalConfig
    : materializeEditorManagedPersonalConfig({
        current: sparsePersonalConfig,
        effective: {
          ...currentModel.config,
          enabled: effectiveEnabled,
          properties: effectiveProperties,
          optionSpecs: effectiveOptionSpecs,
        },
      });
  return {
    status: "commit",
    model: {
      ...currentModel,
      modelId,
      useRecommendedConfig,
      hasPersonalConfig: Object.keys(personalConfig).length > 0,
      personalConfig,
      config: {
        ...currentModel.config,
        enabled: effectiveEnabled,
        properties: effectiveProperties,
        optionSpecs: effectiveOptionSpecs,
      },
    },
  };
}

function preserveEnabledPersonalConfig(config: ModelConfigObject): ModelConfigObject {
  return config.enabled === undefined ? {} : { enabled: config.enabled };
}

function materializeEditorManagedPersonalConfig({
  current,
  effective,
}: {
  current: ModelConfigObject;
  effective: ModelConfigObject;
}): ModelConfigObject {
  // enabled 由模型列表行单独管理，不随“跟随推荐配置”模式物化或清除。
  // 只提取可编辑叶子；隐藏请求映射必须来自当前身份规则，不能由旧模型草稿冻结。
  return extractManualModelConfig({
    ...preserveEnabledPersonalConfig(current),
    properties: effective.properties,
    optionSpecs: effective.optionSpecs,
  });
}

// [契约] 布尔三态收敛：未触碰保留原稀疏值；触碰且等于 inherited 不写；触碰且不同才写覆盖。
// 未触碰的判定是「新值等于当前有效值」，因为 Draft 初值正取自有效配置。
// [权衡] 等于 inherited 即不写，是为了让推荐配置升级能透传到用户。
// [失败路径] currentPersonal 为 undefined 或 null 时返回空对象，避免产生带 undefined 值的 enabled 键。
function resolvePersonalBoolean<K extends string>(
  key: K,
  value: boolean,
  currentEffective: boolean,
  inherited: unknown,
  currentPersonal: boolean | null | undefined,
) {
  // 未触碰的控件必须保留现有的稀疏 Overlay，不能因为 Effective 默认值而凭空写入 false。
  if (value === currentEffective) {
    return currentPersonal === undefined || currentPersonal === null
      ? {}
      : ({ [key]: currentPersonal } as Record<K, boolean>);
  }
  return inherited === value ? {} : ({ [key]: value } as Record<K, boolean>);
}

// [契约] 从当前 Overlay 的浅拷贝出发，逐叶判断是否与 inherited 相等，相等即删除。
// contextWindow 走 applySparseLeaf（无交互基线），三个布尔与 image/video 走 applyInteractiveSparseLeaf。
// [契约] supportsPdf 不在此处理：它由提交段的覆盖标记循环单独补写，避免两处规则冲突。
// [失败路径] 结果为空时删除 inputFormat 键，防止留下空对象让下游误判存在覆盖。
function buildPersonalProperties({
  current,
  inherited,
  currentEffective,
  effective,
}: {
  current: ModelConfigObject["properties"];
  inherited: ModelConfigObject["properties"];
  currentEffective: ModelConfigObject["properties"];
  effective: NonNullable<ModelConfigObject["properties"]>;
}): NonNullable<ModelConfigObject["properties"]> {
  const result: Record<string, unknown> = { ...current };
  applySparseLeaf(result, "contextWindow", effective.contextWindow, inherited?.contextWindow);
  for (const key of [
    "supportsJsonSchemaOutput",
    "supportsNativeWebSearch",
    "supportsMidConversationSystem",
  ] as const) {
    applyInteractiveSparseLeaf(
      result,
      key,
      effective[key],
      currentEffective?.[key],
      inherited?.[key],
    );
  }
  const input = { ...current?.inputFormat } as Record<string, unknown>;
  applyInteractiveSparseLeaf(
    input,
    "supportsImage",
    effective.inputFormat?.supportsImage,
    currentEffective?.inputFormat?.supportsImage,
    inherited?.inputFormat?.supportsImage,
  );
  applyInteractiveSparseLeaf(
    input,
    "supportsVideo",
    effective.inputFormat?.supportsVideo,
    currentEffective?.inputFormat?.supportsVideo,
    inherited?.inputFormat?.supportsVideo,
  );
  if (Object.keys(input).length > 0) result.inputFormat = input;
  else delete result.inputFormat;
  return result as NonNullable<ModelConfigObject["properties"]>;
}

function applyInteractiveSparseLeaf(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  currentEffective: unknown,
  inherited: unknown,
) {
  if (value === currentEffective) return;
  applySparseLeaf(target, key, value, inherited);
}

// [契约] 稀疏写入的唯一原子操作：等于 inherited 删除，否则写入。
// [权衡] 用严格相等而非深比较：这里处理的都是原始类型，数组已在调用前换成新实例。
// [失败路径] 用 delete 而非置 undefined，保证键枚举能真实反映覆盖情况。
function applySparseLeaf(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  inherited: unknown,
) {
  if (value === inherited) delete target[key];
  else target[key] = value;
}

// [契约] 档位与映射共用「等于生成源则删」，但比较对象不同：values 比当前有效，map 比 inherited。
// values 与当前有效相等说明没改，直接沿用 currentPersonal 的稀疏状态。
// [失败路径] 空映射不写入，避免下游把空串当成合法映射参与请求拼装。
// [失败路径] 结果为空时删除整个 reasoningLevel 键，避免空对象被当作覆盖。
function applyPersonalReasoning({
  target,
  values,
  map,
  currentEffective,
  inherited,
  currentPersonal,
}: {
  target: Record<string, unknown>;
  values: readonly string[];
  map: string;
  currentEffective: readonly string[] | undefined;
  inherited: NonNullable<ModelConfigObject["optionSpecs"]>["reasoningLevel"] | undefined;
  currentPersonal: NonNullable<ModelConfigObject["optionSpecs"]>["reasoningLevel"] | undefined;
}) {
  const next = { ...currentPersonal };
  if (!arraysEqual(values, currentEffective)) {
    if (arraysEqual(values, inherited?.values)) deleteMutable(next, "values");
    else assignMutable(next, "values", [...values]);
  }
  if (!map || map === inherited?.map) deleteMutable(next, "map");
  else assignMutable(next, "map", map);
  if (Object.keys(next).length === 0) delete target.reasoningLevel;
  else target.reasoningLevel = next;
}

// [契约] 顺序敏感比较：档位数组的顺序就是 UI 与协议顺序，不能排序后比较。
// [失败路径] 引用相等、双空、长度不等三条捷径覆盖绝大多数调用，其余逐项比较。
// [权衡] 不对元素做 trim 或大小写归一：归一已在解析阶段完成。
function arraysEqual(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
) {
  if (left === right) return true;
  if ((left?.length ?? 0) === 0 && (right?.length ?? 0) === 0) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

// [契约] 动态键写入与删除的唯一封装，供稀疏合并统一使用。
// [权衡] 用 Record<PropertyKey, unknown> 断言绕开索引签名限制，而不是把整份文件的类型放宽为 any。
// [资源] 就地修改的都是本文件内新建的临时对象，不会外泄到调用方。
function assignMutable(target: object, key: PropertyKey, value: unknown) {
  (target as Record<PropertyKey, unknown>)[key] = value;
}

function deleteMutable(target: object, key: PropertyKey) {
  delete (target as Record<PropertyKey, unknown>)[key];
}
