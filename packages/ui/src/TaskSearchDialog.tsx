// TaskSearchDialog：全局任务搜索弹窗，包含常驻触发按钮、CommandDialog 与分组结果列表。
// 职责：把 useGlobalTaskList 的搜索结果整理成「任务头 + 正文片段 + 展开更多」三类行，
// 提供 1-9 数字快捷键直达、跨工作区去重合并、按任务折叠或展开片段，并把选中结果回交给调用方。
// 不负责：检索与排序本身（服务层与 useGlobalTaskList）、正文索引实现、任务打开后的导航动作。
// 不负责：系统级快捷键注册，本组件只在弹窗打开期间监听 window 上的 keydown。
// 弹窗常驻在 App 中，未打开时必须保持零订阅、零 RPC，否则每个窗口都会多一份启动开销。
//
// INV-01 断言：未打开时必须向 useGlobalTaskList 传空 workspaceTabs —— 守住它的位置：searchWorkspaceTabs —— 改错故障：空闲期多出一组 listTaskList 与工作区事件订阅，启动变慢
// INV-02 断言：结果行 key 必须由工作区身份（缺失时退回路径）与 taskId 共同构成 —— 守住它的位置：getTaskResultKey —— 改错故障：两个工作区同 id 任务互相覆盖，搜索结果凭空少一条
// INV-03 断言：同一会话 key 的任务必须合并片段而不是新起一行 —— 守住它的位置：visibleResults 的合并分支 —— 改错故障：同一任务出现两份标题，条数与实际命中不符
// INV-04 断言：片段去重必须先归一化省略号、连续空白与大小写再比较 —— 守住它的位置：normalizeSnippetForDedupe —— 改错故障：只差省略号或大小写的片段被当成两条，展开计数虚高
// INV-05 断言：只有查询词非空才把一个任务拆成多条片段行 —— 守住它的位置：visibleResults 的 hasQuery 分支 —— 改错故障：空查询下历史任务被拆行，最近列表变成噪音
// INV-06 断言：任务标题头只挂在每组第一条片段上 —— 守住它的位置：showTaskHeader 赋值 —— 改错故障：每条片段都重复标题，列表高度翻倍
// INV-07 断言：折叠态每组最多三条片段并追加一条展开行 —— 守住它的位置：TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT 分支 —— 改错故障：首屏被单个任务占满，其他任务不可见
// INV-08 断言：未展开时行数达到上限即跳出任务循环 —— 守住它的位置：提前 break —— 改错故障：上千条结果全部建成行对象，输入每个字符都卡顿
// INV-09 断言：全局截断只发生在没有任何展开任务时 —— 守住它的位置：visibleResults 末尾三元表达式 —— 改错故障：点开「更多」后列表仍停在九行，展开无效果
// INV-10 断言：结果上限 9 与数字快捷键 1-9 必须同口径 —— 守住它的位置：TASK_SEARCH_RESULT_LIMIT 与快捷键标签 —— 改错故障：标签序号与实际可直达的条数不一致，末几条按键无响应
// INV-11 断言：展开分支只累加展开集合，不关弹窗也不回调选中 —— 守住它的位置：selectTask 的 expand 分支 —— 改错故障：点「更多」直接跳走任务，用户丢失当前上下文
// INV-12 断言：命中上下文上报必须先于关闭弹窗与清空查询 —— 守住它的位置：selectTask 尾段顺序 —— 改错故障：下游拿到已清空的 query，跳转后无法定位命中片段
// INV-13 断言：展开集合每次修改都必须换成新 Set 实例 —— 守住它的位置：setExpandedTaskKeys 全部调用点 —— 改错故障：原地 add 不触发重渲染，点按钮没有反应
// INV-14 断言：查询词变化必须重置展开集合 —— 守住它的位置：第二个 useEffect —— 改错故障：换词后仍带旧任务的展开态，截断判断错乱
// INV-15 断言：刷新副作用只在打开且有查询时触发，且依赖稳定的 refresh 引用 —— 守住它的位置：第一个 useEffect —— 改错故障：空闲期反复整表重拉，或引用不稳导致刷新风暴
// INV-16 断言：window keydown 监听只在打开时注册，并在清理函数移除同一个处理函数 —— 守住它的位置：最后一个 useEffect —— 改错故障：监听器逐次累积，一次按键触发多次跳转
//
// 数据流：trimmedQuery → useGlobalTaskList(searchQuery) → items → visibleResults 行模型 → JSX。
// 检索是宿主（服务端）口径，组件内的 Command 必须关闭自带过滤，否则片段行会被前端再筛一遍而消失。
// 关闭统一走 onOpenChange(false)：清空查询与展开集合，保证下次打开是干净初态。
// logger 输出受「打开且有查询」约束，常驻组件在空闲期不产生日志。
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickInputClassName,
  quickPickItemClassName,
  quickPickListClassName,
  quickPickMetadataClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

