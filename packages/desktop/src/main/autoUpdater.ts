/* eslint-disable max-lines -- autoUpdater 需要集中维护 Electron 事件、菜单状态与 IPC 交互，过度拆分会让更新状态流更难追踪 */
// ============================================================================
// autoUpdater —— Desktop 主进程自动更新的唯一状态所有者（L1 深度注释）
// 分层：electron-updater 原生事件 -> 归一状态 menuState -> 菜单/窗口/IPC 派生输出。
// renderer 侧状态只是投影，不回传；renderer 只回传"用户意图"（下载/取消/跳过/安装）。
// 事件可能重复、乱序、迟到，因此每个写状态入口都必须先做世代/通道/状态校验。
// 下方 INV 表逐条给出跨函数不变量，正文以 INV-k 引用；标记见 [并发]/[资源]/[失败路径]/[权衡]。
//
// INV-1: menuState 只能经 setAutoUpdaterMenuState 写入，且去重、菜单同步、广播、轮询复位
//        必须在同一同步块内完成 —— 破坏后果：菜单显示"可更新"而弹窗仍为 idle，用户点击无响应。
// INV-2: 一次 check 的互斥范围是"请求 + 结果处理"，由 activeAutoUpdateCheckId 与
//        settlingAutoUpdateCheckId 双记账 —— 破坏后果：通道刷新抢在旧结果写状态前启动，旧版本写入新通道。
// INV-3: check 收口必须经 completeAutoUpdateCheck 并按 checkId 校验世代 —— 破坏后果：迟到旧检查清掉
//        新一轮的 in-flight 标记，同一时刻出现两个 check。
// INV-4: readyUpdateVersion 只在 publishDownloadedUpdate 中由"真正的下载完成"写入 —— 破坏后果：
//        publishDownloadedUpdate 若在下载未完成时写 readyUpdateVersion，安装器会读到半包。
// INV-5: pendingDownloadedUpdate 与 downloadCancellationToken 同生共死 —— 破坏后果：取消后的迟到
//        ready 被发布，用户已跳过该版本却被拉回"下载完成"。
// INV-6: quitAndInstallState 单向 idle→preparing→installing→recovering，recovering 为终态 ——
//        破坏后果：recovering 回退到 idle 时 Host/Agent 已关闭而窗口还在，所以用户操作全部失败。
// INV-7: 安装准入必须用 isReadyUpdateCurrentTarget 校验"ready 版本 == 当前目标" —— 破坏后果：
//        远端已推进到更高版本时仍 quitAndInstall 旧包，用户升级后版本倒退。
// INV-8: quitAndInstallState 为 recovering 时所有失败回调必须短路 —— 破坏后果：原生错误重复
//        触发 app.relaunch，形成重启循环，用户永远进不了主界面。
// INV-9: 下载失败不等于用户跳过：必须回退到 update-available 并保留 releaseNotes/channel ——
//        破坏后果：弱网一次失败后入口消失，用户再也看不到该版本，只能手动升级。
// INV-10: 取消下载必须同时 markCancelledDownload 与 token.cancel()，并吞掉随后的 cancelled 错误 ——
//         破坏后果：取消被当作真实失败，状态被打回 idle 并触发一次无意义的重查。
// INV-11: pendingCancelledDownloadErrorCount 是"待吞掉的取消错误"配额，只能被同语义错误消耗 ——
//         破坏后果：真实下载失败被误吞，UI 永久停在下载态且没有任何错误提示。
// INV-12: available/downloading/ready 三组字段任一时刻最多一组有效 —— 破坏后果：状态回退时
//         状态回退会把 available/downloading/ready 组的版本或渠道混读，显示错版本、向错通道发请求。
// INV-13: 渠道刷新在 check in-flight 时只能登记 pendingManifestReleaseChannelRefresh ——
//         破坏后果：旧请求返回时把 preview 结果标成 stable，或直接丢弃新通道结果。
// INV-14: stale 判定只比较本次 check 启动时锁定的 expected channel —— 破坏后果：用户切通道后
//         旧 manifest 结果覆盖新结果，弹窗长期显示旧版本与旧 release notes。
// INV-15: manualCheckWebContentsId 是单槽且发送即清空 —— 破坏后果：同一结果被重复投递，
//         或目标窗口销毁后 send 抛错打断后续状态收敛。
// INV-16: pendingPostUpdateReleaseNotes 的持久化与 ack 以 version 为幂等键 —— 破坏后果：
//         若不以 version 为幂等键，重启后 pendingPostUpdateReleaseNotes 会重复弹旧说明，或被下一次下载写回。
// INV-17: 版本比较只用 semver 归一结果；无法解析时退化为字符串不等比较 —— 破坏后果：
//         解析失败被当成"有更新"，对同一版本反复下载与反复弹窗。
// INV-18: 轮询定时器同一时刻只允许一个且必须 unref —— 破坏后果：状态切换时定时器叠加，
//         应用退出时被活动句柄拖住，进程无法结束。
// INV-19: 安装路径必须先 await onBeforeQuitAndInstall 再调用 quitAndInstall —— 破坏后果：
//         Windows 下 resources/glm 仍被占用，安装器覆盖失败，留下"agent 丢失"的半更新。
// INV-20: 启动检查、失败重查、轮询共用 triggerCheckForUpdates 的同一道互斥闸，所以不能各自开闸 —— 破坏后果：
//         三路并发 check，旧结果与新结果互相覆盖，状态机抖动。
//
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import type { ISettingService } from "@zcode/services";
import pkg, { CancellationToken } from "electron-updater";
import semver from "semver";
// 解构默认导出拿实例：electron-updater 以 CJS 打包时 pkg 默认导出是模块对象，
// 直接具名导入在 ESM 互操作下拿不到实例。
const { autoUpdater } = pkg;
import {
  DEFAULT_LOCALE,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  PlatformChannels,
  ZCODE_VERSION,
  desktopMenuMessageIds,
  formatDesktopMenuMessage,
  getDesktopMenuMessage,
  resolveRuntimeZCodeEndpointOrigin,
  type ElectronReleaseChannel,
  type Locale,
  type PostUpdateReleaseNotesPayload,
  type UpdateCheckResultPayload,
  type UpdateStatePayload,
} from "@zcode/shared";
import { logger } from "./logger.js";
import { ManifestUpdateProvider, getElectronReleasePlatform } from "./manifestUpdateProvider.js";

// 菜单项 id 是"菜单重建"与"状态同步"之间唯一的锚点；改名会让 getMenuItemById 静默返回
// undefined，此后更新状态不再反映到菜单，且没有任何报错可以定位。
export const CHECK_FOR_UPDATE_MENU_ID = "check-for-update";
// 两个间隔的差异是"用户是否正看着一个可操作目标"：可见时用 AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS（2 分钟）让新版本尽快出现；
// 无目标时用 AUTO_UPDATE_POLL_INTERVAL_MS（15 分钟），避免后台无意义地打 manifest 服务。
// 环境变量/命令行开关只用于本地验证与灰度，由 isTruthyRuntimeFlag 与 readCommandLineSwitchValue 解析：
// 非法值回落到默认关闭，否则会在启动即抛错中断。
const AUTO_UPDATE_POLL_INTERVAL_MS = 15 * 60 * 1000;
// 可见态间隔 AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS 取 2 分钟：有可操作目标时应尽快出现新版本，与 15 分钟档的差值就是"是否有人看"。
const AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS = 2 * 60 * 1000;
// 环境变量名 UPDATE_FEED_URL_ENV 是对外契约：运维与灰度脚本按这个字符串注入，改名等于静默关闭所有自定义更新源。
const UPDATE_FEED_URL_ENV = "ZCODE_UPDATE_FEED_URL";
// 命令行开关与 env 成对存在：本地调试用开关（优先级更高），部署用 env，两者必须指向同一配置语义。
const UPDATE_FEED_URL_SWITCH = "--zcode-update-feed-url";
// 开发态开关默认关闭：未打包运行时若默认开启，普通开发者一启动就会去拉真实 manifest。
const DEV_AUTO_UPDATE_ENV = "ZCODE_AUTO_UPDATE_DEV";
// 命令行形态与 env 同义：它让"这一次启动"临时开启，无需改环境或配置文件。
const DEV_AUTO_UPDATE_SWITCH = "--zcode-auto-update-dev";
// 伪造版本只用于验证"有新版本"这条链路：没有它就无法在本地复现升级弹窗。
const DEV_AUTO_UPDATE_VERSION_ENV = "ZCODE_AUTO_UPDATE_DEV_VERSION";
// 与上方 env 同义；值必须能被 semver 解析，否则会被 resolveDevAutoUpdateVersion 丢弃并记 warn。
const DEV_AUTO_UPDATE_VERSION_SWITCH = "--zcode-auto-update-dev-version";
// ready 三件套必须整体生效：版本决定"装哪个"，releaseNotes 决定"装完弹什么"，
// restored 标记决定"要不要重新走 downloadUpdate 建立真实安装上下文"。
// 任何一处单独清空都会让另外两处指向不存在的包，因此统一由 clearReadyUpdateState 收口。
let readyUpdateVersion: string | null = null;
// 说明与 version 分开存：它可能来自本次下载，也可能是从 setting 恢复的载荷，来源不同但生命周期必须同步（INV-4/INV-16）。
let readyUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
// 这个布尔量区分"真实下载的 ready"与"磁盘恢复的伪 ready"：安装入口靠它决定是否先重建安装上下文（INV-4/INV-7）。
let readyUpdateRestoredFromPendingReleaseNotes = false;
// menuLocale 与 manualCheckWebContentsId 都是"最后一次交互的上下文"：前者决定菜单文案，
// manualCheckWebContentsId 决定手动检查结果投递给谁。二者都不持久化，重启后由窗口重建流程重新写入。
let menuLocale: Locale = DEFAULT_LOCALE;
// 单槽投递目标：并发的手动检查会被后来者覆盖，这是有意的——结果只应回到最后一次发起检查的窗口（INV-15）。
let manualCheckWebContentsId: number | null = null;
// 内存里的待展示说明是磁盘 pending 的投影：写盘成功后才更新它，保证内存不领先于持久化事实（INV-16）。
let pendingPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
// 记录说明投给过哪个窗口：同一版本只投一次，避免多窗口重复弹窗与重复 ack（INV-16）。
let deliveredPostUpdateReleaseNotesWebContentsId: number | null = null;
// 轮询与 check 世代是两套记账：轮询只关心"下一次何时查"，世代关心"这次结果还算不算数"。
// 混用会导致状态切换时误清对方的标记，因此这里刻意保持两组独立变量。
let autoUpdatePollTimer: NodeJS.Timeout | null = null;
// 记录当前定时器使用的间隔：只有它能判断"状态切换后是否需要换档"，否则每次都得清掉重建（INV-18）。
let autoUpdatePollIntervalMs: number | null = null;
// 这是 triggerCheckForUpdates 的互斥闸：三路触发共用同一道闸，任何绕过它直接调 checkForUpdates 都会破坏 INV-20。
let checkForUpdatesInFlight = false;
// 世代号单调递增、只增不减：它不表示"当前检查"，而是"到目前发起过多少次"，与 checkId 配对判迟到（INV-3）。
let autoUpdateCheckGeneration = 0;
// 当前有效检查的 id：只有它与回调手里的 checkId 相等时，结果才允许写状态（INV-3）。
let activeAutoUpdateCheckId: number | null = null;
// expected channel 是 stale 判定的唯一依据：必须在发起请求时锁定，不能事后从设置重读（INV-14）。
let activeAutoUpdateCheckChannel: ElectronReleaseChannel | null = null;
// 收口中与活跃检查分开记账：结果已到但尚未收口时，新请求仍应排队而不是被当成"没有检查"（INV-2）。
let settlingAutoUpdateCheckId: number | null = null;
// 以下三组字段描述同一条更新在不同阶段的事实：available（远端刚发现）、
// downloading（正在拉包）、ready（包已落地）。它们由不同事件推进，不能互相兜底读取，
// 否则状态回退时会拿到上一阶段残留的渠道或说明。
let availableUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
// 默认 stable 而不是 null：渠道参与状态构造与重试，空值会让 buildUpdateAvailableState 少一个必填字段（INV-12）。
let availableUpdateChannel: ElectronReleaseChannel = "stable";
// 下载版本在发起下载时锁定：后续用户切渠道不影响它，下载完成时按它发布 ready（INV-12）。
let downloadingUpdateVersion: string | null = null;
// 下载态说明单独存：available 可能在下载期间被清理或改写，这里必须留住发起下载时的那一份。
let downloadingUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
// 渠道同样在发起下载时锁定：publishDownloadedUpdate 优先读它，缺失才回落 available（INV-12）。
let downloadingUpdateChannel: ElectronReleaseChannel | null = null;
// 非空即"有一次下载在进行"：它比 menuState 更可靠，因为状态可能被失败路径提前打回 available（INV-5）。
let downloadCancellationToken: CancellationToken | null = null;
// ready 渠道决定安装后回查更新打哪个 manifest：必须在发布 ready 时一并写入，而不是从设置重读。
let readyUpdateChannel: ElectronReleaseChannel | null = null;
// 待刷新渠道是"check 期间用户切了开关"的暂存：它只能被 check 收口消费一次，重复登记等于丢掉中间那次（INV-13）。
let pendingManifestReleaseChannelRefresh: ElectronReleaseChannel | null = null;
// onBeforeQuitAndInstall 由 Main 注入，负责关闭 Host/Agent 并释放随包资源；
// 它必须可重复调用（失败恢复分支会再次进入），幂等性由装配方保证。
// acknowledgedPostUpdateReleaseNotesVersions 只在进程内生效，防止同一版本在一次运行中
// 被重复持久化；跨进程幂等由 setting 中的 pending 字段承担。
// cancelledDownloadTokens 用 WeakSet 避免为每次下载保留强引用，token 被 GC 后自然消失。
let onBeforeQuitAndInstall: (() => void | Promise<void>) | undefined;
// 进程内 ack 集合：防止同一次运行里把已确认的说明重新写回磁盘；跨进程幂等由 setting 的 pending 字段承担（INV-16）。
const acknowledgedPostUpdateReleaseNotesVersions = new Set<string>();
// WeakSet 存 token 身份而非版本号：取消是"这一次下载"的事实，用版本号记录会误伤同版本的下一次下载（INV-10）。
const cancelledDownloadTokens = new WeakSet<CancellationToken>();
// 配额只增不减地等待对应错误消耗：多减会把真实失败当取消吞掉，少减会让取消错误被误报为失败（INV-11）。
let pendingCancelledDownloadErrorCount = 0;
// settingService 在 initAutoUpdater 时注入；未注入意味着宿主尚未完成装配，
// 此时所有"读偏好/写跳过版本/写待展示说明"的路径都必须按"无配置"降级，而不是抛错。
let autoUpdaterSettingService: SettingServiceLike | undefined;
// initAutoUpdater({ enabled: false }) 只清轮询并 return，electron-updater 实例保持未配置
// （占位 feed、autoDownload 默认值）。任何漏改成按身份判断的入口若仍调用手动检查，
// 都会对占位 feed 发真实请求。这里记住“本 flavor 已禁用”，让手动检查在模块内部 fail-closed。
let autoUpdaterDisabledForProductFlavor = false;

// 这里刻意用 Pick 而不是完整 ISettingService：本文件只需要读写其中两个方法，
// 收窄依赖面可以避免测试替身实现整套设置服务，也让误用（写入无关字段）在编译期失败。
type SettingServiceLike = Pick<ISettingService, "get" | "update">;

// 只声明实际用到的两个字段：注记项还有 type 等字段，收窄后调用方不必为无用字段造类型。
type ReleaseNoteInfoLike = {
  // note 可空：注记数组里可能夹带只有 version 没有正文的项，归一化时必须能跳过它们。
  note?: string | null;
  // version 保留但当前未直接使用：它与 note 成对出现，声明为可空以匹配运行时数据。
  version?: string | null;
};

// electron-updater 的 info 是运行时数据（可能来自远端 manifest 或本地缓存），
// 因此所有字段都按"可能缺失/类型漂移"声明，并在使用前经 normalize* 收敛；
// 直接信任其类型会在旧版本缓存或自建 feed 上抛 TypeError。
type UpdateDownloadedInfoLike = {
  // 唯一必填字段 version：没有版本的 ready 既不能发布也不能安装，还会破坏幂等键（INV-4/INV-16）。
  version: string;
  // 本地包路径：用于安装上下文，但不应进持久化载荷（见 toPostUpdateReleaseNotesPayload 的字段裁剪）。
  path?: string | null;
  // 下载文件清单可能含 null 项：声明保留空位，归一化时不做强假设。
  files?: Array<{ url?: string | null } | null> | null;
  // 按平台分包的路径表：旧缓存或自建 feed 可能缺失，因此整体可空。
  packages?: Record<string, { path?: string | null } | null> | null;
  // 自定义渠道字段由我们自己的 manifest 提供：标准 electron-updater 不会填，因此可空。
  zcodeReleaseChannel?: ElectronReleaseChannel | null;
  // 发布名是说明标题的优先来源：为空时退回正文首标题（见 toPostUpdateReleaseNotesPayload）。
  releaseName?: string | null;
  // 上游有两种正文形态（字符串/注记数组）：保留联合类型，归一化交给 normalizeReleaseNotesMarkdown。
  releaseNotes?: string | ReleaseNoteInfoLike[] | null;
  // 日期可能是 Date（运行时对象）或字符串（缓存里 JSON 化过）：两种形态都要接受，见 normalizeReleaseDate。
  releaseDate?: string | Date | null;
  // 按语言分包说明 releaseNotesByLocale 是可选的：自建 manifest 会提供，标准 feed 不提供，缺失时必须回落到主说明兜底。
  releaseNotesByLocale?: Partial<
    // 键类型用 Locale 而不是 string：让白名单之外的语言在编译期就无法被写入载荷。
    Record<
      // 值的形态是"字符串或对象或 null"：对象带标题与正文，字符串只有正文（见 normalizeLocalizedReleaseNotes）。
      Locale,
      | string
      // 对象形态的三个字段全部可空：远端可能只给标题或只给正文，归一化必须能处理半份数据。
      | {
          // 显式标题优先于从正文推导：两者都存在时应以远端标题为准，避免弹窗标题与发布名不一致。
          title?: string | null;
          // markdown 是首选正文键：与 releaseNotes 同时存在时优先它（见 normalizeLocalizedReleaseNotes 的取值顺序）。
          markdown?: string | null;
          // 兼容旧格式：某些 feed 在 locale 层仍用 releaseNotes 命名，保留它避免老数据被整体丢弃。
          releaseNotes?: string | ReleaseNoteInfoLike[] | null;
        }
      // 单语言条目允许为 null：表示"该语言本次没有说明"，归一化时直接跳过而不是报错。
      | null
    // 外层 Partial 的收口：允许只提供部分语言，缺失语言不构成类型错误。
    >
  // 整个 locale 字段可空：标准 feed 完全不提供时，归一化函数要靠这个 null 走兜底路径。
  > | null;
};

// 用对象而不是裸字符串包装：未来新增字段（签名、通道）时不必改所有调用方的签名。
type RuntimeUpdateFeedSource = { url: string };

// 类型别名 AutoUpdaterMenuState 而不是直接使用 UpdateStatePayload：本文件内部用它表达"菜单可消费的状态"，将来结构扩展时改动集中在这一行。
type AutoUpdaterMenuState = UpdateStatePayload;
// 初始态必须是 idle+enabled：initAutoUpdater 之前菜单可能已创建并读取该状态，
// 若初始为 checking，用户会看到一个永远不会结束的"正在检查"。
let menuState: AutoUpdaterMenuState = { kind: "idle", enabled: true };

// ForceAutoUpdateState 是强更弹窗的投影协议，比 menuState 更粗：只表达用户可见的
// 五个阶段，并允许 dev-skipped 这种"未真正执行"的终态，所以弹窗不会停在 checking。
export type ForceAutoUpdateState =
  | { kind: "checking" }
  // 下载中的 version/progress 都可选：强更可能在下载事件到达前就先展示阶段，缺字段时显示不确定态而不是空白。
  | { kind: "downloading"; version?: string; progress?: string }
  // ready 的 version 可选：恢复自磁盘的伪 ready 可能没有版本，弹窗仍需展示"可安装"这一事实。
  | { kind: "ready"; version?: string }
  // installing 无载荷：它是终态转移信号，附加字段只会诱导渲染层做无意义的分支。
  | { kind: "installing" }
  // 错误必须带 message：强更弹窗没有日志通道，message 是用户唯一能看到的失败原因。
  | { kind: "error"; message: string }
  // dev-skipped 是"未真正执行"的终态：它让开发态弹窗能正常关闭，而不是停在 checking 等待一个不会到来的安装。
  | { kind: "dev-skipped"; message?: string };

// activeForceAutoUpdateListener 是单槽：同一时刻只允许一个弹窗驱动更新流程；后来的请求复用进行中的
// 检查（见 requestForceAutoUpdate），否则两个弹窗会各自触发一次下载。
let activeForceAutoUpdateListener: ((state: ForceAutoUpdateState) => void) | null = null;
// 订阅集合用 Set：同一监听器重复注册只保留一份，退订按引用删除即可幂等。
const autoUpdaterStateListeners = new Set<(state: UpdateStatePayload) => void>();
// forceAutoUpdateLastLoggedProgressBucket 记录上一次已记日志的进度档位：进度事件很密，按档位去重才能既留下轨迹又不刷爆日志。
let forceAutoUpdateLastLoggedProgressBucket: number | null = null;

// enabled=false 表示"本产品形态不提供自动更新"，与"当前是开发态"是两回事：
// 前者是产品决策（必须 fail-closed），后者只是运行时限制（可通过开关打开）。
interface InitAutoUpdaterOptions {
  // 省略时按"启用"处理：只有显式传 false 才表示本产品形态不提供更新（见下方注释）。
  enabled?: boolean;
  // 允许返回 Promise：Windows 上关闭 Host/Agent 需要等待子进程退出，同步签名无法表达这段等待（INV-19）。
  onBeforeQuitAndInstall?: () => void | Promise<void>;
  // settingService 可选注入：测试与纯菜单场景可以不接设置服务，此时所有偏好读取按"无配置"降级。
  settingService?: SettingServiceLike;
  // 初始语言可选：未传时用 DEFAULT_LOCALE，窗口就绪后还会由 setAutoUpdaterMenuLocale 覆盖。
  locale?: Locale;
  // 自定义更新源只在本地验证与灰度时注入：生产走内置 manifest，因此必须可选。
  updateFeedSource?: RuntimeUpdateFeedSource;
  // 设备标识可选：缺失时 manifest 请求按匿名处理，不应阻断更新检查。
  deviceMid?: string;
  // 允许异步：端点可能来自需要异步解析的配置源，返回 Promise 让 provider 侧统一 await。
  resolveEndpointOrigin?: () => string | Promise<string>;
}

// quitAndInstallState 是安装链路的单向闸：一旦离开 idle，所有新的检查/下载/渠道刷新
// 都必须被拒绝，因为退出准备可能已经关闭了 Host 与 Agent，再做这些只会产生噪声错误。
// pendingDownloadedUpdate 暂存"事件已到但 downloadUpdate Promise 未收口"的结果，
// 只有 Promise 成功且 token 未取消时才允许发布，避免半包被当成可安装。
let quitAndInstallState: "idle" | "preparing" | "installing" | "recovering" = "idle";
// 槽里带 token 而不只是 info：发布时必须校验"这份 info 是否属于本次下载"，
// 缺 token 就只能按版本猜，迟到事件会污染新一轮（INV-5）。
let pendingDownloadedUpdate: { token: CancellationToken; info: UpdateDownloadedInfoLike } | null =
  null;

// 所有"用户意图"入口的第一道闸。这里不区分安装中还是恢复中：
// 两者都意味着进程即将退出，再接受新请求只会让 renderer 拿到无法兑现的 ACK。
function isUpdateTargetLocked(): boolean {
  // 用"不等于 idle"而不是枚举 installing/recovering：preparing 阶段 Host 已开始关闭，
  // 同样不能再接受新请求，漏掉它会让用户在最危险的窗口里触发下载。
  return quitAndInstallState !== "idle";
}

// [失败路径] 走到这里说明退出准备已经执行过（Host/Agent 已关），安装器却没能接管。
// 此时唯一自洽的状态是"重启恢复"，而不是清标记留在半关闭的窗口里；
// recovering 作为终态让并发到达的失败回调全部短路，避免重复 relaunch。
function recoverFromFailedUpdateInstall(): void {
  // 幂等短路：多个错误回调可能同时到达，先到者已 relaunch，后来者必须直接返回，
  // 否则每次错误都排一次重启（INV-8）。
  if (quitAndInstallState === "recovering") return;
  // 退出准备已不可逆地关闭 Host/Agent 和远控服务；安装失败不能只清标记留在失效窗口。
  // 恢复保持终态直到退出，重复原生错误不得重复安排重启。
  quitAndInstallState = "recovering";
  // 用 warn 而非 error：这不是可处理的失败，而是"必须重启"的既定降级，error 会触发无意义告警升级。
  logger.warn("[auto-update] install failed after shutdown started: relaunch app");
  // 只登记下一次启动，不结束当前进程：真正的退出由下一行完成，两行必须成对出现。
  app.relaunch();
  // exit 而不是 quit：quit 会走窗口关闭与 before-quit 钩子，而那些钩子依赖已被关闭的 Host/Agent，
  // 可能再次抛错并卡住退出（INV-6）。
  app.exit(0);
}
// 开发态覆盖只影响版本比较与 electron-updater 的 currentVersion，不污染产品版本号；
// recheckAfterDownload 是"下载结束后再查一次"的间接层，避免下载链路直接依赖检查函数；
// pendingFailedDownloadRecheck 记录"失败重查被进行中的检查挡下"，等收口后再补一次。
let devAutoUpdateVersionOverride: string | null = null;
// 以函数指针注入而不是直接调用 triggerCheckForUpdates：下载链路不应反向依赖检查模块，
// 也让"下载结束后复查"在未初始化时为空转（INV-20 的去重来源）。
let recheckAfterDownload: ((reason: string) => void) | null = null;
// 标记"失败重查被进行中的检查挡下"：不做这个标记，弱网恢复后那次重查会被直接丢弃。
let pendingFailedDownloadRecheck = false;

// 交叉类型而非 any：只放开需要改写的两个字段，其余成员仍受原类型约束，误写字段名会在编译期报错。
type MutableAutoUpdaterForDev = typeof autoUpdater & {
  // 声明为可选：该字段在部分 electron-updater 版本里是只读或不存在，赋值前必须判存在。
  currentVersion?: semver.SemVer;
  // 与 currentVersion 一起构成 dev 覆盖的最小面：只改这两个字段，避免依赖更多内部实现。
  forceDevUpdateConfig?: boolean;
};

// 运行时开关的取值口径固定为 1/true/yes（大小写与空白不敏感）：环境变量可能由脚本、
// CI 或用户手写注入，isTruthyRuntimeFlag 宽松解析比严格枚举更不容易出现"看起来打开了实际没打开"。
function isTruthyRuntimeFlag(value: string | undefined): boolean {
  // 先判空再归一：value 可能是 undefined（env 未设置），直接调 trim 会在启动期抛错。
  const normalized = value?.trim().toLowerCase();
  // 白名单而非 Truthy 判断：字符串 "false" 在 JS 里是真值，宽松判断会把显式关闭当成开启。
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

// 命令行开关支持 `--name=value` 与 `--name` 两种形态：后者返回空串表示"存在但无值"，
// 与"不存在"（null）区分开，调用方据此决定是否启用而非误判为关闭。
function readCommandLineSwitchValue(name: string): string | null {
  // 前缀只拼一次：循环里 `--name` 与 `--name=value` 共用同一次字符串构造，避免每轮重复拼接。
  const prefix = `${name}=`;
  // 直读 process.argv 而不接受注入：本函数只在启动期解析一次，调用方无法提供替代来源。
  for (const arg of process.argv) {
    // 精确相等优先：`--name` 单独出现表示"开关存在但无值"，与"不存在"必须区分开（见函数头注释）。
    if (arg === name) {
      // 空串是本函数对"存在但无值"的表示：调用方用 !== null 判存在性，用真值判断是否带值。
      return "";
    }
    // 带等号形态放在后面判：先判精确相等能避免 `--name=` 这类空值被误当成裸开关。
    if (arg.startsWith(prefix)) {
      // 直接切出等号之后的部分，不 trim：调用方会自行 trim，这里保持原始值便于排查参数里的意外空格。
      return arg.slice(prefix.length);
    }
  }
  // null 明确表示"整个 argv 里没有这个开关"：与空串的语义差是调用方判断是否启用的唯一依据。
  return null;
}

// 开发态自动更新需要显式双重 opt-in（环境变量或命令行开关），因为未打包应用一旦
// 向生产 feed 发请求，会把开发环境误注册进发布统计，也可能真的下载安装包。
function isDevAutoUpdateEnabled(): boolean {
  // isDevAutoUpdateEnabled 的两个来源是或关系：环境变量便于 CI，命令行便于单次启动，两者任一成立就必须开启。
  return (
    isTruthyRuntimeFlag(process.env[DEV_AUTO_UPDATE_ENV]) ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_SWITCH) !== null
  );
}

// "能不能用 updater"与"能不能装"是两个判据：打包态可用但安装要等退出；
// 开发态仅在显式开启时可用，且安装降级为重启（见 shouldRelaunchForDevAutoUpdateInstall）。
// 把两者合并会让 dev 验证流程要么完全不可用，要么误走真实安装器。
function canUseAutoUpdaterInCurrentRuntime(): boolean {
  // 打包态无条件可用；未打包只在显式 opt-in 时可用，这是防止开发机误连生产 feed 的边界（见上方注释）。
  return app.isPackaged || isDevAutoUpdateEnabled();
}

// [权衡] dev 下没有真实安装包可接管，安装动作降级为"重启以加载新代码"：
// 它与打包态的 quitAndInstall 是两条路径，因此单独判定而不是复用 canUseAutoUpdaterInCurrentRuntime。
function shouldRelaunchForDevAutoUpdateInstall(): boolean {
  // 两个条件同时成立才是 dev 安装：打包态即使开了 dev 开关也必须走原生安装器。
  return !app.isPackaged && isDevAutoUpdateEnabled();
}

// 更新比较必须以"产品版本"为基准，而不是 Electron 运行壳版本：
// dev 下 app.getVersion() 返回的是壳版本，直接比较会把每次检查都判成有更新。
function getCurrentAppVersionForUpdate(): string {
  // 覆盖值优先：dev 下 app.getVersion() 是运行壳版本，直接比较会把每次检查都判成有更新（见上方注释）。
  return devAutoUpdateVersionOverride ?? app.getVersion();
}

