// Windows 进程表读取（异步版）：给进程树终止逻辑提供 pid → (parentPid, startTime) 快照，
// 用于判定「某个 pid 是否还是当初那个进程」，避免 pid 复用后误杀无关进程。
// INV-01：startTime 一律归一成 windows-utc-us:<微秒>（守住者：normalizePowerShellStartTime）；
//         与其它平台标识格式隔离，跨平台比较永远不会误判为同一进程。
// INV-02：解析失败的行整行丢弃、绝不猜值（守住者：parseWindowsProcessList）；
//         猜一个值会让身份校验通过，等于绕过防 pid 复用的核心保护。
// INV-03：单飞共享只在查询起点晚于 root 启动时成立（守住者：startedAtMs 比较）；
//         复用早于 spawn 的快照必然查不到新 root，把可验证降级为 unverified。
// INV-04：任何路径都必须在上层 cleanup deadline 内返回（守住者：boundedWindowsLookupTimeoutMs、
//         awaitWindowsProcessListWithinDeadline）；超时返回空表，由调用方走 fail-closed。
// INV-05：CIM 硬失败后本进程不再重试（守住者：windowsCimCapability）；每次重试都要付一次
//         进程启动开销，而 ENOENT/EACCES 在进程生命周期内不会自愈。
import { execFile } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

// 单次查询上限 2.5s：Get-CimInstance 在慢机器上可能超过 1s，但 host 退出不能无限等；
// 超过后返回空表，调用方按「身份不可确认」处理，而不是当查询成功继续强杀。
const WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS = 2_500;
// .NET DateTime.Ticks 从 0001-01-01 起算，转 Unix 纪元要减这个固定偏移；
// 用 BigInt 常量而非 Number：值超过 2^53，double 会在低位丢精度导致时间比对失败。
const DOTNET_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const TICKS_PER_MICROSECOND = 10n;
const WINDOWS_START_TIME_PREFIX = "windows-utc-us:";

type WindowsCimCapability = "cim" | "identity-unavailable";

interface WindowsProcessListFlight {
  promise: Promise<readonly ProcessIdentity[]>;
  startedAtMs: number;
}

// [并发] 模块级单飞：所有 workspace 共享一次系统进程表查询；Host 里可能同时有多个
// 终止流程，重复 execFile 会在退出窗口内叠加 powershell 启动开销。
let windowsProcessListInFlight: WindowsProcessListFlight | undefined;
let windowsCimCapability: WindowsCimCapability | undefined;

// 只把「命令层面不可用」当硬失败：ENOENT（无 powershell.exe）、EACCES/EPERM（策略禁用）。
// 超时、退出码非零属于瞬时问题，下次仍应重试，不能固化成 identity-unavailable。
function isHardCimUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

// deadline 未设置时返回 undefined 而不是 Infinity：调用方据此区分「无上限」与
// 「已到期（0）」，后者要立刻返回空表，不再发起一次注定被丢弃的查询。
function remainingWindowsCleanupMs(options: ProcessTreeTerminatorOptions): number | undefined {
  return options.windowsCleanupDeadlineAtMs === undefined
    ? undefined
    : Math.max(options.windowsCleanupDeadlineAtMs - Date.now(), 0);
}

// [失败路径] 取 min(默认上限, 剩余 deadline)：默认值保证单次不拖太久，剩余值保证
// 整条清理链路不超出上层预算；再 max(...,0) 避免负数被 setTimeout 当成 0。
function boundedWindowsLookupTimeoutMs(
  defaultTimeoutMs: number,
  options: ProcessTreeTerminatorOptions,
): number {
  const remainingMs = remainingWindowsCleanupMs(options);
  return remainingMs === undefined
    ? defaultTimeoutMs
    : Math.max(Math.min(defaultTimeoutMs, remainingMs), 0);
}

// [资源] 用 Promise.race 加一个临时定时器：输掉 race 的 request 仍在跑，finally 里
// 必须 clearTimeout，否则每次调用都留下一个最长 2.5s 的悬挂句柄。
async function awaitWindowsProcessListWithinDeadline(
  request: Promise<readonly ProcessIdentity[]>,
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  const remainingMs = remainingWindowsCleanupMs(options);
  if (remainingMs === undefined) return await request;
// 预算已经用完就不再发起查询：返回空表让调用方走 fail-closed，比超时后才失败
// 少一次进程启动，也让退出路径不被 powershell 拖长。
  if (remainingMs <= 0) return [];

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<readonly ProcessIdentity[]>((resolve) => {
        deadlineTimer = setTimeout(() => resolve([]), remainingMs);
      }),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

// 两个解析器严格区分 pid / ppid 的合法域：pid 必须 > 0（Windows 无 pid 0 的进程），
// ppid 允许 0（System Idle 的父 pid）。用同一校验会把 Idle 的整棵子树丢掉。
function parsePositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

// 解析 `pid ppid ticks` 三列文本。PowerShell 输出可能混入空行、告警行、本地化提示，
// 因此逐行尝试、失败即跳过，绝不因为一行异常放弃整张表。
function parseWindowsProcessList(stdout: string): ProcessIdentity[] {
  const identities: ProcessIdentity[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, parentPidText, rawStartTime] = line.trim().split(/\s+/);
    const pid = parsePositiveInteger(pidText);
    const parentPid = parseNonNegativeInteger(parentPidText);
    const startTime = normalizePowerShellStartTime(rawStartTime);
// INV-02：三列缺一就丢行。补默认值（0 或当前时间）会让「查不到」伪装成「查到且匹配」，
// 直接击穿防 pid 复用的校验；丢行的代价只是少一个可验证进程，方向上是安全的。
    if (pid === undefined || parentPid === undefined || !startTime) continue;
    identities.push({ parentPid, pid, startTime });
  }
  return identities;
}

