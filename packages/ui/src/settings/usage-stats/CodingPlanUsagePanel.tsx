/* eslint-disable max-lines -- Coding Plan usage 面板集中处理数据来源、额度卡片和用量图表，拆分会让账号级来源绑定状态更分散。 */
// ============================================================================
// CodingPlanUsagePanel.tsx — Coding Plan 用量面板（额度卡 / 活跃度 / 趋势 / 健康度）
//
// 职责边界：
//   - 只做展示与取数编排。HTTP、缓存、轮询、in-flight 去重都在
//     useUsageEntitlement / useCodingPlanUsageStats 里；本文件不直接请求、不写存储。
//   - 只服务「当前选中的 coding plan source」；切换连接由上层重挂组件完成，
//     因此这里没有同步 selectedSource 的 effect，也不持有 source 状态。
//
// 三条数据来源互不替代：
//   a) entitlement 快照 — 额度卡与 Server MCP 额度（账号级、按 provider/连接维度）
//   b) usage 快照 — 明细图表、活跃度、健康度（按 7d/30d 区间取数）
//   c) resetUi — 重置机会与核销状态（按 source + provider + accountAccess 绑定）
//
// 不变量（INV）。每条的「守住它的位置」是唯一允许的做法；改之前先读那几行。
//
// INV-01 三个 entitlement hook 同时挂载，但同一时刻只有一个 enabled=true。
//   守住它的位置：zai / bigmodel / team 三个 useUsageEntitlement 的 enabled 表达式。
//   改错故障：两个 hook 同时启用会各发一次 force 刷新，服务端按 provider 限流后
//   面板出现「一张卡有额度、另一张是空」的撕裂状态。
//
// INV-02 team plan 必须走 teamEntitlement，绝不能落进个人分支。
//   守住它的位置：effectiveEntitlement 的三元链，team 判断在最前面。
//   改错故障：team source 用个人 providerId 查询，缺 org/project，额度恒为 null。
//
// INV-03 个人分支的 cacheKey 必须绑定 providerFingerprint（providerId + accountAccess）。
//   守住它的位置：individualProviderFingerprint 与 buildUsageEntitlementCacheKey。
//   改错故障：切换同 provider 的两个账号时命中旧缓存，额度显示成上一个账号的。
//
// INV-04 team 分支的 cacheKey 用 source.id，不用 fingerprint。
//   守住它的位置：teamEntitlement.cacheKey。
//   改错故障：两个团队项目 fingerprint 可能相同（同 org），互相覆盖额度。
//
// INV-05 loadingSources 期间三个 hook 全部 disabled。
//   守住它的位置：每个 enabled 的首个条件 !loadingSources。
//   改错故障：source 未解析完就按 undefined provider 发请求，打开面板即 4xx。
//
// INV-06 额度卡数据源优先级：entitlement.quota > usage.quota。
//   守住它的位置：<CodingPlanQuotaCards quota={... ?? ...}> 的 ?? 链。
//   改错故障：重置后 entitlement 已是新值，卡片却回退到旧 usage 快照，
//   用户以为重置没生效而重复核销。
//
// INV-07 Server MCP 额度只能从 entitlement 的独立字段取，不在 quota.limits[] 里。
//   守住它的位置：resolveMcpQuotaLimit(effectiveEntitlementSnapshot) 的实参。
//   改错故障：改成 findCodingPlanQuotaLimit(limits, ...) 会永远为 null，
//   Server MCP 卡整块消失（不是显示 0，是消失）。
//
// INV-08 一张卡是否出现，取决于它的 limit 是否非空，与剩余百分比无关。
//   守住它的位置：cards 末尾的 .filter(Boolean(card.limit))。
//   改错故障：按百分比过滤会让「已用尽」的卡消失，用户分不清是没额度还是没加载。
//
// INV-09 重置机会徽标的可见性与「剩余 100%」无关。
//   守住它的位置：opportunityBadge 的 visible 只依赖 opportunityVisible 与 limit 存在。
//   改错故障：核销后剩余被改写为 100%，徽标被误藏，用户以为机会丢了。
//
// INV-10 五小时与周两个机会必须合并成一个徽标，倒计时取最早到期。
//   守住它的位置：mergeCodingPlanQuotaResetOpportunityBadges 的入参数组。
//   改错故障：拆成两个徽标会出现两个倒计时，用户按较早的计时却等较晚的才生效。
//
// INV-11 额度标题旁的入口只负责开弹窗，不直接发起核销。
//   守住它的位置：LocalizedCodingPlanQuotaResetAction 的 onOpenDialog。
//   改错故障：卡片上直接调 reset 会绕过弹窗里的类型选择，可能核销错类型。
//
// INV-12 刷新必须同时刷 usage 与 entitlement，且用 Promise.all 并发。
//   守住它的位置：handleUsageStatsRefresh。
//   改错故障：只刷 usage 会让额度卡停在旧值；串行 await 会让耗时等于两条 RPC 之和。
//
// INV-13 进入面板时必须主动以 silent:true、reason:"access" 刷一次 entitlement。
//   守住它的位置：首个 useEffect 内的 void effectiveEntitlementRefresh(...)。
//   改错故障：只依赖共享 TTL 会继续显示 sidebar/input 留下的旧快照。
//
// INV-14 图表组件必须保持 lazy 加载，不能在模块顶层静态 import。
//   守住它的位置：CodingPlanUsageLineChart / CodingPlanUsageBarChart 的 lazy()。
//   改错故障：Recharts 初始化触发 decimal.js-light 校验，Electron Linux 容器里
//   renderer 启动即白屏（连非 Usage 页面也起不来）。
//
// INV-15 图表系列选中数上限 3，且必须至少保留 1 条。
//   守住它的位置：toggleSeries 里的两处长度判断。
//   改错故障：放开上限后图例与图线互相遮挡；允许清空会让图表变成空坐标系。
//
// INV-16 数据 / 视图维度 / 快照时间变化时，选中集合重置为前 3 条。
//   守住它的位置：第二个 useEffect 的依赖数组。
//   改错故障：切 7d/30d 后沿用旧系列名，图例全灰、图表空白。
//
// INV-17 credits 摘要卡只在「真实存在 credits 数据」时展示。
//   守住它的位置：shouldShowCodingPlanUsageDetailSummary 的第二个 return。
//   改错故障：只有 token 数据的旧响应也显示 0 积分卡，用户以为积分被清零。
//
// INV-18 缺失值必须走 null/undefined 分支，不得用 0 兜底。
//   守住它的位置：formatCodingPlanRate 与 getQuotaRemainingPercentage 的 null 处理。
//   改错故障：把未知显示成 0% 或 0 积分，用户无法区分「没有数据」和「真的用完了」。
//
// INV-19 同一张卡的文字百分比与进度条宽度必须来自同一个 limit 对象。
//   守住它的位置：cards.map 内先算 percentage 再同时用于文本与 width。
//   改错故障：文字读 entitlement、条读 usage，同卡出现「85%」但条只到一半。
//
// INV-20 workspaceIdentity / workspacePath 目前刻意不使用（void 丢弃）。
//   守住它的位置：函数体开头的两个 void 语句。
//   改错故障：误接进请求会把账号级额度变成按工作区统计，与产品定义矛盾。
//
// INV-21 只在 error 存在时渲染提示，且不清空已有 snapshot。
//   守住它的位置：{error ? ... : null} 与三段式渲染分支。
//   改错故障：刷新失败就清空快照，会把一次网络抖动放大成「额度全没了」。
//
// INV-22 range 只能由本组件持有并下传，子区块不得各自存一份。
//   守住它的位置：useState range 与 CodingPlanUsageTrendsSection 的 props。
//   改错故障：两份 range 会在切换时出现「标题已变、图表还是旧区间」的错配。
// ============================================================================
import { Fragment, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { Check, InfoIcon, RefreshCw } from "lucide-react";
import type {
  CodingPlanModelData,
  CodingPlanToolData,
  CodingPlanUsageDetailMetric,
  CodingPlanUsageDetailSubject,
  CodingPlanUsageRange,
  CodingPlanUsageSnapshot,
  UsageQuotaLimit,
  UsageQuotaSnapshot,
} from "@zcode/shared";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { useCodingPlanUsageStats } from "@/hooks/useUsageStats.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  getQuotaRemainingPercentage,
  resolveMcpQuotaLimit,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import {
  buildCodingPlanModelLineChartSeries,
  buildCodingPlanToolLineChartSeries,
  buildCodingPlanUsageDetailLineChartSeries,
} from "@/settings/usage-stats/codingPlanUsageChartSeries.js";
import { UsageStatsErrorNotice } from "@/settings/usage-stats/UsageStatsErrorNotice.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatFullDay,
  formatSummaryCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { formatAppUsageDuration } from "@/settings/usage-stats/AppUsagePanel.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";

// [权衡] 这里做一次转出，是为了让使用方只从面板入口取 source 类型与构造器，
// 不必直接依赖 lib/codingPlanUsageSources。删掉转出会打断现有 import 路径。
export { buildCodingPlanUsageSources, type CodingPlanUsageSource };

/** Usage stats 独有的完整重置时刻格式；其它紧凑入口继续按各自规则展示。 */
// [权衡] 只有 Usage 页用 dateTime 完整格式；侧边栏/输入框仍用各自的紧凑格式。
// 统一成一处会让侧栏宽度被日期撑破，所以这里单独包一层，而不是改底层 formatter。
export function formatUsageStatsQuotaResetTime(
  locale: string,
  value: number | null | undefined,
): string | undefined {
  return formatQuotaResetTime({ locale, value, format: "dateTime" });
}

// Recharts 会在模块初始化阶段触发 decimal.js-light 的 LN10 校验，
// 在 Electron Linux 容器里会阻断整个 renderer 启动。图表按需加载后，
// 普通启动和 e2e 首页不会被 Usage 页图表依赖影响，打开 Usage 时也由局部边界隔离。
// [资源] 按需加载不是性能优化，而是启动可用的硬前提：
// Recharts 在模块初始化阶段触发 decimal.js-light 的 LN10 校验，Electron Linux 容器里
// 会抛错并阻断整个 renderer 启动，因此这两个 import 只能出现在 lazy 回调里。
// [失败路径] 懒加载失败由外层 UsageChartLoadBoundary 捕获并展示占位；
// 本文件不做 try/catch——在组件里吞掉加载错误会让图表区永久空白且无任何提示。
const CodingPlanUsageLineChart = lazy(() =>
  import("@/settings/usage-stats/CodingPlanUsageLineChart.js").then((module) => ({
    default: module.CodingPlanUsageLineChart,
  })),
);
// [权衡] 折线用于健康度（连续速度），柱状用于明细（离散分桶）。
// 两者共享同一套 lazy 边界与空态文案，避免同一页面出现两种加载态。
const CodingPlanUsageBarChart = lazy(() =>
  import("@/settings/usage-stats/CodingPlanUsageBarChart.js").then((module) => ({
    default: module.CodingPlanUsageBarChart,
  })),
);
// 系列色只取 token 变量，不写死十六进制：暗色主题由 CSS 变量整体切换，
// 写死会出现亮色配色在暗背景上对比度不足。
const CODING_PLAN_DETAIL_SERIES_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
] as const;
// [权衡] 3 是图例可读性的经验上限：再多会换行挤压图表高度，
// 且窄侧栏里 3 条以上的折线已无法区分。
const MAX_SELECTED_CODING_PLAN_DETAIL_SERIES = 3;
// 供设置页锚点滚动与深链定位；改动会打断外部文档与引导链接，属于对外契约。
const CODING_PLAN_USAGE_TRENDS_SECTION_ID = "coding-plan-usage-trends";
// [权衡] 这是展示层黑名单，不是 source 过滤：monitor 接口只回通用 provider 名，
// 只能在这里隐藏名字，不能把整个 source 从列表删掉（用户仍需要看到额度）。
const HIDDEN_CODING_PLAN_PROVIDER_NAMES = new Set(["BigModel - Coding Plan"]);
// 趋势只支持 7d / 30d；自定义区间在 Coding Plan 侧没有服务端支持，故用 Extract 收窄。
type CodingPlanUsageTrendRange = Extract<CodingPlanUsageRange, "7d" | "30d">;

