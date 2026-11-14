// INV-01 守住导出常量区：group 与两个事件名是 ARMS 契约的唯一来源；改错会让看板按旧名静默归零。
// INV-02 守住 PlanUsageRequestStatus 的七个字面量：上报值与看板枚举必须一一对应；增删会让类型与图表口径错位。
// INV-03 守住 accepted 作为 request_status 的缺省值：缺省请求没有显式状态；改成 started 会虚增启动量。
// INV-04 守住 ArmsReporter 窄接口只取 reportArmsCustomEvent：这里不持有平台服务；放宽会让依赖扩散并破坏可测性。
// INV-05 守住去重集合上限两千：长会话里 eventKey 会无限增长；去掉上限会造成常驻内存单调上涨。
// INV-06 守住淘汰按迭代顺序取最老一项：集合迭代顺序即写入顺序；改成按值删除会留下永不淘汰的键。
// INV-07 守住先查重后写入的顺序：先写入再判断只会永远命中；顺序颠倒会让后续事件全部被静默丢弃。
// INV-08 守住整数归一化的两个阈值：positive 要求大于零、nonNegative 允许零；混淆会让 attempt 为 0 时维度丢失。
// INV-09 守住 Number.isFinite 先行判断：undefined 与 NaN 必须先被挡掉；直接取整会产生 NaN 上报值。
// INV-10 守住 statusType 到 request_status 的穷尽 switch：五个协议状态各自映射；漏掉一个会让该状态永不上报。
// INV-11 守住 switch 不写 default：协议新增状态时应先编译报错；加 default 会把新状态悄悄吞掉。
// INV-12 守住 omitUndefinedProperties 只剔除不补默认值：undefined 与 false、0 语义不同；填默认值会污染计数。
// INV-13 守住 unknown 兜底桶独立于 custom：它表达协议事件未携带 provider；合并会让内置与自建口径一起失真。
// INV-14 守住投影只改上报值：本地日志与发送闸门仍用原始 providerId；改写原值会丢失排障线索。
// INV-15 守住 providerId 去空白后为空即早返回：空串不是有效维度；放行会产生不可归属的脏事件。
// INV-16 守住 params.properties 最后展开：调用方可以覆盖投影字段；提前展开会让补充字段被静默覆盖。
// INV-17 守住上报即发即忘：等待或重试会阻塞调用链；同步异常与异步拒绝都只记 warn 不抛出。
// INV-18 守住 TTFT 的有限非负校验：负值与 NaN 会拉低均值；提前返回比事后修正更可靠。
//
// 模块职责：把 plan_usage 组的请求生命周期与首字延迟投影成 ARMS 自定义事件，屏蔽 provider 与模型名的隐私与高基数风险。
// 状态所有权：去重集合是本模块私有的进程内状态，容量上限两千；调用方只提供事实参数，不持有该集合。
// 阅读顺序：先看三个导出常量与状态类型，再看去重与整数归一化，然后是投影与三个上报入口的早返回与失败兜底。
import {
  resolveTelemetryModelId,
  resolveTelemetryProviderScope,
  sanitizeTelemetryModelValue,
  type ArmsCustomEventPayload,
  type IPlatformService,
  type ZCodeTaskNetworkDebugStatus,
} from "@zcode/shared";
import { logger } from "@/logger.js";

// 对外契约：三个常量拼成 ARMS 事件三元组，组名固定 plan_usage，事件名分别是 plan_request 与 plan_ttft。
// 事件名是外部看板与告警规则的匹配键，改动属于破坏性变更，必须与 ARMS 侧配置同批发布。
// 请求事件与 TTFT 事件故意拆成两条流：一条携带状态与重试维度，另一条只保证延迟可比。
// 常量保持字面量而非枚举，便于上报载荷直接序列化，也避免跨包引入运行时代码。
export const PLAN_USAGE_ARMS_GROUP = "plan_usage";
export const PLAN_USAGE_ARMS_EVENT_REQUEST = "plan_request";
export const PLAN_USAGE_ARMS_EVENT_TTFT = "plan_ttft";

// 七个字面量覆盖一次请求的完整生命周期：受理、排队、启动、结束、失败、重试排期与流停滞。
// 该联合类型同时约束 networkRequestStatus 的返回值，新增字面量时必须回看映射是否跟上。
// 状态值直接进入 request_status 属性，不能出现驼峰或空格，否则看板分组会分裂成两个桶。
export type PlanUsageRequestStatus =
  | "accepted"
  | "queued"
  | "started"
  | "completed"
  | "failed"
  | "retry_scheduled"
  | "stream_stalled";

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

// 去重集合是模块级私有状态，生命周期跟随进程，保证同一 eventKey 只上报一次。
// 上限两千是内存与去重窗口的折中：事件流无限长，无上限会让集合只增不减。
// 集合只存键不存事件体，避免把请求参数与模型名长期留在内存里。
const reportedModelRequestEventKeys = new Set<string>();
const MAX_REPORTED_MODEL_REQUEST_EVENT_KEYS = 2_000;

