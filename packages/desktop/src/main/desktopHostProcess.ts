// 职责边界（desktopHostProcess）
// 做：必须在 Main 进程 fork 唯一的 Local Host utilityProcess，转发 InitLocal、service port 与广播注册。
// 做：必须收口 Host 到 Main 的全部响应消息，转交遥测、资源采样、agent 进程登记与调度结算回调。
// 做：必须管理 host 生命周期，包括优雅 Dispose、3.5s 兜底强杀和 exit 清理。
// 不做：不能承载 task/session 业务状态，不解析工具事件，不在 Main 结算 cron/off-peak 调度。
// 不做：不能读写数据库、不能创建 Agent、不能直接执行 browser-use 命令（只注入 handler）。
// 依赖：electron utilityProcess 与 MessageChannelMain、@zcode/shared 协议、resourceManager 采样表。
// 边界：所有 Host 输出先过 hostResponseMessageSchema；未知消息丢弃，绝不向调用方抛错。
//
// INV 不变量表（19 条；每条都是「看起来该改、其实不能改」的约束）
// INV-01 断言：hostId 每次 fork 唯一且不由 workspacePath 派生 —— 守住它的位置：spawnHostProcess 顶部 randomUUID —— 改错故障：旧 host 的迟到消息被当成新实例，路由与租约判断全错
// INV-02 断言：数据库 startupId 由 relay 生成且在 InitLocal 之前绑定 —— 守住它的位置：bindDatabaseStartupRelay 调用点 —— 改错故障：Host 回传的 DatabaseStartupState 找不到 relay，窗口卡在启动遮罩
// INV-03 断言：ZCODE_PROCESS_LABEL 必须最后写入 env —— 守住它的位置：fork 的 env 展开顺序 —— 改错故障：所有 host 同名，资源面板与日志无法区分实例
// INV-04 断言：ZCODE_CUA_LAUNCHER_PID 只在 darwin 注入且取 Main 的 pid —— 守住它的位置：env 展开的 darwin 分支 —— 改错故障：Helper 签名校验失败，表现为健康检查超时而不是明确报错
// INV-05 断言：hostResponseMessageSchema 校验失败必须 return —— 守住它的位置：message 监听首段 —— 改错故障：一条畸形消息拆掉整个监听，后续 host 消息全部丢失
// INV-06 断言：每个消息分支处理完必须 return —— 守住它的位置：各 if 分支末尾 —— 改错故障：同一消息落入后续分支被二次结算
// INV-07 断言：exitedHostProcesses 只在 exit 回调写入 —— 守住它的位置：disposeHostProcessAndWait 开头读取处 —— 改错故障：提前写入让 Dispose 被跳过，host 变成孤儿
// INV-08 断言：UtilityProcess 没有 exitCode，存活判断必须只看 exitedHostProcesses —— 守住它的位置：同上 —— 改错故障：undefined 被当成已退出，退出流程漏发 Dispose
// INV-09 断言：强杀下限 3.5s 只能抬高不能降低 —— 守住它的位置：effectiveForceKillDelayMs —— 改错故障：host 先死，agent 进程树被 init 接管成孤儿
// INV-10 断言：dispose 幂等靠 disposingHostProcessTimers —— 守住它的位置：disposeHostProcess 开头 —— 改错故障：重复定时器让 host 被提前强杀
// INV-11 断言：exit 清理顺序是标记 exited、通知 CUA、flush 日志、注销 —— 守住它的位置：child.on exit —— 改错故障：日志最后一行丢失，或注销错删同 label 的新 host
// INV-12 断言：windowId 必须在 exit 回调之外取好 —— 守住它的位置：spawnHostProcess 中段 —— 改错故障：退出时 win 已销毁，读 webContents.id 直接抛异常
// INV-13 断言：广播注册用 webContents.id，taskRealtimeBus 用 win.id —— 守住它的位置：两处注册调用 —— 改错故障：renderer 收不到广播，或实时消息路由到错误窗口
// INV-14 断言：ServicePort 的 port2 必须随 InitLocal 一起 transfer —— 守住它的位置：attachInitialServicePort 分支 —— 改错故障：端口泄漏，Host 等待端口直到超时
// INV-15 断言：attachInitialServicePort 为 false 时不建 MessageChannel —— 守住它的位置：同上 —— 改错故障：共享 SSH/WSL host 多出首个 workspace 端口
// INV-16 断言：AgentProcessSpawned 注册与 AgentProcessExited 注销用同一个 pid —— 守住它的位置：两个分支 —— 改错故障：漏注册导致退出清理找不到 agent，遗留孤儿进程
// INV-17 断言：hostRunningTaskCountMap 计数为 0 必须 delete 而不是写 0 —— 守住它的位置：AgentRunningTaskCountChanged —— 改错故障：app-quit 永远等待一个不存在的任务
// INV-18 断言：Cron/OffPeak 结果只做字段搬运，由 scheduler 结算 —— 守住它的位置：两个结果分支 —— 改错故障：Main 重算 ok 或丢掉 failureKind，永久失败被无限重试
// INV-19 断言：CUA 操作状态唯一所有者必须是 Host，Main 只能投影 —— 守住它的位置：CuaOperationState 分支 —— 改错故障：Main 回写造成双写，turn 状态抖动
//
// 维护约定：新增消息分支先补 schema 与 HostResponseTypes，再在这里加独立 if 加 return。
// 维护约定：不要合并相邻分支或去掉 return，fallthrough 会让同一条消息被二次结算。
import { ingestToolExecResource } from "./desktopResourceTelemetry.js";
import { ingestMcpResourceSamples } from "./processResourceMcpTelemetrySource.js";
/* eslint-disable max-lines -- host process 统一处理 main↔host 生命周期、日志、ZCode Agent，拆分前先保持跨进程消息收口。 */
import {
  type HostAgentProcessErrorResponse,
  type HostAgentProcessExceptionResponse,
  type HostAgentProcessExitedResponse,
  type HostAgentProcessReadyResponse,
  type HostAgentProcessSpawnedResponse,
  type HostCuaOperationStateResponse,
  type HostMcpTelemetryResponse,
  type HostSessionCreateTelemetryResponse,
  type HostPluginTelemetryResponse,
  type RemoteTarget,
  type TaskRealtimeHostDeliveryKind,
  type WorkspacePurpose,
  formatZCodeHostProcessName,
  HostMessageTypes,
  hostResponseMessageSchema,
  HostResponseTypes,
  InternalChannels,
  LAUNCH_MARKS_QUERY_KEY,
  RUNTIME_ZCODE_DEBUG,
  serializeLaunchMarks,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@zcode/shared";
import type {
  PluginSandboxHandle,
  PluginSandboxRegisterRequestPayload,
  PluginSandboxRegisterResultPayload,
} from "@zcode/shared/mcp-apps";
import type { UtilityProcess as ElectronUtilityProcess, MessagePortMain } from "electron";
import {
  app,
  BrowserWindow,
  utilityProcess as electronUtilityProcess,
  MessageChannelMain,
} from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BroadcastHub } from "./broadcastHub.js";
import { bindDatabaseStartupRelay } from "./databaseStartupRelay.js";
import { getMainLaunchPartialMarks } from "./desktopLaunchMarks.js";
import { ingestHostNetworkObservations } from "./desktopNetworkTelemetry.js";
import {
  buildHostProcessEnv,
  hostModulePath,
  resolveBundledGlmBinaryPath,
} from "./desktopRuntimeEnv.js";
import { ingestHostNetworkCapture } from "./resourceManagerNetwork.js";
import { buildHostE2ECoverageEnv } from "./e2eCoverage.js";
import { createFeedbackLogArchiveFromExportLogs } from "./exportLogs.js";
import { createHostLogRelay } from "./hostLogRelay.js";
import { ingestCliResourceSample } from "./processResourceCliSource.js";
import { ingestHostSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { resolveHostResourceUsageResult } from "./resourceManagerHostSampling.js";
import {
  registerHostAgentProcess,
  registerHostProcess,
  unregisterHostAgentProcess,
  unregisterHostProcess,
} from "./resourceManagerWindow.js";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import type { TaskRealtimeBus } from "./taskRealtimeBus.js";

// WindowBootstrapOptions：renderer 启动 query 的类型契约。
export interface WindowBootstrapOptions {
  // restoreSession：是否恢复上次会话，布尔值需转字符串。
  restoreSession?: boolean;
  // supportsSettings：窗口是否展示设置入口。
  supportsSettings?: boolean;
  // initialWorkspacePath：待打开的初始工作区路径。
  initialWorkspacePath?: string;
  // initialWorkspacePurpose：工作区用途，决定 UI 模式。
  initialWorkspacePurpose?: WorkspacePurpose;
  // unavailableWorkspacePath：失效工作区路径，用于提示重建。
  unavailableWorkspacePath?: string;
  // windowKind：主窗口或更新状态窗口。
  windowKind?: "main" | "update-status";
  // locale：覆盖默认语言，仅影响本窗口。
  locale?: string;
}

// HostInitMessage：InitLocal 字段契约，Host 侧按它解析。
export interface HostInitMessage {
  // type 固定 InitLocal：Host 只认这一种启动消息。
  type: typeof HostMessageTypes.InitLocal;
  // hostId：Host 实例身份，与 taskRealtimeBus 注册值一致。
  hostId?: string;
  // databaseStartupId：由 relay 生成，Host 回传时按它对上。
  databaseStartupId?: string;
  // deliveryKind：实时消息投递语义，透传给 Host。
  deliveryKind?: TaskRealtimeHostDeliveryKind;
  // deviceMid：设备中台标识，遥测上报用。
  deviceMid?: string;
  // feedbackApiBase：反馈接口基址，Host 侧拼接请求。
  feedbackApiBase?: string;
  // workspacePath：首个工作区路径。
  workspacePath?: string;
  // workspaceIdentity：工作区身份，远程时与路径成对。
  workspaceIdentity?: string;
  // agentWarmupTargets：启动预热目标列表。
  agentWarmupTargets?: Array<{
    // workspacePath：单个预热目标的工作区路径。
    workspacePath: string;
    // workspaceIdentity：单个预热目标的身份标识。
    workspaceIdentity?: string;
  }>;
  // agentSpawnFallbackCwd：agent spawn 的兜底 cwd。
  agentSpawnFallbackCwd?: string;
  // remoteAssets：远程资源目录快照，Host 只读。
  remoteAssets?: RemoteAssetDirs;
  /** Main 解析后的 ZCode Built-in Provider Config 路径；Host/Services 不感知 Electron 安装布局。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** Main 提前异步采集并过滤的本机 runtime 环境；只允许传给 InitLocal。 */
  runtimeProcessEnvPatch?: Record<string, string>;
}

// SpawnHostProcessOptions：spawn 可选开关，全部有默认值。
export interface SpawnHostProcessOptions {
  // internalChannel：ServicePort 或 ScopedServicePort 二选一。
  internalChannel?: typeof InternalChannels.ServicePort | typeof InternalChannels.ScopedServicePort;
  // internalPayload：ScopedServicePort 的原始载荷。
  internalPayload?: unknown;
  // registerBroadcast：缺省 true，临时 host 可关。
  registerBroadcast?: boolean;
  // taskRealtime：实时路由注册参数，缺省则不注册。
  taskRealtime?: {
    // workspaceKeys：订阅的 workspace 键集合。
    workspaceKeys: Iterable<string>;
    // deliveryKind：路由投递语义，与 InitLocal 同值。
    deliveryKind?: TaskRealtimeHostDeliveryKind;
    // onHostId：注册后回传新 hostId。
    onHostId?: (hostId: string) => void;
  };
  // onPortReady：接管 port1，与 renderer 投递互斥。
  onPortReady?: (port: MessagePortMain) => void;
  /** 共享 SSH/WSL Host 初始化时不创建特殊的首个 workspace RPC port。 */
  attachInitialServicePort?: boolean;
}

// [资源] exitedHostProcesses 只标记「exit 事件已发生」的 host，WeakSet 不持有强引用。
// [契约] disposingHostProcesses 是 Set：退出流程需要枚举正在 dispose 的 host。
// [权衡] 两者不能合并成一个集合：仅 exited 的 host 不在 dispose 中，语义相反。
// [契约] 新增 host 状态前先问清「是否需要枚举」，否则 WeakSet 会让清理逻辑漏项。
const exitedHostProcesses = new WeakSet<ElectronUtilityProcess>();
// disposingHostProcesses：正在 dispose 的 host，供退出流程枚举。
const disposingHostProcesses = new Set<ElectronUtilityProcess>();

// [契约] 复制成数组再返回：调用方遍历期间 dispose 结束会改写集合。
// [并发] 返回值只是快照，不保证调用方拿到时仍在 disposing 中。
// [权衡] 这里不做存活校验：Electron UtilityProcess 没有可靠的 isAlive 字段。
export function listDisposingHostProcesses(): ElectronUtilityProcess[] {
  // 快照返回：调用方遍历期间 Set 可能被改写。
  return Array.from(disposingHostProcesses);
}

// loadWindow：装载 renderer 页面，并注入启动参数。
export function loadWindow(
  // win：目标窗口，由其 loadURL 或 loadFile 完成装载。
  win: BrowserWindow,
  // page：入口页，login 与 index 在 dev server 上路径不同。
  page: "index" | "login" = "index",
  // bootstrap：启动参数，全部转成 query 字符串。
  bootstrap?: WindowBootstrapOptions,
): Promise<void> {
  // [契约] query 只序列化非 null/undefined 的字段，浏览器地址栏会把其它值变成字符串。
  // [权衡] 布尔值必须 String() 显式转换，否则 URL 上变成空值，渲染端解析失败。
  // [失败路径] 过滤发生在 Object.entries 之后，顺序不能反，否则 undefined 会被写成字符串。
  // [契约] 这里新增字段必须同步 renderer 读取侧：query 没有 schema 校验。
  const query = Object.fromEntries(
    Object.entries({
      // restoreSession：布尔值显式 String 化，避免空值。
      restoreSession:
        // String 转换：false 也必须写成字符串，不能省略。
        bootstrap?.restoreSession == null ? undefined : String(bootstrap.restoreSession),
      // supportsSettings：同样需要 String 转换。
      supportsSettings:
        // null 与 undefined 一律转 undefined，随后被 filter 丢弃。
        bootstrap?.supportsSettings == null ? undefined : String(bootstrap.supportsSettings),
      // initialWorkspacePath：字符串原样透传。
      initialWorkspacePath: bootstrap?.initialWorkspacePath,
      // initialWorkspacePurpose：枚举值原样透传。
      initialWorkspacePurpose: bootstrap?.initialWorkspacePurpose,
      // unavailableWorkspacePath：失效路径原样透传。
      unavailableWorkspacePath: bootstrap?.unavailableWorkspacePath,
      // windowKind：窗口类型原样透传。
      windowKind: bootstrap?.windowKind,
      // locale：语言覆盖原样透传。
      locale: bootstrap?.locale,
    }).filter((entry): entry is [string, string] => entry[1] != null),
  );

  // [事务] 只给 index 页写 launch marks，login 页不参与启动耗时统计。
  // [契约] loadUrl 时间点 T3 必须在 loadURL/loadFile 之前采集，不能挪到函数末尾。
  // [并发] 先展开 partial 再覆盖 loadUrl，保证 T1/T2 已采集的标记不被丢掉。
  // [权衡] 每调用一次就刷新 T3，重载窗口会覆盖首次加载时间，这是既定口径。
  if (page === "index") {
    // partial：T1 与 T2 已采集的启动标记。
    const partial = getMainLaunchPartialMarks();
    // LAUNCH_MARKS_QUERY_KEY：与 renderer 约定的 query key。
    query[LAUNCH_MARKS_QUERY_KEY] = serializeLaunchMarks({
      ...partial,
      loadUrl: Date.now(), // T3
    });
  }

  // 生产包不能信任继承环境中的开发服务器地址，否则会被本机开发会话劫持为空白页。
  // [权衡] 打包态一律 loadFile：允许 env 覆盖等于让外部注入任意页面。
  // [失败路径] 开发态拼 /login.html 与根路径不能合并，login 在 dev server 上有独立入口。
  // [契约] 两条分支都必须携带 query，否则启动标记和 workspace 参数丢失。
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    // base：开发服务器地址，仅非打包态读取。
    const base = process.env["ELECTRON_RENDERER_URL"];
    // URL：login 页拼独立入口，其余用根路径。
    const url = new URL(page === "login" ? `${base}/login.html` : base);
    // searchParams：由 URL API 负责编码，避免手动转义。
    for (const [key, value] of Object.entries(query)) {
      // set：key 与 value 都已是字符串，直接写入。
      url.searchParams.set(key, value);
    }
    // [契约] 走 URLSearchParams，中文 workspace 路径由浏览器自动编码。
    // [失败路径] 不要在这里再手动 encodeURIComponent，会二次编码导致路径错乱。
    // [资源] 返回值必须透传 Promise，调用方靠它等待窗口首屏。
    return win.loadURL(url.toString());
  } else {
    // loadFile：打包态只认本地文件，query 携带启动参数。
    return win.loadFile(join(import.meta.dirname, `../renderer/${page}.html`), {
      // query：loadFile 的 query 选项，键值同上。
      query,
    });
  }
}

