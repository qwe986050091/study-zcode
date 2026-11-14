/* ============================================================
 * MCP stdio 进程树回收（adapters/src/mcp/process-tree.ts）
 *
 * 定位：transport dispose 的最后一道兜底，确保 MCP server 及其后代全部退出，
 * 覆盖 Windows（taskkill /T /F）与 POSIX（pgrep/ps 枚举后代 + 逐级信号升级）。
 * 输入：根 pid、可注入的 execFile/kill/now/sleep/platform。
 * 输出：Promise<void>；成功即全部确认退出，失败抛 Error（带残留 pid）。
 * 副作用：spawn pgrep/ps/taskkill 子进程、向目标进程发信号、轮询 sleep。
 * 失败语义：枚举命令失败时退化为空后代列表但继续杀根进程；Windows 仅在
 * taskkill 失败且根进程仍存活时抛错；POSIX 在 SIGKILL 后仍有存活者时抛错。
 * 不变量：只杀自己枚举到的 pid（含根），不广域杀进程组；关闭路径幂等，
 * 信号重复发送与“进程已退出”一律忽略；后代列表反转后由深到浅发送。
 * ============================================================ */

import { execFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

// 时间预算：枚举命令 1s；POSIX 三阶段依次 250ms/750ms/250ms，轮询 25ms；
// Windows taskkill 最长 2s。总关闭耗时上界约 2.5s（POSIX）/ 2s（Windows）。
const PROCESS_LOOKUP_TIMEOUT_MS = 1_000;
const POSIX_PROCESS_TREE_GRACE_MS = 250;
const POSIX_PROCESS_TREE_FORCE_MS = 750;
const POSIX_PROCESS_TREE_VERIFY_MS = 250;
const POSIX_PROCESS_TREE_POLL_MS = 25;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

/** 外部命令结果：error 为 execFile 异常，status 为退出码（被杀/无 code 时为 null）。 */
interface CommandResult {
  error?: unknown;
  status: number | null;
  stderr: string;
  stdout: string;
}

type KillFn = typeof process.kill;
type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<CommandResult>;

/**
 * 注入点与平台覆盖。execFile/kill/now/sleep 便于单测不触碰真实进程；
 * platform 缺省 process.platform。全部只读，不持久化。
 */
export interface McpStdioProcessTreeTerminatorOptions {
  execFile?: ExecFileFn;
  kill?: KillFn;
  now?: () => number;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 回收整棵 MCP stdio 进程树。
 *
 * Windows 走 taskkill /T /F；其它平台走 POSIX 信号升级流程。
 * 根 pid 不存在时立即返回（幂等）。失败以 Error 抛出，由 transport 的 best-effort
 * dispose 决定是否吞掉；本函数不重试（POSIX 内部的升级本身就是分阶段重试）。
 */
export async function terminateMcpStdioProcessTree(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions = {},
): Promise<void> {
  const platform = getPlatform(options);
  if (platform === "win32") {
    await terminateWindowsProcessTree(pid, options);
    return;
  }

  await terminatePosixProcessTree(pid, options);
}

function isProcessAlive(pid: number, options: McpStdioProcessTreeTerminatorOptions): boolean {
  const kill = options.kill ?? process.kill;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPERM"
  );
}

function getPlatform(options: McpStdioProcessTreeTerminatorOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parsePidList(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function getPosixProcessListArgs(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["-axo", "pid=,ppid="] : ["-eo", "pid=,ppid="];
}

function parseChildPidsFromProcessList(stdout: string, parentPid: number): number[] {
  const children: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (Number.isInteger(pid) && pid > 0 && ppid === parentPid) {
      children.push(pid);
    }
  }
  return children;
}

/**
 * 枚举直接子进程：优先 pgrep -P（轻量），失败再回退 ps -eo/axo 过滤 ppid。
 * 两条路径都失败返回空数组——调用方仍会杀根进程，不会因枚举失败放弃关闭。
 * 超时由子命令 timeout 控制，避免关闭路径被卡死。
 */
async function collectChildPids(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions,
): Promise<number[]> {
  const pgrepResult = await runCommand(
    "pgrep",
    ["-P", String(pid)],
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    },
    options,
  );
  if (!pgrepResult.error && pgrepResult.status === 0 && pgrepResult.stdout) {
    return parsePidList(String(pgrepResult.stdout));
  }

  const psResult = await runCommand(
    "ps",
    getPosixProcessListArgs(getPlatform(options)),
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    },
    options,
  );
  if (psResult.error || psResult.status !== 0 || !psResult.stdout) return [];

  return parseChildPidsFromProcessList(String(psResult.stdout), pid);
}

/** 递归枚举后代 pid（深度优先）；seen 防环，避免异常父子关系造成无限递归。 */
async function collectDescendantPids(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions,
  seen = new Set<number>(),
): Promise<number[]> {
  if (seen.has(pid)) return [];
  seen.add(pid);

  const descendants: number[] = [];
  for (const childPid of await collectChildPids(pid, options)) {
    descendants.push(childPid, ...(await collectDescendantPids(childPid, options, seen)));
  }
  return descendants;
}

