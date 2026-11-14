// INV-01 套餐身份只看 providerId：守住位置 formatModelChangeLabel 的 switch；改错故障 从当前连接反推出错误的历史套餐。
// INV-02 三档套餐映射固定：守住位置 三个 case 组；改错故障 个人/Start/团队文案互相串。
// INV-03 非套餐 provider 回退通用拼接：守住位置 default 分支；改错故障 普通连接没有模型文案。
// INV-04 内置连接名不进模型文案：守住位置 resolveModelProviderFamilyIdByProviderId；改错故障 标题重复出现 Coding Plan。
// INV-05 套餐类型由切换提示补充：守住位置 括号后缀；改错故障 用户看不出套餐差异。
// INV-06 无 provider 名时只留模型名：守住位置 末尾三元；改错故障 出现「/model」这种半截文案。
// INV-07 provider 名先 trim：守住位置 normalizedProviderName；改错故障 空白名被当成有效前缀。
// INV-08 触发器标签先查菜单项：守住位置 find + items.some；改错故障 菜单内已有项仍显示原始值。
// INV-09 查不到就原样回退：守住位置 !selectedGroup 分支；改错故障 失效模型显示空白。
// INV-10 仅当前菜单项按 ID 兜底：守住位置 providerName 的或链；改错故障 历史记录被当下连接改写。
// INV-11 展示模型保留结构化前缀：守住位置 providerPrefix；改错故障 只能整段隐藏，无法按断点裁剪。
// INV-12 前缀显隐交给容器：守住位置 返回结构；改错故障 JS 里再写一套宽度分支。
// INV-13 完整标签与模型标签同源：守住位置 先算 fullLabel；改错故障 两处拼接规则漂移。
// INV-14 内置 family 不加前缀：守住位置 resolveV4ModelTriggerDisplay 的提前返回；改错故障 同一模型出现两种写法。
//
// 模块职责：v4 composer 的模型触发器与切换提示文案，区分套餐身份与 provider 前缀。
// 阅读顺序：先看套餐判定，再看通用拼接，最后看触发器标签与结构化展示。
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveModelProviderFamilyIdByProviderId,
} from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

export interface V4ModelTriggerDisplay {
  fullLabel: string;
  modelLabel: string;
  providerPrefix?: string;
}

// 切换记录必须保留当时的套餐身份。
export function formatModelChangeLabel(
  providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
  intl: Pick<IntlInstance, "formatMessage">,
): string {
  let planLabelId: string;
  // 切换记录必须保留当时的套餐身份，不能从当前连接或可用模型目录反推历史套餐。
  switch (providerId) {
    // 两家厂商的个人套餐共用同一文案。
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
      planLabelId = "settings.modelProvider.connectionMode.codingPlan";
      break;
    // Start 套餐单独归类。
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      planLabelId = "settings.modelProvider.connectionMode.startPlan";
      break;
    // 团队套餐走 teamPlan 标签，与 startPlan 分到 BUILTIN_MODEL_PROVIDER_IDS 的两组分支。
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
      planLabelId = "settings.modelProvider.connectionMode.teamPlan";
      break;
    default:
      // 非套餐连接回退通用拼接。
      return formatProviderModelLabel(providerId, providerName, modelName);
  }
  return `${modelName}(${intl.formatMessage({ id: planLabelId })})`;
}

export function formatProviderModelLabel(
  providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
): string {
  // Z.ai / BigModel 的内置连接名属于产品固定入口，拼进模型文案会重复展示
  // “Coding Plan”等连接信息；切换提示额外通过 formatModelChangeLabel 标明套餐类型。
  // 内置连接名不再拼进模型文案。
  if (providerId && resolveModelProviderFamilyIdByProviderId(providerId)) {
    return modelName;
  }

  // provider 名先 trim 再参与拼接。
  const normalizedProviderName = providerName?.trim();
  return normalizedProviderName ? `${normalizedProviderName}/${modelName}` : modelName;
}

export function resolveV4ModelTriggerLabel({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): string {
  // 先按 value 找到所属分组。
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  // selectedGroup 或 selectedItem 缺失时直接返回 fallbackLabel，不再按 ID 猜。
  if (!selectedGroup || !selectedItem) {
    return fallbackLabel;
  }

  // 仅当前菜单中存在的连接按 ID 兜底；历史记录的通用格式化保留原有语义。
  return formatProviderModelLabel(
    providerId,
    // 没有展示名时退回 id，保证仍可辨识。
    providerName?.trim() || providerId,
    selectedItem.name,
  );
}

export function resolveV4ModelTriggerDisplay({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): V4ModelTriggerDisplay {
  // 把 provider/model 预先拼成单一字符串后，响应式布局只能整段隐藏或依赖
  // 平台 JS 分支裁剪；这里保留结构化前缀，让 composer 容器断点统一决定可见密度。
  // fullLabel 复用 resolveV4ModelTriggerLabel，与右键菜单里的完整标签同一来源。
  const fullLabel = resolveV4ModelTriggerLabel({
    modelGroups,
    normalizedValue,
    fallbackLabel,
    providerId,
    providerName,
  });
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return { fullLabel, modelLabel: fallbackLabel };
  }

  // modelLabel 取 selectedItem.name，是各处断点里保底可见的最小单元。
  const modelLabel = selectedItem.name;
  const normalizedProviderName = providerName?.trim() || providerId;
  if (
    !normalizedProviderName ||
    (providerId && resolveModelProviderFamilyIdByProviderId(providerId))
  ) {
    return { fullLabel, modelLabel };
  }

  return {
    fullLabel,
    // providerPrefix 单独返回，显隐交给 composer 容器的断点决定。
    providerPrefix: `${normalizedProviderName}/`,
    modelLabel,
  };
}
