// INV-01 所有资源事件只能经 reportResourceCustom 写入 ARMS，group 固定 resource、type 固定 custom；守住位置：reportResourceCustom 单一出口；改错故障：出现第二条出口后事件重复计数，资源面板数值翻倍。
// INV-02 globalContext 未配置前不得产生任何资源事件；守住位置：reportResourceCustom 与 ingestToolExecResource 的早返回；改错故障：启动早期事件缺少 device_mid，控制台出现无法归属的脏数据。
// INV-03 采样与上报必须分离，采样只写窗口、只有 flush 与退出排空才 drain；守住位置：takeSample 与 drainAllResourceWindows；改错故障：边采边报会让窗口永远凑不满 5 分钟趋势，事件数量暴涨。
// INV-04 main 角色 heap 只能由本模块就地读取并合并进样本，缺失时保留来源样本原值；守住位置：takeSample 中 heapUsedKbByRole 合并分支；改错故障：用 0 覆盖会让 main 角色堆曲线出现周期性假谷。
// INV-05 设备级来源必须在角色级来源全部完成后运行；守住位置：takeSample 第二阶段调用；改错故障：提前运行会用到半成品合计，perf_system_window 的 app 内存偏低。
// INV-06 带 completionToken 的完成事实必须去重，无 token 的旧 CLI 负载必须保留原行为；守住位置：ingestToolExecResource 去重分支；改错故障：多窗口转发被重复计数，工具耗时指标虚高。
// INV-07 去重集合不得超过 MAX_RECENT_TOOL_EXEC_COMPLETIONS；守住位置：ingestToolExecResource 的淘汰分支；改错故障：长会话无限增长，main 内存随工具调用次数单调上升。
// INV-08 backgroundRatio 必须在 drain 之前取值；守住位置：drainAllResourceWindows 的取值顺序；改错故障：drain 清零后再读，前后台占比恒为 0。
// INV-09 两个定时器都必须 unref；守住位置：registerDesktopResourceTelemetry 启动末尾；改错故障：仅剩遥测定时器时进程不退出，用户关窗后主进程滞留。
// INV-10 register 必须先 stop 再重建状态；守住位置：registerDesktopResourceTelemetry 首行调用；改错故障：重复注册叠加定时器，采样频率翻倍且无法回收。
// INV-11 stop 只在 flushPendingWindows 为真时排空，否则直接清窗；守住位置：stopDesktopResourceTelemetry 分支；改错故障：正常退出丢残窗，最后一段趋势在控制台缺失。
// INV-12 tick 回调内的异常必须被捕获并降级为 warn；守住位置：两个 setInterval 回调的 try/catch；改错故障：单次来源异常抛穿定时器，后续采样全部停摆。
// INV-13 sendCustom 抛错只能丢当前事件；守住位置：reportResourceCustom 的 try/catch；改错故障：SDK 异常向上冒泡，整轮 flush 中止。
// INV-14 退出路径不得新采样，也不得起外部进程，所以 flushPendingSourceReadings 只搬运已有读数；守住位置：flushPendingSourceReadings 只搬运已有读数；改错故障：退出时拉起 PowerShell 或 WMI，Windows 关机被拖慢。
// INV-15 E2E 必须在 sendCustom 之前录制，被抑制时不得真实发送；守住位置：reportResourceCustom 的 record 与 shouldSuppress；改错故障：断言读到的是上游截断数据，E2E 误报。
// INV-16 main 内存每 6 个 tick 读一次，日志与角色 heap 必须共用同一次读数，所以 takeSample 用 memoryLogTick 取模；改错故障：两处各自读一次内存，日志与事件数值不一致。
// INV-17 遥测自证耗时只能落在下一个窗口；守住位置：measureTelemetrySelfMs 的 finally；改错故障：试图回写已投影窗口，事件属性与实际耗时错位。
// INV-18 Agent 指标探针禁用审计必须在 win32、test 环境、E2E 日志目录齐备时才记录一次；守住位置：auditDisabledAgentMetricProbe 的守卫；改错故障：E2E 合同失效，同步外部探针可能被重新引入 main。
//
// 模块职责：main 侧进程资源遥测的唯一出口，10 秒采样先入有界窗口，再按角色与设备两个维度聚合，最后周期性 flush 到 ARMS。
// 状态所有权：globalContext、desktopHardware、两个窗口聚合器、去重集合与两个定时器都由本模块私有持有，外部只能经导出函数配置与启停。
// 阅读顺序：先看 INV 与常量，再看 reportResourceCustom 出口，然后 takeSample 编排、drainAllResourceWindows 排空，最后 configure、register、stop 生命周期。
import armsRum from "@arms/rum-electron";
import {
  bytesToKb,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  mapZCodeEnvToArmsRumEnv,
  memoryUsageToSampleFields,
  type MemorySample,
  type MemorySampleWriteGate,
  type ProcessResourceRole,
  type ProcessResourceRuntimeSurface,
  PROCESS_RESOURCE_EVENT_NAMES,
  zcodeToolExecResourceSchema,
} from "@zcode/shared";
import { BrowserWindow } from "electron";
import os from "node:os";
import { getSharedFinalArmsCustomEventE2EController } from "./desktopArmsCustomEvent.js";
import { desktopRuntimeEnv } from "./desktopRuntimeEnv.js";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";
import { addAppResourceTotals, type AppResourceTotals } from "./processResourceAppTotals.js";
import { PROCESS_RESOURCE_SAMPLE_SOURCES } from "./processResourceSampleSourceRegistry.js";
import {
  flushPendingProcessResourceSampleSources,
  resetProcessResourceSampleSources,
  runProcessResourceDeviceSampleSources,
  runProcessResourceSampleSources,
} from "./processResourceSampleSources.js";
import { ProcessResourceSystemWindowAggregator } from "./processResourceSystemWindowAggregator.js";
import {
  buildSystemWindowEventProperties,
  PERF_SYSTEM_WINDOW_EVENT_NAME,
} from "./processResourceSystemWindowEvent.js";
import {
  ProcessResourceWindowAggregator,
  type ProcessResourceHardware,
  type ProcessRoleSample,
} from "./processResourceWindowAggregator.js";
import {
  buildProcessWindowEventProperties,
  normalizeOsCategory,
  PERF_PROCESS_WINDOW_EVENT_NAME,
} from "./processResourceWindowEvent.js";
import { listRegisteredHostAgentProcessIds } from "./resourceManagerWindow.js";

