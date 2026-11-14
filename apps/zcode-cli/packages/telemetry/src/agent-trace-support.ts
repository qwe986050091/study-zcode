import {
  context,
  createContextKey,
  createTraceState,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import type {
  AgentTelemetryAbandonReason,
  AgentTelemetryCausation,
  AgentTelemetryExecutionContext,
  AgentTelemetryScope,
} from "@zcode/contracts/telemetry";
import { claimSanitizedTelemetryError } from "./error-sanitizer.js";

const ACTIVE_WRITER_CONTEXT_KEY = createContextKey("@zcode/telemetry/active-writer-v4");
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_ENUM_PATTERN = /^[a-z0-9_./:-]{1,128}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;

/**
 * 单个 writer 在 OTel Context 中登记的运行态快照。
 * 职责：把 Span 与其父 Context、业务关联信息绑定，供 `run` 激活与 causation 提取复用。
 * 输入/输出：由 BaseSpanWriter 构造时写入，读取方通过 `activeWriterContext()` 取回。
 * 副作用：无；对象本身只持有引用，真正的 Context 绑定发生在构造期。
 * 失败语义：`parent` 断开只影响父子链回溯，不影响当前 Span 的终结。
 * 不变量：`activeContext` 必须已 `trace.setSpan` 且携带本对象自身的 KEY 值。
 */
export interface ActiveWriterContext {
  /** 已绑定当前 Span 与父上下文的 OTel Context；`run` 以它为激活底。 */
  activeContext: Context;
  /** 业务执行关联信息（session/turn/actor 等）；缺失时 causation 不携带这些字段，绝不推断默认值。 */
  correlation?: AgentTelemetryExecutionContext;
  /** 上层 writer 快照，用于跨 span 追溯父级状态；缺失表示当前是根 writer。 */
  parent?: ActiveWriterContext;
  /** 当前 writer 持有的活动 Span；所有属性写入与 `end()` 都作用于此。 */
  span: Span;
  /** Span 名称，仅用于健康告警定位，不参与 trace 语义。 */
  spanName: string;
  /** 触发当前 Span 的工具调用标识；非工具场景缺失。 */
  toolCallId?: string;
}

/**
 * telemetry 旁路健康告警配置。
 * 职责：把 Context 激活失败、SDK 抛错等观测侧故障交给调用方记录。
 * 输入：`message` 为稳定英文摘要，`context` 为结构化诊断字段（不含敏感信息）。
 * 失败语义：回调自身抛错会被吞掉，绝不影响业务链路。
 */
export interface WriterHealth {
  /** 可选告警回调；未提供时所有旁路错误静默丢弃，仍保证业务结果原样返回。 */
  onWarning?: (message: string, context: Record<string, unknown>) => void;
}

/**
 * writer 终结时使用的属性键名集合。
 * 职责：让不同 span 类型复用同一套终结逻辑，同时把语义映射推迟到具体 writer 选择。
 * 输入：全部键名均为 OTel 属性名，调用方必须保证非空且互不冲突。
 * 不变量：同一 writer 生命周期内键名固定，禁止运行时变更，否则同一 Span 属性会互相覆盖。
 */
export interface WriterLifecycleKeys {
  /** 放弃原因键；写入 `abandoned` 情形下的结构化枚举。 */
  abandonReason: string;
  /** 取消原因键；仅 `cancelled` 情形写入。 */
  cancelReason: string;
  /** 错误分类键；用于区分失败归属（如 network、validation）。 */
  errorCategory: string;
  /** 错误码键；来自已脱敏错误的稳定 code，缺失时不写。 */
  errorCode: string;
  /** 脱敏后的错误消息键；已移除敏感内容，长度受 `safeString` 上限约束。 */
  errorMessage: string;
  /** 错误类型键；通常是错误 `name` 或构造器类型。 */
  errorType: string;
  /** 失败阶段键；由各 writer 自定义的稳定枚举，表示失败发生在链路哪一步。 */
  failureStage: string;
  /** 终结结论键；取值集合由各 `finish*` 方法决定，并在终结时驱动 Span 结束。 */
  outcome: string;
}

/**
 * 传给 `onTerminal` 的终结观测摘要。
 * 职责：在不对外暴露 Span 的前提下，让上层对终结原因做二次统计。
 * 缺失值语义：字段缺省表示该口径不适用，不代表"未知"或空字符串。
 */
export interface WriterTerminalObservation {
  /** 放弃原因；仅 `abandoned` 终结时存在。 */
  abandonReason?: string;
  /** 已归一化的错误分类；仅 `failed` 终结时存在。 */
  errorCategory?: string;
}

/**
 * 所有 telemetry writer 的公共基类，统一封装 Span 生命周期与业务回调执行。
 * 职责：在业务回调外包一层 OTel Context 激活，并保证 Span 恰好终结一次。
 * 输入：构造时接收 Span、父 Context、causation 元数据与生命周期键名。
 * 输出：`run` 原样返回业务返回值或异常，不改变业务语义。
 * 副作用：写 Span 属性/事件、结束 Span、调用 `onTerminal`，且均经 `safe` 隔离。
 * 失败语义：观测侧异常统一降级为健康告警；telemetry 必须完全旁路业务主链路。
 * 不变量：`ended` 闩锁保证终结幂等，重复 `finish*` 调用不会二次写属性或二次 end。
 */
export abstract class BaseSpanWriter implements AgentTelemetryScope {
  /** 终结闩锁；一旦置位，所有 `finish*` 都退化为空操作。 */
  private ended = false;
  /** 单调时钟起点（毫秒）；用 hrtime 而非墙上时钟，避免系统时间回拨产生负时长。 */
  private readonly startedAtMs = monotonicNowMs();
  /** 对外暴露的上下文快照，供子类写属性与提取 causation。 */
  readonly state: ActiveWriterContext;

  /**
   * 构造 writer 并立即把 Span 绑定进 OTel Context。
   * 输入：`span` 必须尚未结束；`parentContext` 通常是上层 writer 的 activeContext。
   * 副作用：执行 `trace.setSpan` 并写入 Context 私有 KEY，此后 `run` 才能正确激活。
   * 不变量：`state.activeContext` 必须同时包含本 Span 与自身 KEY，避免跨任务串台。
   */
  protected constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    private readonly lifecycle: WriterLifecycleKeys,
    private readonly health: WriterHealth,
    private readonly onTerminal?: (
      outcome: string,
      durationMs: number,
      observation: WriterTerminalObservation,
    ) => void,
  ) {
    this.state = {
      ...metadata,
      activeContext: parentContext,
      span,
    };
    this.state.activeContext = trace
      .setSpan(parentContext, span)
      .setValue(ACTIVE_WRITER_CONTEXT_KEY, this.state);
  }

  /**
   * 提取当前 Span 的可传播 causation，供子任务或下游 span 继承血缘。
   * 输出：SpanContext 无效时返回 `undefined`，调用方应视为"无可继承血缘"。
   * 口径：`isRemote` 缺省按 false 处理；`traceState` 仅在 SpanContext 提供时序列化。
   * 副作用：无，纯读取快照。
   */
  captureCausation(): AgentTelemetryCausation | undefined {
    return causationFromState(this.state);
  }

  /**
   * 在 writer 的 OTel Context 中执行业务回调，并按返回值类型补齐终结语义。
   * 输入：`execute` 至多被执行一次，与 Context 激活是否成功无关。
   * 输出：同步值原样返回；Promise 则透传 resolve/reject，异常对象与调用栈保持不变。
   * 副作用：进入时激活 Context；退出时若 Span 仍打开，则按 abandoned/thrown 兜底终结。
   * 失败语义：激活失败降级为"无 Context"执行；teardown 失败仅在业务已返回值时告警。
   * 不变量：不得重跑业务回调，也不得覆盖已经成功返回的值。
   */
  run<T>(execute: () => T): T {
    // 三个状态位共同保证：回调最多执行一次，且 Context 异常不会引发重跑或吞掉业务异常。
    let entered = false;
    let businessReturned = false;
    let businessValue: T | undefined;
    let businessError: unknown;

    const invokeBusinessOnce = (): T => {
      if (entered) {
        if (businessReturned) return businessValue as T;
        throw businessError;
      }
      entered = true;
      try {
        businessValue = execute();
        businessReturned = true;
        return businessValue;
      } catch (error) {
        businessError = error;
        throw error;
      }
    };

    let value: T;
    try {
      value = context.with(this.state.activeContext, invokeBusinessOnce);
    } catch (error) {
      if (!entered) {
        this.warn("Telemetry context activation failed", error);
        value = invokeBusinessOnce();
      } else if (businessReturned) {
        // Bug 根因：观测 Context Manager 理论上不应在业务返回后抛错；若第三方实现违反
        // 契约，不能因此重跑或覆盖已经成功执行一次的业务回调。
        this.warn("Telemetry context teardown failed", error);
        value = businessValue as T;
      } else {
        this.finishThrownIfOpen(error);
        throw error;
      }
    }

    if (!isPromiseLike(value)) {
      this.finishAbandonedIfOpen("missing_terminal");
      return value;
    }

    return Promise.resolve(value).then(
      (result) => {
        this.finishAbandonedIfOpen("missing_terminal");
        return result;
      },
      (error: unknown) => {
        this.finishThrownIfOpen(error);
        throw error;
      },
    ) as T;
  }

  /**
   * 业务异常且 Span 仍打开时的兜底终结策略，由具体 writer 决定失败阶段与分类。
   * 输入：原始异常对象；实现方必须走脱敏流程，禁止直接把原文写入属性。
   * 调用时机：仅当 `finishThrownIfOpen` 判定 Span 尚未终结时触发。
   */
  protected abstract finishUnhandled(error: unknown): void;

  /**
   * 向 Span 追加事件，属性先经 `compactAttributes` 归一化。
   * 输入：`name` 为稳定事件名；`attributes` 允许含 undefined/非法值，会被静默丢弃。
   * 副作用：写入失败不影响业务，SDK 抛错转为健康告警。
   */
  protected addEvent(name: string, attributes?: Attributes): void {
    this.safe(() => this.state.span.addEvent(name, compactAttributes(attributes ?? {})));
  }

  /**
   * 返回 writer 已存活时长（毫秒），终结时作为 duration 上报。
   * 口径：单调时钟差值，下限截断为 0，避免时钟源异常产生负值。
   */
  protected elapsedMs(): number {
    return Math.max(0, monotonicNowMs() - this.startedAtMs);
  }

  /**
   * 业务未显式终结就归还控制权时的兜底收尾（如漏发 terminal 事件）。
   * 输入：`reason` 为契约枚举，原样写入 abandon 原因属性。
   * 不变量：先抢占终结闩锁，已终结则完全不写属性、不重复 end。
   */
  protected finishAbandonedIfOpen(reason: AgentTelemetryAbandonReason): void {
    if (!this.claimTerminal()) return;
    this.setAttribute(this.lifecycle.outcome, "abandoned");
    this.setAttribute(this.lifecycle.abandonReason, reason);
    this.endSpan("abandoned", { abandonReason: reason });
  }

  /**
   * 以 `cancelled` 结论终结 Span，典型场景是用户取消或 AbortSignal 触发。
   * 口径：`reason` 经 `safeEnum` 归一化，非法字符会整体丢弃而非截断。
   * 不变量：取消原因只用于诊断，不参与成功/失败判定。
   */
  protected finishCancelledIfOpen(reason: string): void {
    if (!this.claimTerminal()) return;
    this.setAttribute(this.lifecycle.outcome, "cancelled");
    this.setAttribute(this.lifecycle.cancelReason, safeEnum(reason));
    this.endSpan("cancelled");
  }

  /**
   * 以 `completed` 结论终结 Span，并把 OTel 状态置为 OK。
   * 输入：`extra` 用于在终结前补写业务属性，其抛错会被 `safe` 吞掉。
   * 副作用：写入顺序固定为 extra → outcome → SpanStatus → end，顺序不可交换。
   */
  protected finishCompletedIfOpen(extra?: () => void): void {
    if (!this.claimTerminal()) return;
    this.safe(extra);
    this.setAttribute(this.lifecycle.outcome, "completed");
    this.safe(() => this.state.span.setStatus({ code: SpanStatusCode.OK }));
    this.endSpan("completed");
  }

  /**
   * 用业务自定义结论终结 Span，适用于既非成功也非失败的领域态（如 skipped、policy_aborted）。
   * 口径：`outcome` 经 `safeEnum` 归一化后既写入属性，也作为 onTerminal 的结论文本。
   * 不变量：不修改 SpanStatus，由调用方自行决定是否标记错误。
   */
  protected finishDomainOutcomeIfOpen(outcome: string, extra?: () => void): void {
    if (!this.claimTerminal()) return;
    this.safe(extra);
    this.setAttribute(this.lifecycle.outcome, safeEnum(outcome));
    this.endSpan(outcome);
  }

  /**
   * 以 `failed` 结论终结 Span，并写入失败阶段、分类以及脱敏后的错误信息。
   * 输入：`stage`/`category` 为稳定枚举；`error` 可为任意值，仅可被脱敏器识别的才落属性。
   * 副作用：SpanStatus 置为 ERROR，随后结束 Span。
   * 不变量：全部失败属性必须在 end 之前写完，否则导出端读取不到。
   */
  protected finishFailedIfOpen(stage: string, category: string, error?: unknown): void {
    if (!this.claimTerminal()) return;
    this.setAttribute(this.lifecycle.outcome, "failed");
    this.setAttribute(this.lifecycle.failureStage, safeEnum(stage));
    this.setAttribute(this.lifecycle.errorCategory, safeEnum(category));
    if (error !== undefined) this.recordSanitizedError(error);
    this.safe(() =>
      this.state.span.setStatus({
        code: SpanStatusCode.ERROR,
      }),
    );
    this.endSpan("failed", { errorCategory: safeEnum(category) });
  }

  /**
   * 判断 Span 是否仍可写入。
   * 口径：仅反映内存闩锁状态，不代表底层 SDK 是否已成功导出。
   */
  protected isOpen(): boolean {
    return !this.ended;
  }

  /**
   * 写入经统一脱敏的异常三元组（type/code/message），并保留 `error.*` 兼容键。
   * 输入：任意异常；脱敏器判定不可用时整体跳过，绝不写入半套字段。
   * 副作用：只写属性，不改变 Span 状态。
   * 不变量：禁止写入原始错误对象或其未脱敏 message，避免敏感内容外泄。
   */
  protected recordSanitizedError(error: unknown): void {
    const sanitized = claimSanitizedTelemetryError(error);
    if (!sanitized) return;
    this.setAttribute(this.lifecycle.errorType, sanitized.type);
    this.setAttribute(this.lifecycle.errorCode, sanitized.code);
    this.setAttribute(this.lifecycle.errorMessage, sanitized.message);
    this.setAttribute("error.type", sanitized.type);
    this.setAttribute("error.message", sanitized.message);
    if (sanitized.cause) {
      this.setAttribute("error.cause.type", sanitized.cause.type);
      this.setAttribute("error.cause.code", sanitized.cause.code);
      this.setAttribute("error.cause.message", sanitized.cause.message);
    }
  }

  /**
   * 归一化并写入单个 Span 属性，非法值静默丢弃。
   * 口径：仅接受 string/number/boolean 及同质数组，其余（对象、undefined、NaN、Infinity）丢弃。
   */
  protected setAttribute(key: string, value: unknown): void {
    const normalized = normalizeAttributeValue(value);
    if (normalized === undefined) return;
    this.safe(() => this.state.span.setAttribute(key, normalized));
  }

  /**
   * 批量写入属性，语义等价于逐个调用 `setAttribute`，丢弃规则完全一致。
   * 注意：不做 key 去重与合并，重复键由后写覆盖先写。
   */
  protected setAttributes(attributes: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value);
  }

  /**
   * 执行观测侧副作用并吞掉异常，是 telemetry 旁路的统一入口。
   * 失败语义：异常转为健康告警，不向上传播，避免阻断业务主链路。
   */
  protected safe(run: (() => void) | undefined): void {
    if (!run) return;
    try {
      run();
    } catch (error) {
      this.warn("Telemetry writer operation failed", error);
    }
  }

  /**
   * 原子抢占终结权；返回 false 表示已被其他路径终结，调用方必须直接返回。
   * 为什么先置位再操作 SDK：即使后续 SDK 调用抛错，也不会留下"未终结却无法再终结"的 Span。
   */
  private claimTerminal(): boolean {
    if (this.ended) return false;
    // 先关闭内存闩锁，再触碰任何 SDK/Adapter；即使后续抛错也不会重复终结。
    this.ended = true;
    return true;
  }

  /**
   * 统一终结出口：先回调 `onTerminal` 上报观测，再结束 Span。
   * 为什么是这个顺序：onTerminal 需要 duration 与 observation，且必须在 Span 关闭前读取。
   */
  private endSpan(outcome: string, observation: WriterTerminalObservation = {}): void {
    const durationMs = this.elapsedMs();
    this.safe(() => this.onTerminal?.(outcome, durationMs, observation));
    this.safe(() => this.state.span.end());
  }

  /**
   * 业务抛错时的终结入口，具体失败阶段与分类委托子类 `finishUnhandled` 决定。
   * 为什么先查 `isOpen`：对已终结 Span 重复写属性会被 SDK 丢弃或报错，只会污染告警。
   */
  private finishThrownIfOpen(error: unknown): void {
    if (!this.isOpen()) return;
    this.finishUnhandled(error);
  }

  /**
   * 上报 telemetry 健康告警，自身异常一并吞掉。
   * 为什么需要内层 try/catch：告警回调来自外部配置，不能成为新的业务失败源。
   */
  private warn(message: string, error: unknown): void {
    try {
      this.health.onWarning?.(message, {
        errorType: error instanceof Error ? error.name : typeof error,
        spanName: this.state.spanName,
      });
    } catch {
      // Telemetry 的健康回调也属于旁路，绝不能覆盖业务返回或异常。
    }
  }
}

