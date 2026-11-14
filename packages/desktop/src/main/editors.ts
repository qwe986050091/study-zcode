/* eslint-disable max-lines -- 编辑器检测需要集中维护跨平台路径、图标解析和缓存逻辑。 */
/**
 * 编辑器检测与打开 —— 检测系统中已安装的编辑器/终端，获取图标，打开路径
 *
 * 当前支持 macOS / Windows。Linux 后续再补。
 */

// 编辑器与终端探测：把系统中已安装的编辑器收敛成 EditorInfo 列表，并按需产出图标 data URL。
// 职责边界：只读探测与图标编码；不落盘、不派发打开动作、不持有窗口或工作区状态。
// 平台边界：macOS 必须走 .app 静态白名单，Windows 必须走 Program Files 与 PATH shim 推导，Linux 只保留文件应用。
// 以下不变量必须串起同一条链路，任一条写错的表现只有两种：列表缺项，或主进程崩溃。
// INV-01 断言：编辑器候选只来自静态白名单与环境变量拼出的固定目录，绝不引入渲染层传入的任意路径 —— 守住它的位置：EditorDef 定义表与 resolveEditorDefAppPath —— 改错故障：用户可控路径被当应用拉起，等于任意可执行文件落地。
// INV-02 断言：所有外部命令参数必须以数组传入 execFileSync，禁止拼成一条 shell 字符串 —— 守住它的位置：where.exe、plutil、sips 三处调用 —— 改错故障：路径含空格即被拆成多个参数，严重时等于命令注入。
// INV-03 断言：只有 existsSync 命中的候选才算已安装，否则返回 null —— 守住它的位置：resolveEditorDefAppPath 的首次命中判定 —— 改错故障：列表出现点不开的条目，用户点击后无任何反馈。
// INV-04 断言：Windows 资源管理器与 macOS Finder 必须排在各自列表首位 —— 守住它的位置：getEditorDefsForCurrentPlatform 的拼接顺序 —— 改错故障：顶部入口首项变成某个 IDE，「在文件管理器中打开」消失。
// INV-05 断言：图标解析必须保持包解析、sips、getFileIcon 三级降级，且每级失败都返回 null —— 守住它的位置：getAppIconDataUrl —— 改错故障：任一环抛错冒泡，Promise.all 整批失败，编辑器列表全空。
// INV-06 断言：icns 模块缓存的三态不可合并，未尝试与已失败必须可区分 —— 守住它的位置：cachedIcnsModule 与 getIcnsModule —— 改错故障：缺包后每次取图标都重新 require，并反复刷同一条 warn。
// INV-07 断言：图标候选路径必须是普通文件，不能是目录 —— 守住它的位置：resolveAppIconPath 的 isFile 判断 —— 改错故障：命中同名资源目录，读取失败后退回空白文件图标。
// INV-08 断言：临时 PNG 目录必须建在 ZCode 数据根下并由 mkdtemp 生成唯一子目录 —— 守住它的位置：loadNativeImageFromIcnsViaSips 开头 —— 改错故障：并发加载多个图标时输出文件互相覆盖，图标串台。
// INV-09 断言：临时目录清理必须在 finally 中执行 —— 守住它的位置：loadNativeImageFromIcnsViaSips 的 finally —— 改错故障：sips 失败时残留目录，长期使用后占满磁盘。
// INV-10 断言：清理失败只能吞在函数内层，不得影响已拿到的图标结果 —— 守住它的位置：finally 里的空 catch —— 改错故障：清理报错覆盖成功返回值，图标白算一次。
// INV-11 断言：基础编辑器整表只在首次调用时做磁盘探测并缓存 —— 守住它的位置：cachedEditors —— 改错故障：每次菜单渲染都扫一遍目录并起 where.exe，打开菜单明显卡顿。
// INV-12 断言：带 fileExtensions 的定义不得进入基础编辑器列表 —— 守住它的位置：getBaseInstalledEditors 的过滤 —— 改错故障：文件应用混进编辑器菜单，两套语义串台。
// INV-13 断言：文件应用探测必须按 id 单飞，失败结果必须驱逐缓存 —— 守住它的位置：cachedFileApps 与 evict —— 改错故障：未安装的应用被永久判死，装好之后仍然不显示。
// INV-14 断言：windowsCommandAppNames 只在 win32 参与 PATH 反推 —— 守住它的位置：resolveWindowsCommandPaths 的平台闸门 —— 改错故障：macOS 上也去跑 where.exe，白等一次超时。
// INV-15 断言：JetBrains 版本目录必须按名称倒序取，优先最新版本 —— 守住它的位置：findWindowsJetBrainsExecutableCandidates 的排序 —— 改错故障：旧版本 exe 先命中，打开的是过期 IDE。
// INV-16 断言：任何可选能力探测失败都必须降级并留日志，不得让主进程退出 —— 守住它的位置：getIcnsModule 与 readAppBundleInfoPlist 的 catch —— 改错故障：缺一个可选依赖，整个桌面端起不来。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, win32 as pathWin32 } from "node:path";
import { app, nativeImage } from "electron";
import type { EditorInfo } from "@zcode/shared";
import { getZCodeDataRootDir } from "@zcode/services/node";
import { logger } from "./logger.js";
import {
  getFileApplicationDefs,
  matchesFileApplication,
  resolveFileApplicationPath,
} from "@desktop/main/fileApplications.js";

