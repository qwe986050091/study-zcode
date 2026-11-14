// ============================================================================
// ConversationShareConfirmationDock.tsx — 会话分享停靠面板（确认 / 进度 / 失败 / 警告）
//
// 职责边界：
//   - 只做展示与本地交互提示：草稿、发布、错误都来自 store，本组件不自己发请求。
//   - 三种版面共用一个 section：确认表单、发布进度、结构化失败详情。
//   - 所有副作用（取消、改选、确认、取消某轮）都经 props 回抛给 owner。
//
// 三态判定只看两个输入：pending（发布在飞）与 error（上次发布失败）。
//   publishView = pending || error   进入「进度 / 失败」版面。
//   compactProgress = pending && !error   发布中且无错，用紧凑进度条。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 三种版面必须互斥，且 error 单独也能进入发布版面。
//   守住它的位置：publishView = pending || error !== null。
//   改错故障：只判 pending 时，发布失败会退回确认表单，用户看不到失败原因。
//
// INV-02 紧凑进度只在「发布中且没有错误」时启用。
//   守住它的位置：compactProgress = pending && !error。
//   改错故障：失败时仍用紧凑版，阶段详情与修复入口全部被折叠，用户无从下手。
//
// INV-03 披露勾选是确认的前置条件，但失败重试不需要再确认。
//   守住它的位置：handleConfirm 的 if (!error && !disclosureAccepted)。
//   改错故障：重试也被拦截，用户以为按钮坏了；或首次发布绕过免责声明。
//
// INV-04 未勾选时只做本地提示，绝不上抛 onConfirm。
//   守住它的位置：handleConfirm 的提示分支以 return 结尾。
//   改错故障：弹一次抖动却仍然发起发布，免责声明形同虚设。
//
// INV-05 提示行为顺序固定：滚动到披露区 → 聚焦复选框 → 抖动确认行。
//   守住它的位置：handleConfirm 里的三个 ref 调用顺序。
//   改错故障：先抖动后滚动，动画在视口外播放，用户只看到按钮没反应。
//
// INV-06 滚动只改正文容器的 scrollTop，不能让外层页面跟着滚。
//   守住它的位置：bodyRef 的 scrollTop 计算（基于 getBoundingClientRect 差值）。
//   改错故障：使用 scrollIntoView 会把整个聊天流带走，用户丢失上下文位置。
//
// INV-07 抖动动画必须尊重 prefers-reduced-motion。
//   守住它的位置：matchMedia 判断包裹 animate 调用。
//   改错故障：前庭敏感用户被强制播放位移动画，无障碍验收不通过。
//
// INV-08 动画实例必须保存、可取消，并在卸载时清理。
//   守住它的位置：reviewAnimationRef 与依赖 [] 的 cleanup effect。
//   改错故障：多次点击叠出多条动画；卸载后回调仍在跑，React 报状态更新警告。
//
// INV-09 用户一旦改动勾选，必须清掉 reviewRequired 并取消动画。
//   守住它的位置：Checkbox 的 onCheckedChange 前两行。
//   改错故障：勾选后警告色仍挂在确认行上，用户以为还没勾上。
//
// INV-10 进度百分比按阶段固定三档，不做按 artifact 数量插值。
//   守住它的位置：progressPercent 的三元（20 / 58 / 82）。
//   改错故障：插值会与实际后端阶段不同步，进度条反复回跳。
//
// INV-11 阶段状态的优先级是 complete → failed → active → pending。
//   守住它的位置：phaseState 的三元链。
//   改错故障：失败阶段先被算成 active，图标一直转圈而状态文案已报错。
//
// INV-12 failed 只标记「当前 phase」，不污染其它阶段。
//   守住它的位置：failed = error !== null && phase === progressPhase。
//   改错故障：整条轨道全部变红，用户无法判断是哪一步失败。
//
// INV-13 失败文案必须按 phase 选择，未知或越界回落 checkingFailed。
//   守住它的位置：failedProgressMessageId 的嵌套三元。
//   改错故障：上传失败被写成「检查失败」，用户去排查完全无关的环节。
//
// INV-14 进度条必须同时声明 role / aria-valuenow / min / max / label。
//   守住它的位置：role=progressbar 的四个属性。
//   改错故障：读屏软件只念一个无意义的数字，视障用户不知道在等什么。
//
// INV-15 紧凑版把状态文案设为 sr-only，而不是删除它。
//   守住它的位置：compactProgress 时的 sr-only 类名。
//   改错故障：视觉更干净了，但无障碍通道同时失去发布状态播报。
//
// INV-16 上传阶段的 n/m 只在 totalArtifacts > 0 时展示。
//   守住它的位置：phaseDescription 的 totalArtifacts > 0 条件。
//   改错故障：展示 0/0，用户以为一个文件都没上传成功。
//
// INV-17 确认按钮的五项禁用条件缺一不可。
//   守住它的位置：disabled 的 pending / selectionEditing / publishDisabled / selectedCount / title。
//   改错故障：空标题或零选中也能发布，服务端拒绝后用户才看到错误。
//
// INV-18 pending 时关闭按钮禁用，但失败态必须允许关闭。
//   守住它的位置：X 按钮的 disabled={pending}。
//   改错故障：发布失败后 dock 关不掉，用户被迫留在错误面板里。
//
// INV-19 页脚文案按三态取 messageId：失败 / 发布中 / 确认选区。
//   守住它的位置：footerMetaMessageId 的三元。
//   改错故障：失败态仍显示「已选 N 条」，与标题的失败语义冲突。
//
// INV-20 页脚参数必须与文案配套：发布中给 access，其它给 total。
//   守住它的位置：footerMetaValues 的 pending && !error 判断。
//   改错故障：文案里要 total、参数里没有，格式化会漏词或直接抛错。
//
// INV-21 权限映射必须双向全覆盖，不能有落空分支。
//   守住它的位置：ConversationSharePermissionPicker 的入参与 onChange。
//   改错故障：未知权限被映射成 private，用户以为链接可访问却打不开。
//
// INV-22 accessMode 缺省必须用 store 导出的默认值。
//   守住它的位置：解构默认值 DEFAULT_CONVERSATION_SHARE_ACCESS_MODE。
//   改错故障：本地写死 public_readonly，默认从私密变成公开。
//
// INV-23 服务端 requestId 走按需 Popover，不常驻错误区。
//   守住它的位置：错误行右侧的诊断按钮与 PopoverContent。
//   改错故障：常驻会把 dock 撑高，并把「改选范围」这个主要修复路径挤到视口外。
//
// INV-24 每条 issue 的文案参数必须全字段兜底为「—」。
//   守住它的位置：errors / warnings 两处 values 对象。
//   改错故障：undefined 被格式化进文案，界面出现字面量 undefined。
//
// INV-25 「取消该轮」只在 productTurnId 与 onDeselectTurn 同时存在时渲染。
//   守住它的位置：issue.productTurnId !== undefined && onDeselectTurn 条件。
//   改错故障：渲染出点了没反应的按钮，用户以为修复失败。
//
// INV-26 omittedIssueCount 才展示「还有 N 条」。
//   守住它的位置：两处 error.omittedIssueCount / warnings.omittedIssueCount 判断。
//   改错故障：值为 0 时仍展示「还有 0 条」，像是没修完。
//
// INV-27 警告区只在「非发布中」且「有 issue」时展示，且语义与失败严格区分。
//   守住它的位置：warnings && warnings.issues.length > 0 && !pending。
//   改错故障：发布中弹警告让用户以为要中断；或把部分文件跳过写成失败。
//
// INV-28 整体错误（有 messageId）时不渲染逐条 issues。
//   守住它的位置：error.messageId ? null : ul 列表。
//   改错故障：整体 4xx 与逐文件校验错误叠在一起，信息互相矛盾。
//
// INV-29 列表 key 必须含 code + rowId + index。
//   守住它的位置：两处 key 模板。
//   改错故障：同一文件多条同类问题时 key 冲突，勾选与展开状态串行。
//
// INV-30 formatValue 只对 size 类 code 做单位换算。
//   守住它的位置：code.includes(size) / payload_size_limit 判断。
//   改错故障：把轮次序号 1024 显示成 1.0 KB。
//
// INV-31 正文区独立滚动，底部操作区固定不滚。
//   守住它的位置：bodyRef 容器的 overflow-y-auto 与 actions 的 shrink-0。
//   改错故障：内容变长后「确认 / 取消」被挤出视口，用户必须滚到底才能发布。
//
// INV-32 dock 只继承 Composer 的基础输入 surface，不叠加自己的 ring / 阴影 / 固定宽度。
//   守住它的位置：section 的 className（仅 bg-popover）。
//   改错故障：与输入区叠出双层光晕，切换面板时层级闪烁。
//
// INV-33 keep-open 标记必须保留，供外部的「点击外部关闭」逻辑识别。
//   守住它的位置：data-conversation-share-keep-open。
//   改错故障：点输入框或下拉时 dock 被当成外部点击关闭，已填标题丢失。
//
// INV-34 窄屏下主操作独占一行，次要操作换行排列。
//   守住它的位置：确认按钮 col-span-2 与容器 @min-[480px] 栅格。
//   改错故障：两个按钮挤在一行，长语言文案被截断成省略号。
//
// INV-35 发布中隐藏全部次要操作，只保留状态文案与关闭。
//   守住它的位置：!compactProgress 才渲染按钮组。
//   改错故障：发布中仍能点「调整范围」：`publishRequest` 与改选并发，范围不确定。
//
/* oxlint-disable eslint(max-lines) -- 确认、发布进度和结构化失败详情必须共享同一 dock 状态与操作上下文。 */
// [契约] 依赖面刻意很窄：只有 react、lucide 图标、基础 UI 原语与 store 的展示类型。
// 本组件不得直接引用 service / repo / runtime：
// 发布链路的失败重试由上层 owner 决定，dock 只负责把点击变成意图。
// [失败路径] 新增依赖时优先复用现有原语（Button / Input / Checkbox / Popover），
// 自带一套控件会让平台主题与键盘可达性在这里失灵。
// [性能] 唯一订阅的全局状态是 i18n；其余全部走 props，
// 保证流式输出期间本组件不会因 store 变化被动重渲染。
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
  ShieldCheck,
  X,
  MessagesSquare,
  ChevronRight,
} from "lucide-react";
// [契约] 表单控件必须复用基础原语：
// Input / Checkbox / Button 已经承载平台焦点环、禁用态与主题变量，
// 自绘控件会在 Linux 桌面与手机 Web 上出现焦点不可见、对比度不足。
// [失败路径] size=lg 是输入区统一高度，改成本地固定高度会与 Composer 错位。
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationShareAccessMode } from "@zcode/shared";
// [契约] 权限选择器是独立受控组件，dock 只负责在两种表示之间翻译（INV-21）：
// store 的 accessMode 用 public_readonly / public_importable / private，
// 选择器用 link-viewer / link-editor / private。
// [失败路径] 翻译必须双向全覆盖且有默认分支，
// 否则新增模式时会静默落到 private，用户以为分享链接对外可见。
import { ConversationSharePermissionPicker } from "@/ConversationSharePermissionPicker.js";
import {
  DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  type ConversationShareDisplayError,
  type ConversationShareDisplayWarnings,
  type ConversationShareProgressPhase,
} from "@/store/conversationShareSelectionStore.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareIssueMessageId,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

