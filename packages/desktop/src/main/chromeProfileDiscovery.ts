// 模块职责：必须从 Chrome Local State、企业策略与运行进程线索中解析唯一可导入的 Profile，供桌面端复用登录态。
// 数据流向：安装候选 → Profile 目录枚举 → 可导入性过滤 → 唯一目录选择 → 来源描述返回。
// 失败语义：候选缺失与候选歧义都是结构化失败结果，不向 IPC 边界抛异常。
// 权衡：宁可报歧义也不猜测，避免把错误账号的 Cookie 导入当前工作区。
// INV-01 命令超时上限统一为 3 秒；守住位置：execFileText 的 timeout 选项；改错故障：reg.exe 或进程查询卡死会让设置页加载无限转圈。
// INV-02 只认 Default 与 Profile 加数字两种目录名；守住位置：PROFILE_DIRECTORY_PATTERN 匹配处；改错故障：误收 Guest 与 System 目录会把临时浏览态当成用户账号。
// INV-03 Local State 解析失败必须降级而非终止；守住位置：readProfileDirectoryCandidates 的 try 块；改错故障：Chrome 升级中 JSON 半写会直接报未找到，用户看不到任何候选。
// INV-04 磁盘目录扫描结果必须并入 info_cache 名单；守住位置：readProfileDirectoryCandidates 的 names 集合；改错故障：残留目录被漏掉时，多账户用户只能看到其中一个账号。
// INV-05 安装来源顺序固定为运行进程、Linux 环境变量、企业策略、标准安装；守住位置：discoverChromeProfile 的 installations 拼接；改错故障：顺序反转会让便携版与策略版配置被系统默认安装顶掉。
// INV-06 同一 userDataDir 只保留首次出现的候选；守住位置：dedupeInstallations 的 seen 集合；改错故障：重复候选会重复解析同一目录，并把单来源误判为来源冲突。
// INV-07 导入前必须剔除没有 Cookie 与 LocalStorage 的空 Profile；守住位置：filterImportableProfiles 调用；改错故障：空 Default 会遮蔽同安装的真实账户，导入后仍要求登录。
// INV-08 歧义时返回错误而不是任选其一；守住位置：selectProfileDirectory 的 ambiguous 分支；改错故障：静默选中错误账户会把他人 Cookie 写入当前工作区。
// INV-09 last_used 仅在对应目录仍可导入时采用；守住位置：selectProfileDirectory 的首个判断；改错故障：陈旧的 last_used 会让每次启动都回落到已删除的目录。
// INV-10 所有文件探测失败按不存在处理；守住位置：pathExists 的失败回调；改错故障：权限错误抛到上层会让整轮发现中断，而不是继续尝试下一个安装。
// INV-11 子进程统一 utf8 编码与 2MiB 缓冲上限；守住位置：execFileText 的 execFile 选项；改错故障：输出截断会让策略路径解析到半截字符串，进而拼出非法目录。
// INV-12 子进程必须带 windowsHide 启动；守住位置：execFileText 的 execFile 选项；改错故障：每次发现都弹黑框，桌面端看起来像被恶意程序劫持。
// INV-13 策略路径展开顺序为先花括号变量再百分号变量；守住位置：expandWindowsPolicyPath 的两段替换；改错故障：顺序颠倒会让已展开字符串里的百分号被二次替换。
// INV-14 未识别的变量保持原文而非清空；守住位置：expandWindowsPolicyPath 的替换回调；改错故障：清空后可能拼出根目录路径，把用户主目录当成 userDataDir。
// INV-15 用户级与机器级策略键都要读取；守住位置：readWindowsPolicyUserDataDirs 的 keys 列表；改错故障：漏掉机器级策略时，域管推送的重定向目录完全不可见。
// INV-16 缺失策略键不是错误；守住位置：readWindowsPolicyUserDataDirs 的空失败分支；改错故障：普通用户机器每次启动都走异常路径，日志被噪音淹没。
// INV-17 只返回第一个真实存在的可执行文件；守住位置：resolveFirstExistingPath 的顺序遍历；改错故障：返回不存在的路径会让启动 Chrome 直接失败且提示与实际不符。
// INV-18 发现结果只有成功与两种错误形态；守住位置：ChromeProfileDiscoveryResult 联合类型；改错故障：新增错误码而不更新调用方会让界面落到默认文案。
// INV-19 空候选时返回未找到而不是抛异常；守住位置：discoverChromeProfile 结尾；改错故障：异常逃逸会让设置页白屏，用户无法选择手动指定路径。
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildStandardChromeInstallations,
  parseRunningChromeInstallations,
  type ChromeBrowserKind,
  type ChromeInstallationCandidate,
  type ChromeInstallationPathOptions,
  type LinuxChromePasswordStore,
} from "./chromeInstallationCandidates.js";
import { readRunningChromeProcessCommandLines } from "./chromeExecutableDiscovery.js";

