// CLI 环境变量装配层：统一负责运行时环境（development/production）判定、工具链变量透传、
// 敏感变量清洗，以及 .env 的向上查找与加载。所有命令入口都应先经此处归一化 env，再往下传递。
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  ZCODE_RUNTIME_ENV_KEY,
  buildZCodeToolEnvPassthroughEnv,
  normalizeZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnvInPlace,
  type ZCodeRuntimeEnv,
} from "@zcode/shared/runtime-env";

// 可写的环境变量袋。键存在但值为 undefined 表示"该变量已声明但未赋值"；
// 调用方既可直接传 process.env，也可传自建对象以避免污染真实进程环境。
export type CliEnv = Record<string, string | undefined>;

// .env 加载结果。
export type DotenvLoadResult = {
  // 找到文件但读写/解析失败时的原始错误；存在时 loaded 必为 false。
  error?: Error;
  // 本次真正写入 env 的键名（不含因 override:false 被跳过、即已存在的键），无文件时为 []。
  keys: string[];
  // 是否成功完成一次加载；未发现 .env 与加载失败都为 false，用 path/error 区分。
  loaded: boolean;
  // 命中的 .env 绝对路径；仅当发现文件时才赋值。
  path?: string;
};

// loadCliDotenv 的可选依赖；两个字段都缺省，缺省时回落到进程自身状态。
export type LoadCliDotenvOptions = {
  // 向上查找 .env 的起点目录，缺省为 process.cwd()。
  cwd?: string;
  // 写入目标环境变量袋，缺省为 process.env；传入自定义袋可让加载结果只作用于本次运行。
  env?: CliEnv;
};

// 构造一份"可用于运行时"的 env 副本，不修改传入的原始 env。
// 输入：原始环境变量袋与进程参数（argv 只用于判定 development/production，不解析业务参数）。
// 输出：新对象，包含清洗后的运行时变量 + 工具链透传变量 + 补齐的默认值；null/undefined 值原样保留。
// 副作用：纯内存计算，无 IO、无日志、不写 process.env。
// 不变量：返回值中的运行时环境键（ZCODE_RUNTIME_ENV）一定已被显式设置，下游无需再兜底。
export function prepareCliRuntimeEnv(
  env: CliEnv = process.env,
  argv: readonly string[] = process.argv,
): CliEnv {
  const prepared = {
    ...sanitizeZCodeRuntimeEnv(env),
    ...buildZCodeToolEnvPassthroughEnv(env),
  };
  applyCliRuntimeEnvDefaults(prepared, argv);
  return prepared;
}

// 就地清洗 env（与 prepareCliRuntimeEnv 的差别只在写入原对象），常在入口拿到 process.env 后立即调用。
// 输入：待清洗的可变 env 与进程参数；无返回值，成功后同一对象可继续使用。
// 副作用：原地删除/改写敏感键，并把工具链透传变量写回；调用后原对象的键集合可能变小。
// 不变量：透传值必须在其来源键被清洗前先取出，否则跨平台工具的 PATH 类变量会丢失。
export function applyCliRuntimeEnvSanitization(
  env: CliEnv,
  argv: readonly string[] = process.argv,
): void {
  const toolEnvPassthrough = buildZCodeToolEnvPassthroughEnv(env);
  sanitizeZCodeRuntimeEnvInPlace(env);
  Object.assign(env, toolEnvPassthrough);
  applyCliRuntimeEnvDefaults(env, argv);
}