// 解析失败必须返回 null，而不是猜一个值：一旦版本号非法，electron-updater 的
// SemVer 比较会抛错，整条检查链路都不可用。
// 优先级为 环境变量 > 命令行 > 编译期常量，后者保证不开任何覆盖时仍能复现真实版本。
function resolveDevAutoUpdateVersion(): string | null {
  // 三级回退顺序固定在源码里：env > 命令行 > 编译期常量，改顺序会让本地验证读到意料之外的版本。
  const configuredVersion =
    process.env[DEV_AUTO_UPDATE_VERSION_ENV]?.trim() ||
    readCommandLineSwitchValue(DEV_AUTO_UPDATE_VERSION_SWITCH)?.trim() ||
    ZCODE_VERSION;
  // 用 parse 而非 coerce：这里是"配置值必须严格合法"的场景，宽松归一会把拼错的版本悄悄修正。
  const parsed = semver.parse(configuredVersion);
  // 解析失败不猜值：非法版本会传进 electron-updater 的 SemVer 比较并抛错，整条检查链路都不可用（见函数头注释）。
  if (!parsed) {
    // 日志带上 configuredVersion 原值：用户需要知道具体是哪个字符串写错了，而不是只被告知"忽略"。
    logger.warn(`[auto-update] ignore invalid dev update version=${configuredVersion}`);
    // null 让调用方回落到默认版本：与"解析成功但值相同"区分开，后者仍会写覆盖。
    return null;
  }
  // 归一成标准格式：`v3.3.2` 与 `3.3.2` 必须得到同一字符串，否则覆盖值与 app 版本比较会不等。
  return parsed.format();
}

// [权衡] 这里直接改写 electron-updater 的私有 currentVersion 字段，而不是伪造一个
// 假 feed：只有让 updater 认为当前版本是产品版本，"3.3.1 -> 3.3.2" 这类真实升级
// 才能在 dev 下被判定为可用；代价是依赖其内部字段名，升级依赖时需要回归此路径。
function applyDevAutoUpdateRuntimeOverrides(): void {
  // 先清空再判是否启用：本函数可能在多次初始化中被调用，残留覆盖值会让打包态读到上一轮的假版本。
  devAutoUpdateVersionOverride = null;
  // 打包态直接跳过：生产环境绝不能改写 currentVersion，否则真实版本比较会失真。
  if (app.isPackaged || !isDevAutoUpdateEnabled()) {
    // 返回前不记日志：这是绝大多数用户的正常路径，记日志只会淹没真正的 dev 覆盖记录。
    return;
  }

  // 解析失败返回 null 是合法结果：下面的三元会把 null 保留，只跳过 currentVersion 覆盖。
  const devVersion = resolveDevAutoUpdateVersion();
  // resolve 已保证格式合法，这里再 parse 是为了拿到 SemVer 对象：currentVersion 只接受对象而非字符串。
  const parsedVersion = devVersion ? semver.parse(devVersion) : null;
  // 断言集中在一处：所有对私有字段的改写都经由这个别名，依赖升级时只需回归这里（见上方 [权衡]）。
  const mutableAutoUpdater = autoUpdater as MutableAutoUpdaterForDev;
  // 必须先于任何 check 设置：electron-updater 在构造检查器时读取该标志，晚设置等于没设置。
  mutableAutoUpdater.forceDevUpdateConfig = true;
  // 只有拿到合法版本才写 currentVersion：写 null 会让 updater 在比较时抛错。
  if (parsedVersion) {
    // 同步写入本模块的覆盖值：getCurrentAppVersionForUpdate 与日志都读它，两处必须一致。
    devAutoUpdateVersionOverride = parsedVersion.format();
    // Electron 开发态 app.getVersion() 读取的是 desktop 运行壳版本，
    // 不一定跟产品版本一致。验证自动更新时需要显式把 electron-updater 的
    // currentVersion 改成产品版本，否则 3.3.1 -> 3.3.2 这类流程无法复现。
    mutableAutoUpdater.currentVersion = parsedVersion;
  }

  // 覆盖生效后记一次日志：这是"本地为什么看到 3.3.2 的更新"的唯一解释来源。
  logger.info(
    `[auto-update] dev update enabled version=${devAutoUpdateVersionOverride ?? app.getVersion()}`,
  );
}

// 统一用 semver.coerce 而非 valid：远端版本可能带前缀（v3.3.2）或后缀，coerce 能
// 取出可比较的部分；解析失败返回 null，由调用方决定退化策略。
function normalizeVersionForCompare(version: string): string | null {
  // 先 trim 再 coerce：首尾空白会让 coerce 取到空结果；这里防御直接调用方未清洗的入参。
  return semver.valid(semver.coerce(version.trim()));
}

// [权衡] 解析失败时退化为"字符串不相等即认为有更新"，而不是判定为无更新。
// 宁可多下载一次（用户可取消），也不能因为版本格式异常而永久错过安全更新；
// 该退化只在两个版本至少有一个无法解析时发生，正常情况下仍走 semver.gt。
function isVersionGreaterThan(candidateVersion: string, baselineVersion: string): boolean {
  // 两侧分别归一：候选与基准可能来自不同来源（远端 manifest 与本地常量），格式不一定同构。
  const candidate = normalizeVersionForCompare(candidateVersion);
  // 基准也要归一：本地版本通常干净，但 dev 覆盖值可能是 `v` 前缀形态。
  const baseline = normalizeVersionForCompare(baselineVersion);
  // 两侧都解析成功才走 semver：只有一侧成功时无法成立比较，必须落到下面的字符串退化。
  if (candidate && baseline) {
    // 严格大于才算更新：相等或更旧都返回 false，否则同一版本会反复提示下载（INV-17）。
    return semver.gt(candidate, baseline);
  }

  // 退化判据是"不相等"而非"字典序更大"：格式异常时无法判断方向，宁可多提示一次（见上方 [权衡]）。
  return candidateVersion.trim() !== baselineVersion.trim();
}

// 已 ready 的版本是"用户已经付出下载成本"的资产，只有远端出现更高版本才允许覆盖。
// restored 标记例外：它来自 pending 说明而非真实安装上下文，必须允许同版本重新下载，
// 否则会一直停在伪 ready，点击安装也不会发生任何事。
function shouldDownloadAvailableUpdate(version: string): boolean {
  // 伪 ready 必须允许同版本重下：它的"已下载"不是事实，跳过会让用户点安装时无事发生（INV-4）。
  if (readyUpdateRestoredFromPendingReleaseNotes) {
    // true 表示可以下载：下载入口据此把伪 ready 退回 available 并重建真实安装上下文。
    return true;
  }

  // 没有 ready 或远端更高才允许下载：其余情况都是在覆盖用户已付下载成本的包（见上方注释）。
  return !readyUpdateVersion || isVersionGreaterThan(version, readyUpdateVersion);
}

// 轮询只在"没有正在进行的工作"时才有意义：checking/download-progress 下再查会与
// 当前流程抢状态；update-available 与 update-downloaded 则需要继续轮询以发现更高版本。
function canPollForUpdatesFromState(state: AutoUpdaterMenuState): boolean {
  // 白名单式可轮询状态：checking/download-progress 会与进行中的流程抢状态，因此明确排除（见上方注释）。
  return (
    state.kind === "idle" || state.kind === "update-available" || state.kind === "update-downloaded"
  );
}

// hasVisibleUpdateTarget 的"可见目标"定义被三处复用：轮询间隔、失败收敛分支与手动检查的 checking，所以改判据必须三处同步。
// 统一在此判定可以避免某一处漏掉 update-downloaded，导致状态被误清。
function hasVisibleUpdateTarget(state: AutoUpdaterMenuState): boolean {
  // 只把"有东西可点"的两种态算作可见目标：downloading 虽也面向用户，但它的轮询由定时器直接停表处理（见下方注释）。
  return state.kind === "update-available" || state.kind === "update-downloaded";
}

// hasVisibleUpdateTarget 为真时用 AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS 短间隔，让"用户盯着弹窗等新版本"的场景尽快收敛；
// 但下载中不轮询（由 ensureAutoUpdatePollInterval 直接停表），避免边下边查。
function resolveAutoUpdatePollInterval(state: AutoUpdaterMenuState): number {
  // 复用同一个判据而不是重写条件：轮询间隔与失败收敛必须对"可见"达成一致，否则会出现一处短轮询一处清状态。
  return hasVisibleUpdateTarget(state)
    // 可见时用短间隔：用户正盯着一个可操作目标，新版本晚出现两分钟就会被当成"检查坏了"。
    ? AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS
    // 无目标时用长间隔：后台空转打 manifest 既耗流量，又会在服务端造成无意义的检查峰值。
    : AUTO_UPDATE_POLL_INTERVAL_MS;
}

// 渠道必须从"当前状态携带的渠道"回退到模块记录，而不是直接读设置：
// 设置可能在检查过程中被改动，而当前展示的版本属于旧渠道，用新渠道去比较会误判。
function getAutoUpdaterReleaseChannelForCurrentState(): ElectronReleaseChannel {
  // 按 menuState 当前展示的状态分派，而不是读设置或全局变量：用户看到哪个版本，就应按那个版本所属的渠道去比较（见上方注释）。
  switch (menuState.kind) {
    // available 态只有一份渠道记录：状态里的 channel 是权威值，缺失才回落到模块记录。
    case "update-available":
      // 两级回退：状态自带的渠道优先，旧状态（无 channel 字段）用模块记录补，避免返回 undefined。
      return menuState.channel ?? availableUpdateChannel;
    // 下载态有第二层来源：downloadingUpdateChannel 是发起下载时锁定的值，比 available 更接近事实。
    case "download-progress":
      // 三层顺序不可换：available 可能已被新一轮检查改写，放在中间会让下载中的版本被标成新渠道。
      return menuState.channel ?? downloadingUpdateChannel ?? availableUpdateChannel;
    // ready 态同理，但中间层换成 readyUpdateChannel：它是发布 ready 时写入的渠道。
    case "update-downloaded":
      // 与下载态结构对称：保证显示中的 ready 版本总能找到它自己那一层的渠道。
      return menuState.channel ?? readyUpdateChannel ?? availableUpdateChannel;
    // idle/checking 没有携带渠道：此时模块记录就是唯一事实，也是下一次 begin 要锁定的 expected channel。
    default:
      // 不返回设置里的值：设置是"用户想要什么"，availableUpdateChannel 是"当前这批结果基于什么"（见上方注释）。
      return availableUpdateChannel;
  }
}

// 只接受白名单值：远端 manifest 的 zcodeReleaseChannel 是外部输入，
// 任意字符串若流入状态机会让渠道比较永远不相等，从而把所有结果都判成 stale。
function readUpdateInfoReleaseChannel(
  // 入参是整个 info 而非裸字段：渠道与版本来自同一条下载结果，分开传会让两者可能来自不同事件。
  info: UpdateDownloadedInfoLike,
): ElectronReleaseChannel | null {
  // 白名单逐值比较而不是 includes：TypeScript 需要这个形态才能把结果收窄成联合类型，同时拒绝大小写变体。
  return info.zcodeReleaseChannel === "preview" || info.zcodeReleaseChannel === "stable"
    // 命中白名单才回传 info.zcodeReleaseChannel 原值：此时它已被收窄，调用方无需再断言。
    ? info.zcodeReleaseChannel
    // null 表示"这条结果没有可用渠道"：调用方据此跳过 stale 判定，而不是把它当成 stable（见 shouldIgnoreStaleAvailableUpdate）。
    : null;
}

// [并发] begin 是整个互斥协议的起点：先置 in-flight，再推进世代并锁定 expected channel。
// 顺序不能反：若先写 activeAutoUpdateCheckId 而 in-flight 仍为 false，期间到达的事件
// 会走"无 check"分支绕过 settle 收口，造成状态与标记不一致。
function beginAutoUpdateCheck(): number {
  // 必须先置位：后续所有事件与收口都以它为"有 check 在进行"的判据，晚一步会让早到的事件走无 check 分支（INV-2）。
  checkForUpdatesInFlight = true;
  // 世代号只增不减：即使 id 理论上回绕，单调递增也能保证旧回调的 id 永远小于新回调。
  autoUpdateCheckGeneration += 1;
  // id 直接取世代值而不是另设计数器：两个数字分开维护就存在"id 相同但世代不同"的误判空间（INV-3）。
  activeAutoUpdateCheckId = autoUpdateCheckGeneration;
  // expected channel 在此刻锁定：之后用户切预览开关也不改变本次预期，这是 INV-14 的落点。
  activeAutoUpdateCheckChannel = availableUpdateChannel;
  // 新一轮开始必须清掉上一轮的收口中标记：残留会让本次结果的 settle 被误判为重复收口。
  settlingAutoUpdateCheckId = null;
  // 回传刚写入的 id：调用方拿它做后续校验，读同一个字段可避免返回值与全局值不一致。
  return activeAutoUpdateCheckId;
}

// [并发] 收口必须校验 checkId：只有"当前世代"才有资格清 in-flight 与待刷新通道。
// 迟到的旧检查若直接清标记，会让新一轮 check 失去互斥保护，两轮结果交错写 menuState。
// 清 pending 前先快照：待刷新通道要在标记清理后立刻用于重新请求，不能被中途事件覆盖。
function completeAutoUpdateCheck(reason: string, checkId: number | null): void {
  // 只有"当前世代"有资格收口：checkId 为 null 表示调用方无法证明身份（模块早期路径），此时按无校验处理。
  if (checkId !== null && activeAutoUpdateCheckId !== checkId) {
    // 迟到检查直接返回：它既不清 in-flight，也不消费待刷新渠道，把这两件事留给当前世代（INV-3）。
    return;
  }

  // 先放开互斥闸：后续的渠道刷新会重新发起检查，若闸还关着，那次检查会被自己的互斥挡掉（INV-13/INV-20）。
  checkForUpdatesInFlight = false;
  // 清 id 表示"当前没有有效检查"：之后到达的任何结果都会因 id 不匹配而被判迟到（INV-3）。
  activeAutoUpdateCheckId = null;
  // expected channel 随本次检查一起失效：它只服务于这一批结果，留着会让下一轮沿用旧渠道比较。
  activeAutoUpdateCheckChannel = null;
  // 收口中标记与 in-flight 同批清理：只清一个会让 finish 的重复检测失效（见 finishAutoUpdateCheck）。
  settlingAutoUpdateCheckId = null;

  // 先快照再清：下面的刷新函数会读同一字段，先清后读就永远拿不到用户切换的渠道（INV-13）。
  const pendingChannel = pendingManifestReleaseChannelRefresh;
  // 与渠道刷新一起快照：失败重查必须在"标记已清"之后再触发，否则会被新一轮检查当成重复请求丢掉。
  const shouldRecheckFailedDownload = pendingFailedDownloadRecheck;
  // 无条件复位：这个标记只服务一次收口，保留会让每次收口都补发一次重查（INV-20 的重复来源）。
  pendingFailedDownloadRecheck = false;
  // 三个条件都要成立：有失败待重查、没有渠道切换（切渠道本身会发起检查）、没有强更接管（强更不轮询）。
  if (shouldRecheckFailedDownload && !pendingChannel && !activeForceAutoUpdateListener) {
    // 下载失败发生在本次检查收口前。等标记清掉后再查一次，避免复查被进行中的检查直接丢掉。
    queueMicrotask(() => recheckAfterDownload?.("download-failed"));
  }
  // 没有渠道切换就到此为止：这是绝大多数正常收口的路径，早返回避免误触一次额外检查。
  if (!pendingChannel) {
    // 返回前不再写 pending 字段：它此刻本来就是 null，多写一次会掩盖上面的快照逻辑。
    return;
  }

  // 消费即清：渠道刷新是"一次性事件"，不清会让下一次收口重复刷新同一个渠道（INV-13）。
  pendingManifestReleaseChannelRefresh = null;
  // 通过公开入口刷新而不是直接改 availableUpdateChannel：入口包含安装锁、下载态、同渠道等全部校验。
  refreshAutoUpdaterReleaseChannel(
    pendingChannel === "preview",
    `${reason} pending release channel refresh`,
  );
}

// finish 与 settle 的分工：settle 覆盖"请求 + 结果处理"，finish 只用于 Promise 收口。
// 若结果处理已经通过 settle 收口，这里的重复调用必须被识别并短路，
// 否则会把 pendingManifestReleaseChannelRefresh 提前清掉，丢失用户刚切换的渠道。
function finishAutoUpdateCheck(reason: string, checkId: number | null): void {
  // 三个条件缺一不可：id 必须仍有效、仍是当前世代、且确实处于"结果处理中"，才说明 settle 已经收过口。
  if (
    checkId !== null &&
    activeAutoUpdateCheckId === checkId &&
    settlingAutoUpdateCheckId === checkId
  ) {
    // 重复调用必须短路：否则会把已经登记的新渠道刷新提前清掉，用户切的渠道就丢了（见函数头注释）。
    return;
  }

  // 非重复场景统一交给 completeAutoUpdateCheck：清理与后续刷新只有这一条实现，避免两处分叉。
  completeAutoUpdateCheck(reason, checkId);
}

// [并发] electron-updater 的 checkForUpdates() 只代表"请求返回"，update-available 回调里
// 还有读设置、跳过判定、自动下载等异步工作。这里把互斥范围扩展到 work() 完成，
// 保证通道刷新或手动检查不会插进"旧结果尚未写完状态"的窗口。
// finally 中收口而不是在 work 内收口，是为了让异常路径也走同一条清理逻辑。
function settleAutoUpdateCheckResult(
  // reason 会传进收口与日志：它把"启动检查/失败重查/渠道刷新"与最终的清理记录对应起来。
  reason: string,
  // 允许同步或异步：update-available 的处理可能只是同步写状态，强制 Promise 会给每条路径加一层无意义包装。
  work: () => Promise<void> | void,
): Promise<void> {
  // 在 work 启动前锁定 id：work 内部可能触发新的检查并改写全局，晚读会把收口挂到别人的 id 上（INV-2）。
  const checkId = activeAutoUpdateCheckId;
  // 没有进行中的检查时不做互斥包装：直接执行 work，避免为一个不存在的世代登记 settling 标记。
  if (!checkForUpdatesInFlight || checkId === null) {
    // 用 Promise.resolve 包同步返回值：调用方拿到统一语义，但同步异常仍会直接抛出（由上层 try 捕获）。
    return Promise.resolve(work());
  }

  // 登记"结果处理中"：finishAutoUpdateCheck 靠它识别"Promise 先收口、处理后完成"的重复收口（INV-2）。
  settlingAutoUpdateCheckId = checkId;
  try {
    // 用 finally 覆盖成功与失败：work 抛错时也必须放开互斥闸，否则更新检查会永久卡在 in-flight。
    return Promise.resolve(work()).finally(() => {
      // electron-updater 的 checkForUpdates() Promise 只代表请求返回，
      // 不会等待 update-available 里读取设置、跳过版本、自动下载等异步状态处理。
      // 这里让一次 check 的互斥范围覆盖“请求 + 结果处理”，避免通道刷新或手动检查抢在旧结果写状态前启动。
      completeAutoUpdateCheck(reason, checkId);
    });
  } catch (error) {
    // 同步抛错的路径同样要收口：work 内部的同步异常不会进入 finally，只能在这里兜住。
    completeAutoUpdateCheck(reason, checkId);
    // 收口后原样拒绝：调用方仍需要感知失败（用于日志与手动检查回投），不能因为已清理就吞掉。
    return Promise.reject(error);
  }
}

// 只比较"本次 check 锁定的渠道"：activeAutoUpdateCheckChannel 在 begin 时锁定，
// 期间即使用户切换设置也不会改变本次预期，避免同一批结果内部自相矛盾。
// info 未携带渠道时不做判定（null 表示旧版本 feed 不提供该字段）。
function shouldIgnoreStaleAvailableUpdate(infoChannel: ElectronReleaseChannel | null): boolean {
  // 锁定值缺失时才回落模块记录：理论上 begin 已写入，这里的兜底针对不经过 begin 的旧调用路径。
  const expectedChannel = activeAutoUpdateCheckChannel ?? availableUpdateChannel;
  // info 无渠道（null）时不判 stale：旧 feed 不提供该字段，把"无渠道"当不匹配会丢掉所有结果（INV-14）。
  return Boolean(infoChannel && infoChannel !== expectedChannel);
}

// 这是"能否安装"的唯一判据：ready 版本必须同时等于模块记录与 menuState 中展示的版本。
// 只校验其中一处会在远端推进后被旧 ready 骗过，最终装上低于目标的包。
function isReadyUpdateCurrentTarget(): boolean {
  // 用 Boolean 收口三条件：返回值必须是确定布尔，不能把 undefined 透给调用方的 if。
  return Boolean(
    readyUpdateVersion &&
    menuState.kind === "update-downloaded" &&
    menuState.version === readyUpdateVersion,
  );
}

// 构造器只读模块状态，不接收调用方传入的版本/渠道：让"展示的"与"记录的"永远同源，
// 否则某条失败路径可能把旧版本号配上新渠道。
function buildUpdateDownloadedState(version: string): AutoUpdaterMenuState {
  // 状态对象在这里一次性构造：所有字段都来自模块记录，调用方无法注入旧版本号（见函数头注释）。
  return {
    // kind 与函数名绑定：这个构造器只能产出 ready 态，避免被复用来产出别的状态。
    kind: "update-downloaded",
    // ready 必须可用：它是"重启即安装"的入口，禁用会让用户看到一个无法操作的已下载版本。
    enabled: true,
    version,
    ...(readyUpdateChannel ? { channel: readyUpdateChannel } : {}),
    ...(readyUpdateReleaseNotes ? { releaseNotes: readyUpdateReleaseNotes } : {}),
  };
}

// update-available 必须显式带 channel：renderer 的"跳过此版本"会把它写进对应渠道的
// skipped 记录；缺省会让跳过落到 stable，preview 用户下次仍被同一版本打扰。
function buildUpdateAvailableState(
  // 版本必填：available 态的"跳过此版本"要用它作为跳过键，缺失会让跳过落到 undefined 键上（INV-17）。
  version: string,
  // 允许 null：manifest 可以不提供说明，构造器用条件展开把它省略，而不是塞进一个空对象。
  releaseNotes: PostUpdateReleaseNotesPayload | null,
  // 渠道必填（与 ready 构造器不同）：跳过记录按渠道隔离，缺省渠道会把 preview 的跳过写到 stable（见函数头注释）。
  channel: ElectronReleaseChannel,
): AutoUpdaterMenuState {
  // 与 ready 构造器同构：字段全部来自入参或模块记录，保证 renderer 拿到的版本、渠道、说明同源。
  return {
    // available 的 kind 是跳过与下载两条 renderer 动作的触发条件，写错会让按钮永远不出现。
    kind: "update-available",
    // 可更新态必须可点：这里是用户唯一能主动发起下载的入口。
    enabled: true,
    version,
    channel,
    ...(releaseNotes ? { releaseNotes } : {}),
  };
}

// 强更监听器可能已被释放（弹窗关闭），可选链保证状态推进不被悬空回调打断；
// 这是"旁路通知"而不是状态提交，失败不影响 menuState。
function notifyForceAutoUpdate(state: ForceAutoUpdateState) {
  // 可选调用：弹窗关闭后监听器为 null，这不是异常路径，静默丢弃即可（见函数头注释）。
  activeForceAutoUpdateListener?.(state);
}

// 文案在这里内联而不是走 shared 的 id 表：它是强更专用的一次性提示，不需要参与菜单的翻译复用。
function getForceAutoUpdateNoUpdateMessage(): string {
  // 只区分中英两种：强更弹窗只在这些环境出现，为它引入完整 locale 表得不偿失。
  return menuLocale === "zh-CN"
    // 中文文案强调"手动升级"这一出路：只说"没有更新"会让被强更挡住的用户无处可去。
    ? "未找到可安装更新，请使用手动升级。"
    // 英文文案与中文语义严格对应：两条分支表达同一件事，避免用户按 menuLocale 得到不同建议。
    : "No installable update was found. Use manual update instead.";
}

// progress 来自 electron-updater 的运行时对象，percent 可能是字符串/NaN/越界；
// 这里统一收敛到 0..100 的整数字符串，避免 UI 出现 "Infinity%" 或负进度。
function normalizeProgressPercent(progress: unknown): string | undefined {
  // 三重判空：normalizeProgressPercent 的入参可能是 undefined、null 或缺少 percent 字段，任一不满足就不能取值。
  if (typeof progress !== "object" || progress === null || !("percent" in progress)) {
    // undefined 让调用方省略 progress 字段：渲染端据此显示"准备中"，而不是 0%。
    return undefined;
  }

  // 先断言再取值：percent 的运行时类型可能是字符串，交给 Number 统一转换，避免字符串比较。
  const percent = Number((progress as { percent?: unknown }).percent);
  // NaN/Infinity 都要挡：它们是 Number 转换的合法产物，但会让 toFixed 输出 NaN 或 Infinity%。
  if (!Number.isFinite(percent)) {
    // 非法数值按"无进度"处理：宁可不显示进度条，也不能把 NaN/Infinity 交给渲染层显示成错误百分比。
    return undefined;
  }

  // 夹紧到 0..100 再取整：electron-updater 可能给出越界值或小数，夹紧能保证进度条不溢出。
  return Math.max(0, Math.min(100, percent)).toFixed(0);
}

// [权衡] 进度日志按 10% 分桶：下载事件每秒可达数十次，逐条记录会淹没连接日志并放大
// 磁盘 IO；分桶后仍能看出阶段，但会丢失桶内抖动，因此只用于强更的可观测性。
// 分桶变量 forceAutoUpdateLastLoggedProgressBucket 在 requestForceAutoUpdate 开始时重置，否则上一次的桶位会把本次首条日志吞掉。
function logForceAutoUpdateProgress(progress: string | undefined) {
  // 无进度直接返回：首条事件可能不带 percent，此时不应消耗桶位，否则第一次真实进度会被吞掉。
  if (!progress) {
    // 不更新桶位：forceAutoUpdateLastLoggedProgressBucket 只有真的记录过一次进度才有意义（见函数头注释）。
    return;
  }

  // 按 10% 向下取整得到 bucket：同一档内多次事件只能记一条，档位边界固定在 0/10/.../100，便于日志对齐。
  const bucket = Math.floor(Number(progress) / 10) * 10;
  // 同档不重复记：下载事件每秒可达数十次，bucket 相等时直接返回，这是日志量的主要闸门（见函数头注释）。
  if (bucket === forceAutoUpdateLastLoggedProgressBucket) {
    // 直接返回而不更新桶位：桶位在下面统一写入，这里重复赋值没有意义。
    return;
  }
  // 先更新 bucket 再写日志：日志写入可能抛错（磁盘满等），先更新可避免同档反复尝试。
  forceAutoUpdateLastLoggedProgressBucket = bucket;
  // 日志格式带 % 与固定前缀：便于按前缀过滤出一次安装的完整进度轨迹。
  logger.info(`[force-update] 自动升级下载进度 ${progress}%`);
}

// 下载态把 enabled 置 false：此时菜单项不应再触发新的检查；
// 字节进度与百分比同时下发，renderer 可自行选择展示粒度。
function buildDownloadProgressState(
  // 进度是字符串而非数字：它直接用于渲染，避免 renderer 再做一次格式化（见 normalizeProgressPercent）。
  progress: string,
  // 字节进度可选：部分 provider 不提供总大小，缺失时只显示百分比。
  byteProgress?: { transferredBytes: number; totalBytes: number },
): AutoUpdaterMenuState {
  // download-progress 态的所有可选字段都用条件展开：缺哪个就省略哪个，而不是用空值占位。
  return {
    // 这是唯一高频广播的 kind：它的去重逻辑与其它状态不同（见 isSameAutoUpdaterMenuState）。
    kind: "download-progress",
    // 下载中禁用菜单入口：此时再触发检查或下载会与进行中的链竞争 token（见上方注释）。
    enabled: false,
    progress,
    ...(byteProgress ? byteProgress : {}),
    ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
    ...(downloadingUpdateChannel ? { channel: downloadingUpdateChannel } : {}),
    ...(downloadingUpdateReleaseNotes ? { releaseNotes: downloadingUpdateReleaseNotes } : {}),
  };
}

