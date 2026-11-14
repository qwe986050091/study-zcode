// 定时任务的 cron 语义层：只做解析、校验与“下次触发时间”计算，不负责实际派发。
import { Cron } from "croner";
import type { ZCodeAutomation, ZCodeAutomationScheduleRule } from "@zcode/shared";
import { isValidCronExpr } from "#src/session/automationCronValidation.js";

export { isValidCronExpr } from "#src/session/automationCronValidation.js";

// 一次任务错过目标后的补执行宽限：ONE_SHOT_MISSED_RUN_GRACE_MS 内视为工具调用跨分钟误差，可直接补跑。
// 超过该宽限的目标时间由上层拒绝，而不是静默滚到下一次。
const ONE_SHOT_MISSED_RUN_GRACE_MS = 60 * 1_000;
// 一次性固定月日 cron「目标刚过去」的识别窗口。模型对“现在”的时刻常是陈旧的（时间上下文停留在
// 会话/轮开始），把相对请求自算成绝对 cron 时，目标分钟往往已过去几分钟到几十分钟。窗口内的过期
// 目标视为模型算错、而非用户真想约到下一年：<1min 立即补执行，其余在写库前拒绝并提示改用
// delayMinutes。取 30min 覆盖真实的时钟漂移；超过窗口（如创建于目标月份之后）才保留下一年语义。
const ONE_SHOT_STALE_TARGET_WINDOW_MS = 30 * 60 * 1_000;
// 固定月日的一次性 cron 形态：分 时 日 月 全部为具体数字。
const FIXED_CALENDAR_CRON = /^\d+\s+\d+\s+\d+\s+\d+\s+\*$/;

/** 用于判断直接提交的 scheduleRule 是否仅更新展示字段，比较时忽略 anchorAt。 */
// 规则“定义”忽略 anchorAt：只比较调度频率本身，用于判断保存时是否需要重置锚点。
// 数组字段排序后再序列化，避免仅顺序不同被误判为规则变更。
export function scheduleRuleDefinition(rule: ZCodeAutomationScheduleRule): string {
  // 只序列化调度字段，anchorAt 被刻意排除：仅改锚点不应被当成规则变更。
  return JSON.stringify([
    // unit 与 interval 决定周期，hour 与 minute 决定相位；任一变化都必须视为规则变更。
    rule.unit,
    rule.interval,
    rule.hour,
    rule.minute,
    // 数组先排序再序列化：weekdays 的书写顺序不同不代表规则变了。
    rule.weekdays ? [...rule.weekdays].sort((a, b) => a - b) : null,
    rule.monthDays ? [...rule.monthDays].sort((a, b) => a - b) : null,
    rule.months ? [...rule.months].sort((a, b) => a - b) : null,
    rule.monthlyMode ?? null,
  ]);
}

/** 一次性固定日历任务使用了刚刚过去、但已不能安全补执行的目标时间。 */
// 目标时间已过去且超出补执行窗口时抛出，调用方据此提示用户改用相对时间。
// 错误信息包含 targetAt 的本地化时间，便于用户直接核对是哪一次目标。
export class StaleOneShotAutomationScheduleError extends Error {
  constructor(targetAt: number) {
    // 错误信息只需可读：new Date(targetAt) 的本地化时间让用户对照是哪一次目标，文案改版不影响调度逻辑。
    super(
      `一次性定时任务的目标时间（${new Date(targetAt).toLocaleString()}）已过去；相对时间请使用 delayMinutes，绝对时间请确认未来时刻后重试`,
    );
    // 显式设置 name：上层按 name 区分可提示的陈旧目标与内部错误。
    this.name = "StaleOneShotAutomationScheduleError";
  }
}

/**
 * 纯一次性任务（非循环且至多执行一次）。相对延迟的语义是一个确定的目标时刻，
 * 不是间隔型重复规则：错过窗口后必须进入终态，不得从兼容性 scheduleRule
 * （如 delayMinutes 落成的 minute 规则）推导出新的执行承诺。
 */
