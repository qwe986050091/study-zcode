// 子代理存储路径解析：统一计算用户级/工作区级 agent 目录与状态文件位置。
// 路径解析优先读 CLI 配置（storage.dir），未配置时回落到 ~/.zcode；
// subagentStorage 只做无缓存纯计算：磁盘位置由路径推导得出，不在模块级缓存，进程间与测试才能复用同一套口径。
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// 仅识别「~/」前缀（不处理裸「~」与 Windows 风格 ~\），与 CLI 配置书写约定保持一致。
const HOME_PREFIX = "~/";

// homeDir 仅供测试覆盖，生产路径应走环境变量与 os.homedir()，避免把用户目录硬编码进服务。
export interface SubagentStorageOptions {
  homeDir?: string;
}

// 优先级：显式 options.homeDir → HOME → USERPROFILE → os.homedir()。
// 先 trim 再判空，避免空白环境变量被当成有效目录；
// 逐级回落保证 Windows（USERPROFILE）与类 Unix（HOME）行为一致。
export function resolveUserHomeDir(options?: SubagentStorageOptions): string {
  // 显式 homeDir 优先级最高：测试靠它完全摆脱 HOME/USERPROFILE 的机器差异，生产调用不应传它。
  if (options?.homeDir && options.homeDir.trim().length > 0) {
    return options.homeDir;
  }
  // 先 HOME 后 USERPROFILE：两个变量可能指向不同目录，顺序对调会让 Windows 与类 Unix 解析出不同 home。
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  // 两者都为空才落到 os.homedir()：它是最后兜底，保证函数永远不会返回空串让 join 拼出相对路径。
  return envHome && envHome.length > 0 ? envHome : homedir();
}

// 用户级 agent 目录固定挂在存储根下的 agents/，与工作区目录结构对称。
export async function resolveUserSubagentRoot(options?: SubagentStorageOptions): Promise<string> {
  // 用户级 agent 目录挂在存储根 agents/ 下：storage.dir 换根时它会跟着走，不能写死 ~/.zcode。
  return join(await resolveZCodeStorageRoot(options), "agents");
}

// 工作区级目录不读配置：它必须落在 workspacePath 内，才能随仓库被提交或按目录隔离；
// 使用 path.join 而非字符串拼接，兼容不同平台分隔符。
export function resolveWorkspaceSubagentRoot(workspacePath: string): string {
  // 前置条件：workspacePath 必须是已校验的项目根；本函数不校验越界，传错会把 agent 目录写到任意位置。
  // 工作区级目录固定在仓库内 .zcode/agents，才能随仓库提交或按目录隔离；这里刻意不读 storage.dir。
  return join(workspacePath, ".zcode", "agents");
}

// 状态文件固定在 v2/agents-state.json；版本目录隔离旧格式，避免升级时误读既有数据。
export async function resolveSubagentStateFile(options?: SubagentStorageOptions): Promise<string> {
  // 状态文件固定 v2/agents-state.json：v2 段隔离旧格式，改名会让已有 agent 状态被当成缺失而重建。
  return join(await resolveZCodeStorageRoot(options), "v2", "agents-state.json");
}

// 存储根由 CLI 配置的 storage.dir 决定（支持「~/」展开），读取失败或字段非法时回落 ~/.zcode。
// 配置读取失败不抛错：首次运行或配置损坏都应能用默认目录继续工作。
export async function resolveZCodeStorageRoot(options?: SubagentStorageOptions): Promise<string> {
  // readUserCliConfig 内部吞掉所有读取与解析错误并返回空对象，因此这里不需要 try，失败等价于没有配置。
  const config = await readUserCliConfig(options);
  // storage 必须是普通对象：数组或字符串都按缺失处理，否则 storage.dir 可能取到数组下标的无意义值。
  const storage = isObjectRecord(config.storage) ? config.storage : {};
  // 同时校验类型与空白：只判 typeof 会让空串通过，trim 后为空仍应回落到默认根。
  const storageDir =
    typeof storage.dir === "string" && storage.dir.trim().length > 0
      ? storage.dir.trim()
      // 默认值写成 ~/.zcode 而不是展开后的绝对路径，展开逻辑只在 resolveConfigPath 一处，避免两份实现漂移。
      : "~/.zcode";
  // 统一交给 resolveConfigPath 收口：无论配置以 ~/ 开头还是相对路径，返回值都是可跨进程比较的绝对路径。
  return resolveConfigPath(storageDir, options);
}

// 只展开开头的「~/」；展开后仍为相对路径时按进程 cwd 解析为绝对路径，
// 保证调用方拿到的始终是可比较、可持久化的绝对路径。
export function resolveConfigPath(path: string, options?: SubagentStorageOptions): string {
  // 相对路径按进程 cwd 解析：跨进程比较前，调用方应持久化这里返回的绝对路径。
  // 只认开头的 ~/：裸 ~ 与 Windows 风格 ~\ 都不展开，否则 .zcode 之后的内容会被当作用户名的一部分。
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(options), path.slice(HOME_PREFIX.length))
    : path;
  // 相对路径按进程 cwd 解析：调用方会跨进程比较路径字符串，保留相对形式会让两处结果不一致。
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

// 配置缺失、JSON 损坏或顶层不是对象时一律返回空对象，由调用方走默认值；不记录日志避免噪声。
async function readUserCliConfig(
  options?: SubagentStorageOptions,
): Promise<Record<string, unknown>> {
  // config.json 是用户可手改的文件：解析结果必须当成不可信输入，字段由调用方逐个校验。
  try {
    // 配置路径固定 ~/.zcode/cli/config.json：这里不读 ZCODE_DATA_BASE_DIR，避免与 paths.ts 的数据根互相影响。
    const raw = await readFile(
      join(resolveUserHomeDir(options), ".zcode", "cli", "config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    // 顶层不是对象时当成无配置：JSON 数组或 null 都取不到 storage.dir，返回空对象让调用方走默认值。
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    // 读取失败不区分 ENOENT 与解析错误：两者都等价于「没有配置」，交由调用方回落默认根。
    return {};
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  // 数组在 typeof 下也是 object，必须显式排除，否则 storage 为数组时 config.storage.dir 会读到 undefined。
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
