// ============================================================================
// StatusCards.tsx — Coding Plan / Start Plan 状态卡（状态投影 + 动作编排）
//
// 职责边界：
//   - 只做展示与动作转发：登录、解绑、购买、升级、额度重置都通过 props 回调。
//   - 不读取 provider 存储，也不判断账号域；状态由 nav item 计算后传入。
//   - 文案只用于展示，不能反过来驱动交互分支（见 INV-03）。
//
// 四种输入必须分清：
//   displayStatus  决定卡片整体处于哪一态（未购买/已购/检查中/不可用/不支持）。
//   actionStatus   决定登录与重试入口，可与 displayStatus 不同。
//   balanceStatus  只决定额度区的占位与真实卡，不影响标题与动作。
//   loginLoading   传输中的开关，只用于禁用与转圈。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 viewState 缺省时必须由 status 同源补齐三态。
//   守住它的位置：effectiveViewState 的 ?? 默认对象。
//   改错故障：只补 displayStatus，actionStatus 为 undefined 会让登录入口消失。
//
// INV-02 checking 期间不得展示上一轮的错误文案或自定义 statusLabelId。
//   守住它的位置：statusBadgeId 顶部的 isChecking 分支与 statusBadgeMessage 的 undefined。
//   改错故障：检查中同时出现转圈、旧错误与错误图标，用户以为失败已成定局。
//
// INV-03 Team Plan 交互只读显式业务原因，不从展示文案反推。
//   守住它的位置：teamPlanAvailabilityReason 的显式比较。
//   改错故障：Project Key 错误被翻译 key 误判成「团队套餐未分配」，给出错误的引导。
//
// INV-04 只有 not-allocated / expired 才把团队不可用显示为状态行。
//   守住它的位置：teamPlanUnavailableStatusVisible 的两个等值判断。
//   改错故障：任何团队错误都走「不可用」，真正的网络错误失去重试入口。
//
// INV-05 recoverableUnavailable 必须排除团队不可用状态。
//   守住它的位置：actionStatus === "unavailable" && !teamPlanUnavailableStatusVisible。
//   改错故障：团队未分配会显示「登录已过期 → 重新登录」，用户反复登录也无法解决。
//
// INV-06 relogin 优先于 retry，且 retry 必须排除 relogin。
//   守住它的位置：retryVisible 的 !reloginVisible 条件。
//   改错故障：同一张卡同时出现「重新登录」与「重试」两个按钮，用户不知道该点哪个。
//
// INV-07 尾部登录按钮只在 actionStatus=disconnected 或可恢复不可用时出现。
//   守住它的位置：trailingLoginVisible 的最后一个括号条件。
//   改错故障：已登录且一切正常时仍显示「连接」，点击后重复发起登录流程。
//
// INV-08 升级入口对 Max 档仍然显示，只是文案改成「续期」。
//   守住它的位置：canUpgrade 不因 isMaxPlanLevel 排除。
//   改错故障：Max 用户失去续费入口，只能等套餐过期。
//
// INV-09 管理入口必须同时具备 purchaseUrl 与 onOpenPurchase。
//   守住它的位置：canManageCodingPlan 末尾两个 Boolean。
//   改错故障：少一个条件就渲染出点了没反应的「管理」。
//
// INV-10 内联解绑只用于未购买状态；已购买时解绑在 statusMeta 里。
//   守住它的位置：inlineDisconnectVisible = canDisconnectProvider && !isPurchased。
//   改错故障：同一张卡出现两个解绑入口，或已购卡把解绑藏进不可见区域。
//
// INV-11 内联解绑可见时，必须把 CodingPlanStatusActions 的 canDisconnectProvider 置 false。
//   守住它的位置：statusContent 里的 inlineDisconnectVisible ? false : canDisconnectProvider。
//   改错故障：两个组件同时渲染解绑按钮，重复点击导致第二次 404。
//
// INV-12 购买入口与升级入口互斥：canUpgrade 时不再渲染 buyAction。
//   守住它的位置：buyAction 的 !canUpgrade 条件。
//   改错故障：已购用户同时看到「升级」与「订阅」，订阅会再买一份。
//
// INV-13 额度区只在 purchased 时展示，Start 或有可展示 limits 时才非空。
//   守住它的位置：usageCardsVisible 的三段与运算。
//   改错故障：未购买也渲染 0% 额度卡，用户以为套餐已生效但没有额度。
//
// INV-14 多卡路径只属于「Start + purchased + 有 entries」三条件同时成立。
//   守住它的位置：planCards 的三元条件。
//   改错故障：普通 Coding Plan 误入多卡分支，只渲染出第一项额度而丢掉主卡信息。
//
// INV-15 多卡兜底分支不得把全量 quotaLimits 塞进单卡。
//   守住它的位置：isStartPlanProvider 且非 checking 时返回 undefined 的注释分支。
//   改错故障：无 plan_id 归属的额度桶被挂到某张卡上，数据张冠李戴。
//
// INV-16 卡标题优先级：未购买用 inactivePlanTitle，Start 真权益用 Start，其余用权益名。
//   守住它的位置：resolveCodingPlanStatusCardTitle 的两个 if。
//   改错故障：付费 Coding Plan 权益被显示成「Start Plan」，用户以为买错了套餐。
//
// INV-17 Max 判定必须带词边界，不能裸 includes("MAX")。
//   守住它的位置：isMaxCodingPlanLevel 的正则。
//   改错故障："MAXIMUM" 或备注里的 max 被当成 Max 档，按钮文案误变「续期」。
//
// INV-18 entitlement 标识比较前必须 trim + toLowerCase。
//   守住它的位置：hasStartPlanEntitlementQuota 的 map 归一。
//   改错故障：大小写或空格差异让真实权益匹配失败，额度卡误判为无额度。
//
// INV-19 entitlements 为空时用 limits.length 兜底，而不是判定为无额度。
//   守住它的位置：entitlementIds.size === 0 的提前返回。
//   改错故障：旧 Host 不下发 entitlements，所有 Start 用户都显示「暂无额度」。
//
// INV-20 标准额度卡只映射真实存在的 limit，不得用 limits[0]/[1]/[2] 兜底。
//   守住它的位置：createCodingPlanUsageSummaryCard 的 !card.limit 返回 null。
//   改错故障：provider 详情固定出现三张卡，与侧边栏额度项不一致。
//
// INV-21 五小时与周额度的重置机会必须经 resolveCodingPlanQuotaResetLimit 合并。
//   守住它的位置：fiveHourLimit / weeklyLimit 的取值。
//   改错故障：直接读原始 limit 会丢掉「机会已核销」的合并结果，入口状态错乱。
//
// INV-22 有可用机会就展示徽标与入口，不得因剩余 100% 或多张机会隐藏。
//   守住它的位置：opportunityBadge 的 visible 与卡片 action 的判断。
//   改错故障：核销后剩余变 100%，徽标被藏，用户以为重置机会丢了。
//
// INV-23 percentage 是已用百分比，剩余视图必须反转并 clamp 到 0~100。
//   守住它的位置：resolveLimitRemainingPercentage 的 100 - usedPercentage。
// 改错故障：`CodingPlanStatusPanel` 把已用比例当剩余展示，用户会以为额度快用完。
//
// INV-24 所有百分比在进出计算前都要过 Number.isFinite 与 clamp。
//   守住它的位置：normalizeUsagePercentage 与 formatRemainingPercentage 的首个判断。
//   改错故障：NaN / Infinity 让进度条宽度变成非法 CSS，整卡布局塌陷。
//
// INV-25 剩余值小于 10 时保留一位小数，其余取整。
//   守住它的位置：maximumFractionDigits 的 value >= 10 三元。
//   改错故障：剩余 0.4% 被四舍五入成 0%，用户以为额度已耗尽。
//
// INV-26 模型名只在非 TIME_LIMIT 的额度卡展示。
//   守住它的位置：modelLabel 的 type !== "TIME_LIMIT" 条件。
//   改错故障：时间类额度把 usageDetails 里的模型名当成额度归属，展示出无关模型。
//
// INV-27 额度卡标题行最低高度用 min-h-6，不能写死 24px。
//   守住它的位置：PlanUsageMetricCard 标题行的 min-h-6。
//   改错故障：20px 字号下 30px 行盒溢出，标题与右侧动作互相重叠。
//
// INV-28 额度类别匹配统一走 isSameLimitCategory，兼容 CREDIT_LIMIT 与 TOKENS_LIMIT。
//   守住它的位置：findUsageLimit 的第一个条件。
//   改错故障：Team Plan 的 CREDIT_LIMIT 查不到，额度区整块空白。
//
// ============================================================================
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- Coding Plan/Start Plan 状态卡集中编排状态、动作和套餐区块，当前先保持同一文件避免拆散状态语义。 */
import {
  BIGMODEL_PROVIDER_ID,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  type UsageEntitlementSubscriptionDetail,
  type UsageQuotaLimit,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { InfoIcon, Loader2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { logger } from "@/logger.js";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import {
  CodingPlanBillingDiscountBadge,
  useCodingPlanBillingDiscount,
} from "@/CodingPlanBillingDiscount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { formatQuotaResetTime, isSameLimitCategory } from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  type CodingPlanFunnelContext,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  type CodingPlanStatus,
  type CodingPlanProviderId,
  type TeamPlanAvailabilityReason,
} from "./constants.js";
import type { CodingPlanStatusPanelViewState } from "./codingPlanStatusPanelViewState.js";
import { CodingPlanStatusMeta, StartPlanStatusMeta } from "./CodingPlanStatusMeta.js";
import { CodingPlanStatusActions, CodingPlanUpgradeAction } from "./CodingPlanStatusActions.js";
import type { CodingPlanLoginOptions } from "./codingPlanPricingCards.js";
import type { PurchaseAudience } from "./codingPlanEnterpriseTiers.js";
import { StartPlanCard } from "./StartPlanCard.js";
import { StartPlanQuotaStatusCard } from "./StartPlanQuotaStatusCard.js";
import { resolveStartPlanQuotaCardEntries } from "./StartPlanBalanceCard.js";
import { useStartPlanPreview } from "./useStartPlanPreview.js";
import {
  BigModelRegistrationHint,
  isBigModelUnregisteredAuthError,
} from "./BigModelRegistrationHint.js";
import { formatQuotaModelDisplayName } from "./quotaModelDisplayName.js";

// [权衡] 颜色用 CSS 变量而不是 hex：主题切换与深浅色由样式层统一控制，
// 组件里写死色值会在暗色主题下失去对比度。
const CODING_PLAN_USAGE_SUMMARY_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
] as const;