// 一次性判定：非循环且 maxRuns 缺省或不超过 1。
// 相对延迟规则也归入一次性，错过窗口后必须进入终态。
// 只依据 recurring 与 maxRuns 判定，不解析 cron 表达式。
// maxRuns 缺省按 1 处理，让历史数据同样进入一次性终态语义。
export function isOneShotAutomation(
  automation: Pick<ZCodeAutomation, "recurring" | "maxRuns">,
): boolean {
  // maxRuns 缺省按 1 处理：历史记录没有该字段时也落入一次性终态，不会无限补跑。
  return !automation.recurring && (automation.maxRuns ?? 1) <= 1;
}

/**
 * cron 表达式的下次触发时间计算（本地时区）。定时任务只用 croner 做「解析 + 算下次时间」，
 * 不用它做实际调度——调度循环由 scheduler 自己轮询 automation_runs / claimDue 完成。
 */

/**
 * 计算 cron 的下一个触发时间（毫秒时间戳）。
 * @param from 基准时间（毫秒）；缺省用当前时间。返回严格晚于 from 的下一次；无未来触发返回 null。
 */
// 使用 croner 计算严格晚于 from 的下一次触发；无未来时间返回 null。
// 调度循环不依赖 croner 的定时器，只复用它的解析结果。
export function computeNextRunAt(cronExpr: string, from?: number): number | null {
  // 每次新建 Cron 实例：表达式来自用户输入，共享实例会把不同任务的解析状态串在一起。
  const cron = new Cron(cronExpr);
  // from 缺省交给 croner 用当前时间；显式传 Date 而不是数字，避免它按秒截断后算回过去。
  const next = cron.nextRun(from === undefined ? undefined : new Date(from));
  return next ? next.getTime() : null;
}

/**
 * 将“几分钟后”收口为以服务端真实时钟为锚点的一次性规则。cronExpr 仅用于兼容展示，
 * 实际 nextRunAt 由带秒级 anchorAt 的 scheduleRule 计算，避免五段 cron 提前或延后一整分钟。
 */
// 把 delayMinutes 从相对延迟转换成带 anchorAt 的一次性规则，精度保留到秒。
export function buildRelativeDelaySchedule(
  delayMinutes: number,
  from = Date.now(),
): Pick<ZCodeAutomation, "cronExpr" | "scheduleRule"> {
// cronExpr 仅为兼容展示，真实触发时间由 anchorAt + interval 计算。
  // 目标按毫秒算而不是给 Date 加月日：跨月与月末由时间戳自然进位，不会算出 1 月 32 日。
  // anchorAt 必须取服务端当前时刻：两次重算用不同锚点会让同一任务得到不同的下次触发。
  const target = new Date(from + delayMinutes * 60 * 1_000);
  return {
    // 兼容展示串的月份要 +1：cron 的 month 是 1-12，而 getMonth 返回 0-11。
    cronExpr: `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`,
    scheduleRule: {
      unit: "minute",
      interval: delayMinutes,
      hour: target.getHours(),
      minute: target.getMinutes(),
      // anchorAt 存服务端真实时钟，调度引擎从它推导下次触发，不用这串 cron 反解。
      anchorAt: from,
    },
  };
}

/**
 * 新建任务的首次触发时间。一次性固定月日 cron 如果刚错过目标分钟，下一次会滚到下一年；
 * 仅允许小于一分钟的工具调用跨分钟误差立即补执行，已经陈旧的目标必须拒绝并重新计算。
 */