export {
  buildStandardChromeInstallations,
  parseRunningChromeInstallations,
  type ChromeInstallationCandidate,
  type LinuxChromePasswordStore,
} from "./chromeInstallationCandidates.js";
export { resolveChromeExecutablePath } from "./chromeExecutableDiscovery.js";

// 超时语义：3 秒覆盖注册表查询与进程命令行读取，超时即拒绝，避免发现流程无限挂起。
// 权衡：DISCOVERY_COMMAND_TIMEOUT_MS 的 3 秒在高负载机器上可能误杀正常查询，但宁可少一个来源也不让设置页转圈。
// 改动此处须同步 chromeExecutableDiscovery 的同类上限，否则两条路径的等待时间会不一致。
const DISCOVERY_COMMAND_TIMEOUT_MS = 3_000;
// 不变量：只有 Default 与 Profile 加数字被视为用户配置目录，Guest 与 System 一律排除。
// 守住位置：readProfileDirectoryCandidates 的目录枚举；改错会导入临时浏览态，用户重启后登录态全部失效。
// 放宽正则会连带收进快照与访客目录，新增命名规则前先确认 Chrome 实际产物。
const PROFILE_DIRECTORY_PATTERN = /^(?:Default|Profile \d+)$/;

export interface ChromeProfileSource {
  browser: ChromeBrowserKind;
  executablePath?: string;
  passwordStore?: LinuxChromePasswordStore;
  profileDirectory: string;
  profilePath: string;
  userDataDir: string;
}

export type ChromeProfileDiscoveryResult =
  | { success: true; source: ChromeProfileSource }
  | { success: false; error: "chrome_profile_not_found" | "chrome_profile_ambiguous" };

// 结构按最小可用字段裁剪：只声明 profile.info_cache 与 profile.last_used，其余键忽略。
// Local State 是 Chrome 私有格式，字段随版本膨胀，多余字段不能进入类型契约。
// last_used 设为可选，是因为旧版本可能缺失该字段，此时仍需降级到 Default 判断。
interface ChromeLocalState {
  profile?: {
    info_cache?: Record<string, unknown>;
    last_used?: string;
  };
}

export interface ChromeProfileDiscoveryOptions extends ChromeInstallationPathOptions {
  installations?: ChromeInstallationCandidate[];
  processCommandLines?: string[];
}

// 语义：任何 stat 失败都必须折算为 false，包括路径不存在、无权限与瞬时 IO 错误。
// 调用方因此只需判断真假，不必为每种 errno 分支，代价是权限问题会被静默吞掉。
// 将来若要区分不可读与不存在，必须新增返回形态，不能在此处抛出。
function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// 资源生命周期：子进程由 execFile 托管，回调触发即结束，不留句柄。
// stdout 走成功回调，stderr 与退出码统一进拒绝路径，调用方只处理一条失败分支。
// 2MiB 缓冲上限会触发拒绝而非静默截断，保证解析到的策略路径完整。
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

// 去重必须按 trim 后的字符串精确比较，不做大小写折叠，保留平台原始语义。
// 空串与纯空白在此被丢弃，避免空 userDataDir 让后续拼接退化到当前目录。
// 顺序即优先级，首次出现的路径保留，调用方拼装顺序直接影响最终选择。
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

// 展开顺序固定：先处理花括号形式的 Chromium 变量，再处理百分号包裹的环境变量。
// 变量名统一转小写查表，使策略文件里的大小写差异不会导致展开失败。
// 匹配不到时原样返回占位符，让上层凭路径不存在自然淘汰，而非拼出错误目录。
function expandWindowsPolicyPath(value: string, options: ChromeProfileDiscoveryOptions): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const variables: Record<string, string> = {
    local_app_data: options.localAppData ?? env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"),
    profile: env.USERPROFILE ?? homeDir,
    program_files: options.programFiles ?? env.PROGRAMFILES ?? "C:\\Program Files",
  };
  return value
    .replace(/\$\{([^}]+)\}/g, (match, name: string) => variables[name.toLowerCase()] ?? match)
    .replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? env[name.toUpperCase()] ?? match);
}

