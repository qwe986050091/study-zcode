// 解析宿主上可用的 Chrome/Chromium 可执行文件：必须按环境变量、运行进程、系统注册信息、标准安装目录分层探测。
// 所有候选统一经过 isChromeBrowserExecutable 白名单与可执行性校验，任一来源失败都不阻断整体导入。
// 返回值是首个命中的绝对路径，找不到时回落 null，由上层决定禁用或提示。
// 层级顺序即优先级，调整顺序会改变用户实际启动的浏览器版本。
// INV-01 [权衡] 探测总预算受 DISCOVERY_COMMAND_TIMEOUT_MS 约束，超时即拒绝；守住位置：execFileText 的 timeout 选项；改错故障：系统命令挂起时导入流程被无限拖住，用户看到启动卡死。
// INV-02 [资源] 子进程输出上限 2MB 且 windowsHide 为真，避免弹出控制台窗口与内存失控；守住位置：execFileText 的 maxBuffer 与 windowsHide；改错故障：进程列表过长时 stdout 被截断报错或瞬间闪窗。
// INV-03 [失败路径] 命令以非零码退出时 Promise 必须 reject 而非返回空串；守住位置：execFileText 回调的 error 分支；改错故障：把权限拒绝误判成没有 Chrome，用户重装也无效。
// INV-04 [失败路径] 非 darwin、linux、win32 平台直接返回空数组且不抛异常；守住位置：readRunningChromeProcessCommandLines 的平台集合判断；改错故障：在其他类 Unix 平台启动即崩，导入页完全打不开。
// INV-05 [资源] 进程枚举只捕获 stdout 并按行切分过滤空行，不保留 stderr；守住位置：win32 与 ps 两条返回分支；改错故障：stderr 混入命令文本，解析出并不存在的可执行路径。
// INV-06 [失败路径] 进程枚举异常被吞掉并返回空数组，后续注册信息与标准目录仍可继续；守住位置：readRunningChromeProcessCommandLines 的 catch；改错故障：组策略禁用 WMI 后整条发现链短路，Chrome 明明装好却提示未安装。
// INV-07 [权衡] 可执行判定要求 stat 成功且 isFile 为真，符号链接需先解析到真实文件；守住位置：isExecutableFile 的前两个判断；改错故障：把目录或断链当成浏览器，启动时 spawn ENOENT。
// INV-08 [权衡] 非 Windows 平台额外校验 X_OK 权限位，Windows 依赖扩展名而非权限位；守住位置：isExecutableFile 的平台分支；改错故障：Linux 上选中无执行权限的文件，点击后静默失败。
// INV-09 [失败路径] stat 或 access 任一抛错都折算为不可执行，而不是向上冒泡；守住位置：isExecutableFile 的 catch；改错故障：一条坏候选让整个解析抛出，用户看不到任何候选结果。
// INV-10 [事务] 候选集合先去重再按原始声明顺序逐个校验，首个通过者即最终答案；守住位置：resolveFirstExecutable 的循环；改错故障：并行校验打乱优先级，用户被切到 Canary 等非预期版本。
// INV-11 [并发] 去重以 trim 后的字符串为键并保留首次出现位置；守住位置：uniquePaths 的 seen 集合；改错故障：同一路径带空格重复入列，探测浪费且低优先项被后写值覆盖。
// INV-12 [事务] 空白候选在入列前即被丢弃，不参与后续白名单校验；守住位置：uniquePaths 的 normalized 判空；改错故障：空串进入路径拼接，得到相对当前目录的假路径。
// INV-13 [失败路径] 带引号的环境变量值必须成对剥除引号，单侧引号原样保留；守住位置：stripMatchingQuotes 的首尾判断；改错故障：用户配置带引号的 CHROME_PATH 永远无法命中。
// INV-14 [失败路径] env 包装命令要跳过前置选项与 KEY=VALUE 赋值，取第一个真实可执行名；守住位置：desktopExecutableToken 的 env 分支；改错故障：把 -u 或 DISPLAY=:0 当成浏览器路径，探测必然落空。
// INV-15 [权衡] 无斜杠的裸命令名才允许查 PATH，含路径分隔符的非绝对路径直接放弃；守住位置：resolvePathCommand 的两个早退分支；改错故障：把相对路径拼进每个 PATH 目录，产生十几条无效候选。
// INV-16 [资源] Spotlight 结果只扫描 app 包内 Contents/MacOS 一层，且单个陈旧记录失败不影响其他包；守住位置：readMacRegisteredChromeExecutablePaths 的内层 catch；改错故障：一个已删除应用让整批 macOS 候选归零。
// INV-17 [失败路径] mdfind 不可用或索引关闭时返回空数组，交由运行进程与标准目录兜底；守住位置：readMacRegisteredChromeExecutablePaths 的外层 catch；改错故障：禁用 Spotlight 的用户被直接判定未安装 Chrome。
// INV-18 [资源] XDG 数据目录逐个尝试，单个 applications 目录缺失或单个 desktop 条目损坏都只跳过自身；守住位置：readLinuxDesktopChromeExecutablePaths 的双层 catch；改错故障：一个无权限目录阻断整轮 Linux 发现。
// INV-19 [事务] 注入的 registeredExecutablePaths 完全替代系统查询，保证测试不依赖宿主环境；守住位置：readRegisteredChromeExecutablePaths 的首个分支；改错故障：单测在 CI 上读到真实注册表，结果随机器漂移。
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  buildStandardChromeInstallations,
  isChromeBrowserExecutable,
  parseRunningChromeExecutablePaths,
  type ChromeInstallationCandidate,
  type ChromeInstallationPathOptions,
} from "./chromeInstallationCandidates.js";