// [事务] 安装是一次不可回滚的交接：进入 preparing 后 Host/Agent 会被关闭。
// 因此所有"能否安装"的校验必须在置位之前完成，置位之后只允许前进到 installing/recovering。
async function quitAndInstallUpdate(rejectUnavailable = false) {
  // 重复请求直接返回而不是抛错：renderer 可能同时通过 IPC 与菜单触发，
  // 第二次点击应被视为幂等，而不是让 UI 收到一个无法解释的失败。
  if (quitAndInstallState !== "idle") {
    // 记录重复请求：renderer 连点或 IPC 与菜单同时触发时会走到这里，日志能区分"没反应"与"被幂等拦截"。
    logger.info("[auto-update] quitAndInstall already in flight");
    // 直接返回且不抛错：重复安装请求应被视为幂等成功，抛错会让 UI 收到一个无法解释的失败。
    return;
  }
  // restored 分支必须最先判：它伪装成 update-downloaded，若先走下方通用准入，
  // 就会把一个没有安装上下文的 ready 交给原生安装器（INV-4）。
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    readyUpdateRestoredFromPendingReleaseNotes
  ) {
    // 先快照三件套再清 ready：clearReadyUpdateState 会把它们置空，而重建 available 与重新下载都要用到（INV-12）。
    const restoredVersion = readyUpdateVersion;
    // 说明必须一起快照：只保留版本会让重新下载后的弹窗丢失安装后说明（INV-16）。
    const restoredReleaseNotes = readyUpdateReleaseNotes;
    // 渠道回落一层：磁盘恢复的 ready 可能没有渠道（旧数据），此时按最后一轮检查的渠道重下。
    const restoredChannel = readyUpdateChannel ?? availableUpdateChannel;
    // [失败路径] restored ready 没有真实安装上下文（进程重启后 electron-updater 的
    // downloadedUpdateHelper 已丢失），直接 quitAndInstall 只会静默失败。
    // 因此先退回 update-available，再按用户偏好重新下载，由 update-downloaded 重建上下文。
    logger.warn(
      `[auto-update] restage restored pending update before install version=${restoredVersion}`,
    );
    // 先清 ready 再退回 available：restored 标记与 ready 三件套必须同时消失，
    // 否则下载完成时会再次被当成伪 ready（INV-7）。
    clearReadyUpdateState();
    // 回填说明：退回的 available 需要完整三元组，用户点重试时弹窗才能展示同一份说明（INV-12）。
    availableUpdateReleaseNotes = restoredReleaseNotes;
    // 退回 available 时一次性写全三元组：分开写会让 renderer 收到"有版本无说明"的中间态，
    // 也便于下载入口据此做状态白名单校验（INV-12）。
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(restoredVersion, restoredReleaseNotes, restoredChannel),
    );
    // 是否立即重下取决于用户偏好：await 期间用户可能关掉自动下载，按最新设置决定而不是按进入函数时的快照。
    if (await shouldAutoDownloadAndInstallUpdates(autoUpdaterSettingService)) {
      // 复用统一下载入口：它会重新校验状态白名单与 token，避免这里另开一条没有幂等保护的下载链。
      downloadAvailableUpdate("restored-pending-install");
    }
    // 无论是否重下都必须返回：继续往下会进入真实安装，而此刻 ready 已被清空（INV-7）。
    return;
  }

  // [失败路径] renderer 可能持有旧的 UpdateReady 缓存。这里以 Main 状态为准拒绝安装，
  // 并在 IPC 路径上抛错，让"重启以更新"按钮能结束 pending 而不是永久转圈。
  if (
    menuState.kind !== "update-downloaded" ||
    !readyUpdateVersion ||
    !isReadyUpdateCurrentTarget()
  ) {
    // 修复原因：renderer 可能因为旧 UpdateReady 缓存残留而展示“重启以更新”，
    // 但 main 在 staging error 后已经清掉 ready。目标已经换成更高版本时，
    // 这里也不能安装仍低于目标的旧包。
    logger.warn(`[auto-update] ignore quitAndInstall request: state=${menuState.kind}`);
    // 只有 IPC 调用方要求"失败必须可见"时才抛错：菜单入口是 fire-and-forget，抛错无人接住会变成未处理异常。
    if (rejectUnavailable) {
      // 错误信息带出当前 state：renderer 用它决定是结束 pending 还是保留按钮，只说失败无法驱动 UI 收敛。
      throw new Error(`Update is not ready to install: state=${menuState.kind}`);
    }
    // 菜单入口失败时静默返回：状态本身已由 menuState 表达，菜单项的可用性会随广播更新。
    return;
  }

  // 安装只读取已下载包，不依赖 manifest 请求。立即锁定 ready，迟到检查不能替换它，
  // 也不能让一次挂起的后台网络请求扣押用户已经选择的安装。
  // [事务] 置位后不再接受任何会改变 ready 目标的操作：迟到检查只能收口，不能替换目标，
  // 这也让挂起的后台网络请求无法扣押用户已经确认的安装。
  quitAndInstallState = "preparing";
  // 在置位之后立刻落日志：这是"用户已发起安装"的唯一时间点，之后进程随时可能退出，日志必须先写。
  logger.info("[auto-update] user requested quit and install");
  // macOS 上 quitAndInstall() 在关窗前不会先走 app.before-quit。
  // 如果仍然只靠 before-quit 去放行窗口 close，现有的“红绿灯关闭=隐藏窗口”逻辑会把退出拦住，
  // 表现成点击更新后界面消失但进程没退、安装流程也不再继续。
  // 这里先通知主进程进入“允许真正关窗”的状态，再把控制权交给 updater。
  try {
    // Windows 更新会替换 resources/glm 等随包资源；
    // 若 quitAndInstall 先于 host/agent 子进程完成退出，安装器可能在文件仍被占用时开始覆盖，
    // 最终留下“应用能启动但 bundled agent 丢失”的半更新状态。
    // 这里显式等待主进程完成退出准备，再进入安装器，尽量把资源替换和子进程回收时序拉直。
    // [资源] 退出准备的顺序不可交换：先停 Host/Agent（释放 stdio 与文件锁），
    // 再让 updater 启动安装器。反过来会让 Windows 安装器在文件仍被占用时开始覆盖。
    await onBeforeQuitAndInstall?.();
  } catch (error) {
    // [失败路径] 退出准备失败且继续安装 = 半更新（资源被占用）。这里宁可重启恢复，
    // 也不能把控制权交给安装器；rejectUnavailable 时再把错误上抛给 IPC 调用方。
    // 安装前退出准备是释放 host/agent 与 resources/glm 文件锁的硬前置条件。
    // 如果这里失败后仍启动安装器，Windows 可能在资源仍被占用时覆盖安装目录，形成半更新。
    handleAutoUpdateFailure(error, "prepare quit and install failed");
    // 退出准备失败走重启恢复：进程已无法回到可用窗口（资源可能半释放），只能重启重建 Host/Agent（INV-6）。
    recoverFromFailedUpdateInstall();
    // 恢复动作先执行、错误后上抛：让 IPC 调用方拿到失败原因的同时，进程已经进入恢复流程。
    if (rejectUnavailable) {
      // 原样上抛而不是包一层：调用方需要原始错误判断是否是资源占用这类可重试失败。
      throw error;
    }
    // 菜单入口在恢复后直接返回：不能再往下走到 installing，否则会在资源未释放时启动安装器（INV-19）。
    return;
  }

  // [事务] await 期间远端可能推进目标或原生 staging 失败；必须重新校验。
  // 此时进程已无法回到可用窗口，唯一出路是重启恢复。
  if (!readyUpdateVersion || !isReadyUpdateCurrentTarget()) {
    // 后台结果已锁定，只有原生 staging 错误能使 ready 失效。服务已经清理，
    // 此时不能仅解除标记停留在旧窗口，必须重启恢复 Host/Agent 和远控连接。
    recoverFromFailedUpdateInstall();
    // await 之后 ready 失效只能重启恢复：服务已关闭，停留在旧窗口会留下一个连不上 Host 的空壳（INV-6）。
    return;
  }

  // 只有在退出准备完成且 ready 仍有效时才进入 installing：此后不再接受回退，只能前进或进入 recovering（INV-6）。
  quitAndInstallState = "installing";
  try {
    // 开发态没有真实发布包上下文，调用原生 quitAndInstall 只会退出而不安装；
    // 重启当前 dev app 是为了让"更新入口 -> 退出准备 -> 重启"闭环可被验证。
    if (shouldRelaunchForDevAutoUpdateInstall()) {
      // 开发态只用于验证服务端 manifest、下载进度和安装入口 UI 闭环，
      // 未打包应用没有可被安装器接管的真实发布包上下文。这里改为重启当前 dev app，
      // 避免点击“重启以更新”执行退出准备后停在无响应状态。
      logger.info("[auto-update] dev update install fallback: relaunch app");
      // 开发态直接重启而不是交给安装器：未打包应用没有可被接管的发布包，原生安装只会退出不安装。
      app.relaunch();
      // relaunch 后必须显式退出：relaunch 只是登记下一次启动，当前进程不退出会让重启永不发生。
      app.exit(0);
      // 返回避免继续执行到原生 quitAndInstall：那会把 dev 环境交给一个不存在的安装上下文。
      return;
    }

    // 3.3.0 的 Windows 自定义 PowerShell delayed launcher 在 detached/hidden
    // 模式下可能只创建 powershell.exe，却没有稳定执行到安装器启动，用户看到应用关闭但版本不变。
    // 这里恢复 electron-updater 原生安装入口，避免把“launcher 进程创建成功”误当成更新已接管。
    // [资源] 成功后故意不清 quitAndInstallState：原生安装会异步触发 before-quit，
    // 若此时回到 idle，退出监听器会再次进入本函数，形成"再次安装"的无限重入。
    autoUpdater.quitAndInstall();
    // macOS 安装入口会先返回，原生 staging 完成后才异步触发 before-quit。
    // 若在 finally 清标记，退出监听器会重新拦截并安装，形成无限重入；成功交接后保留到进程退出。
  } catch (error) {
    // 安装异常统一进失败收敛点：它负责区分下载/安装来源并决定是否恢复，这里不重复写状态。
    handleAutoUpdateFailure(error, "quit and install failed");
    // 与前面的准入失败一致：IPC 调用方需要拿到异常，菜单入口只需要状态收敛。
    if (rejectUnavailable) {
      // 上抛原始错误：调用方据此提示用户安装失败，而不是把异常吞在 Main 里。
      throw error;
    }
  }
}

// 菜单项可能尚未创建（窗口未就绪或菜单被重建）；找不到时静默跳过，
// 因为状态本身已经写入 menuState，窗口加载后会通过同步 IPC 补齐。
function updateMenuItemLabel(label: string, enabled: boolean) {
  // 每次重建时重新取菜单：菜单可能在语言切换或窗口切换时被整体替换，缓存旧引用会改到已失效的实例上。
  const menu = Menu.getApplicationMenu();
  // 用 CHECK_FOR_UPDATE_MENU_ID 而不是文本查找：文案本身就是待更新的内容，按文本查找在切换语言后必然失配。
  const item = menu?.getMenuItemById(CHECK_FOR_UPDATE_MENU_ID);
  // 菜单项可能尚不存在（窗口未就绪或菜单被重建）：这里静默跳过，
  // 状态本身已写入 menuState，窗口加载后会通过同步 IPC 补齐（见函数头注释）。
  if (item) {
    // 直接改现有菜单项而不是重建菜单：重建会丢失用户展开的子菜单与焦点，且触发一次全窗口菜单同步。
    item.label = label;
    // enabled 与 label 必须同批写入：只改文案不改可用性，会出现"下载中"却仍可点击的菜单项。
    item.enabled = enabled;
  }
}

// 文案由 kind 唯一决定，而不是读取多个布尔标记：这样可以保证菜单文本与弹窗态
// 不会因为某个分支漏改而互相矛盾；版本/进度来自状态自身，避免读到上一阶段残留。
function getMenuItemLabel(state: AutoUpdaterMenuState): string {
  // 按 kind 分派而不是读多个布尔标记：文案与状态一一对应，漏改某个分支会互相矛盾（见函数头注释）。
  switch (state.kind) {
    // checking 复用通用"正在检查"文案：它没有额外载荷，不需要格式化参数。
    case "checking":
      // 文案走 shared 的 id 表而不是内联字符串：菜单与弹窗必须共用同一套翻译，否则两处会出现不同措辞。
      return getDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpCheckingForUpdates);
    // 可更新态必须带版本号：用户需要知道将升级到哪个版本，缺少版本会让人怀疑是重复提示。
    case "update-available":
      // 用带参格式化而不是字符串拼接：参数占位符由 shared 侧定义，拼接会绕过翻译占位顺序。
      return formatDesktopMenuMessage(
        menuLocale,
        desktopMenuMessageIds.helpUpdateAvailableVersion,
        { version: state.version },
      );
    // 下载态显示进度：进度是用户判断还要等多久的唯一信息，缺省会让菜单看起来卡住。
    case "download-progress":
      // 进度同样走格式化入口：与 available 共用同一套 locale 解析，避免一处已翻译一处没翻译。
      return formatDesktopMenuMessage(
        menuLocale,
        desktopMenuMessageIds.helpDownloadingUpdateProgress,
        { progress: state.progress },
      );
    // update-downloaded 的文案是行动指令（重启以更新）而非陈述：它直接引导用户完成最后一步。
    case "update-downloaded":
      // 重启文案携带版本号：安装后版本会变，用户需要能核对装的是哪个版本。
      return formatDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpRestartToUpdate, {
        // 版本号取自 state 而不是 readyUpdateVersion：菜单文案要为用户看到的那一版服务，两处若有瞬时差异应以显示态为准。
        version: state.version,
      });
    // idle 与 default 合并处理：任何未知 kind 都应退化成"检查更新"这个安全入口，而不是空文案。
    case "idle":
    // default 兜底不可删：新增 kind 时若忘记加分支，菜单仍要有可点击入口。
    default:
      // 兜底文案必须无参数：未知状态没有可靠载荷，强插参数会显示 undefined。
      return getDesktopMenuMessage(menuLocale, desktopMenuMessageIds.helpCheckForUpdates);
  }
}

// 单一入口：locale 变化与状态变化都走这里，避免两处各写一份 label 计算逻辑。
function syncMenuItemState() {
  // 两个入参都取自同一个 menuState 快照：分开读会在并发写入的间隙取到 label 与 enabled 不一致的组合。
  updateMenuItemLabel(getMenuItemLabel(menuState), menuState.enabled);
}

// 去重是防止事件风暴的关键：download-progress 每秒多次，若每条都广播，
// renderer 会不断重渲染，菜单也会反复 setLabel。
// releaseNotes 用 JSON.stringify 比较：它是纯数据对象，深比较成本可接受且字段顺序稳定。
// idle/checking 只比较 kind/enabled，因为这两个状态没有可变的载荷字段。
function isSameAutoUpdaterMenuState(left: AutoUpdaterMenuState, right: AutoUpdaterMenuState) {
  // kind/enabled 是全部状态的公共字段，先在公共层判掉：不一致直接返回，避免进入各 kind 的载荷比较。
  if (left.kind !== right.kind || left.enabled !== right.enabled) {
    // false 表示"不同"→ 需要广播：判断方向必须与调用方 isSame... 的语义一致，取反会让每条事件都被丢弃。
    return false;
  }

  // 按 left.kind 分派：公共字段已相等，剩下的差异只可能来自同一 kind 的载荷。
  switch (left.kind) {
    // available 的载荷是版本+渠道+说明：三者任一变化都要广播，否则界面会停留在旧版本信息上。
    case "update-available":
      // 逐字段比较而非 JSON 整体比较：版本与渠道是原始值，先比它们能在最常见的"版本变化"场景下短路。
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    // ready 态与 available 同构：它的载荷也是版本+渠道+说明，复用同一组比较字段。
    case "update-downloaded":
      // ready 的比较字段与 available 完全一致：两者差异只在 kind（已在上方公共层比过），载荷比较可复用同一组条件。
      return (
        right.kind === left.kind &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    // 进度态额外比较 progress：这是唯一高频变化的字段，也是去重的主要目的（见函数头注释）。
    case "download-progress":
      // 进度相同即视为同一状态：download-progress 每秒多次，只比进度能让广播次数与真实变化对齐。
      return (
        right.kind === left.kind &&
        right.progress === left.progress &&
        right.version === left.version &&
        right.channel === left.channel &&
        JSON.stringify(right.releaseNotes ?? null) === JSON.stringify(left.releaseNotes ?? null)
      );
    // idle/checking 没有载荷字段：公共字段已在上面比过，走到这里即等价。
    case "idle":
    // checking 同样无载荷：它只有 enabled=false 这一个事实，已在公共层判过。
    case "checking":
    // default 与 idle 合并：未知 kind 按"无载荷"处理，避免未来新增状态时误判成"不同"而反复广播。
    default:
      // true 表示"相同"→ 调用方跳过写入：这是去重的落点，返回反了会让每次 setAutoUpdaterMenuState 都变成空转广播。
      return true;
  }
}

// 广播给所有窗口而不是只给发起检查的窗口：更新是应用级事实，多窗口都必须同步；
// isDestroyed 检查是必要的，窗口可能在事件循环切换期间被关闭。
function broadcastAutoUpdaterState() {
  // 遍历当前所有窗口而不是维护自己的窗口列表：窗口的创建与销毁由 Electron 管理，自建列表必然会漂移。
  for (const win of BrowserWindow.getAllWindows()) {
    // [失败路径] 销毁中的窗口不能 send：会抛 "Object has been destroyed"，
    // 而这个异常发生在广播路径上，会打断其余窗口的同步。
    if (!win.isDestroyed()) {
      // 广播的是 menuState 而非入参：调用方传入的状态已在赋值后成为 menuState，读同一来源可避免两者分叉（INV-1）。
      win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
    }
  }
}

// 返回退订函数而不是要求调用方持有 listener 引用：调用方（如托盘/IPC 桥）常在
// 组件卸载时忘记比较引用，导致闭包泄漏；这里把退订语义固化下来。
export function onAutoUpdaterStateChanged(listener: (state: UpdateStatePayload) => void) {
  // 用 Set 而非数组：同一监听器被重复注册时只保留一份，避免卸载一次后仍有残留引用。
  autoUpdaterStateListeners.add(listener);
  // 返回退订闭包而不是暴露集合：调用方无需持有 listener 引用即可解绑，避免卸载时漏删（见函数头注释）。
  return () => {
    // 退订只删自己：按引用删除，重复调用是幂等的，不会影响其它订阅者。
    autoUpdaterStateListeners.delete(listener);
  };
}

// [并发] 写入顺序固定为：去重 -> 赋值 -> 菜单 -> 广播 -> 轮询 -> 监听器。
// menuState 必须先赋值，后续所有派生读取才有稳定值；轮询复位放在广播之后，
// 是为了让 renderer 先看到终态再决定下一次查询节奏。
// 监听器放在最后：它们是外部代码，可能重入本模块，必须看到完全收敛的状态。
function setAutoUpdaterMenuState(nextState: AutoUpdaterMenuState) {
  // 去重必须在赋值之前：download-progress 每秒多次，先赋值再比较等于把"是否相同"的判据也改掉了（INV-1）。
  if (isSameAutoUpdaterMenuState(menuState, nextState)) {
    // 相同状态直接返回：不广播、不重建菜单、不复位轮询，这是控制事件风暴的关键出口。
    return;
  }

  // 先赋值：后续菜单同步、广播、监听器都读 menuState，先赋值才能保证它们看到同一份事实（INV-1）。
  menuState = nextState;
  // 菜单同步紧随赋值：菜单是用户最直接看到的入口，延后会出现"状态已变但菜单仍禁点"的窗口。
  syncMenuItemState();
  // 广播在菜单之后：广播可能触发 renderer 立即回查状态，此时菜单与 menuState 必须已一致。
  broadcastAutoUpdaterState();
  // 轮询复位放在广播之后：让 renderer 先看到终态再决定查询节奏（INV-18）。
  ensureAutoUpdatePollInterval();
  // 监听器最后执行：它们是外部代码，可能重入本模块，必须看到完全收敛的状态（见函数头注释）。
  for (const listener of autoUpdaterStateListeners) {
    // 传入 menuState 而非闭包捕获的 nextState：两者此刻相等，但读全局能保证监听器与其他路径看到同一对象。
    listener(menuState);
  }
}

// webContentsId 是窗口销毁后仍可能被引用的稳定标识；这里每次重新查找并要求未销毁，
// 避免把消息发给一个已 detach 的 webContents。
function findLiveWindowByWebContentsId(webContentsId: number | null) {
  // 空 id 直接返回 null：手动检查未发起时它就是 null，这是常态而非错误。
  if (webContentsId == null) {
    // 返回 null 而不是抛错：调用方用 if (!win) 处理，抛错会让"窗口已关闭"这种正常竞态变成失败日志。
    return null;
  }

  // 每次重新遍历窗口查找：窗口可能已被关闭或重载，缓存的 webContents 引用会指向已销毁对象（见函数头注释）。
  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
    ) ?? null
  );
}

// 标题优先取 markdown 的第一个一级标题，取不到才退回版本号：
// 远端说明不一定提供 releaseName，标题为空会让弹窗出现空白头部。
function deriveReleaseNotesTitle(markdown: string, version: string) {
  // 只看首个一级标题：releaseNotes 正文里可能有多个标题，取第一个才符合"标题即文档标题"的直觉。
  const firstHeading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("# ") && line.length > 2);

  // 取不到标题时用版本号兜底：保证返回非空字符串，渲染端不必再判空（见函数头注释）。
  return firstHeading ? firstHeading.slice(2).trim() : `Release v${version}`;
}

// normalizeReleaseNotesMarkdown 兼容三种上游形态：纯字符串、注记数组与 null，所以数组要按空行拼接，
// 空项被过滤，保证不会产出只有空白的 markdown。
function normalizeReleaseNotesMarkdown(
  // 入参声明为三种形态（字符串/数组/null）：归一函数必须自己判型，调用方不做预转换。
  releaseNotes: UpdateDownloadedInfoLike["releaseNotes"],
): string | null {
  // 字符串是最常见的上游形态，先判它可以在数组分支之前完成清洗并返回。
  if (typeof releaseNotes === "string") {
    // trim 后判空：远端可能下发纯空白正文，未清洗会把它当成有效说明持久化。
    const markdown = releaseNotes.trim();
    // 空串归一成 null：调用方用 !markdown 判断"没有说明"，null 与空串同效但语义更明确。
    return markdown === "" ? null : markdown;
  }

  // 非数组非字符串即视为无说明：包括 null 与结构漂移的对象，直接返回 null 而不是猜测字段。
  if (!Array.isArray(releaseNotes)) {
    // null 让上层走 locale 兜底或最终清空 pending（INV-16）。
    return null;
  }

  // 数组按 note 字段拼接：这是 electron-updater 注记数组的协议形态，逐项 trim 后过滤空项。
  const markdown = releaseNotes
    .map((item) => (typeof item?.note === "string" ? item.note.trim() : ""))
    .filter((item) => item.length > 0)
    .join("\n\n")
    .trim();

  // 与字符串分支同一收口语义：拼接后为空（或全被过滤）时返回 null，保证"无说明"只有一种表示。
  return markdown === "" ? null : markdown;
}

// 只保留 zh-CN/en-US 两种 locale：产品只发布这两种文案，
// normalizeLocalizedReleaseNotes 过滤其他 locale 键：它们即使远端下发也不进入持久化，所以设置文件不会无限膨胀。
// 每个 locale 的标题缺失时用 markdown 首标题补齐，保证渲染端不必再判空。
function normalizeLocalizedReleaseNotes(
  // 版本用于推导缺失标题时的兜底文案：它同时也是载荷的幂等键，必须随 locale 归一一起传下（INV-16）。
  version: string,
  // releaseNotesByLocale 在运行时可能整体缺失或类型漂移：声明为可空结构，判型在函数体内完成。
  releaseNotesByLocale: UpdateDownloadedInfoLike["releaseNotesByLocale"],
): PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined {
  // 先建空对象再按白名单填充：只有真正有正文的语言才会写入键，空对象最终归一成 undefined。
  const localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] = {};
  // 先判 falsy 再判类型：null/undefined 与"非对象"都要挡；数组会通过 typeof 检查，
  // 但下面按白名单取键时自然落空，不会写入任何语言。
  if (!releaseNotesByLocale || typeof releaseNotesByLocale !== "object") {
    // 结构不合法时整条 locale 说明作废：返回 undefined 让上层走主说明或返回 null，而不是带着半份数据持久化。
    return undefined;
  }

  // 白名单遍历而非 Object.keys：只发布两种语言的文案，遍历全部键会让远端新增的 locale 直接进入设置文件。
  for (const locale of ["zh-CN", "en-US"] as const) {
    // 只按白名单取值：键可能缺失或为 null，下面统一判空而不为可选字段写两套分支。
    const entry = releaseNotesByLocale[locale];
    // 该语言没有内容就 continue：缺失一种语言不影响另一种，整体仍可成立。
    if (!entry) {
      // continue 而不是 return：这里是逐语言累积，提前返回会丢掉后面语言的文案。
      continue;
    }

    // 两种输入形态共用一条归一链：字符串是纯正文，对象则带 markdown/releaseNotes 两种可能的正文键。
    const markdown =
      typeof entry === "string"
        // 字符串直接过清洗：它仍可能是空串或全空白，必须走同一个归一函数才能得到统一结果。
        ? normalizeReleaseNotesMarkdown(entry)
        // 对象优先取 markdown 再退回 releaseNotes：两者在新旧 manifest 中互为替代，
        // 顺序固定才能保证同一输入得到同一输出。
        : normalizeReleaseNotesMarkdown(entry.markdown ?? entry.releaseNotes);
    // 清洗后为空说明这条 locale 没有可用正文：跳过它，而不是写入一个空 markdown 占住该语言。
    if (!markdown) {
      // 同上：逐语言处理，空值只影响当前 locale 这一次迭代。
      continue;
    }

    // 只有正文成立才建条目：先判后建保证对象里不会出现 markdown 为空串的语言键。
    localized[locale] = {
      // 标题必填：渲染端按 title/markdown 直接渲染，缺标题会让弹窗头部为空。
      title:
        // 只有对象形态才可能有 title，且必须 trim 后非空：空标题等同于缺失，交给下面的推导分支。
        typeof entry === "object" && entry.title?.trim()
          // 用远端标题时也 trim：manifest 里常见的尾部空格会让弹窗标题右侧留下空隙。
          ? entry.title.trim()
          // 缺失标题从正文首标题推导，并用 version 兜底：保证任何情况下都有非空标题。
          : deriveReleaseNotesTitle(markdown, version),
      markdown,
    };
  }

  // 空对象归一成 undefined：与"字段缺失"保持同一种表示，避免持久化出 {} 让下游多一层判空。
  return Object.keys(localized).length > 0 ? localized : undefined;
}

// 类型谓词而非 boolean：调用方判真后可直接按对象访问字段，避免每处再写一次类型断言。
function isRecord(value: unknown): value is Record<string, unknown> {
  // 只排除 null：数组也会返回 true，这是有意的——错误对象与 manifest 片段都可能是数组形态，
  // 具体字段由调用方再校验：isRecord 只负责对象身份，不管内容。
  return value !== null && typeof value === "object";
}

// feed URL 可能包含内网域名与查询串凭据；日志只保留协议/host/path，
// 用户名、密码、query、fragment 全部抹掉，解析失败则整体替换为占位符。
function redactUpdateFeedUrlForLog(value: string): string {
  try {
    // 解析失败直接进 catch：非法 URL 不能靠字符串切割兜底，那会把凭据留在日志里。
    const url = new URL(value);
    // 用户名与密码必须清空：内网 feed 常把凭据写在 authority 段，只抹 query 不够。
    url.username = "";
    // 密码与用户名成对清空：只清一个会留下形如 user@host 的半脱敏结果。
    url.password = "";
    // 只有存在 query 才替换：无 query 时写 `?<redacted>` 会凭空造出一个不存在的查询串。
    if (url.search) {
      // 用固定占位替换整段 query：按参数名过滤容易漏掉新加的签名参数，整体替换才是安全的默认。
      url.search = "?<redacted>";
    }
    // fragment 也可能携带令牌：日志里保留它没有任何排障价值，直接清空。
    url.hash = "";
    // 用 URL 序列化而不是手工拼接：保证协议/host/path 的转义与规范化一致，日志中的地址可直接复现。
    return url.toString();
  } catch {
    // 解析失败整体替换为占位符：宁可丢失排查信息，也不把可能含凭据的原始字符串写进日志。
    return "<invalid-url>";
  }
}

// 与 readCommandLineSwitchValue 的区别：这里额外支持 `--name value` 形态（下一个参数
// 不以 -- 开头才取值），用于需要传 URL 这类含空格的启动参数。
function readSwitchValue(argv: readonly string[], switchName: string): string | undefined {
  // 先拼一次 equalsPrefix 而不是逐次拼接：循环里复用同一个字符串，也避免两种形态的判定条件写得不一样。
  const equalsPrefix = `${switchName}=`;
  // 用索引遍历而非 for..of：`--name value` 形态需要读到下一个参数，只有索引能安全地前看一位。
  for (let index = 0; index < argv.length; index += 1) {
    // 取出的元素可能是 undefined（稀疏数组或越界）：下面先判空再 startsWith，避免对 undefined 调方法抛错。
    const arg = argv[index];
    // 空参数直接跳过：启动参数里可能存在空串占位，继续匹配只会白跑一次 startsWith。
    if (!arg) {
      // continue 而不是 break：一次空值不能终止整轮扫描，后面的参数里仍可能有目标开关。
      continue;
    }
    // `--name=value` 形态优先判定：它是显式赋值，比裸 `--name` 更能确定用户意图。
    if (arg.startsWith(equalsPrefix)) {
      // 空值归一成 undefined：`--name=` 表示显式清空，返回空串会让调用方误以为拿到了有效配置。
      return arg.slice(equalsPrefix.length).trim() || undefined;
    }
    // 精确相等而不是 startsWith：`--name-x` 不应被当作 `--name`，否则短开关会吞掉长开关。
    if (arg === switchName) {
      // 取下一个参数作为候选值：只有 `--name value` 形态成立时才会用到，越界时为 undefined 由下一行判空。
      const next = argv[index + 1];
      // 下一个参数必须以非 `--` 开头才算值：否则它是另一个开关，取值会把后续选项当成 URL。
      if (next && !next.startsWith("--")) {
        // 同样把空值归一成 undefined：与 `--name=` 分支保持一致的空值语义。
        return next.trim() || undefined;
      }
      // 命中裸开关但没有值：显式返回 undefined 而不继续扫描，避免后面偶然出现的同名参数被误取。
      return undefined;
    }
  }
  // 扫完全部 argv 都没有目标开关：交给调用方走环境变量或内置默认值。
  return undefined;
}

// 启动参数优先于环境变量：命令行是用户显式指定，环境变量可能是父进程继承的默认值。
// 两者都未提供时返回 undefined，让 provider 走内置 manifest 地址。
// 信任边界（D-7-3，未修）：ZCODE_UPDATE_FEED_URL / --zcode-update-feed-url 不做协议与主机白名单，读到的任意字符串会原样进入 setFeedURL；
// 能改环境变量或启动参数的一方即可把更新源指向任意 manifest。
export function resolveUpdateFeedSourceFromStartupConfig(
  // argv 可注入而不是直读 process.argv：测试与主进程外的调用方需要构造确定的参数序列。
  options: {
    // env 同样可注入：它决定"命令行未指定时读哪个变量"，注入后本函数不再依赖进程全局状态。
    argv?: readonly string[];
    // 默认空对象：不传参时两个字段都为 undefined，下面各自回落到 process 上的真实值。
    env?: Record<string, string | undefined>;
  } = {},
): RuntimeUpdateFeedSource | undefined {
  // ?? 而不是 ||：显式传入空数组是合法输入（表示没有任何启动参数），|| 会把它替换成真实 argv。
  const argv = options.argv ?? process.argv;
  // 同上：空对象表示"没有任何环境变量"，不能回落到真实进程环境，否则测试会读到宿主机配置。
  const env = options.env ?? process.env;
  // 命令行优先于环境变量：命令行是用户本次显式指定，环境变量可能是父进程继承的默认值（见上方注释）。
  const feedUrl = readSwitchValue(argv, UPDATE_FEED_URL_SWITCH) ?? env[UPDATE_FEED_URL_ENV]?.trim();
  // 空值不构造对象：返回 undefined 让 applyManifestUpdateProvider 不写 manifestUrl，回落到内置服务地址。
  return feedUrl
    // 真值分支才构造对象：空串与 undefined 都走 else，保证"没有自定义源"只有 undefined 这一种表示。
    ? {
        // 只保留 url 一个字段：这里不做协议/主机白名单（D-7-3 未修），因此不能顺便做半套校验而造成"看起来安全"的错觉。
        url: feedUrl,
      }
    // 三元的另一半：没有配置时显式 undefined，调用方据此区分"未配置"与"配置为空串"。
    : undefined;
}

