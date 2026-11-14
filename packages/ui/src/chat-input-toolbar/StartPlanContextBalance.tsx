// INV-01 百分比必须夹取到 0 到 1：守住位置 比例夹取；改错故障 超额用量显示负值或超过百分之百。
// INV-02 非法比例回落为 0：守住位置 有限数判断；改错故障 非数污染格式化输出。
// INV-03 百分比按整数显示：守住位置 小数位设置；改错故障 小数位造成宽度跳动。
// INV-04 总量优先取数量，再取单位，最后为 0：守住位置 总量解析；改错故障 缺数量时误判为有额度。
// INV-05 剩余量缺失按 0 处理：守住位置 剩余量解析；改错故障 空值参与除法得到非数。
// INV-06 只有总量或剩余为正的额度才展示：守住位置 可见额度过滤；改错故障 空额度占位卡片。
// INV-07 没有可展示额度且不在加载中时整段不渲染：守住位置 面板早退；改错故障 出现空标题区。
// INV-08 存在按需刷新入口即保留触发器：守住位置 可用性判断的兜底；改错故障 首次无快照时用户没有入口。
// INV-09 加载中与静默刷新都要显示旋转指示：守住位置 两个标记的或判断；改错故障 静默刷新无反馈。
// INV-10 重置时间只取本桶字段：守住位置 重置时间格式化入参；改错故障 多套餐下同一时间被复制到每个桶。
// INV-11 模型名优先使用显示名，否则走统一解析：守住位置 模型名拼接；改错故障 同一模型两种叫法。
// INV-12 模型列表为空时回退到额度类型：守住位置 长度判断；改错故障 标题空白。
// INV-13 模型名按原顺序用斜杠连接：守住位置 连接调用；改错故障 顺序随对象键变化。
// INV-14 升级按钮点击必须阻止冒泡与默认行为：守住位置 点击处理；改错故障 触发外层卡片跳转。
// INV-15 折扣命中时按钮使用高亮样式并附徽标：守住位置 高亮标记；改错故障 优惠信息不可见。
// INV-16 图标按钮必须带读屏文本：守住位置 视觉隐藏文案；改错故障 读屏用户无法识别按钮。
// INV-17 进度条宽度只由剩余比例决定：守住位置 宽度内联样式；改错故障 进度与文字数值不一致。
// INV-18 动画必须尊重减弱动效偏好：守住位置 动效降级类名；改错故障 前庭敏感用户仍看到过渡。
//
// 模块职责：渲染 Start Plan 余额面板，展示各额度桶的剩余比例与重置时间。
// 状态所有权：快照与刷新标记来自入参；折扣状态由共享 hook 提供，组件不发起请求。
// 阅读顺序：先看总量与比例格式化，再读可见额度过滤与可用性判断，最后看面板与单桶渲染。
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { Loader2Icon, RocketIcon } from "lucide-react";
import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
  useCodingPlanBillingDiscount,
} from "@/CodingPlanBillingDiscount.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { formatStartPlanBucketResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { formatQuotaModelDisplayName } from "@/settings/model-provider-section/quotaModelDisplayName.js";

export interface ChatStartPlanBalanceConfig {
  loading: boolean;
  /** hover 打开 context 面板时发起的静默 access 刷新（与 Coding Plan 段 onAccess 语义一致）。 */
  onAccess?: () => Promise<void> | void;
  onUpgradeClick?: () => void;
  /** hover 触发的本次刷新 promise 进行中；静默刷新不置 entitlement.loading，spinner 需要跟随它。 */
  refreshing?: boolean;
  snapshot: UsageEntitlementSnapshot | null;
}

// resolveLimitTotal 按 limit.number ?? limit.unit ?? 0 取总量：数量字段优先，没有时才用 unit，两者都缺按 0，
// 这样 getVisibleStartPlanLimits 的 total > 0 判断不会因缺字段抛错，也不会把没有额度的桶误判为可见；
// 这里不做单位换算，unit 只作为数值兜底参与可见性判断。
function resolveLimitTotal(limit: UsageQuotaLimit): number {
  return limit.number ?? limit.unit ?? 0;
}

function resolveLimitRemaining(limit: UsageQuotaLimit): number {
  return limit.remaining ?? 0;
}

// formatStartPlanRemainingPercentage 先 Number.isFinite(ratio) 校验（NaN/Infinity 一律按 0），再把比例夹到 [0,1]，
// 防止超额用量显示成负数或超过 100%；Intl.NumberFormat 用 style:"percent" + maximumFractionDigits:0，
// 整数百分比才不会随小数位变化抖动宽度；locale 为空时传 undefined 交回运行环境默认。
function formatStartPlanRemainingPercentage(ratio: number, locale: string): string {
  const boundedRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(boundedRatio);
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode.replace(/^model:/i, "");
  if (normalized.toLowerCase() === "glm-5-turbo") {
    return "GLM-5Turbo";
  }
  return normalized.toUpperCase();
}

function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  if (modelNames.length === 0) {
    return limit.type;
  }

  return modelNames.join(" / ");
}

function getVisibleStartPlanLimits(snapshot: UsageEntitlementSnapshot | null): UsageQuotaLimit[] {
  return (snapshot?.quota?.limits ?? []).filter((limit) => {
    const total = resolveLimitTotal(limit);
    const remaining = resolveLimitRemaining(limit);
    return total > 0 || remaining > 0;
  });
}

