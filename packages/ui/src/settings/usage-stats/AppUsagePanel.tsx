// INV-01 两张图表必须保持 lazy 拆包，禁止改成顶层静态 import；守住位置：AppUsageDailyModelTrendChart 与 AppUsageModelUsagePieChart 两处 lazy 声明；改错故障：Recharts 在模块初始化阶段触发 decimal.js-light 的 LN10 校验，Electron Linux 容器里 renderer 直接起不来。
// INV-02 动态 import 的结果必须再取具名导出作为 default 字段；守住位置：两个 then 回调里对 module.AppUsageDailyModelTrendChart 与 module.AppUsageModelUsagePieChart 的取值；改错故障：React.lazy 拿到 undefined，Suspense 内渲染报错，图表区变成空白。
// INV-03 [并发] lifetime 与当前窗口必须各用一个 hook 实例；守住位置：AppUsagePanel 顶部 useAppUsageStats 的 all 与 range 两次调用；改错故障：两份数据共用一个实例，切 range 时摘要条与热力图一起被清空或串成同一窗口。
// INV-04 [权衡] 时间窗口默认值固定为 7d 且只作组件内状态；守住位置：useState<AppUsageRange> 的初值 7d；改错故障：默认落到 all 会让 range tabs 无选中项，或把 lifetime 与窗口数据混成一份。
// INV-05 [失败路径] 只有首次加载且尚无快照时才展示加载占位；守住位置：AppUsagePanel 的 loading 与 !snapshot 联合判断；改错故障：同窗口重刷也命中骨架屏，图表被卸载重建，滚动位置丢失。
// INV-06 [失败路径] 加载分支不得渲染任何图表组件；守住位置：loading 分支返回的摘要条、tabs 与 UsageEmptyState 三个子节点；改错故障：null 快照被图表当作有效输入，渲染抛错后连加载提示一起消失。
// INV-07 [失败路径] 无快照且存在错误时必须显示错误提示；守住位置：!snapshot 分支里对 error 的条件渲染；改错故障：首次请求失败只剩暂无数据，用户无法区分真空数据与请求失败。
// INV-08 [契约] 无快照分支仍要保留摘要条与 range tabs；守住位置：!snapshot 分支的前两个子节点；改错故障：失败后无法切换窗口重试，且 lifetime 摘要整块消失。
// INV-09 [契约] 热力图只在 lifetime 的 weeks 非空时渲染；守住位置：成功分支对 lifetimeSnapshot.heatmap.weeks.length 的判断；改错故障：空数组进入 UsageHeatmap 后画出空网格，或按 0 最大值做分级导致除零。
// INV-10 [契约] 热力图必须同时接收 locale 与 intl；守住位置：UsageHeatmap 的 locale 与 intl 两个 props；改错故障：日期与单位回退默认语言，中文界面出现英文月份。
// INV-11 [权衡] 有快照时的错误只降级为提示条；守住位置：成功分支里 error 存在才挂 UsageStatsErrorNotice；改错故障：一次刷新失败把仍可用的旧图表整块替换成错误页。
// INV-12 [资源] 两张图必须各自包一层图表加载边界；守住位置：两个 UsageChartLoadBoundary 的 scope 常量；改错故障：共用一个边界时一张图失败连带另一张白屏，错误信息也无法定位来源。
// INV-13 [并发] 边界的复位键必须包含窗口与生成时间；守住位置：两个 resetKeys 里的 snapshot.range 与 snapshot.generatedAt；改错故障：切 range 或刷新后错误边界不复位，图表永久停在失败态。
// INV-14 [契约] 饼图边界要多带一个 model-pie 字面量；守住位置：第二个 UsageChartLoadBoundary 的 resetKeys 第三项；改错故障：两张图复位键同形，缓存与失败状态互相干扰。
// INV-15 [并发] 手动刷新必须同时重取窗口与 lifetime 两份快照；守住位置：刷新按钮 onClick 里并列的 refresh 与 refreshLifetime 调用；改错故障：只刷一份，摘要数字与趋势图落在不同时间窗。
// INV-16 [失败路径] 刷新结果必须显式丢弃，不得让异常冒泡到事件层；守住位置：onClick 内的 void 前缀；改错故障：被拒绝的请求变成 unhandledrejection，且绕过 hook 内部的错误提示。
// INV-17 [契约] 摘要条五格字段映射不可换序；守住位置：AppUsageLifetimeSummaryStrip 的 items 数组 totalTokens、peakDayTokens、longestSessionMs、currentStreakDays、longestStreakDays；改错故障：token 数被当小时数展示，连续天数与最长会话互换。
// INV-18 [权衡] 快照为空时摘要只能显示短横，不能用 0 冒名；守住位置：items 每项的三元分支；改错故障：未加载时出现 0 tokens，用户误判自己没有任何用量。
//
// 模块职责：渲染本地 App Usage 面板，把 lifetime 与当前窗口两份快照组合成摘要条、热力图、日趋势图、模型占比图与刷新入口。
// 状态所有权：range 只在本组件内用 useState 持有，快照、loading 与 error 全部由 useAppUsageStats 管理；本文件只做派生与格式化，不缓存任何统计值。
// 阅读顺序：先看两个 lazy 图表声明与顶层双 hook，再看加载、空、成功三个返回分支，最后看摘要条与两个格式化函数。
import { RefreshCcw } from "lucide-react";
import { Fragment, lazy, useState } from "react";
import { APP_USAGE_RANGES } from "@zcode/shared";
import type { AppUsageRange, AppUsageSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAppUsageStats } from "@/hooks/useUsageStats.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import { UsageStatsErrorNotice } from "@/settings/usage-stats/UsageStatsErrorNotice.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  UsageEmptyState,
  formatCompactNumber,
  formatSummaryCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

