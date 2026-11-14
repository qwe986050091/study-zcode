// 本文件是定时任务的展示层格式化层：只做已知 cron 模式的可读化与时间文本拼装，不参与调度计算。
// 纯函数约束：输入 intl 与时间戳，输出字符串，不读全局状态、不写缓存，卡片与编辑态共用同一实现。
// 无法识别的表达式一律回退为原始 cron 文本或「自定义」标签，宁可少说也不误导用户。
// 依赖方向：只依赖 IntlLike 抽象，不引入 React、store 或服务层，保持可单测。
// INV-01 失败态只认 failed 生命周期、failed_to_dispatch 派发态、非空 lastError，任一成立即成立；守住位置：hasAutomationFailureState；改错故障：调度已恢复的任务长期挂红色失败角标。
// INV-02 lastError 必须先 trim 再判真值，空白串不算失败；守住位置：hasAutomationFailureState 的 Boolean 分支；改错故障：用户清空错误信息后失败状态仍然残留。
// INV-03 重试队列态是失败态的子集，四个条件同时满足才展示排队时间；守住位置：hasAutomationRetryQueueState；改错故障：未进退避队列的任务显示虚假的重试倒计时。
// INV-04 dispatchAttempts 缺省按 0，retryAt 必须为 number；守住位置：hasAutomationRetryQueueState 的两处空值兜底；改错故障：首次失败就显示第 0 次重试，或倒计时出现 NaN。
// INV-05 生命周期终态压过 enabled，failed 先于 completed 先于 paused；守住位置：resolveAutomationStatusKind 的早返链；改错故障：已失败任务被开关状态覆盖成已暂停，用户误判可恢复。
// INV-06 enabled 为 false 视同 paused，判定只在此处收口；守住位置：resolveAutomationStatusKind 第三条分支；改错故障：同一任务在列表与详情页显示两种状态。
// INV-07 会话内创建的 cron 在编辑其他字段时必须原样回写；守住位置：buildAutomationEditCronExpr 的三元分支；改错故障：改个标题就把用户的自定义规则改写成近似表达式。
// INV-08 5 段顺序恒为分 时 日 月 周且单空格分隔；守住位置：buildCronExpr 全部 case；改错故障：保存时校验失败，或触发时间整体偏移。
// INV-09 weekly 空集合回退为星号表示每天，不得 join 出空字段；守住位置：buildCronExpr 的 weekly 分支；改错故障：生成缺字段的表达式，任务无法保存。
// INV-10 自定义间隔先 floor 再取至少 1，0 与浮点都收敛到 1；守住位置：buildCronExpr 的 custom 首行；改错故障：步长 0 让校验抛错，任务无法创建。
// INV-11 分钟步长上限 59、小时 24、日 31，超限必须降级；守住位置：buildCronExpr 的 custom 三个分支；改错故障：每 61 分钟写成超限步长，保存阶段直接失败。
// INV-12 超限时 cron 只保留最小合法候选，真实间隔交给 scheduleRule；守住位置：上述三处降级 return；改错故障：退化成每分钟执行，产生高频空跑并被限流。
// INV-13 yearly 月份夹在 1 至 12，缺日时取当天日号；守住位置：buildCronExpr 的 custom 尾部；改错故障：月份越界生成非法表达式，或每年在错误日期触发。
// INV-14 monthly 的星期模式用 #1 表达当月第一个该星期几；守住位置：buildCronExpr 的 monthly 分支；改错故障：用户选「每月第一个周一」却被保存成每月 1 号。
// INV-15 反解析仅接受 5 段，段数不符立即落 fallback；守住位置：parseCronToBuilder 的 length 早返；改错故障：4 段或 6 段被强行切片成错误的 builder 状态。
// INV-16 反解析顺序由窄到宽：步长、每小时、每天、工作日、每周、每年、每月；守住位置：parseCronToBuilder 判定链；改错故障：每天表达式先命中每周分支，编辑态显示成星期集合。
// INV-17 星期集合过滤非整数与越界值，过滤后为空则继续下探；守住位置：parseCronToBuilder 的 days 过滤；改错故障：脏数据留下空数组，回显时丢失星期信息。
// INV-18 卡片摘要先归一化空白再整串锚定匹配；守住位置：describeCron 开头的 trim 与 replace；改错故障：多空格 cron 被误判为自定义，或相似前缀被误识别。
// INV-19 未识别的 custom 必须回比 buildCronExpr，不一致才降级为自定义；守住位置：describeCron 的回比分支；改错故障：09:00 默认占位值被当成真实调度时间展示。
// 定时任务展示层格式化：cron 表达式 → 人类可读的调度摘要 / 相对时间 / cron builder 组装。
// 说明：croner 只在 services 侧用于算下次触发时间；UI 这里仅做「已知常见模式」的可读化，
// 覆盖不到的表达式回退成原始 cron 文本，保证不误导。

