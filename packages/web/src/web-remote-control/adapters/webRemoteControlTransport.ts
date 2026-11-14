// 做：维护手机端到外部 relay 的终端 WebSocket 生命周期（鉴权、配对、心跳、重连、前台/后台恢复）。
// 不做：不持有任务或会话业务状态，不解释 payload 语义，也不决定“何时该重试”（由上层调用 recover*）。
// 依赖：relay 消息由 relayMessage 模块解析；payload 序列化与帧上限来自 @zcode/client 与 @zcode/shared。
// 契约：对外只暴露 sendPayload / suspend / recoverConnection / recoverInBackground / dispose，状态变化统一经 setState 通知。
// 生命周期：一个实例对应一次远控页面会话；dispose 之后任何路径都不得再启动新连接。
// 不变量（INV）：
// INV-01 断言：socketGeneration 是唯一的代际标识，任何 await 或事件回调回到同步世界前都要校验代际 —— 守住它的位置：connect 内 generation 比较与四个 socket 监听器 —— 改错故障：旧 socket 的 close 会关掉新连接，表现为无限重连抖动。
// INV-02 断言：每个 socket 监听器第一句必须是 socket 与 this.socket 的判等短路 —— 守住它的位置：open / message / error / close —— 改错故障：旧连接的 error 与 close 会把新连接推回 reconnecting，状态来回跳。
// INV-03 断言：closeSocket 必须自增代际并 abort tokenController —— 守住它的位置：closeSocket —— 改错故障：正在 await getToken 的旧 connect 返回后继续建连，产生两条并存 socket。
// INV-04 断言：intentionallyClosed 为真时 connect 与 scheduleReconnect 必须直接返回 —— 守住它的位置：connect 首行、scheduleReconnect、重连计时器回调 —— 改错故障：dispose 后计时器仍重建连接，页面已卸载但 WebSocket 常驻。
// INV-05 断言：authenticated 只在 auth_ack 且 device_sid 匹配后置真，closeSocket 必须置假 —— 守住它的位置：handleMessage 的 auth_ack 分支与 closeSocket —— 改错故障：新 socket 复用旧认证态，未鉴权就发 data 被 relay 丢弃。
// INV-06 断言：已配对后的 waiting 是合法降级，不得清除 wasPaired —— 守住它的位置：applyPairStatus 的 wasPaired 分支与 reconnectAfterStaleWaiting —— 改错故障：下一跳 waiting 被当成首次未匹配，桌面短暂重连就把手机推进失败页。
// INV-07 断言：wasPaired 只能在新一轮建连的计时器回调里清除 —— 守住它的位置：scheduleReconnect 的 reconnectTimer 回调 —— 改错故障：提前清空会让 close 处理误判为从未配对，丢掉原地恢复语义。
// INV-08 断言：hadPairedSession 一旦为真只由 start 重置 —— 守住它的位置：start 与 close 监听器 —— 改错故障：短暂断连后回到首次配对分支，已配对页面被切回加载态。
// INV-09 断言：waiter 的 resolve 与 reject 都必须清掉自己的计时器 —— 守住它的位置：resolvePairedWaiters / rejectPairedWaiters —— 改错故障：超时计时器在完成后仍触发，产生未捕获的 rejection。
// INV-10 断言：waitForPaired 只在未 paired 时挂 waiter —— 守住它的位置：waitForPaired 首行 —— 改错故障：已配对时挂上的 waiter 没有后续迁移唤醒，调用方白等到超时。
// INV-11 断言：DEVICE_OFFLINE 不得立刻进终态，必须先开宽限计时器 —— 守住它的位置：recoverFromDeviceOffline —— 改错故障：桌面重连的一两秒空窗被渲染成电脑端离线，用户被迫手动重开远控。
// INV-12 断言：宽限计时器只能存在一个，且在进入 paired 时必须清除 —— 守住它的位置：desktopOfflineFailureTimer 与 applyPairStatus 的 matched 分支 —— 改错故障：恢复成功后旧计时器仍触发，把正常连接踢进失败页。
// INV-13 断言：每次心跳 ack 都要 acknowledged 重置退避 —— 守住它的位置：startHeartbeat 与 auth_ack / pair_status_ack 分支 —— 改错故障：长连接跑几小时后重连延迟被拉到上限，抖动恢复明显变慢。
// INV-14 断言：suspend 对未认证的连接必须 closeSocket —— 守住它的位置：suspend 里的 authenticated 判断 —— 改错故障：迟到的 open 与 ACK 会在手机后台启动 bootstrap，回前台时状态与页面不符。
// INV-15 断言：suspended 状态下所有计时器回调都要早退 —— 守住它的位置：connect、scheduleReconnect 与 reconnectAfterStaleWaiting 的延迟分支 —— 改错故障：后台仍持续建连，移动端被判为耗电。
// INV-16 断言：send 必须同时校验 readyState 与物理帧字节上限 —— 守住它的位置：send 与 sendPayloadResult —— 改错故障：超帧消息被 relay 断开连接，而上层已收到成功回执，消息静默丢失。
// INV-17 断言：sendPayloadResult 的超限判断必须先于可用性判断 —— 守住它的位置：sendPayloadResult 的分支顺序 —— 改错故障：未配对时的超限消息只报 unavailable，调用方无法把内容过大暴露给用户。
// INV-18 断言：状态迁移必须经 setState，且同状态重复设置要短路 —— 守住它的位置：setState —— 改错故障：直接赋值会跳过 paired 的 waiter 唤醒，恢复调用永远等到超时。
// INV-19 断言：relay 诊断日志只允许开发态输出摘要 —— 守住它的位置：traceRelayMessages 与 logRelayTrace —— 改错故障：生产环境把 relay 正文写进日志，泄露凭据并放大日志体积。
import type {
  WebRemoteControlTerminalTransportState,
  WebRemoteControlTerminalTransportDiagnostic,
  WebRemoteControlTerminalTransportDiagnosticInput,
  WebRemoteControlTerminalTransportOptions,
} from "#src/web-remote-control/contracts/transport.js";
import {
  webSocketDataByteLength,
  parseRelayMessage,
  createFailure,
  isRawTransportCandidate,
  summarizeRelayMessageForTrace,
} from "#src/web-remote-control/adapters/relayMessage.js";
import {
  WebRemoteControlRelayPayloadSerializer,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  parseWebRemoteControlAppPayload,
  type WebRemoteControlAppPayload,
  type WebRemoteControlFailure,
} from "@zcode/shared";
import {
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
  WebRemoteControlV2ConnectionError,
  WebRemoteControlV2Heartbeat,
  WebRemoteControlV2RetryPolicy,
  webRemoteControlV2PairState,
  WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS,
  getWebRemoteControlHeartbeatJitterMs,
  getWebRemoteControlReconnectJitterMs,
  type WebRemoteControlRelayV2OutgoingMessage,
} from "@zcode/shared/web-remote-relay";

