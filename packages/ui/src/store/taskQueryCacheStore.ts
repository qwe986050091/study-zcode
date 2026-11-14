// 文件头 · packages/ui/src/store/taskQueryCacheStore.ts —— 任务列表查询缓存的唯一 Zustand 事实源
// 职责边界：维护 queryKey → 结果索引（taskKeys/total/分页）、实体元数据（taskMetaByEntityKey）与 unread 覆盖层。
// 不负责：数据获取（hook 负责）、服务端 membership 判定（services 负责）、持久化（本 store 无持久化）。
// 读取约束：组件只通过 selector 订阅，不得整体替换 store 状态。
//
// 不变式（INV）：断言 ｜ 守住它的位置 ｜ 改错后的故障
// INV-01 断言 resultsByQueryKey 只按 queryKey 索引，store 不解析 key 语义 ｜ 位置 CachedTaskListResult / setQueryResult ｜ 改错 在 store 内拼 key 会与构造方分叉，查不到结果
// INV-02 断言 taskKeys 里的 key 必须能取到 meta 或明确是占位 ｜ 位置 sortTaskKeysByDescriptor 的缺 meta 分支 ｜ 改错 排序错乱且行渲染空白
// INV-03 断言 unread overlay 只在 query 发布同值后才释放 ｜ 位置 setQueryResult 的 hasUnreadOverlay 分支 ｜ 改错 旧回包把已读状态改回未读
// INV-04 断言 overlay 键存在（值为 null）与键不存在语义不同 ｜ 位置 setTaskUnreadOverlay 写入 null ｜ 改错 无法表达「清除未读」，下次回包又恢复
// INV-05 断言 republish 内容等价时必须保留旧引用 ｜ 位置 mergeIncomingTaskListItem / areCachedTaskListItemsEquivalent ｜ 改错 整列表行无效重渲染
// INV-06 断言 三者均未变化时 setState 返回原 state ｜ 位置 setQueryResult / setQueryResults 的等价短路 ｜ 改错 每次轮询都换引用，memo 全部失效
// INV-07 断言 fetchedAt/stale 不参与等价比较 ｜ 位置 isQueryResultEquivalent ｜ 改错 保留窗口被提前放大或缩小，语义漂移
// INV-08 断言 只保留本地更新时间新于上一轮快照的任务 ｜ 位置 preserveFreshLocalTaskKeys 的 updatedAt > fetchedAt ｜ 改错 旧刷新把刚创建的 task 从侧栏抹掉
// INV-09 断言 搜索结果列表不做本地 key 保留 ｜ 位置 preserveFreshLocalTaskKeys 的 descriptor.search 早返回 ｜ 改错 正文搜索结果被本地乐观插入污染
// INV-10 断言 stale 结果不参与等价短路 ｜ 位置 isQueryResultEquivalent 的 previous.stale 分支 ｜ 改错 已标记失效的结果被当成 fresh 复用
// INV-11 断言 invalidationVersion 只增不减 ｜ 位置 applyTaskMutation / markWorkspaceKeysStale 的 +1 ｜ 改错 在途查询误判为最新，写入过期结果
// INV-12 断言 expectedInvalidationVersion 不匹配时整条结果丢弃 ｜ 位置 setQueryResults 的版本比较 ｜ 改错 旧结果覆盖新状态并释放 overlay
// INV-13 断言 搜索列表的成员资格由服务端决定 ｜ 位置 applyTaskMutation 的 descriptor.search 分支 ｜ 改错 正文命中的会话被 title-only 规则误删
// INV-14 断言 meta 增量只重排已包含该任务的列表 ｜ 位置 updateTaskMetaPreservingMembership ｜ 改错 任务被错误地从 pinned 区移走
// INV-15 断言 entityKey 变化时必须删除旧键 ｜ 位置 applyTaskMutation 的 previousEntityKey !== nextEntityKey ｜ 改错 旧身份残留，出现重复行
// INV-16 断言 删除只对可见缓存命中的列表扣 total ｜ 位置 removeTask 的 taskKeys 过滤 ｜ 改错 折叠区隐藏项被重复扣减，计数漂移
// INV-17 断言 removeTask 返回是否真的从可见缓存删除 ｜ 位置 removeTask 的 removedFromVisibleCache ｜ 改错 调用方误以为删成功，跳过刷新
// INV-18 断言 空 workspaceKeys 是 no-op ｜ 位置 markWorkspaceKeysStale / invalidateWorkspaceKeys 早返回 ｜ 改错 产生无意义新引用，触发全量重渲染
// INV-19 断言 所有状态变更必须经 set 写回 ｜ 位置 clearAll ｜ 改错 只返回对象不生效，旧 meta 继续残留
// INV-20 断言 archived 生命周期事件只在 false→true 触发 ｜ 位置 applyTaskQueryCacheMutation 的条件 ｜ 改错 重复归档/取消归档发出错误事件
// INV-21 断言 诊断只统计键数量 ｜ 位置 uiMemoryDiagnosticsRegistry.register ｜ 改错 遍历 meta 会在诊断时引入 O(n) 开销
// INV-22 断言 workspaceKey 由 entityKey 前缀解析，分隔符不可改 ｜ 位置 invalidateWorkspaceKeys 的 split ｜ 改错 失效匹配不到任何缓存，内存只增不减
/* eslint-disable max-lines -- task query cache 的 descriptor、membership 与 mutation 必须在同一 Zustand 事务里维护，拆散会增加缓存一致性风险。 */
import { create } from "zustand";
import type { ZCodeTaskListItem } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { getTaskListRowActivity, mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import {
  buildTaskEntityKey,
  buildTaskWorkspaceKey,
  type CachedTaskListResult,
  type TaskListCacheDescriptor,
  type TaskEntityKey,
  type TaskListCacheKey,
} from "@/lib/taskQueryCache.js";
import { notifyTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TaskListMembershipState {
  pinned: boolean;
  archived: boolean;
}

// [契约] 本接口是 UI 侧唯一的任务缓存事实源，hook 只能读写这里声明的字段。
// [失败路径] 在 hook 内另存一份 task 列表会与服务端 membership 产生第二事实源。
// [契约] 实体缓存与结果索引分离：同一 task 只存一份 meta，多个列表共享引用。
// [失败路径] 把 meta 内联进 result.taskKeys 会让改名要改 N 份，且引用去重失效。
// [契约] overlay 单列一张表，避免把乐观值写进 meta 后被 republish 覆盖。
interface TaskQueryCacheState {
  resultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult>;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  /** 覆盖正在提交或等待 membership 确认的 unreadAt 字段；null 表示清除。 */
  taskUnreadOverlayByEntityKey: Record<TaskEntityKey, number | null>;
  setQueryResult: (params: {
    queryKey: TaskListCacheKey;
    descriptor: TaskListCacheDescriptor;
    items: CachedTaskListItem[];
    total: number;
    hasMore: boolean;
    unreadTaskKeys?: TaskEntityKey[];
    partial?: boolean;
    loadingShardKeys?: string[];
    failedShardKeys?: string[];
  }) => void;
  setQueryResults: (
    entries: Array<{
      queryKey: TaskListCacheKey;
      descriptor: TaskListCacheDescriptor;
      items: CachedTaskListItem[];
      total: number;
      hasMore: boolean;
      unreadTaskKeys?: TaskEntityKey[];
      partial?: boolean;
      loadingShardKeys?: string[];
      failedShardKeys?: string[];
      /** 该异步查询启动时观察到的 invalidationVersion；不匹配时整条结果丢弃。 */
      expectedInvalidationVersion?: number;
    }>,
  ) => void;
  upsertTaskMeta: (task: ZCodeTaskMeta) => void;
  updateTaskMetaPreservingMembership: (task: ZCodeTaskMeta) => void;
  applyTaskMutation: (params: {
    previousTask: ZCodeTaskMeta;
    nextTask: ZCodeTaskMeta;
    previousState: TaskListMembershipState;
    nextState: TaskListMembershipState;
  }) => void;
  setTaskUnreadOverlay: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  reconcileTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  rollbackTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  removeTask: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  markWorkspaceKeysStale: (workspaceKeys: string[]) => void;
  invalidateWorkspaceKeys: (workspaceKeys: string[]) => void;
  clearAll: () => void;
}

// [契约] searchSnippets 是搜索命中的附加片段，不属于服务端 task 字段。
// [失败路径] 把它写回 ZCodeTaskMeta 会污染实体身份比较，产生无意义引用变化。
// [权衡] 用可选字段而不是并行 map，换取与 task 一起做引用等价判断。
type CachedTaskListItem = ZCodeTaskListItem & { searchSnippets?: string[] };

// [契约] fetchedAt 在此统一取 Date.now()，preserve 窗口以它为基准。
// [失败路径] 由调用方传入 fetchedAt 会让延迟返回的响应把窗口往回拨。
// [契约] invalidationVersion 缺省 0，表示「无失效」而不是「未知」。
// [契约] stale 恒为 false：新建结果必然是 fresh，标脏只能走失效路径。
// [失败路径] 在这里继承旧 stale 会让新结果一出生就不可用。
function buildCachedTaskListResult(params: {
  descriptor: TaskListCacheDescriptor;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial?: boolean;
  loadingShardKeys?: string[];
  failedShardKeys?: string[];
  invalidationVersion?: number;
}): CachedTaskListResult {
  return {
    taskKeys: params.taskKeys,
    unreadTaskKeys: params.unreadTaskKeys,
    searchSnippetsByTaskKey: params.searchSnippetsByTaskKey,
    searchSnippetListsByTaskKey: params.searchSnippetListsByTaskKey,
    total: params.total,
    hasMore: params.hasMore,
    fetchedAt: Date.now(),
    invalidationVersion: params.invalidationVersion ?? 0,
    stale: false,
    partial: params.partial ?? false,
    loadingShardKeys: params.loadingShardKeys ?? [],
    failedShardKeys: params.failedShardKeys ?? [],
    descriptor: params.descriptor,
  };
}

// [契约] workspace 描述符在 membership 维度等价于 timeline。
// [失败路径] 直接透传 workspace 给 matchesTaskListMembershipKind 会匹配失败。
// [契约] 判定逻辑集中在 shared 的实现，store 不复制一份规则。
// [失败路径] 本地重写 subject/pinned 规则会与服务端分页口径不一致。
function matchesTaskMembership(
  descriptor: TaskListCacheDescriptor,
  membership: TaskListMembershipState,
): boolean {
  const kind = descriptor.kind === "workspace" ? "timeline" : descriptor.kind;
  return matchesTaskListMembershipKind(membership, kind);
}

// [契约] 无 search 时恒匹配；有 search 时只比 title 的小写包含。
// [失败路径] 这条规则不能用于正文搜索的成员判定，见 applyTaskMutation 的分支。
// [契约] descriptor.search 必须是已小写的查询串，构造方负责归一化。
// [失败路径] 在每次比较里再 toLowerCase 查询串会放大 O(n) 成本。
function matchesTaskSearch(descriptor: TaskListCacheDescriptor, task: ZCodeTaskMeta): boolean {
  if (!descriptor.search) {
    return true;
  }

  return task.title.toLocaleLowerCase().includes(descriptor.search);
}

// [契约] 三个维度与关系：workspaceKeys 命中 且 membership 命中 且 search 命中。
// [失败路径] 用或关系会让任务出现在不相关的 workspace 列表里。
// [契约] workspaceKey 由 buildTaskWorkspaceKey 统一构造（identity 优先，path 兜底）。
// [失败路径] 手写 path 比较会让远程 identity 相同的任务匹配不上。
// [权衡] 每次全量判定而非索引，任务量级下可接受，换取实现简单。
function matchesTaskDescriptor(
  descriptor: TaskListCacheDescriptor,
  task: ZCodeTaskMeta,
  membership: TaskListMembershipState,
): boolean {
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  if (!descriptor.workspaceKeys.includes(workspaceKey)) {
    return false;
  }

  return matchesTaskMembership(descriptor, membership) && matchesTaskSearch(descriptor, task);
}

// [契约] 先 Set 去重，再排序：重复 key 会让 React 列表出现重复行。
// [失败路径] 不去重时同 key 的两次出现会共享同一 meta，视觉上重复。
// [契约] 缺 meta 的 key 排在末尾，两侧都缺时按 key 字典序保证稳定。
// [失败路径] 缺 meta 时返回 0 会让排序随输入顺序抖动。
// [契约] 实际比较委托 compareZCodeTaskListItems，按 descriptor.sortBy 分流。
function sortTaskKeysByDescriptor(params: {
  taskKeys: TaskEntityKey[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): TaskEntityKey[] {
  const uniqueTaskKeys = [...new Set(params.taskKeys)];
  return uniqueTaskKeys.sort((leftKey, rightKey) => {
    const leftTask = params.taskMetaByEntityKey[leftKey];
    const rightTask = params.taskMetaByEntityKey[rightKey];
    if (!leftTask && !rightTask) {
      return leftKey.localeCompare(rightKey);
    }
    if (!leftTask) {
      return 1;
    }
    if (!rightTask) {
      return -1;
    }
    return compareZCodeTaskListItems(leftTask, rightTask, params.descriptor.sortBy);
  });
}

// republish（membership 重拉、sessions-index 帧）产出的 item 都是全新对象引用。
// 内容没变时如果照样换引用，taskMetaByEntityKey 和派生 items memo 会整列表换新，
// 所有列表行无效重渲染。这里做逐字段等价判断，等价则保留旧引用。
// 嵌套字段（lastError/target 等）用 JSON 比较；task meta 是小对象，代价可接受。
// [契约] 逐字段比较；对象字段用 JSON 比较，因为 task meta 是小对象。
// [失败路径] 只用 === 比较对象会永远判定不等，引用保持失效。
// [契约] 键数量不同直接判不等，避免漏比较新增字段。
// [失败路径] 只比较左值存在的键会漏掉右侧新增字段，产生假等价。
// [权衡] JSON.stringify 依赖键顺序；同源对象键序稳定，跨源需谨慎。
// [失败路径] 对含函数/循环引用的字段用 JSON 比较会抛错。
function areCachedTaskListItemsEquivalent(
  left: CachedTaskListItem,
  right: CachedTaskListItem,
): boolean {
  if (left === right) {
    return true;
  }
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (leftValue === rightValue) {
      continue;
    }
    if (
      typeof leftValue === "object" &&
      leftValue !== null &&
      typeof rightValue === "object" &&
      rightValue !== null
    ) {
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

// [契约] 搜索结果的 incoming 可能缺 sessions-index 的 activity，需要从旧值补齐。
// [失败路径] 不补会让用户一输入搜索词，running/等待确认就消失。
// [契约] 非搜索列表不能按 tasks-index updatedAt 做 whole-meta winner。
// [失败路径] 否则 rename/unread 响应会覆盖实时 phase/lastActivityAt。
// [契约] 标题只在 incoming 是占位（空或 new session）时才沿用旧值。
// [契约] 最后做引用等价判断：等价则返回 existingItem，让下游 memo 短路。
function mergeIncomingTaskListItem(params: {
  item: CachedTaskListItem;
  existingItem: CachedTaskListItem | undefined;
  descriptor: TaskListCacheDescriptor;
  hasUnreadOverlay: boolean;
  unreadAtOverlay: number | null | undefined;
}): CachedTaskListItem {
  const incomingActivity = getTaskListRowActivity(params.item);
  const existingActivity = params.existingItem ? getTaskListRowActivity(params.existingItem) : null;
  // 搜索结果来自 tasks-index，但实体缓存可能已有 sessions-index activity。
  // 合并时保留 sidecar，否则用户一输入搜索词，running/等待确认就会消失。
  const incomingWithActivity =
    params.descriptor.search && params.existingItem && existingActivity && !incomingActivity
      ? (mergeTaskListMembershipFields(params.existingItem, params.item) as CachedTaskListItem)
      : params.item;
  const keepExistingNonPlaceholderTitle =
    params.existingItem &&
    incomingActivity &&
    (params.item.title.trim().length === 0 ||
      params.item.title.trim().toLocaleLowerCase() === "new session") &&
    params.existingItem.title.trim().length > 0 &&
    params.existingItem.title.trim().toLocaleLowerCase() !== "new session";
  // 非搜索列表的 incoming item 是 sessions-index activity + 最新 membership join，
  // 不能再按 tasks-index updatedAt 做 whole-meta winner；否则 rename/unread 响应会覆盖实时
  // phase/lastActivityAt。只保留 sessions-index 尚未补齐时的首发标题和非 activity 展示字段。
  const mergedItem = params.descriptor.search
    ? incomingWithActivity
    : ({
        ...incomingWithActivity,
        ...(keepExistingNonPlaceholderTitle ? { title: params.existingItem?.title } : {}),
        changeSummary: incomingWithActivity.changeSummary ?? params.existingItem?.changeSummary,
        model: incomingWithActivity.model ?? params.existingItem?.model,
        provider: incomingWithActivity.provider ?? params.existingItem?.provider,
      } as CachedTaskListItem);
  const itemWithUnreadOverlay = params.hasUnreadOverlay
    ? ({
        ...mergedItem,
        unreadAt: params.unreadAtOverlay ?? undefined,
      } as CachedTaskListItem)
    : mergedItem;
  const nextItem =
    params.descriptor.search || !params.existingItem?.searchSnippet
      ? itemWithUnreadOverlay
      : {
          ...itemWithUnreadOverlay,
          searchSnippet: params.existingItem.searchSnippet,
          searchSnippets: params.existingItem.searchSnippets,
        };
  // 引用保持：合并结果与现值等价时沿用旧对象，让下游 memo/浅比较短路。
  return params.existingItem && areCachedTaskListItemsEquivalent(nextItem, params.existingItem)
    ? params.existingItem
    : nextItem;
}

// republish 内容与现缓存完全等价时，直接跳过整个 setState，
// 避免 resultsByQueryKey/taskMetaByEntityKey 换新引用引发全列表无效重渲染。
// fetchedAt/stale 不参与比较（保留旧值不影响正确性，preserve 窗口只会更保守）。
// [契约] previous 不存在或已 stale 时直接判不等，强制写入新结果。
// [失败路径] 对 stale 结果判等价会让失效标记永远清不掉。
// [契约] total/hasMore/partial 任一不同即不等。
// [契约] taskKeys 逐位比较，顺序不同也算不同（顺序即展示顺序）。
// [失败路径] 用集合比较会漏掉排序变化，UI 顺序不更新。
// [契约] 搜索片段用 JSON 比较：键集合与内容都要一致才算等价。
function isQueryResultEquivalent(params: {
  previousResult: CachedTaskListResult | undefined;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
}): boolean {
  const previous = params.previousResult;
  if (!previous || previous.stale) {
    return false;
  }
  if (
    previous.total !== params.total ||
    previous.hasMore !== params.hasMore ||
    previous.partial !== params.partial
  ) {
    return false;
  }
  if (
    previous.taskKeys.length !== params.taskKeys.length ||
    previous.taskKeys.some((taskKey, index) => taskKey !== params.taskKeys[index])
  ) {
    return false;
  }
  const sameStringArray = (left: string[], right: string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  if (
    !sameStringArray(previous.unreadTaskKeys ?? [], params.unreadTaskKeys ?? []) ||
    !sameStringArray(previous.loadingShardKeys, params.loadingShardKeys) ||
    !sameStringArray(previous.failedShardKeys, params.failedShardKeys)
  ) {
    return false;
  }
  return (
    JSON.stringify(previous.searchSnippetsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetsByTaskKey ?? null) &&
    JSON.stringify(previous.searchSnippetListsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetListsByTaskKey ?? null)
  );
}

// [契约] 无上一轮结果或是搜索列表时不做保留，直接返回 incoming。
// [失败路径] 搜索列表保留本地 key 会让正文搜索出现未命中的行。
// [契约] 只保留 updatedAt 严格大于上一轮 fetchedAt 的任务。
// [失败路径] 用 >= 会把同一批次的旧任务反复保留，列表不再收缩。
// [契约] 保留后再排序并按 visibleLimit 截断，保持与分页一致。
// [契约] preservedCount 供上层放大 total/hasMore，避免计数小于可见行数。
function preserveFreshLocalTaskKeys(params: {
  incomingTaskKeys: TaskEntityKey[];
  previousResult: CachedTaskListResult | undefined;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): { taskKeys: TaskEntityKey[]; preservedCount: number } {
  if (!params.previousResult || params.descriptor.search) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const previousResult = params.previousResult;
  const incomingTaskKeySet = new Set(params.incomingTaskKeys);
  const preservedTaskKeys = previousResult.taskKeys.filter((taskKey) => {
    if (incomingTaskKeySet.has(taskKey)) {
      return false;
    }
    const task = params.taskMetaByEntityKey[taskKey];
    return Boolean(task && task.updatedAt > previousResult.fetchedAt);
  });
  if (preservedTaskKeys.length === 0) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const sortedTaskKeys = sortTaskKeysByDescriptor({
    // sqlite 列表刷新可能晚于首发 optimistic 插入。
    // 只有本地更新时间新于上一轮列表快照的 key 才临时保留，避免旧刷新把新 task 从侧栏抹掉。
    taskKeys: [...params.incomingTaskKeys, ...preservedTaskKeys],
    taskMetaByEntityKey: params.taskMetaByEntityKey,
    descriptor: params.descriptor,
  });
  const visibleTaskKeys =
    params.descriptor.visibleLimit === null
      ? sortedTaskKeys
      : sortedTaskKeys.slice(0, params.descriptor.visibleLimit);
  return {
    taskKeys: visibleTaskKeys,
    preservedCount: preservedTaskKeys.length,
  };
}

// [契约] 整个 store 只有一个 create；多实例会让不同窗口/入口看到不同缓存。
// [失败路径] 在测试里直接 new store 会绕过订阅，症状与生产不一致。
// [契约] 初始三张表都为空对象，不使用 undefined，简化读取分支。
// [失败路径] 用 undefined 初始化会让每个 action 都要判空，容易漏。
// [契约] 所有 action 内部只调用 set，不产生外部副作用。
export const useTaskQueryCacheStore = create<TaskQueryCacheState>()((set) => ({
  resultsByQueryKey: {},
  taskMetaByEntityKey: {},
  taskUnreadOverlayByEntityKey: {},
  // [事务] 单次 set 内同时完成：实体合并、overlay 释放、结果索引重建。
  // [失败路径] 拆成多次 set 会让订阅者观察到「新列表 + 旧 meta」的中间态。
  // [契约] 只有确实改动的表才换新引用，未改动的表沿用 state 上的旧对象。
  // [失败路径] 无条件展开复制会让未改动的表也换引用，触发全量重渲染。
  // [契约] 等价短路时 return state，Zustand 不会再通知订阅者。
  // [契约] searchSnippets 只从本次 incoming 收集，不从旧缓存回填。
  setQueryResult: ({
    queryKey,
    descriptor,
    items,
    total,
    hasMore,
    unreadTaskKeys,
    partial,
    loadingShardKeys,
    failedShardKeys,
  }) =>
    set((state) => {
      // [契约] 先浅拷贝再按需改，保证 set 返回的对象与旧 state 不共享被改的键。
      // [失败路径] 直接改 state.taskMetaByEntityKey 会原地污染旧快照，撤销/回放失效。
      // [契约] 拷贝是惰性的：没有任何 meta 变化时最终仍返回旧引用。
      // [失败路径] 拷贝后不回退引用，会让等价短路形同虚设。
      // [契约] 该对象只在本 set 回调内可见，不逃逸到闭包外。
      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      // [契约] 片段表只收集本次 incoming 中确实带 searchSnippet 的项。
      // [失败路径] 无条件为每条 item 写空串，会让等价比较永远判定变化。
      // [契约] 为空时上层传 undefined，保持结果对象形状稳定。
      // [失败路径] 传空对象会让 JSON 比较产生与 undefined 不同的结果。
      const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
      const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
      // [契约] 顺序即服务端返回顺序，后续只做保留与排序，不重排原始顺序。
      // [失败路径] 在此去重会丢掉「同 key 多行」的异常信号，掩盖服务端问题。
      // [契约] 每条 item 同步合并 meta，返回的 entityKey 用于结果索引。
      // [失败路径] 用异步 map 会让 merge 顺序不确定，overlay 释放结果不稳定。
      // [契约] hasUnreadOverlay 用 hasOwnProperty 判断，能区分 null 与不存在。
      // [契约] overlay 释放条件：query 发布的值与 overlay 值一致（或同为无值）。
      const incomingTaskKeys = items.map((item) => {
        const entityKey = buildTaskEntityKey(item);
        if (item.searchSnippet) {
          searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
        }
        if (item.searchSnippets?.length) {
          searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
        }
        // [契约] 必须从本轮已改动的树上取，保证同一批内后续条目看到前面的合并结果。
        // [失败路径] 从 state 原表取会让同批重复 key 丢弃前一次的 overlay 释放。
        // [契约] 取不到时 undefined，由合并函数按「无旧值」处理。
        // [失败路径] 用默认空对象会让等价比较误判为「有旧值且不等」。
        const existingItem = nextTaskMetaByEntityKey[entityKey];
        const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
          state.taskUnreadOverlayByEntityKey,
          entityKey,
        );
        const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
        const mergedItem = mergeIncomingTaskListItem({
          item,
          existingItem,
          descriptor,
          hasUnreadOverlay,
          unreadAtOverlay,
        });
        if (
          hasUnreadOverlay &&
          (unreadAtOverlay === null
            ? typeof item.unreadAt !== "number"
            : item.unreadAt === unreadAtOverlay)
        ) {
          // RPC 成功不等于所有在途 membership 查询都已更新。
          // overlay 只有在 query 真正发布出同一字段值后才可释放，旧回包前后都不能覆盖新状态。
          delete nextTaskUnreadOverlayByEntityKey[entityKey];
          taskUnreadOverlayChanged = true;
        }
        // [契约] 只有引用变化才写回并标记 taskMetaChanged。
        // [失败路径] 无条件写回会让等价短路失效，每轮都换整张表。
        // [契约] 该判断依赖 mergeIncomingTaskListItem 的引用保持语义。
        // [失败路径] 若合并总是返回新对象，这里的优化完全不生效。
        if (mergedItem !== existingItem) {
          taskMetaChanged = true;
          nextTaskMetaByEntityKey[entityKey] = mergedItem;
        }
        return entityKey;
      });
      // [契约] 保留逻辑在合并 meta 之后执行：它需要读到最新的 updatedAt。
      // [失败路径] 在合并前保留会用到旧 meta 的 updatedAt，判断失真。
      // [契约] 传入 nextTaskMetaByEntityKey 而非 state 上的旧表。
      // [失败路径] 传旧表会让刚写入的乐观任务因取不到 meta 而不被保留。
      // [契约] previousResult 取同一个 queryKey 的上一轮结果。
      const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
        incomingTaskKeys,
        previousResult: state.resultsByQueryKey[queryKey],
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        descriptor,
      });

      // [契约] total 在保留本地任务时取三者最大值，避免出现 total < 可见行数。
      // [失败路径] 直接用服务端 total 会让侧栏显示「3 条」却有 4 行。
      // [契约] hasMore 同理，保留场景下以「可见行数 < 计数」为准。
      // [契约] invalidationVersion 沿用旧值：republish 不是失效事件。
      // [失败路径] 每次 republish 自增会让在途查询全部被判过期。
      const resultParams = {
        descriptor,
        taskKeys,
        unreadTaskKeys,
        searchSnippetsByTaskKey:
          Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
        searchSnippetListsByTaskKey:
          Object.keys(searchSnippetListsByTaskKey).length > 0
            ? searchSnippetListsByTaskKey
            : undefined,
        total:
          preservedCount > 0
            ? Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length)
            : total,
        hasMore:
          hasMore ||
          (preservedCount > 0 &&
            Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length) >
              taskKeys.length),
        partial,
        loadingShardKeys,
        failedShardKeys,
        invalidationVersion: state.resultsByQueryKey[queryKey]?.invalidationVersion ?? 0,
      };
      // 内容与现缓存完全等价时跳过 setState，republish 不再引发全列表无效重渲染。
      if (
        !taskMetaChanged &&
        !taskUnreadOverlayChanged &&
        isQueryResultEquivalent({
          previousResult: state.resultsByQueryKey[queryKey],
          taskKeys,
          unreadTaskKeys: resultParams.unreadTaskKeys,
          searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
          searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
          total: resultParams.total,
          hasMore: resultParams.hasMore,
          partial: partial ?? false,
          loadingShardKeys: loadingShardKeys ?? [],
          failedShardKeys: failedShardKeys ?? [],
        })
      ) {
        return state;
      }

      return {
        resultsByQueryKey: {
          ...state.resultsByQueryKey,
          [queryKey]: buildCachedTaskListResult(resultParams),
        },
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  // [事务] 批量版本：多次查询共享一次 set，订阅者只收到一次通知。
  // [失败路径] 逐条调用 setQueryResult 会触发 N 次渲染，且中间态互相覆盖。
  // [契约] 空数组直接 return state，不产生任何新引用。
  // [失败路径] 空数组也构造新对象会让每次轮询都刷新整棵树。
  // [契约] 各 entry 独立做版本校验与等价短路，互不影响。
  // [契约] 最终只要有任意一类变化就整体写入，否则返回原 state。
  setQueryResults: (entries) =>
    set((state) => {
      if (entries.length === 0) {
        return state;
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      // [契约] 先整体浅拷贝，再按 queryKey 替换需要重排的条目。
      // [失败路径] 原地改 result 会污染仍被订阅者持有的旧快照。
      // [契约] 未命中该任务的列表保持原 result 引用不变。
      // [契约] 该表只在本 set 回调内使用，不跨调用复用。
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let resultsChanged = false;

      for (const entry of entries) {
        const previousResult = state.resultsByQueryKey[entry.queryKey];
        // [契约] 用 `expected` 与当前版本比对，不一致就判过期并丢弃结果。
        // [失败路径] 用写入后的版本比较会永远相等，过期结果照样落地。
        // [契约] previousResult 缺失时版本为 0，与未提供 expected 的调用兼容。
        // [失败路径] 缺失时返回 undefined 会让 undefined !== 0，误丢首屏结果。
        // [契约] 版本不匹配时 continue，不写 entity、不释放 overlay。
        const currentInvalidationVersion = previousResult?.invalidationVersion ?? 0;
        if (
          entry.expectedInvalidationVersion !== undefined &&
          entry.expectedInvalidationVersion !== currentInvalidationVersion
        ) {
          // sessions-index activity 与 tasks-index membership 是异步 join。
          // 在途期间再次失效时，旧结果不能写 entity、释放 unread overlay 或把 query 标 fresh；
          // hook 会按最新 activity/membership revision 自动重算。
          continue;
        }
        const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
        const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
        // [契约] 每条 entry 使用自己的 descriptor 合并 meta，不能用批内第一条的。
        // [失败路径] 复用同一 descriptor 会让搜索条目按非搜索规则补齐 activity。
        // [契约] searchSnippets 按 entry 独立收集，随后写入该 queryKey 的结果。
        // [失败路径] 跨 entry 合并片段会把 A 查询的高亮塞进 B 查询。
        // [契约] 同一 entityKey 在多个 entry 中出现时，以最后一次合并结果为准。
        const incomingTaskKeys = entry.items.map((item) => {
          const entityKey = buildTaskEntityKey(item);
          if (item.searchSnippet) {
            searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
          }
          if (item.searchSnippets?.length) {
            searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
          }
          const existingItem = nextTaskMetaByEntityKey[entityKey];
          const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
            state.taskUnreadOverlayByEntityKey,
            entityKey,
          );
          const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
          const mergedItem = mergeIncomingTaskListItem({
            item,
            existingItem,
            descriptor: entry.descriptor,
            hasUnreadOverlay,
            unreadAtOverlay,
          });
          if (
            hasUnreadOverlay &&
            (unreadAtOverlay === null
              ? typeof item.unreadAt !== "number"
              : item.unreadAt === unreadAtOverlay)
          ) {
            delete nextTaskUnreadOverlayByEntityKey[entityKey];
            taskUnreadOverlayChanged = true;
          }
          if (mergedItem !== existingItem) {
            taskMetaChanged = true;
            nextTaskMetaByEntityKey[entityKey] = mergedItem;
          }
          return entityKey;
        });
        const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
          incomingTaskKeys,
          previousResult,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: entry.descriptor,
        });

        const resultParams = {
          descriptor: entry.descriptor,
          taskKeys,
          unreadTaskKeys: entry.unreadTaskKeys,
          searchSnippetsByTaskKey:
            Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
          searchSnippetListsByTaskKey:
            Object.keys(searchSnippetListsByTaskKey).length > 0
              ? searchSnippetListsByTaskKey
              : undefined,
          total:
            preservedCount > 0
              ? Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length)
              : entry.total,
          hasMore:
            entry.hasMore ||
            (preservedCount > 0 &&
              Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length) > taskKeys.length),
          partial: entry.partial,
          loadingShardKeys: entry.loadingShardKeys,
          failedShardKeys: entry.failedShardKeys,
          invalidationVersion: currentInvalidationVersion,
        };
        // 与单条 setQueryResult 同一等价短路——内容没变的条目保留旧结果引用。
        if (
          isQueryResultEquivalent({
            previousResult,
            taskKeys,
            unreadTaskKeys: resultParams.unreadTaskKeys,
            searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
            searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
            total: resultParams.total,
            hasMore: resultParams.hasMore,
            partial: entry.partial ?? false,
            loadingShardKeys: entry.loadingShardKeys ?? [],
            failedShardKeys: entry.failedShardKeys ?? [],
          })
        ) {
          continue;
        }
        resultsChanged = true;
        nextResultsByQueryKey[entry.queryKey] = buildCachedTaskListResult(resultParams);
      }

      if (!taskMetaChanged && !resultsChanged && !taskUnreadOverlayChanged) {
        return state;
      }

      return {
        resultsByQueryKey: resultsChanged ? nextResultsByQueryKey : state.resultsByQueryKey,
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  // [契约] 用于 raw session snapshot / 单条推送，不重排任何列表。
  // [失败路径] 顺手重排会让未完成的分页结果顺序突变。
  // [契约] 必须与已有 meta 合并，保留 titleOverridden 等手动事实。
  // [失败路径] 直接覆盖会让重启恢复时 snapshot 抹掉用户手动标题。
  // [契约] 已有 sessions-index activity 时以 activity 一侧为基准合并 membership。
  // [失败路径] 反之会让列表行的 activity 字段被空 snapshot 清空。
  upsertTaskMeta: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // 重启恢复时 raw session snapshot 可能先于列表刷新写入 query cache。
      // 这里必须和已有 indexed meta 合并，避免缺少 titleOverridden 的 snapshot 把用户手动标题覆盖掉。
      // [契约] 合并优先级由 mergeTaskMetaCandidates 统一决定，store 不覆盖。
      // [失败路径] 在 store 内再加一层字段优先级会与其它写入路径分叉。
      // [契约] 合并返回 undefined 时回落 incoming task，保证总有值。
      // [失败路径] 回落成 existingTask 会让空推送无法清空过期字段。
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      const nextTask = getTaskListRowActivity(task)
        ? mergeTaskListMembershipFields(task, mergedTask)
        : existingTask
          ? mergeTaskListMembershipFields(existingTask, mergedTask)
          : mergedTask;
      return {
        ...state,
        taskMetaByEntityKey: {
          ...state.taskMetaByEntityKey,
          [entityKey]: nextTask,
        },
      };
    }),
  // [契约] 只更新 meta 并重排「已经包含该任务」的列表，不改变成员资格。
  // [失败路径] 重新做 membership 判定会把任务从 pinned 区移走。
  // [契约] 保留已存在的手动重命名，新 meta 只补 status/updatedAt 等运行态。
  // [失败路径] 用 incoming 覆盖 title 会让 rename 后的名字被列表刷新回滚。
  // [契约] 重排只复用原 descriptor，不重新计算 visibleLimit 之外的成员。
  // [契约] 未包含该 task 的列表原样保留引用，避免无意义重渲染。
  updateTaskMetaPreservingMembership: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // workspace_task_list_changed 可能携带 runtime snapshot 投影标题。
      // 保留 query cache 里已存在的手动重命名事实源，只用新 meta 补 status/updatedAt 等运行态字段。
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      // workspace_task_list_changed 带来的 tasks-index updatedAt
      // 只是 metadata 更新，不是用户真实会话活动。已有 sessions-index sidecar 时
      // 只合并 membership/meta 字段，否则 rename/unread 会让任务错误跳到顶部。
      // [契约] 无新 activity 时以 existingTask 为基准，只补 incoming 的 membership。
      // [失败路径] 反过来以 incoming 为基准会把 activity 字段清空。
      // [契约] 有 activity 时以 incoming 为基准，因为它才是最新的行状态。
      // [失败路径] 两种基准混用会让 running 状态偶发消失。
      const nextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, mergedTask)
        : mergedTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [entityKey]: nextTask,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          continue;
        }

        // workspace_task_list_changed 的 meta 增量只说明任务内容/状态变化，
        // 不代表 pinned/archived 成员关系变化；因此只重排已经包含该任务的列表，不能把它从 pinned 区移走。
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: sortTaskKeysByDescriptor({
            taskKeys: result.taskKeys,
            taskMetaByEntityKey: nextTaskMetaByEntityKey,
            descriptor: result.descriptor,
          }),
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  // [契约] 乐观更新入口：一次 set 内完成实体换键、列表增删与计数调整。
  // [失败路径] 拆成多步会让 UI 先看到「旧键已删、新键未入」的空窗。
  // [契约] previousEntityKey === nextEntityKey 时不删键，只覆盖 meta。
  // [失败路径] 无条件 delete 会把刚写入的新 meta 立刻删掉。
  // [契约] 搜索列表只标脏 + 版本自增，由 hook 回源重查。
  // [失败路径] 在本地按 title 重算搜索结果会把正文命中误删。
  applyTaskMutation: ({ previousTask, nextTask, previousState, nextState }) =>
    set((state) => {
      const previousEntityKey = buildTaskEntityKey(previousTask);
      const nextEntityKey = buildTaskEntityKey(nextTask);
      const existingTask =
        state.taskMetaByEntityKey[nextEntityKey] ?? state.taskMetaByEntityKey[previousEntityKey];
      const mergedNextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, nextTask)
        : nextTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [nextEntityKey]: mergedNextTask,
      };
      if (previousEntityKey !== nextEntityKey) {
        delete nextTaskMetaByEntityKey[previousEntityKey];
      }

      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (result.descriptor.search) {
          // 正文搜索结果由服务端 sqlite searchable_text 决定，前端缓存只有 task meta/title，
          // 不能用 title-only 规则判断增量列表成员资格；否则正文命中的会话会被本地缓存误判为不匹配。
          nextResultsByQueryKey[queryKey] = {
            ...result,
            invalidationVersion: result.invalidationVersion + 1,
            stale: true,
          };
          continue;
        }

        const previousIncluded = matchesTaskDescriptor(
          result.descriptor,
          previousTask,
          previousState,
        );
        const nextIncluded = matchesTaskDescriptor(result.descriptor, nextTask, nextState);
        const wasVisible =
          result.taskKeys.includes(previousEntityKey) || result.taskKeys.includes(nextEntityKey);

        if (!previousIncluded && !nextIncluded && !wasVisible) {
          continue;
        }

        const taskKeysWithoutTarget = result.taskKeys.filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const unreadTaskKeysWithoutTarget = (result.unreadTaskKeys ?? []).filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const visibleCandidateKeys = nextIncluded
          ? [...taskKeysWithoutTarget, nextEntityKey]
          : taskKeysWithoutTarget;
        const nextUnreadTaskKeys =
          nextIncluded && typeof mergedNextTask.unreadAt === "number"
            ? [...unreadTaskKeysWithoutTarget, nextEntityKey]
            : unreadTaskKeysWithoutTarget;
        const sortedTaskKeys = sortTaskKeysByDescriptor({
          taskKeys: visibleCandidateKeys,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: result.descriptor,
        });
        const visibleTaskKeys =
          result.descriptor.visibleLimit === null
            ? sortedTaskKeys
            : sortedTaskKeys.slice(0, result.descriptor.visibleLimit);
        const nextTotal = Math.max(
          0,
          result.total + Number(nextIncluded) - Number(previousIncluded),
        );
        const shouldBackgroundRefresh =
          result.descriptor.visibleLimit !== null &&
          previousIncluded !== nextIncluded &&
          nextTotal > visibleTaskKeys.length;

        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: visibleTaskKeys,
          ...(result.unreadTaskKeys ? { unreadTaskKeys: nextUnreadTaskKeys } : {}),
          total: nextTotal,
          hasMore: nextTotal > visibleTaskKeys.length,
          stale: result.stale || shouldBackgroundRefresh,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  // [契约] 写入 overlay 并同步更新 meta.unreadAt，保证 UI 立刻反映乐观值。
  // [失败路径] 只写 overlay 不写 meta，行上的未读点要等下一次 query 才变化。
  // [契约] unreadAt 为 undefined 时 overlay 存 null：表示「显式清除」。
  // [失败路径] 存 undefined 会退化成 delete 语义，无法区分「未设置」。
  // [契约] meta 不存在时只写 overlay，不凭空造一条实体。
  setTaskUnreadOverlay: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  // [契约] 服务端确认后把 overlay 更新为服务端值，但**不释放**。
  // [失败路径] 直接删除 overlay 会让稍后到达的旧 membership 回包把未读改回去。
  // [契约] 释放时机固定在 setQueryResult 观察到同值之后。
  // [失败路径] 在这里释放就失去了「挡住旧回包」的全部意义。
  // [契约] meta 不存在时同样只更新 overlay，等待后续实体写入。
  reconcileTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // 服务端回包只确认 mutation 已持久化；旧 membership 请求仍可能稍后返回。
      // 把 overlay 更新成服务端值，直到 setQueryResult 观察到同值后再自动释放。
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  // [契约] 失败回滚：删除 overlay 并恢复 meta.unreadAt 到 mutation 前值。
  // [失败路径] 只删 overlay 不恢复 meta，会留下乐观写入的假未读。
  // [契约] 用 delete 而不是写 null：回滚后应回到「无覆盖」状态。
  // [失败路径] 写 null 会让下一次 query 必须发布「无 unread」才释放，拖慢恢复。
  // [契约] 该函数不返回是否命中，调用方无需关心 key 是否存在。
  rollbackTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      const nextOverlays = { ...state.taskUnreadOverlayByEntityKey };
      delete nextOverlays[entityKey];
      return {
        taskUnreadOverlayByEntityKey: nextOverlays,
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  // [契约] 返回布尔表示是否真的从可见缓存移除，供调用方决定是否刷新。
  // [失败路径] 恒返回 true 会让调用方跳过本应进行的回源查询。
  // [契约] meta 不存在且任何列表都不含该 key 时直接 return state。
  // [失败路径] 无条件构造新对象会广播一次没有实际变化的更新。
  // [契约] 同时删除 meta 与 overlay，避免删除后残留未读状态。
  // [契约] 只对包含该 key 的列表扣减 total，隐藏项不猜 membership。
  removeTask: (task) => {
    let removedFromVisibleCache = false;
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      if (!state.taskMetaByEntityKey[entityKey]) {
        const hasCachedResult = Object.values(state.resultsByQueryKey).some((result) =>
          result.taskKeys.includes(entityKey),
        );
        if (!hasCachedResult) {
          return state;
        }
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      delete nextTaskMetaByEntityKey[entityKey];
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      delete nextTaskUnreadOverlayByEntityKey[entityKey];

      // [契约] 重建整张结果表而不是原地改，保证未命中列表保持旧引用。
      // [失败路径] 原地改 result.taskKeys 会污染仍被订阅者持有的旧快照。
      // [契约] 未包含该 entityKey 的列表直接赋回原 result 引用。
      // [契约] 只有真正参与增删/重排的列表才会生成新对象。
      const nextResultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult> = {};
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          nextResultsByQueryKey[queryKey] = result;
          continue;
        }

        const taskKeys = result.taskKeys.filter((taskKey) => taskKey !== entityKey);
        removedFromVisibleCache = true;
        // 删除 task 以前只能整表刷新；这里只对实际可见缓存命中的列表扣减 total。
        // 对未出现在折叠可见区的隐藏项不猜 membership，避免误扣其它列表计数。
        const total = Math.max(0, result.total - 1);
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys,
          total,
          hasMore: total > taskKeys.length,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: nextTaskUnreadOverlayByEntityKey,
      };
    });
    return removedFromVisibleCache;
  },
  // [契约] 只标脏匹配 workspace 的结果，不删数据、不扣计数。
  // [失败路径] 在这里直接删行会让折叠区/分页计数无法安全推算。
  // [契约] 每次标脏都自增 invalidationVersion，让在途查询失效。
  // [失败路径] 只置 stale 不自增，会让刚发出的查询把旧结果写回来。
  // [契约] 无任何匹配时返回原 state，不产生新引用。
  // [契约] 空入参早返回，避免构建空 Set 与无意义遍历。
  markWorkspaceKeysStale: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const staleWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let changed = false;

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (
          !result.descriptor.workspaceKeys.some((workspaceKey) =>
            staleWorkspaceKeySet.has(workspaceKey),
          )
        ) {
          continue;
        }

        // 删除折叠/分页隐藏 task 时无法只靠 taskId 安全扣 total。
        // 这里保留当前可见列表，只标脏匹配 workspace，让 hook 的下一轮 effect 真正回源刷新计数。
        nextResultsByQueryKey[queryKey] = {
          ...result,
          invalidationVersion: result.invalidationVersion + 1,
          stale: true,
        };
        changed = true;
      }

      // [契约] 没有任何列表被标脏时返回原 state，避免空更新。
      // [失败路径] 无条件返回新对象会让每次事件都触发全量重渲染。
      // [契约] changed 只由真正写入 nextResultsByQueryKey 的分支置位。
      // [契约] 返回原 state 时 Zustand 不会通知订阅者。
      if (!changed) {
        return state;
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
      };
    }),
  // [契约] 彻底移除匹配 workspace 的结果与实体缓存，用于 workspace 被删除。
  // [失败路径] 只标脏会让已删除 workspace 的数据常驻内存。
  // [契约] queryKey 匹配同时兼容 `workspaces=` 与 `|` 两种历史拼接格式。
  // [失败路径] 只匹配一种格式会漏删另一半缓存。
  // [契约] entityKey 用 `::` 前缀取 workspaceKey，分隔符与构造方一致。
  // [失败路径] 改分隔符会让这里的失效匹配不到任何实体。
  invalidateWorkspaceKeys: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const invalidatedWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = Object.fromEntries(
        Object.entries(state.resultsByQueryKey).filter(([queryKey]) => {
          return ![...invalidatedWorkspaceKeySet].some(
            (workspaceKey) =>
              queryKey.includes(`workspaces=${workspaceKey}`) ||
              queryKey.includes(`|${workspaceKey}`),
          );
        }),
      );
      const nextTaskMetaByEntityKey = Object.fromEntries(
        Object.entries(state.taskMetaByEntityKey).filter(([entityKey]) => {
          const workspaceKey = entityKey.split("::")[0] ?? "";
          return !invalidatedWorkspaceKeySet.has(workspaceKey);
        }),
      );

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  // [契约] 必须通过 set 写回三张表，不能只 return 一个对象。
  // [失败路径] 只返回对象不生效，测试与开发态清理后旧 meta 继续残留。
  // [契约] `clearAll` 不做等价判断：显式清空允许产生新引用。
  // [契约] 三张表一起清，避免残留 overlay 指向已不存在的实体。
  clearAll: () =>
    set(() => ({
      // clearAll 是 Zustand action，必须通过 set 写回 store。
      // 之前只返回对象，测试和开发态清理 query cache 时旧 task meta 会继续残留。
      resultsByQueryKey: {},
      taskMetaByEntityKey: {},
      taskUnreadOverlayByEntityKey: {},
    })),
}));

