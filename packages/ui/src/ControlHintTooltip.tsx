// INV-01 触发元素直接合并 ref：守住位置 cloneElement；改错故障 SlotClone 渲染栈错误。
// INV-02 回调 ref 身份稳定：守住位置 useCallback 依赖；改错故障 每次渲染触发更新循环。
// INV-03 双 ref 同时转发：守住位置 setRef 两次；改错故障 外部拿不到触发器引用。
// INV-04 非元素子节点包 span：守住位置 三元分支；改错故障 文本触发器无法挂载。
// INV-05 有描述时改纵向布局：守住位置 description 判断；改错故障 标题与快捷键挤压。
// INV-06 无描述允许自然换行：守住位置 whitespace 类；改错故障 长文案被裁剪。
// INV-07 快捷键仅在无描述时下排：守住位置 条件渲染；改错故障 徽标重复出现。
// INV-08 共享 Provider 不逐项创建：守住位置 Root 级 Provider；改错故障 上下文树放大到消息数量级。
// INV-09 独立渲染按需补 Provider：守住位置 standalone 分支；改错故障 SSR 与单测缺少上下文。
// INV-10 侧栏统一延迟三百毫秒：守住位置 delayDuration；改错故障 连续划过跳过等待。
// INV-11 侧栏禁用悬停内容：守住位置 disableHoverableContent；改错故障 移动鼠标时提示闪烁。
// INV-12 侧栏范围用上下文标记：守住位置 SidebarTooltipContext；改错故障 其它页面行为被改变。
// INV-13 非侧栏原样透传插槽：守住位置 inSidebar 判断；改错故障 普通按钮丢失原生 title。
// INV-14 去掉原生 title 防重复：守住位置 cloneElement 覆盖；改错故障 原生提示与自定义提示叠加。
// INV-15 收缩场景不继承 shrink-0：守住位置 triggerClassName；改错故障 图标按钮撑开菜单行。
// INV-16 禁用元素外包一层 span：守住位置 disabled 分支；改错故障 禁用按钮无法触发提示。
// INV-17 提示内容单一出口：守住位置 tooltip 常量；改错故障 组合逻辑散落多处。
// INV-18 触发器类名与外部合并：守住位置 cn 调用；改错故障 业务自定义样式被覆盖。
//
// 模块职责：包装 Radix Tooltip，统一标题、描述、快捷键与侧栏延迟语义。
// 状态所有权：提示开关可由外部受控；其余为渲染期派生值。
// 阅读顺序：先看引用合并，再看主组件，最后看侧栏两个变体。
import { Slot } from "radix-ui";
import {
  cloneElement,
  createContext,
  useContext,
  type ReactElement,
  isValidElement,
  useCallback,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ControlShortcutBadge } from "@/ControlShortcutBadge.js";

interface ControlHintTooltipProps {
  children: ReactNode;
  title: ReactNode;
  description?: string;
  shortcut?: string;
  standalone?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: ComponentProps<typeof TooltipContent>["side"];
  align?: ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: ComponentProps<typeof TooltipContent>["sideOffset"];
  className?: string;
  triggerClassName?: string;
  triggerRef?: Ref<HTMLElement>;
}

type TriggerChildProps = {
  className?: string;
  ref?: Ref<HTMLElement>;
};

// ref 为空直接 return，不抛错。
// 函数型 Ref 以 ref(value) 形式调用。
// 对象引用写入 current。
// 不返回值。
function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