/**
 * main 侧进程资源遥测。
 *
 * 唯一的 ARMS 资源出口：10 秒 tick 让每个样本来源写入有界窗口，
 * 5 分钟（开发构建与 E2E 1 分钟）flush 出每角色一条 `perf_process_window`
 * 与每设备一条 `perf_system_window`，正常退出排空残窗。
 * 性能红线：main 进程零外部进程，全链路禁止 PowerShell / WMI / CIM。
 */

/** 采样间隔 */
// 10 秒采样节拍是唯一时间源，两个定时器都不自带相位，tick 与 flush 必须用同一时钟推进窗口边界。
// [权衡] 固定 10s 让 5 分钟窗口稳定容纳约 30 个样本，再密只会增加 main 每 tick 的全量遍历成本。
export const RESOURCE_SAMPLE_INTERVAL_MS = 10_000;

/** 开发构建与 E2E 用 1 分钟窗口便于验证；生产 5 分钟。 */
// 窗口长度按运行模式解析：development 与 test+E2E 都用 60s，其余生产构建 300s。
// [失败路径] ZCODE_E2E_RUN_ID 为空串时不算 E2E，避免本地误配把生产窗口缩短。
function resolveDefaultReportIntervalMs(): number {
  if (desktopRuntimeEnv === "development") {
    return 60_000;
  }
  // E2E 跑的是打包构建，没有这个短窗口就无法在一次用例里观察到趋势事件。
  if (process.env.ZCODE_ENV === "test" && process.env.ZCODE_E2E_RUN_ID?.trim()) {
    return 60_000;
  }
  return 300_000;
}

