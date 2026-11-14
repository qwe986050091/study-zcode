// ============================================================================
// Detail.tsx — Model Provider 设置页右侧详情面板
//
// 职责：根据左侧导航项的类型，决定右侧渲染哪一种详情：
//   preset      预置供应商（只读 endpoint + 可编辑模型列表）；
//   codingPlan  个人 Coding Plan（状态卡 + 套餐购买/升级）；
//   teamPlan    团队套餐（状态卡 + 组织/项目维度额度）；
//   custom      自定义供应商（可改名、可删除、可填自定义 endpoint）；
//   codingPlanLoading 纯导航占位（详情区不渲染）。
//
// 本文件是「展示层」而不是「状态所有者」：所有权益、订阅、额度的权威来源是
// useUsageEntitlement 与 useProviderSettingsView；这里只做投影和降级。
// 因此不允许在本文件里缓存权益快照或推断订阅状态，否则会和 Account 快照打架。
//
// INV 不变量表（每条注明守住它的位置）
// INV-01 导航项类型决定渲染分支，顺序固定：preset -> codingPlan/teamPlan -> loading。
//         守住：三个互斥的早期 return。
// INV-02 codingPlanLoading 只属于导航占位，绝不能落进详情表单渲染路径。
//         守住：if (selectedNavItem.type === "codingPlanLoading") return null。
// INV-03 Team 权益只来自 useUsageEntitlement 的团队查询；quota 失败不得撤销订阅。
//         守住：resolveTeamScopedPlanNavItem 末尾的 hasTeamSubscription 分支。
// INV-04 「查询失败」不等于「未分配」；unknown 必须映射成 unavailable 而不是 not-allocated。
//         守住：entitlement.error 的三处分支。
// INV-05 切换团队时必须清空上一团队的额度与订阅展示，不能沿用缓存。
//         守住：cacheKey 取 selectedNavItem.key + 每个分支重建 quotaLimits。
// INV-06 已确认 credential-unavailable 时，后续 loading/error 不得改写真实原因。
//         守住：resolveTeamScopedPlanNavItem 的第一个 if。
// INV-07 购买/支付 token 与卡片登录态是两个独立事实，不得互相点亮。
//         守住：codingPlanPurchaseTokenAuthenticated 的取值。
// INV-08 明确无权益时才隐藏模型配置区；查询/取 Key 失败不得隐藏或删除配置。
//         守住：hasNoPlanEntitlement / hidePlanModels 的计算。
// INV-09 Start Plan 的编辑器在 Account 快照确认可用后不得被额度 loading 卸载。
//         守住：accountAvailable 与 shouldShowDedicatedProviderDetail。
// INV-10 升级面板打开时，状态卡的登录/重试动作必须收敛，避免两套流程并行。
//         守住：四处 !upgradePlansVisible 前置条件。
// INV-11 未登录的购买入口先建 OAuth 身份再开购买面板。
//         守住：handlePurchaseChoiceSelect 的 resolvePurchaseChoiceSelectionIntent 分支。
// INV-12 购买入口只读 Account owner 已确认的权益，不读商品目录的 subscribed 标记。
//         守住：hasActivePaidPlan。
// INV-13 模型编辑回调必须五件套齐传给每个卡片，避免「只删 UI 不写盘」。
//         守住：modelEditingProps 的展开点。
// INV-14 价格缺失时不补造静态价；个人套餐全售罄时才显示售罄。
//         守住：resolvePurchaseChoiceBannerPrice 的短路顺序。
// INV-15 币种缺失时按 provider 结算域兜底，不得默认 CNY。
//         守住：product.product.priceCurrency 的三元兜底。
// INV-16 预置供应商名称不可编辑：它承载固定 API Key 入口语义。
//         守住：preset 分支的 nameEditable={false}。
// INV-17 Start Plan 名称只本地化已知的英文默认名，不覆盖远端自定义名。
//         守住：resolveStartPlanPurchaseChoiceBannerTitle 的正则判断。
// INV-18 打开另一个 Provider 详情时必须清空升级面板可见态。
//         守住：selectedItemKey 的 useEffect。
// ============================================================================
import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- Model Provider 详情页当前集中编排 Plan Card、API Key 表单和 OAuth 套餐态；后续稳定后再按 family/API/OAuth 拆分。 */
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZAI_PROVIDER_ID,
  type BuiltinModelProviderId,
  type ProviderFamilyConnectionSelectionSettings,
  type StartPlanPreviewConfig,
  isStartPlanModelProviderId,
  isIndividualCodingPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  type ModelConnectivityResult,
  type OAuthProviderId,
} from "@zcode/shared";
import {
  getProviderFormApiKeyManagementUrl,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { ArrowRightIcon, AstroidIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  type CodingPlanStatus,
  type CodingPlanProviderId,
  type ModelProviderNavItem,
} from "./constants.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";
import {
  ModelProviderLoadingCard,
  PresetProviderPlaceholderCard,
  CodingPlanStatusPanel,
} from "./StatusCards.js";
import {
  resolveCodingPlanUpgradeProductsProviderId,
  type CodingPlanLoginOptions,
} from "./codingPlanPricingCards.js";
import {
  type EnterpriseCodingPlanProductGroup,
  type PurchaseAudience,
} from "./codingPlanEnterpriseTiers.js";
import { resolveCodingPlanStatusPanelViewState } from "./codingPlanStatusPanelViewState.js";
import {
  formatCodingPlanAmount,
  pickProductPrice,
  type CodingPlanProductDisplay,
} from "./codingPlanProductPresentation.js";
import {
  ProviderFamilyDetailShell,
  ProviderFamilyHeader,
  ProviderFamilyPlanModeSwitch,
} from "./ProviderFamilyModeHeader.js";
import { resolveStartPlanEntitlementSummary } from "./StartPlanCard.js";
import { useCodingPlanProducts } from "./useCodingPlanProducts.js";
import { useEnterpriseCodingPlanProducts } from "./useEnterpriseCodingPlanProducts.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import type { ProviderSettingsView } from "@zcode/services";
import type { SavePersonalModelDraftInput } from "@zcode/provider";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";

// 四个入口横幅的样式常量把渐变、圆角、hover 边框固化下来。
// 这些类名同时被企业档位解析函数复用，因此不能内联到 JSX：
// 一旦内联，售罄/高级档位的配色就会和标准档位漂移。
const START_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,var(--color-success)_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,var(--color-success)_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";
const PERSONAL_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,#4099ff_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,#4099ff_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";
const TEAM_PLAN_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,#0ea5e9_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,#0ea5e9_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";
const TEAM_PLAN_ADVANCED_ENTRY_BANNER_CLASS =
  "min-h-20 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle_at_14%_12%,color-mix(in_srgb,#14b8a6_24%,var(--color-background)_76%)_0%,color-mix(in_srgb,#14b8a6_10%,var(--color-surface)_90%)_64%,var(--color-surface)_300%)] p-4 text-left transition-colors hover:border-border-hover";

// 类型守卫：把 codingPlan 与 teamPlan 合并成「套餐类导航项」。
// 使用 type predicate 而不是 boolean，是为了让后续分支直接收窄联合类型，
// 避免在 JSX 里到处写 as。
function isPlanNavItem(
  item: ModelProviderNavItem | null,
): item is Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }> {
  return item?.type === "codingPlan" || item?.type === "teamPlan";
}

// 团队套餐必须有组织与项目两个身份，任一为空都视为「没有团队上下文」。
// trim 后判空而不是直接判 undefined：上游可能传来空串。
// 返回类型同时收窄出 organizationId/projectId 为非空 string，调用方无需再断言。
function hasTeamPlanContext(item: ModelProviderNavItem | null): item is Extract<
  ModelProviderNavItem,
  { type: "teamPlan" }
> & {
  organizationId: string;
  projectId: string;
} {
  return (
    item?.type === "teamPlan" &&
    (item.organizationId?.trim().length ?? 0) > 0 &&
    (item.projectId?.trim().length ?? 0) > 0
  );
}

