// TUI 入口模块：创建 OpenTUI renderer 并驱动"启动屏 → 主应用"的生命周期。
// 边界：只负责渲染器与 React 根的装配、主题广播与退出码收敛，不承载会话业务状态。
// 副作用：读写 stdin/stdout/stderr、创建/销毁 renderer、注册终端事件监听；均在 DESTROY 时统一解绑。
// 失败语义：非 TTY 直接写 stderr 并返回 1；启动选项加载失败以 1 退出并在 closed 后重新抛出。
import { CliRenderEvents, createCliRenderer, type CliRenderer } from "@mbears/opentui-core";
import type { UiThemeMode } from "@zcode/contracts";
import { createRoot } from "@mbears/opentui-react";
import { getZCodeCopy } from "@zcode/i18n";
import React from "react";
import { TuiApp } from "./app.js";
import { TuiStartupScreen } from "./app-startup.js";
import { createSelectionCopyHandler, hasCopyableSelectionText } from "./app-copy.js";
import { activeTuiTheme, resolveTuiThemeMode, setActiveTuiThemeMode } from "./theme/index.js";
import { resolveInitialTerminalThemeMode } from "./theme/terminal.js";
import type { TuiOptions } from "./types.js";

// TUI 交互式入口：校验 stdin/stdout 为 TTY，创建 OpenTUI renderer 后交给共享生命周期函数。
// 非交互终端直接向 stderr 写提示并返回 1，不创建 renderer。
// 启动时先按显式主题偏好设置背景色，最终模式会在终端探测后由 runTuiWithRenderer 修正。
// 复制选区的 Ctrl+Y 快捷键在此接入，实际剪贴板写入委托 options.writeClipboardText。
// 失败（createCliRenderer 抛错）不吞掉，由上层处理；成功返回进程退出码。
export const runTui = async (options: TuiOptions): Promise<number> => {
  // 重定向/管道场景无法渲染交互界面，尽早失败并给出可读提示。
  if (!options.stdin.isTTY || !options.stdout.isTTY) {
    const copy = getZCodeCopy(options.locale);
    options.stderr.write(`${copy.tui.terminal.requiresInteractive}\n`);
    return 1;
  }

  const startupThemeMode = resolveTuiThemeMode(options.theme, null);
  setActiveTuiThemeMode(startupThemeMode);

  const renderer = await createCliRenderer({
    backgroundColor: activeTuiTheme(startupThemeMode).background,
    autoFocus: false,
    consoleMode: "disabled",
    enableMouseMovement: true,
    exitOnCtrlC: false,
    // Session replacement can raise SIGPIPE while closing MCP pipes. OpenTUI's
    // default exit signals include it and would destroy the entire TUI.
    exitSignals: ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGBREAK", "SIGBUS"],
    consoleOptions: {
      keyBindings: [
        {
          action: "copy-selection",
          ctrl: true,
          name: "y",
        },
      ],
      onCopySelection: (text) => {
        if (!hasCopyableSelectionText(text) || !options.writeClipboardText) return;
        void Promise.resolve(options.writeClipboardText(text)).finally(() =>
          renderer.clearSelection(),
        );
      },
    },
    stdin: options.stdin,
    stdout: options.stdout,
    targetFps: 30,
    useMouse: true,
  });
  return runTuiWithRenderer(options, renderer);
};