// 返回值语义是本次是否首次见到该键：false 表示重复，调用处据此提前返回。
// 先查后写保证同一键只放行一次；集合无锁，依赖单线程事件循环让这段同步判断保持原子。
// 超过上限时按迭代顺序删除最老键，形成近似先进先出的滑动窗口，避免淘汰刚发生的事件。
// 淘汰分支先判断取出值是否为字符串，用来覆盖空集合取到 undefined 的情况，保证不会误删。
function rememberModelRequestEventKey(eventKey: string): boolean {
  if (reportedModelRequestEventKeys.has(eventKey)) {
    return false;
  }
  reportedModelRequestEventKeys.add(eventKey);
  if (reportedModelRequestEventKeys.size > MAX_REPORTED_MODEL_REQUEST_EVENT_KEYS) {
    const oldest = reportedModelRequestEventKeys.values().next().value;
    if (typeof oldest === "string") {
      reportedModelRequestEventKeys.delete(oldest);
    }
  }
  return true;
}

// 两个归一化函数都不接受负值与 NaN：ARMS 属性与事件值只保留可聚合的数字。
// 采用四舍五入而非截断，避免重试次数等小数值在边界处被系统性压低。
// undefined 原样返回，让 omitUndefinedProperties 最后统一剔除，而不是在各处补零。
function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}

// 映射只做协议状态到上报状态的转换，不补默认值也不改计数，保证失败与重试口径稳定。
// 五个分支对应协议里有限的 statusType，穷尽返回让调用处无需再判空。
// 若上游新增状态，这里会先出现编译错误，提醒同时更新看板与告警阈值。
function networkRequestStatus(
  statusType: ZCodeTaskNetworkDebugStatus["statusType"],
): PlanUsageRequestStatus {
  switch (statusType) {
    case "model_request_started":
      return "started";
    case "model_request_completed":
      return "completed";
    case "model_request_failed":
      return "failed";
    case "model_retry_scheduled":
      return "retry_scheduled";
    case "model_stream_stalled":
      return "stream_stalled";
  }
}

// 只剔除 undefined，保留 false 与 0：这两个值在 ARMS 里是可区分的事实，不能被当成缺失。
// 逐项重建对象而不是原地删除，避免改变调用方传入的 properties 引用。
// 放在属性组装之后执行，让 undefined 在序列化前一次性消失，减少逐条属性的条件判断。
function omitUndefinedProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const compact: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return compact;
}

/** 真实状态没有 provider id 时的既有兜底桶；必须与「自定义 provider 归一值」区分开。 */
const PLAN_USAGE_PROVIDER_ID_UNKNOWN = "unknown";

/**
 * provider/model 的上报投影。
 *
 * 自定义 provider 的 id 与模型名由用户命名，原样上报会泄露私有名称并制造高基数，因此与
 * `chat_error_banner` 共用同一条白名单：内置 provider 保留稳定 ID，其余归一为 `custom`。
 * 只改写上报值——事件是否发送仍由调用处的原始 `providerId` 闸门决定，本地日志也保留原值。
 *
 * `unknown` 兜底不能被并进 `custom`：它表达「协议事件没带 provider」，是既有计数口径的一部分。
 * 该分支下模型名按自身白名单判定，既保留可用维度，又不透传自定义模型名。
 */
// 投影的输入是已去空白的 providerId，输出三个稳定维度：provider_id、provider_scope 与 model_name。
// unknown 必须单独成桶：它表示协议事件本身没带 provider，与自建 provider 归一后的 custom 语义不同。
// 其余情况交给共享白名单解析，内置 provider 保留稳定 ID，自建项统一归一，避免私有名称外泄与高基数。
// 模型名同样走白名单，未命中时返回 undefined 由上层剔除，而不是透传原始字符串。
function providerTelemetryProjection(
  providerId: string,
  modelName: string | undefined,
): { provider_id: string; provider_scope: string; model_name: string | undefined } {
  if (providerId === PLAN_USAGE_PROVIDER_ID_UNKNOWN) {
    return {
      provider_id: PLAN_USAGE_PROVIDER_ID_UNKNOWN,
      provider_scope: PLAN_USAGE_PROVIDER_ID_UNKNOWN,
      model_name: sanitizeTelemetryModelValue(modelName) || undefined,
    };
  }
  const provider = resolveTelemetryProviderScope(providerId);
  const modelId = resolveTelemetryModelId(provider.providerScope, modelName);
  return {
    provider_id: provider.providerId,
    provider_scope: provider.providerScope,
    model_name: modelId || undefined,
  };
}

