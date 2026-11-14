// 文件职责：模型调用轨迹面板的展示投影层，负责把 useModelTrajectory 的结果
// 解析成时间线、汇总行与搜索索引，并把展开、覆盖、搜索定位三套交互状态下发到子组件。
// 边界：本文件不发起请求、不持久化状态、不解析协议，records 的获取与去重由 hook 负责；
// 不负责时间线内部的节点渲染、搜索匹配算法与高亮 DOM 操作，这些分别落在 Timeline、Search、SearchHighlight。
//
// 不变量表：
// INV-01 断言：本组件只做展示投影，不复制也不改写 records —— 守住它的位置：records/summary/timelineItems 三处 useMemo —— 改错故障：刷新后新旧轨迹两份真相并存，展开与搜索指向过期节点
// INV-02 断言：取数 hook 必须同时收到 workspacePath 与 workspaceIdentity —— 守住它的位置：顶部 useModelTrajectory 调用 —— 改错故障：远程工作区串到同名本地路径，展示他人轨迹
// INV-03 断言：搜索索引与传给时间线的查询一律用延迟后的查询值 —— 守住它的位置：searchIndex 与 Timeline 的 query 入参 —— 改错故障：每次按键全量重建索引，长轨迹输入明显卡顿
// INV-04 断言：搜索命中下标恒被夹在 0 到命中数减一的区间，无命中时为 -1 —— 守住它的位置：resolvedSearchActiveIndex —— 改错故障：删字后下标越界，高亮与上下跳转指向不存在的项
// INV-05 断言：展开命令对象只做惰性初始化一次 —— 守住它的位置：useState(createTrajectoryExpansionCommands) —— 改错故障：每次渲染产生新对象，下游 context 全量重渲染并丢失展开状态
// INV-06 断言：每次切换展开都自增版本号，并把同一版本写进受影响的 kind —— 守住它的位置：handleToggleAll 与 handleToggleExpansionKind —— 改错故障：时间线按旧版本复用缓存，点击无反应或展开错行
// INV-07 断言：批量切换清空逐条覆盖，单类切换保留覆盖 —— 守住它的位置：handleToggleAll 里的空 Map 写入 —— 改错故障：批量展开后个别节点仍停留在旧的覆盖状态
// INV-08 断言：覆盖表每次写入都新建 Map，不原地修改 —— 守住它的位置：setExpansionOverride —— 改错故障：引用不变使 memo 与 context 不更新，逐条展开点了没效果
// INV-09 断言：批量切换的目标态在回调内用最新命令现算 —— 守住它的位置：handleToggleAll 首行的 some 判断 —— 改错故障：快速连点读到渲染期快照，两次点击互相抵消
// INV-10 断言：搜索翻页先夹取当前下标再对命中数取模 —— 守住它的位置：handleSearchMove —— 改错故障：命中集缩小后按上一条直接跳到末尾这一错误位置
// INV-11 断言：关闭搜索必须清掉命令式 DOM 高亮 —— 守住它的位置：handleCloseSearch 里的清理调用 —— 改错故障：面板关闭搜索后正文仍残留高亮标记，重新打开定位错乱
// INV-12 断言：源目录取首个非空 sourceFiles 的父目录，缺失时必须是 null —— 守住它的位置：getModelTrajectorySourceDirectory —— 改错故障：目录按钮常驻但路径为空，点击后无响应或打开错误位置
// INV-13 断言：打开目录的两种失败（返回失败与抛异常）都记 warn 并提示用户 —— 守住它的位置：handleOpenSourceDirectory 的 try 与 catch —— 改错故障：平台静默失败，用户以为目录已打开却看不到窗口
// INV-14 断言：滚动容器保持原生纵向滚动，不换成 ScrollArea —— 守住它的位置：scrollContainerRef 所在的滚动 div —— 改错故障：内容层被注入表格布局撑宽，长轨迹出现横向抖动
// INV-15 断言：错误与空态优先于时间线，loading 只在无记录时占位 —— 守住它的位置：返回体里的条件渲染链 —— 改错故障：刷新瞬间闪回空态，或错误提示与旧轨迹同时可见
// INV-16 断言：展开命令、覆盖注册表、搜索定位三层 Provider 必须包住时间线且顺序不变 —— 守住它的位置：时间线外层嵌套 —— 改错故障：时间线取不到上下文，展开与搜索定位全部失效
// INV-17 断言：截断提示必须常驻渲染在滚动内容的末尾 —— 守住它的位置：滚动容器内时间线之后的条件段落 —— 改错故障：截断数据被当成完整轨迹，用户漏看后半段调用
import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import {
  FolderOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useModelTrajectory } from "@/hooks/useModelTrajectory.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import { logger } from "@/logger.js";
