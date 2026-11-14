// INV-01 请求 id 由 lastRequestId 单调递增分配，Promise 调用与事件监听共用同一计数器与 handlers 表；守住位置：requestPromise 与 requestEvent 的 id 赋值行；改错故障：两类响应撞号，事件数据被 Promise 回调吞掉或反之，调用方永久挂起。
// INV-02 每个 id 对应的 handler 必须在成功、失败、取消、dispose 四条路径上删除，不得残留；守住位置：requestPromise 内三个 ResponseType 分支与取消回调；改错故障：handlers 表随调用量无界增长，内存泄漏且旧 handler 抢走新响应。
// INV-03 只有 Promise 请求登记 pendingRejections，事件监听故意不登记；守住位置：requestPromise 内的 set 调用与 requestEvent 不写该表；改错故障：dispose 把事件订阅当作挂起请求拒绝，抛出无人处理的 Promise 拒绝。
// INV-04 dispose 必须对所有 pendingRejections 逐个拒绝后再清空，实现 fail-closed；守住位置：dispose 中遍历 pendingRejections 的循环；改错故障：握手前发出的 RPC 永久 pending，上层去重表永久占用 workspace key。
// INV-05 取消路径先校验 pendingRejections 是否仍持有该 id，已完成的请求不得再发送 PromiseCancel；守住位置：onCancellationRequested 回调开头的 has 判断；改错故障：对已完成 id 发送取消帧，服务端报未知请求或误取消复用 id 的新请求。
// INV-06 state 非 Idle 时请求必须挂起到 onDidInitialize，不能在未握手的传输上直接写帧；守住位置：requestPromise 与 requestEvent 里的 state 分支；改错故障：首帧在 Initialize 之前写出，服务端丢弃或协议解析错位。
// INV-07 doRequest 发送前必须复检 isDisposed 与 pendingRejections 归属，防止等待期间的翻转；守住位置：两处 doRequest 闭包开头的早返回；改错故障：已 dispose 的连接仍写出请求，对应 Promise 无人拒绝。
// INV-08 protocolListener 在 dispose 中先摘除再置 null，保证入站消息只有一条入口；守住位置：dispose 内对 protocolListener 的处理；改错故障：终结后仍接收响应，已清表的回调落空或重复触发初始化。
// INV-09 传输写失败必须被吞掉而不是抛出，因为写异常不代表协议错误；守住位置：sendRequest 与 sendCancelOrDispose 的 try/catch；改错故障：写失败异常冒泡到调用方，与 Promise 的 reject 语义冲突造成双重失败。
// INV-10 Initialize 帧只允许把 state 推进到 Idle 并广播 onDidInitialize；守住位置：onResponse 的 Initialize 分支；改错故障：重复初始化或状态回退，等待队列提前放行或永不放行。
// INV-11 whenInitialized 在已 Idle 时必须立即完成，不得再订阅事件；守住位置：whenInitialized 的早返回；改错故障：Idle 之后仍等待下一次初始化，请求永久不发出。
// INV-12 事件监听的注册与注销跟随监听者数量，首次监听才发 EventListen，最后一个监听移除才发 EventDispose；守住位置：Emitter 的两个生命周期回调；改错故障：同一事件被重复订阅产生多份推送，或提前注销让后续监听收不到数据。
// INV-13 dispose 必须幂等，重复调用不得二次拒绝或二次释放监听器；守住位置：dispose 开头的 isDisposed 判断；改错故障：上层多条清理路径触发时抛出已释放错误或重复回调。
// INV-14 非 Initialize 的响应必须按 id 精确路由，未知 id 静默丢弃；守住位置：onResponse 末尾的 handlers 查找；改错故障：迟到响应被错投，或抛异常打断同批消息的处理。
// INV-15 入站帧的 header 与 body 必须按写入顺序反序列化两次；守住位置：onBuffer 中的两次 deserialize 调用；改错故障：id 与响应类型错位，消息静默丢失且没有日志。
// INV-16 请求结束后取消令牌订阅必须释放并从 activeRequests 摘除；守住位置：返回 Promise 的 finally；改错故障：长生命周期令牌持续持有已完成的请求闭包，内存与监听泄漏。
// INV-17 PromiseError 必须还原 name、stack 与白名单透传字段，不能只保留 message；守住位置：PromiseError 分支与 passthroughKeys 列表；改错故障：上层按 code 或 retryable 分支的重试与提示全部失效。
// INV-18 dispose 传入 reason 时原样使用，未传时统一构造 ConnectionClosed 命名的错误；守住位置：dispose 中 rejection 的构造；改错故障：传输断开被上层误判为业务错误，重连逻辑无法识别连接终结。
//
// 模块职责：实现 RPC 通道客户端，把通道名与命令封装成 Promise 请求和事件流，并在同一条协议连接上完成握手、响应路由、取消与终结。
// 状态所有权：本文件独占 state、isDisposed、lastRequestId、handlers、pendingRejections、activeRequests 与 protocolListener，外部只通过 getChannel、onDidInitialize、dispose 交互。
// 阅读顺序：先看 State 与字段声明理解状态机，再读 getChannel 的两个入口，随后 requestPromise 的成功、错误、取消路径，最后看 onBuffer 与 dispose 的终结语义。
import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter, type IDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannel,
  type IChannelClient,
  type IHandler,
  type IRawResponse,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

