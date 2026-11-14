/* eslint-disable max-lines -- 终端 resize 调度需要和 xterm/PTY 生命周期放在同一组件内，避免拖拽状态、fit、后端 resize 队列拆散后出现竞态。*/
// ============================================================================
// 职责边界
// 做：在组件内托管单个 xterm 实例 + 单条 PTY 的完整生命周期（创建、fit/resize 调度、
//     主题与字体下发、data/exit 订阅、Windows 组合输入兜底、右键复制粘贴菜单）。
// 不做：不持有 workspace/tab 业务状态，不决定哪个 session 可见（isVisible 由上层传入），
//       不实现 PTY 协议，不直接访问平台 API（一律经 IServiceAccessor / 平台注入）。
// 依赖：terminalService（create/resize/write/dispose/onDynamicData/onDynamicExit）、
//       sidePaneTerminalSessionRegistry（persistentKey 路径的模块级单例所有权）、
//       terminalComposedInputFallback（IME 三段去重）、terminalLinks/terminalTheme 纯函数。
// 边界：本文件存在两条互斥路径——persistentKey（side pane，资源进 registry、卸载只 detach）
//       与默认路径（下侧 terminal，清理即 dispose）。两者语义必须保持对称，
//       任何只改一条的修改都会让另一侧出现无报错的静默回归。
//
// INV 不变量表
// INV-01 断言：resize 必须用 lastSent + pending 双 ref 去重，不能只比较 pending —— 守住它的位置：queueTerminalServiceResize —— 改错故障：ResizeObserver 每帧重复下发，PTY 反复重排导致输出闪烁。
// INV-02 断言：resize 请求必须串行，in-flight 期间新尺寸只能覆盖 pending，不能并发发送 —— 守住它的位置：flushTerminalServiceResize —— 改错故障：旧请求后到达，终端最终停在错误 cols/rows。
// INV-03 断言：PTY id 就绪后必须主动 flush 排队中的 resize —— 守住它的位置：create().then 内的 flushTerminalServiceResize —— 改错故障：同尺寸被去重跳过，PTY 永久停在创建时尺寸。
// INV-04 断言：drag 节流只在 isPanelResizing 为真时生效，final 必须绕过节流 —— 守住它的位置：scheduleFitAndResize —— 改错故障：松手后的最终尺寸被 300ms 延迟吞掉，终端留白或溢出。
// INV-05 断言：fit 必须在可见且宿主尺寸大于 0 时执行，绝不在隐藏容器上 fit —— 守住它的位置：requestFitAndResize 的双守卫 —— 改错故障：clientWidth 为 0 时被 fit 成 1x1 并把错误尺寸同步给 PTY。
// INV-06 断言：isVisibleRef 必须由 effect 同步，RAF/observer 回调只能读 ref —— 守住它的位置：useEffect(isVisible) 首行 —— 改错故障：异步回调读到过期可见性，向隐藏终端 fit 或抢焦点。
// INV-07 断言：requestFocus 必须延后一帧并在回调里二次校验可见性 —— 守住它的位置：requestFocus 的 RAF 回调 —— 改错故障：焦点落到已切走的 tab，键盘输入进入错误终端。
// INV-08 断言：textarea 组合输入兜底只允许在 isWindowsDesktop 时挂载 —— 守住它的位置：textarea 的 isWindowsDesktop 短路 —— 改错故障：Linux Wayland 与 xterm onData 双写，字符重复。
// INV-09 断言：Ctrl/Cmd+V 必须先 preventDefault 再手动读剪贴板 —— 守住它的位置：attachCustomKeyEventHandler 的 v 分支 —— 改错故障：原生 paste 与手动 paste 叠加，粘贴两份。
// INV-10 断言：pending fallback 必须用 40ms 与 150ms 两个不同窗口分别消费，不能合并成单一超时 —— 守住它的位置：consumeTerminalInputFallbackHandledData 的参数 —— 改错故障：普通空格被判定未处理而重复写入。
// INV-11 断言：persistent 路径的 onData / onDynamicData / input 监听必须进 registryDisposers —— 守住它的位置：各订阅注册处 —— 改错故障：detach 后订阅被取消，切回 workspace 只能看不能输入。
// INV-12 断言：persistent 复用分支的 cleanup 只能 detachDom，绝不能 dispose term —— 守住它的位置：复用路径 return 的清理函数 —— 改错故障：scrollback 与 PTY 被销毁，跨 workspace 保活失效。
// INV-13 断言：PTY 未就绪即卸载必须 release 掉占位 entry —— 守住它的位置：cleanup 的 !entry.terminalId 分支 —— 改错故障：重挂命中复用快路径，复用空 PTY，终端永久连不上。
// INV-14 断言：create 失败时必须做 entry 引用比较（ownership 校验）再 release —— 守住它的位置：catch 内 currentEntry === entry —— 改错故障：误删新一代 entry，终端无声消失。
// INV-15 断言：ptyCancelled 只能用于 create 回调，常驻订阅里禁止检查它 —— 守住它的位置：textarea 的 setTimeout 回调 —— 改错故障：detach 后兜底写入永久失效，中文输入丢失。
// INV-16 断言：persistent 路径主题 observer 必须读 entry.profileTheme —— 守住它的位置：themeObserver 回调 —— 改错故障：重挂后组件 ref 为 undefined，用户终端配色回落到默认主题。
// INV-17 断言：profile theme 必须同时写 terminalProfileThemeRef 与 entry.profileTheme —— 守住它的位置：create().then 内 —— 改错故障：复用路径用 undefined 合并主题，自定义颜色丢失。
// INV-18 断言：windowsPty 必须经 normalizeWindowsPtyOption 后再下发，空 buildNumber 不能保留 —— 守住它的位置：两处 term.options.windowsPty 赋值 —— 改错故障：ConPTY 兼容失效，PSReadLine 覆盖上一行输出。
// INV-19 断言：字号必须经 6~72 区间校验、fontFamily 必须回退 DEFAULT —— 守住它的位置：normalizeTerminalFontSize 与 fontFamily 赋值 —— 改错故障：后端返回非法值时 xterm 抛错或渲染错乱。
// INV-20 断言：cleanup 必须先清订阅再 dispose PTY，并清空所有 ref、cancel 所有 RAF —— 守住它的位置：默认路径 return 的清理函数 —— 改错故障：重挂后旧回调写进新 term，或 dispose 后仍收到 data。
// ============================================================================
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { ClipboardPaste, Copy } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { ILink, ILinkHandler, ITheme, IWindowsPty } from "@xterm/xterm";
import type { IServiceAccessor } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  createPendingTerminalInputFallback,
  consumeTerminalInputFallbackHandledData,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
  type PendingTerminalInputFallback,
  type TerminalInputFallbackKeydownCandidate,
  type TerminalInputFallbackHandledData,
} from "@/terminal/terminalComposedInputFallback.js";
import { normalizePowerShellReadlineRedraw } from "@/terminal/terminalDataTransform.js";
import { getHttpLinksForTerminalBufferLine } from "@/terminal/terminalLinks.js";
import { mergeTerminalTheme } from "@/terminal/terminalTheme.js";
import {
  sidePaneTerminalSessionRegistry,
  type SidePaneTerminalSessionEntry,
} from "@/terminal/sidePaneTerminalSessionRegistry.js";

