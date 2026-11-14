// INV-01 客户端指令：守住位置——必须留在文件首条语句且唯一；改错故障——指令被下移后组件按服务端组件处理，context 与事件回调在 RSC 下失效并报错
// INV-02 上下文默认值：守住位置——createContext 的默认参数只能是 null；改错故障——塞入假默认值后，漏包 Provider 的子树不再快速失败，而是静默渲染错误的开合状态
// INV-03 读取入口判空：守住位置——useChainOfThought 必须在取值之后、解构之前判空抛错；改错故障——去掉判断会在渲染期抛 TypeError，丢失组件归属与修复提示
// INV-04 初始开合：守住位置——defaultOpen 的默认 false 只能写在组件签名解构里；改错故障——挪到别处兜底会与受控 open 语义冲突，首次渲染出现误开
// INV-05 受控与非受控：守住位置——open 与 defaultOpen 必须同时交给 useControllableState；改错故障——自行用局部 state 复制一份 isOpen，外部 open 变更被吞成两份真相
// INV-06 context 引用稳定：守住位置——useMemo 依赖只能是 isOpen 与 setIsOpen；改错故障——每次渲染新建对象，Provider 下全部消费者无条件重渲染
// INV-07 头与内容同源：守住位置——Header 与 Content 都必须读同一 context；改错故障——任一侧改成本地 state 后，点击标题展开而内容不动
// INV-08 折叠受控：守住位置——内层 Collapsible 的 open 与 onOpenChange 都要绑定 context；改错故障——只绑定其一会退化为非受控，第二次交互后状态分叉
// INV-09 标题缺省文案：守住位置——默认文案只能作为 children 的回退；改错故障——把默认值提到 props 解构，会让显式传空节点的调用方无法留白
// INV-10 箭头朝向：守住位置——旋转类名切换只读 isOpen；改错故障——改由父级 CSS 组属性驱动后，脱离折叠上下文时图标与内容状态不一致
// INV-11 状态样式表：守住位置——active、complete、pending 三个键必须与 status 联合类型一致；改错故障——增删任一键后索引得到 undefined，颜色静默丢失
// INV-12 步骤缺省状态：守住位置——status 解构默认值必须保持 complete；改错故障——改成 pending 会让所有未显式传值的步骤半透明，看起来像渲染失败
// INV-13 图标缺省：守住位置——icon 到 Icon 的重命名解构不能拆开；改错故障——拆成两步后变量变小写，JSX 会当成 DOM 标签并产生未知元素告警
// INV-14 连接线定位：守住位置——竖线必须落在带 relative 的图标容器内；改错故障——把 relative 移到外层后竖线从行首起画并压住相邻文本
// INV-15 描述条件渲染：守住位置——description 的真值判断必须保留；改错故障——改为无条件渲染后空值也占位，步骤间距被撑大
// INV-16 属性透传顺序：守住位置——各组件的剩余属性展开必须放在末尾；改错故障——展开提前会被显式属性覆盖，aria 属性与测试选择器丢失
// INV-17 展示名登记：守住位置——七个 displayName 在文件末尾集中赋值；改错故障——删除后 memo 包装组件在 DevTools 与错误栈中显示为匿名，排障困难
// INV-18 依赖边界：守住位置——本文件只允许 react、lucide 与 ui 基础组件；改错故障——接入服务或平台调用后组件不再纯展示，单测与预览环境需要额外 Provider
//
// 模块职责：Chain of Thought 展示族的纯展示组件集合，负责开合容器、步骤列表、搜索来源与图片块的结构与样式。
// 状态所有权：开合状态由 ChainOfThought 经 useControllableState 持有并通过 context 下发，其余组件不持有业务状态。
// 阅读顺序：先看 INV 清单与上下文契约，再按 ChainOfThought、Header、Step、SearchResults、Content、Image 的顺序读。
"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Badge } from "../ui/badge.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import type { LucideIcon } from "lucide-react";
import { BrainIcon, ChevronDownIcon, DotIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useMemo } from "react";

