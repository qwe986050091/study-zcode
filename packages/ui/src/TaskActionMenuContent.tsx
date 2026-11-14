// INV-01 组件完全受控：函数体内没有任何本地状态、副作用或异步；守住位置：推导一个常量后直接 return；改错故障：组件内自持状态会与父层菜单快照脱节，重开菜单即读到旧值。
// INV-02 两个禁用开关先合成为 taskTargetActionsDisabled 再分发；守住位置：函数体第一行常量；改错故障：各条目自行拼条件会漏掉其中一个开关，同一菜单内禁用态不一致。
// INV-03 disableTaskActions 是总开关，同时约束复制路径、打开目录、前往配置等非目标动作；守住位置：这些条目的 disabled 直接引用它；改错故障：只判目标开关会让被整体禁用的任务仍能执行复制或跳转。
// INV-04 disablePinTaskAction 只额外约束置顶一项，不进入公共常量；守住位置：pin 条目的 disabled 与 onSelect 双重判断；改错故障：把它并进公共常量会连带禁用重命名、归档与标记未读。
// INV-05 disabledReason 只作为 title 文案，从不参与可点性计算；守住位置：各条目 title 的三元表达式；改错故障：把文案当布尔判断会改变禁用结果，且空文案时行为翻转。
// INV-06 title 仅在对应禁用原因成立时给出，可点条目保持无提示；守住位置：title 的 condition ? disabledReason : undefined；改错故障：无条件给 title 会让可点击项显示误导性说明。
// INV-07 需要前置条件的动作在 onSelect 内再次判断同一条件；守住位置：pin、重命名、归档、标记未读、打开目录、前往配置的回调；改错故障：只依赖 disabled 会被键盘回车或程序化触发绕过闸门。
// INV-08 复制类条目不再二次判断，回调直接绑定；守住位置：复制工作区路径、任务路径、日志路径的 onSelect；改错故障：额外加判断会与 disabled 语义分叉，出现灰项却能执行或可点却静默失败。
// INV-09 任务快照路径的可点条件是 loading 结束且 path 非空，刻意不看 exists；守住位置：该条目的 disabled 表达式；改错故障：把 exists 纳入判据会让未落盘快照的路径无法复制。
// INV-10 Agent 原生日志路径同样只判 loading 与 path，exists 不计入；守住位置：日志复制条目的 disabled；改错故障：以 exists 拦截会让「路径已知但今日文件尚未生成」的常态变成不可复制。
// INV-11 复制会话 ID 条目仅在回调存在时渲染，并额外要求 activeSessionId 非空；守住位置：条件渲染与 disabled 两处；改错故障：无条件渲染会出现点击无反应的空条目。
// INV-12 打开文件管理器条目受 hideMobileUnsupportedActions 控制；守住位置：第一个隐藏开关分支；改错故障：移动远控下显示该条目会指向不存在的平台实现，成为坏入口。
// INV-13 前往 provider 配置条目同样受 hideMobileUnsupportedActions 控制；守住位置：第二个隐藏开关分支；改错故障：浏览器环境无法可靠打开桌面配置文件，暴露入口只会导向不可用路径。
// INV-14 调用轨迹条目仅依赖 activeSessionId 与目标开关，不绑定任何快照文件状态；守住位置：条件渲染块与 disabled；改错故障：绑定文件状态会让快照缺失时轨迹入口整体消失。
// INV-15 反馈条目是唯一不带 title 的条目，只受任务目标开关约束；守住位置：菜单最后的 Item；改错故障：套用 disabledReason 会把兜底求助入口解释成任务动作，禁用理由失真。
// INV-16 Separator 位置固定三处：基础四项之后、轨迹块内部、反馈块内部；守住位置：三处 Separator 的所在块；改错故障：分隔线随可选块漂移会在轨迹缺失时留下孤立分隔。
// INV-17 两个可选块用 fragment 包裹，保证 Separator 与 Item 是同级兄弟节点；守住位置：轨迹块与反馈块的短语法包裹；改错故障：改成数组会要求 key，并打散分隔线与条目的分组关系。
// INV-18 全部文案走 intl.formatMessage 的 id，置顶与归档只用三元切换 id；守住位置：pin 与 archive 的 id 选择；改错故障：内联中文会丢失多语言，并让同一动作出现两套措辞。
//
// 模块职责：渲染任务操作菜单的内容区，负责条目顺序、禁用态与文案，具体动作全部由父层回调承接。
// 状态所有权：本组件不持有任何状态；任务、会话与文件探测结果均由父层通过 props 注入，菜单开关状态同样归属父层。
// 阅读顺序：先看两个禁用开关如何合成，再读 pin 的双重闸门，随后看复制类条目的 loading 与 path 门槛，最后看三处可选块与 Separator 的分组位置。
interface TaskActionMenuItemProps {
  children: React.ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}

