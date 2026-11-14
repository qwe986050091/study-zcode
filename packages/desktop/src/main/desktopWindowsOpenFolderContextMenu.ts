// INV-01 只写当前用户：守住位置 HKCU；改错故障 需要管理员权限或污染全机。
// INV-02 两处挂载点同源：守住位置 Directory 与 Drive 共用 key 名；改错故障 驱动器右键没有菜单。
// INV-03 键名版本无关：守住位置 ZCode.OpenInZCode；改错故障 升级后出现重复菜单项。
// INV-04 文案随语言：守住位置 MENU_LABELS；改错故障 英文系统出现中文菜单。
// INV-05 缺失语言回退英文：守住位置 ?? 兜底；改错故障 非中英语言得到 undefined 文案。
// INV-06 参数必须加引号：守住位置 quoteWindowsCommandArg；改错故障 带空格路径被拆成多参。
// INV-07 引号转义：守住位置 replace(/"/g)；改错故障 路径含引号时命令截断。
// INV-08 占位符原样保留：守住位置 "%1"；改错故障 Explorer 传入的目录丢失。
// INV-09 入口参数必须绝对化：守住位置 resolve(argv[1])；改错故障 用相对路径注册后开机失效。
// INV-10 仅默认应用登记入口：守住位置 isDefaultApp && argv[1]；改错故障 开发态菜单只拉起空 Electron。
// INV-11 非 Windows 直接返回：守住位置 platform 判断；改错故障 macOS/Linux 上调用 reg.exe。
// INV-12 四条写入成组：守住位置 flatMap 顺序；改错故障 默认值、MUIVerb、Icon、command 缺一。
// INV-13 失败只告警：守住位置 catch + warn；改错故障 右键菜单失败阻断应用启动。
// INV-14 退出码进错误：守住位置 code ?? "unknown"；改错故障 排查时不知道 reg 为何失败。
//
// 模块职责：在 Windows 注册表里维护「在 ZCode 中打开」的目录与驱动器右键菜单。
// 阅读顺序：先看命令与参数的转义，再看注册表条目构造，最后看安装入口的守卫与容错。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Locale } from "@zcode/shared";

// 键名跨版本固定，避免重复项。
const MENU_KEY_NAME = "ZCode.OpenInZCode";
const DIRECTORY_MENU_KEY = `HKCU\\Software\\Classes\\Directory\\shell\\${MENU_KEY_NAME}`;
const DRIVE_MENU_KEY = `HKCU\\Software\\Classes\\Drive\\shell\\${MENU_KEY_NAME}`;
// MENU_LABELS 的菜单文案必须与界面语言一致。
const MENU_LABELS: Record<Locale, string> = {
  "zh-CN": "在ZCode中打开",
  "en-US": "Open in ZCode",
};

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export interface WindowsOpenFolderRegistryOperation {
  args: string[];
}

// 未知语言统一回落英文。
export function getWindowsOpenFolderMenuName(locale: Locale): string {
  return MENU_LABELS[locale] ?? MENU_LABELS["en-US"];
}

// 每个参数必须单独加引号并转义。
function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

// 命令必须由可执行文件、启动参数、动作、占位符四段组成。
export function buildWindowsOpenFolderCommand(
  executablePath: string,
  appArgs: readonly string[] = [],
): string {
  return [
    quoteWindowsCommandArg(executablePath),
    ...appArgs.map(quoteWindowsCommandArg),
    // open-workspace 动作参数告诉应用按工作区打开。
    "--open-workspace",
    '"%1"',
  ].join(" ");
}

// 构造纯数据，此时不能写注册表。
export function buildWindowsOpenFolderRegistryOperations(options: {
  executablePath: string;
  appArgs?: readonly string[];
  locale: Locale;
}): WindowsOpenFolderRegistryOperation[] {
  const command = buildWindowsOpenFolderCommand(options.executablePath, options.appArgs ?? []);
  const menuName = getWindowsOpenFolderMenuName(options.locale);
  const menuKeys = [DIRECTORY_MENU_KEY, DRIVE_MENU_KEY];

  return menuKeys.flatMap((menuKey) => [
    { args: ["add", menuKey, "/ve", "/d", menuName, "/f"] },
    // MUIVerb 决定 Explorer 显示文本。
    { args: ["add", menuKey, "/v", "MUIVerb", "/t", "REG_SZ", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "Icon", "/t", "REG_SZ", "/d", options.executablePath, "/f"] },
    { args: ["add", `${menuKey}\\command`, "/ve", "/d", command, "/f"] },
  ]);
}

// 单条 reg add 以退出码为准。
function runRegAdd(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("reg.exe", [...args], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      // 退出码缺失也必须给出明确文案。
      reject(new Error(`reg.exe exited with code ${code ?? "unknown"}`));
    });
  });
}

// 安装入口必须只关心平台与默认应用状态。
export async function installWindowsOpenFolderContextMenu(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  argv: readonly string[];
  isDefaultApp: boolean;
  locale: Locale;
  logger: Logger;
}): Promise<void> {
  // 非 Windows 立即空返回。
  if (options.platform !== "win32") {
    return;
  }

  const appArgs =
    // 开发态 Windows 的 process.execPath 是 Electron 可执行文件。
    // 注册表命令必须同时带上应用入口，否则 Explorer 右键菜单只能启动空 Electron。
    // 开发态必须把入口路径绝对化后写入。
    options.isDefaultApp && options.argv[1] ? [resolve(options.argv[1])] : [];
  const operations = buildWindowsOpenFolderRegistryOperations({
    executablePath: options.executablePath,
    appArgs,
    locale: options.locale,
  });

  try {
    await Promise.all(operations.map((operation) => runRegAdd(operation.args)));

    options.logger.info("[open-folder] Windows Explorer 右键菜单已安装或更新", {
      executablePath: options.executablePath,
      hasDefaultAppEntry: appArgs.length > 0,
      locale: options.locale,
    });
  } catch (error) {
    options.logger.warn("[open-folder] Windows Explorer 右键菜单安装失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
