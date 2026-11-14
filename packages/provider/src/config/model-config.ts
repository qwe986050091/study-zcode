/* oxlint-disable eslint(max-lines) -- Model Config、嵌套 Overlay 与有序规则共同定义一份领域类型，暂不为行数拆散。 */
// ============================================================================
// provider/config/model-config.ts —— 模型配置的不可变覆盖层与有序规则解析
// ============================================================================
//
// 【职责边界】
// 1. 只为 model、properties、optionSpecs、inputFormat、outputFormat、枚举档位、上限档位提供不可变值对象。
// 2. 只负责把多层规则按 composeEffective 定下的层次顺序叠加，并把结果校验成完整配置。
// 3. 不解析用户文件、不读写磁盘、不缓存跨进程状态：入参是已解析数据，出参是只读对象。
// 4. 缺省继承、Config 递归覆盖、其他值整体替换的语义在 config-overlay.ts，本文件不得另立规则。
// 5. 字段合法性与默认值归 @zcode/shared/model-config 的 schema，本文件不复制枚举与边界。
//
// 【INV 不变量表】
// INV-01 断言：所有 Config 实例在构造结束前冻结，字段写入只发生在构造期内 —— 守住它的位置：七个 Config 子类的 constructor —— 改错故障：多个 provider 共享同一叠加结果时，UI 的一次补写会污染其他人的模型能力。
// INV-02 断言：overlayValue 仅在 next 不为 undefined 时替换，undefined 表示本层未声明 —— 守住它的位置：所有 overlay 中的标量字段 —— 改错故障：个人层未填 contextWindow 被当成清空，内置长上下文模型退回默认窗口并截断会话。
// INV-03 断言：null 是显式清空，overlayConfig 遇到 next 为 null 直接返回 null，不与 base 合并 —— 守住它的位置：properties、optionSpecs、inputFormat、outputFormat 的覆盖分支 —— 改错故障：把 null 归一成 undefined 后，个人层无法删除内置继承来的格式限制。
// INV-04 断言：overlayConfig 在 base 为 null 或 undefined 时直接采用 next，不对空值做合并 —— 守住它的位置：ModelPropertiesConfig 与 ModelOptionSpecsConfig 的 overlay —— 改错故障：对 null 执行合并会抛错，或产出空对象让序列化多出无意义层级。
// INV-05 断言：ModelConfigRules 构造时冻结数组并复制每条规则，外部数组改动不影响实例 —— 守住它的位置：ModelConfigRules 的 constructor —— 改错故障：调用方保存后继续往原数组追加，规则顺序与持久化内容分叉。
// INV-06 断言：composeEffective 保留 builtin 全部层次，只把 personal 的精确规则追加在后 —— 守住它的位置：composeEffective 的过滤条件 —— 改错故障：个人层带上模板与推荐规则，双层命中顺序变化，用户改过的值被内置推荐反向覆盖。
// INV-07 断言：resolve 严格按规则数组顺序累加，后出现者覆盖先出现者 —— 守住它的位置：resolve 的遍历顺序 —— 改错故障：改成按类型分组或并行合并，站点兜底规则会盖住用户的精确配置。
// INV-08 断言：manual-provider-model 覆盖前先清空基线里的手动叶子 —— 守住它的位置：resolve 中的三支覆盖表达式 —— 改错故障：手动规则只填部分字段时，旧模型的隐藏映射被复制进个人规则文件并随文件外泄。
// INV-09 断言：setExact 对同一 providerId 与 modelId 只保留一条精确规则，并停留在首次出现的位置 —— 守住它的位置：setExact 的 replaced 标志与重建循环 —— 改错故障：重复规则进入个人文件，编码边界触发 duplicate-key 校验，保存整体失败。
// INV-10 断言：setExact 在 useRecommendedConfig 未传时沿用上一条规则的 type，传了则取反 —— 守住它的位置：manual 的三元判定 —— 改错故障：UI 未显式传参时规则在自动与手动之间漂移，用户关掉的字段被重新贴回。
// INV-11 断言：setExact 落盘前用整条规则 schema 解析一次，不完整的手动值不允许写出 —— 守住它的位置：setExact 中 data 的解析 —— 改错故障：半成品手动规则写进文件，下次启动解析失败导致整份个人配置被丢弃。
// INV-12 断言：matchesRule 用 ^(?:pattern)$ 整串锚定，不做子串或前缀匹配 —— 守住它的位置：matchesRule 的正则拼接 —— 改错故障：gpt-4 命中 gpt-4o，请求被路由到不支持该参数的模型。
// INV-13 断言：忽略大小写只放宽 modelMatch，apiTypeMatch 与 baseUrlMatch 保持大小写敏感 —— 守住它的位置：三处 matchesRule 调用的 ignoreCase 实参 —— 改错故障：apiType 的拼写差异被静默吞掉，错误的协议适配器拿到请求。
// INV-14 断言：normalizeBaseURLForRuleMatch 解析失败返回 undefined，provider-site 规则随之整条跳过 —— 守住它的位置：resolve 里 baseUrl 的判空分支 —— 改错故障：非法 URL 被当成通配，所有站点规则同时命中，配置互相污染。
// INV-15 断言：getExact 用前向累积取最终写值，getExactRule 用反向扫描取最后一条身份 —— 守住它的位置：两个方法的遍历方向 —— 改错故障：两处方向被统一后，手动标记与实际合并结果不一致，保存时类型翻转。
// INV-16 断言：toJSON 统一经 objectWithoutUndefined，未声明字段不出现在对象里 —— 守住它的位置：所有 toJSON 与 objectWithoutUndefined —— 改错故障：undefined 被序列化成缺键或 null 后与显式清空混淆，叠加结果反向。
//
// ----------------------------------------------------------------------------
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeEnumOptionSpecDataSchema,
  completeLimitOptionSpecDataSchema,
  completeModelInputFormatDataSchema,
  completeModelOutputFormatDataSchema,
  completeModelPropertiesDataSchema,
  completeModelOptionSpecsDataSchema,
  completeModelConfigDataSchema,
  type enumOptionSpecDataSchema,
  type limitOptionSpecDataSchema,
  type modelInputFormatDataSchema,
  type modelOutputFormatDataSchema,
  type modelPropertiesDataSchema,
  type modelOptionSpecsDataSchema,
  type modelConfigDataSchema,
} from "@zcode/shared/model-config";
import { validateConfigSchema } from "./schema-validation.js";
import { clearManualModelConfig } from "./manual-model-config.js";
import {
  providerModelConfigRuleSchema,
  manualProviderModelConfigRuleSchema,
  personalModelConfigRulesSchema,
  builtinModelConfigRulesSchema,
  type ProviderModelConfigRuleData,
  type ManualProviderModelConfigRuleData,
  type TemplateModelConfigRuleData,
  type ModelMatchConfigRuleData,
  type ModelApiMatchConfigRuleData,
  type ProviderSiteMatchConfigRuleData,
  type BuiltinModelConfigRulesData,
  type PersonalModelConfigRulesData,
} from "./rule-data-schema.js";

