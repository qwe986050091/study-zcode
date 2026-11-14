// INV-01 守住位置：第 6~7 行的 PAGE_SIZE 与 MAX_PAGE_SIZE 上限；改错故障：单次请求突破 100 条会让目录首屏一次拉满，长会话下内存与渲染同时膨胀并卡住切换。
// INV-02 守住位置：第 9~14 行的视图状态字段集合；改错故障：漏掉 revision 或 loading 会让陈旧响应覆盖新数据，用户看到上一会话的子智能体列表。
// INV-03 守住位置：第 16~23 行的空态工厂；改错故障：共享同一个对象引用会让多次重置互相污染，错误提示与列表内容串台。
// INV-04 守住位置：第 25~31 行按 childSessionId 去重合并；改错故障：重复项进入列表会让 React key 冲突，翻页后出现重复行且删除操作错位。
// INV-05 守住位置：第 33~43 行的补取数量推导；改错故障：新完成项挤占页容量却不补旧项，用户已滚到底部的条目会被挤出并造成跳动。
// INV-06 守住位置：第 45~52 行 hook 入参契约；改错故障：workspacePath 或 sessionId 缺失时仍发请求，会让目录读到别的会话数据。
// INV-07 守住位置：第 53~55 行服务注入与 useState 初始化；改错故障：把 state 提到模块作用域会跨会话共享，切换后残留旧列表。
// INV-08 守住位置：第 56~58 行三个 ref 的职责边界；改错故障：requestInFlightRef 未复位会让后续刷新永久静默失效。
// INV-09 守住位置：第 59~60 行 stateRef 的写回；改错故障：异步回调读到过期快照会算错补取数量，翻页结果被截断。
// INV-10 守住位置：第 61 行 enabled 的派生条件；改错故障：忽略 sessionId 判空会让空会话也发起轮询，产生无意义请求与告警噪声。
// INV-11 守住位置：第 63~82 行 requestPage 的参数拼装；改错故障：可选字段被写成 undefined 展开会污染服务端过滤条件，返回全量或空集。
// INV-12 守住位置：第 92~100 行 refresh 的前置闸门；改错故障：并发刷新未去重会让两次响应竞态写 state，列表在加载中闪烁。
// INV-13 守住位置：第 102~112 行的目标条数推导；改错故障：首屏即按历史加载量请求会放大流量，冷启动变慢。
// INV-14 守住位置：第 113~120 行的游标补页循环；改错故障：缺少 cursor 终止条件会在服务端返回空页时死循环。
// INV-15 守住位置：第 121~132 行的版本校验与提交；改错故障：跳过快照比对会让旧请求覆盖新会话数据。
// INV-16 守住位置：第 133~144 行的失败路径；改错故障：finally 漏掉 in-flight 复位会让后续所有刷新被闸门挡住，界面停在错误态。
// INV-17 守住位置：第 154~176 行 loadMore 的追加语义；改错故障：直接覆盖而非合并会让已加载页消失，滚动位置回跳。
// INV-18 守住位置：第 189~204 行两个 effect 的依赖与清理；改错故障：清理时不递增版本号会让卸载后的响应写回已销毁组件。
//
// 模块职责：把子智能体会话目录的分页读取、去重合并、竞态防护与错误态收敛在一个 hook 内，供 UI 直接消费。
// 状态所有权：列表、总量、游标与错误由本模块的 useState 独占，调用方只读不回写；并发令牌与 in-flight 标记走 ref，避免触发重渲染。
// 阅读顺序：先常量与类型，再看空态与纯函数，随后 requestPage 闸门、refresh 补页循环、loadMore 追加，最后 effect 生命周期。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeSessionEndedSubagent, ZCodeSessionSubagentsResult } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

// 分页常量同时是首屏数量与后续翻页步长，两处共用才保证缓存条数可预测。
// MAX_PAGE_SIZE 是服务端单次返回的硬上限，请求前必须夹紧，否则补页循环会把整目录塞进一次响应。
// 改动这里会同时影响首屏渲染开销与滚动容器高度估算，属于需要与后端约定同步调整的耦合点。
// 常量放在模块顶层而非 hook 内，是为了让纯函数与测试可以复用同一套边界值。
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface SessionSubagentsViewState {
  revision: number;
  ended: ZCodeSessionSubagentsResult["ended"];
  error: string | null;
  loading: boolean;
}

function emptyState(): SessionSubagentsViewState {
  return {
    revision: 0,
    ended: { total: 0, items: [] },
    error: null,
    loading: false,
  };
}