import {
  TrajectoryExpansionCommandContext,
  TrajectoryExpansionRegistryContext,
  TRAJECTORY_EXPANSION_KINDS,
  createTrajectoryExpansionCommands,
  type TrajectoryExpansionOverride,
} from "@/ModelTrajectoryExpansion.js";
import { ModelTrajectoryExpansionMenu } from "@/ModelTrajectoryExpansionMenu.js";
import {
  buildTrajectorySearchIndex,
  TrajectorySearchRevealContext,
} from "@/ModelTrajectorySearch.js";
import { ModelTrajectorySearchBar } from "@/ModelTrajectorySearchBar.js";
import { clearTrajectorySearchHighlights } from "@/ModelTrajectorySearchHighlight.js";
import {
  ModelTrajectoryTimeline,
  resolveTrajectoryTimelineItems,
} from "@/ModelTrajectoryTimeline.js";
import type { TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";
import { EmptyState, summarizeRecords } from "@/ModelTrajectoryPaneParts.js";

// [契约] 入参里 taskId 供日志与标题悬浮提示使用，workspacePath 只用于取数，二者不可互换
// [契约] workspaceIdentity 仅参与身份隔离，绝不参与路径拼接或目录展示
// 标题优先取外部传入值，空白串等同未提供，回退到 i18n 默认文案
// onClose 缺省时不渲染关闭按钮，由父层自行决定面板生命周期
export function ModelTrajectoryPane({
  taskId,
  title,
  workspacePath,
  workspaceIdentity,
  onClose,
}: {
  taskId: string;
  title?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  onClose?: () => void;
}) {
  // [契约] 所有可见文案与 aria 标签统一走 intl.formatMessage，本文件不硬编码中文
  // [失败路径] 缺失文案 id 时由 IntlProvider 告警回退，不能在这里补本地字符串掩盖
  // [契约] 平台能力只经 usePlatform 取得，禁止直接访问 window 上的注入对象
  // 声明顺序固定：先拿国际化与平台，后续 hook、回调和 JSX 都依赖它们
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  // [契约] 轨迹数据源唯一在这里，组件内不再发第二个请求
  // [并发] 入参变化即重新取数，旧请求不得覆盖新请求，该保证由 hook 侧承担
  // loading 与 data 可以同时为真，刷新时旧轨迹继续可见，不要据此清空列表
  // error 只代表本轮取数失败，不清空已有 data，降级方式由下方渲染链决定
  const { loading, data, error, refresh } = useModelTrajectory(
    workspacePath,
    taskId,
    workspaceIdentity,
  );

  // data 未到达时统一给空数组，避免下游每个 useMemo 都写判空分支
  // records 每轮可能换引用，因此汇总与时间线解析必须用 useMemo 缓存
  // 不要在渲染期对 records 再排序或过滤，展示顺序由时间线解析统一决定
  // [契约] sourceFiles 原样透传，打开目录失败时日志要完整带上它便于还原现场
  const records = data?.records ?? [];
  const sourceFiles = data?.sourceFiles;
  // [资源] 目录只在 sourceFiles 变化时重算，避免每次渲染都做路径切分
  // [契约] 取第一个非空源文件所在目录，而不是全部文件的公共父目录
  // sourceFiles 为 undefined 或空数组都归一到 null，目录按钮据此整体隐藏
  // 此处不校验目录是否仍存在，平台调用失败由打开流程统一反馈
  const sourceDirectory = useMemo(
    () => getModelTrajectorySourceDirectory(sourceFiles),
    [sourceFiles],
  );
  // 汇总只关心调用次数、token 总量与模型集合，聚合规则收敛在 PaneParts 内
  // token 总数为 0 时不渲染该片段，避免展示无意义的零值
  // 模型名按逗号拼接后交给 CSS 截断，不在这里做字符串裁剪
  // [权衡] 聚合与渲染解耦，记录再多也只遍历一次
  const summary = useMemo(() => summarizeRecords(records), [records]);
  // [契约] 时间线项目由解析函数统一产出，搜索索引与渲染共用这一份结果
  // [权衡] 搜索索引建立在解析后的项目上，保证命中项与可见行一一对应
  // records 引用不变时复用结果，展开状态不参与解析，避免展开引发全量重算
  // 解析顺序即展示顺序，此处不得再插入排序或去重
  const timelineItems = useMemo(() => resolveTrajectoryTimelineItems(records), [records]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  // [并发] 输入框值即时更新，索引构建使用延迟值，按键不被同步搜索阻塞
  // [契约] 延迟值只服务索引与高亮，计数与文案不要混用两个查询值
  // 搜索框关闭后延迟值可能仍落后一拍，状态复位统一放在关闭回调里
  // [权衡] 搜索是同步遍历，牺牲一拍延迟换取长轨迹输入流畅
  const deferredSearchQuery = useDeferredValue(searchQuery);
  // [契约] 索引构建入参顺序固定为项目在前、查询在后，调换会得到空结果
  // 命中项携带展开键，搜索定位时据此驱动时间线展开到对应节点
  // 空查询时索引返回空命中集而非空值，渲染层依赖其结构稳定
  // 依赖只保留延迟查询与时间线项目，混入活动下标会导致每次翻页都重建
  // [并发] 索引随延迟查询整体替换，活动命中项可能短暂指向旧索引，读取前必须夹取
  const searchIndex = useMemo(
    () => buildTrajectorySearchIndex(timelineItems, deferredSearchQuery),
    [deferredSearchQuery, timelineItems],
  );
  // [失败路径] 命中数变少时旧下标会越界，这里必须夹取而不是直接丢弃
  // 无命中时固定为 -1，供搜索条展示零比零并禁用上下翻页
  // [契约] 活动命中项允许为空，时间线据此决定是否滚动定位
  // 不要在此回写活动下标，渲染期写状态会多出一轮更新并可能死循环
  const resolvedSearchActiveIndex =
    searchIndex.matches.length === 0
      ? -1
      : Math.min(searchActiveIndex, searchIndex.matches.length - 1);
  const activeSearchMatch =
    resolvedSearchActiveIndex >= 0
      ? (searchIndex.matches[resolvedSearchActiveIndex] ?? null)
      : null;
  // [契约] 使用惰性初始化，展开命令工厂只在首次渲染执行一次
  // [并发] 命令对象是展开状态唯一真源，时间线只读，禁止在子层回写形成双写
  // 不要改成 useMemo 或对象字面量，否则每次渲染都会重置展开状态
  // 命令里的版本号字段随切换自增，是下游缓存失效的唯一信号
  const [expansionCommands, setExpansionCommands] = useState(createTrajectoryExpansionCommands);
  // [并发] 版本号放在 ref 里，自增不触发渲染，避免与状态更新互相追赶
  // 每次切换先自增再读取，保证同一事件内写出的多个 kind 共享同一版本
  // [契约] 版本号只做下游缓存失效信号，不参与任何显示或持久化
  // [失败路径] 若把自增放进状态更新回调，快速连点可能得到重复版本，节点不刷新
  // 不要改成 state：版本递增本身不应带来额外渲染轮次
  const expansionVersionRef = useRef(0);
  // [契约] 覆盖表按节点键存储，空 Map 表示全部回到默认展开策略
  // [权衡] 用 Map 而非普通对象，节点键可能含特殊字符，规避原型链键冲突
  // 批量切换必须整体清空，否则逐条覆盖会压过新的全局状态
  // [并发] 任何写入都构造新 Map，供 memo 依赖做引用比较
  const [expansionOverrides, setExpansionOverrides] = useState(
    () => new Map<string, TrajectoryExpansionOverride>(),
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // [契约] 只要还有一类未展开，批量按钮就表现为展开全部
  // 图标与无障碍文案都由该布尔量派生，保证语义与视觉一致
  // [失败路径] 不要用全部已展开取反代替存在未展开，两者在空集合下结果相反
  const willExpandAll = TRAJECTORY_EXPANSION_KINDS.some(
    (kind) => !expansionCommands[kind].expanded,
  );
  const toggleAllLabel = intl.formatMessage({
    id: willExpandAll ? "modelTrajectory.expandAll" : "modelTrajectory.collapseAll",
  });
  // [事务] 一次批量切换是整体：清覆盖、定版本、写全部类别必须同批完成
  // [并发] 目标态在此处依据最新命令现算，不复用渲染期的批量按钮判断
  // 先自增版本再写入命令，保证下游只在版本变化时重建展开节点
  // [失败路径] 若保留旧覆盖，批量展开后个别节点仍维持原状，用户会认为漏点
  // 依赖列表必须保留命令快照，去掉会读到陈旧闭包并反复切换同一方向
  const handleToggleAll = useCallback(() => {
    const expanded = TRAJECTORY_EXPANSION_KINDS.some((kind) => !expansionCommands[kind].expanded);
    expansionVersionRef.current += 1;
    const version = expansionVersionRef.current;
    setExpansionOverrides(new Map());
    setExpansionCommands(
      Object.fromEntries(
        TRAJECTORY_EXPANSION_KINDS.map((kind) => [kind, { expanded, version }]),
      ) as ReturnType<typeof createTrajectoryExpansionCommands>,
    );
  }, [expansionCommands]);
  // [契约] 单类切换用函数式更新，并发点击不会互相覆盖
  // 只改目标类别，其余类别保持原对象引用，减少下游重渲染
  // [事务] 同一次点击内所有相关写入共享同一版本号，便于按类别维度失效缓存
  // 这里不清空覆盖表：单类切换不应抹掉用户逐条调整过的节点
  const handleToggleExpansionKind = useCallback((kind: TrajectoryVisualRole) => {
    expansionVersionRef.current += 1;
    const version = expansionVersionRef.current;
    setExpansionCommands((previous) => ({
      ...previous,
      [kind]: { expanded: !previous[kind].expanded, version },
    }));
  }, []);
  const handleSearchQueryChange = useCallback((query: string) => {
    setSearchQuery(query);
    setSearchActiveIndex(0);
  }, []);
  // [失败路径] 命中数为 0 时直接返回，避免对零取模得到非法下标
  // [契约] 位移前先夹取当前下标，命中集缩小后不会跳到错误位置
  // 循环取模实现首尾相接，向下越界回到第一条，向上越界回到最后一条
  // 依赖只放命中数，函数式更新保证连续快速翻页不丢步
  const handleSearchMove = useCallback(
    (direction: "previous" | "next") => {
      const count = searchIndex.matches.length;
      if (count === 0) return;
      setSearchActiveIndex((current) => {
        const resolved = Math.min(current, count - 1);
        return direction === "next" ? (resolved + 1) % count : (resolved - 1 + count) % count;
      });
    },
    [searchIndex.matches.length],
  );
  // [资源] 关闭时清空命令式高亮，DOM 标记由外部函数维护，必须手动回收
  // [事务] 查询、下标、开关三者一起复位，否则下次打开会沿用旧定位
  // 不要保留最后一次查询，重新打开应按全新搜索从第一条开始
  // 已暂停的延迟查询不需要额外同步，索引会随空查询自然退化
  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchActiveIndex(0);
    clearTrajectorySearchHighlights();
  }, []);
  const setExpansionOverride = useCallback((key: string, override: TrajectoryExpansionOverride) => {
    setExpansionOverrides((previous) => {
      const next = new Map(previous);
      next.set(key, override);
      return next;
    });
  }, []);
  const expansionRegistry = useMemo(
    () => ({ overrides: expansionOverrides, setOverride: setExpansionOverride }),
    [expansionOverrides, setExpansionOverride],
  );
  // [失败路径] 没有可用目录时直接返回且不弹提示，避免空态反复打扰
  // 平台调用统一等待，成功静默返回，失败进入两条明确分支
  // [契约] 返回失败与抛异常共用同一组日志字段，便于按前缀检索告警
  // 日志必须带任务号与完整源文件列表，排查时才能还原是哪个任务的哪个文件
  // [资源] 不缓存打开结果，目录可能被外部删除，每次点击都重新尝试
  const handleOpenSourceDirectory = useCallback(async () => {
    if (!sourceDirectory) {
      return;
    }

    try {
      const result = await platform.openInFileManager(sourceDirectory);
      if (result.success) {
        return;
      }

      logger.warn("[ModelTrajectoryPane] 打开调用轨迹目录失败", {
        taskId,
        path: sourceDirectory,
        sourceFiles: sourceFiles ?? [],
        error: result.error ?? "unknown-error",
      });
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    // [失败路径] 捕获后只记 warn 与提示用户，不让异常冒泡打断面板渲染
    // 异常对象可能是任意值，写日志前统一收敛成字符串
    // [契约] 两条失败分支的提示文案与日志前缀必须一致，便于告警去重
    // 不要改成静默吞掉：用户会误以为目录已经打开
    } catch (openError) {
      logger.warn("[ModelTrajectoryPane] 打开调用轨迹目录失败", {
        taskId,
        path: sourceDirectory,
        sourceFiles: sourceFiles ?? [],
        error: openError instanceof Error ? openError.message : String(openError),
      });
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [intl, platform, sourceDirectory, sourceFiles, taskId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-col px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1" title={taskId}>
            <span className="block truncate text-ui-base font-medium text-foreground">
              {title?.trim() || intl.formatMessage({ id: "modelTrajectory.title" })}
            </span>
          </div>
          {records.length > 0 ? (
            <Button
              data-trajectory-search-trigger=""
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground"
              onClick={() => setSearchOpen(true)}
              aria-label={intl.formatMessage({ id: "modelTrajectory.search" })}
              title={intl.formatMessage({ id: "modelTrajectory.search" })}
            >
              <SearchIcon className="size-3.5" />
            </Button>
          ) : null}
          {records.length > 0 ? (
            <ModelTrajectoryExpansionMenu
              commands={expansionCommands}
              onToggle={handleToggleExpansionKind}
              intl={intl}
            />
          ) : null}
          {records.length > 0 ? (
            <Button
              data-trajectory-toggle-all=""
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-foreground"
              onClick={handleToggleAll}
              aria-label={toggleAllLabel}
              title={toggleAllLabel}
            >
              {willExpandAll ? (
                <Maximize2Icon className="size-3.5" />
              ) : (
                <Minimize2Icon className="size-3.5" />
              )}
            </Button>
          ) : null}
          {sourceDirectory ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void handleOpenSourceDirectory()}
              aria-label={intl.formatMessage({ id: "modelTrajectory.openSourceDirectory" })}
              title={`${intl.formatMessage({ id: "modelTrajectory.openSourceDirectory" })}: ${sourceDirectory}`}
            >
              <FolderOpenIcon className="size-4" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={refresh}
            aria-label={intl.formatMessage({ id: "modelTrajectory.refresh" })}
            title={intl.formatMessage({ id: "modelTrajectory.refresh" })}
          >
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
          </Button>
          {onClose ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={intl.formatMessage({ id: "modelTrajectory.close" })}
              title={intl.formatMessage({ id: "modelTrajectory.close" })}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
        {records.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-xs text-foreground-subtle">
            <span>
              {intl.formatMessage(
                { id: "modelTrajectory.summaryCalls" },
                { count: String(records.length) },
              )}
            </span>
            {summary.totalTokens > 0 ? (
              <span
                className="font-mono"
                title={intl.formatMessage({ id: "modelTrajectory.summaryTokens" })}
              >
                · {summary.totalTokens.toLocaleString()} tok
              </span>
            ) : null}
            {summary.models.length > 0 ? (
              <span className="min-w-0 truncate font-mono">· {summary.models.join(", ")}</span>
            ) : null}
          </div>
        ) : null}
        {searchOpen && records.length > 0 ? (
          <ModelTrajectorySearchBar
            query={searchQuery}
            activeIndex={resolvedSearchActiveIndex}
            matchCount={searchIndex.matches.length}
            onQueryChange={handleSearchQueryChange}
            onMove={handleSearchMove}
            onClose={handleCloseSearch}
            intl={intl}
          />
        ) : null}
      </header>
      <div data-trajectory-header-divider="" className="h-px shrink-0 bg-border" />

      {/* Radix ScrollArea 会注入 display: table 的内容层，使长轨迹参与异常宽度计算；这里仅需原生纵向滚动。 */}
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {error ? (
          <EmptyState
            tone="error"
            text={intl.formatMessage({ id: "modelTrajectory.error" })}
            detail={error}
          />
        ) : loading && records.length === 0 ? (
          <EmptyState text={intl.formatMessage({ id: "modelTrajectory.loading" })} />
        ) : records.length === 0 ? (
          <EmptyState text={intl.formatMessage({ id: "modelTrajectory.empty" })} />
        ) : (
          <TrajectoryExpansionCommandContext.Provider value={expansionCommands}>
            <TrajectoryExpansionRegistryContext.Provider value={expansionRegistry}>
              <TrajectorySearchRevealContext.Provider
                value={activeSearchMatch?.expansionKey ?? null}
              >
                <ModelTrajectoryTimeline
                  items={timelineItems}
                  searchQuery={searchIndex.query}
                  searchMatches={searchIndex.matches}
                  activeSearchMatch={activeSearchMatch}
                  intl={intl}
                  scrollContainerRef={scrollContainerRef}
                />
              </TrajectorySearchRevealContext.Provider>
            </TrajectoryExpansionRegistryContext.Provider>
          </TrajectoryExpansionCommandContext.Provider>
        )}

        {data?.truncated ? (
          <p className="px-3 py-2 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "modelTrajectory.truncatedNotice" })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export {
  resolveTrajectoryInputMessages,
  resolveTrajectoryTimelineItems,
} from "@/ModelTrajectoryTimeline.js";

export function getModelTrajectorySourceDirectory(
  sourceFiles: readonly string[] | undefined,
): string | null {
  const sourceFile = sourceFiles?.find((path) => path.trim().length > 0);
  return sourceFile ? getContainingDirectoryPath(sourceFile) : null;
}
