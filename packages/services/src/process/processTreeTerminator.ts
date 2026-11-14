/* eslint-disable max-lines -- Windows 进程树清理需要集中维护跨阶段的安全边界与 deadline。 */
// 进程树终止器：一次 spawn 产生的 root、其后代、detached 的 runtime/MCP 子进程都要在
// 有限预算内收敛退出，并在杀不掉时如实上报剩余 PID。
// 核心风险不是“杀不掉”而是“杀错”：PID 会复用、Node 的 exitCode 会滞后、快照会过期，
// 因此“能证明归属”才是发送任何信号的凭证；证明不了只能观察并上报，不能扩大打击面。
// INV-01：SIGKILL 与 taskkill /F 的目标必须带本次核对过的身份（守住：两个 force 函数的 targets；破坏：PID 复用后杀掉无关新进程）。
// INV-02：graceful（SIGTERM / taskkill 不带 /F）先于 force（SIGKILL / /F）（守住：terminatePosixProcessTree；破坏：跳过子进程落盘，留下半写文件与孤儿端口）。
// INV-03：force 定时器独立于 graceful flight，互不 await（守住：scheduleForceCleanup 调用点；破坏：await 会吃掉 force 预算，卡死进程永久残留）。
// INV-04：POSIX 只在 child 属于本组时用 kill(-pid)（守住：terminatePosixProcessTree 的 canSignalOwnedGroup；破坏：误伤同 pgid 的其它进程）。
// INV-05：unverifiedRootOnly 下禁止对裸 PID 发 taskkill /T（守住：各 targets 构造处；破坏：身份查询失败时整棵同名树被误杀）。
// INV-06：等待式清理把 graceful flight 纳入完成屏障（守住：onGracefulCleanupScheduled；破坏：回调稍晚即把正常退出误报为残留）。
import type { ChildProcess } from "node:child_process";
import {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
} from "#src/process/processTreeSnapshot.js";
import {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  verifyWindowsProcessIdentityAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import {
  resolveCurrentOwnedIdentities,
  resolveCurrentOwnedIdentitiesAsync,
} from "#src/process/processTreeOwnership.js";
import { waitForProcessTreeTermination } from "#src/process/processTreeWaiter.js";
import { defaultWindowsTaskkillRunner } from "#src/process/windowsTaskkillRunner.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

export {
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
} from "#src/process/processTreeSnapshot.js";
export {
  captureExitedRootDescendantsSnapshotAsync,
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
export type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorLogger,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
  WindowsTaskkillRequest,
  WindowsTaskkillResult,
  WindowsTaskkillRunner,
} from "#src/process/processTreeTypes.js";

// graceful 用 SIGTERM：子进程可捕获后落盘、关连接；直接 SIGKILL 会留下半写文件。
// force 才升级到 SIGKILL（见 POSIX_FORCE_SIGNAL）：SIGTERM 可被忽略，没有升级就收不掉卡死的进程。
const POSIX_TERMINATION_SIGNAL = "SIGTERM";
const POSIX_FORCE_SIGNAL = "SIGKILL";
// 单次 taskkill 的命令超时：taskkill 是外部进程，可能因为系统繁忙长期不返回。
// 没有这个上限，一次挂起就会吃掉整棵树的收敛预算，后续 force 阶段根本没机会执行。
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
// force 前为“重新核对创建标识”预留的预算：从 forceDelayMs 中切出，而不是额外延长 deadline。
// 低于这个值时不做复核（见 canRecheckIdentitiesWithinDeadline），直接退回只信句柄的保守目标集。
const WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS = 750;
// 默认 graceful 窗口 2s：足够常规 runtime 收尾，又不会让调用方等过久；可由 forceAfterMs 覆盖。
const DEFAULT_FORCE_AFTER_MS = 2_000;

// 内部选项：knownIdentities / resolvedOwnership / 回调都挂在 options 上传递，避免再造一套签名；
// 这些字段不属于公开契约，调用方从外部传入也不会被信任。
// unverifiedRootOnly 是 fail-closed 开关：身份查询失败后只允许通过 ChildProcess 句柄观察，禁止裸 PID 操作。
interface InternalProcessTreeTerminatorOptions extends ProcessTreeTerminatorOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
  /** 进程身份查询失败，只观察原 ChildProcess，禁止向裸 PID 发送 taskkill。 */
  unverifiedRootOnly?: boolean;
}

