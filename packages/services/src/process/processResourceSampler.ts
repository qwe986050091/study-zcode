// 资源管理器 Host 侧进程采样：读整机进程表 → 用 cputime 差分算整机归一化占比 → 按 Host 后代归属。
// 上游是 Window Host 内资源窗口的请求，下游是 HostResourceUsageProcess 列表（经 IPC 交给 main/渲染层）。
// INV-01：main 进程绝不走本文件的读表路径；外部进程读取只发生在 utility 进程（守住：createProcessResourceTableReader 三个分支）。
//   若破坏：同步 ps/PowerShell 会卡住 main 的事件循环，历史上曾导致整个 App 无响应。
// INV-02：任何一次读表失败都返回 undefined 而非抛错，采样器据此跳过本轮并保留旧基线（守住：reader 各分支 / sample）。
//   若改成 throw：一次权限拒绝或进程竞态会让资源窗口持续报错，而不是只少一帧数据。
import { execFile as nodeExecFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import os from "node:os";
import {
  formatZCodeAgentProcessName,
  type HostResourceUsageProcess,
  type ZCodeProcessChildProcess,
} from "@zcode/shared";

/**
 * 资源管理器 Host 侧采样。
 *
 * 设计边界：
 * - 只在 Window Host（utility 进程）内运行，并且只在资源管理器窗口发起请求时才读一次进程表；
 *   main 进程禁止起任何外部进程（历史上同步 ps / PowerShell 曾卡死整个 App）。
 * - 读取整机进程表后按 Host 后代做归属；插件归属来自 CLI 的 `process/childProcesses`。
 * - CPU 统一为整机归一化百分比（100% = 所有逻辑核心占满），由两次采样的 cputime 差分得到。
 */

// 超时是护栏而非性能目标：进程表读取慢于它时本轮直接放弃，避免窗口里堆起排队请求。
const POSIX_TABLE_TIMEOUT_MS = 3_000;
// PowerShell 冷启动比 ps 慢得多，单独给更宽的超时；仍远小于用户能感知的卡顿阈值。
const WINDOWS_TABLE_TIMEOUT_MS = 5_000;
// 进程数异常多时 stdout 会膨胀，封顶避免一次采样吃掉整块内存。
const TABLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Linux /proc 的 utime/stime 固定按 USER_HZ=100 输出，与内核 HZ 无关。 */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
// Win32_Process 的 Kernel/UserModeTime 单位是 100 纳秒，换算成毫秒需除以 1e4。
const WINDOWS_100NS_PER_MS = 10_000;
/** 上一轮 cputime 基线在这么久没被再次看到后丢弃（pid 复用防护） */
const CPU_BASELINE_TTL_MS = 60_000;

// 一张进程表行：rssKb 已平台无关化到 KB，cpuTimeMs 是累计值而非百分比；
// 百分比只能由两次采样差分得到，所以数据层不产出 cpuPercent。
export interface ProcessResourceRow {
  pid: number;
  ppid: number;
  rssKb: number;
  /** 进程累计 CPU 时间（user + system），毫秒 */
  cpuTimeMs: number;
  /** 命令名或可执行路径（平台原样） */
  command: string;
}

// 读表函数用 undefined 表示「本轮不可用」（超时/权限/平台无 ps）。
// 调用方必须区分「空表」与「读失败」：前者说明进程都退出了，后者不能清空基线。
export type ProcessResourceTableReader = (
  signal?: AbortSignal,
) => Promise<ProcessResourceRow[] | undefined>;

interface ExecFileResult {
  error?: unknown;
  stdout: string;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide?: boolean; signal?: AbortSignal },
) => Promise<ExecFileResult>;

// 把 node 的 callback 形式包成 Promise 且永不 reject：错误塞进返回值，
// 让上层统一走「返回 undefined」的降级路径，不必到处 try/catch。
function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide?: boolean; signal?: AbortSignal },
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    nodeExecFile(file, [...args], { ...options, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? { error, stdout: "" } : { stdout });
    });
  });
}

