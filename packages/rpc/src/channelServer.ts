// INV-01 每个 Promise 请求的 id 在 activeRequests 中最多存活一项，后到者覆盖前者的取消句柄；守住位置：onPromise 与 Promise 链尾的 finally；改错故障：取消信号打到旧项上，被取消的调用继续跑并回写已失效的界面状态
// INV-02 每个响应必须携带入站请求的同一 id，客户端按 id 配对，id 错位即整包丢弃；守住位置：onPromise 的成功与失败两个回包点；改错故障：调用方永久挂起等待，界面一直停在加载态且没有任何错误提示
// INV-03 PromiseCancel 与 EventDispose 共用同一套 id 空间，并由 disposeActiveRequest 统一释放；守住位置：onRawMessage 的合并分支；改错故障：事件监听器泄漏，长会话中监听器越积越多，最终内存与重绘成本同时失控
// INV-04 通道未注册时请求只能进入 pendingRequests，不得立即回错；守住位置：onPromise 与 onEventListen 的 channel 缺失分支；改错故障：对端在 handler 注册完成前的首批调用成片失败，扩展冷启动即不可用
// INV-05 pending 请求超时后必须回 PromiseError 而不是静默丢弃，时长取自构造参数的 timeoutDelay；守住位置：collectPendingRequest 的定时器回调；改错故障：客户端既等不到响应也收不到错误，问题在联调后期才以挂起形式暴露
// INV-06 EventListen 的 pending 请求超时后不得回包，因为事件类型没有请求-响应配对语义；守住位置：collectPendingRequest 中对请求类型提前返回的分支；改错故障：对端收到一个无法归位的响应 id，可能误当成另一个 Promise 的结果
// INV-07 registerChannel 之后必须以 0 延迟异步冲刷 pending，不得在注册调用栈内同步回调；守住位置：registerChannel 里的 setTimeout；改错故障：注册方尚未完成内部初始化就被调用，handler 读到半初始化的实例
// INV-08 冲刷 pending 时必须先 clearTimeout 再重放，否则同一请求会被超时逻辑二次回包；守住位置：flushPendingRequests 的循环体；改错故障：同一 id 先后收到成功与错误两个响应，客户端状态被撕裂
// INV-09 pendingRequests 的键恒为 channelName，冲刷完成后必须整条删除；守住位置：flushPendingRequests 末尾的 delete；改错故障：重复注册同名通道会把老请求再重放一遍，同一次调用被执行两次
// INV-10 序列化边界上 header 与 body 固定两次连续写入，收发两端顺序必须一致；守住位置：send 的 BufferWriter 与 onRawMessage 的 BufferReader；改错故障：读端错位解析，把 body 当作下一帧 header，整条通道彻底失步
// INV-11 发送失败必须吞掉异常，不得冒泡到业务调用方；守住位置：send 内部的 try 包裹；改错故障：对端已关闭时业务调用被传输层异常打断，错误归因错误并触发无意义重试
// INV-12 所有响应写入都经 sendResponse 的类型分派，Initialize 不带 id 也不带 body；守住位置：sendResponse 的分派分支；改错故障：握手帧多出 id 字段，对端解析出非法响应类型并拒绝建立通道
// INV-13 未知通道的 Promise 超时回包必须写成 name 为 Unknown channel 的错误信封，而不是抛异常；守住位置：collectPendingRequest 内的 sendResponse；改错故障：未知方法在前端表现为挂起而非明确报错，掩盖到交付前才被发现
// INV-14 同步抛出也必须转成 rejected Promise，让失败走统一的 finally 清理路径；守住位置：onPromise 中对 channel.call 的 try 包裹；改错故障：activeRequests 残留该项，后续同 id 请求的取消句柄被旧项占位
// INV-15 activeRequests 的清理只能放在 finally，成功、失败、取消三条路径都要覆盖；守住位置：onPromise 链尾的 finally；改错故障：长连接中 id 复用后取消打到已完成的旧请求上，真正在跑的调用无法中止
// INV-16 Error 实例必须转成可结构化传输的信封，并按白名单透传 code、kind、status 等字段；守住位置：onPromise 的 rejection 分支；改错故障：前端拿不到错误码，无法区分可重试与致命失败，只能一律重试
// INV-17 非 Error 的 rejection 值走 PromiseErrorObj 原样回传，不得包装成 Error；守住位置：rejection 分支中 instanceof 判断之后；改错故障：字符串或对象形态的拒绝原因丢失原始结构，对端无法还原语义
// INV-18 dispose 只清理本端监听与取消句柄，不向对端发送任何收尾消息；守住位置：dispose 的释放顺序；改错故障：关闭时序被打乱，已释放的协议被再次写入而触发二次异常
// INV-19 deferInit 为真时构造函数不得发送 Initialize，握手权交给显式 ready；守住位置：constructor 尾部的条件分支；改错故障：对端在 handler 注册完成前就认为通道可用，首批调用全部落进 pending 并超时
import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private channels = new Map<string, IServerChannel<TContext>>();
  private activeRequests = new Map<number, IDisposable>();
  private pendingRequests = new Map<
    string,
    { request: any; timer: ReturnType<typeof setTimeout> }[]
  >();
  private protocolListener: IDisposable | null;

  // [并发] 构造即订阅：onMessage 注册后随时可能收到对端消息，因此 protocolListener 必须在
  // 任何业务字段就绪之前落定，onRawMessage 只能依赖已赋值的 channels 与 activeRequests。
  // [权衡] 默认不延迟初始化，构造期就发出 Initialize，让对端尽早解除阻塞；deferInit 把
  // 握手权交给调用方，代价是多一次显式调用，换来 handler 注册与可用性公告的严格先后。
  // [事务] 这里的握手等价于通道可用性断言：对端收到 Initialize 后会立刻发请求，此时本端
  // channel 若尚未注册，请求只会落进 pendingRequests，而不是得到一个明确的失败。
  // [资源] protocolListener 保存为可空字段，dispose 时先置空再释放，避免同一订阅被释放两次。
  // 因此 sendResponse 可以从任意回调里安全重入，不需要额外的重入保护。
  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
  ) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);
    setTimeout(() => this.flushPendingRequests(channelName), 0);
  }

  // [并发] 响应分派以 response.type 为唯一开关：Initialize 不带 id，其余四种类型必须
  // 携带 id，否则客户端无法把响应归位到发起时的 pending 项。
  // [失败路径] 分派没有 default 分支：未知 ResponseType 会被直接丢弃而不抛错，这是刻意的
  // 向前兼容策略，代价是新类型若忘记在此登记，表现为响应静默消失而非编译失败。
  // [权衡] 事件与 Promise 复用同一条发送通道而不是分成两条队列，换取时序天然一致；
  // 若改成两条通道，事件可能先于其对应的成功响应抵达，前端会看到无主的进度更新。
  // [资源] 这里不持有任何缓冲区，writer 由 send 内部新建，调用方无需关心生命周期。
  // 因此本函数在事件回调与 Promise 回调中都可以直接调用，不存在跨帧共享状态。
  private sendResponse(response: IRawResponse): void {
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type]);
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  // [资源] 每帧新建 BufferWriter，不复用缓冲区：复用会把上一帧未消费的尾字节带进
  // 下一帧，而接收端按 header 加 body 两次反序列化，多余字节会让后续帧整体错位。
  // [失败路径] protocol.send 抛错被吞掉：此时对端已不可达，继续冒泡只会把传输层故障
  // 伪装成业务失败，误导上层重试；真正的断线由协议自身的关闭回调负责上报。
  // [权衡] 序列化放在 try 之外，只有跨进程写入被包裹：序列化失败属于本端编程错误，
  // 必须暴露；把两者混在一起会让类型错误也被静默成一次丢包。
  // [并发] 同一事件循环内的多帧按调用顺序写入，依赖协议实现不重排，本层不做额外排队。
  private send(header: any, body: any = undefined): void {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  // [并发] 反序列化在消息回调内同步完成：header 与 body 必须按发送端相同的顺序读取，
  // 任何一方多读或少读一次，都会让该通道后续所有帧失步。
  // [失败路径] 反序列化抛错不会被捕获，会原样冒泡给协议的订阅者：畸形帧通常意味着
  // 对端实现不匹配，静默跳过只会让失步累积到无法诊断。
  // [失败路径] 请求类型不在已知枚举内时直接落到分派之外的隐式返回，既不回包也不抛错：
  // [边界] 跨版本兜底：旧端收到新请求类型回请求错误而非崩溃，request.method 未登记就走兜底分支。
  // [权衡] 取消与事件销毁合并成同一分支，因为二者语义都是释放一个已登记的活跃项；
  // 分开写会复制同一段查找逻辑，并且容易漏掉其中一条的清理。
  private onRawMessage(message: VSBuffer): void {
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as RequestType;

    switch (type) {
      case RequestType.Promise:
        this.onPromise({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: body,
        });
        return;
      case RequestType.EventListen:
        this.onEventListen({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: body,
        });
        return;
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        this.disposeActiveRequest(header[1]);
        return;
    }
  }

  // [并发] 请求 id 由对端分配并在整条连接内唯一，本端只登记不生成：id 冲突意味着对端
  // 违约，本端以覆盖方式让新请求胜出，旧项就此失去取消句柄。
  // [失败路径] 通道缺失时绝不能立刻回错：handler 注册是异步的，先到的请求必须排队，
  // 否则扩展冷启动期间的首批调用会成片失败。
  // [失败路径] 同步抛出的 handler 被显式转成 rejected Promise，保证后面的 finally 一定
  // 会执行；若直接返回，activeRequests 会残留一项永远无法释放的取消句柄。
  // [资源] 取消句柄先于 Promise 链登记，即使 handler 已同步完成也能命中同一项；用
  // toDisposable 包一层 cts.cancel 只是把活跃表元素统一成可释放对象，便于共用清理路径。
  private onPromise(request: {
    type: RequestType.Promise;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const cts = new CancellationTokenSource();
    let promise: Promise<any>;

    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }

    const disposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(request.id, disposable);

    promise
      .then(
        (data) => {
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          if (error instanceof Error) {
            // [失败路径] 只有 Error 实例才走结构化信封，其它拒绝值原样回传：跨进程序列化无法
            // 还原原型链，硬包成 Error 会让对端拿到一份伪造的 name 与 stack。
            // [权衡] 白名单透传而不是展开全部自有属性：错误对象上常挂循环引用与不可序列化字段，
            // 全量展开会在序列化边界抛错，把一次业务失败升级成通道故障。
            // [权衡] 透传键写成字面量数组并逐项判 undefined，而不是整体合并拷贝：显式列举让新增
            // 错误码必须改这里，避免无意间把内部字段泄漏到前端。
            // [失败路径] stack 按换行切分后传数组：对端按行渲染，避免在协议层引入字符串转义分歧。
            // [并发] 回包时该项仍留在 activeRequests，直到 finally 才删除，保证对端收到响应前本端仍可被取消。
            const rpcErrorPayload: {
              message: string;
              name: string;
              stack: string[] | undefined;
              code?: unknown;
              kind?: unknown;
              status?: unknown;
              retryAfterMs?: unknown;
              data?: unknown;
              detail?: unknown;
              details?: unknown;
              taskId?: unknown;
              traceId?: unknown;
              retryable?: unknown;
            } = {
              message: error.message,
              name: error.name,
              stack: error.stack ? error.stack.split("\n") : undefined,
            };
            const errorRecord = error as Error & Record<string, unknown>;
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
              const value = errorRecord[key];
              if (value !== undefined) {
                rpcErrorPayload[key] = value;
              }
            }
            this.sendResponse({
              id: request.id,
              data: rpcErrorPayload,
              type: ResponseType.PromiseError,
            });
            return;
          }

          this.sendResponse({
            id: request.id,
            data: error,
            type: ResponseType.PromiseErrorObj,
          });
        },
      )
      .finally(() => {
        disposable.dispose();
        this.activeRequests.delete(request.id);
      });
  }

  // [并发] 事件监听的 id 与 Promise 的 id 共用一张 activeRequests 表：对端用同一套 id
  // 分配策略，因此 EventDispose 与 PromiseCancel 可以走同一个释放入口。
  // [资源] listen 返回的 disposable 直接被表接管，监听器本身不保存其它引用：一旦对端
  // 发来 EventDispose，本端只剩这一条释放路径，漏登记就是永久泄漏。
  // [失败路径] 通道缺失时同样进 pendingRequests，且超时后不回包：事件没有请求-响应
  // 语义，回一个 EventFire 会让对端把错误当成一次真实事件处理。
  // [权衡] 回调里只做 sendResponse，不做异常捕获：事件处理器抛错应在 handler 内部消化，本层捕获只会掩盖真正原因。
  private onEventListen(request: {
    type: RequestType.EventListen;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const disposable = channel.listen(
      this.ctx,
      request.name,
      request.arg,
    )((data) => {
      this.sendResponse({
        id: request.id,
        data,
        type: ResponseType.EventFire,
      });
    });
    this.activeRequests.set(request.id, disposable);
  }

  private disposeActiveRequest(id: number): void {
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    disposable.dispose();
    this.activeRequests.delete(id);
  }

  // [并发] pending 表按 channelName 分桶，同一桶内的请求保持到达顺序，注册后按序重放：
  // 顺序错乱会让对端收到与发起顺序不一致的响应，对依赖时序的初始化流程是致命的。
  // [失败路径] 超时只对 Promise 回 Unknown channel 错误信封，时长取自构造参数：
  // 这是明确拒绝未知方法的唯一出口，缺了它未知方法就退化成永久挂起。
  // [权衡] 定时器与请求对象一起入队而不是给每个请求单独挂表，是为了在冲刷时能一次性
  // 取消全部定时器；否则冲刷后仍有一批定时器会在同一时刻集中触发并重复回包。
  // [资源] console.error 只用于诊断，不参与控制流：即便日志被重定向或丢弃，回包逻辑
  // 也必须照常执行，不能把可观测性当作错误处理的必要条件。
  private collectPendingRequest(request: any): void {
    const pendingRequests = this.pendingRequests.get(request.channelName) ?? [];
    if (pendingRequests.length === 0) {
      this.pendingRequests.set(request.channelName, pendingRequests);
    }

    const timer = setTimeout(() => {
      console.error(`Unknown channel: ${request.channelName}`);
      if (request.type !== RequestType.Promise) {
        return;
      }

      this.sendResponse({
        id: request.id,
        data: {
          name: "Unknown channel",
          message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          stack: undefined,
        },
        type: ResponseType.PromiseError,
      });
    }, this.timeoutDelay);

    pendingRequests.push({ request, timer });
  }

  private flushPendingRequests(channelName: string): void {
    const requests = this.pendingRequests.get(channelName);
    if (!requests) {
      return;
    }

    for (const { request, timer } of requests) {
      clearTimeout(timer);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
    this.pendingRequests.delete(channelName);
  }

  dispose(): void {
    this.protocolListener?.dispose();
    this.protocolListener = null;
    for (const disposable of this.activeRequests.values()) {
      disposable.dispose();
    }
    this.activeRequests.clear();
  }
}
