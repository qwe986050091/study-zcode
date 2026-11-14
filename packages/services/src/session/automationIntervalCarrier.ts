// interval carrier 校验：会话侧用 intervalUnit + interval 表达 cron 无法承载的长间隔。
// 这里只做输入合法性，规则归一化在 automationCron.buildIntervalScheduleRule。
import type {
  ZCodeAutomationIntervalUnit,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";

/** 会话侧自定义重复 carrier 的受控上限；不要收紧管理页历史 scheduleRule 的领域上限。 */
// 会话侧 carrier 上限 200，与管理页历史规则的领域上限相互独立。
const MAX_SESSION_AUTOMATION_INTERVAL = 200;

/** 会话侧自定义重复 carrier 配对、范围或互斥校验失败。 */
// carrier 非法同样是可修正输入错误，使用独立错误类型。
export class InvalidAutomationIntervalCarrierError extends Error {
  constructor(message: string) {
    super(`非法的自定义重复入参：${message}`);
    this.name = "InvalidAutomationIntervalCarrierError";
  }
}

/**
 * 校验会话 Cron 工具与 UI 共用的 interval carrier。
 *
 * intervalUnit + interval 是受控输入，服务层必须再次校验，避免旧客户端或内部调用绕过
 * contract/protocol 后写入超出 UI 语义的间隔。`scheduleRule: null` 是 update 的显式清除
 * 语义，也不能与 carrier 混用，否则无法确定是新建规则还是清除规则。
 */
export function assertValidAutomationIntervalCarrier(input: {
  intervalUnit?: ZCodeAutomationIntervalUnit;
  interval?: number;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  relativeDelayMinutes?: number;
  recurring?: boolean;
  maxRuns?: number | null;
}): void {
  // 入参 input 解构一次，后面每条配对与互斥校验都基于同一份快照。
  // 所有字段都可选，undefined 与 false 必须严格区分。
  const { intervalUnit, interval, scheduleRule, relativeDelayMinutes, recurring, maxRuns } = input;
  // 此函数只读不写：任何互斥校验漏项都会被下游的强制归一化掩盖，用户提交的真实冲突将无法诊断。
  // intervalUnit 与 interval 必须同进同出，只给一半无法拼出合法周期。
  // 用 undefined 判定而不是真值判断，避免 0 或空串被当成已提交。
  // 旧客户端只传 interval 时会在这里被拒，而不是让下游算出 NaN。
  if ((intervalUnit === undefined) !== (interval === undefined)) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit 与 interval 必须同时提交或同时省略",
    );
  }
  if (
    // 上限 200 与 UI 的受控取值一致，超出说明调用方绕过了 contract。
    // Number.isInteger 同时拦住小数与 NaN，interval 小于 1 会造出零间隔循环。
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < 1 || interval > MAX_SESSION_AUTOMATION_INTERVAL)
  ) {
    throw new InvalidAutomationIntervalCarrierError("interval 必须是 1-200 的整数");
  }
  // 一次性相对延迟与周期 carrier 语义互斥，同时提交无法确定调度模式。
  if (intervalUnit !== undefined && relativeDelayMinutes !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit 是周期 carrier，不能与一次性 relativeDelayMinutes 同时提交",
    );
  }
  // scheduleRule 直传是另一条建规则路径，与 carrier 混用会让规则来源不确定。
  // scheduleRule: null 是显式清除语义，同样不能与 carrier 并存，否则清除与新建会在同一次写入里互相覆盖。
  if (intervalUnit !== undefined && scheduleRule !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit carrier 不能与直传 scheduleRule 同时提交",
    );
  }
  // carrier 的真实语义是无限循环；若放行 recurring=false 或 maxRuns，repository 会
  // 在首次派发后按一次性 / 有限任务结束，留下 scheduleRule 与生命周期模式相互矛盾的数据。
  // carrier 的语义是无限循环，recurring 为 false 会在首次派发后结束，留下矛盾数据。
  // 若放行 false，repository 按一次性收尾，scheduleRule 却仍描述周期。
  if (intervalUnit !== undefined && recurring === false) {
    throw new InvalidAutomationIntervalCarrierError("intervalUnit carrier 必须使用 recurring=true");
  }
  // maxRuns 是有限次任务的配额，与无限循环 carrier 冲突，必须一并拒绝。
  // typeof number 只拦真实数字，null 表示未设置因此放行。
  if (intervalUnit !== undefined && typeof maxRuns === "number") {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit carrier 不能与有限 maxRuns 同时提交",
    );
  }
}

/** carrier 更新必须原子切换无限循环，避免 scheduleRule 与生命周期模式脱节。 */
// carrier 更新时强制切回无限循环并清空 maxRuns，避免与既有一次性状态混用。
export function forceIntervalCarrierRecurring(
  params: ZCodeAutomationUpdateParams,
): ZCodeAutomationUpdateParams {
  // 强制切回 recurring=true 并清空 maxRuns，避免更新时与既有一次性状态混用。
  // 必须在 assertValidAutomationIntervalCarrier 通过之后调用：顺序反了会把非法 carrier 洗成合法输入。
  // 展开 params 后再覆盖两个字段，调用方的其它编辑字段原样保留。
  return { ...params, recurring: true, maxRuns: null };
}
