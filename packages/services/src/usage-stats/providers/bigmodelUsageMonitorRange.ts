// resolveUsageTimeRange 只产出后端可接受的日期字符串、粒度与横轴，由调用方发起请求。
// INV-01：resolveUsageTimeRange 的区间为本地自然日闭区间，跨度必须等于 min(range, 30) 天（守住：end/start 的 setHours/setDate）。
// INV-02：CodingPlan 分支的所有日期都基于请求的 timeZone 计算，不混用宿主本地时区（守住：formatDateInTimeZone 的唯一调用点）。
// INV-03：custom 分支必须满足 1 ≤ days ≤ 30，越界抛错而不是截断（守住：两处 throw）。
// 破坏 INV-02：跨时区用户的「今天」会落到前一天，小时轴与配额重置时刻错位，图上出现虚假 0 值。
// 破坏 INV-01：多算一天会把后端尚无数据的日期当作 0，掩盖真实用量并拉低均值。
import type {
  CodingPlanUsageGranularity,
  CodingPlanUsageRequest,
  UsageStatsRequest,
} from "@zcode/shared";

// 后端明细只保留最近 30 天；上限同时约束预设与 custom，
// 若放宽到 90 天，接口会静默截断，而前端仍按完整长度绘图。
const MONITOR_MAX_RANGE_DAYS = 30;
// 未知 range 降级为 30 天而不是空区间：空区间会让调用方把「没请求」误判成「没用量」。
const MONITOR_DEFAULT_RANGE_DAYS = 30;
// custom 日期先过形状校验再进入 Date 运算，
// 否则 2026-02-30 会被 Date 静默滚到 3 月 2 日，区间长度与用户所选不符。
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

// resolveUsageTimeRange 只返回起止时间，不含横轴与粒度；
// 与下面的 CodingPlan 版本分开，避免摘要被迫承担图表语义。
export function resolveUsageTimeRange(request: UsageStatsRequest): {
  startTime: string;
  endTime: string;
} {
// 显式映射而非解析数字：'7d'/'30d' 之外的值必须落到 default，
// parseInt 会把 '7x' 误读成 7，range 的联合类型也就失去意义。
  const days = (() => {
    switch (request.range) {
      case "7d":
        return 7;
      case "30d":
        return 30;
      default:
        return MONITOR_DEFAULT_RANGE_DAYS;
    }
  })();

  // now 是区间右端：摘要接口按服务器时区展示，日期边界只由这里决定，不参与格式化偏移。
  const now = new Date();
  const end = new Date(now);
// 用 setHours 而不是加 86400000 毫秒：DST 切换日不足 24 小时，按毫秒推进会漂移一小时。
  end.setHours(23, 59, 59, 0);
  const start = new Date(end);
// setDate 减 1 是因为区间含首尾两天：7 天 = 今天 + 前 6 天。
// Math.min 兜住更大的 days，保证永远不会越过 30 天上限。
  start.setDate(end.getDate() - (Math.min(days, MONITOR_MAX_RANGE_DAYS) - 1));
  start.setHours(0, 0, 0, 0);

  return {
    startTime: formatMonitorDateTime(start),
    endTime: formatMonitorDateTime(end),
  };
}