// [契约] 该类只管连接与配对，不解释业务 payload：上层拿到 onPayload 后自行决定投递到哪个会话。
// [生命周期] 实例与手机远控页面同寿命，跨页面复用会让代际、waiter 与旧页面回调互相纠缠。
// [权衡] 不做成 React hook：恢复流程要脱离渲染节奏运行（页面隐藏时仍要继续），放进 hook 会被卸载打断。
export class WebRemoteControlTerminalTransport {
  // [契约] 构造器注入而不是直接用全局 WebSocket：单测与桌面环境需要伪造实现，
  // 并且保证 readyState 常量与实例来自同一实现，避免跨实现比较永远为假。
  // [权衡] 每次都用 this.WebSocketCtor.OPEN 判断，不在模块顶层缓存常量。
  private readonly WebSocketCtor: typeof globalThis.WebSocket;
  // [契约] socket 是当前代的唯一引用，所有监听器都拿它与 this.socket 判等；
  // 关闭时必须先清空再 close，否则 close 回调会看到仍相等的引用并再次触发重连。
  // [资源] 旧 socket 只被闭包持有，不做数组管理，避免阻止回收。
  private socket?: WebSocket;
  private state: WebRemoteControlTerminalTransportState = "idle";
  // [契约] 这是“上层要求停止”与“网络故障”的唯一区分点：置真后 connect 与所有计时器回调都要早退。
  // [失败路径] 只在 dispose 里清计时器而不设该标志时，晚到的 close 事件仍会排一次重连。
  private intentionallyClosed = false;
  // [契约] 表示本代 socket 曾进入 paired，用于把 waiting 解释为可恢复降级；
  // [状态] `wasPaired` 只描述本代 socket：新一轮建连的计时器回调重置为 false，表示重新从 waiting 开始配对。
  // [权衡] 与 hadPairedSession 拆开：前者描述当前 socket，后者描述整个页面会话，合并会丢掉恢复语义。
  private wasPaired = false;
  // [契约] 只由 start 重置；close 处理靠它区分重连与首次配对失败，
  // 从而避免已配对页面在网络抖动时被切回加载态。
  // [失败路径] 提前清空会让紧接着的 waiting 走进失败页，用户看到桌面未连接，实际只是切网。
  private hadPairedSession = false;
  private staleWaitingCount = 0;
  // [契约] 抖动在策略之外计算：重连抖动还要与心跳抖动取较小值，直接配进策略会让两套退避互相覆盖。
  // [权衡] 注入 Math.random 便于单测确定化，类内不要直接调用全局随机。
  private readonly retry = new WebRemoteControlV2RetryPolicy(Math.random, {
    initialMs: 500,
    maxMs: 10_000,
    jitter: 0,
  });
  // [契约] 每次建连新建一个 controller，closeSocket 与 suspend 都会 abort 它：
  // 取令牌可能耗时数秒，期间用户可能已挂起页面或触发新一代连接。
  // [失败路径] 不 abort 时迟到的 token 会继续走到 new WebSocket，产生幽灵连接。
  private tokenController?: AbortController;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private authenticated = false;
  private readonly heartbeat: WebRemoteControlV2Heartbeat;
  // [契约] 单调递增的代际：await 之后与事件回调里都要先比对再改状态；
  // 这是避免旧异步任务污染新连接的唯一手段，不能靠 socket 引用判等替代（建连前还没有 socket）。
  // [并发] closeSocket 自增一次、connect 自增一次，因此一次重连会跨两代，属于预期行为。
  // [权衡] 不用时间戳：同一毫秒内多次重连会碰撞。
  private socketGeneration = 0;
  // [契约] 记录上一次配对成功发生在哪一代，用于区分 same-socket 与 reconnected-socket；
  // 0 表示本页面会话尚未配对过，此时不通知 onSendReady。
  // [失败路径] 用 wasPaired 布尔代替时，重连后无法告诉上层需要重放未确认队列。
  private lastPairedSocketGeneration = 0;
  private lastPairStatusAckAt = 0;
  private hiddenStartedAt?: number;
  private lastPairStatusDiagnostic?: string;
  // [契约] 每个 waiter 自带计时器，挂在 Set 里以便 paired 或终态时统一唤醒；
  // 计时器必须在 resolve 与 reject 时清掉，否则完成后仍会触发超时 rejection。
  // [并发] 循环中不删除元素，结束后统一 clear，避免依赖迭代器的删除语义。
  private pairedWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private waitingTimer?: ReturnType<typeof setTimeout>;
  private staleWaitingRecoveryTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private desktopOfflineFailureTimer?: ReturnType<typeof setTimeout>;
  private readonly traceRelayMessages = import.meta.env.DEV;
  private readonly payloadSerializer = new WebRemoteControlRelayPayloadSerializer();

