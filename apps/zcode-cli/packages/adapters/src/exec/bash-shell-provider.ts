// INV-01 直接执行：守住位置 provider 的 shell 字段；改错故障：命令再套一层 shell，参数被二次解释。
// INV-02 快照优先：守住位置 非用户配置的判断；改错故障：设置页探测结果被重新探测覆盖。
// INV-03 用户优先：守住位置 Windows 显式选择；改错故障：手动选择的 Git Bash 被自动发现抢走。
// INV-04 可执行才采纳：守住位置 路径探测；改错故障：失效路径被写进供应器。
// INV-05 Git Bash 优先：守住位置 自动发现顺序；改错故障：Windows 回落到功能更弱的命令提示符。
// INV-06 检测可注入：守住位置 exists 参数；改错故障：测试无法绕过真实文件探测。
// INV-07 探测不抛：守住位置 可执行位捕获；改错故障：权限异常中断解析。
// INV-08 候选去重：守住位置 已见集合；改错故障：同一路径被反复探测，顺序不可预期。
// INV-09 SHELL 领先：守住位置 首候选；改错故障：用户登录环境习惯被忽略。
// INV-10 偏好顺序：守住位置 两种种类顺序；改错故障：macOS 上先探测 bash，结果与系统不一致。
// INV-11 反推兼容：守住位置 git 路径推导；改错故障：非标准安装目录找不到 bash。
// INV-12 编辑器固定：守住位置 环境增量；改错故障：git 打开交互编辑器，任务挂起。
// INV-13 方言保真：守住位置 物化分派；改错故障：Git Bash 工作目录未做路径转换。
// INV-14 空路径不物化：守住位置 路径判断；改错故障：空路径生成无效供应器。
// INV-15 失败降级：守住位置 legacy 结果；改错故障：探测失败抛出，整条命令链中断。
// INV-16 无启动副作用：守住位置 解析函数体；改错故障：解析期间启动 shell 或改环境。
// INV-17 描述一致：守住位置 选择构造器；改错故障：展示名与方言不匹配。
// INV-18 来源可辨：守住位置 source 字段；改错故障：自动与手动结果在诊断中无法区分。
//
// 模块职责：探测并物化 Bash 执行器，确定方言、启动参数与环境增量。
// 状态所有权：无运行时状态，全部为纯解析与探测函数。
// 阅读顺序：类型与常量 → 统一入口 → POSIX 探测 → Windows 探测 → 物化 → 候选构造。
// ============================================================
// 文件定位：选择并“物化”Bash 执行器（Git Bash / POSIX bash+ zsh / cmd），决定 shell 方言与启动参数。
// 输入输出：输入 env + 平台 + 可选用户选择；输出 provider（file/shell/方言/环境增量）与可展示的 selection。
// 副作用：仅 isExecutableCandidate 默认 accessSync(X_OK) 探测；不启动 shell、不改环境。
// 失败语义：探测不到 bash/zsh 时返回 legacy-shell（无 provider），由上层退回系统 shell。
// 不变量：provider 一律 shell:false 直接 exec；Git Bash 优先于 POSIX；用户明确选择不被自动探测覆盖。
// ============================================================
import { accessSync, constants as fsConstants } from "node:fs";
import { basename, delimiter, join, win32 } from "node:path";
import { windowsExecutableCandidates } from "./windows-executable.js";
import {
  type ExecutionShellDialect,
  type ExecutionShellSelection,
} from "@zcode/contracts";

// 可执行性判定注入点：默认 accessSync(X_OK)，测试可替换为假路径集合。
type PosixShellKind = "bash" | "zsh";
type ExecutableCheck = (path: string) => boolean;
// 解析入参：platform 用宽松 string 便于跨平台测试；override 来自会话/设置页快照。
type EffectiveBashShellResolveOptions = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform | string;
  exists?: ExecutableCheck;
  override?: ExecutionShellSelection;
};

const FIXED_POSIX_SHELL_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const WINDOWS_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
] as const;

// 方言决定工作目录路径的转换方式。
// 环境增量只放 shell 与编辑器两项。
//
export interface BashShellProvider {
  // 决定 cwd 路径转换方式：git-bash 需 /c/...，posix 原样，cmd 用 Windows 路径。
  dialect: ExecutionShellDialect;
  // 覆盖到子进程 env 的键值，目前固定 SHELL 与 GIT_EDITOR。
  envOverlay?: Record<string, string>;
  // 直接 spawn 的 shell 可执行文件路径（绝对路径）。
  file: string;
  // provider 恒为 false（直接 exec），只有 cmd provider 携带 cmd.exe 路径字符串。
  shell: boolean | string;
}

