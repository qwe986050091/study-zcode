// legacy 单根项目适配层：对端握手缺少 virtualProjects 时，把「一个 workspace = 一个项目」的旧
// 模型伪装成新 IProjectService，使 UI 不必为旧 Server 分叉出第二套项目模型。
// 本文件不持有状态、不写数据库、不重启 Agent；所有读都实时转发给旧 Server 的只读端口。
// INV-01：合成项目 ID 必须是 hostId + rootPath 的纯函数，同一输入在任何进程、任何时刻都得到
// 同一 ID；否则刷新后任务与项目的绑定会断裂。（守住位置：catalog 中 sha256 的输入）
// INV-02：directoryMatchPath 只能用于匹配，绝不能参与 ID 计算，也不能当作任务 cwd；历史 cwd
// 可能含点段或不同分隔符，规范化后的值与落盘值不同。（守：catalog 的 pathRules.normalize）
// INV-03：写操作一律 readOnly 抛错，且任何 I/O 之前先 verifyHost；跨 Host 请求必须被拒绝，
// 而不是被本机服务误处理。（守：verifyHost 与四个 readOnly 方法）
// INV-04：任务行只做去重与补全 hostId/projectId，不保存第二份任务索引；旧协议三个分区不是事务。
// 破坏后果：ID 不稳定会让项目每次刷新后换身份；写路径漏拦会写坏旧端数据且无回滚。
import type { AppSettings, FileEntry, SystemInfo, ZCodeTaskMeta } from "@zcode/shared";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type { IProjectService, VirtualProject, ProjectTask } from "#src/project/contract.js";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "#src/project/contract.js";

