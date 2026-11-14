// ============================================================================
// 进程树快照：在「杀进程」之前把仍属于某个 runtime 的进程身份固化成可复核的列表。
// 难点不是枚举而是 PID 复用——进程退出后 PID 会被系统重新分配，仅凭 PID 发信号
// 可能杀掉无关进程，因此每个成员都带 startTime，发送前必须逐条复核。
//
// INV-01：identities 中每条都是同一时刻采样出的 pid/ppid/pgid/创建时间，不允许拼接两次读取
//         （守住：refineLinuxProcessIdentity 的字段一致性校验）
// INV-02：拿不到创建标识的 root 不生成快照，半截快照会在延迟回收时沿裸 PID 认领无关进程树
//         （守住：captureProcessTreeSnapshot 的 rootIdentity 判空）
// INV-03：Windows 进程表只缓存一个 microtask：同一轮 quit 复用一次 PowerShell 查询，
//         同时保证下一次回收读不到过期 PID（守住：readWindowsProcessList 的 queueMicrotask）
// INV-04：采样失败一律返回空数组 / undefined，绝不抛错中断退出链路
//         （守住：readPosixProcessList / readWindowsProcessList 的提前 return）
// INV-05：POSIX 仅在 PGID === rootPid 时合并同组成员，避免把宿主进程组纳入快照
// ============================================================================
import { spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

const PROCESS_LOOKUP_TIMEOUT_MS = 1_000;
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MILLISECOND = 10_000n;

// [并发] 模块级缓存，生命周期只有一个 microtask：同一轮 quit 会同步抓多个 workspace，
// 复用同一份带 CreationDate 的进程表以避免反复起 PowerShell（单次约 300ms~1s）；
// 用 queueMicrotask 而非定时器失效，是为了在下一个异步机会立刻清空，不引入时间假设。
let windowsProcessListCache: readonly ProcessIdentity[] | undefined;

// 统一走 options.log（可注入），采样失败只看 warn 不抛错，避免退出链路因日志后端异常中断。
function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

// [失败路径] Number("") === 0、Number("12a") === NaN，因此必须同时校验整数与正数；
// pid/pgid 为 0 在 POSIX 语义里表示「无」，绝不能当成真实进程身份。
function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

// 解析 ps 输出：固定列 pid/ppid/pgid/lstart，命令列可选。
// [权衡] Darwin 没有高精度启动时间，于是把 command 拼进 startTime 增加复用校验熵；
// Linux 随后会被 /proc 的 tick 覆盖，这里只需保证不丢字段。
function parsePosixProcessList(stdout: string, includeCommand: boolean): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const [pidText, parentPidText, processGroupIdText] = fields;
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const processGroupId = parsePositiveInteger(processGroupIdText);
    const lstart = fields.slice(3, 8).join(" ");
    const command = includeCommand ? fields.slice(8).join(" ") : "";
    // Darwin 的 ps 只暴露秒级 lstart；追加完整 command 作为复用校验熵。
    // Linux 随后会用 /proc start ticks 覆盖该值。
    const startTime = includeCommand ? `${lstart}|command:${command}` : lstart;
    // [失败路径] 列数不足或字段非法的行整行跳过：半条身份信息比没有更危险，
    // 会被后续 filterCurrentProcessIdentities 当成「仍然存活」而误发信号。
    if (pid === undefined || parentPid === undefined || !processGroupId || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, processGroupId, startTime });
  }
  return identities;
}

// 解析 PowerShell 输出的三列 pid/ppid/CreationDate.Ticks。
// [权衡] Windows 没有进程组，processGroupId 留空，后续一律按 PPID 树判定归属。
function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, startTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    if (pid === undefined || parentPid === undefined || !startTime) {
      continue;
    }
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

