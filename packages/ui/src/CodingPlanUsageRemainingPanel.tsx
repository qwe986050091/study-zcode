/* eslint-disable max-lines -- Coding Plan 用量视图集中维护来源选择、额度投影和重置入口；本阶段只迁移 Account Access，不拆分既有 UI 结构。 */
// 组件：Coding Plan 剩余额度面板（sidebar 与输入框上下文菜单共用同一份展示）。
// 职责边界：只把 entitlements 快照投影成「额度行 + 重置时间 + 降级提示」，
//   不发起请求、不写 store、不做导航；详情入口与 provider 切换由调用方注入。
// 本文件持有三件事：来源选择（state 解析）、额度取数与窗口口径、展示格式化。
// 不持有：网络请求、鉴权、订阅、provider 元数据与 tab/store 导航。
// 度量口径：整行注释 / 代码行，本文件目标 31.31%（129 / 412）。
//
// INV 不变量表（每条都指向一个可被改坏的位置）：
// INV-01 断言：快照有效 = provider.id 一致 + 不可用原因非 no_plan + subscription.details 非空 —— 守住它的位置：hasActiveCodingPlanSnapshot —— 改错故障：无 plan 的账号被当成有效来源，面板出现空额度行
// INV-02 断言：entitlement 先按 team: 前缀放行，其余必须命中 availableProviders —— 守住它的位置：providerEntitlements 过滤 —— 改错故障：已下线的 provider 凭旧快照重新出现在面板
// INV-03 断言：选中项有效则用它，否则回退到首个有效 provider —— 守住它的位置：activeEntitlement 表达式 —— 改错故障：用户点过的 tab 被后台刷新悄悄重置
// INV-04 断言：展示降级链为 active ?? selected ?? 首个 —— 守住它的位置：displayedEntitlement —— 改错故障：没有有效 plan 时整块面板消失而非提示
// INV-05 断言：loading = modelProvidersLoading 或任一 entitlement.loading —— 守住它的位置：loading 聚合 —— 改错故障：首帧就把加载中误判成「无 plan」
// INV-06 断言：非 loading 且无 entitlement，或非 loading 且无有效 plan，才返回 null —— 守住它的位置：resolveCodingPlanUsageRemainingState 尾部 —— 改错故障：加载瞬间闪空或面板永久空白
// INV-07 断言：tab 只列有效 plan，label 走 entitlement.label → provider.label → 内置名三级回退 —— 守住它的位置：tabProviders —— 改错故障：单个 tab 仍渲染切换器或标签为空
// INV-08 断言：剩余百分比 = clamp(100 - 已用百分比, 0, 100) —— 守住它的位置：formatQuotaRemainingPercentage 取数链 —— 改错故障：负数或超 100 的百分比直接显示
// INV-09 断言：percentage 非有限数时显示 -- 而不是 0% —— 守住它的位置：getQuotaRemainingPercentage —— 改错故障：缺字段被读成「额度耗尽」
// INV-10 断言：5 小时 = TOKENS_LIMIT unit3 number5，周 = unit6，工具 = TIME_LIMIT unit5 number1 —— 守住它的位置：三个 findCodingPlanQuotaLimit 调用 —— 改错故障：5 小时与周额度命中同一只桶
// INV-11 断言：MCP 额度只来自 snapshot.mcpQuota.aggregate，不在 quota.limits 里查 —— 守住它的位置：resolveMcpQuotaLimit —— 改错故障：MCP 行永远缺失或取到别的桶
// INV-12 断言：5 小时用 dateTime+compactToday，周/月/MCP 用 date —— 守住它的位置：四处 formatQuotaResetTime 调用 —— 改错故障：同日重置重复显示日期或跨天只看时分
// INV-13 断言：渲染优先级 error > unavailable > 额度行 —— 守住它的位置：主体三态分支 —— 改错故障：有缓存额度时把真实错误吞掉
// INV-14 断言：remaining.isShow === false 时底部给出隐藏提示 —— 守住它的位置：尾部附加行 —— 改错故障：服务端明确要求隐藏，UI 仍展示数字
//
// TSX 约束：新增注释全落在模块/函数体语句之间，
//   不进入 JSX 子节点，也不插在开标签属性行之间。
// 读法：正文块标签 [契约]/[并发]/[事务]/[资源]/[失败路径]/[权衡]。
import type {
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  type OAuthProviderId,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
// [权衡] 图标依赖刻意收窄：Loader2 只服务「加载中且无快照」这一个分支，
//   ChevronRightIcon 只服务详情入口；provider 图标交给 renderOAuthProviderIcon，
//   避免把品牌图标映射复制到本组件。
import { ChevronRightIcon, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  resolveMcpQuotaLimit,
} from "@/lib/codingPlanQuotaPresentation.js";
import { renderOAuthProviderIcon } from "@/lib/oauthProviderIcon.js";
import type {
  SidebarUsageCodingPlanProviderId,
  SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

// [契约] 单个来源的输入契约：身份（sourceId/providerId）+ 账户（accountAccess）
//   + 数据（snapshot）+ 三态（loading/error）。三态不由本组件推断，
//   只有 loading 与 error 都为空时才可能走到额度行。
//   改这个接口等于改面板与所有调用方的边界，先看 INV-01/INV-05。
export interface CodingPlanUsageRemainingEntitlement {
  sourceId?: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label?: string;
  // [失败路径] 无快照降级：null 是合法输入，不是错误。面板不得因此抛错，
  //   只能表现为 loading、unavailable 文案，或按 INV-06 整块返回 null。
  //   三态优先级见 INV-13，别在这里提前 return。
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

export interface CodingPlanUsageAvailableProvider {
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label: string;
}

// [契约] 输出契约：四个决策（有效来源、展示来源、是否加载、是否有任一 plan）
//   + 两份派生数据（可见快照、tab 列表）。visibleSnapshot 已按 INV-01 过滤，
//   消费方不必再判一次 provider；tabProviders 只含有效 plan（INV-07）。
//   CodingPlanUsageRemainingState 只承载派生结果，渲染分支由消费方按 loading 与 unavailable 自行选择。
export interface CodingPlanUsageRemainingState {
  activeProviderId?: SidebarUsageCodingPlanSourceId;
  displayedEntitlement: CodingPlanUsageRemainingEntitlement | null;
  displayedProviderId?: SidebarUsageCodingPlanSourceId;
  hasAnyActiveCodingPlan: boolean;
  loading: boolean;
  providerEntitlements: CodingPlanUsageRemainingEntitlement[];
  tabProviders: CodingPlanUsageRemainingTabProvider[];
  visibleSnapshot: UsageEntitlementSnapshot | null;
}

interface CodingPlanUsageRemainingTabProvider {
  id: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  label: string;
}

// [契约] 单行渲染只做排版，不做格式化：value 由调用方算好，resetTime 缺省则不渲染
//   时间段。四条额度行因此共享同一列宽（minmax(0,1fr) + auto），
//   长语言文案靠 truncate 收敛，不因缺少重置时间而错位。
//   label 与 value 都是已本地化字符串，这里不碰 intl。
function UsageLimitRow({
  label,
  value,
  resetTime,
}: {
  label: string;
  value: string;
  resetTime?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5">
      <div className="min-w-0 truncate text-ui-sm text-foreground">{label}</div>
      <div className="flex min-w-0 max-w-36 items-center gap-2 text-right text-ui-sm">
        <span className="min-w-0 truncate font-medium text-foreground">{value}</span>
        {resetTime ? (
          <span className="min-w-0 truncate text-foreground-subtle">{resetTime}</span>
        ) : null}
      </div>
    </div>
  );
}

// [契约] 详情入口必须由调用方注入：同一展示会出现在 sidebar 与输入框上下文菜单，
//   组件内不能假设 tab/store 导航能力存在；onUsageClick 缺省时按钮仍可点但无副作用。
//   点击时 preventDefault + stopPropagation，避免冒泡触发宿主菜单的其它动作。
function UsageDetailsButton({ label, onUsageClick }: { label: string; onUsageClick?: () => void }) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      aria-label={label}
      title={label}
      className="h-6 gap-0.5 px-0 text-ui-sm"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onUsageClick?.();
      }}
    >
      {label}
      <ChevronRightIcon className="size-3.5" />
    </Button>
  );
}