// [失败路径] 读设置失败按 stable 处理而不是抛错：更新检查不应因为一次设置读取异常
// 而整体不可用；stable 是默认渠道，误用的代价最小。
async function resolveUpdateReleaseChannel(
  // 允许 undefined：调用方可能在装配完成前就触发检查，本函数必须给出确定渠道而不是抛错。
  settingService: SettingServiceLike | undefined,
): Promise<ElectronReleaseChannel> {
  // 无配置服务即"用户未表达偏好"：stable 是默认渠道，不需要再读盘。
  if (!settingService) {
    // 直接返回 stable 而不是 undefined：渠道是窄联合类型，调用方不应承担空值分支。
    return "stable";
  }

  try {
    // 每次检查前重读：用户可能在两次轮询之间切换 preview 开关（见下方函数的注释）。
    const settings = await settingService.get();
    // 只认严格 true：旧配置可能写成字符串，宽松比较会把"未设置"误判成开启预览。
    return settings.receivePreviewUpdates === true ? "preview" : "stable";
  } catch (error) {
    // 读失败降级为 stable：更新检查不能因为一次设置读取异常整体不可用，stable 误用代价最小（见函数头注释）。
    logger.warn("[auto-update] read preview update setting failed:", error);
    // 与无配置服务分支同向：所有异常都收敛到默认渠道，保证调用方永远拿到确定值。
    return "stable";
  }
}

// 每次检查开始前都要重读设置：用户可能在两次轮询之间切换 preview 开关。
// await 之后必须重新校验世代与安装锁——期间可能已经开始了新一轮检查或进入安装，
// 此时写 availableUpdateChannel 会污染新一轮的 expected channel。
async function syncAutoUpdateCheckChannelFromSettings(
  // 传入 checkId 而不是从全局读：await 期间全局 activeAutoUpdateCheckId 可能已被新一轮改写，
  // 只有调用方手里的那个值能证明"我这次检查仍然有效"（INV-3）。
  checkId: number,
  // 允许 undefined：设置服务未装配时 resolveUpdateReleaseChannel 会退回 stable，
  // 检查流程不能因为缺配置而整条中断。
  settingService: SettingServiceLike | undefined,
  // reason 只用于日志：它把"启动检查/失败重查/轮询"三种触发来源与本行的渠道切换对起来。
  reason: string,
): Promise<void> {
  // await 之前不读任何全局状态：读设置是异步的，提前快照会拿到过期的渠道（见下方二次校验）。
  const nextChannel = await resolveUpdateReleaseChannel(settingService);
  // [并发] await 之后必须重新校验：期间可能已进入安装或开始了新一轮检查，
  // 此时写渠道会污染新一轮的 expected channel（INV-2/INV-3）。
  if (isUpdateTargetLocked() || activeAutoUpdateCheckId !== checkId) {
    // 静默放弃写入：本次检查已失去写入资格，但它仍会正常收口，不需要在这里清理。
    return;
  }

  // 只在真正变化时记日志：轮询每两分钟一次，无变化也记会让日志失去可读性。
  if (availableUpdateChannel !== nextChannel) {
    // 日志同时带旧值与新值：排查"preview 用户拿到 stable 清单"时，需要确认这一步是否真的切过渠道。
    logger.info(
      `[auto-update] ${reason}: check channel ${availableUpdateChannel} -> ${nextChannel}`,
    );
  }
  // 服务端 manifest provider 会在 checkForUpdates 内部读取 preview 设置。
  // 如果 begin 阶段仍用默认 stable 作为 expected channel，冷启动 preview 结果会被误判为 stale。
  availableUpdateChannel = nextChannel;
  // expected channel 必须与 available 同步写入：stale 判定只比对 activeAutoUpdateCheckChannel，
  // 漏写这一行会让本次结果按旧渠道判成 stale（INV-14）。
  activeAutoUpdateCheckChannel = nextChannel;
}

// 自定义 provider 是 Main 与远端 manifest 之间的唯一适配层：endpointOrigin、
// applyManifestUpdateProvider 在这里注入平台标识与 deviceMid，所以环境细节不会散落到状态机。
// resolveReleaseChannel 必须与 Main 的 expected channel 同源，否则首批结果会被判 stale。
// 安装锁期间不允许它改写 availableUpdateChannel，否则恢复分支会拿到错误渠道。
function applyManifestUpdateProvider(options: InitAutoUpdaterOptions): void {
  // trim 后再判空：启动参数可能带尾部空格，未清洗会让 setFeedURL 收到非法 URL，并在首次检查时才报错。
  const manifestUrl = options.updateFeedSource?.url.trim();
  // 全量替换 feed 配置而不是逐字段设置：provider/updateProvider 必须成套生效，
  // 分开设置会在中间态留下"自定义 provider 却仍指向默认地址"的组合。
  autoUpdater.setFeedURL({
    // 必须是 custom：electron-updater 只在这个 provider 下才使用 updateProvider 字段，
    // 写成 generic 会静默忽略 ManifestUpdateProvider，回落到默认下载逻辑。
    provider: "custom",
    // 注入的是类而不是实例：electron-updater 每次检查自行实例化，Main 无法也不应持有其生命周期。
    updateProvider: ManifestUpdateProvider,
    // 默认端点作为构建期常量传入：运行期只允许 resolveEndpointOrigin 覆盖，避免出现两个来源不一致。
    endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    ...(manifestUrl ? { manifestUrl } : {}),
    // 平台标识在这里就固定：manifest 选择哪个平台的包由它决定，
    // 放到 provider 内部再算会让同一进程出现两种判定。
    releasePlatform: getElectronReleasePlatform(),
    // deviceMid 允许为空：灰度与统计用它区分设备，但缺失不应阻止更新检查（服务端按匿名处理）。
    deviceMid: options.deviceMid,
    // 以函数形式注入而非字符串：端点可能在运行期变化（切换环境），字符串会把它固化成装配时的值。
    resolveEndpointOrigin:
      // 兜底读环境变量：主进程未显式注入时仍要能解析端点，否则 setFeedURL 会因缺少 origin 直接抛错。
      options.resolveEndpointOrigin ?? (() => resolveRuntimeZCodeEndpointOrigin(process.env)),
    // 渠道解析必须与 Main 的 expected channel 同源：provider 内部读到的渠道与状态机不一致，
    // 首批结果就会被判成 stale（INV-14）。
    resolveReleaseChannel: async () => {
      // 复用同一个解析函数而不是重写一遍：两处若对"未配置"的缺省判断不同，冷启动就会走错渠道。
      const channel = await resolveUpdateReleaseChannel(options.settingService);
      // 安装锁期间不回写：此时 ready 包的渠道是历史事实，改写会让恢复分支按新渠道解释旧包。
      if (!isUpdateTargetLocked()) availableUpdateChannel = channel;
      // 回传解析结果给 provider：它要按这个渠道选 manifest，而 Main 侧只在未锁定时才回写模块记录。
      return channel;
    },
  });
  // provider 生效后立刻落日志：这是"更新源到底指向哪里"的唯一启动期证据。
  logger.info(
    manifestUrl
      // 自定义 feed 必须经 redact：URL 的 query 里可能带签名或内网凭据，原样记日志等于把凭据写进日志文件。
      ? `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()} manifestUrl=${redactUpdateFeedUrlForLog(manifestUrl)}`
      // 无自定义 feed 时只记平台：此时地址来自内置 manifest，多余字段只会掩盖真正的配置来源。
      : `[auto-update] service manifest provider applied platform=${getElectronReleasePlatform()}`,
  );
}

// 回退顺序：当前菜单语言 -> zh-CN -> en-US。只在主 releaseNotes 缺失时使用，
// pickFallbackReleaseNotesMarkdown 的目的是让弹窗至少有一种可读文案，而不是空正文。
function pickFallbackReleaseNotesMarkdown(
  // 允许 undefined：payload 的该字段本身可选，兜底函数必须能直接消费归一化结果而不额外判空。
  localized: PostUpdateReleaseNotesPayload["releaseNotesByLocale"] | undefined,
): string | null {
  // 三级 ?? 链的顺序就是产品优先级：当前语言优先保证一致性，zh-CN 次之，en-US 兜底。
  return (
    localized?.[menuLocale]?.markdown ??
    // zh-CN 排在 en-US 之前：产品的主要用户群决定缺省语言，顺序颠倒会让中文用户看到英文说明。
    localized?.["zh-CN"]?.markdown ??
    // en-US 是最后一级：它最可能存在于所有发布物中，作为兜底几乎不会为空。
    localized?.["en-US"]?.markdown ??
    // 全部缺失返回 null 而不是空串：调用方用 !markdown 判断，两者同效但 null 语义更明确。
    null
  );
}

// 日期可能来自 Date 或字符串；非法 Date 直接丢弃，避免 toISOString 抛 RangeError。
function normalizeReleaseDate(
  // 入参声明为 string | Date | null：归一化必须同时处理两种运行时形态，不能假设只来字符串。
  releaseDate: UpdateDownloadedInfoLike["releaseDate"],
): string | undefined {
  // 先判 Date 再判非法值：Invalid Date 调 toISOString 会抛 RangeError，必须先过 getTime 检查。
  if (releaseDate instanceof Date && !Number.isNaN(releaseDate.getTime())) {
    // 统一写成 ISO 字符串：持久化层只接受可 JSON 化的值，直接存 Date 读回时会变成字符串，类型不一致。
    return releaseDate.toISOString();
  }
  // 非字符串非 Date 一律丢弃：远端可能下发数字时间戳，误当字符串会让渲染端显示一串数字。
  if (typeof releaseDate !== "string") {
    // 只丢弃 releaseDate 这一个字段而不是整条载荷：发布日期缺失不影响说明展示。
    return undefined;
  }
  // 清洗空白：manifest 里的空字符串会被原样持久化，渲染端需要额外判空才能避免显示空行。
  const trimmed = releaseDate.trim();
  // 空串归一成 undefined：保证"有值"与"无值"在载荷里只有一种表示，避免下游出现两种空判断。
  return trimmed.length > 0 ? trimmed : undefined;
}

// 归一为可持久化的最小载荷：主 markdown 缺失时用 locale 回退，两者都没有则返回 null，
// 调用方据此决定"清空 pending"而不是写入一个空说明。
// releaseDate 与 localized 都是可选字段，缺省时不写键，保证旧版本读到的 JSON 不变。
function toPostUpdateReleaseNotesPayload(
  // 入参是运行时结构而非已校验类型：所有字段都必须当作可能缺失，归一化只在本函数内完成（见 UpdateDownloadedInfoLike 声明）。
  info: UpdateDownloadedInfoLike,
): PostUpdateReleaseNotesPayload | null {
  // 先归一 locale 说明再归一主说明：主说明缺失时要靠它兜底，顺序颠倒会让兜底拿到未清洗的原始结构。
  const releaseNotesByLocale = normalizeLocalizedReleaseNotes(
    info.version,
    info.releaseNotesByLocale,
  );
  // 主说明优先、locale 兜底：两条来源都能形成完整正文，只取其一会让部分 feed 得到空载荷（INV-16）。
  const markdown =
    normalizeReleaseNotesMarkdown(info.releaseNotes) ??
    // 先按 menuLocale、zh-CN、en-US 三级取兜底：用户切到未发布文案的语言时仍能拿到可读内容。
    pickFallbackReleaseNotesMarkdown(releaseNotesByLocale);
  // 两种来源都为空说明这个包没有任何可展示说明：返回 null 让调用方清空 pending，而不是写一条空说明（INV-16）。
  if (!markdown) {
    // null 与"空对象载荷"语义不同：前者触发 clearPendingPostUpdateReleaseNotes，后者会在安装后弹一个空白弹窗。
    return null;
  }

  // 标题优先用 releaseName，缺失时从正文首标题推导：渲染端不再判空，弹窗一定有标题（与 locale 归一约定同源）。
  const title = info.releaseName?.trim() || deriveReleaseNotesTitle(markdown, info.version);
  // 日期归一与标题分离：releaseDate 是可选项，非法值只丢这一个字段，而不会影响整条载荷成立。
  const releaseDate = normalizeReleaseDate(info.releaseDate);
  // 只回传可持久化的最小字段集：info 里还有 path/files/packages 等本地路径信息，写进设置既无用又会暴露安装位置。
  return {
    // version 是整条载荷的幂等键（ack 与跳过都按它比对），必须原样取自下载结果，不能在归一化里改写（INV-16）。
    version: info.version,
    title,
    markdown,
    ...(releaseDate ? { releaseDate } : {}),
    ...(releaseNotesByLocale ? { releaseNotesByLocale } : {}),
  };
}

// 幂等键是 version：acknowledgedPostUpdateReleaseNotesVersions 命中的版本不再写回，否则下一次下载完成会让"安装后说明"重新出现在已确认过的用户面前。
// 该集合只在进程内存、重启即失效：落盘失败时磁盘上仍有 pending，下次启动 hydratePendingPostUpdateReleaseNotes 会重新投递（D-7-2，未修）。
// 写盘成功后才更新内存并清空投递窗口，保证内存状态不会领先于持久化事实。
async function persistPendingPostUpdateReleaseNotes(
  // settingService 是必填参数：写入方一定是已装配的调用点，缺失属于编程错误而非运行时降级。
  settingService: SettingServiceLike,
  // 写入的是已归一载荷：本函数不再做字段校验，避免两处判空逻辑分叉导致磁盘与内存载荷不一致（INV-16）。
  payload: PostUpdateReleaseNotesPayload,
  // reason 只进日志不进载荷：它是"谁触发了这次写入"的排查线索，不属于要持久化的产品事实。
  reason: string,
) {
  // 已 ack 的版本不再写回：否则下一次下载完成会把用户确认过的安装后说明重新弹一遍（INV-16）。
  if (acknowledgedPostUpdateReleaseNotesVersions.has(payload.version)) {
    // 跳过写入也记日志：这条 reason 记录能解释"为什么某个版本的说明在设置里不存在"。
    logger.info(
      `[auto-update] skip persisting acknowledged post-update release notes (${reason}) version=${payload.version}`,
    );
    // 返回前不写内存：内存与磁盘必须保持一致，单写内存会让本次进程内又出现一份已 ack 的说明。
    return;
  }

  // 先落盘再更新内存：顺序颠倒会在写失败时留下"内存说有、磁盘说没有"的分叉（见函数头注释）。
  await settingService.update({ pendingPostUpdateReleaseNotes: payload });
  // 写盘成功后才更新内存：此后窗口就绪流程读到的就是磁盘上那份载荷，两者同源（INV-16）。
  pendingPostUpdateReleaseNotes = payload;
  // 新说明意味着投递对象要重算：不清会让新版本说明被误判为"已投递给某窗口"而永远不展示（INV-16）。
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  // 成功日志带 reason 与 version：这是"设置文件里为什么出现这条说明"的唯一线索。
  logger.info(
    `[auto-update] persisted post-update release notes (${reason}) version=${payload.version}`,
  );
}

/**
 * 待展示说明里的 version 来自「已下载的安装包」；当前进程版本在安装完成前仍可能是旧版，
 * 此时待展示版本高于当前运行版本属于正常中间态，不能丢弃。
 * 若用户跳过自动更新链路（官网安装包等）直接升到更高版本，磁盘里可能仍残留更早一次下载写入的 pending，
 * 此时待展示版本低于已安装版本，应在启动时丢弃，否则会弹出旧版更新说明。
 */
// 判定规则刻意只处理"能解析且更旧"的情况：解析失败或相等都保留，
// 因为 pending 可能来自一个尚未安装的更高版本，丢弃会让用户看不到升级说明。
// 启动时的丢弃由 hydrate 统一执行，避免这里产生"读时删除"的副作用。
function shouldDiscardStalePendingReleaseNotes(
  // 形参是磁盘上的待展示版本，不是当前 ready 版本：判定必须在读盘后立刻做，晚一步就可能被新下载覆盖（INV-16）。
  pendingVersion: string,
  // 当前 app 版本单独传入而非在函数内取：只有 hydrate 的调用点才知道此刻运行的是哪个版本（dev 覆盖版可能不同）。
  appVersion: string,
): boolean {
  // trim 后比较：setting 里的旧值可能带空白，未 trim 会让相等判断失效而误判为"更旧"（INV-17）。
  const pending = pendingVersion.trim();
  // 两侧同样 trim：语义对称，避免只有一侧清洗导致 3.3.2 与 " 3.3.2 " 被判成不同版本。
  const current = appVersion.trim();
  // 相等即"已安装但尚未投递"：这是正常的待展示中间态，丢弃会让用户永远看不到升级说明（INV-16）。
  if (pending === current) {
    // false = 保留：相等分支必须早于 semver 比较，因为 coerce 可能把两者归一成同一个值而丢失"相等"这一事实。
    return false;
  }

  // 用 coerce 而非 parse：manifest 里的版本可能带前缀或后缀，coerce 能取出主体版本，避免把可比较的值判成不可解析。
  const pendingCoerced = semver.valid(semver.coerce(pending));
  // 两侧必须用同一种归一方式：一边 parse 一边 coerce 会产生不可比的组合，比较结果无意义（INV-17）。
  const appCoerced = semver.valid(semver.coerce(current));
  // 任一解析失败即保留 pending：无法证明它过期时，宁可多弹一次说明，也不能丢掉用户的升级内容（INV-17）。
  if (!pendingCoerced || !appCoerced) {
    // 保留而非丢弃：与上面的相等分支同向，保证所有"不确定"都落到不删除。
    return false;
  }

  // 只有严格更旧才丢弃：等于已在上方返回，更高属于"下载完成未安装"的正常中间态（INV-16）。
  return semver.lt(pendingCoerced, appCoerced);
}

// "未来版本"意味着下载完成但尚未安装：此时说明书不能投递，否则 renderer 会在
// 旧版本上弹出新版本的更新说明并立即 ack，安装后反而看不到。
function isPendingReleaseNotesForFutureVersion(payload: PostUpdateReleaseNotesPayload): boolean {
  // 未来版本判定统一走 isVersionGreaterThan：投递侧与丢弃侧必须用同一套比较，否则会出现"该留的被清、该清的被投"（INV-17）。
  return isVersionGreaterThan(payload.version, getCurrentAppVersionForUpdate());
}

// 只在"未打包 + 显式开启 dev 更新 + macOS"三条同时成立时才识别该错误：
// 生产包遇到同样的 SQRLUpdaterErrorDomain code=2 必须按真实失败清理 ready，
// 否则用户会一直看到一个永远装不上的更新。
function isDevSquirrelReadyError(error: unknown): boolean {
  // isDevSquirrelReadyError 的三个条件必须同时成立：未打包、显式开启 dev 更新、macOS，生产包即使遇到同码错误也按真实失败处理（INV-4）。
  if (
    app.isPackaged ||
    !isDevAutoUpdateEnabled() ||
    process.platform !== "darwin" ||
    !isRecord(error)
  ) {
    // 非开发态一律不认这个错误：把真实 staging 失败当成误报会让界面长期停留在"重启以更新"。
    return false;
  }

  // 只认 domain + code 这一组精确特征：message 文案随 Squirrel 版本变化，按文案匹配会在依赖升级后失效。
  return error.domain === "SQRLUpdaterErrorDomain" && error.code === 2;
}

// 没有 pending 时不写盘：设置服务每次 update 都可能触发磁盘与广播，
// 无条件清空会让启动路径产生无意义的写放大。
async function clearPendingPostUpdateReleaseNotes(
  // 必填：调用方都是已注入设置服务的路径（发布下载、hydrate 丢弃），缺失说明装配有误。
  settingService: SettingServiceLike,
  // reason 进日志，用于区分"安装后 ack""版本过期""失败回退"三类清理来源。
  reason: string,
) {
  // 没有 pending 时不写盘：设置服务每次 update 都可能触发磁盘写与广播，无条件清空会造成写放大。
  if (!pendingPostUpdateReleaseNotes) {
    // 直接返回：此时内存与磁盘都是空的，任何写入都只是多一次无意义的 I/O。
    return;
  }

  // 先取版本号再清：update 之后内存字段会被置空，日志与持久化清理都需要这个快照值（INV-16）。
  const version = pendingPostUpdateReleaseNotes.version;
  // 写 undefined 表示删除该键，而不是写 null：JSON 序列化会丢弃 undefined 键，
  // 写 null 会在磁盘上留下一个需要额外判空的空值（INV-16）。
  await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
  // 内存先于磁盘清空：后续投递与幂等判断都以内存为准，等 await 完成再清会让并发的窗口就绪流程读到旧说明（INV-16）。
  pendingPostUpdateReleaseNotes = null;
  // 说明被清后投递记录也失去意义：不清会让下一个窗口被误判为"已投递过"，同一版本再也弹不出来（INV-16）。
  deliveredPostUpdateReleaseNotesWebContentsId = null;
  // 日志带上 reason 与 version：清理有安装后 ack、版本过期、失败回退等来源，没有 reason 就不能归因。
  logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
}

// [并发] manualCheckWebContentsId 是单槽：先取值再立刻清空，保证同一结果只投递一次。
// 窗口可能在检查期间被关闭，findLiveWindowByWebContentsId 返回 null 时只记日志，
// 不能抛错——此时状态机已经收敛，投递失败不应回滚状态。
function sendManualCheckResult(payload: UpdateCheckResultPayload) {
  // 先快照再清空：清空后并发到达的第二次结果会因单槽为空而自然丢弃，这就是"只投递一次"的实现（INV-15）。
  const webContentsId = manualCheckWebContentsId;
  // 没有发起过手动检查时静默返回：自动检查与强更也会产生结果，但它们不经过这条单槽通道。
  if (webContentsId == null) return;
  // 在查找窗口之前清空：窗口查找与 send 都可能抛错，放在后面会让单槽残留，下一次结果被投给旧窗口（INV-15）。
  manualCheckWebContentsId = null;

  // 用存活的窗口而不是 id 直接 send：检查期间窗口可能已关闭或重载，webContents 已被销毁（INV-15）。
  const win = findLiveWindowByWebContentsId(webContentsId);
  // 找不到窗口是正常竞态而非错误：状态机已收敛，投递失败不能回滚已经写入的状态（INV-15）。
  if (!win) {
    // 记录被丢弃的 webContentsId：用户报"检查没反应"时，需要确认结果是不是打给了一个已关闭的窗口。
    logger.info(
      `[auto-update] manual check result dropped, target webContents ${webContentsId} gone`,
    );
    // 丢弃结果但不改状态：菜单与窗口状态已由 setAutoUpdaterMenuState 写入，这里只负责投递。
    return;
  }
  // 成功投递也留日志：手动检查是低频且用户可感知的动作，日志能与用户描述的 webContentsId 时间点对齐。
  logger.info(`[auto-update] manual check result → wc=${webContentsId}: ${payload.kind}`);
  // 结果走独立通道而非状态广播：它带的是"这一次检查的结局"，与 menuState 的当前事实不是一回事（INV-15）。
  win.webContents.send(PlatformChannels.UpdateCheckResult, payload);
}

// 三个 clear 函数是状态回退的唯一出口：分别对应"远端候选""下载中""已就绪"三段事实。
// 任何分支清空时都必须成组调用，单独清一个字段会让构造器读到跨阶段的残留值。
function clearAvailableUpdateState() {
  // 只清说明不清版本：available 的版本由 menuState 承载，字段级清理必须与其他 clear 函数保持同一粒度（INV-12）。
  availableUpdateReleaseNotes = null;
}

// 下载态三件套必须整体清空：version 决定下的是哪个包，说明与渠道决定回退后如何重试（INV-12）。
function clearDownloadingUpdateState() {
  // 版本置空是"当前无下载"的判据之一：handleAutoUpdateFailure 用它区分下载失败与检查失败（INV-5）。
  downloadingUpdateVersion = null;
  // 说明随版本一起清：残留的说明会被下一次失败回退挂到另一个版本上，弹窗显示错版本内容。
  downloadingUpdateReleaseNotes = null;
  // 渠道随版本一起清：它是下载时锁定的值，留着会让下一次下载误用上一次的渠道（INV-12）。
  downloadingUpdateChannel = null;
}

// ready 三件套 + restored 标记是一个整体：少清一项都会让"伪 ready"逃过安装前的重新下载校验（INV-4/INV-7）。
function clearReadyUpdateState() {
  // 版本是 ready 的唯一身份：它为空时所有安装入口都必须判定为"没有可装包"（INV-7）。
  readyUpdateVersion = null;
  // 说明必须与版本同步清空：否则下一个版本就绪时会沿用上一个版本的说明（INV-16）。
  readyUpdateReleaseNotes = null;
  // 渠道不能跨版本复用：它决定安装后回查更新时打哪个 manifest，错渠道会让用户升级后看到版本倒退。
  readyUpdateChannel = null;
  // 复位 restored 标记：它只在"从磁盘恢复"这条路径上为 true，漏复位会让真实下载被当成伪 ready 再下一次包（INV-4/INV-7）。
  readyUpdateRestoredFromPendingReleaseNotes = false;
}

// [资源] clearPersistedPostUpdateReleaseNotesForVersion 做的是"内存立即可见、磁盘异步对齐"：先清 pending 与投递槽，
// 再异步读 settingService 确认 version 仍匹配后删除；不匹配说明用户已经装了新版本，
// 此时删除会把新版本的说明误删，因此必须二次校验。
function clearPersistedPostUpdateReleaseNotesForVersion(version: string, reason: string) {
  // 只有版本匹配才清内存：不匹配说明磁盘上的说明已属于更新版本，清掉会把新版本的说明误删（INV-16）。
  if (pendingPostUpdateReleaseNotes?.version === version) {
    // 内存先清让界面立刻停止展示：磁盘写是异步的，用户不该等一次 I/O 才看到入口消失（INV-16）。
    pendingPostUpdateReleaseNotes = null;
    // 投递槽一起复位：说明已作废，保留投递记录只会阻止同一版本在新窗口上再次展示（INV-16）。
    deliveredPostUpdateReleaseNotesWebContentsId = null;
  }

  // 取模块级引用而不是新增参数：本函数由失败回退等多处调用，统一从注入点读可避免各处传参不一致。
  const settingService = autoUpdaterSettingService;
  // autoUpdaterSettingService 未注入时只做内存清理：磁盘无从下手，但界面语义已经成立，不能因此抛错。
  if (!settingService) {
    // 静默返回：装配未完成的早期路径会频繁走到这里，记日志会掩盖真正的清理失败。
    return;
  }

  // 立即执行的异步函数 + void：本函数签名是同步的（调用方在失败路径上不能 await），
  // 磁盘对齐必须放到后台，错误在内部捕获。
  void (async () => {
    try {
      // 写前重新读盘做二次校验：内存比较发生在调用瞬间，而 await 期间可能已经安装了新版本（INV-16）。
      const settings = await settingService.get();
      // 磁盘版本已变则放弃删除：这是"内存立即可见、磁盘异步对齐"里唯一能防止误删新版本说明的闸（INV-16）。
      if (settings.pendingPostUpdateReleaseNotes?.version !== version) {
        // 放弃删除但不回写内存：内存里的 pending 已被调用方清掉，此处再改会把状态改回去。
        return;
      }

      // 与 clearPendingPostUpdateReleaseNotes 用同一种清空写法：两条路径必须产生同样的磁盘结果，否则幂等性不成立（INV-16）。
      await settingService.update({ pendingPostUpdateReleaseNotes: undefined });
      // 磁盘清理成功也记日志：它与内存清理是两次独立动作，只有这条能证明下次启动不会再恢复该说明。
      logger.info(`[auto-update] cleared post-update release notes (${reason}) version=${version}`);
    } catch (error) {
      // 磁盘清理失败降级为 warn：内存已清，本轮语义正确；但下次启动会恢复该说明，需要被人看到。
      logger.warn(`[auto-update] clear post-update release notes (${reason}) failed:`, error);
    }
  })();
}

// 两条判据缺一不可：WeakSet 记录"我们主动取消过这个 token"，覆盖 updater 抛出的
// 错误文案与 "cancelled" 不一致的实现；token.cancelled 覆盖取消与错误同时到达的时序。
// 只认 error.message 会在依赖升级改文案后把取消当成真实失败。
function isCancelledDownload(cancellationToken: CancellationToken, error: unknown): boolean {
  // 两条判据是或关系而非与：任一条成立都说明这是取消，任一缺失都会把取消误判成真实失败（INV-10/INV-11）。
  return (
    cancelledDownloadTokens.has(cancellationToken) ||
    (cancellationToken.cancelled && isDownloadCancellationError(error))
  );
}

// electron-updater 取消时固定抛出 message 为 "cancelled" 的 Error，这是唯一可用的协议特征。
function isDownloadCancellationError(error: unknown): boolean {
  // 只认精确文案 "cancelled"：这是 electron-updater 唯一的协议特征，宽松匹配会把真实错误吞掉（INV-11）。
  return error instanceof Error && error.message === "cancelled";
}

// [并发] 先记账再取消：若先 cancel 再 add，取消引发的同步 error 可能在记账前到达，
// 配额为 0 导致错误被当作真实失败，状态被打回 idle。
// 配额只增不减地等待对应错误消耗，是为了容忍"取消后 hook 再抛一次错误"的实现差异。
function markCancelledDownload(cancellationToken: CancellationToken) {
  // 先记账：WeakSet 用对象身份而非内容，token 被 GC 后自动出表，不会为每次下载保留强引用（INV-10）。
  cancelledDownloadTokens.add(cancellationToken);
  // 配额与 token 同时记录：WeakSet 回答"这个 token 取消过"，配额回答"还有几条取消错误待吞"（INV-11）。
  pendingCancelledDownloadErrorCount += 1;
}

// [失败路径] 配额 > 0 且错误语义匹配时才吞：真实失败不会带 "cancelled" 文案，
// 因此不会被误吞；配额用尽后到达的 cancelled 说明它不是本次取消引起的，按真实失败处理。
function shouldIgnoreCancelledDownloadError(error: unknown): boolean {
  // 配额先判再判语义：配额为 0 时连文案匹配都不做，避免把"恰好也叫 cancelled"的真实错误消耗掉（INV-11）。
  if (pendingCancelledDownloadErrorCount <= 0 || !isDownloadCancellationError(error)) {
    // false 表示按真实失败处理：这是安全方向，宁可多报一次错误，也不要让下载失败被静默吞掉。
    return false;
  }

  // 每条匹配错误只消耗一份配额：配额用尽后到达的 cancelled 说明不是本次取消引起，按真实失败处理（INV-11）。
  pendingCancelledDownloadErrorCount -= 1;
  // 只有两条判据同时成立才返回 true：调用方据此跳过状态回退，因此这里不能放宽。
  return true;
}

