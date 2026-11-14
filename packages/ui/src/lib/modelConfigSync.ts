// INV-01 前缀不匹配即空：守住位置 前缀判断；改错故障 普通供应商被当自定义。
// INV-02 标识先裁剪：守住位置 去空白；改错故障 前后空格导致匹配失败。
// INV-03 前缀后为空返回空：守住位置 或运算；改错故障 生成空提供者标识。
// INV-04 幽灵键需两段分隔：守住位置 分隔符查找；改错故障 残缺键解析出错误标识。
// INV-05 解码失败用原文：守住位置 捕获分支；改错故障 异常中断配置刷新。
// INV-06 身份段按逗号切分：守住位置 映射裁剪；改错故障 提供者字段读不到。
// INV-07 只认提供者字段：守住位置 前缀判断；改错故障 其他身份段被误当提供者。
// INV-08 活动任务提供者优先：守住位置 选择顺序；改错故障 设置页同步到错误范围。
// INV-09 乐观表优先于缓存：守住位置 空值合并；改错故障 刚切换的模型回退旧值。
// INV-10 无活动任务用当前选择：守住位置 早退分支；改错故障 空任务把范围清空。
// INV-11 自定义供应商必用模型键：守住位置 条件判断；改错故障 保存后刷新丢失供应商。
// INV-12 同提供者沿用已选供应商：守住位置 相等判断；改错故障 纯模型名被误判为原生。
// INV-13 无模型值退回原生键：守住位置 末尾分支；改错故障 返回空供应商键。
// INV-14 模型选项只认下拉：守住位置 类别与类型双判断；改错故障 读到错误配置项。
// INV-15 空模型值视为缺失：守住位置 长度判断；改错故障 空串被当成有效模型。
// INV-16 自定义值需同提供者：守住位置 标识比较；改错故障 跨提供者套用模型名。
// INV-17 模型名需在清单内：守住位置 包含判断；改错故障 返回已下线的模型。
// INV-18 无法确定返回空：守住位置 末尾返回；改错故障 调用方拿到错误默认值。
//
// 模块职责：设置页与工作区模型配置之间的供应商作用域同步。
// 状态所有权：无状态，快照与选项由调用方传入。
// 阅读顺序：先看供应商键解析，再看作用域推导，最后看模型名解析。
import {
  CUSTOM_SUPPLIER_KEY_PREFIX,
  GHOST_SUPPLIER_KEY_PREFIX,
  buildNativeSupplierKey,
  resolveSupplierKeyFromModelDisplayValue,
  type ZCodeConfigOption,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

interface ModelConfigSyncScope {
  provider: ZCodeProvider;
  supplierKey: string;
}

export interface ModelConfigSyncWorkspaceSnapshot {
  activeTaskId: string | null;
  selectedProvider: ZCodeProvider;
  selectedSupplierKey: string;
  configOptions: ZCodeConfigOption[] | null;
  optimisticTaskListByTaskId: Record<string, Pick<ZCodeTaskMeta, "provider">>;
  taskListCache: ZCodeTaskMeta[] | null;
}

// custom:* 前缀命中的 key，冒号之后整段就是 provider id。
// ghost:* 需要找到第二段冒号，第三段才是身份串。
// 身份串先按 decodeURIComponent 解码，失败则沿用原文。
// 逗号分段后找 provider= 开头的段，取出提供者字段。
// 没有 custom 前缀又没有 provider 字段时返回 null。
export function parseCustomProviderIdFromSupplierKey(supplierKey: string): string | null {
  const normalizedSupplierKey = supplierKey.trim();
  if (normalizedSupplierKey.startsWith(CUSTOM_SUPPLIER_KEY_PREFIX)) {
    const providerId = normalizedSupplierKey.slice(CUSTOM_SUPPLIER_KEY_PREFIX.length).trim();
    return providerId || null;
  }

  if (!normalizedSupplierKey.startsWith(GHOST_SUPPLIER_KEY_PREFIX)) {
    return null;
  }

  const firstSeparatorIndex = normalizedSupplierKey.indexOf(":", GHOST_SUPPLIER_KEY_PREFIX.length);
  const secondSeparatorIndex =
    firstSeparatorIndex >= 0 ? normalizedSupplierKey.indexOf(":", firstSeparatorIndex + 1) : -1;
  if (secondSeparatorIndex < 0) {
    return null;
  }

  const encodedIdentity = normalizedSupplierKey.slice(secondSeparatorIndex + 1);
  let identity = encodedIdentity;
  try {
    identity = decodeURIComponent(encodedIdentity);
  } catch {
    identity = encodedIdentity;
  }

  // custom provider 配置被修改后，当前模型可能处在 ghost
  // supplier 状态，key 形如 ghost:glm:no-preference:provider=provider-demo...
  // 只识别 custom:* 会导致后续 provider registry 刷新无法定位自定义 provider。
  // 这里从 ghost identity 中恢复 provider 元数据，确保保存配置后能刷新对应配置。
  const providerSegment = identity
    .split(",")
    .map((segment) => segment.trim())
    .find((segment) => segment.startsWith("provider="));
  const providerId = providerSegment?.slice("provider=".length).trim();
  return providerId || null;
}

export function isCustomSupplierKeyForProvider(supplierKey: string, providerId: string): boolean {
  return parseCustomProviderIdFromSupplierKey(supplierKey) === providerId.trim();
}

function isCustomSupplierKey(supplierKey: string): boolean {
  return parseCustomProviderIdFromSupplierKey(supplierKey) !== null;
}

function resolveModelSupplierKeyFromConfigOptions(
  configOptions: ZCodeConfigOption[] | null,
  provider: ZCodeProvider,
): string | null {
  const modelValue = resolveModelValueFromConfigOptions(configOptions);
  if (!modelValue) {
    return null;
  }

  return resolveSupplierKeyFromModelDisplayValue(provider, modelValue);
}

// activeTaskId 为空时直接返回 null，不做后续推导。
// 先看 optimisticTaskListByTaskId 的乐观值，它比缓存新。
// 乐观值缺失时再查 taskListCache，按 taskId 匹配。
// 两处都取不到就返回 null，由调用方回退当前选择。
// 返回值再喂给 resolveWorkspaceModelConfigSyncScope 推导范围。
function resolveActiveTaskProvider(
  snapshot: ModelConfigSyncWorkspaceSnapshot,
): ZCodeProvider | null {
  const activeTaskId = snapshot.activeTaskId?.trim();
  if (!activeTaskId) {
    return null;
  }

  const taskProvider =
    snapshot.optimisticTaskListByTaskId[activeTaskId]?.provider ??
    snapshot.taskListCache?.find((task) => task.taskId === activeTaskId)?.provider ??
    null;

  return taskProvider ?? null;
}

// 无活动任务时沿用 snapshot.selectedProvider 与 selectedSupplierKey。
// 模型推导出的键是 custom:* 时直接采用。
// 当前提供者等于 selectedProvider 时沿用已选供应商。
// 其余情况用模型推导的 modelSupplierKey。
// 三者都没有则退回 buildNativeSupplierKey。
export function resolveWorkspaceModelConfigSyncScope(
  snapshot: ModelConfigSyncWorkspaceSnapshot,
): ModelConfigSyncScope {
  const activeTaskProvider = resolveActiveTaskProvider(snapshot);
  if (!activeTaskProvider) {
    return {
      provider: snapshot.selectedProvider,
      supplierKey: snapshot.selectedSupplierKey,
    };
  }

  const modelSupplierKey = resolveModelSupplierKeyFromConfigOptions(
    snapshot.configOptions,
    activeTaskProvider,
  );
  if (modelSupplierKey && isCustomSupplierKey(modelSupplierKey)) {
    return {
      provider: activeTaskProvider,
      supplierKey: modelSupplierKey,
    };
  }

  if (activeTaskProvider === snapshot.selectedProvider) {
    // Bugfix: 自定义供应商运行中的 ZCode Agent 回包经常只带纯模型名（如 glm-5.1），
    // 直接按模型值推导会误判成 native supplier，导致设置页保存后刷新到错误的 scope。
    // 当前 provider 与 selectedProvider 一致时，纯模型名不能证明 supplier 已变化，所以继续沿用 selectedSupplierKey。
    return {
      provider: activeTaskProvider,
      supplierKey: snapshot.selectedSupplierKey,
    };
  }

  if (modelSupplierKey) {
    return {
      provider: activeTaskProvider,
      supplierKey: modelSupplierKey,
    };
  }

  return {
    provider: activeTaskProvider,
    supplierKey: buildNativeSupplierKey(activeTaskProvider),
  };
}

function resolveModelValueFromConfigOptions(
  configOptions: ZCodeConfigOption[] | null,
): string | null {
  const modelOption = configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );

  if (!modelOption) {
    return null;
  }

  const modelValue = modelOption.currentValue;
  const normalizedModelValue =
    typeof modelValue === "string" ? modelValue.trim() : String(modelValue ?? "").trim();

  return normalizedModelValue.length > 0 ? normalizedModelValue : null;
}

// decodeCustomModelValue 解出的 providerId 必须等于入参 providerId。
// 解出的 modelName 还要在 providerModels 清单内，否则返回 undefined。
// 非自定义值直接看 providerModels.includes(modelValue)，命中即可用。
// 两条路都不匹配时返回 undefined，由调用方保留原值。
export function resolveModelNameForConfigSync(params: {
  configOptions: ZCodeConfigOption[] | null;
  selectedProvider: ZCodeProvider;
  providerId: string;
  providerModels: string[];
}): string | undefined {
  const modelValue = resolveModelValueFromConfigOptions(params.configOptions);
  if (!modelValue) {
    return undefined;
  }

  const decodedCustomValue = decodeCustomModelValue(modelValue);
  if (decodedCustomValue?.providerId === params.providerId) {
    const customModelName = decodedCustomValue.modelName?.trim();
    if (customModelName && params.providerModels.includes(customModelName)) {
      return customModelName;
    }

    return undefined;
  }

  if (params.providerModels.includes(modelValue)) {
    return modelValue;
  }

  return undefined;
}
