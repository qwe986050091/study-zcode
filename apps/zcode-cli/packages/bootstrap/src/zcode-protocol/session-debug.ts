// INV-01 只处理网络状态事件：守住位置 事件类型判断；改错故障 其它事件污染调试面。
// INV-02 会话标识必须一致：守住位置 sessionId 比对；改错故障 串会话数据显示。
// INV-03 映射失败直接跳过：守住位置 mapped 判断；改错故障 半成品条目入表。
// INV-04 观察状态惰性创建：守住位置 WeakMap；改错故障 无事件会话也占内存。
// INV-05 事件去重有界：守住位置 remember；改错故障 去重集合无限增长。
// INV-06 去重集合按上限淘汰最旧：守住位置 size 判断；改错故障 内存随请求数增长。
// INV-07 请求头有界化：守住位置 boundedHeaders；改错故障 超大响应头撑爆快照。
// INV-08 消息截断：守住位置 MAX_MESSAGE_LENGTH；改错故障 调试响应体积失控。
// INV-09 无限重试必须保留：守住位置 maxAttempts 透传；改错故障 旧映射器丢字段。
// INV-10 条目按上限滑窗：守住位置 尾部裁剪；改错故障 网络表无限增长。
// INV-11 只统计主回合完成：守住位置 三个条件；改错故障 子查询混入命中率。
// INV-12 完成请求也去重：守住位置 completedRequests；改错故障 同一请求重复累计。
// INV-13 未知缓存用量标记：守住位置 hasUnknownCacheUsage；改错故障 命中率被低估。
// INV-14 命中率有未知即置空：守住位置 三元；改错故障 展示虚假命中率。
// INV-15 输出速率需有效时长：守住位置 calculateOutputTps；改错故障 除零或负值。
// INV-16 轮次表按上限滑窗：守住位置 尾部裁剪；改错故障 轮次无限增长。
// INV-17 快照只读不落库：守住位置 readSessionDebug；改错故障 调试读取触发持久化。
// INV-18 协议入口先校验参数：守住位置 schema parse；改错故障 非法参数进入运行时。
//
// 模块职责：旁路观察模型网络事件，维护有界的会话调试快照。
// 状态所有权：快照挂在 WeakMap 上随会话记录回收，不进入聊天投影。
// 阅读顺序：先看观察入口，再看有界工具，最后看读取与协议入口。
import {
  SessionEventType,
  type ModelNetworkStatusPayload,
  type SessionEvent,
} from "@zcode/contracts";
import {
  SESSION_DEBUG_LIMITS,
  calculateOutputTps,
  sessionDebugParamsSchema,
  zcodeTaskNetworkDebugStatusFromPayload,
  type SessionDebugSnapshot,
} from "@zcode/shared";
import { requireSession, type ZCodeProtocolAgentServerContext } from "./server-types.js";

type SessionRecord = { app: { sessionId: string } };
interface Observation {
  snapshot: SessionDebugSnapshot;
  seenEvents: Set<string>;
  completedRequests: Set<string>;
  hasUnknownCacheUsage: boolean;
}
// 旁路记录跟随 CLI record 回收，不挂到聊天投影、轮次事实或已提交输入队列上。
const observations = new WeakMap<SessionRecord, Observation>();
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE_LENGTH = 512;
const MAX_MESSAGE_LENGTH = 2048;