/**
 * 从当前活跃 OTel Context 还原最近一次 `run` 绑定的 writer 快照。
 * 输出：当前不在任何 writer 上下文中时返回 `undefined`，调用方需自行降级。
 * 口径：只读取 Context 私有 KEY，不会创建或修复缺失的绑定。
 * 副作用：无。
 */
export function activeWriterContext(): ActiveWriterContext | undefined {
  return context.active().getValue(ACTIVE_WRITER_CONTEXT_KEY) as ActiveWriterContext | undefined;
}

/**
 * 把 writer 快照转换为可序列化的 causation 结构，供跨任务/跨进程继承血缘。
 * 输入：`state` 可为空；空值直接返回 `undefined`。
 * 输出：SpanContext 非法时同样返回 `undefined`，避免传播伪造的 traceId。
 * 口径：`isRemote` 缺省 false；traceState 仅在存在时输出；session/turn/tool 字段取自快照关联信息。
 * 副作用：无，不触发任何 Context 变更。
 */
export function causationFromState(
  state: ActiveWriterContext | undefined,
): AgentTelemetryCausation | undefined {
  if (!state) return undefined;
  const spanContext = state.span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) return undefined;
  return {
    isRemote: spanContext.isRemote ?? false,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceId: spanContext.traceId,
    ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
    sessionId: state.correlation?.sessionId,
    turnId: state.correlation?.turnId,
    toolCallId: state.toolCallId,
  };
}