// [契约] 主进程是 ESM，可选的 @fiahfy/icns 只能通过 createRequire 做同步懒加载，不能写成静态 import。
// [资源] 紧随其后的系统盘路径只用于定位资源管理器 exe，兜底 C:/Windows 以兼容缺 WINDIR 的精简环境。
// [失败路径] 这里的 require 本身不包裹 try：真正的成败判断留给 getIcnsModule，此处只负责拿到加载器。
const require = createRequire(import.meta.url);
const WINDOWS_EXPLORER_PATH = pathWin32.join(process.env.WINDIR ?? "C:/Windows", "explorer.exe");

// [契约] EditorDef 必须是探测层与 UI 之间唯一的描述结构：id 稳定、name 直接展示、appPath 为主路径。
// appPathCandidates 只放「同产品备用安装位置」，不是任意候选池，顺序即优先级。
// command 为空表示没有 CLI，打开动作只能退化为 open -a 或直接拉起 bundle。
// windowsCommandAppNames 仅在 win32 用于从 PATH shim 反推真实 exe，其他平台必须忽略。
export interface EditorDef {
  id: string;
  name: string;
  /** macOS .app bundle 路径 */
  appPath: string;
  appPathCandidates?: string[];
  windowsCommandAppNames?: string[];
  /** CLI 命令名（如果有）。用于 open folder；null 则 fallback 到 `open -a` */
  command: string | null;
}

// [契约] 这里只声明图标相关的 plist 字段，且全部可选：第三方 .app 常常缺其中一半。
// plutil 输出是 JSON，多余字段解析后自然丢弃，不需要补全整个 Info.plist 结构。
// 新增字段必须同时加进 resolveAppIconPath 的候选数组，否则声明了也不会被读到。
interface AppBundleInfoPlist {
  CFBundleIconFile?: string;
  CFBundleIconFiles?: string[];
  CFBundleIconName?: string;
  CFBundleIcons?: {
    CFBundlePrimaryIcon?: {
      CFBundleIconFiles?: string[];
      CFBundleIconName?: string;
    };
  };
}

// [契约] reason 是四态枚举，必须只用于日志定位失败环节，不参与控制流。
// path 非空当且仅当 reason 为 resolved，调用方只需判 path 就能决定是否走 icns 解析。
// candidateIconNames 在失败时也要带出，否则日志里看不出是 plist 缺字段还是文件名猜错。
interface ResolvedAppIconPath {
  candidateIconNames: string[];
  path: string | null;
  reason: "resolved" | "missing-plist" | "missing-icon-name" | "missing-icon-file";
}

// [契约] 只承载 PNG 格式的 icns 条目：size 用于排序，image 直接喂给 nativeImage。
// 老格式（ARGB 与 RGB）在映射阶段就被丢弃，不在此结构里做兼容。
interface ParsedIcnsPngCandidate {
  osType: string;
  size: number;
  image: Buffer;
}

