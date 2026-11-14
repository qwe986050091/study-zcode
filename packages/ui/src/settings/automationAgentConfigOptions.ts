// INV-01 表单是纯本地草稿：守住位置 模块顶部说明与各构造函数；改错故障 打开编辑就改掉项目运行配置。
// INV-02 默认模式固定 build：守住位置 AUTOMATION_DEFAULT_MODE；改错故障 新建任务继承上次会话模式。
// INV-03 新建固化具体模型：守住位置 resolveAutomationPreferredModelValue；改错故障 保存虚拟「默认模型」。
// INV-04 模型项先精确后回退：守住位置 findDirectModelItem 的短路；改错故障 完整 value 已命中仍走模糊匹配。
// INV-05 纯模型名仅唯一时回填：守住位置 modelMatches 长度判断；改错故障 同名跨 provider 被猜错来源。
// INV-06 包装值 provider 不符不猜：守住位置 providerMatches 长度判断；改错故障 默认模型丢失 think 元数据。
// INV-07 展示标签复用会话侧规则：守住位置 resolveV4ModelTriggerLabel；改错故障 两侧身份文案不一致。
// INV-08 解析失败只影响展示：守住位置 !selectedItem 分支；改错故障 回退时改写了保存值。
// INV-09 失效档位置空：守住位置 validCurrentValue 三元；改错故障 刷新候选后自动保存默认档。
// INV-10 更新不支持 Think 用 null：守住位置 末尾三元；改错故障 undefined 被当成不修改，旧档位残留。
// INV-11 编辑中未换模型沿用持久化档位：守住位置 editing 与 modelChanged 双条件；改错故障 打开就重置用户档位。
// INV-12 输出预算不属于模型选择：守住位置 buildAutomationModelSelection；改错故障 预算被写进持久化模型。
// INV-13 空白 reasoningLevel 视为未设置：守住位置 trim 后判空；改错故障 空串写进 options。
// INV-14 全部构造函数纯函数：守住位置 无外部读写；改错故障 单元测试需要 mock 全局状态。
//
// 模块职责：定时任务表单的模型、模式与 Think 档位选项构造，以及模型值解析。
// 阅读顺序：先看默认值与首选模型，再看模型项解析，最后看档位更新与选择持久化。
import {
  getZCodeAgentModeSelectOptions,
  type ModelSelection,
  type ZCodeConfigOption,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import {
  buildRegistryModelSelectGroups,
  type ModelProviderGroupLabelOptions,
} from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { resolveV4ModelTriggerLabel } from "@/v4/composer/modelTriggerDisplay.js";

// 定时任务表单必须是纯本地草稿，不能借用 workspace 默认配置写接口来获取选项；
// 否则仅打开或取消编辑也会改掉当前项目和 draft session 的运行配置。

/** 权限模式默认值：Ask before changes。 */
// `AUTOMATION_DEFAULT_MODE` 是表单 mode 的兜底值，新建与缺省编辑态共用。
export const AUTOMATION_DEFAULT_MODE = "build";

/** 新建任务必须把目标 Host 的 preferredSelection 固化为具体模型，而不是保存虚拟“默认模型”。 */
// 首选模型必须落成 provider 与 model 的具体值。
export function resolveAutomationPreferredModelValue(
  view: Pick<ModelSelectionView, "preferredSelection">,
): string | null {
  const preferred = view.preferredSelection;
  return preferred ? encodeCustomModelValue(preferred.providerId, preferred.modelId) : null;
}

// 分组直接复用注册表构建器，不另起一套规则。
export function buildAutomationModelSelectGroups(params: {
  selectedProvider: ZCodeProvider;
  labels: ModelProviderGroupLabelOptions;
  registrySelectionView: ModelSelectionView;
}): ModelSelectGroup[] {
  return buildRegistryModelSelectGroups(
    params.selectedProvider,
    params.registrySelectionView,
    params.labels,
  );
}

export function buildAutomationModeOption(currentValue: string): ZCodeConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
    options: getZCodeAgentModeSelectOptions(),
  };
}

// 先按完整 value 精确命中。
function findDirectModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  for (const group of modelGroups) {
    const item = group.items.find((candidate) => candidate.value === modelValue);
    if (item) return item;
  }
  return null;
}