export interface IntlLike {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
}

export type AutomationStatusKind = "active" | "paused" | "completed" | "failed";

interface AutomationStatusLike {
  lifecycleStatus: AutomationStatusKind;
  enabled: boolean;
}

interface AutomationFailureLike {
  lifecycleStatus: AutomationStatusKind;
  dispatchStatus?: "idle" | "claimed" | "dispatched" | "failed_to_dispatch";
  dispatchAttempts?: number;
  retryAt?: number;
  lastError?: string;
}

/** 最近一次真实运行/派发失败时展示失败态；循环任务本身仍保持 active 并继续调度。 */
// 只看三个信号：failed 生命周期、failed_to_dispatch 派发态、非空 lastError，任一成立即失败态。
// 循环任务失败后仍保持 active 继续调度，因此失败态是叠加展示，而不是新的生命周期取值。
// lastError 先 trim 再判真值，空白串不得点亮失败角标，否则清除错误后仍会残留红标。
export function hasAutomationFailureState(automation: AutomationFailureLike): boolean {
  return (
    automation.lifecycleStatus === "failed" ||
    automation.dispatchStatus === "failed_to_dispatch" ||
    Boolean(automation.lastError?.trim())
  );
}

/** 派发失败进入退避队列时，失败态旁展示真实的重试排队信息。 */
// 失败态是前置门槛：没有失败就不存在重试队列文案，二者顺序不能互换。
// 必须同时满足 failed_to_dispatch、dispatchAttempts 大于 0、retryAt 为 number，缺一项就不展示排队时间。
// dispatchAttempts 缺省按 0 处理，字符串型 retryAt 会让倒计时渲染成 NaN。
export function hasAutomationRetryQueueState(automation: AutomationFailureLike): boolean {
  return (
    hasAutomationFailureState(automation) &&
    automation.dispatchStatus === "failed_to_dispatch" &&
    (automation.dispatchAttempts ?? 0) > 0 &&
    typeof automation.retryAt === "number"
  );
}

/** 定时任务生命周期展示状态：终态优先，其次 paused/enabled，最后 active。 */
// 优先级固定：failed 与 completed 这类终态压过开关，paused 与 enabled=false 等价，最后才是 active。
// 顺序一旦调换，已失败任务会被 enabled 覆盖成暂停，用户会误以为还能恢复。
// 这里是展示状态的唯一收口，别处不要复制这套判断，否则列表和详情会出现两种状态。
export function resolveAutomationStatusKind(
  automation: AutomationStatusLike,
): AutomationStatusKind {
  if (automation.lifecycleStatus === "failed") return "failed";
  if (automation.lifecycleStatus === "completed") return "completed";
  if (automation.lifecycleStatus === "paused" || !automation.enabled) return "paused";
  return "active";
}

/** cron builder 支持的频率类型（覆盖 Feishu 自定义重复里最常用的几种）。 */
export type CronFrequency = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";
export type CustomRepeatUnit = "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
export type CustomMonthlyMode = "date" | "weekday";

