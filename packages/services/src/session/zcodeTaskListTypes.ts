// 任务列表的查询契约：由 UI 侧声明筛选/排序/分页，services 只按契约返回结果。
// 所有字段都必须是可序列化的纯数据，禁止把运行时句柄混入查询对象。
import type { WorkspacePurpose, ZCodeTaskMeta } from "@zcode/shared";

// 列表种类决定默认排序与过滤条件；新增种类必须同步补齐 SQL 分支。
export type ZCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZCodeTaskListSortBy = "created" | "updated";

// workspace 作用域：路径是必填项，identity/purpose 用于区分同一路径下的不同身份视图。
export interface ZCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

// 查询参数整体不可变；调用方复用同一对象时不得依赖服务端对其做任何改写。
export interface ZCodeTaskListQuery {
  kind: ZCodeTaskListKind;
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  sortBy: ZCodeTaskListSortBy;
// [契约] search 缺省或 trim 后为空都表示不过滤：不得把空串当成「匹配空内容」的过滤条件。
  search?: string;
  limit?: number;
}

// 列表项在任务元数据之上附加搜索片段；片段只在搜索命中的字段上出现。
export type ZCodeTaskListItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

// total 是满足条件的总数（不受 limit 影响），hasMore 由 total 与已返回数量推导。
export interface ZCodeTaskListResult {
  items: ZCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

// 事件订阅只按 workspace 维度；identity 缺省表示订阅该路径下所有身份的事件。
export interface ZCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
