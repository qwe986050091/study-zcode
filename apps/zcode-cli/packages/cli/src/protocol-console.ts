import { Console } from "node:console";

/**
 * 为独占 stdout 的 CLI（stdio protocol / TUI）安装 console 输出边界。
 *
 * app-server/agent-server 的 stdout 只能承载 ZCode Protocol NDJSON 帧，但三方
 * SDK 可能通过 console.* 写普通文本。如果不在加载这些依赖之前分离输出，
 * 任意一行日志都会被 Host 当作 JSON 解析，或直接覆盖 TUI 当前光标处的画面。
 *
 * 输入：stderr 为进程真实错误流（必须是仍在使用的同一个流对象）。
 * 输出：restore 回调，幂等；调用后恢复原 console，未调用则 console.* 一直写往 stderr。
 * 副作用：整体替换 globalThis.console，影响此后所有模块的 console 调用。
 * 失败语义：不抛错；stderr 已关闭时写入失败由 Node 流自身吞掉，不升级为进程崩溃。
 */
export function installStderrConsoleBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalConsole = globalThis.console;
  globalThis.console = new Console({ stdout: stderr, stderr });

  let restored = false;
  return () => {
    // 退出路径可能重复调用 restore；第二次起必须无副作用，避免覆盖后续模块重新安装的 console。
    if (restored) return;
    restored = true;
    globalThis.console = originalConsole;
  };
}
