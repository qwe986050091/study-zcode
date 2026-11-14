// 运行时工具解析：把 provider（当前仅 glm）映射到 agent 二进制或 JS bundle 的可执行入口，
// 并产出隔离、可复现的子进程环境。这里只做路径发现与 env 组装，不负责启动进程。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { ZCODE_AGENT_RUNTIME, sanitizeZCodeRuntimeEnvInPlace } from "@zcode/shared";
import { getDataBaseDir, getProviderWorkspaceConfigDir } from "../paths.js";
import { buildRuntimeProcessEnvPatch } from "./runtimeCommandEnv.js";

// 开发态覆盖入口：显式指定的 ZCode 源码工作目录，优先级高于任何自动发现逻辑。
const ZCODE_AGENT_WORKDIR_ENV = "ZCODE_AGENT_WORKDIR";

/** 返回 provider + workspace 在应用内的专属配置目录路径 */
// 契约：provider / workspace 形参目前被忽略，统一返回按 workspace 隔离的配置目录。
// 保留形参是为了不破坏调用方签名；将来恢复按 provider 区分时只需改动此处。
export function resolveProviderConfigDir(
  _legacyProvider: string,
  _workspacePath: string,
  _workspaceIdentity?: string,
): string {
  return getProviderWorkspaceConfigDir();
}

/** 构建干净的 Node.js 环境，去掉 Electron/GPU 相关变量 */
// 构造 agent 子进程环境：先复制 shell env，再剔除会污染运行时或让子进程失控的变量。
// 副作用只作用于入参 env 的副本，绝不修改 process.env；返回值最后还会叠加
// 工具 PATH 补丁与调用方 extra，后者优先级最高。
export function buildCleanEnv(
  provider: string,
  _configDir: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    // 过滤掉 Electron 特有的和 GPU 相关的环境变量
    if (key.startsWith("ELECTRON_")) continue;
    if (key.startsWith("ORIGINAL_XDG_")) continue;
    if (key === "NODE_OPTIONS") continue;
    // Bugfix: Windows 下 git bash / WSL 环境会把 SHELL=/usr/bin/bash 注入到 process.env，
    // agent runtime 在 Windows 上用 SHELL 来启动子进程（stdio MCP server），
    // 传入无效的 POSIX shell 路径会导致所有 stdio MCP 启动失败。
    // 不能直接删掉 SHELL，否则 agent 找不到 shell 也会导致 MCP 连接失败。
    // 这里把无效的 POSIX 路径替换为 Windows 原生 shell（优先 ComSpec，回退 cmd.exe）。
    if (key === "SHELL" && process.platform === "win32") {
      const winShell = process.env.ComSpec || "cmd.exe";
      env.SHELL = winShell;
      continue;
    }
    if (key === "GOOGLE_API_KEY") continue;
    env[key] = value;
  }
  // 修复原因：provider/agent runtime 子进程不能默认继承 shell 里的 NODE_ENV、代理或证书变量。
  // 这些运行时输入必须来自 ZCODE_* 显式配置或 app 设置页，避免用户环境污染模型请求和工具子进程。
  sanitizeZCodeRuntimeEnvInPlace(env);
  // Bugfix: Windows 环境变量名大小写不敏感，但 JS 普通对象区分大小写。
  // process.env 枚举时 PATH 通常以 "Path"（title case）出现，
  // 复制到普通对象后，下游 buildRuntimeProcessEnvPatch 按 "PATH"（全大写）查找会得到 undefined，
  // 导致它创建仅含工具路径的 PATH 条目，子进程初始化时 "PATH" 覆盖了 "Path"，
  // 最终 agent 及其子进程丢失整个系统 PATH，无法找到 git / node / cmd 等系统命令。
  // 这里统一把 Path → PATH，保证后续代码使用一致的大写 key。
  if (process.platform === "win32") {
    const nonCanonicalPathKey = Object.keys(env).find(
      (k) => k.toUpperCase() === "PATH" && k !== "PATH",
    );
    if (nonCanonicalPathKey && env[nonCanonicalPathKey]) {
      env.PATH = env[nonCanonicalPathKey]!;
      delete env[nonCanonicalPathKey];
    }
  }
  if (provider === "glm") {
    const glmHome = getDataBaseDir();
    // Bugfix: GLM agent 会把 config/session 产物写到 dataBaseDir 下的 ~/.zcode/cli。
    // 这里统一把子进程 HOME 切到 dataBaseDir，保证“写入目录”和“运行时读取目录”始终一致。
    env.HOME = glmHome;
    if (process.platform === "win32") {
      env.USERPROFILE = glmHome;
    }
  }
  Object.assign(env, buildRuntimeProcessEnvPatch(env));
  if (extra) Object.assign(env, extra);
  return env;
}

// 打包态（Electron）由主进程注入 resourcesPath；开发与 CLI 场景下不存在，
// 因此只在类型上探测一次并归一为 null，后续候选统一跳过，避免把 undefined 传给 path.resolve。
const packagedResourcesPath =
  typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
    ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    : null;

