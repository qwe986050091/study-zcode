// INV-01 本文件只做渲染，状态与动作全部来自 useSavedWorkflowGlobalGroup；守住位置：组件体内唯一的数据来源 group；改错故障：组件里再存一份 entries 或忙名，两份真相在删除与移动后对不上。
// INV-02 所有 hook 必须在 mode 早返回之前无条件调用；守住位置：detail 分支之前的 useZCodeIntl 与 useSavedWorkflowGlobalGroup；改错故障：把 hook 挪进 detail 分支，切换列表与详情时 hook 数量变化，React 直接抛渲染顺序错误。
// INV-03 早返回只允许出现在 hook 之后，且只按 mode.kind 分叉；守住位置：detail 分支的提前 return；改错故障：多加一个条件早返回会让弹窗节点随条件挂载卸载，运行窗在打开瞬间被自己卸载。
// INV-04 launchDialog 与 moveDialog 必须在两个模式下都可达；守住位置：detail 分支的 launchDialog 入参与 moveDialog 节点、列表末尾的两个弹窗；改错故障：只在列表分支渲染，详情页点「移到项目…」后没有任何可见反馈。
// INV-05 运行弹窗的 pending 与 error 必须直接透传 launcher；守住位置：launchPending 与 launchError 的取值；改错故障：组件本地缓存一份错误，重试时旧错误与新进度同屏，用户以为第二次也失败。
// INV-06 onOpenChange 只处理关闭，打开分支必须返回 undefined；守住位置：两个弹窗的 onOpenChange 回调；改错故障：打开时也清空 entry，弹窗刚出现就被自己的状态关掉。
// INV-07 全局档弹窗必须显式传 scope 与全局标题；守住位置：SavedWorkflowLaunchDialog 的 scope 与两处 projectLabel；改错故障：省略 scope 后请求落到项目档，运行写进错误目录。
// INV-08 运行与移动的默认落点只能是 activeProjectKey，候选只能是 localProjects；守住位置：两处 defaultTargetKey 与 targets；改错故障：把远程项目塞进候选，用户在远程会话里选到本机不存在的路径。
// INV-09 详情分支的条目必须按 name 精确查找，找不到就传 undefined；守住位置：state.entries.find 的谓词；改错故障：按 path 或下标匹配，条目改名后详情渲染到另一条工作流。
// INV-10 详情分支的 runs 必须按 name 过滤后再传；守住位置：state.runs.filter 的谓词；改错故障：详情页混入别的工作流运行历史，时间线整体错位。
// INV-11 详情页动作必须逐项判空 entry，不得直接解引用；守住位置：onRun 到 onDelete 的条件表达式；改错故障：条目被并发删除后 entry 为空，点击运行抛异常导致整页白屏。
// INV-12 产物入口只在父层提供回调时才展开透传；守住位置：onOpenArtifact 的条件展开；改错故障：无条件传 undefined 让打开器误判入口可用，点击产物 chip 无反应。
// INV-13 onMetaSaved 必须以 bypassCache 刷新；守住位置：详情页 onMetaSaved 的调用；改错故障：走缓存刷新把刚保存的元数据覆盖回旧值，用户以为保存没生效。
// INV-14 noActionTarget 只由 actionTarget 判定，不得回落到第一个项目；守住位置：noActionTarget 的赋值；改错故障：没有本地项目时仍能点创建，提示词被发到不存在的工作区。
// INV-15 无目标时创建按钮必须禁用并包在提示气泡里；守住位置：createButton 的 disabled 与 ControlHintTooltip 包裹；改错故障：按钮可点但静默无响应，用户重复点击以为界面卡死。
// INV-16 空态与错误态必须按「不支持、加载失败、真空」的优先级分叉；守住位置：错误码 -32602 与 state.error 组成的三元链；改错故障：先判 error 会把「全局档不支持」显示成本机运行时缺失，误导用户重装。
// INV-17 invalid 区块必须与列表并列渲染，且不参与空态判定；守住位置：invalid 区块的独立条件；改错故障：把 invalid 折进空态，只剩损坏文件的目录变成「暂无工作流」并引导新建覆盖。
// INV-18 列表与创建按钮的 test id 必须带 global 后缀；守住位置：TID_WORKFLOWS_LIST 与 TID_WORKFLOWS_CREATE_VIA_CHAT 的第二参；改错故障：两组共用同一 id，E2E 选中项目档元素后断言全部错位。
//
// 模块职责：`GlobalWorkflowGroup` 渲染设置页固定的「全局」组，并承载列表与运行弹窗。
// 状态所有权：entries、runs、loaded、busyName、launchEntry、moveEntry 全部归 useSavedWorkflowGlobalGroup；本文件不持有任何业务状态，只持有渲染用的局部常量。
// 阅读顺序：先读 props 契约与 hook 解构，再看 detail 早返回分支，最后读列表分支与两个弹窗节点。
import { Plus } from "lucide-react";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_LIST,
  TID_WORKFLOW_GLOBAL_GROUP,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { SavedWorkflowCard } from "@/settings/saved-workflows/SavedWorkflowCard.js";
