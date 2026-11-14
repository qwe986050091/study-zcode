// 资源管理器窗口：main 侧的单例窗口、资源采样入口与进程角色归类。
// 采样必须一律按「面板发起、main 聚合、Host 回报」三段式，main 只做轻量归并与系统读数。
// 下面五条不变量必须同时成立：单例复用、采样生命周期、进程行去重、加载降级、平台差异。
// INV-01 资源管理器在 main 侧只保留一个实例引用，再次打开只聚焦不新建；守住位置：openResourceManager 首个提前返回分支；改错故障：连点菜单弹出两个面板，同一批进程被两套采样重复统计。
// INV-02 采样控制器必须与窗口同生共死，关闭、渲染进程崩溃、webContents 销毁三条路径都汇到同一个停止函数；守住位置：stopResourceUsageSampling 与其三个注册点；改错故障：窗口关闭后后台仍周期性采样，CPU 与 Host 通信空转。
// INV-03 采样只认发起方，任何与当前实例 webContents id 不符的调用都被静默丢弃；守住位置：setResourceUsageSamplingActive 与 getResourceUsageSnapshot 的守卫；改错故障：残留页面能启停采样，主面板数据被他处掐断。
// INV-04 未激活即报错，没有采样控制器时取快照直接抛错而不是返回空表；守住位置：getResourceUsageSnapshot 的四个条件合取；改错故障：面板显示全零进程行，用户误以为进程都空闲。
// INV-05 [并发] 快照聚合返回后必须再检查一次中止信号，然后才返回结果；守住位置：getResourceUsageSnapshot 尾部的中止兜底；改错故障：已关闭窗口的请求把旧数据写回，界面出现幽灵进程行。
// INV-06 [资源] 整机 CPU 依赖上一样本做差分，首次调用恒返回 0；守住位置：createSystemCpuMeter 中基线为空的分支；改错故障：刚打开面板整机 CPU 显示 0%，看起来像采集失败。
// INV-07 整机 CPU 在 total 未增长时返回 0，结果再截断到 0 至 100 并保留一位小数；守住位置：createSystemCpuMeter 的百分比计算尾段；改错故障：休眠唤醒后 CPU 出现负值或超过 100% 的跳动。
// INV-08 [事务] Host 进程登记必须与抓包配置成对发生，注册即在同一函数内完成挂接；守住位置：registerHostProcess 的两条语句；改错故障：新窗口的 Host 抓不到网络请求，网络面板长期空白。
// INV-09 [事务] 注销 Host 必须同时清进程表、Agent 表与采样缓存三处；守住位置：unregisterHostProcess 的三次删除；改错故障：窗口关闭后列表仍留着已死 Host 与 Agent 行。
// INV-10 Agent 行按 label 分组成表、组内以 pid 为键，组空必须删组；守住位置：unregisterHostAgentProcess 的空组分支；改错故障：长时间运行后残留空组，内存缓慢增长且注销变慢。
// INV-11 [失败路径] Host 尚未回报的 Agent 由注册表补一行占位，指标为零且标记为未采样；守住位置：collectUnsampledAgentProcesses；改错故障：刚启动的 Agent 在列表里消失数秒，用户误判进程没起来。
// INV-12 同一 PID 在 Electron 指标里只出一行，先写入者占位；守住位置：collectElectronProcesses 中 push 的 assigned 判重；改错故障：同一 renderer 出现两行，合计 CPU 直接翻倍。
// INV-13 [权衡] Host 回报行与 Electron 行 PID 冲突时以 Electron 指标为准并丢弃 Host 行；守住位置：buildResourceUsageSnapshot 的 electronPids 过滤；改错故障：PID 复用场景下同一进程两套数字，总占用虚高。
// INV-14 [平台] 打包版一律加载包内渲染文件，开发版才读环境变量指向的 dev server；守住位置：openResourceManager 的加载分支；改错故障：安装包打开白屏，或改前端后开发态不生效。
// INV-15 [失败路径] 窗口加载失败不阻塞主流程，也不重试，只留一条主进程日志；守住位置：openResourceManager 末尾的日志调用；改错故障：preload 路径写错时整个应用卡在启动阶段。
// INV-16 [平台] 标题与最小尺寸是固定常量，窗口不继承主窗口的自定义标题栏；守住位置：openResourceManager 的 BrowserWindow 选项；改错故障：不同平台标题为空，或窗口被拖到无法恢复的尺寸。
// INV-17 主窗口 webContents id 集合必须是 renderer_main 归类的唯一依据，注册与注销成对；守住位置：registerMainApplicationWindow 与 unregisterMainApplicationWindow；改错故障：主窗口被算进 chromium_other，renderer 占用统计丢失。
// INV-18 进程角色快照只统计未销毁且 OS 进程号为正的 webContents；守住位置：collectChromiumProcessRolePids 的两处 continue；改错故障：已销毁窗口被计入角色表，指标出现 pid 为 0 的行。
// INV-19 [并发] 快照并发向所有 Host 请求，采样层对单 Host 超时会回退上一轮结果，整体不会被拖住；守住位置：collectHostProcesses 的 Promise.all；改错故障：一台慢 Host 让整个面板空表，其余进程指标一起消失。
//
import { app, BrowserWindow, webContents as electronWebContents } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import os from "node:os";
import { join } from "node:path";
import {
  formatZCodeAgentProcessName,
  formatZCodeGpuProcessName,
  formatZCodeHostProcessName,
  formatZCodeMainProcessName,
  formatZCodeRendererProcessName,
  formatZCodeUtilityProcessName,
  type HostResourceUsageProcess,
  type ResourceUsageProcess,
  type ResourceUsageSnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { configureNetworkCaptureHost, observeNetworkWindow } from "./resourceManagerNetwork.js";
import { normalizeElectronCpuToMachinePercent } from "./electronCpuNormalization.js";
import type { ChromiumProcessRolePids } from "./processResourceRoleClassifier.js";
import { buildAuxiliaryRendererName } from "./resourceManagerProcessNames.js";
import {
  forgetHostResourceUsage,
  requestHostResourceUsage,
} from "./resourceManagerHostSampling.js";

/**
 * 资源管理器。
 *
 * main 只做三件事：Electron 自身进程指标（app.getAppMetrics）、系统总量（os）、
 * 合并 Host 回报的外部进程行。外部进程采样一律在 Host 内完成——
 * 历史 bug：main 里同步/异步起 ps、PowerShell 都会卡住整个 App。
 */

// [资源] preload 路径必须以当前模块目录为基准，开发与打包共用一份，不存在两套加载分支。
// [失败路径] 该路径写错时窗口仍能打开，但面板会空白，错误只出现在主进程控制台。
const preloadPath = join(import.meta.dirname, "../preload/resourceManager.cjs");
const RESOURCE_MANAGER_WINDOW_TITLE = "Resource Manager";
const BROWSER_USE_PLUGIN_NAME = "browser-use";

/** 系统整机 CPU：两次 os.cpus() 之间 busy / total 的差分 */
export interface SystemCpuMeter {
  read(): number;
}

export function createSystemCpuMeter(
  readCpus: () => Array<{ times: Record<string, number> }> = () => os.cpus(),
): SystemCpuMeter {
  let previous: { busy: number; total: number } | null = null;
  return {
    read() {
      let busy = 0;
      let total = 0;
      for (const cpu of readCpus()) {
        for (const [key, value] of Object.entries(cpu.times)) {
          total += value;
          if (key !== "idle") busy += value;
        }
      }
      const current = { busy, total };
      const baseline = previous;
      previous = current;
      if (!baseline || current.total <= baseline.total) return 0;
      const percent = ((current.busy - baseline.busy) / (current.total - baseline.total)) * 100;
      return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
    },
  };
}

// 单例：同一时刻只允许一个资源管理器窗口
// [不变量] 这个引用是本文件唯一的窗口句柄，只在未创建或已销毁时允许重建。
// [资源] main 在关闭回调里清空引用，防止后续判断继续摸着已销毁对象。
// [并发] 单线程事件循环保证判空到赋值之间不会插入第二次打开，无需额外加锁。
let instance: BrowserWindow | null = null;
let samplingController: AbortController | undefined;

// [事务] 停止顺序固定为：先中止控制器，再清空引用，最后逐个遗忘 Host 采样缓存。
// [不变量] 清引用让后续快照请求直接落到未激活分支，而不是读到已中止的信号。
// [资源] 遍历 Host 标签逐个忘缓存，避免窗口重开后先看到上一轮的旧进程行。
function stopResourceUsageSampling(): void {
  samplingController?.abort();
  samplingController = undefined;
  for (const label of hostProcesses.keys()) forgetHostResourceUsage(label);
}

/** 只有资源管理器本身能启停观测；Main 持有唯一生命周期。 */
// [不变量] 只接受当前实例 webContents 发来的启停请求，其余调用静默返回。
// [事务] 激活是幂等赋值，重复置真不会替换已有控制器，进行中的快照不被中断。
// [失败路径] 关闭时统一走停止函数，避免只置空引用却留下仍在跑的采样器。
export function setResourceUsageSamplingActive(senderId: number, active: boolean): void {
  if (!instance || instance.isDestroyed() || instance.webContents.id !== senderId) return;
  if (active) samplingController ??= new AbortController();
  else stopResourceUsageSampling();
}

// [失败路径] main 在四种情况下必须一律抛错：未激活、实例已销毁、发起方不匹配、控制器缺失。
// [并发] 先固化信号引用再等待聚合，避免中途被替换导致读到错配的采样会话。
// [事务] 聚合返回后补一次中止检查，已关闭窗口的请求不会把旧数据写回界面。
export async function getResourceUsageSnapshot(senderId: number): Promise<ResourceUsageSnapshot> {
  if (
    !instance ||
    instance.isDestroyed() ||
    instance.webContents.id !== senderId ||
    !samplingController
  ) {
    throw new Error("Resource sampling is inactive");
  }
  const signal = samplingController.signal;
  const result = await buildResourceUsageSnapshot({ signal });
  signal.throwIfAborted();
  return result;
}

export function getResourceManagerWindowId(): number | null {
  if (!instance || instance.isDestroyed()) {
    return null;
  }
  return instance.id;
}

/**
 * 记录活跃的 host process（utility process）。
 * 每个 BrowserWindow 只注册一个 window-scoped Host；远程连接不再产生独立 Host PID。
 * key = 窗口 label（如 "local-2"），value = UtilityProcess
 */
// [不变量] 键是窗口 label（如 local-2），值是该窗口唯一的 Host 子进程。
// [资源] main 的这张表同时喂给进程归类与网络观测，注销时两处都要跟着失效。
const hostProcesses = new Map<string, ElectronUtilityProcess>();

interface RegisteredAgentProcess {
  pid: number;
  provider: ZCodeProvider;
  workspacePath: string;
  command: string;
  args: string[];
  startedAt: number;
}

const hostAgentProcesses = new Map<string, Map<number, RegisteredAgentProcess>>();

export function listRegisteredHostAgentProcessIds(): number[] {
  return [...hostAgentProcesses.values()].flatMap((processes) => [...processes.keys()]);
}

/**
 * 主应用窗口（createWindow 创建的承载 workspace 的窗口）的 webContents id。
 * 唯一数据源：资源遥测据此把主窗口 renderer 归 `renderer_main`，
 * 资源管理器 / about / update-status 等辅助窗口归 `chromium_other`。
 */
const mainApplicationWindowWebContentsIds = new Set<number>();

export function registerMainApplicationWindow(webContentsId: number): void {
  if (webContentsId > 0) {
    mainApplicationWindowWebContentsIds.add(webContentsId);
  }
}

export function unregisterMainApplicationWindow(webContentsId: number): void {
  mainApplicationWindowWebContentsIds.delete(webContentsId);
}

/** renderer heap 样本按发送方 webContents 判断是否属于 `renderer_main`。 */
export function isMainApplicationWindowWebContents(webContentsId: number): boolean {
  return mainApplicationWindowWebContentsIds.has(webContentsId);
}

/** cron scheduler 的 utilityProcess，由 spawn 点登记。 */
const schedulerProcesses = new Set<ElectronUtilityProcess>();

export function registerSchedulerProcess(child: ElectronUtilityProcess): void {
  schedulerProcesses.add(child);
}

export function unregisterSchedulerProcess(child: ElectronUtilityProcess): void {
  schedulerProcesses.delete(child);
}

function collectUtilityProcessPids(children: Iterable<ElectronUtilityProcess>): Set<number> {
  const pids = new Set<number>();
  for (const child of children) {
    if (child.pid != null && child.pid > 0) {
      pids.add(child.pid);
    }
  }
  return pids;
}

/**
 * 当前各进程角色的 pid 快照，供资源遥测按 process_role 拆分使用
 *
 * getAppMetrics 不直接给 renderer / host / scheduler 的角色，需结合
 * BrowserWindow / webContents / utilityProcess 注册表才能可靠归类。
 */
// [不变量] 主进程 pid 直接取当前进程，不依赖 Electron 指标里可能缺失的字段。
// [权衡] 主窗口 renderer 与内置浏览器 guest 分开收集，辅助窗口一律不归类。
// [失败路径] 注册表过期时宁可漏归类，也不按标题或地址猜测窗口身份。
export function collectChromiumProcessRolePids(): ChromiumProcessRolePids {
  const mainWindowRendererPids = new Set<number>();
  const guestRendererPids = new Set<number>();

  // [失败路径] 先跳过销毁中的 webContents，再去取 OS 进程号，避免读取已释放句柄。
  // [不变量] 进程号小于等于零说明 renderer 尚未就绪，此时不进入任何角色集合。
  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) {
      continue;
    }
    const rendererPid = contents.getOSProcessId();
    if (rendererPid <= 0) {
      continue;
    }
    if (mainApplicationWindowWebContentsIds.has(contents.id)) {
      mainWindowRendererPids.add(rendererPid);
      continue;
    }
    // 内置浏览器 tab 是真实 `<webview>` guest；辅助窗口与 DevTools 落到 chromium_other。
    if (contents.getType() === "webview") {
      guestRendererPids.add(rendererPid);
    }
  }

  return {
    mainPid: process.pid,
    mainWindowRendererPids,
    guestRendererPids,
    hostPids: collectUtilityProcessPids(hostProcesses.values()),
    schedulerPids: collectUtilityProcessPids(schedulerProcesses),
  };
}

