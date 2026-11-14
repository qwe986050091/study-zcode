// scheduleRule 的领域校验：任何写入任务库的规则必须先通过这里。
import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import { Cron } from "croner";

/** 校验 cron 表达式是否合法（5 段，本地时区）。 */
// cron 合法性以 croner 构造是否抛错为准，不自行实现五段语法。
// 返回布尔值而不抛错，便于 UI 直接做即时校验。
export function isValidCronExpr(cronExpr: string): boolean {
  try {
    // croner 构造时即解析，非法表达式会抛错。
    new Cron(cronExpr);
    return true;
  } catch {
    return false;
  }
}

/** 非法自定义调度规则；规则必须先通过领域校验才能写入内部任务库。 */
// 规则非法属于调用方可修正的输入错误，用独立错误类型区分内部故障。
// message 前缀固定，UI 可直接展示。
export class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`非法的定时任务调度规则：${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

// 月度间隔上限 1200 个月（100 年），与计算函数的搜索边界保持一致。
// 上限用于防止生成永远算不出下一次的规则。
const MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL = 1_200;
// 允许的调度单位白名单；新增单位必须同时补齐计算分支。
const AUTOMATION_SCHEDULE_RULE_UNITS = new Set([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

// 数组字段统一校验：非空、全为整数、全部落在闭区间内。
// undefined 视为未提供，由调用方决定是否必需。
function hasOnlyIntegersInRange(values: number[] | undefined, min: number, max: number): boolean {
  return Boolean(
    values?.length &&
    values.every((value) => Number.isInteger(value) && value >= min && value <= max),
  );
}

// 逐项校验并抛出首个错误，调用方无需自行组合错误信息。
// 校验顺序：unit → interval → 时分 → 模式 → 数组字段。
export function assertValidAutomationScheduleRule(rule: ZCodeAutomationScheduleRule): void {
// unit 不在白名单内直接拒绝，避免计算函数走到 default 分支。
  if (!AUTOMATION_SCHEDULE_RULE_UNITS.has(rule.unit)) {
    throw new InvalidAutomationScheduleRuleError("unit 不受支持");
  }
// interval 必须为正整数；0 或小数会让步进计算失真。
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new InvalidAutomationScheduleRuleError("interval 必须是正整数");
  }
// [边界] monthly 还需过 MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL：其他 unit 只做正整数校验，不共用月度上限。
  if (rule.unit === "monthly" && rule.interval > MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL) {
    throw new InvalidAutomationScheduleRuleError(
      `monthly interval 不能超过 ${MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL}`,
    );
  }
// hour 采用 0-23 本地时间。
  if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
    throw new InvalidAutomationScheduleRuleError("hour 必须是 0-23 的整数");
  }
// minute 采用 0-59，不接受秒级精度。
  if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
    throw new InvalidAutomationScheduleRuleError("minute 必须是 0-59 的整数");
  }
  if (
// monthlyMode 只允许 date / weekday 两种，缺省按 date 处理。
    rule.monthlyMode !== undefined &&
    rule.monthlyMode !== "date" &&
    rule.monthlyMode !== "weekday"
  ) {
    throw new InvalidAutomationScheduleRuleError("monthlyMode 不受支持");
  }
// weekdays 采用 0-6（0 为周日），与 Date.getDay 一致。
  if (rule.weekdays && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekdays 必须是 0-6 的非空整数数组");
  }
// weekly 规则必须显式给出 weekdays，缺省不会被猜测。
  if (rule.unit === "weekly" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekly 规则必须包含有效的 weekdays");
  }
  if (rule.unit === "monthly") {
    if (rule.monthlyMode === "weekday" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
      throw new InvalidAutomationScheduleRuleError("monthly weekday 规则必须包含有效的 weekdays");
    }
    if (rule.monthlyMode !== "weekday" && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
      throw new InvalidAutomationScheduleRuleError("monthly date 规则必须包含有效的 monthDays");
    }
  }
// months 采用 1-12，与 cron 的 1-based 月一致。
  if (rule.months && !hasOnlyIntegersInRange(rule.months, 1, 12)) {
    throw new InvalidAutomationScheduleRuleError("months 必须是 1-12 的非空整数数组");
  }
  if (rule.monthDays && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
    throw new InvalidAutomationScheduleRuleError("monthDays 必须是 1-31 的非空整数数组");
  }
}
