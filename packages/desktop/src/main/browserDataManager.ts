// INV-01 内置浏览器固定使用 persist:zcode-embedded-browser 分区，导入与清理必须共用同一份会话；守住位置：EMBEDDED_BROWSER_PARTITION 常量及两处 fromPartition 回退；改错故障：数据写进临时会话，重启后登录态全部丢失。
// INV-02 调用方显式传入的 targetSession 优先于分区回退，保证测试与其它窗口可定向写入；守住位置：导入与清理两个入口的 targetSession 解析；改错故障：清理打到错误会话，用户以为已退出登录但凭据仍在。
// INV-03 非 Windows 平台未给出 profilePath、也未探测到可执行文件时必须以 chrome_executable_not_found 提前返回；守住位置：平台判断后的早返回分支；改错故障：Chrome 未安装被误报为 Profile 缺失，用户按错误提示排查无果。
// INV-04 给出显式 profilePath 时必须跳过 Profile 自动发现，不能覆盖调用方的选择；守住位置：discovered 的三元赋值；改错故障：用户指定目录被最近使用的 Profile 覆盖，导入了他人数据。
// INV-05 Profile 目录必须经 stat 确认存在，不能只信发现结果或调用方声明；守住位置：profilePath 判空与 pathExists 分支；改错故障：目录被删后仍进入下游导入，错误信息偏离真实原因。
// INV-06 成功判定只能是 Cookie 数据库存在但零行、Cookie 导入数大于零、LocalStorage 导入源大于零三者之一；守住位置：result.success 赋值；改错故障：空导入被标成成功，用户误以为迁移完成。
// INV-07 失败时 error 先取五类可操作错误码，再回落 LocalStorage 错误，最后才是通用不可用；守住位置：非成功分支的查找与空值合并；改错故障：renderer 只拿到通用错误，无法引导用户提权或换浏览器。
// INV-08 Cookie 与 LocalStorage 两阶段的 issue 必须并入同一次调用的集合去重后回传；守住位置：issues 集合与 result.issues 赋值；改错故障：同一问题重复上报，UI 提示抖动或重复弹窗。
// INV-09 macOS 钥匙串拒绝授权必须整体中止，不再进入 LocalStorage 阶段；守住位置：ChromeCookieAccessDeniedError 捕获分支；改错故障：用户已取消却继续读文件，出现二次授权与半导入状态。
// INV-10 日志只允许出现错误 name 与 code，绝不写入 Cookie 值、LocalStorage 值或绝对 Profile 路径；守住位置：toSafeBrowserDataError 与各 logger 调用；改错故障：用户隐私数据落盘并被外传。
// INV-11 单阶段失败不得中断另一阶段，两段按顺序各自累加统计；守住位置：try 块内 Cookie 与 LocalStorage 的先后顺序；改错故障：单点故障导致整体迁移不可用，用户需重复操作。
// INV-12 mode 为 all 时必须同时清除站点权限同意记录，为 cache 时必须保留登录态存储；守住位置：clearEmbeddedBrowserData 的 mode 分支；改错故障：全部清除后权限弹窗复活，或清缓存把用户踢下线。
// INV-13 普通缓存清理只能限定 shadercache、serviceworkers、cachestorage 三类，不能无参清空；守住位置：CACHE_STORAGE_TYPES 与该分支的 storages 入参；改错故障：用户点清缓存却丢失登录态与 IndexedDB 数据。
// INV-14 清理顺序固定为缓存、存储、权限三步，任一步失败即整体返回失败；守住位置：清理 try 块的调用顺序与 catch；改错故障：顺序颠倒导致权限已清而缓存残留，用户仍看到旧页面。
// INV-15 清理只返回成功或稳定错误码 embedded_browser_clear_failed，不向调用方抛异常；守住位置：catch 块；改错故障：IPC 出现未捕获异常，界面白屏且无任何提示。
// INV-16 路径拼接只走 node:path 的 join，并允许注入 platform、homeDir、localAppData 以支持跨平台测试；守住位置：resolveChromeDefaultProfilePath 的入参与三个平台分支；改错故障：Windows 下生成混合分隔符路径，文件读取失败。
// INV-17 外部副作用一律通过可选注入提供默认实现，函数不直接持有不可替换依赖；守住位置：options 解构处的默认值回落；改错故障：单测无法替换发现与导入实现，只能读取真实用户数据。
// INV-18 空结果对象必须携带完整的 cookies 与 localStorage 零值结构，renderer 无需判空；守住位置：emptyImportResult 与 result 初值；改错故障：前端读取 undefined 字段抛错，失败提示无法展示。
//
// 模块职责：为 Desktop 内置浏览器提供 Chrome 数据导入与本地数据清理两个主进程能力，不持有任何 UI 状态。
// 状态所有权：会话数据归 Electron session，导入结果在函数栈内装配后一次性返回，本模块不做缓存。
// 阅读顺序：常量与类型 → 工具函数 → 导入主流程 → 清理流程，INV 条目对应下文关键防线。
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { session as electronSession } from "electron";
import type {
  ChromeBrowserDataImportError,
  ChromeBrowserDataImportResult,
  EmbeddedBrowserDataClearResult,
} from "@zcode/shared";
import {
  importChromeCookies,
  type ChromeCookieDatabaseBackup,
  type ChromeCookieHelper,
} from "./chromeCookieManager.js";
import {
  ChromeCookieAccessDeniedError,
  type MacChromeSafeStorageSecretReader,
} from "./chromeCredentialManager.js";
import {
  emptyChromeLocalStorageImportStats,
  importChromeLocalStorage,
  type ChromeLocalStorageImportStats,
} from "./chromeLocalStorageManager.js";
import {
  discoverChromeProfile,
  resolveChromeExecutablePath,
  type ChromeProfileDiscoveryResult,
} from "./chromeProfileDiscovery.js";
import type { LinuxChromePasswordStore } from "./chromeInstallationCandidates.js";
import type { WindowsChromeAppBoundKeyReader } from "./windowsChromeAppBoundKey.js";
import { clearEmbeddedBrowserSitePermissions } from "./embeddedBrowserSitePermissions.js";

