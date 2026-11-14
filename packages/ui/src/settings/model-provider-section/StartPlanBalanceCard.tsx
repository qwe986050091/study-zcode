// INV-01 可见桶过滤：守住位置 总量与余量的正数判断；改错故障：空桶占卡位。
// INV-02 服务端顺序：守住位置 展示顺序不再反转；改错故障：高优先级桶被排到最后。
// INV-03 全空隐藏：守住位置 非检查态的空列表早退；改错故障：没有额度时仍显示空卡片。
// INV-04 过期时间：守住位置 标签格式化的入参与判空；改错故障：无过期时间时显示出错文案。
// INV-05 桶刷新时间：守住位置 单桶字段来源；改错故障：把套餐级时间复制到所有桶。
// INV-06 百分比夹取：守住位置 余量比例的上下界；改错故障：进度条溢出或为负。
// INV-07 总量回退：守住位置 总量取值链；改错故障：缺字段时按零处理导致整桶消失。
// INV-08 数字格式：守住位置 百分比与整数的格式器；改错故障：小数位在小比例下丢失。
// INV-09 模型名归一：守住位置 展示名与代码的优先级；改错故障：同一模型出现两种写法。
// INV-10 空模型名：守住位置 过滤空串；改错故障：分隔符悬空。
// INV-11 类型回退：守住位置 无模型名时的回退；改错故障：卡片标题为空。
// INV-12 键稳定：守住位置 桶键的拼装；改错故障：同类型多桶被复用成一行。
// INV-13 归属精确：守住位置 按套餐标识过滤；改错故障：多套餐时同一桶出现在每张卡。
// INV-14 内嵌布局：守住位置 内嵌开关的容器样式；改错故障：内嵌卡片多出边框与内边距。
// INV-15 检查态：守住位置 加载图标分支；改错故障：刷新时没有任何反馈。
// INV-16 文案前缀：守住位置 余额与过期文案键；改错故障：串到其它设置区块的文案。
// INV-17 纯函数辅助：守住位置 底部的格式化与解析函数；改错故障：读外部状态导致同输入不同输出。
// INV-18 类型契约：守住位置 导出接口与返回类型；改错故障：调用方漏字段仍能编译。
//
// 模块职责：`StartPlanBalanceCard` 按额度桶展示余量比例、重置时间与模型名。
// 状态所有权：无内部状态；语言与文案来自国际化上下文，额度数据由上层传入。
// 阅读顺序：主卡片 → 单桶视图 → 解析与格式化辅助 → 套餐归属映射。
import { Loader2Icon } from "lucide-react";
import type {
  UsageEntitlementSubscriptionDetail,
  UsageQuotaLimit,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatStartPlanBucketResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { formatStartPlanExpireDate } from "./CodingPlanStatusMeta.js";
import { formatQuotaModelDisplayName } from "./quotaModelDisplayName.js";

// 主卡片：检查中即使没有可见桶也保留骨架，检查结束且全空才整体隐藏。
// `embedded` 模式去掉外框与内边距，嵌进套餐详情时不出现双层卡片。
// 过期时间标签可为空，为空时头部只留标题与加载标记。
//
export function StartPlanBalanceCard({
  isChecking,
  limits,
  expireTime,
  embedded = false,
}: {
  isChecking: boolean;
  limits: UsageQuotaLimit[];
  expireTime?: string | null;
  embedded?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  // 可见桶：总量或余量任一为正才计入，全零桶视为无效配置直接隐藏。
  // 过滤顺序保持后端返回的原序，展示层不再按余量重排。
  // 后端已按产品优先级排好顺序，前端再排会与服务端配置和用户预期不一致。
  //
  const visibleLimits = limits.filter((limit) => {
    const total = resolveLimitTotal(limit);
    const remaining = resolveLimitRemaining(limit);
    return total > 0 || remaining > 0;
  });
  // Today's balance 后端已经按产品优先级返回 balances。
  // UI 继续反转会把 GLM-5.2 放到最后，和服务端配置及用户预期不一致。
  const displayLimits = visibleLimits;
  // 早退条件：检查态下必须保留卡片，否则刷新瞬间卡片闪烁消失。
  // 该判断放在计算过期标签之前，省去无意义的格式化。
  //
  if (!isChecking && visibleLimits.length === 0) {
    return null;
  }
  // 过期标签：只在 `expireTime` 非空时生成，纯空白与空串同样按缺失处理。
  // 文案日期走套餐专用格式器，保证与其它计划位置的写法一致。
  //
  const expireTimeLabel = formatStartPlanBalanceExpireTimeLabel({
    expireTime,
    intl,
    locale,
  });
  return (
    <div
      className={embedded ? "" : "rounded-lg border border-border bg-card p-4"}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <h4 className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({
              id: "settings.modelProvider.startPlan.balance.title",
            })}
          </h4>
          {isChecking ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
        {expireTimeLabel ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtle">
            {expireTimeLabel}
          </span>
        ) : null}
      </div>
      {displayLimits.length > 0 ? (
        <div className="mt-3 flex gap-2 max-sm:flex-col">
          {displayLimits.map((limit) => (
            <StartPlanBalanceLimit
              key={resolveLimitKey(limit)}
              limit={limit}
              locale={locale}
              // 桶刷新时间只来自本桶的 expires_at（limit.nextResetTime），
              // 不再用套餐级 renewTime 兜底，避免把同一时间复制到所有桶。
              renewTimeLabel={formatStartPlanBucketResetTime(
                locale,
                limit.nextResetTime,
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// 单桶视图：标题是模型名，右侧是余量百分比，下方是进度条与完整用量。
// 比例先夹到零到一，再交给百分比格式器，异常数据不会画出越界条。
// `renewTimeLabel` 可为空：为空时不渲染占位节点。
//
function StartPlanBalanceLimit({
  limit,
  locale,
  renewTimeLabel,
}: {
  limit: UsageQuotaLimit;
  locale: string;
  renewTimeLabel?: string;
}) {
  const total = resolveLimitTotal(limit);
  const remaining = resolveLimitRemaining(limit);
  // 比例计算：总量为零时直接取零，避免除零得到非数值。
  // 夹取放在除法之后，保证进度条宽度始终在合法区间。
  //
  const remainingRatio =
    total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const remainingPercent = formatRemainingPercent(locale, remainingRatio);

  return (
    <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
      <div className="truncate text-ui-base font-medium text-foreground">
        {formatLimitModels(limit)}
      </div>
      <div className="mt-2 flex min-w-0 items-baseline justify-between gap-3">
        <span className="shrink-0 text-ui-lg font-semibold leading-none text-foreground">
          {remainingPercent}
        </span>
        {renewTimeLabel ? (
          <span className="min-w-0 truncate text-right text-ui-xs text-foreground-subtle">
            {renewTimeLabel}
          </span>
        ) : null}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-success"
          style={{ width: `${remainingRatio * 100}%` }}
        />
      </div>
      <div className="mt-2 truncate text-ui-xs text-foreground-subtle">
        {formatFullTokenUsage(locale, remaining)} / {formatFullTokenUsage(locale, total)}
      </div>
    </div>
  );
}

// 桶键：类型加模型名，同一类型下的不同模型桶不会互相复用。
// 键只用于渲染复用，不参与任何协议字段。
//
function resolveLimitKey(limit: UsageQuotaLimit): string {
  return `${limit.type}:${formatLimitModels(limit)}`;
}

function resolveLimitTotal(limit: UsageQuotaLimit): number {
  return limit.number ?? limit.unit ?? 0;
}

function resolveLimitRemaining(limit: UsageQuotaLimit): number {
  return limit.remaining ?? 0;
}

function formatRemainingPercent(locale: string, ratio: number): string {
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: ratio >= 0.1 ? 0 : 1,
    style: "percent",
  }).format(ratio);
}

function formatFullTokenUsage(locale: string, value: number): string {
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 0,
  }).format(value);
}

export interface StartPlanQuotaCardEntry {
  plan: UsageEntitlementSubscriptionDetail;
  limits: UsageQuotaLimit[];
}

// 套餐归属：每个套餐只收标识完全匹配的桶，前后空白先归一。
// 服务端契约保证每桶都带套餐标识，因此不再对缺失标识做单套餐兜底。
// 兜底会在多套餐场景把同一桶复制进每张卡片，导致用量被重复展示。
//
export function resolveStartPlanQuotaCardEntries({
  plans,
  limits,
}: {
  plans: UsageEntitlementSubscriptionDetail[];
  limits: UsageQuotaLimit[];
}): StartPlanQuotaCardEntry[] {
  return plans.map((plan) => ({
    plan,
    // 额度桶只按 plan_id 精确归属。服务端契约保证每个桶都带 plan_id，
    // 不再对无 plan_id 的桶做单套餐兜底，否则多套餐下会把同一桶复制进每张卡片。
    limits: limits.filter((limit) => limit.planId?.trim() === plan.productId.trim()),
  }));
}

function formatStartPlanBalanceExpireTimeLabel({
  expireTime,
  intl,
  locale,
}: {
  expireTime?: string | null;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
}): string | null {
  const normalizedExpireTime = expireTime?.trim();
  if (!normalizedExpireTime) {
    return null;
  }
  return intl.formatMessage(
    { id: "settings.modelProvider.codingPlan.expiresAt" },
    {
      date: formatStartPlanExpireDate(normalizedExpireTime, locale),
    },
  );
}

function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(
        displayName || formatModelCode(detail.modelCode.trim()),
      );
    })
    .filter((modelName) => modelName.length > 0);
  if (modelNames.length === 0) {
    return limit.type;
  }

  return modelNames.join(" / ");
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode.replace(/^model:/i, "");
  if (normalized.toLowerCase() === "glm-5-turbo") {
    return "GLM-5Turbo";
  }
  return normalized.toUpperCase();
}