// .NET ticks（自 0001-01-01 起的 100ns 计数）换算成 Unix 毫秒。
// [权衡] 全程用 BigInt：ticks 约 6.4e17 超过 Number.MAX_SAFE_INTEGER，先转 Number 会丢精度，
// 丢掉的低位恰好是「同一毫秒内复用」的判据；超出安全整数范围视为不可用而非截断。
function parseWindowsCreationTimeMs(startTime: string): number | undefined {
  try {
    const unixTicks = BigInt(startTime) - DOTNET_UNIX_EPOCH_TICKS;
    const timestamp = Number(unixTicks / TICKS_PER_MILLISECOND);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

// 一次 ps 采样；超时由 spawnSync 的 timeout 兜底。
// [失败路径] spawn 失败、被 SIGTERM/SIGKILL 杀掉（超时）、非零退出都返回空数组：
// 调用方据此认为「没有可回收的后代」，宁可漏杀也不能误杀，误杀会波及宿主进程。
function readPosixProcessList(options: ProcessTreeTerminatorOptions): ProcessIdentity[] {
  const includeCommand = process.platform === "darwin";
  const result = spawnSync(
    "ps",
    includeCommand
      ? ["-axo", "pid=,ppid=,pgid=,lstart=,command="]
      : ["-eo", "pid=,ppid=,pgid=,lstart="],
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    },
  );
  if (result.error) {
    warn(options, "查询 runtime 后代进程失败（进程表查询）:", result.error);
    return [];
  }
  // [失败路径] timeout 命中时 spawnSync 用信号终止子进程，单独记一条便于区分「ps 本身报错」。
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    warn(options, `查询 runtime 后代进程失败（进程表超时） signal=${result.signal}`);
    return [];
  }
  if (result.status !== 0 || !result.stdout) {
    warn(options, `查询 runtime 后代进程失败（进程表查询） status=${result.status ?? "unknown"}`);
    return [];
  }
  return parsePosixProcessList(result.stdout, includeCommand);
}

// Windows 没有 /proc，只能起 PowerShell 查 Win32_Process；单次成本高，因此带缓存。
// [资源] windowsHide + -NonInteractive + -NoProfile：避免闪出黑框，也避免用户 profile 拖慢或污染输出。
// [权衡] 用 Get-CimInstance 而非 tasklist：只有前者能拿到 CreationDate，而它是 PID 复用的唯一判据。
function readWindowsProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  // [并发] 命中缓存直接返回同一份只读数组；调用方不得修改，所有下游都只做 filter/map。
  if (windowsProcessListCache) {
    return windowsProcessListCache;
  }
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
    ],
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    warn(
      options,
      `查询 Windows runtime 进程表失败 status=${result.status ?? "unknown"}:`,
      result.error ?? result.stderr,
    );
    return [];
  }
  const identities = parseWindowsProcessList(result.stdout);
  windowsProcessListCache = identities;
  // 同一轮 app quit 会同步抓取多个 workspace，复用同一份带 CreationDate 的系统进程表；
  // 下个 microtask 立即失效，避免稍后的 restart/quit 把 PID 复用误判成旧进程。
  // [并发] 失效时比对身份再清空：若期间已有新一轮采样写入新数组，
  // 这里的回调不能把它抹掉，否则下一轮会重复起 PowerShell 且可能读到半新半旧的数据。
  queueMicrotask(() => {
    if (windowsProcessListCache === identities) {
      windowsProcessListCache = undefined;
    }
  });
  return identities;
}

function readProcessList(options: ProcessTreeTerminatorOptions): readonly ProcessIdentity[] {
  return process.platform === "win32"
    ? readWindowsProcessList(options)
    : readPosixProcessList(options);
}

// Linux 专用：用 /proc/<pid>/stat 的启动 tick 覆盖 ps 的秒级 lstart。
// [失败路径] 返回 undefined 表示「不能再确认这个进程就是快照里的那个」——已退出，
// 或两次采样之间发生了 reparent/PID 复用；调用方必须剔除，而不是保留旧值。
function refineLinuxProcessIdentity(identity: ProcessIdentity): ProcessIdentity | undefined {
  if (process.platform !== "linux") {
    return identity;
  }
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    // [权衡] 用最后一个 ")" 定位 comm 结束：comm 本身可能含 ")"，从第一个 ")" 切会把
    // 后续字段整体错位，field 22 的 tick 就会取到错误列。
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    // /proc/<pid>/stat 的 field 22 是自 boot 起的启动 tick；精度高于 ps lstart
    // 的秒级时间，PID 在同一秒被复用时也不会被误认成旧 runtime 成员。
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const parentPid = parseNonNegativeInteger(fieldsAfterCommand[1]);
    const processGroupId = parsePositiveInteger(fieldsAfterCommand[2]);
    const startTimeTicks = fieldsAfterCommand[19];
    if (
      // [失败路径] ps 与 /proc 两次读取的 ppid/pgid 必须完全一致，否则说明中间发生了
      // reparent 或 PID 复用，此时拼出的身份是两代进程的混合体，必须丢弃。
      parentPid === undefined ||
      !processGroupId ||
      !startTimeTicks ||
      parentPid !== identity.parentPid ||
      processGroupId !== identity.processGroupId
    ) {
      // ps 与 /proc 两次读取间发生 PID 复用/reparent 时，不能拼出混合身份。
      return undefined;
    }
    return {
      ...identity,
      parentPid,
      processGroupId,
      startTime: `linux-ticks:${startTimeTicks}`,
    };
  } catch {
    return undefined;
  }
}

