// ConversationDraftSuggestedPrompts —— New task 草稿页推荐提示词入口，chips / list 双形态共用一套数据。
// 数据来源：上层把 Client Scenes 的 draft-suggestion scene 映射成 DraftSuggestedPromptItem 后下发。
// 本组件不发起网络请求、不解析 prompt、不读写 Plugin catalog，只负责渲染、回调与浮层呈现。
//
// 不可变约束 INV-01..INV-20：每条都标注守护点，以及改动后会出现的具体故障。
// INV-01 items 为空必须早退返回 null：守护点 items.length === 0 的提前 return。
//         若改为渲染空容器，上层会多出占位高度，list 形态还会出现只有标题和刷新按钮的空分区。
// INV-02 两种形态的根节点都带 data-v4-draft-suggested-prompts：两处 div 各自守护。
//         移除属性会让 e2e 与埋点选择器同时失配，测试拿不到根节点只能按文案匹配。
// INV-03 chips 形态每个推荐项从首帧起就包在 Popover 内：map 内结构固定，不按需挂载。
//         若改成打开时才包 Root/Anchor，按钮会重挂并重播 waterfall，Radix 会量到带位移的锚点。
// INV-04 两处 Popover 都显式 modal={false}：避免浮层抢焦点与锁滚动。
//         改成模态后用户无法在草稿输入框与浮层之间往返，连续重试场景直接不可用。
// INV-05 浮层开关只有一个真源 pluginActionPopover.anchorItemId，组件内不另存 open 状态。
//         若本地再存一份，快速连点时两份状态会分叉，浮层与高亮项错位。
// INV-06 仅当 anchorItemId 命中 item.id 才渲染浮层内容：由条件渲染守护。
//         提前渲染会把 progress / success 文案挂到错误的推荐项下。
// INV-07 disabled 只影响交互不影响渲染：按钮 disabled 由 !onSelect || disabled 计算。
//         若禁用时不渲染，列表高度会塌陷，切换可用性时出现骨架跳动。
// INV-08 刷新与关闭共用 disabled || refreshDisabled：两处 Button 各自校验。
//         只改一处会出现刷新可用而关闭不可用的不可解释差异。
// INV-09 关闭必须二次确认：X 仅 setConfirmClose(true)，onClose 只在 AlertDialogAction 触发。
//         改成直接关闭会丢弃当前推荐上下文且不可撤销。
// INV-10 所有可见文案经 intl.formatMessage 输出，组件内不硬编码中文。
//         绕过它会让未翻译语言显示键名，并失去 locale 切换时的重渲染。
// INV-11 推荐项标题统一走 resolveDraftSuggestedPromptText(label, locale)：两处渲染点一致。
//         直接读 item.label 会拿到未本地化对象，界面上出现 [object Object]。
// INV-12 chips 按钮必须同时有 aria-label 与 title：移动端截断后仍可被读屏与悬停识别。
//         去掉任一个，max-w-64 截断后的长文案就彻底不可读。
// INV-13 入场延迟按 index * 65ms 递增并写入 CSS 变量，不写内联 animation-delay。
//         改成固定值会让所有 chips 同时入场，观感像整块闪烁。
// INV-14 动画必须尊重 reduced motion：useReducedMotion 与 motion-reduce: 类双重守护。
//         少任何一处都会在系统关闭动画时仍产生位移，触发无障碍回归。
// INV-15 纵向滚动切换只由 phase === "success" 的 key 触发，其余阶段共用 steady key。
//         若每个阶段换 key，确认→进度→失败会连续重播，界面看起来在抖动。
// INV-16 浮层打开与关闭都阻止自动对焦：两处 AutoFocus 回调都 preventDefault。
//         放开会让焦点跳回锚点，草稿输入框光标位置丢失。
// INV-17 外部点击只在确认态、有 onDismiss、且主键按下时放行：由 onPointerDownOutside 判定。
//         条件放宽会误关结果态，收窄则确认态点不出去。
// INV-18 浮层内 Escape 一律吞掉：onEscapeKeyDown 阻止默认行为，避免进度态被误取消。
// INV-19 GitHub 图标单独缩小到 size-4.5：按 iconUrl 是否含 /github/icon.png 判定。
//         统一尺寸时该素材自带白底会撑满容器，与其他图标视觉不一致。
// INV-20 浮层宽度固定 w-60、高度 h-auto：确认态若改回固定高度会裁切换行的 Plugin 名称。
// 维护建议：以上约束彼此耦合，改动任一条件渲染或 Popover 属性前先核对对应 INV 编号。
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog.js";
/* New task 草稿页推荐提示词入口。
   推荐配置来自 Client Scenes 的 draft-suggestion scene。 */
