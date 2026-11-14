"use client";

// InlineCitation 组件族：角标展示首条来源域名，悬浮卡片内用 Carousel 浏览多来源详情。
// 全文件为无业务状态的展示层，状态来源只有 props、HoverCard 与 carousel 实例。
// 视觉依赖 Badge、HoverCard、Carousel 三个原子组件，覆写一律经 cn 合并而非替换语义。
// 引用数据由调用方解析后以字符串数组传入，本文件不取数、不缓存、不持久化。
// INV-01 角标主机名取 sources[0] 的 hostname 且仅在 sources[0] 为真值时求值；守住位置：InlineCitationCardTrigger 的三元分支；改错故障：空数组渲染出异常或显示 undefined 主机名。
// INV-02 额外来源数固定为 sources.length - 1 且仅当大于 1 才追加显示；守住位置：InlineCitationCardTrigger 的 +N 片段；改错故障：单来源也出现 +0，或计数漏算首条误导用户。
// INV-03 sources[0] 非空但非合法绝对 URL 时 URL 构造会抛错并炸掉整棵引用子树；守住位置：InlineCitationCardTrigger 的 hostname 求值；改错故障：一条脏链接让整段回答白屏。
// INV-04 角标基形态由 Badge 的 secondary 变体提供，class 追加 ml-1 rounded-full；守住位置：InlineCitationCardTrigger 的 Badge；改错故障：角标与正文黏连，或与主题徽章样式漂移。
// INV-05 HoverCardTrigger 以 asChild 将悬浮能力下沉到 Badge 真实 DOM；守住位置：InlineCitationCardTrigger 的触发层；改错故障：多包一层节点导致布局错位与聚焦目标丢失。
// INV-06 closeDelay 与 openDelay 同为 0，令悬浮卡片即时开合；守住位置：InlineCitationCard 的 HoverCard 默认值；改错故障：划过时出现延迟卡顿，或关闭后残留弹层。
// INV-07 调用方 props 展开在默认值之后，可整体接管延时与受控 open；守住位置：InlineCitationCard 的参数透传顺序；改错故障：外部受控开关被默认值吞掉而无法控制。
// INV-08 卡片外框固定 w-80 且 p-0，留白与裁切下放给子项；守住位置：InlineCitationCardBody 的 HoverCardContent；改错故障：双层内边距使卡片过宽或窄屏溢出。
// INV-09 CarouselApiContext 初值为 undefined，消费者必须在实例就绪前安全空跑；守住位置：useCarouselApi 与 createContext 初值；改错故障：首帧拿到空实例后调用滚动接口直接报错。
// INV-10 轮播实例由 Carousel 的 setApi 回灌 state，Provider 在渲染期下发给整棵子树；守住位置：InlineCitationCarousel 的 useState 与 Provider；改错故障：子组件永远读不到实例，索引与翻页全部失效。
// INV-11 索引默认输出 current/count，children 存在时整体替换默认输出；守住位置：InlineCitationCarouselIndex 的返回值；改错故障：自定义索引与默认文本叠加渲染出两份。
// INV-12 count 取滚动快照列表长度、current 取选中下标加一，两者在同一回调内成对写入；守住位置：syncState；改错故障：页码与总数错位，出现 0/0 或越界页码。
// INV-13 syncState 在实例为空时提前返回，绝不在空实例上读快照；守住位置：syncState 的空值守卫；改错故障：未挂载完成即同步，渲染被异常中断。
// INV-14 select 事件只在 effect 内订阅，并在清理函数中以同一引用解绑；守住位置：InlineCitationCarouselIndex 的 effect 清理；改错故障：多次挂载累积监听，页码抖动并泄漏内存。
// INV-15 effect 依赖固定为实例与 syncState，保证订阅只在实例更替时重建；守住位置：InlineCitationCarouselIndex 的依赖数组；改错故障：订阅持续重建使 select 回调丢失。
// INV-16 上一页与下一页按钮显式声明 type=button，避免在表单上下文里触发提交；守住位置：Prev 与 Next 的 button；改错故障：卡片内翻页误提交外层表单。
// INV-17 翻页按钮在实例缺失时静默跳过，不改动任何状态；守住位置：Prev 与 Next 的 handleClick；改错故障：未就绪点击抛错，或跳到错误页。
// INV-18 两个按钮各自携带 aria-label 且图标不承载文案，键盘与读屏依赖该标签；守住位置：Prev 与 Next 的 aria-label；改错故障：读屏用户听到无意义按钮名而无法导航。
import { Badge } from "../ui/badge.js";
import type { CarouselApi } from "../ui/carousel.js";
import { Carousel, CarouselContent, CarouselItem } from "../ui/carousel.js";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../ui/hover-card.js";
import { cn } from "../lib/utils.js";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import type { ComponentProps } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type InlineCitationProps = ComponentProps<"span">;