// 并发语义：两个注册表键串行查询，任一失败只跳过该键，不打断另一键。
// 结果经 uniquePaths 收敛，用户级与机器级指向同一目录时只保留一份。
// 读取失败一律视为无策略，因为普通终端用户本就不会写这两处键。
async function readWindowsPolicyUserDataDirs(
  options: ChromeProfileDiscoveryOptions,
): Promise<string[]> {
  const keys = [
    "HKCU\\Software\\Policies\\Google\\Chrome",
    "HKLM\\Software\\Policies\\Google\\Chrome",
  ];
  const values: string[] = [];
  for (const key of keys) {
    try {
      const output = await execFileText("reg.exe", ["query", key, "/v", "UserDataDir"]);
      const value = output.match(/UserDataDir\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1]?.trim();
      if (value) values.push(expandWindowsPolicyPath(value, options));
    } catch {
      // 没有企业策略是正常状态。
    }
  }
  return uniquePaths(values);
}

// 按数组顺序返回首个存在项，顺序即优先级，不在此处做任何排序。
// 全部不存在时返回 undefined 而非抛错，让上层继续尝试下一个安装来源。
async function resolveFirstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return undefined;
}

// Local State 读取与 JSON 解析共用同一 try，损坏文件只清空状态不终止流程。
// 目录枚举失败直接返回空列表，因为连目录都读不到时没必要再探测子路径。
// info_cache 名单与磁盘扫描取并集，既覆盖已注册账户，也覆盖尚未写入索引的残留目录。
// 每个名字都要再探测存在性，剔除 info_cache 中的陈旧条目，防止引用已删除目录。
// 排序按 localeCompare 稳定输出，使同样输入在不同机器上得到一致的 Profile 顺序。
async function readProfileDirectoryCandidates(userDataDir: string): Promise<{
  lastUsed?: string;
  profiles: string[];
}> {
  let localState: ChromeLocalState = {};
  try {
    localState = JSON.parse(
      await readFile(join(userDataDir, "Local State"), "utf8"),
    ) as ChromeLocalState;
  } catch {
    // Local State 损坏或暂时不可读时，仍允许通过目录 fallback 发现 Profile。
  }

  const names = new Set<string>(Object.keys(localState.profile?.info_cache ?? {}));
  try {
    for (const entry of await readdir(userDataDir, { withFileTypes: true })) {
      if (entry.isDirectory() && PROFILE_DIRECTORY_PATTERN.test(entry.name)) names.add(entry.name);
    }
  } catch {
    return { profiles: [] };
  }

  const profiles: string[] = [];
  for (const name of names) {
    if (await pathExists(join(userDataDir, name))) profiles.push(name);
  }
  return {
    lastUsed: localState.profile?.last_used,
    profiles: profiles.sort((a, b) => a.localeCompare(b)),
  };
}

