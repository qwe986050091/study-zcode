// 进程树等待器：终止动作下发后判定进程树是否真的消失，并把仍存活的 PID 交回调用方。
// 本文件只观察、不终止；强杀由注入的 terminateProcessTree 回调控件。
// INV-01：等待边界必须早于 Host 的强杀点（3.5s phase / 4s 强杀），否则 waiter 返回时调用方
// 拿到的 remainingPids 已无人消费。（守住位置：windowsCleanupDeadlineMs 的三段 min）
// INV-02：进入等待后不再认领裸 PID，只观察 initialOwnership 快照中的已验证身份与一个明确的
// unverifiedRootPid；否则 PID 复用会把无关进程当成残留。（守：trackedIdentities/unverifiedRootPid）
// INV-03：settle 只允许发生一次，且必须先清 timer 再 resolve；重复 settle 会让已清除的 timer
// 重新挂回事件循环，Host 退出被拖住。（守住位置：settled / cleanup / settle）
// INV-04：Windows 上 taskkill 回调可能早于 Node 的 exit 投递；两者不一致时以 OS 判活为准，
// 否则「已死但 exit 未到」会被报成残留。（守住位置：settleIfTreeExited）
// INV-05：跟踪集只能整体替换、不能与旧快照合并，旧身份可能已被 PID 复用。（守：onForceCleanup）
// 破坏后果：漏报残留让 runtime 进程账本永久挂住；误报让调用方对已退出进程白等整个 deadline。
import type { ChildProcess } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "#src/process/processTreeTypes.js";

// [权衡] 默认值构成一次 Windows cleanup 的三段预算：graceful taskkill、到点强杀、强杀后观察。
// 数值不可随意放大：Host 侧另有独立的 3.5s phase 与 4s 强杀，这里超预算等于让 Host 先收口。
// WINDOWS_LATE_EXIT_OBSERVATION_MS 是纯观察下限：最后重试拿不到可验证身份时没有 taskkill
// 目标，不能把剩余 transport 预算压成 250ms，否则 code=0 的延迟 exit 会被误报成残留。
const DEFAULT_FORCE_AFTER_MS = 2_000;
const DEFAULT_WAIT_AFTER_FORCE_MS = 250;
const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_LATE_EXIT_OBSERVATION_MS = 750;

interface WaitInternalOptions extends ProcessTreeTerminatorWaitOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

type TerminateProcessTree = (child: ChildProcess, options: ProcessTreeTerminatorOptions) => void;

function warn(options: ProcessTreeTerminatorWaitOptions, message: string): void {
  options.log?.warn(options.traceId, message);
}

function debug(
  options: ProcessTreeTerminatorWaitOptions,
  message: string,
  context?: Record<string, unknown>,
): void {
  options.log?.debug?.(options.traceId, message, context);
}

// 以 Node 的退出标记判终态，而非 PID 判活：exitCode/signalCode 写入即代表 ChildProcess 已收口，
// 而 PID 判活还会看到尚未回收的僵尸，也无法区分「本进程的子进程」与「复用同号的其他进程」。
function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