// 上下文只放开合状态，不放步骤数据，避免任一字段变化触发整棵步骤树重渲染
// setIsOpen 声明为接收布尔值的函数类型，好让 useControllableState 的结果直接注入
// 字段增删必须同步 useMemo 的依赖数组，否则消费者拿到陈旧闭包
// 这里只定义形状，具体值由 ChainOfThought 在 Provider 处补齐
// 类型与运行时默认值分开维护，是为了让漏包 Provider 的用法显式失败
interface ChainOfThoughtContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

// 默认值固定为 null，作为漏包 Provider 的哨兵，任何假默认值都会掩盖接线错误
// 把 null 放进联合类型而不是断言非空，让类型系统强制调用方先判空
// 泛型参数与上面的 interface 保持同源，改字段时只需改一处
// 该值在模块加载期创建一次，保证跨组件实例共享同一引用
// 不要在别的文件重复创建同名 context，否则 Provider 与消费者会跨到不同实例
const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(
  null
);

// 这是唯一的读取入口，组件不直接取 context，便于后续统一加断言
// 判空抛错必须发生在解构字段之前，否则会先得到空值访问的 TypeError
// 错误文案点名 ChainOfThought，提示调用方补上 Provider 包裹
// 抛错属于开发期契约失败，不要降级成返回默认值，否则问题被推迟到样式层
// 该 hook 无状态、无副作用，可安全在渲染期任意次调用
const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error(
      "ChainOfThought components must be used within ChainOfThought"
    );
  }
  return context;
};

// 对外契约是 div 原生属性叠加三个开合字段，调用方既能传样式也能控状态
// open 与 defaultOpen 并存意味着受控与非受控两条路径都要成立，二者不能互相污染
// onOpenChange 只在内部状态真正变化时触发，调用方不应依赖它做二次同步
// 类型里不暴露 context 细节，避免调用方绕过组件直接操作状态
// 新增 prop 时优先考虑透传给根 div，其次才提升为显式字段
export type ChainOfThoughtProps = ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

// defaultOpen 的默认值写在解构处，仅在调用方未指定时生效，不会覆盖受控 open
// useControllableState 同时接收 prop 与 defaultProp，由它判定当前以哪条路径为准
// 开合状态只在此处持有，是整棵子树唯一真相，下游组件不得另存副本
// useMemo 依赖只有 isOpen 与 setIsOpen，二者稳定则 Provider 的 value 引用不变
// memo 包装让父级无关重渲染被短路，属性引用不变时直接复用上次结果
export const ChainOfThought = memo(
  ({
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: open,
    });

    const chainOfThoughtContext = useMemo(
      () => ({ isOpen, setIsOpen }),
      [isOpen, setIsOpen]
    );

    return (
      <ChainOfThoughtContext.Provider value={chainOfThoughtContext}>
        <div className={cn("not-prose w-full space-y-4", className)} {...props}>
          {children}
        </div>
      </ChainOfThoughtContext.Provider>
    );
  }
);

export type ChainOfThoughtHeaderProps = ComponentProps<
  typeof CollapsibleTrigger
>;

// Header 不持有状态，只消费 context，因此折叠标题可出现在子树任意位置
// Collapsible 的 open 与 onOpenChange 都绑定 context，保持完全受控
// 若只绑定其一，组件会退化为非受控，内部状态从此与 context 分叉
// children 为空才使用默认文案，显式传入空节点应保留为空白
// 箭头旋转读 isOpen 而不是内部 data-state，保证与 context 严格一致
export const ChainOfThoughtHeader = memo(
  ({ className, children, ...props }: ChainOfThoughtHeaderProps) => {
    const { isOpen, setIsOpen } = useChainOfThought();

    return (
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger
          className={cn(
            "flex w-full items-center gap-2 text-muted-foreground text-ui-base transition-colors hover:text-foreground",
            className
          )}
          {...props}
        >
          <BrainIcon className="size-4" />
          <span className="flex-1 text-left">
            {children ?? "Chain of Thought"}
          </span>
          <ChevronDownIcon
            className={cn(
              "size-4 transition-transform",
              isOpen ? "rotate-180" : "rotate-0"
            )}
          />
        </CollapsibleTrigger>
      </Collapsible>
    );
  }
);