// [资源] 这张表是 macOS 的探测白名单：getInstalledEditors 完全依赖它再做 existsSync 过滤。
// 表里每条都必须是确定的 .app 绝对路径，不做通配与扫描，避免启动期遍历 /Applications。
// 新增编辑器只需追加一条定义，图标与打开链路都会自动复用。
// [权衡] 白名单必然滞后于新应用发布，这是用「可预测的启动成本」换「不能自动发现」。
const MAC_EDITOR_DEFS: EditorDef[] = [
  // 代码编辑器
  {
    id: "vscode",
    name: "VS Code",
    appPath: "/Applications/Visual Studio Code.app",
    command: "code",
  },
  // 这里之前只登记了稳定版 VS Code，`getInstalledEditors()` 又完全依赖这份静态白名单做 existsSync 过滤。
  // 用户安装的是 `Visual Studio Code - Insiders.app` 时，主进程根本不会把它纳入候选列表，UI 自然也就显示不出来。
  // 补上独立定义后，既能识别 Insiders，也能复用现有的 `code-insiders` CLI / `open -a` 降级打开链路。
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    appPath: "/Applications/Visual Studio Code - Insiders.app",
    command: "code-insiders",
  },
  { id: "cursor", name: "Cursor", appPath: "/Applications/Cursor.app", command: "cursor" },
  { id: "trae", name: "Trae", appPath: "/Applications/Trae.app", command: null },
  { id: "zed", name: "Zed", appPath: "/Applications/Zed.app", command: "zed" },
  {
    id: "sublime",
    name: "Sublime Text",
    appPath: "/Applications/Sublime Text.app",
    command: "subl",
  },
  { id: "codebuddy", name: "CodeBuddy", appPath: "/Applications/CodeBuddy.app", command: null },
  { id: "qoder", name: "Qoder", appPath: "/Applications/Qoder.app", command: null },
  // JetBrains 系列
  {
    id: "idea",
    name: "IntelliJ IDEA",
    appPath: "/Applications/IntelliJ IDEA.app",
    command: "idea",
  },
  {
    id: "idea-ce",
    name: "IntelliJ IDEA CE",
    appPath: "/Applications/IntelliJ IDEA CE.app",
    command: "idea",
  },
  { id: "webstorm", name: "WebStorm", appPath: "/Applications/WebStorm.app", command: "webstorm" },
  { id: "pycharm", name: "PyCharm", appPath: "/Applications/PyCharm.app", command: "pycharm" },
  { id: "goland", name: "GoLand", appPath: "/Applications/GoLand.app", command: "goland" },
  { id: "phpstorm", name: "PhpStorm", appPath: "/Applications/PhpStorm.app", command: "phpstorm" },
  { id: "rider", name: "Rider", appPath: "/Applications/Rider.app", command: "rider" },
  { id: "clion", name: "CLion", appPath: "/Applications/CLion.app", command: "clion" },
  { id: "rubymine", name: "RubyMine", appPath: "/Applications/RubyMine.app", command: "rubymine" },
  { id: "datagrip", name: "DataGrip", appPath: "/Applications/DataGrip.app", command: "datagrip" },
  // 终端（macOS 新版系统 Terminal 在 /System/Applications 下）
  {
    id: "terminal",
    name: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    command: null,
  },
  { id: "iterm2", name: "iTerm", appPath: "/Applications/iTerm.app", command: null },
  { id: "ghostty", name: "Ghostty", appPath: "/Applications/Ghostty.app", command: null },
  { id: "warp", name: "Warp", appPath: "/Applications/Warp.app", command: null },
  // 文件管理器
  {
    id: "finder",
    name: "Finder",
    appPath: "/System/Library/CoreServices/Finder.app",
    command: null,
  },
  // 功能扩展：QSpace / QSpace Pro 是 macOS 第三方文件管理器，默认没有 CLI，复用 open -a app bundle 打开路径。
  {
    id: "qspace",
    name: "QSpace",
    appPath: "/Applications/QSpace.app",
    command: null,
  },
  {
    id: "qspace-pro",
    name: "QSpace Pro",
    appPath: "/Applications/QSpace Pro.app",
    command: null,
  },
];

// [契约] 去重与空值过滤是候选路径的唯一入口：null、undefined、纯空白一律丢弃。
// 保留首次出现的顺序，调用方依赖这个顺序表达优先级。
// [权衡] 用 Set 去重是大小写敏感的；Windows 路径其实大小写不敏感，但同一候选不会以两种大小写同时出现。
function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0),
    ),
  );
}

// [资源] Program Files 根目录优先级：环境变量先于按系统盘拼出的默认值，兼容非 C 盘安装。
// SystemDrive 缺失时回落 C:，避免拼出 undefined\Program Files 这种脏路径。
// 返回前统一过 uniquePaths：环境变量与默认值常常指向同一个目录。
function getWindowsProgramFilesRoots(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  return uniquePaths([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ]);
}

// [资源] 用户级安装落在 LOCALAPPDATA\Programs，VS Code 与 Cursor 默认都装在这里。
// LOCALAPPDATA 缺失时回落 Default 用户目录，只为拼出可检查的候选而非真正使用。
// [契约] 一律用 pathWin32 拼接，保证在非 Windows 上做类型检查时也能得到反斜杠路径。
function getWindowsLocalProgramsRoot(): string {
  const systemDrive = process.env.SystemDrive || "C:";
  return pathWin32.join(
    process.env.LOCALAPPDATA || `${systemDrive}\\Users\\Default\\AppData\\Local`,
    "Programs",
  );
}

// [契约] 可变参数逐段交给 pathWin32.join，禁止在调用点手写含反斜杠的字符串。
// 分段传入能让目录名里的空格原样保留，不需要额外转义。
// [权衡] 这里只产出一个候选；需要多根目录时由 windowsProgramFilesCandidates 负责展开。
function windowsLocalProgramCandidate(...segments: string[]): string {
  return pathWin32.join(getWindowsLocalProgramsRoot(), ...segments);
}

// [契约] 同一组相对段要在每个 Program Files 根下各展开一次，顺序跟随根目录优先级。
// 调用点用展开运算符接入候选数组，保持「本机用户目录优先于全局目录」的既有约定。
function windowsProgramFilesCandidates(...segments: string[]): string[] {
  return getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, ...segments));
}