// force 结果：identities 是复核后仍属于原树的身份，交给 waiter 汇总 remainingPids；
// unverifiedRootPid 表示 root 已无法用快照证明、但句柄仍持有，必须上报而不是静默丢弃。
interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

// POSIX 需要独立进程组（detached）才能在终止时用 kill(-pid) 覆盖整棵树；
// Windows 没有进程组语义，detached 只影响控制台与信号投递，还会削弱 taskkill /T 的父子关联，
// 所以 Windows 返回 false，终止统一走 taskkill。
export function shouldSpawnInDetachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

function warn(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.warn(options.traceId, message, ...args);
}

function debug(options: ProcessTreeTerminatorOptions, message: string, ...args: unknown[]): void {
  options.log?.debug?.(options.traceId, message, ...args);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isMissingProcessError(error: unknown): boolean {
  return getErrorCode(error) === "ESRCH";
}

// signal 0 只做存在性与权限探测，不投递信号。
// EPERM 说明进程存在但无权限，这里统一按“不存活”返回：宁可少杀，也不对不可控 PID 动手。
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// force 定时器默认 unref：非等待式关闭不能让一个 2s 兜底计时器拖住 Host 退出。
// keepTimerRef 为 true（等待式调用）时保持 ref，否则事件循环可能在 force 触发前就空转结束。
// Math.max(...,0) 防止负的剩余预算让 setTimeout 立即提前升级到 SIGKILL。
function scheduleForceCleanup(
  callback: () => void,
  timeoutMs: number,
  keepTimerRef: boolean,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, Math.max(timeoutMs, 0));
  if (!keepTimerRef) {
    timer.unref();
  }
  return timer;
}

// 单 PID 信号：ESRCH 表示目标已退出，属于正常竞态，不告警；
// 其它错误（EPERM 等）必须 warn，否则“以为杀掉了”会掩盖真正的残留进程。
// 返回值表示是否成功投递，调用方据此决定是否再走兜底路径。
function killPid(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(options, `发送 runtime 进程终止信号失败 pid=${pid} signal=${signal}:`, error);
    }
    return false;
  }
}

// 负 PID 表示向整个进程组投递信号，这是 POSIX 上收掉 root 全部后代的主路径。
// 只有确认 child 属于该组（或仍被句柄持有）时才可调用：pgid 与 PID 一样会被复用，
// 同号不等于“还是我们那个组”，误发会命中别的会话。
// 与 killPid 一致：ESRCH 视为已退出，其余错误告警但不抛，终止流程必须继续走完。
function killPosixProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminatorOptions,
): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (!isMissingProcessError(error)) {
      warn(options, `发送 runtime 进程组终止信号失败 pgid=${pid} signal=${signal}:`, error);
    }
    return false;
  }
}

// 单个 PID 的 taskkill 调用：超时下限取 1ms，防止 0/负数让 runner 立即放弃。
// taskkill 必须自带超时，不能依赖外层 deadline——一次挂起会吃掉整棵树的收敛预算。
// runner 抛错统一折成 { error }，让“是否仍在存活”的判断只有一条路径。
// durationMs 只用于 debug：终止路径的高频日志必须是 debug，避免生产日志随进程数膨胀。
async function runWindowsTaskkill(
  pid: number,
  force: boolean,
  options: ProcessTreeTerminatorOptions,
): Promise<void> {
  const timeoutMs = Math.max(options.windowsTaskkillTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS, 1);
  const runner = options.windowsTaskkillRunner ?? defaultWindowsTaskkillRunner;
  const startedAt = Date.now();
  debug(options, "Windows runtime 进程树 taskkill started", { force, pid, timeoutMs });
  let result;
  try {
    result = await runner({ force, pid, timeoutMs });
  } catch (error) {
    result = { error };
  }
  debug(options, "Windows runtime 进程树 taskkill completed", {
    durationMs: Date.now() - startedAt,
    force,
    pid,
    success: !result.error,
  });
// 只有“taskkill 失败且 PID 仍存活”才告警：进程自行退出时 taskkill 报找不到进程
// 是预期竞态，告警会淹没真正的残留。
  if (result.error && isPidAlive(pid)) {
    warn(
      options,
      `${force ? "强制清理" : "请求"} runtime 进程树退出失败 pid=${pid} status=${String(
        typeof result.error === "object" && result.error !== null && "code" in result.error
          ? ((result.error as { code?: unknown }).code ?? "unknown")
          : "unknown",
      )}:`,
      result.error,
      result.stderr,
    );
  }
}