// [事务] 先登记进程表再下发抓包配置，保证之后按 label 查到的就是同一个子进程。
// [不变量] 抓包配置只在存在捕获会话时才真正发消息，空闲时注册只是纯登记。
export function registerHostProcess(label: string, child: ElectronUtilityProcess): void {
  hostProcesses.set(label, child);
  configureNetworkCaptureHost(child);
}

// [事务] 注销顺序必须为进程表、Agent 表、采样缓存，三处清完才算 Host 生命周期结束。
// [资源] 漏掉采样缓存会让重开的窗口先看到已退出 Host 的进程行。
// [并发] Agent 表按 label 整组删除而不逐个 pid 处理，避免退出抖动时反复增删。
export function unregisterHostProcess(label: string): void {
  hostProcesses.delete(label);
  hostAgentProcesses.delete(label);
  forgetHostResourceUsage(label);
}

export function registerHostAgentProcess(label: string, process: RegisteredAgentProcess): void {
  let processes = hostAgentProcesses.get(label);
  if (!processes) {
    processes = new Map();
    hostAgentProcesses.set(label, processes);
  }

  processes.set(process.pid, process);
}

export function unregisterHostAgentProcess(label: string, pid: number): void {
  const processes = hostAgentProcesses.get(label);
  if (!processes) {
    return;
  }

  processes.delete(pid);
  if (processes.size === 0) {
    hostAgentProcesses.delete(label);
  }
}

