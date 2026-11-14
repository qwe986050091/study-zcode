// INV-01 单一配置所有者：telemetryConfig 必须是本模块唯一的上报配置来源，只在 configure 中整体替换；守住位置：configureRemoteUsageArmsTelemetry 的赋值与首行停止调用；改错故障：旧定时器沿用新配置，事件被发到错误的窗口通道。
// INV-02 未配置即静默：telemetryConfig 为空时所有上报路径直接返回且不告警；守住位置：dispatchSafely、reportGauge、reportPeriodicGauge 的提前返回分支；改错故障：启动早期与测试环境刷出大量无意义 warn 日志。
// INV-03 定时器唯一：周期采样定时器在同一时刻至多存在一个句柄；守住位置：configureRemoteUsageArmsTelemetry 先 stop 再重建的顺序；改错故障：连续配置后多次采样，看板数值翻倍。
// INV-04 事件名固定白名单：三个事件名只能来自模块常量，禁止按参数拼接；守住位置：REMOTE_USAGE_ARMS_EVENT 系列常量与三个 build 函数；改错故障：后端看板按事件名聚合时出现未知事件，指标断流。
// INV-05 属性白名单：properties 只允许 result、remote_kind、connect_trigger、error_category、sample_reason、transition、active_target_count、disconnect_reason、duration_ms；守住位置：三个 build 函数的返回对象；改错故障：上游新增字段泄漏敏感信息并让看板维度膨胀。
// INV-06 失败必有分类：失败结果的 error_category 必须恒为非空，缺失时回落到 unknown；守住位置：buildRemoteConnectResultArmsPayload 的三元分支；改错故障：失败样本落入空分类，排障无法定位错误类型。
// INV-07 采样窗口固定：gauge 周期固定为 300_000 毫秒，不随会话数或网络状况自适应；守住位置：REMOTE_USAGE_GAUGE_INTERVAL_MS；改错故障：窗口抖动让活跃会话曲线出现台阶与误判。
// INV-08 零值过滤：周期采样在活跃会话数小于等于 0 时跳过上报；守住位置：reportPeriodicGauge 的提前返回；改错故障：空闲时段灌入大量 0 值样本，拉低均值。
// INV-09 窗口归属唯一：周期样本只能归属最近一次状态变更的 rendererId；守住位置：lastGaugeRendererId 的赋值与读取；改错故障：多窗口下样本记到错误窗口，单窗口指标失真。
// INV-10 状态变更不含 none：状态变更路径只接受 connected 与各类关闭原因；守住位置：reportRemoteConnectionStateChangedToArms 的类型约束；改错故障：把周期语义混进变更事件，导致重复计数。
// INV-11 时长双写一致：断开事件的 value 与 duration_ms 必须是同一个值；守住位置：buildRemoteDisconnectArmsPayload 的两处赋值；改错故障：按 value 与按属性统计得到两份不同时长。
// INV-12 发送异常不外抛：发送失败只写 warn，绝不影响调用方的连接主流程；守住位置：dispatchSafely 的 try 块；改错故障：遥测故障导致远程连接建立失败。
// INV-13 读取统计异常隔离：读取连接统计失败时不发送半成品事件；守住位置：reportGauge 与 reportPeriodicGauge 的 try 边界；改错故障：缺字段事件写入后端，出现空维度脏数据。
// INV-14 生命周期排空：停止采样必须清除句柄并把全局槽位置空；守住位置：stopRemoteUsageArmsPeriodicSampling 的清除与置空；改错故障：窗口关闭后仍在上报，进程退出被拖慢。
// INV-15 不阻塞退出：Node 定时器句柄需要 unref，数字句柄保持原样；守住位置：configure 中的 typeof 判断；改错故障：后台定时器阻止进程退出，App 无法关闭。
// INV-16 测试可重置：重置函数恢复三个全局变量到初始状态；守住位置：resetRemoteUsageArmsTelemetryForTest；改错故障：用例之间串状态，出现偶发失败。
// INV-17 时钟可注入：setInterval 与 clearInterval 支持注入，默认回落全局实现；守住位置：配置对象的可选字段与调用处的空值合并；改错故障：单测依赖真实时间，运行慢且不稳定。
// INV-18 E2E 透传受控：e2eController 必须只透传给发送函数，不改变线上发送路径；守住位置：dispatchSafely 传入的调用参数；改错故障：测试钩子泄漏到生产路径，事件被重复投递。
//
// 模块职责：把桌面远控的连接结果、活跃会话量与断开动作收敛为三个 ARMS 自定义事件，并负责固定窗口采样与生命周期排空。
// 状态所有权：telemetryConfig、periodicTimer、lastGaugeRendererId 必须是仅有的可变状态，全部留在本文件，不向调用方暴露。
// 阅读顺序：先看事件常量与三个 build 函数，再看 dispatchSafely 的失败边界，最后看周期采样与 stop 的退出路径。
import type {
  ArmsCustomEventPayload,
  ArmsRumEnv,
  FinalArmsCustomEventPayload,
  RemoteUsageErrorCategory,
  RemoteUsageRemoteKind,
  RemoteUsageResult,
  RemoteWorkspaceConnectTrigger,
} from "@zcode/shared";
import {
  dispatchFinalArmsCustomEvent,
  type FinalArmsCustomEventE2EController,
} from "./desktopArmsCustomEvent.js";