function uniquePids(pids: number[]): number[] {
  return [...new Set(pids.filter((pid) => pid > 0))];
}

function killPid(
  pid: number,
  signal: NodeJS.Signals,
  options: McpStdioProcessTreeTerminatorOptions,
): void {
  const kill = options.kill ?? process.kill;
  try {
    kill(pid, signal);
  } catch {
    // 进程可能已经被 SDK close 或前一轮信号回收；关闭路径要求幂等。
  }
}

function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  options: McpStdioProcessTreeTerminatorOptions,
): void {
  const kill = options.kill ?? process.kill;
  try {
    kill(-pid, signal);
  } catch {
    // SDK 当前没有 detached spawn，进程组可能不存在；保留兼容未来 launcher 的能力。
  }
}

/**
 * Windows：taskkill /T 杀整棵树。
 * 先探测根进程存活，已退出直接返回；taskkill 失败且根仍存活才抛错，
 * 失败但根已退出视为成功（子进程可能已被系统/Job Object 回收）。
 */
async function terminateWindowsProcessTree(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions,
): Promise<void> {
  if (!isProcessAlive(pid, options)) return;

  const result = await runCommand(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    {
      encoding: "utf8",
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    },
    options,
  );
  if (didTerminationFail(result) && isProcessAlive(pid, options)) {
    throw new Error(
      `taskkill failed for MCP stdio process tree pid=${pid} status=${result.status ?? "unknown"}`,
    );
  }
}

/**
 * POSIX：先枚举后代，然后 SIGINT → SIGTERM → SIGKILL 三阶段升级。
 *
 * 每阶段都同时发给进程组（-pid）与逐个 pid；阶段间轮询等待退出。
 * 到 SIGKILL 前重新枚举一次后代，捕捉在宽限期内新 spawn 的子进程。
 * 最终仍有存活者则抛错并附带 remaining pid；全退出则正常返回。
 * 副作用：子进程、信号、sleep；不修改 options。
 */
async function terminatePosixProcessTree(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions,
): Promise<void> {
  if (!isProcessAlive(pid, options)) return;

  const descendants = uniquePids(await collectDescendantPids(pid, options)).reverse();
  const treePids = uniquePids([...descendants, pid]);

  killProcessGroup(pid, "SIGINT", options);
  for (const treePid of treePids) killPid(treePid, "SIGINT", options);
  await waitUntilAllExited(treePids, POSIX_PROCESS_TREE_GRACE_MS, options);
  if (!treePids.some((treePid) => isProcessAlive(treePid, options))) return;

  killProcessGroup(pid, "SIGTERM", options);
  for (const treePid of treePids) killPid(treePid, "SIGTERM", options);
  await waitUntilAllExited(treePids, POSIX_PROCESS_TREE_FORCE_MS, options);
  if (!treePids.some((treePid) => isProcessAlive(treePid, options))) return;

  const latestDescendants = uniquePids(await collectDescendantPids(pid, options)).reverse();
  const finalPids = uniquePids([...latestDescendants, ...treePids]);
  for (const treePid of finalPids) {
    if (isProcessAlive(treePid, options)) killPid(treePid, "SIGKILL", options);
  }
  killProcessGroup(pid, "SIGKILL", options);
  await waitUntilAllExited(finalPids, POSIX_PROCESS_TREE_VERIFY_MS, options);
  const remainingPids = finalPids.filter((treePid) => isProcessAlive(treePid, options));
  if (remainingPids.length > 0) {
    throw new Error(
      `SIGKILL failed for MCP stdio process tree pid=${pid} remaining=${remainingPids.join(",")}`,
    );
  }
}

/**
 * 在预算内轮询直到所有 pid 退出或超时。
 * 超时后不抛错，由调用方根据 isProcessAlive 决定是否升级信号/最终抛错。
 * 使用注入的 now/sleep，保证测试可瞬时推进。
 */
async function waitUntilAllExited(
  pids: number[],
  timeoutMs: number,
  options: McpStdioProcessTreeTerminatorOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (!pids.some((pid) => isProcessAlive(pid, options))) return;
    await sleep(POSIX_PROCESS_TREE_POLL_MS);
  }
}

function runCommand(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  terminatorOptions: McpStdioProcessTreeTerminatorOptions,
): Promise<CommandResult> {
  const execFileFn = terminatorOptions.execFile ?? defaultExecFile;
  return execFileFn(file, args, options);
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      resolveCommand({
        error,
        status: getExitStatus(error),
        stderr,
        stdout,
      });
    });
  });
}

function getExitStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function didTerminationFail(result: CommandResult): boolean {
  return Boolean(result.error) || (result.status !== null && result.status !== 0);
}
