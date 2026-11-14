/* eslint-disable max-lines -- 强制升级提示窗口包含内联 HTML/CSS 和状态脚本，启动前不能依赖 renderer 包 */
// 做：在强制升级期间用一个独立无边框 BrowserWindow 承载提示与进度，并把用户选择回传给 guard。
// 不做：不实现下载与安装本身（由注入的 startAutoUpdate 负责），不持有主窗口状态，也不加载 renderer 包。
// 依赖：electron 的 BrowserWindow 与 nativeTheme；文案与动作契约来自 forceUpdateGuard；页面是内联 HTML。
// 契约：页面与主进程只能通过 document.title 通信（force-update:action 与 force-update-height:N），无 preload、无 IPC。
// 生命周期：窗口在 app ready 之前就可能出现，只允许依赖 node 内建模块，任何 renderer 依赖都会让强更卡片无法显示。
// 不变量（INV）：
// INV-01 断言：内联 HTML 必须自包含样式与脚本，不得引用外部资源 —— 守住它的位置：renderForceUpdatePromptHtml 的模板 —— 改错故障：启动早期 renderer 未就绪，卡片白屏，用户只能强杀进程。
// INV-02 断言：注入页面的初始状态必须经 JSON.stringify —— 守住它的位置：stateMessages 与 initialState —— 改错故障：文案含引号时脚本出现语法错误，整页交互失效。
// INV-03 断言：插入 HTML 的文本必须逐个 escapeHtml（含 locale 与按钮文案） —— 守住它的位置：模板插值与 detailLines —— 改错故障：文案里的尖括号破坏结构，最坏情况执行被注入的脚本。
// INV-04 断言：detail 必须按行切分并逐行包成版本行 —— 守住它的位置：detailLines 的 split 与 map —— 改错故障：多行版本说明被折成一行，旧版信息与卡片高度都不对。
// INV-05 断言：主进程写页面状态必须用可选调用 —— 守住它的位置：updatePromptState 拼接的脚本 —— 改错故障：页面脚本尚未安装时 executeJavaScript 抛错，状态更新停在第一条。
// INV-06 断言：所有 executeJavaScript 都必须 catch 并 warn —— 守住它的位置：updatePromptState、高度桥注入、初始化 —— 改错故障：窗口销毁或导航产生的 rejection 变成未捕获异常，日志被刷屏。
// INV-07 断言：resolveOnce 只能结算一次，但 closeWindow 独立于结算判断 —— 守住它的位置：resolveOnce 的 resolved 与 closeWindow 两个条件 —— 改错故障：重复结算让 guard 收到两个动作；不关窗则提示窗残留在强更页之上。
// INV-08 断言：窗口被用户关闭时必须把未结算的结果按 quit 交还 —— 守住它的位置：closed 监听器 —— 改错故障：用户关掉提示后 guard 永远等不到动作，进程挂在启动校验阶段。
// INV-09 断言：每次自动升级都要先解绑上一个 dispose 再启动新的 —— 守住它的位置：startAutoUpdate 首行 —— 改错故障：重试后两个订阅同时推进状态，进度在两条流程间跳变。
// INV-10 断言：closed 与 manual/quit 结算前都要调用 autoUpdateDispose —— 守住它的位置：closed 监听器与 page-title-updated 的 manual/quit 分支 —— 改错故障：窗口已关但升级器仍在跑，退出时留下未清理的定时器。
// INV-11 断言：action 必须只认 auto、manual、quit，其余一律按 quit —— 守住它的位置：page-title-updated 的 action 映射 —— 改错故障：未知动作既不结算也不关窗，用户点击后毫无反应。
// INV-12 断言：高度协议必须先于动作协议解析 —— 守住它的位置：page-title-updated 的首个分支 —— 改错故障：标题被当成动作前缀解析，改高度被误判为 quit。
// INV-13 断言：窗口高度变化必须同时 setSize 与 center —— 守住它的位置：updatePromptHeight —— 改错故障：只改尺寸会让卡片偏出屏幕，紧凑态下按钮跑到可视区外。
// INV-14 断言：窗口必须在 ready-to-show、did-finish-load、超时三者中最先发生时显示 —— 守住它的位置：三个 showPromptWindow 入口 —— 改错故障：data: URL 场景下个别事件不触发，用户永远看不到提示。
// INV-15 断言：showPromptWindow 必须幂等，重复调用只做 show 与 focus —— 守住它的位置：shown 标志 —— 改错故障：三个入口叠加会把显示日志刷成多条，掩盖真正的首次显示时间。
// INV-16 断言：无父窗口时必须显式置顶 —— 守住它的位置：showPromptWindow 的 parentWindow 判断 —— 改错故障：开发环境无主窗口时提示被其他窗口盖住，表现为启动卡住。
// INV-17 断言：事件监听必须在 loadURL 之前注册完 —— 守住它的位置：showForceUpdatePrompt 的调用顺序 —— 改错故障：加载过快时 ready-to-show 与 did-finish-load 丢失，窗口始终不显示。
// INV-18 断言：图标读取失败只能降级为字母，不得阻断提示 —— 守住它的位置：readForceUpdatePromptIcon 的 catch —— 改错故障：开发环境没有 build/icon.png 时整个强更卡片弹不出来。
// INV-19 断言：nativeTheme 只用于窗口背景色，不参与页面主题 —— 守住它的位置：new BrowserWindow 的 backgroundColor —— 改错故障：页面用 prefers-color-scheme 自绘，主进程再改颜色会出现启动白闪或黑框。
import { readFileSync } from "node:fs";
// [契约] 图标路径用 node:path 解析而不是字符串拼接：Windows 与 POSIX 的分隔符不同。
// [契约] 本文件只引入 node 内建模块与类型：强更发生在 renderer 加载之前，任何传递依赖都可能缺失。
// [权衡] import 保持在顶层，保证模块加载问题立刻暴露，而不是等到弹窗时才失败。
// [契约] 类型导入必须带 type，避免运行期去加载一个只有类型的模块。
import { resolve } from "node:path";
import { type Locale } from "@zcode/shared";
// [契约] 文案与日志接口来自 guard，这里不自定义结构：两侧字段必须逐一对应。
// [契约] 只用 type 导入：guard 在运行期会依赖本模块，值导入会形成循环。
import type { ForceUpdateDialogText, ForceUpdateGuardLogger } from "./forceUpdateGuard.js";
// [契约] ForceAutoUpdateState 是页面的状态输入之一，新增字段要同时补页面渲染分支。
// [契约] 只导类型：升级器实现由 options 注入，本模块不能自行启动它。
import type { ForceAutoUpdateState } from "./autoUpdater.js";