// [资源] JetBrains 安装目录带版本后缀，只能列目录后按前缀匹配产品名。
// 目录名倒序排列，保证「IntelliJ IDEA 2025.1」排在「2024.3」前面。
// [失败路径] readdirSync 失败直接吞掉：未安装该产品、目录无权限都属于正常情况，不能让探测中断。
// [契约] 只返回候选路径，存在性仍由下游 existsSync 判定，这里不做二次 IO。
function findWindowsJetBrainsExecutableCandidates(
  productDirPrefix: string,
  executableName: string,
): string[] {
  const roots = uniquePaths([
    ...getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, "JetBrains")),
    pathWin32.join(getWindowsLocalProgramsRoot(), "JetBrains"),
  ]);
  const candidates: string[] = [];

  for (const root of roots) {
    try {
      const entries = readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.toLowerCase().startsWith(productDirPrefix.toLowerCase()),
        )
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));

      for (const entry of entries) {
        candidates.push(pathWin32.join(root, entry, "bin", executableName));
      }
    } catch {
      // JetBrains products are optional; missing roots are expected.
    }
  }

  return candidates;
}

// [契约] 候选数组的第一项必须落到 appPath，其余进 appPathCandidates，解析时按此顺序尝试。
// 去重必须在这里做：调用点会用展开运算符把多组候选拼在一起，重复项会放大探测次数。
// [失败路径] 候选全为空时 appPath 给空串而非抛错，让上层按「未安装」处理，不阻断其它编辑器。
// windowsCommandAppNames 原样透传，仅在 win32 参与 PATH 反推。
function createWindowsEditorDef(
  id: string,
  name: string,
  appPathCandidates: string[],
  command: string | null = null,
  windowsCommandAppNames: string[] = [],
): EditorDef {
  const candidates = uniquePaths(appPathCandidates);
  return {
    id,
    name,
    appPath: candidates[0] ?? "",
    appPathCandidates: candidates.slice(1),
    windowsCommandAppNames,
    command,
  };
}

