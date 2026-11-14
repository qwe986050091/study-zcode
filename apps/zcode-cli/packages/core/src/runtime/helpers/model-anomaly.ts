import type { ModelAnomalyGuardConfig, ModelToolCall, ToolCallId } from "../deps.js";

/**
 * 一次 turn 内的"异常告警账本"（纯内存态，随 RegularTurnLoopState 存活）。
 * 本文件不落盘、不发事件：告警事件与 reminder 注入由 methods/turn-tool-warnings.ts
 * 依据本文件的返回值完成，从而把"判定"与"副作用"分离。
 */
interface RepeatedToolCallWarningState {
  /**
   * 本 turn 已实际注入的告警条数（两种告警共用同一个预算）。
   * 达到 modelAnomalyGuard.maxBudgetWarningsPerTurn 后不再注入，但仍继续产出
   * observation（warningInjected=false），让遥测能看到"被限流"的命中次数。
   */
  anomalyWarningsInjected: number;
  /** 最近一次工具调用的签名；undefined 表示本 turn 尚未出现工具调用。 */
  repeatedToolCallSignature?: string;
  /** 与 signature 连续相同的次数；签名一变即重置为 1，不跨 turn 累计。 */
  repeatedToolCallStreakCount: number;
}

/**
 * 一次"重复工具调用"命中结果。只在连续次数恰好等于阈值的那一刻产生，
 * 因此同一段 streak 只会告警一次，后续再重复只增加 count 不再产生新告警。
 */
interface RepeatedToolCallWarningObservation {
  /** 命中时的连续次数；正常等于 threshold（阈值 <= 0 时根本不会命中）。 */
  observedCount: number;
  /** 生效阈值：config.repeatedToolCallWarningThreshold ?? 3。 */
  threshold: number;
  /** 触发本次命中的 toolCall id，供告警事件定位到具体调用。 */
  toolCallId: ToolCallId;
  /** 原始工具名（未做别名归一化），与模型返回保持一致。 */
  toolName: string;
  /** 是否真的把 reminder 注入模型上下文；false 表示被 per-turn 预算限流。 */
  warningInjected: boolean;
}

/**
 * 工具调用总量"越过阈值"那一步的结果；只在跨过阈值的那一批调用产生一次，
 * 之后继续调用不会再产生新条目（避免每一批都重复提醒）。
 */
interface ToolCallBudgetWarningObservation {
  /** 本批执行后本 turn 累计工具调用数（已含本批）。 */
  observedCount: number;
  /** 生效阈值：config.toolCallWarningThreshold；未配置时永不告警。 */
  threshold: number;
  /** 是否真的注入了 reminder（受 maxBudgetWarningsPerTurn 约束）。 */
  warningInjected: boolean;
}

/**
 * 扫描一批模型返回的 toolCalls，更新连续重复账本并返回"恰好命中阈值"的告警。
 *
 * 输入：本批 toolCalls（顺序即模型返回顺序）、turn 级 state（会被就地修改）、
 *   config（partial，缺省阈值 3）。
 * 输出：0..n 条 observation；每条自带 warningInjected，调用方据此决定是否注入 reminder。
 * 副作用：只写 state 三个字段，不 emit、不落盘、不抛错。
 * 失败/降级：threshold<=0 视为关闭，直接返回空数组且不改 state。
 * 不变量：streak 只在签名变化时重置；告警预算由调用方与 budget 判定共用。
 */
