// ZCode 桌面主进程应用菜单构建器：只做 Electron Menu 模板装配，不承担业务副作用。
// 所有菜单点击都经 executeDesktopCommand 回到命令通道，由 handler 层决定真实行为。
//
// 度量口径按整行注释计（zc-gate）：本文件注释只增不改，禁止行尾挂注释刷密度。
//
// 不变量（INV-01..INV-20）：每条标注守卫位置与破坏后果，改动前必须逐条核对。
// INV-01 菜单文案必须全部经 getDesktopMenuLabel 取 shared 文案表（守卫：getLabel/getAppLabel），硬编码会让切换 locale 后菜单不刷新。
// INV-02 顶层禁止使用 editMenu/windowMenu 等聚合 role（守卫：edit 与 window 两处手写 submenu），否则文案跟随 Electron locale 产生中英混排。
// INV-03 accelerator 必须经 resolveMenuAccelerator 求解（守卫：File/View 各项），绕过会丢失用户覆盖或录制态摘键语义。
// INV-04 显式空数组表示抢绑后的未设置，必须返回 undefined（守卫：overrideList.length === 0 分支），压成回退默认会导致同键双动作。
// INV-05 覆盖全部非法时回退硬编码 fallback（守卫：overrideList.find(isValid) ?? fallback），与 renderer 生效表语义保持一致。
// INV-06 录制态必须摘掉全部可配置 accelerator（守卫：函数首行短路），否则录制按键会回灌触发原命令。
// INV-07 zoomIn 双条目不变式：可见项显示 Plus、隐藏项保留原始等号键（守卫：zoomInVisibleAccelerator 与第二个条件展开），否则 Windows 无 Shift 直按失效。
// INV-08 zoom 三项 enabled 必须由 clampDesktopZoomLevel 之后等级推导（守卫：canZoomIn/canZoomOut/canResetZoom），越界仍可继续缩放。
// INV-09 关闭窗口必须走 CloseActiveContext 业务命令而非 close role（守卫：file 菜单 fileCloseWindow 项），否则主进程直接关窗丢失 side pane 判断。
// INV-10 更新入口只由 ZCODE_PRODUCT_FLAVOR 决定（守卫：darwin 与 help 两处条件展开），Preview 连生产后端也不得注册更新器。
// INV-11 darwin 专属菜单与项必须按 process.platform 条件展开（守卫：app 菜单与 Window 的 zoom/front），非 darwin 不得产生占位项。
// INV-12 应用名文案必须经 getAppLabel 注入 app.name（守卫：replaceAll 占位符），否则菜单里出现未替换的字面占位符。
// INV-13 stdio tap 调试项仅在未打包且 state.visible 时注册（守卫：isLocalDevelopmentRuntime && stdioTapState.visible），生产包不得暴露。
// INV-14 ZCode endpoint 切换子菜单仅在 ZCODE_ENV === test 时注册（守卫：对应条件展开），生产构建不得暴露测试后端入口。
// INV-15 endpoint radio 的 checked 必须把 undefined 归一为 production（守卫：空值合并默认值），否则三个 radio 可能全不选中。
// INV-16 菜单项 id 必须是跨模块共享常量（守卫：CHECK_FOR_UPDATE_MENU_ID 等导入），重建后 getMenuItemById 才能继续命中。
// INV-17 重建菜单必须原子替换：构建成功后才安装（守卫：rebuildApplicationMenu 嵌套调用），构建失败不得清空现有菜单。
// INV-18 重建后必须同步 autoUpdater 菜单 locale（守卫：setAutoUpdaterMenuLocale 调用），否则更新提示语言与菜单不一致。
// INV-19 未打包重建后必须回填 stdio tap 勾选与可见态（守卫：if (!app.isPackaged) 分支），否则新菜单实例勾选态陈旧。
// INV-20 菜单结构与 desktopMenuMessageIds 必须一一对应（守卫：getLabel 的 keyof 约束），缺键会在构建期类型报错而非运行期空白。
import { app, BrowserWindow, Menu } from "electron";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isValidShortcutBinding,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import { CHECK_FOR_UPDATE_MENU_ID, setAutoUpdaterMenuLocale } from "./autoUpdater.js";
import {
  DESKTOP_ZOOM_MAX_LEVEL,
  DESKTOP_ZOOM_MIN_LEVEL,
  clampDesktopZoomLevel,
} from "./desktopZoom.js";
import {
  HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
  HELP_TOGGLE_DEV_TOOLS_MENU_ID,
} from "./desktopCommandHandlers.js";

