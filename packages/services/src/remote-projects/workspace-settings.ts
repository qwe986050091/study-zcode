// 远端工作区设置投影层：把「项目目录 + host 表 + 已存设置」折叠成 UI 直接消费的四个字段。
// INV-01：输出只由一个 SQLite 快照派生，不读旧集合重建成员（守住：入参与 localPaths）；
//          混读两套来源会在同一帧给出互斥成员集合，使活跃工作区指向已删除项。
// INV-02：远端身份一律用 buildRemoteHostWorkspaceIdentity 生成，禁止手写字符串拼接。
import {
  buildRemoteHostWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type AppSettings,
  type PersistedWorkspaceSessionEntry,
} from "@zcode/shared";
import type { VirtualProject } from "#src/project-storage/contract.js";
import type { RemoteProjectDirectory, RemoteProjectHost } from "#src/remote-projects/contract.js";

// 去重与比较统一用这个身份 key：本地取路径，远端优先用已存 identity，缺失才按 path+target 推导。
// 与全局 workspaceIdentity 口径一致，否则同一远端工作区会因两种写法被当成两项。
const key = (entry: PersistedWorkspaceSessionEntry) =>
  entry.kind === "local"
    ? entry.workspacePath
    : entry.workspaceIdentity?.trim() ||
      buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target);

/** 单向兼容投影。输入必须是同一 SQLite 快照，不读取旧集合重建成员。 */
// 纯函数、无 IO：入参必须来自同一时刻的 SQLite 快照，本函数不缓存也不回写设置，
// 保证「读取设置」没有副作用、也不会与写入方争同一条记录。
export function projectWorkspaceSettings(
  projects: readonly VirtualProject[],
  directory: RemoteProjectDirectory,
  settings: AppSettings,
): Pick<
  AppSettings,
  "lastActiveWorkspace" | "lastWorkspaceSession" | "recentProjects" | "lastActiveTabIndex"