export interface CronBuilderState {
  frequency: CronFrequency;
  /** daily/weekly/monthly 用：0-23 */
  hour: number;
  /** daily/weekly/monthly 用：0-59 */
  minute: number;
  /** weekly 用：0(周日)-6(周六) 的集合 */
  weekdays: number[];
  /** monthly 用：1-31 */
  dayOfMonth: number;
  /** custom 用：原始 5 段 cron */
  rawExpr: string;
  customInterval: number;
  customUnit: CustomRepeatUnit;
  customWeekdays: number[];
  customMonthDays: number[];
  /** yearly 用：1-12 人类月份（日期复用 customMonthDays[0]）。 */
  customMonth: number;
  customMonthlyMode: CustomMonthlyMode;
}

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const pad2 = (value: number): string => String(value).padStart(2, "0");
const AUTOMATION_CARD_RELATIVE_NEXT_RUN_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export function isSessionCreatedAutomation(
  automation: { targetTaskId?: string } | null | undefined,
): boolean {
  return Boolean(automation?.targetTaskId?.trim());
}

// 会话内创建的任务可能带 UI builder 表达不了的 cron，编辑非调度字段时必须原样回写。
// 若走 builder 重算，「每 61 分钟」这类规则会被静默改写成近似值，属于数据损坏。
// 真值判断统一走 isSessionCreatedAutomation，不直接读 targetTaskId，判空逻辑只留一处。
export function buildAutomationEditCronExpr(
  state: CronBuilderState,
  automation: { cronExpr: string; targetTaskId?: string } | null | undefined,
): string {
  // Bugfix: 会话内创建的 cron 可能超出 UI builder 的表达能力，编辑其他字段时必须原样保留。
  return isSessionCreatedAutomation(automation) ? automation!.cronExpr : buildCronExpr(state);
}

/** 组装 cron builder 状态 → 5 段 cron 表达式（分 时 日 月 周）。 */
// 输出恒为 5 段：分、时、日、月、周，字段之间单个空格，不追加任何修饰。
// weekly 的空集合回退为星号表示每天，直接 join 空数组会产出非法表达式。
// monthly 与 yearly 的日期来自不同字段，混用会让「每月 15 号」变成「每年某日」。
// custom 之下只做步长收敛，真正的间隔语义由 scheduleRule 承担，cron 仅是兼容载体。
export function buildCronExpr(state: CronBuilderState): string {
  const { frequency, hour, minute, weekdays, dayOfMonth, rawExpr } = state;
  switch (frequency) {
    case "hourly":
      // 每小时的第 <minute> 分钟。
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly": {
      const days = weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b).join(",") : "*";
      return `${minute} ${hour} * * ${days}`;
    }
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case "custom": {
      // 自定义间隔先 floor 再取至少 1，浮点、0、负数都收敛到 1。
      // croner 对分钟步长上限 59、小时 24、日 31，越界表达式会在保存校验阶段被拒。
      // 越界时降级为最小合法候选（每分钟、每小时、每天），保证表达式一定能过校验。
      // 降级只改 cron 字段，真实间隔仍在 scheduleRule，回显时不要用 cron 反推间隔。
      const interval = Math.max(1, Math.floor(state.customInterval));
      if (state.customUnit === "minute") {
        // croner 的分钟步长最大为 59，把“每 61 分钟”写成 `*/61` 会在保存校验时失败。
        // 真实间隔由 scheduleRule 承载；超出 cron 表达能力时仅保留合法的每分钟候选。
        return interval <= 59 ? `*/${interval} * * * *` : "* * * * *";
      }
      if (state.customUnit === "hourly") {
        // croner 的小时步长最大为 24，把“每 31 小时”写成 `*/31` 会在保存校验时失败。
        // 真实间隔由 scheduleRule 承载；超出 cron 表达能力时仅保留合法的每小时候选。
        return interval <= 24 ? `${minute} */${interval} * * *` : `${minute} * * * *`;
      }
      if (state.customUnit === "daily") {
        // croner 的日期步长最大为 31，把“每 32 天”写成 `*/32` 会在保存校验时失败。
        // 真实间隔由 scheduleRule 承载；超出 cron 表达能力时仅保留合法的每日候选。
        return interval <= 31 ? `${minute} ${hour} */${interval} * *` : `${minute} ${hour} * * *`;
      }
      if (state.customUnit === "weekly") {
        const days = state.customWeekdays.length > 0 ? state.customWeekdays.join(",") : "1";
        return `${minute} ${hour} * * ${days}`;
      }
      if (state.customUnit === "monthly") {
        // 把 interval 直接写进月份字段会让“每 29 个月”生成 `*/29`，但 cron
        // 月份只允许 1-12。真实间隔由 scheduleRule 承载，兼容 cron 只保留合法的每月候选。
        if (state.customMonthlyMode === "weekday") {
          return `${minute} ${hour} * * ${state.customWeekdays[0] ?? 1}#1`;
        }
        const days = state.customMonthDays.length > 0 ? state.customMonthDays.join(",") : "1";
        return `${minute} ${hour} ${days} * *`;
      }
      // yearly：用用户选择的月份/日期组装 `M H DOM MON *`（不再固定为当前月份）。
      const yearMonth = Math.min(12, Math.max(1, Math.floor(state.customMonth)));
      const yearDay = state.customMonthDays[0] ?? new Date().getDate();
      return `${minute} ${hour} ${yearDay} ${yearMonth} *`;
    }
    default:
      return rawExpr.trim();
  }
}