/** browser-use 的浏览器 guest 是 main 里的 WebContentsView，其 renderer 归内置插件 browser-use */
let browserUseGuestWebContentsIdsProvider: () => Iterable<number> = () => [];

export function setBrowserUseGuestWebContentsIdsProvider(provider: () => Iterable<number>): void {
  browserUseGuestWebContentsIdsProvider = provider;
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

/**
 * 打开资源管理器窗口（单例）。
 * 如果已有实例则聚焦，不重复创建。
 */
// [不变量] 已有存活实例时只聚焦并返回，不更新尺寸、不重载页面、不重建观测。
// [失败路径] 聚焦在最小化或隐藏状态下未必可见，此处不做还原，保持行为可预期。
// [事务] 创建窗口、挂网络观测、挂生命周期回调、打日志按此顺序完成。
export function openResourceManager(): void {
  // [不变量] 存活判断用销毁标记而非引用是否为空，销毁后引用可能尚未被清空。
  // [权衡] 命中即返回意味着用户调过的窗口尺寸会被保留，既不记忆也不重置。
  // [失败路径] 若引用指向已销毁窗口则继续往下重建，旧引用会被新窗口直接覆盖。
  if (instance && !instance.isDestroyed()) {
    instance.focus();
    return;
  }

  // [不变量] 宽高与最小尺寸必须是常量，标题固定，不随主窗口状态或主题变化。
  // [平台] 明确使用系统标题栏与深色背景，规避 macOS 与 Windows 的标题栏差异。
  // [资源] 必须只开放 preload 一个能力入口，上下文隔离开启、Node 集成关闭。
  instance = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 640,
    minHeight: 420,
    title: RESOURCE_MANAGER_WINDOW_TITLE,
    // 不继承主窗口的自定义标题栏，使用系统默认标题栏
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  observeNetworkWindow(instance, () => hostProcesses.values());
  // 与主窗口保持一致：生产包始终加载签名包内的渲染资源。
  // [平台] 开发态带 dev server 地址时走 URL 加载，其余情况一律加载包内 HTML。
  // [失败路径] 两条分支都不做重试，加载失败只留下空白窗口，由用户重新打开。
  // [权衡] main 的环境变量只在非打包态生效，防止安装包被外部变量指向任意地址。
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    instance.loadURL(`${base}/resource-manager.html`);
  } else {
    instance.loadFile(join(import.meta.dirname, "../renderer/resource-manager.html"));
  }

  // [事务] 关闭回调里先停采样再清实例引用，顺序颠倒会留下无主的采样控制器。
  // [不变量] 关闭是唯一允许把实例引用置空的路径，其它位置只读不写。
  // [资源] 网络观测在创建时自行注册了同一批生命周期事件，两边各自清理互不依赖。
  instance.on("closed", () => {
    stopResourceUsageSampling();
    instance = null;
  });
  // [失败路径] 渲染进程崩溃时不能重建窗口，只能停采样，用户看到的是崩溃后的空面板。
  // [并发] 与 webContents 销毁回调可能先后触发，停止函数必须可重复执行且无副作用。
  instance.webContents.on("render-process-gone", stopResourceUsageSampling);
  instance.webContents.on("destroyed", stopResourceUsageSampling);

  logger.info("[resource-manager] window opened");
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

function baseProcess(
  pid: number,
  name: string,
  groupKey: string,
  cpuPercent: number,
  memoryBytes: number,
): ResourceUsageProcess {
  return {
    pid,
    name,
    category: "base",
    groupKey,
    groupLabel: groupKey,
    cpuPercent,
    memoryBytes,
    sampled: true,
  };
}

/** Electron 自身进程（main / gpu / renderer / host / utility）→ 进程行 */
// [不变量] 一次快照只取一份 Electron 指标，后续所有 pid 查表都基于同一份数据。
// [权衡] 指标按 pid 建索引而不是按进程类型查，避免同名 utility 进程互相覆盖。
// [资源] 逻辑 CPU 数只取一次供归一化复用，避免每行都重复调用系统接口。
function collectElectronProcesses(): ResourceUsageProcess[] {
  const metrics = app.getAppMetrics();
  const metricsByPid = new Map(metrics.map((m) => [m.pid, m]));
  const assigned = new Set<number>();
  const rows: ResourceUsageProcess[] = [];
  const logicalCpuCount = os.cpus().length;

  const metricsOf = (pid: number): { cpuPercent: number; memoryBytes: number } => {
    const metric = metricsByPid.get(pid);
    return {
      cpuPercent: normalizeElectronCpuToMachinePercent(metric?.cpu.percentCPUUsage, {
        logicalCpuCount,
      }),
      // getAppMetrics 的 workingSetSize 单位是 KB
      memoryBytes: (metric?.memory.workingSetSize ?? 0) * 1024,
    };
  };
  // [不变量] 按 pid 去重是组装进程行时唯一的合并策略，先写入者占位。
  // [失败路径] 重复 pid 直接丢弃后到的行，不合并数值，避免同一进程被重复计数。
  const push = (row: ResourceUsageProcess): void => {
    if (assigned.has(row.pid)) return;
    assigned.add(row.pid);
    rows.push(row);
  };

  const mainMetrics = metricsOf(process.pid);
  push(
    baseProcess(
      process.pid,
      formatZCodeMainProcessName(),
      "main",
      mainMetrics.cpuPercent,
      mainMetrics.memoryBytes,
    ),
  );

  for (const m of metrics) {
    if (m.type === "GPU") {
      const { cpuPercent, memoryBytes } = metricsOf(m.pid);
      push(baseProcess(m.pid, formatZCodeGpuProcessName(), "gpu", cpuPercent, memoryBytes));
    }
  }

  // 同一个 OS 进程可能承载多个 BrowserWindow，按 PID 去重。
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const rendererPid = win.webContents.getOSProcessId();
    if (rendererPid <= 0) continue;
    const { cpuPercent, memoryBytes } = metricsOf(rendererPid);
    push(
      baseProcess(
        rendererPid,
        formatZCodeRendererProcessName(win.getTitle() || `Window ${win.id}`),
        "renderer",
        cpuPercent,
        memoryBytes,
      ),
    );
  }

  // browser-use 的浏览器 guest：renderer 进程但归内置插件。
  const browserUseGuestIds = new Set(browserUseGuestWebContentsIdsProvider());
  for (const contents of electronWebContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const rendererPid = contents.getOSProcessId();
    if (rendererPid <= 0 || assigned.has(rendererPid)) continue;
    const { cpuPercent, memoryBytes } = metricsOf(rendererPid);
    const name = buildAuxiliaryRendererName(contents);
    if (browserUseGuestIds.has(contents.id)) {
      push({
        pid: rendererPid,
        name,
        category: "builtin-plugin",
        groupKey: `builtin:${BROWSER_USE_PLUGIN_NAME}`,
        groupLabel: BROWSER_USE_PLUGIN_NAME,
        cpuPercent,
        memoryBytes,
        sampled: true,
      });
      continue;
    }
    push(baseProcess(rendererPid, name, "renderer", cpuPercent, memoryBytes));
  }

  // host 是 main 通过 utilityProcess.fork() 创建的直接子进程。
  for (const [label, child] of hostProcesses) {
    if (child.pid == null) continue;
    const { cpuPercent, memoryBytes } = metricsOf(child.pid);
    push(
      baseProcess(child.pid, formatZCodeHostProcessName(label), "host", cpuPercent, memoryBytes),
    );
  }

  for (const m of metrics) {
    if (assigned.has(m.pid)) continue;
    const { cpuPercent, memoryBytes } = metricsOf(m.pid);
    push(
      baseProcess(
        m.pid,
        m.type === "Utility"
          ? formatZCodeUtilityProcessName(m.name || String(m.pid))
          : formatZCodeUtilityProcessName(m.type, "process"),
        "utility",
        cpuPercent,
        memoryBytes,
      ),
    );
  }

  return rows;
}