import type { CSSProperties } from "react";
import { X, Check, Info, LoaderCircle, SquareCode, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveDraftSuggestedPromptText,
  type DraftSuggestedPromptItem,
} from "@/v4/draftSuggestedPromptItems.js";
import type { DraftSuggestedPluginActionPopoverState } from "@/v4/useDraftSuggestedPluginActionPopover.js";

// 类型再导出让使用方只依赖本组件的公开入口，不必直接引用 draftSuggestedPromptItems 内部模块。
// DraftSuggestedPromptItem 是纯数据契约：字段变化属于上层映射层的事，本文件只消费不扩写。
// 若删掉这行再导出，消费方的沿路径导入会穿透到实现文件，后续拆分模块时编译期直接断裂。
export type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

// [资源] 过渡参数提成模块级常量，保证每次渲染复用同一对象引用。
// 若把它写进 JSX 属性，motion 每次渲染都收到新对象，会重新起算过渡并触发多余的重排。
// 时长 0.2s 与三段贝塞尔共同决定滚动节奏，单独调 duration 会让进出场不同步。
const PLUGIN_SUCCESS_ROLL_TRANSITION = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1],
} as const;

// 图标名来自 scene 配置，可能缺失或不在 Lucide 集合内，因此必须给 fallback。
// fallback 固定为 SquareCode 且同样 aria-hidden，避免装饰性图标被读屏当正文朗读。
// aria-hidden 不能删：按钮本身已有 aria-label，重复朗读图标名会让可访问名称变长。
function DraftSuggestedPromptIcon({ name }: { name?: string }) {
  return (
    <ClientSceneLucideIcon
      name={name}
      aria-hidden="true"
      className="size-4"
      strokeWidth={2}
      fallback={<SquareCode aria-hidden="true" className="size-4" strokeWidth={2} />}
    />
  );
}

// 所有 props 都是可选的：组件既能在列表里独立使用，也能被上层用最小参数挂载。
// layout 默认 chips、items 默认空数组，二者共同决定首次渲染走哪个分支。
// onSelect 缺失时按钮呈禁用态而不是隐藏，保证两条分支的 DOM 结构稳定、快照不抖动。
interface ConversationDraftSuggestedPromptsProps {
  className?: string;
  layout?: "chips" | "list";
  /** 推荐项列表；由上层从 Client Scenes 映射后下发。 */
  items?: DraftSuggestedPromptItem[];
  /** 点击回调；完整配置交给上层解析 prompt 与 Plugin catalog。 */
  onSelect?: (item: DraftSuggestedPromptItem) => void;
  disabled?: boolean;
  onRefresh?: () => void;
  onClose?: () => void;
  refreshDisabled?: boolean;
  pluginActionPopover?: DraftSuggestedPluginActionPopoverState | null;
}