// Recharts 会在模块初始化阶段触发 decimal.js-light 的 LN10 校验，
// 在 Electron Linux 容器里会阻断整个 renderer 启动。图表按需加载后，
// 普通启动和 e2e 首页不会被 Usage 页图表依赖影响，打开 Usage 时也由局部边界隔离。
// [资源] 两个图表用 lazy 拆包，模块初始化时只保留占位组件，不加载 Recharts。
// [失败路径] 静态导入会让 Recharts 在 renderer 启动阶段触发 decimal.js-light 的 LN10 校验，Linux 容器直接白屏。
// [契约] then 回调把具名导出包装成 default，React.lazy 只认 default 字段。
// [契约] 导入路径必须带 .js 扩展名并与其余内部导入一致，否则打包解析到错误模块。
// [权衡] 拆包代价是首次打开 Usage 多一次加载等待，由外层边界的加载态兜底。
// [契约] 两个 lazy 声明放在组件外，避免每次渲染生成新的组件类型导致图表反复卸载。
const AppUsageDailyModelTrendChart = lazy(() =>
  import("@/settings/usage-stats/AppUsageDailyModelTrendChart.js").then((module) => ({
    default: module.AppUsageDailyModelTrendChart,
  })),
);
const AppUsageModelUsagePieChart = lazy(() =>
  import("@/settings/usage-stats/AppUsageModelUsagePieChart.js").then((module) => ({
    default: module.AppUsageModelUsagePieChart,
  })),
);