// [契约] 宽度是内联 HTML 布局的基准：模板里的响应式断点在 560px，改这里要同步检查该分支。
// [契约] minWidth 与 width 相同且 resizable 为 false，用户无法拖拽改变卡片尺寸。
// [权衡] 不做屏幕尺寸自适应：强更提示要在各平台保持同一视觉，尺寸固定更可控。
const FORCE_UPDATE_PROMPT_WIDTH = 480;
// [契约] 默认高度服务检查、错误、确认关闭三种状态，下载态会切到紧凑高度。
// [契约] 这里只是初值，运行时高度由页面通过 title 协议回写，两者不一致时以页面为准。
// [失败路径] 初值过小会让首帧内容被裁切，因此宁可略大也不要贴边。
const FORCE_UPDATE_PROMPT_HEIGHT = 256;
// [契约] main 在紧凑态必须隐藏版本卡片，只保留标题、说明与进度条。
// [契约] 与默认高度的差值来自版本卡片高度，改卡片样式必须同步这个常量。
// [权衡] 不做尺寸动画：resize 由主进程执行，动画期间页面内容会抖动。
const FORCE_UPDATE_PROMPT_COMPACT_HEIGHT = 232;

// [契约] 三个动作是 guard 的唯一输入：auto 表示重试自动升级，manual 表示改用手动，quit 表示放弃。
// [契约] 动作名同时出现在 HTML 的 data-action 与 title 协议里，改名要同步模板脚本。
// [契约] 不允许新增中间态动作：guard 只处理这三条路径，新增会留下未覆盖的结算分支。
type ForceUpdatePromptAction = "auto" | "manual" | "quit";
// [契约] 这是主进程推给页面的状态集合，比 ForceAutoUpdateState 多了 idle 与 confirm-close。
// [契约] confirm-close 是纯 UI 态，不进入升级器：它只在用户点击关闭时短暂存在。
// [失败路径] 页面收到未知 kind 时回落为 idle 视图，因此新增 kind 必须同时补页面分支。
type ForceUpdatePromptState = ForceAutoUpdateState | { kind: "idle" } | { kind: "confirm-close" };
// [契约] 注入式启动器：返回 dispose 用于解绑状态订阅，返回 void 视为无需清理。
// [契约] 回调可能同步触发（例如立即进入 checking），因此调用前必须已经把页面状态准备好。
// [权衡] main 不定义取消语义：取消由窗口关闭驱动，能否中断由升级器自己决定。
type StartForceAutoUpdate = (
  onStateChange: (state: ForceAutoUpdateState) => void,
) => (() => void) | void;

// [契约] main 只允许注入自动升级启动器，窗口、主题与日志都从环境读取，减少调用方负担。
interface ShowForceUpdatePromptOptions {
  startAutoUpdate?: StartForceAutoUpdate;
}

