// project-sidebar/index.tsx —— 项目侧栏装配层：把目录 Provider 的权威树、偏好、远端同步与会话状态收束成一个侧栏。
// 职责边界：只做「取数 → 选择器 → 布局编排 → 弹层开合」；持久化在 view-preference，排序/分组纯函数在 view.js 与 grouped-view.js。
// 不做的事：不发 RPC、不建第二份项目树、不缓存宽度或滚动值、不推导 workspaceIdentity（透传 props 或 trim() || path）。
// 依赖方向：contract.js 类型 → view.js 选择器 → 本文件编排 → ProjectSidebarNode / ProjectSections 交互；不可反向。
// 布局骨架：h-12 拖拽区 → overflow-clip 面板（ProjectSidebarNavigation / 任务列表区 / WorkspaceSidebarFooter）→ 三个弹层 + remoteSync.dialog。
// 状态归属：树与偏好来自 useProjectDirectory；projects / expandableProjects / hasExpandedProjects 是派生值，本文件不缓存。
// 渲染安全区：本文件只在语句间隙写行注释；JSX 属性之间与子节点一律沿用既有的花括号块注释。
// INV 表（都是当前代码已成立的不变量；改到对应位置时逐条核对，不是愿望清单）：
// INV-01 断言：项目列表只按 preferences.sort 的结果渲染，pinned 段与 ProjectSections 不重复同一项目 —— 守住它的位置：projects 计算与 projects.filter(pinned) —— 改错故障：重复行与 key 冲突，展开态和拖拽索引错位。
// INV-02 断言：拖拽只在同 pinned 分组内换位 —— 守住它的位置：reorder 中 source.pinned !== target.pinned 提前 return —— 改错故障：置顶项目被拖进普通段，顺序持久化写坏。
// INV-03 断言：view 只有 projects / grouped / timeline 三态且仅一分支生效 —— 守住它的位置：homeOnlySwitcher 优先、其后三元链 —— 改错故障：两种视图同时挂载，滚动容器 ref 冲突。
// INV-04 断言：scrollRef 只绑在唯一的 ScrollFadeViewport 上，切视图不重建外层滚动容器 —— 守住它的位置：列表区外层容器与 scrollRef 传入 TaskGroupedView —— 改错故障：树滚动位置归零、分组锚点失效。
// INV-05 断言：列表只允许纵向滚动，拖拽位移不得制造水平滚动 —— 守住它的位置：外层 overflow-clip 加 overflow-x-hidden —— 改错故障：手机整栏被横向拖偏、sticky 错位。
// INV-06 断言：homeOnlySwitcher 与 projects/grouped/timeline 互斥，且 home-only 下静默 loading/error —— 守住它的位置：homeOnlySwitcher 定义与两处 !homeOnlySwitcher 判断 —— 改错故障：无 base attachment 时冒出本地错误或空列表。
// INV-07 断言：空项目态由 ProjectSections 的 loading / onAddProject / canToggleProjects 决定，本文件不另造空态 —— 守住它的位置：ProjectSections 入参 —— 改错故障：双重空态文案与首屏闪烁。
// INV-08 断言：只有 service 与 remoteService 同时就绪才挂 ProjectCreation / RemoteProjectPicker —— 守住它的位置：两处 && 条件 —— 改错故障：半初始化弹层提交空服务，创建项目抛错。
// INV-09 断言：editor 弹层 key 变化即重置表单，新项目固定为 "new" —— 守住它的位置：ProjectEditor 的 key 表达式 —— 改错故障：切换编辑对象残留上一项目的校验态。
// INV-10 断言：hasActiveRemoteTask 的订阅只返回布尔 —— 守住它的位置：useZCodeSessionStore 的 Boolean(...) selector —— 改错故障：会话切换让全部项目行与 Tooltip 重渲染。
// INV-11 断言：taskPresentation 的 useMemo 依赖与入参一一对应 —— 守住它的位置：deps 数组 —— 改错故障：手机远控高亮或 pin 回调读到旧闭包。
// INV-12 断言：顶栏新建与快捷键共用同一条继承路径（onCreateTask 省略 projectId） —— 守住它的位置：ProjectSidebarNavigation onCreate 与 start 的 inheritedGroup —— 改错故障：新建任务丢失当前分组或误绑当前项目。
// INV-13 断言：分组归属只在点击时从 store 读取 —— 守住它的位置：start 内 getState() —— 改错故障：订阅化后菜单与 Tooltip 随草稿切换重渲染。
// INV-14 断言：footer 的 workspaceIdentity 透传 props，不从当前 tab 反推 —— 守住它的位置：WorkspaceSidebarFooter 入参 —— 改错故障：远控入口落到错误 attachment scope。
// INV-15 断言：内联输入聚焦不得滚动裁剪容器 —— 守住它的位置：overflow-clip 而非 overflow-auto —— 改错故障：手机侧栏随焦点左移。
// INV-16 断言：memo 只隔离无关父更新，context 与 store 订阅仍生效 —— 守住它的位置：memo(function ProjectSidebar) 与内部 hooks —— 改错故障：面板显隐时整树重渲染，或反向导致项目状态不刷新。
// INV-17 断言：本文件 JSX 属性之间与子节点内不出现行注释 —— 守住它的位置：正文注释全部落在语句间隙 —— 改错故障：注释被当文本渲染，或属性解析报错。
// INV-18 断言：弹层开合只走本地 useState，不写进偏好 —— 守住它的位置：editor / creating / remotePicker 三个 state —— 改错故障：弹层状态泄漏到持久层，刷新后重复弹出。
// INV-19 断言：加载与错误提示不遮挡 footer，错误带 role="alert" —— 守住它的位置：列表尾部两个条件渲染 —— 改错故障：错误被滚动遮住、读屏不播报。
// INV-20 断言：分组视图的工具条与吸顶宿主由 ref 回调回填 state 提供 —— 守住它的位置：setGroupedToolbar / setGroupedSticky —— 改错故障：工具条挂到旧 DOM，切换视图后丢失。
// 变更守则：任何新分支都要能回答「谁拥有这份状态」，答不上来就下沉到 hook 或 view.js。
// 验收口径：只新增整行注释、不改语句；密度按 注释行/代码行 口径统计。
import { SidebarTooltipProvider } from "@/ControlHintTooltip.js";
export { readProjectSidebarView } from "@/project-sidebar/view-preference.js";
import { SortableProjects } from "@/project-sidebar/SortableProjects.js";
export { ArchiveManagement } from "@/project-sidebar/ArchiveManagement.js";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { TID_SIDEBAR } from "@zcode/shared/test-ids";
import { remoteHostIdFromWorkspaceIdentity } from "@/project-sidebar/contract.js";
import type {
  ProjectSidebarProps,
  VirtualProject,
  Locale,
  Theme,
  RemoteProjectHost,
} from "@/project-sidebar/contract.js";
import { useProjectPinIntent } from "@/project-sidebar/useProjectPinIntent.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import { useProjectRemoteSync } from "@/project-sidebar/useProjectRemoteSync.js";
import { useProjectConnectionDiagnostics } from "@/project-sidebar/useProjectConnectionDiagnostics.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
export {
  ProjectDirectoryProvider,
  useOptionalProjectDirectory,
} from "@/project-sidebar/ProjectDirectoryProvider.js";
export { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import { useProjectTaskNavigation } from "@/project-sidebar/useProjectTaskNavigation.js";
import { useProjectFileTree } from "@/project-sidebar/useProjectFileTree.js";
import {
  selectProjectRows,
  selectSortedProjects,
  projectKey,
  projectHasUnread,
  projectSourceServerId,
} from "@/project-sidebar/view.js";
import { TaskGroupedView } from "@/project-sidebar/TaskGroupedView.js";
import { taskGroupKey } from "@/project-sidebar/grouped-view.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import {
  ProjectSidebarNode,
  runProjectAction as action,
} from "@/project-sidebar/ProjectSidebarNode.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { RemoteProjectPicker } from "@/project-sidebar/RemoteProjectPicker.js";
import { ProjectSections } from "@/project-sidebar/ProjectSections.js";
import { ProjectSidebarListHeader } from "@/project-sidebar/ProjectSidebarListHeader.js";
import { ProjectSidebarNavigation } from "@/project-sidebar/ProjectSidebarNavigation.js";
import { HomeOnlyWorkspaceRows } from "@/project-sidebar/HomeOnlyWorkspaceRows.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { SidebarBottomActivity } from "@/sidebar-activity/SidebarBottomActivity.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
export { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";
export { resolveEntryProject } from "@/project-sidebar/view.js";
export type {
  SidebarFileTreeOpenRequest,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";

// 右侧面板显隐曾让所有项目的菜单和 Tooltip 重渲染；只隔离无关父更新，保留目录/context 订阅。
export const ProjectSidebar = memo(function ProjectSidebar(props: ProjectSidebarProps) {
  // [契约] 目录 Provider 是本侧栏唯一的树与偏好来源，props 只提供 workspace 身份和回调。
  // [契约] directory 与 props 同名概念冲突时以 Provider 为准，避免出现第二份项目视图。
  // [权衡] 一次性解构本组件需要的 Provider 字段（不含 projects），代价是对 Provider 形状敏感；换取下方零 props 透传噪声。
  const {
    tree: authoritativeTree,
    directory,
    service,
    remoteService,
    availability,
    refresh,
    error,
    loading,
    preferences,
    groups,
    deviceNames,
  } = useProjectDirectory();
  // [事务] pin 覆盖层叠在权威树上，未落盘时列表先按意图显示，回滚由 hook 负责。
  // [并发] 远端刷新与本地 pin 冲突时以 hook 的合并结果为准，本文件不再二次比较。
  // [失败路径] pin 写入失败不会回退这里的入参，提示由写操作所在处承担。
  const { tree, pin } = useProjectPinIntent(authoritativeTree);
  // [并发] 远端连接状态由该 hook 订阅，本文件只消费 actions 与 dialog，不自行轮询。
  // [资源] dialog 是 hook 产出的元素，挂在 aside 末尾而非列表内，避免被滚动区裁切。
  // [契约] actions 原样下传给每个 ProjectSidebarNode，单个项目行不各自建连。
  const remoteSync = useProjectRemoteSync(props, directory);
  // [契约] diagnostics 以 hostId 为键，只在 renderProject 内按当前项目取值。
  // [资源] 诊断一次算全量，换取取值简单；项目多时依赖 hook 内部节流。
  // [权衡] 不按可见项目懒加载诊断，避免展开/折叠触发二次请求风暴。
  const diagnostics = useProjectConnectionDiagnostics(directory, props);
  // [契约] 任务导航统一走此回调，pinned/项目/分组/时间线四种行共用同一入口。
  // [事务] 选中即开 tab 的副作用在 hook 内完成，本文件不重复 open。
  const onSelectTask = useProjectTaskNavigation(props, tree, remoteService);
  // [契约] 文案统一经 msg()/intl 取 project.* 命名空间，不在此拼接中文字面量。
  // [契约] localePreference 含 system 语义，footer 展示偏好值而非已解析语言。
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const tabStore = useTabStoreApi();
  const setTheme = useZCodeStore((state) => state.setTheme);
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  // [契约] view 是持久化偏好，projects/grouped/timeline 三选一，切视图不重置展开态。
  // [资源] 三态共享同一个 ScrollFadeViewport 与 scrollRef，切换不重建滚动容器。
  // [权衡] 用三元分支而非路由，保证侧栏内切换无 URL 与历史记录副作用。
  const { view, setView } = preferences;
  // [资源] scrollRef 指向任务列表的唯一滚动视口，TaskGroupedView 借它做锚点与吸顶。
  // [并发] ref 在首次提交后才有值，分组 hook 必须在 effect 内读取而非渲染期。
  // [失败路径] 视图切换导致节点重建时，滚动位置由视口自身保留，本文件不手工 scrollTo。
  // [权衡] 不把滚动偏移存进 state：避免每帧重渲染，也不把视图事实写进偏好。
  const scrollRef = useRef<HTMLDivElement>(null);
  // [契约] 工具条宿主由 ref 回调回填 state，供分组视图挂载，不用 querySelector。
  // [失败路径] 未回填时为 null，分组视图需自行跳过挂载而不是渲染到 body。
  const [groupedToolbar, setGroupedToolbar] = useState<HTMLDivElement | null>(null);
  // [契约] sticky 占位节点位于滚动容器之外，吸顶元素不参与滚动高度计算。
  // [失败路径] 占位缺失时吸顶退化为普通行，不抛错也不阻塞列表。
  const [groupedSticky, setGroupedSticky] = useState<HTMLDivElement | null>(null);
  // [契约] null 表示关闭；project 为 null 表示新建，两者语义靠 key 为 new 区分。
  // [权衡] 弹层开关留在本地 state，不持久化，刷新后回到项目列表。
  const [editor, setEditor] = useState<{ project: VirtualProject | null } | null>(null);
  // [契约] 创建弹层只由 ProjectSections 的 onAddProject 打开，关闭时无条件置 false。
  // [失败路径] service/remoteService 缺失时条件渲染为 null，state 可残留但不可见。
  const [creating, setCreating] = useState(false);
  // 当前任务只影响远端“创建项目”的默认设备；分组继承在点击时读，
  // 避免本地会话/草稿切换让全部项目的菜单与 Tooltip 重渲染。
  // [并发] 选择器只投影布尔值，避免 activeTaskId 变化引发项目行批量重渲染。
  // [契约] 身份键沿用 workspaceIdentity?.trim() || workspacePath，与全局约定一致。
  // [权衡] 用 Boolean 包住可选链，代价是无法区分无任务与未知，本处只需前者。
  const hasActiveRemoteTask = useZCodeSessionStore((state) =>
    Boolean(
      props.workspaceIdentity &&
      state.workspaces[props.workspaceIdentity.trim() || props.workspacePath]?.activeTaskId,
    ),
  );
  // [契约] remotePicker 持有 host 本身而非 id，弹层以 membershipId 作 key 重置表单。
  // [失败路径] host 被移除后 state 仍可能停留，关闭动作由 onClose 统一清理。
  const [remotePicker, setRemotePicker] = useState<RemoteProjectHost | null>(null);
  // [契约] openFiles 给项目级查看文件，openTaskFiles 给任务级入口，两者不混用。
  // [资源] 文件树打开请求走 props 回调，侧栏不自己建文件树实例。
  // [失败路径] 远端项目离线时由 hook 决定降级，本文件不做可用性二次判断。
  const { openFiles, openTaskFiles } = useProjectFileTree(props, directory, remoteService);
  // [契约] 远控开关是 feature flag，只影响状态订阅，不影响本地列表渲染。
  // [权衡] 与 isDesktop 组合成 enabled，避免 Web 端无谓建立状态通道。
  const remoteControlEnabled = useWebRemoteControlFeatureEnabled();
  // [资源] 订阅以 enabled 为前提，桌面且开关开启才建立连接，减少无谓心跳。
  // [并发] mobileConnected 是瞬时值，只能用于高亮，不能用于路由判断。
  // [失败路径] 断连时 mobileView 退化为 null，列表回落到本地任务态。
  const mobileStatus = useWebRemoteControlStatus({
    enabled: Boolean(props.isDesktop && remoteControlEnabled),
  });
  // [契约] 手机远控视图状态是投影，不写入项目树，也不参与排序与分组键。
  // [失败路径] mobileViewState 结构变化时只影响高亮 key，不影响行渲染。
  const mobileView = mobileStatus.mobileConnected ? mobileStatus.mobileViewState : null;
  const mobileActiveTaskKey =
    mobileView?.activeWorkspaceKey && mobileView.activeTaskId
      ? `${mobileView.activeWorkspaceKey}:${mobileView.activeTaskId}`
      : null;
  // [契约] taskPresentation 是 ProjectTaskListContext 的值，统一描述 pin 与开文件能力。
  // [并发] activeWorkspaceKey 用 trim() 加 path 归一，手机高亮才能与本地 key 对齐。
  // [权衡] 依赖逐项列出而非整个 props，避免父级对象字面量让 memo 失效。
  const taskPresentation = useMemo(
    () => ({
      isWebRemoteControl: props.isWebRemoteControl,
      activeWorkspaceKey: props.workspaceIdentity?.trim() || props.workspacePath,
      mobileActiveTaskKey,
      onPin: pin,
      onOpenTaskFiles: openTaskFiles,
    }),
    [
      props.isWebRemoteControl,
      props.workspacePath,
      props.workspaceIdentity,
      mobileActiveTaskKey,
      pin,
      openTaskFiles,
    ],
  );
  // [契约] 仅用于项目命名空间，其他命名空间直接调用 intl，避免前缀串味。
  // [权衡] 每次调用都 formatMessage，未做缓存；文案量小且不参与 diff。
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  // [契约] 新建任务的唯一出口：三个可选参数分别表达归属项目、远端 host、目标分组。
  // [事务] 先读 store 拿 activeTaskId，再决定继承分组，最后一次性调用 onCreateTask。
  // [并发] 用 getState() 而非订阅，保证点击瞬间取值，不受渲染批次影响。
  // [权衡] 三层三元嵌套可读性差，但避免中间变量把继承逻辑散成多处。
  // [失败路径] projectId 与分组继承互斥：显式传项目时不再继承当前任务分组。
  const start = async (projectId?: string, hostId?: string, taskGroupId?: string | null) => {
    const activeTaskId = useZCodeSessionStore
      .getState()
      .getWorkspaceState(props.workspacePath, props.workspaceIdentity).activeTaskId;
    const inheritedGroup =
      view === "grouped" && !projectId && activeTaskId
        ? (groups.parents.get(
            taskGroupKey({
              taskId: activeTaskId,
              workspacePath: props.workspacePath,
              workspaceIdentity: props.workspaceIdentity,
            }),
          ) ?? null)
        : view === "grouped" && !projectId
          ? (useZCodeSessionStore
              .getState()
              .getWorkspaceState(props.workspacePath, props.workspaceIdentity).draftTaskGroupId ??
            null)
          : null;
    props.onCreateTask({
      projectId: projectId ?? null,
      taskGroupId: taskGroupId === undefined ? inheritedGroup : taskGroupId,
      ...(hostId ? { hostId } : {}),
    });
  };
  // [契约] 排序是 reorder 偏好（用户手排加置顶优先），选择器只负责过滤与投影。
  // [事务] 列表顺序与 preferences.reorder 的入参必须同源，否则拖拽落点错位。
  // [权衡] 每次渲染重算排序，项目量级小；换取不维护排序缓存的一致性。
  const projects = preferences.sort(selectSortedProjects(tree));
  // [契约] 仅 online 不为 false 的项目参与全部展开/收起，离线项目不改变计数。
  // [失败路径] availability 缺项视为未知而非离线，避免首屏按钮被禁用。
  // [权衡] 用 filter 而非 useMemo：依赖 projects 与 availability，重算代价可忽略。
  const expandableProjects = projects.filter(
    (project) => availability.get(projectKey(project))?.online !== false,
  );
  // [契约] allExpanded 只驱动全部展开/收起按钮的语义，不参与单项目展开态。
  // [事务] 它是派生值，与 isExpanded 的写入同帧生效，不单独存 state。
  const hasExpandedProjects = expandableProjects.some(preferences.isExpanded);
  // [契约] 拖拽入参是 projectKey 字符串，先映射回项目再判断是否可换位。
  // [事务] 只在同一 pinned 分组内换位；跨组拖拽被静默丢弃，不做二次确认。
  // [失败路径] source 或 target 缺失（列表刷新竞态）时直接返回，不写偏好。
  const reorder = (active: string, over: string) => {
    const source = projects.find((item) => projectKey(item) === active);
    const target = projects.find((item) => projectKey(item) === over);
    if (!source || !target || source.pinned !== target.pinned) return;
    preferences.reorder(
      projects.filter((item) => item.pinned === source.pinned),
      active,
      over,
    );
  };
  // [契约] 项目行的唯一渲染工厂：pinned 段、ProjectSections、拖拽容器共用它。
  // [契约] deviceLabel/remoteHost/diagnostics 都按当前项目局部查询，不预算全量映射。
  // [并发] tasks 用 selectProjectRows 按 kind 为 project 现取，树更新即行更新。
  // [失败路径] remoteHost 找不到时传 undefined，行内降级为本地展示而不隐藏项目。
  // [权衡] 工厂函数每次渲染新建，牺牲引用稳定换取闭包内取值总是最新。
  const renderProject = (project: VirtualProject) => (
    <ProjectSidebarNode
      key={projectKey(project)}
      project={project}
      deviceLabel={deviceNames.get(projectSourceServerId(project) ?? "")}
      remoteHost={directory.hosts.find((host) => host.id === project.hostId)}
      diagnostics={diagnostics.get(project.hostId)}
      expanded={preferences.isExpanded(project)}
      onExpandedChange={preferences.setExpanded}
      hasUnread={projectHasUnread(authoritativeTree, project)}
      availability={availability.get(projectKey(project))}
      tasks={selectProjectRows(tree, {
        kind: "project",
        projectId: project.id,
        hostId: project.hostId,
      })}
      onSelect={onSelectTask}
      refresh={refresh}
      service={service}
      remoteService={remoteService}
      isDesktop={props.isDesktop}
      isWebRemoteControl={props.isWebRemoteControl}
      onCreateTask={props.onCreateTask}
      onReconnectRemoteWorkspace={props.onReconnectRemoteWorkspace}
      onEdit={setEditor}
      onViewFiles={openFiles}
      remoteActions={remoteSync.actions}
    />
  );
  // [契约] 设置入口只走 tabStore.openSettingsTab，侧栏不自管路由。
  // [资源] useCallback 稳定引用，避免 footer 因父重渲染而失效 memo。
  const openSettings = useCallback(() => {
    tabStore.getState().openSettingsTab();
  }, [tabStore]);
  // [契约] locale 值来自 footer 菜单，类型收窄到 Locale 或 system。
  // [事务] 写入偏好即广播同步，本文件不做本地镜像。
  const changeLocale = useCallback(
    (value: string) => setLocalePreference(value as Locale | "system"),
    [setLocalePreference],
  );
  // [契约] 主题写 store（跨窗口广播），与 locale 走偏好不同，二者不要统一。
  // [权衡] 断言 Theme 依赖菜单枚举与 store 类型保持一致。
  const changeTheme = useCallback((value: string) => setTheme(value as Theme), [setTheme]);
  // [契约] 升级入口参数从 footer 的 onUpgradeClick 类型反推，避免自造签名。
  // [事务] 打开升级弹窗由 Provider 负责，本文件不处理 providerId 语义。
  const upgrade = useCallback<
    NonNullable<Parameters<typeof WorkspaceSidebarFooter>[0]["onUpgradeClick"]>
  >(
    (providerId, funnelContext) => openCodingPlanUpgrade({ providerId, funnelContext }),
    [openCodingPlanUpgrade],
  );
  // [资源] banner 元素只创建一次，活动条不随 footer 重渲染而重挂载。
  // [契约] 它作为 footer 的插槽内容，内部状态由子组件自持。
  const banner = useMemo(() => <SidebarBottomActivity />, []);
  // 手机远控 home-only 没有 base attachment，也就没有项目契约；改用 relay 层工作区列表与重连入口。
  // [契约] 有 base service 时走项目契约；无 service 的手机远控走 relay 工作区列表。
  // [失败路径] 两者都为空时展示空态，而不是渲染本地项目。
  // [权衡] 用有无 service 判断能力，避免再引入一个显式 mode 字段。
  const homeOnlySwitcher = service ? undefined : props.webRemoteControlWorkspaceSwitcher;
  // [契约] 渲染树顺序固定：拖拽区、导航、列表、footer，弹层与 dialog 置于最后。
  // [契约] 快捷键与焦点由 ProjectSidebarNavigation 及行组件自持，本层只给 onCreate。
  // [失败路径] 弹层都按需条件渲染，不塞进滚动容器以免被 overflow 裁掉。
  return (
    <ProjectTaskListContext.Provider value={taskPresentation}>
      <SidebarTooltipProvider>
        <aside data-testid={TID_SIDEBAR} className="flex h-full min-h-0 flex-col overflow-hidden">
          <div
            className={`h-12 shrink-0 [app-region:drag] ${props.isWebRemoteControl ? "max-md:hidden" : ""}`}
          />
          {/* 内联改名聚焦曾把 hidden 容器横向滚动，导致手机整栏左移；滑动面板只裁切，不允许焦点滚动。 */}
          <div className="relative min-h-0 flex-1 overflow-clip">
            <div
              data-project-sidebar-panel="navigation"
              className="absolute inset-0 flex min-h-0 flex-col"
            >
              {/* 原因：顶层新建显式传 null 会抹掉当前项目；省略归属，让 Root 与快捷键共用继承路径。 */}
              <ProjectSidebarNavigation props={props} onCreate={() => props.onCreateTask()} />
              <div
                data-testid="sidebar-task-list-region"
                className="flex min-h-0 flex-1 flex-col border-t border-border/50 pt-3 [anchor-name:--sidebar-task-list-divider]"
              >
                <ProjectSidebarListHeader
                  onOpenCommandCenter={props.onOpenCommandCenter}
                  view={view}
                  onViewChange={setView}
                  groupedActionsRef={setGroupedToolbar}
                />
                {/* 原因：仅设 overflow-y:auto 会让拖拽位移打开水平滚动；列表始终只允许纵向滚动。 */}
                {/* 原因：项目侧栏迁移后普通滚动容器遗漏边缘渐隐；复用统一 mask，随实际滚动边界更新。 */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <div ref={setGroupedSticky} />
                  <ScrollFadeViewport ref={scrollRef} className="overflow-x-hidden">
                    <div className="flex flex-col gap-3 pb-3">
                      {homeOnlySwitcher ? (
                        <HomeOnlyWorkspaceRows switcher={homeOnlySwitcher} />
                      ) : view === "projects" ? (
                        <>
                          <ProjectTaskRows
                            kind="pinned"
                            tasks={selectProjectRows(tree, { kind: "pinned" })}
                            onSelect={onSelectTask}
                            refresh={refresh}
                          />
                          <SortableProjects
                            projects={projects.filter((project) => project.pinned)}
                            renderProject={renderProject}
                            onReorder={reorder}
                          />
                          <ProjectSections
                            tree={tree}
                            projects={projects}
                            directory={directory}
                            renderProject={renderProject}
                            onReorder={reorder}
                            loading={loading}
                            onSelect={onSelectTask}
                            refresh={refresh}
                            onCreate={() => action(() => start())}
                            onAddProject={() => setCreating(true)}
                            hasExpandedProjects={hasExpandedProjects}
                            canToggleProjects={expandableProjects.length > 0}
                            onToggleProjects={() =>
                              preferences.setAllExpanded(expandableProjects, !hasExpandedProjects)
                            }
                          />
                        </>
                      ) : view === "grouped" ? (
                        <>
                          <ProjectTaskRows
                            kind="pinned"
                            tasks={selectProjectRows(tree, { kind: "pinned" })}
                            onSelect={onSelectTask}
                            refresh={refresh}
                          />
                          <TaskGroupedView
                            tasks={tree.tasks}
                            onSelect={onSelectTask}
                            refresh={refresh}
                            scrollRef={scrollRef}
                            toolbarTarget={groupedToolbar}
                            stickyTarget={groupedSticky}
                            workspacePath={props.workspacePath}
                            workspaceIdentity={props.workspaceIdentity}
                            onOpenAutomations={props.onOpenAutomations}
                            onCreate={(groupId) =>
                              action(() => start(undefined, undefined, groupId))
                            }
                          />
                        </>
                      ) : (
                        <ProjectTaskRows
                          key="timeline"
                          kind="timeline"
                          tasks={selectProjectRows(tree, { kind: view })}
                          onSelect={onSelectTask}
                          refresh={refresh}
                        />
                      )}
                      {loading && !homeOnlySwitcher ? (
                        <p className="px-4 text-ui-sm text-foreground-subtle">
                          {intl.formatMessage({ id: "common.loading" })}
                        </p>
                      ) : null}
                      {error && !homeOnlySwitcher ? (
                        <p role="alert" className="px-4 text-ui-sm text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </div>
                  </ScrollFadeViewport>
                </div>
              </div>
              <WorkspaceSidebarFooter
                className="pr-3"
                theme={props.theme}
                localeMenuValue={localePreference}
                onLocaleChange={changeLocale}
                onThemeChange={changeTheme}
                onSettingsButtonClick={openSettings}
                onUsageClick={openSettings}
                onUpgradeClick={upgrade}
                onLogin={props.onLogin}
                onLogout={props.onLogout}
                user={props.user}
                workspacePath={props.workspacePath}
                // 项目侧栏不再从 tab 反推身份；远控入口必须沿用当前 attachment 的精确 scope。
                workspaceIdentity={props.workspaceIdentity}
                workspaceRemoteSessionId={props.workspaceRemoteSessionId}
                isDesktop={props.isDesktop}
                banner={banner}
              />
            </div>
          </div>
          {creating && service && remoteService ? (
            <ProjectCreation
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              onCreateTask={props.onCreateTask}
              directory={directory}
              defaultDeviceId={
                hasActiveRemoteTask && props.workspaceIdentity
                  ? (remoteHostIdFromWorkspaceIdentity(props.workspaceIdentity) ?? "local")
                  : "local"
              }
              allowDeviceManagement={props.isDesktop === true}
              projects={tree.projects}
              service={service}
              remoteService={remoteService}
              onOpenRemoteWorkspace={props.onOpenRemoteWorkspace}
              onClose={() => setCreating(false)}
              onSaved={refresh}
            />
          ) : null}
          {remotePicker && service && remoteService ? (
            <RemoteProjectPicker
              key={remotePicker.membershipId}
              host={remotePicker}
              service={service}
              remoteService={remoteService}
              onClose={() => setRemotePicker(null)}
              onSaved={refresh}
            />
          ) : null}
          {editor && service ? (
            <ProjectEditor
              key={editor.project?.id ?? "new"}
              project={editor.project}
              host={directory.hosts.find((host) => host.id === editor.project?.hostId)}
              projects={tree.projects.filter(
                (project) => !availability.get(projectKey(project))?.entryId,
              )}
              service={service}
              onClose={() => setEditor(null)}
              onSaved={refresh}
              onDeleted={refresh}
            />
          ) : null}
          {remoteSync.dialog}
        </aside>
      </SidebarTooltipProvider>
    </ProjectTaskListContext.Provider>
  );
});

export { ComposerSubmissionPendingContext } from "@/project-sidebar/ComposerSubmissionPendingContext.js";