// [契约] 9 同时是单次渲染的结果上限和数字快捷键 1-9 的上界，两处口径必须一致。
// 改成两位数后，第 10 条需要连续按两个数字键才能命中，等于失去键盘直达能力。
// [权衡] 3 是折叠态每组片段数：再多会挤掉其他任务的可见性，再少则展开入口过于频繁。
// 这两个常量只服务本弹窗，不要下沉到通用配置被别处改口径。
const TASK_SEARCH_RESULT_LIMIT = 9;
const TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT = 3;

// [契约] 协议只保证单个 searchSnippet，searchSnippets 是本组件合并多路结果后的聚合字段。
// 读片段一律走 getUniqueTaskSearchSnippets，直接读 searchSnippets 会绕过去重。
// 两者同时存在时以数组为准，单值仅作为无数组时的兜底来源。
type TaskSearchResultItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};
type TaskSearchResultRow = {
  key: string;
  task: TaskSearchResultItem;
  searchSnippet?: string;
  snippetIndex?: number;
  kind: "task" | "snippet" | "expand";
  hiddenSnippetCount?: number;
  showTaskHeader: boolean;
};

// 标题为空白时回落到「未命名」文案，避免出现无法识别、也无法点击定位的空行。
// 用 trim 判断而不是长度判断：纯空格标题在列表里和空行没有区别。
// 这里不做截断与高亮，高亮由 HighlightedMatchText 按原始文本处理。
function getTaskTitle(task: ZCodeTaskMeta, untitledLabel: string): string {
  return task.title.trim() || untitledLabel;
}

