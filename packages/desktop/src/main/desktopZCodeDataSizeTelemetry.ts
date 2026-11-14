// ZCode 数据体积遥测调度：按「每日一次 + 空闲窗口」节奏驱动数据目录体积扫描，
// 并把结果包装成 ARMS 自定义事件上报；同时守住跨重启的 24 小时上报配额。
// 不负责：目录遍历与统计（Worker 侧）、状态文件序列化与损坏恢复、ARMS 传输重试、UI 开关。
//
// 不变量（INV）：
// INV-01 断言：同一时刻最多只有一个采集在途 —— 守住它的位置：evaluateDueCollection 入口对 activeAbortController 的判空 —— 改错故障：重复扫描抢 IO，并在一日内重复上报消耗样本配额
// INV-02 断言：限流锚点取 lastReportedAt 与 reportReservedAt 的较大值 —— 守住它的位置：initializeFromPersistedState 的 rateLimitAnchor —— 改错故障：上报失败后重启会立刻重发，突破 24 小时限制
// INV-03 断言：任何上报动作之前必须先把预占时间落盘 —— 守住它的位置：collectAndReport 调用 reserveReport —— 改错故障：发送成功但落盘失败时，重启后会再次发送同一天样本
// INV-04 断言：预占之后的任一步失败都要把状态回滚到预占前 —— 守住它的位置：rollbackReportReservation 的三处调用 —— 改错故障：一次失败消耗掉整天的配额，用户当天再也看不到数据
// INV-05 断言：上报成功后只写 lastReportedAt，隐式清掉 reportReservedAt —— 守住它的位置：persistSuccess 构造的 nextState —— 改错故障：残留预占时间会把下一次到期日整体推后一天
// INV-06 断言：抖动只由设备号与日桶决定，不依赖随机数 —— 守住它的位置：stableJitterMs 的 FNV-1a 哈希 —— 改错故障：每次重启错峰时间跳变，服务端在同一分钟收到大量上报
// INV-07 断言：到期判定用的 dueAt 必须包含抖动 —— 守住它的位置：initializeFromPersistedState 的 dueAt 计算 —— 改错故障：在抖动窗口内重启会退化为启动抖动，跨重启错峰失效
// INV-08 断言：抖动取值为零到上限的闭区间 —— 守住它的位置：stableJitterMs 的取模分支 —— 改错故障：出现负数延迟或超出上限，扫描落在业务高峰
// INV-09 断言：扫描开始前后都要检查空闲与忙碌 —— 守住它的位置：collectAndReport 的扫描后复查 —— 改错故障：长扫描期间用户已恢复操作，仍被上报，后台任务与交互争抢磁盘
// INV-10 断言：空闲判定要求系统空闲时长与退到后台同时成立 —— 守住它的位置：isPreferredIdleWindow —— 改错故障：用户只是离开键盘但仍在看界面，扫描打断前台操作
// INV-11 断言：任何空闲或忙碌探测抛错都按「不可采集」处理 —— 守住它的位置：isPreferredIdleWindow 与 collectionEligibilityLost 的 catch —— 改错故障：探测失败被当成空闲，采集在任意时刻启动
// INV-12 断言：等待空闲超过兜底时长后允许放宽窗口，但绝不能放宽忙碌检查 —— 守住它的位置：evaluateDueCollection 的 relaxedIdle —— 改错故障：常驻前台的设备永远不采集，指标长期缺样本
// INV-13 断言：读取状态失败时只重试读取，不进入采集 —— 守住它的位置：initializeFromPersistedState 的 catch 分支 —— 改错故障：状态文件损坏被当成首次安装，每次都重新上报
// INV-14 断言：中止重试与失败重试使用不同延迟 —— 守住它的位置：collectAndReport 的 catch 与 schedule 参数 —— 改错故障：用户频繁活动导致中止，却按 6 小时冷却，当日样本缺失
// INV-15 断言：停止之后所有 await 落点都必须复检停止标记 —— 守住它的位置：collectAndReport 与各持久化动作之间的 stopped 判断 —— 改错故障：退出中的进程仍写入状态文件，或对已销毁的对象发起上报
// INV-16 断言：所有定时器都不阻止主进程退出 —— 守住它的位置：unrefTimer —— 改错故障：Electron 退出被挂起，用户看到进程常驻
// INV-17 断言：上报属性全部为字符串且未定义字段被丢弃 —— 守住它的位置：stringifyProperties —— 改错故障：ARMS 侧属性类型漂移，看板聚合出现空值列
// INV-18 断言：事件名、指标名与 schema 版本是稳定契约 —— 守住它的位置：buildZCodeDataSizeArmsPayload —— 改错故障：改名会导致历史数据断档，看板出现断层
//
// 调度状态机（单向推进，无回退边）：
// 调度入口 → 读状态 → 限流未到期就排到 dueAt；已到期则排 startupMinDelay 加启动抖动
// 调度链：到点 → evaluateDueCollection 的空闲与忙碌检查 → scan → 复查 → reserveReport → report → persistSuccess → schedule 下一次
// 失败 → 中止按 30 分钟重试，其他错误按 6 小时重试；预占中途中止或失败则回滚预占
// 只有成功落盘后才清空 idleWaitingSince，保证兜底窗口按成功采集重新计时
// 时间单位：除 getSystemIdleTimeSeconds 返回秒外，timing 常量与状态字段全部为毫秒
import armsRum from "@arms/rum-electron";
import type { ArmsRumEnv, FinalArmsCustomEventPayload } from "@zcode/shared";