import { SavedWorkflowDetailView } from "@/settings/saved-workflows/SavedWorkflowDetailView.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import { SavedWorkflowMoveDialog } from "@/settings/saved-workflows/SavedWorkflowMoveDialog.js";
import { GLOBAL_SAVED_WORKFLOW_TARGET } from "@/settings/saved-workflows/globalWorkflowGroupHelpers.js";
import { useSavedWorkflowGlobalGroup } from "@/settings/saved-workflows/useSavedWorkflowGlobalGroup.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import type {
  SavedWorkflowGroupMode,
  SavedWorkflowGroupState,
} from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

// Props 全部由页传入，本组件不回写父层；唯一回写通道是 onStateChange 与 onMoved
// refreshSeq 是父层单调计数器：值变化即要求绕过缓存重拉，本组件只透传不解释
// mode 只决定列表或详情，切换不重置组内数据，因此状态必须留在 hook 而不是组件
// 回调都可选：缺席时对应入口必须整体关闭，不得用空实现冒充可用
interface SavedWorkflowGlobalGroupProps {
  /** 页级刷新计数器；变化（非首挂）时绕过缓存重拉。 */
  refreshSeq: number;
  mode: SavedWorkflowGroupMode;
  onStateChange: (key: "global", state: SavedWorkflowGroupState) => void;
  onOpenDetail: (name: string) => void;
  onBack: () => void;
  /** 「运行」= GUI 直接启动：accepted 后切到新会话。 */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** 产物 chip → `workflow-artifact` tab。 */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /** 本机项目候选（已过滤远程 remoteSessionId）：运行落点、修订落点、移到项目的目标。 */
  // localProjects 已在上游过滤掉远程条目，本组件不得再按 remoteSessionId 二次筛选
  // 它是运行落点、修订落点与移动目标的唯一候选集，数组顺序就是弹窗展示顺序
  // activeProjectKey 只作默认选中项，用户仍可在弹窗内改选，不要把默认值当成实际落点
  // 把远程项目混进候选会让运行与移动落到本机不存在的路径
  localProjects: readonly AutomationWorkspaceOption[];
  /** 活动项目 key：实参窗默认「运行于」、修订 / 创建默认落点。 */
  activeProjectKey: string | null;
  /** 移动成功后回调页刷新两组。 */
  onMoved: () => void;
}

/**
 * 全局工作流组：顶部固定的「全局」组，空也显示。载体不用
 * `useWorkspaceServicesResolution`——直接用 `useServices().zcodeAgentService`，RPC 带 `{ scope: "global" }`，
 * services 层自选本机运行时。运行走带「运行于」的实参窗；卡片 / 详情可「移到项目…」搬回本地项目。
 * 状态与动作全在 `useSavedWorkflowGlobalGroup`，本文件只负责渲染。
 */