// selection 是给 UI 与诊断用的可读描述，不参与解析决策。
// 供应器为空表示要回退系统 shell。
//
export interface EffectiveBashShellResolution {
  // 面向 UI/诊断的选择描述；source=auto-detected|user-config|legacy-fallback。
  selection: ExecutionShellSelection;
  // 为空表示未找到可用 Bash，调用方应回退系统 shell。
  provider?: BashShellProvider;
}

// 统一入口：快照选择（非 user-config）优先；否则 Windows 走 Git Bash/CMD，其他平台走 bash/zsh。
// provider 存在时必须以 shell:false 执行，并把 envOverlay 合并进子进程环境。
// 非用户配置的快照直接复用，避免重复探测。
// 用户配置则按平台进入各自的解析分支。
//
export function resolveEffectiveBashShellSelection(
  options: EffectiveBashShellResolveOptions,
): EffectiveBashShellResolution {
  // 非 user-config 的快照（如设置页探测结果）直接复用，避免重复探测而选出不同 shell。
  const snapshotResolution = resolveShellSnapshotSelection(options.override);
  if (snapshotResolution) {
    return snapshotResolution;
  }

  return options.platform === "win32"
    ? resolveEffectiveWindowsBashShellSelection(options)
    : resolveEffectivePosixBashShellSelection(options);
}

// POSIX 平台探测：SHELL 若已是 bash/zsh 则排第一，然后按偏好补 PATH 与固定目录候选。
// 返回第一个可执行路径；全部探测失败返回 undefined（调用方据此退回 legacy shell）。
// 用户自己的 shell 命中时排在最前。
// 候选去重后返回首个可执行路径。
//
export function resolvePosixBashShell(
  env: NodeJS.ProcessEnv,
  exists?: ExecutableCheck,
): string | undefined {
  const candidates: string[] = [];
  const shell = env.SHELL;

  if (shell && posixShellKind(shell)) {
    // 用户自己的 SHELL 命中 bash/zsh 时优先级最高，保持其登录环境习惯。
    candidates.push(shell);
  }

  // 按偏好补候选：看 SHELL 类型决定先 bash 还是先 zsh。
  for (const kind of preferredPosixShellKinds(env)) {
    candidates.push(...pathCandidates(kind, env));
    candidates.push(...fixedPosixShellCandidates(kind));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableCandidate(candidate, exists)) {
      return candidate;
    }
  }

  return undefined;
}

// Windows 专用便捷入口：只返回 provider，忽略 selection（供不需要展示层信息的调用方使用）。
export function resolveWindowsBashShellProvider(options: {
  env: NodeJS.ProcessEnv;
  exists?: ExecutableCheck;
  override?: ExecutionShellSelection;
}): BashShellProvider | undefined {
  return resolveEffectiveWindowsBashShellSelection({
    env: options.env,
    exists: options.exists,
    override: options.override,
    platform: "win32",
  }).provider;
}

// 定位 Git Bash：先看两个标准安装目录，再从 PATH 中的 git.exe 反推 ../bin/bash.exe 与 ../../bin/bash.exe。
// 使用自研反推而不是写死路径，兼容 scoop/winget/自定义安装；找不到返回 undefined。
// 先看两个标准安装目录。
// 再从路径中的 git 可执行文件反推上两级。
//
export function resolveWindowsGitBashShell(
  env: NodeJS.ProcessEnv,
  exists?: ExecutableCheck,
): string | undefined {
  for (const candidate of WINDOWS_GIT_BASH_PATHS) {
    if (isExecutableCandidate(candidate, exists)) return candidate;
  }

  const gitExe = windowsExecutableCandidates("git", env).find((candidate) =>
    isExecutableCandidate(candidate, exists),
  );
  if (!gitExe) return undefined;

  const inferred = inferWindowsGitBashPathsFromGitExe(gitExe);
  return inferred.find((candidate) => isExecutableCandidate(candidate, exists));
}