/** 尽力把已有 cron 反解析回 builder 状态；不认识的落到 custom。 */
// 入口先按空白切段，段数不等于 5 立即返回 fallback，不做部分匹配。
// fallback 统一是 custom 加 09:00 默认值，它只是占位，不代表真实调度时间。
// 判定链由窄到宽：步长类、每小时、每天、工作日、每周、每年、每月，先命中先返回。
// 顺序若反过来，每天表达式会先落进每周分支，编辑态把时间显示成星期集合。
export function parseCronToBuilder(expr: string): CronBuilderState {
  const fallback: CronBuilderState = {
    frequency: "custom",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    rawExpr: expr,
    customInterval: 1,
    customUnit: "daily",
    customWeekdays: [1],
    customMonthDays: [1],
    customMonth: new Date().getMonth() + 1,
    customMonthlyMode: "date",
  };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const min = parts[0]!;
  const hr = parts[1]!;
  const dom = parts[2]!;
  const mon = parts[3]!;
  const dow = parts[4]!;
  const minNum = Number(min);
  const hrNum = Number(hr);
  const isNum = (v: string) => /^\d+$/.test(v);

  const minuteInterval = /^\*\/([1-9]\d*)$/.exec(min);
  if (minuteInterval && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      customInterval: Number(minuteInterval[1]),
      customUnit: "minute",
    };
  }

  const hourlyInterval = /^\*\/(\d+)$/.exec(hr);
  if (isNum(min) && hourlyInterval && dom === "*" && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      minute: minNum,
      customInterval: Math.max(1, Number(hourlyInterval[1])),
      customUnit: "hourly",
    };
  }
  const dailyInterval = /^\*\/(\d+)$/.exec(dom);
  if (isNum(min) && isNum(hr) && dailyInterval && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      hour: hrNum,
      minute: minNum,
      customInterval: Math.max(1, Number(dailyInterval[1])),
      customUnit: "daily",
    };
  }

  // 每小时：`M * * * *`
  if (isNum(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...fallback, frequency: "hourly", minute: minNum };
  }
  // 每天：`M H * * *`
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow === "*") {
    return { ...fallback, frequency: "daily", hour: hrNum, minute: minNum };
  }
  // 工作日：`M H * * 1-5`
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow === "1-5") {
    return { ...fallback, frequency: "weekdays", hour: hrNum, minute: minNum };
  }
  // 每周：`M H * * D(,D...)`
  // 星期集合要过滤非整数与 0 至 6 之外的值，脏数据不能进入 builder 状态。
  // 过滤后为空则继续下探到 fallback，而不是返回一个空星期数组。
  // 工作日分支必须先于每周分支，否则 1-5 会被当成五个独立星期，文案从「工作日」变成星期列表。
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow !== "*") {
    const days = dow
      .split(",")
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length > 0) {
      return { ...fallback, frequency: "weekly", hour: hrNum, minute: minNum, weekdays: days };
    }
  }
  // 每年：`M H DOM MON *`（月份为 1-12 数字，与每月的 `MON === "*"` 区分）
  if (isNum(min) && isNum(hr) && isNum(dom) && isNum(mon) && dow === "*") {
    const monthNum = Number(mon);
    if (monthNum >= 1 && monthNum <= 12) {
      return {
        ...fallback,
        frequency: "custom",
        hour: hrNum,
        minute: minNum,
        customUnit: "yearly",
        customMonth: monthNum,
        customMonthDays: [Number(dom)],
      };
    }
  }
  // 每月：`M H DOM * *`
  if (isNum(min) && isNum(hr) && isNum(dom) && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "monthly",
      hour: hrNum,
      minute: minNum,
      dayOfMonth: Number(dom),
    };
  }
  return fallback;
}