export type EnumOptionSpec = Readonly<z.infer<typeof completeEnumOptionSpecDataSchema>>;

export type LimitOptionSpec = Readonly<z.infer<typeof completeLimitOptionSpecDataSchema>>;

export type EnumOptionSpecConfigInput = Readonly<z.infer<typeof enumOptionSpecDataSchema>>;

// [契约] 本类只管 values 与 map 两个叶子；values 在构造时浅拷贝后冻结，调用方数组后续追加不会渗入。
// [权衡] map 不做深拷贝：它是只读查表，复制会放大对象数量，代价是调用方必须把 map 视为不可变。
// [契约] values 显式传 null 表示清空，传 undefined 表示本层未声明，两条分支在构造里写死。
// [失败路径] 把 null 与 undefined 合并成一条分支，内置枚举档位被个人层清空后无法恢复。
export class EnumOptionSpecConfig extends ConfigOverlay<EnumOptionSpecConfig> {
  readonly values?: EnumOptionSpecConfigInput["values"];
  readonly map?: EnumOptionSpecConfigInput["map"];

  // [契约] 构造顺序是 values、map、冻结；任何字段赋值都必须在此之前完成。
  // [资源] 冻结发生在返回前，构造体内不做校验与抛错，避免留下半冻结对象。
  // [失败路径] 在构造后补写字段会抛 TypeError，热路径上表现为模型设置面板保存失败。
  // [权衡] 校验留给 validateComplete 而不是构造：稀疏层允许不完整，构造期拒绝会让部分层无法加载。
  constructor(input: EnumOptionSpecConfigInput = {}) {
    super();
    this.values =
      input.values === undefined
        ? undefined
        : input.values === null
          ? null
          : Object.freeze([...input.values]);
    this.map = input.map;
    Object.freeze(this);
  }

  overlay(next: EnumOptionSpecConfig): EnumOptionSpecConfig {
    return new EnumOptionSpecConfig({
      values: this.overlayValue(this.values, next.values),
      map: this.overlayValue(this.map, next.map),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeEnumOptionSpecDataSchema, this.toJSON(), path, true);
  }

  toJSON(): EnumOptionSpecConfigInput {
    return objectWithoutUndefined({
      values: this.values,
      map: this.map,
    });
  }
}

export type LimitOptionSpecConfigInput = Readonly<z.infer<typeof limitOptionSpecDataSchema>>;

export class LimitOptionSpecConfig extends ConfigOverlay<LimitOptionSpecConfig> {
  readonly max?: LimitOptionSpecConfigInput["max"];
  readonly map?: LimitOptionSpecConfigInput["map"];