// 所有失败路径的唯一收敛点：它必须能处理 check/download/install 三类来源，
// 且不能假设 menuState 停在某个固定阶段。
// 先判 recovering 再判安装锁：recovering 是终态，任何后续错误都只应被忽略，
// 否则一次原生错误会触发多次 relaunch。
function handleAutoUpdateFailure(error: unknown, source: string) {
  // quitAndInstallState 为 recovering 时是终态：安装失败后已经 relaunch，此刻任何错误都必须忽略，
  // 继续处理会再触发一次 relaunch，形成重启循环（INV-8）。
  if (quitAndInstallState === "recovering") return;
  // 安装已受理后的 check 失败可以安全丢弃：用户已在退出路径上，任何状态写入都会被安装器覆盖（INV-7/INV-8）。
  if (isUpdateTargetLocked() && source.endsWith("check failed")) {
    // 记 info 留下"迟到失败"的痕迹：排查重启循环时需要确认这条错误是被有意忽略，而不是被漏处理。
    logger.info("[auto-update] ignore late check failure after install admission");
    // 返回前不改任何状态：此刻 ready 仍应保持，安装器还要靠它找到包（INV-7）。
    return;
  }
  // [事务] 失败前先快照"失败发生在哪个阶段"：调用过程中 menuState 会被改写，
  // 事后再读就拿不到原始下载版本，回退分支会丢失版本与说明。
  // failedDownload 有两套来源：下载态字段，或"有 token 但状态已被提前改写"的中间态。
  const failedInstall = quitAndInstallState === "installing";
  // 错误可能是字符串、对象或 undefined（经事件回调与 IPC 后类型会漂移）：统一收敛成 message，
  // 后续日志与强更弹窗都只依赖这个字符串。
  const message = error instanceof Error ? error.message : String(error);
  // 在改写状态前快照"失败发生在哪个阶段"：下面的回退与归因都依赖这份快照，
  // 事后读 menuState 已经拿不到原始下载版本（INV-9）。
  const failedDownload =
    menuState.kind === "download-progress"
      // 第一套来源：状态仍是 download-progress 时，必须先让状态与 downloading 字段互相兜底，
      // 保证某一侧被提前清空也能还原目标版本（INV-12）。
      ? {
          // downloading 字段优先于 menuState：前者是下载真正锁定的版本，后者可能已被新一次检查覆盖（INV-12）。
          version: downloadingUpdateVersion ?? menuState.version,
          // 说明允许一路兜底到 null：缺失说明不应阻止失败回退，弹窗可以只显示版本（INV-9）。
          releaseNotes: downloadingUpdateReleaseNotes ?? menuState.releaseNotes ?? null,
          // 渠道最后回落到 available：重试下载必须打在同一个 manifest 通道上，否则会取到另一渠道的包。
          channel: downloadingUpdateChannel ?? menuState.channel ?? availableUpdateChannel,
        }
      // 第二套来源：状态已被提前改写（例如失败先于事件到达）但 token 还在，说明确实有一次下载未收口（INV-5）。
      : downloadCancellationToken && downloadingUpdateVersion
        // downloadCancellationToken 在即证明下载链仍活着，必须用它认领这次失败，避免把"下载失败"误判成"检查失败"。
        ? {
            // 此处不再从 menuState 兜底：状态已被改写，menuState 的版本不一定是这次下载的目标（INV-12）。
            version: downloadingUpdateVersion,
            // 说明只认下载时锁定的 downloadingUpdateReleaseNotes：提前改写的状态可能已把说明换成新一次检查的结果。
            releaseNotes: downloadingUpdateReleaseNotes ?? null,
            // 渠道回落只到 available 层：下载通道缺失说明还在沿用最后一轮检查的渠道。
            channel: downloadingUpdateChannel ?? availableUpdateChannel,
          }
        // 两套来源都不成立说明这次失败与下载无关（检查/安装错误），后续回退不得改写 available 三元组。
        : null;
  // 开发态 Squirrel 的 code=2 是已知误报：只有"已就绪 + 有 ready 版本 + 开发态"三者同时成立才放行（INV-4）。
  if (
    menuState.kind === "update-downloaded" &&
    readyUpdateVersion &&
    isDevSquirrelReadyError(error)
  ) {
    // 开发态验证真实测试环境 manifest 时，macOS Squirrel 仍可能在
    // update-downloaded 后补一个 code=2 staging 错误。生产包必须清掉失败的 ready，
    // 但开发态需要保留 ready 状态来验证“重启以更新”交互闭环。
    logger.warn(
      `[auto-update] ignore dev Squirrel ready error after ${source} version=${readyUpdateVersion}: ${message}`,
    );
    // 重新写一次 ready 状态以抵消前面的错误路径：开发态需要保留"重启以更新"入口做闭环验证（INV-4）。
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    // 直接返回，跳过下面的清 ready 流程：这是"保留 ready"与"销毁 ready"两条互斥分支的分界。
    return;
  }

  // logger.error 必须放在分支判定之前：无论走哪条收敛路径，都要留下原始错误，
  // 否则"静默恢复"会让线上问题无法归因。
  // 检查失败但用户已经能看到目标（hasVisibleUpdateTarget）时只反馈错误、不清目标，否则一次网络抖动会把已发现的版本从 UI 上抹掉。
  logger.error(`[auto-update] ${source}:`, error);
  // 检查失败但界面已有可见目标时只反馈错误：一次网络抖动不该把已发现的版本从界面上抹掉（INV-9）。
  if (
    source.endsWith("check failed") &&
    hasVisibleUpdateTarget(menuState) &&
    !activeForceAutoUpdateListener
  ) {
    // 强更弹窗必须收到错误：它没有轮询通道，缺这条消息会停在 checking 直到用户手动关闭。
    notifyForceAutoUpdate({ kind: "error", message });
    // 手动检查的发起方是单个窗口：结果必须回到那个窗口，否则用户看不到自己这次检查的失败原因（INV-15）。
    sendManualCheckResult({ kind: "error", message });
    // 返回前不清目标：保留 available/ready 让用户直接重试，而不是重新走一次完整检查（INV-9）。
    return;
  }
  // [失败路径] macOS Squirrel 可能在 update-downloaded 之后才发现包无法 stage。
  // 若继续保留 ready，renderer 会一直显示"重启以更新"，而每次点击都失败；
  // 因此必须同时清内存 ready 与持久化的待展示说明，让入口回到可重试状态。
  if (menuState.kind === "update-downloaded" && readyUpdateVersion) {
    // 在清空之前快照版本号：clearReadyUpdateState 会把它置 null，而持久化清理必须按版本匹配（INV-16）。
    const failedReadyVersion = readyUpdateVersion;
    // macOS Squirrel 可能在 update-downloaded 后才发现包无法 stage。
    // 如果继续保留 ready 缓存，renderer 会一直展示“重启以更新”，再次点击只会调用一个已失败的安装上下文。
    clearReadyUpdateState();
    // 内存 ready 与磁盘 pending 必须一起清：只清一侧会让下次启动又从 setting 恢复出同一个坏包（INV-16）。
    clearPersistedPostUpdateReleaseNotesForVersion(
      failedReadyVersion,
      `${source}-after-ready-error`,
    );
    // 清 ready 后记录版本号：这是"用户为什么突然看不到更新"的直接答案，缺了它只能看到状态回退。
    logger.info(`[auto-update] cleared ready update after ${source} version=${failedReadyVersion}`);
  }
  // 清 available 与清 downloading 成组出现：它们描述同一次失败的两段事实，单独清会留下跨阶段残留（INV-12）。
  clearAvailableUpdateState();
  // 此处清下载态是无条件的：无论失败来自 check 还是 download，下载链都已结束（INV-5）。
  clearDownloadingUpdateState();
  // [权衡] 下载失败回退到 update-available，而不是 idle：失败不等于用户跳过，
  // 保留版本/说明/渠道让用户能直接重试，也避免入口消失后只能手动升级。
  // 强更进行中不回退——强更弹窗自己会展示错误并决定下一步，Main 不应替它决定。
  if (failedDownload?.version && !readyUpdateVersion && !activeForceAutoUpdateListener) {
    // 修复原因：用户点击“下载更新”后如果下载启动或 staging 很快失败，
    // 旧逻辑会清空 available/downloading 并广播 idle，renderer 入口和弹窗同时消失。
    // 失败并不等同于用户跳过该版本，应退回“发现更新”状态，让用户能看到并重试下载。
    availableUpdateReleaseNotes = failedDownload.releaseNotes;
    // 回填渠道后 available 三元组才完整：后续 buildUpdateAvailableState 与重试下载都读这个值。
    availableUpdateChannel = failedDownload.channel;
    // 回退到 update-available 是一次完整状态写入：版本、说明、渠道必须同时就位，避免 renderer 收到半份事实（INV-12）。
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(
        failedDownload.version,
        failedDownload.releaseNotes,
        failedDownload.channel,
      ),
    );
  } else {
    // else 分支覆盖三种情况：没有失败版本可回退、本地已有快照包、强更正在进行；
    // 统一收敛到 ready 或 idle，绝不停在 downloading（INV-9/INV-12）。
    setAutoUpdaterMenuState(
      readyUpdateVersion
        // 有本地快照包时以 ready 为落点：下载失败不该把已存在的可安装包降级，否则用户失去离线安装入口（INV-4）。
        ? buildUpdateDownloadedState(readyUpdateVersion)
        // idle 必须显式带 enabled=true：失败路径的前一步可能写过 enabled=false，漏写会让菜单永久禁用（INV-1）。
        : { kind: "idle", enabled: true },
    );
  }
  // 强更弹窗的错误由 Main 主动推送而非等它轮询：弹窗自己无法感知主进程异常，
  // 推送缺失会让用户停在一个没有进度也没有报错的界面（INV-8）。
  notifyForceAutoUpdate({ kind: "error", message });
  // 手动检查结果必须单独回投：它的接收方是发起检查的窗口（单槽 manualCheckWebContentsId），
  // 与状态广播不是同一条通道（INV-15）。
  sendManualCheckResult({ kind: "error", message });
  // [并发] 重查不能在失败处理栈内直接触发：此时 check 可能仍标记 in-flight，
  // triggerCheckForUpdates 会直接丢弃本次重查，导致弱网失败后长期不再检查。
  // 下载失败也是一次下载结束，无论来自 Promise reject 还是 error 事件。
  // 没有强制更新在进行时立即复查，避免弱网失败期间错过更高版本。
  // 失败可能发生在启动检查的结果处理里，记下原因，等这次检查收口后再查。
  if (failedDownload && !activeForceAutoUpdateListener) {
    // 失败也要标记"一次下载结束"：否则 recheckAfterDownload 会在本次 check 收口后仍被挂起，
    // 弱网恢复后没有任何自动重查（INV-20）。
    recheckAfterDownload?.("download-failed");
  }
  // 安装失败走独立恢复流程：它需要把 quitAndInstallState 从 preparing 拉回 idle，
  // 与下载失败的状态回退是两套逻辑，不能合并（INV-6）。
  if (failedInstall) recoverFromFailedUpdateInstall();
}

// 跳过记录按渠道隔离：preview 用户跳过 3.3.2 不应让 stable 用户也看不到它。
// 手动检查会清掉当前渠道的跳过记录（见 checkForUpdateMenuClick），
// 因为 manualCheckWebContentsId 非空本身就说明用户重新关注该版本。
async function isSkippedUpdateVersion(
  // 形参 version 是"要判定是否被跳过"的候选版本，不是当前显示的版本：调用方可能在状态切换后
  // 才拿旧结果来问，按入参比较才能避免误判（INV-17）。
  version: string,
  // 渠道必须随版本一起传入：跳过记录按渠道隔离，缺渠道就无法确定该查哪个键。
  channel: ElectronReleaseChannel,
  // 允许 undefined：调用方可能在没有配置服务的早期路径上询问，本函数必须能回答而不是抛错（降级为"未跳过"）。
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  // 无配置服务或强更进行中一律视为"未跳过"：强更的语义就是不能跳过，
  // 返回 true 会让强更流程直接退出。
  if (!settingService || activeForceAutoUpdateListener) {
    // false 表示"当作没跳过"，即允许继续展示与下载：这是安全的缺省方向，
    // 宁可多提示一次，也不能静默隐藏 update：多一次提示只是噪声，藏掉版本会让用户失去升级入口。
    return false;
  }

  // 用户手动检查更新代表重新关注被跳过的版本。
  // 即使持久化清理还没落盘，这一轮也不能继续把同版本更新当作 up-to-date 隐藏掉。
  if (manualCheckWebContentsId != null) {
    // 手动检查即"重新关注"：即使清盘记录还没落，本轮也必须让同版本重新可见，
    // 否则用户点了检查却被告知已是最新（INV-17 的用户意图侧）。
    return false;
  }

  try {
    // 每次判定都重新读盘而不缓存：skippedUpdateVersion 由设置页与手动检查两条路径修改，
    // 缓存会让刚取消的跳过在本进程内继续生效。
    const settings = await settingService.get();
    // 用 trim 后严格相等而不是 includes/startsWith：跳过是按完整版本号记录的，
    // 前缀匹配会把 3.3.2 与 3.3.21 混为一谈（INV-17）。
    return settings.skippedElectronUpdateVersions?.[channel]?.trim() === version.trim();
  } catch (error) {
    // 读盘失败记 warn 不记 error：跳过查询是辅助判据，失败只会导致多提示一次更新，
    // 不影响更新本身的正确性：读盘失败只会让 isSkippedUpdateVersion 多提示一次。
    logger.warn("[auto-update] read skipped update version failed:", error);
    // 读失败按"未跳过"处理：与上面一致，缺省方向是让用户仍能看到该版本。
    return false;
  }
}

// 读偏好失败按 false 处理：自动下载是"主动行为"，读不到配置时应保持不下载，
// shouldAutoDownloadAndInstallUpdates 返回 false 让用户仍可通过弹窗手动触发，而不是在配置损坏时静默开始拉包。
async function shouldAutoDownloadAndInstallUpdates(
  // 允许 undefined 与 isSkippedUpdateVersion 同构：两条读偏好的函数必须能接受同一批调用方，
  // 否则其中一条会在装配未完成时抛错。
  settingService: SettingServiceLike | undefined,
): Promise<boolean> {
  // 没有配置服务即"无偏好"：此时不能自动下载，因为用户从未表达过同意。
  if (!settingService) {
    // false 是 fail-closed 的方向：自动下载是主动拉包行为，读不到配置时应保持不动（见函数头注释）。
    return false;
  }

  try {
    // 只认严格 true：旧配置可能写成 "true" 或 1，宽松比较会在字段迁移期意外开启自动下载。
    return (await settingService.get()).autoDownloadAndInstallUpdates === true;
  } catch (error) {
    // 读失败记 warn：这是一次"放弃自动化"的降级，用户仍可手动触发，不需要按错误告警。
    logger.warn("[auto-update] read auto download preference failed:", error);
    // 读失败不自动下载：配置损坏时静默拉包比不更新更糟，用户会不知道安装了什么。
    return false;
  }
}

// 跳过是"用户意图"，必须同时作用于正在下载的包：仅写设置而放任下载继续，
// 会在下载完成后又把用户拉回 ready 状态，看起来像跳过无效。
// 状态校验先于取消：版本不匹配时不能误取消另一个版本的下载。
export async function skipAvailableUpdateVersion(
  // 入参是用户点"跳过此版本"时界面上显示的版本：必须与当前状态里的版本严格相等才生效，
  // 防止界面陈旧时跳过掉另一个版本（INV-17）。
  version: string,
  // 允许 undefined：跳过在设置未装配时仍要能生效于内存状态，只是无法持久化（见下方分支）。
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  // activeForceAutoUpdateListener 非空期间忽略跳过请求：强更的语义是不允许停留在旧版本，
  // 接受跳过会让弹窗与主进程对"是否必须升级"产生分歧。
  if (activeForceAutoUpdateListener) {
    // 记录被忽略的版本号：事后区分"用户没点跳过"与"点了但被强更拒绝"。
    logger.info(`[auto-update] ignore skip version=${version}: force update active`);
    // 返回前不取消下载：强更的下载由它自己的生命周期管理，这里取消会让强更卡在 downloading。
    return;
  }

  // 状态白名单：只有 download-progress 与 update-available 两种状态允许跳过；update-downloaded 时跳过必须先删除本地包，
  // 那是另一条更重的路径，不在本函数语义内（INV-12）。
  if (
    (menuState.kind !== "update-available" && menuState.kind !== "download-progress") ||
    menuState.version !== version
  ) {
    // 日志带出实际 state：用户报"跳过按钮没反应"时，先确认当时是不是 ready 态。
    logger.info(`[auto-update] ignore skip version=${version}: state=${menuState.kind}`);
    // 不写跳过记录：状态不匹配说明用户看到的不是这个版本的入口，写入会污染另一版本的跳过键。
    return;
  }

  // 渠道按状态分层取：下载态用锁定的 downloadingUpdateChannel，否则用 available，
  // 最后回落默认渠道——三层兜底保证跳过记录一定写到具体渠道键上（INV-12）。
  const channel =
    menuState.channel ??
    // 先按 menuState 选来源再统一 ??：把三元放进 ?? 链内部，避免"状态对了但字段为空"时直接落到默认渠道而绕过正确来源。
    (menuState.kind === "download-progress" ? downloadingUpdateChannel : availableUpdateChannel) ??
    // 最后兜底：即便两个来源都为空也要写到一个确定渠道，否则跳过记录会以 undefined 为键，重启后失效。
    availableUpdateChannel;
  // 只有存在 token 才需要取消：没有 token 说明这次跳过发生在"仅发现未下载"阶段，直接进入状态清理。
  if (downloadCancellationToken) {
    // 先标记后 cancel：与 cancelDownloadingUpdate 同一顺序，保证随之而来的 reject 被识别为取消（INV-10/INV-11）。
    markCancelledDownload(downloadCancellationToken);
    // 取消的是"正在下的这个版本"：上面已确认 menuState.version 与入参相等，不会误取消别的版本。
    downloadCancellationToken.cancel();
    // 日志同时带 channel 与 version：跳过并取消是一次复合动作，需要能从日志还原取消了哪个包。
    logger.info(
      `[auto-update] skipped downloading version; cancel active download channel=${channel} version=${version}`,
    );
  }

  // 下载态弹窗仍需要允许用户跳过当前版本。
  // 如果 main 只接受 update-available，UI 中点击“跳过此版本”会变成 no-op；
  // 这里在持久化跳过前取消当前下载，并清理下载态，避免后台继续拉取已跳过版本。
  clearAvailableUpdateState();
  // 清下载态必须在写跳过记录之前：否则下载链的 finally 可能用旧快照把状态写回 downloading（INV-5）。
  clearDownloadingUpdateState();
  // 跳过后的落点只有 ready 或 idle：跳过意味着不再展示这个版本，不能回退成 available（INV-9 的反向约束）。
  setAutoUpdaterMenuState(
    readyUpdateVersion
      // 本地仍有其它可安装包时回到 ready：跳过 A 版本不影响已下载的 B 版本，
      // 把界面打成 idle 会让用户失去已有的安装入口（INV-4）。
      ? buildUpdateDownloadedState(readyUpdateVersion)
      // 无包可装才回 idle，并显式恢复 enabled：跳过不该让更新功能整体不可用（INV-1）。
      : { kind: "idle", enabled: true },
  );

  // 设置未装配时跳过只在内存生效：这是可接受的降级，但要留下 warn 让人知道重启后该版本会重现。
  if (!settingService) {
    // 用 warn 而非 info：跳过没有落盘属于"用户意图未被持久化"，是需要被人看见的异常降级。
    logger.warn(
      `[auto-update] skipped version not persisted because setting service is missing version=${version}`,
    );
    // 状态已改完再返回：内存语义必须先生效，持久化只是后续动作，不能因它缺失而回滚界面。
    return;
  }

  try {
    // 写前先读全量设置：update 是浅合并，只带 skippedElectronUpdateVersions 会覆盖掉其它渠道的跳过记录。
    const settings = await settingService.get();
    // 用展开合并而不是直接赋值：preview 与 stable 共享同一个跳过对象，覆盖写会让另一个渠道的记录凭空消失。
    await settingService.update({
      // 键必须与查询侧一致（isSkippedUpdateVersion 用同一个 channel 取值），两边任一改名都会让跳过静默失效。
      skippedElectronUpdateVersions: {
        ...settings.skippedElectronUpdateVersions,
        [channel]: version,
      },
    });
    // 成功日志带 channel 与 version：这是"跳过已持久化"的唯一证据，排查重启后跳过期失效时需要它。
    logger.info(`[auto-update] skipped version persisted channel=${channel} version=${version}`);
  } catch (error) {
    // 持久化失败记 error：用户以为已跳过，重启后该版本会重新出现，这是需要被告警的状态不一致。
    logger.error("[auto-update] persist skipped update version failed:", error);
  }
}

// 手动检查前清除当前渠道的跳过记录：清理失败只记 warn，
// 因为即使持久化没成功，本轮仍需让同版本重新可见（isSkippedUpdateVersion 会因
// manualCheckWebContentsId 非空而短路）。
async function clearSkippedUpdateVersionForManualCheck(
  // 只清"当前检查的目标渠道"：清全部渠道会让 preview 用户的手动检查顺手抹掉 stable 的跳过记录。
  channel: ElectronReleaseChannel,
  // 允许 undefined：手动检查必须在没有配置服务时也能继续，跳过清理失败不影响本轮可见性。
  settingService: SettingServiceLike | undefined,
): Promise<void> {
  // 无配置服务直接返回：没有可清的对象，且上面已保证本轮不会因跳过记录而隐藏更新。
  if (!settingService) {
    // 静默返回不记日志：这条路径在装配早期的每次手动检查都会走到，记日志会形成噪声。
    return;
  }

  try {
    // 读全量再只改一个渠道：与 skipAvailableUpdateVersion 的写侧对称，避免覆盖其它渠道。
    const settings = await settingService.get();
    // 先取引用再判空：字段本身可能整体缺失（老配置），后续 ?. 链依赖这个局部变量。
    const skippedVersions = settings.skippedElectronUpdateVersions;
    // trim 后再判空：历史数据可能写入空串，空串不是有效跳过记录，不该触发一次无意义的写盘。
    const skippedVersion = skippedVersions?.[channel]?.trim();
    // 没有记录就不写盘：手动检查会频繁触发本函数，无差别 update 会让设置文件反复落盘。
    if (!skippedVersion) {
      // 返回前不动状态：清跳过只影响"未来是否提示"，当前这轮检查的结果由调用方决定。
      return;
    }

    // 浅拷贝后再删：直接 delete 原对象会改动从设置读出的引用，若后续写盘失败，内存里已经丢了这条记录。
    const nextSkippedVersions = { ...skippedVersions };
    // 只删当前渠道：其它渠道的跳过记录必须原样保留，用户只同意"这一次手动检查重新关注此版本"（INV-17）。
    delete nextSkippedVersions[channel];
    // 与写入侧同样用全量对象覆盖：合并语义下只传 channel 键无法表达"删除"，必须给出完整的新映射。
    await settingService.update({
      // 键名必须与两侧一致：这是持久化契约，改名不会报错，只会让跳过记录在重启后全部失效。
      skippedElectronUpdateVersions: nextSkippedVersions,
    });
    // 成功日志带 channel 与 version：清跳过是"用户重新可见该版本"的原因，排查时需要能把两者对上。
    logger.info(
      `[auto-update] manual check cleared skipped update channel=${channel} version=${skippedVersion}`,
    );
  } catch (error) {
    // 清盘失败降级为 warn：本轮判断已按"未跳过"执行，只是重启后该版本会再被隐藏一次。
    logger.warn("[auto-update] clear skipped update version failed:", error);
  }
}

// [事务] 这是"下载完成"的唯一发布点：先写 ready 三件套，再清 available/downloading，
// 顺序保证任何并发读取都不会看到"既 ready 又在下载"的双重事实。
// 渠道先取下载时锁定的 downloadingUpdateChannel，缺失才回落 availableUpdateChannel：下载期间用户可能已切换设置，用新设置会把这次下载标记到错误渠道。
function publishDownloadedUpdate(info: UpdateDownloadedInfoLike): void {
  // 先写版本：它是 ready 的唯一身份，后续 channel/说明都以它为归属，顺序颠倒会短暂出现"有说明无版本"的状态。
  readyUpdateVersion = info.version;
  // 真实下载必须清掉 restored 标记：否则本次 ready 会被安装入口当成伪 ready 再下一次包（INV-4/INV-7）。
  readyUpdateRestoredFromPendingReleaseNotes = false;
  // 渠道取下载时锁定值：下载期间用户可能切了设置，用新设置会把这次下载标记到错误渠道（见函数头注释）。
  readyUpdateChannel = downloadingUpdateChannel ?? availableUpdateChannel;
  // 归一失败时回落到下载时快照：info 可能缺说明，但用户仍应看到发起下载时那条版本说明（INV-16）。
  readyUpdateReleaseNotes = toPostUpdateReleaseNotesPayload(info) ?? downloadingUpdateReleaseNotes;
  // ready 写入后才清 available：反序会让并发读取看到"既没有 available 又没有 ready"的空窗（见函数头注释）。
  clearAvailableUpdateState();
  // 与清 available 成组：它们描述同一次下载的两段事实，只清一段会留下"下载中"的残留字段（INV-12）。
  clearDownloadingUpdateState();
  // 日志区分平台：win32 不随退出自动安装，必须明确提示"等待显式安装"，避免用户以为升级已生效。
  logger.info(
    `[auto-update] downloaded: ${info.version}, ${process.platform === "win32" ? "waiting for explicit install" : "ready to install on quit or explicit install"}`,
  );
  // 先提交状态再通知弹窗：监听器与 renderer 都可能回查 menuState，状态必须已是 ready（INV-1）。
  setAutoUpdaterMenuState(buildUpdateDownloadedState(info.version));
  // 弹窗需要"下载完成"这一中间反馈：它不等于可点击安装，强更会紧接着自动进入 installing。
  notifyForceAutoUpdate({ kind: "ready", version: info.version });
  // 强更存在时不复查：弹窗已经把完成当作过渡态，再查一次会与即将开始的安装抢状态。
  if (!activeForceAutoUpdateListener) {
    // 非强更才顺带复查更高版本：避免刚下完就被远端新版本取代却仍提示安装旧包（见 recheckAfterDownload 注释）。
    recheckAfterDownload?.("download-finished");
  }

  // activeForceAutoUpdateListener 存在时下载完成即 quitAndInstallUpdate：弹窗已经把"下载完成"当作过渡态，
  // 若等用户点击会与强更的"必须升级"语义冲突。
  // 非强更模式则先 recheckAfterDownload?.("download-finished") 复查更高版本，避免刚下完就被远端新版本取代却仍提示装旧包。
  if (activeForceAutoUpdateListener) {
    // 先推 installing 再调用安装：安装会关闭 Host/Agent，弹窗必须在断连前收到阶段变化（INV-6）。
    notifyForceAutoUpdate({ kind: "installing" });
    // 不 await 且不传 rejectUnavailable：强更路径没有调用方需要错误，失败由 handleAutoUpdateFailure 内部收敛。
    void quitAndInstallUpdate();
  }

  // pendingPostUpdateReleaseNotes 持久化是"安装后弹窗"的事实来源：没有说明时也要 clearPendingPostUpdateReleaseNotes 写一次清空，
  // 否则上一次下载残留的说明会在安装后被误认为本次版本的说明。
  // 写盘失败只记录错误：它不影响本次安装，但会让安装后的说明缺失。
  if (autoUpdaterSettingService) {
    // settingService 未注入说明宿主尚未完成装配：此时跳过持久化而不是抛错，
    // 安装后说明会缺失，但不该因此阻塞安装（INV-16 的降级侧）。
    const releaseNotesPayload = readyUpdateReleaseNotes;
    // 先快照再异步写：persist 期间可能又有新下载写入 ready 三件套，
    // 晚读会把新说明写进旧版本的 pending 槽（INV-16）。
    const persistTask = releaseNotesPayload
      // 有无说明都要写盘：没有说明必须显式清空，否则上一次安装残留的说明会被误认作本次版本（INV-16）。
      ? persistPendingPostUpdateReleaseNotes(
          autoUpdaterSettingService,
          releaseNotesPayload,
          "update-downloaded",
        )
      // 清空走与写入同一组 setting 字段：两条分支必须覆盖同一个键，漏一条就会留下"有版本无说明"的脏数据。
      : clearPendingPostUpdateReleaseNotes(
          autoUpdaterSettingService,
          "update-downloaded-without-release-notes",
        );

    // 写盘失败只记录不改状态：它不影响本次安装，但会让安装后的说明缺失，
    // 因此不能静默吞掉（INV-16）。
    void persistTask.catch((error) => {
      // 失败不重试：重试写入会与下一次下载的持久化竞争同一个键，谁后写谁生效，版本与说明可能错配。
      logger.error("[auto-update] persist post-update release notes failed:", error);
    });
  }

  // 逐个窗口补发 ready：新窗口可能在事件之后创建，广播无法覆盖它，
  // 只有遍历当前窗口才能保证每个 renderer 都拿到可安装状态。
  for (const win of BrowserWindow.getAllWindows()) {
    // 逐窗口补发而不是广播：新窗口可能在 update-downloaded 之后才创建，广播覆盖不到它，
    // 只有遍历当前窗口才能让每个 renderer 都拿到可安装状态（INV-4 的投递侧）。
    syncReadyUpdateToWindow(win);
  }
}

