// INV-01 消息 ID 是唯一真源：菜单项、托盘与程序坞文案都经 desktopMenuMessageIds 取键，守住位置 常量 ID 表；改错故障：任一处硬编码字符串后改名漏改，菜单项静默显示旧文案或空串。
// INV-02 值即字面键：每个 ID 的字符串值必须语义唯一，守住位置 常量对象的值列；改错故障：两处值重复会让不同菜单项共享同一条译文，翻译一侧即污染另一侧。
// INV-03 ID 集合与语言字典键集合严格相等：DesktopMenuLocaleMessages 把键约束成 DesktopMenuMessageId，守住位置 该类型别名；改错故障：放宽为 string 后新增 ID 不会强制补翻译，界面出现原始键名。
// INV-04 类型由值派生而不是手抄：DesktopMenuMessageId 用 typeof 索引取并集，守住位置 类型别名处；改错故障：手写联合类型与表漂移，编译期不再发现缺键。
// INV-05 语言回退只发生在查表入口：未知 locale 落默认语言，守住位置 getDesktopMenuMessage 首行；改错故障：每个调用点各自回退，行为分叉且难以排查。
// INV-06 回退不得返回 undefined：字典必须覆盖默认语言全部键，守住位置 查表函数返回值；改错故障：缺键时 undefined 进入原生菜单构造，窗口创建阶段抛错或显示空白。
// INV-07 占位符替换是纯函数：不修改入参也不缓存结果，守住位置 formatDesktopMenuMessage 函数体；改错故障：原地改写共享字典值后，后续语言切换会带上上一次的参数。
// INV-08 无参数时保留原文：不做空串替换，守住位置 早返回分支；改错故障：把空替代值渲染出去，用户看到 {version} 之类原始占位符。
// INV-09 替换按全局进行：同一文本可含多个相同占位符，守住位置 替换循环；改错故障：只替换首个后剩余占位符原样外泄。
// INV-10 注释只写在导出符号与关键结构上：内部别名不堆注释，守住位置 导出处；改错故障：噪声注释稀释文件头不变量表的可检索性。
// INV-11 两套语言字典键顺序一致：便于逐行 diff，守住位置 两个 locale 对象；改错故障：键顺序错位让漏译被顺序噪声掩盖，审阅者无法快速比对。
// INV-12 文案不得运行期拼接：除登记过的占位符外保持静态，守住位置 值字符串；改错故障：把动态文本写死后，多语言与品牌改名都要改代码。
// INV-13 as const 必须保留：否则值类型退化为 string，ID 派生失效，守住位置 常量表尾部断言；改错故障：删除断言后 keyof 变成 string，编译期校验全部失效。
// INV-14 字典只读：调用方不得改写，守住位置 导出常量；改错故障：渲染层误写回字典后，同进程所有窗口都显示被污染的文案。
// INV-15 缺省参数只允许出现在格式化入口：查表函数不设默认 locale，守住位置 函数签名；改错故障：默认值掩盖调用方漏传 locale 的缺陷。
// INV-16 数字与字符串统一转文本再替换：守住位置 替换循环；改错故障：直接拼接数字会产生科学计数法或本地化差异。
// INV-17 本文件不依赖运行时状态：无 window、无框架实例，守住位置 import 区；改错故障：引入运行时依赖后，主进程菜单构造阶段出现未初始化错误。
// INV-18 新增菜单项须三处同改：ID 表与两个语言字典，守住位置 文件内三处块；改错故障：只加 ID 不加译文，回退路径给用户显示键名。
//
// 模块职责：集中维护桌面壳层（标题栏菜单、程序坞、托盘）的双语文案与消息 ID，只暴露取用与占位符格式化两个入口。
// 状态所有权：无运行时状态；字典与 ID 表均为模块级只读常量，生命周期等同模块加载。
// 阅读顺序：先看 ID 表确认键域，再看两个语言字典核对完整性，最后看取用与格式化两个入口的回退与替换。
import { DEFAULT_LOCALE, type Locale } from "./protocol.js";

