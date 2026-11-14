import { normalizeRemoteConnectionError, sanitizeRemoteConnectionLog } from "@zcode/shared";
/* eslint-disable max-lines -- Host 入口集中编排 local/remote service wiring，本次退出保护需要在同一处桥接 host 上报。 */
/* eslint-disable max-lines -- host process 入口集中维护 local/remote 初始化和资源回收，realtime bridge 接入后先保持同文件收口。 */
/**
 * ============================================================================
 * desktop/host/index.ts —— Window Host 进程入口
 * ============================================================================
 *
 * 【定位】每个 BrowserWindow 对应一个独立 utilityProcess（Window Host）。
 * 它是该窗口所有业务状态的唯一所有者：
 *   Renderer / Mobile ← MessagePort attachment → Window Host
 *      ├─ local services（按 workspaceKey 选择/启动本地 zcode-cli）
 *      ├─ RemoteConnectionRegistry（SSH/WSL/Docker/Server 连接与 logical session）
 *      ├─ ControllerProjection（workspace/task 列表事实）
 *      └─ AttachmentRegistry（desktop-continuous / web-remote-replayable）
 *
 * 【Main 与 Host 的分工】
 *   Main 只做平台调度：窗口生命周期、native dialog、OAuth callback、
 *   utilityProcess.fork 与 MessagePort 薄转发。Main 不持有 conversation、
 *   queue、snapshot、projection、remoteSessionId 或连接池。
 *
 * 【启动流程】
 *   1) Main 通过 `utilityProcess.fork()` 创建本进程；
 *   2) Main 只发送一次 init-local 初始化窗口 Host；
 *   3) 后续 remote connect / scoped attachment 都由同一 Host 处理。
 *
 * 【释放语义（改这里之前先确认）】
 *   - 真实窗口关闭 / app quit / update install 只等待该窗口唯一 Host；
 *   - Host 内部对 attachment、远端 registry 和本地 services 做有界释放；
 *   - 手机关 attachment 只释放该 attachment，不进入 Host shutdown 屏障；
 *   - 关闭一个 attachment 不能销毁仍有其他 owner 的 connection。
 *
 * 【为什么文件很大也不要拆】local/remote service wiring、退出保护、
 * realtime bridge 与资源回收共享同一组生命周期状态；机械拆分会把
 * "谁先释放"的时序散到多个文件里，反而更容易出现半关闭状态。
 *
 * 【#18（attachment clientMode / seq / dispose）在本文件的落点】
 *   - exposeServicesOnMessagePort 是 attachment 的物理入口：clientMode 随 attachment 透传到
 *     服务装配与各 scope 适配（replayable 的服务面由 windowHostAttachmentRpcPolicy 收紧），
 *     并在 port close 时只 dispose 本 attachment 的 handle，不触发 Host shutdown；
 *   - createWindowRemoteConnectionHandle 把 registry 的「当前代际」句柄包装成可多次订阅的
 *     handle，close/reconnect 事件按对象身份转发，旧代际的迟到事件不会写入新句柄；
 *   - disposeAttachedServicePorts / disposeHostResources 是两层释放：前者只摘附件，
 *     后者才是窗口 Host 退出屏障（先停新 attach 再逐个有界释放）。
 * ============================================================================
 */
