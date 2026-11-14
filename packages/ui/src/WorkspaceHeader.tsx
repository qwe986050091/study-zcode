// INV-01 组件只做顶栏布局与分发，不持有工作区事实；守住位置：WorkspaceHeader 函数体内只有 selectedEditor 一个状态；改错故障：组件内另存路径或任务状态，与上层 owner 形成两份真相，标题与菜单可能显示不同任务。
// INV-02 侧栏可见时不预留浮层留白；守住位置：resolveTopOverlayLeadingPaddingClass 首个分支返回 false；改错故障：侧栏展开仍加左内边距，标题整体右移，宽屏下出现一条空槽。
// INV-03 留白以类名而非像素表达；守住位置：resolveTopOverlayLeadingPaddingClass 各分支返回 pl- 开头的字符串；改错故障：改成内联像素值后调用方无法再用 cn 合并，条件类名互相覆盖。
// INV-04 更新徽标要占额外宽度；守住位置：hasUpdateReady 为真时返回 pl-66、pl-48、pl-44；改错故障：沿用无徽标档位，更新按钮压住标题右侧统计。
// INV-05 macOS 全屏与窗口态分开取值；守住位置：isMacDesktop 分支内的 isMacFullscreen 三元；改错故障：全屏仍用窗口态留白，标题左侧多出一大块空白。
// INV-06 variant 默认必须是 task；守住位置：参数解构中的默认值；改错故障：默认改成 draft 后底边透明且标题区不渲染，普通任务页顶栏只剩动作区。
// INV-07 标题区在四种情形下渲染；守住位置：variant 为 task，或 remoteTarget、workspaceIdentity、remoteSessionId 任一存在；改错故障：漏掉远端三项，远端会话头部看不到当前工作区标识。
// INV-08 远端标识必须原样下传；守住位置：WorkspaceHeaderTitleSection 的 remoteTarget、workspaceIdentity、remoteSessionId 三个属性；改错故障：只传路径时远端与本地同名工作区混为一条，菜单与日志指向错误目标。
// INV-09 选中编辑器属本地展示态；守住位置：useState 的 selectedEditor 与动作区的 onSelectedEditorChange；改错故障：写进全局 store 后多窗口互相覆盖高亮。
// INV-10 内联窗控判定只看平台组合；守住位置：usesInlineWindowControls 的布尔表达式；改错故障：把 Web 远控也算进去，手机端多出三颗无效窗控按钮。
// INV-11 Web 远控默认关闭；守住位置：isWebRemoteControl 的默认值；改错故障：默认成 true 后桌面端进入简化布局，隐藏本应可见的操作。
// INV-12 窄屏简化默认关闭；守住位置：simplifyForNarrowRemote 的默认值；改错故障：默认简化后桌面端标题统计信息被裁掉。
// INV-13 底边仅在非草稿态显示；守住位置：header 的 cn 中 variant 为 draft 的分支；改错故障：草稿页也画分隔线，与浮动输入区之间出现错位边框。
// INV-14 过渡只声明 padding；守住位置：内层容器的 transition-[padding] 与上方两行说明；改错故障：退回默认 all 后，大会话 resize trace 期间滚动条颜色参与动画并掉帧。
// INV-15 遮罩只在草稿态且控制器激活时挂载；守住位置：variant 为 draft 与 draftDropTargetController 的 active 两个条件；改错故障：任务态也渲染遮罩，整块顶栏被高层覆盖且无法点击。
// INV-16 遮罩事件必须同源；守住位置：遮罩上三个拖拽回调全部取自 draftDropTargetController；改错故障：只接投放事件时浏览器默认行为接管，直接把文件打开。
// INV-17 动作区显隐开关要显式传入；守住位置：hideHelpMenu 与 showWindowControls 两个属性；改错故障：删掉后回落到子组件默认，帮助菜单或窗控在错误平台出现。
// INV-18 未被解构的 props 不在此消费；守住位置：props 类型中的 onToggleBrowser、onCreateTask、onOpenWorkspace 等未出现在解构列表；改错故障：误以为本层已接线而新增调用，形成第二条动作入口。
//
// 模块职责：工作区头部外壳，负责顶栏高度与底边、侧栏收起时的浮层留白、草稿态拖放遮罩，并把标识、任务、日志与平台信息分发给标题区与动作区。
// 状态所有权：工作区路径、任务元信息、Git 摘要、日志路径与平台标识全部由上层注入，本组件只持有 selectedEditor 这一项展示态。
// 阅读顺序：先看留白工具函数，再看 props 契约与派生量，随后是 header 根节点、草稿遮罩、内层布局、标题区条件与动作区传参。
import type {
  ZCodeProvider,
  ZCodeTaskMeta,
  ZCodeTaskChangeSummary,
  EditorInfo,
  GitRepositorySummary,
  RemoteTarget,
  UserInfo,
} from "@zcode/shared";
import { useState } from "react";
import { TID_WORKSPACE_HEADER } from "@zcode/shared/test-ids";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { cn } from "@/components/lib/utils.js";
import {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderState,
  WorkspaceHeaderTitleSection,
} from "@/WorkspaceHeaderSections.js";
import type { WorkspaceHeaderVariant } from "@/WorkspaceHeaderSections/shared.js";

