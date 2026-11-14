// ProjectNodeContent —— 项目侧栏「项目行」的内容层（memo），只做投影渲染与操作编排。
// 职责边界：
// 1) 输入是调用方投影：project / remoteHost / tasks / availability 与回调，不持有项目事实、不发起加载。
// 2) 行内操作项（management / files / contextActions）在本层组装，执行权交回项目侧栏上层。
// 3) 拖拽激活器 attributes/listeners 仅透传；位移、测量与落点更新留在 useSortable 外壳。
// 4) 展开状态由 Collapsible 父级持有，本组件只用 isOpen 决定图标形态、未读点与子列表挂载。
// 5) 远程连接五态由 resolveRemoteConnectionPresentation 统一投影，本文件不另造状态机。
// 6) tasks 的逐行渲染归 ProjectTaskRows，本文件只决定是否挂载，不做任务合并或排序。
// 7) 文案统一走 intl 的 project.* 命名空间，不在本文件内联中文或英文常量。
//
// INV 不变量（任一条被破坏都视为回归，改动前先逐条对照）：
// INV-01 断言：节点类型分派必须穷尽 远程 / legacy 单 root / 普通多 root —— 守住它的位置：remotePresentation 三元与 legacySingleRoot 徽标分支 —— 改错故障：某类节点丢图标或徽标，行退化成通用文件夹。
// INV-02 断言：remoteHost 有值即远程、无值即本地，二者不可同时成立 —— 守住它的位置：ProjectNodeProps.remoteHost 与 remotePresentation 的构造 —— 改错故障：本地项目走远程五态，图标与状态文案错乱。
// INV-03 断言：主目录失效只禁用动作，不禁用展开与任务查看 —— 守住它的位置：primaryRootDisabledReason 的四处消费者与 CollapsibleTrigger —— 改错故障：目录丢失后历史任务无法再打开。
// INV-04 断言：展开状态由父级持有，本层只读 isOpen —— 守住它的位置：isOpen 仅用于 ProjectFolderIcon 与未读点 —— 改错故障：出现第二份展开真相，折叠动画与滚动位置错位。
// INV-05 断言：tasks 数据与展开状态分离，isOpen 不得参与任务数据推导 —— 守住它的位置：ProjectTaskRows 只接收 tasks/onSelect/refresh —— 改错故障：折叠时任务被清空或重复请求。
// INV-06 断言：离线时不渲染新建任务与文件入口 —— 守住它的位置：contextActions 与行尾操作组的 availability.online 判断 —— 改错故障：断连状态下暴露必然失败的入口。
// INV-07 断言：management / files 只组装动作，不直接调用服务或写 store —— 守住它的位置：ProjectRowAction.run 的绑定点 —— 改错故障：UI 直连数据源，绕过上层事务与乐观更新。
// INV-08 断言：同一动作定义同时服务更多菜单与右键菜单 —— 守住它的位置：contextActions 展开 ...management —— 改错故障：两个入口文案、禁用态不一致。
// INV-09 断言：action.id 唯一且稳定，兼任 React key 与 data-testid 后缀 —— 守住它的位置：files-N 的索引拼装与 remove-entry 常量 —— 改错故障：菜单项复用错误节点或被测试选错。
// INV-10 断言：子节点加载失败必须保留可重试入口 —— 守住它的位置：refresh 透传给 ProjectTaskRows —— 改错故障：任务读取失败后只能重开面板才能恢复。
// INV-11 断言：拖拽属性只在 dragEnabled 时展开，且不得覆盖标题自身的 aria 语义 —— 守住它的位置：Button 上的 attributes/listeners 展开与 aria-disabled 固定值 —— 改错故障：不可拖拽时点击被吞，或读屏误报禁用。
// INV-12 断言：远程设备名回退链为 deviceLabel → remoteHostLabel(remoteHost)，不得显示空串 —— 守住它的位置：project-device 文本节点 —— 改错故障：远程行只剩项目名，用户无法分辨设备。
// INV-13 断言：浮层一律非模态，键盘路径（F10 / ContextMenu 键）与鼠标右键等价 —— 守住它的位置：ContextMenu/DropdownMenu 的 modal 关闭标志与 onKeyDown —— 改错故障：浮层残留指针锁，键盘用户无法打开菜单。
// INV-14 断言：模块级默认对象/数组保持引用稳定，不在渲染期新建 —— 守住它的位置：DEFAULT_AVAILABILITY 与 EMPTY_ADDITIONAL_ACTIONS —— 改错故障：memo 失效，全部项目行整体重渲染。
//
// 行渲染顺序：远程身份卡 → 右键包裹行 → 左图标槽（置顶时悬停替换）→ 名称与设备名 → 未读点 → legacy 徽标 → 状态文案 → 行尾操作组。
// 交互入口顺序：整行右键 → 行尾「更多」→ 多 root 时叠加「文件」下拉 → 新建任务按钮；离线隐藏后两者。
// 维护约定：新增分支先判断是否触碰 INV-01/02/04，再决定挂在 remotePresentation 还是 availability。
// 维护约定：本文件不引入状态源、定时器与请求；异步失败与重试由上层或 ProjectTaskRows 承担。
import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
import { RemoteIdentityHoverCard } from "@/project-sidebar/RemoteIdentityHoverCard.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { memo } from "react";
import type { useSortable } from "@dnd-kit/sortable";
import {
  Ellipsis,
  FolderMinus,
  ListTree,
  Pin,
  PinOff,
  Pencil,
  Settings,
  Trash2,
  MessageCirclePlus,
} from "lucide-react";
import { ProjectFolderIcon } from "@/project-sidebar/ProjectFolderIcon.js";
import { sourceServerConnectionStateSchema } from "@zcode/shared";
import type {
  ProjectTask,
  VirtualProject,
  ProjectSidebarProps,
  ProjectAvailability,
  ProjectRowAction,
  RemoteProjectHost,
} from "@/project-sidebar/contract.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";