// ============================================================================
// INV 不变量表：本文件是 Window Host 进程入口，下列断言只在「一个窗口 = 一个 Host 进程」
// 这个前提下成立。改任何分支前，先按编号确认它守的是哪条，以及反过来写会破坏什么。
// 引用方式：INV-05 之类只在本文件内有效；跨文件的不变量在 <阅读大纲> 第 12.4 节有汇总。
// ============================================================================
// INV-01：一个 BrowserWindow 只对应一个 Host，InitLocal 只允许真正初始化一次（守住它的位置：parentPort 处理里的 databaseStartup 非空分支）。
//   第二次 InitLocal 必须只 publish 已有启动状态并关闭新端口；若重建 services，旧 attachment 会指向已废弃的服务实例，请求静默打到孤儿对象上。
// INV-02：activeServices 是本地服务集合的唯一所有者句柄，非 null 期间禁止再次 createLocalServices（守住它的位置：initializeServices 与 disposeHostResources）。
//   两份 services 会各自持有 sqlite 句柄与 Agent 子进程，进程退出时只有一份被回收，另一份变成僵尸。
// INV-03：attachment 能看到什么由 clientMode 决定；web-remote-replayable 永远拿不到 desktop-continuous 的完整服务面（守住它的位置：exposeServicesOnMessagePort 的 overrides 构造）。
//   反向放开会让手机端获得只有桌面可信进程才该有的写能力（例如 Source settings 附件、本地 unread 回写）。
// INV-04：关闭 attachment 只能释放该 attachment 自己的 handle，不能销毁仍被其他 owner 引用的 connection（守住它的位置：ExposedServicePortHandle.dispose、connection.dispose 的空实现）。
//   这条是「关一个 tab 不断整条 SSH」的实现基础；改成顺手 disconnect 会误杀同连接的另一个窗口或手机端。
// INV-05：logical session 换代后，旧 generation 的 attachment 必须先 detach 再允许新 attachment attach（守住它的位置：detachStaleRemoteSessionAttachments 与 waitForScopedServices 调用点）。
//   否则旧端口会把请求写进新一代 runtime，表现为「切 workspace 后写到了上一个项目」。
// INV-06：远程身份找不到目标 Host 时必须失败，禁止回落到本地 services（守住它的位置：resolveAutomationTargetServices、resolveSource 的 remote 分支）。
//   回落会让远程 workspace 的定时任务用本机模型与本地 Registry 执行，结果写进错误的数据库。
// INV-07：workspaceIdentity 管身份与隔离，workspacePath 管执行与文件操作，二者不可互相替代（守住它的位置：所有 resolveWorkspaceKey / buildRemoteWorkspaceIdentity 调用）。
//   只按路径匹配会把 SSH 与本地同名目录当成同一个 workspace，权限与缓存全部串味。
// INV-08：每个带 requestId 的 parentPort 请求必须恰好 settle 一次（成功或失败各一次），不允许既不发回执也不抛（守住它的位置：PrepareProjectWorkspace 与 BindRemoteWorkspaceContext 的 then/catch）。
//   少发一次回执，Main 侧只能等超时，UI 上表现为「点了没反应且不报错」。
// INV-09：pending 类集合在失败路径必须先 delete 再 reject，且成功路径也只 delete 一次（守住它的位置：authorizeLocalMediaPreviewPath、createFullFeedbackLogArchiveViaMain、pendingStartupAttachments）。
//   漏删会让 Promise 永久悬挂并持有 renderer 的闭包；重复 delete 本身无害，但漏 delete 会随窗口存活一直累积。
// INV-10：databaseStartup 未 ready 时不得派发 cron/off-peak，也不得直接 attach local scope（守住它的位置：CronRun/OffPeakRun 的就绪检查与 pendingStartupAttachments 缓存）。
//   local services 内部的 sqlite 还没建表，提前派发会以「表不存在」失败并被调度器当成业务失败计入退避。
// INV-11：disposeHostResources 是唯一的异步收口，且必须幂等；重复调用共享同一个 in-flight Promise（守住它的位置：disposeHostResourcesInFlight 与 hasDisposedHostResources）。
//   若每次调用都重新跑一遍阶段，第二次会对着已置 null 的 registry 释放，抛出与真实退出原因无关的噪音错误。
// INV-12：释放顺序固定为远端 registry → Source manager → 本地 services（守住它的位置：runHostShutdownPhases 的数组顺序）。
//   反过来先释放本地 services，远端 facade 的释放会回调已经不存在的 task service，并把失败误记到 exitCode 上。
// INV-13：applicationLocale 只认 Main 的 InitLocal 初值与 locale 变更消息，不读进程 Intl 或 setting.json（守住它的位置：parentPort 消息处理最前面的同步赋值）。
//   进程 locale 在 Dock 启动时可能缺失，setting.json 写入可能滞后；用它们会发出错误语言的 X-Client-Language。
// INV-14：applicationLocale 的赋值必须发生在任何 await 之前（守住它的位置：InitLocal 分支的同步 if）。
//   一旦落到 await 之后，后到的变更消息可能先被处理，旧初值会覆盖新语言，直到下一次变更才恢复。
// INV-15：每次远程连接都必须经 requireActiveHostApiNetworkTransport 取 fetch（守住它的位置：connectServerRemote 与 resolveSourceServerReleaseAsset 的调用）。
//   回退到全局 fetch 会绕过设置页代理与自签 CA，企业网络下表现为「本机能连、应用连不上」。
// INV-16：Source 物理连接的所有权在 SourceServerConnectionManager，Window registry handle 只是 lease（守住它的位置：wrapper 的 dispose 空实现与 manager 的显式断开路径）。
//   lease 被当成 owner 时，任意一个 tab 关闭都会拆掉其他 tab 正在共享的 Source。
// INV-17：同一个 Source 重连换代时，services 必须整体替换并重新挂资源遥测（守住它的位置：onDidReconnect 里的 refreshResourceTelemetry）。
//   只换 connection 不换 telemetry，重连后样本会静默丢失，直到下次重启才恢复。
// INV-18：close 通知对同一个 handle 只能发一次语义有效事件；retrying 的代际用 lastNotifiedRecoveryAttempt 去重（守住它的位置：manager.onDidChangeState 回调）。
//   不去重会让 UI 每轮退避都弹一次「连接已断开」，把一次故障渲染成 N 次。
// INV-19：pendingStartupAttachments 里的 attach 闭包只在 ready 时消费一次，之后必须 clear（守住它的位置：publish 回调的 ready 分支）。
//   保留闭包会让每个刷新过页面的 renderer 都被重新 attach，端口重复注册后请求被广播多份。
// INV-20：cron 与 off-peak 各自有独立的 repo、订阅表和终态写回，不得互相复用（守住它的位置：cronRunSubscriptions / offPeakRunSubscriptions 与两个 Repo 实例）。
//   复用会把「闲时任务已取消」误写成「定时任务失败」，两张表的状态机语义不同。
// INV-21：off-peak 终态写回是幂等的；markTerminal 返回 false 时必须丢弃而不是重试（守住它的位置：finalizeOffPeakRun 的 !updated 分支）。
//   迟到回写覆盖用户主动取消的状态，会把已取消任务重新标成 completed。
// INV-22：off-peak 派发必须先 markRunning 再唤醒 CLI（守住它的位置：residentExecutions.deliverTicket 之前的 markRunning 调用）。
//   反过来，CLI 立即 requeue 产生的迟到确认会覆盖 running，任务在 UI 上永远停在排队。
// INV-23：续票派发失败只允许 requeueForContinuation，绝不能重新发送初始 prompt（守住它的位置：dispatchOffPeakRun 的 catch）。
//   重发初始 prompt 会让模型把已完成的工作从头再做一遍，并产生第二份副作用。
// INV-24：闲时 turn 必须隐藏 CronCreate 与 OffPeakCreate（守住它的位置：sendPrompt 的 toolDenylist）。
//   放开后后台模型能自我复制出新的持久化定时任务，用户会在无交互的情况下获得不断增长的调度队列。
// INV-25：cron run 的模型选择在首次派发时固定（fixRunModelSelection），后续重试复用该值（守住它的位置：dispatchCronRun 的 existingRun 分支）。
//   每次重试重新解释会让同一 run 的前后两段用不同模型，历史记录无法复现。
// INV-26：createTask 的 traceId 与 prompt 的 traceId 是两种身份；未绑定会话的 prompt 一律用 runId（守住它的位置：promptTraceId 赋值）。
//   混用会让 CLI 无法从 inputId 还原 manual/schedule admission，台账与终态无法配对。
// INV-27：绑定会话（targetTaskId）必须先 resumeTask 再 setConfig/sendPrompt（守住它的位置：dispatchCronRun 的 targetTaskId 分支）。
//   重启或切换 workspace 后会话不在 active，直接写入会报 Session is not active，看起来像「立即运行没触发」。
// INV-28：Bot 回推订阅失败不能阻断 automation 派发（守住它的位置：watchCronRunBotDelivery 的 try/catch）。
//   Bot 通道是 best-effort 辅助面，把它升级为硬依赖会让凭据过期的用户连本地定时任务都跑不了。
// INV-29：remote ZCode task service 的 Proxy 只允许包装「读路径 + 运行计数 + 附件物化」，不得改变业务返回值（守住它的位置：createReportingRemoteZCodeTaskService 的 get 拦截）。
//   包装层一旦改写返回值，snapshot 与事件投影就会看到两份不同的真相，UI 出现刷新前后不一致。
// INV-30：beginWorkspaceTask 失败必须回滚 finish，且每个 begin 恰好对应一次 finish（守住它的位置：beginWorkspaceTask 的两次 throw 前 finish）。
//   漏回滚会让 runningTaskCount 单调增长，Host 退出屏障会永远等一个不存在的任务。
// INV-31：untrackedPromptRpcCount 只用于退出诊断，不参与 workspace runtime 释放裁决（守住它的位置：task meta 缺失时的 fallback 分支）。
//   让它参与释放会让一个无法定位 workspace 的请求把别人的 runtime 判成空闲并回收。
// INV-32：整份 console 重定向必须先保存原始方法再改写（守住它的位置：rawConsole 定义在三个赋值之前）。
//   先改写再取原始方法会拿到自己，形成无限递归的日志栈溢出。
// INV-33：console.error 的上报要让位给 process warning listener，避免同一条 warning 生成 error + warn 双份（守住它的位置：shouldReportHostConsoleError 判定）。
//   双份会让按级别统计的错误看板长期高估，掩盖真实 error 率。
// INV-34：MessagePort 的关闭只有一个触发点（port 的 close 事件），handle.dispose 必须自身幂等（守住它的位置：port.once 与 disposed 标志）。
//   多触发点会重复 forwardFlowState(closed)，让 CLI 侧的 transport 状态机收到非法迁移。
// INV-35：flow 状态更新必须串行（flowUpdateChain），不能让并发的 saturated/closed 乱序到达（守住它的位置：forwardFlowState 的 Promise 链）。
//   乱序会让 closed 之后的 saturated 把 CLI 的 pause 状态重新打开，形成永不恢复的暂停。
// INV-36：Source settings 附件的 detach 只能针对「当前代际仍是自己」的场景（守住它的位置：detachOwnSourceSettings 的 current.services 判定）。
//   不判身份会拆掉重连后新 attachment 正在使用的 settings 面。
// INV-37：取消类消息（CancelRemoteWorkspaceConnect/Bind）只取消 request，不连锁 dispose 共享 session（守住它的位置：两个 cancel 分支）。
//   连锁 dispose 会让「取消选择目录」直接关闭另一个窗口正在使用的远端会话。
// INV-38：BindRemoteWorkspaceContext 的取消标记必须在三条 settle 路径上都被清理（守住它的位置：success/catch/早退分支的 delete）。
//   残留标记会让同一个 requestId 的后续绑定被永久判为已取消。
// INV-39：远程 bind 完成后 workspace 身份以 registry 的当前 session 为准，不用消息里的旧值（守住它的位置：currentSession.workspaceIdentity 的使用）。
//   用旧值会让 renderer 持有已被替换的 identity，后续请求落到已释放的 scope。
// INV-40：Source 重连替换 Controller 失败时不能回滚 transport，也不能删除离线可信投影（守住它的位置：replaceDisconnectedSource 的 catch）。
//   回滚 transport 会让已连通的 Source 被强制断开，用户看到「刚连上又掉线」。
// INV-41：远程媒体并发上限固定为 4，释放用 max(0, n-1)（守住它的位置：hostRemoteMediaRequestLimiter）。
//   不夹紧下界会让异常重复 release 把计数打成负数，之后的请求全部被错误放行。
// INV-42：远端媒体数据面按 clientMode 选择：桌面走 Host loopback Range，手机走 inline（守住它的位置：remoteMediaPreviewFactory 的构造条件）。
//   手机端拿 loopback 地址会直接 404，因为那台机器上没有这个监听端口。
// INV-43：controller-routed task service 的每个写操作都必须先 resolveTaskAddress 再 mutate（守住它的位置：createControllerRoutedTaskService 的 route 函数）。
//   跳过地址解析会把写操作落到本地索引，远程任务的 pin/archive 永远不生效。
// INV-44：releaseWorkspacePreparation 之后必须同步清理 Host 代理层的 task meta 与动态事件订阅（守住它的位置：Proxy 的 releaseWorkspacePreparation 分支）。
//   pooled Host 不随 tab 退出，不清会让监听器随 workspace 数量单调增长。
// INV-45：资源遥测的注册是「替换」而非「叠加」（守住它的位置：wireLocalResourceTelemetry 与 refreshResourceTelemetry 先 dispose 再注册）。
//   叠加会让同一份样本按重连次数被重复上报，指标出现虚假放大。
// INV-46：Host 自采样只在被请求时读一次，不建立周期定时器（守住它的位置：createHostResourceUsageResponder 的注释与用法）。
//   周期采样在空闲 Host 上也会持续唤醒 CPU，笔记本电池会为此付出代价。
// INV-47：uncaughtException 的致命路径只允许进入一次（handlingFatalUncaughtException 标志）（守住它的位置：onFatal 回调）。
//   重入会让第二次异常在清理途中再次触发 process.exit，跳过尚未完成的写回。
// INV-48：parentPort 的 message 处理器是 async 的，await 之间允许其他消息插队（守住它的位置：整个 handler 的顶层 await）。
//   因此任何「先检查后执行」都必须自带身份校验（assertHost / disposed），不能假设中间没有其他消息被处理。
// INV-49：远程连接的 close/reconnect 监听集合在 dispose 后必须清空（守住它的位置：handle.dispose 的 clear 调用）。
//   不清会让已释放的 handle 继续被 manager 回调持有，形成整棵 services 的引用泄漏。
// INV-50：本文件只做装配与转发，不实现业务规则；出现业务判断时说明放错了层（守住它的位置：全文的 dispatch* 与 Proxy 包装）。
import { createHostDatabaseStartup } from "./database-startup/hostDatabaseStartup.js";
import { isOffPeakTerminalStatus } from "@zcode/shared";
import { createHostNetworkCapture } from "./hostNetworkCapture.js";
import { randomUUID } from "node:crypto";
import { createPluginSandboxRegistrationBridge } from "./pluginSandbox/index.js";
import { createWindowTopicResourceRelay } from "./windowTopicResourceRelay.js";
import {
  MessagePortProtocol,
  ChannelServer,
  type IDisposable,
  type IChannelServer,
  LoggingChannelServer,
  NetworkTelemetryChannelServer,
} from "@zcode/rpc";
import { registerHostNetworkTelemetry, stopHostNetworkTelemetry } from "./hostNetworkTelemetry.js";
import { registerHostServiceResourceTelemetry } from "./hostServiceResourceTelemetry.js";
import { resolveResourceTelemetryEnvironmentKey } from "./hostResourceTelemetryEnvironment.js";
import { reportHostSessionCreate } from "./hostSessionCreateTelemetry.js";
import { createBrowserControlMainBridge } from "./browserControlMainBridge.js";
import { materializeBrowserRecordingArtifact } from "./browserRecordingArtifactMaterializer.js";
import {
  ServiceCollection,
  IBotsService,
  ICredentialService,
  IFileService,
  IClientConfigService,
  IMediaPreviewService,
  IOffPeakTaskService,
  IRemoteProjectService,
  type RemoteProjectHost,
  IProjectService,
  ITaskGroupService,
  IBroadcastService,
  IModelSelectionService,
  ISettingService,
  ISourceServerManagementService,
  IWindowControllerService,
  IConversationShareService,
  IPromptAttachmentTransferService,
  IZCodeAgentService,
  IZCodeTaskService,
  IZCodeSessionService,
  ICuaPipSessionService,
  createZCodeAgentConnectionScope,
  type ZCodeAgentV4ClientMode,
  collectServiceMemoryDiagnostics,
} from "@zcode/services";
import {
  createLocalServices,
  createProjectWorkspaceNavigation,
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
  bindRemoteProjectIdentities,
  getOffPeakRequestAuthBuilder,
  disposeServiceResources,
  disposeServiceResourcesAndWait,
  AutomationRepo,
  OffPeakTaskRepo,
  OffPeakTaskService,
  createServiceLogger,
  buildTaskChangeSummary,
  createHostApiNetworkTransport,
  createSettingServiceWithMigrations,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
  type BotProjectConnection,
  type HostApiNetworkTransport,
  type OffPeakRequestAuthBuilder,
} from "@zcode/services/node";
import { createHostResourceUsageResponder } from "./hostResourceUsage.js";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "./offPeakDispatchPlan.js";
import {
  HostMessageTypes,
  HostResponseTypes,
  formatLogPrefix,
  formatZCodeHostProcessName,
  formatZodError,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  buildRemoteHostWorkspaceIdentity,
  resolveWorkspaceKey,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
  formatModelPickerValue,
  type ZCodePromptAttachment,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type TaskStreamMirrorableEvent,
  type TraceId,
  type ZCodeTaskMode,
  type WindowHostAttachmentScope,
  type SourceServerArtifactPolicy,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ModelSelection,
} from "@zcode/shared";
import {
  parseHostIncomingMessageEvent,
  rejectUnavailableAttachedServicePort,
} from "./hostMessagePortGuard.js";
// remote backend 相关模块延迟加载：ssh2 的 CJS 依赖链（asn1 等）在 asar 打包后路径断裂，
// 静态 import 会导致 local 模式的 host process 也崩溃。
// 改为动态 import，仅 remote 模式时才加载。
import type { IRemoteBackend } from "@zcode/server/remote";
import type { Locale, RemoteTarget } from "@zcode/shared";
import { wrapElectronPort } from "./electronPort.js";
import { createTaskRealtimeBridgeForHostInit } from "./taskRealtimeBridge.js";
import { resolveRpcLogLevel } from "./rpcLogLevel.js";
import { createHostWorkspaceTaskTracker } from "./hostWorkspaceTaskTracker.js";
import {
  createRemoteMediaPreviewProxy,
  type RemoteMediaPreviewProxy,
} from "./remoteMediaPreviewProxy.js";
import { watchCronRunBotDelivery } from "./cronBotDelivery.js";
import { createHostRemoteWorkspaceProxyState } from "./hostRemoteWorkspaceProxyState.js";
import {
  createServerRemoteWorkspaceServiceCollection,
  resolveServerProjectService,
} from "./remoteWorkspaceServiceCollection.js";
import { getRemoteProviderProvisioningExecutor } from "./remoteProviderProvisioningService.js";
import {
  createSourceSettingsServiceCollection,
  shouldDetachSourceSettingsAttachment,
} from "./sourceSettingsServiceCollection.js";
import { shouldReportHostConsoleError, stringifyHostLogArg } from "./hostLog.js";
import { flushHostE2ECoverage } from "./e2eCoverage.js";
import { runHostShutdownPhases, type HostShutdownResult } from "./hostShutdownPhases.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createHostUncaughtExceptionHandler } from "./hostUncaughtExceptionGuard.js";
import {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
} from "./cronRunLifecycle.js";
import { connectServerRemote, type ServerRemoteConnection } from "./serverRemoteConnection.js";
import { bindBotGroupTaskScope } from "./botGroupTaskScope.js";
import { createWindowHostAttachmentRegistry } from "./windowHostAttachmentRegistry.js";
import { exposeWindowHostAttachmentServices } from "./windowHostAttachmentRpcPolicy.js";
import { scopeConversationShareServiceForAttachment } from "./conversationShareAttachmentService.js";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";
import { pushDynamicWorkflowUserModeToRemoteHosts } from "./remoteDynamicWorkflowUserMode.js";
import { connectDesktopSourceServer } from "./connectDesktopSourceServer.js";
import { prepareRemoteWorkspaceIdentity } from "./remoteWorkspacePreparation.js";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import { resolveBotRemoteWorkspace } from "./botRemoteWorkspaceResolver.js";
import { SourceServerDirectory } from "./sourceServerDirectory.js";
import { connectSourceServerTarget } from "./connectSourceServerTarget.js";
import {
  SourceServerConnectionManager,
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
} from "./sourceServerConnectionManager.js";
import { createSourceServerRecoveryCloseEvent } from "./sourceServerRecoveryPolicy.js";
import { runStartupReconnectBatch } from "./sourceServerStartupReconnect.js";
import {
  createSourceServerManagementService,
  type SourceServerManagementService,
} from "./sourceServerManagementService.js";
import { resolveSourceServerReleaseAsset } from "./sourceServerReleaseResolver.js";
import { resolveAutomationSubmissionModelSelection } from "./automationModelSelection.js";
import { createRemoteConnectionProgressContext } from "@zcode/server/remote/remoteConnectionProgressContext.js";
import {
  createRemotePromptAttachmentTransferService,
  type RemotePromptAttachmentTransferService,
} from "./promptAttachmentTransferService.js";
import { startHostSelfResourceTelemetry } from "./hostSelfResourceTelemetry.js";
type HostRemoteConnection = ServerRemoteConnection;
interface HostRemoteConnectionCapabilities {
  promptAttachmentTransferFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemotePromptAttachmentTransferService;
  browserRecordingUploader?: Pick<IRemoteBackend, "upload">;
  remoteMediaPreviewFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemoteMediaPreviewProxy;
  sourceServerId?: string;
  persistentSourceConnection?: boolean;
  /** underlying 服务实例标识，创建 logical wrapper 不代表物理连接换代。 */
  physicalOwner?: () => object;
  profileId?: string;
  recordWorkspaceOpen?: (input: {
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    legacyWorkspaceIdentity?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  bindWorkspaceIdentity?: (input: {
    workspacePath: string;
    stableWorkspaceIdentity: string;
    legacyRouteHint?: string;
    signal?: AbortSignal;
  }) => Promise<void>;
}

// [并发] 这是进程内唯一的远程媒体并发计数，读改写都在 JS 单线程里完成，因此不需要锁；
// 但它的正确性依赖「tryAcquire 与 release 严格成对」，任何提前 return 的分支都必须归还配额。
// [权衡] 上限写成常量 4 而不是配置项：媒体预览是纯体验路径，允许用户调大只会让大图解码挤占 Host 主线程。
// 若改成按内存动态计算，判定本身就要读 process.memoryUsage()，反而比固定上限更贵。
let activeRemoteMediaRequests = 0;
const hostRemoteMediaRequestLimiter = {
  tryAcquire: () => {
    if (activeRemoteMediaRequests >= 4) return false;
    activeRemoteMediaRequests += 1;
    return true;
  },
  release: () => {
    activeRemoteMediaRequests = Math.max(0, activeRemoteMediaRequests - 1);
  },
  getState: () => ({ active: activeRemoteMediaRequests, limit: 4 }),
};
const remoteMediaRangePreviewEnabled =
  process.env["ZCODE_REMOTE_MEDIA_RANGE_PREVIEW_ENABLED"] !== "0";

type RemoteAssetDirs = import("./windowRemoteConnectionRegistry.js").WindowRemoteAssetDirs;

const { parentPort } = process;
const hostNetworkCapture = createHostNetworkCapture(parentPort);

// 进程检索体验优化：host 由 utilityProcess 拉起时外壳仍是 Electron Helper，
// 这里根据 main 传入的窗口 label 补一层稳定的 zcode-* title，方便系统进程列表过滤。
// [权衡] 这里在进程启动早期就改写 title，是为了让系统进程列表能按窗口过滤；
// 若等到 IPC 初始化后再设置，用户在这段时间里看到的仍是 Electron Helper，无法区分是哪个窗口卡住。
process.title = formatZCodeHostProcessName(process.env["ZCODE_PROCESS_LABEL"]);

type HostLogLevel = "info" | "warn" | "error";

interface PendingFeedbackLogArchiveRequest {
  resolve: (archive: { path: string; size: number }) => void;
  reject: (error: Error) => void;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

interface PendingLocalMediaPreviewPathAuthorization {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

// [资源] 反馈日志归档是「Host 发请求、Main 打包」的跨进程 Promise，Map 是它唯一的挂起点。
// 每条记录在三个位置必须被删除：postMessage 抛错、收到 Result、Host 关闭；漏掉任何一个，
// 该 Promise 的 resolve/reject 与 onProgress 闭包会随进程存活一直驻留。
// [失败路径] 这里刻意不做超时淘汰：打包大日志可能耗时数分钟，超时重试会产生两份 zip。
const pendingFeedbackLogArchiveRequests = new Map<string, PendingFeedbackLogArchiveRequest>();
let nextFeedbackLogArchiveRequestSeq = 0;
const pendingLocalMediaPreviewPathAuthorizations = new Map<
  string,
  PendingLocalMediaPreviewPathAuthorization
>();

// 本地视频预览需要 Main 侧确认路径授权（渲染进程不能直接读任意绝对路径），本函数是唯一入口。
// 先注册 pending 再 postMessage，顺序不能反：Main 可能在同一个 tick 内回包，
// 先发后注册会拿到一个找不到 pending 的 Result，表现为授权永远 pending。
// [失败路径] parentPort 不存在时同步 reject 而不是 throw，调用方统一按 Promise 失败处理。
function authorizeLocalMediaPreviewPath(path: string): Promise<string> {
  if (!parentPort) {
    return Promise.reject(new Error("parentPort unavailable"));
  }
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    // [失败路径] postMessage 抛错说明端口已断，必须立刻删掉刚写入的 pending 再 reject；
    // 否则这条记录既不会被 Result 消费（消息没发出去），也不会被关闭流程清理，成为永久泄漏。
    pendingLocalMediaPreviewPathAuthorizations.set(requestId, { resolve, reject });
    try {
      parentPort.postMessage({
        type: HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest,
        requestId,
        path,
      });
    } catch (error) {
      pendingLocalMediaPreviewPathAuthorizations.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// [资源] 插件沙箱注册桥的生命周期比 attachment 长：它服务整个 Host，而不是某个端口。
// 因此它的 dispose 只能出现在 disposeHostResources 里，不能被 attachment 的 dispose 顺带调用。
// [权衡] send 里对 parentPort 的空判直接抛错：注册请求丢一半比整体失败更难排查。
const pluginSandboxRegistrationBridge = createPluginSandboxRegistrationBridge({
  send: (message) => {
    if (!parentPort) throw new Error("parentPort unavailable");
    parentPort.postMessage(message);
  },
});

// browser-use host↔main 桥：把 agent 的 browser 命令经 parentPort 转给 main（WebContentsView+CDP）。
// parentPort 为空（不应发生于 host 进程）时 postToMain 抛错，bridge 自身返回 backend_unavailable。
// browser-use 的 Host 侧代理：agent 发出的 browser 命令在此转成 parentPort 消息，由 Main 用
// WebContentsView + CDP 执行。Host 不持有任何页面句柄，因此这里失败只能是 backend_unavailable。
// [失败路径] parentPort 为空（理论上不会发生在 Host 进程）时抛错，让 bridge 明确降级，
// 而不是把命令静默吞掉——静默吞掉会让模型以为浏览器已操作成功并继续往下推理。
const browserControlMainBridge = createBrowserControlMainBridge({
  postToMain: (message) => {
    if (!parentPort) {
      throw new Error("parentPort unavailable");
    }
    parentPort.postMessage(message);
  },
  materializeRecording: (input) => {
    let remoteBackend: Pick<IRemoteBackend, "upload"> | undefined;
    // [并发] Window Host 可以同时持有多条远端连接，所以不能用进程级 uploader；
    // 必须带完整 scope 回 registry 取当前代际的权威 entry，否则并发会话会互相串数据。
    // [失败路径] scope 解析不到时抛错而不是退回本地落盘：远端录屏留在本机等于用户拿不到产物。
    if (input.remoteSessionId) {
      const workspaceIdentity = input.workspaceIdentity;
      if (!workspaceIdentity?.trim()) {
        throw new Error("remote Browser recording materialization requires workspaceIdentity");
      }
      // Window Host 重构后同一进程可同时持有多个远端连接，旧的进程级
      // remoteConnection 会串 session。必须用完整 scope 从 registry 的权威 entry 取 uploader。
      remoteBackend = windowRemoteConnectionRegistry.resolveScopedCapabilities({
        kind: "remote",
        remoteSessionId: input.remoteSessionId,
        workspacePath: input.workspacePath,
        workspaceIdentity,
      })?.browserRecordingUploader;
      if (!remoteBackend) {
        throw new Error(
          "Source Server browser recording transfer requires the remote resource transaction path",
        );
      }
    }
    return materializeBrowserRecordingArtifact({
      ...input,
      ...(remoteBackend ? { remoteBackend } : {}),
    });
  },
});

// 日志双写中的「上报 Main」一半：把参数串化后作为单条消息发送，保证 Main 侧日志顺序与本地一致。
// [失败路径] 整段包 try/catch 且空 catch 是有意的：端口断开时日志本身不该把 Host 带崩；
// 这里也不能回退到 console.error，否则会再次进入已被重定向的 console，形成递归。
function reportHostLog(level: HostLogLevel, args: unknown[]): void {
  if (!parentPort) {
    return;
  }

  try {
    parentPort.postMessage({
      type: HostResponseTypes.Log,
      level,
      source: "host",
      message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
    });
  } catch {
    // 日志上报失败不应影响 host 主流程。
  }
}

// [权衡] 必须先保存原始 console 方法，再在后面重定向 console.*；顺序反了会拿到重定向后的函数，
// 调用它又触发重定向，形成无限递归。
// 这三个引用同时是「本地落盘」与「上报 Main」两条路径的共同底层，不能再被第三方库覆盖。
const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const remoteConnectionProgressContext = createRemoteConnectionProgressContext({
  emit: ({ requestId, level, args }) => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId,
        level,
        message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
      });
    } catch {
      // 连接进度上报失败不应中断 SSH/WSL/Docker 的真实连接流程。
    }
  },
});

// 结构化日志的唯一出口：先拼一次 prefix，再同时写给本地 console 与 Main；
// 只拼一次保证两侧的 pid/进程名前缀完全一致，排查时可以直接按字符串对齐。
// [权衡] 不做级别过滤：Host 的日志量级由调用点控制，集中过滤会让 debug 级诊断在线上永久丢失。
function writeHostLog(level: HostLogLevel, ...args: unknown[]): void {
  const prefix = formatLogPrefix("zcode-host", process.pid);
  const consoleFn =
    level === "error" ? rawConsole.error : level === "warn" ? rawConsole.warn : rawConsole.log;
  consoleFn(prefix, ...args);
  reportHostLog(level, [prefix, ...args]);
}

// 问题反馈的日志打包必须与「导出日志」同源，否则用户上传的 zip 会缺 zcode-cli、rollout 与脱敏，
// 客服拿到的证据与开发者本地看到的不一致。Host 只负责发起与接收路径，打包逻辑留在 Main。
// [事务] 打包是幂等读操作，但每次调用都会产生一个新的 requestId，重复点击会生成两份 zip；
// 调用方需要自行去重，这里不做（Host 没有「当前是否已有打包」的业务语义）。
function createFullFeedbackLogArchiveViaMain(
  sourceDir: string,
  options?: {
    onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
  },
): Promise<{ path: string; size: number }> {
  const requestId = `feedback-log-archive-${Date.now()}-${nextFeedbackLogArchiveRequestSeq++}`;
  options?.onProgress?.({ processedBytes: 0, totalBytes: 0 });

  return new Promise((resolve, reject) => {
    pendingFeedbackLogArchiveRequests.set(requestId, {
      resolve,
      reject,
      onProgress: options?.onProgress,
    });
    // 问题反馈以前在 host service 内走 compactLogArchive 的 full fallback，
    // 收集范围和“导出日志”不一致，缺少 zcode-cli 日志、rollout/debug 以及导出链路脱敏。
    // 这里把完整日志打包委托给 main process 的导出日志同源逻辑，host 只拿 zip 路径继续上传。
    try {
      parentPort.postMessage({
        type: HostResponseTypes.FeedbackLogArchiveRequest,
        requestId,
        sourceDir,
      });
    } catch (error) {
      pendingFeedbackLogArchiveRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// 本文件内部的日志门面：只暴露三个级别，避免调用点直接依赖 writeHostLog 的可变参数签名。
// [权衡] 不提供 debug：Host 侧的 debug 走 createServiceLogger(rpc) 独立通道，混在一起会污染级别语义。
const logger = {
  info: (...args: unknown[]) => writeHostLog("info", ...args),
  warn: (...args: unknown[]) => writeHostLog("warn", ...args),
  error: (...args: unknown[]) => writeHostLog("error", ...args),
};

// [资源] automation 台账的进程级单例。它持有 sqlite 连接，必须在 Host 退出阶段 close；
// 每次派发都新建 repo 会让连接数随调度次数增长，最终触发文件句柄上限。
// [事务] 台账写入是「先落 running、再落终态」的两段式，中途崩溃时由 reconcile 逻辑按 runId 修复。
const cronAutomationRepo = new AutomationRepo();
// [资源] 每个进行中的 cron run 占用一条终态订阅（+ 可选的心跳），key 是 taskId+traceId。
// 这张表是「重复派发」的第二道闸：同一 key 再次进入前会先 dispose 旧订阅，避免两份结算同时回写。
// [失败路径] 进程退出时必须逐个 dispose，不能只清 Map——清 Map 不会解除底层事件监听。
const cronRunSubscriptions = new Map<string, { dispose(): void }>();

// ---- 闲时任务（off-peak）派发：与 cron 并行的独立链路（表/消息/常量互不复用）----
// [资源] 闲时任务台账与 cron 完全隔离（不同表、不同 repo），因为两者状态机不同：
// cron 以 run 为单位，闲时任务以 task 为单位并带 ticket 生命周期。
// 共用 repo 会让「取消闲时任务」被解释成「cron run 失败」，两侧看板互相污染。
const offPeakTaskRepo = new OffPeakTaskRepo();
// [资源] 闲时执行的订阅表，语义与 cronRunSubscriptions 相同但生命周期更长：
// 一次任务可能跨多张票（多轮自动 turn），每轮结束后才能释放对应 key。
const offPeakRunSubscriptions = new Map<string, { dispose(): void }>();
/**
 * 续跑提示词（"实现时定"的落地）：3h 时间盒到期 / app 重启恢复后 resume 同一
 * session 续发。不重发原始 prompt（会让模型从头再做一遍），而是指示接续未完成的工作。
 */
// [权衡] 续跑用固定提示而不是重发原始 prompt：重发会让模型把已完成的部分再做一遍，
// 在「写文件」这类有副作用的工具上直接产生重复改动。
// 文案刻意要求「review what has already been done」，因为冷恢复后的模型没有上一轮的内存，
// 只能靠重新读工作区来建立上下文；不写这句它会倾向从头规划。
const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

// ---- off-peak 运行时装配（server client + 进程内 mock 网关 + 编排服务，host 域属主）----
// ⚠ 多窗口=多 host 会各自跑一份 sync 轮询（批量接口幂等、写入同库同数据，重复仅多耗请求）；
// mock 网关用固定端口单实例共享票据状态。若多窗口轮询放大成本，再加跨 host 选主。
// `OffPeakRuntime` 的三元组：`service`、逐请求鉴权构造器与派发前的模型可用性校验。
// 三者必须来自同一个 ServiceCollection，混用不同代际的 services 会让鉴权票与服务实例对不上。
interface OffPeakRuntime {
  service: OffPeakTaskService;
  /** 派发时按本段票据构造逐请求鉴权；静态模型事实由 CLI Built-in Config 提供。 */
  buildRequestAuth: OffPeakRequestAuthBuilder;
  validateSelection: (selection: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  }) => Promise<boolean>;
}
// 懒加载缓存：只在第一次真正派发时装配，避免 Host 启动阶段为未使用的功能初始化网络客户端。
// [失败路径] 置 null 是唯一的失效方式（见 disposeOffPeakRuntime），服务实例本身由 services 集合回收。
let offPeakRuntime: OffPeakRuntime | null = null;

// 返回 null 而不是抛错：调用方（dispatchOffPeakRun）需要把「服务未就绪」与「业务派发失败」
// 区分开，前者是可重试的环境问题，后者会写台账。
// [并发] 这里没有加单飞保护，因为赋值发生在同步段（无 await），两次并发调用不会各建一份。
async function ensureOffPeakRuntime(): Promise<OffPeakRuntime | null> {
  if (offPeakRuntime) return offPeakRuntime;
  const services = activeServices;
  if (!services) return null;
  const service = services.getOptional(IOffPeakTaskService);
  const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
  if (!service || !buildRequestAuth) {
    logger.warn("off-peak runtime unavailable: missing host services");
    return null;
  }
  offPeakRuntime = {
    service: service as OffPeakTaskService,
    buildRequestAuth,
    validateSelection: (selection) =>
      (service as OffPeakTaskService).validateDispatchModelSelection(selection),
  };
  logger.info("off-peak runtime ready (service from local collection)");
  return offPeakRuntime;
}

// [资源] 只清缓存引用，不 dispose service：service 属于 ServiceCollection，由服务层统一回收。
// 这里若额外 dispose，会让后续 Host 重启复用同一集合时拿到已关闭的服务。
function disposeOffPeakRuntime(): void {
  if (!offPeakRuntime) return;
  offPeakRuntime = null;
}

// 派发请求的完整快照。字段全部来自 scheduler 侧的持久事实，Host 不在这里做二次推导。
// [事务] serverTicketId 是这张票的唯一凭据：没有它就说明快照失序，必须拒绝派发。
interface OffPeakRunDispatchRequest {
  offPeakTaskId: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
}

// [权衡] 用 \u0000 拼 key 而不是冒号：taskId 与 traceId 都可能含冒号（traceId 形如 task:resume:uuid），
// 用冒号会在「拆回两段」时产生歧义，进而把不同 run 判成同一个 key。
function offPeakRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

// [资源] 单条订阅释放：先从表里摘除再 dispose，保证 dispose 内部即使重入也不会二次执行。
// 找不到时直接 return，让调用方不需要先判断存在性（重复派发、迟到回调都会走到这里）。
function disposeOffPeakRunSubscription(key: string): void {
  const disposable = offPeakRunSubscriptions.get(key);
  if (!disposable) return;
  offPeakRunSubscriptions.delete(key);
  disposable.dispose();
}

/** 终态回填 files_changed：复用现有 task diff 汇总（工具写盘型统计，Bash 改动不计入，接受）。 */
// 终态回填用的「改动文件数」是展示信息，不是判定依据；因此整段 best-effort，失败返回 undefined。
// [权衡] 只统计工具写盘，Bash 造成的改动不计入：精确统计需要全仓 diff，代价远高于这个数字的价值。
async function resolveOffPeakFilesChanged(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<number | undefined> {
  try {
    const snapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const fileChanges = snapshot?.fileChanges;
    if (!fileChanges) return undefined;
    // 汇总为空（无文件改动）按 0 计——"改了 0 个文件"对完成通知是真实信息。
    return buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
  } catch (error) {
    logger.warn("off-peak files_changed 汇总失败（不阻塞终态落库）:", error);
    return undefined;
  }
}

/** loop 终态 → off_peak_tasks 终态：succeeded→completed、stopped→cancelled（用户手动停止）、其余→failed。 */
// [事务] loop 终态到台账终态的映射是单向的：succeeded→completed、stopped→cancelled（用户手动停止）、
// 其余一律 failed。把 stopped 当成 failed 会让「用户主动停」被算进失败率看板。
// 先取 filesChanged 再写终态，是因为写终态后任务行就不可再变更；顺序反了会永久缺这一列。
async function finalizeOffPeakRun(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): Promise<void> {
  const status =
    params.outcome === "succeeded"
      ? ("completed" as const)
      : params.outcome === "stopped"
        ? ("cancelled" as const)
        : ("failed" as const);
  const filesChanged = await resolveOffPeakFilesChanged(params);
  const updated = await offPeakTaskRepo.markTerminal(params.offPeakTaskId, {
    status,
    endedAt: Date.now(),
    ...(params.error ? { failureReason: params.error } : {}),
    ...(filesChanged !== undefined ? { filesChanged } : {}),
  });
  // [失败路径] markTerminal 返回 false 表示这条任务已经是终态（用户先一步取消或删除）。
  // 此时必须丢弃而不是重试：终态不可逆出，重试会用「成功」覆盖用户明确的取消意图。
  // 这条分支同时是幂等兜底——同一 traceId 的重复终态通知会安静地走到这里。
  if (!updated) {
    // 终态不可逆出：任务已被用户先一步取消/删除等，丢弃迟到回写（幂等兜底）。
    logger.info(
      `off-peak terminal writeback dropped (already terminal) task=${params.offPeakTaskId}`,
    );
    return;
  }
  logger.info(
    `off-peak run finished task=${params.offPeakTaskId} status=${status} filesChanged=${filesChanged ?? "n/a"}`,
  );
  // 后台完成统一置未读，打开 task 时由导航链路清除（与 cron 同款）。
  void params.zcodeTaskService.setTaskUnread({
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    unread: true,
  });
}

// [并发] 一次闲时执行需要两个来源的配合：residentExecutions 负责「凭据与票据」，
// onDynamicOffPeakLifecycle 负责「真实 turn 生命周期」。只用其中一个都会漏掉一半终态。
// 两者都注册进同一张订阅表，确保任意一侧先结束都会走同一条 dispose 路径。
function trackOffPeakRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  zcodeAgentService: IZCodeAgentService;
  service: OffPeakTaskService;
  ticketId: string;
  offPeakTaskId: string;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
}): { admitted(): void } {
  const key = offPeakRunSubscriptionKey(params.taskId, params.traceId);
  disposeOffPeakRunSubscription(key);
  const target = {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  };
  // [事务] complete 回调是唯一的终态写入口；control 回调把 stop/permission 之类的控制命令
  // 转发给 CLI，Host 只做通道，不解释命令语义。
  // disposed 回调用于「执行被外部注销」的场景，必须与订阅表清理保持一致。
  const registration = params.service.residentExecutions.register({
    offPeakTaskId: params.offPeakTaskId,
    executionId: params.traceId,
    sessionId: params.taskId,
    ticketId: params.ticketId,
    control: (control) =>
      params.zcodeAgentService.controlOffPeakExecutionV4({ ...target, control }),
    complete: (outcome) => finalizeOffPeakRun({ ...params, outcome }),
    disposed: () => disposeOffPeakRunSubscription(key),
  });
  // [并发] 订阅是 workspace 级的，同一 workspace 下的其他 execution 事件也会进来；
  // 因此必须先用 executionId + sessionId 双条件过滤，只处理本 run 的事件。
  // 漏掉过滤会让 A 任务的终态写到 B 任务的台账上。
  const disposable = params.zcodeAgentService.onDynamicOffPeakLifecycle(target)((event) => {
    if (event.executionId !== params.traceId || event.sessionId !== params.taskId) return;
    void params.service.residentExecutions
      .handle(event)
      .catch((error) => logger.warn("off-peak 生命周期处理失败:", error));
  });
  offPeakRunSubscriptions.set(key, {
    dispose() {
      disposable.dispose();
      registration.dispose();
    },
  });
  return registration;
}

/**
 * 把一次闲时任务派发提交给当前 host 的 V4 task service。
 * 首跑 createTask；进程内换票只交付现存执行，绝不重发初始 prompt。
 * 已有任务行的中断恢复仍复用会话；它不恢复旧进程的后台工作或通知。
 */
// 闲时派发的主状态机，按顺序分四段：校验票据 → 判断是否已有驻留执行 → 建立会话 → 首次/续跑派发。
// [事务] 每段都以「台账当前状态」为判断依据，而不是以内存标志为准；因为调度认领与 CLI 收口可以交错。
// 返回值固定带 lifecycleManaged: true，告诉调用方终态由订阅链负责，不要再写第二遍。
// [失败路径] 所有抛出都保留原始错误类型，上层据此区分 permanent 与 transient。
async function dispatchOffPeakRun(request: OffPeakRunDispatchRequest): Promise<{
  conversationId?: string;
  sessionId?: string;
  lifecycleManaged: true;
}> {
  const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
  const zcodeAgentService = activeServices?.getOptional(IZCodeAgentService);
  if (!zcodeTaskService || !zcodeAgentService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const runtime = await ensureOffPeakRuntime();
  if (!runtime) {
    throw new Error("off-peak runtime is not available");
  }
  // [事务] schedulable 快照必然已取号；到这里还没有票，说明调度侧与 Host 的快照失序。
  // 抛 transient 让下一轮轮询补票，而不是自己造一个票去执行——自造票会绕过服务端的配额与去重。
  if (!request.serverTicketId) {
    // schedulable 必然已取号；无票派发说明快照失序，按 transient 回执等下轮（轮询会补票）。
    throw new Error("off-peak dispatch without server ticket");
  }
  const currentTask = await offPeakTaskRepo.get(request.offPeakTaskId);
  // [事务] 迟到的派发：任务已完成/取消，或台账行已被删除。
  // 必须先 discardTicket 再返回，否则这张票会一直挂在 residentExecutions 里，阻塞后续认领。
  // 返回已有 conversationId 是给调度侧一个可关联的 id，不代表本次真的执行了。
  if (!currentTask || isOffPeakTerminalStatus(currentTask.status)) {
    // 调度认领与 CLI 收口可以交错；迟到的派发不能重放已经完成的任务。
    await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
    const sessionId = currentTask?.conversationId ?? request.conversationId ?? request.sessionId;
    return { conversationId: sessionId, sessionId, lifecycleManaged: true };
  }
  // 已有驻留执行时的换票路径：只交付新票，绝不重发 prompt。
  // [事务] isUserOwned 决定是否构造鉴权：用户接管的执行由用户自己的凭据驱动，Host 不能再注入票级 auth。
  // [失败路径] deliverTicket 返回 null 表示等待凭据期间执行已注销，此时只能丢弃票据并按续票语义返回。
  if (runtime.service.residentExecutions.has(request.offPeakTaskId)) {
    const stillNeedsTicket = runtime.service.residentExecutions.retakeGuard(request.offPeakTaskId);
    const auth = runtime.service.residentExecutions.isUserOwned(request.offPeakTaskId)
      ? {}
      : await runtime.buildRequestAuth(request.serverTicketId);
    // 先写 running 再唤醒 CLI；否则新请求立即过期产生的 requeue 会被迟到确认覆盖。
    await offPeakTaskRepo.markRunning(request.offPeakTaskId, { startedAt: Date.now() });
    try {
      const resident = await runtime.service.residentExecutions.deliverTicket(
        request.offPeakTaskId,
        request.serverTicketId,
        auth,
      );
      if (resident)
        return {
          conversationId: resident.sessionId,
          sessionId: resident.sessionId,
          lifecycleManaged: true,
        };
      // 等凭据期间驻留执行可能完成并注销；此派发已属于续票，禁止降级成初始 prompt。
      await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
      const sessionId = currentTask.conversationId ?? request.conversationId ?? request.sessionId;
      return { conversationId: sessionId, sessionId, lifecycleManaged: true };
    } catch (error) {
      // RPC 在途可能发生用户接管或整项完成，失败回执不能重新夺回调度归属。
      if (stillNeedsTicket()) await offPeakTaskRepo.requeueForContinuation(request.offPeakTaskId);
      throw error;
    }
  }
  // 闲时 Selection 只承载驻内存续跑；普通 Session entry 与 CLI 默认不持久化它。
  const idleSelection = request.modelSelection;
  if (!(await runtime.validateSelection(idleSelection))) {
    throw new OffPeakModelUnavailableError("idlePlan");
  }
  const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
  // 首次派发与复用会话的恢复派发需要在轮次事实中可区分；该字段只描述
  // 当前自动 turn 的调度阶段，不改变稳定 task ID、独立 message ID 或手动消息语义。
  // 三态派发：bound-first-run（在用户已有会话里首跑）、resume（跨票续跑）、init（新建会话）。
  // [权衡] 用独立函数判定而不是在这里展开条件，是因为「是否有绑定会话」与「是否已有 conversationId」
  // 的组合会随调度侧字段演进；集中一处判定，避免两条 if 链得出不同结论。
  const dispatchKind = resolveOffPeakDispatchKind(request);
  const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
  let trackedKey: string | null = null;
  try {
    let taskId: string;
    let traceId: TraceId;
    let promptContent = request.prompt;
    // [事务] 绑定首跑必须复用用户会话，因此先探测「已删除/运行中」再写任何配置；
    // 顺序反了会在忙碌会话上先改掉 mode，然后被 -32010 拒绝，用户权限模式被静默污染。
    // [失败路径] assertBoundSessionDispatchable 抛出的是 transient，交给调度器退避，不在 Host 内重试。
    if (dispatchKind === "bound-first-run") {
      // 绑定首跑：会话内创建的任务在创建它的会话里执行（对齐 dispatchCronRun 的 targetTaskId 路径）。
      // 先探测再写配置：绑定的是用户的工作会话，忙碌时直接 transient 交给调度器退避，
      // 不能先 setMode 再被 session/send 以 -32010 拒绝（那会悄悄改掉用户会话的权限模式）。
      taskId = request.sessionId!;
      traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
      const workspaceScope = {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
      };
      // Bug 原因：归属收口后 tasks-index 行的 status 只镜像 CLI 的 last_outcome，
      // 永远不会是 running，原来按 listTasks(...).status === "running" 的忙碌判断已失效，
      // 闲时任务会被派发到仍在运行的绑定会话上。运行中事实只能取 syncer 的活动集合。
      const [deletedIds, activeIds] = await Promise.all([
        zcodeTaskService.listDeletedTaskIds(workspaceScope),
        zcodeTaskService.listActiveTaskIds(workspaceScope),
      ]);
      assertBoundSessionDispatchable({
        sessionId: taskId,
        deleted: deletedIds.includes(taskId),
        running: activeIds.includes(taskId),
      });
      await zcodeTaskService.resumeTask({
        ...workspaceScope,
        taskId,
        // 绑定会话首次盖章归属标记，侧栏归入闲时分组（机制同 cron targetTaskId）。
        offPeakTaskId: request.offPeakTaskId,
      });
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
    // 续跑段：必须先 resume 再 send，冷恢复要重新水合历史；顺序反了会以 Session is not active 失败。
    // [事务] offPeakTaskId 在这里补写一次，作为 bootstrap 回填之外的双保险，保证侧栏分组不丢。
    } else if (dispatchKind === "resume") {
      // 续跑段：resume 同一 session（冷恢复水合历史；send 前必须先 resume）。
      taskId = request.conversationId!;
      // 原因：offPeakTaskId 只用于跨 talk 关联；每次自动轮必须生成独立消息身份，
      // 不能复用 task ID，也不能依赖同毫秒时间戳避免碰撞。
      traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
      promptContent = OFF_PEAK_RESUME_PROMPT;
      await zcodeTaskService.resumeTask({
        taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        // D48：pre-打点会话续跑时补写归属标记（bootstrap 回填之外的双保险）。
        offPeakTaskId: request.offPeakTaskId,
      });
      // 权限模式随派发下发（resume 后显式设置，幂等）。
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
      // 档位是 idle Selection 的一部分，只在 sendPrompt 注入；单独写档位会污染用户会话。
    } else {
      // 新建会话路径：把 mode 与归属标记一次性写进 createTask，减少后续 setConfig 的中间态。
      // [事务] offPeakTaskId 在创建时就落库，侧栏的月亮图标与系统分组只读这个标记，不再反查 store。
      // [权衡] deferPersistenceUntilFirstPrompt 让空 session 在首条 admission 内落库，
      // 避免 session_input 的外键先于 session 主记录写入而失败。
      const task = await zcodeTaskService.createTask({
        projectId: request.projectId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        // 空 Session 沿用普通初始化；idle Selection 只在下方执行中注入。
        // 在此写入会让闲时轮结束后的普通消息继续使用无票的隐藏 Provider。
        mode: request.permissionMode as ZCodeTaskMode,
        // 闲时任务是无界面的 createTask + sendPrompt 连续派发；空 session 必须在首条
        // V4 admission 内先持久化，否则 session_input 外键会先于 session 主记录写入。
        deferPersistenceUntilFirstPrompt: true,
        // 创建时即盖章持久归属标记（月亮图标/后续系统分组只看该标记，不再反查 store）。
        offPeakTaskId: request.offPeakTaskId,
      });
      taskId = task.taskId;
      traceId = task.traceId;
    }
    // 准备会话含异步 I/O；任务可能在此期间取消，首条 prompt 接纳前必须重新核对。
    // [事务] 准备会话的过程中包含异步 I/O，任务可能已被取消；首条 prompt 接纳前必须重新核对。
    // 这一步是「取消」与「派发」之间唯一的同步点，删掉它会让已取消任务重新跑起来。
    const beforeAdmission = await offPeakTaskRepo.get(request.offPeakTaskId);
    if (!beforeAdmission || isOffPeakTerminalStatus(beforeAdmission.status)) {
      await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
      return { conversationId: taskId, sessionId: taskId, lifecycleManaged: true };
    }
    trackedKey = offPeakRunSubscriptionKey(taskId, traceId);
    const lifecycle = trackOffPeakRunOutcome({
      zcodeTaskService,
      zcodeAgentService,
      service: runtime.service,
      ticketId: request.serverTicketId,
      offPeakTaskId: request.offPeakTaskId,
      taskId,
      traceId,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    await zcodeTaskService.sendPrompt({
      taskId,
      traceId,
      content: promptContent,
      clientMode: "desktop-continuous",
      // Bug 原因：闲时自动 turn 以前只注入 idle plan，没有限制工具面，模型可在后台创建
      // 持久化定时任务。首跑与续跑在此收敛，显式隐藏 CronCreate 且不伪造 cron automation 归属。
      // 闲时轮同时隐藏 OffPeakCreate，OffPeakList 只读保留。
      // [权衡] 闲时自动 turn 的工具面必须比交互式 turn 更窄：模型在无人监督时创建新的持久化调度，
      // 用户会在完全不知情的情况下得到一个自我增长的定时任务集合。
      // 只隐藏写入类工具、保留 OffPeakList 只读，是为了让模型仍然能查询自己的任务上下文。
      // [失败路径] 这里用 denylist 而不是 allowlist：新增工具默认可用，但一旦发现危险需同步加进来。
      toolDenylist: ["CronCreate", "OffPeakCreate"],
      modelSelection: idleSelection,
      modelExecution: {
        // 闲时执行凭据只服务主 Turn；完成后不再派生自动 Memory 请求。
        memoryExtraction: "skip",
        selectionScope: "execution",
        offPeak: {
          executionId: traceId,
          ticketId: request.serverTicketId,
          providerErrorCode: "3102",
        },
        requestAuth,
        subagents: {
          foregroundModel: "submission",
          background: "allow",
        },
      },
      offPeakTaskId: request.offPeakTaskId,
      offPeakRunType,
    });
    await offPeakTaskRepo.markRunning(request.offPeakTaskId, {
      startedAt: Date.now(),
      conversationId: taskId,
      sessionId: taskId,
    });
    lifecycle.admitted();
    // 只有 init 实际新建；绑定首跑和跨票续跑只是原 Session 的后续输入。
    // [事务] 只有真正新建会话才上报 session_create；绑定首跑与续跑只是原会话的后续输入，
    // 重复上报会把同一会话的创建数统计成 N 次。
    if (dispatchKind === "init") {
      reportHostSessionCreate(parentPort, {
        sessionId: taskId,
        messageId: traceId,
        source: "automation_idle",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { conversationId: taskId, sessionId: taskId, lifecycleManaged: true };
  } catch (error) {
    if (trackedKey) disposeOffPeakRunSubscription(trackedKey);
    throw error;
  }
}

// cron run 的派发入参，与 IPC 消息形状基本一致；mode/modelSelection 允许缺省，
// 由目标 Host 的 Registry 解析后固定，Host 不在这里填默认值。
interface CronRunDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
}

// [权衡] automation 必须先按 workspace 找远端 logical session：remote workspace 的 task service
// 跑在远端 server 上，用本地 service 派发会把会话建到本机数据库。
// [失败路径] 远程身份找不到 session 时直接抛错，禁止 fallback 到本地——fallback 会静默用错模型与 Registry。
// 本地路径才检查 activeServices，因为只有本地需要「Host 已初始化」这个前置条件。
function resolveAutomationTargetServices(request: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ServiceCollection {
  const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(request);
  if (remoteSession) {
    if (!remoteSession.workspaceIdentity) {
      throw new Error("Automation 目标 Remote Host 缺少 workspaceIdentity");
    }
    return windowRemoteConnectionRegistry.resolveScopedServices({
      kind: "remote",
      remoteSessionId: remoteSession.remoteSessionId,
      workspacePath: request.workspacePath,
      workspaceIdentity: remoteSession.workspaceIdentity,
    });
  }
  // 远程 Automation 找不到目标 logical session 时，旧派发会静默落到 Local Host，
  // 从而使用本地模型首选与 Registry。远程身份只能失败，不能跨 Environment fallback。
  if (request.workspaceIdentity && isRemoteWorkspaceIdentity(request.workspaceIdentity)) {
    throw new Error("Automation 目标 Remote Host 当前不可用");
  }
  if (!activeServices) {
    throw new Error("Local Host services are not initialized.");
  }
  return activeServices;
}

function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

// runId 的格式是 <automationId>:<scheduledAt>:<...>，这里只解析第二段作为「计划时间」。
// [失败路径] 解析不出数字时返回 null 而不是报错：历史 runId 可能来自旧格式，
// 台账里少一个计划时间不影响结算，但抛错会让整次终态写回失败。
function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function markCronRunOutcome(params: {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): void {
  void recordCronRunOutcomeBestEffort({
    ...params,
    repo: cronAutomationRepo,
    logWarn: (message, error) => logger.warn(message, error),
  });
}

function disposeCronRunSubscription(key: string): void {
  const disposable = cronRunSubscriptions.get(key);
  if (!disposable) return;
  cronRunSubscriptions.delete(key);
  disposable.dispose();
}

// 给「已存在会话」应用本次 run 的模型/档位/模式。
// [事务] setAutomationSessionConfig 一次写三项，因此用两个 flag 记录哪些已随它落库，
// 避免随后再逐项 setConfigOption 造成重复写入与事件翻倍。
// [失败路径] 逐项写入失败会向上抛，让派发方标记 failed；这里不做部分成功的补偿。
async function applyCronRunConfigToExistingTask(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.zcodeTaskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

// [资源] 一次 cron run 需要两件东西：终态订阅 + manual 场景下的认领心跳。
// 两者合并成一条订阅项，保证 dispose 时不会只释放其中一个（漏掉心跳会让台账永远显示 running）。
function trackCronRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
}): void {
  const key = cronRunSubscriptionKey(params.taskId, params.traceId);
  disposeCronRunSubscription(key);
  markCronRunOutcome({ ...params, outcome: "running" });
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      void settleCronRunTerminalOutcome({
        ...params,
        outcome: result.outcome,
        error: result.error,
        repo: cronAutomationRepo,
        logWarn: (message, error) => logger.warn(message, error),
      });
      // 定时任务在后台完成后统一置为未读，真正打开 task 时再由导航链路清除。
      void params.zcodeTaskService.setTaskUnread({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        unread: true,
      });
      disposeCronRunSubscription(key);
    },
  );
  const claimHeartbeat =
    params.trigger === "manual"
      ? startManualClaimHeartbeat({
          ...params,
          repo: cronAutomationRepo,
          logWarn: (message, error) => logger.warn(message, error),
        })
      : null;
  cronRunSubscriptions.set(key, {
    dispose() {
      claimHeartbeat?.dispose();
      disposable.dispose();
    },
  });
}

/**
 * 把一次 cron/manual run 直接提交给当前 host 的 V4 task service。
 * 会话内 automation 可能绑定到未激活 session，必须先恢复再应用保存的运行参数。
 */
// cron 派发主流程：先固定模型选择，再建/复用会话，最后 sendPrompt 并挂终态订阅。
// [事务] 失败时既要 dispose 订阅，也要把台账写成 failed；只做前者会让 run 永久停在 running。
// [权衡] 这里不等待 turn 完成，sendPrompt 的 ACK 只代表进入 busy queue，真正的终态由订阅收口。
async function dispatchCronRun(request: CronRunDispatchRequest): Promise<{
  taskId: string;
  sessionId: string;
}> {
  const targetServices = resolveAutomationTargetServices(request);
  const zcodeTaskService = targetServices.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const modelSelectionService = targetServices.getOptional(IModelSelectionService);
  if (!modelSelectionService) {
    throw new Error("目标 Host Model Selection service is not initialized.");
  }
  // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
  // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
  // [事务] 首次派发时把模型选择固定进 run 行，后续重试直接复用；
  // 不这样做的话，账号切换或 Registry 临时读取失败会改变同一 run 的执行模型，历史无法复现。
  // 读取前的离线导入已在 repo 内完成，这里不再绕 Agent/账号服务。
  const existingRun = await cronAutomationRepo.getRun(request.runId);
  const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
    selection: request.modelSelection,
    fixedSelection: existingRun?.modelSelection,
    modelSelectionService,
    // Repo 已在读取前完成离线导入；不再为迁移绕行 Agent/账号服务。
    // 未迁入或损坏的新值仍由此入口明确拒绝，不能当成跟随 Workspace。
    readSelection: () =>
      cronAutomationRepo.getModelSelectionForDispatch(
        request.automationId,
        resolveWorkspaceKey(request),
      ),
  });
  const submissionModelSelection = await cronAutomationRepo.fixRunModelSelection(
    request.runId,
    resolvedSubmissionModelSelection,
  );
  let trackedKey: string | null = null;
  const workspaceKey = resolveWorkspaceKey(request);
  const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
  const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
  try {
    const task = request.targetTaskId
      ? { taskId: request.targetTaskId }
      : await zcodeTaskService.createTask({
          projectId: request.projectId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          additionalDirectories: request.additionalDirectories,
          model: formatModelPickerValue(submissionModelSelection),
          mode: request.mode,
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
    // 未绑定会话时不能沿用 createTask 的 session trace 作为首条 prompt trace：
    // CLI 无法从 inputId 还原 manual/schedule admission。
    // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId。
    // [事务] createTask 返回的 traceId 属于「建会话」这一次操作，不能拿来做首条 prompt 的 inputId；
    // CLI 需要从 inputId 还原 manual/schedule 的 admission 语义，混用会让两者无法配对。
    // 两条派发路径（新建 / 绑定）在这里统一使用 runId，保证台账与消息的关联键一致。
    const promptTraceId = request.runId as TraceId;
    if (request.targetTaskId) {
      // 绑定会话在 app 重启或切换 workspace 后通常不处于 active；旧实现直接
      // setConfig/sendPrompt 会立即报 Session is not active，看起来像「立即运行」没有触发。
      await zcodeTaskService.resumeTask({
        taskId: task.taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        model: formatModelPickerValue(submissionModelSelection),
        thoughtLevel: submissionModelSelection.options?.reasoningLevel,
        automationId: request.automationId,
      });
      await applyCronRunConfigToExistingTask({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        modelSelection: submissionModelSelection,
        mode: request.mode,
      });
    }
    const botsService = targetServices.getOptional(IBotsService);
    if (botsService) {
      try {
        await watchCronRunBotDelivery({
          automationId: request.automationId,
          runId: promptTraceId,
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          taskId: task.taskId,
          repo: cronAutomationRepo,
          botsService,
        });
      } catch (error) {
        // Bot 回推是 best-effort 辅助通道；配置/凭据/订阅失败不能阻断 automation 派发与结算。
        logger.warn(
          `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
          error,
        );
      }
    }
    trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
    trackCronRunOutcome({
      zcodeTaskService,
      taskId: task.taskId,
      traceId: promptTraceId,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
    });
    await zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: request.prompt,
      clientMode: "desktop-continuous",
      automationId: request.automationId,
    });
    // prompt 创建的定时任务带 targetTaskId，追加原会话不能计成 session_create。
    if (!request.targetTaskId) {
      reportHostSessionCreate(parentPort, {
        sessionId: task.taskId,
        messageId: promptTraceId,
        source: "automation_scheduled",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { taskId: task.taskId, sessionId: task.taskId };
  } catch (error) {
    if (trackedKey) disposeCronRunSubscription(trackedKey);
    markCronRunOutcome({
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// 「立即运行」入口：与 scheduler 共用 dispatchCronRun，但失败语义不同——
// 这里的失败必须显式释放 manual claim，否则 automation 会以为仍有排队中的 run 而不再受理。
// [事务] markManualRunDispatched 失败不能当成派发失败：prompt 已经被接纳，重复排队会产生第二个 run。
async function dispatchManualAutomationRun(params: {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}): Promise<void> {
  logger.info(
    `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
  );
  let result: Awaited<ReturnType<typeof dispatchCronRun>>;
  try {
    result = await dispatchCronRun({
      automationId: params.automation.automationId,
      runId: params.run.runId,
      prompt: params.automation.prompt,
      targetTaskId: params.automation.targetTaskId,
      modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
      mode: params.automation.mode,
      workspacePath: params.automation.workspacePath,
      workspaceIdentity: params.automation.workspaceIdentity,
      projectId: params.automation.projectId,
      hostId: params.automation.hostId,
      additionalDirectories: params.automation.additionalDirectories,
    });
  } catch (error) {
    logger.warn(
      `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}:`,
      error,
    );
    await settleManualDispatchFailureBestEffort({
      repo: cronAutomationRepo,
      automationId: params.automation.automationId,
      runId: params.run.runId,
      workspaceKey: params.automation.workspaceKey,
      scheduledAt: params.run.scheduledAt ?? null,
      trigger: "manual",
      dispatchError: error,
      logWarn: (message, releaseError) => logger.warn(message, releaseError),
    });
    throw error;
  }

  try {
    await cronAutomationRepo.markManualRunDispatched({
      runId: params.run.runId,
      sessionId: result.sessionId,
      dispatchedAt: Date.now(),
    });
  } catch (error) {
    // prompt 已经 accepted/queued，台账和累计次数回写失败不能伪装成派发失败并提前释放锁；
    // 真实终态仍由 trackCronRunOutcome 收口，避免同一 automation 重复排队。
    logger.warn(
      `回写 manual automation dispatched 状态与运行次数失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
      error,
    );
  }
  // sendPrompt ACK 可能只表示进入 busy queue；manual claim 必须保留到对应 turn 终态。
  logger.info(
    `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
  );
}

// Node warning 不是远端连接失败，改成结构化 warn，避免默认 stderr 被误染成 error。
// [权衡] Node warning 走结构化 warn 而不是让它落到默认 stderr：默认 stderr 会被 Electron 转成
// console.error，从而在错误看板上伪装成真实故障。
process.on("warning", (warning) => logger.warn(`${warning.name}: ${warning.message}`));

registerHostNetworkTelemetry(parentPort);
// Host 进程自身的 60 秒采样：一次读数两个出口——门控后写本地
// `[memory]` 行，同一次读数换算成 HostResourceSample 经 parentPort 送 main 作 heap 来源。
// services 计数器由各 service 工厂自注册。
// [资源] Host 自身的 60 秒采样：同一次读数两个出口（本地 [memory] 行 + 结构化样本给 Main）。
// 只开一个采样器，避免 main 侧把同一进程的内存算两遍。
// [失败路径] postMessage 在 parentPort 缺失时传 undefined，采样器内部按「不上报」降级。
const hostSelfResourceTelemetry = startHostSelfResourceTelemetry({
  logger,
  collectCounters: collectServiceMemoryDiagnostics,
  postMessage: parentPort ? (message) => parentPort.postMessage(message) : undefined,
});

// Agent 子进程生命周期的四个事件全部扁平转发给 Main；每个回调都先判 parentPort，
// 因为进程退出阶段 parentPort 可能已被置空，此时上报会抛错并打断退出流程。
// [权衡] onExit 单独把 signal 归一成 null：undefined 无法跨 IPC 序列化，UI 会拿到字段缺失。
const runtimeProcessLifecycleReporter = {
  onSpawn(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessSpawned,
      ...event,
    });
  },
  onReady(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessReady,
      ...event,
    });
  },
  onExit(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessExited,
      ...event,
      signal: event.signal ?? null,
    });
  },
  onError(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessError,
      ...event,
    });
  },
  onException(event) {
    parentPort?.postMessage({ type: HostResponseTypes.AgentProcessException, ...event });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["processLifecycleReporter"];

// runningTaskCount 只上报聚合数字，不携带 task 明细：Main 侧只用于退出屏障与诊断展示，
// 传输明细会让高频的 begin/finish 变成 IPC 风暴。
const runtimeTaskReporter = {
  onRunningTaskCountChanged(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentRunningTaskCountChanged,
      runningTaskCount: event.runningTaskCount,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["taskRuntimeReporter"];

// CUA 的操作状态属于「物理 Windows 桌面」的投影；非 Windows 平台在装配处直接不注入这个上报器，
// 因此这里不需要再做平台判断，保持单一判定点。
const cuaOperationStateReporter = {
  onStateChanged(event) {
    if (!parentPort) {
      return;
    }
    parentPort.postMessage({
      type: HostResponseTypes.CuaOperationState,
      ...event,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["cuaOperationStateReporter"];

// [并发] 无法定位 task meta 的 sendPrompt 只做计数：它们没有 workspace 身份，
// 因此只能参与退出诊断，绝不能参与 workspace runtime 的释放裁决（否则会误回收别人的 runtime）。
// 计数用 max(0, n-1) 保护下界，防止异常路径重复递减导致负数。
let untrackedPromptRpcCount = 0;
function reportHostRunningTaskCount(): void {
  runtimeTaskReporter.onRunningTaskCountChanged({
    runningTaskCount: workspaceTaskTracker.getTotalRunningTaskCount() + untrackedPromptRpcCount,
  });
}

// 一处变更三处消费：Main（退出屏障）、远端 registry（按 workspace 汇总）、本机聚合计数。
// [权衡] 用回调扇出而不是让三个消费方各自订阅 service：扇出点唯一，顺序可控，也避免重复计算。
const workspaceTaskTracker = createHostWorkspaceTaskTracker((event) => {
  parentPort?.postMessage({
    type: HostResponseTypes.WorkspaceRunningTaskCountChanged,
    ...event,
  });
  windowRemoteConnectionRegistry.setWorkspaceRunningTaskCount(event);
  reportHostRunningTaskCount();
});

// 类型守卫只校验三个字符串字段，不做完整 schema 校验：它的用途是从任意 RPC 返回值里
// 捞出「像 task meta」的对象，误判的代价只是多记一条路由，漏判的代价是丢整个 workspace 归因。
function isZCodeTaskMeta(value: unknown): value is ZCodeTaskMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "workspacePath" in value &&
    "traceId" in value &&
    typeof (value as { taskId?: unknown }).taskId === "string" &&
    typeof (value as { workspacePath?: unknown }).workspacePath === "string" &&
    typeof (value as { traceId?: unknown }).traceId === "string"
  );
}

// [权衡] 镜像批次与整包快照都携带「同一批事件」，再镜像一次等于把 N 条流放大成 N+1 条；
// 这里用黑名单而不是白名单，是为了让新增的事件类型默认被镜像（漏镜像比多镜像更难发现）。
function isRemoteMirrorableStreamEvent(
  event: ZCodeStreamEvent,
): event is TaskStreamMirrorableEvent {
  return event.type !== "task_stream_mirror_batch" && event.type !== "task_snapshot_updated";
}

// [权衡] 用 Proxy 而不是手写委托子类：远端 task service 的方法集会随协议演进，
// 逐方法转发会长期漂移；Proxy 只拦截需要额外行为的几个方法，其余原样透传。
// [并发] 包装层持有 workspaceProxyState，它的 key 是 workspace 而不是 connection，
// 因此重连换代后旧 workspace 的 meta 仍可被新 services 使用。
// 这条链路属于「读路径增强」，任何拦截都必须返回原始结果，不能改写业务字段。
function createReportingRemoteZCodeTaskService<T extends object>(
  service: T,
  options?: {
    reportRunningPromptCount?: boolean;
    taskRealtimePort?: ReturnType<typeof createTaskRealtimeBridgeForHostInit>;
    materializePromptAttachments?: (params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    }) => Promise<{ content: string; attachments?: ZCodePromptAttachment[] }>;
  },
): T {
  const workspaceProxyState = createHostRemoteWorkspaceProxyState();

  // [失败路径] 这条通道没有回执：main 侧只是把请求转投给目标窗口，失败由对端以 DeliveryResult 回来。
  // 因此这里不 try/catch，parentPort 已断时整条链路正在退出，静默丢弃与会话关闭语义一致。
  function forwardSessionMessageRequest(request: unknown): void {
    parentPort?.postMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request,
    });
  }

  // [资源] 每个 workspace 只订阅一次（ensureWorkspaceSubscription 去重），订阅句柄挂在 proxy state 上，
  // 由 releaseWorkspacePreparation 统一释放；在每次 rememberTaskMeta 里直接 subscribe 会随任务数线性泄漏。
  // [权衡] onDynamicWorkspaceEvent 是可选能力，旧远端服务没有它时直接跳过，不能因此让 createTask 失败。
  function subscribeSessionMessageRequests(target: T, meta: ZCodeTaskMeta): void {
    const onDynamicWorkspaceEvent = Reflect.get(target, "onDynamicWorkspaceEvent");
    if (typeof onDynamicWorkspaceEvent !== "function") {
      return;
    }
    const subscribe = onDynamicWorkspaceEvent.call(target, {
      workspacePath: meta.workspacePath,
      ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    });
    if (typeof subscribe !== "function") {
      return;
    }
    workspaceProxyState.ensureWorkspaceSubscription(meta, () =>
      subscribe((event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "workspace_session_message_send_requested"
        ) {
          forwardSessionMessageRequest((event as { request?: unknown }).request);
        }
      }),
    );
  }

  // 一次 createTask/resumeTask 的返回值就把三件事定下来：路由缓存、workspace 订阅、Main 侧 session 路由公告。
  // [事务] 公告只带 sessionId，不带 workspace：Main 用 sessionId 决定把后续 send 消息投给哪个窗口，
  // 多带字段会让路由表在 workspace 移动后留下过期条目。
  function rememberTaskMeta(result: unknown): void {
    if (isZCodeTaskMeta(result)) {
      workspaceProxyState.rememberTaskMeta(result);
      subscribeSessionMessageRequests(service, result);
      parentPort?.postMessage({
        type: HostResponseTypes.SessionRouteAnnounce,
        route: {
          sessionId: result.taskId,
        },
      });
    }
  }

  // [权衡] 返回值形状在不同协议版本里是 task / {items} / {snapshot} / 数组四种之一，
  // 这里做的是「尽力而为的广度遍历」而不是严格解析：漏记一条路由只会让该会话无法跨窗口续聊，
  // 而严格解析一旦遇到新形状就会让 listTasks 整体失败，代价高得多。
  function rememberTaskMetasFromResult(result: unknown): void {
    if (Array.isArray(result)) {
      for (const item of result) {
        rememberTaskMetasFromResult(item);
      }
      return;
    }
    rememberTaskMeta(result);
    if (typeof result !== "object" || result === null) {
      return;
    }
    const items = (result as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const item of items) {
        rememberTaskMeta(item);
      }
    }
    const snapshot = (result as { snapshot?: unknown }).snapshot;
    if (typeof snapshot === "object" && snapshot !== null) {
      rememberTaskMeta((snapshot as { meta?: unknown }).meta);
    }
    rememberTaskMeta((result as { meta?: unknown }).meta);
  }

  // [事务] 附件在本机（Desktop）而执行在远端，必须在进入 RPC 之前完成 staging 物化，
  // 否则远端拿到的是本机绝对路径，模型读到的文件不存在。
  // [失败路径] 物化失败直接向上抛，让这次 prompt 明确失败；吞掉后远端会以「附件缺失」继续跑，
  // 用户最后看到的是一次内容残缺的回答。
  async function prepareRemotePromptParams(params: {
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }): Promise<{
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }> {
    if (!options?.materializePromptAttachments) {
      return params;
    }
    return {
      ...params,
      ...(await options.materializePromptAttachments(params)),
    };
  }

  // 远端 prompt 的本地镜像：先租到 workspace 的实时通道，再把 user_message 与后续 stream_event
  // 转给手机 relay。租约拿不到（或通道未注入）时退回直连调用，保证功能降级而不是不可用。
  // [事务] publish 必须先于 sendPrompt：事件顺序反了，手机端会先收到 assistant 流再收到 user 消息。
  // [资源] finally 里同时释放 stream 订阅与租约，二者必须成对，否则 relay 会一直认为该 workspace 忙。
  async function mirrorRemotePrompt(
    target: T,
    sendPrompt: (...args: unknown[]) => Promise<unknown>,
    params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    },
  ): Promise<unknown> {
    const taskRealtimePort = options?.taskRealtimePort;
    const meta = workspaceProxyState.getTaskMeta(params.taskId);
    if (!taskRealtimePort || !meta) {
      return sendPrompt.call(target, params);
    }

    const mirrorTarget = {
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      workspaceKey: resolveWorkspaceKey(meta),
      taskId: params.taskId,
      runId: params.traceId,
      traceId: params.traceId,
    };
    const leaseResult = await taskRealtimePort
      .acquireTaskRunLease(mirrorTarget)
      .catch((error: unknown) => {
        logger.warn("Bot remote runtime realtime lease failed:", error);
        return null;
      });
    if (!leaseResult?.acquired) {
      return sendPrompt.call(target, params);
    }

    taskRealtimePort.publishStreamOp(mirrorTarget, {
      kind: "user_message",
      messageId: `user-${params.traceId}`,
      content: params.content,
      attachments: params.attachments,
      timestamp: Date.now(),
    });

    // 写路径（send/stop/交互回执）已收敛 v4 命令面；本镜像属**读路径**——
    // taskRealtimePort → 手机 relay → 手机端
    // zcodeSessionStore 的整条消费链词表都是 ZCodeStreamEvent。两个方案的评估结论：
    // a) relay 直接转发 v4 帧、手机端消费 v4 store（正解）：需要重做 relay stream-op
    //    协议 + 手机端 store；
    // b) 帧→ZCodeStreamEvent 薄映射：等价复刻 adapter mapSessionEvent，
    //    否决。
    // 结论：本镜像保持 legacy 源不动。
    const dynamicStreamEvent = Reflect.get(target, "onDynamicStreamEvent");
    const streamDisposable =
      typeof dynamicStreamEvent === "function"
        ? dynamicStreamEvent.call(
            target,
            params.taskId,
          )((event: ZCodeStreamEvent) => {
            if (isRemoteMirrorableStreamEvent(event)) {
              taskRealtimePort.publishStreamOp(mirrorTarget, {
                kind: "stream_event",
                event,
              });
            }
          })
        : null;

    try {
      return await sendPrompt.call(target, params);
    } finally {
      // 远端 zcode-server 没有 desktop realtime port；由窗口 Host 内的
      // remote facade 接管 lease 和 stream mirror，确保 UI 能持续收到远端会话流。
      streamDisposable?.dispose();
      taskRealtimePort.releaseTaskRunLease(mirrorTarget);
    }
  }

  // [资源] 先释放 ready 订阅再减计数：反过来的话计数归零会先触发 workspace release，
  // 而 release 期间 ready 回调仍可能到达并访问已被清理的 services。
  function finishWorkspaceTask(taskId: string, meta: ZCodeTaskMeta): void {
    workspaceProxyState.disposeTaskReadySubscription(taskId);
    workspaceTaskTracker.finish(taskId, meta);
  }

  // [事务] begin 与 finish 必须严格配对，因此两处「不可订阅」的抛错前都先 finish 回滚计数；
  // 漏掉回滚会让 runningTaskCount 单调增长，Host 退出时永远等不到 0。
  // [并发] tracker.begin 返回 false 表示该 taskId 已在计数中，此时直接返回 false，不再重复订阅。
  function beginWorkspaceTask(target: T, taskId: string, meta: ZCodeTaskMeta): boolean {
    const started = workspaceTaskTracker.begin(taskId, meta);
    if (!started) {
      return false;
    }
    const onDynamicTaskReady = Reflect.get(target, "onDynamicTaskReady");
    if (typeof onDynamicTaskReady !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task service does not expose onDynamicTaskReady");
    }
    const subscribe = onDynamicTaskReady.call(target, taskId);
    if (typeof subscribe !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task ready event is not subscribable");
    }
    workspaceProxyState.trackTaskReady(
      taskId,
      meta,
      (listener) => subscribe(listener),
      () => finishWorkspaceTask(taskId, meta),
    );
    return true;
  }

  // remote workspace 的 ZCode Agent manager 跑在远端 server，desktop main 不能直接看到
  // `handles` 状态。sendPrompt Promise 只是远端 ACK，必须等待 task ready 才能允许回收 workspace。
  // [权衡] 只拦截三类方法：创建/恢复（需要记路由）、sendPrompt（需要镜像与附件物化）、
  // 以及运行计数；其余方法原样绑定返回，避免代理层成为事实上的二次实现。
  // [失败路径] 拦截器一律 await 原方法后再做副作用，保证「业务失败不产生路由」；
  // 反过来的话一次失败的 createTask 也会在 Main 留下指向不存在会话的路由。
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === "createTask" || property === "resumeTask") && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMeta(result);
          return result;
        };
      }
      if (
        (property === "listTasks" ||
          property === "listPinnedTasks" ||
          property === "listTaskList" ||
          property === "listArchivedTasks" ||
          property === "getTaskMeta" ||
          property === "getTaskSnapshot" ||
          property === "getTaskSnapshotWithEtag") &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMetasFromResult(result);
          return result;
        };
      }
      if (property === "releaseWorkspacePreparation" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          const context = args[0];
          if (
            typeof context === "object" &&
            context !== null &&
            typeof (context as { workspacePath?: unknown }).workspacePath === "string"
          ) {
            const workspaceContext = context as {
              workspacePath: string;
              workspaceIdentity?: string;
            };
            // pooled Host 不随 tab 退出；runtime 成功释放后必须同步解除 Host 代理层引用，
            // 否则 task meta 和动态事件 listener 会在整个应用生命周期内单调增长。
            workspaceProxyState.clearWorkspace(workspaceContext);
            workspaceTaskTracker.clearWorkspace(workspaceContext);
          }
          return result;
        };
      }
      const shouldWrapSendPrompt =
        options?.reportRunningPromptCount !== false ||
        Boolean(options?.taskRealtimePort) ||
        Boolean(options?.materializePromptAttachments);
      if (property !== "sendPrompt" || typeof value !== "function" || !shouldWrapSendPrompt) {
        return value;
      }

      return async (...args: unknown[]) => {
        let trackedTask: { taskId: string; meta: ZCodeTaskMeta; started: boolean } | undefined;
        let tracksOnlyRpcLifetime = false;
        try {
          const params = args[0];
          if (
            typeof params === "object" &&
            params !== null &&
            typeof (params as { taskId?: unknown }).taskId === "string" &&
            typeof (params as { traceId?: unknown }).traceId === "string" &&
            typeof (params as { content?: unknown }).content === "string"
          ) {
            const promptParams = params as {
              taskId: string;
              traceId: TraceId;
              content: string;
              attachments?: ZCodePromptAttachment[];
            };
            const taskMeta = workspaceProxyState.getTaskMeta(promptParams.taskId) as
              | ZCodeTaskMeta
              | undefined;
            if (taskMeta) {
              trackedTask = {
                taskId: promptParams.taskId,
                meta: taskMeta,
                started: beginWorkspaceTask(target, promptParams.taskId, taskMeta),
              };
            } else if (options?.reportRunningPromptCount !== false) {
              // task meta 缺失时无法安全伪造 workspace identity；仅保留 ACK 期间的 Host 退出诊断，
              // 不让该 fallback 参与 workspace runtime 的释放裁决。
              tracksOnlyRpcLifetime = true;
              untrackedPromptRpcCount += 1;
              reportHostRunningTaskCount();
            }
            const preparedParams = await prepareRemotePromptParams(promptParams);
            return await mirrorRemotePrompt(
              target,
              value.bind(target) as (...promptArgs: unknown[]) => Promise<unknown>,
              preparedParams,
            );
          }
          if (options?.reportRunningPromptCount !== false) {
            tracksOnlyRpcLifetime = true;
            untrackedPromptRpcCount += 1;
            reportHostRunningTaskCount();
          }
          return await value.apply(target, args);
        } catch (error) {
          if (trackedTask?.started) {
            finishWorkspaceTask(trackedTask.taskId, trackedTask.meta);
          }
          throw error;
        } finally {
          if (tracksOnlyRpcLifetime) {
            untrackedPromptRpcCount = Math.max(0, untrackedPromptRpcCount - 1);
            reportHostRunningTaskCount();
          }
        }
      };
    },
  });
}