// [权衡] 字体族末尾保留 Nerd Font / MesloLGS 是刻意的：oh-my-zsh 主题依赖这些字形。
// 删掉末尾字体在 Windows 上会掉图标字形，但不会报错，只会显示成方块。
//
// [资源] 下面四个时间常量是一组，改任意一个都会改变 IME 去重与拖拽节流的耦合关系：
// 300ms 是拖拽预览上限，150ms 同时是兜底延迟与近期 data 去重窗口，40ms 是 keydown 到 input 的允许延迟。
// 去重窗口必须不小于兜底延迟，否则 setTimeout 触发时历史已被裁剪；两者同为 150 是对齐结果，不要各自调整。
//
// [边界] 这些值保持字面量常量，不合并成配置对象：日志与排查依赖常量名定位具体窗口。
const DEFAULT_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', monospace";
const TERMINAL_RESIZE_DRAG_THROTTLE_MS = 300;
const TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS = 150;
const TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS = 40;
const TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS = 150;

type TerminalResizeReason = "drag" | "final" | "visible" | "init" | "observer";

type TerminalSize = {
  cols: number;
  rows: number;
};

// [契约] 这里是白名单重建而不是透传：只保留 backend 与 buildNumber 两个键。
// IWindowsPty 未来若新增字段，必须同步补到这里，否则会被静默丢弃（表现为配置了但没生效）。
//
// [失败路径] buildNumber 为 0 或 undefined 时不写该键，而不是写 undefined：
// xterm 用「键是否存在」判定是否启用 ConPTY 兼容分支，显式 undefined 与缺键行为不同。
//
// [边界] 合法性校验（6~72）属于 normalizeTerminalFontSize，不要合并进来：
// 合并会让 windowsPty 的缺键语义被字号分支污染，两处都要改的成本更高。
//
// [并发] 本函数必须保持纯函数，不能在内部读 term.options：两处赋值点都要用同一份归一化结果。
function normalizeWindowsPtyOption(windowsPty: IWindowsPty | undefined): IWindowsPty | undefined {
  if (!windowsPty) return undefined;
  return windowsPty.buildNumber
    ? { backend: windowsPty.backend, buildNumber: windowsPty.buildNumber }
    : { backend: windowsPty.backend };
}

// [契约] 非法字号返回 undefined 而不是抛错：调用方用 if (nextFontSize) 决定是否覆盖。
// 返回 0 会被 falsy 判断吞掉，看似安全，但会把「明确设为 0」与「未设置」混为一谈。
//
// [权衡] 6~72 是经验区间：xterm 在更小字号下 cell 计算会四舍五入到 0 宽，
// 更大字号在 fit 时容易触发布局抖动；放宽上限前先用真实 profile 字体验证 cell 尺寸。
//
// [边界] formatShellLabel 只做展示名归一（去 .exe、小写、PowerShell 特判），
// 不要在这里做路径解析或 shell 能力判断，展示名不参与任何逻辑分支。
function normalizeTerminalFontSize(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 6 || value > 72) {
    return undefined;
  }
  return value;
}

function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null;
  }

  const shellParts = shell.split(/[\\/]/);
  const lastPart = shellParts[shellParts.length - 1];
  const name = lastPart?.replace(/\.exe$/i, "").toLowerCase();
  if (!name) {
    return shell;
  }
  if (name === "powershell" || name === "pwsh") {
    return "PowerShell";
  }
  return name;
}

function isHttpTerminalUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