// 浮层内容是纯展示组件：状态机在 useDraftSuggestedPluginActionPopover 里推进，这里只读 phase。
// 入参 state 同时携带文案、动作标签与回调，组件内部不推导业务含义，接受什么就渲染什么。
// 若在这里加本地状态做动画编排，会和上游 phase 变化产生两份时序，成功态可能被旧值覆盖。
function DraftSuggestedPluginActionPopoverContent({
  state,
}: {
  state: DraftSuggestedPluginActionPopoverState;
}) {
  // 确认态是全组件唯一的分叉依据，抽成局部布尔值保证三处判断语义完全一致。
  // 三处分别是内部结构 gap、动作按钮显隐与外部点击放行条件，任一处改判定都会破坏一致性。
  // 若把 phase 直接散落到各分支比较，新增阶段时容易漏改其中一处，出现按钮与布局不同步。
  const isConfirmation = state.phase === "confirmation";
  const reducedMotion = useReducedMotion();
  // [失败路径] phase 到图标的映射是穷尽式的：progress、success、error 各有专属图标。
  // 最后的 else 落到 Info，用来兜底确认态与未来新增阶段，保证任何 phase 都有可视反馈。
  // error 分支用 TriangleAlert 配 text-warning，颜色与形状双通道提示，避免只靠颜色传达失败。
  const statusIcon =
    state.phase === "progress" ? (
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin text-foreground-subtle motion-reduce:animate-none"
      />
    ) : state.phase === "success" ? (
      <Check
        aria-hidden="true"
        data-draft-suggested-plugin-success-icon="true"
        className="size-4 shrink-0 text-foreground"
      />
    ) : state.phase === "error" ? (
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
    ) : (
      <Info aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
    );
  const statusContent = (
    <>
      {statusIcon}
      <div
        data-draft-suggested-plugin-popover-message="true"
        className="min-w-0 flex-1 text-ui-base leading-4.5 text-foreground"
      >
        {state.message}
      </div>
    </>
  );

  return (
    // [并发] 浮层固定从下方展开并预留 16px 碰撞边距，避免贴边时被视口裁切或压住锚点。
    // 四个焦点与键盘回调都阻止默认行为：浮层是状态展示，不应夺走草稿输入框的焦点。
    // 若允许默认聚焦，打开瞬间焦点会移入浮层，用户继续输入时字符会丢进错误的目标。
    <PopoverContent
      side="bottom"
      align="center"
      sideOffset={6}
      collisionPadding={16}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => event.preventDefault()}
      onFocusOutside={(event) => event.preventDefault()}
      // [并发] 外部点击用 pointerdown 而不是 click 判定，避免按下与抬起落在不同元素时误放行。
      // 只有确认态、存在 onDismiss、且按的是主键三条件同时成立才真正关闭浮层。
      // 其余情况一律 preventDefault：进度与结果态需要用户读完后自行离开，不能被一次误触清掉。
      onPointerDownOutside={(event) => {
        const isPrimaryPointer = event.detail.originalEvent.button === 0;
        if (!isConfirmation || !state.onDismiss || !isPrimaryPointer) {
          event.preventDefault();
          return;
        }
        state.onDismiss();
      }}
      data-draft-suggested-plugin-popover={state.phase}
      data-draft-suggested-plugin-popover-offset="9"
      data-anchor-item-id={state.anchorItemId}
      className={cn(
        // 固定 80px 确认态只容得下一行标题，较长的本地化 Plugin 名称换行后会把按钮挤出并被裁切。
        "h-auto w-60 max-w-[calc(100vw-2rem)] border-popover-border bg-popover p-3 shadow-md",
        isConfirmation ? "gap-3" : "gap-0",
      )}
    >
      {/* Plugin 名称、状态和按钮不压进同一横排、不从锚点上方展开：遵循设计稿的确认/结果两种结构。 */}
      <div
        role={state.phase === "error" ? "alert" : "status"}
        aria-live={state.phase === "error" ? "assertive" : "polite"}
        data-draft-suggested-plugin-status-viewport="true"
        className="relative min-w-0 overflow-hidden"
      >
        {reducedMotion ? (
          <div
            data-draft-suggested-plugin-success-content={
              state.phase === "success" ? "true" : undefined
            }
            className="flex min-w-0 items-center gap-1.5"
          >
            {statusContent}
          </div>
        ) : (
          // 旧 CSS rotateX 只让成功内容自身翻入，无法像模型标签一样表达“进度被成功替换”。
          // steady key 覆盖确认、进度、失败和重试，仅在进入成功态时触发一出一入的纵向滚动。
          // [事务] key 只在 success 与 steady 之间切换：确认、进度、失败共用 steady，故不重播滚动。
          // mode="popLayout" 让旧内容先退出再让位，容器高度在切换瞬间不塌陷，锚点定位不跳。
          // initial={false} 抑制首次挂载动画，否则每次打开浮层都会先播一遍入场滚动。
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={state.phase === "success" ? "success" : "steady"}
              data-draft-suggested-plugin-success-content={
                state.phase === "success" ? "true" : undefined
              }
              className="flex min-w-0 items-center gap-1.5"
              initial={{ y: "0.75em", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "-0.75em", opacity: 0 }}
              transition={PLUGIN_SUCCESS_ROLL_TRANSITION}
            >
              {statusContent}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      {isConfirmation && state.actionLabel && state.onAction ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="self-end"
          onClick={state.onAction}
        >
          {state.actionLabel}
        </Button>
      ) : null}
    </PopoverContent>
  );
}

