// Windows 异步版进程树快照与身份过滤：同步版只适合 POSIX，Windows 必须走 CIM 异步查询，
// 否则每次回收前的进程枚举都可能阻塞事件循环数百毫秒，拖慢整个 runtime 的终止时序。
// INV-01：root 身份只能建立在「查询发起时 child 尚未退出」这一前提上；一旦期间观测到退出，
//         必须用调用方记录的 (startedAt, exitedAt) 时间窗恢复后代，绝不能采信同 PID 的当前进程
//         （守住位置：captureProcessTreeSnapshotAsync 的 rootIdentity && !childExitedDuringQuery）。
// INV-02：身份等价 = pid 相同且 startTime 完全相等；只看 pid 会把复用进程当原进程。
// INV-03：缺 startedAt/exitedAt 任一时间上界时，宁可不恢复任何后代，也不放宽时间窗（fail closed）。
import type { ChildProcess } from "node:child_process";
import {
  captureExitedRootDescendantsSnapshot,
  captureProcessTreeSnapshot,
  filterCurrentProcessIdentities,
} from "#src/process/processTreeSnapshot.js";
import type {
  ProcessIdentity,
  ProcessTreeSnapshot,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";
import { readWindowsProcessListAsync } from "#src/process/windowsProcessListAsync.js";

export { verifyWindowsProcessIdentityAsync } from "#src/process/windowsProcessListAsync.js";

// startTime 形如 windows-utc-us:<微秒>；前缀缺失说明该身份不是本模块产出的，直接放弃解析。
// 返回 undefined 而不抛错：时间不可解析只意味着无法参与生命周期筛选，不影响其余判定。
const WINDOWS_START_TIME_PREFIX = "windows-utc-us:";

function parseWindowsCreationTimeMs(startTime: string): number | undefined {
  if (!startTime.startsWith(WINDOWS_START_TIME_PREFIX)) return undefined;
  try {
// 微秒转毫秒。用 BigInt 是因为 FILETIME 量级的微秒数已超出 Number 安全整数范围；
// 除以 1000 后再转 Number 并复查安全整数，避免精度丢失后被当成合法时间参与比较。
    const microseconds = BigInt(startTime.slice(WINDOWS_START_TIME_PREFIX.length));
    const timestamp = Number(microseconds / 1_000n);
    return Number.isSafeInteger(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function collectDescendants(
  rootPid: number,
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const childrenByParentPid = new Map<number, ProcessIdentity[]>();
  for (const identity of identities) {
// 先建 parentPid 索引再做 DFS：一次遍历建表，避免对每个节点重复扫描整张进程表（O(n^2)）。
// 同一父进程的多个子进程按进程表返回顺序排列，只影响 descendantPids 顺序，不影响结果集合。
    const children = childrenByParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParentPid.set(identity.parentPid, children);
  }
  const descendants: ProcessIdentity[] = [];
// seen 预置 rootPid：Windows 上进程可能在极短窗口里成为自己的祖先（父 PID 复用），
// 不预置会让 DFS 立刻回到 root 并无限递归。
// [失败路径] 命中 seen 直接跳过：既防环，也防同一 PID 因进程表重复项被收集两次。
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number) => {
    for (const child of childrenByParentPid.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      visit(child.pid);
    }
  };
// 递归深度等于进程树高度，正常场景远小于调用栈上限；这里不做显式栈，因为树深由 OS 进程模型约束。
// 若未来出现病态深链，风险是栈溢出而非错误结果；保持简单实现是权衡后接受该风险。
  visit(rootPid);
  return descendants;
}

export async function filterCurrentProcessIdentitiesAsync(
  identities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
): Promise<ProcessIdentity[]> {
  if (process.platform !== "win32") {
    return filterCurrentProcessIdentities(identities, options);
  }
  if (identities.length === 0) return [];
  const trackedPids = new Set(identities.map((identity) => identity.pid));
  const currentByPid = new Map(
    (await readWindowsProcessListAsync(options))
// 只保留被追踪 PID 的当前记录：CIM 返回的是整机进程表，先裁剪再建 Map，
// 避免后续比较的内存与耗时会随机器进程总数放大。
      .filter((identity) => trackedPids.has(identity.pid))
      .map((identity) => [identity.pid, identity]),
  );
  return identities.filter((identity) => {
    const current = currentByPid.get(identity.pid);
// startTime 必须完全相等才认定为同一进程：仅比 pid 会把「已退出并被复用的 PID」判成存活，
// 从而把信号发给无关进程，这是本模块最需要避免的误杀。
// current 缺失（进程已消失或未被 CIM 返回）同样视为不匹配。
    return current?.startTime === identity.startTime;
  });
}

export async function captureProcessTreeSnapshotAsync(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  if (process.platform !== "win32") return captureProcessTreeSnapshot(child, options);
// 没有 pid 说明 fork 尚未完成，此时无法建立 root 身份，也不能凭空枚举整机进程。
// 返回 undefined 而非空快照：调用方据 undefined 判定「无法判定」，空快照会被当成「确认为空」。
  if (child.pid == null) return undefined;
  const processList = await readWindowsProcessListAsync(options);
// [并发] 查询前记下退出状态，查询后再读一次；两次读之间 child 可能退出——
// 本次结果只代表「查询发起时」的进程表，不能证明查询结束时 root 仍存活。
// 因此该标记只用于决定「能否采信 rootIdentity」，最终所有权仍由上层再做一次复核。
  const childExitedDuringQuery = child.exitCode !== null || child.signalCode !== null;
  const ownedProcessExitedAtMs =
    options.ownedProcessExitedAtMs ?? options.resolveOwnedProcessExitedAtMs?.();
// root 仍存活时才按 PID 认领 root；childExitedDuringQuery 为真时即使查到同号进程也不采信，
// 因为那可能是退出后被复用的无关进程。
  const rootIdentity = processList.find((identity) => identity.pid === child.pid);
  // 查询期间原 root 退出后，PID 可能在 Node exit 回调与 CIM 返回之间
  // 被复用。查询完成时间不是受管进程的退出时间；一旦已观察到 child 退出，只能使用
  // 调用方记录的可信退出上界恢复旧后代，绝不能把同 PID 的当前进程认作原 root。
  const identities =
    rootIdentity && !childExitedDuringQuery
      ? [rootIdentity, ...collectDescendants(child.pid, processList)]
      : collectExitedRootDescendants(
          child.pid,
          processList,
          options.ownedProcessStartedAtMs,
          ownedProcessExitedAtMs,
        );
// 空结果返回 undefined 而不是空快照：上层据此区分「无法判定」与「确认没有后代」。
// [失败路径] 这个区分会影响回收决策，混用会让一次查询失败演变成「确认无需清理」。
  if (identities.length === 0) return undefined;
  return {
    rootPid: child.pid,
// descendantPids 排除 root 自身：该字段供 kill 循环使用，含 root 会与 root 单独处理的路径重复发信号。
// 该字段只做投影，真正的身份仍以 identities 为准，故不需要再做一次 PID 去重。
    descendantPids: identities
      .filter((identity) => identity.pid !== child.pid)
      .map((identity) => identity.pid),
    identities,
  };
}

// root 已退出时的后代恢复：只能靠创建时间落在 (startedAt, exitedAt) 窗口内近似判断归属，
// 因为此时无法再从 root 沿父链下钻（root 已不在进程表，父链断裂）。
// [权衡] 该窗口是上界近似：窗口内启动的无关进程可能被误收，但漏杀残留进程的代价更高。
function collectExitedRootDescendants(
  rootPid: number,
  processList: readonly ProcessIdentity[],
  startedAtMs: number | undefined,
  exitedAtMs: number | undefined,
): ProcessIdentity[] {
  if (
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return [];
  }
// 左闭右开：创建时间等于 exitedAt 的进程视为「退出之后才出现」，不属于本轮；
// 相等即纳入会把复用同一毫秒的无关进程认领进来。
// 无法解析创建时间的记录直接排除，不参与猜测。
  const lifecycleCandidates = processList.filter((identity) => {
    const createdAtMs = parseWindowsCreationTimeMs(identity.startTime);
    return createdAtMs !== undefined && createdAtMs >= startedAtMs && createdAtMs < exitedAtMs;
  });
  return collectDescendants(rootPid, lifecycleCandidates);
}

export async function captureExitedRootDescendantsSnapshotAsync(
  rootPid: number,
  options: ProcessTreeTerminatorOptions = {},
): Promise<ProcessTreeSnapshot | undefined> {
  if (process.platform !== "win32") {
    return captureExitedRootDescendantsSnapshot(rootPid, options);
  }
  const startedAtMs = options.ownedProcessStartedAtMs;
  const exitedAtMs = options.ownedProcessExitedAtMs;
  if (
// 入参校验与 collectExitedRootDescendants 内部重复，但这里必须先拦住非法 rootPid，
// 否则会拿 0/负数去建 DFS 集合，产生无意义的整表遍历。
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    typeof startedAtMs !== "number" ||
    !Number.isFinite(startedAtMs) ||
    typeof exitedAtMs !== "number" ||
    !Number.isFinite(exitedAtMs)
  ) {
    return undefined;
  }
  const identities = collectExitedRootDescendants(
    rootPid,
    await readWindowsProcessListAsync(options),
    startedAtMs,
    exitedAtMs,
  );
  return identities.length === 0
// 三目而非 if：保持单一 return 表达式，避免在快照构造前出现两条返回路径导致字段不一致。
// 空集合已在上面转成 undefined，所以这里 identity 列表必然非空，无需再判空。
    ? undefined
    : {
        rootPid,
        descendantPids: identities.map((identity) => identity.pid),
        identities,
      };
}
