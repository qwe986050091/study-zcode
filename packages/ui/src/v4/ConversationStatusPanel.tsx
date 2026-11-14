/* oxlint-disable eslint(max-lines) -- 状态面板同时维护收起态摘要、展开态分区、菜单策略和宽度自适应，同文件能保证两种形态共享同一内容优先级。 */
// ConversationStatusPanel 是 V4 会话「状态面板」的唯一外壳：同一个组件在 mini（胶囊）与
// panel（展开卡片）两种形态之间切换，两种形态共享 buildConversationStatusPanelModel 产出的
// 同一份投影。本文件只做展示与交互编排：它不持有会话事实、不写回 runtime、不自己算计数。
//
// INV 不变量表（行号会随注释漂移，请按符号检索；本表覆盖整个文件）：
// INV-1: model 只能由 props 经 buildConversationStatusPanelModel 派生，组件内不得另行组装业务状态 —— 破坏后果：出现第二真相源，面板与输入框/侧栏对同一会话给出不同事实且无法归因。
// INV-2: mini 与 panel 必须消费同一个 model 和同一组 canRender* 闸门 —— 破坏后果：切换形态时分区凭空出现或消失，用户在胶囊看到的计数点开后找不到对应分区。
// INV-3: 分区是否挂载只由 canRender* 决定，不能用 CSS 隐藏代替卸载 —— 破坏后果：隐藏分区仍在挂载并继续跑各自的秒表 interval，任务结束后面板不再收敛。
// INV-4: StatusSection 的开合状态必须受控/非受控二选一；受控时组件自身不得再写本地 state —— 破坏后果：宿主与组件同时写 open，折叠动画抖动或在受控值为 false 时回弹展开。
// INV-5: 秒表 effect 的依赖必须是「是否在跑」这类布尔或计数，不能是整个对象/数组 —— 破坏后果：每次投影更新都重建 interval，同步 setState 落进投影提交帧，触发 React 嵌套更新告警（#185）。
// INV-6: 已结束 workflow run 的目录入口必须独立于 model.hasContent 开门 —— 破坏后果：重启后活投影为空，整个面板连同 run 目录入口一起消失，而回看被打断的 run 正是该入口的主要用途。
// INV-7: 只有在 model.hasContent 或 canRenderEndedWorkflows 为真时才渲染外层壳，否则返回 null —— 破坏后果：空会话留下 2px 空壳线，既遮挡正文又点不开。
// INV-8: 行内「打开详情」与「停止」必须是同级按钮，禁止整行 button 包住 Stop —— 破坏后果：嵌套 button 在 HTML 中非法，浏览器重排 DOM 后点击 Stop 可能同时触发打开。
// INV-9: 后台任务/run/subagent 的行顺序必须来自模型层或显式稳定排序，不能按投影对象身份重排 —— 破坏后果：每次投影更新行位置跳动，用户按位置记忆点击会打错目标。
// INV-10: 所有回调型 props 都必须按可选处理并容忍 undefined —— 破坏后果：只读嵌入场景（手机远控壳、预览）未接线时直接抛 TypeError 白屏。
// INV-11: isOfficeMode / layoutMode / variant 等纯展示开关不得改变数据语义，只影响布局类名与默认分区 —— 破坏后果：Office 模式与普通模式对同一会话给出不同事实。
// INV-12: startedAt 缺失时不得用 0 或当前时间伪造 elapsed —— 破坏后果：界面显示 1970 年或恒为 0 的时长，比不显示更误导。
// INV-13: 已结束计数（endedWorkflowRunCount / endedSubagentCount）只能由宿主从 journal 口径传入，面板不得用活投影推算 —— 破坏后果：重启后计数归零，目录入口与胶囊计数同时消失。
// INV-14: 胶囊摘要分支是一条严格优先级的互斥链，任一次序调整都会改变「会话此刻在做什么」的答案 —— 破坏后果：优先级错位后，正在跑的 run 被上一轮遗留的 todo 遮住。
// INV-15: 分区之间的分隔线由 separated 逐级或运算得到，不能用 CSS :not(:first-child) 之类推断 —— 破坏后果：条件分支导致的首个可见分区不同时，顶部分隔线重复或缺失。
// INV-16: 需要滚动限高的区块，滚动容器必须放在 CollapsibleContent 内部 —— 破坏后果：滚动边界落到折叠动画层之外，高度动画失效或标题被裁掉。
// INV-17: StatusSection 的限高策略由完整 StatusSectionKind 表裁决，新增分区漏配必须编译失败 —— 破坏后果：新分区漏配后无滚动、内容被外层壳裁切且无提示。
// INV-18: key 必须能唯一标识领域实体（workId / runId / childSessionId / toolCallId）—— 破坏后果：用下标做 key 时删除中间项会让 React 复用错误节点，秒表与按钮挂到别人行上。
// INV-19: 面板内所有派生列表（iterationRows、ordered、focusWindow）都必须 useMemo 或稳定引用 —— 破坏后果：memo(ConversationStatusPanel) 的浅比较失效，每次父渲染都重算全树。
// INV-20: 展开面板的动作必须与胶囊展示的内容对齐（胶囊显示 workflow 就一并打开 workflow 分区）—— 破坏后果：点开面板后看到的比胶囊还少，入口看起来是坏的。
//
// INV-21: 分区标题的可访问名必须与可见标题同源（同一 i18n key），不能用硬编码英文兜底 —— 破坏后果：读屏播报与界面语言不一致，且翻译更新后读屏仍是旧词。
// INV-22: 任何「已结束/历史」入口的点击都必须携带 parentSessionId，不能只带 runId/childSessionId —— 破坏后果：目录页无法定位会话，打开一张空白页且没有回退路径。
// INV-23: 秒表显示的最小单位是秒，且所有行共用同一个 now —— 破坏后果：同一屏出现两种时间基准，行间相对顺序看起来自相矛盾。
// INV-24: 胶囊点击只允许改变展示（variant / 分区开合），不得触发取消、提交等写操作 —— 破坏后果：用户想「看看」却中断了正在跑的任务。
// INV-25: 停止按钮的可见性由 cancellable 决定，实际能否停止由 runtime 决定，UI 不做预判 —— 破坏后果：UI 误判后隐藏唯一入口，用户只能杀掉整个会话。
// INV-26: 所有 data-* 属性只用于测试与埋点，不得成为业务判断依据 —— 破坏后果：样式/测试改动影响运行逻辑，且线上异常无法按 DOM 复现。
// INV-27: 分区内的列表容器不设置固定高度，只给 max-height —— 破坏后果：一条内容时也会留下大片空白，面板看起来「没渲染完」。
// INV-28: 新增分区必须同时更新 StatusSectionKind、滚动策略表、canRender* 与 separated 链 —— 破坏后果：漏一处即出现空壳分区、无滚动裁切或分隔线错位。
//
// 五类标记在本文件里的含义（出现于行首，便于检索）：
// [并发] 同一帧内多个来源同时改写展示状态时，谁覆盖谁、以哪个为准。
// [事务] 一次用户动作必须原子完成的多个写入（如先开分区再切形态），中途失败会留下半状态。
// [资源] interval / 定时器 / 订阅的建立与清理配对，以及「静置时不跑定时器」的保证。
// [失败路径] 上游字段缺失、远端时钟偏移、宿主未接线回调时的降级形状。
// [权衡] 两个都合理的方案之间为什么选这个（性能 vs 一致性、稳定 vs 即时）。
//
// 阅读顺序建议：先看 props（来源与所有权）→ 再看 StatusSection（受控/非受控与滚动边界）
// → 再看各分区（canRender 闸门与空态）→ 最后看 StatusSummaryRow（胶囊优先级链）。
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckBigIcon,
  CircleIcon,
  EllipsisIcon,
  FileDiffIcon,
  GoalIcon,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  SquareTerminalIcon,
  Workflow,
} from "lucide-react";
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_BACKGROUND_WORK_CANCEL,
  TID_V4_BACKGROUND_WORK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeSessionRunningSubagent,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { RUN_STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { WorkflowRunRail } from "@/components/workflow-run-line/WorkflowRunRail.js";
import { foldWorkflowRunRail } from "@/lib/workflowRunLine.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenSubagentDirectorySideTabRequest,
  OpenSubagentSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";
import { resolveConversationStatusPanelVariant } from "@/v4/conversationLayout.js";
import {
  buildConversationStatusPanelModel,
  type ConversationStatusPanelRunningSubagent,
  type ConversationStatusPanelModel,
  type ConversationStatusPanelSessionPlanItem,
  type ConversationStatusPanelWorkflowRun,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  workflowRunOpenTarget,
  workflowRunWords,
  type ConversationStatusPanelWorkflowRunWords,
} from "@/v4/conversationStatusPanelModel.js";
import {
  buildConversationGoalIterationSummaries,
  getConversationGoalElapsedSeconds,
} from "@/v4/conversationGoalSummaryModel.js";

// props 的所有权边界：这里全部字段都是「宿主投影的只读切片」，组件不缓存也不 mutate。
// workspacePath 只用于展示与 Git 操作（执行边界），workspaceIdentity 才是隔离键；
// 两者混用会让远程会话读到本地同路径仓库的状态（见 INV-19 的仓库级约束）。
// 需要写回的地方一律走 on* 回调，由 ChatView / 侧栏宿主决定是否接线。
export interface ConversationStatusPanelProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly ZCodeSessionRunningSubagent[];
  /** 本会话 `snapshot.workflowRuns.runs`；与 backgroundWorks 在模型层按 workId ≡ runId 联接。 */
  workflowRuns?: readonly WorkflowRunState[];
  /**
   * 已结束的 workflow run 条数（journal 口径，`countEndedWorkflowRuns`）。
   * 面板不自己算：它手上的投影是 memory-only 的活状态，重启后为空，而这条计数恰恰要在重启后
   * 仍然正确。
   */
  endedWorkflowRunCount?: number;
  endedSubagentCount?: number;
  rootSessionId?: string;
  parentSessionId?: string;
  /** 当前 pane 是否由手机 Web 远控壳承载。 */
  isWebRemoteControl?: boolean;
  /** 当前是否为粗指针手机视口。 */
  isMobileViewport?: boolean;
  layoutMode?: "none" | "auto" | "inline";
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onVariantChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  terminalSectionOpen?: boolean;
  onTerminalSectionOpenChange?: (open: boolean) => void;
  agentSectionOpen?: boolean;
  onAgentSectionOpenChange?: (open: boolean) => void;
  workflowSectionOpen?: boolean;
  onWorkflowSectionOpenChange?: (open: boolean) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  onOpenWorkflowRunDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  className?: string;
}

// 空数组常量必须是模块级的同一个引用：组件用这些默认值参与 useMemo 依赖，
// 若在参数默认值里写 []，每次父渲染都会产生新数组，模型层 useMemo 全部失效，
// 并让 memo 的浅比较永远为 false（稳定引用边界测试会直接失败）。
// memo 组件默认 props 不内联创建数组，避免每次渲染生成新引用触发稳定引用边界测试。
const EMPTY_BACKGROUND_WORKS: readonly BackgroundWorkSummary[] = [];
const EMPTY_RUNNING_SUBAGENTS: readonly ZCodeSessionRunningSubagent[] = [];
const EMPTY_WORKFLOW_RUNS: readonly WorkflowRunState[] = [];

