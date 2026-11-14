// INV-01 状态集合与运行态一一对应：守住位置 WebRemoteControlTerminalTransportState；改错故障 新增状态后诊断类型不全、漏记现场。
// INV-02 每类诊断都带定位要素：state、timestamp、visibilityState 与 online；改错故障 线上问题无法还原现场。
// INV-03 hiddenDurationMs 只在有值时出现：守住位置 可选字段；改错故障 序列化出大量 null 噪声。
// INV-04 输入侧字段全部可选：守住位置 DiagnosticInput；改错故障 构造诊断时必须伪造无关字段。
// INV-05 socket-close 必带 code 与 wasPaired：守住位置 close 分支；改错故障 无法区分主动断开与配对后掉线。
// INV-06 pair-status 只允许两种取值：守住位置 字面量联合；改错故障 UI 出现未知配对态。
// INV-07 WebSocketCtor 可注入：守住位置 options；改错故障 单测无法模拟断线。
// INV-08 时间参数全部可选：守住位置 各 IntervalMs；改错故障 生产与测试行为被迫一致。
// INV-09 getToken 必须可中止：守住位置 signal 参数；改错故障 退出时挂起的鉴权无法取消。
// INV-10 原始载荷回调返回布尔：守住位置 onRawTransportPayload；改错故障 上层无法声明已消费、消息被二次处理。
// INV-11 状态变更只通过回调出站：守住位置 onStateChange；改错故障 外部直接读内部状态导致不同步。
// INV-12 失败与错误分两条通道：守住位置 onFailure 与 onError；改错故障 协议失败被当成网络异常。
// INV-13 重载页面由宿主提供：守住位置 reloadPage；改错故障 传输层直接操作 window。
//
// 模块职责：Web 远控终端传输层的状态、诊断事件与选项契约。
// 阅读顺序：先看状态集合，再看诊断联合的五种形状，最后看选项接口。
import type { WebRemoteControlAppPayload, WebRemoteControlFailure } from "@zcode/shared";

export type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";

// 诊断是排查断线问题的唯一现场来源，字段只增不减。
// 五种形状按事件来源区分，不要合并成一个大可选对象。
export type WebRemoteControlTerminalTransportDiagnostic =
  | {
      type: "state-transition";
      previousState: WebRemoteControlTerminalTransportState;
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      // close 码与 wasPaired 一起记录，才能区分主动断开与配对后掉线。
      // wasClean 反映浏览器判定，不要用 code 反推。
      // [判据] `visibilityState` 与 `hiddenDurationMs` 一起进入 socket-close：页面隐藏期间的断线归为后台回收，前台断线才算异常掉线。
      type: "socket-close";
      code: number;
      reason: string;
      wasClean: boolean;
      wasPaired: boolean;
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      // 这三类没有额外业务字段，只带定位要素。
      // 不要把错误对象塞进来：诊断必须可安全序列化。
      type: "socket-error" | "recover-start" | "recover-scheduled";
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "pair-status";
      pairStatus: "waiting" | "matched";
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-extensions";
      state: WebRemoteControlTerminalTransportState;
      perMessageDeflate: boolean;
      extensions?: string;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    };

// 输入侧全字段可选，由构造方按事件类型填必需的几项。
// previousState 只在状态迁移时提供。
// 缺失字段由构造器补成类型要求的形状，而不是留 undefined。
export type WebRemoteControlTerminalTransportDiagnosticInput = {
  type: WebRemoteControlTerminalTransportDiagnostic["type"];
  previousState?: WebRemoteControlTerminalTransportState;
  state: WebRemoteControlTerminalTransportState;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  pairStatus?: "waiting" | "matched";
  perMessageDeflate?: boolean;
  extensions?: string;
};

// relayWsUrl 与 deviceSid 是连接身份，不可为空。
// 所有时间参数都有生产默认值，测试通过注入覆盖。
// onSendReady 用于区分同一 socket 复用与重连后的新 socket。
// [分层] `onPayload` / `onStateChange` 等钩子由宿主实现；传输层只回调而不碰 document 与路由，便于脱离页面复用。
export interface WebRemoteControlTerminalTransportOptions {
  relayWsUrl: string;
  deviceSid: string;
  getToken(signal: AbortSignal): Promise<string>;
  deviceMid?: string;
  appVersion?: string;
  WebSocketCtor?: typeof globalThis.WebSocket;
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectJitterMs?: number;
  healthCheckTimeoutMs?: number;
  desktopOfflineGraceMs?: number;
  staleWaitingRecoveryMs?: number;
  waitingTimeoutMs?: number;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onStateChange(state: WebRemoteControlTerminalTransportState): void;
  onFailure(failure: WebRemoteControlFailure): void;
  onError(error: Error): void;
  onDiagnostic?(diagnostic: WebRemoteControlTerminalTransportDiagnostic): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  reloadPage(): void;
}