// 菜单项文案的键域在此声明：新增一项菜单必须先在这里登记 ID
// [兼容] 值同时被主进程与渲染层消费，重命名等于一次跨进程协议变更
// 值重复会让两个菜单项共享同一条译文，翻译一侧即污染另一侧
// [失败路径] 漏登记时调用方只能硬编码字符串，语言切换后残留旧文案
// 本表只描述键，不含任何语言内容，避免键与译文互相耦合
export const desktopMenuMessageIds = {
  file: "titleBar.menu.file",
  edit: "titleBar.menu.edit",
  view: "titleBar.menu.view",
  window: "titleBar.menu.window",
  help: "titleBar.menu.help",
  fileNewTask: "titleBar.menu.file.newTask",
  fileOpenWorkspace: "titleBar.menu.file.openWorkspace",
  fileCloseWindow: "titleBar.menu.file.closeWindow",
  editUndo: "titleBar.menu.edit.undo",
  editRedo: "titleBar.menu.edit.redo",
  editCut: "titleBar.menu.edit.cut",
  editCopy: "titleBar.menu.edit.copy",
  editPaste: "titleBar.menu.edit.paste",
  editDelete: "titleBar.menu.edit.delete",
  editSelectAll: "titleBar.menu.edit.selectAll",
  viewToggleFullScreen: "titleBar.menu.view.toggleFullScreen",
  viewActualSize: "titleBar.menu.view.actualSize",
  viewZoomIn: "titleBar.menu.view.zoomIn",
  viewZoomOut: "titleBar.menu.view.zoomOut",
  windowMinimize: "titleBar.menu.window.minimize",
  windowZoom: "titleBar.menu.window.zoom",
  windowBringAllToFront: "titleBar.menu.window.bringAllToFront",
  appServices: "titleBar.menu.app.services",
  appHide: "titleBar.menu.app.hide",
  appHideOthers: "titleBar.menu.app.hideOthers",
  appShowAll: "titleBar.menu.app.showAll",
  appQuit: "titleBar.menu.app.quit",
  helpAbout: "titleBar.menu.help.about",
  helpWhatsNew: "titleBar.menu.help.whatsNew",
  helpCheckForUpdates: "titleBar.menu.help.checkForUpdates",
  helpToggleDevTools: "titleBar.menu.help.toggleDevTools",
  helpResourceManager: "titleBar.menu.help.resourceManager",
  helpToggleZCodeStdioTap: "titleBar.menu.help.toggleZCodeStdioTap",
  helpZCodeEndpoint: "titleBar.menu.help.zcodeEndpoint",
  helpZCodeEndpointProduction: "titleBar.menu.help.zcodeEndpoint.production",
  helpZCodeEndpointTest: "titleBar.menu.help.zcodeEndpoint.test",
  helpZCodeEndpointCustom: "titleBar.menu.help.zcodeEndpoint.custom",
  helpZCodeEndpointReset: "titleBar.menu.help.zcodeEndpoint.reset",
  helpFeedback: "titleBar.menu.help.feedback",
  helpExportLogs: "titleBar.menu.help.exportLogs",
  helpClearAllData: "titleBar.menu.help.clearAllData",
  helpCheckingForUpdates: "desktopMenu.help.checkingForUpdates",
  helpUpdateAvailableVersion: "desktopMenu.help.updateAvailableVersion",
  helpDownloadingUpdateVersion: "desktopMenu.help.downloadingUpdateVersion",
  helpDownloadingUpdateProgress: "desktopMenu.help.downloadingUpdateProgress",
  helpRestartToUpdate: "desktopMenu.help.restartToUpdate",
  dockShowCurrentWindow: "dock.menu.showCurrentWindow",
  trayTooltip: "tray.tooltip",
  trayOpenZCode: "tray.menu.openZCode",
  trayQuit: "tray.menu.quit",
// as const 把值收窄成字面量，ID 联合类型才能从值反推
// 去掉断言后值类型退化为 string，键域校验在编译期全部失效
// [权衡] 断言会让对象深度只读，调用方无法也没必要改写
// 与下游 Record 约束配合，任何缺键都会在同一次编译中暴露
// 新增 ID 时本行无需改动，只需保证键值语义仍然唯一
} as const;

export type DesktopMenuMessageId =
  (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds];

// 把「字典必须覆盖全部消息 ID」写成类型约束，而不是靠人工核对
// [失败路径] 若改成 Record<string, string>，新增 ID 不会强制补两种语言
// 键类型来自常量表，因此约束随 ID 表自动扩展
// 缺键在编译期报错，而不是等用户切到该语言才暴露
// 内部别名不导出，防止外部绕过约束自建字典
type DesktopMenuLocaleMessages = Record<DesktopMenuMessageId, string>;

