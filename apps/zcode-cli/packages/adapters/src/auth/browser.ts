import { spawn, type ChildProcess } from "node:child_process";

/*
 * ============================================================
 * auth / browser.ts —— 跨平台打开系统浏览器
 *
 * 定位：OAuth 登录把授权 URL 交给用户浏览器；本文件封装三平台启动命令，不依赖 shell
 * 拼接（Windows 固定 cmd.exe /c start，参数数组传 URL）。
 *
 * 输入输出：输入 URL 与可选 platform/spawnProcess/timeoutMs；输出 BrowserOpenResult
 * （opened=false 时带 reason），从不抛错。
 *
 * 副作用：拉起独立子进程（detached + stdio ignore + windowsHide），成功后 unref，
 * 不让 CLI 等待浏览器退出。
 *
 * 失败语义：spawn 同步抛错、异步 error 事件或超时都归一为 opened=false；超时按“已打开”
 * 处理，因为部分平台启动成功也不触发 spawn 事件。
 * ============================================================
 */

const BROWSER_OPEN_SETTLE_TIMEOUT_MS = 1_000;

export interface BrowserOpenResult {
  /** 实际使用的可执行文件名（open / cmd.exe / xdg-open）。 */
  command: string;
  /** 是否认为浏览器已成功启动；超时按 true 处理。 */
  opened: boolean;
  /** opened=false 时的失败原因文本，供上层提示。 */
  reason?: string;
}

export interface BrowserOpenOptions {
  /** 覆盖平台判断（测试用），缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** 注入 spawn 实现（测试用），缺省 node:child_process.spawn。 */
  spawnProcess?: typeof spawn;
  /** 等待 spawn 事件的超时，单位毫秒；默认 1000。 */
  timeoutMs?: number;
}

/**
 * 用系统默认浏览器打开 URL，并把“是否成功”作为结果返回而不是异常。
 *
 * 输入 URL 必需；副作用是启动 detach 的子进程。成功路径 unref 子进程并返回 opened=true；
 * 任何启动失败（命令不存在、权限、超时）都收敛到 opened=false + reason，调用方据此
 * 决定是否提示用户手动复制链接。
 */
export async function openUrlInBrowser(
  url: string,
  options: BrowserOpenOptions = {},
): Promise<BrowserOpenResult> {
  const platform = options.platform ?? process.platform;
  const command = browserOpenCommand(platform, url);
  const spawnProcess = options.spawnProcess ?? spawn;

  try {
    const child = spawnProcess(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    return await waitForBrowserSpawn(child, command.executable, options.timeoutMs);
  } catch (error) {
    return {
      command: command.executable,
      opened: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 按平台选择启动命令；Windows 用 `cmd.exe /c start "" <url>` 避免 URL 被当作窗口标题。 */
function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { args: string[]; executable: string } {
  if (platform === "darwin") {
    return { executable: "open", args: [url] };
  }

  if (platform === "win32") {
    return { executable: "cmd.exe", args: ["/c", "start", "", url] };
  }

  return { executable: "xdg-open", args: [url] };
}

/**
 * 等待子进程 spawn/error 之一，或超时。
 *
 * 只 settle 一次：清理监听与定时器后 resolve；opened=true 时 unref，避免 CLI 退出被
 * 浏览器进程阻塞。超时视为启动成功——某些平台不产生 spawn 事件。
 */
function waitForBrowserSpawn(
  child: ChildProcess,
  command: string,
  timeoutMs = BROWSER_OPEN_SETTLE_TIMEOUT_MS,
): Promise<BrowserOpenResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (result: BrowserOpenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners("error");
      child.removeAllListeners("spawn");
      if (result.opened) {
        child.unref();
      }
      resolve(result);
    };
    timeout = setTimeout(() => {
      settle({ command, opened: true });
    }, timeoutMs);

    child.once("spawn", () => {
      settle({ command, opened: true });
    });
    child.once("error", (error) => {
      settle({
        command,
        opened: false,
        reason: error.message,
      });
    });
  });
}