// [权衡] tab 图标按 providerId 归一：zai 个人版用 ZAI_PROVIDER_ID，其余一律 BigModel。
//   这里刻意不给未知 provider 抛错，回退图标比空白 tab 更可用（与 INV-07 配套）。
//   新增品牌时必须同时改这里与 formatCodingPlanProviderTabAriaLabel。
function resolveCodingPlanTabProviderIcon(providerId: string): OAuthProviderId {
  if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
    return ZAI_PROVIDER_ID;
  }
  return BIGMODEL_PROVIDER_ID;
}

// [契约] 无障碍标签是 label 回退链的最后一环，只区分 Z.ai 与 BigModel 两个品牌。
//   它不是用户可见标题，别在这里接 i18n 文案，否则 tab 标题会被翻译串号。
function formatCodingPlanProviderTabAriaLabel(providerId: string): string {
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    ? "Z.ai Coding Plan"
    : "BigModel Coding Plan";
}

// [契约] 身份归一：team: 前缀的 entitlement 用 sourceId，其余用 providerId 兜底。
//   所有「来源是否相等」的判断都必须走这里，不要各写一遍 ?? 链，
//   否则 INV-02/INV-03 会在 team 来源上出现两种宽严不同的比较。
//   sourceId 缺失时回退 providerId，保证旧调用方仍可工作。
function getEntitlementSourceId(
  entitlement: Pick<CodingPlanUsageRemainingEntitlement, "providerId" | "sourceId">,
): SidebarUsageCodingPlanSourceId {
  return entitlement.sourceId ?? entitlement.providerId;
}

