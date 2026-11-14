// INV-01 一次「关于」只能创建一个自绘窗口，不存在并发创建或复用旧窗口；守住位置：showAboutDialog 内的窗口构造；改错故障：连点菜单叠出多个关于窗口，用户无法逐个关闭
// INV-02 父窗口存在且未销毁时才设 parent 与 modal，两项必须同源；守住位置：new BrowserWindow 的 parent/modal 选项；改错故障：父窗口关闭后出现孤儿窗口，或模态窗口反向阻塞主界面
// INV-03 父窗口是否可用以同一判据在 parent 与 modal 两处分别判定，两次结果必须一致；守住位置：两处条件表达式；改错故障：有父无模态导致焦点双占，或无父却模态导致主窗口被锁死
// INV-04 窗口尺寸常量只服务自绘内容，透明窗口必须额外留出背景呼吸空间；守住位置：ABOUT_WINDOW_WIDTH 与 ABOUT_WINDOW_HEIGHT；改错故障：内容贴边、圆角阴影被裁，品牌展示比参考图更局促
// INV-05 版本、提交、构建时间优先取 build-meta.json，编译时常量只作兜底；守住位置：readBuildMetadata 与 createAboutSnapshot；改错故障：关于页显示编译那一刻而非安装包产物信息
// INV-06 元数据文件缺失或 JSON 非法时返回 null，绝不抛错中断窗口；守住位置：readJsonFile 的 existsSync 与 catch；改错故障：点击关于直接白屏或菜单项静默失效 [失败路径]
// INV-07 元数据路径以 import.meta.dirname 为基准向上解析，不依赖进程 cwd；守住位置：resolveBuildMetadataPath 与打包器版本回退；改错故障：从其他工作目录启动时读不到产物元数据
// INV-08 所有快照字段必须是非空字符串，空值统一收敛为 unknown；守住位置：normalizeValue；改错故障：关于页出现空白行或 undefined 文案
// INV-09 打包器版本先看元数据，再回退读 devDependencies 并剥离范围前缀；守住位置：resolveElectronBuilderVersion 与 normalizePackageVersion；改错故障：显示带 ^ 或 ~ 的版本，用户以为是真实安装版本
// INV-10 createAboutSnapshot 是纯函数，外部输入必须全部可注入；守住位置：AboutSnapshotOptions 与三处默认值分支；改错故障：单测被迫真实读盘取系统信息，断言随机器漂移
// INV-11 快照字段顺序与命名是诊断契约，详情文本必须按序拼接；守住位置：formatAboutDetail 的数组字面量；改错故障：用户复制的问题信息缺字段或错位，排查被误导
// INV-12 文案只在 ABOUT_MESSAGES 内维护，各语言键集合必须齐全；守住位置：ABOUT_MESSAGES 常量与 Locale 类型；改错故障：切到英文后出现中文占位或空白按钮
// INV-13 未知 locale 一律回退 DEFAULT_LOCALE；守住位置：getAboutMessages 的空值合并；改错故障：非规范语言标签下关于页文案变成 undefined
// INV-14 Apple Silicon 优化行仅在 darwin 且 arm64 时产出，其余平台返回空串；守住位置：formatAboutOptimizationLine；改错故障：Intel Mac 与 Windows 出现错误的硬件宣传语
// INV-15 credits 为空时整个键都不写入原生面板，用条件展开而非空串；守住位置：createSystemAboutPanelOptions 的对象展开；改错故障：macOS 面板多出一片空白说明区 [权衡]
// INV-16 图标路径区分打包态与开发态，打包后只能认 resourcesPath；守住位置：resolveAboutIconPath；改错故障：安装包内图标丢失，关于窗口没有品牌标识
// INV-17 图标文件不存在时传 undefined 而不是坏路径；守住位置：icon 选项旁的 existsSync 判定；改错故障：Electron 打印加载失败日志，窗口仍然没有图标 [失败路径]
// INV-18 自绘页面必须隔离上下文并禁用 Node 集成；守住位置：webPreferences 的 contextIsolation、nodeIntegration、sandbox；改错故障：data URL 页面获得主进程能力，形成注入面
// INV-19 窗口先隐藏、首帧就绪后再显示，加载失败不阻塞返回；守住位置：show 为 false、ready-to-show 回调与不等待的加载；改错故障：用户看到白屏闪烁，或对话框迟迟不返回 [并发]
//
// 本文件是 About 的唯一实现：把构建元数据、运行时版本与操作系统信息收敛成快照，再交给自绘页面或原生面板渲染。
// 读盘与平台探测都在失败时降级为 unknown 或 null，保证「关于」永远能打开；改动前先确认降级路径仍然完整。
import type {
  AboutPanelOptionsOptions,
  BrowserWindow,
  MessageBoxReturnValue,
} from "electron";
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release, type, version as osVersion } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LOCALE,
  type Locale,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_ENV,
  ZCODE_VERSION,
} from "@zcode/shared";
import { createCustomAboutDialogHtml } from "./aboutWindow.js";