// [权衡] 事件名与分组名用常量固化，改口径必须动代码并经过评审，避免配置化后出现拼写漂移。
// [资源] 一个事件只承载一条连接结果，不做批量聚合，保证后端按事件粒度统计时不会重复计数。
// 三个事件分别对应连接结果、活跃会话量与断开，任何新增事件都应先补常量与 build 函数。
export const REMOTE_USAGE_ARMS_GROUP = "remote_usage";
export const REMOTE_USAGE_ARMS_EVENT_CONNECT_RESULT = "remote_connect_result";
export const REMOTE_USAGE_ARMS_EVENT_ACTIVE_SESSION_COUNT =
  "remote_active_session_count";
export const REMOTE_USAGE_ARMS_EVENT_DISCONNECT = "remote_disconnect";
// [权衡] 300_000 毫秒是活跃会话量的采样窗口，兼顾曲线分辨率与后台开销。
// [资源] 窗口内不能做补偿采样，错过的周期不补发，所以避免短时间堆积请求。
// 改窗口前先确认后端看板的聚合粒度，窗口小于聚合粒度会让曲线出现锯齿。
export const REMOTE_USAGE_GAUGE_INTERVAL_MS = 300_000;

// 统计快照只包含活跃会话数与活跃目标数，读取方按值使用，不共享内部集合。
// [并发] 快照由注入的 readSnapshot 即时生成，采样点之间不缓存旧值。
// 两个计数都必须为非负整数，负数代表实现侧缺陷，不在上报层做纠正。
export interface RemoteConnectionStats {
  activeSessionCount: number;
  activeTargetCount: number;
}

export type RemoteGaugeTransition =
  | "connected"
  | "connection-closed"
  | "disposed"
  | "window-closed"
  | "host-exit"
  | "app-shutdown"
  | "none";

export type RemoteDisconnectReason = Exclude<
  RemoteGaugeTransition,
  "connected" | "none"
>;

type IntervalHandle = ReturnType<typeof setInterval> | number;

interface RemoteUsageArmsTelemetryConfig {
  armsCustomContext: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
  };
  // [失败路径] 读取函数可能抛错，调用方必须包在 try 内，不能让它打断采样。
  // [权衡] 用函数注入而不是传对象，保证每次采样读到的是最新连接状态。
  // 实现方需保证读取为同步且廉价，不在这里做 IO 或跨进程等待。
  getRemoteConnectionStats: () => RemoteConnectionStats;
  sendCustom: (payload: FinalArmsCustomEventPayload) => void;
  e2eController?: FinalArmsCustomEventE2EController | null;
  logger: { warn: (...args: unknown[]) => void };
  setInterval?: (
    callback: () => void,
    delayMs: number,
  ) => IntervalHandle;
  clearInterval?: (timer: IntervalHandle) => void;
}

// [并发] 配置必须整体替换而不是逐字段合并，避免新旧配置混用出半套发送通道。
// [资源] 配置里持有 logger 与发送函数，替换后旧引用不再被模块级变量持有。
// 读取方必须统一先取局部快照，防止替换期间出现半途读取。
let telemetryConfig: RemoteUsageArmsTelemetryConfig | null = null;
let periodicTimer: IntervalHandle | null = null;
// [并发] 该值只在状态变更路径写入，周期采样只读，避免多窗口互相覆盖归属。
// 为空时周期采样必须直接返回，不能猜测目标窗口。
// [失败路径] 窗口销毁后若未清理，周期样本会继续指向已失效的 renderer。
let lastGaugeRendererId: number | null = null;