// 非 Linux 平台没有更精确的启动时间，直接浅拷贝返回，让调用方拿不到原数组引用。
// [失败路径] Linux 上剔除不可确认条目会让快照变小：保守策略，宁可漏杀不可误杀。
function refineProcessIdentities(identities: readonly ProcessIdentity[]): ProcessIdentity[] {
  if (process.platform !== "linux") {
    return [...identities];
  }
  return identities
    .map((identity) => refineLinuxProcessIdentity(identity))
    .filter((identity): identity is ProcessIdentity => identity !== undefined);
}

// 按 PPID 建索引后做 DFS，得到 root 的全部后代。
// [失败路径] seen 集合防止父子环（采样抖动或已复用的 PID 互相指认）导致无限递归；
function collectDescendantIdentitiesFromProcessList(
  rootPid: number,
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const childrenByParentPid = new Map<number, ProcessIdentity[]>();
  for (const identity of identities) {
    const children = childrenByParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParentPid.set(identity.parentPid, children);
  }

  const descendants: ProcessIdentity[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number) => {
    for (const child of childrenByParentPid.get(pid) ?? []) {
      // [失败路径] 已访问则跳过：同一进程可能因 PPID 指向自身或多父引用被遍历两次，重复入列会重复发信号。
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      descendants.push(child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  return descendants;
}

// 发信号前的复核：把快照里的身份与当前进程表逐条比对，只留下仍是同一代进程的条目。
// [并发] 采样与发信号之间必然存在时间窗，这里不追求原子，而是把窗口内出现的新进程挡在外面：
// 只有 startTime 相同（Linux 还要求 pgid 相同）才算同一个进程。
export function filterCurrentProcessIdentities(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (identities.length === 0) {
    return [];
  }
  // [权衡] 先按 pid 过滤当前进程表再逐个读 /proc：整表 refine 会对每个进程做一次文件 IO，
  // 在进程多的机器上明显拖慢退出；只复核快照里的 pid 把 IO 收敛到影响面。
  const trackedPids = new Set(identities.map((identity) => identity.pid));
  const currentByPid = new Map(
    refineProcessIdentities(
      readProcessList(options).filter((identity) => trackedPids.has(identity.pid)),
    ).map((identity) => [identity.pid, identity]),
  );
  // processGroupId 缺省（Windows）时只比 startTime；POSIX 上再比 pgid，
  // 防止 PID 复用后虽然创建时间巧合相同、但已换到别的进程组。
  return identities.filter((identity) => {
    const current = currentByPid.get(identity.pid);
    return (
      current?.startTime === identity.startTime &&
      (identity.processGroupId === undefined || current.processGroupId === identity.processGroupId)
    );
  });
}

// 以 child 为根抓一次进程树快照；调用方随后会用它做延迟回收。
// [失败路径] 拿不到 child.pid（同步 spawn 失败）或进程表里查不到根进程时返回 undefined：
// 无根即无所有权，任何「猜」出来的后代都可能在 PID 复用后指向无关进程。
export function captureProcessTreeSnapshot(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  // [失败路径] pid 为空说明 spawn 尚未成功或已失败，此时没有可冻结的进程树。
  if (child.pid == null) {
    return undefined;
  }
  const processList = readProcessList(options);
  const rootIdentity = processList.find((identity) => identity.pid === child.pid);
  if (!rootIdentity) {
    // 没有创建标识的 rootPid 不能形成进程所有权；返回半截快照会让
    // 延迟回收在 PID 复用后重新沿裸 root PID 认领无关进程树。
    return undefined;
  }
  // 后代按 PPID 链收集；再补一层进程组兜底（见下），两者取并集去重。
  const descendantIdentities = collectDescendantIdentitiesFromProcessList(child.pid, processList);
  // POSIX detached root 是自己进程组的 leader；若它在 ps 扫描期间退出，
  // 后代会被 reparent，单靠 PPID 链会漏掉仍属于该 owned PGID 的进程。仅在
  // PGID === root PID 时合并同组成员，避免把普通 child 所在的宿主进程组纳入快照。
  const ownedProcessGroupIdentities =
    process.platform !== "win32" && rootIdentity.processGroupId === child.pid
      ? processList.filter((identity) => identity.processGroupId === child.pid)
      : [];
  // [权衡] 用 Map 以 pid 为键合并三路来源：root、PPID 后代、进程组同组成员会大量重叠，
  // 三路都来自同一次 processList 采样，因此不会拼出跨时刻的混合身份。
  const snapshotCandidates = new Map(
    [rootIdentity, ...descendantIdentities, ...ownedProcessGroupIdentities].map((identity) => [
      identity.pid,
      identity,
    ]),
  );
  // [失败路径] refine 之后可能丢掉根进程本身（采样窗口内退出/被复用）；此时不能返回快照，
  // 否则 rootPid 与 identities 不再自洽，下游会用裸 PID 重新认领进程树。
  const identities = refineProcessIdentities([...snapshotCandidates.values()]);
  if (!identities.some((identity) => identity.pid === child.pid)) {
    return undefined;
  }
  return {
    rootPid: child.pid,
    descendantPids: identities
      .filter((identity) => identity.pid !== child.pid)
      .map((identity) => identity.pid),
    identities,
  };
}

// 按宿主 spawn 时拥有的 PGID 抓快照，用于 detached Agent（root 可能先于成员退出）。
// [权衡] 只在 cleanup 边界调用：进程表扫描（Windows 需起 PowerShell）成本高，
// 不能放进协议消息热路径；PGID 由宿主分配，不会像 PID 那样被无关进程复用。
export function captureProcessGroupSnapshot(
  processGroupId: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  // [失败路径] Windows 没有进程组语义，非法 PGID 直接返回 undefined，避免误把整表当成同组。
  if (process.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return undefined;
  }
  // POSIX detached Agent 的 root 可能先于同组 MCP/工具进程退出，
  // 此时 PPID 已经变化，但内核会在最后一个成员退出前保留原 PGID。只在 cleanup
  // 边界按 Host spawn 时拥有的 PGID 查询，避免把进程表扫描带入协议消息热路径。
  const identities = refineProcessIdentities(
    readProcessList(options).filter((identity) => identity.processGroupId === processGroupId),
  );
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid: processGroupId,
    descendantPids: identities
      .filter((identity) => identity.pid !== processGroupId)
      .map((identity) => identity.pid),
    identities,
  };
}

// Windows 专用：root 已退出时仍按 ParentProcessId 反查其后代。
// [失败路径] 缺少启动/退出时间戳就无法把候选限制在 root 生命周期内，此时宁可返回 undefined；
// 任何一项时间非法都会让 PID 复用校验失去意义。
export function captureExitedRootDescendantsSnapshot(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): ProcessTreeSnapshot | undefined {
  const startedAtMs = options.ownedProcessStartedAtMs;
  const exitedAtMs = options.ownedProcessExitedAtMs;
  if (
    // [失败路径] 平台与参数一起校验：这里是唯一允许「裸 PPID 反查」的入口，前提必须有时间窗。
    process.platform !== "win32" ||
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return undefined;
  }
  // Windows Win32_Process 会保留创建者 ParentProcessId，即使 CLI root
  // 已经退出。裸 ParentProcessId 会在 PID 复用后误认领无关进程，因此候选成员的
  // CreationDate 还必须落在 Host 记录的 root 生命周期内；后续 force 再按同一
  // CreationDate 复核，不能向已经复用的 descendant PID 发信号。
  // [权衡] 先按 CreationDate 落到 [startedAtMs, exitedAtMs] 再建树：
  // 反过来先建整棵树再过滤，会让已被复用的 PID 充当中间节点，把无关进程挂进快照。
  const processList = readProcessList(options).filter((identity) => {
    const createdAtMs = parseWindowsCreationTimeMs(identity.startTime);
    return createdAtMs !== undefined && createdAtMs >= startedAtMs && createdAtMs <= exitedAtMs;
  });
  const identities = collectDescendantIdentitiesFromProcessList(rootPid, processList);
  if (identities.length === 0) {
    return undefined;
  }
  return {
    rootPid,
    descendantPids: identities.map((identity) => identity.pid),
    identities,
  };
}