  // [契约] 本类用整体拷贝接收 max 与 map，字段语义完全由 limitOptionSpecDataSchema 决定。
  // [契约] 这里不做 max 的数值范围归一，负数与零的判定交给完整校验，避免两处阈值漂移。
  // [失败路径] 在构造里补默认 max 会让未声明变成具体值，上层再无法区分继承与本地设置。
  constructor(input: LimitOptionSpecConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: LimitOptionSpecConfig): LimitOptionSpecConfig {
    return new LimitOptionSpecConfig({
      max: this.overlayValue(this.max, next.max),
      map: this.overlayValue(this.map, next.map),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeLimitOptionSpecDataSchema, this.toJSON(), path, true);
  }

  toJSON(): LimitOptionSpecConfigInput {
    return objectWithoutUndefined({
      max: this.max,
      map: this.map,
    });
  }
}

export type ModelPropertiesConfigInput = Readonly<z.infer<typeof modelPropertiesDataSchema>>;

export type ModelInputFormatConfigInput = Readonly<z.infer<typeof modelInputFormatDataSchema>>;

// [契约] 五个 supports 布尔叶子彼此独立，叠加时逐字段继承，不能合并成位图或能力枚举。
// [权衡] 不提供 anySupported 之类聚合读法：聚合会把未声明折成 false，隐藏继承含义。
// [失败路径] 若改成整体替换，个人层只写 supportsPdf 时，文本与图片能力会一起丢失。
// [契约] 字段名与 schema 一一对应，新增能力必须先改 schema，本文件不自行扩展字段。
export class ModelInputFormatConfig extends ConfigOverlay<ModelInputFormatConfig> {
  readonly supportsText?: ModelInputFormatConfigInput["supportsText"];
  readonly supportsImage?: ModelInputFormatConfigInput["supportsImage"];
  readonly supportsVideo?: ModelInputFormatConfigInput["supportsVideo"];
  readonly supportsAudio?: ModelInputFormatConfigInput["supportsAudio"];
  readonly supportsPdf?: ModelInputFormatConfigInput["supportsPdf"];