// [契约] 五个替换覆盖标签与属性两种上下文，顺序先 & 后其余，避免二次转义。
// [契约] 该函数同时用于文本与属性值，所以引号必须转义，不能只处理尖括号。
// [权衡] 不依赖第三方转义库：主进程启动早期不应引入额外模块图。
function escapeHtml(value: string): string {
  // [契约] 链式 replaceAll 比单次正则更不容易漏字符，也不要改成一次性映射。
  // [契约] 单引号同样要转义：内联 HTML 中存在单引号包裹的属性。
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// [契约] 图标以内联 data URL 嵌入，避免 file 协议在 default-src 为 none 的 CSP 下被拦。
// [失败路径] 任何异常都返回 null：开发环境没有 build/icon.png 时仍要能弹出提示。
// [权衡] 每次渲染都重新读取而不缓存：强更只发生一次，缓存反而会留下跨版本残留。
function readForceUpdatePromptIcon(): string | null {
  try {
    // [契约] 路径基于 process.cwd() 而不是 __dirname：打包后资源位于运行目录的 build 下。
    // [失败路径] 这里不预先 existsSync，省一次 IO，路径不存在由外层 catch 兜底。
    const iconPath = resolve(process.cwd(), "build/icon.png");
    // [契约] 同步读取是必要的：调用发生在建窗之前的同步路径，异步会让窗口先显示空图标。
    // [契约] 转 base64 而不是直接塞二进制：data URL 只接受编码后的字符串。
    const icon = readFileSync(iconPath).toString("base64");
    // [契约] 返回完整 data URL：CSP 允许 img-src data:，因此图标不会触发额外网络请求。
    // [契约] MIME 固定 png：build/icon.png 由打包流程保证格式，换扩展名会显示破图。
    return `data:image/png;base64,${icon}`;
  } catch {
    return null;
  }
}

// [契约] 文案是内联脚本的一部分，页面脚本直接按这些键取值，改名必须同步模板。
// [契约] 只支持 zh-CN 与默认英文：其他语言回落到英文，避免强更页出现未翻译的空白。
// [权衡] 不复用 UI 包的 i18n：强更发生在 renderer 加载之前，不能依赖它的文案运行时。
function buildForceUpdatePromptMessages(locale: Locale) {
  // [契约] 中文分支必须返回完整键集合，缺键会让页面显示 undefined。
  // [契约] 两套文案的键必须一一对应，新增键要同时加两处。
  if (locale === "zh-CN") {
    return {
      // [契约] 下载态标题含 {version} 占位符，由页面脚本替换；占位符缺失时原样显示。
      // [契约] main 的按钮文案区分进行时，与可用状态一起决定禁用。
      checkingTitle: "正在检查更新",
      checkingMessage: "请保持此窗口打开，ZCode 正在查找可用更新。",
      downloadingTitle: "正在下载更新",
      downloadingVersionTitle: "正在下载更新 v{version}",
      downloadingMessage: "下载完成后会自动安装，请勿关闭应用。",
      readyTitle: "更新已下载",
      readyMessage: "ZCode 正在准备重启并安装更新。",
      installingTitle: "正在安装更新",
      installingMessage: "ZCode 即将重启完成安装。",
      errorTitle: "自动升级失败",
      errorMessage: "你可以重试自动升级，或改用手动升级。",
      devSkippedTitle: "调试环境无法自动升级",
      devSkippedMessage: "自动升级仅在打包后的应用中可用，请使用手动升级或打包应用验证。",
      confirmCloseTitle: "自动升级正在进行",
      confirmCloseMessage: "关闭窗口会中断当前自动升级流程，旧版本仍然无法进入主界面。你可以继续等待，或确认关闭并退出。",
      confirmCloseButton: "确认关闭",
      continueUpdateButton: "继续更新",
      retryButton: "重试自动升级",
      // [契约] 进行时按钮文案会在下载态被页面拼上百分比，这里不要自带百分号。
      checkingButton: "检查中...",
      downloadingButton: "下载中...",
      installingButton: "安装中...",
    };
  }

  return {
    // [契约] 英文分支是所有其他语言的兜底，键集合必须与中文完全一致。
    // [契约] 文案里不要出现 HTML 标签：页面按纯文本插值并依赖 escapeHtml。
    // [权衡] i18n 文案与中文保持同结构，便于逐键对比排查漏翻。
    checkingTitle: "Checking for updates",
    checkingMessage: "Keep this window open while ZCode checks for updates.",
    downloadingTitle: "Downloading update",
    downloadingVersionTitle: "Downloading update v{version}",
    downloadingMessage: "ZCode will install the update automatically after download.",
    readyTitle: "Update downloaded",
    readyMessage: "ZCode is preparing to restart and install the update.",
    installingTitle: "Installing update",
    installingMessage: "ZCode will restart to finish installing the update.",
    errorTitle: "Auto update failed",
    errorMessage: "You can retry auto update or use manual update.",
    devSkippedTitle: "Auto update unavailable in development",
    devSkippedMessage: "Auto update is only available in packaged apps. Use manual update or test a packaged build.",
    confirmCloseTitle: "Auto update in progress",
    confirmCloseMessage: "Closing this window will stop the current auto update flow, and this old version still cannot open the main app. You can keep waiting or close and quit.",
    confirmCloseButton: "Close anyway",
    continueUpdateButton: "Continue update",
    retryButton: "Retry auto update",
    checkingButton: "Checking...",
    downloadingButton: "Downloading...",
    installingButton: "Installing...",
  };
}

// [契约] 整个页面是一段字符串：任何插值都必须显式转义，且不能引用外部资源。
// [契约] 返回完整 HTML 而不是片段，调用方直接用 data: URL 加载。
// [契约] CSP 在模板里声明，只允许内联样式与脚本以及 data: 图片，放宽它会削弱这层隔离。
function renderForceUpdatePromptHtml(text: ForceUpdateDialogText, locale: Locale): string {
  // [契约] 图标是可选内容，null 时页面渲染字母占位。
  // [契约] 读取发生在拼接 HTML 之前，保证生成结果是纯字符串，可重复生成。
  const icon = readForceUpdatePromptIcon();
  // [契约] 文案表与初始状态分别序列化后再插入，不能直接拼接对象字面量。
  // [契约] main 只在生成时读取这些内容一次，页面长期持有，状态切换不重新加载页面。
  const messages = buildForceUpdatePromptMessages(locale);
  // [契约] 版本说明必须按行拆成独立 div，保留换行语义，同时避免整段文本被 HTML 折叠。
  // [契约] 每一行都要单独转义：拼接完成后再转义会把生成的标签也转义掉。
  const detailLines = text.detail
    .split("\n")
    // [契约] 每行包一个 div 并转义，版本号里的特殊字符不会破坏结构。
    // [契约] join 空串而不是换行：多余的换行在 pre-wrap 下会变成额外空行。
    .map((line) => `<div class="version-row">${escapeHtml(line)}</div>`)
    .join("");
  // [契约] JSON.stringify 保证引号合法；内容来自内部文案常量而非用户输入，因此不再做 HTML 转义。
  // [失败路径] 若将来文案改为用户可控，这里必须补尖括号转义，否则能提前闭合 script 标签。
  const stateMessages = JSON.stringify(messages);
  // [契约] 初始标题与按钮文案来自 guard，必须一起注入：页面重置回 idle 时要用它们。
  // [契约] detailHtml 已经是转义后的片段，页面直接以 innerHTML 写入。
  const initialState = JSON.stringify({
    title: text.title,
    message: text.message,
    detailHtml: detailLines,
    autoButton: text.autoUpdateButton,
    manualButton: text.manualUpdateButton,
    quitButton: text.quitButton,
  });

  // [契约] 从这里开始的模板字符串里不能插入行注释：任何双斜杠都会成为页面可见文本。
  // [契约] 语言写进 html lang，影响页面字体与系统控件的语言表现。
  // [契约] 主题由 prefers-color-scheme 决定，与主进程 backgroundColor 保持一致，避免白闪。
  // [契约] 内联脚本放在 body 末尾：元素查询依赖 DOM 已经存在。
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
  <title>${escapeHtml(text.title)}</title>
    <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f8f8f8;
      color: #0d0d0d;
      user-select: none;
    }
    .window {
      width: 100vw;
      height: 100vh;
      padding: 0;
      background: #f8f8f8;
      display: flex;
    }
    /* Bugfix: 强更截图范围就是完整 BrowserWindow；外层留白加内层圆角会把宿主底色显示成黑框。 */
    .panel {
      width: 100%;
      height: 100%;
      min-height: 0;
      background: #ffffff;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .titlebar {
      height: 36px;
      padding: 0 48px 0 14px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      position: relative;
      -webkit-app-region: drag;
      border-bottom: 1px solid rgba(13, 13, 13, 0.1);
      background: #f0f0f0;
    }
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .brand-icon {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: #ebf4ff;
      border: 1px solid rgba(13, 13, 13, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      color: #0b7fff;
      font-size: 12px;
      font-weight: 600;
    }
    .brand-icon img { width: 100%; height: 100%; border-radius: 6px; }
    .brand-title { font-size: 13px; font-weight: 500; color: #0d0d0d; }
    .close {
      position: absolute;
      right: 0;
      top: 0;
      width: 46px;
      height: 36px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: rgba(13, 13, 13, 0.62);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0;
      line-height: 0;
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    /* Bugfix: 字体字符 × 的字形基线会让视觉中心偏移，改用两条线保证和主窗口关闭按钮一致居中。 */
    .close::before,
    .close::after {
      content: "";
      position: absolute;
      width: 15px;
      height: 2px;
      border-radius: 999px;
      background: currentColor;
    }
    .close::before { transform: rotate(45deg); }
    .close::after { transform: rotate(-45deg); }
    .close:hover { background: #f8f8f8; color: #0d0d0d; }
    .content {
      padding: 18px 20px 20px;
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 14px;
    }
    .hero { display: flex; gap: 12px; align-items: flex-start; }
    .status-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: color-mix(in oklab, #0b7fff 12%, transparent);
      border: 1px solid rgba(13, 13, 13, 0.1);
      color: #0b7fff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .status-icon svg { width: 20px; height: 20px; }
    h1 { margin: 0; font-size: 15px; line-height: 1.45; font-weight: 600; color: #0d0d0d; }
    .message { margin: 6px 0 0; color: rgba(13, 13, 13, 0.62); font-size: 13px; line-height: 1.6; }
    .version-card {
      border: 1px solid rgba(13, 13, 13, 0.1);
      background: #f0f0f0;
      border-radius: 12px;
      padding: 12px 14px;
      color: #0d0d0d;
      font-size: 13px;
      line-height: 1.7;
    }
    .version-card.hidden { display: none; }
    .version-row { white-space: pre-wrap; }
    .progress { display: none; gap: 8px; flex-direction: column; }
    .progress.visible { display: flex; }
    .progress-track { height: 6px; border-radius: 999px; background: rgba(13, 13, 13, 0.08); overflow: hidden; }
    .progress-bar { width: 0%; height: 100%; border-radius: inherit; background: #0b7fff; transition: width 160ms ease; }
    .progress-text { color: rgba(13, 13, 13, 0.62); font-size: 12px; }
    .actions {
      margin-top: auto;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      -webkit-app-region: no-drag;
    }
    button {
      min-width: 88px;
      height: 28px;
      border: 1px solid rgba(13, 13, 13, 0.1);
      background: #ffffff;
      color: #0d0d0d;
      border-radius: 6px;
      padding: 0 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover { background: #f8f8f8; border-color: rgba(13, 13, 13, 0.15); }
    button:disabled { cursor: default; opacity: 0.58; }
    button.primary { border-color: transparent; background: #000000; color: #ffffff; }
    button.primary:hover { background: rgba(0, 0, 0, 0.82); }
    button.secondary { background: #e6e6e6; }
    button.secondary:hover { background: #f0f0f0; }
    @media (prefers-color-scheme: dark) {
      body { background: #2b2b2b; color: #f8f8f8; }
      .window { background: #2b2b2b; }
      .panel { background: #2b2b2b; border-color: transparent; }
      .titlebar { background: #202020; border-bottom-color: rgba(255, 255, 255, 0.1); }
      .brand-title, h1 { color: #f8f8f8; }
      .brand-icon { background: #001d3d; border-color: rgba(255, 255, 255, 0.1); color: #80beff; }
      .close { color: rgba(248, 248, 248, 0.64); }
      .close:hover { background: #363636; border-color: rgba(255, 255, 255, 0.15); color: #f8f8f8; }
      .message { color: rgba(248, 248, 248, 0.64); }
      .status-icon { background: color-mix(in oklab, #4099ff 14%, transparent); border-color: rgba(255, 255, 255, 0.1); color: #80beff; }
      .version-card { border-color: rgba(255, 255, 255, 0.1); background: #202020; color: #f8f8f8; }
      .progress-track { background: rgba(255, 255, 255, 0.1); }
      .progress-bar { background: #80beff; }
      .progress-text { color: rgba(248, 248, 248, 0.64); }
      button { border-color: rgba(255, 255, 255, 0.1); background: #2b2b2b; color: #f8f8f8; }
      button:hover { background: #363636; border-color: rgba(255, 255, 255, 0.15); }
      button.primary { border-color: transparent; background: #ffffff; color: #161616; }
      button.primary:hover { background: rgba(255, 255, 255, 0.82); }
      button.secondary { background: #363636; }
      button.secondary:hover { background: #2b2b2b; }
    }
    @media (max-width: 560px) {
      .window { padding: 0; }
      .content { padding: 16px; }
      .actions { flex-wrap: wrap; }
      button { min-width: 0; flex: 1 1 0; }
    }
  </style>
</head>
<body>
  <div class="window">
    <main class="panel" role="dialog" aria-modal="true" aria-labelledby="title">
      <header class="titlebar">
        <div class="brand">
          <div class="brand-icon">${icon ? `<img src="${icon}" alt="" />` : "Z"}</div>
          <div class="brand-title">ZCode</div>
        </div>
        <button class="close" type="button" data-action="quit" aria-label="${escapeHtml(text.quitButton)}">×</button>
      </header>
      <section class="content">
        <div class="hero">
          <div class="status-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
          </div>
          <div>
            <h1 id="title" data-role="status-title">${escapeHtml(text.title)}</h1>
            <p class="message" data-role="status-message">${escapeHtml(text.message)}</p>
          </div>
        </div>
        <section class="version-card" data-role="detail">${detailLines}</section>
        <section class="progress" data-role="progress" aria-live="polite">
          <div class="progress-track"><div class="progress-bar" data-role="progress-bar"></div></div>
          <div class="progress-text" data-role="progress-text"></div>
        </section>
        <div class="actions">
          <button type="button" data-action="quit" data-role="quit-button">${escapeHtml(text.quitButton)}</button>
          <button type="button" class="secondary" data-action="manual" data-role="manual-button">${escapeHtml(text.manualUpdateButton)}</button>
          <button type="button" class="primary" data-action="auto" data-role="auto-button">${escapeHtml(text.autoUpdateButton)}</button>
        </div>
      </section>
    </main>
  </div>
  <script>
    const messages = ${stateMessages};
    const initialState = ${initialState};
    let currentState = { kind: 'idle' };
    let previousAutoState = null;
    const elements = {
      title: document.querySelector('[data-role="status-title"]'),
      message: document.querySelector('[data-role="status-message"]'),
      detail: document.querySelector('[data-role="detail"]'),
      progress: document.querySelector('[data-role="progress"]'),
      progressBar: document.querySelector('[data-role="progress-bar"]'),
      progressText: document.querySelector('[data-role="progress-text"]'),
      autoButton: document.querySelector('[data-role="auto-button"]'),
      manualButton: document.querySelector('[data-role="manual-button"]'),
      quitButton: document.querySelector('[data-role="quit-button"]'),
    };
    function resizePromptHeight(height) {
      if (window.__setForceUpdatePromptHeight) {
        window.__setForceUpdatePromptHeight(height);
      }
    }
    function setDetailVisible(visible) {
      elements.detail.classList.toggle('hidden', !visible);
      if (visible) {
        elements.detail.innerHTML = initialState.detailHtml;
      }
    }
    function formatMessage(template, values) {
      return String(template).replace(/{(\\w+)}/g, (_, key) => values && values[key] ? values[key] : '');
    }
    function setProgress(percent, text) {
      const visible = typeof percent === 'number' || Boolean(text);
      elements.progress.classList.toggle('visible', visible);
      elements.progressBar.style.width = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) + '%' : '0%';
      elements.progressText.textContent = text || '';
    }
    function setButtons(autoText, autoDisabled) {
      elements.autoButton.textContent = autoText;
      elements.autoButton.disabled = Boolean(autoDisabled);
      elements.manualButton.disabled = false;
      elements.quitButton.disabled = false;
    }
    function isActiveAutoState(kind) {
      return kind === 'checking' || kind === 'downloading' || kind === 'ready' || kind === 'installing';
    }
    function showCloseConfirmation() {
      // Bugfix: 自动升级会禁用主按钮，但关闭窗口仍应给用户二次确认，避免误关中断下载。
      resizePromptHeight(${FORCE_UPDATE_PROMPT_HEIGHT});
      previousAutoState = isActiveAutoState(currentState.kind) ? currentState : previousAutoState;
      currentState = { kind: 'confirm-close' };
      elements.title.textContent = messages.confirmCloseTitle;
      elements.message.textContent = messages.confirmCloseMessage;
      setDetailVisible(true);
      setProgress(undefined, '');
      elements.quitButton.textContent = messages.continueUpdateButton;
      elements.manualButton.textContent = initialState.manualButton;
      elements.autoButton.textContent = messages.confirmCloseButton;
      elements.quitButton.disabled = false;
      elements.manualButton.disabled = false;
      elements.autoButton.disabled = false;
    }
    window.__setForceUpdateState = function (state) {
      const kind = state && state.kind;
      if (kind !== 'confirm-close') {
        currentState = state || { kind: 'idle' };
      }
      if (kind === 'checking') {
        resizePromptHeight(${FORCE_UPDATE_PROMPT_HEIGHT});
        elements.title.textContent = messages.checkingTitle;
        elements.message.textContent = messages.checkingMessage;
        setDetailVisible(true);
        setProgress(undefined, '');
        setButtons(messages.checkingButton, true);
        return;
      }
      if (kind === 'downloading') {
        const progress = Number.parseFloat(state.progress || '');
        const hasProgress = Number.isFinite(progress);
        const version = state.version || '';
        resizePromptHeight(${FORCE_UPDATE_PROMPT_COMPACT_HEIGHT});
        elements.title.textContent = version ? formatMessage(messages.downloadingVersionTitle, { version }) : messages.downloadingTitle;
        elements.message.textContent = messages.downloadingMessage;
        setDetailVisible(false);
        setProgress(hasProgress ? progress : undefined, hasProgress ? progress.toFixed(0) + '%' : '');
        setButtons(hasProgress ? messages.downloadingButton + ' ' + progress.toFixed(0) + '%' : messages.downloadingButton, true);
        return;
      }
      if (kind === 'ready' || kind === 'installing') {
        resizePromptHeight(${FORCE_UPDATE_PROMPT_COMPACT_HEIGHT});
        elements.title.textContent = kind === 'ready' ? messages.readyTitle : messages.installingTitle;
        elements.message.textContent = kind === 'ready' ? messages.readyMessage : messages.installingMessage;
        setDetailVisible(false);
        setProgress(100, '100%');
        setButtons(messages.installingButton, true);
        return;
      }
      if (kind === 'error' || kind === 'dev-skipped') {
        resizePromptHeight(${FORCE_UPDATE_PROMPT_HEIGHT});
        elements.title.textContent = kind === 'dev-skipped' ? messages.devSkippedTitle : messages.errorTitle;
        elements.message.textContent = state.message || (kind === 'dev-skipped' ? messages.devSkippedMessage : messages.errorMessage);
        setDetailVisible(true);
        setProgress(undefined, '');
        setButtons(messages.retryButton, false);
        return;
      }
      resizePromptHeight(${FORCE_UPDATE_PROMPT_HEIGHT});
      elements.title.textContent = initialState.title;
      elements.message.textContent = initialState.message;
      setDetailVisible(true);
      setProgress(undefined, '');
      setButtons(initialState.autoButton, false);
      elements.manualButton.textContent = initialState.manualButton;
      elements.quitButton.textContent = initialState.quitButton;
    };
    window.__confirmForceUpdateClose = function () {
      showCloseConfirmation();
    };
    document.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        let action = button.dataset.action;
        if ((action === 'quit' || action === 'manual') && isActiveAutoState(currentState.kind)) {
          showCloseConfirmation();
          return;
        }
        if (currentState.kind === 'confirm-close') {
          if (action === 'quit') {
            window.__setForceUpdateState(previousAutoState || { kind: 'checking' });
            return;
          }
          if (action === 'auto') {
            action = 'quit';
          }
        }
        document.title = 'force-update:' + action;
        setTimeout(() => {
          if (document.title === 'force-update:' + action) {
            document.title = initialState.title;
          }
        }, 0);
      });
    });
  </script>
</body>
</html>`;
}

// [契约] 返回 Promise 直到用户做出选择：guard 依赖它阻塞主界面启动。
// [契约] 窗口独立于主窗口、也不加载 renderer，所以 electron 用动态 import 延后加载。
// [失败路径] 任何加载失败都必须仍然显示窗口，否则强更流程表现为什么都没发生。
export async function showForceUpdatePrompt(
  text: ForceUpdateDialogText,
  locale: Locale,
  logger: ForceUpdateGuardLogger,
  options: ShowForceUpdatePromptOptions = {},
): Promise<ForceUpdatePromptAction> {
  // [契约] 动态 import 而不是顶层导入：本模块在 app ready 之前就被加载，延后可以缩短启动关键路径。
  // [契约] nativeTheme 只用于窗口背景色，页面主题由 CSS 媒体查询自行决定。
  // [权衡] 不等待 app.whenReady：强更提示必须早于主窗口，等待 ready 会把卡片推到首屏之后。
  const { BrowserWindow, nativeTheme } = await import("electron");
  // [契约] 有主窗口时作为 modal 父窗口，保证提示永远盖在主界面之上。
  // [失败路径] 没有主窗口时 parent 为 undefined，此时必须依赖 alwaysOnTop 兜住可见性。
  const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
  // [契约] 结算函数只在这里暴露，其余逻辑统一经 resolveOnce 调用。
  // [契约] executor 是同步的：窗口与监听在同一个 tick 内建好，避免状态事件落在监听注册之前。
  return new Promise<ForceUpdatePromptAction>((resolvePrompt) => {
    // [契约] 记录动作是否已交还 guard，与窗口是否关闭是两个独立维度。
    // [契约] 只有 resolved 为 false 时才调用 resolvePrompt，保证 guard 只收到一次结果。
    let resolved = false;
    // [契约] 该标记必须只用于日志去重，不参与显示逻辑，显示本身是幂等的。
    // [契约] 三个入口竞争，source 由第一次胜出者决定，便于定位是哪个事件救活了窗口。
    let shown = false;
    // [契约] 保存升级器返回的解绑函数，窗口关闭或重试时必须调用。
    // [失败路径] 为 undefined 表示升级器没有提供清理能力，此时只能依赖进程退出。
    let autoUpdateDispose: (() => void) | undefined;
    // [契约] 兜底计时器保证 ready-to-show 与 did-finish-load 都未触发时窗口仍可见。
    // [资源] 结算时必须清除，否则窗口关闭后还会触发一次 show，对已销毁窗口报错。
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    // [契约] frame 与 roundedCorners 都关闭：卡片自绘标题栏，系统圆角会露出宿主底色。
    // [契约] show 为 false 且 paintWhenInitiallyHidden 为 true：先完成绘制再显示，避免白屏闪烁。
    // [契约] sandbox 与 contextIsolation 同时开启且不加载 preload：页面没有任何 Node 能力。
    // [契约] alwaysOnTop 只在无父窗口时开启，有父窗口时由 modal 关系保证层级。
    const win = new BrowserWindow({
      width: FORCE_UPDATE_PROMPT_WIDTH,
      height: FORCE_UPDATE_PROMPT_HEIGHT,
      minWidth: FORCE_UPDATE_PROMPT_WIDTH,
      minHeight: FORCE_UPDATE_PROMPT_HEIGHT,
      parent: parentWindow,
      modal: Boolean(parentWindow),
      frame: false,
      transparent: false,
      hasShadow: true,
      roundedCorners: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: !parentWindow,
      center: true,
      focusable: true,
      skipTaskbar: false,
      paintWhenInitiallyHidden: true,
      title: text.title,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#2b2b2b" : "#f8f8f8",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    // [契约] 通过 executeJavaScript 注入状态而不是 webContents.send：页面没有 preload，收不到 IPC。
    // [失败路径] 窗口已销毁时直接返回，避免在关闭流程中注入脚本。
    const updatePromptState = (state: ForceUpdatePromptState) => {
      if (win.isDestroyed()) {
        return;
      }
      // [契约] 可选调用加 JSON.stringify：状态对象不会破坏脚本语法，页面未就绪时也不会抛错。
      // [权衡] 不做状态排队：页面渲染是幂等的，后到的状态自然覆盖先到的。
      const script = `window.__setForceUpdateState?.(${JSON.stringify(state)})`;
      // [契约] void 前缀表示有意丢弃 Promise：调用点不等待注入结果。
      // [失败路径] catch 必须保留：窗口销毁或导航中注入会 reject，不接会产生未捕获异常。
      // [契约] 日志只带 error 不带状态内容：状态里是重复的版本文案，写进日志没有价值。
      void win.webContents.executeJavaScript(script).catch((error) => {
        logger.warn("[force-update] 更新强制升级提示状态失败", { error });
      });
    };

    // [契约] 页面高度必须由页面根据内容请求，main 只负责执行，不猜测布局。
    // [资源] 改尺寸后重新 center，避免窗口变矮时向下漂移。
    const updatePromptHeight = (height: number) => {
      if (win.isDestroyed()) {
        return;
      }
      // 下载态隐藏版本说明后需要收回窗口高度，避免出现大片空白；确认关闭/错误态再恢复默认高度。
      // [契约] 用 setSize 而不是 setContentSize：无边框窗口两者等价，但前者不引入额外绘制差异。
      // [契约] 尺寸变化是同步的，紧接着的 center 才能基于新尺寸计算。
      win.setSize(FORCE_UPDATE_PROMPT_WIDTH, height);
      win.center();
    };

    // [契约] resolved 与 closeWindow 分开控制：已结算但仍需关窗时，不能因 resolved 提前返回。
    // [契约] 先结算再关窗：关窗触发的 closed 回调会看到 resolved 为真，不会重复结算。
    // [资源] 关窗前清掉兜底计时器，否则窗口销毁后计时器仍会尝试 show。
    const resolveOnce = (action: ForceUpdatePromptAction, closeWindow: boolean) => {
      // [契约] 已结算且不关窗时直接返回，这是唯一的重复结算防护。
      // [契约] closeWindow 为真时仍要继续往下走：关闭动作与是否已结算无关。
      // [权衡] 不在这里清计时器：清理统一由下面的 fallbackTimer 分支处理，避免两处重复。
      if (resolved && !closeWindow) {
        return;
      }
      // [契约] 先置 resolved 再 resolvePrompt：同步回调再次进入时不会重复结算。
      // [契约] resolvePrompt 之后不再做任何可能抛错的事，保证结算一定完成。
      if (!resolved) {
        resolved = true;
        resolvePrompt(action);
      }
      // [资源] 清除后不置 undefined：计时器已不可能再次触发，重复 clear 无害。
      // [契约] 清理放在结算之后、关窗之前：关窗触发的 closed 回调不会再看到活动计时器。
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
      if (closeWindow && !win.isDestroyed()) {
        win.close();
      }
    };

    // [契约] 重试路径必须先解绑上一次订阅，否则两个升级流程会同时推进页面状态。
    // [契约] 先推 checking 再启动：升级器可能同步回调 downloading，页面必须已有基础视图。
    // [失败路径] 启动器抛错不在这里捕获：交给 guard 决定是否降级为手动升级。
    const startAutoUpdate = () => {
      // [契约] main 在重试前必须先解绑旧订阅，避免两条升级流程同时写页面状态。
      // [契约] 解绑后不置空：紧接着会重新赋值；若启动器抛错，保留旧引用便于下次重试再解绑。
      if (autoUpdateDispose) {
        autoUpdateDispose();
      }
      logger.info("[force-update] 用户选择自动升级");
      updatePromptState({ kind: "checking" });
      // [契约] 用空值合并归一化为 undefined：启动器返回 void 时便于后续可选调用。
      // [契约] 赋值发生在启动之后：启动器同步回调时 dispose 尚未就绪，这是它自身的自洽责任。
      autoUpdateDispose = options.startAutoUpdate?.((state) => updatePromptState(state)) ?? undefined;
    };

    // [契约] 显示入口幂等：三个事件与兜底计时器都可能调用，重复 show 不会产生额外窗口。
    // [契约] focus 是必要的：无父窗口的提示在 Windows 上可能显示但不抢焦点。
    // [失败路径] 窗口已销毁时直接返回，避免 ready-to-show 在关闭后迟到触发。
    const showPromptWindow = (source: string) => {
      // [契约] 显示入口也要判销毁：ready-to-show 与兜底计时器可能在窗口关闭后才到达。
      // [失败路径] 直接 return 而不是抛错：此时已无需显示，抛错只会污染日志。
      if (win.isDestroyed()) {
        return;
      }
      if (!shown) {
        shown = true;
        logger.info(`[force-update] 显示强制升级提示窗口 source=${source}`);
      }
      // [契约] 先 show 再 focus：顺序反了在 macOS 上可能只激活窗口而不置顶。
      // [契约] 这里不改 alwaysOnTop：层级策略在创建时已按有无父窗口决定。
      // [契约] 重复 show 不会重建窗口，因此三个入口可以安全竞争。
      win.show();
      win.focus();
      // 启动前没有主窗口时，原生消息框在部分开发环境不可见；显式置顶保证用户能看到强制升级提示。
      // [契约] 只有无父窗口时才显式置顶：有父窗口时 modal 关系已足够，重复置顶会盖住系统弹窗。
      // [契约] 置顶级别用 modal-panel 而不是 screen-saver，避免覆盖系统级对话框。
      if (!parentWindow) {
        win.setAlwaysOnTop(true, "modal-panel");
      }
    };

    // [契约] 用户直接关窗时也必须把结果交还 guard，否则启动校验会永久挂起。
    // [契约] 结算用 quit 而不是 manual：关闭意味着放弃升级，manual 会走另一条路径。
    // [资源] main 必须先解绑升级订阅再结算：关窗后升级器不应再尝试更新已销毁的页面。
    win.on("closed", () => {
      autoUpdateDispose?.();
      if (!resolved) {
        // 自动升级是异步流程，用户关闭保留中的强更窗口时仍要把最终退出动作交还给 guard。
        resolveOnce("quit", false);
      }
    });
    // [契约] title 是唯一通信通道：页面通过改标题发事件，这里 preventDefault 阻止标题栏变化。
    // [契约] 高度协议必须先判断：它是动作协议的扩展前缀，顺序反了会被当成未知动作。
    // [契约] 未知 action 一律按 quit 处理，保证用户操作总能让流程收尾。
    win.webContents.on("page-title-updated", (event, title) => {
      // [契约] 高度请求只接受可解析的整数，NaN 直接忽略并继续走动作判断。
      // [契约] 解析后立刻 return，避免同一标题被当成动作前缀二次处理。
      if (title.startsWith("force-update-height:")) {
        event.preventDefault();
        const height = Number.parseInt(title.slice("force-update-height:".length), 10);
        // [契约] 只接受有限数：页面可能传空串或 NaN，直接 setSize 会抛错。
        // [契约] 不额外限制上下界：高度由页面脚本决定，主进程再夹取会与模板布局脱节。
        if (Number.isFinite(height)) {
          updatePromptHeight(height);
        }
        return;
      }
      // [契约] 非协议标题一律放行、不 preventDefault：Chromium 可能改写空标题。
      // [契约] 该判断必须在 preventDefault 之前，否则会冻结正常标题。
      if (!title.startsWith("force-update:")) {
        return;
      }
      event.preventDefault();
      const action = title.slice("force-update:".length);
      // [契约] auto 只启动升级、不结算：动作要等升级器给出 ready 或 error 后由用户再次选择。
      // [契约] 这里不校验 autoUpdateDispose 是否存在，重试允许覆盖旧订阅。
      if (action === "auto") {
        startAutoUpdate();
        return;
      }
      autoUpdateDispose?.();
      resolveOnce(action === "manual" ? "manual" : "quit", true);
    });
    // [契约] ready-to-show 是首选显示时机：首帧已绘制，不会闪白。
    // [契约] 该事件在部分平台与 data: URL 组合下可能不触发，因此不是唯一入口。
    win.once("ready-to-show", () => showPromptWindow("ready-to-show"));
    // [契约] 加载完成后才注入高度桥：此时页面脚本已安装，注入不会落空。
    // [契约] 注入失败只会 warn，不影响其他功能：高度桥只是优化，尺寸有默认值。
    // [契约] did-finish-load 也调用显示，与 ready-to-show 互为兜底。
    win.webContents.once("did-finish-load", () => {
      void win.webContents
        // [契约] main 注入的高度桥脚本用单引号拼串：外层是模板字符串，避免嵌套转义。
        // [契约] 页面只能拿到一个写标题的函数，无法直接触碰主进程。
        .executeJavaScript(
          `window.__setForceUpdatePromptHeight = (height) => { document.title = 'force-update-height:' + height; };`,
        )
        .catch((error) => {
          logger.warn("[force-update] 初始化强制升级窗口高度桥失败", { error });
        });
      showPromptWindow("did-finish-load");
    });
    // [契约] 加载失败仍要显示窗口：否则用户只看到应用卡住，没有任何可操作界面。
    // [失败路径] 只记录错误码与描述、不重试加载：data: URL 失败通常说明代码本身有问题。
    win.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      logger.warn("[force-update] 强制升级提示窗口加载失败", { errorCode, errorDescription });
      showPromptWindow("did-fail-load");
    });
    // [契约] 1 秒兜底覆盖两个事件都未触发的情况，保证提示一定可见。
    // [契约] 计时器不 unref：强更流程本身就要阻塞退出，没有必要让进程提前结束。
    // [资源] 结算与关闭时清除，避免对已销毁窗口调用 show。
    fallbackTimer = setTimeout(() => showPromptWindow("timeout"), 1000);
    // [契约] 监听必须全部注册完再 loadURL，否则快速加载会丢掉 ready-to-show 与 did-finish-load。
    // [契约] 用 encodeURIComponent 包裹整个 HTML：中文文案直接拼进 data: URL 会破坏 URL 结构。
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderForceUpdatePromptHtml(text, locale))}`);
  });
}