/** 上报间隔 */
// 上报间隔在模块加载时求值一次并冻结，运行期不再跟随环境变量变化，保证定时器与启动日志一致。
// [权衡] 常量导出供单测直接断言，生产注入走 registerDesktopResourceTelemetry 的 options。
export const RESOURCE_REPORT_INTERVAL_MS = resolveDefaultReportIntervalMs();

/**
 * 本地内存诊断日志：借用 10s 资源采样节拍，
 * 每 6 个 tick（≈60s）读一次 main 自身内存，同一次读数既写主日志又作为 main 角色的 heap 样本。
 */
// 内存诊断复用 10s 采样节拍，必须每 6 个 tick 才读一次 main 自身内存，约 60s 一条本地日志。
// [资源] 不为内存日志单独起定时器，避免 main 进程多一条常驻计时链路。
export const MEMORY_LOG_SAMPLE_EVERY_N_TICKS = 6;

export type ResourceUsageScene = "foreground" | "background";

interface ResourceLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface ResourceGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

let globalContext: ResourceGlobalContext | null = null;
let desktopHardware: ProcessResourceHardware | null = null;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;
let agentMetricProbeDisabledAuditLogged = false;
let memoryLogTick = 0;
let memorySampleWriteGate: MemorySampleWriteGate = createMemorySampleWriteGate();
/** 自证开销时钟；只有单测会替换成可预期的假时钟。 */
let readTelemetrySelfClockMs: () => number = () => performance.now();

const processResourceWindows = new ProcessResourceWindowAggregator();
const processResourceSystemWindow = new ProcessResourceSystemWindowAggregator();
/** 完成事实只需覆盖多连接转发的近期重复，固定预算避免长会话无界增长。 */
// 去重集合的硬上限 1024：只覆盖多连接转发的近期重复，同时约束长会话不无界增长。
// [资源] 上限取常量而非配置，避免运行期被调大后回不到有界状态。
const MAX_RECENT_TOOL_EXEC_COMPLETIONS = 1_024;
const recentToolExecCompletions = new Set<string>();

function resolveDesktopHardware(platform: NodeJS.Platform): ProcessResourceHardware {
  return {
    platform,
    arch: process.arch,
    logicalCpuCount: os.cpus().length,
    totalMemoryGb: Math.round(os.totalmem() / 1024 ** 3),
  };
}

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

// [并发] 所有资源事件都必须从此处写 ARMS，group 固定 resource，属性统一转成字符串。
// [失败路径] globalContext 为空直接返回，配置完成前不产生半成品事件。
// E2E 控制器先录制再判断抑制，抑制时返回，真实发送被跳过但断言仍能读到内容。
function reportResourceCustom(
  name: string,
  /** ARMS custom 的 value 字段：控制台默认展示的主指标数值 */
  metricValue: number,
  properties: Record<string, string | number | boolean | undefined>,
): void {
  if (!globalContext) {
    return;
  }

  const payload = {
    name,
    type: "custom" as const,
    group: "resource",
    value: metricValue,
    properties: stringifyProperties(properties),
  };

  // E2E 在 sendCustom 之前捕获，读到的就是真实上报内容。
  const e2eController = getSharedFinalArmsCustomEventE2EController();
  e2eController?.record(payload);
  if (e2eController?.shouldSuppress(name)) {
    return;
  }

  try {
    armsRum.sendCustom(payload);
  } catch (error) {
    console.warn("[resource] sendCustom failed:", name, error);
  }
}

// 场景判定只看未被销毁的窗口：任取焦且可见未最小化才算 foreground，否则 background。
// [并发] 每次 takeSample 都必须重新查询窗口状态，不缓存结果，避免窗口关闭后仍按旧场景计数。
export function resolveResourceUsageScene(): ResourceUsageScene {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (windows.length === 0) {
    return "background";
  }

  const anyFocused = windows.some((win) => win.isFocused());
  const anyVisible = windows.some((win) => win.isVisible() && !win.isMinimized());
  return anyFocused && anyVisible ? "foreground" : "background";
}