import type { ZCodeDataSizeScanResult } from "./zcodeDataSizeScanner.js";
import {
  readZCodeDataSizeTelemetryState,
  writeZCodeDataSizeTelemetryState,
  type ZCodeDataSizeTelemetryState,
} from "./zcodeDataSizeTelemetryState.js";
import { scanZCodeDataDirectoryInWorker } from "./zcodeDataSizeWorkerClient.js";

export type { ZCodeDataSizeTelemetryState } from "./zcodeDataSizeTelemetryState.js";

// [契约] 这些常量是生产默认值，调度器内部会与逐项覆盖合并；测试只覆写 timing 字段，不要直接改这里的数值。
// 扫描上限 30 秒与 20 万文件是两个独立闸门：超时先触发，超大目录以 partial 状态上报而不是无限期挂起。
// dailyIntervalMs、idlePollMs 与 startupMinDelayMs 的关系决定首次采集最早也会排到 2 分钟之后，不要为了早点看到数据把它调小。
// 新增常量时必须同时补进 ZCodeDataSizeTelemetryTiming 与 DEFAULT_TIMING，否则覆盖字段会静默失效。
export const ZCODE_DATA_SIZE_SCAN_MAX_DURATION_MS = 30_000;
export const ZCODE_DATA_SIZE_SCAN_MAX_FILES = 200_000;
export const ZCODE_DATA_SIZE_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const ZCODE_DATA_SIZE_IDLE_POLL_MS = 5 * 60 * 1000;
export const ZCODE_DATA_SIZE_IDLE_WAIT_FALLBACK_MS = 6 * 60 * 60 * 1000;
export const ZCODE_DATA_SIZE_MINIMUM_IDLE_SECONDS = 5 * 60;
export const ZCODE_DATA_SIZE_STARTUP_MIN_DELAY_MS = 2 * 60 * 1000;
export const ZCODE_DATA_SIZE_STARTUP_JITTER_MAX_MS = 8 * 60 * 1000;
export const ZCODE_DATA_SIZE_DAILY_JITTER_MAX_MS = 60 * 60 * 1000;
export const ZCODE_DATA_SIZE_ABORTED_RETRY_MS = 30 * 60 * 1000;
export const ZCODE_DATA_SIZE_FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;
export const ZCODE_DATA_SIZE_ACTIVITY_POLL_MS = 1_000;