// Windows 强杀：先解析“此刻仍属于原树”的身份，再对每个 PID 执行 taskkill /F /T。
// 解析失败时 identities 为空，只剩两个安全目标：句柄仍持有的 root、以及 deadline 路径下
// 在预留窗口内复核过 CreationDate 的身份。
// 裸 PID 永不进 targets——PID 复用后 /T 会连无关子树一起杀掉。
async function forceTerminateWindowsProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  verifiedOwnership?: ProcessTreeOwnershipResolution,
  deadlineSnapshotOnly = false,
  deadlineVerifiedIdentities: readonly ProcessIdentity[] = [],
): Promise<ForceCleanupResult> {
  const { childStillOwned, currentIdentities } =
    verifiedOwnership ??
    (await resolveCurrentOwnedIdentitiesAsync(child, knownIdentities, options, false));
  // 旧快照和滞后的 Node exitCode 都不能证明 deadline 时 PID 仍属于原进程树。
  // deadline 路径只允许强杀预留窗口内重新核对过 CreationDate 的 root/后代；查询失败的
  // 旧身份继续交给 waiter 报告残留，但绝不作为 /F 目标，避免 PID 复用误杀。
// deadline 路径只信本次复核过的身份；非 deadline 路径沿用当前解析结果。
// 分叉是 fail-closed 的：复核失败的身份不进入 /F 目标，交给 waiter 报残留。
  const targets = new Set(
    deadlineSnapshotOnly
      ? deadlineVerifiedIdentities.map((identity) => identity.pid)
      : currentIdentities.map((identity) => identity.pid),
  );
  const unverifiedRootOnly = (options as InternalProcessTreeTerminatorOptions).unverifiedRootOnly;
  if (childStillOwned && child.pid != null && !unverifiedRootOnly && !deadlineSnapshotOnly) {
    targets.add(child.pid);
  }
  // 定向 CIM 复核超时不应让仍由 ChildProcess 句柄持有的 root 永久残留。
  // 句柄确认 root 仍存活后，taskkill /T 只针对该 root，不会按失效快照认领新 PID。
  if (
    deadlineSnapshotOnly &&
    !unverifiedRootOnly &&
    child.pid != null &&
    typeof child.kill === "function" &&
    child.exitCode === null &&
    child.signalCode === null &&
    isPidAlive(child.pid)
  ) {
    targets.add(child.pid);
  }
// [并发] 并发而不是串行：每个目标都有独立 2s 超时，串行会把总耗时乘上目标数并突破 deadline。
// 单个失败不影响其它目标，失败原因由 runWindowsTaskkill 内部告警。
  await Promise.all([...targets].map((targetPid) => runWindowsTaskkill(targetPid, true, options)));
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === child.pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: child.pid } : {}),
  };
}