/**
 * 由显式 causation 构造 OTel Context，作为下游 span 的父上下文。
 * 输入：`causation` 必须来自可信来源；字段缺失会原样带入 SpanContext。
 * 输出：始终基于 ROOT_CONTEXT 构造，不继承调用点的活跃 Context。
 * 副作用：无。
 * 不变量：绝不能以执行时活跃 Context 为底，否则会夹带其他异步任务的 Baggage 或 Writer 私有状态。
 */
export function contextFromCausation(causation: AgentTelemetryCausation): Context {
  // 显式 Causation 只传播保存下来的 SpanContext。不能以执行时碰巧活跃的 Context
  // 为底，否则会把另一个异步任务的 Baggage 或 ZCode Writer 私有状态夹带进来。
  return trace.setSpanContext(ROOT_CONTEXT, spanContextFromCausation(causation));
}

/**
 * 把 causation 中的标识字段还原为 OTel SpanContext。
 * 口径：`traceFlags` 按位原样传递；`traceState` 仅在非空字符串时解析。
 * 失败语义：本函数不校验 traceId/spanId 格式，校验由 `trace.isSpanContextValid` 负责。
 */
export function spanContextFromCausation(causation: AgentTelemetryCausation): SpanContext {
  return {
    isRemote: causation.isRemote,
    spanId: causation.spanId,
    traceFlags: causation.traceFlags,
    traceId: causation.traceId,
    ...(causation.traceState ? { traceState: createTraceState(causation.traceState) } : {}),
  };
}