// 分区名固定带 persist: 前缀，Electron 才会把数据落盘，去掉前缀重启后全部丢失。
// [权衡] 以常量导出而非配置项，保证导入、清理与会话创建指向同一份数据。
// partition 改名等同于用户侧全量登出，需要迁移旧目录或明确接受一次重新登录。
export const EMBEDDED_BROWSER_PARTITION = "persist:zcode-embedded-browser";
// 只列 shadercache、serviceworkers、cachestorage 三类，localstorage 与 indexeddb 必须排除。
// 这三个类型可由浏览器重新生成，删除代价低，不影响登录态与会话数据。
const CACHE_STORAGE_TYPES: Electron.ClearStorageDataOptions["storages"] = [
  "shadercache",
  "serviceworkers",
  "cachestorage",
];

// [权衡] 用最小结构类型替代 Electron 会话类型，测试可传替身而不启动 Electron。
// 只声明导入与清理真正用到的成员，新增依赖需同时评估两处调用点。
interface BrowserSessionLike {
  clearCache(): Promise<void>;
  clearStorageData(options?: Electron.ClearStorageDataOptions): Promise<void>;
  cookies: {
    set(details: Electron.CookiesSetDetails): Promise<void>;
    flushStore(): Promise<void>;
  };
}

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

// [失败路径] 非 Error 抛出物统一折叠为 UnknownError，避免序列化阶段再失败。
// 仅透出 name 与字符串类型的 code，message 与堆栈留在进程内不外泄。
function toSafeBrowserDataError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