// [契约] INV-01 的唯一实现点：provider 一致只是必要条件，还要排除 no_plan，
//   并要求 subscription.details 非空 —— 空 details 会让四条额度行全部消失。
//   这是纯函数，不取 intl、不读时间，便于调用方在渲染前完成过滤。
//   返回 false 只表示「不算有效 plan」，不区分失败原因。
export function hasActiveCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  // [契约] INV-13 的渲染顺序：加载中且无快照 → 错误 → unavailable → 四条额度行。
  //   错误优先于 unavailable，避免旧缓存把真实失败伪装成「无 plan」；
  //   四条额度行各自判空，缺哪个窗口就少哪一行，不占位。
  //   四条都缺且不在加载中时，会走 unavailable 分支而不是空容器。
  return (
    snapshot?.provider?.id === providerId &&
    snapshot.unavailableReason !== "no_plan" &&
    Boolean(snapshot.subscription?.details.length)
  );
}

export function resolveCodingPlanUsageRemainingState(params: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: CodingPlanUsageRemainingEntitlement[];
  modelProvidersLoading: boolean;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
}): CodingPlanUsageRemainingState | null {
  // [契约] INV-02：team: 来源不看 availableProviders（团队额度不在模型 provider 列表里），
  //   其余来源必须仍被 provider 列表承认。这个过滤决定 tab 与 active 的候选集，
  //   放宽会让下线 provider 复活，收紧会让 team plan 整块消失。
  //   过滤顺序保持输入顺序，tab 的排列因此稳定。
  const providerEntitlements = params.entitlements.filter(
    (entitlement) =>
      getEntitlementSourceId(entitlement).startsWith("team:") ||
      params.availableProviders.some((provider) => provider.providerId === entitlement.providerId),
  );
  // [契约] 选中的解析只认归一后的身份（见 getEntitlementSourceId），
  //   找不到即 undefined，由下一段回退，不在这里兜底成首个元素。
  //   若改为兜底，INV-03 会退化成「永远有选中」，tab 高亮随之失真。
  const selectedEntitlement = providerEntitlements.find(
    (entitlement) => getEntitlementSourceId(entitlement) === params.selectedProviderId,
  );
  // [契约] INV-03/INV-04：先尊重用户选择（但要求该来源有有效快照），
  //   否则取首个有效快照；selected 有效只是「可展示」，不一定「有额度」。
  //   这里的 ?? 顺序就是 INV-04 的降级链，调整顺序会改变 tab 高亮。
  //   两个分支都只读快照，不触发任何加载。
  const activeEntitlement =
    (selectedEntitlement &&
    hasActiveCodingPlanSnapshot(selectedEntitlement.snapshot, selectedEntitlement.providerId)
      ? selectedEntitlement
      : undefined) ??
    providerEntitlements.find((entitlement) =>
      hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
    );
  const displayedEntitlement =
    activeEntitlement ?? selectedEntitlement ?? providerEntitlements[0] ?? null;
  const activeProviderId = activeEntitlement
    ? getEntitlementSourceId(activeEntitlement)
    : undefined;
  const displayedProviderId = activeProviderId ?? params.selectedProviderId;
  // [并发] loading 是聚合量：模型 provider 列表加载或任一来源加载都算加载中。
  //   聚合口径保证 INV-05：首帧不会因为「还没拿到 entitlement」被误判成无 plan。
  //   已有快照时 loading 仍可为 true，渲染分支会优先展示旧快照（INV-13）。
  const loading =
    params.modelProvidersLoading || providerEntitlements.some((entitlement) => entitlement.loading);
  // [失败路径] 只有「展示项」的有效快照才进 visibleSnapshot，provider 对不上即降级 null。
  //   下游所有额度、重置时间、unavailable 判断都读它，避免半有效快照泄漏到 UI。
  //   注意它不是 displayedEntitlement.snapshot 的直接别名。
  const visibleSnapshot =
    displayedEntitlement &&
    hasActiveCodingPlanSnapshot(displayedEntitlement.snapshot, displayedEntitlement.providerId)
      ? displayedEntitlement.snapshot
      : null;
  // [资源] 有效来源 id 先算一次再复用：tabProviders 用它做成员判断，
  //   避免在同一渲染里对同一批 entitlement 重复调用 hasActiveCodingPlanSnapshot。
  //   这是纯计算，不进 useMemo，因为依赖已是本次渲染的局部变量。
  const activeCodingPlanProviderIds = providerEntitlements
    .filter((entitlement) =>
      hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
    )
    .map((entitlement) => getEntitlementSourceId(entitlement));
  const hasAnyActiveCodingPlan = Boolean(activeEntitlement);
  // [契约] INV-07：tab 只列有有效快照的来源，label 走 entitlement.label →
  //   provider.label → 内置品牌名三级回退。team: 来源通常没有 provider 元数据，
  //   必须靠前两级或内置名兜住，否则 tab 的 title/aria-label 为空。
  //   这里只产出展示数据，不改来源顺序。
  const tabProviders = providerEntitlements
    .filter((entitlement) =>
      activeCodingPlanProviderIds.includes(getEntitlementSourceId(entitlement)),
    )
    .map((entitlement): CodingPlanUsageRemainingTabProvider => {
      const provider = params.availableProviders.find(
        (item) => item.providerId === entitlement.providerId,
      );
      return {
        id: getEntitlementSourceId(entitlement),
        providerId: entitlement.providerId,
        label:
          entitlement.label ??
          provider?.label ??
          formatCodingPlanProviderTabAriaLabel(entitlement.providerId),
      };
    });

  if (
    // [失败路径] INV-06 的空态出口：模型列表已加载完却没有候选来源，或已停止加载
    //   却没有任何有效 plan，都返回 null 让调用方收起整块面板。
    //   两个条件都带 !loading，防止加载窗口内先闪一次空。
    //   返回 null 后组件不做任何占位渲染，由调用方决定留白。
    (!params.modelProvidersLoading && providerEntitlements.length === 0) ||
    (!loading && !hasAnyActiveCodingPlan)
  ) {
    return null;
  }

  return {
    activeProviderId,
    displayedEntitlement,
    displayedProviderId,
    hasAnyActiveCodingPlan,
    loading,
    providerEntitlements,
    tabProviders,
    visibleSnapshot,
  };
}