// [并发] 所有 Host 并行请求，单 Host 超时由采样层回退上一轮结果，不阻塞整体。
// [失败路径] Host 尚未分到 pid 时返回空数组，占位工作留给后续的 Agent 兜底。
// [事务] 结果扁平化后交给上层再做 pid 过滤，采样层不参与去重决策。
async function collectHostProcesses(signal?: AbortSignal): Promise<HostResourceUsageProcess[]> {
  const results = await Promise.all(
    [...hostProcesses].map(([label, child]) =>
      child.pid != null ? requestHostResourceUsage(label, child, undefined, signal) : [],
    ),
  );
  return results.flat();
}

/** Agent 注册表兜底：Host 还没回报的 Agent 也要出现在列表里（指标未采到） */
function collectUnsampledAgentProcesses(sampledPids: Set<number>): ResourceUsageProcess[] {
  const rows: ResourceUsageProcess[] = [];
  for (const processes of hostAgentProcesses.values()) {
    for (const agent of [...processes.values()].sort(
      (left, right) => left.startedAt - right.startedAt,
    )) {
      if (sampledPids.has(agent.pid)) continue;
      rows.push({
        pid: agent.pid,
        name: formatZCodeAgentProcessName(agent.provider, agent.workspacePath),
        category: "base",
        groupKey: "cli",
        groupLabel: "cli",
        cpuPercent: 0,
        memoryBytes: 0,
        sampled: false,
      });
    }
  }
  return rows;
}

