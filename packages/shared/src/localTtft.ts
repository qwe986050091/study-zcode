// INV-01 守住位置：六个阶段按 renderer_prepare、command_admission、execution_wait、request_prepare、model_request、output_return 固定排序｜改错故障：改动枚举顺序会让上报端的 interval stage 与本模块不一致，整条记录被判为未知阶段
// INV-02 守住位置：record 的 intervals 上限 6 恒等于阶段常量的长度｜改错故障：新增阶段却不同步上限，最后一个阶段的耗时会被校验拒收并连带丢掉整条记录
// INV-03 守住位置：桶边界数组从 1 到 300000 严格递增，样本归入首个不小于自身的边界｜改错故障：插入乱序边界会让相邻桶耗时倒挂，分位数整体偏移
// INV-04 守住位置：details 在 facts 与 record 两处共用 64 条上限｜改错故障：只放宽一处会让同一批明细在落库前被不同校验截断
// INV-05 守住位置：detail 的阶段只允许七个准备工作阶段外加 attempt、retry_wait、user_confirmation｜改错故障：漏掉重试等待会把重试耗时错记进模型请求阶段
// INV-06 守住位置：detail 与 interval 都用 refine 强制结束不早于开始，开始必填而结束可选｜改错故障：去掉该约束后时钟回拨会写出负耗时，把均值整体拉低
// INV-07 守住位置：所有标识限制在 1 到 128 字符，uuid 只用于 observationId｜改错故障：放开长度会让超长上游字段撑爆上报载荷并触发服务端整批拒收
// INV-08 守住位置：detail 的来源只取 renderer 或 cli，interval 的来源多一个 aligned｜改错故障：把对齐后的区间继续标成 renderer 会让双端耗时被重复统计
// INV-09 守住位置：所有对象 schema 都以 strict 收尾，未知字段一律报错而不是静默丢弃｜改错故障：放宽成透传会让新版本字段悄悄越过版本号兼容检查
// INV-10 守住位置：facts 直接展开上下文的 shape，version 与 observationId 与观测上下文同源｜改错故障：各自复写字段会让同一条观测在两条通道里拿到不同 version
// INV-11 守住位置：facts 的时间线按接收、准入、执行、发请求、首字输出依次可选递进｜改错故障：前置时刻缺失却填后续时刻，回放时会算出负的准备耗时
// INV-12 守住位置：terminal 与 excluded 分工表达结局与不计入原因，二者不混用｜改错故障：把容量拒绝写进 terminal 会让拒载样本污染本地首字延迟均值
// INV-13 守住位置：record 的类型区分 start、first_output、first_text、no_text、excluded、checkpoint 六种｜改错故障：把 no_text 混进 first_output 会把无文本回合算成有首字延迟
// INV-14 守住位置：outcome 里的 resync 只代表桌面 continuous 缓冲溢出后的在线快照重建｜改错故障：复用 resync 表示手机重连会让恢复样本失去可区分性
// INV-15 守住位置：quality 为 clock_invalid 时仍保留 clockErrorMs，且两端可信度分为两个独立标志｜改错故障：合并成一个标志会让单端时钟坏掉时另一端样本也被丢弃
// INV-16 守住位置：batch 的 records 上限 32、sequence 单调非负，丢弃数单独记在 dropped｜改错故障：不比对 sequence 会漏掉整段丢失，缺口被当成零延迟样本
// INV-17 守住位置：取时只用 performance 的 timeOrigin 加单调计时得到 epoch 毫秒｜改错故障：混入系统时间会让校准窗口内的样本出现负延迟或突刺
// INV-18 守住位置：时钟校准以往返延迟的一半为误差、以行程中点为偏移，超限即返回未定义｜改错故障：上限放宽会把高抖动实例算进对齐样本，尾部延迟被系统性改写
//
// 模块职责：定义本地首字延迟观测的共享契约，包括阶段与桶常量、明细/事实/区间/记录/批五层校验、时钟校准与统一取时。
// 状态所有权：本模块无状态，只导出常量、schema 与纯函数；时间戳由调用方采集后填入事实与记录，校准结果是值对象。
// 阅读顺序：先看阶段、桶与上限常量，再看五层 schema 的必填项与 refine 约束，最后看校准函数的拒绝条件与取时函数的时钟域。
import { z } from "zod";