// 两态状态机：Uninitialized 表示尚未收到服务端 Initialize，Idle 表示握手完成、请求可以立即写出。
// 状态只能单向推进，重连由上层新建实例承担，本实例不提供回退到 Uninitialized 的路径，避免出现半握手的中间态。
enum State {
  Uninitialized,
  Idle,
}

// 同时实现 IChannelClient 与 IDisposable：前者向调用方交出通道代理，后者把连接生命周期的终结权显式交给持有者而不是交给 GC。
export class ChannelClient implements IChannelClient, IDisposable {
  // state 的唯一写入点是 Initialize 分支，其余代码只读；单线程事件循环保证一次响应处理中读到的值不会中途变化，因此无需加锁。
  private state = State.Uninitialized;
  private isDisposed = false;
  // [资源] activeRequests 收集两类可释放对象：取消令牌订阅与事件 Emitter，dispose 时逐个释放，保证不留悬挂监听。
  private activeRequests = new Set<IDisposable>();
  // handlers 以请求 id 为键，同时容纳 Promise 的单次回调与事件的长驻回调，是响应分发的唯一依据。
  private handlers = new Map<number, IHandler>();
  // Promise 请求和事件监听共用 handlers，但只有前者需要在连接终结时 reject。
  // 单独维护 reject map，避免 dispose 把事件订阅误当成挂起的 RPC 请求。
  // 只有仍未结算的 Promise 请求登记在这里，事件监听故意不登记，这是区分单次请求与长驻订阅的唯一凭据。
  // [权衡] 选 Map 而非数组是为了按 id 常数时间摘除，避免 dispose 时线性扫描全部历史请求。
  private pendingRejections = new Map<number, (error: Error) => void>();
  // id 从 0 开始单调递增且进程内不复用；即使 handler 已删除，迟到的同 id 响应也只会被静默丢弃而不会错投。
  private lastRequestId = 0;
  private protocolListener: IDisposable | null;

  private readonly _onDidInitialize = new Emitter<void>();
  readonly onDidInitialize = this._onDidInitialize.event;