// 根 span 承担 group 语义，后代悬浮样式全部以此为祖先锚点。
// inline 与 items-center gap-1 共同保证角标与文字同基线且保持最小间距。
// 调用方 className 经 cn 合并到末位，可覆盖默认间距但保留 group 标记。
// 透传 props 不做白名单筛选，事件与 aria 属性由外层调用方全权决定。
export const InlineCitation = ({
  className,
  ...props
}: InlineCitationProps) => (
  <span
    className={cn("group inline items-center gap-1", className)}
    {...props}
  />
);

export type InlineCitationTextProps = ComponentProps<"span">;

// 正文用 group-hover:bg-accent 整体高亮，提示该段带有可交互引用。
// transition-colors 限定过渡属性，避免布局或阴影被连带做动画。
// 高亮只由父级 group 悬浮驱动，文本自身不持有任何悬浮状态。
export const InlineCitationText = ({
  className,
  ...props
}: InlineCitationTextProps) => (
  <span
    className={cn("transition-colors group-hover:bg-accent", className)}
    {...props}
  />
);

export type InlineCitationCardProps = ComponentProps<typeof HoverCard>;

// openDelay 缺省 0 是引用浏览的默认手感，调用方需要缓冲时应显式覆盖。
// 该组件不产出 DOM，仅把行为与状态转发给 HoverCard 根节点。
// 开合与外部点击关闭由 HoverCard 统一托管，本层不监听全局指针事件。
// openDelay 与 open 同属行为契约，改动需同步调用方的悬浮期望。
export const InlineCitationCard = (props: InlineCitationCardProps) => (
  <HoverCard closeDelay={0} openDelay={0} {...props} />
);

export type InlineCitationCardTriggerProps = ComponentProps<typeof Badge> & {
  sources: string[];
};

// sources 为空数组时回落 unknown 文案，保证角标占位不塌陷。
// 主机名后追加一个空格再拼 +N，防止域名与计数视觉粘连。
// 计数用条件与运算短路，避免单来源时把布尔值渲染进文本。
// 非空首条一律交给 URL 解析，合法性由调用方在传入前负责。
// sources 按位置读取，重复链接既不去重也不影响计数口径。
// Badge 接收的透传 props 位于 className 之后，可被改写为其他变体。
export const InlineCitationCardTrigger = ({
  sources,
  className,
  ...props
}: InlineCitationCardTriggerProps) => (
  <HoverCardTrigger asChild>
    <Badge
      className={cn("ml-1 rounded-full", className)}
      variant="secondary"
      {...props}
    >
      {sources[0] ? (
        <>
          {new URL(sources[0]).hostname}{" "}
          {sources.length > 1 && `+${sources.length - 1}`}
        </>
      ) : (
        "unknown"
      )}
    </Badge>
  </HoverCardTrigger>
);

export type InlineCitationCardBodyProps = ComponentProps<"div">;

// relative 为内部绝对定位元素提供包含块，p-0 把留白让给子项。
// 宽度固定不随内容伸缩，长内容由子项的截断规则自行收敛。
// 内容尺寸与轮播、来源列表解耦，单点调整不会连锁改变布局。
// 调用方 className 追加在后可覆盖宽度，但需自行承担窄屏溢出。
export const InlineCitationCardBody = ({
  className,
  ...props
}: InlineCitationCardBodyProps) => (
  <HoverCardContent className={cn("relative w-80 p-0", className)} {...props} />
);

