// INV-01 所有入口都先经 zod 校验：守住位置 parse 系列首步；改错故障 非法形状进入领域层。
// INV-02 内置、个人与账号是三种来源：守住位置 三组 parse 函数；改错故障 规则互相覆盖。
// INV-03 账号配置只取成员与权益：守住位置 pick 字段；改错故障 磁盘规则被当运行时事实。
// INV-04 账号访问信息可为空：守住位置 nullable 与 optional；改错故障 无权益账号解析失败。
// INV-05 规则数组到映射保持原顺序：守住位置 ProviderConfigMap 构造；改错故障 覆盖优先级漂移。
// INV-06 模板映射以 templateId 为键：守住位置 createTemplateRules；改错故障 同模板被覆盖。
// INV-07 模型规则按五类来源拼接：守住位置 内置模型分支；改错故障 某类规则丢失。
// INV-08 个人模型只有两类：守住位置 个人分支；改错故障 混入内置来源。
// INV-09 type 字段在构造时显式声明：守住位置 as const；改错故障 联合类型被放宽成字符串。
// INV-10 访问配置按 type 分派子类：守住位置 createProviderConfig；改错故障 智谱账号被当 API Key。
// INV-11 空访问配置原样保留：守住位置 空值判断；改错故障 空值被替换成默认对象。
// INV-12 api 配置同样按需构造：守住位置 api 三元；改错故障 空 api 生成空壳实例。
// INV-13 模型配置统一走工厂：守住位置 createModelConfig；改错故障 不同来源字段语义不一致。
// INV-14 解析函数不吞异常：守住位置 直接返回 parse 结果；改错故障 上层无法区分配置错误。
// INV-15 校验只复用严格 schema：守住位置 rule-data-schema；改错故障 未知字段被静默忽略。
// INV-16 解析不修改入参：守住位置 展开后重建；改错故障 调用方数据被意外改写。
// INV-17 账号映射用非空字符串键：守住位置 record 约束；改错故障 空 providerId 进入映射。
// INV-18 本文件不持有运行时状态：守住位置 纯函数边界；改错故障 解析结果被缓存共享。
//
// 模块职责：把磁盘与账号的原始配置解析为 Provider 与 Model 领域对象。
// 状态所有权：无状态；所有产物都是新建实例，不缓存也不回写入参。
// 阅读顺序：先看账号片段与各 parse 入口，再看规则转换，最后看两个构造器。
import { z } from "zod";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { providerConfigDataSchema, zhipuAccountAccessDataSchema } from "./provider-data-schema.js";
import { ModelConfig, ModelConfigRules } from "./model-config.js";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplate,
  ProviderTemplateMap,
  ZhipuAccountAccessConfig,
} from "./provider-config.js";
import {
  builtinModelConfigRulesSchema,
  personalModelConfigRulesSchema,
  builtinProviderConfigRulesSchema,
  personalProviderConfigRulesSchema,
  providerConfigRuleSchema,
  providerTemplateConfigRuleSchema,
  builtinProviderConfigRuleSchema,
  type ProviderConfigRuleData,
  type ProviderTemplateConfigRuleData,
} from "./rule-data-schema.js";

// accountProviderConfigSchema 从 providerConfigDataSchema 里 pick 出 builtinModelIds。
// access 由 type 与 entitled 组成，nullable 且 optional。
// 该 schema 只给 Account 运行时用，不进入 provider-config 文件的解析链。
// 它只描述 Account 运行时事实，不是磁盘配置规则的第二种格式。
const accountProviderConfigSchema = providerConfigDataSchema
  .pick({ builtinModelIds: true })
  .extend({
    access: zhipuAccountAccessDataSchema.pick({ type: true, entitled: true }).nullable().optional(),
  });

// parseProviderConfigMap 先用 z.array 校验，再交给 createProviderRules。
// 内置侧校验 builtinProviderConfigRuleSchema，个人侧只取 providerRules 字段。
// parseAccountProviderConfigMap 用 z.record 校验，值走 accountProviderConfigSchema。
// 每个 providerId 对应的配置都经由 createProviderConfig 生成。
// 四个 parse* 都返回 ProviderConfigMap，调用方不需要分支。
export function parseProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(z.array(providerConfigRuleSchema).parse(input));
}

export function parseZCodeBuiltinProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(z.array(builtinProviderConfigRuleSchema).parse(input));
}

