// 大模型配额与订阅响应到领域模型的纯映射层：不发网络、不抛业务异常，缺字段一律降级为 undefined/null。
// INV-01：数值字段只在 typeof === 'number' 时透传，字符串数字一律丢弃（守住：normalizeLimits 的条件展开）。
// INV-02：limits 中没有合法 type 的项必须整条过滤，不得补空串占位（守住：normalizeLimits 的 filter）。
// INV-03：续费时间与到期时间互斥，同一时间不会被两处同时返回（守住：pickCurrentSubscriptionRenewTime/ExpireTime）。
// 破坏 INV-01：'12' 这类字符串会让 UI 的百分比计算得到 NaN，配额条整条消失。
// 破坏 INV-03：UI 会把下一次扣费当成权益到期，诱导用户在有余额时重复购买。
import { isActivePersonalCodingPlan } from "#src/bigmodel/codingPlanEntitlement.js";
import type { UsageQuotaLimit, UsageQuotaUsageDetail } from "@zcode/shared";

// 信封的 code/msg/success 都可能缺失：上游不同版本只保证 data 存在，
// 因此不能用 success === true 做前置判断，否则旧网关会被整体判失败。
export interface BigModelSubscriptionListEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelSubscriptionListItem[] | null;
}

// 字段全部可选：这是网络边界类型，用可选字段强迫调用方处理缺省，
// 而不是在解析时补默认值，把上游返回不全的事实掩盖掉。
export interface BigModelSubscriptionListItem {
  productId?: string;
  productName?: string;
  status?: string;
  inCurrentPeriod?: boolean;
  purchaseTime?: string;
  valid?: string;
// autoRenew 历史上出现过 0/1 与 true/false 两种编码，必须同时接受；只判 truthy 会把 0 当开启。
  autoRenew?: number | boolean;
  currentRenewTime?: string;
  nextRenewTime?: string;
  billingCycle?: string;
}

export interface BigModelUsageQuotaEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelUsageQuotaPayload | null;
}

// payload 只有 level 与 limits：level 用于展示套餐名，limits 才是数值来源，两者可能不同步。
export interface BigModelUsageQuotaPayload {
  level?: string;
  limits?: BigModelUsageQuotaLimitPayload[];
}

// BigModelUsageQuotaLimitPayload 是上游原始形状而非领域类型，故字段保持可选且不导出；
// 一旦导出，其它模块会开始依赖上游拼写，未来改名无法收敛在这一层。
interface BigModelUsageQuotaLimitPayload {
  type?: string;
// unit 是计量单位（如 1=次、60=秒），number 是总量，usage 是已用量；
// 三者必须共用同一单位，映射层不做换算，否则跨套餐比较会拿错维度。
// 任何一项缺失都不推断补齐：宁可在 UI 上留空，也不要把「不知道」显示成 0。
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
// nextResetTime 是毫秒时间戳而非 ISO 字符串；用 typeof 判断即可把字符串时间挡在外面。
  nextResetTime?: number;
  usageDetails?: Array<{
    modelCode?: string;
    displayName?: string;
    usage?: number;
  }>;
}

// 宽容解析：数组缺失返回空数组，单条非法只跳过该条，
// 保证一个坏 limit 不会让整个配额面板失败。
export function normalizeLimits(limits: BigModelUsageQuotaPayload["limits"]): UsageQuotaLimit[] {
// [失败路径] null/对象都归为空数组，调用方据此显示「无配额」，而不是抛错导致白屏。
  if (!Array.isArray(limits)) {
    return [];
  }

  return limits
// 用 length > 0 而非 truthy：' ' 这样的空白 type 能通过 truthy 检查，
// 却匹配不上任何已知类型，最终在 pickPrimaryLimit 里变成无法解释的兜底项。
    .filter((limit) => typeof limit.type === "string" && limit.type.length > 0)
    .map((limit) => ({
      type: limit.type ?? "",
// [权衡] 用条件展开而不是先赋 undefined：undefined 键会覆盖下游默认值，也让「字段缺失」和「显式置空」无法区分。
      ...(typeof limit.unit === "number" ? { unit: limit.unit } : {}),
      ...(typeof limit.number === "number" ? { number: limit.number } : {}),
      ...(typeof limit.usage === "number" ? { usage: limit.usage } : {}),
      ...(typeof limit.currentValue === "number" ? { currentValue: limit.currentValue } : {}),
      ...(typeof limit.remaining === "number" ? { remaining: limit.remaining } : {}),
      ...(typeof limit.percentage === "number" ? { percentage: limit.percentage } : {}),
      ...(typeof limit.nextResetTime === "number" ? { nextResetTime: limit.nextResetTime } : {}),
// 明细始终给数组（哪怕是空），避免下游为 undefined 和 [] 写两条分支。
      usageDetails: normalizeUsageDetails(limit.usageDetails),
    }));
}

