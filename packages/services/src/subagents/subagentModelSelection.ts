// 子代理模型选择归一化：把外部传入的 selection 收敛为共享 schema 允许的字段。
// INV：仅保留 reasoningLevel，其余 options 一律丢弃，避免上层私有参数透传到下游。
// 改错后果：放行多余字段会让模型调用收到未校验配置，产生难复现的行为差异。
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared";

export function normalizeSubagentModelSelection(
  selection: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return undefined;
  const options = selection.options;
// 解析结果即最终写入值，schema 校验失败应向上抛出，不能降级为原值返回。
  return modelSelectionSchema.parse({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(options?.reasoningLevel ? { options: { reasoningLevel: options.reasoningLevel } } : {}),
  });
}