// 修复原因：memo 内容的内联默认对象/数组会在每次渲染时新建引用，触发引用稳定性门禁。
// [契约] 模块级常量只为 memo 内容层提供稳定引用，避免渲染期新建对象或数组破坏浅比较。
// DEFAULT_AVAILABILITY 表示「本地项目默认在线」，只有显式传入 availability 时才被覆盖。
// EMPTY_ADDITIONAL_ACTIONS 承担「无附加操作」的默认值，等价于空数组而非 undefined，菜单可直接展开。
// 这两个常量是只读契约：调用方要追加操作必须传新数组，不能就地 push。
// 它们存在的原因是引用稳定性门禁，不是业务默认值本身有额外含义。
const DEFAULT_AVAILABILITY: ProjectAvailability = { online: true };
const EMPTY_ADDITIONAL_ACTIONS: ProjectRowAction[] = [];

// [契约] project 是侧栏投影（id/name/roots/pinned/legacySingleRoot/primaryRootStatus），不是可写的项目实体。
// remoteHost 有值即代表远程项目，本地项目恒为 undefined；节点类型分派完全依赖这一条。
// availability.online 是连接可用性总闸，缺省回落到本地在线，离线 UI 只在显式 false 时出现。
// editable / isOpen / dragEnabled / canOpen 由外壳注入，内容层不自行推导可写性、展开态与拖拽能力。
// 写操作一律以回调外抛（onCreate/onEdit/onDelete/onPin/onMove/onRemoveEntry），本层不直接改项目数据。
export type ProjectNodeProps = {
  project: VirtualProject;
  remoteHost?: RemoteProjectHost;
  deviceLabel?: string;
  diagnostics?: { error?: string };
  expanded: boolean;
  onExpandedChange(value: boolean): void;
  tasks: ProjectTask[];
  hasUnread?: boolean;
  additionalActions?: ProjectRowAction[];
  onCreate(): void;
  onViewFiles?(rootPath: string): void;
  onEdit(): void;
  onDelete(): void;
  onPin(): void;
  onMove(task: { workspacePath: string; workspaceIdentity?: string; taskId: string }): void;
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  availability?: ProjectAvailability;
  onRemoveEntry?(): void;
  /** 仅桌面端远程项目提供：从菜单或待处理详情跳到“设置 › 远程设备”。 */
  onOpenDeviceSettings?(): void;
};

