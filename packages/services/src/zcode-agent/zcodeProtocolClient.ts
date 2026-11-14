import { ZCodeStorageStartupGate } from "#src/zcode-agent/zcodeStorageStartupGate.js";
import { Emitter } from "@zcode/rpc";
import type { IDisposable } from "@zcode/rpc";
import type {
  ZCodeProtocolMethod,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolTrace,
} from "@zcode/shared";
import type { V4Method } from "@zcode/shared/zcode-protocol-v4";
import type { z } from "zod";
import type { ZCodeProtocolTransport } from "./zcodeProtocolTransport.js";

/** 客户端可发的方法名：旧 zcodeProtocolMethods + v4/*（M3 起并存，M5 波次 2 收敛为 v4）。 */
// 方法与协议存量并存：旧 zcodeProtocolMethods 与 v4/* 同时可发，
// 收敛到 v4 之前不要假设调用方只会使用其中一套。
export type ZCodeProtocolClientMethod = ZCodeProtocolMethod | V4Method;

// requireStorageStartup 只对声明支持存储启动协议的命令开启：
// 旧自定义命令不等待迁移通知，开了会永久卡在选择门禁上。
interface ZCodeProtocolClientOptions {
  requireStorageStartup?: boolean;
  requestTimeoutMs?: number;
}

// 超时事件把「连接已不可信」的事实上抛给 owner：
// client 自己无法淘汰进程，只负责报告是哪条请求超了多少毫秒。
export interface ZCodeProtocolRequestTimeoutEvent {
  method: ZCodeProtocolClientMethod;
  requestId: ZCodeProtocolRequestId;
  timeoutMs: number;
}

// [资源] 在飞请求的全部句柄：定时器、恢复函数、abort 清理与可选 schema。
// promise 字段只用于 dispose 批量拒绝时挂 no-op catch，
// 正常路径不依赖它做任何等待。
interface PendingRequest<T> {
  method: string;
  observation: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resumeTimeout: () => void;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  /** dispose 批量拒绝时在此处挂 no-op catch，防止"取消即 unhandled"（见 rejectAll）。 */
  promise?: Promise<T>;
  resultSchema?: z.ZodType<T>;
  cleanupAbort?: () => void;
}

// [权衡] lifecycle=observation 的请求不计入业务空闲续期：
// 资源采样、状态轮询不应让一个本该回收的进程一直活着。
interface ZCodeProtocolClientRequestOptions {
  /** 观测不得参与 runtime 健康判定或业务空闲续期；默认保持业务请求语义。 */
  lifecycle?: "operation" | "observation";
  signal?: AbortSignal;
  trace?: ZCodeProtocolTrace;
  timeoutMs?: number;
}

// 默认 3 分钟：thinking 模型的长请求可能接近这个量级，
// 需要更长的调用方必须显式传 timeoutMs，而不是改这个全局值。
export const DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS = 3 * 60_000;

// 协议层错误保留 code 与 data：上层据此区分「方法不存在」与「执行失败」。
class ZCodeProtocolClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "ZCodeProtocolClientError";
  }
}

// 单独的错误类型让 owner 能精确捕获超时并触发进程回收，
// 不必解析 message 文本。
export class ZCodeProtocolRequestTimeoutError extends Error {
  constructor(
    readonly method: ZCodeProtocolClientMethod,
    readonly requestId: ZCodeProtocolRequestId,
    readonly timeoutMs: number,
  ) {
    super(`ZCode Protocol request timed out: ${method}`);
    this.name = "ZCodeProtocolRequestTimeoutError";
  }
}

