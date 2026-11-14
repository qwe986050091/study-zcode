// INV-01 遥测出口是单一回调：守住位置 模块级引用；改错故障 各处自行上报造成双计。
// INV-02 未安装回调时静默：守住位置 可选调用；改错故障 无上报环境抛错。
// INV-03 观察对象只承载事实：守住位置 接口字段；改错故障 上报携带业务数据。
// INV-04 耗时归一到非负整数：守住位置 取整与下界；改错故障 时钟回拨产生负耗时。
// INV-05 接口名由频道与命令拼接：守住位置 字符串模板；改错故障 无人能定位慢接口。
// INV-06 成功不填错误类型：守住位置 三元表达式；改错故障 成功记录带旧错误。
// INV-07 错误分类按关键字降级：守住位置 消息小写比较；改错故障 分类遗漏时抛错。
// INV-08 没有匹配归为其他：守住位置 兜底返回；改错故障 未知错误被丢弃。
// INV-09 服务端装饰只包调用：守住位置 转发方法；改错故障 监听事件被重复注册。
// INV-10 成功与失败都上报：守住位置 两个分支；改错故障 失败调用没有耗时数据。
// INV-11 异常原样再抛：守住位置 捕获后重抛；改错故障 遥测把错误吞掉。
// INV-12 客户端装饰可选：守住位置 类注释；改错故障 两端同时包装导致双计。
// INV-13 频道按名称逐层包装：守住位置 注册参数；改错故障 遥测丢失频道名。
// INV-14 就绪转发保持幂等：守住位置 可选调用；改错故障 重复就绪抛错。
// INV-15 包装不改变调用签名：守住位置 泛型透传；改错故障 返回值类型收窄。
// INV-16 通道获取不缓存：守住位置 每次查询；改错故障 旧通道绕过遥测。
// INV-17 错误分类不读取堆栈：守住位置 仅用消息；改错故障 上报泄露路径信息。
// INV-18 传输种类固定枚举：守住位置 类型别名；改错故障 上报端收到未知传输。
//
// 模块职责：为 RPC 调用装饰服务端与客户端通道，产出按接口聚合的网络遥测。
// 状态所有权：上报回调是模块级单例，由宿主在启动时安装或清空。
// 阅读顺序：先看观察结构与上报入口，再看错误分类，最后看两个装饰器。
/**
 * RPC 调用网络遥测：记录 channel.command 级成功率与耗时，供桌面主进程聚合上报 ARMS。
 */
import type { IChannelServer, IChannelClient, IChannel, IServerChannel } from "./channels.js";
import type { CancellationToken } from "./foundation.js";
import { Event } from "./foundation.js";

export type NetworkTransportKind = "http" | "websocket" | "rpc";

// NetworkObservation 只描述单次 RPC 调用的结果，不带业务数据。
// 分阶段耗时由 http 链路填写，dnsMs、tcpMs 等字段允许缺席。
// transport 取 http/websocket/rpc，用于区分上报来源。
export interface NetworkObservation {
  transport: NetworkTransportKind;
  interface: string;
  durationMs: number;
  ok: boolean;
  statusCode?: number;
  errorKind?: string;
  attempt?: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  downloadMs?: number;
}

export type NetworkTelemetrySink = (observation: NetworkObservation) => void;

let networkTelemetrySink: NetworkTelemetrySink | null = null;

export function setNetworkTelemetrySink(sink: NetworkTelemetrySink | null): void {
  networkTelemetrySink = sink;
}

export function emitNetworkTelemetryObservation(observation: NetworkObservation): void {
  networkTelemetrySink?.(observation);
}

// classifyErrorKind 先把 message 转小写再匹配关键字。
// timeout 分支先于 dns 与 connection 判断，避免误分类。
// 三个分支都不命中时返回 other，不丢弃原始错误。
function classifyErrorKind(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("dns") || message.includes("getaddrinfo") || message.includes("enotfound")) {
    return "dns_failure";
  }
  if (
    message.includes("econnreset") ||
    message.includes("connection reset") ||
    message.includes("econnrefused")
  ) {
    return "connection_reset";
  }
  return "other";
}

function emitRpcObservation(
  channelName: string,
  command: string,
  durationMs: number,
  ok: boolean,
  error?: unknown,
): void {
  emitNetworkTelemetryObservation({
    transport: "rpc",
    interface: `${channelName}.${command}`,
    durationMs: Math.max(0, Math.round(durationMs)),
    ok,
    errorKind: ok ? undefined : classifyErrorKind(error),
    attempt: 1,
  });
}

// inner.call 成功后才按 ok=true 上报，返回值原样返回。
// 失败分支先 emitRpcObservation 再 throw，遥测不吞错误。
// listen 直接转发 inner.listen，事件流不做重复计时。
class NetworkTelemetryServerChannel<TContext> implements IServerChannel<TContext> {
  constructor(
    private inner: IServerChannel<TContext>,
    private channelName: string,
  ) {}

  async call<T>(
    ctx: TContext,
    command: string,
    arg?: unknown,
    cancellationToken?: CancellationToken,
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(ctx, command, arg, cancellationToken);
      emitRpcObservation(this.channelName, command, performance.now() - start, true);
      return result;
    } catch (error) {
      emitRpcObservation(this.channelName, command, performance.now() - start, false, error);
      throw error;
    }
  }

  listen<T>(ctx: TContext, event: string, arg?: unknown): Event<T> {
    return this.inner.listen<T>(ctx, event, arg);
  }
}

class NetworkTelemetryChannel implements IChannel {
  constructor(
    private inner: IChannel,
    private channelName: string,
  ) {}

  async call<T>(command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
    const start = performance.now();
    try {
      const result = await this.inner.call<T>(command, arg, cancellationToken);
      emitRpcObservation(this.channelName, command, performance.now() - start, true);
      return result;
    } catch (error) {
      emitRpcObservation(this.channelName, command, performance.now() - start, false, error);
      throw error;
    }
  }

  listen<T>(event: string, arg?: unknown): Event<T> {
    return this.inner.listen<T>(event, arg);
  }
}

/** 装饰 ChannelServer，为 RPC call 写入网络遥测 */
// registerChannel 用 channelName 构造 NetworkTelemetryServerChannel。
// ready 转发给 inner.ready?.()，内层未实现时静默跳过。
// 包装器实现与 inner 相同的 IChannelServer 接口，调用方无感。
export class NetworkTelemetryChannelServer<TContext = string> implements IChannelServer<TContext> {
  constructor(private inner: IChannelServer<TContext>) {}

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.inner.registerChannel(
      channelName,
      new NetworkTelemetryServerChannel(channel, channelName),
    );
  }

  ready(): void {
    this.inner.ready?.();
  }
}

/** 装饰 ChannelClient（renderer 侧可选，与 server 侧二选一即可避免双计） */
export class NetworkTelemetryChannelClient implements IChannelClient {
  constructor(private inner: IChannelClient) {}

  getChannel<T extends IChannel>(channelName: string): T {
    const channel = this.inner.getChannel<T>(channelName);
    return new NetworkTelemetryChannel(channel as unknown as IChannel, channelName) as unknown as T;
  }
}
