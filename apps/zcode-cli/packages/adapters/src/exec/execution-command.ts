// INV-01 环境构建不改动进程环境：守住位置 新建对象；改错故障 子进程配置污染父进程。
// INV-02 空环境起点可选：守住位置 基础判断；改错故障 需要隔离时仍继承全部变量。
// INV-03 运行时变量先清洗：守住位置 继承后调用；改错故障 代理与证书变量泄漏给工具。
// INV-04 文本编码注入与平台相关：守住位置 平台入参；改错故障 非 Windows 写入无效变量。
// INV-05 网络出口策略最后应用：守住位置 调用顺序；改错故障 洗干净的网络变量又被覆盖。
// INV-06 删除与设置分两步：守住位置 两个循环；改错故障 同名键残留旧值。
// INV-07 环境键比较按平台语义：守住位置 删除实现；改错故障 Windows 出现重复键。
// INV-08 已解析 shell 优先复用：守住位置 早退返回；改错故障 重复解析导致方言不一致。
// INV-09 仅 posix-bash 配置尝试 Git Bash：守住位置 配置判断；改错故障 系统 shell 被错误替换。
// INV-10 非 Windows 直接 argv：守住位置 平台分支；改错故障 多走一次扩展名解析。
// INV-11 Windows 可执行文件按候选查找：守住位置 解析函数；改错故障 命令找不到。
// INV-12 候选全不存在保留原值：守住位置 兜底返回；改错故障 在此处抛错掩盖真实原因。
// INV-13 批处理脚本强制走解释器：守住位置 扩展名判断；改错故障 直接 spawn 失败。
// INV-14 解释器路径取系统变量：守住位置 大小写不敏感读取；改错故障 自定义 ComSpec 被忽略。
// INV-15 方言跟随 provider：守住位置 字段透传；改错故障 cwd 转换用错规则。
// INV-16 登录 shell 可无副作用降级：守住位置 形态检查；改错故障 非该形态被改坏。
// INV-17 命令行替换保留登录标志：守住位置 参数重组；改错故障 降级后仍带登录参数。
// INV-18 未命中形态退化为整串命令：守住位置 末尾分支；改错故障 旧命令残留在参数里。
//
// 模块职责：把命令描述编译成可 spawn 的文件、参数、shell 与方言。
// 状态所有权：无状态；平台、环境与存在性探测都由调用方注入。
// 阅读顺序：先看环境构建，再看命令解析的三条分支，最后看登录模式与辅助函数。
// ============================================================
// 文件定位：把 ExecutionCommand 解析成可 spawn 的 file/args/shell/env，是 exec 与平台差异的唯一编译点。
// 输入输出：输入命令描述 + cwd/env/平台/已解析 shell；输出 ResolvedSpawnCommand（file、argv、方言）。
// 副作用：无（exists 默认 existsSync 只做探测；不创建进程）。
// 失败语义：找不到可执行文件时回退原始 file，由 spawn 报错；不在此处抛错。
// 不变量：Windows 下 .cmd/.bat 必须经 cmd.exe /d /s /c 执行；argv 模式绝不启用 shell:true。
// ============================================================
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { sanitizeZCodeRuntimeEnvInPlace } from "@zcode/shared";
import { applyNetworkEgressEnv, type NetworkEgressEnvPolicy } from "../network/subprocess-env.js";
import {
  resolveEffectiveBashShellSelection,
  type BashShellProvider,
} from "./bash-shell-provider.js";
import { applyExecutionTextEnv } from "./outputEncoding.js";
import { windowsExecutableCandidates } from "./windows-executable.js";
import type {
  ExecutionCommand,
  ExecutionEnvOverlay,
  ExecutionShellDialect,
} from "@zcode/contracts";

// Windows 下无法用 shell:false 直接 spawn 的批处理脚本扩展名。
const WINDOWS_COMMAND_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

export interface ResolvedSpawnCommand {
  // 传给 spawn 的 argv；shell 模式且 file 本身是命令行时为空。
  args: string[];
  // 生成 cwd 时的路径方言：cmd 需 Windows 路径，posix/git-bash 需对应 POSIX 路径。
  cwdDialect: ExecutionShellDialect;
  // 仅覆盖本命令的环境变量增量（如 SHELL/GIT_EDITOR），合并进基础 env。
  envOverlay?: Record<string, string>;
  // 可执行文件绝对路径，或 shell 模式下的完整命令行字符串。
  file: string;
  // false=直接 exec；true=系统默认 shell；字符串=指定 shell 可执行文件。
  shell: boolean | string;
  // true 表示 argv 以 `-c -l` 启动（登录 shell），后续可被 setResolvedShellLoginMode 降级。
  usesLoginShell?: boolean;
}