// [权衡] 抽一层纯布局壳：单卡与多卡（Start Plan）共用同一套标题/分隔线/动作布局，
// 避免两条路径的留白与断点行为逐渐分叉。
function PlanStatusCardSurface({
  planTitle,
  titleAccessory,
  statusMeta,
  trailingAction,
  usageContent,
}: {
  planTitle: string;
  titleAccessory?: ReactNode;
  statusMeta: ReactNode;
  trailingAction?: ReactNode;
  usageContent?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <h3 className="min-w-0 truncate text-ui-lg font-semibold leading-5 text-foreground">
              {planTitle}
            </h3>
            {titleAccessory}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {statusMeta}
          </div>
        </div>
        {trailingAction ? (
          <div className="shrink-0 max-sm:flex max-sm:w-full max-sm:[&>button]:w-full">
            {trailingAction}
          </div>
        ) : null}
      </div>
      {usageContent ? (
        <>
          <div className="my-4 border-t border-border" />
          {usageContent}
        </>
      ) : null}
    </div>
  );
}

// [失败路径] 占位卡不带骨架屏动画：设置页的加载通常只有一帧，
// 骨架闪烁比静态转圈更让人误以为网络卡住。
export function ModelProviderLoadingCard({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <Loader2Icon className="size-4 animate-spin" />
        <span>{loadingLabel}</span>
      </div>
    </div>
  );
}

// [失败路径] messageId 有默认值：预设 provider 尚未配置时也要有可读文案，
// 调用方不必为每种预设各传一条。
export function PresetProviderPlaceholderCard({
  displayName,
  messageId = "settings.modelProvider.presetEmpty",
}: {
  displayName: string;
  messageId?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="bg-background/50 rounded-2xl p-3">
      <div className="text-ui-lg font-semibold text-foreground">{displayName}</div>
      <div className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: messageId })}
      </div>
    </div>
  );
}