export function buildRemoteConnectResultArmsPayload(params: {
  result: RemoteUsageResult;
  remoteKind: RemoteUsageRemoteKind;
  connectTrigger: RemoteWorkspaceConnectTrigger;
  errorCategory?: RemoteUsageErrorCategory;
}): ArmsCustomEventPayload {
  return {
    name: REMOTE_USAGE_ARMS_EVENT_CONNECT_RESULT,
    group: REMOTE_USAGE_ARMS_GROUP,
    value: 1,
    properties: {
      result: params.result,
      remote_kind: params.remoteKind,
      connect_trigger: params.connectTrigger,
      // [失败路径] 成功结果恒写空串，失败结果写入具体分类，缺失时回落 unknown。
      // 分类是排障主维度，不允许写自由文本，否则聚合结果不可用。
      // [权衡] 用空串而非缺省字段表示成功，保证后端字段 schema 稳定。
      // 新增分类需同时在共享类型与后端枚举登记，避免出现未知取值。
      error_category:
        params.result === "success" ? "" : (params.errorCategory ?? "unknown"),
    },
  };
}

export function buildRemoteActiveSessionCountArmsPayload(
  params: {
    sampleReason: "state-change" | "periodic";
    transition: RemoteGaugeTransition;
    remoteKind?: RemoteUsageRemoteKind;
  },
  stats: RemoteConnectionStats,
): ArmsCustomEventPayload {
  return {
    name: REMOTE_USAGE_ARMS_EVENT_ACTIVE_SESSION_COUNT,
    group: REMOTE_USAGE_ARMS_GROUP,
    value: stats.activeSessionCount,
    properties: {
      sample_reason: params.sampleReason,
      transition: params.transition,
      remote_kind: params.remoteKind ?? "",
      active_target_count: stats.activeTargetCount,
    },
  };
}

export function buildRemoteDisconnectArmsPayload(params: {
  remoteKind: RemoteUsageRemoteKind;
  disconnectReason: RemoteDisconnectReason;
  durationMs: number;
}): ArmsCustomEventPayload {
  return {
    name: REMOTE_USAGE_ARMS_EVENT_DISCONNECT,
    group: REMOTE_USAGE_ARMS_GROUP,
    value: params.durationMs,
    properties: {
      remote_kind: params.remoteKind,
      disconnect_reason: params.disconnectReason,
      // [权衡] 时长同时放进 value 与属性，方便既按数值也按维度查询。
      // 两处必须来自同一入参，任一改动都要同步，防止统计口径分叉。
      // 单位固定为毫秒，不做秒级换算，避免小数导致精度丢失。
      duration_ms: params.durationMs,
    },
  };
}

export function configureRemoteUsageArmsTelemetry(
  config: RemoteUsageArmsTelemetryConfig,
): void {
  stopRemoteUsageArmsPeriodicSampling();
  telemetryConfig = config;
  // [权衡] 定时器实现必须可注入，默认回落全局实现，方便测试控制时间。
  // [并发] 注入的实现必须与注入的清除函数成对出现，混用会留下野定时器。
  // 配置重建时 main 必须先停旧定时器，再按新实现排期。
  const schedule = config.setInterval ?? setInterval;
  periodicTimer = schedule(reportPeriodicGauge, REMOTE_USAGE_GAUGE_INTERVAL_MS);
  // Bug 根因：desktop main 同时被 Node 与 DOM lib 检查，setInterval handle 会被推导成
  // Timeout | number；仅 Node handle 支持 unref，数字 handle 仍需保留给 clearInterval。
  // [资源] Node 句柄调用 unref，让后台采样不阻止进程退出。
  // [权衡] 数字句柄来自 DOM 类型推导，没有 unref，只能交给清除函数释放。
  // 类型判断不能简化成布尔强转，数字 0 也是合法句柄。
  if (typeof periodicTimer !== "number") periodicTimer.unref?.();
}

