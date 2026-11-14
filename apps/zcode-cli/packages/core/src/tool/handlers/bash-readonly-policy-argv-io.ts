/**
 * Bash 命令"外围噪声"的只读约束：环境变量前缀白名单、重定向白名单、Windows UNC 路径、
 * 以及 command/builtin/noglob 这类不改变实际执行体的 wrapper 剥离。
 * 被 bash-readonly-policy-argv.ts（判定入口）与 -argv-direct.ts（docker 前缀）复用。
 * 口径：只允许明确无写入、无网络效应的前缀与重定向；不认识的形态一律返回 false，
 * wrapper 无法剥净时原样返回，让后续白名单查不到命令而退回不可读。
 */

import type { BashCommandInvocation } from "./bash-command-parser.js";

// 只收录输出/颜色/编码/区域/构建开关类变量；PATH、LD_PRELOAD、GIT_* 等能改变后续执行行为的
// 变量故意不在此列，出现即整条命令判不可读。
const SAFE_ENV_ASSIGNMENTS = new Set([
  "ANTHROPIC_API_KEY",
  "BLOCK_SIZE",
  "BLOCKSIZE",
  "CGO_ENABLED",
  "CHARSET",
  "CI",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLORTERM",
  "COLUMNS",
  "DEBIAN_FRONTEND",
  "FORCE_COLOR",
  "GCC_COLORS",
  "GIT_TERMINAL_PROMPT",
  "GO111MODULE",
  "GOARCH",
  "GOEXPERIMENT",
  "GOOS",
  "GREP_COLOR",
  "GREP_COLORS",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_TIME",
  "LINES",
  "LSCOLORS",
  "LS_COLORS",
  "NO_COLOR",
  "NODE_ENV",
  "PYTEST_DEBUG",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
  "PYTHONDONTWRITEBYTECODE",
  "PYTHONUNBUFFERED",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "TERM",
  "TIME_STYLE",
  "TZ",
]);

export function areEnvAssignmentsAllowed(commandPart: BashCommandInvocation): boolean {
  // 赋值名缺失（动态变量名）或不在白名单，都无法确认不会改写执行环境，直接拒绝。
  return commandPart.envAssignments.every((assignment) => {
    return assignment.name !== undefined && SAFE_ENV_ASSIGNMENTS.has(assignment.name);
  });
}

// 只允许"喂输入"的重定向：<、<<、<&、<<<；`>`/`>>`/`&>` 都会写文件。
const SAFE_INPUT_REDIRECTS = new Set(["<", "<<", "<&", "<<<"]);

export function areRedirectsAllowed(commandPart: BashCommandInvocation): boolean {
  for (const redirect of commandPart.redirects) {
    // /dev/tcp、/dev/udp 是 bash 的网络重定向，不是本地文件读写。
    if (isUnsafeDeviceRedirectTarget(redirect.target)) return false;
    // `2>&1` 这类 fd 复制只改输出流向，不触碰文件系统。
    if (redirect.operator === ">&" && /^\d+$/.test(redirect.target)) continue;
    if (redirect.target === "/dev/null") continue;
    if (SAFE_INPUT_REDIRECTS.has(redirect.operator)) {
      // Windows 上 UNC 输入路径会走 SMB，可能阻塞或访问远端。
      if (isUnsafeWindowsUncPath(redirect.target)) return false;
      continue;
    }
    // 其余（>、>>、&>、>&file 等）一律视为写文件。
    return false;
  }
  return true;
}

function isUnsafeDeviceRedirectTarget(target: string): boolean {
  return /^\/dev\/(?:tcp|udp)\//.test(target);
}

export function isUnsafeWindowsUncPath(value: string): boolean {
  // `//host/...` 与 `\\host\...` 在 Windows 上是 UNC 路径，读取会触发网络访问。
  return /^(?:\/\/|\\\\)[^/\\]/.test(value);
}

export function stripSafeCommandWrappers(argv: readonly string[]): readonly string[] {
  let stripped = [...argv];
  for (;;) {
    if (stripped[0] === "command") {
      let index = 1;
      while (stripped[index] !== undefined && /^-p+$/.test(stripped[index] ?? "")) index += 1;
      if (stripped[index] === "--") index += 1;
      // 剥不掉（后面仍是 flag 或已到末尾）就原样返回，让调用方查不到命令、判不可读。
      if (index >= stripped.length || stripped[index]?.startsWith("-")) return stripped;
      stripped = stripped.slice(index);
      continue;
    }
    if (stripped[0] === "builtin") {
      const index = stripped[1] === "--" ? 2 : 1;
      if (index >= stripped.length) return stripped;
      stripped = stripped.slice(index);
      continue;
    }
    // noglob 只关闭 glob 展开，不影响实际执行的命令。
    if (stripped[0] === "noglob") {
      if (stripped.length <= 1) return stripped;
      stripped = stripped.slice(1);
      continue;
    }
    return stripped;
  }
}