export const LOCAL_TTFT_STAGES = [
  "renderer_prepare",
  "command_admission",
  "execution_wait",
  "request_prepare",
  "model_request",
  "output_return",
] as const;
// 桶边界是左闭右开语义，样本值归入首个不小于自身的边界
// 1 到 1000 毫秒之间按 1、5、10、20、50 的密度递增，覆盖首字延迟最常见的量级
// 1 秒之后只保留 2、5、10、30 秒与 5 分钟，长尾不再细分以控制直方图宽度
// 数组必须严格升序且无重复，分位数反查依赖边界单调才能定位桶下标
// 改错后果：调整任一边界都会让历史直方图与新直方图不可比，同期对比失真
export const LOCAL_TTFT_BUCKETS_MS = [
  1, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000,
];
export const LOCAL_TTFT_MAX_DETAILS = 64;
export const LOCAL_TTFT_PREPARATION_STAGES = [
  "context",
  "hooks",
  "persistence",
  "compaction",
  "mcp",
  "tools",
  "request_assembly",
] as const;
// 诊断时间统一收口成有限非负数，NaN、Infinity 与负值都在此被拒
// 起点必填而终点可选，是后续全部耗时计算的前置约定
// 毫秒精度由采集方保证，这里只做取值范围把关，不做取整或补默认值
// 改错后果：放过 Infinity 会让差值变成 NaN 并污染整批聚合结果
const diagnosticTime = z.number().finite().nonnegative();
export const localTtftDetailSchema = z
  .object({
    id: z.string().min(1).max(128),
    stage: z.enum([...LOCAL_TTFT_PREPARATION_STAGES, "attempt", "retry_wait", "user_confirmation"]),
    start: diagnosticTime,
    end: diagnosticTime.optional(),
    outcome: z.enum(["completed", "failed", "cancelled", "first_output"]).optional(),
    requestId: z.string().min(1).max(128).optional(),
    logicalCallId: z.string().min(1).max(128).optional(),
    role: z.enum(["response", "preparation"]).optional(),
    source: z.enum(["renderer", "cli"]),
  })
  .strict()
  // 明细的结束时间允许缺省，表示该阶段已开始但尚未收尾
  // 一旦给出结束时间就必须不早于开始时间，负时长一律当脏数据拒收
  // 该校验排在 strict 之后，未知字段先被拒，再谈时间顺序
  // 缺省不会补成零，避免把进行中的阶段算成瞬时完成
  // 改错后果：把缺省当成 0 会让未完成阶段拉低整体首字延迟
  .refine((value) => value.end === undefined || value.end >= value.start);
export type LocalTtftDetail = z.infer<typeof localTtftDetailSchema>;
export const LOCAL_TTFT_MAX_PENDING = 128;
export const LOCAL_TTFT_TTL_MS = 300_000;
export const LOCAL_TTFT_CLOCK_MAX_ERROR_MS = 10;
export const LOCAL_TTFT_CLOCK_TTL_MS = 60_000;
const time = z.number().finite().nonnegative();
const identifier = z.string().min(1).max(128);
export const localTtftContextSchema = z
  .object({ version: z.literal(1), observationId: z.string().uuid() })
  .strict();
export type LocalTtftContext = z.infer<typeof localTtftContextSchema>;
// 时钟探针只承载实例标识与收发两个时间戳，不携带偏移结果
// receivedAt 是本地收包时刻，sentAt 是对方发出时刻，二者共同参与差值计算
// sentAt 不早于 receivedAt 的顺序校验留给校准函数，schema 只做类型与范围约束
// 改错后果：在 schema 里提前拒绝会让坏样本连计数都拿不到，无法统计时钟异常率
export const localTtftClockSchema = z
  .object({ instanceId: identifier, receivedAt: time, sentAt: time })
  .strict();
export type LocalTtftClock = z.infer<typeof localTtftClockSchema>;
export interface LocalTtftCalibration {
  instanceId: string;
  offsetMs: number;
  errorMs: number;
  measuredAt: number;
}
export function calibrateLocalTtftClock(
  start: number,
  end: number,
  clock: LocalTtftClock,
): LocalTtftCalibration | undefined {
  // 往返延迟用本地耗时减去对方处理间隔，剩余部分才是纯网络开销
  // 前置校验按顺序短路：非有限值、时间倒挂、负网络耗时、误差超限逐层拒绝
  // 误差上限十毫秒是刻意的严阈值，超过即判定该实例的时钟不可用
  // 偏移取往返行程的中点估计，误差取往返延迟的一半，二者共用同一个除数二
  // 改错后果：阈值放宽会把跨时区或高抖动实例算进对齐样本，尾部延迟被系统性改写
  const networkMs = end - start - (clock.sentAt - clock.receivedAt);
  if (
    ![start, end, clock.receivedAt, clock.sentAt].every(Number.isFinite) ||
    end < start ||
    clock.sentAt < clock.receivedAt ||
    networkMs < 0 ||
    networkMs / 2 > LOCAL_TTFT_CLOCK_MAX_ERROR_MS
  )
    return undefined;
  return {
    instanceId: clock.instanceId,
    offsetMs: (start + end - clock.receivedAt - clock.sentAt) / 2,
    errorMs: networkMs / 2,
    measuredAt: end,
  };
}
export const localTtftOutputKindSchema = z.enum(["text", "reasoning", "tool"]);
export type LocalTtftOutputKind = z.infer<typeof localTtftOutputKindSchema>;
// facts 是上报端的原始事实，除上下文、实例、命令与接收时间外全部可选
// 上下文字段通过展开 shape 复用，保证与观测上下文的校验完全一致
// 时间戳按接收、准入、执行、发请求、首字输出递进，后一时刻缺失表示流程未走到
// terminal 描述结局，excluded 描述为何不计入样本，两者不互相替代
// 改错后果：把容量拒绝写进 terminal 会让拒载样本污染首字延迟分布
export const localTtftFactsSchema = z
  .object({
    ...localTtftContextSchema.shape,
    instanceId: identifier,
    commandId: identifier,
    sessionId: identifier.optional(),
    turnId: identifier.optional(),
    productTurnId: identifier.optional(),
    queryId: identifier.optional(),
    requestId: identifier.optional(),
    logicalCallId: identifier.optional(),
    cliVersion: identifier.optional(),
    provider: identifier.optional(),
    model: identifier.optional(),
    details: z.array(localTtftDetailSchema).max(LOCAL_TTFT_MAX_DETAILS).optional(),
    truncated: z.boolean().optional(),
    revision: z.number().int().nonnegative().optional(),
    sendMode: z.enum(["idle", "queued", "guided"]).optional(),
    clockInvalid: z.boolean().optional(),
    receivedAt: time,
    admittedAt: time.optional(),
    executionAt: time.optional(),
    requestAt: time.optional(),
    outputAt: time.optional(),
    outputKind: localTtftOutputKindSchema.optional(),
    terminal: z.enum(["completed", "failed", "cancelled", "rejected", "interrupted"]).optional(),
    excluded: z.enum(["busy", "retry", "unsupported", "failed", "capacity"]).optional(),
  })
  .strict();
