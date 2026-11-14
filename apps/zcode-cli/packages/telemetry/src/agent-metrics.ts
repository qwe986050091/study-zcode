/**
 * Agent 运行期指标（Metric）记录层。
 *
 * 职责：把 span 终态、模型尝试细节、命令首字节延迟等事实写成 OTel Counter/Histogram，
 * 供聚合看板使用；Trace 负责的可追溯性不在这里重复。
 * 输入口径：所有标签来自调用方已归一化的 Attributes，本层只做「白名单过滤 + 稀疏裁剪」。
 * 输出口径：时长统一以秒为单位写入（入参毫秒在此除以 1000），计数用 Counter.add。
 * 失败语义：记录方法不抛错；非法 delta（NaN/负数）、缺失的计时点直接跳过而不补 0。
 * 不变量：Metric 永不接收高基数执行 ID 或原始业务内容，否则系列基数会失控。
 */

import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";

/** 允许产生时长/终态指标的逻辑跨度集合；后续新增需同时在 TERMINAL_LABELS 中登记标签白名单。 */
export type AgentMetricSpanName =
  | "agent_turn"
  | "agent_step"
  | "tool_execution"
  | "command_execution"
  | "context_compaction"
  | "detached_operation"
  | "model_call"
  | "model_attempt";

/** 模型 token 计费维度：区分缓存读写与推理 token，避免把不同单价的口径合并成一个计数。 */
export type ModelTokenType = "input" | "output" | "reasoning" | "cache_read" | "cache_write";

/**
 * 指标记录器契约。
 *
 * 实现方可能是真实 OTel Meter，也可能是 NOOP 桩；调用方只按接口调用，不关心后端是否启用。
 * 所有方法均为「尽力而为」：不得抛出异常影响主流程，缺失字段时跳过对应记录。
 */
export interface AgentTelemetryMetricRecorder {
  recordCommandFirstOutput(durationMs: number, labels: Attributes): void;
  recordCreationDrop(spanName: AgentMetricSpanName, reason: "process_capacity" | "unknown"): void;
  recordModelAttemptDetail(
    labels: Attributes,
    detail: {
      firstContentMs?: number;
      firstProviderEventMs?: number;
      firstTextMs?: number;
      stallCount: number;
      streamMaxIdleMs: number;
    },
  ): void;
  recordModelCallAttempts(attemptCount: number, labels: Attributes): void;
  recordModelTokenDelta(tokenType: ModelTokenType, delta: number, labels: Attributes): void;
  recordSpanTerminal(
    spanName: AgentMetricSpanName,
    outcome: string,
    durationMs: number,
    labels: Attributes,
    abandonReason?: string,
  ): void;
}

/**
 * Metric 只接收已归一化、低基数的标签。高基数执行 ID 和原始业务内容只属于 Trace，
 * 不能通过这个边界进入 Metric Series。
 *
 * 构造副作用：在传入的 Meter 上注册全部仪器（Counter/Histogram），因此同一 Meter 重复构造
 * 会得到重复注册的同名仪器；本类应在进程内单例化。
 * 不变量：所有写入都把毫秒换算为秒；标签一律经 allowMetricAttributes 过滤后才落到 Series。
 */
export class OtelAgentTelemetryMetrics implements AgentTelemetryMetricRecorder {
  private readonly abandoned: Counter;
  private readonly commandFirstOutput: Histogram;
  private readonly creationDrop: Counter;
  private readonly durations: Record<AgentMetricSpanName, Histogram>;
  private readonly modelAttemptFirstContent: Histogram;
  private readonly modelAttemptFirstProviderEvent: Histogram;
  private readonly modelAttemptFirstText: Histogram;
  private readonly modelAttemptStreamMaxIdle: Histogram;
  private readonly modelAttemptStreamStalls: Counter;
  private readonly modelCallAttempts: Histogram;
  private readonly modelTokens: Counter;