// [契约] 轨道顺序即后端阶段顺序，数组下标同时用于「已完成」判定：
// collecting → uploading → checking，任何调整都必须与 store 的阶段推进保持一致。
const SHARE_PROGRESS_PHASES: readonly ConversationShareProgressPhase[] = [
  "collecting",
  "uploading",
  "checking",
];

// [契约] 用 Record 绑定全部枚举，新增阶段时类型检查会强制补文案，
// 避免出现「阶段在跑但标题是空白」的静默缺陷。
const SHARE_PHASE_LABEL_IDS: Record<ConversationShareProgressPhase, string> = {
  collecting: "conversationShare.phase.collecting",
  uploading: "conversationShare.phase.uploading",
  checking: "conversationShare.phase.checking",
};

// [契约] 组件是纯受控的：选中数、标题、权限、进度全部由 owner 传入，
// 本组件只产生意图（取消 / 改选 / 确认 / 改标题 / 改权限 / 取消某轮）。
// [权衡] preflightContent 用 ReactNode 注入而不是让 dock 自己查：
// 预检内容属于选择面板的职责，dock 只负责位置与滚动容器。
export interface ConversationShareConfirmationDockProps {
  selectionEditing?: boolean;
  publishDisabled?: boolean;
  preflightChecking?: boolean;
  preflightContent?: ReactNode;

