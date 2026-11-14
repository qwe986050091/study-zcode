// 文件头：项目侧栏分组视图里，单个任务的右键菜单内容。整体是把 props 投影成 Radix 菜单项，不发请求、不持有状态。
// 阅读顺序：先看 INV 建立可用性与触发边界，再看分组二级菜单，最后看复制与打开两族的异步快照判断。
// INV-01 disabledReason 是唯一写入闸门：非空时所有组织类菜单项一并禁用；守住位置：六个组织项 item 的 disabled；改错故障：只读或忙碌态仍能改任务，界面与事实分叉。
// INV-02 只读类复制与反馈不受闸门限制；守住位置：复制四项与反馈项的 disabled 不引用 disabledReason；改错故障：只读场景连任务路径都拿不到，排障断链。
// INV-03 每个 onSelect 内必须再次检查 disabledReason；守住位置：各 onSelect 的守卫分支；改错故障：禁用态被键盘或关闭竞态触发，产生用户没预期的写入。
// INV-04 移动目标等于当前分组时必须禁用；守住位置：分组目标项的 group.id 比较；改错故障：发出无变化的移动，列表闪动并重新排序。
// INV-05 没有 currentGroupId 时移出分组必须禁用；守住位置：task-group-remove 的 disabled；改错故障：顶层任务仍发空目标写入，产生无意义事务。
// INV-06 分组子菜单必须列出全部目标分组，不按当前分组过滤；守住位置：groups 的 map 循环；改错故障：空分组永远收不到任务，分组能力失效一半。
// INV-07 会话路径复制在 loading 或空路径时禁用；守住位置：taskSessionFile 项的 disabled；改错故障：复制到空串或旧路径，粘贴后定位到错误文件。
// INV-08 原生日志路径复制同样受 loading 与空路径约束；守住位置：taskNativeSessionLogFile 项的 disabled；改错故障：日志未解析就被复制，反馈缺少可定位证据。
// INV-09 前往 provider 配置要求路径已解析；守住位置：providerConfigFile 项的 disabled；改错故障：点击无反应，用户以为配置入口损坏。
// INV-10 项目路径与会话 ID 复制始终可用；守住位置：两项 onSelect 直接调用复制回调；改错故障：快照未就绪时复制项整组变灰，用户误判任务没有路径。
// INV-11 菜单文案必须与复制内容使用同一条消息 key；守住位置：各复制项的 label 表达式；改错故障：日志标签与剪贴板内容对不上，排障时误判目标。
// INV-12 右键归档不再二次确认；守住位置：归档项的 onSelect；改错故障：与行内归档的两次点击保护叠加，用户要点三次才生效。
// INV-13 确认弹窗与后果提示归上游，本组件不挂载对话框；守住位置：组件体内没有 Dialog；改错故障：菜单关闭后弹窗丢上下文，或一次点击弹两次确认。
// INV-14 菜单内容只在打开期挂载，渲染期不得触发路径加载；守住位置：组件体为纯 props 投影；改错故障：列表重排批量刷路径 RPC，拖拽卡顿。
// INV-15 onSelect 必须同步上抛，不在菜单内等待异步结果；守住位置：各 onSelect 的调用形态；改错故障：菜单卸载后回调丢失，点击看起来毫无反应。
// INV-16 每次打开每个菜单项最多触发一次回调；守住位置：onSelect 作为唯一出口；改错故障：一次点击发出两次归档或两次移动。
// INV-17 disabledReason 必须同时作为 title 下发；守住位置：各 item 的 title；改错故障：菜单项变灰却没有原因，用户只能反复重试。
// INV-18 分组目标的 E2E 属性是契约；守住位置：task-group-move-menu、task-group-remove、data-task-group-target；改错故障：回归用例静默失配，移动分组缺陷无法拦截。
// INV-19 分组项以 group.id 为 key，色点与标题同源；守住位置：groups map 的 key 与颜色点；改错故障：重命名后颜色或选中态串到别的分组。
// INV-20 分区顺序固定为组织、单任务操作、打开与复制、反馈；守住位置：三处 ContextMenuSeparator；改错故障：破坏性操作与只读复制混排，用户误点归档。
//
import { SidebarNativeTooltip } from "@/ControlHintTooltip.js";
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";