// [状态归属] 一个 client 对应一个已建立握手的 runtime 进程。
// 它持有在飞请求表与四类事件流，dispose 后所有在飞请求统一以取消语义拒绝。
// 复用前必须检查 isDisposed：进程已经被回收但 onClose 尚未触发时，
// 继续用旧 client 发请求会立刻抛错。
export class ZCodeProtocolClient implements IDisposable {
  readonly storageStartup: ZCodeStorageStartupGate;
// 以字符串 id 为键与 wire 层保持一致：JSON 里 id 可能是数字也可能是字符串，
// 统一 String 化避免同一请求出现两个键。
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly notificationEmitter = new Emitter<ZCodeProtocolNotification>();
  private readonly requestEmitter = new Emitter<ZCodeProtocolRequest>();
  private readonly requestTimeoutEmitter = new Emitter<ZCodeProtocolRequestTimeoutEvent>();
  // 业务请求归零时触发；观测完成不能给被观察进程续命。
// [契约] pendingDrained 只统计业务请求：观测类请求完成后不得触发，否则会给被观察进程续命。
  private readonly pendingDrainedEmitter = new Emitter<void>();
  private readonly closeEmitter = new Emitter<void>();
  private readonly disposables: IDisposable[] = [];
// 请求 id 进程内单调递增，不复用：复用会让迟到的旧响应结算到新请求上。
  private nextRequestId = 1;
  private disposed = false;
  private readonly requestTimeoutMs: number;

  /**
   * client 是否已 dispose（进程被回收/transport 关闭后为 true）。
   * 调用方（如 getClient 复用 active entry）必须在复用前检查此标记，
   * 避免对一个已被 processManager 回收但尚未触发 onClose 的 client 发请求，
   * 否则会立即抛 "ZCode Protocol client is disposed"。
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

// 五路事件分流：通知、服务端请求、请求超时、业务请求排空、连接关闭。
// 订阅方按语义各取所需，避免一个万能回调里做二次分发。
  readonly onNotification = this.notificationEmitter.event;
  readonly onRequest = this.requestEmitter.event;
  readonly onRequestTimeout = this.requestTimeoutEmitter.event;
  readonly onPendingRequestsDrained = this.pendingDrainedEmitter.event;
  readonly onClose = this.closeEmitter.event;

  /** 当前尚未收到响应的请求数。 */
  get pendingRequestCount(): number {
    return this.pending.size;
  }

// 逐条遍历而不是维护计数器：增删路径分散在超时/abort/响应/拒绝四处，
// 计数一旦漂移就会导致空闲回收永不触发或提前触发。
  get pendingOperationRequestCount(): number {
    let count = 0;
    for (const pending of this.pending.values()) if (!pending.observation) count += 1;
    return count;
  }

  constructor(
    private readonly transport: ZCodeProtocolTransport,
    options?: ZCodeProtocolClientOptions,
  ) {
// 门禁缺省关闭：只有明确声明支持存储启动协议的命令才需要等待迁移完成。
    this.storageStartup = new ZCodeStorageStartupGate(options?.requireStorageStartup ?? false);
// 构造即接管 transport 的两条生命周期：消息与关闭。
// 关闭时必须先关存储门禁再批量拒绝，否则等待迁移的请求会永远 pending。
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS;
    this.disposables.push(
      transport.onMessage((message) => this.handleMessage(message)),
// [失败路径] 关闭是终态：先释放门禁、再以取消语义拒绝所有在飞请求、最后广播 onClose。
// 顺序固定，保证订阅方收到关闭时已经没有悬挂的 promise。
      transport.onClose((event) => {
        this.storageStartup.dispose();
        const suffix = event.reason ? `: ${event.reason}` : "";
        this.rejectAll(new Error(`ZCode agent transport closed${suffix}`));
        this.closeEmitter.fire();
      }),
    );
  }

// 透传 transport 类型，供上层区分 stdio 与 websocket 通道。
  get transportKind() {
    return this.transport.kind;
  }