// 非等待式 Windows 入口：graceful taskkill 立即发出，force 由独立定时器在剩余预算后触发。
// 这里不 await 任何 Promise：close 路径要求“发信号即返回”，收敛观察由 terminateProcessTreeAndWait 负责。
// startedAtMs 由调用方在解析归属前记录，保证 CIM 查询耗时也计入 force 预算。
function terminateWindowsProcessTreeWithOwnership(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
  ownership: ProcessTreeOwnershipResolution,
  startedAtMs: number,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
// 句柄自有 root 的判据：未开启 unverifiedRootOnly、kill 可用、尚未 exit、PID 仍存活。
// exitCode/signalCode 非空说明 Node 已回收该子进程，此时 PID 可能已被复用，不能再当作 root。
  const childHandleOwnsLiveRoot =
    !internalOptions.unverifiedRootOnly &&
    typeof child.kill === "function" &&
    child.exitCode === null &&
    child.signalCode === null &&
    isPidAlive(pid);
  const gracefulTargets =
    ownership.childStillOwned && !internalOptions.unverifiedRootOnly
      ? [pid]
      : ownership.currentIdentities.map((identity) => identity.pid);
  // CIM 查询在系统高负载下可能超过一次 cleanup deadline，但仍存活的
  // ChildProcess 句柄可以证明 root 属于当前 Host。此时允许用 root /T 作为安全兜底，
  // 只扩大到该句柄对应的活进程，不沿裸 PID 重新发现或认领进程树。
// CIM 查询超时会让 targets 变空；只要句柄还证明 root 活着，就补一个 root-only 目标，
// 否则“查不到身份”会退化成“完全不发信号”，进程树永久残留。
  if (gracefulTargets.length === 0 && childHandleOwnsLiveRoot) gracefulTargets.push(pid);
  const gracefulFlight = Promise.all(
    [...new Set(gracefulTargets)].map((targetPid) => runWindowsTaskkill(targetPid, false, options)),
  ).then(() => undefined);
  // 等待式清理过去把 graceful taskkill fire-and-forget 后只等 force 窗口，
  // taskkill callback/ChildProcess exit 稍晚到达时会把正常退出误报为 remaining PID。
  // 非等待式调用仍不 await；等待式 waiter 通过回调把同一 flight 纳入完成屏障。
// [并发] graceful flight 必须登记给 waiter，才能纳入完成屏障；否则 taskkill 回调晚几毫秒，
// 正常退出就会被误报为 remaining PID。void 保持不 await，非等待式路径不能被 taskkill 拖住。
  internalOptions.onGracefulCleanupScheduled?.(gracefulFlight);
  void gracefulFlight;
  const forceDelayMs = Math.max(
    (options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS) - (Date.now() - startedAtMs),
    0,
  );
  const identitiesToRecheck = ownership.currentIdentities.filter(
    (identity) => !internalOptions.unverifiedRootOnly || identity.pid !== pid,
  );
// 复核预算从 forceDelayMs 中切出（定时器提前 750ms 触发），因此复核不增加总 deadline。
// 身份列表为空或剩余预算不足时直接跳过复核，退回只信句柄的保守目标集。
  const canRecheckIdentitiesWithinDeadline =
    identitiesToRecheck.length > 0 && forceDelayMs >= WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS;
  const forceTimer = scheduleForceCleanup(
    () => {
      // 非等待式关闭不会注入观察回调；强制回收必须先独立执行，
      // 不能作为 optional call 的参数，否则回调缺失时参数也不会求值。
// 异步 IIFE 保证强制回收无条件执行；不能写成 optional call 的实参，否则回调缺失时参数不求值。
// [失败路径] 结果经 then 交给 onForceCleanup；非等待式调用没有该回调，残留仅由 waiter 观察。
      void (async () => {
        // 只定向复核并强杀 root 是不够的：当 graceful /T 失败或后代已经
        // reparent 时，已知 MCP/runtime 后代永远没有 force flight。这里在 force 前预留的
        // 同一份预算内并发复核所有已知身份，不增加总 deadline；每个 PID 只有 CreationDate
        // 本次仍匹配才进入 /F，查询失败继续 fail-closed。
// 只定向复核 root 不够：graceful 失败或后代已 reparent 时，已知 MCP/runtime 后代永远没有 force 目标。
// 这里在预留预算内并发复核所有已知身份，只有创建标识本次仍匹配的才进入 /F，查询失败即排除。
        const deadlineVerifiedIdentities = canRecheckIdentitiesWithinDeadline
          ? (
              await Promise.all(
                identitiesToRecheck.map(async (identity) =>
                  (await verifyWindowsProcessIdentityAsync(
                    identity,
                    WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS,
                    options,
                  ))
                    ? identity
                    : undefined,
                ),
              )
            ).filter((identity): identity is ProcessIdentity => identity !== undefined)
          : [];
        return await forceTerminateWindowsProcessTree(
          child,
          ownership.knownIdentities,
          options,
          ownership,
          true,
          deadlineVerifiedIdentities,
        );
      })().then((result) => internalOptions.onForceCleanup?.(result));
    },
    canRecheckIdentitiesWithinDeadline
      ? forceDelayMs - WINDOWS_FORCE_IDENTITY_RECHECK_BUDGET_MS
      : forceDelayMs,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

// 已有归属解析结果就同步进入 graceful 阶段，省掉一次 CIM 查询；否则异步解析后再进入。
// [并发] 解析 Promise 不 await：解析窗口由 force 定时器兜底，不会漏杀。
function terminateWindowsProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const startedAtMs = Date.now();
  if (internalOptions.resolvedOwnership) {
    terminateWindowsProcessTreeWithOwnership(
      child,
      options,
      internalOptions.resolvedOwnership,
      startedAtMs,
    );
    return;
  }
  void resolveCurrentOwnedIdentitiesAsync(
    child,
    internalOptions.knownIdentities ?? [],
    options,
  ).then((ownership) => {
    terminateWindowsProcessTreeWithOwnership(child, options, ownership, startedAtMs);
  });
}

// POSIX 强杀：SIGKILL 不可捕获，必须先把目标集合收敛到“已证明属于原树”的身份。
// 顺序：先整组（覆盖未单独枚举的后代），再倒序补杀个体（叶子先于父进程），
// 避免父进程先死导致后代被 reparent 后失去可追踪的父子关系。
function forceTerminatePosixProcessTree(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): ForceCleanupResult {
  const pid = child.pid!;
  const { childStillOwned, currentIdentities } = resolveCurrentOwnedIdentities(
    child,
    knownIdentities,
    options,
    false,
  );
  const canSignalOwnedGroup =
    childStillOwned || currentIdentities.some((identity) => identity.processGroupId === pid);
// 仅当 root 仍被句柄持有，或某个已知身份的 pgid 等于 root pid 时才认这个组；
// 否则 kill(-pid) 可能命中复用后的同号进程组。
  if (canSignalOwnedGroup) {
    killPosixProcessGroup(pid, POSIX_FORCE_SIGNAL, options);
  }
// toReversed 让子进程先收到信号：父进程先退出会让后代被 init 收养，之后只能靠快照 PID 命中。
// root 已在组信号里覆盖过，这里跳过以免重复投递。
  for (const identity of currentIdentities.toReversed()) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
// 组信号发不出去时，仍可对“身份已验证的 root 单 PID”补一刀；
// 这是最后一个安全兜底，因为创建时间已证明它还是原来的 root。
  if (!canSignalOwnedGroup) {
    const rootIdentity = currentIdentities.find((identity) => identity.pid === pid);
    if (rootIdentity) {
      killPid(rootIdentity.pid, POSIX_FORCE_SIGNAL, options);
    }
  }
  const hasVerifiedRoot = currentIdentities.some((identity) => identity.pid === pid);
  return {
    identities: currentIdentities,
    ...(childStillOwned && !hasVerifiedRoot ? { unverifiedRootPid: pid } : {}),
  };
}

// 非等待式 POSIX 入口：先 SIGTERM 整组与已知后代，2s 后由定时器升级 SIGKILL。
// 两阶段的意义：给 runtime/MCP 落盘与释放端口的机会；直接 SIGKILL 会留下半写文件、
// 孤儿 socket 与未 flush 的日志，下次启动可能被误判为崩溃。
// 归属解析复用 resolvedOwnership（若上层已算过），避免重复遍历 /proc。
function terminatePosixProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): void {
  const pid = child.pid!;
  const internalOptions = options as InternalProcessTreeTerminatorOptions;
  const ownership =
    internalOptions.resolvedOwnership ??
    resolveCurrentOwnedIdentities(child, internalOptions.knownIdentities ?? [], options);
  const canSignalOwnedGroup =
    ownership.childStillOwned ||
    ownership.currentIdentities.some((identity) => identity.processGroupId === pid);
// 记录组信号是否真的投递成功：只有失败时才补发 root 单 PID，避免同一次终止发两遍信号。
  const signaledProcessGroup = canSignalOwnedGroup
    ? killPosixProcessGroup(pid, POSIX_TERMINATION_SIGNAL, options)
    : false;

  // detached runtime/MCP 后代不在 root 进程组内；只对创建标识仍匹配的
  // 生前快照成员发信号，避免延迟回收把复用后的同 PID 进程当成旧后代误杀。
  for (const identity of ownership.currentIdentities) {
    if (identity.pid !== pid) {
      killPid(identity.pid, POSIX_TERMINATION_SIGNAL, options);
    }
  }
// 组信号失败但句柄仍持有 root：说明组可能尚未建立或已被拆散，对 root 单独 SIGTERM 作为兜底。
// childStillOwned 为 false 时不再补发：此时 PID 归属未证实，补发就是裸 PID 操作。
  if (!signaledProcessGroup && ownership.childStillOwned) {
    killPid(pid, POSIX_TERMINATION_SIGNAL, options);
  }

  const forceTimer = scheduleForceCleanup(
    () => {
      // 非等待式关闭不会注入观察回调；强制回收必须先独立执行，
      // 不能作为 optional call 的参数，否则回调缺失时参数也不会求值。
// force 阶段同步执行：此刻已过 forceAfterMs，不能再引入异步等待。
// 结果通过 onForceCleanup 交给 waiter 汇总 remainingPids。
      const result = forceTerminatePosixProcessTree(child, ownership.knownIdentities, options);
      internalOptions.onForceCleanup?.(result);
    },
    options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS,
    Boolean(options.keepForceTimerRef),
  );
  internalOptions.onForceTimerScheduled?.(forceTimer);
}