> {
// 本地成员取未删除项目的 roots 并去重：同一 root 被多个项目引用时只出现一次，
// 否则最近项目列表重复，lastActiveTabIndex 的序号也会整体偏移。
  const localPaths = [
    ...new Set(
      projects
        .filter((project) => !project.deleted)
        .flatMap((project) => project.roots.map((root) => root.rootPath)),
    ),
  ];
// 本地项固定 workspacePurpose=project，远端项才需要按 legacy 数据决定用途。
  const lastWorkspaceSession: PersistedWorkspaceSessionEntry[] = localPaths.map(
    (workspacePath) => ({ kind: "local", workspacePath, workspacePurpose: "project" }),
  );
  const hosts = new Map(directory.hosts.map((host) => [host.id, host]));
// identityOrder 维护「本地在前、远端在后」的稳定次序，仅用于推导 lastActiveTabIndex，改动会改变切回窗口时落到的标签页。
  const identityOrder = [...localPaths];
  const seen = new Set<string>();
// 逐 entry 展开 roots：一个远端 host 可有多个工作区目录，每个目录都是独立成员，
// 因此去重键必须是 hostId+path，只按 hostId 会吞掉同机其它目录。
  for (const entry of directory.entries) {
    const host = hosts.get(entry.hostId);
    if (!host?.target) continue;
// 新版 entry 用 roots 数组，只有旧数据才回退到单值 legacyWorkspace；
// 两者都为空说明该 entry 已无有效目录，跳过而不生成空路径成员。
    const paths = entry.roots.length
      ? entry.roots.map((root) => root.rootPath)
      : entry.legacyWorkspace
        ? [entry.legacyWorkspace.workspacePath]
        : [];
    for (const workspacePath of paths) {
// [并发] 去重只基于这一份快照的 seen 集合，且键含 hostId：两台远端机器上的同名目录
// 必须算两项，只按路径去重会让它们互相覆盖。
      const stableKey = buildRemoteHostWorkspaceIdentity(host.id, workspacePath);
      if (seen.has(stableKey)) continue;
      seen.add(stableKey);
      identityOrder.push(stableKey);
      const legacy =
        entry.legacyWorkspace?.workspacePath === workspacePath ? entry.legacyWorkspace : null;
      const target = legacy?.target ?? host.target;
      // 旧版通过 snapshot 中的实际 credential key 取凭据；不制造无值的镜像 key。
// 以 legacy 展开为底：credential key、最后打开时间等旧字段需要原样透传，
// 否则升级后首次连接会因缺少 credential key 被要求重新登录。
      lastWorkspaceSession.push({
        ...legacy,
        kind: "remote",
        workspacePath,
        workspaceIdentity:
          legacy?.workspaceIdentity &&
// 只有旧 identity 可解析且不是 server 形态时才复用：server 形态缺 host 段，
// 沿用后按 hostId 反查会失败，此时一律按 path+target 重建。
// 不制造无值镜像 key 是硬约束——写入 undefined 会覆盖仍然有效的新字段。
          parseRemoteWorkspaceIdentity(legacy.workspaceIdentity)?.kind !== "server"
            ? legacy.workspaceIdentity
            : buildRemoteWorkspaceIdentity(workspacePath, target),
        workspacePurpose: "project",
        target,
        lastOpenedAt: legacy?.lastOpenedAt ?? host.lastOpenedAt ?? 0,
        lastConnectionStatus: legacy?.lastConnectionStatus ?? "connected",
      });
    }
  }

  // 只在新字段缺席的首次升级取旧选择；null 是已经清空，不再被旧 index 填回。
// 只在新字段缺席时按旧 index 推断一次；null 表示用户已主动清空，必须保留，
// 否则被清空的选择会被旧数组反复填回。
  let active =
    settings.lastActiveWorkspace === undefined
      ? (settings.lastWorkspaceSession?.[settings.lastActiveTabIndex ?? 0] ?? null)
      : settings.lastActiveWorkspace;
  if (active?.kind === "remote") {
    const identity = key(active);
// 先按 identity 中的 hostId 精确反查；identity 无法解析时得到空串，
// 落到下面的路由匹配分支，而不是在此抛错中断整个投影。
    let host: RemoteProjectHost | undefined = hosts.get(
      remoteHostIdFromWorkspaceIdentity(identity) ?? "",
    );
// 回退：按 path+target 重算 host 路由，再在现存 host 里找唯一匹配。
// [权衡] 仅当匹配数恰好为 1 才采纳：多台 host 路由相同时无法判定归属，
// 猜一个会把工作区绑到错误机器，宁可判为失活。
    if (!host && parseRemoteWorkspaceIdentity(identity)?.kind !== "server") {
      const route = remoteHostIdFromWorkspaceIdentity(
        buildRemoteWorkspaceIdentity(active.workspacePath, active.target),
      );
      const matches = directory.hosts.filter(
        (candidate) =>
          candidate.target &&
          remoteHostIdFromWorkspaceIdentity(
            buildRemoteWorkspaceIdentity(active!.workspacePath, candidate.target),
          ) === route,
      );
      if (matches.length === 1) host = matches[0];
    }
// 存活判据要求 host 仍在，且该路径仍出现在 entry.roots 或 legacyWorkspace 中；
// 只校验 host 不校验路径，会让已删除目录继续被激活。
    const retained =
      host &&
      directory.entries.some(
        (entry) =>
          entry.hostId === host.id &&
          (entry.roots.some((root) => root.rootPath === active!.workspacePath) ||
            entry.legacyWorkspace?.workspacePath === active!.workspacePath),
      );
// 通过校验才回填 target 与规范化 identity；conversation 用途允许无目录时保留，它代表进行中的对话。
    active =
      host?.target && (retained || active.workspacePurpose === "conversation")
        ? {
            ...active,
            target: host.target,
            workspaceIdentity: buildRemoteHostWorkspaceIdentity(host.id, active.workspacePath),
          }
        : null;
  }
// 不在 identityOrder 中时得到 -1，下面用 max(0, …) 收敛到首个标签，避免把 -1 传给渲染层。
  const activeIndex = active ? identityOrder.indexOf(key(active)) : -1;
  return {
    lastActiveWorkspace: active,
    lastWorkspaceSession,
    recentProjects: localPaths.slice(0, 10),
    lastActiveTabIndex: Math.max(0, activeIndex),
  };
}
