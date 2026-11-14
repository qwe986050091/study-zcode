/* oxlint-disable eslint(max-lines) -- 侧栏 Tab trigger 集中维护拖拽、上下文菜单与各类图标；本次只增加 Browser 驻留态测试属性，不为行数拆散既有交互。 */
// 侧边面板 Tab 触发器：把一个 tab 投影成可拖拽、可关闭、带右键菜单的标签页。
// 职责边界：只做手势分派、样式投影与可访问性属性转发；不拥有 tab 集合，
// 不判断哪些 tab 可关闭，不持久化激活态，也不解析 diff 内容或承担 tooltip 定位。
// 关闭判定、排序结果与激活态分别由调用方、workspaceSidePane store 与上层 Tabs 决定。
// 图标与标题必须在这里稳定下来：同一 tab 从内存恢复时，元数据可能尚未回填。
// 事件分派顺序固定为 pointerdown -> click / auxclick -> 关闭按钮，任一处提前返回都会改变语义。
//
// 不变量（每条都能对应到下方具体语句；改动前先确认自己没破坏它）：
// INV-01 断言：拖拽松手后的第一次 click 必须被吞掉 —— 守住它的位置：wasDraggingRef 与 onClick 分支 —— 改错故障：拖完落点会顺带激活该 tab，用户以为只挪了位置。
// INV-02 断言：拖拽 transform 只保留水平位移且缩放恒为 1 —— 守住它的位置：normalizedTransform 的 scaleX/scaleY —— 改错故障：拖动中 tab 被拉扁或撑大，与相邻 tab 重叠错位。
// INV-03 断言：zIndex 与 opacity 只在拖拽中生效，其余情况为 undefined —— 守住它的位置：style 对象 —— 改错故障：浮层被兄弟 tab 盖住，或整条 tab 条多出无谓的合成层。
// INV-04 断言：tab 的真实 DOM 必须是 div，不能是原生 button —— 守住它的位置：TabsTrigger asChild 包住的内层 div —— 改错故障：出现 button 嵌套，浏览器修正 DOM 后 tab 点击、关闭、拖拽事件全部错位。
// INV-05 断言：pointerdown 先转发给 dnd-kit 再取消默认行为 —— 守住它的位置：onPointerDown 内两行的先后顺序 —— 改错故障：顺序颠倒后拖拽完全失效，只剩点击。
// INV-06 断言：中键在 click 阶段只拦截、不激活 —— 守住它的位置：onClick 开头的 button 判定 —— 改错故障：关闭前先把目标 tab 激活，相邻 tab 闪一下再消失，焦点落错位置。
// INV-07 断言：auxclick 只处理中键，其余按键原样放行 —— 守住它的位置：onAuxClick 首个判断 —— 改错故障：右键被吞，外层上下文菜单打不开；或中键触发浏览器自动滚动。
// INV-08 断言：关闭按钮按下时不得启动拖拽 —— 守住它的位置：关闭 Button 的 onPointerDown 停止冒泡 —— 改错故障：点关闭先进入拖拽态，松手后 tab 位移且未关闭。
// INV-09 断言：非激活 tab 的关闭按钮默认不接收指针事件 —— 守住它的位置：关闭 Button 的条件类名 —— 改错故障：关闭按钮永久占用标题宽度，或悬停经过时误触关闭。
// INV-10 断言：选中态由受控 isActive 补齐 data-active 与 data-state —— 守住它的位置：cn 里的 data-active 变体 —— 改错故障：多一层 asChild 包装后选中样式整体失效，当前 tab 无高亮。
// INV-11 断言：没有 source 字段的 tab 类型必须先于底部兜底分支返回 —— 守住它的位置：SidePaneTabIcon 与 getSidePaneTabTitle 的 browser-use 分支 —— 改错故障：读取 undefined 的字段抛异常，整棵 workspace 子树被卸载。
// INV-12 断言：browser 图标在两处都必须能回退到地球图标 —— 守住它的位置：browser 与 browser-use 分支 —— 改错故障：favicon 未回填时图标区空白，tab 高度抖动。
// INV-13 断言：patch 目标文件名按源路径、diff 头、标题三级取 —— 守住它的位置：getPatchFileDisplayTarget —— 改错故障：标题常为 Diff 常量，跳过前两级会让图标永远停在通用文件图标。
// INV-14 断言：diff 头扫描优先新文件路径，且两轮分别看 +++ 与 --- —— 守住它的位置：getPatchHeaderFileDisplayTarget 的两个循环 —— 改错故障：重命名或删除场景取到旧文件名，图标与标题不符。
// INV-15 断言：diff 路径必须先脱引号再去 a/ b/ 前缀 —— 守住它的位置：unquoteDiffPath 与 stripDiffPathPrefix —— 改错故障：带空格路径解析失败，图标退回通用类型。
// INV-16 断言：任何 tab 类型都返回非空标题 —— 守住它的位置：getSidePaneTabTitle 的全部分支 —— 改错故障：标题为空时 tab 宽度塌成只剩图标，无法点击识别。
// INV-17 断言：actor 会话标题必须带实例序号 —— 守住它的位置：workflow-actor-session 分支的拼接 —— 改错故障：同车道族多个 tab 显示同名，用户无法区分。
// INV-18 断言：产物 tab 图标固定、不随 kind 变化 —— 守住它的位置：workflow-artifact 分支 —— 改错故障：从内存恢复时元数据未回填，图标在打开前后跳变。
//
// 复用提示：新增 tab 类型时先补 SidePaneTabIcon 与 getSidePaneTabTitle 两处分支，
// 否则会落到读 source 的兜底路径，表现为运行时崩溃而非降级显示。
// 拖拽、中键、关闭三条手势路径互斥，改其中一条必须回看另外两条的取消默认行为与冒泡处理。
import { useRef, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  FolderOpenIcon,
  PuzzleIcon,
  BotIcon,
  BotMessageSquareIcon,
  BugIcon,
  FileIcon,
  FileCode2Icon,
  FileDiffIcon,
  MapIcon,
  MessageSquareTextIcon,
  ListTreeIcon,
  PlugIcon,
  NotepadTextIcon,
  PackageIcon,
  PaletteIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  TerminalIcon,
  WaypointsIcon,
  Workflow as WorkflowIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { TabsTrigger } from "@/components/ui/tabs.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { Button } from "@/components/ui/button.js";
import { BrowserUseTabIcon } from "@/app-shell/BrowserUseTabIcon.js";
import { BrowserTabFavicon } from "@/app-shell/BrowserTabFavicon.js";
import { SidePaneTabTitleTooltip } from "@/app-shell/SidePaneTabTitleTooltip.js";

// tab 默认按 156px 等宽排列；空间不足时以相同 grow/shrink 参数平均收缩到 60px，
// 之后由外层滚动容器承接溢出，避免标题长度改变每个 tab 的宽度。
// 标题没有独立上限时，长网页标题会持续撑宽 tab；主 tab 与拖拽浮层都只钳制标题本体，避免挤占图标、徽标和关闭按钮。
// [契约] 本组件同时被 Tabs 列表与 dnd-kit SortableContext 托管：value 必须等于 tab.id，
// setNodeRef 必须挂在真实 DOM 上，attributes 与 listeners 必须透传到同一节点，
// 否则拖拽命中区与 Radix 的 roving focus 会指向两个不同元素，键盘导航与拖拽各走一套。
export function SortableSidePaneTabTrigger({
  tab,
  title,
  closeTabLabel,
  closeTabMenuLabel,
  closeOtherTabsLabel,
  closeAllTabsLabel,
  diffBadgeLabel,
  isActive,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  canCloseOtherTabs,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  closeTabLabel: string;
  closeTabMenuLabel: string;
  closeOtherTabsLabel: string;
  closeAllTabsLabel: string;
  diffBadgeLabel: string;
  isActive: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  canCloseOtherTabs: boolean;
}) {
  // [契约] wasDraggingRef 是「刚才那一下是拖拽而非点击」的唯一凭据。
  // 它只能由拖拽状态置位、由紧随其后的 click 消费一次，不能存进 state：
  // 置位与消费发生在同一帧，重渲染会把标记清掉，松手后照样激活 tab。
  const wasDraggingRef = useRef(false);
  // [并发] dnd-kit 的 listeners 是惰性对象，pointerdown 必须由本组件手动转发。
  // 这里的 id 就是排序键，必须与上层 SortableContext 的 items 完全一致；
  // 两端不一致时拖拽会静默失效，既不报错也不给任何控制台线索。
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  // [权衡] 横向 tab 条是固定高度控件，语义上只允许水平位移。
  // dnd-kit 在跨容器场景会给 transform 带上 scale，直接透传会让被拖 tab 变形，
  // 所以这里把两个轴的缩放钳回 1，只保留平移分量。
  const normalizedTransform = transform
    ? {
        ...transform,
        // 横向 tabs 是固定高度控件，拖拽时只允许水平位移。
        // dnd-kit 会携带 scale 信息；这里钳回 1，避免 tab 被临时压缩或拉伸。
        scaleX: 1,
        scaleY: 1,
      }
    : null;
  // [资源] 未拖拽时 transform 为 null，必须让序列化结果保持空值。
  // 否则会渲染出零位移的 3D 变换，凭空创建合成层，让整条 tab 条多一层栅格化；
  // zIndex 与透明度同理，只在拖拽中给值。
  const style: CSSProperties = {
    transform: CSS.Transform.toString(normalizedTransform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  // [契约] 置位必须在渲染期同步完成，不能挪进 effect：
  // click 可能在同一帧、effect 之前到达，届时标记仍是初始值，
  // 用户拖完松手会顺带激活 tab，表现为「一拖就切走」。
  if (isDragging) {
    wasDraggingRef.current = true;
  }

  // [事务] tabTrigger 是唯一被 Tooltip 与 ContextMenuTrigger 依次克隆的元素，
  // 真实 DOM 由最内层那个 div 决定。中间任一层去掉 asChild 换成真包装节点，
  // Radix 就会把状态属性打到包装节点上，下方依赖 data-active 的选中样式随即失效。
  const tabTrigger = (
    <TabsTrigger value={tab.id} asChild>
      <div
        ref={setNodeRef}
        data-side-pane-tab-id={tab.id}
        data-browser-tab-residency={"residency" in tab ? tab.residency : undefined}
        data-active={isActive ? "" : undefined}
        data-state={isActive ? "active" : "inactive"}
        style={style}
        {...attributes}
        {...listeners}
        onPointerDown={(event) => {
          listeners?.onPointerDown?.(event);
          // side pane tab 里有独立关闭按钮，外层不能再渲染成 button。
          // 否则会形成 button 嵌套 button，生产包里浏览器会修正 DOM，导致 tab/close/drag 事件错位。
          // 这里用 TabsTrigger asChild 承载 Radix 状态，真实 DOM 改成 div，关闭按钮继续保持原生 button。
          event.preventDefault();
        }}
        onClick={(event) => {
          // 浏览器可能同时派发 middle-click 的 click/auxclick；先在 click 阶段拦截，
          // 避免关闭前把 inactive tab 激活。
          // [失败路径] 部分浏览器给中键同时派发 click 与 auxclick，且顺序不保证。
          // click 阶段必须先返回，且不能调用激活回调：一旦先激活再关闭，
          // 相邻 tab 会闪一下再消失，焦点也会落到错误的 tab 上。
          // 这里只拦截不处理，真正的关闭交给 auxclick。
          if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          // [契约] 一次拖拽只消费一次抑制标记，消费后立刻复位。
          // 不复位会让此后所有点击都失效，tab 变成永久点不动；
          // 若在取消默认行为之前复位，浏览器还会补一次激活，等于没抑制。
          if (wasDraggingRef.current) {
            wasDraggingRef.current = false;
            event.preventDefault();
            return;
          }

          onActivateTab(tab.id);
        }}
        onAuxClick={(event) => {
          // [失败路径] auxclick 覆盖所有非主键，右键与侧键也会进来，必须只放行中键。
          // 其余按键直接返回，且不要取消默认行为：右键要留给外层
          // 上下文菜单的 contextmenu 事件，提前吞掉会让菜单完全打不开。
          if (event.button !== 1) return;

          // Side Pane tab 之前只有左键激活和显式关闭按钮，middle-click 会触发
          // 浏览器默认自动滚动，且部分浏览器还会先触发 tab 激活。统一在 auxclick 阶段
          // 取消默认行为并关闭目标 tab，保持原 active tab 不变。
          event.preventDefault();
          event.stopPropagation();
          onCloseTab(tab.id);
        }}
        className={cn(
          "group relative inline-flex items-center gap-1",
          "flex-[1_1_9.75rem] !h-7 min-w-15 max-w-39 justify-start overflow-hidden rounded-md border px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring",
          "!border-transparent !bg-transparent text-foreground-subtle !rounded-lg",
          "hover:text-foreground",
          !isActive && "hover:!bg-hover",
          // TabsTrigger asChild 经过 ContextMenuTrigger 再包一层后，Radix 的 active 标记不会稳定落到真实 tab div。
          // 这里用受控的 isActive 同步补齐 data-active / data-state，保证 Tailwind 的 active variant 能命中。
          "data-active:!bg-selected data-active:text-foreground",
          "cursor-default",
          isDragging && "cursor-grabbing shadow-md",
        )}
      >
        <SidePaneTabItemContent
          tab={tab}
          title={title}
          diffBadgeLabel={diffBadgeLabel}
          closeVisible={isActive}
          revealCloseOnHover
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={closeTabLabel}
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2 rounded-md",
            !isActive &&
              "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
          onPointerDown={(event) => {
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
      </div>
    </TabsTrigger>
  );

  // [契约] 右键菜单的三个动作都以 tab.id 为目标，语义由调用方决定。
  // canCloseOtherTabs 为假时只禁用「关闭其他」这一项，不能整菜单禁用：
  // `canCloseOtherTabs` 为假只禁用「关闭其他」一项，用户仍可走「关闭」与「关闭全部」完成清理。
  return (
    <ContextMenu>
      <SidePaneTabTitleTooltip isDragging={isDragging} title={title}>
        <ContextMenuTrigger asChild>{tabTrigger}</ContextMenuTrigger>
      </SidePaneTabTitleTooltip>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => onCloseTab(tab.id)}>{closeTabMenuLabel}</ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOtherTabs} onSelect={() => onCloseOtherTabs(tab.id)}>
          {closeOtherTabsLabel}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCloseAllTabs}>{closeAllTabsLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// [权衡] 浮层用与主 tab 不同的固定宽度，且刻意不带悬停与选中变体：
// 它必须看起来被拎起来，任何与主 tab 共享的交互样式都会让它误响应指针。
export function SidePaneTabDragOverlay({
  tab,
  title,
  diffBadgeLabel,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex !h-7 w-39 min-w-15 max-w-39 items-center justify-start gap-1.5 whitespace-nowrap rounded-lg border border-transparent bg-selected px-1.5 pr-1 text-ui-base font-medium text-foreground shadow-md",
        "cursor-grabbing",
      )}
    >
      <SidePaneTabItemContent tab={tab} title={title} diffBadgeLabel={diffBadgeLabel} />
    </div>
  );
}

// [契约] 内容区只渲染图标、标题与 diff 徽标，关闭按钮刻意留在外层：
// 放进内容区会被遮罩渐变一起淡化，且按钮宽度会被算进标题可用空间，
// 长标题的裁剪位置随之偏移。
function SidePaneTabItemContent({
  tab,
  title,
  diffBadgeLabel,
  closeVisible = false,
  revealCloseOnHover = false,
}: {
  tab: WorkspaceSidePaneTab;
  title: string;
  diffBadgeLabel: string;
  closeVisible?: boolean;
  revealCloseOnHover?: boolean;
}) {
  return (
    <span
      data-side-pane-tab-content=""
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-var(--tab-fade-offset)-0.5rem),transparent_calc(100%-var(--tab-fade-offset)))]",
        closeVisible ? "[--tab-fade-offset:1.25rem]" : "[--tab-fade-offset:0px]",
        revealCloseOnHover &&
          "group-hover:[--tab-fade-offset:1.25rem] group-focus-within:[--tab-fade-offset:1.25rem]",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <SidePaneTabIcon tab={tab} />
      </span>
      <span data-side-pane-tab-title="" className="shrink-0 whitespace-nowrap">
        {title}
      </span>
      {isDiffPreviewTab(tab) ? (
        <span className="ml-0.5 shrink-0 rounded-full border border-border bg-surface px-1 py-0 text-ui-xs leading-3 text-foreground-subtle">
          {diffBadgeLabel}
        </span>
      ) : null}
    </span>
  );
}