// 公开的“发信号即返回”入口：不等待收敛，供 close/kill 路径使用；
// 需要知道是否杀干净必须用 terminateProcessTreeAndWait。
export function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): void {
  if (child.pid == null) {
    // 测试替身或极早期 spawn 失败场景可能拿不到 pid。
    // 这时无法按进程组/进程树兜底，但仍保留旧的 child.kill() 关闭语义。
    try {
      child.kill(POSIX_TERMINATION_SIGNAL);
    } catch (error) {
      warn(options, "发送 runtime 进程终止信号失败 pid=unknown:", error);
    }
    return;
  }

// 平台分派：Windows 无信号语义，统一 taskkill；其余平台走进程组 + SIGTERM/SIGKILL。
// 分支在入口固定，避免单次调用中途切换平台假设。
  if (process.platform === "win32") {
    terminateWindowsProcessTree(child, options);
    return;
  }
  terminatePosixProcessTree(child, options);
}

// 等待式入口：发出终止请求后在有界预算内观察整棵树直到收敛，返回仍存活的 PID。
// 返回 remainingPids 而非抛错：调用方需要区分“已收敛”和“有残留但无法安全处理”。
export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions = {},
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) return { remainingPids: [] };
// 快照优先级：调用方自带的 root 快照 > 已知进程组快照 > 现场采样的 exited-root 后代。
// 复用调用方快照是为了拿到 spawn 时刻的身份；现场采样只能看到“现在还在”的进程，
// 对已退出并可能被复用的 PID 无能为力。
  const cleanupSnapshot =
    options.snapshot?.rootPid === child.pid
      ? options.snapshot
      : options.ownedProcessGroupId === child.pid
        ? captureProcessGroupSnapshot(options.ownedProcessGroupId, options)
        : process.platform === "win32"
          ? await captureExitedRootDescendantsSnapshotAsync(child.pid, options)
          : captureExitedRootDescendantsSnapshot(child.pid, options);
  const snapshotIdentities = cleanupSnapshot?.identities ?? [];
  const identityVerificationUnavailable = cleanupSnapshot?.identityVerification === "unavailable";
  // 刚取得的异步快照已经固定了 Windows 创建标识，避免在 EOF 前立刻重复执行一次
  // 代价较高的 CIM 查询。force 阶段仍会异步复核身份，防止 PID 复用误杀。