// 面板入口。props 都是「当前选中」的只读快照，面板内部不持有 source 状态——
// 切换连接由上层重挂本组件，因此这里不需要同步 selectedSource 的 effect。
export function CodingPlanUsagePanel({
  loadingSources,
  selectedSource,
  workspaceIdentity,
  workspacePath,
}: {
  loadingSources: boolean;
  selectedSource?: CodingPlanUsageSource | null;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();
  // range 是唯一的面板级 UI 状态，其余全部由 source 与远端快照推导。
  // 默认 7d：与供应商侧的五小时/周额度窗口对齐，避免首屏就拉 30d 大响应。
  // [资源] 切区间会触发一次新请求，因此不做「先乐观渲染再回填」，
  // 否则会短暂出现两种区间的混合数据。
  const [range, setRange] = useState<CodingPlanUsageTrendRange>("7d");
  // [权衡] props 保留但刻意不使用：额度是账号级的，按工作区聚合会得出错误结论。
  // 用 void 显式丢弃而不是删掉 prop，是为了让调用方保持统一签名、避免误以为漏传。
  void workspaceIdentity;
  // 同上；workspacePath 只预留给未来的深链定位，当前不参与任何请求参数。
  void workspacePath;
  // 所有下游逻辑以 effectiveSource 为唯一真源，避免 selectedSource 在渲染间抖动。
  const effectiveSource = selectedSource ?? null;
  // providerId 决定走哪个 entitlement 分支；为 undefined 时三个 hook 全部 disabled。
  const effectiveProviderId = effectiveSource?.providerId;
  // [权衡] 用 "planKind" in accountAccess 做窄化，而不是读布尔字段：
  // accountAccess 是联合类型，只有 team 变体带 planKind，in 判断同时完成运行时分派与类型收窄。
  const effectiveSourceIsTeamPlan = Boolean(
    effectiveSource &&
    "planKind" in effectiveSource.accountAccess &&
    effectiveSource.accountAccess.planKind === "team-coding-plan",
  );
  // [并发] fingerprint 必须把 accountAccess 一起序列化：同一 providerId 下可能并存
  // 个人 key 与订阅账号，只用 providerId 做 key 会让两条查询互相覆盖。
  // team 分支不用它（走 source.id），这里显式置空避免无意义的 JSON.stringify。
  const individualProviderFingerprint = effectiveSourceIsTeamPlan
    ? ""
    : effectiveSource?.accountAccess
      ? JSON.stringify([effectiveSource.providerId, effectiveSource.accountAccess])
      : "";
  // 个人 zai 分支。enabled 的四个条件是与的关系，缺一不可：
  //   !loadingSources —— source 未解析完不发请求；
  //   providerId 命中 —— 否则会拿到别的 provider 的额度；
  //   fingerprint 非空 —— 否则 cacheKey 退化成常量、跨账号串数据；
  //   !team —— team 必须走下面的 teamEntitlement。
  const zaiEntitlement = useUsageEntitlement({
    // 原只按 zai providerId 启用，没区分个人/团队，team source 会被
    // 当成个人 zaiEntitlement 查询（缺 org/project）。加上 !effectiveSourceIsTeamPlan
    // 后，zai team source 改走 teamEntitlement 分支。
    enabled:
      !loadingSources &&
      effectiveProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan &&
      Boolean(individualProviderFingerprint) &&
      !effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: individualProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  // 个人 bigmodel 分支，结构与 zai 完全对称；刻意不抽工厂函数：
  // enabled / cacheKey 一旦参数化，后续很容易在其中一处漏改而静默串额度。
  const bigmodelEntitlement = useUsageEntitlement({
    enabled:
      !loadingSources &&
      effectiveProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan &&
      Boolean(individualProviderFingerprint) &&
      !effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: individualProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  // team 分支只按 effectiveSourceIsTeamPlan 路由，providerId 跟随 source 动态取，
  // 因此 zai team 与 bigmodel team 共用这段代码，同时用 source.id 作 cacheKey 不会互相污染。
  const teamEntitlement = useUsageEntitlement({
    // 原硬绑 bigmodelCodingPlan providerId，zai team source 永远进不来。
    // 改为按 effectiveSourceIsTeamPlan 路由，providerId 按 effectiveSource 动态取，
    // zai team → zaiCodingPlan，bigmodel team → bigmodelCodingPlan。
    enabled: !loadingSources && effectiveSourceIsTeamPlan,
    includeSubscription: true,
    preferredProviderId:
      effectiveProviderId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: effectiveSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: effectiveSource?.id,
    refreshOnMount: false,
  });
  // 原 zai providerId 一律走 zaiEntitlement（个人），把 team plan 漏掉。
  // 改为先判 team plan，命中走 teamEntitlement；否则按 providerId 走个人分支。
  // [失败路径] 判断顺序不可交换：team 必须在 providerId 之前。
  // 若先判 providerId，team source（providerId 与个人相同）会被个人分支截走。
  const effectiveEntitlement = effectiveSourceIsTeamPlan
    ? teamEntitlement
    : effectiveProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
      ? zaiEntitlement
      : bigmodelEntitlement;
  // 只取快照与 refresh：hook 的 loading/error 不参与渲染——
  // 额度不可用时宁可回退到 usage 快照，也不让整块面板进入错误态。
  const effectiveEntitlementSnapshot = effectiveEntitlement.snapshot;
  // 常用引用的局部别名，供下面两个 useCallback / useEffect 作为稳定依赖使用。
  const effectiveEntitlementRefresh = effectiveEntitlement.refresh;
  // 供额度卡内的重置流程回调。silent:true 是有意为之：
  // 核销后服务端会自行改写额度，这里只需静默回填，不弹全局 loading。
  const handleResetEntitlementRefresh = useCallback(async () => {
    await effectiveEntitlementRefresh?.({ force: true, silent: true });
  }, [effectiveEntitlementRefresh]);
  const {
    snapshot,
    loading,
    error,
    refresh: refreshCodingPlanUsage,
  // usage 快照与 entitlement 是两条独立查询：前者供图表与活跃度，后者只供额度。
  // enabled 同样受 loadingSources 约束；providerId 缺失时不发请求。
  } = useCodingPlanUsageStats(range, {
    enabled: !loadingSources && Boolean(effectiveProviderId),
    preferredProviderId: effectiveProviderId,
    accountAccess: effectiveSource?.accountAccess,
    customStartDate: null,
    customEndDate: null,
  });
  // [并发] 两个刷新必须并发：串行会让「点一次刷新」的耗时等于两条 RPC 之和。
  // [失败路径] 用 Promise.all 而非 allSettled，任一失败都冒泡给调用方；
  // 静默吞掉会让用户以为刷新成功但数据没变。
  const handleUsageStatsRefresh = useCallback(async () => {
    await Promise.all([
      refreshCodingPlanUsage({ force: true }),
      effectiveEntitlementRefresh?.({ force: true, silent: true }),
    ]);
  }, [effectiveEntitlementRefresh, refreshCodingPlanUsage]);
  useEffect(() => {
    if (!effectiveProviderId || !effectiveEntitlementRefresh) {
      return;
    }

    // Usage 页的 Quota Remaining 优先展示 entitlement quota。
    // 打开 Coding Plan Usage 页面时，如果只依赖共享 TTL，可能继续显示 sidebar/input 留下的旧快照。
    // [资源] 进入面板主动刷一次 entitlement（silent），补偿共享 TTL 可能留下的旧快照。
    // 依赖只放 refresh 与 providerId：把 snapshot 放进来会在每次回填后再触发刷新，形成自激。
    void effectiveEntitlementRefresh({ silent: true, reason: "access" });
  }, [effectiveEntitlementRefresh, effectiveProviderId]);

  // 首次加载（还没有任何 source）展示加载态。必须与下面「加载完成但没有 source」区分，
  // 否则会在 source 解析期间闪一下「未连接」。
  if (loadingSources && !effectiveSource) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
        description={intl.formatMessage({
          id: "settings.usage.codingPlanLoadingDescription",
        })}
      />
    );
  }

  // [失败路径] 解析完成仍没有 source：当前连接不支持 coding plan（或未登录）。
  // 这里只返回 UsageEmptyState，不报错也不引导登录，登录引导由设置页整体负责。
  if (!loadingSources && !effectiveSource) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({
          id: "settings.usage.codingPlanCurrentConnectionTitle",
        })}
        description={intl.formatMessage({
          id: "settings.usage.codingPlanCurrentConnectionDescription",
        })}
      />
    );
  }

  return (
    <div className="space-y-5">
      {error ? <UsageStatsErrorNotice error={error} /> : null}

      {loading && !snapshot ? (
        // Coding Plan 来自供应商 monitor API，加载说明要和 App Usage 的本地统计区分。
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.codingPlanLoadingDescription",
          })}
        />
      ) : snapshot ? (
        <>
          <CodingPlanQuotaCards
            quota={effectiveEntitlementSnapshot?.quota ?? snapshot.quota}
            mcpQuotaLimit={resolveMcpQuotaLimit(effectiveEntitlementSnapshot)}
            generatedAt={snapshot.generatedAt}
            sourceKey={effectiveSource?.id}
            preferredProviderId={effectiveProviderId}
            accountAccess={effectiveSource?.accountAccess}
            onEntitlementRefresh={handleResetEntitlementRefresh}
            onUsageStatsRefresh={handleUsageStatsRefresh}
          />
          <CodingPlanActivitySection snapshot={snapshot} />
          <CodingPlanUsageTrendsSection
            range={range}
            snapshot={snapshot}
            // 直接把 setState 下传：区间变更没有副作用，不需要包一层 useCallback。
            onRangeChange={setRange}
          />
        </>
      ) : null}
    </div>
  );
}