// 两套语言字典共享同一键域类型，结构对称便于逐行比对
// [权衡] 没有按语言拆文件，是因为单文件更便于审阅完整性
// Locale 作为键类型，新增语言时此处必须先补一个完整字典
// 字典是模块级常量，生命周期与模块一致，不做运行期热替换
// [失败路径] 某种语言只写部分键时，类型检查直接失败而非静默回退
export const desktopMenuMessages: Record<Locale, DesktopMenuLocaleMessages> = {
  "zh-CN": {
    "titleBar.menu.file": "文件",
    "titleBar.menu.edit": "编辑",
    "titleBar.menu.view": "视图",
    "titleBar.menu.window": "窗口",
    "titleBar.menu.help": "帮助",
    "titleBar.menu.file.newTask": "新建任务",
    "titleBar.menu.file.openWorkspace": "打开工作区",
    "titleBar.menu.file.closeWindow": "关闭窗口",
    "titleBar.menu.edit.undo": "撤销",
    "titleBar.menu.edit.redo": "重做",
    "titleBar.menu.edit.cut": "剪切",
    "titleBar.menu.edit.copy": "复制",
    "titleBar.menu.edit.paste": "粘贴",
    "titleBar.menu.edit.delete": "删除",
    "titleBar.menu.edit.selectAll": "全选",
    "titleBar.menu.view.toggleFullScreen": "切换全屏",
    "titleBar.menu.view.actualSize": "实际大小",
    "titleBar.menu.view.zoomIn": "放大",
    "titleBar.menu.view.zoomOut": "缩小",
    "titleBar.menu.window.minimize": "最小化",
    "titleBar.menu.window.zoom": "缩放",
    "titleBar.menu.window.bringAllToFront": "全部置于前台",
    "titleBar.menu.app.services": "服务",
    "titleBar.menu.app.hide": "隐藏 {appName}",
    "titleBar.menu.app.hideOthers": "隐藏其他",
    "titleBar.menu.app.showAll": "全部显示",
    "titleBar.menu.app.quit": "退出 {appName}",
    "titleBar.menu.help.about": "关于 ZCode",
    "titleBar.menu.help.whatsNew": "更新日志",
    "titleBar.menu.help.checkForUpdates": "检查更新",
    "titleBar.menu.help.toggleDevTools": "切换开发者工具",
    "titleBar.menu.help.resourceManager": "资源管理器",
    "titleBar.menu.help.toggleZCodeStdioTap": "抓取 Agent stdio 通信",
    "titleBar.menu.help.zcodeEndpoint": "ZCode Endpoint",
    "titleBar.menu.help.zcodeEndpoint.production": "Production（默认）",
    "titleBar.menu.help.zcodeEndpoint.test": "Test",
    "titleBar.menu.help.zcodeEndpoint.custom": "自定义...",
    "titleBar.menu.help.zcodeEndpoint.reset": "恢复默认",
    "titleBar.menu.help.feedback": "问题上报",
    "titleBar.menu.help.exportLogs": "导出日志",
    "titleBar.menu.help.clearAllData": "清除所有数据",
    "desktopMenu.help.checkingForUpdates": "正在检查更新...",
    "desktopMenu.help.updateAvailableVersion": "发现新版本 {version}",
    "desktopMenu.help.downloadingUpdateVersion": "正在下载更新 {version}...",
    "desktopMenu.help.downloadingUpdateProgress": "正在下载更新... {progress}",
    "desktopMenu.help.restartToUpdate": "重启以更新（{version}）",
    "dock.menu.showCurrentWindow": "显示当前窗口",
    "tray.tooltip": "ZCode",
    "tray.menu.openZCode": "打开 ZCode",
    "tray.menu.quit": "退出",
  },
  // 英文侧与中文侧键集合必须完全一致，顺序也保持一致以便 diff
  // [失败路径] 只补中文漏补英文时，英文用户会看到回退后的中文
  // 带占位符的条目两侧必须使用同名占位符，否则替换后残留原文
  // 品牌名以 {appName} 形式出现，便于不同产品线复用同一字典
  // 以静态文本为主，运行期拼接一律通过格式化入口完成
  "en-US": {
    "titleBar.menu.file": "File",
    "titleBar.menu.edit": "Edit",
    "titleBar.menu.view": "View",
    "titleBar.menu.window": "Window",
    "titleBar.menu.help": "Help",
    "titleBar.menu.file.newTask": "New task",
    "titleBar.menu.file.openWorkspace": "Open workspace",
    "titleBar.menu.file.closeWindow": "Close window",
    "titleBar.menu.edit.undo": "Undo",
    "titleBar.menu.edit.redo": "Redo",
    "titleBar.menu.edit.cut": "Cut",
    "titleBar.menu.edit.copy": "Copy",
    "titleBar.menu.edit.paste": "Paste",
    "titleBar.menu.edit.delete": "Delete",
    "titleBar.menu.edit.selectAll": "Select all",
    "titleBar.menu.view.toggleFullScreen": "Toggle full screen",
    "titleBar.menu.view.actualSize": "Actual size",
    "titleBar.menu.view.zoomIn": "Zoom in",
    "titleBar.menu.view.zoomOut": "Zoom out",
    "titleBar.menu.window.minimize": "Minimize",
    "titleBar.menu.window.zoom": "Zoom",
    "titleBar.menu.window.bringAllToFront": "Bring all to front",
    "titleBar.menu.app.services": "Services",
    "titleBar.menu.app.hide": "Hide {appName}",
    "titleBar.menu.app.hideOthers": "Hide others",
    "titleBar.menu.app.showAll": "Show all",
    "titleBar.menu.app.quit": "Quit {appName}",
    "titleBar.menu.help.about": "About ZCode",
    "titleBar.menu.help.whatsNew": "What's new",
    "titleBar.menu.help.checkForUpdates": "Check for updates",
    "titleBar.menu.help.toggleDevTools": "Toggle developer tools",
    "titleBar.menu.help.resourceManager": "Resource manager",
    "titleBar.menu.help.toggleZCodeStdioTap": "Capture agent stdio traffic",
    "titleBar.menu.help.zcodeEndpoint": "ZCode Endpoint",
    "titleBar.menu.help.zcodeEndpoint.production": "Production (default)",
    "titleBar.menu.help.zcodeEndpoint.test": "Test",
    "titleBar.menu.help.zcodeEndpoint.custom": "Custom...",
    "titleBar.menu.help.zcodeEndpoint.reset": "Reset to default",
    "titleBar.menu.help.feedback": "Feedback",
    "titleBar.menu.help.exportLogs": "Export logs",
    "titleBar.menu.help.clearAllData": "Clear all data",
    "desktopMenu.help.checkingForUpdates": "Checking for updates...",
    "desktopMenu.help.updateAvailableVersion": "Update available {version}",
    "desktopMenu.help.downloadingUpdateVersion": "Downloading update {version}...",
    "desktopMenu.help.downloadingUpdateProgress": "Downloading update... {progress}",
    "desktopMenu.help.restartToUpdate": "Restart to update ({version})",
    "dock.menu.showCurrentWindow": "Show current window",
    "tray.tooltip": "ZCode",
    "tray.menu.openZCode": "Open ZCode",
    "tray.menu.quit": "Quit",
  },
};

// 取用入口是唯一允许回退的位置：未知 locale 落到默认语言
// [失败路径] 若直接索引而不回退，未知语言会取到 undefined 并进入渲染层
// 两次查表都命中同一个 ID 类型，避免调用方传入任意字符串
// 该函数不缓存结果，字典常量本身已足够廉价
// 不做 trim 或空值兜底：空译文属于字典缺陷，应在编译期发现
export function getDesktopMenuMessage(locale: Locale, id: DesktopMenuMessageId): string {
  const messages = desktopMenuMessages[locale] ?? desktopMenuMessages[DEFAULT_LOCALE];
  return messages[id];
}

export function formatDesktopMenuMessage(
  locale: Locale,
  id: DesktopMenuMessageId,
  values?: Record<string, string | number>,
): string {
  let message = getDesktopMenuMessage(locale, id);
  if (!values) {
    return message;
  }

  // 占位符替换按条目循环，同一文本可含多个不同占位符
  // [权衡] 采用全局替换而非首个替换，避免重复占位符残留
  // 值统一转字符串，防止数字在拼接时出现本地化格式差异
  // 未传参数时上游已提前返回，这里无需再判空
  // 替换只作用于返回的副本，字典常量本身不被修改
  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, String(value));
  }

  return message;
}
