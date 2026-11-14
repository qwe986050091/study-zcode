// INV-01 三个上限固定且同时生效：守住位置 SESSION_DEBUG_LIMITS 与两处 max；改错故障 调试快照撑爆前端。
// INV-02 参数只接受 sessionId 一个字段：守住位置 strict；改错故障 多余字段被静默忽略。
// INV-03 sessionId 不能为空串：守住位置 min(1)；改错故障 空 id 查询到默认会话。
// INV-04 计数字段有限且非负：守住位置 count 定义；改错故障 NaN 或负数进入统计。
// INV-05 所有对象 schema 都 strict：守住位置 四处 strict；改错故障 未知字段悄悄落库。
// INV-06 网络状态是五值枚举：守住位置 z.enum；改错故障 新事件类型让整个快照解析失败。
// INV-07 头部字段必须成对：守住位置 两个 HeaderCount；改错故障 计数与实际头数不一致。
// INV-08 可空字段用 nullable 而非 optional：守住位置 hitRate/generationDurationMs；改错故障 缺失与 null 语义混淆。
// INV-09 cache 可整体为空：守住位置 nullable；改错故障 无缓存时快照校验失败。
// INV-10 TPS 只在输入完整时计算：守住位置 calculateOutputTps 的六连判；改错故障 未知值被算成 0。
// INV-11 时长必须为正：守住位置 generationDurationMs <= 0；改错故障 除零得到 Infinity。
// INV-12 非有限结果一律 null：守住位置 末尾 Number.isFinite；改错故障 NaN 进入展示层。
// INV-13 类型由 schema 推导：守住位置 z.infer；改错故障 手写类型与校验漂移。
// INV-14 未知值不用总耗时替代：守住位置 入参只收生成时长；改错故障 TPS 被高估。
//
// 模块职责：会话调试快照的 zod 契约与输出 TPS 计算。
// 阅读顺序：先看上限与基础 schema，再看轮次/网络/缓存三张表，最后看 TPS 计算。
import { z } from "zod";

// rounds 与 network 是数组上限，dedupe 供上游去重窗口使用。
// 三值集中在这里，避免不同调用方各自截断。
export const SESSION_DEBUG_LIMITS = { rounds: 200, network: 100, dedupe: 2000 } as const;
// 只允许 sessionId，strict 让拼错的查询参数直接报错。
export const sessionDebugParamsSchema = z.object({ sessionId: z.string().min(1) }).strict();
// 共享一个有限非负约束，避免每个字段重复字面量。
const count = z.number().finite().nonnegative();
const debugUsageSchema = z
  .object({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    totalTokens: count.optional(),
    reasoningTokens: count.optional(),
    cachedInputTokens: count.optional(),
    cachedWriteInputTokens: count.optional(),
  })
  .strict();
// hitRate 等可空字段允许 null，区分无数据与未采集。
// usage 内全部 optional，旧快照缺少新字段仍可解析。
export const sessionDebugRoundSchema = z
  .object({
    eventKey: z.string(),
    requestId: z.string(),
    requestIndex: count,
    recordedAt: count,
    usage: debugUsageSchema,
    hitRate: count.nullable(),
    generationDurationMs: count.nullable(),
    tokensPerSecond: count.nullable(),
  })
  .strict();
// 枚举覆盖请求生命周期五个关键点，新增状态需同步前端。
// 头部同时给 map 与 count，便于展示体积又不必遍历。
export const sessionDebugNetworkEntrySchema = z
  .object({
    eventKey: z.string(),
    traceId: z.string(),
    recordedAt: count,
    statusType: z.enum([
      "model_request_started",
      "model_request_completed",
      "model_request_failed",
      "model_retry_scheduled",
      "model_stream_stalled",
    ]),
    requestId: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    providerKind: z.string().optional(),
    transport: z.string().optional(),
    baseURL: z.string().optional(),
    querySource: z.string().optional(),
    queryId: z.string().optional(),
    timestamp: z.string().optional(),
    attempt: count.optional(),
    maxAttempts: count.optional(),
    nextAttempt: count.optional(),
    retryable: z.boolean().optional(),
    statusCode: count.optional(),
    durationMs: count.optional(),
    delayMs: count.optional(),
    idleMs: count.optional(),
    timeoutMs: count.optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
    requestHeaders: z.record(z.string(), z.string()),
    responseHeaders: z.record(z.string(), z.string()),
    requestHeaderCount: count,
    responseHeaderCount: count,
  })
  .strict();
// rounds 与 networkEntries 必须落在上限内。
// cache 整体可空，表示该会话没有缓存统计。
export const sessionDebugSnapshotSchema = z
  .object({
    sessionId: z.string(),
    rounds: z.array(sessionDebugRoundSchema).max(SESSION_DEBUG_LIMITS.rounds),
    networkEntries: z.array(sessionDebugNetworkEntrySchema).max(SESSION_DEBUG_LIMITS.network),
    cache: z
      .object({
        hitRateRequestCount: count,
        totalInputTokens: count,
        totalCacheReadTokens: count,
        hitRate: count.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SessionDebugSnapshot = z.infer<typeof sessionDebugSnapshotSchema>;
export type SessionDebugNetworkEntry = z.infer<typeof sessionDebugNetworkEntrySchema>;

/** 输出 token 与首输出到请求结束的同源时间；未知值不能用请求总耗时替代。 */
// 任一输入缺失或非正都返回 null，不猜测。
export function calculateOutputTps(
  outputTokens: number | undefined,
  generationDurationMs: number | null,
): number | null {
  if (
    outputTokens === undefined ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    generationDurationMs === null ||
    !Number.isFinite(generationDurationMs) ||
    generationDurationMs <= 0
  )
    return null;
  // 毫秒换算成秒，调用方拿到的是每秒 token 数。
  // [契约] tps 不做四舍五入：毫秒换算后原样返回，精度与舍入全部交给展示层。
  const tps = (outputTokens * 1000) / generationDurationMs;
  return Number.isFinite(tps) ? tps : null;
}