// 时长格式化的隐含前提：输入单位是秒且允许为负/NaN 上游（时钟回拨时 now - startedAt 可能为负）。
// 先 clamp 再 floor：直接 Math.floor 负数会向 -∞ 取整，界面出现「-1秒」这种不可能的时长。
// 三段中秒永远输出（全为 0 时输出 0秒），否则空白文案会被误读成「仍在加载」。
function formatDurationUnits(
  totalSeconds: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  const hourUnit = formatMessage({ id: "chat.summaryPanel.duration.hours" });
  const minuteUnit = formatMessage({ id: "chat.summaryPanel.duration.minutes" });
  const secondUnit = formatMessage({ id: "chat.summaryPanel.duration.seconds" });
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}${hourUnit}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}${minuteUnit}`);
  }
  if (restSeconds > 0 || parts.length === 0) {
    parts.push(`${restSeconds}${secondUnit}`);
  }
  return parts.join(" ");
}

// now 由调用方注入而不是在这里 Date.now()：同一帧内所有行必须共享同一个时间基准，
// 否则并排行会出现 1 秒级的速度差，且行序（按 startedAt 排）会看起来违反直觉。
// clamp 到 0 是必要的：远端 startedAt 来自 Host 时钟，与本机时钟存在偏移时差值为负。
function getBackgroundWorkElapsedMs(work: BackgroundWorkSummary, now: number) {
  return Math.max(0, now - work.startedAt);
}

// 收起态只能显示一个数字，取「最长」而不是「最新」或「平均」：
// 用户扫一眼胶囊时关心的是最久那条还要跑多久，平均或总和都无法指向任何一条具体任务。
// 初值 0 让空数组自然退化为 0，不需要额外空判断（调用方会先按长度做空态闸门）。
function getLongestRunningWorkElapsedMs(works: readonly BackgroundWorkSummary[], now: number) {
  return works.reduce(
    (longestElapsedMs, work) => Math.max(longestElapsedMs, getBackgroundWorkElapsedMs(work, now)),
    0,
  );
}

// 单复数必须走两条独立 i18n key，而不是在代码里拼 `count === 1 ? "" : "s"`：
// 复数规则因语言而异（中文无复数、俄语有三种形式），拼接只能在英语下正确。
function formatRunningCount(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      id:
        count === 1
          ? "chat.summaryPanel.runningBackgroundTasksMiniValue"
          : "chat.summaryPanel.runningBackgroundTasksMiniValuePlural",
    },
    { count: String(count) },
  );
}

// 与 formatRunningCount 分开而不是复用：两条链路的计数语义不同（见下方注释），
// 共用会让 i18n key 与语义脱钩，后续任一方改文案都会污染另一方。
function formatRunningSubagentCount(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      // 这里的计数至少包含 running 投影中的 subagent（可能是 mixed 胶囊总数）；
      // subagent 又包含 foreground、background、blocked 和 waiting，复用后台任务文案
      // 会把计数语义错误地缩窄成“后台”。
      id:
        count === 1
          ? "chat.statusPanel.runningAgentsValue"
          : "chat.statusPanel.runningAgentsValuePlural",
    },
    { count: String(count) },
  );
}

// 这是封闭联合而不是 string：它同时被用作 data-status-section 的 DOM 契约、
// 限高策略表的键、以及标题栏折叠触发器的 data 属性。新增分区时类型检查会逼你
// 同步补 STATUS_SECTION_SCROLL_POLICY，从而避免「新分区忘了给滚动视口」这类静默降级。
type StatusSectionKind =
  | "environment"
  | "goal"
  | "sessionPlans"
  | "plan"
  | "terminal"
  | "workflow"
  | "agent";

// environment（Git）故意为 null：它只有三行固定操作项，高度恒定，加滚动只会引入无意义的嵌套
// 滚动条。其余分区都给限高，是因为它们的内容条数由会话规模决定，理论上无上界。
// `satisfies` 而不是类型注解：注解会把值拓宽成 string|null，丢失具体类名与漏配检测。
const STATUS_SECTION_SCROLL_POLICY = {
  environment: null,
  goal: "max-h-48",
  sessionPlans: "max-h-48",
  // 六个双行 Todo（6 × 52px）需要约 20rem；超过后只滚动进程区块。
  plan: "max-h-80",
  terminal: "max-h-48",
  // workflow 行定高 56px，列表滚到三行半（196px）：露出的半行告诉人下面还有。
  workflow: "max-h-[12.25rem]",
  agent: "max-h-48",
} as const satisfies Record<StatusSectionKind, string | null>;

// 折叠触发器必须是一个真实 button 而不是给 div 加 onClick：
// aria-expanded 只有在 focusable 元素上才会被读屏软件正确播报，键盘 Space/Enter
// 也需要原生按钮语义。Chevron 用 opacity 过渡而不是条件渲染，避免标题行宽度跳动。
function StatusSectionHeader({
  children,
  isOpen,
  section,
  title,
}: {
  children?: ReactNode;
  isOpen: boolean;
  section: StatusSectionKind;
  title: string;
}) {
  return (
    // 标题行固定 h-8 且 pr-8：右侧 8（2rem）是给宿主操作区（展开/收起、菜单）预留的，
    // 不预留时面板头部的按钮会盖住 trailing 的计数文本。
    <div className="mb-0.5 flex h-8 min-w-0 shrink-0 items-center gap-1.5 px-2 pr-8">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={isOpen}
          data-status-section-trigger={section}
          className="group flex min-w-0 shrink-0 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <span className="shrink-0 text-ui-base text-[var(--color-foreground-subtle)]">
            {title}
          </span>
          {isOpen ? (
            // 展开/收起只换箭头方向，两个箭头尺寸与定位完全一致：
            // 若用一个图标加 rotate，旋转中心在 3.5 尺寸下会出现半像素抖动。
            <ChevronDownIcon className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          )}
        </button>
      </CollapsibleTrigger>
      {children ? (
        // trailing 插槽与标题同处一行：min-w-0 + max-w-full 是必须的，
        // 否则长数字（多日时长）会把标题挤成省略号甚至溢出面板。
        <div className="inline-flex min-w-0 max-w-full shrink items-center gap-1.5 text-ui-sm text-[var(--color-foreground-subtlest)]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

// 受控/非受控的统一实现：open 为 undefined 即非受控，此时组件自己保存开合状态；
// 一旦宿主传入 open，本地 state 仍然存在但被完全忽略（不再读写），
// 这样宿主把 open 从受控改回 undefined 时不会出现「记住了上一次受控值」的幽灵状态。
// 两种模式最终都回调 onOpenChange，宿主据此决定是否真的改值（受控模式必须回写）。
function StatusSection({
  children,
  defaultOpen = true,
  footer,
  onOpenChange,
  open,
  separated = false,
  section,
  title,
  trailing,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  /** 固定在滚动视口之外的页脚（如已结束目录入口）：列表再长也滚不走它。 */
  footer?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated?: boolean;
  section: StatusSectionKind;
  title: string;
  trailing?: (isOpen: boolean) => ReactNode;
}) {
  // 本地 state 的唯一用途是「宿主没接管时也能开合」。初始化只读 defaultOpen 一次，
  // 之后的 defaultOpen 变化被刻意忽略：否则宿主在运行中改默认值会把用户手动折叠掀翻。
  // 这也是受控模式下这个 state 完全无人读写的依据（见 isOpen 的 ?? 取值）。
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  // `??` 而不是 `||`：open=false 是合法受控值，用 || 会在宿主显式折叠时回落到默认展开。
  const isOpen = open ?? uncontrolledOpen;
  // 限高过去依赖每个调用方显式传 scrollable，组合区块或新增类型时容易
  // 旁路滚动视口。改为按完整区块类型表统一裁决，让计划等新类型漏配时直接触发类型检查。
  // 查表得到的可能为 null，null 表示「这一块不给滚动视口」（environment）。
  // 用查表而不是内联三元：新增 Kind 时漏配会被 satisfies 约束拦住（INV-17）。
  const scrollViewportMaxHeightClass = STATUS_SECTION_SCROLL_POLICY[section];
  // 本地 setState 只在非受控时执行：受控模式下若同时写本地值，
  // 宿主拒绝这次变更（不更新 open）时 UI 会短暂显示已打开，下一次投影再弹回，
  // 表现为折叠动画抖动。useCallback 依赖里显式列 isControlled 而不是省略。
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  return (
    // Collapsible 的根同时承担三件事：受控开合、data-status-section 定位、
    // 以及 separated 的边框与内边距。把 separated 放在这里而不是内容层，
    // 是为了让折叠态也能看到分区之间的分隔线。
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      data-status-section={section}
      className={cn("min-w-0 flex-none", separated && "border-t border-[var(--color-border)] pt-2")}
    >
      <section className="min-w-0 flex-none">
        <StatusSectionHeader isOpen={isOpen} section={section} title={title}>
          {trailing?.(isOpen)}
        </StatusSectionHeader>
        <CollapsibleContent>
          {scrollViewportMaxHeightClass ? (
            // 长 Goal / 计划 / Todo / 终端 / 智能体列表过去保持自然高度，外层 shell
            // 只能把超出 max-height 的内容裁掉。滚动边界必须放在折叠动画内容层内部，
            // 既固定区块标题和控制，也不破坏 CollapsibleContent 的高度动画。
            <div
              data-status-section-scroll={section}
              className={cn(
                scrollViewportMaxHeightClass,
                "min-h-0 overflow-x-hidden overflow-y-auto pr-1",
              )}
            >
              {children}
            </div>
          ) : (
            children
          )}
          {footer}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

// Git 分区是三个独立行（Changes / 分支切换 / Git 操作），行的顺序就是用户的操作频率：
// 先看改了多少，再切分支，最后才是提交级别动作。任一回调缺失就整块不渲染（返回 null），
// 因为只读宿主下这三行都点不动，展示它们只会制造「看起来可点」的假入口。
// gitSummary 与 model.git 是两份不同口径：前者是仓库事实，后者是模型算出的展示摘要。
function GitStatusSection({
  activeTaskChangeSummary,
  gitSummary,
  gitWorktreeReviewSourceId,
  model,
  onOpenGitReview,
  onRefreshGit,
  separated,
  workspaceIdentity,
  workspacePath,
  useVerticalFloatingPanels,
}: {
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  gitSummary: GitRepositorySummary | null | undefined;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  model: ConversationStatusPanelModel;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onRefreshGit?: () => void;
  separated: boolean;
  workspaceIdentity?: string;
  workspacePath: string;
  useVerticalFloatingPanels: boolean;
}) {
  const { intl } = useZCodeIntl();
  // 三个来源缺一不可：model.git 是摘要事实，gitSummary 是分支/仓库元信息，
  // onRefreshGit 是刷新能力（分支切换后必须能回读）。缺任一项都返回 null，
  // 因为剩下的两项凑不出一个完整可用的分区——尤其缺刷新能力时，
  // 分支切换会成功但界面永远停在旧分支，比不给入口更糟。
  const git = model.git;
  // Git 的「有没有内容」不看 hasContent：一个干净仓库也值得显示分支与操作入口，
  // 因此这里只判数据完整性。真正的空态由 added/removed 与 isRepository 分别表达。
  if (!git || !gitSummary || !onRefreshGit) {
    return null;
  }
  // 当前计划的「有没有增删」与 Git 分区用的是同一份摘要，判断口径不能分叉：
  // hasChanges 只影响 trailing 的透明度（0/0 时变淡），不影响分区是否渲染。
  const hasChanges = git.added + git.removed > 0;
  // isRepository 是必要条件：非 Git 仓库里 openReview 无处可去，disable 而不是隐藏，
  // 是为了让这一行的位置保持稳定（隐藏会让下面的分支行上下跳）。
  // disable 而不是隐藏：非仓库/未接线时这一行仍占位，保证下面的分支行与操作行的
  // 纵向位置稳定。50% 透明度是「不可用」的唯一视觉信号，不能改成灰色文字——
  // 那会让它与「没有变更」的淡色 +0/-0 混淆。
  const canOpenReview = Boolean(onOpenGitReview && gitSummary.isRepository);

  return (
    <StatusSection
      section="environment"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.environment" })}
      trailing={(isOpen) =>
        isOpen ? null : (
          // 收起态必须显示增删数：展开后每一行已有自己的数字，
          // 标题再重复一遍会让 trailing 看起来像总计（它不是总计，只是 worktree 摘要）。
          <span className="shrink-0 font-mono text-ui-sm tabular-nums">
            <span className={cn("text-[var(--color-diff-added)]", !hasChanges && "opacity-50")}>
              +{git.added}
            </span>{" "}
            <span className={cn("text-[var(--color-diff-removed)]", !hasChanges && "opacity-50")}>
              -{git.removed}
            </span>
          </span>
        )
      }
    >
      <div className="space-y-0">
        {/* Bug 原因：V4 状态面板迁移时只保留了 Changes 的静态展示，
            没有继续透传旧版 Git review 回调，导致规范中的审阅入口不可点击。 */}
        <button
          type="button"
          disabled={!canOpenReview}
          className={cn(
            "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] transition-colors",
            canOpenReview
              ? "hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
              : "cursor-default opacity-50",
          )}
          onClick={() => {
            onOpenGitReview?.(gitWorktreeReviewSourceId ?? undefined);
          }}
        >
          <FileDiffIcon className="size-4 shrink-0 text-[var(--color-foreground)]" />
          <span className="min-w-0 flex-1 truncate">
            {intl.formatMessage({ id: "chat.statusPanel.changes" })}
          </span>
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-[var(--color-diff-added)]">+{git.added}</span>{" "}
            <span className="text-[var(--color-diff-removed)]">-{git.removed}</span>
          </span>
        </button>
        <GitBranchSwitcher
          workspacePath={workspacePath}
          gitSummary={gitSummary}
          dirtyFileCount={git.dirtyFileCount}
          onRefreshGit={onRefreshGit}
          className="w-full px-0 pt-0"
          triggerClassName="flex h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] [&>span]:max-w-[calc(100%-3.5rem)] [&_svg:first-child]:text-[var(--color-foreground)]"
          popoverClassName="w-72 max-w-[calc(100vw-2rem)]"
          branchListClassName="max-h-56"
          popoverSide={useVerticalFloatingPanels ? "bottom" : "left"}
          showFooterActions
        />
        <GitActionMenu
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          gitSummary={gitSummary}
          activeTaskChangeSummary={activeTaskChangeSummary ?? null}
          onRefreshGit={onRefreshGit}
          triggerLayout="status-row"
          className="w-full"
        />
      </div>
    </StatusSection>
  );
}

// goal 的四种展示态是互斥的：isPausable（可暂停）/ isPaused（可恢复）/ isDone（只显示勾）/
// 其余（不显示控件）。注意 isPausable 覆盖了 verifying 与 notSatisfied——这两个状态
// 仍是「活的」，必须允许用户暂停；漏掉 notSatisfied 会让验证失败的 goal 卡在无法中断的循环里。
function GoalStatusSection({
  model,
  onPauseGoal,
  onResumeGoal,
  separated,
}: {
  model: ConversationStatusPanelModel;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const goal = model.goal;
  // 三个状态合并成一个布尔，是因为 UI 只有「能不能暂停」这一种决策；
  // 拆成三个变量会让 control 的三元多两层，且新增状态时容易漏掉某一支。
  // verifying 与 notSatisfied 必须包含：它们是可中断的中间态，不是终点。
  const isPausable =
    goal?.status === "active" || goal?.status === "verifying" || goal?.status === "notSatisfied";
  const isPaused = goal?.status === "paused";
  // isDone 只认 verified：paused 与 notSatisfied 都属于「未完成」，
  // 若把它们算进完成态，control 会显示一个勾而用户仍看到 goal 在跑，自相矛盾。
  const isDone = goal?.status === "verified";
  // 迭代行由 goal 内的迭代记录构建，纯派生数据；useMemo 依赖整个 goal 对象是安全的，
  // 因为模型层每次投影都会产出新对象（浅比较必然失效），这里不为性能、只为避免
  // 在 render 中重复构造数组导致的引用不稳定。
  const iterationRows = useMemo(
    () => (goal ? buildConversationGoalIterationSummaries(goal) : []),
    [goal],
  );
  // 用时秒针只看「有没有在跑」这一个布尔。effect 不能以整个 goal 对象为依赖：
  // 每个 goal 事件都同步 setNow 并重建 interval——落在投影帧的同步提交里，给 React 的嵌套更新计数
  // 记一笔（与工作流卡 React #185 崩溃同形）。
  // 秒表开关的判据是「可暂停且有起点」：没有 activeRunStartedAtMs 说明这一轮还没开始，
  // 此时每秒重渲染只会得到一个恒定的 0秒，是纯粹的浪费。
  // useNowTicker 内部负责清理，本组件不重复建 interval。
  const now = useNowTicker(isPausable && goal?.activeRunStartedAtMs != null);

  // 空 goal 直接不渲染整个分区（而不是渲染空壳）：分区标题由 StatusSection 提供，
  // 没有 goal 时标题下面没有任何内容，会变成一条无法解释的分隔线。
  // 注意这个判断必须在所有 hooks 之后：提前 return 会改变 hooks 数量，
  // 从「有 goal」切到「无 goal」时 React 会抛渲染顺序不一致。
  if (!goal) return null;

  // 时长与状态共用同一个 now：若 here 再调一次 Date.now()，标题的秒数可能与
  // data-goal-elapsed-seconds 属性差 1 秒，快照测试会随机失败。
  const elapsed = formatDurationUnits(
    getConversationGoalElapsedSeconds(goal, now),
    intl.formatMessage,
  );
  // 控件三选一用嵌套三元而不是提前 return：它要嵌入 trailing 的同一行里，
  // 与时长并用一个「·」分隔。disabled={!onPauseGoal} 而不是隐藏，理由同 Git 行：
  // 只读宿主下仍要让人看到「这里本来能暂停」。
  const control = isPausable ? (
    <ControlHintTooltip title={intl.formatMessage({ id: "chat.target.pause" })}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0"
        data-goal-action="pause"
        disabled={!onPauseGoal}
        aria-label={intl.formatMessage({ id: "chat.target.pause" })}
        onClick={onPauseGoal}
      >
        <PauseIcon className="size-3.5" />
      </Button>
    </ControlHintTooltip>
  ) : isPaused ? (
    // 暂停态只给「恢复」，不给「暂停」：同时显示两个按钮会让用户怀疑当前到底跑没跑。
    // 这两种控件的图标、文案、data-goal-action 都不同，测试与埋点按 data 属性区分。
    <ControlHintTooltip title={intl.formatMessage({ id: "chat.target.resume" })}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0"
        data-goal-action="resume"
        disabled={!onResumeGoal}
        aria-label={intl.formatMessage({ id: "chat.target.resume" })}
        onClick={onResumeGoal}
      >
        <PlayIcon className="size-3.5" />
      </Button>
    </ControlHintTooltip>
  ) : isDone ? (
    // isDone 为真时只留成功色勾，不渲染暂停或恢复控件，
    // 「重新开始」属于下一轮目标，入口放按钮区而不是 chat.goalVerification.complete 旁。
    <CircleCheckBigIcon
      aria-label={intl.formatMessage({ id: "chat.goalVerification.complete" })}
      className="size-4 shrink-0 text-[var(--color-success)]"
    />
  ) : null;

  return (
    <StatusSection
      // Agent/Workflow 用 defaultOpen 而非受控：这两个入口在未接管时按「有活内容就展开」
      // 给出合理默认，一旦宿主传入 open，同一套规则就在宿主侧重算（两边口径必须一致）。
      section="goal"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.goal" })}
      trailing={() => (
        <>
          <span
            className="shrink-0 tabular-nums"
            data-goal-elapsed-seconds={getConversationGoalElapsedSeconds(goal, now)}
          >
            {elapsed}
          </span>
          {control ? <span className="shrink-0">·</span> : null}
          {control}
        </>
      )}
    >
      <div className="space-y-0">
        {iterationRows.map((row) => {
          const title =
            row.title ??
            intl.formatMessage(
              { id: "chat.summaryPanel.goalIterationValue" },
              { count: String(row.iteration) },
            );
          return (
            <div
              key={row.iteration}
              data-goal-iteration={row.iteration}
              data-goal-iteration-completed={row.completed}
              data-goal-verification-outcome={row.verificationOutcome ?? undefined}
              className="flex min-w-0 cursor-default items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]"
              title={title}
            >
              {row.completed ? (
                // 完成的迭代用「序号 + 圆环」而不是勾：序号本身携带顺序信息，
                // 而勾会与分区标题旁的整体完成标记在视觉上重复。
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--color-success)] text-ui-xs tabular-nums text-[var(--color-success)]">
                  {row.iteration}
                </span>
              ) : (
                <GoalIcon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
              )}
              <p className="line-clamp-3 min-w-0 flex-1 text-ui-base leading-4 text-[var(--color-foreground)]">
                {title}
              </p>
              {row.totalCount > 0 ? (
                // 分母为 0 时整段不渲染：0/0 会让用户以为验证项丢了，
                // 而实际含义是「这一轮没有可验证项」，用缺席表达更准确。
                <span className="shrink-0 text-ui-sm tabular-nums text-[var(--color-foreground-subtle)]">
                  {row.completedCount}/{row.totalCount}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </StatusSection>
  );
}

// 状态图标三态映射，未知状态一律落到空心圆（pending 的画法）：
// 这里故意不写 exhaustive switch + default throw——契约会随 CLI 版本新增状态，
// 旧 UI 遇到新状态时应当「看起来还没开始」，而不是整块面板崩掉。
function PlanStatusIcon({ status }: { status: PlanState["items"][number]["status"] }) {
  if (status === "completed") {
    // 完成态用 success 色的勾，且尺寸与其它两态一致（size-3.5）：
    // 尺寸不同会让左侧图标列在状态切换时抖动，Todo 列表看起来在跳。
    return (
      <CheckCircle2Icon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-success)]"
      />
    );
  }
  if (status === "inProgress") {
    // 进行中用箭头而不是旋转 spinner：静态图标不会持续触发重绘，
    // 在长列表里几十行同时「转」会明显拖慢低端设备。
    return (
      <ArrowRightIcon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-foreground)]"
      />
    );
  }
  return (
    <CircleIcon
      aria-hidden
      className="mt-0.5 size-3.5 shrink-0 text-[var(--color-foreground-subtlest)]"
    />
  );
}

// 阈值 6 与窗口 3 是一组：面板可用高度约 20rem，双行 Todo 每条约 52px，
// 6 条恰好填满且不滚动；超过 6 条才折叠成「前 N · 焦点 3 条 · 后 M」。
// 若把阈值改小，5 条的正常计划也会被折出两个预览入口，反而更难读。
const COMPACT_TODO_THRESHOLD = 6;
const TODO_FOCUS_WINDOW_SIZE = 3;

// 三个切片都直接从同一个 items 数组 slice，且保持原序：调用方据此把「前」「焦点」「后」
// 渲染成同一列，不重新排序。compact=false 时 focusItems 就是全部内容，
// 另外两个切片为空，调用方不需要为「是否折叠」写第二套渲染分支。
export interface StatusPanelTodoFocusWindow {
  compact: boolean;
  precedingItems: PlanState["items"];
  focusItems: PlanState["items"];
  followingItems: PlanState["items"];
}

// 焦点项的选取优先级：正在做的 → 第一条未完成 → 末尾三条。
// 全部完成时 getStatusPanelTodoFocusWindow 退化为末尾三条，因为用户最可能回看最近做完的几步。
// 这个函数是纯函数并导出，测试直接锁定切片边界，避免面板宽度/字体变化时窗口悄悄错位。
export function getStatusPanelTodoFocusWindow(
  items: PlanState["items"],
): StatusPanelTodoFocusWindow {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return {
      compact: false,
      precedingItems: [],
      focusItems: items,
      followingItems: [],
    };
  }

  // 两个索引分开找而不是一次遍历：runningIndex 需要「任一 inProgress」，
  // firstUnfinishedIndex 需要「第一个不是 completed 的」——后者包含 pending、blocked 等，
  // 合并判断会把 blocked 误当成 inProgress，从而把焦点窗口拉到一条卡住的任务上。
  const runningIndex = items.findIndex((item) => item.status === "inProgress");
  const firstUnfinishedIndex = items.findIndex((item) => item.status !== "completed");
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : firstUnfinishedIndex >= 0
        ? firstUnfinishedIndex
        : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE);
  // 只取“当前 + 后两条”会让靠近列表末尾的当前项只剩一两条上下文。
  // 从前面回补可以让精简窗口在项目数足够时始终保持三条，同时不改变 snapshot 原序。
  const focusStartIndex = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE));
  const focusEndIndex = Math.min(items.length, focusStartIndex + TODO_FOCUS_WINDOW_SIZE);

  return {
    compact: true,
    precedingItems: items.slice(0, focusStartIndex),
    focusItems: items.slice(focusStartIndex, focusEndIndex),
    followingItems: items.slice(focusEndIndex),
  };
}

// 只渲染行，不包 ul：调用方既把它放进面板主列表，也放进预览浮层里的 ul，
// 由外层决定列表语义与间距。行内 span 用 title 而不是省略号弹层，
// 是因为长文本在窄面板里必然被 line-clamp 截断，title 是唯一的低成本兜底。
function PlanStatusItemRows({ items }: { items: PlanState["items"] }) {
  return items.map((item) => (
    // 行本身不可交互（没有 onClick），悬停高亮只是让长列表更易横向定位；
    // 真正的点击目标在折叠入口与详情按钮上，避免误触把 Todo 当成链接。
    <li
      key={item.id}
      data-plan-status={item.status}
      className="flex min-h-8 items-start gap-2 rounded-lg px-2 py-1.5 text-ui-base hover:bg-[var(--color-hover)]"
    >
      <PlanStatusIcon status={item.status} />
      <span
        title={item.content}
        className={cn(
          "line-clamp-2 min-w-0 flex-1 break-words leading-5",
          item.status === "completed"
            ? "text-[var(--color-foreground-subtlest)] line-through"
            : "text-[var(--color-foreground)]",
        )}
      >
        {item.content}
      </span>
    </li>
  ));
}

// forwardRef 是为了让 Radix 的 HoverCardTrigger asChild 能把锚点 ref 与事件挂到同一个
// 原生按钮上；不转发 ref 时浮层无法定位到触发点，会退化成屏幕中央的游离卡片。
// 事件处理必须「先调用外部 onClick 再看 defaultPrevented」：宿主可能用 preventDefault
// 取消这次点击（例如正在拖拽选择文本），此时不应再打开浮层。
const TodoPreviewTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    group: "preceding" | "following";
    label: string;
    open: boolean;
    onTouchOpen: () => void;
  }
>(function TodoPreviewTrigger({ group, label, onClick, onTouchOpen, open, ...buttonProps }, ref) {
  return (
    // 必须是原生 button：HoverCard 的 asChild 只合并 ref 与事件，不提供焦点语义，
    // 换成 div 后键盘用户完全打不开这个预览（INV-10 的可访问性侧）。
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-expanded={open}
      data-status-todo-preview-trigger={group}
      className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground-subtle)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
      onClick={(event) => {
        onClick?.(event);
        // matchMedia 需判 undefined：SSR/测试环境的 window 上可能没有 matchMedia，
        // 直接调用会抛错并让整行无法点击。hover:none 判定只在触摸设备成立。
        // HoverCard 在桌面由 hover/focus 驱动；仅无 hover 输入补充点击打开，
        // 避免桌面点击把已经由 hover 打开的预览反向关闭。
        if (
          !event.defaultPrevented &&
          typeof window !== "undefined" &&
          window.matchMedia?.("(hover: none)").matches
        ) {
          onTouchOpen();
        }
      }}
    >
      <ChevronLeftIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
});

type TodoPreviewGroup = "preceding" | "following";

// 折叠组的文案要同时表达「方向」与「这些条目的状态」，否则四个入口（前/后 × 完成/待办）
// 会长得一模一样。messageId 的四选一就是这层语义，不能简化成统一的「还有 n 条」。
function TodoHiddenGroupPreview({
  group,
  items,
  onOpenChange,
  open,
  popoverSide,
}: {
  group: TodoPreviewGroup;
  items: PlanState["items"];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  popoverSide: "bottom" | "left";
}) {
  const { intl } = useZCodeIntl();
  // every() 对空数组返回 true，但调用方在 items.length > 0 时才渲染，
  // 因此这里不会出现「0 条也算全部完成」的真空真。
  const messageId =
    group === "preceding"
      ? items.every((item) => item.status === "completed")
        ? "chat.statusPanel.todoCompletedFold"
        : "chat.statusPanel.todoEarlierFold"
      : items.every((item) => item.status === "pending")
        ? "chat.statusPanel.todoWaitingFold"
        : "chat.statusPanel.todoLaterFold";
  const label = intl.formatMessage({ id: messageId }, { count: String(items.length) });

  return (
    <HoverCard closeDelay={80} open={open} openDelay={120} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>
        <TodoPreviewTrigger
          group={group}
          label={label}
          open={open}
          onTouchOpen={() => onOpenChange(true)}
        />
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        side={popoverSide}
        sideOffset={4}
        data-status-todo-preview-content={group}
        className="w-80 max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-[var(--color-popover-border)] bg-[var(--color-menu)] p-3 shadow-md ring-0"
      >
        <div className="flex max-h-[min(24rem,calc(100dvh-2rem))] min-w-0 flex-col">
          <p className="flex h-8 shrink-0 items-center px-2 text-ui-base text-[var(--color-foreground-subtle)]">
            {label}
          </p>
          <ul className="min-h-0 space-y-0 overflow-y-auto pr-1">
            <PlanStatusItemRows items={items} />
          </ul>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// 这里重新计算焦点窗口而不是从 props 传入：displayItems 已经过模型层去重与排序，
// 直接算能保证与渲染的列表严格同源；代价是每次 plan 变化重算一次 O(n)，n 为 Todo 条数，可忽略。
function PlanStatusItems({
  plan,
  popoverSide,
}: {
  plan: NonNullable<ConversationStatusPanelModel["plan"]>;
  popoverSide: "bottom" | "left";
}) {
  // 预览组的开合是本组件唯一的本地状态：它属于「读者此刻在看什么」，
  // 不需要跨形态、跨会话保持，因此不提升到宿主。会话切换时组件随 key 重挂即自然清空。
  const [openPreviewGroup, setOpenPreviewGroup] = useState<TodoPreviewGroup | null>(null);
  // 焦点窗口在这里现算而不是从 props 传：它必须与 plan.displayItems 完全同源，
  // 传进来就可能出现「列表已更新、窗口还是旧的」这种一帧不一致。
  // popoverSide 也在这里被消费，避免两个折叠入口各自决定方向而互相翻转。
  const window = getStatusPanelTodoFocusWindow(plan.displayItems);
  // 同一时刻只允许一个预览组打开：HoverCard 的 open 是受控的，
  // 若不在这里做互斥，鼠标从「前 N」移到「后 M」时两个浮层会同时可见并互相遮挡。
  // 关闭时只清掉自己那一组（current === group），避免把刚打开的另一组误关。
  const handlePreviewOpenChange = (group: TodoPreviewGroup, open: boolean) => {
    setOpenPreviewGroup((current) => (open ? group : current === group ? null : current));
  };

  // 两个折叠入口都用 compact 与「该组非空」双重条件：窗口只有 3 条时不折叠，
  // 也就不该出现「前 0 条」这种入口。条件与 getStatusPanelTodoFocusWindow 的
  // compact 定义必须是同一处真源，否则会出现两边都空却仍渲染入口的情况。
  return (
    <ul className="space-y-0 pb-1">
      {window.compact && window.precedingItems.length > 0 ? (
        // 折叠入口必须包在 li 里：外层是 ul，直接放 button 会让 DOM 结构非法，
        // 读屏的列表项计数也会少一项（入口本身也是一条「还有更多」的记录）。
        <li>
          <TodoHiddenGroupPreview
            group="preceding"
            items={window.precedingItems}
            open={openPreviewGroup === "preceding"}
            onOpenChange={(open) => handlePreviewOpenChange("preceding", open)}
            popoverSide={popoverSide}
          />
        </li>
      ) : null}
      <PlanStatusItemRows items={window.focusItems} />
      {window.compact && window.followingItems.length > 0 ? (
        // 焦点窗口固定在中间，前后两个入口对称：任一入口独立开合，
        // 但打开一个会关掉另一个（见 handlePreviewOpenChange），避免浮层叠加。
        <li>
          <TodoHiddenGroupPreview
            group="following"
            items={window.followingItems}
            open={openPreviewGroup === "following"}
            onOpenChange={(open) => handlePreviewOpenChange("following", open)}
            popoverSide={popoverSide}
          />
        </li>
      ) : null}
    </ul>
  );
}

// SessionPlans 是「本会话里 plan 工具留下的产物」列表，与 Plan 分区（当前运行时 Todo）
// 是两种不同事实：前者可点开历史文档，后者只反映此刻进度。两者都渲染的会话是正常的，
// 因为 compact 之后 Todo 会清空而历史 plan 文档仍在。
function SessionPlansStatusSection({
  model,
  onOpenPlanDetail,
  parentSessionId,
  separated,
}: {
  model: ConversationStatusPanelModel;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  parentSessionId?: string;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  // items 已经在模型层按「本会话 plan 工具调用」过滤过；这里只做空态闸门，
  // 不再二次过滤，否则面板与侧栏对「哪些 plan 属于本会话」会出现两套口径。
  const sessionPlans = model.sessionPlans;
  // 只看对象是否存在：切片由模型层保证非空（没有 plan 工具调用时压根不给 sessionPlans）。
  // 若这里再判 items.length，模型层换成懒加载后会把「还没加载」误判成「没有」。
  if (!sessionPlans) return null;

  return (
    <StatusSection
      // 历史 plan 分区默认展开：条目通常只有一两条，折叠反而要多一次点击。
      // 与 Terminals/Agents 的「背景活动默认折叠」是相反取舍，因为这里的条目是「文档索引」而非实时流。
      section="sessionPlans"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.sessionPlans" })}
    >
      <ul className="space-y-0">
        {sessionPlans.items.map((item) => {
          // 标题兜底走 i18n 而不是原始 id：title 可能是空串，
          // 直接渲染会在列表里留一条没有文本的行，看起来像加载失败。
          const title = item.title ?? intl.formatMessage({ id: "chat.statusPanel.planFallback" });
          // canOpen 需要「父会话 id」与「打开回调」同时存在：详情页必须挂在会话下才能
          // 定位到正确的 transcript，只给回调不给 id 会打开一个空白的侧栏页。
          const canOpen = Boolean(parentSessionId && onOpenPlanDetail);
          return (
            <li key={item.toolCallId}>
              <button
                type="button"
                data-plan-directory-tool-call-id={item.toolCallId}
                disabled={!canOpen}
                aria-label={intl.formatMessage({ id: "chat.statusPanel.openPlan" }, { title })}
                onClick={() => {
                  if (!parentSessionId) return;
                  onOpenPlanDetail?.(buildSessionPlanOpenRequest(parentSessionId, item));
                }}
                className={cn(
                  "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-base text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]",
                  canOpen && "hover:bg-[var(--color-hover)]",
                )}
              >
                <ListChecksIcon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </StatusSection>
  );
}

// 侧栏请求是纯数据：markdown 由模型层从 tool call 参数里取出，planFilePath 可选。
// 这里不读文件、不做存在性校验——文件可能已在会话外被删除，是否降级由侧栏页自己决定；
// 若在面板里预检，会把一次点击变成一次异步 RPC，且失败提示无处安放。
export function buildSessionPlanOpenRequest(
  parentSessionId: string,
  item: ConversationStatusPanelSessionPlanItem,
): OpenPlanDetailSideTabRequest {
  // planFilePath 用条件展开而不是赋 undefined：侧栏会用「字段存在」判断是否
  // 作为文件打开，显式 undefined 会让它走错分支（存在但为空）。
  return {
    parentSessionId,
    toolCallId: item.toolCallId,
    markdown: item.markdown,
    ...(item.planFilePath ? { planFilePath: item.planFilePath } : {}),
  };
}

// Todo 分区的展示是完全无状态的：开合交给 StatusSection，折叠窗口由纯函数算出，
// 本组件只负责把三者拼起来。正因为无状态，plan 每次更新都整体重绘，
// 所以外层用 key（id+content+status）强制重建，避免沿用上一个计划的预览开合。
function PlanStatusSection({
  model,
  popoverSide,
  separated,
}: {
  model: ConversationStatusPanelModel;
  popoverSide: "bottom" | "left";
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const plan = model.plan;
  // Todo 指针只依赖 plan 对象存在与否；canRenderPlan 与这里必须一致，
  // 否则会出现「外层认为该渲染、内层 null」的空壳分区（INV-28）。
  if (!plan) return null;
  // totalCount > 0 是必要的保护：空计划下 completedCount >= totalCount 也成立，
  // 会把「还没开始」染成成功色。所有项完成才用 success 色，其余一律 subtle。
  const isCompleted = plan.totalCount > 0 && plan.completedCount >= plan.totalCount;

  return (
    <StatusSection
      // 受控开合：open/onOpenChange 直通宿主（面板折叠状态要跨形态保持），
      // 因此这里不传 defaultOpen；两者同时传时受控值优先，defaultOpen 会变成无声的噪音。
      section="plan"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.todo" })}
      trailing={() => (
        <span
          className={cn(
            "tabular-nums",
            isCompleted ? "text-[var(--color-success)]" : "text-[var(--color-foreground-subtle)]",
          )}
        >
          {plan.completedCount}/{plan.totalCount}
        </span>
      )}
    >
      <PlanStatusItems
        key={plan.displayItems
          .map((item) => `${item.id}\u0000${item.content}\u0000${item.status}`)
          .join("\u0001")}
        plan={plan}
        popoverSide={popoverSide}
      />
    </StatusSection>
  );
}

// 停止按钮必须 stopPropagation：它渲染在整行透明「打开」按钮之上，
// 少了这一句，一次点击会同时触发取消与打开两个动作（取消是不可撤销的）。
// onCancel 缺失时返回 null 而不是渲染 disabled 按钮：行内空间有限，
// 一个永远点不动的 Stop 只会挤掉时长与标题。
function RunningWorkCancelButton({
  workId,
  onCancel,
}: {
  workId: string;
  onCancel?: (workId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // useCallback 依赖 onCancel 与 workId：workId 变化意味着按钮换了目标，
  // 沿用旧闭包会把「停 A」的请求发给刚切换到 B 的行（同一组件实例被复用时的经典竞态）。
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onCancel?.(workId);
    },
    [onCancel, workId],
  );

  if (!onCancel) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, workId)}
      aria-label={intl.formatMessage({
        id: "chat.summaryPanel.stopRunningBackgroundTask",
      })}
      onClick={handleClick}
      className="pointer-events-auto relative z-[2] ml-auto h-6 shrink-0 px-1.5 text-ui-base text-[var(--color-foreground)]"
    >
      <SquareIcon aria-hidden className="size-3 fill-current" />
      {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
    </Button>
  );
}

// 返回 null 而不是抛错：子代理详情是增强能力，宿主没接 parentSessionId（例如
// 只读快照视图）时应当「没有这个入口」，而不是让整行渲染失败。
// rootSessionId 回落成 parentSessionId：单层子代理下二者相同，深层嵌套时
// 由模型层给到真正的根，回落只覆盖旧协议缺字段的情况。
export function buildRunningSubagentOpenRequest({
  parentSessionId,
  rootSessionId,
  subagent,
}: {
  parentSessionId?: string;
  rootSessionId?: string;
  subagent: ZCodeSessionRunningSubagent;
}): OpenSubagentSideTabRequest | null {
  // 没有 parentSessionId 就无法定位会话，直接返回 null 让调用方把入口置为不可点；
  // 这里不抛错：子会话可能存在，只是当前视图不提供导航能力。
  if (!parentSessionId) return null;
  return {
    // rootSessionId 回落成 parentSessionId：旧协议没有 rootSessionId，
    // 单层场景下二者相同；这保证了目录页与详情页对「根」的理解一致（INV-22）。
    rootSessionId: rootSessionId ?? parentSessionId,
    parentSessionId,
    childSessionId: subagent.childSessionId,
    subagentType: subagent.subagentType,
    title: subagent.title,
  };
}

// 一行由三层叠成：底层是绝对定位的透明「打开详情」按钮，中层是图标与文本
// （pointer-events-none，把点击让给底层），顶层是 Stop（pointer-events-auto + z-[2]）。
// 这个层序不能调换：一旦文本层接收指针事件，点击行内任意位置都打不开详情。
function RunningStatusItem({
  now,
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  work,
}: {
  now: number;
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  work: BackgroundWorkSummary;
}) {
  const { intl } = useZCodeIntl();

  return (
    <li
      data-testid={testId(TID_V4_BACKGROUND_WORK_ITEM, work.workId)}
      data-background-task-kind={work.kind}
      data-work-id={work.workId}
      data-work-status={work.status}
      className="group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]"
    >
      {onOpenBackgroundBash ? (
        // 覆盖整行的透明按钮：用 aria-label 而不是 title 承载可读名，
        // 因为它是唯一可获得焦点的元素，读屏只会读它自己的标签。
        // inset-0 + 圆角与 li 对齐，保证 hover 区域与点击区域完全重合。
        <button
          type="button"
          className="absolute inset-0 rounded-lg focus-visible:outline-ring"
          aria-label={intl.formatMessage({ id: "bashOutput.open" }, { title: work.title })}
          data-testid="background-bash-open"
          onClick={() => onOpenBackgroundBash(work)}
        />
      ) : null}
      <SquareTerminalIcon className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
          {work.title}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
          <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
            {formatBackgroundTaskElapsedLabel(
              getBackgroundWorkElapsedMs(work, now),
              intl.formatMessage,
            )}
          </span>
          {work.cancellable !== false ? (
            // 不可取消时不渲染按钮而不是渲染 disabled：这一行空间紧，
            // 一个永远灰着的 Stop 会挤掉时长，且无法解释「为什么不能停」。
            <RunningWorkCancelButton workId={work.workId} onCancel={onCancelBackgroundWork} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

// Terminals 与 Agents 共用这一个分区实现：两者的数据结构都是 BackgroundWorkSummary，
// 差别只在标题、图标（由行内决定）与所属 section。抽出来是为了让两处的排序、
// 秒表、收起态文案、取消按钮行为不可能长出两套不同实现。
// 默认折叠（defaultOpen=false）：这两类活动通常是「背景」，不该抢走主状态的注意力。
function BackgroundWorkStatusSection({
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  onOpenChange,
  open,
  separated,
  section,
  title,
  works,
}: {
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated: boolean;
  section: "terminal" | "agent";
  title: string;
  works: readonly BackgroundWorkSummary[];
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  // 投影里的顺序不保证稳定（可能按 workId 或 map 迭代序），这里显式按 startedAt 升序：
  // 启动越早的排越前，与「谁跑得最久」的直觉一致。slice 是为了不改动入参（只读投影）。
  const orderedRunningWorks = useMemo(
    () => [...works].sort((left, right) => left.startedAt - right.startedAt),
    [works],
  );

  // 依赖 works.length 而不是 works：只要条数不变（例如某条任务的标题或状态更新），
  // 重新建 interval 没有任何收益，却会让秒表在不同步的时机重置。条数变化才代表
  // 「有没有在跑」可能翻转，此时重建是必要的。
  // 清理函数必须在条数变化/卸载时 clearInterval，否则面板折叠后仍每秒 setNow。
  useEffect(() => {
    if (works.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [works.length]);

  // 空分区必须整体不渲染，而不是渲染一个「0 个运行中」的标题：
  // 那会让面板在没有任何后台活动时也常驻一行，压缩正文可视高度。
  if (works.length === 0) return null;

  // 收起态只显示「最长那条」的时长，且至少 1 秒：刚启动的任务会显示 0秒，
  // 读起来像计时器坏了，clamp 到 1 秒表示「已经开始」。
  const collapsedElapsedLabel = formatDurationUnits(
    Math.max(1, Math.floor(getLongestRunningWorkElapsedMs(works, now) / 1000)),
    intl.formatMessage,
  );

  return (
    <StatusSection
      // section 决定滚动策略表的查表键：传错会让终端分区拿到 agent 的限高，
      // 因此这里的类型是 "terminal" | "agent" 的封闭联合，而不是 string。
      section={section}
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        isOpen ? (
          // 展开时只报「N 个运行中」，不报时长：每行自己都有秒表，
          // 标题再给一个汇总时长反而让人以为那是总耗时（并行任务不该相加）。
          <span>
            {intl.formatMessage(
              {
                id:
                  works.length === 1
                    ? "chat.statusPanel.runningStatusValue"
                    : "chat.statusPanel.runningStatusValuePlural",
              },
              { count: String(works.length) },
            )}
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate">{collapsedElapsedLabel}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{formatRunningCount(intl.formatMessage, works.length)}</span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {orderedRunningWorks.map((work) => (
          <RunningStatusItem
            key={work.workId}
            work={work}
            now={now}
            onOpenBackgroundBash={onOpenBackgroundBash}
            onCancelBackgroundWork={onCancelBackgroundWork}
          />
        ))}
      </ul>
    </StatusSection>
  );
}

/**
 * run 行的时长：沿用分区头部的时长单位（formatDurationUnits），但不带「已运行」前缀，且超过
 * 一小时去掉秒——一条跑了一小时的 run 上逐秒跳动的数字只是噪音（`1小时 2分` / `1h 2m`）。
 */
function formatWorkflowRunElapsed(
  elapsedMs: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  // 分与秒的取舍在 3600 秒处切换：超过一小时时把秒抹掉（seconds - seconds % 60），
  // 否则一行每秒跳变一次，在扫描列表时非常刺眼。Math.max(0, ...) 防负时长。
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return formatDurationUnits(seconds >= 3600 ? seconds - (seconds % 60) : seconds, formatMessage);
}

/** run 「此刻在做什么」的词，按 i18n 拼成一句（规则在模型层的 `workflowRunWords`）。 */
function formatWorkflowRunWords(
  words: ConversationStatusPanelWorkflowRunWords,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  // 四种 kind 必须各自映射到不同 i18n key：phases 是「3/5 · 步骤名」，
  // status 是状态词，error 是失败原因。混用会让「phase 进度」被读成状态词，
  // 用户无法判断是卡住了还是仍在推进。
  switch (words.kind) {
    case "status":
      return formatMessage({ id: `chat.toolCall.workflow.run.status.${words.status}` });
    case "steps":
      return formatMessage(
        { id: "chat.toolCall.workflow.card.steps" },
        { done: String(words.done), total: String(words.total) },
      );
    case "phases":
      return words.text;
  }
}

/** 未命名的判定：`title ≡ runId`（见 `ConversationStatusPanelWorkflowRun.title`）。 */
// 未命名判定必须与模型层的 title 约定一致：title ≡ runId 表示「没有可读名字」，
// 此时展示 i18n 的 fallbackName。若这里改成「title 为空才 fallback」，
// runId 会被当成名字显示出来，用户会看到一串随机 id。
function workflowRunDisplayName(run: ConversationStatusPanelWorkflowRun): string | null {
  return run.title && run.title !== run.runId ? run.title : null;
}

/** 单盏状态灯（pending 空心、running 脉冲），与卡片、侧栏同一套 `STATUS_DOT`。 */
// 灯复用 RUN_STATUS_DOT（与工作流卡、侧栏同一套色），保证「同一条 run 在任何位置
// 颜色一致」。aria-hidden 是必要的：状态已经由旁边的文字播报，灯再播一次会让读屏重复。
function WorkflowRunLamp({ status }: { status: "pending" | "running" }) {
  return (
    <span
      aria-hidden="true"
      data-workflow-run-lamp={status}
      className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[status])}
    />
  );
}

/**
 * run 行的 Stop（docs/dynamic-workflow/presentation.md「Other places a run appears」）：沿用今天的
 * 幽灵按钮（方块 + 「停止」），但**叠在时长上**——悬停或键盘焦点落进这一行时出现、时长淡出；
 * 平时不占位，整列行因此只剩名字和时长。没有悬停的触屏（`hover: none`）上常驻，换成第三列的 32px
 * 图标按钮。隐藏时同时关掉指针事件：一个看不见却点得中的 Stop 会在用户点时长时停掉 run。
 * 背景用不透明的 menu-hover：它与悬停中的行同色，盖住时长下面可能被截断的名字尾巴。
 */
function WorkflowRunStopButton({
  workId,
  onCancel,
}: {
  workId: string;
  onCancel: (workId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, workId)}
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.cancel" })}
      onClick={(event) => {
        // 必须阻止冒泡：Stop 叠在整行透明「打开详情」按钮之上，
        // 少了这一句，点击会先打开详情页再取消 run，两个动作都不可撤销。
        event.stopPropagation();
        onCancel(workId);
      }}
      className={cn(
        "pointer-events-none absolute right-1.5 top-1.5 z-[2] h-6 gap-1 bg-menu-hover px-1.5 text-ui-sm text-foreground opacity-0 transition-opacity",
        "hover:bg-[image:linear-gradient(var(--color-hover),var(--color-hover))]",
        "group-hover/wf-run:pointer-events-auto group-hover/wf-run:opacity-100 group-focus-within/wf-run:pointer-events-auto group-focus-within/wf-run:opacity-100",
        "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:size-8 [@media(hover:none)]:bg-transparent [@media(hover:none)]:p-0 [@media(hover:none)]:text-foreground-subtle [@media(hover:none)]:opacity-100",
      )}
    >
      <SquareIcon aria-hidden className="size-2.5 fill-current [@media(hover:none)]:size-3" />
      <span className="[@media(hover:none)]:sr-only">
        {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
      </span>
    </Button>
  );
}

/**
 * 一条 run 两行定高（56px）：第一行 名字 + 时长，第二行 侧栏同款轨道 + 「在做什么」的词。
 * 字段三簇逐簇独立缺席（见 `ConversationStatusPanelWorkflowRun`）：
 * - 无 `status`：偏斜降级行（旧 CLI），只剩第一行——不知道状态就不画灯、不说词；
 * - 无 `startedAt`：没有配对的后台任务，没有时长；pending 也不报时长；
 * - 无 `workId` / 不可取消：没有 Stop，时长常驻。
 * 可见的状态词没了（灯和 phase 已经说了），所以它进打开按钮的无障碍名：名字 · 状态 · 词。
 */
function WorkflowRunRow({
  now,
  onCancelBackgroundWork,
  onOpenWorkflowRun,
  run,
}: {
  now: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  run: ConversationStatusPanelWorkflowRun;
}) {
  const { intl } = useZCodeIntl();
  // 行 → 打开意图的换算与 composer 徽标直达共用（模型层 workflowRunOpenTarget）。
  const openTarget = onOpenWorkflowRun ? workflowRunOpenTarget(run) : null;
  const name = workflowRunDisplayName(run);
  // 无名字时用 i18n 的 fallbackName，而不是显示 runId 或留空：
  // 留空会让这一行只剩灯和时长，读屏更是完全无法识别这是哪条 run。
  const displayName = name ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const words = workflowRunWords(run);
  const wordsText = words ? formatWorkflowRunWords(words, intl.formatMessage) : null;
  // pending 不报时长：它还没被调度，now - startedAt 只会是一个误导性的等待值。
  // 无 startedAt 同理（无配对的后台任务），这两种情况都必须渲染成「没有时长」而不是 0秒。
  const elapsed =
    run.startedAt === undefined || run.status === "pending"
      ? null
      : formatWorkflowRunElapsed(now - run.startedAt, intl.formatMessage);
  // 可停止需要三个条件同时成立：有 workId（能定位到后台任务）、未显式标记不可取消、
  // 宿主接入了取消回调。cancellable !== false 沿用「缺字段按可取消」的兼容口径。
  const canStop = Boolean(run.workId && run.cancellable !== false && onCancelBackgroundWork);
  // status 理论上恒有值，但仍保留空值分支：i18n 模板是以 status 为后缀拼出来的，
  // 未登记的状态会得到 key 本身（如 "chat.toolCall.workflow.run.status.x"），
  // 此时宁可返回 null 让无障碍名少一段，也不要把内部 key 播报给用户。
  const statusWord = run.status
    ? intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` })
    : null;
  // 无障碍名把「动作 · 名字 · 状态 · 此刻在做什么」拼成一句：可见文本里状态词
  // 已经由灯和 phase 表达，但读屏读不到灯，所以必须补进 label。
  // 当 wordsText 与 statusWord 相同（status 型词）时去重，避免「运行中 · 运行中」。
  const openLabel = [
    intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" }),
    displayName,
    statusWord,
    wordsText === statusWord ? null : wordsText,
  ]
    .filter(Boolean)
    .join(" · ");
  // phases 只在 words.kind === "phases" 时被读取，但这里无条件归一化：
  // 让下方 JSX 的分支拿到稳定类型（数组），不必在渲染里写两次空值判断。
  const phases = run.phases ?? [];

  return (
    <li
      data-testid={run.workId ? testId(TID_V4_BACKGROUND_WORK_ITEM, run.workId) : undefined}
      data-background-task-kind="workflow"
      data-workflow-run-id={run.runId}
      data-work-id={run.workId}
      data-work-status={run.status}
      className={cn(
        "group/wf-run relative grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 rounded-lg p-2 hover:bg-[var(--color-hover)]",
        canStop && "[@media(hover:none)]:grid-cols-[1rem_minmax(0,1fr)_2rem]",
        openTarget && "cursor-pointer",
      )}
    >
      {openTarget ? (
        // 行里还有 Stop 这个嵌套交互，整行 button 会套出嵌套按钮：透明同级按钮承接「打开详情页」，
        // Stop 保持独立交互层并阻止冒泡（与 Agent 行同款）。
        <button
          type="button"
          data-workflow-run-details-trigger="true"
          data-workflow-run-id={run.runId}
          aria-label={openLabel}
          title={displayName}
          onClick={() => onOpenWorkflowRun?.(openTarget)}
          className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
        />
      ) : null}
      <Workflow className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 self-start text-[var(--color-foreground-subtle)]" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-col gap-0.5">
        <div
          data-workflow-island-line="name"
          className="flex h-5 min-w-0 items-baseline gap-2 leading-5"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-ui-base",
              name ? "text-[var(--color-foreground)]" : "text-[var(--color-foreground-subtle)]",
            )}
          >
            {displayName}
          </span>
          {elapsed ? (
            // 触屏（hover:none）下 Stop 独占第三列，时长必须挪到 phase 行末尾；
            // 桌面下悬停/聚焦时淡出，把位置让给 Stop——两个元素不能同时占同一格，
            // 否则 grid 会临时加宽导致整行文字重排。
            <span
              data-workflow-run-elapsed="true"
              className={cn(
                "shrink-0 text-ui-sm tabular-nums text-[var(--color-foreground-subtle)] transition-opacity",
                canStop &&
                  "group-hover/wf-run:opacity-0 [@media(hover:hover)]:group-focus-within/wf-run:opacity-0",
                // 触屏：Stop 占了第三列，时长挪到第二行末尾（没有第二行时留在这里）。
                canStop && wordsText && "[@media(hover:none)]:hidden",
              )}
            >
              {elapsed}
            </span>
          ) : null}
        </div>
        {words && wordsText ? (
          <div
            data-workflow-island-line="phase"
            className="flex h-4.5 min-w-0 items-center gap-1.5 text-ui-sm text-[var(--color-foreground-subtle)]"
          >
            {words.kind === "phases" ? (
              // phases 用轨道（rail）而不是灯：轨道能同时表达「第几步/共几步」，
              // 灯只能表达「在跑」。两者互斥，不能用灯再叠一段进度文本。
              <WorkflowRunRail rail={foldWorkflowRunRail(phases)} intl={intl} />
            ) : (
              // 非 phases 型词（status/error/steps）只用灯：这些信息已经由 wordsText 完整表达，
              // 再加进度轨道会暗示一个并不存在的步骤划分。
              <WorkflowRunLamp status={run.status === "pending" ? "pending" : "running"} />
            )}
            <span className="min-w-0 flex-1 truncate">{wordsText}</span>
            {elapsed && canStop ? (
              // 这一份时长是触屏专用的副本，aria-hidden 防止读屏读两遍：
              // 桌面副本与它在 DOM 里同时存在，只是被媒体查询各自隐藏。
              <span
                aria-hidden="true"
                className="hidden shrink-0 tabular-nums [@media(hover:none)]:inline"
              >
                {elapsed}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {canStop && run.workId && onCancelBackgroundWork ? (
        // 三个条件在这里再判一次（canStop 已包含），是为了让 TypeScript 在 JSX 内
        // 收窄 run.workId 的类型：canStop 是 boolean，无法帮它穿过属性访问。
        <WorkflowRunStopButton workId={run.workId} onCancel={onCancelBackgroundWork} />
      ) : null}
    </li>
  );
}

/**
 * Workflows 分区：与 Terminals / Agents 并列的第三类实时活动，**外加**一条通往 run 目录的
 * 页脚行——已结束的 run 折进这条页脚行，不占活动列表的位置。
 *
 * 头部右侧开合一个样：一盏运行灯 + 「{n} 个运行中」。折叠时不再换成「所有 run 里最长的时长」
 * ——那不是任何一条 run 的时间。只有 run 列表滚动（三行半，露出的半行告诉人下面还有）；
 * 已结束入口放在滚动区之外，run 再多也滚不走它。
 *
 * **不排序**：顺序 = 投影 runs 序 = 启动序（模型层已经保证）。Terminals / Agents 按
 * startedAt 排是因为它们的投影无序；这里重排反而会让行在每次投影更新时跳位。
 */
function WorkflowStatusSection({
  endedRunCount,
  onCancelBackgroundWork,
  onOpenChange,
  onOpenDirectory,
  onOpenWorkflowRun,
  open,
  parentSessionId,
  runs,
  separated,
  title,
}: {
  endedRunCount: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  open?: boolean;
  parentSessionId?: string;
  runs: readonly ConversationStatusPanelWorkflowRun[];
  separated: boolean;
  title: string;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  // 只有带 startedAt 的行需要秒级刷新；一行都没有时不必让面板每秒重渲染。
  // 只有「真的在跑且有 startedAt」的行才需要秒级刷新。这里用 filter 计数而不是
  // 复用 runs.length：pending 行没有时长，为它们每秒重渲染整个列表是纯浪费，
  // 而且会让 Stop 按钮的 hover 状态在重渲染时被频繁打断。
  const tickingRunCount = runs.filter((run) => run.startedAt !== undefined).length;
  // 计数为 0 时直接 return，不建立 interval：这是「面板静置时不跑定时器」的唯一保证，
  // 清理函数与建立函数必须成对；依赖 tickingRunCount 而不是 runs，理由同 Terminals 分区。
  useEffect(() => {
    if (tickingRunCount === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tickingRunCount]);

  // 活动行与已结束计数**都**为零才收起整个分区：只按活动数开门的那一版，重启后一个 run
  // 都不在跑，于是入口连带目录页一起消失——而重启后回看被打断的 run 正是它的主要用途。
  // 两个条件都是「渲染这个分区的理由」：有活 run，或存在已结束的 run 目录入口。
  // 用 <= 而不是 === 防御计数为负（理论上不可能，但跨版本协议传坏值时不要整块消失）。
  if (runs.length === 0 && endedRunCount <= 0) return null;

  return (
    <StatusSection
      section="workflow"
      // 宿主不接管开合时同一条规则：有活 run 就默认打开（受控时由宿主按同一规则驱动）。
      // defaultOpen 只在非受控时被读取，受控后由宿主按同一规则重算，
      // 两边口径必须一致，否则展开动画会在首帧跳一下。
      defaultOpen={runs.length > 0}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={() =>
        runs.length > 0 ? (
          <>
            <WorkflowRunLamp status="running" />
            <span>
              {intl.formatMessage(
                { id: "chat.statusPanel.workflowsLive" },
                { count: String(runs.length) },
              )}
            </span>
          </>
        ) : null
      }
      // 已结束的 run 折进这条页脚行（与 Agents 分区共用同一个 affordance）：终态 run 不占
      // 活动列表的位置，但入口必须留着——被打断的那些正是最需要点进去的。
      // 页脚必须由 endedRunCount > 0 与 onOpen 共同兜底（EndedDirectoryRow 内判断），
      // 这里再传 separated=runs.length > 0：没有活动行时页脚就是唯一内容，不该再画分隔线。
      footer={
        <EndedDirectoryRow
          count={endedRunCount}
          icon={
            <CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
          }
          label={intl.formatMessage({ id: "chat.statusPanel.endedWorkflows" })}
          separated={runs.length > 0}
          testId="workflow-run-directory-trigger"
          onOpen={
            parentSessionId && onOpenDirectory
              ? () => onOpenDirectory({ parentSessionId })
              : undefined
          }
        />
      }
    >
      <ul className="space-y-0">
        {runs.map((run) => (
          // 不排序：模型层已按启动序给出 runs，这里再排会引入第二处顺序定义，
          // 且每次投影更新都可能与页脚计数不同步（行数变了但顺序没变）。
          <WorkflowRunRow
            key={run.runId}
            run={run}
            now={now}
            onCancelBackgroundWork={onCancelBackgroundWork}
            onOpenWorkflowRun={onOpenWorkflowRun}
          />
        ))}
      </ul>
    </StatusSection>
  );
}

// Subagent 与 Terminals 的数据结构不同（前者是 ConversationStatusPanelRunningSubagent），
// 因此不能复用 BackgroundWorkStatusSection：字段名不同（controlWorkId vs workId），
// 且行内要展示子会话标题、打开子会话详情。硬套会让两边的可选链各自分叉。
function SubagentStatusSection({
  endedSubagentCount,
  onCancelBackgroundWork,
  onOpenChange,
  onOpenSubagentDirectory,
  onOpenSubagentSession,
  open,
  parentSessionId,
  rootSessionId,
  separated,
  title,
  subagents,
}: {
  endedSubagentCount: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  open?: boolean;
  parentSessionId?: string;
  rootSessionId?: string;
  separated: boolean;
  title: string;
  subagents: readonly ConversationStatusPanelRunningSubagent[];
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  // startedAt 可能缺失（旧协议），用 ?? 0 让它们排在列表最前而不是产生 NaN 比较：
  // NaN 参与 sort 比较时顺序未定义，行会随机跳动。0 是「未知即最早」的显式取舍。
  const ordered = useMemo(
    () => [...subagents].sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0)),
    [subagents],
  );
  // 只有条数变化才重建 interval（依赖 subagents.length）：任何一条子代理的标题更新
  // 都不该重置秒表相位。清理函数必须存在，否则分区折叠后仍在每秒 setState。
  useEffect(() => {
    if (subagents.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [subagents.length]);
  // 与 Workflow 分区同一道门：只要还有已结束的子代理，分区就必须留着，
  // 否则重启后（活子代理为 0）通往「已结束智能体」目录的入口会消失。
  if (subagents.length === 0 && endedSubagentCount <= 0) return null;
  // 缺 startedAt 时用 now 做起点，等价于「刚启动」：显示 0秒 而不是 1970 年的巨大时长。
  // 这是 INV-12 的具体落点，和 getBackgroundWorkElapsedMs 的 clamp 是同一件事的两面。
  const longestElapsedMs = subagents.reduce(
    (longest, item) => Math.max(longest, Math.max(0, now - (item.startedAt ?? now))),
    0,
  );

  return (
    <StatusSection
      // 默认折叠：子代理是背景活动，展开面板时首要信息是 Git/Goal/Todo。
      // 受控值优先于 defaultOpen，宿主一旦接管，这里的 false 只影响未接管的嵌入场景。
      section="agent"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        subagents.length === 0 ? null : isOpen ? (
          // 展开时只报条数；收起时才报「最长时长 · 条数」。
          // subagents.length === 0 时必须 null 而不是 0秒：只剩已结束目录时，
          // 一个「0秒」会让人以为有子代理卡住了。
          <span>{formatRunningSubagentCount(intl.formatMessage, subagents.length)}</span>
        ) : (
          <>
            <span className="min-w-0 truncate">
              {formatDurationUnits(
                Math.max(1, Math.floor(longestElapsedMs / 1000)),
                intl.formatMessage,
              )}
            </span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">
              {formatRunningSubagentCount(intl.formatMessage, subagents.length)}
            </span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {ordered.map((subagent) => {
          // request 在 map 内构造而不是提升到分区级：它依赖每一行的 childSessionId，
          // 提升会变成「先算全部再配对」，多一层索引且容易与行错位。
          const request = buildRunningSubagentOpenRequest({
            parentSessionId,
            rootSessionId,
            subagent,
          });
          // request 与回调必须同时存在才可点：request 为空说明缺会话上下文，
          // 回调为空说明宿主不提供子会话导航。两者缺一时保留行但不可点（不隐藏），
          // 让用户仍能看到「这个子代理在跑」这一事实。
          const canOpenSubagentSession = Boolean(request && onOpenSubagentSession);
          return (
            <li
              key={subagent.childSessionId}
              data-testid={
                subagent.controlWorkId
                  ? testId(TID_V4_BACKGROUND_WORK_ITEM, subagent.controlWorkId)
                  : undefined
              }
              data-background-task-kind="agent"
              data-child-session-id={subagent.childSessionId}
              data-work-id={subagent.controlWorkId}
              data-work-status="running"
              className={cn(
                "group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]",
                canOpenSubagentSession && "cursor-pointer",
              )}
            >
              {canOpenSubagentSession ? (
                // Agent 行同时包含“打开详情”和 Stop，不能用整行 button 包住
                // Stop 形成嵌套按钮。透明同级按钮承接详情，Stop 保持独立交互层且阻止冒泡。
                <button
                  type="button"
                  data-running-subagent-session-trigger="true"
                  data-child-session-id={subagent.childSessionId}
                  aria-label={intl.formatMessage({
                    id: "chat.summaryPanel.openRunningSubagentSession",
                  })}
                  onClick={() => request && onOpenSubagentSession?.(request)}
                  className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
                />
              ) : null}
              <BotIcon className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
              <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
                  {subagent.title}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
                  <span className="text-ui-base tabular-nums text-[var(--color-foreground-subtle)]">
                    {formatBackgroundTaskElapsedLabel(
                      Math.max(0, now - (subagent.startedAt ?? now)),
                      intl.formatMessage,
                    )}
                  </span>
                  {subagent.controlWorkId && subagent.cancellable !== false ? (
                    // 与后台任务行同一口径：controlWorkId 是「能停哪个后台任务」的键，
                    // 与 childSessionId 不是一回事——子会话可能没有对应的可取消任务。
                    <RunningWorkCancelButton
                      workId={subagent.controlWorkId}
                      onCancel={onCancelBackgroundWork}
                    />
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <EndedSubagentDirectoryRow
        // separated 取决于「上面是否有活动行」，而不是分区是否展开：
        // 折叠状态下页脚仍可见，此时它就是唯一内容，不该带分隔线。
        count={endedSubagentCount}
        parentSessionId={parentSessionId}
        rootSessionId={rootSessionId}
        onOpen={onOpenSubagentDirectory}
        separated={subagents.length > 0}
      />
    </StatusSection>
  );
}

// 页脚行的契约：count 由宿主从 journal 口径提供（不能用活投影推算，INV-13），
// separated 由调用方按「上方是否已有可见行」给出，onOpen 为空时整行不渲染。
// 这三条必须同时满足，否则会出现「显示 N 条但点不开」或「有入口但计数为 0」的矛盾状态。
/**
 * 「已结束的 X · N ›」页脚行：分区里那条通往目录页的入口。
 *
 * Agents 与 Workflows **共用这一个** affordance（图标/文案/计数/回调由调用方给）。抽出来的
 * 理由不是省行数，而是不出现第二套画法：两个分区的页脚行若各写一遍，两者会随时间长出不同的
 * 间距、不同的 hover、不同的计数位置，而它们在读者眼里本来是同一个动作。
 *
 * `count <= 0` 或缺回调即整行缺席：一个点了没反应的入口比没有入口更糟。
 */
function EndedDirectoryRow({
  count,
  icon,
  label,
  onOpen,
  separated,
  testId,
}: {
  count: number;
  icon: ReactNode;
  label: string;
  onOpen?: () => void;
  separated: boolean;
  testId?: string;
}) {
  // 两个前置条件都必须成立才渲染：没有计数就没有内容，没有回调就点不开。
  // 一个点了没反应的入口比没有入口更糟——用户会怀疑是应用卡住，而不是缺功能。
  if (count <= 0 || !onOpen) return null;
  return (
    <div className={cn(separated && "border-t border-[var(--color-border)] pt-2")}>
      <button
        type="button"
        data-testid={testId}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
        onClick={onOpen}
      >
        {icon}
        <span>{label}</span>
        <span className="ml-auto text-[var(--color-foreground-subtle)]">{count}</span>
        <ChevronRightIcon className="size-4 text-[var(--color-foreground-subtle)]" />
      </button>
    </div>
  );
}

// 子代理目录的 request 在这里一次性组装好：rootSessionId 缺失时回落到 parentSessionId，
// 与 buildRunningSubagentOpenRequest 同一口径，保证目录页和单条详情页对「根会话」
// 的理解一致（否则目录会按另一棵树查询，列出空列表）。
function EndedSubagentDirectoryRow({
  count,
  onOpen,
  parentSessionId,
  rootSessionId,
  separated,
}: {
  count: number;
  onOpen?: (request: OpenSubagentDirectorySideTabRequest) => void;
  parentSessionId?: string;
  rootSessionId?: string;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <EndedDirectoryRow
      count={count}
      icon={<CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />}
      label={intl.formatMessage({ id: "chat.statusPanel.endedAgents" })}
      separated={separated}
      onOpen={
        parentSessionId && onOpen
          ? () =>
              onOpen({
                rootSessionId: rootSessionId ?? parentSessionId,
                parentSessionId,
              })
          : undefined
      }
    />
  );
}

// 胶囊里的一个指标：图标默认可见，悬停/键盘聚焦时换成「最大化」图标，
// 暗示整块胶囊是一个可点击的展开控件。两个图标都绝对定位叠在同一格里，
// 用 opacity 交叉淡出，避免切换时行高抖动。
function StatusSummaryMetric({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    // 图标有两层：静止态显示传入的 icon，hover/键盘聚焦时切成「最大化」，
    // 两者绝对定位叠放，用 opacity 交叉过渡——换成条件渲染会让宽度在切换瞬间跳动。
    <div className="flex h-8 w-max max-w-full min-w-0 items-center gap-1.5 pl-2 pr-3 text-ui-base text-[var(--color-foreground)]">
      <span className="relative size-4 shrink-0">
        <span className="absolute inset-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
          {icon}
        </span>
        <Maximize2Icon className="absolute inset-0 size-4 text-[var(--color-foreground)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </span>
      {children}
    </div>
  );
}

/**
 * 胶囊里的工作流摘要：Workflow 图标 · 名字 · 灯 · phase 词 · `+n`（其余在跑的 run）。
 * phase 词整段保留（至多占 45%），先截的是名字：名字看开头就认得出，截断的 phase 什么也说不了。降级行（旧 CLI，无状态）只有名字，不画灯——不知道状态就不猜。
 */
// 胶囊里的工作流摘要：名字可截断，phase 词封顶 45% 且不收缩。
// 顺序上是「名字让位、phase 保留」——名字看开头就能认出，截断的 phase 什么也说不了。
// 无状态的降级行（旧 CLI）只有名字，不画灯：不知道状态就不猜。
function WorkflowSummaryMetric({
  others,
  run,
}: {
  others: number;
  run: ConversationStatusPanelWorkflowRun;
}) {
  const { intl } = useZCodeIntl();
  const name = workflowRunDisplayName(run);
  const words = workflowRunWords(run);
  const wordsText = words ? formatWorkflowRunWords(words, intl.formatMessage) : null;
  return (
    <StatusSummaryMetric icon={<Workflow className="size-4 text-[var(--color-foreground)]" />}>
      <span
        data-workflow-pill={run.runId}
        className={cn(
          // 挤不下时只有名字让位：phase 不收缩，但封顶 45%，所以名字总还剩一半多。不给名字设
          // 最小宽度——定宽下限会把短名字撑出一段空白，还会和 phase 一起把胶囊撑破。
          "min-w-0 truncate",
          !name && "text-[var(--color-foreground-subtle)]",
        )}
      >
        {name ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" })}
      </span>
      {run.status && wordsText ? (
        <>
          <WorkflowRunLamp status={run.status} />
          <span className="max-w-[45%] shrink-0 truncate text-[var(--color-foreground-subtle)]">
            {wordsText}
          </span>
        </>
      ) : null}
      {others > 0 ? (
        <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtlest)]">
          +{others}
        </span>
      ) : null}
    </StatusSummaryMetric>
  );
}

// 优先找 inProgress，其次找第一条 pending：前者是「现在做的」，后者是「马上要做的」。
// 全部完成时返回 null，让调用方继续走完成态分支，而不是在这里伪造一条「已完成」。
// 两段 find 的顺序就是语义：先找进行中，再找第一条待办。用 ?? 串联，
// 任一段返回 undefined 都会继续往下；两段都空时返回 null，由调用方决定降级形状。
function getCurrentPlanItem(plan: ConversationStatusPanelModel["plan"]) {
  return (
    plan?.items.find((item) => item.status === "inProgress") ??
    plan?.items.find((item) => item.status === "pending") ??
    null
  );
}

// 取「最后一条 completed」而不是第一条：胶囊要展示的是最近的成果。
// 先拷贝再 reverse，是因为 items 来自只读投影，原地 reverse 会污染模型层的数组顺序。
function getCompletedPlanItem(plan: ConversationStatusPanelModel["plan"]) {
  // 先拷贝再 reverse：items 是只读投影的一部分，原地反转会改变模型层数组的顺序，
  // 让「下一次投影」与「本地视图」对不上（且这个 bug 只在下一次渲染才显现）。
  return [...(plan?.items ?? [])].reverse().find((item) => item.status === "completed") ?? null;
}

// 胶囊的整条优先级链：在跑的工作流 → 当前 Todo → 活跃 Goal → Git 变更 → 已完成 Goal
// → 最近完成的 Todo → Todo 汇总 → 历史 plan → 实时计数 → 已结束 run。
// 这条顺序就是产品对「会话此刻在做什么」的定义，改动它等于改产品语义（INV-14）。
// 每个分支只读 model 或 props，不做副作用，因此整段可以在 render 里安全求值。
function StatusSummaryRow({
  endedWorkflowRunCount,
  gitWorktreeChangeSummary,
  model,
  onOpenWorkflowSection,
  onVariantChange,
}: {
  /** 已结束 run 的目录计数；宿主给 0 表示目录入口不可渲染（缺会话或缺回调）。 */
  endedWorkflowRunCount: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  model: ConversationStatusPanelModel;
  /** 胶囊显示着工作流时，点击展开要同时打开的「工作流」分区。 */
  onOpenWorkflowSection?: () => void;
  onVariantChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
}) {
  const { intl } = useZCodeIntl();
  // 胶囊的 aria-label 与 tooltip 共用同一条 i18n 文案：两处若分开维护，
  // 读屏用户与鼠标用户会看到不同措辞，且翻译时容易漏掉其中一个。
  const expandLabel = intl.formatMessage({ id: "chat.summaryPanel.showPanel" });
  // 三个候选项在 render 前算好，而不是在三元里各调一次纯函数：
  // 这样「优先级链」与「数据提取」分离，读代码时能一眼看出顺序才是产品语义（INV-14）。
  const currentPlanItem = getCurrentPlanItem(model.plan);
  // 已完成项的优先级低于「活跃 Goal」：有目标在推进时，实现目标的某个 Todo 只是过程，
  // 不该盖过「我们在做什么」这个更大的答案。
  const completedPlanItem = getCompletedPlanItem(model.plan);
  // 历史 plan 排在「Todo 汇总」之后：todo 计数是实时事实，历史文档只是参考。
  // 取 items[0] 依赖模型层的排序（最新在前），这里不重新排序，避免与侧栏列表顺序相反。
  const latestSessionPlan = model.sessionPlans?.items[0] ?? null;
  const goal = model.goal;
  // goalTitle 做两级兜底：summaryTitle 是模型给的短标题，objective 是用户原文。
  // trim() 后判空是必要的：CLI 可能传出只含空白的标题，直接使用会让胶囊只剩图标。
  const goalTitle = goal ? goal.summaryTitle?.trim() || goal.objective.trim() || null : null;
  const goalStatus = goal?.status ?? null;
  // V4 goal 在 verifier 判定未完成后会进入 notSatisfied；mini 过去漏掉
  // 这个合法开放态并返回 null，导致只剩 2px 空 shell，也失去重新展开入口。
  // 四个状态都算「活跃」：notSatisfied 是 verifier 判定未完成但 goal 仍在推进，
  // 漏掉它会让胶囊在验证失败后静默消失（只剩 2px 空壳），同时失去重新展开的入口。
  // verifying 同理——它是 active 与 verified 之间的过渡态，不是终点。
  const isActiveGoal =
    goalStatus === "active" ||
    goalStatus === "notSatisfied" ||
    goalStatus === "paused" ||
    goalStatus === "verifying";
  const isDoneGoal = goalStatus === "verified";
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  // Git 迷你摘要只在「有实际增删」时进入优先级链：+0/-0 只是噪音，
  // 而且会让面板在只有空仓库信息时也占一行。
  const hasGitMiniSummary = Boolean(model.git && added + removed > 0);

  // 胶囊摘要过去把所有后台任务都写死成 Activity，纯 Subagent 因而没有复用
  // Running 明细的 Bot 语义。**恰好一类**沿用该类图标，混合才是 Activity。在跑的工作流不进这条
  // 兜底：它排在胶囊最前，自己一个分支（名字 · 灯 · phase），不再是一个计数。
  // 图标只按「恰有一类」推断：同时有终端与子代理时用 Activity 表示混合，
  // 单类时才用该类的语义图标。反过来写（先判混合再判单类）会让单类也落到 Activity。
  const hasRunningBash = model.runningBashWorks.length > 0;
  const hasRunningSubagent = model.runningSubagentWorks.length > 0;
  const runningCount = model.runningBashWorks.length + model.runningSubagentWorks.length;
  // 三元链的顺序即优先级：混合 → 终端 → 子代理。最后一支不需要 hasRunningSubagent
  // 判断，因为 runningCount > 0 且不是前两种时只能是子代理。
  const RunningSummaryIcon =
    hasRunningBash && hasRunningSubagent
      ? ActivityIcon
      : hasRunningBash
        ? SquareTerminalIcon
        : BotIcon;
  // 只取第一条在跑的工作流做「代表」：胶囊只有一行，列全部会挤成不可读的碎片。
  // others 用 length - 1 传给 +n 角标，因此这里取的是模型层已排好序的第一条，
  // 不是随机一条（顺序由模型层保证，见 WorkflowStatusSection 的「不排序」说明）。
  const firstLiveRun = model.runningWorkflowRuns[0];
  // 在跑的工作流排在胶囊最前（docs/dynamic-workflow/presentation.md「Other places a run appears」）：
  // 它在跑时就是会话在做的事，而主代理那一轮多半早已结束、todo 只是上一轮的余迹。过去它排在
  // 最后，理由是「与输入框的后台计数重复」——名字加 phase 并不重复什么。
  // 优先级链的求值是「短路的三元嵌套」：一旦命中就停止，后面的分支看不到。
  // 因此把 earliest 的「在跑的工作流」放最前，把「只剩历史」放最后。
  const summaryMetric = firstLiveRun ? (
    <WorkflowSummaryMetric run={firstLiveRun} others={model.runningWorkflowRuns.length - 1} />
  ) : currentPlanItem ? (
    // 第二优先级是「此刻在做的 Todo」：它比 goal 更具体，比已完成项更有时效性。
    // 用 ArrowRightIcon 而不是勾，表明这是进行中的指向，不是结果。
    <StatusSummaryMetric
      icon={<ArrowRightIcon className="size-4 text-[var(--color-foreground)]" />}
    >
      <span className="min-w-0 truncate">{currentPlanItem.content}</span>
    </StatusSummaryMetric>
  ) : goalTitle && isActiveGoal ? (
    // goalTitle 与 isActiveGoal 必须同时成立：有标题但已结束要落到后面的分支，
    // 没有标题（只有 objective 也空）时不该占位显示一个空胶囊。
    <StatusSummaryMetric icon={<GoalIcon className="size-4 text-[var(--color-foreground)]" />}>
      <span className="min-w-0 truncate">{goalTitle}</span>
    </StatusSummaryMetric>
  ) : hasGitMiniSummary ? (
    // Git 变更排在活跃目标之后：它是「副作用」而不是「意图」。
    // +N/-M 用两个独立色值，不能合并成「共 N 处变更」——增删方向是审阅时最先看的信息。
    <StatusSummaryMetric icon={<FileDiffIcon className="size-4 text-[var(--color-foreground)]" />}>
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "chat.statusPanel.changes" })}
      </span>
      <span className="shrink-0 text-[var(--color-diff-added)]">+{added}</span>
      <span className="shrink-0 text-[var(--color-diff-removed)]">-{removed}</span>
    </StatusSummaryMetric>
  ) : goalTitle && isDoneGoal ? (
    // 已完成的 Goal 排在 Git 之后、Todo 之前：它是「上一件事的结论」，
    // 既不如未提交的改动紧迫，又比一条历史 Todo 更值得留在眼前。
    <StatusSummaryMetric icon={<GoalIcon className="size-4 text-[var(--color-foreground)]" />}>
      <span className="min-w-0 truncate">{goalTitle}</span>
    </StatusSummaryMetric>
  ) : completedPlanItem ? (
    // 最近完成的 Todo 用 success 色勾：它是「刚刚有产出」的轻量信号，
    // 与下面「Todo 汇总计数」的区别在于它指向具体一条，而不是整体进度。
    <StatusSummaryMetric icon={<CheckCircle2Icon className="size-4 text-[var(--color-success)]" />}>
      <span className="min-w-0 truncate">{completedPlanItem.content}</span>
    </StatusSummaryMetric>
  ) : model.plan ? (
    // 只剩空计划时也要显示 0/N 而不是隐藏：用户刚调用过 plan 工具，
    // 看不到任何反馈会以为工具没生效。这里的 0 是「已建立但还没开始」，不是错误。
    <StatusSummaryMetric
      icon={<ListChecksIcon className="size-4 text-[var(--color-foreground-subtle)]" />}
    >
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "chat.statusPanel.todo" })}
      </span>
      <span className="shrink-0 text-[var(--color-foreground-subtle)]">
        {model.plan.completedCount}/{model.plan.totalCount}
      </span>
    </StatusSummaryMetric>
  ) : latestSessionPlan ? (
    // 历史 plan 的图标不用 success 色：它不代表「完成」，只代表「存在一份文档」，
    // 用 success 会被误读成计划已达成。
    <StatusSummaryMetric
      icon={<ListChecksIcon className="size-4 text-[var(--color-foreground)]" />}
    >
      <span className="min-w-0 truncate">
        {latestSessionPlan.title ?? intl.formatMessage({ id: "chat.statusPanel.planFallback" })}
      </span>
    </StatusSummaryMetric>
  ) : runningCount > 0 ? (
    // 实时计数是倒数第二优先级：它对应输入框旁已经在显示的同一组数字，
    // 只有前面所有「主状态」都缺席时才轮到它，避免同屏重复。
    <StatusSummaryMetric
      icon={<RunningSummaryIcon className="size-4 text-[var(--color-foreground)]" />}
    >
      {/* 产品规则：终端 / 智能体的实时计数只能在没有 Goal/Todo/Git 等主状态时兜底，
          避免胶囊把主状态和输入框已展示的实时计数重复拼接。 */}
      <span className="shrink-0">
        {hasRunningSubagent
          ? formatRunningSubagentCount(intl.formatMessage, runningCount)
          : formatRunningCount(intl.formatMessage, runningCount)}
      </span>
    </StatusSummaryMetric>
  ) : endedWorkflowRunCount > 0 ? (
    // 胶囊的兜底链止步于「活动计数」，而面板级的卸载闸门（!hasContent &&
    // !canRenderEndedWorkflows）为了保住 run 目录入口，会在**只剩已结束 run**时仍保留
    // 整个壳——工作区无 Git 变更时 workflow 一结束，胶囊各分支全 null，只剩一条 2px
    // 空壳线（与 goal notSatisfied 那次是同一个失效形状）。这里补上最低优先级的终态
    // 分支：图标沿用 Workflow 域，文案与 Workflows 分区页脚同 key，点开即展开面板。
    <StatusSummaryMetric
      icon={<Workflow className="size-4 text-[var(--color-foreground-subtle)]" />}
    >
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "chat.statusPanel.endedWorkflows" })}
      </span>
      <span className="shrink-0 text-[var(--color-foreground-subtle)]">
        {endedWorkflowRunCount}
      </span>
    </StatusSummaryMetric>
  ) : null;

  // 所有分支都落空时整块胶囊不渲染（而不是渲染一个空容器）：
  // 空容器会保留 8px 高度与阴影，看起来像渲染失败的残片（正是 INV-7 要防的形状）。
  if (!summaryMetric) {
    return null;
  }

  return (
    <ControlHintTooltip title={expandLabel} sideOffset={4} side="left">
      <button
        type="button"
        aria-label={expandLabel}
        className="group inline-flex w-max max-w-full cursor-pointer flex-col items-stretch text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-menu-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        onClick={() => {
          // 展开后看到的不能比胶囊还少：胶囊显示着工作流，就连同「工作流」分区一起打开——
          // 顺序必须固定：先开分区再切形态，反序会让状态写进正在卸载的分区宿主。
          // 哪怕读者先前手动折过它（点胶囊就是「给我看这个」）。
          if (firstLiveRun) onOpenWorkflowSection?.();
          onVariantChange?.("panel");
        }}
      >
        {summaryMetric}
      </button>
    </ControlHintTooltip>
  );
}