// 入口先挡两件事：没有 reporter 时不触碰平台服务，providerId 去空白后为空时直接放弃。
// 空 providerId 不是有效维度，放行只会产出无法归属的计数，因此宁可不报。
// value 恒为 1，表示一次请求；随时间变化的信息全部放进属性，保证事件值口径单一。
// request_status 缺省按 accepted 计，调用方可以显式传入后续状态。
// properties 最后展开，调用方补充字段可以覆盖投影值，这是有意的逃生口，改动顺序会静默改变语义。
export function reportPlanUsageRequestToArms(
  reporter: ArmsReporter | null | undefined,
  params: {
    providerId?: string | null;
    modelName?: string | null;
    askMode?: string | null;
    requestStatus?: PlanUsageRequestStatus;
    properties?: Record<string, string | number | boolean | undefined>;
  },
): void {
  if (!reporter) {
    return;
  }

  const providerId = params.providerId?.trim();
  if (!providerId) {
    return;
  }

  const payload: ArmsCustomEventPayload = {
    name: PLAN_USAGE_ARMS_EVENT_REQUEST,
    group: PLAN_USAGE_ARMS_GROUP,
    value: 1,
    properties: {
      ask_mode: params.askMode?.trim() || undefined,
      ...providerTelemetryProjection(providerId, params.modelName?.trim()),
      request_status: params.requestStatus ?? "accepted",
      ...params.properties,
    },
  };

  try {
    void Promise.resolve(reporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[plan-usage] ARMS 上报失败", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[plan-usage] ARMS 上报异常", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// 入口依赖 eventKey 去重：同一网络事件可能从多条链路回调，重复上报会放大失败率与延迟分位。
// providerId 缺失时落到 unknown 桶而不是丢弃事件，因为协议事件可能不携带 provider。
// value 取 durationMs，缺失时退回 1，保证事件值始终是正数可聚合。
// 属性里所有可选数值都过整数归一化，任何 NaN 都会让整条属性集失去统计意义。
// 上报仍然即发即忘：同步抛错与异步拒绝都只记录 warn，绝不向上冒泡影响网络状态机。
export function reportPlanUsageModelRequestStartedToArms(
  reporter: ArmsReporter | null | undefined,
  event: ZCodeTaskNetworkDebugStatus,
): void {
  if (!reporter) {
    return;
  }
  if (!rememberModelRequestEventKey(event.eventKey)) {
    return;
  }

  const providerId = event.providerId?.trim() || "unknown";
  const status = networkRequestStatus(event.statusType);
  const durationMs = nonNegativeInteger(event.durationMs);
  const payload: ArmsCustomEventPayload = {
    name: PLAN_USAGE_ARMS_EVENT_REQUEST,
    group: PLAN_USAGE_ARMS_GROUP,
    value: durationMs ?? 1,
    properties: omitUndefinedProperties({
      ask_mode: event.querySource?.trim() || undefined,
      ...providerTelemetryProjection(providerId, event.modelId?.trim()),
      request_status: status,
      request_id: event.requestId,
      task_id: event.taskId,
      input_id: event.inputId,
      query_id: event.queryId,
      event_key: event.eventKey,
      attempt: positiveInteger(event.attempt),
      next_attempt: positiveInteger(event.nextAttempt),
      max_attempts: positiveInteger(event.maxAttempts),
      status_code: nonNegativeInteger(event.statusCode),
      duration_ms: durationMs,
      delay_ms: nonNegativeInteger(event.delayMs),
      idle_ms: nonNegativeInteger(event.idleMs),
      timeout_ms: nonNegativeInteger(event.timeoutMs),
      retryable: event.retryable,
      reason: event.reason?.trim() || undefined,
      transport: event.transport?.trim() || undefined,
      provider_kind: event.providerKind?.trim() || undefined,
    }),
  };

  try {
    void Promise.resolve(reporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[plan-usage] ARMS 上报失败", {
        providerId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[plan-usage] ARMS 上报异常", {
      providerId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// TTFT 入口的守卫最严：reporter 缺失、ttftMs 非有限值或为负都直接返回。
// 负延迟与 NaN 会污染均值与分位，宁可丢一条样本也不写入。
// 通过守卫后统一四舍五入并夹到零以上，属性里的 ttft_ms 与事件 value 使用同一个值。
// 该事件不带重试与状态维度，只保留 ask_mode 与 provider 投影，保证跨版本可比。
export function reportPlanUsageTtftToArms(
  reporter: ArmsReporter | null | undefined,
  params: {
    providerId?: string | null;
    modelName?: string | null;
    askMode?: string | null;
    ttftMs: number;
  },
): void {
  if (!reporter || !Number.isFinite(params.ttftMs) || params.ttftMs < 0) {
    return;
  }

  const providerId = params.providerId?.trim();
  if (!providerId) {
    return;
  }

  const ttftMs = Math.max(0, Math.round(params.ttftMs));
  const payload: ArmsCustomEventPayload = {
    name: PLAN_USAGE_ARMS_EVENT_TTFT,
    group: PLAN_USAGE_ARMS_GROUP,
    value: ttftMs,
    properties: {
      ask_mode: params.askMode?.trim() || undefined,
      ...providerTelemetryProjection(providerId, params.modelName?.trim()),
      ttft_ms: ttftMs,
    },
  };

  try {
    void Promise.resolve(reporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[plan-usage] ARMS TTFT 上报失败", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[plan-usage] ARMS TTFT 上报异常", {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