/** 完成事实即时上报，复用唯一资源出口；不进入五分钟窗口或会话恢复链路。 */
// 工具执行完成事实的即时入口：绕过五分钟窗口与会话恢复链路，直接落 ARMS 自定义事件。
// [失败路径] 未配置上下文或 schema 校验失败都静默返回，旧 CLI 的脏负载不得污染资源指标。
// [并发] 只在 main 唯一出口去重，因为同一 Server 可能经多个 workspace 与 window Host 转发。
export function ingestToolExecResource(
  raw: unknown,
  runtimeSurface: ProcessResourceRuntimeSurface,
): void {
  if (!globalContext) return;
  const parsed = zcodeToolExecResourceSchema.safeParse(raw);
  if (!parsed.success) return;
  const sample = parsed.data;
  // 同一 Server 可经多个 workspace 和 window Host 转发完成事实；只在 main 唯一出口去重。
  // 无标识的旧 CLI 保留原行为，不能按量化指标去重，否则会吞掉不同的真实命令。
  if (sample.completionToken) {
    if (recentToolExecCompletions.has(sample.completionToken)) return;
    recentToolExecCompletions.add(sample.completionToken);
    // 超过上限时按插入顺序淘汰最旧 token：Set 迭代顺序即插入顺序，FIFO 足以覆盖近期重复窗。
    // [资源] 淘汰与插入必须在同一步完成，没有额外定时清理，集合大小恒定有界。
    if (recentToolExecCompletions.size > MAX_RECENT_TOOL_EXEC_COMPLETIONS) {
      const oldest = recentToolExecCompletions.values().next().value;
      if (oldest !== undefined) recentToolExecCompletions.delete(oldest);
    }
  }
  reportResourceCustom(PROCESS_RESOURCE_EVENT_NAMES.toolExecResource, sample.durationMs, {
    platform: normalizeOsCategory(sample.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    runtime_surface: runtimeSurface,
    tool_name: sample.toolName,
    exit_kind: sample.exitKind,
    sample_count: sample.sampleCount,
    cli_rss_kb: sample.cliRssKb,
    system_free_memory_kb: sample.systemFreeMemoryKb,
    ...(sample.platform === "win32"
      ? {}
      : {
          tree_rss_kb_peak: sample.treeRssKbPeak ?? 0,
          tree_cpu_time_ms: sample.treeCpuTimeMs ?? 0,
        }),
  });
}

function auditDisabledAgentMetricProbe(logger: ResourceLogger | undefined): void {
  if (
    agentMetricProbeDisabledAuditLogged ||
    process.platform !== "win32" ||
    process.env.ZCODE_ENV !== "test" ||
    !process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim()
  ) {
    return;
  }

  const agentCount = listRegisteredHostAgentProcessIds().length;
  if (agentCount === 0) {
    return;
  }

  agentMetricProbeDisabledAuditLogged = true;
  // E2E 审计合同：该记录仅证明真实采样周期在 Agent PID 已注册时
  // 明确跳过外部指标采集。若未来恢复采集，必须先记录 action=spawn，
  // Windows E2E 会因此失败，防止再次把同步 PowerShell 带回 main process。
  logger?.info(
    `[resource] agent_metric_probe action=skipped reason=main_process_external_probe_disabled agent_count=${agentCount}`,
  );
}

function readMainMemoryUsage(): NodeJS.MemoryUsage | null {
  try {
    return process.memoryUsage();
  } catch {
    return null;
  }
}

// 内存样本落本地日志前先汇总诊断计数器，并把各角色 rss 以 ws.<role> 键注入同一条样本。
// [失败路径] 整段必须包在 try/catch 内，诊断日志失败只丢当前样本，不影响资源采样与上报。
function logMemorySample(
  logger: ResourceLogger | undefined,
  memoryUsage: NodeJS.MemoryUsage,
  samples: readonly ProcessRoleSample[],
): void {
  if (!logger) {
    return;
  }
  try {
    const counters = mainMemoryDiagnosticsRegistry.collect();
    for (const sample of samples) {
      counters[`ws.${sample.role}`] = sample.rssKbTotal;
    }
    const sample: MemorySample = {
      role: "main",
      ...memoryUsageToSampleFields(memoryUsage),
      counters,
    };
    // 写入闸门决定本次读数是否落日志：reason 为空表示节流或抑制，非空才真正写出。
    // [权衡] 闸门状态由 shared 的 createMemorySampleWriteGate 持有，main 只做单次判定。
    const reason = memorySampleWriteGate.evaluate(sample, Date.now());
    if (reason) {
      logger.info(formatMemorySampleLine(sample, reason));
    }
  } catch {
    // 诊断日志失败只丢当前样本，不影响资源采样与 ARMS 上报。
  }
}

// 一次 tick 的唯一编排点：先记场景，再跑角色来源，然后补 main heap，最后跑设备级来源。
// [并发] 两个阶段串行，第二阶段依赖第一阶段同一 tick 的精确合计，不能交换顺序。
// [失败路径] 单个来源报错走 onError 只 warn，其余来源与窗口写入照常完成。
function takeSample(logger?: ResourceLogger): void {
  processResourceWindows.recordScene(resolveResourceUsageScene());

  const now = Date.now();
  const samples: ProcessRoleSample[] = [];
  /**
   * 只有进程自己读得到 heap：main 在下面就地读，host / scheduler / renderer 由各自的
   * 自采样本来源投递。heap 不足以独立开窗，统一并入同一 tick 内该角色的完整样本。
   */
  const heapUsedKbByRole = new Map<ProcessResourceRole, number>();
  let appProcessTotals: AppResourceTotals | null = null;
  const onError = (sourceId: string, error: unknown): void =>
    logger?.warn(`[resource] sample source ${sourceId} failed:`, error);
  // 角色级来源回填三个回调：角色样本、角色 heap、应用进程合计，heap 先入 map 等角色样本到位再合并。
  // [资源] 来源清单来自 PROCESS_RESOURCE_SAMPLE_SOURCES，main 不自行起子进程或外部探针。
  runProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now,
    addRoleSample: (sample) => samples.push(sample),
    addRoleHeapSample: (role, heapUsedKb) => heapUsedKbByRole.set(role, heapUsedKb),
    addAppProcessTotals: (totals) => {
      appProcessTotals = appProcessTotals ? addAppResourceTotals(appProcessTotals, totals) : totals;
    },
    onError,
  });

  // 每 6 个 tick（≈60s）读一次 main 自身内存：同一次读数既写本地 `[memory]` 日志，
  // 又作为 main 角色事件的 heap 样本，两处数值天然一致且不新增定时器。
  memoryLogTick += 1;
  const mainMemoryUsage =
    memoryLogTick % MEMORY_LOG_SAMPLE_EVERY_N_TICKS === 0 ? readMainMemoryUsage() : null;
  if (mainMemoryUsage) {
    heapUsedKbByRole.set("main", bytesToKb(mainMemoryUsage.heapUsed));
  }

  for (const sample of samples) {
    const heapUsedKb = heapUsedKbByRole.get(sample.role);
    processResourceWindows.add(heapUsedKb === undefined ? sample : { ...sample, heapUsedKb });
  }

  if (mainMemoryUsage) {
    logMemorySample(logger, mainMemoryUsage, samples);
  }

  // 第二阶段：设备级来源要用同一 tick 的精确合计，所以必须等第一阶段全部来源跑完。
  // 设备级来源在角色来源结束后运行，用同一 tick 的 appProcessTotals 计算精确合计。
  // [权衡] 设备样本必须直接进 system 窗口，不经角色聚合器，避免两类窗口互相污染。
  runProcessResourceDeviceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now,
    appProcessTotals,
    addDeviceSample: (sample) => processResourceSystemWindow.add(sample),
    onError,
  });

  auditDisabledAgentMetricProbe(logger);
}