// 多返回粒度、横轴与日期键；横轴长度必须等于 [startDateKey, endDateKey] 的天数，
// 否则图表点数与 tooltip 日期错位，最后一天的数据会被画到错误的槽位。
export function resolveCodingPlanUsageTimeRange(request: CodingPlanUsageRequest): {
  startTime: string;
  endTime: string;
  granularity: CodingPlanUsageGranularity;
  xTime: string[];
  startDateKey: string;
  endDateKey: string;
} {
// endDateKey 是整条链路的时区基准：只在这里读一次「现在」，
// 后续用 endDateKey 做纯日历运算，避免请求跨午夜时首尾落在不同天。
  // request.timeZone 来自 renderer 的界面时区设置；缺失时退回宿主时区，与后端约定一致。
  const endDateKey = formatDateInTimeZone(new Date(), request.timeZone);

  switch (request.range) {
// today 固定 24 个小时点而非 1 个点：后端按小时返回，缺失小时由上层补 0，索引不能压缩。
    // range 是联合类型，但运行时仍可能来自旧客户端；custom 之外的未知值按 30 天处理。
    case "today": {
      return {
        startTime: `${endDateKey} 00:00:00`,
        endTime: `${endDateKey} 23:59:59`,
        granularity: "hour",
        xTime: buildHourlyAxis(),
        startDateKey: endDateKey,
        endDateKey,
      };
    }
    case "7d": {
      const startDateKey = addDaysToDateKey(endDateKey, -6);
      return {
        startTime: `${startDateKey} 00:00:00`,
        endTime: `${endDateKey} 23:59:59`,
        granularity: "day",
        xTime: buildDailyAxis(startDateKey, 7),
        startDateKey,
        endDateKey,
      };
    }
    case "30d": {
      const startDateKey = addDaysToDateKey(endDateKey, -29);
      return {
        startTime: `${startDateKey} 00:00:00`,
        endTime: `${endDateKey} 23:59:59`,
        granularity: "day",
        xTime: buildDailyAxis(startDateKey, 30),
        startDateKey,
        endDateKey,
      };
    }
// custom 的起止来自用户输入，是本文件唯一不可信来源，必须逐项校验后再参与运算。
    case "custom": {
      const startDateKey = normalizeCustomDateKey(request.customStartDate, "start");
      const customEndDateKey = normalizeCustomDateKey(request.customEndDate, "end");
// 用 UTC 毫秒差再 floor：日期键没有时区，若用本地 Date 相减，
// DST 当天会得到 0.958 天并被 floor 成 0，合法区间被误判为顺序颠倒。
      // +1 把闭区间端点算进跨度：同一天起止的 days=1，不会被误判为非法。
      const days = diffDateKeyDays(startDateKey, customEndDateKey) + 1;
// [失败路径] 起止颠倒直接抛错，不自动交换：顺序是用户的显式选择，静默纠正会让人以为选择已生效。
      if (days <= 0) {
        throw new Error("coding_plan_usage_custom_range_invalid_order");
      }
// 超长与后端上限共用 MONITOR_MAX_RANGE_DAYS，不能在两处各写 30，
// 否则调整上限时必漏改一侧，表现为前端允许、后端拒绝。
      if (days > MONITOR_MAX_RANGE_DAYS) {
        throw new Error("coding_plan_usage_custom_range_too_long");
      }
      return {
        startTime: `${startDateKey} 00:00:00`,
        endTime: `${customEndDateKey} 23:59:59`,
        granularity: "day",
        xTime: buildDailyAxis(startDateKey, days),
        startDateKey,
        endDateKey: customEndDateKey,
      };
    }
  }
}

// 手写格式化而非 toISOString：后端要的是宿主本地时间 'YYYY-MM-DD HH:mm:ss'，
// toISOString 会转成 UTC 并带 Z，东八区整体回退 8 小时。
function formatMonitorDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// 小时轴是固定槽位而非「有数据的时刻」：24 项与索引一一对应，
// 上层按索引对齐后端返回值，缺项补 0，因此不能根据实际返回反推轴。
// 调用方按索引与后端返回值对齐，因此这里必须固定 24 项，不能按实际数据裁剪。
function buildHourlyAxis(): string[] {
  return Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00:00`);
}

// 日轴按日期键逐日推进，长度由调用方传入而不是再算一次，
// 两处各算一次天数，必然在 custom 边界上漂移。
function buildDailyAxis(startDateKey: string, days: number): string[] {
  return Array.from({ length: days }, (_, index) => {
    return addDaysToDateKey(startDateKey, index);
  });
}

// 用 Intl 的 en-CA 直接拿 YYYY-MM-DD，避免手写时区偏移；
// timeZone 为空时退回宿主时区，这是「未指定即本地」的显式约定。
function formatDateInTimeZone(date: Date, timeZone: string | undefined): string {
// formatToParts 而非 format()：en-CA 输出虽接近 ISO，不同 ICU 版本仍可能插入空格，
// 逐字段取名能保证结构稳定。
  // 每个请求都会新建 formatter：缓存需要处理 timeZone 变化，而该函数只被调用一次。
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

// 日期键运算是纯日历运算，必须走 UTC：
// 用本地 Date 加减会在 DST 日得到 23/25 小时，跨月跨年时日期键可能重复或跳号。
function addDaysToDateKey(dateKey: string, days: number): string {
  // split 结果长度由上游校验保证；默认值只用于满足解构类型，正常路径不会取到。
  const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
// Date.UTC 的 day 参数溢出时会自动进位，不必手写月末天数。
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// 只接受 trim 后仍为严格 YYYY-MM-DD 的输入；空串与 null 视为非法，而不是回退到今天。
function normalizeCustomDateKey(value: string | null | undefined, label: "start" | "end"): string {
  const trimmed = value?.trim() ?? "";
  if (!DATE_KEY_PATTERN.test(trimmed)) {
// [失败路径] 错误码带 label，调用方无需解析文案就能定位是哪一端；异常交由 RPC 层转成参数错误。
    throw new Error(`coding_plan_usage_custom_${label}_date_invalid`);
  }
  return trimmed;
}

// 差值用 UTC 毫秒除以固定 86400000 再 floor：
// 两端都是零点，分子必为整数天，floor 只消除浮点误差，不会掩盖真实偏差。
function diffDateKeyDays(startDateKey: string, endDateKey: string): number {
  const start = dateKeyToUtcMs(startDateKey);
  const end = dateKeyToUtcMs(endDateKey);
  return Math.floor((end - start) / 86_400_000);
}

// 解构默认值 1970/01/01 只为避免 undefined 进入 Number；调用前形状已由校验函数保证，正常路径不会用到。
function dateKeyToUtcMs(dateKey: string): number {
  const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}