// [契约] 徽标只认代码查看器且来源为单文件补丁或多文件差异两类；
// 普通文件预览同样属于代码查看器，但不能挂徽标，否则用户会误以为该文件有改动。
function isDiffPreviewTab(tab: WorkspaceSidePaneTab): boolean {
  return (
    tab.type === "code-viewer" &&
    (tab.source.type === "patch" || tab.source.type === "multi-file-diff")
  );
}

// [契约] 图标按类型分派，顺序敏感：所有无 source 字段的类型必须先于底部读来源的分支返回。
// 新增类型时把分支插在上方具体类型区，不要插在末尾兜底之前：
// 末尾兜底已假定来源存在，位置插错会先命中兜底并在渲染期抛异常。
export function SidePaneTabIcon({ tab }: { tab: WorkspaceSidePaneTab }) {
  if (tab.type === "file-manager") return <FolderOpenIcon className="size-3.5" />;
  // plan-detail tab 由 switch-mode（ExitPlanMode）工具调用卡片打开，来源卡片
  // 用 NotepadTextIcon；tab 必须与来源一致，避免点击后图标跳变。不用 ListChecksIcon：
  // 那会与状态面板 Todo section 撞图标，语义上也偏向 todo 而非计划方案文档。
  if (tab.type === "plan-detail") {
    return <NotepadTextIcon className="size-3.5" />;
  }
  if (tab.type === "plugin-ui") {
    return <PlugIcon className="size-3.5" />;
  }
  // 同一条约定：来源卡片（CreateWorkflow）用 lucide Workflow，tab 必须与它一致。
  if (tab.type === "workflow-run") {
    return <WorkflowIcon className="size-3.5" />;
  }
  // run 目录与单个 run 的详情必须能一眼分开（一页名单 vs 一次运行），所以借 subagent 目录
  // 的同一枚「目录」图标——两个目录页在 tab 条上因此同形，正是它们的共同点。
  if (tab.type === "workflow-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }
  // actor transcript 是「一个 actor 的对话记录」：既不是整次运行（Workflow），也不是子智能体
  // 会话（Bot）。三者在 tab 条上必须能一眼分开——它们的可见性与回收语义都不同。
  if (tab.type === "workflow-actor-session") {
    return <BotMessageSquareIcon className="size-3.5" />;
  }
  // 脚本 transcript 与脚本药丸同一枚字形（终端）：来源与 tab 一致，点开不跳变。
  if (tab.type === "workflow-workspace") {
    return <TerminalIcon className="size-3.5" />;
  }
  // 产物 tab 的图标**按 kind 变**是错的：tab 条上的图标要在打开前就稳定（tab 从内存恢复时
  // 元数据还没读回来）。所以用一枚固定的「交付物」图标，kind 的区分留给 tab 内部的头部与卡片。
  if (tab.type === "workflow-artifact") {
    return <PackageIcon className="size-3.5" />;
  }
  if (tab.type === "selection-side-chat") {
    return <MessageSquareTextIcon className="size-3.5" />;
  }
  if (tab.type === "subagent-session") {
    return <BotIcon className="size-3.5" />;
  }

  if (tab.type === "subagent-directory") {
    return <ListTreeIcon className="size-3.5" />;
  }

  if (tab.type === "browser") {
    return <BrowserTabFavicon faviconUrl={tab.faviconUrl} />;
  }

  if (tab.type === "browser-permissions") {
    return <ShieldCheckIcon className="size-3.5" />;
  }

  if (tab.type === "git") {
    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.type === "treemapping") {
    return <MapIcon className="size-3.5" />;
  }

  if (tab.type === "whiteboard") {
    return <PaletteIcon className="size-3.5" />;
  }

  if (tab.type === "model-trajectory") {
    return <WaypointsIcon className="size-3.5" />;
  }

  if (tab.type === "new-tab") return <FileIcon className="size-3.5" />;
  if (tab.type === "plugin-market") return <PuzzleIcon className="size-3.5" />;

  if (tab.type === "developer-tools") {
    return <BugIcon className="size-3.5" />;
  }

  if (tab.type === "terminal" || tab.type === "bash-output") {
    return <SquareTerminalIcon className="size-3.5" />;
  }

  // 同 getSidePaneTabTitle——browser-use tab 无 source，若不在此拦截会 fallthrough
  // 到下方 `tab.source.type` 读 undefined.type 崩溃。
  // agent 导航后由 <webview> favicon 事件回填 faviconUrl，与 human browser tab 一致地展示真实图标；
  // 缺省（about:blank/未取到）回退地球图标。
  // [失败路径] browser-use tab 没有 source 字段。
  // 本分支必须在任何来源读取之前返回，否则读到 undefined 的属性会抛异常；
  // 异常发生在渲染期，会把整棵 workspace 子树一起卸载，而不是只坏一个 tab。
  if (tab.type === "browser-use") {
    return <BrowserUseTabIcon tab={tab} />;
  }

  // [契约] 补丁来源优先用源路径，其次从统一 diff 头里解析真实文件名，最后才回退标题。
  // 三级顺序不能颠倒：标题常是 Diff 这类常量，
  // 提前使用会让图标永远停在通用文件图标上。
  if (tab.source.type === "patch") {
    const fileDisplayTarget = getPatchFileDisplayTarget(tab.source);
    if (fileDisplayTarget) {
      const descriptor = resolveFileDisplayDescriptor(fileDisplayTarget);
      return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
    }

    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.source.type === "multi-file-diff") {
    if (tab.source.path) {
      const descriptor = resolveFileDisplayDescriptor(tab.source.path);
      return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
    }

    return <FileDiffIcon className="size-3.5" />;
  }

  if (tab.source.path) {
    const descriptor = resolveFileDisplayDescriptor(tab.source.path);
    return <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />;
  }

  // [失败路径] 走到这里说明来源存在，但既没有 path 也没命中上面的具体类型，
  // 只能给通用代码文件图标。此处不要再读标题等可选字段：
  // 该分支同时服务尚未枚举的新类型，恢复期这些字段读到的是空值。
  return <FileCode2Icon className="size-3.5" />;
}

// [失败路径] 空串、纯空白与空设备占位路径都视为「没有文件名」。
// 空设备是新增与删除文件 diff 的占位，拿去解析图标会稳定落到文档类型，
// 所以判定必须在这一处收紧，而不是让每个调用点各自去空白。
function isUsablePatchFileTarget(target: string | null | undefined): target is string {
  const trimmedTarget = target?.trim();
  return Boolean(trimmedTarget && trimmedTarget !== "/dev/null");
}

function unquoteDiffPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length >= 2 && trimmedPath.startsWith('"') && trimmedPath.endsWith('"')) {
    return trimmedPath.slice(1, -1);
  }

  return trimmedPath;
}