// [失败路径] stat 的任何异常都回落到 false，权限不足与路径不存在在此层不区分。
function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** 兼容旧调用；实际导入使用 discoverChromeProfile 自动选择最近使用的 Profile。 */
// 保留为兼容旧调用，真实导入已改由 Profile 自动发现挑选最近使用的目录。
// Windows 分支必须按显式 localAppData、进程环境变量、homeDir 下 AppData/Local 的顺序回落。
export function resolveChromeDefaultProfilePath(
  options: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    localAppData?: string;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Google", "Chrome", "Default");
  }
  if (platform === "win32") {
    return join(
      options.localAppData ?? process.env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
      "Default",
    );
  }
  return join(homeDir, ".config", "google-chrome", "Default");
}

// 失败结果也带完整的 cookies 与 localStorage 零值结构，调用方无需判空即可渲染计数。
// error 用条件展开而非显式 undefined，保持返回对象键集合稳定。
function emptyImportResult(error?: ChromeBrowserDataImportError): ChromeBrowserDataImportResult {
  return {
    success: false,
    cookies: { imported: 0, skipped: 0, failed: 0 },
    localStorage: emptyChromeLocalStorageImportStats(),
    ...(error ? { error } : {}),
  };
}

// 所有外部依赖均为可选注入：可执行文件发现、Profile 发现、解密辅助、备份与 LocalStorage 导入器。
// [权衡] 参数偏多是为了让 test double 与各平台适配层共用同一入口签名。
// logger 必填，主进程不能静默失败，至少留下开始与结束两条记录。
export async function importChromeBrowserData(options: {
  allowElevatedChromeDecryption?: boolean;
  chromeCookieDatabaseBackup?: ChromeCookieDatabaseBackup;
  chromeCookieHelper?: ChromeCookieHelper;
  chromeExecutableDiscovery?: () => Promise<string | null>;
  chromeExecutablePath?: string;
  chromePasswordStore?: LinuxChromePasswordStore;
  chromeProfileDiscovery?: () => Promise<ChromeProfileDiscoveryResult>;
  logger: BrowserDataLogger;
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader;
  profilePath?: string;
  platform?: NodeJS.Platform;
  targetSession?: BrowserSessionLike;
  windowsChromeAppBoundKeyReader?: WindowsChromeAppBoundKeyReader;
  localStorageImporter?: (options: {
    profilePath: string;
    targetSession: Electron.Session;
    logger: BrowserDataLogger;
    platform?: NodeJS.Platform;
    chromeExecutablePath?: string;
  }) => Promise<ChromeLocalStorageImportStats>;
}): Promise<ChromeBrowserDataImportResult> {
  const platform = options.platform ?? process.platform;
  // [并发] 只在非 Windows 且既无显式 profilePath 又无显式可执行文件路径时探测一次。
  // 结果放局部变量而非模块级 cache，多窗口并发导入互不影响。
  let detectedChromeExecutablePath = options.chromeExecutablePath;
  // [失败路径] 探测失败立即返回 chrome_executable_not_found，不触碰任何 Chrome 源数据。
  // 该早返回刻意排在 Profile 发现之前，避免把「未安装」误判成「Profile 缺失」。
  if (platform !== "win32" && !options.profilePath && !detectedChromeExecutablePath) {
    detectedChromeExecutablePath =
      (await (options.chromeExecutableDiscovery ??
        (() => resolveChromeExecutablePath({ platform })))()) ?? undefined;
    if (!detectedChromeExecutablePath) {
      // 过去会先扫描默认 Profile，导致“Chrome 未安装”被误报为 Profile 缺失，
      // 也无法识别注册在非默认目录的浏览器。先完成可执行文件发现，失败时不访问源数据。
      return emptyImportResult("chrome_executable_not_found");
    }
  }
  const discovered = options.profilePath
    ? null
    : await (options.chromeProfileDiscovery ?? (() => discoverChromeProfile({ platform })))();
  if (discovered && !discovered.success) return emptyImportResult(discovered.error);

  const profilePath = options.profilePath ?? discovered?.source.profilePath;
  // [失败路径] 显式路径与发现结果都要过存在性校验，目录被删时不再进入下游。
  // 失败返回 chrome_profile_not_found，与可执行文件缺失的错误码分开，便于引导排查。
  if (!profilePath || !(await pathExists(profilePath))) {
    return emptyImportResult("chrome_profile_not_found");
  }
  const chromeExecutablePath =
    options.chromeExecutablePath ??
    discovered?.source.executablePath ??
    detectedChromeExecutablePath;
  const chromePasswordStore = options.chromePasswordStore ?? discovered?.source.passwordStore;
  const targetSession =
    options.targetSession ?? electronSession.fromPartition(EMBEDDED_BROWSER_PARTITION);
  const result: ChromeBrowserDataImportResult = {
    success: false,
    cookies: { imported: 0, skipped: 0, failed: 0 },
    localStorage: emptyChromeLocalStorageImportStats(),
  };
  // [并发] Cookie 与 LocalStorage 两阶段的问题共用同一个集合，按错误码天然去重。
  // 集合只活在本次调用内，多次导入之间不共享，告警不会跨请求累积。
  const issues = new Set<ChromeBrowserDataImportError>();

  try {
    options.logger.info("[browser-data] 开始导入 Chrome 浏览器数据", {
      browser: discovered?.source.browser ?? "explicit-profile",
      profile: discovered?.source.profileDirectory ?? "explicit-profile",
    });
    // Cookie 阶段先执行，因为它决定解密权限是否成立，失败时可能整体中止。
    // [资源] 数据库备份、平台解密器与辅助进程全部由入参透传，本函数不自行 open 句柄。
    const cookieImport = await importChromeCookies({
      allowElevatedChromeDecryption: options.allowElevatedChromeDecryption,
      databaseBackup: options.chromeCookieDatabaseBackup,
      chromeCookieHelper: options.chromeCookieHelper,
      chromeExecutablePath,
      chromePasswordStore,
      logger: options.logger,
      macChromeSafeStorageSecretReader: options.macChromeSafeStorageSecretReader,
      platform,
      profilePath,
      targetSession,
      windowsChromeAppBoundKeyReader: options.windowsChromeAppBoundKeyReader,
    });
    result.cookies = cookieImport.stats;
    for (const issue of cookieImport.issues) issues.add(issue);

    // LocalStorage 排在 Cookie 之后，Cookie 阶段抛错时根本不会走到这里。
    // 默认实现来自同目录 importer，可注入以便替换为测试替身或平台特化实现。
    const localStorageImporter = options.localStorageImporter ?? importChromeLocalStorage;
    options.logger.info("[browser-data] 开始导入 Chrome LocalStorage");
    result.localStorage = await localStorageImporter({
      profilePath,
      targetSession: targetSession as Electron.Session,
      logger: options.logger,
      platform,
      chromeExecutablePath,
    });
    if (result.localStorage.error) issues.add(result.localStorage.error);

    // [权衡] 数据库存在但零行视为成功：用户 Chrome 确实没有 Cookie，不应报错。
    // 三个条件必须用或连接，任一成立即成功，允许部分成功而不要求两阶段都非零。
    result.success =
      (cookieImport.databaseFound && cookieImport.rowCount === 0) ||
      result.cookies.imported > 0 ||
      result.localStorage.originsImported > 0;
    // 错误码必须按可操作性排序：提权、取消、校验失败、App-Bound 解密失败、保护不支持。
    // 取值第一个命中项，顺序即优先级，新增错误码要插到对应位置。
    if (!result.success) {
      result.error = [
        "chrome_cookie_elevation_required",
        "chrome_cookie_elevation_cancelled",
        "chrome_cookie_helper_verification_failed",
        "chrome_cookie_app_bound_decryption_failed",
        "chrome_cookie_protection_unsupported",
      ].find((issue) => issues.has(issue as ChromeBrowserDataImportError)) as
        | ChromeBrowserDataImportError
        | undefined;
      result.error ??= result.localStorage.error ?? "chrome_browser_data_import_unavailable";
    }
    if (issues.size > 0) result.issues = [...issues];
    options.logger.info("[browser-data] Chrome 数据导入完成", {
      importedCount: result.cookies.imported,
      skippedCount: result.cookies.skipped,
      failedCount: result.cookies.failed,
      importedLocalStorageOrigins: result.localStorage.originsImported,
      importedLocalStorageEntries: result.localStorage.entriesImported,
      skippedLocalStorageOrigins: result.localStorage.originsSkipped,
      failedLocalStorageOrigins: result.localStorage.originsFailed,
    });
    return result;
  // [失败路径] 顶层 catch 是最后一道闸，未预期异常在此转成稳定可序列化错误码。
  // [权衡] 用展开沿用 result 中已完成的统计，让用户看到部分成功的数据。
  } catch (error) {
    // 钥匙串拒绝授权是唯一需要专属文案的分支，直接覆盖 error 而不合并 issues。
    // 该分支必须整体返回，不能再进入 LocalStorage 阶段触发二次授权弹窗。
    if (error instanceof ChromeCookieAccessDeniedError) {
      // macOS 用户拒绝钥匙串授权后，导入必须作为一个整体停止，不能再进入
      // LocalStorage 阶段；返回稳定错误码给 renderer 展示明确提示。
      options.logger.warn("[browser-data] Chrome 数据导入已取消：macOS 钥匙串授权被拒绝");
      return {
        ...result,
        error: "chrome_cookie_access_denied",
      };
    }
    // 只记录错误类型/错误码，不记录 Cookie、LocalStorage 值或绝对 Profile 路径。
    options.logger.warn("[browser-data] Chrome 数据导入失败", toSafeBrowserDataError(error));
    return {
      ...result,
      ...(issues.size > 0 ? { issues: [...issues] } : {}),
      error: "chrome_data_import_failed",
    };
  }
}