/**
 * main 侧遥测代码自身的墙钟耗时：以 `telemetry_self_ms` 上报。
 * flush 的耗时落在下一个窗口——它发生在窗口投影之后，无法计入已经发出的那条事件。
 */
// 遥测自身耗时的测量外壳：开始前取时钟，运行结束在 finally 里把差值记到系统窗口。
// [权衡] 自证耗时总落在下一个窗口，因为 flush 在窗口投影之后发生，改不回已发出的事件。
function measureTelemetrySelfMs(run: () => void): void {
  const startedAt = readTelemetrySelfClockMs();
  try {
    run();
  } finally {
    processResourceSystemWindow.addTelemetrySelfMs(readTelemetrySelfClockMs() - startedAt);
  }
}

// 上下文缺失时清空角色窗口并返回，防止未配置期堆积的样本在配置后被误当作真实趋势。
// 每条 drain 出的报告生成一条 perf_process_window，主指标取 cpuPercentMean。
function reportProcessResourceWindows(): void {
  if (!globalContext || !desktopHardware) {
    processResourceWindows.clear();
    return;
  }
  const context = {
    deviceMid: globalContext.deviceMid,
    appVersion: globalContext.appVersion,
    armsEnv: globalContext.armsEnv,
    desktopHardware,
  };
  for (const report of processResourceWindows.drain()) {
    reportResourceCustom(
      PERF_PROCESS_WINDOW_EVENT_NAME,
      report.cpuPercentMean,
      buildProcessWindowEventProperties(report, context),
    );
  }
}

