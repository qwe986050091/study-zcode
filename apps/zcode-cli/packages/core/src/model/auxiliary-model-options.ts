/**
 * 后台辅助调用的模型参数策略：为标题生成、摘要等非主流程请求给出稳定、低成本的参数。
 * 纯函数，无 IO、无缓存、不修改 model 对象；输出可直接并入请求 options。
 * 与主会话参数解耦：这里不读 session 配置，因此会话切换档位不会改变后台请求成本。
 */

import type { Model, ModelOptions } from "@zcode/contracts";

// 辅助调用（标题、摘要等后台请求）的输出 token 上限，压低成本并避免长输出挤占主流程。
const AUXILIARY_MAX_OUTPUT_TOKENS = 5_000;

/**
 * 辅助调用统一使用公开档位的最低项，并限制输出预算；档位顺序来自 Model Config，
 * 不能再按 disabled/off 等名字推断协议行为。
 * 输出为 Required<ModelOptions>：两个字段必有值，调用方无需再处理 undefined。
 * reasoningLevel 固定取 values[0]（最低档），不随会话配置变化，避免后台请求成本漂移。
 * maxOutputTokens 取模型上限与 5000 的较小值；模型上限缺失时由 optionSpecs 保证存在。
 * 不变量：两字段必须非 undefined，调用方无需再兜底；若模型未声明 reasoningLevel 档位，
 * 这里会直接抛错而不是降级，属于装配期错误，应在启动阶段暴露。
 * 无副作用，同一 model 重复调用结果一致，可安全用于每次后台请求。
 */
export function auxiliaryModelOptions(model: Model): Required<ModelOptions> {
  return {
    reasoningLevel: model.optionSpecs.reasoningLevel.values[0]!,
    maxOutputTokens: Math.min(AUXILIARY_MAX_OUTPUT_TOKENS, model.optionSpecs.maxOutputTokens.max),
  };
}
