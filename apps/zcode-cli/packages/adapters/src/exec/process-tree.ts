// ============================================================
// 文件定位：POSIX 进程树终止工具，供 exec 的 cancel/timeout 清理使用。
// 输入输出：输入根 pid/信号；不返回值，只尽力向进程组与 PPID 后代发送信号。
// 副作用：spawn 一次 `ps -A -o pid= -o ppid=`（500ms 超时），并向多个 pid 发送 SIGTERM/SIGKILL。
// 失败语义：pid 非法直接跳过；ps 失败退化为只杀进程组；单个 kill 失败视为进程已退出。
// 不变量：Bash 用两阶段查表杀树（每次重新快照，不跨阶段记忆身份），通用执行保留原 PGID 边界。
// ============================================================
import { spawn, type ChildProcess } from "node:child_process";

// 通用进程组：先 SIGTERM，750ms 后确认组仍存在再 SIGKILL（负 PGID 可命中持有 pipe 的孙进程）。
const GENERIC_SIGTERM_TO_SIGKILL_MS = 750;
const POSIX_PROCESS_LOOKUP_TIMEOUT_MS = 500;
export const BASH_SIGTERM_TO_SIGKILL_MS = 1_500;

// 对整棵 POSIX 进程树发送一次信号（组信号 + 当时快照出的 PPID 后代）；根 pid 非法或为 1 时直接返回。
// 内部任何异常都被吞掉，调用方无需 try/catch。
export async function signalPosixProcessTree(
  rootPid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return;
  await killPosixProcessTree(rootPid, signal).catch(() => undefined);
}

// 通用（非 Bash）终止：只动子进程自己的进程组，升级杀必须再次确认组存活。
// 这样 hook / argv 执行的清理能力不会被扩散到无关进程。
export function terminateGenericPosixProcessGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  setTimeout(() => {
    // 组长 exit 后，负 PGID 仍可能命中持有 pipe 的孙进程；仅当进程组
    // 确认不存在时才跳过 escalation。
    if (!isPosixProcessGroupAlive(child.pid!)) return;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, GENERIC_SIGTERM_TO_SIGKILL_MS).unref();
}

function isPosixProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Bash 专用两阶段清理的一次执行：先取当前 PPID 后代快照，再对组与快照逐个发信号。
// 组信号失败时退回杀根进程；根已退出也继续处理快照后代。
async function killPosixProcessTree(rootPid: number, signal: NodeJS.Signals): Promise<void> {
  const descendants = await collectPosixDescendantPids(rootPid);
  try {
    process.kill(-rootPid, signal);
  } catch {
    try {
      process.kill(rootPid, signal);
    } catch {
      // 根进程可能已退出；仍继续处理快照后代。
    }
  }
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      // 后代可能已自然退出或已被同组信号回收。
    }
  }
}

// 用一次 ps 快照构建 PPID 树，再从根 pid 做 BFS 收集后代（跳过 1、根自身与重复 pid）。
// 查询有 500ms 上限，超时按“无后代”退化，保证取消路径不会被进程表查询卡住。
async function collectPosixDescendantPids(rootPid: number): Promise<Set<number>> {
  let stdout: string;
  try {
    stdout = await Promise.race([
      readPosixProcessTable(),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve(""), POSIX_PROCESS_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // ps 失败时按空后代集合退化，根进程组信号仍会继续。
    return new Set();
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      if (pid <= 1 || pid === rootPid || descendants.has(pid)) continue;
      descendants.add(pid);
      queue.push(pid);
    }
  }
  return descendants;
}

function readPosixProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    let processTable: ChildProcess;
    try {
      processTable = spawn("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
        cwd: "/",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    processTable.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk;
    });
    processTable.once("error", reject);
    processTable.once("close", () => resolve(stdout));
  });
}