  /**
   * 非 async 包装（CR 意见）：调用方持有的是本方法返回的 Promise，而 async 实现内部的
   * resultPromise 经 return 传播拒绝时，外层 Promise 独立参与 unhandledRejection 判定。
   * no-op catch 必须挂在最终返回对象创建点，才能覆盖 dispose/transport close 的批量拒绝
   * 与调用方挂靠 .catch() 之间的时序窗口。该 handler 只影响 unhandled 判定，不改变
   * rejection 向真实 awaiter 的传播；代价是调用方 fire-and-forget 忘挂 catch 时不再有
   * unhandled 噪声暴露，属可接受取舍（仓库内 void 调用点均自带 catch）。
   */
  request<T = unknown>(
    method: ZCodeProtocolClientMethod,
    params?: unknown,
    resultSchema?: z.ZodType<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    const requestPromise = this.requestImpl(method, params, resultSchema, options);
    void requestPromise.catch(() => undefined);
    return requestPromise;
  }

// [事务] 一次请求的完整生命周期：门禁等待 → 分配 id → 建 pending → 发送 → 等待结算。
// 每个 await 之后都要复核 disposed 与 pending 是否已被删除，
// 否则 abort/超时之后仍会往 transport 写入一个无人接收的请求。
  private async requestImpl<T = unknown>(
    method: ZCodeProtocolClientMethod,
    params?: unknown,
    resultSchema?: z.ZodType<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    this.assertNotDisposed();
    // 不先创建请求/启动 watchdog；只在真实 COMMIT 后进入原有协议请求生命周期。
// [资源] 门禁等待发生在建请求之前：等待迁移期间不该占用请求 id，
// 也不该启动 watchog 计时器，否则迁移耗时会被误判成请求超时。
// signal 透传让取消能立即中断等待；醒来后必须再判一次 disposed。
    if (this.storageStartup.isWaiting) await this.storageStartup.wait(options?.signal);
    this.assertNotDisposed();
    options?.signal?.throwIfAborted();
// 超时来源二选一：调用方显式值优先，否则用 client 级默认值。
// observation 标记决定超时是否升级成连接故障事件。
    const id = this.nextRequestId++;
    const requestKey = String(id);
    const requestTimeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const observation = options?.lifecycle === "observation";

    const resultPromise = new Promise<T>((resolve, reject) => {
// [失败路径] 超时先清 pending 再上报：owner 收到事件后可能立刻回收进程，
// 若此时表里还有该请求，回收路径会重复拒绝同一条 promise。
// 观测类请求的短超时只代表本轮无数据，不上报为连接故障。
      const expire = () => {
        const pending = this.pending.get(requestKey);
        pending?.cleanupAbort?.();
        this.deletePending(requestKey);
        const error = new ZCodeProtocolRequestTimeoutError(method, id, requestTimeoutMs);
        // 子进程仍存活但协议 event loop 已无响应时，只让单次 request 超时是不够的：
        // process manager 仍复用这个 stale client，导致后续 plugins/list 等请求连续卡在超时窗口。
        // 超时事件把“连接已不可信”的事实上抛给 owner，由 owner 负责淘汰进程。
        // 资源查询的短超时只表示本轮无数据，不能被升级成整个 Agent 的故障回收。
        if (!observation) {
          this.requestTimeoutEmitter.fire({ method, requestId: id, timeoutMs: requestTimeoutMs });
        }
        reject(error);
      };
      const timeout = setTimeout(expire, requestTimeoutMs);

// abort 与超时共用同一套清理：清定时器、摘监听、删表、以 AbortError 拒绝。
// 若 pending 已不存在（同步 abort 或已结算），直接返回且不重复 reject。
      const abortHandler = () => {
        const pending = this.pending.get(requestKey);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pending.cleanupAbort?.();
        this.deletePending(requestKey);
        const reason = options?.signal?.reason;
        reject(
          reason instanceof Error ? reason : new DOMException("Request aborted", "AbortError"),
        );
      };
      const pending: PendingRequest<T> = {
        method,
        observation,
        timeout,
        resumeTimeout: () => {
          pending.timeout = setTimeout(expire, requestTimeoutMs);
        },
        resolve: resolve as (value: unknown) => void,
        reject,
        // Bug 复盘：这里曾在 executor 内直接引用外层 resultPromise，触发 TDZ
        // ReferenceError（executor 同步运行于 const 赋值完成之前），每次 request 即抛。
        // promise 绑定延后到 new Promise 返回之后完成。
        resultSchema,
        cleanupAbort: () => options?.signal?.removeEventListener("abort", abortHandler),
      };
      this.pending.set(requestKey, pending as PendingRequest<unknown>);
      if (options?.signal?.aborted) {
        abortHandler();
      } else {
        options?.signal?.addEventListener("abort", abortHandler, { once: true });
      }
    });

    // executor 内 pending.set 已同步完成；此处 resultPromise 已就绪，补绑给
    // rejectAll 做 dispose 批量拒绝的 no-op catch。同步 abort 场景 pending 已
    // 删除，get 返回 undefined，安全跳过。
    const registeredPending = this.pending.get(requestKey);
// [失败路径] executor 内不能引用外层 resultPromise（TDZ），
// 因此在 new Promise 返回后才补绑，供 dispose 批量拒绝挂 no-op catch。
// 同步 abort 时 pending 已被删除，这里的 get 返回 undefined 属正常分支。
    if (registeredPending) {
      registeredPending.promise = resultPromise;
    }

    // 已在发送前取消的请求不能继续写入 transport；否则服务端会执行一个客户端已经
    // 放弃、也无法接收响应的模型任务。
// 发送前已被取消的请求绝不写入 transport：
// 否则服务端会执行一个客户端已经放弃、也无法接收响应的模型任务。
    if (!this.pending.has(requestKey)) {
      return resultPromise;
    }

    try {
      await this.transport.send({
        id,
        method,
        params,
        ...(options?.trace ? { trace: options.trace } : {}),
      });
    } catch (error) {
      const pending = this.pending.get(requestKey);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.cleanupAbort?.();
        this.deletePending(requestKey);
      }
      throw error;
    }