// 下载入口被 renderer、强更、自动下载三处复用，因此每道校验都必须幂等：
// 已 ready/已下载中/无可用目标时直接返回，而不是抛错。
// 这些校验也让"双击下载按钮"不会创建第二个 CancellationToken。
export function downloadAvailableUpdate(reason = "renderer") {
  // 安装流程已启动时拒绝新的下载请求：此刻 ready 包可能正被安装器覆盖，
  // 新建 token 会与退出流程争同一份缓存（INV-6/INV-7）。
  if (isUpdateTargetLocked()) return;
  // 未打包或 flavor 禁用时 fail-closed：electron-updater 没有真实 feed，
  // 点下载只会对占位地址发请求并留下误导性失败。
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    // 记录 reason 而不只写"跳过"：下载有三个入口（renderer/强更/自动），
    // 没有 reason 无法定位是哪条路径在不可用运行时被触发。
    logger.info(`[auto-update] skip ${reason} download: not packaged`);
    // 返回前不动 menuState：不可用运行时下状态应保持调用前的值，
    // 改成 downloading 会让界面出现一个永远不会前进的进度条（INV-12）。
    return;
  }

  // 已就绪时重复点击是幂等返回而非错误：用户可能连点两次或两个窗口同时触发，
  // 再走一次 downloadUpdate 会覆盖 ready 三件套（INV-4）。
  if (menuState.kind === "update-downloaded") {
    // 日志区分 already ready 与 already in progress：两者对用户的后续动作不同，
    // 前者该引导安装，后者该等待：两者在 menuState 里的 kind 不同。
    logger.info(`[auto-update] skip ${reason} download: update already ready`);
    // 不改状态：ready 是终态之一，回退到 downloading 会让"重启即安装"按钮消失（INV-4/INV-12）。
    return;
  }

  // 进度态重复请求直接丢弃：此时 token 已存在，再建一个会让两条下载链写同一个 pending 槽（INV-5）。
  if (menuState.kind === "download-progress") {
    // 这条日志用于排查"双击下载按钮"：download-progress 出现两次说明上游入口没做按钮禁用，而不是下载逻辑重复。
    logger.info(`[auto-update] skip ${reason} download: download already in progress`);
    // 保持当前进度：重置进度会让进度条从 0 重来，用户会以为下载失败后又自动重试了。
    return;
  }

  // 以 token 而非 menuState 判"是否已有下载"：menuState 可能因失败被提前打回 available
  // 而 token 尚未清理，此时再发起会让两个下载链并存（INV-5）。
  if (downloadCancellationToken) {
    // already requested 与 already in progress 分开记：前者说明 token 在但状态未推进，
    // 通常意味着第一条 download-progress 事件还没到。
    logger.info(`[auto-update] skip ${reason} download: download already requested`);
    // 不改状态：token 在就意味着已有一条链负责收口，这里插手会与它的 finally 竞争清槽。
    return;
  }

  // 最后一道白名单校验：只有 update-available 才携带可下载版本，
  // 其余态（checking/idle/error）都没有确定的目标包（INV-12）。
  if (menuState.kind !== "update-available") {
    // 带出实际 state：这条日志是"按钮亮了但点不动"最直接的证据，
    // 能定位是 menuState 没刷新还是渲染层自行显示了按钮。
    logger.info(`[auto-update] skip ${reason} download: state=${menuState.kind}`);
    // 白名单外一律不下载：没有确定的版本与渠道就发起下载，等于让 electron-updater 按当前配置猜包。
    return;
  }

  // 先把 available 的三元组复制到 downloading，再发起下载：后续事件只读 downloading，
  // 避免 available 被清空后丢失版本与说明。
  downloadingUpdateVersion = menuState.version;
  // 说明允许从 available 兜底：部分 manifest 不带 releaseNotes，下载态仍需展示上次检查拿到的说明（INV-12）。
  downloadingUpdateReleaseNotes = menuState.releaseNotes ?? availableUpdateReleaseNotes;
  // 渠道必须在这里锁定：之后用户切预览开关不影响本次下载，
  // 下载完成时 publishDownloadedUpdate 读的就是这个值。
  downloadingUpdateChannel = menuState.channel ?? availableUpdateChannel;
  // electron-updater 如果命中本地已下载缓存，会在 downloadUpdate() 内直接触发
  // update-downloaded。这里不能先广播 0% 下载态，否则用户会先看到“下载中”，
  // 再跳到“已下载”；真实下载态改由第一条 download-progress 事件驱动。
  notifyForceAutoUpdate({
    // 强更弹窗先进入 downloading 是给用户"已受理"的反馈：真实进度由 download-progress 接管，
    // 这个 downloading 只是给弹窗的占位态：第一条 download-progress 会立刻覆盖它。
    kind: "downloading",
    // 版本取自刚写入的 downloading 字段而非 menuState：两者此刻相等，
    // 但读同一来源能保证弹窗与主进程记录的是同一个目标版本。
    version: downloadingUpdateVersion,
    // 用字符串 "0" 而不是数字 0：强更协议里 progress 是渲染用字符串，类型混用会让弹窗拼出 undefined%。
    progress: "0",
  });

  // [资源] token 与 pending 槽必须成对建立：先建 token 再清 pending，
  // 保证下载开始后到达的旧 ready 事件不会落进新一次下载的槽位。
  const cancellationToken = new CancellationToken();
  // 全局槽指向新 token 是"这次下载"的唯一身份：后续所有回调都靠它判断自己是否已被取代（INV-5）。
  downloadCancellationToken = cancellationToken;
  // 清掉上一轮的 pending：不清会让本次下载若只 reject 不触发事件时，旧 ready 被下一次成功回调误发（INV-5）。
  pendingDownloadedUpdate = null;
  // 直接调实例方法而不经封装：downloadUpdate 的 Promise 是唯一能拿到 reject 的通道，
  // 只监听 update-downloaded 事件会漏掉"失败但不发 error 事件"的实现。
  autoUpdater
    .downloadUpdate(cancellationToken)
    // [并发] downloadUpdate 的 Promise 成功不代表仍是这次下载，所以必须校验下面三重条件：
    // token 身份、未取消、未锁定这三重校验必须同时成立，缺一不可。
    .then(() => {
      // [并发] token 身份是第一道闸：用户取消后重试会换新 token，旧链的成功回调必须在此丢弃（INV-5）。
      if (downloadCancellationToken !== cancellationToken) return;
      // 取事件回调写入的 pending：update-downloaded 事件比 Promise resolve 更早拿到 info，
      // 这里是两条路径唯一的交汇点（INV-4）。
      const downloaded = pendingDownloadedUpdate;
      // 取走即清槽：同一份 info 只能发布一次，否则会重复写 ready 三件套并重复广播（INV-4）。
      pendingDownloadedUpdate = null;
      // 清 token 表示"下载链已结束"：之后 cancelDownloadingUpdate 会因 token 为空而静默返回（INV-10）。
      downloadCancellationToken = null;
      // 三重条件必须同时成立：token 相同、未被取消、未进入安装，任一不成立都说明这次下载已不被需要（INV-5/INV-6）。
      if (
        downloaded?.token === cancellationToken &&
        !cancellationToken.cancelled &&
        !isUpdateTargetLocked()
      ) {
        // 只有三重校验全过才发布 ready：这是 INV-4 的唯一真实写入点，提前发布会让安装器读到半包。
        publishDownloadedUpdate(downloaded.info);
      }
    })
    // [失败路径] 取消走静默分支，其余错误必须立即收敛：不能只等 electron-updater 的
    // error 事件，因为某些实现只在 Promise 上 reject，UI 会永远停在下载态。
    .catch((error) => {
      // 取消错误必须按 token 身份识别：取消后仍可能有一次真实失败到达，
      // 用"是否取消过"这种全局判断会把真实失败一起吞掉（INV-11）。
      if (isCancelledDownload(cancellationToken, error)) {
        // 取消记 info 不记 error：这是用户主动操作的结果，记 error 会污染失败率并触发告警。
        logger.info(`[auto-update] ${reason} download cancelled`);
        // 取消分支不回退状态：回退由 cancelDownloadingUpdate 统一完成，
        // 这里再写一次会与它竞争，出现"取消后闪一下 idle 又回 available"。
        return;
      }
      // 下载由用户点击或强更 gate 显式触发，Promise reject 也必须立即反馈。
      // 不能只依赖 electron-updater 后续是否额外触发 error 事件，否则 UI 会卡在下载态。
      handleAutoUpdateFailure(error, "download update failed");
    })
    // [资源] dispose 无条件执行：CancellationToken 内部持有的监听与定时器必须释放，
    // 否则每次下载都会留下一个悬挂的句柄。
    // 只清"仍属于本次下载"的槽位，避免把后来者建立的 token 清掉。
    .finally(() => {
      // 只清"仍属于本次下载"的槽位：token 身份比较是唯一判据，避免把后来者（用户重试、下一次自动下载）
      // 新建的 token 清掉（INV-5）。
      if (downloadCancellationToken === cancellationToken) {
        // token 置空即"当前无下载"的唯一标记：cancelDownloadingUpdate 靠它判断是否还有可取消的下载，
        // 因此必须与 pending 槽同批清理。
        downloadCancellationToken = null;
        // pending 槽与 token 同生共死：downloadUpdate 已 reject 时槽里可能残留上一轮的 ready 信息，
        // 不清会让下一次 publishDownloadedUpdate 取到旧包（INV-5）。
        pendingDownloadedUpdate = null;
      }
      // [资源] 无条件调用 cancellationToken.dispose()：CancellationToken 内部挂着监听与定时器，漏掉一次就会留下一个悬挂句柄，
      // 进程退出会被它拖住（INV-18 的同源约束）。
      cancellationToken.dispose();
    });
}

// 取消只回退到 update-available，不写跳过记录：用户只是想停止下载，
// 不是放弃该版本。保留 manifest 信息让"重试下载"不需要重新走检查。
export function cancelDownloadingUpdate(reason = "renderer") {
  // [权衡] 强更期间不允许取消：强更语义是"必须升级"，允许取消会把弹窗留在 downloading
  // 而下载已被中止，用户既不能继续也不能跳过。
  if (activeForceAutoUpdateListener) {
    // 记录被拒绝的取消请求：事后需要区分"用户没点取消"与"点了但被强更挡回"，
    // 日志里的 reason 必须能区分这两类请求：否则统计取消失败率会把它算成用户放弃。
    logger.info(`[auto-update] skip ${reason} cancel download: force update active`);
    // 不做任何状态回退：强更的 downloading 由下载完成或失败路径收口，
    // 这里插手会让弹窗与主进程状态分叉。
    return;
  }

  // download-progress 与 downloadCancellationToken 必须同时成立：状态是 downloading 但没有 token，说明下载已被 finally 清槽，
  // 此时 cancel() 无从下手，只能静默跳过（INV-5）。
  if (menuState.kind !== "download-progress" || !downloadCancellationToken) {
    // 日志带出当前 state：用户报"取消没反应"时，需要先确认当时是不是 update-available
    // （update-available 态本来就不该出现取消按钮）。
    logger.info(`[auto-update] skip ${reason} cancel download: state=${menuState.kind}`);
    // 返回前不动状态：非下载态的清空会把 available 信息一并抹掉，用户会以为版本消失了。
    return;
  }

  // 先快照再清空：clearDownloadingUpdateState 会把 version/releaseNotes/channel 置 null，回退状态需要它们。
  const version = downloadingUpdateVersion;
  // 三个快照字段必须取自同一时刻的 downloading 三元组：分开读会在 clearDownloadingUpdateState 之后读到 null，
  // 回退状态就丢了版本说明（INV-12）。
  const releaseNotes = downloadingUpdateReleaseNotes;
  // 渠道取下载时锁定的值：用户可能在下载中切了预览开关，用新设置会把这次下载标记到错误渠道，
  // 否则回退后点重试取到的是新渠道的包：menuState.channel 与下载时的渠道已分叉。
  const channel = downloadingUpdateChannel ?? availableUpdateChannel;
  // 先取引用再清槽：clearDownloadingUpdateState 会把 downloadCancellationToken 置 null，
  // 晚一步就取不到要取消的 token（INV-10）。
  const cancellationToken = downloadCancellationToken;
  // 必须先标记再 cancel：electron-updater 的 reject 可能在 cancel() 返回前就到，
  // 顺序颠倒会让这个 token 被当作真实失败（INV-10/INV-11）。
  markCancelledDownload(cancellationToken);
  // cancel 只置位并触发 reject，不回收监听；真正的资源释放留给 downloadUpdate 链上的 finally（INV-10）。
  cancellationToken.cancel();
  // 取消日志必须在 clearDownloadingUpdateState 之前落：version 取自快照，能明确指出取消的是哪个版本，便于和远端发布记录对齐。
  logger.info(
    `[auto-update] ${reason}: cancel download channel=${channel} version=${version ?? "unknown"}`,
  );

  // 取消下载不是跳过版本，只回退到发现更新状态，保留同一份 manifest 信息让用户可以稍后重试。
  clearDownloadingUpdateState();
  // 有版本才回退到 available：没有版本说明这次下载不是由一次真实 check 发起，
  // 回退只能落到 idle 或 ready。
  if (version) {
    // 回填说明与渠道，让用户点重试时无需重新走检查：check 会重新打 manifest，
    // 弱网下等于把刚失败的流程再走一遍（INV-9）。
    availableUpdateReleaseNotes = releaseNotes;
    // 回填的渠道必须与当初下载一致：否则重试会按新渠道取包，用户看到的版本号与说明来自旧渠道，
    // 否则 version 没变而安装内容已换，用户上报的问题无法复现。
    availableUpdateChannel = channel;
    // 一次写全 available 三件套：分三次写会让 renderer 收到中间态（有版本无说明），弹窗短暂显示空说明（INV-12）。
    setAutoUpdaterMenuState(buildUpdateAvailableState(version, releaseNotes, channel));
    // 借"下载周期结束"这个时机用 recheckAfterDownload 复查远端：用户取消期间可能已发布更高版本，
    // 复用同一条去重路径收口（INV-20）。
    recheckAfterDownload?.("download-finished");
    // 回退完成后必须 return：继续往下会再写一次 menuState，把刚建立的 available 覆盖成 idle/ready（INV-12）。
    return;
  }

  // 无版本可回退时的兜底收敛：优先回到 ready（包还在本地），否则 idle，绝不停在 downloading（INV-12）。
  setAutoUpdaterMenuState(
    readyUpdateVersion
      // 本地已有可安装包时以 ready 为准：取消只针对"这一次下载"，不该抹掉此前已经落地的包（INV-4）。
      ? buildUpdateDownloadedState(readyUpdateVersion)
      // idle 必须带 enabled=true 重新开放入口：取消后用户还要能再点检查或下载，禁用会让更新功能看起来坏掉（INV-1）。
      : { kind: "idle", enabled: true },
  );
}

// locale 只影响渲染，不影响更新事实；因此这里只同步菜单，不触发任何网络或状态迁移。
export function setAutoUpdaterMenuLocale(locale: Locale) {
  // locale 只改渲染上下文，不触发网络或状态迁移：更新事实（版本、渠道）与界面语言无关，
  // 混在一起会让切语言顺带触发一次无谓 check。
  menuLocale = locale;

  // 检查更新菜单项会被 updater 的异步状态流反复改写。
  // 如果只在创建菜单时翻译一次，后续 checking/downloading 阶段又会退回英文。
  // 这里把 locale 和当前 updater 状态一起保存，确保每次重建菜单或切语言后都能按最新状态重新渲染。
  syncMenuItemState();
}

// 启动时把磁盘上的 pending 说明读回内存，并按版本关系决定三种归宿：
// 旧于已安装版本 -> 丢弃；高于当前版本 -> 恢复 ready；等于当前版本 -> 等待窗口投递。
// 恢复 ready 用的是"持久事实 + 版本比较"，而不是 electron-updater 的内存状态，
// 因为 electron-updater 的内存状态在进程重启后必然丢失。
export async function hydratePendingPostUpdateReleaseNotes(settingService: SettingServiceLike) {
  // 读盘是异步且可能在启动早期完成：await 期间不写任何全局字段，避免读失败时把 pending 清成 null（INV-16）。
  const settings = await settingService.get();
  // 用 ?? null 而不是 ||：setting 里可能存着旧结构的空值，统一 null 化才能让后续所有
  // if (pendingPostUpdateReleaseNotes) 判断语义一致（INV-16）。
  pendingPostUpdateReleaseNotes = settings.pendingPostUpdateReleaseNotes ?? null;
  // 进程重启后 deliveredPostUpdateReleaseNotesWebContentsId 必然失效：强制清空投递记录，让新窗口能重新接收同一份说明，
  // 而不是被当作"已投递"跳过（INV-16）。
  deliveredPostUpdateReleaseNotesWebContentsId = null;

  // 丢弃后立即走 clearPendingPostUpdateReleaseNotes 清槽：只记日志不清盘，下一次启动会再次读到同一条过期说明，每次启动都重复一次"丢弃"日志，掩盖真正的新说明。
  if (pendingPostUpdateReleaseNotes) {
    // 读到 pending 就落日志：用于对齐"磁盘里有说明但界面没弹"，区分是没读到还是读到后被丢弃（INV-16）。
    logger.info(
      `[auto-update] hydrated pending post-update release notes version=${pendingPostUpdateReleaseNotes.version}`,
    );
  }

  // 丢弃判据按 semver 比较"版本低于已安装"而非时间：用户可能跨多个版本重启，
  // 只有版本比较才能证明这份说明确实过期（INV-16）。
  if (
    pendingPostUpdateReleaseNotes &&
    shouldDiscardStalePendingReleaseNotes(
      pendingPostUpdateReleaseNotes.version,
      getCurrentAppVersionForUpdate(),
    )
  ) {
    // 丢弃日志同时带上 pending 版本与当前 app 版本：只写"丢弃了"无法判断是说明真过期，还是版本比较出错。
    logger.info(
      `[auto-update] discard stale post-update release notes pending=${pendingPostUpdateReleaseNotes.version} app=${getCurrentAppVersionForUpdate()}`,
    );
    // 丢弃必须落盘清槽：只记日志不写盘，下一次启动会再读到同一条过期说明并重复丢弃，
    // 真正的新说明会被这层噪声掩盖（INV-16）。
    await clearPendingPostUpdateReleaseNotes(
      settingService,
      "hydrate-pending-older-than-installed-app",
    );
  }

  // 恢复 ready 的条件是"pending 版本高于当前 app"：等于当前版本说明更新已安装、只待投递；
  // 低于当前版本则已在上面分支丢弃（INV-4/INV-16）。
  if (
    pendingPostUpdateReleaseNotes &&
    isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)
  ) {
    // 用户下载完成但尚未安装时重启应用，electron-updater 的内存 ready 状态会丢失，
    // 但本地 pending 包和版本说明仍在。这里用“pending 版本高于当前版本”恢复待安装状态，
    // 避免已有缓存时仍提示“下载更新”，点击后又被 dev staging 错误打回 idle。
    // [事务] restored 标记必须与 ready 同时写入：后续安装入口据此识别
    // "这是伪 ready，需要重新下载建立真实上下文"。
    readyUpdateVersion = pendingPostUpdateReleaseNotes.version;
    // 说明与版本必须同源：恢复时两者来自同一条 setting，混用内存残留会让安装后弹出别的版本的说明（INV-16）。
    readyUpdateReleaseNotes = pendingPostUpdateReleaseNotes;
    // 这个标记把 ready 分成"真实下载"与"磁盘恢复"两类：安装入口据此决定是否先重新 downloadUpdate
    // 建立安装上下文（INV-4/INV-7）。
    readyUpdateRestoredFromPendingReleaseNotes = true;
    // 恢复后立即发布状态：否则重启后的窗口要先等一次检查才看得到"可安装"，用户会以为更新丢了（INV-4）。
    setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
    // 恢复日志在 setAutoUpdaterMenuState 之后落：它记录的是"恢复已生效"这一既成事实，不是"准备恢复"的意图。
    logger.info(
      `[auto-update] restored ready update from pending release notes version=${readyUpdateVersion}`,
    );
  }
}

// ready 是持久状态而非一次性事件：窗口 reload/新开都可能在事件之后，
// 这里在窗口就绪时补发，保证"重启以更新"按钮不会因为错过一次 IPC 而消失。
export function syncReadyUpdateToWindow(win: BrowserWindow) {
  // [失败路径] 没有 ready 版本时不补发：UpdateReady 是"可立即安装"的承诺，空版本会让 renderer
  // 记下一个点不动的按钮；win 已销毁时 send 会抛 "Object has been destroyed" 并打断窗口重建流程。
  if (!readyUpdateVersion || win.isDestroyed()) {
    // 静默返回而非抛错：本函数在窗口创建/恢复的多条路径上被调用，"没有东西可补发"是常态（INV-4 的投递侧）。
    return;
  }

  // update-downloaded 可能发生在 renderer React effect 还没挂好之前，
  // 甚至发生在窗口 reload / 新开窗口之前。这里把“已有可安装更新”视为一份持久状态，
  // 在窗口后续就绪时补发一次，避免按钮只靠那次瞬时事件而丢失。
  logger.info(
    `[auto-update] sync ready update to window ${win.webContents.id}: ${readyUpdateVersion}`,
  );
  // 只补发 readyUpdateVersion、不夹带 releaseNotes：说明必须走 syncPostUpdateReleaseNotesToWindow 的单窗口 ack 通道，
  // 两条通道混用会让同一份说明被 renderer 消费两次（INV-16）。
  win.webContents.send(PlatformChannels.UpdateReady, readyUpdateVersion);
}

// 只返回引用而不复制：调用方是 Main 内部的 IPC 桥，不需要防御性拷贝；
// 若返回副本，dedupe 比较会永远失败，广播会退化成每条事件都发一次。
export function getAutoUpdaterState(): UpdateStatePayload {
  // 返回内部引用而非副本：调用方是同进程的 IPC 桥，读到的就是写入的那份对象；
  // 若在此复制，dedupe 比较永远不等，每次状态同步都会退化成一次全窗口广播（INV-1 的读侧）。
  return menuState;
}

// refreshAutoUpdaterReleaseChannel 有三种归宿：直接重查、登记 pending 等当前检查收口与忽略，所以必须先判当前是否有 check。
// 选择哪一种取决于"当前是否有 check"与"是否正处于下载/已就绪"。
export function refreshAutoUpdaterReleaseChannel(
  // 形参 receivePreviewUpdates 是"用户设置里的布尔值"而非渠道字符串：渠道映射只在本函数内完成一次，
  // 避免调用方各自拼 "preview"/"stable" 造成拼写或大小写漂移（INV-13）。
  receivePreviewUpdates: boolean,
  reason = "settings receivePreviewUpdates changed",
) {
  // [并发] 安装流程一旦离开 idle 就冻结渠道：此刻改 availableUpdateChannel 会让正在退出的进程
  // 重新发起 manifest 请求，而安装器已开始覆盖 resources（INV-6）。
  if (quitAndInstallState !== "idle") return;
  // 关闭预览即 stable，是本函数对"渠道只有两档"的显式假设：新增渠道必须同时改这里与
  // getAutoUpdaterReleaseChannelForCurrentState，否则会退化成"永远按 stable 重查"。
  const nextChannel: ElectronReleaseChannel = receivePreviewUpdates ? "preview" : "stable";

  // flavor 禁用与未打包都归为"当前运行时不可用"：这两种情况下 electron-updater 没有真实 feed，
  // 继续重查只会打占位地址，并留下会污染错误率的失败日志。
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    // 记 info 不记 warn：这是产品形态决定的正常跳过而非故障，用 warn 会让错误率统计失真。
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    // 返回前不登记 pendingManifestReleaseChannelRefresh：该字段只服务于真实 check，
    // 在不可用运行时登记会留下一个永远无人消费的渠道（INV-13）。
    return;
  }

  // 下载中/已就绪时拒绝换渠道：这两态的包已按旧渠道下载，此时改 availableUpdateChannel
  // 会让 ready 的版本被标成新渠道，安装后回查更新时向错通道要清单（INV-12）。
  if (menuState.kind === "download-progress" || menuState.kind === "update-downloaded") {
    // 日志带上即将切换的 nextChannel：排查"用户开了预览却没生效"时，需要区分是
    // 这两种情况在日志里的区别就是 nextChannel：没有这一列就无法确认选择是否落盘。
    logger.info(`[auto-update] skip ${reason}: state=${menuState.kind} channel=${nextChannel}`);
    // 不登记 pending：下载结束后的渠道刷新由用户再次改设置或下一次轮询承担，
    // 在这里排队会让下载完成瞬间对旧渠道再查一次（INV-13）。
    return;
  }

  // [并发] check 期间只登记待刷新渠道：立即改 availableUpdateChannel 会让旧请求
  // 返回的结果按新渠道解释，产生"旧通道版本被打上新通道标签"的错配。
  if (checkForUpdatesInFlight) {
    // 用户可能在启动检查尚未完成时切换 preview 开关。
    // 不能立刻改 availableUpdateChannel，否则旧请求返回时会把旧通道的版本标成新通道；
    // 这里只记录待刷新通道，等当前 check 收口后再重新请求 manifest。
    pendingManifestReleaseChannelRefresh = nextChannel;
    // 这条日志是"延迟生效"的唯一证据：用户切开关后界面不立即变化时，靠它确认请求已被登记而非丢弃。
    logger.info(
      `[auto-update] defer ${reason}: check already in flight, next channel=${nextChannel}`,
    );
    // 登记后立即返回：本次调用不再触碰 availableUpdateChannel，in-flight check 仍按
    // 它启动时锁定的 expected channel 收口（INV-14）。
    return;
  }

  // 取"当前状态所代表"的渠道而非直读变量：ready/downloading 态的渠道可能来自下载时锁定值，
  // 直读 availableUpdateChannel 会误判为已切换，从而发起一次多余重查（INV-12）。
  const currentChannel = getAutoUpdaterReleaseChannelForCurrentState();
  // 同渠道直接返回，避免每次保存设置都打一次 manifest：设置面板是整体提交，
  // 未改动的字段也会经过本函数。
  if (currentChannel === nextChannel) {
    // 记录 unchanged 而非静默返回：这条日志用于解释"我只改了别的设置为什么也出现 skip"，
    // currentChannel 与 nextChannel 相等时本就没有可广播的变化，这条 skip 属于预期噪声。
    logger.info(`[auto-update] skip ${reason}: channel unchanged (${nextChannel})`);
    // 返回前不动 menuState：渠道未变时把界面改成 checking，会让用户看到一次没有结果的闪烁。
    return;
  }

  // 在改动任何状态前落日志：后续 check 抛错时，需要能还原"是哪次渠道切换触发了它"。
  logger.info(
    `[auto-update] ${reason}: refresh manifest channel ${currentChannel} -> ${nextChannel}`,
  );
  // 先写渠道再清 available：clearAvailableUpdateState 是按渠道语义清旧版本信息的，
  // 顺序颠倒会让旧渠道的版本短暂带着新渠道标签留在 available 三元组里（INV-12）。
  availableUpdateChannel = nextChannel;
  // 必须清空旧 available：新渠道 manifest 返回前，旧渠道的版本仍可被渲染层读到并点击下载，
  // 那会把旧渠道的包按新渠道安装（INV-12）。
  clearAvailableUpdateState();
  // enabled=false 是本状态的语义：checking 期间禁用菜单与按钮，防止结果到达前再触发一次检查；
  // 结果收口时由 setAutoUpdaterMenuState 统一恢复（INV-1）。
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  // 世代号必须在发起请求前取得：结果回来时要用它判断"这次结果是否仍属于当前世代"（INV-3）。
  const checkId = beginAutoUpdateCheck();
  // 直接调用 electron-updater 而不复用 triggerCheckForUpdates：公共闸会再判一次 in-flight 并重新取渠道，
  // 而渠道刚被本函数改写，重取会把这次请求当成同渠道 skip（INV-20）。
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      // [失败路径] 安装流程已启动时吞掉 check 失败：用户已在退出路径上，此刻报错只会弹出一个
      // 无法处理的提示，并覆盖 install 后的状态（INV-8）。
      if (isUpdateTargetLocked()) return;
      // 失败日志带上 reason：同一 catch 覆盖设置切换、启动检查等多条触发路径，
      // 没有 reason 就无法判断是哪条路径的 manifest 请求失败。
      logger.error(`[auto-update] ${reason} check failed:`, err);
      // 失败必须回到"上一个可信状态"而不是停在 checking：checking 会让菜单永久禁用，
      // 轮询虽会再查，但用户已无法手动重试（INV-9）。
      setAutoUpdaterMenuState(
        readyUpdateVersion
          // 有 ready 版本时回到"可安装"：切渠道失败不该把已下载好的包降级成 idle，
          // 否则用户失去"重启即安装"入口（INV-4）。
          ? buildUpdateDownloadedState(readyUpdateVersion)
          // 无 ready 才回 idle 并重新开放 enabled：enabled 必须在这里恢复，
          // 因为 checking 是用 enabled=false 写进去的（INV-1）。
          : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      // 收口放在 finally：checkForUpdates 成功但结果被判为 stale 时同样要清 in-flight 与世代，
      // 否则下一次检查会被永久挡住（INV-3）。
      finishAutoUpdateCheck(reason, checkId);
    });
}

// 状态同步是"拉"而不是"推"：窗口就绪时主动取一次 menuState，
// 弥补它错过广播的时间窗；销毁检查避免向已释放的 webContents 发送。
export function syncAutoUpdaterStateToWindow(win: BrowserWindow) {
  // [失败路径] 窗口销毁后 webContents.send 会抛错：该异常发生在窗口恢复流程中，
  // 会打断后续窗口的状态同步。
  if (win.isDestroyed()) {
    // 静默返回：新窗口重建后会再调一次本函数，这里不是丢消息，而是把投递推迟到有接收方时。
    return;
  }

  // 无条件发当前 menuState（含 idle）：renderer 靠这条消息覆盖自己缓存的旧状态，
  // 跳过 idle 会让重开的窗口停在上一轮的 downloading（INV-1 的拉取侧）。
  win.webContents.send(PlatformChannels.UpdateStateChanged, menuState);
}

// 说明只投给一个窗口并等待 ack：所有窗口同时弹说明会导致重复 ack，
// 且用户关掉任意一个归档就算 ack，其他窗口的弹窗就成了无人收口的孤儿。
// 未来版本的说明直接不投递，避免在旧版本上展示新版本内容。
export function syncPostUpdateReleaseNotesToWindow(win: BrowserWindow) {
  // 投递前置条件：既要有待投说明，也要有活着的接收方；缺一即返回，
  // 因为说明是单窗口 ack 语义，投给不存在的窗口等于把这份说明提前吃掉（INV-16）。
  if (!pendingPostUpdateReleaseNotes || win.isDestroyed()) {
    // 缺 pending 或窗口已销毁时直接返回：投递与持久化都不应发生在不存在的目标上（INV-16 的投递侧）
    return;
  }

  // 版本仍高于当前 app 说明更新尚未安装；此刻投递会被 renderer 静默 ack，等于在旧版本上吃掉新版本说明
  if (isPendingReleaseNotesForFutureVersion(pendingPostUpdateReleaseNotes)) {
    // pending release notes 是下载完成时写入的；若版本仍高于当前 app，
    // 说明更新尚未安装，不能提前作为“安装后说明”发给 renderer 静默 ack。
    return;
  }

  // 反查当前持有者时要确认窗口仍存活：webContentsId 会被回收复用，只比数字会把说明投给同 id 的新窗口
  const assignedWindow = findLiveWindowByWebContentsId(
    deliveredPostUpdateReleaseNotesWebContentsId,
  );
  // 已有窗口持有时拒绝其他窗口：说明只会被 ack 一次，
  // 多窗口同时展示会让未 ack 的那个成为永不关闭的孤儿弹窗。
  if (assignedWindow && assignedWindow.webContents.id !== win.webContents.id) {
    // 已有其他窗口持有时拒绝投递（INV-16 单窗口语义），否则未 ack 的那个会变成永不关闭的孤儿弹窗
    return;
  }

  // 先占位再发送：如果先 send 再记录，窗口在 send 后立即 reload 会再次命中
  // "无主"分支，把 pendingPostUpdateReleaseNotes 重复投递给同一个窗口。
  deliveredPostUpdateReleaseNotesWebContentsId = win.webContents.id;
  // 记录 webContentsId 与 version，必须能对照 ack 日志确认「发给了谁、确认的是哪个版本」
  logger.info(
    `[auto-update] sync post-update release notes to window ${win.webContents.id}: ${pendingPostUpdateReleaseNotes.version}`,
  );
  // 投递后不在这里清空 pending：用户尚未 ack，清空会让说明永久丢失；
  // 清理只由 acknowledge 或版本过期触发。
  win.webContents.send(PlatformChannels.PostUpdateReleaseNotes, pendingPostUpdateReleaseNotes);
}