// 端口只暴露旧协议真实具备的读能力；缺什么就在这里显式缺，不在适配层补默认值，否则会对旧
// Server 产生它并不支持的语义（例如创建、移动、重排）。
/** 旧 Server 的只读边界；实际 RPC 的选择由连接装配器完成。 */
interface LegacyProjectReadPort {
  directories: {
    info(): Promise<SystemInfo>;
    read(input: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  };
  readSettings(): Promise<Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">>;
  readTasks(input: {
    workspacePath: string;
    kind: "active" | "pinned" | "archived";
  }): Promise<ZCodeTaskMeta[]>;
  ensureConversation(): Promise<string>;
  readKnownWorkspaces?(): Promise<
    readonly { workspacePath: string; workspacePurpose?: "project" | "conversation" }[]
  >;
}

/** 仅由握手缺失 virtualProjects 的装配路径调用；没有数据库或 Agent 创建权限。 */
// 前置契约：只允许在「握手缺失 virtualProjects」的装配路径调用；hostId 是这一层所有合成 ID 与
// 任务行的所有权锚点，必须来自已鉴权的连接，不能取自请求参数。
// 返回对象满足 IProjectService 的只读子集，写方法全部指向 readOnly 以保持接口形状完整。
export function createLegacySingleRootProjectService(
  options: LegacyProjectReadPort & { hostId: string },
): IProjectService {
  // [失败路径] 空 hostId 放行是有意的：本地调用链不带 hostId，不能因此拒绝；一旦带了就必须
  // 相等，防止跨 Host 的移动请求被本机旧端接受。
  const verifyHost = (hostId?: string) => {
    if (hostId && hostId !== options.hostId) throw new Error("project.cross-host-move");
  };
  // 统一失败出口而不是逐个方法写 throw：调用方按接口签名应当实现这些写方法，运行时必须以
  // 明确错误拒绝，不能静默返回成功让 UI 误以为迁移已完成。
  const readOnly = async (): Promise<never> => {
    throw new Error("project.legacy-read-only");
  };
  // 目录是派生视图而非缓存：每次调用都重新向旧端读设置与系统信息，避免适配层引入过期状态。
  // 平台规则取远端 info.platform 而不是 process.platform：本机可能是 Windows 而远端是 POSIX。
  // lastWorkspaceSession 只取 local 条目：remote 条目属于另一条连接，不能混进本 Host 的项目列表。
  // known 合并「最近会话 + 已登记工作区」，两者可能重叠，靠后面的 Set 去重而不是在这里判重。
  // 会话用途（conversation）的工作区必须从项目列表剔除，否则切换项目时会话目录会被当成仓库。
  // paths 用 Set 保持首次出现顺序，该下标直接作为 position：顺序稳定才能让 UI 列表不跳动。
  // 无法反推出更早的 createdAt/updatedAt，故统一置 0，由 UI 按 position 排序而非时间排序。
  const catalog = async () => {
    const [settings, info] = await Promise.all([
      options.readSettings(),
      options.directories.info(),
    ]);
    const pathRules = info.platform === "win32" ? win32 : posix;
    const local = (settings.lastWorkspaceSession ?? []).filter((entry) => entry.kind === "local");
    const known = [...local, ...((await options.readKnownWorkspaces?.()) ?? [])];
    const conversations = new Set(
      known
        .filter((entry) => entry.workspacePurpose === "conversation")
        .map((entry) => entry.workspacePath),
    );
    const paths = [
      ...new Set([
        ...known.map((entry) => entry.workspacePath),
        ...(settings.recentProjects ?? []),
      ]),
    ];
    const projects: VirtualProject[] = paths
      .filter((path) => !conversations.has(path))
      .map((rootPath, position) => ({
        id:
          LEGACY_SINGLE_ROOT_PROJECT_PREFIX +
          createHash("sha256")
            .update(JSON.stringify([options.hostId, rootPath]))
            .digest("hex"),
        hostId: options.hostId,
        legacySingleRoot: true,
        // 历史 cwd 可能含点段或不同分隔符；仅规范化匹配值，不能改合成 ID 的输入及任务绑定目录。
        directoryMatchPath: pathRules.normalize(rootPath),
        name: rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath,
        nameOverridden: false,
        roots: [{ rootPath, isPrimary: true, position: 0 }],
        position,
        pinned: false,
        deleted: false,
        createdAt: 0,
        updatedAt: 0,
      }));
    return { paths, projects };
  };
  const service: IProjectService = {
    // 路径规则必须按远端平台取：用本机规则判 posix 绝对路径会漏判 /home/...，进而拼错 normalize。
    // isAbsolute 必须在 normalize 之前判，否则 normalize 会把相对路径拼成看似绝对的字符串。
    // includeHidden 未传时不写该键，让旧端保持自己的默认，而不是由适配层假定 false。
    async readDirectory(params) {
      verifyHost(params?.hostId);
      // 旧远端只读能力不应阻止选择已有项目；目录校验走远端文件服务，路径规则不能取本机平台。
      const info = await options.directories.info();
      const paths = info.platform === "win32" ? win32 : posix;
      const requested = params?.path?.trim() || info.homedir;
      if (!paths.isAbsolute(requested)) throw new Error("project.absolute-path-required");
      const path = paths.normalize(requested);
      const entries = await options.directories.read({
        path,
        ...(params?.includeHidden === undefined ? {} : { includeHidden: params.includeHidden }),
      });
      return { path, entries };
    },
    // 只读端点不缓存 catalog：UI 可能在两次刷新之间新增了最近项目，缓存会把新项目藏起来。
    async readProjects(params) {
      verifyHost(params?.hostId);
      return (await catalog()).projects;
    },
    // 三个分区并行读取：旧协议每次只返回一个 kind，串行会让 tree 的延迟变成三倍。
    // projectId 通过 roots[0].rootPath 反查，而不是自己再算一遍哈希：ID 生成规则只能在 catalog 一处。
    // 分区的 pinned/archived 标记由这里补全：旧端只按 kind 返回，行本身不带这两个字段。
    // [权衡] 去重键优先用 workspaceIdentity、退化到 workspacePath：远程身份相同而路径写法不同时，
    // 路径会把同一任务算两遍。只对本次查询去重，不写入任何持久索引。
    async readTree(params) {
      verifyHost(params?.hostId);
      const { paths, projects } = await catalog();
      const rows = await Promise.all(
        paths.map(async (workspacePath) => {
          const scope = { workspacePath };
          const [active, pinned, archived] = await Promise.all([
            options.readTasks({ ...scope, kind: "active" }),
            options.readTasks({ ...scope, kind: "pinned" }),
            options.readTasks({ ...scope, kind: "archived" }),
          ]);
          const projectId =
            projects.find((project) => project.roots[0]?.rootPath === workspacePath)?.id ?? null;
          return [
            ...active.map((task) => ({ ...task, pinned: false, archived: false })),
            ...pinned.map((task) => ({ ...task, pinned: true, archived: false })),
            ...archived.map((task) => ({ ...task, pinned: false, archived: true })),
          ].map((task): ProjectTask => ({ ...task, hostId: options.hostId, projectId }));
        }),
      );
      // 行集合仍来自远端 app 的索引；不读取 runtime snapshot 推导存在性或终态。
      // 旧协议的三个分区不是一个事务；置顶/归档交错可能让同一行出现两次。
      // 只对本次查询按 workspace 身份和 task ID 去重，不保存第二份任务索引。
      const tasks = [
        ...new Map(
          rows
            .flat()
            .map((task) => [
              JSON.stringify([task.workspaceIdentity?.trim() || task.workspacePath, task.taskId]),
              task,
            ]),
        ).values(),
      ];
      return { projects, tasks, legacySingleRoot: true };
    },
    // 无 projectId 表示「新会话」：此时交给旧端分配会话目录，适配层不猜路径。
    // 有 projectId 却查不到必须抛 not-found，而不是退回会话目录——那会把任务默默写进错误目录。
    async prepareSession(params) {
      verifyHost(params?.hostId);
      if (!params?.projectId)
        return {
          workspacePath: await options.ensureConversation(),
          projectId: null,
          additionalDirectories: [],
        };
      const project = (await catalog()).projects.find((item) => item.id === params.projectId);
      if (!project) throw new Error("project.not-found");
      return {
        workspacePath: project.roots[0]!.rootPath,
        projectId: project.id,
        additionalDirectories: [],
      };
    },
    // 任务可能来自远程 workspace，workspaceIdentity 里带的 host 也要校验，不能只看入参 hostId。
    // 反查不到项目不算错误：任务可能属于本适配层未登记的旧 cwd，此时 projectId 置 null 即可。
    async resolveSessionDirectories(task, hostId) {
      verifyHost(hostId);
      if (task.workspaceIdentity)
        verifyHost(remoteHostIdFromWorkspaceIdentity(task.workspaceIdentity) ?? undefined);
      const project = (await catalog()).projects.find(
        (item) => item.roots[0]?.rootPath === task.workspacePath,
      );
      return {
        workspacePath: task.workspacePath,
        projectId: project?.id ?? null,
        additionalDirectories: [],
      };
    },
    // 四个写方法集中指向同一个 readOnly：保持接口形状完整（类型层不会缺方法），又在运行期明确
    // 拒绝，避免 UI 以为可以在旧端做迁移。
    // 新增写方法必须补进这一组，否则接口会在运行时以 undefined 调用失败。
    saveProject: readOnly,
    deleteProject: readOnly,
    moveTask: readOnly,
    reorderProjects: readOnly,
  };
  return service;
}