  // [契约] 心跳回调用箭头函数绑定实例：心跳在构造期创建并持有 this，
  // 若依赖外部注入回调，挂起与重连期间的回调归属会变得不可追踪。
  // [权衡] 心跳的 interval、jitter、ackTimeout 全部来自 options，只有默认值来自 shared 常量，
  // 便于端到端用毫秒级参数验证超时分支。
  // [契约] 重连退避固定初始 500ms、上限 10s，指数增长必须有上界。
  constructor(private readonly options: WebRemoteControlTerminalTransportOptions) {
    this.WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
    this.heartbeat = new WebRemoteControlV2Heartbeat(
      () => this.sendPairStatusQuery(),
      () => this.reconnectAfterStaleWaiting(this.getReconnectJitterMs()),
      {
        intervalMs: options.heartbeatIntervalMs,
        jitterMs: options.heartbeatJitterMs,
        ackTimeoutMs: options.heartbeatAckTimeoutMs,
      },
    );
  }

  // [契约] start 是唯一的重置入口：配对记忆、退避、陈旧等待计数、诊断去重都在这里归零，
  // 因此只能由上层在进入远控页时调用一次。
  // [并发] 必须先置 intentionallyClosed 为假再 connect，否则 connect 首行会因旧标志直接返回。
  // [契约] lastPairStatusAckAt 也要重置：心跳用它判断 ack 是否过期，沿用旧值会让首轮心跳立刻判定超时。
  start(): void {
    this.intentionallyClosed = false;
    this.wasPaired = false;
    this.hadPairedSession = false;
    this.staleWaitingCount = 0;
    this.retry.acknowledged();
    this.lastPairedSocketGeneration = 0;
    this.lastPairStatusAckAt = Date.now();
    this.setState("connecting");
    this.connect();
  }

  // [契约] connect 不幂等：每次调用都会抢占新的一代，重复调用会让上一代的 await 结果作废。
  // [失败路径] suspended 与 intentionallyClosed 直接返回，因为此时建连必然被上层撤销。
  // [事务] 顺序不可调换：先自增代际、再 abort 旧 token、再新建 controller，
  // 这样旧 connect 恢复执行时必然能在 await 之后发现自己已过期。
  private async connect(): Promise<void> {
    if (this.intentionallyClosed || this.state === "suspended") return;
    // [契约] 在发起任何异步动作前取号，await getToken 之后用它判断自己是否已被取代。
    // [并发] 用前缀自增而不是先读后写，避免两条协程拿到同一个号。
    const generation = ++this.socketGeneration;
    this.tokenController?.abort();
    // [契约] controller 在赋值给字段之前就开始使用，保证同一代内 getToken 与后续关闭看到的是同一个实例。
    // [资源] 这里不重置 authenticated，真正的复位在 closeSocket，避免读到一半的状态被提前改写。
    const controller = new AbortController();
    this.tokenController = controller;
    this.authenticated = false;
    try {
      // [契约] 令牌请求可取消：挂起或重连时 abort 能让请求尽快结束，实现方必须尊重 signal。
      // [失败路径] 返回后立刻复查 aborted 与代际，任一成立都放弃建连，不能只看其中一项。
      const token = await this.options.getToken(controller.signal);
      if (controller.signal.aborted || generation !== this.socketGeneration) return;
      const url = new URL(this.options.relayWsUrl);
      url.searchParams.set("token", token);
      if (this.options.deviceMid?.trim()) {
        url.searchParams.set("mid", this.options.deviceMid);
      }
      const socket = new this.WebSocketCtor(url.toString());
      this.socket = socket;
      clearTimeout(this.handshakeTimer);
      // [契约] 建连到 auth_ack 之间没有心跳可依赖，必须有独立兜底计时器推进状态机，
      // 这里复用心跳的 ack 超时值。
      // [资源] 计时器只排一次，auth_ack 与 closeSocket 都要 clear，否则重连会被误触发。
      this.handshakeTimer = setTimeout(
        () => this.scheduleReconnect(),
        WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
      );

      // [契约] open 只代表 WebSocket 就绪、不代表已鉴权：先发 auth_init 再等 auth_ack，中间态是 authenticating。
      // [契约] 上报 extensions 是为了确认 relay 是否真的协商了 permessage-deflate：浏览器端无法强制开启压缩，
      // 只能观测；误以为可配置会在排查带宽问题时得出错误结论。
      // [失败路径] device_sid 与 relay 侧不一致时鉴权失败会以 AUTH_FAILED 回到 handleRelayError。
      socket.addEventListener("open", () => {
        if (socket !== this.socket) {
          return;
        }
        const negotiatedExtensions = typeof socket.extensions === "string" ? socket.extensions : "";
        // Bugfix: 手机端运行在浏览器 WebSocket API 下，无法主动传 perMessageDeflate 配置。
        // 只能通过标准 extensions 字段确认 relay 是否真的完成压缩协商，避免误以为业务代码可强制开启。
        this.emitDiagnostic({
          type: "socket-extensions",
          state: this.state,
          perMessageDeflate: negotiatedExtensions.includes("permessage-deflate"),
          ...(negotiatedExtensions ? { extensions: negotiatedExtensions } : {}),
        });
        this.setState("authenticating");
        this.send({
          type: "auth_init",
          device_sid: this.options.deviceSid,
          meta: {
            platform: "web",
            version: this.options.appVersion ?? "web",
            name: "mobile-browser",
          },
          client_ts: Math.floor(Date.now() / 1000),
        });
      });

      socket.addEventListener("message", (event) => {
        if (socket !== this.socket) {
          return;
        }
        void this.handleMessage(event.data, socket);
      });

      socket.addEventListener("error", () => {
        if (socket !== this.socket) {
          return;
        }
        const error = new Error("External relay terminal socket error");
        this.emitDiagnostic({ type: "socket-error", state: this.state });
        this.options.onError(error);
      });

      // [契约] close 只处理当前代的关闭，旧 socket 的 close 必须被首行判等挡掉。
      // [契约] 先停心跳与等待计时器再决定重连：残留的 waiting 计时器会把重连中的状态误判为超时。
      // [失败路径] hadPairedSession 的两个分支目前都落到 scheduleReconnect，
      // 保留分支是因为“先探测再重连”的恢复策略将来只对已配对会话生效。
      socket.addEventListener("close", (event) => {
        if (socket !== this.socket) {
          return;
        }
        this.emitDiagnostic({
          type: "socket-close",
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          wasPaired: this.wasPaired,
          state: this.state,
        });
        this.stopHeartbeat();
        this.clearWaitingTimer();
        this.clearStaleWaitingRecoveryTimer();
        if (this.intentionallyClosed) {
          return;
        }
        if (this.state === "suspended") {
          return;
        }
        if (this.hadPairedSession) {
          // Bugfix: 手机浏览器后台恢复、网络切换或 relay 短抖会关闭已配对 socket。
          // 旧逻辑直接刷新整页，导致用户丢失当前 workspace/task 视图；这里改为原地重连，
          // 让上层在重新 paired 后按 mobile view state 恢复。
          this.scheduleReconnect();
          return;
        }
        this.scheduleReconnect();
      });
    } catch (error) {
      if (controller.signal.aborted || generation !== this.socketGeneration) return;
      if (error instanceof WebRemoteControlV2ConnectionError && !error.retryable) {
        this.enterTerminalFailure(createFailure(error.reason));
      } else this.scheduleReconnect();
    }
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    return this.payloadSerializer.prepare(payload, Math.floor(Date.now() / 1000)).bytes;
  }