/**
 * 过滤 OTel 属性表，丢弃归一化失败的键值。
 * 输入：允许含 undefined、NaN、对象以及混合类型数组。
 * 输出：仅保留 string/number/boolean 及其同质数组；即使全被丢弃也返回新对象而非入参引用。
 * 副作用：无，不修改入参对象。
 */
export function compactAttributes(attributes: Attributes): Attributes {
  const compacted: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const normalized = normalizeAttributeValue(value);
    if (normalized !== undefined) compacted[key] = normalized;
  }
  return compacted;
}

/**
 * 生成 `zcode.execution.*` 属性投影，把业务关联信息映射为 span 属性。
 * 输入：`correlation` 缺失时返回空对象；`options` 按开关裁剪敏感维度。
 * 输出：值统一经 `safeId`/`safeEnum`/`safeIdentifier` 归一化，非法值变为 undefined 并被后续写入丢弃。
 * 口径：`includeSession` 同时控制 session、parentSession 与 parentTurn 三个字段；`launchSurface` 始终输出。
 * 副作用：无；返回普通对象，由调用方决定写入时机。
 */
export function executionProjection(
  correlation: AgentTelemetryExecutionContext | undefined,
  options: {
    includeActor?: boolean;
    includeAgent?: boolean;
    includeIdentity?: boolean;
    includeQuery?: boolean;
    includeSession?: boolean;
  } = {},
): Record<string, unknown> {
  if (!correlation) return {};
  return {
    "zcode.execution.session_id": options.includeSession
      ? safeId(correlation.sessionId)
      : undefined,
    "zcode.execution.parent_session_id": options.includeSession
      ? safeId(correlation.parentSessionId)
      : undefined,
    "zcode.execution.turn_id": safeId(correlation.turnId),
    "zcode.execution.parent_turn_id": options.includeSession
      ? safeId(correlation.parentTurnId)
      : undefined,
    "zcode.execution.query_id": options.includeQuery ? safeId(correlation.queryId) : undefined,
    "zcode.execution.actor_kind": options.includeActor
      ? safeEnum(correlation.actorKind)
      : undefined,
    "zcode.execution.agent_name": options.includeAgent
      ? safeIdentifier(correlation.agentName)
      : undefined,
    "zcode.execution.identity_state": options.includeIdentity
      ? safeEnum(correlation.identityState)
      : undefined,
    "zcode.execution.user_subject_id": options.includeIdentity
      ? safeId(correlation.userSubjectId)
      : undefined,
    "zcode.execution.launch_surface": safeEnum(correlation.launchSurface),
  };
}

