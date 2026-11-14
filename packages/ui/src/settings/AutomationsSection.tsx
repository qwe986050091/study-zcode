// ============================================================================
// INV 不变量表（AutomationsSection）
// 职责：自动化中枢的主视图，同时承载列表、创建/编辑整页路由、闲时任务入口，
// 以及来自外部的“一次性导航”（openAutomationId / openAutomationTab / openWorkflow）。
// 这个组件的复杂度不在渲染，而在三份状态的所有权：store 里的列表、本地的 view、
// 以及外部传入的一次性导航参数。下面每条不变量都约束其中一处，破坏后共同的表现
// 是“页面看起来正常但操作后状态回退”或“深链进来停在空白页”。
//
// INV-1: view 是“列表 / 新建 / 编辑 / 闲时新建 / 闲时编辑”的唯一路由真相
//   —— 破坏后果：同时用布尔量和 view 表达页面，会出现“编辑页显示列表数据”的叠加态。
// INV-2: 列表数据只来自 store，本组件不保留第二份可写副本
//   —— 破坏后果：本地副本不随刷新更新，删除/启停后卡片仍显示旧数据，直到整页重建。
// INV-3: 编辑页 view.automation 是进入页面时的快照，必须在动作成功后手动同步
//   —— 破坏后果：菜单里 Pause/Resume 后，详情页开关和文案仍停在旧状态（已有故障）。
// INV-4: 任何写操作失败都必须给出可见 toast，不允许静默返回
//   —— 破坏后果：用户重复点击，或误以为已生效而在错误状态下继续操作。
// INV-5: 创建上限既在 UI 拦截，也依赖 store 返回失败兜底
//   —— 破坏后果：只靠 UI 时并发入口（对话/模板/手动）能越过上限，最终在服务端报错。
// INV-6: tab 与状态筛选同居一个 state，tab 变化必须原子地重置筛选
//   —— 破坏后果：切走再切回会恢复已失效的筛选，列表显示 0 条而用户以为任务丢了。
// INV-7: idle tab 仅在 offPeakVisible 时存在
//   —— 破坏后果：灰度关闭或切到远端工作区后，页面停留在不存在的 tab，两块列表都隐藏。
// INV-8: 远端工作区禁止创建闲时任务，必须收敛到列表或带项目选择器的表单
//   —— 破坏后果：任务被隐式绑到远端会话，实际无法在该机器上执行。
// INV-9: 所有一次性导航参数必须在处理后被消费（onXxxConsumed）
//   —— 破坏后果：参数一直挂着，用户每次返回都被重新拉进详情页，无法停留在列表。
// INV-10: 列表未就绪时导航必须停在 pending，不能判 missing
//   —— 破坏后果：首帧空列表被当成“任务不存在”，弹出误报并消费掉导航。
// INV-11: 确实 missing 时也要消费并提示，不能静默吞掉
//   —— 破坏后果：一次性参数不死，形成“反复提示 + 反复重试”的死循环。
// INV-12: offpeak- 前缀的详情 id 不得进入 cron 解析路径
//   —— 破坏后果：cron 列表里必然查不到，误报 targetNotFound 并抢在 offpeak 分支前消费。
// INV-13: 所有 setTimeout / setInterval 必须在 effect cleanup 中清除
//   —— 破坏后果：组件卸载后仍轮询写 store，离开页面后仍在发请求并更新已卸载状态。
// INV-14: loadedWorkspaceKey 是“当前工作区列表已加载”的唯一判据
//   —— 破坏后果：切项目瞬间用上一个项目的列表做详情定位，命中错误任务。
// INV-15: 切换 workspace 时必须先把 loadedWorkspaceKey 置空
//   —— 破坏后果：新项目首帧仍被认为已加载，详情导航按旧列表判定 missing。
// INV-16: 灰度关闭时只收窄 pageTab 的读值，不清除用户记住的值
//   —— 破坏后果：灰度重开后用户回不到上次的「工作流」页，记忆形同虚设。
// INV-17: 删除正在编辑的任务后必须回到列表
//   —— 破坏后果：view 仍指向已删除对象，整页显示幽灵数据且提交必然失败。
// INV-18: busy 判定必须按 operationId 的 id 后缀精确匹配
//   —— 破坏后果：任意任务的操作都会让所有卡片转圈，或反过来点击无反馈导致重复提交。
// INV-19: 保存态（saving）按 operationId 前缀判定，且必须包含 create 与 update 两种
//   —— 破坏后果：表单在提交中仍可点击，产生重复创建；或提交后一直显示保存中。
// INV-20: 空态与列表态的 Keep-awake 提示条位置不同，不能同时渲染
//   —— 破坏后果：空态出现两条相同提示，或列表态提示被挤到大空卡下方。
// INV-21: 模板可见性由“是否有任何任务”与当前 tab 共同决定
//   —— 破坏后果：空首页移除 All tab 后闲时模板被 tab 条件误隐藏（已有回归）。
// INV-22: 创建准入 fail-closed：只有明确 canTakeNumber=true 才放行
//   —— 破坏后果：资格查询失败被当成可创建，用户填完表单才在服务端被拒。
// INV-23: 计划锁定的模板点击必须走升级漏斗，而不是打开发不出去的表单
//   —— 破坏后果：用户填完表单才遇到 plan 错误，丢失入口埋点与升级上下文。
// INV-24: 卡片主点击永远进详情，会话跳转只作为显式次级动作
//   —— 破坏后果：有 session 的卡片直接跳会话，Settings/History 无法稳定到达。
// ============================================================================
import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- 定时任务主视图集中维护列表、创建/编辑整页路由与启停/删除操作，集中更利于交互一致。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { CircleCheck, RotateCcw, TriangleAlert } from "lucide-react";
import {
  AUTOMATION_CREATE_LIMIT,
  BUILTIN_MODEL_PROVIDER_IDS,
  isAutomationCreateLimitError,
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import {
  TID_AUTOMATION_ACTION_DELETE,
  TID_AUTOMATION_ACTION_TOGGLE,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CARD_MENU,
  TID_AUTOMATIONS_LIST,
  TID_AUTOMATIONS_STATUS_FILTER,
  TID_OFFPEAK_CREATE_BUTTON,
  TID_OFFPEAK_TAB,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast as showToast, type ToastOptions } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { AutomationScheduledTemplateIcon } from "@/settings/AutomationScheduledTemplateIcon.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  OFF_PEAK_CREATE_TOOLTIP_CLASSNAME,
  formatOffPeakRemainingWait,
  resolveOffPeakCreateBlockReason,
  type OffPeakCreateBlockReason,
} from "@/settings/offPeakUiPresentation.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  useAutomationManagementStore,
  type AutomationRunNowResult,
} from "@/store/automationManagementStore.js";
import {
  isCurrentOffPeakCodingPlanSupported,
  resolveOffPeakCreateErrorMessageId,
  useOffPeakTaskStore,
  type OffPeakCreateDraft,
} from "@/store/offPeakTaskStore.js";
import {
  createAndReportOffPeakTask,
  freezeOffPeakCreateTelemetrySnapshot,
  reportOffPeakCreateResult,
} from "@/lib/offPeakTelemetry.js";
import { OffPeakTaskList } from "@/settings/OffPeakTaskList.js";
import { OffPeakTemplateIcon } from "@/settings/OffPeakTemplateIcon.js";
import { OffPeakEditView, type OffPeakEditSubmit } from "@/settings/OffPeakEditView.js";
import {
  formatAutomationCardNextRun,
  hasAutomationFailureState,
  resolveAutomationStatusKind,
  type AutomationStatusKind,
} from "@/settings/automationFormat.js";
import { describeAutomationCardSchedule } from "@/settings/automationCardSchedule.js";
import { AutomationEditView, type AutomationEditSubmit } from "@/settings/AutomationEditView.js";
import { AutomationScheduleBadge } from "@/settings/AutomationScheduleBadge.js";
import {
  AutomationClockIcon,
  AutomationContinueIcon,
  AutomationCreateDropdown,
  AutomationEditActionIcon,
  AutomationKeepAwakeNotice,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationRefreshIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  AUTOMATION_STATUS_FILTERS,
  DEFAULT_AUTOMATION_STATUS_FILTER,
  filterAutomationsByStatus,
  filterOffPeakTasksByStatus,
  resolveAutomationTabState,
  type AutomationStatusFilter,
  type AutomationTabState,
} from "@/settings/automationStatusFilter.js";
import { isRemoteAutomationWorkspace } from "@/hooks/useAutomationProjectOptions.js";
import {
  reportAutomationActionClick,
  reportAutomationCreateResult,
  resolveAutomationSelectionTelemetry,
} from "@/lib/automationTelemetry.js";
import {
  materializeOffPeakTemplateDraft,
  materializeScheduledTemplateDraft,
  resolveOffPeakTemplateText,
  resolveAutomationTemplateText,
  type ScheduledAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import {
  AutomationsPageTitle,
  type AutomationsPageTab,
} from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import {
  readAutomationsPageTab,
  writeAutomationsPageTab,
} from "@/settings/saved-workflows/automationsPageTabMemory.js";
import {
  SavedWorkflowsSection,
  type SavedWorkflowLaunchTarget,
  type SavedWorkflowProjectTarget,
  type SavedWorkflowsOpenArtifactParams,
  type SavedWorkflowsOpenRunParams,
  type SavedWorkflowsOpenTarget,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationTemplateSkeletonGrid } from "@/settings/AutomationTemplateSkeletonGrid.js";

// Props 全部是“可选的一次性输入或能力注入”，组件不持有它们的副本：
// [权衡] workspacePath 允许为空，是为了让未打开项目的窗口也能渲染占位而不是崩溃；
// 代价是每个使用点都要处理 null，因此空值分支集中在最深一层统一渲染提示。
interface AutomationsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** 「Create via chat」:切到会话让 agent 用 CronCreate 创建;缺省则回退到手动创建整页。
   * target = 工作流所属项目；定时任务的「通过对话创建」不带 target，落到活动项目。 */
  onCreateViaChat?: (prompt: string, target?: SavedWorkflowProjectTarget) => void;
  /** 会话内创建卡片的详情导航目标；定位成功后由调用方清空。 */
  openAutomationId?: string | null;
  // [事务] 导航参数是“请求”而不是“状态”：本组件消费后必须回调 onXxxConsumed 清空，
  // 否则父层会一直认为导航未完成，在用户返回列表时再次把它推进详情页（INV-9）。
  /** 推荐提示词携带的一次性 tab 导航目标；仅在目标 tab 可见时应用。"workflow" 落到顶级「工作流」标签。 */
  openAutomationTab?: AutomationsNavigationTab | null;
  onOpenAutomationConsumed?: () => void;
  // [权衡] 运行成功后由父层负责切会话，而不是本组件直接导航：运行请求可能尚未
  // 完全落库，由父层在 accepted 后统一跳转，避免“跳过去了但 run 还没建好”。
  /** 工作流「运行」= GUI 直接启动：accepted 后切到新会话。 */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  // [失败路径] 该回调必须同时携带会话与运行标识：只带 runId 时会话侧无法定位实例，
  // 会把用户带到会话首页而不是他点开的那条运行记录。
  /** 工作流运行历史「查看实例」：切到发起它的会话并打开实例详情页。 */
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  // [事务] 产物跳转要带工作流名与产物标识：产物可以同名存在于多个工作流，
  // 缺名字会落到错误的 workflow-artifact tab，用户看到的是别人的产物。
  /** 产物 chip → `workflow-artifact` tab。 */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /** 深链直接落到详情页；透传给 SavedWorkflowsSection，定位后由调用方清空。global 只需 name。 */
  openWorkflow?: SavedWorkflowsOpenTarget | null;
  // [事务] openWorkflow 与 openAutomationId 一样是一次性请求：消费时机由
  // SavedWorkflowsSection 决定（定位成功或确认不存在），本组件只转发、不抢先消费（INV-9）。
  onOpenWorkflowConsumed?: () => void;
  /** 打开某次运行关联的会话；管理页列出所有项目，必须携带 automation 所属 workspace。 */
  // [失败路径] workspacePath 是必填而非可选：管理页聚合所有项目，缺了它只能回退到
  // 当前活动项目，会把用户带到错误的会话上下文（调用点见 handleRunNow 的 onAction）。
  onOpenSession?: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
}

// [权衡] toast 统一注入 anchorId，而不是让每个调用点自己指定：中枢页面可能同时
// 挂载多个设置分区，没有固定锚点会让提示出现在视口外或与其他分区的提示叠在一起。
export const AUTOMATIONS_TOAST_ANCHOR_ID = "automations-main-toast-anchor";

function toast(message: string, options?: ToastOptions): number {
  // 展开顺序很重要：先铺调用方选项再覆盖 anchorId，保证锚点不会被误改。
  return showToast(message, {
    ...options,
    anchorId: AUTOMATIONS_TOAST_ANCHOR_ID,
  });
}

// 闲时任务的创建按钮，承担“能不能点”的全部展示职责：
// [失败路径] 禁用原因与 tooltip 由调用方计算后传入，组件本身不判断资格：
// 判断散落在展示层会让同一套 fail-closed 规则出现两份实现（INV-22）。
function OffPeakCreateButton({
  greyReason,
  greyTooltip,
  onCreate,
}: {
  greyReason: OffPeakCreateBlockReason | null;
  greyTooltip?: string;
  onCreate: () => void;
}) {
  const { intl } = useZCodeIntl();
  // disabled 按钮 pointer-events-none，tooltip 必须挂在外层可指针元素上。
  // [失败路径] 这就是为什么要先构造 button、再决定是否包一层 span：把 tooltip 挂在
  // 按钮自身上时，禁用状态下 hover 事件根本不会触发，用户看不到任何禁用原因。
  const button = (
    <Button
      type="button"
      variant="default"
      size="default"
      data-testid={TID_OFFPEAK_CREATE_BUTTON}
      disabled={greyReason !== null}
      onClick={onCreate}
    >
      {intl.formatMessage({ id: "offPeak.createButton" })}
    </Button>
  );

  if (!greyTooltip) return button;
  // [权衡] 无 tooltip 时不额外包一层 span：多一层 DOM 会改变 flex 布局的间距，
  // 让“可创建”和“被禁用”两种状态在顶栏出现像素级偏移。
  return (
    <ControlHintTooltip
      title={greyTooltip}
      side="top"
      align="center"
      className={OFF_PEAK_CREATE_TOOLTIP_CLASSNAME}
    >
      <span className="inline-flex">{button}</span>
    </ControlHintTooltip>
  );
}

// 草稿只承载“预填值”，不承载校验结果：校验属于表单组件（AutomationEditView），
// 中枢若也持有一份校验状态，两处会给出不一致的可用性判断。
/** 创建表单的预填草稿(来自「More ideas」模板)。 */
export interface AutomationDraft {
  templateId?: string;
  title: string;
  cronExpr: string;
  prompt: string;
}

