// Chrome / Chromium 安装候选推导：按平台给出各发行通道的 Profile 目录与可执行文件路径。
// 纯推导层：buildStandardChromeInstallations 不探测文件是否存在、不读注册表、不启动进程，候选是否可用由调用方判断。
// 运行进程侧只解析命令行里的可执行文件、--user-data-dir 与 --password-store，不能据此做进程发现。
// 不负责：Profile 迁移与修复、密码库读取、多候选之间的选择与去重。
//
// 不变量（改动本文件前逐条核对；每条都对应线上可观察的故障）：
// INV-01 断言：USER_DATA_ARGUMENT_PATTERN 是带 g 标志的全局正则，任何 matchAll 之前必须把 lastIndex 归零 —— 守住它的位置：parseRunningChromeInstallations 中 matchAll 前的赋值 —— 改错故障：第二条命令行起全部匹配不到，运行中的实例被静默漏掉。
// INV-02 断言：三段捕获按 双引号、单引号、裸值 的优先级取值 —— 守住它的位置：parseRunningChromeInstallations 与 parseLinuxChromePasswordStore —— 改错故障：带引号的路径被截断成空串，Profile 指向错误目录。
// INV-03 断言：LinuxChromePasswordStore 类型与 LINUX_CHROME_PASSWORD_STORES 集合必须同步增删 —— 守住它的位置：类型声明与 Set 字面量 —— 改错故障：命令行里的新后端被判为 undefined，helper 退回默认 keyring 打不开密码库。
// INV-04 断言：Windows 的 canary 安装目录是 Chrome SxS，与 macOS 的命名不同 —— 守住它的位置：windowsProductPath —— 改错故障：Windows Canary 的 User Data 永远指向不存在的目录。
// INV-05 断言：macOS 的 .app 包名（Google Chrome Canary）与 Profile 目录名（Chrome Canary）是两套命名 —— 守住它的位置：macApplicationName 与 macProductDirectory —— 改错故障：可执行文件候选拼成带 Chrome Canary.app 的错误路径，探测必然落空。
// INV-06 断言：Linux 的 chrome-dev 通道对应 google-chrome-unstable 目录 —— 守住它的位置：linuxProductDirectory 与 linuxExecutablePaths —— 改错故障：Dev 通道的 Profile 全部丢失，只剩 stable。
// INV-07 断言：macOS 上 chromium 的 Profile 根不带 Google 子目录，其余通道带 —— 守住它的位置：darwin 分支里的 supportRoot 三元表达式 —— 改错故障：Chromium 用户数据被指向 Google 子目录，读到空目录。
// INV-08 断言：win32 的 userDataDir 必须恒在 LOCALAPPDATA 下，与可执行文件所在的 Program Files 根无关 —— 守住它的位置：win32 分支的两处 join —— 改错故障：把 Program Files 当 Profile 根，扫描到不存在的 User Data。
// INV-09 断言：programRoots 先经 uniquePaths 去重再铺开候选 —— 守住它的位置：win32 分支里的 uniquePaths 调用 —— 改错故障：同一根目录重复出现，产生重复候选并重复尝试启动。
// INV-10 断言：Linux 候选顺序为 标准目录、snap、flatpak，标准优先 —— 守住它的位置：末尾的数组拼接返回值 —— 改错故障：沙箱 Profile 抢占首位，读到长期未更新的旧数据库。
// INV-11 断言：buildStandardChromeInstallations 完全不触碰文件系统，只产出路径 —— 守住它的位置：整个函数体 —— 改错故障：在单测或渲染侧调用时同步 IO 抛错或阻塞主进程。
// INV-12 断言：isChromeBrowserExecutable 只看 basename 白名单，不看目录 —— 守住它的位置：该函数的取 basename 与正则 —— 改错故障：误把无关二进制当成 Chrome，或误杀 flatpak 导出的浏览器。
// INV-13 断言：flatpak 的 app-id 形式（com.google.Chrome、org.chromium.Chromium）必须留在白名单 —— 守住它的位置：isChromeBrowserExecutable 正则尾部 —— 改错故障：flatpak 安装的 Chrome 运行进程完全无法识别。
// INV-14 断言：parseExecutablePath 的匹配顺序是 引号整段、macOS 包内路径、裸 token —— 守住它的位置：该函数三段正则的先后 —— 改错故障：含空格的路径被截断，后续 basename 判断全部失效。
// INV-15 断言：isChromeMainProcessCommandLine 必须用是否携带 --type 区分主进程与渲染、GPU 子进程 —— 守住它的位置：该函数与调用处的 continue 分支 —— 改错故障：一个窗口的每个子进程都被当成独立安装，候选数量爆炸。
// INV-16 断言：命令行出现 --user-data-dir 时不再叠加 fallback —— 守住它的位置：userDataDirFound 标志 —— 改错故障：同一实例产出两条互斥候选，按目录去重时互相覆盖。
// INV-17 断言：fallback 仅在可执行文件路径归一后相等时生效 —— 守住它的位置：fallback 的 find 与 pathsMatch —— 改错故障：把另一通道的 Profile 与密钥后端错误绑定。
// INV-18 断言：passwordStore 按有值才展开写入，缺失时不得留下 undefined 键 —— 守住它的位置：两处条件展开 —— 改错故障：下游用 in 判断或序列化时读到 undefined，覆盖既有配置。
//
// 平台差异刻意不做抽象：三套目录布局来自各家安装器的事实约定，合并成一张表会让某一端的命名错误难以定位。
// 三张命名表（Windows 目录名、macOS 应用名、Linux 目录名）互不复用，改一端时不要顺手统一，所以改名必须按平台分别修改。
// 候选顺序即回退优先级：新增条目追加在末尾，插到头部会改变调用方的探测顺序。
// 命令行解析只覆盖常见启动形态，匹配失败时放弃该行，不做启发式猜测。
// 所有路径都用 path.join 拼接；手写分隔符会让 Windows 上的路径比较因分隔符不同而失配。
// 运行进程与标准候选的合并只发生在 fallback 分支，且必须沿用 fallback 的其余字段。
// 命名口径来自上游安装器，改动 windowsProductPath / macProductDirectory / linuxProductDirectory 前必须先确认真实安装目录，不要凭直觉修正拼写。
import { homedir } from "node:os";
import { join } from "node:path";