// 菜单原语统一从 components/ui/context-menu 取，避免各个面板各写一套定位与关闭逻辑。
// `ContextMenuItem` 等原语已覆盖禁用与定位：新增能力先确认可复用，不要自绘下拉容器。
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
// Separator 只做视觉分区，不含权限或禁用语义，可用性一律落在 item 的 disabled。
// Portal、碰撞翻转、Esc 与外部点击关闭都由 Radix 承担，本文件不重复实现。
} from "@/components/ui/context-menu.js";
// `TaskGroupColorDot` 与分组头部同一组件，菜单色与侧栏色保持同源。
// 颜色只表达分组身份，不承担状态，不要按颜色分支改变菜单行为。
import { TaskGroupColorDot } from "@/project-sidebar/grouped/colors.js";
// 菜单目标只需要 id、title、color，新增展示字段先扩展该类型再谈渲染。
// 不要把完整分组对象灌进来，避免无关字段变化引发菜单重渲染。
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/types.js";

// 纯展示组件：不读 store、不调服务、不持有状态，同一份 props 渲染结果确定。
// 所有写操作经 props 回调上抛，任务与分组的唯一 owner 仍在上游。
// 菜单只服务单个任务，多选批量操作走归档页，这里不引入选中集合。
export function GroupedTaskContextMenuContent({
  // task 是打开菜单那一刻的行快照，菜单存活期内可能已过期，写入以上游最新状态为准。
  // 不在菜单里缓存标题或路径，避免二次打开时看到上一次的值。
  task,
  // 可选值：顶层或未分组行没有分组 id，此时只影响移出分组的可用性。
  // 它只用于同组禁用与移出判断，不参与寻址，也不代表任务归属的唯一事实。
  currentGroupId,
  // 目标分组沿用侧栏视图的顺序，菜单不排序也不裁剪，保证两处展示一致。
  // 空分组同样在列表内，新建分组后可以立刻承接任务。
  groups,
  intl,
  // 打开文件管理器的文案由平台层注入，macOS 是 Finder，Windows 是资源管理器。
  // 不要在菜单里按 navigator 判断平台，文案与真实打开行为可能来自不同来源。
  fileManagerLabel,
  // 三态快照：loading 表示仍在解析，path 为 null 表示脚本侧没有对应文件。
  // 两种都按未就绪处理，避免把空串或旧路径写进剪贴板。
  taskSessionFile,
  taskNativeSessionLogFile,
  providerConfigFile,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenTaskPathInFileManager,
  onCopyText,
  onOpenProviderConfig,
  onOpenTaskFeedback,
  // 唯一的全局禁用原因，空串与 undefined 都表示当前工作区可写。
  // 它同时驱动 disabled 与提示文案，新增组织类操作必须接同一个闸门。
  disabledReason,
}: {
  task: ZCodeTaskMeta;
  currentGroupId?: string;
  groups: TaskGroupMenuItem[];
  intl: {
    formatMessage: (desc: { id: string }) => string;
  };
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null };
  taskNativeSessionLogFile: { loading: boolean; path: string | null };
  providerConfigFile: { loading: boolean; path: string | null };
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyText: (label: string, text: string | null) => void;
  onOpenProviderConfig: () => void;
  onOpenTaskFeedback: () => void;
  disabledReason?: string;
}) {
  // 返回单个 ContextMenuContent，外层定位与卸载节奏交给 Radix Presence。
  // 关闭即卸载由 Radix `Presence` 处理，渲染期不写任何持久化或副作用。
  return (
    // 固定宽度让长路径只影响单行截断，不会把菜单撑出可视区。
    // [权衡] 主菜单 56 与二级菜单 52 成对调整，单改一边会出现视觉错位。
    <ContextMenuContent className="w-56">
      <ContextMenuSub>
        <SidebarNativeTooltip>
          <ContextMenuSubTrigger
            // 触发器 testid 是 E2E 契约，移动分组用例靠它展开二级菜单。
            // 改名会让用例静默失配，需要兼容时新增别名而不是直接替换。
            data-testid="task-group-move-menu"
            disabled={Boolean(disabledReason)}
            title={disabledReason}
          >
            {intl.formatMessage({ id: "taskGroup.moveToGroup" })}
          </ContextMenuSubTrigger>
        </SidebarNativeTooltip>
        <ContextMenuSubContent className="w-52">
          <SidebarNativeTooltip>
            <ContextMenuItem
              data-testid="task-group-remove"
              // 移出分组要求工作区可写且任务确实在组内，两个条件缺一即禁用。
              // 不做点击后静默失败，禁用态配合 title 直接说明原因。
              disabled={Boolean(disabledReason) || !currentGroupId}
              title={disabledReason}
              onSelect={() => {
                if (!disabledReason) {
                  onMoveTaskToGroup(task, null);
                }
              }}
            >
              {intl.formatMessage({ id: "taskGroup.removeFromGroup" })}
            </ContextMenuItem>
          </SidebarNativeTooltip>
          <ContextMenuSeparator />
          {groups.map((group) => (
            <SidebarNativeTooltip key={group.id}>
              <ContextMenuItem
                // E2E 用该属性精确选择目标分组，比按标题文本匹配更耐国际化。
                // 值必须是 group.id，不要换成标题或数组下标。
                data-task-group-target={group.id}
                // 目标等于当前分组时禁用，避免发出没有变化的移动请求。
                // [事务] 同组写入会刷新排序时间并触发无意义重排，必须挡在点击之前。
                disabled={Boolean(disabledReason) || group.id === currentGroupId}
                title={disabledReason}
                onSelect={() => {
                  if (!disabledReason) {
                    onMoveTaskToGroup(task, group.id);
                  }
                }}
              >
                <TaskGroupColorDot color={group.color} />
                <span className="truncate">{group.title}</span>
              </ContextMenuItem>
            </SidebarNativeTooltip>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onMoveTaskToTop(task);
            }
          }}
        >
          {intl.formatMessage({ id: "taskGroup.moveToTop" })}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <ContextMenuSeparator />
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onStartRenameTask(task);
            }
          }}
        >
          {intl.formatMessage({ id: "taskList.rename" })}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onArchiveTask(task);
            }
          }}
        >
          {intl.formatMessage({ id: "taskList.archive" })}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onMarkTaskAsUnread(task);
            }
          }}
        >
          {intl.formatMessage({ id: "taskList.markAsUnread" })}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <ContextMenuSeparator />
      <SidebarNativeTooltip>
        <ContextMenuItem
          disabled={Boolean(disabledReason)}
          title={disabledReason}
          onSelect={() => {
            if (!disabledReason) {
              onOpenTaskPathInFileManager();
            }
          }}
        >
          {fileManagerLabel}
        </ContextMenuItem>
      </SidebarNativeTooltip>
      <ContextMenuItem
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), task.workspacePath)
        }
      >
        {intl.formatMessage({ id: "appHeader.copyPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        // 会话路径解析完成且非空才允许复制，loading 与 null 都算未就绪。
        // [失败路径] 解析失败时保持禁用，不提供可能为空的复制入口。
        disabled={taskSessionFile.loading || !taskSessionFile.path}
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copyTaskPath" }), taskSessionFile.path)
        }
      >
        {intl.formatMessage({ id: "appHeader.copyTaskPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={taskNativeSessionLogFile.loading || !taskNativeSessionLogFile.path}
        onSelect={() =>
          onCopyText(
            intl.formatMessage({ id: "appHeader.copyLogPath" }),
            taskNativeSessionLogFile.path,
          )
        }
      >
        {intl.formatMessage({ id: "appHeader.copyLogPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId)
        }
      >
        {intl.formatMessage({ id: "appHeader.copySessionId" })}
      </ContextMenuItem>
      <ContextMenuItem
        // 前往配置要求路径已可打开，加载中或缺失时禁用。
        // [资源] 该路径只在菜单打开后加载，避免每个列表行各发一次 RPC。
        disabled={providerConfigFile.loading || !providerConfigFile.path}
        onSelect={onOpenProviderConfig}
      >
        <span className="truncate">
          {intl.formatMessage({ id: "appHeader.goToProviderConfig" })}
        </span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onOpenTaskFeedback}>
        {intl.formatMessage({ id: "taskList.feedback" })}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
