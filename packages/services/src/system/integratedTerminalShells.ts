// 集成终端 shell 探测：只回答「本机有哪些可选 shell」，不启动进程也不缓存结果；
// INV-01：id 内嵌可执行路径且全局唯一（守住：两处 id 拼接），冲突会让持久化的默认 shell 指错解释器。
// INV-02：候选必须先过 isExecutableCandidate 才可返回（守住：两处探测循环），否则到 spawn 才失败。
// INV-03：env 名按 Windows 大小写不敏感语义解析（守住：getWindowsEnvValue），否则静默退回错误默认值。
import { accessSync, constants as fsConstants } from "node:fs";
import { win32 } from "node:path";
import type { IntegratedTerminalShellOption } from "@zcode/shared";

// 可执行性判定做成可注入依赖：生产用 accessSync(X_OK)，单测可给固定集合，
// 从而在 Linux CI 上验证 win32 分支，不必伪造真实 Git 安装。
type ExecutableCheck = (path: string) => boolean;

// [权衡] 只枚举两个 Git for Windows 默认安装目录，不做全盘搜索：全盘搜索在
// 机械盘上扫描可能耗时数秒，而本函数 listIntegratedTerminalShellOptions 位于同步渲染路径；装在自定义目录的
// 用户由 PATH 反推分支兜底，代价是必须能从 git.exe 定位到同级 bash.exe。
const WINDOWS_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
] as const;

// 返回顺序即下拉框顺序：CMD 恒为第一项，Git Bash 仅在探测成功时追加；
// 非 Windows 返回空数组而非抛错，「没有可选值」等价于沿用系统默认 shell。
// options.platform 显式注入而非读 process.platform，使 win32 分支可在任意宿主上被单测覆盖。
export function listIntegratedTerminalShellOptions(options: {
  env: NodeJS.ProcessEnv;
  isExecutable?: ExecutableCheck;
  platform: NodeJS.Platform;
}): IntegratedTerminalShellOption[] {
// [失败路径] 非 win32 提前返回：后续 win32.dirname/join 与 PATHEXT 语义在
// POSIX 上会产出看似合法但不可用的路径，宁可空集也不能给出错误候选。
  if (options.platform !== "win32") {
    return [];
  }

  // CMD 无条件加入候选：即使 isExecutable 判定失败，系统也总能通过 ComSpec 找到解释器。
  const shellOptions: IntegratedTerminalShellOption[] = [createCommandPromptOption(options.env)];
// [失败路径] undefined 是「未安装 Git」的正常结果而非异常：此时设置页只展示
// CMD 即可，探测内部已把文件系统错误收敛成 false，这里无需再包 try/catch。
  // env 来自装配层，单测可注入伪造的 PATH/PATHEXT，从而在非 Windows 宿主上覆盖 win32 分支。
  const gitBash = resolveWindowsGitBash(options.env, options.isExecutable);
  if (gitBash) {
    shellOptions.push({
      dialect: "git-bash",
      id: `git-bash:${gitBash.path}`,
      label: "Git Bash",
      path: gitBash.path,
      source: gitBash.source,
    });
  }

  return shellOptions;
}

// ComSpec 是系统登记的命令解释器路径，优先于字面量 cmd.exe：精简镜像与
// 32 位子系统上 cmd.exe 可能不在 PATH，只有 ComSpec 指向真实位置。
// trim 后为空视为未设置，防止空字符串拼出无法解析的 id（如 cmd:）。
function createCommandPromptOption(env: NodeJS.ProcessEnv): IntegratedTerminalShellOption {
  // 返回给调用方的是可持久化的 id 与 path，因此 ComSpec 缺失时必须给字面量兜底。
  const path = getWindowsEnvValue(env, "ComSpec")?.trim() || "cmd.exe";
  return {
    dialect: "cmd",
    id: `cmd:${path}`,
    label: "CMD",
    path,
// source=system 供 UI 区分「系统内置不可删」与「来自 PATH 可隐藏」，不要改成 path。
    source: "system",
  };
}