    return resultPromise;
  }

// 通知没有响应体，因此不建 pending、不设超时；
// 失败只可能来自 transport 写入。
  async notify(method: ZCodeProtocolClientMethod, params?: unknown): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ method, params });
  }

// 应答服务端请求：id 原样带回，不参与本端 pending 表。
  async respond(id: ZCodeProtocolRequestId, result: unknown): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ id, result });
  }

  async respondError(
    id: ZCodeProtocolRequestId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    this.assertNotDisposed();
    await this.transport.send({ id, error });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeLocalResources();
    this.transport.dispose();
  }

// [资源] 与 dispose 的唯一区别是等待 transport 完成进程树回收：
// Host 退出必须用这个版本，否则 SIGKILL 兜底定时器会随进程一起消失。
// 重复调用安全：wasDisposed 记录本次是否首次释放。
  async disposeAndWait(): Promise<void> {
    const wasDisposed = this.disposed;
    if (!wasDisposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    if (this.transport.disposeAndWait) {
      await this.transport.disposeAndWait();
      return;
    }
    if (!wasDisposed) {
      this.transport.dispose();
    }
  }

// [事务] 入站消息四分类，判定顺序必须是 result → error → request → notification：
// 带 id 的响应优先于带 method 的请求，否则双向调用的响应会被当成新请求。
  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }

    if ("result" in message && "id" in message) {
      this.resolveResponse(
        (message as { id: ZCodeProtocolRequestId; result: unknown }).id,
        (message as { result: unknown }).result,
      );
      return;
    }

    if ("error" in message && "id" in message) {
      const errorMessage = message as {
        id: ZCodeProtocolRequestId;
        error: { code: number; message: string; data?: unknown };
      };
      this.rejectResponse(
        errorMessage.id,
        new ZCodeProtocolClientError(
          errorMessage.error.message,
          errorMessage.error.code,
          errorMessage.error.data,
        ),
      );
      return;
    }

