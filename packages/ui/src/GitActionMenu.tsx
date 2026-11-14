// ============================================================================
// GitActionMenu —— 顶部 Git 操作入口（commit dialog / push dialog）
//
// 链路位置：WorkspaceHeader 或状态行 trigger → 可用性派生 → commit dialog（stage → commit
//        → 可选 push）或 push dialog → onRefreshGit 回写仓库摘要。本文件只做编排与展示，
//        真正的 git 调用全部走注入的 gitService，失败信息在这里收敛成可读文案。
//
// 不变量表（本文件维持或依赖；每条都对应一种「换个写法就出错」的具体故障）：
// INV-1: actionAvailable 只由 canUseGitActionMenu 决定，不由 isDirty 决定。
//        破坏后果：用 isDirty 当可用性会让干净仓库的入口消失，用户无法从 UI 切分支或查看状态。
// INV-2: primaryActionId 在可用时按「可推送优先、其次可提交」派生；为 null 时 trigger 必须置灰，
//        不能回退到提交对话框。破坏后果：rebase/merge 进行中把用户带进 commit 弹窗，
//        提交必然被 git 拒绝，错误看起来像程序故障而不是当前状态不允许。
// INV-3: commit dialog 的 state 是打开瞬间 refresh 的快照，不是实时仓库事实。
//        破坏后果：用户在外部分支切换后仍以旧文件清单提交，改动会落到错误分支。
// INV-4: commitActionDisabled 的三个来源（actionPending / 无选中文件 / 已知身份缺失）缺一不可。
//        破坏后果：身份尚未探测时误禁用会挡住正常提交；已知无身份仍放行则必然提交失败。
// INV-5: hasIdentity=false 与 identity=null 语义不同：null 表示尚未探测，false 表示探测过且没有。
//        破坏后果：把 null 当 false 会在加载窗口内禁止提交；把 false 当 null 会在无身份时放行。
// INV-6: includeUnstaged=true 时必须先 stagePaths 再 commit，且 commit 同时收到完整 paths
//        与 stagedOnly=false。破坏后果：少传 paths 会漏掉勾选文件，少传 stagedOnly 会提交索引里
//        与预览不一致的旧内容。
// INV-7: committed 标记只在 commit 成功返回后置 true，push 失败与 commit 失败走不同文案。
//        破坏后果：合并成一个成功标志，push 失败会提示「提交失败」，用户重试就会重复提交。
// INV-8: 提交失败后不关闭弹窗、不清空 message；推送失败后保留 push dialog 与 error。
//        破坏后果：清空后用户丢失写好的提交信息，也看不到真实失败原因。
// INV-9: mutationPending 覆盖 stage、commit、push 三个 await，期间所有动作与关闭按钮禁用。
//        破坏后果：连点会并发 stage/commit，产生空提交或把同一批文件提交两次。
// INV-10: 关闭弹窗必须一次性重置 loading、state、message、error、includeUnstaged、
//        generationPending，不能只把 open 置 false。破坏后果：残留 state 会让下次打开先渲染
//        上一轮的文件与错误，用户误以为仓库没有变化。
// INV-11: 打开提交弹窗时先置 open=true 再 await refresh，loading 期间只渲染 spinner。
//        破坏后果：反过来先 await 再 open，慢盘上点击后毫无反馈，用户会重复点击。
// INV-12: 分支切换后必须同时 onRefreshGit() 与重新 loadCommitDialogState，不能省其一。
//        破坏后果：只刷摘要不刷弹窗，弹窗仍显示旧分支的文件，提交落到新分支。
// INV-13: 生成提交信息的入参是打开时的快照 + 当前 includeUnstaged，不是再次读取的 git 状态。
//        破坏后果：生成内容与随后提交的文件集合不一致，提交信息描述的文件根本没被提交。
// INV-14: 生成失败只写 commitError，不覆盖用户已经输入的消息。
//        破坏后果：用户输入被清空且没有可恢复副本。
// INV-15: dialog 内回车只在消息输入框或 Command 容器内触发所选动作，且必须 preventDefault。
//        破坏后果：不拦截时 form 原生提交与自定义提交同时触发，一次回车产生两次 commit。
// INV-16: 键盘上下键只在一组「可用动作」之间移动，选中项被禁用时必须回落到第一个可用项。
//        破坏后果：选中项变成 disabled 后按回车无反应，看起来像快捷键失效。
// INV-17: pushEnabled 只来自 canPushGitBranch，dialog 内不做二次推断。
//        破坏后果：两处各自判断，UI 允许点推送而服务层直接拒绝，错误被误当成网络问题。
// INV-18: 错误详情只读展示，复制失败必须有提示，不能静默。
//        破坏后果：长错误被截断且复制无反馈，用户无法把 git 原始错误反馈给支持。
// INV-19: 所有 git 调用只传 workspacePath，生成消息额外带 workspaceIdentity，不传 UI 状态。
//        破坏后果：把弹窗状态塞进服务调用，会让服务层依赖 UI 生命周期，跨窗口时路由到错误仓库。
// INV-20: 日志只记录 workspacePath / 分支 / 数量 / 错误消息，不记录提交信息正文。
//        破坏后果：提交信息可能含业务敏感内容，落盘日志后无法撤回。
// ============================================================================
/* eslint-disable max-lines -- 顶部 Git 操作当前集中承载 trigger、commit dialog 和 push dialog；先按工作流边界收口，避免为了拆行数把状态机打散。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  GitCommitMessageConversationContext,
  GitIdentity,
  GitRepositorySummary,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Command, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchCommitPreviewFiles,
  getGitBranchCommitTotals,
  resolveGitBranchTriggerLabel,
} from "@/git-branch-switcher/display.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import {
  canUseGitActionMenu,
  canPushGitBranch,
  resolveGitActionMenuPrimaryAction,
} from "@/git-action-menu/display.js";
import {
  filterCommitPreviewFilesByCurrentSession,
  getCurrentSessionFilePaths,
} from "@/git-action-menu/currentSessionFileScope.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { logger } from "@/logger.js";
import {
  AlertCircleIcon,
  ArrowUpFromLine,
  CheckIcon,
  CloudUploadIcon,
  GitBranchIcon,
  GitCommitIcon,
  LoaderIcon,
  SparklesIcon,
} from "lucide-react";

// [权衡] props 只接收调用方算好的 gitSummary，而不是在本组件内订阅 Git 状态：
// 顶部栏与状态行可能同时挂载两个入口，各自订阅会得到刷新节奏不同的两份快照，
// 同一分支在两个入口显示不同的 ahead/behind，用户无法判断哪个是真的。
// 由调用方单向传入，才能保证「一份仓库摘要对应屏幕上所有 Git 控件」。
interface GitActionMenuProps {
  // workspacePath 是所有 git 调用的唯一作用域键：多窗口下它必须来自 props 而不是
  // 当前激活窗口，否则后台窗口的按钮会把提交写到前台窗口的仓库。
  workspacePath: string;
  // workspaceIdentity 只参与生成提交信息（用于匹配该仓库的模型配置），
  // 不参与 stage/commit：身份是仓库级配置，提交动作本身不应因它缺失而不发。
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  // activeTaskChangeSummary 用来把文件清单收窄到本会话的改动；
  // 传 null 表示当前不是任务上下文，此时展示仓库全部改动而不是空列表。
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  // 会话上下文只用于生成提交信息，缺失时生成仍然可用，只是描述不包含对话背景。
  commitMessageConversationContext?: GitCommitMessageConversationContext | null;
  // onRefreshGit 由调用方注入，而不是本组件自己调 gitService：
  // 刷新结果要写回调用方的仓库摘要 store，本组件拿不到那个 store 的写入权。
  onRefreshGit: () => void;
  className?: string;
  // triggerIconOnly 与 triggerLayout 是两套独立的布局开关：
  // 前者只隐藏文字，后者把 trigger 摊平成整行；组合出四种形态，
  // 点击所有权也随之不同（header 由按钮处理，status-row 由外层容器处理）。
  triggerIconOnly?: boolean;
  triggerLayout?: "header" | "status-row";
}

// [权衡] 用 ReturnType 从 buildGitBranchCommitPreviewFiles 提取文件类型，而不是在 UI 侧
// 重新声明一份 { path, stagePath }：两处字段一旦分叉，stagePaths 就拿不到真实暂存路径，
// 提交时按 UI 自造的路径暂存，会静默漏掉真实改动且没有任何报错。
type GitCommitPreviewFile = ReturnType<typeof buildGitBranchCommitPreviewFiles>[number];

// 三个动作 id 是封闭集合：Command 的 value、键盘选中态、data-testid 都从这里派生。
// 新增动作必须同时补齐 commitActions 数组与文案，否则 Command 的 value 对不上任何一项，
// 上下键会在一个不存在的选中项之间循环，回车变成无操作。
const COMMIT_DIALOG_ACTION_IDS = ["commit", "commitAndPush", "push"] as const;
const GIT_COMMIT_MESSAGE_TEXTAREA_ID = "git-action-menu-commit-message";
const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";

// 这些 data-testid 与 textarea id 是跨文件的稳定契约：
// e2e 用例按它们定位动作行，键盘处理按 textarea id 区分可编辑与只读输入框。
// 任意一处改名都会让测试静默找不到元素（而不是失败），所以集中定义、不在 JSX 里写字面量。
type CommitDialogActionId = (typeof COMMIT_DIALOG_ACTION_IDS)[number];

function gitCommitActionItemTestId(actionId: CommitDialogActionId): string {
  return `${TID_GIT_COMMIT_ACTION_ITEM}-${actionId}`;
}

// [失败路径] Command 的 onValueChange 会把任意字符串写进来（包含 DOM 的自动选中值），
// 这里做类型收窄而不是断言：断言失败不会抛错，只会让 selectedActionId 变成非法值，
// 之后 commitActions.find 全部返回 undefined，弹窗表现成「回车没反应」而不是清晰报错。
function isCommitDialogActionId(value: string): value is CommitDialogActionId {
  return COMMIT_DIALOG_ACTION_IDS.includes(value as CommitDialogActionId);
}

// [权衡] 用「target 是本弹窗的 textarea 且 id 匹配」判断，而不是 tagName 或 isContentEditable：
// 弹窗里还有只读错误 Textarea（没有该 id），按 tagName 判断会把上下键从错误详情里劫持走，
// 用户无法滚动查看失败原因。id 常量与渲染处共用同一字符串，避免两处字面量漂移。
function isCommitMessageTextAreaTarget(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.id === GIT_COMMIT_MESSAGE_TEXTAREA_ID;
}

// state 是「打开弹窗那一刻的仓库快照」，不是实时状态；同一次渲染里的所有派生值都取自
// 这同一份快照，避免文件清单来自 A 分支、身份来自另一次刷新的拼接态。
interface GitCommitDialogState {
  // summary 与 identity 分开存：身份按仓库配置解析，可能随 refresh 变化而文件清单没变，
  // 合成一个对象会强迫两者同生命周期，导致身份加载失败时整份预览一起丢弃。
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  // 任务变更摘要是「当前会话改过哪些文件」的 UI 侧事实，只参与过滤与展示计数，
  // 不参与真正提交的路径计算；把它放进快照是为了让打开瞬间的过滤结果保持自洽。
  activeTaskChangeSummary: ZCodeTaskChangeSummary | null;
  // staged 与 unstaged 保持 git 原始两态，不在这里合并：合并后就丢失「是否已暂存」，
  // 勾选「包含未暂存」时无法区分要不要先 stage。
  stagedFiles: GitCommitPreviewFile[];
  unstagedFiles: GitCommitPreviewFile[];
}

// 弹窗是纯展示组件：所有状态与写入回调都由 GitActionMenu 注入，
// 它自己不调用 gitService，也不持有快照。这样「提交失败后关闭再打开」的
// 状态归属只有一个地方，不会出现父子各存一份 message 互相覆盖。
interface GitCommitDialogProps {
  open: boolean;
  // loading 与 state 同时存在是为了区分「正在读」和「读到了但为空」：
  // 用 state===null 兼表 loading 会让空仓库也显示转圈，永远进不了空态。
  loading: boolean;
  state: GitCommitDialogState | null;
  workspacePath: string;
  message: string;
  // error 是字符串而不是布尔：失败文案已经包含 git 原始错误，
  // 只传布尔会让弹窗无法展示可复制的详情。
  error: string | null;
  mutationPending: boolean;
  generationPending: boolean;
  includeUnstaged: boolean;
  pushEnabled: boolean;
  onRefreshGit: () => void;
  onOpenChange: (nextOpen: boolean) => void;
  onMessageChange: (nextValue: string) => void;
  onIncludeUnstagedChange: (nextValue: boolean) => void;
  onGenerateMessage: () => void;
  onSubmit: () => void;
  onSubmitAndPush: () => void;
  onPushOnly: () => void;
}

// [权衡] includeUnstaged 时返回「未暂存 + 已暂存」的并集，而不是只返回未暂存：
// 提交动作把 stagePaths 当作本次要提交的完整清单，只给未暂存会漏掉用户之前已暂存的文件，
// 出现「勾了包含未暂存，结果只提交新文件、旧暂存改动留在索引里」的相反结果。
function getCommitDialogFiles(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): GitCommitPreviewFile[] {
  // 顺序固定为未暂存在前：勾选切换时列表不重排，用户才能确认勾选只改变了文件集合，
  // 而不是把同一批文件换了个位置。
  return includeUnstaged ? [...state.unstagedFiles, ...state.stagedFiles] : state.stagedFiles;
}

// stagePaths 是服务层真正消费的字段，必须按 stagePath 去重：
// 同一路径可能同时出现在 staged 与 unstaged 两个列表（部分暂存），不去重会重复传给 stage，
// 虽然 git 幂等，但选中计数与日志会翻倍，掩盖真实的文件数。
function getCommitDialogStagePaths(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): string[] {
  // 用 Set 而不是手写 reduce 去重：Set 保留首次出现顺序，跨引擎稳定，
  // 提交时的路径顺序也不会随实现细节变化。
  return Array.from(
    new Set(getCommitDialogFiles(state, includeUnstaged).map((file) => file.stagePath)),
  );
}

// 动作行是纯受控组件：可用性、加载态、选中态全部由父级 commitActions 传入，
// 自己不持有任何「点过没有」的本地标记。这样键盘选中项与鼠标点击共享同一份禁用判断，
// 不会出现鼠标能点、回车却因为本地标记而跳过的情况。
function CommitCommandActionItem({
  id,
  icon,
  label,
  shortcutLabel,
  disabled,
  loading,
  onSelect,
}: {
  id: CommitDialogActionId;
  icon: ReactNode;
  label: string;
  shortcutLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  onSelect: () => void;
}) {
  // 图标位固定为 size-5 的方框：加载态替换图标时布局不位移，
  // 否则生成提交信息的转圈出现/消失会让三行动作整体上下跳。
  return (
    <CommandItem
      data-testid={gitCommitActionItemTestId(id)}
      value={id}
      disabled={disabled}
      onSelect={() => {
        // CommandItem 自身已按 disabled 过滤指针事件，但键盘回车仍会走到 onSelect，
        // 这里再判一次：pending 期间外部把该项改成禁用后，回车不能穿透去执行 git 动作。
        if (!disabled) {
          onSelect();
        }
      }}
      className={cn(
        // 禁用态只换颜色，不改高度与内边距：动作可用性随文件数实时变化，
        // 改尺寸会让弹窗在勾选文件时抖动，用户以为列表重新加载了。
        "h-9 px-2.5 py-1.5 font-medium",
        disabled ? "cursor-default text-foreground-subtlest" : "text-foreground",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {loading ? <LoaderIcon className="size-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
    </CommandItem>
  );
}

function GitCommitDialog({
  open,
  loading,
  state,
  workspacePath,
  message,
  error,
  mutationPending,
  generationPending,
  includeUnstaged,
  pushEnabled,
  onRefreshGit,
  onOpenChange,
  onMessageChange,
  onIncludeUnstagedChange,
  onGenerateMessage,
  onSubmit,
  onSubmitAndPush,
  onPushOnly,
}: GitCommitDialogProps) {
  const { intl, locale } = useZCodeIntl();
  // 选中动作只是键盘焦点，不是「用户打算提交」的意图记录：每次 open 都重置为 commit，
  // 避免上次停在 push 时，这次打开一个有待提交改动的仓库却直接回车推送。
  const [selectedActionId, setSelectedActionId] = useState<CommitDialogActionId>("commit");
  // textarea 的 ref 只用于打开时聚焦；不参与提交逻辑，提交内容以 props.message 为准。
  // 用 ref 标记「本轮打开已聚焦过」，否则每次 state 刷新都会重新抢焦点，
  // 用户在生成消息后想改别处（比如切分支）会被拽回输入框。
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageInputFocusedOnOpenRef = useRef(false);
  const numberFormatter = new Intl.NumberFormat(locale);
  // state 为 null 时把 identity 也当作 null（未探测），而不是 false（探测过且缺失）：
  // loading 阶段 identity 还没回来，提前判成缺失会在弹窗里闪一条「未配置身份」的警告。
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);
  // messageReady 只决定按钮文案是「生成」还是「重新生成」，不决定按钮可用性；
  // 把两件事绑在一起会导致用户清空消息后无法再次生成。
  const messageReady = message.trim().length > 0;
  // 生成提交信息也是 mutation：它要读文件、调模型，期间必须和 stage/commit 互斥，
  // 否则用户可以在生成过程中改勾选，生成结果对应的文件集合与提交时不一致。
  const actionPending = mutationPending || generationPending;
  // 选中文件按当前 includeUnstaged 重算，而不是缓存打开时的结果：
  // 用户勾选/取消「包含未暂存」后，计数、+/- 与提交路径必须同时变化，任何一处滞后都会让预览说谎。
  const selectedFiles = state ? getCommitDialogFiles(state, includeUnstaged) : [];
  const stagePaths = state ? getCommitDialogStagePaths(state, includeUnstaged) : [];
  // 脏文件数固定按 includeUnstaged=true 统计：它展示的是「仓库里有多少可提交文件」，
  // 不随勾选变化，否则用户关掉「包含未暂存」后分支入口的数字会莫名变小。
  const dirtyFileCount = state ? getCommitDialogStagePaths(state, true).length : 0;
  const { fileCount, totalAdded, totalRemoved } = getGitBranchCommitTotals(selectedFiles);
  // 任务变更摘要里的 added/removed 是「本会话」口径，比 git 的整仓 diff 更贴近用户预期；
  // 缺失时（历史任务、摘要未落盘）才退回 git 汇总，而不是显示 0 误导用户。
  const displayChangeSummary = state?.activeTaskChangeSummary ?? null;
  const displayAdded = displayChangeSummary?.added ?? totalAdded;
  const displayRemoved = displayChangeSummary?.removed ?? totalRemoved;
  const hasSelectedChanges = stagePaths.length > 0;
  const hasUnstagedChanges = Boolean(state?.unstagedFiles.length);
  // 三个禁用来源必须同时生效：
  // 1) actionPending：并发 stage/commit 会产生空提交或重复提交；
  // 2) 无选中文件：commit 会以「没有要提交的内容」失败，提前禁用比让用户吃错误更清楚；
  // 3) 身份已探测且缺失：此时提交必然被 git 拒绝，属于确定性失败而非偶发错误。
  // 注意第三个条件带 state?.identity !== null：null 表示尚未探测，不能当成缺失。
  const commitActionDisabled =
    actionPending || !hasSelectedChanges || (!hasIdentity && state?.identity !== null);
  // 推送不要求本地有改动（可能只是落后/领先），只要求 canPushGitBranch 判定可达；
  // 这里不把 commit 的禁用条件复用到推送，否则「干净但领先」的分支无法推送。
  const pushOnlyDisabled = actionPending || !pushEnabled;
  const commitShortcutLabel = formatCommandShortcutLabel("⏎");
  // commitActions 的顺序同时是键盘上下键的遍历顺序与视觉顺序，必须与 action id 集合一致：
  // 提交、提交并推送、仅推送。把「仅推送」放前面会让默认回落的第一个可用项变成推送，
  // 用户在只剩未暂存改动时按回车会跳过提交直接推送。
  const commitActions = useMemo(
    () => [
      {
        // 两个提交动作共用 commitActionDisabled，但 loading 只挂在 mutationPending 上：
        // 生成提交信息期间按钮仍要可点（用于取消/重试），否则用户被锁在一个不可中断的状态里。
        id: "commit" as const,
        icon: <GitCommitIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commit",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmit,
      },
      {
        // 提交并推送复用同一个 disabled：它比纯提交多一个远程依赖，但本地前置条件完全一致，
        // 单独放宽会让用户在无身份、无文件时点到推送，然后在 commit 阶段失败并附带一句 push 错误。
        id: "commitAndPush" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commitAndPush",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmitAndPush,
      },
      {
        // 推送行不挂 loading：推送本身在独立 push dialog 里执行，弹窗内这一行只负责打开它；
        // 给它转圈会让人以为推送已经在后台跑了，从而关掉弹窗等结果。
        id: "push" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.push",
        }),
        disabled: pushOnlyDisabled,
        loading: false,
        onSelect: onPushOnly,
      },
    ],
    [
      commitActionDisabled,
      intl,
      mutationPending,
      onPushOnly,
      onSubmit,
      onSubmitAndPush,
      pushOnlyDisabled,
    ],
  );

  // 只在 open 变 true 时重置选中项，关闭时不动：
  // 关闭动画期间重置会让仍在屏幕上的高亮先跳到 commit，再随卸载消失，视觉上闪一下。
  useEffect(() => {
    if (open) {
      setSelectedActionId("commit");
    }
  }, [open]);

  // 聚焦是一次性动作，必须在 loading 结束且 state 就绪后执行：
  // 弹窗先渲染 spinner，此时 textarea 还没挂载，提前 focus 会拿到 null。
  useEffect(() => {
    if (!open) {
      // 关闭时清掉标记，下一次打开才能重新聚焦；不清会导致第二次打开弹窗焦点停在 body 上。
      messageInputFocusedOnOpenRef.current = false;
      return;
    }
    // actionPending 期间不抢焦点：用户可能正在看错误详情或等待生成结果，
    // 此时把光标塞回输入框会打断阅读，输入的内容也可能被下一帧覆盖。
    if (loading || !state || actionPending || messageInputFocusedOnOpenRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      // 打开弹窗后的默认焦点要落在提交信息里，方便立即编辑或生成后微调。
      messageTextareaRef.current?.focus();
      // 标记与 focus 放在同一帧内：拆分到两个 effect 会在中间帧重复聚焦。
      messageInputFocusedOnOpenRef.current = true;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [actionPending, loading, open, state]);

  useEffect(() => {
    // 弹窗加载 Git 状态前提交动作会短暂不可用，不能在 loading 阶段把默认选择跳到推送。
    if (!open || loading || !state || actionPending) {
      return;
    }

    // 选中项仍可用时保持不动：用户用上下键选好的动作不能因为一次 state 刷新被重置，
    // 否则生成提交信息返回后选中项会跳回第一项，回车执行的动作与用户看到的不一致。
    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (selectedAction && !selectedAction.disabled) {
      return;
    }

    // 只有选中项确实禁用时才回落到第一个可用项；全部禁用则保持原选择，
    // 让高亮与「按回车不执行」的行为同时成立，避免出现高亮消失但焦点仍在的空白态。
    const firstEnabledAction = commitActions.find((action) => !action.disabled);
    if (firstEnabledAction && firstEnabledAction.id !== selectedActionId) {
      setSelectedActionId(firstEnabledAction.id);
    }
  }, [actionPending, commitActions, loading, open, selectedActionId, state]);

  // 所有「回车」路径都收敛到这里，而不是各自判断并调用回调：
  // form 的 onSubmit、Command 的 onSelect、输入框内的回车共用同一份禁用判断，
  // 三处各自实现迟早会出现一处漏判，于是同一次回车触发两次不同动作。
  const triggerSelectedAction = useCallback(() => {
    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (!selectedAction || selectedAction.disabled) {
      return;
    }
    // 这里直接调用已绑定的 onSelect，不再读 DOM 的选中状态：
    // DOM 选中可能因禁用项被移除而短暂为空，读它会把一次有效回车吞掉。
    selectedAction.onSelect();
  }, [commitActions, selectedActionId]);

  // 用 setState 的函数式更新读取「按下这一刻」的选中项，而不是闭包里的 selectedActionId：
  // 连续快速按方向键时闭包值还是上一次渲染的，两次按键都会基于同一个起点计算，
  // 表现为按键丢步。
  const selectAdjacentAction = useCallback(
    (direction: 1 | -1) => {
      setSelectedActionId((currentActionId) => {
        const enabledActions = commitActions.filter((action) => !action.disabled);
        if (enabledActions.length === 0) {
          return currentActionId;
        }

        // 只在可用动作里找当前位置：用全量 commitActions 的索引再取模，
        // 会落到被禁用项上，按下键看起来「跳过了一行」，实际是高亮跑到了点不动的行。
        const currentIndex = enabledActions.findIndex((action) => action.id === currentActionId);
        if (currentIndex === -1) {
          // 原选中项已恢复可用但不在当前可用集合里（例如刚被禁用又启用），
          // 回到第一个可用项；返回原值会让键盘永远停在集合之外。
          return enabledActions[0]?.id ?? currentActionId;
        }

        // 环绕用「加长度再取模」而不是 Math.max/min 夹紧：
        // 夹紧到端点后，在最后一项按向下键没有反馈，用户会以为键盘失灵。
        const nextIndex =
          (currentIndex + direction + enabledActions.length) % enabledActions.length;
        return enabledActions[nextIndex]?.id ?? currentActionId;
      });
    },
    [commitActions],
  );

  // Command 自身的 keydown 与 form 上的 capture 处理是两层：
  // capture 先拿到事件并 stopPropagation，正常路径下这里不会重复触发；
  // 保留它是因为 Command 内部的输入过滤框也可能先截获方向键，需要兜底一次。
  const handleActionCommandKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      // Command 内部对方向键有自己的处理（移动焦点/滚动），不拦截会与我们的选中态同时生效，
      // 出现「高亮动一格、滚动条也动一格」的双重反馈。
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
    },
    [selectAdjacentAction],
  );

  // 键盘处理挂在 form 的 capture 阶段：先于 textarea / Command 的默认行为执行，
  // 才能在事件冒泡到各自组件之前决定是「换选中动作」还是「执行动作」。
  // 若改成 bubble 阶段，Command 会先把方向键吃掉，选中态永远停在第一行。
  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFormElement>) => {
      if (
        isCommitMessageTextAreaTarget(event.target) &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        // 输入框保持焦点时也允许切换下方 Command 操作，避免键盘流断掉。
        // 这里不移动 DOM 焦点，只改选中态：焦点离开 textarea 会让用户下一句话打进空气。
        event.preventDefault();
        event.stopPropagation();
        selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      // 只认主快捷键（Enter / Cmd+Enter 之类），不把普通字符键当提交：
      // 否则在多行提交信息里换行会直接触发 commit，用户来不及写完正文。
      if (!matchesPrimaryShortcut(event, "Enter")) {
        return;
      }
      // 必须同时阻止默认行为与冒泡：form 的原生 submit 也会调用 onSubmit，
      // 两处都调用 triggerSelectedAction 就会在一次回车里提交两次。
      event.preventDefault();
      event.stopPropagation();
      triggerSelectedAction();
    },
    [selectAdjacentAction, triggerSelectedAction],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_GIT_COMMIT_DIALOG}
        showCloseButton={false}
        // 关闭按钮不交给 DialogContent：提交中要禁用关闭，内置按钮无法单独控制 disabled，
        // 由页面自己渲染才能在 mutationPending 期间阻止关闭并保留失败回执。
        className="max-w-md gap-0 overflow-hidden border-popover-border bg-popover p-0 shadow-lg"
        onOpenAutoFocus={(event) => {
          // 只有「已经有内容可聚焦」时才阻止 Radix 的默认聚焦：
          // loading 阶段弹窗内只有 spinner，阻止默认会让焦点留在触发按钮上，
          // 屏幕阅读器读不到弹窗已经打开。
          if (!loading && state && !actionPending) {
            event.preventDefault();
          }
        }}
      >
        {loading ? (
          <div className="flex h-56 items-center justify-center px-5 py-5 text-foreground-subtle">
            <LoaderIcon className="size-5 animate-spin" />
          </div>
        ) : state ? (
          <form
            className="space-y-0"
            onKeyDownCapture={handleDialogKeyDown}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              // 原生 submit 只会由回车触发，但和 capture 阶段的处理是两条路径：
              // 这里保留 preventDefault，防止浏览器把表单提交当成导航，
              // 重复触发由 handleDialogKeyDown 的 stopPropagation 负责，两者缺一不可。
              event.preventDefault();
              triggerSelectedAction();
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
              <GitBranchSwitcher
                workspacePath={workspacePath}
                gitSummary={state.summary}
                dirtyFileCount={dirtyFileCount}
                onRefreshGit={onRefreshGit}
                className="min-w-0 px-0 pt-0"
                triggerClassName="h-7 max-w-64 justify-start rounded-lg px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground [&>span]:max-w-48"
                popoverSide="bottom"
                popoverClassName="w-80"
                branchListClassName="max-h-56"
                showFooterActions={false}
              />
              <div className="flex shrink-0 items-center gap-1.5 font-mono text-ui-base">
                <span className="text-diff-added">+{numberFormatter.format(displayAdded)}</span>
                <span className="text-diff-removed">-{numberFormatter.format(displayRemoved)}</span>
              </div>
            </div>

            <div className="min-h-36 px-4 pb-2">
              <label htmlFor={GIT_COMMIT_MESSAGE_TEXTAREA_ID} className="sr-only">
                {intl.formatMessage({
                  id: "git.actionMenu.commitDialog.messageLabel",
                })}
              </label>
              <div className="relative">
                <Textarea
                  ref={messageTextareaRef}
                  data-testid={TID_GIT_COMMIT_MESSAGE_INPUT}
                  id={GIT_COMMIT_MESSAGE_TEXTAREA_ID}
                  value={message}
                  disabled={actionPending}
                  placeholder={intl.formatMessage({
                    id: "git.actionMenu.commitDialog.messagePlaceholder",
                  })}
                  className="field-sizing-fixed min-h-28 rounded-none border-0 bg-transparent px-0 py-2 pr-8 text-ui-base font-medium text-foreground shadow-none placeholder:text-foreground-subtle focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0 md:text-ui-base"
                  onChange={(event) => {
                    // 受控输入：值只通过 onMessageChange 回到父级，弹窗内不保留副本。
                    // 保留副本会在生成消息后出现「父级已替换、输入框仍显示旧值」的双真相。
                    onMessageChange(event.target.value);
                  }}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid={TID_GIT_COMMIT_GENERATE_BUTTON}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={onGenerateMessage}
                      disabled={
                        // 生成按钮必须与提交动作使用同一组禁用来源：
                        // pending、无选中文件、身份已探测且缺失。少一条都会让一次模型调用
                        // 跑在空文件集或必然提交失败的仓库上，用户白等一轮。
                        actionPending ||
                        !hasSelectedChanges ||
                        (!hasIdentity && state.identity !== null)
                      }
                      aria-label={intl.formatMessage({
                        id: messageReady
                          ? "git.actionMenu.commitDialog.regenerate"
                          : "git.actionMenu.commitDialog.generate",
                      })}
                      className="absolute right-0 top-1.5 text-foreground-subtle hover:text-foreground"
                    >
                      {generationPending ? (
                        <LoaderIcon className="size-4 animate-spin" />
                      ) : (
                        <SparklesIcon className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end" sideOffset={6}>
                    {intl.formatMessage({
                      id: messageReady
                        ? "git.actionMenu.commitDialog.regenerate"
                        : "git.actionMenu.commitDialog.generate",
                    })}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="px-2.5 pb-2">
              <button
                type="button"
                role="checkbox"
                data-testid={TID_GIT_COMMIT_INCLUDE_UNSTAGED}
                aria-checked={includeUnstaged}
                disabled={actionPending || !hasUnstagedChanges}
                // 用取反而不是直接传 true：同一个按钮既承担勾选也承担取消，
                // 写死 true 会让用户无法把「包含未暂存」关掉，导致每次提交都顺带暂存全部文件。
                onClick={() => onIncludeUnstagedChange(!includeUnstaged)}
                className={cn(
                  // 禁用时只改文字颜色、保留透明背景：若连背景一起改，
                  // 勾选框看起来像「已选中但不可用」，与真实 includeUnstaged 值冲突。
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base font-medium transition-colors",
                  actionPending || !hasUnstagedChanges
                    ? "cursor-default text-foreground-subtle"
                    : "cursor-pointer text-foreground hover:bg-menu-hover",
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-sm border",
                      includeUnstaged
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-transparent",
                    )}
                  >
                    <CheckIcon className="size-3.5" />
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {intl.formatMessage({
                    id: "git.actionMenu.commitDialog.includeUnstaged",
                  })}
                </span>
                <span className="shrink-0 text-ui-base font-normal text-foreground-subtle">
                  {intl.formatMessage(
                    {
                      id: "git.actionMenu.commitDialog.changesValue",
                    },
                    {
                      count: numberFormatter.format(fileCount),
                    },
                  )}
                </span>
              </button>
            </div>

            <div className="border-t border-border/50 px-2.5 py-2">
              {!hasIdentity ? (
                <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-base text-warning">
                  <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                  <p>
                    {intl.formatMessage({
                      id: "git.actionMenu.commitDialog.identityMissing",
                    })}
                  </p>
                </div>
              ) : null}

              {error ? <p className="px-3 py-1.5 text-ui-base text-destructive">{error}</p> : null}

              <Command
                data-testid={TID_GIT_COMMIT_ACTION_COMMAND}
                shouldFilter={false}
                loop
                tabIndex={0}
                value={selectedActionId}
                onValueChange={(nextValue) => {
                  // Command 在鼠标悬停时也会改写 value，这里必须收窄：悬停到分隔线或其他
                  // 非动作节点时 nextValue 可能是空串，直接 set 会让选中态丢失，
                  // 随后回车走到 find 返回 undefined，动作静默不执行。
                  if (isCommitDialogActionId(nextValue)) {
                    setSelectedActionId(nextValue);
                  }
                }}
                onKeyDown={handleActionCommandKeyDown}
                aria-label={intl.formatMessage({
                  id: "git.actionMenu.trigger.ariaLabel",
                })}
                className="rounded-none bg-transparent p-0 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                <CommandList className="max-h-none scroll-py-1">
                  {commitActions.map((action) => (
                    <CommitCommandActionItem
                      key={action.id}
                      id={action.id}
                      icon={action.icon}
                      label={action.label}
                      shortcutLabel={
                        selectedActionId === action.id ? commitShortcutLabel : undefined
                      }
                      disabled={action.disabled}
                      loading={action.loading}
                      onSelect={action.onSelect}
                    />
                  ))}
                </CommandList>
              </Command>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// 推送弹窗的 props 刻意不含 message 与文件清单：推送不消费这些数据，
// 传进来只会让「改一个提交信息就重渲染整个推送弹窗」成为常态。
interface GitPushDialogProps {
  open: boolean;
  // gitSummary 用于展示上游名称与 ahead/behind，是只读快照；
  // 弹窗内的推送结果不写回它，刷新由父级 onRefreshGit 统一完成。
  gitSummary: GitRepositorySummary;
  currentBranchLabel: string;
  // pushEnabled 是外部判定结果，弹窗不重新计算，保证入口与确认按钮同一份规则。
  pushEnabled: boolean;
  error: string | null;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onSubmit: () => void;
}

// 推送弹窗是「确认 + 错误回执」两态组件：成功即关闭，失败会把错误详情留在弹窗里。
// 它不负责判断能不能推送，pushEnabled 由父级按 canPushGitBranch 传入，
// 保证触发入口与确认按钮使用同一份判定，不会出现入口可点、弹窗确认灰掉的割裂。
function GitPushDialog({
  open,
  gitSummary,
  currentBranchLabel,
  pushEnabled,
  error,
  mutationPending,
  onOpenChange,
  onSubmit,
}: GitPushDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  // errorCopied 只是复制按钮 1.5 秒的文案切换，不代表剪贴板真的写入成功：
  // 成功回调触发才置 true，失败走 toast，避免把失败也显示成「已复制」。
  const [errorCopied, setErrorCopied] = useState(false);
  // 有无上游决定推送到哪里：没有 trackingBranch 时文案必须说明会新建上游，
  // 否则用户会在不知情的情况下把本地分支推到远端同名分支。
  const descriptionId = gitSummary.trackingBranchName
    ? "git.actionMenu.pushDialog.description.tracked"
    : "git.actionMenu.pushDialog.description.untracked";

  // 复制失败也要有反馈：Web 非安全上下文和桌面端权限差异都会让 writeText 直接 reject，
  // 静默失败时用户会反复点「复制」并粘贴出上一次的旧内容，误以为错误文本就是这个。
  const handleCopyError = useCallback(() => {
    if (!error) {
      return;
    }

    // 先探测 navigator.clipboard 是否存在，而不是 try/catch writeText：
    // 某些 WebView 下 clipboard 是 undefined，直接调用会在事件回调里抛 TypeError，
    // 变成未捕获异常，连 toast 都不会出现。
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.copyFailed" },
          { error: "clipboard-unavailable" },
        ),
      );
      return;
    }

    // 用 then 的两个回调分别处理成功与失败，不用 async/await：
    // 复制是纯副作用，不参与渲染顺序，展开成 await 会让后续 setErrorCopied 落到下一微任务，
    // 按钮的「已复制」反馈看起来会慢一拍。
    void navigator.clipboard.writeText(error).then(
      () => {
        setErrorCopied(true);
        // 1.5 秒后恢复原文案；不清理定时器是有意的：弹窗很快被卸载时 setState 已被 React 忽略，
        // 而清理会引入一个需要跟随 open 变化的额外 effect。
        window.setTimeout(() => {
          setErrorCopied(false);
        }, 1500);
      },
      (copyError: unknown) => {
        // 失败分支必须把原始 message 带进文案：只显示「复制失败」时用户无法判断
        // 是权限被拒还是剪贴板被占用，也就不知道该不该重试。
        const message = copyError instanceof Error ? copyError.message : String(copyError);
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.error.copyFailed" },
            { error: message },
          ),
        );
      },
    );
  }, [error, intl]);

  // 有 error 时整块替换掉分支/上游信息，而不是追加在下面：
  // 失败后用户唯一关心的是错误原文与关闭，继续展示「将推送到 xxx」会让人以为推送已完成。
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({ id: "git.actionMenu.pushDialog.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: descriptionId })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-6">
          {!error && (
            <div className="rounded-xl bg-background/30">
              <div className="flex items-start justify-between p-4">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.currentBranchLabel",
                  })}
                </div>
                <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                  <GitBranchIcon className="size-4 text-foreground-subtle" />
                  <span>{currentBranchLabel}</span>
                </div>
              </div>

              <div className="space-y-3 border-t border-border/50 p-4 text-ui-base">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.upstreamLabel",
                    })}
                  </div>
                  <div className="text-foreground-subtle">
                    {gitSummary.trackingBranchName
                      ? gitSummary.trackingBranchName
                      : intl.formatMessage({
                          id: "git.actionMenu.pushDialog.upstreamPending",
                        })}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.aheadBehindLabel",
                    })}
                  </div>
                  <div className="text-foreground-subtle">
                    {intl.formatMessage(
                      {
                        id: "git.actionMenu.pushDialog.aheadBehindValue",
                      },
                      {
                        ahead: numberFormatter.format(gitSummary.ahead),
                        behind: numberFormatter.format(gitSummary.behind),
                      },
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.pushLabel",
                    })}
                  </div>
                  <div className="flex items-center gap-2 text-foreground-subtle">
                    <ArrowUpFromLine className="size-4" />
                    <span>
                      {intl.formatMessage({
                        id: "git.actionMenu.pushDialog.pushValue",
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!pushEnabled ? (
            <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                {intl.formatMessage({
                  id: "git.actionMenu.pushDialog.upToDate",
                })}
              </span>
            </div>
          ) : null}

          {error ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <span>
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.error.summary",
                  })}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.error.detailsLabel",
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-ui-base text-foreground-subtle hover:text-foreground"
                    onClick={handleCopyError}
                  >
                    {intl.formatMessage({
                      id: errorCopied
                        ? "git.actionMenu.pushDialog.error.copy.copied"
                        : "git.actionMenu.pushDialog.error.copy",
                    })}
                  </Button>
                </div>
                <Textarea
                  // Textarea 默认带 field-sizing-content，长错误文本会按内容扩张并把弹窗横向撑爆。
                  // 这里改成固定尺寸模式，并允许长内容换行，保证错误详情始终被限制在弹窗宽度内。
                  className="field-sizing-fixed w-full max-w-full min-h-56 rounded-lg border-input-border bg-background/50 px-3 py-3 text-ui-base text-foreground whitespace-pre-wrap break-words placeholder:text-foreground-subtlest focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
                  readOnly
                >
                  {error}
                </Textarea>
              </div>
            </>
          ) : null}

          <DialogFooter className="gap-2 pt-4">
            {error ? (
              <Button
                type="button"
                size="lg"
                onClick={() => onOpenChange(false)}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({ id: "common.close" })}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  onClick={() => onOpenChange(false)}
                  disabled={mutationPending}
                  className="h-10 min-w-0 px-5"
                >
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  onClick={onSubmit}
                  disabled={mutationPending || !pushEnabled}
                  className="h-10 min-w-0 px-5"
                >
                  {mutationPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.confirm",
                  })}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// GitActionMenu 是顶部 Git 工作流的唯一编排点：它持有两个弹窗的开关、快照、草稿与
// mutation 互斥标志，并把所有 git 调用收敛到 workspacePath 这一个作用域。
// 之所以不把 commit/push 状态下放到弹窗内部：弹窗会被 Radix 在关闭后卸载，
// 状态下沉会让「提交失败 → 用户关掉弹窗 → 再打开」丢失未提交的提交信息。
export function GitActionMenu({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  activeTaskChangeSummary = null,
  commitMessageConversationContext = null,
  onRefreshGit,
  className,
  triggerIconOnly = false,
  triggerLayout = "header",
}: GitActionMenuProps) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  // 五个 commit 状态分开存而不是合成一个对象：
  // loading 只描述快照是否就绪，message 是用户草稿，error 是失败回执，三者生命周期不同；
  // 合并后任何一处更新都要重建整个对象，会把用户正在输入的内容一起 reset 掉。
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitDialogLoading, setCommitDialogLoading] = useState(false);
  const [commitDialogState, setCommitDialogState] = useState<GitCommitDialogState | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  // 默认勾选「包含未暂存」：多数用户只会修改文件不会先 git add，
  // 默认 false 会造成「弹窗里看不到改动、以为没东西可提交」。
  const [commitIncludeUnstaged, setCommitIncludeUnstaged] = useState(true);
  // 生成状态与 mutationPending 分开：生成失败要保留用户已输入的内容，
  // 而 mutationPending 失败会把弹窗留在提交失败态，两者清理时机不同。
  const [commitMessageGenerationPending, setCommitMessageGenerationPending] = useState(false);
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  // mutationPending 是跨弹窗的全局互斥：commit dialog 里的「提交并推送」会连续执行
  // stage + commit + push，期间 push dialog 若可打开，用户能对同一分支发起第二次推送。
  const [mutationPending, setMutationPending] = useState(false);

  // 可用性只问「当前是不是一个可操作的 git 仓库」，不问有没有改动：
  // 干净仓库仍要能打开弹窗查看分支、执行推送（可能只是 ahead）。
  const actionAvailable = canUseGitActionMenu(gitSummary);
  // 分支标签在这里算好再传给两个弹窗：detached HEAD 之类需要本地化文案，
  // 若让子组件各自 formatMessage，同一个状态可能在两处显示不同语言。
  const currentBranchLabel = useMemo(
    () =>
      // detached HEAD 用专门文案，不能用 branchName 兜底：
      // detached 时 branchName 可能仍是上一个分支名，直接展示会让用户以为还在那个分支上推送。
      resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      }),
    [gitSummary.branchName, gitSummary.headRefType, intl],
  );
  // commitEnabled 只看 isDirty：它决定主按钮的文案/图标是提交还是推送，
  // 不能混入 actionAvailable，否则仓库不可用时会把主按钮误呈现成推送入口。
  const commitEnabled = gitSummary.isDirty;
  // pushEnabled 与 commitEnabled 独立：一个分支可以干净但 ahead>0，此时只应推送。
  const pushEnabled = canPushGitBranch(gitSummary);
  // 三种 pending 合并成一个 triggerPending，是为了让顶部按钮在任一阶段都显示转圈并禁用：
  // 少合并 loading 会让用户在快照加载中再点一次，触发第二份 refresh 并互相覆盖。
  const triggerPending = mutationPending || commitMessageGenerationPending || commitDialogLoading;
  const primaryActionId = useMemo(
    () =>
      // 派生顺序由 resolveGitActionMenuPrimaryAction 内部固定（提交优先于推送），
      // 这里传三个原始布尔而不是提前算好的动作，避免调用方各处顺序不一致。
      resolveGitActionMenuPrimaryAction({
        actionAvailable,
        commitEnabled,
        pushEnabled,
      }),
    [actionAvailable, commitEnabled, pushEnabled],
  );
  // primaryActionId 为 null 表示「既不能提交也不能推送」，此时必须禁用而不是回退：
  // 回退到提交会在 rebase/merge 进行中把用户带进必然失败的弹窗。
  const primaryActionDisabled = !actionAvailable || triggerPending || primaryActionId === null;
  // status-row 模式下 trigger 只是整行容器的一部分，点击事件挂在外层 div 上；
  // header 模式则由按钮本身处理，两种布局的点击所有权不能混用，否则一次点击触发两次。
  const isStatusRowTrigger = triggerLayout === "status-row";

  // 只记录「可用性派生结果」，不记录每次点击：这个入口在滚动/刷新时会被频繁重算，
  // 每次重算都打 info 会把日志刷满；而禁用原因（不是仓库 / 无动作）恰恰是排查
  // 「按钮灰了但用户不知道为什么」时唯一需要的信息。
  useEffect(() => {
    // 顶部 commit 入口改成“始终展示、异常时置灰”后，
    // 这里记录低频可用性日志，方便继续区分是仓库探测失败，
    // 还是 UI 交互本身出现了禁用/启用状态不一致。
    logger.info("[GitActionMenu] 顶部 Git 操作入口可用性变化", {
      workspacePath,
      available: actionAvailable,
      primaryActionDisabled,
      primaryActionId,
      isGitAvailable: gitSummary.isGitAvailable,
      isRepository: gitSummary.isRepository,
      headRefType: gitSummary.headRefType,
      branchName: gitSummary.branchName,
      trackingBranchName: gitSummary.trackingBranchName,
      isDirty: gitSummary.isDirty,
    });
  }, [
    gitSummary.branchName,
    gitSummary.headRefType,
    gitSummary.isDirty,
    gitSummary.isGitAvailable,
    gitSummary.isRepository,
    gitSummary.trackingBranchName,
    actionAvailable,
    primaryActionId,
    primaryActionDisabled,
    workspacePath,
  ]);

  // 关闭必须原子地清空全部派生状态，而不是只关 open：
  // 只关 open 时下一次打开会有一帧先渲染上一次的 state 与 message，
  // 用户看到旧文件清单，误以为仓库在两次打开之间没有变化。
  // 这里同时清 generationPending，避免上一次未完成的生成在下次打开时把按钮锁住。
  const closeCommitDialog = useCallback(() => {
    setCommitDialogOpen(false);
    setCommitDialogLoading(false);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    setCommitMessageGenerationPending(false);
  }, []);

  // 推送弹窗不持有快照，关闭只需清错误：
  // 错误是上一轮推送的回执，留到下次打开会与新一次推送的状态混在一起，
  // 用户会以为这次推送也失败了。
  const closePushDialog = useCallback(() => {
    setPushDialogOpen(false);
    setPushError(null);
  }, []);

  // 打开前先清错误，而不是等请求失败时覆盖：
  // 否则上一次的红色错误块会在本次确认界面里闪一帧，用户以为刚点就失败了。
  const openPushDialog = useCallback(() => {
    setPushError(null);
    setPushDialogOpen(true);
  }, []);

  // 快照读取是唯一会真正访问 git 的「读」路径：refresh 同时带回 summary、identity 与
  // 两态文件，保证这三者在同一时刻一致。拆成三次调用会出现「文件来自刷新前、身份来自
  // 刷新后」的拼接态，身份刚配置好时提交按钮仍被禁用。
  // resetMessage 由调用方决定：分支切换必须清空（旧分支的提交信息会误导），
  // 而单纯重试读取不应清空用户正在编辑的内容。
  const loadCommitDialogState = useCallback(
    async (options?: { resetMessage?: boolean }) => {
      setCommitDialogLoading(true);
      setCommitError(null);
      if (options?.resetMessage) {
        setCommitMessage("");
      }

      try {
        // includeIdentity=true 是必须的：不请求身份就拿不到本地 user.name/email，
        // 弹窗会一直认为「尚未探测」，提交按钮永远禁用且没有解释。
        const refreshResult = await gitService.refresh({
          workspacePath,
          includeIdentity: true,
        });
        const rawUnstagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.unstagedChanges);
        const rawStagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.stagedChanges);
        // 过滤只在「当前会话改过的文件」范围内生效，且两个列表用同一份 summary：
        // 若只过滤未暂存而不过滤已暂存，用户会看到一批本会话没碰过的暂存文件，
        // 勾选「包含未暂存」后它们会被一起提交。
        const unstagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawUnstagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        const stagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawStagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        // 一次性写入完整快照：先写 state 再写 includeUnstaged 会让一帧内出现
        // 「未暂存文件还没被勾选」的空预览，用户能看到列表闪一下再补全。
        setCommitDialogState({
          summary: refreshResult.summary,
          activeTaskChangeSummary,
          identity: refreshResult.identity,
          stagedFiles,
          unstagedFiles,
        });
        setCommitIncludeUnstaged(unstagedFiles.length > 0);
        setCommitDialogLoading(false);
      } catch (error: unknown) {
        // 读取失败时关闭弹窗而不是留在 loading：refresh 失败通常意味着仓库已不可用
        // （目录被删、git 被占用），留着 spinner 会让用户一直等一个不会来的结果。
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 读取提交弹窗状态失败", {
          workspacePath,
          error: message,
        });
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.commitDialog.error.requestFailed" },
            { error: message },
          ),
        );
        closeCommitDialog();
      }
    },
    [activeTaskChangeSummary, closeCommitDialog, gitService, intl, workspacePath],
  );

  // 先 open 再 await，顺序不能反：open 立刻让弹窗渲染 spinner，
  // 用户能确认点击已被接收；反过来在慢盘上会出现 1~2 秒完全无反馈，
  // 用户重复点击就会并发两份 refresh，后返回的旧快照可能覆盖新的。
  // 同时清空上一轮的 state 与 message，保证 spinner 阶段不会闪出旧内容。
  const openCommitDialog = useCallback(async () => {
    setCommitDialogOpen(true);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    await loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState]);

  // 分支切换是「提交目标变了」：摘要与弹窗快照必须同时刷新，
  // 只刷摘要会让弹窗仍按旧分支的文件清单 stage，提交落到新分支上。
  // resetMessage 为 true，因为旧分支的提交信息描述的是另一批改动。
  const refreshCommitDialogAfterBranchChange = useCallback(() => {
    onRefreshGit();
    void loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState, onRefreshGit]);

  // 生成只依赖传入的快照，不读组件外部的 git 状态：
  // 这样「生成时描述的文件」与「提交时 stage 的文件」来自同一份 state + 同一个 includeUnstaged，
  // 用户中途改勾选会重新生成，而不是用旧描述提交新集合。
  const generateCommitMessage = useCallback(
    async (state: GitCommitDialogState, includeUnstaged: boolean): Promise<string> => {
      // files 在这里再算一次而不是复用渲染期的 selectedFiles：
      // 渲染期值可能来自上一帧的闭包，与服务层即将读取的路径集合可能已经不同。
      const files = getCommitDialogFiles(state, includeUnstaged);
      const currentSessionFilePaths = getCurrentSessionFilePaths(state.activeTaskChangeSummary);
      logger.info("[GitActionMenu] 开始生成提交消息", {
        workspacePath,
        branchName: gitSummary.branchName,
        selectedFileCount: files.length,
        currentSessionFileCount: currentSessionFilePaths?.length ?? 0,
        includeUnstaged,
        conversationMessageCount: commitMessageConversationContext?.messages.length ?? 0,
      });

      // locale 用当前 UI 语言显式传入，而不是让服务层读全局：
      // 同机多窗口可能语言不同，读全局会生成与当前界面不一致的提交信息。
      // 身份用可选展开而不是传 undefined，是为了让「没有 workspaceIdentity」与
      // 「显式传空」在服务层可区分，后者可能被解释成已配置但为空。
      const result = await gitService.generateCommitMessage({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        locale,
        includeUnstaged,
        ...(currentSessionFilePaths ? { currentSessionFilePaths } : {}),
        ...(commitMessageConversationContext
          ? { conversationContext: commitMessageConversationContext }
          : {}),
      });

      logger.info("[GitActionMenu] 提交消息生成成功", {
        workspacePath,
        branchName: gitSummary.branchName,
        providerId: result.providerId,
        model: result.model,
      });
      return result.message;
    },
    [
      commitMessageConversationContext,
      gitService,
      gitSummary.branchName,
      locale,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // 生成入口只负责「校验 + pending + 调纯函数」，不根据 message 是否为空分支：
  // 消息为空时应由动作禁用条件拦住，这里再判一次会形成两套规则，
  // 用户在生成途中清空消息时会看到按钮时灵时不灵。
  const handleGenerateCommitMessage = useCallback(async () => {
    // 没有快照就没有文件清单，发请求只会让服务层拿到空列表并生成一段空洞描述，
    // 用户还会以为「生成质量变差了」。
    if (!commitDialogState) {
      return;
    }

    const stagePaths = getCommitDialogStagePaths(commitDialogState, commitIncludeUnstaged);
    if (stagePaths.length === 0) {
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.noChanges",
        }),
      );
      return;
    }

    // 先清错误再置 pending：错误块与「生成中」同时出现会让人以为这次已经失败，
    // 而实际上用户看到的是上一次的回执。
    setCommitError(null);
    setCommitMessageGenerationPending(true);

    try {
      const nextCommitMessage = await generateCommitMessage(
        commitDialogState,
        commitIncludeUnstaged,
      );
      // 成功才覆盖输入框；失败路径绝不能写空串，
      // 否则用户手写的内容会被一次模型超时静默吞掉。
      setCommitMessage(nextCommitMessage);
    } catch (error: unknown) {
      // 生成失败只提示、不关闭弹窗、不清空已输入内容：
      // 用户通常还有一份可手改的草稿，丢掉它比失败本身更糟。
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 生成提交消息失败", {
        workspacePath,
        branchName: gitSummary.branchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.generateFailed",
        }),
      );
    } finally {
      // pending 必须在 finally 释放：生成超时抛错也能让按钮恢复可点，
      // 否则用户只能关掉弹窗重开才能再试一次。
      setCommitMessageGenerationPending(false);
    }
  }, [
    commitIncludeUnstaged,
    commitDialogState,
    generateCommitMessage,
    gitSummary.branchName,
    intl,
    workspacePath,
  ]);

  // 推送统一走这里，是为了让「提交后推送」与「仅推送」共享同一套错误处理与刷新：
  // 两处各自调用 gitService.push 时，总有一处忘记 onRefreshGit，
  // 于是推送成功后 ahead 计数仍显示旧值，用户会再点一次。
  // showToast 由调用方决定：提交并推送成功时提交通知已经出现，再弹一条会覆盖前一条。
  const pushCurrentBranch = useCallback(
    async (options?: { showToast?: boolean }) => {
      const result = await gitService.push({ workspacePath });
      logger.info("[GitActionMenu] 推送更改成功", {
        workspacePath,
        branchName: result.branchName,
        trackingBranchName: result.trackingBranchName,
        remoteName: result.remoteName,
        setUpstream: result.setUpstream,
      });
      if (options?.showToast !== false) {
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.toast.success" },
            {
              target:
                result.trackingBranchName?.trim() ||
                result.branchName?.trim() ||
                currentBranchLabel,
            },
          ),
        );
      }
      return result;
    },
    [currentBranchLabel, gitService, intl, workspacePath],
  );

  // 提交主流程按「校验 → 计算路径 → stage → commit → 可选 push → 刷新」固定顺序执行，
  // 顺序不可交换：先 commit 再 stage 会把新文件留在工作区；先 push 再刷新会让
  // push dialog 里的 ahead 计数与实际远端不一致。
  // 整个流程只在 finally 里释放 mutationPending，确保任何一步抛错都不会让入口永久禁用。
  const handleCommitAction = useCallback(
    async (options?: { pushAfterCommit?: boolean }) => {
      // 快照为空说明弹窗还在加载或已关闭，此时点提交属于竞态窗口内的误触，
      // 直接返回比用空 state 计算出一组空路径、再由 git 报「没有可提交内容」更清楚。
      if (!commitDialogState) {
        return;
      }

      // 身份缺失是确定性失败：这里提前拦截并给出可操作的文案，
      // 而不是让 git commit 抛出原始英文错误，后者用户无法判断该去配置什么。
      if (!hasGitCommitIdentity(commitDialogState.identity)) {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.identityMissing",
          }),
        );
        return;
      }

      // 勾选状态只读取一次并固定下来：await 期间用户可以继续改勾选，
      // 若各处分别读 state，stage 的集合与 commit 的集合会来自不同版本。
      const includeUnstaged = commitIncludeUnstaged;
      // stagePaths 始终是「按当前勾选算出的完整待提交集合」，pathsToStage 只在
      // 需要包含未暂存时才非空：已暂存文件不需要再 add，add 只会刷新索引时间戳。
      const stagePaths = getCommitDialogStagePaths(commitDialogState, includeUnstaged);
      const pathsToStage = includeUnstaged ? stagePaths : [];
      if (stagePaths.length === 0) {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.error.noChanges",
          }),
        );
        return;
      }

      // trim 后再判断：只有空白字符的消息在 git 侧会被当成空消息拒绝，
      // 提前 trim 还能保证最终提交信息与预览里显示的一致，不会带首尾空行。
      // 消息为空时自动生成而不是直接报错，是为了让「一键提交」在用户没写消息时仍然可用。
      let nextCommitMessage = commitMessage.trim();
      if (!nextCommitMessage) {
        setCommitError(null);
        setCommitMessageGenerationPending(true);
        try {
          nextCommitMessage = await generateCommitMessage(commitDialogState, includeUnstaged);
          setCommitMessage(nextCommitMessage);
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          logger.warn("[GitActionMenu] 生成提交消息失败", {
            workspacePath,
            branchName: gitSummary.branchName,
            error: message,
          });
          setCommitError(
            intl.formatMessage({
              id: "git.actionMenu.commitDialog.error.generateFailed",
            }),
          );
          return;
        } finally {
          setCommitMessageGenerationPending(false);
        }
      }

      // committed 只是「本次尝试里 commit 是否已经成功」的局部标记，不是持久状态：
      // 它决定 catch 里该提示「提交失败」还是「推送失败」，也决定是否需要重新读取快照。
      // 放在 try 外层是为了让 catch 能读到，但绝不能在 finally 里重置成 false 后再用。
      setCommitError(null);
      setMutationPending(true);
      let committed = false;

      try {
        logger.info("[GitActionMenu] 开始提交当前更改", {
          workspacePath,
          branchName: gitSummary.branchName,
          selectedPathCount: stagePaths.length,
          stagedPathCount: pathsToStage.length,
          includeUnstaged,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        // 先 stage 再 commit 是不可交换的：commit 读取的是索引，
        // 先 commit 会把本次勾选的未暂存文件留在工作区，用户以为已经提交。
        if (pathsToStage.length > 0) {
          await gitService.stagePaths({
            workspacePath,
            paths: pathsToStage,
          });
        }
        // stagedOnly 必须显式取反 includeUnstaged，不能省略让服务层用默认值：
        // 默认值与用户当前勾选无关，省略后预览里取消掉的文件仍可能被提交。
        // paths 传完整的 stagePaths 而不是 pathsToStage，是因为「不包含未暂存」时
        // 仍需要限定只提交已暂存的那批，而不是整个索引。
        await gitService.commit({
          workspacePath,
          message: nextCommitMessage,
          paths: stagePaths,
          stagedOnly: !includeUnstaged,
        });
        // 置位必须在 commit 成功返回之后：提前置位会让随后的 push 失败被报成
        // 「提交失败」，用户重试就会产生一次重复提交。
        committed = true;

        // push 失败不复用提交通知：showToast=false 让推送错误只通过 catch 文案表达，
        // 否则会先弹「提交成功」再弹「推送失败」，两条互相矛盾。
        if (options?.pushAfterCommit) {
          await pushCurrentBranch({ showToast: false });
        }

        // 成功日志放在 push 之后：只有整条链路都成功才记为「提交当前更改成功」，
        // 放在 commit 之后会让「提交成功但推送失败」在日志里看起来完全成功。
        logger.info("[GitActionMenu] 提交当前更改成功", {
          workspacePath,
          branchName: gitSummary.branchName,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        // 关闭弹窗与刷新摘要的顺序是先关后刷：close 会清空 message，
        // 若先刷新摘要导致组件重渲染，弹窗里会闪一帧空消息再关闭。
        toast(
          intl.formatMessage({
            id: options?.pushAfterCommit
              ? "git.actionMenu.commitDialog.toast.commitAndPushSuccess"
              : "git.actionMenu.commitDialog.toast.success",
          }),
        );
        closeCommitDialog();
        onRefreshGit();
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 提交当前更改失败", {
          workspacePath,
          error: message,
          committed,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        // 文案按 committed 分流：已经提交但推送失败时，用户最需要知道「commit 已经生效，
        // 只需重试推送」；统一报「请求失败」会诱导用户重写提交信息并再次 commit。
        // 原始 message 必须带上：区分网络失败、认证失败与非快进合并，靠的就是这段文本。
        setCommitError(
          intl.formatMessage(
            {
              id:
                committed && options?.pushAfterCommit
                  ? "git.actionMenu.commitDialog.error.pushAfterCommitFailed"
                  : "git.actionMenu.commitDialog.error.requestFailed",
            },
            { error: message },
          ),
        );
        // 提交已经落地但后续步骤失败，也必须刷新摘要：
        // 否则顶部仍显示 isDirty=true，用户会以为提交没生效而重复提交。
        if (committed) {
          onRefreshGit();
        }
      } finally {
        setMutationPending(false);
      }
    },
    [
      closeCommitDialog,
      commitIncludeUnstaged,
      commitDialogState,
      commitMessage,
      generateCommitMessage,
      gitService,
      gitSummary.branchName,
      intl,
      onRefreshGit,
      pushCurrentBranch,
      workspacePath,
    ],
  );

  // `handleCommitSubmit` 与 `handleCommitAndPushSubmit` 拆成两个入口，调用点语义更清晰。
  // 两者共用 handleCommitAction，保证 stage/commit 的前置校验完全相同，
  // 唯一差异是 pushAfterCommit，避免两套流程在失败文案上漂移。
  const handleCommitSubmit = useCallback(async () => {
    await handleCommitAction();
  }, [handleCommitAction]);

  const handleCommitAndPushSubmit = useCallback(async () => {
    await handleCommitAction({ pushAfterCommit: true });
  }, [handleCommitAction]);

  // 独立推送不做任何前置计算：pushEnabled 已经在打开弹窗时校验过，
  // 这里再校验一次是为了覆盖「弹窗打开期间分支被外部切走」的窗口，
  // 此时推送会把错误的本地分支推到远端。
  const handlePushSubmit = useCallback(async () => {
    if (!pushEnabled) {
      return;
    }

    // 先置 pending 再清 error：清 error 会触发一次重渲染，
    // 若此时按钮仍可点，用户能在同一帧里再点一次推送。
    setMutationPending(true);
    setPushError(null);

    try {
      await pushCurrentBranch();
      // 成功才关闭：失败时保留弹窗与错误，用户可以复制原文或直接重试，
      // 关闭再打开会丢失这次失败的完整回执。
      closePushDialog();
      onRefreshGit();
    } catch (error: unknown) {
      // 推送失败不关闭弹窗，也不清 mutationPending 之外的状态：
      // ahead/behind 与上游信息仍然有效，保留它们能帮用户判断是不是非快进导致。
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 推送更改失败", {
        workspacePath,
        error: message,
      });
      setPushError(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [closePushDialog, intl, onRefreshGit, pushCurrentBranch, pushEnabled, workspacePath]);

  // 主按钮是「当前最可能的动作」的快捷入口，不承担选择职责：
  // `handlePrimaryAction` 在有改动时开提交弹窗，干净且可推时开推送弹窗。
  // 判断顺序不能反：先判推送会让有改动但也可推的分支跳过提交流程。
  const handlePrimaryAction = useCallback(() => {
    if (primaryActionDisabled) {
      return;
    }

    runUserAction({
      input: { featureId: "workbench.git", action: "open", trigger: "button" },
      operation: () => {
        // push 分支显式 return，不能依赖 else：两个 open 都是异步副作用，
        // 漏掉 return 会同时打开两个弹窗，叠在一起后关闭顺序不可控。
        if (primaryActionId === "push") {
          openPushDialog();
          return;
        }
        void openCommitDialog();
      },
      completed: { resultSource: "local_commit" },
      failureStage: "git_action_open",
    });
  }, [openCommitDialog, openPushDialog, primaryActionId, primaryActionDisabled]);

  // status-row 布局把点击挂在整行 div 上，按钮自己不再处理点击；
  // 两种情况必须互斥，否则一次点击会同时触发容器与按钮，打开两次弹窗。
  const handleStatusRowContainerClick = useCallback(() => {
    handlePrimaryAction();
  }, [handlePrimaryAction]);

  // 外层容器只负责布局与（status-row 下的）点击，真正的禁用态在 Button 上：
  // 容器禁用会吞掉 hover 反馈，用户看不出按钮为什么点不动。
  return (
    <>
      <div
        onClick={isStatusRowTrigger && !triggerIconOnly ? handleStatusRowContainerClick : undefined}
        className={cn(
          // macOS/Windows 小窗口下，顶部 Git 主按钮的中文文案会和分支入口、窗口控制区挤在同一行。
          // 在 header 容器变窄时只隐藏主按钮文字，保留图标入口，避免丢失核心 Git 操作。
          // transition-all 会把 scrollbar-color 等非合成属性也启动动画，
          // 进而触发整页 UpdateLayoutTree；Git 入口只需要颜色反馈，不动画尺寸和滚动条属性。
          "flex h-7 items-center overflow-hidden rounded-lg border border-border bg-input transition-colors hover:border-border-hover @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:justify-center",
          // 图标模式固定宽度 7，与 header 分支按钮同宽：
          // 不等宽会让相邻控件在隐藏文字后左右跳动，点击位置也跟着变。
          triggerIconOnly && "w-7 justify-center",
          isStatusRowTrigger &&
            "h-8 w-full justify-start rounded-lg border-0 bg-transparent hover:border-transparent hover:bg-hover @max-[560px]/workspace-header:w-full @max-[560px]/workspace-header:justify-start",
          className,
        )}
      >
        <Button
          data-testid={TID_GIT_ACTION_TRIGGER}
          type="button"
          variant="ghost"
          size="default"
          disabled={primaryActionDisabled}
          aria-label={intl.formatMessage({
            id: "git.actionMenu.trigger.ariaLabel",
          })}
          className={cn(
            // 用 [&>span]:hidden 而不是条件渲染文字，是为了让按钮的可访问名仍由
            // aria-label 承担，同时避免窄屏下文字把布局撑开再被裁掉。
            "h-7 rounded-lg border-0 gap-1 px-1.5 @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:px-0 @max-[560px]/workspace-header:[&>span]:hidden",
            triggerIconOnly && "w-7 px-0 [&>span]:hidden",
            isStatusRowTrigger &&
              "h-8 min-w-0 w-full justify-start gap-2 px-2 text-left text-ui-base hover:bg-transparent hover:text-foreground @max-[560px]/workspace-header:w-auto @max-[560px]/workspace-header:[&>span]:inline",
          )}
          onClick={isStatusRowTrigger && !triggerIconOnly ? undefined : handlePrimaryAction}
        >
          {/* 主按钮进入 pending 时直接替换左侧动作图标，避免在紧凑头部里额外追加 loading 图标把按钮挤宽。*/}
          {triggerPending ? (
            <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
          ) : primaryActionId === "push" ? (
            <ArrowUpFromLine className="size-4 text-foreground" />
          ) : (
            <GitCommitIcon className="size-4 text-foreground" />
          )}
          <span className={cn(isStatusRowTrigger && "min-w-0 truncate")}>
            {intl.formatMessage({ id: "git.actionMenu.trigger" })}
          </span>
        </Button>
      </div>

      <GitCommitDialog
        open={commitDialogOpen}
        loading={commitDialogLoading}
        state={commitDialogState}
        workspacePath={workspacePath}
        message={commitMessage}
        error={commitError}
        mutationPending={mutationPending}
        generationPending={commitMessageGenerationPending}
        includeUnstaged={commitIncludeUnstaged}
        pushEnabled={pushEnabled}
        onRefreshGit={refreshCommitDialogAfterBranchChange}
        onOpenChange={(nextOpen) => {
          // 只在关闭时统一清理：打开由 openCommitDialog 负责，
          // 在这里再处理打开会出现「按钮打开 → Radix 回调再打开」的双重初始化。
          if (!nextOpen) {
            closeCommitDialog();
          }
        }}
        onMessageChange={setCommitMessage}
        onIncludeUnstagedChange={setCommitIncludeUnstaged}
        onGenerateMessage={() => {
          void handleGenerateCommitMessage();
        }}
        onSubmit={() => {
          void handleCommitSubmit();
        }}
        onSubmitAndPush={() => {
          void handleCommitAndPushSubmit();
        }}
        onPushOnly={() => {
          // 先关提交弹窗再开推送弹窗：两个 Dialog 同时 open 会争夺焦点与 ESC 处理，
          // 用户按一次 ESC 只关掉其中一个，另一个留在屏幕上无法交互。
          closeCommitDialog();
          openPushDialog();
        }}
      />

      <GitPushDialog
        open={pushDialogOpen}
        gitSummary={gitSummary}
        currentBranchLabel={currentBranchLabel}
        pushEnabled={pushEnabled}
        error={pushError}
        mutationPending={mutationPending}
        onOpenChange={(nextOpen) => {
          // 推送弹窗的错误只在关闭时清除，失败后保持打开能看到原文；
          // 这里不阻止关闭，用户需要在反复失败时能退出去检查远端配置。
          if (!nextOpen) {
            closePushDialog();
          }
        }}
        onSubmit={() => {
          void handlePushSubmit();
        }}
      />
    </>
  );
}