// Git Bash provider：sh:false 直接 exec，注入 SHELL 与 GIT_EDITOR=true（避免 git 打开交互编辑器阻塞）。
// 直接执行，不经过中间 shell。
// 编辑器固定为真值，避免交互界面阻塞。
//
function createGitBashProvider(shellPath: string): BashShellProvider {
  return {
    dialect: "git-bash",
    envOverlay: {
      GIT_EDITOR: "true",
      SHELL: shellPath,
    },
    file: shellPath,
    shell: false,
  };
}

// POSIX provider：与 Git Bash 相同的环境增量，仅方言不同（影响 cwd 路径不做 /c/ 转换）。
function createPosixShellProvider(shellPath: string): BashShellProvider {
  return {
    dialect: "posix",
    envOverlay: {
      GIT_EDITOR: "true",
      SHELL: shellPath,
    },
    file: shellPath,
    shell: false,
  };
}

// 快照选择只在非 user-config 时生效：这类结果来自设置页/会话探测，已包含绝对路径，直接信任。
// user-config 必须走后续的平台解析，因为用户可能只给了方言/名称而 path 为空。
function resolveShellSnapshotSelection(
  selection: ExecutionShellSelection | undefined,
): EffectiveBashShellResolution | undefined {
  if (!selection || selection.source === "user-config") {
    return undefined;
  }
  return {
    provider: createShellProviderFromSelection(selection),
    selection,
  };
}

// 把 selection 物化为 provider：path 为空返回 undefined；dialect 决定方言与环境增量。
// 路径为空则不物化供应器。
// 方言决定使用哪套启动参数与环境增量。
//
function createShellProviderFromSelection(
  selection: ExecutionShellSelection,
): BashShellProvider | undefined {
  if (!selection.path) return undefined;
  if (selection.dialect === "git-bash") {
    return createGitBashProvider(selection.path);
  }
  if (selection.dialect === "cmd") {
    return createWindowsCmdProvider(selection.path);
  }
  if (selection.dialect === "posix") {
    return createPosixShellProvider(selection.path);
  }
  return undefined;
}

// Windows 解析：用户显式选择（且可执行）优先 → 自动发现 Git Bash → 退回 legacy-shell。
// 显式 cmd 选择在 ComSpec 缺失时仍保留，避免被自动探测的 Git Bash 抢走。
// override.source === "user-config" 且 isExecutableCandidate 为真时直接采纳，跳过自动探测。
// ComSpec 为空时 baseline 校验必然失败，所以 cmd 分支绕过 baseline 只查 path 是否存在。
//
function resolveEffectiveWindowsBashShellSelection(
  options: EffectiveBashShellResolveOptions,
): EffectiveBashShellResolution {
  const override = options.override;
  // 只有 user-config 才在此处消费；其他来源已在 resolveShellSnapshotSelection 提前返回。
  if (override?.source === "user-config") {
    if (
      override.dialect === "git-bash" &&
      override.path &&
      isExecutableCandidate(override.path, options.exists)
    ) {
      return {
        provider: createGitBashProvider(override.path),
        selection: shellSelection({
          dialect: "git-bash",
          displayName: "Git Bash",
          id: override.id,
          label: override.label,
          path: override.path,
          source: "user-config",
        }),
      };
    }
    if (override.dialect === "cmd") {
      const cmdPath = resolveWindowsCmdOverridePath(override.path ?? "cmd.exe", options.exists);
      if (cmdPath) {
        return {
          provider: createWindowsCmdProvider(cmdPath),
          selection: shellSelection({
            dialect: "cmd",
            displayName: "CMD",
            id: override.id,
            label: override.label,
            path: cmdPath,
            source: "user-config",
          }),
        };
      }
    }
  }

  // 用户选择的 Git Bash 路径必须实际可执行才采纳，否则回落到自动发现。
  const gitBash = resolveWindowsGitBashShell(options.env, options.exists);
  if (gitBash) {
    return {
      provider: createGitBashProvider(gitBash),
      selection: shellSelection({
        dialect: "git-bash",
        displayName: "Git Bash",
        id: "auto:git-bash",
        label: "Git Bash",
        path: gitBash,
        source: "auto-detected",
      }),
    };
  }

  return legacyShellSelection();
}