// 组件体只做三件事：取 hook 结果、拼两个弹窗节点、按 mode 分叉渲染
// 不要在组件内订阅 store 或直接取服务，否则与 hook 形成第二条读取路径
// hook 必须位于组件体顶层且无条件：下方 detail 分支有提前 return，条件调用会破坏 hook 顺序
// 解构字段与 hook 返回值一一对应，改名要同步 hook 的返回对象
// props 整体交给 hook；父层每次渲染产生的新对象不会引发额外拉取，拉取由 refreshSeq 控制
export function SavedWorkflowGlobalGroup(props: SavedWorkflowGlobalGroupProps) {
  const {
    mode,
    onBack,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    localProjects,
    activeProjectKey,
  } = props;
  const { intl } = useZCodeIntl();
  // 这一行是组件与状态的唯一接口：之后所有渲染只读 group 的字段
  // hook 内部已订阅 store 快照，组件再读 store 会拿到可能不同步的第二份数据
  // 渲染期间不得调用 refresh 或任何 handle 系列动作，动作只挂在事件回调上
  // hook 抛错时本组件没有兜底分支，错误按现有边界在 hook 或上层处理，不要在这里吞掉
  const group = useSavedWorkflowGlobalGroup(props);
  const {
    agentService,
    state,
    now,
    busyName,
    launchEntry,
    launchPending,
    launchError,
    moveEntry,
    actionTarget,
    resolveRunProject,
    setLaunchEntry,
    setMoveEntry,
    launch,
    handleRun,
    handleRevise,
    handleCreateViaChat,
    handleCopyPath,
    handleDelete,
    handleCardDelete,
    handleCardMove,
    handleOpen,
    handleOpenRun,
    handleOpenArtifact,
    handleMoveSubmit,
    lastRuns,
    refresh,
  } = group;

  // 弹窗先构造后使用：detail 分支作为属性传入，列表分支在末尾直接渲染
  // entry 为空即关闭，打开由 handleRun 写入 launchEntry 触发，开关只有这一个来源
  // pending 与 error 由 launcher 互斥维护，这里不做本地镜像也不做二次判断
  // onOpenChange 只在关闭时清空 entry；打开分支返回 undefined 以保持受控语义
  // onSubmit 以 void 触发异步 launch，失败已由行内 error 呈现，不需要额外的 catch
  const launchDialog = (
    <SavedWorkflowLaunchDialog
      entry={launchEntry}
      scope="global"
      projectLabel={intl.formatMessage({ id: "workflows.hub.global.title" })}
      targets={localProjects}
      defaultTargetKey={activeProjectKey}
      pending={launchPending}
      error={launchError}
      onOpenChange={(open) => (open ? undefined : setLaunchEntry(null))}
      onSubmit={(entry, args, target) => void launch(entry, args, target)}
    />
  );
  // 移动弹窗的开关只看 moveEntry 是否为 null，不额外维护 open 布尔
  // busy 取 busyName 非空：移动在途时禁止再次提交，避免同一文件被并发搬两次
  // entryName 允许为空，弹窗内部要先能承受空值再渲染内容
  // onSubmit 同样以 void 触发，成功路径由 hook 负责关窗、回退详情并通知父层
  const moveDialog = (
    <SavedWorkflowMoveDialog
      open={moveEntry !== null}
      entryName={moveEntry?.name ?? null}
      targets={localProjects}
      defaultTargetKey={activeProjectKey}
      busy={busyName !== null}
      onOpenChange={(open) => (open ? undefined : setMoveEntry(null))}
      onSubmit={(target) => void handleMoveSubmit(target)}
    />
  );

  // detail 分支在 hook 之后提前返回，保证两个模式的 hook 数量一致
  // entry 按 name 精确查找：刷新后条目消失时传 undefined，由详情页自行降级
  // runs 只保留同名运行记录，混入全量会让时间线张冠李戴
  // busy 用 busyName 与 mode.name 比较，删除或移动在途只锁当前这一条
  // onOpenRun 把 mode.name 作为工作流名传入，打开实例不依赖条目对象仍在列表里
  if (mode.kind === "detail") {
    const entry = state.entries.find((candidate) => candidate.name === mode.name);
    return (
      <>
        <SavedWorkflowDetailView
          target={GLOBAL_SAVED_WORKFLOW_TARGET}
          agentService={agentService}
          name={mode.name}
          projectLabel={intl.formatMessage({ id: "workflows.hub.global.title" })}
          entry={entry}
          runs={state.runs.filter((run) => run.name === mode.name)}
          now={now}
          busy={busyName === mode.name}
          canOpenRun={Boolean(onOpenWorkflowRun)}
          resolveRunProject={resolveRunProject}
          onBack={onBack}
          onRun={() => (entry ? handleRun(entry) : undefined)}
          onRevise={() => (entry ? handleRevise(entry) : undefined)}
          onCopyPath={() => (entry ? handleCopyPath(entry) : undefined)}
          onMove={() => (entry ? setMoveEntry(entry) : undefined)}
          onDelete={() => (entry ? void handleDelete(entry) : undefined)}
          onOpenRun={(run) => handleOpenRun(run, mode.name)}
          {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
          onMetaSaved={() => void refresh({ bypassCache: true })}
          launchDialog={launchDialog}
        />
        {moveDialog}
      </>
    );
  }

  // 没有可用本地项目时创建入口整体禁用，并靠提示气泡说明原因，不提供回落默认值
  // 这个判定只依赖 actionTarget，不要在这里重新计算项目候选
  // 抽成常量而不是在各使用处重复比较，避免两处判定漂移导致按钮可点但动作无效
  const noActionTarget = actionTarget === null;
  const createButton = (
    <Button
      type="button"
      size="lg"
      data-icon="inline-start"
      data-testid={testId(TID_WORKFLOWS_CREATE_VIA_CHAT, "global")}
      disabled={noActionTarget}
      onClick={handleCreateViaChat}
    >
      <Plus className="size-4" aria-hidden="true" />
      {intl.formatMessage({ id: "workflows.hub.createViaChat" })}
    </Button>
  );

  return (
    <div data-testid={TID_WORKFLOW_GLOBAL_GROUP} className="mt-8 first:mt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-ui-base font-medium leading-5 text-foreground">
          <span className="truncate">
            {intl.formatMessage({ id: "workflows.hub.global.title" })}
          </span>
          <span className="rounded-sm border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest">
            {intl.formatMessage({ id: "workflows.hub.global.hint" })}
          </span>
          {state.entries.length > 0 ? (
            <span className="font-normal text-foreground-subtlest">{state.entries.length}</span>
          ) : null}
        </h3>
        {noActionTarget ? (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "workflows.hub.launch.noLocalProject" })}
          >
            <span className="inline-flex">{createButton}</span>
          </ControlHintTooltip>
        ) : (
          createButton
        )}
      </div>

      {state.entries.length > 0 ? (
        <div
          data-testid={testId(TID_WORKFLOWS_LIST, "global")}
          className="mt-5 grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2"
        >
          {state.entries.map((entry) => (
            <SavedWorkflowCard
              key={entry.path}
              entry={entry}
              lastRun={lastRuns.get(entry.name)}
              now={now}
              busy={busyName === entry.name}
              onOpen={handleOpen}
              onRun={handleRun}
              onRevise={handleRevise}
              onCopyPath={handleCopyPath}
              onMove={handleCardMove}
              onDelete={handleCardDelete}
            />
          ))}
        </div>
      ) : state.errorCode === -32602 ? (
        <p className="mt-5 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "workflows.hub.global.unsupported" })}
        </p>
      ) : state.error ? (
        <p className="mt-5 text-ui-sm text-destructive">
          {intl.formatMessage({ id: "workflows.hub.global.noLocalRuntime" })} {state.error}
        </p>
      ) : (
        <p className="mt-5 text-ui-base text-foreground-subtlest">
          {intl.formatMessage({ id: "workflows.hub.global.empty" })}
        </p>
      )}

      {state.invalid.length > 0 ? (
        <div
          data-workflows-invalid="true"
          className="mt-4 space-y-0.5 rounded-lg border border-warning/40 px-2.5 py-2"
        >
          <p className="text-ui-sm text-warning">
            {intl.formatMessage(
              {
                id:
                  state.invalid.length === 1 ? "workflows.hub.invalidOne" : "workflows.hub.invalid",
              },
              { count: String(state.invalid.length) },
            )}
          </p>
          {state.invalid.map((entry) => (
            <p
              key={entry.path}
              className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
              title={entry.reason}
            >
              {entry.path} — {entry.reason}
            </p>
          ))}
        </div>
      ) : null}

      {launchDialog}
      {moveDialog}
    </div>
  );
}