// [权衡] 预热是 fire-and-forget：它只为把 Agent 二进制的首次启动成本提前，
// 失败不应影响任何用户路径，因此内部整段 try/catch 且只记 debug。
// [资源] 预热进程由 Agent manager 统一回收，这里不持有句柄，避免与真实会话的生命周期混淆。
function warmUpZCodeAgent(
  services: ServiceCollection,
  context: { workspacePath?: string; workspaceIdentity?: string },
  reason: string,
): void {
  if (!context.workspacePath) {
    return;
  }
  const workspacePath = context.workspacePath;
  const workspaceIdentity = context.workspaceIdentity;
  const zcodeSessionService = services.getOptional(IZCodeSessionService);
  if (!zcodeSessionService) {
    return;
  }
  void zcodeSessionService
    .initializeWorkspace({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .then((result) => {
      if (!result.available) {
        if (result.reasonCode === "provider_not_ready") {
          logger.info(
            `ZCode agent warmup waiting for provider/model (${reason}) workspace=${workspacePath}`,
          );
          return;
        }
        logger.warn(
          `ZCode agent warmup unavailable (${reason}) workspace=${workspacePath} reason=${result.reason ?? "unknown"}`,
        );
        return;
      }
      // 模型候选和首选项已经由目标 Host ModelSelectionView 提供；workspace
      // presentation 只剩 mode 与 slash commands。预热不能为读取 presentation 额外创建
      // Agent App，否则其 MCP close 会占住协议通道并阻塞真正的 Session 初始化。
      logger.info(
        `ZCode agent warmup ready (${reason}) workspace=${workspacePath} transport=${result.transportKind ?? "unknown"}`,
      );
    })
    .catch((error) => {
      logger.warn(`ZCode agent warmup failed (${reason}) workspace=${workspacePath}:`, error);
    });
}

// 后台输出轮询仍需独立的 debug logger，不能随其他日志调用方移除而丢失工厂导入。
// RPC 调试日志单独走一条通道，便于线上按 level=debug 打开而不影响 Host 主日志的级别。
// [权衡] 不把它并入 logger：RPC 帧的吞吐量远高于业务日志，混在一起会淹没关键错误。
const rpcDebugLogger = createServiceLogger("rpc");

// [权衡] 用 debug 级别而不是 info：RPC 日志只在排障时打开，生产默认不落盘；
// 但仍然先经过 writeHostLog，保证时间戳与 pid 前缀和其他日志同源。
function logRpc(message: string, ...args: unknown[]): void {
  const level = resolveRpcLogLevel(message, ...args);
  if (level === "debug") {
    rpcDebugLogger.debug(undefined, message, ...args);
    return;
  }
  logger[level](message, ...args);
}

// [资源] 日志里只允许出现 host/port/kind，绝不允许把 token、密码或私钥路径拼进去：
// 这条日志会被写进可导出的诊断包，泄露凭据等于把用户的服务器交出去。
// [权衡] 因此这里返回的是「可读摘要」而不是序列化结果，新增字段必须逐个显式判断。
function formatRemoteTargetForLog(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `wsl:${distro}:${user}` : `wsl:${distro}`;
    }
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return `server:${target.name?.trim() || target.url}`;
  }
}