// [契约] 返回 selector 而非直接取值，让组件按 queryKey 精确订阅。
// [失败路径] 直接 getState() 取值会失去订阅，数据更新后不重渲染。
// [契约] 缺失时返回 null 而不是 undefined，便于调用方显式判空。
// [契约] selector 内部不做派生计算，保证引用稳定。
export function selectTaskListCacheResult(queryKey: TaskListCacheKey) {
  return (state: TaskQueryCacheState): CachedTaskListResult | null => {
    return state.resultsByQueryKey[queryKey] ?? null;
  };
}

// [契约] 对外 API 统一把 scope 归一化成 workspaceKey，再调用 store action。
// [失败路径] 由调用方各自拼 key 会出现 identity/path 优先级不一致。
// [契约] scopes 为空时 map 出空数组，action 内早返回。
// [契约] 该函数无返回值，调用方不需要等待异步完成。
export function invalidateTaskQueryCacheByScopes(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().invalidateWorkspaceKeys(workspaceKeys);
}

export function markTaskQueryCacheScopesStale(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().markWorkspaceKeysStale(workspaceKeys);
}

// [契约] 模块级 API 只是 getState().action 的薄封装，不额外做合并。
// [失败路径] 在此再包一层合并会与 store 内规则产生第二套优先级。
// [契约] 供非 React 环境（事件回调、测试）直接写入缓存。
export function upsertTaskQueryCacheTaskMeta(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().upsertTaskMeta(task);
}