export function parseProviderTemplateMap(input: unknown): ProviderTemplateMap {
  return createTemplateRules(z.array(providerTemplateConfigRuleSchema).parse(input));
}

export function parseZCodeBuiltinProviderConfigRules(input: unknown): {
  providers: ProviderConfigMap;
  providerTemplates: ProviderTemplateMap;
} {
  const parsed = builtinProviderConfigRulesSchema.parse(input);
  return {
    providers: createProviderRules(parsed.providerRules),
    providerTemplates: createTemplateRules(parsed.templateRules),
  };
}

export function parsePersonalProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(personalProviderConfigRulesSchema.parse(input).providerRules);
}

/** Account 运行时事实仍只有成员及权益；不是磁盘配置规则的第二种格式。 */
export function parseAccountProviderConfigMap(input: unknown): ProviderConfigMap {
  const parsed = z.record(z.string().min(1), accountProviderConfigSchema).parse(input);
  return new ProviderConfigMap(
    Object.entries(parsed).map(([providerId, config]) => [
      providerId,
      createProviderConfig(config),
    ]),
  );
}

export function parseProviderConfig(input: unknown): ProviderConfig {
  return createProviderConfig(providerConfigDataSchema.parse(input));
}

export function parseModelConfig(input: unknown): ModelConfig {
  return createModelConfig(modelConfigDataSchema.parse(input));
}

// 五类规则依次展开。
// 每类都补上稳定的 type 字面量。
// 每条规则里的 config 都交给 createModelConfig，不在解析层展开。
// 展开顺序固定：model 在前，再依次 model-api、provider-site、template-model、provider-model。
// 数组最后包成 ModelConfigRules，顺序保持不变。
export function parseZCodeBuiltinModelConfigRules(input: unknown): ModelConfigRules {
  const parsed = builtinModelConfigRulesSchema.parse(input);
  return new ModelConfigRules([
    ...parsed.modelRules.map((rule) => ({
      ...rule,
      type: "model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.modelApiRules.map((rule) => ({
      ...rule,
      type: "model-api" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.providerSiteRules.map((rule) => ({
      ...rule,
      type: "provider-site" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.templateModelRules.map((rule) => ({
      ...rule,
      type: "template-model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.builtinProviderModelRules.map((rule) => ({
      ...rule,
      type: "provider-model" as const,
      config: createModelConfig(rule.config),
    })),
  ]);
}

export function parsePersonalModelConfigRules(input: unknown): ModelConfigRules {
  const parsed = personalModelConfigRulesSchema.parse(input);
  return new ModelConfigRules([
    ...parsed.providerModelRules.map((rule) => ({
      ...rule,
      type: "provider-model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.manualProviderModelRules.map((rule) => ({
      ...rule,
      type: "manual-provider-model" as const,
      config: createModelConfig(rule.config),
    })),
  ]);
}

// 逐条剥离 config 字段。
// 其余字段用展开保留，只把 config 换成 createProviderConfig 的结果。
// createProviderConfig 负责把 rule.config 转成运行时配置。
// rules.map 保持输入顺序，不重排也不去重。
function createProviderRules(rules: readonly ProviderConfigRuleData[]): ProviderConfigMap {
  return new ProviderConfigMap(
    rules.map(({ config, ...rule }) => ({
      ...rule,
      config: createProviderConfig(config),
    })),
  );
}

function createTemplateRules(
  rules: readonly ProviderTemplateConfigRuleData[],
): ProviderTemplateMap {
  return new ProviderTemplateMap(
    rules.map((rule) => [
      rule.templateId,
      new ProviderTemplate({ ...rule, config: createProviderConfig(rule.config) }),
    ]),
  );
}

// 先展开原始字段。
// 空访问配置原样透传。
// 非智谱类型包装为 API Key 配置。
// 智谱类型包装为账号配置。
function createProviderConfig(config: z.infer<typeof providerConfigDataSchema>): ProviderConfig {
  return new ProviderConfig({
    ...config,
    access:
      config.access == null
        ? config.access
        : config.access.type !== "zhipu-account"
          ? new ApiKeyAccessConfig(config.access)
          : new ZhipuAccountAccessConfig(config.access),
    api: config.api == null ? config.api : new ProviderApiConfig(config.api),
  });
}

function createModelConfig(config: z.infer<typeof modelConfigDataSchema>): ModelConfig {
  return ModelConfig.fromData(config);
}