// 选择顺序即产品语义：时间型额度优先（它决定窗口重置），
// 其次是有 remaining 的额度，最后退回第一条，保证面板总有主指标。
export function pickPrimaryLimit(limits: UsageQuotaLimit[]): UsageQuotaLimit | null {
  return (
// 精确匹配 TIME_LIMIT：类型名是稳定枚举，用 includes 会误命中 RATE_LIMIT_TIME 之类变体。
    limits.find((limit) => limit.type === "TIME_LIMIT") ??
// 只认 remaining 为数字的项：0 也有效（额度耗尽），不能用 truthy 过滤。
    limits.find((limit) => typeof limit.remaining === "number") ??
    limits[0] ??
    null
  );
}

export function formatPlanName(level: string): string {
  const normalized = level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
  return `GLM Coding ${normalized}`;
}

// [失败路径] 上游用自然语言表达「无套餐」且无稳定错误码，只能子串匹配；匹配失败会退化成通用错误提示。
export function isNoPlanMessage(message: string): boolean {
  return message.includes("不存在coding plan") || message.includes("没有资格");
}

// items 可能同时包含历史套餐、团队套餐与当前个人套餐；
// 这里只取「当前生效的个人 Coding Plan」，避免把团队额度展示成个人额度。
export function pickCurrentSubscriptionFromList(
  payload: BigModelSubscriptionListItem[] | null | undefined,
): {
  productId: string;
  productName: string;
  billingCycle: string | null;
  renewTime: string | null;
  expireTime: string | null;
} | null {
// 空列表与 null 同义（未订阅），返回 null 让上层显示购买入口，而不是一张全 0 的套餐卡。
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  const currentSubscription = payload.find(isActivePersonalCodingPlan);
// productId 是后续查询配额的主键，缺失时整条记录不可用；
// 这里不用下标兜底，否则会拿历史套餐的 id 去查当前配额。
  if (!currentSubscription?.productId) {
    return null;
  }

  return {
    productId: currentSubscription.productId,
    productName: currentSubscription.productName ?? currentSubscription.productId,
    billingCycle: currentSubscription.billingCycle?.trim() || null,
    renewTime: pickCurrentSubscriptionRenewTime(currentSubscription),
    expireTime: pickCurrentSubscriptionExpireTime(currentSubscription),
  };
}

function pickCurrentSubscriptionRenewTime(
  subscription: BigModelSubscriptionListItem,
): string | null {
  const nextRenewTime = parseBigModelLocalDateTime(subscription.nextRenewTime);
  if (!nextRenewTime) {
    return null;
  }

// 显式比较 true/1：autoRenew 可能是字符串 '1' 或 0，宽松判等会把 '0' 当成开启。
  return subscription.autoRenew === true || subscription.autoRenew === 1 ? nextRenewTime : null;
}

// 与 pickCurrentSubscriptionRenewTime 互补：自动续费取 valid 区间末尾，
// 非自动续费才把 nextRenewTime 当到期时间，保证两个返回值互斥。
function pickCurrentSubscriptionExpireTime(
  subscription: BigModelSubscriptionListItem,
): string | null {
  // 自动续费套餐的 nextRenewTime 表示下一次扣费，不是最终到期；
  // 非自动续费时它才是当前权益结束时间，避免 UI 同时显示续费和到期两个互斥含义。
  const nextRenewTime = parseBigModelLocalDateTime(subscription.nextRenewTime);
  if (nextRenewTime && subscription.autoRenew !== true && subscription.autoRenew !== 1) {
    return nextRenewTime;
  }

  const validPeriodEnd = parseValidPeriodEnd(subscription.valid);
  return validPeriodEnd;
}

// 用正则抓所有日期再取最后一个，比按分隔符 split 稳健：
// 上游用过 '-'、'至' 和空白作为区间分隔符，按固定分隔符切会漏格式。
function parseValidPeriodEnd(value: string | undefined): string | null {
  const matches = value?.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/g);
  const end = matches?.at(-1);
  return parseBigModelLocalDateTime(end);
}

// 上游给的是无时区本地时间（'2026-01-01 12:00:00'），
// new Date 按宿主时区解释后再 toISOString 转 UTC，保证跨设备显示一致。
function parseBigModelLocalDateTime(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

// 把空格换成 T 再交给 Date：ISO 8601 要求 T 分隔，V8 虽兼容空格，其它运行时（Hermes/JSC）不保证。
  const normalized =
    trimmed.includes("T") || !trimmed.includes(" ") ? trimmed : trimmed.replace(" ", "T");
// [失败路径] getTime() 为 NaN 时返回 null，避免 Invalid Date 流到 UI 的格式化函数里抛 RangeError。
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// 明细用于展示「哪个模型用了多少」，上层按 modelCode 聚合，
// 因此没有 modelCode 的条目无法定位，直接过滤而不是补空串。
function normalizeUsageDetails(
  details: BigModelUsageQuotaLimitPayload["usageDetails"],
): UsageQuotaUsageDetail[] {
  if (!Array.isArray(details)) {
    return [];
  }

  return details
    .filter((detail) => typeof detail.modelCode === "string")
    .map((detail) => ({
      modelCode: detail.modelCode ?? "",
      ...(typeof detail.displayName === "string" && detail.displayName.trim().length > 0
        ? { displayName: detail.displayName.trim() }
        : {}),
// usage 缺失补 0：明细行必须能显示数字，0 只表示该模型未计量，不代表有额度。
      usage: typeof detail.usage === "number" ? detail.usage : 0,
    }));
}
