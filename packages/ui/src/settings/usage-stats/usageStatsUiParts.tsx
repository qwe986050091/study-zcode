// INV-01 范围选项只有两档：守住位置 RANGE_OPTIONS；改错故障 后端不支持的区间被请求。
// INV-02 标签栏样式集中导出：守住位置 两个类名常量；改错故障 多处标签样式漂移。
// INV-03 非有限数显示占位：守住位置 Number.isFinite 判断；改错故障 非数值直接渲染。
// INV-04 千位以上走紧凑格式：守住位置 notation 三元；改错故障 大数字撑破卡片。
// INV-05 紧凑格式最多一位小数：守住位置 maximumFractionDigits；改错故障 数值宽度抖动。
// INV-06 Token 格式统一入口：守住位置 formatCompactTokenUsage；改错故障 各处写法不一致。
// INV-07 中文摘要保留单位间距：守住位置 零宽断言替换；改错故障 数字与单位粘连。
// INV-08 百分比精度按量级切换：守住位置 阈值比较；改错故障 小比例显示成整数零。
// INV-09 缺日期显示占位：守住位置 空值判断；改错故障 空日期渲染成非法值。
// INV-10 非法日期原样返回：守住位置 时间戳判断；改错故障 图表因格式化异常崩溃。
// INV-11 日期按 UTC 解析：守住位置 拼接零点后缀；改错故障 时区偏移导致日期错一天。
// INV-12 横轴只取短月名：守住位置 month short；改错故障 标签过长互相遮挡。
// INV-13 未知模型回退文案：守住位置 resolveModelLabel 兜底；改错故障 卡片标题为空。
// INV-14 指标卡尺寸可调：守住位置 valueSize 映射；改错故障 不同卡片字号不一致。
// INV-15 辅助文案可内联或下置：守住位置 helperPlacement；改错故障 两种布局互相覆盖。
// INV-16 图标类型沿用图标库：守住位置 icon 属性类型；改错故障 传入非图标组件导致崩溃。
// INV-17 空态只做展示：守住位置 UsageEmptyState；改错故障 空态混入业务逻辑。
// INV-18 本文件不含数据请求：守住位置 纯格式化与展示；改错故障 展示层直接拉取接口。
//
// 模块职责：使用统计页的数值格式化、指标卡与空态展示部件。
// 状态所有权：无状态；数值与文案全部由调用方传入。
// 阅读顺序：先看三个导出常量，再读数值与日期格式化，最后看两个展示组件。
import type { AppUsageRange } from "@zcode/shared";
import { Flame } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

export const RANGE_OPTIONS: AppUsageRange[] = ["7d", "30d"];
export const USAGE_STATS_TABS_LIST_CLASS =
  "flex h-7 rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-7";
export const USAGE_STATS_TABS_TRIGGER_CLASS =
  "h-6 flex-none justify-center rounded-full border-transparent bg-transparent px-2.5 py-0 text-ui-sm font-medium text-foreground-subtle data-active:border-transparent data-active:bg-background data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-background";

// 非有限数（NaN/Infinity）返回 "--"，不交给 Intl.NumberFormat。
// value < 1000 用 notation: "standard"，maximumFractionDigits 为 0。
// value >= 1000 切到 notation: "compact"，保留 1 位小数。
// 小数位随 notation 分支切换，两种量级不共用同一套参数。
// 分隔符与单位由 locale 决定，函数内不写死中文或英文。
// 每次调用都新建 Intl.NumberFormat，结果不做缓存。
export function formatCompactNumber(locale: string, value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return new Intl.NumberFormat(locale, {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

export function formatCompactTokenUsage(locale: string, value: number): string {
  return formatCompactTokenNumber(locale, value);
}

// 先走通用 token 格式。
// 先调用 formatCompactTokenUsage，复用通用 token 紧凑格式。
// 中文 locale 用正则 (?<=\d)(?=[万亿]) 在数字与单位间补空格。
// 其它语言原样返回 formatted，不插入额外空白。
// 该正则只服务于摘要卡片，明细表格仍用 formatCompactTokenUsage。
export function formatSummaryCompactTokenUsage(locale: string, value: number): string {
  const formatted = formatCompactTokenUsage(locale, value);

  // 通用紧凑格式会把中文单位直接贴在数字后；摘要卡片与相邻的时长、天数指标统一保留单位间距。
  return locale.startsWith("zh") ? formatted.replace(/(?<=\d)(?=[万亿])/u, " ") : formatted;
}

export function formatPercent(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: value >= 0.1 ? 0 : 1,
  }).format(value);
}

// 空日期返回占位。
// 以 UTC 零点解析。
// 非法日期原样返回。
// 合法日期按 locale 的 short 月日格式展示，timeZone 固定为 UTC。
// 时区固定为 UTC。
export function formatDay(locale: string, dateKey: string | null): string {
  if (!dateKey) {
    return "--";
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    // BigModel monitor 接口偶尔返回空字符串或非 yyyy-MM-dd 格式的日期,
    // 之前直接交给 Intl.DateTimeFormat 会抛 RangeError 把整个图表炸掉。
    return dateKey;
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatFullDay(locale: string, dateKey: string | null): string {
  if (!dateKey) {
    return "--";
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return dateKey;
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function formatMonth(locale: string, dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return dateKey.slice(5, 7);
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
  }).format(date);
}

export function resolveModelLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  modelId: string | null,
): string {
  return (
    modelId?.trim() || intl.formatMessage({ id: "settings.usage.unknownModel" })
  );
}

// icon 由调用方传入，组件不内置图标映射。
// valueSize 只有 sm/base/lg/xl 四档，决定数值字号。
// helperPlacement 为 "inline" 时辅助文案与数值同一行。
// helperPlacement 为 "below" 时辅助文案排在数值之后。
// helper 为空时不渲染辅助节点，布局不留占位。
export function UsageMetricCard({
  icon: Icon,
  label,
  value,
  helper,
  helperPlacement = "below",
  valueSize = "xl",
}: {
  icon: typeof Flame;
  label: string;
  value: string;
  helper?: string;
  helperPlacement?: "below" | "inline";
  valueSize?: "sm" | "base" | "lg" | "xl";
}) {
  const valueNode = (
    <div
      className={cn(
        "truncate font-semibold text-foreground",
        valueSize === "sm"
          ? "text-ui-base"
          : valueSize === "base"
          ? "text-ui-lg"
          : valueSize === "lg"
            ? "text-lg"
            : "text-3xl",
      )}
    >
      {value}
    </div>
  );

  return (
    <div className="min-w-0 rounded-xl bg-surface px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">
        <Icon className="size-3.5 shrink-0 text-foreground-subtle" />
        <span className="truncate">{label}</span>
      </div>
      {helperPlacement === "inline" && helper ? (
        <div className="mt-2 flex min-w-0 items-baseline gap-2">
          {valueNode}
          <div className="min-w-0 truncate text-ui-base text-foreground-subtle">
            {helper}
          </div>
        </div>
      ) : (
        <div className="mt-2">{valueNode}</div>
      )}
      {helper && helperPlacement === "below" ? (
        <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">
          {helper}
        </div>
      ) : null}
    </div>
  );
}

export function UsageEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <div className="text-ui-base font-medium text-foreground">{title}</div>
      <div className="mt-2 text-ui-base text-foreground-subtle">{description}</div>
    </div>
  );
}