// 所有来自进程表的数字都过这一道：NaN、小数、负数一律视为缺失，避免脏值被当成有效 pid 或内存量。
function parseNonNegativeInteger(text: string | undefined): number | undefined {
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 解析 ps 的 cputime 文本：macOS `[[dd-]hh:]mm:ss.cc`、Linux `[dd-]hh:mm:ss`。
 * 返回毫秒；无法解析返回 undefined。
 */
// 解析失败必须返回 undefined 而不是 0：0 会被当成「本进程没消耗 CPU」写成基线，
// 下一轮差分就会算出一个巨大的百分比尖峰。
export function parseCpuTimeText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let days = 0;
  let clock = trimmed;
// 负号只在 >0 位置才是「天」分隔符；位置 0 说明字段本身非法，交由冒号解析失败的路径处理。
  const dayIndex = trimmed.indexOf("-");
  if (dayIndex > 0) {
    days = Number(trimmed.slice(0, dayIndex));
    clock = trimmed.slice(dayIndex + 1);
    if (!Number.isInteger(days) || days < 0) return undefined;
  }
// 1~3 段分别对应 [ss]、[mm:ss]、[hh:mm:ss]；超过 3 段无法判定含义，直接判失败。
// 各段用 Number 转换后统一校验有限非负，避免 "1e3"、空白串这类伪装值混进来。
  const parts = clock.split(":");
  if (parts.length === 0 || parts.length > 3) return undefined;
  const seconds = Number(parts[parts.length - 1]);
  const minutes = parts.length >= 2 ? Number(parts[parts.length - 2]) : 0;
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, minutes, hours].every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/** `ps -axo pid=,ppid=,rss=,cputime=,comm=` 的输出；comm 可能含空格，取前 4 列后剩余全部为 comm */
// ps 输出按行解析，任一行失败只跳过该行而不中断整表：采样期间进程生灭频繁，畸形行属常态。
export function parseDarwinProcessTable(stdout: string): ProcessResourceRow[] {
  const rows: ProcessResourceRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = parseNonNegativeInteger(match[1]);
    const ppid = parseNonNegativeInteger(match[2]);
    const rssKb = parseNonNegativeInteger(match[3]);
    const cpuTimeMs = parseCpuTimeText(match[4] ?? "");
// pid<=0 在内核里保留给调度器，出现即说明该行不是真实进程；宁缺勿错，直接跳过。
    if (pid === undefined || pid <= 0 || ppid === undefined || rssKb === undefined) continue;
    if (cpuTimeMs === undefined) continue;
    rows.push({ pid, ppid, rssKb, cpuTimeMs, command: (match[5] ?? "").trim() });
  }
  return rows;
}

/** 解析 `/proc/<pid>/stat`：comm 用括号包裹且可含空格/括号，按最后一个 `)` 切分 */
// /proc/<pid>/stat 的 comm 用括号包裹，可含空格与括号，因此必须取「最后一个 )」作分隔符；
// 若按第一个 ) 切分，形如 (a) b) 的进程名会让后续字段整体错位，ppid 与 utime 全读错。
export function parseLinuxProcStat(
  content: string,
): { pid: number; ppid: number; command: string; cpuTimeMs: number } | undefined {
// open/close 任一缺失说明文件被截断（读取瞬间进程已退出），返回 undefined 让调用方跳过该 pid。
  const open = content.indexOf("(");
  const close = content.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = parseNonNegativeInteger(content.slice(0, open).trim());
  const command = content.slice(open + 1, close);
  const rest = content
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0]=state, rest[1]=ppid, ... rest[11]=utime, rest[12]=stime（原始字段号 14/15）
  const ppid = parseNonNegativeInteger(rest[1]);
  const utime = parseNonNegativeInteger(rest[11]);
  const stime = parseNonNegativeInteger(rest[12]);
  if (
    pid === undefined ||
    pid <= 0 ||
    ppid === undefined ||
    utime === undefined ||
    stime === undefined
  ) {
    return undefined;
  }
  return {
    pid,
    ppid,
    command,
    cpuTimeMs: Math.round(((utime + stime) * 1000) / LINUX_CLOCK_TICKS_PER_SECOND),
  };
}

/** 解析 `/proc/<pid>/status` 里的 `VmRSS:\t 1234 kB` */
// VmRSS 缺失（内核线程或无权限）时返回 0 而不是沿用旧值：
// 内存宁可短暂偏低，也不能把已退出进程的占用挂到复用的 pid 上。
export function parseLinuxVmRssKb(content: string): number {
  const match = /^VmRSS:\s*(\d+)\s*kB/m.exec(content);
  return match ? Number(match[1]) : 0;
}