// 供应商展示名解析。Team Plan 复用 BigModel 的 provider，monitor 接口只回通用名，
// 因此优先用当前连接的 label，再回退快照名；返回 undefined 表示「整行不展示」。
export function resolveCodingPlanUsageProviderName({
  fallbackProviderName,
  snapshot,
  source,
}: {
  fallbackProviderName?: string;
  snapshot: CodingPlanUsageSnapshot | null;
  source: CodingPlanUsageSource | null;
}): string | undefined {
  // 修复原因：Team Plan 复用 BigModel Coding Plan provider，monitor 接口只知道通用 provider 名。
  // 使用统计必须按当前 Team 连接的展示 key 取团队项目名，不能继续识别已删除的 team-plan key。
  // [权衡] 用 source.id 的 team: 前缀识别团队连接，而不是读 accountAccess：
  // 这里是纯展示函数，调用方可能只拿到 source 的剪裁副本。
  if (source?.id.startsWith("team:")) {
    return source.label || snapshot?.sourceProvider.name || fallbackProviderName;
  }
  // 非 team 分支的优先级：快照名 > 连接 label > 上层 fallback。
  // 快照名优先是因为它来自服务端真实返回，能反映改名后的现状。
  const providerName = snapshot?.sourceProvider.name ?? source?.label ?? fallbackProviderName;
  // 黑名单命中返回 undefined 而非空串：调用方据此决定是否渲染整行，
  // 空串会留下一个高度不为零的空标签。
  return providerName && !HIDDEN_CODING_PLAN_PROVIDER_NAMES.has(providerName)
    ? providerName
    : undefined;
}

