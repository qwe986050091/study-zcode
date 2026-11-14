// 运行时命令环境装配：把「进程继承环境 + login shell 快照 + 工具链 PATH 补丁 + Python UTF-8 补丁」
// 合并成一份环境补丁，供 Host、terminal 与 Bash/Agent 子进程共用。
// INV-env#01：host/agent 进程本身不得继承 shell 的 NODE_ENV、http_proxy 或证书变量，
//   它们只能以 ZCODE_TOOL_ENV_PASSTHROUGH_JSON 暂存（守住位置：initializeRuntimeProcessEnv 的 sanitize 调用）。
// INV-env#02：Windows 上 PATH 必须收敛为唯一的 PATH 键（守住位置：normalizeRuntimeProcessEnv；
//   破坏后子进程只看到其中一个，用户 PATH 被短 patch 覆盖，命令随机找不到）。
// INV-env#03：合并优先级为 快照白名单 → 工具透传 → 内置工具 → Python 补丁，后者覆盖前者
//   （守住位置：buildRuntimeProcessEnvPatch 的展开顺序；顺序错会让用户配置被默认值吃掉）。
// INV-env#04：login shell 探测失败只能降级为 bootstrap PATH，不能让 spawn 直接失去 node/npx。
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { buildZCodeToolEnvPassthroughEnv, sanitizeZCodeRuntimeEnvInPlace } from "@zcode/shared";
import { appendPathEntries, buildRuntimeToolEnvPatch } from "./runtimeToolResolver.js";
import {
  buildShellBootstrapPath,
  captureLoginShellEnvSnapshot,
  captureLoginShellEnvSnapshotSync,
} from "./runtimeLoginShellEnvCapture.js";
export {
  captureLoginShellEnvSnapshot,
  type LoginShellExecutor,
} from "./runtimeLoginShellEnvCapture.js";

// Windows 安装 Node 却未写入系统 PATH 的情况很常见，这里作为 PATH 末尾的兜底候选。
// 全部写成模板串，读取时用当前 env 展开 %VAR%，不写死用户目录。
const DEFAULT_WINDOWS_NODE_PATHS = [
  "%APPDATA%\\npm",
  "%ProgramFiles%\\nodejs",
  "%ProgramFiles(x86)%\\nodejs",
  "%LOCALAPPDATA%\\Programs\\nodejs",
];
// [权衡] 无条件覆盖用户的 PYTHONIOENCODING/PYTHONUTF8：工具输出按 UTF-8 解码，
// 若沿用 Windows 默认 GBK，含中文的 stdout 会在解析阶段变成乱码或抛 UnicodeDecodeError。
const PYTHON_UTF8_ENV_PATCH = {
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
} as const;

// [并发] initialize 是幂等闸门：Host 启动与测试可能各调用一次，重复 sanitize 会把已恢复的变量再清一次。
// 用模块级布尔而非检查某个 env 键，因为该键可能本来就不存在，无法据此判断是否已执行。
let hasInitializedRuntimeCommandEnv = false;

// Windows 变量名大小写不敏感，但 process.env 可能同时保留多个大小写不同的键，这里统一做不区分大小写查找。
function readWindowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const matchingKey = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
  return matchingKey ? env[matchingKey] : undefined;
}

// 只展开 %VAR%；未定义变量展开为空串，与 cmd.exe 一致，避免残留字面量路径。
function expandWindowsEnvVars(path: string, env: NodeJS.ProcessEnv): string {
  return path.replace(/%([^%]+)%/g, (_, varName) => readWindowsEnvValue(env, varName) || "");
}

// 只保留真实存在的目录：塞入不存在的候选会拖慢每次命令查找，也让 PATH 难以排错。
// 顺序保持声明顺序，APPDATA 下的 npm 优先于系统级安装。
function resolveWindowsNodePaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  for (const template of DEFAULT_WINDOWS_NODE_PATHS) {
    const expanded = expandWindowsEnvVars(template, env);
    if (expanded && existsSync(expanded)) {
      paths.push(expanded);
    }
  }
  return paths;
}