// [权衡] 刚拿到的异步快照已固定 Windows 创建标识，这里直接合成 ownership，
// 避免 EOF 前重复一次昂贵的 CIM 查询；force 阶段仍会异步复核，安全性不降级。
  const initialOwnership =
    process.platform === "win32" &&
    cleanupSnapshot &&
    child.exitCode === null &&
    child.signalCode === null
      ? {
          // 查询失败不等于进程不存在。保留未验证 root 让 waiter 在整个
          // 有界预算内观察 ChildProcess，并在仍存活时通过 remainingPids 报告失败。
          childStillOwned:
            identityVerificationUnavailable ||
            snapshotIdentities.some((identity) => identity.pid === child.pid),
          currentIdentities: [...snapshotIdentities],
          knownIdentities: [...snapshotIdentities],
        }
      : await resolveCurrentOwnedIdentitiesAsync(child, snapshotIdentities, options);
// [失败路径] 身份查询不可用时传 unverifiedRootOnly：只观察 ChildProcess，禁止裸 PID taskkill，
// 宁可报残留也不冒误杀无关进程的风险。
// 第三个布尔量决定是否为 taskkill flight 预留命令超时；只有存在真实信号目标时才预留。
  return await waitForProcessTreeTermination(
    child,
    identityVerificationUnavailable
      ? ({ ...options, unverifiedRootOnly: true } as ProcessTreeTerminatorWaitOptions)
      : options,
    initialOwnership,
    // 身份查询失败且没有已验证 identity 时，terminator 的 graceful/force
    // targets 都为空。只有存在真实信号目标才为 taskkill flight 预留命令超时；其余
    // 情况保持完整预算，禁止按 Promise 的瞬时 settle 状态激进缩短边界。
    initialOwnership.currentIdentities.length > 0 ||
      (!identityVerificationUnavailable && initialOwnership.childStillOwned),
    terminateProcessTree,
  );
}