// Item 与 Separator 由父层注入，本组件不决定使用哪种菜单原语，只负责给出正确的顺序、禁用态与文案。
// Separator 的 props 只有可选 key，说明它是无状态纯展示节点，不能借它承载分组标题或权限判断。
// 注入式设计让桌面右键菜单与移动端动作面板复用同一份条目顺序，避免两套菜单各自漂移。
// 改错预警：在组件内直接引入具体菜单实现，会把平台差异重新耦合回 UI 包。
// 改错预警：给 Separator 增加业务属性，会迫使调用方理解分组规则，破坏纯展示契约。
interface TaskActionMenuSeparatorProps {
  key?: string;
}

// 对外契约：这是一个完全受控的菜单内容组件，函数体内没有状态、没有副作用、没有异步。
// 所有可点击动作都以 onXxx 回调形式接收，组件只决定是否渲染与是否可点，不执行具体业务。
// 五个布尔 prop 均有默认值 false：归档、两个任务禁用开关、置顶专用开关与移动端隐藏开关。
// disabledReason 是共享提示，多个条目复用同一段文案，不要按条目拆分措辞让用户以为是不同原因。
// 父层负责在菜单关闭后清理上下文，本组件不缓存任何上次选择，否则快速重开菜单会读到过期值。
// 改错预警：在这里发起请求或写 store，会让菜单渲染变成副作用入口，一次重渲染就可能重复触发动作。
export function TaskActionMenuContent({
  intl,
  isPinned,
  isArchived = false,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  providerConfigFile,
  disableTaskActions = false,
  disableTaskTargetActions = false,
  disablePinTaskAction = false,
  disabledReason,
  hideMobileUnsupportedActions = false,
  Item,
  Separator,
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
}: {
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  isArchived?: boolean;
  fileManagerLabel: string;
  // 文件类状态统一用 loading、path、exists 三元组表达，三者含义不同，不可互相替代。
  // loading 表示探测仍在进行，此时 path 可能尚不可用，必须禁用复制以免用户拿到空字符串。
  // path 为 null 表示位置未知，与非空但尚未落盘是两种不同情况，不能合并判断。
  // exists 只用于展示或诊断，本组件刻意不让它参与可点性，因为复制只消费路径字符串。
  // 改错预警：把三者压缩成一个字符串或布尔，会让「已知路径但未落盘」这种常态被误判为不可用。
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  providerConfigFile: { loading: boolean; path: string | null; exists: boolean };
  disableTaskActions?: boolean;
  disableTaskTargetActions?: boolean;
  disablePinTaskAction?: boolean;
  disabledReason?: string;
  hideMobileUnsupportedActions?: boolean;
  Item: React.ComponentType<TaskActionMenuItemProps>;
  Separator: React.ComponentType<TaskActionMenuSeparatorProps>;
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  onOpenTaskFeedback?: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
  onOpenProviderConfig: () => void;
}) {
  // 两个禁用开关在这里合成为单一判据，后续所有任务目标类动作只读这一个常量。
  // disableTaskActions 是粗粒度总开关，disableTaskTargetActions 只针对任务目标动作，取或即最大禁用范围。
  // 先合成再使用，避免每个 Item 各写一遍条件而漏掉其中一个开关。
  // 该常量在 return 之前只求值一次，保证同一次渲染中所有条目看到一致的禁用结论。
  // 改错预警：某个 Item 直接用原始开关判断，会绕过合成结果，造成同一菜单内禁用态不一致。
  // 改错预警：把或写成与，只有两个开关同时打开才禁用，任一单开时全部放行，禁用形同虚设。
  const taskTargetActionsDisabled = disableTaskActions || disableTaskTargetActions;

  return (
    <>
      <Item
        // 置顶条目是唯一受三重条件约束的动作：任务目标禁用、置顶专用禁用，任一成立即不可点。
        // title 只在这两个禁用原因之一成立时给出 disabledReason，可点时保持无提示。
        // onSelect 内重复同一组判断，是为了挡住键盘回车与程序化触发绕过 disabled 的路径。
        // 改错预警：把置顶专用开关并入公共常量，会连带禁用重命名、归档与标记未读。
        // 改错预警：只判公共常量而漏掉置顶专用开关，会在不允许改置顶的场景下仍能切换。
        disabled={taskTargetActionsDisabled || disablePinTaskAction}
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={() => {
          if (!taskTargetActionsDisabled && !disablePinTaskAction) {
            onTogglePinTask();
          }
        }}
      >
        {intl.formatMessage({ id: isPinned ? "taskList.unpin" : "taskList.pin" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onStartRenameTask();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.rename" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onArchiveTask();
          }
        }}
      >
        {intl.formatMessage({ id: isArchived ? "taskList.unarchive" : "taskList.archive" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onMarkTaskAsUnread();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.markAsUnread" })}
      </Item>
      <Separator />
      {!hideMobileUnsupportedActions ? (
        <Item
          disabled={disableTaskActions}
          title={disableTaskActions ? disabledReason : undefined}
          onSelect={() => {
            if (!disableTaskActions) {
              onOpenTaskPathInFileManager();
            }
          }}
        >
          {fileManagerLabel}
        </Item>
      ) : null}
      <Item
        disabled={disableTaskActions}
        title={disableTaskActions ? disabledReason : undefined}
        onSelect={onCopyWorkspacePath}
      >
        {intl.formatMessage({ id: "appHeader.copyPath" })}
      </Item>
      <Item
        // 复制任务路径的可点条件是目标动作未被禁、探测已结束且路径非空，三者缺一不可。
        // 这里不检查 exists，因为复制只消费字符串；检查存在性会让高频场景静默变成灰项。
        // title 只反映任务目标被禁用这一原因，loading 与空路径导致的禁用不弹统一文案，避免误导。
        // 复制类条目的 onSelect 直接绑定父层回调，不再二次判断，可点性完全由 disabled 表达。
        // 改错预警：把等待态与禁用原因混进同一条 title，用户会分不清是稍后重试还是根本不允许。
        disabled={taskTargetActionsDisabled || taskSessionFile.loading || !taskSessionFile.path}
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={onCopyTaskPath}
      >
        {intl.formatMessage({ id: "appHeader.copyTaskPath" })}
      </Item>
      <Item
        disabled={
          taskTargetActionsDisabled ||
          taskNativeSessionLogFile.loading ||
          !taskNativeSessionLogFile.path
        }
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={onCopyTaskLogPath}
      >
        {/* Bugfix: ZCode Agent 的日志路径可能先按运行时约定得出，当前日期文件尚未落盘。
            复制动作只依赖路径字符串，不能把 exists=false 当成不可复制，否则菜单会表现成“不能点”。 */}
        {intl.formatMessage({ id: "appHeader.copyLogPath" })}
      </Item>
      {onCopySessionId ? (
        <Item
          disabled={taskTargetActionsDisabled || !activeSessionId}
          title={taskTargetActionsDisabled ? disabledReason : undefined}
          onSelect={onCopySessionId}
        >
          {intl.formatMessage({ id: "appHeader.copySessionId" })}
        </Item>
      ) : null}
      {!hideMobileUnsupportedActions ? (
        /* Bugfix: 手机远控运行在浏览器里，无法可靠打开桌面端 provider 配置文件。
           这里只在远控移动端隐藏入口，桌面端仍沿用“路径已知即可前往配置”的能力。 */
        <Item
          disabled={disableTaskActions || providerConfigFile.loading || !providerConfigFile.path}
          title={disableTaskActions ? disabledReason : undefined}
          onSelect={() => {
            if (!disableTaskActions) {
              onOpenProviderConfig();
            }
          }}
        >
          <span className="truncate">
            {intl.formatMessage({ id: "appHeader.goToProviderConfig" })}
          </span>
        </Item>
      ) : null}
      {onViewModelTrajectory ? (
        <>
          <Separator />
          {/* 调用轨迹查看：从 ~/.zcode/cli 的 model-io 还原该 task 的模型请求/响应/工具调用，
              在右侧边栏可视化。只依赖 taskId（即 sessionId），不依赖快照文件是否落盘。 */}
          <Item
            disabled={taskTargetActionsDisabled || !activeSessionId}
            title={taskTargetActionsDisabled ? disabledReason : undefined}
            onSelect={onViewModelTrajectory}
          >
            {intl.formatMessage({ id: "taskList.viewModelTrajectory" })}
          </Item>
        </>
      ) : null}
      {onOpenTaskFeedback ? (
        <>
          <Separator />
          <Item disabled={taskTargetActionsDisabled} onSelect={onOpenTaskFeedback}>
            {/* Bugfix: 任务菜单之前只有复制日志/路径，用户遇到任务问题时还要手动回到反馈中心。
                “反馈问题”不是任务管理动作，单独放在菜单底部更符合兜底求助入口的层级。 */}
            {intl.formatMessage({ id: "taskList.feedback" })}
          </Item>
        </>
      ) : null}
    </>
  );
}