// 原因：useSortable 的激活/测量/落点更新曾让 41 个项目的菜单和 Tooltip 连续重渲染。
// 外壳只把稳定的激活器属性传入 memo 内容，位移和蓝线变化不穿透到整棵内容树。
// [权衡] memo 边界刻意压在这一层：useSortable 留在外壳，内容层只接稳定的激活器句柄与布尔位。
// 位移、测量与落点更新停在投影层，不再穿透到每个项目的菜单、Tooltip 与任务行。
// 拖拽属性仅在 dragEnabled 为真时展开，否则整行保持纯点击展开，不吞掉指针手势。
// 所以这里不能引入依赖 project/tasks 引用之外的新派生对象，否则 memo 的浅比较形同虚设。
// 行内瞬态（hover、菜单开合、焦点）交给 DOM 与 Radix，本组件不新增 useState。
export const ProjectNodeContent = memo(function ProjectNodeContent({
  project,
  remoteHost,
  deviceLabel,
  diagnostics,
  tasks,
  hasUnread = false,
  onCreate,
  onViewFiles,
  onEdit,
  onDelete,
  onPin,
  onSelect,
  refresh,
  availability = DEFAULT_AVAILABILITY,
  onRemoveEntry,
  onOpenDeviceSettings,
  additionalActions = EMPTY_ADDITIONAL_ACTIONS,
  editable,
  isOpen,
  attributes,
  listeners,
  setActivatorNodeRef,
  dragEnabled,
}: ProjectNodeProps &
  Pick<ReturnType<typeof useSortable>, "attributes" | "listeners" | "setActivatorNodeRef"> & {
    dragEnabled: boolean;
    editable: boolean;
    canOpen: boolean;
    isOpen: boolean;
  }) {
  // [契约] intl 在渲染期取一次，msg 只负责拼 project. 前缀，不缓存格式化结果。
  // 所有面向用户的字符串都必须经 msg 或 intl.formatMessage，禁止中英文常量内联。
  // 文案 id 限定在 project.*、common.more、workspaceSidebar.showFileTree 这些既有 key。
  // 缺 key 会原样渲染 id，属于可见故障，不在此处写兜底文案掩盖。
  // 本层不读写 locale，语言切换由 Provider 触发整棵侧栏重渲染。
  const { intl } = useZCodeIntl();
  // [契约] msg 是同步纯投影：同一 id 在本次渲染内结果稳定，便于测试直接断言文案。
  // 它不做占位符插值，需要参数的文案改用 intl.formatMessage 显式传 values。
  // msg 只服务 project 域，跨域 id 单独取，不靠前缀猜测。
  // 新增文案先确认语言包里已有对应 key，再在本层引用。
  // 保持同步调用，避免首帧出现空文案或闪烁。
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  // 修复原因：新项目行曾无条件显示本地文件夹；远程图标只读 Host 现有投影，复用统一五态。
  // [契约] 远程节点的连接状态只读上游事实，经 resolveRemoteConnectionPresentation 统一投影出五态。
  // lastConnectionStatus 先过 sourceServerConnectionStateSchema.safeParse，未知枚举回落 remoteHost.connectionStatus。
  // attached 取 availability.online，保证「设备在线但项目未挂载」仍按连接中呈现而不是在线。
  // projectError 优先用 diagnostics.error，再回落 lastConnectionError；本地化文案不覆盖设备级错误码分类。
  // 本地项目不进入这条路径，remotePresentation 保持 undefined，图标回落到文件夹。
  const remotePresentation = remoteHost
    ? resolveRemoteConnectionPresentation({
        state:
          sourceServerConnectionStateSchema.safeParse(remoteHost.lastConnectionStatus).data ??
          remoteHost.connectionStatus,
        attached: availability.online,
        upgradeTarget: remoteHost.upgradeTarget,
        projectError: diagnostics?.error ?? remoteHost.lastConnectionError,
      })
    : undefined;
  // [失败路径] 主目录 missing / unavailable 各映射一条禁用原因文案，available 与缺省视为可用。
  // undefined 表示「可以继续」，是有意义的可用信号，不要改成空字符串占位。
  // 同一个原因同时驱动更多菜单、文件入口、新建任务按钮与标题行透明度，四处判断必须一致。
  // 失效只禁用动作，不禁用展开：历史任务仍需可查看与切换。
  // 刷新后 primaryRootStatus 由上层重算，本层不缓存上一次原因。
  const primaryRootDisabledReason =
    project.primaryRootStatus === "missing"
      ? msg("primaryRootMissing")
      : project.primaryRootStatus === "unavailable"
        ? msg("primaryRootUnavailable")
        : undefined;
  // [契约] showFiles 是「查看文件」的单一文案来源，行尾图标、菜单项与 Tooltip 共用。
  // 多 root 项目在菜单里追加 rootPath 后缀，单 root 不追加，避免标签噪声。
  // 文案属于通用侧栏域，不复用 project.* 前缀，防止两处翻译漂移。
  // 这里只取一次，同一渲染内多次引用保持同一字符串值。
  // 新增入口若需要不同措辞，应新增 key，而不是在调用点拼字符串。
  const showFiles = intl.formatMessage({ id: "workspaceSidebar.showFileTree" });
  const more = intl.formatMessage({ id: "common.more" });
  // 原因：右键是快捷入口的补充；与更多菜单共用操作定义，避免再次删掉 hover 功能。
  // [契约] management 的组装顺序即菜单展示顺序：附加操作 → 设备设置 → 编辑/置顶/删除 → 移除入口兜底。
  // 每个元素是 ProjectRowAction（id/label/icon/run/disabled/destructive），只描述动作不执行副作用。
  // id 同时作为 React key 与 data-testid 后缀，必须唯一且稳定。
  // 同一份数组同时喂给「更多」下拉与右键菜单，杜绝两个入口行为漂移。
  // 数组每次渲染重建，但 memo 的输入没有变化，因此不构成额外渲染压力。
  const management: ProjectRowAction[] = [
    ...additionalActions,
    ...(onOpenDeviceSettings
      ? [
          {
            id: "device-settings",
            label: msg("deviceSettings"),
            icon: Settings,
            run: onOpenDeviceSettings,
          },
        ]
      : []),
    // [权衡] 编辑、置顶、删除只在 editable 为真时出现，可写性由外壳判定，内容层不做权限推导。
    // 置顶项按 project.pinned 切换文案与图标（Pin/PinOff），同一动作承担解除置顶。
    // 删除标记 destructive，由菜单渲染层套用危险色，不在数据层写死 class。
    // 不可编辑时这三项整体缺席，而不是渲染成禁用项，避免出现永远点不动的入口。
    // 若将来要支持只读置顶，需新增独立分支，不能直接放开整个可编辑块。
    ...(editable
      ? [
          { id: "edit", label: msg("edit"), icon: Pencil, run: onEdit },
          {
            id: "pin",
            label: project.pinned ? msg("unpin") : msg("pin"),
            icon: project.pinned ? PinOff : Pin,
            run: onPin,
          },
          { id: "delete", label: msg("delete"), icon: Trash2, run: onDelete, destructive: true },
        ]
      : []),
    // 可编辑的远程项目菜单与本地项目一致；从本机移除只在不能删除项目时（离线、legacy 单 root）兜底。
    // [失败路径]「从本机移除」是三方兜底入口：不可编辑、有远端入口 id、且上层提供了回调。
    // 它只在无法删除项目的场景出现（离线、legacy 单 root），用来清理本地入口而保留远端数据。
    // `editable` / `entryId` / `onRemoveEntry` 任一缺失就整体不渲染，不做禁用态占位。
    // id 固定为 remove-entry，测试与埋点按这个值定位。
    // `onRemoveEntry` 不写入项目存储，只影响本机入口列表。
    ...(!editable && availability.entryId && onRemoveEntry
      ? [{ id: "remove-entry", label: msg("removeEntry"), icon: FolderMinus, run: onRemoveEntry }]
      : []),
  ];
  // [契约] 每个 root 生成一条 files-N 动作，索引参与 id，保证同项目多目录时 key 唯一。
  // 多 root 时标签拼上 rootPath，用户能区分打开的是哪个目录；单 root 保持短标签。
  // run 通过可选链调用 onViewFiles，回调缺失时点击无副作用而不是抛错。
  // disabled 合并两个条件：主目录失效原因，或缺少 onViewFiles 能力。
  // files 只描述「可打开的目录」，不承担创建、重命名等目录管理职责。
  const files: ProjectRowAction[] = project.roots.map((root, index) => ({
    id: `files-${index}`,
    label: project.roots.length > 1 ? `${showFiles} · ${root.rootPath}` : showFiles,
    icon: ListTree,
    run: () => onViewFiles?.(root.rootPath),
    disabled: Boolean(primaryRootDisabledReason) || !onViewFiles,
  }));
  // [契约] 右键菜单 = 在线时的新建任务与文件列表 + 始终存在的 management。
  // 离线时只剩管理项，避免在断连状态下暴露注定失败的任务创建入口。
  // 顺序固定为新建任务在前、文件其后、管理项收尾，与行尾按钮的视觉顺序对齐。
  // 这里不复制 management 元素，直接展开同一数组引用，保证文案与禁用态一致。
  // 菜单项数量随 roots 线性增长，渲染时不做额外过滤。
  const contextActions = [
    ...(availability.online
      ? [
          {
            id: "create-task",
            label: msg("createTask"),
            icon: MessageCirclePlus,
            run: onCreate,
            disabled: Boolean(primaryRootDisabledReason),
          },
          ...files,
        ]
      : []),
    // [权衡] 右键菜单复用整份 management，而不是维护第二套定义，减少入口漂移。
    // 代价是右键菜单也会出现设备设置这类偏设置的项，属于可接受的冗余。
    // 若要为右键定制顺序或分组，应扩展 action 结构而不是在此处过滤。
    // 上下文菜单与下拉菜单共用 ProjectMenuItems，仅切换 Item 实现。
    // 移除 management 会让右键失去删除与置顶，属于明显的功能缺失。
    ...management,
  ];
  // [契约] 渲染树固定为：Fragment → ContextMenu → 远程身份卡 → Trigger 行 → 行尾操作 → 任务折叠区。
  // ContextMenu 与 DropdownMenu 都关闭 modal，避免浮层锁住指针与滚动。
  // 整行 div 承担右键锚点、tabIndex 与 F10/ContextMenu 键盘唤起，键盘路径与鼠标右键等价。
  // 标题区不含行尾按钮，避免 HoverCard 浮层遮住操作；浮层定位以整行边界为准。
  // CollapsibleContent 始终挂在行外层，展开动画与任务列表卸载互不干扰。
  return (
    <>
      <ContextMenu modal={false}>
        {/* 标题区域不含行尾按钮，作为锚点时浮层会遮住操作；以整行边界定位，保留更多/新建入口可点击。 */}
        <RemoteIdentityHoverCard
          host={remoteHost}
          title={project.name}
          projectName={project.name}
          deviceName={deviceLabel}
          paths={project.roots.map((root) => root.rootPath)}
          connectionError={diagnostics?.error}
          onOpenDeviceSettings={onOpenDeviceSettings}
        >
          <ContextMenuTrigger asChild>
            <div
              data-testid="virtual-project-row"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  event.currentTarget.dispatchEvent(
                    new MouseEvent("contextmenu", {
                      bubbles: true,
                      clientX: rect.left + 24,
                      clientY: rect.bottom,
                    }),
                  );
                }
              }}
              className="group/project-row ml-2 flex h-8 min-w-0 items-center gap-1 rounded-lg pr-1 hover:bg-surface-hover"
            >
              {/* 标题仍可展开历史；失效提示仅绑定禁用的操作按钮，避免悬停整行也弹出。 */}
              <span className="flex min-w-0 flex-1 shrink-0">
                <CollapsibleTrigger asChild>
                  <Button
                    ref={setActivatorNodeRef}
                    {...(dragEnabled ? attributes : {})}
                    {...(dragEnabled ? listeners : {})}
                    variant="ghost"
                    className={cn(
                      dragEnabled ? "touch-none" : "touch-pan-y",
                      "flex h-8 min-w-0 flex-1 justify-start gap-2 rounded-lg pl-2.5 pr-1 text-left text-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground",
                      primaryRootDisabledReason && "opacity-50",
                    )}
                    data-testid="virtual-project-toggle"
                    // dnd-kit 的 attributes 按可排序性给出 aria-disabled，不能覆盖标题本身的不可用状态。
                    aria-disabled={false}
                  >
                    {/* 置顶提示复用左侧固定槽位；仅悬停时替换图标，避免名称右侧常驻钉子占位。 */}
                    <span
                      className="flex size-4 shrink-0 items-center justify-center"
                      aria-hidden="true"
                    >
                      <span
                        className={cn(
                          "inline-flex",
                          project.pinned && "group-hover/project-row:hidden",
                        )}
                      >
                        {remotePresentation ? (
                          <RemoteConnectionStateIcon presentation={remotePresentation} project />
                        ) : (
                          <ProjectFolderIcon
                            rootCount={project.roots.length}
                            open={isOpen}
                            className="size-4 shrink-0 text-foreground-subtle"
                          />
                        )}
                      </span>
                      {project.pinned ? (
                        <Pin className="hidden size-4 text-foreground-subtle group-hover/project-row:block" />
                      ) : null}
                    </span>
                    {/* 不同字号按框居中会让设备名基线上浮；文字单独对齐基线，外层图标仍居中。 */}
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-ui-base text-foreground-subtle">
                        {project.name}
                      </span>
                      {remoteHost ? (
                        <span
                          data-testid="project-device"
                          className="max-w-24 truncate text-ui-sm text-remote-foreground-muted"
                        >
                          {deviceLabel || remoteHostLabel(remoteHost)}
                        </span>
                      ) : null}
                    </span>
                    {!isOpen && availability.online && hasUnread ? (
                      <span
                        data-testid="virtual-project-unread"
                        data-workspace-unread-indicator="true"
                        role="img"
                        aria-label={intl.formatMessage({ id: "project.hasUnread" })}
                        className="size-1.5 shrink-0 rounded-full bg-icon-blue"
                      />
                    ) : null}
                    {project.legacySingleRoot ? (
                      <SidebarNativeTooltip>
                        <span
                          className="shrink-0 text-ui-sm text-foreground-subtle"
                          title={msg("legacyUpgradeRequired")}
                        >
                          {msg("legacySingleRoot")}
                        </span>
                      </SidebarNativeTooltip>
                    ) : null}
                    {/* 修复原因：待处理设备曾统一显示“离线”，与普通离线无法区分；改为展示模型短状态。
                        连接中/失败同样曾落入“离线”分支，出现图标在转、文字写离线的矛盾；只有普通离线显示“离线”。 */}
                    {!availability.online ? (
                      <span
                        data-testid="project-status-label"
                        className={cn(
                          "text-ui-sm",
                          remotePresentation?.status === "pending" && !availability.unresolved
                            ? remotePresentation.foreground
                            : "text-foreground-subtle",
                        )}
                      >
                        {availability.unresolved
                          ? msg("unresolved")
                          : remotePresentation && remotePresentation.status !== "offline"
                            ? intl.formatMessage({ id: remotePresentation.shortMessageId })
                            : msg("offline")}
                      </span>
                    ) : null}
                  </Button>
                </CollapsibleTrigger>
              </span>
              <div
                data-testid="virtual-project-actions"
                className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 [&:has([data-state=open])]:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <DropdownMenu modal={false}>
                  <ControlHintTooltip title={more}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        data-testid="virtual-project-menu"
                        variant="ghost"
                        size="icon-sm"
                        disabled={!management.length}
                        aria-label={more}
                        className="text-foreground-subtle hover:text-foreground"
                      >
                        <Ellipsis className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                  </ControlHintTooltip>
                  <DropdownMenuContent align="end">
                    <ProjectMenuItems actions={management} />
                  </DropdownMenuContent>
                </DropdownMenu>
                {availability.online ? (
                  <>
                    {/* 主目录失效时多 root 也复用禁用按钮，避免菜单仍能打开附加目录。 */}
                    {files.length > 1 && !primaryRootDisabledReason ? (
                      <DropdownMenu modal={false}>
                        <ControlHintTooltip title={showFiles}>
                          <DropdownMenuTrigger asChild>
                            <Button
                              data-testid="virtual-project-files"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={showFiles}
                              className="text-foreground-subtle hover:text-foreground"
                            >
                              <ListTree className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                        </ControlHintTooltip>
                        <DropdownMenuContent align="end">
                          <ProjectMenuItems actions={files} />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <TaskRowActionButton
                        testId="virtual-project-files"
                        label={showFiles}
                        showTooltip
                        disabledReason={
                          primaryRootDisabledReason ??
                          (!files.length || !onViewFiles ? msg("noFolders") : undefined)
                        }
                        className="text-foreground-subtle hover:text-foreground"
                        onClick={() => files[0]?.run()}
                      >
                        <ListTree className="size-3.5" />
                      </TaskRowActionButton>
                    )}
                    <TaskRowActionButton
                      testId="virtual-project-create-task"
                      label={msg("createTask")}
                      showTooltip
                      disabledReason={primaryRootDisabledReason}
                      className="text-foreground-subtle hover:text-foreground"
                      onClick={onCreate}
                    >
                      <MessageCirclePlus className="size-3.5" />
                    </TaskRowActionButton>
                  </>
                ) : null}
              </div>
            </div>
          </ContextMenuTrigger>
        </RemoteIdentityHoverCard>
        {/* 非模态菜单只负责导航，避免退出动画与编辑弹窗交错后残留指针锁。 */}
        <ContextMenuContent>
          <ProjectMenuItems actions={contextActions} context />
        </ContextMenuContent>
      </ContextMenu>
      {/* 直接条件卸载曾跳过收起动画；复用旧侧栏的受控高度/透明度生命周期。 */}
      <CollapsibleContent data-testid="virtual-project-tasks">
        {/* 原因：旧任务文字的 34px 缩进外只需 8px 留白，空态与项目名称保持对齐。 */}
        <div className="pl-2 pt-1">
          <ProjectTaskRows tasks={tasks} onSelect={onSelect} refresh={refresh} />
        </div>
      </CollapsibleContent>
    </>
  );
});