interface DesktopBuildMetadata {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronBuilderVersion?: string;
}

interface AboutSnapshot {
  appVersion: string;
  buildCommitId: string;
  buildTime: string;
  environment: string;
  electronVersion: string;
  electronBuilderVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  v8Version: string;
  osType: string;
  osPlatform: string;
  osRelease: string;
  osVersion: string;
  osArch: string;
  hostname: string;
}

interface AboutSnapshotOptions {
  appVersion?: string;
  buildMetadata?: DesktopBuildMetadata | null;
  environment?: string;
  runtimeVersions?: Pick<NodeJS.ProcessVersions, "electron" | "chrome" | "node" | "v8">;
  osInfo?: {
    type: string;
    platform: string;
    release: string;
    version: string;
    arch: string;
    hostname: string;
  };
}

const ABOUT_APPLICATION_NAME = "ZCode Desktop App";
// 自定义 About 内容本体是 256x280；原生窗口如果同尺寸会让内容贴满透明窗口边界。
// 这里给 BrowserWindow 额外留出背景呼吸空间，避免正式 About 看起来比 demo 更局促。
// 自绘内容本体是 256x280，窗口高度额外留出 32 像素背景呼吸空间 [权衡]
// 透明窗口下这段留白就是圆角与阴影的可视区，改小会让内容贴边被裁
// 高度只影响外壳，调整时需同步 aboutWindow.ts 的页面高度，否则内部出现滚动
const ABOUT_WINDOW_WIDTH = 256;
const ABOUT_WINDOW_HEIGHT = 312;
// 两种语言文案的唯一来源，键集合由 Locale 约束，新增语言漏键会直接类型报错
// copyright 写成函数而非字符串，因为年份要在调用时取当前年，不能烘焙进常量
// ABOUT_MESSAGES 同时供原生面板与自绘页面渲染，避免同一个版本里两套文案互相漂移
const ABOUT_MESSAGES: Record<
  Locale,
  {
    aboutTitle: string;
    versionLabel: string;
    okButtonLabel: string;
    optimizedForAppleSilicon: string;
    copyright: (year: number) => string;
  }
> = {
  "zh-CN": {
    aboutTitle: "关于 ZCode",
    versionLabel: "版本",
    okButtonLabel: "确定",
    optimizedForAppleSilicon: "已针对 Apple Silicon 优化。",
    copyright: (year) => `版权所有 © ${year} ZCode。`,
  },
  "en-US": {
    aboutTitle: "About ZCode",
    versionLabel: "version",
    okButtonLabel: "OK",
    optimizedForAppleSilicon: "Optimized for Apple Silicon.",
    copyright: (year) => `Copyright © ${year} ZCode.`,
  },
};

