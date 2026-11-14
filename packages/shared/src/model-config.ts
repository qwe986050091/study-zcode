// INV-01 选项映射非空：守住位置 最小长度；改错故障 空映射通过校验后编译失败。
// INV-02 映射编译失败转为字段错误：守住位置 精化回调；改错故障 配置页整页崩溃。
// INV-03 枚举值不得为空串：守住位置 逐项精化；改错故障 空白档位出现在下拉里。
// INV-04 枚举值不得重复：守住位置 去重比较；改错故障 同档位出现两次无法区分。
// INV-05 枚举至少一项：守住位置 数组下限；改错故障 模型没有任何可选档位。
// INV-06 上限必须为正整数：守住位置 整数与正数校验；改错故障 零上限让生成立即截断。
// INV-07 完整形状拒绝多余字段：守住位置 严格模式；改错故障 拼写错误字段被静默忽略。
// INV-08 稀疏形状只放宽必填：守住位置 形状派生；改错故障 局部配置无法覆盖默认值。
// INV-09 输入格式五项齐全：守住位置 属性表；改错故障 能力声明缺项被当成不支持。
// INV-10 输出格式只声明文本：守住位置 输出模式；改错故障 未实现的能力被当作可用。
// INV-11 属性嵌套格式可空：守住位置 可空可选；改错故障 局部覆盖时丢失其它能力。
// INV-12 模型配置三块齐全：守住位置 完整形状；改错故障 缺省字段被当成禁用。
// INV-13 数据合同只含数据：守住位置 类型导出；改错故障 行为与输入输出泄漏进公共契约。
// INV-14 类型全部由模式推导：守住位置 推导声明；改错故障 手写类型与校验漂移。
// INV-15 校验失败给中文可读信息：守住位置 消息文本；改错故障 用户只看到路径数组。
// INV-16 严格模式逐层生效：守住位置 每层配置；改错故障 内层多余字段逃过检查。
// INV-17 稀疏形状不改变值域：守住位置 派生入口；改错故障 局部配置放宽了取值范围。
// INV-18 本模块不引入运行时行为：守住位置 导入清单；改错故障 公共模式拖入服务依赖。
//
// 模块职责：模型能力与选项的公共数据合同。
// 状态所有权：无状态；只导出模式与由它推导的类型。
// 阅读顺序：先看选项映射，再看能力与配置形状，最后看类型导出。
import { z } from "zod";
import { compileModelOptionMap } from "@zcode/model-option-map";
import { sparseShape } from "./config-schema.js";

// optionMapSchema 先用 z.string().min(1) 拒绝空映射文本，空串不会进入 compileModelOptionMap。
// compileModelOptionMap 抛错时经 context.addIssue 转成字段级问题，不冒泡成整页异常。
// addIssue 的 message 优先取 error.message，非 Error 才回落 "Option map 无法编译"。
// variableName 只接受 reasoningLevel 或 maxOutputTokens，编译错误据此带上字段名。
function optionMapSchema(variableName: "reasoningLevel" | "maxOutputTokens") {
  return z
    .string()
    .min(1)
    .superRefine((source, context) => {
      try {
        compileModelOptionMap(source, variableName);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Option map 无法编译",
        });
      }
    });
}

export const completeEnumOptionSpecDataSchema = z
  .object({
    /** 按语义强度从低到高排列；首项是辅助调用可选的最低公开档位。 */
    values: z
      .array(
        z
          .string()
          .refine((value) => value.trim().length > 0, "reasoningLevel.values 必须是非空字符串"),
      )
      .min(1, "reasoningLevel.values 不能为空")
      .refine((values) => new Set(values).size === values.length, "reasoningLevel.values 不能重复")
      .readonly(),
    map: optionMapSchema("reasoningLevel"),
  })
  .strict();

export const completeLimitOptionSpecDataSchema = z
  .object({
    max: z.number().int().positive(),
    map: optionMapSchema("maxOutputTokens"),
  })
  .strict();

export const enumOptionSpecDataSchema = z
  .object(sparseShape(completeEnumOptionSpecDataSchema.shape))
  .strict();
