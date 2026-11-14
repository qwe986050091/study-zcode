// INV-01 家族归一：守住位置 OAuth 标识到家族域的解析；改错故障：未知供应商进入下游选择。
// INV-02 前置早退：守住位置 域名与规格判断；改错故障：无家族仍发起一轮网络查询。
// INV-03 查询失败可降级：守住位置 权益快照的捕获；改错故障：权益服务异常中断登录刷新。
// INV-04 只读口径：守住位置 权益查询参数；改错故障：把未选中套餐当成当前编码套餐。
// INV-05 套餐自身：守住位置 查询身份的重写；改错故障：开始套餐被写成编码套餐。
// INV-06 跳过缺失：守住位置 访问身份解析；改错故障：空访问占用映射，后续误判。
// INV-07 状态另表：守住位置 供应商状态映射；改错故障：访问身份与可用性混淆。
// INV-08 刷新失败即止：守住位置 失败标记；改错故障：用空访问继续做选择。
// INV-09 未知保护：守住位置 未知可用性判断；改错故障：等待组织的账号被当成首次连接。
// INV-10 已存优先：守住位置 已保存连接分支；改错故障：登录后覆盖用户手动选择。
// INV-11 旧连接保留：守住位置 开始套餐分支；改错故障：权益失效导致连接被自动替换。
// INV-12 并行查询：守住位置 三个查询的组合；改错故障：串行等待拖慢登录流程。
// INV-13 条件写入：守住位置 预期设置对象；改错故障：迟到操作覆盖新设置。
// INV-14 版本可比：守住位置 更新时间的缺省；改错故障：空值比较恒不等，写入被拒。
// INV-15 无选择不写：守住位置 选择器空值分支；改错故障：空结果清空已有映射。
// INV-16 启动只读：守住位置 已保存连接的分支；改错故障：启动时把不可用当成失效。
// INV-17 设置回读：守住位置 选择后的刷新回调；改错故障：界面仍显示旧连接。
// INV-18 失败不抛：守住位置 启动入口的捕获；改错故障：启动刷新异常阻断应用。
//
// 模块职责：登录或启动后刷新供应商家族连接，并在版本约束下条件写入选择。
// 状态所有权：选择归设置服务；本模块只做查询、决策与条件写入。
// 阅读顺序：辅助解析 → 权益查询 → 访问刷新 → 登录后选择 → 启动恢复。
import type { IServiceAccessor } from "@zcode/services";
import type { AccountProviderState } from "@zcode/provider";
import type {
  OAuthProviderId,
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  getModelProviderFamilySpec,
  resolveProviderFamilyDomainFromOAuthProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import {
  type ModelProviderFamilyConnectionSelection,
  resolveAutomaticModelProviderFamilyConnectionSelection,
} from "@/lib/modelProviderFamilyConnectionSelection.js";

import { getEnterprisePricingProductsOrEmpty } from "@/root/oauthTeamPricing.js";

// OAuth 供应商标识先归一到家族域。
// 映射不到家族时返回空，调用方直接跳过。
//
function resolveModelProviderFamilySpecFromOAuth(
  provider: OAuthProviderId | string,
): ReturnType<typeof getModelProviderFamilySpec> | null {
  const family = resolveProviderFamilyDomainFromOAuthProvider(provider);
  return family ? getModelProviderFamilySpec(family) : null;
}

// 权益查询失败只告警并返回空。
// 登录后的刷新不能因权益服务异常而中断。
//
async function getUsageEntitlementSnapshotOrNull(params: {
  services: IServiceAccessor;
  providerId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}): Promise<UsageEntitlementSnapshot | null> {
  try {
    return await params.services.usageStatsService.getEntitlementSnapshot({
      includeSubscription: true,
      preferredProviderId: params.providerId,
      accountAccess: params.accountAccess,
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
  } catch (error) {
    logger.warn("[Root] 刷新登录后权益快照失败", {
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

// 刷新账号事实交给供应商设置服务。
// 只读查询显式要求首选供应商，不接受环境密钥。
//
async function refreshAccountProviderAccesses(params: {
  services: IServiceAccessor;
  providerIds: readonly string[];
  reason: string;
}): Promise<{
  accesses: ReadonlyMap<string, ZCodeProviderAccountAccess | ZCodeAccountAccess>;
  states: ReadonlyMap<string, AccountProviderState>;
  refreshed: boolean;
  error?: unknown;
}> {
  // 先刷新再按供应商逐个解析访问身份。
  // 解析不到的供应商直接跳过，不占映射。
  //
  const providerSettingsService = params.services.providerSettingsService;

  try {
    const view = await providerSettingsService.refresh(params.reason);
    const accesses = new Map(
      params.providerIds.flatMap((providerId) => {
        const resolved = resolveAccountProviderInspectionAccess(view, providerId);
        if (!resolved) return [];
        const access = resolved.access;
        // 登录/启动检查属于套餐只读查询。静态 mode 会经执行期 current 解析，
        // 把未选中或 pending 的 Start 当作当前 Coding 查询；此处必须明确查询套餐自身。
        // 套餐只读查询必须显式写明套餐自身。
        // 静态模式会经执行期解析成当前编码套餐。
        //
        const query: ZCodeProviderAccountAccess | ZCodeAccountAccess =
          access.mode === "start-plan" || access.mode === "individual-coding-plan"
            ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
            : access;
        return [[providerId, query] as const];
      }),
    );
    return {
      refreshed: true,
      accesses,
      states: new Map(
        view.providers.flatMap((provider) =>
          provider.accountState ? [[provider.providerId, provider.accountState] as const] : [],
        ),
      ),
    };
  } catch (error) {
    logger.warn("[Root] 刷新 Account Provider 访问身份失败", {
      providerIds: params.providerIds,
      error,
    });
    return { refreshed: false, accesses: new Map(), states: new Map(), error };
  }
}

// 解析不到家族域或家族规格时直接返回空。
// 两条前置条件都在发起任何请求之前判断。
//
export async function refreshLatestModelProviderFamilySelectionAfterLogin(params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.provider);
  if (!domain) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecFromOAuth(params.provider);
  if (!familySpec) return null;
  // 登录查询也有网络等待，条件写入必须基于查询前的意图，而非回包后的选择。
  const currentSettings = await params.services.settingService.get();
  // 条件写入的预期版本取自 `expectedAccountSettings`，即查询前的设置。
  // 回包后的选择不能反过来决定预期值。
  //
  const expectedAccountSettings = {
    providerFamilyDomain: currentSettings.providerFamilyDomain,
    providerFamilyConnectionSelections: currentSettings.providerFamilyConnectionSelections,
    // 原因：相同身份重选不会改变映射，迟到操作仍须按锁内版本拒绝。
    providerFamilyDomainUpdatedAt: currentSettings.providerFamilyDomainUpdatedAt ?? 0,
  };
  const codingPlanProviderId = familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = familySpec.startPlanProviderId;
  const codingPlanProviderIds = [
    familySpec.individualCodingPlanProviderId,
    familySpec.startPlanProviderId,
    familySpec.teamCodingPlanProviderId,
  ];
  const { accesses, states, refreshed } = await refreshAccountProviderAccesses({
    services: params.services,
    providerIds: codingPlanProviderIds,
    reason: "oauth-login-entitlement",
  });
  if (!refreshed) return null;
  // 登录后的刷新也可能仍在等待旧 Team 补组织；未知不是可按排序重选的首次连接。
  if (
    !currentSettings.providerFamilyConnectionSelections?.[domain] &&
    codingPlanProviderIds.every((id) => states.get(id)?.availability === "unknown")
  )
    return null;

  // 三个查询并行，权益与团队商品互不依赖。
  // `codingPlanEntitlement` 或 `startPlanEntitlement` 为空时由选择器自行降级。
  //
  const [codingPlanEntitlement, startPlanEntitlement, teamProducts] = await Promise.all([
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: codingPlanProviderId,
      accountAccess: accesses.get(codingPlanProviderId),
    }),
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: startPlanProviderId,
      accountAccess: accesses.get(startPlanProviderId),
    }),
    getEnterprisePricingProductsOrEmpty(params.services, domain),
  ]);
  // 旧 Start 连接只保留读取，不以权益失效为由删除或自动替换成付费连接。
  const savedSelection = currentSettings.providerFamilyConnectionSelections?.[domain];
  if (savedSelection?.kind === "start-plan") return savedSelection;
  const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
    providerFamilyDomain: domain,
    codingPlanEntitlement,
    startPlanEntitlement,
    teamProducts,
    codingPlanAvailable: states.has(codingPlanProviderId)
      ? states.get(codingPlanProviderId)!.availability === "available"
      : undefined,
    startPlanAvailable: states.has(startPlanProviderId)
      ? states.get(startPlanProviderId)!.availability === "available"
      : undefined,
  });
  // `selection` 为空时不写入，保留原有 `providerFamilyConnectionSelections`。
  // 只有明确选择才触发条件写入。
  //
  if (!selection) {
    return null;
  }

  await params.services.settingService.update(
    {
      providerFamilyConnectionSelections: {
        ...currentSettings.providerFamilyConnectionSelections,
        [domain]: selection,
      },
    },
    expectedAccountSettings,
  );
  return selection;
}