export function updateTaskQueryCacheTaskMetaPreservingMembership(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().updateTaskMetaPreservingMembership(task);
}

// [契约] 写入缓存后按 archived false→true 补发生命周期事件。
// [失败路径] 在 store action 内发事件会让 set 回调带副作用，无法在测试中隔离。
// [契约] 事件带 workspaceKey，订阅方按 workspace 过滤。
// [失败路径] 只传 taskId 会让跨 workspace 的同名任务混淆。
// [契约] 取消归档不发事件：只有进入归档态才需要通知。
export function applyTaskQueryCacheMutation(params: {
  previousTask: ZCodeTaskMeta;
  nextTask: ZCodeTaskMeta;
  previousState: TaskListMembershipState;
  nextState: TaskListMembershipState;
}): void {
  useTaskQueryCacheStore.getState().applyTaskMutation(params);
  if (!params.previousState.archived && params.nextState.archived) {
    notifyTaskLifecycle({
      type: "archived",
      taskId: params.nextTask.taskId,
      workspaceKey: buildTaskWorkspaceKey(
        params.nextTask.workspacePath,
        params.nextTask.workspaceIdentity,
      ),
    });
  }
}

export function setTaskQueryCacheUnreadOverlay(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().setTaskUnreadOverlay(task, unreadAt);
}

