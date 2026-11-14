/* eslint-disable max-lines -- 定时任务编辑整页集中维护 Settings/History 两个 tab、cron builder、项目/模型选择器与运行历史，集中更利于交互一致。 */
// ============================================================================
// AutomationEditView —— 定时任务「新建 / 编辑」整页
// ============================================================================
// 职责边界：本组件只持有"表单草稿"（draft）。持久化、乐观更新与回滚都由父组件
// onSubmit 完成；运行历史、启停、删除也都是受控回调。凡是"应该写库"的念头都必须
// 落在 onSubmit 上，否则会出现两套写入路径。
//
// INV 不变量表（编号在本文件内唯一）
// INV-01：表单的唯一真相是 React state；ref 只做"同一事件内跨闭包读取"的镜像
//         （modelSelection/modeRef/thoughtLevelRef/saveAndRunPendingRef）。
//         写入时必须 state 与 ref 同步改，只改一个就会出现提交值滞后一轮。
//         （守住它的位置：handleModelValueChange / ConfigSelect.onValueChange）
// INV-02：dirty 判定只认"用户实际触碰过的字段"。仅打开页面时异步归一化的
//         model/cron builder 不得计入，否则"打开即脏"会拦住正常返回。
//         （守住它的位置：changedFields / touchedFields）
// INV-03：touchedFieldBaselinesRef 记录字段"首次被触碰那一刻"的签名，而不是初始值：
//         先改后改回、或先由异步归一化再被用户编辑，比较基准都必须是首次触碰时的值。
//         （守住它的位置：markFieldTouched）
// INV-04：编辑态的首帧 builder 必须直接用持久化的真实 cron/scheduleRule，
//         不允许"先渲染默认 09:00、再由 effect 回填"。首帧默认值会被子控件的
//         register 回调记成 dirty baseline，让所有编辑态一打开就是脏的。
//         （守住它的位置：useState(() => initialBuilder(...))）
// INV-05：模型与思考档位必须以 ref 为准做提交校验：权限下拉与保存按钮是独立控件，
//         快速"选完立刻保存"时 state 尚未刷新到闭包，ref 才能给出最后一次选择。
//         （守住它的位置：submitAutomation 的 modelSelection.current 比较）
// INV-06：切换目标项目必须清空模型与档位选择：模型候选按 Host 作用域解析，
//         保留上一个项目的选择会让提交带一个目标 Host 不存在的 provider/model。
//         （守住它的位置：handleSelectProject）
// INV-07：编辑态 workspace 锁定为任务所属项目（不可改整个项目），新建态必须收敛到
//         当前有效候选；没有有效候选时 selectedWorkspace 为 null 且禁止提交。
//         （守住它的位置：workspaceOptions / hasValidWorkspace）
// INV-08：cronExpr 有三种来源且优先级固定：已删除 → 空串；会话来源且不可回显 →
//         原样保留；其余 → 由 builder 重新生成。三者互斥，混用会写出与 UI
//         不一致的表达式。（守住它的位置：cronExpr useMemo）
// INV-09：scheduleRemoved 只表达"用户删掉了日程"，必须在用户重新选择频率
//         （任意入口）时同步复位，并清掉 schedule 的必填错误，否则会出现
//         "已有日程但仍标红"。（守住它的位置：Select/Dropdown 的 onValueChange）
// INV-10：提交顺序是 必填校验 → canSubmit → 防旧 View → StartPlan 确认 →
//         onSubmit → onBack。任何一步提前都会产生"校验没过就发请求"或
//         "保存失败却已经离开页面"。（守住它的位置：submitAutomation）
// INV-11：本组件不做乐观更新，也不持有回滚逻辑：onSubmit 返回 false 时保持当前页
//         与表单内容，只有 onBack 才是"成功后的离开"。本地回滚会与父组件的
//         乐观缓存冲突，形成两份互相覆盖的真相。
// INV-12：保存并运行必须防重入（ref + state 双份）：ref 挡住同一 tick 的第二次点击，
//         state 负责禁用按钮。只用 state 会在双击的第二个事件里读到旧渲染值。
//         （守住它的位置：handleSaveAndRun）
// INV-13：保存并运行是"先保存成功、再触发运行"，保存失败绝不运行。反过来会
//         启动一个用旧配置的任务，用户看到的运行结果与刚改的表单不符。
// INV-14：未保存离开保护只在"编辑态 + changedFields 非空"时生效；新建态没有
//         可回滚的持久对象，弹确认框反而是噪声。
//         （守住它的位置：handleBackClick）
// INV-15：运行历史是客户端分页：数据整份已加载，页码只做切片。删除/刷新导致
//         总页数变小时必须把当前页收敛到有效范围，否则会渲染空白页。
//         （守住它的位置：runsCurrentPage = min(runsPage, runsTotalPages)）
// INV-16：历史轮询的 effect 依赖只允许 tab 与 automationId：onLoadRuns 由父组件
//         inline 传入，作为依赖会在每次 runsCache 更新时重启 effect，形成请求风暴。
//         （守住它的位置：onLoadRunsRef + 5s interval）
// INV-17：模型/思考候选来自"目标 Host"的 services：远程未连接时保持 unavailable，
//         本地空项目直接读同 Host 目录。禁止为了预览去创建 deferred session。
//         （守住它的位置：useWorkspaceServicesResolution / useModelSelectionServiceView）
// INV-18：unavailable / error 态一律不可提交：submissionContextReady 要求
//         status === "ready"、selectedModelItem 非空、reasoningLevel 非空且无
//         selectionIssue。放宽任何一项都会让用户提交一个无法执行的配置。
// INV-19：自定义重复的输入框允许空串（便于编辑），但可调度值必须是 >=1 的整数；
//         cron 步长为 0 不会触发，却会被持久化成一个"永不执行"的任务。
//         （守住它的位置：isIntervalValid / CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN）
// INV-20：endAt 的三态必须区分：undefined = 不结束；数字 = 指定结束时间；
//         编辑态显式清除时传 null。混用会让"清除结束时间"退化成"不做修改"。
//         （守住它的位置：buildSubmitInput 的 endAt 展开）
// INV-21：会话内创建、且 cron 无法被可视化回显的任务，日程区只读；只有用户显式
//         编辑过 schedule 才写 scheduleEditedByUser 并退出只读。
//         （守住它的位置：preserveSessionCreatedSchedule）
// INV-22：终态任务（completed/failed）不提供 pause/resume：对终态 resume 等价于
//         复活一个已结束的任务，与"改存即复活"的产品语义冲突。
// INV-23：思考档位必须随模型重新解析：切模型时清空用户手改标记并按新模型的
//         Option Specs 重新初始化最高档；切档位则把"当前显示的模型"固化为新意图。
//         （守住它的位置：handleModelValueChange / ThoughtLevelCycleControl）
// INV-24：模型失效提示必须去重：key 由 automationId + modelSelectionView.revision
//         组成，避免每次 View 刷新都弹一次同样的 toast。
// INV-25：CustomRepeatDialog 的本地草稿只在打开时从 builder 重置：关闭期间父级
//         builder 变化不能污染已关闭的对话框状态，否则下次打开会短暂闪出旧值。
// INV-26：时间/数字滚动列只在挂载时滚动一次到选中项：每次渲染都 scrollIntoView
//         会让用户手动滚动时被持续拽回。
// INV-27：结束日期选择器的最小可选日为"今天"；切月后当前日超过该月天数时必须
//         收敛到月末，否则会构造出 2 月 31 日这类非法日期。
// INV-28：每周/每月多选不允许清空最后一个选项：空集合会让 cron 的星期/日字段
//         变成非法表达式，任务直接静默不触发。
// INV-29：状态徽标的颜色与文案都必须来自同一份映射表（RunStatusKind /
//         AutomationStatusKind），散落的条件分支会让同一个状态在不同位置变色。
// INV-30：dirty 签名必须可稳定序列化：schedule 用固定字段顺序的 JSON.stringify，
//         并先把 scheduleRule 归一化（缺省值补齐）。直接 stringify 原始对象会因
//         字段顺序或 undefined 差异产生"没改也判脏"。
// INV-31：buildSubmitInput 在缺少有效选择时抛错而不是返回空对象：这是编程错误的
//         快速失败，空对象会让持久层写出一条不可执行的自动化。
// INV-32：提交边界必须二次校验 target：按钮禁用挡不住快捷键与异步回调，
//         无有效项目的新建请求一律拒绝。
// INV-33：startUserAction 的 trace 必须严格闭环（complete/reject/fail 各一次）：
//         漏掉会让埋点里的任务生命周期永远停在 started。
// INV-34：自定义重复对话框的"结束"开关与 endDate 分离：关闭结束开关不覆盖已选日期，
//         重新打开时可以恢复用户上次的选择（INV-25 的重置依据）。
// ============================================================================
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { completeNewModelSelection } from "@zcode/provider";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  MessageCircle,
  X,
} from "lucide-react";
import {
  ZCODE_AGENT_PROVIDER,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationScheduleRule,
} from "@zcode/shared";
import {
  testId,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_CUSTOM_UNIT_OPTION,
  TID_AUTOMATION_CUSTOM_UNIT_SELECT,
  TID_AUTOMATION_FORM_PROMPT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_FREQUENCY_SELECT,
  TID_AUTOMATION_RUN_NOW,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_DELETE,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATION_YEAR_DAY_OPTION,
  TID_AUTOMATION_YEAR_MONTH_OPTION,
  TID_AUTOMATION_YEAR_MONTHDAY,
} from "@zcode/shared/test-ids";
import {
  AutomationAddScheduleIcon,
  AutomationChevronDownIcon,
  AutomationContinueIcon,
  AutomationExternalLinkIcon,
  AUTOMATION_FORM_FIELD_CLASSNAME,
  AutomationHistoryEmptyState,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationRunNowIcon,
  AutomationSettingsHistoryTabs,
  AutomationTrashIcon,
  type AutomationSettingsHistoryTab,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
  AutomationInstructionsComposer,
  AutomationInstructionsTextarea,
  AutomationInstructionsToolbar,
} from "@/settings/AutomationInstructionsComposer.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { cn } from "@/components/lib/utils.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { resolveLocalizedAutomationCreateTitle } from "@/settings/automationEditLocalizedTitle.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import {
  AUTOMATION_DEFAULT_MODE,
  buildAutomationModelSelectGroups,
  buildAutomationModeOption,
  buildAutomationThoughtLevelOption,
  resolveAutomationModelItem,
  resolveAutomationModelTriggerLabel,
  resolveAutomationPreferredModelValue,
} from "@/settings/automationAgentConfigOptions.js";
import {
  resolveChangedAutomationEditFields,
  type AutomationEditDirtyField,
  type AutomationEditFieldSignatures,
} from "@/settings/automationEditDirtyState.js";
import {
  clearAutomationEditRequiredFieldError,
  resolveAutomationEditRequiredFieldErrors,
  type AutomationEditRequiredField,
} from "@/settings/automationEditValidation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useAutomationProjectOptions } from "@/hooks/useAutomationProjectOptions.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import {
  buildCronExpr,
  canVisualizeCronInAutomationEditor,
  describeCronBuilder,
  formatDateTime,
  formatDuration,
  formatGmtOffset,
  isSessionCreatedAutomation as resolveIsSessionCreatedAutomation,
  parseCronToBuilder,
  resolveAutomationStatusKind,
  WEEKDAY_ORDER,
  type AutomationStatusKind,
  type CronBuilderState,
  type CronFrequency,
  type CustomRepeatUnit,
} from "@/settings/automationFormat.js";
import type {
  AutomationRunsEntry,
  CreateAutomationInput,
  UpdateAutomationInput,
} from "@/store/automationManagementStore.js";

// [权衡] 用常量函数而不是内联 arrow 传给 ModelConfigSelect：该 prop 会参与子组件的
// memo 比较，内联写法每次渲染都产生新引用，导致下拉整棵树重渲染。
const MODEL_ITEM_NEVER_LOCKED = () => false;
// [事务] FREQUENCIES 的顺序就是菜单展示顺序，也是 isCronFrequency 的白名单；
// 两处共用同一数组，新增频率只需改这里（下拉与校验自动同步）。
const FREQUENCIES: CronFrequency[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];
// [失败路径] Radix Select 在"编辑旧 cron 的控件注册阶段"可能发出空字符串，直接
// 用 `as CronFrequency` 断言会让 builder.frequency 变成 ""，进而 buildCronExpr
// 产出一条非法表达式。此守卫是唯一挡住该路径的地方（见 Schedule Select 的告警日志）。
const isCronFrequency = (value: string): value is CronFrequency =>
  FREQUENCIES.includes(value as CronFrequency);
/** 运行历史每页条数。 */
const RUNS_PAGE_SIZE = 8;
/** 自定义重复频率输入允许输入的视觉范围。 */
const CUSTOM_REPEAT_INTERVAL_INPUT_MIN = 0;
/** cron 的步长必须为正整数，0 不能形成有效调度。 */
const CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN = 1;
// [权衡] 视觉范围（0..200）与可调度下限（1）必须分开：输入框允许落到 0 是为了
// 让用户能"退格后重新输入"，但 0 不能进入 cron，因此校验用的是 SCHEDULABLE_MIN。
// 合成一个常量会让输入框在 0 时立刻判非法，光标体验变差。
const CUSTOM_REPEAT_INTERVAL_MAX = 200;

// [性能] 页码序列是纯函数，渲染时直接调用即可，不需要 useMemo：入参只有两个数字，
// 计算量是常数级，缓存反而增加依赖比较成本。
// [失败路径] total<=7 走全量分支而不是让通用算法处理：通用分支的"首尾各 3 页"
// 在总页数很少时会生成 "1,2,3,…,5,6,7" 这种省略号无意义的序列。
/**
 * 生成分页控件的页码序列：首尾各保留 3 页、当前页左右各 1 页，其余用省略号折叠。
 * 例：current=1,total=10 → [1,2,3,"ellipsis",8,9,10]。
 */
function buildRunsPageItems(current: number, total: number): Array<number | "ellipsis"> {
  // [权衡] 7 页以内全列：此时首尾各 3 页已经覆盖全部页码，再插省略号只是噪声。
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  // [事务] 用 Set 而不是拼接数组：当前页可能落在首尾 3 页之内（例如 current=2），
  // 直接拼接会产生重复页码，导致 React key 冲突。
  const pages = new Set<number>([
    1,
    2,
    3,
    total - 2,
    total - 1,
    total,
    current - 1,
    current,
    current + 1,
  ]);
  // [失败路径] 过滤 + 排序必须在展开之后：Set 的插入顺序不是页码顺序，
  // 直接遍历会让分页器出现 "1,2,3,8,10,…" 这种乱序。
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];
  let previous = 0;
  // [事务] 省略号只在"页码不连续"时插入（page - previous > 1）：这是唯一能保证
  // 序号与省略号交替正确的判据，按索引奇偶判断会在首尾覆盖时出错。
  for (const page of sorted) {
    if (previous && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
    previous = page;
  }
  return items;
}

// [权衡] 先归一化反斜杠再按 "/" 切分：Windows 路径同时支持 \ 与 /，只按一种切在
// 混合分隔符时会把 "C:\a/b" 整段当成名字。
// [失败路径] 切完为空（例如根目录 "/"）时回落到原串，避免标签变成空白导致行高塌陷。
function workspaceLabelFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

// [权衡] 时间列统一两位数展示（即使 0..9），避免列表滚动时左侧数字宽度抖动。
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// [权衡] 下拉宽度绑到 trigger 宽度（--radix-select-trigger-width）并隐藏滚动按钮：
// 自定义重复的单位下拉只有 6 项，滚动按钮在鼠标环境里是纯噪声，且会让 popper
// 多出一行高度、与左侧输入框错位。
const CUSTOM_REPEAT_SELECT_CONTENT_CLASS =
  "w-[var(--radix-select-trigger-width)] px-0 py-1.5 [&_[data-position=popper]]:px-1 [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden";
// [失败路径] 选中态用 data-[state=checked] 而不是 aria-selected 样式：Radix 的
// 选中项与高亮项是两个状态，只写 highlighted 会在键盘导航时看不出"已选中"。
const CUSTOM_REPEAT_SELECT_ITEM_CLASS =
  "min-h-8 rounded-[8px] px-2 py-1.5 pr-8 text-ui-base leading-5 text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-[state=checked]:bg-menu-hover data-[state=checked]:text-foreground";

// [权衡] 指示器单独抽组件而不是内联 JSX：SelectTrigger 的 indicator 插槽每次渲染
// 都会重新挂载子节点，抽成稳定组件可避免 chevron 掉帧闪烁。
function CustomRepeatSelectIndicator() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
      <ChevronDown className="size-4" strokeWidth={2} />
    </span>
  );
}

// [权衡] 图标组件只为统一 strokeWidth=2：直接写 <CalendarDays /> 会在不同调用点
// 继承不同的粗细，与设计稿的 6px glyph 规格冲突。
function CustomRepeatCalendarIcon({ className }: { className?: string }) {
  return <CalendarDays className={className} strokeWidth={2} />;
}

/**
 * 时间选择的单列滚动列表（小时或分钟），选中项打开时自动滚动到可见位置。
 * 时间选项属于常用交互控件，不应沿用仅用于徽标和紧凑标签的最小字号 token。
 * 已选时间属于菜单选中态，不是主操作按钮；使用菜单 hover 语义避免 Light 主题下出现突兀黑块。
 */
