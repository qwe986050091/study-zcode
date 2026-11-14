// ============================================================================
// [b18 深注] 文件头：desktopStabilityTelemetry.ts —— 职责边界
//   main 进程的稳定性遥测出口：ANR/挂死探测、renderer 与 child 退出分类、Agent 崩溃诊断与脱敏、事件去重、ARMS 发送；只做「观测」，绝不改变业务状态机。
//   不负责：崩溃现场采集（desktopCrashCapture 负责落盘）、Host 侧诊断收集、UI 提示；这些一旦搬进来，IO 失败会直接打断上报。
//   所有上报必须 best-effort：任何异常都只能降级为日志。
// ============================================================================
// 不变量（INV）表：断言 —— 守住位置 —— 改错后的故障
//   INV-01 globalContext 未配置前一切上报静默丢弃 —— reportStabilityCustom 首判断 —— 改错：启动早期抛错或半截属性上报。
//   INV-02 上报永不抛错 —— sendCustom / sendEvent 的 try/catch —— 改错：遥测故障阻断主流程。
//   INV-03 属性必须经 stringifyProperties 归一 —— payload 构造 —— 改错：undefined 进入属性集，统计口径漂移。
//   INV-04 事件名到 metric_value 的映射固定 —— resolveStabilityMetricValue —— 改错：ANR 时长被记成计数 1。
//   INV-05 崩溃详情必须先脱敏再截断 —— sanitizeAgentCrashDetail 的调用顺序 —— 改错：尾部路径或密钥逃过脱敏。
//   INV-06 <workspace>/<home> 占位符必须在路径脱敏后恢复 —— redactRemainingAbsolutePaths —— 改错：用户工作区被抹成 <path>。
//   INV-07 指纹只基于归一化文本 —— normalizeAgentCrashFingerprintSource —— 改错：同一崩溃因 pid/路径不同被拆散。
//   INV-08 结构噪音行必须先剔除再选摘要 —— isAgentDiagnosticNoise —— 改错：[Object] 盖过真实 OOM。
//   INV-09 摘要优先级固定：OOM、sqlite、errno、Error、关键字 —— errorLine 的链式 find —— 改错：诊断类别随机漂移。
//   INV-10 OOM 一律 ERR_OUT_OF_MEMORY 且名称为 AgentOutOfMemory —— 该分支 —— 改错：内存问题被算作普通退出。
//   INV-11 异常去重键为 runtimeInstanceId:errorId，且仅在成功后入集合 —— reportAgentProcessExceptionToArms —— 改错：重复上报或失败事件被永久吞掉。
//   INV-12 去重集合有容量上限并淘汰最早项 —— AGENT_EXCEPTION_DEDUP_CAPACITY —— 改错：长会话内存持续增长。
//   INV-13 只有 terminationKind=unexpected 才上报 Agent crash —— reportAgentProcessExitToArms 首判断 —— 改错：正常退出计入崩溃。
//   INV-14 受控终止仅在缺少 protocol-close 根因时抑制 —— isProtocolFailure —— 改错：真实崩溃被误当受控退出。
//   INV-15 app_quit/update_install 期间的迟到 Agent 退出必须抑制 —— lifecycleScene 判断 —— 改错：退出阶段误报 crash。
//   INV-16 lifecycleScene 在退出后不可恢复 —— notifyStabilityAppExit —— 改错：后续事件回到 runtime，crash 率虚高。
//   INV-17 killed 与 clean-exit 不是崩溃 —— classifyRenderProcessCrash / shouldReportChildProcessGoneAsCrash —— 改错：正常关窗触发崩溃告警。
//   INV-18 gpu 与 utility 子进程退出只记 process_exit —— 该角色判断 —— 改错：可恢复退出拉低 crash-free。
//   INV-19 窗口场景必须取崩溃 WebContents 自身窗口 —— resolveRegisteredWindowScene(win) —— 改错：辅助窗被算成主窗。
//   INV-20 只有登记过的业务窗口才算主窗 —— mainWindowIds —— 改错：Resource Manager 污染 Crash 率。
//   INV-21 ANR 阈值 STABILITY_ANR_THRESHOLD_MS、freeze 阈值 STABILITY_FREEZE_THRESHOLD_MS 各自只报一次 —— UnresponsiveWatchState 的三个标志 —— 改错：重复上报或永久挂死。
//   INV-22 轮询定时器必须 unref 并在 crash/responsive/destroyed 时清理 —— pollTimer —— 改错：事件循环被拖住或状态泄漏。
//   INV-23 perf_app_start 只报一次且必须在首屏后 —— perfAppStartReported 与延迟 —— 改错：与首屏 PV 分属不同批次。
//   INV-24 每次 gone 回调生成新 crash_id，不做时间窗去重 —— reportPerfCrash —— 改错：同类不同进程事故被吞。
//   INV-25 日志级别由 exit_kind 决定 —— reportPerfProcessExit 的 logLevel —— 改错：正常退出被 console collector 计为异常。
/* eslint-disable max-lines -- 稳定性上报集中单模块，拆分反而增加跨文件状态同步 */
import { createHash, randomUUID } from "node:crypto";
// [契约] ARMS SDK 是唯一上报通道，禁止在本文件另建 HTTP 客户端。
// SDK 未初始化时 sendCustom 可能抛错，因此调用点必须自带 try/catch。
import armsRum from "@arms/rum-electron";
import { BrowserWindow, type WebContents } from "electron";
import {
  mapZCodeEnvToArmsRumEnv,
  type HostAgentProcessErrorResponse,
  type HostAgentProcessExceptionResponse,
  type HostAgentProcessExitedResponse,
  type HostAgentProcessReadyResponse,
  type HostAgentProcessSpawnedResponse,
} from "@zcode/shared";
import type { CrashCapturePaths } from "./desktopCrashCapture.js";
import { registerCrashEventMonitor as registerBaseCrashEventMonitor } from "./desktopCrashCapture.js";
import { getResourceManagerWindowId } from "./resourceManagerWindow.js";

/** ANR：主线程无响应阈值（与 Electron unresponsive 对齐） */
// [契约] 与 Electron 的 unresponsive 事件阈值对齐，避免两套口径。
// 调低会让正常的重计算被计入 ANR，调高则漏报真实卡死。
// 该值只被 shouldReportAnr 读取，不参与 freeze 判定。
// 改它必须同步评估 ARMS 看板的历史基线。
export const STABILITY_ANR_THRESHOLD_MS = 5_000;
/** 挂死：未恢复且未 crash 的更长无响应阈值 */
// [契约] 未恢复且未崩溃的更长无响应阈值，用于区分挂死与短暂卡顿。
// 必须大于 ANR 阈值：否则 freeze 会先于 ANR 触发，指标语义倒置。
// 与 ANR 一样每个 watch 只报一次。
// 该值不参与轮询间隔，轮询固定 1s。
export const STABILITY_FREEZE_THRESHOLD_MS = 30_000;
// [契约] 崩溃详情上限，防止单条事件超过 ARMS 的属性体积限制。
// 截断（truncateAgentCrashDetail）发生在脱敏（sanitizeAgentCrashDetail）之后，否则会把 <workspace> 占位符切成半截。
// 调大只会增加上报体积，不会提升可诊断性。
export const AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH = 4_000;
export const STABILITY_TELEMETRY_SCHEMA_VERSION = 2;
// [契约] Windows 受控终止（control-c）退出码，用于抑制误报。
// 该码来自 Windows 状态常量，不要改成十进制魔数。
// 只在 Agent 退出判定中使用，renderer 侧不识别。
const WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE = 0x40010004;
// [资源] 去重集合上限，防止长会话无限增长。
// 淘汰策略是最早插入项，不保证 LRU。
// 容量过小会导致重复上报，过大则内存增长。
const AGENT_EXCEPTION_DEDUP_CAPACITY = 1024;
// [资源] 进程级去重集合，键为 runtimeInstanceId:errorId。
// 只在 sendEvent 成功后插入，失败允许下次重试。
// 不持久化：进程重启会清空，符合「同一实例内只报一次」的语义。
// 遍历顺序即插入顺序，容量淘汰依赖这一点。
const reportedAgentExceptions = new Set<string>();