  // [契约] 返回三态而不是布尔：oversize、unavailable、sent 的处置完全不同，
  // 调用方需要把消息过大当成可展示错误，而 unavailable 只需排队重发。
  // [事务] 顺序固定：先序列化、再判大小、再判可用性，只有这样才能在断连时也报告超限。
  // [权衡] 每次发送重新序列化而不缓存：payload 可能带时间戳，复用会让重发的时序失真。
  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    // [契约] 序列化与计时来自同一次 prepare：字节数与 client_ts 必须同源，
    // 分两次取时间会让重试后的消息看起来比实际更旧。
    // [权衡] 字节数用 prepare 的结果，避免再对整个消息做一次全量编码。
    const prepared = this.payloadSerializer.prepare(payload, Math.floor(Date.now() / 1000));
    if (this.payloadSerializer.isOversize(prepared)) {
      return {
        kind: "oversize",
        bytes: prepared.bytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      };
    }
    // [契约] staleWaitingCount 大于 0 表示刚收到过 waiting：socket 还在但桌面不在，
    // 继续发送只会堆积失败回执，因此按 unavailable 处理让上层排队。
    if (this.state !== "paired" || this.staleWaitingCount > 0) {
      return { kind: "unavailable" };
    }
    return this.sendSerialized(prepared.message, prepared.json)
      ? { kind: "sent", bytes: prepared.bytes }
      : { kind: "unavailable" };
  }

  // [契约] 只允许从活跃状态挂起：已进入 error 或 kicked 时挂起没有意义，也不应覆盖终态。
  // [失败路径] 未认证的连接必须关闭：留着它，迟到的 auth_ack 会在后台把状态推到 paired，
  // 而页面并不知道自己已经连上，恢复时会出现两份不一致的状态。
  // [资源] abort token 并清掉握手、重连、等待、陈旧等待计时器，缺一项都会在后台留下活动任务。
  // [契约] hiddenStartedAt 只做诊断用，恢复时由 emitDiagnostic 消费并清空。
  suspend(): void {
    if (
      this.state !== "paired" &&
      this.state !== "connecting" &&
      this.state !== "reconnecting" &&
      this.state !== "authenticating" &&
      this.state !== "waiting"
    ) {
      return;
    }
    // 未认证连接没有可复用的会话，挂起时撤销它；迟到 open/ACK 不能在后台启动 bootstrap。
    if (!this.authenticated) this.closeSocket();
    this.hiddenStartedAt = Date.now();
    this.tokenController?.abort();
    clearTimeout(this.handshakeTimer);
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.setState("suspended");
  }

  // [契约] 这是回到前台的主路径：若 socket 仍 OPEN 且曾配对，先做一次 pair_status 探测，
  // 避免短暂切后台就断开重建。
  // [失败路径] 探测超时不能直接失败，必须落到重建 socket，否则一次慢恢复就被判为桌面断开。
  // [事务] 重建前清空所有计时器并把 staleWaitingCount 归零，否则旧计时器会与新连接交错。
  // [契约] 探测成功直接返回，不再重建：pair_status 已确认链路可用，重建只会打断刚恢复的连接。
  async recoverConnection(timeoutMs = 15_000): Promise<void> {
    if (this.intentionallyClosed) throw new Error("Web remote control transport stopped.");
    this.emitDiagnostic({ type: "recover-start", state: this.state });
    this.clearReconnectTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.staleWaitingCount = 0;
    if (
      this.state === "suspended" &&
      this.wasPaired &&
      this.socket?.readyState === this.WebSocketCtor.OPEN
    ) {
      // Bugfix: hidden/pagehide 只说明手机页面暂停过，不代表 WebSocket 一定坏了。
      // 先用原 socket 做一次 pair_status 探测，避免短暂切后台也强制断开重连。
      this.setState("reconnecting");
      if (this.sendPairStatusQuery()) {
        try {
          await this.waitForPaired(this.options.healthCheckTimeoutMs ?? 3_000);
          return;
        } catch {
          // 探测超时后再重建 socket；这里不直接失败，避免把短暂恢复慢误判为桌面断开。
        }
      }
    }
    this.retry.acknowledged();
    this.reconnectNow();
    await this.waitForPaired(timeoutMs);
  }

  // [契约] 后台恢复不发探测、不抛失败，只做原地重连：页面可能长时间不可见，
  // 任何一次性等待窗口都可能提前到期。
  // [失败路径] 已 paired 或 kicked 直接返回：前者无需动作，后者是终态，重连会被 relay 再次拒绝。
  // [资源] 先清计时器再 reconnectNow，避免内部 setState 触发旧计时器回调。
  recoverInBackground(): void {
    if (this.intentionallyClosed || this.state === "paired" || this.state === "kicked") {
      return;
    }
    // Bugfix: 手机端长时间后台恢复可能超过 recoverConnection 的单次等待窗口。
    // 这里继续原地重连，不把当前页面切成错误页，保证用户正在输入的草稿不被卸载。
    this.clearReconnectTimer();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.stopHeartbeat();
    this.staleWaitingCount = 0;
    this.reconnectNow();
  }

  // [契约] dispose 幂等且不可逆：先置 intentionallyClosed，再清计时器、拒绝 waiter、关闭 socket。
  // [并发] 顺序关键：先置标志后清计时器，否则计时器回调可能先于标志生效而发起重连。
  // [失败路径] 拒绝 waiter 用显式 Error：调用方需要区分被销毁与恢复超时。
  // [资源] setState 放在 closeSocket 之后，保证上层看到 idle 时 socket 已释放。
  dispose(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.rejectPairedWaiters(new Error("Web remote control transport disposed."));
    this.closeSocket();
    this.setState("idle");
  }

  // [契约] 帧大小上限在建连后仍要校验：WebSocket 不提供分片前的尺寸视图，
  // 超大帧直接丢弃并上报 raw transport fault，避免解析器吃掉内存。
  // [并发] await 解析期间 socket 可能已换代或被 dispose，返回后必须重新判等。
  // [失败路径] 解析失败返回 null 时静默丢弃，不把单条坏帧注入状态机。
  private async handleMessage(data: unknown, socket: WebSocket): Promise<void> {
    if (
      webSocketDataByteLength(data) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
      return;
    }
    // [契约] 解析同时负责二进制与文本解码，这里不假设 event.data 的类型：
    // [契约] `parseRelayMessage` 统一解码 `event.data` 的 Blob / ArrayBuffer / string 三种形态；调用方不按浏览器分支。
    const message = await parseRelayMessage(data);
    if (!message || socket !== this.socket || this.intentionallyClosed) {
      return;
    }
    this.logRelayTrace("recv", summarizeRelayMessageForTrace(message));

    switch (message.type) {
      case "auth_ack":
        if (this.state !== "authenticating" || message.device_sid !== this.options.deviceSid)
          return;
        this.authenticated = true;
        clearTimeout(this.handshakeTimer);
        this.retry.acknowledged();
        this.applyPairStatus(message.pair_status);
        break;
      case "pair_status_ack":
        if (!this.authenticated || this.state === "suspended") return;
        this.applyPairStatus(message.pair_status);
        break;
      case "data":
        if (!this.authenticated || this.state !== "paired") return;
        this.handleDataPayload(message.payload);
        break;
      case "error":
        this.handleRelayError(message.code, message.message);
        break;
    }
  }

  // [契约] 两个来源共用此函数：auth_ack 携带的初始状态与后续 pair_status_ack，
  // 因此不能假设刚连上，要按当前 wasPaired 分流。
  // [契约] 先写 lastPairStatusAckAt 再改状态：心跳的 ack 判定依赖它，晚写会让合法 ack 被算作过期。
  // [事务] waiting 与 matched 都先清陈旧等待与重连计时器，再设置新状态。
  private applyPairStatus(status: "waiting" | "matched"): void {
    this.lastPairStatusAckAt = Date.now();
    this.emitDiagnostic({ type: "pair-status", pairStatus: status, state: this.state });
    if (webRemoteControlV2PairState(status) === "waiting_terminal") {
      if (this.wasPaired) {
        // Bugfix: zcode-remote-hub 的 waiting 是合法配对状态，表示当前 device 不在 hub 里，
        // 不是 terminal WS 损坏信号。已配对后降级为 waiting 时保持同一条手机端 WS，
        // 继续轻量查询，避免把桌面端短暂重连放大成手机端反复踢旧连接。
        this.staleWaitingCount = 0;
        this.clearStaleWaitingRecoveryTimer();
        this.clearReconnectTimer();
        this.clearWaitingTimer();
        this.clearDesktopOfflineFailureTimer();
        this.setState("waiting");
        this.startHeartbeat();
        return;
      }
      this.setState("waiting");
      this.startHeartbeat();
      this.startWaitingTimer();
      return;
    }
    // [契约] 进入 paired 是唯一唤醒 waitForPaired 的时机（经 setState），
    // 任何绕过 setState 的直接赋值都会让恢复流程空等到超时。
    // [事务] 计时器必须在 onSendReady 之前清完：上层收到 ready 会立刻发消息，此时状态必须已是 paired。
    // [契约] staleWaitingCount 归零，否则 sendPayloadResult 仍会继续返回 unavailable。
    if (status === "matched") {
      const previousPairedGeneration = this.lastPairedSocketGeneration;
      // [契约] 区分同一条 socket 重新配对与换了一条 socket：上层据此决定是否重放未确认队列，
      // 同 socket 重放会造成重复消息。
      // [失败路径] 上一代记录为 0 表示首次配对，此时不通知，避免冷启动就触发重放。
      const sendReadyKind =
        previousPairedGeneration === 0
          ? null
          : previousPairedGeneration === this.socketGeneration
            ? "same-socket"
            : "reconnected-socket";
      this.staleWaitingCount = 0;
      this.retry.acknowledged();
      this.clearStaleWaitingRecoveryTimer();
      this.clearDesktopOfflineFailureTimer();
      this.clearReconnectTimer();
      this.clearWaitingTimer();
      this.setState("paired");
      this.wasPaired = true;
      this.hadPairedSession = true;
      this.lastPairedSocketGeneration = this.socketGeneration;
      this.startHeartbeat();
      if (sendReadyKind) this.options.onSendReady?.({ kind: sendReadyKind });
      return;
    }
  }

  // [契约] 这是 relay 错误码的唯一分流点：可恢复错误降级重连，不可恢复错误进终态。
  // [失败路径] 未覆盖的码落到 relay-unavailable，宁可进入可诊断的失败页，也不要静默重试。
  private handleRelayError(
    code: "AUTH_FAILED" | "DEVICE_OFFLINE" | "KICKED" | "WRONG_PARAM" | "INTERNAL",
    message?: string,
  ): void {
    // [契约] KICKED 是唯一需要退避的终态：同一设备在别处登录时立刻重连只会互相踢，
    // 退避耗尽（策略返回 null）后才进入 session-conflict。
    // [失败路径] 退避期间不能置 intentionallyClosed，否则计时器回调会早退，状态卡在 reconnecting。
    if (code === "KICKED") {
      const delay = this.retry.kickedDelay();
      if (delay === null) this.enterTerminalFailure(createFailure("session-conflict"));
      else this.scheduleReconnect({ delayMs: delay });
      return;
    }
    // [契约] 桌面重启或换 socket 期间 relay 会短暂回 DEVICE_OFFLINE，必须给宽限窗口；
    // 立刻进终态会让用户在桌面重连的一两秒内被踢出远控页。
    if (code === "DEVICE_OFFLINE") {
      // Bugfix: 桌面端打开远控或 relay 短暂重连时，手机可能先收到一次 DEVICE_OFFLINE。
      // 旧逻辑会立刻渲染“电脑端离线”终态页，实际桌面 1~2 秒后就恢复 paired。
      // 这里先进入可恢复重连窗口，超过宽限时间仍未 paired 才认定桌面真正离线。
      this.recoverFromDeviceOffline(message || code);
      return;
    }
    if (code === "AUTH_FAILED" || code === "WRONG_PARAM") {
      this.enterTerminalFailure(
        createFailure(code === "AUTH_FAILED" ? "device-not-owned" : "invalid-mobile-connection"),
      );
      return;
    }
    // [契约] 已配对、或已配对后降级 waiting 时，INTERNAL 多半表示当前 device 不在 hub 里，
    // 此时降级 waiting 继续查询，而不是重建连接。
    // [失败路径] 其余 INTERNAL（握手早期）按可恢复处理，原地重连。
    if (code === "INTERNAL") {
      if (this.state === "paired" || (this.hadPairedSession && this.state === "waiting")) {
        this.enterWaitingForDeviceAfterRelayError(message || code);
        return;
      }
      // Bugfix: relay 在桌面/手机快速重连切换时会短暂回 INTERNAL。
      // 这类错误大多可恢复，直接抛失败页会迫使用户手动重开远控；改为原地重连恢复。
      this.recoverFromRelayInternal(message || code);
      return;
    }
    this.enterTerminalFailure(createFailure("relay-unavailable", message || code));
  }

  private handleDataPayload(payload: unknown): void {
    if (isRawTransportCandidate(payload) && this.options.onRawTransportPayload?.(payload)) {
      return;
    }
    const parsed = parseWebRemoteControlAppPayload(payload);
    if (!parsed) {
      return;
    }
    this.options.onPayload(parsed);
  }

  private startHeartbeat(): void {
    this.heartbeat.acknowledged();
  }

  private getReconnectJitterMs(): number {
    const baseIntervalMs =
      this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS;
    const heartbeatJitterMs = getWebRemoteControlHeartbeatJitterMs(
      baseIntervalMs,
      this.options.heartbeatJitterMs,
    );
    return getWebRemoteControlReconnectJitterMs(
      this.options.reconnectJitterMs ??
        Math.min(heartbeatJitterMs, WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS),
    );
  }

  private sendPairStatusQuery(): boolean {
    return this.send({
      type: "pair_status_query",
      client_ts: Math.floor(Date.now() / 1000),
    });
  }

  private stopHeartbeat(): void {
    this.heartbeat.stop();
  }

  private startWaitingTimer(): void {
    if (this.waitingTimer) return;
    this.waitingTimer = setTimeout(() => {
      if (this.state !== "waiting") {
        return;
      }
      this.enterTerminalFailure(
        createFailure(
          "desktop-disconnected",
          "Desktop did not match this mobile connection before the waiting timeout.",
        ),
      );
    }, this.options.waitingTimeoutMs ?? 30_000);
  }

  private clearWaitingTimer(): void {
    if (!this.waitingTimer) {
      return;
    }
    clearTimeout(this.waitingTimer);
    this.waitingTimer = undefined;
  }

  private scheduleStaleWaitingRecovery(): void {
    if (this.staleWaitingRecoveryTimer) {
      return;
    }
    this.staleWaitingRecoveryTimer = setTimeout(() => {
      this.staleWaitingRecoveryTimer = undefined;
      if (
        (this.state === "paired" ||
          this.state === "reconnecting" ||
          this.state === "connecting" ||
          this.state === "authenticating") &&
        this.staleWaitingCount > 0
      ) {
        this.reconnectAfterStaleWaiting();
      }
    }, this.options.staleWaitingRecoveryMs ?? 1_500);
  }

  private clearStaleWaitingRecoveryTimer(): void {
    if (!this.staleWaitingRecoveryTimer) {
      return;
    }
    clearTimeout(this.staleWaitingRecoveryTimer);
    this.staleWaitingRecoveryTimer = undefined;
  }

  // [契约] 该路径专门服务“已配对但连续收到 waiting”：不清 wasPaired，
  // 否则下一次 waiting 会被当成首次未匹配并推进失败页。
  // [事务] 先清全部计时器与心跳再决定是否延迟，延迟期间不应再发出 pair_status_query。
  // [并发] 延迟分支要重写 lastPairStatusAckAt，否则心跳会立刻判定 ack 过期并再触发一次重连。
  private reconnectAfterStaleWaiting(reconnectDelayMs = 0): void {
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    // Bugfix: 已配对手机在恢复时可能先拿到 auth_ack: waiting。
    // 这里不能清掉 wasPaired，否则下一跳 waiting 会被当成首次未匹配并进入失败页；
    // 保留已配对语义，让状态机继续按可恢复短断连重试到 matched。
    if (reconnectDelayMs > 0) {
      this.closeSocket();
      this.setState("reconnecting");
      this.lastPairStatusAckAt = Date.now();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.intentionallyClosed || this.state === "suspended") {
          return;
        }
        this.connect();
      }, reconnectDelayMs);
      return;
    }
    this.reconnectNow();
  }

  private reconnectNow(): void {
    this.closeSocket();
    this.setState("reconnecting");
    this.lastPairStatusAckAt = Date.now();
    this.connect();
  }

  // [契约] 同一时刻只允许一个重连计时器：已有计时器时直接返回，
  // 避免 close、error、心跳超时三路事件叠加出多条并行 connect。
  // [事务] 关闭 socket 与切到 reconnecting 在排程时立即执行、不等计时器：
  // 上层据此停止发送，sent 回执不会指向已死的连接。
  // [失败路径] 计时器回调里再判一次 intentionallyClosed 与 suspended，因为等待期间状态可能已变。
  // [契约] 回调里清 wasPaired 与 staleWaitingCount，表示新一轮建连从未配对开始。
  private scheduleReconnect(options?: { immediate?: boolean; delayMs?: number }): void {
    if (this.intentionallyClosed || this.state === "suspended") return;
    if (this.reconnectTimer) {
      return;
    }
    const delayMs = options?.delayMs ?? (options?.immediate ? 0 : this.retry.nextDelay());
    this.closeSocket();
    this.setState("reconnecting");
    this.emitDiagnostic({ type: "recover-scheduled", state: this.state });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionallyClosed || this.state === "suspended") {
        return;
      }
      this.staleWaitingCount = 0;
      this.wasPaired = false;
      this.closeSocket();
      this.connect();
    }, delayMs);
  }

  private recoverFromRelayInternal(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    this.closeSocket();
    this.scheduleReconnect({ immediate: true });
  }

  // [契约] 上报 onError 但不上报 onFailure：这是可恢复告警，失败页只能由宽限计时器决定。
  // [事务] 宽限计时器只排一次：重复的 DEVICE_OFFLINE 不应不断重置倒计时，
  // 否则桌面长时间离线时用户永远等不到终态。
  // [契约] 关闭当前 socket 并立刻重连：relay 已表明 device 不在，留着连接只会继续收到错误。
  private recoverFromDeviceOffline(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    if (!this.desktopOfflineFailureTimer) {
      this.desktopOfflineFailureTimer = setTimeout(() => {
        this.desktopOfflineFailureTimer = undefined;
        this.enterTerminalFailure(createFailure("desktop-disconnected", message));
      }, this.options.desktopOfflineGraceMs ?? 15_000);
    }
    this.closeSocket();
    this.scheduleReconnect({ immediate: true });
  }

  // [契约] 保留手机端 socket、降级 waiting 并继续查询：hub 找不到 device 时并不关闭 terminal WS，
  // 此时重建连接只会放大成两端互相踢。
  // [资源] 清掉宽限计时器：进入 waiting 说明链路还活着，不应再倒计时到失败页。
  // [契约] 不清 wasPaired：这是可恢复降级，不是首次未匹配。
  private enterWaitingForDeviceAfterRelayError(message: string): void {
    // Bugfix: zcode-remote-hub 在已认证连接上转发 data 找不到 device 时只返回 INTERNAL，
    // 不会关闭当前 terminal WS。这里保持手机端 WS，降级为 waiting 并继续查询配对状态，
    // 避免把“桌面端暂时不在”放大成手机端反复重连。
    this.options.onError(new Error(message));
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    this.setState("waiting");
    this.startHeartbeat();
  }

  private clearDesktopOfflineFailureTimer(): void {
    if (!this.desktopOfflineFailureTimer) {
      return;
    }
    clearTimeout(this.desktopOfflineFailureTimer);
    this.desktopOfflineFailureTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  // [契约] 已 paired 时同步 resolve、不挂 waiter：否则后续没有状态迁移能唤醒它。
  // [并发] waiter 的 timer 由 Set 持有，resolve 与 reject 时必须 clear，
  // 否则超时 rejection 在 promise 完成后变成未捕获异常。
  // [失败路径] 超时时主动从 Set 删除，避免已超时的 waiter 被后续 paired 再次 resolve。
  private waitForPaired(timeoutMs = 15_000): Promise<void> {
    if (this.state === "paired") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pairedWaiters.delete(waiter);
          reject(new Error("Web remote control relay did not recover before timeout."));
        }, timeoutMs),
      };
      this.pairedWaiters.add(waiter);
    });
  }

  private resolvePairedWaiters(): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.pairedWaiters.clear();
  }

  private rejectPairedWaiters(error: Error): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pairedWaiters.clear();
  }

  // [契约] 进入终态即置 intentionallyClosed：这是不再自动重连的开关，
  // 状态区分 error 与 kicked 只是为了上层展示不同文案。
  // [事务] 先清计时器与心跳，再拒绝 waiter、上报失败、关闭 socket：
  // 顺序反过来会让 onFailure 期间仍收到旧连接的消息。
  // [契约] session-conflict 映射为 kicked，其余一律 error。
  private enterTerminalFailure(failure: WebRemoteControlFailure): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.setState(failure.reason === "session-conflict" ? "kicked" : "error");
    this.rejectPairedWaiters(new Error(failure.message ?? failure.reason));
    this.options.onFailure(failure);
    this.closeSocket();
  }

  // [契约] 唯一关闭 socket 的入口：自增代际、abort token、复位认证态、清握手计时器。
  // [资源] waiting 计时器在这里清，因为它属于旧 socket 的等待窗口；
  // KICKED 的退避计时器另算，不能被残留引用阻止新一轮重新计时。
  // [并发] 先取走 this.socket 再 close：close 可能同步触发回调，届时字段必须已为 undefined。
  private closeSocket(): void {
    // 等待超时属于旧 socket；KICKED 的退避不能让其残留引用阻止新一代重新计时。
    this.clearWaitingTimer();
    ++this.socketGeneration;
    this.tokenController?.abort();
    this.tokenController = undefined;
    this.authenticated = false;
    clearTimeout(this.handshakeTimer);
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  // [契约] 状态迁移的唯一出口：同状态短路，避免重复通知上层触发多余渲染。
  // [事务] 先更新 this.state 再通知 onStateChange：回调读取状态时必须已是最新值。
  // [契约] paired 唤醒所有 waiter，error 与 kicked 拒绝所有 waiter；
  // 副作用放在通知之后，保证上层先看到状态再拿到 promise 结果。
  private setState(state: WebRemoteControlTerminalTransportState): void {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    this.emitDiagnostic({
      type: "state-transition",
      previousState,
      state,
    });
    this.options.onStateChange(state);
    if (state === "paired") {
      this.resolvePairedWaiters();
    }
    if (state === "error" || state === "kicked") {
      this.rejectPairedWaiters(new Error(`Web remote control transport entered ${state}.`));
    }
  }

  // [契约] 控制帧（auth_init、pair_status_query）同样受物理帧上限约束，
  // 返回 false 而不是抛错，调用方据此决定是否需要重建连接。
  // [权衡] 序列化后用 TextEncoder 复测字节数：字符串长度不等于 UTF-8 字节数，中文元数据会被低估。
  private send(message: WebRemoteControlRelayV2OutgoingMessage): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    const serialized = JSON.stringify(message);
    if (
      new TextEncoder().encode(serialized).byteLength >
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      return false;
    }
    return this.sendSerialized(message, serialized);
  }

  // [契约] 调用前必须已校验帧大小与状态，这里只做最后的 readyState 复查与发送。
  // [并发] 复查必要：序列化与发送之间可能插入 close 事件。
  // [契约] 发送日志交给 logRelayTrace 自行判断是否输出，这里不做开关判断。
  private sendSerialized(
    message: WebRemoteControlRelayV2OutgoingMessage | { type: "data"; payload: unknown },
    serialized: string,
  ): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    this.logRelayTrace("send", summarizeRelayMessageForTrace(message));
    this.socket.send(serialized);
    return true;
  }

  // [契约] 只在开发态输出且只输出摘要：生产环境打印 relay 正文会放大日志体积并暴露凭据内容，
  // 所以开关取自 import.meta.env.DEV 而不是运行期配置。
  private logRelayTrace(direction: "send" | "recv", fields: Record<string, unknown>): void {
    if (!this.traceRelayMessages) {
      return;
    }
    // Bugfix: 远控 relay 消息量高，生产环境打印正文会快速放大日志体积并暴露敏感内容。
    // 这里只在开发态输出摘要字段，排查链路足够且不会污染线上日志。
    console.info("[web-remote-control][relay-message]", {
      direction,
      ...fields,
    });
  }

  // [契约] 诊断是纯观测通道，不允许影响状态机：所有分支都不改 state、不发送消息。
  // [契约] visibilityState 与 online 在同一帧读取，便于把状态跳变与网络、可见性变化对齐。
  // [资源] hiddenDurationMs 读取后立刻清空 hiddenStartedAt，避免同一段隐藏时长被重复上报。
  // [权衡] 只对 pair-status 做去重：心跳每几秒一次，若不去重会把诊断流刷成噪声，掩盖真正的状态跳变。
  private emitDiagnostic(diagnostic: WebRemoteControlTerminalTransportDiagnosticInput): void {
    if (diagnostic.type === "pair-status") {
      const nextPairStatusDiagnostic = `${diagnostic.state}:${diagnostic.pairStatus ?? "unknown"}`;
      if (this.lastPairStatusDiagnostic === nextPairStatusDiagnostic) {
        return;
      }
      this.lastPairStatusDiagnostic = nextPairStatusDiagnostic;
    }
    const visibilityState = typeof document === "undefined" ? "unknown" : document.visibilityState;
    const hiddenDurationMs =
      this.hiddenStartedAt && visibilityState !== "hidden"
        ? Date.now() - this.hiddenStartedAt
        : undefined;
    if (hiddenDurationMs !== undefined) {
      this.hiddenStartedAt = undefined;
    }
    this.options.onDiagnostic?.({
      ...diagnostic,
      timestamp: Date.now(),
      visibilityState,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(hiddenDurationMs !== undefined ? { hiddenDurationMs } : {}),
    } as WebRemoteControlTerminalTransportDiagnostic);
  }
}