const systemCpuMeter = createSystemCpuMeter();

/** 一次完整快照：Electron 进程 + Host 采样的外部进程 + 系统总量 */
export async function buildResourceUsageSnapshot(
  options: { includeHosts?: boolean; signal?: AbortSignal } = {},
): Promise<ResourceUsageSnapshot> {
  const electronProcesses = collectElectronProcesses();
  const hostRows = options.includeHosts === false ? [] : await collectHostProcesses(options.signal);

  const electronPids = new Set(electronProcesses.map((row) => row.pid));
  const processes: ResourceUsageProcess[] = [...electronProcesses];
  for (const row of hostRows) {
    // Host 子树里会再次看到 Host 自身之外的 Electron 进程吗？不会（它们都是 main 的子进程），
    // 但 pid 复用等极端情况下仍按 Electron 指标优先。
    if (electronPids.has(row.pid)) continue;
    processes.push({ ...row, sampled: true });
  }
  processes.push(...collectUnsampledAgentProcesses(new Set(processes.map((row) => row.pid))));

  const appTotals = processes.reduce(
    (total, row) => ({
      cpuPercent: total.cpuPercent + row.cpuPercent,
      memoryBytes: total.memoryBytes + row.memoryBytes,
    }),
    { cpuPercent: 0, memoryBytes: 0 },
  );
  const memoryTotalBytes = os.totalmem();

  return {
    sampledAt: Date.now(),
    logicalCpuCount: os.cpus().length,
    system: {
      cpuPercent: systemCpuMeter.read(),
      memoryTotalBytes,
      memoryUsedBytes: Math.max(0, memoryTotalBytes - os.freemem()),
    },
    app: {
      cpuPercent: Math.round(appTotals.cpuPercent * 10) / 10,
      memoryBytes: appTotals.memoryBytes,
    },
    processes,
  };
}