export type LocalTtftFacts = z.infer<typeof localTtftFactsSchema>;
export const localTtftIntervalSchema = z
  .object({
    stage: z.enum(LOCAL_TTFT_STAGES),
    start: time,
    end: time,
    source: z.enum(["renderer", "cli", "aligned"]),
  })
  .strict()
  .refine((interval) => interval.end >= interval.start);
// record 是落库形态，version、observationId、kind、起止时间、质量与区间均为必填
// intervals 上限为六，正好对应六个阶段，缺阶段用更短的数组表示而不补零
// sendMode 与 visibility 只记录发送方式与前后台切换，不参与耗时计算
// visibilityChanges 上限三十二，超出部分靠 truncated 标记而不是无限追加
// 改错后果：给缺失阶段补零会让总耗时被低估，分位数整体左移
export const localTtftRecordSchema = z
  .object({
    version: z.literal(1),
    observationId: z.string().uuid(),
    commandId: identifier.optional(),
    sessionId: identifier.optional(),
    turnId: identifier.optional(),
    productTurnId: identifier.optional(),
    queryId: identifier.optional(),
    requestId: identifier.optional(),
    logicalCallId: identifier.optional(),
    cliVersion: identifier.optional(),
    cliInstanceId: identifier.optional(),
    kind: z.enum(["start", "first_output", "first_text", "no_text", "excluded", "checkpoint"]),
    outcome: z.enum([
      "success",
      "busy",
      "retry",
      "unsupported",
      "failed",
      "cancelled",
      "background",
      "expired",
      "capacity",
      "recovery",
      // 桌面 continuous 缓冲溢出/投影重建后的 online snapshot；不是手机 replayable 恢复。
      "resync",
      "clock_invalid",
      "rejected",
      "interrupted",
      "guided",
      "unclosed",
    ]),
    start: time,
    end: time,
    firstOutputKind: localTtftOutputKindSchema.optional(),
    quality: z.enum(["complete", "missing", "clock_invalid"]),
    clockErrorMs: time.optional(),
    intervals: z.array(localTtftIntervalSchema).max(6),
    checkpointId: identifier.optional(),
    details: z.array(localTtftDetailSchema).max(LOCAL_TTFT_MAX_DETAILS).optional(),
    truncated: z.boolean().optional(),
    sendMode: z.enum(["idle", "queued", "guided"]).optional(),
    visibility: z.enum(["foreground", "background", "background_returned"]).optional(),
    visibilityChanges: z
      .array(z.object({ at: time, foreground: z.boolean() }).strict())
      .max(32)
      .optional(),
    userWaitMs: time.optional(),
    executionMs: time.optional(),
    timingReliable: z.boolean().optional(),
    cliTimingReliable: z.boolean().optional(),
    provider: identifier.optional(),
    model: identifier.optional(),
  })
  .strict()
  .refine((record) => record.end >= record.start);
export type LocalTtftRecord = z.infer<typeof localTtftRecordSchema>;
export const localTtftBatchSchema = z
  .object({
    version: z.literal(1),
    rendererInstanceId: identifier,
    sequence: z.number().int().nonnegative(),
    records: z.array(localTtftRecordSchema).max(32),
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export type LocalTtftBatch = z.infer<typeof localTtftBatchSchema>;
// 取时只用 performance 的 timeOrigin 加单调计时，输出 epoch 毫秒供跨端对齐
// 刻意不读系统时间，避免用户改表或校时导致时间戳整体跳变
// timeOrigin 在页面生命周期内固定，单调部分不受墙钟回拨影响
// 改错后果：换回日期取时会让校准窗口内的样本出现负延迟或突刺
export function localTtftNow(): number {
  return performance.timeOrigin + performance.now();
}
