// ============================================================
// 文件定位：进程探针的平台无关契约与工具（进程表解析、树展开、外部命令执行）。
// 输入输出：输入进程行/根 pid，输出样本或树；runProbeCommand 返回 stdout 文本。
// 副作用：仅在调用方注入的 execFile 时启动外部进程（1s 超时、8MB 缓冲）。
// 失败语义：非零退出/execFile error 抛 ProcessProbeFailure；解析缺列返回 undefined 而非猜测。
// 不变量：样本 cpuTimeMs 缺失用“字段缺席”表达；树成员含根自身且 DFS 去重。
// ============================================================
import { execFile as nodeExecFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

/**
 * 通用进程探针的共享契约与平台无关工具。
 * 平台实现（darwin / linux / win32）各自一个文件，只依赖本文件，不互相依赖。
 */
export interface ProcessProbeSample {
  // 进程 id；样本不可靠不会出现在结果里。
  pid: number;
  // 常驻内存，单位 KB（与 ps/tasklist 输出一致，不做换算）。
  rssKb: number;
  /** 进程启动以来的累计 CPU 时间；Windows 无此数据，字段缺席而不是填 0 */
  cpuTimeMs?: number;
}

export interface ProcessProbeCommandResult {
  error?: unknown;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type ProcessProbeExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<ProcessProbeCommandResult>;

/** 进程间关系与 CPU 时间；RSS 由各平台单独取得（Linux 要多读一次 `status`）。 */
export interface ProcessRelation {
  // 累计 CPU 毫秒；Windows/无法解析时缺席。
  cpuTimeMs?: number;
  // 父进程 pid；根进程或不可得时为 undefined。
  parentPid?: number;
  pid: number;
  // POSIX 进程组 id；Windows 没有此语义。
  processGroupId?: number;
}

export interface ProcessRow extends ProcessRelation {
  rssKb: number;
}

export const PROCESS_PROBE_SAMPLE_TIMEOUT_MS = 1_000;

const PROCESS_PROBE_MAX_BUFFER_BYTES = 8 * 1_024 * 1_024;

/** 采样失败：调用方一律翻译成「本次无样本」，并累计连续失败次数。 */
export class ProcessProbeFailure extends Error {}

/** 把进程表按 parentPid 展开成每个根 pid 的进程树；根不存在时不出现在结果里。 */
export function groupProcessTrees(
  rows: readonly ProcessRow[],
  rootPids: readonly number[],
): ReadonlyMap<number, readonly ProcessProbeSample[]> {
  const rowByPid = new Map(rows.map((row) => [row.pid, row]));
  const trees = new Map<number, readonly ProcessProbeSample[]>();
  for (const [rootPid, treePids] of collectProcessTreePids(rows, rootPids)) {
    trees.set(
      rootPid,
      treePids.flatMap((pid) => {
        const row = rowByPid.get(pid);
        return row ? [toSample(row)] : [];
      }),
    );
  }
  return trees;
}

/** 每个根 pid 的进程树成员 pid（含根自身），按 DFS 顺序；根不在进程表里则整棵树缺席。 */
export function collectProcessTreePids(
  relations: readonly ProcessRelation[],
  rootPids: readonly number[],
): ReadonlyMap<number, readonly number[]> {
  const knownPids = new Set(relations.map((relation) => relation.pid));
  const childrenByParent = new Map<number, number[]>();
  for (const relation of relations) {
    if (relation.parentPid === undefined) continue;
    const children = childrenByParent.get(relation.parentPid) ?? [];
    children.push(relation.pid);
    childrenByParent.set(relation.parentPid, children);
  }
  const trees = new Map<number, readonly number[]>();
  for (const rootPid of rootPids) {
    if (!knownPids.has(rootPid)) continue;
    const treePids: number[] = [];
    const visited = new Set<number>();
    const visit = (pid: number): void => {
      if (visited.has(pid)) return;
      visited.add(pid);
      treePids.push(pid);
      for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
    };
    visit(rootPid);
    trees.set(rootPid, treePids);
  }
  return trees;
}

// 外部命令采样：统一 utf8、1s 超时、8MB 缓冲；调用方可用 extraOptions 覆盖（如 windowsHide）。
// 返回 stdout；任何 error/非零状态都抛 ProcessProbeFailure，交由探针计为一次失败。
export async function runProbeCommand(
  execFile: ProcessProbeExecFile,
  file: string,
  args: readonly string[],
  extraOptions: Partial<ExecFileOptionsWithStringEncoding> = {},
): Promise<string> {
  const result = await execFile(file, args, {
    encoding: "utf8",
    maxBuffer: PROCESS_PROBE_MAX_BUFFER_BYTES,
    timeout: PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
    ...extraOptions,
  });
  if (result.error || result.status !== 0) {
    throw new ProcessProbeFailure(
      `${file} 采样失败: ${result.stderr.trim() || String(result.status)}`,
    );
  }
  return result.stdout;
}

// 行 → 样本：cpuTimeMs 为 undefined 时不写该键（保持“缺席”语义，而不是 0ms）。
export function toSample(row: ProcessRow): ProcessProbeSample {
  return {
    pid: row.pid,
    rssKb: row.rssKb,
    ...(row.cpuTimeMs === undefined ? {} : { cpuTimeMs: row.cpuTimeMs }),
  };
}

// 只接受正整数 pid：0/负数/非整数（含 NaN）都不可采样。
export function isSamplablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

// 默认 execFile 包装：把回调式 API 转成“永不 reject”的结果对象（error 放在字段里）。
// 这样调用方可以统一用 status/stderr 判定，而不必区分异常与退出码。
export function defaultProbeExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<ProcessProbeCommandResult> {
  return new Promise((resolve) => {
    nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
      resolve({
        ...(error ? { error } : {}),
        status: resolveExitStatus(error),
        stderr,
        stdout,
      });
    });
  });
}

// 退出状态归一：无错误=0；错误码为数字则原样返回；超时/信号终止（字符串 code）返回 null。
function resolveExitStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}