const AGENT_CRASH_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AGENT_CRASH_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AGENT_CRASH_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;
const AGENT_CRASH_UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const AGENT_CRASH_STACK_LOCATION_PATTERN = /:\d+:\d+/g;
const AGENT_CRASH_POSIX_HOME_PATTERN = /\/(?:Users|home)\/[^/\s"'`()[\]{}<>]+/g;
const AGENT_CRASH_WINDOWS_HOME_PATTERN = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`()[\]{}<>]+/gi;
const AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN =
  /\b[A-Za-z]:[\\/](?:[^\\/\s"'`()[\]{}<>:]+[\\/])*[^\\/\s"'`()[\]{}<>:]+/g;
const AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN =
  /\/(?:[^/\s"'`()[\]{}<>:]+\/)*[^/\s"'`()[\]{}<>:]+/g;
const AGENT_CRASH_KNOWN_PATH_PLACEHOLDER_PATTERN = /<(?:workspace|home)>[^\s"'`()[\]{}<>]*/g;

// [契约] 生命周期场景决定迟到的 Agent 退出是否计入崩溃。
// cold_start 只在 perf_app_start 上报期间短暂使用。
// app_quit 与 update_install 一旦设置就不再回退。
export type StabilityLifecycleScene = "cold_start" | "runtime" | "app_quit" | "update_install";

export type StabilityWindowScene = "main" | "process_monitor" | "other";

export type StabilityCrashKind = "native" | "js" | "oom";

export type StabilityCrashScope =
  | "app_native_process"
  | "main_window_renderer"
  | "auxiliary_window_renderer"
  | "embedded_webview"
  | "host"
  | "child";

export type StabilityCrashCause =
  | "oom"
  | "process_crashed"
  | "abnormal_exit"
  | "launch_failed"
  | "integrity_failure"
  | "native_crash"
  | "unknown";

export interface StabilityCrashClassification {
  crashKind: StabilityCrashKind;
  crashScope: StabilityCrashScope;
  crashCause: StabilityCrashCause;
}

export type StabilityProcessRole =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "agent"
  | "host"
  | "child"
  | "unknown";

export type AgentCrashPhase = "startup" | "runtime" | "unknown";
export type AgentTerminationClass = "exit_zero" | "exit_nonzero" | "signal" | "unknown";
export type AgentDiagnosticClass = "oom" | "sqlite" | "errno" | "generic" | "none";

// [契约] 只依赖最小日志接口，便于测试注入与 Host 侧复用。
// debug 可选：部分调用方没有实现，调用时必须用可选链。
interface StabilityLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

// [契约] 全局上下文在 configureDesktopStabilityTelemetry 中一次性写入。
// deviceMid 是所有事件的关联键，缺失会导致看板无法聚合。
// armsEnv 必须是 mapZCodeEnvToArmsRumEnv 的产物，不自行映射。
interface StabilityGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

// [资源] 单个 WebContents 的无响应观测状态，按 webContentsId 索引。
// 三个 reported 标志保证 ANR、freeze、crash 各自只上报一次。
// pollTimer 必须在 clearUnresponsiveWatch 中清理，否则泄漏。
// startedAt 取 unresponsive 事件到达时刻，不是首次轮询时刻。
// windowScene 在创建时快照，避免窗口随后销毁导致分类漂移。
interface UnresponsiveWatchState {
  windowId: number;
  webContentsId: number;
  windowScene: StabilityWindowScene;
  startedAt: number;
  anrReported: boolean;
  freezeReported: boolean;
  crashReported: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
}

// [契约] reason 是 Electron 原始退出原因，分类逻辑全部在 mapExitReason* 中。
// webContentsType 用于区分 webview 与普通窗口。
// windowScene 缺省时按主窗口处理，这是历史兼容行为。
export interface RenderProcessGoneInput {
  reason: string;
  exitCode: number;
  webContentsType: string;
  windowScene?: StabilityWindowScene;
}

export interface ChildProcessGoneInput {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string;
  name: string;
}

// [契约] 唯一可变全局，未配置时所有上报静默返回。
// 不做默认值兜底：缺 device_mid 的事件没有分析价值。
// 配置只写一次，重复调用会覆盖，但不应发生。
let globalContext: StabilityGlobalContext | null = null;
// [并发] 模块级可变场景 lifecycleScene，被上报与退出抑制逻辑共同读取。
// 默认 runtime 表示应用正常运行阶段。
// 写入只发生在 reportPerfAppStart 与 notifyStabilityAppExit。
// 不要在读取处做缓存：退出期间的迟到事件必须看到最新值。
let lifecycleScene: StabilityLifecycleScene = "runtime";
// 修复原因：WebContents.getType() 对所有 BrowserWindow 都返回 window，无法区分主业务窗和
// Resource Manager / 更新 / About。只登记 createWindowInstance 创建的业务窗口，避免辅助窗污染 Crash 率。
// [契约] 只登记 createWindowInstance 创建的业务窗口 id。
// WebContents.getType 无法区分主窗与辅助窗，因此必须显式登记。
// 窗口 closed 时移除，避免 id 复用造成误判。
// 未登记的窗口一律归为 other，不计入主窗 Crash 率。
const mainWindowIds = new Set<number>();
let perfAppStartReported = false;
// [资源] 活跃的无响应观测表，key 为 webContentsId。
// 同一次 unresponsive 会先清理旧状态再新建，保证不叠加。
// responsive 与 destroyed 都必须删除条目，否则轮询永不停止。
// 该表不做容量限制：条目数量必须受窗口数量约束。
const unresponsiveByWebContentsId = new Map<number, UnresponsiveWatchState>();

// [契约] 把 Node 平台名收敛为三分类，保证看板维度稳定。
// 未知平台统一归 linux，不新增维度。
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

// [契约] undefined 直接跳过，绝不写成字符串 undefined。
// 数字与布尔统一转字符串，保持 ARMS 属性类型一致。
// 不递归处理嵌套对象：属性值必须是标量。
// 调用方必须传扁平对象，否则会出现 [object Object]。
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

// [契约] 计数类事件必须固定为 1，时长类取 duration_ms，退出类取 exit_code。
// Number 转换失败时回落 0，保证 value 始终是有限数。
// 新增事件名必须在此登记，否则会落入 default 被记为 1。
// 该值与 payload 中的 metric_value 必须来自同一来源。
// 不要在此做单位换算：口径由调用方保证。
function resolveStabilityMetricValue(
  name: string,
  properties: Record<string, string | number | boolean | undefined>,
): number {
  switch (name) {
    case "perf_anr":
    case "perf_freeze": {
      const duration = Number(properties.duration_ms);
      return Number.isFinite(duration) ? duration : 0;
    }
    case "perf_app_exit":
    case "perf_process_exit": {
      const exitCode = Number(properties.exit_code);
      return Number.isFinite(exitCode) ? exitCode : 0;
    }
    case "perf_crash":
      return 1;
    case "perf_app_start":
    default:
      return 1;
  }
}

function truncateAgentCrashDetail(value: string): string {
  return value.length > AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH
    ? value.slice(0, AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH)
    : value;
}

// [契约] 必须先把已知占位符替换成临时令牌，避免被后续路径正则一并抹掉。
// 临时令牌必须足够独特，不能出现在正常文本中。
// 最后按插入顺序恢复占位符，保证多次替换不串位。
// 该函数是 <workspace>/<home> 保真的唯一位置。
// 正则顺序固定：先 Windows 再 POSIX，避免盘符路径被 POSIX 规则截半。
function redactRemainingAbsolutePaths(value: string): string {
  // [资源] 数组下标即临时令牌编号，恢复时依赖该顺序；protectedPaths 只在本次调用内有效，不跨调用复用。
  // 不能去重：重复占位符需要按出现顺序逐一还原。
  const protectedPaths: string[] = [];
  const protectedValue = value.replace(AGENT_CRASH_KNOWN_PATH_PLACEHOLDER_PATTERN, (match) => {
    const index = protectedPaths.push(match) - 1;
    return `ZCODE_REDACTED_PATH_${index}_TOKEN`;
  });
  const redacted = protectedValue
    .replace(AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN, "<path>");
  return protectedPaths.reduce(
    (result, protectedPath, index) =>
      result.replace(`ZCODE_REDACTED_PATH_${index}_TOKEN`, protectedPath),
    redacted,
  );
}

// [契约] 顺序不可换：工作区替换、home 替换、路径脱敏、占位符恢复、敏感赋值、鉴权头、裸 key。
// workspacePath 为空时跳过替换，避免 split 空串把文本拆碎。
// 敏感赋值必须在路径脱敏之后，否则冒号会被路径规则破坏。
// 裸 API key 兜底：Host reporter 不是唯一输入边界。
// 最后才截断，保证被截掉的内容已经脱敏。
// 该函数对所有进入上报的字符串都必须是强制入口。
function sanitizeAgentCrashDetail(value: string, workspacePath: string): string {
  const withoutWorkspace = workspacePath ? value.split(workspacePath).join("<workspace>") : value;
  return truncateAgentCrashDetail(
    redactRemainingAbsolutePaths(
      withoutWorkspace
        .replace(AGENT_CRASH_WINDOWS_HOME_PATTERN, "<home>")
        .replace(AGENT_CRASH_POSIX_HOME_PATTERN, "<home>"),
    )
      .replace(AGENT_CRASH_SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
      .replace(AGENT_CRASH_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      // 修复原因：Host reporter 不是唯一输入边界，main 在发送 RUM 前必须再次遮盖裸 key。
      .replace(AGENT_CRASH_API_KEY_PATTERN, "$1<redacted>"),
  );
}

// [契约] 反斜杠归一为正斜杠消除平台差异；UUID、栈位置、pid、绝对路径都由占位符替代。
// 连续空白压成单空格，否则栈格式差异会让指纹漂移；只取前 1_000 字符避免超长栈拖慢 sha256；结果只用于指纹，不用于展示。
function normalizeAgentCrashFingerprintSource(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(AGENT_CRASH_UUID_PATTERN, "<uuid>")
    .replace(AGENT_CRASH_STACK_LOCATION_PATTERN, ":<line>:<column>")
    .replace(/\bpid\s*[:=]\s*\d+\b/gi, "pid=<pid>")
    .replace(AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function normalizeAgentDiagnosticSummary(value: string): string {
  return truncateAgentCrashDetail(value.replace(/\\/g, "/").trim());
}

// [契约] 命中的行不参与摘要选择，但仍会进入 errorStack 原文。
// [Object]、node:internal、at 帧、裸地址、GC 标题都是结构噪音，必须先剔除再选摘要（INV-08）。
// 只排除已知形态、不做语义判断，否则会误杀真实错误行；新增噪音形态要加一条明确正则，不能放宽已有规则。
// 该函数必须是纯函数，供两处过滤复用。
function isAgentDiagnosticNoise(line: string): boolean {
  return (
    /^(?:\[Object\]\s*,?\s*)+$/i.test(line) ||
    /\[Object\]/i.test(line) ||
    /^node:(?:events|internal)\b/i.test(line) ||
    /^at\s+/i.test(line) ||
    /^\d+:\s*0x[0-9a-f]+\b/i.test(line) ||
    /^\[\d+:0x[0-9a-f]+\]/i.test(line) ||
    /^<---.*--->$/.test(line) ||
    /^-+\s*(?:Native stack trace|JS stacktrace)\s*-+$/i.test(line) ||
    /^\(node:\d+\)\s*ExperimentalWarning:/i.test(line) ||
    /^\(Use `.*--trace-warnings.*\)$/i.test(line) ||
    /^(?:throw er;|Emitted ['"]error['"] event on .* instance at:)$/i.test(line) ||
    /^[}\]]\s*,?$/.test(line) ||
    /^(?:\{|\[)$/.test(line) ||
    /^["']?[\w-]+["']?\s*:\s*(?:\{|\[)$/.test(line) ||
    /^["']?code["']?\s*:\s*["'][A-Z0-9_]+["'],?$/i.test(line)
  );
}

// [契约] 显式 code 字段优先，且忽略泛化的 ERROR。
// 其次按常见错误码族匹配，排除 ERROR 本身。
// 找不到返回空串，调用方按空值处理而不是抛错。
function extractAgentErrorCode(value: string): string {
  const explicit = value.match(/\bcode:\s*["']?([A-Z][A-Z0-9_]+)\b/i)?.[1]?.toUpperCase();
  if (explicit && explicit !== "ERROR") {
    return explicit;
  }
  return (
    value
      .match(/\b(?:[A-Z]+_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|SQLITE_[A-Z0-9_]+|E[A-Z0-9_]{2,})\b/g)
      ?.find((candidate) => candidate !== "ERROR") ?? ""
  );
}

function isErrnoCode(errorCode: string): boolean {
  return /^E[A-Z0-9_]{2,}$/.test(errorCode) && !errorCode.startsWith("ERR_");
}

function isSqliteDiagnostic(value: string, errorCode: string): boolean {
  return (
    /^SQLITE_/i.test(errorCode) ||
    /\bSQLiteError\b|\bSQLite\s+(?:migration|database|initialization|lock)\b|\bdatabase (?:is locked|disk image is malformed)\b/i.test(
      value,
    )
  );
}

// [契约] 优先级：OOM、sqlite、errno、generic/none。
// OOM 判定只看文本特征，不依赖错误码。
// hasUsefulSummary 为 false 时归 none，表示没有可读摘要。
// 分类结果直接进入看板维度，变更需同步 schema 版本。
function classifyAgentDiagnostic(
  value: string,
  errorCode: string,
  hasUsefulSummary: boolean,
): AgentDiagnosticClass {
  if (/\b(?:JavaScript heap out of memory|Reached heap limit)\b/i.test(value)) {
    return "oom";
  }
  if (isSqliteDiagnostic(value, errorCode)) {
    return "sqlite";
  }
  if (isErrnoCode(errorCode)) {
    return "errno";
  }
  return hasUsefulSummary ? "generic" : "none";
}

// [契约] 用 | 连接各段后归一化，段顺序即语义。
// sha256 截取前 16 位，兼顾碰撞率与可读性。
// 调用方必须传入稳定顺序的字段，否则指纹不稳定。
function createAgentCrashFingerprint(parts: string[]): string {
  return createHash("sha256")
    .update(parts.map(normalizeAgentCrashFingerprintSource).join("|"))
    .digest("hex")
    .slice(0, 16);
}

// [契约] 只解析 stderr 尾部，不读取完整日志文件。
// 所有文本必须先脱敏再分析，避免正则命中敏感串。
// 空 stderr 也要返回可用的 fallback 名称与消息。
// 该函数的输出直接作为 perf_agent_crash 的属性来源。
function parseAgentStderrDiagnostic(event: HostAgentProcessExitedResponse): {
  errorName: string;
  errorCode: string;
  errorMessage: string;
  errorStack: string;
  errorFingerprint: string;
  diagnosticClass: AgentDiagnosticClass;
} {
  const errorStack = sanitizeAgentCrashDetail(
    event.stderrTail?.join("\n") ?? "",
    event.workspacePath,
  );
  const lines = errorStack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Bug 根因：旧逻辑把 stderr 第一条非空行当摘要，实际数据中的 [Object]、GC 标题和
  // native 地址因此盖过真正的 OOM / SQLite / errno。先排结构噪音，再按诊断确定性选行。
  const usefulLines = lines.filter((line) => !isAgentDiagnosticNoise(line));
  const oomLine = usefulLines.find((line) =>
    /\b(?:JavaScript heap out of memory|Reached heap limit)\b/i.test(line),
  );
  const stackErrorCode = extractAgentErrorCode(errorStack);
  const sqliteLine = usefulLines.find(
    (line) => !/ExperimentalWarning:/i.test(line) && isSqliteDiagnostic(line, stackErrorCode),
  );
  const errnoLine = usefulLines.find((line) => isErrnoCode(extractAgentErrorCode(line)));
  // [契约] 六级 fallback 依次为 OOM、sqlite、errno、Error 构造、关键字、首行，最终由 errorLine 的 ?? 链决定。
  // 顺序决定诊断类别，调整前必须确认优先级语义。
  // 首行兜底保证一定有摘要，不会出现空 message。
  // 该结果同时影响 errorName 与 errorMessage 两个字段。
  // 不要在链中加入宽泛匹配，会抢占更精确的分支。
  const errorLine =
    oomLine ??
    sqliteLine ??
    errnoLine ??
    usefulLines.find((line) => /^(?:[A-Za-z_$][\w$]*Error|Error):\s*/.test(line)) ??
    usefulLines.find((line) => /\b(?:Exception|fatal|panic|process exited)\b/i.test(line)) ??
    usefulLines[0];
  const errorMatch = errorLine?.match(/^([A-Za-z_$][\w$]*Error|Error):\s*(.*)$/);
  // [契约] OOM 使用固定名称，便于看板聚合。
  // 其余情况取 Error 构造名，缺失时用 AgentProcessExit。
  // 名称进入指纹，改名会重置历史聚类。
  const errorName = oomLine ? "AgentOutOfMemory" : (errorMatch?.[1] ?? "AgentProcessExit");
  const fallbackMessage = `Agent process exited unexpectedly (code=${event.exitCode ?? "null"}, signal=${event.signal ?? "null"})`;
  const errorMessage = normalizeAgentDiagnosticSummary(
    (oomLine ? oomLine.replace(/^FATAL ERROR:\s*/i, "") : errorMatch?.[2]?.trim()) ||
      errorLine ||
      fallbackMessage,
  );
  const errorCode = oomLine
    ? "ERR_OUT_OF_MEMORY"
    : extractAgentErrorCode(`${errorMessage}\n${errorStack}`);
  const diagnosticClass = classifyAgentDiagnostic(
    `${errorMessage}\n${errorStack}`,
    errorCode,
    errorLine != null,
  );
  return {
    errorName,
    errorCode,
    errorMessage,
    errorStack,
    diagnosticClass,
    errorFingerprint: createAgentCrashFingerprint([
      errorName,
      errorCode,
      errorMessage,
      lines.find((line) => line.startsWith("at ")) ?? "",
    ]),
  };
}

// [契约] spawn 失败携带结构化字段，不需要解析 stderr。
// errorMessage 为空时摘要等级降为 none。
// 指纹取栈中第一个 at 帧，缺失时不能贡献。
function parseAgentSpawnDiagnostic(event: HostAgentProcessErrorResponse): {
  errorName: string;
  errorCode: string;
  errorMessage: string;
  errorStack: string;
  errorFingerprint: string;
  diagnosticClass: AgentDiagnosticClass;
} {
  const errorName = event.errorName || "Error";
  const errorCode = event.errorCode ?? "";
  const errorMessage = sanitizeAgentCrashDetail(event.errorMessage, event.workspacePath);
  const errorStack = sanitizeAgentCrashDetail(event.errorStack ?? "", event.workspacePath);
  const diagnosticClass = classifyAgentDiagnostic(
    `${errorMessage}\n${errorStack}`,
    errorCode,
    Boolean(errorMessage),
  );
  return {
    errorName,
    errorCode,
    errorMessage,
    errorStack,
    diagnosticClass,
    errorFingerprint: createAgentCrashFingerprint([
      errorName,
      errorCode,
      errorMessage,
      errorStack.split(/\r?\n/).find((line) => line.trim().startsWith("at ")) ?? "",
    ]),
  };
}

function classifyAgentCrashPhase(runtimeReady: boolean | undefined): AgentCrashPhase {
  if (runtimeReady === true) {
    return "runtime";
  }
  if (runtimeReady === false) {
    return "startup";
  }
  return "unknown";
}

function classifyAgentTermination(event: HostAgentProcessExitedResponse): AgentTerminationClass {
  if (event.signal) {
    return "signal";
  }
  if (event.exitCode === 0) {
    return "exit_zero";
  }
  if (typeof event.exitCode === "number") {
    return "exit_nonzero";
  }
  return "unknown";
}

// [契约] 所有 custom 事件的统一出口：必须补全局属性、算 metric、发送。
// globalContext 未配置时静默返回，不排队不重试。
// lifecycleSceneOverride 仅用于 cold_start 这类瞬时场景。
// 发送异常只 warn，绝不向上抛。
// payload 平铺 properties，同名字段会覆盖内置字段。
function reportStabilityCustom(
  name: string,
  properties: Record<string, string | number | boolean | undefined>,
  windowScene?: StabilityWindowScene,
  lifecycleSceneOverride?: StabilityLifecycleScene,
): void {
  if (!globalContext) {
    return;
  }

  const metricValue = resolveStabilityMetricValue(name, properties);

  // [契约] 内置字段在前、业务属性后置（...properties 展开），后写的会覆盖同名内置字段。
  // scene_window 缺省为 main，与历史看板口径一致。
  // metric_value 必须与 group/value 使用同一个值。
  // telemetry_schema_version 随结构变更递增。
  const payload = stringifyProperties({
    event_name: name,
    platform: normalizeOsCategory(globalContext.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    telemetry_schema_version: STABILITY_TELEMETRY_SCHEMA_VERSION,
    scene_lifecycle: lifecycleSceneOverride ?? lifecycleScene,
    scene_window: windowScene ?? "main",
    metric_value: metricValue,
    ...properties,
  });

  try {
    // ARMS 原始日志/控制台按 custom 类型展示；业务分组用 group
    // value 填具体数值：ANR/挂死为 duration_ms，退出为 exit_code，计数类统一为 1
    // [契约] type 固定 custom、group 固定 stability，看板依赖这两个维度。
    // name 是事件名，value 是数值，两者不能互换。
    // 该调用可能同步抛错，必须包在 try 中。
    armsRum.sendCustom({
      name,
      type: "custom",
      group: "stability",
      value: metricValue,
      properties: payload,
    });
  } catch (error) {
    // 稳定性上报失败不应影响主流程
    // [失败路径] 用 warn 而不是 error：避免被 console collector 计为 JS 异常。
    console.warn("[stability] sendCustom failed:", name, error);
  }
}

// [契约] Agent 异常必须携带原始栈立即发送，不能等进程退出。
// 所有文本字段都先经 sanitizeAgentCrashDetail 脱敏，再计算指纹。
// 成功后才入去重集合，失败允许重试。
// stack 缺省时不写该字段，而不是写空串。
export function reportAgentProcessExceptionToArms(
  event: HostAgentProcessExceptionResponse,
  logger: StabilityLogger,
): void {
  if (!globalContext) return;
  const key = `${event.runtimeInstanceId}:${event.diagnostic.errorId}`;
  if (reportedAgentExceptions.has(key)) return;
  const diagnostic = event.diagnostic;
  const name = sanitizeAgentCrashDetail(diagnostic.name, event.workspacePath);
  const message = sanitizeAgentCrashDetail(diagnostic.message, event.workspacePath);
  const stack =
    diagnostic.stack === undefined
      ? undefined
      : sanitizeAgentCrashDetail(diagnostic.stack, event.workspacePath);
  try {
    // 根因：Electron collector 只监听自身进程，CLI 异常必须携带原始栈显式发送，
    // 不能先转成 console.error 包装字符串，也不能等待进程退出后再上报。
    // [契约] exception 事件必须带 source=kind，否则无法归类。
    // timestamp 使用诊断产生时间，不是上报时间。
    // properties 中的 process_role 固定 agent，用于区分 Host/child。
    // error_fingerprint 与 crash 事件共用算法，便于关联。
    // sendEvent 抛错时不得写入去重集合。
    armsRum.sendEvent({
      event_type: "exception",
      type: "error",
      source: diagnostic.kind,
      name,
      message,
      ...(stack === undefined ? {} : { stack }),
      timestamp: diagnostic.occurredAt,
      properties: stringifyProperties({
        process_role: "agent",
        process_error_kind: diagnostic.kind,
        process_error_origin: diagnostic.origin,
        error_id: diagnostic.errorId,
        runtime_instance_id: event.runtimeInstanceId,
        runtime_generation: event.runtimeGeneration,
        provider: event.provider,
        lane: event.lane,
        error_fingerprint: createAgentCrashFingerprint([
          name,
          message,
          stack?.split(/\r?\n/).find((line) => line.trim().startsWith("at ")) ?? "",
        ]),
        app_version: globalContext.appVersion,
        arms_env: globalContext.armsEnv,
        device_mid: globalContext.deviceMid,
        platform: normalizeOsCategory(globalContext.platform),
      }),
    });
    reportedAgentExceptions.add(key);
    if (reportedAgentExceptions.size > AGENT_EXCEPTION_DEDUP_CAPACITY) {
      reportedAgentExceptions.delete(reportedAgentExceptions.values().next().value!);
    }
  } catch (error) {
    // SDK 失败不能影响 Host 消息处理；未成功提交的事件不进入去重集合。
    logger.warn("[stability] Agent exception report failed", error);
  }
}

export function reportAgentProcessStartToArms(
  event: HostAgentProcessSpawnedResponse,
  logger: StabilityLogger,
): void {
  reportStabilityCustom("perf_agent_start", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
  });
  logger.info("[stability] perf_agent_start reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    runtimeInstanceId: event.runtimeInstanceId,
  });
}

export function reportAgentProcessReadyToArms(
  event: HostAgentProcessReadyResponse,
  logger: StabilityLogger,
): void {
  reportStabilityCustom("perf_agent_ready", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    startup_duration_ms: event.startupDurationMs,
  });
  logger.info("[stability] perf_agent_ready reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    runtimeInstanceId: event.runtimeInstanceId,
    startupDurationMs: event.startupDurationMs,
  });
}

// [契约] 只在 terminationKind=unexpected 时进入崩溃统计。
// 受控终止与退出阶段的迟到事件都只记 debug 日志。
// 诊断解析失败也必须回落到可读的 fallback 消息。
export function reportAgentProcessExitToArms(
  event: HostAgentProcessExitedResponse,
  logger: StabilityLogger,
): void {
  if (event.terminationKind !== "unexpected") {
    return;
  }
  // [契约] 协议故障（terminationReason === "protocol-close"）是结构化根因，优先级高于裸退出签名。
  // 有根因时不再按 SIGTERM 或 control-c 码抑制，否则真实崩溃会被吞；isProtocolFailure 只影响抑制判断，不改变上报内容。
  const isProtocolFailure = event.terminationReason === "protocol-close";
  if (
    !isProtocolFailure &&
    (event.exitCode === WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE || event.signal === "SIGTERM")
  ) {
    // Bug 根因：协议故障会先触发 protocol-close，再由 Host 回收仍存活的进程，
    // 因此最终也可能表现为 SIGTERM / Windows control-c exit code。只有缺少结构化
    // 协议根因时，裸退出签名才不足以证明 Agent 自身崩溃，应继续抑制误报。
    logger.debug?.("[stability] controlled Agent termination suppressed", {
      pid: event.pid,
      runtimeInstanceId: event.runtimeInstanceId,
      exitCode: event.exitCode,
      signal: event.signal,
    });
    return;
  }
  // [契约] 应用退出是 main 持有的更高层事实，迟到的 Agent 退出不计崩溃。
  // 只记 debug 日志，避免污染退出阶段的日志级别。
  // 该判断必须在诊断解析之前，省掉无用的脱敏开销。
  if (lifecycleScene === "app_quit" || lifecycleScene === "update_install") {
    // Bug 根因：Host 清理与 IPC 回传是异步的，perf_app_exit 之后仍可能晚到一个缺失
    // termination intent 的 Agent exit。应用退出是 main 持有的更高层事实，不能计入 runtime crash。
    logger.debug?.("[stability] late Agent exit suppressed during app shutdown", {
      pid: event.pid,
      runtimeInstanceId: event.runtimeInstanceId,
      lifecycleScene,
    });
    return;
  }
  const diagnostic = parseAgentStderrDiagnostic(event);
  // [契约] incident_kind 固定 unexpected_exit，与 spawn_error 区分。
  // exit_code 与 signal 缺省写成空串而不是 undefined。
  // diagnostic_class 与 error_* 字段全部来自同一份诊断对象。
  // crash_phase 与 termination_class 由事件字段派生，不在此计算。
  reportStabilityCustom("perf_agent_crash", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    incident_kind: "unexpected_exit",
    provider: event.provider,
    exit_code: event.exitCode ?? "",
    signal: event.signal ?? "",
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    uptime_ms: event.uptimeMs,
    stderr_line_count: event.stderrLineCount,
    crash_phase: classifyAgentCrashPhase(event.runtimeReady),
    termination_class: classifyAgentTermination(event),
    termination_reason: event.terminationReason,
    diagnostic_class: diagnostic.diagnosticClass,
    error_name: diagnostic.errorName,
    error_code: diagnostic.errorCode,
    error_message: diagnostic.errorMessage,
    error_stack: diagnostic.errorStack,
    error_fingerprint: diagnostic.errorFingerprint,
  });
  // 上报成功属于观测日志，error 会被 console collector 再生成一条伪 JS 异常。
  logger.info("[stability] perf_agent_crash reported", {
    pid: event.pid,
    exitCode: event.exitCode,
    signal: event.signal,
    runtimeGeneration: event.runtimeGeneration,
    errorName: diagnostic.errorName,
    errorCode: diagnostic.errorCode,
    errorFingerprint: diagnostic.errorFingerprint,
  });
}

export function reportAgentProcessSpawnErrorToArms(
  event: HostAgentProcessErrorResponse,
  logger: StabilityLogger,
): void {
  const diagnostic = parseAgentSpawnDiagnostic(event);
  reportStabilityCustom("perf_agent_spawn_error", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    incident_kind: "spawn_error",
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    diagnostic_class: diagnostic.diagnosticClass,
    error_name: diagnostic.errorName,
    error_code: diagnostic.errorCode,
    error_message: diagnostic.errorMessage,
    error_stack: diagnostic.errorStack,
    error_fingerprint: diagnostic.errorFingerprint,
  });
  logger.info("[stability] perf_agent_spawn_error reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    errorName: diagnostic.errorName,
    errorCode: diagnostic.errorCode,
    errorFingerprint: diagnostic.errorFingerprint,
  });
}

export function mapRenderProcessGoneToCrashKind(
  input: RenderProcessGoneInput,
): StabilityCrashKind | null {
  return classifyRenderProcessCrash(input)?.crashKind ?? null;
}

// [契约] oom 与 memory-eviction 都归为 oom，其余一律 native。
// renderer 与 child 共用该映射，不能按来源区分。
// Electron 41 起把内存压力驱逐单独命名，漏掉会低估 OOM。
// 不要在此返回 null：是否上报由调用方判断。
function mapExitReasonToCrashKind(reason: string): StabilityCrashKind {
  // Electron 的 renderer/child gone 回调共用这组退出原因，OOM 不能因进程来源不同而被归为 native。
  return reason === "oom" || reason === "memory-eviction" ? "oom" : "native";
}

// [契约] 原因映射是穷举式 switch，未知值归 unknown 而不是抛错。
// memory-eviction 与 oom 同因，必须落在同一分支。
// abnormal 与 abnormal-exit 是不同 Electron 版本的同一语义。
// crashCause 直接作为看板维度，新增枚举需同步 schema。
function mapExitReasonToCrashCause(reason: string): StabilityCrashCause {
  switch (reason) {
    case "oom":
    // Electron 41 将 Chromium 的内存压力驱逐单独命名；它与 oom 一样表示进程因内存
    // 压力退出，不能落入 native/unknown，否则 OOM 指标会被低估。
    case "memory-eviction":
      return "oom";
    case "crashed":
      return "process_crashed";
    case "abnormal":
    case "abnormal-exit":
      return "abnormal_exit";
    case "launch-failed":
      return "launch_failed";
    case "integrity-failure":
      return "integrity_failure";
    default:
      return "unknown";
  }
}

// [契约] killed 与 clean-exit 返回 null，表示不是崩溃。
// webview 优先于窗口场景：webview 挂在任意窗口内。
// windowScene 缺省按主窗口处理，是历史兼容约定。
// 返回值决定走 crash 还是 process_exit 两条上报路径。
// 该函数必须无副作用，供纯判定复用。
export function classifyRenderProcessCrash(
  input: RenderProcessGoneInput,
): StabilityCrashClassification | null {
  if (input.reason === "killed" || input.reason === "clean-exit") {
    return null;
  }
  return {
    crashKind: mapExitReasonToCrashKind(input.reason),
    crashScope:
      input.webContentsType === "webview"
        ? "embedded_webview"
        : input.windowScene === undefined || input.windowScene === "main"
          ? "main_window_renderer"
          : "auxiliary_window_renderer",
    crashCause: mapExitReasonToCrashCause(input.reason),
  };
}

export function mapChildProcessGoneToProcessRole(
  type: string,
  processName?: string,
): StabilityProcessRole {
  return mapChildProcessGoneToProcessRoleWithName(type, processName);
}

function mapChildProcessGoneToProcessRoleWithName(
  type: string,
  processName?: string,
): StabilityProcessRole {
  if (processName?.startsWith("zcode-host")) {
    return "host";
  }
  if (processName?.startsWith("zcode-agent")) {
    return "agent";
  }
  switch (type) {
    case "GPU":
      return "gpu";
    case "Utility":
      return "utility";
    default:
      return "child";
  }
}

// [契约] killed 与 clean-exit 直接排除。
// gpu 与 utility 退出可由 Chromium 自动重建，不计 crash。
// host 与 agent 走完整崩溃上报。
// 该判断与 classifyRenderProcessCrash 的口径必须一致。
// 放宽任一条件都会拉低 crash-free 指标的可信度。
export function shouldReportChildProcessGoneAsCrash(input: ChildProcessGoneInput): boolean {
  if (input.reason === "killed" || input.reason === "clean-exit") {
    return false;
  }

  const role = mapChildProcessGoneToProcessRoleWithName(input.type, input.name);
  if (role === "gpu") {
    return false;
  }

  // Bugfix: RUM 里 Video Capture / Network Service / Audio Service 等 Chromium Utility
  // 子进程会被系统自动重建，不会让 ZCode 主窗口或会话不可用；它们只能作为可恢复退出记录，
  // 不能进入 perf_crash，否则会把 crash-free 指标按“非真实崩溃”拉低。
  if (role === "utility") {
    return false;
  }

  return true;
}

export function shouldReportAnr(elapsedMs: number, anrReported: boolean): boolean {
  return !anrReported && elapsedMs >= STABILITY_ANR_THRESHOLD_MS;
}

export function shouldReportFreeze(
  elapsedMs: number,
  freezeReported: boolean,
  crashReported: boolean,
): boolean {
  return !freezeReported && !crashReported && elapsedMs >= STABILITY_FREEZE_THRESHOLD_MS;
}

// [契约] 已销毁或缺失窗口归 other，不猜测主窗。
// Resource Manager 优先判定，避免它被登记为主窗。
// 只有 mainWindowIds 中的窗口才是 main。
// 该函数是 crash_scope 的唯一来源。
function resolveRegisteredWindowScene(win: BrowserWindow | null | undefined): StabilityWindowScene {
  if (!win || win.isDestroyed()) {
    return "other";
  }
  const resourceManagerId = getResourceManagerWindowId();
  if (resourceManagerId != null && win.id === resourceManagerId) {
    return "process_monitor";
  }
  return mainWindowIds.has(win.id) ? "main" : "other";
}

function resolveWindowScene(win: BrowserWindow | null | undefined): StabilityWindowScene {
  if (win && !win.isDestroyed()) {
    return resolveRegisteredWindowScene(win);
  }
  const focused = BrowserWindow.getFocusedWindow();
  // 与 INV-19 冲突（D-8-2，未修）：按契约缺失窗口应由 other 承接、不猜测主窗，当前实现却回退 main；
  // webview 与已销毁窗口的崩溃会因此算进主窗 crash 率，待修：回退值应为 other。
  return focused && !focused.isDestroyed() ? resolveRegisteredWindowScene(focused) : "main";
}

function markWebContentsCrash(webContentsId: number): void {
  const state = unresponsiveByWebContentsId.get(webContentsId);
  if (state) {
    state.crashReported = true;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }
}

function clearUnresponsiveWatch(webContentsId: number): void {
  const state = unresponsiveByWebContentsId.get(webContentsId);
  if (!state) {
    return;
  }
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
  }
  unresponsiveByWebContentsId.delete(webContentsId);
}

// [资源] 每秒轮询一次，直到 crash/freeze 上报或被清理。
// crashReported 为真时立即清除轮询定时器并清表，不再安排下一轮。
// ANR 与 freeze 各自只触发一次，靠标志位保证。
// 定时器必须 unref，避免阻止进程退出。
function pollUnresponsiveState(state: UnresponsiveWatchState, logger: StabilityLogger): void {
  if (state.crashReported) {
    clearUnresponsiveWatch(state.webContentsId);
    return;
  }

  // 度量口径（D-8-1，未修）：duration_ms 由 unresponsive 事件到达时刻起算，不是真实卡顿起点；
  // Chromium 会先自行判定无响应再发事件，看板上的 ANR/freeze 时长因此系统性偏小。
  const elapsedMs = Date.now() - state.startedAt;
  const windowScene = state.windowScene;

  if (shouldReportAnr(elapsedMs, state.anrReported)) {
    state.anrReported = true;
    reportStabilityCustom(
      "perf_anr",
      {
        duration_ms: elapsedMs,
        window_id: state.windowId,
        web_contents_id: state.webContentsId,
      },
      windowScene,
    );
    logger.warn("[stability] perf_anr reported", {
      windowId: state.windowId,
      webContentsId: state.webContentsId,
      durationMs: elapsedMs,
    });
  }

  if (shouldReportFreeze(elapsedMs, state.freezeReported, state.crashReported)) {
    state.freezeReported = true;
    reportStabilityCustom(
      "perf_freeze",
      {
        duration_ms: elapsedMs,
        window_id: state.windowId,
        web_contents_id: state.webContentsId,
      },
      windowScene,
    );
    logger.warn("[stability] perf_freeze reported", {
      windowId: state.windowId,
      webContentsId: state.webContentsId,
      durationMs: elapsedMs,
    });
  }

  // [资源] 只有未崩溃且未挂死才继续轮询。
  // 轮询间隔固定 1s，与本轮耗时无关。
  // unref 缺失会让无响应窗口拖住进程退出。
  // 下一轮回调仍复用同一个 state 对象，标志位持续生效。
  if (!state.freezeReported && !state.crashReported) {
    state.pollTimer = setTimeout(() => pollUnresponsiveState(state, logger), 1_000);
    state.pollTimer.unref?.();
  }
}

// [资源] 每个窗口 WebContents 绑定一次，重复绑定会重复上报。
// 三个监听都在 destroyed 时清理，保证表不泄漏。
// 该函数由 onBrowserWindowCreated 调用，不订阅全局事件。
function attachWebContentsStabilityWatch(
  win: BrowserWindow,
  webContents: WebContents,
  logger: StabilityLogger,
): void {
  const webContentsId = webContents.id;

  // [并发] 先 clearUnresponsiveWatch(webContentsId) 再新建，防止重复事件叠加计时。
  // startedAt 取事件到达时刻，不取首次轮询。
  // windowScene 在此快照，之后窗口销毁也不改变分类。
  // 立即执行一轮轮询，保证极短的无响应也能被判定。
  // 日志记录 URL 便于定位是哪个页面卡住。
  webContents.on("unresponsive", () => {
    clearUnresponsiveWatch(webContentsId);
    const state: UnresponsiveWatchState = {
      windowId: win.id,
      webContentsId,
      windowScene: resolveRegisteredWindowScene(win),
      startedAt: Date.now(),
      anrReported: false,
      freezeReported: false,
      crashReported: false,
      pollTimer: null,
    };
    unresponsiveByWebContentsId.set(webContentsId, state);
    logger.warn("[stability] webContents unresponsive", {
      windowId: win.id,
      webContentsId,
      url: webContents.getURL(),
    });
    pollUnresponsiveState(state, logger);
  });

  webContents.on("responsive", () => {
    logger.info("[stability] webContents responsive", {
      windowId: win.id,
      webContentsId,
    });
    clearUnresponsiveWatch(webContentsId);
  });

  webContents.on("destroyed", () => {
    clearUnresponsiveWatch(webContentsId);
  });
}

// [契约] 全局唯一初始化入口：写入 context 并同步 SDK 默认属性；重复调用会覆盖属性（运行期不应发生），配置字段必须与上报时读取的字段一致，且该函数不发送任何事件。
export function configureDesktopStabilityTelemetry(context: StabilityGlobalContext): void {
  globalContext = context;
  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

/** 与 @arms/rum-electron pv-collector 的 initial_load 窗口对齐，避免早于首屏 PV 单独 flush */
// [契约] 与 pv-collector 的 initial_load 窗口对齐，避免单独 flush。
// 过早发送会让 view 仍是 __default__，与 PV 不同批次；延迟从首屏完成后才开始计时。
const PERF_APP_START_AFTER_VIEW_MS = 3_200;

// [并发] 幂等：已上报直接返回，避免重复计数。
// 临时切到 cold_start 再恢复 runtime，保证事件场景正确。
// 置位在发送前：即使失败也不重试，避免抖动。
export function reportPerfAppStart(logger: StabilityLogger): void {
  if (perfAppStartReported) {
    return;
  }
  perfAppStartReported = true;
  lifecycleScene = "cold_start";
  reportStabilityCustom("perf_app_start", {}, "main", "cold_start");
  lifecycleScene = "runtime";
  logger.info("[stability] perf_app_start reported");
}

/**
 * 在主窗口首屏加载完成后再上报 perf_app_start。
 * 原因：过早 sendCustom 时 view 仍为 __default__，且可能与 renderer PV 分属不同上报批次；
 * ARMS 原始日志里常见只有 PV、看不到同 session 的 custom。
 */
// [契约] 加载中挂 once(did-finish-load)，已加载则立即排期。
// 两处都再次检查 perfAppStartReported 与销毁状态。
// 延迟期间窗口可能已销毁，回调内必须复核。
// 该函数不保证一定上报：窗口提前关闭就放弃。
export function scheduleReportPerfAppStartAfterMainViewReady(
  webContents: WebContents,
  logger: StabilityLogger,
): void {
  if (perfAppStartReported || webContents.isDestroyed()) {
    return;
  }

  const reportAfterView = (): void => {
    if (perfAppStartReported || webContents.isDestroyed()) {
      return;
    }
    setTimeout(() => {
      if (!webContents.isDestroyed()) {
        reportPerfAppStart(logger);
      }
    }, PERF_APP_START_AFTER_VIEW_MS);
  };

  if (webContents.isLoading()) {
    webContents.once("did-finish-load", reportAfterView);
    return;
  }

  reportAfterView();
}

// [契约] 幂等登记，重复调用不重复 add。
// closed 时移除 id，防止窗口 id 复用造成误判。
// 只有经过此函数的窗口才会被算作主业务窗。
export function registerStabilityMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || mainWindowIds.has(win.id)) {
    return;
  }
  mainWindowIds.add(win.id);
  win.once("closed", () => {
    mainWindowIds.delete(win.id);
  });
}

export function notifyStabilityLifecycle(scene: StabilityLifecycleScene): void {
  lifecycleScene = scene;
}

export function getStabilityLifecycleScene(): StabilityLifecycleScene {
  return lifecycleScene;
}

// [契约] 退出场景一旦写入就不可恢复，迟到事件据此被抑制。
// 上报 perf_app_exit 时使用传入的 exitCode 与 exitKind。
// 缺省值 0 与 normal 表示正常退出。
// 该函数不等待 Agent/Host 清理完成。
// 不要在退出后再调用 notifyStabilityLifecycle(runtime)。
export function notifyStabilityAppExit(
  scene: StabilityLifecycleScene,
  logger: StabilityLogger,
  options?: { exitCode?: number; exitKind?: string },
): void {
  // Bug 根因：旧实现上报 perf_app_exit 后立即恢复 runtime；Agent/Host 的异步退出事件
  // 因而丢失 app_quit/update_install 边界并被误计为 crash。退出流程一旦开始就不可逆，
  // lifecycle 必须保持到主进程终止。
  lifecycleScene = scene;
  reportStabilityCustom("perf_app_exit", {
    exit_code: options?.exitCode ?? 0,
    exit_kind: options?.exitKind ?? "normal",
  });
  logger.info("[stability] perf_app_exit reported", { scene, exitCode: options?.exitCode ?? 0 });
}

// [契约] 每次回调生成新 crash_id，不做时间窗去重。
// crash_source 固定 electron_callback，标识事件边界。
// 业务属性后置可覆盖内置字段；窗口场景取崩溃对象自身窗口（resolveWindowScene）。
function reportPerfCrash(
  classification: StabilityCrashClassification,
  logger: StabilityLogger,
  properties: Record<string, string | number | boolean | undefined>,
  win?: BrowserWindow | null,
): void {
  // [契约] crash_id 必须是 UUID，便于跨系统关联。
  // kind/scope/cause 三个维度共同描述事故类型。
  // caller 传入的 properties 在后，允许覆盖但不应覆盖 id。
  const crashProperties = {
    crash_id: randomUUID(),
    crash_kind: classification.crashKind,
    crash_scope: classification.crashScope,
    crash_cause: classification.crashCause,
    crash_source: "electron_callback",
    ...properties,
  };
  // Bugfix: 旧实现按 crash_kind 做五分钟去重，会吞掉同类但不同进程的真实事故。
  // Electron 的 gone 回调本身就是单次事故边界，这里每个回调只上报一次。
  reportStabilityCustom("perf_crash", crashProperties, resolveWindowScene(win));
  logger.error("[stability] perf_crash reported", crashProperties);
}

// [契约] 承载受控退出与可恢复的 helper 异常退出两种语义。
// 日志级别由 exit_kind 决定，正常退出用 info。
// 该事件不计入 crash 率，只用于生命周期分析。
// 缺省按 warn 处理，提醒存在未分类退出。
function reportPerfProcessExit(
  logger: StabilityLogger,
  properties: Record<string, string | number | boolean | undefined>,
  win?: BrowserWindow | null,
): void {
  reportStabilityCustom("perf_process_exit", properties, resolveWindowScene(win));
  // Bug 原因：perf_process_exit 同时承载受控退出和可恢复的 helper 异常退出。
  // 旧实现统一使用 error，导致正常生命周期被 ARMS console collector 误计为异常。
  const logLevel = properties.exit_kind === "normal" ? "info" : "warn";
  logger[logLevel]("[stability] perf_process_exit reported", properties);
}

// [契约] 三个回调必须分别处理 renderer 崩溃、child 退出、窗口创建。
// 落盘由 desktopCrashCapture 负责，本函数只做分类与上报。
// 回调内任何异常都会被采集模块吞掉，不能依赖重试。
export function registerDesktopStabilityMonitors(
  logger: StabilityLogger,
  crashPaths: CrashCapturePaths,
): void {
  registerBaseCrashEventMonitor(logger, crashPaths, {
    onRenderProcessGone: (webContents, details) => {
      // [资源] 先标记崩溃，停止该 WebContents 的 ANR/freeze 轮询。
      markWebContentsCrash(webContents.id);
      const win = BrowserWindow.fromWebContents(webContents);
      const input: RenderProcessGoneInput = {
        reason: details.reason,
        exitCode: details.exitCode,
        webContentsType: webContents.getType(),
        // 必须使用崩溃 WebContents 自身所属窗口；回退到当前焦点窗会把辅助窗误判成主业务窗。
        windowScene: resolveRegisteredWindowScene(win),
      };
      const classification = classifyRenderProcessCrash(input);
      if (classification) {
        reportPerfCrash(
          classification,
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: "renderer",
            web_contents_type: webContents.getType(),
            web_contents_id: webContents.id,
            window_id: win?.id,
          },
          win,
        );
      } else {
        reportPerfProcessExit(
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: "renderer",
            exit_kind: "normal",
            web_contents_id: webContents.id,
          },
          win,
        );
      }
    },
    onChildProcessGone: (details) => {
      // 修复原因：Electron 将 utilityProcess.fork() 的自定义标识放在 serviceName，
      // name 只表示 Chromium Utility 服务名（如 Network Service）。只读 name 会把
      // Host 归为 utility，导致 Host 异常退出走 recoverable_child_crash 而不是 perf_crash。
      // [契约] serviceName 优先：utilityProcess.fork 的自定义标识只在这里。
      // name 只表示 Chromium 内置服务名，会把 Host 误判为 utility。
      // 裁剪后为空串表示无法识别，交由 type 分类。
      // processName 同时用于角色判定与 process_name 上报属性。
      // 不要在此回退到 pid 或路径。
      const processName = details.serviceName?.trim() || details.name?.trim() || "";
      const role = mapChildProcessGoneToProcessRoleWithName(details.type, processName);
      if (details.reason === "killed" || details.reason === "clean-exit") {
        reportPerfProcessExit(logger, {
          exit_code: details.exitCode,
          exit_reason: details.reason,
          process_role: role,
          exit_kind: "normal",
          process_type: details.type,
          process_name: processName,
        });
      } else if (!shouldReportChildProcessGoneAsCrash({ ...details, name: processName })) {
        reportPerfProcessExit(logger, {
          exit_code: details.exitCode,
          exit_reason: details.reason,
          process_role: role,
          exit_kind: "recoverable_child_crash",
          process_type: details.type,
          process_name: processName,
        });
      } else {
        reportPerfCrash(
          {
            crashKind: mapExitReasonToCrashKind(details.reason),
            crashScope: role === "host" ? "host" : "child",
            crashCause: mapExitReasonToCrashCause(details.reason),
          },
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: role,
            process_type: details.type,
            process_name: processName,
          },
        );
      }
    },
    onBrowserWindowCreated: (win) => {
      attachWebContentsStabilityWatch(win, win.webContents, logger);
    },
  });
}
