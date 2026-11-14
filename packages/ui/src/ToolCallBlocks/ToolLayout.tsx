// ToolCallBlocks/ToolLayout：工具调用卡片的统一外壳，摘要行、状态词与可折叠正文槽位都在这里编排。
// 展开状态以 persistOpenKey（缺省回落到 toolId）为键存在模块级 Map 中，跨重渲染与流式更新保持稳定。
// 正文卸载使用 300ms 延迟，配合 Radix Collapsible 的关闭动画高度测量，避免高度塌陷时的视觉跳变。
// 本文件只做展示投影：不读取服务、不写回会话事实，只把调用方传入的面板投影成可访问的折叠结构。
// INV-01 展开真相单源：isOpen 与 toolLayoutOpenState 必须同步写入；守住位置：onOpenChange 与 autoOpen、autoCollapse 副作用；改错故障：刷新或切回会话后卡片展开态与上次不一致。
// INV-02 持久键回落：resolvedPersistOpenKey 以 persistOpenKey 优先、toolId 兜底；守住位置：resolvedPersistOpenKey 声明；改错故障：多实例共用一个键，展开一张卡会连带展开无关卡片。
// INV-03 摘要操作互斥：summaryAction 存在时整卡不参与折叠，forceOpen 与 canToggle 均失效；守住位置：isExpanded 计算与 Collapsible open；改错故障：带操作按钮的行出现可折叠三角，点开却是空壳。
// INV-04 forceOpen 是硬锁：非摘要操作模式下强制展开且 onOpenChange 直接忽略用户点击；守住位置：onOpenChange 早退分支；改错故障：用户点击无法收起被锁定的卡片，交互看起来失灵。
// INV-05 自动展开只触发一次：hasAutoOpenedRef 记名后不再响应 autoOpen 变化；守住位置：autoOpen 效果的早退判断；改错故障：用户手动收起后又被拉回展开，切不回摘要视图。
// INV-06 完成收敛仅认边沿：只有 running 到 completed 的那一次跳变会收起，静止在非运行态不重复触发；守住位置：previousIsRunningRef 对比分支；改错故障：历史卡片在无关重渲染中被反复收起。
// INV-07 正文延迟卸载保护：收起后保留 children 至 300ms 计时结束，让 Radix 读到内层高度变量；守住位置：contentUnmountDelayRef 计时与清理；改错故障：详情区短暂撑成超高空白，下方消息像整块闪没。
// INV-08 展开即取消待卸载：重新展开必须清掉挂起的卸载计时器，否则计时到点仍会把正文摘掉；守住位置：isExpanded 分支的 clearTimeout 段；改错故障：快速连点展开后正文消失，只剩标题行。
// INV-09 计时器所有权唯一：卸载与复制重置两个 ref 在复用前都要先清旧再写新；守住位置：handleCopyFailureTooltip 与组件卸载清理效果；改错故障：旧计时器回调覆盖新状态，复制反馈闪一下就卡住。
// INV-10 延迟槽位与展开态解耦：shouldRenderContent 一旦置真可先于 isExpanded 保持，避免关闭动画期间正文被摘；守住位置：shouldRenderResolvedContent 的条件；改错故障：收起动画中途内容消失，高度测量读到 0。
// INV-11 内容求值惰性：renderContent 只在可见或保留窗口内调用；守住位置：resolvedContent 三元分支；改错故障：折叠着的卡片仍执行渲染函数，流式期间重复开销堆积。
// INV-12 双标签随态切换：expanded 变体仅在展开时生效，未传则回落原字段，undefined 与 null 语义不同；守住位置：summaryKindDetail 与 summarySecondaryText 的判定；改错故障：只传空值想隐藏的文案在收起时又出现。
// INV-13 摘要内容键兜底：summaryContentKey 缺省时用标题与状态词拼键，键变才重放动画；守住位置：resolvedSummaryContentKey 拼接；改错故障：工具状态更新后扫光动画不重播，看起来像卡死。
// INV-14 差异计数与展开隐藏：hideDiffCountWhenOpen 只在展开时屏蔽计数，收起必须恢复显示；守住位置：shouldShowDiffCount 与 diffCount 传参；改错故障：收起后改动块数一直缺失，用户以为没有变更。
// INV-15 图标静态化权衡：运行态不使用旋转 loading，改由文案扫光表达进行中，避免长列表持续动画占用渲染；守住位置：summaryIcon 与 kindLabelClassName；改错故障：多卡片流式时动画帧率下降，滚动发涩。
// INV-16 状态指示物分层：statusIndicator 与状态词同显同隐但留在提示触发区之外，虚线只属于词本身；守住位置：statusNode 包裹分支；改错故障：空环灯被一起划线并遮蔽悬停提示，报错原因取不到。
// INV-17 失败详情不阻塞展开：statusTooltip 非空时挂到状态词 tooltip，失败态沿用与成功态一致的折叠逻辑；守住位置：statusWordNode 的 Tooltip 分支；改错故障：失败卡片被强制撑开或错误原因无处可看。
// INV-18 复制动作需隔离冒泡：提示内复制按钮阻止默认与冒泡，避免点复制顺带切换整卡折叠；守住位置：复制按钮 onClick；改错故障：复制报错文本时卡片同时收起，上下文跳走。
// INV-19 间距挂在动画内层：padding 放在正文内层容器而非高度动画节点上，随 overflow 连续裁切；守住位置：CollapsibleContent 内层 div；改错故障：收起末尾残留 8px 空白再瞬间消失，出现抖动。
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ToolSummaryRow, type ToolSummaryAction } from "@/ToolCallBlocks/ToolSummaryRow.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