export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
  icon?: LucideIcon;
  label: ReactNode;
  description?: ReactNode;
  status?: "complete" | "active" | "pending";
};

const stepStatusStyles = {
  active: "text-foreground",
  complete: "text-muted-foreground",
  pending: "text-muted-foreground/50",
};

export const ChainOfThoughtStep = memo(
  ({
    className,
    icon: Icon = DotIcon,
    label,
    description,
    status = "complete",
    children,
    ...props
  }: ChainOfThoughtStepProps) => (
    <div
      className={cn(
        "flex gap-2 text-ui-base",
        stepStatusStyles[status],
        "fade-in-0 slide-in-from-top-2 animate-in",
        className
      )}
      {...props}
    >
      <div className="relative mt-0.5">
        <Icon className="size-4" />
        <div className="absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border" />
      </div>
      <div className="flex-1 space-y-2 overflow-hidden">
        <div>{label}</div>
        {description && (
          <div className="text-muted-foreground text-ui-base">{description}</div>
        )}
        {children}
      </div>
    </div>
  )
);

export type ChainOfThoughtSearchResultsProps = ComponentProps<"div">;

export const ChainOfThoughtSearchResults = memo(
  ({ className, ...props }: ChainOfThoughtSearchResultsProps) => (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
);

export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>;

export const ChainOfThoughtSearchResult = memo(
  ({ className, children, ...props }: ChainOfThoughtSearchResultProps) => (
    <Badge
      className={cn("gap-1 px-2 py-0.5 font-normal text-ui-base", className)}
      variant="secondary"
      {...props}
    >
      {children}
    </Badge>
  )
);

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>;

// Content 只读不开写，展开与收起完全由 Header 或外部 open 驱动
// 这里再包一层 Collapsible 是为了复用动画所需的 data-state 标记
// 缺少 Provider 时 useChainOfThought 立即抛错，而不是渲染空内容
// 动画类名依赖 data-state 开合标记，改类名前先确认状态属性仍会输出
// 子内容直接透传给 CollapsibleContent，不要再包一层 div 破坏间距
export const ChainOfThoughtContent = memo(
  ({ className, children, ...props }: ChainOfThoughtContentProps) => {
    const { isOpen } = useChainOfThought();

    return (
      <Collapsible open={isOpen}>
        <CollapsibleContent
          className={cn(
            "mt-2 space-y-3",
            "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
            className
          )}
          {...props}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    );
  }
);

export type ChainOfThoughtImageProps = ComponentProps<"div"> & {
  caption?: string;
};

export const ChainOfThoughtImage = memo(
  ({ className, children, caption, ...props }: ChainOfThoughtImageProps) => (
    <div className={cn("mt-2 space-y-2", className)} {...props}>
      <div className="relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-lg bg-muted p-3">
        {children}
      </div>
      {caption && <p className="text-muted-foreground text-ui-base">{caption}</p>}
    </div>
  )
);

// memo 包装会丢失函数名，这里集中补 displayName 供 DevTools 与错误栈识别
// 七个组件的 displayName 与导出名逐字对应，改名时两者要同步修改
// 漏写不会报错，但匿名组件会让 React 警告与堆栈指向难以定位
// 新增导出组件时在此追加一行，保持集中登记的习惯
// 该赋值在模块加载期执行一次，必须位于组件定义之后
ChainOfThought.displayName = "ChainOfThought";
ChainOfThoughtHeader.displayName = "ChainOfThoughtHeader";
ChainOfThoughtStep.displayName = "ChainOfThoughtStep";
ChainOfThoughtSearchResults.displayName = "ChainOfThoughtSearchResults";
ChainOfThoughtSearchResult.displayName = "ChainOfThoughtSearchResult";
ChainOfThoughtContent.displayName = "ChainOfThoughtContent";
ChainOfThoughtImage.displayName = "ChainOfThoughtImage";