// 合并基础环境：继承 process.env → 清洗 ZCode 运行时变量 → 注入文本编码 → 应用网络出口策略
// → 应用 overlay 的 unset/set（Windows 下键名大小写不敏感地删除/覆盖）。
// 返回全新对象，绝不原地修改 process.env；overlay.base === "empty" 时从空环境起步。
// buildExecutionEnv 默认从 process.env 复制，不原地修改原对象。
// overlay.base === "empty" 时跳过继承与清洗。
// 文本编码在 applyNetworkEgressEnv 之前注入。
// overlay 的 unset 删除先于 set 设置。
export function buildExecutionEnv(
  overlay?: ExecutionEnvOverlay,
  options: {
    network?: NetworkEgressEnvPolicy;
    platform?: NodeJS.Platform;
    processEnv?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.processEnv ?? process.env;
  const env: Record<string, string> = {};

  if (overlay?.base !== "empty") {
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    // Bash/tool 子进程不能直接继承运行时的 NODE_ENV、http_proxy 或证书变量。
    // 网络变量会在 applyNetworkEgressEnv 中从 ZCode 内部封存恢复，避免 app/provider 运行时先被污染。
    sanitizeZCodeRuntimeEnvInPlace(env);
  }

  applyExecutionTextEnv(env, platform);

  applyNetworkEgressEnv(env, {
    network: options.network,
    platform,
    sourceEnv,
    toolEnvPassthrough: overlay?.base !== "empty",
  });

  for (const key of overlay?.unset ?? []) {
    deleteEnvKey(env, key, platform);
  }

  for (const [key, value] of Object.entries(overlay?.set ?? {})) {
    setEnvKey(env, key, value, platform);
  }

  return env;
}

// 解析执行方式：shell 模式选 Bash provider 或系统 shell；argv 模式在 Windows 上做可执行文件查找。
// 优先级：已解析的 resolvedShell > posix-bash provider > 系统 shell；Windows 批处理 shim 强制走 cmd.exe。
// 纯函数：不做存在性假设之外的动作，找不到时返回原始 file 让 spawn 自行报 ENOENT。
// 已解析 shell 只替换命令行文本。
// 仅 posix 配置尝试外部 bash。
// 其余 shell 模式交给系统 shell。
// argv 模式在 Windows 才需要查扩展名。
export function resolveExecutionCommand(
  command: ExecutionCommand,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
    resolvedShell?: ResolvedSpawnCommand;
  } = {},
): ResolvedSpawnCommand {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (command.mode === "shell") {
    // 调用方已提前解析好 shell（含登录模式开关），这里只替换命令行本体。
    if (options.resolvedShell) {
      return applyResolvedShellCommand(options.resolvedShell, command.command);
    }

    // 只有 posix-bash profile 才尝试 Git Bash / POSIX bash；失败则继续走系统 shell。
    if (command.shellProfile === "posix-bash") {
      const resolution = resolveEffectiveBashShellSelection({
        env,
        exists: options.exists,
        override: command.shellOverride,
        platform,
      });
      if (resolution.provider) {
        return createShellProviderCommand(resolution.provider, command.command);
      }
    }

    return {
      args: [],
      cwdDialect: defaultCwdDialect(platform),
      file: command.command,
      shell: resolveShell(command.shell, env, platform),
    };
  }

  // 非 Windows 直接 argv 执行，无需扩展名解析。
  if (platform !== "win32") {
    return {
      args: command.args ?? [],
      cwdDialect: "posix",
      file: command.file,
      shell: false,
    };
  }

  const resolvedFile = resolveWindowsExecutable(command.file, {
    cwd: options.cwd,
    env,
    exists: options.exists,
  });
  if (!isWindowsCommandShim(resolvedFile)) {
    return {
      args: command.args ?? [],
      cwdDialect: "cmd",
      file: resolvedFile,
      shell: false,
    };
  }

  // Note: Windows .cmd/.bat shims cannot be spawned directly with shell:false.
  // Route them through cmd.exe while keeping normal .exe argv execution shell-free.
  return {
    args: createCmdShimArgs(resolvedFile, command.args ?? []),
    cwdDialect: "cmd",
    file: getEnvValue(env, "ComSpec", "win32") ?? "cmd.exe",
    shell: false,
  };
}

function createShellProviderCommand(
  provider: BashShellProvider,
  command: string,
): ResolvedSpawnCommand {
  // cmd 方言本身就是命令行解释器，直接以 file=命令文本 + shell 执行，不加 -c。
  if (provider.dialect === "cmd") {
    return {
      args: [],
      cwdDialect: provider.dialect,
      envOverlay: provider.envOverlay,
      file: command,
      shell: provider.shell,
    };
  }

  // bash/zsh 采用 `-c -l` 登录模式；mark usesLoginShell 以便失败时可无副作用地降级。
  return {
    args: ["-c", "-l", command],
    cwdDialect: provider.dialect,
    envOverlay: provider.envOverlay,
    file: provider.file,
    shell: provider.shell,
    usesLoginShell: true,
  };
}

