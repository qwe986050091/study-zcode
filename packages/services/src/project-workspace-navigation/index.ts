// 工作区导航门面：把「项目 / 远程主机 / 任务」三种入口收敛为同一份目录决议结果。
// INV-01：远程主机导航必须先有已保留项目，缺项目不得降级分配本地目录（守住位置：prepare 的 hostId 非 local 分支）。
// INV-02：返回的 workspaceIdentity 恒非空，缺失时由 hostId + workspacePath 派生（守住位置：directories 组装处）。
// INV-03：远程发布前 owner / membership / 目录条目必须与打开时一致，否则导航作废（守住位置：assertCurrent）。
// INV-04：task 入口的目录必须与任务记录逐字一致，不允许静默纠正（守住位置：resolveDirectories）。
// 破坏 INV-01 会让设备在线即拿到无归属 logical scope；破坏 INV-02 会让下游按 identity 去重时把两台主机合并；
// 破坏 INV-03 会把已失效的 workspace 挂到新连接；破坏 INV-04 会让任务续跑落到另一个目录。
// 本文件不做 IO 决策，只编排顺序与闸门；真正的目录创建与注册由 port 承担。
import { z } from "zod";
import { buildRemoteHostWorkspaceIdentity } from "@zcode/shared";
import { readProjectCatalog } from "#src/project-catalog/index.js";
import type {
  ProjectNavigationPort,
  ProjectWorkspaceNavigation,
} from "#src/project-workspace-navigation/contract.js";
export type {
  ProjectNavigationRequest,
  ProjectNavigationResult,
  ProjectNavigationPort,
} from "#src/project-workspace-navigation/contract.js";

