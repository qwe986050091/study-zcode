// INV-01 单实例：守住位置 模块级托盘变量；改错故障：重复创建托盘，出现两个图标。
// INV-02 平台门：守住位置 createDesktopTray 的平台判断；改错故障：不支持平台也尝试建托盘。
// INV-03 创建可失败：守住位置 捕获分支；改错故障：图标缺失直接中断应用启动。
// INV-04 菜单同源：守住位置 语言与产品身份读取；改错故障：托盘与主菜单更新入口不一致。
// INV-05 预览不露更新：守住位置 产品身份分支；改错故障：预览版托盘出现更新入口。
// INV-06 点击回窗：守住位置 两个点击监听；改错故障：点托盘无反应。
// INV-07 命令先亮窗：守住位置 执行前的显示调用；改错故障：命令在后台窗口执行，用户看不到。
// INV-08 失败只告警：守住位置 命令链的捕获；改错故障：托盘操作异常冒泡到主进程。
// INV-09 双档表示：守住位置 一倍与二倍合成；改错故障：高 DPI 下角标发糊。
// INV-10 尺寸校验：守住位置 位图长度比较；改错故障：尺寸不符仍合成，得到错位图像。
// INV-11 缓存有界：守住位置 按标签缓存；改错故障：零未读也走合成，重复计算。
// INV-12 基础图复用：守住位置 加载即缓存；改错故障：每次角标更新都重新读盘。
// INV-13 空图不设：守住位置 空图判断；改错故障：把透明图设为托盘图标。
// INV-14 两档原子：守住位置 任一失败即放弃；改错故障：只挂上单档表示。
// INV-15 零值复原：守住位置 标签为空的分支；改错故障：未读清零后角标仍残留。
// INV-16 无托盘静默：守住位置 空值早退；改错故障：其他平台调用时报错。
// INV-17 重建安全：守住位置 可空调用；改错故障：未创建时刷新菜单崩溃。
// INV-18 无全局写：守住位置 除托盘与缓存外的模块体；改错故障：加载时产生副作用。
//
// 模块职责：创建并维护桌面托盘，组装菜单与未读角标。
// 状态所有权：tray 实例、rebuildTray 与图标缓存归本模块。
// 阅读顺序：模块状态 → 图标路径 → 托盘创建 → 菜单重建 → 基础图与角标合成 → 未读入口。
import { app, Menu, nativeImage, Tray } from "electron";
import type { NativeImage } from "electron";
import { join } from "node:path";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import {
  blendBadgeIntoBitmap,
  renderAntialiasedStatusDotPixels,
  resolveBadgeOverlayLabel,
} from "./unreadBadge.js";

// tray 实例与 rebuildTray 由模块级变量持有。
// 日志器由 setTrayLogger 延迟注入，创建前调用时安全跳过。
//
let desktopTray: Tray | null = null;
let rebuildDesktopTrayContextMenu: (() => void) | null = null;
let trayLogger: { warn: (...args: unknown[]) => void } | null = null;

// 托盘图在 Windows 通知区域实际显示约 16px。为避免把普通 32px 合成图交给 Shell
// 盲缩导致红点发糊，分别合成原生 1x(16px) 与 2x(32px) 表示；红点尺寸独立于任务栏。
// spec 见 docs/desktop/windows-taskbar-unread-badge.md
// 逻辑尺寸按 16 像素设计，用 nativeImage 合成两档。
// 避免把大图交给外壳盲缩导致角标发糊。
//
const TRAY_LOGICAL_SIZE = 16;

let trayBaseImage: NativeImage | null = null;
// 角标图按 label 缓存，计数相同直接复用。
// 缓存随标签增长，标签集合本身有界。
//
const trayBadgeImageCache = new Map<string, NativeImage>();

// Linux 只接受 PNG，Windows 继续用图标文件。
// 打包态从 process.resourcesPath 取，开发态从构建目录取。
//
export function resolveDesktopTrayIconPath(platform: NodeJS.Platform = process.platform) {
  // Linux 托盘只接受 PNG（.ico 不会渲染）；打包态 icon.png 已由 extraResources 无条件放入
  // resources 目录（electron-builder.config.js），Windows 继续用独立托盘 .ico 避免高 DPI 模糊。
  if (platform === "linux") {
    return app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(import.meta.dirname, "../../build/icon.png");
  }
  return app.isPackaged
    ? join(process.resourcesPath, "tray_icon.ico")
    : join(import.meta.dirname, "../../build/icon.ico");
}

