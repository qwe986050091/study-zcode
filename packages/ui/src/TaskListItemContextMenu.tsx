// INV-01 纯展示装配：守住位置 组件体；改错故障 右键菜单自己取服务或改任务状态。
// INV-02 组织动作排在最前：守住位置 organizationActions；改错故障 分组命令被任务动作挤到后面。
// INV-03 菜单项实现可注入：守住位置 Item / Separator；改错故障 右键菜单与操作面板分叉。
// INV-04 动作清单只有一份：守住位置 TaskActionMenuContent；改错故障 两处菜单项增减不同步。
// INV-05 全部动作回调透传：守住位置 各 on* props；改错故障 右键菜单里点击无反应。
// INV-06 可选动作保持可选：守住位置 onCopySessionId / onViewModelTrajectory；改错故障 缺数据时出现死按钮。
// INV-07 禁用态整体下传：守住位置 disableTaskActions；改错故障 部分动作在禁用任务上仍可点。
// INV-08 禁用原因一并下传：守住位置 disabledReason；改错故障 悬停没有解释。
// INV-09 会话文件三态透传：守住位置 taskSessionFile；改错故障 加载中与不存在被混为一谈。
// INV-10 原生日志与人读日志分开：守住位置 taskNativeSessionLogFile；改错故障 复制到错误路径。
// INV-11 供应商配置独立入参：守住位置 providerConfigFile；改错故障 打不开当前任务的配置。
// INV-12 宽度固定：守住位置 w-52；改错故障 长文案把菜单撑出屏幕。
// INV-13 intl 由调用方注入：守住位置 intl prop；改错故障 菜单文案绕开统一国际化。
// INV-14 归档默认 false：守住位置 参数默认值；改错故障 缺省时显示「取消归档」。
//
// 模块职责：任务列表项右键菜单的容器，把动作清单接到上下文菜单组件上。
// 阅读顺序：先看容器与组织动作，再看动作清单的透传参数，最后看禁用与文件三态。
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";

// 菜单只做装配，不持有任务状态。
export function TaskListItemContextMenu({
  organizationActions,
  intl,
  isPinned,
  isArchived = false,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  providerConfigFile,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
  onOpenProviderConfig,
  disableTaskActions = false,
  // disabledReason 由调用方给出并直接渲染，本组件不自行推断禁用文案。
  disabledReason,
}: {
  organizationActions?: React.ReactNode;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  isArchived?: boolean;
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  providerConfigFile: { loading: boolean; path: string | null; exists: boolean };
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  onOpenTaskFeedback: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
  onOpenProviderConfig: () => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
// 参数解构结束，属性原样展开。
}) {
  return (
    // 宽度固定，避免长文案撑破。
    <ContextMenuContent className="w-52">
      {organizationActions}
      <TaskActionMenuContent
        intl={intl}
        isPinned={isPinned}
        isArchived={isArchived}
        fileManagerLabel={fileManagerLabel}
        taskSessionFile={taskSessionFile}
        activeSessionId={activeSessionId}
        taskNativeSessionLogFile={taskNativeSessionLogFile}
        providerConfigFile={providerConfigFile}
        // Item 由调用方注入 ContextMenuItem，本组件不绑定具体实现。
        Item={ContextMenuItem}
        // Separator 与 Item 同源注入 ContextMenuSeparator，菜单样式因此可被外层整体替换。
        Separator={ContextMenuSeparator}
        onTogglePinTask={onTogglePinTask}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        onOpenTaskFeedback={onOpenTaskFeedback}
        onOpenTaskPathInFileManager={onOpenTaskPathInFileManager}
        onCopyWorkspacePath={onCopyWorkspacePath}
        onCopyTaskPath={onCopyTaskPath}
        onCopyTaskLogPath={onCopyTaskLogPath}
        // onCopySessionId 等可选动作原样下传，未提供时子组件自行隐藏对应菜单项。
        onCopySessionId={onCopySessionId}
        // onViewModelTrajectory 只在支持轨迹的来源传入，子组件据此决定是否渲染入口。
        onViewModelTrajectory={onViewModelTrajectory}
        onOpenProviderConfig={onOpenProviderConfig}
        // disableTaskActions 整体传进动作清单，批量禁用不需要逐项判断。
        disableTaskActions={disableTaskActions}
        // 原因一并下传用于提示。
        disabledReason={disabledReason}
      />
    </ContextMenuContent>
  );
}
