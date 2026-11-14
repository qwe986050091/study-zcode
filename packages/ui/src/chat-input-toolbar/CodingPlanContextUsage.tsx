/* eslint-disable max-lines -- Composer 用量入口集中维护多来源状态、弹层和重置交互；本阶段只迁移 Account Access，不拆分既有 UI 结构。 */
// 职责边界：Composer 工具栏「编码套餐上下文用量」的纯展示投影层，不持有业务事实。
// 输入只有一份 config（可用供应商、权益快照、加载态、回调），输出只有额度条、重置机会徽标
// 与弹窗配置；不发请求、不写 store、不改变任何配额数字。
// 刷新由 config.onEntitlementRefresh 触发，核销由 useCodingPlanQuotaResetUi 与弹窗按钮完成；
// 本组件只读它们回传的状态并转发回调，保证展示与事实单向流动。
//
// INV 表（改动前逐条对照；位置指当前函数与常量名）：
// INV-01 断言：百分比必须截断到 0~100 才允许写入条形宽度 —— 守住它的位置：ChatCodingPlanUsageMeter 的 boundedPercentage —— 改错故障：上游给 105 或 -3 时进度条溢出或反向，数字与图形矛盾。
// INV-02 断言：非有限值（NaN、Infinity、null）一律按 0 处理 —— 守住它的位置：boundedPercentage 的 Number.isFinite 判断 —— 改错故障：宽度写成 NaN 百分比被浏览器丢弃，条形与文字同时消失。
// INV-03 断言：没有任何可见快照时不得渲染额度条 —— 守住它的位置：Panel 里 state 为空即早退的分支 —— 改错故障：下游读到未定义的 limits 直接抛错，整个工具栏白屏。
// INV-04 断言：加载中且无快照时只显示加载占位，不显示更新失败 —— 守住它的位置：渲染第一分支对 state.loading 与 visibleSnapshot 的联合判断 —— 改错故障：首次打开被误判失败，用户看到红字其实正在请求。
// INV-05 断言：有缓存快照时错误只降级为头部警示文案，不得清空旧额度 —— 守住它的位置：cachedUpdateError 与 CodingPlanUsageHeaderAction 的 warningLabel —— 改错故障：一次刷新失败抹掉上次成功数据，用户以为额度归零。
// INV-06 断言：五小时取 TOKENS_LIMIT 的 3/5 双键，周取 TOKENS_LIMIT 的 6，二者不可互换 —— 守住它的位置：fiveHourTokenLimit 与 weeklyTokenLimit 两处 findCodingPlanQuotaLimit 实参 —— 改错故障：五小时数字被周额度覆盖，倒计时指向错误日期。
// INV-07 断言：月工具调用取 TIME_LIMIT 的 5/1，MCP 走 resolveMcpQuotaLimit，三套口径不混算 —— 守住它的位置：monthlyToolLimit 与 mcpQuotaLimit —— 改错故障：把调用次数当 token 展示，单位与量级全错。
// INV-08 断言：五小时重置只给时分且固定 h23 口径，周、月、MCP 给日期 —— 守住它的位置：fiveHourResetTime 用时分格式化，其余用日期格式化 —— 改错故障：五小时条显示完整日期挤爆单行，日期口径的条只显示时分看不出哪天。
// INV-09 断言：时间戳无效必须得到空值而不是 Invalid Date 文案 —— 守住它的位置：formatContextFiveHourResetTime 的 Number.isNaN 分支 —— 改错故障：界面出现 Invalid Date，且宽度测量把该串当成真实内容。
// INV-10 断言：重置机会徽标次数累加、到期时间取最早一档 —— 守住它的位置：opportunityBadge 由 resolveChatCodingPlanResetOpportunityBadge 汇总 —— 改错故障：两次机会只显示一次，或倒计时指向较晚一档导致入口过早消失。
// INV-11 断言：弹窗用量项必须与额度条同源同序 —— 守住它的位置：quotaResetDialog 由同一份 quotaMeters 映射生成 —— 改错故障：弹窗与面板配色顺序不一致，用户按位置记忆点错重置类型。
// INV-12 断言：网格列数取条数与 3 的较小值，MCP 独立一格 —— 守住它的位置：quotaGridCount 与 getContextQuotaMeterGridClass —— 改错故障：四类额度挤成一行导致标签截断，或 MCP 被并进三列网格错位。
// INV-13 断言：父层传入弹层开关时不得再写内部状态 —— 守住它的位置：resolvedQuotaResetDialogOpen 与 setQuotaResetDialogOpen 的受控回退 —— 改错故障：父子各持一份开关，弹窗关掉后又被内部状态弹回来。
// INV-14 断言：快照只随 config 引用变化重算 —— 守住它的位置：state 的 useMemo 依赖项只写 config —— 改错故障：父层每次渲染造新对象，每帧重算快照并把加载态抖成真。
// INV-15 断言：尺寸观察者与窗口 resize 监听必须成对释放 —— 守住它的位置：useLayoutEffect 的 cleanup —— 改错故障：额度条卸载后测量仍被回调，向已卸载组件写入布局状态。
//
// props 契约：config 只读；onEntitlementRefresh 为唯一刷新入口，onUsageClick 为唯一外跳入口，
// onProviderChange 由供应商选择器侧使用；本组件不判断供应商是否可用。
// 展示口径：四条额度条固定按 五小时 → 周 → 月工具 → MCP 排序，配色取 usage-chart-1/2/3/5。
// 降级口径：加载中 → 更新失败 → 不可用（未配置/未登录/无套餐）→ 正常额度条，互斥且按序。
// 刷新口径：快照 loading 与父层 refreshing 任一为真都视为刷新中，头部动作按钮据此防重复点击。
// 格式化口径：数值统一走 formatQuotaRemainingPercentage，日期统一走 formatQuotaResetTime。
// 事务口径：核销完成后的撒花按 FIVE_HOUR / WEEK 两个 arm 分别消费，消费后由 onAutoCelebrated 上报。
import { type CodingPlanResetType } from "@zcode/shared";
import { Loader2 } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type CodingPlanUsageRemainingEntitlement,
  type CodingPlanUsageAvailableProvider,
  resolveCodingPlanUsageRemainingState,
} from "@/CodingPlanUsageRemainingPanel.js";
import { cn } from "@/components/lib/utils.js";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanUsageHeaderAction } from "@/chat-input-toolbar/CodingPlanUsageHeaderAction.js";
import { CodingPlanUsageNotice } from "@/chat-input-toolbar/CodingPlanUsageNotice.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  getQuotaRemainingPercentage,
  resolveMcpQuotaLimit,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { resolveChatCodingPlanResetOpportunityBadge } from "@/chat-input-toolbar/codingPlanResetOpportunityBadge.js";
