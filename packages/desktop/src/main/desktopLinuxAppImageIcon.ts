// INV-01 图标安装是可选增强：守住位置 installLinuxAppImageDesktopIconBestEffort 的 try/catch；改错故障 图标失败连累 deep link 注册。
// INV-02 未以 AppImage 运行就不安装：守住位置 APPIMAGE 判定；改错故障 deb 安装被写入重复图标。
// INV-03 源图标缺失只告警不创建：守住位置 existsSync 早退；改错故障 生成空图标文件。
// INV-04 目标路径固定为 hicolor/512x512/apps：守住位置 resolveLinuxUserIconFilePath；改错故障 任务栏按名字找不到图标。
// INV-05 内容相同不复制：守住位置 copyFileIfChanged 比较；改错故障 每次启动都重写文件并触发缓存刷新。
// INV-06 未变更不刷新缓存：守住位置 changed 早退；改错故障 启动期无谓调用 gtk-update-icon-cache。
// INV-07 缓存刷新失败只告警：守住位置 三个 warn 分支；改错故障 图标已就位却被判安装失败。
// INV-08 只刷新用户级 hicolor 目录：守住位置 join 出来的路径；改错故障 扫描系统图标拖慢启动。
// INV-09 命令执行可注入：守住位置 runCommand 默认值；改错故障 测试真的去 spawn 外部进程。
// INV-10 超时单独识别：守住位置 signal === "SIGTERM"；改错故障 超时被当成普通非零退出。
// INV-11 结果三态明确：守住位置 installed/changed 两个字段；改错故障 调用方无法区分跳过与失败。
// INV-12 源与目标路径不重叠：守住位置 常量拼接；改错故障 复制到自身导致内容截断。
//
// 模块职责：AppImage 直跑时在用户级 hicolor 目录补齐应用图标，并尽力刷新图标缓存。
// 阅读顺序：先看路径解析与内容比较，再看缓存刷新的三个告警分支，最后看 best-effort 包装。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

// 从 desktopLinuxDeepLinkRegistration 拆出的 AppImage 用户级图标安装逻辑：
// 图标集成是可选的桌面增强，与 deep link 协议注册分属不同关注点，独立成模块便于各自演进。

const LINUX_APP_ICON_NAME = "zcode";
const LINUX_APP_ICON_SIZE = "512x512";

// 路径必须与 desktop entry 的图标名同尺寸，否则主题查找落空。
// 全部落在 dataDir 下，卸载时随用户数据一起清理。
function resolveLinuxUserIconFilePath(dataDir: string): string {
  return join(
    dataDir,
    "icons",
    "hicolor",
    LINUX_APP_ICON_SIZE,
    "apps",
    `${LINUX_APP_ICON_NAME}.png`,
  );
}

// 先比内容再决定是否写，避免 mtime 变化引发无意义的缓存重建。
// 比较读的是两份完整文件，512x512 PNG 体积可控。
// 返回 false 表示无需后续刷新，调用方据此短路。
function copyFileIfChanged(sourcePath: string, targetPath: string): boolean {
  if (existsSync(targetPath) && readFileSync(sourcePath).equals(readFileSync(targetPath))) {
    return false;
  }

  copyFileSync(sourcePath, targetPath);
  return true;
}

// 两个条件同时成立才安装：运行时是 AppImage 且打包时带了源图标。
// trim 后判空，防止空白字符串通过真值判断。
export function shouldInstallAppImageDesktopIcon(params: {
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
}): boolean {
  return Boolean(params.env?.APPIMAGE?.trim() && params.iconSourcePath);
}

// 源图标不存在时返回 installed=false，与创建目录失败区分开。
// mkdir recursive 覆盖首次运行目录缺失的情况。
// 图标已存在且内容相同也算 installed=true，只是 changed=false。
// changed=false 直接返回，省掉一次外部命令。
export function installLinuxAppImageDesktopIcon(params: {
  dataDir: string;
  iconSourcePath: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } {
  const iconFilePath = resolveLinuxUserIconFilePath(params.dataDir);
  if (!existsSync(params.iconSourcePath)) {
    params.logger.warn("[deep-link] Linux AppImage 图标源文件不存在，跳过用户级图标安装", {
      iconSourcePath: params.iconSourcePath,
      iconFilePath,
    });
    return { iconFilePath, installed: false, changed: false };
  }

  mkdirSync(dirname(iconFilePath), { recursive: true });
  const changed = copyFileIfChanged(params.iconSourcePath, iconFilePath);
  // AppImage 直跑不会像 deb 安装包一样把 Icon=zcode 写入 hicolor 图标主题。
  // 这里在用户级 hicolor 目录补齐同名图标，让任务栏/Dock 有机会按 desktop entry 命中真实图标。
  if (!changed) {
    return { iconFilePath, installed: true, changed };
  }

  const runCommand = params.runCommand ?? runXdgCommand;
  const cacheResult = runCommand("gtk-update-icon-cache", [
    "-f",
    "-t",
    join(params.dataDir, "icons", "hicolor"),
  ]);
  // 命令无法启动单独告警，不当作安装失败。
  // 超时通过 signal 判定，与普通非零退出分开提示。
  // stderr 只取 trimmed 摘要，避免日志里塞入整段输出。
  if (cacheResult.error) {
    params.logger.warn("[deep-link] gtk-update-icon-cache 不可用，已跳过", {
      iconFilePath,
      message: cacheResult.error.message,
    });
  } else if (cacheResult.signal === "SIGTERM") {
    params.logger.warn("[deep-link] Linux 用户级图标缓存刷新超时，已跳过", {
      iconFilePath,
      timeoutMs: XDG_COMMAND_TIMEOUT_MS,
    });
  } else if (cacheResult.status !== 0) {
    params.logger.warn("[deep-link] Linux 用户级图标缓存刷新失败", {
      iconFilePath,
      status: cacheResult.status,
      stderr: cacheResult.stderr?.trim(),
    });
  }

  return { iconFilePath, installed: true, changed };
}

// 前置判断已保证 iconSourcePath 非空，try 内不再重复校验。
export function installLinuxAppImageDesktopIconBestEffort(params: {
  dataDir: string;
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } | null {
  if (
    !shouldInstallAppImageDesktopIcon({
      env: params.env,
      iconSourcePath: params.iconSourcePath,
    }) ||
    !params.iconSourcePath
  ) {
    return null;
  }

  try {
    return installLinuxAppImageDesktopIcon({
      dataDir: params.dataDir,
      iconSourcePath: params.iconSourcePath,
      logger: params.logger,
      runCommand: params.runCommand,
    });
  } catch (error) {
    params.logger.warn("[deep-link] Linux AppImage 图标安装失败，已降级", {
      iconSourcePath: params.iconSourcePath,
      error,
    });
    return null;
  }
}