export function detectRepeatedToolCallWarnings(
  toolCalls: readonly ModelToolCall[],
  state: RepeatedToolCallWarningState,
  config: Partial<ModelAnomalyGuardConfig> | undefined,
): RepeatedToolCallWarningObservation[] {
  const threshold = config?.repeatedToolCallWarningThreshold ?? 3;
  const maxBudgetWarningsPerTurn = config?.maxBudgetWarningsPerTurn ?? 3;
  if (threshold <= 0) return [];

  const observations: RepeatedToolCallWarningObservation[] = [];

  for (const toolCall of toolCalls) {
    const signature = buildRepeatedToolCallSignature(toolCall.name, toolCall.input);
    if (state.repeatedToolCallSignature === signature) {
      state.repeatedToolCallStreakCount += 1;
    } else {
      state.repeatedToolCallSignature = signature;
      state.repeatedToolCallStreakCount = 1;
    }

    // 只认"恰好等于"阈值：>= 会让同一段 streak 在每次追加后重复告警。
    if (state.repeatedToolCallStreakCount !== threshold) {
      continue;
    }

    const warningInjected = state.anomalyWarningsInjected < maxBudgetWarningsPerTurn;
    if (warningInjected) {
      state.anomalyWarningsInjected += 1;
    }

    observations.push({
      observedCount: state.repeatedToolCallStreakCount,
      threshold,
      toolCallId: toolCall.id as ToolCallId,
      toolName: toolCall.name,
      warningInjected,
    });
  }

  return observations;
}

/**
 * 判断本批工具调用是否"跨过"累计阈值，并返回一次性告警。
 *
 * 输入口径：currentToolCallCount 是已含本批的累计值，newToolCallCount 是本批数量，
 *   因此 previous = current - new；只有 previous < threshold <= current 才算跨过，
 *   首次请求即超阈值（previous 也为 0 且 current 已过线）同属跨过。
 * 输出：undefined 表示未配置阈值或未跨线；否则一条 observation。
 * 副作用：可能给 state.anomalyWarningsInjected 加 1，不 emit、不落盘。
 * 降级：threshold 未配置/<=0 时静默关闭，不影响主循环。
 */
export function detectToolCallBudgetWarning(
  currentToolCallCount: number,
  newToolCallCount: number,
  state: RepeatedToolCallWarningState,
  config: Partial<ModelAnomalyGuardConfig> | undefined,
): ToolCallBudgetWarningObservation | undefined {
  const threshold = config?.toolCallWarningThreshold;
  if (threshold === undefined || threshold <= 0) {
    return undefined;
  }

  const previousToolCallCount = currentToolCallCount - newToolCallCount;
  if (previousToolCallCount >= threshold || currentToolCallCount < threshold) {
    return undefined;
  }

  const maxBudgetWarningsPerTurn = config?.maxBudgetWarningsPerTurn ?? 3;
  const warningInjected = state.anomalyWarningsInjected < maxBudgetWarningsPerTurn;
  if (warningInjected) {
    state.anomalyWarningsInjected += 1;
  }

  return {
    observedCount: currentToolCallCount,
    threshold,
    warningInjected,
  };
}

/**
 * 生成"重复调用"的模型可见 reminder 文案（英文，作为 system reminder 附件注入）。
 * 纯函数：无状态、无 I/O；文案保持稳定，测试与 UI 快照依赖它。
 */
export function buildRepeatedToolCallReminderBody(
  toolName: string,
  observedCount: number,
): string {
  return [
    `You have called ${toolName} with the same input ${observedCount} times in a row.`,
    "Do not repeat the exact same tool call again unless the user explicitly asked you to retry it unchanged.",
    "Use the existing result to take a different next step, explain the blocker, or ask the user for guidance.",
  ].join("\n");
}

/**
 * 生成"工具调用总量过高"的模型可见 reminder 文案。纯函数，与重复调用文案分开，
 * 便于模型区分"同参重复"与"调用过多"两种干预。
 */
export function buildToolCallBudgetReminderBody(observedCount: number): string {
  return [
    `This turn has already made ${observedCount} tool calls.`,
    "Do not keep calling tools reflexively. Use the gathered results to choose a different next step, summarize the blocker, or ask the user for guidance if you are stuck.",
  ].join("\n");
}

/**
 * 用"工具名 + 稳定化 JSON(入参)"构造签名。键序不稳定会让语义相同的入参被判成
 * 不同调用，从而漏掉重复告警，因此 stableJson 必须递归排序对象键。
 */
function buildRepeatedToolCallSignature(toolName: string, input: unknown): string {
  return `${JSON.stringify(toolName)}:${stableJson(input)}`;
}

/**
 * 递归序列化：对象按键名排序、数组保序，保证同一语义对象得到唯一字符串。
 * 只用于比较，不做类型校验；undefined 显式落成 "undefined" 以避免丢字段。
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