// 模块级 Map 是展开态的唯一持久点：不随组件卸载清空，也不进入 React 状态树；守住位置：此表声明；改错故障：会话切换后所有卡片回落到收起，看起来像丢失记忆。
// 键为 persistOpenKey 或 toolId，长度无上界，因此需要内存诊断登记；守住位置：下方 registry 注册；改错故障：长会话里展开记录持续累积却无人可见。
// 表内容只由展开交互与自动收敛写入，不做外部同步，避免与 React 状态形成双写回路；守住位置：全部写入点；改错故障：两侧状态分叉，UI 与实际记录长期不一致。
const toolLayoutOpenState = new Map<string, boolean>();
// 内存诊断计数器：该表按 toolId 只增不减，先落日志。
uiMemoryDiagnosticsRegistry.register("toolLayout", () => ({ openState: toolLayoutOpenState.size }));
// 常量 300ms 是对齐 Radix 关闭动画的测量窗口，短于此值正文会先被摘掉；守住位置：卸载计时器；改错故障：详情收起时高度归零过早，出现空白块闪烁。
// 两个类名常量把外壳与间距拆开：外壳管焦点轮廓与前景色，间距必须留在动画内层；守住位置：TOOL_CONTENT_SPACING_CLASSNAME 的使用处；改错故障：间距被并入高度动画节点，收起末尾残留固定留白。
const TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;
const TOOL_CONTENT_SHELL_CLASSNAME = "text-popover-foreground outline-none";
const TOOL_CONTENT_SPACING_CLASSNAME = "pt-2";