export const HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID = "help.zcode-endpoint.production";
export const HELP_ZCODE_ENDPOINT_TEST_MENU_ID = "help.zcode-endpoint.test";

// 菜单文案的唯一入口：locale 与 messageId 交给 shared 的 getDesktopMenuMessage。
// [权衡] 不在本层做默认文案兜底，缺失 key 由 shared 层处理，避免两处默认值漂移。
// 调用方只传 messageId 常量，禁止拼接字符串，否则切换 locale 后无法整体刷新。
export function getDesktopMenuLabel(
  locale: Locale,
  id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds],
) {
  return getDesktopMenuMessage(locale, id);
}

// [失败路径] getPreferredSystemLanguages 在旧版 Electron 可能不存在，故使用可选调用。
// 取首选语言数组第一项作为系统语言，比 getLocale 更贴近系统默认选项的真实意图。
// locale 只区分 zh 与 en 两支：产品当前只发布中英文文案，其他语种统一落到 en-US。
// 本函数只读系统状态且无副作用，可在每次重建菜单时重复调用。
export function resolveSystemApplicationLocale(): Locale {
  // macOS 系统语言为中文时，Electron app.getLocale() 仍可能返回 en-US；
  // 优先读取系统首选语言列表，避免 System default 被误解析成英文。
  const systemLocale = app.getPreferredSystemLanguages?.()[0] ?? app.getLocale();
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

// [资源] getApplicationMenu 返回当前已安装菜单，尚未安装时为 null，此处必须容忍。
// 菜单重建后按 id 重新取项并回填 checked 与 visible，因为每次构建都会生成新实例。
// 该回填只在未打包运行时调用，生产包不提供 stdio tap 调试开关。
export function updateZCodeStdioTapDevMenuState() {
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById(HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID);
  if (!item) {
    return;
  }
  const state = readZCodeStdioTapDevState();
  item.checked = state.enabled;
  item.visible = state.visible;
}

/** 菜单通道命令的快捷键共享 options 类型（shortcutBindings 为 setting.json 里的用户覆盖）。 */
interface ApplicationMenuShortcutOptions {
  shortcutBindings?: Record<string, string[]>;
}

/**
 * 从用户覆盖解析菜单 accelerator：显式空数组 = 抢绑后的「未设置」（无 accelerator）；
 * 覆盖全部非法时回退硬编码默认值（与 renderer 生效表语义一致）。
 * main 进程只需要"命令 → accelerator 字符串"，完整生效表语义在 ui 快捷键内核。
 * 录制态返回 undefined（菜单项不带 accelerator，仍可点击），防止录制按键触发原命令。
 */
// [并发] 纯同步函数且无共享可变状态，可在任意时刻对同一 options 重复求解。
// 解析顺序固定：录制态短路，然后用户覆盖存在则按覆盖解析，无覆盖才用 fallback。
// 返回 undefined 表示该项不带 accelerator，不是错误，调用方需保留菜单项仍可点击。
// main 进程只需要命令到键位字符串的映射，完整生效表语义在 ui 快捷键内核。
function resolveMenuAccelerator(
  options: ApplicationMenuShortcutOptions & { disableShortcutAccelerators?: boolean },
  commandId: string,
  fallback: string,
): string | undefined {
  if (options.disableShortcutAccelerators) {
    return undefined;
  }
  // `?.find(isValid) ?? fallback` 会把「显式空数组 = 未设置」和
  // 「全部非法 = 回退默认」压成同一条路径，抢绑后被抢命令的默认 accelerator 复活，
  // 同键双动作且与「被抢命令变未设置」的 UI 承诺矛盾。
  // 用 undefined 与空数组区分没有覆盖和被抢绑后显式未设置这两种状态。
  // [失败路径] 若把两者合并，被抢命令会复活默认键，出现同键双动作。
  // 后续两个分支都依赖此判定，切勿提前用空值合并或逻辑或压缩。
  const overrideList = options?.shortcutBindings?.[commandId];
  if (overrideList !== undefined) {
    if (overrideList.length === 0) {
      return undefined;
    }
    return overrideList.find((binding) => isValidShortcutBinding(binding)) ?? fallback;
  }
  return fallback;
}

// 模板构建是纯函数：同一 options 应产出结构一致的模板，便于重建与单测断言。
// [事务] 本函数只返回模板不安装菜单，真正的副作用集中在 rebuildApplicationMenu。
// executeDesktopCommand 的错误必须统一在命令通道处理，菜单层不等待，避免阻塞 UI。
// 可选入参缺失均有安全默认：zoom 必须视为 0，bindings 可空，locale 必填。
function buildApplicationMenuTemplate(options: {
  currentApplicationLocale: Locale;
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** 快捷键设置页录制态：true 时摘掉全部可配置 accelerator */
  disableShortcutAccelerators?: boolean;
}): Electron.MenuItemConstructorOptions[] {
  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuLabel(options.currentApplicationLocale, id);
  const getAppLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getLabel(id).replaceAll("{appName}", app.name);
  // 在构建期快照一次状态供后续分支共用，避免构建途中状态漂移导致菜单自相矛盾。
  // [资源] 该读取是同步内存读取不涉及 IPC，可在模板构建期安全调用。
  const stdioTapState = readZCodeStdioTapDevState();
  const isLocalDevelopmentRuntime = !app.isPackaged;
  // [失败路径] 等级可能来自 renderer 且越界或缺失，必须先归一后再参与判断。
  // 三个 enabled 常量全部基于归一后的等级计算，保证边界处三项状态一致。
  // clamp 只收缩范围不做持久化，真实缩放等级仍由 renderer 持有。
  const currentZoomLevel = clampDesktopZoomLevel(options.currentZoomLevel ?? 0);
  const canResetZoom = currentZoomLevel !== 0;
  const canZoomIn = currentZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = currentZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;
  // zoomIn 主绑定含 "=" 时保留 Plus 可见 + "=" 隐藏的双条目（Plus 在菜单显示更好，"=" 兜底 Windows 无 Shift 直按）。
  // 录制态 accelerator 为 undefined（摘掉键位，菜单项保留可点击）。
  const zoomInBinding = resolveMenuAccelerator(options, "zoomIn", "CmdOrCtrl+=");
  // 仅替换首个等号为 Plus 以改善菜单展示，隐藏项继续保留原始等号绑定。
  // binding 为 undefined 时结果同为 undefined，可见放大项自然不带键位。
  const zoomInVisibleAccelerator = zoomInBinding?.replace("=", "Plus");

  // 模板顶层顺序必须固定：darwin 应用菜单（条件）之后依次是 File、Edit、View、Window、Help。
  // [权衡] 顶层不复用 Electron 聚合 role，以换取文案完全跟随应用内 locale。
  // 任一子菜单缺项都会导致对应快捷键失效，新增命令必须同步在此注册。
  return [
    // darwin 独有应用菜单：services、hide、hideOthers、unhide、quit 均由系统 role 实现。
    // 非 darwin 展开为空数组不产生占位菜单，保证 Windows 与 Linux 顶层从 File 开始。
    // [失败路径] 若在非 darwin 也注册该菜单，首项会变成无意义的应用名菜单。
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              // 更新入口跟随产品身份：Preview 禁用更新器，生产后端的 Preview 也不例外。
              // 更新入口受产品身份控制，Preview 即使连接生产后端也不会注册更新器。
              // 条件展开为空数组时不能留分隔符，避免菜单出现孤立横线。
              ...(ZCODE_PRODUCT_FLAVOR === "production"
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.appServices),
                role: "services" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appHide),
                role: "hide" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appHideOthers),
                role: "hideOthers" as const,
              },
              {
                label: getLabel(desktopMenuMessageIds.appShowAll),
                role: "unhide" as const,
              },
              { type: "separator" as const },
              {
                label: getAppLabel(desktopMenuMessageIds.appQuit),
                role: "quit" as const,
              },
            ],
          },
        ]
      : []),
    {
      label: getLabel(desktopMenuMessageIds.file),
      submenu: [
        {
          // File 菜单首项为新建任务，accelerator 允许被用户覆盖或被其他命令抢绑。
          // 点击回传 NewTask 命令，窗口上下文由命令通道解析，菜单层不持有 window。
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          accelerator: resolveMenuAccelerator(options, "newTask", "CmdOrCtrl+N"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          accelerator: resolveMenuAccelerator(options, "openWorkspace", "CmdOrCtrl+O"),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" as const },
        {
          // [权衡] 不用 close role：role 会在主进程直接关窗，renderer 没机会判断 side pane 的 active tab。
          // 改为 CloseActiveContext 命令，让快捷键先进入 workspace 状态机再决定关面板还是关窗。
          label: getLabel(desktopMenuMessageIds.fileCloseWindow),
          accelerator: resolveMenuAccelerator(options, "closeActiveContext", "CmdOrCtrl+W"),
          // Electron 的 close role 会在 main 进程直接关闭窗口，renderer 没机会判断
          // 右侧 side pane 是否有 active tab。这里改为业务命令，让快捷键先进入 workspace 状态机。
          click: () => void options.executeDesktopCommand(DesktopCommandIds.CloseActiveContext),
        },
      ],
    },
    {
      // Edit 子菜单必须逐项手写，role 只负责行为，label 完全来自应用内 locale。
      // [失败路径] 混用 editMenu 聚合 role 会出现文件与 Edit 并列的中英混排。
      label: getLabel(desktopMenuMessageIds.edit),
      // 顶层使用 Electron 的 editMenu/windowMenu role 会按系统/Electron locale 生成文案，
      // 和应用内 currentApplicationLocale 混用后出现“文件 Edit 视图 Window 帮助”的中英混排。
      submenu: [
        { label: getLabel(desktopMenuMessageIds.editUndo), role: "undo" as const },
        { label: getLabel(desktopMenuMessageIds.editRedo), role: "redo" as const },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editCut), role: "cut" as const },
        { label: getLabel(desktopMenuMessageIds.editCopy), role: "copy" as const },
        { label: getLabel(desktopMenuMessageIds.editPaste), role: "paste" as const },
        { type: "separator" as const },
        { label: getLabel(desktopMenuMessageIds.editSelectAll), role: "selectAll" as const },
      ],
    },
    {
      // View 子菜单必须包含全屏、放大、缩小、实际大小四类入口。
      // zoom 三项的 enabled 全部依赖归一后的缩放等级，避免越界后仍可继续缩放。
      label: getLabel(desktopMenuMessageIds.view),
      submenu: [
        {
          label: getLabel(desktopMenuMessageIds.viewToggleFullScreen),
          role: "togglefullscreen" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleFullScreen),
        },
        { type: "separator" as const },
        // zoom 命令的 accelerator 跟随用户快捷键设置（shortcutBindings 用户覆盖）。
        {
          label: getLabel(desktopMenuMessageIds.viewZoomIn),
          // 可见放大项必须使用 Plus 文案，Windows 上等价于 Ctrl 加等号，展示更符合习惯。
          // [并发] accelerator 每次重建都重新求解，设置变更后无需原地改写键位。
          accelerator: zoomInVisibleAccelerator,
          enabled: canZoomIn,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
        },
        // 仅当 Plus 与原始等号不同才追加隐藏兜底项，避免同键重复注册。
        // 隐藏项 visible 为 false 但 enabled 与可见项一致，保证两种按键行为等价。
        // [失败路径] 去掉该兜底会让 Windows 无 Shift 直接按等号无法放大。
        ...(zoomInVisibleAccelerator !== undefined && zoomInVisibleAccelerator !== zoomInBinding
          ? [
              {
                label: getLabel(desktopMenuMessageIds.viewZoomIn),
                accelerator: zoomInBinding,
                visible: false,
                enabled: canZoomIn,
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomIn),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.viewZoomOut),
          accelerator: resolveMenuAccelerator(options, "zoomOut", "CmdOrCtrl+-"),
          enabled: canZoomOut,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ZoomOut),
        },
        {
          label: getLabel(desktopMenuMessageIds.viewActualSize),
          accelerator: resolveMenuAccelerator(options, "resetZoom", "CmdOrCtrl+0"),
          enabled: canResetZoom,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ResetZoom),
        },
      ],
    },
    {
      label: getLabel(desktopMenuMessageIds.window),
      submenu: [
        { label: getLabel(desktopMenuMessageIds.windowMinimize), role: "minimize" as const },
        ...(process.platform === "darwin"
          ? [
              { label: getLabel(desktopMenuMessageIds.windowZoom), role: "zoom" as const },
              { type: "separator" as const },
              {
                label: getLabel(desktopMenuMessageIds.windowBringAllToFront),
                role: "front" as const,
              },
            ]
          : []),
      ],
    },
    {
      // Help 菜单按平台与运行环境动态拼装，是条件分支最多的子菜单。
      // 非 darwin 先补 About 与检查更新，darwin 这两项已在应用菜单，避免重复。
      label: getLabel(desktopMenuMessageIds.help),
      submenu: [
        // 非 darwin 才把 About 与检查更新放进 Help，条件与 darwin 应用菜单互斥。
        // 条件块末尾补分隔符，保证与后续新版本说明之间有视觉分组。
        ...(process.platform !== "darwin"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpAbout),
                click: () => void options.executeDesktopCommand(DesktopCommandIds.ShowAbout),
              },
              ...(ZCODE_PRODUCT_FLAVOR === "production"
                ? [
                    {
                      id: CHECK_FOR_UPDATE_MENU_ID,
                      label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                      click: () =>
                        void options.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
                    },
                  ]
                : []),
              { type: "separator" as const },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpWhatsNew),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenChangelog),
        },
        { type: "separator" as const },
        // [资源] stdio tap 调试项仅在未打包且状态可见时注册，生产包不暴露。
        // 勾选态来自构建期快照，重建后由 updateZCodeStdioTapDevMenuState 回填。
        ...(isLocalDevelopmentRuntime && stdioTapState.visible
          ? [
              {
                id: HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID,
                label: getLabel(desktopMenuMessageIds.helpToggleZCodeStdioTap),
                type: "checkbox" as const,
                checked: stdioTapState.enabled,
                click: () =>
                  void options.executeDesktopCommand(DesktopCommandIds.ToggleZCodeStdioTapDevProxy),
              },
              { type: "separator" as const },
            ]
          : []),
        // ZCode endpoint 切换只在 test 环境构建出现，生产构建不暴露测试后端入口。
        // 展开为空数组时不能占位，生产菜单结构与旧版本保持一致。
        ...(ZCODE_ENV === "test"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpZCodeEndpoint),
                submenu: [
                  {
                    id: HELP_ZCODE_ENDPOINT_PRODUCTION_MENU_ID,
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointProduction),
                    type: "radio" as const,
                    checked: (options.zcodeEndpointSelection ?? "production") === "production",
                    click: () =>
                      void options.executeDesktopCommand(
                        DesktopCommandIds.SetZCodeEndpointProduction,
                      ),
                  },
                  {
                    id: HELP_ZCODE_ENDPOINT_TEST_MENU_ID,
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointTest),
                    type: "radio" as const,
                    checked: options.zcodeEndpointSelection === "test",
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.SetZCodeEndpointTest),
                  },
                  { type: "separator" as const },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointCustom),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.SetZCodeEndpointCustom),
                  },
                  {
                    label: getLabel(desktopMenuMessageIds.helpZCodeEndpointReset),
                    click: () =>
                      void options.executeDesktopCommand(DesktopCommandIds.ResetZCodeEndpoint),
                  },
                ],
              },
              { type: "separator" as const },
            ]
          : []),
        {
          // DevTools 项使用稳定 id 供外部按 id 查找与联动，role 负责默认行为。
          // click 仍走 ToggleDevTools 命令，确保窗口级状态与 renderer 认知一致。
          id: HELP_TOGGLE_DEV_TOOLS_MENU_ID,
          label: getLabel(desktopMenuMessageIds.helpToggleDevTools),
          role: "toggleDevTools" as const,
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ToggleDevTools),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpResourceManager),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenResourceManager),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpFeedback),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
        },
        {
          label: getLabel(desktopMenuMessageIds.helpExportLogs),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ExportLogs),
        },
        { type: "separator" as const },
        {
          label: getLabel(desktopMenuMessageIds.helpClearAllData),
          click: () => void options.executeDesktopCommand(DesktopCommandIds.ClearAllData),
        },
      ],
    },
  ];
}