export function mergeEndedSubagentPages(
  current: readonly ZCodeSessionEndedSubagent[],
  incoming: readonly ZCodeSessionEndedSubagent[],
): ZCodeSessionEndedSubagent[] {
  // 以 childSessionId 作为去重键，是因为同一子会话在多次翻页中会重复出现。
  // 先建索引再过滤，复杂度保持在一次遍历，避免在大目录上退化为平方级比较。
  // 保留已有顺序并把新项追加在后，滚动位置与已渲染行标识因此保持稳定。
  // 若换成整对象比较，任何字段抖动都会被当成新项，列表会持续增长。
  const currentIds = new Set(current.map((item) => item.childSessionId));
  return [...current, ...incoming.filter((item) => !currentIds.has(item.childSessionId))];
}

export function resolveEndedSubagentRefreshTargetCount(options: {
  loadedItemCount: number;
  nextTotal: number;
  previousTotal: number;
  requestedCount: number;
}): number {
  if (options.loadedItemCount === 0) return options.requestedCount;
  return (
    options.requestedCount + Math.max(0, options.nextTotal - options.previousTotal)
  );
}

export function useSessionSubagents(options: {
  enabled?: boolean;
  refreshKey?: string | number | null;
  remoteSessionId?: string;
  sessionId?: string | null;
  workspaceIdentity?: string;
  workspacePath: string;
}) {
  const services = useServices();
  const zcodeAgentService = services.zcodeAgentService;
  // 视图状态由本 hook 独占，外部拿到的只是快照，不提供受控写入口。
  // 初始化为空态而非 undefined，调用方无需处理尚未请求的三态分支。
  // stateRef 与 state 同步维护，是为了让异步回调在不重跑副作用的前提下读到最新值。
  // 任何跨会话复用该状态的改动都会把上一个会话的列表污染到新会话。
  const [state, setState] = useState<SessionSubagentsViewState>(emptyState);
  // requestSeq 并发令牌只递增不重置，每次请求发出前取号，落地前比对，晚到的响应直接丢弃。
  // 用 ref 持有是为了避免令牌变化触发重渲染，它只服务于竞态判定。
  // 会话切换与组件卸载都会推进令牌，确保在途响应无权再写状态。
  // 若把令牌放进 state，会让每次请求都多一轮渲染，且在闭包中读到滞后值。
  const requestVersionRef = useRef(0);
  const requestInFlightRef = useRef(false);
  const loadedEndedCountRef = useRef(PAGE_SIZE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const enabled = options.enabled !== false && Boolean(options.sessionId);

  const requestPage = useCallback(
    (endedLimit: number, endedCursor?: string): Promise<ZCodeSessionSubagentsResult> => {
      // 缺少会话标识时直接拒绝，而不是发明一个空会话，避免把错误数据缓存进列表。
      // 拒绝值带固定错误码，调用方的错误分支可以据此判断是参数缺失还是网络失败。
      // 这里刻意不写日志，因为未启用状态下该分支属于预期路径，记录会污染告警。
      // 返回 rejected promise 而非同步抛出，保证调用方始终走同一条异步错误处理链路。
      if (!options.sessionId) return Promise.reject(new Error("session_id_missing"));
      // 服务能力缺失时返回结构完整的空结果，而不是抛错，让目录区退化为空态而非报错面板。
      // 空结果里的 total 与 items 必须自洽，否则上层会认为还有更多页而无限触发翻页。
      // 这条降级路径覆盖测试环境与旧宿主，属于可预期分支，不应产生错误提示。
      // 判断放在请求函数内部而非 hook 入口，是为了让每次调用都重新检查，避免服务延迟注入后永久降级。
      if (typeof zcodeAgentService?.listSessionSubagents !== "function") {
        return Promise.resolve({
          revision: 0,
          childSessionIds: [],
          running: [],
          ended: { total: 0, items: [] },
        });
      }
      return zcodeAgentService.listSessionSubagents({
        workspacePath: options.workspacePath,
        ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
        ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
        sessionId: options.sessionId,
        endedLimit,
        ...(endedCursor ? { endedCursor } : {}),
      });
    },
    [
      options.remoteSessionId,
      options.sessionId,
      options.workspaceIdentity,
      options.workspacePath,
      zcodeAgentService,
    ],
  );

  const refresh = useCallback(async () => {
    if (!enabled) {
      setState(emptyState());
      return;
    }
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    const requestVersion = ++requestVersionRef.current;
    setState((current) => ({ ...current, loading: current.revision === 0, error: null }));
    try {
      const requestedCount = Math.max(PAGE_SIZE, loadedEndedCountRef.current);
      let response = await requestPage(Math.min(requestedCount, MAX_PAGE_SIZE));
      const previous = stateRef.current;
      // 新完成项会插入 ended 顶部。多取同样数量的旧项，避免刷新时把用户已经
      // 加载到目录底部的项目挤出当前内存页；浏览器滚动锚点可继续保持可见行。
      const targetCount = resolveEndedSubagentRefreshTargetCount({
        loadedItemCount: previous.ended.items.length,
        nextTotal: response.ended.total,
        previousTotal: previous.ended.total,
        requestedCount,
      });
      // loadMore 循环以 remaining 为界，只在 nextCursor 存在时继续，二者共同构成终止条件，缺一必须退出。
      // 每轮只取剩余所需数量，避免一次拉取远超需要的旧数据。
      // 合并时沿用同一套去重规则，防止新完成项在跨页边界重复出现。
      // 循环会串行等待多个网络往返，这是用首屏抖动换取内存占用的取舍，极端大目录下应改为懒加载。
      // 一旦游标为空即退出，宁可少加载也不空转请求，服务端分页策略变化时这里最先暴露。
      let items = response.ended.items;
      let cursor = response.ended.nextCursor;
      while (items.length < targetCount && cursor) {
        const page = await requestPage(Math.min(PAGE_SIZE, targetCount - items.length), cursor);
        items = mergeEndedSubagentPages(items, page.ended.items);
        cursor = page.ended.nextCursor;
        response = page;
      }
      if (requestVersion !== requestVersionRef.current) return;
      loadedEndedCountRef.current = Math.max(PAGE_SIZE, items.length);
      setState({
        revision: response.revision,
        ended: {
          total: response.ended.total,
          items,
          ...(cursor ? { nextCursor: cursor } : {}),
        },
        error: null,
        loading: false,
      });
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[subagent-directory] 读取子智能体目录失败", {
        error: message,
        sessionId: options.sessionId,
        workspaceKey: options.workspaceIdentity?.trim() || options.workspacePath,
      });
      setState((current) => ({ ...current, error: message, loading: false }));
    } finally {
      requestInFlightRef.current = false;
    }
  }, [
    enabled,
    options.remoteSessionId,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    requestPage,
  ]);

  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (!enabled || current.loading || requestInFlightRef.current || !current.ended.nextCursor) {
      return;
    }
    requestInFlightRef.current = true;
    const requestVersion = ++requestVersionRef.current;
    setState((value) => ({ ...value, loading: true, error: null }));
    try {
      const response = await requestPage(PAGE_SIZE, current.ended.nextCursor);
      if (requestVersion !== requestVersionRef.current) return;
      const items = mergeEndedSubagentPages(current.ended.items, response.ended.items);
      loadedEndedCountRef.current = Math.max(PAGE_SIZE, items.length);
      setState({
        revision: response.revision,
        ended: {
          total: response.ended.total,
          items,
          ...(response.ended.nextCursor ? { nextCursor: response.ended.nextCursor } : {}),
        },
        error: null,
        loading: false,
      });
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return;
      setState((value) => ({
        ...value,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      }));
    } finally {
      requestInFlightRef.current = false;
    }
  }, [enabled, requestPage]);

  useEffect(() => {
    // 会话身份变化时把已加载条数归零，下一次刷新回到首屏页大小。
    // 同时清空列表状态，避免新会话短暂显示上一个会话的子智能体。
    // 清理函数递增并发令牌，让旧会话的在途响应失效，这是取消语义的全部实现。
    // 依赖数组只列身份字段而不含函数引用，防止每次渲染都重复重置。
    loadedEndedCountRef.current = PAGE_SIZE;
    setState(emptyState());
    return () => {
      requestVersionRef.current += 1;
    };
  }, [
    options.remoteSessionId,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
  ]);

  useEffect(() => {
    // refreshKey 变化即代表外部数据可能过期，这里只触发一次刷新而不做轮询。
    // refresh 的引用由依赖列表约束，键变化时副作用重跑，旧调用被令牌判定作废。
    // 使用 void 显式丢弃返回值，表明调用方不关心这次刷新的完成时机。
    // 若要加轮询必须在此处引入定时器并在清理中注销，否则会话切换后会累积重复请求。
    void refresh();
  }, [options.refreshKey, refresh]);

  return { ...state, loadMore, refresh };
}