// [权衡] 保留原方法调用而不是自己 format：console 的格式化（%s、对象展开）由运行时处理，
// 自己实现必然与 Node 行为不一致，排障时会看到两套格式。
console.log = (...args: unknown[]) => {
  rawConsole.log(...args);
  reportHostLog("info", args);
};

// [权衡] warn 同时落本地与上报：它是「可恢复异常」的唯一记录点，只落本地会在远程诊断里缺失。
console.warn = (...args: unknown[]) => {
  rawConsole.warn(...args);
  reportHostLog("warn", args);
};

// [失败路径] 这里多做一次「是否已被 process warning listener 覆盖」的判断，
// 否则同一条 Node warning 会同时产生 warn 与 error 两条记录，错误率统计被系统性放大。
// [权衡] 判定失败时宁可少报也不重复报：宁可缺失一条，也不要让看板失真。
console.error = (...args: unknown[]) => {
  rawConsole.error(...args);
  // Electron 会把 Node warning 先走 console.error，而 process warning listener 随后还会
  // 结构化记录 warn；若这里继续上报，就会为同一个 warning 留下一条 error 和一条 warn。
  if (!shouldReportHostConsoleError(args)) {
    return;
  }
  reportHostLog("error", args);
};

/** 当前 host 已注册的服务集合，进程退出时用于统一回收本地资源 */
// [事务] 本地数据库启动协调器的唯一实例。undefined 表示「尚未收到 InitLocal」，
// 非 undefined 表示初始化已开始或已完成；它是 INV-01 成立与否的判据，不能被重置为 undefined。
let databaseStartup: ReturnType<typeof createHostDatabaseStartup> | undefined;
// [资源] 数据库未 ready 期间到达的 local attachment 先挂起闭包，ready 时统一播放一次。
// key 用 attachmentId 而不是 requestId：同一个 attachment 可能被 renderer 重试多次，
// 用 requestId 会让重复项一起堆积，ready 时同一个端口被 attach 多次。
// [失败路径] 端口在等待期间关闭时必须删除闭包，否则 close 之后再播放会向已销毁端口注册服务。
const pendingStartupAttachments = new Map<string, () => void>();
let activeServices: ServiceCollection | null = null;
/**
 * Main 推送的实时界面语言，供 ZCode endpoint 请求的 X-Client-Language。
 * 过去 Host 用进程 Intl locale（Dock 启动无 LANG 会回退 en-US）；setting.json 写入可能滞后或失败，
 * 也不能代表当前界面，所以只认 Main 的 InitLocal 初值与 application-locale-changed 变更。
 */
// [并发] 这是 Host 侧唯一可信的语言来源，只由 Main 的消息写入（见 INV-13/14）。
// [权衡] 特意不读 Intl.DateTimeFormat().resolvedOptions().locale：Electron 在 Dock 启动、
// 系统语言切换但未重启时都可能给出与 UI 不一致的值，会把错误语言写进请求头。
// undefined 表示「尚未收到」，下游据此不发 X-Client-Language，而不是猜一个默认值。
let applicationLocale: Locale | undefined;
// [资源] 当前生效的网络传输（代理 + 自签 CA）。它的生命周期与 activeServices 绑定，
// 在 disposeHostResources 的最后被置 null；任何 fetch 调用都必须经 require 函数取，
// 直接缓存这个引用会让设置页改代理后旧连接继续走旧代理。
let activeHostApiNetworkTransport: HostApiNetworkTransport | null = null;
let sourceServerDirectory: SourceServerDirectory | null = null;
let sourceServerConnectionManager: SourceServerConnectionManager | null = null;
let sourceServerManagementService: SourceServerManagementService | null = null;
let sourceServerArtifactPolicy: SourceServerArtifactPolicy = "release-versioned";
const sourceServerDisplayNameById = new Map<string, string>();
let sourceSettingsStateSubscription: IDisposable | null = null;
// [并发] bind 与 cancel 走同一个 parentPort，消息之间没有顺序保证；
// 这个集合记录「正在处理中的 bind」，让先到的 cancel 能立即结算、后到的 cancel 能命中已注册的请求。
// [事务] 三条 settle 路径都必须 delete，否则同一个 requestId 的后续 bind 会被当成重复请求拒绝。
const activeWorkspaceBindRequestIds = new Set<string>();
const cancelledWorkspaceBindRequestIds = new Set<string>();
const workspaceBindAbortControllers = new Map<string, AbortController>();
const projectNavigationAbortControllers = new Map<string, AbortController>();
// [并发] Source 运行时的初始化是单飞：多个窗口同时打开不同远端时只会建一份 manager。
// [失败路径] 失败后必须置回 null，否则一次临时失败会被永久缓存，后续所有连接都拿到同一个 rejected promise。
let sourceServerRuntimeInitializeFlight: Promise<SourceServerConnectionManager> | null = null;

// [权衡] 项目树变更用「无参数通知」而不是增量：Main 侧本来就要重新拉全量，
// 传增量只会让通道两端对同一份状态做两套 diff 逻辑。
// [并发] 多次变更合并成一次重拉由 Main 侧去抖，Host 不做合并，避免丢失最后一次变更。
function notifyProjectChange(): void {
  void activeServices
    ?.get(IBroadcastService)
    .send({ channel: "state:projects", payload: {} })
    .catch((error) => logger.warn("failed to notify project change", error));
}

/** Bot 只取得当前 Source 代际，不拥有连接，也不创建 logical tab。 */
// [失败路径] 这里只返回「连接描述」，不负责建立连接：Bot 的 remote project 连接由
// remoteProjectConnection.connectHost 显式发起，避免一次列表查询就隐式连通用户没打开的机器。
// [权衡] 找不到时返回 undefined 而不是抛错，因为 Bot 列表允许展示离线主机。
function resolveBotProjectConnection(hostId: string): BotProjectConnection | undefined {
  const serverId = parseRemoteWorkspaceIdentity(
    buildRemoteHostWorkspaceIdentity(hostId, "/"),
  )?.sourceServerId;
  if (!serverId) return undefined;
  const registered = windowRemoteConnectionRegistry.getOnlineSource(serverId);
  if (registered) {
    const services = registered.services;
    return {
      owner: registered.capabilities?.physicalOwner?.() ?? services,
      taskService: createControllerRoutedTaskService(services.get(IZCodeTaskService), {
        kind: "local",
      }),
      modelSelectionService: services.get(IModelSelectionService),
      agentService: services.get(IZCodeAgentService),
      bindWorkspace: async (target) => {
        await registered.capabilities?.bindWorkspaceIdentity?.({
          workspacePath: target.workspacePath,
          stableWorkspaceIdentity: target.workspaceIdentity,
          legacyRouteHint: target.workspaceIdentity,
        });
      },
    };
  }
  const connection = sourceServerConnectionManager?.getOnlineConnection(serverId);
  if (!connection) return undefined;
  return {
    owner: connection.services,
    taskService: createControllerRoutedTaskService(connection.services.zcodeTaskService, {
      kind: "local",
    }),
    modelSelectionService: connection.services.modelSelectionService,
    agentService: connection.services.zcodeAgentService,
    bindWorkspace: async (target) => {
      await connection.services.sourceServerWorkspaceService.resolveWorkspace({
        workspacePath: target.workspacePath,
        legacyRouteHint: target.workspaceIdentity,
      });
    },
  };
}

// [失败路径] 没有传输时抛错而不是退回全局 fetch（见 INV-15）：
// 回退会绕过代理与 CA，企业环境下表现为难以复现的 TLS 失败。
function requireActiveHostApiNetworkTransport(): HostApiNetworkTransport {
  if (!activeHostApiNetworkTransport) {
    // Bug 原因：Source Server release 下载若在 Host 网络策略之外回退 global fetch，会绕过设置页代理。
    throw new Error("Window Host network transport is not initialized");
  }
  return activeHostApiNetworkTransport;
}

// [并发] 单飞实现：并发调用共享同一个 Promise，成功后缓存实例。
// [失败路径] catch 里清空 flight 后再抛，保证下一次连接能重新尝试；
// 若只在 then 里赋值，一次失败会让所有后续调用永久拿到 rejected promise。
// [资源] 已进入 shutdown 时直接抛错，禁止在清理途中新建 manager。
async function ensureSourceServerConnectionManager(): Promise<SourceServerConnectionManager> {
  if (sourceServerConnectionManager) return sourceServerConnectionManager;
  if (!sourceServerDirectory) throw new Error("Source Server directory 尚未初始化");
  if (!activeServices) throw new Error("Host services 尚未初始化");
  const directory = sourceServerDirectory;
  const remoteProjects = activeServices.get(IRemoteProjectService);
  sourceServerRuntimeInitializeFlight ??= (async () => {
    await directory.initialize();
    if (hasDisposedHostResources || sourceServerDirectory !== directory) {
      throw new Error("Source Server directory 初始化期间 Host 已释放");
    }
    const manager = new SourceServerConnectionManager({
      directory,
      admitConnection: createRemoteProjectConnectionAdmission(remoteProjects),
      onProjectChange: notifyProjectChange,
      logWarn: (message, error) => logger.warn(message, error),
      sourceServerArtifactPolicy,
      connectServer: (options) =>
        connectDesktopSourceServer(options, {
          resolveServices: (scope) => windowRemoteConnectionRegistry.resolveScopedServices(scope),
          getBots: () => activeServices?.getOptional(IBotsService),
          readDynamicWorkflowMode: async () =>
            (await activeServices?.get(ISettingService).get())?.dynamicWorkflowMode,
          onModeSyncError: (error) =>
            logger.warn("remote dynamic workflow user mode push failed", error),
        }),
    });
    sourceServerConnectionManager = manager;
    return manager;
  })().finally(() => {
    sourceServerRuntimeInitializeFlight = null;
  });
  return await sourceServerRuntimeInitializeFlight;
}
/** 本地 host services 的资源遥测订阅；远端连接的订阅由各自的 connection handle 持有。 */
// [资源] 本地资源遥测订阅的唯一句柄；wire 时先 dispose 旧的再注册新的（INV-45），
// 保证重连或重建 services 后不会出现两份样本。
let activeLocalResourceTelemetry: IDisposable | null = null;
// 资源管理器采样只在 main 请求时执行一次，Host 不维护任何周期定时器。
// [权衡] 资源用量按请求采样（INV-46），不建立定时器：Host 空闲时不应该有周期性唤醒。
// [失败路径] 取消请求要显式转发，否则面板关闭后采样仍在跑并占着 CPU。
const hostResourceUsageResponder = createHostResourceUsageResponder({
  getAgentService: () => activeServices?.getOptional(IZCodeAgentService),
  postMessage: (message) => parentPort?.postMessage(message),
});
let activeSessionRealtimePort: ReturnType<typeof createTaskRealtimeBridgeForHostInit> = null;
// [事务] 关闭屏障标志：一旦置 true，任何新的 InitLocal / attachment / 派发都必须被拒绝。
// 它与 disposeHostResourcesInFlight 一起构成幂等（INV-11）：标志防重入，Promise 让重复调用等待同一次收尾。
let hasDisposedHostResources = false;
let disposeHostResourcesInFlight: Promise<HostShutdownResult> | null = null;

// [失败路径] 关闭失败只记录不上抛：退出路径上再抛错会掩盖真正的退出原因，
// 而连接对象此时已不可复用，重试没有意义。
async function disposeHostRemoteConnection(connection: HostRemoteConnection): Promise<void> {
  connection.dispose();
}

// 建立一条「窗口作用域」的远端连接，返回 handle 而不是裸 services：
// 因为 services 会随 Source 重连换代，调用方必须每次都通过 getter 取当前代际。
// [事务] handle 同时承载事件（close/reconnect）与能力（媒体数据面、附件传输、身份绑定），
// 三者必须来自同一个 connection 代际，混用会让手机端拿到旧 source 的能力。
async function createWindowRemoteConnectionHandle(params: {
  target: RemoteTarget;
  membershipIntent?: "add" | "retain";
  existingSourceServerId?: string;
  remoteAssets: RemoteAssetDirs;
  signal: AbortSignal;
  confirmSourceServerInstall?: boolean;
}): Promise<WindowRemoteConnectionHandle<ServiceCollection, HostRemoteConnectionCapabilities>> {
  if (!activeServices) throw new Error("Local Host services are not initialized.");
  const clientConfigService = activeServices.get(IClientConfigService);
  if (params.signal.aborted) {
    throw new Error("远程连接已取消");
  }
  // [资源] close/reconnect 用 Set 而不是单回调：同一连接会被 registry、窗口 UI、手机镜像多方订阅。
  // [失败路径] 回调抛出会中断后续监听器，因此 notifyClose 内部逐个调用并自行兜住异常边界。
  const closeListeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  let topicResourceRelay: ReturnType<typeof createWindowTopicResourceRelay> | undefined;
  // [资源] 先释放 topic 资源中继再通知：中继持有远端通道，若监听器里同步发起了重连，
  // 旧中继会与新连接争抢同一个 topic 订阅。
  // [事务] 这里不做「只通知一次」的保护，去重责任在调用方（manager 的 retrying 去重），
  // 因为 recoverable 的多次 close 对 UI 是有意义的进度信号。
  const notifyClose = (event: WindowRemoteConnectionCloseEvent) => {
    topicResourceRelay?.dispose();
    for (const listener of closeListeners) {
      listener(event);
    }
  };
  let connection: HostRemoteConnection;
  let managedProfile: import("@zcode/shared").ConnectionProfile | undefined;
  let reusedConnectionTarget: RemoteTarget | undefined;
  let managerStateSubscription: { dispose(): void } | undefined;
  let managerConnectionInvalidatedSubscription: { dispose(): void } | undefined;
  let managerReconnectSubscription: { dispose(): void } | undefined;
  let services: ServiceCollection;
  let resourceTelemetry: IDisposable | undefined;
  const refreshResourceTelemetry = () => {
    resourceTelemetry?.dispose();
    // Source 重连会替换 services；遥测也必须释放旧订阅并挂到新一代代理，避免重连后静默丢样本。
    resourceTelemetry = registerHostServiceResourceTelemetry({
      services,
      postMessage: (message) => parentPort?.postMessage(message),
      runtimeSurface: "remote",
      // SSH/WSL/Docker 也会复用兼容的旧 Source；所有 Server 都须声明能力才订阅新增事件。
      telemetrySupported: connection.serverInfo.capabilities.processResourceTelemetry === true,
      environmentKey: resolveResourceTelemetryEnvironmentKey(
        params.target,
        connection.serverInfo.serverId,
      ),
      onError: (error) => logger.warn("remote resource telemetry subscription failed", error),
    });
  };
  // [并发] 用「已通知过的退避轮次」做去重（INV-18）：同一轮 retrying 只上报一次，
  // 回到 online 时清零，让下一轮故障重新计数。
  // [资源] 必须「先释放旧的再挂新的」（INV-17/45）：Source 重连后 services 已换代，
  // 旧订阅还指向已销毁的代理，继续保留既拿不到样本，也会在释放时抛错。
  // [权衡] telemetrySupported 从 serverInfo.capabilities 读：旧版 Source 没有该字段，
  // 硬订阅会让每次采样都收到 method not found，反而制造噪音。
  // [并发] 用「已通知过的退避轮次」做去重（INV-18）：同一轮 retrying 只上报一次，
  // 回到 online 时清零，让下一轮故障重新计数。
  // [资源] 必须「先释放旧的再挂新的」（INV-17/45）：Source 重连后 services 已换代，
  // 旧订阅还指向已销毁的代理，继续保留既拿不到样本，也会在释放时抛错。
  // [权衡] telemetrySupported 从 serverInfo.capabilities 读：旧版 Source 没有该字段，
  // 硬订阅会让每次采样都收到 method not found，反而制造噪音。
  // [并发] 用「已通知过的退避轮次」做去重（INV-18）：同一轮 retrying 只上报一次，
  // 回到 online 时清零，让下一轮故障重新计数。
  // [资源] 必须「先释放旧的再挂新的」（INV-17/45）：Source 重连后 services 已换代，
  // 旧订阅还指向已销毁的代理，继续保留既拿不到样本，也会在释放时抛错。
  // [权衡] telemetrySupported 从 serverInfo.capabilities 读：旧版 Source 没有该字段，
  // 硬订阅会让每次采样都收到 method not found，反而制造噪音。
  let lastNotifiedRecoveryAttempt = 0;
  let disposed = false;
  let sourceClosed = false;
  let projectSubscription: { dispose(): void } | undefined;
  // [事务] 只在「当前在线 Source 仍是自己这一代」时 detach（INV-36）：
  // 重连后 registry 已经换成新 services，此时旧句柄的关闭不能拆掉新 attachment。
  // [权衡] 用 services 引用相等而不是 connectionId 比较，因为 connectionId 在换代时会变，
  // 而「同一份 services 对象」正好就是 attachment 真正绑定的东西。
  const detachOwnSourceSettings = () => {
    const sourceId = connection?.serverInfo.serverId;
    if (!sourceId || params.target.kind !== "server") return;
    const current = windowRemoteConnectionRegistry.getOnlineSource(sourceId);
    if (!current || current.services === services)
      windowHostAttachmentRegistry.detachSourceSettingsAttachments(sourceId);
  };
  // [事务] server 直连与 source 托管是两条完全不同的生命周期：前者自带连接管理，
  // 后者只是 manager 的一条 lease。用一个函数分叉，避免把两种 owner 语义混在同一个 dispose 里。
  // [失败路径] existingSourceServerId 与 server 直连同时出现时直接抛错：两者语义冲突，
  // 继续执行会让 registry 同时持有一条直连与一条托管连接。
  if (params.target.kind === "server") {
    if (params.existingSourceServerId) throw new Error("project.host-offline");
    if (!activeServices) throw new Error("Host services 尚未初始化");
    const admission = await prepareRemoteServerConnection({
      service: activeServices.get(IRemoteProjectService),
      credentials: activeServices.get(ICredentialService),
      target: params.target,
      intent: params.membershipIntent ?? "add",
    });
    params.signal.throwIfAborted();
    topicResourceRelay = createWindowTopicResourceRelay({
      getPeerAgentService: () => connection?.services.zcodeAgentService,
      resolveServices: (scope) => windowRemoteConnectionRegistry.resolveScopedServices(scope),
      getBots: () => activeServices?.getOptional(IBotsService),
    });
    try {
      connection = await connectServerRemote(admission.target, {
        signal: params.signal,
        fetchImpl: requireActiveHostApiNetworkTransport().fetch,
        commitMembership: admission.commit,
        topicResourceChannel: topicResourceRelay.channel,
        onClose: ({ code, reason }) => {
          sourceClosed = true;
          detachOwnSourceSettings();
          notifyClose({ exitCode: code, signal: null, ...(reason ? { error: reason } : {}) });
        },
      });
    } catch (error) {
      topicResourceRelay.dispose();
      throw error;
    }
  } else {
    if (!sourceServerDirectory) {
      throw new Error("Source Server manager 尚未初始化");
    }
    const manager = await ensureSourceServerConnectionManager();
    // [事务] 只登记 manager 里仍在线的连接，绝不在这里新建：project 导航要求「复用现有物理连接」，
    // 新建会让一次目录选择触发一次 SSH 登录，用户会看到重复的密码/主机指纹提示。
    // [失败路径] profile 与 connection 任一缺失都按 project.host-offline 失败，不回退直连。
    const existingProfile = params.existingSourceServerId
      ? (await sourceServerDirectory.snapshot()).profiles.find(
          (item) => item.sourceServerId === params.existingSourceServerId,
        )
      : undefined;
    const existingConnection = params.existingSourceServerId
      ? manager.getOnlineConnection(params.existingSourceServerId)
      : undefined;
    if (params.existingSourceServerId && (!existingProfile || !existingConnection))
      throw new Error("project.host-offline");
    const { profile, connection: managed } =
      existingProfile && existingConnection
        ? { profile: existingProfile, connection: existingConnection }
        : await connectSourceServerTarget(sourceServerDirectory, manager, {
            membershipIntent: params.membershipIntent,
            target: params.target,
            allowInstall: params.confirmSourceServerInstall === true,
            resolveRelease: async (probe, target, options) =>
              await resolveSourceServerReleaseAsset(
                probe,
                params.remoteAssets,
                target,
                {
                  fetch: requireActiveHostApiNetworkTransport().fetch,
                },
                options,
              ),
            context: {
              signal: params.signal,
              onLog: (event) => {
                const progress =
                  event.progress == null
                    ? ""
                    : ` ${(Math.max(0, Math.min(1, event.progress)) * 100).toFixed(1)}%`;
                const message =
                  event.progress == null || event.message.startsWith("upload progress:")
                    ? `[source-server:${event.phase}] ${event.message}`
                    : `[source-server:${event.phase}] upload progress (${event.message}):${progress}`;
                remoteConnectionProgressContext.report(event.level ?? "info", [message]);
              },
            },
          });
    managedProfile = profile;
    reusedConnectionTarget = managed.reusedConnectionTarget;
    const sourceDirectorySnapshot = await sourceServerDirectory.snapshot();
    for (const server of sourceDirectorySnapshot.servers) {
      sourceServerDisplayNameById.set(server.sourceServerId, server.displayName);
    }
    // [并发] 状态回调是全局广播，必须先用 profileId 过滤（同一 manager 可能托管多个 Source）。
    // [失败路径] retrying 事件用 recoveryAttempt 去重（INV-18）；online 时清零计数，
    // 让「恢复后再故障」能被重新通知，而不是被历史轮次永久压住。
    managerStateSubscription = manager.onDidChangeState((state) => {
      if (state.profileId !== profile.profileId) return;
      if (state.state === "online") {
        lastNotifiedRecoveryAttempt = 0;
        return;
      }
      const closeEvent = createSourceServerRecoveryCloseEvent(state);
      if (!closeEvent) return;
      if (state.state === "retrying" && state.recoveryAttempt === lastNotifiedRecoveryAttempt) {
        return;
      }
      if (state.state === "retrying") {
        lastNotifiedRecoveryAttempt = state.recoveryAttempt ?? lastNotifiedRecoveryAttempt;
      }
      notifyClose(closeEvent);
    });
    connection = {
      serverInfo: managed.serverInfo,
      services: managed.services,
      dispose() {
        // Bug 原因：Window registry handle 是 logical/attachment lease，不是 Source connection owner。
        // 旧 entry 取消或迟到恢复时若调用 manager.disconnect，会拆掉新 entry 正在共享的
        // Source。真实物理连接由 SourceServerConnectionManager 在显式断开或 Host shutdown 回收。
      },
    };
    // [事务] 失效分两种：update（可恢复，UI 应保留并等待重连）与删除 Profile（用户显式断开，终态）。
    // 用 recoverable 字段把两者区分开，而不是让上层根据 error code 猜。
    // [失败路径] disposed 之后不再通知：此时监听器集合已被清空，再发会让 UI 收到已注销句柄的事件。
    managerConnectionInvalidatedSubscription = manager.onDidInvalidateConnection((event) => {
      if (event.sourceServerId !== managed.sourceServerId || disposed) return;
      // Bug 原因：物理 Source connection 被更新或其当前 Profile 被删除时，若不先按
      // Source 通知 Registry，已有 logical workspace 会继续以 online 状态持有失效 services。
      // 更新允许恢复；删除当前 Profile 属于用户显式断开，必须发布 terminal close。
      notifyClose({
        exitCode: null,
        signal: null,
        recoverable: event.reason === "update",
      });
    });
    // [事务] 重连是「整体换代」：先换 connection，再重建 services，最后重挂遥测；
    // 顺序反了会让 refreshResourceTelemetry 读到旧 connection 的 capabilities。
    // [并发] 换代完成后统一通知 reconnect 监听器，保证它们看到的是已经完整的 services。
    // [失败路径] 只处理 sourceServerId 匹配且未 disposed 的事件，迟到事件一律忽略。
    managerReconnectSubscription = manager.onDidReconnect((reconnected) => {
      if (reconnected.sourceServerId !== managed.sourceServerId || disposed) return;
      connection = {
        serverInfo: reconnected.serverInfo,
        services: reconnected.services,
        dispose() {
          // 同上：只释放当前 wrapper 的订阅，不跨 lease 关闭共享 Source。
        },
      };
      services = createServerRemoteWorkspaceServiceCollection({
        clientConfigService,
        connectionServices: reconnected.services,
        virtualProjects: reconnected.serverInfo.capabilities.virtualProjects,
        serverId: reconnected.serverInfo.serverId,
        sourceServices: activeServices ?? undefined,
        targetKind: params.target.kind,
      });
      refreshResourceTelemetry();
      lastNotifiedRecoveryAttempt = 0;
      for (const listener of reconnectListeners) listener();
    });
  }

  if (params.signal.aborted) {
    topicResourceRelay?.dispose();
    await disposeHostRemoteConnection(connection);
    throw new Error("远程连接已取消");
  }

  services = createServerRemoteWorkspaceServiceCollection({
    clientConfigService,
    connectionServices: connection.services,
    virtualProjects: connection.serverInfo.capabilities.virtualProjects,
    serverId: connection.serverInfo.serverId,
    targetKind: params.target.kind,
    sourceServices: activeServices ?? undefined,
  });
  if (params.target.kind === "server") {
    projectSubscription = connection.services.broadcastService.onMessage((event) => {
      if (!disposed && !sourceClosed && event.channel === "state:projects") notifyProjectChange();
    });
  }
  refreshResourceTelemetry();
  // 桌面 attachment 对远端媒体走 Host loopback Range 数据面；services 会随 Source 重连换代，
  // 工厂在调用时再取当前 file service。server 直连保持 renderer inline 读取。
  // [权衡] 数据面按 clientMode 选择（INV-42）：桌面端走 Host loopback Range，手机端保持 inline。
  // 手机端拿 loopback 地址必然 404，因为那台机器上根本没有这个监听端口。
  // [资源] 工厂是惰性调用：每次都从当前 services 取 fileService，天然跟随重连换代。
  const remoteMediaPreviewFactory =
    params.target.kind === "server" || !remoteMediaRangePreviewEnabled
      ? undefined
      : (scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>) =>
          createRemoteMediaPreviewProxy({
            fileService: services.get(IFileService),
            logger: {
              debug: (message, metadata) => {
                if (process.env.NODE_ENV !== "production") logger.info(message, metadata);
              },
              warn: (message, metadata) => logger.warn(message, metadata),
            },
            scope,
            requestLimiter: hostRemoteMediaRequestLimiter,
          });

  return {
    ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
    get services() {
      return services;
    },
    // [事务] capabilities 是「这个 handle 能提供什么」的唯一声明面，registry 与 attachment 都只读它。
    // physicalOwner 返回的是底层连接服务而不是代理后的 services，专门用于判断「两条 lease 是否同源」。
    capabilities: {
      sourceServerId: connection.serverInfo.serverId,
      physicalOwner: () => connection.services,
      ...(remoteMediaPreviewFactory ? { remoteMediaPreviewFactory } : {}),
      persistentSourceConnection: true,
      ...(managedProfile ? { profileId: managedProfile.profileId } : {}),
      ...(managedProfile
        ? {
            promptAttachmentTransferFactory: (
              scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
            ) => {
              if (!sourceServerConnectionManager) throw new Error("Source Server is unavailable");
              return createRemotePromptAttachmentTransferService(
                sourceServerConnectionManager.getFileTransfer(connection.serverInfo.serverId),
                {
                  scope,
                  onJanitorError: (error) => logger.warn("remote attachment janitor failed", error),
                },
              );
            },
          }
        : {}),
      ...(managedProfile && sourceServerDirectory
        ? {
            bindWorkspaceIdentity: async (input) => {
              input.signal?.throwIfAborted();
              const currentRouteHint = buildRemoteWorkspaceIdentity(
                input.workspacePath,
                params.target,
              );
              const legacyRouteHint = await sourceServerDirectory!.resolveLegacyWorkspaceIdentity({
                profileId: managedProfile!.profileId,
                workspacePath: input.workspacePath,
                fallback: input.legacyRouteHint ?? currentRouteHint,
              });
              input.signal?.throwIfAborted();
              await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                workspacePath: input.workspacePath,
                legacyRouteHint,
              });
            },
          }
        : {
            bindWorkspaceIdentity: async (input) => {
              await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                workspacePath: input.workspacePath,
              });
            },
          }),
      ...(managedProfile && sourceServerDirectory
        ? {
            recordWorkspaceOpen: async (input) => {
              await sourceServerDirectory?.recordWorkspaceOpen({
                profileId: managedProfile!.profileId,
                sourceServerId: connection.serverInfo.serverId,
                ...input,
              });
            },
          }
        : {}),
    },
    // [资源] 订阅返回 disposable 而不是「取消订阅函数」：调用方可以统一放进 cleanup 列表，
    // 不必为不同事件类型写两套解绑代码。
    onDidClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    onDidReconnect(listener) {
      reconnectListeners.add(listener);
      return { dispose: () => reconnectListeners.delete(listener) };
    },
    // [资源] handle 的释放顺序是固定的：先 detach settings、再释放 relay、再清监听集合、
    // 最后才释放底层连接（INV-04）。反过来会让监听器在连接已关闭后再收到事件。
    // [事务] disposed 标志保证重复 dispose 无副作用；projectSubscription 与三个 manager 订阅
    // 必须逐个 dispose，清空集合不会解除底层监听。
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      detachOwnSourceSettings();
      topicResourceRelay?.dispose();
      closeListeners.clear();
      reconnectListeners.clear();
      managerStateSubscription?.dispose();
      managerConnectionInvalidatedSubscription?.dispose();
      managerReconnectSubscription?.dispose();
      projectSubscription?.dispose();
      resourceTelemetry?.dispose();
      await disposeHostRemoteConnection(connection);
    },
  };
}

