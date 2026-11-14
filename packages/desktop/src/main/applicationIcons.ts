// INV-01 图标解析结果只由请求 locator 与当前平台决定，任何一层都不得自行猜测本地路径。守住位置：normalizedRequest 与 locator 尝试链的入口。改错故障：renderer 或模型给的任意字符串被当成文件路径读取。
// INV-02 locator 数量上限 3 且必须非空，每个 value 先 trim 再校验。守住位置：normalizedRequest 的结构化分支。改错故障：请求规模失控，扫描与图标读取被放大成拒绝服务入口。
// INV-03 只要有一个 locator 不合法就整单拒绝，用丢弃后长度相等判断。守住位置：normalizedRequest 的返回判断。改错故障：非法项被静默忽略，主进程按截断后的列表给出错误图标。
// INV-04 历史字符串入参仅在 darwin 且符合 SAFE_BUNDLE_ID 时转成 bundle id locator，Windows 一律不接受字符串。守住位置：normalizedRequest 尾段。改错故障：模型输出被当作 exe 路径读本机文件。
// INV-05 Windows 可执行路径必须同时满足固定盘符正则与 win32.isAbsolute。守住位置：isSafeWindowsExecutablePath。改错故障：UNC 与设备路径放行，getFileIcon 触发主进程网络文件访问。
// INV-06 必须拒绝 applicationframehost.exe，它是应用框架宿主而非应用本体。守住位置：exe 分支的前置条件。改错故障：所有 UWP 应用被解析成同一个系统图标。
// INV-07 bundle id 索引必须按小写建键、按小写查键，与 Spotlight 的大小写不敏感查询同一语义。守住位置：buildApplicationPathIndex 与 readFallbackApplicationPath。改错故障：只在 mdfind 不可用的机器上取不到图标。
// INV-08 macOS 路径拼接必须固定使用 posix 分隔符，不随运行平台切换。守住位置：buildApplicationPathIndex 的根目录与条目拼接。改错故障：Windows 上跑单测产出反斜杠路径，兜底索引与 Spotlight 口径不一致。
// INV-09 兜底扫描受 3000ms 总预算与 8 路并发约束，预算耗尽时 worker 立即退出。守住位置：buildApplicationPathIndex 的 deadline 与 worker 循环。改错故障：全盘扫描拖住主进程并耗尽文件句柄。
// INV-10 单次 plist 读取超时取固定上限与剩余预算的较小值。守住位置：PlistBuddy 调用的 timeoutMs 计算。改错故障：慢盘吞掉整段预算，索引迟迟不 ready。
// INV-11 并发 worker 共享 cursor，取出的路径必须先收窄再使用。守住位置：worker 循环里的 appPath 判空。改错故障：undefined 流入 plist 读取，异常被下面的 catch 吞掉，条目静默丢失。
// INV-12 默认依赖只构建一次索引并复用同一个 Promise，注入依赖时每次新建。守住位置：readFallbackApplicationPath 的三元分支。改错故障：每次请求重建索引，逐 bundle 扫描冻结主进程。
// INV-13 单个目录不可读、单个 plist 损坏或超时只能丢弃该条，不得中断整个索引。守住位置：两处空 catch 的边界。改错故障：一个坏应用让整机图标全部失效。
// INV-14 locator 按 AUMID 优先排序后依次尝试，第一个成功结果即返回。守住位置：createApplicationIconLoader 的 sort 与 return。改错故障：AUMID 命中被排到最后，退回 exe 的旧图标。
// INV-15 单个 locator 的失败必须只记 warn 后继续下一个，不向调用方抛错。守住位置：loader 循环内的 catch 与 continue。改错故障：某个平台分支异常打断整单解析，图标彻底缺失。
// INV-16 平台校验在各分支重复出现，与 kind 判断必须成对成立。守住位置：macOS、AUMID、exe 三个分支的条件。改错故障：缺少平台判断后在错误平台读错资源类型。
// INV-17 成功结果结构为带 iconDataUrl 的对象，空图和空字符串都算失败。守住位置：readFileIcon 的两处判空。改错故障：返回空 data URL，前端渲染成破图。
// INV-18 缓存键按请求原顺序拼接 locator 的 kind 与小写 value，不做排序，缓存存的是 Promise 而不是结果。守住位置：locatorCacheKey 与 getApplicationIcon 的读写。改错故障：顺序变化导致重复 IO，或大小写不同请求互相命中。
//
// 模块职责：把 renderer 与 CUA 提交的图标定位请求解析成本机图标 data URL，只读本地资源，不持有业务状态。
// 状态所有权：模块级图标缓存与兜底路径索引是本模块私有的性能设施，写入点分别只有 getApplicationIcon 与 readFallbackApplicationPath。
// 阅读顺序：依赖与常量 → 路径安全判断 → 兜底索引与降级 → 请求归一 → locator 尝试链 → 对外入口与缓存。
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type {
  ApplicationIconInfo,
  ApplicationIconRequest,
  ApplicationIconLocator,
} from "@zcode/shared";
import { app } from "electron";
import { getAppIconDataUrl } from "./editors.js";
import { logger } from "./logger.js";
import { readWindowsAumidIcon } from "./windowsAumidIcon.js";