// 服务端发起的请求（含 id 与 method），交给业务侧 responder 处理；
// 无 id 的才是单向通知。
    if ("method" in message && "id" in message) {
      this.requestEmitter.fire(message as ZCodeProtocolRequest);
      return;
    }

    if ("method" in message) {
      if (
// [资源] 首个合法启动帧会暂停所有在飞请求的计时器：
// 自定义/旧部署无法事先声明能力，请求可能已发出，迁移期间超时会误杀进程。
// ready 后逐个恢复计时，failed 则整体拒绝并给出错误码。
        message.method === "startup/storageState" &&
        this.storageStartup.accept((message as ZCodeProtocolNotification).params)
      ) {
        // 自定义/旧部署命令无法事先声明能力；首个请求可能已发出。只有首次合法启动帧
        // 能暂停这些计时器，ready 后恢复；该进程的终态不能被后续通知重新续期。
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          if (this.storageStartup.snapshot?.phase === "ready") pending.resumeTimeout();
        }
        if (this.storageStartup.snapshot?.phase === "failed") {
          this.rejectAll(
            new Error(`SQLite startup failed: ${this.storageStartup.snapshot.errorCode}`),
          );
        }
      }
      this.notificationEmitter.fire(message as ZCodeProtocolNotification);
    }
  }

  private resolveResponse(id: ZCodeProtocolRequestId, result: unknown): void {
    const requestKey = String(id);
    const pending = this.pending.get(requestKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pending.cleanupAbort?.();
    this.deletePending(requestKey);

    try {
// schema 解析失败按请求失败处理，而不是把未校验数据交给调用方；
// 解析异常信息里带 method，便于定位是哪个协议方法漂移。
      const parsed = pending.resultSchema ? pending.resultSchema.parse(result) : result;
      pending.resolve(parsed);
    } catch (error) {
      pending.reject(
        error instanceof Error
          ? error
          : new Error(`ZCode Protocol response parse failed: ${pending.method}`),
      );
    }
  }

// 未知 id 的错误响应静默丢弃：典型场景是请求已超时后才收到服务端错误。
  private rejectResponse(id: ZCodeProtocolRequestId, error: Error): void {
    const requestKey = String(id);
    const pending = this.pending.get(requestKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    pending.cleanupAbort?.();
    this.deletePending(requestKey);
    pending.reject(error);
  }

// [并发] 批量拒绝发生在调用方 await 之外，拒绝先于任何处置会被判 unhandled；
// 这里先给每个 promise 挂 no-op catch，真实 awaiter 仍会收到 rejection。
// 只有此前存在业务请求时才发排空事件，避免纯观测连接触发空闲回收。
  private rejectAll(error: Error): void {
    const hadPending = this.pendingOperationRequestCount > 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.cleanupAbort?.();
      // Bug 原因：dispose 批量拒绝发生在调用方 await 之外（如 dispose 与在飞观测长轮询
      // 竞态），拒绝先于调用方任何处置被判 unhandledRejection（vitest 运行级失败，生产
      // 等价未处理拒绝崩溃）。dispose 引发的拒绝语义是"取消"，这里先挂 no-op catch；
      // 真实 awaiter 仍照常收到该 rejection，超时/abort 路径不受影响、照常上报。
      void pending.promise?.catch(() => undefined);
      pending.reject(error);
    }
    this.pending.clear();
    if (hadPending && !this.disposed) {
      this.pendingDrainedEmitter.fire();
    }
  }

// 删除失败即说明该请求已被其它路径结算，直接返回避免重复发排空事件。
// 排空事件用业务请求计数判定，观测请求不计入。
  private deletePending(requestKey: string): void {
    const pending = this.pending.get(requestKey);
    if (!this.pending.delete(requestKey)) {
      return;
    }
    if (!pending?.observation && this.pendingOperationRequestCount === 0 && !this.disposed) {
      this.pendingDrainedEmitter.fire();
    }
  }

// [资源] 释放顺序：先拒绝在飞请求，再解除 transport 订阅，最后销毁事件流。
// 顺序反了会在 emitter 销毁后仍有回调尝试 fire。
  private disposeLocalResources(): void {
    this.rejectAll(new Error("ZCode Protocol client disposed"));
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.storageStartup.dispose();
    this.notificationEmitter.dispose();
    this.requestEmitter.dispose();
    this.requestTimeoutEmitter.dispose();
    this.pendingDrainedEmitter.dispose();
    this.closeEmitter.dispose();
  }

// 所有对外方法的第一道检查，错误文案固定，便于调用方按字符串兜底处理。
  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("ZCode Protocol client is disposed");
    }
  }
}