  constructor(input: ModelInputFormatConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: ModelInputFormatConfig): ModelInputFormatConfig {
    return new ModelInputFormatConfig({
      supportsText: this.overlayValue(this.supportsText, next.supportsText),
      supportsImage: this.overlayValue(this.supportsImage, next.supportsImage),
      supportsVideo: this.overlayValue(this.supportsVideo, next.supportsVideo),
      supportsAudio: this.overlayValue(this.supportsAudio, next.supportsAudio),
      supportsPdf: this.overlayValue(this.supportsPdf, next.supportsPdf),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelInputFormatDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelInputFormatConfigInput {
    return objectWithoutUndefined({
      supportsText: this.supportsText,
      supportsImage: this.supportsImage,
      supportsVideo: this.supportsVideo,
      supportsAudio: this.supportsAudio,
      supportsPdf: this.supportsPdf,
    });
  }
}

export type ModelOutputFormatConfigInput = Readonly<z.infer<typeof modelOutputFormatDataSchema>>;

export class ModelOutputFormatConfig extends ConfigOverlay<ModelOutputFormatConfig> {
  readonly supportsText?: ModelOutputFormatConfigInput["supportsText"];

  // [契约] 输出格式目前只有 supportsText 一个叶子，叠加仍走 overlayValue 而不是整体替换。
  // [权衡] 保留 `ModelOverlay` 单叶子结构而非裸布尔：新增输出能力不必改覆盖语义。
  // [失败路径] 若为简洁改成裸布尔，undefined 继承分支消失，内置输出约束会被清空。
  constructor(input: ModelOutputFormatConfigInput = {}) {
    super();
    Object.assign(this, input);
    Object.freeze(this);
  }

  overlay(next: ModelOutputFormatConfig): ModelOutputFormatConfig {
    return new ModelOutputFormatConfig({
      supportsText: this.overlayValue(this.supportsText, next.supportsText),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelOutputFormatDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelOutputFormatConfigInput {
    return objectWithoutUndefined({ supportsText: this.supportsText });
  }
}

// [契约] properties 是唯一聚合层，字段声明顺序即 toJSON 输出顺序，影响配置文件 diff 的可读性。
// [契约] inputFormat 与 outputFormat 持有 Config 实例或 null，从不是普通对象，读取方不得按字面量访问。
// [失败路径] 直接赋值普通对象会绕过规模校验，序列化时 undefined 与 null 混杂。
export class ModelPropertiesConfig extends ConfigOverlay<ModelPropertiesConfig> {
  readonly requiresMfjsToolSchema?: ModelPropertiesConfigInput["requiresMfjsToolSchema"];
  readonly contextWindow?: ModelPropertiesConfigInput["contextWindow"];
  readonly inputFormat?: ModelInputFormatConfig | null;
  readonly outputFormat?: ModelOutputFormatConfig | null;
  readonly supportsToolCall?: ModelPropertiesConfigInput["supportsToolCall"];
  readonly supportsJsonSchemaOutput?: ModelPropertiesConfigInput["supportsJsonSchemaOutput"];
  readonly supportsNativeWebSearch?: ModelPropertiesConfigInput["supportsNativeWebSearch"];
  readonly supportsMidConversationSystem?: ModelPropertiesConfigInput["supportsMidConversationSystem"];

  // [契约] 构造时把 inputFormat 与 outputFormat 归一化为 Config 实例，已是实例或为 null 时原样保留。
  // [权衡] 归一化放在构造而不是叠加：每个入口都必须拿到同一形态，否则递归覆盖会在普通对象上失败。
  // [失败路径] 漏掉 null 判断会让 null 被重新包装成空实例，显式清空退化成空对象。
  constructor(input: ModelPropertiesConfigInput = {}) {
    super();
    Object.assign(this, {
      ...input,
      inputFormat:
        input.inputFormat instanceof ModelInputFormatConfig || input.inputFormat == null
          ? input.inputFormat
          : new ModelInputFormatConfig(input.inputFormat),
      outputFormat:
        input.outputFormat instanceof ModelOutputFormatConfig || input.outputFormat == null
          ? input.outputFormat
          : new ModelOutputFormatConfig(input.outputFormat),
    });
    Object.freeze(this);
  }

  // [契约] 标量字段走 overlayValue，嵌套格式走 overlayConfig，两类语义不能互换。
  // [并发] 叠加不修改 this，返回新实例；同一基线可被多个 provider 同时使用而互不可见。
  // [失败路径] 改成原地修改会让后加载的 provider 改掉先加载者的能力位，表现为模型能力随机变化。
  // [权衡] 每次叠加都新建实例，牺牲分配换确定性；层数固定在三层左右，分配可接受。
  overlay(next: ModelPropertiesConfig): ModelPropertiesConfig {
    return new ModelPropertiesConfig({
      requiresMfjsToolSchema: this.overlayValue(
        this.requiresMfjsToolSchema,
        next.requiresMfjsToolSchema,
      ),
      contextWindow: this.overlayValue(this.contextWindow, next.contextWindow),
      inputFormat: this.overlayConfig(this.inputFormat, next.inputFormat),
      outputFormat: this.overlayConfig(this.outputFormat, next.outputFormat),
      supportsToolCall: this.overlayValue(this.supportsToolCall, next.supportsToolCall),
      supportsJsonSchemaOutput: this.overlayValue(
        this.supportsJsonSchemaOutput,
        next.supportsJsonSchemaOutput,
      ),
      supportsNativeWebSearch: this.overlayValue(
        this.supportsNativeWebSearch,
        next.supportsNativeWebSearch,
      ),
      supportsMidConversationSystem: this.overlayValue(
        this.supportsMidConversationSystem,
        next.supportsMidConversationSystem,
      ),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    // [契约] 校验对象是叠加完成后的完整配置，稀疏层缺失字段在此时才应报错。
    // [失败路径] 把同一 schema 用在单层稀疏值上，只声明部分字段的个人层会永远校验失败。
    return validateConfigSchema(completeModelPropertiesDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelPropertiesConfigInput {
    return objectWithoutUndefined({
      requiresMfjsToolSchema: this.requiresMfjsToolSchema,
      contextWindow: this.contextWindow,
      inputFormat: this.inputFormat?.toJSON() ?? this.inputFormat,
      outputFormat: this.outputFormat?.toJSON() ?? this.outputFormat,
      supportsToolCall: this.supportsToolCall,
      supportsJsonSchemaOutput: this.supportsJsonSchemaOutput,
      supportsNativeWebSearch: this.supportsNativeWebSearch,
      supportsMidConversationSystem: this.supportsMidConversationSystem,
    });
  }
}

export type ModelOptionSpecsConfigInput = Readonly<z.infer<typeof modelOptionSpecsDataSchema>>;

export class ModelOptionSpecsConfig extends ConfigOverlay<ModelOptionSpecsConfig> {
  readonly reasoningLevel?: EnumOptionSpecConfig | null;
  readonly maxOutputTokens?: LimitOptionSpecConfig | null;

  constructor(input: ModelOptionSpecsConfigInput = {}) {
    super();
    this.reasoningLevel = toEnumOptionSpecConfig(input.reasoningLevel);
    this.maxOutputTokens = toLimitOptionSpecConfig(input.maxOutputTokens);
    Object.freeze(this);
  }

  overlay(next: ModelOptionSpecsConfig): ModelOptionSpecsConfig {
    return new ModelOptionSpecsConfig({
      reasoningLevel: this.overlayConfig(this.reasoningLevel, next.reasoningLevel),
      maxOutputTokens: this.overlayConfig(this.maxOutputTokens, next.maxOutputTokens),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelOptionSpecsDataSchema, this.toJSON(), path, true);
  }

  toJSON(): ModelOptionSpecsConfigInput {
    return objectWithoutUndefined({
      reasoningLevel: this.reasoningLevel?.toJSON() ?? this.reasoningLevel,
      maxOutputTokens: this.maxOutputTokens?.toJSON() ?? this.maxOutputTokens,
    });
  }
}

// [契约] 该输入类型只把 properties 与 optionSpecs 换成 Config 实例，其余字段沿用 schema 推导。
// [权衡] 用 Omit 重写而非复制字段，避免 schema 新增字段时两处不同步。
export type ModelConfigInput = Omit<ModelConfigObject, "properties" | "optionSpecs"> & {
  readonly properties?: ModelPropertiesConfig | null;
  readonly optionSpecs?: ModelOptionSpecsConfig | null;
};

export type ModelConfigObject = Readonly<z.infer<typeof modelConfigDataSchema>>;

export class ModelConfig extends ConfigOverlay<ModelConfig> {
  readonly enabled?: ModelConfigObject["enabled"];
  readonly properties?: ModelPropertiesConfig | null;
  readonly optionSpecs?: ModelOptionSpecsConfig | null;

  // [契约] enabled 与两个嵌套层在此只做赋值，不做任何默认值填充。
  // [契约] 构造结束即冻结，之后所有变更都通过叠加产出新实例。
  // [失败路径] 给 enabled 补 true 默认值，会让个人层未声明的模型被意外启用。
  // [权衡] 不接受 null 的 enabled：关闭态由 false 表达，未声明由 undefined 表达，减少一层判空。
  constructor(input: ModelConfigInput = {}) {
    super();
    this.enabled = input.enabled;
    this.properties = input.properties;
    this.optionSpecs = input.optionSpecs;
    Object.freeze(this);
  }

  static empty(): ModelConfig {
    return new ModelConfig();
  }

  // [契约] fromData 是文件数据进入内存的唯一入口，null 保持 null，不做空实例替换。
  // [事务] 它只读入参，不修改传入对象；解析失败由调用方 schema 负责，不在这里兜底。
  // [失败路径] 在入口补默认 properties 会让文件未写与写了空对象不可区分，覆盖顺序失真。
  // [契约] 嵌套字段逐层构造，保证深层也是 Config 实例，递归覆盖才成立。
  static fromData(config: ModelConfigObject): ModelConfig {
    return new ModelConfig({
      enabled: config.enabled,
      properties:
        config.properties == null
          ? config.properties
          : new ModelPropertiesConfig(config.properties),
      optionSpecs:
        config.optionSpecs == null
          ? config.optionSpecs
          : new ModelOptionSpecsConfig(config.optionSpecs),
    });
  }

  overlay(next: ModelConfig): ModelConfig {
    return new ModelConfig({
      enabled: this.overlayValue(this.enabled, next.enabled),
      properties: this.overlayConfig(this.properties, next.properties),
      optionSpecs: this.overlayConfig(this.optionSpecs, next.optionSpecs),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeModelConfigDataSchema, this.toJSON(), path);
  }

  toJSON(): ModelConfigObject {
    return objectWithoutUndefined({
      enabled: this.enabled,
      properties: this.properties?.toJSON() ?? this.properties,
      optionSpecs: this.optionSpecs?.toJSON() ?? this.optionSpecs,
    });
  }
}

type RuleWithConfig<T> = Readonly<Omit<T, "config"> & { config: ModelConfig }>;
export type ProviderModelConfigRule = RuleWithConfig<ProviderModelConfigRuleData>;
export type ManualProviderModelConfigRule = RuleWithConfig<ManualProviderModelConfigRuleData>;
export type TemplateModelConfigRule = RuleWithConfig<TemplateModelConfigRuleData>;
export type ModelMatchConfigRule = RuleWithConfig<ModelMatchConfigRuleData>;
export type ModelApiMatchConfigRule = RuleWithConfig<ModelApiMatchConfigRuleData>;
export type ProviderSiteMatchConfigRule = RuleWithConfig<ProviderSiteMatchConfigRuleData>;

/** type 只标识内存执行规则的来源层，不写入配置文件；分组不能再按字段有无猜测。 */
// [契约] type 只是内存判别字段，标识规则来源层，任何序列化路径都必须剥掉。
// [失败路径] 把 type 写进配置文件，严格解析会因未知键失败，整份规则不可加载。
// [权衡] 用判别联合而不是按字段有无猜测来源：手动规则与自动规则字段几乎相同，猜测必然误判。
// [契约] 精确规则的 type 只有 provider-model 与 manual-provider-model 两种，ExactModelConfigRule 据此收窄。
export type ModelConfigRule =
  | (ProviderModelConfigRule & { readonly type: "provider-model" })
  | (ManualProviderModelConfigRule & { readonly type: "manual-provider-model" })
  | (TemplateModelConfigRule & { readonly type: "template-model" })
  | (ModelMatchConfigRule & { readonly type: "model" })
  | (ModelApiMatchConfigRule & { readonly type: "model-api" })
  | (ProviderSiteMatchConfigRule & { readonly type: "provider-site" });
type ExactModelConfigRule = Extract<
  ModelConfigRule,
  { type: "provider-model" | "manual-provider-model" }
>;

export interface ModelConfigRuleResolutionInput {
  readonly providerId: string;
  readonly templateId?: string | null;
  readonly modelId: string;
  readonly apiType?: string | null;
  readonly baseUrl?: string | null;
}

// [契约] 本类是不可变规则列表，所有写操作返回新实例。
// [资源] 私有字段不可被外部读取，暴露只能经 rules 的只读快照。
// [失败路径] 若暴露可变数组，调用方排序会改变 resolve 的覆盖优先级，配置在无感知中漂移。
// [契约] 规则顺序即优先级，本类不提供按类型重排的方法。
export class ModelConfigRules {
  readonly #rules: readonly ModelConfigRule[];

  // [契约] 构造时逐条浅拷贝并冻结，数组本身也冻结，防止外部持有同一引用。
  // [并发] 冻结后可在多窗口间共享同一实例读取，不需要额外加锁。
  // [失败路径] 只冻结数组不复制元素，外部仍能通过原对象改掉 providerId，命中错误的规则。
  // [权衡] 浅拷贝足够：config 已由 ModelConfig 自身不可变，深拷贝只会增加分配。
  constructor(rules: readonly ModelConfigRule[] = []) {
    this.#rules = Object.freeze(rules.map((rule) => Object.freeze({ ...rule })));
    Object.freeze(this);
  }

  static empty(): ModelConfigRules {
    return new ModelConfigRules();
  }

  /** Built-in 保留原层次和组内顺序；个人只包含普通/手动精确规则。 */
  // [契约] builtin 全量保留，personal 只追加精确规则，模板与推荐规则不允许来自个人层。
  // [事务] `composeModelConfig` 只做纯函数拼接：不写回任何一层。
  // [失败路径] 若把个人层全部规则拼进来，重复的推荐规则会在 resolve 中二次覆盖，用户改动被反向抹平。
  // [权衡] 不在此处去重：去重会掩盖个人层数据异常，问题应暴露在保存校验。
  static composeEffective(builtin: ModelConfigRules, personal: ModelConfigRules): ModelConfigRules {
    return new ModelConfigRules([...builtin.rules(), ...personal.rules().filter(isExactModelRule)]);
  }

  rules(): readonly ModelConfigRule[] {
    return this.#rules;
  }

  // [契约] 解析顺序固定为精确规则、模板规则、模型匹配、API 匹配、站点匹配，逐条累加。
  // [契约] baseUrl 只在进入站点匹配前归一化一次，大小写与默认端口交给 URL 解析统一。
  // [并发] 解析过程无共享可变状态，同一规则表可被多个请求并发调用。
  // [失败路径] 把归一化提前到每次比较，长列表下会反复重建 URL，成为热点并放大异常。
  // [权衡] 不做短路返回：后面的兜底规则必须有机会补齐前面未声明的字段。
  resolve(input: ModelConfigRuleResolutionInput): ModelConfig {
    let result = ModelConfig.empty();
    const baseUrl = input.baseUrl == null ? undefined : normalizeBaseURLForRuleMatch(input.baseUrl);
    for (const rule of this.#rules) {
      // [契约] 精确规则命中只比较 providerId 与 modelId，不看模板、不看站点。
      // [失败路径] 加上模板条件后，同一模型换了模板就会丢掉系统映射。
      if (isExactModelRule(rule)) {
        if (rule.providerId !== input.providerId || rule.modelId !== input.modelId) continue;
        // 手动规则要求所有可编辑叶子齐全，因此可直接覆盖；系统叶子继续来自当前身份的规则。
        // 清空整份基线会既丢失系统映射，也迫使 UI 把旧模型的隐藏配置复制进个人规则。
        result = (
          rule.type === "manual-provider-model"
            ? ModelConfig.fromData(clearManualModelConfig(result.toJSON()))
            : result
        ).overlay(rule.config);
        continue;
      }
      // [契约] 模板规则要求 templateId 与 modelId 同时相等，任一为空都不命中。
      // [失败路径] 允许 templateId 为空时通配，会让所有模型继承某个模板的配置。
      // [权衡] 模板规则不参与精确规则的清空逻辑，保持叠加而非替换。
      if (rule.type === "template-model") {
        if (rule.templateId === input.templateId && rule.modelId === input.modelId)
          result = result.overlay(rule.config);
        continue;
      }
      // 只放宽推荐规则匹配，不改真实请求里的模型 ID。
      // [契约] 推荐规则匹配模型名时忽略大小写，这是唯一放宽的字段。
      // [契约] 放宽只影响推荐规则命中，不改请求里的真实模型 ID。
      // [失败路径] 把忽略大小写扩散到 apiType 或 baseUrl，协议与站点判定会出现静默误命中。
      if (!matchesRule(rule.modelMatch, input.modelId, true)) continue;
      if (
        (rule.type === "model-api" || rule.type === "provider-site") &&
        rule.apiTypeMatch !== undefined
      ) {
        if (input.apiType == null || !matchesRule(rule.apiTypeMatch, input.apiType)) continue;
      }
      if (
        rule.type === "provider-site" &&
        (baseUrl === undefined || !matchesRule(rule.baseUrlMatch, baseUrl))
      )
        continue;
      result = result.overlay(rule.config);
    }
    return result;
  }

  // [契约] setExact 是精确配置的唯一写入口，负责判定手动还是自动并做整条校验。
  // [契约] 同 providerId 与 modelId 的旧规则被替换而非追加，位置保持在首次出现处。
  // [并发] 返回新实例，不修改原规则表，UI 侧失败时旧表仍然可用。
  // [失败路径] 改成原地替换会让并发保存互相覆盖，最后写入者决定全部字段。
  // [权衡] 不在此处合并同组其他规则：批量语义由调用方拆成多次调用表达。
  setExact(
    providerId: string,
    modelId: string,
    config: ModelConfig,
    useRecommendedConfig?: boolean,
  ): ModelConfigRules {
    const previous = this.getExactRule(providerId, modelId);
    const manual =
      useRecommendedConfig === undefined
        ? previous?.type === "manual-provider-model"
        : !useRecommendedConfig;
    // 保存入口复用整条规则 schema，不再另写一份“完整但忽略 enabled”的校验。
    // [事务] 校验用整条规则 schema，enabled 与嵌套配置必须在同一次解析中通过。
    // [失败路径] 另写一份宽松校验，手动规则的缺失叶子会漏进文件，下次读取才报错。
    const data = { providerId, modelId, config: config.toJSON() };
    (manual ? manualProviderModelConfigRuleSchema : providerModelConfigRuleSchema).parse(data);
    const replacement: ExactModelConfigRule = {
      type: manual ? "manual-provider-model" : "provider-model",
      providerId,
      modelId,
      config,
    };
    const result: ModelConfigRule[] = [];
    let replaced = false;
    for (const rule of this.#rules) {
      if (isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === modelId) {
        if (!replaced) result.push(replacement);
        replaced = true;
      } else {
        result.push(rule);
      }
    }
    if (!replaced) result.push(replacement);
    return new ModelConfigRules(result);
  }

  // [契约] 删除只移除精确规则，模板、推荐、站点规则不受影响。
  // [失败路径] 按 providerId 粗删会连带清掉该提供方的手动规则，用户自定义配置不可恢复。
  deleteExact(providerId: string, modelId: string): ModelConfigRules {
    return new ModelConfigRules(
      this.#rules.filter(
        (rule) =>
          !isExactModelRule(rule) || rule.providerId !== providerId || rule.modelId !== modelId,
      ),
    );
  }

  // [契约] 模型改名校验新旧 ID 相同则直接返回原实例，不产生新对象。
  // [契约] 改名只遍历精确规则，模板与匹配规则引用的是模式不是模型名。
  // [失败路径] 把匹配规则也一起改，模式里的正则片段会被当成模型 ID 替换，规则语义被破坏。
  // [权衡] 不做冲突检测：重名由上层 UI 与 schema 的唯一性校验负责。
  renameExactModel(
    providerId: string,
    currentModelId: string,
    nextModelId: string,
  ): ModelConfigRules {
    if (currentModelId === nextModelId) return this;
    return new ModelConfigRules(
      this.#rules.map((rule) =>
        isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === currentModelId
          ? { ...rule, modelId: nextModelId }
          : rule,
      ),
    );
  }

  // [契约] 按提供方批量删除时只过滤精确规则，保留共享的匹配与模板规则。
  // [失败路径] 若把所有含 providerId 的规则都删掉，其他提供方复用的站点规则会一起消失。
  deleteExactForProvider(providerId: string): ModelConfigRules {
    return new ModelConfigRules(
      this.#rules.filter((rule) => !isExactModelRule(rule) || rule.providerId !== providerId),
    );
  }

  // [契约] getExact 前向遍历并按出现顺序叠加，得到该模型最终的精确配置。
  // [契约] 没有命中返回 undefined，而不是空 ModelConfig，调用方据此区分无配置。
  // [失败路径] 改成返回空实例，会让未配置被当成全部关闭，新模型默认不可用。
  // [权衡] 不复用 resolve：resolve 会带入推荐与站点规则，语义不同。
  getExact(providerId: string, modelId: string): ModelConfig | undefined {
    let result: ModelConfig | undefined;
    for (const rule of this.#rules) {
      if (!isExactModelRule(rule) || rule.providerId !== providerId || rule.modelId !== modelId)
        continue;
      result = result ? result.overlay(rule.config) : rule.config;
    }
    return result;
  }

  // [契约] getExactRule 反向扫描，返回最后一条同身份规则，用于判定手动标记与替换位置。
  // [契约] 返回的是原规则引用，调用方不得修改，本类已整体冻结。
  // [失败路径] 改成正向取第一条，手动与自动的类型会与 resolve 的最终叠加结果不一致。
  // [权衡] 反向扫描最坏多走一遍数组，但规则量小，可读性优先。
  getExactRule(providerId: string, modelId: string): ExactModelConfigRule | undefined {
    for (let index = this.#rules.length - 1; index >= 0; index -= 1) {
      const rule = this.#rules[index]!;
      if (isExactModelRule(rule) && rule.providerId === providerId && rule.modelId === modelId)
        return rule;
    }
    return undefined;
  }

  // [契约] 内置 JSON 按 model、model-api、provider-site、template、provider-model 固定分组输出。
  // [事务] 编码前经 builtinModelConfigRulesSchema 解析，不合法结构不允许写出。
  // [失败路径] 跳过解析直接序列化，内存里的非法模式会落盘，下次启动整份内置规则不可用。
  // [契约] 分组键名与 schema 字段一一对应，改名必须同时改 schema。
  toZCodeBuiltinJSON(): BuiltinModelConfigRulesData {
    return builtinModelConfigRulesSchema.parse({
      modelRules: this.#collect("model"),
      modelApiRules: this.#collect("model-api"),
      providerSiteRules: this.#collect("provider-site"),
      templateModelRules: this.#collect("template-model"),
      builtinProviderModelRules: this.#collect("provider-model"),
    });
  }

  // [契约] 个人 JSON 只导出 provider-model 与 manual-provider-model 两类规则。
  // [失败路径] 把模板或站点规则也写进个人文件，下次加载会因未知键被严格解析拒绝。
  // [事务] 手动规则在此再次整体校验，直接构造的不完整值无法穿过编码边界。
  toPersonalJSON(): PersonalModelConfigRulesData {
    // 完整规则必须在编码边界再校验，不能把直接构造的不完整手动值写入文件。
    return personalModelConfigRulesSchema.parse({
      providerModelRules: this.#collect("provider-model"),
      manualProviderModelRules: this.#collect("manual-provider-model"),
    });
  }

  toJSON() {
    return {
      ...this.toZCodeBuiltinJSON(),
      manualProviderModelRules: this.#collect("manual-provider-model"),
    };
  }

  // [契约] 收集时先按 type 过滤再剥离 type，输出只保留身份字段与 config 的普通对象。
  // [失败路径] 忘掉剥离 type，文件里会出现内存判别字段，严格解析直接失败。
  // [契约] config 走自身 toJSON，未声明字段不出现在输出中。
  // [权衡] 用泛型收窄而不是为每种类型写一份收集函数，减少与 schema 的重复。
  #collect<T extends ModelConfigRule["type"]>(type: T) {
    return this.#rules
      .filter((rule): rule is Extract<ModelConfigRule, { type: T }> => rule.type === type)
      .map(({ type: _type, config, ...identity }) => ({ ...identity, config: config.toJSON() }));
  }
}

// [契约] 精确规则的判定只有两个 type，新增来源类型必须同步这里与 ExactModelConfigRule。
// [失败路径] 漏掉新增类型，规则在 resolve 中落入推荐分支，精确配置被当成模式匹配。
function isExactModelRule(rule: ModelConfigRule): rule is ExactModelConfigRule {
  return rule.type === "provider-model" || rule.type === "manual-provider-model";
}

// [契约] 模式整串锚定，调用方传入的 pattern 已是正则片段，本函数不再做转义。
// [失败路径] 改成包含匹配后，短模式会命中大量无关模型，路由与展示同时出错。
// [权衡] 每次调用都新建正则，未做缓存：规则表很小，缓存会引入失效管理。
function matchesRule(pattern: string, value: string, ignoreCase = false): boolean {
  return new RegExp(`^(?:${pattern})$`, ignoreCase ? "i" : undefined).test(value);
}

// [契约] 归一化去掉尾部斜杠，保留 path、query、hash 的原始大小写。
// [契约] 解析失败返回 undefined，调用方据此跳过站点规则而不是按通配处理。
// [失败路径] 在捕获分支里返回空串，会让空模式命中所有站点，规则互相覆盖。
// [权衡] 不手写 URL 拼接：交给标准解析器处理默认端口与大小写，避免平台差异。
function normalizeBaseURLForRuleMatch(value: string): string | undefined {
  try {
    // Host 大小写、默认端口和尾部斜杠不应改变配置命中；URL parser 会保留 path/query 大小写。
    const parsed = new URL(value);
    const suffix = `${parsed.search}${parsed.hash}`;
    const serialized = parsed.toString();
    const endpoint = suffix.length === 0 ? serialized : serialized.slice(0, -suffix.length);
    return `${endpoint.replace(/\/+$/, "")}${suffix}`;
  } catch {
    return undefined;
  }
}

// [契约] 归一化只包装普通对象，已是实例或为 null、undefined 时原样透传。
// [失败路径] 对 null 也重新包装，显式清空会变成空对象，叠加时无法清掉继承值。
function toEnumOptionSpecConfig(
  spec: EnumOptionSpecConfig | EnumOptionSpecConfigInput | null | undefined,
): EnumOptionSpecConfig | null | undefined {
  return spec instanceof EnumOptionSpecConfig || spec == null
    ? spec
    : new EnumOptionSpecConfig(spec);
}

function toLimitOptionSpecConfig(
  spec: LimitOptionSpecConfig | LimitOptionSpecConfigInput | null | undefined,
): LimitOptionSpecConfig | null | undefined {
  return spec instanceof LimitOptionSpecConfig || spec == null
    ? spec
    : new LimitOptionSpecConfig(spec);
}

// [契约] 只删除 undefined，保留 null 与 false、0、空串等有效值。
// [失败路径] 用真值过滤会把 false 与 0 一起删掉，禁用的模型保存后变回启用。
// [权衡] 每次序列化都新建对象，换取输出与未声明语义严格对应。
function objectWithoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  ) as T;
}