// [状态所有权] intl 与 locale 来自 useZCodeIntl，面板自身不缓存任何文案。
// [状态所有权] range 是本组件私有 useState，不进入全局 store，也不回写服务。
// [事务] lifetime 快照固定查 all 窗口，用来喂摘要条与热力图，与当前 range 无关。
// [事务] range 快照由第二个 hook 提供，切换 tab 只替换这一份数据。
// [并发] 两个 hook 各自维护请求代次，面板不做二次合并，避免出现第三份快照来源。
// [契约] loading 与 error 只取 range 快照这一路，lifetime 失败不能把整页判成错误。
// [权衡] 两路请求并存意味着首屏两个查询，换来切 range 时摘要不闪空。
export function AppUsagePanel() {
  const { intl, locale } = useZCodeIntl();
  const [range, setRange] = useState<AppUsageRange>("7d");
  const { snapshot: lifetimeSnapshot, refresh: refreshLifetime } = useAppUsageStats("all");
  const { snapshot, loading, error, refresh } = useAppUsageStats(range);

  // [失败路径] 判定要求 loading 为真且无快照，只有首次加载会走这里。
  // [权衡] 同窗口重刷时保留旧快照，因此不会命中本分支，图表不会被卸载重建。
  // [契约] 分支内仍渲染摘要条与 range tabs，用户可在等待期间换窗口。
  // [契约] 加载占位复用 UsageEmptyState 加 loadingTitle，不引入第二套骨架组件。
  if (loading && !snapshot) {
    return (
      <div className="space-y-5">
        <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
          </div>
          <AppUsageRangeTabs range={range} onRangeChange={setRange} />
        </div>
        {/* Bugfix: App Usage 只聚合本地 session 历史，不能复用 Coding Plan 的 monitor API 加载说明。 */}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.appUsageLoadingDescription",
          })}
        />
      </div>
    );
  }

  // [失败路径] 走到这里表示请求已结束但没有可用快照，属于空数据或失败。
  // [契约] error 非空时先挂 UsageStatsErrorNotice，再渲染空状态，两个提示并存。
  // [契约] 空状态文案取 emptyTitle 与 emptyDescription，与加载态文案严格区分。
  // [失败路径] 摘要条与 range tabs 必须留在分支内，失败后仍能切窗口触发重试。
  if (!snapshot) {
    return (
      <div className="space-y-5">
        <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
          </div>
          <AppUsageRangeTabs range={range} onRangeChange={setRange} />
        </div>
        {error ? <UsageStatsErrorNotice error={error} /> : null}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
      {lifetimeSnapshot?.heatmap.weeks.length ? (
        <UsageHeatmap locale={locale} intl={intl} weeks={lifetimeSnapshot.heatmap.weeks} />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
        </div>
        <AppUsageRangeTabs range={range} onRangeChange={setRange} />
      </div>
      {error ? <UsageStatsErrorNotice error={error} /> : null}

      <UsageChartLoadBoundary
        scope="settings.usage.app-daily-model-chart"
        resetKeys={[snapshot.range, snapshot.generatedAt]}
        loadingDescription={intl.formatMessage({
          id: "settings.usage.appUsageLoadingDescription",
        })}
      >
        <AppUsageDailyModelTrendChart snapshot={snapshot} />
      </UsageChartLoadBoundary>
      <UsageChartLoadBoundary
        scope="settings.usage.app-model-pie-chart"
        resetKeys={[snapshot.range, snapshot.generatedAt, "model-pie"]}
        loadingDescription={intl.formatMessage({
          id: "settings.usage.appUsageLoadingDescription",
        })}
      >
        <AppUsageModelUsagePieChart snapshot={snapshot} />
      </UsageChartLoadBoundary>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-md bg-background"
          // [并发] 刷新必须一次覆盖两份快照，否则摘要与图表的时间窗错位。
          // [并发] 两路请求并行发出，不串行等待，任一失败只落到各自 hook 的 error。
          // [失败路径] 返回值被显式丢弃，拒绝由 hook 内部转成 error 文案，避免未处理拒绝。
          // [契约] 按钮不维护自己的 loading，禁用与文案完全由快照状态推导。
          onClick={() => {
            void Promise.all([refresh(), refreshLifetime()]);
          }}
        >
          <RefreshCcw className="size-3.5" />
          {intl.formatMessage({ id: "settings.usage.refresh" })}
        </Button>
      </div>
    </div>
  );
}

// [状态所有权] 组件无内部状态，五格指标全部由传入快照即时派生。
// [契约] 字段映射固定为总量、单日峰值、最长会话、当前连续、最长连续，顺序不可换。
// [权衡] 快照为 null 时统一显示两个短横，不用 0 冒充真实值。
// [契约] token 走 formatSummaryCompactTokenUsage 统一中文单位间距，时长与天数走本文件格式器。
// [契约] 分隔线按 index 大于 0 插入并标 aria-hidden，纯装饰不进无障碍树。
export function AppUsageLifetimeSummaryStrip({ snapshot }: { snapshot: AppUsageSnapshot | null }) {
  const { intl, locale } = useZCodeIntl();
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTotalTokens" }),
      value: snapshot
        ? formatSummaryCompactTokenUsage(locale, snapshot.summary.totalTokens)
        : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" }),
      value: snapshot
        ? formatSummaryCompactTokenUsage(locale, snapshot.summary.peakDayTokens)
        : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestSession" }),
      value: snapshot ? formatAppUsageDuration(snapshot.summary.longestSessionMs, intl) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.currentStreak" }),
      value: snapshot ? formatAppUsageDays(snapshot.summary.currentStreakDays, intl, locale) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestStreak" }),
      value: snapshot ? formatAppUsageDays(snapshot.summary.longestStreakDays, intl, locale) : "--",
    },
  ];

  return (
    <section className="flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center">
      {items.map((item, index) => (
        <Fragment key={item.label}>
          {index > 0 ? (
            <div aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
          ) : null}
          <div className="min-w-0 flex-1 px-4 py-3 text-center">
            <div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>
            <div className="mt-1 truncate text-ui-base text-foreground-subtle">{item.label}</div>
          </div>
        </Fragment>
      ))}
    </section>
  );
}

function formatAppUsageDays(
  days: number,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: string,
): string {
  return `${formatCompactNumber(locale, days)} ${intl.formatMessage({
    id: "settings.usage.duration.day",
  })}`;
}

export function formatAppUsageDuration(
  durationMs: number,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  // [失败路径] 时长先按分钟向下取整并钳到 0，负值与脏数据不会渲染成负时长。
  // [契约] 天、小时、分钟按 24 与 60 拆解，余数只用于下一级单位。
  // [契约] parts 为空时必须补 0 分钟，保证任何输入都有可读文案。
  // [契约] 天与小时为 0 时跳过对应段，最终用单空格拼接。
  // [契约] 天数格式器复用 formatCompactNumber，避免长数字撑破摘要格。
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${intl.formatMessage({ id: "settings.usage.duration.day" })}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${intl.formatMessage({ id: "settings.usage.duration.hour" })}`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${intl.formatMessage({ id: "settings.usage.duration.minute" })}`);
  }
  return parts.join(" ");
}

function AppUsageRangeTabs({
  range,
  onRangeChange,
}: {
  range: AppUsageRange;
  onRangeChange: (range: AppUsageRange) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Tabs
      value={range}
      onValueChange={(value) => onRangeChange(value as AppUsageRange)}
      className="shrink-0"
    >
      <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
        {APP_USAGE_RANGES.filter((option) => option !== "all").map((option) => (
          <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
            {intl.formatMessage({ id: `settings.usage.range.${option}` })}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