  selectedCount: number;
  totalCount: number;
  title?: string;
  accessMode?: ConversationShareAccessMode;
  progressLabel?: string;
  progressPhase?: ConversationShareProgressPhase;
  completedArtifacts?: number;
  totalArtifacts?: number;
  onCancel: () => void;
  onEditSelection: () => void;
  onConfirm: () => void;
  onTitleChange?: (title: string) => void;
  onAccessModeChange?: (accessMode: ConversationShareAccessMode) => void;
  disclosureAccepted?: boolean;
  onDisclosureAcceptedChange?: (accepted: boolean) => void;
  pending?: boolean;
  error?: ConversationShareDisplayError | null;
  warnings?: ConversationShareDisplayWarnings | null;
  /** 整轮取消选择，按 productTurnId 定位（turnOrdinal 只用于展示文案）。 */
  onDeselectTurn?: (productTurnId: string) => void;
  onDismissError?: () => void;
  onDismissWarnings?: () => void;
  onCopyRequestId?: () => void;
}

// [性能] 可选回调的默认值必须是模块级常量：
// 内联 () => {} 每次渲染都是新引用，会让依赖它的 memo 与 effect 反复触发。
const NOOP = () => {};

// [契约] 所有可选 props 在这里集中给默认值，后续代码不再做 undefined 判断。
// [失败路径] 默认值只能是原始值或上面的模块常量，不能是对象 / 数组字面量。
function ConversationShareConfirmationDockImpl({
  selectionEditing = false,
  publishDisabled = false,
  preflightChecking = false,
  preflightContent,
  selectedCount,
  totalCount,
  title = "Share",
  accessMode = DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  progressLabel,
  progressPhase = "collecting",
  completedArtifacts = 0,
  totalArtifacts = 0,
  onCancel,
  onEditSelection,
  onConfirm,
  onTitleChange = NOOP,
  onAccessModeChange = NOOP,
  disclosureAccepted = false,
  onDisclosureAcceptedChange = NOOP,
  pending = false,
  error = null,
  warnings = null,
  onDeselectTurn,
  onDismissError,
  onDismissWarnings,
  onCopyRequestId,
}: ConversationShareConfirmationDockProps) {
  // [契约] locale 只用于 artifact 类型与允许格式的本地化（formatConversationShareArtifactType /
  // formatConversationShareAllowedArtifacts），不参与任何判断分支。
  const { intl, locale } = useZCodeIntl();
  // [契约] 诊断入口的 aria-label 与 Popover 标题共用同一个文案 id，
  // 保证视觉标题与读屏标签不会分叉。
  const errorDetailsLabel = intl.formatMessage({
    id: "conversationShare.issue.details",
  });
  // [事务] 四个 ref 各自只服务一个动作，不要合并：
  // disclosureRef  滚动定位的锚点。
  // bodyRef        唯一允许被滚动的容器。
  // checkboxRef    未确认时接收焦点。
  // reviewRowRef   抖动动画的作用对象（只动确认行，不动整块）。
  const disclosureRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const checkboxRef = useRef<HTMLButtonElement>(null);
  const reviewRowRef = useRef<HTMLLabelElement>(null);
  // [事务] reviewRequired 是唯一的本地状态：
  // 只表达「用户已尝试确认但还没勾选」，属提示态而非 `validationError`。
  // [失败路径] 不要把它初始化成「未勾选即为 true」，
  // 那会在首次打开面板时就闪一次警告色和抖动。
  const [reviewRequired, setReviewRequired] = useState(false);
  // [契约] 这是派生值而不是第二份状态：
  // reviewRequired 只在「用户尝试确认但未勾选」时置 true，勾选后立即失效（INV-09）。
  // [失败路径] 直接把 reviewRequired 当作文案开关，会在用户勾选后仍显示警告色。
  const invalidDisclosure = reviewRequired && !disclosureAccepted;
  // [资源] 保存 Animation 句柄是为了「重入时先取消」和「卸载时清理」（INV-08）：
  // 连续点击确认会创建多条 keyframe 动画，位移叠加后抖动幅度会翻倍。
  const reviewAnimationRef = useRef<Animation | null>(null);
  useEffect(() => () => reviewAnimationRef.current?.cancel(), []);
  // [事务] 确认按钮的唯一入口，两种结局：
  // 1) 未勾选且无错误 → 本地提示并 return（绝不触发发布）；
  // 2) 其余情况 → onConfirm 交给 owner（是否重试由 error 决定）。
  // [失败路径] 失败态（error 非空）跳过勾选校验：此时免责声明已经确认过一次，
  // 重试再拦一次会让「修复后重试」变成两次点击。
  const handleConfirm = () => {
    // [不变量] 未勾选且无错误时拦截发布（INV-03/INV-04）：
    // error 非空表示这是一次重试，免责声明在首次发布时已经确认过。
    // [失败路径] 把 error 判断去掉，重试会被要求再勾一次，
    // 用户往往会以为是勾选状态丢了而不是发布失败。
    if (!error && !disclosureAccepted) {
      setReviewRequired(true);
      // 仅对确认行做 transform 提示并滚动正文，不改变布局或牵动外层页面。
      // [事务] 滚动计算用的是「披露区与正文可视区的相对位置」，不是绝对坐标：
      // 只有披露区超出可视区时才滚动，差值即最小滚动量，
      // 避免每次点击都把面板拽到最底部。
      const body = bodyRef.current;
      const disclosure = disclosureRef.current;
      if (body && disclosure) {
        const bodyBounds = body.getBoundingClientRect();
        const bounds = disclosure.getBoundingClientRect();
        // [事务] 只滚最小必要距离（INV-06）：
        // 披露区在上方被裁切就向上补差值，在下方被裁切就向下补差值，
        // 两者都不满足时完全不滚，保持用户当前位置。
        if (bounds.top < bodyBounds.top) body.scrollTop += bounds.top - bodyBounds.top;
        else if (bounds.bottom > bodyBounds.bottom)
          body.scrollTop += bounds.bottom - bodyBounds.bottom;
      }
      // [失败路径] focus 必须带 preventScroll: true：
      // 浏览器默认聚焦会再滚一次，把上面刚算好的位置覆盖掉，最终停在错误的位置。
      checkboxRef.current?.focus({ preventScroll: true });
      reviewAnimationRef.current?.cancel();
      // [权衡] 减少动效时不播动画，但仍然保留「聚焦 + 滚动 + 警告色」三重提示：
      // 提示不能只依赖动画这一条通道（INV-07）。
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        reviewAnimationRef.current =
          reviewRowRef.current?.animate(
            [
              { transform: "translateX(0)" },
              { transform: "translateX(-4px)" },
              { transform: "translateX(4px)" },
              { transform: "translateX(-2px)" },
              { transform: "translateX(2px)" },
              { transform: "translateX(0)" },
            ],
            { duration: 280, easing: "ease-out" },
          ) ?? null;
      }
      return;
    }
    onConfirm();
  };
  // [契约] 版面切换的唯一开关（INV-01）：
  // pending 是「正在发」，error 是「上次发失败」，两者都不该回到确认表单。
  // [失败路径] 不要用 completedArtifacts 或 progressLabel 推断是否发布中，
  // 它们只是展示数据，可能在重试时为旧值。
  const publishView = pending || error !== null;
  // [契约] 紧凑版面只属于纯发布中（INV-02）：
  // 它决定状态文案是 sr-only、标题是否行内展示、按钮组是否整体隐藏。
  // [失败路径] 失败时仍 compact 会让修复入口全部消失，用户只剩一个关闭按钮。
  const compactProgress = pending && !error;
  // [权衡] 三档固定值是有意为之（INV-10）：
  // 后端只保证「进入某阶段」，没有可靠的整体进度；插值会制造不存在的精度，
  // 并在阶段回退时让进度条倒着走。
  const progressPercent =
    progressPhase === "collecting" ? 20 : progressPhase === "uploading" ? 58 : 82;
  // [失败路径] 失败文案按阶段取（INV-13）：
  // 默认分支落在 checkingFailed，因为 checking 是最后阶段，未知阶段只可能来自它的扩展。
  const failedProgressMessageId =
    progressPhase === "collecting"
      ? "conversationShare.progress.collectingFailed"
      : progressPhase === "uploading"
        ? "conversationShare.progress.uploadingFailed"
        : "conversationShare.progress.checkingFailed";
  // [失败路径] indexOf 可能返回 -1（阶段值来自外部 store）：
  // 此时所有阶段既非 complete 也非 active，轨道整体呈 pending，
  // 这是可接受的降级；不要用 ?? 0 伪装成第一阶段。
  const progressPhaseIndex = SHARE_PROGRESS_PHASES.indexOf(progressPhase);
  // [契约] 权限值到摘要文案的三元必须与权限选择器的三态一一对应（INV-21）。
  // [失败路径] 新增权限模式时这里若走默认分支，页脚会显示错误的可见范围。
  const accessSummaryMessageId =
    accessMode === "public_readonly"
      ? "conversationShare.permission.linkViewerSummary"
      : accessMode === "public_importable"
        ? "conversationShare.permission.linkEditorSummary"
        : "conversationShare.permission.privateSummary";
  // [契约] 页脚三态（INV-19）：失败 → 修复提示；发布中 → 权限摘要；确认态 → 选区计数。
  // [失败路径] 失败态误用选区计数，用户会以为失败原因是「选多了」。
  const footerMetaMessageId = error
    ? "conversationShare.publish.failedFooter"
    : pending
      ? "conversationShare.publish.footerMeta"
      : "conversationShare.partial.selectionCount";
  // [事务] 参数必须与上面选中的文案模板配套（INV-20）：
  // 发布中模板需要 access，确认态模板需要 total，二者不能同时喂。
  const footerMetaValues: Record<string, string | number> =
    pending && !error
      ? {
          selected: selectedCount,
          access: intl.formatMessage({ id: accessSummaryMessageId }),
        }
      : { selected: selectedCount, total: totalCount };
  // [契约] 只做「数字 + 单位」的展示格式化，`formatShareCount` 不改语义。
  // [失败路径] 单位换算只对 size 类 code 生效（INV-30）：
  // 用一个全局 heuristic（例如「大于 1024 就当字节」）会把轮次、行号也换算掉。
  const formatValue = (value: number | undefined, code: string): string => {
    // [失败路径] undefined 统一渲染成破折号而不是空串：
    // 空串会让「字段缺失」与「字段为空」在界面上无法区分。
    if (value === undefined) return "—";
    if (code.includes("size") || code === "payload_size_limit") {
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} B`;
    }
    return String(value);
  };

  // [契约] 版面骨架固定为「正文滚动区 + 底部固定操作区」：
  // 1) header：标题（成功 / 失败 / 发布中三态）+ 关闭；失败时额外给「调整范围」。
  // 2) 发布中或失败：进度轨道（三阶段）+ 失败详情。
  // 3) 确认态：标题输入、选区入口、权限选择、披露勾选。
  // 4) 失败详情与警告详情都在正文区内部滚动，不撑高 dock。
  // 5) footer：状态文案 + 主操作（确认 / 重试）。
  // [失败路径] 顺序不能调换：错误详情必须紧随进度轨道，
  // 用户看到失败的第一屏就要能读到原因与修复入口。
  return (
    // 分享 dock 曾在同一输入区额外叠加 popover ring、阴影和固定宽度，
    // 切换时会产生不必要的层级光晕；这里只继承普通 Composer 的基础输入 surface。
    <section
      data-conversation-share-keep-open="confirmation-dock"
      data-testid="conversation-share-confirmation-dock"
      className={cn(
        "@container/share flex max-h-[70dvh] w-full min-w-0 flex-col overflow-hidden text-foreground",
        "bg-popover",
      )}
    >
      {/* 窄面板下表单会增高；正文独立滚动，避免把发布操作挤出视口。 */}
      <div
        ref={bodyRef}
        data-testid="conversation-share-confirmation-body"
        className="min-h-0 overflow-y-auto overscroll-contain"
      >
        <div
          data-testid="conversation-share-confirmation-header"
          className={cn("flex flex-wrap items-center justify-between gap-3 p-3")}
        >
          <div className="min-w-0">
            <p
              className={cn(
                "flex items-center gap-1.5 font-medium",
                "text-ui-lg",
                error && "text-destructive",
              )}
            >
              {error ? <CircleX className="size-4 shrink-0" aria-hidden="true" /> : null}
              {intl.formatMessage({
                id: error
                  ? "conversationShare.publish.failedTitle"
                  : pending
                    ? "conversationShare.generatingLink"
                    : "conversationShare.popover.title",
              })}
            </p>
            {error ? (
              <p className="mt-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({
                  id: "conversationShare.publish.failedDescription",
                })}
              </p>
            ) : null}
          </div>
          {
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending}
              onClick={onCancel}
              aria-label={intl.formatMessage({
                id: "conversationShare.result.dismiss",
              })}
            >
              <X className="size-4" />
            </Button>
          }
        </div>
        {error ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onEditSelection}
            data-testid="conversation-share-adjust"
          >
            {intl.formatMessage({ id: "conversationShare.range.adjust" })}
          </Button>
        ) : null}
        {publishView ? (
          <div
            data-testid="conversation-share-publish-progress"
            className={cn("grid gap-3", compactProgress ? "px-3 pb-3" : "p-3 pb-4")}
          >
            {compactProgress ? (
              <p className="line-clamp-2 break-words text-ui-base" title={title}>
                {title}
              </p>
            ) : null}
            <div className="grid gap-2">
              <p role="status" className={compactProgress ? "sr-only" : "text-ui-base font-medium"}>
                {error ? intl.formatMessage({ id: failedProgressMessageId }) : progressLabel}
              </p>
              <div
                className={cn(
                  "overflow-hidden rounded-full bg-background-subtle",
                  compactProgress ? "h-1" : "h-1.5",
                )}
                role="progressbar"
                aria-label={intl.formatMessage({
                  id: "conversationShare.generatingLink",
                })}
                aria-valuenow={progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  data-testid="conversation-share-progress-fill"
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    error ? "bg-destructive" : "bg-primary",
                  )}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
            <div
              className={cn(
                "grid gap-3 text-ui-sm",
                !compactProgress && "@min-[640px]/share:grid-cols-3",
              )}
            >
              {SHARE_PROGRESS_PHASES.map((phase, index) => {
                // [事务] 阶段态由「下标 + 当前阶段 + 是否有错」三输入决定（INV-11/INV-12）：
                // complete 只看下标，failed / active 只看是否等于当前 phase。
                // [失败路径] 不要让 failed 条件包含 index < progressPhaseIndex：
                // 那会把之前的阶段也标红，掩盖真正的失败点。
                const completed = index < progressPhaseIndex;
                const failed = error !== null && phase === progressPhase;
                const active = !error && phase === progressPhase;
                const phaseState = completed
                  ? "complete"
                  : failed
                    ? "failed"
                    : active
                      ? "active"
                      : "pending";
                // [契约] 图标是状态的第二通道（文案是第一通道）：
                // checking 的 pending 态用盾牌，提示这一步是「安全检查」而非普通等待。
                const PhaseIcon = completed
                  ? CircleCheck
                  : failed
                    ? CircleX
                    : active
                      ? LoaderCircle
                      : phase === "checking"
                        ? ShieldCheck
                        : Circle;
                // [失败路径] 描述优先级：失败 → 已完成 → 上传进度 → 当前进度 → 待开始。
                // 上传中的 n/m 依赖 totalArtifacts，未知时回落到通用进度文案（INV-16）。
                const phaseDescription = failed
                  ? intl.formatMessage({ id: "conversationShare.phase.failed" })
                  : completed
                    ? intl.formatMessage({
                        id:
                          phase === "collecting"
                            ? "conversationShare.phase.collectingComplete"
                            : "conversationShare.phase.uploadingComplete",
                      })
                    : active && phase === "uploading" && totalArtifacts > 0
                      ? intl.formatMessage(
                          { id: "conversationShare.phase.uploadingActive" },
                          {
                            completed: completedArtifacts,
                            total: totalArtifacts,
                          },
                        )
                      : active
                        ? progressLabel
                        : intl.formatMessage({
                            id:
                              phase === "collecting"
                                ? "conversationShare.phase.collectingPending"
                                : phase === "uploading"
                                  ? "conversationShare.phase.uploadingPending"
                                  : "conversationShare.phase.checkingPending",
                          });
                // [契约] 单阶段的根节点同时承载三件事：
                // data-phase-state 给 e2e 断言、aria-current 给读屏定位「当前步」、
                // 颜色与图标给视觉状态；三者必须由同一个 state 派生，不能各算一次。
                return (
                  <div
                    key={phase}
                    data-testid={`conversation-share-publish-phase-${phase}`}
                    data-phase-state={phaseState}
                    className={cn(
                      "flex min-w-0 items-start gap-2",
                      failed
                        ? "text-destructive"
                        : completed || active
                          ? "text-foreground"
                          : "text-foreground-subtlest",
                    )}
                    aria-current={active || failed ? "step" : undefined}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <PhaseIcon
                        className={cn(
                          "size-4",
                          compactProgress && active && "animate-spin motion-reduce:animate-none",
                          completed
                            ? "text-success"
                            : failed
                              ? "text-destructive"
                              : active
                                ? "text-foreground"
                                : "text-foreground-subtle",
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="grid min-w-0 gap-1">
                      <strong
                        className={cn(
                          "text-ui-base",
                          !compactProgress || active ? "font-medium" : "font-normal",
                        )}
                      >
                        {intl.formatMessage({
                          id: SHARE_PHASE_LABEL_IDS[phase],
                        })}
                      </strong>
                      {!compactProgress || active ? (
                        <span
                          className={cn(
                            "text-foreground-subtle",
                            compactProgress && "text-ui-base",
                          )}
                        >
                          {phaseDescription}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div className={cn("grid px-3", "gap-3")}>
              <label className={cn("grid gap-1 text-foreground-subtle", "text-ui-base")}>
                {intl.formatMessage({ id: "conversationShare.shareTitle" })}
                <Input
                  size="lg"
                  value={title}
                  onChange={(event) => onTitleChange(event.currentTarget.value)}
                  className={undefined}
                />
              </label>
              {
                <div className="grid gap-1 text-ui-base">
                  <span className="text-foreground-subtle">
                    {intl.formatMessage({
                      id: "conversationShare.range.label",
                    })}
                  </span>
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={onEditSelection}
                    disabled={selectionEditing}
                    data-testid="conversation-share-adjust"
                    aria-expanded={selectionEditing}
                    aria-busy={preflightChecking}
                    className="w-full justify-start gap-2 border-input-border bg-input pl-3 pr-2 font-normal hover:border-input-border-hover"
                  >
                    {preflightChecking ? (
                      <LoaderCircle
                        className="size-4 shrink-0 animate-spin text-foreground-subtle"
                        aria-hidden="true"
                      />
                    ) : (
                      <MessagesSquare
                        className="size-4 shrink-0 text-foreground-subtle"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className="min-w-0 flex-1 truncate text-left"
                      data-testid="conversation-share-range-summary"
                    >
                      {preflightChecking
                        ? intl.formatMessage({ id: "conversationShare.partial.preflightChecking" })
                        : intl.formatMessage(
                            {
                              id:
                                selectedCount === totalCount
                                  ? "conversationShare.range.all"
                                  : "conversationShare.range.selected",
                            },
                            { count: selectedCount },
                          )}
                    </span>
                    <ChevronRight
                      className="size-3.5 shrink-0 text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </Button>
                  {preflightContent}
                </div>
              }
              <ConversationSharePermissionPicker
                permission={
                  accessMode === "public_readonly"
                    ? "link-viewer"
                    : accessMode === "public_importable"
                      ? "link-editor"
                      : "private"
                }
                onChange={(permission) =>
                  onAccessModeChange(
                    permission === "link-viewer"
                      ? "public_readonly"
                      : permission === "link-editor"
                        ? "public_importable"
                        : "private",
                  )
                }
              />
            </div>
            {/* 设计原因：敏感信息确认需要保留警示语义，但把详细检查范围收进锚定浮层，避免确认 dock 被长文案撑高。 */}
            <section
              ref={disclosureRef}
              data-testid="conversation-share-disclosure"
              role="note"
              className={cn("mx-3 mt-3 text-ui-sm text-foreground", "py-1")}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div
                    data-testid="conversation-share-disclosure-content-row"
                    className={cn("flex min-w-0 gap-y-1", "flex-col items-start")}
                  >
                    <label
                      ref={reviewRowRef}
                      className={cn(
                        "flex min-w-0 items-start gap-2 text-ui-base",
                        invalidDisclosure && "text-warning",
                      )}
                    >
                      <Checkbox
                        ref={checkboxRef}
                        data-testid="conversation-share-disclosure-checkbox"
                        aria-invalid={invalidDisclosure}
                        checked={disclosureAccepted}
                        onCheckedChange={(checked) => {
                          setReviewRequired(false);
                          reviewAnimationRef.current?.cancel();
                          onDisclosureAcceptedChange(checked === true);
                        }}
                        className="mt-0.5"
                      />
                      <span className={"leading-5"}>
                        {intl.formatMessage({
                          id: "conversationShare.disclosure.checkbox",
                        })}
                      </span>
                    </label>
                    <div
                      data-testid="conversation-share-disclosure-supporting-row"
                      className={cn(
                        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm leading-5",
                        "pl-6",
                      )}
                    >
                      <span
                        data-testid="conversation-share-disclosure-description"
                        className="min-w-0 text-ui-sm leading-5 text-foreground-subtle"
                      >
                        {intl.formatMessage({
                          id: "conversationShare.disclosure.description",
                        })}
                      </span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            data-testid="conversation-share-disclosure-scope-trigger"
                            className="inline-flex shrink-0 items-center text-ui-sm leading-5 text-foreground-subtle underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            {intl.formatMessage({
                              id: "conversationShare.disclosure.scope.trigger",
                            })}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          side="top"
                          align="end"
                          data-testid="conversation-share-disclosure-scope-content"
                          className="w-[22.5rem] max-w-[calc(100vw-1rem)] max-h-(--radix-popover-content-available-height) gap-3 overflow-y-auto border-popover-border p-3"
                        >
                          <PopoverTitle className="text-ui-base font-medium">
                            {intl.formatMessage({ id: "conversationShare.disclosure.scope.title" })}
                          </PopoverTitle>
                          <div className="grid gap-1">
                            <p className="text-ui-sm font-medium text-foreground-subtle">
                              {intl.formatMessage({
                                id: "conversationShare.disclosure.scope.reviewLabel",
                              })}
                            </p>
                            <ul className="grid gap-1 text-ui-base">
                              {(["conversation", "tools", "generated"] as const).map((scope) => (
                                <li key={scope}>
                                  {intl.formatMessage({
                                    id: `conversationShare.disclosure.scope.${scope}`,
                                  })}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div className="grid gap-1">
                            <p className="text-ui-sm font-medium text-foreground-subtle">
                              {intl.formatMessage({
                                id: "conversationShare.disclosure.scope.sensitiveLabel",
                              })}
                            </p>
                            <p className="text-ui-base">
                              {intl.formatMessage({
                                id: "conversationShare.disclosure.scope.sensitive",
                              })}
                            </p>
                          </div>
                          <p className="text-ui-sm text-foreground-subtle">
                            {intl.formatMessage({ id: "conversationShare.disclosure.scope.note" })}
                          </p>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}
        {error ? (
          // 单行 Toast 无法同时承载文件、轮次和限制上限；详情固定留在分享面板，避免用户丢失修复路径。
          <section
            role="alert"
            data-testid="conversation-share-error-details"
            className={cn(
              "mx-4 max-h-40 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 text-ui-base text-foreground",
              error.messageId ? "mb-2 p-2" : "mb-3 p-2.5",
            )}
          >
            <div
              data-testid="conversation-share-error-row"
              className={cn(
                "flex justify-between gap-3",
                error.messageId ? "items-center" : "mb-1.5 items-start",
              )}
            >
              <p
                data-testid="conversation-share-error-message"
                className="flex min-w-0 flex-1 items-center gap-1.5 font-medium leading-6"
              >
                <span className="min-w-0 flex-1">
                  {error.messageId
                    ? intl.formatMessage({ id: error.messageId }, { status: error.status ?? "—" })
                    : intl.formatMessage(
                        { id: "conversationShare.error.summary" },
                        { count: error.issueCount },
                      )}
                </span>
                {/* 修复原因：服务端 request ID 属于诊断信息，常驻错误区会拉高 dock 并分散修复文案注意力；改为按需 Popover 展示。 */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="conversation-share-request-id-trigger"
                      aria-label={errorDetailsLabel}
                      title={errorDetailsLabel}
                      className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/30"
                    >
                      <CircleAlert className="size-4" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    side="top"
                    sideOffset={6}
                    collisionPadding={16}
                    data-testid="conversation-share-request-id-content"
                    className="w-80 max-w-[calc(100vw-1rem)] gap-2 p-3"
                  >
                    <PopoverTitle className="text-ui-base font-medium">
                      {errorDetailsLabel}
                    </PopoverTitle>
                    {(
                      [
                        ["HTTP", error.status],
                        [
                          intl.formatMessage({
                            id: "conversationShare.issue.codeLabel",
                          }),
                          error.code,
                        ],
                        [
                          intl.formatMessage({
                            id: "conversationShare.issue.clientRequestIdLabel",
                          }),
                          error.clientRequestId,
                        ],
                        ["operationId", error.operationId],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.ruleLabel" }),
                          error.rejection?.rule,
                        ],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.pathLabel" }),
                          error.rejection?.path,
                        ],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.fieldLabel" }),
                          error.rejection?.field,
                        ],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.rowLabel" }),
                          error.rejection?.row_index === undefined
                            ? undefined
                            : error.rejection.row_index + 1,
                        ],
                        [
                          intl.formatMessage({ id: "conversationShare.issue.rowKindLabel" }),
                          error.rejection?.row_kind,
                        ],
                      ] as const
                    ).map(([label, value]) =>
                      value === undefined ? null : (
                        <p
                          key={label}
                          className="break-all text-ui-sm text-foreground-subtle select-text"
                        >
                          {label}: {value}
                        </p>
                      ),
                    )}
                    {error.requestId ? (
                      <div className="grid gap-2">
                        <p className="text-ui-sm text-foreground-subtle">
                          {intl.formatMessage({
                            id: "conversationShare.issue.requestIdLabel",
                          })}
                        </p>
                        <div className="flex min-w-0 items-start gap-2">
                          <code className="min-w-0 flex-1 break-all font-mono text-ui-base text-foreground select-text">
                            {error.requestId}
                          </code>
                          {onCopyRequestId ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={intl.formatMessage({
                                id: "conversationShare.issue.copyRequestId",
                              })}
                              onClick={onCopyRequestId}
                              className="shrink-0 px-2"
                            >
                              {intl.formatMessage({
                                id: "conversationShare.issue.copyRequestId",
                              })}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <p className="text-ui-sm text-foreground-subtle">
                        {intl.formatMessage({
                          id: "conversationShare.issue.requestIdMissing",
                        })}
                      </p>
                    )}
                  </PopoverContent>
                </Popover>
              </p>
              {onDismissError ? (
                <button
                  type="button"
                  data-testid="conversation-share-error-dismiss"
                  className="shrink-0 text-ui-sm leading-6 text-foreground-subtle underline underline-offset-2"
                  onClick={onDismissError}
                >
                  {intl.formatMessage({ id: "common.close" })}
                </button>
              ) : null}
            </div>
            {error.messageId ? null : (
              <ul className="grid gap-1.5">
                {error.issues.map((issue, index) => {
                  // [契约] 文案 id 由 issue.code 决定，展示参数统一走 values（INV-24）。
                  // [失败路径] values 里每个字段都必须兜底成「—」：
                  // 后端某些错误不带 artifact 信息，缺兜底会把 undefined 拼进用户可见文案。
                  const messageId = resolveConversationShareIssueMessageId(issue);
                  // [契约] 失败与警告两块使用完全相同的参数结构，
                  // 这样同一个 messageId 在两个通道里显示一致，不会出现「警告说 A、失败说 B」。
                  const values = {
                    turnOrdinal: issue.turnOrdinal ?? "—",
                    artifactDisplayName: issue.artifactDisplayName ?? "—",
                    artifactType: formatConversationShareArtifactType(issue, locale),
                    extension: issue.extension ?? "—",
                    mimeType: issue.mimeType ?? "—",
                    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
                    actual: formatValue(issue.actual, issue.code),
                    limit: formatValue(issue.limit, issue.code),
                    phase: issue.phase ?? "—",
                  };
                  // [契约] 每条 issue 的渲染分两段：文案行 + 可选的「取消该轮」操作。
                  // 取消操作按 productTurnId 定位（INV-25），turnOrdinal 只用于人类可读文案，
                  // 两者不能互换——序号会随选择变化，id 才是稳定锚点。
                  return (
                    <li
                      key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}
                      className="grid gap-1"
                    >
                      <p className="leading-5">{intl.formatMessage({ id: messageId }, values)}</p>
                      {issue.productTurnId !== undefined && onDeselectTurn ? (
                        <button
                          type="button"
                          className="w-fit text-ui-sm font-medium text-foreground underline underline-offset-2"
                          onClick={() => onDeselectTurn?.(issue.productTurnId!)}
                        >
                          {intl.formatMessage({
                            id: "conversationShare.issue.deselectTurn",
                          })}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {error.omittedIssueCount ? (
              <p className="mt-2 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "conversationShare.issue.more" },
                  { count: error.omittedIssueCount },
                )}
              </p>
            ) : null}
          </section>
        ) : null}
        {warnings && warnings.issues.length > 0 && !pending ? (
          // 发布已成功，只是部分正文引用的文件读不到被跳过；与失败区分开，也不提供「取消该轮」。
          <section
            role="status"
            data-testid="conversation-share-warning-details"
            className="mx-4 mb-3 max-h-40 overflow-y-auto rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-ui-base text-foreground"
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <p className="font-medium">
                {intl.formatMessage(
                  { id: "conversationShare.warning.summary" },
                  { count: warnings.issueCount },
                )}
              </p>
              {onDismissWarnings ? (
                <button
                  type="button"
                  className="shrink-0 text-ui-sm text-foreground-subtle underline underline-offset-2"
                  onClick={onDismissWarnings}
                >
                  {intl.formatMessage({ id: "common.close" })}
                </button>
              ) : null}
            </div>
            <ul className="grid gap-1.5">
              {warnings.issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.rowId ?? "global"}-${index}`} className="leading-5">
                  {intl.formatMessage(
                    { id: resolveConversationShareWarningMessageId(issue) },
                    {
                      turnOrdinal: issue.turnOrdinal ?? "—",
                      artifactDisplayName: issue.artifactDisplayName ?? "—",
                      artifactType: formatConversationShareArtifactType(issue, locale),
                      extension: issue.extension ?? "—",
                      mimeType: issue.mimeType ?? "—",
                      allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
                      actual: formatValue(issue.actual, issue.code),
                      limit: formatValue(issue.limit, issue.code),
                      phase: issue.phase ?? "—",
                    },
                  )}
                </li>
              ))}
            </ul>
            {warnings.omittedIssueCount ? (
              <p className="mt-2 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "conversationShare.issue.more" },
                  { count: warnings.omittedIssueCount },
                )}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
      <div
        data-testid="conversation-share-confirmation-actions"
        className={cn(
          "flex shrink-0 flex-wrap content-center items-center justify-between gap-2 p-3",
          compactProgress && "pt-0",
        )}
      >
        <p
          role="status"
          className={cn(
            "min-w-0 text-ui-sm leading-4 tabular-nums",
            compactProgress && "text-foreground-subtle",
            !publishView && "sr-only",
          )}
        >
          {intl.formatMessage({ id: footerMetaMessageId }, footerMetaValues)}
        </p>
        {!compactProgress ? (
          <div className="grid w-full min-w-0 grid-cols-2 gap-2 @min-[480px]/share:flex @min-[480px]/share:w-auto @min-[480px]/share:flex-1 @min-[480px]/share:flex-wrap @min-[480px]/share:justify-end">
            {/* 根因：内层按钮强制横排时仍会被外层裁切；窄屏主操作与次要操作分行。 */}
            <Button
              type="button"
              size="lg"
              disabled={
                pending ||
                selectionEditing ||
                publishDisabled ||
                selectedCount === 0 ||
                !title.trim()
              }
              onClick={handleConfirm}
              data-testid="conversation-share-confirm"
              className={cn(
                "col-span-2 whitespace-normal break-words px-3 @min-[480px]/share:order-last",
                "h-10",
              )}
            >
              {intl.formatMessage({
                id: error
                  ? "conversationShare.publish.retry"
                  : pending
                    ? "conversationShare.partial.publishing"
                    : "conversationShare.partial.confirm",
              })}
            </Button>
            {null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// [性能] 导出面只暴露 memo 版本：dock 挂在整个输入区上，
// 父级在流式输出期间高频重渲染，必须靠 props 引用相等整体跳过。
// [失败路径] 因此所有 props 回调都应由 owner 用 useCallback 稳定，
// 本文件内部的 NOOP 默认值也必须保持模块级常量。
export const ConversationShareConfirmationDock = memo(ConversationShareConfirmationDockImpl);