// [契约] 组件签名即契约：onShellLabelChange 必填、onExit 可选，两者语义不同——
// 有 onExit 表示调用方接管退出（关闭 tab），没有则组件自己写退出提示，不能统一。
//
// [并发] 回调（onExit / onOpenBrowserUrl）通过 ref 转发，不进入 effect 依赖：
// 把它们写进依赖会让父组件每次 render 都重建 xterm 与 PTY，终端被反复重启。
//
// [资源] persistentKey / workspaceKey 只在 side pane 传入；下侧 terminal 不传，
// 走默认路径。新增属性时必须保持「不传就等于旧行为字节级不变」，这是两条路径共存的前提。
//
// [边界] 组件不读 store、不取服务单例，只经 props.services 访问 terminalService。
export function TerminalSession({
  sessionId,
  services,
  cwd,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onShellLabelChange,
  onExit,
  onOpenBrowserUrl,
  persistentKey,
  workspaceKey,
}: {
  sessionId: string;
  services: IServiceAccessor;
  cwd?: string;
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  onExit?: (sessionId: string, exitCode: number) => void;
  onOpenBrowserUrl: (url: string) => void;
  /**
   * 跨组件生命周期的会话复用 key（仅 side pane terminal 用）。
   * 传入后 xterm 实例 + PTY 所有权上移到 sidePaneTerminalSessionRegistry 模块级单例，
   * 组件卸载只 detach DOM、不 dispose；重挂按 key 复用，scrollback 历史跨 workspace 保活。
   * 不传（下侧 terminal）走原 effect 路径，字节级不变。
   */
  persistentKey?: string;
  /**
   * workspace 身份隔离 key（= workspaceIdentity?.trim() || workspacePath）。
   * 仅 persistentKey 路径用：写入 registry entry.workspaceKey，
   * 供 workspace tab 真正关闭时按 workspaceKey 批量回收 PTY（对称下侧 openWorkspaceKeys 回收）。
   * 不传时 fallback 到 cwd。下侧 terminal 不传 persistentKey，此值不生效。
   */
  workspaceKey?: string;
}) {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const isVisibleRef = useRef(isVisible);
  const resizeRAFRef = useRef(0);
  const resizeThrottleTimerRef = useRef<number | null>(null);
  const isPanelResizingRef = useRef(isPanelResizing);
  const resizeRequestStatsRef = useRef({ fit: 0, queued: 0, sent: 0, skipped: 0 });
  const lastSentTerminalSizeRef = useRef<TerminalSize | null>(null);
  const pendingTerminalSizeRef = useRef<TerminalSize | null>(null);
  const resizeInFlightRef = useRef(false);
  const focusRAFRef = useRef(0);
  const exitedMessageRef = useRef("");
  const exitHandlerRef = useRef(onExit);
  const openBrowserUrlRef = useRef(onOpenBrowserUrl);
  const terminalProfileThemeRef = useRef<ITheme | undefined>(undefined);
  const pendingInputFallbacksRef = useRef<PendingTerminalInputFallback[]>([]);
  const inputFallbackKeydownCandidateRef = useRef<TerminalInputFallbackKeydownCandidate | null>(
    null,
  );
  const recentInputFallbackHandledDataRef = useRef<TerminalInputFallbackHandledData[]>([]);

  exitedMessageRef.current = intl.formatMessage({ id: "terminal.exited" });
  exitHandlerRef.current = onExit;
  openBrowserUrlRef.current = onOpenBrowserUrl;

  // [事务] resize 是一次「读 pending → 清 pending → 置 in-flight → 发送」的状态迁移，
  // 四步必须连续完成，中间不能 await：否则第二个调用会看到已被清空的 pending 而漏发尺寸。
  //
  // [并发] in-flight 期间的新尺寸只覆盖 pendingTerminalSizeRef，不立即发送；
  // finally 里检测 pending 再递归 flush，形成串行队列——这是「最后一次尺寸必定生效」的唯一保证。
  //
  // [失败路径] resize 失败只 warn 不重试，也不回滚 lastSentTerminalSizeRef：
  // 回滚会让同一尺寸被再次下发，在 PTY 已死时刷出一串失败日志；保留 lastSent 让去重继续生效。
  //
  // [权衡] stats.sent 在发送前自增、fit/queued/skipped 各自计数，是给日志用的观测面：
  // 删掉任何一个计数不影响功能，但会让「终端尺寸不对」类问题失去唯一的量化证据。
  //
  // [资源] 依赖数组只含 services.terminalService 与 sessionId：把 services 整体放进来会
  // 在 accessor 重建时打断 in-flight 链，导致 pending 永远等不到 finally。
  const flushTerminalServiceResize = useCallback(() => {
    if (resizeInFlightRef.current) {
      return;
    }

    const terminalId = terminalIdRef.current;
    const pendingSize = pendingTerminalSizeRef.current;
    if (!terminalId || !pendingSize) {
      return;
    }

    pendingTerminalSizeRef.current = null;
    resizeInFlightRef.current = true;
    resizeRequestStatsRef.current.sent += 1;

    const startedAt = performance.now();
    void services.terminalService
      .resize({
        id: terminalId,
        cols: pendingSize.cols,
        rows: pendingSize.rows,
      })
      .then(() => {
        logger.debug("[Terminal] resize sent", {
          cols: pendingSize.cols,
          durationMs: Math.round(performance.now() - startedAt),
          fitCount: resizeRequestStatsRef.current.fit,
          queuedCount: resizeRequestStatsRef.current.queued,
          rows: pendingSize.rows,
          sentCount: resizeRequestStatsRef.current.sent,
          skippedCount: resizeRequestStatsRef.current.skipped,
          terminalId,
          terminalTabId: sessionId,
        });
      })
      // [失败路径] create 失败必须释放现占位 entry，否则空 terminalId 的僵尸 entry 会留在 registry，
      // 重挂命中复用快路径，复用已启动失败的 xterm 且永不重新 create，终端永久不可用。
      //
      // [并发] release 前必须做 entry 引用比较：create reject 前组件可能已卸载并重挂，
      // registry 已被新一代 entry 覆盖，无脑 release 会误删新的终端。
      //
      // [事务] 引用比较而不是 key 比较：每次创建都是新对象，引用天然区分代际。
      //
      // [资源] 这里不 dispose term 与订阅：那是 cleanup 的职责，重复释放会让 disposer 抛错。
      // [边界] 错误文本直接写进 term 供用户看到，不要只打日志——否则界面表现为空白终端。
      .catch((error) => {
        logger.warn("[Terminal] resize failed:", error);
      })
      .finally(() => {
        resizeInFlightRef.current = false;
        if (pendingTerminalSizeRef.current) {
          flushTerminalServiceResize();
        }
      });
  }, [services.terminalService, sessionId]);

  const queueTerminalServiceResize = useCallback(
    (size: TerminalSize) => {
      const lastSentSize = lastSentTerminalSizeRef.current;
      const pendingSize = pendingTerminalSizeRef.current;
      if (
        (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows && !pendingSize) ||
        (pendingSize?.cols === size.cols && pendingSize.rows === size.rows)
      ) {
        resizeRequestStatsRef.current.skipped += 1;
        return;
      }

      pendingTerminalSizeRef.current = size;
      lastSentTerminalSizeRef.current = size;
      resizeRequestStatsRef.current.queued += 1;
      flushTerminalServiceResize();
    },
    [flushTerminalServiceResize],
  );

  const clearResizeThrottleTimer = useCallback(() => {
    if (resizeThrottleTimerRef.current) {
      window.clearTimeout(resizeThrottleTimerRef.current);
      resizeThrottleTimerRef.current = null;
    }
  }, []);

  const requestFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (resizeRAFRef.current) {
        cancelAnimationFrame(resizeRAFRef.current);
      }

      resizeRAFRef.current = requestAnimationFrame(() => {
        resizeRAFRef.current = 0;
        const el = containerRef.current;
        const term = termRef.current;
        const fitAddon = fitAddonRef.current;
        if (
          !isVisibleRef.current ||
          !el ||
          !term ||
          !fitAddon ||
          el.clientWidth <= 0 ||
          el.clientHeight <= 0
        ) {
          return;
        }

        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] fit failed:", error);
          return;
        }

        logger.debug("[Terminal] fit requested resize", {
          cols: term.cols,
          reason,
          resizing: isPanelResizingRef.current,
          rows: term.rows,
          terminalId: terminalIdRef.current,
          terminalTabId: sessionId,
        });
        queueTerminalServiceResize({ cols: term.cols, rows: term.rows });
      });
    },
    [queueTerminalServiceResize, sessionId],
  );

  // [并发] 非拖拽（或 final）走「清节流 → 立即 fit」，拖拽中走「首次排定 → 300ms 后单次 fit」。
  // 这里的 !isPanelResizingRef.current 判断必须在前：顺序反了会让 final 也被节流吞掉。
  //
  // [失败路径] 节流定时器只排一次（已存在则直接 return），不做 trailing 重置：
  // 每次事件都重置会让连续拖拽期间永远不 fit，松手后只看到最后一帧。
  //
  // [资源] requestFitAndResize 内部先 cancel 上一帧 RAF 再排新帧，保证每帧最多一次 fit：
  // 去掉 cancel 会让同一帧内多个 observer 回调各 fit 一次，xterm 布局抖动。
  //
  // [契约] reason 只用于日志，不参与分支（除 final）：不要按 reason 做可见性过滤，
  // 可见性判断统一在 RAF 回调里读 isVisibleRef，两处判断会漂移。
  // [权衡] RAF 句柄在回调首行清零，是为了让 cleanup 能区分「已执行的帧」与「待执行的帧」。
  const scheduleFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (!isPanelResizingRef.current || reason === "final") {
        clearResizeThrottleTimer();
        requestFitAndResize(reason);
        return;
      }

      if (resizeThrottleTimerRef.current) {
        return;
      }

      // 拖动终端高度时 ResizeObserver 会按布局帧连续触发。
      // xterm fit + PTY resize 是同步布局和跨进程请求组合，拖拽中只按常量低频预览，松手后再 flush 最终尺寸。
      resizeThrottleTimerRef.current = window.setTimeout(() => {
        resizeThrottleTimerRef.current = null;
        requestFitAndResize("drag");
      }, TERMINAL_RESIZE_DRAG_THROTTLE_MS);
    },
    [clearResizeThrottleTimer, requestFitAndResize],
  );

  // [并发] 未聚焦的 tab 仍然挂载，所以 focus 必须延后一帧并在回调里再次校验可见性：
  // 调用瞬间的可见性与下一帧可能不同（tab 切换、侧栏收起都在同一个 task 里发生）。
  //
  // [资源] 复用 focusRAFRef 做「只保留最后一帧」：不 cancel 会让多次切换累积多次 focus，
  // 最后一次执行时可能已经切到别的 session，焦点被抢回旧终端。
  //
  // [失败路径] term 可能已被 dispose（快速卸载），termRef 为 null 时静默返回；
  // 这里不能 throw，也不能 fallback 到 containerRef.focus()，否则会把焦点给到不可交互的 div。
  const requestFocus = useCallback(() => {
    if (focusRAFRef.current) {
      cancelAnimationFrame(focusRAFRef.current);
    }

    focusRAFRef.current = requestAnimationFrame(() => {
      focusRAFRef.current = 0;
      const term = termRef.current;
      if (!isVisibleRef.current || !term) {
        return;
      }

      // 打开/新建/切换终端时 React 只更新了可见 tab，焦点仍停在按钮或输入框。
      // xterm 的 textarea 会在 open 后创建，所以要等下一帧确认当前 session 仍可见再聚焦。
      term.focus();
      logger.debug("[Terminal] focused visible terminal", {
        terminalId: terminalIdRef.current,
        terminalTabId: sessionId,
      });
    });
  }, [sessionId]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible) {
      scheduleFitAndResize("visible");
      requestFocus();
    }
  }, [isVisible, requestFocus, scheduleFitAndResize]);

  useEffect(() => {
    const wasResizing = isPanelResizingRef.current;
    isPanelResizingRef.current = isPanelResizing;
    if (wasResizing && !isPanelResizing && isVisibleRef.current) {
      scheduleFitAndResize("final");
    }
  }, [isPanelResizing, scheduleFitAndResize]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // ===== persistentKey 路径：side pane terminal 跨 workspace 会话保活 =====
    // xterm 实例 + PTY 所有权上移到 sidePaneTerminalSessionRegistry 模块级单例，
    // 组件卸载只 detach DOM、不 dispose；重挂按 persistentKey 复用，scrollback 跨 workspace 保活。
    // 原路径（下侧 terminal，不传 persistentKey）字节级不变。
    // [契约] 两条路径互斥：persistentKey 存在时整个默认路径的代码都不执行，反之亦然。
    // 不要在其中一条里复用另一条的局部变量（term / fitAddon），它们的所有权模型不同。
    //
    // [资源] persistent 路径的所有权在 sidePaneTerminalSessionRegistry：term、fitAddon、hostEl、
    // PTY 订阅和 input 监听都随 entry 常驻，组件卸载只 detachDom；默认路径则全部由本 effect 持有并 dispose。
    //
    // [事务] entry 先以空 terminalId 占位注册，再异步 create，最后回填：
    // 顺序不能反——先 create 再 register 会让「创建期间卸载」没有可 release 的对象。
    //
    // [失败路径] 复用快路径（existingEntry 非空）必须直接 return 自己的清理函数，
    // 不能落到下面的首次创建分支：两条分支共享 effect 但清理语义完全不同。
    // [边界] 两条路径的 customKeyEventHandler 与 onData 逻辑是镜像复制，改动必须成对进行。
    if (persistentKey) {
      terminalProfileThemeRef.current = undefined;
      const existingEntry = sidePaneTerminalSessionRegistry.get(persistentKey);

      // --- 复用快路径：切回 workspace / 重挂，entry 已在 registry ---
      if (existingEntry) {
        termRef.current = existingEntry.term;
        fitAddonRef.current = existingEntry.fitAddon;
        terminalIdRef.current = existingEntry.terminalId || undefined;
        el.appendChild(existingEntry.hostEl);
        const reuseThemeObserver = new MutationObserver(() => {
          // 从 entry.profileTheme 读：重挂后组件局部 ref 已重置为 undefined，
          // profile theme 只存在于 registry entry，必须从 entry 取（否则丢用户配置的终端颜色）。
          existingEntry.term.options.theme = mergeTerminalTheme(existingEntry.profileTheme);
        });
        reuseThemeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });
        let reuseResizeRAF = 0;
        const reuseResizeObserver = new ResizeObserver(() => {
          if (!isVisibleRef.current) return;
          if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
          reuseResizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
        });
        reuseResizeObserver.observe(el);
        try {
          resizeRequestStatsRef.current.fit += 1;
          existingEntry.fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] persistent reuse fit failed:", error);
        }
        if (isVisibleRef.current) {
          requestFocus();
        }
        logger.debug("[Terminal] persistent reuse", {
          terminalTabId: sessionId,
          persistentKey,
        });
        return () => {
          reuseThemeObserver.disconnect();
          reuseResizeObserver.disconnect();
          if (reuseResizeRAF) cancelAnimationFrame(reuseResizeRAF);
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
          // 不 dispose：term/PTY/订阅都留在 registry 供下次复用
          termRef.current = null;
          fitAddonRef.current = null;
        };
      }

      // --- 首次创建：常驻 hostEl，term open 到 hostEl，资源进 registry ---
      const hostEl = document.createElement("div");
      hostEl.className = "terminal-xterm-shell h-full min-h-0 w-full overflow-hidden";
      el.appendChild(hostEl);

      let ptyCancelled = false;
      const registryDisposers: IDisposable[] = [];
      const localDisposers: IDisposable[] = [];

      // [契约] 这里只为 persistent 路径创建 XTerm；默认路径在下方另建一份，两处 options 必须保持一致。
      // fontSize 13 与 DEFAULT_TERMINAL_FONT_FAMILY 是初始值，profile 下发后会覆盖，不要在此处读配置。
      //
      // [资源] hostEl 是常驻 DOM 容器，追加到组件 el 后即使卸载也不销毁（随 entry 走），
      // 这样重挂时 appendChild 能带回 scrollback；不要改成 term.open(el) 直接挂载。
      //
      // [并发] 同步 fit 必须在 create 之前完成：用 xterm 默认 80x24 建 PTY 会让启动输出
      // 在随后 resize 时按错误宽度重排，zsh 会显示反白的 PROMPT_EOL_MARK。
      //
      // [失败路径] 初始 fit 失败只 warn，initialTerminalSize 保持 null，后续用 term.cols/rows 兜底；
      // 不要在这里 return，否则 PTY 永远不会创建。
      // [权衡] linkHandler 里 allowNonHttpProtocols 为 false 是安全边界，放开会允许 file: 与 javascript: 链接。
      const term = new XTerm({
        fontSize: 13,
        fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
        theme: mergeTerminalTheme(terminalProfileThemeRef.current),
        linkHandler: {
          allowNonHttpProtocols: false,
          activate(event, text) {
            if (!isHttpTerminalUrl(text)) return;
            event.preventDefault();
            logger.debug("[Terminal] open OSC 8 http link", { url: text });
            openBrowserUrlRef.current(text);
          },
        } satisfies ILinkHandler,
      });
      termRef.current = term;

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(new ClipboardAddon());
      term.open(hostEl);

      let initialTerminalSize: TerminalSize | null = null;
      if (isVisibleRef.current && hostEl.clientWidth > 0 && hostEl.clientHeight > 0) {
        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
          initialTerminalSize = { cols: term.cols, rows: term.rows };
          lastSentTerminalSizeRef.current = initialTerminalSize;
          logger.debug("[Terminal] initial fit before create (persistent)", {
            cols: initialTerminalSize.cols,
            rows: initialTerminalSize.rows,
            terminalTabId: sessionId,
          });
        } catch (error) {
          logger.warn("[Terminal] persistent initial fit failed:", error);
        }
      }
      if (isVisibleRef.current) {
        requestFocus();
      }

      // 组件局部：customKeyEventHandler（依赖组件 inputFallback ref）
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        inputFallbackKeydownCandidateRef.current =
          e.metaKey || e.ctrlKey || e.altKey
            ? null
            : createTerminalInputFallbackKeydownCandidate({
                eventTimeStamp: e.timeStamp,
                key: e.key,
                now: performance.now(),
              });
        if (!(e.metaKey || e.ctrlKey)) return true;
        const key = e.key.toLowerCase();
        if (key === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
            logger.warn("[Terminal] copy via shortcut failed:", err);
          });
          return false;
        }
        if (key === "v") {
          // attachCustomKeyEventHandler 返回 false 只阻止 xterm 处理 Ctrl+V，
          // 不会取消浏览器随后派发的原生 paste 事件；这里手动 paste 一次后，
          // 原生 paste 又会被 xterm 的内置监听写入一次，导致快捷键粘贴重复。
          // 因此必须先取消默认事件，再保留手动读取剪贴板的单次写入。
          // 与原路径（下侧 terminal）字节对齐：两份拷贝曾在此漂移（persistentKey 漏了 debug 日志），
          // 待后续重构收敛为单一 wireTerminalProcessing 后此注释删除。
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard
            .readText()
            .then((text) => {
              logger.debug("[Terminal] paste via shortcut", { length: text.length });
              if (text) term.paste(text);
            })
            .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
          return false;
        }
        return true;
      });

      // 组件局部：主题 observer
      const themeObserver = new MutationObserver(() => {
        // 从 entry.profileTheme 读：profile theme 所有权在 registry entry，跨重挂常驻；
        // 组件局部 terminalProfileThemeRef 在重挂后会丢失 profile theme，不能作为 observer 数据源。
        term.options.theme = mergeTerminalTheme(entry.profileTheme);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      localDisposers.push({ dispose: () => themeObserver.disconnect() } as IDisposable);

      // 进 registry：linkProvider（detached 时保留无害）
      registryDisposers.push(
        term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const links = getHttpLinksForTerminalBufferLine(
              term.buffer.active,
              bufferLineNumber,
              term.cols,
            )?.map(
              (link): ILink => ({
                ...link,
                activate(event, text) {
                  event.preventDefault();
                  logger.debug("[Terminal] open plain http link", { url: text });
                  openBrowserUrlRef.current(text);
                },
              }),
            );
            callback(links);
          },
        }),
      );

      // entry 先占位存入 registry（terminalId 异步填），重挂/回收据此判断
      const entry: SidePaneTerminalSessionEntry = {
        key: persistentKey,
        term,
        fitAddon,
        terminalId: "",
        cwd: cwd ?? "",
        // workspaceKey 用于 workspace tab 真正关闭时按 workspace 批量回收（对称下侧 openWorkspaceKeys）。
        workspaceKey: workspaceKey ?? cwd ?? "",
        hostEl,
        dispose: () => {}, // 紧接着补全
      };
      // [事务] dispose 的顺序是固定的：先置 ptyCancelled（阻断 create 回调），再释放订阅，
      // 再 dispose PTY，最后 dispose term。调换任意两步都会出现「回调写进已销毁 term」的窗口。
      //
      // [失败路径] 每个 disposer 单独 try/catch：任一 addon 的 dispose 抛错不能阻断后续释放，
      // 否则 registry 会留下半销毁 entry，重挂时复用这个残骸。
      //
      // [资源] ptyCancelled 是闭包变量，只对本次创建有效；复用路径不会重新执行它，
      // 所以常驻订阅里禁止检查 ptyCancelled（见 INV-15）。
      //
      // [契约] dispose 只由 registry.release 调用，组件 cleanup 不直接调用：所有权单一入口。
      entry.dispose = () => {
        ptyCancelled = true;
        for (const d of registryDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent dispose disposer failed:", error);
          }
        }
        if (entry.terminalId) {
          void services.terminalService.dispose({ id: entry.terminalId });
        }
        try {
          term.dispose();
        } catch (error) {
          logger.warn("[Terminal] persistent term.dispose failed:", error);
        }
      };
      sidePaneTerminalSessionRegistry.register(persistentKey, entry);

      // 创建 PTY（异步）
      // [并发] id 就绪前后都可能发生 resize：就绪前尺寸进 pending，就绪后立即 flush，
      // 否则 scheduleFitAndResize 的 init 会因同尺寸去重而跳过，PTY 停在创建尺寸。
      //
      // [事务] 回填 terminalId 必须早于 flush：flush 里读 terminalIdRef，顺序反了会因无 id 直接返回。
      //
      // [资源] profile theme 要同时写组件 ref 与 entry.profileTheme：ref 供本次渲染，
      // entry 供跨组件生命周期复用；只写 ref 会在重挂后丢配色（INV-16/17）。
      //
      // [契约] fontFamily 回退 DEFAULT、fontSize 走 normalize：后端可能返回空串或非法字号，
      // 直接赋值会让 xterm 抛错或 cell 尺寸为 0。
      //
      // [失败路径] ptyCancelled 检查必须在最前面，且 return 前要 dispose 这个孤儿 PTY，不能只 return。
      const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
      void services.terminalService
        .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
        .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
          if (ptyCancelled) {
            // cleanup 已发生：杀掉这个孤儿 PTY，不进 entry
            void services.terminalService.dispose({ id });
            return;
          }
          entry.terminalId = id;
          terminalIdRef.current = id;
          // 与原路径对称：id ready 后立即 flush 创建期间排队的 resize（pendingTerminalSizeRef）。
          // 否则 scheduleFitAndResize("init") 会因 pendingSize 去重跳过，PTY 停在错误 cols/rows。
          flushTerminalServiceResize();
          term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
          term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
          const nextFontSize = normalizeTerminalFontSize(fontSize);
          if (nextFontSize) {
            term.options.fontSize = nextFontSize;
          }
          terminalProfileThemeRef.current = theme as ITheme | undefined;
          // profile theme 所有权上移到 registry entry，
          // 跨组件生命周期复用不丢（原仅写组件局部 ref，重挂后新组件 ref=undefined → 复用 observer 用 undefined 合并 → 丢失）。
          entry.profileTheme = theme as ITheme | undefined;
          term.options.theme = mergeTerminalTheme(entry.profileTheme);
          const nextShellLabel = formatShellLabel(shell);
          logger.info("[Terminal] shell resolved (persistent):", {
            cwd,
            fontFamilySource,
            shell,
            shellLabel: nextShellLabel,
            terminalId: id,
            terminalTabId: sessionId,
          });
          onShellLabelChange(sessionId, nextShellLabel);
          scheduleFitAndResize("init");
          if (isVisibleRef.current) {
            requestFocus();
          }

          // data 订阅 → term.write（进 registry，detached 时仍累积 scrollback）
          registryDisposers.push(
            services.terminalService.onDynamicData(id)((data) => {
              term.write(normalizePowerShellReadlineRedraw(data, shell));
            }),
          );
          // exit 订阅（进 registry，与原路径对称：有 onExit 则回调，否则写退出提示）
          registryDisposers.push(
            services.terminalService.onDynamicExit(id)((exitCode) => {
              const exitHandler = exitHandlerRef.current;
              logger.info("[Terminal] persistent session exited", {
                autoClose: Boolean(exitHandler),
                exitCode,
                terminalId: id,
                terminalTabId: sessionId,
              });
              if (exitHandler) {
                exitHandler(sessionId, exitCode);
                return;
              }
              // side pane Terminal 不传 onExit，保留退出提示。
              term.write(`\r\n${exitedMessageRef.current}\r\n`);
            }),
          );

          // onData（进 registry，随 term 常驻）：
          // 不能放 localDisposers：cleanup(detach) 时会被取消，而复用路径不重绑，
          // 导致切回 workspace 后 scrollback 在但无法输入交互。
          // 输入订阅生命周期必须 = entry 生命周期（随 term 常驻），detach 不取消。
          //
          // 与原路径（下侧 terminal）的 onData 完全一致：维护 keydown candidate 去重历史，
          // 供 Windows 输入法 textarea 兜底消费（IME composition committed text 的三段去重闭环）。
          // 注：本段只处理「已提交 composition 文本」的去重，与 Shift 切换输入法动作无关——
          // Shift 切换是输入法系统级行为（customKeyEventHandler 对 Shift 直接 return true 放行）；
          // 「Shift 切英文后字符丢失」的真根因是 isWindowsDesktop 未透传（已在 WorkspaceShellLayout 修复）。
          registryDisposers.push(
            // [契约] 这里的 onData 必须进 registryDisposers，不能进 localDisposers：
            // detach 时 localDisposers 会被释放，而复用路径不重绑，会导致切回后能看不能输入。
            //
            // [并发] 三段去重是一个闭环：keydown 记 candidate → onData 消费并落历史 →
            // textarea input 再用 40ms/150ms 窗口消费同一次输入。任何一段单独删除都会重复写字符。
            //
            // [事务] usedCandidate 为真时必须清空 candidate，否则同一 keydown 会被下一次输入再次认领。
            //
            // [权衡] 历史只在命中时替换、未命中时追加，maxAgeMs 由 record 函数裁剪；
            // 不要在这里手写裁剪逻辑，两处裁剪口径不同会漏掉边界样本。
            //
            // [边界] 写入失败（PTY 已 dispose）由 service 侧吞掉，这里不做 try/catch，避免掩盖真实错误。
            term.onData((data) => {
              const now = performance.now();
              const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
              const handledData = recordTerminalInputFallbackHandledData({
                candidate: inputFallbackKeydownCandidate,
                data,
                history: recentInputFallbackHandledDataRef.current,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                now,
              });
              recentInputFallbackHandledDataRef.current = handledData.usedCandidate
                ? handledData.history
                : recordTerminalInputFallbackRecentData({
                    data,
                    history: handledData.history,
                    maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                    now,
                  });
              if (handledData.usedCandidate) {
                inputFallbackKeydownCandidateRef.current = null;
              }
              markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
              void services.terminalService.write({ id, data });
            }),
          );

          // Windows 输入法兜底（进 registry，随 term 常驻，与 onData 同生命周期）。
          // textarea 元素随 term 实例常驻，监听绑一次即可；detach 不取消，重挂后中文输入法兜底仍生效。
          const textarea =
            isWindowsDesktop &&
            (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
          if (textarea) {
            const handleInput = (e: InputEvent) => {
              if (e.inputType !== "insertText" || !e.data || !e.composed) return;
              const insertedText = e.data;
              const now = performance.now();
              const pendingFallback = createPendingTerminalInputFallback(insertedText);
              pendingInputFallbacksRef.current.push(pendingFallback);
              consumeTerminalInputFallbackHandledData({
                history: recentInputFallbackHandledDataRef.current,
                inputEventTimeStamp: e.timeStamp,
                maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
                now,
                pending: pendingFallback,
              });
              setTimeout(() => {
                pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
                  (item) => item !== pendingFallback,
                );
                // 不检查 ptyCancelled：订阅已随 entry 常驻（registryDisposers），
                // ptyCancelled 是单次 effect 闭包变量，detach 后会变 true 导致 fallback 永久失效。
                // release 时 entry.dispose 会移除本监听；PTY disposed 后 write 为 no-op，安全。
                const fallbackAction = resolveTerminalInputFallbackAction({
                  pending: pendingFallback,
                  textareaValue: textarea.value,
                });
                if (fallbackAction.shouldWrite) {
                  logger.debug("[Terminal] flush composed input fallback (persistent)", {
                    length: insertedText.length,
                    terminalId: id,
                    terminalTabId: sessionId,
                  });
                  void services.terminalService.write({ id, data: insertedText });
                }
                if (fallbackAction.shouldClearTextarea) {
                  textarea.value = "";
                }
              }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
            };
            textarea.addEventListener("input", handleInput, true);
            registryDisposers.push({
              dispose: () => textarea.removeEventListener("input", handleInput, true),
            } as IDisposable);
          }
        })
        .catch((error) => {
          if (ptyCancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          logger.error("[Terminal] persistent create failed:", error);
          term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
          // PTY 创建失败必须释放 registry 中本次占位的 entry。
          // entry 在上方以 terminalId="" 占位先 register（line 541），再异步 terminalService.create()。
          // 若失败不释放，terminalId="" 的僵尸 entry 会留在 registry，重挂/切 workspace 时命中
          // 复用快路径（见上方 existingEntry 分支），直接复用已启动失败的 xterm，且永不重新
          // terminalService.create()，该终端永久无法连接 PTY。
          //
          // ownership 校验（稳妥方案）：只有 registry 当前 entry 仍是本次创建的 entry 时才释放。
          // 极端时序：create reject 触发前，组件可能已卸载（cleanup 已 release 半成品，见下方 !entry.terminalId
          // 分支）并重挂、registry 已被新一次创建的 entry 覆盖。此时无脑 release 会误删新 entry。
          // 闭包 entry 引用比较 registry 当前值：每次创建都是新 entry 对象，引用比较天然区分代际。
          const currentEntry = sidePaneTerminalSessionRegistry.get(persistentKey);
          if (currentEntry === entry) {
            sidePaneTerminalSessionRegistry.release(persistentKey);
          }
        });

      // 组件局部：resize observer
      let resizeRAF = 0;
      const resizeObserver = new ResizeObserver(() => {
        if (!isVisibleRef.current) return;
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
      });
      resizeObserver.observe(el);

      logger.debug("[Terminal] persistent create", {
        terminalTabId: sessionId,
        persistentKey,
      });

      return () => {
        ptyCancelled = true;
        themeObserver.disconnect();
        resizeObserver.disconnect();
        if (resizeRAF) cancelAnimationFrame(resizeRAF);
        for (const d of localDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent cleanup local disposer failed:", error);
          }
        }
        // PTY 未就绪即被卸载（极少见）：回收半成品 entry，避免重挂复用到空 PTY
        if (!entry.terminalId) {
          sidePaneTerminalSessionRegistry.release(persistentKey);
        } else {
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
        }
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }
    // ===== persistentKey 路径结束 =====

    // [契约] 以下全部是默认路径（下侧 terminal）：与 persistent 路径是镜像实现，
    // 修改任何一处都要同步另一处，否则 side pane 与底部终端行为分叉。
    //
    // [资源] 默认路径的 term 直接 open(el)，卸载即 dispose；不要为了「保活」把这里也接 registry。
    //
    // [并发] disposed 是本次 effect 的闭包标记，异步 create 回调与 setTimeout 都要先查它；
    // persistent 路径的对应物是 ptyCancelled，但后者不覆盖常驻订阅，两者语义不同。
    //
    // [事务] cleanup 顺序：标记 disposed → 断 observer → 清 RAF 与定时器 → 清 ref → 释放订阅 → dispose PTY → dispose term。
    // [失败路径] 顺序本身是失败隔离：disposer 抛错也不能阻断后续释放，否则资源泄漏。
    let disposed = false;
    terminalProfileThemeRef.current = undefined;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      theme: mergeTerminalTheme(terminalProfileThemeRef.current),
      linkHandler: {
        allowNonHttpProtocols: false,
        activate(event, text) {
          if (!isHttpTerminalUrl(text)) {
            return;
          }
          event.preventDefault();
          logger.debug("[Terminal] open OSC 8 http link", { url: text });
          openBrowserUrlRef.current(text);
        },
      } satisfies ILinkHandler,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    // 接入 ClipboardAddon 以支持 OSC 52，并让 xterm 的 copy 事件把选区写入系统剪贴板。
    term.loadAddon(new ClipboardAddon());
    term.open(el);
    let initialTerminalSize: TerminalSize | null = null;
    if (isVisibleRef.current && el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        // side pane 终端挂载时如果先用 xterm 默认列数创建 PTY，
        // 启动输出会在随后 fit/resize 时按错误宽度重排，zsh 可能显示反白的 PROMPT_EOL_MARK。
        // 首次可见时先同步 fit，再用真实 cols/rows 启动 PTY，避免启动输出和尺寸校正竞态。
        resizeRequestStatsRef.current.fit += 1;
        fitAddon.fit();
        initialTerminalSize = { cols: term.cols, rows: term.rows };
        lastSentTerminalSizeRef.current = initialTerminalSize;
        logger.debug("[Terminal] initial fit before create", {
          cols: initialTerminalSize.cols,
          rows: initialTerminalSize.rows,
          terminalTabId: sessionId,
        });
      } catch (error) {
        logger.warn("[Terminal] initial fit failed:", error);
      }
    }
    if (isVisibleRef.current) {
      requestFocus();
    }

    // 拦截 Ctrl/Cmd+C、Ctrl/Cmd+V：
    // - Ctrl+C 在 Win/Linux 默认会被当作 SIGINT 传给 PTY，必须在有选区时改走复制；
    // - Ctrl+V 不拦截会被当作 `^V` 字符输入。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      inputFallbackKeydownCandidateRef.current =
        e.metaKey || e.ctrlKey || e.altKey
          ? null
          : createTerminalInputFallbackKeydownCandidate({
              eventTimeStamp: e.timeStamp,
              key: e.key,
              now: performance.now(),
            });
      if (!(e.metaKey || e.ctrlKey)) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
          logger.warn("[Terminal] copy via shortcut failed:", err);
        });
        return false;
      }
      if (key === "v") {
        // attachCustomKeyEventHandler 返回 false 只阻止 xterm 处理 Ctrl+V，
        // 不会取消浏览器随后派发的原生 paste 事件；这里手动 paste 一次后，
        // 原生 paste 又会被 xterm 的内置监听写入一次，导致快捷键粘贴重复。
        // 因此必须先取消默认事件，再保留手动读取剪贴板的单次写入。
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard
          .readText()
          .then((text) => {
            logger.debug("[Terminal] paste via shortcut", { length: text.length });
            if (text) term.paste(text);
          })
          .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
        return false;
      }
      return true;
    });

    // 监听主题切换，实时更新 terminal 配色
    const observer = new MutationObserver(() => {
      term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const disposables: IDisposable[] = [];
    const { terminalService } = services;
    disposables.push(
      // 交互说明：plain URL 不属于 React DOM，必须通过 xterm link provider 从 buffer
      // 计算可点击区域，再统一交给右侧 browser pane，避免在终端层直接碰平台 API。
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const links = getHttpLinksForTerminalBufferLine(
            term.buffer.active,
            bufferLineNumber,
            term.cols,
          )?.map(
            (link): ILink => ({
              ...link,
              activate(event, text) {
                event.preventDefault();
                logger.debug("[Terminal] open plain http link", { url: text });
                openBrowserUrlRef.current(text);
              },
            }),
          );

          callback(links);
        },
      }),
    );

    // 优先使用 workspace 路径作为 terminal 工作目录，未设置时后端回退到 HOME
    const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
    terminalService
      .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
      .then(({ id, shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty }) => {
        if (disposed) {
          terminalService.dispose({ id });
          return;
        }

        terminalIdRef.current = id;
        // 首次 fit 或 ResizeObserver 可能早于 terminal id ready，先把 resize
        // 暂存在 pendingTerminalSizeRef；id ready 后必须主动 flush，否则相同尺寸会被去重逻辑跳过。
        flushTerminalServiceResize();
        // Windows ConPTY 在 resize 增高时不会像传统 Unix PTY 一样把 scrollback 拉回 viewport，
        // 不开启 xterm 的 windowsPty 兼容会让 PSReadLine 后续按旧坐标重绘输入，覆盖到上一条命令输出行。
        term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
        term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
        const nextFontSize = normalizeTerminalFontSize(fontSize);
        if (nextFontSize) {
          term.options.fontSize = nextFontSize;
        }
        terminalProfileThemeRef.current = theme as ITheme | undefined;
        term.options.theme = mergeTerminalTheme(terminalProfileThemeRef.current);
        const nextShellLabel = formatShellLabel(shell);
        logger.info("[Terminal] shell resolved:", {
          cwd,
          fontFamilySource,
          shell,
          shellLabel: nextShellLabel,
          terminalId: id,
          terminalTabId: sessionId,
        });
        onShellLabelChange(sessionId, nextShellLabel);
        scheduleFitAndResize("init");
        if (isVisibleRef.current) {
          requestFocus();
        }

        disposables.push(
          terminalService.onDynamicData(id)((data) => {
            term.write(normalizePowerShellReadlineRedraw(data, shell));
          }),
        );

        disposables.push(
          terminalService.onDynamicExit(id)((exitCode) => {
            const exitHandler = exitHandlerRef.current;
            logger.info("[Terminal] terminal session exited", {
              autoClose: Boolean(exitHandler),
              exitCode,
              terminalId: id,
              terminalTabId: sessionId,
            });
            if (exitHandler) {
              exitHandler(sessionId, exitCode);
              return;
            }

            // side pane Terminal 不属于底部 tab registry，未传 onExit 时继续保留退出提示。
            term.write(`\r\n${exitedMessageRef.current}\r\n`);
          }),
        );

        disposables.push(
          term.onData((data) => {
            const now = performance.now();
            const inputFallbackKeydownCandidate = inputFallbackKeydownCandidateRef.current;
            const handledData = recordTerminalInputFallbackHandledData({
              candidate: inputFallbackKeydownCandidate,
              data,
              history: recentInputFallbackHandledDataRef.current,
              maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
              now,
            });
            recentInputFallbackHandledDataRef.current = handledData.usedCandidate
              ? handledData.history
              : recordTerminalInputFallbackRecentData({
                  data,
                  history: handledData.history,
                  maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
                  now,
                });
            if (handledData.usedCandidate) {
              inputFallbackKeydownCandidateRef.current = null;
            }
            markTerminalInputFallbackHandled(pendingInputFallbacksRef.current, data);
            terminalService.write({ id, data });
          }),
        );

        // Windows desktop 下某些输入法会把 composed text 留在 textarea 里，
        // xterm 可能只处理到一半；这里保留兜底。但 Linux Wayland 已确认会和 xterm 的
        // onData 路径重复写入，所以必须显式收窄到 Windows，避免把正常链路误伤。
        const textarea =
          isWindowsDesktop &&
          (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
        if (textarea) {
          const handleInput = (e: InputEvent) => {
            // 只处理组合文本的 insertText
            if (e.inputType !== "insertText" || !e.data || !e.composed) return;
            const insertedText = e.data;
            const now = performance.now();
            const pendingFallback = createPendingTerminalInputFallback(insertedText);
            pendingInputFallbacksRef.current.push(pendingFallback);
            // 普通空格会先经 keydown 被 xterm onData 写入 PTY，随后浏览器才派发 composed input。
            // 搜狗输入法也会在没有稳定 keydown candidate 的情况下先触发 xterm onData、后触发 composed input。
            // 这里消费同一次输入附近的未消费 onData，避免把同一段组合文本再兜底写入一次。
            consumeTerminalInputFallbackHandledData({
              history: recentInputFallbackHandledDataRef.current,
              inputEventTimeStamp: e.timeStamp,
              maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
              maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
              now,
              pending: pendingFallback,
            });

            // 延迟检查：等 xterm 的 onData 先认领 pending，再判断是否需要兜底写入。
            setTimeout(() => {
              pendingInputFallbacksRef.current = pendingInputFallbacksRef.current.filter(
                (item) => item !== pendingFallback,
              );
              if (disposed) {
                return;
              }
              const fallbackAction = resolveTerminalInputFallbackAction({
                pending: pendingFallback,
                textareaValue: textarea.value,
              });
              if (fallbackAction.shouldWrite) {
                // 普通空格也会触发 composed input，且 xterm 已经通过 onData 写入 PTY。
                // 只看 textarea.value 会把空格再手动写一次；这里必须确认 onData 没处理过才兜底。
                logger.debug("[Terminal] flush composed input fallback", {
                  length: insertedText.length,
                  terminalId: id,
                  terminalTabId: sessionId,
                });
                terminalService.write({ id, data: insertedText });
              }
              if (fallbackAction.shouldClearTextarea) {
                textarea.value = "";
              }
            }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
          };

          textarea.addEventListener("input", handleInput, true);
          disposables.push({
            dispose: () => textarea.removeEventListener("input", handleInput, true),
          } as IDisposable);
        }
      })
      .catch((error) => {
        // 之前没有接住 create() 的拒绝态，终端启动失败会直接变成 Uncaught Promise。
        // 这里显式记录错误，并在终端区域提示用户，方便定位到底是 shell 还是 cwd 出了问题。
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Terminal] failed to create terminal:", error);
        term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
      });

    let resizeRAF = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      resizeRAF = requestAnimationFrame(() => scheduleFitAndResize("observer"));
    });
    resizeObserver.observe(el);

    return () => {
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      clearResizeThrottleTimer();
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
      if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
      if (focusRAFRef.current) cancelAnimationFrame(focusRAFRef.current);
      pendingInputFallbacksRef.current = [];
      inputFallbackKeydownCandidateRef.current = null;
      recentInputFallbackHandledDataRef.current = [];
      pendingTerminalSizeRef.current = null;
      lastSentTerminalSizeRef.current = null;
      resizeInFlightRef.current = false;
      for (const d of disposables) d.dispose();
      if (terminalIdRef.current) {
        terminalService.dispose({ id: terminalIdRef.current });
      }
      terminalIdRef.current = undefined;
      fitAddonRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [
    clearResizeThrottleTimer,
    cwd,
    isWindowsDesktop,
    onShellLabelChange,
    requestFocus,
    scheduleFitAndResize,
    flushTerminalServiceResize,
    services,
    sessionId,
    persistentKey,
  ]);

  // [契约] 右键菜单只操作当前 term 的选区与剪贴板，不写 PTY；复制失败只 warn，不弹错误。
  // hasSelection 为空时静默返回：空复制会清空系统剪贴板，用户丢失之前的内容。
  //
  // [边界] 这里与 customKeyEventHandler 里的 Cmd+C 是两条独立实现，改动要成对；
  // 快捷键路径必须 return false 阻止 xterm 默认处理，菜单路径则不需要。
  // [资源] navigator.clipboard 可能因非安全上下文 reject，catch 必须存在。
  const handleCopy = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
      logger.warn("[Terminal] copy via context menu failed:", err);
    });
  };

  const handlePaste = () => {
    const term = termRef.current;
    if (!term) return;
    navigator.clipboard
      .readText()
      .then((text) => text && term.paste(text))
      .catch((err) => logger.warn("[Terminal] paste via context menu failed:", err));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="terminal-xterm-shell h-full min-h-0 w-full overflow-hidden"
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          <Copy className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.copy" })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.paste" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
