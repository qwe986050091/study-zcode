// 项目服务的装配层：把 SQLite 仓储、目录端口、远端 Host 路由合成为一个 IProjectService。
// 本文件不实现持久化，也不实现目录枚举；它只决定这次调用归谁、什么时候允许产生副作用。
// INV-01：主目录存在性每次读取都重新派生，不写回仓储（守住：projectPrimaryRootStatuses）；
//         固化旧值会让用户删除或恢复目录后，侧栏长期显示过期状态。
// INV-02：进入仓储的 root 必须绝对、normalize、且是真实目录（守住：saveProject / moveTask /
//         prepareSession）；否则同一目录存在多种字符串表示，归属比较失配，任务会落到错误项目。
// INV-03：远端调用必须先路由再执行本地副作用（守住：所有 route 调用点）；顺序颠倒会在本机
//         建出目录，而请求实际属于远端 Host。
// INV-04：按 projectId 的首建合并为单飞（守住：creationFlights）；并发首建会产生两个 cwd，
//         同一任务的不同窗口看到不同文件。
// INV-05：空项目的 root 初始化必须走仓储写事务（守住：initializeProjectRoot）；先读后写会覆盖
//         另一 Host 刚写入的 roots。
// INV-06：workspaceIdentity 只由 attachment 解析，cwd 原文不改写（守住：bindRemoteProjectIdentities）；
//         用 identity 当路径会让文件操作指向不存在的位置。
// INV-07：本层不重试、不兜底（守住：整体）；失败以错误码上抛，由调用方决定提示文案。
import type { FileEntry } from "@zcode/shared";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { IProjectService, ProjectDirectories, VirtualProject } from "#src/project/contract.js";
export { IProjectService } from "#src/project/contract.js";
export { createLegacySingleRootProjectService } from "#src/project/legacy-single-root.js";
export {
  createTaskAutoArchiveScheduler,
  shouldRescanTaskAutoArchive,
} from "#src/project/autoArchiveScheduler.js";
export type {
  ProjectTree,
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
  ProjectRoot,
  SaveProjectInput,
  ProjectDirectories,
} from "#src/project/contract.js";