// [事务] registry 是窗口内所有远端 connection 与 logical session 的唯一 owner（INV-11/16）。
// 它把「连接」与「workspace 作用域」分开：同一 Source 物理连接可以承载多个 logical session。
// [权衡] releaseWorkspace 走 IZCodeTaskService 而不是直接杀进程，是为了让 Agent manager
// 有机会把未完成的 turn 落盘，WSL 场景下粗暴回收会丢掉最后的写回。
const windowRemoteConnectionRegistry = createWindowRemoteConnectionRegistry<
  ServiceCollection,
  HostRemoteConnectionCapabilities
>({
  connect: (request) => createWindowRemoteConnectionHandle(request),
  createId: randomUUID,
  onConnectionChanged: notifyProjectChange,
  resolveSourceServerId: (handle) => handle.capabilities?.sourceServerId,
  shouldKeepConnectionAlive: (handle) => handle.capabilities?.persistentSourceConnection === true,
  prepareWorkspaceIdentity: async (handle, input) => {
    await prepareRemoteWorkspaceIdentity(
      handle.services.get(IFileService),
      input,
      handle.capabilities?.bindWorkspaceIdentity,
    );
  },
  releaseWorkspace: async (services, context) => {
    await services.get(IZCodeTaskService).releaseWorkspacePreparation({
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      provider: "glm",
    });
    logger.info(
      `released WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
    );
  },
  onWorkspaceReleaseError: (context, error) => {
    logger.warn(
      `failed to release WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
      error,
    );
  },
  // [资源] logical session 离线时 attachment 仍持有旧 services 与订阅，且无法再按 sessionId 找回；
  // 因此必须在失效源头统一关闭所有 clientMode 的端口（INV-05），而不是等下一次 attach 覆盖。
  // [事务] 只有同时具备 workspacePath 与 workspaceIdentity 时才通知 Controller 断开，
  // 缺一不可：半条 scope 会让 Controller 把 source 归到错误的 workspace 上。
  onSessionClosed: (event) => {
    // logical session 已离线时 attachment 仍持有旧 services/订阅；后续 sessionId
    // 换代只释放 transport，无法按旧 ID 找回这些端口。Host 在失效源头统一关闭所有 clientMode。
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(event.remoteSessionId);
    const session = windowRemoteConnectionRegistry.getSession(event.remoteSessionId);
    if (session?.workspacePath && session.workspaceIdentity) {
      windowHostControllerRuntime.disconnectSource({
        kind: "remote",
        ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
        remoteSessionId: event.remoteSessionId,
        workspacePath: session.workspacePath,
        workspaceIdentity: session.workspaceIdentity,
      });
    }
    parentPort?.postMessage({
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: event.remoteSessionId,
      reason: "connection-closed",
      exitCode: event.exitCode,
      signal: event.signal,
      ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(event.recoveryAttempt ? { recoveryAttempt: event.recoveryAttempt } : {}),
      ...(event.recoveryLimit ? { recoveryLimit: event.recoveryLimit } : {}),
      ...(event.recoveryBudgetExhausted !== undefined
        ? { recoveryBudgetExhausted: event.recoveryBudgetExhausted }
        : {}),
      ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
      ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
    });
    logWindowHostTopology("remote-connection-closed");
  },
  // [事务] Source 重连时 logical session 也要换代：Controller 的引用必须原子替换，
  // 否则旧 scope 会继续把请求路由到已销毁的 services。
  // [并发] canCommit: isCurrent + commit() 是两道闸：Controller 提交后 registry 还要确认自己仍是 owner，
  // 失去 owner 就抛错，让上层按失败处理而不是留下半提交状态。
  // [失败路径] parentPort 在提交后失效只记日志：此时进程通道正在终止，回滚反而会破坏一致性。
  onSessionReconnected: async ({
    previous,
    current,
    services: currentServices,
    isCurrent,
    commit,
  }) => {
    if (
      !previous.workspacePath ||
      !previous.workspaceIdentity ||
      !current.workspacePath ||
      !current.workspaceIdentity
    ) {
      throw new Error("Source 重连换代缺少 workspace scope");
    }
    const previousScope = {
      kind: "remote" as const,
      ...(previous.sourceServerId ? { sourceServerId: previous.sourceServerId } : {}),
      remoteSessionId: previous.remoteSessionId,
      workspacePath: previous.workspacePath,
      workspaceIdentity: previous.workspaceIdentity,
    };
    const currentScope = {
      kind: "remote" as const,
      ...(current.sourceServerId ? { sourceServerId: current.sourceServerId } : {}),
      ...(current.sourceServerId && sourceServerDisplayNameById.get(current.sourceServerId)
        ? {
            serverDisplayName: sourceServerDisplayNameById.get(current.sourceServerId),
          }
        : {}),
      remoteSessionId: current.remoteSessionId,
      workspacePath: current.workspacePath,
      workspaceIdentity: current.workspaceIdentity,
    };
    await windowHostControllerRuntime.replaceDisconnectedSource(
      previousScope,
      {
        scope: currentScope,
        taskService: currentServices.get(IZCodeTaskService),
        agentService: currentServices.getOptional(IZCodeAgentService),
        sourceAvailability: "online",
      },
      {
        canCommit: isCurrent,
        rollbackOnFailure: true,
      },
    );
    if (!commit()) {
      throw new Error("Source 重连换代在 Controller 提交后失去 Registry owner");
    }
    try {
      parentPort?.postMessage({
        type: HostResponseTypes.RemoteWorkspaceReconnected,
        previousRemoteSessionId: previous.remoteSessionId,
        descriptor: {
          ...(current.sourceServerId ? { sourceServerId: current.sourceServerId } : {}),
          remoteSessionId: current.remoteSessionId,
          target: current.target,
          workspacePath: current.workspacePath,
          workspaceIdentity: current.workspaceIdentity,
          generation: current.generation,
        },
      });
    } catch (error) {
      // Controller 已提交新 generation 后不能再让 Registry 回滚；parentPort 失效意味着
      // Window Host 与 Main 的进程通道正在终止，交给既有 Host shutdown 回收全部 owner。
      logger.error("failed to publish committed remote workspace replacement", error);
    }
    logWindowHostTopology("remote-connection-reconnected");
  },
  onSessionReconnectError: (error) => {
    logger.warn("failed to replace Source Server logical sessions after reconnect", error);
  },
});

// [事务] Controller 是「任务地址 -> 执行服务」的解析中心，所有跨 workspace 的写操作都先经过它。
// [失败路径] resolveSource 返回 null 表示「没有任何可用的执行面」，调用方必须失败而不是猜一个。
const windowHostControllerRuntime = createWindowHostControllerRuntime({
  createId: randomUUID,
  onSourceError: (scope, operation, error) => {
    logger.warn(
      `window Controller source ${operation} failed, scope=${scope.kind}, workspaceKey=${scope.workspaceIdentity?.trim() || scope.workspacePath}`,
      error,
    );
  },
  // [失败路径] 三个返回分支的顺序就是优先级：先查 logical session，再查「远程身份但 session 未连接」，
  // 最后才是本地。顺序一旦颠倒，远程 workspace 的历史查询会落到本地 tasks-index（INV-06）。
  // [权衡] 远程身份在无 logical session 时允许复用 Source 的物理连接：项目树不要求先打开 tab，
  // 但这里只借 taskService，不伪造 session，避免在 registry 里留下无主的 logical session。
  // [事务] offline 的 logical session 返回 sourceAvailability=offline 而不是 null：
  // `sourceAvailability=offline` 让上层区分「项目在但执行面不可用」与「项目不存在」。
  resolveSource: (scope) => {
    const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(scope);
    if (remoteSession?.workspacePath && remoteSession.workspaceIdentity) {
      const controllerScope = {
        kind: "remote" as const,
        ...(remoteSession.sourceServerId ? { sourceServerId: remoteSession.sourceServerId } : {}),
        ...(remoteSession.sourceServerId &&
        sourceServerDisplayNameById.get(remoteSession.sourceServerId)
          ? {
              serverDisplayName: sourceServerDisplayNameById.get(remoteSession.sourceServerId),
            }
          : {}),
        remoteSessionId: remoteSession.remoteSessionId,
        workspacePath: remoteSession.workspacePath,
        workspaceIdentity: remoteSession.workspaceIdentity,
      };
      if (remoteSession.sourceAvailability !== "online") {
        return {
          scope: controllerScope,
          sourceAvailability: "offline" as const,
        };
      }
      const services = windowRemoteConnectionRegistry.resolveScopedServices(controllerScope);
      return {
        scope: controllerScope,
        taskService: services.get(IZCodeTaskService),
        agentService: services.getOptional(IZCodeAgentService),
        sourceAvailability: "online" as const,
      };
    }
    // 远程 history scope 未连接或已被移除时，绝不能落回本地 tasks-index。
    if (scope.workspaceIdentity && isRemoteWorkspaceIdentity(scope.workspaceIdentity)) {
      // 项目树不要求打开 workspace tab；列表命令可复用稳定 Source 的现有物理连接，不能伪造 logical session。
      const identity = parseRemoteWorkspaceIdentity(scope.workspaceIdentity);
      const connection =
        identity?.kind === "server" &&
        identity.sourceServerId &&
        identity.workspacePath === scope.workspacePath
          ? sourceServerConnectionManager?.getOnlineConnection(identity.sourceServerId)
          : undefined;
      const registered =
        identity?.kind === "server" &&
        identity.sourceServerId &&
        identity.workspacePath === scope.workspacePath
          ? windowRemoteConnectionRegistry.getOnlineSource(identity.sourceServerId)
          : undefined;
      if (identity?.kind === "server" && identity.sourceServerId && (connection || registered))
        return {
          scope: {
            kind: "remote" as const,
            sourceServerId: identity.sourceServerId,
            workspacePath: scope.workspacePath,
            workspaceIdentity: scope.workspaceIdentity,
          },
          taskService:
            connection?.services.zcodeTaskService ?? registered!.services.get(IZCodeTaskService),
          agentService:
            connection?.services.zcodeAgentService ??
            registered!.services.getOptional(IZCodeAgentService),
          sourceAvailability: "online" as const,
        };
      return null;
    }
    const taskService = activeServices?.getOptional(IZCodeTaskService);
    if (!taskService) {
      return null;
    }
    return {
      scope: {
        kind: "local" as const,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      },
      taskService,
      agentService: activeServices?.getOptional(IZCodeAgentService),
      sourceAvailability: "online" as const,
    };
  },
});

// [资源] 替换式挂载（INV-45）：先释放旧订阅再挂新的，任何时候只有一份本地样本源。
// [失败路径] 注册失败只记 warn，不影响服务初始化；遥测是可选观测能力。
function wireLocalResourceTelemetry(services: ServiceCollection): void {
  activeLocalResourceTelemetry?.dispose();
  activeLocalResourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "local",
    onError: (error) => logger.warn("local resource telemetry subscription failed", error),
  });
}

// [失败路径] dispose 抛错必须被吞掉，否则会让 Host 的 shutdown barrier 提前中断；
// finally 里置 null 保证即使 dispose 抛错也不会被下一次 wire 重复释放。
function disposeLocalResourceTelemetry(): void {
  try {
    activeLocalResourceTelemetry?.dispose();
  } catch {
    // 资源遥测释放失败不能阻塞 Host 的既有 shutdown barrier。
  } finally {
    activeLocalResourceTelemetry = null;
  }
}

// [资源] attachment 的句柄契约：server 用于日志与就绪确认，dispose 是唯一的释放入口（幂等）。
type ExposedServicePortHandle = {
  server: IChannelServer & { ready(): void };
  dispose(): void;
};