// [资源] selectedRef 只挂在当前选中项上，因此"滚动到可见"只会作用于一项；
// 空依赖数组保证只在挂载时执行一次（INV-26）：每次打开 popper 都重新挂载，
// 天然获得"打开即定位"的效果，同时不会在用户滚动时把视口拽回。
// [失败路径] 用可选链而不是判空分支：count 为 0 时没有任何按钮挂 ref，
// 这里静默跳过即可，不需要额外状态。
function TimeUnitColumn({
  count,
  selected,
  onSelect,
}: {
  count: number;
  selected: number;
  onSelect: (value: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {Array.from({ length: count }, (_, value) => value).map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-base tabular-nums transition-colors",
              value === selected
                ? "bg-menu-hover text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 * HH:MM 时间选择器：一个 pill 触发器 + 弹层内小时/分钟两列滚动选择。
 * 时间选择触发器属于常用交互控件，应使用正文基准字号 text-ui-base。
 */
// [事务] 两列共用同一个 onChange(hour, minute) 契约：任一侧改动都必须带上另一侧
// 的当前值，否则父组件需要自己合并两次更新，会出现"改小时把分钟重置"的竞态。
// [权衡] 弹层宽度写死 w-29（两列 14 + 分隔线）：用自适应宽度时两列在滚动条出现
// 后会互相挤压，选中项抖动。
function TimeOfDayPicker({
  hour,
  minute,
  onChange,
  ariaLabel,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          // [权衡] 用 tabular-nums + 固定两列补零（原注释提到的时间格式稳定性）：
          // 数字等宽才能让 "09:05" 与 "11:50" 宽度一致，触发器不会随分钟跳动。
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {pad2(hour)}:{pad2(minute)}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <TimeUnitColumn count={24} selected={hour} onSelect={(value) => onChange(value, minute)} />
        <div className="w-px shrink-0 bg-border" />
        <TimeUnitColumn count={60} selected={minute} onSelect={(value) => onChange(hour, value)} />
      </PopoverContent>
    </Popover>
  );
}

/** 月/日单列滚动列表（1-based 值），样式对齐 TimeUnitColumn。 */
// [权衡] 与 TimeUnitColumn 的差异只在"值集合由外部给定"（月份 1..12、天数按当月）：
// 因此不复用同一个组件加 mode，避免把 24/60 的固定语义也变成参数。
// [事务] buttonTestIdPrefix 用于 e2e 精确定位某一天：日期按钮是纯数字，没有稳定
// 文本可断言，必须带 testid（见下方 `${prefix}-${value}` 注释）。
function ScrollNumberColumn({
  values,
  selected,
  onSelect,
  buttonTestIdPrefix,
}: {
  values: number[];
  selected: number;
  onSelect: (value: number) => void;
  /** 提供时每个数字按钮带 `${prefix}-${value}` 的 data-testid（e2e 用）。 */
  buttonTestIdPrefix?: string;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  // [并发] 与 TimeUnitColumn 相同的"仅挂载时定位"策略（INV-26）：日期列的选项数量
  // 会随月份变化，但重新挂载只发生在弹层重新打开，不会在切月时把视口拽走。
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <ScrollArea className="h-52 w-14 shrink-0">
      <div className="flex flex-col gap-0.5 p-1">
        {values.map((value) => (
          <button
            key={value}
            ref={value === selected ? selectedRef : undefined}
            type="button"
            data-testid={buttonTestIdPrefix ? testId(buttonTestIdPrefix, String(value)) : undefined}
            onClick={() => onSelect(value)}
            className={cn(
              "rounded-md px-2 py-1 text-center text-ui-sm tabular-nums transition-colors",
              value === selected
                ? "bg-primary text-primary-foreground"
                : "text-foreground-subtle hover:bg-surface-hover",
            )}
          >
            {pad2(value)}
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

/** 某月天数（用闰年 2024 作参照，使 2 月可选到 29）；month 为 1-12。 */
// [权衡] 用闰年 2024 作参照，使 2 月永远可选到 29 号：若按当前年份计算，
// 用户在 1 月选 29 号、切到 2 月时选项会突然消失；统一按闰年给满，
// 真正的非法日期由 cron 语义与月份天数在下一次切月时收敛（见 MonthDayPicker）。
// [失败路径] month 传 0 会得到 1 月末（Date 的月份从 0 开始），调用方必须传 1..12。
function daysInMonth(month: number): number {
  return new Date(2024, month, 0).getDate();
}

/**
 * 月/日选择器（custom → yearly 用）：一个 pill 触发器 + 弹层内月/日两列滚动选择，
 * 样式与 TimeOfDayPicker 对齐。切月后当前日超过该月最大天数时自动收敛。
 */
// [事务] 切月时用 Math.min(day, daysInMonth(value)) 收敛（INV-27）：不收敛会在
// 2 月留下 31 号，cron 表达式虽然合法但下一次触发要等到 3 月，用户会认为任务"没生效"。
// [失败路径] days 由 month 派生而不是独立 state：两者同步更新可避免"月份已变、
// 日期列表还是上月"的中间渲染。
function MonthDayPicker({
  month,
  day,
  intl,
  onChange,
}: {
  month: number;
  day: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onChange: (month: number, day: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // [事务] months/days 是纯派生数组，不需要 state：它们完全由 props 决定，
  // 放进 state 会引入"props 变了但列表没更新"的第二份真相。
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  // [失败路径] days 依赖 month 重新计算（INV-27）：固定 31 天会让 2 月出现 30/31 号
  // 选项，用户点选后 cron 合法但永不触发。
  const days = Array.from({ length: daysInMonth(month) }, (_, index) => index + 1);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={TID_AUTOMATION_YEAR_MONTHDAY}
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.yearDateLabel",
          })}
          className="inline-flex h-auto items-center gap-1 rounded-full bg-hover py-px pl-2 pr-1.5 text-ui-base leading-5 tabular-nums text-foreground transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {intl.formatMessage(
            { id: "automations.form.schedule.monthDayValue" },
            { month: String(month), day: String(day) },
          )}
          <span className="shrink-0 text-foreground-subtle">
            <AutomationChevronDownIcon />
          </span>
        </button>
      </PopoverTrigger>
      {/* 与 TimeOfDayPicker 一致：flex-row 覆盖 PopoverContent 默认的 flex-col，月/日两列并排。 */}
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-29 flex-row gap-0 p-0"
      >
        <ScrollNumberColumn
          values={months}
          selected={month}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_MONTH_OPTION}
          onSelect={(value) => onChange(value, Math.min(day, daysInMonth(value)))}
        />
        <div className="w-px shrink-0 bg-border" />
        <ScrollNumberColumn
          values={days}
          selected={day}
          buttonTestIdPrefix={TID_AUTOMATION_YEAR_DAY_OPTION}
          onSelect={(value) => onChange(month, value)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** 每周日期选择：保持语句式 trigger，并禁止清空最后一个日期。 */
// [事务] label 按 WEEKDAY_ORDER 排序后再 join，而不是按 weekdays 的选择顺序：
// 用户点选顺序不同会让同一组日期显示成不同文案，视觉上像"配置变了"。
// [失败路径] 空数组时 label 为空串，trigger 会塌成只有一个箭头——但 WeekdayPicker
// 与 CustomRepeatDialog 都会阻止清空最后一个日期（INV-28），该状态不可达。
function WeekdayPicker({
  weekdays,
  intl,
  onChange,
}: {
  weekdays: number[];
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onChange: (weekdays: number[]) => void;
}) {
  // [事务] label 与 weekdays 同源派生，不缓存（INV-28 的展示侧）：weekdays 变短时
  // label 必须同步变短，useMemo 会让多语言切换后仍显示旧语言。
  const label = WEEKDAY_ORDER.filter((day) => weekdays.includes(day))
    .map((day) => intl.formatMessage({ id: `automations.weekday.${day}` }))
    .join(intl.formatMessage({ id: "automations.weekday.separator" }));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "automations.form.schedule.weekdaysLabel",
          })}
          // 星期多选 trigger 与同层频率、时间 tag 使用相同高亮，避免亮度不一致。
          className="inline-flex h-auto max-w-full items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground transition-colors hover:bg-selected data-[state=open]:bg-selected focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          <span className="truncate">{label}</span>
          <AutomationChevronDownIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-40 p-1">
        {WEEKDAY_ORDER.map((day) => {
          // [事务] active 用 includes 判定而不是索引：WEEKDAY_ORDER 是展示顺序，
          // weekdays 是"已选集合"，两者顺序无关（见上方的 label 排序说明）。
          const active = weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => {
                if (active && weekdays.length === 1) return;
                onChange(
                  active ? weekdays.filter((candidate) => candidate !== day) : [...weekdays, day],
                );
              }}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui-base text-foreground transition-colors hover:bg-menu-hover"
            >
              {/* Bug 原因：勾选位放在行首会让星期菜单偏离标准的尾部状态布局。 */}
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage({ id: `automations.weekday.${day}` })}
              </span>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

// [权衡] 无值时默认给"明天"而不是今天：结束日期是"从今天起至少还剩一天"的语义，
// 默认今天会让用户一打开就处在边界上，稍不留神就选到一个已过期的时间。
// [失败路径] 用本地时间构造而不是 toISOString：后者是 UTC，东八区在 00:00-08:00
// 之间会得到昨天的日期，用户看到"最小可选日"比今天早一天。
function toDateInputValue(timestamp: number | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date(Date.now() + 24 * 60 * 60 * 1_000);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// [事务] 显式构造 23:59:59.999 而不是依赖 Date 解析 "YYYY-MM-DD"：后者按 UTC
// 解析，东八区会得到当天 08:00，导致"结束日当天"的任务提前 16 小时停跑。
// [失败路径] 正则不匹配或非法日期返回 undefined，让按钮的 disabled 判定生效；
// 抛错会让输入过程中的空串直接崩掉整页。
function localDateEndTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

// [失败路径] 返回 null 而不是 Invalid Date：Invalid Date 参与 `<` 比较恒为 false，
// 会让"结束日期早于最小可选日"的校验整体失效（日历仍可点选过期日期）。
function parseDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

// [事务] visibleMonth 是"当前浏览的月"，与 value（已选日期）分离：翻月不应改变
// 已选值，否则用户翻两页看日期就会把选择改掉。
// [并发] 打开时用 effect 把 visibleMonth 重置到已选日期（INV-26 的同类约束）：
// 依赖只放 open 与选中日的时间戳，避免每次渲染都重设导致无法翻月。
function EndDatePicker({
  disabled,
  intl,
  min,
  onChange,
  value,
}: {
  disabled: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  min: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  // [事务] 三个解析结果都来自 props，每帧重算：它们只用于渲染，不参与提交，
  // 因此不需要 state（否则会出现"props 更新但日历停在旧月"的第二份真相）。
  const selectedDate = parseDateInputValue(value);
  const minDate = parseDateInputValue(min);
  // [并发] 初始月优先取已选日期，其次最小可选日，最后今天：三者都为空时才退到 now，
  // 保证首次打开一定落在"用户可能关心的月份"而不是很久以前。
  const [visibleMonth, setVisibleMonth] = useState(() => selectedDate ?? minDate ?? new Date());

  useEffect(() => {
    if (open && selectedDate) setVisibleMonth(selectedDate);
  }, [open, selectedDate?.getTime()]);

  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  // [事务] firstWeekday 决定首行补几个空格（周日=0）：用 getDay() 而不是
  // "周一开始"的换算，因为表头渲染顺序就是 0..6，两者必须同一套基准。
  const firstWeekday = new Date(year, month, 1).getDay();
  // [失败路径] "下个月第 0 天"是当月最后一天这一写法依赖 JS 的日期回绕：
  // new Date(y, m+1, 0) 在 m=11 时会跨年到次年 1 月 0 日，仍然正确，不要改成 m+2。
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // [权衡] todayValue 每次渲染重算而不是 useMemo：跨午夜时页面若一直开着，
  // 缓存值会让"今天"的高亮停在昨天。重算成本只有一次字符串拼接。
  const todayValue = toDateInputValue(Date.now());
  const monthLabel = intl.formatMessage(
    { id: "automations.customRepeat.monthLabel" },
    { year: String(year), month: String(month + 1) },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-9 w-[135px] items-center justify-center gap-1.5 rounded-lg border border-input-border bg-input pl-3 pr-3.5 text-ui-base font-normal leading-5 tracking-[-0.18px] text-foreground transition-colors hover:border-input-border-hover hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-input-border disabled:hover:bg-input"
        >
          <CustomRepeatCalendarIcon className="size-5 shrink-0 text-foreground-subtle" />
          <span className="tabular-nums">
            {selectedDate
              ? `${selectedDate.getFullYear()}/${pad2(selectedDate.getMonth() + 1)}/${pad2(selectedDate.getDate())}`
              : value}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-3">
        <div className="mb-3 flex h-8 items-center justify-between">
          <span className="text-ui-sm font-medium text-foreground">{monthLabel}</span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month - 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.previousMonth",
              })}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisibleMonth(new Date(year, month + 1, 1))}
              aria-label={intl.formatMessage({
                id: "automations.customRepeat.nextMonth",
              })}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <span
              key={day}
              className="flex size-8 items-center justify-center text-ui-sm text-foreground-subtlest"
            >
              {intl.formatMessage({ id: `automations.weekday.${day}` })}
            </span>
          ))}
          {Array.from({ length: firstWeekday }, (_, index) => (
            <span key={`blank-${index}`} className="size-8" />
          ))}
          {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => {
            // [事务] dateValue 必须用补零后的本地值拼装：它同时与 value（受控 props）
            // 和 min（字符串下限）比较，格式不一致会让"相等"判定永远失败。
            const dateValue = `${year}-${pad2(month + 1)}-${pad2(day)}`;
            const selected = dateValue === value;
            const isToday = dateValue === todayValue;
            // [失败路径] 用字典序比较日期（YYYY-MM-DD 有序）：解析成 Date 再比较
            // 会引入时区偏移，导致"今天"在 UTC 负偏移时被误判为不可选。
            const unavailable = dateValue < min;
            return (
              <button
                key={day}
                type="button"
                disabled={unavailable}
                onClick={() => {
                  onChange(dateValue);
                  setOpen(false);
                }}
                className={cn(
                  "flex size-8 items-center justify-center rounded-[8px] text-ui-base tabular-nums transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-menu-hover",
                  isToday && !selected && "ring-1 ring-inset ring-border-hover",
                  unavailable && "cursor-not-allowed text-foreground-subtlest opacity-35",
                )}
              >
                {day}
              </button>
            );
          })}
          {Array.from({ length: 42 - firstWeekday - daysInMonth }, (_, index) => (
            <span key={`trailing-blank-${index}`} className="size-8" />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CustomRepeatDialog({
  builder,
  endAt,
  intl,
  onConfirm,
  onOpenChange,
  open,
}: {
  builder: CronBuilderState;
  endAt: number | undefined;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onConfirm: (value: {
    interval: number;
    unit: CustomRepeatUnit;
    weekdays: number[];
    monthDays: number[];
    monthlyMode: CronBuilderState["customMonthlyMode"];
    endAt?: number;
  }) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  // [事务] 对话框内部持有一份完整草稿副本，而不是直接受控于 builder：确认前的所有
  // 改动都不能泄漏到父表单（否则用户点"取消"后日程已经被改掉了）。
  // [失败路径] 每个字段单独 useState 而不是一个对象：合并对象更新会强制所有字段
  // 同一 tick 渲染，输入框在连续输入时会丢字符。
  const [intervalInput, setIntervalInput] = useState(String(builder.customInterval));
  const [unit, setUnit] = useState<CustomRepeatUnit>(builder.customUnit);
  const [weekdays, setWeekdays] = useState(builder.customWeekdays);
  const [monthDays, setMonthDays] = useState(builder.customMonthDays);
  const [monthlyMode, setMonthlyMode] = useState(builder.customMonthlyMode);
  // [事务] ends 与 endDate 分离（INV-34）：关闭"结束"开关不清空已选日期，
  // 重新打开时能恢复用户上次的选择；合并成一个值会让"关掉再打开"丢失日期。
  const [ends, setEnds] = useState(endAt !== undefined);
  // [失败路径] endDate 的初值用 toDateInputValue(endAt)：endAt 为 undefined 时
  // 得到"明天"，保证用户第一次勾选结束时有一个合法默认值（见该函数注释）。
  const [endDate, setEndDate] = useState(toDateInputValue(endAt));

  // [并发] 只在 open 时重置（INV-25）：关闭状态下父级 builder 变化（例如外部
  // 重新解析 cron）不应改动已关闭对话框的草稿，否则下次打开会先闪一帧旧值。
  // [失败路径] 直接落地到各个 setState 而不是"先比较再设"：这些值只在打开瞬间
  // 同步一次，跳过比较可避免 builder 引用变化时的额外渲染。
  useEffect(() => {
    if (!open) return;
    setIntervalInput(String(builder.customInterval));
    setUnit(builder.customUnit);
    setWeekdays(builder.customWeekdays);
    setMonthDays(builder.customMonthDays);
    setMonthlyMode(builder.customMonthlyMode);
    setEnds(endAt !== undefined);
    setEndDate(toDateInputValue(endAt));
  }, [builder, endAt, open]);

  // [事务] 校验用正则 + 数值双重判定：正则挡住 "1.5"/"1e3"/"-1"，数值范围挡住
  // 0 与超上限。只做 Number() 会把 " 12 " 也接受，而这类值写进 cron 会变成非法步长。
  // [失败路径] intervalInput 为空串时 Number("") === 0，必须靠 /^\d+$/ 先判否，
  // 否则空输入会被当成 0 并允许确认（INV-19）。
  const interval = Number(intervalInput);
  const isIntervalValid =
    /^\d+$/.test(intervalInput) &&
    Number.isInteger(interval) &&
    interval >= CUSTOM_REPEAT_INTERVAL_SCHEDULABLE_MIN &&
    interval <= CUSTOM_REPEAT_INTERVAL_MAX;
  const canIncrementInterval = intervalInput === "" || interval < CUSTOM_REPEAT_INTERVAL_MAX;
  // [失败路径] 减号在空串时禁用（而不是减到 -1）：空串是"正在输入"的合法中间态，
  // 此时减一没有意义，禁用比把输入框变成一个非法值更好。
  const canDecrementInterval = intervalInput !== "" && interval > CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
  // [事务] 步进时以"当前可解析值或输入下限"为基准再做 clamp：空串时按 0 起跳，
  // 这样第一次点 "+" 得到 1（可调度下限），而不是 NaN。
  // [失败路径] clamp 必须同时有上下界：只 clamp 上界会让 "-" 把值压到 -1，
  // 随后正则判否、输入框进入永久的 invalid 态。
  const stepInterval = (delta: 1 | -1) => {
    const currentInterval = /^\d+$/.test(intervalInput)
      ? interval
      : CUSTOM_REPEAT_INTERVAL_INPUT_MIN;
    const nextInterval = Math.min(
      CUSTOM_REPEAT_INTERVAL_MAX,
      Math.max(CUSTOM_REPEAT_INTERVAL_INPUT_MIN, currentInterval + delta),
    );
    setIntervalInput(String(nextInterval));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // [权衡] 固定 400px 宽 + 视口最大高：两列（数字 + 单位）在窄屏会挤成一行
        // 折行，而 overflow-y-auto 保证小屏能滚动到"结束日期"。
        className="max-h-[calc(100vh-2rem)] w-[400px] gap-0 overflow-y-auto border-border bg-card p-0 shadow-[0_20px_25px_-5px_rgba(0,0,0,0.1),0_8px_10px_-6px_rgba(0,0,0,0.1)]"
        // [失败路径] aria-describedby={undefined} 是为了关掉 Radix 的"缺少描述"告警：
        // 该对话框没有描述段落，保留默认会让控制台每次打开都报 warn。
        aria-describedby={undefined}
        showCloseButton={false}
      >
        <DialogHeader className="px-5 pb-5 pt-5">
          <DialogTitle className="text-ui-xl font-medium leading-[26px] tracking-[-0.12px]">
            {intl.formatMessage({ id: "automations.customRepeat.title" })}
          </DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute right-5 top-5 flex size-6 items-center justify-center rounded-[6px] opacity-80 transition-colors hover:bg-surface-hover hover:opacity-100"
            >
              <X className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="space-y-5 px-5">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-custom-interval"
              className="text-ui-base leading-5 tracking-[-0.18px] text-foreground"
            >
              {intl.formatMessage({ id: "automations.customRepeat.frequency" })}
            </label>
            <div className="grid grid-cols-2 gap-4">
              <div className="relative">
                <Input
                  id="automation-custom-interval"
                  type="number"
                  min={CUSTOM_REPEAT_INTERVAL_INPUT_MIN}
                  max={CUSTOM_REPEAT_INTERVAL_MAX}
                  step={1}
                  inputMode="numeric"
                  value={intervalInput}
                  aria-invalid={!isIntervalValid}
                  className="h-9 rounded-lg px-3 pr-10 text-mobile-input-safe leading-6 tracking-[-0.18px] [appearance:textfield] md:text-ui-base md:leading-5 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_SELECT}
                  onChange={(event) => {
                    const value = event.target.value;
                    // number 输入允许空值和科学计数法；保留空值便于编辑，
                    // 但只接收非负整数文本，避免将无效值写进 cron / scheduleRule。
                    if (value === "" || /^\d+$/.test(value)) setIntervalInput(value);
                  }}
                />
                {/* 原生 number spinner 在系统浏览器与 WebView 的尺寸、主题反馈不一致；
                    使用受控步进按钮，统一桌面与手机 Web 的点击样式。 */}
                <div className="absolute inset-y-px right-px flex w-8 flex-col overflow-hidden rounded-r-[7px] border-l border-input-border bg-input">
                  <button
                    type="button"
                    aria-label="+1"
                    title="+1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT}
                    disabled={!canIncrementInterval}
                    onClick={() => stepInterval(1)}
                    className="flex flex-1 items-center justify-center border-b border-input-border text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronUp className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="-1"
                    title="-1"
                    data-testid={TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT}
                    disabled={!canDecrementInterval}
                    onClick={() => stepInterval(-1)}
                    className="flex flex-1 items-center justify-center text-foreground-subtle transition-colors hover:bg-input-focused hover:text-foreground focus-visible:z-10 focus-visible:bg-input-focused focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
                  >
                    <ChevronDown className="size-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <Select
                value={unit}
                onValueChange={(value) => {
                  const nextUnit = value as CustomRepeatUnit;
                  setUnit(nextUnit);
                  // [事务] 切到 yearly 时必须重建 monthDays（INV-27 的入口侧）：之前
                  // 按月选的多天在"每年"语义下没有意义，用今天作为单日锚点。
                  if (nextUnit === "yearly") setMonthDays([new Date().getDate()]);
                }}
              >
                <SelectTrigger
                  className="h-9 w-full rounded-[8px] px-3 text-ui-base leading-5 tracking-[-0.18px] hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                  data-testid={TID_AUTOMATION_CUSTOM_UNIT_SELECT}
                  indicator={<CustomRepeatSelectIndicator />}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  collisionPadding={8}
                  className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                >
                  <SelectItem
                    value="minute"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "minute")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.minute",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="hourly"
                    className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "hourly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.hour",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="daily"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "daily")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.day",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="weekly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "weekly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.week",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="monthly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "monthly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.month",
                    })}
                  </SelectItem>
                  <SelectItem
                    value="yearly"
                    data-testid={testId(TID_AUTOMATION_CUSTOM_UNIT_OPTION, "yearly")}
                  >
                    {intl.formatMessage({
                      id: "automations.customRepeat.unit.year",
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {unit === "weekly" ? (
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAY_ORDER.map((day) => {
                const active = weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    // [事务] 最后一个选中项不可取消（INV-28）：空集合会写出非法
                    // cron 的星期字段，任务保存成功却永不触发；对话框里同样要拦，
                    // 不能只依赖 WeekdayPicker。
                    onClick={() => {
                      if (active && weekdays.length === 1) return;
                      setWeekdays(
                        active
                          ? weekdays.filter((candidate) => candidate !== day)
                          : [...weekdays, day],
                      );
                    }}
                    className={cn(
                      "flex h-9 items-center justify-center rounded-md border text-ui-base",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:bg-surface-hover",
                    )}
                  >
                    {intl.formatMessage({ id: `automations.weekday.${day}` })}
                  </button>
                );
              })}
            </div>
          ) : null}

          {unit === "monthly" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui-base text-foreground">
                  {intl.formatMessage({ id: "automations.customRepeat.rule" })}
                </span>
                <Select
                  value={monthlyMode}
                  onValueChange={(value) =>
                    setMonthlyMode(value as CronBuilderState["customMonthlyMode"])
                  }
                >
                  <SelectTrigger
                    className="h-9 w-32 rounded-[8px] px-3 text-ui-base hover:bg-input/80 data-[state=open]:border-input-border-hover data-[state=open]:bg-input/80"
                    indicator={<CustomRepeatSelectIndicator />}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    position="popper"
                    align="start"
                    side="bottom"
                    sideOffset={4}
                    collisionPadding={8}
                    className={CUSTOM_REPEAT_SELECT_CONTENT_CLASS}
                  >
                    <SelectItem value="date" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byDate",
                      })}
                    </SelectItem>
                    <SelectItem value="weekday" className={CUSTOM_REPEAT_SELECT_ITEM_CLASS}>
                      {intl.formatMessage({
                        id: "automations.customRepeat.byWeekday",
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {monthlyMode === "date" ? (
                <div className="grid grid-cols-10 gap-2.5">
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => {
                    const active = monthDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => {
                          if (active && monthDays.length === 1) return;
                          setMonthDays(
                            active
                              ? monthDays.filter((candidate) => candidate !== day)
                              : [...monthDays, day],
                          );
                        }}
                        className={cn(
                          "flex h-7 w-full items-center justify-center rounded-[8px] border text-ui-sm",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-2">
                  {WEEKDAY_ORDER.map((day) => {
                    const active = weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => setWeekdays([day])}
                        className={cn(
                          "flex h-9 items-center justify-center rounded-md border text-ui-base",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-surface-hover",
                        )}
                      >
                        {intl.formatMessage({
                          id: `automations.weekday.${day}`,
                        })}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-base leading-5 tracking-[-0.18px] text-foreground">
              {intl.formatMessage({ id: "automations.customRepeat.ends" })}
            </span>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setEnds(false)}
                // [事务] 选择"永不结束"只改 ends，不动 endDate（INV-34）：清空日期会
                // 让用户切回来时丢失上次选好的日期，需要重新翻日历。
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      !ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {!ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.neverEnds",
                })}
              </button>
              <button
                type="button"
                onClick={() => setEnds(true)}
                // [失败路径] 切到"指定结束"时若 endDate 仍是空串，EndDatePicker 会
                // 显示为空且确认按钮被 disabled（见下方 disabled 表达式），
                // 用户必须自己选日期——这是刻意的，避免默认给一个用户没确认的截止日。
                className="flex h-9 items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 tracking-[-0.18px] transition-colors hover:bg-surface-hover"
              >
                <span className="flex size-5 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-[1.33px]",
                      ends ? "border-[#4099FF] bg-[#4099FF]" : "border-border",
                    )}
                  >
                    {ends ? <span className="size-1.5 rounded-full bg-white" /> : null}
                  </span>
                </span>
                {intl.formatMessage({
                  id: "automations.customRepeat.endsOption",
                })}
              </button>
            </div>
            {/* 修复原因：原生 date input 会在暗色主题中弹出不可控的系统白色月历。 */}
            <EndDatePicker
              value={endDate}
              min={toDateInputValue(Date.now())}
              disabled={!ends}
              intl={intl}
              onChange={setEndDate}
            />
          </div>
        </div>

        <DialogFooter className="gap-3 px-5 pb-5 pt-5">
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:border-border-hover hover:bg-input/50"
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </DialogClose>
          <Button
            type="button"
            className="h-9 rounded-[8px] px-4 text-ui-base font-medium leading-5 tracking-[-0.18px] hover:bg-primary/80"
            data-testid={TID_AUTOMATION_CUSTOM_CONFIRM}
            // [事务] 确认按钮的双重闸门：间隔必须可调度（INV-19），且"指定结束"时
            // 必须能解析出合法截止时间（INV-20 的输入侧）。
            // [失败路径] localDateEndTimestamp 返回 undefined 时 disabled，而不是
            // 在 onClick 里抛错：输入过程中的半成品日期不该让按钮"点了才报错"。
            disabled={!isIntervalValid || (ends && !localDateEndTimestamp(endDate))}
            onClick={() => {
              onConfirm({
                interval,
                unit,
                weekdays,
                monthDays,
                monthlyMode,
                ...(ends ? { endAt: localDateEndTimestamp(endDate) } : {}),
              });
              onOpenChange(false);
            }}
          >
            {intl.formatMessage({ id: "common.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// [事务] 提交载荷与"表单草稿"分离：input 是持久层契约（Create/Update 联合类型），
// workspacePath 是 UI 层选择结果。两者分开是因为编辑态的 workspace 不可改，
// 混进 input 会让持久层误以为可以跨项目迁移。
export interface AutomationEditSubmit {
  input: CreateAutomationInput | UpdateAutomationInput;
  /** 目标项目(创建时可能不同于当前列表项目)。 */
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface AutomationEditViewProps {
  /** null = 新建；否则编辑。 */
  editing: ZCodeAutomation | null;
  /** 新建预填(来自 More ideas 模板)。 */
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null;
  /** 当前列表所在项目,作为新建的默认目标项目。 */
  defaultWorkspacePath: string;
  defaultWorkspaceIdentity?: string;
  onManageModels?: () => void;
  saving: boolean;
  onSubmit: (params: AutomationEditSubmit) => Promise<boolean>;
  onBack: () => void;
  /** 编辑态:立即运行 / 启停 / 删除。 */
  onRunNow?: (automation: ZCodeAutomation) => Promise<void> | void;
  onToggle?: (automation: ZCodeAutomation, enabled: boolean) => void;
  onDelete?: (automation: ZCodeAutomation) => void;
  /** History tab 运行历史。 */
  runsEntry?: AutomationRunsEntry;
  onLoadRuns?: () => void;
  onDeleteRun?: (runId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

// [事务] 抽成独立导出函数是为了让"先保存再运行"的顺序可被单测直接覆盖（INV-13）：
// 内联在组件里只能靠 UI 测试间接验证，而这条顺序一旦写反会产生真实副作用。
// [失败路径] save 返回 false 时直接返回 false，不调用 run：这是函数唯一的提前返回，
// 也是"保存失败绝不运行"的唯一实现点。
export async function saveAndRunAutomation(
  save: () => Promise<boolean>,
  run: () => Promise<void> | void,
): Promise<boolean> {
  // [失败路径] 必须 await save 并检查返回值：save 是异步的，不 await 会先跑 run
  // 再拿到保存结果，用户看到"任务已运行"但配置没落库。
  if (!(await save())) return false;
  await run();
  return true;
}

// [权衡] 默认值统一是"每天 09:00、周一、1 号"：这三个字段虽然只在不同频率下生效，
// 但 builder 始终是完整结构，切换频率时无需再补默认值，避免"切到 weekly 时星期为空"。
// [事务] rawExpr 同步写成 "0 9 * * *"：它与 frequency/hour/minute 必须自洽，
// 否则首帧渲染出的预览会与 cronExpr 生成结果不一致。
function defaultBuilder(): CronBuilderState {
  return {
    frequency: "daily",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    rawExpr: "0 9 * * *",
    customInterval: 1,
    customUnit: "daily",
    customWeekdays: [1],
    customMonthDays: [1],
    customMonth: new Date().getMonth() + 1,
    customMonthlyMode: "date",
  };
}

// [事务] 首帧 builder 必须直接用真实 cron/scheduleRule（INV-04）：先渲染默认值再
// 由 effect 回填，会让子控件的 register 回调把"默认值 → 真实值"记成一次用户修改，
// 编辑页一打开就是脏的。
// [失败路径] draft 优先于 editing：模板预填是"用户刚点的入口"，若被 editing 覆盖，
// 从模板进入编辑页会看到另一个任务的配置。
// [权衡] scheduleRule 与 cronExpr 同时给出时以 rule 为准：rule 能表达"每 2 周/每月
// 第几个周几"等 cron 无法无损回显的语义。
function initialBuilder(
  editing: ZCodeAutomation | null,
  initialDraft?: { title: string; cronExpr: string; prompt: string } | null,
): CronBuilderState {
  // [事务] 新建分支的两种来源优先级固定：模板预填 → 默认值。模板里的 cron 必须
  // 完整解析（而不是只改 rawExpr），否则首帧 UI 的频率下拉与表达式不一致。
  if (!editing) {
    return initialDraft ? parseCronToBuilder(initialDraft.cronExpr) : defaultBuilder();
  }

  // [失败路径] 先解析 cron 得到"基础 builder"，再用 scheduleRule 覆盖：直接只用
  // rule 构造会让 rawExpr 为空，用户在自定义重复里点"取消"时没有可回退的表达式。
  const parsedBuilder = parseCronToBuilder(editing.cronExpr);
  if (!editing.scheduleRule) return parsedBuilder;

  // [事务] rule 覆盖成 frequency="custom" 是必须的（INV-08 的来源二）：只有 custom
  // 才会渲染 scheduleRule，其它频率会把它当作"不存在"，导致再次保存时丢掉 interval。
  return {
    ...parsedBuilder,
    frequency: "custom",
    hour: editing.scheduleRule.hour,
    minute: editing.scheduleRule.minute,
    customInterval: editing.scheduleRule.interval,
    customUnit: editing.scheduleRule.unit,
    customWeekdays: editing.scheduleRule.weekdays ?? [1],
    customMonthDays: editing.scheduleRule.monthDays ?? [1],
    customMonth:
      editing.scheduleRule.months?.[0] ?? new Date(editing.scheduleRule.anchorAt).getMonth() + 1,
    customMonthlyMode: editing.scheduleRule.monthlyMode ?? "date",
  };
}

// ---- 运行历史状态映射(与 AutomationRunsDialog 保持一致) ----
type RunStatusKind = "running" | "succeeded" | "failed" | "stopped" | "skipped";
function resolveRunStatus(run: ZCodeAutomationRun): RunStatusKind {
  if (run.dispatchStatus === "skipped") return "skipped";
  if (run.dispatchStatus === "failed_to_dispatch") return "failed";
  switch (run.outcome) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "running";
  }
}
// 运行状态用「圆点 + 彩色文字」呈现（Scheduled 历史表密度规格）。
const RUN_STATUS_DOT_CLASS: Record<RunStatusKind, string> = {
  running: "bg-primary",
  succeeded: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-foreground-subtlest",
  skipped: "bg-warning",
};
const RUN_STATUS_TEXT_CLASS: Record<RunStatusKind, string> = {
  running: "text-primary",
  succeeded: "text-success",
  failed: "text-destructive",
  stopped: "text-foreground-subtle",
  skipped: "text-warning",
};

const AUTOMATION_STATUS_DOT_CLASS: Record<AutomationStatusKind, string> = {
  active: "bg-success",
  paused: "bg-warning",
  failed: "bg-destructive",
  completed: "bg-foreground-subtlest",
};

function normalizeAutomationScheduleRule(
  rule: ZCodeAutomationScheduleRule | null | undefined,
): Record<string, unknown> | null {
  if (!rule) return null;
  return {
    unit: rule.unit,
    interval: rule.interval,
    hour: rule.hour,
    minute: rule.minute,
    anchorAt: rule.anchorAt,
    weekdays: rule.weekdays ?? [],
    monthDays: rule.monthDays ?? [],
    months: rule.months ?? [],
    monthlyMode: rule.monthlyMode ?? "date",
  };
}

export function AutomationEditView({
  editing,
  initialDraft,
  defaultWorkspacePath,
  defaultWorkspaceIdentity,
  onManageModels,
  saving,
  onSubmit,
  onBack,
  onRunNow,
  onToggle,
  onDelete,
  runsEntry,
  onLoadRuns,
  onDeleteRun,
  onOpenSession,
}: AutomationEditViewProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  // [事务] tab 与 runsPage 都属于"视图位置"，不属于草稿：切换编辑对象时必须一起复位
  // （见下面的 reset effect），否则从长历史的任务切到短任务会落在空白的第 9 页。
  const [tab, setTab] = useState<AutomationSettingsHistoryTab>("settings");
  const [runsPage, setRunsPage] = useState(1);
  // [并发] onLoadRunsRef 是"最新回调"的镜像（INV-16）：父组件 inline 传入的回调
  // 每次渲染都是新函数，直接进依赖会让 5s 轮询 effect 反复销毁重建，形成请求风暴。
  const onLoadRunsRef = useRef(onLoadRuns);
  // [并发] saveAndRun 的防重入需要 ref + state 两份（INV-12）：ref 在同一 tick 的
  // 第二次点击时立即生效，state 只负责把按钮置灰。
  const saveAndRunPendingRef = useRef(false);
  const [saveAndRunPending, setSaveAndRunPending] = useState(false);
  // [事务] 默认标题会随 locale 变化，因此要记住"上一次的默认标题"来区分
  // "用户没改过标题"与"用户改成了别的内容"（见 resolveLocalizedAutomationCreateTitle）。
  const localizedDefaultCreateTitle = intl.formatMessage({
    id: "automations.edit.titlePlaceholder",
  });
  const previousLocalizedDefaultTitleRef = useRef(localizedDefaultCreateTitle);
  const titleTouchedRef = useRef(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  // [并发] model/mode/thoughtLevel 都是"state 供渲染 + ref 供提交"的双写结构
  // （INV-01/INV-05）：提交发生在按钮回调里，闭包可能还没拿到最新 state。
  const [model, setModel] = useState<string>("");
  const modelSelection = useRef("");
  const [mode, setMode] = useState<string>(AUTOMATION_DEFAULT_MODE);
  const modeRef = useRef(AUTOMATION_DEFAULT_MODE);
  const [thoughtLevel, setThoughtLevel] = useState<string>("");
  const thoughtLevelRef = useRef("");
  // [权衡] 两个 manuallyChanged 标记用于区分"跟随默认"与"用户显式选择"：
  // 前者允许在候选刷新时自动纠正失效值，后者必须尊重用户选择、只给提示。
  const modelManuallyChangedRef = useRef(false);
  const thoughtManuallyChangedRef = useRef(false);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // 不能首帧先渲染默认的“每天 09:00”、再由 effect 回填持久化调度。
  // 子级调度控件会先注册 value 回调，从而把默认值误记成 dirty baseline；编辑态必须首帧即使用真实值。
  const [builder, setBuilder] = useState<CronBuilderState>(() =>
    initialBuilder(editing, initialDraft),
  );
  // [事务] 新建任务默认不带日程（INV-08 的第三态）：scheduleRemoved 表达"用户还没
  // 添加或不想要日程"，它同时决定 cronExpr 是否为空串、以及校验是否显示必填红框。
  // 新建任务默认不带日程，通过「Add schedule」显式添加；移除后未补齐标红提示。
  const [scheduleRemoved, setScheduleRemoved] = useState(!editing && !initialDraft);
  // [失败路径] errors 用 Set 而不是布尔对象：校验是"字段集合"，新增必填字段时
  // 只需要往枚举里加一项，不需要再加一个 boolean。
  const [validationErrors, setValidationErrors] = useState<
    ReadonlySet<AutomationEditRequiredField>
  >(() => new Set());
  const [customRepeatOpen, setCustomRepeatOpen] = useState(false);
  // [事务] touchedFields 与 baselines 成对存在（INV-02/INV-03）：前者驱动渲染与
  // 离开保护，后者提供"首次触碰时"的比较基准，两者缺一就无法正确判定 dirty。
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<AutomationEditDirtyField>>(
    () => new Set(),
  );
  const currentEditSignaturesRef = useRef<AutomationEditFieldSignatures | null>(null);
  const touchedFieldBaselinesRef = useRef<Partial<AutomationEditFieldSignatures>>({});
  const [endAt, setEndAt] = useState<number | undefined>(() => editing?.endAt);
  // 目标项目 key(仅新建时可改;编辑锁定为 automation 所属项目)。
  // [权衡] 这里存 key 而不是整个 option 对象：option 会随 services 刷新重建，
  // 存对象会让"用户已选的项目"在每次刷新后变成新引用并触发无谓重渲染。
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);

  const localWorkspaceOptions = useAutomationProjectOptions();
  // [事务] 编辑态只保留"任务所属项目"一个候选（INV-07）：把全部项目列出来会诱导
  // 用户改项目，而持久层只支持在同一项目内更新任务，改项目等于隐式搬到另一个项目。
  // [失败路径] 找不到对应 option 时用路径末段兜底标签：任务所属项目可能已被移除，
  // 此时仍要能展示并允许保存（标签只是展示层，不参与校验）。
  const editingWorkspaceOption = editing
    ? findAutomationWorkspaceOptionByKey(
        localWorkspaceOptions,
        resolveAutomationWorkspaceSelectionKey(editing),
      )
    : undefined;
  const workspaceOptions = useMemo<AutomationWorkspaceOption[]>(
    () =>
      editing
        ? [
            {
              workspacePath: editing.workspacePath,
              workspaceIdentity: editing.workspaceIdentity,
              projectId: editing.projectId,
              hostId: editing.hostId,
              label: editingWorkspaceOption?.label ?? workspaceLabelFromPath(editing.workspacePath),
            },
          ]
        : localWorkspaceOptions,
    [editing, editingWorkspaceOption, localWorkspaceOptions],
  );
  // [并发] workspaceOptionsRef 是"渲染值的最新镜像"：reset effect 的依赖里刻意不含
  // workspaceOptions（否则候选一刷新就重置整个表单），因此只能通过 ref 读到最新候选。
  const workspaceOptionsRef = useRef(workspaceOptions);
  workspaceOptionsRef.current = workspaceOptions;

  // [事务] 打开/切换编辑对象时整体重置，顺序是"先清脏值与校验，再写入目标对象"：
  // 反过来会让新对象的值先被记进旧 baseline，一打开就是脏的（INV-02）。
  // [失败路径] ref 形式的标记（titleTouched/manuallyChanged/touchedFieldBaselines）
  // 必须在这里一并清空：它们不参与渲染，漏清会跨任务残留。
  // 打开/切换编辑对象时重置表单。
  useEffect(() => {
    setTab("settings");
    setRunsPage(1);
    setTouchedFields(new Set());
    setValidationErrors(new Set());
    touchedFieldBaselinesRef.current = {};
    if (editing) {
      setScheduleRemoved(false);
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      // [事务] 编辑态必须把三份"选择"同时写成同一份值：state（渲染）、ref（提交）、
      // 以及 encodeCustomModelValue 的 provider:id 编码（持久层格式）。
      // 只写其中一个就会出现"界面显示 A、保存写入 B"的错位（INV-01）。
      setTitle(editing.title);
      setPrompt(editing.prompt);
      const editingModel = editing.modelSelection
        ? encodeCustomModelValue(editing.modelSelection.providerId, editing.modelSelection.modelId)
        : "";
      const editingThoughtLevel = editing.modelSelection?.options?.reasoningLevel?.trim() ?? "";
      // [并发] 编辑态初始化必须把 ref 与 state 同步写成同一份持久化值（INV-01）：
      // 只写 state 会让"打开页面后立刻点保存"读到空 ref，从而被新鲜度校验拦下。
      modelSelection.current = editingModel;
      thoughtLevelRef.current = editingThoughtLevel;
      setModel(editingModel);
      const editingMode = editing.mode?.trim() || AUTOMATION_DEFAULT_MODE;
      modeRef.current = editingMode;
      setMode(editingMode);
      setThoughtLevel(editingThoughtLevel);
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(editing.endAt);
      setWorkspaceKey(resolveAutomationWorkspaceSelectionKey(editing));
    } else {
      setScheduleRemoved(!initialDraft);
      // [权衡] 模板标题属于"用户明确选择的内容"，视为已触碰；而 locale 默认标题
      // 需要跟随语言切换，因此 titleTouchedRef 保持 false（见下一个 effect）。
      // 新建页的默认标题可随 locale 更新；模板标题仍属于用户明确选择的内容。
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(initialDraft?.title ?? localizedDefaultCreateTitle);
      setPrompt(initialDraft?.prompt ?? "");
      // [失败路径] 新建态必须把模型选择清空而不是沿用上一次的值：同一组件实例
      // 可能从"编辑 A"直接切到"新建"，不清空会让新任务带上 A 的模型。
      modelSelection.current = "";
      setModel("");
      modeRef.current = AUTOMATION_DEFAULT_MODE;
      thoughtLevelRef.current = "";
      setMode(AUTOMATION_DEFAULT_MODE);
      setThoughtLevel("");
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(undefined);
      // [事务] 新建态必须把目标项目收敛到"当前候选集合里真实存在"的一项（INV-07）：
      // 直接信任 defaultWorkspacePath 会在项目被删除/断开后留下一个幽灵目标，
      // 提交时才发现 services 解析不到模型。
      setWorkspaceKey(
        reconcileAutomationWorkspaceSelectionKey(workspaceOptionsRef.current, null, {
          workspacePath: defaultWorkspacePath,
          workspaceIdentity: defaultWorkspaceIdentity,
        }),
      );
    }
  }, [editing, initialDraft, defaultWorkspacePath, defaultWorkspaceIdentity]);

  // [事务] 标题的 locale 跟随只在"用户没碰过标题"时生效：正则/判等判断交给
  // resolveLocalizedAutomationCreateTitle，这里只负责记住新的默认值。
  // [失败路径] nextTitle === title 时不 setState（避免一次无意义渲染）：该 effect 的
  // 依赖包含 title，无条件 set 会形成"set → 渲染 → effect"的循环。
  useEffect(() => {
    const nextTitle = resolveLocalizedAutomationCreateTitle({
      currentTitle: title,
      hasInitialDraft: Boolean(initialDraft),
      isEditing: Boolean(editing),
      nextDefaultTitle: localizedDefaultCreateTitle,
      previousDefaultTitle: previousLocalizedDefaultTitleRef.current,
      titleTouched: titleTouchedRef.current,
    });
    previousLocalizedDefaultTitleRef.current = localizedDefaultCreateTitle;
    if (nextTitle !== title) {
      setTitle(nextTitle);
    }
  }, [editing, initialDraft, localizedDefaultCreateTitle, title]);

  // [并发] 新建态的目标项目跟随"候选集合"变化而重新收敛（INV-07）：项目列表可能在
  // 后台刷新（Host 重连、项目被删），必须把已选 key 校正到一个仍然有效的项。
  // [失败路径] 收敛结果是 null 时必须真的置空，而不是保留旧 key：后者会让
  // hasValidWorkspace 仍为真，用户能提交一个没有目标项目的任务。
  useEffect(() => {
    if (editing) return;
    // 候选为空或默认项目已失效时不能保留 default workspace 并允许落库。
    // 任何 tab 变化都重新把选择收敛到当前有效项目；没有候选时必须明确置空。
    setWorkspaceKey((currentWorkspaceKey) =>
      reconcileAutomationWorkspaceSelectionKey(workspaceOptions, currentWorkspaceKey, {
        workspacePath: defaultWorkspacePath,
        workspaceIdentity: defaultWorkspaceIdentity,
      }),
    );
  }, [defaultWorkspaceIdentity, defaultWorkspacePath, editing, workspaceOptions]);

  // [事务] baseline 只在"首次触碰"时写入（INV-03）：后续再改不覆盖，这样比较的
  // 永远是"用户开始编辑前的那个值"，改回原值也能正确判成未变。
  // [并发] 写 ref 与 setState 之间没有 await，但 ref 先写是必要的：同一次交互里
  // 可能紧接着触发提交，提交读的是 ref。
  const markFieldTouched = useCallback((field: AutomationEditDirtyField) => {
    if (touchedFieldBaselinesRef.current[field] === undefined) {
      touchedFieldBaselinesRef.current[field] = currentEditSignaturesRef.current?.[field];
    }
    setTouchedFields((previous) => {
      if (previous.has(field)) return previous;
      const next = new Set(previous);
      next.add(field);
      return next;
    });
  }, []);

  // [事务] 清错误只做"删除这个字段的条目"，不整体重置：用户同时缺 title 与 prompt
  // 时，填好 title 不应让 prompt 的红框一起消失。
  const clearRequiredFieldValidation = useCallback((field: AutomationEditRequiredField) => {
    setValidationErrors((current) => clearAutomationEditRequiredFieldError(current, field));
  }, []);

  // [事务] 删除日程必须同时做三件事：标记 schedule 脏、置 removed、清掉该字段的
  // 必填错误。只清错误而不标记脏，用户点返回时不会提示未保存（INV-09）。
  // [失败路径] 这里刻意不打开 destructive 校验态：删除是合法的编辑动作，
  // 立刻标红会让用户以为操作失败（见下方日志里的 validationVisible: false）。
  const handleRemoveSchedule = useCallback(() => {
    markFieldTouched("schedule");
    setScheduleRemoved(true);
    // 删除计划曾直接开启 destructive 校验态，把普通编辑误当成提交失败。
    clearRequiredFieldValidation("schedule");
    logger.debug("[AutomationEditView] 删除计划草稿", {
      automationId: editing?.automationId ?? null,
      validationVisible: false,
    });
  }, [clearRequiredFieldValidation, editing?.automationId, markFieldTouched]);

  useEffect(() => {
    onLoadRunsRef.current = onLoadRuns;
  }, [onLoadRuns]);

  // [并发] 轮询 effect 的依赖只有 tab 与 automationId（INV-16）：onLoadRuns 通过
  // ref 读取，editing 对象本身不进依赖（它的引用每次父级渲染都可能变）。
  // [资源] 必须在 cleanup 里 clearInterval：切走 tab 或卸载页面后继续轮询，
  // 会在后台持续发 RPC，手机端还会被唤醒。
  // 切到 History tab(编辑态)时加载运行历史，并在停留期间轻量刷新。
  // cron run/outcome 由 scheduler/host 异步写入；只加载一次会让用户看到会话已结束但历史仍为空。
  // onLoadRuns 由父组件 inline 传入，不能作为依赖，否则每次 runsCache 更新都会重启 effect 形成请求循环。
  useEffect(() => {
    if (tab !== "history" || !editing) {
      return;
    }
    // [失败路径] 进入 tab 先立即拉一次，再挂 5s 轮询：只靠 interval 会让用户
    // 在切换后的最多 5 秒里看到"没有运行记录"的空态。
    onLoadRunsRef.current?.();
    const timer = window.setInterval(() => {
      onLoadRunsRef.current?.();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [tab, editing?.automationId]);

  // [事务] "会话来源"判定只看持久化数据里有没有 sessionId 血缘，不看当前运行态：
  // 任务被暂停/结束后这个属性仍是 true，若跟着生命周期变化，编辑页的只读规则
  // 会在同一次会话里反复切换，用户两次打开看到两种行为。
  const isSessionCreatedAutomation = resolveIsSessionCreatedAutomation(editing);
  // [事务] 只读条件是四个"与"（INV-21）：会话来源 + 用户没改过日程 + cron 无法可视化
  // + 用户还没触碰 schedule。少任何一个都会让用户的第一次编辑被旧的只读值覆盖，
  // 表现为"改了日程但保存后没变"。
  // 会话来源但无法由 UI 安全回显的旧 cron 保持只读；用户显式重设后以持久化标记退出该路径。
  const preserveSessionCreatedSchedule =
    isSessionCreatedAutomation &&
    !editing?.scheduleEditedByUser &&
    Boolean(editing && !canVisualizeCronInAutomationEditor(editing.cronExpr)) &&
    !touchedFields.has("schedule");
  // [事务] cronExpr 的三态优先级固定（INV-08）：已删除 → 空串；保留态 → 原 cron；
  // 其余 → 由 builder 生成。三者互斥，顺序交换会写出与界面不一致的表达式。
  // [权衡] 依赖里放 builder 整体而不是它的字段：builder 是不可变对象，字段级依赖
  // 需要列出 9 项，容易漏项导致"改了周几但 cron 没更新"。
  const cronExpr = useMemo(
    () =>
      scheduleRemoved
        ? ""
        : preserveSessionCreatedSchedule
          ? (editing?.cronExpr ?? "")
          : buildCronExpr(builder),
    [builder, editing?.cronExpr, preserveSessionCreatedSchedule, scheduleRemoved],
  );
  // [失败路径] 预览必须与 cronExpr 同源（而不是直接从 builder 描述）：只读保留态的
  // cron 无法被 builder 表达，从 builder 生成预览会显示一段与真实调度不符的文案。
  // [权衡] 空 cron 时返回空串让 UI 隐藏预览行，而不是显示"未设置"——删除日程后
  // 那一行应当整体消失（与 Add schedule 按钮状态一致）。
  const schedulePreview = useMemo(
    () => (cronExpr ? describeCronBuilder(builder, intl) : ""),
    [builder, cronExpr, intl],
  );
  // [失败路径] 二级兜底（editing 时直接构造 option）是为了"任务所属项目已从候选里
  // 消失"的场景：此时必须仍能展示路径并提交，否则用户无法编辑或关闭这个任务。
  // [事务] 新建态没有兜底，直接返回 null：没有有效项目时 UI 展示空态与禁用提交，
  // 不允许退回到 conversation/default workspace（INV-07）。
  const selectedWorkspace: AutomationWorkspaceOption | null =
    findAutomationWorkspaceOptionByKey(workspaceOptions, workspaceKey) ??
    (editing
      ? {
          workspacePath: editing.workspacePath,
          workspaceIdentity: editing.workspaceIdentity,
          projectId: editing.projectId,
          hostId: editing.hostId,
          label: editingWorkspaceOption?.label ?? workspaceLabelFromPath(editing.workspacePath),
        }
      : null);
  // 新建态无有效项目时保留空目标，避免模型配置读取悄悄回退到 conversation/default workspace。
  const selectedWorkspacePath = selectedWorkspace?.workspacePath ?? "";
  const selectedWorkspaceIdentity = selectedWorkspace?.workspaceIdentity;
  // [并发] originalSelection 是"持久化的原始选择"（用于检测失效），而 effectiveSelection
  // 是"服务端解析后的实际选择"。两者分开才能表达"用户存的模型已被下线"这种状态，
  // 合成一个就只剩"当前是什么"，无法提示重新选择（INV-18）。
  const originalSelection = useMemo(() => {
    if (!model) return null;
    const identity = parseModelPickerValue(model);
    return identity
      ? { ...identity, ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}) }
      : null;
  }, [model, thoughtLevel]);
  // 模型候选属于当前表单目标 Host。项目切换时立即切换订阅；远程目标未连接时
  // 等待远端时保持 unavailable；本地空项目直接读取同 Host 模型目录，不创建假 cwd。
  // [并发] 模型候选按"目标 Host"订阅（INV-17）：切换项目会立刻切换 services 所有者，
  // 这里不做缓存合并——跨 Host 的候选项 id 可能相同但权限不同，合并会给出不可用的模型。
  // [失败路径] 远程未连接时传 "remote-waiting" 而不是 "missing-target"：前者保留
  // 加载态、后者直接进入空态，会让刚打开页面的用户看到"没有模型"的误导提示。
  const selectionOwner = useWorkspaceServicesResolution(
    selectedWorkspacePath || null,
    selectedWorkspace?.remoteSessionId,
    selectedWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
  );
  const modelSelectionRead = useModelSelectionServiceView(
    selectionOwner.services.modelSelectionService,
    Boolean(selectedWorkspace) && selectionOwner.connectionKind !== "remote-waiting",
    selectedWorkspace ? "remote-waiting" : "missing-target",
    { selection: originalSelection },
  );
  // [失败路径] 只有 ready 才取 view，其余状态一律 null：把 unavailable 的缓存 view
  // 当可用会让 submissionContextReady 误判为真，提交一个目标 Host 已断开的任务。
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // [事务] effectiveModelValue 用"服务端视图的 effectiveSelection"而不是用户输入的
  // model：下拉展示与提交值必须同源，否则会出现"显示 A 模型、提交 B 模型"。
  const effectiveSelection = modelSelectionView?.effectiveSelection;
  const effectiveModelValue = effectiveSelection
    ? encodeCustomModelValue(effectiveSelection.providerId, effectiveSelection.modelId)
    : "";
  const effectiveReasoningLevel = effectiveSelection?.options?.reasoningLevel ?? "";
  // [权衡] 分组在 view 为 null 时返回空数组而不是缓存的旧分组：宁可在加载态短暂
  // 显示空下拉，也不要让用户从一个已经失效的 Host 选模型。
  // [失败路径] 所有文案都走 intl 而不是硬编码：模型组标签与设置页共用同一批 key，
  // 硬编码会让中英文混排（见下方 labels 逐项 formatMessage 的原因）。
  const modelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildAutomationModelSelectGroups({
      selectedProvider: ZCODE_AGENT_PROVIDER,
      labels: {
        apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
        apiKeyBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.apiKeyBadge",
        }),
        codingPlanLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.codingPlan",
        }),
        codingPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.codingPlanBadge",
        }),
        startPlanLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.startPlan",
        }),
        startPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.startPlanBadge",
        }),
        teamPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.teamPlanBadge",
        }),
        teamPlanFallbackLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.teamPlan",
        }),
      },
      registrySelectionView: modelSelectionView,
    });
  }, [intl, modelSelectionView]);
  // [事务] "会话型工作区"的两条判据（projectId 为 null 或 purpose=conversation）都必须
  // 保留：历史数据只写了其中一个，只认一条会把一部分会话型项目显示成普通项目路径。
  const isSelectedConversationWorkspace =
    selectedWorkspace?.projectId === null || selectedWorkspace?.workspacePurpose === "conversation";
  // Bug 原因：automation 数据只持久化 workspaceKey/path，编辑态曾直接把 conversation
  // backing path 当项目展示成 default。匹配当前 canonical 候选恢复 purpose 后，
  // 继续复用会话侧文案；无法匹配的历史目标仍回退到路径名称。
  const selectedWorkspaceDisplayLabel = isSelectedConversationWorkspace
    ? intl.formatMessage({ id: "chat.empty.workOutsideProject" })
    : (selectedWorkspace?.label ?? workspaceLabelFromPath(defaultWorkspacePath));
  // [并发] 切项目要立刻清空模型与档位（INV-06）：候选集合会随 Host 变化，保留旧值
  // 会让提交带上目标 Host 不存在的 provider/model，保存成功但任务永远执行失败。
  // [失败路径] key 不在候选里时直接 return，不改任何状态：这通常来自过期渲染的
  // 下拉事件，静默忽略比置空更安全（置空会让用户以为选择被吞掉）。
  const handleSelectProject = (key: string) => {
    if (!findAutomationWorkspaceOptionByKey(workspaceOptions, key)) return;
    // [事务] 两个 manuallyChanged 标记必须与清空动作同一 tick 复位：
    // 留 true 会让"新项目的默认模型自动填充"被永久抑制，用户只能手动选。
    // [失败路径] 只清 model 不清 thoughtLevel 会留下一个属于旧模型的档位，
    // 提交时该档位可能不在新模型的 Option Specs 里，保存后任务无法执行。
    modelManuallyChangedRef.current = false;
    thoughtManuallyChangedRef.current = false;
    // [并发] ref 与 state 必须一起清（INV-01）：ref 是提交瞬间读的值，
    // 只清 state 会让"切项目后立刻保存"仍然提交旧模型。
    modelSelection.current = "";
    setModel("");
    setWorkspaceKey(key);
  };
  // [事务] 触发器文案复用同一个解析函数（resolveAutomationModelTriggerLabel），
  // 而不是在本地拼接 provider/model：解析函数同时处理"候选尚未加载"与"已选模型
  // 不在当前分组"两种降级，本地拼接会让这两种态显示成一段 id 字符串。
  // [失败路径] fallbackLabel 必须传入 intl 文案而非空串：空串会让触发器塌缩成一个
  // 无文字按钮，用户以为模型选择器坏了。
  const modelTriggerLabel = resolveAutomationModelTriggerLabel({
    modelGroups: modelSelectGroups,
    modelSelectionView,
    modelValue: effectiveModelValue,
    fallbackLabel: intl.formatMessage({ id: "chat.toolbar.model.label" }),
  });
  // [事务] 主动选模型是唯一会"重新初始化思考档位"的入口（INV-23）：只有用户明确的
  // 模型切换才把档位重置为新模型的最高档；历史恢复与 View 刷新都保留缺失档位，
  // 否则服务端每次刷新都会把用户的档位改成默认值。
  // [并发] 先写 ref 再 setState：同一 tick 内紧接着的提交回调读 ref 才拿得到新值。
  // 主动选模型才初始化最高档；历史恢复和 View 刷新仍保留缺失档位。
  const handleModelValueChange = useCallback(
    (value: string) => {
      // [事务] 顺序不能反：先置 manuallyChanged、再清 thoughtManuallyChanged。
      // 反序会在两次写之间留下"用户改过思考档位"的短暂窗口，自动填充 effect
      // 若恰好在这个窗口运行，就会把用户刚选的档位覆盖成默认最高档。
      modelManuallyChangedRef.current = true;
      thoughtManuallyChangedRef.current = false;
      // [并发] 写 ref 放在 setState 之前：同一 tick 内后续的提交回调读的是 ref。
      modelSelection.current = value;
      setModel(value);
      const selection =
        value && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(value))
          : undefined;
      // [失败路径] selection 为 undefined（value 为空或 View 已失效）时把档位写成空串：
      // 空串会让 submissionContextReady 判假，用户看到禁用按钮而不是一次失败保存。
      // [事务] 这里不能回退到"沿用旧档位"：旧档位属于旧模型，写入会制造非法组合。
      const level = selection?.options?.reasoningLevel ?? "";
      thoughtLevelRef.current = level;
      setThoughtLevel(level);
      markFieldTouched("model");
    },
    [markFieldTouched, modelSelectionView],
  );
  // [事务] 这里刻意不调用 workspace 默认配置接口（原注释）：编辑页只读"模型列表"，
  // 不读"当前项目配置"，因为读取动作本身在部分 Host 上会创建/切换 draft session。
  // [失败路径] selectedModelItem 为 null 是提交闸门的一部分（INV-18）：候选列表还没
  // 加载或选中项已被移除时，必须禁用保存而不是带着 undefined 提交。
  // 定时任务编辑页只维护表单草稿，不能为了读取选项调用 workspace 默认配置接口；
  // 否则用户仅打开后取消，也会改掉当前项目或 draft session 的模型、模式和思考强度。
  const modeOption = useMemo(() => buildAutomationModeOption(mode), [mode]);
  const selectedModelItem = useMemo(
    () => resolveAutomationModelItem(modelSelectGroups, effectiveModelValue),
    [effectiveModelValue, modelSelectGroups],
  );
  // [权衡] preferredModelValue 只在新建态被消费：编辑态的模型由持久化值决定，
  // 用 preferred 覆盖会让用户保存的（可能已下线的）模型被悄悄替换。
  // [失败路径] View 未就绪时返回 null 而不是空串：空串会通过 Boolean 判断，
  // 让自动填充 effect 以为"有默认值"从而提前固化一个无效选择。
  const preferredModelValue = useMemo(
    () => (modelSelectionView ? resolveAutomationPreferredModelValue(modelSelectionView) : null),
    [modelSelectionView],
  );
  // [事务] 失效判定要求 originalSelection 与 view 同时存在（INV-24）：view 未就绪时
  // selectionIssue 必然为空，提前判定会把"还在加载"误报成"选择已失效"。
  // [失败路径] 只看 selectionIssue 不看 originalSelection 时，新建态的默认选择
  // 也可能被标成失效，用户会被要求重新选择一个本来就没有的选择。
  const persistedSelectionInvalid = Boolean(
    originalSelection && modelSelectionView && modelSelectionView.selectionIssue,
  );
  // [并发] 失效提示的去重键是 automationId + view.revision（INV-24）：只按 automationId
  // 去重会导致模型恢复后又失效时不提示；只按 revision 去重会在同一任务上反复弹。
  // [失败路径] 依赖里包含 modelSelectionView，但真正的门是 ref 里的 noticeKey：
  // effect 会重跑，重复的 toast 由 ref 挡住。
  const invalidSelectionNoticeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!persistedSelectionInvalid || !editing || !modelSelectionView) return;
    const noticeKey = `${editing.automationId}:${modelSelectionView.revision}`;
    if (invalidSelectionNoticeKeyRef.current === noticeKey) return;
    invalidSelectionNoticeKeyRef.current = noticeKey;
    toast(intl.formatMessage({ id: "modelSelection.invalidated.reselect" }), {
      variant: "warning",
      position: "bottom-center",
      dedupeKey: `automation-model-selection-invalidated:${editing.automationId}`,
    });
  }, [editing, intl, modelSelectionView, persistedSelectionInvalid]);
  // [事务] 新建态的"默认模型自动选中"必须满足四个条件同时成立：无 editing、
  // 有 preferred、用户没手动改过、且没有失效选择（INV-23 的补充）。
  // [失败路径] 若允许在有 editing 时也自动填充，会覆盖用户明确保存的（可能已下线）
  // 模型，让"重新选择"的提示失去意义；若忽略 manuallyChanged，用户清空后会被反复填回。
  useEffect(() => {
    if (
      editing ||
      !preferredModelValue ||
      modelManuallyChangedRef.current ||
      persistedSelectionInvalid
    )
      return;
    if (model) return;
    // [并发] 已有值时（model 非空）不覆盖：这说明用户刚刚手动选过，或上一次自动选中
    // 已生效；重复写入会把用户在 View 回来前改的选择冲掉。
    // 旧表单把“默认模型”保存为空值，却又要求提交前必须存在具体候选，
    // 导致初次创建按钮永远禁用。目标 Host ready 后直接选中并固化 preferredSelection。
    modelSelection.current = preferredModelValue;
    setModel(preferredModelValue);
    thoughtManuallyChangedRef.current = false;
    const preferredReasoning =
      modelSelectionView?.preferredSelection?.options?.reasoningLevel ?? "";
    thoughtLevelRef.current = preferredReasoning;
    setThoughtLevel(preferredReasoning);
  }, [editing, model, modelSelectionView, persistedSelectionInvalid, preferredModelValue]);
  // [权衡] 思考档位优先取"模型静态元数据"而不是 host 视图（见原注释）：runtime 的
  // catalog 可能还没投影 thought_level，此时只有静态元数据能正确显示该模型支持推理。
  // [失败路径] 两级都取不到时返回 null，由 buildAutomationThoughtLevelOption 决定
  // 是否隐藏整个控件；返回空对象会让用户看到一个可选但无意义的档位。
  const selectedModelMetadataThoughtOption = useMemo(() => {
    // [失败路径] 没有选中项时返回 null：模型列表还没加载完就计算档位，会拿一个
    // 空 provider/model 去查 Option Specs，得到一个"支持推理"的错误结论。
    if (!selectedModelItem) return null;
    // [失败路径] value 解码失败（历史脏数据或格式版本不一致）时返回 null，
    // 让 thoughtLevelOption 隐藏整个控件，而不是展示一个无法保存的档位。
    const decodedModel = decodeCustomModelValue(selectedModelItem.value);
    if (!decodedModel?.modelName) return null;
    // 与会话 composer 复用同一模型静态事实，避免 workspace runtime catalog 暂未投影
    // thought_level 时，定时任务把支持推理的模型误显示成无思考档位。
    return modelSelectionView
      ? resolveModelThoughtOption({
          modelSelectionView,
          providerId: decodedModel.providerId,
          modelId: decodedModel.modelName,
        })
      : null;
  }, [modelSelectionView, selectedModelItem]);
  // 所选模型的 Option Specs 只来自目标 Host View；不能为预览再创建 deferred Session。
  // [事务] activeThoughtOption 是"静态元数据优先、Host 视图兜底"的结果：两者都缺失时
  // 为 undefined，由 buildAutomationThoughtLevelOption 决定隐藏控件（不显示禁用档位）。
  // [权衡] 不使用 effectiveReasoningLevel 反推档位：它是服务端回显值，
  // 缺省时为空串，反推会得出"该模型不支持推理"的错误结论。
  const activeThoughtOption = selectedModelMetadataThoughtOption ?? undefined;
  const thoughtLevelOption = useMemo(
    () => buildAutomationThoughtLevelOption(activeThoughtOption, effectiveReasoningLevel),
    [activeThoughtOption, effectiveReasoningLevel],
  );

  // [事务] 提交闸门被拆成"上下文可用"与"必填齐全"两层（INV-18）：分开的理由是
  // 错误提示不同——前者要引导用户去连接 Host / 选模型，后者只需在字段旁标红。
  // 合并成一个布尔会让两种完全不同的修复路径共用一条提示。
  // [失败路径] hasValidWorkspace 在编辑态恒为真（INV-07）：任务所属项目可能已从
  // 候选里消失，但用户仍应能改标题或删除这个任务。
  const requiredFieldErrors = useMemo(
    () =>
      resolveAutomationEditRequiredFieldErrors({
        title,
        cronExpr,
        prompt,
      }),
    [cronExpr, prompt, title],
  );
  // [事务] hasValidWorkspace 是"能否提交"的最小必要条件，不含任何字段校验（INV-07）：
  // 与 requiredFieldErrors 分层后，按钮的 disabled 才能区分"去选项目"与"去补标题"。
  const hasValidWorkspace = Boolean(editing || selectedWorkspace);
  // [事务] 六个"与"就是 submissionContextReady 的全部定义（INV-18）：工作区、显式
  // 非空项目、Host ready、模型已选、档位非空、无失效选择。任何一项放宽都会让一次
  // 注定失败的请求通过按钮层，用户要等到执行时才看到错误。
  // [失败路径] 最后的 !selectionIssue 是"持久化选择已失效"的闸门：允许提交会让
  // 用户把一个已下线的模型写回去，任务将永远无法调度。
  const submissionContextReady =
    hasValidWorkspace &&
    (Boolean(editing) || selectedWorkspace !== null) &&
    modelSelectionRead.state.status === "ready" &&
    selectedModelItem !== null &&
    Boolean(effectiveReasoningLevel) &&
    !modelSelectionView?.selectionIssue;
  const canSubmit = submissionContextReady && requiredFieldErrors.length === 0;

  // [权衡] 拆成两层而不是一个布尔：按钮的 disabled 与提示文案需要不同的粒度
  // （"上下文未就绪"要引导，必填缺失要定位到字段），见上方 requiredFieldErrors。
  // [事务] "请求校验"与"读取校验结果"分离：调用时把当前错误集写入 state 让 UI 标红，
  // 同时同步返回布尔值供提交流程短路。只返回布尔不写 state 时，用户看不到是哪一项
  // 没过；只写 state 不返回时，提交仍会继续。
  // [事务] 校验函数只负责"写回可见错误"，返回布尔供提交流程短路：两者必须在
  // 同一次调用里完成，否则会出现"按钮没反应但也没有红框"的无解释失败。
  const requestRequiredFieldValidation = useCallback(
    (source: "save" | "run-now") => {
      setValidationErrors(new Set(requiredFieldErrors));
      // [失败路径] 用 new Set 而不是复用原引用：React 对同一引用不重渲染，
      // 重复点击保存时第二次错误集不会让红框再次出现。
      logger.debug("[AutomationEditView] 提交前校验必填字段", {
        automationId: editing?.automationId ?? null,
        source,
        invalidFields: requiredFieldErrors,
      });
      return requiredFieldErrors.length === 0;
    },
    [editing?.automationId, requiredFieldErrors],
  );

  // [事务] scheduleRule 只在 custom 频率下产出：其它频率由 cronExpr 表达，同时写
  // scheduleRule 会让持久层出现两份互相矛盾的调度定义，读回时以谁为准没有定论。
  // [失败路径] anchorAt 优先沿用原有值：重新计算 Date.now() 会让"每 2 小时"这类
  // 相对调度的相位在下一次保存时整体平移，用户看到执行时间莫名变化。
  const currentScheduleRule = useMemo<ZCodeAutomationScheduleRule | undefined>(
    () =>
      builder.frequency === "custom"
        ? {
            unit: builder.customUnit,
            interval: builder.customInterval,
            hour: builder.hour,
            minute: builder.minute,
            anchorAt: editing?.scheduleRule?.anchorAt ?? Date.now(),
            weekdays: builder.customWeekdays,
            monthDays: builder.customMonthDays,
            // months 仅对 yearly 有意义；其它单位置空，JSON.stringify 会丢弃 undefined。
            months: builder.customUnit === "yearly" ? [builder.customMonth] : undefined,
            monthlyMode: builder.customMonthlyMode,
          }
        : undefined,
    [builder, editing?.scheduleRule?.anchorAt],
  );

  // [失败路径] 缺模型或缺档位时抛错（INV-31）：走到这里说明 canSubmit 已被绕过，
  // 继续构造会写出一条不可执行的任务，且错误会被埋进持久层而无人知晓。
  // [事务] endAt 的三态展开（INV-20）：编辑态永远显式传（null 表示清除），新建态
  // 只在有值时才带字段——新建传 null 会被持久层当成"非法结束时间"。
  // [事务] preserveSessionCreatedSchedule 时不下发 scheduleRule、也不加
  // scheduleEditedByUser（INV-21）：这两个字段一旦出现，就等于宣告用户改过日程，
  // 会永久退出只读保护。
  const buildSubmitInput = useCallback(
    ({ modeValue }: { modeValue: string }): CreateAutomationInput | UpdateAutomationInput => {
      if (!effectiveSelection || !effectiveReasoningLevel) {
        // [失败路径] 抛错而不是返回部分对象（INV-31）：调用方只在 canSubmit 为真时
        // 进入这里，触发说明闸门被绕过，必须快速失败而不是写一条残缺配置。
        throw new Error("Automation model selection is required");
      }
      // [事务] 返回的是持久层载荷，字段语义固定：title/prompt 已 trim，cronExpr 与
      // scheduleRule 互斥（见上方注释），modelSelection 用服务端 effectiveSelection
      // 而不是 UI 的输入值，保证落库值与下拉展示一致。
      return {
        title: title.trim(),
        cronExpr,
        prompt: prompt.trim(),
        // 编辑会话内创建的有限次任务时，不能固定改成循环任务。
        // [事务] recurring 只沿用原值、不在 UI 提供开关：有限次任务（session 内创建）
        // 若被改成循环，会在原定次数耗尽后继续运行，违背用户的明确设置。
        recurring: editing?.recurring ?? true,
        ...(editing ? { endAt: endAt ?? null } : endAt ? { endAt } : {}),
        ...(editing
          ? preserveSessionCreatedSchedule
            ? {}
            : { scheduleRule: currentScheduleRule ?? null }
          : currentScheduleRule
            ? { scheduleRule: currentScheduleRule }
            : {}),
        ...(editing && touchedFields.has("schedule") ? { scheduleEditedByUser: true } : {}),
        mode: modeValue,
        modelSelection: effectiveSelection,
      };
    },
    [
      cronExpr,
      currentScheduleRule,
      editing,
      endAt,
      preserveSessionCreatedSchedule,
      prompt,
      effectiveSelection,
      effectiveReasoningLevel,
      title,
      touchedFields,
    ],
  );

  // [事务] 签名是可用于比较的"规范化快照"（INV-30）：title/prompt 先 trim，
  // schedule 用固定字段顺序序列化并归一化 rule（补齐缺省数组）。
  // [失败路径] 直接 JSON.stringify(currentScheduleRule) 会因 undefined 字段与键序
  // 差异产生不同字符串，导致"什么都没改"也被判成脏。
  const currentEditSignatures = useMemo<AutomationEditFieldSignatures | null>(() => {
    if (!editing) return null;
    return {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule: JSON.stringify({
        cronExpr,
        endAt: endAt ?? null,
        scheduleRule: preserveSessionCreatedSchedule
          ? null
          : normalizeAutomationScheduleRule(currentScheduleRule ?? null),
      }),
      mode,
      thoughtLevel,
      model,
    };
  }, [
    cronExpr,
    currentScheduleRule,
    editing,
    endAt,
    preserveSessionCreatedSchedule,
    mode,
    model,
    prompt,
    thoughtLevel,
    title,
  ]);
  // [并发] 直接赋值 ref（而非 effect）：签名必须在本轮渲染期间就可被 markFieldTouched
  // 读取，放进 effect 会晚一帧，用户"输入后立刻点保存"时 baseline 会记成旧值。
  currentEditSignaturesRef.current = currentEditSignatures;

  // [事务] dirty 的判定需要三个输入（INV-02/INV-03）：touchedFields 决定"哪些字段
  // 算用户动过"，current 是当前值，baseline 是首次触碰时的值。缺 baseline 时
  // 退化为"任一触碰即脏"，会让打开页面后的异步归一化也触发离开保护。
  const changedFields = useMemo(
    () =>
      currentEditSignatures
        ? resolveChangedAutomationEditFields({
            touchedFields,
            current: currentEditSignatures,
            baseline: touchedFieldBaselinesRef.current,
          })
        : [],
    // [并发] 依赖里必须包含 touchedFields，但 baseline 用 ref 读取：
    // 把 baseline 放进依赖需要它参与渲染，而 baseline 只在事件里写，
    // 那会造成"标记脏之后不再重新计算"的漏判。
    [currentEditSignatures, touchedFields],
  );
  // 模型元数据和 cron builder 会在打开页面后异步归一化；只有用户实际操作过的
  // 字段才能触发未保存提示，否则仅打开已有任务再返回也会被误判为修改。
  // [事务] 未保存提示必须同时要求 editing 与 changedFields 非空（INV-14）：新建态
  // 没有可回滚的持久对象，弹"放弃修改？"反而让用户以为内容会被保存。
  const hasUnsavedChanges = Boolean(editing) && changedFields.length > 0;

  // [并发] 提交是一个"六步串行"的临界流程（INV-10）：防重入 → 必填校验 → canSubmit →
  // 选择新鲜度 → 目标解析 → StartPlan 确认 → onSubmit。顺序不可交换：把 canSubmit
  // 提前会让用户看不到具体缺哪个字段；把 StartPlan 提前会在参数还没定稿时就弹付费确认。
  // [失败路径] 选择新鲜度比较用 ref 与 state 的差异（INV-05）：两者不等说明用户刚改完
  // 下拉、对应 View 还没回来，此时保存会写入上一份有效选择，因此直接返回 false 让
  // 用户再点一次，而不是静默写入旧值。
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const submitAutomation = useCallback(
    async (options: { validationSource: "save" | "run-now"; returnToList?: boolean }) => {
      // [并发] saving 是父组件的写状态，本地快速连点时它还没变：因此这层判断只是
      // 第二道闸，真正的同步防重入在上面的 saving 之外由调用方（按钮 disabled）兜。
      // [失败路径] 直接返回 false 而不是等待 saving 变假再继续：排队会让一次双击
      // 变成两次串行提交，第二次覆盖第一次的 idempotency 语义。
      if (saving) return false;
      // [事务] 必填校验必须写回 state 才能让用户看到红框（见 requestRequiredFieldValidation）：
      // 只返回 false 会让"点了保存没反应"变成无解释的静默失败。
      if (!requestRequiredFieldValidation(options.validationSource)) {
        return false;
      }
      // [失败路径] canSubmit 为假时直接返回：它同时覆盖上下文不可用与必填缺失，
      // 此处不再逐项区分——用户已经在上面看到具体原因。
      // [权衡] 不用 toast 再提示一次：字段级红框已经定位到具体输入，重复的浮层
      // 会遮住表单且在移动端挤压可视区域。
      if (!canSubmit) return false;
      // 防止刚改选择尚未取得对应 View 时，快速保存采用上一个输入的有效结果。
      // [并发] 比较的是 ref 与 state 两份值的差异（INV-05）：不等说明用户刚改完
      // 下拉而 React 尚未提交渲染，此时 input 里仍会是上一份 effectiveSelection。
      // [失败路径] 返回 false 而不重试或覆盖：静默写入旧值比"点一次没反应"更糟，
      // 用户会以为新模型已保存，直到下次打开才发现没变。
      if (modelSelection.current !== model || thoughtLevelRef.current !== thoughtLevel)
        return false;
      // [事务] projectId 只在新建且目标项目有 projectId 时下发：编辑态的任务已经
      // 绑定在某个项目里，重复下发会让持久层把它当成"跨项目移动"。
      // [失败路径] 会话型项目（projectId 为 null）不展开该字段，而不是传 null：
      // 持久层把"显式 null"与"未提供"当成两种语义，前者会触发解绑。
      const input: CreateAutomationInput | UpdateAutomationInput = {
        ...(!editing && selectedWorkspace?.projectId
          ? { projectId: selectedWorkspace.projectId }
          : {}),
        // Bugfix: 权限下拉和保存按钮是两个独立控件，快速选择 Plan 后立即保存时，
        // React state 可能还没刷新到 submit 闭包；用 ref 保留最后一次选择，避免落库成默认 build。
        ...buildSubmitInput({
          modeValue: modeRef.current,
        }),
      };
      // [事务] 目标项目在提交边界再算一次（INV-32）：编辑态锁定原项目，新建态才用
      // 当前选择。按钮禁用挡不住回车提交与异步回调，所以这里必须显式拒绝 null。
      // 编辑态锁定原项目;新建态用选中的项目。
      const target = editing
        ? {
            workspacePath: editing.workspacePath,
            workspaceIdentity: editing.workspaceIdentity,
          }
        : selectedWorkspace
          ? {
              workspacePath: selectedWorkspace.workspacePath,
              workspaceIdentity: selectedWorkspace.workspaceIdentity,
            }
          : null;
      // 只禁用按钮无法覆盖快捷键或异步回调；提交边界也必须拒绝无有效项目的新建。
      // [失败路径] 这里返回 false 而不是抛错：没有目标项目是"用户还没选完"的
      // 正常中间态，抛错会变成一条吓人的失败提示。
      // [权衡] 判断放在 StartPlan 确认之前：确认会发起一次远端计费协商，用无效目标
      // 去问用户"是否使用套餐"再失败，等于让用户为一次注定失败的请求做决定。
      if (!target) return false;
      // [事务] StartPlan 只对"新建"或"用户改过模型"的编辑请求确认：未改模型的编辑
      // 沿用已确认过的套餐，重复弹窗会让每次改标题都打断一次付费确认。
      // [失败路径] chosen 为空表示用户取消，必须整体中止（返回 false），不能退回到
      // 原选择继续提交——那会在用户明确拒绝后仍然发起一次可能扣费的请求。
      if (input.modelSelection && (!editing || changedFields.includes("model"))) {
        const chosen = await recommendStartPlan(input.modelSelection);
        if (!chosen) return false;
        input.modelSelection = chosen;
      }
      // [事务] trace 的三个出口必须互斥且都恰好一次（INV-33）：ok → complete、
      // 业务拒绝 → reject、抛错 → fail 并原样重抛（让上层展示错误）。
      // [失败路径] 不 catch 只是为了埋点而吞掉异常：吞掉会让用户以为保存成功。
      const trace = startUserAction({
        featureId: "automation.lifecycle",
        action: editing ? "update" : "create",
        trigger: "button",
        workspaceKind: editing?.workspaceIdentity?.trim() ? "remote" : "local",
        automationKind: "scheduled",
      });
      try {
        // [并发] onSubmit 期间用户仍可能改动表单，但 input 已经是一份快照：
        // 提交后不再读任何 state，保证"落库的内容"与"发出去的内容"完全一致。
        const ok = await onSubmit({ input, ...target });
        // [事务] 只有成功才 onBack（INV-11）：失败时保留页面与用户输入，让用户修正后
        // 重试；提前离开会让"保存失败"看起来像"保存成功但列表没刷新"。
        // [权衡] returnToList=false 用于"保存并运行"：那条路径不离开页面，只刷新历史。
        if (ok) {
          trace.complete({ resultSource: "platform_result" });
          if (options?.returnToList !== false) onBack();
        } else {
          trace.reject({ resultSource: "platform_result" });
        }
        return ok;
      } catch (error) {
        // [失败路径] 先 fail 再原样 rethrow：埋点拿到的 failureStage 只有这里能提供，
        // 而错误本身必须交给父组件（它决定展示哪种提示与是否重试）。
        trace.fail({ failureStage: "automation_save" });
        throw error;
      }
    },
    [
      buildSubmitInput,
      changedFields,
      recommendStartPlan,
      canSubmit,
      editing,
      onBack,
      onSubmit,
      requestRequiredFieldValidation,
      saving,
      model,
      thoughtLevel,
      selectedWorkspace?.workspaceIdentity,
      selectedWorkspace?.workspacePath,
      selectedWorkspace?.projectId,
    ],
  );

  // [事务] 表单提交只负责 preventDefault 后转调 submitAutomation：把"原生表单事件"
  // 与"业务提交"分开，回车/点击两条路径才不会各自实现一遍校验与埋点。
  const handleSubmit = async (event: FormEvent) => {
    // [失败路径] preventDefault 必须在 await 之前同步执行：放到 await 之后时，
    // 原生表单已经完成导航，页面会整页刷新并丢失所有草稿。
    event.preventDefault();
    await submitAutomation({ validationSource: "save" });
  };

  // [并发] 防重入的 ref 必须在 await 之前置位（INV-12）：双击的两次事件在同一 tick 内
  // 先后执行，state 还没重渲染，只有 ref 能挡住第二次。
  // [失败路径] finally 里无条件复位 ref 与 state：保存失败后按钮必须能再次点击，
  // 否则用户被永久卡在"运行中"的禁用态。
  const handleSaveAndRun = useCallback(async () => {
    // [事务] 三个前置条件缺一不可：没有 editing 就没有可运行的持久对象，没有
    // onRunNow 就无法触发运行，ref 为真说明上一次流程还没结束。任何一项缺失时
    // 静默返回而不是禁用按钮，因为按钮本身已按同样的条件计算 disabled。
    if (!editing || !onRunNow || saveAndRunPendingRef.current) return;
    saveAndRunPendingRef.current = true;
    setSaveAndRunPending(true);
    // [权衡] 日志里带 changedFields 而不是整个表单：排查"为什么没运行"时，关键是
    // 知道本次保存涉及哪些字段（是否触发了 StartPlan 确认），而不是全部内容。
    logger.debug("[AutomationEditView] 保存并立即运行开始", {
      automationId: editing.automationId,
      changedFields,
    });
    try {
      // [事务] saveAndRunAutomation 是"先保存成功再运行"的唯一实现（INV-13）：
      // 保存返回 false 时它直接短路，run 不会被调用；把顺序写反会让用户看到一次
      // 用旧配置跑出来的结果，而表单里的修改还没落库。
      // [失败路径] run 回调透传 editing 而不是 automationId：运行需要 workspace
      // 与 model 快照，只传 id 会让父组件再查一次刚被保存覆盖过的对象。
      const completed = await saveAndRunAutomation(
        () =>
          submitAutomation({
            returnToList: false,
            validationSource: "run-now",
          }),
        () => onRunNow(editing),
      );
      logger.debug("[AutomationEditView] 保存并立即运行结束", {
        automationId: editing.automationId,
        completed,
      });
    } finally {
      // [并发] ref 与 state 必须在同一个 finally 里复位：任何一个漏掉都会让按钮
      // 永远处于 pending（ref 漏 → 后续点击全部被吞；state 漏 → 按钮永久 disabled）。
      saveAndRunPendingRef.current = false;
      setSaveAndRunPending(false);
    }
  }, [changedFields, editing, onRunNow, submitAutomation]);

  // [事务] 返回路径分两支（INV-14）：没有未保存改动直接离开；否则必须等用户在
  // 统一确认弹窗里选"丢弃"。
  // [失败路径] 弹窗返回 false（取消/关闭）时不做任何事——尤其不能"顺手"保存：
  // 用户点的是返回，隐式保存会让一次误操作产生持久副作用。
  const handleBackClick = useCallback(async () => {
    logger.debug("[AutomationEditView] 返回前检查未保存更改", {
      automationId: editing?.automationId ?? null,
      touchedFields: [...touchedFields],
      changedFields,
    });
    if (!hasUnsavedChanges) {
      // [事务] 无改动时直接离开，不弹确认框：这是"打开即返回"的最常见路径，
      // 多一次点击会被用户感知成卡顿。
      onBack();
      return;
    }

    // 定时任务曾单独维护“保存 / 放弃修改”弹窗，与闲时任务的确认弹窗
    // 尺寸和动作持续漂移；统一复用远程 Automation presentation，仅保留“取消 / 丢弃”语义。
    // [事务] showKeyboardHints 关闭是刻意的：这里只有一个破坏性动作，回车默认确认
    // 会让用户"手滑放弃修改"，确认必须是一次显式点击。
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "automations.unsaved.title" }),
      description: intl.formatMessage({
        id: "automations.unsaved.description",
      }),
      confirmLabel: intl.formatMessage({
        id: "automations.unsaved.discard",
      }),
      confirmVariant: "destructive",
      showCloseButton: true,
      showKeyboardHints: false,
      presentation: "automation-confirmation",
    });
    logger.debug("[AutomationEditView] 未保存更改确认结果", {
      automationId: editing?.automationId ?? null,
      discarded: confirmed,
    });
    if (confirmed) onBack();
  }, [
    changedFields,
    confirmDialog,
    editing?.automationId,
    hasUnsavedChanges,
    intl,
    onBack,
    touchedFields,
  ]);

  // [事务] 切 tab 只改视图位置，不动草稿：这也是"新建任务也能看空历史"的原因
  // （原注释）：disabled 的 trigger 会让同一组件在不同模式下表现不一致。
  // [并发] runsPage 不在这里复位：历史刷新后由 runsCurrentPage 收敛（INV-15），
  // 在这里 setPage(1) 会因为 effect 顺序产生一次多余渲染。
  const handleTabChange = useCallback(
    (nextTab: AutomationSettingsHistoryTab) => {
      // 新建定时任务曾直接禁用 History trigger，和闲时任务可查看空历史的交互不一致。
      logger.debug("[AutomationEditView] 切换设置页签", {
        automationId: editing?.automationId ?? null,
        nextTab,
        willLoadRuns: nextTab === "history" && Boolean(editing),
      });
      // [并发] 只写 tab，不在这里触发加载：加载由依赖 [tab, automationId] 的
      // effect 统一负责，双入口会让每次切换发两次相同的请求。
      setTab(nextTab);
    },
    [editing],
  );

  // [事务] runs 与 runsLoading 都从父级缓存读取（runsEntry），本组件不持有第二份
  // 运行历史：保存并运行后会由父级刷新缓存，本地复制会让两条数据源在一帧内不一致。
  // [失败路径] 缓存缺失时退回空数组而不是抛错：首帧尚未请求时这是正常状态，
  // 抛错会让整个设置页白屏。
  const runs = runsEntry?.runs ?? [];
  // [权衡] loading 只在缓存 entry 的 status 上判断，不看 runs.length：
  // "已加载但确实没有记录"与"正在加载"必须区分，否则空态与转圈会互相闪烁。
  const runsLoading = runsEntry?.status === "loading";
  // 运行历史客户端分页：数据已整份加载，这里按页切片展示。删除后条数变化时把页码收敛到有效范围。
  // [失败路径] 收敛必须是"计算值"而不是"写回 state"（INV-15）：写回会触发额外渲染，
  // 且在"第 3 页删到只剩 1 页"时产生一次 setState-in-render 警告。
  // [权衡] totalPages 用 Math.max(1, ...) 保证空列表也有 1 页：0 页会让分页控件
  // 计算出 NaN 的偏移量。
  const runsTotalPages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  const runsCurrentPage = Math.min(runsPage, runsTotalPages);
  // [失败路径] 切片用"收敛后的页码"而不是 runsPage：删除最后一页的最后一条后，
  // runsPage 仍指向已不存在的页，直接切片会得到空数组并渲染成"没有运行记录"。
  const pagedRuns = runs.slice(
    (runsCurrentPage - 1) * RUNS_PAGE_SIZE,
    runsCurrentPage * RUNS_PAGE_SIZE,
  );
  // [事务] 页码序列由纯函数生成（buildRunsPageItems）：省略号位置与相邻页码数
  // 属于展示策略，放在渲染里内联会让"当前页在两端"的分支难以测试。
  const runsPageItems = buildRunsPageItems(runsCurrentPage, runsTotalPages);
  // [事务] editStatus 只在编辑态解析（INV-29）：新建态没有生命周期，
  // 若用 enabled 兜底推导会显示一个"待启用"标签，误导用户以为任务已存在。
  // [失败路径] 解析结果直接喂给两张映射表，缺项会回落到 unknown 而不是崩溃——
  // 服务端新增状态时旧客户端必须仍能渲染列表。
  const editStatus = editing ? resolveAutomationStatusKind(editing) : null;
  // [事务] 两个"显示条件"分别对应两种页头操作集合：编辑态有更多操作（运行/启停/删除），
  // 新建态只有创建。它们都要求 tab === settings，因为 history tab 不应出现保存按钮。
  const showEditingSettingsActions = Boolean(editing && tab === "settings");
  // [事务] 新建态与编辑态的可视操作集合必须互斥：同时渲染两套会在一帧里出现
  // 两个提交按钮（编辑按钮用的是 form 关联，新建按钮直接 onClick 语义）。
  // [失败路径] 不看 tab 时，切到历史页仍会显示"创建"按钮，用户会在看列表时
  // 误触而创建一条空任务。
  const showCreateSettingsAction = !editing && tab === "settings";

  return (
    <>
      <div className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col gap-6")}>
        <SettingsBreadcrumbReporter
          // [事务] 面包屑只有一项（当前任务标题）：编辑页是二级页面，返回由
          // onSectionSelect 统一走未保存保护（INV-14），不能直接用 history.back。
          items={[
            {
              label: editing?.title ?? intl.formatMessage({ id: "automations.edit.newTask" }),
            },
          ]}
          onSectionSelect={() => void handleBackClick()}
        />

        <div className="space-y-1.5">
          <h1
            data-testid="automation-edit-title"
            // [权衡] 标题文案由 editing 决定而不是由路由参数：同一路由承载新建与编辑，
            // 用 state 判断可以避免"编辑对象加载失败时标题还显示编辑"的错位。
            className="text-ui-xl font-semibold text-foreground"
          >
            {intl.formatMessage({
              id: editing ? "automations.form.editTitle" : "automations.form.createTitle",
            })}
          </h1>
          <p data-testid="automation-edit-subtitle" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: editing ? "automations.edit.editSubtitle" : "automations.edit.createSubtitle",
            })}
          </p>
        </div>

        {/* tab + 右侧操作 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AutomationSettingsHistoryTabs
            value={tab}
            // [事务] 两个 tab 标签都走 intl 而不是常量：与设置页其它入口共用同一批 key，
            // 硬编码会让语言切换后只更新一半界面。
            // [并发] onValueChange 直连 handleTabChange，不在 JSX 里内联 setTab：
            // 内联会绕过埋点与"历史页是否需要加载"的判断。
            settingsLabel={intl.formatMessage({
              id: "automations.edit.tab.settings",
            })}
            historyLabel={intl.formatMessage({
              id: "automations.edit.tab.history",
            })}
            onValueChange={handleTabChange}
          />

          <div className="flex items-center gap-1.5">
            {editing ? (
              <>
                {showEditingSettingsActions ? (
                  <button
                    type="submit"
                    form="automation-edit-form"
                    // [事务] 保存按钮用 form 属性而不是 onClick：让浏览器的原生提交
                    // 语义（回车、表单校验）与点击走同一条路径，减少一个入口就少一处漂移。
                    // [失败路径] disabled 同时看"上下文可用"与 saving：任一为假都不可点，
                    // 但 reason 不同（见 submissionContextReady 的拆分）。
                    data-testid={TID_AUTOMATION_FORM_SUBMIT}
                    className="inline-flex h-8 items-center rounded-lg border-0 bg-white px-3 text-ui-base font-medium text-black shadow-none outline-none transition-colors hover:bg-white/90 focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-40"
                    disabled={!submissionContextReady || saving}
                  >
                    {intl.formatMessage({
                      id: saving ? "automations.form.saving" : "automations.form.save",
                    })}
                  </button>
                ) : null}
                {showEditingSettingsActions && onRunNow ? (
                  <button
                    type="button"
                    data-testid={TID_AUTOMATION_RUN_NOW}
                    // [事务] 运行按钮的 disabled 多看了 saveAndRunPending：保存并运行的
                    // 整个流程（保存 + 触发）期间都要禁用，只判 saving 会在两次 await
                    // 之间留下一个可点击的窗口（INV-12）。
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border-0 bg-white/[0.06] px-3 text-ui-base font-medium text-foreground shadow-none outline-none transition-colors hover:bg-white/10 focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-foreground-subtlest disabled:opacity-40"
                    disabled={!submissionContextReady || saving || saveAndRunPending}
                    onClick={() => void handleSaveAndRun()}
                  >
                    <AutomationRunNowIcon className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "automations.runNow" })}
                  </button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "automations.moreActions",
                      })}
                      // [权衡] 用 data-[state=open] 而不是 hover 态表达"菜单已展开"：
                      // Radix 会把焦点留在 trigger 上，没有这个态时展开后看不出当前项。
                      className="flex size-8 items-center justify-center rounded-lg border-0 bg-white/[0.06] text-foreground-subtle shadow-none outline-none transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground focus-visible:ring-0"
                    >
                      <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px]">
                    {/* 终态任务(completed/failed)不展示 pause/resume：Resume 对终态无意义，改存即复活。 */}
                    {onToggle &&
                    editing.lifecycleStatus !== "completed" &&
                    editing.lifecycleStatus !== "failed" ? (
                      <DropdownMenuItem
                        // [事务] 启停只翻 enabled，不碰 lifecycleStatus（INV-22）：
                        // 由持久层在下次调度时重算状态，UI 不预判"暂停即 paused"。
                        className="gap-1"
                        onSelect={() => onToggle(editing, !editing.enabled)}
                      >
                        <span className="flex size-5 items-center justify-center">
                          {editing.enabled ? (
                            <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                          ) : (
                            <AutomationContinueIcon className="size-4" aria-hidden="true" />
                          )}
                        </span>
                        {intl.formatMessage({
                          id: editing.enabled ? "automations.pause" : "automations.resume",
                        })}
                      </DropdownMenuItem>
                    ) : null}
                    {onDelete ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                          // [失败路径] 删除不经本地确认弹窗：确认由父组件统一负责，
                          // 这里再弹一次会出现"两级确认"，而用户在第二级取消后
                          // 第一级的乐观删除已经发生，列表会短暂少一行。
                          onSelect={() => onDelete(editing)}
                        >
                          <AutomationTrashIcon />
                          {intl.formatMessage({ id: "automations.delete" })}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : showCreateSettingsAction ? (
              <Button
                type="submit"
                form="automation-edit-form"
                variant="default"
                size="lg"
                data-testid={TID_AUTOMATION_FORM_SUBMIT}
                // [失败路径] 新建按钮判 canSubmit（含必填），编辑按钮判 submissionContextReady：
                // 编辑态允许先保存"改了一半"的标题，必填缺失由字段级红框提示，不阻塞
                // 其它字段的保存——这是两种页面刻意不同的宽严策略。
                disabled={!canSubmit || saving}
              >
                {intl.formatMessage({
                  id: saving ? "automations.form.saving" : "automations.edit.createButton",
                })}
              </Button>
            ) : null}
          </div>
        </div>

        {tab === "settings" ? (
          <form
            id="automation-edit-form"
            // [事务] 表单 id 与上方按钮的 form 属性成对绑定：id 一旦改动，保存按钮
            // 会静默失效（浏览器找不到关联表单），因此两处必须一起改。
            className="space-y-4"
            // [失败路径] 统一在 onSubmit 里 preventDefault：回车提交与点击提交走同一
            // 条路径，避免出现"点按钮能保存、按回车整页刷新"的分叉。
            onSubmit={(e) => void handleSubmit(e)}
          >
            {editStatus ? (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <div className="text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({ id: "automations.form.status.label" })}
                </div>
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                  {/* Bug 原因：状态圆点与胶囊沿用了偏大的 8px / 36px 尺寸，未遵循 6px glyph + 20px frame 的规格。 */}
                  <span className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-card pl-2 pr-4 text-ui-base leading-5 text-foreground">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          AUTOMATION_STATUS_DOT_CLASS[editStatus],
                        )}
                        // [失败路径] aria-hidden 必须与文案分离：圆点只是颜色编码，
                        // 让读屏软件读到一个空 span 会打断状态文案的朗读顺序。
                        aria-hidden="true"
                      />
                    </span>
                    <span className="min-w-0 truncate">
                      {intl.formatMessage({
                        id: `automations.lifecycle.${editStatus}`,
                      })}
                    </span>
                  </span>
                </div>
              </div>
            ) : null}

            {/* Task title */}
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <label
                className="text-ui-base font-normal leading-5 text-foreground-subtle"
                // [事务] htmlFor 必须与下方 Input 的 id 一致：label 点击聚焦依赖
                // 原生关联，改成包裹写法会改变 flex 布局并丢失点击聚焦。
                htmlFor="automation-title"
              >
                {intl.formatMessage({ id: "automations.form.title.label" })}
              </label>
              {/* 修复原因：Task title 是标准 Input，不能局部移除全局描边语义。 */}
              <Input
                id="automation-title"
                // [权衡] size="lg" 与下方 textarea 的高度档位对齐：两者在小屏上
                // 上下相邻，尺寸不一致会让用户误以为标题是单行内联输入。
                size="lg"
                data-testid={TID_AUTOMATION_FORM_TITLE}
                value={title}
                // [事务] 输入时必须同时做四件事：标记 title 已触碰（INV-02）、记 baseline
                // （INV-03）、清掉必填错误、更新值。少任何一步都会出现"有错误提示但字已经
                // 填了"或"改了却不算脏"。
                // [失败路径] 用 e.target.value 而不是受控回读：输入法组字阶段回读会丢光标。
                onChange={(e) => {
                  titleTouchedRef.current = true;
                  markFieldTouched("title");
                  clearRequiredFieldValidation("title");
                  setTitle(e.target.value);
                }}
                placeholder={intl.formatMessage({
                  id: "automations.edit.titlePlaceholder",
                })}
                aria-invalid={validationErrors.has("title") && !title.trim()}
                // [事务] aria-invalid 以"错误集 + 实际为空"双条件判定：用户清空又输入后，
                // 错误集可能还没被清（异步清），只看错误集会让红框比实际内容多停一帧。
                // [失败路径] maxLength 只做前端兜底，不能替代提交时的 trim 校验：
                // 输入法可能绕过长度限制或粘贴超长文本，持久层仍需按长度拒绝。
                maxLength={200}
                className={cn(
                  "h-9 rounded-xl bg-input px-3 text-foreground",
                  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
                )}
              />
            </div>

            {/* 会话来源的旧 cron 无法可靠回显；删除后切换到标准 UI 调度编辑流程。 */}
            {preserveSessionCreatedSchedule ? (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "automations.form.schedule.label",
                  })}
                </label>
                <div
                  data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                  // [事务] 只读预览区仍保留删除按钮（INV-21 的出口）：会话来源的旧 cron
                  // 唯一的安全编辑方式就是"删掉后重新添加"，去掉删除会让用户彻底无法改日程。
                  className="relative flex h-9 items-center overflow-hidden rounded-xl border border-input-border bg-input px-2 pr-9 text-ui-base leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused"
                >
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({ id: "automations.frequency.custom" })}
                  </span>
                  <button
                    type="button"
                    data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                    onClick={handleRemoveSchedule}
                    // [事务] 删除按钮的点击只走 handleRemoveSchedule：它内部会同时
                    // 标记脏值与清错误（INV-09），在这里另加 setState 会让两条路径分叉。
                    className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                    aria-label={intl.formatMessage({ id: "common.delete" })}
                  >
                    <AutomationTrashIcon />
                  </button>
                </div>
              </div>
            ) : (
              <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
                <label className="inline-flex items-center gap-1.5 text-ui-base font-normal leading-5 text-foreground-subtle">
                  {intl.formatMessage({
                    id: "automations.form.schedule.label",
                  })}
                </label>
                {scheduleRemoved ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid={TID_AUTOMATION_SCHEDULE_ADD}
                        aria-invalid={scheduleRemoved && validationErrors.has("schedule")}
                        // [失败路径] 红框只在"已移除 + 有必填错误"时出现：刚删除时
                        // handleRemoveSchedule 刻意不清错误集（INV-09 的另一半），
                        // 用户看到的是一个"需要补日程"的引导态而不是报错态。
                        className={cn(
                          "flex h-9 w-full items-center gap-1 rounded-xl border bg-input px-2 text-ui-base font-normal leading-5 text-foreground-subtle transition-colors hover:border-input-border-hover hover:text-foreground focus-visible:border-input-border-focused focus-visible:bg-input-focused data-[state=open]:border-input-border-focused data-[state=open]:bg-input-focused data-[state=open]:text-foreground",
                          validationErrors.has("schedule")
                            ? "!border-destructive !ring-2 !ring-destructive/20"
                            : "border-input-border",
                        )}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <AutomationAddScheduleIcon aria-hidden="true" />
                        </span>
                        {intl.formatMessage({
                          id: "scheduledPreview.addSchedule",
                        })}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" sideOffset={4} className="w-[148px] p-1.5">
                      {FREQUENCIES.map((frequency) => (
                        <DropdownMenuItem
                          key={frequency}
                          data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, frequency)}
                          // raw 白色 5% 只在深色菜单可见，Light 下高亮状态近似透明。
                          className="min-h-8 px-2 py-2 text-ui-base text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground"
                          onSelect={() => {
                            // [事务] 三条路径都在这里收敛（INV-09）：custom 只开对话框、
                            // 其它频率写 builder 并清 removed/错误。custom 分支必须 return，
                            // 否则会先写一个空频率再打开对话框，label 会短暂显示成空白。
                            markFieldTouched("schedule");
                            if (frequency === "custom") {
                              setCustomRepeatOpen(true);
                              return;
                            }
                            // [权衡] weekdays 重置为一到五而不是保留旧选择：用户从 weekly
                            // 切到 weekdays 时，之前勾的周末会让"工作日"名不副实。
                            setBuilder((previous) => ({
                              ...previous,
                              frequency,
                              ...(frequency === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                            }));
                            setScheduleRemoved(false);
                            clearRequiredFieldValidation("schedule");
                          }}
                        >
                          {intl.formatMessage({
                            id: `automations.frequency.${frequency}`,
                          })}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <>
                    {/* Bugfix：调度栏原先使用 min-height、换行布局和全行摘要，新增 tag 后会被第二行撑高。
                        恢复全局 Input 的 1px 描边后，用 7px 左内边距抵消边框占位，保持首个 tag
                        距外边缘仍为 8px；tag 增加上下各 1px padding 后仍在 36px input 内垂直居中。 */}
                    <div className="relative flex h-9 flex-nowrap items-center gap-1 overflow-hidden rounded-xl border border-input-border bg-input py-1 pl-[7px] pr-9 text-ui-base leading-5 text-foreground transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
                      <Select
                        value={builder.frequency}
                        onValueChange={(value) => {
                          // Radix Select 在编辑旧 cron 的控件注册阶段可能发出空值，不能覆盖已解析频率。
                          // [失败路径] 非法值只 warn 并 return（保留已解析频率）：把它写进
                          // builder 会让 buildCronExpr 生成 "  * * * *" 这类非法表达式，
                          // 任务保存成功却永不触发。
                          // [事务] custom 分支同样必须先 return 再置 removed：否则会先
                          // 把频率改成 custom，取消对话框后调度栏停留在空的 custom 配置。
                          if (!isCronFrequency(value)) {
                            logger.warn("[AutomationEditView] 忽略非法的频率选择值", {
                              automationId: editing?.automationId,
                              cronExpr: editing?.cronExpr,
                              value,
                            });
                            return;
                          }
                          markFieldTouched("schedule");
                          if (value === "custom") {
                            setCustomRepeatOpen(true);
                            return;
                          }
                          setBuilder((prev) => ({
                            ...prev,
                            frequency: value,
                            ...(value === "weekdays" ? { weekdays: [1, 2, 3, 4, 5] } : {}),
                          }));
                        }}
                      >
                        {/* 修复原因：频率触发器曾写死深色值，导致浅色主题下对比失真；
                            改用 hover/selected 语义 token，并在 20px 行高外增加上下各 1px padding。 */}
                        <SelectTrigger
                          variant="ghost"
                          data-testid={TID_AUTOMATION_FREQUENCY_SELECT}
                          // [权衡] h-auto + py-px 是为了让 20px 行高的 tag 在 36px 输入框内
                          // 垂直居中（原注释）：固定 h-8 会让 tag 贴顶，与右侧删除按钮错位。
                          className="h-auto min-w-24 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                          indicator={<AutomationChevronDownIcon />}
                        >
                          <SelectValue>
                            {intl.formatMessage({
                              id: `automations.frequency.${builder.frequency}`,
                            })}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {FREQUENCIES.map((freq) => (
                            <SelectItem
                              key={freq}
                              value={freq}
                              data-testid={testId(TID_AUTOMATION_FREQUENCY_OPTION, freq)}
                            >
                              {intl.formatMessage({
                                id: `automations.frequency.${freq}`,
                              })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {builder.frequency === "monthly" ? (
                        <Select
                          value={String(builder.dayOfMonth)}
                          onValueChange={(value) => {
                            // [事务] 30/31 号的月份差异由 daysInMonth 在 Monthly/Day 选择器里
                            // 收敛（INV-27）；这里只负责把字符串转成数字并标脏。
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({
                              ...prev,
                              dayOfMonth: Number(value),
                            }));
                          }}
                        >
                          <SelectTrigger
                            variant="ghost"
                            // [事务] 月内日选择器复用 tag 样式而不是独立输入框：
                            // 它与频率 tag 在同一行，任何尺寸差异都会被视觉放大成错位。
                            className="h-auto w-auto rounded-full border-0 bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected aria-expanded:bg-selected"
                            indicator={<AutomationChevronDownIcon />}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-60">
                            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                              <SelectItem key={day} value={String(day)}>
                                {intl.formatMessage(
                                  { id: "automations.form.dayOfMonth" },
                                  { day: String(day) },
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}

                      {builder.frequency === "weekly" ? (
                        <WeekdayPicker
                          weekdays={builder.weekdays}
                          intl={intl}
                          // [事务] onChange 收到的已经是"新集合"，这里不再二次过滤：
                          // 空集合的防护在 WeekdayPicker 内部完成（INV-28），两处都判会让
                          // 最后一个选项如何"取消不掉"的逻辑分散在两个组件里。
                          onChange={(weekdays) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({ ...prev, weekdays }));
                          }}
                        />
                      ) : null}

                      {/* Bugfix：重复周期曾写死 #F8F8F8 且三段 tag 圆角不一致；统一语义文字色与 pill 圆角。 */}
                      {builder.frequency === "custom" ? (
                        <button
                          type="button"
                          // [权衡] 用 button 而不是再次打开 Select：自定义重复有多个
                          // 维度（间隔/单位/星期/月内日），塞进单选会丢失组合语义。
                          // 视觉重构误删了 E2E 稳定选择器，导致保存后无法重新打开 Custom Repeat 验证复原值。
                          // [失败路径] 这里只开对话框、不改 builder：确认前的一切改动都必须
                          // 停留在对话框草稿里（INV-25），否则"打开后取消"也会污染表单。
                          data-testid={TID_AUTOMATION_CUSTOM_REPEAT_EDIT}
                          onClick={() => setCustomRepeatOpen(true)}
                          className="inline-flex h-auto items-center gap-0.5 rounded-full bg-hover py-px pl-2 pr-0.5 text-ui-base leading-5 text-foreground hover:bg-selected"
                        >
                          <span>
                            {intl.formatMessage(
                              {
                                id: "automations.customRepeat.compactFrequency",
                              },
                              {
                                interval: String(builder.customInterval),
                                unit: intl.formatMessage({
                                  id: `automations.customRepeat.unit.${
                                    builder.customUnit === "minute"
                                      ? "minute"
                                      : builder.customUnit === "daily"
                                        ? "day"
                                        : builder.customUnit === "weekly"
                                          ? "week"
                                          : builder.customUnit === "monthly"
                                            ? "month"
                                            : builder.customUnit === "yearly"
                                              ? "year"
                                              : "hour"
                                  }`,
                                }),
                              },
                            )}
                          </span>
                          <AutomationChevronDownIcon />
                        </button>
                      ) : null}

                      {builder.frequency !== "custom" && builder.frequency !== "hourly" ? (
                        <>
                          {/* 修复原因：连接词曾单独使用二级色，和相邻 tag 主文字形成错误的高亮断层。 */}
                          <span className="text-foreground">
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <TimeOfDayPicker
                            hour={builder.hour}
                            minute={builder.minute}
                            ariaLabel={intl.formatMessage({
                              id: "automations.form.schedule.label",
                            })}
                            // [事务] 一次性接收 hour 与 minute（而不是两个回调）：
                            // 选择器内部两列同时可见，分开回调会让父级合并两次更新，
                            // 出现"改了分钟又把小时写回旧值"的竞态。
                            onChange={(hour, minute) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({ ...prev, hour, minute }));
                            }}
                          />
                          <span className="whitespace-nowrap text-foreground-subtle">
                            {formatGmtOffset()}
                          </span>
                        </>
                      ) : null}

                      {builder.frequency === "hourly" ? (
                        <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.minutePrefix",
                            })}
                          </span>
                          <Select
                            value={String(builder.minute)}
                            onValueChange={(value) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({
                                ...prev,
                                minute: Number(value),
                              }));
                            }}
                          >
                            <SelectTrigger
                              variant="ghost"
                              className="h-auto w-14 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                            >
                              <SelectValue>{pad2(builder.minute)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {Array.from({ length: 60 }, (_, value) => (
                                <SelectItem key={value} value={String(value)}>
                                  {pad2(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.minuteSuffix",
                            })}
                          </span>
                        </div>
                      ) : null}

                      {builder.frequency === "custom" && builder.customUnit === "hourly" ? (
                        <div className="flex items-center gap-1 text-ui-base leading-5 text-foreground">
                          <span>
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <Select
                            value={String(builder.minute)}
                            onValueChange={(value) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({
                                ...prev,
                                minute: Number(value),
                              }));
                            }}
                          >
                            <SelectTrigger
                              variant="ghost"
                              className="h-auto w-16 rounded-full border-0 bg-hover py-px pl-2 text-ui-base leading-5 tabular-nums hover:bg-selected"
                            >
                              <SelectValue>{pad2(builder.minute)}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-60">
                              {Array.from({ length: 60 }, (_, value) => (
                                <SelectItem key={value} value={String(value)}>
                                  {pad2(value)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span>
                            {intl.formatMessage({
                              id: "automations.customRepeat.minutes",
                            })}
                          </span>
                        </div>
                      ) : null}

                      {builder.frequency === "custom" && builder.customUnit === "yearly" ? (
                        <MonthDayPicker
                          month={builder.customMonth}
                          day={builder.customMonthDays[0] ?? 1}
                          intl={intl}
                          onChange={(month, day) => {
                            markFieldTouched("schedule");
                            setBuilder((prev) => ({
                              ...prev,
                              customMonth: month,
                              customMonthDays: [day],
                            }));
                          }}
                        />
                      ) : null}

                      {builder.frequency === "custom" &&
                      builder.customUnit !== "hourly" &&
                      builder.customUnit !== "minute" ? (
                        <>
                          <span className="text-foreground">
                            {intl.formatMessage({
                              id: "automations.form.schedule.at",
                            })}
                          </span>
                          <TimeOfDayPicker
                            hour={builder.hour}
                            minute={builder.minute}
                            // [失败路径] 这里不传 ariaLabel：同一行已有可见的连接词
                            // 与 GMT 偏移，重复的 aria-label 会让读屏播报两次时间语义。
                            onChange={(hour, minute) => {
                              markFieldTouched("schedule");
                              setBuilder((prev) => ({ ...prev, hour, minute }));
                            }}
                          />
                          <span className="text-foreground-subtle">{formatGmtOffset()}</span>
                        </>
                      ) : null}

                      {schedulePreview ? (
                        <span
                          data-testid={TID_AUTOMATION_SCHEDULE_PREVIEW}
                          className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle sm:ml-1"
                        >
                          {schedulePreview}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        data-testid={TID_AUTOMATION_SCHEDULE_DELETE}
                        onClick={handleRemoveSchedule}
                        className="absolute right-2 top-2 flex size-5 items-center justify-center text-foreground-subtle transition-colors hover:text-foreground"
                        aria-label={intl.formatMessage({ id: "common.delete" })}
                      >
                        <AutomationTrashIcon />
                      </button>
                    </div>
                  </>
                )}

                <CustomRepeatDialog
                  builder={builder}
                  endAt={endAt}
                  intl={intl}
                  open={customRepeatOpen}
                  // [事务] onOpenChange 直接接 setState：对话框内部不维护 open 的镜像，
                  // 关闭动作只能由这里统一收口，否则两个真相会不同步。
                  onOpenChange={setCustomRepeatOpen}
                  onConfirm={({
                    interval,
                    unit,
                    weekdays,
                    monthDays,
                    monthlyMode,
                    endAt: nextEndAt,
                  }) => {
                    // [事务] 确认是一次性"整包替换"（INV-26 的反面）：interval/unit/
                    // weekdays/monthDays/monthlyMode 必须一起写，逐个 setBuilder 会让
                    // 中间态被 buildCronExpr 读到，生成一个短暂的错误表达式。
                    // [事务] endAt 由对话框一并返回（可为 undefined 表示"不结束"）：
                    // 结束时间属于日程的一部分，分开保存会出现"周期已改、结束时间没跟上"。
                    markFieldTouched("schedule");
                    setScheduleRemoved(false);
                    clearRequiredFieldValidation("schedule");
                    setBuilder((prev) => ({
                      ...prev,
                      frequency: "custom",
                      customInterval: interval,
                      customUnit: unit,
                      customWeekdays: weekdays,
                      customMonthDays: monthDays,
                      customMonthlyMode: monthlyMode,
                    }));
                    setEndAt(nextEndAt);
                  }}
                />
              </div>
            )}

            {/* Instructions + 底部项目/模型选择器 */}
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <label
                className="text-ui-base font-normal leading-5 text-foreground-subtle"
                // [事务] 必填提示出现在 Composer 外壳而不是 textarea 自身：外壳负责
                // 描边与错误态，textarea 只负责内容，拆开才能同时承载工具栏与多行输入
                // 而不复制样式。
                // [失败路径] htmlFor 指向 textarea 的 id，点击标签必须能聚焦输入区。
                htmlFor="automation-prompt"
              >
                {intl.formatMessage({ id: "automations.form.prompt.label" })}
              </label>
              <AutomationInstructionsComposer
                invalid={validationErrors.has("prompt") && !prompt.trim()}
              >
                <AutomationInstructionsTextarea
                  id="automation-prompt"
                  // [事务] id 与 label 的 htmlFor 成对绑定，同样不能单方面修改。
                  data-testid={TID_AUTOMATION_FORM_PROMPT}
                  value={prompt}
                  // [事务] 与标题输入同构：标脏 + 记 baseline + 清错误 + 写值。prompt 是
                  // 必填项，清错误的时机必须与标脏同一 tick，否则会出现"已输入但仍红框"。
                  onChange={(event) => {
                    markFieldTouched("prompt");
                    clearRequiredFieldValidation("prompt");
                    setPrompt(event.target.value);
                  }}
                  placeholder={intl.formatMessage({
                    id: "automations.edit.promptPlaceholder",
                  })}
                  aria-invalid={validationErrors.has("prompt") && !prompt.trim()}
                  // [失败路径] 这里不设 rows：高度由 Composer 容器控制，
                  // 固定 rows 会让长提示词在窄屏上撑出滚动条、在宽屏上留大片空白。
                />
                <AutomationInstructionsToolbar>
                  <div className="flex min-w-0 flex-wrap items-center gap-0 text-foreground-subtle">
                    {/* 项目选择器:新建复用输入框空态的项目菜单;编辑锁定为 automation 所属项目 */}
                    {editing ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled
                        // [事务] 这里用 disabled 的 Button 而不是只读文本：保留控件外形
                        // 可以让用户确认"项目是可配置概念，只是当前不可改"，纯文本会
                        // 让编辑页看起来比新建页少一个能力（INV-07）。
                        // [失败路径] 不加 Tooltip 说明锁定原因：编辑态的项目就是任务
                        // 归属，解释"为什么不能改"反而暗示存在一个不存在的迁移入口。
                        className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal"
                      >
                        {isSelectedConversationWorkspace ? (
                          <MessageCircle className="size-3.5" aria-hidden="true" />
                        ) : (
                          <FolderOpen className="size-3.5" aria-hidden="true" />
                        )}
                        <span className="max-w-40 truncate">{selectedWorkspaceDisplayLabel}</span>
                      </Button>
                    ) : workspaceOptions.length > 0 ? (
                      <Select value={workspaceKey ?? ""} onValueChange={handleSelectProject}>
                        <SelectTrigger
                          data-testid="automation-project-select"
                          variant="ghost"
                          // [事务] trigger 复用 composer 的紧凑样式（原注释）：两处各写一份
                          // 会让项目选择器与模型选择器在同一行里高度/圆角逐渐分叉。
                          // [失败路径] data-testid 用固定字符串而不是 testId() 拼接：
                          // 这个选择器在 E2E 里被直接引用，拼错后测试会静默跳过。
                          className={AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME}
                        >
                          <FolderOpen className="size-4" aria-hidden="true" />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {workspaceOptions.map((option) => (
                            <SelectItem
                              key={resolveAutomationWorkspaceSelectionKey(option)}
                              // [事务] key 与 value 必须用同一个解析函数：两者不一致时
                              // Radix 会认为选中项不存在，触发器显示 placeholder 而不是项目名。
                              value={resolveAutomationWorkspaceSelectionKey(option)}
                              // [权衡] data-* 只用于 E2E 定位，不参与业务判断：
                              // 用 projectId 做 value 会让"同一项目多 Host"发生键冲突。
                              data-project-id={option.projectId}
                              data-project-name={option.label}
                            >
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled
                        // [失败路径] 空候选时同样用 disabled Button 而不是隐藏：隐藏会让
                        // 工具栏左侧突然少一块，右侧模型选择器横向跳动；同时"本地必须
                        // 先有项目"这条规则也就不再可见。
                        className="h-auto min-h-7 gap-1 rounded-full px-2 py-1 text-ui-base font-normal leading-normal text-foreground-subtlest"
                      >
                        <FolderOpen className="size-3.5" aria-hidden="true" />
                        {intl.formatMessage({
                          id: "automations.form.project.localRequired",
                        })}
                      </Button>
                    )}

                    {/* Bugfix：自动化曾复制首页权限菜单，导致图标、字号和选中态逐渐分叉。
                        直接复用首页 ConfigSelect，只覆盖紧凑 trigger 布局。 */}
                    <ConfigSelect
                      option={modeOption}
                      // [事务] 复用首页 Composer 的 ConfigSelect 而不是本地 Select：
                      // 权限项的图标、快捷键与选中态都在这一个组件里维护，复制一份
                      // 会在两处逐渐漂移（历史 bug）。
                      // [失败路径] 不传 lockReason：定时任务没有"当前会话不可切换"的概念，
                      // 传空字符串会让控件渲染出一个空的锁定 tooltip。
                      // [事务] 模式同样需要 ref + state 双写（INV-01）：提交时读的是
                      // modeRef，只写 state 会让"切到 plan 后立刻保存"写入旧模式。
                      onValueChange={(value) => {
                        markFieldTouched("mode");
                        modeRef.current = value;
                        setMode(value);
                      }}
                      tooltipTitle={intl.formatMessage({
                        id: "chat.toolbar.mode.label",
                      })}
                      triggerVariant="ghost"
                      triggerSize="default"
                      triggerClassName={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "w-fit max-w-56 min-w-0 shrink justify-start gap-1 px-2",
                      )}
                      labelVisibilityClassName="inline-flex min-w-0 truncate text-left"
                      provider={ZCODE_AGENT_PROVIDER}
                      restoreFocusSelector={null}
                    />
                  </div>

                  {/* 模型 / 推理强度在右侧成组，和左侧 workspace / 权限形成清晰分区。 */}
                  <div className="flex min-w-0 flex-wrap items-center justify-end gap-0 text-foreground-subtle">
                    <ModelConfigSelect
                      modelGroups={modelSelectGroups}
                      // [事务] normalizedValue 用"解析后的 item.value"而不是 state 里的
                      // model：历史脏数据（带前缀/大小写差异）只有经过解析才能与
                      // modelGroups 的 value 对齐，否则下拉会显示未选中。
                      normalizedValue={selectedModelItem?.value ?? ""}
                      triggerLabel={modelTriggerLabel}
                      showManageModelsAction={Boolean(onManageModels)}
                      lockReasonMessage=""
                      // [权衡] isItemLocked 恒返回 false：定时任务没有"当前会话已锁定
                      // 某个模型"的约束，加锁会让用户无法把任务切到别的模型。
                      isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                      onValueChange={handleModelValueChange}
                      tooltipTitle={intl.formatMessage({
                        id: "chat.toolbar.model.label",
                      })}
                      manageModelsLabel={intl.formatMessage({
                        id: "chat.toolbar.model.manageModels",
                      })}
                      onManageModels={onManageModels}
                      contentSide="top"
                      focusSelectorOnClose={null}
                      labelVisibilityClassName="hidden @sm/composer:inline-flex"
                      indicatorClassName="hidden @sm/composer:block"
                      triggerClassName={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "w-fit max-w-72 min-w-0 shrink @max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0",
                      )}
                      triggerIconClassName="inline-flex @sm/composer:hidden"
                      // [失败路径] 非 ready 一律 disabled（INV-18）：加载中允许点开
                      // 会展示一个空模型列表，用户会误以为"这个项目没有可用模型"。
                      disabled={modelSelectionRead.state.status !== "ready"}
                    />
                    {modelSelectionRead.state.status === "error" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        // [事务] 重试按钮只在 error 态渲染（而不是 disabled）：加载中
                        // 与 ready 都不需要重试，常驻会诱导用户频繁刷新并打断订阅。
                        onClick={modelSelectionRead.reload}
                      >
                        {intl.formatMessage({ id: "common.retry" })}
                      </Button>
                    ) : null}
                    {thoughtLevelOption ? (
                      <ThoughtLevelCycleControl
                        intl={intl}
                        option={thoughtLevelOption}
                        // [事务] triggerRef 由父级持有：档位控件与模型控件在同一行，
                        // 关闭下拉后需要把焦点还给正确的一个，否则 Tab 顺序会跳回模型。
                        provider={ZCODE_AGENT_PROVIDER}
                        triggerRef={thoughtTriggerRef}
                        indicatorClassName="hidden @xl/composer:block"
                        triggerClassName={cn(
                          AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                          "@max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:p-0",
                        )}
                        restoreFocusSelector={null}
                        labelVisibilityClassName="hidden @xl/composer:inline-flex"
                        onValueChange={(value) => {
                          if (!effectiveSelection) return;
                          markFieldTouched("thoughtLevel");
                          // 用户改档位时以正在显示的模型身份形成新意图；只读刷新不改表单。
                          // [事务] 三件事必须原子完成（INV-23）：固化当前模型（否则刷新后模型
                          // 会被服务端回退）、置 manuallyChanged（阻止默认填充覆盖）、写
                          // ref+state（提交读 ref）。
                          // [失败路径] effectiveSelection 为空时直接 return：此时表单里没有
                          // 可信的模型身份，写入会把 thoughtLevel 挂到一个空模型上。
                          modelSelection.current = effectiveModelValue;
                          setModel(effectiveModelValue);
                          thoughtManuallyChangedRef.current = true;
                          thoughtLevelRef.current = value;
                          setThoughtLevel(value);
                        }}
                      />
                    ) : null}
                  </div>
                </AutomationInstructionsToolbar>
              </AutomationInstructionsComposer>
            </div>
          </form>
        ) : (
          // History tab：运行历史内联表
          <div>
            {/* 修复原因：运行条件已在设置入口说明，历史页重复提示会挤占表格上方空间。 */}
            {runsLoading && runs.length === 0 ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner className="size-5" />
              </div>
            ) : runsEntry?.status === "error" ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
                {runsEntry.error}
              </div>
            ) : runs.length === 0 ? (
              // 定时任务曾仅渲染透明的 py-10 文本块，缺少与闲时任务一致的空态背景、边框和高度。
              <AutomationHistoryEmptyState>
                {intl.formatMessage({ id: "automations.runs.empty" })}
              </AutomationHistoryEmptyState>
            ) : (
              <div className="overflow-x-auto rounded-[8px]">
                {/* 修复原因：运行历史使用可缩放字号，不能继续绑定固定 18px 行高。 */}
                <table className="w-full text-left text-ui-base font-normal leading-normal tracking-[-0.08px]">
                  <thead className="bg-surface text-foreground-subtle">
                    <tr className="h-[30px] border-b border-border">
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.triggered",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.trigger",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.status",
                        })}
                      </th>
                      <th className="px-4 font-normal">
                        {intl.formatMessage({
                          id: "automations.runs.col.duration",
                        })}
                      </th>
                      <th className="px-4 font-normal" />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRuns.map((run) => {
                      // [事务] status 先解析成有限枚举，再由两张映射表分别取点色与文字色
                      // （INV-29）：把颜色写进三元表达式会让"同一个失败态"在圆点与
                      // tooltip 文案里出现不同颜色。
                      const status = resolveRunStatus(run);
                      const statusLabel = intl.formatMessage({
                        id: `automations.runs.status.${status}`,
                      });
                      const statusBadge = (
                        <span className="flex items-center text-ui-base leading-5 tracking-[-0.18px]">
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <span
                              className={cn(
                                "inline-block size-1.5 rounded-full",
                                RUN_STATUS_DOT_CLASS[status],
                              )}
                            />
                          </span>
                          <span className={RUN_STATUS_TEXT_CLASS[status]}>{statusLabel}</span>
                        </span>
                      );
                      // [失败路径] canOpenSession 必须同时要求 sessionId 与回调（INV-18
                      // 的读面版本）：只有 id 没有回调时渲染一个点了没反应的菜单项，
                      // 比不渲染更糟。
                      // [权衡] hasActions 只用于决定是否渲染操作列：它不参与权限判断，
                      // 权限缺失由菜单项内部再判一次。
                      const canOpenSession = Boolean(run.sessionId && onOpenSession);
                      const hasActions = canOpenSession || Boolean(onDeleteRun);
                      return (
                        <tr
                          key={run.runId}
                          className="h-[46px] border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover"
                        >
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {formatDateTime(run.scheduledAt ?? run.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {intl.formatMessage({
                              id: `automations.trigger.${run.trigger}`,
                            })}
                          </td>
                          <td className="px-4">
                            {status === "failed" ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>{statusBadge}</TooltipTrigger>
                                  <TooltipContent
                                    side="top"
                                    align="start"
                                    // [失败路径] 允许换行并限制最大宽度：错误信息来自
                                    // 服务端，可能是一整段堆栈摘要；不换行会把 tooltip
                                    // 撑出屏幕外。
                                    sideOffset={6}
                                    className="max-w-96 whitespace-normal break-words"
                                  >
                                    {run.error?.trim() ||
                                      intl.formatMessage({
                                        id: "automations.runs.errorUnavailable",
                                      })}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              statusBadge
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 text-foreground-subtle">
                            {formatDuration(run.createdAt, run.updatedAt)}
                          </td>
                          <td className="px-4">
                            <div className="flex items-center justify-end">
                              {hasActions ? (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      // [事务] 行内操作菜单按需渲染（hasActions 为真才出现）：
                                      // 两个回调都缺时 `hasActions` 为假，渲染空菜单会多出一个空入口。
                                      // 空 `DropdownMenu` 展开后 0 项，比不显示这一列更令人困惑。
                                      aria-label={intl.formatMessage({
                                        id: "automations.moreActions",
                                      })}
                                      className="flex size-6 items-center justify-center rounded-[6px] text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground"
                                    >
                                      <AutomationMoreHorizontalIcon
                                        className="size-4"
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent
                                    align="end"
                                    // [权衡] sideOffset 固定为 4 与表头菜单一致：表格行高
                                    // 46px，偏移再大弹出层会盖住下一行的状态色点。
                                    sideOffset={4}
                                    className="min-w-[160px]"
                                  >
                                    {canOpenSession ? (
                                      <DropdownMenuItem
                                        // [失败路径] sessionId 用非空断言是安全的：
                                        // canOpenSession 已保证它存在，但回调仍用可选调用，
                                        // 防止父级在渲染后被卸载导致回调变 undefined。
                                        onSelect={() => onOpenSession?.(run.sessionId!)}
                                      >
                                        <AutomationExternalLinkIcon
                                          className="size-3.5"
                                          aria-hidden="true"
                                        />
                                        {intl.formatMessage({
                                          id: "automations.runs.openSession",
                                        })}
                                      </DropdownMenuItem>
                                    ) : null}
                                    {onDeleteRun ? (
                                      <>
                                        {canOpenSession ? <DropdownMenuSeparator /> : null}
                                        <DropdownMenuItem
                                          variant="destructive"
                                          onSelect={() => onDeleteRun(run.runId)}
                                        >
                                          <AutomationTrashIcon />
                                          {intl.formatMessage({
                                            id: "automations.runs.delete",
                                          })}
                                        </DropdownMenuItem>
                                      </>
                                    ) : null}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {runs.length > 0 && runsTotalPages > 1 ? (
              <nav className="mt-4 flex items-center justify-between text-ui-base">
                <button
                  type="button"
                  // [事务] 上一页用"收敛后的 runsCurrentPage"计算而不是 runsPage：
                  // 删除导致页码越界时，runsPage 可能是 3 而实际只显示第 1 页，
                  // 直接减一会跳到一个同样不存在的页。
                  disabled={runsCurrentPage <= 1}
                  onClick={() => setRunsPage(Math.max(1, runsCurrentPage - 1))}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <ArrowLeft className="size-3.5" aria-hidden="true" />
                  {intl.formatMessage({ id: "automations.runs.prevPage" })}
                </button>
                <div className="flex items-center gap-1">
                  {runsPageItems.map((item, index) =>
                    item === "ellipsis" ? (
                      <span
                        key={`ellipsis-${index}`}
                        className="flex size-7 items-center justify-center text-foreground-subtlest"
                        aria-hidden="true"
                      >
                        …
                      </span>
                    ) : (
                      <button
                        key={item}
                        type="button"
                        // [失败路径] aria-current 只在当前页设置，其余传 undefined：
                        // 传 false 会让部分读屏把每一页都播报成"第 N 页，非当前页"。
                        aria-current={item === runsCurrentPage ? "page" : undefined}
                        onClick={() => setRunsPage(item)}
                        className={cn(
                          "inline-flex size-7 items-center justify-center rounded-[6px] transition-colors",
                          item === runsCurrentPage
                            ? "bg-surface text-foreground"
                            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                        )}
                      >
                        {item}
                      </button>
                    ),
                  )}
                </div>
                <button
                  type="button"
                  // [事务] 下一页同样以 runsTotalPages 为上限：页数在轮询刷新后可能
                  // 变小，不夹取会写入一个超过总页数的 runsPage，下次渲染依然收敛，
                  // 但会产生一次"点下一页没反应"的错觉。
                  disabled={runsCurrentPage >= runsTotalPages}
                  onClick={() => setRunsPage(Math.min(runsTotalPages, runsCurrentPage + 1))}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  {intl.formatMessage({ id: "automations.runs.nextPage" })}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </button>
              </nav>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