export function computeInitialAutomationNextRunAt(
  automation: Pick<ZCodeAutomation, "cronExpr" | "recurring" | "scheduleRule">,
  from = Date.now(),
): number | null {
// 先按常规路径算出下一次，再对一次性固定日历 cron 做陈旧目标判定。
  // 先按 computeAutomationNextRunAt 算一次，后面只在明显可疑时才回头校正，正常任务零额外开销。
  const nextRunAt = computeAutomationNextRunAt(automation, from);
  if (
    automation.recurring ||
    automation.scheduleRule ||
    !FIXED_CALENDAR_CRON.test(automation.cronExpr.trim())
  ) {
    return nextRunAt;
  }

  // 只有 FIXED_CALENDAR_CRON 形态才回头找上一轮目标；其余规则交给常规计算，避免把循环任务误判成算错。
  const cron = new Cron(automation.cronExpr);
  // 取严格早于 from 的最近一次触发；previousRuns 不含当前时刻，正好衡量目标过去了多久。
  const previousRun = cron.previousRuns(1, new Date(from))[0]?.getTime();
  // 只有落在 ONE_SHOT_STALE_TARGET_WINDOW_MS 内的过去目标才可能被判陈旧；超出窗口说明用户真的约在更早的月份。
  const targetAge =
    previousRun !== undefined &&
    from >= previousRun &&
    from - previousRun <= ONE_SHOT_STALE_TARGET_WINDOW_MS
      ? from - previousRun
      : undefined;
  // 下一次已滚出窗口（通常直接跳到下一年）才是目标刚过去的证据；否则下一次本身就很近。
  const rolledToNextCalendarOccurrence =
    nextRunAt === null || nextRunAt - from > ONE_SHOT_STALE_TARGET_WINDOW_MS;
  // 目标刚过去且 nextRunAt 已滚到很远的日历点时，说明本次创建很可能算错了时刻。
  // 两个条件必须同时成立：单看过期时间会把正常的年度任务误判成模型算错。
  if (targetAge !== undefined && rolledToNextCalendarOccurrence) {
    // 返回 from 而不是 previousRun：补执行必须落在创建时刻之后，
    // 回填过去时间会让 run_id 与已结束的一轮撞车，结算落到旧台账行。
    if (targetAge < ONE_SHOT_MISSED_RUN_GRACE_MS) return from;

    // 把 任意过去时间都当作“刚跨分钟”会让模型算错的
    // 相对时间被创建后立即执行。超过一分钟已不能安全推断用户仍想补执行，必须在写库前拒绝。
    // 抛错而不是返回 null：写库前调用方需要可提示的错误，静默 null 会被当成无未来触发。
    throw new StaleOneShotAutomationScheduleError(from - targetAge);
  }
  return nextRunAt;
}

// atTime 把本地日历日期与时分秒组合成 Date，所有重复规则共用该构造方式。
function atTime(date: Date, hour: number, minute: number): Date {
  // 秒与毫秒固定为 0：重复规则只精确到分钟，保留当前秒会让同一分钟内多次调用算出不同时间。
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function firstWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const first = new Date(year, month, 1);
  // 从 1 号起加偏移取第一个目标星期几；先 +7 再取模，让 first.getDay() 晚于 weekday 时也回到本周。
  return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7));
}