// 白名单而非黑名单：login shell 快照里混有大量交互态变量（PWD、PS1、NODE_OPTIONS、代理变量），
// 整份继承会把交互 shell 的副作用带进 host/agent；这里只放行版本管理器、凭证与语言环境类变量。
// 每条都锚定 ^...$，避免 PATH、HOME 这类前缀相近的键被意外放行。
const INHERITED_LOGIN_SHELL_ENV_KEY_PATTERNS = [
  /^KUBECONFIG$/i,
  /^KUBE_CONFIG_PATH$/i,
  /^KUBECTL_KUBECONFIG$/i,
  /^SSH_AUTH_SOCK$/i,
  /^AWS_PROFILE$/i,
  /^AWS_REGION$/i,
  /^AWS_DEFAULT_REGION$/i,
  /^AWS_SDK_LOAD_CONFIG$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^LANG$/i,
  /^LC_[A-Z0-9_]+$/i,
  /^XDG_CONFIG_HOME$/i,
  /^XDG_DATA_HOME$/i,
  /^XDG_CACHE_HOME$/i,
  /^TERM$/i,
  /^COLORTERM$/i,
  /^TERM_PROGRAM$/i,
  /^TERM_PROGRAM_VERSION$/i,
  /^NPM_CONFIG_USERCONFIG$/i,
  /^NPM_CONFIG_PREFIX$/i,
  /^PNPM_HOME$/i,
  /^NVM_DIR$/i,
  /^NVM_CD_FLAGS$/i,
  /^FNM_[A-Z0-9_]+$/i,
  /^VOLTA_HOME$/i,
  /^CARGO_HOME$/i,
  /^RUSTUP_HOME$/i,
  /^GOPATH$/i,
  /^GOROOT$/i,
  /^GOENV_ROOT$/i,
  /^GVM_ROOT$/i,
  /^gvm_[A-Za-z0-9_]+$/i,
  /^JAVA_HOME$/i,
  /^JENV_ROOT$/i,
  /^SDKMAN_DIR$/i,
  /^SDKMAN_CANDIDATES_DIR$/i,
  /^SDKMAN_PLATFORM$/i,
  /^VIRTUAL_ENV$/i,
  /^CONDA_PREFIX$/i,
  /^PYENV_ROOT$/i,
  /^PYENV_VERSION$/i,
  /^PYENV_VIRTUALENV_[A-Z0-9_]+$/i,
  /^PIP_CONFIG_FILE$/i,
  // shell init snapshot 会保存 cd/chpwd/precmd hook 函数；
  // 这些 hook 常依赖版本管理器的 root/state env。
  // 这里只补已知 hook 必需变量，避免恢复宽继承把 NODE_OPTIONS 等带进 host/agent runtime。
  /^DIRENV_[A-Z0-9_]+$/i,
  /^MISE_[A-Z0-9_]+$/i,
  /^rvm_[A-Za-z0-9_]+$/i,
  /^MY_RUBY_HOME$/i,
  /^GEM_HOME$/i,
  /^GEM_PATH$/i,
  /^RUBIES$/i,
  /^CHRUBY_ROOT$/i,
  /^RBENV_ROOT$/i,
  /^NODENV_ROOT$/i,
  /^AUTOENV_[A-Z0-9_]+$/i,
] as const;

// 逐个模式匹配，任一命中即放行；模式数量固定且很短，不需要预编译缓存。
function shouldInheritLoginShellEnvKey(key: string): boolean {
  return INHERITED_LOGIN_SHELL_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

// 值为 undefined 表示 shell 中未导出，必须跳过：写入 undefined 会在 spawn 时变成字符串 "undefined"。
// 返回新对象而不是复用快照，保证调用方后续修改快照不会污染已生成的补丁。
export function buildLoginShellEnvPatch(
  snapshot: Record<string, string | undefined>,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined && shouldInheritLoginShellEnvKey(key)) {
      patch[key] = value;
    }
  }

  return {
    ...patch,
// 工具透传在快照白名单之后展开，同名时以透传结果为准（它来自用户显式的 tool env 配置）。
    ...buildZCodeToolEnvPassthroughEnv(snapshot),
  };
}

// 把 Windows 上大小写混杂的 Path/PATH 收敛成唯一 PATH：子进程按「最后写入者」生效，
// 同时保留继承的 Path 与 Main patch 的 PATH 会让两者互相覆盖，表现为部分命令时好时坏。
// 非 Windows 直接浅拷贝返回：POSIX 变量大小写敏感，不存在等价键冲突。
export function normalizeRuntimeProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const normalized = { ...baseEnv };
  if (platform !== "win32") {
    return normalized;
  }

  let pathValue: string | undefined;
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.toUpperCase() === "PATH" && value !== undefined) {
      // 后出现的值优先，使 {...dotenv, ...process.env} 保持真实进程环境优先语义。
// 遍历全部键而不是取第一个：对象里可能存在大小写不同的多个 PATH，后出现的更接近真实进程环境。
      pathValue = value;
    }
  }