// 把「导航项自带的展示状态」与「团队权益快照」合并成最终展示项。
// 整个函数是纯函数，便于对五种快照组合做单测，也避免在渲染期产生副作用。
// 状态优先级（从高到低）：
//   1) credential-unavailable 且快照不是 no_plan -> unavailable（保留真实原因）；
//   2) 无快照 + loading -> checking；无快照 + error -> unavailable；
//   3) 有快照且 loading 仍未订阅时判 checking，error 且未订阅时判 unavailable。
//   4) 有订阅 -> purchased；无订阅且明确 no_plan -> unavailable（区分过期/未分配）。
// 注意 checking 不是中性态：它会隐藏额度与登录动作，所以只能由「真的在请求」触发。
export function resolveTeamScopedPlanNavItem(
  item: Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }>,
  entitlement: ReturnType<typeof useUsageEntitlement>,
): Extract<ModelProviderNavItem, { type: "codingPlan" | "teamPlan" }> {
  if (item.type !== "teamPlan" || !hasTeamPlanContext(item)) {
    return item;
  }
  if (
    // 已知 Project Key 不可用时，快照里没有 no_plan 就不能把原因改写成「未分配」。
    // 这里清空 statusLabelId 与 quotaLimits，是为了让状态卡走通用的不可用文案，
    // 而不是继续展示上一次团队的额度数字。
    item.availabilityReason === "credential-unavailable" &&
    entitlement.snapshot?.unavailableReason !== "no_plan"
  ) {
    // 已知 Project Key 不可用时，后续 quota loading/error 不能把真实原因改写成
    // “正在检查”或“团队套餐未分配”。Provider 配置仍由 Settings View 独立展示。
    return {
      ...item,
      status: "unavailable" as const,
      statusLabelId: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  // 快照为空时的三种路径必须严格区分：loading / error / 两者皆无。
  // 「两者皆无」返回原项而不是 checking，因为此时根本没有请求在飞，
  // 把静态导航项标成 checking 会让 UI 永远转圈。
  const snapshot = entitlement.snapshot;
  if (!snapshot) {
    if (entitlement.loading) {
      return {
        ...item,
        // Team Plan 额度按组织 / 项目重新查询，切换团队时不能继续展示上一团队额度。
        status: "checking" as const,
        statusLabelId: undefined,
        availabilityReason: undefined,
        statusActive: false,
        quotaLimits: [],
      };
    }
    if (entitlement.error) {
      return {
        ...item,
        // 请求失败只证明权益状态未知，不能等价成服务端明确判定“团队套餐未分配”。
        status: "unavailable" as const,
        statusLabelId: undefined,
        availabilityReason: undefined,
        statusActive: false,
        quotaLimits: [],
      };
    }
    return item;
  }
  if (entitlement.loading && !snapshot.subscription) {
    return {
      ...item,
      status: "checking" as const,
      statusLabelId: undefined,
      availabilityReason: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  if (entitlement.error && !snapshot.subscription) {
    return {
      ...item,
      status: "unavailable" as const,
      statusLabelId: undefined,
      availabilityReason: undefined,
      statusActive: false,
      quotaLimits: [],
    };
  }
  // 订阅是否存在只由 details 长度决定，不看 status 字段：
  // status 可能因配额耗尽或结算延迟而滞后。
  // quotaLimits 无条件取自快照，即使没有订阅也保留空数组而不是 undefined，
  // 让状态卡的类型分支保持稳定。
  const hasTeamSubscription = Boolean(snapshot.subscription?.details.length);
  const noPlan = snapshot.unavailableReason === "no_plan";
  const expired = noPlan && snapshot.teamPlanUnavailableReason === "expired";
  return {
    ...item,
    // 权益只来自团队订阅查询；quota 查询失败不能撤销订阅，也不能被解释成未分配。
    status: hasTeamSubscription ? ("purchased" as const) : ("unavailable" as const),
    planLevel: item.teamPlanName?.trim() || item.planLevel,
    currentProductId: item.currentProductId,
    subscriptionBillingCycle: null,
    subscriptionRenewTime: null,
    subscriptionExpireTime: null,
    subscriptionDetails: [],
    quotaLimits: snapshot.quota?.limits ?? [],
    statusLabelId:
      !hasTeamSubscription && noPlan
        ? expired
          ? "settings.modelProvider.codingPlan.status.teamExpired"
          : "settings.modelProvider.codingPlan.status.teamUnavailable"
        : undefined,
    statusMessage: noPlan ? undefined : item.statusMessage,
    availabilityReason:
      !hasTeamSubscription && noPlan ? (expired ? "expired" : "not-allocated") : undefined,
    statusActive: hasTeamSubscription,
  };
}

// 构造团队套餐的「查看权益」上下文，供额度查询复用 Coding Plan 链路。
// 四个字段缺一即返回 undefined：少 organizationId 或 projectId 会让后端无法定位团队，
// 少 productId 会让价格与权益对不上。
// resolveTeamPlanInspectionAccess() 刻意不检查套餐可用性，失效套餐仍要查原因。
export function resolveTeamPlanInspectionAccess(
  item: Extract<ModelProviderNavItem, { type: "teamPlan" }>,
) {
  // 不可用套餐仍需查询失效原因；组织/项目身份来自团队导航，不能被执行可用性门禁清空。
  const family = resolveModelProviderFamilySpecByProviderId(item.presetId)?.id;
  const productId = item.currentProductId?.trim();
  const organizationId = item.organizationId?.trim();
  const projectId = item.projectId?.trim();
  if (!family || !productId || !organizationId || !projectId) return undefined;
  return {
    type: "zhipu-account" as const,
    family,
    planKind: "team-coding-plan" as const,
    productId,
    organizationId,
    projectId,
  };
}

// 从 Settings View 投影出当前 provider 的表单模型；拿不到时退回导航项自带快照。
// view 存在但找不到对应 provider 时返回 null 而不是 fallback：
// view 是权威快照，其中缺失就意味着该 provider 已被移除。
// fallback 只在 view 整体不可用（首屏未就绪）时兜底，避免首个请求返回前闪空。
export function resolvePlanSettingsProvider({
  view,
  providerId,
  fallback,
}: {
  view: ProviderSettingsView | null | undefined;
  providerId: string;
  fallback: ProviderSettingsFormProvider | null;
}): ProviderSettingsFormProvider | null {
  if (view) {
    return (
      projectProviderSettingsViewToFormProviders(view).find(
        (provider) => provider.providerId === providerId,
      ) ?? null
    );
  }
  return fallback?.providerId === providerId ? fallback : null;
}

// 详情面板入口。这里同时接受「全局 Settings View」与「覆盖值」两个来源，
// 覆盖值供测试和嵌入式宿主注入，优先级高于根 hook。
// 参数分为四组：导航数据、连接选择、六类异步状态、十二个动作回调。
// 所有异步状态都以「providerId === 当前项」的方式比较，
// 因此父组件可以在请求返回后无差别刷新，详情面板只认自己那一份。
export function ModelProviderSectionDetail({
  selectedNavItem,
  navigationItems = selectedNavItem ? [selectedNavItem] : [],
  connectionSettingsFailed = false,
  connectionSelections,
  startPlanSubscriptionCount = 0,
  presetLoading,
  codingPlanPurchaseTokenAuthenticatedByProviderId,
  codingPlanAuthError,
  presetSubscriptionProviderId,
  codingPlanStatusSyncProviderId,
  codingPlanDisconnectProviderId,
  onSave,
  onAddPersonalModel,
  onSavePersonalModelDraft,
  onSetPersonalModelEnabled,
  onDeletePersonalModel,
  onDelete,
  onReorderProviderModels,
  onTestModel,
  onCodingPlanLogin,
  onRetryCodingPlan,
  onCodingPlanDisconnect,
  onOpenApiKeyUrl,
  onOpenBigModelRegistration,
  onCodingPlanPurchaseComplete,
  onSelectNavItem,
  providerSettingsView: providerSettingsViewOverride,
}: {
  selectedNavItem: ModelProviderNavItem | null;
  navigationItems?: ModelProviderNavItem[];
  connectionSettingsFailed?: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  startPlanSubscriptionCount?: number;
  presetLoading: boolean;
  codingPlanPurchaseTokenAuthenticatedByProviderId: Partial<
    Record<BuiltinModelProviderId, boolean>
  >;
  codingPlanAuthError?: string | null;
  presetSubscriptionProviderId: BuiltinModelProviderId | null;
  codingPlanStatusSyncProviderId: BuiltinModelProviderId | null;
  codingPlanDisconnectProviderId: BuiltinModelProviderId | null;
  onSave: (config: ProviderSettingsFormProvider) => void | Promise<void>;
  onAddPersonalModel?: (
    providerId: string,
    modelId: string,
    config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onSavePersonalModelDraft?: (input: SavePersonalModelDraftInput) => Promise<unknown>;
  onSetPersonalModelEnabled?: (
    providerId: string,
    modelId: string,
    enabled: boolean,
  ) => Promise<unknown>;
  onDeletePersonalModel?: (providerId: string, modelId: string) => Promise<unknown>;
  onDelete: (provider: ProviderSettingsFormProvider) => Promise<void>;
  onReorderProviderModels?: (providerId: string, modelIds: string[]) => Promise<void>;
  onTestModel: (providerId: string, modelId: string) => Promise<ModelConnectivityResult>;
  onRetryCodingPlan?: () => void | Promise<void>;
  onCodingPlanLogin: (
    presetId: BuiltinModelProviderId,
    providerId: OAuthProviderId,
    providerName: string,
    status: CodingPlanStatus,
    options?: CodingPlanLoginOptions,
  ) => number | void;
  onCodingPlanDisconnect: (
    presetId: BuiltinModelProviderId,
    providerId: OAuthProviderId,
    providerName: string,
  ) => void;
  onOpenApiKeyUrl: (url: string) => void;
  onOpenBigModelRegistration: () => void;
  onCodingPlanPurchaseComplete: () => void | Promise<void>;
  onSelectNavItem?: (item: ModelProviderNavItem) => void;
  providerSettingsView?: ProviderSettingsView | null;
}) {
  const { intl } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  // 加载文案只解析一次，供所有加载卡复用；
  // 在 JSX 里重复 formatMessage 会增加每次渲染的格式化开销。
  const loadingLabel = intl.formatMessage({ id: "common.loading" });
  // 升级面板可见态存 providerId 而不是布尔值：
  // 布尔值在切换 provider 后会残留为真，导致新详情下方挂着一个旧面板。
  // 用 providerId 让「当前项」与「面板归属」天然对齐。
  const [upgradePlansVisibleProviderId, setUpgradePlansVisibleProviderId] =
    useState<BuiltinModelProviderId | null>(null);
  // 用导航项 key（含 providerId 与团队组织/项目）作为「选中身份」，
  // 而不是用对象引用：父组件每次刷新都会重建导航项对象，引用比较会误判为切换。
  const selectedItemKey = selectedNavItem?.key ?? null;
  // 根 hook 有三种状态：loading / error / ready。
  // 只有 ready 才把 view 传下去；loading 与 error 都按「view 不可用」处理，
  // 由各分支退回导航项自带快照，避免首屏把 provider 全部判成已删除。
  const rootProviderSettingsRead = useProviderSettingsView();
  const rootProviderSettingsView =
    rootProviderSettingsRead.state.status === "ready" ? rootProviderSettingsRead.state.view : null;
  // providerSettingsViewOverride 优先于根 view，是嵌入式宿主与测试的注入点。
  // 注意 ?? 不会把 null 覆盖成根值：显式传 null 表示「我确认没有 view」，
  // 这一点在测试「view 缺失时如何降级」时必须保留。
  const providerSettingsView = providerSettingsViewOverride ?? rootProviderSettingsView;
  // 账号分支曾漏传删除回调，出现只删 UI 不写盘。所有详情共用同一套模型操作装配。
  // 模型编辑回调五件套 + revision 一起下发给卡片。
  // 集中装配是刻意的：历史上账号分支漏传 onDeletePersonalModel，
  // 表现为「模型从列表消失但重启后又回来」。新增编辑动作时必须加在这里，
  // 而不是只接到某一个分支的 JSX 上。
  // settingsRevision 让卡片能判断草稿是否已过期。
  const modelEditingProps = {
    onAddPersonalModel,
    onSavePersonalModelDraft,
    onSetPersonalModelEnabled,
    onDeletePersonalModel,
    settingsRevision: providerSettingsView?.revision,
  };
  // selectedPlanAccess 把选中项翻译成额度查询所需的账户访问上下文。
  // 团队用组织/项目身份，个人用 Account 快照里的 start-plan / individual-coding-plan 模式。
  // 非套餐项返回 undefined，useUsageEntitlement 据此跳过请求。
  // access 模式不匹配时也返回 undefined：把其他模式传下去会让后端返回 403 而不是空列表。
  const selectedPlanAccess = useMemo(() => {
    if (!isPlanNavItem(selectedNavItem)) return undefined;
    if (selectedNavItem.type === "teamPlan")
      return resolveTeamPlanInspectionAccess(selectedNavItem);
    const access = resolveAccountProviderInspectionAccess(
      providerSettingsView,
      selectedNavItem.presetId,
    );
    if (
      !access ||
      (access.access.mode !== "start-plan" && access.access.mode !== "individual-coding-plan")
    )
      return undefined;
    return {
      type: "zhipu-account" as const,
      family: access.access.accountType,
      planKind: access.access.mode,
    };
  }, [providerSettingsView, selectedNavItem]);
  // 团队上下文只提取 trimmed 的组织/项目，作为 refresh 的依赖。
  // 依赖是整个对象而不是两个字符串：useMemo 会随选中项重建，但值相等时
  // 下游 effect 的比较仍然稳定，因为对象来自同一次 memo。
  const selectedTeamPlanContext = useMemo(
    () =>
      hasTeamPlanContext(selectedNavItem)
        ? {
            organizationId: selectedNavItem.organizationId.trim(),
            projectId: selectedNavItem.projectId.trim(),
          }
        : null,
    [selectedNavItem],
  );
  // 团队权益查询。四个开关需要一起理解：
  // allowDisabledPreferredProvider：已购 Team Plan 时个人 provider 可能被标 disabled，
  //   但团队额度仍要走同一条 Coding Plan quota 链路，不能在服务选择阶段被过滤；
  // allowEnvApiKey:false：环境变量 Key 不能代表团队授权；
  // requirePreferredProvider:true：没有目标 provider 就不要退化成任意可用 provider；
  // refreshOnMount:false：挂载时由下面那个 effect 显式刷新，避免切换团队时先发旧请求。
  // cacheKey 用导航项的 key（含组织/项目），保证不同团队不共享缓存。
  const selectedTeamPlanEntitlement = useUsageEntitlement({
    enabled: Boolean(selectedTeamPlanContext),
    includeSubscription: true,
    preferredProviderId:
      selectedNavItem?.type === "teamPlan" ? selectedNavItem.presetId : undefined,
    accountAccess: selectedPlanAccess,
    // 已购 Team Plan 时，个人 Coding Plan provider 可能因个人权益不可用被标记 disabled。
    // Team 额度查询仍复用 Coding Plan quota 链路，并追加组织 / 项目上下文，不能在服务选择阶段被过滤。
    allowDisabledPreferredProvider: selectedNavItem?.type === "teamPlan",
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: selectedNavItem?.key ?? undefined,
    refreshOnMount: false,
  });
  useEffect(() => {
    if (!selectedTeamPlanContext) {
      return;
    }
    // 挂载/切换团队时静默刷新（silent 不展示全局 loading）。
    // silent 是必要的：切换团队时展示 loading 会让整页状态卡闪烁，
    // 而 checking 态已经能表达「正在确认」。
    void selectedTeamPlanEntitlement.refresh({
      silent: true,
      reason: "access",
    });
  }, [selectedTeamPlanContext, selectedTeamPlanEntitlement.refresh]);
  // 只有套餐类导航项才做权益合并；预设与自定义供应商直接透传。
  // 合并结果可能把状态改成 unavailable，但不会改动 provider 配置本身。
  const effectiveSelectedPlanNavItem = isPlanNavItem(selectedNavItem)
    ? resolveTeamScopedPlanNavItem(selectedNavItem, selectedTeamPlanEntitlement)
    : null;
  // 模式切换器只由 family header 承载，且只在 familySpec 存在时挂上去。
  // 把它同时传给 preset 卡片会导致同一页出现两个切换入口。
  const planModeSwitch = (
    <ProviderFamilyPlanModeSwitch
      selectedNavItem={selectedNavItem}
      navigationItems={navigationItems}
      connectionSettingsFailed={connectionSettingsFailed}
      connectionSelections={connectionSelections}
      startPlanSubscriptionCount={startPlanSubscriptionCount}
      onSelectNavItem={onSelectNavItem}
    />
  );

  useEffect(() => {
    // 切换 provider 时收起升级面板。
    // 不收起会出现「A 的升级面板挂在 B 的详情下方」，
    // 因为面板可见态是 providerId 单值，而不是跟随选中项生命周期。
    setUpgradePlansVisibleProviderId(null);
  }, [selectedItemKey]);

  // 还没有选中项时渲染加载卡而不是空白：
  // 首屏导航是异步构建的，空白会被误读为「没有可用供应商」。
  if (!selectedNavItem) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  // 预置供应商分支。provider 为空有两种原因，必须区分：
  // 1) presetLoading：配置还在下载，展示 loading；
  // 2) 已加载完仍为空：展示「未同步」占位。
  // 把 1 当作 2 会让用户以为账号未登录，这是本文件里最容易复发的误判。
  // familySpec 存在时，模式切换由 family header 承担，卡片自身不再渲染 header。
  // readOnlyEndpoints + nameEditable=false 是预置语义的一部分：
  // 名称与 endpoint 由产品定义，改名会让侧栏与模型选择器不一致。
  if (selectedNavItem.type === "preset") {
    if (!selectedNavItem.provider) {
      // 首屏慢网时预置供应商配置尚未返回，之前这里会直接展示“尚未同步，请先完成 OAuth 登录”，
      // 用户会把“还在下载”误判成“当前账号未登录”。首刷期间改为明确显示 loading，等请求结束后再决定是否展示未同步占位。
      if (presetLoading) {
        return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
      }

      return <PresetProviderPlaceholderCard displayName={selectedNavItem.displayName} />;
    }

    // 预置供应商的卡片使用只读 endpoint、不可改名的配置。
    // headerVisible 由 familySpec 反向决定：有 family 时 header 已被外层 shell 接管。
    const presetProvider = selectedNavItem.provider;

    // family 规格决定「该 provider 是否支持多模式切换」。
    // 解析失败返回 undefined，此时 header 由卡片自己渲染，功能不缺失只是少了切换入口。
    const familySpec = resolveModelProviderFamilySpecByProviderId(selectedNavItem.presetId);
    // 预置分支的 header 复用 ProviderFamilyHeader，并附上模式切换。
    // familySpec 缺失时不传 trailingAction，header 只剩标题与状态，功能降级但不崩。
    const presetFamilyHeader = (
      <ProviderFamilyHeader
        selectedNavItem={selectedNavItem}
        trailingAction={familySpec ? planModeSwitch : undefined}
      />
    );
    return (
      <ProviderFamilyDetailShell header={presetFamilyHeader}>
        <InlineEditableProviderCard
          provider={presetProvider}
          onSave={onSave}
          {...modelEditingProps}
          onReorderModelIds={
            onReorderProviderModels
              ? (modelIds) => onReorderProviderModels(presetProvider.providerId, modelIds)
              : undefined
          }
          onTestModel={onTestModel}
          readOnlyEndpoints
          // 预置供应商名称承载固定 API Key 入口语义，
          // 允许重命名会让侧边栏和模型选择器展示含义不一致，因此只允许自定义供应商改名。
          nameEditable={false}
          headerVisible={!familySpec}
          headerActionsVisible={familySpec ? false : undefined}
        />
      </ProviderFamilyDetailShell>
    );
  }

  // 套餐分支。注意这里重新声明了同名局部变量 selectedNavItem，
  // 之后所有读取都用合并后的展示项，这是刻意的遮蔽而不是笔误。
  // dedicatedProvider 为 null 表示 Settings View 里没有该 provider 的配置，
  // 此时仍要渲染状态卡（用户至少能看到为什么没有配置）。
  if (effectiveSelectedPlanNavItem) {
    const selectedNavItem = effectiveSelectedPlanNavItem;
    // 专属 provider 优先从 Settings View 投影，缺失时退回导航项快照。
    // 两者都缺失时返回 null，分支会落到「只渲染状态卡」的兜底路径。
    const dedicatedProvider = resolvePlanSettingsProvider({
      view: providerSettingsView,
      providerId: selectedNavItem.presetId,
      fallback: selectedNavItem.provider,
    });
    // 购买/支付接口仍然依赖 OAuth 业务 token。
    // 这里与卡片登录态分开传递，避免 Provider API Key 点亮状态后误判购买 token 可用。
    // 购买 token 只认严格 === true：undefined 与 false 都必须按未认证处理。
    // 用 Boolean() 会把字符串 "false" 判成真，这是历史上出现过的坑。
    const codingPlanPurchaseTokenAuthenticated =
      codingPlanPurchaseTokenAuthenticatedByProviderId[selectedNavItem.presetId] === true;
    // 三个 pending 标记统一用 presetId 比较，
    // 这样父组件可以并行发起多个 provider 的操作而不会互相遮挡 loading。
    // 任何一处改成布尔 props，都会让 A 的登录把 B 的按钮也置灰。
    const codingPlanLoginPending = presetSubscriptionProviderId === selectedNavItem.presetId;
    const codingPlanStatusSyncPending = codingPlanStatusSyncProviderId === selectedNavItem.presetId;
    const codingPlanDisconnectPending = codingPlanDisconnectProviderId === selectedNavItem.presetId;
    const hasResolvedEntitlementStatus =
      selectedNavItem.status === "purchased" || selectedNavItem.status === "notPurchased";
    // 状态卡的显示态优先级：
    //   断开中 / （同步中且尚无已解析状态）-> 全部 checking；
    //   否则交给 resolveCodingPlanStatusPanelViewState 按 status + loginPending 推导。
    // 为什么同步中仍要区分 hasResolvedEntitlementStatus：
    // 已购买用户刷新状态时继续展示 purchased，不会闪成 checking。
    // loginLoading 只在 statusSyncPending 时为真，避免断开过程中显示登录转圈。
    const statusPanelViewState =
      codingPlanDisconnectPending || (codingPlanStatusSyncPending && !hasResolvedEntitlementStatus)
        ? {
            // 登录/登出后的 provider key 与权益刷新是异步链路。
            // 刷新落定前继续展示旧的未连接/已连接状态会让用户误以为操作失败。
            displayStatus: "checking" as const,
            actionStatus: "checking" as const,
            balanceStatus: "checking" as const,
            loginLoading: codingPlanStatusSyncPending,
          }
        : resolveCodingPlanStatusPanelViewState({
            status: selectedNavItem.status,
            loginPending: codingPlanLoginPending || codingPlanStatusSyncPending,
          });
    // checking 态必须隐藏具体状态标签。
    // 继续显示「未分配」或「已过期」会让用户把「正在确认」读成最终结论。
    const visibleStatusLabelId =
      statusPanelViewState.displayStatus === "checking" ? undefined : selectedNavItem.statusLabelId;
    // Start Plan 在多处需要特判：无权益判定、升级入口、访问横幅、专属详情可见性。
    // 集中成一个布尔量而不是散落调用，保证四处判断不会漂移。
    const isStartPlanProvider = isStartPlanModelProviderId(selectedNavItem.presetId);
    // 明确无权益时隐藏配置入口，但查询/取 Key 失败不能推断无权益，也不删除配置。
    // 「明确无权益」的判定：Start Plan 除外（它免费，不存在未购买），
    // 团队看 not-allocated / expired，个人看 notPurchased。
    // 只有明确无权益才允许隐藏配置区；credential-unavailable 不在此列。
    const hasNoPlanEntitlement =
      !isStartPlanProvider &&
      (selectedNavItem.type === "teamPlan"
        ? selectedNavItem.availabilityReason === "not-allocated" ||
          selectedNavItem.availabilityReason === "expired"
        : selectedNavItem.status === "notPurchased");
    // Start 已由 Account 快照确认可用时，额度查询清空/刷新自己的缓存不能卸载编辑器。
    // 未取得套餐时不展示可执行模型；配置区不依赖额度请求的临时 loading 状态。
    // Account 快照的 availability 是「账号是否已绑定可用凭据」的权威来源。
    // 这里的 optional chaining 兜底成 undefined，等价于「未知」，
    // 与「不可用」区分开：未知时由 status==="purchased" 走另一条放行条件。
    const accountAvailable =
      providerSettingsView?.providers.find(
        (provider) => provider.providerId === selectedNavItem.presetId,
      )?.accountState?.availability === "available";
    // 隐藏配置区的三个条件：明确无权益、已断开、未购买。
    // 不要把 checking 加进来：加载中隐藏会让布局在请求返回后整体跳动。
    const hidePlanModels =
      hasNoPlanEntitlement ||
      selectedNavItem.status === "disconnected" ||
      selectedNavItem.status === "notPurchased";
    // 是否需要渲染带状态卡的完整详情。四个条件缺一不可：
    // provider 存在、未被隐藏、Start Plan 需要 Account 明确可用或已购买。
    // 第三个条件存在的理由：Start 的额度查询会清空自己的缓存，
    // 但 Account 快照已确认可用，此时不能因为额度临时为空就卸载编辑器。
    const shouldShowDedicatedProviderDetail =
      dedicatedProvider !== null &&
      !hidePlanModels &&
      (!isStartPlanProvider || accountAvailable || selectedNavItem.status === "purchased");
    // 个人 Coding Plan 凭据失败时，把「重试」升级成「重新登录」。
    // 只对 individual-coding-plan 生效：团队凭据失败要走团队刷新链路，
    // 直接弹 OAuth 会丢失组织/项目上下文。
    const reloginOnFailure =
      selectedNavItem.type === "codingPlan" &&
      isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
      selectedNavItem.provider?.accountState?.unavailableReason === "credential-failed";
    // 团队查询/取 Key 失败不是未登录：先刷新 Host 凭据，再刷新当前团队权益。
    // 团队重试是两步：先刷新 Host 凭据，再强制刷新当前团队权益。
    // 排除 not-allocated / expired：这两种是确定性结论，重试没有意义。
    // 两步必须串行，先刷权益会因为凭据仍旧失效而再次失败。
    const retryTeamPlan =
      selectedNavItem.type === "teamPlan" &&
      selectedNavItem.status === "unavailable" &&
      selectedNavItem.availabilityReason !== "not-allocated" &&
      selectedNavItem.availabilityReason !== "expired" &&
      onRetryCodingPlan
        ? async () => {
            await onRetryCodingPlan();
            await selectedTeamPlanEntitlement.refresh({ force: true, reason: "manual" });
          }
        : undefined;
    // Start Plan 与团队确定不可用（未分配/过期）时不展示访问横幅：
    // 状态卡本身已经给出原因，重复提示只会增加噪音。
    // 其余情况交给 resolveCodingPlanAccessBanner 按显示态决定。
    const accessBanner =
      isStartPlanProvider ||
      (selectedNavItem.type === "teamPlan" &&
        (selectedNavItem.availabilityReason === "not-allocated" ||
          selectedNavItem.availabilityReason === "expired"))
        ? null
        : resolveCodingPlanAccessBanner(statusPanelViewState.displayStatus, intl, reloginOnFailure);
    // 升级面板可见性绑定到具体 providerId，切换 provider 时自动为假。
    // 这是本地 UI 态，不进 store：升级面板是模态流程，不需要跨窗口同步。
    const upgradePlansVisible = upgradePlansVisibleProviderId === selectedNavItem.presetId;
    // 只允许当前 provider 打开面板：visible 为真时写入自己的 presetId，
    // 为假时无论归属都清空（面板关闭事件可能来自任何来源）。
    const handleUpgradePlansVisibleChange = (visible: boolean) => {
      setUpgradePlansVisibleProviderId(visible ? selectedNavItem.presetId : null);
    };
    // 购买入口只在 notPurchased 且计费 provider 已知时出现。
    // BigModel 额外要求 purchase token 已认证：它的商品目录需要业务 token 才能取价。
    // Z.ai 不要求 token 是因为其商品目录为纯静态。
    const purchaseChoiceBannersVisible =
      statusPanelViewState.displayStatus === "notPurchased" &&
      (selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID ||
        (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID &&
          codingPlanPurchaseTokenAuthenticated));
    // 未登录时也要展示购买入口：用户需要在没有 OAuth 身份时先看到价格，
    // 点击后再走登录。条件是 disconnected 且计费 provider 属于已知集合。
    const anonymousPurchaseChoiceBannersVisible =
      (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
        selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
      statusPanelViewState.displayStatus === "disconnected";
    // 购买入口点击：未登录先登录，已登录才开购买面板。
    // 顺序不能反：直接开面板会绕过账号态，后端只会回 oauth_required。
    // funnelContext 同时记录来源区域、入口文案与套餐档位，
    // eventText 允许调用方覆盖（企业档位横幅需要带档位名）。
    const handlePurchaseChoiceSelect = (
      audience: PurchaseAudience,
      options: { initialTeamPlanKey?: string; eventText?: string } = {},
    ) => {
      if (resolvePurchaseChoiceSelectionIntent(statusPanelViewState.displayStatus) === "login") {
        // 未登录时个人/团队套餐必须先建立对应 provider 的 OAuth 身份。
        // 直接打开购买面板会绕过账号态，导致后续价格/订单接口只能再报 oauth_required。
        onCodingPlanLogin(
          selectedNavItem.presetId,
          selectedNavItem.oauthProviderId,
          selectedNavItem.providerName,
          selectedNavItem.status,
        );
        return;
      }
      const nextFunnelContext = createCodingPlanFunnelContext({
        providerId: selectedNavItem.presetId,
        upgradeSource:
          audience === "team" ? "setting_team_plan_banner" : "setting_personal_plan_banner",
        eventRegion: "app.setting",
        eventText:
          options.eventText ??
          intl.formatMessage({
            id:
              audience === "team"
                ? "settings.modelProvider.codingPlan.purchaseBanner.teamTitle"
                : "settings.modelProvider.codingPlan.purchaseBanner.personalTitle",
          }),
        entryPlanState: resolveCodingPlanEntryPlanState({
          displayStatus: statusPanelViewState.displayStatus,
          providerId: selectedNavItem.presetId,
          planLevel: selectedNavItem.planLevel,
        }),
        purchaseAudience: audience,
      });
      openCodingPlanUpgrade({
        providerId: selectedNavItem.presetId,
        initialAudience: audience,
        initialTeamPlanKey: options.initialTeamPlanKey,
        funnelContext: nextFunnelContext,
      });
    };
    // 套餐分支的 header 无条件挂模式切换：套餐类导航项都属于某个 family，
    // 这里不需要 familySpec 判断。
    const codingPlanFamilyHeader = (
      <ProviderFamilyHeader selectedNavItem={selectedNavItem} trailingAction={planModeSwitch} />
    );
    // 团队导航在 pricing 返回历史 subscribed 时也可能标为 purchased。购买/升级入口
    // 只读取 Account owner 已确认的权益，不能把商品目录的展示状态当成当前权益。
    // 判断「当前账号在同一 OAuth provider 下是否已有生效的付费套餐」。
    // 必须同时满足三项：导航项是套餐类、oauthProvider 相同、Settings View 里
    // accountState.availability 为 available 且 entitled 为真。
    // 只读导航项的 purchased 会把商品目录的历史订阅当成当前权益，
    // 结果是已过期用户看不到升级入口。
    const hasActivePaidPlan = navigationItems.some(
      (item) =>
        (item.type === "teamPlan" ||
          (item.type === "codingPlan" && isIndividualCodingPlanModelProviderId(item.presetId))) &&
        item.oauthProviderId === selectedNavItem.oauthProviderId &&
        providerSettingsView?.providers.some(
          (provider) =>
            provider.providerId === item.presetId &&
            provider.accountState?.availability === "available" &&
            provider.accountState.entitled,
        ),
    );
    // 状态卡下方的补充内容，三者互斥且有优先级：
    // planSupplementalContent 优先级为购买横幅高于访问横幅，两者都无则为空。
    // Start 且已有生效付费套餐时不展示任何购买入口，避免重复推销。
    // 三元表达式的缩进刻意保持原样，改动会同时影响两个分支的可读性。
    const planSupplementalContent =
      isStartPlanProvider && hasActivePaidPlan ? null : anonymousPurchaseChoiceBannersVisible ||
        purchaseChoiceBannersVisible ? (
        <CodingPlanPurchaseChoiceBanners
          providerId={selectedNavItem.presetId}
          soldOutVisible={codingPlanPurchaseTokenAuthenticated}
          accountDisconnected={statusPanelViewState.displayStatus === "disconnected"}
          onSelect={handlePurchaseChoiceSelect}
          teamVisible={selectedNavItem.oauthProviderId !== ZAI_PROVIDER_ID}
        />
      ) : accessBanner ? (
        <CodingPlanAccessBanner title={accessBanner.title} description={accessBanner.description} />
      ) : null;

    // 完整详情分支：状态卡作为卡片的 statusSection 嵌入，而不是并列渲染。
    // 嵌入后卡片仍负责模型列表与保存动作，状态卡只负责权益展示。
    // 登录动作固定放在 trailing：未登录时右侧只渲染 Plan Card，
    // 不再回退到 API Key 表单，登录入口必须留在卡片本体上。
    if (shouldShowDedicatedProviderDetail && dedicatedProvider) {
      // 完整详情里的状态卡实例。几个易错点：
      // quotaResetSourceKey：团队用导航项 key，个人用 presetId，否则重置后缓存键不一致；
      // onQuotaResetEntitlementRefresh：团队走 team entitlement 的强制刷新，
      //   个人走 onCodingPlanPurchaseComplete，两条链路不能互换；
      // onDisconnect 只有在 oauthProvider 是 BigModel/Z.ai 且 provider 匹配时才提供，
      //   其他 provider 没有可撤销的 OAuth 授权；
      // onLogin 在升级面板展开时强制传 unavailable，让「重新链接」走真正的重新登录。
      const statusPanel = (
        <CodingPlanStatusPanel
          providerId={selectedNavItem.presetId}
          providerName={selectedNavItem.providerName}
          status={selectedNavItem.status}
          viewState={statusPanelViewState}
          planLevel={selectedNavItem.planLevel}
          subscriptionRenewTime={selectedNavItem.subscriptionRenewTime}
          subscriptionExpireTime={selectedNavItem.subscriptionExpireTime}
          subscriptionDetails={selectedNavItem.subscriptionDetails}
          quotaLimits={selectedNavItem.quotaLimits}
          mcpQuotaLimit={selectedNavItem.mcpQuotaLimit ?? null}
          authError={codingPlanAuthError}
          onOpenRegistration={onOpenBigModelRegistration}
          purchaseUrl={selectedNavItem.purchaseUrl}
          inactivePlanTitle={selectedNavItem.inactivePlanTitle}
          statusLabelId={visibleStatusLabelId}
          statusMessage={selectedNavItem.statusMessage}
          teamPlanAvailabilityReason={
            selectedNavItem.type === "teamPlan" ? selectedNavItem.availabilityReason : undefined
          }
          // 额度重置后的缓存键必须与查询时的缓存键一致：
          // 团队用导航项 key（含组织/项目），个人用 presetId。
          // quotaResetSourceKey 必须与查询缓存键一致，否则重置成功后仍显示旧额度。
          quotaResetSourceKey={
            selectedNavItem.type === "teamPlan" ? selectedNavItem.key : selectedNavItem.presetId
          }
          quotaResetAccountAccess={selectedPlanAccess}
          onQuotaResetEntitlementRefresh={
            selectedNavItem.type === "teamPlan"
              ? () =>
                  selectedTeamPlanEntitlement.refresh({
                    force: true,
                    reason: "manual",
                  })
              : onCodingPlanPurchaseComplete
          }
          onOpenPurchase={onOpenApiKeyUrl}
          onDisconnect={
            (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
              selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
            dedicatedProvider.providerId === selectedNavItem.presetId
              ? () => {
                  onCodingPlanDisconnect(
                    selectedNavItem.presetId,
                    selectedNavItem.oauthProviderId,
                    selectedNavItem.providerName,
                  );
                }
              : undefined
          }
          disconnectLoading={codingPlanDisconnectProviderId === selectedNavItem.presetId}
          // Plan Card 在未登录/登录失效时仍然是用户当前选中的入口。
          // 之前详情页没有打开状态卡内置登录动作，导致用户能进入 Coding tab 却只能看到“未连接”文案。
          loginActionVisible
          loginActionPlacement="trailing"
          reloginOnFailure={!upgradePlansVisible && reloginOnFailure}
          onRetry={
            retryTeamPlan ??
            (!upgradePlansVisible &&
            selectedNavItem.type === "codingPlan" &&
            !selectedNavItem.accountLoginRequired &&
            (selectedNavItem.status === "unavailable" ||
              selectedNavItem.statusLabelId ===
                "settings.modelProvider.codingPlan.status.unavailable" ||
              (isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
                selectedNavItem.provider?.accountState?.unavailableReason === "credential-failed"))
              ? onRetryCodingPlan
              : undefined)
          }
          onLogin={(options) => {
            return onCodingPlanLogin(
              selectedNavItem.presetId,
              selectedNavItem.oauthProviderId,
              selectedNavItem.providerName,
              // 查看套餐接口要求业务 OAuth 仍有效；已购买状态下的“重新链接”不能只静默刷新 key，
              // 否则 OAuth 过期时点击没有可见反馈。升级态的重连强制走重新登录路径。
              upgradePlansVisible ? "unavailable" : selectedNavItem.status,
              options,
            );
          }}
          onOpenUpgradePlans={(options) => {
            openCodingPlanUpgrade({
              providerId: selectedNavItem.presetId,
              initialAudience: options.initialAudience,
              funnelContext: options.funnelContext ?? undefined,
            });
          }}
          upgradePlansVisible={upgradePlansVisible}
          onUpgradePlansVisibleChange={handleUpgradePlansVisibleChange}
          purchaseInitialAudience={selectedNavItem.type === "teamPlan" ? "team" : "personal"}
          // 升级入口在「非 Start」或「Start 且无生效付费套餐」时可见。
          // Start 用户已有付费套餐时隐藏升级，避免重复引导。
          upgradeActionVisible={!isStartPlanProvider || !hasActivePaidPlan}
          startPlanPreviewVisible={false}
        />
      );

      return (
        <ProviderFamilyDetailShell header={codingPlanFamilyHeader}>
          <InlineEditableProviderCard
            provider={dedicatedProvider}
            onSave={onSave}
            {...modelEditingProps}
            onReorderModelIds={
              onReorderProviderModels
                ? (modelIds) => onReorderProviderModels(dedicatedProvider.providerId, modelIds)
                : undefined
            }
            onTestModel={onTestModel}
            nameEditable={false}
            statusSection={
              <div className="space-y-3">
                {statusPanel}
                {planSupplementalContent}
              </div>
            }
            headerActionsVisible={false}
          />
        </ProviderFamilyDetailShell>
      );
    }

    return (
      <ProviderFamilyDetailShell header={codingPlanFamilyHeader}>
        <div className="space-y-3">
          <CodingPlanStatusPanel
            providerId={selectedNavItem.presetId}
            providerName={selectedNavItem.providerName}
            status={selectedNavItem.status}
            viewState={statusPanelViewState}
            // 未登录状态下右侧只渲染 Plan Card，不再回退到 API Key 表单。
            // 因此登录入口必须留在 Plan Card 本身，否则用户进入 Coding tab 后没有下一步动作。
            loginActionVisible
            loginActionPlacement="trailing"
            purchaseUrl={selectedNavItem.purchaseUrl}
            planLevel={selectedNavItem.planLevel}
            inactivePlanTitle={selectedNavItem.inactivePlanTitle}
            statusLabelId={visibleStatusLabelId}
            statusMessage={selectedNavItem.statusMessage}
            teamPlanAvailabilityReason={
              selectedNavItem.type === "teamPlan" ? selectedNavItem.availabilityReason : undefined
            }
            quotaResetSourceKey={
              selectedNavItem.type === "teamPlan" ? selectedNavItem.key : selectedNavItem.presetId
            }
            quotaResetAccountAccess={selectedPlanAccess}
            onQuotaResetEntitlementRefresh={
              selectedNavItem.type === "teamPlan"
                ? () =>
                    selectedTeamPlanEntitlement.refresh({
                      force: true,
                      reason: "manual",
                    })
                : onCodingPlanPurchaseComplete
            }
            subscriptionRenewTime={selectedNavItem.subscriptionRenewTime}
            subscriptionExpireTime={selectedNavItem.subscriptionExpireTime}
            subscriptionDetails={selectedNavItem.subscriptionDetails}
            quotaLimits={selectedNavItem.quotaLimits}
            mcpQuotaLimit={selectedNavItem.mcpQuotaLimit ?? null}
            authError={codingPlanAuthError}
            onOpenRegistration={onOpenBigModelRegistration}
            onLogin={(options) => {
              return onCodingPlanLogin(
                selectedNavItem.presetId,
                selectedNavItem.oauthProviderId,
                selectedNavItem.providerName,
                selectedNavItem.status,
                options,
              );
            }}
            reloginOnFailure={!upgradePlansVisible && reloginOnFailure}
            onRetry={
              retryTeamPlan ??
              (!upgradePlansVisible &&
              selectedNavItem.type === "codingPlan" &&
              !selectedNavItem.accountLoginRequired &&
              (selectedNavItem.status === "unavailable" ||
                selectedNavItem.statusLabelId ===
                  "settings.modelProvider.codingPlan.status.unavailable" ||
                (isIndividualCodingPlanModelProviderId(selectedNavItem.presetId) &&
                  selectedNavItem.provider?.accountState?.unavailableReason ===
                    "credential-failed"))
                ? onRetryCodingPlan
                : undefined)
            }
            onOpenPurchase={onOpenApiKeyUrl}
            onDisconnect={
              (selectedNavItem.oauthProviderId === BIGMODEL_PROVIDER_ID ||
                selectedNavItem.oauthProviderId === ZAI_PROVIDER_ID) &&
              selectedNavItem.provider?.providerId === selectedNavItem.presetId &&
              selectedNavItem.status !== "disconnected"
                ? () => {
                    onCodingPlanDisconnect(
                      selectedNavItem.presetId,
                      selectedNavItem.oauthProviderId,
                      selectedNavItem.providerName,
                    );
                  }
                : undefined
            }
            disconnectLoading={codingPlanDisconnectProviderId === selectedNavItem.presetId}
            onOpenUpgradePlans={(options) => {
              openCodingPlanUpgrade({
                providerId: selectedNavItem.presetId,
                initialAudience: options.initialAudience,
                funnelContext: options.funnelContext ?? undefined,
              });
            }}
            upgradePlansVisible={upgradePlansVisible}
            onUpgradePlansVisibleChange={handleUpgradePlansVisibleChange}
            purchaseInitialAudience={selectedNavItem.type === "teamPlan" ? "team" : "personal"}
            upgradeActionVisible={!isStartPlanProvider || !hasActivePaidPlan}
            startPlanPreviewVisible={false}
          />
          {hidePlanModels ? null : providerSettingsView && !dedicatedProvider ? (
            <PresetProviderPlaceholderCard
              displayName={selectedNavItem.providerName}
              messageId="settings.modelProvider.accountProviderConfigMissing"
            />
          ) : !selectedNavItem.provider ||
            selectedNavItem.provider.providerId !== selectedNavItem.presetId ? (
            <ModelProviderLoadingCard loadingLabel={loadingLabel} />
          ) : null}
          {planSupplementalContent}
        </div>
      </ProviderFamilyDetailShell>
    );
  }

  // 导航占位项没有详情内容。返回 null 而不是占位卡，
  // 因为占位卡会和真实加载卡在视觉上混淆。
  if (selectedNavItem.type === "codingPlanLoading") {
    // Z.AI plan 判定占位只属于左侧导航，不应进入详情表单渲染路径。
    return null;
  }

  // 自定义供应商分支：provider 缺失时只能显示加载卡。
  // 这与预置分支不同 —— 预置有「未同步」占位，自定义没有远程同步概念，
  // 缺失只可能是首屏快照尚未就绪。
  if (!selectedNavItem.provider) {
    return <ModelProviderLoadingCard loadingLabel={loadingLabel} />;
  }

  // 自定义供应商允许改名与自定义 endpoint，因此 nameEditable 为真、
  // readOnlyEndpoints 为假；删除入口也只在这个分支提供。
  // presetApiKeyUrl 只在模板声明时传入，未声明时按钮隐藏但保存不受影响。
  const customProvider = selectedNavItem.provider;
  // 自定义供应商只有在模板声明了 Key 控制台地址时才展示入口。
  // 不根据 endpoint 猜测 URL：猜测出来的地址经常 404 或指向错误租户。
  // 模板缺失时返回 undefined，按钮隐藏但表单可用。
  const customApiKeyUrl = customProvider.templateId
    ? getProviderFormApiKeyManagementUrl(customProvider)
    : undefined;
  return (
    // 仅展示预设模板声明的入口，不根据地址猜测自定义 Provider 的 Key 控制台。
    <InlineEditableProviderCard
      provider={customProvider}
      onSave={onSave}
      {...modelEditingProps}
      onDelete={() => onDelete(customProvider)}
      onReorderModelIds={
        onReorderProviderModels
          ? (modelIds) => onReorderProviderModels(customProvider.providerId, modelIds)
          : undefined
      }
      onTestModel={onTestModel}
      presetApiKeyUrl={customApiKeyUrl}
      readOnlyEndpoints={false}
      nameEditable
      onOpenPresetApiKey={
        customApiKeyUrl
          ? () => {
              onOpenApiKeyUrl(customApiKeyUrl);
            }
          : undefined
      }
    />
  );
}

// 唯一一处把「status=disconnected」翻译成「需要登录」的规则。
// 抽成导出函数是为了让购买入口与测试共享同一判据，
// 避免两处各写一个 === 判断后逐渐漂移。
export function resolvePurchaseChoiceSelectionIntent(
  status: CodingPlanStatus,
): "login" | "purchase" {
  return status === "disconnected" ? "login" : "purchase";
}

// 三档购买入口横幅（Start / 个人 / 团队）。
// Start 只作为免费入口出现，且只在远端 preview 存在时渲染；
// 个人与团队入口是否可见由价格解析结果决定，解析不出 price 就不渲染。
// 入口误导成本高于少一个入口，所以不放价格加载中的 skeleton 占位。
function CodingPlanPurchaseChoiceBanners({
  providerId,
  startPlanPreview = null,
  personalVisible = true,
  teamVisible = true,
  soldOutVisible = false,
  accountDisconnected = false,
  onSelect,
  onSelectStartPlan,
}: {
  providerId: CodingPlanProviderId;
  startPlanPreview?: StartPlanPreviewConfig | null;
  personalVisible?: boolean;
  teamVisible?: boolean;
  soldOutVisible?: boolean;
  accountDisconnected?: boolean;
  onSelect: (
    audience: PurchaseAudience,
    options?: { initialTeamPlanKey?: string; eventText?: string },
  ) => void;
  onSelectStartPlan?: () => void;
}) {
  // entryGate 控制能否进入购买流，非 ready 时点击只触发 retry。
  // loading 时禁用非 Start 入口；非 ready 时点击只触发 retry，不打开面板，
  // 避免在半初始化状态下创建订单。
  const entryGate = useCodingPlanEntryGate();
  const { intl, locale } = useZCodeIntl();
  // Start 预览摘要只在远端 preview 存在时解析，
  // 否则返回 null，横幅列表里对应项会被跳过（不是渲染空价格）。
  const startPlanSummary = startPlanPreview
    ? resolveStartPlanEntitlementSummary(startPlanPreview, intl, locale)
    : null;
  // Start Plan 只是免费入口，入口价格必须读取对应付费 Coding Plan 的商品源；
  // 否则这里拿到免费 SKU/空列表后会隐藏对应付费 Coding Plan 的起售价。
  // Start Plan 的商品源必须映射到对应的付费 Coding Plan：
  // Start 自己的 SKU 是免费的，直接用它取价会得到空列表，
  // 从而把付费套餐的起售价整块隐藏。
  const pricingProviderId = resolvePurchaseChoiceBannerProductsProviderId(providerId);
  // 这里只取静态商品目录：入口横幅的价格不应触发远端拉取，
  // 否则首屏会多一次网络请求并可能让价格闪烁。
  const staticProducts = useCodingPlanProducts(pricingProviderId, {
    remotePreviewEnabled: false,
  });
  // 团队目录在未登录时也要读静态数据；售罄可见性只是「是否请求远端」的开关，
  // 不能同时充当目录加载开关。
  // staticOnly 与 authenticated 互斥地表达了这个区别。
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    // 未登录也必须读取静态团队目录；售罄可见性不能充当目录加载开关。
    enabled:
      teamVisible && pricingProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    authenticated: soldOutVisible,
    staticOnly: !soldOutVisible,
  });
  // 个人入口价格来自个人套餐目录，售罄标记由 soldOutVisible 控制。
  // 这里不做 try/catch：解析函数是纯函数，异常意味着数据契约被破坏，
  // 应该在测试里暴露而不是在生产里吞掉。
  const personalPrice = resolvePurchaseChoiceBannerPrice({
    providerId: pricingProviderId,
    audience: "personal",
    products: staticProducts.snapshot?.productList ?? [],
    soldOutVisible,
  });
  // 团队入口只展示一个横幅，价格来自已配置商品的最低价，不按档位拆成多个入口。
  // 团队价格只在企业快照成功时计算；快照报错时传空数组而不是保留旧快照，
  // 避免展示过期价格。staticProductIds 过滤保证只统计静态目录内的商品。
  const teamPrice = resolveEnterprisePurchaseChoiceBannerPrice({
    key: "team",
    title: "",
    products: enterpriseProducts.error
      ? []
      : (enterpriseProducts.snapshot?.productList ?? []).filter((product) =>
          enterpriseProducts.snapshot?.staticProductIds?.includes(product.productId),
        ),
  });
  // Start 标题优先用远端名，回落本地文案。
  // resolveStartPlanPurchaseChoiceBannerTitle() 单独抽出：中文替换远端英文名，英文保留。
  const startPlanTitle = resolveStartPlanPurchaseChoiceBannerTitle({
    fallbackTitle: intl.formatMessage({
      id: "settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle",
    }),
    locale,
    remoteTitle: startPlanPreview?.name,
  });
  // 三个横幅按固定顺序拼装：Start、个人、团队。
  // 顺序影响用户的第一印象，也影响键盘 Tab 焦点顺序，不能按数据到达顺序渲染。
  // 每个条目都自带 className 与 Icon，避免在 JSX 里写三段条件类名。
  // 团队横幅始终只出现一个，价格取已配置商品的最低价。
  const bannerItems = [
    ...(startPlanPreview && startPlanSummary
      ? [
          {
            key: "startPlan" as const,
            label: startPlanTitle,
            description: startPlanSummary.detailsDescription,
            metric: startPlanSummary.grantUnitsLabel,
            metricUnit: startPlanSummary.unitLabel,
            priceState: null,
            className: START_PLAN_ENTRY_BANNER_CLASS,
            Icon: AstroidIcon,
            iconClassName: "text-success",
            onClick: onSelectStartPlan,
          },
        ]
      : []),
    ...(personalVisible && personalPrice !== null
      ? [
          {
            key: "personal" as const,
            label: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.personalTitle",
            }),
            description: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.personalDescription",
            }),
            metric: null,
            metricUnit: null,
            priceState: personalPrice,
            className: PERSONAL_PLAN_ENTRY_BANNER_CLASS,
            Icon: AstroidIcon,
            iconClassName: "text-[#4099ff]",
            onClick: () => onSelect("personal"),
          },
        ]
      : []),
    // 历史订阅记录不决定购买入口可见性；团队 banner 沿用静态目录价格。
    ...(teamVisible && teamPrice !== null
      ? [
          {
            key: "team" as const,
            label: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.teamTitle",
            }),
            description: intl.formatMessage({
              id: "settings.modelProvider.codingPlan.purchaseBanner.teamDescription",
            }),
            metric: null,
            metricUnit: null,
            priceState: teamPrice,
            className: TEAM_PLAN_ENTRY_BANNER_CLASS,
            Icon: UsersIcon,
            iconClassName: "text-warning",
            onClick: () => onSelect("team"),
          },
        ]
      : []),
  ];
  return (
    <div className="space-y-3">
      {bannerItems.map((item) => (
        <button
          // 用语义 key（startPlan/personal/team）而不是数组下标：
          // 价格变化导致条目增减时，下标 key 会让 React 复用错误的按钮状态（焦点、按下态）。
          key={item.key}
          type="button"
          className={item.className}
          disabled={
            !accountDisconnected && item.key !== "startPlan" && entryGate.status === "loading"
          }
          onClick={() => {
            if (!accountDisconnected && item.key !== "startPlan" && entryGate.status !== "ready") {
              entryGate.retry?.();
              return;
            }
            item.onClick?.();
          }}
        >
          <span className="flex min-w-0 items-start gap-3">
            <item.Icon className={`mt-1 size-4 shrink-0 ${item.iconClassName}`} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-ui-lg font-medium leading-6 text-foreground">
                  {!accountDisconnected && item.key !== "startPlan"
                    ? (entryGate.label ?? item.label)
                    : item.label}
                </span>
              </span>
              {item.metric ? (
                <span className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-2xl font-bold leading-none text-foreground">
                    {item.metric}
                  </span>
                  {item.metricUnit ? (
                    <span className="text-ui-base font-medium text-foreground-subtle">
                      {item.metricUnit}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {item.priceState?.kind === "price" ? (
                <PurchaseChoiceBannerPrice
                  price={item.priceState.price}
                  currency={item.priceState.currency}
                  locale={locale}
                />
              ) : item.priceState?.kind === "soldOut" ? (
                <span className="mt-1 block text-lg font-semibold leading-6 text-foreground">
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.purchaseBanner.temporarilySoldOut",
                  })}
                </span>
              ) : null}
              <span className="mt-0.5 block text-ui-base leading-5 text-foreground-subtle">
                {item.description}
              </span>
            </span>
            <span className="flex h-6 shrink-0 items-center">
              <ArrowRightIcon className="size-4 text-foreground-subtle" />
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

// 企业档位 → 横幅样式的映射。max 与 advanced 共用一套视觉，
// 其余档位回退到标准团队样式。
// 归一化只做 trim + lower，不做本地化匹配：档位键是后端标识而不是展示文案。
export function resolveEnterpriseTeamPlanBannerClass(tierKey: string): string {
  const normalized = tierKey.trim().toLowerCase();
  if (normalized === "max" || normalized.includes("advanced")) {
    return TEAM_PLAN_ADVANCED_ENTRY_BANNER_CLASS;
  }
  return TEAM_PLAN_ENTRY_BANNER_CLASS;
}

export function resolveEnterpriseTeamPlanBannerIconClass(tierKey: string): string {
  const normalized = tierKey.trim().toLowerCase();
  if (normalized === "max" || normalized.includes("advanced")) {
    return "text-[#14b8a6]";
  }
  return "text-[#0ea5e9]";
}

export function resolveEnterpriseTeamPlanBannerDescriptionId(tierKey: string): string {
  const normalized = tierKey.trim().toLowerCase();
  if (normalized === "max" || normalized.includes("advanced")) {
    return "settings.modelProvider.codingPlan.purchaseBanner.teamAdvancedDescription";
  }
  return "settings.modelProvider.codingPlan.purchaseBanner.teamStandardDescription";
}

export function resolvePurchaseChoiceBannerProductsProviderId(
  providerId: CodingPlanProviderId,
): CodingPlanProviderId {
  return resolveCodingPlanUpgradeProductsProviderId(providerId) ?? providerId;
}

// resolvePurchaseChoiceBannerPrice() 过滤售罄与非正数商品后取最低价。
// 三个过滤条件必须同时存在：价格为 0 的试用 SKU 会把起售价拉成 0，
// 售罄商品会把已下架价格继续展示。
// 全部售罄时才返回 soldOut；部分售罄仍展示可购买的最低价。
// 缺失远端商品时返回 null，绝不回退静态价格：静态价与真实 SKU 失配时，
// 用户点进去会看到另一个价格。
export function resolvePurchaseChoiceBannerPrice({
  providerId,
  audience,
  products,
  soldOutVisible = true,
}: {
  providerId: BuiltinModelProviderId;
  audience: PurchaseAudience;
  products: CodingPlanProductDisplay[];
  soldOutVisible?: boolean;
}): { kind: "price"; price: number; currency: string } | { kind: "soldOut" } | null {
  // audience 分支只处理个人；团队价格走另一个函数，
  // 因为团队商品是分组结构（EnterpriseCodingPlanProductGroup）而不是平铺列表。
  if (audience === "personal") {
    const product = products
      .map((candidate) => ({
        product: candidate,
        price: pickProductPrice(candidate),
      }))
      .filter(
        (candidate): candidate is { product: CodingPlanProductDisplay; price: number } =>
          candidate.product.soldOut !== true &&
          typeof candidate.price === "number" &&
          candidate.price > 0,
      )
      .sort((left, right) => left.price - right.price)[0];
    if (product) {
      return {
        kind: "price",
        price: product.price,
        // 商品价格属于 provider 维度，缺失币种时只能按当前 provider 的结算域兜底。
        // 不能让 formatter 默认落到 CNY，否则 Z.ai Global 入口会错误显示 RMB。
        currency:
          product.product.priceCurrency ??
          (providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ? "CNY" : "USD"),
      };
    }
    if (
      soldOutVisible &&
      products.length > 0 &&
      products.every((candidate) => candidate.soldOut === true)
    ) {
      // 个人套餐入口 banner 是用户进入购买流前看到的第一层价格信息。
      // 所有个人套餐都售罄时需要在金额位置前置展示售罄，而不是继续显示静态最低价。
      return { kind: "soldOut" };
    }
  }

  // 缺失远端商品时不能补造静态价格，否则配置键失配会伪装成正常套餐。

  return null;
}

// resolveEnterprisePurchaseChoiceBannerPrice() 只在 group.products 内取最低价。
// 团队价格缺失币种时兜底 CNY：企业目录当前只在国内站售卖。
// 与个人不同，团队不返回 soldOut 状态 —— 售罄由远端目录直接剔除商品来表达。
export function resolveEnterprisePurchaseChoiceBannerPrice(
  group: EnterpriseCodingPlanProductGroup,
): { kind: "price"; price: number; currency: string } | null {
  // 团队分组内取最低有效价，过滤条件与 resolvePurchaseChoiceBannerPrice() 一致。
  // 这里不过滤 soldOut：团队目录通过移除商品表达售罄，不会出现 soldOut 标记。
  const product = group.products
    .map((candidate) => ({
      product: candidate,
      price: pickProductPrice(candidate),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        product: EnterpriseCodingPlanProductGroup["products"][number];
        price: number;
      } => typeof candidate.price === "number" && candidate.price > 0,
    )
    .sort((left, right) => left.price - right.price)[0];
  if (!product) {
    return null;
  }
  return {
    kind: "price",
    price: product.price,
    currency: product.product.priceCurrency ?? "CNY",
  };
}

// Start Plan 标题的本地化兜底。
// 只替换「start plan」这个已知的英文默认名，其余远端名称原样保留。
// 用 locale.startsWith("zh") 而不是精确匹配 zh-CN，覆盖 zh-HK / zh-TW 等变体。
function resolveStartPlanPurchaseChoiceBannerTitle({
  fallbackTitle,
  locale,
  remoteTitle,
}: {
  fallbackTitle: string;
  locale: string;
  remoteTitle?: string;
}): string {
  const title = remoteTitle?.trim() || fallbackTitle;
  if (locale.startsWith("zh") && /^start\s+plan$/i.test(title)) {
    // Start Plan banner 的名称来自远端 preview；当前远端默认只返回英文。
    // 这里只本地化这个已知默认名，避免覆盖真实远端自定义套餐名。
    return fallbackTitle;
  }
  return title;
}

// 价格排版组件。中文与英文的语序不同：
// 英文用整句 from $X，中文要把金额单独放大、单位与后缀拆到第二行。
// 拆分行依赖 formatCodingPlanAmount 的输出格式（金额 + 空格 + 单位），
// 因此该函数的格式变更必须同步检查这里。
function PurchaseChoiceBannerPrice({
  price,
  currency,
  locale,
}: {
  price: number;
  currency: string | null;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  // 金额格式化统一走 formatCodingPlanAmount，
  // 本组件只负责按语言重排「金额 / 单位 / 起价后缀」三段的视觉层级。
  const formattedAmount = formatCodingPlanAmount(price, currency, locale);
  // 中文排版判断独立于 intl.locale：intl 可能被宿主强制成其他语言，
  // 而价格语序必须跟随用户实际看到的语言环境。
  const isChineseLocale = locale.toLowerCase().startsWith("zh");
  if (!isChineseLocale) {
    return (
      <span className="mt-1 block text-lg font-semibold leading-6 text-foreground">
        {intl.formatMessage(
          { id: "settings.modelProvider.codingPlan.purchase.fromPrice" },
          { price: formattedAmount },
        )}
      </span>
    );
  }

  // 按第一个空格切分是格式契约的一部分：格式化函数保证「金额 单位」两段式。
  // labelParts 用 rest 收集，兼容单位本身含空格（如某些语言的 "per month"）。
  // labelParts 为空时 label 是空串，最终 join 结果仍只显示后缀，不会出现多余空格。
  const [amount, ...labelParts] = formattedAmount.split(" ");
  // 标签部分为空时不渲染占位空格：join 后再 trim，
  // 最终由 filter(Boolean) 保证后缀不会以空格开头。
  const label = labelParts.join(" ").trim();
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className="text-lg font-semibold leading-6 text-foreground">{amount}</span>
      <span className="text-ui-base font-medium text-foreground-subtle">
        {[
          label,
          intl.formatMessage({
            id: "settings.modelProvider.codingPlan.purchase.fromPriceSuffix",
          }),
        ]
          .filter(Boolean)
          .join(" ")}
      </span>
    </span>
  );
}

function CodingPlanAccessBanner({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <p className="mt-1 text-ui-sm leading-6 text-foreground-subtle">{description}</p>
    </div>
  );
}

// 登录/购买引导横幅。只有三种情况需要提示：未连接、未购买、凭据失败。
// 其余状态返回 null，让状态卡自己承担信息展示。
// 文案 id 通过状态拼接而不是枚举 switch，新增状态时必须同步补翻译键，
// 缺失的键会直接显示 id 字面量 —— 这也是它的发现机制。
function resolveCodingPlanAccessBanner(
  status: CodingPlanStatus,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  reloginOnFailure = false,
): { title: string; description: string } | null {
  if (
    status !== "disconnected" &&
    status !== "notPurchased" &&
    !(status === "unavailable" && reloginOnFailure)
  ) {
    return null;
  }
  return {
    title: intl.formatMessage({
      id: `settings.modelProvider.codingPlan.status.${status}`,
    }),
    description: intl.formatMessage({
      id:
        status === "unavailable" && reloginOnFailure
          ? "settings.modelProvider.codingPlan.description.credentialFailed"
          : `settings.modelProvider.codingPlan.description.${status}`,
    }),
  };
}