// 主组件是纯组合：模型派生 → variant 解析 → 闸门计算 → 分支渲染。
// 这里没有 useEffect（除子组件内部秒表），因为所有状态都来自 props 投影；
// 任何「本地缓存一份投影」的写法都会在会话切换时留下上一会话的残影。
function ConversationStatusPanelImpl({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  gitDirtyFileCount = 0,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  goal,
  sessionPlans,
  plan,
  backgroundWorks = EMPTY_BACKGROUND_WORKS,
  runningSubagents = EMPTY_RUNNING_SUBAGENTS,
  workflowRuns = EMPTY_WORKFLOW_RUNS,
  endedWorkflowRunCount = 0,
  endedSubagentCount = 0,
  rootSessionId,
  parentSessionId,
  isWebRemoteControl = false,
  isMobileViewport = false,
  layoutMode = "none",
  summaryPanelVariantOverride,
  onVariantChange,
  terminalSectionOpen,
  onTerminalSectionOpenChange,
  agentSectionOpen,
  onAgentSectionOpenChange,
  workflowSectionOpen,
  onWorkflowSectionOpenChange,
  onRefreshGit,
  onOpenGitReview,
  onPauseGoal,
  onResumeGoal,
  onOpenPlanDetail,
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  onOpenSubagentSession,
  onOpenSubagentDirectory,
  onOpenWorkflowRun,
  onOpenWorkflowRunDirectory,
  className,
}: ConversationStatusPanelProps) {
  const isOfficeMode = useIsOfficeMode();
  // 模型是纯函数派生，依赖数组必须列全参与计算的每个投影字段：
  // 漏掉任何一个（历史上漏过 workspacePath）都会让面板停在旧会话的 Git 与计划上，
  // 直到某个无关字段变化才「突然刷新」。
  const model = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal,
        sessionPlans,
        workspacePath,
        plan,
        backgroundWorks,
        runningSubagents,
        workflowRuns,
      }),
    [
      isOfficeMode,
      backgroundWorks,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      goal,
      sessionPlans,
      plan,
      runningSubagents,
      workflowRuns,
      workspacePath,
    ],
  );
  // variant 解析集中在一处（conversationLayout）：组件本身不判断视口宽度，
  // 也不在 auto 模式下自行决定展开/收起，从而让「自动」与「用户 override」
  // 只在宿主的一个地方决定，避免两处各自推导出不同形态。
  const variant = resolveConversationStatusPanelVariant({
    variantOverride: summaryPanelVariantOverride ?? null,
  });
  // 「自动」的判据是 override 为 null，而不是 variant === "auto"：
  // resolve 之后 auto 可能已经展开成 panel/mini，用 variant 判断会丢失「用户没选过」这个事实，
  // 菜单里的单选项也就无法正确回显。
  const isVariantAutomatic = summaryPanelVariantOverride == null;
  // Bug 根因：状态面板在手机远控中仍把分支/Todo 浮层固定到左侧，
  // 而面板本身已占据大部分视口，左右均无法容纳固定宽度。手机远控改用纵向定位，
  // 让 Radix 在上/下之间翻转；桌面和宽屏 Web 保持原左侧交互。
  // 纵向浮层只在「手机远控 + 粗指针视口」同时成立时启用：任一条件单独成立时
  // 面板仍有足够的横向空间，改成上下翻转反而会让浮层盖住被引用的行。
  const useVerticalFloatingPanels = isWebRemoteControl && isMobileViewport;
  // 菜单的受控值把「自动」还原成字符串 "auto"：Radix RadioGroup 只接受字符串值，
  // 若直接传 null 会变成「无选中项」，用户看不到当前生效的其实是哪个选项。
  const panelModeValue = isVariantAutomatic ? "auto" : variant;
  const { intl } = useZCodeIntl();
  // 菜单标签同时用于 tooltip 与 aria-label，理由同 expandLabel：
  // 图标按钮没有可见文本，可访问名与提示必须是同一句话。
  const panelMenuLabel = intl.formatMessage({
    id: "chat.summaryPanel.displayMode",
  });
  // 每个 canRender* 都同时检查「有没有内容」和「有没有回调」：
  // 只查内容会在只读宿主下渲染出点不动的行；只查回调会渲染空分区。
  // 这些布尔量也是 separated 的计算输入，因此必须与子组件内部的空态判断一致。
  const canRenderGit = Boolean(model.git && gitSummary && onRefreshGit);
  // 闸门只看「对象是否存在」，不看是否活跃：已完成或已暂停的 goal 仍要显示，
  // 否则用户在 goal 完成的一瞬间会看到整个分区消失，误以为记录丢了。
  const canRenderGoal = Boolean(model.goal);
  // 同 Goal：切片存在即有内容。sessionPlans 没有回调依赖，因为「有没有条目」由模型层决定，
  // 而每一条的 canOpen 在行内判断（缺回调时降级为不可点文本）。
  const canRenderSessionPlans = Boolean(model.sessionPlans);
  // Todo 闸门与 PlanStatusSection 的 `if (!plan) return null` 必须同构（INV-28）：
  // 这里宽一点会让面板出现只有标题的空分区，窄一点会让有内容的 Todo 静默消失。
  const canRenderPlan = Boolean(model.plan);
  // 与子组件 BackgroundWorkStatusSection 的 works.length === 0 判断保持严格一致：
  // 这里漏判会让分区渲染成空壳，多判会让有内容的终端消失。
  const canRenderTerminals = model.runningBashWorks.length > 0;
  // 已结束的 run 也开门（与 canRenderAgents 同判断）：重启后活动数为零，若只按它开门，
  // 通往 run 目录的唯一入口会连带消失。
  const canRenderEndedWorkflows = Boolean(
    endedWorkflowRunCount > 0 && parentSessionId && onOpenWorkflowRunDirectory,
  );
  // 活 run 或已结束 run 目录，二者其一即可渲染（与 WorkflowStatusSection 的 return null 条件同构）。
  // 注意 canRenderEndedWorkflows 还要求 parentSessionId 与打开回调同时在场。
  const canRenderWorkflows = model.runningWorkflowRuns.length > 0 || canRenderEndedWorkflows;
  // 已结束子代理目录的闸门：计数、父会话、打开回调三者同时在场才允许开。
  // 与 endedWorkflow 分开判而不是抽公共函数，因为两个目录页的 request 结构不同，
  // 强行抽象会让「缺哪个字段」变得不直观。
  const canRenderEndedAgents = Boolean(
    endedSubagentCount > 0 && parentSessionId && onOpenSubagentDirectory,
  );
  // 已结束目录入口过去渲染在 Agent StatusSection 之后，视觉和 DOM 都被提升成
  // 并列顶层 section。Agent 的运行态和已结束目录属于同一领域，统一由 Agent 折叠分组承载。
  // 与 canRenderWorkflows 同构：活子代理或已结束目录任一存在就保留分区。
  // 这两个 canRenderEnded* 布尔量还被传给子组件用于决定页脚计数是否渲染，
  // 从而保证「面板认为能开」与「页脚真的可点」是同一个判断。
  const canRenderAgents = model.runningSubagentWorks.length > 0 || canRenderEndedAgents;
  // 菜单值是字符串，必须在这里白名单过滤：非法值（旧版本持久化的其它枚举）
  // 一律忽略而不是透传给宿主，避免宿主用未适配的形态渲染而导致白屏。
  // "auto" 映射回 null，与 isVariantAutomatic 的判据保持同一表示。
  const handlePanelModeChange = useCallback(
    (value: string) => {
      if (value === "auto") {
        onVariantChange?.(null);
        return;
      }
      if (value === "panel" || value === "mini") {
        onVariantChange?.(value);
      }
    },
    [onVariantChange],
  );
  // 回调必须是稳定引用：它被传进 memo 化的 StatusSummaryRow 与子分区，
  // 每次渲染新建箭头函数会让整棵面板树重渲染（INV-19 的调用侧落点）。
  const handleOpenWorkflowSection = useCallback(() => {
    onWorkflowSectionOpenChange?.(true);
  }, [onWorkflowSectionOpenChange]);
  // 收起只改 variant，不动 model 与分区开合：再次展开时应回到用户上次的阅读位置，
  // 而不是被强制恢复成默认折叠状态。
  const handleCollapseToMini = useCallback(() => {
    onVariantChange?.("mini");
  }, [onVariantChange]);

  // `model.hasContent` 只认**活的**内容（模型手上的投影都是活状态），所以「只剩历史」的
  // 会话会连整个胶囊一起消失——而那正是重启后打开一条旧对话的样子，run 目录的入口于是又没了。
  // 已结束的 run 因此单独开这道门。（Agents 的已结束行有同一个洞：`endedSubagentCount` 也
  // 没进 `hasContent`。那是既有行为，不在本轮一起翻。）
  // 唯一的卸载闸门：没有任何活内容、也没有已结束 run 目录时必须整块消失。
  // 这里刻意不把 endedSubagentCount 纳入（见上方注释）：那是既有缺口，
  // 本轮只保证 workflow 目录入口不丢，避免顺手改动另一条已上线的行为。
  if (!model.hasContent && !canRenderEndedWorkflows) {
    return null;
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 z-20 pt-4",
        // 旧 ChatView 的 inline 面板直接钉在右侧，正文列通过独立 translate 让位。
        // v4 若继续用 inset-x-0 + justify-end，会让面板容器宽铺满并改变宽屏下的横向对齐。
        layoutMode === "inline"
          ? "right-4"
          : layoutMode === "auto"
            ? "inset-x-0 flex justify-end px-4 @min-[1280px]/conversation:left-auto @min-[1280px]/conversation:right-4 @min-[1280px]/conversation:px-0"
            : "inset-x-0 flex justify-end px-4",
        className,
      )}
    >
      {/* Bugfix: 状态面板恢复旧 ChatView 的同 shell 收起/展开模型。
          之前 v4 用固定展开卡片替代 summary panel，窄屏会遮挡聊天正文，也丢失用户 override。 */}
      <aside
        aria-label={intl.formatMessage({ id: "chat.summaryPanel.title" })}
        data-testid={TID_CHAT_SUMMARY_PANEL}
        data-state={variant === "mini" ? "collapsed" : "expanded"}
        data-display-mode={variant}
        data-goal-status={model.goal?.status}
        data-goal-objective={model.goal?.objective}
        data-running-background-count={
          model.runningBashWorks.length +
          model.runningSubagentWorks.length +
          model.runningWorkflowRuns.length
        }
        data-running-terminal-count={model.runningBashWorks.length}
        data-running-agent-count={model.runningSubagentWorks.length}
        data-running-workflow-count={model.runningWorkflowRuns.length}
        data-ended-workflow-count={endedWorkflowRunCount}
        className={cn(
          // 三段宽度策略互斥：mini 用 w-max 跟随摘要，panel 用固定 w-80，
          // auto 在窄容器下等同 mini、宽容器下等同 panel（靠 container query 切换）。
          // 三者都不能用 100vw 计算上限：面板挂在会话列里，视口宽度会把它撑出列外。
          "pointer-events-auto relative overflow-hidden rounded-2xl border border-[var(--color-popover-border)] bg-[var(--color-popover)] text-[var(--color-foreground)] shadow-md transition-[border-radius,padding,background-color,box-shadow] duration-300 ease-in-out",
          // 胶囊宽度只由 CSS 决定：w-max 跟随摘要内容，上限以 conversation 容器（100cqw）为基准。
          // Bug 原因：过去由 ResizeObserver 量出摘要宽度写进 CSS 变量（为了给宽度做插值动画，
          // 而 shell 早已不过渡宽度），测量值会比内容晚一次渲染、上限又按窗口宽度（100vw）算——
          // 两者都能让文字落到胶囊外面。
          variant === "mini"
            ? "inline-flex max-h-8.5 w-max max-w-[min(20rem,calc(100cqw-2rem))] flex-col"
            : variant === "panel"
              ? "flex max-h-[min(64dvh,32rem)] w-80 max-w-[calc(100cqw-2rem)] flex-col"
              : "inline-flex max-h-8.5 w-max max-w-[min(20rem,calc(100cqw-2rem))] flex-col @min-[1280px]/conversation:max-h-[min(64dvh,32rem)] @min-[1280px]/conversation:w-80",
        )}
      >
        {variant !== "mini" ? (
          // 头部操作区只在展开形态出现（mini 上没有它），但两种展开形态的显示方式不同：
          // auto 在窄容器里 hidden、宽容器才 flex——否则 900px 的会话列会挤掉标题。
          <div
            className={cn(
              "absolute right-3 top-3 z-10 items-center gap-1",
              variant === "auto" ? "hidden @min-[1280px]/conversation:flex" : "flex",
            )}
          >
            <DropdownMenu>
              <ControlHintTooltip title={panelMenuLabel} side="left">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    aria-label={panelMenuLabel}
                  >
                    <EllipsisIcon className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </ControlHintTooltip>
              <DropdownMenuContent align="end" side="bottom" className="w-44">
                <DropdownMenuRadioGroup
                  value={panelModeValue}
                  onValueChange={handlePanelModeChange}
                >
                  <DropdownMenuRadioItem value="auto">
                    {intl.formatMessage({
                      id: "chat.summaryPanel.displayModeAuto",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ControlHintTooltip
              title={intl.formatMessage({ id: "chat.summaryPanel.showMini" })}
              side="left"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={intl.formatMessage({
                  id: "chat.summaryPanel.showMini",
                })}
                onClick={handleCollapseToMini}
              >
                <Minimize2Icon className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          </div>
        ) : null}
        {variant !== "mini" ? (
          // 分区列表与头部操作区是同一个 variant 判断的两个分支，
          // 它们的 hidden/flex 条件必须完全一致，否则会出现「有菜单但没内容」的空面板。
          // 单个区块限高后，多区块同时展开仍可能超过 shell；外层必须提供
          // 第二层兜底滚动，保证后续区块标题和操作始终可达，不能继续直接裁切。
          <div
            className={cn(
              "min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2",
              variant === "auto" ? "hidden @min-[1280px]/conversation:flex" : "flex",
            )}
          >
            {canRenderGit ? (
              // separated=false 是硬编码：Git 永远是第一个分区，
              // 若按「前面有没有分区」动态计算，首个可见分区会随会话状态变化而出现顶部分隔线。
              <GitStatusSection
                model={model}
                gitSummary={gitSummary}
                gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
                activeTaskChangeSummary={activeTaskChangeSummary}
                onRefreshGit={onRefreshGit}
                onOpenGitReview={onOpenGitReview}
                separated={false}
                useVerticalFloatingPanels={useVerticalFloatingPanels}
              />
            ) : null}
            {canRenderGoal ? (
              // separated 直接复用上一个 canRender*：这是「逐级或运算」的起点，
              // 保证只有真正渲染出来的前序分区才会产生分隔线（INV-15）。
              <GoalStatusSection
                model={model}
                separated={canRenderGit}
                onPauseGoal={onPauseGoal}
                onResumeGoal={onResumeGoal}
              />
            ) : null}
            {canRenderSessionPlans ? (
              // 历史 plan 排在 Goal 之后、Todo 之前：它是「上一轮/参考文档」，
              // 重要性低于当前目标，高于此刻的执行清单。
              <SessionPlansStatusSection
                model={model}
                parentSessionId={parentSessionId}
                onOpenPlanDetail={onOpenPlanDetail}
                separated={canRenderGit || canRenderGoal}
              />
            ) : null}
            {canRenderPlan ? (
              // popoverSide 由 useVerticalFloatingPanels 决定，而非 CSS 媒体查询：
              // Radix 的 collision 计算需要知道初始 side，纯 CSS 改不了它的翻转逻辑。
              <PlanStatusSection
                model={model}
                popoverSide={useVerticalFloatingPanels ? "bottom" : "left"}
                separated={canRenderGit || canRenderGoal || canRenderSessionPlans}
              />
            ) : null}
            {canRenderTerminals ? (
              // open/onOpenChange 是受控的：宿主记住用户对每个分区的折叠偏好，
              // 这里绝不能再传 defaultOpen，否则首次渲染会与宿主的记忆值打架。
              <BackgroundWorkStatusSection
                onOpenBackgroundBash={onOpenBackgroundBash}
                section="terminal"
                title={intl.formatMessage({ id: "chat.statusPanel.terminals" })}
                works={model.runningBashWorks}
                open={terminalSectionOpen}
                onOpenChange={onTerminalSectionOpenChange}
                separated={canRenderGit || canRenderGoal || canRenderSessionPlans || canRenderPlan}
                onCancelBackgroundWork={onCancelBackgroundWork}
              />
            ) : null}
            {canRenderWorkflows ? (
              // endedRunCount 传的是「闸门过滤后的值」而不是原始计数：
              // 若目录打不开（缺 parentSessionId 或回调），页脚就不该出现，
              // 否则面板会显示一个点了没反应的入口。
              <WorkflowStatusSection
                title={intl.formatMessage({ id: "chat.statusPanel.workflows" })}
                runs={model.runningWorkflowRuns}
                endedRunCount={canRenderEndedWorkflows ? endedWorkflowRunCount : 0}
                open={workflowSectionOpen}
                onOpenChange={onWorkflowSectionOpenChange}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTerminals
                }
                parentSessionId={parentSessionId}
                onCancelBackgroundWork={onCancelBackgroundWork}
                onOpenWorkflowRun={onOpenWorkflowRun}
                onOpenDirectory={onOpenWorkflowRunDirectory}
              />
            ) : null}
            {canRenderAgents ? (
              // 同理，endedSubagentCount 也过闸门；rootSessionId 单独透传，
              // 因为子代理目录按根会话聚合，深层嵌套时它与 parentSessionId 不同。
              <SubagentStatusSection
                title={intl.formatMessage({ id: "chat.statusPanel.agents" })}
                subagents={model.runningSubagentWorks}
                endedSubagentCount={canRenderEndedAgents ? endedSubagentCount : 0}
                onCancelBackgroundWork={onCancelBackgroundWork}
                open={agentSectionOpen}
                onOpenChange={onAgentSectionOpenChange}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTerminals ||
                  canRenderWorkflows
                }
                parentSessionId={parentSessionId}
                rootSessionId={rootSessionId}
                onOpenSubagentSession={onOpenSubagentSession}
                onOpenSubagentDirectory={onOpenSubagentDirectory}
              />
            ) : null}
          </div>
        ) : null}
        <div
          aria-hidden={variant === "panel"}
          className={cn(
            "w-max max-w-full transition-opacity duration-150",
            variant === "mini"
              ? "pointer-events-auto relative visible opacity-100"
              : variant === "panel"
                ? "pointer-events-none invisible absolute left-0 top-0 opacity-0"
                : "pointer-events-auto relative visible opacity-100 @min-[1280px]/conversation:hidden",
          )}
        >
          <StatusSummaryRow
            model={model}
            // 与页脚同一道门（canRenderEndedWorkflows）：缺会话或缺回调时目录打不开，
            // 胶囊也就不该报一个点了没反应的数。
            endedWorkflowRunCount={canRenderEndedWorkflows ? endedWorkflowRunCount : 0}
            gitWorktreeChangeSummary={gitWorktreeChangeSummary}
            onOpenWorkflowSection={handleOpenWorkflowSection}
            onVariantChange={onVariantChange}
          />
        </div>
      </aside>
    </div>
  );
}

// memo 的比较是浅比较：只要宿主每次传入的数组/对象是新引用，这里就仍会重渲染。
// 它存在的意义是挡住「父组件因无关状态重渲染」这一大类噪音，而不是替代上面的 useMemo。
// 若未来给面板加 context，需要重新评估这层 memo 是否还有效。
export const ConversationStatusPanel = memo(ConversationStatusPanelImpl);
