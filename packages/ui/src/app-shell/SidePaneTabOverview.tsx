// INV-01 空态与列表共用同一对长度判断，显示占位和显示条目是同一份数据的互斥结果；守住位置 hasAnySearchResult 与两处条件渲染；改错故障 列表非空却显示「无结果」，用户以为页签全部丢失。
// INV-02 每个分组只在自身有命中时渲染，两个分组独立判空；守住位置 filteredTabItems 与 filteredRecentClosedItems 的长度分支；改错故障 空分组仍输出一行标题，菜单出现无内容的分隔线。
// INV-03 无结果时占位必须放在带 openTabs 标题的 CommandGroup 内，与有结果时的标题节奏一致；守住位置 hasAnySearchResult 为假的分支；改错故障 占位脱离分组后标题消失、弹层高度骤变，用户以为弹层没加载完。
// INV-04 弹层关闭时必须同时清空 query；守住位置 onOpenChange 的 nextOpen 为假分支；改错故障 重开时残留上次关键词，列表被静默过滤成「页签少了」。
// INV-05 关键词只由 CommandInput 写入，筛选路径只读不写；守住位置 query state 与 queryParts 派生；改错故障 外部改写 query 绕过归一化缓存，输入框与列表不同步。
// INV-06 命中顺序完全由 filterAndRankSearchItems 决定，组件内不再排序；守住位置 两个 filtered 系列 memo；改错故障 二次排序覆盖 rank，键盘上下移动与视觉顺序不一致。
// INV-07 shouldFilter 必须保持为 false，否则 cmdk 会按 value 二次过滤已排好序的结果；守住位置 Command 的 shouldFilter 属性；改错故障 中文标题被默认匹配吞掉，存在该页签却搜不到。
// INV-08 打开分组的选中态只按 tab.id 与 activeTabId 相等判定，不按标题比对；守住位置 isActive 计算；改错故障 同名页签一起高亮，用户无法判断哪一个是当前页。
// INV-09 已关闭分组不渲染关闭按钮，也不参与 activeTabId 比较；守住位置 recentClosedItems 的渲染分支；改错故障 对已销毁页签重复触发关闭，父层面板状态被误清。
// INV-10 行选中只调用 onActivateTab 或 onReopenClosedTab 并立即关闭弹层；守住位置 两处 onSelect；改错故障 弹层不关，用户误判点击无效而反复点击，产生重开风暴。
// INV-11 行内关闭按钮必须在 pointerdown 与 click 上都阻断冒泡与默认行为；守住位置 close Button 的两个事件处理器；改错故障 点关闭先激活该页签再关掉它，面板闪回后再消失。
// INV-12 关闭按钮的 aria-label 必须携带页签标题；守住位置 labels.closeTab 的入参来源；改错故障 读屏用户面对一排同名「关闭」，无法定位目标页签。
// INV-13 时间基准的定时器只在弹层打开期间存在，关闭或卸载必须清理；守住位置 useEffect 的 open 分支与 cleanup；改错故障 隐藏的概览仍每分钟 setState，持续触发无意义重渲染。
// INV-14 相对时间一律以 currentTime 为基准，openedAt 缺失时退回 currentTime 而不是 0；守住位置 openedAtLabel 构造；改错故障 缺少时间戳的行显示极大时长，时间列失去可比性。
// INV-15 两个构造 memo 的依赖必须逐个列出 labels 字段与 relativeTime，不得只依赖 labels 对象；守住位置 两处依赖数组；改错故障 切换语言后标题与提示停在旧语言，看起来像未生效。
// INV-16 分组标题只由 CommandGroup 的 heading 与 cmdk-group-heading 类名提供，本文件不额外包标题元素；守住位置 三处 CommandGroup；改错故障 出现两份标题或标题脱离 role，读屏层级错乱。
// INV-17 触发按钮必须同时具备 type 为 button 与 aria-label，弹层展开状态交给 Popover 管理；守住位置 PopoverTrigger 内的 Button；改错故障 入口被放进表单时点击触发提交，纯图标按钮无可读名称。
// INV-18 列表顺序沿用入参 tabs 与 recentClosedTabs 的原始顺序，组件内不重排；守住位置 两个 map 构造；改错故障 每次渲染顺序抖动，用户按记忆点击却命中相邻项。
// INV-19 已关闭项只读取 tab.id 与展示字段，不触碰其运行时资源；守住位置 recentClosedItems 的字段读取；改错故障 访问已销毁页签的运行时句柄，概览在打开瞬间抛错。
import { useEffect, useMemo, useState } from "react";
import { ChevronsDownIcon, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  buildSearchFields,
  filterAndRankSearchItems,
  normalizeSearchQuery,
} from "@/app-shell/sidePaneTabSearch.js";
import { SidePaneTabIcon } from "@/app-shell/SidePaneTabTrigger.js";
import {
  getLocalizedSidePaneTabTitle,
  getSidePaneTabSearchHint,
  getSidePaneTabTypeLabel,
  type SidePaneTabPresentationLabels,
} from "@/app-shell/sidePaneTabPresentation.js";
import type { RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

export function SidePaneTabOverview({
  tabs,
  activeTabId,
  recentClosedTabs,
  labels,
  onActivateTab,
  onCloseTab,
  onReopenClosedTab,
}: {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
  recentClosedTabs: RecentClosedSidePaneTab[];
  labels: SidePaneTabPresentationLabels & {
    title: string;
    searchPlaceholder: string;
    openTabs: string;
    recentlyClosedTabs: string;
    noResults: string;
    closeTab: (title: string) => string;
    relativeTime: (timestamp: number) => string;
  };
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReopenClosedTab: (tabId: string) => void;
}) {
  // 三个 state 都是本组件私有：弹层开合、搜索词与相对时间基准互不共享，父层只通过 props 下传数据与回调。
  // [资源] currentTime 用惰性初始化而非直接取值，避免每次渲染都读一次系统时间，导致下面 memo 的依赖每帧抖动。
  // query 初值固定为空串，不在挂载时读取任何外部状态，保证首次打开看到的是完整列表而不是被记忆的关键词过滤后的结果。
  // [权衡] 没有把三个值合成一个对象：分开后改 query 只击穿依赖 query 的 memo，时间基准推进不会连带重算搜索词相关派生。
  // [失败路径] 父层传入空 tabs 时这里不做兜底，空列表由下面的占位分支统一呈现，避免在数据层塞假条目。
  // 该行之后所有派生数据都走 useMemo，state 到渲染之间不再有新增副作用。
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const queryParts = useMemo(() => normalizeSearchQuery(query), [query]);
  // 把每个页签一次性规整成「标题 + 提示 + 类型标签 + 时间文案 + 检索字段」的展示项，后续筛选与渲染只读这份结构。
  // 标题、提示与类型标签都走 sidePaneTabPresentation 的本地化函数，保证与触发按钮和页头同源，不在此处拼字符串。
  // openedAt 缺失时退回 currentTime，否则相对时间会算成一个几十年的跨度，时间列失去意义。
  // [并发] 依赖数组逐个列出 labels 字段：labels 对象每次父层渲染都是新引用，直接依赖对象会让 memo 永久失效。
  // [权衡] 依赖 currentTime 是刻意的，时间基准每分钟推进一次让「x 分钟前」跟着刷新，代价是每分钟重算一次整表。
  // searchFields 由 buildSearchFields 预先拼好，避免筛选阶段对每个条目重复拼接同一段字符串。
  // 返回值保持入参 tabs 的顺序，不在这里排序，排序职责只属于 filterAndRankSearchItems。
  const tabItems = useMemo(
    () =>
      tabs.map((tab) => {
        const title = getLocalizedSidePaneTabTitle(tab, labels);
        const hint = getSidePaneTabSearchHint(tab);
        const typeLabel = getSidePaneTabTypeLabel(tab, labels);
        return {
          tab,
          title,
          hint,
          openedAtLabel: labels.relativeTime(tab.openedAt ?? currentTime),
          searchFields: buildSearchFields(title, hint, typeLabel),
        };
      }),
    [
      currentTime,
      labels.browserTitle,
      labels.codeViewerTitle,
      labels.relativeTime,
      labels.reviewTitle,
      labels.treemappingTitle,
      labels.whiteboardTitle,
      labels.developerToolsTitle,
      labels.terminalTitle,
      labels.subagentTypeLabel,
      tabs,
    ],
  );
  // 已关闭项与打开项走同一套本地化与检索字段构造，保证同一个页签在两组里的标题和命中口径完全一致。
  // closedAtLabel 取 item.closedAt 而非 tab.openedAt，展示的是关闭时刻，与打开分组的时间列语义区分开。
  // [失败路径] 已关闭项对应的页签可能已被真正销毁，这里只读 tab.id 与展示字段，不访问其运行时资源。
  // [并发] 依赖同样逐个展开 labels 字段；recentClosedTabs 由父层传入，引用不变时本 memo 不会重算。
  // [权衡] 不复用 tabItems 的结果：两组的时间字段与依赖不同，强行合并会让任一组的更新拖着重算另一组。
  // 这里不把已关闭项并入打开分组，避免同一 id 在列表里出现两次、被键盘选中两次。
  const recentClosedItems = useMemo(
    () =>
      recentClosedTabs.map((item) => {
        const title = getLocalizedSidePaneTabTitle(item.tab, labels);
        const hint = getSidePaneTabSearchHint(item.tab);
        const typeLabel = getSidePaneTabTypeLabel(item.tab, labels);
        return {
          item,
          title,
          hint,
          closedAtLabel: labels.relativeTime(item.closedAt),
          searchFields: buildSearchFields(title, hint, typeLabel),
        };
      }),
    [
      currentTime,
      labels.browserTitle,
      labels.codeViewerTitle,
      labels.relativeTime,
      labels.reviewTitle,
      labels.treemappingTitle,
      labels.whiteboardTitle,
      labels.developerToolsTitle,
      labels.terminalTitle,
      labels.subagentTypeLabel,
      recentClosedTabs,
    ],
  );
  // 筛选与排序都在 filterAndRankSearchItems 内一次完成，本组件只按组渲染结果，不做任何二次过滤。
  // queryParts 由 normalizeSearchQuery 归一化后缓存，同一关键词反复输入不会让下游重复分词。
  // [权衡] 两组合并成一次遍历更省，但分组渲染需要知道每条命中属于哪一组，分开算才能让空分组整组消失。
  // [失败路径] 关键词无命中时这里得到空数组而非 undefined，后续长度判断与 map 都不需要额外判空。
  // 命中结果顺序即渲染顺序，键盘上下移动与视觉顺序一致，不依赖 DOM 顺序兜底。
  // 该列表只依赖 queryParts 与 tabItems，打开或关闭弹层本身不会触发重新过滤。
  const filteredTabItems = useMemo(
    () => filterAndRankSearchItems(tabItems, queryParts),
    [queryParts, tabItems],
  );
  const filteredRecentClosedItems = useMemo(
    () => filterAndRankSearchItems(recentClosedItems, queryParts),
    [queryParts, recentClosedItems],
  );
  // 空态与两个分组共用同一对长度判断，保证「显示占位」和「显示列表」是同一份数据的互斥结果。
  // [失败路径] 若空态改成只看 query 是否为空，清空关键词但列表本身为空时会显示占位，等于把空列表伪装成无结果。
  // 总判定用或运算合并没有分别判断，避免两个分组各自渲染占位、同一个提示出现两次。
  // filteredTabItems 为空而 filteredRecentClosedItems 非空时 hasAnySearchResult 仍为真：只渲染已关闭分组，不显示占位。
  // [权衡] 该布尔值每次渲染重算而不加 memo：它只是两次长度比较，比维护额外依赖更便宜也更难写错。
  // 它只影响占位分支，不参与分组是否渲染的判断，两者分开才能让空分组独立隐藏。
  // 计数口径与渲染口径同源，将来新增第三个分组必须同步扩展这一行，否则占位在新分组上失灵。
  const hasAnySearchResult = filteredTabItems.length > 0 || filteredRecentClosedItems.length > 0;

  useEffect(() => {
    // [资源] 定时器只在弹层打开期间存在：关闭时立即返回，不注册任何 interval，避免隐藏状态下的空转。
    // 每次打开都先同步一次 currentTime，否则会沿用上次打开时的基准，刚一展开就显示过期的时间差。
    // 60 秒对齐相对时间的最小展示粒度，比这更密只增加重渲染而不改变文案。
    // [并发] 清理函数与 effect 在同一个闭包内配对返回，open 变化或组件卸载时都会被调用，不存在泄漏的定时器。
    // [失败路径] 关闭时直接返回 undefined，等价于没有清理函数可调用，这是合法且刻意的分支，不是遗漏。
    // [权衡] 不在渲染期读系统时间：那样每次渲染都产生新依赖值，memo 的稳定性会被整体破坏。
    // 定时器只写 currentTime，不碰 query 与 open，因此不会与用户输入产生竞争。
    if (!open) {
      return;
    }

    setCurrentTime(Date.now());
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [open]);

  return (
    <Popover
      open={open}
      // 弹层开关是受控的：open 只由这里与行选中两条路径写入，Popover 自身不保留独立状态。
      // [失败路径] 关闭时清空 query 是必要动作，否则下次打开会带着上次关键词，列表被静默过滤成「页签丢了」。
      // 打开时不重置 query，保留用户中途关闭再打开继续筛选的连续操作。
      // [权衡] 不在别处监听外部点击：Popover 已把外部点击、Esc 与选中项统一收敛到这一个回调，重复监听会产生两次状态写入。
      // 清空与关闭放在同一个回调内，避免「已关闭但关键词还在」的中间态被下一次渲染读到。
      // 收起弹层只更新本地 open 与关键词，不调用父层回调，当前激活页签保持不变。
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="shrink-0"
          // 触发按钮只有图标，必须靠 aria-label 给出可读名称，否则读屏会把整个入口念成「按钮」。
          // 按钮类型显式写成 button：该入口可能被放进表单或工具栏，缺省类型会在点击时意外提交表单。
          // [失败路径] 名称直接取 labels.title 而非硬编码：翻译缺失时由上层键值兜底，至少不会退化成空字符串。
          // 弹层自身的 role 与展开状态由 Popover 生成，这里不重复添加展开类属性，避免两套状态互相矛盾。
          // 图标固定尺寸且不参与伸缩，标题名长短变化不会挤动右侧工具栏。
          aria-label={labels.title}
        >
          <ChevronsDownIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 bg-menu p-0">
        <Command
          // 旧搜索菜单手写输入框、标题和列表项，和模型选择菜单的 Command 视觉体系不一致。
          // 这里复用 Command 容器统一搜索框、分组标题、hover 和键盘选中态，同时保留现有 ranking 逻辑。
          // [权衡] 关掉 cmdk 内置过滤：命中与排序已由 filterAndRankSearchItems 完成，再过滤一次会按 value 重新打分并吞掉中文标题。
          // 内置过滤只做 value 的字符串包含，无法表达标题、提示、类型标签三字段联合命中的口径。
          // [失败路径] 若误开启，搜索「终端」时整组中文标题可能消失，用户看到无结果而该页签确实存在。
          // 关闭内置过滤后 cmdk 仍负责键盘导航与高亮，选中顺序按渲染顺序走，与上面的排序结果一致。
          // 该开关只影响过滤，不影响输入框值绑定与 Esc 关闭行为，改动它不会改变输入体验。
          shouldFilter={false}
          className="bg-transparent p-0 text-foreground"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={labels.searchPlaceholder}
            className="h-8"
          />
          <CommandList className="max-h-80">
            {!hasAnySearchResult ? (
              <CommandGroup
                heading={labels.openTabs}
                className="border-border border-b p-1 last:border-b-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {labels.noResults}
                </CommandEmpty>
              </CommandGroup>
            ) : null}

            {filteredTabItems.length > 0 ? (
              <CommandGroup
                heading={labels.openTabs}
                className="border-border border-b p-1 last:border-b-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                {filteredTabItems.map(({ tab, title, openedAtLabel }) => {
                  const isActive = tab.id === activeTabId;
                  return (
                    <CommandItem
                      key={tab.id}
                      value={title}
                      className={cn(
                        "mb-0.5 min-h-8 cursor-pointer gap-2 px-2 text-ui-base last:mb-0",
                        isActive && "bg-selected data-selected:bg-selected",
                      )}
                      onSelect={() => {
                        onActivateTab(tab.id);
                        setOpen(false);
                      }}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-foreground-subtle">
                        <SidePaneTabIcon tab={tab} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
                        {title}
                      </span>
                      <span className="mr-0.5 shrink-0 text-ui-base text-foreground-subtle">
                        {openedAtLabel}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={labels.closeTab(title)}
                        className="shrink-0 opacity-70 hover:opacity-100"
                        // [权衡] 在 pointerdown 阶段就阻断：cmdk 的选中在 pointerup 与 click 上触发，只拦 click 会先激活整行再执行关闭。
                        // 阻止默认行为同时抑制了焦点转移，关掉一个后台页签不会把焦点从搜索框抢走，键盘用户可继续操作。
                        // [失败路径] 只拦 pointerdown 不够：键盘或合成事件触发的 click 仍会冒泡到行，因此两处都要阻断冒泡。
                        // 这里不改 open，关闭后弹层保持展开，用户可连续关闭多个页签。
                        // 关闭只发 onCloseTab 并带上 tab.id，不在本组件改动激活页签，当前页签被关闭后的回退由父层决定。
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}

            {filteredRecentClosedItems.length > 0 ? (
              <CommandGroup
                heading={labels.recentlyClosedTabs}
                className="border-border border-b p-1 last:border-b-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
              >
                {filteredRecentClosedItems.map(({ item, title, closedAtLabel }) => (
                  <CommandItem
                    key={item.tab.id}
                    value={title}
                    className="mb-0.5 min-h-8 cursor-pointer gap-2 px-2 text-ui-base last:mb-0"
                    onSelect={() => {
                      onReopenClosedTab(item.tab.id);
                      setOpen(false);
                    }}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center text-foreground-subtle">
                      <SidePaneTabIcon tab={item.tab} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
                      {title}
                    </span>
                    <span className="mr-0.5 shrink-0 text-ui-base text-foreground-subtle">
                      {closedAtLabel}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