// [事务] 任务写操作（pin/archive/delete/unread）必须经 Controller 解析地址后再执行（INV-43），
// 因为同一个 taskId 可能属于本地、远端甚至已离线 workspace；直接调 base 会写错库。
// [权衡] 只有写操作被拦截，读操作原样透传：读路径已经有 scope 约束，再包一层只会增加延迟。
function createControllerRoutedTaskService(
  base: IZCodeTaskService,
  attachmentScope: WindowHostAttachmentScope,
): IZCodeTaskService {
  // [事务] 地址解析与变更不是原子操作，但顺序不能反：先解析再 mutate，
  // 保证 mutation 一定作用在解析时刻的 workspace 上；反过来会让「已移动的任务」被写回旧库。
  // [失败路径] resolveTaskAddress 抛错时直接冒泡，不做本地兜底——兜底会制造双写。
  const route = async (
    params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
    mutation:
      | { kind: "pin"; pinned: boolean }
      | { kind: "archive"; archived: boolean }
      | { kind: "delete" }
      | { kind: "mark-read"; expectedUnreadAt?: number }
      | { kind: "mark-unread" },
  ) =>
    windowHostControllerRuntime.service.mutateTask({
      address: await windowHostControllerRuntime.resolveTaskAddress({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        attachmentScope,
      }),
      mutation,
    });

  // [失败路径] pin/archive/unread 在 mutation 后必须有投影，取不到就抛错而不是返回 null：
  // 静默返回 null 会让 UI 以为操作成功，但列表始终不刷新。
  // [权衡] 批量删除在 taskIds 为空时直接返回空结果，避免 Controller 为一次空操作解析地址。
  // [事务] deleteArchivedTasks 用第一个 taskId 解析地址并允许缺失，因为批量删除允许部分 ID 已不存在。
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "setTaskPinned") {
        return async (params: Parameters<IZCodeTaskService["setTaskPinned"]>[0]) => {
          const meta = await route(params, {
            kind: "pin",
            pinned: params.pinned,
          });
          if (!meta) throw new Error("pin mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "archiveTask" || property === "unarchiveTask") {
        return async (
          params:
            | Parameters<IZCodeTaskService["archiveTask"]>[0]
            | Parameters<IZCodeTaskService["unarchiveTask"]>[0],
        ) => {
          const meta = await route(params, {
            kind: "archive",
            archived: property === "archiveTask",
          });
          if (!meta) throw new Error("archive mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "deleteTask") {
        return async (params: Parameters<IZCodeTaskService["deleteTask"]>[0]) => {
          await route(params, { kind: "delete" });
        };
      }
      if (property === "deleteArchivedTasks") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTasks"]>[0]) => {
          if (params.taskIds.length === 0) {
            return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
          }
          return windowHostControllerRuntime.service.deleteArchivedTasks({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              taskId: params.taskIds[0]!,
              attachmentScope,
              allowMissingTask: true,
            }),
            taskIds: params.taskIds,
          });
        };
      }
      if (property === "deleteArchivedTask") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTask"]>[0]) =>
          windowHostControllerRuntime.service.deleteArchivedTask({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              ...params,
              attachmentScope,
              allowMissingTask: true,
            }),
          });
      }
      if (property === "setTaskUnread") {
        return async (params: Parameters<IZCodeTaskService["setTaskUnread"]>[0]) => {
          const meta = await route(
            params,
            params.unread
              ? { kind: "mark-unread" }
              : {
                  kind: "mark-read",
                  ...(params.expectedUnreadAt != null
                    ? { expectedUnreadAt: params.expectedUnreadAt }
                    : {}),
                },
          );
          if (!meta) throw new Error("unread mutation 后 task 投影缺失");
          return meta;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof value === "function" &&
        [
          "getBotGroupTaskBlockReason",
          "cancelBotGroupInput",
          "submitBotGroupInput",
          "readBotTopicSummaries",
        ].includes(String(property))
      ) {
        return (params: Record<string, unknown>) =>
          value.call(target, bindBotGroupTaskScope(params, attachmentScope));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// attachment 的物理出口：把当前代际的 services 按 clientMode 组装成一台 ChannelServer，
// 挂到已转移的 MessagePort 上。所有 override 都只影响这次 attachment，不改变全局 services。
// [事务] overrides 的构造顺序决定了「谁能看到什么」（INV-03）：先基础服务，再按 clientMode 收窄，
// 最后再挂 controller 与 agent 作用域；顺序反了会让手机端拿到 desktop 专属通道。
// [资源] 返回的 handle 必须被 registry 持有，端口 close 时由 handle 自行释放（INV-34）。
function exposeServicesOnMessagePort(
  port: Electron.MessagePortMain,
  services: ServiceCollection,
  deferInit: boolean,
  clientMode: ZCodeAgentV4ClientMode = "desktop-continuous",
  attachmentScope: WindowHostAttachmentScope = { kind: "local" },
  capabilities?: HostRemoteConnectionCapabilities,
): ExposedServicePortHandle {
  // [权衡] 包一层 Electron Port 适配器：MessagePortMain 的事件名与 Node worker 不一致，
  // 直接给 ChannelServer 会让 close/error 语义在各平台漂移。
  const wrappedPort = wrapElectronPort(port);
  const protocol = new MessagePortProtocol(wrappedPort);
  // remote 模式延迟发送 Initialize：远程建连需要时间，如果构造时就发 Initialize，
  // renderer 会立即发请求但 channel 还没注册，导致 "Unknown channel" 超时错误。
  // attach 模式复用已就绪服务，必须立即初始化新的 RPC MessagePort。
  logger.info(`creating ChannelServer (deferInit=${deferInit})`);
  // [并发] deferInit 是 remote 建连的关键：构造时立即 Initialize 会让 renderer 在 channel
  // 尚未注册时发请求，收到 Unknown channel 后按超时失败。attach 模式则必须立即初始化。
  // [资源] 三个装饰顺序固定：Logging 在内、Telemetry 在外，保证日志能看到真实帧、遥测不重复计数。
  const rawServer = new ChannelServer(protocol, "host", 1000, deferInit);
  const loggedServer = new LoggingChannelServer(rawServer, logRpc);
  const server = new NetworkTelemetryChannelServer(loggedServer);
  const agentService = services.getOptional(IZCodeAgentService);
  // [事务] connectionId 每次 attachment 都新生成，作为 trusted carrier 的握手身份；
  // 复用它会让两个端口共享同一连接作用域，关闭其一时另一个的 agent 会话被一起销毁。
  // [权衡] clientMode 写进 context 而不是事后推断：agent 侧需要它决定哪些能力可暴露。
  const connectionContext = { connectionId: `host-rpc-${randomUUID()}`, clientMode };
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, connectionContext)
    : undefined;
  // [事务] Controller 是全局单例，重复 register 无副作用；这里放在 attachment 路径上，
  // 是因为 Host 只有收到端口后才会被调用，提前注册会拉长启动关键路径。
  services.register(IWindowControllerService, windowHostControllerRuntime.service);
  // 未读自动写入只归窗口 base renderer；手机和 remote facade 不能重复消费同一完成信号。
  // [并发] 未读自动写入只归窗口 base renderer（INV-03）：手机与 remote facade 会重复消费同一个
  // 完成信号，若都写 unread，用户会在桌面看到「已读」被手机改回「未读」。
  // [资源] controllerAttachment 的生命周期与端口绑定，由 handle.dispose 释放。
  const controllerAttachment = windowHostControllerRuntime.createAttachmentService(
    clientMode === "desktop-continuous" && attachmentScope.kind === "local",
  );
  const overrides = new Map<string, unknown>([
    [IWindowControllerService.channelName, controllerAttachment],
  ]);
  // 手机可从任意远端 workspace 重建 Root；侧栏组织服务仍归控制端，不能随当前执行 attachment 换库。
  // [事务] 手机端可以从任意远端 workspace 重建 Root，但侧栏组织服务仍归控制端：
  // 若跟着当前执行 attachment 换库，手机打开不同 workspace 时侧栏分组会来回跳变。
  // [权衡] 这里只覆盖 project 相关通道并注册 taskGroup，不复制整套本地服务。
  if (
    clientMode === "web-remote-replayable" &&
    attachmentScope.kind === "remote" &&
    activeServices
  ) {
    overrides.set(IProjectService.channelName, activeServices.get(IProjectService));
    overrides.set(IRemoteProjectService.channelName, activeServices.get(IRemoteProjectService));
    services.register(ITaskGroupService, activeServices.get(ITaskGroupService));
  }
  // 远端媒体必须按 attachment 的 clientMode 选择数据面：桌面使用 Host loopback Range，手机保持 inline。
  // [权衡] 只有「远端 scope + 桌面 clientMode」才注入媒体代理（INV-42）：
  // 手机走 inline 数据面，本地 scope 直接读文件系统，两者都不需要 loopback 代理。
  const remoteMediaPreviewProxy =
    attachmentScope.kind === "remote" && clientMode === "desktop-continuous"
      ? capabilities?.remoteMediaPreviewFactory?.(attachmentScope)
      : undefined;
  if (remoteMediaPreviewProxy) {
    overrides.set(IMediaPreviewService.channelName, remoteMediaPreviewProxy.service);
  }
  // R3 的 Source 本地 transfer 无法读取 Desktop localPath；跨机 staging 必须在 owning
  // Window Host attachment 注入，复用当前 transport。桌面/手机不另建 runtime 或业务队列。
  // [事务] 跨机附件的 staging 必须在 owning Window Host 的 attachment 内完成：
  // Source 侧的本地 transfer 读不到 Desktop 的 localPath，另建 runtime 会产生两套队列。
  // [资源] 这里把 dispose 从服务对象里摘出来单独持有，确保它只属于 Host 生命周期，
  // 不会被 renderer 通过 RPC 调用；暴露出去等于让对端能随时拆掉自己的上传通道。
  const remotePromptAttachmentTransfer =
    attachmentScope.kind === "remote"
      ? capabilities?.promptAttachmentTransferFactory?.(attachmentScope)
      : undefined;
  const { dispose: disposePromptAttachmentTransfer, ...promptAttachmentService } =
    remotePromptAttachmentTransfer ?? {};
  if (remotePromptAttachmentTransfer) {
    // dispose 只属于 Host attachment 生命周期，不暴露为 Renderer RPC。
    overrides.set(IPromptAttachmentTransferService.channelName, promptAttachmentService);
  }
  const taskService = services.getOptional(IZCodeTaskService);
  if (taskService) {
    overrides.set(
      IZCodeTaskService.channelName,
      createControllerRoutedTaskService(taskService, attachmentScope),
    );
  }
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // [事务] Share 服务若继续持有 raw Agent，会绕过当前端口已握手的 trusted carrier，
  // rowsRange 会以 connection untrusted 被拒绝；因此必须复用同一个 connection scope。
  // [权衡] 用 scopeConversationShareServiceForAttachment 做包装而不是替换实现，保留原服务语义。
  const conversationShareService = services.getOptional(IConversationShareService);
  if (conversationShareService) {
    // Share service 若继续持有 raw Agent，会绕过当前 MessagePort 已握手的 trusted carrier，
    // rowsRange 会以 connection untrusted 拒绝。必须复用同一 attachment connection scope。
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        conversationShareService,
        clientMode,
        connectionScope?.service,
        connectionContext,
      ),
    );
  }
  // [事务] 统一注册入口：把 base services、overrides、windowServices 三者合并成这次 attachment 的可见面。
  exposeWindowHostAttachmentServices({
    server,
    services,
    overrides,
    clientMode,
    attachmentScope,
    windowServices: activeServices ?? undefined,
  });
  let disposed = false;
  // [并发] flow 状态必须串行送达（INV-35）：MessagePort 的 sideband 事件本身可能乱序，
  // 链式 Promise 保证 CLI 侧的 session 状态机只看到单调迁移。
  let flowUpdateChain = Promise.resolve();
  const forwardFlowState = (state: "saturated" | "drained" | "closed") => {
    if (!connectionScope) return Promise.resolve();
    const update = flowUpdateChain.then(() => connectionScope.setTransportFlowState(state));
    flowUpdateChain = update.catch((error) => {
      logger.warn("failed to forward attachment connection flow state", {
        state,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return update;
  };
  // [并发] 只转发「本 attachment 自己的」scope，不能由 control object 指定 connectionId（INV-35）。
  // [失败路径] 转发失败只记 warn：流控是尽力而为的背压信号，丢一帧只会让 CLI 晚一点暂停。
  const flowStateDisposable = protocol.onFlowState((state) => {
    if (disposed) return;
    // MessagePort sideband 已在 protocol 层与 Uint8Array 分流；这里只把 owning scope
    // 的 edge 串行送往 CLI，不能由 control object 指定 connectionId。
    void forwardFlowState(state).catch(() => {});
  });
  // [资源] 释放顺序：先停事件订阅，再释放 controller 与 transfer，最后才发 closed 并断协议（INV-34）。
  // 反过来的话，closed 之后仍可能收到 saturated，把 CLI 的 pause 状态重新打开。
  // [事务] closed 必须排在所有已接收的 SAT/DRN 之后：链式 await 保证顺序，不依赖对端重发。
  const handle: ExposedServicePortHandle = {
    server,
    dispose() {
      if (disposed) return;
      disposed = true;
      flowStateDisposable.dispose();
      controllerAttachment.dispose();
      void disposePromptAttachmentTransfer?.().catch((error: unknown) => {
        logger.warn("failed to dispose remote attachment transfer", error);
      });
      void remoteMediaPreviewProxy?.dispose().catch((error: unknown) => {
        logger.warn("failed to dispose remote media preview proxy", error);
      });
      // close 排在所有已接收 SAT/DRN 之后；scope.dispose 自身会再次幂等确保 closed，
      // 但绝不让迟到 saturated 在 close 后复活 CLI pause state。
      void forwardFlowState("closed")
        .catch(() => {})
        .then(() => connectionScope?.dispose());
      rawServer.dispose();
      protocol.disconnect();
    },
  };
  // [资源] 端口 close 是唯一的外部触发点；handle.dispose 自身幂等，因此重复触发安全。
  port.once("close", () => handle.dispose());
  logger.info(`service connection ready mode=${clientMode}`);
  return handle;
}

// [事务] attachment registry 只负责「按 scope 找 services 并挂端口」，不实现业务路由；
// scope 解析失败必须抛错（INV-05/06），绝不能回退到 activeServices。
// [资源] 它同时承担 detachStaleRemoteSessionAttachments 的批量清理，是 INV-05 的执行者。
const windowHostAttachmentRegistry = createWindowHostAttachmentRegistry<
  ServiceCollection,
  Electron.MessagePortMain,
  HostRemoteConnectionCapabilities
>({
  // [失败路径] 三种 scope 各自有独立的失败语义：local 要求 services 已就绪，
  // source-settings 要求 Source 在线（并派生 generation），remote 要求 logical session 存在。
  // [事务] 一律抛错而不是返回空：空 services 会让 RPC 请求挂起，比明确失败更难排查。
  // [并发] generation 用于让 registry 判断 attachment 是否过期；source-settings 用 updatedAt，
  // remote 用 session.generation，local 固定为 1（本地没有换代概念）。
  resolveScope: (scope: WindowHostAttachmentScope) => {
    if (scope.kind === "local") {
      if (!activeServices) {
        throw new Error("local services 尚未初始化");
      }
      return { services: activeServices, generation: 1 };
    }
    if (scope.kind === "source-settings") {
      const connection = sourceServerConnectionManager?.getOnlineConnection(scope.sourceServerId);
      const registered = windowRemoteConnectionRegistry.getOnlineSource(scope.sourceServerId);
      const configServices = connection?.services ?? registered?.services;
      if (!configServices) {
        throw new Error(`Source Server is offline: ${scope.sourceServerId}`);
      }
      return {
        services: createSourceSettingsServiceCollection(configServices),
        generation:
          sourceServerConnectionManager
            ?.listStates()
            .find((state) => state.sourceServerId === scope.sourceServerId)?.updatedAt ?? 1,
      };
    }
    const session = windowRemoteConnectionRegistry.getSession(scope.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${scope.remoteSessionId}`);
    }
    return {
      services: windowRemoteConnectionRegistry.resolveScopedServices(scope),
      generation: session.generation,
      capabilities: windowRemoteConnectionRegistry.resolveScopedCapabilities(scope),
    };
  },
  expose: ({ port, services, clientMode, scope, capabilities }) =>
    exposeServicesOnMessagePort(port, services, false, clientMode, scope, capabilities),
});

// [权衡] 只记计数不记明细：拓扑日志用于定位「attach 泄漏」，打印每个 scope 会让日志量随窗口数爆炸。
function logWindowHostTopology(reason: string): void {
  const stats = windowRemoteConnectionRegistry.getStats();
  logger.info(
    `window Host topology, reason=${reason}, pid=${process.pid}, connections=${stats.connectionCount}, logicalSessions=${stats.logicalSessionCount}, attachments=${windowHostAttachmentRegistry.size()}`,
  );
}

// [资源] 独立成函数是为了让关闭顺序可读：端口必须先于 services 释放，否则端口上的 pending RPC 会打到已销毁服务。
function disposeAttachedServicePorts(): void {
  windowHostAttachmentRegistry.dispose();
}

// [事务] 全进程唯一的异步收口（INV-11/12）。它同时做三件事：关数据库启动协调器、
// 中止项目导航、按固定阶段释放远端与本地资源。
// [并发] 重入时等待同一个 in-flight Promise，绝不重复执行阶段；
// [失败路径] 返回失败的阶段列表而不是抛错，让调用方能带着真实 exitCode 退出。
async function disposeHostResources(reason: string): Promise<HostShutdownResult> {
  databaseStartup?.dispose();
  pendingStartupAttachments.clear();
  if (hasDisposedHostResources) {
    return (
      (await disposeHostResourcesInFlight) ?? {
        exitCode: 0,
        failedPhases: [],
        timedOutPhases: [],
      }
    );
  }
  hasDisposedHostResources = true;
  for (const controller of projectNavigationAbortControllers.values()) controller.abort();
  projectNavigationAbortControllers.clear();

  // [事务] 同步段先释放「无异步收尾」的资源（插件桥、遥测、端口、订阅表），
  // 再构造 shutdown phases；顺序保证即使后面的阶段超时，日志与采样也已停止，不会污染退出诊断。
  // [资源] cron/off-peak 的订阅表必须逐个 dispose 再 close repo：只 close repo 不会解除事件监听。
  disposeHostResourcesInFlight = (async () => {
    logger.info(`disposing host resources, reason=${reason}`);

    pluginSandboxRegistrationBridge.dispose();
    stopHostNetworkTelemetry();
    hostNetworkCapture.setCaptureId(null);
    hostSelfResourceTelemetry.stop();
    disposeLocalResourceTelemetry();
    disposeAttachedServicePorts();
    windowHostControllerRuntime.dispose();
    for (const key of Array.from(cronRunSubscriptions.keys())) {
      disposeCronRunSubscription(key);
    }
    cronAutomationRepo.close();
    for (const key of Array.from(offPeakRunSubscriptions.keys())) {
      disposeOffPeakRunSubscription(key);
    }
    disposeOffPeakRuntime();
    offPeakTaskRepo.close();

    if (activeSessionRealtimePort) {
      activeSessionRealtimePort.dispose();
      activeSessionRealtimePort = null;
    }

    const servicesToDispose = activeServices;
    activeServices = null;
    // Registry 是全部远端 connection 的唯一 owner；释放失败不能阻塞本地服务继续收口。
    // [事务] 阶段顺序即依赖顺序（INV-12）：registry 先释放（它持有远端 connection），
    // manager 次之（它持有物理 Source），本地 services 最后（它们可能被前两者的回调引用）。
    // [失败路径] 每个阶段都有独立超时；超时会被记进 timedOutPhases，而不是让整个退出挂死。
    // [权衡] 超时值按经验设定：registry 6s（可能有多条 SSH），manager 2s，services 3.5s。
    const shutdownResult = await runHostShutdownPhases(
      [
        {
          name: "remote-registry-dispose",
          run: () => windowRemoteConnectionRegistry.dispose(),
          timeoutMs: 6_000,
        },
        {
          name: "source-server-manager-dispose",
          run: async () => {
            sourceServerConnectionManager?.dispose();
            sourceServerManagementService?.dispose();
            sourceSettingsStateSubscription?.dispose();
            sourceServerConnectionManager = null;
            sourceServerManagementService = null;
            sourceSettingsStateSubscription = null;
            sourceServerDirectory = null;
          },
          timeoutMs: 2_000,
        },
        ...(servicesToDispose
          ? [
              {
                name: "service-dispose",
                run: () => disposeServiceResourcesAndWait(servicesToDispose),
                timeoutMs: 3_500,
              },
            ]
          : []),
      ],
      {
        phaseTimeoutMs: 5_000,
        log: (message, details) => logger.warn(message, details),
      },
    );
    if (shutdownResult.exitCode !== 0) {
      logger.warn("host resource cleanup completed with errors", {
        failedPhases: shutdownResult.failedPhases,
        reason,
        timedOutPhases: shutdownResult.timedOutPhases,
      });
    }
    activeHostApiNetworkTransport = null;
    return shutdownResult;
  })();

  const shutdownResult = await disposeHostResourcesInFlight;
  flushHostE2ECoverage((error) => {
    logger.warn("[e2e-coverage] host coverage flush failed", error);
  });
  return shutdownResult;
}

// [失败路径] 这是同步兜底路径（process exit 阶段），只做「能立刻做完」的释放：
// 不能用 await，因此远端 registry 的 dispose 只能 fire-and-forget。
// [权衡] 与异步版本重复的代码是有意的：exit 时 event loop 即将停止，复用 async 版本会一行都不执行。
function disposeHostResourcesBestEffort(reason: string): void {
  if (hasDisposedHostResources) {
    return;
  }
  hasDisposedHostResources = true;

  logger.info(`disposing host resources, reason=${reason}`);
  pluginSandboxRegistrationBridge.dispose();
  stopHostNetworkTelemetry();
  hostNetworkCapture.setCaptureId(null);
  disposeLocalResourceTelemetry();
  disposeAttachedServicePorts();
  windowHostControllerRuntime.dispose();
  for (const key of Array.from(cronRunSubscriptions.keys())) {
    disposeCronRunSubscription(key);
  }
  cronAutomationRepo.close();
  for (const key of Array.from(offPeakRunSubscriptions.keys())) {
    disposeOffPeakRunSubscription(key);
  }
  disposeOffPeakRuntime();
  offPeakTaskRepo.close();
  void windowRemoteConnectionRegistry.dispose();

  if (activeServices) {
    try {
      disposeServiceResources(activeServices);
    } catch (error) {
      logger.error("failed to dispose local services:", error);
    } finally {
      activeServices = null;
      activeHostApiNetworkTransport = null;
    }
  }

  if (activeSessionRealtimePort) {
    activeSessionRealtimePort.dispose();
    activeSessionRealtimePort = null;
  }
}

// [失败路径] 信号退出必须先完成收尾再 exit，否则未落盘的 turn 会丢失；
// 收尾本身失败时以 1 退出，让 Main 知道「非正常关闭」。
process.once("SIGTERM", () => {
  void disposeHostResources("SIGTERM").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

// [并发] 与 SIGTERM 共用同一条收口；once 保证连按两次 Ctrl+C 不会启动第二轮清理。
process.once("SIGINT", () => {
  void disposeHostResources("SIGINT").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

// [失败路径] parent IPC 消失后不会再有人发 Dispose，必须自行有界清理并显式退出（exitCode 1）；
// 不退出会让 Host 变成常驻孤儿进程，占着 sqlite 锁。
process.once("disconnect", () => {
  // parent IPC 消失后不会再有人发送 Dispose；有界清理结束后必须明确退出，避免 Host 常驻。
  void disposeHostResources("disconnect").finally(() => process.exit(1));
});

// [资源] exit 回调里只能做同步释放，任何 Promise 都不会被调度；这是最后的兜底，不追求完整性。
process.once("exit", () => {
  disposeHostResourcesBestEffort("exit");
});

let handlingFatalUncaughtException = false;
// [失败路径] 未捕获异常分两类：可恢复的原生 TLS 回调分配失败（onRecovered）与真正的致命错误。
// [并发] 致命路径用 handlingFatalUncaughtException 防重入（INV-47）：清理途中再抛异常时直接 exit，
// 不再启动第二轮清理，避免两个 shutdown 同时写台账。
// [权衡] 用 process.on 而不是 once：可恢复分支需要继续接收后续异常。
process.on(
  "uncaughtException",
  createHostUncaughtExceptionHandler({
    onRecovered: (error, origin) => {
      const memoryUsage = process.memoryUsage();
      logger.warn("contained host allocation failure from native TLS callback", {
        arrayBuffers: memoryUsage.arrayBuffers,
        external: memoryUsage.external,
        heapUsed: memoryUsage.heapUsed,
        message: error.message,
        origin,
        rss: memoryUsage.rss,
      });
    },
    onFatal: (error, origin) => {
      if (handlingFatalUncaughtException) {
        process.exit(1);
      }
      handlingFatalUncaughtException = true;
      logger.error(`uncaughtException origin=${origin}:`, error);
      void disposeHostResources(`uncaughtException:${origin}`).finally(() => process.exit(1));
    },
  }),
);

// 全部 parentPort 消息的唯一分发点。处理器是 async 的，await 之间允许其他消息插队（INV-48），
// 因此任何「先检查后执行」都必须自带身份校验（assertHost / disposed / requestId 去重）。
// [事务] 先做同步且无副作用的赋值（locale、captureId），再进入可能 await 的业务分支。
// [失败路径] schema 解析失败只记日志并丢弃：畸形消息无法安全回执，回执本身也可能再次失败。
parentPort.on("message", async (e: Electron.MessageEvent) => {
  const result = parseHostIncomingMessageEvent(e);
  if (!result.success) {
    logger.error("invalid parentPort message:", formatZodError(result.error));
    return;
  }

  const msg = result.data;
  // 在任何 await 之前同步赋值：InitLocal 与变更消息同端口按序到达，初值不会覆盖较新的变更。
  // [并发] 必须在任何 await 之前同步赋值（INV-14）：InitLocal 与 locale 变更同端口按序到达，
  // 一旦延后，后到的变更可能先执行，旧初值反而覆盖新语言。
  if (msg.type === HostMessageTypes.InitLocal && msg.locale) {
    applicationLocale = msg.locale;
  }
  // [权衡] locale 变更立即生效且不广播：只有本 Host 的请求头需要它，其他窗口会各自收到自己的消息。
  if (msg.type === HostMessageTypes.ApplicationLocaleChanged) {
    applicationLocale = msg.locale;
    return;
  }
  // [资源] captureId 是 Main 侧抓包会话的句柄，置 null 即停止记录；Host 不持有任何文件句柄。
  if (msg.type === HostMessageTypes.NetworkCapture) {
    hostNetworkCapture.setCaptureId(msg.control.captureId);
    return;
  }
  const port = e.ports[0];
  // [事务] snapshot 只是重发当前启动状态（UI 重连后补播），retry 才真正推进状态机；
  // 两者都不创建新的协调器，保证 INV-01 成立。
  if (msg.type === HostMessageTypes.DatabaseStartupControl) {
    if (msg.control.action === "snapshot") databaseStartup?.coordinator.publish();
    else if (msg.control.action === "retry")
      void databaseStartup?.coordinator.retry(msg.control.attemptId);
    return;
  }

  // [事务] 项目导航是全文件里最长的请求路径：requestId 去重 → 建 AbortController → 执行 navigation →
  // 恰好回执一次 → finally 清理。任何一步漏掉，Main 侧都会永久等待。
  // [并发] requestId 重复时立即回执失败而不复用旧控制器：复用会让两个导航共享同一次 abort。
  // [失败路径] 整个导航包在 try/catch 中，异常被翻译成 result.ok=false 而不是抛到消息循环外。
  if (msg.type === HostMessageTypes.PrepareProjectWorkspace) {
    const controller = new AbortController();
    if (projectNavigationAbortControllers.has(msg.requestId)) {
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: false, error: "项目导航 requestId 重复" },
      });
      return;
    }
    projectNavigationAbortControllers.set(msg.requestId, controller);
    try {
      const services = activeServices;
      if (!services || hasDisposedHostResources) throw new Error("Window Host is unavailable");
      const assertHost = () => {
        controller.signal.throwIfAborted();
        if (activeServices !== services || hasDisposedHostResources)
          throw new Error("Window Host changed during project navigation");
      };
      const navigation = createProjectWorkspaceNavigation({
        projectService: services.get(IProjectService),
        remoteProjectService: services.get(IRemoteProjectService),
        readConnectionOwner: (hostId) => resolveBotProjectConnection(hostId)?.owner,
        openRemoteWorkspace: async ({ host, directories, owner, assertCurrent }) => {
          assertHost();
          const serverId = parseRemoteWorkspaceIdentity(
            buildRemoteHostWorkspaceIdentity(host.id, directories.workspacePath),
          )?.sourceServerId;
          if (!serverId || !host.target) throw new Error("project.host-offline");
          // 对 Manager-only Source 仅登记现有连接的 wrapper；URL Source 必须已经在 Registry 在线。
          const registered = await windowRemoteConnectionRegistry.connectSource({
            target: host.target,
            remoteAssets: {},
            membershipIntent: "retain",
            existingSourceServerId: serverId,
          });
          assertHost();
          if (
            (registered.handle.capabilities?.physicalOwner?.() ?? registered.handle.services) !==
            owner
          )
            throw new Error("project.navigation-stale");
          return windowRemoteConnectionRegistry.openWorkspaceOnSource({
            requestId: msg.requestId,
            sourceServerId: serverId,
            workspacePath: directories.workspacePath,
            workspaceIdentity: directories.workspaceIdentity,
            workspacePurpose: directories.projectId ? "project" : "conversation",
            assertCurrent: async () => {
              assertHost();
              await assertCurrent();
              assertHost();
            },
          });
        },
      });
      const value = await navigation.prepare({
        projectId: msg.projectId,
        hostId: msg.hostId,
        draftId: msg.draftId,
        reuseDraft: msg.reuseDraft,
        ...(msg.task ? { task: msg.task } : {}),
      });
      assertHost();
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: true, value },
      });
    } catch (error) {
      parentPort.postMessage({
        type: HostResponseTypes.ProjectWorkspacePrepared,
        requestId: msg.requestId,
        result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (projectNavigationAbortControllers.get(msg.requestId) === controller)
        projectNavigationAbortControllers.delete(msg.requestId);
    }
    return;
  }

  // [失败路径] 服务取不到时必须显式 warn（原实现静默丢弃，dev 实测 0 条、正式包 92 条）：
  // 只有把「main 没发」与「host 收到但服务未注册」分开，才能定位链路断点。
  // [并发] publishFocus 是 fire-and-forget：焦点事件是高频诊断信号，等待会阻塞后续消息。
  if (msg.type === HostMessageTypes.CuaPipFocusChanged) {
    const service = activeServices?.getOptional(ICuaPipSessionService);
    if (service) {
      void service.publishFocus(msg.event);
    } else {
      // 取不到服务时过去静默丢弃，focus-changed 于是从链路上凭空消失
      // （dev 实测 0 条，正式包同期 92 条）。补这条才能把「main 没发」与
      // 「host 收到了但服务没注册」分开。
      logger.warn("[cua-pip-session] focus event dropped: service unavailable");
    }
    return;
  }

  // [资源] 按需采样（INV-46）：请求到达才读一次进程指标，取消消息用于停止等待中的采样。
  if (msg.type === HostMessageTypes.ResourceUsageSnapshotRequest) {
    void hostResourceUsageResponder.handleRequest(msg);
    return;
  }
  if (msg.type === HostMessageTypes.ResourceUsageSnapshotCancel) {
    hostResourceUsageResponder.cancelRequest(msg.requestId);
    return;
  }

  // [失败路径] 找不到 pending 说明请求已被关闭流程清理，直接丢弃（迟到回包是正常竞态）。
  // [事务] 先 delete 再 resolve/reject（INV-09）：否则回调里再次触发同一 requestId 会重复结算。
  // [权衡] 成功时先推一次 100% 进度再 resolve，让进度条不需要额外等待 UI 轮询。
  if (msg.type === HostMessageTypes.FeedbackLogArchiveResult) {
    const pending = pendingFeedbackLogArchiveRequests.get(msg.requestId);
    if (!pending) {
      return;
    }
    pendingFeedbackLogArchiveRequests.delete(msg.requestId);
    if (msg.ok && msg.path && typeof msg.size === "number") {
      pending.onProgress?.({ processedBytes: msg.size, totalBytes: msg.size });
      pending.resolve({ path: msg.path, size: msg.size });
      return;
    }
    pending.reject(new Error(msg.error ?? "反馈日志归档创建失败"));
    return;
  }

  // [事务] 与归档回包同构：先摘除 pending 再结算，保证恰好一次（INV-08/09）。
  if (msg.type === HostMessageTypes.LocalMediaPreviewPathAuthorizeResult) {
    const pending = pendingLocalMediaPreviewPathAuthorizations.get(msg.requestId);
    if (!pending) return;
    pendingLocalMediaPreviewPathAuthorizations.delete(msg.requestId);
    if (msg.ok && msg.path) {
      logger.info("local media preview path authorization OK");
      pending.resolve(msg.path);
    } else {
      pending.reject(new Error(msg.error ?? "本地视频预览路径授权失败"));
    }
    return;
  }

  // [资源] 注册结果直接交给 bridge 内部按 requestId 配对，Host 不重复维护 pending 表。
  if (msg.type === HostMessageTypes.PluginSandboxRegisterResult) {
    pluginSandboxRegistrationBridge.accept(msg);
    return;
  }

  // [事务] 数据库未 ready 时以 transient 失败回执（INV-10）：让调度器退避重试，
  // 而不是让 run 直接进 failed（那会把一次启动竞态记成业务失败）。
  // [并发] 真正的派发不 await，避免长时间占用消息循环；结果通过 CronRunResult 异步回执。
  if (msg.type === HostMessageTypes.CronRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.CronRunResult,
        runId: msg.runId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchCronRun({
          ...msg,
          mode: msg.mode as ZCodeTaskMode | undefined,
        });
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          failureKind: "transient",
        });
      }
    })();
    return;
  }

  // [事务] 与 CronRun 同构，但失败分类不同：确定性模型/凭证错误标 permanent，
  // 其余标 transient（保留退避语义）。分错会让配置错误无限重试，或让临时故障直接失败。
  // [失败路径] 回执一定会发：success 与 catch 两条路径都 postMessage，Main 不会悬挂。
  if (msg.type === HostMessageTypes.OffPeakRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.OffPeakRunResult,
        offPeakTaskId: msg.offPeakTaskId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchOffPeakRun(msg);
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          // 确定性模型/凭证配置错误重试不会自愈；交给 scheduler 转 failed，
          // 未知及生命周期错误仍按 transient 保持原退避语义。
          failureKind: error instanceof OffPeakPermanentDispatchError ? "permanent" : "transient",
        });
      }
    })();
    return;
  }

  // [事务] main 执行完 browser 命令后按 requestId 关联回 bridge 的 pending，Host 不做二次解释。
  if (msg.type === HostMessageTypes.BrowserExecuteResult) {
    // main 的 WebContentsView+CDP 执行完 browser 命令，按 requestId 关联回 bridge 的 pending。
    void browserControlMainBridge.handleResult({
      requestId: msg.requestId,
      result: msg.result,
    });
    return;
  }

  // [事务] 窗口关闭/app 退出：必须 await 统一清理（含异步写回）后再退出（INV-11）；
  // Main 侧另有强杀 timer 兜底，因此这里可以放心等待。
  // [失败路径] 清理结果里的 exitCode 直接作为进程退出码，让 Main 能区分正常与带错退出。
  if (msg.type === HostMessageTypes.Dispose) {
    // main 进程通知清理（窗口关闭 / app 退出时）
    // 这里必须等待统一资源清理完成（含异步收尾写回），再让进程退出；main 侧仍有强杀 timer 兜底。
    const result = await disposeHostResources("parent dispose");
    process.exit(result.exitCode);
    return;
  }

  // [权衡] Broadcast 由 Main 直接投递到其他窗口，Host 只需忽略；转发会造成回环广播。
  if (msg.type === HostMessageTypes.Broadcast) {
    return;
  }

  // [失败路径] 服务未初始化时必须回一条 failed 结果，而不是直接 return：
  // 对端在等 DeliveryResult，缺一条就会永久 pending。
  // [事务] 成功与失败都带原样的 messageId/requestId/fromSessionId，保证对端能对上号。
  // [并发] deliverSessionMessage 不 await，deliver 本身可能触发一轮完整 turn。
  if (msg.type === HostMessageTypes.SessionMessageDeliver) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      parentPort.postMessage({
        type: HostResponseTypes.SessionMessageDeliverResult,
        result: {
          error: "ZCode task service is not initialized.",
          messageId: msg.request.messageId,
          requestId: msg.request.requestId,
          sessionId: msg.request.fromSessionId,
          status: "failed",
        },
      });
      return;
    }

    void zcodeTaskService
      .deliverSessionMessage(msg.request)
      .then((deliveryResult) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: deliveryResult,
        });
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: {
            error: error instanceof Error ? error.message : String(error),
            messageId: msg.request.messageId,
            requestId: msg.request.requestId,
            sessionId: msg.request.fromSessionId,
            status: "failed",
          },
        });
      });
    return;
  }

  // [失败路径] 未初始化时只记 warn 并丢弃：这是一个「回执的回执」，没有对端在等结果。
  // [事务] 转发失败同样只记 warn，不能让一次消息投递影响 Host 主循环。
  if (msg.type === HostMessageTypes.SessionMessageDeliveryResult) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      logger.warn("session message delivery result received before ZCode task service initialized");
      return;
    }
    void zcodeTaskService.sendSessionMessageDeliveryResult(msg.result).catch((error) => {
      logger.warn("failed to forward session message delivery result:", error);
    });
    return;
  }

  // [事务] 执行前用 environmentKey 校验 session 仍然有效：注册失效后继续执行会把凭据写进错误的远端环境。
  // [失败路径] 三种失败（session 失效 / 不支持 / 执行异常）都回执明确的 errorCode，
  // 让 Main 能区分「需要重新注册」与「执行本身失败」。
  // [权衡] syncLocalToRemote 的返回状态原样回传，不在 Host 侧二次归类。
  if (msg.type === HostMessageTypes.ProviderProvisioningExecute) {
    const session = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (
      !session ||
      !session.workspaceIdentity ||
      buildRemoteEnvironmentKey(session.target) !== msg.environmentKey
    ) {
      parentPort.postMessage({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: msg.requestId,
        environmentKey: msg.environmentKey,
        status: "failed",
        error: "Remote Environment registration 已失效",
        errorCode: "session-unavailable",
      });
      return;
    }
    const scope = {
      kind: "remote",
      remoteSessionId: session.remoteSessionId,
      workspacePath: session.workspacePath ?? "/",
      workspaceIdentity: session.workspaceIdentity,
    } as const;
    void Promise.resolve()
      .then(() =>
        (() => {
          const provisioningService = getRemoteProviderProvisioningExecutor(
            windowRemoteConnectionRegistry.resolveScopedServices(scope),
          );
          if (!provisioningService) {
            throw new Error("Remote Environment 不支持 Provider Provisioning");
          }
          return provisioningService.syncLocalToRemote();
        })(),
      )
      .then((result) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: result.status,
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        });
      })
      .catch((error: unknown) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          errorCode: "host-execution-failed",
        });
      });
    return;
  }

  // [事务] 建连请求：先算 workspacePath/identity（缺省值必须在这里定死，registry 不接受空值），
  // 再进入 remoteConnectionProgressContext 关联进度，最后统一回 Connected/ConnectFailed。
  // [失败路径] 错误信息必须 sanitize 后再回传：原始错误可能含 SSH 命令与路径。
  if (msg.type === HostMessageTypes.ConnectRemoteWorkspace) {
    const workspacePath =
      msg.workspacePath ??
      (msg.target.kind === "server" ? msg.target.workspacePath?.trim() || "/" : "/");
    const workspaceIdentity =
      msg.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, msg.target);
    logger.info(
      `connecting window-scoped remote source, requestId=${msg.requestId}, target=${formatRemoteTargetForLog(msg.target)}`,
    );
    void remoteConnectionProgressContext
      .run(msg.requestId, () =>
        windowRemoteConnectionRegistry.connect({
          requestId: msg.requestId,
          target: msg.target,
          remoteAssets: msg.remoteAssets,
          workspacePath,
          workspaceIdentity,
          ...(msg.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
        }),
      )
      .then(async (descriptor) => {
        // [事务] 同一 workspace 的旧离线 session 必须在新连接成功后原子替换（INV-05）：
        // 不替换会让 UI 列表里出现同一项目的两个 logical session。
        // [失败路径] Controller 替换失败不回滚 transport，也不删离线投影：保留 pending replacement，
        // 等后续 query 成功后再提交；回滚会表现为「刚连上又掉线」。
        // [资源] 旧 session 的 attachment 必须先 detach 再 disposeSession，否则端口仍指向已销毁 services。
        const replacedOfflineSessions = windowRemoteConnectionRegistry
          .listSessions()
          .filter(
            (session) =>
              session.remoteSessionId !== descriptor.remoteSessionId &&
              session.state === "disconnected" &&
              session.workspacePath === descriptor.workspacePath &&
              session.workspaceIdentity === descriptor.workspaceIdentity,
          );
        for (const replaced of replacedOfflineSessions) {
          if (replaced.workspacePath && replaced.workspaceIdentity) {
            const previousScope = {
              kind: "remote",
              ...(replaced.sourceServerId ? { sourceServerId: replaced.sourceServerId } : {}),
              remoteSessionId: replaced.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            const nextScope = {
              kind: "remote",
              ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            try {
              const services = windowRemoteConnectionRegistry.resolveScopedServices(nextScope);
              await windowHostControllerRuntime.replaceDisconnectedSource(previousScope, {
                scope: nextScope,
                taskService: services.get(IZCodeTaskService),
                sourceAvailability: "online",
              });
            } catch (error) {
              // source 已连接但 task-index 暂时不可读时不能回滚 transport，也不能删除上一代
              // 离线可信投影。Controller 会保留 pending replacement，后续 query 成功后原子替换。
              logger.warn("failed to atomically replace disconnected Controller source", error);
            }
          }
          windowHostAttachmentRegistry.detachRemoteSessionAttachments(replaced.remoteSessionId);
          await windowRemoteConnectionRegistry.disposeSession(replaced.remoteSessionId);
          // 重连替换后旧 remoteSessionId 已不再可 attachment；同步清理 Main 的端口请求关联，
          // 但不向 Renderer 伪报一次新的 transport failure。
          parentPort.postMessage({
            type: HostResponseTypes.RemoteWorkspaceClosed,
            remoteSessionId: replaced.remoteSessionId,
            reason: "disposed",
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnected,
          requestId: msg.requestId,
          descriptor,
        });
        logWindowHostTopology("remote-connected");
      })
      .catch((error) => {
        const failure = normalizeRemoteConnectionError(error);
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnectFailed,
          requestId: msg.requestId,
          error: sanitizeRemoteConnectionLog(failure.message) || "Remote connection failed",
          reasonCode: failure.code,
          ...(error instanceof SourceServerUpgradeRequiredError ||
          error instanceof SourceServerInstallRequiredError
            ? { profileId: error.profileId }
            : {}),
          // 安装和升级等待固定 Main 解析后的 WSL 身份，不能从可编辑 Profile 重建。
          // 身份来自同一请求，独立于附加安装预览；只回传 WSL 的非敏感连接参数。
          ...((error instanceof SourceServerInstallRequiredError ||
            error instanceof SourceServerUpgradeRequiredError) &&
          msg.target.kind === "wsl"
            ? { resolvedWslTarget: msg.target }
            : {}),
          ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
        });
      });
    return;
  }

  // [事务] 取消建连同时中止项目导航（同一 requestId 可能属于导航中的一次建连）；
  // 只取消 request，不连锁 dispose 共享 session。
  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceConnect) {
    projectNavigationAbortControllers.get(msg.requestId)?.abort();
    windowRemoteConnectionRegistry.cancelConnect(msg.requestId);
    return;
  }

  // [事务] 先记取消标记再 abort：bind 可能尚未注册到 activeWorkspaceBindRequestIds，
  // 此时先到的 cancel 只能靠标记让后续 bind 立即失败（INV-38）。
  // [权衡] 不连锁 dispose session：取消一次目录选择不代表该 session 的其他 owner 都已释放。
  // [失败路径] 若 bind 已在处理中，则由 bind 自己的 abort 路径回执，不在这里重复回执。
  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceBind) {
    cancelledWorkspaceBindRequestIds.add(msg.requestId);
    workspaceBindAbortControllers.get(msg.requestId)?.abort();
    // Bug 原因：bind 可能 join 到已有 Source logical session；取消一个选择目录请求不代表
    // 该 session 的其他 attachment/owner 都已释放。这里只取消 request，不再连坐 dispose。
    if (!activeWorkspaceBindRequestIds.has(msg.requestId)) {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: "Remote workspace bind was canceled",
        reasonCode: REMOTE_BIND_CANCELED_ERROR_CODE,
        retryable: false,
      });
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
    }
    return;
  }

  // [事务] bind 是全文件状态最多的一条路径：请求登记、取消标记、abort 控制器、workspace 准备、
  // Controller 绑定与三条 settle 清理，必须严格一一对应（INV-08/38）。
  // [并发] 消息处理器是 async 的，取消消息可能在任意 await 点插队，因此每个 await 后都要复查取消。
  if (msg.type === HostMessageTypes.BindRemoteWorkspaceContext) {
    activeWorkspaceBindRequestIds.add(msg.requestId);
    const bindAbortController = new AbortController();
    workspaceBindAbortControllers.set(msg.requestId, bindAbortController);
    if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
      bindAbortController.abort();
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: "Remote workspace bind was canceled",
        reasonCode: REMOTE_BIND_CANCELED_ERROR_CODE,
        retryable: false,
      });
      activeWorkspaceBindRequestIds.delete(msg.requestId);
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
      return;
    }
    const previous = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    let workspaceReady: Promise<void>;
    try {
      workspaceReady = windowRemoteConnectionRegistry.bindWorkspaceContext({
        remoteSessionId: msg.remoteSessionId,
        workspacePath: msg.workspacePath,
        workspaceIdentity: msg.workspaceIdentity,
        ...(msg.workspacePurpose ? { workspacePurpose: msg.workspacePurpose } : {}),
        ...(msg.legacyRouteHint ? { legacyWorkspaceIdentity: msg.legacyRouteHint } : {}),
        signal: bindAbortController.signal,
      });
    } catch (error) {
      logger.warn(
        `failed to bind remote workspace context, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
        requestId: msg.requestId,
        error: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? { reasonCode: error.code }
          : {}),
        ...(error &&
        typeof error === "object" &&
        "retryable" in error &&
        typeof error.retryable === "boolean"
          ? { retryable: error.retryable }
          : {}),
      });
      activeWorkspaceBindRequestIds.delete(msg.requestId);
      cancelledWorkspaceBindRequestIds.delete(msg.requestId);
      workspaceBindAbortControllers.delete(msg.requestId);
      return;
    }
    const current = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (current) {
      // scope generation 换代后，旧 Renderer/手机 attachment 不得继续持有远端 IO facade。
      windowHostAttachmentRegistry.detachStaleRemoteSessionAttachments(
        msg.remoteSessionId,
        current.generation,
      );
    }
    void workspaceReady
      .then(async () => {
        if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
          throw Object.assign(new Error("Remote workspace bind was canceled"), {
            code: REMOTE_BIND_CANCELED_ERROR_CODE,
            retryable: false,
          });
        }
        const currentSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
        if (!currentSession?.workspaceIdentity) {
          // Bug 原因：bind 完成前 logical session 可能被并发释放；旧实现直接 return，Main
          // 永远收不到 ACK。抛入统一失败链，确保每个 requestId 恰好 settle 一次。
          throw Object.assign(
            new Error(`远程 workspace bind 完成时 session 已失效: ${msg.remoteSessionId}`),
            {
              code: REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
              retryable: true,
            },
          );
        }
        const scope = {
          kind: "remote" as const,
          ...(currentSession.sourceServerId
            ? { sourceServerId: currentSession.sourceServerId }
            : {}),
          remoteSessionId: msg.remoteSessionId,
          workspacePath: msg.workspacePath,
          workspaceIdentity: currentSession.workspaceIdentity,
        };
        await windowRemoteConnectionRegistry
          .resolveScopedCapabilities(scope)
          ?.recordWorkspaceOpen?.({
            workspacePath: msg.workspacePath,
            workspaceIdentity: currentSession.workspaceIdentity,
            ...(msg.workspacePurpose ? { workspacePurpose: msg.workspacePurpose } : {}),
            ...(msg.legacyRouteHint ? { legacyWorkspaceIdentity: msg.legacyRouteHint } : {}),
            signal: bindAbortController.signal,
          });
        if (cancelledWorkspaceBindRequestIds.has(msg.requestId)) {
          throw Object.assign(new Error("Remote workspace bind was canceled"), {
            code: REMOTE_BIND_CANCELED_ERROR_CODE,
            retryable: false,
          });
        }
        if (previous?.workspacePath && previous.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            ...(previous.sourceServerId ? { sourceServerId: previous.sourceServerId } : {}),
            remoteSessionId: msg.remoteSessionId,
            workspacePath: previous.workspacePath,
            workspaceIdentity: previous.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceContextBound,
          requestId: msg.requestId,
          // Bug 原因：首次从旧 route tab 打开 Source workspace 时，Renderer 只拿到 stable
          // identity 会误认为没有旧 tab，随后 addTab 产生第二个 workspace。把本次 bind
          // 使用的旧 route 作为一次性 tab rekey 提示返回；它不是任务路由身份，手机端忽略。
          ...(msg.legacyRouteHint && msg.legacyRouteHint !== currentSession.workspaceIdentity
            ? { previousWorkspaceIdentity: msg.legacyRouteHint }
            : {}),
        });
        logger.info(
          `bound remote workspace context, remoteSessionId=${msg.remoteSessionId}, workspacePath=${msg.workspacePath}`,
        );
        activeWorkspaceBindRequestIds.delete(msg.requestId);
        cancelledWorkspaceBindRequestIds.delete(msg.requestId);
        workspaceBindAbortControllers.delete(msg.requestId);
      })
      .catch((error) => {
        logger.warn(
          `failed to prepare bound remote workspace, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
        const normalizedError = cancelledWorkspaceBindRequestIds.has(msg.requestId)
          ? Object.assign(new Error("Remote workspace bind was canceled"), {
              code: REMOTE_BIND_CANCELED_ERROR_CODE,
              retryable: false,
            })
          : error;
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceContextBindFailed,
          requestId: msg.requestId,
          error:
            normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
          ...(normalizedError &&
          typeof normalizedError === "object" &&
          "code" in normalizedError &&
          typeof normalizedError.code === "string"
            ? { reasonCode: normalizedError.code }
            : {}),
          ...(normalizedError &&
          typeof normalizedError === "object" &&
          "retryable" in normalizedError &&
          typeof normalizedError.retryable === "boolean"
            ? { retryable: normalizedError.retryable }
            : {}),
        });
        activeWorkspaceBindRequestIds.delete(msg.requestId);
        cancelledWorkspaceBindRequestIds.delete(msg.requestId);
        workspaceBindAbortControllers.delete(msg.requestId);
      });
    return;
  }

  // [事务] 显式释放 logical session：先 detach 全部端口，再 dispose，最后通知 Controller removeSource。
  // 顺序反了会让 Controller 在端口仍存活时撤掉 source，端口上的后续请求落到空作用域。
  // [失败路径] dispose 失败只记 warn：Main 已经决定关闭这个 session，重试没有语义。
  if (msg.type === HostMessageTypes.DisposeRemoteWorkspaceSession) {
    const disposedSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(msg.remoteSessionId);
    void windowRemoteConnectionRegistry
      .disposeSession(msg.remoteSessionId)
      .then(() => {
        if (disposedSession?.workspacePath && disposedSession.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            ...(disposedSession.sourceServerId
              ? { sourceServerId: disposedSession.sourceServerId }
              : {}),
            remoteSessionId: msg.remoteSessionId,
            workspacePath: disposedSession.workspacePath,
            workspaceIdentity: disposedSession.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: msg.remoteSessionId,
          reason: "disposed",
        });
        logWindowHostTopology("remote-session-disposed");
      })
      .catch((error) => {
        logger.warn(
          `failed to dispose remote logical session, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
      });
    return;
  }

  // [事务] attachment 的唯一入口：先做就绪门控（local 未 ready 则挂起），再做 scope 校验，
  // 最后才把端口交给 registry。校验放在 attach 之前，保证失败端口不会被注册。
  // [失败路径] scope 校验失败必须关闭端口并明确记录，禁止回退到 activeServices（INV-06）。
  if (msg.type === HostMessageTypes.AttachServicePort) {
    if (!port) {
      logger.error("attach-service-port message missing MessagePort");
      return;
    }
    if (msg.scope.kind === "local" && databaseStartup?.coordinator.snapshot.phase !== "ready") {
      // 刷新/手机 attachment 复用同一 Host，等待现有准备，不启动第二个执行者。
      // [资源] 就绪前先挂起闭包并监听端口 close（INV-09/19）：端口在等待期间关闭时必须删除，
      // 否则 ready 后会向已销毁端口注册服务，抛出与启动无关的噪音错误。
      // [权衡] 等待现有启动而不触发第二次初始化：刷新/手机 attachment 复用同一 Host。
      pendingStartupAttachments.set(msg.attachmentId, () => {
        windowHostAttachmentRegistry.attach({ ...msg, port });
      });
      port.once("close", () => pendingStartupAttachments.delete(msg.attachmentId));
      return;
    }
    try {
      if (msg.clientMode === "web-remote-replayable" && msg.scope.kind === "source-settings") {
        throw new Error("Source settings attachments are Desktop-only");
      }
      if (msg.scope.kind === "remote") {
        // Bind 与 Attach 共用 parentPort，但 WSL 上一代 workspace release 可能仍在途。
        // 持有已转移 port 等待 Host 内 generation barrier，避免新 attachment 踩过旧 runtime 清理。
        // [并发] 这里持有已转移的 port 等待 generation barrier（INV-05）：WSL 上一代 workspace 的 release
        // 可能仍在途，新 attachment 若直接挂上会踩到旧 runtime 的清理，表现为首批请求间歇性失败。
        await windowRemoteConnectionRegistry.waitForScopedServices(msg.scope);
      }
      windowHostAttachmentRegistry.attach({
        requestId: msg.requestId,
        attachmentId: msg.attachmentId,
        clientMode: msg.clientMode,
        scope: msg.scope,
        port,
      });
      logger.info(
        `attached scoped service port, attachmentId=${msg.attachmentId}, scope=${msg.scope.kind}, clientMode=${msg.clientMode}`,
      );
      logWindowHostTopology("attachment-added");
    } catch (error) {
      // 跨 logical session 或旧 identity 的 port 若继续暴露，会把远端请求路由到错误 source。
      // scope 校验失败必须关闭已转移端口并明确记录，禁止回退 active local services。
      // [失败路径] 失败端口不能「保持沉默」：renderer 会一直等 channel 注册，最终以超时收场；
      // 显式 reject 让它立刻拿到明确错误，也避免该端口被误当成可用连接。
      rejectUnavailableAttachedServicePort(port, false);
      logger.warn(`failed to attach scoped service port, attachmentId=${msg.attachmentId}`, error);
    }
    return;
  }

  // [资源] detach 同时清理「等待启动」与「已挂载」两种状态，二者互斥但都要处理，
  // 否则一个在 ready 前关闭的端口会留下永远不被消费的闭包。
  if (msg.type === HostMessageTypes.DetachServicePort) {
    pendingStartupAttachments.delete(msg.attachmentId);
    windowHostAttachmentRegistry.detach(msg.attachmentId);
    logger.info(`detached service port, attachmentId=${msg.attachmentId}`);
    logWindowHostTopology("attachment-removed");
    return;
  }

  if (!port) {
    return;
  }

  // [事务] 本地初始化的唯一入口（INV-01）：databaseStartup 非空时只 publish 并关闭新端口，
  // 绝不重建 services。第二次初始化会让旧 attachment 指向孤儿服务实例。
  if (msg.type === HostMessageTypes.InitLocal) {
    if (!port) {
      logger.error("init-local message missing MessagePort");
      return;
    }
    // [事务] 重入分支的行为被刻意限制为「关闭端口 + 重发状态」：
    // 这样刷新后的 renderer 能重新拿到启动状态，又不会污染已经建立的服务集合。
    if (databaseStartup) {
      port.close();
      databaseStartup.coordinator.publish();
      return;
    }
    // [资源] base 端口是 renderer 的生命线：它关闭代表窗口已销毁，后续初始化不应再挂任何服务。
    // `basePortClosed` 用局部标志而非监听器里直接释放，让初始化每阶段都能主动检查。
    let basePortClosed = false;
    port.once("close", () => {
      basePortClosed = true;
    });
    databaseStartup = createHostDatabaseStartup({
      startupId: msg.databaseStartupId,
      cwd: msg.agentSpawnFallbackCwd ?? process.cwd(),
      workingDirectories:
        msg.agentWarmupTargets?.map((target) => target.workspacePath) ??
        (msg.workspacePath ? [msg.workspacePath] : []),
      env: msg.runtimeProcessEnvPatch,
      // [事务] 启动状态是广播语义：每次变化都发给 Main，ready 时额外播放挂起的 attachment（INV-19）。
      // [失败路径] 单个 attachment 播放失败只记 warn 并继续：一个坏端口不能阻塞其余窗口。
      // [资源] 播放后必须 clear，否则每次 publish 都会把同一批闭包再执行一遍。
      publish: (state) => {
        parentPort?.postMessage({ type: HostResponseTypes.DatabaseStartupState, state });
        if (state.phase === "ready") {
          for (const attach of pendingStartupAttachments.values()) {
            try {
              attach();
            } catch (error) {
              logger.warn("startup attachment failed", error);
            }
          }
          pendingStartupAttachments.clear();
        }
      },
      onFailure: (error) =>
        logger.error(
          `local database startup failed attempt=${databaseStartup?.coordinator.snapshot.attemptId}`,
          error,
        ),
      // [事务] 服务装配的顺序有依赖：先建 realtime 桥（后续服务要用），再建 setting（网络代理要读它），
      // 然后才建 transport 与 services。顺序反了会拿到未迁移的 setting 或没有代理的 fetch。
      initializeServices: async () => {
        logger.info("initializing local services");
        activeSessionRealtimePort = createTaskRealtimeBridgeForHostInit(msg, parentPort);
        // 旧 Team 补组织必须与网络代理读取共用同一个 Setting 实例及写队列。
        // 只注入 service 会跳过默认装配分支，导致缺组织的升级用户永远无法恢复连接。
        // [事务] setting 必须带迁移构造（createSettingServiceWithMigrations）：只注入 service 会跳过
        // legacy account 组织补写，缺组织的升级用户永远无法恢复连接。
        // [权衡] 同时取出 prepareLegacyAccountConnections 与 setWorkspaceProjection，供 services 与
        // Bot 链路复用，避免两处各建一个 Setting 实例导致写队列不一致。
        const {
          service: settingService,
          prepareLegacyAccountConnections,
          setWorkspaceProjection,
        } = createSettingServiceWithMigrations();
        // [事务] transport 从 setting 惰性读取代理配置：设置页修改后无需重启，下一个请求即生效。
        // [失败路径] 读取失败由 transport 内部按「直连」降级，但绝不使用全局 fetch（INV-15）。
        const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
          const settings = await settingService.get();
          return {
            httpProxy: settings.httpProxy,
            noProxy: settings.httpProxyNoProxy,
            caCertPath: settings.httpProxyCaCertPath,
          };
        });
        // [事务] transport owner 负责「先连通再装配」：网络不可用时不会建出一半服务，
        // 避免出现「服务在、但所有请求都失败」的半初始化状态。
        // [失败路径] establishOwner 抛错会让初始化整体失败，由启动协调器决定重试或上报。
        const services = await initializeHostApiNetworkTransportOwner({
          transport: hostApiNetworkTransport,
          log: (message, details) => logger.warn(message, details),
          establishOwner: () => {
            const initializedServices = createLocalServices({
              reportPluginTelemetryEvent: (event) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.PluginTelemetry,
                  event: {
                    ...event,
                    context: {
                      ...event.context,
                      screenResolution: event.context.screenResolution || "unknown",
                    },
                  },
                });
              },
              resolveBotProjectConnection,
              resolveBotRemoteWorkspace: (workspace) =>
                sourceServerDirectory
                  ? resolveBotRemoteWorkspace(workspace, "lookup", {
                      directory: sourceServerDirectory,
                      listSessions: () => windowRemoteConnectionRegistry.listSessions(),
                    })
                  : Promise.resolve(null),
              setWorkspaceProjection,
              remoteProjectConnection: {
                connectHost: async (host) => {
                  if (host.target?.kind === "server") {
                    const connected = await windowRemoteConnectionRegistry.connectSource({
                      target: host.target,
                      remoteAssets: msg.remoteAssets ?? {},
                      membershipIntent: "retain",
                    });
                    return remoteProjectHostIdForTarget(host.target, connected.sourceServerId);
                  }
                  if (!sourceServerManagementService)
                    throw new Error("remote-project.connector-unavailable");
                  const management = sourceServerManagementService;
                  const snapshot = await management.getSnapshot();
                  const profiles = snapshot.profiles.filter(
                    (profile) =>
                      profile.lifecycleState !== "retired" &&
                      remoteProjectHostIdForProfile(profile) === host.id,
                  );
                  const preferred = new Set(
                    snapshot.servers.map((server) => server.preferredProfileId),
                  );
                  const profile =
                    profiles.find((item) => preferred.has(item.profileId)) ?? profiles[0];
                  if (!profile) throw new Error("remote-project.profile-not-found");
                  const connected = await management.connectProfile(profile.profileId, {
                    retainedOnly: true,
                  });
                  const resolved = connected.profiles.find(
                    (item) => item.profileId === profile.profileId,
                  );
                  if (
                    !resolved ||
                    !connected.states.some(
                      (state) => state.profileId === resolved.profileId && state.state === "online",
                    )
                  )
                    throw new Error("project.host-offline");
                  return remoteProjectHostIdForProfile(resolved);
                },
                readConnectionStates: async () => {
                  const result = new Map<
                    string,
                    Pick<
                      RemoteProjectHost,
                      | "connectionStatus"
                      | "lastConnectionError"
                      | "lastConnectionStatus"
                      | "upgradeTarget"
                    >
                  >();
                  for (const state of windowRemoteConnectionRegistry.listConnections()) {
                    if (state.target.kind !== "server") continue;
                    result.set(remoteProjectHostIdForTarget(state.target, state.sourceServerId), {
                      connectionStatus:
                        state.state === "online"
                          ? "online"
                          : state.state === "connecting"
                            ? "connecting"
                            : "offline",
                    });
                  }
                  if (!sourceServerDirectory || !sourceServerConnectionManager) return result;
                  const snapshot = await sourceServerDirectory.snapshot();
                  for (const state of sourceServerConnectionManager.listStates()) {
                    const profile = snapshot.profiles.find(
                      (item) => item.profileId === state.profileId,
                    );
                    if (!profile) continue;
                    const id = remoteProjectHostIdForProfile(profile);
                    const value =
                      state.state === "online"
                        ? "online"
                        : ["bootstrapping", "retrying", "updating"].includes(state.state)
                          ? "connecting"
                          : "offline";
                    if (
                      result.get(id)?.connectionStatus !== "online" &&
                      (result.get(id)?.connectionStatus !== "connecting" || value === "online")
                    )
                      result.set(id, {
                        connectionStatus: value,
                        lastConnectionError: state.error,
                        lastConnectionStatus: state.state,
                        // 修复原因：投影曾丢掉 upgradeTarget，桌面端过旧时详情入口误显示“更新远端”。
                        upgradeTarget: state.upgradeTarget,
                      });
                  }
                  return result;
                },
              },
              resolveProjectHostService: async (hostId) => {
                const serverId = parseRemoteWorkspaceIdentity(
                  buildRemoteHostWorkspaceIdentity(hostId, "/"),
                )?.sourceServerId;
                const registered = serverId
                  ? windowRemoteConnectionRegistry.getOnlineSource(serverId)
                  : undefined;
                if (registered && serverId)
                  return bindRemoteProjectIdentities(
                    registered.services.get(IProjectService),
                    async (workspacePath) => {
                      const workspaceIdentity = buildServerRemoteWorkspaceIdentity({
                        serverId,
                        workspacePath,
                      });
                      await registered.capabilities?.bindWorkspaceIdentity?.({
                        workspacePath,
                        stableWorkspaceIdentity: workspaceIdentity,
                      });
                      return workspaceIdentity;
                    },
                  );
                const source = sourceServerConnectionManager?.listStates().find(
                  (state) =>
                    state.sourceServerId &&
                    remoteHostIdFromWorkspaceIdentity(
                      buildServerRemoteWorkspaceIdentity({
                        serverId: state.sourceServerId,
                        workspacePath: "/",
                      }),
                    ) === hostId,
                );
                const connection = source?.sourceServerId
                  ? sourceServerConnectionManager?.getOnlineConnection(source.sourceServerId)
                  : undefined;
                if (!connection || !source?.sourceServerId) throw new Error("project.host-offline");
                const sourceServerId = source.sourceServerId;
                return bindRemoteProjectIdentities(
                  resolveServerProjectService({
                    connectionServices: connection.services,
                    serverId: sourceServerId,
                    virtualProjects: connection.serverInfo.capabilities.virtualProjects,
                    sourceServices: activeServices ?? undefined,
                  }),
                  async (workspacePath) => {
                    await connection.services.sourceServerWorkspaceService.resolveWorkspace({
                      workspacePath,
                    });
                    return buildServerRemoteWorkspaceIdentity({
                      serverId: sourceServerId,
                      workspacePath,
                    });
                  },
                );
              },
              parentPort,
              settingService,
              prepareLegacyAccountConnections,
              hostApiNetworkTransport,
              // [并发] 用闭包读当前值而不是把值拷进去：locale 变更后新请求要立即用新语言（INV-13）。
              resolveClientLanguage: () => applicationLocale,
              authorizeLocalMediaPreviewPath,
              // launch.md「The user's choice」：本机用户选择变化后，推给本窗口所有在线的远程 Host。
              // [并发] 用户模式变化推给所有「已就绪」的远端 Host；未就绪的连接会在建连时自行拉取，
              // 因此不等待、不重试，失败只记 warn。
              forwardDynamicWorkflowUserMode: (mode) => {
                void pushDynamicWorkflowUserModeToRemoteHosts(
                  windowRemoteConnectionRegistry
                    .listReadyConnections()
                    .map(({ target, services: remoteServices }) => ({
                      target,
                      zcodeAgentService: remoteServices.get(IZCodeAgentService),
                    })),
                  mode,
                  (error) => logger.warn("remote dynamic workflow user mode forward failed", error),
                );
              },
              registerPluginSandbox: pluginSandboxRegistrationBridge.register,
              runtimeProcessEnvPatch: msg.runtimeProcessEnvPatch,
              agentTelemetry: {
                getDeviceMid: () => msg.deviceMid,
                runtimeSurface: "desktop_local_host",
              },
              serviceAuthorityMode: "desktop-local",
              zcodeAgentSpawnFallbackCwd: msg.agentSpawnFallbackCwd,
              zcodeBuiltinProviderConfigFilePath: msg.zcodeBuiltinProviderConfigFilePath,
              processLifecycleReporter: runtimeProcessLifecycleReporter,
              taskRuntimeReporter: runtimeTaskReporter,
              feedback: {
                getDeviceMid: () => msg.deviceMid,
                apiBaseUrl: msg.feedbackApiBase,
                createFullLogArchive: createFullFeedbackLogArchiveViaMain,
              },
              forwardSessionMessageSendRequested: (request) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.SessionMessageSendRequested,
                  request,
                });
              },
              onAutomationManualRunRequested: dispatchManualAutomationRun,
              onOffPeakSchedulerWakeRequested: () => {
                parentPort?.postMessage({ type: HostResponseTypes.OffPeakSchedulerWakeRequest });
              },
              onProviderProvisioningSourceChanged: (trigger) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.ProviderProvisioningSourceChanged,
                  trigger,
                });
              },
              // browser-use：agent 的 interaction/browserExecute 经 zcodeAgentService 转到这个 executor，
              // 再经 parentPort 到 main 的 WebContentsView+CDP 执行。
              browserControlExecutor: browserControlMainBridge,
              // CUA 顶部提示属于物理 Windows 桌面投影；非 Windows 和远端 authority 都不得上报。
              // [权衡] 只在 win32 注入：CUA 顶部提示属于物理 Windows 桌面投影，
              // 非 Windows 与远端 authority 上报会让主机的提示条闪烁在错误的机器上。
              cuaOperationStateReporter:
                process.platform === "win32" ? cuaOperationStateReporter : undefined,
            });
            activeServices = initializedServices;
            activeHostApiNetworkTransport = hostApiNetworkTransport;
            return initializedServices;
          },
        });
        const zcodeTaskService = services.getOptional(IZCodeTaskService);
        if (zcodeTaskService) {
          // [事务] 本地 task service 也包一层：本机作为「远端」被手机访问时同样需要路由公告与运行计数，
          // reportRunningPromptCount=false 因为本地场景由 workspaceTaskTracker 另行统计。
          const reportingZCodeTaskService = createReportingRemoteZCodeTaskService(
            zcodeTaskService,
            {
              reportRunningPromptCount: false,
            },
          );
          services.register(IZCodeTaskService, reportingZCodeTaskService);
        }
        // [资源] Source 目录是远端主机的持久索引（profile/server/credential），
        // 与 ConnectionManager 分离：目录可离线读取，manager 才持有真实连接。
        sourceServerDirectory = new SourceServerDirectory({
          settingService: services.get(ISettingService),
          credentialService: services.get(ICredentialService),
          // host 域无 debug 日志通道；按 debug 语义仅在非生产输出，生产 no-op 防止刷盘。
          logDebug: (message) => {
            if (process.env.NODE_ENV !== "production") logger.info(message);
          },
        });
        // [事务] 发布物策略来自 Main 的启动参数，必须在第一次连接前定死：
        // 中途改变会让已缓存的版本清单与远端实际安装的产物不匹配。
              // [事务] 只解析「当前在线」的 project 服务：先查 registry 的已注册 Source，再退到 manager 的在线连接；
              // 两者都没有说明主机离线，必须抛 project.host-offline 而不是尝试新建连接。
              // [权衡] 绑定 workspace identity 时同时给出 stable identity 与 resolver，保证虚拟项目与物理路径两套语义一致。
        // [事务] 发布物策略来自 Main 的启动参数，必须在第一次连接前定死：
        // 中途改变会让已缓存的版本清单与远端实际安装的产物不匹配。
              // [事务] 只解析「当前在线」的 project 服务：先查 registry 的已注册 Source，再退到 manager 的在线连接；
              // 两者都没有说明主机离线，必须抛 project.host-offline 而不是尝试新建连接。
              // [权衡] 绑定 workspace identity 时同时给出 stable identity 与 resolver，保证虚拟项目与物理路径两套语义一致。