function weekdayLabel(day: number, intl: IntlLike): string {
  return intl.formatMessage({ id: `automations.weekday.${day}` });
}

/** builder → 可读调度摘要；编辑态直接使用，避免自定义规则经过 cron 反解析后丢失 UI 语义。 */
// 编辑态直接吃 builder 状态、绕过 cron 反解析，保证自定义规则不丢 UI 语义。
// 时间统一走 pad2 补零到两位，展示层不做 12 小时制转换，避免与 cron 的 0-23 语义打架。
// 周几文案与分隔符全部来自 intl，中文用顿号、英文用逗号，不允许在代码里写死。
// custom 的每个 unit 都有独立模板，回落到 daily 模板只发生在确实没有专属文案时。
export function describeCronBuilder(state: CronBuilderState, intl: IntlLike): string {
  const time = `${pad2(state.hour)}:${pad2(state.minute)}`;
  switch (state.frequency) {
    case "hourly":
      return intl.formatMessage(
        { id: "automations.schedule.hourly" },
        { minute: pad2(state.minute) },
      );
    case "daily":
      return intl.formatMessage({ id: "automations.schedule.daily" }, { time });
    case "weekdays":
      return intl.formatMessage({ id: "automations.schedule.weekdays" }, { time });
    case "weekly": {
      const days = [...state.weekdays]
        .sort((a, b) => WEEKDAY_ORDER.indexOf(a as never) - WEEKDAY_ORDER.indexOf(b as never))
        .map((d) => weekdayLabel(d, intl))
        .join("、");
      return intl.formatMessage({ id: "automations.schedule.weekly" }, { days, time });
    }
    case "monthly":
      return intl.formatMessage(
        { id: "automations.schedule.monthly" },
        { day: String(state.dayOfMonth), time },
      );
    case "custom": {
      if (state.customUnit === "minute") {
        return intl.formatMessage(
          { id: "automations.schedule.customMinutes" },
          { interval: String(state.customInterval) },
        );
      }
      if (state.customUnit === "hourly") {
        // 小时周期没有固定 hour，复用通用时间模板会把 builder
        // 为其它频率保留的默认 hour=9 误展示成 09:00。
        return intl.formatMessage(
          { id: "automations.schedule.customHourly" },
          {
            interval: String(state.customInterval),
            time: pad2(state.minute),
          },
        );
      }
      if (state.customUnit === "weekly") {
        const days = state.customWeekdays
          .map((day) => weekdayLabel(day, intl))
          .join(intl.formatMessage({ id: "automations.weekday.separator" }));
        return intl.formatMessage(
          { id: "automations.schedule.customWeekly" },
          { interval: String(state.customInterval), days, time },
        );
      }
      if (state.customUnit === "monthly") {
        if (state.customMonthlyMode === "weekday") {
          return intl.formatMessage(
            { id: "automations.schedule.customMonthlyWeekday" },
            {
              interval: String(state.customInterval),
              day: weekdayLabel(state.customWeekdays[0] ?? 1, intl),
              time,
            },
          );
        }
        return intl.formatMessage(
          { id: "automations.schedule.customMonthlyDates" },
          {
            interval: String(state.customInterval),
            days: state.customMonthDays.join(", "),
            time,
          },
        );
      }
      if (state.customUnit === "yearly") {
        return intl.formatMessage(
          { id: "automations.schedule.customYearly" },
          {
            interval: String(state.customInterval),
            month: String(state.customMonth),
            day: String(state.customMonthDays[0] ?? 1),
            time,
          },
        );
      }
      // 走到这里只剩 daily（hourly/weekly/monthly/yearly 已在上面各自处理）。
      const unitId = "automations.customRepeat.unit.day";
      return intl.formatMessage(
        { id: "automations.schedule.custom" },
        {
          interval: String(state.customInterval),
          unit: intl.formatMessage({ id: unitId }),
          time,
        },
      );
    }
    default:
      return state.rawExpr;
  }
}