export function reconcileTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().reconcileTaskUnread(task, unreadAt);
}

export function rollbackTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().rollbackTaskUnread(task, unreadAt);
}

// [契约] 删除后无条件发 deleted 事件，即使缓存里本来就没有该任务。
// [失败路径] 只在 removed 时发事件会让「服务端已删、本地未缓存」的场景漏通知。
// [契约] 返回值透传 store 的 removedFromVisibleCache，供调用方决定刷新。
// [失败路径] 返回 void 会让调用方无法区分「可见缓存已删」与「未命中」。
// [契约] workspaceKey 仍按 identity 优先构造。
export function removeTaskFromTaskQueryCaches(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): boolean {
  const removed = useTaskQueryCacheStore.getState().removeTask(task);
  notifyTaskLifecycle({
    type: "deleted",
    taskId: task.taskId,
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  });
  return removed;
}

// 内存诊断计数器：版本化 queryKey 只增不删，先落日志。
// [契约] 诊断只统计键数量，不遍历 meta 内容。
// [失败路径] 在诊断回调里序列化 meta 会在内存紧张时雪上加霜。
// [契约] queryKey 版本化后只增不删，该计数用于发现泄漏。
// [契约] 回调必须是纯读，不能调用任何 action。
uiMemoryDiagnosticsRegistry.register("taskQueryCache", () => {
  const state = useTaskQueryCacheStore.getState();
  return {
    queryKeys: Object.keys(state.resultsByQueryKey).length,
    taskMetas: Object.keys(state.taskMetaByEntityKey).length,
  };
});