// 先记录再统一删除：边遍历边删会让 for...of 跳过后续同名键，残留的旧 PATH 仍会被子进程看到。
  for (const key of Object.keys(normalized)) {
    if (key.toUpperCase() === "PATH") {
      delete normalized[key];
    }
  }
  if (pathValue !== undefined) {
    normalized.PATH = pathValue;
  }
  return normalized;
}

// 纯函数：不读全局、不改 process.env，便于测试注入 platform、windowsNodePaths 与快照。
// loginShellSnapshot 的默认值会同步探测一次 shell，不可用于高频调用；异步场景应改用 prepareRuntimeProcessEnvPatch。
// 返回值是增量补丁而非完整环境，调用方用 Object.assign 叠加，未提及的键保持继承值。
export function buildRuntimeProcessEnvPatch(
  baseEnv: NodeJS.ProcessEnv = process.env,
  loginShellSnapshot: Record<string, string> | null = captureLoginShellEnvSnapshotSync(baseEnv),
  options: {
    platform?: NodeJS.Platform;
    windowsNodePaths?: readonly string[];
  } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const normalizedBaseEnv = normalizeRuntimeProcessEnv(baseEnv, platform);
// 空白 PATH 视为未探测到：PATH=" " 时拼接会产生非法条目，后续 spawn 直接 ENOENT。
// 只认快照里的 PATH 原文，不与 runtimeToolEnvPatch 的 PATH 混用，二者来源不同。
  const loginShellPath = loginShellSnapshot?.PATH?.trim() || null;
  const loginShellEnvPatch = loginShellSnapshot ? buildLoginShellEnvPatch(loginShellSnapshot) : {};
// 透传判定基于「基础环境 + 快照白名单」的合并视图：只看 baseEnv 会漏掉 shell 里 export 的代理与证书变量。
// 展开顺序为快照在前、基础环境在后，保证真实进程环境优先。
  const toolEnvPassthroughPatch = buildZCodeToolEnvPassthroughEnv({
    ...normalizedBaseEnv,
    ...loginShellEnvPatch,
  });
// PATH 显式置 undefined：工具解析只看基础环境的 PATH，不叠加 login shell 的 PATH，
// 否则两条 PATH 会被拼成超长链，重复条目让「哪个版本优先」不可预测。
  const runtimeToolEnvPatch = buildRuntimeToolEnvPatch(["bfs", "ripgrep", "ugrep"], {
    ...normalizedBaseEnv,
    PATH: undefined,
  });

// 内置工具目录追加到最终 PATH 尾部而不是替换，保留用户版本管理器的顺序。
  const runtimeToolPathEntries = runtimeToolEnvPatch.PATH?.split(delimiter).filter(Boolean) ?? [];
  // 远端 server 可能由非交互 SSH /bin/sh 启动，原始 PATH 只有系统目录；
  // login shell 探测失败时如果继续沿用该 PATH，后续 mcp/list 的 app-server 直接 spawn("npx")
  // 会找不到 Homebrew/NVM 里的 npx。POSIX 下把 bootstrap PATH 也作为最终兜底，而不是只用于探测。
// [失败路径] buildShellBootstrapPath 只在 POSIX 生效；Windows 的 PATH 已被 normalize 收敛，无需再补。
// 这里构造兜底基座，只有 login shell 探测失败时才会进入 pathBase。
  const fallbackPathBase =
    platform === "win32" ? normalizedBaseEnv.PATH : buildShellBootstrapPath(normalizedBaseEnv.PATH);
// login shell 的 PATH 优先：它包含用户 rc 里 source 的 nvm/pyenv/mise 初始化结果。
  const pathBase = loginShellPath ?? fallbackPathBase;
// [权衡] 合并顺序即覆盖优先级，后展开者胜：内置工具 PATH 覆盖透传 PATH，Python 补丁覆盖用户同名变量。
// 若把用户环境放最后，PYTHONUTF8 等缺省值就形同虚设，Windows 上仍会回落到 GBK。
  const envPatch: Record<string, string> = {
    ...loginShellEnvPatch,
    ...toolEnvPassthroughPatch,
    ...runtimeToolEnvPatch,
    // Python on Windows inherits the active code page (often GBK/936) when no explicit
    // encoding is set. ZCode/Bash tool output is consumed as UTF-8, so force Python
    // subprocesses spawned by agents to emit UTF-8.
    ...PYTHON_UTF8_ENV_PATCH,
  };

// Windows 的 Node 目录只在此处拼接，避免影响 POSIX 下由 shell 提供的完整 PATH。
  if (platform === "win32") {
    const windowsNodePaths = options.windowsNodePaths ?? resolveWindowsNodePaths(normalizedBaseEnv);
    runtimeToolPathEntries.push(...windowsNodePaths);
  }

// 只有确实要改动 PATH 时才写回：无条件写会让上层误以为环境被 patch，
// 并在 Windows 上重新引入大小写不同的 PATH 键，破坏 INV-env#02。
  const shouldSetPath =
    Boolean(loginShellPath) ||
    runtimeToolPathEntries.length > 0 ||
    (platform === "win32" && Boolean(normalizedBaseEnv.PATH)) ||
    (platform !== "win32" && pathBase !== normalizedBaseEnv.PATH);
  if (shouldSetPath) {
    const nextPath = appendPathEntries(pathBase, runtimeToolPathEntries);
    if (nextPath) {
      envPatch.PATH = nextPath;
    }
  }

  return envPatch;
}