// spawnHostProcess：fork 唯一 Local Host，并接入消息收口与资源表。
export function spawnHostProcess(
  // win：宿主窗口，用于 port1 投递与退出时的 webContents 归属。
  win: BrowserWindow,
  // label：host 逻辑名，同时决定 serviceName 与资源表 key。
  label: string,
  // initMessage：InitLocal 载荷，spawn 内补 hostId 与 startupId。
  initMessage: HostInitMessage,
  // dependencies：宿主注入的回调与共享表，本函数不自行创建。
  dependencies: {
    // hostProcessLocalEnv：dotenv 解析出的本机环境变量。
    hostProcessLocalEnv: Record<string, string>;
    /** Main 进程已完成服务端灰度裁决；Host 只消费这个快照，不自行请求或分桶。 */
    desktopContextPromptEnabled?: () => boolean;
    // logger：spawn、exit 与 dispose 共用的日志出口。
    logger: {
      // info：正常路径日志。
      info: (...args: unknown[]) => void;
      // warn：postMessage 与 kill 失败走 warn。
      warn: (...args: unknown[]) => void;
    };
    // broadcastHub：按 windowId 注册，承载 main 到 renderer 的广播。
    broadcastHub: BroadcastHub;
    // taskRealtimeBus：实时任务路由，缺省则跳过注册。
    taskRealtimeBus?: TaskRealtimeBus;
    // windowHostProcessMap：windowId 到 host 的反向索引，exit 时清理。
    windowHostProcessMap: Map<number, ElectronUtilityProcess>;
    // hostRunningTaskCountMap：退出确认用的忙碌计数表。
    hostRunningTaskCountMap: Map<ElectronUtilityProcess, number>;
    // onWorkspaceRunningTaskCountChanged：按 workspace 维度上报计数变化。
    onWorkspaceRunningTaskCountChanged?: (
      // child：事件源 host，回调可据此区分实例。
      child: ElectronUtilityProcess,
      // event：workspace 维度计数载荷。
      event: {
        // workspacePath：计数所属工作区路径。
        workspacePath: string;
        // workspaceIdentity：远程 workspace 身份，与路径成对使用。
        workspaceIdentity?: string;
        // runningTaskCount：该 workspace 的正在运行任务数。
        runningTaskCount: number;
      },
    ) => void;
    // onAgentProcessExited：agent 退出事件，资源表注销后转发。
    onAgentProcessExited?: (event: HostAgentProcessExitedResponse) => void;
    // onAgentProcessError：agent 启动失败事件。
    onAgentProcessError?: (event: HostAgentProcessErrorResponse) => void;
    // onAgentProcessException：agent 运行时异常事件。
    onAgentProcessException?: (event: HostAgentProcessExceptionResponse) => void;
    // onAgentProcessReady：agent 就绪事件。
    onAgentProcessReady?: (event: HostAgentProcessReadyResponse) => void;
    // onAgentProcessSpawned：agent 进程已创建事件。
    onAgentProcessSpawned?: (event: HostAgentProcessSpawnedResponse) => void;
    // onMcpTelemetry：MCP 遥测批量上报。
    onMcpTelemetry?: (event: HostMcpTelemetryResponse) => void;
    // onPluginTelemetry：插件遥测批量上报。
    onPluginTelemetry?: (event: HostPluginTelemetryResponse) => void;
    // onSessionCreateTelemetry：会话创建遥测上报。
    onSessionCreateTelemetry?: (event: HostSessionCreateTelemetryResponse) => void;
    // onCuaOperationStateChanged：CUA 状态投影，Host 是唯一所有者。
    onCuaOperationStateChanged?: (
      // source：上报状态的 host 实例。
      source: ElectronUtilityProcess,
      // event：CuaOperationState 载荷。
      event: HostCuaOperationStateResponse,
    ) => void;
    // onCuaOperationStateSourceExited：host 退出时补发 inactive。
    onCuaOperationStateSourceExited?: (source: ElectronUtilityProcess) => void;
    /** host → main：定时任务派发结果，转交给 cron scheduler 结算调度状态机。 */
    onCronRunResult?: (result: {
      // runId：调度运行标识，scheduler 据此对账。
      runId: string;
      // ok：Host 判定的成败，Main 不重算。
      ok: boolean;
      // taskId：定时任务标识。
      taskId?: string;
      // sessionId：本次运行所属会话。
      sessionId?: string;
      // error：失败原因文本。
      error?: string;
      // failureKind：transient 或 permanent，决定是否重试。
      failureKind?: "transient" | "permanent";
    }) => void;
    /** host → main：闲时任务派发结果，转交给 scheduler 结算（与 cron 独立）。 */
    onOffPeakRunResult?: (result: {
      // offPeakTaskId：闲时任务标识。
      offPeakTaskId: string;
      // ok：Host 判定的成败。
      ok: boolean;
      // lifecycleManaged：scheduler 是否已接管会话生命周期。
      lifecycleManaged?: true;
      // conversationId：闲时任务绑定的会话标识。
      conversationId?: string;
      // sessionId：本次运行的会话标识。
      sessionId?: string;
      // error：失败原因文本。
      error?: string;
      // failureKind：区分瞬时与永久失败。
      failureKind?: "transient" | "permanent";
    }) => void;
    /** host 中 manual run 落库后请求 main 立即唤醒 scheduler。 */
    onCronSchedulerWakeRequested?: (automationId: string) => void;
    /** host 中闲时任务翻 schedulable 后请求 main 立即唤醒 scheduler。 */
    onOffPeakSchedulerWakeRequested?: (offPeakTaskId?: string) => void;
    // browser-use：main 用 WebContentsView+CDP 执行一条命令。实现由宿主注入；缺省则 backend_unavailable。
    handleBrowserExecuteRequest?: (params: {
      // win：browser-use 需要的 WebContentsView 宿主窗口。
      win: BrowserWindow;
      // requestId：回包时原样带回。
      requestId: string;
      // browserId：目标浏览器实例标识。
      browserId?: string;
      // browserGeneration：实例代次，防止复用旧视图。
      browserGeneration?: number;
      // sessionId：命令所属会话。
      sessionId: string;
      // turnId：命令所属轮次。
      turnId?: string;
      // workspaceKey：工作区键，优先于路径。
      workspaceKey?: string;
      // workspacePath：工作区路径。
      workspacePath?: string;
      // workspaceIdentity：远程 workspace 身份标识。
      workspaceIdentity?: string;
      // remoteSessionId：远控会话标识，本地为空。
      remoteSessionId?: string;
      // clientMode：desktop-continuous 或 web-remote-replayable。
      clientMode?: "desktop-continuous" | "web-remote-replayable";
      // sessionContext：live 或 cached，决定视图复用策略。
      sessionContext?: "live" | "cached";
      // command：browser 命令载荷，Main 不解析。
      command: unknown;
    }) => Promise<{ ok: boolean; [k: string]: unknown }>;
    /** Host 已完成附件授权后，由 Main 将本地视频 realpath 加入精确协议授权集合。 */
    authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
    /** Host 校验完插件 UI HTML 后交给 Main 沙箱注册表登记，返回句柄。 */
    registerPluginSandbox?: (
      // input：Host 已校验的插件 UI 注册载荷。
      input: PluginSandboxRegisterRequestPayload,
    ) => PluginSandboxHandle | Promise<PluginSandboxHandle>;
  },
  // options：端口附着、广播注册与实时路由的可选开关。
  options?: SpawnHostProcessOptions,
): ElectronUtilityProcess {
  // [契约] hostId 每次 fork 都新生成，是 Host 实例身份，不能由 workspace 派生。
  // [事务] 同一个 hostId 同时写进 InitLocal 与 taskRealtimeBus 注册，两边必须一致。
  // [并发] 复用 hostId 会让旧 host 的迟到消息被当成新实例，路由与租约判断全错。
  // [权衡] 用 UUID 而不是自增：跨窗口跨进程只能靠它去重。
  const hostId = randomUUID();
  // [资源] resolveBundledGlmBinaryPath 只做路径解析并打日志，不校验文件存在；缺失时由下游自行降级。
  // [失败路径] 解析失败返回 undefined，日志必须显式输出 <not found>，否则排查看不出缺失。
  // [权衡] 不用 process.cwd() 拼接：打包态 cwd 可能被启动器改掉。
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  // execArgv：debug 端口只在 RUNTIME_ZCODE_DEBUG 存在时注入。
  const execArgv = [
    ...(RUNTIME_ZCODE_DEBUG ? [`--inspect-brk=${RUNTIME_ZCODE_DEBUG}`] : []),
    "--no-warnings",
  ];
  // [资源] fork 之后 child 已在运行，后续任何一行抛错都会留下孤儿 host，因此初始化顺序敏感。
  // [契约] env 顺序：先基础环境，再 E2E 覆盖，最后写 ZCODE_PROCESS_LABEL。
  // [事务] ZCODE_PROCESS_LABEL 必须是最终值，后写覆盖先写，反了会让所有 host 同名。
  // [权衡] desktopContextPromptEnabled 用可选调用：Main 未裁决时不注入该 key，Host 走默认值。
  // [并发] 这里不要 await 任何东西，spawn 同步返回是窗口初始化的时序假设。
  const child = electronUtilityProcess.fork(hostModulePath, [], {
    // serviceName：资源面板展示名，由 label 统一格式化。
    serviceName: formatZCodeHostProcessName(label),
    execArgv,
    // env：基础环境、E2E 覆盖、平台补丁依次展开。
    env: {
      ...buildHostProcessEnv(dependencies.hostProcessLocalEnv),
      ...buildHostE2ECoverageEnv(),
      // ZCODE_PROCESS_LABEL 最后写入：必须覆盖前面所有同名 key。
      ZCODE_PROCESS_LABEL: label,
      // macOS-only: the Computer Use Helper launcher runs inside this forked host utilityProcess, whose
      // code-signing identity is a nested Electron helper (NOT dev.zcode.app). Publish THIS (main
      // Electron) process's pid — which IS dev.zcode.app — so helperLauncher passes it as
      // `--launcher-pid` and the Helper's signature/peer verification succeeds instead of
      // health-timing out. Env-name mirror of services' LAUNCHER_PID_ENV. Not set on
      // Windows/Linux (CUA is macOS-only; nothing reads it there) to keep the host env pristine.
      // [契约] 只在 darwin 注入 ZCODE_CUA_LAUNCHER_PID，且必须是 Main 的 pid 而不是 child.pid。
      // [失败路径] 改成 child.pid 后 Helper 签名校验失败，表现为健康检查超时。
      // [权衡] 其他平台不注入是为了保持 host env 最小，CUA 只在 macOS 可用。
      ...(process.platform === "darwin" ? { ZCODE_CUA_LAUNCHER_PID: String(process.pid) } : {}),
      ...(dependencies.desktopContextPromptEnabled
        // 可选分支：只有 Main 完成灰度裁决才注入该 key。
        ? {
            // key 名走共享常量，Host 侧读取同一个名字。
            [ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]: dependencies.desktopContextPromptEnabled()
              // 裁决结果转成 1 或 0，Host 只做字符串比较。
              ? "1"
              // 关闭态写 0，不能省略 key，否则 Host 走默认值。
              : "0",
          }
        // 未裁决：整体不注入，保持 host env 最小。
        : {}),
    },
  });

  // info：fork 后立刻记录 pid，后续日志都靠它对账。
  dependencies.logger.info(
    `[spawnHostProcess] forked host process for (${label}), pid=${child.pid}`,
  );
  // info：hostModulePath 是唯一模块入口，加载失败先看它。
  dependencies.logger.info(`[spawnHostProcess] host module path: ${hostModulePath}`);
  // info：glmBinaryPath 缺失时显式打 <not found>。
  dependencies.logger.info(`[spawnHostProcess] glm binary path: ${glmBinaryPath ?? "<not found>"}`);
  // info：BIGMODEL_OAUTH_APP_SECRET 来源三分支，便于定位注入问题。
  dependencies.logger.info(
    `[spawnHostProcess] BIGMODEL_OAUTH_APP_SECRET source: ${process.env.BIGMODEL_OAUTH_APP_SECRET ? "process" : dependencies.hostProcessLocalEnv.BIGMODEL_OAUTH_APP_SECRET ? "dotenv" : "fallback"}`,
  );

  // 远程连接与本地服务共享 window Host，进程级 stdout 没有请求身份。
  // 连接进度改由 HostResponseTypes.RemoteWorkspaceConnectionLog 按 requestId 上报。
  // [资源] stdout/stderr 在 fork 之后立刻接管，晚绑定会丢启动阶段日志。
  // [契约] 进程级 stdout 没有 requestId，远程连接日志必须走结构化 Log 响应。
  // [权衡] relay 负责按行切分与限流，不要在 message handler 里再解析原始文本。
  const hostLogRelay = createHostLogRelay(
    label,
    dependencies.logger as Parameters<typeof createHostLogRelay>[1],
  );

  // [资源] stdout 与 stderr 都要接，只接一个会丢掉崩溃栈。
  // [并发] 用 on 而不是 once：进程存活期间持续输出，once 会截断日志。
  // [失败路径] data 转字符串时不要假设 UTF-8 边界安全，交给 relay 做行缓冲。
  child.stderr?.on("data", (data: Buffer) => {
    // onStderr：原始 stderr 交给 relay 做行缓冲。
    hostLogRelay.onStderr(data.toString());
  });
  // stdout 同样要接：只接 stderr 会丢正常输出。
  child.stdout?.on("data", (data: Buffer) => {
    // onStdout：与 stderr 共用同一 relay，保证顺序。
    hostLogRelay.onStdout(data.toString());
  });

  // [事务] relay 必须先于 InitLocal 绑定：InitLocal 里要带 startupId。
  // [契约] startupId 由 relay 生成，只在这里取一次，后续 postMessage 复用同一个值。
  // [并发] 如果在 postMessage 之后再 bind，Host 回传的 DatabaseStartupState 会找不到 relay。
  // [失败路径] 窗口先销毁时 receive 必须静默丢弃，不能抛错打断 message 处理循环。
  const databaseStartupRelay = bindDatabaseStartupRelay(win, child, hostId);
  // [契约] 统一用 hostResponseMessageSchema 校验：未知或半截消息直接丢弃，不给下游猜类型。
  // [失败路径] 校验失败必须 return 而不是抛错，否则一条畸形消息会拆掉整个监听。
  // [并发] 每个分支处理完立即 return，避免同一消息被后续分支重复结算。
  // [权衡] 在 Main 侧再校验一次，不信任 Host 的 TypeScript 类型断言。
  child.on("message", (message: unknown) => {
    // safeParse：Main 侧再校验一次，不信任 Host 的类型断言。
    const result = hostResponseMessageSchema.safeParse(message);
    // safeParse 失败：丢弃整条消息，不猜类型。
    if (!result.success) {
      // return：畸形消息不能拆掉监听循环。
      return;
    }

    // [契约] 数据库启动态必须先交给 relay，不能落到通用 telemetry 分支。
    // [事务] relay.receive 内部推进启动状态机，这里不能改成 fire-and-forget。
    // [失败路径] 顺序调换会让 Main 先看到 ready 再看到 starting，窗口卡在启动遮罩。
    if (result.data.type === HostResponseTypes.DatabaseStartupState) {
      // receive：数据库启动态先推进状态机，再考虑其他分支。
      databaseStartupRelay.receive(result.data.state);
      // return：启动态分支独占处理。
      return;
    }

    // Log：结构化日志走 relay，与原始 stdout 分流。
    if (result.data.type === HostResponseTypes.Log) {
      // onStructuredLog：Host 主动上报的日志行。
      hostLogRelay.onStructuredLog(result.data);
      // return：日志分支结束。
      return;
    }

    // [契约] 网络观测与抓包是两个协议，不能合并成一个 ingest 调用。
    // [资源] 采样数据必须只做聚合上报，这里不缓存也不落盘。
    // [失败路径] ingest 抛错会中断后续消息处理，因此上游必须自行兜底。
    if (result.data.type === HostResponseTypes.NetworkTelemetryBatch) {
      // ingestHostNetworkObservations：网络观测批量交给遥测聚合。
      ingestHostNetworkObservations(result.data.observations);
      // return：网络观测分支结束。
      return;
    }
    // NetworkCaptureBatch：抓包批次走独立 ingest，不与观测合并。
    if (result.data.type === HostResponseTypes.NetworkCaptureBatch) {
      // ingestHostNetworkCapture：抓包批次附 host pid 便于归属。
      ingestHostNetworkCapture(result.data.batch, child.pid ?? 0);
      // return：抓包分支结束。
      return;
    }
    // [契约] runtimeSurface 与 environmentKey 原样透传，Main 不重新归类 lane。
    // [事务] 资源样本只是观测，不能反向影响 agent 生命周期。
    // CLI 自采的 60 秒样本：按 services 打的 lane 归入 cli_chat / cli_aux 角色。
    if (result.data.type === HostResponseTypes.AgentResourceSample) {
      // ingestCliResourceSample：CLI 自采样本按 lane 归入资源表。
      ingestCliResourceSample(
        result.data.sample,
        result.data.runtimeSurface,
        result.data.environmentKey,
      );
      // return：Agent 资源样本分支结束。
      return;
    }

    // Host 自采的 60 秒样本：main 只取 heap 作 host 角色事件的 heap 维度。
    if (result.data.type === HostResponseTypes.HostResourceSample) {
      // ingestHostSelfResourceSample：只取 heap 维度作 host 角色事件。
      ingestHostSelfResourceSample(result.data.sample);
      // return：Host 自采样分支结束。
      return;
    }

    // ResourceUsageSnapshotResult：采样快照结果回填等待方。
    if (result.data.type === HostResponseTypes.ResourceUsageSnapshotResult) {
      // resolveHostResourceUsageResult：把采样快照回填给等待方。
      resolveHostResourceUsageResult(label, result.data);
      // return：资源快照结果分支结束。
      return;
    }

    // ToolExecResource：工具执行资源样本，按 runtimeSurface 汇总。
    if (result.data.type === HostResponseTypes.ToolExecResource) {
      // ingestToolExecResource：工具执行资源按 runtimeSurface 汇总。
      ingestToolExecResource(result.data.sample, result.data.runtimeSurface);
      // return：工具资源分支结束。
      return;
    }

    // McpResourceSamples：MCP 资源样本，按 environmentKey 归类。
    if (result.data.type === HostResponseTypes.McpResourceSamples) {
      // ingestMcpResourceSamples：MCP 资源样本按 environmentKey 归类。
      ingestMcpResourceSamples(
        result.data.samples,
        result.data.runtimeSurface,
        result.data.environmentKey,
      );
      // return：MCP 资源分支结束。
      return;
    }

    // [契约] MCP、Plugin、SessionCreate 三类 telemetry 必须只转发给注入的回调。
    // [失败路径] 回调缺失时静默放弃，不能在 Main 侧补一份本地实现。
    // [权衡] 用可选调用而不是默认空函数，缺实现时不会静默，便于在日志里发现。
    if (result.data.type === HostResponseTypes.McpTelemetry) {
      // onMcpTelemetry：MCP 遥测只转发给注入回调。
      dependencies.onMcpTelemetry?.(result.data);
      // return：MCP 遥测分支结束。
      return;
    }

    // PluginTelemetry：插件遥测只转发给注入回调。
    if (result.data.type === HostResponseTypes.PluginTelemetry) {
      // onPluginTelemetry：插件遥测只转发给注入回调。
      dependencies.onPluginTelemetry?.(result.data);
      // return：插件遥测分支结束。
      return;
    }

    // SessionCreateTelemetry：会话创建遥测只转发。
    if (result.data.type === HostResponseTypes.SessionCreateTelemetry) {
      // onSessionCreateTelemetry：会话创建遥测只转发。
      dependencies.onSessionCreateTelemetry?.(result.data);
      // return：会话遥测分支结束。
      return;
    }

    // [契约] 授权结果必须带 requestId 回传，Host 靠它匹配等待中的预览请求。
    // [失败路径] authorize 缺失时也要回 ok:false，不能静默丢弃，否则 Host 永远挂起。
    // [资源] then 与 catch 两条路径都必须 postMessage，异步链路没有超时兜底。
    // [权衡] 用 void 包裹 Promise：message 监听不能阻塞，也不能把异常抛回 EventEmitter。
    if (result.data.type === HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest) {
      // request：带 requestId 与待授权 path。
      const request = result.data;
      // authorize：宿主注入的授权实现，缺失即回 ok:false。
      const authorize = dependencies.authorizeLocalMediaPreviewPath;
      // 未注入 authorize：必须回失败，不能让 Host 永久挂起。
      if (!authorize) {
        // postMessage：失败结果回 LocalMediaPreviewPathAuthorizeResult。
        child.postMessage({
          // type：Host 据此匹配等待中的预览请求。
          type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
          // requestId：原样回传。
          requestId: request.requestId,
          // ok 为 false：表示授权不可用。
          ok: false,
          // error：固定说明文本，不暴露内部细节。
          error: "Local media preview path authorization is unavailable.",
        });
        // return：缺失实现的分支到此结束。
        return;
      }
      // authorize：异步授权，成功路径走 then。
      void authorize(request.path)
        .then((path) => {
          // postMessage：成功时回 path。
          child.postMessage({
            // type：与失败路径同一个 LocalMediaPreviewPathAuthorizeResult。
            type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
            // requestId：成功路径同样要匹配原请求。
            requestId: request.requestId,
            // ok 为 true：Host 可放行该路径。
            ok: true,
            path,
          });
        })
        .catch((error) => {
          // postMessage：异常路径也要回包，否则 Host 挂起。
          child.postMessage({
            // type：失败包与成功包同型。
            type: HostMessageTypes.LocalMediaPreviewPathAuthorizeResult,
            // requestId：异常时同样回传。
            requestId: request.requestId,
            // ok 为 false：Host 据此放弃预览。
            ok: false,
            // error：异常文本，尽量保留原始 message。
            error: error instanceof Error ? error.message : String(error),
          });
        });
      // return：授权请求处理完毕。
      return;
    }

    // PluginSandboxRegisterRequest：插件 UI 沙箱注册请求。
    if (result.data.type === HostResponseTypes.PluginSandboxRegisterRequest) {
      // request：含 ownerWebContentsId 与 HTML 载荷。
      const request = result.data;
      // register：宿主注入的沙箱注册实现。
      const register = dependencies.registerPluginSandbox;
      // reply：统一回包函数，保证 type 与 requestId 一致。
      const reply = (payload: PluginSandboxRegisterResultPayload) =>
        // postMessage：结果展开 payload，成功带 handle 字段。
        child.postMessage({ type: HostMessageTypes.PluginSandboxRegisterResult, ...payload });
      // [契约] 插件沙箱只服务本窗口：ownerWebContentsId 必须等于当前 webContents。
      // [失败路径] 窗口销毁后不能再注册，否则句柄挂在已销毁的 WebContents 上。
      // [权衡] 三个条件用 || 合并成一次拒绝：对 Host 只回一个不可用错误，不区分原因。
      // [事务] 校验必须在 register 之前，注册成功就无法回滚。
      if (!register || win.isDestroyed() || request.ownerWebContentsId !== win.webContents.id) {
        // reply：任一校验失败都只回一个不可用错误。
        reply({
          // requestId：保证 Host 能对上注册请求。
          requestId: request.requestId,
          // ok 为 false：窗口销毁或 owner 不匹配。
          ok: false,
          // error：不区分具体原因，避免泄露窗口状态。
          error: "Plugin UI sandbox is unavailable.",
        });
        // return：拒绝分支结束。
        return;
      }
      // Promise.resolve 起链：注册异步执行，不阻塞 message 循环。
      void Promise.resolve()
        .then(() => register(request))
        .then((handle) => reply({ requestId: request.requestId, ok: true, ...handle }))
        .catch((error: unknown) =>
          // reply：注册抛错时回失败结果。
          reply({
            // requestId：失败包同样匹配原请求。
            requestId: request.requestId,
            // ok 为 false：沙箱未注册成功。
            ok: false,
            // error：异常文本透传给 Host。
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      // return：插件沙箱注册分支结束。
      return;
    }

    // [契约] Main 只投影 Host 已判定的 turn 状态，不在这里重新解析 session/tool 事件。
    // [事务] 投影失败也不能回写 Host：CUA 状态唯一所有者是 Host。
    // [失败路径] 监听器抛错会中断 message 循环，因此依赖方必须自行 catch。
    if (result.data.type === HostResponseTypes.CuaOperationState) {
      // Main 只投影 Host 已经判定的 turn 状态，不在这里重复解析 session/tool 业务事件。
      dependencies.onCuaOperationStateChanged?.(child, result.data);
      // return：CUA 状态只投影给回调，不进入后续分支。
      return;
    }

    // [资源] 归档在 Main 侧执行，Host 只等结果，大文件必须不经过 message 通道。
    // [契约] 成功回 path 与 size，失败回 error，两者都必须带 requestId。
    // [失败路径] 不 await 也不吞错：catch 里必须回 ok:false，否则反馈流程一直转圈。
    if (result.data.type === HostResponseTypes.FeedbackLogArchiveRequest) {
      // request：带 requestId，结果必须按它回传。
      const request = result.data;
      // createFeedbackLogArchiveFromExportLogs：归档在 Main 侧执行。
      void createFeedbackLogArchiveFromExportLogs(request.sourceDir)
        .then((archive) => {
          // postMessage：成功路径回 path 与 size。
          child.postMessage({
            // type：FeedbackLogArchiveResult，Host 据此匹配请求。
            type: HostMessageTypes.FeedbackLogArchiveResult,
            // requestId：原样回传，Host 靠它结束等待。
            requestId: request.requestId,
            // ok 为 true：表示归档文件已生成。
            ok: true,
            // path：归档文件绝对路径，Host 只读不建。
            path: archive.path,
            // size：字节数，供 Host 判断是否需要提示。
            size: archive.size,
          });
        })
        .catch((error) => {
          // postMessage：失败路径同样要回 requestId。
          child.postMessage({
            // type：与成功路径同一个 FeedbackLogArchiveResult。
            type: HostMessageTypes.FeedbackLogArchiveResult,
            // requestId：保证失败也能对上原请求。
            requestId: request.requestId,
            // ok 为 false：反馈流程据此终止转圈。
            ok: false,
            // error：异常文本，不做结构化包装。
            error: error instanceof Error ? error.message : String(error),
          });
        });
      // return：归档请求处理完毕，不进后续分支。
      return;
    }

    // [契约] 缺省实现必须回 backend_unavailable，让 Host 能区分「没实现」与「执行失败」。
    // [失败路径] handler 的 reject 要归一成 execution_error，不能把原始异常穿过 IPC。
    // [事务] requestId 先取出再异步执行，postMessage 时不能再读 result.data（可能已被复用）。
    // [权衡] 这里注入 win：browser-use 需要 WebContentsView，窗口引用只能由 Main 持有。
    if (result.data.type === HostResponseTypes.BrowserExecuteRequest) {
      // browser-use：main 用 WebContentsView+CDP 执行命令（handleBrowserExecuteRequest）。
      // 缺省实现时返回 backend_unavailable，保证通道打通但不阻塞。
      const requestId = result.data.requestId;
      // handler：宿主注入的 browser-use 执行器，缺省即 backend_unavailable。
      const handler = dependencies.handleBrowserExecuteRequest;
      // fallback：未注入 handler 时的固定失败结果。
      const fallback = {
        // ok 为 false：与执行失败区分开，由 code 判断原因。
        ok: false as const,
        // error：错误对象，含 code 与 message 两个字段。
        error: {
          // code 固定 backend_unavailable：表示能力未接入。
          code: "backend_unavailable",
          // message：给 Host 阅读的简短说明。
          message: "browser executor not ready",
        },
        // elapsedMs 为 0：没有真正执行，耗时为 0。
        elapsedMs: 0,
      };
      // void 包裹：message 监听不能等待异步结果。
      void (
        handler
          // handler 存在：请求字段逐个透传，不展开 result.data。
          ? handler({
              // win：browser-use 需要 WebContentsView，引用只能由 Main 提供。
              win,
              requestId,
              // browserId：目标浏览器实例标识。
              browserId: result.data.browserId,
              // browserGeneration：实例代次，防止复用到旧视图。
              browserGeneration: result.data.browserGeneration,
              // sessionId：命令所属会话。
              sessionId: result.data.sessionId,
              // turnId：命令所属轮次，可为空。
              turnId: result.data.turnId,
              // workspaceKey：工作区键，优先级高于 path。
              workspaceKey: result.data.workspaceKey,
              // workspacePath：工作区路径，远程时与 identity 成对。
              workspacePath: result.data.workspacePath,
              // workspaceIdentity：远程 workspace 身份标识。
              workspaceIdentity: result.data.workspaceIdentity,
              // remoteSessionId：远控会话标识，本地为空。
              remoteSessionId: result.data.remoteSessionId,
              // clientMode：desktop-continuous 或 web-remote-replayable。
              clientMode: result.data.clientMode,
              // sessionContext：live 或 cached，决定是否复用视图。
              sessionContext: result.data.sessionContext,
              // command：原样透传的 browser 命令载荷。
              command: result.data.command,
            }).catch((error: unknown) => ({
              // ok 为 false：执行抛错时统一归一成失败结果。
              ok: false as const,
              // error：错误对象，code 固定 execution_error。
              error: {
                // code 固定 execution_error：区别于 backend_unavailable。
                code: "execution_error",
                // message：异常文本，不把原始异常穿过 IPC。
                message: error instanceof Error ? error.message : String(error),
              },
              // elapsedMs 为 0：抛错路径不回报耗时。
              elapsedMs: 0,
            }))
          // 无 handler：直接 resolve fallback，通道仍然打通。
          : Promise.resolve(fallback)
      ).then((commandResult) => {
        // postMessage：把执行结果回传 Host。
        child.postMessage({
          // type：BrowserExecuteResult，Host 据此匹配 requestId。
          type: HostMessageTypes.BrowserExecuteResult,
          requestId,
          // result：成功或失败结果整体回传，不再拆字段。
          result: commandResult,
        });
      });
      // return：browser 命令分支结束。
      return;
    }

    // [资源] 注册与注销必须成对：Spawned 注册 pid，Exited 注销同一个 pid。
    // [契约] 注册用 Host 上报的 pid/command/args，不用 Main 侧推测值。
    // [事务] 先注册再通知依赖方，保证回调里查得到这条 agent 进程。
    // [失败路径] 漏注册会让退出清理找不到子进程，遗留孤儿 agent。
    if (result.data.type === HostResponseTypes.AgentProcessSpawned) {
      // registerHostAgentProcess：按 label 登记 agent 进程。
      registerHostAgentProcess(label, {
        // pid：Host 上报的子进程 pid，注销时用同一个值。
        pid: result.data.pid,
        // provider：agent 提供方标识，资源面板据此分组。
        provider: result.data.provider,
        // workspacePath：agent 所属工作区路径。
        workspacePath: result.data.workspacePath,
        // command：实际启动的可执行文件。
        command: result.data.command,
        // args：启动参数，原样记录便于排查。
        args: result.data.args,
        // startedAt：启动时间戳，用于存活时长统计。
        startedAt: result.data.startedAt,
      });
      // onAgentProcessSpawned：注册之后再通知依赖方。
      dependencies.onAgentProcessSpawned?.(result.data);
      // return：spawn 事件处理完毕。
      return;
    }

    // AgentProcessReady：agent 就绪事件只转发。
    if (result.data.type === HostResponseTypes.AgentProcessReady) {
      // onAgentProcessReady：就绪事件只转发，不改登记表。
      dependencies.onAgentProcessReady?.(result.data);
      // return：ready 事件处理完毕。
      return;
    }

    // [事务] 先 unregister 再回调：回调里重建 agent 时不能看到旧 pid。
    // [契约] 注销用 label 加 pid，不能用 child 代替，同一 host 可能托管多个 agent。
    // [失败路径] 顺序反了会让重试的 spawn 与旧 exited 竞争，计数短暂为负。
    if (result.data.type === HostResponseTypes.AgentProcessExited) {
      // unregisterHostAgentProcess：先注销再回调，回调看不到旧 pid。
      unregisterHostAgentProcess(label, result.data.pid);
      // onAgentProcessExited：通知依赖方做重试或清理。
      dependencies.onAgentProcessExited?.(result.data);
      // return：exited 事件处理完毕。
      return;
    }

    // AgentProcessError：agent 启动失败事件只转发。
    if (result.data.type === HostResponseTypes.AgentProcessError) {
      // onAgentProcessError：错误事件只转发，不在此重试。
      dependencies.onAgentProcessError?.(result.data);
      // return：error 事件处理完毕。
      return;
    }

    // AgentProcessException：agent 运行时异常事件只转发。
    if (result.data.type === HostResponseTypes.AgentProcessException) {
      // onAgentProcessException：异常事件只转发，不在此重试。
      dependencies.onAgentProcessException?.(result.data);
      // return：exception 事件处理完毕。
      return;
    }

    // [契约] 只做字段搬运，调度状态机归 cron scheduler 所有。
    // [事务] Main 不在这里重算 ok/failureKind，也不做重试决策。
    // [失败路径] 丢掉 failureKind 会让 scheduler 把永久失败当瞬时失败无限重试。
    // [权衡] 逐个字段显式转发而不是展开 result.data：协议字段可能多于 scheduler 契约。
    if (result.data.type === HostResponseTypes.CronRunResult) {
      // onCronRunResult：把 cron 结果原样交给 scheduler。
      dependencies.onCronRunResult?.({
        // runId：调度运行标识，scheduler 用它关联状态机。
        runId: result.data.runId,
        // ok：成败由 Host 判定，Main 不重算。
        ok: result.data.ok,
        // taskId：定时任务标识，可为空（一次性运行）。
        taskId: result.data.taskId,
        // sessionId：关联会话，失败结算时用于定位。
        sessionId: result.data.sessionId,
        // error：失败原因文本，直接透传。
        error: result.data.error,
        // failureKind：区分 transient 与 permanent，决定是否重试。
        failureKind: result.data.failureKind,
      });
      // return：Cron 结果只走这一条分支。
      return;
    }

    // [契约] 闲时任务与 cron 是两套独立结算，不能合并到同一个回调。
    // [事务] lifecycleManaged 必须原样透传：它决定 scheduler 是否接管会话生命周期。
    // [失败路径] 漏传 lifecycleManaged 会让已接管的任务被再次调度。
    if (result.data.type === HostResponseTypes.OffPeakRunResult) {
      // onOffPeakRunResult：闲时任务结果，与 cron 独立结算。
      dependencies.onOffPeakRunResult?.({
        // offPeakTaskId：闲时任务标识，对应 off-peak 调度表。
        offPeakTaskId: result.data.offPeakTaskId,
        // ok：成败由 Host 判定，Main 只搬运。
        ok: result.data.ok,
        // lifecycleManaged：决定 scheduler 是否接管会话生命周期。
        lifecycleManaged: result.data.lifecycleManaged,
        // conversationId：闲时任务绑定的会话标识。
        conversationId: result.data.conversationId,
        // sessionId：本次运行产生的会话，可为空。
        sessionId: result.data.sessionId,
        // error：失败原因文本，直接透传。
        error: result.data.error,
        // failureKind：永久失败不能被当成瞬时失败重试。
        failureKind: result.data.failureKind,
      });
      // return：OffPeak 结果只走这一条分支。
      return;
    }

    // [契约] wake 请求只唤醒 scheduler，不在 Main 直接派发任务。
    // [并发] 唤醒与结果回传可能交叉，scheduler 必须按 automationId 幂等。
    if (result.data.type === HostResponseTypes.CronSchedulerWakeRequest) {
      // onCronSchedulerWakeRequested：只唤醒 scheduler，不直接派发。
      dependencies.onCronSchedulerWakeRequested?.(result.data.automationId);
      // return：唤醒请求处理完毕。
      return;
    }

    // OffPeakSchedulerWakeRequest：闲时调度唤醒，按任务标识幂等。
    if (result.data.type === HostResponseTypes.OffPeakSchedulerWakeRequest) {
      // onOffPeakSchedulerWakeRequested：按任务标识幂等唤醒。
      dependencies.onOffPeakSchedulerWakeRequested?.(result.data.offPeakTaskId);
      // return：唤醒请求处理完毕。
      return;
    }

    // [事务] 计数为 0 时必须 delete，不能写入 0：退出流程以「是否存在 key」判断忙碌。
    // [契约] 这个 map 只服务退出确认，不是 UI 的 running 数量来源。
    // [失败路径] 保留 0 会让 app-quit 永远等待一个不存在的任务。
    // [并发] set 与 delete 都是同步的，中间不能插入 await。
    if (result.data.type === HostResponseTypes.AgentRunningTaskCountChanged) {
      // 计数大于 0 才登记，0 必须走 delete 分支。
      if (result.data.runningTaskCount > 0) {
        // set：退出确认据此判断 host 是否仍在跑任务。
        dependencies.hostRunningTaskCountMap.set(child, result.data.runningTaskCount);
      } else {
        // delete：保留 0 会让 app-quit 永远等待不存在的任务。
        dependencies.hostRunningTaskCountMap.delete(child);
      }
      // info：计数变化写日志，退出排查时对照。
      dependencies.logger.info(
        `[app-quit] host running agent sessions updated (${label}) count=${result.data.runningTaskCount}`,
      );
      // return：计数消息不再落入后续分支。
      return;
    }

    // [契约] 按 workspace 维度的计数只透传给依赖方，Main 不自己聚合。
    // [事务] workspacePath 与 workspaceIdentity 必须成对透传，不能只按路径匹配。
    // [失败路径] 丢掉 workspaceIdentity 会让远程 workspace 的计数串到本地同名路径。
    // [权衡] 这里用 child 作为事件源，回调可据此区分是哪个 host 上报的。
    if (result.data.type === HostResponseTypes.WorkspaceRunningTaskCountChanged) {
      // onWorkspaceRunningTaskCountChanged：按 workspace 维度透传。
      dependencies.onWorkspaceRunningTaskCountChanged?.(child, {
        // workspacePath：本地或远程 workspace 路径。
        workspacePath: result.data.workspacePath,
        // workspaceIdentity：与路径成对，远程路径不能串到本地同名目录。
        workspaceIdentity: result.data.workspaceIdentity,
        // runningTaskCount：该 workspace 的正在运行任务数。
        runningTaskCount: result.data.runningTaskCount,
      });
      // return：workspace 计数不再落入后续分支。
      return;
    }
  });

  // [契约] 是否挂 taskRealtime 由调用方一次决定，后续所有分支都读这个布尔值。
  // [事务] hostInitMessage 必须在 fork 之后、任何 postMessage 之前构造完成。
  // [并发] 不要再重读 options.taskRealtime：中途变化会让 hostId 与 deliveryKind 不一致。
  const shouldAttachRealtimeHost = options?.taskRealtime != null;
  // hostInitMessage：把 databaseStartupId 与实时路由字段合进一条 InitLocal。
  const hostInitMessage: HostInitMessage = shouldAttachRealtimeHost
    // 挂 realtime：额外带 hostId 与 deliveryKind。
    ? {
        ...initMessage,
        // databaseStartupId：必须来自 relay，不能在别处生成。
        databaseStartupId: databaseStartupRelay.startupId,
        hostId,
        // deliveryKind：透传调用方指定的投递语义。
        deliveryKind: options?.taskRealtime?.deliveryKind,
      }
    // 不挂 realtime：只补 startupId，其余沿用 initMessage。
    : { ...initMessage, databaseStartupId: databaseStartupRelay.startupId };

  // [契约] attachInitialServicePort 为 false 时不建 MessagePort，只发 InitLocal（共享 SSH/WSL host）。
  // [事务] MessageChannelMain 的 port2 必须随 InitLocal 一起 postMessage，不能分两次发。
  // [资源] port1 只交给一个接收方：onPortReady 或 renderer，二者互斥。
  if (options?.attachInitialServicePort === false) {
    // 不建 MessageChannel：共享 SSH/WSL host 复用已有端口。
    child.postMessage(hostInitMessage);
  } else {
    // MessageChannelMain：port1 留 Main，port2 转给 Host。
    const { port1, port2 } = new MessageChannelMain();
    // transfer port2：必须与 InitLocal 同一次 postMessage。
    child.postMessage(hostInitMessage, [port2]);

    // onPortReady：调用方自接管 port1，与 renderer 投递互斥。
    if (options?.onPortReady) {
      // port1 交给回调，后续转发目标由它决定。
      options.onPortReady(port1);
    } else {
      // webContents.postMessage：默认把 port1 交给 renderer 侧。
      win.webContents.postMessage(
        options?.internalChannel ?? InternalChannels.ServicePort,
        options?.internalChannel === InternalChannels.ScopedServicePort
          // ScopedServicePort：payload 原样透传，不做包装。
          ? (options.internalPayload ?? null)
          // ServicePort：附 startupId，renderer 据此对上启动事务。
          : { databaseStartupId: databaseStartupRelay.startupId },
        [port1],
      );
    }
  }

  // [契约] 广播注册用 webContents.id 而不是 win.id，renderer 侧按 webContents 识别。
  // [事务] 先把 windowId 存下来：exit 时 win 可能已销毁，读不到 id。
  // [失败路径] 在 exit 回调里重新读 win.webContents.id 会抛 Object has been destroyed。
  const windowId = win.webContents.id;
  // [契约] 默认注册广播；只有明确传 false 的临时 host 才跳过。
  // [事务] 这个布尔值被 exit 回调复用，必须在注册前求值一次。
  // [失败路径] 在 exit 里重算 options 会与注册时不一致，导致注销漏项。
  const shouldRegisterBroadcast = options?.registerBroadcast ?? true;
  // shouldRegisterBroadcast：临时 host 可传 false 跳过注册。
  if (shouldRegisterBroadcast) {
    // register：按 windowId 绑定 child，广播从这里下发。
    dependencies.broadcastHub.register(windowId, child);
  }

  // [事务] 实时路由只注册一次，key 是 hostId；重复注册会覆盖 workspaceKeys 而不报错。
  // [契约] workspaceKeys 是调用方快照，这里不再合并或去重。
  // [失败路径] 没有 taskRealtimeBus 时静默跳过，不能在 host 已启动后补注册。
  if (shouldAttachRealtimeHost && dependencies.taskRealtimeBus && options?.taskRealtime) {
    // taskRealtimeBus.registerHost：key 是 hostId，重复注册会覆盖。
    dependencies.taskRealtimeBus.registerHost({
      // hostId：与 InitLocal 中同一个值，两端必须一致。
      hostId,
      // windowId 用 win.id：实时路由按窗口归属，不是 webContents。
      windowId: win.id,
      child,
      // workspaceKeys：调用方快照，这里不再合并或去重。
      workspaceKeys: options.taskRealtime.workspaceKeys,
      // deliveryKind：与 InitLocal 保持一致。
      deliveryKind: options.taskRealtime.deliveryKind,
    });
    // onHostId：把新 hostId 回传给调用方做后续绑定。
    options.taskRealtime.onHostId?.(hostId);
  }

  // [资源] 这里是 host 进入资源采样表的唯一入口，必须在返回 child 之前调用。
  // [契约] 与 exit 里的 unregisterHostProcess 成对，label 必须同一个。
  // [失败路径] 漏注册只影响资源面板，不影响消息通道，所以很难被发现。
  registerHostProcess(label, child);

  // [资源] exit 清理顺序不能改：先标记 exited，再通知 CUA，再 flush 日志。
  // [事务] onCuaOperationStateSourceExited 必须在注销之前，它还要按 child 查状态。
  // [契约] flushRawLogs 放在通知之后、注销之前，保证最后一行 stderr 不丢。
  // [失败路径] unregisterHostProcess 按 label 全局注销，提前执行会误删同 label 的新 host。
  // [并发] exit 可能重入（dispose 也监听 exit），所有清理都必须幂等。
  child.on("exit", (code) => {
    // exitedHostProcesses 先标记：disposeHostProcessAndWait 直接短路。
    exitedHostProcesses.add(child);
    // Host exit 是 fail-hidden 权威边界；不能依赖即将退出的 Host 再补发 inactive。
    dependencies.onCuaOperationStateSourceExited?.(child);
    // flushRawLogs：注销前必须把最后一行 stderr 刷出去。
    hostLogRelay.flushRawLogs();
    // info：exit code 记入日志，便于对照强杀路径。
    dependencies.logger.info(`[spawnHostProcess] host process (${label}) exited with code ${code}`);
    // hostRunningTaskCountMap 删除：0 与不存在语义不同，退出流程按存在性判断。
    dependencies.hostRunningTaskCountMap.delete(child);
    // 只有注册过广播的 host 才需要注销。
    if (shouldRegisterBroadcast) {
      // unregister：按 windowId 解绑，避免旧 host 继续收广播。
      dependencies.broadcastHub.unregister(windowId);
    }
    // unregisterHostProcess：按 label 从资源采样表移除。
    unregisterHostProcess(label);
    // 反向扫窗口映射表，摘掉指向该 child 的条目。
    for (const [wcId, process] of dependencies.windowHostProcessMap) {
      // 命中同一个 child 才删除，同窗口可能已换成新 host。
      if (process === child) {
        // delete windowHostProcessMap：关闭裁决不再等待这个 host。
        dependencies.windowHostProcessMap.delete(wcId);
        // break：一个 child 只对应一个 windowId。
        break;
      }
    }
  });

  // 返回 child：调用方持句柄用于后续 dispose 与消息发送。
  return child;
}

// [契约] dispose 是「请求优雅退出加强杀」，不等 exit；等 exit 的是 disposeHostProcessAndWait。
// [资源] disposingHostProcessTimers 由调用方持有，保证跨调用看到同一个 timer。
// [失败路径] postMessage Dispose 失败只 warn 不抛：进程可能已死，仍要继续安排强杀。
// [权衡] forceKillDelayMs 默认 300ms，但会被内部抬到 3.5s，见下方原因。
export function disposeHostProcess(
  // child：要优雅退出的 host utilityProcess。
  child: ElectronUtilityProcess,
  // label：日志与资源表使用的 host 逻辑名。
  label: string,
  // disposingHostProcessTimers：调用方持有的 timer 表，跨调用共用。
  disposingHostProcessTimers: WeakMap<ElectronUtilityProcess, ReturnType<typeof setTimeout>>,
  // logger：Dispose 与强杀失败的告警出口。
  logger: {
    // info：开始 dispose 时打印 pid。
    info: (...args: unknown[]) => void;
    // warn：postMessage 或 kill 失败只告警，不抛出。
    warn: (...args: unknown[]) => void;
  },
  forceKillDelayMs = 300,
) {
  // [事务] 已有 timer 说明正在 dispose，直接返回保证幂等。
  // [并发] 与 disposingHostProcesses.add 配合：先查后加，避免重复定时器。
  // [失败路径] 去掉这个判断会创建第二个 timer，先到的那个提前强杀 host。
  if (disposingHostProcessTimers.has(child)) {
    // 已有 timer：同一 child 正在 dispose，直接返回保证幂等。
    return;
  }
  // disposingHostProcesses：供退出流程枚举，与 timer 表分工不同。
  disposingHostProcesses.add(child);

  // info：记录 label 与 pid，便于对照 exit 日志。
  logger.info(
    `[disposeHostProcess] disposing host process (${label}), pid=${child.pid ?? "unknown"}`,
  );

  try {
    // postMessage Dispose：只请求优雅退出，不等待 exit。
    child.postMessage({ type: HostMessageTypes.Dispose });
  } catch (error) {
    // warn：进程可能已死，失败后仍要继续安排强杀。
    logger.warn(`[disposeHostProcess] failed to post dispose to (${label}):`, error);
  }

  // host 收到 Dispose 后需要等待 agent 进程树的 SIGTERM/SIGKILL 兜底完成。
  // 如果 main 仍按 150/300ms 强杀 host，host 会先退出，zcode-cli/app-server 子进程就可能被 init 接管成孤儿。
  // [资源] 下限 3.5s 是留给 host 杀 agent 进程树的时间窗，不能按调用方参数缩短。
  // [失败路径] 缩短后 host 先死，zcode-cli/app-server 被 init 接管成孤儿进程。
  // [事务] 下限字面量必须与 Host 侧 SIGTERM/SIGKILL 预算对齐，改一处要改两处。
  const effectiveForceKillDelayMs = Math.max(forceKillDelayMs, 3_500);
  // setTimeout：effectiveForceKillDelayMs 到期仍未退出就强杀。
  const killTimer = setTimeout(() => {
    // 先删 timer 再 kill，kill 抛错时表里也不留失效句柄。
    disposingHostProcessTimers.delete(child);
    try {
      // child.kill：兜底 host 未响应 Dispose 的情况。
      child.kill();
    } catch (error) {
      // warn：kill 失败通常表示进程已退出，不中断清理。
      logger.warn(`[disposeHostProcess] failed to kill host process (${label}):`, error);
    }
  }, effectiveForceKillDelayMs);

  // set：登记 timer，幂等判断靠它，必须在 exit 监听之前。
  disposingHostProcessTimers.set(child, killTimer);
  // [资源] once 而不是 on：exit 只处理一次，重复监听会让 timer 被多次 clear。
  // [事务] exit 里同时清 timer 与 disposing 集合，三者必须同一处清理。
  // [失败路径] 只 clearTimeout 不删 map entry，后续 dispose 会被误判为正在处理。
  child.once("exit", () => {
    // exitedHostProcesses：exit 已发生，disposeHostProcessAndWait 据此短路。
    exitedHostProcesses.add(child);
    // disposingHostProcesses 移除：后续枚举不再包含该 child。
    disposingHostProcesses.delete(child);
    // clearTimeout：正常退出后不再触发强杀。
    clearTimeout(killTimer);
    // timer 表同步删除，避免后续 dispose 被误判为进行中。
    disposingHostProcessTimers.delete(child);
  });
}
// [契约] 返回 Promise 以便 before-quit 串行等待所有 host 退出。
// [资源] 内部复用 disposeHostProcess，不另起一套强杀逻辑。
// [失败路径] 超时也必须 resolve：退出流程不能被一个卡死的 host 永久阻塞。
export function disposeHostProcessAndWait(
  // child：待等待退出的 host utilityProcess 句柄。
  child: ElectronUtilityProcess,
  // label：host 逻辑名，只用于日志与资源表定位。
  label: string,
  // disposingHostProcessTimers：与 disposeHostProcess 共享的强杀 timer 表。
  disposingHostProcessTimers: WeakMap<ElectronUtilityProcess, ReturnType<typeof setTimeout>>,
  // logger：退出等待的告警出口，超时必须可见。
  logger: {
    // info：退出流程内的常规进度日志。
    info: (...args: unknown[]) => void;
    // warn：等待超时与强杀异常走 warn。
    warn: (...args: unknown[]) => void;
  },
  // options：强杀延迟与等待超时，均可省略。
  options: {
    // forceKillDelayMs：透传给 disposeHostProcess，仍受 3.5s 下限约束。
    forceKillDelayMs?: number;
    // waitTimeoutMs：0 表示不设超时，由调用方显式开启。
    waitTimeoutMs?: number;
  } = {},
): Promise<void> {
  // Electron UtilityProcess 不是 Node ChildProcess，没有 exitCode 字段。
  // 右键 Dock 退出会走 before-quit -> disposeHostProcessAndWait；旧判断把运行中的 host
  // 的 undefined exitCode 当成“已退出”。这里改为记录 exit 事件，避免第一次退出漏发 Dispose。
  // [契约] 用 exitedHostProcesses 判断存活，不能读 exitCode（UtilityProcess 没有该字段）。
  // [失败路径] 旧写法把 undefined exitCode 当成已退出，导致第一次退出漏发 Dispose。
  // [事务] 该标记只在 exit 回调里写入，任何提前 add 都会让 dispose 被跳过。
  if (exitedHostProcesses.has(child)) {
    // 已退出：返回完成的 Promise，不重复发 Dispose。
    return Promise.resolve();
  }

  // waitTimeoutMs 归一：负数在 setTimeout 里等同立即触发。
  const waitTimeoutMs = Math.max(options.waitTimeoutMs ?? 0, 0);

  // Promise：exit 与超时两条路径都 resolve，不 reject。
  return new Promise((resolve) => {
    // settled：唯一门闩，保证 resolve 只发生一次。
    let settled = false;
    // waitTimeout：超时句柄，settle 时需要 clearTimeout。
    let waitTimeout: ReturnType<typeof setTimeout> | null = null;

    // settle：清 timer 并 resolve，可重入。
    const settle = () => {
      // settled 为 true：重复调用直接返回，不影响首次结果。
      if (settled) {
        // return：提前结束，防止二次 resolve。
        return;
      }
      // settled 先置 true，再清 timer，重入时不会重复清理。
      settled = true;
      // waitTimeout 存在才清理，null 分支跳过。
      if (waitTimeout) {
        // clearTimeout：防止超时回调在 exit 之后才触发。
        clearTimeout(waitTimeout);
        // waitTimeout 置 null：结算后不再持有句柄。
        waitTimeout = null;
      }
      // resolve：before-quit 据此继续等待下一个 host。
      resolve();
    };

    // once exit：只等一次，重复监听会让 settle 被多次调用。
    child.once("exit", () => {
      // exitedHostProcesses 先标记，后续调用可直接短路。
      exitedHostProcesses.add(child);
      // settle：exit 到达即结束等待。
      settle();
    });

    // [契约] waitTimeoutMs 默认 0 表示不设超时，由调用方显式开启。
    // [资源] timer 必须 unref，否则一个待退出的 host 会拖住整个事件循环。
    // [事务] settle 里清 timer 加 resolve 只执行一次，settled 标志是唯一门闩。
    // [失败路径] 超时只 warn 不 reject：退出流程要继续，不能让调用方误以为 host 已死。
    if (waitTimeoutMs > 0) {
      // setTimeout：仅在 waitTimeoutMs 大于 0 时创建。
      waitTimeout = setTimeout(() => {
        // warn：超时属异常路径，必须留下 label 与 pid。
        logger.warn(
          `[disposeHostProcessAndWait] host process exit wait timed out (${label}), pid=${child.pid ?? "unknown"}`,
        );
        // settle：超时也 resolve，退出流程不能被卡死的 host 阻塞。
        settle();
      }, waitTimeoutMs);
      // unref：待退出的 host 不能拖住事件循环。
      waitTimeout.unref?.();
    }

    // disposeHostProcess：复用同一套 Dispose 加 3.5s 强杀逻辑。
    disposeHostProcess(child, label, disposingHostProcessTimers, logger, options.forceKillDelayMs);
  });
}