// ack 以 version 校验：renderer 可能延迟确认旧说明，此时 pending 已换成新版本，直接清除会把新版本的说明误删。
// 信任边界（D-7-1，未修）：这里只校验 version、不校验发送方 webContents.id，任意 renderer 拿到版本号就会清掉全局 pending，
// 被投递窗口的弹窗随即成为孤儿；调用方 desktopMainIpcPlatform 也没有补这层校验。
// 幂等边界（D-7-2，未修）：acknowledgedPostUpdateReleaseNotesVersions 只在内存，重启后 ack 记录会丢失；
// clearPendingPostUpdateReleaseNotes 落盘失败时磁盘记录仍在，下次启动会重新投递同一份说明（仅本次运行不重复）。
export async function acknowledgePostUpdateReleaseNotes(
  // 入参 version 是幂等键而不是展示字段：ack 必须证明确认的正是当前 pending 的版本
  version: string,
  // 设置服务按参数注入而非读模块级变量：调用方可能是测试替身，且 init 未执行时也要能落盘
  settingService: SettingServiceLike,
) {
  // 无 pending 时 ack 是迟到的重复消息，直接吞掉可让重复 ack 天然幂等（INV-16）
  if (!pendingPostUpdateReleaseNotes) {
    // 记录无 pending 的 ack：线上出现「弹了但没清」时要能区分是没投递还是 ack 丢失
    logger.info(
      `[auto-update] ignore release notes ack without pending payload version=${version}`,
    );
    // 不写 acknowledged 集合：没有 pending 就没真正消费过说明，记进集合会污染本次运行的幂等判断
    return;
  }

  // 版本不等说明 renderer 确认的是旧说明，直接清除会把新版本的 pending 误删（INV-16）
  if (pendingPostUpdateReleaseNotes.version !== version) {
    // 用 warn 而不是 info：版本错配通常意味着投递与 ack 之间存在竞态，需要被注意到
    logger.warn(
      `[auto-update] ignore release notes ack version mismatch expected=${pendingPostUpdateReleaseNotes.version} actual=${version}`,
    );
    // 保留 pending 等待正确版本的 ack，绝不能在这条分支上做任何清理
    return;
  }

  // 先记进程内幂等再落盘：落盘失败时至少本次运行不会重复弹同一版本（INV-16）
  acknowledgedPostUpdateReleaseNotesVersions.add(version);
  // 清理原因写成 renderer-acknowledged：跨进程排查时能区分「用户确认」与「版本过期」两条清除路径
  await clearPendingPostUpdateReleaseNotes(settingService, "renderer-acknowledged");
}

// [资源] init 可能因窗口重建/设置服务替换被再次调用，因此进入时先清定时器与世代标记，
// 再重新绑定 provider 与 IPC。重复注册 ipcMain.handle 会抛错，
// 这也是本函数只在 Main 装配阶段调用一次的原因。
// enabled=false 分支必须早退：它连 feed 都不配置，避免向占位地址发请求。
export async function initAutoUpdater(options: InitAutoUpdaterOptions = {}): Promise<void> {
  // enabled=false 是产品形态决策，必须早于任何 provider 配置与事件注册，否则会对占位 feed 发真实请求
  if (options.enabled === false) {
    // 记住禁用态，让后续手动检查在模块内部 fail-closed（checkForUpdateMenuClick 的第二道闸）
    autoUpdaterDisabledForProductFlavor = true;
    // 禁用时也要清掉可能已存在的轮询：它下一次 tick 会触发检查并绕过禁用判定
    if (autoUpdatePollTimer) {
      // 清句柄必须发生在置空之前，否则 clearInterval 拿到 null 会漏掉仍在计时的旧 timer
      clearInterval(autoUpdatePollTimer);
      // 置空让后续路径看到「未轮询」，不会误以为已有定时器在跑
      autoUpdatePollTimer = null;
    }
    // 用固定文案标记本 flavor 禁用，和「未打包」跳过区分开，避免排查时把两种跳过混为一谈
    logger.info("[auto-update] disabled for this desktop product flavor");
    // 连 provider 都不配置：实例保持未初始化，autoDownload 等默认值不会被本模块改写
    return;
  }
  // 显式复位 autoUpdaterDisabledForProductFlavor：同一进程内切换产品形态（如测试装配）时，
  // 残留的 true 会让后续手动检查全部走 dev-skipped 分支。
  autoUpdaterDisabledForProductFlavor = false;
  // 未打包且未显式开启时直接返回：不配置 provider、不注册事件，
  // 让实例保持"从未初始化"，避免 dev 误连生产 feed。
  if (!canUseAutoUpdaterInCurrentRuntime()) return;

  // 退出准备回调只在初始化时注入一次：它绑定的是 Main 的 Host/Agent 生命周期，
  // 换成别的实现会绕过资源释放，因此不做按次覆盖。
  onBeforeQuitAndInstall = options.onBeforeQuitAndInstall;
  // locale 只在显式传入时覆盖：undefined 不能把默认语言写成空值，否则菜单文案查表会落空
  if (options.locale) {
    // 菜单文案语言取自装配方，之后的 checkForUpdateMenuClick 与状态广播都读这个值
    menuLocale = options.locale;
  }
  // 保存设置服务供后续异步路径复用：下载完成、跳过版本、ack 说明都可能在
  // init 的调用栈之外触发，不能依赖闭包参数。
  autoUpdaterSettingService = options.settingService;

  // 初始化时清掉上一轮定时器：重复 init（窗口重建）若不清理，
  // 会留下两个按不同间隔触发的轮询，检查频率翻倍。
  if (autoUpdatePollTimer) {
    // 重复 init 时先清旧轮询：两个按不同间隔触发的 timer 会让检查频率翻倍
    clearInterval(autoUpdatePollTimer);
    // autoUpdatePollTimer 置空后 scheduleAutoUpdatePoll 才能正确判断是否需要重建
    autoUpdatePollTimer = null;
  }
  // 重新初始化必须把上一轮的互斥记账全部归零：残留的 in-flight 会让本次
  // 启动检查被直接丢弃，残留的 pending 渠道会让首轮结果被判 stale。
  // 两组状态字段也需要清空，避免新 provider 收到旧通道的候选版本。
  checkForUpdatesInFlight = false;
  // 互斥记账归零：残留 id 会让新的 catch/finally 校验世代时永远不匹配（INV-3）
  activeAutoUpdateCheckId = null;
  // 清 expected channel：否则首轮结果会被 shouldIgnoreStaleAvailableUpdate 判成 stale（INV-14）
  activeAutoUpdateCheckChannel = null;
  // settling 槽位同样归零，否则上一轮未收口的结果会卡住本次启动检查
  settlingAutoUpdateCheckId = null;
  // 丢弃未执行的渠道刷新：新 provider 尚未配置，沿用旧请求会把 preview 结果标成 stable（INV-13）
  pendingManifestReleaseChannelRefresh = null;
  // 先清 dev 版本覆盖，随后 applyDevAutoUpdateRuntimeOverrides 会按当前开关重新求值
  devAutoUpdateVersionOverride = null;
  // 通道复位为 stable：新 provider 的首轮结果不应继承上一轮用户选择的 preview（INV-12）
  availableUpdateChannel = "stable";
  // 清 available 组，避免新通道的候选版本读到旧 release notes（INV-12）
  clearAvailableUpdateState();
  // 清 downloading 组及其 token 配对字段，防止上一轮取消的 token 影响新下载（INV-5）
  clearDownloadingUpdateState();
  // 覆盖必须在配置 provider 之前完成：否则 provider 初始化时会用旧版本号
  // 参与一次版本判定，首个 manifest 请求可能被错误地判成"无更新"。
  applyDevAutoUpdateRuntimeOverrides();

  // 记录实际参与比较的版本，方便对照"产品版本 / 壳版本 / dev 覆盖"三者差异，
  // 产品版本、壳版本与 dev 覆盖三者不一致时，绝大多数更新异常都能从这条日志看出端倪。
  logger.info(`[auto-update] initializing, current version: ${getCurrentAppVersionForUpdate()}`);

  // [权衡] autoUpdater.autoDownload = false：electron-updater 只按"当前 app 版本"判断是否需要下载，无法感知"已 ready 的旧版本"；
  // 是否下载由 shouldDownloadAvailableUpdate 接管比较，避免每次轮询都再次下载同一个版本。
  // 已下载旧版本后，feed 继续推进到更高版本时，主进程必须先比较远端版本和 ready 版本，
  // 再决定是否下载。若继续让 electron-updater 自动下载，它只会按当前 app 版本判断，
  // 导致 `3.1.2` 已 ready `3.1.3` 时每次轮询都可能重复下载 `3.1.3`。
  autoUpdater.autoDownload = false;
  // Bugfix: Windows/NSIS 在窗口关闭后会异步启动安装；如果用户紧接着关机，安装器可能被系统中断，
  // 留下半更新状态并导致下次启动失败。macOS/Linux 也先关掉退出即装，只在 ready 包仍等于当前目标时
  // 由 before-quit 主动安装，避免目标已经升高后退出装上旧包。
  autoUpdater.autoInstallOnAppQuit = false;
  // 复用宿主 logger 而不是自建实例：更新日志需要与 Host/Agent 日志同一条
  // 连接日志流，否则线上排查时要跨文件对齐时间线。
  autoUpdater.logger = logger;
  // 在 autoDownload/autoInstallOnAppQuit 置位之后配置 provider：provider 初始化会读这两个开关决定行为
  applyManifestUpdateProvider(options);

  // 所有检查的统一入口：启动、轮询、下载后重查都调用 triggerCheckForUpdates，因此互斥、状态守卫与世代记账只需要维护一份，漏改任一处都会让两套记账分叉。
  const triggerCheckForUpdates = (reason: string) => {
    // 安装流程一旦启动，任何来源的检查都必须失效（INV-6）
    if (quitAndInstallState !== "idle") return;
    // 统一入口的第一道互斥（INV-20）：三个触发源共享，重复请求直接丢弃
    if (checkForUpdatesInFlight) {
      // checkForUpdatesInFlight 为真时只记日志不改状态：本轮请求不需要在 UI 上留下痕迹
      logger.info(`[auto-update] skip ${reason}: check already in flight`);
      // 不排队也不合并结果：当前在途检查的结果会照常广播，本轮请求无需补偿
      return;
    }

    // 已展示的目标不能被一次复查盖成 checking。下载中也不另起检查，等这次下载结束后再查。
    if (reason === "poll" && !canPollForUpdatesFromState(menuState)) {
      // poll 的条件不满足时记录当时的 menuState.kind，便于确认是「已有目标」还是「正在下载」
      logger.info(`[auto-update] skip ${reason}: state=${menuState.kind}`);
      // poll 在无可见目标或下载中直接跳过：canPollForUpdatesFromState 是轮询独有的守卫
      return;
    }

    // 读设置是异步的：begin 已锁定 expected channel，await 之后必须再次检查安装锁，
    // 否则退出准备已经开始时仍会向 Host 发一次 check 请求。
    // checkId 在这里生成而不是在 Promise 内，保证 catch/finally 能校验同一世代。
    const checkId = beginAutoUpdateCheck();
    // 有三元分叉的原因：无设置服务时不能 await 渠道同步，必须直接复用原生的 Promise
    const checkForUpdatesPromise = options.settingService
      // 包成 IIFE 才能把「同步渠道 + 检查」串成一个可被同一 catch/finally 收口的 Promise
      ? (async () => {
          // 先同步渠道再检查：provider 的 feed 由渠道决定，顺序反过来会打到上一个通道（INV-13）
          await syncAutoUpdateCheckChannelFromSettings(checkId, options.settingService, reason);
          // await 之后必须重新检查安装锁：期间退出准备可能已开始（INV-19）
          if (isUpdateTargetLocked()) return;
          // 真实请求点；结果事件可能早于 resolve 到达，状态写入不依赖这里的返回值
          await autoUpdater.checkForUpdates();
        })()
      // 无设置服务时不包 async：少一层微任务，也避免 await 改变 rejected Promise 的抛出形态
      : autoUpdater.checkForUpdates();

    // 统一收口：两条分叉共用同一 catch/finally，保证互斥释放路径唯一
    checkForUpdatesPromise
      .catch((err) => {
        // 强更弹窗可能复用启动期后台检查；如果 checkForUpdates 直接 reject 且没有后续 error 事件，
        // 只写日志会让弹窗停在 checking。这里复用失败收敛逻辑，把状态恢复并反馈给强更监听。
        handleAutoUpdateFailure(err, `${reason} check failed`);
      })
      .finally(() => {
        // 按 checkId 校验世代后再释放（INV-3）：迟到旧检查不能清掉新一轮的 in-flight
        finishAutoUpdateCheck(reason, checkId);
        // 每次收口后重算轮询节奏：状态可能已从 checking 变成 available 或 ready
        ensureAutoUpdatePollInterval();
      });
  };
  // 下载结束/失败后的重查分两种：失败要等当前检查收口（用 pending 标记），
  // 完成则已被这次检查覆盖，不再排队。区分两者是为了避免失败原因被吞掉。
  recheckAfterDownload = (recheckReason: string) => {
    // 下载失败需要等当前检查收口。完成和取消的结果已经被这次检查覆盖，不再排队。
    if (checkForUpdatesInFlight) {
      // 只有失败需要排到当前检查之后：完成或取消的结果已被本次检查覆盖
      if (recheckReason === "download-failed") {
        // 用标记而不是立即重查：在途检查收口后会读它补一次，否则失败原因会被吞掉
        pendingFailedDownloadRecheck = true;
      }
      // 其余 recheckReason 直接丢弃，避免在途期间堆叠出多次检查
      return;
    }
    // 空闲时才真正重查，仍走 triggerCheckForUpdates：互斥与世代记账不另写一份
    triggerCheckForUpdates(recheckReason);
  };

  // checking-for-update 只在 hasVisibleUpdateTarget 为假且非 download-progress 时改写 UI，否则会把已展示的版本降级成没有信息量的"正在检查"。
  autoUpdater.on("checking-for-update", () => {
    // 安装锁生效后不再改写 UI 状态（INV-8）
    if (isUpdateTargetLocked()) return;
    // checking 事件在早退前记日志：排查时要能看到「检查确实开始过」
    logger.info("[auto-update] checking for update...");
    // 已有可见目标或下载中时不改写 UI：否则版本信息会被降级成没有信息量的 checking
    if (hasVisibleUpdateTarget(menuState) || menuState.kind === "download-progress") {
      // 早退即保持原状态：这是「菜单文案不抖动」的唯一实现点
      return;
    }
    // 仅在真正空档时切 checking：enabled=false 让菜单在检查期间不可重复触发
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  });

  // update-available 是整条链路信息量最大的事件：它决定是否下载、是否跳过、
  // 是否恢复伪 ready，以及是否反馈给手动检查/强更。
  // 因此这里用 settleAutoUpdateCheckResult 包住全部异步处理，而不是只包同步部分。
  autoUpdater.on("update-available", (info: UpdateDownloadedInfoLike) => {
    // available 到达时安装流程已启动则直接丢弃，避免与退出流程竞争（INV-8）
    if (isUpdateTargetLocked()) return;
    // 版本号取自事件本身而非 menuState：这是本轮结果的唯一权威来源
    logger.info(`[auto-update] new version available: ${info.version}`);
    // 先归一通道：后续 stale 判定与跳过记录都依赖同一个 channel 值
    const infoChannel = readUpdateInfoReleaseChannel(info);
    // 旧通道的迟到结果必须整条丢弃（INV-14），否则会把 preview 的新版本标成 stable
    if (shouldIgnoreStaleAvailableUpdate(infoChannel)) {
      // 用户切换“接收 preview 版本”时，旧通道的 manifest 请求可能晚于新请求返回。
      // 旧结果如果继续写 menuState，或提前结束当前 generation，会让独立更新弹窗继续显示旧版本/旧 release notes。
      logger.info(
        `[auto-update] ignore stale update channel=${infoChannel} expected=${activeAutoUpdateCheckChannel ?? availableUpdateChannel} version=${info.version}`,
      );
      // 不结束当前 generation：这次迟到结果不代表本轮检查完成，收口权属于现役检查
      return;
    }

    // 用 settle 包住全部异步处理：isSkippedUpdateVersion 与 shouldAutoDownload 都在 await，必须整体纳入收口（INV-3）
    void settleAutoUpdateCheckResult("update available", async () => {
      // 远端版本不高于 ready 时保留已下载的包：重新下载既浪费流量，
      // 也会让用户已经看到的"可安装"入口短暂消失。
      if (!shouldDownloadAvailableUpdate(info.version)) {
        // 远端不高于 ready 时沿用已下载版本：避免重复下载，也保住用户已看到的安装入口
        const readyVersion = readyUpdateVersion ?? info.version;
        // 日志同时给出 ready 与 remote 两个版本：判断「保留旧包」是否正确只看这一条
        logger.info(
          `[auto-update] keep downloaded update version=${readyVersion}; remote=${info.version}`,
        );
        // 重建 ready 投影而不是写 available：此时的事实是「包已落地」
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyVersion));
        // 手动检查要拿到确定性终态，否则按钮会停在等待
        sendManualCheckResult({ kind: "ready", version: readyVersion });
        // 不进入下载分支：这是「保留已下载包」的收口点，menuState 保持 update-downloaded
        return;
      }

      // 渠道优先取 info 自带值：它代表"这个版本属于哪个通道"，
      // 而 availableUpdateChannel 可能在请求期间被设置改动过。
      const channel = infoChannel ?? availableUpdateChannel;
      // 跳过判定是异步读设置，await 之后必须重新确认安装锁（2124）
      const skipped = await isSkippedUpdateVersion(info.version, channel, options.settingService);
      // await 期间可能已进入安装流程（INV-8）
      if (isUpdateTargetLocked()) return;
      // 已跳过版本按「无更新」处理：清 available 并回 idle，而不是继续弹下载
      if (skipped) {
        // 记录 channel 与 version：跳过记录按渠道存储，错渠道的跳过不应影响本通道
        logger.info(
          `[auto-update] ignore skipped update channel=${channel} version=${info.version}`,
        );
        // 清 available 组：否则被跳过的版本仍会出现在菜单里（INV-12）
        clearAvailableUpdateState();
        // 回 idle 并恢复 enabled，让用户仍能手动再查一次
        setAutoUpdaterMenuState({ kind: "idle", enabled: true });
        // 手动检查要回 up-to-date 而不是沉默，否则按钮没有终态
        sendManualCheckResult({
          // 被跳过的版本对用户等价于「没有可用更新」：update-available 收窄成 up-to-date 是刻意的
          kind: "up-to-date",
          // 带上 currentVersion 本地版本，便于用户与日志对照「跳过的是哪个远端版本」
          currentVersion: getCurrentAppVersionForUpdate(),
        });
        // 跳过分支到此结束：不写 available 说明，也不再下载
        return;
      }

      // 先写 available 的说明，再决定是否下载：下载入口会把它复制到 downloading，
      // 这样即使 available 被清空，下载态仍能带上正确的 release notes。
      availableUpdateReleaseNotes = toPostUpdateReleaseNotesPayload(info);
      // 伪 ready 只由 pending 说明恢复，缺 electron-updater 的下载上下文；manifest 再次确认同版本时必须清掉重下（INV-4）
      if (readyUpdateRestoredFromPendingReleaseNotes) {
        // pendingPostUpdateReleaseNotes 只能证明“曾经下载完成并持久化了版本说明”，
        // 不能恢复当前进程里的 electron-updater downloadedUpdateHelper、Squirrel.Mac proxy server
        // 或 native staged update。遇到 manifest 再次确认同版本可用时必须清掉伪 ready，
        // 重新 downloadUpdate，让缓存命中/重新下载后的 update-downloaded 建立真实安装上下文。
        clearReadyUpdateState();
      }
      // 写 available 并携带说明与 channel：下载入口会从这里复制到 downloading（INV-12）
      setAutoUpdaterMenuState(
        buildUpdateAvailableState(info.version, availableUpdateReleaseNotes, channel),
      );

      // 强更优先于用户偏好：强更意味着该版本必须安装，不能因为
      // autoDownloadAndInstallUpdates=false 就停在 update-available。
      if (activeForceAutoUpdateListener) {
        // 强更优先于用户偏好：autoDownloadAndInstallUpdates=false 也不能让它停在 available
        downloadAvailableUpdate("force-update");
        // 强更分支直接接管下载，不再回执 available：弹窗通过 force 监听拿状态
        return;
      }

      // 自动下载偏好属于 main 状态机，不能依赖 renderer 弹窗是否打开
      const autoDownload = await shouldAutoDownloadAndInstallUpdates(options.settingService);
      // await 期间安装流程可能已启动（INV-8）
      if (isUpdateTargetLocked()) return;
      // 开启自动下载时复用手动下载入口，保持取消、缓存命中与失败恢复行为完全一致
      if (autoDownload) {
        // 功能原因：自动下载偏好属于 main 进程更新状态机，不能依赖 renderer 弹窗是否打开。
        // 检测到更新后复用手动下载入口，保持取消、缓存命中、失败恢复等行为完全一致。
        downloadAvailableUpdate("auto-download");
        // 自动下载分支不再回执 available：后续状态由 progress/ready 事件推进
        return;
      }

      // 既不自动下载也不是强更时，才把选择权交回发起窗口：sendManualCheckResult 带「有更新待下载」
      sendManualCheckResult({
        // 终态是「有更新待下载」，renderer 据此展示下载按钮
        kind: "available",
        // 用远端归一后的版本：与 menuState 中的版本同源，避免 UI 两处显示不同
        version: info.version,
        channel,
        ...(availableUpdateReleaseNotes ? { releaseNotes: availableUpdateReleaseNotes } : {}),
      });
    }).catch((error) => {
      // 异步处理失败统一收敛：不能只记日志，否则菜单会停在 checking（INV-9）
      handleAutoUpdateFailure(error, "update available failed");
    });
  });

  // 无更新事件也要区分三种情形：仍有 ready（保留入口）、仍有可见目标
  // （只回填手动检查结果）、确实什么都没有（清空并回到 idle）。
  // 直接无脑清空会让用户在"已下载但远端暂未更新"时丢失安装入口。
  autoUpdater.on("update-not-available", (info) => {
    // 无更新事件同样受安装锁约束（INV-8）
    if (isUpdateTargetLocked()) return;
    // 无更新也要收口：settleAutoUpdateCheckResult 释放互斥并结束手动检查的等待
    void settleAutoUpdateCheckResult("update not available", () => {
      // 同时打印本地与远端版本：判断「确实无更新」还是「版本比较退化」只能靠这两个值
      logger.info(
        `[auto-update] already up to date (local=${getCurrentAppVersionForUpdate()}, remote=${info.version})`,
      );
      // 仍有 ready 且是当前目标时保留安装入口：远端暂未推进不等于本地包失效（INV-7）
      if (readyUpdateVersion && isReadyUpdateCurrentTarget()) {
        // 维持 ready 投影，不回 idle：否则用户会丢失已经下载好的安装入口
        setAutoUpdaterMenuState(buildUpdateDownloadedState(readyUpdateVersion));
        // 手动检查拿到 ready 终态，用户可直接安装
        sendManualCheckResult({ kind: "ready", version: readyUpdateVersion });
        // ready 分支收口，不再走「可见目标」或「全清」两条路
        return;
      }
      // 仍有可见目标时只回填回执，不降级状态：避免菜单闪成 idle
      if (hasVisibleUpdateTarget(menuState)) {
        // 用当前目标的版本与 channel 回执，保持与菜单显示一致
        sendManualCheckResult({
          // 对用户而言仍是「有更新可用」，不是 up-to-date
          kind: "available",
          // 版本取值按状态分叉：update-available 用菜单值，其余退 ready 版本，最后由空串兜底
          version:
            // 这里不能用 info.version：无更新事件里的远端版本可能比本地目标更旧，回执会自相矛盾
            menuState.kind === "update-available" ? menuState.version : (readyUpdateVersion ?? ""),
          ...("channel" in menuState && menuState.channel ? { channel: menuState.channel } : {}),
        });
        // 回执后结束：不清空 menuState，菜单继续展示既有目标
        return;
      }

      // 先清状态字段再写 idle：确保 2205 不残留 available/downloading 的版本（INV-12）
      clearAvailableUpdateState();
      // downloading 组与 token 成对清理，避免下一轮读到已取消下载的渠道（INV-5）
      clearDownloadingUpdateState();
      // 真正无更新才回 idle，并恢复 enabled，让菜单项恢复可点
      setAutoUpdaterMenuState({ kind: "idle", enabled: true });
      // 强制升级弹窗复用启动期检查时，也必须在无可用更新时给出闭环反馈，避免一直停在 checking。
      notifyForceAutoUpdate({
        // 强更弹窗用 error 而不是 up-to-date：强更场景下「没有可用更新」是异常，需要用户看到明确原因
        kind: "error",
        // 文案走共享取词，保证中英文一致且可被测试断言
        message: getForceAutoUpdateNoUpdateMessage(),
      });
      // 手动检查同时回执 up-to-date：弹窗与按钮两条通道都要有终态
      sendManualCheckResult({
        // 与强更的 error 不同，按钮路径认为这是正常的「无更新」结果
        kind: "up-to-date",
        // 带上 currentVersion，供 UI 展示「已是最新 x.y.z」
        currentVersion: getCurrentAppVersionForUpdate(),
      });
    });
  });

  // download-progress 的三个守卫是 isUpdateTargetLocked、token 已取消与无下载上下文，所以任一缺失都会让 UI 回退。
  // 任一缺失都会让 UI 在取消后又被推回下载态，或让进度写入错误的版本。
  autoUpdater.on("download-progress", (progress) => {
    // 进度事件的第一个守卫：安装中不再推进 UI（INV-8）
    if (isUpdateTargetLocked()) return;
    // 用户快速取消下载后，electron-updater 可能还会补发旧下载流的 progress。
    // 如果继续接收这个陈旧事件，UI 会从“可更新”被重新推回“下载中”，看起来像取消后卡住。
    if (!downloadCancellationToken || downloadCancellationToken.cancelled) {
      // token 缺失或已取消时丢弃 progress：迟到的旧下载流会把 UI 从 update-available 拉回下载中（INV-5）
      return;
    }

    // 只有 download-progress 与 update-available 两种状态能接受进度：其他状态说明该事件属于已被替换的下载
    if (menuState.kind !== "download-progress" && menuState.kind !== "update-available") {
      // 丢弃且不改写状态：保证「取消后不会闪回下载态」
      return;
    }

    // normalize 失败时退回 toFixed(0)：percent 理论上一定存在，
    // 但 normalizeProgressPercent 失败时这里不抛错，避免一个畸形事件中断整条下载链路。
    const normalizedProgress = normalizeProgressPercent(progress) ?? progress.percent.toFixed(0);
    // 进度日志同时打印 bytesPerSecond 与已传/总量：弱网停滞与「总量估算跳变」要靠这两组数区分
    logger.info(
      `[auto-update] download progress: ${progress.percent.toFixed(1)}% (${(progress.bytesPerSecond / 1024).toFixed(0)} KB/s, ${(progress.transferred / 1024 / 1024).toFixed(1)}/${(progress.total / 1024 / 1024).toFixed(1)} MB)`,
    );
    // 首个 progress 到达时把 available 转成下载态，这是状态机唯一的前进点
    if (menuState.kind === "update-available") {
      // 清 available 组，避免 downloading 与 available 两组字段同时有效（INV-12）
      clearAvailableUpdateState();
    }
    // 进度写入必须走 buildDownloadProgressState：它负责一并带上字节量，缺了字节的进度条无法显示「已传/总量」
    setAutoUpdaterMenuState(
      buildDownloadProgressState(normalizedProgress, {
        // transferred 与 total 同源取自原生事件：不能用百分比反推字节量，总量估算会随事件漂移
        transferredBytes: progress.transferred,
        // total 可能是估算值，只供展示；这里不做取整或修正，保持与原生事件一致
        totalBytes: progress.total,
      }),
    );
    // 强更日志按桶限流：进度事件频率高，逐条打印会把主机日志刷满
    logForceAutoUpdateProgress(normalizedProgress);
    // 同一份进度要广播给强更弹窗：它不订阅 menuState，只通过 force 监听拿阶段
    notifyForceAutoUpdate({
      // 阶段值与 menuState.download-progress 对齐，弹窗据此渲染进度条
      kind: "downloading",
      ...(downloadingUpdateVersion ? { version: downloadingUpdateVersion } : {}),
      // 透传 normalizedProgress 进度串，主进程不再格式化百分比，避免出现第二套口径
      progress: normalizedProgress,
    });
  });

  // [并发] 有 token 说明下载仍在途：此时只暂存，等 downloadUpdate Promise 收口后再发布。
  // updater 会在 downloadUpdate Promise 收口前同步发 ready；若立即 publishDownloadedUpdate，就会在缓存写入失败时让用户看到"可安装"而实际包并不完整。
  autoUpdater.on("update-downloaded", (info: UpdateDownloadedInfoLike) => {
    // update-downloaded 到达时安装流程已启动则丢弃：此时安装器已接管，发布新 ready 会覆盖安装上下文（INV-4/INV-8）
    if (isUpdateTargetLocked()) return;
    // 有 token 说明下载仍在途：ready 只是事件早到，不能当作「包已可用」（INV-4）
    if (downloadCancellationToken) {
      // updater 会在 downloadUpdate Promise 收口前同步发 ready；缓存写入仍可能失败并清包。
      // 以下载成功为唯一发布点，避免安装依赖无完成保证的在途下载，也避免失败包被提前安装。
      if (!downloadCancellationToken.cancelled) {
        // 只暂存不发布：等 downloadUpdate 的 Promise 收口后才由发布路径调用 publishDownloadedUpdate
        pendingDownloadedUpdate = { token: downloadCancellationToken, info };
      }
      // 暂存后立即返回，绝不能在 token 存活期间 publish：缓存写入仍可能失败并清包
      return;
    }
    // 无 token 说明这是缓存命中的同步 ready，可直接发布；这是唯一「没有在途下载」的发布路径
    publishDownloadedUpdate(info);
  });

  // error 事件的来源不唯一：check、download、native staging 都会走这里，
  // 只能靠 detail 前缀与当前状态区分。误判会让安装期的原生错误
  // 被当成一次普通检查失败，从而只回退到 idle 而不触发恢复。
  autoUpdater.on("error", (err, detail: unknown) => {
    // 锁定依赖中 checkForUpdates 会携带这个来源，Mac 原生错误仅传 Error。
    // 已接受的检查可以迟到失败，不能把它误判成正在安装的原生包失败。
    if (typeof detail === "string" && detail.startsWith("Cannot check for updates:")) {
      // detail 前缀表明这是 check 阶段的失败，交给后台检查的收敛路径，而不是安装期原生错误
      handleAutoUpdateFailure(err, "background check failed");
      // 分支收口：不再走下面的取消吞掉逻辑，避免把检查失败误判成取消
      return;
    }
    // 取消后 updater 会异步补发 error(cancelled)，必须在通用失败处理之前拦截（INV-11）
    if (shouldIgnoreCancelledDownloadError(err)) {
      // electron-updater 在取消下载后可能异步补发 error("cancelled")。
      // 用户取消已经把状态恢复到可重试的 update-available，迟到取消事件不能再清空入口。
      logger.info("[auto-update] ignore delayed error from cancelled download");
      // 吞掉即返回：配额消耗与实际错误匹配由 shouldIgnoreCancelledDownloadError 内部记账保证
      return;
    }

    // 其余错误属于安装期原生失败，必须走 settle + handleAutoUpdateFailure，触发恢复而不是简单回 idle（INV-6）
    void settleAutoUpdateCheckResult("error", () => {
      // 交给统一失败处理：它按 quitAndInstallState 决定回退还是重启（INV-8）
      handleAutoUpdateFailure(err, "error");
    });
  });

  // [并发] 同一通道同时注册 handle 与 on：handle 供需要 ACK 的 renderer 调用，
  // on 兼容旧版只发不等待的客户端。两条路径都收敛到同一个幂等入口，
  // 不会因为 renderer 版本差异出现"有的能装、有的不能装"。
  ipcMain.handle(PlatformChannels.QuitAndInstallUpdate, () =>
    // renderer 只有在 IPC reject 时才知道安装器没有接管。ready 失效或
    // 退出准备失败不能返回成功 ACK，否则“重启以更新”会永久保持 pending。
    quitAndInstallUpdate(true),
  );
  // on 版本不返回 Promise：它只用于"发完即忘"的旧客户端，
  // 失败也不会 reject，因此错误只能通过状态广播让 UI 自愈。
  ipcMain.on(PlatformChannels.QuitAndInstallUpdate, () => {
    // 旧客户端走 on 通道：发完即忘，失败只能靠状态广播自愈，因此这里不接 Promise
    void quitAndInstallUpdate();
  });
  // handle 版本供需要 ACK 的新客户端调用，返回值即「安装器是否已接管」
  ipcMain.handle(PlatformChannels.DownloadUpdate, () => {
    // 统一下载入口：renderer 与自动下载共用，保证取消与缓存命中行为一致
    downloadAvailableUpdate("renderer");
  });
  // 取消同样收敛到共享入口，token 与配额记账不在此处重复实现（INV-10）
  ipcMain.handle(PlatformChannels.CancelUpdateDownload, () => {
    // 传 renderer 作为 reason，便于日志区分是谁取消了下载
    cancelDownloadingUpdate("renderer");
  });
  // version 来自 renderer，必须做类型与空白校验：空串若写进跳过记录，
  // 会让"跳过列表"里出现一个无法匹配任何版本的空项。
  ipcMain.handle(PlatformChannels.SkipUpdateVersion, async (_event, version: unknown) => {
    // 先归一类型：renderer 可传任意值，非字符串一律按空串处理，不让对象进入设置服务
    const validatedVersion = typeof version === "string" ? version.trim() : "";
    // 空串不能写入跳过记录：否则跳过列表里会出现一个匹配不到任何版本的空项
    if (!validatedVersion) {
      // 用 warn：这通常意味着 renderer 侧参数构造有误，需要被注意到
      logger.warn("[auto-update] ignore empty skipped update version");
      // 静默返回：IPC 已被调用，不抛错以免在 renderer 侧产生未处理 rejection
      return;
    }
    // 复用共享入口写跳过记录：渠道判定与持久化都在那里，IPC 层不重复实现
    await skipAvailableUpdateVersion(validatedVersion, options.settingService);
  });

  // initAutoUpdater 启动即 triggerCheckForUpdates("startup") 一次，再挂轮询：定时器只负责后续节奏，
  // 若依赖定时器首跳会让冷启动后的第一次检查延迟一个完整间隔。
  triggerCheckForUpdates("startup");
  // 启动检查之后再挂轮询：定时器只负责后续节奏，冷启动首查不依赖首跳
  ensureAutoUpdatePollInterval();
  // [事务] 非 Windows 平台在用户退出时主动安装：条件是 ready 仍等于当前目标。
  // preventDefault 后异步安装，让 Electron 先完成本次退出事件分发再交给安装器。
  // Windows 交给 NSIS 自己处理，重复 preventDefault 会和安装器的退出流程打架。
  app.on("before-quit", (event) => {
    // 三个条件任一成立就不在这里安装：Windows 交给 NSIS、安装中不重复触发、ready 已非当前目标（INV-7）
    if (
      process.platform === "win32" ||
      quitAndInstallState !== "idle" ||
      !isReadyUpdateCurrentTarget()
    ) {
      // 直接返回不 preventDefault：让退出流程按平台默认继续，避免与 NSIS 的退出流程打架
      return;
    }
    // preventDefault 必须在任何 await 之前调用：事件分发结束后再调用已无效，
    // 窗口会先关闭，退出准备中的 Host/Agent 清理被强行中断。
    event.preventDefault();
    // preventDefault 之后才异步安装：必须让 Electron 先完成本次退出事件分发（INV-19）
    void quitAndInstallUpdate();
  });
}

