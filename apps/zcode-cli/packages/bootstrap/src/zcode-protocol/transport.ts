import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";
import {
  networkCaptureControlSchema,
  zcodeProtocolMessageSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
} from "@zcode/shared";
import type { Logger } from "@zcode/contracts";

type ZCodeProtocolOutgoingMessage =
  | ZCodeProtocolError
  | ZCodeProtocolNotification
  | ZCodeProtocolRequest
  | ZCodeProtocolResponse;

type ZCodeProtocolMessageHandler = (
  message: ZCodeProtocolMessage,
) => Promise<ZCodeProtocolOutgoingMessage | undefined>;

// stdin EOF 后给「已排队请求」的短宽限窗口：半关闭场景下应把已收到的请求跑完再关流，
// 但任一挂起 handler（如等待模型/交互）都可能永久占住队列。100ms 后强制 finish，
// 让进程能退出；超过窗口的响应由下游自行丢弃，不在这里无限保活。
const PROTOCOL_EOF_DRAIN_MS = 100;
// 插件读请求收到即处理，不排在安装/更新之后。describe 写 manifest 的分支自带 storage lock；
// list/overview 是同步 handler，执行中不让出事件循环，seed 只在内容变化时写盘，
// 不会与安装跨 await 的读改写交错。
const PLUGIN_READ_IMMEDIATE_METHODS = new Set<string>([
  zcodeProtocolMethods.pluginsDescribe,
  zcodeProtocolMethods.pluginsList,
  zcodeProtocolMethods.pluginsOverview,
]);
// MCP App 的请求由实例凭证和 callId 隔离；若与普通命令一起等待完成，
// uiCallTool 会挡住自己的 cancel/close，真实 stdio 链路将死锁。
const MCP_APP_CONCURRENT_METHODS = new Set<string>([
  zcodeProtocolMethods.mcpReadResource,
  zcodeProtocolMethods.mcpUiOpenInstance,
  zcodeProtocolMethods.mcpUiCloseInstance,
  zcodeProtocolMethods.mcpUiValidateInstance,
  zcodeProtocolMethods.mcpUiCallTool,
  zcodeProtocolMethods.mcpUiSampling,
  zcodeProtocolMethods.mcpUiCancelSampling,
  zcodeProtocolMethods.mcpUiCancelCall,
  zcodeProtocolMethods.mcpUiReadResource,
  zcodeProtocolMethods.mcpUiListResources,
  zcodeProtocolMethods.mcpUiListResourceTemplates,
  zcodeProtocolMethods.mcpUiSubscribeResource,
  zcodeProtocolMethods.mcpUiUnsubscribeResource,
  zcodeProtocolMethods.mcpUiRegisterAppTools,
  zcodeProtocolMethods.mcpUiUnregisterAppTools,
  zcodeProtocolMethods.mcpUiClaimAppToolCall,
  zcodeProtocolMethods.mcpUiResolveAppToolCall,
]);

interface ZCodeProtocolNdjsonConnectionOptions {
  signal?: AbortSignal;
  clearPostResponseMessages?: () => void;
  handleMessage: ZCodeProtocolMessageHandler;
  input: NodeJS.ReadableStream;
  logger?: Logger;
  onTransportClosed?: (error: Error) => void;
  output: NodeJS.WritableStream;
  takePostResponseMessages?: (
    requestId: ZCodeProtocolRequestId,
  ) => readonly ZCodeProtocolOutgoingMessage[];
  takePostResponseBatch?: (requestId: ZCodeProtocolRequestId) => {
    readonly messages: readonly ZCodeProtocolOutgoingMessage[];
    commit(): boolean;
  } | null;
}

/**
 * 单条 stdio 连接的 NDJSON 协议通道：client→server 每行一条 `ZCodeProtocolMessage`，
 * server→client 由 `send()` 逐行写出 response / notification / 反向 request。
 *
 * 职责：切行、schema 校验（失败回 -32700/-32600 但不关连接）、按方法分流执行队列，
 * 并在传输终结时一次性清理 post-response outbox。不变量：
 * - 默认串行：普通请求按到达顺序严格排队，前一条 handler 未 resolve 不开始下一条；
 * - 例外分流：停止/取消/MCP App 请求绕过串行队列，保证能打断在途模型任务；
 * - terminal 一旦置位，后续 `send()` 静默丢弃，避免向已坏的 stdout 写数据；
 * - 关闭有两态：`finish()` 正常 resolve，`fail()` 带错误 reject（EPIPE 等）。
 * 该实例只属于一个连接 epoch；新连接不得复用旧实例的订阅与 outbox 状态。
 */