// 从 startDir 起逐级向上查找最近的 `.env` 文件。
// 输入：起点目录（相对/绝对均可，内部会 resolve）；空字符串会退化为 process.cwd()。
// 输出：命中文件的绝对路径；走到文件系统根仍未命中时返回 undefined（不是异常）。
// 副作用：只读文件系统（existsSync + statSync），不做缓存，重复调用会重复 stat。
// 不变量：返回的路径必定指向常规文件；目录同名 `.env` 会被跳过并继续向上查找。
export const findDotenv = (startDir: string): string | undefined => {
  let current = resolve(startDir);
  const root = parse(current).root;

  while (true) {
    const candidate = resolve(current, ".env");
    // 用户可能把 .env 当作目录使用（如 ~/.env/modelscope）。
    // existsSync 只检查存在性，不区分文件/目录；必须显式检查 isFile避免 loadDotenv 报错。
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }

    if (current === root) {
      return undefined;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

// 查找并加载 `.env`，把键值写入目标 env 袋。
// 输入：options.cwd/options.env，均可缺省；找到文件后以 override:false 方式写入，已存在的键不覆盖。
// 输出：DotenvLoadResult。未发现文件时返回 `{keys: [], loaded: false}` 且不带 path；
// 解析失败时额外带 error 与 path，keys 仍为空集合，便于调用方区分"没有"与"坏了"。
// 副作用：仅写内存中的 env 对象（默认即 process.env）+ 读取一次磁盘，不落盘、不打印日志。
// 失败语义：不抛异常，错误通过返回值上报，由入口决定是否降级继续运行。
export const loadCliDotenv = (options: LoadCliDotenvOptions = {}): DotenvLoadResult => {
  const env = options.env ?? process.env;
  const dotenvPath = findDotenv(options.cwd ?? process.cwd());

  if (!dotenvPath) {
    return {
      keys: [],
      loaded: false,
    };
  }

  // The build used to inline .env values into dist. Loading at the CLI boundary
  // keeps secrets runtime-scoped and lets users rotate .env without rebuilding.
  const result = loadDotenv({
    override: false,
    path: dotenvPath,
    processEnv: env,
    quiet: true,
  });

  if (result.error) {
    return {
      error: result.error,
      keys: [],
      loaded: false,
      path: dotenvPath,
    };
  }

  return {
    keys: Object.keys(result.parsed ?? {}),
    loaded: true,
    path: dotenvPath,
  };
};

// 协议服务器（Host 拉起的长驻进程）是否应加载 `.env`。
// 输入：目标 env（只读，用于判定运行时环境）。
// 输出：仅 development 返回 true；production 一律 false。
// 原因：打包产物的生产形态不应因工作目录里的 `.env` 改变行为，避免用户环境不可预期地影响 Host。
export function shouldLoadCliDotenvForProtocolServer(env: CliEnv): boolean {
  return resolveCliRuntimeEnv(env, process.argv) === "development";
}

// 补齐 CLI 运行所需的环境默认值：运行时环境键与 beta 存储目录。
// 副作用：就地写入 env；幂等，重复调用结果相同。
// 不变量：显式给出的值优先，任何默认值只在缺省时才填。
function applyCliRuntimeEnvDefaults(env: CliEnv, argv: readonly string[]): void {
  env[ZCODE_RUNTIME_ENV_KEY] = resolveCliRuntimeEnv(env, argv);
  applyBetaStorageDefault(env, argv);
}

// 判定当前 CLI 的运行时环境。
// 输入：env 中的显式 ZCODE_RUNTIME_ENV 优先；缺失时按入口文件路径推断。
// 输出：`"development"` 或 `"production"`，永不返回空值。
function resolveCliRuntimeEnv(env: CliEnv, argv: readonly string[]): ZCodeRuntimeEnv {
  const explicit = normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]);
  if (explicit) {
    return explicit;
  }

  // CLI 运行时不再读取 NODE_ENV。源码 tsx 入口仍表示本地开发形态，
  // 但该判定来自入口路径，不来自用户 shell 里的 NODE_ENV。
  const entrypoint = (argv[1] ?? "").replace(/\\/g, "/");
  return entrypoint.endsWith(".ts") && entrypoint.includes("packages/cli/src")
    ? "development"
    : "production";
}

// beta 形态下把存储目录默认到 `~/.zcode-beta`，避免与正式版共用 session/凭据库。
// 输入：env 与 argv；显式 ZCODE_STORAGE_DIR 非空时完全不动。
// 副作用：就地写入 ZCODE_STORAGE_DIR；不创建目录（由存储层首次写入时创建）。
function applyBetaStorageDefault(env: CliEnv, argv: readonly string[]): void {
  if (env.ZCODE_STORAGE_DIR?.trim()) return;
  const explicitBeta = env.ZCODE_BETA === "1" || env.ZCODE_ENV === "beta";
  const invokedAsBeta = argv.some((arg) => /(^|[/\\])zcode-beta(?:$|\.)/u.test(arg));
  if (!explicitBeta && !invokedAsBeta) return;
  env.ZCODE_STORAGE_DIR = join(homedir(), ".zcode-beta");
}
