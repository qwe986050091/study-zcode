// B224 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/desktop/src/main/appARMSBootstrap.ts',
    target: 30,
    header: [
      '// INV-01 上报前统一闸门：守住位置 beforeReport；改错故障 过滤、脱敏顺序散落到各 collector。',
      '// INV-02 环境按运行形态判定：守住位置 mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv)；改错故障 源码启动的开发数据污染生产看板。',
      '// INV-03 设备维度走 user.name：守住位置 armsDeviceMid；改错故障 RUM 日志无法按设备关联。',
      '// INV-04 device_mid 幂等：守住位置 ensureDesktopDeviceMidSync；改错故障 每次启动换一个新 id。',
      '// INV-05 采样率必须为 1：守住位置 sessionConfig.sampleRate；改错故障 页面性能指标大面积缺失。',
      '// INV-06 单页模式关 SPA：守住位置 spaMode: false；改错故障 无 History 路由时采不到 perf。',
      '// INV-07 crash 只认产品可执行文件：守住位置 hasProductExecutable；改错故障 helper dump 计入崩溃率。',
      '// INV-08 二进制名精确匹配：守住位置 Set 全等比较；改错故障 前缀匹配混入 helper 进程。',
      '// INV-09 进程角色只信 dump 元数据：守住位置 meta.process_type；改错故障 通用属性把 helper 提升为 main。',
      '// INV-10 未知角色仍保留事件：守住位置 返回 true 并标 native_dump_unattributed；改错故障 丢失可排查的 dump。',
      '// INV-11 只有 main 进产品 KPI：守住位置 crash_scope 三元；改错故障 Crash-Free 被非主进程拉低。',
      '// INV-12 crash_id 跨重试稳定：守住位置 已有值优先；改错故障 重试产生重复崩溃计数。',
      '// INV-13 隐私收口最后执行：守住位置 redactArmsEventBatch 位置；改错故障 脱敏先跑导致聚合与归因拿不到原值。',
      '// INV-14 init 必须 await：守住位置 armsInitPromise；改错故障 首窗 dom-ready 前未注入，零上报。',
      '//',
      '// 模块职责：Electron 主进程 ARMS RUM 的初始化、上报前过滤与脱敏，以及长任务归因补写。',
      '// 阅读顺序：先看三个事件加工函数，再看崩溃过滤与分级，最后看 init 与 beforeReport 的装配顺序。',
    ],
    blocks: [
      {
        anchor: 'function enrichLongTaskAttribution(events: Array<Record<string, unknown>>): void {',
        lines: [
          '长任务只补摘要，不上报脚本 URL。',
        ],
      },
      {
        anchor: 'if (event.event_type !== "longTask") {',
        lines: [
          '非长任务事件原样放过。',
        ],
      },
      {
        anchor: 'event.properties = { ...existingProps, ...summary };',
        lines: [
          '摘要合并进 properties 供查询。',
        ],
      },
      {
        anchor: 'function isCrashReporterEvent(event: Record<string, unknown>): boolean {',
        lines: [
          '三字段同时命中才算崩溃事件。',
        ],
      },
      {
        anchor: 'function hasProductExecutable(',
        lines: [
          '两种运行形态的真实二进制名都算。',
        ],
      },
      {
        anchor: 'return expectedNames.has(normalizeExecutableName((image as Record<string, unknown>).name));',
        lines: [
          '全等比较，绝不放宽为前缀。',
        ],
      },
      {
        anchor: 'function readNativeDumpProcessRole(event: Record<string, unknown>): NativeDumpProcessRole {',
        lines: [
          '角色只从结构化 annotation 读。',
        ],
      },
      {
        anchor: 'export function filterAndEnrichNativeCrashEvents(',
        lines: [
          '过滤与增补在同一次遍历完成。',
        ],
      },
      {
        anchor: 'crash_scope:',
        lines: [
          '只有 main 计入 app_native_process。',
        ],
      },
      {
        anchor: 'const armsRumEnv = mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv);',
        lines: [
          '环境在模块加载时定一次。',
        ],
      },
      {
        anchor: 'const armsDeviceMid = ensureDesktopDeviceMidSync();',
        lines: [
          '设备 id 与遥测状态文件同源。',
        ],
      },
      {
        anchor: 'armsRum.client.useReporter = (reporter) => {',
        lines: [
          '包装 transport 以观察投递结果。',
        ],
      },
      {
        anchor: 'beforeReport: (payload: { events?: Array<Record<string, unknown>> }) => {',
        lines: [
          '顺序固定：过滤、 ingested、归因、脱敏。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/browserView/browserCommandExecutor.ts',
    target: 30,
    header: [
      '// INV-01 结构化返回：守住位置 外层 try/catch；改错故障 异常穿透 host↔main 桥，调用方拿不到结果。',
      '// INV-02 永不 throw：守住位置 catch 内 done 返回；改错故障 主进程未捕获拒绝。',
      '// INV-03 耗时统一计算：守住位置 done 包装；改错故障 各分支自行计时且口径不一。',
      '// INV-04 取消优先于超时：守住位置 cancelled 判断在前；改错故障 用户取消被报成超时。',
      '// INV-05 取消识别双源：守住位置 signal.aborted 与 AbortError；改错故障 不同 Playwright 版本的取消漏判。',
      '// INV-06 超时识别双源：守住位置 name 与文案正则；改错故障 超时退化为执行错误。',
      '// INV-07 未实现显式声明：守住位置 default 分支；改错故障 未知命令静默成功。',
      '// INV-08 不支持清单写进消息：守住位置 available 列表；改错故障 调用方不知道可用能力。',
      '// INV-09 简单导航直接走 webContents：守住位置 back/forward/reload；改错故障 多绕一层 handler 引入时序差。',
      '// INV-10 状态随动作返回：守住位置 readState；改错故障 调用方要多一次往返。',
      '// INV-11 playwright 收窄为 action：守住位置 command.action；改错故障 整个命令对象下传导致类型漂移。',
      '// INV-12 取消信号透传：守住位置 opts?.signal；改错故障 长动作无法中断。',
      '// INV-13 处理器只做分派：守住位置 各 case 单行返回；改错故障 分派层堆积业务逻辑。',
      '// INV-14 类型出口集中：守住位置 两组 re-export；改错故障 消费者从实现文件深层导入。',
      '//',
      '// 模块职责：把一条浏览器命令分派给对应的交互或页面处理器，并统一包装结果与错误码。',
      '// 阅读顺序：先看 done 包装，再看 switch 分派，最后看 catch 的三类错误归一。',
    ],
    blocks: [
      {
        anchor: 'export async function executeBrowserCommandOnView(',
        lines: [
          '分派层是命令进入页面的唯一入口。',
        ],
      },
      {
        anchor: 'const done = (partial: Omit<BrowserCommandResult, "elapsedMs">): BrowserCommandResult => ({',
        lines: [
          '所有出口都经过这一个包装。',
        ],
      },
      {
        anchor: 'case "navigate":',
        lines: [
          '导航与等待策略交给页面处理器。',
        ],
      },
      {
        anchor: 'case "back":',
        lines: [
          '三个历史动作直接调用 webContents。',
        ],
      },
      {
        anchor: 'case "evaluate":',
        lines: [
          '脚本求值同样返回结构化错误。',
        ],
      },
      {
        anchor: 'case "playwright":',
        lines: [
          'Playwright 命令只透传 action 与信号。',
        ],
      },
      {
        anchor: 'return await handlePlaywrightAction(view, command.action, done, opts?.signal);',
        lines: [
          '取消信号必须进到动作内部。',
        ],
      },
      {
        anchor: 'default:',
        lines: [
          '未实现能力显式失败，不静默。',
        ],
      },
      {
        anchor: 'code: "capability_unsupported",',
        lines: [
          '错误码固定，便于上层分支。',
        ],
      },
      {
        anchor: 'const cancelled =',
        lines: [
          '取消判定先于超时判定。',
        ],
      },
      {
        anchor: 'const timedOut =',
        lines: [
          '超时同时看错误类型与文案。',
        ],
      },
      {
        anchor: 'code: cancelled ? "cancelled" : timedOut ? "timeout" : "execution_error",',
        lines: [
          '三类错误码互斥且稳定。',
        ],
      },
      {
        anchor: 'export { isAllowedBrowserUrl } from "./browserCommandState.js";',
        lines: [
          '类型与校验入口在此集中导出。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts',
    target: 30,
    header: [
      '// INV-01 只写当前用户：守住位置 HKCU；改错故障 需要管理员权限或污染全机。',
      '// INV-02 两处挂载点同源：守住位置 Directory 与 Drive 共用 key 名；改错故障 驱动器右键没有菜单。',
      '// INV-03 键名版本无关：守住位置 ZCode.OpenInZCode；改错故障 升级后出现重复菜单项。',
      '// INV-04 文案随语言：守住位置 MENU_LABELS；改错故障 英文系统出现中文菜单。',
      '// INV-05 缺失语言回退英文：守住位置 ?? 兜底；改错故障 非中英语言得到 undefined 文案。',
      '// INV-06 参数必须加引号：守住位置 quoteWindowsCommandArg；改错故障 带空格路径被拆成多参。',
      '// INV-07 引号转义：守住位置 replace(/"/g)；改错故障 路径含引号时命令截断。',
      '// INV-08 占位符原样保留：守住位置 "%1"；改错故障 Explorer 传入的目录丢失。',
      '// INV-09 入口参数必须绝对化：守住位置 resolve(argv[1])；改错故障 用相对路径注册后开机失效。',
      '// INV-10 仅默认应用登记入口：守住位置 isDefaultApp && argv[1]；改错故障 开发态菜单只拉起空 Electron。',
      '// INV-11 非 Windows 直接返回：守住位置 platform 判断；改错故障 macOS/Linux 上调用 reg.exe。',
      '// INV-12 四条写入成组：守住位置 flatMap 顺序；改错故障 默认值、MUIVerb、Icon、command 缺一。',
      '// INV-13 失败只告警：守住位置 catch + warn；改错故障 右键菜单失败阻断应用启动。',
      '// INV-14 退出码进错误：守住位置 code ?? "unknown"；改错故障 排查时不知道 reg 为何失败。',
      '//',
      '// 模块职责：在 Windows 注册表里维护「在 ZCode 中打开」的目录与驱动器右键菜单。',
      '// 阅读顺序：先看命令与参数的转义，再看注册表条目构造，最后看安装入口的守卫与容错。',
    ],
    blocks: [
      {
        anchor: 'const MENU_KEY_NAME = "ZCode.OpenInZCode";',
        lines: [
          '键名跨版本固定，避免重复项。',
        ],
      },
      {
        anchor: 'const MENU_LABELS: Record<Locale, string> = {',
        lines: [
          '菜单文案与界面语言一致。',
        ],
      },
      {
        anchor: 'export function getWindowsOpenFolderMenuName(locale: Locale): string {',
        lines: [
          '未知语言统一回落英文。',
        ],
      },
      {
        anchor: 'function quoteWindowsCommandArg(value: string): string {',
        lines: [
          '每个参数单独加引号并转义。',
        ],
      },
      {
        anchor: 'export function buildWindowsOpenFolderCommand(',
        lines: [
          '可执行文件、启动参数、动作、占位符。',
        ],
      },
      {
        anchor: '"--open-workspace",',
        lines: [
          '动作参数告诉应用按工作区打开。',
        ],
      },
      {
        anchor: 'export function buildWindowsOpenFolderRegistryOperations(options: {',
        lines: [
          '构造纯数据，不在此时写注册表。',
        ],
      },
      {
        anchor: '{ args: ["add", menuKey, "/v", "MUIVerb", "/t", "REG_SZ", "/d", menuName, "/f"] },',
        lines: [
          'MUIVerb 决定 Explorer 显示文本。',
        ],
      },
      {
        anchor: 'function runRegAdd(args: readonly string[]): Promise<void> {',
        lines: [
          '单条 reg add 以退出码为准。',
        ],
      },
      {
        anchor: 'reject(new Error(`reg.exe exited with code ${code ?? "unknown"}`));',
        lines: [
          '退出码缺失也给出明确文案。',
        ],
      },
      {
        anchor: 'export async function installWindowsOpenFolderContextMenu(options: {',
        lines: [
          '安装入口只关心平台与默认应用状态。',
        ],
      },
      {
        anchor: 'if (options.platform !== "win32") {',
        lines: [
          '非 Windows 立即空返回。',
        ],
      },
      {
        anchor: 'options.isDefaultApp && options.argv[1] ? [resolve(options.argv[1])] : [];',
        lines: [
          '开发态必须把入口路径绝对化后写入。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/src/main/startupWorkspace.ts',
    target: 30,
    header: [
      '// INV-01 设置读取永不抛错：守住位置 readStartupSettings 的 catch；改错故障 损坏的 settings.json 阻断启动。',
      '// INV-02 非法结构回落默认：守住位置 safeParse 分支；改错故障 半截配置进入窗口引导。',
      '// INV-03 预热上限为 1：守住位置 STARTUP_AGENT_WARMUP_LIMIT；改错故障 每个窗口常驻多份 Agent 内存。',
      '// INV-04 只在本地会话预热：守住位置 activeSession.kind 判断；改错故障 远程工作区也起本地 CLI。',
      '// INV-05 可用性三重校验：守住位置 stat + isDirectory + access；改错故障 无权限目录被当可用。',
      '// INV-06 不可用只让出路径：守住位置 unavailableWorkspacePath；改错故障 直接清空用户上次工作区。',
      '// INV-07 cwd 必须有真实目录：守住位置 mkdir(conversationWorkspaceDir)；改错故障 CLI 在发存储帧前退出。',
      '// INV-08 backing workspace 不当项目：守住位置 initialWorkspacePurpose: "conversation"；改错故障 凭空出现 ZCodeProject。',
      '// INV-09 新字段优先：守住位置 lastActiveWorkspace 判断；改错故障 旧多标签状态覆盖当前单工作区。',
      '// INV-10 索引夹取到合法区间：守住位置 min/max；改错故障 标签数变少时取到 undefined。',
      '// INV-11 远程会话不预热：守住位置 localActiveSessionIndex 分支；改错故障 远程活动项也产出预热目标。',
      '// INV-12 返回结构按需带字段：守住位置 条件展开；改错故障 传 undefined 字段覆盖默认值。',
      '// INV-13 打开工作区固定为项目用途：守住位置 createOpenWorkspaceStartupBootstrap；改错故障 用户打开的目录被标成会话目录。',
      '// INV-14 读取顺序只影响日志：守住位置 logger?.warn/info；改错故障 日志失败改变返回值。',
      '//',
      '// 模块职责：把持久化设置翻译成首窗引导参数，决定恢复哪个工作区与预热哪个 cwd。',
      '// 阅读顺序：先看设置读取容错，再看会话选取，最后看三条返回分支。',
    ],
    blocks: [
      {
        anchor: 'async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {',
        lines: [
          '任何读取异常都退化为默认设置。',
        ],
      },
      {
        anchor: 'if (!result.success) {',
        lines: [
          '结构非法与文件缺失走同一回落。',
        ],
      },
      {
        anchor: 'export const STARTUP_AGENT_WARMUP_LIMIT = 1;',
        lines: [
          '预热数量与协议上限保持一致。',
        ],
      },
      {
        anchor: 'export interface StartupWindowBootstrap {',
        lines: [
          '引导参数全部可选，缺省由 Host 决定。',
        ],
      },
      {
        anchor: 'async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {',
        lines: [
          '目录存在且可读可进入才算可用。',
        ],
      },
      {
        anchor: 'await access(workspacePath, constants.R_OK | constants.X_OK);',
        lines: [
          '权限不足按不可用处理。',
        ],
      },
      {
        anchor: 'function resolvePersistedActiveSession(',
        lines: [
          '从多标签状态里取当前活动项。',
        ],
      },
      {
        anchor: 'const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);',
        lines: [
          '索引夹取，容忍标签数缩减。',
        ],
      },
      {
        anchor: 'export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {',
        lines: [
          '用户主动打开目录时用途固定为项目。',
        ],
      },
      {
        anchor: 'export async function resolveStartupWindowBootstrap({',
        lines: [
          '启动恢复的唯一决策点。',
        ],
      },
      {
        anchor: 'const sessions =',
        lines: [
          '新字段存在时不再读旧多标签列表。',
        ],
      },
      {
        anchor: 'if (unavailableWorkspacePath) {',
        lines: [
          '不可用只告警，仍保留原路径供读史。',
        ],
      },
      {
        anchor: 'const localActiveSessionIndex = resolveStartupLocalWorkspaceSessionIndex(sessions, activeIndex);',
        lines: [
          '只有本地会话能产出预热目标。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b224-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
