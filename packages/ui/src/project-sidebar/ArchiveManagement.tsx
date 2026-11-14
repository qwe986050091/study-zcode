// INV-01 目录上下文由外层提供：组件本身不解析主机，守住位置 外层包装；改错故障：缺少上下文时子组件拿到空目录，归档列表为空。
// INV-02 分组与项目选项都从同一棵树派生：守住位置 两个派生根值；改错故障：分组与筛选选项不同源会让筛选出空结果。
// INV-03 分组由查询、排序与项目三者共同决定：守住位置 分组派生依赖；改错故障：漏掉任一维会让改动不生效或结果滞后。
// INV-04 全部行由分组摊平而来，不单独过滤：守住位置 行派生；改错故障：另起一套过滤口径会让批量删除与可见行不一致。
// INV-05 批量删除按钮在忙碌、加载、错误与空列表时禁用：守住位置 禁用条件；改错故障：错误态仍可点击，会重复触发失败请求。
// INV-06 忙碌与错误期间禁止行内操作：守住位置 分组卡片的禁用属性；改错故障：并发操作会让同一批任务被重复处理。
// INV-07 空态区分无结果与无归档：守住位置 空态文案选择；改错故障：有数据但筛空时提示无归档，误导用户。
// INV-08 加载态优先于空态展示：守住位置 三元链顺序；改错故障：加载中先显示空态，用户以为数据已被清空。
// INV-09 错误提示独立成块，不被其它状态遮蔽：守住位置 三个独立条件块；改错故障：合并成一个分支会吞掉重试入口。
// INV-10 结果提示的角色随失败切换：守住位置 角色属性；改错故障：失败仍是状态角色，读屏不会主动播报。
// INV-11 排序控件标签放在触发器之外：守住位置 标签与触发框结构；改错故障：标签并入触发器会让装饰图标挤占文本。
// INV-12 排序值只允许两个枚举：守住位置 选项映射；改错故障：放行任意字符串会让分组收到未知排序。
// INV-13 项目筛选默认值为全部：守住位置 初始状态；改错故障：默认空串会让首屏筛不到任何分组。
// INV-14 项目选项名称包含主机与已删除标注：守住位置 名称拼接；改错故障：同名项目跨主机时无法区分。
// INV-15 搜索框清空走显式回调：守住位置 清空处理；改错故障：只更新值不清内部状态，清空按钮失效。
// INV-16 所有文案经统一消息前缀取用：守住位置 文案取值函数；改错故障：散落硬编码会让新增语言漏翻。
// INV-17 结果计数来自操作返回而非本地估算：守住位置 结果提示；改错故障：本地估算与实际删除数不符，用户质疑。
// INV-18 列表根节点的测试标识稳定：守住位置 根节点属性；改错故障：改名会让端到端用例失效或误命中。
//
// 模块职责：归档管理页的外壳，负责提供目录上下文、筛选与排序状态以及批量操作入口。
// 状态所有权：查询、排序与项目筛选为本地状态；归档数据与操作状态由管理 Hook 持有。
// 阅读顺序：先看外层包装，再看派生分组与行，最后看批量按钮、筛选区与四种状态提示。
import { useId, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildArchiveGroups,
  buildArchiveProjectOptions,
  type ArchiveGroup,
  type ArchiveSort,
} from "@/project-sidebar/archive-view.js";
import { useArchiveManagement } from "@/project-sidebar/useArchiveManagement.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { ArchiveGroupCard } from "@/project-sidebar/ArchiveGroupCard.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";