// 缓存必须按 locator 组合为键存 Promise，命中即复用同一个在途请求，避免并发重复读盘。
// 失败结果同样被缓存且没有失效路径，图标变化后需要重启进程才会刷新。
// 不要在本模块之外新增写入点，否则同一个键会出现两套事实。
const applicationIconCache = new Map<string, Promise<ApplicationIconInfo | null>>();
const SAFE_BUNDLE_ID = /^[A-Za-z0-9.-]+$/;
const SAFE_WINDOWS_FIXED_DRIVE_PATH = /^[A-Za-z]:[\\/][^\\/]/u;
const FALLBACK_SCAN_BUDGET_MS = 3_000;
const PLIST_READ_TIMEOUT_MS = 1_000;
const FALLBACK_SCAN_CONCURRENCY = 8;

interface ApplicationPathDependencies {
  execute: (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  listDirectory: (path: string) => Promise<string[]>;
  homeDirectory: string;
  now: () => number;
}

const defaultApplicationPathDependencies: ApplicationPathDependencies = {
  execute: (command, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(command, [...args], { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }),
  listDirectory: (path) => readdir(path),
  homeDirectory: homedir(),
  now: () => Date.now(),
};

let defaultApplicationPathIndex: Promise<Map<string, string>> | undefined;

// 安全边界：mdfind 结果和 renderer 输入都能变成 locator，路径不是可信数据。
// 只放行本机固定盘符路径，UNC 与设备前缀一律拒绝，避免主进程去访问网络位置。
// win32.isAbsolute 单独使用不够，它同样接受 UNC，两个条件必须同时成立。
// 放宽判断等于把图标读取变成任意路径探测，会让故障不体现在图标上而体现在网络侧。
// 不合法直接返回 false，由调用方丢弃该 locator，这一层不抛错。
function isSafeWindowsExecutablePath(value: string): boolean {
  // win32.isAbsolute 同时接受 UNC 与设备路径，把不可信 locator 交给
  // app.getFileIcon 会触发主进程网络文件访问。图标读取只允许本机固定盘符路径。
  return SAFE_WINDOWS_FIXED_DRIVE_PATH.test(value) && win32.isAbsolute(value);
}

async function buildApplicationPathIndex(
  dependencies: ApplicationPathDependencies,
): Promise<Map<string, string>> {
  // 预算从索引构建开始时计时，worker 每轮重算剩余时间，用尽即退出而不是跑完整个队列。
  // 根目录覆盖系统级与用户级 Applications，缺失目录走 catch 跳过，属于预期路径。
  // 这些目录在非 macOS 环境不可读，跳过是设计行为，不要改成抛错或告警。
  // 分隔符固定 posix，避免测试环境与生产环境产出不同形态的路径。
  // 若换成跟随平台的分隔符，索引键与 Spotlight 返回值不可比，兜底命中率归零。
  const deadline = dependencies.now() + FALLBACK_SCAN_BUDGET_MS;
  // darwin 路径拼接固定用 posix 分隔符：node:path 的 join 会跟随运行平台，
  // Windows 上跑单测时产出反斜杠路径，导致兜底索引与 Spotlight 的 POSIX 口径不一致。
  const roots = [
    "/Applications",
    posix.join(dependencies.homeDirectory, "Applications"),
    "/System/Applications",
    "/System/Applications/Utilities",
  ];
  const appPaths: string[] = [];
  for (const root of roots) {
    try {
      const entries = await dependencies.listDirectory(root);
      appPaths.push(
        ...entries
          .filter((entry) => entry.endsWith(".app"))
          .map((entry) => posix.join(root, entry)),
      );
    } catch {
      // 标准目录可能不存在或不可读，继续扫描其余目录。
    }
  }

  // worker 数量取路径数与并发上限的较小值，目录为空时不会启动任何 worker。
  // 共享 cursor 让每个路径只被一个 worker 取走，索引写入因此无需额外加锁。
  // 取出的路径可能为空，先判空再使用，不能让空值流进 plist 读取。
  // 每次读取都必须先算剩余预算，超时值同时受单次上限与全局预算约束。
  // 先到先得：同一小写 bundle id 只保留首个成功路径，其余重复安装被忽略。
  const index = new Map<string, string>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < appPaths.length) {
      const appPath = appPaths[cursor++];
      // Bug 原因：并发 worker 共享 cursor，数组下标在 noUncheckedIndexedAccess 下仍可能为空；
      // 先收窄本轮路径，避免把 undefined 传给 plist 读取与索引。
      if (!appPath) return;
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) return;
      try {
        const bundleId = (
          await dependencies.execute(
            "/usr/libexec/PlistBuddy",
            ["-c", "Print :CFBundleIdentifier", posix.join(appPath, "Contents", "Info.plist")],
            Math.min(PLIST_READ_TIMEOUT_MS, remainingMs),
          )
        ).trim();
        // 索引按小写 bundle id 建键：CUA producer 的 appKey 是 `darwin:<bundleId.toLowerCase()>`，
        // 而 Info.plist 里是原始大小写（com.apple.Notes）。Spotlight 主路径用的是
        // 大小写不敏感查询（`"..."c`），兜底索引若保持精确匹配，就会只在 Spotlight 不可用的
        // 机器上取不到图标 —— 两条路径必须同一套大小写语义。
        const key = bundleId.toLowerCase();
        if (SAFE_BUNDLE_ID.test(bundleId) && !index.has(key)) index.set(key, appPath);
      } catch {
        // 单个损坏或超时的 plist 不能中断整个索引。
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FALLBACK_SCAN_CONCURRENCY, appPaths.length) }, worker),
  );
  return index;
}