// [契约] 该子组件只做一件事：把同一份 ProjectRowAction 数组渲染成指定菜单容器里的项。
// context 为真时用 ContextMenuItem，否则用 DropdownMenuItem，行为与样式由 Radix 保证一致。
// 它不读取任何外部状态，纯函数式渲染，便于被两个入口复用。
// actions 为空时返回空数组，调用方负责决定按钮是否禁用。
// 新增菜单类型时只扩展 Item 选择，不改动 action 结构。
function ProjectMenuItems({
  actions,
  context = false,
}: {
  actions: ProjectRowAction[];
  context?: boolean;
}) {
  // [契约] Item 的分派只发生一次，后续 map 共用同一个组件引用。
  // data-testid 以 virtual-project- 为前缀；右键菜单里文件与新建任务再加 context- 段区分入口。
  // id 里已含 files-N，前缀化后仍保持唯一。
  // disabled 直接透传 action.disabled，禁用原因在组装期已计算完毕。
  // destructive 映射为危险色 class，其余保持默认样式。
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  // [契约] 逐项渲染：key 取 action.id，icon 可选且统一 size-4，label 直接作为子节点。
  // onSelect 直接绑定 action.run，不做参数包装，保证动作签名与组装期一致。
  // 点击后菜单由 Radix 自行关闭，此处不手动控制开合。
  // 图标标记 aria-hidden，语义完全由 label 承担。
  // 渲染是纯映射，不排序、不去重、不按 disabled 过滤。
  return actions.map((action) => (
    <Item
      key={action.id}
      disabled={action.disabled}
      data-testid={`virtual-project-${context && (action.id.startsWith("files-") || action.id === "create-task") ? "context-" : ""}${action.id}`}
      className={action.destructive ? "text-destructive" : undefined}
      onSelect={action.run}
    >
      {action.icon ? <action.icon className="size-4 shrink-0" aria-hidden="true" /> : null}
      {action.label}
    </Item>
  ));
}
