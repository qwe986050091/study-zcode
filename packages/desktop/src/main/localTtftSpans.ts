// INV-01 traceId 由观测标识去掉连字符得到：守住位置 replaceAll；改错故障 跨度无法与观测记录关联。
// INV-02 根 spanId 取 traceId 前 16 位：守住位置 slice；改错故障 父子关系不成立。
// INV-03 非根 spanId 由名称与附加属性哈希确定：守住位置 哈希输入；改错故障 重发记录产生重复标识。
// INV-04 根跨度只在需要上报记录时产出：守住位置 条件展开；改错故障 完成记录被重复上报。
// INV-05 子跨度的父上下文固定指向根跨度：守住位置 parentSpanContext；改错故障 跨度树断裂。
// INV-06 所有跨度都以未设置状态上报：守住位置 status 字段；改错故障 分析侧误判失败率。
// INV-07 值为空的属性必须剔除：守住位置 filter；改错故障 序列化出现空值。
// INV-08 布尔属性统一转成字符串：守住位置 显式转换；改错故障 属性类型在导出侧不一致。
// INV-09 首次输出记录才补未归因时长与缺失阶段：守住位置 kind 判断；改错故障 其他类型带上无意义字段。
// INV-10 缺失阶段只统计完成记录中确实缺席的阶段：守住位置 阶段过滤；改错故障 缺失列表恒为空。
// INV-11 每个区间映射为一个子跨度并保留时钟来源：守住位置 区间映射；改错故障 无法区分渲染侧与主进程时钟。
// INV-12 明细跨度名称按阶段前缀规范化：守住位置 三段判断；改错故障 阶段名散落难以聚合。
// INV-13 未结束明细必须以 started 后缀区分：守住位置 结束时间判断；改错故障 零长度与未完成混淆。
// INV-14 明细缺结束时间时用开始时间兜底：守住位置 空值合并；改错故障 出现负时长。
// INV-15 覆盖时长只统计与总区间相交的部分：守住位置 上下界夹取；改错故障 未归因时长被算成负数。
// INV-16 时钟不可信时只统计渲染侧区间：守住位置 quality 过滤；改错故障 跨时钟区间被重复计入。
// INV-17 区间合并按起点排序后线性扫描：守住位置 排序与游标；改错故障 重叠区间重复累加。
// INV-18 毫秒转时间元组必须保留纳秒部分：守住位置 hr 函数取整；改错故障 跨度时长精度丢失。
//
// 模块职责：把本地首字耗时记录转换为 OpenTelemetry 跨度，供统一采集链路导出。
// 状态所有权：无状态；输入记录与资源必须由调用方提供，本文件只做映射。
// 阅读顺序：先看属性表与跨度工厂，再读三类跨度产出，最后看覆盖时长合并。
import { createHash } from "node:crypto";
import { SpanKind, SpanStatusCode, TraceFlags, type HrTime } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { LOCAL_TTFT_STAGES, type LocalTtftRecord } from "@zcode/shared";