// [契约] 存在性判断与渲染共用同一次解析，避免「说有面板但渲染 null」的分叉。
//   它只返回布尔值，调用方不能据此推断有额度可展示。
export function hasCodingPlanUsageRemainingPanel(params: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: CodingPlanUsageRemainingEntitlement[];
  modelProvidersLoading: boolean;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
}): boolean {
  return Boolean(resolveCodingPlanUsageRemainingState(params));
}

export function CodingPlanUsageRemainingPanel({
  availableProviders,
  audience,
  className,
  entitlements,
  modelProvidersLoading,
  onProviderChange,
  onUsageClick,
  selectedProviderId,
}: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  audience?: "individual" | "team";
  className?: string;
  entitlements: CodingPlanUsageRemainingEntitlement[];
  modelProvidersLoading: boolean;
  onProviderChange?: (providerId: SidebarUsageCodingPlanSourceId) => void;
  onUsageClick?: () => void;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
}) {
  // [契约] locale 只用于数字与日期格式化，不参与业务判断；
  //   intl 只用于固定文案 id。两者都来自 Provider，不在本组件缓存或透传。
  //   日期格式化统一走 formatQuotaResetTime，避免各处 Intl 选项漂移。
  //   百分比格式化统一走 formatQuotaRemainingPercentage（含夹紧与缺失降级）。
  const { intl, locale } = useZCodeIntl();
  // [资源] 解析结果按四个输入缓存：availableProviders、entitlements、
  //   modelProvidersLoading、selectedProviderId。调用方若每次渲染新建数组，
  //   缓存失效只是多算一次纯函数，不会造成错误（解析无副作用）。
  //   不要在 deps 里补 state 或 locale，那会让缓存形同虚设。
  const state = useMemo(
    () =>
      resolveCodingPlanUsageRemainingState({
        availableProviders,
        entitlements,
        modelProvidersLoading,
        selectedProviderId,
      }),
    [availableProviders, entitlements, modelProvidersLoading, selectedProviderId],
  );

  if (!state) {
    return null;
  }

  // [契约] 额度取数只读 visibleSnapshot：level 是包月档位，remaining 是服务端隐藏意图，
  //   limits 是窗口桶集合。三者都可能缺失，下游一律按「缺即不显示」处理，
  //   不用空数组或 0 伪造存在性（对应 INV-08/INV-09 的展示口径）。
  //   percentage 表示已用占比，反转与夹紧都在格式化函数里完成。
  const planLevel = state.visibleSnapshot?.quota?.level ?? null;
  const remaining = state.visibleSnapshot?.remaining;
  const unavailableReason = state.visibleSnapshot?.unavailableReason;
  const limits = state.visibleSnapshot?.quota?.limits ?? [];
  // [契约] 窗口额度与包月额度口径分离：5 小时与周额度都来自 TOKENS_LIMIT，
  //   靠 unit/number 区分（3/5 与 6）；工具调用是 TIME_LIMIT unit5 number1；
  //   level 与 remaining 则是包月档位与隐藏标记，绝不与窗口桶混用（INV-10）。
  //   共享的 isSameLimitCategory 还兼容 zai 的 CREDIT_LIMIT 命名。
  const fiveHourTokenLimit = findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5);
  const weeklyTokenLimit = findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6);
  const monthlyToolLimit = findCodingPlanQuotaLimit(limits, "TIME_LIMIT", 5, 1);
  // [契约] MCP 额度是 entitlement 上的独立字段（mcpQuota.aggregate），
  //   不在 quota.limits 里，所以不能复用 findCodingPlanQuotaLimit（INV-11）。
  //   缺失时返回 null，MCP 行整行不渲染，不做零值占位。
  const mcpQuotaLimit = resolveMcpQuotaLimit(state.visibleSnapshot);
  // [契约] INV-12：重置时间统一交给 formatQuotaResetTime，由它做本地时区换算与
  //   Intl 格式化；5 小时窗口用 dateTime + compactToday（当日只给时分），
  //   周/月/MCP 用 date。缺 nextResetTime 或非法时间返回 undefined，行内不渲染。
  //   不要在调用点用 toLocaleString 直接拼，会绕过时区与非法值防护。
  const fiveHourResetTime = fiveHourTokenLimit?.nextResetTime
    ? formatQuotaResetTime({
        locale,
        value: fiveHourTokenLimit.nextResetTime,
        format: "dateTime",
        compactToday: true,
      })
    : undefined;
  const weeklyResetTime = weeklyTokenLimit?.nextResetTime
    ? formatQuotaResetTime({
        locale,
        value: weeklyTokenLimit.nextResetTime,
        format: "date",
      })
    : undefined;
  const monthlyToolResetTime = monthlyToolLimit?.nextResetTime
    ? formatQuotaResetTime({
        locale,
        value: monthlyToolLimit.nextResetTime,
        format: "date",
      })
    : undefined;
  // MCP 额度按自然日重置，重置时刻恒为 00:00，展示时分没有信息量；
  // 与 Weekly / Tool calls 统一用日期口径。
  const mcpResetTime = mcpQuotaLimit?.nextResetTime
    ? formatQuotaResetTime({
        locale,
        value: mcpQuotaLimit.nextResetTime,
        format: "date",
      })
    : undefined;
  // [失败路径] 服务端 unavailableReason 到文案的映射是封闭枚举：not_configured、
  //   not_authenticated、no_plan 各有专文案，其余一律「不可用」。
  //   新增原因时必须先加分支，否则会被兜底文案静默吞掉。
  //   这里只做映射，不判断该不该展示（由 unavailable 决定）。
  const unavailableMessage =
    unavailableReason === "not_configured"
      ? intl.formatMessage({ id: "sidebar.usage.plan.notConfigured" })
      : unavailableReason === "not_authenticated"
        ? intl.formatMessage({ id: "sidebar.usage.plan.loginRequired" })
        : unavailableReason === "no_plan"
          ? intl.formatMessage({ id: "sidebar.usage.plan.noPlan" })
          : intl.formatMessage({ id: "sidebar.usage.plan.unavailable" });
  // [权衡] unavailable 要求四者同时为空：不在加载中、无 remaining、无窗口桶、无档位。
  //   unavailable 必须三项全空才为真（额度、窗口桶、档位），宁可显示部分额度也不误报不可用；
  //   这条判断与 INV-13 的渲染优先级共同决定三态分支。
  //   remaining 为 null 与 isShow === false 是两件事，后者只加底部提示。
  const unavailable = !state.loading && !remaining && limits.length === 0 && !planLevel;

  return (
    <div className={className}>
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="min-w-0 truncate text-ui-base font-medium text-foreground">
                {intl.formatMessage({
                  id: "sidebar.usage.plan.codingPlanTitle",
                })}
              </div>
              {audience ? (
                <span className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-ui-xs font-medium leading-none text-foreground-subtle">
                  {intl.formatMessage({
                    id:
                      audience === "team"
                        ? "sidebar.usage.plan.audienceTeam"
                        : "sidebar.usage.plan.audienceIndividual",
                  })}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 修复原因：同一份 Usage Remaining 展示会出现在 sidebar 和输入框上下文菜单。
                详情入口必须由调用方传入，避免共享展示组件直接依赖 tab/store 导航。 */}
            {onUsageClick ? (
              <UsageDetailsButton
                label={intl.formatMessage({ id: "sidebar.usage.plan.open" })}
                onUsageClick={onUsageClick}
              />
            ) : null}
            {!audience && state.tabProviders.length > 1 && state.displayedProviderId ? (
              <div className="flex min-w-0 items-center rounded-lg bg-surface p-0.5">
                {state.tabProviders.map((provider) => {
                  const active = provider.id === state.displayedProviderId;
                  const label = provider.label;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      aria-pressed={active}
                      aria-label={label}
                      title={label}
                      className={[
                        "flex size-6 items-center justify-center rounded-md",
                        active
                          ? "bg-card text-foreground shadow-sm"
                          : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground",
                      ].join(" ")}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onProviderChange?.(provider.id);
                      }}
                    >
                      {renderOAuthProviderIcon(
                        resolveCodingPlanTabProviderIcon(provider.providerId),
                        "size-3.5",
                      )}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="px-3 py-2">
        {state.loading && !state.visibleSnapshot ? (
          <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
            <Loader2 className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
          </div>
        ) : state.displayedEntitlement?.error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
            {state.displayedEntitlement.error}
          </div>
        ) : unavailable ? (
          <div className="p-2 text-ui-base leading-relaxed text-foreground-subtle">
            {unavailableMessage}
          </div>
        ) : (
          <>
            {fiveHourTokenLimit ? (
              <UsageLimitRow
                label={intl.formatMessage({
                  id: "sidebar.usage.plan.fiveHour",
                })}
                value={formatQuotaRemainingPercentage(locale, fiveHourTokenLimit)}
                resetTime={fiveHourResetTime}
              />
            ) : null}
            {weeklyTokenLimit ? (
              <UsageLimitRow
                label={intl.formatMessage({
                  id: "sidebar.usage.plan.weekly",
                })}
                value={formatQuotaRemainingPercentage(locale, weeklyTokenLimit)}
                resetTime={weeklyResetTime}
              />
            ) : null}
            {monthlyToolLimit ? (
              <UsageLimitRow
                label={intl.formatMessage({
                  id: "sidebar.usage.plan.toolCalls",
                })}
                value={formatQuotaRemainingPercentage(locale, monthlyToolLimit)}
                resetTime={monthlyToolResetTime}
              />
            ) : null}
            {mcpQuotaLimit ? (
              <UsageLimitRow
                label={intl.formatMessage({ id: "sidebar.usage.plan.mcp" })}
                value={formatQuotaRemainingPercentage(locale, mcpQuotaLimit)}
                resetTime={mcpResetTime}
              />
            ) : null}
          </>
        )}
      </div>
      {remaining?.isShow === false ? (
        <div className="border-t border-border px-3 py-2 text-ui-xs font-normal">
          {intl.formatMessage({ id: "sidebar.usage.plan.hidden" })}
        </div>
      ) : null}
    </div>
  );
}