/** cron → 可读调度摘要（如 “每天 09:00”“每周一、三 18:30”）；无法识别回退原始表达式。 */
// 先 trim 并把连续空白压成单空格，后续正则一律整串锚定，避免前缀匹配误判。
// 分钟步长单独识别，其余交给 parseCronToBuilder 再复述，避免两套解析逻辑漂移。
// 五段 cron 不带年份，无法区分单次固定日期与年度重复，只能统一标为自定义。
// 未识别的 custom 必须回比 buildCronExpr，一致才允许展示，否则 09:00 默认值会被当成真实时间。
export function describeCron(expr: string, intl: IntlLike): string {
  const normalizedExpr = expr.trim().replace(/\s+/g, " ");
  const minuteInterval = /^\*\/([1-9]\d*) \* \* \* \*$/.exec(normalizedExpr);
  if (minuteInterval) {
    return intl.formatMessage(
      { id: "automations.schedule.customMinutes" },
      { interval: minuteInterval[1]! },
    );
  }

  // 五段 cron 不携带年份，`M H DOM MON *` 无法区分单次固定日期与年度重复。
  // 卡片不能猜测产品语义，也不能把底层表达式直接暴露给用户，因此统一标记为自定义。
  if (/^\d+ \d+ \d+ \d+ \*$/.test(normalizedExpr)) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  // `M H DOM */N *` 目前无法在普通调度编辑器中稳定还原，卡片同样只标记为自定义。
  if (/^\d+ \d+ \d+ \*\/\d+ \*$/.test(normalizedExpr)) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }

  const builder = parseCronToBuilder(normalizedExpr);
  // 未识别 cron 会落到带 09:00 默认值的 custom 状态，不能把默认值误当成真实调度展示。
  if (builder.frequency === "custom" && buildCronExpr(builder) !== normalizedExpr) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  return describeCronBuilder(builder, intl);
}

/** UI 调度 builder 是否能无损回显 cron；固定月日和未知表达式必须走“自定义”替换流程。 */
// 能无损回显的判定就是往返相等：builder 再拼回 cron 必须与原串完全一致。
// 固定月日与按月步长两类先直接判否，它们即使往返相等也不允许进可视化编辑。
// 判否的表达式走「自定义」替换流程，用户改动前会看到明确的覆盖提示。
export function canVisualizeCronInAutomationEditor(expr: string): boolean {
  const normalizedExpr = expr.trim().replace(/\s+/g, " ");
  if (/^\d+ \d+ \d+ \d+ \*$/.test(normalizedExpr)) return false;
  if (/^\d+ \d+ \d+ \*\/\d+ \*$/.test(normalizedExpr)) return false;
  const builder = parseCronToBuilder(normalizedExpr);
  return buildCronExpr(builder) === normalizedExpr;
}