// [权衡] 3 秒是探测类命令的统一上限：太长会拖慢首屏，太短会误杀冷启动的 mdfind 与 powershell。
// [失败路径] 调大该常量不会提升成功率，只会把不可用环境的等待时间等比放大。
// [资源] 所有外部命令必须共享这一个预算，新增探测来源时不得各自定义超时。
const DISCOVERY_COMMAND_TIMEOUT_MS = 3_000;
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>([
  "darwin",
  "linux",
  "win32",
]);

// [事务] installations 与 processCommandLines 一旦注入即视为快照，运行期不再触发系统枚举。
// [失败路径] registeredExecutablePaths 注入后完全跳过 mdfind 与 desktop 文件扫描，测试断言才可复现。
// [权衡] 注入字段仅服务于可测试性，生产调用方必须保持为空以走真实发现链。
export interface ChromeExecutableDiscoveryOptions extends ChromeInstallationPathOptions {
  installations?: ChromeInstallationCandidate[];
  processCommandLines?: string[];
  /** 测试可注入已由操作系统注册表/索引解析出的可执行文件，避免依赖宿主环境。 */
  registeredExecutablePaths?: string[];
}

// [资源] 子进程句柄在回调返回时即释放，调用方无需也无法取消，超时由 execFile 内部终结。
// [失败路径] 只消费 stdout，stderr 被丢弃以免污染待解析的路径列表。
// [权衡] maxBuffer 取 2MB 覆盖大型进程表，超出会以 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 拒绝。
// [事务] 参数数组直传不做 shell 拼接，避免引号与空格改变命令语义。
function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: DISCOVERY_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// [并发] 顺序遍历而非并发，首次出现的索引决定最终优先级。
// [事务] 去重键是 trim 后的原字符串，不做大小写归一化以保持跨平台差异可观测。
// [失败路径] undefined 与空白输入被静默跳过，不产生占位元素。
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

// [失败路径] 平台不在白名单时在枚举前返回空数组，避免调用不存在的命令。
// [事务] 返回的每行是一条完整命令行，解析权交给 parseRunningChromeExecutablePaths。
// [资源] 只读取进程元数据，不 attach 也不结束任何浏览器进程。
export async function readRunningChromeProcessCommandLines(
  platform: NodeJS.Platform,
): Promise<string[]> {
  if (!SUPPORTED_PLATFORMS.has(platform)) return [];
  try {
    // [权衡] Windows 走 CIM 查询并在管道内按进程名过滤，避免把整张进程表拉进内存。
    // [失败路径] 该分支抛错由外层 catch 兜底，不会降级到 ps 分支。
    if (platform === "win32") {
      const script =
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|chromium)\\.exe$' } | ForEach-Object { $_.CommandLine }";
      return (
        await execFileText("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ])
      )
        .split(/\r?\n/)
        .filter(Boolean);
    }
    return (await execFileText("ps", ["-axo", "command="]))
      .split(/\r?\n/)
      .filter((line) => /(?:chrome|chromium)/i.test(line));
  } catch {
    // 进程枚举受系统策略限制时，仍应继续使用注册信息和标准目录，不能阻断导入。
    return [];
  }
}