// [失败路径] 用 signal 0 探测存在性：kill 抛错等价于「不存在或无权限」，两者都必须当已消失，
// 因为等待器在无权限时做不了任何补救，继续算残留只会让 Host 无止境等待。
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 前置契约：terminateProcessTree 必须同步返回，并在内部把强杀结果经 onForceCleanup 回灌；
// 等待器不 await 它，因为 Windows 的 graceful taskkill 与 force timer 是并发的两条 flight。
// [并发] 返回的 Promise 只在 settle 后 resolve，此时所有 timer 与 exit 监听都已解绑，
// 调用方可以安全地在 await 之后释放 child，不会再有回调触碰它。
export async function waitForProcessTreeTermination(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions,
  initialOwnership: ProcessTreeOwnershipResolution,
  hasWindowsTaskkillTargets: boolean,
  terminateProcessTree: TerminateProcessTree,
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) {
    return { remainingPids: [] };
  }

  const waiterStartedAtMs = Date.now();
  const forceAfterMs = Math.max(options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS, 0);
  const waitAfterForceMs = Math.max(options.waitAfterForceMs ?? DEFAULT_WAIT_AFTER_FORCE_MS, 0);
  const isWindows = process.platform === "win32";
  const windowsTaskkillBudgetMs = hasWindowsTaskkillTargets
    ? Math.max(options.windowsTaskkillTimeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS, 1)
    : 0;
  // Windows 的 graceful taskkill 与 force timer 并发；只要存在已验证信号目标，就保守地
  // 保留一份终态 taskkill 上限。身份不可用且目标集为空时，两条 taskkill flight 都必然
  // 为空，继续预留命令超时只会让 Host 在无法执行任何动作的状态下白等。
  // [权衡] 把 force、taskkill 命令、强杀后宽限三段相加作为相对预算，而不是只扣 force：慢 CIM
  // 会吃满整个 force 窗口，若只扣这段，waiter 会重新追加完整 taskkill + 宽限，总耗时突破 Host
  // 的 3.5s phase。扣减只来自确定的 wall-clock 消耗，不依赖 Promise 的瞬时 settle 状态。
  const windowsRelativeDeadlineMs = forceAfterMs + windowsTaskkillBudgetMs + waitAfterForceMs;
  const windowsTransportDeadlineRemainingMs =
    options.windowsCleanupDeadlineAtMs === undefined
      ? windowsRelativeDeadlineMs
      : Math.max(options.windowsCleanupDeadlineAtMs - waiterStartedAtMs, 0);
  // transport 只扣减 forceAfterMs 时，慢 CIM 一旦耗尽 2s force 窗口，waiter
  // 会重新追加完整 taskkill + exit 宽限，导致总 cleanup 突破 Host 3.5s phase。这里把
  // waiter 相对边界夹在 transport 从 cleanup 起点固定的绝对边界内；扣减只来自确定的
  // wall-clock 消耗，不依赖 Promise 的瞬时 settle 状态。
  // 最终重试无法取得可验证身份时没有 taskkill 目标，不能把 transport
  // 尚余的观察预算压缩成 waitAfterForceMs（生产为 250ms），把随后 code=0 的 exit
  // 误报成持久残留。此路径不发送裸 PID 信号，只在既有绝对 deadline 内继续观察；
  // 750ms 上限同时保证新增的纯观察路径与首次 3.25s cleanup 组合不突破 4s 强杀点。
  // [失败路径] 观测下限只作用于「没有 taskkill 目标」的纯观察路径：此时不能发裸 PID 信号，
  // 也不该把 transport 尚余预算压成 waitAfterForceMs（生产 250ms），否则随后才到的 code=0
  // exit 会被误报成持久残留。750ms 上限保证新增观察与首次 3.25s cleanup 相加仍不越过 4s。
  const windowsObservationDeadlineMs = Math.max(
    windowsRelativeDeadlineMs,
    WINDOWS_LATE_EXIT_OBSERVATION_MS,
  );
  // 两条分支都取 min：相对预算防止单次 cleanup 被拖长，transport 剩余预算防止 Host 的绝对
  // deadline 已被上游消耗后仍重新起算；两者都保证 timer 在 Host 收口之前触发。
  const windowsCleanupDeadlineMs =
    !hasWindowsTaskkillTargets && options.windowsCleanupDeadlineAtMs !== undefined
      ? Math.min(windowsObservationDeadlineMs, windowsTransportDeadlineRemainingMs)
      : Math.min(windowsRelativeDeadlineMs, windowsTransportDeadlineRemainingMs);
  // 生前快照是唯一身份来源：根 child 退出不代表 detached 后代已退出，且此后枚举进程树会被 PID 复用污染。
  const knownIdentities = initialOwnership.knownIdentities;

  // 根 child 退出不代表 detached MCP 已退出；等待边界只使用生前快照。
  // 强杀回调会用已复核身份替换跟踪集，禁止等待或重新认领裸 PID。
  // 整个等待收敛在单个 Promise 作用域内：timer、exit 监听、轮询都是局部变量，settle 时统一注销。
  // 这也是不能用多段 await 串行改写的原因——串行会让每段重新起算超时，总预算不可控。
  return await new Promise<ProcessTreeTerminationResult>((resolve) => {
    let settled = false;
    let trackedIdentities = initialOwnership.currentIdentities;
    let unverifiedRootPid =
      initialOwnership.childStillOwned &&
      !trackedIdentities.some((identity) => identity.pid === child.pid)
        ? child.pid
        : undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let treePollTimer: ReturnType<typeof setInterval> | undefined;

    // [资源] 先解绑 exit 监听再清四类 timer；任一遗漏都会让已 resolve 的 Promise 继续持有事件循环
    // 引用，Node 进程在会话关闭后无法自然退出。
    const cleanup = () => {
      child.off?.("exit", onExit);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceWaitTimer) clearTimeout(forceWaitTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      if (treePollTimer) clearInterval(treePollTimer);
      forceTimer = undefined;
      forceWaitTimer = undefined;
      cleanupDeadlineTimer = undefined;
      treePollTimer = undefined;
    };
    // [并发] 幂等收口点：exit、轮询、force 完成、两种 deadline 都汇到这里；先置 settled 再 cleanup，
    // 保证只有第一个到达者 resolve，后到者不会改写已确定的残留集合。
    const settle = (remainingPids: number[] = []) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ remainingPids });
    };
    // 判活只覆盖已验证身份与一个未验证根 PID，不重新枚举进程树：枚举结果无法与生前快照建立所有权
    // 关系，正是 PID 复用的入口。两类都消失才 settle，否则交回轮询继续观察。
    const settleIfTreeExited = () => {
      const hasRunningVerifiedProcess = trackedIdentities.some((identity) =>
        isPidAlive(identity.pid),
      );
      const hasRunningUnverifiedRoot =
        unverifiedRootPid !== undefined && !hasChildExited(child) && isPidAlive(unverifiedRootPid);
      if (!hasRunningVerifiedProcess && !hasRunningUnverifiedRoot) {
        // Windows 的 taskkill callback 可能先于 Node ChildProcess exit 事件。
        // OS 已无 PID 时继续等一轮 exit 投递，避免 transport/lifecycle 在清理 Promise
        // 返回后仍看见旧状态；若 exit 丢失，绝对 deadline 仍会按 OS 事实成功收口。
        if (isWindows && !hasChildExited(child)) return;
        settle();
      }
    };
    // [权衡] 用 25ms 轮询而不是监听 exit：detached 后代不会向本进程投递 exit，只能靠轮询兜住；
    // 周期是延迟与 CPU 的折中，settle 后必须 clearInterval，否则定时器会一直空转。
    const startTreePolling = () => {
      if (!treePollTimer && !settled) {
        treePollTimer = setInterval(settleIfTreeExited, 25);
      }
    };
    // 残留口径必须与 settleIfTreeExited 判活口径完全一致：多算一类永不收口，少算一类则调用方拿到空数组但进程仍活。
    const collectRemainingPids = (): number[] => {
      const remainingPids = trackedIdentities
        .filter((identity) => isPidAlive(identity.pid))
        .map((identity) => identity.pid);
      if (
        unverifiedRootPid !== undefined &&
        !hasChildExited(child) &&
        isPidAlive(unverifiedRootPid)
      ) {
        remainingPids.push(unverifiedRootPid);
      }
      return remainingPids;
    };
    const onExit = () => {
      unverifiedRootPid = undefined;
      // Windows exit 回调中同步刷新 CIM 进程表会再次阻塞 Host deadline。
      // 此处只观察已固定身份 PID 是否仍存活；真正发送 force 前仍会复核创建标识。
      settleIfTreeExited();
      if (!settled) startTreePolling();
    };
    const scheduleForceWait = () => {
      if (forceWaitTimer || settled) return;
      if (waitAfterForceMs === 0) {
        settle(collectRemainingPids());
        return;
      }
      forceWaitTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime 进程树强制回收后仍有残留 pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, waitAfterForceMs);
    };
    const scheduleWindowsCleanupDeadline = () => {
      if (!isWindows || cleanupDeadlineTimer || settled) return;
      debug(options, "Windows runtime 进程树 cleanup deadline scheduled", {
        forceAfterMs,
        hasWindowsTaskkillTargets,
        waitAfterForceMs,
        windowsRelativeDeadlineMs,
        windowsTaskkillBudgetMs,
        windowsCleanupDeadlineMs,
        windowsCleanupDeadlineAtMs: options.windowsCleanupDeadlineAtMs,
      });
      cleanupDeadlineTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime 进程树绝对 deadline 后仍有残留 pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, windowsCleanupDeadlineMs);
    };
    // 强杀完成是唯一允许改写跟踪集的时机，因为它持有复核后的新身份；旧快照可能已被新进程复用。
    // [并发] 替换后要重新判活并恢复轮询：force 与轮询可能同时到达 settle，幂等由 settle 保证。
    const onForceCleanup = (result: ForceCleanupResult) => {
      debug(options, "Windows runtime 进程树 force cleanup completed", {
        trackedPids: result.identities.map((identity) => identity.pid),
        unverifiedRootPid: result.unverifiedRootPid,
      });
      // 这里必须替换而不是合并：旧快照身份可能已经失效，继续保留会把新进程
      // 错当成残留，并让后续等待/日志失去进程所有权语义。
      trackedIdentities = result.identities;
      unverifiedRootPid = result.unverifiedRootPid;
      settleIfTreeExited();
      if (!settled) {
        startTreePolling();
        if (!isWindows) scheduleForceWait();
      }
    };

    child.once("exit", onExit);
    const waitOptions: WaitInternalOptions = {
      ...options,
      forceAfterMs,
      keepForceTimerRef: true,
      knownIdentities,
      resolvedOwnership: initialOwnership,
      onForceCleanup,
      onForceTimerScheduled: (timer) => {
        forceTimer = timer;
      },
      onGracefulCleanupScheduled: (flight) => {
        // runner 自身有 timeout 且 runWindowsTaskkill 会把 rejection 归一化；无论命令结果，
        // flight settle 后都重新观察 OS/ChildProcess 事实，最终失败仍由绝对 deadline 决定。
        void flight.then(() => {
          debug(options, "Windows runtime 进程树 graceful cleanup flight settled");
          settleIfTreeExited();
          if (!settled) startTreePolling();
        });
      },
    };
    scheduleWindowsCleanupDeadline();
    terminateProcessTree(child, waitOptions);

    settleIfTreeExited();
    if (!settled && hasChildExited(child)) {
      startTreePolling();
    }
  });
}