function stripDiffPathPrefix(path: string): string {
  const unquotedPath = unquoteDiffPath(path);
  if (unquotedPath.startsWith("a/") || unquotedPath.startsWith("b/")) {
    return unquotedPath.slice(2);
  }

  return unquotedPath;
}

// [并发] 表头可能是带引号的路径，也可能是「路径 + 制表符 + 时间戳」。
// 引号分支要按转义规则整体取出，非引号分支要截断制表符之后的内容；
// 两者混用会把时间戳当成文件名的一部分，导致扩展名识别错误。
function parseDiffHeaderPath(headerValue: string): string | null {
  const trimmedValue = headerValue.trim();
  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith('"')) {
    const quotedPathMatch = trimmedValue.match(/^"((?:\\.|[^"\\])+)"/);
    return quotedPathMatch?.[1] ? stripDiffPathPrefix(quotedPathMatch[1]) : null;
  }

  const pathWithoutTimestamp = trimmedValue.split("\t", 1)[0]?.trim();
  return pathWithoutTimestamp ? stripDiffPathPrefix(pathWithoutTimestamp) : null;
}

// [契约] diff 行可能两侧都带引号，也可能是裸路径，还可能一侧为空设备占位。
// 解析优先取新路径一侧，无效时才回退旧路径一侧：
// 重命名场景下取旧路径会让图标与标题显示改名前的文件。
// 两侧都无效时返回空值，把机会让给后续的加号表头扫描。
function parseDiffGitLinePath(line: string): string | null {
  const gitPathMatch = line.match(
    /^diff --git (?:"((?:\\.|[^"\\])*)"|(\S+)) (?:"((?:\\.|[^"\\])*)"|(\S+))$/,
  );
  const nextPath = gitPathMatch?.[3] ?? gitPathMatch?.[4];
  const previousPath = gitPathMatch?.[1] ?? gitPathMatch?.[2];
  const normalizedNextPath = nextPath ? stripDiffPathPrefix(nextPath) : null;
  if (isUsablePatchFileTarget(normalizedNextPath)) {
    return normalizedNextPath;
  }

  const normalizedPreviousPath = previousPath ? stripDiffPathPrefix(previousPath) : null;
  return isUsablePatchFileTarget(normalizedPreviousPath) ? normalizedPreviousPath : null;
}

