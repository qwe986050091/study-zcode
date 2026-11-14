// INV-01 严格对象：守住位置 各规则对象的严格模式；改错故障：未知字段被静默忽略，配置写错也不报错。
// INV-02 标识非空：守住位置 标识字符串的最小长度；改错故障：空标识被接受，规则互相覆盖。
// INV-03 正则预编译：守住位置 模式字段的校验函数；改错故障：非法正则直到运行时才炸。
// INV-04 全串匹配：守住位置 校验时的首尾锚定；改错故障：模式只匹配子串，规则命中范围过大。
// INV-05 继承一致：守住位置 扩展后的字段集合；改错故障：扩展规则漏字段，校验与类型脱节。
// INV-06 单 Provider 单声明：守住位置 智能与手动配置的互斥检查；改错故障：同一组合两条规则，后者覆盖前者。
// INV-07 元组编码：守住位置 身份键的序列化；改错故障：标识自带分隔符时发生键碰撞。
// INV-08 账号受限：守住位置 账号前缀的访问声明检查；改错故障：账号 Provider 的访问配置被规则覆盖。
// INV-09 模板引用：守住位置 模板规则的标识字段；改错故障：模板规则与实例规则混用同一字段。
// INV-10 内置集合：守住位置 内置规则的五个数组；改错故障：新增规则类型没有校验入口。
// INV-11 唯一标识：守住位置 模板与 Provider 的重复检查；改错故障：重复标识按数组顺序静默胜出。
// INV-12 错误路径：守住位置 重复问题的路径构造；改错故障：报错指不到具体条目。
// INV-13 手动配置：守住位置 手动规则的配置字段；改错故障：手动规则被按智能规则解析。
// INV-14 个人集合：守住位置 个人规则的分组约束；改错故障：内置分组混进个人配置。
// INV-15 内置模型列表：守住位置 个人规则里被省略的字段；改错故障：个人 Provider 携带内置模型列表。
// INV-16 schema 唯一来源：守住位置 类型推导；改错故障：手写类型与校验漂移。
// INV-17 纯校验：守住位置 规则定义与检查函数；改错故障：校验中写外部状态导致结果不稳定。
// INV-18 导出稳定：守住位置 底部类型导出；改错故障：下游引用改名后编译断裂。
//
// 模块职责：用 zod 定义模型与 Provider 配置规则的结构、互斥与唯一性约束。
// 状态所有权：无运行期状态；所有 schema 在模块加载时构建一次。
// 阅读顺序：基础字段 → 匹配规则 → 内置与个人模型规则 → Provider 规则 → 类型导出。
import { z } from "zod";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { manualModelConfigSchema } from "./manual-model-config.js";
export { manualModelConfigSchema, type ManualModelConfig } from "./manual-model-config.js";
import {
  apiKeyAccessDataSchema,
  personalProviderApiDataSchema,
  providerConfigDataSchema,
  providerGroupDataSchema,
  providerTemplateDataSchema,
} from "./provider-data-schema.js";

// 标识字段：非空字符串，用于模板、Provider 与模型的身份。
// 只约束非空，不约束格式，具体格式由上游配置来源保证。
//
const idSchema = z.string().min(1);
// 匹配模式：先尝试把整串编译成带锚定的正则，编译失败即判为非法。
// 锚定是为了让模式匹配整串而不是任意子串，避免命中范围被放大。
//
const patternSchema = z
  .string()
  .min(1)
  .refine((pattern) => {
    try {
      new RegExp(`^(?:${pattern})$`);
      return true;
    } catch {
      return false;
    }
  }, "无效匹配正则");

// 模型匹配规则：模式加一份模型配置，严格模式拒绝额外字段。
// API 与站点规则在它的基础上扩展各自的选择条件。
//
export const modelMatchConfigRuleSchema = z
  .object({
    modelMatch: patternSchema,
    config: modelConfigDataSchema,
  })
  .strict();
export const modelApiMatchConfigRuleSchema = modelMatchConfigRuleSchema.extend({
  apiTypeMatch: patternSchema,
});
export const providerSiteMatchConfigRuleSchema = modelMatchConfigRuleSchema.extend({
  baseUrlMatch: patternSchema,
  apiTypeMatch: patternSchema.optional(),
});
// 模板模型规则：以模板与模型两个标识定位，再附带要落地的配置。
// 实例规则由它去掉模板标识并换成 Provider 标识得到，字段集合保持一致。
//
export const templateModelConfigRuleSchema = z
  .object({
    templateId: idSchema,
    modelId: idSchema,
    config: modelConfigDataSchema,
  })
  .strict();
export const providerModelConfigRuleSchema = templateModelConfigRuleSchema
  .omit({ templateId: true })
  .extend({
    providerId: idSchema,
  });
export const manualProviderModelConfigRuleSchema = providerModelConfigRuleSchema.extend({
  config: manualModelConfigSchema,
});

// 内置模型规则集合：五类规则各自成数组，整体严格校验。
// 五类分别是模型匹配、API 匹配、站点匹配、模板模型与内置 Provider 模型。
// 数组顺序即优先级，新增类型要同时补数组与类型导出。
//
export const builtinModelConfigRulesSchema = z
  .object({
    modelRules: z.array(modelMatchConfigRuleSchema),
    modelApiRules: z.array(modelApiMatchConfigRuleSchema),
    providerSiteRules: z.array(providerSiteMatchConfigRuleSchema),
    templateModelRules: z.array(templateModelConfigRuleSchema),
    builtinProviderModelRules: z.array(providerModelConfigRuleSchema),
  })
  .strict();