  /**
   * 注册全部指标仪器。
   *
   * 输入：meter 由 telemetry bootstrap 提供，代表当前进程的指标后端。
   * 副作用：向后端声明命名、描述与单位；这些元数据一旦注册即固定，改名等于产生新的 Series。
   * 失败语义：注册本身不返回错误；后端未启用时 OTel 会返回 NOOP 仪器，写入自动丢弃。
   */
  constructor(meter: Meter) {
    this.durations = {
      agent_turn: duration(meter, "zcode.agent.turn.duration"),
      agent_step: duration(meter, "zcode.agent.step.duration"),
      tool_execution: duration(meter, "zcode.tool.execution.duration"),
      command_execution: duration(meter, "zcode.command.execution.duration"),
      context_compaction: duration(meter, "zcode.context.compaction.duration"),
      detached_operation: duration(meter, "zcode.detached.operation.duration"),
      model_call: duration(meter, "zcode.model.call.duration"),
      model_attempt: duration(meter, "zcode.model.attempt.duration"),
    };
    this.modelCallAttempts = meter.createHistogram("zcode.model.call.attempts", {
      description: "Physical provider attempts per logical model call",
      unit: "{attempt}",
    });
    this.modelTokens = meter.createCounter("zcode.model.attempt.tokens", {
      description: "Observed provider token delta by token type",
      unit: "{token}",
    });
    this.modelAttemptFirstProviderEvent = duration(
      meter,
      "zcode.model.attempt.time_to_first_provider_event",
    );
    this.modelAttemptFirstContent = duration(meter, "zcode.model.attempt.time_to_first_content");
    this.modelAttemptFirstText = duration(meter, "zcode.model.attempt.time_to_first_text");
    this.modelAttemptStreamStalls = meter.createCounter("zcode.model.attempt.stream_stall.count", {
      description: "Observed stream stalls",
      unit: "{stall}",
    });
    this.modelAttemptStreamMaxIdle = duration(meter, "zcode.model.attempt.stream_max_idle");
    this.commandFirstOutput = duration(meter, "zcode.command.execution.time_to_first_output");
    this.creationDrop = meter.createCounter("zcode.telemetry.creation_drop.count", {
      description: "Spans rejected before creation by runtime capacity protection",
      unit: "{span}",
    });
    this.abandoned = meter.createCounter("zcode.telemetry.abandoned.count", {
      description: "Spans closed as abandoned",
      unit: "{span}",
    });
  }

  /**
   * 记录一次 span（或逻辑跨度）的终态。
   *
   * 输入：durationMs 为跨度从创建到关闭的真实毫秒数；outcome 为归一化终态；
   * abandonReason 只在 outcome === "abandoned" 时写入放弃计数标签。
   * 输出：写入 spanName 对应的时长直方图（单位秒）。
   * 失败语义：不抛错；未知标签被白名单丢弃，不污染 Series。
   * 不变量：outcome 恒定参与标签，保证成功与失败可分开聚合。
   */
  recordSpanTerminal(
    spanName: AgentMetricSpanName,
    outcome: string,
    durationMs: number,
    labels: Attributes,
    abandonReason?: string,
  ): void {
    // 终态必须进标签，否则同一跨度的成功/失败时长会被聚合成一条 Series；白名单外的标签直接丢弃。
    const terminalLabels = allowMetricAttributes({ ...labels, outcome }, TERMINAL_LABELS[spanName]);
    this.durations[spanName].record(durationMs / 1_000, terminalLabels);
    if (outcome === "abandoned") {
      this.abandoned.add(
        1,
        allowMetricAttributes(
          {
            abandon_reason: abandonReason,
            span_name: spanName,
          },
          ["abandon_reason", "span_name"],
        ),
      );
    }
  }

  /**
   * 记录「因运行时容量保护而未创建」的 span。
   *
   * 输入：reason 区分进程容量上限（process_capacity）与未知原因（unknown），
   * 便于区分「主动限流」和「异常失败」。
   * 输出：累加 creation_drop 计数，标签固定为 drop_reason + span_name（均为低基数）。
   * 失败语义：纯计数，不抛错。
   */
  recordCreationDrop(spanName: AgentMetricSpanName, reason: "process_capacity" | "unknown"): void {
    this.creationDrop.add(1, {
      drop_reason: reason,
      span_name: spanName,
    });
  }

  /**
   * 记录一次逻辑模型调用消耗的物理尝试次数。
   *
   * 输入：attemptCount 为最终尝试次数（含重试），labels 需已归一化。
   * 输出：写入 attempts 直方图，用于观察重试放大系数。
   * 失败语义：不抛错；标签经白名单裁剪后才写入。
   */
  recordModelCallAttempts(attemptCount: number, labels: Attributes): void {
    this.modelCallAttempts.record(attemptCount, allowMetricAttributes(labels, MODEL_CALL_LABELS));
  }

