// INV-01 不可见或缺少类型时整块不渲染：守住位置 早退；改错故障 空白横幅占位。
// INV-02 展示回调只在真正进入视口且页面可见时触发：守住位置 交叉与可见性组合；改错故障 后台任务消耗提醒配额。
// INV-03 交叉状态必须由观察器回调更新：守住位置 观察器；改错故障 滚动进入视口不触发。
// INV-04 页面可见性变化也要重新上报：守住位置 可见性监听；改错故障 切回标签页不补报。
// INV-05 观察器与监听必须成对清理：守住位置 清理函数；改错故障 卸载后仍触发回调。
// INV-06 服务端直出文案优先于本地模板：守住位置 提供方限制分支；改错故障 服务端说明被覆盖。
// INV-07 文案键按类型解析，特殊类型再细分：守住位置 文案键解析；改错故障 低额度与耗尽共用一句。
// INV-08 按周期区分低额度文案：守住位置 周期分支；改错故障 一次性额度显示每日文案。
// INV-09 重试耗尽使用专用并发文案：守住位置 原因判断；改错故障 用户不知道是被重试耗尽。
// INV-10 令牌数缺失显示占位符：守住位置 空值判断；改错故障 显示非数。
// INV-11 令牌数不允许负数：守住位置 下限夹取；改错故障 展示负用量。
// INV-12 百分比夹取到 0 与 100：守住位置 上下界夹取；改错故障 超过百分之百。
// INV-13 紧凑令牌数保留一位小数：守住位置 格式化选项；改错故障 长数字撑破横幅。
// INV-14 折扣徽标只在可升级且折扣生效时出现：守住位置 布尔组合；改错故障 无升级入口也显示徽标。
// INV-15 折扣生效时升级按钮使用活动背景：守住位置 类名条件；改错故障 按钮与徽标拼接突兀。
// INV-16 关闭按钮只在可关闭时渲染：守住位置 可关闭判断；改错故障 不可关闭的提示被隐藏。
// INV-17 关闭按钮必须带读屏标签：守住位置 无障碍标签；改错故障 图标按钮无含义。
// INV-18 横幅容器携带测试标识：守住位置 数据属性；改错故障 自动化无法定位。
//
// 模块职责：渲染会话额度告警横幅，区分模型、每日、并发与 MCP 等场景。
// 状态所有权：告警状态与折扣信息来自入参；展示上报由观察器驱动。
// 阅读顺序：先看文案键表与解析，再读格式化与可见性上报，最后看横幅内容与操作。
import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { useEffect, useRef } from "react";
import type { CodingPlanBillingDiscountConfig } from "@zcode/shared";
import { InfoIcon, RocketIcon, XIcon } from "lucide-react";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
} from "@/CodingPlanBillingDiscount.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  SessionQuotaBannerKind,
  SessionQuotaBannerState,
} from "@/v4/sessionQuotaBannerState.js";

// MESSAGE_IDS 是 Record<SessionQuotaBannerKind, string> 穷尽映射，新增 kind 不补键会直接编译失败；它只存通用键，不含 provider-limited 的服务端直出文案，也不含 model-very-low / concurrent-limit 的细分，细分必须先由 resolveMessageId 拦下，否则会退化成笼统提示。
const MESSAGE_IDS: Record<SessionQuotaBannerKind, string> = {
  "model-very-low": "chat.quota.startPlan.modelVeryLow",
  "model-exhausted": "chat.quota.startPlan.modelExhausted",
  "daily-exhausted": "chat.quota.startPlan.dailyExhausted",
  "concurrent-limit": "chat.quota.startPlan.concurrentLimit",
  "provider-limited": "chat.quota.providerLimited",
  "mcp-quota-exhausted": "chat.quota.mcp.quotaExhausted",
  "mcp-plan-required": "chat.quota.mcp.codingPlanRequired",
};

// resolveMessageId 的顺序即优先级：model-very-low 再按 state.quotaPeriod 细分（daily → bucketDailyLow、one_time → bucketActivityLow、其余 → modelVeryLow），concurrent-limit 再按 state.concurrentLimitReason 细分（retry-exhausted-busy → concurrentLimit.retryExhausted）；只有其余类型才落到 MESSAGE_IDS[state.kind]，kind 为空返回 ""，避免 formatMessage 收到空 id。
function resolveMessageId(state: SessionQuotaBannerState): string {
  if (state.kind === "model-very-low") {
    return state.quotaPeriod === "daily"
      ? "chat.quota.startPlan.bucketDailyLow"
      : state.quotaPeriod === "one_time"
        ? "chat.quota.startPlan.bucketActivityLow"
        : "chat.quota.startPlan.modelVeryLow";
  }
  if (state.kind === "concurrent-limit") {
    return state.concurrentLimitReason === "retry-exhausted-busy"
      ? "chat.quota.startPlan.concurrentLimit.retryExhausted"
      : "chat.quota.startPlan.concurrentLimit";
  }
  return state.kind ? MESSAGE_IDS[state.kind] : "";
}

function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat().format(Math.max(0, Math.floor(value)));
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