// Props 是受控与非受控的显式分界：缺省值让调用方只传文案即可用，展开能力按需打开；守住位置：本接口默认值；改错故障：新增卡片忘记传 canToggle，用户点标题无反应。
// persistOpenKey 与 toolId 分离，是为了让一张逻辑卡片在多次重渲染中沿用同一展开记忆；守住位置：persistOpenKey 可选字段；改错故障：同名工具的不同实例共享折叠态，互相干扰。
// 两组内容字段二选一：content 适合静态节点，renderContent 把求值推迟到展开，减少折叠卡片的渲染成本；守住位置：本接口后半段字段；改错故障：重内容在收起状态下仍被构造，列表滚动变慢。
// 可访问相关字段成组出现：showStatusLabel、showFailureStatus、statusTooltip 共同决定状态词是否渲染与是否带提示；守住位置：本接口状态段；改错故障：只有悬停文本没有词，失败原因永远读不到。
interface ToolLayoutProps {
  toolId: string;
  persistOpenKey?: string;
  icon: ReactNode;
  showIcon?: boolean;
  canToggle?: boolean;
  forceOpen?: boolean;
  autoOpen?: boolean;
  autoCollapseOnComplete?: boolean;
  kindLabel: ReactNode;
  expandedKindLabel?: ReactNode;
  kindDetail?: ReactNode;
  expandedKindDetail?: ReactNode;
  sourceLabel?: ReactNode;
  primaryText: ReactNode;
  prioritizePrimaryText?: boolean;
  expandedPrimaryText?: ReactNode;
  secondaryText?: ReactNode;
  expandedSecondaryText?: ReactNode;
  summaryContentSeparator?: ReactNode;
  animateSummaryContent?: boolean;
  disableSummaryContentAnimation?: boolean;
  summaryContentKey?: string;
  summaryContentRefreshVersion?: string;
  hideSecondaryTextWhenOpen?: boolean;
  diffCount?: ReactNode;
  hideDiffCountWhenOpen?: boolean;
  statusLabel?: ReactNode;
  statusTooltip?: ReactNode;
  /**
   * 状态词之前的指示物（如编译反馈行的空环灯），与状态词同显同隐。放在提示触发区之外：
   * 虚线下划线与悬停提示只属于词，灯不该被划线，也不该成为另一个悬停目标。
   */
  statusIndicator?: ReactNode;
  showStatusLabel?: boolean;
  showFailureStatus?: boolean;
  isRunning?: boolean;
  title?: string;
  expandedTitle?: string;
  content?: ReactNode;
  renderContent?: () => ReactNode;
  summaryAction?: ToolSummaryAction;
}