// 远端连接的「能力声明」：窗口层只通过这些可选字段判断该连接能提供哪些数据面，
// 而不去探测对端能力位。字段可选即代表旧版 Source 不具备该能力，调用方必须降级。
// [事务] 所有字段都必须来自同一份 connection 元信息，混入后续代际的字段会让 handle 声称拥有它实际上没有的能力。
  // [事务] 附件传输必须由 owning Window Host 构造：Source 侧的工厂读不到 Desktop 的 localPath，
  // 直接在 Source 上建会得到一条「能创建但永远传不出文件」的通道。
  // [权衡] 只取 upload 一个方法而不是整个 IRemoteBackend：上传是唯一需要跨机的能力，
  // 收窄成 Pick 后调用方无法顺手触发其他 backend 行为，减少误用面。
  // [事务] 工厂按 scope 现取，而不是预先绑定一个服务实例：媒体代理依赖当前 services 的 fileService，
  // 绑死实例会在 Source 重连后指向已销毁的文件服务。
  // [事务] 用于判断两条 lease 是否共享同一条物理连接（INV-16）：
  // logical wrapper 每次新建都不等于物理连接换代，比较 services 引用会得出错误结论。
  // [权衡] 返回 object 而不是布尔或 id，是为了让调用方自行决定比较语义，也避免暴露内部句柄。
  // [事务] 打开工作区要同时上报物理路径与 stable identity：前者用于本地索引，后者用于跨机器去重。
  // [失败路径] 该回调是可选的，旧 Source 没有它时必须继续连接，只是失去「最近打开」排序。
  // [事务] 身份绑定是幂等的覆盖写：同一路径多次绑定只保留最后一次 stable identity，
  // 并保留 legacyRouteHint 供迁移期的旧路由继续命中。
  // [失败路径] 绑定失败不阻断连接：身份缺失只影响跨机器去重，不影响本机执行。