/** PowerShell 输出：`pid ppid workingSetBytes cpu100ns name...` */
// PowerShell 每行固定为 pid ppid workingSetBytes cpu100ns name，name 可能为空（受保护进程）。
export function parseWindowsProcessTable(stdout: string): ProcessResourceRow[] {
  const rows: ProcessResourceRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const pid = parseNonNegativeInteger(match[1]);
    const ppid = parseNonNegativeInteger(match[2]);
    const workingSetBytes = parseNonNegativeInteger(match[3]);
    const cpu100ns = parseNonNegativeInteger(match[4]);
    if (pid === undefined || pid <= 0 || ppid === undefined || workingSetBytes === undefined)
      continue;
    if (cpu100ns === undefined) continue;
    rows.push({
      pid,
      ppid,
      rssKb: Math.round(workingSetBytes / 1024),
// 这里不做取整：差分比例对精度敏感，取整误差会在两轮间被放大成几个百分点。
      cpuTimeMs: cpu100ns / WINDOWS_100NS_PER_MS,
      command: (match[5] ?? "").trim(),
    });
  }
  return rows;
}

export interface CreateProcessResourceTableReaderOptions {
  platform?: NodeJS.Platform;
  execFile?: ExecFileFn;
  readdir?: (path: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
}

/** 按平台读取整机进程表；任何失败都返回 undefined（本轮跳过），不抛错 */
// 按平台选实现，返回固定签名的读表函数；三个分支失败语义完全一致（undefined），
// 让 sample 里只有一条降级路径，不因平台产生行为差异。
// 默认平台取 process.platform，注入仅用于测试与远程宿主。
export function createProcessResourceTableReader(
  options: CreateProcessResourceTableReaderOptions = {},
): ProcessResourceTableReader {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? defaultExecFile;

// Windows 必须走 CIM 而不是 tasklist：只有 Win32_Process 同时给出 ppid 与累计 CPU 时间，
// 缺任一项都无法做归属和差分。
  if (platform === "win32") {
    return async (signal) => {
      signal?.throwIfAborted();
      const result = await execFile(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3} {4}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ($_.KernelModeTime + $_.UserModeTime), $_.Name }",
        ],
        {
          timeout: WINDOWS_TABLE_TIMEOUT_MS,
          maxBuffer: TABLE_MAX_BUFFER_BYTES,
          windowsHide: true,
          signal,
        },
      );
// 超时/被杀/权限不足都进 error 分支，统一返回 undefined；
// 不把部分 stdout 交给解析器，避免用半张表算出错误的进程树。
      return result.error ? undefined : parseWindowsProcessTable(result.stdout);
    };
  }

// Linux 直接读 /proc，避免 fork 外部进程（采样要尽可能便宜，容器里也常常没有 ps）；
// 代价是每 pid 两次文件读，所以下面用 Promise.all 并发并逐个兜错。
  if (platform === "linux") {
// /proc 读取失败（非 Linux 宿主或权限受限）直接整轮放弃，不尝试退化到 ps。
    const readDirectory = options.readdir ?? ((path: string) => readdir(path));
    return async (signal) => {
      signal?.throwIfAborted();
      const readText =
        options.readFile ?? ((path: string) => readFile(path, { encoding: "utf8", signal }));
// entries 在 try 内赋值、catch 里 return，因此这里的「未初始化」在控制流上不可达。
      let entries: string[];
      try {
        entries = await readDirectory("/proc");
      } catch {
        return undefined;
      }
// 对每个 pid 并发读取，单条失败只让该条为 undefined，不影响整表；
// 串行读在几百个进程时会把一次采样拖到秒级。
      const rows = await Promise.all(
        entries
// 只处理纯数字目录：/proc 下还有 self、sys、net 等虚拟项，读它们的 stat 得不到有效结果。
          .filter((entry) => /^\d+$/.test(entry))
          .map(async (entry): Promise<ProcessResourceRow | undefined> => {
            try {
              signal?.throwIfAborted();
// stat 提供 ppid 与 CPU 时间，status 提供 VmRSS；两者并行读把单 pid 往返压到一次。
              const [stat, status] = await Promise.all([
                readText(`/proc/${entry}/stat`),
                readText(`/proc/${entry}/status`),
              ]);
              const parsed = parseLinuxProcStat(stat);
// 解析失败（多为进程已退出导致内容不完整）与读文件失败同等处理：跳过该 pid。
              if (!parsed) return undefined;
              return { ...parsed, rssKb: parseLinuxVmRssKb(status) };
            } catch {
              // 进程在读取期间退出属正常现象，跳过即可。
              return undefined;
            }
          }),
      );
      return rows.filter((row): row is ProcessResourceRow => row !== undefined);
    };
  }

  return async (signal) => {
    signal?.throwIfAborted();
// macOS/BSD 走 ps：-axo 覆盖全部进程并自定义列序，列尾的等号去掉表头，
// 保证输出可以按固定列位解析。
    const result = await execFile("ps", ["-axo", "pid=,ppid=,rss=,cputime=,comm="], {
      timeout: POSIX_TABLE_TIMEOUT_MS,
      maxBuffer: TABLE_MAX_BUFFER_BYTES,
      signal,
    });
    return result.error ? undefined : parseDarwinProcessTable(result.stdout);
  };
}