/**
 * 侧栏收起时左上角浮层（侧栏开关、前进后退、新建、更新）盖在内容区顶栏上，顶栏需要让出的左侧留白。
 * WorkspaceHeader 与 Side Pane 完整视图的 tab 栏共用这一规则。
 */
// [契约] `resolveTopOverlayLeadingPaddingClass` 只回答一件事：侧栏收起后顶栏要给左上角浮层让出多少左边距，其余属性不归函数管。
// [契约] 入参只有侧栏可见性、平台标识与更新徽标，调用方无需关心浮层内部有几颗按钮。
// [顺序] 侧栏可见时首个分支直接返回 false，类名不参与拼接，顶栏保持原始内边距。
// [权衡] macOS 留白明显大于其他平台，因为浮层含红绿灯与新建按钮，而 Windows 与 Linux 只有一组操作。
// [事务] 更新徽标只在基础宽度之外再让一档，四组取值都写死为类名，避免渲染期测量布局。
// [失败路径] 返回 false 而非空串，交给 cn 过滤，改成空串会多出一个无意义的空类。
// [契约] 该函数被侧栏收起态的多个顶部容器共用，取值必须与 Side Pane 完整视图的 tab 栏保持一致。
export function resolveTopOverlayLeadingPaddingClass({
  isSidebarVisible,
  isMacDesktop,
  isMacFullscreen,
  hasUpdateReady,
}: {
  isSidebarVisible: boolean;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  hasUpdateReady?: boolean;
}): string | false {
  if (isSidebarVisible) return false;
  if (isMacDesktop) {
    if (hasUpdateReady) return isMacFullscreen ? "pl-48" : "pl-66";
    return isMacFullscreen ? "pl-38" : "pl-58";
  }
  return hasUpdateReady ? "pl-44" : "pl-38";
}