// record 与 completeRecord 是单条观测记录与对应的完成记录。
// traceId 直接复用观测标识，便于跨系统跳转。
// 属性表在创建跨度前一次算好并复用；上报开关 includeRecord 决定是否产出根跨度；返回顺序必须为根跨度、区间跨度、明细跨度。
export function createLocalTtftSpans(
  record: LocalTtftRecord,
  resource: ReadableSpan["resource"],
  includeRecord: boolean,
  completeRecord: LocalTtftRecord,
): ReadableSpan[] {
  const traceId = record.observationId.replaceAll("-", "");
  const rootId = traceId.slice(0, 16);
  const attributes = Object.fromEntries(
    Object.entries({
      observation_id: record.observationId,
      command_id: record.commandId,
      input_id: record.commandId,
      query_id: record.queryId,
      turn_id: record.turnId,
      product_turn_id: record.productTurnId,
      request_id: record.requestId,
      logical_call_id: record.logicalCallId,
      cli_version: record.cliVersion,
      session_id: record.sessionId,
      cli_instance_id: record.cliInstanceId,
      first_output_kind: record.firstOutputKind,
      model: record.model,
      provider: record.provider,
      quality: record.quality,
      outcome: record.outcome,
      send_mode: record.sendMode ?? "idle",
      visibility: record.visibility ?? "foreground",
      user_wait_ms: record.userWaitMs,
      execution_ms: record.executionMs,
      truncated: String(record.truncated === true),
      timing_reliable: String(record.timingReliable !== false),
      visibility_changes: JSON.stringify(record.visibilityChanges ?? []),
      clock_error_ms: record.clockErrorMs,
      ...(record.kind === "first_output"
        ? {
            unattributed_ms: record.end - record.start - coveredMs(completeRecord),
            missing_stages: LOCAL_TTFT_STAGES.filter(
              (stage) => !completeRecord.intervals.some((interval) => interval.stage === stage),
            ).join(","),
          }
        : {}),
    }).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
  );
  // 根跨度复用根标识，子跨度按内容哈希；哈希输入必须包含名称与附加属性，确保可区分；所有跨度都是内部跨度并标记采样。
  // 时间统一由 hr 转换成 HrTime。
  // 资源与仪表作用域必须由调用方注入。
  const span = (
    name: string,
    start: number,
    end: number,
    root: boolean,
    extra = {},
  ): ReadableSpan => {
    const spanId = root
      ? rootId
      : createHash("sha256")
          .update(`${traceId}:${name}:${JSON.stringify(extra)}`)
          .digest("hex")
          .slice(0, 16);
    return {
      name,
      kind: SpanKind.INTERNAL,
      spanContext: () => ({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }),
      ...(root
        ? {}
        : { parentSpanContext: { traceId, spanId: rootId, traceFlags: TraceFlags.SAMPLED } }),
      startTime: hr(start),
      endTime: hr(end),
      duration: hr(end - start),
      status: { code: SpanStatusCode.UNSET },
      attributes: { ...attributes, ...extra },
      links: [],
      events: [],
      ended: true,
      resource,
      instrumentationScope: { name: "@zcode/local-ttft", version: "1" },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
  };
  return [
    // 只有需要上报记录本身时才产出根跨度；根名称必须按记录类型区分；首次输出记录才标记为根；检查点缺失时必须回退到类型名。
    ...(includeRecord
      ? [
          span(
            record.kind === "first_output" ? "local_ttft" : `local_ttft.${record.kind}`,
            record.start,
            record.end,
            record.kind === "first_output",
            { checkpoint_id: record.checkpointId ?? record.kind },
          ),
        ]
      : []),
    // 每个区间都是根跨度下的子跨度；名称必须带统一前缀便于聚合；时钟来源写入属性以支持可信度分析；区间跨度不参与根标记。
    ...record.intervals.map((interval) =>
      span(`local_ttft.${interval.stage}`, interval.start, interval.end, false, {
        clock_source: interval.source,
      }),
    ),
    ...(record.details ?? []).map((detail) =>
      span(
        `local_ttft.${detail.stage === "attempt" || detail.stage === "retry_wait" || detail.stage === "user_confirmation" ? detail.stage : `prepare.${detail.stage}`}${detail.end === undefined ? ".started" : ""}`,
        detail.start,
        detail.end ?? detail.start,
        false,
        {
          detail_id: detail.id,
          clock_source: detail.source,
          ...(detail.requestId ? { request_id: detail.requestId } : {}),
          ...(detail.logicalCallId ? { logical_call_id: detail.logicalCallId } : {}),
          role: detail.role ?? "preparation",
          detail_outcome: detail.outcome ?? "unclosed",
        },
      ),
    ),
  ];
}
// 区间来源必须包含总区间与已结束的明细；时钟不可信时丢弃非渲染侧区间；所有区间先夹取到总区间内；结束早于开始的区间被过滤；排序后按游标累加，避免重叠重复计数；返回值用于计算未归因时长。
function coveredMs(record: LocalTtftRecord): number {
  const intervals = [
    ...record.intervals,
    ...(record.details ?? []).flatMap((detail) =>
      detail.end === undefined
        ? []
        : [{ start: detail.start, end: detail.end, source: detail.source }],
    ),
  ]
    .filter((interval) => record.quality !== "clock_invalid" || interval.source === "renderer")
    .map((interval) => ({
      start: Math.max(record.start, interval.start),
      end: Math.min(record.end, interval.end),
    }))
    .filter((interval) => interval.end >= interval.start)
    .sort((a, b) => a.start - b.start);
  let covered = 0;
  let end = record.start;
  for (const interval of intervals) {
    if (interval.end > end) covered += interval.end - Math.max(end, interval.start);
    end = Math.max(end, interval.end);
  }
  return covered;
}
function hr(ms: number): HrTime {
  const seconds = Math.floor(ms / 1000);
  return [seconds, Math.floor((ms - seconds * 1000) * 1e6)];
}
