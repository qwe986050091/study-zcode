// INV-01 上报间隔随运行环境切换：守住位置 间隔常量；改错故障：生产沿用开发间隔，指标写入量放大五倍。
// INV-02 未配置全局上下文时静默跳过：守住位置 上报函数首段；改错故障：早期调用会在配置前发送缺维度事件。
// INV-03 维度值统一转字符串并丢弃空值：守住位置 属性序列化；改错故障：布尔被序列化成不同写法，报表按维度分裂。
// INV-04 发送异常只告警不抛出：守住位置 发送的异常分支；改错故障：埋点故障向上冒泡会中断网络主流程。
// INV-05 只有采样数大于零的阶段耗时才上报：守住位置 五个条件展开；改错故障：零样本均值会以零污染分位数统计。
// INV-06 主错误归因与计数成对出现：守住位置 主错误条件展开；改错故障：只报类型不报次数，无法判断影响面。
// INV-07 空窗口不触发任何上报：守住位置 刷新函数的早返回；改错故障：空数组也发送会让上报量随定时器空转。
// INV-08 批量事件逐条转交聚合器：守住位置 批量入口；改错故障：整批当一条会让聚合维度错位。
// INV-09 观察数据只进入聚合器不直接发送：守住位置 观察入口；改错故障：直发会绕过窗口聚合，指标失去统一口径。
// INV-10 远控中继使用固定接口名：守住位置 接口常量；改错故障：各调用点自拼名字会让同一链路拆成多个维度。
// INV-11 连接耗时归一到非负整数：守住位置 连接记录；改错故障：负数或小数进入聚合会污染均值。
// INV-12 成功时不带错误类别：守住位置 三元取值；改错故障：成功事件也带类别，会让失败率统计虚高。
// INV-13 重连按第二次尝试记录：守住位置 重连入口；改错故障：记为首次会让重试率永远为零。
// INV-14 错误分类只按已知特征归并：守住位置 分类函数；改错故障：按完整文案建类会让类别数量失控。
// INV-15 配置写入同时更新全局上下文与 SDK 属性：守住位置 配置函数；改错故障：只改其一会让事件属性与维度不一致。
// INV-16 注册前先停旧定时器并清空聚合器：守住位置 注册函数首两行；改错故障：重复注册会产生两个定时器，指标翻倍。
// INV-17 定时回调内部捕获异常：守住位置 定时器回调；改错故障：一次上报失败会让后续定时全部停止。
// INV-18 停止后句柄置空且可重复调用：守住位置 停止函数；改错故障：重复清理会在已释放句柄上操作。
//
// 模块职责：configureDesktopNetworkTelemetry 把网络观察数据聚合成窗口指标并周期上报，含远控中继的连接与重连埋点。
// 状态所有权：globalContext 与 reportTimer 句柄是模块级变量；聚合状态在独立聚合器中，本文件只驱动其生命周期。
// 阅读顺序：先看间隔与属性序列化，再看单接口上报与刷新，最后看观察入口与注册停止。
/* eslint-disable max-lines -- 网络指标采集/聚合/ARMS 上报 */
import armsRum from "@arms/rum-electron";
import { mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import type { NetworkObservation } from "@zcode/rpc";
import {
  flushInterfaceNetworkStats,
  ingestArmsApiEvent,
  recordNetworkObservation,
  resetNetworkTelemetryAggregator,
  type InterfaceNetworkStats,
} from "./networkTelemetryAggregator.js";
import { desktopRuntimeEnv } from "./desktopRuntimeEnv.js";

/** 与资源指标对齐：开发 1min、生产 5min 聚合上报 */
// NETWORK_REPORT_INTERVAL_MS 在模块加载时按 desktopRuntimeEnv === "development" ? 60_000 : 300_000 求值一次，运行期不再变化；它直接决定 setInterval 的写入量，生产若误用 60s 会把指标放大五倍，测试通过替换 desktopRuntimeEnv 观察两种间隔。
export const NETWORK_REPORT_INTERVAL_MS = desktopRuntimeEnv === "development" ? 60_000 : 300_000;

interface NetworkLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface NetworkGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

let globalContext: NetworkGlobalContext | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

// stringifyProperties 遍历 Object.entries(properties)，value === undefined 时 continue，其余 String(value)：保留 undefined 会让序列化层写出字面量 "undefined"，布尔统一成 "true"/"false" 小写以便跨端同名维度合并；函数不修改入参，返回新对象，键顺序不影响结果。
function stringifyProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

// reportNetworkCustom 在 !globalContext 时直接 return：configureDesktopNetworkTelemetry 之前的早期调用发出去会污染维度基数；payload 先铺 platform/app_version/arms_env/device_mid 再 ...properties，业务键可覆盖同名公共键；armsRum.sendCustom 的异常只 console.warn，绝不冒泡中断网络主流程。
function reportNetworkCustom(
  name: string,
  metricValue: number,
  properties: Record<string, string | number | boolean | undefined>,
): void {
  if (!globalContext) {
    return;
  }

  const payload = stringifyProperties({
    platform: normalizeOsCategory(globalContext.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    ...properties,
  });

  try {
    armsRum.sendCustom({
      name,
      type: "custom",
      group: "network",
      value: metricValue,
      properties: payload,
    });
  } catch (error) {
    console.warn("[network] sendCustom failed:", name, error);
  }
}

// reportInterfaceStats 每条 InterfaceNetworkStats 发一条 perf_network_window：value 取 stats.duration.mean，dns/tcp/tls/ttfb/download 仅在 sample_count > 0 时带上 *_ms_mean，primaryErrorKind 与 primaryErrorCount 必须成对出现；属性键统一下划线命名，与平台既有指标对齐，阶段只留均值以控制属性预算。
function reportInterfaceStats(stats: InterfaceNetworkStats): void {
  reportNetworkCustom("perf_network_window", stats.duration.mean, {
    transport: stats.transport,
    interface: stats.interface,
    request_total: stats.requestTotal,
    success_count: stats.successCount,
    fail_count: stats.failCount,
    retry_count: stats.retryCount,
    // value 已表达 duration mean；阶段耗时只保留 mean，给 counts 与主错误归因留固定预算。
    duration_ms_peak: stats.duration.peak,
    duration_ms_p95: stats.duration.p95,
    duration_ms_sample_count: stats.duration.sample_count,
    ...(stats.dns.sample_count > 0 ? { dns_ms_mean: stats.dns.mean } : {}),
    ...(stats.tcp.sample_count > 0 ? { tcp_ms_mean: stats.tcp.mean } : {}),
    ...(stats.tls.sample_count > 0 ? { tls_ms_mean: stats.tls.mean } : {}),
    ...(stats.ttfb.sample_count > 0 ? { ttfb_ms_mean: stats.ttfb.mean } : {}),
    ...(stats.download.sample_count > 0 ? { download_ms_mean: stats.download.mean } : {}),
    ...(stats.primaryErrorKind
      ? {
          primary_error_kind: stats.primaryErrorKind,
          primary_error_count: stats.primaryErrorCount,
        }
      : {}),
  });
}

// flushNetworkReports 先 flushInterfaceNetworkStats()，stats.length === 0 直接 return，避免空数组随 setInterval 空转上报；非空时逐个调 reportInterfaceStats 而不合并，保证 interface/transport 维度可下钻，最后 logger.info 记录 interfaces=${stats.length}；该函数只做一次取数与发送，清空由 flushInterfaceNetworkStats 完成。
function flushNetworkReports(logger: NetworkLogger): void {
  const stats = flushInterfaceNetworkStats();
  if (stats.length === 0) {
    return;
  }

  for (const item of stats) {
    reportInterfaceStats(item);
  }

  logger.info(`[network] perf_network flushed interfaces=${stats.length}`);
}

export function ingestArmsApiEventsFromBatch(
  events: Array<Record<string, unknown>> | undefined,
): void {
  if (!events?.length) {
    return;
  }
  for (const event of events) {
    ingestArmsApiEvent(event);
  }
}

export function ingestHostNetworkObservations(observations: NetworkObservation[]): void {
  for (const observation of observations) {
    recordNetworkObservation(observation);
  }
}

/** 远控 relay WebSocket：接口维度固定为 web_remote_control.relay */
export const WEB_REMOTE_RELAY_INTERFACE = "web_remote_control.relay";

// noteWebRemoteRelayConnectAttempt 用 interface: WEB_REMOTE_RELAY_INTERFACE 固定维度，durationMs 经 Math.max(0, Math.round(...)) 归一到非负整数，ok 为 true 时 errorKind 置 undefined、失败才走 classifyWsError，attempt 取 options?.attempt ?? 1；这里只 recordNetworkObservation，不决定是否重试。
export function noteWebRemoteRelayConnectAttempt(
  durationMs: number,
  ok: boolean,
  options?: { error?: unknown; attempt?: number },
): void {
  recordNetworkObservation({
    transport: "websocket",
    interface: WEB_REMOTE_RELAY_INTERFACE,
    durationMs: Math.max(0, Math.round(durationMs)),
    ok,
    errorKind: ok ? undefined : classifyWsError(options?.error),
    attempt: options?.attempt ?? 1,
  });
}

export function noteWebRemoteRelayReconnect(): void {
  recordNetworkObservation({
    transport: "websocket",
    interface: WEB_REMOTE_RELAY_INTERFACE,
    durationMs: 0,
    ok: false,
    errorKind: "connection_reset",
    attempt: 2,
  });
}

function classifyWsError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("dns") || message.includes("getaddrinfo")) {
    return "dns_failure";
  }
  return "connection_reset";
}

export function configureDesktopNetworkTelemetry(context: NetworkGlobalContext): void {
  globalContext = context;
  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

export function registerDesktopNetworkTelemetry(logger: NetworkLogger): void {
  stopDesktopNetworkTelemetry();
  resetNetworkTelemetryAggregator();

  reportTimer = setInterval(() => {
    try {
      flushNetworkReports(logger);
    } catch (error) {
      logger.warn("[network] report failed:", error);
    }
  }, NETWORK_REPORT_INTERVAL_MS);

  logger.info(`[network] reporting started interval=${NETWORK_REPORT_INTERVAL_MS}ms`);
}

export function stopDesktopNetworkTelemetry(): void {
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
}
