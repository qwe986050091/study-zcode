// renderer action trace broker：接收 renderer 上送的动作 trace 批次，做体积与 schema 准入后转投 OTel exporter
// 边界：只管排队、背压、超时与关闭顺序，不解析业务语义，不持久化，也不承担跨进程重试
// 并发模型：全部逻辑必须位于 Electron main 单线程，异步等待用 promise 串联，队列无锁但靠单飞 promise 去重
// 关闭顺序：先拒收新批次，再排空队列，最后关 exporter，任何一步超时都不阻塞进程退出
// INV-01 关闭中或已关闭或未配置 exporter 时必须拒收且不排队；守住位置：enqueue 入口守卫；改错故障：退出阶段仍接收批次，导出请求吊在已销毁的进程上
// INV-02 单批序列化字节数超过上限必须拒绝；守住位置：enqueue 的序列化体积检查；改错故障：超大批次撑爆 main 堆并拖住事件循环
// INV-03 序列化抛错必须降级为拒收而不是冒泡；守住位置：enqueue 的 catch 分支；改错故障：renderer 传入循环引用即可让主进程抛异常
// INV-04 只有 schema 校验通过的批次才能进入队列；守住位置：safeParse 之后的入队分支；改错故障：脏字段流入 OTel 转换，导出无法解释的 span
// INV-05 队列长度上限是背压闸门，满队丢新而非丢旧；守住位置：入队批数上限判断；改错故障：突发流量下队列无限增长直至内存泄漏
// INV-06 任意时刻最多存在一个 drainPromise；守住位置：scheduleDrain 的单飞守卫；改错故障：并发 drain 重复导出同一批次并打乱顺序
// INV-07 drain 收尾时若仍有积压且未关闭必须继续排下一轮；守住位置：finally 内的续排判断；改错故障：尾部批次永久滞留队列
// INV-08 closed 之后 drain 必须立刻清空队列并返回；守住位置：drain 顶部与循环内的关闭判断；改错故障：退出阶段继续发起导出，退出时延不可控
// INV-09 只有明确 failed 才重试一次，timeout 不重试；守住位置：导出结果的重试分支；改错故障：超时重试与迟到请求同时成功，产生重复 span
// INV-10 重试之前必须复查关闭状态；守住位置：重试条件中的关闭判断；改错故障：关闭后仍占用导出通道，阻塞后续关闭步骤
// INV-11 flush 必须幂等，并发调用共享同一 promise；守住位置：flush 的 flushPromise 缓存；改错故障：多次 flush 触发重复 forceFlush
// INV-12 flush 必须先等队列排空再 forceFlush；守住位置：flush 内的 drain 等待与续排；改错故障：forceFlush 早于积压导出，调用方拿到残缺数据
// INV-13 forceFlush 超出 deadline 只告警不抛出；守住位置：settleWithinDeadline 包装；改错故障：exporter 卡死导致 flush 永不返回
// INV-14 shutdown 必须幂等，重复调用返回同一 promise；守住位置：shutdown 的终态与缓存分支；改错故障：exporter 收到两次关闭，第二次抛错污染退出日志
// INV-15 进入 shutdown 时立即置 shuttingDown 拒收新批次；守住位置：shutdown 开头的状态赋值；改错故障：退出竞态中新批次插队，永远得不到导出
// INV-16 drain 超出 shutdown 预算时丢弃剩余队列并计数；守住位置：drain 等待的 deadline 分支；改错故障：进程退出被队列拖住直到被系统强杀
// INV-17 剩余预算不足时跳过 exporter.shutdown；守住位置：剩余毫秒数判断；改错故障：退出尾段再等满一个超时，用户感知为卡顿
// INV-18 超时定时器必须 unref，且胜负都要清理；守住位置：settleWithinDeadline 的定时器管理；改错故障：悬挂 timer 维持事件循环，进程无法退出
import { SpanKind, SpanStatusCode, TraceFlags, type HrTime } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  RENDERER_ACTION_TRACE_MAX_BATCH_BYTES,
  rendererActionTraceBatchSchema,
  type RendererActionTraceBatchV1,
  type RendererActionTraceSpanV1,
} from "@zcode/shared";

// [权衡] 32 批与 3 秒导出预算是渲染端突发量与主进程退出时延的折中，调小会丢批调大会拉长退出
// [约束] 四个上限都是硬编码默认值，调用方能覆盖超时但无法突破入队批数上限
const RENDERER_ACTION_TRACE_MAX_INGRESS_BATCHES = 32;
const RENDERER_ACTION_TRACE_EXPORT_TIMEOUT_MS = 3_000;
const RENDERER_ACTION_TRACE_SHUTDOWN_TIMEOUT_MS = 2_000;
const RENDERER_ACTION_TRACE_FLUSH_TIMEOUT_MS = 2_000;