// [契约] 全局正则会被复用，调用方每次 matchAll 之前必须把 lastIndex 归零，否则从上次匹配结束位置继续。
// USER_DATA_ARGUMENT_PATTERN 的三段捕获对应等号带双引号、带单引号、裸值三种写法，顺序必须固定，取到第一个非空项即止。
// 路径允许含空格，所以裸值分支用 \s 收尾；不要把它改成贪婪匹配，否则会把后续参数吞进路径。
const USER_DATA_ARGUMENT_PATTERN = /--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
// [契约] 这里刻意不加 g 标志：只需要第一处 --password-store，加上 g 会引入与上面同样的 lastIndex 状态问题。
// i 标志必须保留，发行版启动脚本里参数大小写并不统一。
// PASSWORD_STORE_ARGUMENT_PATTERN 只负责取值，合法性由 LINUX_CHROME_PASSWORD_STORES 裁决，枚举范围不在正则里重复维护。
const PASSWORD_STORE_ARGUMENT_PATTERN =
  /--password-store(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i;

// 类型与运行时集合是一对：新增后端要同时改这里和 LINUX_CHROME_PASSWORD_STORES，只改类型会让新值在解析时被丢弃。
// 取值不含 detect 之类占位项，无法识别的后端一律返回 undefined，由调用方决定默认策略。
export type LinuxChromePasswordStore =
  | "basic"
  | "gnome-libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6";

// 用 Set 做白名单而不是正则，是为了让类型允许的值与运行时接受的值共用同一份枚举。
// 加新值必须同步 LinuxChromePasswordStore，否则 as 断言会把集合里多出的值伪装成类型安全。
const LINUX_CHROME_PASSWORD_STORES = new Set<LinuxChromePasswordStore>([
  "basic",
  "gnome-libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

export type ChromeBrowserKind =
  | "chrome"
  | "chrome-beta"
  | "chrome-dev"
  | "chrome-canary"
  | "chrome-for-testing"
  | "chromium";

// userDataDir 是 Profile 目录本身（Windows 点到 User Data 一级）；executablePaths 按顺序探测，executablePath 仅有运行进程候选时才存在。
// passwordStore 可选而不是默认 basic：缺失表示命令行未声明，与显式声明 basic 的语义不同。
export interface ChromeInstallationCandidate {
  browser: ChromeBrowserKind;
  userDataDir: string;
  executablePaths: string[];
  executablePath?: string;
  passwordStore?: LinuxChromePasswordStore;
}

// 全部字段可注入，是为了让单测在任意平台上构造另一端的路径布局，不必 mock process.platform。
// env 与 homeDir 缺省回落到真实环境；函数内部不得再直接读 process 或 os，否则注入失效。
export interface ChromeInstallationPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  localAppData?: string;
  platform?: NodeJS.Platform;
  programFiles?: string;
  programFilesX86?: string;
}

// 去重必须按原始字符串，不能做大小写与分隔符归一：这里只用于去掉完全相同的根目录，跨平台等价判断交给 pathsMatch。
// 保持首次出现的顺序，调用方依赖该顺序作为探测优先级，直接展开 Set 会改变次序语义。
function uniquePaths(paths: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = path?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

// canary 在 Windows 的安装目录是 Chrome SxS，不是 Chrome Canary；这处不一致是上游安装器的事实。
// 返回路径分段而不是拼好的字符串，让调用方分别用于 LOCALAPPDATA 与 Program Files 两个根。
function windowsProductPath(browser: ChromeBrowserKind): string[] {
  switch (browser) {
    case "chrome":
      return ["Google", "Chrome"];
    case "chrome-beta":
      return ["Google", "Chrome Beta"];
    case "chrome-dev":
      return ["Google", "Chrome Dev"];
    case "chrome-canary":
      return ["Google", "Chrome SxS"];
    case "chrome-for-testing":
      return ["Google", "Chrome for Testing"];
    case "chromium":
      return ["Chromium"];
  }
}

// macProductDirectory 给的是 Application Support 下的目录名，Canary 的目录名是 Chrome Canary，不能与 .app 包名混用。
// chromium 的目录名首字母大写，Linux 侧则是全小写，两张表不能互相抄。
function macProductDirectory(browser: ChromeBrowserKind): string {
  switch (browser) {
    case "chrome":
      return "Chrome";
    case "chrome-beta":
      return "Chrome Beta";
    case "chrome-dev":
      return "Chrome Dev";
    case "chrome-canary":
      return "Chrome Canary";
    case "chrome-for-testing":
      return "Chrome for Testing";
    case "chromium":
      return "Chromium";
  }
}

// macApplicationName 给的是 .app 包名与包内 MacOS 可执行文件名，Google Chrome 系列必须带厂商前缀，Chromium 不带。
// 测试专用通道的包名含空格且不是 Canary，按通道逐个列举比字符串拼接更不容易错。
function macApplicationName(browser: ChromeBrowserKind): string {
  switch (browser) {
    case "chrome":
      return "Google Chrome";
    case "chrome-beta":
      return "Google Chrome Beta";
    case "chrome-dev":
      return "Google Chrome Dev";
    case "chrome-canary":
      return "Google Chrome Canary";
    case "chrome-for-testing":
      return "Google Chrome for Testing";
    case "chromium":
      return "Chromium";
  }
}

function linuxProductDirectory(browser: ChromeBrowserKind): string {
  switch (browser) {
    case "chrome":
      return "google-chrome";
    case "chrome-beta":
      return "google-chrome-beta";
    case "chrome-dev":
      return "google-chrome-unstable";
    case "chrome-canary":
      return "google-chrome-canary";
    case "chrome-for-testing":
      return "google-chrome-for-testing";
    case "chromium":
      return "chromium";
  }
}

function linuxExecutablePaths(browser: ChromeBrowserKind): string[] {
  switch (browser) {
    case "chrome":
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/google-chrome",
        "/opt/google/chrome/chrome",
      ];
    case "chrome-beta":
      return [
        "/usr/bin/google-chrome-beta",
        "/opt/google/chrome-beta/google-chrome-beta",
        "/opt/google/chrome-beta/chrome",
      ];
    case "chrome-dev":
      return [
        "/usr/bin/google-chrome-unstable",
        "/opt/google/chrome-unstable/google-chrome-unstable",
        "/opt/google/chrome-unstable/chrome",
      ];
    case "chrome-canary":
      return ["/usr/bin/google-chrome-canary"];
    case "chrome-for-testing":
      return ["/usr/bin/google-chrome-for-testing"];
    case "chromium":
      return [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/lib/chromium/chromium",
        "/usr/lib/chromium-browser/chromium-browser",
      ];
  }
}

// 纯推导函数：不发系统调用、不探测文件是否存在，返回的是按平台可能存在的路径，可用性由调用方判断。
// browsers 的顺序就是各平台候选顺序，必须固定为 stable、beta、dev、canary、for-testing、chromium，不要按名字排序。
export function buildStandardChromeInstallations(
  options: ChromeInstallationPathOptions = {},
): ChromeInstallationCandidate[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const browsers: ChromeBrowserKind[] = [
    "chrome",
    "chrome-beta",
    "chrome-dev",
    "chrome-canary",
    "chrome-for-testing",
    "chromium",
  ];

  // darwin 分支用 map 生成，系统 /Applications 必须排在用户 ~/Applications 之前，后者作为便携安装的补充候选。
  // XDG 变量在这里完全不参与，macOS 只看 Application Support 布局。
  if (platform === "darwin") {
    return browsers.map((browser) => {
      const productDirectory = macProductDirectory(browser);
      const applicationName = macApplicationName(browser);
      const supportRoot =
        browser === "chromium"
          ? join(homeDir, "Library", "Application Support")
          : join(homeDir, "Library", "Application Support", "Google");
      return {
        browser,
        userDataDir: join(supportRoot, productDirectory),
        executablePaths: [
          join("/Applications", `${applicationName}.app`, "Contents", "MacOS", applicationName),
          join(
            homeDir,
            "Applications",
            `${applicationName}.app`,
            "Contents",
            "MacOS",
            applicationName,
          ),
        ],
      };
    });
  }

  // win32 的 Profile 根只有 LOCALAPPDATA，Program Files 系列仅用于可执行文件，两者不能混用。
  // env 与显式选项的优先级写在空值合并链里；改顺序会让 CI 注入的假路径被真实环境覆盖。
  if (platform === "win32") {
    const localAppData =
      options.localAppData ?? env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local");
    // 三个根可能重合（例如 LOCALAPPDATA 被显式指向 Program Files），去重后每个根只产生一条候选。
    // 顺序必须为 Program Files、Program Files (x86)、LOCALAPPDATA，对应 64 位安装、32 位安装与用户级安装。
    const programRoots = uniquePaths([
      options.programFiles ?? env.PROGRAMFILES ?? "C:\\Program Files",
      options.programFilesX86 ?? env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
      localAppData,
    ]);
    return browsers.map((browser) => {
      const productPath = windowsProductPath(browser);
      return {
        browser,
        userDataDir: join(localAppData, ...productPath, "User Data"),
        executablePaths: programRoots.map((root) =>
          join(root, ...productPath, "Application", "chrome.exe"),
        ),
      };
    });
  }

  // 配置根优先级是 Chrome 私有变量、XDG、~/.config；顺序错了会读不到用户实际在用的 Profile。
  // 这里只取第一个非空值，不做多目录合并，多根场景由下面的 snap 与 flatpak 候选单独覆盖。
  const configRoot = env.CHROME_CONFIG_HOME ?? env.XDG_CONFIG_HOME ?? join(homeDir, ".config");
  const standardInstallations = browsers.map((browser) => ({
    browser,
    userDataDir: join(configRoot, linuxProductDirectory(browser)),
    executablePaths: linuxExecutablePaths(browser),
  }));
  // Ubuntu 上 Chromium 常以 Snap 安装，Chrome/Chromium 也可能来自 Flatpak。
  // 这些 Profile 不在 XDG 标准目录中；保留独立候选，才能在标准目录为空时继续发现真实数据。
  // [权衡] snap 与 flatpak 的 Profile 不在 XDG 目录，必须独立成候选，否则标准目录为空时整条发现链断掉。
  // 这些条目排在标准候选之后，标准安装可用时优先级更高，避免读到沙箱里长期未更新的旧数据。
  // flatpak 的可执行文件用导出目录里的软链路径，不指向版本化子目录，升级后路径才不会失效。
  const sandboxedInstallations: ChromeInstallationCandidate[] = [
    {
      browser: "chromium",
      userDataDir: join(homeDir, "snap", "chromium", "common", "chromium"),
      executablePaths: ["/snap/bin/chromium", "/var/lib/snapd/snap/bin/chromium"],
    },
    {
      browser: "chrome",
      userDataDir: join(homeDir, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
      executablePaths: [
        join(homeDir, ".local", "share", "flatpak", "exports", "bin", "com.google.Chrome"),
        "/var/lib/flatpak/exports/bin/com.google.Chrome",
      ],
    },
    {
      browser: "chromium",
      userDataDir: join(homeDir, ".var", "app", "org.chromium.Chromium", "config", "chromium"),
      executablePaths: [
        join(homeDir, ".local", "share", "flatpak", "exports", "bin", "org.chromium.Chromium"),
        "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
      ],
    },
  ];
  return [...standardInstallations, ...sandboxedInstallations];
}

// 三段匹配的顺序是刻意的：带引号的整段最可靠，其次是 macOS 包内路径，最后才退回裸 token。
// 裸 token 分支要求 token 必须内含 chrome 或 chromium，避免把解释器、wrapper 脚本当成浏览器。
// [权衡] 这里不解析 shell 转义与多层包装脚本；宁可返回 undefined 让调用方跳过，也不要猜出一个错路径。
function parseExecutablePath(commandLine: string): string | undefined {
  const quoted = commandLine.match(/^\s*"([^"]+(?:chrome|chromium)[^"]*)"/i)?.[1];
  if (quoted) return quoted;
  const macApplication = commandLine.match(
    /^\s*(.+?\/(?:Google Chrome(?: Beta| Dev| Canary| for Testing)?|Chromium))(?:\s+--|$)/i,
  )?.[1];
  if (macApplication) return macApplication;
  return commandLine.match(/^\s*(\S*(?:chrome|chromium)(?:\.exe)?)(?:\s|$)/i)?.[1];
}

// isChromeBrowserExecutable 只比较 basename：同一可执行文件可能来自 /usr/bin、/opt 或 flatpak 导出目录，目录不能参与判断。
// 白名单必须包含 flatpak 的 app-id，它们是导出软链的目标名，漏掉就认不出沙箱安装的浏览器。
// 正则用 i 标志吞掉大小写差异，因此 Google Chrome Beta 这类含空格的名称也能命中。
export function isChromeBrowserExecutable(path: string): boolean {
  const executableName = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  return /^(?:chrome(?:\.exe)?|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable|-canary|-for-testing)?|Google Chrome(?: Beta| Dev| Canary| for Testing)?|com\.google\.Chrome|org\.chromium\.Chromium)$/i.test(
    executableName,
  );
}

// 去重键是反斜杠转正斜杠再加小写，但返回的是首次出现的原始写法，调用方要拿它去启动进程。
// parseRunningChromeExecutablePaths 只回可执行文件列表，不会解析 Profile 与密钥后端。
export function parseRunningChromeExecutablePaths(commandLines: string[]): string[] {
  const executablePaths: string[] = [];
  const seen = new Set<string>();
  for (const commandLine of commandLines) {
    const executablePath = parseExecutablePath(commandLine);
    if (!executablePath || !isChromeBrowserExecutable(executablePath)) continue;
    const normalized = executablePath.replaceAll("\\", "/").toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    executablePaths.push(executablePath);
  }
  return executablePaths;
}

// 识别不了的后端返回 undefined，而不是回落 basic：显式声明却拼错时，应当暴露为未声明让上层决定。
// 取值先 toLowerCase 再查 LINUX_CHROME_PASSWORD_STORES，启动脚本里出现过全大写的后端名。
function parseLinuxChromePasswordStore(commandLine: string): LinuxChromePasswordStore | undefined {
  const match = commandLine.match(PASSWORD_STORE_ARGUMENT_PATTERN);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
  return value && LINUX_CHROME_PASSWORD_STORES.has(value as LinuxChromePasswordStore)
    ? (value as LinuxChromePasswordStore)
    : undefined;
}

// 比较前把分隔符与大小写归一，Windows 传入的反斜杠路径才能与命令行里的正斜杠写法相等。
// pathsMatch 只用于匹配、不用于回传；候选里保留的始终是原始路径写法。
function pathsMatch(left: string, right: string): boolean {
  return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
}

// 只有浏览器主进程才携带 --user-data-dir；带 --type 的是渲染、GPU 等子进程，不能各算一个安装。
// 判据用 不含 --type 而不是枚举子进程类型，新进程类型出现时不会把子进程误判成主进程。
function isChromeMainProcessCommandLine(commandLine: string): boolean {
  return !/(?:^|\s)--type(?:=|\s)/i.test(commandLine);
}

// 输出顺序与输入命令行一致，同一实例可产出多条（多个 --user-data-dir）；fallbackInstallations 只用于补全没带目录的主进程。
// [契约] browser 靠命令行里是否出现 chromium 来猜，Chrome 打开 Chromium Profile 这类混合场景以进程名为准。
export function parseRunningChromeInstallations(
  commandLines: string[],
  fallbackInstallations: ChromeInstallationCandidate[] = [],
): ChromeInstallationCandidate[] {
  const installations: ChromeInstallationCandidate[] = [];
  for (const commandLine of commandLines) {
    const executablePath = parseExecutablePath(commandLine);
    if (!executablePath || !isChromeBrowserExecutable(executablePath)) continue;
    const passwordStore = parseLinuxChromePasswordStore(commandLine);
    let userDataDirFound = false;
    // [并发] 该正则是模块级单例，lastIndex 是共享可变状态；忘记重置就会从上一次匹配结束处继续，导致后续命令行漏匹配。
    // 重置必须紧跟在上面的可执行文件与密钥后端解析之后、matchAll 之前，中间任何一次该正则的调用都会污染位置。
    // 不要改成每次新建 RegExp：高频调用会放大开销，也容易与常量里的字面量漂移。
    USER_DATA_ARGUMENT_PATTERN.lastIndex = 0;
    for (const match of commandLine.matchAll(USER_DATA_ARGUMENT_PATTERN)) {
      const userDataDir = match[1] ?? match[2] ?? match[3];
      if (!userDataDir) continue;
      userDataDirFound = true;
      // 同一命令行的每个 --user-data-dir 都生成独立候选，Profile 目录不同即视为不同安装，不能合并。
      // executablePaths 与 executablePath 同时写：前者供回退探测，后者标明本次确证的路径。
      installations.push({
        browser: /chromium/i.test(commandLine) ? "chromium" : "chrome",
        userDataDir,
        executablePaths: [executablePath],
        executablePath,
        ...(passwordStore ? { passwordStore } : {}),
      });
    }
    // [失败路径] 已经拿到 --user-data-dir 就绝不再走 fallback，否则同一实例会产出两条互斥的候选。
    // 子进程在这里被丢弃，即使它带了 --user-data-dir，避免把临时目录当成用户 Profile。
    // 先判显式目录、后判 fallback，保证命令行直给的信息优先于按可执行文件反查。
    if (userDataDirFound || !isChromeMainProcessCommandLine(commandLine)) continue;
    // 匹配的是可执行文件而不是 Profile 目录：Linux 常规启动没有 --user-data-dir，只能靠二进制路径反查通道。
    // find 取第一个命中项，依赖各通道路径表互斥且标准候选内不重复。
    const fallback = fallbackInstallations.find((candidate) =>
      candidate.executablePaths.some((path) => pathsMatch(path, executablePath)),
    );
    if (fallback) {
      // Linux 常规启动不会显式携带 --user-data-dir；仍需把运行进程选择的密钥后端
      // 合并回对应标准 Profile，确保隔离 helper 使用同一个 Libsecret/KWallet backend。
      // 先展开 fallback 再覆盖 executablePath 与 passwordStore：保留其 userDataDir 和其余通道字段，不要在这里重建对象。
      // 未解析到密钥后端时保留 fallback 里的既有值，而不是写成 undefined 把它清空。
      installations.push({
        ...fallback,
        executablePath,
        ...(passwordStore ? { passwordStore } : {}),
      });
    }
  }
  return installations;
}