// [并发] 三个方法构成一个最小信号量：tryAcquire 失败时调用方必须立即返回 429 语义，
// 不允许自旋等待，否则大图预览会把 Host 的消息循环堵住。
// [失败路径] release 用 max(0, n-1) 夹紧（INV-41）：异常路径重复释放只会让计数归零，不会变成负数。
// [权衡] 默认开启、显式 "0" 才关闭：Range 预览是远端大文件的唯一可行方案，
// 但保留环境变量开关，方便在代理不支持 Range 的环境里一键退回整包下载。
// [事务] parentPort 是 Host 与 Main 的唯一通道；解构一次并在后续判空，避免每处都访问 process。
// 它在进程退出阶段会被置空，所有使用点都必须按「可能为空」处理。
// [资源] 抓包器持有 Main 侧的 captureId 与本地临时文件；Host 只做记录入口，不写盘。
// [资源] pending 记录同时保存 resolve/reject 与进度回调：后者是可选的双向通知，
// 丢了它只是进度条不更新，丢了 resolve 则整个请求永久悬挂，因此二者放在同一条记录里统一清理。
// [资源] 媒体路径授权只有一次性结算，没有进度；因此不需要额外字段，保持最小形状即可。
// [资源] 与归档 pending 同构的第二张挂起表，但 key 空间独立：媒体授权按帧高频产生，
// 与归档请求混表会让 requestId 前缀校验失效，也让清理逻辑难以按业务分别处理。
// [权衡] 上报值是「已归因任务数 + 未归因 prompt 数」：只报前者会让退出屏障在未知 workspace 的
// prompt 上提前放行，只报后者则完全失去 workspace 维度（INV-31）。
// [事务] 用 \u0000 拼接而不是冒号：traceId 自身形如 task:resume:uuid，冒号会让 key 无法反解，
// 进而把两次不同的续跑判成同一个订阅，导致后者的终态被前者吞掉。
// [事务] 台账写入是 best-effort：它只是看板数据，失败不能反过来让派发失败。
// 但 running 这一笔必须先写：否则 UI 在 run 开始到终态之间没有任何可见状态。
// [资源] 先摘表再 dispose，保证 dispose 内部即使同步触发回调也不会二次释放；
// 找不到时静默返回，让重复终态、迟到回调都可以无条件调用。
  // [并发] 派发前先清掉同 key 的旧订阅：同一 task+trace 的重复派发会让两份结算同时回写，
  // 表现为终态在 completed/failed 之间抖动。
  // [事务] 订阅是 task 级的，会收到该任务所有 turn 的终态；必须用 inputId 与本 run 的 traceId 对齐，
  // 否则续跑场景下前一轮的终态会把本轮提前结算。
  // [失败路径] 结算与未读写入都是 fire-and-forget，避免终态回调里做长 I/O 阻塞事件分发。
  // [资源] 只有 manual 触发需要心跳：调度触发的 run 由 scheduler 自己续租，
  // 重复心跳会让两套认领机制互相延长对方的锁。
  // [事务] 心跳与终态订阅合并成一条 dispose 链，保证不会只停掉其中一个。
  // [事务] 第一件事就是解析目标 services：后面的所有读取（task service、model selection）
  // 都必须来自同一份集合，否则远程 workspace 会出现「会话建在远端、模型读自本地」。
  // [失败路径] 模型服务缺失时直接抛错而不是用默认模型：默认模型可能与该 workspace 的
  // 账号/组织不匹配，跑出来的回答无法复现，也绕过了用户的显式选择。
  // [事务] 先声明后赋值，是为了让 catch 块能区分「派发阶段失败」与「派发成功但回写失败」；
  // 两者的善后完全不同：前者要释放 manual claim，后者必须保留 claim 等终态。
    // [失败路径] 派发失败必须释放 claim 并记 failed，然后原样抛出（INV-08 的变体：调用方仍在等结果）。
    // [权衡] 善后本身失败只记 warn：真实错误比善后错误更重要，不能被后者覆盖。
    // [事务] 走到这里说明 prompt 已被接纳，台账回写失败绝不能降级成「派发失败」并释放锁：
    // 释放锁会让同一 automation 立刻再排一个 run，而第一个 run 其实已经在跑（INV-25 的配套约束）。
    // 真实终态仍由 trackCronRunOutcome 收口，所以这里只记日志。
// [资源] 网络遥测与被抓包开关共用同一个 captureId；注册点在启动早期，保证启动阶段的请求也被计入。
  // [失败路径] 这是唯一使用可选链的上报分支：异常上报本身可能发生在 parentPort 已断的退出路径上，
  // 此时抛错会打断正在进行的清理。
// [权衡] 用 satisfies 而不是类型注解：保留对象字面量的精确推断（便于编译器检查每个回调的参数），
// 同时强制它与 createLocalServices 的入参契约保持一致。
// [权衡] 任务计数上报器刻意只有一个方法：扩展它会让 Host 与 Main 之间多出一层需要同步的状态。
// [权衡] CUA 上报器不做平台判断（INV：装配处唯一判定），因此这里永远注册，
// 由调用方决定是否注入，避免两处平台分支得出不同结论。
  // [事务] registry 用这个计数决定 workspace 是否可释放：先于 reportHostRunningTaskCount 调用，
  // 保证 Main 收到汇总值时 registry 已经反映最新状态。
  // [事务] 先按 workspace 找 logical session（不要求 workspaceIdentity）：
  // 项目树的自动化只带路径时也要能命中远端 workspace，否则会静默落回本地（INV-06 的前置校验）。
  // [资源] topic 中继是连接上的「远端资源通道」代理，必须在 connection 之前创建、之后释放（INV-12 的局部版）。
  // 它被三个位置释放：换连失败、handle dispose、shutdown；因此用可选变量而不是 const。
    // [事务] admission（准入）阶段先于真正建连：它负责身份校验、配额与目标解析，
    // 失败时不会有半条连接留下。commit/rollback 成对出现，是这条链上唯一的分布式事务点。
    // [失败路径] 准入失败直接冒泡，由上层翻译成 project.host-offline，不在这里重试。
    // [资源] 中继必须在 connect 之前建好，因为连接建立时要把它作为 channel 传入；
    // 顺序反了会得到一条「连上了但没有资源通道」的连接，topic 读取全部超时。
      // [事务] 建连参数全部来自 admission 的产物：target、commit、topic 通道。
      // [失败路径] 这里失败必须 dispose 刚建的中继（见 catch），否则每次重试都会泄漏一个订阅。
      // [权衡] 不在这里做重试：重试策略属于 Source manager，Window Host 只表达一次尝试。
  // [事务] 预热与 metadata 一律用调用方给的 workspacePath，不在这里做 realpath 归一化：
  // 远端路径必须与 Source 侧看到的字符串完全一致，本机 realpath 会把它改写成本地风格。
  // [权衡] workspaceIdentity 允许为空：本地直连没有跨机身份，硬造一个会让去重键冲突。
        // [事务] 发布物策略来自 Main 的启动参数，必须在第一次连接前定死：
        // 中途改变会让已缓存的版本清单与远端实际安装的产物不匹配。
              // [事务] 只解析「当前在线」的 project 服务：先查 registry 的已注册 Source，再退到 manager 的在线连接；
              // 两者都没有说明主机离线，必须抛 project.host-offline 而不是尝试新建连接。
              // [权衡] 绑定 workspace identity 时同时给出 stable identity 与 resolver，保证虚拟项目与物理路径两套语义一致。
// 远端连接的「能力声明」：窗口层只通过这些可选字段判断该连接能提供哪些数据面，
// 而不去探测对端能力位。字段可选即代表旧版 Source 不具备该能力，调用方必须降级。
// [事务] 所有字段都必须来自同一份 connection 元信息，混入后续代际的字段会让 handle 声称拥有它实际上没有的能力。
  // [事务] 附件传输必须由 owning Window Host 构造：Source 侧的工厂读不到 Desktop 的 localPath，
  // 直接在 Source 上建会得到一条「能创建但永远传不出文件」的通道。
  // [权衡] 只取 upload 一个方法而不是整个 IRemoteBackend：上传是唯一需要跨机的能力，
  // 收窄成 Pick 后调用方无法顺手触发其他 backend 行为，减少误用面。
  // [事务] 工厂按 scope 现取，而不是预先绑定一个服务实例：媒体代理依赖当前 services 的 fileService，
  // 绑死实例会在 Source 重连后指向已销毁的文件服务。
  // [事务] 用于判断两条 lease 是否共享同一条物理连接（INV-16）：
  // logical wrapper 每次新建都不等于物理连接换代，比较 services 引用会得出错误结论。
  // [权衡] 返回 object 而不是布尔或 id，是为了让调用方自行决定比较语义，也避免暴露内部句柄。
  // [事务] 打开工作区要同时上报物理路径与 stable identity：前者用于本地索引，后者用于跨机器去重。
  // [失败路径] 该回调是可选的，旧 Source 没有它时必须继续连接，只是失去「最近打开」排序。
  // [事务] 身份绑定是幂等的覆盖写：同一路径多次绑定只保留最后一次 stable identity，
  // 并保留 legacyRouteHint 供迁移期的旧路由继续命中。
  // [失败路径] 绑定失败不阻断连接：身份缺失只影响跨机器去重，不影响本机执行。
// [并发] 三个方法构成一个最小信号量：tryAcquire 失败时调用方必须立即返回 429 语义，
// 不允许自旋等待，否则大图预览会把 Host 的消息循环堵住。
// [失败路径] release 用 max(0, n-1) 夹紧（INV-41）：异常路径重复释放只会让计数归零，不会变成负数。
// [权衡] 默认开启、显式 "0" 才关闭：Range 预览是远端大文件的唯一可行方案，
// 但保留环境变量开关，方便在代理不支持 Range 的环境里一键退回整包下载。
// [事务] parentPort 是 Host 与 Main 的唯一通道；解构一次并在后续判空，避免每处都访问 process。
// 它在进程退出阶段会被置空，所有使用点都必须按「可能为空」处理。
// [资源] 抓包器持有 Main 侧的 captureId 与本地临时文件；Host 只做记录入口，不写盘。
// [资源] pending 记录同时保存 resolve/reject 与进度回调：后者是可选的双向通知，
// 丢了它只是进度条不更新，丢了 resolve 则整个请求永久悬挂，因此二者放在同一条记录里统一清理。
// [资源] 媒体路径授权只有一次性结算，没有进度；因此不需要额外字段，保持最小形状即可。
// [资源] 与归档 pending 同构的第二张挂起表，但 key 空间独立：媒体授权按帧高频产生，
// 与归档请求混表会让 requestId 前缀校验失效，也让清理逻辑难以按业务分别处理。
// [权衡] 上报值是「已归因任务数 + 未归因 prompt 数」：只报前者会让退出屏障在未知 workspace 的
// prompt 上提前放行，只报后者则完全失去 workspace 维度（INV-31）。
// [事务] 用 \u0000 拼接而不是冒号：traceId 自身形如 task:resume:uuid，冒号会让 key 无法反解，
// 进而把两次不同的续跑判成同一个订阅，导致后者的终态被前者吞掉。
// [事务] 台账写入是 best-effort：它只是看板数据，失败不能反过来让派发失败。
// 但 running 这一笔必须先写：否则 UI 在 run 开始到终态之间没有任何可见状态。
// [资源] 先摘表再 dispose，保证 dispose 内部即使同步触发回调也不会二次释放；
// 找不到时静默返回，让重复终态、迟到回调都可以无条件调用。
  // [并发] 派发前先清掉同 key 的旧订阅：同一 task+trace 的重复派发会让两份结算同时回写，
  // 表现为终态在 completed/failed 之间抖动。
  // [事务] 订阅是 task 级的，会收到该任务所有 turn 的终态；必须用 inputId 与本 run 的 traceId 对齐，
  // 否则续跑场景下前一轮的终态会把本轮提前结算。
  // [失败路径] 结算与未读写入都是 fire-and-forget，避免终态回调里做长 I/O 阻塞事件分发。
  // [资源] 只有 manual 触发需要心跳：调度触发的 run 由 scheduler 自己续租，
  // 重复心跳会让两套认领机制互相延长对方的锁。
  // [事务] 心跳与终态订阅合并成一条 dispose 链，保证不会只停掉其中一个。
  // [事务] 第一件事就是解析目标 services：后面的所有读取（task service、model selection）
  // 都必须来自同一份集合，否则远程 workspace 会出现「会话建在远端、模型读自本地」。
  // [失败路径] 模型服务缺失时直接抛错而不是用默认模型：默认模型可能与该 workspace 的
  // 账号/组织不匹配，跑出来的回答无法复现，也绕过了用户的显式选择。
  // [事务] 先声明后赋值，是为了让 catch 块能区分「派发阶段失败」与「派发成功但回写失败」；
  // 两者的善后完全不同：前者要释放 manual claim，后者必须保留 claim 等终态。
    // [失败路径] 派发失败必须释放 claim 并记 failed，然后原样抛出（INV-08 的变体：调用方仍在等结果）。
    // [权衡] 善后本身失败只记 warn：真实错误比善后错误更重要，不能被后者覆盖。
    // [事务] 走到这里说明 prompt 已被接纳，台账回写失败绝不能降级成「派发失败」并释放锁：
    // 释放锁会让同一 automation 立刻再排一个 run，而第一个 run 其实已经在跑（INV-25 的配套约束）。
    // 真实终态仍由 trackCronRunOutcome 收口，所以这里只记日志。
// [资源] 网络遥测与被抓包开关共用同一个 captureId；注册点在启动早期，保证启动阶段的请求也被计入。
  // [失败路径] 这是唯一使用可选链的上报分支：异常上报本身可能发生在 parentPort 已断的退出路径上，
  // 此时抛错会打断正在进行的清理。
// [权衡] 用 satisfies 而不是类型注解：保留对象字面量的精确推断（便于编译器检查每个回调的参数），
// 同时强制它与 createLocalServices 的入参契约保持一致。
// [权衡] 任务计数上报器刻意只有一个方法：扩展它会让 Host 与 Main 之间多出一层需要同步的状态。
// [权衡] CUA 上报器不做平台判断（INV：装配处唯一判定），因此这里永远注册，
// 由调用方决定是否注入，避免两处平台分支得出不同结论。
  // [事务] registry 用这个计数决定 workspace 是否可释放：先于 reportHostRunningTaskCount 调用，
  // 保证 Main 收到汇总值时 registry 已经反映最新状态。
  // [事务] 先按 workspace 找 logical session（不要求 workspaceIdentity）：
  // 项目树的自动化只带路径时也要能命中远端 workspace，否则会静默落回本地（INV-06 的前置校验）。
  // [资源] topic 中继是连接上的「远端资源通道」代理，必须在 connection 之前创建、之后释放（INV-12 的局部版）。
  // 它被三个位置释放：换连失败、handle dispose、shutdown；因此用可选变量而不是 const。
    // [事务] admission（准入）阶段先于真正建连：它负责身份校验、配额与目标解析，
    // 失败时不会有半条连接留下。commit/rollback 成对出现，是这条链上唯一的分布式事务点。
    // [失败路径] 准入失败直接冒泡，由上层翻译成 project.host-offline，不在这里重试。
    // [资源] 中继必须在 connect 之前建好，因为连接建立时要把它作为 channel 传入；
    // 顺序反了会得到一条「连上了但没有资源通道」的连接，topic 读取全部超时。
      // [事务] 建连参数全部来自 admission 的产物：target、commit、topic 通道。
      // [失败路径] 这里失败必须 dispose 刚建的中继（见 catch），否则每次重试都会泄漏一个订阅。
      // [权衡] 不在这里做重试：重试策略属于 Source manager，Window Host 只表达一次尝试。
  // [事务] 预热与 metadata 一律用调用方给的 workspacePath，不在这里做 realpath 归一化：
  // 远端路径必须与 Source 侧看到的字符串完全一致，本机 realpath 会把它改写成本地风格。
  // [权衡] workspaceIdentity 允许为空：本地直连没有跨机身份，硬造一个会让去重键冲突。
  // [事务] 协议层只负责帧的编解码与 sideband 分流；所有业务能力都在 ChannelServer 之上注册。
  // 把 protocol 提到 server 之外持有，是为了 dispose 时能先断协议再丢端口，
  // 保证关闭瞬间仍在排队的分片不会被当作新帧解析。
  // [失败路径] 端口若已关闭，构造 protocol 不抛错，错误会在第一次 write 时以 close 事件暴露。
  // [权衡] 日志装饰放在遥测之内：logRpc 需要看到原始帧（含 channel 名与请求 id），
  // 若套在 telemetry 外面则会记录装饰后的包装对象，排查时对不上 renderer 侧日志。
  // [资源] 装饰器不持有额外资源，dispose 时只需释放 rawServer。
  // [权衡] 遥测装饰在最外层：它统计的是「这一跳 RPC 的真实耗时」，
  // 包含日志与序列化开销；放在里层会少算这部分，指标与用户体感不一致。
  // [失败路径] 遥测写失败不能影响 RPC 本身，装饰器内部已按 best-effort 处理。
  // [事务] Agent 服务是可选能力：手机与 headless 场景可能不注册它，
  // 因此这里取 Optional 而不是 get，缺失时后续不注入 connectionScope，
  // 让 attachment 仍然可用（只是没有会话级 agent RPC）。
  // [事务] connectionScope 把「这次端口握手的身份」绑定到 agent 服务上，所有会话级 RPC 都带这个作用域。
  // [并发] 每个 attachment 一份 scope：两个窗口共享同一 Agent 时，关闭其一只销毁自己的会话，
  // 复用同一 scope 会让另一个窗口的会话跟着消失（INV-34 的上层约束）。
  // [失败路径] agentService 缺失时 scope 为 undefined，conversationShare 会退回非 scope 包装。
  // [事务] overrides 是「本次 attachment 的替换表」：key 是 channel 名，value 是该通道的服务实现。
  // 用 Map 而不是对象，是因为 channel 名来自常量对象，可能包含点号等不适合做属性名的字符。
  // 这里先放入 controller，后续按 clientMode 逐步收窄（INV-03）。
  // [事务] 媒体代理覆盖 base 的 file/media 通道：远端文件的 Range 读取只有它能正确处理。
  // [失败路径] 代理构造失败时 upstream 返回 undefined，此处不覆盖，前端会退回整包下载而不是报错。
  // [事务] 每个 attachment 都包一层 controller-routed 服务（INV-43）：
  // 同一份 taskService 被本地、远端、手机三种 scope 共用，路由必须按 attachment 的 scope 解析。
  // [权衡] 包装是轻量的（只拦截写方法），因此不做缓存复用，避免 scope 变化后拿到旧包装。
  // [事务] Share 的 rowsRange 会校验连接可信度，必须使用与本次握手相同的 connectionScope；
  // 直接暴露原服务会让手机/远端分享请求以 connection untrusted 被拒绝（INV-03 的具体案例）。
  // [失败路径] scope 缺失时传入 undefined，包装器按 clientMode 决定是否降级为不可分享。
  // [资源] disposed 是 handle.dispose 的幂等闸（INV-34）：端口 close 与上层显式 dispose 都可能触发，
  // 两者竞争时必须只有一次真正的释放流程。
  // [并发] 每次状态更新都追加到同一条 Promise 链（INV-35）：不 await 上一个就发送会让
  // saturated 与 closed 在传输层乱序，CLI 侧的暂停状态可能被重新打开或永远关不掉。
  // [失败路径] 链上失败只记录并吞掉，保证后续状态仍能继续投递；否则一次写失败会永久冻结流控。
  // [权衡] 返回 update 而不是链尾，让需要确认的调用方（close）能等待自己那一跳完成。
    // [资源] dispose 之后仍可能收到 sideband 帧（端口关闭是异步的），必须在这里丢弃，
    // 否则会向已释放的 connectionScope 写状态，产生「已关闭却仍上报 drained」的假日志。
    // [资源] 释放顺序不可交换：事件订阅 → controller → 附件传输 → 媒体代理 → closed 流控 → 协议断开（INV-34）。
    // [失败路径] 附件传输与媒体代理的释放都带 catch：它们是跨机通道，对端可能已先断开，
    // 失败只记 warn，不能阻断后续的协议关闭，否则端口会一直处于半关闭状态。
    // [事务] closed 必须 await 完成后再 dispose scope，保证 CLI 不会在 closed 之后收到 saturated。
      // [资源] 最后才释放 server 与 protocol：前面所有步骤都可能还在用 channel 写事件。
      // 先释放 server 会让 settle 阶段的错误响应无处可发，renderer 只能等超时。
  // [权衡] 只记 mode 不记 scope 明细：这条日志每次 attach 都会出现，
  // 带路径会让日志体积随 workspace 深度增长，而 mode 已足够定位「谁连上来了」。
      // [事务] 本地 scope 的 generation 固定为 1：本地 services 只在初始化时创建一次，没有换代概念，
      // 用递增版本号反而会让 registry 误判存在新代际并触发不必要的 detach。
      // [事务] 双来源查找：manager 的在线连接优先（它持有最新握手信息），registry 的已注册 Source 兜底，
      // 后者覆盖「连接由另一个窗口建立、但本窗口尚未 attach」的场景。
      // [失败路径] 两处都没有即视为离线，抛错而不返回空集合——空集合会让设置页读到一个永不返回的 RPC。
      // [事务] Source settings 是「裁剪后的服务集合」：只暴露配置相关通道，
      // 复用同一份 configServices 以保证设置写入落在同一条连接上。
      // [并发] generation 取 manager 的 updatedAt：状态更新即代表设置面换代，
      // 这样 registry 能在重连后主动 detach 旧设置附件（INV-05 的一种）。
    // [失败路径] 远程 scope 必须显式校验 logical session 仍存在：renderer 持有的 remoteSessionId 可能已过期，
    // 不校验会让 resolveScopedServices 抛出一个不带上下文的内部错误。
    // [事务] generation 与 capabilities 一并返回，保证 registry 判定过期与能力注入使用的是同一代际。
  // [并发] registry 在调用 expose 前已完成 generation 校验与登记；这里传 false 表示「端口已就绪，立即初始化」，
  // 与 remote 建连路径的 deferInit=true 形成两个不同的初始化时机。
  // [权衡] 统计只在显式调用时读取：拓扑日志用于事后对账「attach 数是否等于端口数」，
  // 常驻采样会让每次 attach/detach 都产生额外分配。
  // [并发] 先中止所有在途的项目导航再进入阶段释放：导航可能正在建连并写入 registry，
  // 不中止会让释放阶段与建连阶段并发修改同一批 session。
  // [资源] clear 必须紧跟 abort：否则已完成的请求会留在表里，长命 Host 会持续增长。
    // [事务] 先捕获再置 null：这样即便后续阶段抛错，也已经没有「activeServices 仍然可用」的错觉；
    // 同时保证并发到达的 attachment 请求会立刻看到未初始化而失败，而不是挂到一个正在被销毁的集合上。
    // [资源] 捕获后的引用交给 service-dispose 阶段，确保只释放一次。
          // [事务] 第一阶段释放远端 registry：它持有全部 logical session 与它们的 attachment，
          // 必须先于 Source manager，否则 manager 断开物理连接时 registry 还会尝试重连。
          // [权衡] 超时给到 6 秒：多条 SSH 连接的优雅关闭是串行 RPC，时间随连接数增长。
          // [失败路径] 超时只会被记入 timedOutPhases，后续阶段继续执行，不因远端而阻塞本地退出。
          // [事务] 第二阶段释放 Source manager 与其管理服务，然后把四个引用一起置 null；
          // 置 null 是为了让迟到的 resolveSource 调用明确失败，而不是命中一个已 dispose 的对象。
          // [资源] sourceSettingsStateSubscription 必须单独 dispose：它挂在 manager 上，
          // 只清 manager 不会解除状态监听，重连回调仍可能在退出途中被调用。
                // [事务] 最后释放本地 services：前面的阶段可能仍通过回调引用 task/agent 服务，
                // 提前释放会让这些回调以「服务已关闭」报错，污染退出诊断。
                // [资源] disposeServiceResourcesAndWait 会等待各服务完成异步收尾（例如 rollout 落盘）。
                // [权衡] 3.5 秒是经验值：超过这个时间通常意味着网络写回已经不可恢复，继续等只会拖慢退出。
    // [资源] 传输最后置 null：前面的阶段可能仍要用它做收尾请求（例如上报离线状态），
    // 提前置空会让这些请求退回全局 fetch，正是 INV-15 要避免的情况。
  // [权衡] 覆盖率刷盘只在异步收口后做，并且失败只记 warn：它是测试设施，
  // 线上不启用；但一旦启用，必须在退出前完成，否则 CI 拿不到覆盖数据。
      // [失败路径] exit 兜底路径里释放 services 必须整段 try/catch：此时 event loop 即将停止，
      // 任何一个服务抛错都会让 finally 之后的清理（置 null）也一并跳过。
      // [事务] 无论释放成败都置 null，保证不会在进程最后时刻留下「services 仍可用」的假象。
  // [资源] 关闭开始时先清空挂起的 attachment 闭包（INV-09/19）：
  // 这些闭包捕获了 MessagePort，保留它们会让端口在 Host 退出前一直无法被 GC 回收。
  // [失败路径] 这里不逐个回执失败：端口会随后由 Main 关闭，renderer 收到 close 事件即可。
        sourceServerArtifactPolicy =
          msg.remoteAssets?.sourceServerArtifactPolicy ?? "release-versioned";
        // Bug 原因：release resolver 过去只传给 updateSource；启动恢复和 connectProfile 直接调用
        // Manager，在 development-content-addressed 同版本校验处拿不到本地 archive，必然误报 unavailable。
        const resolveSourceServerRelease = async (
          probe: Parameters<typeof resolveSourceServerReleaseAsset>[0],
          target: Parameters<typeof resolveSourceServerReleaseAsset>[2],
          options?: { metadataOnly?: boolean },
        ) =>
          await resolveSourceServerReleaseAsset(
            probe,
            msg.remoteAssets ?? {},
            target,
            {
              fetch: hostApiNetworkTransport.fetch,
            },
            options,
          );
        sourceServerConnectionManager = new SourceServerConnectionManager({
          directory: sourceServerDirectory,
          admitConnection: createRemoteProjectConnectionAdmission(
            services.get(IRemoteProjectService),
          ),
          onProjectChange: notifyProjectChange,
          logWarn: (message, error) => logger.warn(message, error),
          sourceServerArtifactPolicy,
          resolveRelease: resolveSourceServerRelease,
        });
        sourceServerManagementService = createSourceServerManagementService({
          directory: sourceServerDirectory,
          manager: sourceServerConnectionManager,
          resolveRelease: resolveSourceServerRelease,
          onDirectorySnapshot: (snapshot) => {
            sourceServerDisplayNameById.clear();
            for (const server of snapshot.servers) {
              sourceServerDisplayNameById.set(server.sourceServerId, server.displayName);
            }
          },
          onBeforeSourceServerRemoved: async (sourceServerId) => {
            const hostId = remoteHostIdFromWorkspaceIdentity(
              buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" }),
            );
            if (!hostId) throw new Error("remote-project.invalid-host-identity");
            await services.get(IRemoteProjectService).removeHost(hostId);
            windowHostAttachmentRegistry.detachSourceSettingsAttachments(sourceServerId);
            sourceServerDisplayNameById.delete(sourceServerId);
          },
        });
        sourceSettingsStateSubscription = sourceServerConnectionManager.onDidChangeState(
          (state) => {
            notifyProjectChange();
            if (state.sourceServerId && shouldDetachSourceSettingsAttachment(state.state)) {
              windowHostAttachmentRegistry.detachSourceSettingsAttachments(state.sourceServerId);
            }
          },
        );
        services.register(ISourceServerManagementService, sourceServerManagementService);
        wireLocalResourceTelemetry(services);
        hasDisposedHostResources = false;
        disposeHostResourcesInFlight = null;
        const agentWarmupTargets =
          msg.agentWarmupTargets && msg.agentWarmupTargets.length > 0
            ? msg.agentWarmupTargets
            : msg.workspacePath
              ? [
                  {
                    workspacePath: msg.workspacePath,
                    ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
                  },
                ]
              : [];
        // Main 已把启动预热限制为 active workspace 1 个；Host 必须显式消费这份固定名单，
        // 不能让后续 task-list observer 再隐式扩大，也不能因失败扫描补位。
        agentWarmupTargets.forEach((target, index) => {
          warmUpZCodeAgent(
            services,
            target,
            `local host init (${index + 1}/${agentWarmupTargets.length})`,
          );
        });
        logger.info("exposing services on ChannelServer...");
        if (!basePortClosed)
          windowHostAttachmentRegistry.attach({
            requestId: `init-local-${randomUUID()}`,
            attachmentId: `base-${randomUUID()}`,
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
            port,
          });
        logWindowHostTopology("base-attachment-ready");
        logger.info("local services ready, all channels registered");
        // URL Host 复用相同启动开关与 Registry；项目发现不创建 logical workspace/Agent。
        void runStartupReconnectBatch({
          getSettings: () => services.get(ISettingService).get(),
          listCandidates: async () =>
            (await services.get(IRemoteProjectService).readDirectory()).hosts.filter(
              (host) => host.kind === "server",
            ),
          reconnect: (hosts) =>
            Promise.all(
              hosts.map(async (host) => {
                try {
                  await services.get(IRemoteProjectService).connectHost(host.id);
                } catch (error) {
                  logger.warn("URL Server startup reconnect failed", { hostId: host.id, error });
                }
              }),
            ),
        }).catch((error) => logger.warn("URL Server startup directory unavailable", error));

        // Bug 原因：Directory 迁移属于远程附加能力，等待它完成会把本地 base attachment 的
        // 首帧一起拖住。base ready 后再后台初始化；失败 flight 清空，用户显式连接仍可重试。
        void sourceServerDirectory
          .initialize()
          .then(async () =>
            runStartupReconnectBatch({
              getSettings: () => services.get(ISettingService).get(),
              listCandidates: async () => {
                const retained = new Set(
                  (await services.get(IRemoteProjectService).readDirectory()).hosts.map(
                    (host) => host.id,
                  ),
                );
                return (await sourceServerDirectory!.listStartupReconnectCandidates()).filter(
                  (candidate) => retained.has(remoteProjectHostIdForProfile(candidate.profile)),
                );
              },
              reconnect: (candidates) =>
                sourceServerConnectionManager!.reconnectOnStartup(candidates),
            }),
          )
          .then((results) => {
            const online = results.filter((result) => result.status === "online").length;
            // Bug 原因：过去只记录失败计数，真实 Profile/reason 被吞掉，导致冷启动失败只能靠
            // 手动重连再次触发。启动批次最多 3 个，逐项 warn 不会形成高频日志。
            for (const result of results) {
              if (result.status === "failed") {
                logger.warn("Source Server startup reconnect failed", {
                  profileId: result.profileId,
                  error: result.error,
                });
              }
            }
            logger.info(
              `Source Server startup reconnect finished, online=${online}, failed=${results.length - online}`,
            );
          })
          .catch((error) =>
            logger.warn(
              "Source Server directory initialization failed; local services remain available",
              error,
            ),
          );
      },
    });
    await databaseStartup.coordinator.start();
  }
});