// 入参全部解构并给出缺省，函数体内不再对可选值做二次判空；守住位置：参数列表；改错故障：某处忘记补缺省，布尔字段的 undefined 被当成真值。
// 组件只做投影与本地交互状态，不订阅服务、不发请求，保证流式更新时渲染代价可控；守住位置：函数体；改错故障：在卡片内取服务，导致每张卡片各自建立订阅。
// 解构默认值与 Props 可选声明必须成对维护，漏改任一侧都会让缺省失效；守住位置：参数列表；改错故障：调用方依赖的默认展开行为消失，卡片全部收起。
function ToolLayoutComponent({
  toolId,
  persistOpenKey,
  icon,
  showIcon = true,
  canToggle = true,
  forceOpen = false,
  autoOpen = false,
  autoCollapseOnComplete = false,
  kindLabel,
  expandedKindLabel,
  kindDetail,
  expandedKindDetail,
  sourceLabel,
  primaryText,
  prioritizePrimaryText = false,
  expandedPrimaryText,
  secondaryText,
  expandedSecondaryText,
  summaryContentSeparator,
  animateSummaryContent = false,
  disableSummaryContentAnimation = false,
  summaryContentKey,
  summaryContentRefreshVersion,
  hideSecondaryTextWhenOpen = false,
  diffCount,
  hideDiffCountWhenOpen = false,
  statusLabel,
  statusTooltip,
  statusIndicator,
  showStatusLabel = false,
  showFailureStatus = false,
  isRunning = false,
  title,
  expandedTitle,
  content,
  renderContent,
  summaryAction,
}: ToolLayoutProps) {
  const { intl } = useZCodeIntl();
  const resolvedPersistOpenKey = persistOpenKey ?? toolId;
  const [isOpen, setIsOpen] = useState(
    () => toolLayoutOpenState.get(resolvedPersistOpenKey) ?? false,
  );
  // 摘要操作存在即整卡让位给操作按钮，折叠能力整体关闭，这是一条贯穿全文件的前置开关；守住位置：本行；改错故障：操作行与折叠三角共存，点击行为互相抢占。
  // 用严格不等判断 undefined 而非真值判断，空字符串或零号动作仍算有操作；守住位置：本行；改错故障：编号为 0 的动作被当作没有操作，卡片突然可折叠。
  const hasSummaryAction = summaryAction !== undefined;
  // 展开判定是三层与：先排除摘要操作卡片，再看硬锁，最后才接受用户态；守住位置：本行；改错故障：带操作行的卡片被用户态误判为展开，露出空内容区。
  // canToggle 为假时用户态被忽略，卡片等同常驻收起；守住位置：本行后半段；改错故障：只读卡片出现可点击的折叠三角，点了没有反馈。
  // isExpanded 同时驱动内容渲染与摘要标签切换，任何一处另算一份都会导致标签与正文不同步；守住位置：本行下游全部引用；改错故障：标题显示展开版文案但正文仍是收起态。
  const isExpanded = !hasSummaryAction && (forceOpen || (canToggle && isOpen));
  const [shouldRenderContent, setShouldRenderContent] = useState(isExpanded);
  const [isFailureTooltipCopied, setIsFailureTooltipCopied] = useState(false);
  const failureTooltipCopyResetRef = useRef<number | null>(null);
  const contentUnmountDelayRef = useRef<number | null>(null);
  const hasAutoOpenedRef = useRef(false);
  const previousIsRunningRef = useRef(isRunning);
  const shouldShowStatusLabel = (showStatusLabel || showFailureStatus) && statusLabel != null;
  // 渲染窗口取展开态与延迟保留态的并集，保证关闭动画期间 children 仍挂着；守住位置：本行；改错故障：高度动画读取不到子内容高度，收起过程卡顿跳变。
  // 摘要操作卡片不渲染正文，即使调用方同时传了内容；守住位置：本行的前置取反；改错故障：纯操作行下方多出一块空白正文容器。
  const shouldRenderResolvedContent = !hasSummaryAction && (isExpanded || shouldRenderContent);
  const resolvedContent = shouldRenderResolvedContent
    ? (renderContent?.() ?? content ?? null)
    : null;
  // 主文案只在展开时替换为展开变体，未提供则沿用原值，避免展开后标题变空；守住位置：本行；改错故障：展开后主文案消失，卡片看起来像加载失败。
  // 这里的三元与摘要行属性一一对应，新增变体字段时必须同步两处；守住位置：本行与下方标签、细节三行；改错故障：新字段只在本层生效，摘要行仍显示旧值。
  const summaryPrimaryText =
    isExpanded && expandedPrimaryText != null ? expandedPrimaryText : primaryText;
  const summaryKindLabel = isExpanded && expandedKindLabel != null ? expandedKindLabel : kindLabel;
  const summaryKindDetail =
    isExpanded && expandedKindDetail !== undefined ? expandedKindDetail : kindDetail;
  const summarySecondaryText =
    isExpanded && expandedSecondaryText !== undefined
      ? expandedSecondaryText
      : isExpanded && hideSecondaryTextWhenOpen
        ? null
        : secondaryText;
  const summaryTitle = isExpanded && expandedTitle !== undefined ? expandedTitle : title;
  const resolvedSummaryContentKey =
    summaryContentKey ?? `${String(summaryTitle ?? "")}:${String(statusLabel ?? "")}`;
  const shouldShowDiffCount = diffCount != null && !(isExpanded && hideDiffCountWhenOpen);
  // toolcall 在流式期间数量多且持续更新，旋转 loading 图标会让
  // 动画长期占用渲染资源；运行态改由文案扫光和状态文字表达，图标保持静态。
  const summaryIcon = icon;
  // 运行态需要保留 kind 文案扫光，用来表达当前工具仍在进行中；
  // 非运行态仍保持最浅文本色，避免摘要信息喧宾夺主。
  // 运行态用扫光文本表达进行中，非运行态取最浅前景色，让状态词成为视觉焦点；守住位置：本行；改错故障：静态卡片也带扫光，用户误以为一直在跑。
  // 类名在渲染期现算，不进入样式缓存，代价是每次渲染都拼字符串，换来零状态维护；守住位置：本行；改错故障：把结果提到模块级后运行态不再跟随切换。
  const kindLabelClassName = cn(
    "font-medium whitespace-nowrap shrink-0",
    isRunning ? "animated-gradient-text" : "text-foreground-subtlest",
  );

  useEffect(() => {
    // 挂载与换键时都重新取表，未记录则视为收起，不沿用旧组件的本地状态；守住位置：本效果；改错故障：切换工具实例后沿用上一张卡片的展开态。
    // 此处只读取不写回，写入权留给用户交互与自动收敛，避免挂载即污染持久表；守住位置：本效果；改错故障：整表在滚动重挂载时被逐条改写为收起。
    // 依赖只含键，不含 isOpen，防止自身写状态触发再次同步形成回路；守住位置：依赖数组；改错故障：展开后立即被重置，卡片出现闪开闪收。
    const persistedOpen = toolLayoutOpenState.get(resolvedPersistOpenKey);
    setIsOpen(persistedOpen ?? false);
  }, [resolvedPersistOpenKey]);

  useEffect(() => {
    // edit/read 这类工具有“完成后默认自动展开”的需求，
    // 但 forceOpen 会把卡片彻底锁死成不可收起。
    // 这里改成一次性的 autoOpen：首次满足条件时自动展开一次，之后仍允许用户手动关闭。
    // 一次性语义由 ref 承载而非 state，避免重置渲染；守住位置：本早退；改错故障：改写成 state 后每次展开都追加一次渲染。
    // autoOpen 关闭时不得触碰持久表，否则会把用户手动的收起结果覆盖成展开；守住位置：本早退；改错故障：普通卡片首次挂载就被强制打开。
    // 自动展开要连写表、渲染标记与展开态三处，缺一都会出现表与 UI 不一致；守住位置：本分支后续三行；改错故障：刷新后回落到收起，但本次会话内看着是展开的。
    if (!autoOpen || hasAutoOpenedRef.current) {
      return;
    }

    toolLayoutOpenState.set(resolvedPersistOpenKey, true);
    setShouldRenderContent(true);
    setIsOpen(true);
    hasAutoOpenedRef.current = true;
  }, [autoOpen, resolvedPersistOpenKey]);

  useEffect(() => {
    const wasRunning = previousIsRunningRef.current;
    previousIsRunningRef.current = isRunning;

    // 子智能体在执行完成后，如果继续保持展开，会把一长串子工具明细永久摊开，
    // 聊天流里会迅速变得很长，也和“运行中自动展开、完成后回到摘要”这套交互不一致。
    // 这里只在 running -> completed 的边沿自动收起一次，不影响用户后续手动再次展开查看细节。
    // 判定必须同时含三个方向：开关打开、当前非运行、上一帧在运行；守住位置：本行；改错故障：静态卡片每次重渲染都被收起，用户展开后立刻弹回。
    // 收起同时写表与本地态，保证下次挂载读到的也是收起；守住位置：本分支内两次写入；改错故障：本轮收起但重新挂载又恢复展开。
    // 这里不重置 hasAutoOpenedRef，故同一实例不会因完成收起而再次自动展开；守住位置：本分支与 autoOpen 效果的配合；改错故障：完成收起后立刻被自动展开，形成抖动循环。
    if (autoCollapseOnComplete && !isRunning && wasRunning) {
      toolLayoutOpenState.set(resolvedPersistOpenKey, false);
      setIsOpen(false);
    }
  }, [autoCollapseOnComplete, isRunning, resolvedPersistOpenKey]);

  useEffect(() => {
    // 展开分支的首要职责是撤销挂起的卸载计时器，其次才是保证正文可渲染；守住位置：本分支；改错故障：展开瞬间被到点的旧计时器关掉正文。
    // 清计时器后必须把 ref 置空，否则后续判空失效，重复清同一句柄掩盖真实生命周期；守住位置：本分支结束处；改错故障：卸载逻辑误判仍有挂起任务，延迟被跳过。
    if (isExpanded) {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
      setShouldRenderContent(true);
      return;
    }

    if (!shouldRenderContent) {
      return;
    }

    // 收起工具详情时不能立刻卸载 children。
    // Radix 会在 closed 动画里读取 --radix-collapsible-content-height；
    // 如果子内容先被卸载，内层高度变量会消失并继承外层历史消息的高度，
    // 导致详情区域短暂撑成超高空白块，下面内容看起来像全部闪没了。
    // 进入此处的前提是已收起且正文曾经渲染，因此这是唯一需要延迟卸载的路径；守住位置：本行；改错故障：从未展开的卡片也排一次卸载，白占一个计时器。
    // 回调里先关状态再置空句柄，顺序反了会让清理分支误判任务仍在进行；守住位置：回调体；改错故障：连续折叠展开时正文停在不可见状态，再也渲染不出来。
    contentUnmountDelayRef.current = window.setTimeout(() => {
      setShouldRenderContent(false);
      contentUnmountDelayRef.current = null;
    }, TOOL_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);

    return () => {
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
        contentUnmountDelayRef.current = null;
      }
    };
  }, [isExpanded, shouldRenderContent]);

  useEffect(() => {
    return () => {
      if (failureTooltipCopyResetRef.current !== null) {
        window.clearTimeout(failureTooltipCopyResetRef.current);
      }
      if (contentUnmountDelayRef.current !== null) {
        window.clearTimeout(contentUnmountDelayRef.current);
      }
    };
  }, []);

  // 空串与非字符串一律不复制，避免把剪贴板写成空白覆盖用户已有内容；守住位置：本函数首段；改错故障：点击复制后剪贴板被清空。
  // 复制成功才亮对勾，失败分支不处理也不弹错，属于有意的静默降级；守住位置：promise 链；改错故障：无剪贴板权限时抛出未捕获的拒绝，控制台噪声不断。
  // 重置计时器每次先清旧再设新，支持连续点击；守住位置：本函数尾部；改错故障：第二次复制后对勾提前消失，用户以为没复制上。
  const handleCopyFailureTooltip = () => {
    if (typeof statusTooltip !== "string" || statusTooltip.trim().length === 0) {
      return;
    }

    navigator.clipboard.writeText(statusTooltip).then(() => {
      setIsFailureTooltipCopied(true);
      if (failureTooltipCopyResetRef.current !== null) {
        window.clearTimeout(failureTooltipCopyResetRef.current);
      }
      failureTooltipCopyResetRef.current = window.setTimeout(() => {
        setIsFailureTooltipCopied(false);
        failureTooltipCopyResetRef.current = null;
      }, 1500);
    });
  };

  // 状态词仅在 showStatusLabel 或 showFailureStatus 打开且确有文案时存在，其余情况为 null；守住位置：本三元的外层条件；改错故障：空状态位撑出间距，摘要行出现神秘留白。
  // 有提示时用虚线下划线与帮助光标标示可悬停，无提示时退化为普通文本，避免误导；守住位置：内层分支；改错故障：纯文本状态词带下划线，用户反复悬停无内容。
  // 提示内容截断到三行并可复制，长报错不撑破卡片宽度；守住位置：TooltipContent 结构；改错故障：超长堆栈把卡片撑到溢出，布局错位。
  const statusWordNode =
    shouldShowStatusLabel && statusLabel != null ? (
      statusTooltip ? (
        // 失败态不再强制展开内容，错误详情改挂到状态文字 tooltip 上，
        // 这样 edit 卡片保持和成功态一致的展开逻辑，同时仍然能在 hover 时拿到报错原因。
        // 提示层就近挂载，作用域只覆盖状态词，避免整卡被 Provider 包裹带来的额外上下文；守住位置：本行；改错故障：Provider 上移后同页多个提示共享延迟，交互变迟钝。
        // 复制按钮同时设置 title 与 aria-label，鼠标与读屏拿到同样的动作说明；守住位置：本块内按钮属性；改错故障：只有图标没有名称，读屏念出无名按钮。
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="whitespace-nowrap underline decoration-dotted underline-offset-2 cursor-help">
                {statusLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-96">
              <div className="flex max-w-96 items-center gap-2">
                <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {statusTooltip}
                </span>
                {typeof statusTooltip === "string" && statusTooltip.trim().length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-md"
                    className="shrink-0"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCopyFailureTooltip();
                    }}
                    title={intl.formatMessage({
                      id: isFailureTooltipCopied
                        ? "chat.toolCall.copyError.copied"
                        : "chat.toolCall.copyError",
                    })}
                    aria-label={intl.formatMessage({
                      id: isFailureTooltipCopied
                        ? "chat.toolCall.copyError.copied"
                        : "chat.toolCall.copyError",
                    })}
                  >
                    {isFailureTooltipCopied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </Button>
                ) : null}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span className="whitespace-nowrap">{statusLabel}</span>
      )
    ) : null;
  // 指示物与状态词共处一个内联容器，间距固定，任一缺失则直接退化为词本身；守住位置：本三元；改错故障：只剩指示物时出现悬空圆点。
  // 包裹层不设置下划线，确保提示交互只作用于词；守住位置：本行内 span 的类名；改错故障：悬停热区扩展到灯上，误触提示。
  const statusNode =
    statusWordNode !== null && statusIndicator != null ? (
      <span className="inline-flex shrink-0 items-center gap-1.5">
        {statusIndicator}
        {statusWordNode}
      </span>
    ) : (
      statusWordNode
    );

  return (
    <Collapsible
      open={!hasSummaryAction && (forceOpen || (canToggle && isOpen))}
      onOpenChange={(open) => {
        if (hasSummaryAction || forceOpen) {
          return;
        }
        toolLayoutOpenState.set(resolvedPersistOpenKey, open);
        if (open) {
          setShouldRenderContent(true);
        }
        setIsOpen(open);
      }}
      className="w-full flex flex-col"
    >
      <ToolSummaryRow
        action={summaryAction}
        animateContent={animateSummaryContent}
        canToggle={canToggle}
        contentKey={resolvedSummaryContentKey}
        contentRefreshVersion={summaryContentRefreshVersion}
        diffCount={shouldShowDiffCount ? diffCount : undefined}
        disableContentAnimation={disableSummaryContentAnimation}
        forceOpen={forceOpen}
        icon={summaryIcon}
        isExpanded={isExpanded}
        kindDetail={summaryKindDetail}
        kindLabel={summaryKindLabel}
        kindLabelClassName={kindLabelClassName}
        primaryText={summaryPrimaryText}
        prioritizePrimaryText={prioritizePrimaryText}
        secondaryText={summarySecondaryText}
        separator={summaryContentSeparator}
        showIcon={showIcon}
        sourceLabel={sourceLabel}
        statusNode={statusNode}
        title={summaryTitle}
        toggleAriaLabel={intl.formatMessage({
          id: isExpanded ? "chat.toolCall.collapseDetails" : "chat.toolCall.expandDetails",
        })}
        toolId={toolId}
      />
      {!hasSummaryAction && canToggle ? (
        // 可折叠分支只在无摘要操作且有折叠能力时出现，条件与 isExpanded 的判定保持同一套来源；守住位置：外层三元；改错故障：不可折叠卡片仍渲染内容容器，页面多出不可见高度。
        // 外壳类名负责前景色与焦点轮廓，不承担布局，布局交给内层间距节点；守住位置：本行 className；改错故障：把 padding 写回此处，收起末尾残留空白。
        // 内层 div 让 padding 随高度动画被裁切，因此不需要为间距额外等待卸载时机；守住位置：下一行内层容器；改错故障：间距与外层动画脱钩，收起出现两段式跳动。
        <CollapsibleContent className={TOOL_CONTENT_SHELL_CLASSNAME}>
          {/* padding 直接挂在高度动画节点上时，主体归零后仍会停在 8px，
              直到延迟卸载切换 display:none 才瞬间消失。放入内部后会被外层 overflow
              随动画高度连续裁切到 0，保留原间距且不改变 300ms 的测量保护。 */}
          <div className={TOOL_CONTENT_SPACING_CLASSNAME}>{resolvedContent}</div>
        </CollapsibleContent>
      ) : !hasSummaryAction && forceOpen ? (
        <div className={cn(TOOL_CONTENT_SHELL_CLASSNAME, TOOL_CONTENT_SPACING_CLASSNAME)}>
          {resolvedContent}
        </div>
      ) : null}
    </Collapsible>
  );
}

// memo 包裹的依据是入参多为稳定节点与字符串，父层高频重渲染时可跳过整棵卡片；守住位置：本导出；改错故障：去掉包裹后流式列表每帧重渲染全部卡片。
// 内联对象与箭头函数作为 props 会击穿 memo，调用方需自行稳定引用；守住位置：本导出与调用约定；改错故障：看似优化无效，滚动仍然掉帧。
// displayName 独立设置，保证调试与性能面板里能定位到具体组件而非匿名包装；守住位置：下一行；改错故障：React 树里显示为 Memo，排查时无法回溯来源。
export const ToolLayout = memo(ToolLayoutComponent);
ToolLayout.displayName = "ToolLayout";
