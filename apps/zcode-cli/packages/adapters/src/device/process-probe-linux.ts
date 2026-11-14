// ============================================================
// 文件定位：Linux 进程采样，全程只读 /proc，不启动任何外部进程。
// 输入输出：输入根 pid 集合或进程组 id，输出样本（pid、rssKb、cpuTimeMs）。
// 副作用：读 /proc/<pid>/stat 与 status；分批发起，超时后剩余批次不再发起。
// 失败语义：/proc 不可读或扫描超时抛 ProcessProbeFailure；单个 pid 读失败只跳过它。
// 不变量：CPU 时间按 USER_HZ=100 换算；样本只包含既拿到 relation 又拿到 VmRSS 的进程。
// ============================================================
import {
  collectProcessTreePids,
  isSamplablePid,
  ProcessProbeFailure,
  toSample,
  type ProcessProbeSample,
  type ProcessRelation,
} from "./process-probe-shared.js";

/** Linux `USER_HZ`：`/proc/<pid>/stat` 的 utime/stime 以此为单位，所有支持平台上都是 100 */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const MS_PER_SECOND = 1_000;
/**
 * `/proc` 扫描按批读取：超时判负后剩余批次不再发起。
 * 一次性 `Promise.all` 上百个 readFile 无法取消，慢盘上会在样本已被丢弃后继续吃 IO。
 */
const PROC_READ_BATCH_SIZE = 64;

export interface LinuxProcReaders {
  // 列出 /proc 下条目（含大量非数字条目，调用方负责过滤）；失败即整次采样失败。
  listProcDirectory: () => Promise<readonly string[]>;
  // 读取单个 /proc 文件；进程刚退出时抛 ENOENT，由调用方按“单 pid 跳过”处理。
  readProcFile: (path: string) => Promise<string>;
  /** 本次采样是否已超时；为 true 时中止剩余 `/proc` 读取并判为无样本 */
  isExpired?: () => boolean;
}

/**
 * Linux 走两遍 `/proc`：先读全部 `stat` 拿 ppid、pgid 与 CPU 时间，
 * 再只对目标进程树内的 pid 读 `status` 的 `VmRSS`。全程不启动任何进程。
 */
export async function sampleLinuxProcessTrees(
  readers: LinuxProcReaders,
  rootPids: readonly number[],
): Promise<ReadonlyMap<number, readonly ProcessProbeSample[]>> {
  const relations = await readLinuxProcessRelations(readers);
  const relationByPid = new Map(relations.map((relation) => [relation.pid, relation]));
  const treePidsByRoot = collectProcessTreePids(relations, rootPids);
  const rssByPid = await readLinuxRssKb(readers, [...treePidsByRoot.values()].flat());
  const trees = new Map<number, readonly ProcessProbeSample[]>();
  for (const [rootPid, treePids] of treePidsByRoot) {
    trees.set(rootPid, buildLinuxSamples(treePids, relationByPid, rssByPid));
  }
  return trees;
}

/**
 * 按进程组采样：先读全表 stat 找 pgid 相同的进程，再只给这些 pid 读 VmRSS。
 * 组内进程在两次读取之间退出时，其样本缺席而不是报错；组不存在时返回空数组。
 */
export async function sampleLinuxProcessGroup(
  readers: LinuxProcReaders,
  processGroupId: number,
): Promise<readonly ProcessProbeSample[]> {
  const relations = await readLinuxProcessRelations(readers);
  const members = relations.filter((relation) => relation.processGroupId === processGroupId);
  const rssByPid = await readLinuxRssKb(
    readers,
    members.map((relation) => relation.pid),
  );
  return buildLinuxSamples(
    members.map((relation) => relation.pid),
    new Map(members.map((relation) => [relation.pid, relation])),
    rssByPid,
  );
}

// 组装样本：只有 relation 与 rss 都拿到的 pid 才产出样本，缺任一即为“进程已消失”。
function buildLinuxSamples(
  pids: readonly number[],
  relationByPid: ReadonlyMap<number, ProcessRelation>,
  rssByPid: ReadonlyMap<number, number>,
): readonly ProcessProbeSample[] {
  return pids.flatMap((pid) => {
    const relation = relationByPid.get(pid);
    const rssKb = rssByPid.get(pid);
    // 进程在两遍读取之间退出时 status 已消失，跳过该 pid，其余样本照常返回。
    if (!relation || rssKb === undefined) return [];
    return [toSample({ ...relation, rssKb })];
  });
}