// POSIX 解析：探测到 bash/zsh 就生成 posix provider，否则 legacy-shell 让上层用系统 shell。
// 探测到 bash 或 zsh 才生成供应器。
// 探测失败返回不带供应器的保守结果。
//
function resolveEffectivePosixBashShellSelection(
  options: EffectiveBashShellResolveOptions,
): EffectiveBashShellResolution {
  const bashShell = resolvePosixBashShell(options.env, options.exists);
  if (!bashShell) {
    return legacyShellSelection();
  }
  const kind = posixShellKind(bashShell) ?? "bash";
  return {
    provider: createPosixShellProvider(bashShell),
    selection: shellSelection({
      dialect: "posix",
      displayName: kind,
      id: `auto:${kind}`,
      label: kind,
      path: bashShell,
      source: "auto-detected",
    }),
  };
}

// selection 统一构造器：display.name 供 UI 展示，id/label 可选，source 区分自动/手动。
function shellSelection(options: {
  dialect: ExecutionShellDialect;
  displayName: string;
  id?: string;
  label?: string;
  path: string;
  source: "auto-detected" | "user-config";
}): ExecutionShellSelection {
  return {
    dialect: options.dialect,
    display: { name: options.displayName },
    id: options.id,
    label: options.label,
    path: options.path,
    source: options.source,
  };
}

// 探测失败时的保守结果：不带 provider，也不承诺方言，交由系统默认 shell 兜底。
function legacyShellSelection(): EffectiveBashShellResolution {
  return {
    selection: {
      dialect: "legacy-shell",
      display: { name: "system shell" },
      source: "legacy-fallback",
    },
  };
}

function inferWindowsGitBashPathsFromGitExe(gitExe: string): string[] {
  const gitDir = win32.dirname(gitExe);
  return [
    win32.normalize(win32.join(gitDir, "..", "bin", "bash.exe")),
    win32.normalize(win32.join(gitDir, "..", "..", "bin", "bash.exe")),
  ];
}

// cmd provider：file/shell 都指向 cmd.exe，命令行由 applyResolvedShellCommand 写入 file。
function createWindowsCmdProvider(shellPath: string): BashShellProvider {
  return {
    dialect: "cmd",
    file: shellPath,
    shell: shellPath,
  };
}

// cmd.exe 覆盖路径：能执行则用绝对路径；裸 "cmd.exe" 视为系统 fallback 直接采纳（不预校验）。
function resolveWindowsCmdOverridePath(
  shellPath: string,
  exists?: ExecutableCheck,
): string | undefined {
  if (isExecutableCandidate(shellPath, exists)) {
    return shellPath;
  }
  // 设置页在 ComSpec 缺失时会暴露系统默认 cmd.exe fallback；它和 generic
  // Windows shell fallback 一样不能依赖 accessSync 预校验，否则用户显式选择会被 Git Bash 抢走。
  return isWindowsCmdFallback(shellPath) ? shellPath : undefined;
}

function isWindowsCmdFallback(shellPath: string): boolean {
  return (
    !shellPath.includes("\\") &&
    !shellPath.includes("/") &&
    shellPath.toLowerCase() === "cmd.exe"
  );
}

// 偏好顺序：SHELL 已是 bash 就先 bash 后 zsh，否则先 zsh（macOS 默认）后 bash。
function preferredPosixShellKinds(env: NodeJS.ProcessEnv): PosixShellKind[] {
  if (env.SHELL && posixShellKind(env.SHELL) === "bash") {
    return ["bash", "zsh"];
  }
  return ["zsh", "bash"];
}

function pathCandidates(kind: PosixShellKind, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH;
  if (!pathValue) return [];

  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry, kind));
}

function fixedPosixShellCandidates(kind: PosixShellKind): string[] {
  return FIXED_POSIX_SHELL_DIRS.map((dir) => join(dir, kind));
}

function posixShellKind(path: string): PosixShellKind | undefined {
  const name = basename(path);
  if (name.includes("bash")) return "bash";
  if (name.includes("zsh")) return "zsh";
  return undefined;
}

// 可执行性判定：优先用注入的 exists（测试/沙箱），否则 accessSync(X_OK)；异常一律视为不可执行。
// 优先使用注入判定，便于测试与沙箱。
// 抛错（ENOENT / EACCES / 网络盘挂起）一律按不可执行处理：此处 fail-closed，宁可退回 legacy-shell。
//
export function isExecutableCandidate(path: string, exists?: ExecutableCheck): boolean {
  if (exists) {
    return exists(path);
  }

  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