// [事务] 扫描分两轮：第一轮同时看 diff 头与加号表头，第二轮才看减号表头。
// 必须分轮而不能合成一趟：删除文件的 diff 没有加号表头，
// 若顺序扫描，前一个文件的减号表头会抢先命中，图标指到相邻的旧文件。
function getPatchHeaderFileDisplayTarget(patch: string): string | null {
  for (const line of patch.split(/\r?\n/)) {
    const diffGitTarget = parseDiffGitLinePath(line);
    if (diffGitTarget) {
      return diffGitTarget;
    }

    if (line.startsWith("+++ ")) {
      const nextFileTarget = parseDiffHeaderPath(line.slice(4));
      if (isUsablePatchFileTarget(nextFileTarget)) {
        // 部分 file diff source 没有带 path，title 也可能只是“Diff”。
        // 这里从 unified diff 的文件头里取真实文件名，再交给 fileDisplay 解析文件类型图标。
        return nextFileTarget;
      }
    }
  }

  // [权衡] 第二遍只扫描减号表头，且只有第一遍完全没找到目标时才会到达这里。
  // 代价是对大补丁多切一次字符串；收益是删除与重命名场景仍能拿到文件名，
  // 而不是退回到常量标题对应的通用图标。
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("--- ")) {
      continue;
    }

    const previousFileTarget = parseDiffHeaderPath(line.slice(4));
    if (isUsablePatchFileTarget(previousFileTarget)) {
      return previousFileTarget;
    }
  }

  return null;
}