// cpuPercent 是「占整机全部逻辑核心」的比例（100% = 跑满所有核），与任务管理器口径一致，
// 避免多核机器上出现 800% 这类难解释的数字。
export interface ProcessResourceSample {
  pid: number;
  ppid: number;
  rssKb: number;
  /** 整机归一化 CPU 百分比；首个样本无差分基线记 0 */
  cpuPercent: number;
  command: string;
}

// 采样器有状态（保存上一轮 cputime 基线），必须按 Host 单例使用；
// 多次创建会让同一进程出现多套基线，首轮 CPU 恒为 0。
export interface ProcessResourceSampler {
  sample(signal?: AbortSignal): Promise<Map<number, ProcessResourceSample> | undefined>;
}

export interface CreateProcessResourceSamplerOptions {
  readTable: ProcessResourceTableReader;
  now?: () => number;
  logicalCpuCount?: number;
}

export function createProcessResourceSampler(
  options: CreateProcessResourceSamplerOptions,
): ProcessResourceSampler {
  const now = options.now ?? Date.now;
  const logicalCpuCount = Math.max(1, options.logicalCpuCount ?? os.cpus().length);
// [并发] baselines 是跨请求的长寿状态，sample 之间必须串行（同一 Host 内按窗口串行调用）；
// 若并发进入，后一轮会覆盖前一轮刚写入的 at，差分区间被压缩，算出虚高百分比。
// 记录 command 用于 pid 复用识别：同一 pid 换了进程必须重新建基线。
  const baselines = new Map<number, { cpuTimeMs: number; at: number; command: string }>();

  return {
// 一次采样 = 读表 → 差分 → 清理过期基线。返回 undefined 表示本轮不可用，
// 上层应保留上一帧 UI 而不是清空列表，否则窗口会周期性闪空。
    async sample(signal) {
// 读表可能耗时数秒（PowerShell 冷启动），必须把 AbortSignal 透传进去，
// 窗口关闭后尽快终止子进程，而不是等它自然结束。
      const rows = await options.readTable(signal);
      // 关窗后的迟到 IO 不能改变下一次打开窗口的采样基线。
      signal?.throwIfAborted();
// 读失败时直接返回，绝不动 baselines：保留旧基线，下一轮成功时的时间差才是真实跨度，
// 否则会把整段空窗的 CPU 时间算进一瞬间。
      if (!rows) return undefined;
// 时间戳取在读表之后：把 IO 耗时排除在差分区间之外，避免读表慢时百分比被系统性压低。
      const at = now();
      const samples = new Map<number, ProcessResourceSample>();
// 逐行重算并立即写回基线：已处理行的基线立刻推进，不会出现同一段时间被算两次。
      for (const row of rows) {
        const baseline = baselines.get(row.pid);
        let cpuPercent = 0;
        // pid 复用防护：command 变了或 cputime 倒退都视为新进程，重新建立基线。
// reusable 为假说明这是新进程（或无基线/时间倒退），本轮 cpuPercent 记 0，只建基线不下结论；
// 新进程第一帧没有参照，报 0 比报一个猜测值更诚实。
        const reusable =
          baseline &&
          baseline.command === row.command &&
          row.cpuTimeMs >= baseline.cpuTimeMs &&
          at > baseline.at;
        if (reusable) {
// elapsedMs > 0 由 reusable 里的 at > baseline.at 保证，这里不会除零；先差分再除核数，避免截断。
          const elapsedMs = at - baseline.at;
          cpuPercent = (((row.cpuTimeMs - baseline.cpuTimeMs) / elapsedMs) * 100) / logicalCpuCount;
        }
// 每轮无条件覆盖基线（含不可复用的新进程），保证下一轮拿到最新 cputime；
// [顺序] baselines 每轮无条件覆盖（含不可复用的新进程）：基线推进独立于 reusable，后者只决定本轮是否算百分比。
        baselines.set(row.pid, { cpuTimeMs: row.cpuTimeMs, at, command: row.command });
        samples.set(row.pid, {
          pid: row.pid,
          ppid: row.ppid,
          rssKb: row.rssKb,
// 上限裁到 100：单进程理论峰值就是 100%，更高值一定是时钟回拨或 pid 复用误判，夹紧比透传更安全。
          cpuPercent: Math.max(0, Math.min(100, roundPercent(cpuPercent))),
          command: row.command,
        });
      }
// [资源] 清理本轮未出现的基线：TTL 取 60s 而非立即删除，是因为读表可能偶发漏行，
// 立刻删会让抖动把百分比重置为 0，产生锯齿。
      for (const [pid, baseline] of baselines) {
        if (!samples.has(pid) && at - baseline.at > CPU_BASELINE_TTL_MS) {
          baselines.delete(pid);
        }
      }
      return samples;
    },
  };
}