function normalizePowerShellStartTime(rawStartTime: string | undefined): string | undefined {
  if (!rawStartTime) return undefined;
  try {
// [失败路径] BigInt 构造对非数字文本抛 SyntaxError：CIM 偶尔把空值渲染成字符串，
// catch 成 undefined 让该行被丢弃，而不是让整次查询失败、退化成空表。
    const unixMicroseconds =
      (BigInt(rawStartTime) - DOTNET_UNIX_EPOCH_TICKS) / TICKS_PER_MICROSECOND;
    return `${WINDOWS_START_TIME_PREFIX}${unixMicroseconds}`;
  } catch {
    return undefined;
  }
}

// 复核单个 pid 的身份：拿当前 CreationDate 与记录值比对，相等才认为还是同一个进程。
// 任何不确定（查询失败、解析不到）都返回 false，宁可放弃强杀也不能误杀。
export async function verifyWindowsProcessIdentityAsync(
  identity: ProcessIdentity,
  timeoutMs: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<boolean> {
  if (process.platform !== "win32" || timeoutMs <= 0) return false;
  if (windowsCimCapability === "identity-unavailable") return false;
  // Windows 11 24H2 及部分 Win10 镜像不再提供 WMIC；Windows 10+ 统一使用
  // PowerShell/CIM，查询失败仍按 CreationDate 无法确认处理，禁止绕过身份校验强杀。
  return await new Promise<boolean>((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}" | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }`,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(
            options,
            `Windows root 身份 PowerShell 复核失败 pid=${identity.pid}:`,
            error ?? stderr,
          );
// [失败路径] 复核失败即 false：调用方会保持 fail-closed（不杀）。误报 true 的代价是
// pid 复用后杀掉用户的新进程，方向性错误不可接受，因此这里不做任何乐观兜底。
          resolve(false);
          return;
        }
        const current = parseWindowsProcessList(stdout).find(
          (processIdentity) => processIdentity.pid === identity.pid,
        );
// 只有成功拿到并解析出结果才记 cim 可用：查询超时不算可用（下次还要试），
// 但一旦有数据就说明 CIM 链路正常，后续无需再付探测成本。
        windowsCimCapability = "cim";
        resolve(current?.startTime === identity.startTime);
      },
    );
  });
}

// 读取整张进程表，供进程树遍历使用。空数组是合法的「未知」语义，调用方必须按
// fail-closed 处理，不能把空表当成「该进程没有子进程」而提前收工。
export async function readWindowsProcessListAsync(
  options: ProcessTreeTerminatorOptions,
): Promise<readonly ProcessIdentity[]> {
  if (windowsCimCapability === "identity-unavailable") return [];
  const ownedProcessStartedAtMs = options.ownedProcessStartedAtMs;
  if (
    windowsProcessListInFlight &&
    (ownedProcessStartedAtMs === undefined ||
      ownedProcessStartedAtMs < windowsProcessListInFlight.startedAtMs)
  ) {
    return await awaitWindowsProcessListWithinDeadline(windowsProcessListInFlight.promise, options);
  }

  // Get-CimInstance 在部分 Windows 机器上会超过 1 秒。同步等待会阻塞 Host
  // 的退出 deadline；共享同一个异步查询后，多个 workspace 可以复用一次系统进程表。
  // 旧共享 Promise 可能早于新 Agent 的 spawn 开始，复用这张进程表必然找不到
  // 新 root 并退化为 unverified。只有严格晚于 root 启动的查询才具备可复用资格。
// [并发] 记录查询起点而不是完成时间：比较的是「快照开始时 root 是否已存在」，
// 用完成时间会误认为晚完成就能覆盖早启动的进程，掩盖漏检。
  const startedAtMs = Date.now();
  const request = new Promise<readonly ProcessIdentity[]>((resolve) => {
    // 移除 WMIC 后直接走受支持的 CIM 后端，避免 ENOENT fallback 消耗 cleanup
    // deadline；查询失败返回空身份，调用方继续沿 fail-closed 路径观察退出。
    const timeoutMs = boundedWindowsLookupTimeoutMs(WINDOWS_PROCESS_LOOKUP_TIMEOUT_MS, options);
    if (timeoutMs <= 0) {
      resolve([]);
      return;
    }

    execFile(
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
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || !stdout) {
          if (isHardCimUnavailable(error)) windowsCimCapability = "identity-unavailable";
          warn(options, "查询 Windows runtime 进程表失败（异步）:", error ?? stderr);
          resolve([]);
          return;
        }
        const identities = parseWindowsProcessList(stdout);
        if (identities.length === 0)
          warn(options, "PowerShell 未返回可解析的 Windows runtime 进程表");
        if (identities.length > 0) windowsCimCapability = "cim";
        resolve(identities);
      },
    );
// [资源] finally 里只清自己那一次的单飞槽：若已被更新的查询替换，直接置 undefined
// 会把新查询也清掉，导致后续调用重复发起 powershell 并让多个流程互相覆盖。
  }).finally(() => {
    if (windowsProcessListInFlight?.promise === request) windowsProcessListInFlight = undefined;
  });
// 登记时带上起点时间，供后续调用判断「这张表是否晚于我的 root 启动」；
// 不记录完成时间，是因为复用资格取决于查询可见的进程集合，而不是返回时刻。
  windowsProcessListInFlight = { promise: request, startedAtMs };
  return await awaitWindowsProcessListWithinDeadline(request, options);
}