// [事务] 路由用判别联合而不是多个布尔量：编辑与创建同时为 true 的叠加态在类型层面
// 就不可表达，也就不可能出现“编辑页里再叠一个新建表单”的分支（INV-1）。
/** 主视图内部路由:列表 / 新建 / 编辑。 */
type AutomationsView =
  | { mode: "list" }
  // [事务] create 的 draft 允许为 null，表示“空表单”；这里不用 undefined，
  // 是为了让“没有草稿”与“字段缺省”在类型上可区分，避免解构时默认值互相污染。
  | { mode: "create"; draft: AutomationDraft | null }
  // [事务] edit 携带的是进入时的快照，而非 automationId：列表刷新会替换 store 里的
  // 对象，快照让表单在编辑过程中保持稳定，代价是成功分支必须手动同步（INV-3）。
  | { mode: "edit"; automation: ZCodeAutomation }
  | { mode: "offpeak-create"; draft?: OffPeakCreateDraft }
  // [事务] offpeak-edit 同理携带任务对象：轮询每 10s 会替换列表项，
  // 若只存 id，表单会在用户输入时被新对象重置。
  | { mode: "offpeak-edit"; task: ZCodeOffPeakTask };

/** 主视图标签页：Scheduled 常驻，Idle-time 受灰度控制（D31）；不设 All 混排视图。 */
export type AutomationsTab = "scheduled" | "idle";

// [权衡] 两个常量都预声明为 readonly 数组而不是每次调用时字面量新建：
// visibleTabs 会进入 useEffect 与 useCallback 的依赖数组，每次渲染返回新数组引用，
// 会让消费它的 effect 每帧都判定为“依赖变化”，进而反复重算与重渲染。
const SCHEDULED_ONLY_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled"];
const SCHEDULED_AND_IDLE_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled", "idle"];

// [权衡] 无任务时不返回任何 tab，而不是返回 Scheduled：空首页要让两类模板并列展示，
// 顶栏若仍留一个孤立 tab，会让用户以为还有别的视图可切，也让模板区位置判断分叉（INV-21）。
export function resolveVisibleAutomationTabs({
  hasAnyTasks,
  offPeakVisible,
}: {
  hasAnyTasks: boolean;
  offPeakVisible: boolean;
}): readonly AutomationsTab[] {
  // [权衡] 空列表时返回空数组而不是全量 tab：只要返回 tab，顶栏就会渲染出可切换项，
  // 而它们背后都是 0 条任务，用户切过去只能看到模板区，误以为列表加载失败。
  if (!hasAnyTasks) return [];
  return offPeakVisible ? SCHEDULED_AND_IDLE_AUTOMATION_TABS : SCHEDULED_ONLY_AUTOMATION_TABS;
}

// [失败路径] 灰度关闭后必须把 idle 归一化回 scheduled：只隐藏 tab 而不改状态，
// tab === "idle" 的条件会让定时任务列表也一起不渲染，页面变成空白（INV-7）。
export function resolveAutomationTabAfterOffPeakChange(
  tab: AutomationsTab,
  offPeakVisible: boolean,
): AutomationsTab {
  // [事务] 只归一化 idle，其余值原样返回：灰度开启时 scheduled 必须保留，
  // 无条件写成 scheduled 会让用户永远无法停留在 idle tab。
  return tab === "idle" && !offPeakVisible ? "scheduled" : tab;
}

// [事务] 三态而不是布尔：pending 表示“列表还没就绪，先别判定”，只有 settled 才允许
// 消费导航。把 pending 折成 settled 会在首帧把目标 tab 判成不可见并误消费（INV-10）。
export function resolveAutomationTabNavigation({
  requestedTab,
  tabsReady,
  visibleTabs,
}: {
  requestedTab: AutomationsTab;
  tabsReady: boolean;
  visibleTabs: readonly AutomationsTab[];
}): { status: "pending" } | { status: "settled"; tab: AutomationsTab } {
  // [事务] pending 不是过渡动画而是“禁止消费”的信号：调用方看到它就什么都不做，
  // 等 loadedWorkspaceKey 变化后重新解析；这里直接给 settled 会消费掉导航请求。
  if (!tabsReady) return { status: "pending" };
  // [失败路径] 目标 tab 不可见时落到 scheduled 而不是保持原值：requestedTab 可能来自
  // 灰度已关闭的旧深链，保持原值会让视图停在不存在的 tab 上（INV-7）。
  return {
    status: "settled",
    tab: visibleTabs.includes(requestedTab) ? requestedTab : "scheduled",
  };
}

// [权衡] “展示哪些模板”由调用方把 hasAnyTasks 与 tab 一起传入，而不是在组件内读列表
// 长度：空态与列表态模板区的位置不同，两处若各算一次就会出现“模板区被渲染两次”。
export function resolveAutomationTemplateVisibility({
  hasAnyTasks,
  offPeakCreationEnabled,
  tab,
}: {
  hasAnyTasks: boolean;
  offPeakCreationEnabled: boolean;
  tab: AutomationsTab;
}): {
  showOffPeakTemplates: boolean;
  showScheduledTemplates: boolean;
} {
  // 移除 All tab 后空首页仍默认落在 Scheduled，导致闲时模板被 tab 条件误隐藏。
  // 无任务时恢复两类模板并列展示；有任务后继续由 Scheduled / Idle tab 分流。
  const showAllTemplates = !hasAnyTasks;
  // [事务] 两个布尔量必须由同一次计算一起产出：调用方若分别推导，会出现“任务区为空
  // 但两块模板都不显示”或“同一模板被两个 section 各渲染一次”的矛盾状态（INV-21）。
  return {
    showOffPeakTemplates: offPeakCreationEnabled && (showAllTemplates || tab === "idle"),
    showScheduledTemplates: showAllTemplates || tab === "scheduled",
  };
}

// 状态元数据只放“图标 + 颜色”，不放文案：文案必须走 i18n key，
// 颜色是设计系统 token，两者混在一处会让新增语言或主题时漏改其中一半。
const STATUS_META: Record<
  AutomationStatusKind,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; className: string }
> = {
  // [权衡] 进行中也用时钟图标而非播放图标：自动化是“按计划等待”而不是“正在执行”，
  // 用播放会让用户以为任务此刻在跑，点暂停时产生预期落差。
  active: { icon: AutomationClockIcon, className: "text-success" },
  // 设计稿的暂停态是 stop-circle 描边图标，不能回退为圆圈内实心方块。
  paused: { icon: AutomationPausedIcon, className: "text-foreground-subtle" },
  // [失败路径] completed 用成功色之外的弱化色：它既不是“正在跑”也不是“需要处理”，
  // 用 success 会让用户误以为有一批任务刚成功、实际可能已结束数天。
  completed: { icon: CircleCheck, className: "text-foreground-subtle" },
  // [失败路径] 失败态是唯一使用 destructive 色的状态：把它降级成普通弱化色，
  // 用户会漏看需要人工介入的任务，任务会一直失败到耗尽次数。
  failed: { icon: TriangleAlert, className: "text-destructive" },
};

// [失败路径] 空白提示词返回单个空格而不是空串：卡片高度由两行 clamp 撑开，
// 空串会让卡片高度塌陷，与同排其他卡片错位。
function automationPromptSummary(prompt: string): string {
  // [权衡] 折叠空白而不是直接裁剪：提示词常含换行缩进，保留原样会让卡片里出现
  // 大段空白，看起来像内容缺失；折叠成单空格后行数稳定、高度可预测。
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : " ";
}

// [事务] 只有 failed 可重排：completed 是有限次任务的自然终态，允许重启会让它
// 立刻再次耗尽次数并回到 completed，用户看到的是“点了没反应”。
export function canRestartAutomation(
  automation: Pick<ZCodeAutomation, "lifecycleStatus">,
): boolean {
  // [事务] 判据只读 lifecycleStatus，不参考 enabled：失败任务可能仍处于启用态，
  // 把 enabled 当前置条件会让“失败但未暂停”的任务永远无法重启。
  return automation.lifecycleStatus === "failed";
}

// [失败路径] 终态禁止 toggle：对 completed 调 pause 会写回非终态，破坏“已结束”语义；
// 对 failed 调 resume 则绕过 Restart 的重新排期，任务会停在“已启用但永不触发”。
export function canToggleAutomation(automation: Pick<ZCodeAutomation, "lifecycleStatus">): boolean {
  // [权衡] 用黑名单而非白名单：新增的中间生命周期默认允许启停，
  // 代价是新增终态时必须回来同步补上，否则会误放行一次无效的状态迁移。
  return automation.lifecycleStatus !== "completed" && automation.lifecycleStatus !== "failed";
}

// [权衡] 结果到文案的映射集中在这里，而不是散落在调用点：三种结果必须互斥，
// 分散写很容易让 queued 与 duplicate 共用一句提示，用户无法判断到底有没有排上。
export function getAutomationRunNowToastId(
  result: AutomationRunNowResult,
): "automations.runNowQueued" | "automations.runNowAlreadyRunning" | "automations.runNowFailed" {
  // [失败路径] 三个分支必须互斥且穷尽：返回值是判别联合，漏掉一种会落进默认失败文案，
  // 把“已排队”误报成失败，用户会立刻再点一次从而触发 duplicate。
  if (result === "queued") return "automations.runNowQueued";
  if (result === "duplicate") return "automations.runNowAlreadyRunning";
  return "automations.runNowFailed";
}

export type AutomationActionError = "create" | "update" | "toggle" | "restart" | "delete";

/** 原始 Agent/RPC 错误留在 logger；界面只展示当前动作对应的可理解提示。 */
// [失败路径] 只按动作映射，不透传原始 RPC 文本：服务端错误可能包含内部路径与堆栈，
// 直接展示既不安全也不可读；原始错误由调用方写 logger，界面只给可理解的动作提示。
export function getAutomationActionErrorToastId(action: AutomationActionError): string {
  // [事务] 这里只拼 key 前缀，不内联整句文案：i18n 资源按动作名建 key，
  // 内联字符串会让新增动作时漏掉翻译，界面直接显示 key 原文。
  return `automations.error.${action}`;
}

// [权衡] 创建失败单独判别限额错误：限额是“可解释且可行动”的失败（提示用户删任务），
// 其余创建失败统一回落通用提示，避免把网络错误误报成额度问题。
export function getAutomationCreateErrorToastId(error: unknown): string {
  // [失败路径] 只把“明确的限额错误”分流：把其余错误也归到限额，
  // 用户会去删任务腾位置，但真实原因可能是网络或参数非法，删了也没用。
  return isAutomationCreateLimitError(error)
    ? "automations.error.createLimit"
    : getAutomationActionErrorToastId("create");
}

// [失败路径] 空 id 与纯空白串都返回 null：深链参数常带首尾空格，直接 find 会得到
// undefined，调用方就无法区分“没给 id”与“id 不存在”，前者不该触发 targetNotFound。
export function resolveAutomationDetailTarget(
  automations: readonly ZCodeAutomation[],
  automationId?: string | null,
): ZCodeAutomation | null {
  // [失败路径] 先 trim 再判空：深链参数可能是 "%20" 解码后的空格，
  // 不 trim 会拿一个永远匹配不上的 id 去查列表，最终误报 targetNotFound（INV-11）。
  const targetId = automationId?.trim();
  if (!targetId) return null;
  // [事务] 严格等值匹配而不是包含匹配：id 之间存在前缀关系时，包含匹配会让
  // 深链指向另一条任务，用户在编辑页改的其实是别人的任务。
  return automations.find((automation) => automation.automationId === targetId) ?? null;
}

// [事务] listReady 由调用方用 loadedWorkspaceKey 算好再传入，而不是在这里读 store：
// 该函数同时被 effect 与测试使用，绑定具体 store 会让“未就绪”语义无法注入（INV-14）。
export function resolveAutomationDetailNavigation(
  automations: readonly ZCodeAutomation[],
  automationId: string | null | undefined,
  listReady: boolean,
): { status: "pending" } | { status: "missing" } | { status: "found"; target: ZCodeAutomation } {
  // [事务] !listReady 直接返回 pending 而不是 missing：列表未就绪时任何“查不到”
  // 都只是数据还没到，判定 missing 会误消费导航并提示任务不存在（INV-10）。
  if (!automationId?.trim() || !listReady) return { status: "pending" };
  // [失败路径] 走到这里说明 id 非空且列表已就绪，此时查不到才允许判 missing：
  // 早一步判定会把“还没加载”误报成“已删除”（INV-10）。
  const target = resolveAutomationDetailTarget(automations, automationId);
  return target ? { status: "found", target } : { status: "missing" };
}

// [失败路径] offpeak- 前缀是两条导航链路的唯一分叉依据：判断若晚于 cron 解析，
// 闲时 id 会先在 cron 列表里查一遍，必然 missing 并弹出误报（INV-12）。
/** D49：openAutomationId 里 `offpeak-` 前缀 id 的判别（生成点唯一：offPeakTaskService 的 offpeak-${uuid}）。 */
export function isOffPeakDetailNavigationId(automationId: string | null | undefined): boolean {
  return Boolean(automationId?.trim().startsWith("offpeak-"));
}

// [权衡] 这里比 cron 版本多一个 unavailable 状态：refresh 吞错并保留旧列表时，
// “查不到”不能等同于“不存在”，否则一次网络失败就会让用户看到任务已被删除（INV-11）。
/** D49：闲时轮尾卡跳转的并行解析路径；与 cron 的 resolveAutomationDetailNavigation 对称。 */
export function resolveOffPeakDetailNavigation(
  tasks: readonly ZCodeOffPeakTask[],
  offPeakTaskId: string | null | undefined,
  listReady: boolean,
  listError: string | null = null,
):
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "missing" }
  | { status: "found"; target: ZCodeOffPeakTask } {
  const targetId = offPeakTaskId?.trim();
  if (!targetId || !listReady) return { status: "pending" };
  // review：store.refresh 吞错保留旧列表；列表不可信时不能做 found/missing 终审。
  if (listError) return { status: "unavailable" };
  // [事务] 只在闲时列表里查，不回落到 cron 列表兜底：两类任务的 id 空间不共享，
  // 兜底查到同名 id 的概率极低却会把用户带进完全不同类型的详情页。
  const target = tasks.find((task) => task.offPeakTaskId === targetId) ?? null;
  return target ? { status: "found", target } : { status: "missing" };
}