function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

export interface HostResourceUsageAgent {
  pid: number;
  provider: string;
  workspacePath: string;
  /** CLI `process/childProcesses` 的回报；请求失败时为空数组，其后代全部归入 cli */
  children: readonly ZCodeProcessChildProcess[];
}

export interface AttributeHostProcessTreeOptions {
  samples: ReadonlyMap<number, ProcessResourceSample>;
  hostPid: number;
  agents: readonly HostResourceUsageAgent[];
  /** Host 直接管理的内置插件进程（如 Windows CUA Helper）：pid → 插件名 */
  builtinPluginPids?: ReadonlyMap<number, string>;
}

// 三种归属来源：agent 根、MCP 子进程（含内置插件）、Host 直接管理的进程。
// 用可辨识联合而不是可选字段，保证 ownerToRow 分支穷尽且 TS 能检查遗漏。
type Owner =
  | { kind: "agent"; agent: HostResourceUsageAgent }
  | { kind: "mcp"; child: ZCodeProcessChildProcess }
  | { kind: "builtin"; pluginName: string };

function commandDisplayName(command: string): string {
  const name = basename(command.trim()).replace(/\.exe$/i, "");
  return name || command.trim() || "process";
}

// 把「样本 + 归属」翻译成 UI 行。isOwnerRoot 区分归属根与其后代：只有根用业务名
// （provider/服务名），后代保留真实进程名，方便定位是哪个子进程在吃 CPU。
function ownerToRow(
  owner: Owner | undefined,
  sample: ProcessResourceSample,
  isOwnerRoot: boolean,
): HostResourceUsageProcess {
  const cpuPercent = sample.cpuPercent;
  const memoryBytes = sample.rssKb * 1024;
// 无归属的 Host 后代归到基础服务 host 组；它仍属于本 Host，不能从列表消失，
// 否则用户看到的用量总和会小于实际。
  if (!owner) {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "base",
      groupKey: "host",
      groupLabel: "host",
      cpuPercent,
      memoryBytes,
    };
  }
  if (owner.kind === "agent") {
    return {
      pid: sample.pid,
      name: isOwnerRoot
        ? formatZCodeAgentProcessName(owner.agent.provider, owner.agent.workspacePath)
        : commandDisplayName(sample.command),
      category: "base",
      groupKey: "cli",
      groupLabel: "cli",
      cpuPercent,
      memoryBytes,
    };
  }
  if (owner.kind === "builtin") {
    return {
      pid: sample.pid,
      name: commandDisplayName(sample.command),
      category: "builtin-plugin",
      groupKey: owner.pluginName,
      groupLabel: owner.pluginName,
      cpuPercent,
      memoryBytes,
    };
  }
  const { child } = owner;
  const groupLabel = child.pluginName ?? child.serverName;
  return {
    pid: sample.pid,
    name: isOwnerRoot ? child.serverName : commandDisplayName(sample.command),
    // 用户裁决：官方市场插件是内置插件，其余（第三方市场 + 自定义 MCP）全部算社区插件。
    category: child.mcpSource === "builtin" ? "builtin-plugin" : "community-plugin",
    groupKey: `${child.mcpSource}:${groupLabel}`,
    groupLabel,
    cpuPercent,
    memoryBytes,
  };
}