// 稳定回调 ref 身份。
// 合并 childRef 与 triggerRef 后一起写入。
// 共享 Provider 放在 Root。
// 独立渲染时才补 Provider。
export function ControlHintTooltip({
  children,
  title,
  description,
  shortcut,
  standalone = false,
  open,
  onOpenChange,
  side = "top",
  align = "center",
  sideOffset = 2,
  className,
  triggerClassName,
  triggerRef,
}: ControlHintTooltipProps) {
  const isTriggerElement = isValidElement<TriggerChildProps>(children);
  const childRef = isTriggerElement ? children.props.ref : undefined;
  // Radix Tooltip/Dropdown/Popper 的 asChild trigger 会在 ref 变化时同步 setState。
  // 这里必须稳定 callback ref 身份，否则每次 render 都会触发 ref detach/attach 并形成更新循环。
  const composedTriggerRef = useCallback(
    (value: HTMLElement | null) => {
      setRef(childRef, value);
      setRef(triggerRef, value);
    },
    [childRef, triggerRef],
  );
  const trigger = isTriggerElement ? (
    cloneElement(children, {
      // 以前额外包一层 span，Radix Tooltip/Select/Popover 多层 asChild 组合时，
      // 事件和 ref 会落到不同 DOM 上，触发 SlotClone 渲染栈错误。这里直接合到真实触发器。
      className: cn("shrink-0", children.props.className, triggerClassName),
      ref: composedTriggerRef,
    })
  ) : (
    <span
      ref={triggerRef as Ref<HTMLSpanElement>}
      className={cn("inline-flex shrink-0", triggerClassName)}
    >
      {children}
    </span>
  );

  // 大会话会为每条消息动作渲染大量 ControlHintTooltip，逐个创建 Provider
  // 会把 Radix 上下文树放大到消息数量级；共享 Provider 统一放在 Root。
  const tooltip = (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          description
            ? "max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-left"
            : "max-w-[min(28rem,calc(100vw-1rem))] items-center gap-2 px-2.5 py-1 text-left has-data-[slot=kbd]:pr-1",
          className,
        )}
      >
        {description ? (
          <div className="flex w-full items-start justify-between gap-3">
            <span className="text-ui-sm font-medium leading-4 text-tooltip-foreground">
              {title}
            </span>
            {shortcut ? <ControlShortcutBadge>{shortcut}</ControlShortcutBadge> : null}
          </div>
        ) : (
          // 无描述的提示过去同时受 max-w-xs 和 nowrap 约束，长中英文文案会越界裁剪。
          // 短提示继续按内容宽度展示，超过视口安全宽度时允许自然换行；显式换行用于结构化提示。
          <span className="text-ui-sm font-medium whitespace-pre-line break-words text-tooltip-foreground">
            {title}
          </span>
        )}
        {description ? (
          <span className="max-w-64 text-ui-sm/relaxed text-tooltip-foreground/80">
            {description}
          </span>
        ) : null}
        {!description && shortcut ? <ControlShortcutBadge>{shortcut}</ControlShortcutBadge> : null}
      </TooltipContent>
    </Tooltip>
  );

  // 少数组件需要支持脱离 Root 的 SSR/单测渲染；由封装按需补 Provider，
  // 避免业务层重新组合 Tooltip primitives，同时不让列表中的常规提示重复创建上下文。
  return standalone ? <TooltipProvider>{tooltip}</TooltipProvider> : tooltip;
}

const SidebarTooltipContext = createContext(false);

// SidebarTooltipProvider 统一 delayDuration={300}。
// skipDelayDuration={0}，连续划过仍要等满 300ms。
// disableHoverableContent 防止提示内容悬停时闪烁。
// SidebarTooltipContext 让子树知道自己在侧栏范围内。
export function SidebarTooltipProvider({ children }: { children: ReactNode }) {
  // 侧栏原先继承全局零延迟，且连续划过按钮会跳过等待；在边界统一配置，每个提示都等待 300ms。
  return (
    <SidebarTooltipContext.Provider value>
      <TooltipProvider
        delayDuration={300}
        skipDelayDuration={0}
        alwaysDelay
        disableHoverableContent
      >
        {children}
      </TooltipProvider>
    </SidebarTooltipContext.Provider>
  );
}

/** 原生 title 无法配置延迟；只在侧栏范围内替换，复用组件在其它页面的行为不变。 */
// 非侧栏直接返回 Slot.Root，不改 title 也不包 span。
// 去掉原生 title 防重复。
// 收缩场景不继承 shrink-0。
// 禁用元素外包一层 span。
export function SidebarNativeTooltip({
  children,
  ...triggerProps
}: Omit<ComponentProps<typeof Slot.Root>, "children"> & {
  children: ReactElement<{ title?: string; disabled?: boolean; className?: string }>;
}) {
  const inSidebar = useContext(SidebarTooltipContext);
  if (!inSidebar || !children.props.title)
    return <Slot.Root {...triggerProps}>{children}</Slot.Root>;
  const trigger = cloneElement(children, { title: undefined });
  return (
    <ControlHintTooltip
      title={children.props.title}
      // 原生标题所在元素可能需要收缩；不能继承图标按钮提示的 shrink-0。
      triggerClassName={cn("shrink", children.props.className)}
    >
      {/* 菜单/树行的 asChild 会把事件和 ref 注入这个适配层，必须通过 Slot 合并回真实触发器。 */}
      {children.props.disabled ? (
        <span className="block min-w-0">
          <Slot.Root {...triggerProps}>{trigger}</Slot.Root>
        </span>
      ) : (
        <Slot.Root {...triggerProps}>{trigger}</Slot.Root>
      )}
    </ControlHintTooltip>
  );
}