// [契约] 参数解构只列本组件真正使用的字段，类型里其余可选入口留给上层容器自行处理。
// [状态] 工作区路径、任务元信息、Git 摘要与日志路径都是自上而下的投影，本组件从不写回。
// [状态] 两个平台开关显式给 false：Web 远控与窄屏简化默认不启用，其余平台标识由外层传入。
// [契约] onReloadSession 允许返回 Promise，调用方可以等待重载完成再收起菜单。
// [顺序] 解构顺序按信息源分组：标识与任务、会话与日志、平台差异、交互回调。
export function WorkspaceHeader({
  variant = "task",

  draftDropTargetController,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary,
  hasUpdateReady,
  activeTaskId,
  user,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  sessionLogPath,
  nativeSessionLogProvider,
  nativeSessionLogPath,
  nativeSessionLogExists,
  nativeSessionLogLoading,
  providerWorkspaceConfigPath,
  providerWorkspaceConfigExists,
  providerWorkspaceConfigLoading,
  workspaceHeaderState,
  gitSummary,
  gitDirtyFileCount,
  isMacDesktop,
  isMacFullscreen,
  isWindowsDesktop,
  isWebRemoteControl = false,

  isDesktop,
  simplifyForNarrowRemote = false,
  isSidebarVisible,
  isTerminalOpen,
  isSidePaneOpen,
  onRefreshGit,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onReloadSession,
  reloadSessionDisabled,
  reloadSessionPending,
}: {
  variant?: WorkspaceHeaderVariant;
  draftDropTargetController?: ConversationDropTargetController | null;
  readOnlyReason?: string;
  workspaceAbsPath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  projectName: string;
  activeTaskTitle: string;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  hasUpdateReady: boolean;
  activeTaskId: string | null;
  user?: UserInfo | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  sessionLogPath: string | null;
  nativeSessionLogProvider: ZCodeProvider | null;
  nativeSessionLogPath: string | null;
  nativeSessionLogExists: boolean;
  nativeSessionLogLoading: boolean;
  providerWorkspaceConfigPath: string | null;
  providerWorkspaceConfigExists: boolean;
  providerWorkspaceConfigLoading: boolean;
  workspaceHeaderState: WorkspaceHeaderState;
  gitSummary: GitRepositorySummary;
  gitDirtyFileCount: number;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  reserveWindowControls?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  isDesktop?: boolean;
  simplifyForNarrowRemote?: boolean;
  isSidebarVisible: boolean;
  isTerminalOpen: boolean;
  isSidePaneOpen: boolean;
  onRefreshGit: () => void;
  onToggleTerminal: () => void;
  onToggleBrowser: () => void;
  onToggleSidePane: () => void;
  toggleSidePaneShortcutLabel?: string;
  onReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => void | Promise<void>;
  reloadSessionDisabled?: boolean;
  reloadSessionPending?: boolean;
  onCreateTask: () => void;
  onOpenWorkspace: () => void;
  allowOpenWorkspace?: boolean;
}) {
  // [状态] 唯一本地状态是用户选中的编辑器，仅用于动作区高亮与菜单勾选。
  // [权衡] 该选择不进全局 store，因为它不构成服务端事实，也不需要跨窗口同步。
  // [事务] 初始为 null，动作区据此显示未指定，不会伪造一个默认编辑器。
  // [顺序] 派生量在状态之后计算，每次渲染先有选中值再推导类名与窗控判定。
  const [selectedEditor, setSelectedEditor] = useState<EditorInfo | null>(null);
  // Linux 与 Windows 共用内联窗控，不再预留旧悬浮窗控的标题栏区域。
  const usesInlineWindowControls = Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop));
  const headerWindowControlsPaddingClass = resolveTopOverlayLeadingPaddingClass({
    isSidebarVisible,
    isMacDesktop,
    isMacFullscreen,
    hasUpdateReady,
  });

  return (
    // [契约] header 是唯一根节点，测试 id 与 variant 数据属性都挂在这里，外部选择器依赖它们。
    // [契约] data-workspace-header-variant 让样式与测试按 task 与 draft 分流，不靠类名判断。
    // [渲染] 高度固定为 h-12 且禁止收缩，内容变长时不会把顶栏挤高。
    // [渲染] variant 为 draft 时 `border-transparent` 去掉底边，与下方浮动输入区连成一片；常规 variant 保留 `border-border/50` 的分隔。
    // [权衡] 根节点声明容器查询上下文，宽度变化由内层响应，不依赖全局断点。
    <header
      data-testid={TID_WORKSPACE_HEADER}
      data-workspace-header-variant={variant}
      className={cn(
        "@container/workspace-header relative flex w-full shrink-0 h-12 border-b",
        variant === "draft" ? "border-transparent" : "border-border/50",
      )}
    >
      {variant === "draft" && draftDropTargetController?.active ? (
        <div
          className="absolute inset-0 z-40 bg-accent/55 backdrop-blur-sm pointer-events-auto [app-region:no-drag]"
          data-testid="new-task-draft-drop-mask"
          onDragOver={draftDropTargetController.onDragOver}
          onDragLeave={draftDropTargetController.onDragLeave}
          onDrop={draftDropTargetController.onDrop}
        />
      ) : null}
      <div
        className={cn(
          // 大会话 resize trace 显示 titlebar padding 动画层会触发 scrollbar-color 非合成动画；
          // 明确限定 transition-property 为 padding，避免 duration-300 退回默认 all。
          // [事务] 内层容器承载真正的一行布局：两端对齐、禁止溢出、内边距统一为 p-2。
          // [渲染] 过渡只声明 padding，上方注释解释了原因：默认 all 会让滚动条颜色参与动画。
          // [失败路径] 若改回 all 配 duration-300，大会话 resize trace 期间会出现明显掉帧。
          // [契约] min-w-0 让标题区可被压缩，去掉后长路径会把动作区挤出可视范围。
          // [渲染] 拖拽区域设为 drag 让空白处可拖动窗口，交互元素各自覆盖为 no-drag。
          // [顺序] 平台留白类名放在最后拼接，调用方传入的条件类因此能覆盖默认内边距。
          "flex h-12 flex-1 min-w-0 items-center justify-between gap-2 overflow-hidden p-2 [app-region:drag] transition-[padding] duration-300",
          // 旧 caption 菜单移除后不能继续清零右边距，否则终端按钮会贴住面板边框。
          headerWindowControlsPaddingClass,
        )}
      >
        {variant === "task" || remoteTarget || workspaceIdentity || remoteSessionId ? (
          <WorkspaceHeaderTitleSection
            variant={variant}
            readOnlyReason={readOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            remoteSessionId={remoteSessionId}
            workspaceIdentity={workspaceIdentity}
            remoteTarget={remoteTarget}
            localWorkspacePath={localWorkspacePath}
            projectName={projectName}
            activeTaskTitle={activeTaskTitle}
            activeTaskChangeSummary={activeTaskChangeSummary}
            activeTaskId={activeTaskId}
            activeTraceId={activeTraceId}
            activeSessionId={activeSessionId}
            activeTaskProvider={activeTaskProvider}
            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
            gitSummary={gitSummary}
            gitDirtyFileCount={gitDirtyFileCount}
            sessionLogPath={sessionLogPath}
            nativeSessionLogProvider={nativeSessionLogProvider}
            nativeSessionLogPath={nativeSessionLogPath}
            nativeSessionLogExists={nativeSessionLogExists}
            nativeSessionLogLoading={nativeSessionLogLoading}
            providerWorkspaceConfigPath={providerWorkspaceConfigPath}
            providerWorkspaceConfigExists={providerWorkspaceConfigExists}
            providerWorkspaceConfigLoading={providerWorkspaceConfigLoading}
            workspaceHeaderState={workspaceHeaderState}
            isMacDesktop={isMacDesktop}
            isMacFullscreen={isMacFullscreen}
            isWindowsDesktop={isWindowsDesktop}
            isWebRemoteControl={isWebRemoteControl}
            simplifyForNarrowRemote={simplifyForNarrowRemote}
            selectedEditor={selectedEditor}
            onReloadSession={onReloadSession}
            reloadSessionDisabled={reloadSessionDisabled}
            reloadSessionPending={reloadSessionPending}
            onRefreshGit={onRefreshGit}
          />
        ) : (
          <div className="min-w-0 flex-1" aria-hidden="true" />
        )}
        <WorkspaceHeaderActionSection
          variant={variant}
          activeTaskId={activeTaskId}
          user={user}
          readOnlyReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          remoteTarget={remoteTarget}
          isWebRemoteControl={isWebRemoteControl}
          isDesktop={isDesktop}
          isTerminalOpen={isTerminalOpen}
          isSidePaneOpen={isSidePaneOpen}
          onToggleTerminal={onToggleTerminal}
          onToggleSidePane={onToggleSidePane}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          simplifyForNarrowRemote={simplifyForNarrowRemote}
          hideHelpMenu={false}
          showWindowControls={usesInlineWindowControls}
          // 面板操作按钮沿用 macOS 紧凑样式，Windows/Linux 窗控跟随最右侧 Header。
          onSelectedEditorChange={setSelectedEditor}
        />
      </div>
    </header>
  );
}