/** Renderer lifecycle shared by the interactive entrypoint and native terminal tests. */
// 渲染器生命周期（交互入口与终端测试共用）：先挂启动屏，等首帧后再加载启动选项并切到 TuiApp。
// 主题模式事件通过监听器分发给已挂载的 App；DESTROY 时统一解绑、清订阅、卸载 React 根并 resolve 退出码。
// loadStartupOptions 抛错时记录 startupError 并以 1 退出，待 closed 后重新抛出，保持调用方可观测。
// 不直接写 stdout/stderr；所有输出由 renderer 与上层负责。
export async function runTuiWithRenderer(
  options: TuiOptions,
  renderer: CliRenderer,
): Promise<number> {
  let exitCode = 0;
  let startupError: unknown;
  let destroyed = false;
  let appMounted = false;
  let terminalThemeMode: UiThemeMode | null = null;
  const themeModeListeners = new Set<(mode: UiThemeMode) => void>();
  const root = createRoot(renderer);
  const onExit = (code: number) => {
    exitCode = code;
    renderer.destroy();
  };
  // OpenTUI 的 root.render 每次新建容器，重复调用会遗留启动页的 Ctrl+C 监听。
  // 保持一个 React 根，在同一棵树内换页，让 React 负责释放旧页面的键盘订阅。
  let screen: React.ReactNode = React.createElement(TuiStartupScreen, { options, onExit });
  const screenListeners = new Set<() => void>();
  // 用外部 store 驱动换页，让 React 在替换 screen 时自动卸载旧页面的订阅。
  const subscribeScreen = (listener: () => void) => {
    screenListeners.add(listener);
    return () => {
      screenListeners.delete(listener);
    };
  };
  const getScreen = () => screen;
  function TuiScreen() {
    return React.useSyncExternalStore(subscribeScreen, getScreen);
  }
  // App 尚未挂载时（启动屏阶段）立即应用终端主题；挂载后只广播，由 App 自己更新主题。
  const handleThemeMode = (mode: UiThemeMode) => {
    if (destroyed) return;
    terminalThemeMode = mode;
    if (!appMounted) {
      const resolved = resolveTuiThemeMode(options.theme, mode);
      setActiveTuiThemeMode(resolved);
      renderer.setBackgroundColor(activeTuiTheme(resolved).background);
    }
    for (const listener of themeModeListeners) listener(mode);
  };
  renderer.on(CliRenderEvents.THEME_MODE, handleThemeMode);

  const copySelection = createSelectionCopyHandler({
    clearSelection: () => renderer.clearSelection(),
    getSelectionText: () => renderer.getSelection()?.getSelectedText(),
    writeClipboardText: options.writeClipboardText,
  });

  // 切换到主应用：按当前终端模式重算主题、同步背景色，并把主题订阅/背景色设置注入 options。
  const renderApp = (readyOptions: TuiOptions) => {
    if (destroyed) return;
    const initialThemeMode = resolveTuiThemeMode(readyOptions.theme, terminalThemeMode);
    setActiveTuiThemeMode(initialThemeMode);
    renderer.setBackgroundColor(activeTuiTheme(initialThemeMode).background);
    appMounted = true;
    screen = React.createElement(TuiApp, {
      onExit,
      options: {
        ...readyOptions,
        initialThemeMode,
        setTerminalBackgroundColor: (color) => renderer.setBackgroundColor(color),
        subscribeThemeMode: (listener) => {
          themeModeListeners.add(listener);
          if (terminalThemeMode) listener(terminalThemeMode);
          return () => {
            themeModeListeners.delete(listener);
          };
        },
      },
      copySelection,
      hasCopyableSelection: () =>
        hasCopyableSelectionText(renderer.getSelection()?.getSelectedText()),
    });
    for (const listener of screenListeners) listener();
  };
  const initialize = () => {
    // harness 已销毁时不再启动会话，避免测试收尾后仍发起网络请求。
    // FRAME is emitted after native output. No runtime work can block the first paint.
    void Promise.resolve()
      .then(() => (destroyed ? undefined : options.loadStartupOptions?.()))
      .then((startup) => renderApp({ ...options, ...startup }))
      .catch((error: unknown) => {
        if (destroyed) return;
        startupError = error;
        onExit(1);
      });
  };
  // 关闭只 resolve 一次（once），所有解绑与卸载集中在此，防止监听泄漏。
  const closed = new Promise<number>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => {
      destroyed = true;
      renderer.off(CliRenderEvents.FRAME, initialize);
      renderer.off(CliRenderEvents.THEME_MODE, handleThemeMode);
      themeModeListeners.clear();
      root.unmount();
      resolve(exitCode);
    });
  });

  // 无启动选项时直接挂 App，无需等待首帧；有选项则延迟到首帧后再加载，保证首屏先出。
  if (options.loadStartupOptions) {
    renderer.once(CliRenderEvents.FRAME, initialize);
  } else {
    renderApp(options);
  }
  root.render(React.createElement(TuiScreen));
  // Terminal replies may take up to 600 ms. Detect concurrently and update the theme
  // through the existing subscription, rather than holding the first screen hostage.
  // 主题探测与首屏并行：异步结果仅通过既有 handleThemeMode 生效，不阻塞渲染。
  void resolveInitialTerminalThemeMode(renderer).then((mode) => {
    if (mode) handleThemeMode(mode);
  });

  const result = await closed;
  if (startupError) throw startupError;
  return result;
}