// 所有对外字段先过这里，空串、纯空白与 null 统一收敛为 unknown [失败路径]
// 收窄成 unknown 而不是空串，是为了让关于页每一行都可见、可复制、可对比
// normalizeValue 不做类型转换，非字符串输入会直接落到 unknown，避免隐式字符串化带来意外值
function normalizeValue(value: string | undefined | null): string {
  if (typeof value !== "string") {
    return "unknown";
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function normalizePackageVersion(version: string | undefined): string {
  const normalized = normalizeValue(version);
  // normalizePackageVersion 的正则只剥掉首个数字之前的字符，预发布后缀原样保留；版本以字母开头且不含数字时结果为空，再回落到原串。
  return normalized === "unknown" ? normalized : normalized.replace(/^[^\d]*/, "") || normalized;
}

function getAboutMessages(locale: Locale): (typeof ABOUT_MESSAGES)[Locale] {
  return ABOUT_MESSAGES[locale] ?? ABOUT_MESSAGES[DEFAULT_LOCALE];
}

// 先探存在再读，两者之间仍有竞态窗口，因此 catch 必须兜住读取失败 [并发]
// 解析失败返回 null 而不是抛错，调用方只关心有没有可用元数据
// 类型参数只作用于 JSON 解析结果，字段是否齐全交给后续 normalize 兜底
// readJsonFile 刻意不做运行时校验：元数据由自家构建脚本产出，信任内部契约 [权衡]
function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    // 文件带 BOM 或编码不是 UTF-8 时 parse 会抛错并被 catch 吞掉，症状与文件缺失一致，排查需先看原始字节。
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function resolveBuildMetadataPath(): string {
  return join(import.meta.dirname, "../metadata/build-meta.json");
}

// readBuildMetadata 的默认路径在参数默认值处求值，调用方可注入路径做测试替身；优先产物元数据，缺文件才回退编译时常量
export function readBuildMetadata(
  filePath = resolveBuildMetadataPath(),
): DesktopBuildMetadata | null {
  // 之前 About 直接读取编译时注入的常量，commit/time 只能代表 tsup 那一刻。
  // 问题原因：构建和打包是分步执行的，安装包里的 about 需要的是“最终产物”的统一元数据，而不是某个编译子步骤的快照。
  // 这里优先读打包前生成的 build-meta.json；只有缺文件时才回退到编译时常量。
  return readJsonFile<DesktopBuildMetadata>(filePath);
}

// resolveElectronBuilderVersion 在元数据里已有打包器版本时直接返回，省一次磁盘读取
// 回退时读 package.json 的开发依赖，再剥离 ^、~ 等范围前缀
function resolveElectronBuilderVersion(buildMetadata: DesktopBuildMetadata | null): string {
  if (buildMetadata?.electronBuilderVersion) {
    return normalizeValue(buildMetadata.electronBuilderVersion);
  }

  const packageJson = readJsonFile<{ devDependencies?: Record<string, string> }>(
    join(import.meta.dirname, "../../package.json"),
  );
  return normalizePackageVersion(packageJson?.devDependencies?.["electron-builder"]);
}

// createAboutSnapshot 是纯函数：不写状态、不发事件，输出只由注入项与进程、系统探测结果拼成
// AboutSnapshotOptions 的三个注入点各自独立默认，测试可以只替换系统信息而不动运行时版本
// 回退链统一是显式入参、构建元数据、编译时常量的顺序，越靠前优先级越高
// 字段一次性构造完成，调用方拿到的对象此后不再变化，窗口渲染不会读到半成品
export function createAboutSnapshot(options: AboutSnapshotOptions = {}): AboutSnapshot {
  const buildMetadata = options.buildMetadata ?? null;
  const runtimeVersions = options.runtimeVersions ?? process.versions;
  const osInfo = options.osInfo ?? {
    type: type(),
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    hostname: hostname(),
  };

  return {
    appVersion: normalizeValue(options.appVersion ?? buildMetadata?.appVersion ?? ZCODE_VERSION),
    buildCommitId: normalizeValue(buildMetadata?.buildCommitId ?? ZCODE_COMMIT),
    buildTime: normalizeValue(buildMetadata?.buildTime ?? ZCODE_BUILD_TIME),
    environment: normalizeValue(options.environment ?? ZCODE_ENV),
    electronVersion: normalizeValue(runtimeVersions.electron),
    electronBuilderVersion: resolveElectronBuilderVersion(buildMetadata),
    chromiumVersion: normalizeValue(runtimeVersions.chrome),
    nodeVersion: normalizeValue(runtimeVersions.node),
    v8Version: normalizeValue(runtimeVersions.v8),
    osType: normalizeValue(osInfo.type),
    osPlatform: normalizeValue(osInfo.platform),
    osRelease: normalizeValue(osInfo.release),
    osVersion: normalizeValue(osInfo.version),
    osArch: normalizeValue(osInfo.arch),
    hostname: normalizeValue(osInfo.hostname),
  };
}

export function formatAboutDetail(snapshot: AboutSnapshot): string {
  return [
    `Version: ${snapshot.appVersion}`,
    `Commit: ${snapshot.buildCommitId}`,
    `Build Time: ${snapshot.buildTime}`,
    `Environment: ${snapshot.environment}`,
    "",
    `Electron: ${snapshot.electronVersion}`,
    `Electron Builder: ${snapshot.electronBuilderVersion}`,
    `Chromium: ${snapshot.chromiumVersion}`,
    `Node.js: ${snapshot.nodeVersion}`,
    `V8: ${snapshot.v8Version}`,
    "",
    `OS Type: ${snapshot.osType}`,
    `OS Platform: ${snapshot.osPlatform}`,
    `OS Release: ${snapshot.osRelease}`,
    `OS Version: ${snapshot.osVersion}`,
    `OS Arch: ${snapshot.osArch}`,
    `Hostname: ${snapshot.hostname}`,
  ].join("\n");
}

// formatAboutCopyright 的年份默认参数在调用时求值，跨年运行无需重启即可显示正确年份
// locale 也走默认值合并，未知语言由 getAboutMessages 统一兜底
export function formatAboutCopyright(
  year = new Date().getFullYear(),
  locale: Locale = DEFAULT_LOCALE,
): string {
  return getAboutMessages(locale).copyright(year);
}

// 只在 darwin 加 arm64 时返回优化文案，其他组合一律空串
// formatAboutOptimizationLine 用空串表示「本平台没有这句话」，上游据此决定是否渲染该行
export function formatAboutOptimizationLine(
  snapshot: Pick<AboutSnapshot, "osPlatform" | "osArch">,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (snapshot.osPlatform === "darwin" && snapshot.osArch === "arm64") {
    return getAboutMessages(locale).optimizedForAppleSilicon;
  }

  return "";
}

// 原生面板只填应用名、版本标签拼接后的版本号与版权三项固定信息
// credits 用条件展开，空串时整个键都不出现，而不是传一个空说明区 [权衡]
// 版本号由本地化标签加版本值拼接，保证不同语言下语义都完整
export function createSystemAboutPanelOptions(
  snapshot: AboutSnapshot,
  year = new Date().getFullYear(),
  locale: Locale = DEFAULT_LOCALE,
): AboutPanelOptionsOptions {
  const messages = getAboutMessages(locale);
  const credits = formatAboutOptimizationLine(snapshot, locale);
  return {
    applicationName: ABOUT_APPLICATION_NAME,
    applicationVersion: `${messages.versionLabel} ${snapshot.appVersion}`,
    copyright: formatAboutCopyright(year, locale),
    // 设计原因：macOS About Panel 的 credits 区最接近参考图里的硬件优化说明位置。
    // 保持信息交给系统级面板渲染，避免自绘窗口和原生关于弹窗风格割裂。
    ...(credits ? { credits } : {}),
  };
}

// 打包后只从 resourcesPath 取图标，开发态回退到仓库 build 目录
// 返回的是候选路径，是否存在由调用方再判一次，职责不混
function resolveAboutIconPath(isPackaged: boolean): string {
  return isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(import.meta.dirname, "../../build/icon.png");
}

// electron 用动态导入，主进程启动早期不因静态依赖而阻塞
// 返回 MessageBoxReturnValue 是历史契约，调用方按对话框结果处理即可
// 函数不持有窗口引用，生命周期完全交给 Electron，关闭即回收 [资源]
export async function showAboutDialog(
  parentWindow?: BrowserWindow,
  locale: Locale = DEFAULT_LOCALE,
): Promise<MessageBoxReturnValue> {
  const { app, BrowserWindow } = await import("electron");
  const snapshot = createAboutSnapshot({
    appVersion: app.getVersion(),
    buildMetadata: readBuildMetadata(),
  });
  const aboutMessages = getAboutMessages(locale);
  // 之前只有 macOS 使用自绘 About，Windows/Linux 仍走原生 message box。
  // 问题原因：各平台原生消息框的排版、图标和按钮样式差异很大，无法复用 macOS 参考样式。
  // 这里统一使用自绘 modal，保证 About 的品牌展示和多语言文案在三端一致。
  // 打包态判定来自 app.isPackaged，而不是环境变量，避免开发构建误判
  // resolveAboutIconPath 先算路径、existsSync 再判存在，两件事分开写便于单独替换其中一步
  const iconPath = resolveAboutIconPath(app.isPackaged);
  // 父窗口可用时才设 parent 与 modal，否则降级为无父的独立窗口 [失败路径]
  // frame: false 加 transparent: true 实现自绘圆角，代价是阴影与拖拽要自己处理 [权衡]
  // minimizable、maximizable、fullscreenable 必须全部禁用，关于窗口只应是一块静态信息卡
  // webPreferences 收紧到上下文隔离与沙箱，data URL 页面不得触达 Node
  // [缺陷 D-31] showAboutDialog 无单例、无在途互斥：菜单与托盘三个入口都能重复触发，快速连点会叠出多个关于窗口
  const aboutWindow = new BrowserWindow({
    width: ABOUT_WINDOW_WIDTH,
    height: ABOUT_WINDOW_HEIGHT,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: aboutMessages.aboutTitle,
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 无边框窗口在 Windows 上仍可能带出菜单栏，这里显式隐藏
  // 放在显示之前执行，避免首帧之后才改动导致一次重排闪动
  aboutWindow.setMenuBarVisibility(false);
  // 用 once 而非 on，保证首帧渲染后只显示一次，重复显示会抢走焦点
  // 窗口初始 show: false 是为了等 ready-to-show 再展示，杜绝白屏闪烁 [并发]
  aboutWindow.once("ready-to-show", () => {
    aboutWindow.show();
  });
  // 不等待加载结果：页面是内联 data URL，加载失败也不应阻塞对话框返回 [失败路径]
  // 整段 HTML 经编码后再拼接，避免井号与与号提前截断 data URL
  void aboutWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      createCustomAboutDialogHtml({
        applicationName: ABOUT_APPLICATION_NAME,
        appVersion: snapshot.appVersion,
        copyright: formatAboutCopyright(undefined, locale),
        optimizationLine: formatAboutOptimizationLine(snapshot, locale),
        versionLabel: aboutMessages.versionLabel,
        okButtonLabel: aboutMessages.okButtonLabel,
      }),
    )}`,
  );
  // 返回时窗口可能还没显示，用户关闭与加载失败都不会回传差异；0 只是沿用 messageBox 的返回形状，不代表真被确认。
  return { response: 0, checkboxChecked: false };
}