// 在保留命令行不变的前提下切换登录/非登录 shell；仅对“provider 直接 exec + -c -l”形态生效。
// 不满足形态时原样返回同一对象，调用方可据引用相等判断“无需更新”。
// setResolvedShellLoginMode 只处理 shell === false 且带 usesLoginShell 的形态。
// 命令行取 args.at(-1) 末位。
// 重组 args 时按 useLoginShell 决定是否保留 -l 参数。
export function setResolvedShellLoginMode(
  resolved: ResolvedSpawnCommand,
  useLoginShell: boolean,
): ResolvedSpawnCommand {
  if (resolved.shell !== false || resolved.args[0] !== "-c") return resolved;
  if (resolved.usesLoginShell !== true) return resolved;

  const command = resolved.args.at(-1) ?? "";
  return {
    ...resolved,
    args: useLoginShell ? ["-c", "-l", command] : ["-c", command],
  };
}

// 用新的命令行文本替换已解析命令：cmd 方言替换 file，bash 形态只换 argv 末尾的命令串并保留登录标志。
// 其余形态（shell:true）退化为 file=命令行、args=[]，与 Node spawn(shell) 的语义一致。
// cmd 方言直接替换整条命令行。
// usesLoginShell 形态保留 -l 标志只换 args 末位。
// 其他形态退化为文件即命令行。
export function applyResolvedShellCommand(
  resolved: ResolvedSpawnCommand,
  command: string,
): ResolvedSpawnCommand {
  if (resolved.cwdDialect === "cmd") {
    return {
      ...resolved,
      args: [],
      file: command,
    };
  }

  if (resolved.shell === false && resolved.args[0] === "-c" && resolved.usesLoginShell === true) {
    const useLoginShell = resolved.args[1] === "-l";
    return {
      ...resolved,
      args: useLoginShell ? ["-c", "-l", command] : ["-c", command],
    };
  }

  return {
    ...resolved,
    args: [],
    file: command,
  };
}

// 测试用别名：暴露内部实现，避免为测试改变生产导出面。
export const applyResolvedShellCommandForTest = applyResolvedShellCommand;

// 各平台默认 cwd 路径方言：Windows 用 cmd 语义（反斜杠/盘符），其余用 posix。
export function defaultCwdDialect(platform: NodeJS.Platform): ExecutionShellDialect {
  return platform === "win32" ? "cmd" : "posix";
}

function resolveShell(
  shell: true | string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): true | string {
  // 显式 shell 字符串原样保留；未指定时 Windows 取 ComSpec，其余交给 Node 的 /bin/sh。
  if (typeof shell === "string") return shell;
  if (platform === "win32") {
    return getEnvValue(env, "ComSpec", "win32") ?? "cmd.exe";
  }
  return true;
}

// Windows 可执行文件解析：按 PATHEXT/PATH 生成候选并取第一个存在的；全不存在时保留原值。
function resolveWindowsExecutable(
  file: string,
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
  },
): string {
  const exists = options.exists ?? existsSync;
  const candidates = windowsExecutableCandidates(file, options.env, options.cwd);
  return candidates.find((candidate) => exists(candidate)) ?? file;
}

function isWindowsCommandShim(file: string): boolean {
  return WINDOWS_COMMAND_SHIM_EXTENSIONS.has(extname(file).toLowerCase());
}

// .cmd/.bat 必须交给 cmd.exe：用 `/d /s /c` 关闭 AutoRun、按原样解析并执行整条命令行。
function createCmdShimArgs(file: string, args: string[]): string[] {
  const commandLine = [file, ...args].map(quoteCmdArgument).join(" ");
  return ["/d", "/s", "/c", commandLine];
}

// cmd 参数转义：空串保留为 ""；含空白/元字符时整体加引号并对 cmd 元字符加 ^ 转义。
function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"%&()<>^|]/.test(value)) return value;
  return `"${value.replace(/(["%&()<>^|])/g, "^$1")}"`;
}

// Windows 环境变量名大小写不敏感：写入前先按键名不区分大小写地删除旧值，避免同一键出现两份。
function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  deleteEnvKey(env, key, platform);
  env[key] = value;
}

// 按平台语义删除环境变量键：POSIX 精确匹配，Windows 遍历所有大小写变体一并删除。
function deleteEnvKey(env: Record<string, string>, key: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }

  const lowerKey = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === lowerKey) {
      delete env[existingKey];
    }
  }
}

// 读取环境变量：Windows 下按键名大小写不敏感查找，其余平台直接取值。
function getEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const lowerKey = key.toLowerCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return actualKey ? env[actualKey] : undefined;
}