// [并发] 本组件同时被向导与设置页挂载，所有状态都必须来自 props；
// 唯一本地状态是「升级面板是否可见」与「Start 权益刷新中」，二者都是纯 UI 态。
export function CodingPlanStatusPanel({
  providerId,
  providerName,
  status,
  viewState,
  loginLoading,
  disconnectLoading,
  purchaseUrl,
  planLevel,
  inactivePlanTitle,
  subscriptionRenewTime,
  subscriptionExpireTime,
  subscriptionDetails,
  quotaLimits = [],
  mcpQuotaLimit = null,
  authError,
  onOpenRegistration,
  onLogin,
  onRetry,
  reloginOnFailure = false,
  onOpenPurchase,
  onDisconnect,
  onOpenUpgradePlans,
  purchaseInitialAudience = "personal",
  loginActionPlacement = "inline",
  loginActionVisible = false,
  usageDetailsVisible = true,
  upgradeActionVisible = true,
  upgradePlansVisible: controlledUpgradePlansVisible,
  onUpgradePlansVisibleChange,
  startPlanPreviewVisible = true,
  statusLabelId,
  statusMessage,
  teamPlanAvailabilityReason,
  quotaResetSourceKey,
  quotaResetAccountAccess,
  onQuotaResetEntitlementRefresh,
}: {
  providerId: CodingPlanProviderId;
  providerName: string;
  status: CodingPlanStatus;
  viewState?: CodingPlanStatusPanelViewState;
  loginLoading?: boolean;
  disconnectLoading?: boolean;
  purchaseUrl?: string;
  planLevel?: string | null;
  inactivePlanTitle?: string | null;
  subscriptionRenewTime?: string | null;
  subscriptionExpireTime?: string | null;
  subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
  quotaLimits?: UsageQuotaLimit[];
  /** 官方 Server MCP 额度（服务端下发的总额度）。不在 quota.limits[] 里，由 nav item 单独透传。 */
  mcpQuotaLimit?: UsageQuotaLimit | null;
  authError?: string | null;
  onOpenRegistration?: () => void;
  onLogin?: (options?: CodingPlanLoginOptions) => number | void | Promise<void>;
  /** 凭据获取失败提供主动重新登录，不据此自动退出账号。 */
  reloginOnFailure?: boolean;
  /** Start 套餐获取失败沿用 Host 手动刷新，不强制重新登录。 */
  onRetry?: () => void;
  onOpenPurchase?: (url: string) => void;
  onDisconnect?: () => void;
  onOpenUpgradePlans?: (options: {
    initialAudience: PurchaseAudience;
    funnelContext: CodingPlanFunnelContext | null;
  }) => void;
  /** 原生面板移除后，Team 状态卡仍须把购买对象传给统一升级入口。 */
  purchaseInitialAudience?: PurchaseAudience;
  loginActionPlacement?: "inline" | "trailing";
  loginActionVisible?: boolean;
  usageDetailsVisible?: boolean;
  upgradeActionVisible?: boolean;
  upgradePlansVisible?: boolean;
  onUpgradePlansVisibleChange?: (visible: boolean) => void;
  startPlanPreviewVisible?: boolean;
  statusLabelId?: string;
  statusMessage?: string | null;
  teamPlanAvailabilityReason?: TeamPlanAvailabilityReason;
  /** Team Plan 必须传完整连接 key，避免与同 provider 的个人套餐共享重置状态。 */
  quotaResetSourceKey?: string;
  quotaResetAccountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  onQuotaResetEntitlementRefresh?: () => void | Promise<void>;
}) {
  // [性能] 只取 intl：本组件的所有文案都在渲染期格式化，
  // 订阅整个上下文会让语言切换之外的变化也触发重渲染。
  const { intl } = useZCodeIntl();
  // [失败路径] 折扣 hook 在无配置时返回 active=false：
  // 组件不判空，直接把 config 透传给 badge 与按钮。
  const billingDiscount = useCodingPlanBillingDiscount();
  // [事务] 受控/非受控双模式：外部传了 onUpgradePlansVisibleChange 时以外部为准，
  // 内部 state 只作为未受控时的兜底，不能同时驱动同一个面板。
  const [internalUpgradePlansVisible, setInternalUpgradePlansVisible] = useState(false);
  const [startPlanEntitlementRefreshing, setStartPlanEntitlementRefreshing] = useState(false);
  // [失败路径] 用 ?? 而不是 ||：外部显式传 false 时必须尊重 false，
  // 用 || 会让「关闭面板」的指令被内部旧值覆盖。
  const upgradePlansVisible = controlledUpgradePlansVisible ?? internalUpgradePlansVisible;
  const setUpgradePlansVisible = onUpgradePlansVisibleChange ?? setInternalUpgradePlansVisible;
  // [资源] 刷新进行中直接早退：额度接口并无幂等保护，
  // 连点会并发多个请求，最后一个响应可能覆盖更新的结果。
  const refreshStartPlanEntitlement = async () => {
    // [失败路径] 没有回调时不进入 loading：
    // 否则按钮会永久转圈，因为 finally 之外的 setState 也可能来不及执行。
    if (!onQuotaResetEntitlementRefresh || startPlanEntitlementRefreshing) {
      return;
    }
    setStartPlanEntitlementRefreshing(true);
    try {
      await onQuotaResetEntitlementRefresh();
    } catch (error) {
      // 额度桶可能在生效时间后仍短暂未就绪。刷新失败时必须保留按钮供重试，
      // 不能因为一次网络错误把“尚未同步”错误收敛成已完成。
      logger.warn("[ModelProviderSection] 刷新 Start Plan 权益失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
      });
    } finally {
      setStartPlanEntitlementRefreshing(false);
    }
  };
  // [失败路径] 三态默认全部取同一个 status：
  // 旧调用方只传 status 时，display/action/balance 的行为必须保持一致，否则升级路径会突变。
  const effectiveViewState = viewState ?? {
    displayStatus: status,
    actionStatus: status,
    balanceStatus: status,
    loginLoading: loginLoading === true,
  };
  // [权衡] 把每个状态解构成布尔而不是到处比较字符串：
  // `PlanStatusCardSurface` 把十几处阈值比较抽成常量，分支条件读起来接近业务描述。
  const isDisconnected = effectiveViewState.displayStatus === "disconnected";
  const isChecking = effectiveViewState.displayStatus === "checking";
  const isUnavailable = effectiveViewState.displayStatus === "unavailable";
  const isUnsupported = effectiveViewState.displayStatus === "unsupported";
  const isPurchased = effectiveViewState.displayStatus === "purchased";
  const isNotPurchased = effectiveViewState.displayStatus === "notPurchased";
  const actionIsDisconnected = effectiveViewState.actionStatus === "disconnected";
  const isStartPlanProvider = isStartPlanModelProviderId(providerId);
  const providerIcon =
    resolveModelProviderFamilySpecByProviderId(providerId)?.oauthProviderId ?? null;
  // [失败路径] 检查中/不可用/不支持都禁止解绑：
  // 此时 provider 快照可能过期，解绑请求会打到已经失效的连接上。
  const canDisconnectProvider =
    !isStartPlanProvider &&
    Boolean(onDisconnect) &&
    !isDisconnected &&
    !isChecking &&
    !isUnavailable &&
    !isUnsupported;
  // [失败路径] Start 且 unavailable 时用「重新登录」而非「登录」：
  // 这表示曾经登录过但凭据失效，文案必须与真实原因一致。
  const loginButtonId = isStartPlanProvider
    ? isUnavailable
      ? "chat.error.action.relogin"
      : "settings.modelProvider.startPlan.login"
    : "settings.modelProvider.codingPlan.connect";
  // [失败路径] 顺序是 unsupported → disconnected → checking → unavailable → purchased → notPurchased：
  // 前面每一态都比后面更具体，调换会让「不支持」被显示成「未购买」。
  const defaultStatusBadgeId = isUnsupported
    ? "settings.modelProvider.codingPlan.status.unsupported"
    : isDisconnected
      ? "settings.modelProvider.codingPlan.status.disconnected"
      : isChecking
        ? "settings.modelProvider.codingPlan.status.checking"
        : isUnavailable
          ? "settings.modelProvider.codingPlan.status.unavailable"
          : isPurchased
            ? "settings.modelProvider.codingPlan.status.purchased"
            : "settings.modelProvider.codingPlan.status.notPurchased";
  // 检查态可能仍携带上一轮团队错误；状态行只呈现当前检查状态，避免双图标和旧错误闪现。
  // [事务] checking 时完全忽略 statusLabelId 与 statusMessage：
  // 它们属于上一轮结果，混进检查态会造成「正在检查 + 已失败」的双重信号。
  const statusBadgeId = isChecking
    ? defaultStatusBadgeId
    : (statusLabelId ??
      (isStartPlanProvider && isDisconnected
        ? "settings.modelProvider.startPlan.status.loginRequired"
        : isStartPlanProvider && isNotPurchased
          ? "settings.modelProvider.startPlan.status.noPlan"
          : defaultStatusBadgeId));
  // [失败路径] trim 后为空仍要回落到 i18n 文案：
  // Host 可能下发空字符串表示「没有额外说明」，直接渲染会出现空状态行。
  const statusBadgeMessage = isChecking ? undefined : statusMessage?.trim();
  // 展示文案不是状态权威。Team Plan 交互只读取显式业务原因，
  // 避免 Project Key 错误被翻译 key 误判成“团队套餐未分配”。
  // [失败路径] 只认两个枚举值：teamPlanAvailabilityReason 是业务原因，
  // 任何新增原因都必须显式加入，避免被误当成「可重试」。
  const teamPlanUnavailableStatusVisible =
    teamPlanAvailabilityReason === "not-allocated" || teamPlanAvailabilityReason === "expired";
  const teamPlanWarningVisible = !isChecking && teamPlanAvailabilityReason !== undefined;
  // [事务] 可恢复不可用 = 动作层不可用 且 非团队业务原因：
  // 这是「重试/重新登录」与「等待管理员分配」两条完全不同的恢复路径的分水岭。
  const recoverableUnavailable =
    effectiveViewState.actionStatus === "unavailable" && !teamPlanUnavailableStatusVisible;
  // [失败路径] 三个条件必须同时成立：可恢复、允许重新登录、存在登录回调；
  // 缺一个就会渲染出一个无法完成认证的按钮。
  const reloginVisible = recoverableUnavailable && reloginOnFailure && Boolean(onLogin);
  // [失败路径] 排除 reloginVisible 是必须的（INV-06）：
  // 两种恢复方式同时出现时，用户往往会点错，而错误的那条会清掉当前会话。
  const retryVisible =
    (recoverableUnavailable ||
      statusLabelId === "settings.modelProvider.codingPlan.status.unavailable") &&
    !reloginVisible &&
    Boolean(onRetry);
  // [事务] 尾部登录只在「未登录」或「可恢复不可用」时出现；
  // 它与 statusContent 里的内联登录互斥，由 loginVisible 的反向条件保证。
  const trailingLoginVisible =
    !reloginVisible &&
    !retryVisible &&
    loginActionVisible &&
    loginActionPlacement === "trailing" &&
    (actionIsDisconnected || recoverableUnavailable) &&
    Boolean(onLogin);
  const rawPlanLevel = planLevel?.trim() ?? "";
  const normalizedPlanLevel = rawPlanLevel.toUpperCase();
  const isMaxPlanLevel = isMaxCodingPlanLevel(rawPlanLevel);
  // [失败路径] GLM Coding 这类产品名需要走展示名格式化：
  // 直接大写会变成 GLM_CODING，与套餐页上的品牌写法不一致。
  const displayPlanLevel = /^GLM[\s_-]+CODING\b/i.test(rawPlanLevel)
    ? formatQuotaModelDisplayName(rawPlanLevel)
    : normalizedPlanLevel;
  // [失败路径] checking 与 unsupported 都不显示升级：
  // 这两种状态下套餐档位可能还是旧值，升级按钮会给出错误的差价与目标。
  const canUpgrade =
    // Max 已是最高档但仍需要续期入口，不能因为不可升级就隐藏按钮。
    upgradeActionVisible && isPurchased && !isChecking && !isUnsupported;
  // [失败路径] purchaseUrl 可能为空（离线或旧快照）：
  // 没有 URL 时管理入口不可渲染，否则点击只会打开空白页。
  const canManageCodingPlan =
    !isDisconnected &&
    !isChecking &&
    !isUnsupported &&
    isPurchased &&
    Boolean(purchaseUrl) &&
    Boolean(onOpenPurchase);
  const disconnectedStartPlanPricingVisible =
    isStartPlanProvider && (isDisconnected || isNotPurchased);
  // [事务] 升级面板打开时隐藏套餐预览：
  // 两者都是大面积内容，同时出现会把状态卡推到首屏之外。
  const startPlanCardVisible =
    startPlanPreviewVisible && disconnectedStartPlanPricingVisible && !upgradePlansVisible;
  // [资源] enabled 随可见性关闭：不可见时不请求预览数据，
  // 避免每个设置页打开都多发一次网络请求。
  const startPlanPreview = useStartPlanPreview({
    enabled: startPlanCardVisible,
  });
  // [失败路径] 只有 checking + 未注册错误 + BigModel provider 三者同时成立才提示：
  // 把注册引导放到其它错误上会让用户误以为所有失败都需要重新注册。
  const shouldShowBigModelRegistrationHint =
    isChecking &&
    providerIcon === BIGMODEL_PROVIDER_ID &&
    isBigModelUnregisteredAuthError(authError);
  // [事务] 埋点上下文在点击时构建而不是渲染时：
  // 它包含当前 eventText 与套餐状态，渲染期构建会缓存过期的档位信息。
  const createSettingPlanCardFunnelContext = (eventText: string) =>
    createCodingPlanFunnelContext({
      providerId,
      // 修复原因：Start Plan 的升级入口与普通 Coding Plan 套餐卡属于不同链接方式，
      // 埋点必须单独标识，避免把 Start Plan 用户误归类为普通套餐卡来源。
      upgradeSource: isStartPlanProvider ? "setting_start_plan_card" : "setting_plan_card",
      eventRegion: "app.setting",
      eventText,
      entryPlanState: resolveCodingPlanEntryPlanState({
        displayStatus: effectiveViewState.displayStatus,
        providerId,
        planLevel,
      }),
    });
  // [事务] 外部回调优先：设置页已经把购买面板移到独立弹窗，
  // 只有嵌入方（例如精简面板）没有回调时才退回本地展开。
  const openUpgradePlans = (
    initialAudience: PurchaseAudience,
    nextFunnelContext: CodingPlanFunnelContext | null,
  ) => {
    if (onOpenUpgradePlans) {
      // Coding Plan 购买流程不应继续挂载在 Model Settings 内部；
      // 状态卡只负责发起意图，由弹窗 hook 承载购买面板。
      onOpenUpgradePlans({
        initialAudience,
        funnelContext: nextFunnelContext,
      });
      return;
    }
    setUpgradePlansVisible(true);
  };
  // [失败路径] 打开升级面板时必须同时带上受众与埋点上下文：
  // 缺少受众会让 Team 用户看到个人套餐价格，缺少上下文则无法归因。
  const upgradeAction = canUpgrade ? (
    <CodingPlanUpgradeAction
      loginLoading={effectiveViewState.loginLoading}
      upgradePlansVisible={upgradePlansVisible}
      actionLabelId={
        isMaxPlanLevel
          ? "settings.modelProvider.codingPlan.renew"
          : "settings.modelProvider.codingPlan.upgrade"
      }
      billingDiscountActive={isStartPlanProvider && billingDiscount.active}
      billingDiscountConfig={billingDiscount.config}
      onUpgradePlansVisibleChange={(visible) => {
        if (visible) {
          openUpgradePlans(
            purchaseInitialAudience,
            createSettingPlanCardFunnelContext(
              intl.formatMessage({
                id: isMaxPlanLevel
                  ? "settings.modelProvider.codingPlan.renew"
                  : "settings.modelProvider.codingPlan.upgrade",
              }),
            ),
          );
          return;
        }
        setUpgradePlansVisible(visible);
      }}
    />
  ) : null;
  // [失败路径] 未购买也可能在等待权益接口：
  // disabled 绑定 loginLoading，防止把旧的 notPurchased 快照提前提交成购买。
  const buyAction =
    !isStartPlanProvider && !canUpgrade && isNotPurchased && !isChecking && !isUnsupported ? (
      <CodingPlanEntryButton
        type="button"
        size="lg"
        // 未购买状态也可能正在等待权益接口返回；此时必须和 Upgrade
        // 按钮一样禁用，避免旧的 notPurchased 快照被提前提交为购买入口。
        disabled={effectiveViewState.loginLoading}
        onClick={() => {
          openUpgradePlans(
            purchaseInitialAudience,
            createSettingPlanCardFunnelContext(
              intl.formatMessage({
                id: "settings.modelProvider.codingPlan.subscribe",
              }),
            ),
          );
        }}
      >
        {/* 单卡同步可能晚于全局套餐查询；仅禁用会丢失等待反馈，和 Upgrade 保持一致。 */}
        {effectiveViewState.loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
        {intl.formatMessage({
          id: "settings.modelProvider.codingPlan.subscribe",
        })}
      </CodingPlanEntryButton>
    ) : null;
  // [事务] 已购买时解绑归 statusMeta（与续期/管理同排），
  // 未购买时没有 statusMeta 内容，才需要内联解绑（INV-10 / INV-11）。
  const inlineDisconnectVisible = canDisconnectProvider && !isPurchased;
  // [事务] 标题计算抽成纯函数：它同时被单卡与多卡路径复用，
  // 内联在 JSX 里会迫使两条路径各写一份优先级。
  const planTitle = resolveCodingPlanStatusCardTitle({
    isPurchased,
    isUnavailable,
    isStartPlanProvider,
    inactivePlanTitle,
    rawPlanLevel,
    displayPlanLevel,
    startPlanTitle: intl.formatMessage({
      id: "settings.modelProvider.planCard.startPlan",
    }),
    codingPlanTitle: intl.formatMessage({
      id: "settings.modelProvider.planCard.codingPlan",
    }),
  });
  const titleBillingDiscountVisible = !isStartPlanProvider && billingDiscount.active;
  // [权衡] 未购买状态自带 Info 图标：它表达「说明」而不是「错误」，
  // 与失败态的 AlertTriangle 形成明确的视觉区分。
  const notPurchasedStatusLabel = isNotPurchased ? (
    <span className="flex w-fit items-center gap-1.5 text-foreground-subtle">
      <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
      <span>{intl.formatMessage({ id: statusBadgeId })}</span>
    </span>
  ) : null;
  // [失败路径] plans 与 limits 都可能为空：
  // 解析函数先丢弃 `plan` 为空的额度桶，组件不再做第二次过滤。
  const startPlanEntries = resolveStartPlanQuotaCardEntries({
    plans: subscriptionDetails ?? [],
    limits: quotaLimits,
  });
  // [事务] 五条分支的顺序即优先级：已购 Start → 已购 → 注册引导 → 内联解绑 → 纯状态文本。
  // 调换顺序会让已购用户看到「连接」按钮，或在检查态露出解绑。
  const statusMeta =
    isPurchased && isStartPlanProvider ? (
      // 产品语义:体验套餐用量卡片不展示「管理」「解绑」操作(免费套餐无管理页,
      // 登录态由 family 级连接方式管理),仅保留过期时间与右侧升级 Coding Plan 入口。
      <StartPlanStatusMeta
        expireTime={subscriptionExpireTime}
        entitlements={subscriptionDetails?.[0]?.entitlements}
        hasQuota={hasStartPlanEntitlementQuota(
          subscriptionDetails?.[0]?.entitlements,
          startPlanEntries[0]?.limits ?? quotaLimits,
        )}
        refreshing={startPlanEntitlementRefreshing}
        onRefresh={refreshStartPlanEntitlement}
      />
    ) : isPurchased ? (
      <CodingPlanStatusMeta
        renewTime={subscriptionRenewTime}
        expireTime={subscriptionExpireTime}
        manageLabel={
          canManageCodingPlan
            ? intl.formatMessage({
                id: "settings.modelProvider.codingPlan.manage",
              })
            : null
        }
        unlinkLabel={
          canDisconnectProvider
            ? intl.formatMessage({
                id: "settings.modelProvider.codingPlan.disconnect",
              })
            : null
        }
        unlinkLoading={disconnectLoading}
        onManage={
          canManageCodingPlan && purchaseUrl && onOpenPurchase
            ? () => onOpenPurchase(purchaseUrl)
            : undefined
        }
        onUnlink={canDisconnectProvider ? onDisconnect : undefined}
      />
    ) : shouldShowBigModelRegistrationHint ? (
      <BigModelRegistrationHint onOpenRegistration={onOpenRegistration} />
    ) : inlineDisconnectVisible ? (
      <CodingPlanStatusMeta
        statusLabel={notPurchasedStatusLabel ?? intl.formatMessage({ id: statusBadgeId })}
        unlinkLabel={intl.formatMessage({
          id: "settings.modelProvider.codingPlan.disconnect",
        })}
        unlinkLoading={disconnectLoading}
        onUnlink={onDisconnect}
      />
    ) : (
      <span
        className={
          teamPlanWarningVisible
            ? "flex w-fit items-center gap-1.5 text-ui-base text-warning"
            : "flex w-fit items-center gap-1.5 text-ui-base text-foreground-subtle"
        }
      >
        {isChecking ? <Loader2Icon className="size-3 animate-spin" /> : null}
        {isNotPurchased || teamPlanWarningVisible ? (
          <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
        ) : null}
        {statusBadgeMessage || intl.formatMessage({ id: statusBadgeId })}
      </span>
    );
  // [失败路径] Start 与普通 Coding Plan 的额度来源不同：
  // 前者看 entries，后者看可展示 limits；统一成一个条件会让其中一方整块消失。
  const usageCardsVisible =
    usageDetailsVisible &&
    isPurchased &&
    (isStartPlanProvider || hasDisplayableCodingPlanUsageLimits(quotaLimits));
  // 同 family 已登录时默认登录动作只刷新；凭据失败后的主动恢复必须强制进入 OAuth。
  // [事务] 尾部动作优先级：重新登录 → 重试 → 登录 → 升级 → 购买；
  // 前两者是恢复路径，必须压过增长路径，否则故障时用户只看到「升级」。
  const trailingAction = reloginVisible ? (
    <Button
      type="button"
      size="lg"
      onClick={() => onLogin?.({ forceOAuth: true })}
      disabled={effectiveViewState.loginLoading}
    >
      {intl.formatMessage({ id: "login.expired.action" })}
    </Button>
  ) : retryVisible ? (
    <Button type="button" size="lg" onClick={onRetry} disabled={effectiveViewState.loginLoading}>
      {intl.formatMessage({ id: "common.retry" })}
    </Button>
  ) : trailingLoginVisible ? (
    <Button
      type="button"
      size="lg"
      onClick={() => onLogin?.()}
      disabled={effectiveViewState.loginLoading}
    >
      {effectiveViewState.loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
    </Button>
  ) : upgradeAction ? (
    // 升级是 Plan Card 的主操作，和连接入口同属卡片级 action。
    // 放在标题旁会随标题换行抖动；放到右侧并使用同尺寸按钮，层级和位置都更稳定。
    upgradeAction
  ) : buyAction ? (
    buyAction
  ) : null;
  const statusContent = (
    <>
      {isPurchased && statusLabelId === "settings.modelProvider.codingPlan.status.unavailable" ? (
        <span className="text-ui-base text-warning">
          {intl.formatMessage({ id: statusLabelId })}
        </span>
      ) : null}
      {statusMeta}
      <CodingPlanStatusActions
        providerName={providerName}
        isDisconnected={actionIsDisconnected}
        isUnavailable={recoverableUnavailable}
        isPurchased={isPurchased}
        loginLoading={effectiveViewState.loginLoading}
        loginButtonId={loginButtonId}
        loginVisible={
          loginActionVisible && !trailingLoginVisible && !reloginVisible && !retryVisible
        }
        canDisconnectProvider={inlineDisconnectVisible ? false : canDisconnectProvider}
        disconnectLoading={disconnectLoading}
        onLogin={onLogin}
        onDisconnect={onDisconnect}
      />
    </>
  );
  // [事务] 多卡与单卡是互斥结构：多卡必须有 entries，否则退回单卡；
  // 两者共用 PlanStatusCardSurface，保证边框与分隔线一致。
  const planCards =
    isStartPlanProvider && isPurchased && startPlanEntries.length > 0
      ? startPlanEntries.map(({ plan, limits: planLimits }, index) => (
          <PlanStatusCardSurface
            key={`${plan.productId}:${index}`}
            planTitle={plan.productName.trim() || planTitle}
            statusMeta={
              index === 0 ? (
                statusContent
              ) : (
                <StartPlanStatusMeta
                  expireTime={plan.expireTime}
                  entitlements={plan.entitlements}
                  hasQuota={hasStartPlanEntitlementQuota(plan.entitlements, planLimits)}
                  refreshing={startPlanEntitlementRefreshing}
                  onRefresh={refreshStartPlanEntitlement}
                />
              )
            }
            trailingAction={index === 0 ? trailingAction : undefined}
            usageContent={
              usageDetailsVisible &&
              (effectiveViewState.balanceStatus === "checking" || planLimits.length > 0) ? (
                <StartPlanQuotaStatusCard
                  isChecking={effectiveViewState.balanceStatus === "checking"}
                  limits={planLimits}
                  embedded
                />
              ) : undefined
            }
          />
        ))
      : [
          <PlanStatusCardSurface
            key="current-plan"
            planTitle={planTitle}
            titleAccessory={
              titleBillingDiscountVisible ? (
                <CodingPlanBillingDiscountBadge config={billingDiscount.config} size="compact" />
              ) : undefined
            }
            statusMeta={statusContent}
            trailingAction={trailingAction}
            usageContent={
              usageCardsVisible ? (
                isStartPlanProvider ? (
                  // 服务端契约保证 balances 只属于 active plans：purchased 快照必带套餐详情，
                  // 多卡路径必然可用。兜底分支（nav item 无套餐详情）不得把全量 quotaLimits
                  // 塞进单卡，否则无归属桶违背「无匹配 plan_id 的桶不得附着到任何卡片」的约定；
                  // 余额未落定时只保留查询占位。
                  effectiveViewState.balanceStatus === "checking" ? (
                    <StartPlanQuotaStatusCard
                      isChecking
                      limits={[]}
                      expireTime={subscriptionExpireTime}
                      embedded
                    />
                  ) : undefined
                ) : (
                  <CodingPlanUsageSummaryCards
                    limits={quotaLimits}
                    mcpQuotaLimit={mcpQuotaLimit}
                    sourceKey={quotaResetSourceKey ?? providerId}
                    preferredProviderId={providerId}
                    accountAccess={quotaResetAccountAccess}
                    onEntitlementRefresh={onQuotaResetEntitlementRefresh}
                  />
                )
              ) : undefined
            }
          />,
        ];

  return (
    <div className="space-y-3">
      {planCards}

      {startPlanCardVisible && !startPlanPreview.loading && startPlanPreview.preview ? (
        <StartPlanCard preview={startPlanPreview.preview} />
      ) : null}
    </div>
  );
}

// [权衡] 导出为纯函数：nav item 在决定是否展示额度区时也需要同一判断，
// 内联会导致两处对「有没有额度」给出不同答案。
export function hasStartPlanEntitlementQuota(
  entitlements: UsageEntitlementSubscriptionDetail["entitlements"],
  limits: readonly UsageQuotaLimit[],
): boolean {
  // [性能] 先建 Set 再 some：额度项通常 3~6 条，
  // 但权益可能更多，O(n*m) 在低频渲染下虽可接受，归一化仍能避免大小写陷阱。
  const entitlementIds = new Set(
    (entitlements ?? [])
      .map((entitlement) => entitlement.entitlementId.trim().toLowerCase())
      .filter(Boolean),
  );
  // [失败路径] 没有 entitlements 时不能直接判 false：
  // 旧 Host 或降级接口只给 limits，此时有额度就应当展示（INV-19）。
  if (entitlementIds.size === 0) {
    return limits.length > 0;
  }
  return limits.some((limit) => entitlementIds.has(limit.type.trim().toLowerCase()));
}

// [失败路径] 未购买时优先 inactivePlanTitle：
// 它可能是「Coding Plan Pro」这类具体产品名，比通用标题更有信息量。
export function resolveCodingPlanStatusCardTitle({
  isPurchased,
  isUnavailable = false,
  isStartPlanProvider,
  inactivePlanTitle,
  rawPlanLevel,
  displayPlanLevel,
  startPlanTitle,
  codingPlanTitle,
}: {
  isPurchased: boolean;
  isUnavailable?: boolean;
  isStartPlanProvider: boolean;
  inactivePlanTitle?: string | null;
  rawPlanLevel: string;
  displayPlanLevel: string;
  startPlanTitle: string;
  codingPlanTitle: string;
}): string {
  if (!isPurchased) {
    return inactivePlanTitle?.trim() || (isStartPlanProvider ? startPlanTitle : codingPlanTitle);
  }

  // [失败路径] Start provider 可能承载付费权益快照：
  // 只有权益名确实是 Start 才显示 Start Plan，否则必须露出真实权益名（INV-16）。
  if (isStartPlanProvider) {
    // Start provider 偶尔会承载同品牌 paid Coding Plan 的权益快照。
    // 只有真实 Start 权益继续显示 Start Plan；否则必须露出后端权益名，避免付费用户看到免费套餐标题。
    return isStartPlanEntitlementName(rawPlanLevel)
      ? startPlanTitle
      : displayPlanLevel || startPlanTitle;
  }

  return displayPlanLevel || codingPlanTitle;
}

// [失败路径] 用 endsWith(" start plan") 覆盖「GLM Start Plan」这类前缀品牌：
// 只做全等匹配会让带品牌的 Start 权益被误判成付费套餐。
function isStartPlanEntitlementName(planLevel: string): boolean {
  const normalized = planLevel.trim().toLowerCase();
  return (
    normalized === "start" || normalized === "start plan" || normalized.endsWith(" start plan")
  );
}

// [失败路径] 两侧都要求词边界：MAX 是短词，
// 裸 includes 会命中 MAXIMUM / MAX_TOKENS 等无关标识。
function isMaxCodingPlanLevel(planLevel: string): boolean {
  return /(^|[\s_-])MAX($|[\s_-])/i.test(planLevel);
}

// [并发] 额度结构直接由 limits 推导，不做本地缓存：
// 权益刷新后父组件会换新数组，缓存会让卡片停留在旧额度。
function CodingPlanUsageSummaryCards({
  limits,
  mcpQuotaLimit,
  sourceKey,
  preferredProviderId,
  accountAccess,
  onEntitlementRefresh,
}: {
  limits: UsageQuotaLimit[];
  mcpQuotaLimit: UsageQuotaLimit | null;
  sourceKey: string;
  preferredProviderId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  onEntitlementRefresh?: () => void | Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  // [事务] sourceKey 决定重置状态的归属：
  // Team 与个人套餐必须传不同 key，否则两边的机会计数会互相覆盖（见 props 注释）。
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey,
    preferredProviderId,
    accountAccess,
    onEntitlementRefresh,
  });
  // [失败路径] 必须用合并后的 limit：原始 limit 不知道机会是否已核销，
  // 直接展示会让「已用完的机会」仍然可点。
  const fiveHourLimit = resolveCodingPlanQuotaResetLimit(
    findUsageLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  // [失败路径] 周额度缺少 number 参数（不区分第几档）：
  // Coding Plan 的周额度只有一个档位，传具体 number 反而匹配不到。
  const weeklyLimit = resolveCodingPlanQuotaResetLimit(
    findUsageLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  // [事务] 四张标准卡按固定顺序构造：五小时 → 周 → 月 MCP → Server MCP；
  // 顺序即产品语义，不能按数据到达顺序重排。
  const standardCards = [
    createCodingPlanUsageSummaryCard({
      key: "fiveHour",
      label: intl.formatMessage({
        id: "settings.usage.entitlementFiveHourUsage",
      }),
      limit: fiveHourLimit ?? undefined,
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[0],
      resetTimeFormat: "dateTime",
    }),
    createCodingPlanUsageSummaryCard({
      key: "weekly",
      label: intl.formatMessage({
        id: "settings.usage.entitlementWeeklyUsage",
      }),
      limit: weeklyLimit ?? undefined,
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[1],
      resetTimeFormat: "date",
    }),
    createCodingPlanUsageSummaryCard({
      key: "monthlyTool",
      label: intl.formatMessage({
        id: "settings.usage.entitlementMonthlyMcpUsage",
      }),
      limit: findUsageLimit(limits, "TIME_LIMIT", 5, 1),
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[2],
      resetTimeFormat: "date",
    }),
    createCodingPlanUsageSummaryCard({
      key: "serverMcp",
      label: intl.formatMessage({
        id: "settings.usage.entitlementServerMcpUsage",
      }),
      limit: mcpQuotaLimit ?? undefined,
      progressColor: "var(--color-usage-chart-5)",
      // 官方 Server MCP 额度按自然日重置，重置时刻恒为 00:00，与其它额度卡统一用日期口径。
      resetTimeFormat: "date",
    }),
  // [失败路径] 用类型守卫过滤 null，而不是 map 后 filter(Boolean)：
  // 后者不会收窄类型，下游读 card.limit 需要额外断言。
  ].filter((card): card is CodingPlanUsageSummaryCard => card !== null);
  // [失败路径] 标准卡一张都没有时才走通用卡：
  // 两者混排会让同一行出现重复的额度类型，且颜色语义不一致。
  const cards =
    standardCards.length > 0
      ? standardCards
      : limits
          .filter(isDisplayableUsageLimit)
          .slice(0, 3)
          .map((limit, index) => ({
            key: `generic-${index}`,
            label: resolveGenericUsageLimitLabel(limit, intl),
            limit,
            progressColor:
              CODING_PLAN_USAGE_SUMMARY_COLORS[index % CODING_PLAN_USAGE_SUMMARY_COLORS.length] ??
              CODING_PLAN_USAGE_SUMMARY_COLORS[0],
            resetTimeFormat: "date" as const,
          }));

  // [事务] 机会徽标必须绑定「对应卡是否存在」：
  // 卡被过滤掉却仍展示重置入口，用户点开弹窗只能看到空列表。
  const fiveHourCardVisible = cards.some((card) => card.key === "fiveHour");
  const weeklyCardVisible = cards.some((card) => card.key === "weekly");
  // 五小时与周机会合并为一个徽标,次数累加,倒计时取最早到期的一档。
  // Bugfix：曾用「剩余 100% 则重置无收益」隐藏徽标与按钮。核销会把剩余改写成 100%，
  // 同类型余下的机会随即被藏掉，用户以为卡丢了。只要额度卡在且有可用机会就展示。
  // [事务] 合并规则是「次数相加、倒计时取最早」：
  // 分开展示两个徽标会挤压标题行，且用户无法一眼看出总次数。
  const opportunityBadge = mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: fiveHourCardVisible && resetUi.opportunityVisible,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: weeklyCardVisible && resetUi.week.opportunityVisible,
    },
  ]);
  // [失败路径] 弹窗配置在渲染期构建：它依赖 cards 与 resetUi，
  // 缓存到 state 会在权益刷新后展示旧的百分比与重置时间。
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourLimit),
    resetUi,
    usageItems: cards.map((card) => {
      const percentage = resolveLimitRemainingPercentage(card.limit);
      return {
        color: card.progressColor,
        id: card.key,
        label: card.label,
        percentage,
        resetTime: formatQuotaResetTime({
          locale,
          value: card.limit.nextResetTime,
          format: card.resetTimeFormat,
          compactToday: card.resetTimeFormat === "dateTime",
        }),
        value: formatRemainingPercentage(locale, percentage),
      };
    }),
    weekEnabled: Boolean(weeklyLimit),
  });

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
        {(fiveHourCardVisible && resetUi.entry) || (weeklyCardVisible && resetUi.week.entry) ? (
          <CodingPlanQuotaResetOpportunity
            count={opportunityBadge.count}
            dialog={quotaResetDialog}
            dialogOpen={quotaResetDialogOpen}
            expiresAt={opportunityBadge.expiresAt}
            placement="inline"
            visible={opportunityBadge.visible}
            onDialogOpenChange={setQuotaResetDialogOpen}
          />
        ) : null}
      </div>
      <div className="flex w-full gap-2 max-sm:flex-col">
        {cards.map((card) => (
          <PlanUsageMetricCard
            key={card.key}
            action={
              // 额度标题旁入口只打开统一弹窗；真正核销由弹窗内对应类型按钮触发。
              // Bugfix：这里曾额外要求 opportunityBadge.count <= 1，多张机会时反而把
              // 卡上的重置入口藏掉（Usage 页已修，此处遗漏）。与 Usage 页口径对齐：
              // 有可用机会就展示，不因满额或多张隐藏。
              card.key === "fiveHour" &&
              resetUi.entry &&
              (resetUi.opportunityVisible ||
                resetUi.processing ||
                resetUi.entry.status === "completed") ? (
                <LocalizedCodingPlanQuotaResetAction
                  completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi)}
                  processing={resetUi.processing}
                  onOpenDialog={() => setQuotaResetDialogOpen(true)}
                />
              ) : card.key === "weekly" &&
                resetUi.week.entry &&
                (resetUi.week.opportunityVisible ||
                  resetUi.week.processing ||
                  resetUi.week.entry.status === "completed") ? (
                <LocalizedCodingPlanQuotaResetAction
                  completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi.week)}
                  processing={resetUi.week.processing}
                  resetType="WEEK"
                  onOpenDialog={() => setQuotaResetDialogOpen(true)}
                />
              ) : undefined
            }
            label={card.label}
            limit={card.limit}
            infoDescription={
              card.key === "serverMcp"
                ? intl.formatMessage({
                    id: "sidebar.usage.plan.zcodeMcpDescription",
                  })
                : undefined
            }
            progressColor={card.progressColor}
            resetTimeFormat={card.resetTimeFormat}
          />
        ))}
      </div>
    </div>
  );
}

