// @zcode/shared 的唯一公共入口（barrel）：对外只做名字再导出，自身不实现任何业务逻辑。
// 职责：把 src 下的协议、类型、常量与纯工具收敛成一个稳定的包级契约面，供 desktop / web / server / cli 统一引用。
// 不负责：不在这里做校验、默认值、序列化、状态缓存或环境探测；这些实现留在被再导出的源文件里，本文件只转发名字。
// 也不负责替源模块决定可见性——某个名字是否该公开由源文件的职责边界决定，这里只把它接到出口。
//
// 不变量表（改动本文件前逐条自检，每删或改一行导出都要能对上一条）：
// INV-01 断言：同名的显式导出会覆盖 export * 透出的同名成员 —— 守住它的位置：成对的显式导出语句与 star 行 —— 改错故障：显式语句被删后 star 会把旧签名重新暴露，消费者编译通过却拿到另一个实现
// INV-02 断言：两条 star 导出若提供同名成员，该名字会被整体剔除且不报错 —— 守住它的位置：任意两行 export * from —— 改错故障：消费者 import 到 undefined 或提示未导出，报错点根本不在被删的那一行
// INV-03 断言：export type 块只在类型层存在，运行时没有任何对应绑定 —— 守住它的位置：本文所有 type 导出列表 —— 改错故障：被当值使用（反射、枚举遍历、instanceof）时运行期取到 undefined
// INV-04 断言：export * 不透传 default 导出 —— 守住它的位置：全部 star 行 —— 改错故障：源模块新增 default 后消费者拿不到，误判为 barrel 漏行而补显式导出，最终出现两个来源
// INV-05 断言：from 路径一律带 .js 后缀且大小写与文件名完全一致 —— 守住它的位置：每条 from 子句 —— 改错故障：NodeNext 解析报 TS2835 或运行时找不到模块，Windows 大小写不敏感会掩盖到 Linux CI 才炸
// INV-06 断言：目录入口必须显式写 index.js（zcode-protocol、source-server、browser-use）—— 守住它的位置：对应的三行 star —— 改错故障：省略 index.js 后解析失败或落到别的入口，导出面整体缺失
// INV-07 断言：#src/web-remote-relay/index.js 依赖包内 imports 映射 #src/* —— 守住它的位置：唯一使用 #src 的那行 —— 改错故障：package.json 的 imports 被改或该子路径被移动，整个 barrel 在加载阶段失败
// INV-08 断言：显式清单必须与源文件实际导出逐字对齐 —— 守住它的位置：protocol、platform、telemetry 的大块类型列表 —— 改错故障：源文件改名后此处悬空，typecheck 在本包报错，但真正卡住的是所有下游
// INV-09 断言：同一模块的类型面与值面要分成两条语句（type 导出与值导出）—— 守住它的位置：protocol、telemetry、shortcutCommands、launchMarks、platform 等成对出现的两段 —— 改错故障：把值挪进 type 导出后运行时为空，把类型挪进值导出则引入无意义的运行期依赖
// INV-10 断言：remoteAssetInstallMode、remoteResourcePackages、zcode-task-types 的显式类型导出只是点名，值仍靠后续 star 行提供 —— 守住它的位置：这几处显式块与其后的 star —— 改错故障：认为已导出过而删掉 star 行，常量与归一化函数会静默消失
// INV-11 断言：本文件只允许再导出与唯一的 ICredentialStore 接口声明，不写任何运行时代码 —— 守住它的位置：文件内除 interface 外的所有语句 —— 改错故障：顶层求值会随每个消费者进程各跑一次，冷启动与测试副作用随之放大
// INV-12 断言：删改任一导出行都属于破坏性变更，只能追加 —— 守住它的位置：整份文件 —— 改错故障：下游包编译失败，且无法用 patch 版本回退，只能发 major 或撤销发布
// INV-13 断言：barrel 的模块求值顺序等于导出行的书写顺序 —— 守住它的位置：全部 export 行的相对次序 —— 改错故障：重排会让注册表、环境读取等副作用提前或延后，出现只在冷启动可见的差异
// INV-14 断言：barrel 不是深路径导入的替代方案，跨包引用只能走包名入口 —— 守住它的位置：实现侧的 import 站点 —— 改错故障：有人用 @zcode/shared/src 直连后，源文件改名只改到一半，另一批引用继续静默编译
// INV-15 断言：re-home 段（旧协议承重面）必须保留 star 导出，不能收窄成显式清单 —— 守住它的位置：遗留类型那组连续 star 行 —— 改错故障：漏列的成员在运行期才缺失，类型侧可能因 any 扩散无报错
// INV-16 断言：脱敏与密钥类能力只能来自其专用模块，不得在本文件内重写或内联默认值 —— 守住它的位置：stripRemoteTargetSecrets、buildSshRemoteHostKey、redactFeedbackText、telemetryRedaction 段 —— 改错故障：多出一条本地兜底实现后两套规则并存，敏感字段从弱的一侧泄漏
//
// 阅读顺序建议：INV-01~04 是 ESM 语义层面的隐式规则，INV-05~12 是本仓库的约束，INV-13~16 是针对具体防线的提醒。
export { cloudContentPayloadSchema, contentBundleSchema } from "./cloudContent.js";
// [契约] networkCapture 走整块 star，新增采集事件类型无需回来改 barrel。
// 但正因为它全量透出，任何与该模块新成员同名的导出都会被 ESM 歧义规则静默剔除。
// [失败路径] 症状是消费者 import 到 undefined 而不是这里编译报错，排查时不要从本行下手。
// 若确需收窄可见性，改的是 networkCapture 自身的导出，不是在这行改成显式清单。
export * from "./networkCapture.js";
export type {
  CloudContentPayload,
  CloudContentBundle,
  CloudContentHeroType,
} from "./cloudContent.js";
export type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  FileTextSlice,
  FileWatchEvent,
  WorkspaceFileEntry,
  SystemInfo,
  AppSettings,
  ElectronReleaseChannel,
  IntegratedTerminalShellDialect,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  Locale,
  LocalePreference,
  ZCodeInteractionBehavior,
  TabId,
  TabState,
  ResourceUsageCategory,
  ResourceUsageBaseGroupKey,
  ResourceUsageProcess,
  HostResourceUsageProcess,
  ResourceUsageSnapshot,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
  PersistedWorkspaceSessionEntry,
} from "./protocol.js";
export type { WorkspacePurpose } from "./workspacePurpose.js";
// [契约] 默认语言是运行时值，只能出现在值导出里；上方大块 type 导出只搬类型。
// 把它误并入 type 导出后，import 端编译期仍通过，运行期得到 undefined，语言回退到硬编码分支。
// DEFAULT_LOCALE 是 UI 与远端会话共用的同一份事实，不要在本文件再包一层默认值。
// [失败路径] 在此处加备用语言会在注入失效时静默走错分支，而不是启动即报错。
export { DEFAULT_LOCALE } from "./protocol.js";
// [契约] 版本三元组由构建期注入 version 模块，barrel 只转发，不在本文件设兜底常量。
// [权衡] 加兜底会让构建漏注入从启动即失败退化为展示 0.0.0，问题被推迟到线上才被发现。
// 这三个导出名是打包脚本与关于页共同依赖的字面量，改名等同于改协议。
// [失败路径] 改名后调用方拿到 undefined 版本串，自动更新比对会退化成永远有新版本。
export { ZCODE_VERSION, ZCODE_COMMIT, ZCODE_BUILD_TIME } from "./version.js";
export type { HelloMessage, HelloAckMessage } from "./handshake.js";
export type { ArmsRumEnv, ZCodeEnv, ZCodeProductFlavor } from "./env.js";
export type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
export type {
  RemoteResourcePackageId,
  RemoteResourcePackageSelection,
} from "./remoteResourcePackages.js";
export type {
  DockerConnectOptions,
  RemoteTarget,
  ServerConnectOptions,
  SSHConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";
// [契约] 与上方 remoteTarget 类型块同源但必须分两条语句：这里导出的是可执行函数。
// 它是远端目标写进日志、快照或持久化之前的唯一清洗口，调用方不得自建脱敏。
// [失败路径] 若因重复导出的印象删掉本行，密码与私钥口令会随目标对象原样落库。
// [权衡] 合并两条语句看似更整洁，但会把类型查询变成运行期依赖，入口模块被迫加载实现。
export { stripRemoteTargetSecrets } from "./remoteTarget.js";
export { buildSshRemoteHostKey } from "./remoteSshHostKey.js";
// [契约] Environment 级身份的构造器只此一处，业务侧不得手写 ssh、wsl、docker 前缀拼接。
// 该 key 与 workspace、session 身份严格分层，不要把它当工作区去重键复用。
// [并发] 同一目标在多个窗口重复建连时必须命中同一 key，否则会各建一份 provisioning 状态。
// [失败路径] 自行拼键会让状态按错误粒度命中，表现为串用他人的远端配置。
export { buildRemoteEnvironmentKey } from "./remoteEnvironmentKey.js";
export type {
  ShortcutChannel,
  ShortcutCommandEntry,
  ShortcutCommandId,
  ParsedShortcutBinding,
} from "./shortcutCommands.js";
export {
  SHORTCUT_COMMANDS,
  getDefaultShortcutBindings,
  isValidShortcutBinding,
  normalizeShortcutKey,
  parseShortcutBinding,
  serializeShortcutBinding,
// [契约] 快捷键的值面（命令表、默认绑定、解析与序列化）必须成组导出，缺一项语义就不完整。
// 键位序列化的规范形式由该模块定义，UI 只消费结果，不要在本文件补任何格式化逻辑。
// [失败路径] 只导出命令表而漏掉解析函数，调用方会各自实现解析，出现同键不同义。
// 上一段 type 导出与本段值导出同源，新增字段时两边都要看，只改一边会让类型与实现错位。
} from "./shortcutCommands.js";
export {
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_APP_VERSION_ENV,
  ZCODE_BUILD_COMMIT_ID_ENV,
  RUNTIME_ZCODE_DEBUG,
  ZCODE_ARMS_RUM_ENDPOINT,
  ZCODE_TELEMETRY_REPORT_ENDPOINT,
  ZCODE_AUTO_UPDATE_ENABLED,
  mapZCodeEnvToArmsRumEnv,
  normalizeZCodeEnv,
  normalizeZCodeProductFlavor,
} from "./env.js";
// [契约] errors 模块同时提供错误类（值）与判别辅助，只能整块 star 透出。
// 跨进程识别错误依赖类名或 code，改导出名等于改协议。
// [失败路径] 收窄成显式清单后新增错误类型不会自动出现在消费者侧，判定落到兜底分支。
// [权衡] `export * from "./errors.js"` 让新增错误零成本扩散，代价是消费者侧失去编译期护栏。
export * from "./errors.js";
export * from "./rendererActionTrace.js";
export * from "./validation.js";
export * from "./api.js";
export * from "./zcode-protocol/index.js";
export * from "./account-provider-state.js";
// re-home：旧协议承重面的幸存文件（消费者继续走 barrel，零感知）
// [契约] re-home 遗留面继续走 star，是让老消费者留在 barrel 上的关键，不能改成逐条清单。
// 这些名字虽标注 legacy，仍有运行期调用方，删减要以引用查询结果为准而非文件名。
// [权衡] 收窄能换来更干净的类型面，代价是把迁移风险转嫁给下游，且漏项不会在编译期暴露。
// [失败路径] 按文件名判断已废弃而删除，老版本客户端的握手载荷解析会直接失败。
export * from "./zcode-protocol-legacy-types.js";
export * from "./zcode-task-types-core.js";
export * from "./task-realtime-core.js";
export * from "./remote-workspace-identity.js";
export * from "./zcode-api-retry-status.js";
export * from "./zcode-network-debug-status.js";
export * from "./zcode-session-visible-content.js";
export * from "./official-mcp-auth.js";
export * from "./official-mcp-tool-error.js";
export * from "./conversation-message-projection-policy.js";
export * from "./conversation-share.js";
export * from "./conversation-share-content.js";
export * from "./conversation-preview-artifacts.js";
export * from "./zcode-session-task-status.js";
export * from "./zcode-session-content-profile.js";
export * from "./zcode-tool-projection-memory.js";
export * from "./zcode-slash-command-help.js";
export * from "./zcodeEndpoint.js";
export * from "./zcode-source-headers.js";
export * from "./zcode-agent-policy.js";
export * from "./zcode-media-policy.js";
export * from "./media-preview.js";
export * from "./plugin-display-name.js";
export * from "./zcode-agent-runtime.js";
export * from "./runtimeEnv.js";
export * from "./dynamic-workflow-feature.js";
export * from "./markdown-artifact-images.js";
export * from "./serviceAuthority.js";
export * from "./server-remote.js";
export * from "./source-server/index.js";

// [契约] 这是本文件唯一允许的声明：纯类型、无运行时代码，方法按异步能力定义。
// 它描述 desktop 与 web 两侧凭据存储的能力边界，实现留在各自平台侧。
// [权衡] 挪进单独模块会引入新的循环引用路径，故有意留在入口文件，不要为整洁搬走。
// [失败路径] 搬走后依赖方会从深路径取类型，与这里的方法签名各自演进，最终无法互相赋值。
export interface ICredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// 这一行被夹在内联接口与后续 star 之间，位置来自历史追加，不代表分组语义。
// [契约] 追加导出只能往末尾或就近追加，重排整段会改变模块求值顺序。
// [失败路径] 顺手做按字母排序的整理，会让带副作用的模块提前执行，且 diff 难以审查。
// 若确实要重新分组，先确认源模块有无顶层副作用，再单独提交一次纯移动变更。
export * from "./test-ids-workflow.js";
export * from "./channels.js";
export * from "./storage.js";
export * from "./oauth.js";
export * from "./desktopMenu.js";
export * from "./feedback.js";
export * from "./e2e-test-bridge.js";
export * from "./remoteAppConfig.js";
export * from "./helpAppConfig.js";
export * from "./remoteAssetInstallMode.js";
export * from "./onboardingRecord.js";
export * from "./remoteResourcePackages.js";
export * from "./plan-identity.js";
export {
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS,
  BROWSER_VIEW_RESTORE_BOOTSTRAP_URL,
  LOCAL_MEDIA_PREVIEW_SCHEME,
  DesktopCommandIds,
  buildLocalMediaPreviewUrl,
  createOpenInEditorRemoteTarget,
// [契约] platform 的值导出（命令 id、超时、URL 构造）与下方大块类型清单必须成对维护。
// 这里只给值不给类型；缺类型时消费者会改从深路径取，barrel 的收口就此失效。
// [失败路径] 新增平台命令只在源文件加而漏在此处，UI 侧拿不到对应 id，行为静默降级。
// 上面的类型块与本行同源，重复的名字靠显式导出定序，删任一条都不报错但会换来源。
} from "./platform.js";
export type {
  ArmsCustomEventPayload,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
  FinalArmsCustomEventPayload,
  MobilePluginDiscoveryTelemetry,
  RendererTelemetryEventPayload,
  TelemetryEventPayload,
  TelemetryRendererContext,
} from "./telemetry.js";
export {
  PLUGIN_TELEMETRY_EVENTS,
  mobilePluginDiscoveryTelemetrySchema,
  sanitizePluginTelemetryDetail,
  collectTelemetryRendererContext,
  resolveSafeTelemetryHostname,
  sanitizeTelemetryErrorMessage,
  sanitizeTelemetrySkillName,
  sanitizeTelemetryEventDetail,
// [契约] schema、事件常量与采集上下文成组导出，缺任一项都会让上报静默丢字段。
// 这里导出的是收口后的安全入口：`sanitizeTelemetryEventDetail` 等脱敏函数，不是原始上报通道。
// [失败路径] 漏掉 sanitize 系列，调用方会直接透传原始错误信息，含主机名与用户路径。
// [权衡] 新增事件常量必须同时进源模块与这里，多一步维护换来的是入口可见性可控。
} from "./telemetry.js";
export type {
  RedactTelemetryTextOptions,
  TelemetryProviderIdentity,
  TelemetryProviderScope,
} from "./telemetryRedaction.js";
export {
  TELEMETRY_SAFE_BUILTIN_MODEL_IDS,
  TELEMETRY_TEXT_MAX_LENGTH,
  redactTelemetryText,
  redactTelemetryUrl,
  resolveTelemetryModelId,
  resolveTelemetryProviderScope,
  sanitizeTelemetryModelValue,
// [契约] 脱敏常量与函数来自独立模块，与上面 telemetry 的值导出是两件事。
// [权衡] 长度上限与安全模型白名单放在源模块，避免出现第二个可调入口。
// [失败路径] 在本文件内联一份长度上限，会与源模块规则漂移，超长文本从较宽的一侧泄漏。
// 解析 provider 作用域与模型 id 的归一化也只走这里，调用方不要自行裁剪字符串。
} from "./telemetryRedaction.js";
export * from "./remoteUsageTelemetry.js";
export * from "./sessionCreateTelemetry.js";
export type { LaunchMarks } from "./launchMarks.js";
// [契约] 查询键常量与解析、序列化必须同源导出，调用方不得自行拼 URL 参数名。
// 该标记用于跨重启归属判定，格式错误不报错，只会让归因整批丢失。
// [失败路径] 只导出序列化不导出解析，两端实现分叉后旧数据无法被新代码识别。
// 上面的 type 导出与本行成对，新增字段时漏改一边会造成读取端丢字段。
export { LAUNCH_MARKS_QUERY_KEY, parseLaunchMarks, serializeLaunchMarks } from "./launchMarks.js";
export type {
  BrowserViewSurfaceScaleMode,
  CancelPendingRemoteConnectionRequest,
  BindRemoteWorkspaceSessionContextRequest,
  BindRemoteWorkspaceSessionContextIpcResult,
  BindRemoteWorkspaceSessionContextResult,
  BrowserTabResidencyState,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewOperationPayload,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  ChromeBrowserDataImportError,
  ChromeBrowserDataImportOptions,
  ChromeBrowserDataImportResult,
  ConnectRemoteRequest,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  DesktopCloseToTrayCapability,
  DesktopCommandId,
  CuaOsSupport,
  DesktopWindowChromeState,
  DesktopTitleBarTheme,
  DockerContainerInfo,
  EditorInfo,
  ApplicationIconInfo,
  ApplicationIconLocator,
  ApplicationIconRequest,
  BrowserGuestAttachRejectReason,
  BrowserGuestAttachResult,
  EmbeddedBrowserDataClearResult,
  EmbeddedBrowserOpenUrlRequest,
  EmbeddedBrowserPermissionDeviceOption,
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolution,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserPermissionScreenOption,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  IPlatformService,
  OpenInEditorRemoteTarget,
  OpenInEditorOptions,
  PostUpdateReleaseNotesPayload,
  RemoteConnectionRuntimeLog,
  RemoteSessionClosedEvent,
  RemoteSessionReconnectedEvent,
  RemoteServiceSession,
  SSHConfigAliasOption,
  TaskNotificationPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  WSLDistro,
  WindowControlsOverlayReadyPayload,
  ZCodeStdioTapDevState,
// [契约] 这是全文件最大的类型清单，按平台能力分组，新增能力补这里而不是让调用方走深路径。
// 清单顺序沿用源文件可读顺序，不具语义，但不要为排序制造大段 diff。
// [失败路径] 漏加一个类型时本包不报错，下游会各自定义同形状类型，最终出现两份不兼容契约。
// 删除其中任一项都要先查引用：它可能是桌面端与 Web 端共用的唯一类型来源。
} from "./platform.js";
export type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";
export type { ZCodeTaskCreateResult } from "./zcode-task-types.js";
// [契约] 上一行只点名任务创建结果类型，本行 star 才覆盖该模块其余类型。
// 显式与 star 同源同名，删任意一行都能编译，这正是危险之处：删 star 会静默丢掉其余成员。
// [失败路径] 因貌似重复而删除本行，任务创建结果之外的类型在运行期与类型面同时消失。
// [权衡] 保留显式行的意义是让入口文件里能搜到这个高频类型，检索性优先于最小化。
export * from "./zcode-task-types.js";
export * from "./automation-types.js";
export * from "./off-peak-types.js";
export * from "./background-task-control-merge.js";
export * from "./background-task-controls.js";
export * from "./background-task-notifications.js";
export * from "./background-bash-jobs.js";
export * from "./zcode-agent-model-state.js";
export * from "./task-realtime.js";
// [契约] 时间戳与前缀格式化是跨进程日志对齐的唯一实现，只导出这两个函数。
// [权衡] 不额外暴露格式化选项，避免各调用方传不同格式导致日志无法按序合并。
// [失败路径] 各自实现后主进程与渲染进程时间格式不一致，排障时前后文对不上。
// 它属于纯函数，无副作用，可安全地在任何进程与测试中直接调用。
export { formatTimestamp, formatLogPrefix } from "./log-format.js";
export * from "./model-provider-types.js";
export * from "./model-provider-family.js";
export * from "./provider-family-connection-selection.js";
export * from "./provider-provisioning.js";
export * from "./custom-model-value.js";
export * from "./model-selection-types.js";
export * from "./model-selection-key.js";
export * from "./model-selection.js";
export * from "./legacy-model-provider-identity.js";
export * from "./official-glm-model-id.js";
export * from "./skills-types.js";
export * from "./skill-sync.js";
export * from "./mcp-sync.js";
export * from "./plugin-sync.js";
export * from "./remote-sync.js";
export * from "./plugin-types.js";
export * from "./subagents-types.js";
export * from "./settings-source.js";
export * from "./settings-errors.js";
export * from "./app-runtime-preferences.js";
export * from "./command-types.js";
export * from "./plugin-marketplaces.js";
export * from "./lineChangeStat.js";
export * from "./process-names.js";
export * from "./mcp.js";
export * from "./runtime-tool-runtime.js";
export * from "./git.js";
export * from "./bots.js";
export * from "./assistant-message-parts.js";
export * from "./zcodePersistedMessageMerge.js";
export * from "./assistant-presentation.js";
export * from "./tool-call-summary.js";
export * from "./tool-identity.js";
export * from "./streaming-tool-input-preview.js";
export * from "./tool-plan-adapter.js";
export * from "./permission-request-preview.js";
export * from "./web-remote-control.js";
// [契约] 这是全文件唯一使用包内 imports 映射的导出行，解析依赖 package.json 的 imports 段。
// 改成相对路径会与 web-remote-relay 的目录约定脱钩，改动前先确认该子模块的对外入口。
// [失败路径] imports 映射被调整时，本行会让整个 barrel 在加载阶段失败，而非仅丢一个导出。
// [权衡] 用别名是为了避免深层相对路径，代价是本文件对包配置产生了隐式依赖。
export * from "#src/web-remote-relay/index.js";

export * from "./web-remote-control-rpc-transport.js";
export * from "./settings-sync.js";
export * from "./uuid.js";
export * from "./usage-stats.js";
export * from "./coding-plan-subscription.js";
export * from "./forceUpdate.js";
export * from "./intranetProbe.js";
export * from "./intranetDefaults.js";
export * from "./hooks.js";
export * from "./memory.js";
export * from "./output-style.js";
export * from "./openrouter-attribution.js";
export * from "./workspaceSessionRestore.js";
export * from "./skill-scan-policy.js";
// [契约] 子目录入口必须带 index.js，browser-use 的对外面由该子目录自行组织。
// 不要在这里逐条列出浏览器工具，那会把子模块的内部重组变成公共 API 变更。
// [失败路径] 写成 ./browser-use.js 后解析到不存在的文件，类型检查与运行时同时失败。
// 同类写法还有 zcode-protocol 与 source-server，三者必须保持一致。
export * from "./browser-use/index.js";

export * from "./coding-plan-reset.js";
export * from "./highspeed.js";
export {
  parseSubagentMarkdownSelection,
  formatSubagentMarkdownModel,
} from "./subagent-markdown-selection.js";
export * from "./memoryDiagnostics.js";
export * from "./database-startup.js";
export * from "./processResourceTelemetry.js";
export * from "./execution-state.js";

export { bashOutputDisplaySchema } from "./bash-output-display.js";

export * from "./subagent-runtime-config.js";

export * from "./subagent-profile.js";
export { parseAgentProfileFromMarkdown } from "./subagent-profile-parser.js";

export * from "./localTtft.js";
export * from "./pluginStoreOrder.js";
export * from "./clientConfig.js";
export * from "./pluginStoreOrdering.js";
export * from "./marketingTouch.js";
export * from "./rewardsEmbedded.js";
export * from "./rewardsBridge.js";
export * from "./session-debug.js";
// [契约] 该函数来自 feedbackPrivacy，与上方 feedback 的 star 面不是同一模块，看似重复实为不同来源。
// 它是反馈文本出站前的最后一道脱敏，任何反馈上报路径都必须经过它。
// [失败路径] 误判为重复而删除，反馈内容会带着日志片段与本地路径原样上报。
// [权衡] 单独点名而非整块 star，是为了避免把反馈隐私模块的其余内部工具一并暴露。
export { redactFeedbackText } from "./feedbackPrivacy.js";
export { API_KEY_USAGE_SCENE, type ApiKeyCreationUsageScene } from "./api-key-usage-scene.js";
export {
  projectAccessTokenFingerprint,
  ProjectAccessTokenTransientError,
} from "./project-access-token.js";
export {
  ProjectAccessTokenClient,
  type ProjectAccessTokenInput,
  type ProjectAccessTokenMaterial,
// [契约] `ProjectAccessTokenInput` 与 `ProjectAccessTokenMaterial` 随客户端成组导出，构造契约随本行公开。
// 令牌的瞬态错误类型单独在上一块导出，不要合并，否则调用方无法区分数值错误与可重试错误。
// [失败路径] 漏导出输入类型会让调用方用结构相同的本地类型顶替，字段演进时静默错位。
// 该客户端涉及敏感凭据，导出面只保留必要成员，不要顺手把内部字段也列进来。
} from "./project-access-token-client.js";

export * from "./conversationSelection.js";
export * from "./attachment-source.js";

export * from "./channel-mention.js";

export {
  requestSecuritySensitiveHeaders,
  isRequestSecurityFailure,
} from "./request-security-edition/policy.js";
export * from "./request-security-edition/verification-policy.js";

// [契约] 文件末尾的追加位：新增导出优先加在这里，减少与既有分组的冲突。
// 追加后仍要遵守类型与值分家、.js 后缀这两条硬规则，末尾不代表可以放松。
// [失败路径] 顺手删掉末尾空行或合并相邻 star，会破坏零删除约束并让变更意图失真。
// 提交前用单文件密度与 diff 复核：本文件只应有新增的整行注释，没有其他改动。
export * from "./conversation-share-tool-presentation.js";
