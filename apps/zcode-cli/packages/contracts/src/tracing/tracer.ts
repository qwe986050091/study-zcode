// ============================================================
// Tracing - Trace context propagation
//
// 生产者：顶层 session 入口创建 root 上下文；turn/step/tool/model 调用逐层派生 child 上下文。
// 消费者：日志（traceContextToLogContext）、模型网络状态事件、遥测 span writer 与 UI 关联。
// 层级不变量：traceId 位于 sessionId 之上——一个 trace 可包含多个 session/subagent/turn；
// spanId 标识当前工作单元，parentSpanId/parentId 指回父 span，三者不可互换。
// 跨异步不变量：任何异步任务、后台队列或子 session 都只能继承 traceId，不得另造；
// 脱离当前上下文时用 ALS 的 run 显式携带，否则该工作单元被视为不可观测。
// ============================================================

import type { QueryId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import { createTraceId } from "../interfaces/shared.js";
import { AsyncLocalStorage } from "async_hooks";
import type { Logger, LogContext } from "../logging/logger.js";

// -----------------------------------------------
// Trace Context
// -----------------------------------------------

/**
 * 跨模块/跨异步传递的追踪上下文：trace 链路的唯一身份事实。
 *
 * 生产者：`createRootTraceContext`（顶部 session/turn 入口）与
 * `createChildTraceContext`/`createSpan`（下游子工作单元）。
 * 消费者：模型状态事件、日志上下文、遥测 writer、V4 投影的关联字段。
 *
 * 不变量：traceId 必须贯穿整条任务链（含重试、子 session、后台任务）；
 * spanId 是当前单元、parentSpanId/parentId 是其父单元，都不能复用别的 span；
 * attributes 只放低敏可序列化键值，跨进程时不能依赖对象引用或函数。
 */
export interface TraceContext {
  traceId: TraceId;
  queryId?: QueryId;
  /** 当前工作单元的 span；为空表示尚未进入具体 span（仍可只靠 traceId 关联）。 */
  spanId?: string;
  /** 父 span 的标准字段，供外部追踪系统还原父子关系。 */
  parentSpanId?: string;
  /** 兼容既有调用链的父引用别名，语义与 parentSpanId 同层，不表示额外层级。 */
  parentId?: string;
  /** 当前 trace 下的会话标识；一个 trace 可有多个 session，不能反向推导 trace。 */
  sessionId?: SessionId;
  /** 当前轮次标识；缺失表示请求尚未绑定到具体 turn（如顶部初始化或后台任务）。 */
  turnId?: TurnId;
  /** 附加的低敏标签；会原样展开进日志上下文，禁止放凭据或用户正文。 */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * 一次执行的工作上下文：追踪 + 日志 + 取消信号的最小组合。
 *
 * 生产者：runtime 在进入 turn/step/tool 时组装并向下传递。
 * 消费者：业务函数用 logger 记录带 traceId 的诊断，用 abortSignal 响应取消。
 * 不变量：`trace` 与 `logger` 必须来自同一条调用链；不允许在中途换 logger 或丢弃
 * abortSignal，否则取消与归因都会断裂。该对象不做持久化。
 */
export interface ExecutionContext {
  trace: TraceContext;
  logger: Logger;
  abortSignal?: AbortSignal;
}

// -----------------------------------------------
// Span (single unit of work within a trace)
// -----------------------------------------------

/**
 * 一个 trace 内的最小工作单元：记录起止、状态、属性与错误。
 *
 * 生产者：`Tracer.startSpan`/`withSpan`/`withSpanAsync` 与 `createSpan`。
 * 消费者：进程内 onSpanEnd 回调（转成日志或外部 trace 导出）。
 * 不变量：end 只生效一次（重复 end 不覆盖首次结果）；status 由是否传入 error 决定，
 * 而不是由调用方自定义；spanId 一经创建不可变，父子关系只由 parentId 表达。
 */
export interface Span {
  readonly traceId: TraceId;
  readonly spanId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: Date;
  endTime?: Date;
  attributes: Record<string, string | number | boolean>;
  status: "running" | "completed" | "error";
  error?: Error;

  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: Record<string, string | number | boolean>): void;
  end(error?: Error): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
}

/**
 * Span 的进程内实现：只做内存态记录，外部导出完全交给 onEnd 回调。
 *
 * 生产者：Tracer 构造，traceId 来自父上下文或新建。
 * 消费者：调用方读取 attributes/status；onEnd 在首次 end 时消费快照。
 * 不变量：onEnd 至多触发一次；endTime 只在结束时写入，未结束的 span 不能被导出为完成；
 * `addEvent` 目前不解构参数，仅为契约占位，不应被业务误认为已落库。
 */
class SpanImpl implements Span {
  readonly traceId: TraceId;
  readonly spanId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: Date;
  endTime?: Date;
  attributes: Record<string, string | number | boolean>;
  status: "running" | "completed" | "error" = "running";
  error?: Error;

  private onEnd?: (span: Span) => void;

  constructor(name: string, traceId: TraceId, parentId?: string, onEnd?: (span: Span) => void) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = generateSpanId();
    this.parentId = parentId;
    this.startTime = new Date();
    this.attributes = {};
    this.onEnd = onEnd;
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  setAttributes(attributes: Record<string, string | number | boolean>): void {
    Object.assign(this.attributes, attributes);
  }

  end(error?: Error): void {
    if (this.status !== "running") return;
    this.endTime = new Date();
    if (error) {
      this.status = "error";
      this.error = error;
    } else {
      this.status = "completed";
    }
    this.onEnd?.(this);
  }

  addEvent(_name: string, _attributes?: Record<string, string | number | boolean>): void {
    // Could emit events for external tracing systems
  }
}

/**
 * 生成 16 字符的 span 短标识（UUID 前 16 位）。
 *
 * 生产者：SpanImpl 构造与 root/child 上下文创建。
 * 消费者：parentSpanId/parentId 关联与日志投影。
 * 不变量：只保证进程内高概率唯一，不是全局有序 ID；不得用时间或递增序号替代，
 * 否则并发链路会碰撞。长度固定为 16，供外部追踪系统按短 ID 解析。
 */
function generateSpanId(): string {
  return crypto.randomUUID().slice(0, 16);
}

// -----------------------------------------------
// Tracer
// -----------------------------------------------

/**
 * Tracer 端口：按名称创建 span，并提供同步/异步的自动收尾包装。
 *
 * 生产者：bootstrap 或各模块用 `createTracer(name, onSpanEnd)` 构造。
 * 消费者：业务用 withSpan/withSpanAsync 包裹一次工作单元，避免漏掉 end。
 * 不变量：withSpan* 必须在成功时 end、异常时 end(error) 后原样抛出，
 * 不得吞错；父上下文缺省时取 ALS 当前上下文，都没有才新建 trace。
 */
export interface Tracer {
  readonly name: string;
  startSpan(name: string, parentContext?: TraceContext): Span;
  withSpan<T>(name: string, fn: (span: Span) => T, parentContext?: TraceContext): T;
  withSpanAsync<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parentContext?: TraceContext,
  ): Promise<T>;
}