interface CodingPlanUsageSummaryCard {
  key: string;
  label: string;
  limit: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}

// [失败路径] limit 缺失返回 null 而不是空卡：
// 下游据此过滤，保证「没有的额度不占位」（INV-20）。
function createCodingPlanUsageSummaryCard(card: {
  key: string;
  label: string;
  limit: UsageQuotaLimit | undefined;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}): CodingPlanUsageSummaryCard | null {
  // Coding Plan 剩余额度展示必须和 sidebar/context 一样只展示接口真实返回的额度项。
  // 不能再用 limits[0]/[1]/[2] 兜底，否则 provider 详情会固定出现三张卡并和其它入口不一致。
  // [事务] 这是「只展示真实额度」的唯一闸门：
  // 任何新增额度卡都必须经过它，不能用默认 limit 绕过。
  if (!card.limit) {
    return null;
  }
  return {
    key: card.key,
    label: card.label,
    limit: card.limit,
    progressColor: card.progressColor,
    resetTimeFormat: card.resetTimeFormat,
  };
}

// [失败路径] 标准四类与通用可展示项取或：
// 只看标准四类会让 Team Plan 的 CREDIT_LIMIT 被判成「无额度」。
function hasDisplayableCodingPlanUsageLimits(limits: UsageQuotaLimit[]): boolean {
  return Boolean(
    findUsageLimit(limits, "TOKENS_LIMIT", 3, 5) ||
    findUsageLimit(limits, "TOKENS_LIMIT", 6) ||
    findUsageLimit(limits, "TIME_LIMIT", 5, 1) ||
    limits.some(isDisplayableUsageLimit),
  );
}