/** 应用运行时长：main 进程与 App 同生共死，直接取它的运行时长。 */
function resolveAppUptimeMinutes(): number {
  const uptimeSeconds = process.uptime();
  return Number.isFinite(uptimeSeconds) ? Math.max(0, Math.round(uptimeSeconds / 60)) : 0;
}

function reportSystemResourceWindow(backgroundRatio: number): void {
  if (!globalContext || !desktopHardware) {
    processResourceSystemWindow.clear();
    return;
  }
  const report = processResourceSystemWindow.drain({
    backgroundRatio,
    appUptimeMinutes: resolveAppUptimeMinutes(),
  });
  if (!report) {
    return;
  }
  reportResourceCustom(
    PERF_SYSTEM_WINDOW_EVENT_NAME,
    report.appCpuPercentMean,
    buildSystemWindowEventProperties(report, {
      deviceMid: globalContext.deviceMid,
      appVersion: globalContext.appVersion,
      armsEnv: globalContext.armsEnv,
      desktopHardware,
    }),
  );
}

/**
 * 把各来源「已经收到、还没交给窗口」的读数补进窗口（只在退出排空时调用）。
 * 不做任何新采样：退出路径不允许再读 getAppMetrics 或起探针。
 */
// 退出排空只搬运来源已收到但未入窗的读数，不再触发新采样或 getAppMetrics 调用。
// [资源] heap 回调是空实现：只有 heap 的来源不足以独立成窗，退出时同样不补。
function flushPendingSourceReadings(logger?: ResourceLogger): void {
  flushPendingProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES, {
    now: Date.now(),
    addRoleSample: (sample) => processResourceWindows.add(sample),
    // heap 不足以独立开窗，退出时也不例外；只贡献 heap 的来源没有 flushPending。
    addRoleHeapSample: () => {},
    addAppProcessTotals: () => {},
    onError: (sourceId, error) =>
      logger?.warn(`[resource] sample source ${sourceId} flush failed:`, error),
  });
}

/** 排空全部资源窗口；窗口时钟只有这一处，退出排空复用同一个顺序。 */
// 窗口排空的唯一顺序：先补未交读数，再取 backgroundRatio，然后依次上报角色窗口与系统窗口。
// [并发] backgroundRatio 必须在 drain 前取值，drain 会同批清零角色聚合器的 scene 计数。
// [失败路径] 正常退出与定时 flush 复用同一顺序，差别只在是否传入 logger。
function drainAllResourceWindows(logger?: ResourceLogger): void {
  flushPendingSourceReadings(logger);
  // background_ratio 的唯一数据源是角色聚合器的 scene 计数，先取值再 drain（drain 会清零）。
  const backgroundRatio = processResourceWindows.backgroundRatio;
  reportProcessResourceWindows();
  reportSystemResourceWindow(backgroundRatio);
}