/**
 * 归一化枚举型属性值：去空白、转小写并按白名单字符集校验。
 * 输出：空值或含非法字符时返回 `undefined`，整体丢弃，不做部分截断。
 */
export function safeEnum(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return SAFE_ENUM_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * 归一化 ID 型属性值：去空白并校验字符集与长度上限（1~128）。
 * 输出：空值、超长或含非法字符时返回 `undefined`，避免污染 trace 查询维度。
 */
export function safeId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && SAFE_ID_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * 归一化标识符型属性值，额外允许 `/` 与 `-`（用于 agent 名等路径式名称）。
 * 口径：先截断到 128 字符再校验；截断后不合法则整体丢弃。
 */
export function safeIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().slice(0, 128);
  return SAFE_IDENTIFIER_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * 清理自由文本：把控制字符与连续空白折叠为单个空格，再按上限截断。
 * 输入：`maxLength` 默认 256，调用方可按字段敏感度收紧。
 * 输出：清理后为空串时返回 `undefined`，与"字段缺失"语义保持一致。
 * 副作用：无，返回新字符串。
 */
export function safeString(value: string | undefined, maxLength = 256): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
  return normalized || undefined;
}

/**
 * 只接受有限且非负的数值作为指标值。
 * 输出：NaN、Infinity、负数与 undefined 一律返回 `undefined`，由调用方跳过该指标而非写入 0。
 */