export function ConversationDraftSuggestedPrompts({
  className,
  layout = "chips",
  items = [],
  onSelect,
  disabled = false,
  onRefresh,
  onClose,
  refreshDisabled = false,
  pluginActionPopover,
}: ConversationDraftSuggestedPromptsProps) {
  const { locale, intl } = useZCodeIntl();
  const [confirmClose, setConfirmClose] = useState(false);

  if (items.length === 0) return null;

  if (layout === "list") {
    return (
      <div
        data-v4-draft-suggested-prompts="true"
        className={cn("w-full min-w-0 px-2 py-4", className)}
      >
        <div className="flex items-center justify-between gap-2 px-3 pb-2 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "occupationOnboarding.suggestionsHeading" })}</span>
          <div className="flex shrink-0 items-center gap-2">
            {onRefresh ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0 text-ui-sm text-foreground-subtle"
                disabled={disabled || refreshDisabled}
                onClick={onRefresh}
              >
                {intl.formatMessage({ id: "chat.officeSuggestions.refresh" })}
              </Button>
            ) : null}
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled || refreshDisabled}
                aria-label={intl.formatMessage({ id: "chat.officeSuggestions.closeTitle" })}
                onClick={() => setConfirmClose(true)}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {intl.formatMessage({ id: "chat.officeSuggestions.closeTitle" })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {intl.formatMessage({ id: "chat.officeSuggestions.closeDescription" })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
              <AlertDialogAction onClick={onClose}>
                {intl.formatMessage({ id: "common.confirm" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map((item) => (
            <Popover
              key={item.id}
              open={pluginActionPopover?.anchorItemId === item.id}
              modal={false}
            >
              <li>
                <PopoverAnchor asChild>
                  <button
                    type="button"
                    data-draft-suggested-prompt={item.id}
                    disabled={!onSelect || disabled}
                    onClick={() => onSelect?.(item)}
                    className="flex w-full items-center gap-3 rounded-xl p-3 text-left text-ui-base text-foreground hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:opacity-50"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface p-px">
                      <img
                        src={item.iconUrl}
                        alt=""
                        draggable={false}
                        className={cn(
                          "shrink-0 rounded-sm object-contain",
                          // GitHub 素材自带白色方形底，再缩小一圈以露出与其他图标一致的外层留白。
                          // [权衡] 通过 iconUrl 是否含 /github/icon.png 识别 GitHub 素材，属于对上游资源命名的约定。
                          // 该素材自带白色方形底，缩到 size-4.5 才能露出与其他图标一致的外层留白。
                          // 若统一用 size-full，白底会撑满容器；若改判定条件，需同步所有 scene 的图标地址。
                          item.iconUrl?.includes("/github/icon.png") ? "size-4.5" : "size-full",
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      {resolveDraftSuggestedPromptText(item.label, locale)}
                    </span>
                  </button>
                </PopoverAnchor>
                {pluginActionPopover?.anchorItemId === item.id ? (
                  <DraftSuggestedPluginActionPopoverContent state={pluginActionPopover} />
                ) : null}
              </li>
            </Popover>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      data-v4-draft-suggested-prompts="true"
      className={cn(
        "w-full min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <div
        data-v4-draft-suggested-prompts-group="true"
        className="mx-auto flex w-max items-center gap-4"
      >
        {items.map((item, index) => {
          const label = resolveDraftSuggestedPromptText(item.label, locale);
          // [并发] 锚点命中判定每帧由 props 重新推导，组件内不缓存，避免浮层与高亮项出现两份状态。
          // isPopoverAnchor 同时驱动 Popover 的 open、锚点 data 属性与浮层内容渲染，三处必须同源。
          // 若缓存到 state 并在 effect 里同步，会多出一帧不一致，浮层可能在旧锚点上闪一次。
          const isPopoverAnchor = pluginActionPopover?.anchorItemId === item.id;
          return (
            <Popover key={item.id} open={isPopoverAnchor} modal={false}>
              {/* 只在 Popover 打开时才包 Root/Anchor 会重挂按钮并重播 waterfall，
                  Radix 因而连续测量到带 translateY 的锚点。所有推荐项从首次渲染起保持同一结构。 */}
              <PopoverAnchor
                asChild
                data-slot="button"
                data-draft-suggested-plugin-popover-anchor={isPopoverAnchor ? "true" : undefined}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  data-draft-suggested-prompt={item.id}
                  aria-label={label}
                  title={label}
                  disabled={!onSelect || disabled}
                  onClick={onSelect ? () => onSelect(item) : undefined}
                  className="zcode-draft-prompt-waterfall h-8 min-w-0 justify-start gap-1.5 overflow-hidden rounded-lg px-3 text-left text-ui-caption font-normal leading-4.5 text-foreground"
                  style={
                    {
                      // [权衡] 入场延迟按 index 线性递增 65ms，纯函数式推导，刷新后顺序变化会自然重排节奏。
                      // 延迟写进自定义 CSS 变量而不是内联 animation-delay，样式侧可统一消费且不触发额外样式失效。
                      // 若改成随机或固定值，失去瀑布层次感，或让首屏几十个 chips 同时出现造成闪烁。
                      "--zcode-draft-prompt-waterfall-delay": `${index * 65}ms`,
                    } as CSSProperties
                  }
                >
                  <span
                    data-draft-suggested-prompt-icon="true"
                    className="flex size-4 shrink-0 items-center justify-center text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
                  >
                    <DraftSuggestedPromptIcon name={item.iconName} />
                  </span>
                  <span
                    data-draft-suggested-prompt-text="true"
                    className="min-w-0 max-w-64 truncate text-ui-base text-foreground opacity-70 transition-opacity group-hover/button:opacity-100 motion-reduce:transition-none"
                  >
                    {label}
                  </span>
                </Button>
              </PopoverAnchor>
              {isPopoverAnchor ? (
                <DraftSuggestedPluginActionPopoverContent state={pluginActionPopover} />
              ) : null}
            </Popover>
          );
        })}
      </div>
    </div>
  );
}
