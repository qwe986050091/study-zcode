// web-remote-relay 设备侧传输层：必须维护单条到 relay 的 V2 WebSocket，负责鉴权、配对、心跳与消息转发。
// 状态机由 state 与 generation 共同定义：generation 单调递增，旧代回调必须在任何 await 之后被丢弃。
// 本层不持有任务队列与快照，只把 relay 帧桥接为 onPayload 与 onRawTransportPayload 回调。
// 约束：所有重连路径共用 retry 策略与 closeSocket，避免多路写入互相覆盖定时器与 socket。
// INV-01 单实例只持有一条 relay 连接；守住位置：start 的 controller 判空；改错故障：重复启动造成双连接并互相踢下线
// INV-02 generation 在每次 closeSocket 递增且不可回退；守住位置：closeSocket 与 connect 的代比较；改错故障：旧代 close 关闭新 socket，界面长期停在连接中
// INV-03 await 之后必须复检 signal.aborted 与代值；守住位置：connect 中的 resolveDeviceSid 与 getToken；改错故障：dispose 后仍续传，进程退出却占着 relay 连接
// INV-04 首次注册与失效重注册共用同一连接尝试；守住位置：connect 的 registrationPending 分支；改错故障：网络抖动时注册与握手错位，手机端始终配不上对
// INV-05 注册网络失败必须重试注册而非复用旧 SID；守住位置：AUTH_FAILED 分支置 registrationPending；改错故障：携带失效 SID 反复握手，用户看到无限重连
// INV-06 握手超时由 handshakeTimer 兜底；守住位置：connect 后的定时器与 auth_ack 的清除；改错故障：半开连接永久挂起，配对卡住且无任何错误提示
// INV-07 authenticated 只由本代 auth_ack 置真；守住位置：handleMessage 的 auth_ack 分支；改错故障：未鉴权就转发数据，消息被 relay 静默丢弃
// INV-08 auth_ack 必须校验 device_sid 与当前一致；守住位置：handleMessage 的 auth_ack 守卫；改错故障：串号响应把旧设备的配对状态写到本机
// INV-09 配对完成才允许业务数据上行；守住位置：sendPayloadResult 的 state 检查；改错故障：未配对发送被丢弃，用户输入无响应也无提示
// INV-10 pairedGeneration 仅在 matched 时更新且区分同 socket 与跨 socket；守住位置：auth_ack 与 pair_status_ack 分支；改错故障：重连后未通知 onSendReady，界面一直不可发送
// INV-11 心跳 ACK 超时触发重连而非静默停摆；守住位置：WebRemoteControlV2Heartbeat 的超时回调；改错故障：链路假活，远控画面冻结却仍显示已连接
// INV-12 每次 auth_ack 与 pair_status_ack 都要回执心跳；守住位置：handleMessage 的 acknowledged 调用；改错故障：误判心跳超时，正常链路被反复重连打断
// INV-13 未压缩帧大小须在拼接与解码之前拦截；守住位置：message 回调的 byteLength 检查；改错故障：超大帧先解码后判边，主进程内存被瞬时撑爆
// INV-14 帧归属校验 socket 即当前实例且非二进制；守住位置：open、message、close 回调的首行守卫；改错故障：旧连接残留消息污染新会话状态
// INV-15 rpc-frame 走旁路回调且不进入 app payload 解析；守住位置：handleMessage 的 data 分支；改错故障：RPC 帧被误当业务消息丢弃，远控操作无响应
// INV-16 KICKED 分可退避与终态两种结局；守住位置：error 分支的 kickedDelay 判空；改错故障：被踢后仍无限重连，占用配额且用户无法察觉
// INV-17 不可重试错误必须收敛为 error 态并上报；守住位置：handleConnectionError 的 retryable 判断；改错故障：坏配置下持续重连刷屏，错误原因对用户不可见
// INV-18 重连定时器与握手定时器需成对清理；守住位置：closeSocket 与 dispose；改错故障：泄漏的定时器在 dispose 之后又发起连接
// INV-19 日志与对外错误不得回显带 token 的 URL；守住位置：socket error 回调与 handleConnectionError；改错故障：一次性设备令牌写进日志，凭据外泄
import { WebSocket, type RawData } from "ws";
import {
  WebRemoteControlRelayPayloadSerializer,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  parseWebRemoteControlAppPayload,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import {
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
  WebRemoteControlV2ConnectionError,
  WebRemoteControlV2Heartbeat,
  WebRemoteControlV2RetryPolicy,
  webRemoteControlV2PairState,
  parseWebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2OutgoingMessage,
} from "@zcode/shared/web-remote-relay";
import {
  noteWebRemoteRelayConnectAttempt,
  noteWebRemoteRelayReconnect,
} from "#src/main/desktopNetworkTelemetry.js";

import type {
  WebRemoteControlDeviceTransportState,
  WebRemoteControlDeviceTransportOptions,
} from "#src/main/web-remote-relay/contract.js";

// 资源：RawData 可能是单块 Buffer、Buffer 数组或 ArrayBuffer，三种形态必须分别拼接或零拷贝处理
// 不变量：只有分片数组走 concat，单块路径避免再复制一份缓冲导致内存翻倍
// 失败路径：形态判断遗漏会把 ArrayBuffer 当普通对象传入转换，得到空缓冲并让解析静默失败
function rawBytes(raw: RawData): Buffer {
  return Array.isArray(raw)
    ? Buffer.concat(raw)
    : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
}

// 不变量：generation 单调递增，pairedGeneration 记录最近一次成功配对的代值
// 资源：retry、heartbeat、serializer 必须在构造期一次性绑定，避免每代重建清零退避计数
// 并发：heartbeat 的两个回调来自定时器与消息处理两条路径，状态改动只能经调度方法收敛
// 权衡：字段平铺而非引入状态容器，换取与 relay 协议字段一一对应的可读性
export class WebRemoteControlDeviceTransport {
  private socket?: WebSocket;
  private state: WebRemoteControlDeviceTransportState = "idle";
  private controller?: AbortController;
  private generation = 0;
  private pairedGeneration = 0;
  private connectStartedAt = 0;
  private connectAttempt = 0;
  private deviceSid?: string;
  private authenticated = false;
  private registrationRetried = false;
  private registrationPending = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private readonly retry = new WebRemoteControlV2RetryPolicy();
  private readonly heartbeat = new WebRemoteControlV2Heartbeat(
    () => this.send({ type: "pair_status_query", client_ts: Math.floor(Date.now() / 1000) }),
    () => this.scheduleReconnect(),
  );
  private readonly serializer = new WebRemoteControlRelayPayloadSerializer();

  constructor(private readonly options: WebRemoteControlDeviceTransportOptions) {}

  // 不变量：controller 非空即视为已启动，重复调用直接返回且不产生第二条连接
  // 资源：AbortController 是所有异步步骤的取消信号源，dispose 前必须保持其唯一性
  // 失败路径：缺少幂等判断会让上层重试放大成多条 relay 连接并互相踢下线
  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.connect();
  }

  // 资源：先清重连定时器再关 socket，颠倒顺序会让 close 回调立刻排出一个新定时器
  // 事务：清理顺序必须为定时器、socket、controller、状态，前一步失败不影响后续步骤
  // 不变量：controller.abort 之后所有 await 复检都会短路，残留的 token 结果被丢弃
  // 失败路径：遗漏 heartbeat 的停止逻辑，会让心跳定时器在窗口销毁后继续触发重连
  // 权衡：dispose 后不重置 deviceSid，保留注册结果以缩短下次启动的握手路径
  dispose(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.closeSocket();
    this.controller?.abort();
    this.controller = undefined;
    this.setState("idle");
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    return this.serializer.prepare(payload, Math.floor(Date.now() / 1000)).bytes;
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  // 不变量：先量尺寸再判状态，oversize 与 unavailable 是互斥的两种用户可见结果
  // 失败路径：超限帧直接返回 oversize 而不发送，调用方据此展示裁剪提示
  // 不变量：只有状态为 paired 且 socket 处于 OPEN 时才真正写入帧
  // 权衡：同步返回发送结果而不等待 ACK，可靠性交由上层 RPC 重传负责
  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    const prepared = this.serializer.prepare(payload, Math.floor(Date.now() / 1000));
    if (this.serializer.isOversize(prepared)) {
      return {
        kind: "oversize",
        bytes: prepared.bytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      };
    }
    if (this.state !== "paired" || this.socket?.readyState !== WebSocket.OPEN)
      return { kind: "unavailable" };
    this.socket.send(prepared.json);
    return { kind: "sent", bytes: prepared.bytes };
  }

  // 不变量：进入即关闭旧 socket 并提升代值，确保旧连接的回调全部失效
  // 并发：重连定时器与外部启动可能同时触发本方法，代比较必须负责串行化
  // 资源：socket 建立后立刻武装握手定时器，超时未握手即交给重连策略
  // 失败路径：取令牌抛错走错误处理分支，按 retryable 区分重试与终态
  // 不变量：auth_init 只在 open 事件后发送，且携带本代的 device_sid
  // 失败路径：URL 拼装抛错会被外层捕获，不会留下悬挂的 socket 引用
  // 权衡：开启压缩扩展换取带宽，代价是首帧延迟与额外的 CPU 开销
  // 资源：未配对时断开要记录连接尝试耗时，已配对断开不计入失败统计
  private async connect(): Promise<void> {
    const signal = this.controller?.signal;
    if (!signal || signal.aborted) return;
    this.closeSocket();
    const generation = this.generation;
    this.connectStartedAt = Date.now();
    this.connectAttempt += 1;
    this.setState("connecting");
    try {
      // 首次注册和失效后的重注册共用连接尝试，网络失败均由此处退避，不能在 manager 裸 await。
      if (!this.deviceSid || this.registrationPending) {
        const sid = await this.options.resolveDeviceSid(signal, this.registrationPending);
        if (signal.aborted || generation !== this.generation) return;
        this.deviceSid = sid;
        this.registrationPending = false;
      }
      const deviceSid = this.deviceSid;
      const token = await this.options.getToken(signal);
      if (signal.aborted || generation !== this.generation) return;
      const url = new URL(this.options.relayWsUrl);
      url.searchParams.set("token", token);
      url.searchParams.set("mid", this.options.deviceMid);
      const socket = new WebSocket(url, { perMessageDeflate: true });
      this.socket = socket;
      this.handshakeTimer = setTimeout(
        () => this.scheduleReconnect(),
        WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
      );
      socket.on("open", () => {
        if (socket !== this.socket) return;
        this.setState("authenticating");
        this.send({
          type: "auth_init",
          device_sid: deviceSid,
          meta: this.options.meta,
          client_ts: Math.floor(Date.now() / 1000),
        });
      });
      // 不变量：帧归属与二进制标记的检查先于任何解析，伪帧不会进入消息处理
      // 失败路径：JSON 解析失败直接丢弃该帧，不触发重连也不污染状态
      // 不变量：协议解析函数不通过即视为非法帧，与解析异常同等对待
      // 权衡：单帧解析失败只丢一帧而不重置整链路，牺牲确定性换取抗干扰
      socket.on("message", (raw, isBinary) => {
        if (socket !== this.socket || isBinary) return;
        // 在拼接/解码前检查未压缩字节数，保留 raw frame 的内存边界。
        const byteLength = Array.isArray(raw)
          ? raw.reduce((sum, part) => sum + part.byteLength, 0)
          : raw.byteLength;
        if (byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
          this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(rawBytes(raw).toString("utf8"));
        } catch {
          return;
        }
        const message = parseWebRemoteControlRelayV2IncomingMessage(value);
        if (message) void this.handleMessage(message);
      });
      socket.on("error", () => {
        // WS 错误可能包含一次性 token URL，日志和对外错误只暴露固定原因。
        if (socket === this.socket)
          this.options.logger.warn("[web-remote-control] V2 socket error");
      });
      socket.on("close", () => {
        if (socket !== this.socket) return;
        if (this.state !== "paired") {
          noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, false, {
            attempt: this.connectAttempt,
          });
        }
        this.scheduleReconnect();
      });
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      this.handleConnectionError(error);
    }
  }

  // 不变量：error 类型消息一律终结本次处理，不再进入后续配对分支
  // 不变量：auth_ack 只有处于 authenticating 态且 sid 匹配时才推进配对
  // 失败路径：KICKED 且退避额度耗尽则进入 kicked 终态，等待外部重新启动
  // 并发：注册失效后的立即重试必须以零延迟排期，不叠加退避计数
  // 不变量：未完成鉴权的消息除 auth_ack 外全部丢弃
  // 不变量：data 只在 paired 分支解析，避免配对中途收到半初始化会话的数据
  // 失败路径：payload 解析不通过时静默丢弃，由上层 RPC 超时暴露问题
  private async handleMessage(message: WebRemoteControlRelayV2IncomingMessage): Promise<void> {
    if (message.type === "error") {
      if (message.code === "KICKED") {
        const delay = this.retry.kickedDelay();
        if (delay === null) {
          this.closeSocket();
          this.setState("kicked");
        } else this.scheduleReconnect(delay);
      } else if (
        message.code === "AUTH_FAILED" &&
        this.state === "authenticating" &&
        !this.registrationRetried
      ) {
        this.registrationRetried = true;
        // 注册遇到网络错误时必须重试注册，不能带已失效 SID 再次握手。
        this.registrationPending = true;
        this.scheduleReconnect(0);
      } else if (message.code === "INTERNAL" || message.code === "DEVICE_OFFLINE") {
        this.scheduleReconnect();
      } else {
        this.handleConnectionError(new WebRemoteControlV2ConnectionError("relay-unavailable"));
      }
      return;
    }
    if (message.type === "auth_ack") {
      if (this.state !== "authenticating" || message.device_sid !== this.deviceSid) return;
      clearTimeout(this.handshakeTimer);
      this.authenticated = true;
      this.retry.acknowledged();
    }
    if (!this.authenticated) return;
    if (message.type === "auth_ack" || message.type === "pair_status_ack") {
      const previousGeneration = this.pairedGeneration;
      this.heartbeat.acknowledged();
      this.setState(webRemoteControlV2PairState(message.pair_status));
      if (message.pair_status === "matched") {
        this.pairedGeneration = this.generation;
        if (previousGeneration)
          this.options.onSendReady?.({
            kind: previousGeneration === this.generation ? "same-socket" : "reconnected-socket",
          });
      }
    } else if (message.type === "data" && this.state === "paired") {
      const value = message.payload;
      if (
        value &&
        typeof value === "object" &&
        "zcode_type" in value &&
        (value.zcode_type === "rpc-frame" || value.zcode_type === "rpc-frame-ack") &&
        this.options.onRawTransportPayload?.(value)
      )
        return;
      const payload = parseWebRemoteControlAppPayload(value);
      if (payload) this.options.onPayload(payload);
    }
  }

  // 不变量：先递增代值再关闭，保证旧 close 与异步结果都落在旧代
  // 资源：CONNECTING 态必须强制终止，否则握手未完成的 socket 不会释放
  // 失败路径：鉴权标记与心跳必须同步复位，遗漏会让新连接沿用旧心跳状态
  // 权衡：已建立连接必须走正常关闭而非销毁，留出协议层关闭帧的发送窗口
  // 不变量：本方法幂等，重复调用不会产生额外副作用
  private closeSocket(): void {
    // 先撤销当前代，再关闭；旧 close/ACK 及异步 token 结果均不能推进下一代。
    this.generation += 1;
    this.authenticated = false;
    this.heartbeat.stop();
    clearTimeout(this.handshakeTimer);
    const socket = this.socket;
    this.socket = undefined;
    if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket?.close();
  }

  // 不变量：controller 缺失或已中止时不再排期，避免 dispose 之后复活连接
  // 事务：先关旧 socket 再清定时器再置状态，顺序错乱会留下双定时器
  // 资源：重连定时器保存句柄以便 dispose 与二次排期时覆盖
  // 失败路径：连续触发本方法由定时器清理收敛为一条待执行任务
  private scheduleReconnect(delay = this.retry.nextDelay()): void {
    if (!this.controller || this.controller.signal.aborted) return;
    this.closeSocket();
    clearTimeout(this.reconnectTimer);
    this.setState("connecting");
    noteWebRemoteRelayReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  // 失败路径：非连接错误或标记可重试时统一走退避重连，不向用户报终态
  // 不变量：不可重试错误先关闭资源再进入错误态并回调上报
  // 权衡：错误原因只保留固定标识，牺牲诊断细节换取凭据与内网地址不外泄
  private handleConnectionError(error: unknown): void {
    if (!(error instanceof WebRemoteControlV2ConnectionError) || error.retryable) {
      this.options.logger.warn("[web-remote-control] V2 connection retry");
      this.scheduleReconnect();
      return;
    }
    this.closeSocket();
    clearTimeout(this.reconnectTimer);
    this.setState("error");
    this.options.onError(error);
  }

  private send(message: WebRemoteControlRelayV2OutgoingMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  // 不变量：相同状态重复设置直接返回，避免订阅者收到噪声通知
  // 不变量：进入 paired 时记录连接成功耗时，与 close 分支的失败记录配对
  // 失败路径：状态回调抛错会中断后续日志，因此日志必须置于回调之前
  // 权衡：状态变更必须同步通知而非排队批处理，换取界面与链路状态严格同帧
  private setState(state: WebRemoteControlDeviceTransportState): void {
    if (this.state === state) return;
    this.state = state;
    if (state === "paired") {
      noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, true, {
        attempt: this.connectAttempt,
      });
    }
    this.options.logger.info("[web-remote-control] V2 device state", { state });
    this.options.onStateChange(state);
  }
}
