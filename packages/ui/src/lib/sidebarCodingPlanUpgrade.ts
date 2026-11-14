// INV-01 回退入口只按家族域名选择：守住位置 三元表达式；改错故障 API Key 模式拿不到升级入口。
// INV-02 层级归一化统一小写去空白：守住位置 归一化函数；改错故障 大小写差异漏判。
// INV-03 词元匹配要求边界：守住位置 正则前缀与后缀；改错故障 premium 被当成 max。
// INV-04 终态包含企业与团队：守住位置 包含判断；改错故障 企业套餐仍显示升级。
// INV-05 终态判定先看配额层级：守住位置 早退判断；改错故障 明细缺失时误判可升级。
// INV-06 终态判定再扫描订阅明细：守住位置 任一命中；改错故障 团队产品被漏掉。
// INV-07 顶级套餐同样按词元识别：守住位置 相等与词元双条件；改错故障 带后缀的顶级套餐被漏判。
// INV-08 有效套餐要求身份一致：守住位置 提供方比较；改错故障 拿别的提供方快照当依据。
// INV-09 无套餐原因不算有效：守住位置 原因比较；改错故障 未订阅也被当成在用。
// INV-10 订阅明细必须非空：守住位置 长度判断；改错故障 空订阅进入候选。
// INV-11 可升级要求已认证：守住位置 认证字段；改错故障 未登录也提示升级。
// INV-12 不可用原因白名单排除：守住位置 三个原因比较；改错故障 网络错误被提示成可升级。
// INV-13 加载中不给出结论：守住位置 入口早退；改错故障 闪烁错误的升级入口。
// INV-14 候选必须同时具备提供方与快照完成：守住位置 过滤条件；改错故障 用未加载完的空快照判断。
// INV-15 首选用户当前选择：守住位置 查找顺序；改错故障 选中入口与侧栏不一致。
// INV-16 其次选在用套餐：守住位置 有效套餐查找；改错故障 升级入口指向未使用品牌。
// INV-17 最后按首个候选兜底：守住位置 兜底取值；改错故障 有候选却不显示入口。
// INV-18 无候选返回未定义：守住位置 空数组早退；改错故障 调用方拿到空串。
//
// 模块职责：从侧栏可见的套餐权益推导升级入口应指向哪个提供方。
// 状态所有权：无状态；权益快照、加载态与当前选择全部由调用方注入。
// 阅读顺序：先看家族回退与层级判定，再看快照分类，最后看提供方选择优先级。
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { CodingPlanUsageAvailableProvider } from "@/CodingPlanUsageRemainingPanel.js";
import type { SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

// snapshot 三态由调用方注入，接口不自行请求
// loading 与 snapshot 正交，null 快照也可以 loading
// 接口只含 providerId / snapshot / loading 三个字段
export interface SidebarCodingPlanUpgradeEntitlement {
  providerId: SidebarUsageCodingPlanProviderId;
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
}

// 家族为 bigmodel 时指向 bigmodel 入口。
// 非 bigmodel 家族统一回退 zaiIndividualCodingPlan
// providerFamilyDomain 为 null 时同样走 zaiIndividualCodingPlan
export function resolveSidebarCodingPlanUpgradeFallbackProviderId(
  providerFamilyDomain: ProviderFamilyDomain | null,
): SidebarUsageCodingPlanProviderId {
  // API Key 模式不会为 Coding Plan provider 注入套餐 key，头像升级入口因而
  // 无法从权益或用量来源推导 provider；按 provider 家族域名回退到对应品牌的入口。
  return providerFamilyDomain === "bigmodel"
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
}

function normalizePlanLevel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasPlanLevelToken(value: string | null | undefined, token: string): boolean {
  return new RegExp(`(^|[\\s_-])${token}($|[\\s_-])`, "i").test(value?.trim() ?? "");
}

// isTerminalCodingPlanLevel 先 normalizePlanLevel 再做 includes
// normalized 命中 enterprise 或 team 即返回 true
// 终态只被 isUpgradableCodingPlanSnapshot 使用，不影响用量面板
function isTerminalCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  // 判断套餐层级是否为不可升级的终态：enterprise/team 视为终态。
  return normalized.includes("enterprise") || normalized.includes("team");
}

function isMaxCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  return normalized === "max" || hasPlanLevelToken(value, "max");
}

export function isTerminalCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isTerminalCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = normalizePlanLevel(detail.productId);
    const productName = normalizePlanLevel(detail.productName);
    return isTerminalCodingPlanLevel(productId) || isTerminalCodingPlanLevel(productName);
  });
}

export function isMaxCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isMaxCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = detail.productId;
    const productName = detail.productName;
    return isMaxCodingPlanLevel(productId) || isMaxCodingPlanLevel(productName);
  });
}

function hasActiveCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  return (
    snapshot?.provider?.id === providerId &&
    snapshot.unavailableReason !== "no_plan" &&
    Boolean(snapshot.subscription?.details.length)
  );
}

function isUpgradableCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  if (!snapshot || snapshot.provider?.id !== providerId || !snapshot.authenticated) {
    return false;
  }

  if (isTerminalCodingPlanSnapshot(snapshot)) {
    return false;
  }

  if (
    snapshot.unavailableReason === "not_authenticated" ||
    snapshot.unavailableReason === "not_configured" ||
    snapshot.unavailableReason === "unavailable"
  ) {
    return false;
  }

  return snapshot.unavailableReason === "no_plan" || Boolean(snapshot.subscription?.details.length);
}

// modelProvidersLoading 为真时返回 undefined
// 候选收 loading=false 且在 availableProviders 中的 entitlement
// 优先 selectedProviderId 与在用套餐，都未命中才取首个可升级项
export function resolveSidebarCodingPlanUpgradeProviderId(params: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: SidebarCodingPlanUpgradeEntitlement[];
  modelProvidersLoading: boolean;
  selectedProviderId?: SidebarUsageCodingPlanProviderId;
}): SidebarUsageCodingPlanProviderId | undefined {
  if (params.modelProvidersLoading) {
    return undefined;
  }

  const providerEntitlements = params.entitlements.filter(
    (entitlement) =>
      !entitlement.loading &&
      params.availableProviders.some((provider) => provider.providerId === entitlement.providerId),
  );
  const upgradableEntitlements = providerEntitlements.filter((entitlement) =>
    isUpgradableCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
  );
  if (upgradableEntitlements.length === 0) {
    return undefined;
  }

  const selectedEntitlement = upgradableEntitlements.find(
    (entitlement) => entitlement.providerId === params.selectedProviderId,
  );
  if (selectedEntitlement) {
    return selectedEntitlement.providerId;
  }

  const activeEntitlement = upgradableEntitlements.find((entitlement) =>
    hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
  );
  return (activeEntitlement ?? upgradableEntitlements[0])?.providerId;
}