// 候选顺序即优先级：返回第一个真实存在的路径，全部落空返回 null 交由调用方降级。
function resolveExistingPath(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// 平台化目录假设：落盘布局为 bundled-agents/<platform>-<arch>，而 desktop / web / server
// 三种启动方式的 process.cwd() 各不相同，故同时枚举仓库根、packages/desktop 与 moduleDir 相对位置。
function resolvePlatformScopedBundledAgentRoots(moduleDir?: string): Array<string | null> {
  const platformKey = `${process.platform}-${process.arch}`;
  return [
    resolvePath(process.cwd(), "bundled-agents", platformKey),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-agents", platformKey),
    // dev:web 会用 pnpm --filter @zcode/server dev 启动，cwd 落在 packages/server。
    // ZCode Agent 资源可能位于桌面包或仓库根的 bundled-agents/<platform>。
    // 这里统一补齐仓库内所有平台化目录候选，desktop/web/server 共享一套解析链路。
    resolvePath(process.cwd(), "..", "desktop", "bundled-agents", platformKey),
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-agents", platformKey) : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-agents", platformKey) : null,
  ];
}

// 历史资源目录布局（未按平台分目录），仅作兼容兜底，优先级低于平台化目录。
function resolveLegacyBundledResourceRoots(moduleDir?: string): Array<string | null> {
  return [
    resolvePath(process.cwd(), "bundled-resources"),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-resources"),
    resolvePath(process.cwd(), "..", "desktop", "bundled-resources"),
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-resources") : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-resources") : null,
  ];
}

// 二进制解析优先级：env 覆盖 > 打包 resources > 用户目录安装 > 仓库内平台化目录 > 历史目录；
// env 命中即短路（便于本地调试指向任意二进制），其余候选交给 resolveExistingPath 校验存在性。
export function findZCodeAgentRuntimeBinary(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];
  const envPath = process.env[runtime.binaryEnvVar];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // import.meta.dirname 在打包后的 CJS bundle（zcode-server.cjs）中是 undefined，
  // 直接传给 resolvePath 会报 "paths[0]" argument must be of type string。
  // 这里做空值保护，只有 import.meta.dirname 存在时才构建对应的候选路径。
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}

/**
 * 查找 agent 的 JS bundle（resources/glm/zcode.cjs）。
 * 桌面打包态用 app 内置的 Electron Node runtime 直接执行这个 bundle，不再随包内置独立 Node 二进制。
 * 候选目录与 findZCodeAgentRuntimeBinary 完全平行，只是入口换成平台无关的 nodeBundleEntryFile。
 * 不查 GLM_BINARY_PATH——那个 env 指向原生二进制，语义不同。
 */
// JS bundle 入口与二进制入口共享同一批候选目录，只是入口文件不同；
// 打包态用 app 内置的 Electron Node 执行，故这里刻意不查指向原生二进制的 binaryEnvVar。
export function findZCodeAgentRuntimeNodeBundle(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveNodeBundleSegments();
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];

  // 与 findZCodeAgentRuntimeBinary 一致，打包后的 CJS bundle 里 import.meta.dirname 为 undefined，
  // 这里做空值保护后再构建仓库内候选路径。
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}

/** 根据 provider 查找对应 binary 路径 */
// 非 glm 的 provider 目前没有随包 agent，直接返回 null 交由上层走各自实现。
export function findBinary(provider: string): string | null {
  if (provider !== "glm") {
    return null;
  }
  // GLM 开发态：ZCODE_AGENT_WORKDIR 或相邻目录发现，返回源码入口路径作为 "binary"
  const devEntry = findGlmDevEntry();
  if (devEntry) {
    return devEntry.agentPath;
  }
  return findZCodeAgentRuntimeBinary();
}

/**
 * GLM 开发态源码入口发现。
 * 优先读取 ZCODE_AGENT_WORKDIR。
 * 未设置时在 cwd 相邻目录查找 zcode-cli / glm。
 */
interface GlmDevEntry {
  workdir: string;
  entryArg: string;
  agentPath: string;
}

function resolveGlmDevEntry(workdir: string): GlmDevEntry | null {
  const candidates = [
    ["packages", "cli", "src", "main.ts"],
    ["src", "cli.ts"],
  ];
  for (const segments of candidates) {
    const agentPath = resolvePath(workdir, ...segments);
    if (existsSync(agentPath)) {
      return {
        workdir,
        entryArg: segments.join("/"),
        agentPath,
      };
    }
  }
  return null;
}

// 源码发现顺序：先信 env 指定的工作目录，再按仓库根与当前目录的相邻目录逐个试探。
function findGlmDevEntry(): GlmDevEntry | null {
  const workdir = process.env[ZCODE_AGENT_WORKDIR_ENV];
  if (workdir) {
    const entry = resolveGlmDevEntry(workdir);
    if (entry) {
      return entry;
    }
  }
  // Bugfix: desktop dev 进程的 cwd 是 packages/desktop，旧逻辑只查 cwd 的父级，
  // 会误找 packages/zcode-cli，而不是仓库旁边的 ../zcode-cli。这里先向上定位仓库根，
  // 再按“仓库相邻目录”发现本地 GLM 源码，同时保留 cwd 相邻目录作为非 monorepo 兜底。
  const repoRoot = findWorkspaceRoot(process.cwd());
  const anchorDirs = [repoRoot, process.cwd()].filter((anchor): anchor is string =>
    Boolean(anchor),
  );
  const candidates = ["zcode-cli", "glm", "cc-refactor"];
  const seen = new Set<string>();
  for (const anchorDir of anchorDirs) {
    for (const name of candidates) {
      const candidate = resolvePath(anchorDir, "..", name);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      const entry = resolveGlmDevEntry(candidate);
      if (entry) {
        return entry;
      }
    }
  }
  return null;
}

// 以 pnpm-workspace.yaml 作为 monorepo 边界向上回溯；到文件系统根仍未命中则返回 null。
function findWorkspaceRoot(startDir: string): string | null {
  let current = resolvePath(startDir);
  while (true) {
    if (existsSync(resolvePath(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