interface ZCodeDataSizeTelemetryTiming {
  abortedRetryMs: number;
  activityPollMs: number;
  dailyIntervalMs: number;
  dailyJitterMaxMs: number;
  failureRetryMs: number;
  idlePollMs: number;
  idleWaitFallbackMs: number;
  minimumIdleSeconds: number;
  startupJitterMaxMs: number;
  startupMinDelayMs: number;
}

// [契约] DEFAULT_TIMING 是唯一一份默认值快照，外部只传 Partial，缺省项由这个完整对象补齐。
// 字段顺序与接口声明保持一致，便于对照排查哪个延迟被覆盖成了零。
// 不要在运行期改写这个对象；调度器只做浅拷贝，改写会让所有实例共享被污染的值。
// 值为零的合法覆盖同样生效，所以判断缺省必须用 undefined 而不是真假值。
const DEFAULT_TIMING: ZCodeDataSizeTelemetryTiming = {
  abortedRetryMs: ZCODE_DATA_SIZE_ABORTED_RETRY_MS,
  activityPollMs: ZCODE_DATA_SIZE_ACTIVITY_POLL_MS,
  dailyIntervalMs: ZCODE_DATA_SIZE_DAILY_INTERVAL_MS,
  dailyJitterMaxMs: ZCODE_DATA_SIZE_DAILY_JITTER_MAX_MS,
  failureRetryMs: ZCODE_DATA_SIZE_FAILURE_RETRY_MS,
  idlePollMs: ZCODE_DATA_SIZE_IDLE_POLL_MS,
  idleWaitFallbackMs: ZCODE_DATA_SIZE_IDLE_WAIT_FALLBACK_MS,
  minimumIdleSeconds: ZCODE_DATA_SIZE_MINIMUM_IDLE_SECONDS,
  startupJitterMaxMs: ZCODE_DATA_SIZE_STARTUP_JITTER_MAX_MS,
  startupMinDelayMs: ZCODE_DATA_SIZE_STARTUP_MIN_DELAY_MS,
};

interface ZCodeDataSizeTelemetryLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface ZCodeDataSizeTelemetrySchedulerDependencies {
  deviceMid: string;
  getSystemIdleTimeSeconds: () => number;
  isAppBackground: () => boolean;
  isZCodeBusy: () => boolean;
  logger: ZCodeDataSizeTelemetryLogger;
  readState: () => Promise<ZCodeDataSizeTelemetryState | null>;
  report: (result: ZCodeDataSizeScanResult) => Promise<void> | void;
  scan: (options: { signal: AbortSignal }) => Promise<ZCodeDataSizeScanResult>;
  timing?: Partial<ZCodeDataSizeTelemetryTiming>;
  writeState: (state: ZCodeDataSizeTelemetryState) => Promise<void>;
}

// [契约] normalizeOsCategory 只区分 macos、windows、linux 三类，其他平台一律由 default 分支归入 linux。
// 看板按该字段做横向对比，新增系统若不在这里显式列出，会静默混进 linux 列。
// 返回的是小写分类名而非 Node 平台名，不要改成直接透传 process.platform。
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

function stringifyProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