// ConversationQuotaBanner 的渲染门槛是 state.visible && state.kind（缺一就在 effect 之后 return null，bannerRef 也不会进入观察）；message 先取 provider-limited 的 state.providerLimitedMessage，没有再走 resolveMessageId + formatMessage，模板参数 model 取 state.modelName、server 取 state.mcpServerName、remaining 为 null 时用 formatTokenCount(null) 的 "-" 否则按 locale 做 compact 且 maximumFractionDigits: 1、percent 交 formatPercent 夹到 0–100 再取整；showBillingDiscountBadge 要求 onUpgrade 存在且 billingDiscountActive === true，缺一则徽标、信息弹窗与活动底纹都不出现。
export function ConversationQuotaBanner({
  state,
  billingDiscountActive,
  billingDiscountConfig,
  upgradeActionLabelId = "chat.quota.action.upgrade",
  onUpgrade,
  onDismiss,
  onShown,
}: {
  state: SessionQuotaBannerState;
  billingDiscountActive?: boolean;
  billingDiscountConfig?: CodingPlanBillingDiscountConfig;
  upgradeActionLabelId?: string;
  onUpgrade?: () => void;
  onDismiss: () => void;
  onShown?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const bannerRef = useRef<HTMLDivElement>(null);
  // 该 effect 在 !onShown、!state.visible 或 bannerRef.current 为空时直接返回；intersecting 缓存 IntersectionObserver 最近一次 entry.isIntersecting，report 仅在 intersecting && document.visibilityState === "visible" 时调 onShown()——后台任务也会算出额度告警，只有真正进入视口且标签页可见才消耗该桶周期的一次提醒；visibilitychange 复用同一 report 补报切回前台，清理函数必须同时 observer.disconnect() 与 removeEventListener，否则卸载后仍会回调 onShown。
  useEffect(() => {
    if (!onShown || !state.visible || !bannerRef.current) return;
    // 后台任务也会计算额度状态，只有实际可见时才能消耗该桶周期的一次提醒。
    let intersecting = false;
    const report = () => {
      if (intersecting && document.visibilityState === "visible") onShown();
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      report();
    });
    observer.observe(bannerRef.current);
    document.addEventListener("visibilitychange", report);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", report);
    };
  }, [onShown, state.visible]);
  if (!state.visible || !state.kind) return null;

  // 文案构建在这里定型：state.kind === "provider-limited" 且 state.providerLimitedMessage 非空时原文直出（服务端措辞优先于本地模板），否则 formatMessage({ id: resolveMessageId(state) }, {...})；remaining 只在 state.remainingTokens 非 null 时走 compact 格式化，否则复用 formatTokenCount(null) 的占位符，percent 统一经 formatPercent 夹取，避免 -1% 或 140% 这类越界展示。
  const message =
    state.kind === "provider-limited" && state.providerLimitedMessage
      ? state.providerLimitedMessage
      : intl.formatMessage(
          { id: resolveMessageId(state) },
          {
            model: state.modelName ?? "",
            // MCP 提示点名具体 server；服务端那句是英文的，界面文案一律走 i18n。
            server: state.mcpServerName ?? "",
            remaining:
              state.remainingTokens === null
                ? formatTokenCount(null)
                : new Intl.NumberFormat(locale, {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(state.remainingTokens),
            percent: formatPercent(state.remainingPercent),
          },
        );
  const showBillingDiscountBadge = Boolean(onUpgrade) && billingDiscountActive === true;

  return (
    <div
      ref={bannerRef}
      className="mb-3 w-full px-4 max-md:px-2"
      data-testid="v4-session-quota-banner"
    >
      <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground">
          <InfoIcon className="size-4 shrink-0" />
          <div className="min-w-0 break-words">{message}</div>
        </div>
        {onUpgrade ? (
          <div className="inline-flex shrink-0 items-center gap-1">
            <CodingPlanEntryButton
              type="button"
              size="sm"
              className={cn(
                "h-auto gap-1.5 rounded-full",
                // Bugfix：V4 迁移时只带回了白色活动徽标，漏掉同款升级按钮的活动背景，
                // 导致默认黑底和徽标拼接突兀。这里与 Model Settings / Context 面板统一。
                showBillingDiscountBadge &&
                  "button-gradient pr-px text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
              )}
              onClick={onUpgrade}
            >
              <RocketIcon className="size-3.5" />
              {intl.formatMessage({ id: upgradeActionLabelId })}
              {showBillingDiscountBadge ? (
                <CodingPlanBillingDiscountBadgePill
                  config={billingDiscountConfig}
                  iconVisible={false}
                  variant="surface"
                />
              ) : null}
            </CodingPlanEntryButton>
            {showBillingDiscountBadge ? (
              <CodingPlanBillingDiscountInfoDialog config={billingDiscountConfig} />
            ) : null}
          </div>
        ) : null}
        {state.dismissible ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDismiss}
            aria-label={intl.formatMessage({ id: "common.close" })}
            className="shrink-0 rounded-full text-foreground-subtle hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
