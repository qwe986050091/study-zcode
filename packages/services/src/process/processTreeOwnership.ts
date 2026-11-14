// 进程树归属判定的核心闸门：决定「这个 child 现在还算不算我们能安全发信号的进程树」，
// 以及「哪些 PID 仍属于本轮受管进程」。所有终止/回收路径都先过这一层，判错会误杀无关进程。
// INV-01：发信号前必须用 (pid, startTime, 进程组) 复核身份，裸 PID 永不作为所有权依据
//         （守住位置：knownRootIdentity 复核分支与末尾 childStillOwned 推导）。
// INV-02：root 身份一旦无法确认（未固定且禁止 discovery），本轮必须永久 fail closed，返回空集合
//         （守住位置：!knownRootIdentity && !allowRootDiscovery 分支）；否则 PID 复用会被认领成 runtime。
// INV-03：knownIdentities 只允许因「明确未知」清空，不能在已知集合上退回 fresh 子集
//         （守住位置：mergeIdentities 调用与各 return 的 knownIdentities）；否则下轮丢掉尚未回收的后代。
import type { ChildProcess } from "node:child_process";
import {
  captureProcessTreeSnapshot,
  filterCurrentProcessIdentities,
} from "#src/process/processTreeSnapshot.js";
import {
  captureProcessTreeSnapshotAsync,
  filterCurrentProcessIdentitiesAsync,
} from "#src/process/processTreeSnapshotAsync.js";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminatorOptions,
} from "#src/process/processTreeTypes.js";

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

// [失败路径] kill(pid, 0) 只做存在性探测、不投递信号；EPERM 说明进程活着但无权探测，
// 因此不抛异常就算存活、任何抛出（ESRCH/EINVAL）都按已退出处理，宁可漏收也不误杀。
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 后写入的组覆盖先写入的同 PID 身份：fresh 快照放在后面，才能让 startTime 新值压过陈旧记录。
// [权衡] 按 PID 去重而不保留全部记录：同一 PID 的两个身份只有一个是当前进程，
// 保留两份会让按 PID 发信号出现歧义，也会让 currentIdentities 出现重复项。
function mergeIdentities(...groups: readonly (readonly ProcessIdentity[])[]): ProcessIdentity[] {
  const identitiesByPid = new Map<number, ProcessIdentity>();
  for (const identities of groups) {
    for (const identity of identities) {
      identitiesByPid.set(identity.pid, identity);
    }
  }
  return [...identitiesByPid.values()];
}

function captureLiveIdentities(
  child: ChildProcess,
  options: ProcessTreeTerminatorOptions,
): ProcessIdentity[] {
  if (hasChildExited(child)) {
    return [];
  }
  return [...(captureProcessTreeSnapshot(child, options)?.identities ?? [])];
}

// 身份 = pid + 启动时间 + 进程组；三者任一不同都说明「同号不同进程」或已换组。
// [权衡] 不比较可执行文件路径：路径会因升级/重命名变化，而 startTime 精度足以区分同 PID 复用；
// 反过来只看 pid 会把复用了 PID 的无关进程当成原 root，是本模块最严重的误杀来源。
function isSameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.processGroupId === right.processGroupId
  );
}