// [契约] buildZCodeDataSizeArmsPayload 的事件名、分组、指标名与 schema 版本是外部看板的查询依据，改名会导致数据断档。
// bytes 同时出现在 value、metric_value 与 zcode_data_bytes 三处，是刻意冗余：有的消费方会读顶层 value，有的读属性。
// partial_reason 未定义时会被 stringifyProperties 丢弃，而不是写成空字符串，看板据此区分完整与未知。
// scan_status 与 scan_error_count 组合表达扫描是否被截断，不要用 bytes 为零反推失败。
// 新增字段走 properties，不改 value 的语义；value 始终等于本次统计到的字节数。
export function buildZCodeDataSizeArmsPayload(params: {
  context: {
    appVersion: string;
    armsEnv: ArmsRumEnv;
    dataRootKind: "custom" | "default";
    deviceMid: string;
    platform: NodeJS.Platform;
  };
  result: ZCodeDataSizeScanResult;
}): FinalArmsCustomEventPayload {
  const eventName = "perf_resource_zcode_data_size";
  return {
    group: "resource",
    name: eventName,
    properties: stringifyProperties({
      app_version: params.context.appVersion,
      arms_env: params.context.armsEnv,
      data_root_kind: params.context.dataRootKind,
      device_mid: params.context.deviceMid,
      directories_scanned: params.result.directoriesScanned,
      event_name: eventName,
      files_scanned: params.result.filesScanned,
      metric_kind: "zcode_data_bytes",
      metric_value: params.result.bytes,
      partial_reason: params.result.partialReason,
      platform: normalizeOsCategory(params.context.platform),
      scan_duration_ms: params.result.durationMs,
      scan_error_count: params.result.scanErrorCount,
      scan_status: params.result.status,
      schema_version: 1,
      zcode_data_bytes: params.result.bytes,
    }),
    type: "custom",
    value: params.result.bytes,
  };
}