// 目录端口只暴露本服务需要的最小能力：home 提供默认起点，read 列出条目。
// 抽成端口而非直接调用 fs，是为了让远端 Host 注入自己的目录实现，本地不假设路径语义一致。
interface ProjectDirectoryPort {
  home(): Promise<string>;
  read(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
}

// 把 stat 失败分成 missing 与 unavailable：只有 ENOENT/ENOTDIR 能证明目录不存在，
// EACCES/EMFILE 等只说明这次读不到。若一律报 missing，UI 会引导用户重选目录，
// 而真实原因是权限或句柄耗尽，重选也无法恢复。
async function readPrimaryRootStatus(
  path: string,
): Promise<NonNullable<VirtualProject["primaryRootStatus"]>> {
  try {
    return (await stat(path)).isDirectory() ? "available" : "missing";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
  }
}

async function projectPrimaryRootStatuses(projects: VirtualProject[]): Promise<VirtualProject[]> {
  // 主目录存在性属于文件系统事实；每次读取重新派生，不能把删除/恢复后的旧值固化进 SQLite。
// [资源] 同批项目可能共享主目录，用 Map 复用同一个 stat Promise；
// 去重只在本批内有效，不跨请求缓存，避免删除或恢复后读到过期状态。
  const checks = new Map<string, ReturnType<typeof readPrimaryRootStatus>>();
  return Promise.all(
    projects.map(async (project) => {
      const primary = project.roots.find((root) => root.isPrimary)?.rootPath;
      if (!primary || project.deleted) return project;
      let check = checks.get(primary);
      if (!check) {
        check = readPrimaryRootStatus(primary);
        checks.set(primary, check);
      }
      return { ...project, primaryRootStatus: await check };
    }),
  );
}

// [失败路径] schema 用 strict + refine 在装配层拦下两类歧义：
// id 与 restoreProjectId 同时出现说明调用方不确定是新建还是恢复；
// restoreProjectId 不带 roots 则恢复后没有可校验的目录。两者都会写到错的记录上。
const saveProjectSchema = z
  .object({
    id: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    restoreProjectId: z.string().min(1).optional(),
    name: z.string().optional(),
    defaultName: z.string().optional(),
    roots: z.array(z.string().min(1)).optional(),
    primaryRoot: z.string().min(1).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((value) => !(value.id && value.restoreProjectId), "project.ambiguous-save")
  .refine(
    (value) => !value.restoreProjectId || value.roots !== undefined,
    "project.restore-roots-required",
  );

// 装配入口：repository 以函数注入，因为仓储初始化本身是异步的（打开或迁移数据库），
// 不能在构造期求值；每次使用都取最新实例，避免持有已关闭的连接。
export function createProjectService(options: {
  repository(): Promise<ProjectRepositoryContract>;
  workspaceDirectory: string;
  ownerHostId?: string;
  directories?: ProjectDirectoryPort;
  /** 只解析现有连接；连接缺失拒绝，不创建替代 Host。 */
  resolveHost?: (hostId: string) => Promise<IProjectService>;
  afterChange?: () => Promise<void>;
}): IProjectService {
// 路由只做三件事：同 Host 返回 null 走本地，未知 Host 直接拒绝，其余交给 resolveHost。
// 缺省 ownerHostId 视为 local，保证单机旧调用方不传 hostId 也不会被当成远端。
  const route = async (hostId?: string) => {
    if (!hostId || hostId === (options.ownerHostId ?? "local")) return null;
// [失败路径] 没有连接解析器就是远端不可达，必须显式失败；回退到本地会把远端项目写进本机库。
    if (!options.resolveHost) throw new Error("project.host-offline");
    return options.resolveHost(hostId);
  };
// [并发] 首建单飞表只在 prepareSession 生命周期内存在，finally 中按 Promise 身份删除，
// 避免把后来者发起的另一次首建误删。
  const creationFlights = new Map<string, Promise<ProjectDirectories>>();
  const changed = async () => {
    await options.afterChange?.();
  };
  const service: IProjectService = {
// 目录浏览返回的 path 会被前端原样回填为 root，所以本地路径必须是绝对路径，
// 否则后续归属校验无法把候选目录与已保存的 root 比较。
    async readDirectory(params = {}) {
      const input = z
        .object({
          hostId: z.string().min(1).optional(),
          path: z.string().min(1).optional(),
          includeHidden: z.boolean().optional(),
        })
        .strict()
        .parse(params);
      const remote = await route(input.hostId);
      if (remote) return remote.readDirectory(input);
      if (!options.directories) throw new Error("project.directory-service-unavailable");
      const requestedPath = input.path ?? (await options.directories.home());
      if (!isAbsolute(requestedPath)) throw new Error("project.absolute-path-required");
      // 目录匹配必须和本 Host 保存 root 的规则相同，不能在控制端按其操作系统处理远端路径。
// [权衡] 在这里统一 normalize 而不是交给前端：前端一旦漏做，就会产生一个
// 与已有 root 永远不相等的候选路径，属于静默的归属失败。
      const path = normalize(requestedPath);
      return {
        path,
        entries: await options.directories.read({
          path,
          ...(input.includeHidden !== undefined ? { includeHidden: input.includeHidden } : {}),
        }),
      };
    },
// 项目列表只附主目录状态、不返回任务：列表用于选择项目，附带任务会让大项目变成全表读。
// 状态与 readTree 共用同一派生函数，保证两处对同一目录给出相同结论。
    async readProjects(params) {
      const remote = await route(params?.hostId);
      return remote
        ? remote.readProjects({ includeDeleted: params?.includeDeleted })
        : projectPrimaryRootStatuses(
            (await options.repository()).readTree({
              includeDeleted: params?.includeDeleted,
              includeTasks: false,
            }).projects,
          );
    },
    async readTree(params) {
      const remote = await route(params?.hostId);
      if (remote)
        return remote.readTree({
          includeDeleted: params?.includeDeleted,
          includeDeletedTasks: params?.includeDeletedTasks,
        });
      // 只读：自动归档由 autoArchiveScheduler 定时执行，读取与点击都不改变 archived。
// 读树只派生状态、不落库：本方法被侧栏高频调用，任何写库都会与归档调度器争用同一连接。
      const tree = (await options.repository()).readTree({
        includeDeleted: params?.includeDeleted,
        includeDeletedTasks: params?.includeDeletedTasks,
      });
      return { ...tree, projects: await projectPrimaryRootStatuses(tree.projects) };
    },
// roots 先 normalize 再 Set 去重：renderer 会提交同一目录的不同字符串写法，
// 按原文去重会把它们当成两个 root，落库后出现两条指向同一物理目录的记录。
    async saveProject(input) {
      input = saveProjectSchema.parse(input);
      const remote = await route(input.hostId);
      if (remote) return remote.saveProject(input);
      const roots = input.roots
        ? [
            ...new Set(
              input.roots.map((path) => {
// [失败路径] 相对路径无法判断归属主机，必须在写库前拒绝，而不是交给仓储后再报错。
                if (!isAbsolute(path)) throw new Error("project.absolute-path-required");
                return normalize(path);
              }),
            ),
          ]
        : undefined;
// 目录存在性并发校验，任一失败即整体失败：不存在的 root 一旦落库，
// 项目树会长期显示一个点进去就报错的目录。
      await Promise.all(
        (roots ?? []).map(async (path) => {
          if (!(await stat(path)).isDirectory()) throw new Error("project.directory-required");
        }),
      );
      const result = (await options.repository()).saveProject({
        ...input,
        roots,
        ...(input.primaryRoot ? { primaryRoot: normalize(input.primaryRoot) } : {}),
      });
      await changed();
      return result;
    },
    async deleteProject(id, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.deleteProject(id);
      (await options.repository()).deleteProject(id);
      await changed();
    },
// addMissingRoot 只表示允许把任务当前 cwd 登记为 root，仍要求目录真实存在；
// 否则一次拖动就能把任务挂到已被删除的路径上。
    async moveTask(input) {
      const remote = await route(input.hostId);
      if (remote)
        return remote.moveTask({
          task: input.task,
          projectId: input.projectId,
          addMissingRoot: input.addMissingRoot,
        });
      // 确认增加缺失 root 时也校验目录，不能通过拖动绕过新增目录的存在性约束。
// [失败路径] 校验必须在写库之前：写入后再发现缺失只能回滚，而回滚会丢失任务原归属。
      if (input.addMissingRoot && !(await stat(input.task.workspacePath)).isDirectory())
        throw new Error("project.directory-required");
      (await options.repository()).moveTask(input);
      await changed();
    },
    async reorderProjects(ids, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.reorderProjects(ids);
      (await options.repository()).reorderProjects(ids);
      await changed();
    },
    async resolveSessionDirectories(task, hostId) {
      const remote = await route(hostId);
      if (remote) return remote.resolveSessionDirectories(task);
      return (await options.repository()).resolveSessionDirectories(task);
    },
    async prepareSession(params) {
// draftId 由客户端在发请求前生成并落盘，这里只校验格式：格式错误说明调用方拼错参数，
// 不能静默当成无 draft 另开一个新目录。
      const draftId =
        params?.draftId === undefined ? undefined : z.string().uuid().parse(params.draftId);
// [失败路径] 两组互斥参数在创建目录前拦截：draft 与 project 同时给会让归属不确定，
// reuseDraft 却没有 draftId 则无法定位要复用的目录。
      if ((draftId && params?.projectId) || (params?.reuseDraft && !draftId))
        throw new Error("project.invalid-draft-target");
      const remote = await route(params?.hostId);
      if (remote) return remote.prepareSession({ projectId: params?.projectId });
// 会话准备是所有副作用的汇合点：目录创建、root 初始化、归属复检都在这里，
// 因此每个分支都先决定拒绝还是复用，再动手。
      const id = params?.projectId;
// 远端 owner 的 Host 不接受无项目的草稿目录：它的工作区必须归属某个项目，
// 否则远控端无法把会话映射回项目树。
      const remoteOwner = Boolean(options.ownerHostId && options.ownerHostId !== "local");
      // 旧入口可绕过项目直接在远端 mkdir；必须在目录或会话副作用之前拒绝。
      if (remoteOwner && !id) throw new Error("project.remote-project-required");
// [并发] 命中在途首建直接复用：两个窗口同时打开空项目时，第二个不重复 mkdir 与初始化。
      if (id && creationFlights.has(id)) return creationFlights.get(id)!;
// 单飞体内部不 catch：错误原样传给所有等待者，避免某个等待者拿到部分成功的目录。
      const flight = (async (): Promise<ProjectDirectories> => {
// 无项目归属的会话：目录名由 draftId 决定（可重试同一目录），
// 或退化为时间戳 + UUID（不可重试，用于 Bots 等一次性调用）。
        if (!id) {
          // 草稿 ID 在客户端先落盘；重复点击、回包丢失与重启重试都准备同一目录。
          // 无 draftId 的自动化/Bots 等调用仍独立分配，不能全局复用最近目录。
          const path = join(
            options.workspaceDirectory,
            draftId ? `draft-${draftId}` : `${Date.now()}-${randomUUID()}`,
          );
          // 已交付的目录若被移走，只报告缺失；不能用 mkdir 静默重建空目录。
// [失败路径] 复用草稿只 stat 不 mkdir：目录被移走说明用户已放弃该草稿，
// 静默重建会让恢复上次会话变成空目录上的新会话。
          if (params?.reuseDraft) {
            if (!(await stat(path)).isDirectory()) throw new Error("project.directory-required");
          } else await mkdir(path, { recursive: true });
          return { workspacePath: path, additionalDirectories: [], projectId: null };
        }
        const repo = await options.repository();
        // 新建只需要项目目录；读取全量历史任务会阻塞草稿导航，复检也使用同一项目限定读取。
        let project = repo
          .readTree({ includeTasks: false })
          .projects.find((item) => item.id === id);
// [失败路径] 找不到项目直接拒绝，不创建占位项目：项目是用户资产，不能由会话请求隐式产生。
        if (!project) throw new Error("project.not-found");
// 远端 Host 只支持单 root：附加目录在远控链路上没有对应的路径映射，
// 放行会让任务 cwd 指向远端不存在的位置。
        if (remoteOwner && project.roots.length !== 1)
          throw new Error("project.remote-single-root-required");
        if (!project.roots.length) {
          // 多窗口为同一空项目生成同一个目录，不依赖进程间定时锁。
          const path = join(options.workspaceDirectory, id);
          await mkdir(path, { recursive: true });
          // 空判断和 INSERT 必须共用写事务，防止另一 Host 的 roots 编辑被覆盖。
          project = repo.initializeProjectRoot(id, path);
          await changed();
        }
// 主 root 缺失属于数据异常（roots 非空但没有 isPrimary），不能退而选第一个附加目录：
// 那会让后续所有会话落到用户没有指定为主目录的位置。
        const workspacePath = project.roots.find((root) => root.isPrimary)?.rootPath;
        if (!workspacePath) throw new Error("project.primary-root-missing");
        // 项目树与点击之间主目录仍可能被移走；创建入口必须复检，不能用 mkdir 复活旧路径或改选附加目录。
// 复检结果区分 missing 与 unavailable，把错误码透给前端，便于选择重新选择还是稍后重试。
        const primaryRootStatus = await readPrimaryRootStatus(workspacePath);
        if (primaryRootStatus !== "available") {
          throw new Error(
            primaryRootStatus === "missing"
              ? "project.primaryRootMissing"
              : "project.primaryRootUnavailable",
          );
        }
        // 目录检查会让出执行权；项目在此期间删除时不得返回可用于首发的旧归属。
// [并发] 复检只能看 !deleted：软删记录仍在表里，用存在性代替会再次放进已删除项目。
        if (
          !repo
            .readTree({ includeTasks: false })
            .projects.some((item) => item.id === id && !item.deleted)
        )
          throw new Error("project.not-found");
        return {
// 附加目录保持仓储顺序并排除主目录：调用方用它建可写根，顺序会影响 UI 展示与默认选中。
          projectId: id,
          workspacePath,
          additionalDirectories: project.roots
            .map((root) => root.rootPath)
            .filter((path) => path !== workspacePath),
        };
      })();
// 只缓存有 projectId 的首建：草稿目录每次都应独立分配，缓存它会把并发请求串到同一目录。
      if (id) creationFlights.set(id, flight);
      try {
        return await flight;
      } finally {
        if (id && creationFlights.get(id) === flight) creationFlights.delete(id);
      }
    },
  };
  return service;
}

// bindRemoteProjectIdentities 是装饰器：不改变原服务的读写语义，只补 workspaceIdentity。
// 所有方法必须转发同一个 service 实例，否则路由与单飞表会被复制成两份。
/** 对外树使用 attachment 已登记的稳定身份；实际 cwd 与远端 canonical key 不改写。 */
export function bindRemoteProjectIdentities(
  service: IProjectService,
  resolveIdentity: (workspacePath: string) => Promise<string>,
): IProjectService {
  return {
    readProjects: (params) => service.readProjects(params),
    async readTree(params) {
// 先解析全部目录身份再发布树：空项目没有任务时侧栏仍会立刻订阅项目目录状态，
// 若只准备 task cwd，首次订阅会固定到未映射的 emitter，之后无法重绑。
      const tree = await service.readTree(params);
      // 空项目也会立即订阅侧栏状态。若只准备 task cwd，首次订阅会固定到未映射的
      // emitter，稍后打开目录才建立映射也无法重绑；必须先准备所有订阅目录再发布树。
      const paths = [
        ...new Set([
          ...tree.projects.flatMap((project) => project.roots.map((root) => root.rootPath)),
          ...tree.tasks.map((task) => task.workspacePath),
        ]),
      ];
// [资源] 一次 Promise.all 解析全部身份，避免逐条 await 造成 N 次串行往返。
      const identities = new Map(
        await Promise.all(paths.map(async (path) => [path, await resolveIdentity(path)] as const)),
      );
      return {
        ...tree,
        tasks: tree.tasks.map((task) => ({
          ...task,
// [失败路径] 非空断言成立：paths 已包含所有 task.workspacePath，解析结果必然存在。
          workspaceIdentity: identities.get(task.workspacePath)!,
        })),
      };
    },
    readDirectory: (params) => service.readDirectory(params),
    saveProject: (input) => service.saveProject(input),
    deleteProject: (id, hostId) => service.deleteProject(id, hostId),
    moveTask: (input) => service.moveTask(input),
    reorderProjects: (ids, hostId) => service.reorderProjects(ids, hostId),
    async prepareSession(params) {
// 身份以服务返回的真实 workspacePath 解析，不用请求里的 projectId 反推。
      const directories = await service.prepareSession(params);
      return {
        ...directories,
        workspaceIdentity: await resolveIdentity(directories.workspacePath),
      };
    },
    async resolveSessionDirectories(task, hostId) {
// 恢复路径同样补 identity：缺它会让同一 cwd 在导航校验里被当成两个工作区。
      const directories = await service.resolveSessionDirectories(task, hostId);
      // 已有任务恢复曾漏补远程身份，导致同一 cwd 被导航隔离校验拒绝。
      // 以所属 Host 返回的真实目录解析身份，不复制请求身份或放宽导航校验。
      return {
        ...directories,
        workspaceIdentity: await resolveIdentity(directories.workspacePath),
      };
    },
  };
}