// 区间选择器只是 SegmentedTabs 的薄包装，不持有状态；value/onChange 全透传，
// 保证 range 的唯一真源仍在面板顶层（INV-22）。
function CodingPlanRangeSelector({
  range,
  onRangeChange,
}: {
  range: CodingPlanUsageTrendRange;
  onRangeChange: (range: CodingPlanUsageTrendRange) => void;
}) {
  // 数组顺序即展示顺序；7d 在前，因为它是默认值也是最常用区间。
  const options: CodingPlanUsageTrendRange[] = ["7d", "30d"];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedTabs
        value={range}
        options={options}
        labelIdPrefix="settings.usage.codingPlanRange"
        // 只做类型断言不做运行时校验：options 与泛型参数同源，非法值不可能从 UI 产生。
        onChange={(value) => onRangeChange(value as CodingPlanUsageTrendRange)}
      />
    </div>
  );
}

// 额度卡区域。四个候选卡（五小时 / 每周 / MCP / Server MCP）里后两者数据源完全不同：
// 前两者来自 quota.limits[]，Server MCP 来自 entitlement 的独立字段。
function CodingPlanQuotaCards({
  quota,
  mcpQuotaLimit,
  generatedAt,
  sourceKey,
  preferredProviderId,
  accountAccess,
  onEntitlementRefresh,
  onUsageStatsRefresh,
}: {
  quota: UsageQuotaSnapshot | null;
  /** 官方 Server MCP 额度不在 quota.limits[] 里，由 entitlement 快照的独立字段传入。 */
  mcpQuotaLimit: UsageQuotaLimit | null;
  generatedAt: number;
  sourceKey: string | undefined;
  preferredProviderId: string | undefined;
  accountAccess:
    | import("@zcode/shared").ZCodeProviderAccountAccess
    | import("@zcode/shared").ZCodeAccountAccess
    | undefined;
  onEntitlementRefresh: () => void | Promise<void>;
  onUsageStatsRefresh: () => void | Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  // 弹窗开关放在卡片层而不是面板层：弹窗内容依赖 resetUi（由本层创建），
  // 上提会把 resetUi 的生命周期一起上提，导致额度卡卸载后仍在轮询。
  // 本地开关只控制显隐，真正的核销状态在 useCodingPlanQuotaResetUi 内。
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  // [事务] resetUi 以 sourceKey + providerId + accountAccess 为身份绑定；
  // 三者任一变化都会重建，旧的核销回调随之失效——这是防止「切换账号后把 A 的核销结果
  // 写到 B 的卡片上」的关键。不要为了少一次重建而把身份参数从依赖里去掉。
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey,
    preferredProviderId,
    accountAccess,
    onEntitlementRefresh,
  });
  // quota 可能为 null（entitlement 尚未回填且 usage 也没有额度），统一归一化为空数组，
  // 下游 findCodingPlanQuotaLimit 因此不需要再做 null 判断。
  const limits = quota?.limits ?? [];
  // 五小时窗：TOKENS_LIMIT 的第 3 档（索引从 1 起），对应 5 小时窗口。
  // resolveCodingPlanQuotaResetLimit 会用 resetUi.entry 覆盖 nextResetTime 等展示字段。
  const fiveHourLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  // 周窗：TOKENS_LIMIT 的第 6 档；与五小时窗共享同一套展示与重置逻辑。
  const weeklyLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  // 五小时与周机会合并为一个徽标,次数累加,倒计时取最早到期的一档。
  // Bugfix：曾用「剩余 100% 则重置无收益」隐藏徽标与按钮。核销会把剩余改写成 100%，
  // 同类型余下的机会随即被藏掉，用户以为卡丢了。只要额度存在且有可用机会就展示。
  // [权衡] 合并而非并列：两类机会的倒计时语义相同（最早到期者决定紧迫度），
  // 拆成两个徽标会让用户误以为要分别处理。
  // visible 只在「该窗口 limit 存在」时才可能为真，否则会出现「没有五小时额度却提示可重置」。
  const opportunityBadge = mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(fiveHourLimit) && resetUi.opportunityVisible,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(weeklyLimit) && resetUi.week.opportunityVisible,
    },
  ]);
  // 四张卡的声明顺序即展示顺序；limit 为 null 的卡在下面被整体过滤掉。
  // 每张卡单独指定 progressColor，避免按索引取色后因过滤导致颜色与语义错位。
  const cards = [
    {
      key: "fiveHour",
      label: intl.formatMessage({
        id: "settings.usage.entitlementFiveHourUsage",
      }),
      limit: fiveHourLimit,
      progressColor: "var(--color-usage-chart-1)",
    },
    {
      key: "weekly",
      label: intl.formatMessage({
        id: "settings.usage.entitlementWeeklyUsage",
      }),
      limit: weeklyLimit,
      progressColor: "var(--color-usage-chart-2)",
    },
    {
      key: "monthlyTool",
      label: intl.formatMessage({
        id: "settings.usage.entitlementMonthlyMcpUsage",
      }),
      // 月度工具额度：走 TIME_LIMIT 而不是 TOKENS_LIMIT，单位是时长而非 token，
      // 因此它不会参与五小时/周的重置机会合并。
      limit: findCodingPlanQuotaLimit(limits, "TIME_LIMIT", 5, 1),
      progressColor: "var(--color-usage-chart-3)",
    },
    {
      key: "serverMcp",
      label: intl.formatMessage({
        id: "settings.usage.entitlementServerMcpUsage",
      }),
      // INV-07：Server MCP 只认 entitlement 的独立字段，不在 limits[] 里查。
      limit: mcpQuotaLimit,
      progressColor: "var(--color-usage-chart-5)",
    },
  // 类型守卫式过滤：把 limit 收窄为非空，后续 map 内无需再判空。
  // 注意过滤的是「卡片是否存在」，不是「百分比是否大于 0」（INV-08）。
  ].filter(
    (
      card,
    ): card is {
      key: string;
      label: string;
      limit: UsageQuotaLimit;
      progressColor: string;
    } => Boolean(card.limit),
  );

  // 四个候选全无额度时整块不渲染：这是「该连接没有 coding plan 额度」的正常状态，
  // 不是错误，因此不占位、不报错。
  if (cards.length === 0) {
    return null;
  }

  // 这两个布尔只用于「徽标是否挂载」，与卡片自身是否存在解耦：
  // Server MCP 卡存在而五小时卡不存在时，不应渲染五小时重置机会。
  const fiveHourCardVisible = cards.some((card) => card.key === "fiveHour");
  // weeklyCardVisible 与 fiveHourCardVisible 各自 cards.some 判断，不能合并成「有任一卡」。
  const weeklyCardVisible = cards.some((card) => card.key === "weekly");
  // [权衡] 弹窗配置在渲染期构造：内容与当前可见卡片强相关，
  // 放进 useMemo 反而会因 resetUi 的高频倒计时更新而反复失效。
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourLimit),
    resetUi,
    usageItems: cards.map((card) => ({
      color: card.progressColor,
      id: card.key,
      label: card.label,
      percentage: getQuotaRemainingPercentage(card.limit),
      // 这里与卡片正文使用同一个 formatter，保证弹窗与卡片的重置时间措辞一致。
      resetTime: formatUsageStatsQuotaResetTime(locale, card.limit.nextResetTime),
      value: formatQuotaRemainingPercentage(locale, card.limit),
    })),
    weekEnabled: Boolean(weeklyLimit),
  });

  // Quota remaining 的响应式只允许整组纵向或整组横向。
  // 额度项（最多 4 个：5 小时 / 每周 / MCP / Server MCP）不能在中间断点排成 n+1，
  // 否则信息组会被视觉拆散。
  // [权衡] 不允许 n+1 折行：额度项是同一组语义，中间断点若排成 3+1，
  // 视觉上会把 Server MCP 误读成「另一类额度」。因此只有整组纵向 / 整组横向两档。
  const quotaCardsLayoutClass = "flex flex-col gap-3 lg:flex-row";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-ui-lg font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
          </h3>
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
        <div className="flex flex-wrap items-center justify-end gap-2 text-ui-base text-foreground-subtle">
          <span>{formatCodingPlanRefreshTime(locale, intl, generatedAt)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "settings.usage.refresh" })}
            onClick={() => {
              void onUsageStatsRefresh();
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{intl.formatMessage({ id: "settings.usage.refresh" })}</span>
          </Button>
        </div>
      </div>
      <div className={quotaCardsLayoutClass}>
        {cards.map((card) => {
          // 返回 null 表示「分母未知」，此处兜底 0 只用于进度条宽度；
          // 文本仍显示 --，二者不一致是刻意的：未知值不应画成满条。
          const percentage = getQuotaRemainingPercentage(card.limit) ?? 0;
          // 每张卡独立格式化；Server MCP 的 nextResetTime 可能为 null（无窗口概念），此时不渲染。
          const resetTime = formatUsageStatsQuotaResetTime(locale, card.limit.nextResetTime);
          return (
            <div key={card.key} className="min-w-0 flex-1 rounded-xl bg-surface/70 p-4">
              {/* min-h 与重置动作(h-5)对齐:没有动作的额度卡也保持同高,避免同排数值/进度条错位。 */}
              <div className="flex min-h-5 min-w-0 items-center gap-1">
                <span className="min-w-0 truncate text-ui-base text-foreground">{card.label}</span>
                {card.key === "serverMcp" ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "sidebar.usage.plan.zcodeMcpDescription",
                    })}
                    standalone
                  >
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "sidebar.usage.plan.zcodeMcpDescription",
                      })}
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
                      data-zcode-mcp-info="usage-stats"
                    >
                      <InfoIcon className="size-3.5" aria-hidden="true" />
                    </button>
                  </ControlHintTooltip>
                ) : null}
                {/* 额度标题旁入口只打开统一弹窗；真正核销由弹窗内对应类型按钮触发。 */}
                {card.key === "fiveHour" &&
                resetUi.entry &&
                (resetUi.opportunityVisible ||
                  resetUi.processing ||
                  resetUi.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi)}
                    processing={resetUi.processing}
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                // 周入口与五小时入口共用同一个弹窗，靠 resetType 区分目标；不要为此拆成两个弹窗。
                ) : card.key === "weekly" &&
                  resetUi.week.entry &&
                  (resetUi.week.opportunityVisible ||
                    resetUi.week.processing ||
                    resetUi.week.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi.week)}
                    processing={resetUi.week.processing}
                    // 显式标注核销类型；缺省值代表五小时窗，因此五小时那侧不传这个 prop。
                    resetType="WEEK"
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : null}
              </div>
              <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
                <span className="text-ui-xl font-semibold text-foreground">
                  {formatQuotaRemainingPercentage(locale, card.limit)}
                </span>
                {resetTime ? (
                  <span className="min-w-0 truncate text-ui-base text-foreground-subtle">
                    {resetTime}
                  </span>
                ) : null}
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-background">
                <div
                  // min-w-2 保证极低百分比也能看到一小段颜色，避免「0.4% 看起来像没渲染」。
                  className="min-w-2 h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                  style={{
                    // 宽度只接受 0..100 的百分比；上游 getQuotaRemainingPercentage 已做夹取，此处不重复校验。
                    width: `${percentage}%`,
                    backgroundColor: card.progressColor,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// CodingPlanUsageTrendsSection 只排布标题、区间选择与两个子区块，数据由上层传入。