export function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 只接受安全整数，防止超出 Number 精度后计数失真。
 * 输出：非整数、NaN、Infinity 与 undefined 均返回 `undefined`。
 */
export function integer(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * 判断异常是否属于取消语义（AbortError 或带 `ABORT_ERR` code）。
 * 口径：只看 name/code 等稳定字段，不匹配错误消息文本，避免随文案变化误判。
 * 输出：非 Error 实例一律 false。
 */
export function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    ("code" in error && (error as Error & { code?: unknown }).code === "ABORT_ERR")
  );
}

/**
 * 把任意值收敛为 OTel 可接受的属性类型。
 * 为什么集中在此：非法类型会被 SDK 丢弃或抛错，统一裁决可避免各调用点重复判断并保持口径一致。
 */
function normalizeAttributeValue(
  value: unknown,
): string | number | boolean | string[] | number[] | boolean[] | undefined {
  if (typeof value === "string") return safeString(value, 1_024);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string");
    if (strings.length === value.length) return strings;
    const numbers = value.filter(
      (item): item is number => typeof item === "number" && Number.isFinite(item),
    );
    if (numbers.length === value.length) return numbers;
    const booleans = value.filter((item): item is boolean => typeof item === "boolean");
    if (booleans.length === value.length) return booleans;
    return undefined;
  }
  return undefined;
}

/**
 * 结构化判断 thenable，兼容非原生 Promise 实现。
 * 为什么不用 instanceof Promise：跨 realm 或三方实现会漏判，进而导致终结语义与实际异步性错位。
 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * 单调时钟毫秒值，使用 hrtime 以免系统时间调整影响时长统计。
 * 精度：纳秒转毫秒，返回值可能带小数。
 */
function monotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}