// 非 Windows 与非 Linux 直接返回空，不创建托盘。
// 已有 tray 实例直接复用，避免重复注册监听。
// 创建失败只告警并返回空，不阻断启动。
//
export function createDesktopTray(options: {
  platform?: NodeJS.Platform;
  getLocale: () => Locale;
  showCurrentWindow: () => Promise<void> | void;
  executeDesktopCommand: (command: DesktopCommandId) => Promise<unknown>;
  quitApp: () => void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  const platform = options.platform ?? process.platform;
  // Linux 驻留能力由 createCloseToTrayCapabilityMonitor 探测决定（spec：
  // docs/desktop/linux-close-to-tray.md）；这里只挡平台，能力不过关时调用方不应传入 linux。
  if (platform !== "win32" && platform !== "linux") {
    return null;
  }

  if (desktopTray) {
    return desktopTray;
  }

  try {
    desktopTray = new Tray(resolveDesktopTrayIconPath(platform));
  } catch (error) {
    options.logger.warn("[desktop-tray] failed to create tray icon", error);
    return null;
  }
  trayLogger = options.logger;

  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuMessage(options.getLocale(), id);
  const showTrayWindow = () => {
    void Promise.resolve(options.showCurrentWindow()).catch((error) => {
      options.logger.warn("[desktop-tray] failed to show current window", error);
    });
  };
  const executeTrayCommand = (command: DesktopCommandId) => {
    void Promise.resolve(options.showCurrentWindow())
      .then(() => options.executeDesktopCommand(command))
      .catch((error) => {
        options.logger.warn(`[desktop-tray] failed to execute tray command ${command}`, error);
      });
  };
  // 菜单每次重建，locale 与产品身份都取当前值。
  // 预览版（isPreview）不暴露更新入口，与主菜单保持一致。
  //
  const rebuildContextMenu = () => {
    desktopTray?.setToolTip(getLabel(desktopMenuMessageIds.trayTooltip));
    desktopTray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: getLabel(desktopMenuMessageIds.trayOpenZCode),
          click: showTrayWindow,
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          click: () => executeTrayCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          click: () => executeTrayCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" },
        // 更新入口跟随产品身份：Preview（含生产后端的 Preview）禁用更新器，托盘也不能露出入口。
        ...(ZCODE_PRODUCT_FLAVOR === "production"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                click: () => executeTrayCommand(DesktopCommandIds.CheckForUpdates),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpAbout),
          click: () => executeTrayCommand(DesktopCommandIds.ShowAbout),
        },
        {
          // 托盘只提供日志诊断入口，避免右键菜单暴露清除全部数据操作；复用应用菜单导出命令。
          label: getLabel(desktopMenuMessageIds.helpExportLogs),
          click: () => executeTrayCommand(DesktopCommandIds.ExportLogs),
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.trayQuit),
          click: () => options.quitApp(),
        },
      ]),
    );
  };

  rebuildDesktopTrayContextMenu = rebuildContextMenu;
  desktopTray.on("click", showTrayWindow);
  desktopTray.on("double-click", showTrayWindow);
  rebuildContextMenu();

  return desktopTray;
}

// 外部只通过 rebuildTray 触发重建。
// 重建函数尚未装配时静默跳过。
//
export function updateWindowsDesktopTrayMenu() {
  rebuildDesktopTrayContextMenu?.();
}

// 基础图用 nativeImage 加载一次后缓存。
// 空图视为失败返回空，避免设置透明图标。
//
function loadTrayBaseImage(): NativeImage | null {
  if (trayBaseImage && !trayBaseImage.isEmpty()) {
    return trayBaseImage;
  }

  try {
    trayBaseImage = nativeImage.createFromPath(resolveDesktopTrayIconPath());
  } catch (error) {
    trayLogger?.warn("[desktop-tray] failed to load tray base image for badge", error);
    return null;
  }
  return trayBaseImage.isEmpty() ? null : trayBaseImage;
}

function composeTrayBadgeRepresentation(
  label: string,
  baseImage: NativeImage,
  scale: 1 | 2,
): Buffer | null {
  const size = TRAY_LOGICAL_SIZE * scale;
  const resized = baseImage.resize({ width: size, height: size });
  const bitmap = resized.toBitmap();
  if (bitmap.length !== size * size * 4) {
    trayLogger?.warn(
      `[desktop-tray] unexpected tray bitmap size ${bitmap.length}, skip badge compose`,
    );
    return null;
  }

  const canvas = new Uint8Array(bitmap);
  // 托盘保持约 8px 逻辑直径，右上角完整圆；4× 超采样后按原生尺寸合成。
  const dotSize = 5 * scale;
  const badge = renderAntialiasedStatusDotPixels({
    size: dotSize,
    centerX: 2.75 * scale,
    centerY: 2.25 * scale,
    radius: 1.875 * scale,
  });
  blendBadgeIntoBitmap({
    base: canvas,
    size,
    badge,
    badgeSize: dotSize,
    originX: size - dotSize,
    originY: 0,
  });
  return Buffer.from(canvas);
}

// 两档表示各自合成，任一失败则整体放弃。
// fs.writeFile 成功后才写入缓存，避免缓存半成品。
//
function composeTrayBadgeImage(label: string, baseImage: NativeImage): NativeImage | null {
  const cached = trayBadgeImageCache.get(label);
  if (cached) return cached;

  const oneX = composeTrayBadgeRepresentation(label, baseImage, 1);
  const twoX = composeTrayBadgeRepresentation(label, baseImage, 2);
  if (!oneX || !twoX) return null;

  const image = nativeImage.createEmpty();
  image.addRepresentation({
    scaleFactor: 1,
    width: 16,
    height: 16,
    buffer: oneX,
  });
  image.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: twoX,
  });
  trayBadgeImageCache.set(label, image);
  return image;
}

// 未读计数变化时同步托盘角标：非零在图标右上角贴数字徽章，零恢复原图。
// macOS 无托盘（createDesktopTray 返回 null），由 Dock 角标承担，这里天然 no-op。
// 零未读恢复基础图，非零才合成角标。
// 托盘不存在时天然跳过，macOS 由 Dock 承担。
//
export function applyDesktopTrayUnreadBadge(totalUnreadCount: number): void {
  if (!desktopTray) {
    return;
  }

  const label = resolveBadgeOverlayLabel(totalUnreadCount);
  if (!label) {
    const base = loadTrayBaseImage();
    if (base) {
      desktopTray.setImage(base);
    }
    return;
  }

  const base = loadTrayBaseImage();
  if (!base) {
    return;
  }

  const image = composeTrayBadgeImage(label, base);
  if (image) {
    desktopTray.setImage(image);
  }
}