// 探测顺序固定：先 Git for Windows 默认目录，再从 PATH 的 git.exe 反推 bash。
// 默认目录优先是因为 IDE/服务启动的进程常拿到被裁剪的 PATH；反推分支覆盖
// 便携版与自定义安装。两处都命中时取默认目录，结果稳定优先于版本最新。
function resolveWindowsGitBash(
  env: NodeJS.ProcessEnv,
  isExecutable?: ExecutableCheck,
): { path: string; source: "system" | "path" } | undefined {
  // 逐个 accessSync 探测，任一命中即停止；探测失败只让该候选退出，不向上抛异常。
  for (const candidate of WINDOWS_GIT_BASH_PATHS) {
    if (isExecutableCandidate(candidate, isExecutable)) {
      return { path: candidate, source: "system" };
    }
  }

  // PATH 反推是自定义安装目录的唯一兜底，找不到 git.exe 时返回 undefined，调用方只展示 CMD。
  const gitExe = windowsExecutableCandidates("git", env).find((candidate) =>
    isExecutableCandidate(candidate, isExecutable),
  );
  if (!gitExe) {
    return undefined;
  }

  const inferred = inferWindowsGitBashPathsFromGitExe(gitExe).find((candidate) =>
    isExecutableCandidate(candidate, isExecutable),
  );
  return inferred ? { path: inferred, source: "path" } : undefined;
}

// git.exe 的两类真实布局：<root>/cmd/git.exe 上跳一级到 <root>/bin/bash.exe；
// <root>/mingw64/bin/git.exe 上跳两级。两个候选都返回交由调用方探测，
// 不靠路径特征猜布局，避免 Git 调整目录结构后这里静默失效。
function inferWindowsGitBashPathsFromGitExe(gitExe: string): string[] {
  const gitDir = win32.dirname(gitExe);
  return [
    win32.normalize(win32.join(gitDir, "..", "bin", "bash.exe")),
    win32.normalize(win32.join(gitDir, "..", "..", "bin", "bash.exe")),
  ];
}

// 近似复刻 cmd.exe 的解析：命令含分隔符即视为显式路径直接采用；否则按
// PATH 目录 × PATHEXT 后缀展开；不查 App Paths 注册表也不展开 8.3 短名，
// 多一层解析会让结果与环境实际的搜索顺序不一致。
function windowsExecutableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (/[\\/]/.test(command)) {
    return [command];
  }

  const pathValue = getWindowsEnvValue(env, "PATH");
  if (!pathValue) {
    return [command];
  }

  const extensions = windowsExecutableExtensions(env);
  return pathValue
    .split(win32.delimiter)
    .filter((entry) => entry.trim().length > 0)
    .flatMap((entry) => extensions.map((extension) => win32.join(entry, `${command}${extension}`)));
}

// PATHEXT 缺失时用 Windows 标准集合兜底，并统一小写：Windows 文件系统
// 大小写不敏感，后续要与 .exe 做包含判断，混杂大小写会漏配。
function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const rawExtensions = getWindowsEnvValue(env, "PATHEXT")?.split(win32.delimiter) ?? [
    ".COM",
    ".EXE",
    ".BAT",
    ".CMD",
  ];
  const normalized = rawExtensions
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.length > 0);
  return normalized.includes(".exe") ? normalized : [".exe", ...normalized];
}

// 遍历 key 做不区分大小写的精确匹配（非前缀匹配）：ProcessEnv 是普通对象，
// env[ComSpec] 在非 Windows 宿主上取不到 env[COMSPEC]。
function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}

// isExecutableCandidate 是 INV-02 的唯一收口点，调用方不得绕过；accessSync 对不存在或无权限路径会直接抛错，
// 非法路径一律抛错，统一收敛为 false，让单个候选退出竞争而不中断整轮探测。
function isExecutableCandidate(path: string, isExecutable?: ExecutableCheck): boolean {
  if (isExecutable) {
    return isExecutable(path);
  }

  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