// [权衡] 校验放在 schema.refine 而不是 prepare 内部：非法组合在进入任何 IO 之前抛出，
// 不会留下「已读目录树、却发现参数矛盾」的半初始化痕迹。strict 拒绝未知字段，
// 避免上层把尚未生效的字段误当成已校验。
const requestSchema = z
  .object({
    projectId: z.string().min(1).nullable().optional(),
    hostId: z.string().min(1).optional(),
    draftId: z.string().uuid().optional(),
    reuseDraft: z.boolean().optional(),
    task: z
      .object({ taskId: z.string().min(1), workspaceKey: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (request) =>
      (!request.task || (request.projectId === undefined && request.draftId === undefined)) &&
      (!request.draftId || !request.projectId) &&
      (!request.reuseDraft || Boolean(request.draftId)),
    "Task navigation cannot prepare a draft",
  );

export function createProjectWorkspaceNavigation(
  port: ProjectNavigationPort,
): ProjectWorkspaceNavigation {
  return {
    async prepare(input) {
      const request = requestSchema.parse(input);
      const hostId = request.hostId ?? "local";
      // 导航必须先有远程项目，不能因设备在线就分配无归属目录和 logical scope。
      if (hostId !== "local" && !request.task && !request.projectId)
        throw new Error("project.remote-project-required");
// [权衡] 未提供的字段用条件展开而非赋 undefined：prepareSession 以「键是否存在」
// 区分「未指定」与「显式清空」，传 undefined 会覆盖掉已有草稿绑定。
// 这也保证 draftId 与 reuseDraft 总是一起出现或一起缺席。
      const params = {
        hostId,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        ...(request.draftId ? { draftId: request.draftId, reuseDraft: request.reuseDraft } : {}),
      };
// [失败路径] 任务按 hostId + taskId + workspaceKey 三元组定位：只按 taskId 匹配会在
// 同名任务跨主机时命中别人的工作区；workspaceKey 用 identity 优先、路径兜底。
      const readTask = async () => {
        if (!request.task) return undefined;
        const tree = await port.projectService.readTree({ hostId, includeDeleted: true });
        const task = tree.tasks.find(
          (item) =>
            item.hostId === hostId &&
            item.taskId === request.task?.taskId &&
            (item.workspaceIdentity?.trim() || item.workspacePath) === request.task.workspaceKey,
        );
        if (!task) throw new Error("project.task-not-found");
        return {
          task,
          project: tree.projects.find(
            (project) => project.id === task.projectId && project.hostId === hostId,
          ),
        };
      };
// [并发] 任务记录的目录可能被另一端改写，这里以任务记录为唯一事实源做一致性校验：
// 决议结果与记录不一致说明任务已被移动或重新绑定，必须失败而不是返回新目录（INV-04）。
// 无任务时走通用 prepareSession；有任务时必须走 resolveSessionDirectories。
      const resolveDirectories = async (existing: Awaited<ReturnType<typeof readTask>>) => {
        if (!existing) return port.projectService.prepareSession(params);
        const directories = await port.projectService.resolveSessionDirectories(
          existing.task,
          hostId,
        );
        if (
          directories.workspacePath !== existing.task.workspacePath ||
          directories.workspaceIdentity !== existing.task.workspaceIdentity
        )
          throw new Error("project.task-directory-mismatch");
        return directories;
      };
// 本地分支到此收敛：不读项目目录、不做 owner 校验，hostId 由这里补齐，
// 下游无需再按入口分叉。
      if (hostId === "local") return { ...(await resolveDirectories(await readTask())), hostId };
// 远程分支先快照目录：后续判定全部基于同一份快照，
// 避免多次读取之间目录被并发修改、project 与 entries 来自不同版本。
      const before = await readProjectCatalog(port);
      const host = before.directory.hosts.find((item) => item.id === hostId);
      const owner = port.readConnectionOwner(hostId);
// [并发] owner 是连接归属令牌：缺失说明连接已被回收，状态非 online 说明通道未就绪；
// 两者都拒绝，否则会把 workspace 发布到死连接上，后续所有读取都超时。
// [资源] 这里只校验 host.target 存在，真正的连接建立与回滚由 openRemoteWorkspace 负责。
      if (!host?.target || !owner || host.connectionStatus !== "online")
        throw new Error("project.host-offline");
      const existing = await readTask();
      const project =
        existing?.project ??
        (request.projectId
          ? before.projects.find((item) => item.id === request.projectId && item.hostId === hostId)
          : undefined);
      if (existing?.task.projectId && !project) throw new Error("project.not-retained");
      if (request.projectId && !project) throw new Error("project.not-retained");
// [权衡] 旧条目没有 projectId 时用 legacyWorkspace.workspacePath 与项目根反查归属：
// 直接丢弃 legacy 条目会让升级前的目录在迁移期内从导航中消失。
// 条件里保留 project 判空，使无项目时 entries 为空，后面的 stale 校验必然失败。
      const entries = before.directory.entries.filter(
        (entry) =>
          entry.hostId === hostId &&
          project &&
          (entry.projectId === project.id ||
            (entry.projectId === null &&
              entry.legacyWorkspace &&
              project.roots.some(
                (root) => root.rootPath === entry.legacyWorkspace?.workspacePath,
              ))),
      );
// [事务] 发布前重读目录并比对三件事：owner 未换、membership 未变、每个条目仍存在。
// 任一不满足即 navigation-stale，这是防止「本地已决议、远端已被踢出」的唯一闸门。
// [权衡] assertCurrent 只比对 entry id 与 owner/membership：条目内容可重命名，id 复用才说明归属被替换。
      const assertCurrent = async () => {
        const current = await port.remoteProjectService.readDirectory();
        if (
          port.readConnectionOwner(hostId) !== owner ||
          !current.hosts.some(
            (item) => item.id === hostId && item.membershipId === host.membershipId,
          ) ||
          (project &&
            !entries.some((entry) => current.entries.some((item) => item.id === entry.id)))
        )
          throw new Error("project.navigation-stale");
      };
      const prepared = await resolveDirectories(existing);
      const directories = {
        ...prepared,
// [失败路径] 远程目录缺 identity 时由 hostId + 路径派生（INV-02），绝不返回空值：
// 下游按 identity 去重，空值会把所有远程工作区合并成同一个。
        workspaceIdentity:
          prepared.workspaceIdentity ??
          buildRemoteHostWorkspaceIdentity(hostId, prepared.workspacePath),
      };
// [事务] 提交前最后一个检查点：从它到 openRemoteWorkspace 之间不再读目录，窗口尽量短；
// 失败只撤销尚未注册的 provisional scope。
      await assertCurrent();
      // Registry 在 provisional scope 提交前再次调用；迟到失败只撤销本次尚未发布的 scope。
      const remote = await port.openRemoteWorkspace({ host, directories, owner, assertCurrent });
// 返回面同时带 directories、hostId 与 remote：调用方在 UI 与 session 层复用同一份
// 目录事实，不再各自拼装，避免两条路径拼出不同的 workspaceKey。
      return { ...directories, hostId, remote };
    },
  };
}