// 个人模型规则集合：智能配置与手动配置分开存放。
// 互斥检查用 Provider 与模型的元组做键，同一组合只能声明一种。
//
export const personalModelConfigRulesSchema = z
  .object({
    providerModelRules: z.array(providerModelConfigRuleSchema),
    manualProviderModelRules: z.array(manualProviderModelConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    // 不能通过最后一次覆盖掩盖矛盾模式；身份用元组编码，避免模型 ID 自带分隔符碰撞。
    const smartIds = new Set(
      rules.providerModelRules.map((rule) => JSON.stringify([rule.providerId, rule.modelId])),
    );
    rules.manualProviderModelRules.forEach((rule, index) => {
      if (smartIds.has(JSON.stringify([rule.providerId, rule.modelId]))) {
        context.addIssue({
          code: "custom",
          path: ["manualProviderModelRules", index],
          message: "同一 Provider/Model 不能同时声明智能和手动配置",
        });
      }
    });
  });

// 身份、模板引用和实例名属于规则，不再成为可向执行配置叠加的叶子。
// Provider 规则：身份、可选的模板引用与实例名、启用开关与配置本体。
// 模板引用与实例名允许为空，表示由配置来源决定展示名。
//
export const providerConfigRuleSchema = z
  .object({
    providerId: idSchema,
    templateId: idSchema.nullable().optional(),
    providerName: idSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    config: providerConfigDataSchema,
  })
  .strict();
// 模板规则：只保留展示与访问相关字段，密钥字段被剥离。
// 访问配置允许为空，表示模板本身不携带凭据。
//
export const providerTemplateConfigRuleSchema = providerTemplateDataSchema.extend({
  config: providerConfigDataSchema
    .pick({ logo: true, access: true, api: true, builtinModelIds: true })
    .extend({
      access: apiKeyAccessDataSchema.omit({ apiKey: true }).nullable().optional(),
    }),
});
export const builtinProviderConfigRuleSchema = providerConfigRuleSchema.extend({
  config: providerConfigDataSchema.omit({ personalModelIds: true, modelOrder: true }).extend({
    group: providerGroupDataSchema.exclude(["standard-personal"]),
  }),
});
// 个人 Provider 规则：去掉内置模型列表，限定个人分组与个人 API 配置。
// 账号前缀的 Provider 不允许在规则里声明访问配置，避免覆盖内置凭据。
//
export const personalProviderConfigRuleSchema = providerConfigRuleSchema
  .extend({
    config: providerConfigDataSchema.omit({ builtinModelIds: true }).extend({
      group: providerGroupDataSchema.extract(["standard-personal"]).nullable().optional(),
      api: personalProviderApiDataSchema.nullable().optional(),
    }),
  })
  .superRefine((rule, context) => {
    if (rule.providerId.startsWith("account:") && rule.config.access !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["config", "access"],
        message: "固定 Account Provider 的 Access 只能由 ZCode Built-in Config 声明",
      });
    }
  });
export const builtinProviderConfigRulesSchema = z
  .object({
    templateRules: z.array(providerTemplateConfigRuleSchema),
    providerRules: z.array(builtinProviderConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    checkUniqueIds(
      rules.templateRules.map((rule) => rule.templateId),
      "templateRules",
      "templateId",
      context,
    );
    checkUniqueIds(
      rules.providerRules.map((rule) => rule.providerId),
      "providerRules",
      "providerId",
      context,
    );
  });
export const personalProviderConfigRulesSchema = z
  .object({
    providerRules: z.array(personalProviderConfigRuleSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    checkUniqueIds(
      rules.providerRules.map((rule) => rule.providerId),
      "providerRules",
      "providerId",
      context,
    );
  });

// 唯一性检查：按顺序扫描标识，重复项带下标与字段名写回问题。
// 重复不抛异常，而是累积到上下文，让一次校验报出全部冲突。
// 路径包含分组与下标，调用方能直接定位到出错的数组元素。
//
function checkUniqueIds(
  ids: readonly string[],
  group: string,
  key: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id))
      context.addIssue({
        code: "custom",
        path: [group, index, key],
        message: `重复 ${key}: ${id}`,
      });
    seen.add(id);
  });
}

export type ModelMatchConfigRuleData = z.infer<typeof modelMatchConfigRuleSchema>;
export type ModelApiMatchConfigRuleData = z.infer<typeof modelApiMatchConfigRuleSchema>;
export type ProviderSiteMatchConfigRuleData = z.infer<typeof providerSiteMatchConfigRuleSchema>;
export type TemplateModelConfigRuleData = z.infer<typeof templateModelConfigRuleSchema>;
export type ProviderModelConfigRuleData = z.infer<typeof providerModelConfigRuleSchema>;
export type ManualProviderModelConfigRuleData = z.infer<typeof manualProviderModelConfigRuleSchema>;
export type BuiltinModelConfigRulesData = z.infer<typeof builtinModelConfigRulesSchema>;
export type PersonalModelConfigRulesData = z.infer<typeof personalModelConfigRulesSchema>;
export type ProviderConfigRuleData = z.infer<typeof providerConfigRuleSchema>;
export type ProviderTemplateConfigRuleData = z.infer<typeof providerTemplateConfigRuleSchema>;