// 异步探测版：可设置超时与自定义 captureSnapshot，Host 启动路径用它避免阻塞事件循环。
// 探测异常一律降级为 null —— shell 不可用是部署常态，不能让 Host 起不来。
export async function prepareRuntimeProcessEnvPatch(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: {
    captureSnapshot?: () => Promise<Record<string, string> | null>;
    platform?: NodeJS.Platform;
    captureTimeoutMs?: number;
  } = {},
): Promise<Record<string, string>> {
  const platform = options.platform ?? process.platform;
  const normalizedBaseEnv = normalizeRuntimeProcessEnv(baseEnv, platform);
  let snapshot: Record<string, string> | null = null;
  try {
// 注入的 captureSnapshot 优先于默认探测，测试与远端 server 据此替换 shell 执行器。
    snapshot = await (
      options.captureSnapshot ??
      (() =>
        captureLoginShellEnvSnapshot({
          baseEnv: normalizedBaseEnv,
          platform,
          timeoutMs: options.captureTimeoutMs,
        }))
    )();
// [失败路径] 任何探测失败都退化为「无快照」：后续会用 bootstrap PATH 兜底，
// 不能把异常上抛，否则用户 shell 配置有错就会让 Host 整体启动失败。
  } catch {
    snapshot = null;
  }
  return buildRuntimeProcessEnvPatch(normalizedBaseEnv, snapshot, { platform });
}

// Host 进程唯一的环境初始化入口：必须在任何 Git/terminal/Agent spawn 之前调用。
// 幂等由模块级布尔保证，第二个调用者直接返回，避免重复 sanitize 与重复 patch。
export function initializeRuntimeProcessEnv(
  preparedRuntimeProcessEnvPatch?: Record<string, string>,
): void {
  if (hasInitializedRuntimeCommandEnv) {
    return;
  }
  hasInitializedRuntimeCommandEnv = true;

// 先取规范化视图再改 process.env：删除同名键的过程中原对象已被修改，事后无法再算出一致 PATH。
  const normalizedProcessEnv = normalizeRuntimeProcessEnv(process.env);
  if (process.platform === "win32") {
    // Host 同时持有继承的 Path 与 Main patch 的 PATH 时，Windows 子进程只会保留其中一项。
    // 在任何 Git/terminal/Agent spawn 前统一成一个键，避免用户 PATH 被短 patch 覆盖。
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === "PATH") {
        delete process.env[key];
      }
    }
    if (normalizedProcessEnv.PATH !== undefined) {
      process.env.PATH = normalizedProcessEnv.PATH;
    }
  }
// 允许传入预热好的补丁（来自 prepareRuntimeProcessEnvPatch），避免启动关键路径再探测一次 shell；
// 未传时退化为同步探测，保证单独调用 initialize 也能得到完整环境。
  const runtimeProcessEnvPatch =
    preparedRuntimeProcessEnvPatch ?? buildRuntimeProcessEnvPatch(normalizedProcessEnv);
  // host/agent 运行时不能直接继承用户 shell 里的 NODE_ENV、http_proxy 或证书变量。
  // 网络变量会先封存为 ZCODE_TOOL_ENV_PASSTHROUGH_JSON，只有 Bash/tool 子进程边界才恢复原名。
// 顺序不能反：必须先 sanitize 再叠加补丁，否则补丁里的 PATH/PYTHONUTF8 会被 sanitize 一并清掉。
  sanitizeZCodeRuntimeEnvInPlace(process.env);
  Object.assign(process.env, runtimeProcessEnvPatch);
}