/** 自定义重复规则的下一次运行；所有计算都使用本地日历时间。 */
export function computeScheduleRuleNextRunAt(
  rule: ZCodeAutomationScheduleRule,
  from = Date.now(),
): number | null {
  // interval 兜底为 1：历史数据里的 0 或负数会让步长循环原地打转。
  const interval = Math.max(1, Math.floor(rule.interval));
  // anchor 是创建/修改时刻，所有分支都从它正推而不是从 from 反推，避免漂移累积。
  const anchor = new Date(rule.anchorAt);

  if (rule.unit === "minute") {
    const step = interval * 60 * 1_000;
    // 分钟间隔从创建/修改时刻开始，不能像 `*/N` cron 一样提前命中下一个墙钟刻度。
    // 始终从固定 anchor 推导还能避免 scheduler 晚派发后逐轮累积漂移。
    const steps = Math.max(1, Math.floor((from - rule.anchorAt) / step) + 1);
    // steps 至少为 1，返回值严格晚于 from；同一毫秒重复调用不会算出过去时刻。
    return rule.anchorAt + steps * step;
  }

  if (rule.unit === "hourly") {
    // hourly 以锚点分钟对齐墙钟；跨夏令时按毫秒差推进，墙钟会偏移一小时，这是本地时区的取舍。
    const base = new Date(anchor);
    base.setMinutes(rule.minute, 0, 0);
    const step = interval * 60 * 60 * 1_000;
    // 允许 steps 为 0：anchor 未到点时下一次就是它本身，而不是跳过一轮。
    const steps = Math.max(0, Math.floor((from - base.getTime()) / step) + 1);
    return base.getTime() + steps * step;
  }

  if (rule.unit === "daily") {
    // 上限 36600 次覆盖约 100 年；非法 interval 触顶后返回 null，不会空转到卡死。
    for (let index = 0; index < 36_600; index += 1) {
      const date = new Date(
        anchor.getFullYear(),
        anchor.getMonth(),
        anchor.getDate() + index * interval,
      );
      const candidate = atTime(date, rule.hour, rule.minute).getTime();
      // 严格大于 from 才算下一次；等于 from 说明这一分钟正在触发，重复返回会立刻补跑。
      if (candidate > from) return candidate;
    }
    return null;
  }

  if (rule.unit === "weekly") {
    // anchorWeek 先归零到当天零点，再回退到所在周的周一，避免时分污染周偏移。
    const anchorWeek = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    // getDay 里周日是 0，先 +6 再取模才把周一对齐；直接减 getDay 会让周日落到上一周。
    anchorWeek.setDate(anchorWeek.getDate() - ((anchorWeek.getDay() + 6) % 7));
    // 周几缺省为周一：空数组会让内层 for 一次都不执行，静默返回 null。
    const weekdays = [...(rule.weekdays?.length ? rule.weekdays : [1])].sort();
    // 5220 周约 100 年；外层按 interval 跳周，内层再按 weekdays 找本周内的具体日。
    for (let week = 0; week < 5_220; week += interval) {
      for (const weekday of weekdays) {
        const dayOffset = (weekday + 6) % 7;
        const date = new Date(
          anchorWeek.getFullYear(),
          anchorWeek.getMonth(),
          anchorWeek.getDate() + week * 7 + dayOffset,
        );
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  if (rule.unit === "monthly") {
    // 1200 同时是合法月度间隔与搜索边界；旧的严格小于只检查 offset=0，
    // 当前月候选已过后会错误返回 null。包含边界才能计算 100 年后的下一轮。
    for (let offset = 0; offset <= 1_200; offset += interval) {
      const month = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);
      // weekday 模式只看当月第一个指定星期几；date 模式按 monthDays 逐日取，溢出日期由下面月份回验过滤。
      const candidates =
        rule.monthlyMode === "weekday"
          ? [firstWeekdayOfMonth(month.getFullYear(), month.getMonth(), rule.weekdays?.[0] ?? 1)]
          : [...(rule.monthDays?.length ? rule.monthDays : [1])]
              .sort((left, right) => left - right)
              .map((day) => new Date(month.getFullYear(), month.getMonth(), day))
              .filter((date) => date.getMonth() === month.getMonth());
      for (const date of candidates) {
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  // yearly：月份优先取 rule.months（1-12 → 0-indexed），缺省回退锚点月份（兼容旧记录）；
  // 日期取 monthDays[0] 或锚点日。溢出守卫：如 2/30、非闰年 2/29 会滚到下个月，跳过该年避免误触发。
  const targetMonth =
    rule.months?.[0] != null ? (((rule.months[0] - 1) % 12) + 12) % 12 : anchor.getMonth();
  // 日期缺省取锚点日；2/30 与非闰年 2/29 会在下面因月份不符被跳过。
  const targetDay = rule.monthDays?.[0] ?? anchor.getDate();
  // 400 年覆盖一个完整公历闰年周期；非法 targetDay 会一直 continue，没有上界就是死循环。
  for (let offset = 0; offset < 400; offset += interval) {
    const date = new Date(anchor.getFullYear() + offset, targetMonth, targetDay);
    if (date.getMonth() !== targetMonth) continue;
    const candidate = atTime(date, rule.hour, rule.minute).getTime();
    if (candidate > from) return candidate;
  }
  return null;
}

/** 将“每 N 分钟”的 cron 展示表达式识别为带创建时刻锚点的产品调度规则。 */
export function inferMinuteIntervalScheduleRule(
  cronExpr: string,
  anchorAt: number,
): ZCodeAutomationScheduleRule | undefined {
  const match = /^\*\/([1-9]\d*)\s+\*\s+\*\s+\*\s+\*$/.exec(cronExpr.trim());
  // 返回 undefined 交给调用方按普通 cron 处理，推断层不猜用户意图。
  if (!match) return undefined;
  return {
    unit: "minute",
    // N 直接取捕获组：带具体分钟的 cron 表达式说明用户在指定墙钟时刻，不能当间隔处理。
    interval: Number(match[1]),
    hour: new Date(anchorAt).getHours(),
    minute: new Date(anchorAt).getMinutes(),
    anchorAt,
  };
}

/**
 * 解析 cron 五段字段。只支持 5 段标准 cron（minute hour day-of-month month day-of-week）；
 * 返回各段的纯数字解析结果，范围字段（dow/dom/month）按逗号分隔，通配段返回 undefined。
 * 失败回退到 undefined，由调用方决定降级策略。
 */
function parseCronFields(cronExpr: string): {
  minute?: number;
  hour?: number;
  monthDays?: number[];
  months?: number[];
  weekdays?: number[];
} {
  // 按空白切段；六段带秒的表达式会因字段错位被降级，而不是悄悄按五段解释。
  const parts = cronExpr.trim().split(/\s+/);
  // noUncheckedIndexedAccess 下 parts[i] 类型含 undefined；解构提取前 5 段。标准 5 段 cron 才解析，
  // 段数不足时返回空对象，由调用方回退到 anchorAt 默认值（避免把 "0 9" 当成有效 cron）。
  // 解构取前五段，多余段直接丢弃；标准 5 段 cron 之外的形式由调用方兜底。
  const [minuteToken, hourToken, domToken, monthToken, dowToken] = parts;
  // 段数不足返回空对象，避免把 `0 9` 当成有效 cron 解析出错误的钟点。
  if (parts.length < 5 || minuteToken === undefined) return {};
  // 单值解析只接受整数与通配；带步长或范围的表达式一律返回 undefined。
  const parseSingle = (token: string): number | undefined => {
    // 通配与问号都表示未指定，回退到 anchorAt 的对应字段。
    if (token === "*" || token === "?") return undefined;
    const value = Number(token);
    return Number.isInteger(value) ? value : undefined;
  };
  // 范围字段支持逗号列表（如 "1,3,5"）；忽略非数字 token（如 "*/2"、"1#1"），
  // 这些步长/序号表达式已超出 carrier 场景（步长超限才走 carrier），直接降级到默认值。
  const parseList = (token: string): number[] | undefined => {
    if (token === "*" || token === "?") return undefined;
    // token 按逗号逐项转数字并过滤小数与步长表达式；过滤后为空同样算未指定。
    const values = token
      .split(",")
      .map((piece) => Number(piece))
      .filter((value) => Number.isInteger(value));
    // 空列表不能当有效值返回，否则月日或星期数组为空会让调度循环一次都不执行。
    return values.length > 0 ? values : undefined;
  };
  return {
    minute: parseSingle(minuteToken),
    hour: hourToken === undefined ? undefined : parseSingle(hourToken),
    monthDays: domToken === undefined ? undefined : parseList(domToken),
    months: monthToken === undefined ? undefined : parseList(monthToken),
    weekdays: dowToken === undefined ? undefined : parseList(dowToken),
  };
}

/**
 * 会话侧自定义重复 carrier（intervalUnit + interval）归一化为权威 scheduleRule。
 *
 * cron 各字段有步长上限（minute 59、hour 24、day-of-month 31、month 12），
 * 「每50小时」「每40天」「每13个月」无法用五段 cron 直接表达。会话侧所有“每 N 单位”均用受控 carrier
 * intervalUnit+interval 携带真实间隔，cronExpr 仅作合法兼容展示；本函数把兼容 cron 各字段
 * 解析成 scheduleRule 所需的 hour/minute/weekdays/monthDays/months，真实 interval 由 carrier
 * 传入。anchorAt 由调用方（service）传入真实创建/修改时刻，调度引擎据此推进。
 *
 * 兼容 cron 字段缺失（如 '* * * * *' 占位）时回退到安全默认值（weekday=[1]、monthDays=[1]、
 * months=锚点月份），保证调度引擎仍可计算下一轮，不静默返回 null。
 */
export function buildIntervalScheduleRule(
  intervalUnit: ZCodeAutomationScheduleRule["unit"],
  interval: number,
  cronExpr: string,
  anchorAt: number,
): ZCodeAutomationScheduleRule {
  // carrier 的 cronExpr 只是兼容展示，解析失败也必须给出可调度默认值，不能让规则落库即失效。
  const fields = parseCronFields(cronExpr);
  const anchor = new Date(anchorAt);
  // 缺省回退到 anchor 时刻：`* * * * *` 这类占位不会把钟点变成 0。
  const minute = fields.minute ?? anchor.getMinutes();
  const hour = fields.hour ?? anchor.getHours();
  // 月日回退锚点日；月份之所以 +1，是 scheduleRule 的 months 用 1-based 表示。
  const monthDays = fields.monthDays ?? [anchor.getDate()];
  // cron 的 month/dow 是 1-based/0-based 混用，统一归一到 scheduleRule 语义（见引擎实现）。
  const months = fields.months ?? [anchor.getMonth() + 1];
  // 星期缺省周一，与 computeScheduleRuleNextRunAt 的空数组兜底保持一致。
  const weekdays = fields.weekdays ?? [1];

  // 按 unit 分流而不是通用映射：每个分支需要的字段不同，统一填默认值会把无关字段写进规则。
  switch (intervalUnit) {
    // minute 与 hourly 的 hour 字段不参与计算，填锚点值只为卡片展示一致，别据此推断触发时刻。
    case "minute":
      // 分钟间隔调度完全以 anchorAt 推进，hour/minute 仅作展示；保留锚点时分以便卡片展示。
      return {
        unit: "minute",
        interval,
        hour: anchor.getHours(),
        minute: anchor.getMinutes(),
        anchorAt,
      };
    case "hourly":
      // 引擎 hourly 分支只用 rule.minute 对齐分钟；hour 不参与计算（见 computeScheduleRuleNextRunAt）。
      return { unit: "hourly", interval, hour: 0, minute, anchorAt };
    case "daily":
      return { unit: "daily", interval, hour, minute, anchorAt };
    case "weekly":
      return { unit: "weekly", interval, hour, minute, weekdays, anchorAt };
    case "monthly":
      return {
        unit: "monthly",
        interval,
        hour,
        minute,
        monthDays,
        monthlyMode: "date",
        anchorAt,
      };
    case "yearly":
      return { unit: "yearly", interval, hour, minute, months, monthDays, anchorAt };
    default: {
      // 无效 unit 必须在归一化层拒绝，避免静默生成错误规则后写入数据库。
      const exhaustive: never = intervalUnit;
      // 走到这里说明传了联合类型之外的值；静默落库会生成永远算不出下次时间的规则。
      throw new Error(`Unsupported intervalUnit: ${String(exhaustive)}`);
    }
  }
}

export function computeAutomationNextRunAt(
  automation: Pick<ZCodeAutomation, "cronExpr" | "scheduleRule">,
  from?: number,
): number | null {
  // scheduleRule 优先：存在权威规则时不再看兼容 cronExpr，否则两套时间会互相打架。
  return automation.scheduleRule
    ? computeScheduleRuleNextRunAt(automation.scheduleRule, from)
    : computeNextRunAt(automation.cronExpr, from);
}