function flushResourceReports(logger: ResourceLogger): void {
  drainAllResourceWindows(logger);
  logger.info("[resource] perf_process_window + perf_system_window flushed");
}

// 配置入口先清空去重集合与两个窗口，再写入上下文和设备硬件快照，换 mid 后不残留旧样本。
// 同时把 device_mid、platform、app_version、arms_env 写入 ARMS 全局属性，后续事件复用。
export function configureDesktopResourceTelemetry(context: ResourceGlobalContext): void {
  recentToolExecCompletions.clear();
  processResourceWindows.clear();
  processResourceSystemWindow.clear();
  globalContext = context;
  desktopHardware = resolveDesktopHardware(context.platform);

  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

// 注册前先 stop 旧实例并重置探针审计、memoryLogTick、写入闸门与来源队列，避免重复定时器。
// 两个 setInterval 回调都包在 measureTelemetrySelfMs 与 try/catch 内，单次失败不影响下一次 tick。
export function registerDesktopResourceTelemetry(
  logger: ResourceLogger,
  /**
   * `reportIntervalMs` 只供单测注入窗口时钟；生产走 RESOURCE_REPORT_INTERVAL_MS。
   * `readSelfClockMs` 只供单测注入可预期的自证开销时钟；生产走 performance.now。
   */
  options?: { reportIntervalMs?: number; readSelfClockMs?: () => number },
): void {
  stopDesktopResourceTelemetry();
  agentMetricProbeDisabledAuditLogged = false;
  memoryLogTick = 0;
  memorySampleWriteGate = createMemorySampleWriteGate();
  resetProcessResourceSampleSources(PROCESS_RESOURCE_SAMPLE_SOURCES);
  processResourceSystemWindow.clear();
  readTelemetrySelfClockMs = options?.readSelfClockMs ?? (() => performance.now());

  const reportIntervalMs = options?.reportIntervalMs ?? RESOURCE_REPORT_INTERVAL_MS;

  sampleTimer = setInterval(() => {
    measureTelemetrySelfMs(() => {
      try {
        takeSample(logger);
      } catch (error) {
        logger.warn("[resource] sample failed:", error);
      }
    });
  }, RESOURCE_SAMPLE_INTERVAL_MS);

  reportTimer = setInterval(() => {
    measureTelemetrySelfMs(() => {
      try {
        flushResourceReports(logger);
      } catch (error) {
        logger.warn("[resource] report failed:", error);
      }
    });
  }, reportIntervalMs);

  // 遥测定时器不得延长进程寿命。
  // [资源] 两个定时器都必须 unref，遥测不得延长进程寿命，退出由主流程显式 stop。
  // unref 用可选调用兼容测试替身，替身没有该方法时不影响注册流程。
  sampleTimer.unref?.();
  reportTimer.unref?.();

  logger.info(
    `[resource] sampling started interval=${RESOURCE_SAMPLE_INTERVAL_MS}ms report=${reportIntervalMs}ms`,
  );
}

// 停止入口幂等：先清去重集合，再逐个 clearInterval 并置空引用，重复调用不会抛错。
export function stopDesktopResourceTelemetry(options?: {
  /** 正常退出：排空残窗，sample_count 如实反映；不触发新采样。 */
  flushPendingWindows?: boolean;
}): void {
  recentToolExecCompletions.clear();
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
  // [失败路径] flushPendingWindows 为真表示正常退出，排空内存窗口让 sample_count 如实反映。
  // [权衡] 其余情况必须直接清窗：崩溃或强制结束不做排空，避免在不确定状态下新增上报。
  if (options?.flushPendingWindows) {
    // Bug 根因：改成 5 分钟聚合后，正常退出仍沿用直接 clear 的旧 stop，
    // 导致已收到但未满窗口的样本静默丢失。这里只排空内存窗口，不触发新采样或磁盘扫描。
    drainAllResourceWindows();
  } else {
    processResourceWindows.clear();
    processResourceSystemWindow.clear();
  }
}