export function resolveCurrentOwnedIdentities(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  allowRootDiscovery = true,
): ProcessTreeOwnershipResolution {
  const rootPid = child.pid!;
  const knownRootIdentity = knownIdentities.find((identity) => identity.pid === rootPid);
// 先固定 root PID 与已知 root 身份，后面所有分支都以这份快照为基准，避免边判边取导致基准漂移。
// 没有 child.pid 说明 fork 未真正落地，此时 rootPid 无意义（非空断言仅表达类型收窄）。
  const childHasNotExited = !hasChildExited(child);
  // root PID 在 exit 回调落到 JS 前也可能进入延迟回收窗口。
  // 没有固定 root 身份或生前身份已不匹配时，都禁止沿裸 PID 抓 fresh tree。
// [失败路径] child 已退出仍可能留有未回收的后代，因此不能直接返回空集；
// 这里保留 known 集合上的存活过滤结果，只撤销 childStillOwned，回收流程可继续清理后代。
// 若直接返回 []，残留孙进程会失去归属而漏杀。
  if (!childHasNotExited) {
    return {
      childStillOwned: false,
      currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }

  if (knownRootIdentity) {
// 有固定 root 身份时先复核它是否仍是当前进程：startTime/PGID 任一变化即视为原 root 已死。
// [并发] 复核本身也是一次采样，通过不代表下一刻还在；它只用于快速否决，不能替代末尾 final 复核。
// 这里仍返回 known 的存活过滤结果而非空集，是为了让后续回收继续处理可能残留的后代。
    const rootIdentityStillCurrent =
      filterCurrentProcessIdentities([knownRootIdentity], options).length === 1;
    if (!rootIdentityStillCurrent) {
      return {
        childStillOwned: false,
        currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
        knownIdentities: [...knownIdentities],
      };
    }
  }

// [失败路径] 首轮查询没能固定 root 身份，说明我们从未确认过这棵树属于自己；
// force timer 里再沿 rootPid 抓树会把已复用的 PID 当成新 root，因此本轮永久 fail closed。
// 两个集合都返回空，是让调用方彻底放弃这次回收，而不是延后重试。
  if (!knownRootIdentity && !allowRootDiscovery) {
    // 首次查询失败后若在 force timer 中重新沿 rootPid 建立身份，
    // 原 PID 已复用时会把无关进程树认领成 runtime；本轮回收必须永久 fail closed。
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }

// 到这一步才允许抓 fresh 树：要么已知 root 身份仍有效，要么调用方明确允许用 rootPid 做首次发现。
// [并发] fresh 树不覆盖已知集合，而是与之合并；已知但暂时抓不到的后代必须保留，等待下一轮复核。
// 若改成用 fresh 覆盖 known，会在抓树瞬间丢掉正在退出的后代 PID，导致漏杀并遗留孤儿。
  const freshIdentities = captureLiveIdentities(child, options);
  const freshRootIdentity = freshIdentities.find((identity) => identity.pid === rootPid);
// 既没有历史 root 身份、fresh 里也没有同号进程：无法证明这棵树属于我们，两个集合都清空，
// 语义与 allowRootDiscovery 关闭时一致——不认领、不发信号。
  if (!knownRootIdentity && !freshRootIdentity) {
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }
  if (
    knownRootIdentity &&
    freshRootIdentity &&
    !isSameProcessIdentity(knownRootIdentity, freshRootIdentity)
  ) {
    return {
      childStillOwned: false,
      currentIdentities: filterCurrentProcessIdentities(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }
// [权衡] 只有 fresh 里仍存在 root 时才把 fresh 并进来；fresh 整个为空时保留 known，
// 是为了不因一次抓树失败就丢失已确认的后代；root 缺位由下面的 final 复核统一否决。
// 合并后不再做二次 PID 复用校验：freshRootIdentity 已在上面与 knownRootIdentity 逐字段比对过。
  const mergedIdentities = mergeIdentities(
    knownIdentities,
    freshRootIdentity ? freshIdentities : [],
  );
  const currentIdentities = filterCurrentProcessIdentities(mergedIdentities, options);
// [并发] 到这里仍可能错过 root 退出：filter 只是一次采样，结果只反映调用瞬间。
// 因此 childStillOwned 由「最终集合是否还含 root」推导，而不复用前面任何布尔标记，
// 否则会把刚退出、PID 即将被复用的 root 判成仍归我们所有，进而向别人的进程树发信号。
  return {
    // root 可能在前一次身份核对与 fresh capture 之间退出；只有最终
    // 复核集合仍包含 root，才能向 root PID/PGID 发信号，禁止信任过期布尔状态。
    childStillOwned: currentIdentities.some((identity) => identity.pid === rootPid),
    currentIdentities,
    knownIdentities: mergedIdentities,
  };
}

export async function resolveCurrentOwnedIdentitiesAsync(
  child: ChildProcess,
  knownIdentities: readonly ProcessIdentity[],
  options: ProcessTreeTerminatorOptions,
  allowRootDiscovery = true,
): Promise<ProcessTreeOwnershipResolution> {
// [权衡] 非 Windows 复用同步实现：POSIX 上 /proc 或 ps 的同步读取代价可接受，
// 只有 Windows 的 CIM 查询必须异步，避免阻塞事件循环拖慢整个 runtime 的回收时序。
  if (process.platform !== "win32") {
    return resolveCurrentOwnedIdentities(child, knownIdentities, options, allowRootDiscovery);
  }

  const rootPid = child.pid!;
  const knownRootIdentity = knownIdentities.find((identity) => identity.pid === rootPid);
  if (hasChildExited(child)) {
// Windows 上 child 已退出时不再抓树（CIM 查询慢，抓到的 root 可能是复用 PID），
// 但仍用 isPidAlive 快速排除全部已消失的 known 身份，避免为肯定不存在的进程付一次异步查询。
// [失败路径] 存活探测若有误（例如权限受限），宁可多查一次也不直接丢弃 known。
    if (!knownIdentities.some((identity) => isPidAlive(identity.pid))) {
      return {
        childStillOwned: false,
        currentIdentities: [],
        knownIdentities: [...knownIdentities],
      };
    }
    return {
      childStillOwned: false,
      currentIdentities: await filterCurrentProcessIdentitiesAsync(knownIdentities, options),
      knownIdentities: [...knownIdentities],
    };
  }
  if (knownRootIdentity) {
    const currentIdentities = await filterCurrentProcessIdentitiesAsync(knownIdentities, options);
    return {
      childStillOwned: currentIdentities.some((identity) => identity.pid === rootPid),
      currentIdentities,
      knownIdentities: [...knownIdentities],
    };
  }
// 与同步版本同一语义：没有固定 root 身份又禁止 discovery 时，不能沿裸 PID 重建所有权。
// 返回的空集合表示「本轮没有任何可信受管进程」，调用方据此放弃回收而不是继续等待。
  if (!allowRootDiscovery) {
    return {
      childStillOwned: false,
      currentIdentities: [],
      knownIdentities: [],
    };
  }

// 只有走到这里才允许首次发现：抓取期间 root 可能退出并被复用，故不合并任何历史身份，
// 以抓到的 root 身份作为唯一依据；抓不到就整体放弃，不做部分认领。
  const freshIdentities = [
    ...((await captureProcessTreeSnapshotAsync(child, options))?.identities ?? []),
  ];
  const freshRootIdentity = freshIdentities.find((identity) => identity.pid === rootPid);
  return {
    childStillOwned: Boolean(freshRootIdentity),
    currentIdentities: freshRootIdentity ? freshIdentities : [],
    knownIdentities: freshRootIdentity ? freshIdentities : [],
  };
}
