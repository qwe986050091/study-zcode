// INV-01 记录版本固定为一：守住位置 version 字段；改错故障 消费方无法判别结构。
// INV-02 时钟漂移即时标坏：守住位置 偏差阈值；改错故障 跨进程时间被当真。
// INV-03 checkpoint 取首字节时间：守住位置 kind 判断；改错故障 检查点延迟被算入生成耗时。
// INV-04 校准需同实例且未过期：守住位置 四项条件；改错故障 用别的实例偏移校正。
// INV-05 未对齐只记缺失：守住位置 quality 三元；改错故障 可靠排队样本被当成坏时钟。
// INV-06 间隔逆序即判无效：守住位置 stop < start；改错故障 负时长进入看板。
// INV-07 非有限时长同样判无效：守住位置 Number.isFinite；改错故障 出现 NaN 间隔。
// INV-08 间隔按阶段命名：守住位置 stage 参数；改错故障 前端无法区分阶段。
// INV-09 仅对齐时补命令准入：守住位置 aligned 判断；改错故障 跨进程阶段错位。
// INV-10 执行等待与请求准备走 CLI 时钟：守住位置 source 参数；改错故障 混用时钟导致失真。
// INV-11 输出返回需要首字节时间：守住位置 firstAt 判断；改错故障 生成阶段缺失。
// INV-12 确认等待累加：守住位置 reduce；改错故障 用户等待时间偏小。
// INV-13 详情上限统一截断：守住位置 LOCAL_TTFT_MAX_DETAILS；改错故障 单条记录无限增长。
// INV-14 超限同时打标：守住位置 truncated；改错故障 消费方不知道被截断。
// INV-15 时钟可靠性分两路：守住位置 timingReliable 与 cliTimingReliable；改错故障 前端与 CLI 混淆。
// INV-16 执行耗时仅在可算时给出：守住位置 条件展开；改错故障 出现负执行时长。
// INV-17 校准误差随记录带出：守住位置 clockErrorMs；改错故障 看板无法评估偏移质量。
// INV-18 行类型映射只保留标识：守住位置 rows 字段；改错故障 复制整行正文。
//
// 模块职责：把待定 TTFT 采样结算成一条含阶段区间与质量标记的不可变记录。
// 状态所有权：pending 由调用方持有，本函数只读并回写少量标记。
// 阅读顺序：先看 pending 结构，再看对齐与区间构造，最后看返回记录。
import {
  LOCAL_TTFT_CLOCK_TTL_MS,
  LOCAL_TTFT_MAX_DETAILS,
  type LocalTtftContext,
  type LocalTtftCalibration,
  type LocalTtftFacts,
  type LocalTtftRecord,
  type LocalTtftOutputKind,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
// LocalTtftPending 以会话为单位持有，context 与 sessionId 随记录带走。
// confirmations 数组按发生顺序累积，最后整体写入 details。
// rows 用 turnId 与 kind 做索引，不保留行内容。
export interface LocalTtftPending {
  context: LocalTtftContext;
  workspace: string;
  start: number;
  wallStart: number;
  clockInvalid?: boolean;
  closed?: boolean;
  outcome?: LocalTtftRecord["outcome"];
  textClosed?: boolean;
  firstAt?: number;
  checkpointRevision: number;
  checkpointSignature?: string;
  dispatch?: number;
  commandId?: string;
  sessionId?: string;
  facts?: LocalTtftFacts;
  first?: LocalTtftOutputKind;
  lastSeq: number;
  sendMode: "idle" | "queued" | "guided";
  visibility: "foreground" | "background" | "background_returned";
  visibilityChanges: { at: number; foreground: boolean }[];
  confirmationStart?: number;
  confirmations: NonNullable<LocalTtftRecord["details"]>;
  rows: Map<number, { turnId: string; kind: ConversationRow["kind"] }>;
}

// 墙钟与单调钟偏差超过 100 毫秒时置 pending.clockInvalid。
// checkpoint 取首字节时间。
// 校准需同实例且未过期。
// 未对齐只记缺失。
export function buildLocalTtftRecord(
  pending: LocalTtftPending,
  kind: LocalTtftRecord["kind"],
  outcome: LocalTtftRecord["outcome"],
  current: number,
  wall: number,
  calibration?: LocalTtftCalibration,
): LocalTtftRecord {
  pending.clockInvalid ||= Math.abs(wall - pending.wallStart - (current - pending.start)) > 100;
  const end = kind === "checkpoint" && pending.firstAt !== undefined ? pending.firstAt : current;
  const facts = pending.facts;
  const aligned =
    calibration &&
    facts?.instanceId === calibration.instanceId &&
    end >= calibration.measuredAt &&
    end - calibration.measuredAt <= LOCAL_TTFT_CLOCK_TTL_MS &&
    !pending.clockInvalid &&
    !facts.clockInvalid;
  const offset = aligned ? calibration.offsetMs : 0;
  const intervals: LocalTtftRecord["intervals"] = [];
  let invalid = pending.clockInvalid === true || facts?.clockInvalid === true;
  // start 或 stop 为 undefined 时 interval 直接返回，不产生区间。
  // stop 小于 start 或差值为非有限数时置 invalid 并丢弃区间。
  // interval 的第一个参数是 LocalTtftRecord.intervals 的 stage 联合值。
  // 来源区分渲染器与 CLI。
  const interval = (
    stage: LocalTtftRecord["intervals"][number]["stage"],
    start: number | undefined,
    stop: number | undefined,
    source: "renderer" | "cli" | "aligned",
  ) => {
    if (start === undefined || stop === undefined) return;
    if (stop < start || !Number.isFinite(stop - start)) {
      invalid = true;
      return;
    }
    intervals.push({ stage, start, end: stop, source });
  };
  interval("renderer_prepare", pending.start, pending.dispatch, "renderer");
  if (facts) {
    const at = (value: number | undefined) => (value === undefined ? undefined : value + offset);
    // aligned 为 true 时才记录 command_admission 区间。
    // 执行等待与请求准备走 CLI 时钟。
    // 输出返回需要首字节时间。
    if (aligned) interval("command_admission", pending.dispatch, at(facts.admittedAt), "aligned");
    interval("execution_wait", at(facts.admittedAt), at(facts.executionAt), "cli");
    interval("request_prepare", at(facts.executionAt), at(facts.requestAt), "cli");
    interval("model_request", at(facts.requestAt), at(facts.outputAt), "cli");
    if (aligned && pending.firstAt !== undefined)
      interval("output_return", at(facts.outputAt), pending.firstAt, "aligned");
  }
  // details 用 slice 截到 LOCAL_TTFT_MAX_DETAILS 条。
  // 截断时 truncated 为 true（details 总数超过上限）。
  // calibration 存在时记录 clockErrorMs，便于核对跨进程偏移。
  return {
    version: 1,
    observationId: pending.context.observationId,
    commandId: pending.commandId,
    sessionId: facts?.sessionId,
    turnId: facts?.turnId,
    productTurnId: facts?.productTurnId,
    queryId: facts?.queryId,
    logicalCallId: facts?.logicalCallId,
    cliVersion: facts?.cliVersion,
    requestId: facts?.requestId,
    cliInstanceId: facts?.instanceId,
    kind,
    ...(kind === "checkpoint"
      ? { checkpointId: `checkpoint:${pending.checkpointRevision++}` }
      : {}),
    outcome,
    start: pending.start,
    end,
    firstOutputKind: pending.first,
    sendMode: facts?.sendMode ?? pending.sendMode,
    visibility: pending.visibility,
    visibilityChanges: [...pending.visibilityChanges],
    userWaitMs: pending.confirmations.reduce(
      (sum, detail) => sum + (detail.end! - detail.start),
      0,
    ),
    details: [
      ...pending.confirmations,
      ...(facts?.details ?? []).map((detail) => ({
        ...detail,
        start: detail.start + offset,
        ...(detail.end === undefined ? {} : { end: detail.end + offset }),
      })),
    ].slice(0, LOCAL_TTFT_MAX_DETAILS),
    truncated:
      facts?.truncated ||
      (facts?.details?.length ?? 0) + pending.confirmations.length > LOCAL_TTFT_MAX_DETAILS,
    timingReliable: !pending.clockInvalid,
    cliTimingReliable: facts?.clockInvalid !== true,
    ...(aligned && facts?.executionAt !== undefined && end >= facts.executionAt + offset
      ? { executionMs: end - facts.executionAt - offset }
      : {}),
    // Bug 原因：此前只要未对齐就标 clock_invalid，把“校准缺失/过期”与真实时钟异常混为一类，
    // 可靠的排队样本被默认看板当作坏时钟过滤。未对齐只意味着跨进程阶段缺失，按 missing 记。
    quality: invalid ? "clock_invalid" : intervals.length === 6 ? "complete" : "missing",
    ...(calibration ? { clockErrorMs: calibration.errorMs } : {}),
    intervals,
    model: facts?.model,
    provider: facts?.provider,
  };
}