// 外壳只负责提供目录上下文，不承担任何数据逻辑
// [失败路径] 缺少上下文时内容组件拿不到目录，主机名与筛选都为空
// 拆出外壳是为让 ArchiveManagementContent 只在 ProjectDirectoryProvider 内运行。
// ArchiveManagement 不接 props，设置页任意位置都能挂载。
// ArchiveManagementContent 不重复提供上下文，避免嵌套覆盖。
export function ArchiveManagement() {
  // 正常态渲染顺序：标题与批量操作、筛选区、状态提示、列表
  // [失败路径] 批量按钮的禁用条件漏掉错误态，会在失败后重复提交
  // 批量操作的行集合来自摊平后的可见行，与列表严格一致
  // archive-filters 用 grid-cols-1 起步，sm 两列、lg 三列，label 与控件保持配对。
  // 状态提示按 state.error 与 state.loading 分块，允许两者同时出现。
  // 列表空与加载中互斥，由 !groups.length && !state.error 的三元链表达。
  return (
    <ProjectDirectoryProvider>
      <ArchiveManagementContent />
    </ProjectDirectoryProvider>
  );
}
// 文案取值统一加归档前缀，避免与其它页面键冲突
// 数据与管理动作全部来自同一个管理 Hook
// 查询、排序与项目筛选是三个独立状态，互不推导
// 排序标识由框架生成，保证同页多实例不冲突
// 组件不直接调用服务，所有动作经 Hook 转译
function ArchiveManagementContent() {
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `archives.${id}` });
  const state = useArchiveManagement();
  const sortId = useId();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ArchiveSort>("updated");
  const [project, setProject] = useState("all");
  // 全部组与筛选后组分别派生：前者只用于区分空态语义
  // [失败路径] 只保留筛选结果会让「有数据但筛空」与「本来就空」无法区分
  // allGroups 与 groups 都以 state.tree 为输入，保证口径一致。
  // projectOptions 同样来自 state.tree，避免筛选后选项自我收缩。
  // 两个 useMemo 只依赖 state.tree 引用，树不变则不重算。
  const allGroups = useMemo(() => buildArchiveGroups(state.tree), [state.tree]);
  const projectOptions = useMemo(() => buildArchiveProjectOptions(state.tree), [state.tree]);
  const groups = useMemo(
    () => buildArchiveGroups(state.tree, { query, sort, project }),
    [state.tree, query, sort, project],
  );
  const rows = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const name = (group: ArchiveGroup) => {
    const title = group.project?.name ?? msg(group.projectId ? "removedProject" : "unclassified");
    const source = state.directory.hosts.find((h) => h.id === group.hostId);
    const host = source ? remoteHostLabel(source) : undefined;
    return `${title}${group.project?.deleted ? ` · ${msg("removed")}` : ""}${host ? ` · ${host}` : ""}`;
  };
  return (
    <section data-testid="archive-management" className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-ui-xl font-medium">{msg("title")}</h2>
        <Button
          data-testid="archive-delete-all"
          variant="ghost"
          disabled={state.busy || state.loading || Boolean(state.error) || !rows.length}
          className="bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface"
          onClick={() => void state.run(rows, "delete")}
        >
          <Trash2 className="size-4" />
          {msg("deleteAll")}
        </Button>
      </div>
      <div
        data-testid="archive-filters"
        className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,13rem)]"
      >
        <SettingsSearchInput
          data-testid="archive-search"
          placeholder={msg("search")}
          aria-label={msg("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel={msg("clearSearch")}
          containerClassName="min-w-0 sm:col-span-2 lg:col-span-1"
          className="text-mobile-input-safe sm:text-ui-base"
        />
        {/* 静态标签放在触发框外，省去装饰图标；框内只保留选中值和公共下拉箭头。 */}
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor={sortId} className="shrink-0 text-ui-base text-foreground-subtle">
            {msg("sortLabel")}
          </label>
          <Select value={sort} onValueChange={(v) => setSort(v as ArchiveSort)}>
            <SelectTrigger
              id={sortId}
              data-testid="archive-sort"
              size="lg"
              className="h-9 min-w-0 flex-1"
              aria-label={msg("sortLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["updated", "created"] as const).map((value) => (
                <SelectItem key={value} value={value} data-testid={`archive-sort-${value}`}>
                  {msg(`sort.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger
            data-testid="archive-project-filter"
            size="lg"
            className="h-9 w-full min-w-0"
            aria-label={msg("projectLabel")}
          >
            <SelectValue placeholder={msg("allProjects")} />
          </SelectTrigger>
          <SelectContent className="max-w-[var(--radix-select-trigger-width)]">
            <SelectItem value="all" data-testid="archive-project-all">
              {msg("allProjects")}
            </SelectItem>
            {projectOptions.map((group) => (
              <SelectItem
                key={group.key}
                value={group.key}
                data-testid={`archive-project-option-${group.projectId ?? "unclassified"}`}
              >
                <span className="truncate">{name(group)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {state.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-ui-base text-destructive"
        >
          <span>{msg("loadFailed")}</span>
          <Button variant="outline" onClick={() => void state.refresh()}>
            {msg("retry")}
          </Button>
        </div>
      ) : null}
      {state.busy ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {msg("working")}
        </p>
      ) : null}
      {state.result ? (
        <p
          role={state.result.failed ? "alert" : "status"}
          className="text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage({ id: "archives.result" }, state.result)}
        </p>
      ) : null}
      {state.loading ? (
        <p role="status" className="py-8 text-ui-base text-foreground-subtle">
          {msg("loading")}
        </p>
      ) : !groups.length && !state.error ? (
        <p className="py-12 text-center text-ui-base text-foreground-subtle">
          {msg(allGroups.length ? "noResults" : "empty")}
        </p>
      ) : (
        // ArchiveGroupCard 用 group.key 作为行键，筛选变化时保持身份稳定。
        // name(group) 返回拼接好的项目名、主机名与删除标记。
        // disabled 与批量按钮同源：state.busy 或 state.error 为真即禁用。
        // 行内动作与管理 Hook 的操作入口复用同一函数
        // 排序值透传给卡片，保证组内顺序与筛选区一致
        // 全部组为空时才展示空态，否则渲染分组列表
        groups.map((group) => (
          <ArchiveGroupCard
            key={group.key}
            group={group}
            name={name(group)}
            sort={sort}
            disabled={state.busy || Boolean(state.error)}
            onAction={state.run}
          />
        ))
      )}
    </section>
  );
}