const CarouselApiContext = createContext<CarouselApi | undefined>(undefined);

// 读取上下文但不做非空断言，返回类型保留 undefined 迫使调用点判空。
// 未包在 Provider 内的组件得到 undefined，而不是抛错中断渲染。
// 该 hook 不订阅额外状态，实例变化完全由 Provider 的 value 驱动重渲染。
const useCarouselApi = () => {
  const context = useContext(CarouselApiContext);
  return context;
};

export type InlineCitationCarouselProps = ComponentProps<typeof Carousel>;

// 首帧 Provider 下发空实例，所有子组件必须容忍空值。
// setApi 作为回调交给 Carousel，实例就绪后再触发一次状态更新。
// Provider 只包住 Carousel 子树，作用域外的消费者读不到该实例。
// setApi 先绑定后展开 props，调用方覆盖会切断上下文回填链路。
// InlineCitationCarousel 宽度由外层容器决定，组件自身不写死像素宽度。
export const InlineCitationCarousel = ({
  className,
  children,
  ...props
}: InlineCitationCarouselProps) => {
  const [api, setApi] = useState<CarouselApi>();

  return (
    <CarouselApiContext.Provider value={api}>
      <Carousel className={cn("w-full", className)} setApi={setApi} {...props}>
        {children}
      </Carousel>
    </CarouselApiContext.Provider>
  );
};

export type InlineCitationCarouselContentProps = ComponentProps<"div">;

export const InlineCitationCarouselContent = (
  props: InlineCitationCarouselContentProps,
) => <CarouselContent {...props} />;

export type InlineCitationCarouselItemProps = ComponentProps<"div">;

export const InlineCitationCarouselItem = ({
  className,
  ...props
}: InlineCitationCarouselItemProps) => (
  <CarouselItem
    className={cn("w-full space-y-2 p-4 pl-8", className)}
    {...props}
  />
);

export type InlineCitationCarouselHeaderProps = ComponentProps<"div">;

export const InlineCitationCarouselHeader = ({
  className,
  ...props
}: InlineCitationCarouselHeaderProps) => (
  <div
    className={cn(
      "flex items-center justify-between gap-2 rounded-t-md bg-secondary p-2",
      className,
    )}
    {...props}
  />
);

export type InlineCitationCarouselIndexProps = ComponentProps<"div">;

// 页码与总数拆成两个 state，可各自独立刷新而不互相拖拽。
// 初始值同为 0，实例就绪前渲染 0/0 占位而非空白。
// 索引容器 flex-1 靠右对齐，与左侧翻页控件共享同一行高度。
// children 用空值合并判断，显式传入空串仍走自定义分支。
// 页码仅是展示投影，真实滚动位置以轮播实例为唯一事实源。
export const InlineCitationCarouselIndex = ({
  children,
  className,
  ...props
}: InlineCitationCarouselIndexProps) => {
  const api = useCarouselApi();
  const [current, setCurrent] = useState(0);
  const [count, setCount] = useState(0);

  // 先取快照再取选中下标，两次读同一实例以保证同一帧内一致。
  // 下标加一后才展示为人类可读页码，内部索引仍从零起。
  // 依赖数组只含实例，实例不变时回调引用稳定，订阅不会被重建。
  // 该回调同时充当事件处理器与首次同步入口，两条路径行为一致。
  const syncState = useCallback(() => {
    if (!api) {
      return;
    }
    setCount(api.scrollSnapList().length);
    setCurrent(api.selectedScrollSnap() + 1);
  }, [api]);

  // 清理函数返回解绑动作，必须与订阅使用同一函数引用才能精确移除。
  // 挂载即主动同步一次，避免等到首次滚动才出现正确页码。
  // 实例变化会整体重跑，先解绑旧实例再订阅新实例。
  // 同步只写本地展示状态，不触碰外部存储，重复执行安全。
  useEffect(() => {
    if (!api) {
      return;
    }

    syncState();

    api.on("select", syncState);

    return () => {
      api.off("select", syncState);
    };
  }, [api, syncState]);

  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-end px-3 py-1 text-muted-foreground text-ui-base",
        className,
      )}
      {...props}
    >
      {children ?? `${current}/${count}`}
    </div>
  );
};