  // 构造函数只做订阅入站消息并保存句柄，不发送任何帧，也不主动触发握手，连接方向完全由对端驱动。
  constructor(private protocol: IMessagePassingProtocol) {
    // 所有入站字节流都从这里进入，onBuffer 是唯一解析入口，因此消息处理天然串行、不会重入。
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));
  }

  // 工厂方法不缓存代理，每次调用返回新的对象字面量；channelName 被闭包捕获，后续 call 与 listen 共享同一通道名。
  getChannel<T extends IChannel>(channelName: string): T {
    return {
      call: (command: string, arg?: any, cancellationToken?: CancellationToken) => {
        // [失败路径] call 入口先判终结并同步返回被拒绝的 Promise 而非抛出，同时不分配 id、不登记 handler，避免为死连接积攒无主条目。
        if (this.isDisposed) {
          return Promise.reject(new Error("ChannelClient is disposed"));
        }
        return this.requestPromise(channelName, command, arg, cancellationToken);
      },
      listen: (event: string, arg?: any) => {
        if (this.isDisposed) {
          // listen 在终结后返回空事件而不是报错，订阅方无需判空即可安全继续；这是与 call 有意不对称的取舍。
          return Event.None;
        }
        return this.requestEvent(channelName, event, arg);
      },
    } as T;
  }

  // Promise 请求的主路径固定为四步：分配 id、构造延迟 Promise、准备发送闭包、挂取消监听，顺序不可调换。
  // 先建 Promise 再决定立即发送还是等待初始化，保证任何分支下调用方都能先拿到句柄，不会出现同步抛错与异步拒绝混用。
  private requestPromise(
    channelName: string,
    name: string,
    arg?: any,
    cancellationToken = CancellationToken.None,
  ): Promise<any> {
    // 在取消判断之前取号，使被取消的调用同样占用一个 id；代价是消耗序号，收益是后续分支无需回滚计数器。
    const id = this.lastRequestId++;

    // 已取消的令牌直接拒绝，既不登记 handler 也不写入 pendingRejections，因此不会向传输发送任何帧。
    if (cancellationToken.isCancellationRequested) {
      return Promise.reject(new Error("Cancelled"));
    }

    // 句柄声明在执行器之外，便于最后在 finally 中统一释放；声明可空是为了覆盖执行器提前返回的路径。
    let disposable: IDisposable | undefined;
    const result = new Promise<any>((resolve, reject) => {
      // 登记先于发送：即使对端在同一个 tick 内回帧，handler 也一定能在表里找到对应的待决项。
      this.pendingRejections.set(id, reject);
      const doRequest = () => {
        // dispose/cancel 可能发生在 Initialize 之前；此时不能再把已经 rejected
        // 的请求发送到新连接或已终结的传输上。
        // [并发] 等待 Initialize 期间可能发生 dispose 或取消，两者都会移除表项；此处复检是拦住已死请求的唯一关卡。
        // [失败路径] 早返回既不 resolve 也不 reject，因为对应拒绝已在 dispose 或取消回调中执行过，重复拒绝会被忽略并掩盖真实原因。
        if (this.isDisposed || !this.pendingRejections.has(id)) {
          return;
        }

        const handler: IHandler = (response) => {
          switch (response.type) {
            // 成功与错误分支都先摘除 handler 与 pendingRejections 再结算，防止结算过程触发的重入读到半清理状态。
            case ResponseType.PromiseSuccess:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              resolve(response.data);
              return;
            case ResponseType.PromiseError: {
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              const error = new Error(response.data.message) as Error & Record<string, unknown>;
              error.name = response.data.name;
              if (response.data.stack) {
                error.stack = response.data.stack.join("\n");
              }
              // [权衡] 只透传固定白名单字段，避免把服务端错误对象的任意属性复制到本地错误上；新增可重试语义字段时必须同步此表。
              const passthroughKeys = [
                "code",
                "kind",
                "status",
                "retryAfterMs",
                "data",
                "detail",
                "details",
                "taskId",
                "traceId",
                "retryable",
              ] as const;
              for (const key of passthroughKeys) {
                const value = response.data[key];
                if (value !== undefined) {
                  error[key] = value;
                }
              }
              reject(error);
              return;
            }
            case ResponseType.PromiseErrorObj:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(response.data);
              return;
          }
        };

        // handler 注册与请求发送紧邻且中间没有 await，否则响应可能先于注册到达而被当成未知 id 丢弃。
        this.handlers.set(id, handler);
        this.sendRequest(RequestType.Promise, id, channelName, name, arg);
      };

      // Idle 时同步发送以省掉一次微任务；否则走 whenInitialized 把请求排队到握手完成之后。
      if (this.state === State.Idle) {
        doRequest();
      } else {
        this.whenInitialized().then(doRequest);
      }

      // [资源] 订阅挂在调用方提供的令牌上，令牌生命周期可能长于本请求，因此必须在 finally 中退订。
      // 取消回调里不删除 activeRequests，统一留给 finally 收口，避免同一句柄被两条路径重复释放。
      disposable = cancellationToken.onCancellationRequested(() => {
        if (!this.pendingRejections.has(id)) {
          return;
        }
        this.sendCancelOrDispose(RequestType.PromiseCancel, id);
        this.handlers.delete(id);
        this.pendingRejections.delete(id);
        reject(new Error("Cancelled"));
      });
      this.activeRequests.add(disposable);
    });

    // [资源] finally 是唯一清理收口：成功、失败、取消、dispose 引发的拒绝都会走到这里，退订与摘除只在这里发生一次。
    return result.finally(() => {
      disposable?.dispose();
      if (disposable) {
        this.activeRequests.delete(disposable);
      }
    });
  }

  // 事件路径没有 Promise 也没有 pendingRejections 登记，它的生命周期由监听者数量驱动，而不是由单次结算驱动。
  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    const id = this.lastRequestId++;
    const emitter = new Emitter<any>({
      // [并发] 只有首个监听者触发时才发送 EventListen，避免同一事件被重复订阅导致远端多份推送。
      onWillAddFirstListener: () => {
        const doRequest = () => {
          this.activeRequests.add(emitter);
          this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
        };

        if (this.state === State.Idle) {
          doRequest();
        } else {
          this.whenInitialized().then(doRequest);
        }
      },
      // 最后一个监听者移除时注销远端订阅并删除 handler；若不删除，Emitter 与 id 会永久留在表中。
      onDidRemoveLastListener: () => {
        this.activeRequests.delete(emitter);
        this.sendCancelOrDispose(RequestType.EventDispose, id);
        this.handlers.delete(id);
      },
    });

    this.handlers.set(id, (response) => {
      // 事件响应只取 data 直接广播，不做运行时形态校验，类型契约由通道接口在编译期保证。
      emitter.fire((response as { data: any }).data);
    });

    return emitter.event;
  }

  private sendRequest(
    type: RequestType,
    id: number,
    channelName: string,
    name: string,
    arg?: any,
  ): void {
    // [并发] 每次发送都新建写入器而不复用缓冲区，避免两个未完成的帧在共享缓冲区上互相覆盖。
    const writer = new BufferWriter();
    serialize(writer, [type, id, channelName, name]);
    serialize(writer, arg);
    try {
      this.protocol.send(writer.buffer);
    // [失败路径] 写失败被静默吞掉，因为对端断开最终会由 dispose 统一拒绝全部待决请求，在此重复报错只会产生双份错误。
    } catch {
      /* noop */
    }
  }

  private sendCancelOrDispose(
    type: RequestType.PromiseCancel | RequestType.EventDispose,
    id: number,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id]);
    serialize(writer, undefined);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  // 入站帧固定为 header 加 body 两段，解析顺序与 sendRequest 的写入顺序严格对称，改动任一侧都必须同步另一侧。
  private onBuffer(message: VSBuffer): void {
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as ResponseType;

    // 只处理 Initialize 与四类响应，其余类型静默忽略，避免未来新增帧类型打乱本地状态机。
    switch (type) {
      case ResponseType.Initialize:
        // Initialize 帧不携带 id 与 body，因此单独构造一个最小响应对象交给统一入口，保证状态推进只有一条路径。
        this.onResponse({ type: ResponseType.Initialize });
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.onResponse({
          type,
          id: header[1],
          data: body,
        } as IRawResponse);
        return;
    }
  }

  private onResponse(response: IRawResponse): void {
    if (response.type === ResponseType.Initialize) {
      this.state = State.Idle;
      this._onDidInitialize.fire();
      return;
    }

    // [失败路径] 未知或已删除的 id 静默丢弃，迟到的成功响应不会把已取消的请求重新唤醒。
    this.handlers.get(response.id)?.(response);
  }

  // 已 Idle 时立即完成，否则等待一次初始化事件；该等待不会被取消，只会在 dispose 时随发射器一起失效。
  private whenInitialized(): Promise<void> {
    if (this.state === State.Idle) {
      return Promise.resolve();
    }
    // [权衡] 用事件转 Promise 而不是维护显式等待队列，省掉队列的清理逻辑，代价是 dispose 时无法主动唤醒等待者。
    return Event.toPromise(this.onDidInitialize);
  }

  // 终结顺序固定为：置标志、摘监听、拒绝待决、释放活动对象、清表、释放发射器；顺序颠倒会留下仍可触达的旧回调。
  dispose(reason?: Error): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    // [资源] 先断开入站通道再清理表项，确保后续不会有新响应插入正在被遍历的集合。
    this.protocolListener?.dispose();
    this.protocolListener = null;

    // 未传原因时统一构造名称是 ConnectionClosed 的错误，让上层能把传输终结与业务失败区分开。
    const rejection = reason ?? new Error("ChannelClient disposed");
    if (!reason) {
      rejection.name = "ConnectionClosed";
    }
    // 传输已终结时，所有已发出以及排队等待 Initialize 的 Promise 请求都必须
    // fail-closed。否则上层的 in-flight 去重 Promise 会永久占用 workspace key。
    // [并发] 一边遍历一边删除当前键是安全的，Map 迭代器允许这种写法；这样排队等待初始化的请求也不会被漏掉。
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id);
      this.handlers.delete(id);
      reject(rejection);
    }
    for (const disposable of this.activeRequests) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    this.pendingRejections.clear();
    // [顺序] _onDidInitialize.dispose() 放在最后：先前已拒掉 pendingRejections 并清空 activeRequests；握手等待者可能静默挂起，属已知取舍。
    this._onDidInitialize.dispose();
  }
}