// 启动入口先看当前供应商与家族域。
// 已保存连接直接沿用，不因启动时的不可用而替换。
//
export async function refreshRestoredOAuthProviderFamilyAfterStartup(params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  if (!params.activeProvider) return null;
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.activeProvider);
  if (!domain) return null;
  const settings = await params.services.settingService.get();
  if (settings.providerFamilyDomain && settings.providerFamilyDomain !== domain) return null;
  const saved = settings.providerFamilyConnectionSelections?.[domain];
  if (saved) {
    // 原因：启动时的不可用不是本次运行中发生的失效，不能替用户更换已保存连接。
    // 刷新账号事实仍照常执行；只有后续真实失效提示的点击动作允许选择替代套餐。
    try {
      await params.services.providerSettingsService.refresh("oauth-restore-entitlement");
    } catch (error) {
      logger.warn("[Root] 启动账号刷新失败，保留原连接", { error });
    }
    return saved;
  }
  try {
    // 仅真正没有选择才沿用首次初始化；该入口保留旧连接待迁移的 unknown 保护及条件写入。
    const selection = await refreshLatestModelProviderFamilySelectionAfterLogin({
      provider: params.activeProvider,
      services: params.services,
    });
    if (selection) await params.refreshAppSettings?.();
    return selection;
  } catch (error) {
    logger.warn("[Root] 启动初始化连接失败", { error });
    return null;
  }
}