function CodingPlanUsageTrendsSection({
  range,
  snapshot,
  onRangeChange,
}: {
  range: CodingPlanUsageTrendRange;
  snapshot: CodingPlanUsageSnapshot;
  onRangeChange: (range: CodingPlanUsageTrendRange) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    // id 与常量同源，保证深链锚点不会与代码里的字面量漂移。
    <section id={CODING_PLAN_USAGE_TRENDS_SECTION_ID} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.trendsTitle" })}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <CodingPlanRangeSelector range={range} onRangeChange={onRangeChange} />
        </div>
      </div>
      <CodingPlanUsageDetailSection snapshot={snapshot} />
      <CodingPlanHealthSection snapshot={snapshot} />
    </section>
  );
}

// 活跃度概览：五项生命周期指标 + 热力图，全部来自 snapshot.activity，不随 range 变化。
function CodingPlanActivitySection({ snapshot }: { snapshot: CodingPlanUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  // summary 是快照的一部分，不做本地聚合，避免前后端口径不一致。
  const summary = snapshot.activity.summary;
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTotalTokens" }),
      value: formatSummaryCompactTokenUsage(locale, summary.totalTokens),
    },
    {
      // 日期直接拼进标签会在窄卡片中被截断；固定标题保持可读，日期改由信息图标按需展示。
      // 五项指标顺序固定；峰值一项额外携带日期，由信息图标按需展示。
      // [权衡] 日期不拼进标签：窄卡片里会先被 truncate 吃掉，反而看不到指标名。
      label: intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" }),
      peakDailyTokensDate: summary.peakDailyTokensDate,
      value: formatSummaryCompactTokenUsage(locale, summary.peakDailyTokens),
    },
    {
      // 修复回归：CodingPlanActivitySummary 只有 totalUsageDurationMs（累计使用时长），
      // longestSessionMs 是 App Usage 侧的字段，不能使用“最长聊天时长”标签。
      // [失败路径] 必须用 totalUsageDurationMs，不能用 longestSessionMs：
      // 后者是 App Usage 的「最长聊天时长」，字段语义不同，用错会显示成同一天的最长会话。
      label: intl.formatMessage({ id: "settings.usage.totalUsageDuration" }),
      value: formatAppUsageDuration(summary.totalUsageDurationMs, intl),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.currentStreak" }),
      // 数值与单位分开格式化：单位走 i18n，数值走 locale 紧凑格式，不能拼成一个模板串。
      value: `${formatCompactNumber(locale, summary.currentStreakDays)} ${intl.formatMessage({
        id: "settings.usage.duration.day",
      })}`,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestStreak" }),
      value: `${formatCompactNumber(locale, summary.longestStreakDays)} ${intl.formatMessage({
        id: "settings.usage.duration.day",
      })}`,
    },
  ];

  return (
    <section className="space-y-4">
      <h3 className="text-ui-lg font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.activityTitle" })}
      </h3>
      <div className="flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center">
        {items.map((item, index) => (
          <Fragment key={item.label}>
            {index > 0 ? (
              <div aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
            ) : null}
            <div className="min-w-0 flex-1 px-4 py-3 text-center">
              <div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>
              <div className="mt-1 flex min-w-0 items-center justify-center gap-1 text-ui-base text-foreground-subtle">
                <span className="min-w-0 truncate">{item.label}</span>
                {item.peakDailyTokensDate ? (
                  // 日期通过 tooltip 展示；外层同时设 tabIndex=0 与 aria-label，保证键盘与读屏可达。
                  <ControlHintTooltip title={formatFullDay(locale, item.peakDailyTokensDate)}>
                    <span
                      className="inline-flex size-4 items-center justify-center"
                      tabIndex={0}
                      aria-label={formatFullDay(locale, item.peakDailyTokensDate)}
                    >
                      <InfoIcon className="size-3.5" aria-hidden="true" />
                    </span>
                  </ControlHintTooltip>
                ) : null}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
      {snapshot.activity.heatmap.weeks.length ? (
        <UsageHeatmap
          locale={locale}
          intl={intl}
          weeks={snapshot.activity.heatmap.weeks}
          countMetric="tools"
        />
      ) : null}
    </section>
  );
}

// 用量明细：metric（credits/usage）× subject（model/tool）两个维度，
// 外加最多 3 条系列的可视化选择，三者共同决定图表数据。
function CodingPlanUsageDetailSection({ snapshot }: { snapshot: CodingPlanUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  // 默认 credits：有积分时优先展示积分；旧接口会因 hasCreditUsageData=false 自动退回用量。
  const [metric, setMetric] = useState<CodingPlanUsageDetailMetric>("credits");
  // subject 默认取 "model"，因为多数用户先看哪个模型的消耗最高。
  const [subject, setSubject] = useState<CodingPlanUsageDetailSubject>("model");
  // 初始为空，由下面的 effect 在拿到 allSeries 后填入前 3 条；
  // 不在此硬编码名字，因为系列名来自服务端且会随模型上下线变化。
  const [selectedSeriesNames, setSelectedSeriesNames] = useState<string[]>([]);
  // activeSummary 只用于摘要卡（缓存命中率/积分/日均），图表数据另取完整列表。
  const activeSummary = subject === "model" ? snapshot.detail.model : snapshot.detail.tool;
  // 是否「真的有积分数据」决定三件事：metric 切换器是否出现、摘要卡是否出现、
  // 系列构造走 credit 还是 usage。三者必须同源，不能各自判断。
  const hasCreditUsageData = hasCodingPlanCreditUsageData({
    summary: activeSummary,
    modelDataList: snapshot.modelUsage.modelDataList,
    toolDataList: snapshot.toolUsage.toolDataList,
  });
  // 摘要卡单独判定：只有 token 数据的旧响应不展示积分卡，
  // 因此这里在 hasCreditUsageData 之外又加了一层 credits 正值判断。
  const showDetailSummary = shouldShowCodingPlanUsageDetailSummary({
    summary: activeSummary,
    modelDataList: subject === "model" ? snapshot.modelUsage.modelDataList : [],
    toolDataList: subject === "tool" ? snapshot.toolUsage.toolDataList : [],
  });
  // xTime 与 granularity 必须与 subject 同步切换：混用会让横轴刻度数对不上数据点。
  const activeChartMeta =
    subject === "model"
      ? {
          granularity: snapshot.modelUsage.granularity,
          xTime: snapshot.modelUsage.xTime,
        }
      : {
          granularity: snapshot.toolUsage.granularity,
          xTime: snapshot.toolUsage.xTime,
        };
  // [权衡] 系列构造分两条路：有积分走 metric，无积分走旧版的 model/tool 固定构造。
  // 不要合并成一个函数——两条路入参形状不同，合并后必然出现大量可选参数。
  const allSeries = useMemo(() => {
    const series = hasCreditUsageData
      ? buildCodingPlanUsageDetailLineChartSeries({
          metric,
          subject,
          modelDataList: snapshot.modelUsage.modelDataList,
          toolDataList: snapshot.toolUsage.toolDataList,
        })
      : subject === "model"
        ? buildCodingPlanModelLineChartSeries(snapshot.modelUsage.modelDataList)
        : buildCodingPlanToolLineChartSeries(snapshot.toolUsage.toolDataList);
    // 色板按索引取模分配，保证同一次渲染内系列颜色稳定；
    // `?? CODING_PLAN_DETAIL_SERIES_COLORS[0]` 只是满足 noUncheckedIndexedAccess 的类型兜底。
    return series.map((item, index) => ({
      ...item,
      color:
        CODING_PLAN_DETAIL_SERIES_COLORS[index % CODING_PLAN_DETAIL_SERIES_COLORS.length] ??
        CODING_PLAN_DETAIL_SERIES_COLORS[0],
    }));
  }, [
    hasCreditUsageData,
    metric,
    snapshot.modelUsage.modelDataList,
    snapshot.toolUsage.toolDataList,
    subject,
  ]);
  // 用 Set 做 O(1) 命中判断；selectedSeriesNames 保持数组以维持用户选择顺序。
  const selectedSeriesNameSet = useMemo(() => new Set(selectedSeriesNames), [selectedSeriesNames]);
  // 只把选中的系列交给图表；未选中的系列不参与渲染，也不参与 totalValue 求和。
  const visibleSeries = useMemo(
    () => allSeries.filter((item) => selectedSeriesNameSet.has(item.name)),
    [allSeries, selectedSeriesNameSet],
  );
  // 图例「合计」= 当前可见系列之和，随选择变化。这是刻意的：
  // 若用全部系列求和，用户取消勾选后合计不变会显得像 bug。
  const totalValue = visibleSeries.reduce(
    (sum, item) => sum + item.values.reduce((itemSum, value) => itemSum + value, 0),
    0,
  );
  // valueKind 决定数值格式化（token 紧凑单位 / 积分 / 次数），
  // 与 hasCreditUsageData 强绑定：只有积分模式下 usage 才可能是 credit。
  const valueKind = hasCreditUsageData
    ? metric === "credits"
      ? "credit"
      : subject === "model"
        ? "token"
        : "count"
    : subject === "model"
      ? "token"
      : "count";
  // 旧接口没有 metric 概念，统一传 usage，让图表按原始用量渲染。
  const valueMetric = hasCreditUsageData ? metric : "usage";
  // 单位在积分/token 下必填；tool 的 usage 是次数，无单位，返回 null 时不渲染单位节点。
  const detailUnit =
    valueKind === "token"
      ? intl.formatMessage({ id: "settings.usage.tokenUnit" })
      : valueKind === "credit"
        ? intl.formatMessage({ id: "settings.usage.creditUnit" })
        : null;

  useEffect(() => {
    setSelectedSeriesNames(
      allSeries.slice(0, MAX_SELECTED_CODING_PLAN_DETAIL_SERIES).map((item) => item.name),
    );
  // [失败路径] 依赖带 snapshot.generatedAt：每次远端刷新都重新落到前 3 条；
  // 否则模型上下线后旧系列名会永久留在选择里，图例全灰。
  }, [allSeries, hasCreditUsageData, metric, subject, snapshot.generatedAt]);

  // 选择切换三条规则：
  //   1. 已选且只剩 1 条 → 保持不变（图表不允许空）；
  //   2. 已选且多于 1 条 → 移除；
  //   3. 未选且已达上限 → 挤掉最早选择的一条（FIFO），而不是拒绝新增。
  const toggleSeries = useCallback((name: string) => {
    setSelectedSeriesNames((current) => {
      if (current.includes(name)) {
        // 保底 1 条：清空会让图表退化成空坐标系，用户无法判断是没数据还是没选。
        if (current.length <= 1) {
          return current;
        }
        return current.filter((item) => item !== name);
      }
      // FIFO 淘汰：保留最近 3 次选择，符合「刚点的那个必须显示」的直觉。
      if (current.length >= MAX_SELECTED_CODING_PLAN_DETAIL_SERIES) {
        return [...current.slice(1), name];
      }
      return [...current, name];
    });
  }, []);

  return (
    <section className="space-y-4">
      {showDetailSummary ? <CodingPlanUsageDetailSummary summary={activeSummary} /> : null}
      <div className="rounded-xl bg-surface/70 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {hasCreditUsageData ? (
            <>
              <SegmentedTabs
                value={metric}
                options={["credits", "usage"]}
                labelIdPrefix="settings.usage.codingPlanMetric"
                // metric 变更会重算 hasCreditUsageData 之外的系列构造，并触发下面的选择重置 effect。
                onChange={(value) => setMetric(value as CodingPlanUsageDetailMetric)}
              />
              <div aria-hidden="true" className="h-4 w-px bg-border" />
            </>
          ) : null}
          <SegmentedTabs
            value={subject}
            options={["model", "tool"]}
            labelIdPrefix="settings.usage.codingPlanSubject"
            // subject 变更同时切换摘要、xTime/granularity 与系列来源，三者必须一起变。
            onChange={(value) => setSubject(value as CodingPlanUsageDetailSubject)}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-ui-sm">
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-ui-sm"
            // 「合计」按钮同时充当重置入口：点击把选择恢复为前 3 条。
            // 用 button 而不是 span，是为了可键盘触达。
            onClick={() =>
              setSelectedSeriesNames(
                allSeries.slice(0, MAX_SELECTED_CODING_PLAN_DETAIL_SERIES).map((item) => item.name),
              )
            }
          >
            <span className="truncate text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.usage.codingPlanLegendTotal",
              })}
              :
            </span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium">
                {formatCodingPlanDetailValue(locale, totalValue, valueMetric, subject)}
              </span>
              {detailUnit ? <span className="text-foreground-subtle">{detailUnit}</span> : null}
            </span>
          </button>
          {allSeries.slice(0, 8).map((item) => {
            // hidden 只影响视觉与 aria-pressed，不影响数据：未选中的系列仍在 allSeries 里。
            const hidden = !selectedSeriesNameSet.has(item.name);
            const itemTotal = item.values.reduce((sum, value) => sum + value, 0);
            const seriesColor = item.color;
            return (
              <button
                key={item.name}
                type="button"
                // aria-pressed 与视觉勾选同源（都取 hidden 的反），保证读屏与视觉一致。
                aria-pressed={!hidden}
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-ui-sm"
                onClick={() => toggleSeries(item.name)}
              >
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                    hidden ? "bg-input border-border text-transparent" : "text-primary-foreground"
                  }`}
                  style={{
                    backgroundColor: hidden ? undefined : seriesColor,
                    borderColor: hidden ? undefined : seriesColor,
                  }}
                >
                  <Check className="size-3" aria-hidden="true" />
                </span>
                <span className="truncate text-foreground-subtle">{item.name}:</span>
                <span className="flex items-baseline gap-1 text-foreground">
                  <span className="font-mono font-medium">
                    {formatCodingPlanDetailValue(locale, itemTotal, valueMetric, subject)}
                  </span>
                  {detailUnit ? <span className="text-foreground-subtle">{detailUnit}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <UsageChartLoadBoundary
            scope="settings.usage.coding-plan-detail-chart"
            resetKeys={[
              snapshot.sourceProvider.id,
              snapshot.range,
              snapshot.rangeStartDate,
              snapshot.rangeEndDate,
              snapshot.generatedAt,
              metric,
              subject,
            ]}
            loadingDescription={intl.formatMessage({
              id: "settings.usage.codingPlanLoadingDescription",
            })}
          >
            <CodingPlanUsageBarChart
              xTime={activeChartMeta.xTime}
              granularity={activeChartMeta.granularity}
              emptyDescription={intl.formatMessage({
                id: "settings.usage.emptyDescription",
              })}
              // 只传可见系列；空数组时由图表自身渲染 emptyDescription，本文件不再兜底。
              series={visibleSeries}
              valueKind={valueKind}
            />
          </UsageChartLoadBoundary>
        </div>
      </div>
    </section>
  );
}

// 积分数据探测。采用「任一正值即认为存在」而不是「totalCredits > 0」：
// 旧数据里 totalCredits 可能缺失，但分模型序列仍有值。
export function hasCodingPlanCreditUsageData({
  summary,
  modelDataList,
  toolDataList,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
  modelDataList: CodingPlanModelData[];
  toolDataList: CodingPlanToolData[];
}): boolean {
  if (
    // 摘要层优先：totalCredits 或日均积分为正即可判定，无需扫描明细。
    hasPositiveFiniteNumber(summary.totalCredits) ||
    hasPositiveFiniteNumber(summary.averageDailyCredits)
  ) {
    return true;
  }

  return (
    // [权衡] 明细扫描包含 cached / uncached / output 三个拆解序列：
    // 只看 creditsUsage 会漏掉只回传拆解字段的供应商版本。
    modelDataList.some(
      (item) =>
        hasPositiveFiniteNumber(item.totalCredits) ||
        hasPositiveFiniteSeries(item.creditsUsage) ||
        hasPositiveFiniteSeries(item.cachedInputCreditsUsage) ||
        hasPositiveFiniteSeries(item.uncachedInputCreditsUsage) ||
        hasPositiveFiniteSeries(item.outputCreditsUsage),
    ) ||
    toolDataList.some(
      (item) =>
        hasPositiveFiniteNumber(item.totalCredits) || hasPositiveFiniteSeries(item.creditsUsage),
    )
  );
}

// 摘要卡可见性：与 hasCodingPlanCreditUsageData 的差别只在第一层直接判断，
// 目的是让「摘要里有积分、明细里没有」的响应也能展示摘要。
export function shouldShowCodingPlanUsageDetailSummary({
  summary,
  modelDataList,
  toolDataList,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
  modelDataList: CodingPlanModelData[];
  toolDataList: CodingPlanToolData[];
}): boolean {
  if (
    hasPositiveFiniteNumber(summary.totalCredits) ||
    hasPositiveFiniteNumber(summary.averageDailyCredits)
  ) {
    return true;
  }

  // 旧版 Coding Plan usage-detail 只有 token 用量时也可能返回 cache 命中率，
  // 但 BigModel 官网不展示积分摘要卡；只有真实 credits 数据才展示这组三卡。
  // 第二层回落到完整探测；注意不能用 >= 0，全 0 表示「确实没有积分消费」，
  // 展示出来反而误导（旧版 token-only 响应就是这种情况）。
  return hasCodingPlanCreditUsageData({ summary, modelDataList, toolDataList });
}

// [失败路径] 必须同时排除 NaN / Infinity / null / undefined：
// 服务端 JSON 里的 null 经 Number() 会变成 0，直接比较会误判为「有数据」。
function hasPositiveFiniteNumber(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// 数组缺失（undefined）与空数组都视为「无数据」，用 === true 把 undefined 收敛成 false。
function hasPositiveFiniteSeries(values: number[] | undefined): boolean {
  return values?.some(hasPositiveFiniteNumber) === true;
}

// 三卡摘要：缓存命中率 / 累计积分 / 日均积分；趋势为 null 时不渲染箭头。
function CodingPlanUsageDetailSummary({
  summary,
}: {
  summary: CodingPlanUsageSnapshot["detail"]["model"];
}) {
  const { intl, locale } = useZCodeIntl();
  const items = [
    {
      // 趋势字段与数值字段一一对应；不要在渲染时用当前值反推趋势。
      label: intl.formatMessage({ id: "settings.usage.cacheHitRate" }),
      trend: summary.cacheHitRateTrend,
      value: formatCodingPlanRate(locale, summary.cacheHitRate),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.creditsTotal" }),
      trend: summary.totalCreditsTrend,
      value: formatCompactNumber(locale, summary.totalCredits),
    },
    {
      label: intl.formatMessage({ id: "settings.usage.averageDailyCredits" }),
      trend: summary.averageDailyCreditsTrend,
      value: formatCompactNumber(locale, summary.averageDailyCredits),
    },
  ];

  return (
    // grid-cols-3 在 sm 以下自动堆叠，卡片高度随内容而不强制等高。
    <div className="grid gap-3 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl bg-surface/70 p-4">
          <div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">
            <span className="min-w-0 truncate">{item.label}</span>
            {item.trend === null ? null : (
              <span
                className={`shrink-0 text-ui-base ${
                  // [权衡] 负值用 destructive、正值用 success：这里的方向语义是「涨了是好事」，
                  // 与通用的「上涨=风险」相反，因此不能复用全局趋势色工具。
                  item.trend < 0 ? "text-destructive" : "text-success"
                }`}
              >
                {formatCodingPlanTrend(locale, item.trend)}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// 健康度：两条解码速度曲线（Pro Max / Lite），区间固定 7d，与上方趋势的 range 无关。
function CodingPlanHealthSection({ snapshot }: { snapshot: CodingPlanUsageSnapshot }) {
  const { intl } = useZCodeIntl();
  // 系列名走 i18n，值直接引用快照数组；依赖显式列出三个来源，避免整对象依赖导致抖动。
  const healthSeries = useMemo(
    () => [
      {
        name: intl.formatMessage({ id: "settings.usage.healthProMaxDecode" }),
        values: snapshot.health.proMaxDecodeSpeed,
      },
      {
        name: intl.formatMessage({ id: "settings.usage.healthLiteDecode" }),
        values: snapshot.health.liteDecodeSpeed,
      },
    ],
    [snapshot.health.liteDecodeSpeed, snapshot.health.proMaxDecodeSpeed, intl],
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.healthTitle" })}
        </h3>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.healthRange.7d" })}
        </span>
      </div>
      <div className="rounded-xl bg-surface/70 p-3">
        <UsageChartLoadBoundary
          scope="settings.usage.coding-plan-health-chart"
          resetKeys={[snapshot.sourceProvider.id, snapshot.generatedAt]}
          loadingDescription={intl.formatMessage({
            id: "settings.usage.codingPlanLoadingDescription",
          })}
        >
          <CodingPlanUsageLineChart
            xTime={snapshot.health.xTime}
            granularity="day"
            emptyDescription={intl.formatMessage({
              id: "settings.usage.emptyDescription",
            })}
            series={healthSeries}
            // 速度单位由图表按 valueKind 决定，本文件不参与格式化，避免两处口径漂移。
            valueKind="speed"
          />
        </UsageChartLoadBoundary>
      </div>
    </section>
  );
}

// [失败路径] 非有限值返回 -- 而不是 0%：命中率缺失与 0% 命中是完全不同的结论。
function formatCodingPlanRate(locale: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  // [权衡] 兼容 0~1 与 0~100 两种历史口径：>1 视为百分数并归一化。
  // 边界值 1 走 ratio 分支（即 100%），这是服务端实际使用的口径。
  const normalizedValue = value > 1 ? value / 100 : value;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
    style: "percent",
  }).format(normalizedValue);
}

// 刷新时间单独实现而不复用 formatFullDay：后者不含时分，无法表达「几点几分刷新」。
function formatCodingPlanRefreshTime(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  value: number,
): string {
  const time = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
  return intl.formatMessage({ id: "settings.usage.lastRefreshTime" }, { time });
}

// 符号单独拼接而不用 Intl 的 signDisplay：需要「0 时不带符号」，且与百分比格式解耦。
function formatCodingPlanTrend(locale: string, value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(Math.abs(value))}`;
}

// 数值格式化按 metric/subject 二分：credits 与 tool 次数用紧凑数字，model 用量用 token 单位。
function formatCodingPlanDetailValue(
  locale: string,
  value: number,
  metric: CodingPlanUsageDetailMetric,
  subject: CodingPlanUsageDetailSubject,
): string {
  // credits 优先判断：积分模式下 subject 仍可能是 model，但单位必须是积分而非 token。
  if (metric === "credits") {
    return formatCompactNumber(locale, value);
  }
  if (subject === "model") {
    return formatCompactTokenUsage(locale, value);
  }
  return formatCompactNumber(locale, value);
}

// 通用分段控件：只依赖 Tabs 原语，不做受控值校验；
// labelIdPrefix + option 拼出 i18n key，新增选项时无需改这里。
function SegmentedTabs<T extends string>({
  value,
  options,
  labelIdPrefix,
  onChange,
}: {
  value: T;
  options: T[];
  labelIdPrefix: string;
  onChange: (value: T) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
        {options.map((option) => (
          <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
            {intl.formatMessage({ id: `${labelIdPrefix}.${option}` })}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
