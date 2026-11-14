// INV-01 无源可调用：守住位置 空订阅常量；改错故障：控制器缺失时钩子抛错。
// INV-02 签名去重：守住位置 查询签名；改错故障：父组件重建数组就触发重复查询。
// INV-03 身份优先：守住位置 作用域键；改错故障：同一路径的远程与本地作用域合并。
// INV-04 身份留白：守住位置 作用域构造；改错故障：空身份以空串写入查询对象。
// INV-05 版本聚合：守住位置 任务列表版本签名；改错故障：单工作区版本变化不触发重查。
// INV-06 来源代际：守住位置 来源签名；改错故障：远程断开后恢复仍读到旧空结果。
// INV-07 请求序号：守住位置 加载入口；改错故障：晚到响应覆盖新查询结果。
// INV-08 空作用域清空：守住位置 早退分支；改错故障：无工作区时仍发请求或残留旧列表。
// INV-09 控制器缺失可见：守住位置 缺注册表分支；改错故障：宿主与渲染进程版本不一致时静默空白。
// INV-10 引用稳定：守住位置 逐条稳定化；改错故障：每次活动帧都整表换代重渲染。
// INV-11 失败保留：守住位置 异常分支；改错故障：单个来源失败清空全部工作区列表。
// INV-12 加载收尾：守住位置 finally；改错故障：晚到请求把加载态提前关掉。
// INV-13 手动刷新：守住位置 refresh；改错故障：手动刷新被去重逻辑吞掉。
// INV-14 依赖完整：守住位置 effect 依赖；改错故障：查询变化后不重查。
// INV-15 展开即全量：守住位置 limit；改错故障：展开视图仍按折叠上限截断。
// INV-16 搜索空白：守住位置 查询构造；改错故障：只含空白的搜索被当作有效条件。
// INV-17 远程同步标记：守住位置 返回值；改错故障：本地加载被误标为远程同步。
// INV-18 状态归位：守住位置 内部状态集合；改错故障：列表与总数来自不同请求，界面自相矛盾。
//
// 模块职责：跨工作区聚合任务列表，负责查询签名、加载与引用稳定化。
// 状态所有权：列表数据归本钩子；控制器版本来自外部存储。
// 阅读顺序：常量 → 作用域构造 → 钩子签名 → 查询 → 加载 → 刷新与副作用。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  WindowHostControllerTaskListItem,
  ZCodeTaskListKind,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { stabilizeTaskListItems } from "@/v4/taskListItemStabilization.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import type { WindowControllerTaskListVersion } from "@/v4/windowControllerTaskListRegistry.js";

type GlobalTaskListItem = WindowHostControllerTaskListItem;

// 没有控制器时订阅空函数，保证外部存储钩子可调用。
// 版本号恒为零，避免无源时反复刷新。
//
const subscribeToNothing = () => () => {};
const zeroRevision = () => 0;

// buildWorkspaceScopes 用 Map 去重，键由 [identity||path, path] 序列化而来。
// identity 只做 trim，大小写与前缀保持原样，不做规范化。
// workspaceIdentity 为空时展开对象里不放该键，查询对象不留空串字段。
// Map 保序，Array.from(scopes.values()) 沿用首次出现顺序。
//
function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]): ZCodeTaskListWorkspaceScope[] {
  const scopes = new Map<string, ZCodeTaskListWorkspaceScope>();
  for (const tab of workspaceTabs) {
    const scope = {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    };
    scopes.set(
      JSON.stringify([tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath]),
      scope,
    );
  }
  return Array.from(scopes.values());
}