// [契约] enqueue 同步返回是否接收，false 表示调用方应自行丢弃，broker 不承诺重试
// [契约] flush 返回的 promise 在队列清空且 forceFlush 结束后才解决
// [契约] shutdown 之后 broker 进入终态，任何后续 enqueue 都返回 false
export interface RendererActionTraceBroker {
  enqueue(batch: unknown): boolean;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

// [职责] 闭包持有队列与三个 promise 槽位，队列是唯一可变状态，实例之间不共享
// [权衡] exporter 允许为空，此时所有入队直接拒绝，便于未启用 trace 的环境零成本装配
// [失败路径] 工厂本身不抛错，配置问题只会在首次使用时表现为拒收而非启动失败
export function createRendererActionTraceBroker(options: {
  exporter: SpanExporter | undefined;
  logger: {
    debug(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
  shutdownTimeoutMs?: number;
  flushTimeoutMs?: number;
  exportTimeoutMs?: number;
}): RendererActionTraceBroker {
  // [并发] queue 只在 main 线程读写，drain 的 shift 与 enqueue 的 push 不会真正并行
  // [状态] 三个 promise 槽位复用同一异步结果，防止重复副作用而不是防止重复计算
  // [生命周期] closed 是单向终态，shuttingDown 是关闭流程的中间态，两者都不能回退
  const queue: RendererActionTraceBatchV1[] = [];
  let drainPromise: Promise<void> | undefined;
  let flushPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let closed = false;
  let shuttingDown = false;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? RENDERER_ACTION_TRACE_SHUTDOWN_TIMEOUT_MS;
  const flushTimeoutMs = options.flushTimeoutMs ?? RENDERER_ACTION_TRACE_FLUSH_TIMEOUT_MS;
  const exportTimeoutMs = options.exportTimeoutMs ?? RENDERER_ACTION_TRACE_EXPORT_TIMEOUT_MS;

  // [资源] 每轮先 shift 再导出，失败批次不回队，避免毒批次无限重试拖垮队列
  // [并发] 导出等待期间仍可入队，循环条件保证新增批次被后续轮次消费
  // [失败路径] exporter 缺失或已关闭时直接清空队列，宁可丢数据也不阻塞退出
  // [权衡] 单轮串行导出换取顺序性与可追溯日志，牺牲吞吐量
  const drain = async (): Promise<void> => {
    if (!options.exporter || closed) {
      queue.splice(0, queue.length);
      return;
    }
    while (queue.length > 0) {
      if (closed) {
        queue.splice(0, queue.length);
        return;
      }
      const batch = queue.shift();
      if (!batch) continue;
      const spans = batch.spans.map((span) => toReadableSpan(batch, span));
      let result = await exportSpansWithDeadline(options.exporter, spans, exportTimeoutMs);
      // Bug 原因：deadline 只能停止等待，无法取消已发出的 exporter 请求。超时后立即重试
      // 可能让迟到的首次请求和重试同时成功，因此仅在 exporter 明确失败时重试。
      // [失败路径] 仅 failed 才重试一次，timeout 不重试，因为超时的请求可能已在 exporter 侧成功
      // [并发] 重试前必须复查关闭状态，避免关闭流程已开始还占用导出通道
      // [权衡] 重试上限为两次且不做退避，超出的批次只记 warn 后丢弃
      if (result === "failed" && !closed) {
        result = await exportSpansWithDeadline(options.exporter, spans, exportTimeoutMs);
      }
      if (result !== "success" && !closed) {
        options.logger.warn("[renderer-action-trace] batch export failed", {
          rendererInstanceId: batch.rendererInstanceId,
          sequence: batch.sequence,
          spanCount: spans.length,
          failureKind: result,
        });
      }
    }
  };

  // [并发] drainPromise 充当单飞锁，已有 drain 在跑时直接返回，不排第二轮
  // [并发] finally 中先清空槽位再按需续排，顺序颠倒会让续排被自身守卫吞掉
  // [失败路径] 借微任务起链，避免在 enqueue 的同步栈内递归调用 drain
  const scheduleDrain = (): void => {
    if (drainPromise) return;
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainPromise = undefined;
        if (!closed && queue.length > 0) scheduleDrain();
      });
  };

  return {
    // [契约] 返回值是同步背压信号，调用方据此丢弃或降频，broker 不保留拒绝原因
    // [顺序] 先拒关闭态再拒超大再拒畸形最后拒满队，越靠前的检查成本越低
    // [权衡] 整批序列化只为量体积，必须多一次字符串拷贝换取入队前的内存上限保障
    enqueue(input) {
      if (closed || shuttingDown || !options.exporter) return false;
      // [失败路径] 序列化遇到循环引用或非法值会抛错，此处吞掉并视为不可接收
      // [权衡] 先序列化再校验 schema，重复遍历一次但让超大载荷在校验前被挡住
      let serializedBytes = 0;
      try {
        serializedBytes = Buffer.byteLength(JSON.stringify(input));
      } catch {
        return false;
      }
      // [失败路径] 超限批次只记录字节数不记录内容，避免日志泄漏 renderer 侧数据
      // [安全] 该上限是准入闸门，防止单个 renderer 用超大批次打爆 main 堆
      if (serializedBytes > RENDERER_ACTION_TRACE_MAX_BATCH_BYTES) {
        options.logger.warn("[renderer-action-trace] rejected oversized batch", {
          serializedBytes,
        });
        return false;
      }
      // [契约] 使用 safeParse 而非 parse，畸形输入走拒绝路径而不是抛到调用栈
      // [失败路径] 只上报 issue 数量不回显字段值，兼顾可诊断与不泄漏原始数据
      const parsed = rendererActionTraceBatchSchema.safeParse(input);
      if (!parsed.success) {
        options.logger.warn("[renderer-action-trace] rejected malformed batch", {
          issueCount: parsed.error.issues.length,
        });
        return false;
      }
      // [并发] 满队时丢新批次而非丢旧批次，保留已接收数据的顺序语义
      // [失败路径] 拒绝日志带实例标识与序号，便于对齐丢失区间
      if (queue.length >= RENDERER_ACTION_TRACE_MAX_INGRESS_BATCHES) {
        options.logger.warn("[renderer-action-trace] ingress queue full", {
          rendererInstanceId: parsed.data.rendererInstanceId,
          sequence: parsed.data.sequence,
        });
        return false;
      }
      queue.push(parsed.data);
      scheduleDrain();
      return true;
    },
    // [并发] flushPromise 必须单飞，并发调用共享同一轮排空，避免重复 forceFlush
    // [顺序] 先等现有 drain，再在仍有积压时手动续排一次，最后才 forceFlush
    // [失败路径] forceFlush 异常在包装层被归一为未完成，只告警不抛出
    flush() {
      if (flushPromise) return flushPromise;
      flushPromise = (async () => {
        await drainPromise;
        if (queue.length > 0) {
          scheduleDrain();
          await drainPromise;
        }
        // [资源] forceFlush 必须使用独立 deadline，不与 shutdown 预算共享，两者超时语义不同
        // [失败路径] 超时后继续而非拒绝，flush 的承诺是尽力而为
        if (options.exporter?.forceFlush) {
          const deadline = Date.now() + flushTimeoutMs;
          const forceFlush = Promise.resolve().then(() => options.exporter?.forceFlush?.());
          if (!(await settleWithinDeadline(forceFlush, deadline)).completed) {
            options.logger.warn(
              "[renderer-action-trace] exporter forceFlush exceeded deadline; continuing",
            );
          }
        }
      })().finally(() => {
        flushPromise = undefined;
      });
      return flushPromise;
    },
    // [状态] 终态判断优先于 promise 缓存，已关闭时直接返回已解决的 promise
    // [并发] shutdownPromise 复用保证 exporter.shutdown 最多被调用一次
    // [失败路径] shutdown 永不拒绝，退出路径不该因 trace 收尾失败而中断
    shutdown() {
      if (closed) return Promise.resolve();
      if (shutdownPromise) return shutdownPromise;
      // [并发] 先置中间态再建 promise，缩小新批次插队的时间窗口
      // [契约] 中间态下 enqueue 返回 false，调用方看到的是背压而不是异常
      shuttingDown = true;
      shutdownPromise = (async () => {
        const deadline = Date.now() + shutdownTimeoutMs;
        // [失败路径] drain 超预算说明导出卡住，此时直接丢弃剩余队列以保退出时延
        // [资源] 丢弃前必须统计批数用于告警，丢弃后不再尝试导出，避免超时后反复挣扎
        if (drainPromise && !(await settleWithinDeadline(drainPromise, deadline)).completed) {
          closed = true;
          const droppedBatchCount = queue.splice(0, queue.length).length;
          options.logger.warn(
            "[renderer-action-trace] shutdown deadline exceeded; dropping queued batches",
            { droppedBatchCount },
          );
          return;
        }
        closed = true;
        queue.splice(0, queue.length);
        const remainingMs = deadline - Date.now();
        // [资源] 预算不足时跳过 exporter.shutdown，把回收交给操作系统
        // [权衡] 与 drain 共用同一 deadline 而非新预算，保证总耗时不超过配置上限
        if (options.exporter?.shutdown && remainingMs > 0) {
          const exporterShutdown = Promise.resolve().then(() => options.exporter?.shutdown());
          if (!(await settleWithinDeadline(exporterShutdown, deadline)).completed) {
            options.logger.warn(
              "[renderer-action-trace] exporter shutdown exceeded deadline; continuing app quit",
            );
          }
        }
      })();
      return shutdownPromise;
    },
  };
}

// [并发] 用 Promise.race 把任意 promise 收敛为完成与否，屏蔽拒绝只保留状态
// [资源] 无论胜负都在 finally 清掉定时器，避免悬挂 timer 维持事件循环
// [契约] 返回未完成即代表超时，调用方不应再假设原 promise 的结果
async function settleWithinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  options?: { unrefTimer?: boolean },
): Promise<{ completed: true; value?: T } | { completed: false }> {
  const remainingMs = deadline - Date.now();
  // [边界] 预算已耗尽时立即返回未完成，不创建定时器也不订阅原 promise
  // [失败路径] 该分支让关闭流程在极端慢时钟下也能快速收敛
  if (remainingMs <= 0) return { completed: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ completed: false }>((resolve) => {
    timer = setTimeout(() => resolve({ completed: false }), remainingMs);
    if (options?.unrefTimer) timer.unref?.();
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ completed: true as const, value }),
        () => ({ completed: true as const }),
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// [契约] 把布尔结果与超时折叠成三态，成功失败超时对应不同重试策略
// [资源] 定时器 unref，导出超时不会单独阻止 Node 进程退出
async function exportSpansWithDeadline(
  exporter: SpanExporter,
  spans: ReadableSpan[],
  timeoutMs: number,
): Promise<"success" | "failed" | "timeout"> {
  const settled = await settleWithinDeadline(exportSpans(exporter, spans), Date.now() + timeoutMs, {
    unrefTimer: true,
  });
  if (!settled.completed) return "timeout";
  return settled.value === true ? "success" : "failed";
}

// [契约] 必须把线上协议 span 映射为 OTel 可导出结构，只补最小必需字段，缺失集合用空数组
// [权衡] 每批重建 resource，换取不依赖全局 provider 注册，转换逻辑可独立单测
function toReadableSpan(
  batch: RendererActionTraceBatchV1,
  span: RendererActionTraceSpanV1,
): ReadableSpan {
  const startTime = unixMsToHrTime(span.startTimeUnixMs);
  const endTime = unixMsToHrTime(span.endTimeUnixMs);
  const resource = resourceFromAttributes({
    "service.name": batch.resource.serviceName,
    "service.version": batch.resource.serviceVersion,
    "service.instance.id": batch.resource.rendererInstanceId,
    "deployment.environment.name": batch.resource.deploymentEnvironment,
  });
  return {
    name: span.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: span.traceId,
      spanId: span.spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    }),
    startTime,
    endTime,
    status: {
      code:
        span.status === "ok"
          ? SpanStatusCode.OK
          : span.status === "error"
            ? SpanStatusCode.ERROR
            : SpanStatusCode.UNSET,
    },
    attributes: span.attributes,
    links: [],
    events: [],
    duration: subtractHrTime(endTime, startTime),
    ended: true,
    resource,
    instrumentationScope: {
      name: "@zcode/desktop-renderer-action-trace",
      version: "1",
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function unixMsToHrTime(value: number): HrTime {
  const seconds = Math.floor(value / 1_000);
  const nanos = Math.floor((value - seconds * 1_000) * 1_000_000);
  return [seconds, nanos];
}

// [边界] 纳秒借位必须处理负差值，末尾对秒与纳秒分别夹到非负，防止异常时间戳产出负时长
// [契约] 下游依赖结束时间不早于开始时间，夹取让调用方不必再判空
function subtractHrTime(end: HrTime, start: HrTime): HrTime {
  let seconds = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    seconds -= 1;
    nanos += 1_000_000_000;
  }
  return [Math.max(seconds, 0), Math.max(nanos, 0)];
}

function exportSpans(exporter: SpanExporter, spans: ReadableSpan[]): Promise<boolean> {
  return new Promise((resolve) => {
    exporter.export(spans, (result) => resolve(result.code === 0));
  });
}