interface AutomationActionsMenuProps {
  automation: ZCodeAutomation;
  // busy 是唯一允许菜单“不可点”的原因；canRestart/canToggle 只控制菜单项是否出现，
  // 两者混用会让禁用状态同时表达“操作进行中”和“该动作不可用”两种含义（INV-18）。
  busy: boolean;
  canRestart: boolean;
  canToggle: boolean;
  onRunNow: (automation: ZCodeAutomation) => void;
  onEdit: (automation: ZCodeAutomation) => void;
  // 菜单只上报“用户意图”，不在内部做状态变更：卡片与详情页复用同一批处理函数，
  // 菜单再包一层会让 operationId 的归属无法判断，双重点击时状态会分叉（INV-18）。
  onToggle: (automation: ZCodeAutomation, enabled: boolean) => void;
  onRestart: (automation: ZCodeAutomation) => void;
  onDelete: (automation: ZCodeAutomation) => void;
}

function AutomationActionsMenu({
  automation,
  busy,
  canRestart,
  canToggle,
  onRunNow,
  onEdit,
  onToggle,
  onRestart,
  onDelete,
}: AutomationActionsMenuProps) {
  const { intl } = useZCodeIntl();
  // [并发] busy 由父层按 operationId 精确匹配后传入，菜单只负责禁用：
  // 菜单内部若自己判断，就会出现“列表在转圈但菜单仍可点”的两种真相（INV-18）。
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-hover md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-hover data-[state=open]:opacity-100"
          data-testid={TID_AUTOMATION_CARD_MENU}
          aria-label={intl.formatMessage({ id: "automations.moreActions" })}
          disabled={busy}
          // 卡片可点进编辑;菜单点击不冒泡到卡片。
          onClick={(event) => event.stopPropagation()}
        >
          <AutomationMoreHorizontalIcon
            className="size-4 text-foreground-subtle"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-[190px]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 立即运行：当前 RPC 期间用 busy 防重，返回后恢复入口；活动 run 由 host single-flight 判重。 */}
        <DropdownMenuItem
          // [并发] 运行中只禁用本项，不禁用整张卡片：runNow 是单次 RPC，
          // 编辑与删除不应被一次运行阻塞，否则用户想中止任务时无路可走。
          className="gap-1"
          disabled={busy}
          onSelect={() => void onRunNow(automation)}
        >
          <span className="flex size-5 items-center justify-center">
            <AutomationRunNowIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "automations.runNow" })}
        </DropdownMenuItem>
        {canRestart ? (
          <DropdownMenuItem
            className="gap-1"
            // [失败路径] Restart 只对 failed 出现，completed 不出现：后者已耗尽次数，
            // 重启后会立刻回到 completed，用户会以为按钮失效并反复点击。
            disabled={busy}
            onSelect={() => void onRestart(automation)}
          >
            <span className="flex size-5 items-center justify-center">
              <RotateCcw className="size-4" strokeWidth={1.33} aria-hidden="true" />
            </span>
            {intl.formatMessage({ id: "automations.restart" })}
          </DropdownMenuItem>
        ) : null}
        {/* 终态任务不展示 pause/resume：failed 可 Restart，completed 彻底收口只保留查看/删除。 */}
        {canToggle ? (
          <DropdownMenuItem
            // [事务] 测试 id 挂在菜单项而不是外层容器：自动化用例需要直接点击“暂停”，
            // 挂在容器上会退化成“先开菜单再点坐标”，对布局改动极其脆弱。
            data-testid={TID_AUTOMATION_ACTION_TOGGLE}
            className="gap-1"
            disabled={busy}
            onSelect={() => void onToggle(automation, !automation.enabled)}
          >
            {automation.enabled ? (
              <span className="flex size-5 items-center justify-center">
                <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
              </span>
            ) : (
              <span className="flex size-5 items-center justify-center">
                <AutomationContinueIcon className="size-4" aria-hidden="true" />
              </span>
            )}
            {intl.formatMessage({
              id: automation.enabled ? "automations.pause" : "automations.resume",
            })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="gap-1"
          disabled={busy}
          // [事务] 编辑只切视图、不发请求：表单需要先用列表里的完整字段预填，
          // 在这里重新拉一次详情会引入“菜单已关、表单还没数据”的空白帧。
          onSelect={() => void onEdit(automation)}
        >
          <span className="flex size-5 items-center justify-center">
            <AutomationEditActionIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "automations.form.editTitle" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          // [失败路径] 删除项同样受 busy 约束：删除请求在途时再次确认会重复提交，
          // 第二次必然失败并弹出误导性的错误提示。
          data-testid={TID_AUTOMATION_ACTION_DELETE}
          className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
          disabled={busy}
          onSelect={() => void onDelete(automation)}
        >
          <AutomationTrashIcon />
          {intl.formatMessage({ id: "automations.delete" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// [权衡] 筛选结果为空时单独给占位，而不是复用“还没有任务”空态：
// 后者会引导用户去创建，但此时其实已有任务，只是被筛选挡掉了，容易造成误操作。
/** 状态筛选命中 0 条时的占位；复用闲时空态卡的描边样式，文案与「还没有任务」区分开。 */
function AutomationStatusFilterEmpty() {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "automations.statusFilter.empty" })}
    </div>
  );
}

export function AutomationsSection({
  workspacePath,
  workspaceIdentity,
  onCreateViaChat,
  openAutomationId,
  openAutomationTab,
  onOpenAutomationConsumed,
  onNavigateToLaunchedRun,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSession,
}: AutomationsSectionProps) {
  // [事务] 依赖注入集中在这一段：service、store action、灰度配置都从 hook 取，
  // 组件内不直接 import 单例，保证测试可以替换，也避免热重载时出现两份 store 实例。
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  // [事务] 三个 service 在挂载时取一次即可：它们是长生命周期的 RPC 客户端，
  // 放进依赖数组会让每次渲染都重建回调，进而让下面的 effect 反复重跑。
  const { clientScenesService, offPeakTaskService, zcodeAgentService } = useServices();
  // 确认弹窗是命令式 API，必须在这里取一次而不是在事件里临时调用：
  // 事件里再挂载上下文会让弹窗挂到卡片节点下，卡片卸载时弹窗一起消失。
  const confirmDialog = useConfirmDialog();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  // [失败路径] providerSettings 可能仍在 loading，取不到 view 时传 null 而不是空对象：
  // 空对象会被下游当成“已读取且没有任何 provider”，从而误判计划未激活（INV-22）。
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  // 入口套餐状态对外只暴露三个字段：status 用于决定展示，label 用于文案，
  // retry 用于失败后重查；其余内部状态不需要也不应该进入组件。
  const { status: entryStatus, label: entryLabel, retry: retryEntry } = useCodingPlanEntryGate();
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings();
  // [并发] eligibility 以 settings + revision 为触发条件，而不是定时轮询：
  // 用户改设置后 revision 变化即重查，既及时又不会产生后台请求。
  useOffPeakEligibility(sharedSettings, providerSettingsView?.revision);

  // [事务] 这里逐个订阅 store 字段，而不是整体取 state 对象：
  // 整体订阅会让任意一次 refresh 都重渲整个页面（含所有卡片），列表大时明显掉帧。
  const automations = useAutomationManagementStore((state) => state.automations);
  // [失败路径] 上限用长度判断只是 UI 提示，服务端仍会独立校验：
  // 两个入口并发创建时，UI 的计数可能还没刷新，最终以 store 返回失败为准（INV-5）。
  const automationCreateLimitReached = automations.length >= AUTOMATION_CREATE_LIMIT;
  const loading = useAutomationManagementStore((state) => state.loading);
  // [并发] operationId 是“当前正在进行的操作”的唯一标识，切页时不清空：
  // 操作可能在用户离开列表后完成，清空会让返回列表时拿不到正确的进行中状态（INV-18）。
  const operationId = useAutomationManagementStore((state) => state.operationId);
  // [权衡] runsCache 只读订阅用于详情页展示运行记录，不在本地做缓存合并：
  // store 已按 automationId 分桶，本地再缓存会出现两份“最近一次运行”的答案。
  const runsCache = useAutomationManagementStore((state) => state.runsCache);
  const initialize = useAutomationManagementStore((state) => state.initialize);
  const createAutomation = useAutomationManagementStore((state) => state.createAutomation);
  const updateAutomation = useAutomationManagementStore((state) => state.updateAutomation);
  const deleteAutomation = useAutomationManagementStore((state) => state.deleteAutomation);
  const setEnabled = useAutomationManagementStore((state) => state.setEnabled);
  const restartAutomation = useAutomationManagementStore((state) => state.restartAutomation);
  const runAutomationNow = useAutomationManagementStore((state) => state.runAutomationNow);
  const loadRuns = useAutomationManagementStore((state) => state.loadRuns);
  const deleteRun = useAutomationManagementStore((state) => state.deleteRun);
  const refresh = useAutomationManagementStore((state) => state.refresh);
  // [事务] 以上 action 逐个取引用而不是解构整个 store：zustand 的 action 引用稳定，
  // 但整体解构会让 useCallback 依赖数组写上 state 对象，导致每次刷新都重建回调。

  // [权衡] 模板走独立 hook 而非 store：模板是只读目录数据，失败时给空列表即可，
  // 与任务列表共用 store 会让一次模板请求失败连带影响任务管理状态。
  const automationTemplates = useAutomationTemplates(clientScenesService);
  const offPeakTasks = useOffPeakTaskStore((state) => state.tasks);
  // [事务] loading 与 tasks 分开订阅：列表可能在后台刷新（loading=true）但已有数据，
  // 混成一个对象会让“有数据但正在刷新”这个中间态无法表达，页面只能二选一展示。
  const offPeakStoreLoading = useOffPeakTaskStore((state) => state.loading);
  // [失败路径] grayConfig 可能为 undefined（尚未拉到配置），所有读取都必须显式判空：
  // 用 `?.enabled === true` 而不是 `!== false`，保证配置缺失时按“关闭”处理（fail-closed）。
  const offPeakGrayConfig = useOffPeakTaskStore((state) => state.grayConfig);
  const offPeakCodingPlanSupport = useOffPeakTaskStore((state) => state.codingPlanSupport);
  // [权衡] 额度与“额度查询状态”必须成对订阅：只有 nextTakeAt 而没有状态时，
  // 无法区分“刚查完还有额度”与“从未查过”，会把禁入提示误显示给所有人（INV-22）。
  const offPeakTakeNumberAvailability = useOffPeakTaskStore(
    (state) => state.takeNumberAvailability,
  );
  const offPeakTakeNumberAvailabilityStatus = useOffPeakTaskStore(
    (state) => state.takeNumberAvailabilityStatus,
  );
  // [并发] 闲时任务有独立的 operationId：两类任务的操作可以并行，
  // 共用一个 id 会让“创建闲时任务”把定时任务卡片也置为 busy（INV-18）。
  const offPeakOperationId = useOffPeakTaskStore((state) => state.operationId);
  const offPeakRefresh = useOffPeakTaskStore((state) => state.refresh);
  const offPeakRefreshCodingPlanSupport = useOffPeakTaskStore(
    (state) => state.refreshCodingPlanSupport,
  );
  const offPeakRefreshTakeNumberAvailability = useOffPeakTaskStore(
    (state) => state.refreshTakeNumberAvailability,
  );
  const offPeakCreate = useOffPeakTaskStore((state) => state.createTask);
  const offPeakUpdate = useOffPeakTaskStore((state) => state.updateTask);
  const offPeakPause = useOffPeakTaskStore((state) => state.pauseTask);
  const offPeakContinue = useOffPeakTaskStore((state) => state.continueTask);
  const offPeakCancel = useOffPeakTaskStore((state) => state.cancelTask);
  const offPeakDelete = useOffPeakTaskStore((state) => state.deleteTask);
  const offPeakDeleteHistory = useOffPeakTaskStore((state) => state.deleteHistory);
  // [事务] 待消费草稿用“消费”语义读取而不是普通 getter：读与清必须在 store 内原子完成，
  // 否则两次渲染之间会把同一份草稿应用两次，覆盖用户已经输入的内容（INV-9）。
  const consumePendingCreateDraft = useOffPeakTaskStore((state) => state.consumePendingCreateDraft);

  // [资源] refreshing 是“手动刷新按钮”的本地态，必须与 store 的 loading 分开：
  // loading 表示后台初始化，若共用，手动刷新会让整页闪成骨架屏。
  const [refreshing, setRefreshing] = useState(false);
  // [事务] 初始 mode 固定为 list，不能依据 URL 猜：深链进入时 workspace 尚未加载，
  // 此时直接开编辑页会拿不到列表，删/改操作全部指向不存在的对象（INV-1）。
  const [view, setView] = useState<AutomationsView>({ mode: "list" });
  // tab 与状态筛选同居一个状态：所有 setTab 调用都经 resolveAutomationTabState 归约，
  // tab 一变筛选即回到全部，切走再切回也不会恢复旧筛选。
  const [tabState, setTabState] = useState<AutomationTabState<AutomationsTab>>({
    tab: "scheduled",
    filter: DEFAULT_AUTOMATION_STATUS_FILTER,
  });
  const { tab, filter: statusFilter } = tabState;
  // [权衡] 两个字段放在同一个 state 里，是为了让归约函数能同时看到旧值；
  // 拆成两个 state 会让“切换 tab 重置筛选”变成两次不可分的写入（INV-6）。
  // [事务] 归约必须发生在同一个 setState 内：若先 setTab 再 setFilter，
  // 中间会有一帧“新 tab + 旧筛选”的渲染，列表可能瞬间显示 0 条并触发空态（INV-6）。
  const setTab = useCallback(
    (next: AutomationsTab | ((current: AutomationsTab) => AutomationsTab)) =>
      setTabState((previous) =>
        resolveAutomationTabState(previous, typeof next === "function" ? next(previous.tab) : next),
      ),
    [],
  );
  // [权衡] 单独切筛选只改 filter，不重置 tab：筛选是“看同一批任务的子集”，
  // 若也重置 tab，用户在 Idle 里换个筛选就会被弹回 Scheduled。
  const setStatusFilter = useCallback(
    (filter: AutomationStatusFilter) => setTabState((previous) => ({ ...previous, filter })),
    [],
  );
  // 动态工作流灰度：未命中就没有「工作流」标签，
  // 页面退回单一的「自动化」。快照未就绪时 enabled 为 false，宁可标题晚半拍长出切换，也不先闪
  // 一个标签再收起——中枢很少是用户进 app 后第一眼看的东西。
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  // 顶级标签「自动化 / 工作流」：页标题即切换。中枢已是跨项目视图，记忆不再按项目分桶，用 app 级单 key。
  const [storedPageTab, setPageTabState] = useState<AutomationsPageTab>(() =>
    readAutomationsPageTab(),
  );
  // 灰度关时忽略 sessionStorage 里记住的「工作流」：只收窄读出来的值，记忆本身不清，
  // 灰度再开时用户仍然回到上次那一页。中枢只在 `pageTab === "workflow"` 分支挂载，
  // 收窄 pageTab 等于 SavedWorkflowsSection 永不挂载，不会有一帧的误挂载去发查询。
  // [事务] pageTab 是从“记忆值”派生出的收窄结果，而不是另一个 state：
  // 用两份状态同步灰度开关，必然出现“记忆已改、展示未改”的中间态（INV-16）。
  const pageTab: AutomationsPageTab = dynamicWorkflowEnabled ? storedPageTab : "automation";
  const setPageTab = useCallback((next: AutomationsPageTab) => {
    // [事务] 先写 state 再写持久化：反过来的话写盘失败会留下“记忆已改、界面未改”，
    // 用户下次进入才发现跳错页，而本次操作看起来毫无效果。
    setPageTabState(next);
    writeAutomationsPageTab(next);
  }, []);
  // [并发] 用 selector 精确取“当前激活的工作区 tab”，而不是订阅整个 tabs 数组：
  // tab 拖拽/切换很频繁，整数组订阅会让设置页在用户拖动标签时持续重渲。
  const activeWorkspaceTab = useTabStore((state) => {
    const activeTab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
    return activeTab && isWorkspaceTab(activeTab) ? activeTab : undefined;
  });
  // [事务] 每次渲染重算而不是缓存进 state：工作区 tab 可能在外部被拖动或关闭，
  // 缓存值会和实际激活 tab 脱节，导致入口出现在已切走的远端项目上（INV-8）。
  const currentWorkspaceIsRemote = isRemoteAutomationWorkspace(activeWorkspaceTab);
  // 灰度中途翻转：只藏创建入口；有非终态存量仍展示并跑到终态。
  // [事务] “能创建”和“能看到存量”是两个独立条件：把后者也绑到灰度上，
  // 灰度关闭时用户手上正在跑的任务会整块消失，只能等它自己结束（INV-7）。
  const offPeakGrayEnabled = offPeakGrayConfig?.enabled === true;
  // [失败路径] 远端工作区要单独排除：灰度开关是在宿主上评估的，
  // 它不知道当前会话连的是远端机器，二者取与才能保证入口不会出现在错误的项目里（INV-8）。
  const offPeakCreationEnabled = offPeakGrayEnabled && !currentWorkspaceIsRemote;
  // 扫描全部 provider 会把未选中的 Coding Plan 当成当前执行凭证。
  // mock 演示字段仍可覆盖；真实路径只接受与当前 family/selectedKey 一致的脱敏 resolver 快照。
  // [失败路径] 这里刻意区分“明确 false”与“未知”：codingPlanActive 未定义时再回落到
  // 本地能力查询，若查询还在 loading 就不判锁定，避免首帧把所有用户错误地挡在门外。
  const offPeakNoPlan =
    offPeakGrayConfig?.codingPlanActive === false ||
    (offPeakGrayConfig?.codingPlanActive === undefined &&
      !offPeakStoreLoading &&
      !isCurrentOffPeakCodingPlanSupported(offPeakCodingPlanSupport, sharedSettings));
  // [权衡] 用“灰度命中 或 已有存量任务”而不是只判灰度：灰度关闭后存量仍要能看，
  // 但只有存量时也不能露出创建入口，两个条件分别控制“可见”与“可创建”（INV-7）。
  const offPeakVisible =
    !currentWorkspaceIsRemote && (offPeakGrayEnabled || offPeakTasks.length > 0);
  // [事务] hasAnyTasks 决定“顶栏 tab 是否存在”，因此必须把两类任务都算进来：
  // 只看定时任务会让只有闲时任务的用户看到空首页，tab 消失后无法回到 Idle（INV-21）。
  const hasAnyTasks = automations.length > 0 || offPeakTasks.length > 0;
  // [失败路径] visibleTabs 为空说明“一条任务都没有”，此时 Top tab 整行不渲染；
  // 列表与模板都退化为并列展示，任何依赖 tab 的分支都必须先看这个前提（INV-21）。
  const visibleTabs = resolveVisibleAutomationTabs({
    hasAnyTasks,
    offPeakVisible,
  });
  // [权衡] hasVisibleTaskCards 用“未筛选”的原始长度：分隔线的职责是区分“任务区”
  // 与“模板区”，筛选后任务为空时区块仍然存在，线不应该跟着消失。
  const hasVisibleTaskCards =
    tab === "scheduled" ? automations.length > 0 : offPeakTasks.length > 0;
  // [事务] 筛选结果与原始列表分开保存：卡片计数、空态判断、grid 滚动阈值都基于
  // 筛选后的数量，混用原始长度会在“筛出少量任务”时仍锁最大高度、留下大块空白。
  const visibleAutomations = filterAutomationsByStatus(automations, statusFilter);
  const visibleOffPeakTasks = filterOffPeakTasksByStatus(offPeakTasks, statusFilter);
  // [事务] 模板可见性必须与列表共用同一份 hasAnyTasks 与 tab：
  // 各自推导会让“任务区为空但模板区显示”与 tab 的空态分支互相矛盾（INV-21）。
  const { showOffPeakTemplates, showScheduledTemplates } = resolveAutomationTemplateVisibility({
    hasAnyTasks,
    offPeakCreationEnabled,
    tab,
  });
  // [事务] 派生值不落 state：模板可见性一旦缓存，灰度或 tab 变化后不会重算，
  // 用户会看到本该隐藏的模板区继续存在（且它下面的任务是空的）。
  const hasVisibleTemplates = showOffPeakTemplates || showScheduledTemplates;
  // [权衡] 分隔线只在“有任务且有模板”时出现：任一侧为空时它只是一条孤立细线，
  // 在空态里既没有分组语义，还会让大卡上下留白对不齐。
  const showTaskTemplateSeparator = hasVisibleTaskCards && hasVisibleTemplates;
  // [事务] loadedWorkspaceKey 与 workspacePath 分开存：前者只有在 initialize 完成后
  // 才等于当前 key，是“这份列表属于当前项目”的唯一证据（INV-14）。
  const [loadedWorkspaceKey, setLoadedWorkspaceKey] = useState<string | null>(null);
  // 相对时间基准;刷新列表时更新,避免频繁 setInterval。
  // [权衡] now 由“事件驱动”更新（刷新、数据到达、分钟边界定时器），而不是每秒 tick：
  // 每秒 setState 会让整个卡片列表每秒重渲一次，代价与收益完全不成比例。
  const [now, setNow] = useState(() => Date.now());

  // 创建准入 fail-closed。只有服务端成功返回 canTakeNumber=true 才放行；资格不符、
  // loading/idle/error 与额度 false 都禁入，避免依赖异常被吞掉后直到真实创建才报错。
  const offPeakCreateGrey = useMemo(() => {
    // [事务] reason 只由这四个输入决定，且完全交给纯函数判定：
    // 把任何一个条件挪到组件里内联，都会让“展示禁用”与“提交前校验”各持一套规则（INV-22）。
    const reason = resolveOffPeakCreateBlockReason({
      availabilityStatus: offPeakTakeNumberAvailabilityStatus,
      canTakeNumber: offPeakTakeNumberAvailability?.canTakeNumber,
      grayEnabled: offPeakGrayEnabled,
      noPlan: offPeakNoPlan,
    });
    // [权衡] tooltip 文案在这里就翻译成字符串，而不是把 reason 传到按钮里再翻译：
    // 按钮只负责展示，不应该知道“额度/计划/不可用”这些业务分支（INV-22）。
    const tooltip =
      reason === "plan"
        ? intl.formatMessage({ id: "offPeak.create.codingPlanOnly" })
        : reason === "unavailable"
          ? intl.formatMessage({ id: "offPeak.create.availabilityUnavailable" })
          : reason === "quota" && offPeakTakeNumberAvailability?.nextTakeAt !== undefined
            ? intl.formatMessage(
                { id: "offPeak.create.limitReachedAt" },
                {
                  time: formatOffPeakRemainingWait(
                    offPeakTakeNumberAvailability.nextTakeAt,
                    now,
                    intl,
                  ),
                },
              )
            : undefined;
    return { reason, tooltip };
  }, [
    intl,
    now,
    offPeakGrayEnabled,
    offPeakNoPlan,
    offPeakTakeNumberAvailability,
    offPeakTakeNumberAvailabilityStatus,
  ]);

  // [事务] 这个 effect 是“工作区切换”的唯一入口：先清空就绪标记，再发 initialize，
  // 完成后才写入新 key。顺序颠倒会让详情导航在旧列表上做出 missing 判定（INV-15）。
  // 列表按当前项目加载(主视图由 WorkspaceShellLayout 传入当前 workspace)。
  useEffect(() => {
    if (!workspacePath) return;
    // [失败路径] 没有 workspacePath 时直接返回，且保持 loadedWorkspaceKey 不变：
    // 过早置 null 会让“未打开项目”和“项目正在切换”变得不可区分（INV-14）。
    const workspaceKey = resolveWorkspaceKey({
      workspacePath,
      workspaceIdentity,
    });
    let disposed = false;
    // [并发] disposed 是必要的，而不是防御性代码：initialize 是网络请求，
    // 用户快速切换项目时前一个请求可能后返回，若直接 setLoadedWorkspaceKey
    // 会把“旧项目的完成”误标成“新项目已就绪”（INV-14）。
    setLoadedWorkspaceKey(null);
    // [并发] 同时推进 now：新项目的数据马上到达，若不刷新基准时间，
    // “上次运行 3 分钟前”会以旧基准计算，出现负数或明显偏大的相对时间。
    setNow(Date.now());
    void initialize({
      workspacePath,
      workspaceIdentity,
      agentService: zcodeAgentService,
    }).then(() => {
      if (!disposed) setLoadedWorkspaceKey(workspaceKey);
    });
    return () => {
      // [资源] cleanup 只置标志，不取消请求：initialize 会写共享 store，
      // 取消它会让“切走再切回”重新拉一次全量列表，代价高于让请求自然完成。
      disposed = true;
    };
  }, [workspacePath, workspaceIdentity, zcodeAgentService, initialize]);

  // [失败路径] 这个 effect 处理“灰度在会话中途翻转”：visibleTabs 收窄后若 tab 仍是
  // idle，两块列表都不会渲染，页面直接空白，所以必须主动归约（INV-7）。
  useEffect(() => {
    const nextTab = resolveAutomationTabAfterOffPeakChange(tab, offPeakVisible);
    // [权衡] 归约结果相同时必须提前返回：setTab 会触发一次全量重渲，
    // 而本 effect 依赖 tab，若不做等值短路会形成“渲染 → effect → 渲染”的自激循环。
    if (nextTab === tab) return;
    // 后台关闭闲时灰度后，Idle tab 会被隐藏；旧状态若继续停在 idle，
    // 定时任务列表也会被 tab === "idle" 一并隐藏。回到 Scheduled，确保定时任务始终可访问。
    setTab(nextTab);
  }, [offPeakVisible, tab]);

  // [事务] openAutomationTab 是一次性的“请求切 tab”，处理完必须消费：
  // 它与 openAutomationId 共用同一个消费回调，因此两个 effect 都要小心不要抢跑（INV-9）。
  useEffect(() => {
    if (!openAutomationTab) return;
    // 灰度关：请求的「工作流」标签不存在，
    // 落到「自动化」并把深链消费掉——不消费会让请求一直挂着，反复把页面拉回来。
    if (openAutomationTab === "workflow" && !dynamicWorkflowEnabled) {
      setPageTab("automation");
      onOpenAutomationConsumed?.();
      return;
    }
    if (openAutomationTab === "workflow") {
      // [事务] 工作流导航必须先切 pageTab 再消费：只切 tab 而不切顶级页，
      // 消费后页面仍停在自动化页，用户看不到目标内容却再也无法重试（INV-9）。
      setPageTab("workflow");
      onOpenAutomationConsumed?.();
      return;
    }
    // 闲时详情导航由下方 offpeak 分支统一 setTab("idle") + 消费；这里若先按
    // 当前（可能尚未加载的）可见 tab 回退到 scheduled 并消费，会把 pending 的详情导航一并清掉。
    if (isOffPeakDetailNavigationId(openAutomationId)) return;
    // [失败路径] 这两个 effect 共享同一个消费回调，谁先执行都可能清掉对方的参数；
    // 用 id 前缀把权限划清，是本文件里唯一能保证“详情导航不被 tab 导航误消费”的依据。
    // [并发] 就绪判据必须同时包含“工作区匹配”和“闲时列表不 loading”：
    // 任一缺失都会在数据未到齐时给出 settled，从而消费掉本应等待的导航（INV-10）。
    const currentWorkspaceKey = workspacePath
      ? resolveWorkspaceKey({ workspacePath, workspaceIdentity })
      : null;
    const result = resolveAutomationTabNavigation({
      requestedTab: openAutomationTab,
      tabsReady:
        currentWorkspaceKey !== null &&
        loadedWorkspaceKey === currentWorkspaceKey &&
        !offPeakStoreLoading,
      visibleTabs,
    });
    // [事务] pending 时直接返回，连 setPageTab 都不做：此时任何写入都会让页面
    // 先跳到自动化页，等数据到达后再跳回来，用户看到明显的双向闪动（INV-10）。
    if (result.status === "pending") return;
    // [事务] 消费前先把顶级页切回自动化：请求可能来自工作流页的推荐提示词，
    // 不切页就会出现“tab 已切、页面仍停在工作流”的割裂状态（INV-9）。
    setPageTab("automation");
    if (result.tab !== tab) setTab(result.tab);
    onOpenAutomationConsumed?.();
  }, [
    dynamicWorkflowEnabled,
    loadedWorkspaceKey,
    offPeakStoreLoading,
    onOpenAutomationConsumed,
    openAutomationId,
    openAutomationTab,
    setPageTab,
    tab,
    visibleTabs,
    workspaceIdentity,
    workspacePath,
  ]);

  // [资源] 额度恢复后必须重新查询，否则禁入状态会一直保持；用 setTimeout 而不是轮询，
  // 是因为服务端已给出准确的 nextTakeAt，按点触发既准确又不需要周期性唤醒（INV-13）。
  // 服务端给出准确恢复时间；到点后重查。刷新期间及失败后继续禁入，直到成功返回 true。
  useEffect(() => {
    const nextTakeAt = offPeakTakeNumberAvailability?.nextTakeAt;
    if (offPeakTakeNumberAvailability?.canTakeNumber !== false || nextTakeAt === undefined) return;
    // [失败路径] +100ms 不是随手加的：服务端的时间与本地时钟可能有毫秒级偏差，
    // 正好在 nextTakeAt 触发会拿到“仍然不可用”的旧快照，白跑一次查询并重新排程。
    const delay = Math.max(0, nextTakeAt - Date.now()) + 100;
    const timer = setTimeout(() => {
      setNow(Date.now());
      void offPeakRefreshTakeNumberAvailability(offPeakTaskService);
    }, delay);
    return () => clearTimeout(timer);
  }, [offPeakRefreshTakeNumberAvailability, offPeakTaskService, offPeakTakeNumberAvailability]);

  // [权衡] 第二个定时器只刷新 now，不请求网络：它负责让“剩余 3 分 12 秒”这类文案
  // 随分钟边界递减，联网刷新由上面的额度定时器负责，两者职责不同不能合并（INV-13）。
  // 额度 Tooltip 曾改成不会递减的绝对日期；按远端实现推进分钟边界，保持剩余时长准确。
  useEffect(() => {
    const nextTakeAt = offPeakTakeNumberAvailability?.nextTakeAt;
    if (offPeakTakeNumberAvailability?.canTakeNumber !== false || nextTakeAt === undefined) return;
    const remainingMs = nextTakeAt - Date.now();
    if (remainingMs <= 0) return;
    const minuteMs = 60_000;
    const remainderMs = remainingMs % minuteMs;
    // [权衡] remainder 为 0 时取整分钟而不是 0：立即 setNow 不会改变任何文案，
    // 却会把 effect 重新排到同一时刻，形成一次空转的微任务风暴。
    const delay = (remainderMs === 0 ? minuteMs : remainderMs) + 50;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, offPeakTakeNumberAvailability]);

  // [资源] 轮询只在“列表视图且有闲时任务”时开启：编辑页与空列表都不需要位次刷新，
  // 无条件轮询会让用户停留在设置页时也持续发请求（INV-13）。
  // 位次/状态轮询刷新（host offPeakTaskSync 写库，renderer 每 10s 读快照；无任务不轮）。
  useEffect(() => {
    if (view.mode !== "list" || offPeakTasks.length === 0) return;
    const timer = setInterval(() => {
      // [资源] 这里不检查 loading 再跳过：refresh 内部会把并发请求合并，
      // 额外判断反而会在上一次请求卡住时永久停掉轮询。
      void offPeakRefresh(offPeakTaskService);
    }, 10_000);
    return () => clearInterval(timer);
  }, [view.mode, offPeakTasks.length, offPeakRefresh, offPeakTaskService]);

  // [并发] 刷新用 Promise.all 并行发三条请求，而不是串行：三者互不依赖，
  // 串行会让最慢的一条把另外两条的耗时叠加，用户感觉刷新按钮“卡住”。
  const handleRefresh = useCallback(async () => {
    // [资源] 手动刷新标志与 store.loading 分开：它只控制右上按钮的旋转与禁用，
    // 若复用它当全局加载态，一次手动刷新会把已有列表替换成骨架屏。
    setRefreshing(true);
    try {
      await Promise.all([
        refresh(zcodeAgentService),
        offPeakRefresh(offPeakTaskService),
        ...(offPeakGrayEnabled ? [offPeakRefreshCodingPlanSupport(offPeakTaskService)] : []),
      ]);
      setNow(Date.now());
    } finally {
      // [失败路径] 必须在 finally 复位：任一请求 reject 时 Promise.all 会立刻抛出，
      // 若只在成功路径复位，刷新按钮会永久转圈且无法再次点击。
      setRefreshing(false);
    }
  }, [
    offPeakGrayEnabled,
    offPeakRefresh,
    offPeakRefreshCodingPlanSupport,
    offPeakTaskService,
    refresh,
    zcodeAgentService,
  ]);

  // [事务] 消费草稿用“读一次就清”的 store action，而不是读取后再手动清除：
  // 两步之间若发生重渲，会把同一份草稿消费两次并覆盖用户的输入（INV-9）。
  // New task 页模板卡跳转过来：消费预填草稿 → 切 idle tab + 打开创建表单预填。
  useEffect(() => {
    const draft = consumePendingCreateDraft();
    // [事务] null 表示“没有待消费草稿”，此时必须原样返回：把 null 当空表单去打开
    // 创建页，会让每次进入这个页面都自动弹出一个空表单。
    if (!draft) return;
    // [失败路径] 远端工作区要丢弃草稿而不是降级打开：草稿里没有项目选择信息，
    // 打开表单只能绑定到远端项目，提交后也无法在本机执行（INV-8）。
    if (currentWorkspaceIsRemote) return;
    setTab("idle");
    setView({ mode: "offpeak-create", draft });
  }, [consumePendingCreateDraft, currentWorkspaceIsRemote]);

  // [失败路径] 切到远端工作区时必须把闲时相关视图强制回列表：远程会话不能作为
  // 闲时任务的归属项目，停留在该表单会让提交被静默绑到远端（INV-8）。
  useEffect(() => {
    if (!currentWorkspaceIsRemote) return;
    // [事务] 归约 tab 用函数式更新而不是直接 "scheduled"：用户可能在别处已经把 tab
    // 改成别的值，直接覆盖会把“当前的 scheduled 选择”误改成旧值。
    setTab((current) => (current === "idle" ? "scheduled" : current));
    setView((current) =>
      current.mode === "offpeak-create" || current.mode === "offpeak-edit"
        ? { mode: "list" }
        : current,
    );
  }, [currentWorkspaceIsRemote]);

  // [事务] 入口套餐状态在点击瞬间冻结并写进 funnelContext：后续 OAuth 只刷新鉴权，
  // 若在升级流程中重新读取，用户中途切换套餐会让漏斗记录与真实行为对不上。
  const handleOpenCodingPlanUpgrade = useCallback(() => {
    // [事务] providerId 由当前套餐家族决定而不是写死：两类 Coding Plan 的购买页
    // 与权益不同，取错会让个人用户落到企业采购流程，或在已有套餐上重复购买。
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const eventText = intl.formatMessage({
      id: "settings.modelProvider.codingPlan.upgrade",
    });
    // 埋点缺失原因：Automations 的闲时入口此前绕过了购买漏斗 context，只打开弹窗。
    // 这里在用户点击时冻结入口套餐状态，后续 OAuth 只刷新鉴权，不重建 funnel。
    // [权衡] initialAudience 固定为 personal：企业版套餐走独立的采购流程，
    // 闲时任务是个人订阅场景，传错 audience 会把用户导向无法购买的企业入口。
    openCodingPlanUpgrade({
      providerId,
      initialAudience: "personal",
      funnelContext: createIdleTimeCodingPlanFunnelContext({
        providerId,
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView),
      }),
    });
  }, [intl, openCodingPlanUpgrade, providerSettingsView, sharedSettings?.providerFamilyDomain]);

  // [失败路径] 计划锁定时不弹普通 toast 而是弹带升级动作的提示：
  // 用户看到“需要 Coding Plan”却没有可点的入口，等于把转化路径断在这里（INV-23）。
  const showCodingPlanRequiredToast = useCallback(() => {
    toast(entryLabel ?? intl.formatMessage({ id: "offPeak.create.codingPlanToast" }), {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      // [失败路径] loading 态不给 actionLabel：此时用户点了也无法重试，
      // 露出一个永远不响应的按钮比不露出更糟（会额外产生一次空点击埋点）。
      actionLabel:
        entryStatus === "loading"
          ? undefined
          : (entryLabel ??
            intl.formatMessage({
              id: "settings.modelProvider.codingPlan.upgrade",
            })),
      // [事务] error 时 action 是“重试查询”，其余时是“去升级”：两种动作语义不同，
      // 若统一绑到升级，入口状态查询失败的用户会被带去付款页而不是修复状态（INV-22）。
      onAction: entryStatus === "error" ? retryEntry : handleOpenCodingPlanUpgrade,
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "common.close" }),
    });
  }, [handleOpenCodingPlanUpgrade, intl, entryStatus, entryLabel, retryEntry]);

  // [失败路径] 限额提示必须带上具体上限值：只说“已达上限”用户不知道该删几条，
  // 而 limit 是编译期常量，集中在这里格式化可以避免各入口写出不同文案。
  const showAutomationCreateLimitToast = useCallback(() => {
    // [失败路径] 提示里必须带具体上限：只说“已达上限”用户不知道要删几条，
    // 而额度是常量，格式化放在这里可保证三个入口的文案完全一致（INV-5）。
    toast(
      intl.formatMessage(
        { id: "automations.error.createLimit" },
        { limit: String(AUTOMATION_CREATE_LIMIT) },
      ),
    );
  }, [intl]);

  // [并发] 就绪信号按“本次导航 id”记录，而不是用一个布尔量：
  // 用户连续点两个不同任务时，第一个任务的刷新完成不能证明第二个任务已可定位。
  // 会话内 OffPeakCreate 由 agent 直接落库，不经过 UI store；store 的 loading 初值也
  // 是 false（"未加载"与"已加载"不可分）。因此每次 offpeak 导航都强制刷新列表，并以
  // 「本次导航 id 的刷新已完成」作为唯一就绪信号，避免拿陈旧/空列表误判 targetNotFound。
  const [offPeakNavRefreshed, setOffPeakNavRefreshed] = useState<{
    id: string | null;
    error: string | null;
  }>({ id: null, error: null });
  useEffect(() => {
    if (!isOffPeakDetailNavigationId(openAutomationId)) return;
    let disposed = false;
    // [资源] finally 里写就绪信号，而不是 then：refresh 不 reject，失败只写 store.error，
    // 若放在 then 里，失败时导航会永远停在 pending，页面一直空白（INV-10）。
    void offPeakRefresh(offPeakTaskService).finally(() => {
      if (disposed) return;
      // review：refresh 不 reject，失败只写 store.error；把它随就绪信号一起带出。
      // [并发] 这里读的是 store 的最新快照而不是闭包里的 offPeakTasks：
      // 闭包捕获的是 effect 创建时的列表，刷新后的新任务它看不见（INV-10）。
      setOffPeakNavRefreshed({
        id: openAutomationId ?? null,
        error: useOffPeakTaskStore.getState().error ?? null,
      });
    });
    return () => {
      disposed = true;
    };
  }, [openAutomationId, offPeakRefresh, offPeakTaskService]);

  // [事务] 详情导航统一在这里消费：两条分支（offpeak / cron）都必须走到
  // onOpenAutomationConsumed，否则父层的参数残留会把用户反复推回详情页（INV-9）。
  useEffect(() => {
    // 闲时轮尾卡携带 offpeak- 前缀 id，从并行路径解析进 offpeak-edit 视图；
    // 不能落进 cron 解析（必然 missing 并误报 targetNotFound）。
    if (isOffPeakDetailNavigationId(openAutomationId)) {
      const result = resolveOffPeakDetailNavigation(
        offPeakTasks,
        openAutomationId,
        offPeakNavRefreshed.id === openAutomationId,
        offPeakNavRefreshed.error,
      );
      if (result.status === "pending") return;
      // [事务] found 时先切 tab 再开表单：顺序反过来会让表单在 scheduled tab 下渲染
      // 一帧，随后被 effect 归约回列表，用户看到表单闪一下就消失（INV-7）。
      if (result.status === "found") {
        setTab("idle");
        setView({ mode: "offpeak-edit", task: result.target });
      } else if (result.status === "unavailable") {
        // 列表刷新失败：落到闲时 tab 并提示加载失败，不误报"任务不存在"。
        setTab("idle");
        toast(intl.formatMessage({ id: "offPeak.nav.listUnavailable" }));
      } else {
        toast(intl.formatMessage({ id: "automations.error.targetNotFound" }));
      }
      // [事务] 三条分支都必须消费：pending 已在上面提前返回，因此这里不会清掉
      // “还没等到数据”的导航（INV-9/INV-10）。
      onOpenAutomationConsumed?.();
      return;
    }
    const currentWorkspaceKey = workspacePath
      ? resolveWorkspaceKey({ workspacePath, workspaceIdentity })
      : null;
    // [事务] listReady 不能只看 loading：列表可能已经加载完，但属于上一个项目，
    // 必须比对 workspaceKey 与 loadedWorkspaceKey 的相等性，才能确认数据归属（INV-14）。
    const result = resolveAutomationDetailNavigation(
      automations,
      openAutomationId,
      currentWorkspaceKey !== null && loadedWorkspaceKey === currentWorkspaceKey,
    );
    if (result.status === "pending") return;
    if (result.status === "found") {
      setView({ mode: "edit", automation: result.target });
    } else {
      // 目标任务可能已删除；失效的一次性导航必须提示并消费，不能影响后续进入页面。
      toast(intl.formatMessage({ id: "automations.error.targetNotFound" }));
    }
    onOpenAutomationConsumed?.();
  }, [
    automations,
    intl,
    loadedWorkspaceKey,
    offPeakNavRefreshed,
    offPeakTasks,
    onOpenAutomationConsumed,
    openAutomationId,
    workspaceIdentity,
    workspacePath,
  ]);

  // [失败路径] 创建入口必须在这里统一收敛限额与远端工作区两个前置条件，
  // 而不是在表单提交时再判断：让用户填完表单才被拒，既浪费输入也容易丢草稿（INV-5）。
  const handleCreateManually = useCallback(() => {
    if (automationCreateLimitReached) {
      showAutomationCreateLimitToast();
      return;
    }
    setView({ mode: "create", draft: null });
  }, [automationCreateLimitReached, showAutomationCreateLimitToast]);

  // 「Create via chat」:交给 parent 切到会话视图;未提供则回退到手动创建整页。
  // [权衡] 回退顺序是“对话优先、手动兜底”：对话入口能携带更多上下文，但调用方
  // 可能未挂载会话视图（例如嵌入式设置页），此时必须仍给出一条可完成的创建路径。
  const handleCreateViaChat = useCallback(() => {
    if (automationCreateLimitReached) {
      showAutomationCreateLimitToast();
      return;
    }
    if (currentWorkspaceIsRemote) {
      // Automations 创建只能绑定本地项目；远端当前会话不能隐式成为创建目标。
      // 仍保留管理页，但把创建收敛到带本地项目选择器的表单。
      // [失败路径] 这里不是“禁止创建”而是“换一种创建方式”：直接 toast 拒绝会让
      // 用户以为远端模式下根本不能用自动化，实际上表单里选个项目就能继续（INV-8）。
      setView({ mode: "create", draft: null });
      return;
    }
    if (onCreateViaChat) {
      onCreateViaChat(intl.formatMessage({ id: "automations.createViaChat.prompt" }));
    } else setView({ mode: "create", draft: null });
  }, [
    automationCreateLimitReached,
    currentWorkspaceIsRemote,
    intl,
    onCreateViaChat,
    showAutomationCreateLimitToast,
  ]);

  // [事务] 模板只 materialize 成草稿，不直接创建：用户需要先确认 cron 与提示词，
  // 直接创建会让“点一下模板”立刻产生后台任务，误触代价高且难以撤销。
  const handleUseTemplate = useCallback(
    (template: ScheduledAutomationTemplate) => {
      if (automationCreateLimitReached) {
        showAutomationCreateLimitToast();
        return;
      }
      const draft = materializeScheduledTemplateDraft(template, locale);
      setView({
        mode: "create",
        draft,
      });
    },
    [automationCreateLimitReached, locale, showAutomationCreateLimitToast],
  );

  // 创建/编辑整页提交:创建可指定目标项目;编辑锁定原项目。
  // [事务] 编辑分支只调 update 且立刻返回，不落进创建逻辑：两个分支共用入口是为了
  // 复用表单，但语义完全不同，混流会让编辑保存后多创建一条任务。
  const handleEditSubmit = useCallback(
    async ({
      input,
      workspacePath: targetPath,
      workspaceIdentity: targetIdentity,
    }: AutomationEditSubmit) => {
      if (view.mode === "edit") {
        // [失败路径] 以 store 返回的 ok 为准，而不是检查 error 字符串：
        // error 可能被上一次失败残留，字符串判断会让一次成功被误报为失败。
        const ok = await updateAutomation(view.automation.automationId, input, zcodeAgentService);
        if (!ok) {
          toast(
            intl.formatMessage({
              id: getAutomationActionErrorToastId("update"),
            }),
          );
        } else {
          setNow(Date.now());
        }
        return ok;
      }
      if (automationCreateLimitReached) {
        showAutomationCreateLimitToast();
        return false;
      }
      // [事务] 创建走 store action 而不是直接调 RPC：store 负责插入列表、清错误、
      // 维护 operationId；绕过它会让新任务在刷新前不可见（INV-2）。
      const created = await createAutomation(
        {
          ...(input as Parameters<typeof createAutomation>[0]),
          // [事务] 目标项目由表单显式传出，而不是默认取当前 workspace：
          // 在“所有项目”视图里创建时，当前 workspace 可能是空的或不是用户选中的那个。
          workspacePath: targetPath,
          workspaceIdentity: targetIdentity,
        },
        zcodeAgentService,
      );
      // [失败路径] 埋点必须在判空之前发：创建失败本身是要观测的核心指标，
      // 放在成功分支之后会让失败率永远为 0。
      void reportAutomationCreateResult(platform, {
        automationId: created?.automationId,
        cronExpr: input.cronExpr ?? "",
        templateId: view.mode === "create" ? view.draft?.templateId : undefined,
        error: useAutomationManagementStore.getState().error,
        modelFields: resolveAutomationSelectionTelemetry(
          input.modelSelection,
          providerSettingsView,
        ),
      });
      if (!created) {
        // [失败路径] 必须重新从 store 读 error，而不是复用上面埋点里的值：
        // 两次 getState 之间可能被并发的 refresh 覆盖，读旧值会把限额错误报成通用错误。
        const createError = useAutomationManagementStore.getState().error;
        toast(
          intl.formatMessage(
            { id: getAutomationCreateErrorToastId(createError) },
            { limit: String(AUTOMATION_CREATE_LIMIT) },
          ),
        );
        return false;
      }
      // [并发] 成功后才推进 now：失败时推进没有意义，反而会让“上次运行”文案
      // 在没有任何数据变化时刷新，用户可能误以为状态已经更新。
      setNow(Date.now());
      return true;
    },
    [
      automationCreateLimitReached,
      createAutomation,
      intl,
      platform,
      providerSettingsView,
      showAutomationCreateLimitToast,
      updateAutomation,
      view,
      zcodeAgentService,
    ],
  );

  // [事务] 启停是“先写服务端再回写本地视图”的两步操作：
  // 编辑页持有进入时的快照，store 刷新不会替换它，所以成功分支必须手动合并
  // enabled 与 lifecycleStatus 两个字段，否则详情页开关会与列表不一致（INV-3）。
  const handleToggle = useCallback(
    async (automation: ZCodeAutomation, enabled: boolean) => {
      await setEnabled(automation.automationId, enabled, zcodeAgentService);
      // [失败路径] 用 store.error 判定而不是 setEnabled 的返回值：该 action 已经
      // 把失败转成“写入 error 并返回”，统一读 error 才能覆盖不同程度的失败来源。
      const message = useAutomationManagementStore.getState().error;
      if (message) toast(intl.formatMessage({ id: getAutomationActionErrorToastId("toggle") }));
      else {
        // 编辑页 view 持有进入页面时的 automation 对象；列表刷新不会自动替换
        // 这个局部对象，导致菜单点击 Pause/Resume 后文案仍停在旧状态。
        setView((prev) =>
          prev.mode === "edit" && prev.automation.automationId === automation.automationId
            ? {
                mode: "edit",
                automation: {
                  ...prev.automation,
                  enabled,
                  lifecycleStatus: enabled ? "active" : "paused",
                },
              }
            : prev,
        );
        setNow(Date.now());
      }
    },
    [intl, setEnabled, zcodeAgentService],
  );

  // [失败路径] 重启只对 failed 提供入口，这里仍按 store.error 判断结果：
  // 守卫只是 UI 约束，列表可能已过期，不能据此假定服务端一定接受。
  const handleRestart = useCallback(
    async (automation: ZCodeAutomation) => {
      await restartAutomation(automation.automationId, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message)
        toast(
          intl.formatMessage({
            id: getAutomationActionErrorToastId("restart"),
          }),
        );
      else setNow(Date.now());
    },
    [intl, restartAutomation, zcodeAgentService],
  );

  // [失败路径] 立即运行有三种结果，必须分别处理：queued 才能继续拉 runs；
  // duplicate 说明上一次手动触发的 run 还没结束，重复提示会让用户误以为创建了两次。
  const handleRunNow = useCallback(
    async (automation: ZCodeAutomation, source: "list" | "editor" = "list") => {
      logger.debug("[automations] 立即运行交互开始", {
        automationId: automation.automationId,
        source,
      });
      void reportAutomationActionClick(platform, {
        action: "run_now",
        source,
        automation,
        providerSettingsView,
      });
      const result = await runAutomationNow(automation.automationId, zcodeAgentService);
      // [权衡] 前后各打一条 debug 日志，而不是只打结果：立即运行失败时请求可能抛出，
      // 只有“开始”一条能证明用户确实点击过，便于区分“没点”和“点了但失败”。
      logger.debug("[automations] 立即运行交互结束", {
        automationId: automation.automationId,
        source,
        result,
      });
      if (result === "queued") {
        // [并发] 必须强制刷新 runs（第三参 true）再从中取最新 manual session：
        // 直接用本地缓存会拿到上一次的 sessionId，提示里的“查看”会打开错误会话。
        await loadRuns(automation.automationId, zcodeAgentService, true);
        const latestSessionId = useAutomationManagementStore
          .getState()
          .runsCache[automation.automationId]?.runs?.find(
            (run) => run.trigger === "manual" && Boolean(run.sessionId),
          )?.sessionId;
        toast(
          intl.formatMessage({ id: "scheduledPreview.toast.running" }, { title: automation.title }),
          {
            durationMs: 4000,
            position: "top-center",
            variant: "info",
            ...(latestSessionId && onOpenSession
              ? {
                  actionLabel: intl.formatMessage({
                    id: "scheduledPreview.toast.view",
                  }),
                  // [失败路径] “查看”按钮必须携带 automation 自己的 workspace：
                  // 管理页可能处于“所有项目”，用当前 workspace 会切到错误的项目下。
                  onAction: () =>
                    onOpenSession({
                      sessionId: latestSessionId,
                      workspacePath: automation.workspacePath,
                      workspaceIdentity: automation.workspaceIdentity,
                    }),
                }
              : {}),
            dismissible: true,
            dismissLabel: intl.formatMessage({ id: "common.close" }),
          },
        );
        setNow(Date.now());
      } else if (result === "duplicate") {
        // 连续点击或上一条 manual run 仍在执行时，store/host 会返回 duplicate。
        // 这里必须给出可见反馈，否则用户会以为按钮没响应。
        toast(intl.formatMessage({ id: getAutomationRunNowToastId(result) }));
      } else if (result === "failed") {
        toast(intl.formatMessage({ id: getAutomationRunNowToastId(result) }));
      }
    },
    [
      intl,
      loadRuns,
      onOpenSession,
      platform,
      providerSettingsView,
      runAutomationNow,
      zcodeAgentService,
    ],
  );

  // [失败路径] 删除前的确认必须等用户明确同意，且删除成功后要检查“是否正在编辑它”：
  // 不同步 view 会留下指向已删除对象的编辑页（INV-17）。
  const handleDelete = useCallback(
    async (automation: ZCodeAutomation, source: "list" | "editor" = "list") => {
      const confirmed = await confirmDialog({
        presentation: "automation-confirmation",
        title: intl.formatMessage({ id: "automations.delete.title" }),
        description: intl.formatMessage(
          { id: "automations.delete.description" },
          { title: automation.title },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
        confirmVariant: "destructive",
        // 共享确认弹窗默认在按钮右侧渲染 esc / ⏎，在删除场景会被视为额外图标。
        // 定时任务删除按钮只保留动作文字，且不改变其他确认弹窗的键盘提示策略。
        showKeyboardHints: false,
      });
      if (!confirmed) return;
      void reportAutomationActionClick(platform, {
        action: "delete",
        source,
        automation,
        providerSettingsView,
      });
      await deleteAutomation(automation.automationId, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message) toast(intl.formatMessage({ id: getAutomationActionErrorToastId("delete") }));
      // 若在编辑该任务的整页,删除后回列表。
      setView((prev) =>
        prev.mode === "edit" && prev.automation.automationId === automation.automationId
          ? { mode: "list" }
          : prev,
      );
    },
    [confirmDialog, deleteAutomation, intl, platform, providerSettingsView, zcodeAgentService],
  );

  // [失败路径] 没有 sessionId 时静默返回，而不是 toast：闲时任务可能在尚未开始时
  // 就没有会话，提示“无法打开”只会让用户以为出了问题（按钮本身已按状态隐藏）。
  const handleOffPeakOpenSession = useCallback(
    (task: ZCodeOffPeakTask) => {
      if (!task.sessionId || !onOpenSession) return;
      onOpenSession({
        sessionId: task.sessionId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
    },
    [onOpenSession],
  );

  // [权衡] 卡片主点击只进详情（INV-24）：把主点击绑到“跳会话”会让 Settings/History
  // 无法稳定到达，且用户无法从列表中查看任务的配置本身。
  const handleOffPeakOpen = useCallback((task: ZCodeOffPeakTask) => {
    // 有 session 的卡片主点击不能直接跳会话：会使 Settings/History
    // 无法稳定到达。卡片主路径始终进入任务详情，会话只保留为显式次级动作。
    setView({ mode: "offpeak-edit", task });
  }, []);

  // [失败路径] 取消是不可逆的状态迁移，必须二次确认；失败只 toast 不回滚本地视图：
  // 服务端状态才是真相，本地乐观回滚会让用户看到“已取消”但实际仍在排队。
  const handleOffPeakCancel = useCallback(
    async (task: ZCodeOffPeakTask) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "offPeak.cancel.title" }),
        description: intl.formatMessage(
          { id: "offPeak.cancel.description" },
          { title: task.title || task.prompt },
        ),
        confirmLabel: intl.formatMessage({ id: "offPeak.action.cancel" }),
      });
      if (!confirmed) return;
      await offPeakCancel(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
    },
    [confirmDialog, intl, offPeakCancel, offPeakTaskService],
  );

  const handleOffPeakDelete = useCallback(
    async (task: ZCodeOffPeakTask) => {
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "offPeak.delete.title" }),
        description: intl.formatMessage({ id: "offPeak.delete.description" }),
        confirmLabel: intl.formatMessage({ id: "offPeak.delete.confirm" }),
      });
      if (!confirmed) return;
      await offPeakDelete(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
      // [事务] 只要删除动作返回就离开编辑页，且仅在“正在编辑这条任务”时切换：
      // 删除可能已在服务端生效但响应丢失，继续停留在详情页会让用户对着幽灵对象操作
      // （INV-17）；切换条件限定同一 id，避免误把别的任务编辑页也弹回列表。
      setView((prev) =>
        prev.mode === "offpeak-edit" && prev.task.offPeakTaskId === task.offPeakTaskId
          ? { mode: "list" }
          : prev,
      );
    },
    [confirmDialog, intl, offPeakDelete, offPeakTaskService],
  );

  // [权衡] 清空历史不弹确认：它只删除“已结束的运行记录”，不改变任务本身，
  // 加确认会让高频清理动作变得繁琐；误删的代价也只是丢失历史列表。
  const handleOffPeakDeleteHistory = useCallback(
    async (task: ZCodeOffPeakTask) => {
      await offPeakDeleteHistory(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
    },
    [offPeakDeleteHistory, offPeakTaskService],
  );

  // [事务] 提交入口承担“编辑 / 创建”两种语义，以及创建前的准入检查：
  // 先冻结遥测快照，再校验准入，最后才发请求 —— 顺序颠倒会让被拒的创建丢失归因（INV-22）。
  const handleOffPeakSubmit = useCallback(
    async (input: OffPeakEditSubmit) => {
      const current = view;
      const telemetrySnapshot =
        current.mode === "offpeak-create"
          ? freezeOffPeakCreateTelemetrySnapshot({
              source: current.draft?.telemetrySource,
              model: input.modelSelection.modelId,
              providerId: input.modelSelection.providerId,
            })
          : null;
      if (current.mode !== "offpeak-edit" && offPeakCreateGrey.reason !== null) {
        // [失败路径] 被拒时按 reason 分流提示：plan 走升级漏斗、unavailable 走灰度说明、
        // 其余走额度。三类混成一句会让用户不知道下一步该做什么（INV-23）。
        if (offPeakCreateGrey.reason === "plan") {
          showCodingPlanRequiredToast();
        } else if (offPeakCreateGrey.reason === "unavailable") {
          toast(intl.formatMessage({ id: "offPeak.error.unavailable" }));
        } else {
          toast(offPeakCreateGrey.tooltip ?? intl.formatMessage({ id: "offPeak.error.quota" }));
        }
        if (telemetrySnapshot) {
          void reportOffPeakCreateResult(platform, telemetrySnapshot, {
            ok: false,
            failureStage: "client_validation",
            errorCategory: "client_validation",
            errorCode: "",
            providerName: "",
          });
        }
        return false;
      }
      if (current.mode === "offpeak-edit") {
        // [事务] 编辑分支只提交可修改字段：workspace 与创建时间等身份字段不在入参里，
        // 更新时带上它们会让服务端把“移动任务所属项目”当成一次合法修改。
        const updated = await offPeakUpdate(
          current.task.offPeakTaskId,
          {
            title: input.title,
            prompt: input.prompt,
            permissionMode: input.permissionMode,
            modelSelection: input.modelSelection,
          },
          offPeakTaskService,
        );
        if (!updated) {
          toast(intl.formatMessage({ id: "offPeak.error.generic" }));
        }
        return updated;
      }

      const result =
        telemetrySnapshot !== null
          ? await createAndReportOffPeakTask(platform, telemetrySnapshot, () =>
              offPeakCreate(input, offPeakTaskService),
            )
          : await offPeakCreate(input, offPeakTaskService);
      if (!result.ok) {
        toast(
          intl.formatMessage({
            id: resolveOffPeakCreateErrorMessageId(result),
          }),
        );
      }
      return result.ok;
    },
    [
      intl,
      offPeakCreate,
      offPeakCreateGrey,
      offPeakTaskService,
      offPeakUpdate,
      platform,
      showCodingPlanRequiredToast,
      view,
    ],
  );

  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "automations.noWorkspace" })}
      </div>
    );
  }

  // 闲时任务创建/编辑整页（表单范式）。
  // [事务] editingTask 先从 store 里取最新对象，找不到时才回落到 view 里的快照：
  // 轮询会更新位次与状态，只用快照会让表单展示过期信息，而直接依赖列表又会在
  // 轮询空窗期把表单打回空白。
  if (view.mode === "offpeak-create" || view.mode === "offpeak-edit") {
    const editingTask =
      view.mode === "offpeak-edit"
        ? (offPeakTasks.find((task) => task.offPeakTaskId === view.task.offPeakTaskId) ?? view.task)
        : null;
    return (
      <>
        <OffPeakEditView
          editing={editingTask}
          initialDraft={view.mode === "offpeak-create" ? (view.draft ?? null) : null}
          modelSelectionView={
            offPeakGrayConfig?.modelSelectionView ?? { revision: 0, providers: [] }
          }
          defaultWorkspacePath={workspacePath ?? ""}
          defaultWorkspaceIdentity={workspaceIdentity}
          saving={
            offPeakOperationId?.startsWith("offpeak:create") ||
            offPeakOperationId?.startsWith("offpeak:update") ||
            false
          }
          createBlocked={view.mode === "offpeak-create" && offPeakCreateGrey.reason !== null}
          createBlockedTooltip={offPeakCreateGrey.tooltip}
          onBack={() => setView({ mode: "list" })}
          onSubmit={handleOffPeakSubmit}
          onOpenSession={onOpenSession}
          onDelete={(task) => void handleOffPeakDelete(task)}
          onDeleteHistory={(task) => void handleOffPeakDeleteHistory(task)}
          onPause={(task) => void offPeakPause(task.offPeakTaskId, offPeakTaskService)}
          onContinue={(task) => void offPeakContinue(task.offPeakTaskId, offPeakTaskService)}
          showToast={toast}
        />
      </>
    );
  }

  // 创建/编辑整页(带 Settings/History tab)。
  // [事务] AutomationEditView 的 editing 只在 edit 分支传入，create 分支传 null：
  // 共用组件靠这个 null 区分“插入”与“更新”，传错会让新建覆盖一条已有任务（INV-19）。
  if (view.mode !== "list") {
    return (
      <>
        <AutomationEditView
          editing={view.mode === "edit" ? view.automation : null}
          initialDraft={view.mode === "create" ? view.draft : null}
          defaultWorkspacePath={workspacePath}
          defaultWorkspaceIdentity={workspaceIdentity}
          saving={
            operationId?.startsWith("automation:create") ||
            operationId?.startsWith("automation:update") ||
            false
          }
          onBack={() => setView({ mode: "list" })}
          onSubmit={handleEditSubmit}
          onRunNow={(automation) => handleRunNow(automation, "editor")}
          onToggle={handleToggle}
          onDelete={(automation) => handleDelete(automation, "editor")}
          runsEntry={view.mode === "edit" ? runsCache[view.automation.automationId] : undefined}
          onLoadRuns={() => {
            if (view.mode === "edit")
              void loadRuns(view.automation.automationId, zcodeAgentService, true);
          }}
          onDeleteRun={(runId) => {
            if (view.mode === "edit") {
              void deleteRun(view.automation.automationId, runId, zcodeAgentService);
            }
          }}
          onOpenSession={
            view.mode === "edit" && onOpenSession
              ? (sessionId) => {
                  // 运行历史的跳转入口之前没有从父层接入导航回调，导致即使 run.sessionId
                  // 已经写入 automation_runs，菜单里也会把“跳到会话”隐藏掉。
                  onOpenSession({
                    sessionId,
                    workspacePath: view.automation.workspacePath,
                    workspaceIdentity: view.automation.workspaceIdentity,
                  });
                }
              : undefined
          }
        />
      </>
    );
  }

  // [事务] 页头是“顶级切换 + 动态副标题”的组合，必须在两条返回分支之前构造：
  // 工作流页与自动化页共用同一个 header，各写一份会让两边的切换状态不同步（INV-16）。
  // 页标题即顶级切换：「自动化 / 工作流」两个标题词
  // 并排，30/34 沿用 h1 的页面标题层级；副标题随标签换。
  const pageHeader = (
    <div className="flex flex-col gap-3">
      <AutomationsPageTitle
        workflowTabEnabled={dynamicWorkflowEnabled}
        value={pageTab}
        onValueChange={setPageTab}
      />
      <p className="text-ui-base leading-5 text-foreground-subtlest">
        {intl.formatMessage({
          id:
            pageTab === "workflow"
              ? "workflows.hub.description"
              : hasAnyTasks
                ? "automations.description.populated"
                : "automations.description",
        })}
      </p>
    </div>
  );

  // [事务] 工作流页是“整页替代”而不是叠层：提前 return 可以保证自动化列表的
  // effect 与轮询都仍在运行（它们挂在组件顶层），切换回来时数据是热的。
  if (pageTab === "workflow") {
    return (
      <SavedWorkflowsSection
        header={pageHeader}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        onNavigateToLaunchedRun={onNavigateToLaunchedRun}
        onCreateViaChat={onCreateViaChat}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        openWorkflow={openWorkflow}
        onOpenWorkflowConsumed={onOpenWorkflowConsumed}
      />
    );
  }

  // [事务] 顶栏只在“至少有一条任务”时渲染（visibleTabs 非空）；空态下创建按钮
  // 必须落在大卡内部，两个位置不能同时出现，否则同一动作会有两个入口（INV-20）。
  return (
    <div data-automations-content className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col")}>
      {pageHeader}

      {/* Tab：Scheduled 常驻；Idle 仅在灰度命中或有闲时存量时出现（D31），不再提供 All 混排视图。
         有任务时右上对齐创建（4866-1735）；空态创建入口在大卡内（4889-2013），不重复顶栏按钮。 */}
      {visibleTabs.length > 0 ? (
        <div className="mt-8 flex items-center justify-between">
          {/* 修复原因：tab 曾与右侧操作组共用 12px 间距，未体现最新设计要求的 8px 紧凑节奏。 */}
          <div className="flex items-center gap-2" data-testid={TID_OFFPEAK_TAB}>
            {/* 修复原因：未选中态旧实现强制显示 surface 背景，无法与 hover、选中态形成层级。 */}
            {visibleTabs.map((key) => (
              <button
                key={key}
                // [事务] 顶栏是主导航，必须使用原生 button 以保留 Tab 可达与 Enter 激活；
                // 换成 div + onClick 会让键盘用户完全无法切换视图。
                type="button"
                className={cn(
                  "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                  tab === key
                    ? "bg-selected text-foreground"
                    : "text-foreground-subtle hover:bg-hover hover:text-foreground",
                )}
                // [权衡] 选中态用 bg-selected 而不是主色：主色在深色主题下对比过强，
                // 会把“当前页”渲染成主要操作按钮，用户容易误以为点击会执行动作。
                onClick={() => setTab(key)}
              >
                {intl.formatMessage({ id: `offPeak.tabs.${key}` })}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <ControlHintTooltip
              title={intl.formatMessage({
                id: refreshing ? "automations.refreshing" : "automations.refresh",
              })}
            >
              <Button
                type="button"
                // [权衡] 用 outline 而不是 primary：刷新是低频次要动作，
                // 主色按钮会和“创建任务”争夺视觉焦点，用户反而找不到真正的主动作。
                variant="outline"
                size="icon"
                aria-label={intl.formatMessage({ id: "automations.refresh" })}
                onClick={() => void handleRefresh()}
                // [失败路径] disabled 必须在 refreshing 期间生效：刷新会并发拉三份数据，
                // 连点会让旧请求的结果在稍后覆盖新结果，列表出现回退。
                disabled={refreshing}
              >
                <AutomationRefreshIcon
                  className={cn("size-3.5", refreshing && "animate-spin")}
                  aria-hidden="true"
                />
              </Button>
            </ControlHintTooltip>
            {tab !== "idle" ? (
              <AutomationCreateDropdown
                onViaChat={handleCreateViaChat}
                onManually={handleCreateManually}
              />
            ) : null}
            {showOffPeakTemplates ? (
              <OffPeakCreateButton
                greyReason={offPeakCreateGrey.reason}
                greyTooltip={offPeakCreateGrey.tooltip}
                onCreate={() => setView({ mode: "offpeak-create" })}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 状态筛选：定时 / 闲时共用一组（全部 / 进行中 / 已完成 / 失败），只在当前 tab 有任务时出现。
         样式沿用顶栏 tab 的胶囊，但字号与内边距更小以体现层级。 */}
      {visibleTabs.length > 0 && hasVisibleTaskCards ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-1.5"
          data-testid={TID_AUTOMATIONS_STATUS_FILTER}
        >
          {AUTOMATION_STATUS_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              // [事务] aria-pressed 让屏幕阅读器知道当前筛选：只靠视觉高亮，
              // 视障用户无法判断列表是否被筛选过，会误以为任务真的只剩这几条。
              aria-pressed={statusFilter === key}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-ui-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                statusFilter === key
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover hover:text-foreground",
              )}
              // [事务] 筛选只改 filter 字段并保留 tab：用户是在当前 tab 内做子集筛选，
              // 若连带重置 tab，在 Idle 里换个筛选就会被弹回 Scheduled（INV-6）。
              onClick={() => setStatusFilter(key)}
            >
              {intl.formatMessage({ id: `automations.statusFilter.${key}` })}
            </button>
          ))}
        </div>
      ) : null}

      {loading && automations.length === 0 && offPeakTasks.length === 0 ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-8",
            // 列表态提示栏与 action row 旧间距为 16px，小于设计稿要求的 20px。
            hasAnyTasks ? "mt-5" : "mt-8",
          )}
        >
          <div className="flex w-full flex-col gap-4">
            {/* keep-awake 是全局开关（与设置页「常规」镜像），定时任务运行会话同样受益，
               在定时/闲时两个 tab 都展示。列表态放在任务卡之前，空态保持大空卡在前。 */}
            {hasAnyTasks ? (
              <AutomationKeepAwakeNotice
                // [事务] 默认值取 false 而不是 true：设置尚未加载时按 true 显示，
                // 用户会以为已开启，实际情况相反，长任务被系统休眠打断时才发现。
                checked={sharedSettings?.keepAwakeWhileRunning ?? false}
                // [失败路径] 这里不 await 保存结果：开关需要即时反馈，
                // 保存失败会由下一次设置同步回弹，比让开关卡住更符合预期。
                onChange={(value) =>
                  void updateSharedSettings({
                    keepAwakeWhileRunning: value,
                  })
                }
              />
            ) : null}

            {/* 去掉 All 混排视图后两类任务不再共用统一 grid；保留该锚点标记任务区起点。 */}
            <div data-automations-task-grid className="contents">
              {offPeakVisible && tab !== "scheduled" && offPeakTasks.length > 0 ? (
                <section className="flex w-full flex-col gap-4">
                  {visibleOffPeakTasks.length === 0 ? (
                    <AutomationStatusFilterEmpty />
                  ) : (
                    <OffPeakTaskList
                      tasks={visibleOffPeakTasks}
                      // [并发] busy 直接透传 store 的 operationId，由列表内部按 id 匹配：
                      // 在这里先过滤成布尔数组会让列表无法区分“哪一条”在操作（INV-18）。
                      busyOperationId={offPeakOperationId}
                      onOpen={handleOffPeakOpen}
                      onPause={(task) => void offPeakPause(task.offPeakTaskId, offPeakTaskService)}
                      onContinue={(task) =>
                        void offPeakContinue(task.offPeakTaskId, offPeakTaskService)
                      }
                      onCancel={(task) => void handleOffPeakCancel(task)}
                      onDelete={(task) => void handleOffPeakDelete(task)}
                      onOpenSession={handleOffPeakOpenSession}
                    />
                  )}
                </section>
              ) : null}

              {/* Task created：当前项目已创建的真实定时任务(全部)。点整张卡片进编辑。
                 闲时任务 tab 下整个定时任务区（卡片/空状态/通过对话创建）都不渲染。 */}
              {tab === "idle" ? null : automations.length > 0 ? (
                <section className="flex w-full flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                      {intl.formatMessage({ id: "automations.createdLabel" })}
                    </h2>
                    {/* 无 tab 行时创建入口落在本区标题右侧；有 tab 行时入口已在顶栏，避免重复。 */}
                    {visibleTabs.length === 0 ? (
                      <AutomationCreateDropdown
                        // [权衡] 无 tab 行时入口复用同一个下拉组件而不是另建按钮：
                        // 两个入口若各写一份，限额提示与远端降级逻辑会逐渐分叉（INV-5）。
                        onViaChat={handleCreateViaChat}
                        onManually={handleCreateManually}
                      />
                    ) : null}
                  </div>
                  {visibleAutomations.length === 0 ? (
                    <AutomationStatusFilterEmpty />
                  ) : (
                    <div
                      data-testid={TID_AUTOMATIONS_LIST}
                      className={cn(
                        "grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2",
                        // 设计规范最多露出 8 张卡片；grid 自身负责滚动。阈值按筛选后的数量算，
                        // 否则筛出少量卡片时仍锁高度会留下大块空白。
                        visibleAutomations.length > 8 &&
                          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
                      )}
                    >
                      {visibleAutomations.map((automation) => {
                        // [事务] 状态由 lifecycle + 最近一次 run 共同推导，不能只看 enabled：
                        // paused 但刚失败的任务应显示失败态，否则用户看不到需要处理的问题。
                        const status = resolveAutomationStatusKind(automation);
                        const hasFailure = hasAutomationFailureState(automation);
                        // [失败路径] STATUS_META 的键必须覆盖 resolveAutomationStatusKind 的
                        // 全部返回值；缺一个就会拿到 undefined 并在解构 icon 时整页崩溃。
                        const statusMeta = STATUS_META[status];
                        const StatusIcon = statusMeta.icon;
                        // [事务] 调度摘要与“下次运行”分开求值：摘要是纯 cron 描述，
                        // 任何状态都能显示；nextRunAt 只在活跃且未失败时才有意义。
                        const scheduleText = describeAutomationCardSchedule(automation, intl);
                        // [并发] 这里把 now 作为参数显式传入，而不是让格式化函数自己取
                        // Date.now：列表内 N 张卡片必须共用同一时间基准，否则同一屏里
                        // “3 分钟后”与“2 分钟后”会同时出现。
                        const formattedNextRun = formatAutomationCardNextRun(
                          automation.nextRunAt,
                          now,
                          intl,
                        );
                        // completed/paused/失败态的调度不再推进，但有限次任务跑完后
                        // nextRunAt 仍可能指向未来时刻，曾被拼进卡片误显“下次运行”。只有活跃
                        // 且未失败的卡片才追加下次运行时间，其余一律只展示频率摘要。
                        const scheduleCardText =
                          status === "active" && !hasFailure && formattedNextRun
                            ? `${scheduleText} · ${intl.formatMessage(
                                { id: "automations.nextRun" },
                                { when: formattedNextRun },
                              )}`
                            : scheduleText;
                        // Card 展示的是定时 + 手动派发的累计次数；maxRuns 只约束定时计划，
                        // 若作为分母会让用户误以为“立即运行”也消耗有限任务额度。
                        const runCountText = intl.formatMessage(
                          { id: "automations.runCount" },
                          { count: String(automation.runCount) },
                        );
                        // [并发] 用 endsWith(":id") 匹配而不是等值比较：operationId 形如
                        // automation:toggle:<id>，只比较 id 永远不相等，所有卡片都会静默
                        // 失去加载态；用前缀匹配则任何一个操作都会点亮全部卡片（INV-18）。
                        const busy = operationId?.endsWith(`:${automation.automationId}`) ?? false;
                        // completed 表示有限次任务已经自然结束，不能再通过 Restart 复活；
                        // failed 才是可恢复终态，允许用户手动重排下一次运行。
                        // [失败路径] 两个判断必须来自同一套谓词函数，而不是在这里内联条件：
                        // 卡片与菜单若各自判断，会出现“菜单显示重启但卡片状态不允许”的分裂。
                        const canRestart = canRestartAutomation(automation);
                        const canToggle = canToggleAutomation(automation);
                        // [事务] 整个卡片是 button 语义，点击与 Enter/Space 必须走同一路径：
                        // 只绑 onClick 会让键盘用户无法进入详情（可访问性回归）。
                        return (
                          <div
                            key={automation.automationId}
                            // [事务] role + tabIndex 让整张卡片可聚焦，但真正的语义仍是
                            // “可点击容器”；内部按钮必须 stopPropagation，否则点菜单
                            // 会同时触发进入详情页（见下方操作区的包裹层）。
                            data-testid={TID_AUTOMATION_CARD}
                            role="button"
                            tabIndex={0}
                            onClick={() => setView({ mode: "edit", automation })}
                            onKeyDown={(event) => {
                              // [事务] Space 必须 preventDefault，否则页面同时滚动：
                              // 卡片本身不消费滚动，误触会让用户以为点击丢失。
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setView({ mode: "edit", automation });
                              }
                            }}
                            className={cn(
                              // 任务卡与模板卡曾分别使用 surface/border，跨主题下描边深浅不一致。
                              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                              // 已完成任务保持静态弱化，不在 hover 时恢复透明度或改变背景。
                              status === "completed" ? "opacity-60" : "hover:bg-hover",
                            )}
                          >
                            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
                              <span className="block truncate pr-12 text-ui-base font-medium leading-5 text-foreground">
                                {automation.title}
                              </span>
                              <p className="text-wrap-phrase line-clamp-2 h-10 text-ui-base font-normal leading-5 text-foreground-subtle">
                                {automationPromptSummary(automation.prompt)}
                              </p>
                              <div className="mt-auto flex h-6 min-w-0 items-center gap-2 text-ui-base leading-5">
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  {hasFailure ? (
                                    <>
                                      <span className="inline-flex shrink-0 items-center py-0.5 pl-1 pr-2 font-normal text-destructive">
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <TriangleAlert
                                            className="size-4"
                                            strokeWidth={1.33}
                                            aria-hidden="true"
                                          />
                                        </span>
                                        <span className="pl-1">
                                          {intl.formatMessage({
                                            id: "automations.lifecycle.failed",
                                          })}
                                        </span>
                                      </span>
                                      {/* 失败态也只展示 cron 摘要，禁止把已过期 nextRunAt 误写成“下次运行”。 */}
                                      <span className="inline-flex min-w-0 items-center rounded-md bg-success/10 py-0.5 pl-1 pr-2 font-normal text-success opacity-40">
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <AutomationClockIcon
                                            className="size-4"
                                            aria-hidden="true"
                                          />
                                        </span>
                                        <span className="truncate pl-1">{scheduleCardText}</span>
                                      </span>
                                    </>
                                  ) : status === "active" ? (
                                    <AutomationScheduleBadge
                                      text={scheduleCardText}
                                      icon={
                                        <StatusIcon
                                          className="size-4 shrink-0"
                                          strokeWidth={1.33}
                                          aria-hidden="true"
                                        />
                                      }
                                    />
                                  ) : (
                                    <>
                                      <span
                                        className={cn(
                                          "inline-flex shrink-0 items-center gap-1 font-normal",
                                          statusMeta.className,
                                        )}
                                      >
                                        <span className="flex size-5 shrink-0 items-center justify-center">
                                          <StatusIcon
                                            className="size-4 shrink-0"
                                            strokeWidth={1.33}
                                            aria-hidden="true"
                                          />
                                        </span>
                                        {intl.formatMessage({
                                          id: `automations.lifecycle.${status}`,
                                        })}
                                      </span>
                                      {status === "paused" || status === "completed" ? (
                                        /* 暂停/完成后调度不再推进，只展示 cron 摘要，不展示 nextRunAt。 */
                                        <AutomationScheduleBadge
                                          dimmed
                                          text={scheduleCardText}
                                          icon={
                                            <AutomationClockIcon
                                              className="size-4"
                                              aria-hidden="true"
                                            />
                                          }
                                        />
                                      ) : null}
                                    </>
                                  )}
                                </div>
                                <span
                                  className={cn(
                                    "inline-flex shrink-0 items-center whitespace-nowrap rounded-md bg-surface px-1.5 py-0.5 text-ui-base font-normal text-foreground-subtle",
                                    (hasFailure || status === "paused") && "opacity-40",
                                  )}
                                >
                                  {runCountText}
                                </span>
                              </div>
                            </div>

                            <div className="absolute right-3 top-3 flex items-center gap-1">
                              {busy ? <Spinner className="size-3.5" /> : null}
                              <AutomationActionsMenu
                                // [事务] 菜单只接收当前卡片这一条任务与已算好的布尔量：
                                // 若把整个列表传进去让它自己查，菜单会与卡片列表形成循环依赖。
                                automation={automation}
                                busy={busy}
                                canRestart={canRestart}
                                canToggle={canToggle}
                                onRunNow={handleRunNow}
                                onEdit={(target) => setView({ mode: "edit", automation: target })}
                                onToggle={handleToggle}
                                onRestart={handleRestart}
                                onDelete={handleDelete}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              ) : (
                /* 空状态卡先于 Keep-awake，按钮组整体较卡片中心下移 8px。 */
                <div
                  data-automations-empty-state
                  className="flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4"
                >
                  <div className="flex translate-y-2 flex-col items-center gap-5">
                    <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
                      {intl.formatMessage({ id: "automations.empty.title" })}
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <AutomationCreateDropdown
                        onViaChat={handleCreateViaChat}
                        onManually={handleCreateManually}
                      />
                      {/* 有闲时任务时右上已有创建入口，空卡不再重复（4866-1735 vs 4889-2013）。 */}
                      {offPeakCreationEnabled && offPeakTasks.length === 0 ? (
                        <OffPeakCreateButton
                          greyReason={offPeakCreateGrey.reason}
                          greyTooltip={offPeakCreateGrey.tooltip}
                          onCreate={() => setView({ mode: "offpeak-create" })}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Figma 4798:2443：空态保持唤醒提示条位于大空卡之后。 */}
            {!hasAnyTasks ? (
              <AutomationKeepAwakeNotice
                checked={sharedSettings?.keepAwakeWhileRunning ?? false}
                onChange={(value) =>
                  void updateSharedSettings({
                    keepAwakeWhileRunning: value,
                  })
                }
              />
            ) : null}
          </div>

          {/* 修复原因：真实任务卡与模板此前只靠空白分区，遗漏了 Figma 4835:5515 的分割线；
             分割线使用 surface 在 Light 下过淡，因此与 Card 统一使用 card-border。
             外层 gap-8 加本容器 py-2，使卡片到线、线到模板标题均保持 40px。 */}
          {showTaskTemplateSeparator ? (
            <div
              data-automations-task-template-separator
              className="flex w-full flex-col py-2"
              // [事务] aria-hidden 让分割线不进入无障碍树：它只是视觉分组，
              // 被读屏念出“分隔符”会打断用户对任务区与模板区关系的理解。
              aria-hidden="true"
            >
              <div className="h-px w-full bg-card-border" />
            </div>
          ) : null}

          {/* Idle-time task template（灰度命中；Figma 4889-2013；与 New task 页同源文案 D30-4）。 */}
          {showOffPeakTemplates ? (
            <section
              data-automations-idle-templates
              // [资源] aria-busy 绑定模板目录的加载态而不是整个页面：模板是独立请求，
              // 页面级 busy 会让读屏在任务已可用时仍宣告“正在加载”。
              aria-busy={automationTemplates.loading}
              className="flex w-full flex-col gap-4"
            >
              <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "offPeak.templates.sectionTitle" })}
              </h2>
              {automationTemplates.loading ? (
                <AutomationTemplateSkeletonGrid
                  label={intl.formatMessage({ id: "common.loading" })}
                />
              ) : automationTemplates.offPeak.length === 0 ? (
                <div
                  data-automation-template-empty-state
                  className="flex min-h-[114px] w-full items-center justify-center rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest"
                >
                  {intl.formatMessage({ id: "automations.templates.unavailable" })}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  {automationTemplates.offPeak.map((template) => {
                    // [失败路径] planLocked 在这里求值而不是在 onClick 内部：模板卡可能
                    // 在渲染后经过一次灰度刷新，闭包必须捕获“当前这一刻”的锁定状态，
                    // 否则用户点开的是旧判定下的表单（INV-23）。
                    const planLocked = offPeakCreateGrey.reason === "plan";
                    const card = (
                      <button
                        type="button"
                        // [失败路径] 整个点击处理是同步的，但必须先判锁定再构造草稿：
                        // 顺序反过来会让被拦下的点击已经改写了视图草稿，返回时表单不干净。
                        onClick={() => {
                          // [事务] 锁定判定必须早于任何 draft 构造：先构造再判断会让
                          // “被拦下的点击”也改动视图状态，返回时用户看到表单已填一半。
                          if (planLocked) {
                            showCodingPlanRequiredToast();
                            return;
                          }
                          const materializedDraft = materializeOffPeakTemplateDraft(
                            template,
                            locale,
                          );
                          setView({
                            mode: "offpeak-create",
                            draft: template.customize
                              ? {
                                  telemetrySource: {
                                    eventRegion: "app.automations",
                                    templateId: template.id,
                                  },
                                }
                              : {
                                  title: materializedDraft.title,
                                  prompt: materializedDraft.prompt,
                                  telemetrySource: {
                                    eventRegion: "app.automations",
                                    templateId: template.id,
                                  },
                                },
                          });
                        }}
                        // Grid wrapper 虽已拉伸到行高，卡片本体仍需 h-full 才能继承同一行的最大高度；只设 min-height 时短文案卡会矮一截。
                        className="flex h-full min-h-[114px] w-full flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      >
                        <div className="flex items-center gap-0.5 text-foreground">
                          <OffPeakTemplateIcon
                            className="size-4 shrink-0"
                            iconName={template.iconName}
                            name={template.icon}
                          />
                          <span className="truncate px-1 text-ui-base font-medium leading-5 text-foreground">
                            {resolveOffPeakTemplateText(
                              template,
                              "title",
                              locale,
                              intl.formatMessage,
                            )}
                          </span>
                        </div>
                        <p className="text-wrap-phrase line-clamp-2 flex-1 text-ui-base font-normal leading-5 text-foreground-subtle">
                          {resolveOffPeakTemplateText(
                            template,
                            "description",
                            locale,
                            intl.formatMessage,
                          )}
                        </p>
                        <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                          {intl.formatMessage({
                            id: "offPeak.form.soonestAvailable",
                          })}
                        </div>
                      </button>
                    );
                    return (
                      <div key={template.id} className="h-full">
                        {card}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {/* Scheduled task template：Client Scenes 候选目录；点击只预填新建整页。闲时任务 tab 不显示。 */}
          {showScheduledTemplates ? (
            <section
              data-automations-scheduled-templates
              // [资源] 与闲时模板区各自标记 busy：两块 section 可能一个已缓存、
              // 一个仍在请求，共用页面级状态会让两者同时闪成骨架。
              aria-busy={automationTemplates.loading}
              className="flex w-full flex-col gap-4"
            >
              <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "automations.moreIdeas" })}
              </h2>
              {automationTemplates.loading ? (
                <AutomationTemplateSkeletonGrid
                  label={intl.formatMessage({ id: "common.loading" })}
                />
              ) : automationTemplates.scheduled.length === 0 ? (
                <div
                  data-automation-template-empty-state
                  className="flex min-h-[114px] w-full items-center justify-center rounded-xl border border-card-border bg-background p-3 text-center text-ui-base font-normal text-foreground-subtlest"
                >
                  {intl.formatMessage({ id: "automations.templates.unavailable" })}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {automationTemplates.scheduled.map((template) => {
                    // [事务] 定时模板点击后只预填草稿，不直接创建：模板里的 cron 是建议值，
                    // 用户必须在整页里确认后才落库，避免一次误触产生后台定时任务。
                    return (
                      <button
                        key={template.id}
                        type="button"
                        // [事务] 点击只 materialize 草稿并切到创建页，不直接调用 create：
                        // 模板中的 cron 是建议值，必须经用户确认后才能进入调度（INV-23）。
                        onClick={() => handleUseTemplate(template)}
                        className="group flex min-h-[114px] flex-col gap-2 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      >
                        <div className="flex min-w-0 items-center gap-1 text-foreground">
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <AutomationScheduledTemplateIcon
                              iconName={template.iconName}
                              name={template.icon}
                            />
                          </span>
                          <span className="truncate text-ui-base font-medium leading-5 text-foreground">
                            {resolveAutomationTemplateText(template.title, locale)}
                          </span>
                        </div>
                        {/* Bug 原因：定时模板首次实现时把周期时间拼进标题行，和闲时模板的底部时间层级不一致。 */}
                        <p className="line-clamp-2 flex-1 text-ui-base font-normal leading-5 text-foreground-subtle">
                          {resolveAutomationTemplateText(template.description, locale)}
                        </p>
                        <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                          {describeAutomationCardSchedule({ cronExpr: template.cronExpr }, intl)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