// [契约] 对外只暴露一个入口，优先级固定为：有效源路径、diff 头、标题。
// 图标与标题两处投影都走这里；任一处自行判空都会与另一处产生分歧，
// 表现为同一个 tab 的图标与标题指向不同文件。
export function getPatchFileDisplayTarget(source: {
  path?: string;
  title: string;
  patch: string;
}): string | null {
  if (isUsablePatchFileTarget(source.path)) {
    return source.path;
  }

  const patchHeaderTarget = getPatchHeaderFileDisplayTarget(source.patch);
  if (patchHeaderTarget) {
    return patchHeaderTarget;
  }

  // 新增/删除文件的 diff 有时会把 source.path 传成 /dev/null。
  // /dev/null 不是业务文件名，直接用于图标识别会固定落到 document；这里只在路径无效时回退 title。
  // [失败路径] 三级都拿不到真实文件名时返回空值，让调用方走通用图标。
  // 不要在这里回退成空串或 unknown 之类的占位：它们会被文件类型解析器当成真实扩展名。
  return isUsablePatchFileTarget(source.title) ? source.title : null;
}

// [契约] 本函数必须对每个联合类型分支给出非空标题，且不得读取该类型上不存在的字段。
// 展示名优先取打开时冻结的标题，其次才取本地化兜底；
// 顺序反过来会让恢复中的 tab 在元数据回填前显示通用名，回填后再突然跳变。
export function getSidePaneTabTitle(
  tab: WorkspaceSidePaneTab,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
): string {
  if (tab.type === "plan-detail") {
    return formatMessage({ id: "planTool.panel.planTab" });
  }
  // 展示名是卡片打开时冻结的兜底；run 身份始终是 runId（tab id 里那一段）。
  if (tab.type === "workflow-run") {
    return tab.workflowName?.trim() || formatMessage({ id: "sidePane.workflowRun" });
  }
  if (tab.type === "workflow-directory") {
    return formatMessage({ id: "sidePane.workflowDirectory" });
  }
  // 实例序号必须留在标题里：同一车道族的实例共用脚本里那一个名字，少了序号 tab 条上就是
  // 两个无法区分的「reviewer」。拼接而不是本地化模板——照 selection-side-chat 的先例。
  if (tab.type === "workflow-actor-session") {
    const name = tab.actorName?.trim() || formatMessage({ id: "sidePane.workflowActor" });
    return `${name} #${tab.ordinal}`;
  }
  // 标题是 run 名（一个 run 一份脚本 transcript）；类型标签「Script steps / 脚本步骤」在 tooltip 里。
  if (tab.type === "workflow-workspace") {
    return tab.workflowName?.trim() || formatMessage({ id: "sidePane.workflowScript" });
  }
  // 展示名是打开时冻结的兜底；产物身份始终是 (runId, artifactId)（tab id 里那两段）。
  if (tab.type === "workflow-artifact") {
    return (
      tab.title?.trim() || tab.artifactId || formatMessage({ id: "sidePane.workflowArtifact" })
    );
  }
  if (tab.type === "selection-side-chat") {
    return `${formatMessage({ id: "sidePane.selectionChat" })} ${tab.ordinal}`;
  }
  if (tab.type === "subagent-session") {
    return tab.title?.trim() || formatMessage({ id: "sidePane.subagent" });
  }

  if (tab.type === "subagent-directory") {
    return formatMessage({ id: "sidePane.subagentDirectory" });
  }

  if (tab.type === "browser") {
    const pageTitle = tab.title?.trim();
    return pageTitle || formatMessage({ id: "browser.title" });
  }

  if (tab.type === "browser-permissions") {
    return formatMessage({ id: "browser.permission.settings" });
  }

  if (tab.type === "git") {
    return formatMessage({ id: "sidePane.review" });
  }

  if (tab.type === "treemapping") {
    return formatMessage({ id: "treemapping.title" });
  }

  if (tab.type === "whiteboard") {
    return tab.title || formatMessage({ id: "whiteboard.title" });
  }

  if (tab.type === "model-trajectory") {
    return tab.title?.trim() || formatMessage({ id: "modelTrajectory.title" });
  }

  if (tab.type === "new-tab") return formatMessage({ id: "sidePane.newTab" });
  if (tab.type === "plugin-market") return formatMessage({ id: "workspace.openPluginsSettings" });

  if (tab.type === "developer-tools") {
    return formatMessage({ id: "developerTools.title" });
  }

  if (tab.type === "terminal" || tab.type === "bash-output") {
    return tab.title || formatMessage({ id: "terminal.title" });
  }

  // browser-use tab 之前未在此分派，会 fallthrough 到底部 `tab.source.title`，
  // 而 browser-use tab 无 source 字段 → 读 undefined.title 触发 React 崩溃（整棵 workspace 子树挂掉）。
  // 用页面标题（agent 导航后由 getState 回填），缺省复用 browser.title 文案。
  if (tab.type === "browser-use") {
    return tab.title?.trim() || formatMessage({ id: "browser.title" });
  }

  if (tab.type === "plugin-ui") {
    return tab.title.trim() || formatMessage({ id: "sidePane.pluginUi" });
  }

  if (tab.type === "file-manager")
    return tab.source?.title || formatMessage({ id: "fileManager.title" });
  return tab.source.title || formatMessage({ id: "codeViewer.title" });
}