import { ChatCodingPlanMcpUsageMeter } from "@/chat-input-toolbar/ChatCodingPlanMcpUsageMeter.js";
import type { SidebarUsageCodingPlanSourceId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

// [契约] config 是父层与快照之间的唯一通道：可用供应商、权益列表与各类回调都在此，
// 组件不自行请求；refreshing 由父层控制，modelProvidersLoading 只影响供应商可用性判断，
// 与本面板的加载态无关，两者不可互相替代。
export type ChatCodingPlanUsageRemainingConfig = {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: CodingPlanUsageRemainingEntitlement[];
  onAccess?: () => Promise<void> | void;
  refreshing?: boolean;
  modelProvidersLoading: boolean;
  onEntitlementRefresh?: () => void | Promise<void>;
  onProviderChange?: (providerId: SidebarUsageCodingPlanSourceId) => void;
  onUsageClick?: () => void;
  selectedProviderId?: SidebarUsageCodingPlanSourceId;
};

// [契约] 撒花 arm 按重置类型分槽：五小时与周可以各自就绪、各自消费，
// 合并成一个字段会让后到的完成事件覆盖先到的，导致其中一次庆祝丢失。
/** Composer 触发器 hover 展开面板后要求补播撒花的自动完成 used_at,按重置类型定位到对应额度条。
 *  五小时与周额度可能各自 arm,因此按类型分别记录,互不覆盖。 */
export type CodingPlanQuotaResetAutoConfettiArms = Record<
  CodingPlanResetType,
  number | null
>;

// [契约] 该判定决定 Composer 是否保留 Context 触发器；有快照或有可发起的首次请求
// 任一成立即判真，否则用户失去 hover 入口，永远发不出第一次请求。
// [失败路径] 无快照且权益列表为空视为确实没有可展示的套餐，判假而不是占位。
// [权衡] hasChatCodingPlanUsageRemaining 只看能否进入，不看数据是否新鲜；新鲜度由面板内降级分支处理。
export function hasChatCodingPlanUsageRemaining(
  config: ChatCodingPlanUsageRemainingConfig,
): boolean {
  return (
    Boolean(resolveCodingPlanUsageRemainingState(config)) ||
    // 按需刷新下首次打开可能还没有快照；仍需保留 Context trigger，
    // 否则用户没有 hover 入口可以发起第一次请求。
    Boolean(config.onAccess && config.entitlements.length > 0)
  );
}

// [契约] 单行宽度测量：容器可用宽度大于零且内容宽度不超出时才展示重置时间，
// 避免「数值 · 时间」被 overflow-hidden 静默截断成半截时间。
// [权衡] 用小于等于而非严格小于：正好等宽时仍展示，减少亚像素误差造成的闪烁。
export function shouldShowContextQuotaResetTime({
  availableWidth,
  contentWidth,
}: {
  availableWidth: number;
  contentWidth: number;
}): boolean {
  return availableWidth > 0 && contentWidth <= availableWidth;
}

// [契约] 五小时窗口只输出时分（h23），跨天信息由窗口语义隐含；空值与非日期值一律给空。
function formatContextFiveHourResetTime({
  locale,
  value,
}: {
  locale: string;
  value: number | null | undefined;
}): string | undefined {
  if (!value) return undefined;
  const resetAt = new Date(value);
  if (Number.isNaN(resetAt.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetAt);
}

// [契约] 单条额度条的受控展示单元：label、action、percentage、resetTime、value 全部由调用方给定，
// 内部只维护「是否放得下重置时间」这一纯布局状态。
// [事务] 条形宽度只由 boundedPercentage 决定，value 文案独立生成，两者不同源，不在此处互相推导。
function ChatCodingPlanUsageMeter({
  color,
  label,
  action,
  percentage,
  resetTime,
  value,
}: {
  color: string;
  label: string;
  action?: ReactNode;
  percentage: number | null;
  resetTime?: string;
  value: string;
}) {
  // [资源] 两个 ref 分工固定：数值行容器读可用宽度，隐藏节点读内容真实宽度，
  // 二者必须挂在同一个动态行上，否则测量基准错位会得出错误的显隐结论。
  // [契约] 隐藏节点脱离无障碍树但仍参与布局，宽度测量不依赖可见性。
  const valueRowRef = useRef<HTMLDivElement>(null);
  const fullValueRef = useRef<HTMLSpanElement>(null);
  // [契约] 初值取 resetTime 的布尔化结果，让首帧在有时间可展示时就渲染出来，
  // 避免先隐藏再弹出的跳动。
  const [showResetTime, setShowResetTime] = useState(Boolean(resetTime));
  // [契约] 百分比先做有限性判断再截断：NaN 走 0，超界收敛到 0 或 100，
  // 保证写入样式时永远是合法百分比；只有截断后大于零才补最小可见宽度。
  // [权衡] 极小非零值给 1.5px 兜底，表达「还剩一点」，但不代表精确比例。
  const boundedPercentage = Number.isFinite(percentage)
    ? Math.max(0, Math.min(100, percentage ?? 0))
    : 0;

  // [资源] 布局阶段测量一次，随后由 ResizeObserver 与 window resize 双通道驱动；
  // 两条通道都要在 cleanup 中释放，否则额度条卸载后测量仍会写入布局状态。
  // [并发] 依赖重置时间与数值：任一变化重新测量，防止文案变长后旧结论继续生效。
  // [失败路径] 无重置时间时直接关闭展示并提前退出，不注册任何监听。
  // [权衡] 隐藏测量节点用 aria-hidden 加 invisible，宽度真实但不进无障碍树。
  useLayoutEffect(() => {
    if (!resetTime) {
      setShowResetTime(false);
      return;
    }
    const measure = () => {
      const availableWidth = valueRowRef.current?.clientWidth ?? 0;
      const contentWidth = fullValueRef.current?.scrollWidth ?? 0;
      setShowResetTime(shouldShowContextQuotaResetTime({ availableWidth, contentWidth }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (valueRowRef.current) observer?.observe(valueRowRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [resetTime, value]);

  // [契约] 渲染只在布局状态确定后产出：数值行先按测量结论决定是否追加「 · 时间」，
  // 隐藏节点始终保留完整文案，供下一轮测量使用。
  // [事务] 动作与标签同行，min-h-5 与重置按钮同高，保证多条额度不上下错位。
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="min-w-0 space-y-0.5 text-ui-sm">
        {/* min-h 与重置动作(h-5)对齐:没有动作的额度条也保持同高,避免同排数值/进度条错位。 */}
        <div className="flex min-h-5 min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-foreground-subtle">
            {label}
          </span>
          {action ? <span className="shrink-0">{action}</span> : null}
        </div>
        <div
          ref={valueRowRef}
          className="relative min-w-0 overflow-hidden whitespace-nowrap text-ui-sm tabular-nums"
        >
          <span className="font-mono text-foreground">{value}</span>
          {resetTime && showResetTime ? (
            <span className="text-ui-xs text-foreground-subtle">
              {" · "}
              {resetTime}
            </span>
          ) : null}
          {resetTime ? (
            <span
              ref={fullValueRef}
              aria-hidden="true"
              className="invisible absolute left-0 whitespace-nowrap"
            >
              <span className="font-mono">{value}</span>
              <span className="text-ui-xs"> · {resetTime}</span>
            </span>
          ) : null}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            boundedPercentage > 0 ? "min-w-1.5" : undefined,
          )}
          style={{ backgroundColor: color, width: `${boundedPercentage}%` }}
        />
      </div>
    </div>
  );
}

// [契约] 面板是纯投影：config 快照、受控或非受控弹层开关、撒花 arm 三组输入，
// 输出顶部标题与刷新动作、重置机会徽标、额度条网格、重置弹窗配置。
// [并发] 弹层开关可由父层受控；未传时用内部状态，二者只取其一，不并存。
// [事务] 重置 UI 以展示中的供应商与权益为键重建，供应商切换后旧机会与旧完成态不串档。
// [失败路径] 解析不出快照时整块不渲染，绝不在无数据时输出空壳容器。
export function ChatCodingPlanUsageRemainingPanel({
  config,
  intl,
  locale,
  quotaResetDialogOpen,
  separated = false,
  autoCelebrateArm,
  onAutoCelebrated,
  onQuotaResetDialogOpenChange,
}: {
  config: ChatCodingPlanUsageRemainingConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  quotaResetDialogOpen?: boolean;
  separated?: boolean;
  /** 自动/运营完成后,由 Composer 触发器在 hover 展开面板时要求补播撒花的自动完成 used_at(按类型)。 */
  autoCelebrateArm?: CodingPlanQuotaResetAutoConfettiArms | null;
  onAutoCelebrated?: (completedAt: number) => void;
  onQuotaResetDialogOpenChange?: (open: boolean) => void;
}) {
  // [并发] 快照只在 config 引用变化时重算：父层必须给出稳定 config，
  // 否则每次渲染重建状态，把加载态抖成真并带来无意义重渲染。
  // [契约] 解析结果同时给出可见快照、展示权益与加载态，三者由同一函数保证口径一致。
  // [失败路径] 解析失败给空态而非抛错，由下方空值早退统一兜底。
  const state = useMemo(() => resolveCodingPlanUsageRemainingState(config), [config]);
  // [并发] 快照加载与父层刷新两个来源任一为真即视为刷新中，头部按钮据此防重复点击。
  const actionRefreshing = state?.loading || config.refreshing === true;
  // [失败路径] 只有同时存在可见快照与权益错误才算「缓存过期」，此时降级为警示文案并保留旧数据。
  const cachedUpdateError =
    Boolean(state?.visibleSnapshot) && Boolean(state?.displayedEntitlement?.error);
  // [事务] 受控优先：父层给出开关时不读内部状态，回调用父层回调，
  // 否则退化为内部状态；两条路径不并存，避免同一弹窗出现两个真相。
  // [契约] 内部状态只服务独立使用场景，父层接管控件后它不再被写入。
  const [uncontrolledQuotaResetDialogOpen, setUncontrolledQuotaResetDialogOpen] = useState(false);
  const resolvedQuotaResetDialogOpen = quotaResetDialogOpen ?? uncontrolledQuotaResetDialogOpen;
  const setQuotaResetDialogOpen =
    onQuotaResetDialogOpenChange ?? setUncontrolledQuotaResetDialogOpen;
  // [事务] 重置 UI 状态按展示中的供应商与权益重建：sourceKey 区分来源，
  // preferredProviderId 与 accountAccess 决定能否发起核销，刷新回调由父层透传。
  // [竞态] 供应商切换时 sourceKey 变化即重建，旧供应商的机会与处理中状态不延续。
  // [契约] 本文件不写该 hook 的状态，只消费 entry、week 与 processing。
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey: state?.displayedProviderId,
    preferredProviderId: state?.displayedEntitlement?.providerId,
    accountAccess: state?.displayedEntitlement?.accountAccess,
    onEntitlementRefresh: config.onEntitlementRefresh,
  });
  // [失败路径] 无快照即无数据源：整块不渲染，避免下游对空值的 limits 与 remaining 取值。
  // [契约] 早退必须位于全部 hook 调用之后，保证每次渲染 hook 数量一致。
  // [权衡] 不留占位空壳，让 Composer 相邻布局自然收缩，而不是留一块空白。
  // [契约] 是否挂载由父层决定，本组件只在挂载后判断是否产出内容，因此 state 为空时直接返回 null。
  if (!state) {
    return null;
  }

  // [契约] 以下取值全部走可见快照而不是当前权益的原始响应：
  // 刷新进行中也要继续展示上一次成功数据，避免中途闪成空。
  // [失败路径] quota、limits、remaining 任一层缺失都退化为空值或空数组，由渲染分支降级。
  // [权衡] 用空值合并而非逻辑或，等级为 0 之类合法假值不会被误判缺失。
  const planLevel = state.visibleSnapshot?.quota?.level ?? null;
  const remaining = state.visibleSnapshot?.remaining;
  const unavailableReason = state.visibleSnapshot?.unavailableReason;
  const limits = state.visibleSnapshot?.quota?.limits ?? [];
  // [契约] 四类额度定位口径固定：五小时 TOKENS_LIMIT 加 3/5 双键，周 TOKENS_LIMIT 加单键 6，
  // 月工具 TIME_LIMIT 加 5/1，MCP 由 resolveMcpQuotaLimit 单独解析。
  // [事务] 前两者再经 resolveCodingPlanQuotaResetLimit 合并重置 UI 条目，
  // 使额度条上的重置按钮与弹窗条目指向同一条记录。
  const fiveHourTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyTokenLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  // [契约] 月工具调用是次数口径（TIME_LIMIT），与 token 口径不可互换；
  // 它不参与重置核销，因此不经过重置 UI 合并。
  const monthlyToolLimit = findCodingPlanQuotaLimit(limits, "TIME_LIMIT", 5, 1);
  // [契约] MCP 额度不复用 token 窗口解析：它按自然日重置、单独成条，
  // 由专用解析函数从快照中取出，避免与五小时、周的 token 口径互相覆盖。
  // [失败路径] 快照里没有 MCP 额度时得到空值，额度条与弹窗条目一并缺席。
  const mcpQuotaLimit = resolveMcpQuotaLimit(state.visibleSnapshot);
  // 五小时与周机会合并为一个徽标,次数累加,倒计时取最早到期的一档。
  // [事务] 五小时与周两次机会合并为一个徽标：次数累加、到期取最早，
  // 保证入口只在确实还有可用机会时出现，也不会因某一档过期而误隐藏另一档。
  const opportunityBadge = resolveChatCodingPlanResetOpportunityBadge(
    state,
    resetUi,
  );
  // [契约] 五小时重置时间只取时分（h23），交给本文件的轻量格式化函数；
  // 周与月走通用日期格式化，MCP 与周保持同一日期口径。
  // [失败路径] 无重置时间时不生成文案，数值行不会留下孤立的分隔点。
  const fiveHourResetTime = fiveHourTokenLimit?.nextResetTime
    ? formatContextFiveHourResetTime({
        locale,
        value: fiveHourTokenLimit.nextResetTime,
      })
    : undefined;
  // [契约] 周额度按日期展示，与五小时的时分口径区分；format 由 "time" 改为 "date"，重置时间因此只带日。
  // weeklyTokenLimit 无重置时间时 weeklyResetTime 保持 undefined；额度条据此省略时间后缀，不留孤立分隔点。
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
  // [契约] MCP 重置恒为自然日零点，展示到日即可；与周、月工具统一日期口径，
  // 避免同排额度条出现两种时间粒度。
  const mcpResetTime = mcpQuotaLimit?.nextResetTime
    ? formatQuotaResetTime({ locale, value: mcpQuotaLimit.nextResetTime, format: "date" })
    : undefined;
  // [失败路径] 四种不可用原因各自映射文案：未配置 → 未登录 → 无套餐 → 通用不可用，
  // 依次判定保证最具体的原因优先，用户看到可行动提示而不是笼统错误。
  // [契约] 文案全部走国际化消息，不在本文件拼接自然语言。
  // [权衡] 兜底用通用不可用而不是抛错，未知原因也仍给出刷新入口。
  const unavailableMessage =
    unavailableReason === "not_configured"
      ? intl.formatMessage({ id: "sidebar.usage.plan.notConfigured" })
      : unavailableReason === "not_authenticated"
        ? intl.formatMessage({ id: "sidebar.usage.plan.loginRequired" })
        : unavailableReason === "no_plan"
          ? intl.formatMessage({ id: "sidebar.usage.plan.noPlan" })
          : intl.formatMessage({ id: "sidebar.usage.plan.unavailable" });
  // [失败路径] 仅当不在加载、无剩余量、无任何额度条、无套餐等级时才判不可用；
  // 任一存在都说明有可展示事实，不能落到不可用空态。
  // [契约] 该判定只用于渲染分支选择，不参与 Composer 触发器的显示判定。
  const unavailable = !state.loading && !remaining && limits.length === 0 && !planLevel;
  // [契约] 四类额度按固定顺序装配：五小时 → 周 → 月工具 → MCP，配色取 usage-chart-1/2/3/5；
  // 缺失项直接跳过，末尾用类型守卫滤掉空项；quotaMeters 因此不含空条目，下游不必再判空。
  // [事务] 该数组是额度条与重置弹窗的共同数据源，顺序与配色只在此处定义一次。
  // [权衡] 不生成空条目占位，空档交由网格列数处理，避免出现无数据的空条。
  const quotaMeters = [
    fiveHourTokenLimit
      ? {
          color: "var(--color-usage-chart-1)",
          key: "fiveHour",
          label: intl.formatMessage({
            id: "sidebar.usage.plan.fiveHour",
          }),
          limit: fiveHourTokenLimit,
          resetTime: fiveHourResetTime,
        }
      : null,
    weeklyTokenLimit
      ? {
          color: "var(--color-usage-chart-2)",
          key: "weekly",
          label: intl.formatMessage({ id: "sidebar.usage.plan.weekly" }),
          limit: weeklyTokenLimit,
          resetTime: weeklyResetTime,
        }
      : null,
    monthlyToolLimit
      ? {
          color: "var(--color-usage-chart-3)",
          key: "monthlyTool",
          label: intl.formatMessage({
            id: "sidebar.usage.plan.toolCalls",
          }),
          limit: monthlyToolLimit,
          resetTime: monthlyToolResetTime,
        }
      : null,
    mcpQuotaLimit
      ? {
          color: "var(--color-usage-chart-5)",
          key: "mcp",
          label: intl.formatMessage({ id: "sidebar.usage.plan.mcp" }),
          limit: mcpQuotaLimit,
          resetTime: mcpResetTime,
        }
      : null,
  ].filter((meter): meter is NonNullable<typeof meter> => meter !== null);
  // [契约] MCP 条单独渲染（自带描述与不同布局），其余三档进网格；
  // 列数取条数与 3 的较小值，保证最多三列且不出现空网格。
  const primaryQuotaMeters = quotaMeters.filter((meter) => meter.key !== "mcp");
  const mcpQuotaMeter = quotaMeters.find((meter) => meter.key === "mcp");
  const quotaGridCount = Math.min(primaryQuotaMeters.length + (mcpQuotaMeter ? 1 : 0), 3);
  // [契约] 弹窗配置与额度条同源：用量项由 quotaMeters 逐项映射，
  // 百分比与文案复用同一组展示函数，避免两处口径漂移。
  // [事务] 五小时与周的启用标记来自额度条是否存在，与界面可见性严格一致。
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourTokenLimit),
    resetUi,
    usageItems: quotaMeters.map((meter) => ({
      color: meter.color,
      id: meter.key,
      label: meter.label,
      percentage: getQuotaRemainingPercentage(meter.limit),
      resetTime: meter.resetTime,
      value: formatQuotaRemainingPercentage(locale, meter.limit),
    })),
    weekEnabled: Boolean(weeklyTokenLimit),
  });

  // [失败路径] 渲染按优先级互斥：加载中且无快照 → 有错误且无快照 → 不可用 → 正常额度条；
  // 顺序颠倒会让首屏误报错误，或让空态盖住真实数据。
  // [契约] MCP 条在网格之外单独渲染，不受上面四分支影响，有数据即出现。
  // [权衡] 有缓存快照时即使处于错误态也走正常分支，把错误降级为头部警示而不是整块替换。
  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="flex min-w-0 items-center mb-2 gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "sidebar.usage.plan.title" })}
          </span>
          {(fiveHourTokenLimit && resetUi.entry) ||
          (weeklyTokenLimit && resetUi.week.entry) ? (
            <CodingPlanQuotaResetOpportunity
              count={opportunityBadge.count}
              dialog={quotaResetDialog}
              dialogOpen={resolvedQuotaResetDialogOpen}
              expiresAt={opportunityBadge.expiresAt}
              placement="tooltip"
              visible={opportunityBadge.visible}
              onDialogOpenChange={setQuotaResetDialogOpen}
            />
          ) : null}
        </div>
        <CodingPlanUsageHeaderAction
          error={state.displayedEntitlement?.error}
          loading={actionRefreshing}
          openLabel={intl.formatMessage({ id: "sidebar.usage.plan.open" })}
          refreshingLabel={intl.formatMessage({
            id: "sidebar.usage.plan.refreshing",
          })}
          updatedLabel={intl.formatMessage({
            id: "sidebar.usage.plan.updated",
          })}
          warningLabel={
            cachedUpdateError
              ? intl.formatMessage({ id: "sidebar.usage.plan.updateFailed" })
              : undefined
          }
          onUsageClick={config.onUsageClick}
        />
      </div>
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(quotaGridCount))}>
        {state.loading && !state.visibleSnapshot ? (
          <div className="flex items-center gap-2 p-2 text-ui-base text-foreground-subtle">
            <Loader2 className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "sidebar.usage.plan.loading" })}
          </div>
        ) : state.displayedEntitlement?.error && !state.visibleSnapshot ? (
          <CodingPlanUsageNotice
            message={intl.formatMessage({
              id: "sidebar.usage.plan.updateFailed",
            })}
            refreshLabel={intl.formatMessage({
              id: "sidebar.usage.plan.refresh",
            })}
            onRefresh={config.onEntitlementRefresh}
          />
        ) : unavailable ? (
          <CodingPlanUsageNotice
            message={unavailableMessage}
            refreshLabel={intl.formatMessage({
              id: "sidebar.usage.plan.refresh",
            })}
            onRefresh={config.onEntitlementRefresh}
          />
        ) : (
          primaryQuotaMeters.map((meter) => (
            <ChatCodingPlanUsageMeter
              key={meter.key}
              color={meter.color}
              label={meter.label}
              action={
                // 额度标题旁入口只打开统一弹窗；真正核销由弹窗内对应类型按钮触发。
                meter.key === "fiveHour" &&
                resetUi.entry &&
                (resetUi.opportunityVisible ||
                  resetUi.processing ||
                  resetUi.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    autoCelebrateCompletedAt={autoCelebrateArm?.FIVE_HOUR ?? null}
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi)}
                    processing={resetUi.processing}
                    onAutoCelebrated={onAutoCelebrated}
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : meter.key === "weekly" &&
                  resetUi.week.entry &&
                  (resetUi.week.opportunityVisible ||
                    resetUi.week.processing ||
                    resetUi.week.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    autoCelebrateCompletedAt={autoCelebrateArm?.WEEK ?? null}
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi.week)}
                    processing={resetUi.week.processing}
                    resetType="WEEK"
                    onAutoCelebrated={onAutoCelebrated}
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : undefined
              }
              percentage={getQuotaRemainingPercentage(meter.limit)}
              resetTime={meter.resetTime}
              value={formatQuotaRemainingPercentage(locale, meter.limit)}
            />
          ))
        )}
        {mcpQuotaMeter ? (
          <ChatCodingPlanMcpUsageMeter
            color={mcpQuotaMeter.color}
            description={intl.formatMessage({
              id: "sidebar.usage.plan.zcodeMcpDescription",
            })}
            label={intl.formatMessage({ id: "sidebar.usage.plan.zcodeMcp" })}
            percentage={getQuotaRemainingPercentage(mcpQuotaMeter.limit)}
            primaryQuotaCount={primaryQuotaMeters.length}
            resetTime={mcpQuotaMeter.resetTime}
            value={formatQuotaRemainingPercentage(locale, mcpQuotaMeter.limit)}
          />
        ) : null}
      </div>
    </div>
  );
}