export function resolveAutomationModelItem(
  modelGroups: readonly ModelSelectGroup[],
  modelValue: string,
): ModelSelectGroupItem | null {
  const direct = findDirectModelItem(modelGroups, modelValue);
  if (direct) return direct;

  // `modelValue` 无 `/` 时 `separator` 为 -1，整串按 `qualifiedModelId` 处理。
  const separator = modelValue.indexOf("/");
  const qualifiedProviderId = separator > 0 ? modelValue.slice(0, separator) : null;
  const qualifiedModelId = separator > 0 ? modelValue.slice(separator + 1) : modelValue;
  // 回退时按模型名跨 provider 收集候选。
  const modelMatches = modelGroups.flatMap((group) =>
    group.items.filter((item) => {
      const decoded = decodeCustomModelValue(item.value);
      return decoded?.modelName === qualifiedModelId;
    }),
  );
  // 带 provider 前缀时，必须在同一 provider 内唯一。
  if (qualifiedProviderId) {
    const providerMatches = modelMatches.filter(
      (item) => decodeCustomModelValue(item.value)?.providerId === qualifiedProviderId,
    );
    if (providerMatches.length === 1) return providerMatches[0] ?? null;
  }
  // 历史 automation 可能只保存纯模型名；同名模型跨 provider 时不能猜测来源。
  // workspace runtime 也可能返回 zcode-openai-compatible/model 这类包装值，provider 对不上时
  // 只有模型名全局唯一才允许回填菜单项，避免默认模型丢失对应的 think 元数据。
  // 全局唯一才回填，否则放弃解析。
  return modelMatches.length === 1 ? (modelMatches[0] ?? null) : null;
}

export function resolveAutomationModelTriggerLabel(params: {
  modelGroups: readonly ModelSelectGroup[];
  modelSelectionView?: ModelSelectionView | null;
  modelValue: string;
  fallbackLabel: string;
}): string {
  const selectedItem = resolveAutomationModelItem(params.modelGroups, params.modelValue);
  // 解析失败只影响展示文案，不改动保存值。
  if (!selectedItem) {
    const decodedModel = decodeCustomModelValue(params.modelValue);
    if (decodedModel?.modelName) {
      // 仅展示层保留历史模型名；模型不回填到当前候选列表，也不改变保存或派发逻辑。
      return decodedModel.modelName;
    }

    const separator = params.modelValue.indexOf("/");
    return separator > 0
      ? params.modelValue.slice(separator + 1)
      : params.modelValue.trim() || params.fallbackLabel;
  }

  const selectedModel = decodeCustomModelValue(selectedItem.value);
  const providerId = selectedModel?.providerId;
  const providerName =
    params.modelSelectionView?.providers.find((provider) => provider.providerId === providerId)
      ?.providerName ?? undefined;

  // Automations 曾自行截断 provider/model 协议值，只显示最后一级模型名，
  // 导致同一模型在会话侧和定时任务侧身份文案不一致。这里直接复用会话侧规则，
  // 同时保留内置 family 与失效值的统一裁剪语义。
  // 展示规则与会话侧共用同一实现。
  return resolveV4ModelTriggerLabel({
    modelGroups: params.modelGroups,
    normalizedValue: selectedItem.value,
    fallbackLabel: params.fallbackLabel,
    providerId,
    providerName,
  });
}

export function buildAutomationThoughtLevelOption(
  runtimeOption: ZCodeConfigOption | undefined,
  currentValue: string,
): ZCodeConfigOption | null {
  const options = runtimeOption?.options ?? [];
  if (options.length === 0) return null;
  const validCurrentValue = options.some((option) => option.value === currentValue);
  // 原因：候选刷新不是用户选择，不能把失效档位改成默认/最高档并保存。
  // 失效档位置空，交由界面显示未选择。
  const resolvedValue = validCurrentValue ? currentValue : "";

  return {
    id: "thought_level",
    name: runtimeOption?.name ?? "Effort",
    category: "thought_level",
    type: "select",
    currentValue: resolvedValue,
    options: options.map((option) => ({ ...option })),
  };
}

/**
 * 更新已有定时任务时必须用 null 显式清掉不支持 Think 的目标模型旧值；
 * undefined 在 update 协议里表示“不修改”，会把源模型的档位残留到下次派发。
 */
export function resolveAutomationThoughtLevelUpdate(params: {
  editing: boolean;
  explicitlyChanged: boolean;
  modelChanged: boolean;
  persistedReasoningLevel?: string;
  resolvedThoughtLevel: string;
  thoughtLevel: string;
}): string | null | undefined {
  if (params.resolvedThoughtLevel) {
    if (params.explicitlyChanged) return params.thoughtLevel;
    if (params.editing && !params.modelChanged) {
      return params.persistedReasoningLevel?.trim() || params.resolvedThoughtLevel;
    }
    return params.resolvedThoughtLevel;
  }
  // 编辑时用 null 显式清值，新建时保持 undefined。
  return params.editing ? null : undefined;
}

/** Automation 只持久化模型选择；输出预算由执行链按本次请求决定。 */
export function buildAutomationModelSelection(params: {
  selected: ModelSelection;
  reasoningLevel?: string | null;
  previous?: ModelSelection;
}): ModelSelection {
  const reasoningLevel = params.reasoningLevel?.trim();
  // 空白档位不写入 options。
  const options = reasoningLevel ? { reasoningLevel } : {};
  return {
    providerId: params.selected.providerId,
    modelId: params.selected.modelId,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}