export const limitOptionSpecDataSchema = z
  .object(sparseShape(completeLimitOptionSpecDataSchema.shape))
  .strict();

export const completeModelInputFormatDataSchema = z
  .object({
    supportsText: z.boolean(),
    supportsImage: z.boolean(),
    supportsVideo: z.boolean(),
    supportsAudio: z.boolean(),
    supportsPdf: z.boolean(),
  })
  .strict();
export const completeModelOutputFormatDataSchema = z.object({ supportsText: z.boolean() }).strict();
export const modelInputFormatDataSchema = z
  .object(sparseShape(completeModelInputFormatDataSchema.shape))
  .strict();
export const modelOutputFormatDataSchema = z
  .object(sparseShape(completeModelOutputFormatDataSchema.shape))
  .strict();

export const completeModelPropertiesDataSchema = z
  .object({
    requiresMfjsToolSchema: z.boolean(),
    contextWindow: z.number().int().positive(),
    inputFormat: completeModelInputFormatDataSchema,
    outputFormat: completeModelOutputFormatDataSchema,
    supportsToolCall: z.boolean(),
    supportsJsonSchemaOutput: z.boolean(),
    supportsNativeWebSearch: z.boolean(),
    supportsMidConversationSystem: z.boolean(),
  })
  .strict();
export const modelPropertiesDataSchema = z
  .object({
    ...sparseShape(completeModelPropertiesDataSchema.shape),
    inputFormat: modelInputFormatDataSchema.nullable().optional(),
    outputFormat: modelOutputFormatDataSchema.nullable().optional(),
  })
  .strict();

export const completeModelOptionSpecsDataSchema = z
  .object({
    reasoningLevel: completeEnumOptionSpecDataSchema,
    maxOutputTokens: completeLimitOptionSpecDataSchema,
  })
  .strict();
export const modelOptionSpecsDataSchema = z
  .object({
    ...sparseShape(completeModelOptionSpecsDataSchema.shape),
    reasoningLevel: enumOptionSpecDataSchema.nullable().optional(),
    maxOutputTokens: limitOptionSpecDataSchema.nullable().optional(),
  })
  .strict();

// completeModelConfigDataSchema 要求 enabled/properties/optionSpecs 三块齐备，缺一即校验失败。
// enabled 声明为 z.boolean()：禁用态必须显式写 false，缺省不会被当成禁用。
// properties 与 optionSpecs 分别复用各自的 complete 模式，保证两块形状完整而不共享可选性。
// 三层 .strict() 逐层生效，properties/optionSpecs 内层的多余字段同样被拒绝。
export const completeModelConfigDataSchema = z
  .object({
    enabled: z.boolean(),
    properties: completeModelPropertiesDataSchema,
    optionSpecs: completeModelOptionSpecsDataSchema,
  })
  .strict();
export const modelConfigDataSchema = z
  .object({
    ...sparseShape(completeModelConfigDataSchema.shape),
    properties: modelPropertiesDataSchema.nullable().optional(),
    optionSpecs: modelOptionSpecsDataSchema.nullable().optional(),
  })
  .strict();

// 跨层只共享数据合同；Provider 行为类与 IO 不进入公共 Schema。
// 能力类型全部由 z.infer 自 complete 模式导出，模式改动时类型自动跟随。
// 需要新类型时先加模式再 z.infer，避免同一形状出现第二份手写定义。
// 公共合同只含数据字段；Provider 行为与 IO 留在各自包内，不进 model-config。
export type ModelInputFormatData = z.infer<typeof completeModelInputFormatDataSchema>;
export type ModelOutputFormatData = z.infer<typeof completeModelOutputFormatDataSchema>;
export type ModelPropertiesData = z.infer<typeof completeModelPropertiesDataSchema>;
export type EnumOptionSpecData = z.infer<typeof completeEnumOptionSpecDataSchema>;
export type LimitOptionSpecData = z.infer<typeof completeLimitOptionSpecDataSchema>;
export type ModelOptionSpecsData = z.infer<typeof completeModelOptionSpecsDataSchema>;