// ensureAutoUpdatePollInterval 的节奏随状态变化，所以下载中停表、有可见目标用短间隔、其余用长间隔。
// 只有 autoUpdatePollIntervalMs 真正变化时才重建定时器，避免每次状态广播都重置计时。
function ensureAutoUpdatePollInterval() {
  // 下载中停表：进度事件本身已在高频推进 menuState，继续轮询只会重复触发 recheck 并与下载 token 抢状态
  if (menuState.kind === "download-progress") {
    // 停表必须三清一体：句柄、null 标记与间隔记录任一残留，都会让下一次 ensure 误判「已有同间隔定时器」而跳过重建
    if (autoUpdatePollTimer) {
      // 先清句柄再置空：顺序反过来会让 clearInterval 拿到已被覆盖的 null 而漏清旧定时器
      clearInterval(autoUpdatePollTimer);
      // 句柄为 null 是「当前未轮询」的唯一标记，2356 与 2359 两个分支都据此判断是否需要重建
      autoUpdatePollTimer = null;
      // 间隔记录同时清空，否则下载结束后 2356 会因「间隔未变」直接 return，轮询永久停摆
      autoUpdatePollIntervalMs = null;
    }
    // 下载期间的节奏由 progress 事件独占，此处无事可做，直接返回避免落入重建逻辑
    return;
  }
  // 按当前 menuState 重算目标间隔：有可见目标必须用 2 分钟、其余用 15 分钟，这是 INV-18 的节奏来源
  const nextInterval = resolveAutoUpdatePollInterval(menuState);
  // 间隔未变就保留原句柄：重建 setInterval 会把计时清零，状态广播一密集轮询就永远等不到触发点
  if (autoUpdatePollTimer && autoUpdatePollIntervalMs === nextInterval) {
    // 同间隔直接返回，不做 clear/重建，避免每次广播都产生一次无意义的定时器抖动
    return;
  }
  // 间隔变了才重建：这里必须先进后出，先清旧句柄再建新表，否则新旧定时器会短暂并存并各自触发一次 recheck
  if (autoUpdatePollTimer) {
    // 只清句柄不置空，因为紧随其后会立即写入新句柄，中间没有可被其他分支观察到的空窗
    clearInterval(autoUpdatePollTimer);
  }
  // 先记录新间隔再建表：setInterval 返回前若发生状态广播，2356 依赖这个字段判断是否需要再次重建
  autoUpdatePollIntervalMs = nextInterval;
  // 回调只投递 poll 原因，不直接调用 check：启动检查、失败重查、轮询必须共用 triggerCheckForUpdates 的同一道互斥闸（INV-20）
  autoUpdatePollTimer = setInterval(() => {
    // recheckAfterDownload 在装配完成前可能为空，可选链保证轮询空转而不抛错，也不吞掉后续重建
    recheckAfterDownload?.("poll");
  }, nextInterval);
  // [资源] autoUpdatePollTimer.unref 让定时器不阻止进程退出：否则用户关窗后 Node 事件循环
  // 仍被这个 AUTO_UPDATE_POLL_INTERVAL_MS（无目标 15 分钟）/ AUTO_UPDATE_VISIBLE_POLL_INTERVAL_MS（可见目标 2 分钟）句柄保活，应用表现为"关不掉"。
  autoUpdatePollTimer.unref?.();
}

// requestForceAutoUpdate 把"当前状态"翻译成 ForceAutoUpdateState 阶段序列，并复用同一套检查/下载/安装逻辑。
// 返回值是退订函数：弹窗关闭后必须解除单槽监听，否则后续状态会发给已销毁的回调。
export function requestForceAutoUpdate(
  // 参数即契约：调用方拿到的必须是可直接渲染的阶段值，不允许把 menuState 原样透传给弹窗
  onStateChange: (state: ForceAutoUpdateState) => void,
  reason = "force-update",
  // 下划线前缀是有意的：最低版本比较由上游 preload 侧完成，主进程不再二次使用，但签名要与调用方保持一致
  _minimumVersion?: string,
) {
  // dispose 只清"仍是自己"的槽位：期间可能有新的强更请求接管，
  // 无条件清空会把后来者的监听一起摘掉。
  const dispose = () => {
    // dispose 只摘「仍是自己」的槽位：期间可能已有新的强更请求接管单槽，无条件清空会把后来者的监听一起摘掉
    if (activeForceAutoUpdateListener === onStateChange) {
      // 置空即彻底退订：此后再有状态变化，2378 的调用方不会再收到任何回调
      activeForceAutoUpdateListener = null;
    }
  };

  // activeForceAutoUpdateListener 单槽覆盖而非追加：同一时刻只允许一个弹窗驱动更新流程，后到的强更请求直接接管状态投递
  activeForceAutoUpdateListener = onStateChange;
  // 进度分桶日志逐轮重置：新弹窗从 0% 开始，沿用上一轮桶号会吞掉前几档日志，看起来像「下载没动」
  forceAutoUpdateLastLoggedProgressBucket = null;
  // 只记 reason 不记版本：此刻尚未 check，任何版本号都可能是上一轮残留，写进日志会误导排查方向
  logger.info(`[force-update] 自动升级开始 reason=${reason}`);
  // 已在安装/恢复流程中时，强更只能报 installing；此处再触发 check 会在退出途中拉起第二次下载（INV-6）
  if (quitAndInstallState !== "idle") {
    // 投影 installing 而不是 checking：复用既有安装流程是唯一正确语义，报 checking 会让弹窗以为后面还有进度
    onStateChange({ kind: "installing" });
    // 提前返回退订函数：即使立刻进入安装阶段，调用方关闭弹窗时仍需能解除单槽
    return dispose;
  }
  // 先投影 checking 再判运行时可用：弹窗需要确定性首帧，否则空白态会被用户当成「本次没有强更」
  onStateChange({ kind: "checking" });

  // 开发态/未打包时强更不可能成功，必须给出 dev-skipped 终态；报 error 会让用户以为可以重试
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    // 文案固定为 not packaged：弹窗据此显示「当前为开发版本」，而不是可重试的网络错误
    const message = "not packaged";
    // 跳过原因同时进主进程日志：终端里能看到强更被哪一道闸拦下，不依赖弹窗文案
    logger.info(`[force-update] 自动升级跳过：${message}`);
    // dev-skipped 是终态：弹窗收到后不再等待任何进度，也不应展示重试按钮
    onStateChange({ kind: "dev-skipped", message });
    // 跳过分支同样要退订：否则槽位里留着一个已关闭弹窗的回调，下一次强更会往死通道发状态
    return dispose;
  }

  // 已 ready 时直接进入安装：强更不允许停留在"等待用户点击"，
  // 否则弹窗的进度语义与 Main 状态不一致。
  if (menuState.kind === "update-downloaded") {
    // 已 ready 时跳过 check/download 直接进安装：强更不允许停在「等待用户点击」，否则弹窗进度与 Main 状态不一致
    onStateChange({ kind: "installing" });
    // void 是有意的：安装失败的恢复由 quitAndInstallUpdate 内部处理（INV-6/INV-8），此处不接 rejection
    void quitAndInstallUpdate();
    // 立即退订：安装阶段的状态由 menuState 与原生安装器推进，弹窗不再需要接收中间态
    return dispose;
  }

  // 已有候选版本直接复用下载，不重新 check：重查会把用户刚看到的版本号短暂变成 checking（与手动路径同源）
  if (menuState.kind === "update-available") {
    // 传 force-update 作为 reason：下载链路的日志与失败重查按来源归因，排查时能区分强更与后台轮询
    downloadAvailableUpdate("force-update");
    // 下载已开始，强更弹窗后续通过 progress 事件被 notifyForceAutoUpdate 推进，此处无需再持有流程
    return dispose;
  }

  // 正在下载时只同步进度，不重新 begin：此时 token 仍在，下载链路会继续
  // 通过 progress 事件推进；重启检查会打断这次下载。
  if (menuState.kind === "download-progress") {
    // 下载中只同步进度，不重新 begin：token 仍在，下载链路会继续推进；重启检查会打断这次下载
    onStateChange({
      // 阶段与 menuState.download-progress 对齐，弹窗据此渲染进度条而不是 loading 态
      kind: "downloading",
      ...("version" in menuState && menuState.version ? { version: menuState.version } : {}),
      // 进度字符串原样透传：主进程不解析百分比，避免与 renderer 的格式化逻辑形成第二套口径
      progress: menuState.progress,
    });
    // 仅同步不接管：退订后下载仍由原生事件推进，状态最终经 menuState 广播给所有窗口
    return dispose;
  }

  // 复用进行中的检查：此时不能再 begin 一次，否则世代推进会让
  // 正在处理的结果被判 stale，强更弹窗永远收不到 available。
  if (checkForUpdatesInFlight) {
    // 复用进行中的检查：此时再 begin 会推进世代，正在处理的结果会被判 stale，强更弹窗永远收不到 available（INV-3）
    logger.info(`[force-update] 自动升级复用进行中的更新检查`);
    // 不注册新的 checkId 就返回：本轮结果会经广播落到已就位的监听上，无需重复发起
    return dispose;
  }

  // 强更自查也走 begin/settle：它和启动检查共享同一份互斥与世代记账，否则两条检查并发会互相覆盖进度（INV-20）
  const checkId = beginAutoUpdateCheck();
  // enabled=false 让菜单在检查期间不可再次触发，与弹窗的 checking 阶段保持同一事实
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  // 强更自查也要走 begin/settle：它和启动检查共享同一份互斥与世代，
  // 否则两条检查并发时，晚到的结果会把强更弹窗的进度覆盖。
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      // 安装锁生效后失败回调必须短路（INV-8）：否则会在退出途中重写菜单状态，造成重启循环
      if (isUpdateTargetLocked()) return;
      // 先归一错误文本：非 Error 抛出（字符串/对象）不能直接进日志与弹窗，否则会显示 [object Object]
      const message = err instanceof Error ? err.message : String(err);
      // 原始 err 必须进 logger.error、归一文本进 UI：两者用途不同，日志需要堆栈，弹窗只需要可读原因
      logger.error(`[auto-update] ${reason} check failed:`, err);
      // 失败回落必须保留 ready 优先：已有下载完成包时不能把菜单打回 idle（INV-9）
      setAutoUpdaterMenuState(
        readyUpdateVersion
          // ready 仍在时重建「可安装」投影：用户仍应看到重启更新入口，而不是一个被清空的菜单
          ? buildUpdateDownloadedState(readyUpdateVersion)
          // 无 ready 才回 idle，并恢复 enabled 让下次点击可用：漏掉 enabled 会让菜单项永久置灰
          : { kind: "idle", enabled: true },
      );
      // 错误同时投递给弹窗：强更没有「稍后重试」入口，必须让用户当场看到失败原因
      onStateChange({ kind: "error", message });
    })
    .finally(() => {
      // finally 收口而非 catch：无论成功失败都要释放 in-flight 与世代标记（INV-3），否则后续检查会被永久挡住
      finishAutoUpdateCheck(reason, checkId);
    });

  // 返回退订函数：弹窗卸载与另一次强更接管可能交错，调用方需要能显式解除监听
  return () => {
    // 同样只摘自己的槽位：若槽位已被新请求覆盖，这里的卸载不能误伤后来者
    if (activeForceAutoUpdateListener === onStateChange) {
      // 置空后 2378 的调用方不再收到任何状态，避免往已销毁的 webContents 发送
      activeForceAutoUpdateListener = null;
    }
  };
}

// 无窗口检查用于托盘/快捷键等没有 renderer 的场景：它不发 UpdateCheckResult，
// 所有结果只通过 menuState 与后续广播体现。
// 与手动检查共享同一把互斥闸，因此二者不会同时对同一个 provider 发请求。
export function requestAutoUpdateCheckWithoutWindow(reason = "force-update") {
  // 安装流程已启动时忽略无窗口检查：与 INV-6 一致，不允许在退出途中再开一轮 check
  if (quitAndInstallState !== "idle") return;
  // 无窗口路径没有回执通道，日志是唯一可观测点：至少留下「谁在什么时候请求了检查」
  logger.info(`[auto-update] ${reason}: user requested update check without renderer window`);

  // 未打包时静默返回：写日志即为止损，调用方是快捷键/托盘这类 fire-and-forget 入口，没有地方处理 rejection
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    // 明确记录跳过原因是 not packaged，与「检查已在进行」等其他跳过区分开
    logger.info(`[auto-update] skip ${reason}: not packaged`);
    // 返回而不写错误态：无窗口路径的 menuState 仍由既有流程维护，这里不应替它做决定
    return;
  }

  // 已 ready 时「检查更新」等价于「立即安装」：这是托盘/快捷键入口的期望语义，不让用户再点第二下
  if (menuState.kind === "update-downloaded") {
    // void 忽略 Promise：安装失败的恢复与重启动由 quitAndInstallUpdate 内部闭环（INV-6/INV-8）
    void quitAndInstallUpdate();
    // 安装已接管：quitAndInstallUpdate 之后本次「检查」不再产生任何状态写入，直接结束
    return;
  }
  // 已有候选版本时直接复用：重新检查会把用户刚看到的版本号短暂变成 checking，
  // 也会让远端多一次无必要的 manifest 请求。
  if (menuState.kind === "update-available") {
    // 复用同一份 menuState 里的版本与渠道：下载发起后再改设置不会影响本次目标（INV-12）
    downloadAvailableUpdate(reason);
    // 下载由 progress 事件推进，函数返回后流程继续，调用方无需等待
    return;
  }
  // 下载中不重查：token 仍有效，重查会把菜单打回 checking 并丢掉当前进度（INV-5）
  if (menuState.kind === "download-progress") {
    // 记录跳过时的真实 menuState.kind，便于区分「正在下载」与「检查在途」两种互斥命中
    logger.info(`[auto-update] skip ${reason}: update already ${menuState.kind}`);
    // 静默返回不写错误态：这是用户预期内的跳过，不是失败
    return;
  }
  // 互斥闸（INV-20）：三路触发共用，这里只做静默跳过，不改写 menuState
  if (checkForUpdatesInFlight) {
    // 与 download-progress 分支分开记日志：两种跳过的成因不同，合并会丢掉排查线索
    logger.info(`[auto-update] skip ${reason}: check already in flight`);
    // 已有检查在途时必须直接结束，本轮不新增 checkId，也不触碰 autoUpdateCheckGeneration
    return;
  }

  // 无窗口路径的 catch 只回填状态，不允许把错误抛给调用方：
  // 调用方是快捷键/托盘这类 fire-and-forget 入口，没有地方处理 rejection。
  const checkId = beginAutoUpdateCheck();
  // 无可见目标时才进 checking：有 update-available 或 download-progress 的情况已在上方提前返回
  setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  // 直接调 checkForUpdates 而不经 triggerCheckForUpdates：互斥已由 begin 占住，再套一层会重复校验并可能自锁
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      // 安装锁生效后 catch 必须短路（INV-8），否则会在退出途中把菜单改回 idle
      if (isUpdateTargetLocked()) return;
      // 失败日志带 reason：托盘/快捷键触发的检查没有窗口，日志是唯一能区分触发来源的线索
      logger.error(`[auto-update] ${reason} check failed:`, err);
      // 无窗口路径同样保留 ready 优先的回落（INV-9）：不能因为入口没有 UI 就把已下载的包丢掉
      setAutoUpdaterMenuState(
        readyUpdateVersion
          // ready 仍在时重建可安装态，用户仍能从菜单点重启更新
          ? buildUpdateDownloadedState(readyUpdateVersion)
          // 无 ready 才回 idle 并恢复 enabled，保证菜单项下一次可点击
          : { kind: "idle", enabled: true },
      );
    })
    .finally(() => {
      // finally 释放互斥与世代，即使 catch 已短路也必须执行；这是「同一时刻只有一个 check」的收口
      finishAutoUpdateCheck(reason, checkId);
    });
}

// 手动检查需要向"发起窗口"回执，因此单独记录 webContentsId；
// 它同时承担"清除当前渠道跳过记录"的语义，见 isSkippedUpdateVersion 的短路条件。
export function checkForUpdateMenuClick(originWindow?: BrowserWindow | null) {
  // 安装中点击不响应：此时任何状态写入都会污染退出流程（INV-6），且菜单即将随进程消失
  if (quitAndInstallState !== "idle") return;
  // 记录点击入口：手动检查的排查起点固定在这条日志，后续 sendManualCheckResult 与之配对
  logger.info("[auto-update] user clicked Check for Updates");

  // 目标窗口按 来源窗口 -> 焦点窗口 -> 任一存活窗口 依次回退：
  // 菜单点击可能由已失焦的窗口触发，直接取 focusedWindow 会把回执发错窗口。
  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      // 首选来源窗口：菜单点击可能来自非焦点窗口，直接取 focusedWindow 会把回执发到错误的窗口
      ? originWindow
      // 无 originWindow 时退到 BrowserWindow.getFocusedWindow()，覆盖快捷键与应用菜单触发的场景
      : (BrowserWindow.getFocusedWindow() ??
        // 再退到任一存活窗口：至少保证回执有落点，避免用户点了却完全无反馈
        BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
        // originWindow 与焦点窗口全无时必须为 null，交给下面的拦截分支处理，否则会进入无目标检查
        null);

  // 没有窗口可回执时直接返回：此时仍可检查，但结果无处投递，
  // 贸然开始会让 manualCheckWebContentsId 指向一个不存在的目标。
  if (!targetWindow) {
    // 无窗口可回执时只告警不抛错：这是 UI 生命周期问题，不是更新逻辑失败
    logger.warn("[auto-update] manual check: no target window to report to");
    // 直接返回：贸然开始会让 manualCheckWebContentsId 指向一个不存在的目标（INV-15）
    return;
  }

  // 手动检查也必须 fail-closed：菜单项本应隐藏，但 IPC 与加速键可以绕过 UI 直接调用
  if (!canUseAutoUpdaterInCurrentRuntime()) {
    // 记录 canUseAutoUpdaterInCurrentRuntime 的跳过原因，与产品形态禁用分开，便于确认是哪一道闸生效
    logger.info("[auto-update] skip manual check: not packaged");
    // 未打包也要回执：否则按钮永远停在转圈，用户会以为检查卡住
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      // dev-skipped 与 error 的区别是「重试无用」：UI 据此隐藏重试按钮，而不是提示用户再试一次
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    // 回执即结束：此分支不占用 checkId，也就不会影响世代计数
    return;
  }

  // 这是产品形态禁用的最后一道闸：入口本应隐藏，但菜单/IPC 可能被直接调用，
  // 这里必须 fail-closed，绝不能对未配置的 updater 发请求。
  if (autoUpdaterDisabledForProductFlavor) {
    // 入口本应已按产品身份隐藏；这里是最后一道闸，不让未初始化的 updater 实例向占位 feed 发请求。
    logger.info("[auto-update] skip manual check: updater disabled for this product flavor");
    // 产品形态禁用时与未打包同构：都回 dev-skipped，避免暴露「可重试」的假象
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      // 复用同一阶段值，让 renderer 只需处理一种「本产品不提供自动更新」的终态
      kind: "dev-skipped",
    } satisfies UpdateCheckResultPayload);
    // 这是最后一道闸：return 必须落在 beginAutoUpdateCheck 之前，否则会对占位 feed 发真实请求
    return;
  }

  // 只有 ready 仍等于当前目标才安装；目标已更高时落到后面的重新检查，
  // 避免用户点"重启以更新"却被 quitAndInstallUpdate 装上一个已被远端取代的版本。
  if (menuState.kind === "update-downloaded" && isReadyUpdateCurrentTarget()) {
    // 菜单文案已经是“重启以更新”。只有 ready 包仍等于当前目标时才安装；
    // 目标已经更高时落到下面的重新检查，避免装上旧包。
    void quitAndInstallUpdate();
    // ready 且仍是当前目标才安装；目标已更高时不在这里安装，落到后续的重新检查（INV-7）
    return;
  }
  // 下载中点击"检查更新"不是错误：回执 already-downloading 让 UI 继续展示进度，否则会弹出一个与事实不符的"检查已在进行"错误。
  if (menuState.kind === "download-progress") {
    // 下载中点击检查不是错误：回 already-downloading 让 UI 继续展示进度，而不是弹出与事实不符的失败
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      // 该阶段值专门用于「检查键被按下但已有下载在跑」，与 download-progress 的主动推送区分开
      kind: "already-downloading",
      // 版本回退链保证字段非空：先在下载版本，再退已 ready 版本，最后由 UI 用空串兜底
      version: downloadingUpdateVersion ?? readyUpdateVersion ?? "",
      // 进度直接取自 menuState.progress：调用方无需再取一次快照，避免两次读取之间状态已变
      progress: menuState.progress,
    } satisfies UpdateCheckResultPayload);
    // 回执后立刻结束：不重启下载，也不改动已有 token（INV-5）
    return;
  }
  // 已有检查在途时回执 error 而不是静默丢弃：手动点击必须有确定性回执，
  // 否则按钮会一直转圈等待一个永不到来的结果。
  if (checkForUpdatesInFlight) {
    // 在途检查必须回确定性错误：手动点击不能静默丢弃，否则按钮会一直转圈等待一个永不到来的结果
    logger.info("[auto-update] skip manual check: check already in flight");
    // 与自动路径的静默跳过刻意不同：有 UI 入口就必须有回执，这是两条路径唯一的语义分叉
    targetWindow.webContents.send(PlatformChannels.UpdateCheckResult, {
      // 用 error 而非 already-checking：renderer 侧只按错误文案分支，新增阶段值需要同步改协议
      kind: "error",
      // message 直接说明「检查已在进行」：用户据此知道只需等待，不需要重复点击
      message: "Update check already in progress.",
    } satisfies UpdateCheckResultPayload);
    // 回执即结束，不能登记 manualCheckWebContentsId：本轮没有真实请求，无需投递结果
    return;
  }

  // 记录目标后再发起检查：结果事件可能在 checkForUpdates 返回前就到达，
  // 顺序反过来会让首次回执因为找不到窗口而被丢弃。
  manualCheckWebContentsId = targetWindow.webContents.id;
  // 跳过记录按"当前状态所属渠道"清理，而不是按设置里的最新值：
  // 用户可能在检查期间切过设置，用新值会清错渠道的记录。
  const manualCheckChannel = getAutoUpdaterReleaseChannelForCurrentState();
  // 已发现的版本继续显示，检查结果回来后再替换，避免菜单先闪成“正在检查”。
  // 已有可见目标时保持原样：把 update-available 闪成 checking 再闪回来，
  // 会让菜单文案与弹窗同时抖动一次。
  if (!hasVisibleUpdateTarget(menuState)) {
    // 仅在没有可见目标时切 checking：已有 update-available 时保持原样，避免菜单文案闪一下再闪回来
    setAutoUpdaterMenuState({ kind: "checking", enabled: false });
  }
  // 先 begin 再进入异步块：checkId 必须在任何 await 之前落定，否则结果事件可能与错误的世代配对
  const checkId = beginAutoUpdateCheck();
  // 先清跳过记录再检查：顺序反过来，本轮结果仍会被 isSkippedUpdateVersion
  // 判成已跳过，用户看到的是 up-to-date 而不是真实的新版本。
  (async () => {
    // 先清跳过记录再检查：顺序反过来，本轮结果仍会被 isSkippedUpdateVersion 判成已跳过，用户看到 up-to-date（INV-14 配套语义）
    await clearSkippedUpdateVersionForManualCheck(manualCheckChannel, autoUpdaterSettingService);
    // 清跳过期间可能已进入安装流程：此处短路，避免对已锁目标发请求并写入过期状态（INV-8）
    if (isUpdateTargetLocked()) return;
    // 唯一的真实请求点：结果事件可能早于 Promise resolve 到达，因此 manualCheckWebContentsId 必须在此之前写好（INV-15）
    await autoUpdater.checkForUpdates();
  })()
    .catch((err) => {
      // 失败回调同样受安装锁约束（INV-8）：退出途中不处理任何检查错误，交给恢复流程
      if (isUpdateTargetLocked()) return;
      // 手动检查失败必须显式回执：sendManualCheckResult 会消耗单槽目标，
      // 让菜单与弹窗同时结束等待，而不是停在 checking。
      logger.error("[auto-update] manual check failed:", err);
      // 手动检查失败必须显式回执：sendManualCheckResult 会消耗单槽目标，让菜单与弹窗同时结束等待
      sendManualCheckResult({
        // 用 error 阶段承载失败：renderer 侧据此在同一条结果通道上收尾，不需要额外事件
        kind: "error",
        // 与 2441 同口径归一错误文本：非 Error 抛出不能直接进 UI，否则会显示不可读内容
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      // finally 释放互斥，reason 用固定文案与启动检查的日志区分；checkId 校验保证不会误清新一轮的 in-flight（INV-3）
      finishAutoUpdateCheck("manual check", checkId);
    });
}