/**
 * 把 Host 的全部后代按“最近的已知祖先”归属：
 * MCP 根 pid → 对应插件；Agent pid → 基础服务 cli；无归属 → 基础服务 host 子进程。
 * Host 自身不在结果里（它的指标由 main 的 app.getAppMetrics 提供）。
 */
// 把 Host 全部后代按「最近的已知祖先」归属：MCP 根 → 对应插件，Agent → cli，其余 → host 基础服务。
// Host 自身不进结果（其指标由 main 的 app.getAppMetrics 提供），避免两处重复计数。
export function attributeHostProcessTree(
  options: AttributeHostProcessTreeOptions,
): HostResourceUsageProcess[] {
// 先建 ppid → children 索引再遍历，避免对每个节点回扫整表（O(n²)）；
// 表里存在 ppid 指向已消失进程的孤儿行，它们不会出现在任何 children 列表里。
  const childrenByParent = new Map<number, number[]>();
  for (const sample of options.samples.values()) {
    const siblings = childrenByParent.get(sample.ppid) ?? [];
    siblings.push(sample.pid);
    childrenByParent.set(sample.ppid, siblings);
  }

// 登记所有已知归属根，后写覆盖先写：同一 pid 被登记为 agent 与内置插件时，内置插件生效（信息最具体）。
  const ownerRoots = new Map<number, Owner>();
  for (const agent of options.agents) {
    ownerRoots.set(agent.pid, { kind: "agent", agent });
// CLI 回报的 children 是唯一可信的 MCP 归属来源；请求失败时它是空数组，此时 MCP 会被归到 cli。
    for (const child of agent.children) {
      ownerRoots.set(child.pid, { kind: "mcp", child });
    }
  }
  for (const [pid, pluginName] of options.builtinPluginPids ?? []) {
    ownerRoots.set(pid, { kind: "builtin", pluginName });
  }

// visited 预置 hostPid 防环：极端 pid 复用或上报错误可能让 ppid 指回祖先，无 visited 会重复出行。
  const rows: HostResourceUsageProcess[] = [];
  const visited = new Set<number>([options.hostPid]);
  const visit = (pid: number, inheritedOwner: Owner | undefined): void => {
// 深度优先而非广度优先：归属靠继承，先确定父的 owner 再下传最自然；
// 最终统一按 pid 排序，遍历顺序不影响结果。
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const sample = options.samples.get(childPid);
      if (!sample) continue;
// rootOwner 命中即「重新归属」：嵌套插件（插件里再起 MCP）在此切换分组，其整棵子树随后继承新 owner。
      const rootOwner = ownerRoots.get(childPid);
      const owner = rootOwner ?? inheritedOwner;
      rows.push(ownerToRow(owner, sample, rootOwner !== undefined));
      visit(childPid, owner);
    }
  };
  visit(options.hostPid, undefined);

  // Agent 注册表里已知但不在 Host 子树下的进程（极端情况：ppid 被重排为 1）也补进来，避免拓扑丢行。
// 补挂不在 Host 子树下的归属根（极端情况：父进程先退出，ppid 被内核重排为 1）。
// 不补会让这些进程从列表消失，用户看到的总量与实际不符。
  for (const [pid, owner] of ownerRoots) {
    if (visited.has(pid)) continue;
    const sample = options.samples.get(pid);
    if (!sample) continue;
    visited.add(pid);
    rows.push(ownerToRow(owner, sample, true));
    visit(pid, owner);
  }

  return rows.sort((left, right) => left.pid - right.pid);
}
