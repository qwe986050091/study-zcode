// 项目目录聚合入口：把本地项目与远程 Host 上的项目合并成一份可展示快照。
// 核心约束是「目录只用于过滤与补全，不用于新增或更新入口」，避免远端抖动导致入口漂移。
// 合并以目录条目为准，项目数据只是该条目的补充信息。
import type { ProjectCatalogPort, ProjectCatalogSnapshot } from "#src/project-catalog/contract.js";
export type { ProjectCatalogPort, ProjectCatalogSnapshot } from "#src/project-catalog/contract.js";
export { projectSelectionId } from "#src/project-catalog/selection-id.js";

// 读取流程分三段：先取一次目录作为基线，再并行读取本地与各在线 Host 的项目，
// 最后再取一次目录，用第二次结果确认 Host 在读取期间仍在线且身份未变。
// 两次读取之间的目录变动被刻意忽略，以换取本次快照内部的一致性。
export async function readProjectCatalog(
  port: ProjectCatalogPort,
): Promise<ProjectCatalogSnapshot> {
  const before = (await port.remoteProjectService?.readDirectory()) ?? { hosts: [], entries: [] };
// 只向基线中标记为 online 的 Host 发起拉取；
// 离线 Host 的项目在结果中不主动排除，因为其本地记录可能仍然可见。
  const hosts = before.hosts.filter((host) => host.connectionStatus === "online");
  const [owned, results] = await Promise.all([
    port.projectService.readProjects(),
    Promise.allSettled(hosts.map((host) => port.projectService.readProjects({ hostId: host.id }))),
  ]);
  const directory = (await port.remoteProjectService?.readDirectory()) ?? before;
// 本地读取结果可能混入属于远程 Host 的项目（同一存储被两端读取），
// 这里用基线 Host 集合把它们从 owned 中剔除，再由远程分支按目录条目补回。
  const foreign = new Set(before.hosts.map((host) => host.id));
  const projects = owned.filter((project) => !project.deleted && !foreign.has(project.hostId));
// 用下标与 results 对齐：allSettled 保持输入顺序，因此失败项可原位跳过而不影响其它 Host；
// 同时校验 membershipId，防止同一 Host id 在两次读取之间被重新配对成另一台机器。
// 目录条目限定为基线中已存在且属于该 Host 的项，避免用读取结果凭空新增入口。
  for (let index = 0; index < hosts.length; index++) {
    const host = hosts[index]!;
    const result = results[index]!;
    if (
      result.status !== "fulfilled" ||
      !directory.hosts.some(
        (current) =>
          current.id === host.id &&
          current.membershipId === host.membershipId &&
          current.connectionStatus === "online",
      )
    )
      continue;
    for (const entry of directory.entries.filter(
      (entry) => entry.hostId === host.id && before.entries.some((old) => old.id === entry.id),
    )) {
      const candidates = result.value.filter(
        (project) => !project.deleted && project.hostId === host.id,
      );
      const exact = candidates.find((project) => project.id === entry.projectId);
      // 尚未转换的旧入口只在目录唯一匹配时展示；不据读取结果新增/更新入口。
      const legacy =
        entry.projectId === null && entry.legacyWorkspace
          ? candidates.filter((project) =>
              project.roots.some((root) => root.rootPath === entry.legacyWorkspace?.workspacePath),
            )
          : [];
      const selected = exact ?? (legacy.length === 1 ? legacy[0] : undefined);
      if (
        selected &&
        !projects.some(
          (project) => project.hostId === selected.hostId && project.id === selected.id,
        )
      )
        projects.push(selected);
    }
  }
// directory 返回第二次读取的完整目录（含离线 Host），基线只作为本次合并的判据；
// 返回值为纯数据快照、不持有 port 引用，调用方可安全缓存或跨线程传递。
// 不在此处对 projects 排序或去重，顺序由调用方按展示需要决定。
  return { projects, directory };
}