export class ZCodeProtocolNdjsonConnection {
  private buffer = "";
  private processing: Promise<void> = Promise.resolve();
  private lastQueuedMessageStarted: Promise<void> = Promise.resolve();
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  private terminal = false;
  private transportCloseNotified = false;
  private draining = false;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ZCodeProtocolNdjsonConnectionOptions) {
    this.closedPromise = new Promise((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
  }

  /**
   * 挂载 stdin/stdout/signal 监听并开始接收。副作用：向 input/output 注册 listener，
   * 可能同步触发 abort 分支（signal 已 aborted 时立即 finish）。
   * 只应调用一次；重复调用会重复挂载 data listener，导致同一行被解析两次。
   */
  start(): void {
    this.options.input.on("data", this.onData);
    this.options.input.once("end", this.onClose);
    this.options.input.once("close", this.onClose);
    this.options.input.on("error", this.onError);
    this.options.output.on("error", this.onError);
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (this.options.signal?.aborted) this.onAbort();
  }

  /**
   * 等待连接终结：正常 EOF/abort 时 resolve，输入输出或 handler 抛错时 reject。
   * 返回的 Promise 已由构造函数创建，重复 await 得到同一结果，不会二次触发清理。
   */
  waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  /**
   * server→client 写出单条消息（JSON + "\n"）。terminal 后调用是无副作用的空操作。
   *
   * 副作用：`output.write` 同步抛错走 `onError` 终结连接；异步 EPIPE 由
   * output 的 error listener 处理。背压策略只对高频观测通知（processNetworkRequests）
   * 生效：stdout 积压 ≥256KiB 时直接丢弃该条观测，不阻塞业务响应。
   */
  send(message: ZCodeProtocolOutgoingMessage): void {
    if (this.terminal) return;
    // 观测可丢弃，不能在 stdout 背压时无界积压或挤占业务协议输出。
    if (
      "method" in message &&
      message.method === zcodeProtocolNotifications.processNetworkRequests &&
      ((this.options.output as NodeJS.WritableStream & { writableLength?: number })
        .writableLength ?? 0) >=
        256 * 1024
    )
      return;
    try {
      this.options.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // 按 "\n" 增量切行；draining/terminal 后忽略新数据，防止 close 后继续入队。
  // 半行留在 buffer，等下一 chunk 或 EOF 时再处理，避免把未完整 JSON 送去解析。
  private readonly onData = (chunk: Buffer | string): void => {
    if (this.terminal || this.draining) return;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.dispatchLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  };

  // EOF/close：先补发 buffer 里最后一条无换行消息，再通知上层 transport closed。
  // 已排队 handler 跑完后 finish；若队列本身 reject 则 fail，保持错误可见。
  private readonly onClose = (): void => {
    if (this.terminal || this.draining) return;
    const trailing = this.buffer.trim();
    if (trailing.length > 0) {
      this.dispatchLine(trailing);
      this.buffer = "";
    }
    this.draining = true;
    this.notifyTransportClosed(new Error("ZCode Protocol client connection closed"));
    // EOF 保留短请求半关闭响应，但挂起 handler 不能让进程永久保活。
    this.drainTimer = setTimeout(() => this.finish(), PROTOCOL_EOF_DRAIN_MS);
    void this.processing.then(
      () => this.finish(),
      (error: Error) => this.fail(error),
    );
  };

  // runtime 主动停止（signal abort）：不等待排队请求，直接 finish，
  // 因为此时上层已决定不再接受新的业务命令。
  private readonly onAbort = (): void => {
    this.notifyTransportClosed(new Error("ZCode Protocol runtime stopping"));
    this.finish();
  };

  private readonly onError = (error: Error): void => {
    this.notifyTransportClosed(error);
    this.fail(error);
  };

  // 关闭通知只发一次：上层据此释放 session/MCP 等资源，不允许重复释放。
  private notifyTransportClosed(error: Error): void {
    if (this.transportCloseNotified) return;
    this.transportCloseNotified = true;
    this.options.onTransportClosed?.(error);
  }

  // 正常终结：置 terminal → 摘除 listener → 清 outbox → resolve。
  // 先置 terminal 保证 detach 期间迟到的 send 不会写坏流。
  private finish(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.detachInput();
    this.options.clearPostResponseMessages?.();
    this.resolveClosed();
  }

  // 错误终结：与 finish 相同的清理顺序，但以 reject 告知等待者；
  // 再次进入由 terminal 保护，第一个错误决定最终结果。
  private fail(error: Error): void {
    if (this.terminal) return;
    this.terminal = true;
    this.notifyTransportClosed(error);
    this.detachInput();
    this.options.clearPostResponseMessages?.();
    this.rejectClosed(error);
  }

  // 摘掉 active listener 并清掉 drain 定时器。onError 故意保留：
  // 已排入事件循环的迟到 stream error 仍需被吸收，否则会变成 unhandled error。
  private detachInput(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.options.input.off("data", this.onData);
    this.options.input.off("end", this.onClose);
    this.options.input.off("close", this.onClose);
    this.options.signal?.removeEventListener("abort", this.onAbort);
    // 错误 listener 保留到流本身结束，吸收已经排入事件循环的迟到 stream error。
  }

  /**
   * 单行消息的调度决策点：决定是否参与串行队列、以及是否旁路执行。
   * 四类分流（顺序敏感）：
   * 1. 网络抓包启停：纯观测，即发即忘，失败不关连接，也不进入 CommandInbox；
   * 2. 反向 response（带 id + result/error）：必须立即处理，否则会与等待它的在途请求互锁；
   * 3. 插件只读方法：不依赖前序安装/更新，可立即执行以免 UI 骨架屏卡住；
   * 4. 停止/取消/MCP App：等前一条「已开始」后旁路，既不抢跑也不能排到长任务之后。
   * 其余请求进入串行队列：只在前一 handler resolve 后开始，保证会话命令顺序。
   */
  private dispatchLine(line: string): void {
    if (this.terminal) return;
    const message = this.decodeLine(line);
    if (!message) {
      return;
    }
    if (
      !("id" in message) &&
      "method" in message &&
      message.method === zcodeProtocolMethods.processNetworkCapture
    ) {
      // 启停是进程观测控制，不等待正在执行的生成任务，也不进入 CommandInbox。
      if (networkCaptureControlSchema.safeParse(message.params).success) {
        void this.handleMessage(message).catch(() => {
          /* 观测失败不关闭业务连接 */
        });
      }
      return;
    }
    if ("id" in message && ("result" in message || "error" in message)) {
      // Agent 发出反向 request 前已同步登记 pending response。
      // 若 response 等待“最后一个排队请求开始”，后续普通请求会把等待点推到当前长请求之后，
      // 形成「当前请求等 response、response 等后续请求」的死锁。
      void this.handleMessage(message).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    if (
      "id" in message &&
      "method" in message &&
      PLUGIN_READ_IMMEDIATE_METHODS.has(message.method)
    ) {
      // Bugfix：插件详情与列表曾排在串行队列里，安装 A 下载期间打开详情卡在组件 loading，
      // 新建右侧标签页（新 store 首次加载 list/overview）卡在骨架屏。读请求不依赖前序请求的
      // 执行结果，因此也不等 lastQueuedMessageStarted：否则 B 排在 A 后面时仍要等到 A 完成。
      void this.handleMessage(message).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }
    if (this.shouldBypassProcessingQueue(message)) {
      // 停止/取消控制必须等它前面的普通请求真正进入 handler、建立 abort
      // controller，再越过该请求的异步执行；只延后一轮微任务会让控制请求提前成为空操作。
      void this.lastQueuedMessageStarted
        .then(() => this.handleMessage(message))
        .catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
      return;
    }
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.lastQueuedMessageStarted = started;
    this.processing = this.processing
      .then(async () => {
        const handling = this.handleMessage(message);
        markStarted();
        await handling;
      })
      .catch((error: unknown) => {
        markStarted();
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * 解析并校验一行：JSON 语法错误回 -32700，schema 不符回 -32600（附 issues）。
   * 两种失败都只丢弃该行、不终结连接 —— 客户端可继续发送后续请求。
   * 返回值 null 表示该行已被拒绝，调用方不得再当消息处理。
   */
  private decodeLine(line: string): ZCodeProtocolMessage | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      this.options.logger?.warn("ZCode Protocol JSON parse failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.parse.failed",
        module: "bootstrap.zcode_protocol",
        status: "failed",
      });
      this.sendError("parse-error", -32700, "Parse error");
      return null;
    }

    const parsed = zcodeProtocolMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.sendError("invalid-message", -32600, "Invalid ZCode Protocol message", {
        issues: parsed.error.issues,
      });
      return null;
    }

    return parsed.data;
  }

  // 控制面方法集合：这些请求需要在模型任务运行期间仍可达 server，
  // 否则底层 AbortSignal 永远传不进去。仅旁路「执行」，不改变响应归并顺序。
  private shouldBypassProcessingQueue(message: ZCodeProtocolMessage): boolean {
    // 模型任务占住串行队列时，停止/取消请求必须仍能进入 server，
    // 才能把底层 AbortSignal 传给真实模型请求。控制面只旁路当前执行，普通请求仍保持串行。
    return (
      "id" in message &&
      "method" in message &&
      (message.method === zcodeProtocolMethods.sessionStop ||
        message.method === zcodeProtocolMethods.workspaceCancelGenerateText ||
        MCP_APP_CONCURRENT_METHODS.has(message.method))
    );
  }

  /**
   * 执行单条消息并把 handler 返回的响应写回。响应可能是 response、error、
   * notification 或反向 request；只有带 id 的 response/error 才会附带
   * post-response outbox（该请求产生的后续通知）。
   *
   * 顺序不变量：take 批次 → 校验未 terminal → 写主响应 → 写批次内通知 → commit。
   * batch.commit 只在前述写入没有同步失败后调用，代表这些消息已进入本连接队列；
   * 若此期间连接被 EPIPE 终结，则放弃 commit，避免把水位推进到已失效的管道。
   * handler 抛出的异常由调用方的 catch 转成 `fail()`，不会静默吞掉。
   */
  private async handleMessage(message: ZCodeProtocolMessage): Promise<void> {
    if (this.terminal) return;
    const response = await this.options.handleMessage(message);
    if (response) {
      // 确定性时序：先一次性 take 当前 request 的 outbox，再连续写 response
      // 与 notification。禁止 queueMicrotask/setTimeout 或依赖底层分包先后。
      const postResponseBatch =
        "id" in response && ("result" in response || "error" in response)
          ? (this.options.takePostResponseBatch?.(response.id) ?? {
              messages: this.options.takePostResponseMessages?.(response.id) ?? [],
              commit: () => true,
            })
          : { messages: [], commit: () => true };
      // output EPIPE 可能发生在 subscribe handler 在途期间。fail() 已清过
      // 当时的 outbox，但迟到 handler 仍可能新建 request entry；这里先 take 精确释放，
      // terminal 时不再写 response/initial，避免 close 后引用泄漏或继续写坏流。
      if (this.terminal) return;
      this.send(response);
      for (const postResponseMessage of postResponseBatch.messages) {
        this.send(postResponseMessage);
      }
      // 旧 outbox 在生成 logical frame 时已推进 publisher 水位。这里以
      // Writable.write() 未同步抛错作为“进入本 connection-owned queue”的 admission；
      // 后续异步 EPIPE 会终结整个 connection epoch，旧 subscription 不会在新管道复用。
      if (!this.terminal) postResponseBatch.commit();
    }
  }

  // 传输层自产错误响应（-32700/-32600）：id 用固定占位串而非请求 id，
  // 因为此时消息可能根本没有可解析的 id。
  private sendError(id: string, code: number, message: string, data?: unknown): void {
    this.send({
      error: {
        code,
        data,
        message,
      },
      id,
    });
  }
}