// [事务] 判定必须分两步：先确认是常规文件，再确认具备执行权限，任一不满足即否。
// [权衡] Windows 没有 POSIX 执行位，跳过 X_OK 校验以免把正常 exe 判死。
// [失败路径] stat 与 access 的异常统一折算为 false，调用方只看到布尔结果。
// [资源] 每次判定都必须重新访问文件系统，不做跨调用缓存，避免安装后不可见。
async function isExecutableFile(
  path: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    if (platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// [事务] 顺序即优先级：先出现的候选先校验，首个通过者立即返回。
// [失败路径] 白名单不通过的候选不触发文件系统访问，减少无效 stat。
// [并发] 逐个 await 而非全量并发，保证返回值与声明顺序一致。
// [权衡] 找不到时返回 null 而不是抛错，缺失 Chrome 属于可预期状态。
async function resolveFirstExecutable(
  paths: Array<string | undefined>,
  platform: NodeJS.Platform,
): Promise<string | null> {
  for (const executablePath of uniquePaths(paths)) {
    if (!isChromeBrowserExecutable(executablePath)) continue;
    if (await isExecutableFile(executablePath, platform)) return executablePath;
  }
  return null;
}

// [失败路径] 只有首尾同种引号才剥除，避免把路径内部的引号吃掉。
// [事务] 剥离前先 trim，防止尾部空格导致引号判断失配。
function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// [权衡] 正则同时支持双引号、单引号与裸词，desktop 文件的三种写法都要覆盖。
// [失败路径] env 前缀后要跳过选项与赋值，否则会把 -u 当成可执行名。
// [事务] 解析不出有效 token 时返回 undefined，由调用方决定跳过。
function desktopExecutableToken(value: string): string | undefined {
  const tokens = [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  if (tokens[0] !== "env") return tokens[0];
  return tokens
    .slice(1)
    .find((token) => !token.startsWith("-") && !token.includes("="));
}

// [事务] 绝对路径直接成为唯一候选，不再叠加 PATH 目录。
// [失败路径] 含分隔符但不是绝对路径的输入返回空，避免拼出相对垃圾路径。
// [资源] PATH 为空时只得到空数组，不会退化为当前工作目录查找。
// [权衡] 每个 PATH 目录都生成一个候选，由后续存在性校验统一淘汰。
function resolvePathCommand(command: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(command)) return [command];
  if (command.includes("/") || command.includes("\\")) return [];
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
}

// [事务] 一次 mdfind 查询覆盖全部 bundle id，减少子进程次数。
// [资源] 只扫描包内 Contents/MacOS 一层，不递归整个 app 包。
// [失败路径] 内层异常只跳过当前 app，外层异常返回空数组等待兜底。
async function readMacRegisteredChromeExecutablePaths(): Promise<string[]> {
  const bundleIds = [
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.dev",
    "com.google.Chrome.canary",
    "com.google.Chrome.forTesting",
    "org.chromium.Chromium",
  ];
  try {
    const output = await execFileText("mdfind", [
      bundleIds
        .map((bundleId) => `kMDItemCFBundleIdentifier == '${bundleId}'`)
        .join(" || "),
    ]);
    const executablePaths: string[] = [];
    for (const appPath of output.split(/\r?\n/).filter(Boolean)) {
      try {
        const executableDirectory = join(appPath, "Contents", "MacOS");
        for (const entry of await readdir(executableDirectory, {
          withFileTypes: true,
        })) {
          if (
            (entry.isFile() || entry.isSymbolicLink()) &&
            isChromeBrowserExecutable(entry.name)
          ) {
            executablePaths.push(join(executableDirectory, entry.name));
          }
        }
      } catch {
        // Spotlight 索引可能含已移除应用；忽略陈旧记录并继续检查其他候选。
      }
    }
    return uniquePaths(executablePaths);
  } catch {
    // Spotlight 被禁用或受系统策略限制时，仍会继续使用运行进程和标准目录。
    return [];
  }
}

// [事务] XDG_DATA_HOME 优先于 XDG_DATA_DIRS，用户级安装因此排在系统级之前。
// [失败路径] 非 desktop 扩展名与非 Chrome 相关的条目直接跳过，不解析命令。
// [资源] TryExec 与 Exec 都可能出现，逐行提取后交给 PATH 解析。
async function readLinuxDesktopChromeExecutablePaths(
  options: ChromeExecutableDiscoveryOptions,
): Promise<string[]> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const dataDirectories = uniquePaths([
    env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"),
    ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
  ]);
  const executablePaths: string[] = [];
  for (const dataDirectory of dataDirectories) {
    const applicationsDirectory = join(dataDirectory, "applications");
    try {
      for (const entry of await readdir(applicationsDirectory, {
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !entry.name.endsWith(".desktop")) continue;
        try {
          const source = await readFile(
            join(applicationsDirectory, entry.name),
            "utf8",
          );
          if (!/(?:chrome|chromium)/i.test(source)) continue;
          for (const line of source.split(/\r?\n/)) {
            const value = line.match(/^(?:TryExec|Exec)=(.+)$/)?.[1];
            const command = value ? desktopExecutableToken(value) : undefined;
            if (command)
              executablePaths.push(...resolvePathCommand(command, env));
          }
        } catch {
          // 单个 desktop entry 损坏或无权限不应阻断其他已注册应用发现。
        }
      }
    } catch {
      // 某个 XDG applications 目录不存在是正常状态。
    }
  }
  return uniquePaths(executablePaths);
}

// [权衡] 固定名称清单覆盖发行版差异，新增发行版命名需在此处补齐。
// [事务] 结果经 uniquePaths 去重，同一目录下的多个别名只保留首个。
function buildLinuxPathChromeExecutablePaths(env: NodeJS.ProcessEnv): string[] {
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "google-chrome-beta",
    "google-chrome-unstable",
    "google-chrome-canary",
    "google-chrome-for-testing",
    "chromium",
    "chromium-browser",
    "com.google.Chrome",
    "org.chromium.Chromium",
  ];
  return uniquePaths(names.flatMap((name) => resolvePathCommand(name, env)));
}

// [事务] 注入路径存在时必须整体短路，系统注册信息不参与本次解析。
// [失败路径] 未支持的平台返回空数组，调用方仍需继续尝试标准目录。
// [权衡] darwin 与 linux 分支互斥，不存在跨平台回退。
async function readRegisteredChromeExecutablePaths(
  options: ChromeExecutableDiscoveryOptions,
  platform: NodeJS.Platform,
): Promise<string[]> {
  if (options.registeredExecutablePaths)
    return options.registeredExecutablePaths;
  if (platform === "darwin") return readMacRegisteredChromeExecutablePaths();
  if (platform === "linux")
    return readLinuxDesktopChromeExecutablePaths(options);
  return [];
}

// [事务] 解析分三层：直接线索、系统注册信息、标准安装目录，命中即返回不再下探。
// [并发] 注入 installations 时跳过进程枚举，保证测试可确定性复现。
// [失败路径] 三层全部未命中返回 null，调用方据此提示用户手动指定。
export async function resolveChromeExecutablePath(
  options: ChromeExecutableDiscoveryOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const commandLines =
    options.processCommandLines ??
    (options.installations
      ? []
      : await readRunningChromeProcessCommandLines(platform));
  const directlyDiscovered = await resolveFirstExecutable(
    [
      stripMatchingQuotes(env.CHROME_PATH ?? ""),
      stripMatchingQuotes(env.CHROME_EXECUTABLE ?? ""),
      ...parseRunningChromeExecutablePaths(commandLines),
    ],
    platform,
  );
  // [事务] 环境变量与运行进程的命令行必须优先级最高，代表用户当下的明确选择。
  // [失败路径] 该层命中即短路，后续注册信息与标准目录不再执行。
  if (directlyDiscovered) return directlyDiscovered;

  const registered = await resolveFirstExecutable(
    await readRegisteredChromeExecutablePaths(options, platform),
    platform,
  );
  // [事务] 注册信息代表系统已安装事实，优先于按约定猜测的标准目录。
  // [权衡] 此处短路保证 Spotlight 与 desktop 记录的版本不被标准目录覆盖。
  if (registered) return registered;

  // [事务] 标准安装目录只在前两层失败后构建，避免无谓的目录扫描。
  // [失败路径] 最后一层的候选顺序由 buildStandardChromeInstallations 决定，此处不再重排。
  const installations =
    options.installations ?? buildStandardChromeInstallations(options);
  return resolveFirstExecutable(
    [
      ...(platform === "linux" ? buildLinuxPathChromeExecutablePaths(env) : []),
      ...installations.flatMap((installation) => [
        installation.executablePath,
        ...installation.executablePaths,
      ]),
    ],
    platform,
  );
}