export type InlineCitationCarouselPrevProps = ComponentProps<"button">;

// 点击回调依赖实例，实例更替后自动取到新引用而非旧闭包。
// 图标按钮配 shrink-0，防止在窄容器里被压扁变形。
// 左右按钮结构镜像，仅滚动方向与图标不同，便于并行维护。
export const InlineCitationCarouselPrev = ({
  className,
  ...props
}: InlineCitationCarouselPrevProps) => {
  const api = useCarouselApi();

  const handleClick = useCallback(() => {
    if (api) {
      api.scrollPrev();
    }
  }, [api]);

  return (
    <button
      aria-label="Previous"
      className={cn("shrink-0", className)}
      onClick={handleClick}
      type="button"
      {...props}
    >
      <ArrowLeftIcon className="size-4 text-muted-foreground" />
    </button>
  );
};

export type InlineCitationCarouselNextProps = ComponentProps<"button">;

// InlineCitationCarouselNext 与上一页共享对称实现，scrollNext 方向向后。
// 点击逻辑收在单一 useCallback，避免每次渲染新建处理器。
// 按钮保持原生可聚焦，Tab 顺序与视觉顺序保持一致。
export const InlineCitationCarouselNext = ({
  className,
  ...props
}: InlineCitationCarouselNextProps) => {
  const api = useCarouselApi();

  const handleClick = useCallback(() => {
    if (api) {
      api.scrollNext();
    }
  }, [api]);

  return (
    <button
      aria-label="Next"
      className={cn("shrink-0", className)}
      onClick={handleClick}
      type="button"
      {...props}
    >
      <ArrowRightIcon className="size-4 text-muted-foreground" />
    </button>
  );
};

export type InlineCitationSourceProps = ComponentProps<"div"> & {
  title?: string;
  url?: string;
  description?: string;
};

// 标题、链接、描述三字段各自判空，缺字段则对应行整体不渲染。
// 标题用 truncate 单行省略，防止超长标题把卡片撑破。
// 链接同时用 truncate 与 break-all，兼顾无空格长串的换行。
// 描述限制三行，超限省略以稳定卡片高度不跳动。
// children 置于末尾，允许调用方追加自定义区块而不改结构。
// InlineCitationSource 的所有片段均为纯展示，不构造可点击链接也不触发导航。
export const InlineCitationSource = ({
  title,
  url,
  description,
  className,
  children,
  ...props
}: InlineCitationSourceProps) => (
  <div className={cn("space-y-1", className)} {...props}>
    {title && (
      <h4 className="truncate font-medium text-ui-base leading-tight">{title}</h4>
    )}
    {url && (
      <p className="truncate break-all text-muted-foreground text-ui-base">{url}</p>
    )}
    {description && (
      <p className="line-clamp-3 text-muted-foreground text-ui-base leading-relaxed">
        {description}
      </p>
    )}
    {children}
  </div>
);

export type InlineCitationQuoteProps = ComponentProps<"blockquote">;

// 引用块用左侧描边加缩进表达从属关系，颜色取 border 令牌。
// 斜体只作用于引用正文，不改变外层排版的字重节奏。
// InlineCitationQuote 的 children 原样透传，不插入编者注也不自动补齐来源。
export const InlineCitationQuote = ({
  children,
  className,
  ...props
}: InlineCitationQuoteProps) => (
  <blockquote
    className={cn(
      "border-border border-l-2 pl-3 text-muted-foreground text-ui-base italic",
      className,
    )}
    {...props}
  >
    {children}
  </blockquote>
);
