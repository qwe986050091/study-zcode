// ============================================================
// 文件定位：macOS 进程采样，唯一外部命令是 ps（每次采样最多一次调用）。
// 输入输出：输入空/进程组 id，输出 ProcessRow（pid、ppid、rssKb、cpuTimeMs）。
// 副作用：spawn 一次 ps（1s 超时、8MB 缓冲），无任何文件写入。
// 失败语义：ps 失败抛 ProcessProbeFailure；单行缺列或字段非法只跳过该行。
// 不变量：列名与 ps 格式串成对声明，解析按列数严格校验，避免静默错位。
// ============================================================
import {
  isSamplablePid,
  runProbeCommand,
  type ProcessProbeExecFile,
  type ProcessRow,
} from "./process-probe-shared.js";

/** macOS 只允许 `ps`；输出格式与列名成对声明，避免两处各写一份而静默错位。 */
const PS_COMMAND = "ps";
const PS_PROCESS_TABLE_FORMAT = {
  columns: ["pid", "parentPid", "rssKb", "cpuTime"],
  spec: "pid=,ppid=,rss=,cputime=",
} as const;
const PS_PROCESS_GROUP_FORMAT = {
  columns: ["pid", "rssKb", "cpuTime"],
  spec: "pid=,rss=,cputime=",
} as const;
const PS_ALL_PROCESSES_FLAG = "-eo";
const PS_FORMAT_FLAG = "-o";
const PS_PROCESS_GROUP_FLAG = "-g";
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_DAY = 86_400;
const MS_PER_SECOND = 1_000;
/** BSD `cputime` 最多 `dd-hh:mm:ss`，即冒号分段不超过 3 段 */
const MAX_BSD_CLOCK_SEGMENTS = 3;

/** macOS：唯一允许的外部进程是 `ps`，每次采样最多一次调用。 */
export async function readDarwinProcessTable(
  execFile: ProcessProbeExecFile,
): Promise<readonly ProcessRow[]> {
  // 进程树需要 ppid，而 `-p <pid 列表>` 只会回列表里的进程、拿不到后代，因此取一次全表。
  const stdout = await runProbeCommand(execFile, PS_COMMAND, [
    PS_ALL_PROCESSES_FLAG,
    PS_PROCESS_TABLE_FORMAT.spec,
  ]);
  return parseDarwinRows(stdout, PS_PROCESS_TABLE_FORMAT.columns);
}

/**
 * 按进程组采样：`ps -o pid=,rss=,cputime= -g <pgid>` 只回该组内进程。
 * 不取 ppid，因为调用方只需要一组成员的内存/CPU；组内进程全部退出时返回空数组。
 */
export async function readDarwinProcessGroup(
  execFile: ProcessProbeExecFile,
  processGroupId: number,
): Promise<readonly ProcessRow[]> {
  const stdout = await runProbeCommand(execFile, PS_COMMAND, [
    PS_FORMAT_FLAG,
    PS_PROCESS_GROUP_FORMAT.spec,
    PS_PROCESS_GROUP_FLAG,
    String(processGroupId),
  ]);
  return parseDarwinRows(stdout, PS_PROCESS_GROUP_FORMAT.columns);
}

type DarwinColumn = "pid" | "parentPid" | "rssKb" | "cpuTime";

/**
 * 把 ps 输出按列名映射成行：字段数必须与 columns 完全一致，否则整行丢弃。
 * pid 必须是正整数、rss 必须是非负有限数；ppid/cputime 解析失败时以字段缺席表达。
 */
// 显式声明列顺序后统一走 Map，避免 column 与 ps 格式串各自维护而错位。
function parseDarwinRows(stdout: string, columns: readonly DarwinColumn[]): readonly ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    // ps 列宽不固定；列数不符说明该行被截断或格式异常，宁可丢弃也不按位置硬猜。
    if (fields.length !== columns.length) continue;
    const values = new Map(columns.map((column, index) => [column, fields[index] ?? ""]));
    const pid = Number(values.get("pid"));
    const rssKb = Number(values.get("rssKb"));
    const parentPidText = values.get("parentPid");
    const parentPid = parentPidText === undefined ? undefined : Number(parentPidText);
    const cpuTimeMs = parseBsdCpuTimeMs(values.get("cpuTime") ?? "");
    if (!isSamplablePid(pid) || !Number.isFinite(rssKb) || rssKb < 0) continue;
    if (parentPid !== undefined && (!Number.isInteger(parentPid) || parentPid < 0)) continue;
    rows.push({
      pid,
      rssKb,
      ...(parentPid === undefined ? {} : { parentPid }),
      ...(cpuTimeMs === undefined ? {} : { cpuTimeMs }),
    });
  }
  return rows;
}

/** BSD `cputime` 形如 `[dd-][hh:]mm:ss[.ff]`。 */
// 解析规则：`dd-` 前缀是天数；冒号段从右往左依次是秒、分、时，最多 3 段；
// 任一段非数字/负数即整体判为不可用（字段缺席而非猜 0），避免把坏数据当 CPU 时间上报。
function parseBsdCpuTimeMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const dashIndex = trimmed.indexOf("-");
  const days = dashIndex === -1 ? 0 : Number(trimmed.slice(0, dashIndex));
  const clockParts = trimmed.slice(dashIndex + 1).split(":");
  if (!Number.isFinite(days) || days < 0 || clockParts.length > MAX_BSD_CLOCK_SEGMENTS) {
    return undefined;
  }
  let seconds = days * SECONDS_PER_DAY;
  // 逆序累加：最右段是个位单位（秒），向左每段乘 60。
  for (const [index, part] of [...clockParts].reverse().entries()) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return undefined;
    seconds += value * SECONDS_PER_MINUTE ** index;
  }
  return Math.round(seconds * MS_PER_SECOND);
}
