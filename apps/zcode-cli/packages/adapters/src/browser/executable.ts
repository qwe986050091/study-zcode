// ============================================================
// 文件定位：浏览器可执行文件解析：显式路径校验 → 已安装 Playwright 路径 → 系统 Chrome/Chromium/Edge。
// 输入输出：输入 env/显式路径/平台，输出可执行绝对路径；找不到时抛带操作建议的错误。
// 副作用：existsSync/statSync/accessSync 探测文件；loadPlaywrightChromium 动态 import。
// 失败语义：显式路径非法/不可执行直接抛错；自动探测失败抛“安装 Chromium 或传路径”的提示。
// 不变量：显式路径必须是绝对路径且是普通文件；Windows 不检查 X_OK（无 exec 位语义）。
// ============================================================
import { constants, accessSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BrowserType, ChromiumBrowser } from "playwright-core";

// 解析选项：env 供 Windows 安装目录展开；executablePath 用户显式指定；platform 便于测试。
export interface BrowserExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  platform?: NodeJS.Platform | string;
}

// 仅需 playwright-core 的 chromium 成员，避免把整个包类型拉进 adapter。
export interface PlaywrightChromiumModule {
  chromium: BrowserType<ChromiumBrowser>;
}

// 系统级安装的候选路径：按“稳定版优先”排列，保证同一机器上的选择可预测。
const LINUX_BROWSER_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

const MAC_BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

// 展开 Windows 三个安装根（Program Files / x86 / LocalAppData）下的 Chrome、Chromium、Edge。
// 先 filter 掉空根，避免 join(undefined) 产生相对路径而被误判为可执行文件。
function windowsBrowserPaths(env: NodeJS.ProcessEnv): string[] {
  return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root?.trim()))
    .flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
}

// 可执行性判定：必须存在且是普通文件；非 Windows 还要求执行位，否则拒绝（避免启动时才发现）。
function isUsableExecutable(path: string, platform: NodeJS.Platform | string): boolean {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 校验显式路径：undefined 表示“未指定”返回 undefined；相对路径或不可执行直接抛出可读错误。
export function validateExplicitBrowserExecutable(
  path: string | undefined,
  platform: NodeJS.Platform | string = process.platform,
): string | undefined {
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) {
    throw new Error(`Browser executable path must be absolute: ${path}`);
  }
  const absolutePath = path;
  if (!isUsableExecutable(absolutePath, platform)) {
    throw new Error(`Browser executable is missing or not executable: ${absolutePath}`);
  }
  return absolutePath;
}

// 解析可执行文件：显式路径 > Playwright 自带 chromium > 平台候选列表，取第一个可用。
// 全部失败抛出带修复建议的 Error（不返回 undefined，避免调用方漏检后 spawn 失败更难懂）。
export function resolveInstalledBrowserExecutable(
  playwright: PlaywrightChromiumModule,
  options: BrowserExecutableResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const explicit = validateExplicitBrowserExecutable(options.executablePath, platform);
  if (explicit) return explicit;

  const playwrightPath = playwright.chromium.executablePath();
  const candidates = [
    ...(playwrightPath ? [playwrightPath] : []),
    ...(platform === "darwin"
      ? MAC_BROWSER_PATHS
      : platform === "win32"
        ? windowsBrowserPaths(options.env ?? process.env)
        : LINUX_BROWSER_PATHS),
  ];
  const resolved = candidates.find((candidate) => isUsableExecutable(candidate, platform));
  if (resolved) return resolved;

  throw new Error(
    "No installed Chrome or Chromium executable was found. " +
      "Install Chromium or pass --browser-executable <absolute-path>.",
  );
}

// 动态加载 playwright-core：Desktop/app-server 进程不启用 headless 时不应因缺依赖而启动失败。
export async function loadPlaywrightChromium(): Promise<PlaywrightChromiumModule> {
  // 延迟加载很关键：Desktop/app-server 路径不会启用 CLI headless，不能因外置依赖缺失而启动失败。
  return (await import("playwright-core")) as PlaywrightChromiumModule;
}