// 重建入口：先 buildFromTemplate 再 setApplicationMenu，实现整棵菜单树的原子替换。
// [事务] 先构建后安装，构建抛错时旧菜单继续生效，用户不会看到空菜单栏。
// 入参形态与模板构建完全一致，避免两处 options 定义漂移。
export function rebuildApplicationMenu(options: {
  currentApplicationLocale: Locale;
  zcodeEndpointSelection?: "production" | "test" | "custom";
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  currentZoomLevel?: number;
  shortcutBindings?: Record<string, string[]>;
  /** 快捷键设置页录制态：true 时摘掉全部可配置 accelerator */
  disableShortcutAccelerators?: boolean;
}) {
  // setApplicationMenu 是全局唯一安装点，重复调用即替换整棵菜单树。
  // [资源] 旧 Menu 实例由 Electron 回收，按 id 缓存的引用在重建后必须重新获取。
  // 模板中的 id 常量保证重建后 getMenuItemById 仍能命中对应项。
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate({
        currentApplicationLocale: options.currentApplicationLocale,
        zcodeEndpointSelection: options.zcodeEndpointSelection,
        executeDesktopCommand: options.executeDesktopCommand,
        currentZoomLevel: options.currentZoomLevel,
        shortcutBindings: options.shortcutBindings,
        disableShortcutAccelerators: options.disableShortcutAccelerators,
      }),
    ),
  );
  setAutoUpdaterMenuLocale(options.currentApplicationLocale);
  if (!app.isPackaged) {
    updateZCodeStdioTapDevMenuState();
  }
}
