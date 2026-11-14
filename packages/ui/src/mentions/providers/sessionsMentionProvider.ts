// INV-01 守住位置：SessionMentionItem 上的 workspaceKey 只在候选聚合阶段用于分桶，改错故障：把它写进 markdown 或 Lexical node 会让历史引用带上宿主内部键，跨工作区粘贴后指向错误会话。
// INV-02 守住位置：当前工作区优先只在 compareSessionTasks 内作为第一权重，改错故障：把权重挪到调用方或改成分桶顺序，会让同一份任务在不同 scope 下返回不同的首位候选。
// INV-03 守住位置：工作区归属判定统一复用 buildTaskWorkspaceKey 的归一化结果，改错故障：直接比较路径字符串会因分隔符与大小写差异把同一工作区判成两个。
// INV-04 守住位置：updatedAt 降序是主序，相等再比 createdAt，改错故障：跳过时间比较会让刚更新的会话沉到列表底部，用户按顺序找不到最近任务。
// INV-05 守住位置：标题 localeCompare 是最后的确定性兜底，改错故障：省略兜底会让同毫秒写入的会话在每次查询中交换位置并触发列表抖动。
// INV-06 守住位置：getSessionLabel 只剥离行首且要求前缀后跟空白的 #sess_ 片段，改错故障：把正则放宽到任意位置会误删用户标题中以该串开头的真实词。
// INV-07 守住位置：标题剥离后为空必须回退占位文案，改错故障：返回空串会让候选行不可读，还会让空查询匹配到全部会话。
// INV-08 守住位置：getWorkspaceLabel 优先取 workspacePath，缺失时才退回 identity，改错故障：直接用 identity 展示会把内部标识当成人类可读路径。
// INV-09 守住位置：候选 id 必须带 session: 前缀，改错故障：去掉前缀会与文件候选撞 id，同一 key 在列表中相互覆盖。
// INV-10 守住位置：markdown 与 label 必须同源于 getSessionLabel，改错故障：两处各自计算会让插入文本与候选显示不一致，甚至写入不同的会话标题。
// INV-11 守住位置：keywords 必须覆盖标题、任务 id、工作区、身份与模型，改错故障：漏字段会让模糊搜索召回下降，用户误以为会话不存在。
// INV-12 守住位置：去重以 taskId 为键并保留 updatedAt 最新的一条，改错故障：保留旧条目会产出 ghost session，点击后引用到已废弃状态。
// INV-13 守住位置：migrationSource 任务在去重之前整体跳过，改错故障：不过滤会让迁移镜像与真实任务争抢同一个 taskId，结果取决于遍历顺序。
// INV-14 守住位置：快照以 services 引用作为版本标识，改错故障：跨工作区复用旧树会把上一个工作区的任务混进当前候选。
// INV-15 守住位置：刷新用自增 generation 丢弃过期响应，改错故障：只靠布尔标记会让两次读树的返回交错写入，快照停留在旧请求。
// INV-16 守住位置：enabled 为假时立即清空快照，改错故障：保留旧快照会让面板隐藏期间仍持有 services 引用，并在下次打开时闪现陈旧数据。
// INV-17 守住位置：广播只响应 state:projects 通道，改错故障：订阅全量事件会让高频通道触发读树风暴，拖慢主线程。
// INV-18 守住位置：截断上限只作用于非当前工作区的分组，改错故障：对当前工作区同样限流会让历史会话在搜索中不可见，且用户无法察觉。
//
// 模块职责：把宿主任务树映射为会话候选，承担去重、scope 过滤、排序、分桶与截断，并向面板返回 items、groups、loading、error。
// 状态所有权：services 来自 useWorkspaceServicesResolution，树快照与 loading/error 归本 hook 所有，候选分组在 useMemo 中派生，传入的任务树按只读处理。
// 阅读顺序：先看类型与排序比较器，再看 collectSessionMentionItems 的聚合契约，最后看 hook 的订阅、竞态与失败回退。
import { useEffect, useMemo, useState } from "react";
import type { ProjectTree } from "@zcode/services";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { buildSessionMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import type { SessionMentionWorkspaceScope } from "@/mentions/mentionPanelRouting.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

// 类型扩展只服务于候选聚合阶段：workspaceKey 让同一批任务按工作区或项目分桶，
// 排序与去重仍由 taskId 与时间戳决定，因此它不能成为引用身份的一部分。
// 把它序列化进 markdown 或 Lexical node 会让历史会话在跨工作区迁移后被误判归属。
// 需要在界面展示工作区时读取 description，而不是直接暴露这个内部键。
interface SessionMentionItem extends MentionItem {
  /** 只在候选聚合阶段分桶，不写入 Lexical node 或 canonical mention。 */
  workspaceKey: string;
}

function compareSessionTasks(
  left: ZCodeTaskMeta,
  right: ZCodeTaskMeta,
  currentWorkspaceKey?: string,
) {
  // 当前工作区优先是排序的第一权重，且只在拿到 currentWorkspaceKey 时生效。
  // 没有可比较的键时整段跳过，保证无工作区上下文的调用方看到纯时间序。
  // 两边的归属判定必须复用 buildTaskWorkspaceKey 的归一化结果，
  // 否则分隔符与大小写差异会把同一工作区判成两侧，当前工作区的会话被排到后面。
  if (currentWorkspaceKey) {
    const leftCurrent =
      buildTaskWorkspaceKey(left.workspacePath, left.workspaceIdentity) === currentWorkspaceKey;
    const rightCurrent =
      buildTaskWorkspaceKey(right.workspacePath, right.workspaceIdentity) === currentWorkspaceKey;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
  }
  // 时间维度用降序：updatedAt 相同再比 createdAt，最后用标题做确定性兜底。
  // 缺少兜底会让同一毫秒写入的会话在每次查询中交换位置，触发列表抖动。
  // 这里返回的是差值语义，两个时间字段都必须是数值，不能被可选链兜底成 undefined。
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return left.title.localeCompare(right.title);
}

function getSessionLabel(task: ZCodeTaskMeta): string {
  // 会话标题可能带 #sess_ 前缀，这里只剥离行首且要求前缀后接空白，
  // 避免把用户真实标题中以该串开头的词误删。
  // 剥离后为空说明标题只有前缀或纯空白，回退占位文案以保证候选行可读可搜索。
  const title = task.title.replace(/^#sess_[a-zA-Z0-9._-]+\s*/, "").trim();
  return title || "Untitled session";
}

function getWorkspaceLabel(task: ZCodeTaskMeta): string {
  const raw = task.workspacePath.trim() || task.workspaceIdentity?.trim() || "";
  return raw.split(/[\\/]/).filter(Boolean).at(-1) ?? raw;
}

function mapTaskToMentionItem(task: ZCodeTaskMeta, provider: ZCodeProvider): SessionMentionItem {
  const sessionId = task.taskId;
  const itemProvider = task.provider ?? provider;
  return {
    id: `session:${task.taskId}`,
    category: "sessions",
    label: getSessionLabel(task),
    description: getWorkspaceLabel(task),
    value: sessionId,
    markdown: buildSessionMentionMarkdown(sessionId, getSessionLabel(task)),
    keywords: [
      task.title,
      task.taskId,
      task.workspacePath,
      task.workspaceIdentity ?? "",
      task.model ?? "",
      itemProvider,
    ],
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  };
}

export function collectSessionMentionItems(
  tasks: ZCodeTaskMeta[],
  provider: ZCodeProvider,
  options: {
    workspacePath?: string;
    workspaceIdentity?: string;
  } = {},
): SessionMentionItem[] {
  // 入口的可选参数决定比较键是否存在：只有拿到 workspacePath 才计算键，
  // 否则保持 undefined，让排序退化为纯时间序而不是抛错。
  // 这个键是一次调用内的稳定快照，tasks 后续变动不会回溯修改它，
  // 调用方必须在工作区切换后重新调用，不能缓存返回值跨工作区复用。
  const currentWorkspaceKey = options.workspacePath
    ? buildTaskWorkspaceKey(options.workspacePath, options.workspaceIdentity)
    : undefined;
  const taskBySessionId = new Map<string, ZCodeTaskMeta>();
  for (const task of tasks) {
    // migrationSource 标记的是迁移过程留下的镜像任务，不属于用户可引用的会话。
    // 直接跳过比在下游按字段过滤更省，也避免同 id 任务互相覆盖时选到镜像。
    // 跳过发生在去重之前，保证镜像不会占用该 taskId 的最新条目位置。
    if (task.migrationSource) {
      continue;
    }
    const sessionId = task.taskId;
    const current = taskBySessionId.get(sessionId);
    if (!current || task.updatedAt > current.updatedAt) {
      taskBySessionId.set(sessionId, task);
    }
  }

  // 去重保留 updatedAt 最大的一条，随后整体排序，再统一映射成候选行。
  // 排序必须先于映射，否则 workspaceKey 计算会重复执行且顺序不稳定。
  // 返回的是新建数组，调用方可安全排序或截断，不会影响内部 Map。
  return [...taskBySessionId.values()]
    .sort((left, right) => compareSessionTasks(left, right, currentWorkspaceKey))
    .map((task) => mapTaskToMentionItem(task, provider));
}

export function useSessionsMentionProvider(
  provider: ZCodeProvider,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  workspaceScope: SessionMentionWorkspaceScope,
  emptyText: string,
  title: string,
  unclassifiedTitle = title,
): MentionCategoryResult {
  // hook 只做编排：把工作区解析成 services，再把快照、分组与截断拼成结果。
  // services 解析可能异步完成，因此所有依赖它的状态都必须带身份校验。
  // 这里不缓存 services，工作区一变就应得到新的引用并触发 effect 重跑。
  const { services } = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const [snapshot, setSnapshot] = useState<{
    services: typeof services;
    tree: ProjectTree;
    error: Error | null;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    // enabled 为假表示面板未打开或查询未激活，此时主动清空快照，
    // 既释放对上一个 services 的引用，也避免旧数据在下次打开时闪现。
    // 清空后 loading 由返回值统一推导，不在状态里单独维护，
    // 否则会出现 enabled 已关闭但 loading 仍为 true 的僵死态。
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    let current = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      setSnapshot({ services, tree: { projects: [], tasks: [] }, error: null, loading: true });
      try {
        if (!services.projectService) throw new Error("project.service-unavailable");
        // 候选行由 Host 组织态与 CLI 镜像决定；不能让缺席的 sessions-index 或 tab 隐藏历史任务。
        const tree = await services.projectService.readTree({ includeDeleted: true });
        if (current && request === generation)
          setSnapshot({ services, tree, error: null, loading: false });
      // 读树失败必须落成 error 状态而不是向上抛出，面板才能展示重试入口。
      // 错误被规范成 Error 实例，保证下游取值一致，不会因字符串抛出而丢掉堆栈。
      // 失败时同时把树置空，避免用上一次成功的树冒充本次结果。
      } catch (error) {
        if (current && request === generation)
          setSnapshot({
            services,
            tree: { projects: [], tasks: [] },
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          });
      }
    };
    // 订阅广播是为了在宿主侧项目态变化时刷新候选，只对 state:projects 通道做出反应。
    // 刷新通过 generation 丢弃过期响应，连续事件不会产生交错写入。
    // 清理函数必须同时置 current 为假并释放监听，否则工作区切换会泄漏订阅。
    const listener = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    void refresh();
    return () => {
      current = false;
      listener.dispose();
    };
  }, [enabled, services]);
  const tree = snapshot?.services === services ? snapshot.tree : null;
  const groups = useMemo(() => {
    if (!tree) return [];
    const currentKey = buildTaskWorkspaceKey(workspacePath, workspaceIdentity);
    const visibleTasks = tree.tasks.filter(
      (task) =>
        workspaceScope !== "current-workspace" ||
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === currentKey,
    );
    const buckets = new Map<string, { id: string; title: string; tasks: ZCodeTaskMeta[] }>();
    for (const task of visibleTasks) {
      const id =
        workspaceScope === "current-workspace"
          ? "sessions"
          : JSON.stringify([task.hostId, task.projectId]);
      const project = tree.projects.find(
        (project) => project.id === task.projectId && project.hostId === task.hostId,
      );
      const bucket = buckets.get(id) ?? {
        id,
        title:
          workspaceScope === "current-workspace" ? title : (project?.name ?? unclassifiedTitle),
        tasks: [],
      };
      bucket.tasks.push(task);
      buckets.set(id, bucket);
    }
    return [...buckets.values()].map((bucket) => ({
      id: bucket.id,
      title: bucket.title,
      items: filterMentionItemsWithOptions(
        collectSessionMentionItems(bucket.tasks, provider),
        query,
        {
          limit: workspaceScope === "current-workspace" ? Number.POSITIVE_INFINITY : 20,
          requireQuery: false,
        },
      ),
    }));
  }, [
    tree,
    workspacePath,
    workspaceIdentity,
    workspaceScope,
    title,
    unclassifiedTitle,
    provider,
    query,
  ]);
  return {
    items: enabled ? groups.flatMap((group) => group.items) : [],
    groups: enabled && workspaceScope !== "current-workspace" ? groups : undefined,
    loading: enabled && (!snapshot || snapshot.services !== services || snapshot.loading),
    error: snapshot?.services === services ? snapshot.error : null,
    emptyText,
    title,
  };
}
