// INV-01 分支优先级的守护点在 ToolSummaryRow 函数体第一个 if (action)：action 优先于 canToggle 与 forceOpen，命中即提前返回。若把 canToggle 判断上移，带动作的行会同时成为折叠触发器，一次点击既执行动作又切换展开，产生两套状态写入。
// INV-02 action 分支的返回树里刻意没有 ChevronRightIcon，守住的是 action return 的 div 内容。若为统一视觉补上箭头，用户会认为该行可展开，点击后却只触发动作，交互承诺与行为不符。
// INV-03 testId 的兜底表达式 action.testId ?? testId(TID_TOOL_SUMMARY_TRIGGER, toolId) 位于 action 分支的 data-testid。若去掉兜底，调用方未传 testId 时该行在 DOM 中失去稳定标识，依赖 toolId 定位的用例会集体失效。
// INV-04 键位白名单只认 "Enter" 与 " "，位置在 handleToolSummaryActionKeyDown 的首个条件。若改成 e.key === "Space" 或顺手加上方向键，标准键盘激活会失效，读屏用户按回车毫无反应。
// INV-05 返回 boolean 的语义在 handleToolSummaryActionKeyDown 末尾：命中才 return true。若恒返回 true，调用方会误判所有按键均已消费，从而吞掉 Tab 与空格滚动等默认行为。
// INV-06 preventDefault 必须落在键位判断之后，位置在 if 块内部。若提前到函数首行，非激活键也会被阻止默认行为，焦点移动与页面滚动同时失灵。
// INV-07 [并发] canToggle 分支的 onKeyDown 内联重写了键位判断，而不是复用 handleToolSummaryActionKeyDown。守住它是因为此处要触发展开而非执行 action。若图省重复用，回车会执行 action，展开能力彻底丢失。
// INV-08 canToggle 分支外层是 CollapsibleTrigger asChild 包裹的 div，而非满宽 button。若换成 button，摘要内嵌套的文件预览按钮会构成非法嵌套交互元素，点击冒泡还会误触发展开。
// INV-09 [失败路径] 内联 keydown 通过 currentTarget 上的 click 派发来触发折叠，位置在 preventDefault 之后。若改为直接翻转本地状态，就绕过了 Collapsible 的 open 所有权，aria-expanded 与面板可见性会不同步。
// INV-10 aria-expanded 必须绑定 isExpanded，位置在 canToggle 分支 div 的属性列表。若误绑 forceOpen，屏幕阅读器读到的展开态与用户实际看到的折叠态相反。
// INV-11 箭头可见性由 cn 的三段组合决定：isExpanded 给 rotate-90 opacity-100，forceOpen 补 opacity-100，默认 opacity-0 只在 group-hover 时浮现。若删掉 hover 兜底，触摸设备上完全没有可展开提示。
// INV-12 [权衡] forceOpen 只提升不透明度，不参与旋转也不参与展开判定，位置在 ChevronRightIcon 的 className 组合。若让它同时旋转，静态行会呈现已展开的箭头却没有对应面板。
// INV-13 [资源] hasSummaryContent 的四元组必须与 SummaryContent 实际渲染的节点全集一致，位置在 [primaryText, secondaryText, diffCount, statusNode] 的 some 判定。若新增了渲染节点却漏进数组，空行仍会渲染出容器。
// INV-14 无内容时必须 return null，位置在 if (!hasSummaryContent) 分支。若改成渲染空 div，标题行的 gap 会在「类别—空容器—箭头」之间计算两次，视觉上出现一块异常大的空白。
// INV-15 空值判定是 node != null && node !== false && node !== ""，位置在 some 的回调体内。若只判 null，调用方传空字符串或 false 时会留下零宽占位，把相邻文本挤开。
// INV-16 [事务] QueuedSummaryContent 的 enabled 是 animateContent && !isExpanded，位置在 SummaryContent 的 enabled 属性。若漏掉 !isExpanded，展开态仍播放打字动画，与新内容刷新叠加造成明显闪烁。
// INV-17 disableAnimation 与 enabled 分成两个属性各自透传，位置同在 QueuedSummaryContent 的入参。若把两者合并成一个开关，调用方就无法做到「展开态保留进场动画、同时禁用逐字刷新」。
// INV-18 kindLabel 的三重判空与窄屏隐藏共同守住 leading 区的宽度，位置在 SummaryLeadingContent 的 kindLabel 条件及 cn。若删掉 !== ""，空标签仍占位；若删掉 @max-[360px] 分支，窄屏下 primaryText 会被挤到换行。
//
// 模块职责：把一次工具调用的摘要渲染成「图标 + 类别 + 明细 + 来源 + 主次文本 + 状态」的单行，并依据 action / canToggle 决定该行是动作按钮、折叠触发器还是纯静态文本。
// 状态所有权：本文件不持有任何状态；展开态由外部 isExpanded 与 Collapsible 的 open 承接，动画开关由 animateContent / disableContentAnimation 传入，本组件只做投影与事件转发。
// 阅读顺序：先看 ToolSummaryAction 与 props 契约，再看键盘处理器，然后是两个子视图（leading 区、content 区），最后看 ToolSummaryRow 的三路分支与箭头可见性。
import type { KeyboardEvent, ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { testId, TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { QueuedSummaryContent } from "@/ToolCallBlocks/QueuedSummaryContent.js";

// 动作契约只有三项：ariaLabel 供读屏朗读，onActivate 是无参回调，testId 可选用于覆盖默认定位。
// onActivate 的签名不带事件对象，说明动作执行方不关心点击来源，键盘与鼠标共用同一入口。
// ariaLabel 是必填而非可选，防止调用方漏传后出现无名称按钮；新增字段时保持必填优先。
// 该接口只描述「有动作」的行，不代表该行可展开；可展开性由 canToggle 独立表达。
// 两者同时为真时以 action 优先，这个取舍写在 ToolSummaryRow 的分支顺序里。
export interface ToolSummaryAction {
  ariaLabel: string;
  onActivate: () => void;
  testId?: string;
}

// 这是唯一的键盘归一化出口，导出是为了让外层容器复用同一套 Enter / 空格语义。
// 参数用 Pick 只取 key 与 preventDefault，避免绑定具体事件类型，便于在合成事件与原生事件间复用。
// 返回值语义是「是否已消费该按键」，调用方据此决定要不要继续处理。
// 命中后先阻止默认行为再执行回调，顺序不能颠倒，否则空格可能先触发滚动。
// 未命中时直接返回 false 且不触碰事件，保证 Tab 与方向键的原生行为完全保留。
export function handleToolSummaryActionKeyDown(
  event: Pick<KeyboardEvent<HTMLDivElement>, "key" | "preventDefault">,
  onActivate: () => void,
): boolean {
  if (event.key !== "Enter" && event.key !== " ") {
    return false;
  }

  event.preventDefault();
  onActivate();
  return true;
}

// props 分成四组：布局开关（showIcon、prioritizePrimaryText、forceOpen）、内容片段（icon、kindLabel、kindDetail、primaryText、secondaryText、separator、diffCount、statusNode）、内容身份（contentKey、contentRefreshVersion）、交互（action、canToggle、isExpanded、toggleAriaLabel）。
// contentKey 是必填，说明摘要内容必须能被稳定标识，否则 QueuedSummaryContent 无法判断是否需要重播动画。
// contentRefreshVersion 是可选的刷新版本号，用于在 key 不变但内容重算时触发一次受控刷新。
// showIcon 与 kindLabelClassName 均为必填，表示调用方必须显式决定图标可见性与类别样式，不提供默认外观。
// forceOpen 只作用于箭头不透明度，不参与任何展开计算，命名容易误解为强制展开。
// prioritizePrimaryText 同时影响 leading 区窄屏隐藏与 content 区 flex-1 溢出策略，是同一意图的两处落点。
interface ToolSummaryRowProps {
  action?: ToolSummaryAction;
  animateContent: boolean;
  canToggle: boolean;
  contentKey: string;
  contentRefreshVersion?: string;
  diffCount?: ReactNode;
  disableContentAnimation: boolean;
  forceOpen: boolean;
  icon: ReactNode;
  isExpanded: boolean;
  kindDetail?: ReactNode;
  kindLabel: ReactNode;
  kindLabelClassName: string;
  primaryText: ReactNode;
  prioritizePrimaryText?: boolean;
  secondaryText?: ReactNode;
  separator?: ReactNode;
  showIcon: boolean;
  sourceLabel?: ReactNode;
  statusNode?: ReactNode;
  title?: string;
  toggleAriaLabel: string;
  toolId: string;
}

// leading 区只负责「谁在左边」，按固定顺序渲染图标、类别标签、类别明细、来源标签。
// 图标用 showIcon 控制而非 icon 是否为空，允许调用方先占位后补图标，避免布局跳动。
// 类别标签的条件是三重判空，任一为真即不渲染，因此空字符串与 false 都不会留下空节点。
// 类别明细用真值判断，空字符串同样被排除，但它不像标签那样支持 false 这种「明确不要」的语义。
// 来源标签带边框与底色，是四个片段里唯一有独立视觉容器的元素。
// prioritizePrimaryText 为真时，类别标签与来源标签在 360px 以下一起隐藏，只保留图标、明细与主文本。
// 隐藏靠 CSS 断点而非条件渲染，因此辅助技术在这些宽度下仍能读到被隐藏的标签文本。
function SummaryLeadingContent({
  icon,
  kindDetail,
  kindLabel,
  kindLabelClassName,
  showIcon,
  sourceLabel,
  prioritizePrimaryText,
}: Pick<
  ToolSummaryRowProps,
  | "icon"
  | "kindDetail"
  | "kindLabel"
  | "kindLabelClassName"
  | "prioritizePrimaryText"
  | "showIcon"
  | "sourceLabel"
>) {
  return (
    <>
      {showIcon ? (
        <span className="shrink-0 text-foreground-subtlest [&_svg]:text-foreground-subtlest">
          {icon}
        </span>
      ) : null}
      {kindLabel != null && kindLabel !== false && kindLabel !== "" ? (
        <span
          className={cn(
            "tool-summary-kind-label",
            kindLabelClassName,
            prioritizePrimaryText && "@max-[360px]/conversation:hidden",
          )}
        >
          {kindLabel}
        </span>
      ) : null}
      {kindDetail ? <span className="min-w-0 shrink-0">{kindDetail}</span> : null}
      {sourceLabel ? (
        <span
          className={cn(
            "shrink-0 rounded border border-border bg-background-alt px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest",
            prioritizePrimaryText && "@max-[360px]/conversation:hidden",
          )}
        >
          {sourceLabel}
        </span>
      ) : null}
    </>
  );
}

// content 区承担「右边说什么」，顺序是分隔符、排队内容、状态节点。
// 分隔符只在非 null 时出现，不参与空内容判定，单独传分隔符不会让整行变成有内容。
// QueuedSummaryContent 承接主文本、次文本与 diffCount，把动画与排队逻辑收敛到子组件。
// statusNode 直接透传渲染，不做包装，调用方需自行保证其尺寸与对齐。
// 容器带 min-w-0 与 max-w-full，保证长文本在 flex 行内可收缩而不是撑破整行。
// prioritizePrimaryText 为真时容器改为 flex-1 加 overflow-hidden，让主文本优先占满并裁掉溢出。
// 空内容提前返回 null 的判断放在本函数开头，先于任何 DOM 产出。
function SummaryContent({
  animateContent,
  contentKey,
  contentRefreshVersion,
  diffCount,
  disableContentAnimation,
  isExpanded,
  primaryText,
  prioritizePrimaryText,
  secondaryText,
  separator,
  statusNode,
}: Pick<
  ToolSummaryRowProps,
  | "animateContent"
  | "contentKey"
  | "contentRefreshVersion"
  | "diffCount"
  | "disableContentAnimation"
  | "isExpanded"
  | "primaryText"
  | "prioritizePrimaryText"
  | "secondaryText"
  | "separator"
  | "statusNode"
>) {
  // 这里用数组加 some 做「是否有可见内容」的统一判定，四个节点即全部渲染来源。
  // 判定口径与渲染口径必须同步：新增任何直接渲染的节点都要同时进入这个数组。
  // separator 被刻意排除在数组外，因为它只是修饰，不应把空行变成有内容。
  // 回调内同时排除 null、false 与空字符串，对应 React 三种「什么都不画」的写法。
  // 判定为假时整块不渲染，这是避免标题行 gap 重复计算的关键，不是单纯的性能优化。
  // 若将来需要支持数字 0 作为合法内容，必须显式放宽判定，现口径会把 0 当成无内容。
  const hasSummaryContent = [primaryText, secondaryText, diffCount, statusNode].some(
    (node) => node != null && node !== false && node !== "",
  );

  // 展开态可能主动清空摘要，但渲染空 flex 容器的话，标题行的 gap
  // 会在“类别—空容器—箭头”之间计算两次，视觉上形成一块异常大的空白。
  if (!hasSummaryContent) {
    return null;
  }

  return (
    <div
      className={cn(
        "tool-summary-content min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest",
        prioritizePrimaryText && "flex-1 overflow-hidden",
      )}
    >
      {separator != null ? (
        <span className="shrink-0 text-foreground-subtlest">{separator}</span>
      ) : null}
      <QueuedSummaryContent
        contentKey={contentKey}
        contentRefreshVersion={contentRefreshVersion}
        primaryText={primaryText}
        secondaryText={secondaryText}
        trailingText={diffCount}
        enabled={animateContent && !isExpanded}
        disableAnimation={disableContentAnimation}
      />
      {statusNode}
    </div>
  );
}

// 组件先解构出 action、canToggle、forceOpen、isExpanded、title、toggleAriaLabel、toolId 七个交互相关字段。
// sharedContent 把 leading 与 content 打包复用，保证三条分支的左侧内容完全一致。
// 三路分支的顺序即优先级：有 action 走动作行，否则可折叠走触发器，否则退化为静态行。
// 动作行与触发器共用同一串 className，唯独静态行把 cursor-pointer 换成 cursor-default 并占满宽度。
// 静态行没有 role、tabIndex 与键盘处理，因为它不可交互，补上反而会制造假的焦点停靠点。
// 折叠触发器自身不传 onClick，展开由 Collapsible 上下文驱动，避免出现第二处状态写入。
export function ToolSummaryRow(props: ToolSummaryRowProps) {
  const { action, canToggle, forceOpen, isExpanded, title, toggleAriaLabel, toolId } = props;
  const sharedContent = (
    <>
      <SummaryLeadingContent {...props} />
      <SummaryContent {...props} />
    </>
  );

  if (action) {
    return (
      <div
        data-testid={action.testId ?? testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
        role="button"
        tabIndex={0}
        aria-label={action.ariaLabel}
        onClick={action.onActivate}
        onKeyDown={(event) => handleToolSummaryActionKeyDown(event, action.onActivate)}
        className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        title={title}
      >
        {sharedContent}
      </div>
    );
  }

  if (canToggle) {
    return (
      <CollapsibleTrigger asChild>
        <div
          data-testid={testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          aria-label={toggleAriaLabel}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }

            // 摘要内可能包含文件预览按钮，因此不能用满宽 button 包裹整行。
            // 保留 div trigger，并在这里补齐 Enter/Space 的展开能力。
            event.preventDefault();
            event.currentTarget.click();
          }}
          className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          title={title}
        >
          {sharedContent}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 text-foreground-subtlest opacity-0 transition-transform transition-opacity duration-200 ease-out will-change-transform group-hover/tool-summary:opacity-100 shrink-0",
              isExpanded ? "rotate-90 opacity-100" : "rotate-0",
              forceOpen && "opacity-100",
            )}
          />
        </div>
      </CollapsibleTrigger>
    );
  }

  return (
    <div
      data-testid={testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
      className="group/tool-summary cursor-default flex w-full items-center gap-2 text-left text-ui-base transition-colors focus-visible:outline-none"
      title={title}
    >
      {sharedContent}
    </div>
  );
}