// [契约] `normalizeSnippetForDedupe` 只看正文：剥首尾省略号 → 压空白 → 转小写。
// 只剥一层首尾省略号是有意的：中间省略号代表原文跨度，剥掉会把不同片段判成同一条。
// 不处理标点与全半角，片段来自同一个索引器，编码口径本就一致。
// 改这里等价于改「什么算同一条命中」，会直接影响展开行的计数与「更多 N 条」文案。
function normalizeSnippetForDedupe(snippet: string): string {
  return snippet
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

// 数组优先、单值兜底：合并后的任务两者可能同时存在，只读单值会丢掉其他工作区的命中。
// [失败路径] 归一化后为空串的片段直接丢弃，空白片段渲染出来就是一条点不动的空行。
// 输出保留原始顺序与原始文本，去重只做过滤不做改写，高亮才能按原串定位。
// seen 存归一化值、输出存原值，这是本函数唯一要点，调换两者会让片段显示变形。
function getUniqueTaskSearchSnippets(task: TaskSearchResultItem): string[] {
  const snippets = task.searchSnippets?.length
    ? task.searchSnippets
    : task.searchSnippet
      ? [task.searchSnippet]
      : [];
  const seen = new Set<string>();
  const uniqueSnippets: string[] = [];
  for (const snippet of snippets) {
    const normalized = normalizeSnippetForDedupe(snippet);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueSnippets.push(snippet);
  }

  return uniqueSnippets;
}

// workspaceTabs 决定搜索域：只有这些工作区里的任务能被搜到，其顺序只影响标签映射。
// onSelectTask 必填、onSelectSearchResult 可选：前者真正打开任务，后者只上报命中上下文。
// openRequestId 是外部快捷键的开门信号，变化即打开；组件不反向通知调用方已关闭。
// 不要新增默认参数或调整参数顺序，仓库内多处已按现有签名注入。
export function TaskSearchDialog({
  workspaceTabs,
  onSelectTask,
  onSelectSearchResult,
  openRequestId = 0,
}: {
  workspaceTabs: WorkspaceTabState[];
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onSelectSearchResult?: (
    task: TaskSearchResultItem,
    context: { query: string; searchSnippet?: string; snippetIndex?: number },
  ) => void;
  openRequestId?: number;
}) {
  // open 由组件自己持有，触发按钮、外部信号与弹窗内部开关三方都改它，不要改成受控 prop。
  // query 保存用户原串，派生的 trimmedQuery 才参与检索与快捷键判断，两者不能合并。
  // expandedTaskKeys 用 Set 存会话 key，任何修改都必须换新实例，否则 React 不会重渲染。
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedTaskKeys, setExpandedTaskKeys] = useState<Set<string>>(() => new Set());
  const shortcutLabel = formatCommandShortcutLabel("G");
  const trimmedQuery = query.trim();
  // [权衡] 关闭时返回空数组而不是跳过 hook 调用：hook 必须无条件执行，只能从入参做空态。
  // 这里刻意不在关闭时直接透传 workspaceTabs 引用，避免关闭期也维持一份订阅。
  // 依赖只有 open 与 workspaceTabs，弹窗打开后工作区增删能立即反映到搜索域。
  const searchWorkspaceTabs = useMemo(
    () => (open ? workspaceTabs : []),
    [open, workspaceTabs],
  );
  // kind/active 与 sortBy/updated 是搜索结果的语义：只搜活动任务，并按更新时间排序。
  // expanded 固定 false 且 collapsedLimit 取结果上限：分组折叠完全由 visibleResults 自己实现。
  // searchQuery 必须传 trimmedQuery，带首尾空格的查询会被宿主当字面量匹配而搜不到。
  // 弹窗关闭时 workspaceTabs 为空，hook 走空态分支，这里不需要额外的启用开关。
  const taskList = useGlobalTaskList({
    kind: "active",
    // 修复原因：搜索弹窗组件常驻在 App 里，但未打开时不需要 recent/search 结果。
    // 传空 workspace 可以复用 useGlobalTaskList 的空态路径，避免空闲时多一组 listTaskList
    // 和 workspace 事件订阅，减轻启动期 renderer/RPC 压力。
    workspaceTabs: searchWorkspaceTabs,
    sortBy: "updated",
    searchQuery: trimmedQuery,
    expanded: false,
    collapsedLimit: TASK_SEARCH_RESULT_LIMIT,
  });
  // key 与 getTaskResultKey 同口径：身份优先、路径兜底，改一处必须同时改另一处。
  // 该映射只用于展示右侧工作区标签，缺失时渲染路径原文，不影响命中与排序。
  // 以 workspaceTabs 为依赖，工作区改名后标签立即跟随，不需要额外刷新。
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map((tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.label]),
      ),
    [workspaceTabs],
  );
  const hasQuery = trimmedQuery.length > 0;
  // [契约] 会话 key 固定为「工作区身份:任务 id」，身份缺失才退回路径。
  // 只用 taskId 做主键会让两个工作区里的同 id 任务互相覆盖，表现为搜索结果少一条。
  // 这个 key 同时用于 React key、展开集合与片段行前缀，三者必须共用一个格式。
  // 身份要用 trim 后判断，只有空白字符的身份不算有效身份。
  const getTaskResultKey = useCallback(
    (task: Pick<TaskSearchResultItem, "workspaceIdentity" | "workspacePath" | "taskId">) =>
      `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`,
    [],
  );
  // 这是本文件的核心投影：先按会话 key 合并多路 items，再决定每个任务产出几行。
  // 先建 Map 再统一遍历，保证同一任务的多条结果不会因到达顺序不同而产生两份标题。
  // rows 只在派生期构建，不写入 state，任何输入变化都靠这个 useMemo 重算。
  // 展开判断用 expandedTaskKeys.has，只对当前任务放开上限，其他任务仍受 9 条约束。
  const visibleResults = useMemo<TaskSearchResultRow[]>(() => {
    const rows: TaskSearchResultRow[] = [];
    const taskByKey = new Map<string, TaskSearchResultItem>();
    // 首次出现的任务直接登记；重复出现的任务走合并分支，片段累加而不是覆盖。
    // [并发] 查询缓存命中和跨工作区聚合可能在同一帧带回同一个任务，这里必须幂等。
    // 合并用展开语法新建对象，不修改原 item，避免污染 hook 返回的数据。
    // 合并后保留首次出现的标题、更新时间等字段，只替换片段数组。
    for (const task of taskList.items) {
      const taskKey = getTaskResultKey(task);
      const existingTask = taskByKey.get(taskKey);
      if (!existingTask) {
        taskByKey.set(taskKey, task);
        continue;
      }

      // Bugfix: 搜索结果可能从查询缓存和跨工作区聚合路径带入同一个 task。
      // 这里先按会话 key 合并，再按片段文本去重，避免列表里出现重复标题或重复摘要。
      taskByKey.set(taskKey, {
        ...existingTask,
        searchSnippets: [
          ...getUniqueTaskSearchSnippets(existingTask),
          ...getUniqueTaskSearchSnippets(task),
        ],
      });
    }

    // 无片段或没有查询时，每个任务只产出一行任务行，标题即结果。
    // 有片段时按片段拆行，snippetIndex 从 0 开始，同时作为行 key 后缀与回调入参。
    // 片段行 key 用「会话 key:序号」，同一任务内不会与任务行或展开行冲突。
    // 展开行固定排在片段之后且 showTaskHeader 为 false，不会重复渲染标题头。
    for (const task of taskByKey.values()) {
      const taskKey = getTaskResultKey(task);
      const snippets = hasQuery
        ? getUniqueTaskSearchSnippets(task)
        : [];
      if (snippets.length === 0) {
        rows.push({
          key: taskKey,
          task,
          kind: "task",
          showTaskHeader: true,
        });
      } else {
        const isExpanded = expandedTaskKeys.has(taskKey);
        const visibleSnippets = isExpanded
          ? snippets
          : snippets.slice(0, TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT);
        visibleSnippets.forEach((snippet, snippetIndex) => {
          rows.push({
            key: `${taskKey}:${snippetIndex}`,
            task,
            searchSnippet: snippet,
            snippetIndex,
            kind: "snippet",
            showTaskHeader: snippetIndex === 0,
          });
        });
        if (!isExpanded && snippets.length > TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT) {
          rows.push({
            key: `${taskKey}:expand`,
            task,
            kind: "expand",
            hiddenSnippetCount: snippets.length - TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT,
            showTaskHeader: false,
          });
        }
      }

      // [权衡] 未展开时按行数而非任务数判断上限：一个任务可能拆出多行，按任务数会超出一屏。
      // 已展开的任务跳过全局截断，否则点开「更多」后仍会被 9 行卡住。
      // break 只跳出当前循环，不销毁已构建的行，最终仍由末尾三元表达式统一截断。
      // 若改成遍历到底，上千条结果会全部建成行对象，输入每个字符都会明显卡顿。
      if (!expandedTaskKeys.has(taskKey) && rows.length >= TASK_SEARCH_RESULT_LIMIT) {
        break;
      }
    }

    // 没有展开任务时统一截断到上限；有展开任务时保留全部行，展开部分才可见。
    // 截断放在最后而非循环内，是为了先确定是否真的存在展开行。
    return expandedTaskKeys.size > 0 ? rows : rows.slice(0, TASK_SEARCH_RESULT_LIMIT);
  }, [expandedTaskKeys, getTaskResultKey, hasQuery, taskList.items]);
  const emptyLabel = taskList.loading
    ? intl.formatMessage({ id: "taskSearch.loading" })
    : intl.formatMessage({ id: hasQuery ? "taskSearch.noResults" : "taskSearch.noRecent" });

  // [契约] 展开行走独立分支：只累加展开集合就返回，不关弹窗、不回调、不清查询。
  // 普通行先上报命中上下文再打开任务，顺序反了会让下游拿到已清空的 query。
  // 上报的片段优先取当前行文本，其次退回任务上的首条片段，都没有则传 undefined。
  // 关闭与清空放在最后，保证回调执行期间弹窗状态仍是用户看到的那一份。
  const selectTask = useCallback(
    (row: TaskSearchResultRow) => {
      if (row.kind === "expand") {
        setExpandedTaskKeys((current) => new Set(current).add(getTaskResultKey(row.task)));
        return;
      }

      onSelectSearchResult?.(row.task, {
        query: trimmedQuery,
        searchSnippet: row.searchSnippet?.trim() || row.task.searchSnippet?.trim() || undefined,
        snippetIndex: row.snippetIndex,
      });
      onSelectTask(row.task.workspacePath, row.task.taskId, row.task.workspaceIdentity);
      setOpen(false);
      setQuery("");
    },
    [getTaskResultKey, onSelectSearchResult, onSelectTask, trimmedQuery],
  );
  // 任务头按钮与片段行点击的差别：头只打开任务，不上报命中上下文。
  // 因此点标题头不带 snippetIndex，下游不会出现「跳到第几条命中」的定位行为。
  // 同样在最后关闭弹窗并清空查询，保持两条路径收尾一致。
  const selectTaskHeader = useCallback(
    (task: TaskSearchResultItem) => {
      onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
      setOpen(false);
      setQuery("");
    },
    [onSelectTask],
  );

  // [失败路径] 只处理「打开且有查询」：空查询时刷新会把最近列表整表重拉一遍。
  // refresh 引用必须稳定（来自 hook 的 useCallback），否则每次渲染都会触发一次刷新。
  // 这条副作用是正文索引上线后的补偿，删掉会让新索引的命中要等缓存过期才出现。
  useEffect(() => {
    if (!open || !trimmedQuery) {
      return;
    }

    // Bugfix: 正文搜索上线后，旧的空搜索结果可能已经被 task query cache 记为 fresh。
    // 弹窗输入查询词时主动刷新一次，确保服务层新补的正文索引和按需回填逻辑能够生效。
    void taskList.refresh();
  }, [open, taskList.refresh, trimmedQuery]);

  // 查询词一变就清空展开集合：旧任务的展开态对新结果没有意义，还会影响截断判断。
  // 只依赖 trimmedQuery，同一查询下追加空白不会打断用户已展开的分组。
  useEffect(() => {
    setExpandedTaskKeys(new Set());
  }, [trimmedQuery]);

  // 仅在打开且有查询时打印，常驻组件不能在空闲期刷日志。
  // 输出条数、片段数与首条片段前 80 字符，用于确认宿主是否真的返回了正文命中。
  // 依赖包含 visibleResults，任何投影变化都会补一条，排障时注意区分重复输出。
  useEffect(() => {
    if (!open || !trimmedQuery) {
      return;
    }

    const snippetCount = visibleResults.filter((result) => result.searchSnippet?.trim()).length;
    logger.info(
      `[TaskSearchDialog] 搜索结果 query=${JSON.stringify(trimmedQuery)} items=${visibleResults.length} snippets=${snippetCount} firstSnippet=${JSON.stringify(visibleResults[0]?.searchSnippet?.slice(0, 80) ?? "")}`,
    );
  }, [open, trimmedQuery, visibleResults]);

  // 外部快捷键通过改变 openRequestId 打开弹窗；值不变的重复渲染不会再触发。
  // 初值 0 表示从未请求打开，必须显式排除，否则首屏会自动弹出搜索框。
  // 这里只置 open 为真，查询与展开集合的清空职责统一交给关闭路径。
  useEffect(() => {
    if (openRequestId <= 0) {
      return;
    }

    setOpen(true);
  }, [openRequestId]);

  // [契约] 数字直达用 1-based 序号比较，与行上展示的快捷键标签是同一套编号。
  // 命中序号必须落在可见行范围内，越界时不应拦截按键。
  // preventDefault 只在命中后执行，没有对应结果时把按键交还输入框正常输入。
  // [资源] 监听挂在 window 上，清理函数必须移除同一个 handleKeyDown，否则每次查询都叠加一个监听。
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const index = visibleResults.findIndex((_, itemIndex) =>
        matchesPrimaryShortcut(event, String(itemIndex + 1)),
      );
      if (index < 0) {
        return;
      }

      event.preventDefault();
      const result = visibleResults[index];
      if (result) {
        selectTask(result);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, selectTask, visibleResults]);

  // 返回的是「触发按钮 + 弹窗」两件套：按钮常驻，弹窗按 open 控制内部内容。
  // 外层 Fragment 是因为调用方把它放进任意布局槽位，不能引入额外 DOM 层级。
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-icon="inline-start"
        size="lg"
        className="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
      >
        <Search className="size-4" />
        <span className="min-w-0 flex-1 truncate text-left">
          {intl.formatMessage({ id: "taskSearch.button" })}
        </span>
        <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
          {shortcutLabel}
        </span>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={(nextOpen) => {
          // 关闭方向同时清空查询与展开集合，保证下次打开是干净初态。
          // 只清理关闭方向：打开瞬间清空会让外部传入的初始查询失效。
          // 清空用新的 Set 实例，直接 clear 同一个实例不会触发重渲染。
          setOpen(nextOpen);
          if (!nextOpen) {
            setQuery("");
            setExpandedTaskKeys(new Set());
          }
        }}
        title={intl.formatMessage({ id: "taskSearch.title" })}
        description={intl.formatMessage({ id: "taskSearch.description" })}
        className={quickPickDialogClassName}
      >
        <Command shouldFilter={false} className={quickPickCommandClassName}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={intl.formatMessage({ id: "taskSearch.placeholder" })}
            className={quickPickInputClassName}
          />
          <CommandList className={quickPickListClassName}>
            <CommandGroup heading={intl.formatMessage({ id: "taskSearch.recent" })}>
              {visibleResults.length === 0 ? (
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {emptyLabel}
                </CommandEmpty>
              ) : null}
              {visibleResults.map((result, index) => {
                const task = result.task;
                const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
                const workspaceLabel =
                  workspaceLabelByKey.get(task.workspaceIdentity?.trim() || task.workspacePath) ??
                  task.workspacePath;
                // [权衡] 有查询才展示片段：无查询时 result.searchSnippet 可能来自上一次请求，展示会造成幻觉。
                // 这里再 trim 一次是因为宿主可能返回带空白的片段，空串要退化成标题行。
                // 片段为空即走标题渲染分支，右侧工作区标签与时间随之出现，两条分支互斥。
                const searchSnippet = hasQuery ? result.searchSnippet?.trim() : undefined;
                const isExpandRow = result.kind === "expand";
                const showTaskHeader = result.showTaskHeader;

                return (
                  <Fragment key={result.key}>
                    {showTaskHeader && searchSnippet ? (
                      <button
                        type="button"
                        className="mt-1 flex min-w-0 w-full cursor-default items-center gap-2 rounded-md px-2.5 pb-0.5 pt-1 text-left outline-hidden first:mt-0 hover:bg-menu-hover focus-visible:bg-menu-hover"
                        onClick={() => selectTaskHeader(task)}
                      >
                        <span className="min-w-0 flex-1 truncate text-ui-base leading-5 font-normal text-foreground">
                          <HighlightedMatchText text={title} query={query} />
                        </span>
                        <CommandShortcut className={quickPickMetadataClassName}>
                          {workspaceLabel}
                        </CommandShortcut>
                        <span className="max-w-12 shrink-0 truncate font-sans text-ui-xs leading-none tracking-normal text-foreground-subtlest">
                          {formatTaskRelativeTime(task.updatedAt, intl)}
                        </span>
                      </button>
                    ) : null}
                    <CommandItem
                      value={`${title} ${workspaceLabel} ${searchSnippet ?? ""}`}
                      className={isExpandRow ? "min-h-7 items-center px-2.5 text-ui-base" : quickPickItemClassName}
                      onSelect={() => selectTask(result)}
                    >
                      {isExpandRow ? (
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-base font-normal text-foreground-subtle">
                          <ChevronDown className="size-3.5 shrink-0" />
                          <span className="truncate">
                            {intl.formatMessage(
                              { id: "taskSearch.expandMoreSnippets" },
                              { count: String(result.hiddenSnippetCount ?? 0) },
                            )}
                          </span>
                        </span>
                      ) : (
                        <>
                          <span
                            className={
                              "flex min-w-0 flex-1 flex-col justify-center py-0.5"
                            }
                          >
                            {searchSnippet ? (
                              <span className="min-w-0 truncate text-ui-base font-normal leading-4 text-foreground-subtle">
                                <HighlightedMatchText text={searchSnippet} query={query} />
                              </span>
                            ) : (
                              <span className="truncate text-ui-base leading-5 font-normal text-foreground">
                                <HighlightedMatchText text={title} query={query} />
                              </span>
                            )}
                          </span>
                          {!searchSnippet ? (
                            <>
                              <CommandShortcut className={quickPickMetadataClassName}>
                                {workspaceLabel}
                              </CommandShortcut>
                              <span className="max-w-12 shrink-0 truncate font-sans text-ui-xs tracking-normal text-foreground-subtlest">
                                {formatTaskRelativeTime(task.updatedAt, intl)}
                              </span>
                            </>
                          ) : null}
                          <span className={quickPickShortcutPillClassName}>
                            {formatCommandShortcutLabel(String(index + 1))}
                          </span>
                        </>
                      )}
                    </CommandItem>
                  </Fragment>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