/** 本地时区偏移 → GMT 文案；支持 GMT+8 与 GMT+5:30 这类半小时时区。 */
// 偏移为 0 直接返回 GMT，不带正负号，避免出现 GMT+0 这种冗余文案。
// 正负号由偏移本身决定，取绝对值后再拆小时与分钟，负偏移不能丢符号。
// 分钟位为 0 时省略，因此整点时区显示 GMT+8 而不是 GMT+8:00。
// 支持半小时与三刻钟时区，GMT+5:30 这类结果依赖 pad2 补齐分钟位。
export function formatGmtOffset(offsetMinutes = -new Date().getTimezoneOffset()): string {
  if (offsetMinutes === 0) return "GMT";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `GMT${sign}${hours}${minutes > 0 ? `:${pad2(minutes)}` : ""}`;
}

/** 毫秒时间戳 → 本地日期时间（YYYY-MM-DD HH:MM）。 */
// 时间戳为 0、undefined 或 NaN 时统一返回短横线，不抛错也不显示 1970 年。
// 各字段手动补零而不用 toLocaleString，保证桌面与 Web、不同语言下格式一致。
// 月份要加 1，Date 的月份从 0 开始，漏加会让整体日期错一个月。
export function formatDateTime(ts: number | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 相对时间（如 “in 2h”“3d ago”），用于“下次运行 / 上次运行”。 */
// 差值取绝对值后按分钟、小时、天三档取整，未来还是过去由符号单独决定。
// 不足一分钟不显示数字，改用「即将」或「刚刚」文案，避免出现 0 分钟。
// 单位与前后缀都是独立消息 id，复数与语言差异交给 intl，代码里不做字符串拼接。
// 取整用四舍五入而非截断，否则 59 分 40 秒会显示成 59 分钟而不是 1 小时。
export function formatRelativeToNow(ts: number | undefined, now: number, intl: IntlLike): string {
  if (!ts) return "-";
  const diff = ts - now;
  const abs = Math.abs(diff);
  const future = diff >= 0;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let value: number;
  let unitId: string;
  if (abs < minute) {
    return intl.formatMessage({
      id: future ? "automations.time.soon" : "automations.time.justNow",
    });
  }
  if (abs < hour) {
    value = Math.round(abs / minute);
    unitId = "automations.time.minutes";
  } else if (abs < day) {
    value = Math.round(abs / hour);
    unitId = "automations.time.hours";
  } else {
    value = Math.round(abs / day);
    unitId = "automations.time.days";
  }
  const amount = intl.formatMessage({ id: unitId }, { value: String(value) });
  return intl.formatMessage(
    { id: future ? "automations.time.in" : "automations.time.ago" },
    { amount },
  );
}

/** 定时任务卡片下次运行时间：过期不展示；一个月内相对时间，更远的未来绝对时间。 */
// 已过期或缺失的时间戳返回 null，卡片据此整块隐藏，不显示「已过期」占位。
// 30 天以内用相对时间，更远用绝对日期，阈值是常量而不是散落的字面量。
// 边界取等号：正好 30 天仍走相对时间，改动比较符号会让临界值在两种格式间跳变。
export function formatAutomationCardNextRun(
  ts: number | undefined,
  now: number,
  intl: IntlLike,
): string | null {
  if (!ts || ts <= now) return null;
  return ts - now <= AUTOMATION_CARD_RELATIVE_NEXT_RUN_THRESHOLD_MS
    ? formatRelativeToNow(ts, now, intl)
    : formatDateTime(ts);
}

/** 运行时长（毫秒）→ 可读文本（如 “1m 20s”“3s”）。 */
// 起止任一缺失或倒序都返回短横线，负时长说明数据异常，不用取绝对值掩盖。
// 秒级四舍五入到整秒，分钟向下取整后再取余，避免 60 秒进位成 0 分 60 秒。
// 不足一分钟只输出秒，不补 0 分，保持「3s」这类紧凑文案。
export function formatDuration(startTs: number | undefined, endTs: number | undefined): string {
  if (!startTs || !endTs || endTs < startTs) return "-";
  const totalSec = Math.round((endTs - startTs) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}