// 判定依据必须只看三处：Network 下的 Cookies、根目录 Cookies、Local Storage 的 leveldb 目录。
// 任一存在即可导入，因为新版 Chrome 把 Cookie 迁到 Network 子目录，旧版仍在根目录。
// 三项都缺失说明该 Profile 从未登录，继续导入只会得到空登录态。
async function hasImportableProfileData(profilePath: string): Promise<boolean> {
  const candidates = [
    join(profilePath, "Network", "Cookies"),
    join(profilePath, "Cookies"),
    join(profilePath, "Local Storage", "leveldb"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

// 并发语义：所有 Profile 并行探测，Promise.all 保证结果与输入顺序一一对应。
// 过滤只削减列表、不改变相对顺序，后续选择逻辑才能依赖稳定次序。
// 探测只走路径存在性、不读文件内容，代价是无 Cookie 内容的空壳目录也会被放行。
async function filterImportableProfiles(
  userDataDir: string,
  profiles: string[],
): Promise<string[]> {
  const availability = await Promise.all(
    profiles.map(async (profile) => ({
      profile,
      importable: await hasImportableProfileData(join(userDataDir, profile)),
    })),
  );
  return availability.filter(({ importable }) => importable).map(({ profile }) => profile);
}

// 优先级固定：last_used 仍可用则优先，其次 Default，再次唯一候选，最后报歧义。
// ambiguous 仅在候选多于一个且既无 last_used 命中又无 Default 时为真，单候选不算歧义。
// 返回结构用可选字段表达未选中，而不是哨兵字符串，避免与真实目录名冲突。
// 顺序不可调换：把 Default 提到 last_used 之前，会让多账户用户被固定到非默认账户。
function selectProfileDirectory(
  profiles: string[],
  lastUsed?: string,
): { profileDirectory?: string; ambiguous: boolean } {
  if (lastUsed && profiles.includes(lastUsed)) {
    return { profileDirectory: lastUsed, ambiguous: false };
  }
  if (profiles.includes("Default")) {
    return { profileDirectory: "Default", ambiguous: false };
  }
  if (profiles.length === 1) {
    return { profileDirectory: profiles[0], ambiguous: false };
  }
  return { ambiguous: profiles.length > 1 };
}

// 以 trim 后的 userDataDir 作为唯一键，保留首次出现的安装来源及其浏览器元数据。
// 合并时用展开运算符复制候选，避免就地修改调用方传入的对象。
// 空 userDataDir 被丢弃，因为空串会让后续 join 退化为当前工作目录。
function dedupeInstallations(
  installations: ChromeInstallationCandidate[],
): ChromeInstallationCandidate[] {
  const result: ChromeInstallationCandidate[] = [];
  const seen = new Set<string>();
  for (const installation of installations) {
    const userDataDir = installation.userDataDir.trim();
    if (!userDataDir || seen.has(userDataDir)) continue;
    seen.add(userDataDir);
    result.push({ ...installation, userDataDir });
  }
  return result;
}

// 来源组装顺序即优先级：运行中进程、Linux 环境变量、Windows 策略、标准安装。
// 传入 installations 时跳过进程探测与策略读取，让测试与调用方完全掌控输入。
// 循环遇到首个可用安装即返回，后续来源不再解析，因此顺序决定最终用户账户。
export async function discoverChromeProfile(
  options: ChromeProfileDiscoveryOptions = {},
): Promise<ChromeProfileDiscoveryResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const standardInstallations = options.installations ?? buildStandardChromeInstallations(options);
  const environmentInstallations =
    !options.installations && platform === "linux" && env.CHROME_USER_DATA_DIR
      ? [
          {
            browser: "chrome" as const,
            userDataDir: env.CHROME_USER_DATA_DIR,
            executablePaths: standardInstallations[0]?.executablePaths ?? [],
          },
        ]
      : [];
  const commandLines =
    options.processCommandLines ??
    (options.installations ? [] : await readRunningChromeProcessCommandLines(platform));
  const runningInstallations = parseRunningChromeInstallations(
    commandLines,
    platform === "linux" ? [...environmentInstallations, ...standardInstallations] : [],
  );
  const policyInstallations =
    platform === "win32" && !options.installations
      ? (await readWindowsPolicyUserDataDirs(options)).map((userDataDir) => ({
          browser: "chrome" as const,
          userDataDir,
          executablePaths: standardInstallations[0]?.executablePaths ?? [],
        }))
      : [];
  const installations = dedupeInstallations([
    ...runningInstallations,
    ...environmentInstallations,
    ...policyInstallations,
    ...standardInstallations,
  ]);

  for (const installation of installations) {
    if (!(await pathExists(installation.userDataDir))) continue;
    const { lastUsed, profiles } = await readProfileDirectoryCandidates(installation.userDataDir);
    // 过去只要标准 Default 目录存在就立即返回，即使里面没有 Cookie/LocalStorage，
    // 从而遮蔽同安装的真实 Profile 以及后续 Snap/Flatpak 候选。发现阶段先过滤空 Profile。
    const importableProfiles = await filterImportableProfiles(installation.userDataDir, profiles);
    // 此处 continue 而不是返回失败，是为了让空 Profile 的安装不阻断后续来源。
    // 若改成 break，多安装共存的机器上可见账户数会从多个降到零。
    if (importableProfiles.length === 0) continue;
    const selected = selectProfileDirectory(importableProfiles, lastUsed);
    // 歧义是终态：不能再尝试后续安装，因为用户面对的是同一台机器上的多账户选择。
    // 返回前不写任何文件，保证发现流程纯读取，可安全重复执行。
    // 错误码与类型联合保持一致，调用方据此引导用户手动指定 Profile。
    if (selected.ambiguous) return { success: false, error: "chrome_profile_ambiguous" };
    if (!selected.profileDirectory) continue;
    const executablePath =
      installation.executablePath ?? (await resolveFirstExistingPath(installation.executablePaths));
    return {
      success: true,
      source: {
        browser: installation.browser,
        executablePath,
        passwordStore: installation.passwordStore,
        profileDirectory: selected.profileDirectory,
        profilePath: join(installation.userDataDir, selected.profileDirectory),
        userDataDir: installation.userDataDir,
      },
    };
  }
  // 兜底分支只在所有安装都不可用时到达，含目录缺失与全部 Profile 不可导入两种情形。
  // 此处返回失败对象而非抛异常，使 IPC 边界只需序列化结果，不必额外包装错误栈。
  return { success: false, error: "chrome_profile_not_found" };
}