// [契约] where.exe 的参数必须是数组形式 [command]，绝不拼成一条命令行：命令名来自静态表但仍按不可信输入处理。
// [资源] 超时压到 1 秒：这只是探测，PATH 里有坏目录时不能拖住整个列表。
// [失败路径] 非 win32 直接返回空数组；where.exe 不存在或超时也返回空数组，由上层继续走静态候选。
// 输出按行拆分后再 trim 与 existsSync 过滤，丢掉已失效的 PATH 残留。
function resolveWindowsCommandPaths(command: string): string[] {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

// [资源] Windows PATH 里常见的是 bin\code.cmd 这类 shim，真实 exe 在其上级目录。
// 因此同时把命令所在目录与其父目录当作应用根，再按 appNames 拼出 exe 候选。
// [契约] 返回前统一 existsSync 过滤，只把真实存在的文件交给图标解析。
function deriveWindowsAppPathsFromCommand(command: string, appNames: string[]): string[] {
  const candidates: string[] = [];

  for (const commandPath of resolveWindowsCommandPaths(command)) {
    const commandDir = pathWin32.dirname(commandPath);
    for (const appRoot of uniquePaths([commandDir, pathWin32.dirname(commandDir)])) {
      for (const appName of appNames) {
        candidates.push(pathWin32.join(appRoot, appName));
      }
    }
  }

  // Windows PATH 常见的是 bin\code.cmd 这类 shim，真实 exe 才能提供和 mac 一致的应用图标。
  return uniquePaths(candidates).filter((candidate) => existsSync(candidate));
}

// [契约] Windows 侧把系统资源管理器排在首位，与 macOS 的 Finder 对齐。
// 它没有 CLI，command 为 null，打开动作只能走直接拉起 exe。
// [权衡] 把 Windows 资源管理器当编辑器暴露给 UI 是一次语义借用，换来顶部入口的平台一致性。
const WINDOWS_EDITOR_DEFS: EditorDef[] = [
  // Workspace 顶部“Open in Editor”以前只把真正的 IDE 暴露给 UI，
  // Windows 用户缺少最基础的“在资源管理器里打开”入口，只能回到其它菜单操作。
  // 这里把系统文件管理器也作为 editor 列表的一员，让 macOS Finder / Windows 资源管理器体验对齐。
  { id: "explorer", name: "资源管理器", appPath: WINDOWS_EXPLORER_PATH, command: null },
];

// [资源] 每个产品都必须按「用户目录、Program Files 根目录」的顺序给候选，命中即止。
// VS Code 与 Cursor 的 exe 名与产品名不同，必须显式传入，不能从 id 推导。
// JetBrains 系列没有稳定安装路径，只能靠目录前缀扫描。
// [契约] command 与 windowsCommandAppNames 成对出现：前者用于打开，后者用于反推图标来源。
const WINDOWS_ADDITIONAL_EDITOR_DEFS: EditorDef[] = [
  createWindowsEditorDef(
    "vscode",
    "VS Code",
    [
      windowsLocalProgramCandidate("Microsoft VS Code", "Code.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code", "Code.exe"),
    ],
    "code",
    ["Code.exe"],
  ),
  createWindowsEditorDef(
    "vscode-insiders",
    "VS Code Insiders",
    [
      windowsLocalProgramCandidate("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code Insiders", "Code - Insiders.exe"),
    ],
    "code-insiders",
    ["Code - Insiders.exe"],
  ),
  createWindowsEditorDef(
    "cursor",
    "Cursor",
    [
      windowsLocalProgramCandidate("Cursor", "Cursor.exe"),
      ...windowsProgramFilesCandidates("Cursor", "Cursor.exe"),
    ],
    "cursor",
    ["Cursor.exe"],
  ),
  createWindowsEditorDef("trae", "Trae", [
    windowsLocalProgramCandidate("Trae", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae CN.exe"),
    ...windowsProgramFilesCandidates("Trae", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae CN.exe"),
  ]),
  createWindowsEditorDef("idea", "IntelliJ IDEA", [
    ...findWindowsJetBrainsExecutableCandidates("IntelliJ IDEA", "idea64.exe"),
  ]),
  createWindowsEditorDef("webstorm", "WebStorm", [
    ...findWindowsJetBrainsExecutableCandidates("WebStorm", "webstorm64.exe"),
  ]),
  createWindowsEditorDef("pycharm", "PyCharm", [
    ...findWindowsJetBrainsExecutableCandidates("PyCharm", "pycharm64.exe"),
  ]),
  createWindowsEditorDef("goland", "GoLand", [
    ...findWindowsJetBrainsExecutableCandidates("GoLand", "goland64.exe"),
  ]),
  createWindowsEditorDef("clion", "CLion", [
    ...findWindowsJetBrainsExecutableCandidates("CLion", "clion64.exe"),
  ]),
];

// [契约] 三个平台分支必须都返回数组，未知平台退化为只有文件应用，不能返回空导致 UI 空白。
// macOS 顺序必须是编辑器表在前、文件应用在后；Windows 是资源管理器、编辑器、文件应用三段拼接。
// 顺序即 UI 顺序，改动会直接影响「在编辑器中打开」菜单的排列。
// [权衡] Linux 暂不登记编辑器，只能保留文件应用，避免维护第三套路径猜测。
// [失败路径] 拼接本身不做去重，重复 id 由定义表保证不出现，这是静态表之间的约定。
export function getEditorDefsForCurrentPlatform(): EditorDef[] {
  if (process.platform === "darwin") {
    return [...MAC_EDITOR_DEFS, ...getFileApplicationDefs()];
  }

  if (process.platform === "win32") {
    return [...WINDOWS_EDITOR_DEFS, ...WINDOWS_ADDITIONAL_EDITOR_DEFS, ...getFileApplicationDefs()];
  }

  return getFileApplicationDefs();
}

/** 缓存检测结果，避免重复 IO */
// [契约] 这是候选路径的唯一归并点：主路径、备用路径、命令反推、where 结果依次合并后去重。
// Windows 下若已能从命令反推 exe，就不再跑 where.exe，省掉一次子进程。
// [资源] 反推失效时才退回 where.exe，两条链路是互斥关系而不是叠加。
// 判定安装与否只看 existsSync，首个命中的候选就是最终 appPath。
// [失败路径] 全部候选都不存在时返回 null，调用方据此把该定义从列表里剔除。
// [权衡] 这里每次都做同步 existsSync 而不缓存：调用点已有整表缓存，单条再缓存会让失效判断复杂化。
// [契约] 返回类型是 string 或 null，不允许返回空串冒充成功。
export function resolveEditorDefAppPath(def: EditorDef): string | null {
  const commandAppPaths =
    def.command && def.windowsCommandAppNames?.length
      ? deriveWindowsAppPathsFromCommand(def.command, def.windowsCommandAppNames)
      : [];
  const commandPaths =
    process.platform === "win32" && def.windowsCommandAppNames?.length
      ? []
      : def.command
        ? resolveWindowsCommandPaths(def.command)
        : [];
  const candidatePaths = uniquePaths([
    def.appPath,
    ...(def.appPathCandidates ?? []),
    ...commandAppPaths,
    ...commandPaths,
  ]);
  return candidatePaths.find((candidate) => existsSync(candidate)) ?? null;
}

// [资源] 整表结果必须缓存到应用生命周期：编辑器安装状态在运行期基本不变。
// 缓存空数组也算有效值，用 null 表示「尚未探测」，两者不能混用。
// [失败路径] 探测中途抛错时不会写入缓存，下次调用会重新尝试。
let cachedEditors: EditorInfo[] | null = null;
let cachedIcnsModule: typeof import("@fiahfy/icns") | null | undefined;

// [契约] 三态缓存必须区分：undefined 表示未尝试，null 表示尝试过但失败，模块对象表示可用。
// 失败后必须把 null 写回缓存，否则每次取图标都会重新 require 并刷一条 warn。
// [失败路径] 缺子依赖（历史上是 pngjs）只降级图标解析，不能让主进程在加载阶段崩溃。
// [权衡] 用同步 require 而非动态 import，是为了让调用方保持同步签名，代价是首帧多一次磁盘读取。
function getIcnsModule(): typeof import("@fiahfy/icns") | null {
  if (cachedIcnsModule !== undefined) {
    return cachedIcnsModule;
  }

  try {
    cachedIcnsModule = require("@fiahfy/icns") as typeof import("@fiahfy/icns");
  } catch (error) {
    // 这里之前在模块顶层直接 require("@fiahfy/icns")。
    // 一旦安装包漏掉它的子依赖（这次是 pngjs），主进程会在文件加载阶段直接崩溃，
    // 连后面的 sips / file icon 降级路径都来不及执行。改成按需懒加载后，缺包时只降级图标解析。
    cachedIcnsModule = null;
    logger.warn("[editors] 加载 @fiahfy/icns 失败，图标解析将回退到 sips", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return cachedIcnsModule;
}

// [契约] plutil 走数组参数：infoPlistPath 虽然由 appPath 拼接而来，仍按不可信输入处理。
// 超时 3 秒，避免个别损坏的 bundle 拖住图标加载。
// [失败路径] 解析失败返回 null 并在日志里带上 appPath，让上层回退到系统文件图标。
function readAppBundleInfoPlist(appPath: string): AppBundleInfoPlist | null {
  try {
    const infoPlistPath = join(appPath, "Contents", "Info.plist");
    const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", infoPlistPath], {
      encoding: "utf8",
      timeout: 3000,
    });
    return JSON.parse(raw) as AppBundleInfoPlist;
  } catch (error) {
    logger.warn("[editors] 读取 Info.plist 失败，图标将回退到 file icon", {
      appPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// [契约] 图标字段优先级固定：CFBundleIconFile、CFBundleIconFiles、PrimaryIcon 的列表与名称、CFBundleIconName。
// 字段可能不带扩展名，因此每个名称都要同时尝试原名与补 .icns 两种文件名。
// [契约] 命中条件必须是「存在且为普通文件」，同名目录在第三方应用里真实出现过。
// [失败路径] 三种失败必须都用 reason 区分：缺 plist、缺字段、缺文件，便于线上定位断在哪一步。
// [资源] 这里必须只做路径判定，不读文件内容，实际解码交给 icns 包或 sips。
// [权衡] 逐个候选串行判断而非先收集再排序：图标通常在第一个字段就命中，提前返回更省。
function resolveAppIconPath(appPath: string): ResolvedAppIconPath {
  const plist = readAppBundleInfoPlist(appPath);
  if (!plist) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-plist",
    };
  }

  // `defaults read` 对不少第三方 .app 读不到 CFBundleIconFile，
  // 会让所有编辑器误回退到 Electron 的通用文件图标；这里改为直接解析 Info.plist。
  const iconNames = [
    plist.CFBundleIconFile,
    ...(plist.CFBundleIconFiles ?? []),
    ...(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ?? []),
    plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
    plist.CFBundleIconName,
  ].filter(
    (iconName): iconName is string => typeof iconName === "string" && iconName.trim().length > 0,
  );

  if (iconNames.length === 0) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-icon-name",
    };
  }

  for (const iconName of iconNames) {
    const candidateFileNames = iconName.endsWith(".icns")
      ? [iconName]
      : [iconName, `${iconName}.icns`];

    for (const candidateFileName of candidateFileNames) {
      const candidatePath = join(appPath, "Contents", "Resources", candidateFileName);
      // Ghostty 这类应用会同时存在同名资源目录和真正的 .icns 文件。
      // 之前这里只判断 existsSync，先命中目录后就会把目录当成图标文件读，
      // 最终解析失败并退回成发白的系统 file icon。这里要求候选路径必须是文件。
      if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
        return {
          candidateIconNames: iconNames,
          path: candidatePath,
          reason: "resolved",
        };
      }
    }
  }

  return {
    candidateIconNames: iconNames,
    path: null,
    reason: "missing-icon-file",
  };
}

// [契约] 只接受 format 为 PNG 的 icns 条目，老格式不入候选。
// 候选按 size 倒序，保证优先取最大图再由调用方缩放。
// [失败路径] 包解析不到 PNG、解码出的图仍为空、解析抛错，三种情况都返回 null 交给 sips。
// [资源] 依赖模块缺失时直接返回 null，本函数不承担加载职责。
function loadNativeImageFromIcnsViaPackage(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  const icnsModule = getIcnsModule();
  if (!icnsModule) {
    return null;
  }

  const { Icns } = icnsModule;

  try {
    const icnsBuffer = readFileSync(icnsPath);
    const icns = Icns.from(icnsBuffer);
    const pngCandidates = icns.images
      .map((image): ParsedIcnsPngCandidate | null => {
        const supportedIconType = Icns.supportedIconTypes.find(
          (iconType) => iconType.osType === image.osType,
        );
        if (!supportedIconType || supportedIconType.format !== "PNG") {
          return null;
        }
        return {
          osType: image.osType,
          size: supportedIconType.size,
          image: image.image,
        };
      })
      .filter((candidate): candidate is ParsedIcnsPngCandidate => candidate !== null)
      .sort((left, right) => right.size - left.size);

    if (pngCandidates.length === 0) {
      logger.info("[editors] @fiahfy/icns 未解析到 PNG icon，图标将回退到 sips", {
        editorId,
        appPath,
        icnsPath,
        availableIconTypes: icns.images.map((image) => image.osType),
      });
      return null;
    }

    for (const candidate of pngCandidates) {
      const icon = nativeImage.createFromBuffer(candidate.image);
      if (!icon.isEmpty()) {
        return icon;
      }
    }

    logger.warn("[editors] @fiahfy/icns 已解析到 PNG icon，但 nativeImage 仍为空", {
      editorId,
      appPath,
      icnsPath,
      pngCandidateTypes: pngCandidates.map((candidate) => `${candidate.osType}:${candidate.size}`),
    });
    return null;
  } catch (error) {
    logger.warn("[editors] @fiahfy/icns 解析失败，图标将回退到 sips", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// [资源] 临时目录建在 ZCode 数据根下的 editor-icon，再经 mkdtemp 生成唯一子目录。
// [契约] sips 参数用数组传递，输入输出路径都不拼进命令行字符串。
// [失败路径] 转换失败或输出的 PNG 仍解析为空，都返回 null，由调用方回退到系统文件图标。
// [契约] 临时目录清理放在 finally，成功与失败路径都必须执行。
// [权衡] 清理异常只允许吞在内层，不能覆盖已经拿到的图标结果。
// [资源] 每次调用都必须新建临时目录，避免并发加载多个图标时互相覆盖输出文件。
function loadNativeImageFromIcnsViaSips(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  const tempRootDir = join(getZCodeDataRootDir(), "editor-icon");
  mkdirSync(tempRootDir, { recursive: true });
  const tempDirPath = mkdtempSync(join(tempRootDir, "icon-"));
  const tempPngPath = join(tempDirPath, "icon.png");

  try {
    execFileSync("sips", ["-s", "format", "png", icnsPath, "--out", tempPngPath], {
      encoding: "utf8",
      timeout: 5000,
    });
    const pngBuffer = readFileSync(tempPngPath);
    const icon = nativeImage.createFromBuffer(pngBuffer);
    if (icon.isEmpty()) {
      logger.warn("[editors] sips 已输出 PNG，但 nativeImage 仍为空", {
        editorId,
        appPath,
        icnsPath,
        tempPngPath,
      });
      return null;
    }
    return icon;
  } catch (error) {
    logger.warn("[editors] .icns 转 PNG 失败，图标将回退到 file icon", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    try {
      rmSync(tempDirPath, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响图标加载
    }
  }
}

// [契约] 双后端顺序固定：先走包解析，失败再走 sips，前者没有子进程开销。
// [权衡] 包解析可能读不到老格式，sips 则每次都要起进程，所以只在必要时降级。
// [失败路径] 两个后端都返回 null 时整体返回 null，由上层落到 getFileIcon。
function loadNativeImageFromIcns(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  // Electron 的 nativeImage 不适合直接读取 .icns，
  // 这里优先用 npm 包解析出 PNG icon，减少每个图标都起系统子进程的成本；
  // 只有遇到老格式或包解析不到的 case，才回退到 macOS 的 sips。
  return (
    loadNativeImageFromIcnsViaPackage(editorId, appPath, icnsPath) ??
    loadNativeImageFromIcnsViaSips(editorId, appPath, icnsPath)
  );
}

/**
 * 从 .app bundle 的 Info.plist 读取多个可能的 icon 字段，
 * 然后把 .icns 转成 PNG，再生成可用于菜单的真实图标。
 * 如果解析不到真实图标，再 fallback 到 Electron 的 app.getFileIcon。
 */
// [契约] 非 macOS 不做 icns 解析，直接走 Electron 的 getFileIcon。
// [资源] macOS 先尝试真实 icns，成功则缩放到 32 像素用于菜单展示。
// [失败路径] 解析不到真实图标时只记一条 info，随后统一回退到 getFileIcon。
// [契约] getFileIcon 的失败被 catch 成 null：图标缺失不能阻断整张编辑器列表。
// [权衡] 返回值统一是 data URL 字符串或 null，调用方无需区分图标来源。
// [失败路径] 编码失败同样返回 null，不允许向渲染层抛异步异常。
export function getAppIconDataUrl(editorId: string, appPath: string): Promise<string | null> {
  if (process.platform !== "darwin") {
    return app
      .getFileIcon(appPath, { size: "normal" })
      .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
      .catch((error) => {
        logger.warn("[editors] 获取 file icon 失败", {
          editorId,
          appPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
  }
  // Step 1: 尝试从 .icns 文件加载真实 app 图标
  const resolvedIcon = resolveAppIconPath(appPath);
  if (resolvedIcon.path) {
    const icon = loadNativeImageFromIcns(editorId, appPath, resolvedIcon.path);
    if (icon && !icon.isEmpty()) {
      // 缩放到合适大小（32x32 用于菜单显示）
      const resized = icon.resize({ width: 32, height: 32 });
      return Promise.resolve(`data:image/png;base64,${resized.toPNG().toString("base64")}`);
    }
  } else {
    logger.info("[editors] 未解析到真实 app 图标，图标将回退到 file icon", {
      editorId,
      appPath,
      reason: resolvedIcon.reason,
      candidateIconNames: resolvedIcon.candidateIconNames,
    });
  }

  // Step 2: fallback 到 Electron 的 app.getFileIcon
  return app
    .getFileIcon(appPath, { size: "normal" })
    .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
    .catch((error) => {
      logger.warn("[editors] 获取 file icon 失败", {
        editorId,
        appPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
}

/**
 * 检测系统中已安装的编辑器/终端，返回带图标的列表。
 * 结果会被缓存（应用生命周期内不变）。
 */
// [资源] 整表缓存命中即返回，避免每次打开菜单都做一轮磁盘探测。
// [契约] 带 fileExtensions 的定义属于文件应用，必须在这里过滤掉，保持编辑器列表的原有语义。
// [契约] 先同步解析出已安装的 appPath，再并发取图标，减少串行等待。
// [失败路径] 单个图标取不到时该条目被剔除，其余条目照常返回。
// [资源] 图标取数是 Promise.all 并发，任一失败都被收敛成 null，不会短路整批。
// [契约] cache 只在完整计算后写入，探测中间态不对外可见。
async function getBaseInstalledEditors(): Promise<EditorInfo[]> {
  if (cachedEditors) {
    return cachedEditors;
  }

  const installed = getEditorDefsForCurrentPlatform()
    .filter((def) => !("fileExtensions" in def))
    .map((def) => {
      const appPath = resolveEditorDefAppPath(def);
      return appPath ? { def, appPath } : null;
    })
    .filter((entry): entry is { def: EditorDef; appPath: string } => entry !== null);

  const results = await Promise.all(
    installed.map(async ({ def, appPath }) => {
      const iconDataUrl = await getAppIconDataUrl(def.id, appPath);
      if (!iconDataUrl) {
        return null;
      }
      return { id: def.id, name: def.name, iconDataUrl };
    }),
  );

  cachedEditors = results.filter((r): r is EditorInfo => r !== null);
  return cachedEditors;
}

// [契约] 按 id 缓存「一次探测」的 Promise，实现并发单飞：同一应用同时只查一次。
// [失败路径] 结果为 null 时必须驱逐缓存，否则未安装的应用会被永久判死。
// [资源] 驱逐时先比对当前缓存项是否仍是自己，避免覆盖后来者的新 Promise。
// [权衡] 只在失败时删缓存，成功结果长期保留，安装状态变化由重启负责刷新。
const cachedFileApps = new Map<string, Promise<EditorInfo | null>>();

/** 可选文件路径只扩展文件菜单，工作区编辑器列表保持原有语义。 */
// [契约] 基础编辑器列表与文件应用列表在这里合并，顺序是基础在前、匹配到的文件应用在后。
// [契约] filePath 必须只用于筛选文件应用，不改变基础列表的语义，也不参与缓存键。
// [资源] 文件应用的 appPath 解析是异步的，逐个走单飞缓存避免重复探测。
// [失败路径] appPath 解析不到或图标缺失时该条目返回 null，最终被过滤掉。
// [契约] 去空洞必须用类型守卫过滤，保证返回数组的元素都带 id、name 与 iconDataUrl。
// [权衡] 每次调用都必须重新筛选文件应用：筛选很轻，缓存只放在单条探测上。
// [失败路径] Promise.all 的单个失败已在内部收敛为 null，这里不再额外捕获。
export async function getInstalledEditors(filePath?: string): Promise<EditorInfo[]> {
  const base = await getBaseInstalledEditors();
  const matching = getFileApplicationDefs().filter((def) => matchesFileApplication(def, filePath));
  const applications = await Promise.all(
    matching.map((def) => {
      let pending = cachedFileApps.get(def.id);
      if (!pending) {
        pending = (async () => {
          const appPath = await resolveFileApplicationPath(def);
          if (!appPath) return null;
          const iconDataUrl = await getAppIconDataUrl(def.id, appPath);
          return iconDataUrl ? { id: def.id, name: def.name, iconDataUrl } : null;
        })();
        cachedFileApps.set(def.id, pending);
        // 未安装或图标暂不可用不能永久缓存；并发查询仍共享同一次探测。
        const evict = () => {
          if (cachedFileApps.get(def.id) === pending) cachedFileApps.delete(def.id);
        };
        void pending.then((editor) => {
          if (!editor) evict();
        }, evict);
      }
      return pending;
    }),
  );
  return [...base, ...applications.filter((entry): entry is EditorInfo => entry !== null)];
}