  /**
   * 记录模型 token 增量。
   *
   * 输入：delta 为本次观测到的增量（非累计值）；tokenType 决定计费口径。
   * 输出：在 token 计数器中按 token_type 累加。
   * 失败语义：delta 非有限数或 ≤ 0 时静默跳过——provider 流式数据可能重复上报或给 0，
   * 写入负数会破坏单调递增的计数器语义。
   */
  recordModelTokenDelta(tokenType: ModelTokenType, delta: number, labels: Attributes): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.modelTokens.add(
      delta,
      allowMetricAttributes(
        {
          ...labels,
          token_type: tokenType,
        },
        MODEL_TOKEN_LABELS,
      ),
    );
  }

  /**
   * 记录单次模型尝试的流式细节。
   *
   * 输入：三个 first*Ms 是相对尝试开始的毫秒偏移，未发生时保持 undefined 而不是 0；
   * stallCount / streamMaxIdleMs 描述流式停顿数量与最长空闲。
   * 输出：逐项写入首事件/首内容/首文本延迟直方图；仅 stallCount > 0 时写入停顿计数与最大空闲。
   * 失败语义：缺失计时点跳过而不补 0，避免把「未发生」误统计成「瞬时」。
   * 不变量：调用方不得用 0 表示「未发生」，否则延迟分布会被污染。
   */
  recordModelAttemptDetail(
    labels: Attributes,
    detail: {
      firstContentMs?: number;
      firstProviderEventMs?: number;
      firstTextMs?: number;
      stallCount: number;
      streamMaxIdleMs: number;
    },
  ): void {
    // 缺失计时点直接跳过，不补 0；停顿只在 >0 时记录，避免「无停顿」在直方图中产生 0 值样本。
    const safeLabels = allowMetricAttributes(labels, MODEL_ATTEMPT_LABELS);
    if (detail.firstProviderEventMs !== undefined) {
      this.modelAttemptFirstProviderEvent.record(detail.firstProviderEventMs / 1_000, safeLabels);
    }
    if (detail.firstContentMs !== undefined) {
      this.modelAttemptFirstContent.record(detail.firstContentMs / 1_000, safeLabels);
    }
    if (detail.firstTextMs !== undefined) {
      this.modelAttemptFirstText.record(detail.firstTextMs / 1_000, safeLabels);
    }
    if (detail.stallCount > 0) {
      // 停顿计数与最长空闲成对记录：只看次数无法区分「偶发长停顿」和「连续小停顿」。
      this.modelAttemptStreamStalls.add(detail.stallCount, safeLabels);
      this.modelAttemptStreamMaxIdle.record(detail.streamMaxIdleMs / 1_000, safeLabels);
    }
  }

  /**
   * 记录命令从启动到首字节输出的延迟。
   * 输入：durationMs 为真实毫秒；labels 已含命令类别与安全化名称（不含原始命令文本）。
   * 输出：写入 time_to_first_output 直方图。
   * 失败语义：不抛错；标签白名单外的字段被丢弃。
   */
  recordCommandFirstOutput(durationMs: number, labels: Attributes): void {
    this.commandFirstOutput.record(
      durationMs / 1_000,
      allowMetricAttributes(labels, COMMAND_LABELS),
    );
  }
}

/**
 * 空实现：telemetry 未启用或初始化失败时的默认记录器。
 * 所有方法都是无副作用空函数，保证调用方无需判空即可调用；不得在此偷偷写日志，否则会形成噪声。
 */
export const NOOP_AGENT_TELEMETRY_METRICS: AgentTelemetryMetricRecorder = {
  recordCommandFirstOutput() {},
  recordCreationDrop() {},
  recordModelAttemptDetail() {},
  recordModelCallAttempts() {},
  recordModelTokenDelta() {},
  recordSpanTerminal() {},
};

/** 统一创建「秒」为单位的时长直方图；描述由指标名生成，避免各处手写描述造成口径漂移。 */
function duration(meter: Meter, name: string): Histogram {
  return meter.createHistogram(name, {
    description: `${name} in seconds`,
    unit: "s",
  });
}

// 标签白名单：每个指标只允许固定的一组低基数标签，新增标签必须同时登记在这里，
// 否则会在 allowMetricAttributes 里被静默丢弃（这是刻意的防高基数护栏）。
const COMMON_TERMINAL_LABELS = ["error_category", "outcome"] as const;
const MODEL_CALL_LABELS = [
  ...COMMON_TERMINAL_LABELS,
  "call_cause",
  "model_operation",
  "model_role",
  "retry_state",
] as const;
const MODEL_ATTEMPT_LABELS = [
  ...COMMON_TERMINAL_LABELS,
  "model",
  "model_operation",
  "model_role",
  "provider_kind",
  "transport",
] as const;
const MODEL_TOKEN_LABELS = [
  "model",
  "model_operation",
  "model_role",
  "provider_kind",
  "token_type",
  "transport",
] as const;
const COMMAND_LABELS = [
  ...COMMON_TERMINAL_LABELS,
  "command_category",
  "command_safe_name",
] as const;

const TERMINAL_LABELS: Record<AgentMetricSpanName, readonly string[]> = {
  agent_turn: [...COMMON_TERMINAL_LABELS, "actor_kind", "input_source", "launch_surface"],
  agent_step: [...COMMON_TERMINAL_LABELS, "actor_kind", "terminal_reason"],
  tool_execution: [...COMMON_TERMINAL_LABELS, "tool_name"],
  command_execution: COMMAND_LABELS,
  context_compaction: [...COMMON_TERMINAL_LABELS, "model_mode", "trigger"],
  detached_operation: [...COMMON_TERMINAL_LABELS, "execution_kind", "operation"],
  model_call: MODEL_CALL_LABELS,
  model_attempt: MODEL_ATTEMPT_LABELS,
};

/**
 * 按白名单裁剪指标标签。
 *
 * 口径：只保留 allowed 中的键；值为 undefined 或空字符串时视为缺失并丢弃。
 * 返回值是新的普通对象，不会回写调用方传入的 Attributes。
 * 失败语义：不抛错；非字符串的非空值（数字/布尔）原样透传，交由 OTel 决定如何编码。
 */
function allowMetricAttributes(attributes: Attributes, allowed: readonly string[]): Attributes {
  const result: Attributes = {};
  for (const key of allowed) {
    const value = attributes[key];
    if (value !== undefined && (typeof value !== "string" || value.length > 0)) {
      result[key] = value;
    }
  }
  return result;
}