// controller 缺失时 controllerRegistry 为 null，订阅回落到 subscribeToNothing。
// useSyncExternalStore 订阅控制器版本，版本变化触发本钩子重渲染。
// workspaceSignature 管查询面，workspaceSourceGenerationSignature 管来源代际。
// 两个键都先 sort 再 JSON.stringify，父组件重建 tabs 数组不会改签名。
// 来源签名多带 remoteSessionId，断线重连后会话换了就会重查。
//
export function useGlobalTaskList(params: {
  kind: ZCodeTaskListKind;
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
  searchQuery: string;
  expanded: boolean;
  collapsedLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
  const controller = baseServices.windowControllerService;
  const controllerRegistry = useMemo(
    () => (controller ? getWindowControllerTaskListRegistry(controller) : null),
    [controller],
  );
  const controllerRevision = useSyncExternalStore(
    controllerRegistry?.subscribe ?? subscribeToNothing,
    controllerRegistry?.getRevision ?? zeroRevision,
    controllerRegistry?.getRevision ?? zeroRevision,
  );
  const workspaceSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath] as const,
      )
      .sort(
        ([leftKey, leftPath], [rightKey, rightPath]) =>
          leftKey.localeCompare(rightKey) || leftPath.localeCompare(rightPath),
      ),
  );
  const workspaceSourceGenerationSignature = JSON.stringify(
    params.workspaceTabs
      .map(
        (tab) =>
          [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            tab.workspacePath,
            tab.remoteSessionId?.trim() || null,
          ] as const,
      )
      .sort(
        ([leftKey, leftPath, leftSession], [rightKey, rightPath, rightSession]) =>
          leftKey.localeCompare(rightKey) ||
          leftPath.localeCompare(rightPath) ||
          (leftSession ?? "").localeCompare(rightSession ?? ""),
      ),
  );
  // 作用域由签名驱动，避免父组件重建 tabs 时重复查询。
  // 任务列表版本签名按工作区聚合，版本变化即触发重查。
  // 局部状态由 items、total、hasMore、loading 四个 useState 组成。
  // requestSerialRef 与 manualRefreshSerialRef 各自单调递增，互不共用。
  // itemsRef 存当前列表引用，供 stabilizeTaskListItems 做等价复用。
  //
  const workspaceScopes = useMemo(
    () => buildWorkspaceScopes(params.workspaceTabs),
    // workspaceSignature 是标准化后的 scope 值签名，避免父组件重建 tabs 数组时重复查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceSignature],
  );
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      params.workspaceTabs
        .map((tab) => {
          const workspace = selectWorkspaceZCodeState(
            state,
            tab.workspacePath,
            tab.workspaceIdentity,
          );
          return [
            tab.workspaceIdentity?.trim() || tab.workspacePath,
            workspace.taskListVersion,
          ] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  const [items, setItems] = useState<GlobalTaskListItem[]>([]);
  const itemsRef = useRef<GlobalTaskListItem[]>(items);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(workspaceScopes.length > 0);
  const requestSerialRef = useRef(0);
  const manualRefreshSerialRef = useRef(0);

  const query = useMemo(
    () => ({
      kind: params.kind,
      workspaceScopes,
      sortBy: params.sortBy,
      search: params.searchQuery.trim() || undefined,
      limit: params.expanded ? undefined : params.collapsedLimit,
    }),
    [
      params.collapsedLimit,
      params.expanded,
      params.kind,
      params.searchQuery,
      params.sortBy,
      workspaceScopes,
    ],
  );
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  // load 开头 ++requestSerialRef.current，晚到的响应比对序号后丢弃。
  // workspaceScopes 为空时清空四项状态并直接 return，不发请求。
  // 控制器缺失代表宿主与渲染进程版本不一致，记错误并结束加载。
  // 逐条引用稳定化，内容等价复用旧对象。
  // 失败时保留最后可信列表，避免单源异常清空全部。
  const load = useCallback(
    async (version: WindowControllerTaskListVersion) => {
      const requestSerial = ++requestSerialRef.current;
      if (workspaceScopes.length === 0) {
        setItems([]);
        itemsRef.current = [];
        setTotal(0);
        setHasMore(false);
        setLoading(false);
        return;
      }
      if (!controllerRegistry) {
        // 原子切换后 base attachment 必须提供 Controller；缺失代表 Host/Renderer 版本不一致。
        logger.error("[useGlobalTaskList] window Host Controller channel unavailable");
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const result = await controllerRegistry.list(queryKey, version, query);
        if (requestSerialRef.current !== requestSerial) {
          return;
        }
        // Controller 的每个 activity 帧（运行中任务的 tool 调用等）都会让本 hook 重查，
        // 而 attachTaskListRowActivity 与 tasks-index join 每次都产生全新对象。下游（grouped 视图）
        // 只能按引用判等，于是整棵列表树换代重渲染并重测量虚拟器。这里与 sessions-index lane 同款
        // 逐条引用稳定化：内容等价复用旧对象，整表等价复用旧数组。
        const nextItems = stabilizeTaskListItems(
          itemsRef.current,
          result.items.map((item) =>
            item.activity ? attachTaskListRowActivity(item, item.activity) : item,
          ),
        );
        itemsRef.current = nextItems;
        setItems(nextItems);
        setTotal(result.total);
        setHasMore(result.hasMore);
      } catch (error) {
        if (requestSerialRef.current === requestSerial) {
          // Controller 查询失败时保留最后可信列表，避免单 source 异常清空其他 workspace。
          logger.error(`[useGlobalTaskList] Controller 加载 ${params.kind} 列表失败`, error);
        }
      } finally {
        if (requestSerialRef.current === requestSerial) {
          setLoading(false);
        }
      }
    },
    [controllerRegistry, params.kind, query, queryKey, workspaceScopes],
  );

  // refresh 先递增 manualRefreshSerialRef，再复用同一个 load。
  // effect 依赖四项签名，任一变化都重查。
  //
  const refresh = useCallback(async () => {
    manualRefreshSerialRef.current += 1;
    await load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
      manualRefreshSerial: manualRefreshSerialRef.current,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  useEffect(() => {
    // 远程 workspace 从断开占位恢复为在线 session 时 identity/path 不变，
    // taskListVersion 也可能尚未变化，旧缓存因此永久保留连接前的空结果。remoteSessionId
    // 只作为 source 代际触发重查，不改变 workspaceIdentity 与 Controller 查询契约。
    void load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  const hasRemoteScope = params.workspaceTabs.some((tab) => Boolean(tab.workspaceIdentity));
  return {
    items,
    total,
    hasMore,
    loading,
    syncingRemoteWorkspaces: loading && hasRemoteScope,
    refresh,
  };
}