// 清理入口只有 cache 与 all 两个取值，避免把清理范围变成任意参数组合。
// [并发] 同一分区可能被多个窗口共用，与页面加载并发时的串行语义由 Electron 保证。
export async function clearEmbeddedBrowserData(options: {
  logger: BrowserDataLogger;
  mode: "cache" | "all";
  targetSession?: BrowserSessionLike;
}): Promise<EmbeddedBrowserDataClearResult> {
  const targetSession =
    options.targetSession ?? electronSession.fromPartition(EMBEDDED_BROWSER_PARTITION);
  try {
    // [资源] 先清 HTTP 缓存：它不承载登录态，清理失败也最先暴露。
    await targetSession.clearCache();
    if (options.mode === "all") {
      await targetSession.clearStorageData();
      // 「全部清除」连站点权限同意记录一起清：登录态与权限授权同属用户可预期的清理范围。
      // 站点权限同意记录存放在独立模块，清除存储不会顺带清掉，必须显式调用。
      // [失败路径] 该调用抛错会让整体返回失败，避免权限残留被误判成清理成功。
      await clearEmbeddedBrowserSitePermissions();
    } else {
      // 普通缓存清理不能删除承载登录态的 LocalStorage/IndexedDB。
      // cache 模式必须只清这三类存储，登录态、IndexedDB 与权限记录全部保留。
      // 入参为 undefined 会退化成全量清理，因此这里必须显式给出 storages。
      await targetSession.clearStorageData({ storages: CACHE_STORAGE_TYPES });
    }
    options.logger.info("[browser-data] 内置浏览器数据清理完成", { mode: options.mode });
    return { success: true };
  // [失败路径] 清理失败只记 warn 并返回稳定错误码，不向 IPC 调用方抛异常。
  } catch {
    options.logger.warn("[browser-data] 内置浏览器数据清理失败", { mode: options.mode });
    return { success: false, error: "embedded_browser_clear_failed" };
  }
}