/**
 * 读全表 stat 得到 pid → (ppid, pgid, cpuTimeMs)。
 * `/proc` 目录不可读视为环境级失败（抛错）；单个 stat 读失败视为进程已退出（跳过）。
 */
async function readLinuxProcessRelations(
  readers: LinuxProcReaders,
): Promise<readonly ProcessRelation[]> {
  let entries: readonly string[];
  try {
    entries = await readers.listProcDirectory();
  } catch (error) {
    throw new ProcessProbeFailure(`/proc 不可读: ${String(error)}`);
  }
  const pids = entries.map(Number).filter(isSamplablePid);
  const relations = await readProcInBatches(readers, pids, async (pid) => {
    let stat: string;
    try {
      stat = await readers.readProcFile(`/proc/${pid}/stat`);
    } catch {
      // 单个 pid 读失败（多数是进程刚退出）只跳过它，不影响本次采样整体。
      return undefined;
    }
    const parsed = parseLinuxStat(stat);
    return parsed ? { pid, ...parsed } : undefined;
  });
  return relations;
}

// 只对目标 pid 读 status 的 VmRSS；去重后分批发起，保持 IO 峰值可控。
async function readLinuxRssKb(
  readers: LinuxProcReaders,
  pids: readonly number[],
): Promise<ReadonlyMap<number, number>> {
  const entries = await readProcInBatches(readers, [...new Set(pids)], async (pid) => {
    try {
      const rssKb = parseLinuxVmRssKb(await readers.readProcFile(`/proc/${pid}/status`));
      return rssKb === undefined ? undefined : ([pid, rssKb] as const);
    } catch {
      return undefined;
    }
  });
  return new Map(entries);
}

/** 分批并发读取 `/proc`，每批前检查超时；已超时则中止扫描并判为本次无样本。 */
async function readProcInBatches<T>(
  readers: LinuxProcReaders,
  pids: readonly number[],
  read: (pid: number) => Promise<T | undefined>,
): Promise<readonly T[]> {
  const collected: T[] = [];
  for (let offset = 0; offset < pids.length; offset += PROC_READ_BATCH_SIZE) {
    if (readers.isExpired?.()) throw new ProcessProbeFailure("/proc 扫描超时");
    const batch = await Promise.all(pids.slice(offset, offset + PROC_READ_BATCH_SIZE).map(read));
    for (const item of batch) {
      if (item !== undefined) collected.push(item);
    }
  }
  return collected;
}

/** comm 字段允许含空格与括号，必须以最后一个 `)` 为界切分。 */
function parseLinuxStat(
  stat: string,
): { cpuTimeMs: number; parentPid: number; processGroupId: number } | undefined {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd === -1) return undefined;
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  // 切分后 fields[0] 是 state（stat 的第 3 个字段），故 ppid=1、pgrp=2、utime=11、stime=12。
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const utimeTicks = Number(fields[11]);
  const stimeTicks = Number(fields[12]);
  if (!Number.isInteger(parentPid) || parentPid < 0 || !Number.isInteger(processGroupId)) {
    return undefined;
  }
  if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks)) return undefined;
  return {
    cpuTimeMs: Math.round(
      ((utimeTicks + stimeTicks) / LINUX_CLOCK_TICKS_PER_SECOND) * MS_PER_SECOND,
    ),
    parentPid,
    processGroupId,
  };
}

// VmRSS 行格式为 `VmRSS:   123 kB`；缺失（如内核线程）返回 undefined，由上层跳过该 pid。
function parseLinuxVmRssKb(status: string): number | undefined {
  const match = /^VmRSS:\s+(\d+)\s*kB$/mu.exec(status);
  if (!match) return undefined;
  const rssKb = Number(match[1]);
  return Number.isFinite(rssKb) ? rssKb : undefined;
}
