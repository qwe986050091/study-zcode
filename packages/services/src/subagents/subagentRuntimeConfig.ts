// 子 Agent 运行时配置缓存：把 user / project 的 profile 文档与持久化 state 合成只读快照。
// INV-01：user、project、state 三个 scope 由身份 key 唯一归属，同一 workspace 只保留一份监听；
// 重复 prepare 同一 workspace 必须先 dispose 旧 scope，否则旧监听会继续 publish 覆写快照。
// INV-02：snapshots 只存已完成的结果；busy 中的 scope 不参与合成，避免把半加载当全量。
// INV-03：快照是内存权威副本，read 返回 structuredClone，调用方改不动缓存。
// INV-04：任一 scope 失败一律降级为 built-in-fallback，不能抛错卡住启动。
// 破坏后果：若把 busy 结果写入快照，父 turn 会拿到缺 profile 的配置并按错误工具集运行；
// 若 read 直接返回引用，某个 turn 的原地修改会污染后续所有 turn。
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  parseAgentProfileFromMarkdown,
  resolveSubagentRuntimeProfiles,
  type SubagentRuntimeConfig,
  type SubagentRuntimeState,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createSubagentConfigScope,
  type SubagentFileChanges,
  type SubagentConfigLoadContext,
} from "#src/subagents/subagentConfigScope.js";

const logger = createServiceLogger("subagentRuntimeConfig");
// 首次加载只等 5s：超时后继续启动并保留后台加载（见 waitForInitialScopes 的 deadline）。
// 上限存在的理由：GUI 冷启动时文件监听可能迟迟不 settle，不能用无限等待阻塞窗口显示。
const INITIAL_LOAD_WAIT_MS = 5000;
interface Workspace {
  workspacePath: string;
  workspaceIdentity?: string;
}
interface ConfigReader {
  readUserRoot(): Promise<string>;
  readStatePath(): Promise<string>;
  readState(path: string): Promise<SubagentRuntimeState>;
}
// Profiles 以文件绝对路径为键：同名 profile 在 user/project 两个根下可以共存，
// 用路径而不是 name 做键，删除/重命名事件才能精确命中单条记录。
type Profiles = Map<string, ReturnType<typeof parseAgentProfileFromMarkdown>>;
type Scope<T> = ReturnType<typeof createSubagentConfigScope<T>>;

// 只扫 root 顶层（depth:0），与文件监听的递归深度保持一致；
// 若这里改成递归而监听不递归，深层 profile 只在全量重扫时出现，表现为「改完要重启」。
async function listDocuments(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
// [失败路径] ENOENT 视为「目录不存在 = 空集合」，首次启动时 agents 目录通常尚未创建；
// 其余 errno（EACCES/EIO）必须上抛，否则会静默丢掉全部用户 profile。
  // 自定义 profile 的发现范围与 depth:0 监听一致，避免深层定义只在重扫时变化。
  return entries
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/iu.test(entry.name))
    .map((entry) => join(root, entry.name));
}
// 增量加载核心：changes 描述文件事件，previous 是上一版 Map；
// 只有两者同时存在才复用 previous，否则从空表重建，避免残留已删除条目。
async function loadDocuments(
  root: string,
  source: "user" | "project",
  previous: Profiles | undefined,
  changes: SubagentFileChanges | undefined,
  context: SubagentConfigLoadContext,
): Promise<Profiles> {
  const next =
    changes && previous
      ? new Map(previous)
      : new Map<string, ReturnType<typeof parseAgentProfileFromMarkdown>>();
// changes 为空代表一次全量扫描：把 root 下所有文档标记为 read，再逐个解析。
  const updates =
    changes ?? new Map((await listDocuments(root)).map((path) => [path, "read" as const]));
  await Promise.all(
    [...updates].map(async ([path, action]) => {
// [失败路径] remove 事件先于「读取完成」到达是正常竞态；按 remove 直接删除，
// 不能让读取结果回过头覆盖，否则已删除的 agent 会继续出现在配置里。
      if (action === "remove") {
        next.delete(path);
        return;
      }
// 稳定窗口内文件仍在写入时返回 false：本轮跳过而不是读半截内容，后续事件会再触发解析；
// 同时删除旧值，避免把过期 profile 继续暴露给调用方。
      if (!(await context.waitForStableFile(path))) {
        next.delete(path);
        return;
      }
      context.signal.throwIfAborted();
// readFile 失败只把 ENOENT 当「已删除」，其他错误继续上抛，由 scope 记为 failed 并触发降级。
      const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        // 删除可能先于 change 的读取完成，以实际文件不存在为准，不回填旧 profile。
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (content === undefined) {
        next.delete(path);
        return;
      }
      context.signal.throwIfAborted();
// 诊断不阻断加载：单份 profile 语法错误只告警，其余文档仍应可用，避免一条坏文件打掉整个 agent 列表。
      const parsed = parseAgentProfileFromMarkdown({ content, path, source });
      if (parsed.diagnostic) logger.warn(undefined, "Agent profile diagnostic", parsed.diagnostic);
      next.set(path, parsed);
    }),
  );
  return next;
}
// 先按路径排序再投影：profile 顺序决定同名 agent 的覆盖优先级，固定顺序保证多次读取结果一致。
const profiles = (documents: Profiles) =>
  [...documents]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, parsed]) => (parsed.profile ? [parsed.profile] : []));