// hasChatStartPlanBalance 在 config 缺失时返回 false；否则只要 config.loading、可见额度非空、或 config.onAccess 存在
// 就保留触发器——onAccess 是可按需刷新入口，首次没有缓存快照时若把它排除，用户就没有 hover 入口发起第一次余额请求；
// Start Plan 与 Coding Plan 连接方式互斥，这个兜底不能只挂在 Coding Plan 配置上。
export function hasChatStartPlanBalance(config: ChatStartPlanBalanceConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  return (
    config.loading ||
    getVisibleStartPlanLimits(config.snapshot).length > 0 ||
    // Start Plan 与 Coding Plan 连接方式互斥，hover 刷新入口不能只挂在 Coding Plan
    // 配置上；首次无缓存快照时本段（含触发器）不渲染，用户没有 hover 入口发起第一次余额请求。
    // onAccess 存在即视为可按需刷新，保留触发器（对齐 hasChatCodingPlanUsageRemaining 的兜底）。
    Boolean(config.onAccess)
  );
}

// ChatStartPlanBalanceMeter 用 resolveLimitTotal/resolveLimitRemaining 算 remainingRatio：total > 0 时才做除法并夹到 [0,1]，
// total 为 0 直接给 0，避免除零得到 NaN/Infinity；renewTime 只取 limit.nextResetTime（本桶 expires_at），
// 不用套餐级 renewTime 兜底，否则多套餐下同一时间会被复制进每个桶；组件自身不发起请求。
function ChatStartPlanBalanceMeter({
  limit,
  locale,
}: {
  limit: UsageQuotaLimit;
  locale: string;
}) {
  const total = resolveLimitTotal(limit);
  const remaining = resolveLimitRemaining(limit);
  const remainingRatio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  // 桶刷新时间只来自本桶 expires_at（nextResetTime）；不再用套餐级 renewTime
  // 或全局聚合时间兜底，否则多套餐下会把同一时间复制进每个桶。
  const renewTime = formatStartPlanBucketResetTime(locale, limit.nextResetTime);

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="min-w-0 space-y-0.5 text-ui-sm">
        <div className="min-w-0 truncate text-foreground-subtle">
          {formatLimitModels(limit)}
        </div>
        <div className="min-w-0 text-ui-sm tabular-nums">
          <span className="font-mono text-foreground">
            {formatStartPlanRemainingPercentage(remainingRatio, locale)}
          </span>
          {renewTime ? (
            <span className="text-foreground-subtle"> · {renewTime}</span>
          ) : null}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
        {/* 修复原因：与 Coding Plan 额度条对齐，hover 静默刷新返回后宽度平滑过渡到新值，
            原先瞬间跳变导致"已刷新"完全无感；同时保留 motion-reduce 无障碍降级。 */}
        <div
          className="h-full rounded-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${remainingRatio * 100}%` }}
        />
      </div>
    </div>
  );
}

// ChatStartPlanBalancePanel 用 useCodingPlanBillingDiscount 决定 upgradeButtonHighlighted，把高亮与徽标绑在同一个 active；
// 非 loading 且 getVisibleStartPlanLimits 为空时整段 return null，避免空标题区；separated 只加 border-t，
// 标题与升级按钮同排，额度网格列数交给 getContextQuotaMeterGridClass(limits.length)。
export function ChatStartPlanBalancePanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatStartPlanBalanceConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const billingDiscount = useCodingPlanBillingDiscount();
  const upgradeButtonHighlighted = billingDiscount.active === true;
  const limits = getVisibleStartPlanLimits(config.snapshot);

  if (!config.loading && limits.length === 0) {
    return null;
  }

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.startPlan.balance.title" })}
          </span>
          {config.loading || config.refreshing === true ? (
            // 静默 access 刷新有缓存快照时不会把 entitlement.loading 置 true，
            // spinner 还要跟随 hover 触发的本次 promise（refreshing），与 Coding Plan 段语义一致。
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
        {config.onUpgradeClick ? (
          <div className="inline-flex shrink-0 items-center gap-1">
            <CodingPlanEntryButton
              type="button"
              size="xs"
              className={cn(
                "h-6 shrink-0 gap-1 px-2 text-ui-sm",
                upgradeButtonHighlighted &&
                  "button-gradient rounded-full pr-[5px] text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                config.onUpgradeClick?.();
              }}
            >
              <RocketIcon className="size-3" />
              {intl.formatMessage({ id: "chat.quota.action.upgrade" })}
              {upgradeButtonHighlighted ? (
                <CodingPlanBillingDiscountBadgePill
                  config={billingDiscount.config}
                  iconVisible={false}
                  size="compact"
                  variant="surface"
                />
              ) : null}
            </CodingPlanEntryButton>
            {upgradeButtonHighlighted ? (
              <CodingPlanBillingDiscountInfoDialog
                config={billingDiscount.config}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(limits.length))}>
        {limits.map((limit) => (
          <ChatStartPlanBalanceMeter
            key={`${limit.type}:${formatLimitModels(limit)}`}
            limit={limit}
            locale={locale}
          />
        ))}
      </div>
    </div>
  );
}
