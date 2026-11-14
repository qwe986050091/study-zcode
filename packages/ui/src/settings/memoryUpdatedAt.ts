// INV-01 输出全部走本地化消息：守住位置 格式化调用；改错故障 界面出现硬编码文案。
// INV-02 无效时间显示刚刚：守住位置 有限数判断；改错故障 无效日期显示为纪元时间。
// INV-03 一分钟内视为刚刚：守住位置 毫秒比较；改错故障 刚保存就显示分钟前。
// INV-04 半小时内给相对分钟：守住位置 上限比较；改错故障 长间隔仍显示分钟数。
// INV-05 分钟数向下取整：守住位置 取整函数；改错故障 显示多一分钟。
// INV-06 日界按本地零点计算：守住位置 起始日函数；改错故障 跨时区判断错日。
// INV-07 当天只显示时间：守住位置 相等比较；改错故障 当天也显示日期。
// INV-08 昨日单独成句：守住位置 偏移一天比较；改错故障 昨天落入星期分支。
// INV-09 本周内显示星期与时间：守住位置 周起点比较；改错故障 跨周仍显示星期。
// INV-10 周起点按周一对齐：守住位置 取模偏移；改错故障 周日被算到上一周。
// INV-11 更早显示日期与时间：守住位置 兜底返回；改错故障 远古记录没有时间。
// INV-12 跨年才补年份：守住位置 年份比较；改错故障 今年记录多出年份。
// INV-13 中文星期走消息键：守住位置 语言判断；改错故障 中文界面出现英文缩写。
// INV-14 其他语言用本地格式：守住位置 格式化器；改错故障 星期顺序不符合习惯。
// INV-15 小时制固定二十四小时：守住位置 选项常量；改错故障 下午显示重复小时。
// INV-16 时间格式两位补零：守住位置 选项常量；改错故障 九点显示成单字符。
// INV-17 日期分段由消息键决定：守住位置 条件选择键；改错故障 中文顺序错乱。
// INV-18 展示函数不读时钟：守住位置 入参当前时间；改错故障 相同入参两次渲染结果不同。
//
// 模块职责：把记忆文件的更新时间格式化成相对或绝对的可读文案。
// 状态所有权：无状态；当前时间与本地化实例全部由调用方注入。
// 阅读顺序：先看常量与日期起点，再看三个格式化辅助，最后看主入口的分支顺序。
import type { Locale } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

// MINUTE_MS 与 RELATIVE_MINUTES_LIMIT 只在此处定义。
// 相对时间上限 RELATIVE_MINUTES_LIMIT = 30。
// 超过 30 分钟改走 formatWeekday()/formatDate() 分支。
// 两个常量都不随 locale 变化。
const MINUTE_MS = 60_000;
const RELATIVE_MINUTES_LIMIT = 30;

// startOfLocalDay() 按本地时区取当天零点。
// 用 getFullYear()/getMonth()/getDate() 构造，不减去时分秒。
// 夏令时切换当天仍由 startOfLocalDay() 得到正确起点。
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// formatTime() 用传入的 locale 建 Intl.DateTimeFormat。
// hourCycle: "h23" 固定 24 小时制并补两位分钟。
// 显式传 locale，不依赖宿主默认时钟设置。
function formatTime(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).format(timestamp);
}

function formatWeekday(
  timestamp: number,
  locale: Locale,
  formatMessage: IntlInstance["formatMessage"],
): string {
  if (locale === "zh-CN") {
    return formatMessage(
      { id: "settings.memory.viewer.updated.weekdayZh" },
      { weekday: "日一二三四五六"[new Date(timestamp).getDay()] ?? "" },
    );
  }
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(timestamp);
}

function formatDate(
  timestamp: number,
  locale: Locale,
  includeYear: boolean,
  formatMessage: IntlInstance["formatMessage"],
): string {
  const date = new Date(timestamp);
  if (locale === "zh-CN") {
    return formatMessage(
      {
        id: includeYear
          ? "settings.memory.viewer.updated.dateYearMonthDay"
          : "settings.memory.viewer.updated.dateMonthDay",
      },
      {
        year: String(date.getFullYear()),
        month: String(date.getMonth() + 1),
        day: String(date.getDate()),
      },
    );
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(timestamp);
}

// formatMemoryUpdatedAt() 的分支顺序即优先级。
// 相对时间分支排在 today/yesterday 之前。
// weekStart 用 (getDay() + 6) % 7 回退到周一。
export function formatMemoryUpdatedAt({
  formatMessage,
  locale,
  now,
  updatedAt,
}: {
  formatMessage: IntlInstance["formatMessage"];
  locale: Locale;
  now: number;
  updatedAt: number;
}): string {
  const elapsedMs = now - updatedAt;
  if (!Number.isFinite(updatedAt) || elapsedMs < MINUTE_MS) {
    return formatMessage({ id: "settings.memory.viewer.updated.justNow" });
  }

  const elapsedMinutes = Math.floor(elapsedMs / MINUTE_MS);
  if (elapsedMinutes < RELATIVE_MINUTES_LIMIT) {
    return formatMessage(
      { id: "settings.memory.viewer.updated.minutesAgo" },
      { count: elapsedMinutes },
    );
  }

  const todayStart = startOfLocalDay(now);
  const updatedDayStart = startOfLocalDay(updatedAt);
  const time = formatTime(updatedAt, locale);
  if (updatedDayStart === todayStart) {
    return formatMessage({ id: "settings.memory.viewer.updated.today" }, { time });
  }

  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  if (updatedDayStart === yesterdayStart.getTime()) {
    return formatMessage({ id: "settings.memory.viewer.updated.yesterday" }, { time });
  }

  const today = new Date(todayStart);
  const weekStart = new Date(todayStart);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  if (updatedDayStart >= weekStart.getTime()) {
    return formatMessage(
      { id: "settings.memory.viewer.updated.weekday" },
      { time, weekday: formatWeekday(updatedAt, locale, formatMessage) },
    );
  }

  return formatMessage(
    { id: "settings.memory.viewer.updated.date" },
    {
      date: formatDate(
        updatedAt,
        locale,
        new Date(updatedAt).getFullYear() !== today.getFullYear(),
        formatMessage,
      ),
      time,
    },
  );
}