/**
 * 创建一个轻量 Tracer 实例：span 全部在内存中记录，结束时回调 onSpanEnd。
 *
 * 生产者：各模块初始化时调用（name 仅用于标识 tracer 类别）。
 * 消费者：业务 withSpan* 包装与 `createSpan` 的 ALS 兜底路径。
 * 不变量：parentContext 提供 traceId 时复用，不新建 trace；parentId 优先取
 * parentContext.spanId，退化到 parentSpanId（兼容只带父 span 的旧上下文）。
 * onSpanEnd 抛错不会改变业务返回值（它在 end 内部被调用，调用方已持有结果）。
 */
export function createTracer(name: string, onSpanEnd?: (span: Span) => void): Tracer {
  return {
    name,
    startSpan(name: string, parentContext?: TraceContext): Span {
      const traceId = parentContext?.traceId ?? (createTraceId() as TraceId);
      return new SpanImpl(
        name,
        traceId,
        parentContext?.spanId ?? parentContext?.parentSpanId,
        onSpanEnd,
      );
    },
    withSpan<T>(name: string, fn: (span: Span) => T, parentContext?: TraceContext): T {
      const span = this.startSpan(name, parentContext);
      try {
        const result = fn(span);
        span.end();
        return result;
      } catch (error) {
        span.end(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    withSpanAsync<T>(
      name: string,
      fn: (span: Span) => Promise<T>,
      parentContext?: TraceContext,
    ): Promise<T> {
      const span = this.startSpan(name, parentContext);
      return fn(span).then(
        (result) => {
          span.end();
          return result;
        },
        (error) => {
          span.end(error instanceof Error ? error : new Error(String(error)));
          throw error;
        },
      );
    },
  };
}

// -----------------------------------------------
// Async Local Storage for Context Propagation
// -----------------------------------------------

/**
 * 进程内追踪上下文的 AsyncLocalStorage 槽位：模块私有，只能经由下面两个函数读写。
 *
 * 生产者：`runWithContext`/`runWithContextAsync` 写入。
 * 消费者：`getCurrentTraceContext` 与 `createSpan` 读取；业务不应直接访问 `_storage`。
 * 不变量：store 是整条异步链共享引用；并发任务各自 run 互不串扰（ALS 按异步上下文隔离）。
 */
const _storage = new AsyncLocalStorage<TraceContext>();

/**
 * 读取当前异步链上的追踪上下文；未包裹时返回 undefined。
 *
 * 生产者：ALS 当前 store。
 * 消费者：`createSpan` 的父上下文回退，以及需要补全日志/事件字段的模块。
 * 不变量：undefined 表示“当前不在任何追踪作用域”，此时新建 span 会启用新 trace；
 * 调用方不得把 undefined 当作空 traceId 传给下游持久化。
 */
export function getCurrentTraceContext(): TraceContext | undefined {
  return _storage.getStore();
}

/**
 * 在指定追踪上下文中同步执行回调：用于把父级 trace 显式带入子调用。
 *
 * 生产者：入口层、子 session/subagent 创建处、后台任务调度处。
 * 消费者：回调用 getCurrentTraceContext / createSpan 读取同一 traceId。
 * 不变量：只影响本回调及其异步派生；回调返回后槽位恢复原值，不污染外层链路。
 */
export function runWithContext<T>(context: TraceContext, fn: () => T): T {
  return _storage.run(context, fn);
}

/**
 * 异步版本的上下文包裹：保证 await 之后仍能读到同一 trace。
 *
 * 生产者：需要跨 I/O、模型调用或队列的异步流程入口。
 * 消费者：异步链中的日志、span 与状态事件。
 * 不变量：这里直接返回 ALS.run 的 Promise，不额外包 then；因此 reject 会原样传播，
 * 且后续 await 的派生异步任务仍继承该 store。
 */
export async function runWithContextAsync<T>(
  context: TraceContext,
  fn: () => Promise<T>,
): Promise<T> {
  return _storage.run(context, fn);
}

// -----------------------------------------------
// Convenience: create span from current context
// -----------------------------------------------

/**
 * 从当前 ALS 上下文创建 span：当前无上下文时新建 trace，有则复用 traceId 与父 span。
 *
 * 生产者：未持有显式 TraceContext 的模块（工具内部调用、临时诊断）。
 * 消费者：进程内 onSpanEnd 导出与日志关联。
 * 不变量：返回的 span 不自动 end，调用方必须显式收尾；父引用只取 spanId 或
 * parentSpanId，不会把 sessionId/turnId 当作父级。
 */
export function createSpan(name: string): Span {
  const currentContext = getCurrentTraceContext();
  const traceId = currentContext?.traceId ?? (createTraceId() as TraceId);
  return new SpanImpl(name, traceId, currentContext?.spanId ?? currentContext?.parentSpanId);
}

/**
 * 创建 root 追踪上下文：一次顶层任务（session/command）的链路起点。
 *
 * 生产者：CLI/desktop host 的入口、子 session 需要独立链路时（通常不这么做）。
 * 消费者：向下派生的所有 child 上下文、模型状态事件与日志。
 * 不变量：可传入既有 traceId 以延续外部链路（如跨进程恢复）；未传则新建。
 * spanId 在此生成，parentSpanId 保持为空——root 就是没有父 span；
 * sessionId/turnId 只是关联字段，不会改变 root 语义。
 */
export function createRootTraceContext(
  options: {
    traceId?: TraceId;
    queryId?: QueryId;
    sessionId?: SessionId;
    turnId?: TurnId;
    attributes?: Record<string, string | number | boolean>;
  } = {},
): TraceContext {
  return {
    traceId: options.traceId ?? createTraceId(),
    queryId: options.queryId,
    spanId: generateSpanId(),
    sessionId: options.sessionId,
    turnId: options.turnId,
    attributes: options.attributes,
  };
}

/**
 * 从父上下文派生 child 上下文：沿用 traceId，生成新 spanId 并指回父 span。
 *
 * 生产者：turn/step/tool/model 调用等需要独立观测粒度的下游入口。
 * 消费者：下游日志、状态事件与遥测 span。
 * 不变量：traceId 必须原样继承，不允许在子调用中换 trace；
 * queryId/sessionId/turnId 未显式给出时继承父值（表示仍在同一轮/同一会话），
 * attributes 做浅合并且子值覆盖父值，但父对象本身不被修改。
 */
export function createChildTraceContext(
  parent: TraceContext,
  options: {
    queryId?: QueryId;
    sessionId?: SessionId;
    turnId?: TurnId;
    attributes?: Record<string, string | number | boolean>;
  } = {},
): TraceContext {
  return {
    traceId: parent.traceId,
    queryId: options.queryId ?? parent.queryId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    parentId: parent.spanId,
    sessionId: options.sessionId ?? parent.sessionId,
    turnId: options.turnId ?? parent.turnId,
    attributes: {
      ...parent.attributes,
      ...options.attributes,
    },
  };
}

/**
 * 把追踪上下文摊平成日志上下文字段：供 logger 直接展开进 LogEntry。
 *
 * 生产者：core 的日志调用点（通过 deps 转出）。
 * 消费者：Logger 实现的 context 合并与落盘。
 * 不变量：固定键（traceId/queryId/spanId/parentSpanId/sessionId/turnId）优先，
 * attributes 随后展开——同名的 attributes 会覆盖固定键，因此 attributes 不得使用
 * 这些保留名；这里不生成 message/level 等日志内容字段。
 */
export function traceContextToLogContext(context: TraceContext): LogContext {
  return {
    traceId: context.traceId,
    queryId: context.queryId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    ...context.attributes,
  };
}