// [失败路径] 发送链路整体包在 try 内，任何异常都只降级成一条 warn。
// [并发] 每次发送前重新取配置快照，配置替换不会让发送拿到旧通道。
// 遥测属于旁路能力，失败不得向上传播，也不能重试放大故障。
function dispatchSafely(
  rendererId: number,
  payload: ArmsCustomEventPayload,
): void {
  const config = telemetryConfig;
  if (!config) return;
  try {
    dispatchFinalArmsCustomEvent({
      payload,
      context: { ...config.armsCustomContext, rendererId },
      e2eController: config.e2eController,
      sendCustom: config.sendCustom,
    });
  } catch (error) {
    config.logger.warn("[remote-usage-arms] dispatch failed", {
      eventName: payload.name,
      error,
    });
  }
}

export function reportRemoteConnectResultToArms(params: {
  rendererId: number;
  result: RemoteUsageResult;
  remoteKind: RemoteUsageRemoteKind;
  connectTrigger: RemoteWorkspaceConnectTrigger;
  errorCategory?: RemoteUsageErrorCategory;
}): void {
  dispatchSafely(
    params.rendererId,
    buildRemoteConnectResultArmsPayload(params),
  );
}

function reportGauge(params: {
  rendererId: number;
  sampleReason: "state-change" | "periodic";
  transition: RemoteGaugeTransition;
  remoteKind?: RemoteUsageRemoteKind;
}): void {
  const config = telemetryConfig;
  if (!config) return;
  try {
    const stats = config.getRemoteConnectionStats();
    dispatchSafely(
      params.rendererId,
      buildRemoteActiveSessionCountArmsPayload(params, stats),
    );
  } catch (error) {
    config.logger.warn("[remote-usage-arms] read stats failed", { error });
  }
}

function reportPeriodicGauge(): void {
  const config = telemetryConfig;
  if (!config || lastGaugeRendererId == null) return;
  try {
    const stats = config.getRemoteConnectionStats();
    // [权衡] 空闲时段必须不上报 0 值，避免用无意义样本稀释活跃曲线。
    // [失败路径] 计数为负说明实现异常，同样按跳过处理而不是上报异常值。
    // 跳过发生在发送之前，因此不会留下只有属性没有数值的半成品事件。
    if (stats.activeSessionCount <= 0) return;
    dispatchSafely(
      lastGaugeRendererId,
      buildRemoteActiveSessionCountArmsPayload(
        { sampleReason: "periodic", transition: "none" },
        stats,
      ),
    );
  } catch (error) {
    config.logger.warn("[remote-usage-arms] periodic stats failed", { error });
  }
}

export function reportRemoteConnectionStateChangedToArms(params: {
  rendererId: number;
  transition: Exclude<RemoteGaugeTransition, "none">;
  remoteKind: RemoteUsageRemoteKind;
}): void {
  if (!telemetryConfig) return;
  // [并发] 状态变更先记录窗口归属再采样，保证本次样本与后续周期样本指向同一窗口。
  // 未配置遥测时直接返回，不污染窗口归属，避免配置前的无效写入。
  // 断开与状态变更必须共享同一归属字段，二者语义不同但目标窗口一致。
  lastGaugeRendererId = params.rendererId;
  reportGauge({
    ...params,
    sampleReason: "state-change",
  });
}

export function reportRemoteDisconnectToArms(params: {
  rendererId: number;
  remoteKind: RemoteUsageRemoteKind;
  disconnectReason: RemoteDisconnectReason;
  durationMs: number;
}): void {
  dispatchSafely(params.rendererId, buildRemoteDisconnectArmsPayload(params));
}

export function stopRemoteUsageArmsPeriodicSampling(): void {
  const timer = periodicTimer;
  if (!timer) return;
  // [资源] 停止采样必须显式清除句柄，再置空全局槽位，两步都不可省。
  // [失败路径] 清除函数支持注入，缺失时回落全局实现，保证卸载路径总能释放定时器。
  // [权衡] 幂等设计：重复调用在句柄为空时直接返回，不做额外判断。
  // 退出、窗口关闭与测试重置都必须汇聚到这一个停止入口，避免多条释放路径。
  (telemetryConfig?.clearInterval ?? clearInterval)(timer);
  periodicTimer = null;
}

export function resetRemoteUsageArmsTelemetryForTest(): void {
  stopRemoteUsageArmsPeriodicSampling();
  telemetryConfig = null;
  lastGaugeRendererId = null;
}