// [失败路径] 四个数值字段任一存在即可展示：
// 不同 backend 只填其中一两个，用单一字段判断会漏掉大量真实额度。
function isDisplayableUsageLimit(limit: UsageQuotaLimit): boolean {
  return (
    typeof limit.percentage === "number" ||
    typeof limit.remaining === "number" ||
    typeof limit.currentValue === "number" ||
    typeof limit.usage === "number"
  );
}

// [失败路径] TIME_LIMIT 复用「月 MCP 用量」文案属于已知近似：
// 通用卡只兜底未知类别，优先保证有可读标题而不是暴露内部 type。
function resolveGenericUsageLimitLabel(
  limit: UsageQuotaLimit,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  if (limit.type === "TIME_LIMIT") {
    return intl.formatMessage({
      id: "settings.usage.entitlementMonthlyMcpUsage",
    });
  }
  // Team Plan 的 quota limit 在测试环境可能不是个人 Coding Plan 的
  // TOKENS_LIMIT(3/5、6) 形态。此时仍应展示剩余额度，不能因为类型不在白名单就空白。
  return intl.formatMessage({
    id: "settings.modelProvider.planCard.usage.totalTokens",
  });
}

// [权衡] 单卡组件不感知 provider 与套餐：
// 它只接收 label/limit/颜色，因此能被通用卡与标准卡同时复用。
function PlanUsageMetricCard({
  action,
  infoDescription,
  label,
  limit,
  progressColor,
  resetTimeFormat,
}: {
  action?: ReactNode;
  infoDescription?: string;
  label?: string;
  limit?: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}) {
  const { locale } = useZCodeIntl();
  // [失败路径] null 表示「接口没有给任何可算字段」，
  // 此时显示 -- 而不是 0%，否则用户会把数据缺失误读为额度耗尽。
  const remainingPercentage = resolveLimitRemainingPercentage(limit);
  const progressPercentage = remainingPercentage ?? 0;
  // [失败路径] TIME_LIMIT 不展示模型：它是时间窗口额度，
  // usageDetails 里的模型名与这张卡无关（INV-26）。
  const modelLabel = limit && limit.type !== "TIME_LIMIT" ? formatLimitModels(limit) : "";
  const resetTime = formatQuotaResetTime({
    locale,
    value: limit?.nextResetTime,
    format: resetTimeFormat,
    compactToday: resetTimeFormat === "dateTime",
  });

  return (
    <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
      {label ? (
        // 固定 24px 会让 20px 界面字号的 30px 行盒溢出；最小高度既保持默认对齐，也允许大字号撑高。
        <div className="flex min-h-6 min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">{label}</span>
          {infoDescription ? (
            <ControlHintTooltip title={infoDescription} standalone>
              <button
                type="button"
                aria-label={infoDescription}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
                data-zcode-mcp-info="model-settings"
              >
                <InfoIcon className="size-3.5" aria-hidden="true" />
              </button>
            </ControlHintTooltip>
          ) : null}
          {action ? <span className="shrink-0">{action}</span> : null}
        </div>
      ) : null}
      {modelLabel ? (
        <div className={`truncate text-ui-xs text-foreground-subtle ${label ? "mt-1" : ""}`}>
          {modelLabel}
        </div>
      ) : null}
      <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
        <span className="text-ui-lg font-semibold leading-none text-foreground">
          {formatRemainingPercentage(locale, remainingPercentage)}
        </span>
        {resetTime ? (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{resetTime}</span>
        ) : null}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${progressPercentage}%`,
            backgroundColor: progressColor,
          }}
        />
      </div>
    </div>
  );
}

// [失败路径] unit 是必填、number 可选：
// 五小时要 unit=3 且 number=5，周额度只要 unit=6，调用方按语义传参。
function findUsageLimit(
  limits: UsageQuotaLimit[],
  type: UsageQuotaLimit["type"],
  unit: number,
  number?: number,
): UsageQuotaLimit | undefined {
  return limits.find(
    (limit) =>
      // zai team plan 返回 CREDIT_LIMIT，bigmodel 返回 TOKENS_LIMIT，
      // unit/number 语义一致。用 isSameLimitCategory 让两者等价命中。
      isSameLimitCategory(limit.type, type) &&
      limit.unit === unit &&
      (number == null || limit.number === number),
  );
}

// [事务] 两条计算路径有严格优先级：有 percentage 时不再用 remaining/number，
// 因为服务端的 percentage 才是最终口径，本地除法可能因四舍五入产生偏差。
function resolveLimitRemainingPercentage(limit: UsageQuotaLimit | undefined): number | null {
  // [失败路径] 先归一再反转：越界的 percentage（例如 -5 或 120）
  // 反转前 clamp 能保证结果仍落在 0~100。
  const usedPercentage = normalizeUsagePercentage(limit?.percentage);
  if (usedPercentage !== null) {
    // Coding Plan quota 接口的 percentage 是已用百分比，
    // Plan Card 属于“剩余额度”视图，需要和侧边栏剩余用量菜单一致反转展示。
    return Math.max(0, Math.min(100, 100 - usedPercentage));
  }
  const remaining = limit?.remaining;
  const total = limit?.number;
  if (
    typeof remaining === "number" &&
    Number.isFinite(remaining) &&
    typeof total === "number" &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return Math.max(0, Math.min(100, (remaining / total) * 100));
  }
  return null;
}

// [失败路径] 用 == null 同时覆盖 undefined 与 null：
// 接口可能显式下发 null 表示「暂无数据」。
function normalizeUsagePercentage(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

// [失败路径] 非有限值统一显示 --：
// Intl.NumberFormat 对 NaN 会输出 NaN%，比占位符更误导。
function formatRemainingPercentage(locale: string, value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "--";
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(Math.max(0, Math.min(100, value)))}%`;
}

// [失败路径] Set 去重后再拼接：同一模型可能因多个 usageDetail 重复出现，
// 不去重会显示成「GLM-4 / GLM-4 / GLM-4.5」。
function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  return Array.from(new Set(modelNames)).join(" / ");
}

// [失败路径] 归一后为空则回退原始 code：
// 纯符号的 modelCode 归一后为空串，直接展示会让额度卡丢失模型信息。
function formatModelCode(modelCode: string): string {
  const normalized = modelCode
    .replace(/^model:/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return normalized || modelCode;
}
