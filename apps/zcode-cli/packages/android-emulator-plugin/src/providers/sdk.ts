/**
 * Android SDK / JDK 定位与环境构造能力。
 *
 * 职责边界：解析 SDK 根目录、查找 adb/emulator/sdkmanager 等工具、构造子进程环境与 JAVA_HOME；不执行构建。
 * 输入输出：多数函数返回路径或 undefined，requireTool 在缺失时抛错；androidEnv 返回可直接传给 run() 的环境覆盖。
 * 副作用：会执行 which/where、macOS java_home 等探测命令；不写盘、不修改 process.env。
 * 失败语义：查找类函数用 undefined 表示「没找到」，由调用方决定报错或降级；仅 requireTool 主动抛错。
 * 跨平台：候选路径同时覆盖 macOS、Windows（含 LOCALAPPDATA/Program Files）与 Linux 常见安装位置；
 * Windows 上可执行文件需尝试 .exe/.bat/.cmd 后缀。
 */
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brief, ok, run } from "../lib/run.js";
import { javaMajorVersion } from "./config.js";

/**
 * 各工具在 SDK 根下的相对候选路径（按优先级排列）。
 * 覆盖 cmdline-tools/latest、cmdline-tools 旧布局与 legacy tools 目录，提高对旧版 SDK 的兼容性。
 */
const TOOL_PATHS: Record<string, string[]> = {
  adb: ["platform-tools/adb"],
  emulator: ["emulator/emulator"],
  sdkmanager: [
    "cmdline-tools/latest/bin/sdkmanager",
    "cmdline-tools/bin/sdkmanager",
    "tools/bin/sdkmanager",
  ],
  avdmanager: [
    "cmdline-tools/latest/bin/avdmanager",
    "cmdline-tools/bin/avdmanager",
    "tools/bin/avdmanager",
  ],
  apkanalyzer: ["cmdline-tools/latest/bin/apkanalyzer", "cmdline-tools/bin/apkanalyzer"],
};

/**
 * 单个工具探测结果：path 为命中的可执行文件（未命中时缺失），detail 为版本输出或错误摘要。
 */
type ToolCheck = {
  name: string;
  path?: string;
  ok: boolean;
  detail: string;
};

/**
 * 汇总 SDK 根候选路径。
 *
 * 优先级：显式环境变量（ANDROID_PLUGIN_SDK_PATH → ANDROID_HOME → ANDROID_SDK_ROOT）→ 各平台默认安装位置。
 * 只做路径拼接与去重，不检查是否存在（由 sdkRoot 逐个探测）。
 * 说明：默认值同时列出 macOS 的 ~/Library/Android/sdk、Windows 的 %LOCALAPPDATA%\Android\Sdk 与 Linux 常见目录，
 * 使用户未设置环境变量时也能自动发现 SDK。
 */
function sdkRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = [env.ANDROID_PLUGIN_SDK_PATH, env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (item): item is string => Boolean(item && item.trim()),
  );
  return unique([
    ...configured,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    ...windowsSdkRoots(env),
    "/opt/android-sdk",
    "/usr/local/share/android-sdk",
    "/opt/homebrew/share/android-commandlinetools",
  ]);
}

/**
 * 返回第一个真实存在的 SDK 根目录。
 * 按 sdkRoots 的优先级顺序探测，找不到返回 undefined；无副作用（仅 access 检查）。
 */
export async function sdkRoot(): Promise<string | undefined> {
  for (const item of sdkRoots()) {
    if (await exists(item)) return item;
  }
  return undefined;
}

/**
 * 查找工具可执行文件。
 *
 * 先查 PATH（which/where），找到用户显式安装/优先版本就采用；否则按 TOOL_PATHS 在 SDK 根下探测。
 * 副作用：执行系统 which/where 命令；返回 undefined 表示未找到，不抛错。
 * 跨平台：SDK 内候选路径会经 executableCandidates 补充 Windows 后缀。
 */