// [并发] Host 是唯一 owner：所有 scope 回调都跑在同一事件循环里，publish 串行执行，
// snapshots 的读写因此不需要额外锁；但异步 load 之间的交错仍要靠 busy 标志挡住。
/** Host 是解析结果的唯一 owner；每个父 turn 的 RPC 只复制已完成的内存 snapshot。 */
export function createSubagentRuntimeConfigCache(reader: ConfigReader) {
  let disposed = false;
  let user: { path: string; scope: Scope<Profiles> } | undefined;
  let state: { path: string; scope: Scope<SubagentRuntimeState> } | undefined;
// workspaces/snapshots 都以身份 key 为索引：dispose 时按 key 清空，避免跨 workspace 泄漏监听。
  const workspaces = new Map<string, Scope<Profiles>>();
  const snapshots = new Map<string, SubagentRuntimeConfig>();
// key 是 workspace 身份口径（workspaceIdentity 优先）：远程与本地可能同路径不同身份，
// 只按路径做键会把两个 workspace 的快照混在一起。
  const key = (workspace: Workspace) =>
    workspace.workspaceIdentity?.trim() || workspace.workspacePath;
// dispose 之后所有入口都走这里快速失败，避免对已清空的 map 做「看似成功」的读取。
  const assertActive = () => {
    if (disposed) throw new Error("Subagent runtime configuration cache is disposed");
  };
// publish 是唯一的快照写入口：任何 scope 变化都收敛到这里，保证读到的永远是完整三元组。
// [权衡] 没有做细粒度 diff，每次全量重算所有 workspace；profile 规模很小，换来的是无缓存失效 bug。
  function publish() {
// 未就绪或已销毁时静默返回：publish 由 scope 回调驱动，此处抛错只会污染加载流程。
    if (disposed || !user || !state) return;
    for (const [workspaceKey, project] of workspaces) {
// 三元组顺序固定 user→state→project，解析时后项覆盖前项；打乱会改变同名 profile 的优先级。
      const scopes = [user.scope, state.scope, project];
// [并发] busy 中的 scope 结果可能只覆盖部分文件；已有 ready 快照时先继续服务旧值，
// 等该 scope settle 再整体替换，避免把短暂的不完整状态暴露给正在跑的 turn。
      // 只保留已有完整快照；首次超时回退可用各范围的完整结果恢复，不必等共享刷新结束。
      if (snapshots.get(workspaceKey)?.kind === "ready" && scopes.some((scope) => scope.busy))
        continue;
// [失败路径] 任一 scope 失败即整体降级：半个用户配置会让工具集与预期不符，
// 显式退回 built-in 比「带着残缺配置」更容易解释，也避免把失败当成空配置。
      if (scopes.some((scope) => scope.failed))
        snapshots.set(workspaceKey, { kind: "built-in-fallback" });
      else if (user.scope.value && state.scope.value && project.value)
        snapshots.set(workspaceKey, {
          kind: "ready",
          ...resolveSubagentRuntimeProfiles(
            [...profiles(user.scope.value), ...profiles(project.value)],
            state.scope.value,
          ),
        });
    }
  }
// scope 自己负责文件监听与生命周期；这里只注入加载函数和 settle 回调，不持有可变状态。
// 每次 prepare 重建 scope 是为了换 root，而不是为了换加载策略。
  function documentScope(path: string, source: "user" | "project") {
    return createSubagentConfigScope({
      root: path,
      load: (previous: Profiles | undefined, changes, context) =>
        loadDocuments(path, source, previous, changes, context),
      onSettled: publish,
    });
  }
// required 是 read 的前置断言：未 prepare 或已 dispose 必须显式失败，
// 不能返回空配置让上层误以为「用户没有自定义 agent」。
  function required(workspace: Workspace) {
    assertActive();
    const project = workspaces.get(key(workspace));
    if (!user || !state || !project)
      throw new Error("Subagent runtime configuration is not prepared");
    return [user.scope, state.scope, project];
  }
// [并发] 首次等待用 do/while：settle 返回后 scope 可能立刻因新事件又变 busy，
// 循环到真正没有 busy 才 publish，否则会发布一份「看起来 ready 但还会变」的快照。
// 超时只结束调用方等待，不取消共享加载（见 finally 的说明）。
  async function waitForInitialScopes(scopes: Scope<unknown>[]) {
    let waiting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = (async () => {
      do {
        await Promise.all(scopes.map((scope) => scope.settle()));
      } while (waiting && scopes.some((scope) => scope.busy));
      // 首次 ready 在 scope 的 onSettled 之后才完成；启动方已返回时也必须发布。
      publish();
    })();
    try {
// [权衡] 用 Promise.race 而不是给 scope 传 timeout：加载是共享的，取消会波及同 workspace
// 的其他调用方；这里只放弃本次等待，后台继续把结果写进 snapshots。
      await Promise.race([
        completed,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            waiting = false;
            logger.warn(undefined, "Subagent 配置初始化等待到期，继续启动并保留后台加载", {
              waitMs: INITIAL_LOAD_WAIT_MS,
            });
            resolve();
          }, INITIAL_LOAD_WAIT_MS);
        }),
      ]);
    } finally {
      // 只结束调用方等待，不中止共享加载或清除文件事件；销毁仍由 scope 负责取消。
      waiting = false;
      if (timer) clearTimeout(timer);
    }
    assertActive();
  }
  return {
// prepare 可重复调用：同 workspace 视为显式重启（重建监听并全量读取），
// 新 workspace 则复用 user/state 共享缓存，只新增 project scope。
    async prepare(workspace?: Workspace) {
      assertActive();
      const initializing: Scope<unknown>[] = [];
      const [userPath, statePath] = (
        await Promise.all([reader.readUserRoot(), reader.readStatePath()])
      ).map((path) => resolve(path)) as [string, string];
      assertActive();
// [资源] 重建前必须先 dispose 旧 scope：其 watcher 与定时器不会因为被覆盖而自动释放，
// 残留的 onSettled 还会继续向 snapshots 写旧 workspace 的结果。
      // 新 workspace 复用共享缓存；既有 workspace 的显式重启才重建监听并全量读取。
      const reload = !workspace || workspaces.has(key(workspace));
      if (!user || user.path !== userPath || reload) {
        user?.scope.dispose();
        user = { path: userPath, scope: documentScope(userPath, "user") };
        initializing.push(user.scope);
      }
// state 用准备时固定的绝对路径作为 root/file：运行中切换 storage root 会让监听指向旧目录，
// 之后的写入全部落在无人监听的位置，表现为「配置改了但不生效」。
      if (!state || state.path !== statePath || reload) {
        state?.scope.dispose();
        state = {
          path: statePath,
          scope: createSubagentConfigScope({
            root: dirname(statePath),
            file: statePath,
            // 使用准备时固定的路径，文件事件不重读 CLI 配置，也不切换到另一 storage root。
            load: async (_previous, _changes, context) => {
              await context.waitForStableFile(statePath);
              context.signal.throwIfAborted();
              return reader.readState(statePath);
            },
            onSettled: publish,
          }),
        };
        initializing.push(state.scope);
      }
      if (workspace) {
        const workspaceKey = key(workspace);
        workspaces.get(workspaceKey)?.dispose();
        const project = documentScope(join(workspace.workspacePath, ".zcode", "agents"), "project");
        workspaces.set(workspaceKey, project);
        initializing.push(project);
      }
// 只等待本次新建的 scope；复用的共享 scope 已在别的 prepare 里推进，重复等待没有意义。
      await waitForInitialScopes(initializing);
      publish();
      if (workspace && !snapshots.has(key(workspace)))
        snapshots.set(key(workspace), { kind: "built-in-fallback" });
    },
// read 永远返回完整快照：缺失时先补一次等待，仍缺失则写 built-in-fallback，绝不返回 undefined。
// structuredClone 隔离调用方与缓存（INV-03），代价是每次 RPC 一次深拷贝。
    async read(workspace: Workspace): Promise<SubagentRuntimeConfig> {
      const scopes = required(workspace);
      if (!snapshots.has(key(workspace))) {
        await waitForInitialScopes(scopes);
        publish();
        if (!snapshots.has(key(workspace)))
          snapshots.set(key(workspace), { kind: "built-in-fallback" });
      }
      const snapshot = snapshots.get(key(workspace));
      if (!snapshot) throw new Error("Subagent runtime configuration is not prepared");
      return structuredClone(snapshot);
    },
// [资源] dispose 顺序固定：先置 disposed 阻断后续 publish，再逐个取消 scope，最后清空容器；
// 若先清容器，scope 回调仍可能通过闭包写回已废弃的 map。
    dispose() {
      disposed = true;
      user?.scope.dispose();
      state?.scope.dispose();
      for (const scope of workspaces.values()) scope.dispose();
      workspaces.clear();
      snapshots.clear();
    },
  };
}