// 默认依赖走模块级单例索引，多次调用共享同一个 Promise，避免重复扫描磁盘。
// 注入依赖时每次新建索引，只服务测试隔离，不要让它进入生产调用路径。
// 返回 null 表示索引里没有该 bundle id，调用方继续尝试下一个 locator。
function readFallbackApplicationPath(
  bundleId: string,
  dependencies: ApplicationPathDependencies,
): Promise<string | null> {
  // 逐 bundle id 同步扫描会冻结 Electron main；默认链路共享一次异步索引构建。
  const indexPromise =
    dependencies === defaultApplicationPathDependencies
      ? (defaultApplicationPathIndex ??= buildApplicationPathIndex(dependencies))
      : buildApplicationPathIndex(dependencies);
  return indexPromise.then((index) => index.get(bundleId.toLowerCase()) ?? null);
}

// 先查 Spotlight，拿到第一个以 .app 结尾的行就早返回，不再走兜底扫描。
// 查询串带 c 后缀表示大小写不敏感，必须与兜底索引的小写键保持一致。
// bundle id 先过白名单，防止引号和运算符注入 mdfind 查询表达式。
// mdfind 失败或超时只记 warn 并回落到兜底索引，这是预期降级而非错误。
// 兜底索引也找不到时返回 null，由 loader 决定是否继续其它 locator。
export async function resolveDarwinApplicationPath(
  bundleId: string,
  dependencies: ApplicationPathDependencies = defaultApplicationPathDependencies,
): Promise<string | null> {
  if (!SAFE_BUNDLE_ID.test(bundleId)) return null;
  try {
    const query = `kMDItemCFBundleIdentifier == "${bundleId}"c`;
    const spotlightPath = (await dependencies.execute("/usr/bin/mdfind", [query], 3_000))
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.endsWith(".app"));
    if (spotlightPath) return spotlightPath;
  } catch (error) {
    logger.warn("[application-icons] 查询应用路径失败", {
      bundleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return readFallbackApplicationPath(bundleId, dependencies);
}

interface NativeImageLike {
  isEmpty(): boolean;
  toDataURL(): string;
}

interface ApplicationIconLoaderDependencies {
  platform: NodeJS.Platform;
  getFileIcon: (path: string, options: { size: "normal" }) => Promise<NativeImageLike>;
  resolveDarwinApplicationPath: (bundleId: string) => Promise<string | null>;
  readWindowsAumidIcon?: (aumid: string) => Promise<ApplicationIconInfo | null>;
}

const defaultApplicationIconLoaderDependencies: ApplicationIconLoaderDependencies = {
  platform: process.platform,
  getFileIcon: (path, options) => app.getFileIcon(path, options),
  resolveDarwinApplicationPath,
  readWindowsAumidIcon,
};

// 统一入口：字符串与结构化请求在这里收敛成同一种 locator 列表，loader 不再接触原始入参。
// 任何校验失败都返回 null 而不是抛错，null 是调用方唯一需要处理的否定结果。
// 数量上限、kind 白名单、value 非空三项必须同时成立才保留该 locator。
// 用丢弃前后长度相等判断是否发生过裁剪，等价于要么全收要么整单拒绝。
// Windows 路径在这一层就做安全判断，非法值不会进入缓存键与尝试链。
function normalizedRequest(
  request: string | ApplicationIconRequest,
  platform: NodeJS.Platform,
): ApplicationIconRequest | null {
  if (typeof request !== "string") {
    if (!request || !Array.isArray(request.locators) || request.locators.length > 3) return null;
    const locators = request.locators.flatMap((locator) => {
      if (
        !locator ||
        (locator.kind !== "darwin-bundle-id" &&
          locator.kind !== "windows-executable-path" &&
          locator.kind !== "windows-aumid") ||
        typeof locator.value !== "string" ||
        !locator.value.trim()
      ) {
        return [];
      }
      const value = locator.value.trim();
      if (locator.kind === "windows-executable-path" && !isSafeWindowsExecutablePath(value)) {
        return [];
      }
      return [{ kind: locator.kind, value }];
    });
    return locators.length === request.locators.length && locators.length > 0 ? { locators } : null;
  }
  const value = request.trim();
  if (!value) return null;
  if (platform === "darwin" && SAFE_BUNDLE_ID.test(value)) {
    return { locators: [{ kind: "darwin-bundle-id", value }] };
  }
  // Legacy string 仅兼容历史 macOS bundle id。Windows exe 必须来自 official CUA
  // authority 的结构化 locator，不能把模型 input 当作本地文件路径。
  return null;
}

function locatorCacheKey(locator: ApplicationIconLocator): string {
  return `${locator.kind}:${locator.value.trim().toLowerCase()}`;
}

async function readFileIcon(
  path: string,
  dependencies: ApplicationIconLoaderDependencies,
): Promise<ApplicationIconInfo | null> {
  const image = await dependencies.getFileIcon(path, { size: "normal" });
  if (image.isEmpty()) return null;
  const iconDataUrl = image.toDataURL();
  return iconDataUrl ? { iconDataUrl } : null;
}

export function createApplicationIconLoader(dependencies: ApplicationIconLoaderDependencies) {
  return async (request: string | ApplicationIconRequest): Promise<ApplicationIconInfo | null> => {
    const normalized = normalizedRequest(request, dependencies.platform);
    if (!normalized) return null;
    const locators = [...normalized.locators].sort(
      (left, right) =>
        Number(right.kind === "windows-aumid") - Number(left.kind === "windows-aumid"),
    );
    // 尝试顺序由 AUMID 优先，它直连应用标识，比可执行路径更接近真实应用。
    // 单个 locator 内的分支用 continue 而不是 return，失败后仍尝试下一个 locator。
    // macOS 分支先解析路径再读图标，两步都可能失败，都要落回 continue。
    // 平台与 kind 必须成对匹配，防止在 darwin 上执行 Windows 分支。
    // 异常在本层收敛为 warn，对外只暴露结果或 null 两种形态。
    for (const locator of locators) {
      const value = locator.value.trim();
      try {
        if (
          locator.kind === "darwin-bundle-id" &&
          dependencies.platform === "darwin" &&
          SAFE_BUNDLE_ID.test(value)
        ) {
          const appPath = await dependencies.resolveDarwinApplicationPath(value);
          if (!appPath) continue;
          const iconDataUrl = await getAppIconDataUrl(value, appPath);
          if (iconDataUrl) return { iconDataUrl };
        }
        if (
          locator.kind === "windows-aumid" &&
          dependencies.platform === "win32" &&
          dependencies.readWindowsAumidIcon
        ) {
          const icon = await dependencies.readWindowsAumidIcon(value);
          if (icon) return icon;
        }
        if (
          locator.kind === "windows-executable-path" &&
          dependencies.platform === "win32" &&
          isSafeWindowsExecutablePath(value) &&
          win32.basename(value).toLowerCase() !== "applicationframehost.exe"
        ) {
          const icon = await readFileIcon(value, dependencies);
          if (icon) return icon;
        }
      } catch (error) {
        logger.warn("[application-icons] 读取应用图标失败", {
          locatorKind: locator.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  };
}

const loadApplicationIcon = createApplicationIconLoader(defaultApplicationIconLoaderDependencies);

// 对外唯一入口：先归一算键，命中缓存直接返回，未命中才发起读取并回写 Promise。
// 归一失败返回已解决的 null，保证调用方拿到的始终是 Promise，无需判空。
// 缓存键对顺序敏感，同一集合换顺序会重复读取，调整归一逻辑时要同步考虑。
export function getApplicationIcon(
  request: string | ApplicationIconRequest,
): Promise<ApplicationIconInfo | null> {
  const normalized = normalizedRequest(request, process.platform);
  if (!normalized) return Promise.resolve(null);
  const cacheKey = normalized.locators.map(locatorCacheKey).join("|");
  const cached = applicationIconCache.get(cacheKey);
  if (cached) return cached;
  const pending = loadApplicationIcon(normalized);
  applicationIconCache.set(cacheKey, pending);
  return pending;
}