// [契约] 用 FNV-1a 对设备号加日桶做确定性哈希，同一设备在同一天内无论重启多少次都得到相同的错峰偏移。
// [权衡] 刻意不用随机数：重启即重算会让错峰失效，服务端会在同一分钟收到大量首启设备的上报。
// 日桶由传入时间按 24 小时向下取整得到，跨天后偏移自然变化，无需额外轮换。
// 取模用上限向下取整加一，保证返回值落在零到上限的闭区间，并且不会产生负数。
// 上限为零或负数时直接返回零，调用方不必再判空。
function stableJitterMs(deviceMid: string, bucketAt: number, maxMs: number): number {
  if (maxMs <= 0) {
    return 0;
  }
  const key = `${deviceMid}:${Math.floor(bucketAt / ZCODE_DATA_SIZE_DAILY_INTERVAL_MS)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % (Math.floor(maxMs) + 1);
}

// 只认 name 为 AbortError 的错误，用于识别 Worker 侧透传的中止原因。
// [失败路径] 不要把 DOMException 的类型判断当成唯一依据：本文件真正依赖的是 signal.aborted，name 判断只是补充。
// 放宽成消息里包含 abort 会把真实扫描错误误判为中止，从而按 30 分钟而不是 6 小时重试。
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// [资源] 所有定时器都 unref，避免调度器让 Electron 主进程无法正常退出。
// unrefTimer 在浏览器或测试桩里可能收到数字句柄，所以先判断是否为对象再调用可选方法。
function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === "object") {
    timer.unref?.();
  }
}

export function createZCodeDataSizeTelemetryScheduler(
  dependencies: ZCodeDataSizeTelemetrySchedulerDependencies,
): { start: () => Promise<void>; stop: () => void } {
  const timing = { ...DEFAULT_TIMING, ...dependencies.timing };
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let activityTimer: ReturnType<typeof setInterval> | null = null;
  let activeAbortController: AbortController | null = null;
  let idleWaitingSince: number | null = null;
  let persistedState: ZCodeDataSizeTelemetryState | null = null;
  let stopped = true;

  function clearScheduledTimer(): void {
    if (scheduledTimer) {
      clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
  }

  function clearActivityTimer(): void {
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
  }

  // [并发] schedule 全局只有一个 scheduledTimer 槽位，先清旧的再设新的，防止同一时刻存在两条待执行的调度链。
  // 停止标记在入口处短路，停止之后任何迟到的回调都不能再排下一次，否则进程退出后仍会有定时器复活。
  // 回调默认是到期评估，初始化阶段重试读取状态时显式传入自己的函数，两者的区别只在这一处。
  // 延迟统一取零以上，抖动计算出负数也只会立即执行而不会抛错。
  // 设置后立刻 unref，避免漏掉某一分支导致主进程被挂住。
  function schedule(delayMs: number, callback = evaluateDueCollection): void {
    if (stopped) {
      return;
    }
    clearScheduledTimer();
    scheduledTimer = setTimeout(
      () => {
        scheduledTimer = null;
        void callback();
      },
      Math.max(0, delayMs),
    );
    unrefTimer(scheduledTimer);
  }

  // [权衡] 空闲时长与前后台状态必须同时满足：只看空闲会把人在屏幕前但没动键盘误判为可采集。
  // getSystemIdleTimeSeconds 返回值单位是秒，与毫秒制的 minimumIdleSeconds 不同，比较前必须换算，不要做额外加工。
  function isPreferredIdleWindow(): boolean {
    try {
      return (
        dependencies.getSystemIdleTimeSeconds() >= timing.minimumIdleSeconds &&
        dependencies.isAppBackground()
      );
    } catch {
      return false;
    }
  }

  // [失败路径] 探测抛错时返回 true，即按已失去资格处理，宁可少采一次也不在未知状态下启动扫描。
  // 忙碌判定优先于空闲窗口，放宽空闲窗口只绕过窗口条件，不会绕过忙碌检查。
  // 扫描期间定时调用它来决定是否中止 Worker，因此这里必须保持无副作用、可高频调用。
  function collectionEligibilityLost(relaxedIdle: boolean): boolean {
    try {
      return dependencies.isZCodeBusy() || (!relaxedIdle && !isPreferredIdleWindow());
    } catch {
      return true;
    }
  }

  // [事务] 成功状态只写 lastReportedAt，等于把预占时间从状态里抹掉；这是限流锚点回落的关键一步。
  // 落盘失败只记录告警、不回滚也不重发：样本已经发出，再补一次会重复计数。
  // persistedState 内存副本同步更新，后续同进程内的判定立刻以新时间为锚点。
  async function persistSuccess(reportedAt: number): Promise<void> {
    try {
      const nextState = { lastReportedAt: reportedAt };
      await dependencies.writeState(nextState);
      persistedState = nextState;
    } catch (error) {
      dependencies.logger.warn("[zcode-data-size] failed to persist report state", error);
    }
  }

  // [事务] 先把预占时间落盘再发送，是整套限流的核心顺序；写盘失败直接抛出，让本次采集按失败路径处理而不发送。
  // 返回的是预占前的状态，供回滚时原样恢复；不要在这里顺手把 lastReportedAt 一起改掉。
  // 预占保留已有字段，只追加 reportReservedAt，避免把读取到的历史时间覆盖丢失。
  async function reserveReport(reservedAt: number): Promise<ZCodeDataSizeTelemetryState | null> {
    const previousState = persistedState;
    const reservation = { ...previousState, reportReservedAt: reservedAt };
    // Bug 根因：旧实现先发送再落盘，落盘失败后重启会再次发送，绕过 24 小时限流。
    // 发送前先原子写入 reservation；即使进程随后退出，也只会少一个样本，不会重复上报。
    await dependencies.writeState(reservation);
    persistedState = reservation;
    return previousState;
  }

  // [事务] 回滚写的是预占前的完整状态；本来没有状态时写入空对象，而不是删除文件。
  // 回滚本身失败只告警：此时上报没有成功，继续抛错会让外层误判重试类型，掩盖真正原因。
  // 内存状态回到预占前的值，即使写盘失败也保持与预占前一致的语义。
  async function rollbackReportReservation(
    previousState: ZCodeDataSizeTelemetryState | null,
  ): Promise<void> {
    try {
      const restoredState = previousState ?? {};
      await dependencies.writeState(restoredState);
      persistedState = previousState;
    } catch (error) {
      dependencies.logger.warn("[zcode-data-size] failed to roll back report reservation", error);
    }
  }

  // [并发] 每次采集新建独立的 AbortController，活动轮询与停止操作都针对本次实例，finally 里只会清理属于自己的那个。
  // 顺序契约：扫描、复查资格、预占、上报、写成功时间、排下一次，任何一步改序都会破坏限流或造成重复上报。
  // 进度轮询会主动中止 Worker，中止后抛出 AbortError 走短重试，让用户恢复操作后尽快让路。
  // 预占之后到上报之前还有两次资格复查，任一次失败都先回滚预占再按中止处理。
  // 只有上报成功才清空空闲等待起点，失败或中止都会保留它，保证兜底窗口不被反复重置。
  async function collectAndReport(relaxedIdle: boolean): Promise<void> {
    const abortController = new AbortController();
    activeAbortController = abortController;
    activityTimer = setInterval(
      () => {
        if (collectionEligibilityLost(relaxedIdle)) {
          // 修复原因：开始扫描后用户可能恢复操作或新任务开始；仅在启动前检查会让 30 秒扫描
          // 继续和用户工作争抢 IO，因此直接终止 Worker 并延后重试。
          abortController.abort();
        }
      },
      Math.max(1, timing.activityPollMs),
    );
    unrefTimer(activityTimer);

    try {
      const result = await dependencies.scan({ signal: abortController.signal });
      if (stopped) {
        return;
      }
      if (abortController.signal.aborted || collectionEligibilityLost(relaxedIdle)) {
        // Bug 根因：Worker 可能在下一次 activity poll 前结束；若任务恰在这个窗口启动，
        // 旧实现会跳过 busy 检查直接上报。发送前同步复查，关闭该 TOCTOU 窗口。
        abortController.abort();
        throw new DOMException("ZCode data size scan eligibility lost", "AbortError");
      }
      const reportReservedAt = Date.now();
      const previousState = await reserveReport(reportReservedAt);
      if (stopped) {
        await rollbackReportReservation(previousState);
        return;
      }
      if (abortController.signal.aborted || collectionEligibilityLost(relaxedIdle)) {
        await rollbackReportReservation(previousState);
        abortController.abort();
        throw new DOMException("ZCode data size report eligibility lost", "AbortError");
      }
      try {
        await dependencies.report(result);
      } catch (error) {
        await rollbackReportReservation(previousState);
        throw error;
      }
      const reportedAt = Date.now();
      await persistSuccess(reportedAt);
      idleWaitingSince = null;
      dependencies.logger.info(
        `[zcode-data-size] reported status=${result.status} bytes=${result.bytes}`,
      );
      schedule(
        timing.dailyIntervalMs +
          stableJitterMs(
            dependencies.deviceMid,
            reportedAt + timing.dailyIntervalMs,
            timing.dailyJitterMaxMs,
          ),
      );
    } catch (error) {
      if (stopped) {
        return;
      }
      const aborted = abortController.signal.aborted || isAbortError(error);
      dependencies.logger.warn(
        `[zcode-data-size] ${aborted ? "scan aborted" : "scan/report failed"}`,
        error,
      );
      schedule(aborted ? timing.abortedRetryMs : timing.failureRetryMs);
    } finally {
      clearActivityTimer();
      // [资源] 活动轮询必须在 finally 里清掉，任何提前返回或抛出都不能留下一个按秒触发的定时器。
      // activeAbortController 可能已被新的采集或停止操作改写，因此只有仍指向本次实例时才置空，避免误伤后来者。
      // 清理顺序是先前停轮询再解除引用，防止轮询回调拿着已释放的信号继续中止。
      if (activeAbortController === abortController) {
        activeAbortController = null;
      }
    }
  }

  // [并发] 这是调度链唯一入口，在途采集与停止状态下直接返回，防止两条定时器同时进入采集。
  // idleWaitingSince 由每次评估惰性初始化，之后一直保留，直到一次成功上报才清空。
  // 忙碌时按 idlePollMs 复查，不重新计算起点，因此兜底计时是连续累计而不是每次重置。
  // 忙碌检查放在 evaluateDueCollection 而不是 collectAndReport 里，是为了让刚开机但系统仍在初始化的阶段不触发磁盘遍历。
  async function evaluateDueCollection(): Promise<void> {
    if (stopped || activeAbortController) {
      return;
    }
    const now = Date.now();
    // idleWaitingSince 只在第一次评估时写入，后续评估复用；用空值合并而不是覆盖，是为了保留跨轮询的累计时长。
    // 它不等同于调度开始时间：经过限流等待后才开始计时的设备，兜底窗口会相应顺延。
    idleWaitingSince ??= now;
    // [权衡] 超过兜底时长后则放宽空闲窗口（relaxedIdle），是为了照顾长期在前台、系统从不进入空闲的机器。
    // 放宽只影响窗口条件，忙碌检查仍在两处生效，所以用户正在用时依旧不会扫描。
    // 该值在整次采集中贯穿传递，扫描后的复查必须用同一个值，否则前后判定口径不一致。
    const relaxedIdle = now - idleWaitingSince >= timing.idleWaitFallbackMs;
    // [缺陷 D-13-1] 这里的 isZCodeBusy() 在 try 之外：它抛错会让 evaluateDueCollection 的 Promise 变成未处理拒绝，且不会排下一次调度，采集停摆到重启；INV-11 只覆盖了 isPreferredIdleWindow 与 collectionEligibilityLost 的 catch。
    if (dependencies.isZCodeBusy()) {
      schedule(timing.idlePollMs);
      return;
    }
    if (!relaxedIdle && !isPreferredIdleWindow()) {
      schedule(timing.idlePollMs);
      return;
    }
    await collectAndReport(relaxedIdle);
  }

  // [失败路径] 只在启动和读取失败重试时进入；成功路径末尾一定排下一次调度，重复调用会出现两条调度链。
  // 限流锚点取上报时间与预占时间的较大值，确保已发送未落成功的那一天也算已消耗。
  // 判断是否到期时把抖动算进 dueAt，保证重启前后用的是同一条时间线。
  // 读取结果先落内存，后续预占与回滚都以它为基线。
  async function initializeFromPersistedState(): Promise<void> {
    let state: ZCodeDataSizeTelemetryState | null;
    try {
      state = await dependencies.readState();
    } catch (error) {
      // Bug 根因：状态读取失败不等于没有历史状态；按首次启动继续采集会绕过持久化限流。
      // 无法确认配额时保持 fail-closed，并且只重试状态读取，不进入采集调度。
      dependencies.logger.warn("[zcode-data-size] failed to read report state", error);
      schedule(timing.failureRetryMs, initializeFromPersistedState);
      return;
    }
    if (stopped) {
      return;
    }
    persistedState = state;

    const now = Date.now();
    // [契约] 两个锚点分别代表已成功上报和已预留上报，取较大值才能覆盖上报后落盘失败的窗口。
    // 缺少任意一项都会漏算：只看上报时间会让失败重发，只看预占时间会让成功后的下次到期被提前。
    // 负无穷表示两个字段都不存在，是首次启动的显式信号，不要改成零，否则会被当成 1970 年已上报。
    // rateLimitAnchor 只参与到期计算，不写回状态字段。
    const rateLimitAnchor = Math.max(
      state?.lastReportedAt ?? Number.NEGATIVE_INFINITY,
      state?.reportReservedAt ?? Number.NEGATIVE_INFINITY,
    );
    if (Number.isFinite(rateLimitAnchor)) {
      const baseDueAt = rateLimitAnchor + timing.dailyIntervalMs;
      // Bug 根因：旧实现先用未加 jitter 的 baseDueAt 判断是否到期；应用在 jitter
      // 窗口内重启时会改走 startup jitter，破坏跨重启的稳定错峰。
      const dueAt =
        baseDueAt + stableJitterMs(dependencies.deviceMid, baseDueAt, timing.dailyJitterMaxMs);
      if (dueAt > now) {
        schedule(dueAt - now);
        return;
      }
    }
    schedule(
      timing.startupMinDelayMs +
        stableJitterMs(dependencies.deviceMid, now, timing.startupJitterMaxMs),
    );
  }

  return {
    // 启动是幂等的：已运行状态下再次调用直接返回，避免重复初始化产生第二条调度链。
    // start() 先把 stopped 置为可运行再读状态，这样读取期间调用 stop() 也能被感知。
    async start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      await initializeFromPersistedState();
    },

    // [资源] 停止要同时清调度定时器、清活动轮询并中止在途扫描，漏掉任意一项都会留下后台活动。
    // 中止后由采集流程内部的停止复检负责回滚预占，这里不直接改状态文件。
    // 停止不重置空闲等待起点；同一调度器再次启动会沿用，新建调度器则从零开始。
    stop() {
      stopped = true;
      clearScheduledTimer();
      clearActivityTimer();
      activeAbortController?.abort();
      activeAbortController = null;
    },
  };
}

// [资源] 模块级单例持有当前调度器；注册新调度前必须先停掉旧的，否则两个调度器会并行扫描与上报。
// desktopScheduler 注销时置空引用，避免已停止的实例被后续注册误用。
let desktopScheduler: ReturnType<typeof createZCodeDataSizeTelemetryScheduler> | null = null;

// [契约] 这是与宿主进程的唯一接线点：状态读写、扫描、上报三个依赖都在这里注入，业务判定留在调度器内部。
// 扫描绑定固定的时长与文件数上限，宿主无法从外部放宽，防止一次扫描拖垮目录。
// 上报适配器把构造好的载荷交给 ARMS 发送；调度器只关心发送是否抛错，不感知传输细节。
// 状态文件路径由调用方给出，同一个路径必须同时用于读取与写入，否则限流会读不到自己写的数据。
export function registerDesktopZCodeDataSizeTelemetry(options: {
  context: Parameters<typeof buildZCodeDataSizeArmsPayload>[0]["context"];
  getSystemIdleTimeSeconds: () => number;
  isAppBackground: () => boolean;
  isZCodeBusy: () => boolean;
  logger: ZCodeDataSizeTelemetryLogger;
  rootPath: string;
  stateFile: string;
}): void {
  // [缺陷 D-13-2] stop() 不等待在途采集：旧实例的 rollbackReportReservation 可能在新实例已写入预占之后执行，把预占覆盖掉，限流锚点回退。
  stopDesktopZCodeDataSizeTelemetry();
  desktopScheduler = createZCodeDataSizeTelemetryScheduler({
    deviceMid: options.context.deviceMid,
    getSystemIdleTimeSeconds: options.getSystemIdleTimeSeconds,
    isAppBackground: options.isAppBackground,
    isZCodeBusy: options.isZCodeBusy,
    logger: options.logger,
    readState: () => readZCodeDataSizeTelemetryState(options.stateFile),
    report: (result) => {
      const payload = buildZCodeDataSizeArmsPayload({ context: options.context, result });
      // 发送是同步入队、不等待传输结果，因此上报函数的 Promise 完成不能代表数据已到达服务端。
      // 正因如此，预占时间必须先落盘；否则传输层的静默失败会让重启后的进程再次发送。
      armsRum.sendCustom({
        group: payload.group,
        name: payload.name,
        properties: payload.properties,
        type: payload.type,
        value: payload.value,
      });
    },
    scan: ({ signal }) =>
      scanZCodeDataDirectoryInWorker(
        {
          maxDurationMs: ZCODE_DATA_SIZE_SCAN_MAX_DURATION_MS,
          maxFiles: ZCODE_DATA_SIZE_SCAN_MAX_FILES,
          rootPath: options.rootPath,
        },
        signal,
      ),
    writeState: (state) => writeZCodeDataSizeTelemetryState(options.stateFile, state),
  });
  void desktopScheduler.start().catch((error) => {
    options.logger.warn("[zcode-data-size] scheduler start failed", error);
  });
}

// 注销入口供窗口关闭或应用退出时调用，保证定时器与在途扫描都被释放。
// stopDesktopZCodeDataSizeTelemetry 重复调用是安全的：没有调度器时什么也不做，避免退出流程因为空引用报错。
export function stopDesktopZCodeDataSizeTelemetry(): void {
  desktopScheduler?.stop();
  desktopScheduler = null;
}
