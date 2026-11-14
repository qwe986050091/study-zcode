// INV-01 方言守卫与空路径检查必须排在一切 IO 之前。守住位置：getOrCreate 的第一个 if。改错故障：cmd/legacy 也去生成快照，source 时整段初始化报错。
// INV-02 cache 存的是 Promise，且必须先查后建。守住位置：getOrCreate 中 cache.get 与 cache.set 的先后。改错故障：并发首次调用各生成一份，多跑登录 shell 并留下多余文件。
// INV-03 create 的失败必须被 catch 成 undefined，拒绝态不得进入缓存。守住位置：getOrCreate 结尾的 .catch。改错故障：调用方收到未处理的拒绝，Bash 启动被快照故障拖垮。
// INV-04 缓存键必须同时包含 rootDir、方言、shellPath。守住位置：cacheKey 的数组拼接。改错故障：不同工作区或不同 shell 复用同一快照，PATH 与环境错配。
// INV-05 快照目录只允许由 shellInitSnapshotsDir 一处拼出。守住位置：shellInitSnapshotsDir。改错故障：生成与清理指向不同目录，过期清理永远删不到文件。
// INV-06 git-bash 方言必须把主进程路径转成 shell 可见路径。守住位置：create 里 snapshotShellPath 的三元表达式。改错故障：source 收到 C:\ 形式路径，git-bash 打不开文件。
// INV-07 快照文件名必须带时间戳与随机段。守住位置：createSnapshotFileName。改错故障：同毫秒并发或残留文件互相覆盖，改掉其他会话正在用的快照。
// INV-08 生成脚本必须以 -c -l 登录模式执行。守住位置：create 中 execFile 的参数数组前两项。改错故障：读不到用户 profile，快照里缺 alias、function 与 PATH。
// INV-09 两次子进程调用都必须带 timeout 与 maxBuffer。守住位置：create 与 resolveSnapshotPathValue 的 options。改错故障：病态 .zshrc 卡死进程或输出撑爆内存。
// INV-10 只 source 已存在的配置文件，并重定向标准输入。守住位置：buildShellInitSnapshotCreationScript 的 configSourceLine。改错故障：登录脚本等待交互输入，生成阶段超时。
// INV-11 快照文件必须用 >| 清空重写。守住位置：脚本里写入 "# Snapshot file" 的那行。改错故障：在开了 noclobber 的 shell 下直接写入失败，快照为空。
// INV-12 PATH 必须经 heredoc 与单引号转义写入。守住位置：pathExportLines。改错故障：路径中的 $ 与反引号被二次展开，PATH 被截断或注入。
// INV-13 脚本末尾必须校验快照文件存在，缺失时 exit 1。守住位置：buildShellInitSnapshotCreationScript 末尾的 if。改错故障：生成失败被静默吞掉，调用方拿到指向空文件的结果。
// INV-14 生成后必须 stat 并确认是普通文件。守住位置：create 的 try/stat 段。改错故障：把目录或其它条目当成快照返回，执行阶段 source 报错。
// INV-15 只有生成成功才允许登记 cleanupRegistry。守住位置：create 中 register 的调用位置。改错故障：登记未生成的文件，清理统计与真实生成数不一致，掩盖失败。
// INV-16 cleanupAll 必须先把 Set 转成数组再 clear。守住位置：cleanupAll 的前两行。改错故障：遍历期间被新登记插入，迭代顺序不确定导致漏删。
// INV-17 ENOENT 视为已处理，其它错误才计入 errors 且不中断。守住位置：两处 catch 里的 isMissingFileError 判断。改错故障：文件已删仍报错，或单个坏文件阻断整批清理。
// INV-18 过期清理只删 mtime 早于截止时间且扩展名为 .sh 的普通文件。守住位置：cleanupStaleShellInitSnapshots 的循环体。改错故障：误删保留期内快照，会话恢复时无快照可用。
//
// 模块职责：把用户 .bashrc/.zshrc 里的 alias、function、shell option 与 PATH 固化成一份可 source 的 .sh，供 Bash 工具复用登录环境。
// 状态所有权：Promise 缓存与待清理登记表都归 ShellInitSnapshotManager 实例所有，进程退出即失效；磁盘快照是唯一持久产物，按 mtime 过期。
// 阅读顺序：先看方言守卫与缓存入口 getOrCreate，再看 create 的路径/脚本/execFile 三段，最后看 cleanupStaleShellInitSnapshots 与 revalidate 两条善后路径。
// ============================================================
// 文件定位：Shell 初始化快照（把用户 .bashrc/.zshrc 的 alias/function/option/PATH 固化成 .sh）。
// 输入输出：getOrCreate 输出 snapshot 路径（含 bash 可 source 的路径）；失败返回 undefined。
// 副作用：mkdir 会话目录、spawn `shell -c -l` 生成快照（10s 超时/1MB 上限）、unlink 清理。
// 失败语义：探测/执行/stat 失败统一降级为 undefined，Bash 照常运行只是没有 init 快照。
// 不变量：同一 (rootDir,dialect,shellPath) 只生成一份（Promise 缓存）；快照按 mtime 保留 N 天。
// ============================================================
import {
  execFile as execFileCallback,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { windowsPathToGitBashPath } from "@zcode/contracts";
import type { ExecutionShellDialect } from "@zcode/contracts";
import type { StartupShellDialect } from "./bash-startup-script.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// 快照生成是冷路径：给 10s 覆盖重型 .zshrc；上限 1MB 防止病态输出拖垮内存。
const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_BUFFER_BYTES = 1_048_576;

// 保留期常量是清理策略的唯一来源：cleanupStaleShellInitSnapshots 未显式传参时回退到它。
// 调小它会让刚生成、仍可能被复用宿主的快照被删掉；调大则陈旧快照长期占用磁盘。
// 30 天覆盖常见的跨版本升级窗口，使旧会话恢复时仍有机会命中历史快照。
// 该值只影响 mtime 过期清理，不参与 getOrCreate 的缓存判定，两者不要混为一谈。
// 导出它是为了让测试与调用方共用同一口径，避免测试里另写一个魔法数字。
// 若将来改为按数量或体积淘汰，必须在这里或清理函数内补齐契约，不要散落到调用点。
export const DEFAULT_SHELL_INIT_SNAPSHOT_RETENTION_DAYS = 30;

type ShellInitSnapshotExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

// 默认执行器：把回调式 execFile promisify，并把 stdout/stderr 统一转成字符串。
const defaultExecFile: ShellInitSnapshotExecFile = async (file, args, options) => {
  const execFileAsync = promisify(execFileCallback);
  const result = await execFileAsync(file, args, options);
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
};

// 只有 POSIX 语义 shell 支持 source 快照；cmd/legacy 不参与。
export type ShellInitSnapshotDialect = Extract<ExecutionShellDialect, "posix" | "git-bash">;
// shell 类型由可执行文件名推断，决定抓取 alias/function 的语法与配置文件。
export type ShellInitSnapshotShellKind = "bash" | "zsh" | "sh";

export interface ShellInitSnapshot {
  // 主进程可访问的绝对路径。
  path: string;
  // Bash 内可访问的路径（git-bash 下转成 /c/...）。
  shellPath: string;
}

export interface ShellInitSnapshotCleanupResult {
  // 成功删除的文件数（ENOENT 不计入 errors）。
  deleted: number;
  // 删除失败（非 ENOENT）的次数。
  errors: number;
}

export interface CleanupStaleShellInitSnapshotsOptions {
  // 以哪个时间点计算保留截止（测试可注入）。
  now?: Date;
  // 保留天数；缺省 30 天。
  retentionDays?: number;
  rootDir: string;
}

export interface ShellInitSnapshotRequest {
  // 生成快照时的环境（决定 HOME 与 PATH）。
  env: NodeJS.ProcessEnv;
  rootDir: string;
  shellDialect: StartupShellDialect;
  shellPath: string;
}

export interface ShellInitSnapshotManagerOptions {
  // 执行 shell 的注入点（测试可替换）。
  execFile?: ShellInitSnapshotExecFile;
}

// 快照目录固定为 <rootDir>/shell-snapshots，便于按目录整体清理。
export function shellInitSnapshotsDir(rootDir: string): string {
  return join(rootDir, "shell-snapshots");
}

// 已生成快照的待清理登记表：只登记本次运行产生的文件，避免误删历史快照。
export class ShellInitSnapshotCleanupRegistry {
  private readonly paths = new Set<string>();

  // 登记一个待清理路径；重复登记幂等。
  register(snapshotPath: string): void {
    this.paths.add(snapshotPath);
  }

  // 逐个 unlink 并累计结果；ENOENT 视为已删除成功，其他错误计入 errors 而不中断后续清理。
  async cleanupAll(): Promise<ShellInitSnapshotCleanupResult> {
    const paths = Array.from(this.paths);
    this.paths.clear();
    let deleted = 0;
    let errors = 0;

    for (const path of paths) {
      try {
        await unlink(path);
        deleted += 1;
      } catch (error) {
        if (isMissingFileError(error)) continue;
        errors += 1;
      }
    }

    return { deleted, errors };
  }
}

// 快照管理器：按请求键缓存 Promise，保证并发首次调用只生成一份；失败缓存的值为 undefined。
// 管理器是快照缓存的唯一所有者：cache 与 cleanupRegistry 都是私有字段，外部只能经由方法读结果。
// cache 的值是 Promise 而不是结果，目的是让同键并发调用在第一次 await 之前就完成登记。
// cleanupRegistry 只登记本进程生成的文件，历史快照由 cleanupStaleShellInitSnapshots 按 mtime 处理。
// 两个字段职责不可互换：cache 管复用，registry 管退出清理，缺任一个都会造成重复生成或磁盘泄漏。
// execFile 由构造函数注入，生产用 defaultExecFile，测试可换成内存实现而不触碰真实 shell。
// 管理器不持有定时器，过期清理必须由调用方显式触发，避免进程因残留句柄无法退出。
export class ShellInitSnapshotManager {
  private readonly cache = new Map<string, Promise<ShellInitSnapshot | undefined>>();
  private readonly cleanupRegistry = new ShellInitSnapshotCleanupRegistry();
  private readonly execFile: ShellInitSnapshotExecFile;

  constructor(options: ShellInitSnapshotManagerOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile;
  }

  // 获取或生成快照：不支持的方言/空 shellPath 立即返回 undefined，不产生 IO。
  // 并发调用复用同一个 Promise；生成失败被转成 undefined，避免拒绝污染缓存与调用方。
  // 这是模块唯一的对外入口，返回 undefined 表示「本次不提供 init 快照」，不是错误。
  // 不支持的方言或空 shellPath 在进入 IO 前直接 resolve undefined，避免无意义的目录创建。
  // 缓存键由 rootDir、方言、shellPath 三元组构成，任何一项变化都视为不同的快照需求。
  // 先查 cache 再创建：命中即复用同一个 Promise，这是并发去重的唯一手段。
  // create 的拒绝被 catch 成 undefined，保证返回的 Promise 永不 reject，也不会把失败写回缓存。
  // 失败同样被缓存，意味着同一进程内不会自动重试；要重试只能新建管理器实例，这是刻意的降级策略。
  getOrCreate(request: ShellInitSnapshotRequest): Promise<ShellInitSnapshot | undefined> {
    if (!supportsShellInitSnapshot(request.shellDialect) || request.shellPath.length === 0) {
      return Promise.resolve(undefined);
    }

    const snapshotRequest = {
      ...request,
      shellDialect: request.shellDialect,
    };
    const key = cacheKey(snapshotRequest);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const created = this.create(snapshotRequest).catch(() => undefined);
    this.cache.set(key, created);
    return created;
  }

  // 清理本次运行登记的全部快照（CLI 退出时调用）；不清缓存，缓存仅在进程内有效。
  async cleanup(): Promise<ShellInitSnapshotCleanupResult> {
    return await this.cleanupRegistry.cleanupAll();
  }

  // 实际生成：按 shell 类型建快照文件，source 用户配置后把 alias/function/option/PATH 写进去。
  // 任何一步失败（shell 非零退出、文件不存在/不是普通文件）都返回 undefined。
  private async create(
    request: ShellInitSnapshotRequest & { shellDialect: ShellInitSnapshotDialect },
  ): Promise<ShellInitSnapshot | undefined> {
    const shellKind = detectShellKind(request.shellPath);
    const snapshotsDir = shellInitSnapshotsDir(request.rootDir);
    await mkdir(snapshotsDir, { recursive: true });

    // 主进程路径与 shell 内路径必须同源：shellPath 只做格式转换，不重新拼目录。
    // git-bash 下必须转成 /c/... 形式，否则 source 时路径不可见。
    // posix 方言直接复用主进程路径，二者相等是预期行为，不要再额外做规范化。
    // 文件名自带时间戳与随机段，进程内不会覆盖他人快照，这是并发安全的最后一道兜底。
    // 路径生成后随即登记进 cleanupRegistry，只有登记过的文件才会在 cleanup 时被删除。
    const snapshotPath = join(snapshotsDir, createSnapshotFileName(shellKind));
    const snapshotShellPath =
      request.shellDialect === "git-bash"
        ? windowsPathToGitBashPath(snapshotPath)
        : snapshotPath;
    const configPath = detectShellInitConfigPath({
      env: request.env,
      shellPath: request.shellPath,
    });
    const pathValue = await this.resolveSnapshotPathValue(request);
    const creationScript = buildShellInitSnapshotCreationScript({
      configExists: existsSync(configPath),
      configPath,
      pathValue,
      shellKind,
      snapshotPath,
    });

    // 用 -l 登录模式启动才会读取用户 profile 类配置，普通 -c 拿不到完整环境。
    // 脚本通过参数数组传入，不拼 shell 字符串，避免路径里的空格与特殊字符被二次解释。
    // timeout 与 maxBuffer 是本模块唯一的资源闸门，超时或输出超限都会让这次调用被拒绝。
    // 拒绝在这里不捕获，交由 getOrCreate 的 catch 统一降级为 undefined。
    // env 原样透传，保证快照里的 PATH 与用户交互 shell 一致；改写它会产出与真实终端不符的快照。
    // windowsHide 抑制 Windows 下的控制台窗口闪现，去掉它会在 GUI 场景弹出黑框。
    await this.execFile(request.shellPath, ["-c", "-l", creationScript], {
      encoding: "utf8",
      env: request.env,
      maxBuffer: SNAPSHOT_MAX_BUFFER_BYTES,
      timeout: SNAPSHOT_TIMEOUT_MS,
      windowsHide: true,
    });

    try {
      const snapshotStat = await stat(snapshotPath);
      if (!snapshotStat.isFile()) return undefined;
    } catch {
      return undefined;
    }

    const result: ShellInitSnapshot = {
      path: snapshotPath,
      shellPath: snapshotShellPath,
    };
    this.cleanupRegistry.register(result.path);
    return result;
  }

  // 取得写入快照的 PATH：非 git-bash 直接用宿主 PATH；git-bash 先问登录 shell 的真实 $PATH。
  // 探测失败回退宿主 PATH，保证快照里始终有一条可用的 PATH。
  private async resolveSnapshotPathValue(
    request: ShellInitSnapshotRequest & { shellDialect: ShellInitSnapshotDialect },
  ): Promise<string> {
    if (request.shellDialect !== "git-bash") return request.env.PATH ?? "";

    try {
      const result = await this.execFile(request.shellPath, ["-lc", 'echo "$PATH"'], {
        encoding: "utf8",
        env: request.env,
        maxBuffer: SNAPSHOT_MAX_BUFFER_BYTES,
        timeout: SNAPSHOT_TIMEOUT_MS,
        windowsHide: true,
      });
      return result.stdout.trim() || request.env.PATH || "";
    } catch {
      return request.env.PATH ?? "";
    }
  }
}

// 按 mtime 清理过期快照：只删 *.sh 普通文件，目录缺失视为“无需清理”。
// 单文件失败（非 ENOENT）计入 errors 但继续处理其余文件。
// 清理是独立导出函数，不与管理器耦合，CLI 可在启动或退出阶段单独调用。
// 目录不存在视为无需清理，返回零结果而不是抛错，避免首次运行时产生噪音。
// 只处理目录项中的普通文件且扩展名必须是 .sh，防止误删同目录下的其它产物。
// 删除前要重新 stat 取 mtime，因为 readdir 返回的目录项不带时间信息。
// 单个文件失败只累加 errors 并继续，保证一个坏文件不会阻断整批清理。
export async function cleanupStaleShellInitSnapshots(
  options: CleanupStaleShellInitSnapshotsOptions,
): Promise<ShellInitSnapshotCleanupResult> {
  const snapshotsDir = shellInitSnapshotsDir(options.rootDir);
  const retentionDays = options.retentionDays ?? DEFAULT_SHELL_INIT_SNAPSHOT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * DAY_MS;
  const result: ShellInitSnapshotCleanupResult = { deleted: 0, errors: 0 };

  let entries;
  try {
    entries = await readdir(snapshotsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return result;
    return { deleted: 0, errors: 1 };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;

    const entryPath = join(snapshotsDir, entry.name);
    try {
      const fileStat = await stat(entryPath);
      if (fileStat.mtimeMs >= cutoffMs) continue;
      await unlink(entryPath);
      result.deleted += 1;
    } catch (error) {
      if (isMissingFileError(error)) continue;
      result.errors += 1;
    }
  }

  return result;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

// 方言守卫（带类型收窄）：只有 posix / git-bash 允许生成并 source 快照。
export function supportsShellInitSnapshot(
  shellDialect: StartupShellDialect | undefined,
): shellDialect is ShellInitSnapshotDialect {
  return shellDialect === "posix" || shellDialect === "git-bash";
}

// 依据可执行文件名判断 shell 类型：含 zsh→zsh、含 bash→bash，其余按 sh 处理。
export function detectShellKind(shellPath: string): ShellInitSnapshotShellKind {
  const name = basename(shellPath).toLowerCase();
  if (name.includes("zsh")) return "zsh";
  if (name.includes("bash")) return "bash";
  return "sh";
}

// 推断用户配置文件：zsh→~/.zshrc、bash→~/.bashrc、sh→~/.profile；HOME 优先，Windows 回退 USERPROFILE。
export function detectShellInitConfigPath(input: {
  env: NodeJS.ProcessEnv;
  shellPath: string;
}): string {
  const home = input.env.HOME || input.env.USERPROFILE || "";
  const shellKind = detectShellKind(input.shellPath);
  if (shellKind === "zsh") return join(home, ".zshrc");
  if (shellKind === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
}

// 生成“造快照”的 shell 脚本：先 source 用户配置（无配置则跳过），再清空/写入快照文件。
// 脚本本身只负责把 alias/function/option/PATH 导出成可再次 source 的文本，失败时 exit 1 让调用方感知。
// 该函数只拼脚本文本、不做 IO，便于单测覆盖「配置存在」与「配置缺失」两条分支。
// 配置存在才 source，且重定向标准输入，避免登录脚本里的交互式命令卡住生成。
// 快照路径与 PATH 一律走单引号转义，防止 $、反引号与单引号在写入时被展开。
// PATH 用带引号定界符的 heredoc 追加，保证内容按字面量落盘。
// 脚本末尾校验快照文件存在，缺失时以非零码退出，让失败的生成无法伪装成功。
export function buildShellInitSnapshotCreationScript(input: {
  configExists: boolean;
  configPath: string;
  pathValue?: string;
  shellKind: ShellInitSnapshotShellKind;
  snapshotPath: string;
}): string {
  const configSourceLine = input.configExists
    ? `source ${shellDoubleQuote(input.configPath)} < /dev/null`
    : "# No user config file to source";
  // 无配置文件时不导出 alias/function，只保留最小骨架，避免对系统默认环境做无意义快照。
  const exportLines = input.configExists
    ? snapshotExportLines(input.shellKind)
    : input.shellKind === "zsh"
      ? []
      : ['echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"'];

  return [
    `SNAPSHOT_FILE=${shellQuoteAlways(input.snapshotPath)}`,
    configSourceLine,
    "",
    "# First, create/clear the snapshot file",
    'echo "# Snapshot file" >| "$SNAPSHOT_FILE"',
    "",
    "# When this file is sourced, we first unalias to avoid conflicts",
    "# This is necessary because aliases get \"frozen\" inside function definitions at definition time,",
    "# which can cause unexpected behavior when functions use commands that conflict with aliases",
    'echo "# Unset all aliases to avoid conflicts with functions" >> "$SNAPSHOT_FILE"',
    'echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"',
    "",
    ...exportLines,
    ...pathExportLines(input.pathValue ?? ""),
    "",
    "# Exit silently on success, only report errors",
    'if [ ! -f "$SNAPSHOT_FILE" ]; then',
    '  echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2',
    "  exit 1",
    "fi",
  ].join("\n");
}

// 执行前复核快照仍存在；文件已被清理/删除时返回 undefined，让调用方退回普通 Bash。
// 执行前复核只做存在性检查，不重新生成；快照失效时调用方退回普通 Bash。
// 不能复用 getOrCreate 的缓存，因为文件可能已被过期清理或用户手动删除。
// access 抛错一律视为不可用，与生成阶段「失败即降级」保持同一语义。
export async function revalidateShellInitSnapshotForExecution(
  result: ShellInitSnapshot | undefined,
): Promise<ShellInitSnapshot | undefined> {
  if (!result) return undefined;

  try {
    await access(result.path);
    return result;
  } catch {
    return undefined;
  }
}

// 按 shell 类型生成导出行：zsh 用 setopt/typeset，bash 用 shopt/set/base64 保留函数体。
// 两路都过滤单下划线补全函数、最多 1000 条，并在 Windows(msys/cygwin) 剔除 winpty alias。
function snapshotExportLines(shellKind: ShellInitSnapshotShellKind): string[] {
  const aliasLines = [
    'echo "# Aliases" >> "$SNAPSHOT_FILE"',
    "# Filter out winpty aliases on Windows to avoid \"stdin is not a tty\" errors",
    "# Git Bash automatically creates aliases like \"alias node='winpty node.exe'\" for",
    "# programs that need Win32 Console in mintty, but winpty fails when there's no TTY",
    'if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then',
    "  alias | grep -v \"='winpty \" | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    "else",
    "  alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    "fi",
  ];

  if (shellKind === "zsh") {
    return [
      'echo "# Functions" >> "$SNAPSHOT_FILE"',
      "",
      "# Force autoload all functions first",
      "typeset -f > /dev/null 2>&1",
      "",
      "# Now get user function names - filter completion functions (single underscore prefix)",
      "# but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)",
      "typeset +f | grep -vE '^_[^_]' | while read func; do",
      '  typeset -f "$func" >> "$SNAPSHOT_FILE"',
      "done",
      "",
      'echo "# Shell Options" >> "$SNAPSHOT_FILE"',
      "setopt | sed 's/^/setopt /' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
      ...aliasLines,
    ];
  }

  return [
    'echo "# Functions" >> "$SNAPSHOT_FILE"',
    "",
    "# Force autoload all functions first",
    "declare -f > /dev/null 2>&1",
    "",
    "# Now get user function names - filter completion functions (single underscore prefix)",
    "# but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)",
    "declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do",
    "  # Encode the function to base64, preserving all special characters",
    '  encoded_func=$(declare -f "$func" | base64 )',
    "  # Write the function definition to the snapshot",
    "  echo \"eval \\\"\\$(echo '$encoded_func' | base64 -d)\\\" > /dev/null 2>&1\" >> \"$SNAPSHOT_FILE\"",
    "done",
    "",
    'echo "# Shell Options" >> "$SNAPSHOT_FILE"',
    "shopt -p | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    "set -o | grep \"on\" | awk '{print \"set -o \" $1}' | head -n 1000 >> \"$SNAPSHOT_FILE\"",
    'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"',
    ...aliasLines,
  ];
}

// PATH 用 heredoc 写入，避免路径里的 $ / 引号被二次展开；quoted delimiter 保证字面量。
function pathExportLines(pathValue: string): string[] {
  return [
    "",
    "# Add PATH to the file",
    "cat >> \"$SNAPSHOT_FILE\" << 'PATH_END_ZCODE_SHELL_INIT_SNAPSHOT'",
    `export PATH=${shellQuoteAlways(pathValue)}`,
    "PATH_END_ZCODE_SHELL_INIT_SNAPSHOT",
  ];
}

// 快照文件名：snapshot-<kind>-<时间戳>-<6 位随机>.sh，随机段避免同毫秒并发碰撞。
function createSnapshotFileName(shellKind: ShellInitSnapshotShellKind): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `snapshot-${shellKind}-${timestamp}-${random}.sh`;
}

// 缓存键：rootDir + 方言 + shell 绝对路径；三者变化即视为不同快照需求。
function cacheKey(request: ShellInitSnapshotRequest): string {
  return [request.rootDir, request.shellDialect, request.shellPath].join(":");
}

function shellQuoteAlways(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellDoubleQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}