function emptySnapshot(sessionId: string): SessionDebugSnapshot {
  return { sessionId, rounds: [], networkEntries: [], cache: null };
}
function remember(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false;
  keys.add(key);
  if (keys.size > SESSION_DEBUG_LIMITS.dedupe) keys.delete(keys.values().next().value!);
  return true;
}
function boundedHeaders(headers: Record<string, string>): Record<string, string> {
  // adapter 已脱敏；此处只限制调试响应体积，不保存正文，也不复制无限大小的 headers。
  return Object.fromEntries(
    Object.entries(headers)
      .slice(0, MAX_HEADER_COUNT)
      .map(([key, value]) => [
        key.slice(0, MAX_HEADER_VALUE_LENGTH),
        value.slice(0, MAX_HEADER_VALUE_LENGTH),
      ]),
  );
}
function token(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 旁路观察一条会话事件，只处理 ModelNetworkStatus（且 sessionId 匹配）。
 * 维护三份有界状态：网络请求条目、去重集合与缓存命中累计；不落盘、不进聊天投影。
 * 解析失败/非主回合完成事件直接跳过，观察函数本身不抛错。
 */
// 只接受 SessionEventType.ModelNetworkStatus 事件。
// event.sessionId 必须严格等于 record.app.sessionId。
// 映射返回空时直接 return，不修改 observations。
// observations 按 record 惰性创建，首次命中才写入。
export function observeSessionDebug(record: SessionRecord, event: SessionEvent): void {
  if (
    event.type !== SessionEventType.ModelNetworkStatus ||
    String(event.sessionId) !== record.app.sessionId
  )
    return;
  // payload 转成 ModelNetworkStatusPayload 后交给映射函数。
  // Date.parse 失败时回退 event.timestamp.getTime()。
  // 解构时剔除 inputId 等标识字段，调试面只保留状态字段。
  const payload = event.payload as ModelNetworkStatusPayload;
  const mapped = zcodeTaskNetworkDebugStatusFromPayload({
    taskId: record.app.sessionId,
    traceId: event.traceId,
    eventId: String(event.id),
    payload: { ...payload, model: { providerId: payload.providerId, modelId: payload.modelId } },
  });
  if (!mapped) return;
  let observation = observations.get(record);
  if (!observation) {
    observation = {
      snapshot: emptySnapshot(record.app.sessionId),
      seenEvents: new Set(),
      completedRequests: new Set(),
      hasUnknownCacheUsage: false,
    };
    observations.set(record, observation);
  }
  // seenEvents 由 remember 维护，容量上限见 SESSION_DEBUG_LIMITS。
  // 超出上限时删除 Set 中最早插入的 event id。
  // remember 返回 false 时说明重复，直接 return 不再累计。
  if (!remember(observation.seenEvents, String(event.id))) return;
  const { type: _type, taskId: _taskId, eventId: _eventId, inputId: _inputId, ...entry } = mapped;
  const parsedAt = Date.parse(payload.timestamp);
  const recordedAt = Number.isFinite(parsedAt) ? parsedAt : event.timestamp.getTime();
  const state = observation.snapshot;
  state.networkEntries = [
    ...state.networkEntries,
    {
      ...entry,
      recordedAt,
      // maxAttempts=0 表示无限重试，旧映射器会丢掉它，调试面必须保留。
      maxAttempts: payload.maxAttempts,
      requestHeaders: boundedHeaders(entry.requestHeaders),
      responseHeaders: boundedHeaders(entry.responseHeaders),
      ...(entry.message ? { message: entry.message.slice(0, MAX_MESSAGE_LENGTH) } : {}),
    },
  ].slice(-SESSION_DEBUG_LIMITS.network);
  if (
    payload.type !== "model_request_completed" ||
    payload.querySource !== "main_turn" ||
    !remember(observation.completedRequests, payload.requestId)
  )
    return;
  // 只累计主回合完成事件，子回合完成不计入 rounds。
  // completedRequests 按 payload.requestId 去重，重复完成只记一次。
  // usage.cacheReadTokens 缺失时把 hasUnknownCacheUsage 置为 true。
  const usage = payload.usage;
  const inputTokens = token(usage?.inputTokens);
  const outputTokens = token(usage?.outputTokens);
  const cacheReadTokens = token(usage?.cacheReadTokens);
  const duration = token(payload.durationMs);
  const first = token(payload.timeToFirstContentMs);
  const generationDurationMs =
    duration !== undefined && first !== undefined && duration > first ? duration - first : null;
  observation.hasUnknownCacheUsage ||= inputTokens === undefined || cacheReadTokens === undefined;
  const previous = state.cache;
  const totalInputTokens = (previous?.totalInputTokens ?? 0) + (inputTokens ?? 0);
  const totalCacheReadTokens = (previous?.totalCacheReadTokens ?? 0) + (cacheReadTokens ?? 0);
  const requestIndex = (previous?.hitRateRequestCount ?? 0) + 1;
  state.cache = {
    hitRateRequestCount: requestIndex,
    totalInputTokens,
    totalCacheReadTokens,
    hitRate:
      !observation.hasUnknownCacheUsage && totalInputTokens > 0
        ? totalCacheReadTokens / totalInputTokens
        : null,
  };
  state.rounds = [
    ...state.rounds,
    {
      eventKey: String(event.id),
      requestId: payload.requestId,
      requestIndex,
      recordedAt,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          token(usage?.totalTokens) ??
          (inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined),
        reasoningTokens: token(usage?.reasoningTokens),
        cachedInputTokens: cacheReadTokens,
        cachedWriteInputTokens: token(usage?.cacheWriteTokens),
      },
      hitRate:
        inputTokens !== undefined && inputTokens > 0 && cacheReadTokens !== undefined
          ? cacheReadTokens / inputTokens
          : null,
      generationDurationMs,
      tokensPerSecond: calculateOutputTps(outputTokens, generationDurationMs),
    },
  ].slice(-SESSION_DEBUG_LIMITS.rounds);
}

/** 读取该 record 的调试快照；没有观察记录时返回空骨架（rounds/network 为空、cache=null）。 */
// observations 无记录时返回 emptySnapshot(record.app.sessionId)。
// readSessionDebug 只读内存，不写数据库。
// 缺记录时不调用 runtime 恢复，避免调试读取改变运行状态。
export function readSessionDebug(record: SessionRecord): SessionDebugSnapshot {
  return observations.get(record)?.snapshot ?? emptySnapshot(record.app.sessionId);
}

/** 协议入口：校验参数并要求 session 存在，只读返回快照，不触发 runtime 恢复。 */
export function querySessionDebug(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): SessionDebugSnapshot {
  const params = sessionDebugParamsSchema.parse(rawParams);
  return readSessionDebug(requireSession(context, params.sessionId));
}