export async function findTool(name: string): Promise<string | undefined> {
  const viaPath = await which(name);
  if (viaPath) return viaPath;
  const rels = TOOL_PATHS[name] ?? [];
  for (const root of sdkRoots()) {
    for (const rel of rels) {
      for (const candidate of executableCandidates(path.join(root, rel))) {
        if (await exists(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/**
 * 查找工具，找不到时抛错并指引用户运行 android_preflight。
 * 调用方无法继续执行时使用；若允许降级应改用 findTool。
 */
export async function requireTool(name: string): Promise<string> {
  const found = await findTool(name);
  if (found) return found;
  throw new Error(`Missing Android tool: ${name}. Run android_preflight for setup details.`);
}

/**
 * 探测工具是否可用并返回版本摘要，供 preflight 使用。
 *
 * 找不到工具时返回 ok=false 且不执行命令；找到后运行 versionArgs（默认 --version），
 * 以退出码判定可用性，detail 取输出摘要（为空时回退路径）。超时 10 秒，避免卡住预检。
 */
export async function checkTool(
  name: string,
  versionArgs: string[] = ["--version"],
): Promise<ToolCheck> {
  const found = await findTool(name);
  if (!found) {
    return {
      name,
      ok: false,
      detail: "not found",
    };
  }
  const out = await run([found, ...versionArgs], { timeout: 10_000, env: await androidEnv() });
  return {
    name,
    path: found,
    ok: ok(out),
    detail: ok(out) ? brief(out, 1000) || found : brief(out, 1000),
  };
}

/**
 * 构造执行 Android 工具所需的环境变量覆盖。
 *
 * 输出 JAVA_HOME/sdk 变量以及把 java、platform-tools、emulator、cmdline-tools 等目录前置到 PATH，
 * 保证 Gradle 与 adb 调用能找到配套工具。
 * 副作用：无（只读 sdkRoot/javaHome/process.env）；缺失 SDK 时对应字段为 undefined，仍保留原 PATH。
 * 跨平台：PATH 用 path.delimiter（Windows 为 ;，其余为 :）拼接。
 */
export async function androidEnv(): Promise<Record<string, string | undefined>> {
  const root = await sdkRoot();
  const java = await javaHome();
  const paths = [
    java ? path.join(java, "bin") : undefined,
    root ? path.join(root, "platform-tools") : undefined,
    root ? path.join(root, "emulator") : undefined,
    root ? path.join(root, "cmdline-tools", "latest", "bin") : undefined,
    root ? path.join(root, "cmdline-tools", "bin") : undefined,
    root ? path.join(root, "tools", "bin") : undefined,
    process.env.PATH,
  ].filter((item): item is string => Boolean(item));
  return {
    JAVA_HOME: java,
    ANDROID_HOME: root,
    ANDROID_SDK_ROOT: root,
    PATH: paths.join(path.delimiter),
  };
}

/**
 * 定位可用的 JDK 根目录。
 *
 * 顺序：显式 JAVA_HOME（必须含 bin/java）→ macOS 的 java_home -v <major> → 各平台约定安装目录。
 * 副作用：macOS 上执行 /usr/libexec/java_home，Windows 上读取 Program Files 下的 jdk 目录。
 * 失败语义：找不到返回 undefined，由调用方决定是否提示；不抛错，因为 Java 缺失应体现为预检项失败。
 * 返回口径：JDK 的 Home 目录（可拼 bin/java），而不是 java 可执行文件本身。
 */
export async function javaHome(): Promise<string | undefined> {
  const version = javaMajorVersion();
  const configured = process.env.JAVA_HOME?.trim();
  if (configured && (await exists(path.join(configured, "bin", javaBin())))) return configured;

  if (process.platform === "darwin") {
    const home = await run(["/usr/libexec/java_home", "-v", version], { timeout: 5000 });
    if (ok(home)) {
      const value = home.stdout.trim();
      if (value) return value;
    }
  }

  for (const candidate of await javaHomes(version)) {
    if (await exists(path.join(candidate, "bin", javaBin()))) return candidate;
  }
  return undefined;
}

/**
 * 通过 which（Windows 为 where）在 PATH 中查找命令。
 * 取输出第一行作为结果；命令失败或输出为空返回 undefined，不抛错。
 */
async function which(name: string): Promise<string | undefined> {
  const out = await run(process.platform === "win32" ? ["where", name] : ["which", name], {
    timeout: 5000,
  });
  if (!ok(out)) return undefined;
  const found = out.stdout.trim().split("\n")[0];
  return found || undefined;
}

/**
 * 判断路径是否可访问；不存在或无权限均返回 false。
 */
async function exists(file: string): Promise<boolean> {
  return access(file)
    .then(() => true)
    .catch(() => false);
}

/**
 * 路径去重并规范化为绝对路径，保留首次出现顺序。
 * 用 resolve 归一化，避免同一目录因写法差异（相对/绝对、末尾分隔符）被判为不同候选。
 */
function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const resolved = path.resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/**
 * 生成可执行文件候选路径。
 * 非 Windows 只有原始路径；Windows 上无扩展名的工具需依次尝试 .exe/.bat/.cmd 与无后缀，
 * 因为 SDK 中 adb 有 adb.exe，而 sdkmanager 是 sdkmanager.bat。
 */
function executableCandidates(base: string): string[] {
  if (process.platform !== "win32") return [base];
  const ext = path.extname(base);
  if (ext) return [base];
  return [".exe", ".bat", ".cmd", ""].map((suffix) => `${base}${suffix}`);
}

/**
 * 返回当前平台的 java 可执行文件名（Windows 为 java.exe）。
 */
function javaBin(): string {
  return process.platform === "win32" ? "java.exe" : "java";
}

/**
 * Windows 专属 SDK 默认路径：优先 LOCALAPPDATA，其次用户目录下的 AppData/Local。
 * 后者用于 LOCALAPPDATA 未设置（服务/受限环境）时的兜底。
 */
function windowsSdkRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    path.join(os.homedir(), "AppData", "Local", "Android", "Sdk"),
  ].filter((item): item is string => Boolean(item));
}

/**
 * 汇总常见 JDK 安装目录。
 *
 * macOS 覆盖 Homebrew 与系统 JavaVirtualMachines；Windows 覆盖 Eclipse Adoptium 与 Oracle Java，
 * 并按主版本前缀匹配实际安装的子目录（版本号常带补丁后缀，如 jdk-17.0.9）。
 * 非 Windows 直接返回固定候选，避免无意义的目录扫描。
 */
async function javaHomes(version: string): Promise<string[]> {
  const fixed = [
    `/opt/homebrew/opt/openjdk@${version}/libexec/openjdk.jdk/Contents/Home`,
    `/Library/Java/JavaVirtualMachines/openjdk-${version}.jdk/Contents/Home`,
    path.join(process.env.ProgramFiles || "", "Eclipse Adoptium", `jdk-${version}`),
    path.join(process.env.ProgramFiles || "", "Java", `jdk-${version}`),
  ].filter(Boolean);
  if (process.platform !== "win32") return fixed;
  const pattern = new RegExp(`^jdk-${escapeRegex(version)}`, "i");
  return unique([
    ...fixed,
    ...(await childDirs(path.join(process.env.ProgramFiles || "", "Eclipse Adoptium"), pattern)),
    ...(await childDirs(path.join(process.env.ProgramFiles || "", "Java"), pattern)),
  ]);
}

/**
 * 列出 root 下名称匹配 pattern 的子目录。
 * 目录不存在或读取失败返回空数组，保证 JDK 探测不因缺少安装目录而抛错。
 */
async function childDirs(root: string, pattern: RegExp): Promise<string[]> {
  if (!root) return [];
  const items = await readdir(root, { withFileTypes: true }).catch(() => []);
  return items
    .filter((item) => item.isDirectory() && pattern.test(item.name))
    .map((item) => path.join(root, item.name));
}

/**
 * 转义正则元字符，把 Java 主版本号（可能含点号）安全嵌入匹配模式。
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
