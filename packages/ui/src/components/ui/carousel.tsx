// INV-01 [状态所有权] canScrollPrev 与 canScrollNext 只能由 onSelect 写入；守住位置：onSelect 里的两次 setState 以及订阅 effect 对 select、reInit 的登记；改错故障：边界处按钮禁用态与真实滚动位置脱节，翻到尽头仍可点、首屏却被误禁。
// INV-02 [并发] 实例在首帧可能尚未就绪；守住位置：scrollPrev、scrollNext 内的可选调用与 onSelect 顶部的空实例早返回；改错故障：初始化后立即点击抛空引用，事件处理链中断。
// INV-03 [契约] 滚动轴由 orientation 推导而非直接透传；守住位置：useEmblaCarousel 首参里 axis 的三元表达式与 contextValue 中 orientation 的回落判定；改错故障：垂直模式仍按水平轴构造，翻页方向与按钮位置相反。
// INV-04 [契约] 子组件只经 useCarousel 取 context，不直接引用 CarouselContext；守住位置：CarouselContent、CarouselItem、CarouselPrevious、CarouselNext 的首行解构；改错故障：绕过校验后拿到 null，在解构处报不易定位的错误。
// INV-05 [失败路径] context 为空必须显式抛错；守住位置：useCarousel 内 if (!context) 分支的 throw；改错故障：组件被放到 Carousel 之外时静默渲染，交互全部失效且无提示。
// INV-06 [事务] onSelect 必须早于事件登记执行一次；守住位置：订阅 effect 中 onSelect 调用位于 reInit、select 登记之前；改错故障：首屏按钮停在初始 false 态，直到第一次滚动才恢复可用。
// INV-07 [资源] 订阅与清理成对，且清理只针对 select；守住位置：订阅 effect 的返回函数里仅对 select 退订；改错故障：清理遗漏或没带上原回调时，监听随重挂载叠加，状态更新次数翻倍。
// INV-08 [权衡] reInit 监听未随清理移除；守住位置：订阅 effect 只登记不移除 reInit 的分支；改错故障：同一实例反复挂载会累积 reInit 回调，重排一次触发多轮状态重算。
// INV-09 [契约] 键盘映射固定为左右箭头；守住位置：handleKeyDown 内 ArrowLeft 与 ArrowRight 的两个判断；改错故障：把方向写反会使键盘行为与按钮相反，用户无法预测下一页方向。
// INV-10 [契约] 键盘分支先阻止默认行为再滚动；守住位置：handleKeyDown 两个分支中的 preventDefault 调用；改错故障：方向键同时滚动页面，轮播与焦点脱节。
// INV-11 [契约] 键盘回调依赖必须登记两个滚动函数；守住位置：handleKeyDown 的 useCallback 依赖数组；改错故障：捕获旧闭包，实例换代后键盘仍驱动上一个实例。
// INV-12 [契约] embla 根引用只能挂在 overflow-hidden 外层；守住位置：CarouselContent 中 ref 所在 div 与内层 flex 轨道；改错故障：引用挂到轨道上，容器尺寸计算错误，每页位移与可见卡片错位。
// INV-13 [契约] 轨道负偏移与 item 内边距必须成对；守住位置：CarouselContent 的 -ml-4、-mt-4 与 CarouselItem 的 pl-4、pt-4；改错故障：首尾多出 16px 空隙或卡片被裁掉一条，翻页露出相邻页。
// INV-14 [契约] 每页宽度由 basis-full 固定；守住位置：CarouselItem 的 className 中 min-w-0、shrink-0、grow-0、basis-full；改错故障：一屏露出多张幻灯片，索引与视觉页数不一致。
// INV-15 [无障碍] 语义靠 role 与 aria-roledescription 表达；守住位置：根 div 的 region、carousel 与 item 的 group、slide；改错故障：读屏软件把轮播当作普通容器，幻灯片数量与切换无法播报。
// INV-16 [失败路径] 按钮可用性直接来自滚动能力布尔态；守住位置：CarouselPrevious、CarouselNext 的 disabled 与 onClick 绑定；改错故障：端点仍可点击并发出无效滚动，或首屏两个按钮同时禁用。
// INV-17 [契约] 按钮文案必须走国际化；守住位置：两个按钮内 sr-only span 的 intl.formatMessage 与 carousel.previousSlide、carousel.nextSlide 两个 id；改错故障：切换语言后读屏文案缺失或回退成键名。
// INV-18 [契约] 导出面固定为五个组件、一个 hook 与一个类型；守住位置：文件末尾 export 块；改错故障：漏出 useCarousel 时外部自定义控件无法复用同一份 context，只能复制逻辑。
//
// 模块职责：基于 embla 封装一套可组合轮播：Carousel 持有实例与滚动状态，Content、Item 提供轨道与页面结构，Previous、Next 提供无障碍按钮。
// 状态所有权：embla 实例、两个可滚动布尔态、滚动回调与合并后的 contextValue 全部封闭在 Carousel 内，子组件只经 useCarousel 读取。
// 阅读顺序：先看类型与 context 契约，再看 Carousel 内的实例初始化、onSelect、键盘与两个 effect，最后看 contextValue 合并与四个子组件的结构、样式与导出。
"use client";

import * as React from "react";
import useEmblaCarousel, { type UseEmblaCarouselType } from "embla-carousel-react";

import { cn } from "../lib/utils.js";
import { Button } from "./button.js";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// [契约] CarouselApi 取 useEmblaCarousel 返回元组的第二项，是外部唯一认可的实例类型。
// [契约] UseCarouselParameters 由参数元组推导，第一项是 opts，第二项是 plugins。
// [权衡] 类型全部从库推导而不手写，embla 升级时自动跟随，代价是报错信息更抽象。
// [契约] CarouselContextProps 把实例、引用、两个滚动函数与两个布尔态合并，并交叉 CarouselProps。
type CarouselApi = UseEmblaCarouselType[1];
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];

type CarouselProps = {
  opts?: CarouselOptions;
  plugins?: CarouselPlugin;
  orientation?: "horizontal" | "vertical";
  setApi?: (api: CarouselApi) => void;
};

type CarouselContextProps = {
  carouselRef: ReturnType<typeof useEmblaCarousel>[0];
  api: ReturnType<typeof useEmblaCarousel>[1];
  scrollPrev: () => void;
  scrollNext: () => void;
  canScrollPrev: boolean;
  canScrollNext: boolean;
} & CarouselProps;

// [状态所有权] 默认值 null 表示不在 Carousel 子树内，而不是一个空实现。
// [契约] Provider 只由 Carousel 渲染，其他位置不得自建第二份 context。
// [契约] 把缺失检测集中到 useCarousel，子组件因此不做重复判空。
// [权衡] 不提供非空默认值，避免脱离 Provider 时静默拿到假实例。
// [契约] 消费方一律经 useCarousel 读取，不直接引用 CarouselContext。
const CarouselContext = React.createContext<CarouselContextProps | null>(null);

function useCarousel() {
  const context = React.useContext(CarouselContext);

  if (!context) {
    throw new Error("useCarousel must be used within a <Carousel />");
  }

  return context;
}

function Carousel({
  orientation = "horizontal",
  opts,
  setApi,
  plugins,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & CarouselProps) {
  const [carouselRef, api] = useEmblaCarousel(
    {
      ...opts,
      axis: orientation === "horizontal" ? "x" : "y",
    },
    plugins,
  );
  const [canScrollPrev, setCanScrollPrev] = React.useState(false);
  const [canScrollNext, setCanScrollNext] = React.useState(false);

  // [状态所有权] 两个可滚动布尔态只允许在 onSelect 内写入。
  // [事务] onSelect 先判空再读实例能力，避免初始化竞态下取空。
  // [并发] select 与 reInit 共用同一个 onSelect，重排后状态自动重算。
  // [契约] scrollPrev 与 scrollNext 直接转调实例，不自行维护索引。
  // [并发] 两个滚动回调以 api 为依赖，实例换代后随之重建。
  // [失败路径] 实例缺失时可选调用空转，不打断调用方的事件流。
  const onSelect = React.useCallback((api: CarouselApi) => {
    if (!api) return;
    setCanScrollPrev(api.canScrollPrev());
    setCanScrollNext(api.canScrollNext());
  }, []);

  const scrollPrev = React.useCallback(() => {
    api?.scrollPrev();
  }, [api]);

  const scrollNext = React.useCallback(() => {
    api?.scrollNext();
  }, [api]);

  // [契约] 左箭头映射上一页、右箭头映射下一页，两分支互斥。
  // [契约] 左右箭头命中时先 preventDefault，再由 api.scrollPrev/Next 消费，防止页面滚动抢占按键。
  // [并发] 依赖数组登记两个滚动函数，键盘绑定始终指向最新实例。
  // [权衡] handleKeyDown 只认 ArrowLeft/ArrowRight，垂直模式的 ArrowUp/ArrowDown 仍交给浏览器。
  // [契约] 处理器挂在根节点的捕获阶段，子节点尚未处理就已决定是否消费。
  // [失败路径] 未匹配的按键直接落空，不触碰默认行为。
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        scrollPrev();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        scrollNext();
      }
    },
    [scrollPrev, scrollNext],
  );

  React.useEffect(() => {
    // [契约] 实例与 setApi 同时存在才向宿主上报。
    // [资源] effect 依赖 api 与 setApi，任一变化都会重新上报。
    // [失败路径] 缺任一时提前返回，绝不向宿主传出空实例。
    // [权衡] 上报放在 effect 中，避免在渲染期触发宿主状态更新。
    if (!api || !setApi) return;
    setApi(api);
  }, [api, setApi]);

  React.useEffect(() => {
    if (!api) return;
    onSelect(api);
    api.on("reInit", onSelect);
    api.on("select", onSelect);

    return () => {
      // [事务] effect 先同步执行一次 onSelect，再登记 reInit 与 select。
      // [契约] reInit 让结构变化后重新计算边界可用性。
      // [资源] 清理函数只对 select 退订，reInit 仍留在原实例上。
      // [权衡] 该不对称使同一实例重挂载会累积 reInit 监听，只有实例换代才整体释放。
      // [失败路径] 清理时实例可能已被销毁，因此退订走可选调用。
      // [并发] 依赖 api 与 onSelect，任一变化都先清理再重订。
      api?.off("select", onSelect);
    };
  }, [api, onSelect]);

  // [契约] contextValue 经 useMemo 收敛，引用稳定才能避免整棵子树重渲染。
  // [契约] 依赖覆盖 api、两个滚动函数、两个布尔态、引用、opts 与 orientation。
  // [契约] orientation 在 memo 内回落到 opts 的 axis，兼容只透传 opts 的调用方。
  // [失败路径] 漏列依赖会让子组件读到陈旧布尔态，按钮禁用态与视觉不一致。
  // [权衡] 值里带着 opts 引用，调用方每次渲染新建选项对象会引发全量更新。
  // [契约] 紧随的 CarouselContent 把实例引用挂在外层 overflow-hidden，内层才是轨道。
  // [契约] CarouselItem 的宽度由 basis-full 锁定一页一张，内边距与轨道负偏移配对。
  const contextValue = React.useMemo(
    () => ({
      carouselRef,
      api: api,
      opts,
      orientation: orientation || (opts?.axis === "y" ? "vertical" : "horizontal"),
      scrollPrev,
      scrollNext,
      canScrollPrev,
      canScrollNext,
    }),
    [api, canScrollNext, canScrollPrev, carouselRef, opts, orientation, scrollNext, scrollPrev],
  );

  return (
    <CarouselContext.Provider value={contextValue}>
      <div
        onKeyDownCapture={handleKeyDown}
        className={cn("relative", className)}
        role="region"
        aria-roledescription="carousel"
        data-slot="carousel"
        {...props}
      >
        {children}
      </div>
    </CarouselContext.Provider>
  );
}

function CarouselContent({ className, ...props }: React.ComponentProps<"div">) {
  const { carouselRef, orientation } = useCarousel();

  return (
    <div ref={carouselRef} className="overflow-hidden" data-slot="carousel-content">
      <div
        className={cn("flex", orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col", className)}
        {...props}
      />
    </div>
  );
}

function CarouselItem({ className, ...props }: React.ComponentProps<"div">) {
  const { orientation } = useCarousel();

  return (
    <div
      role="group"
      aria-roledescription="slide"
      data-slot="carousel-item"
      className={cn(
        "min-w-0 shrink-0 grow-0 basis-full",
        orientation === "horizontal" ? "pl-4" : "pt-4",
        className,
      )}
      {...props}
    />
  );
}

// [契约] 上一个按钮的禁用态直接取 canScrollPrev，点击即调用 scrollPrev。
// [契约] 下一个按钮对称地依赖 canScrollNext 与 scrollNext。
// [契约] 水平模式按钮落在左右两侧垂直居中，垂直模式转为上下并旋转 90 度。
// [契约] 两个按钮都标记 touch-manipulation 与 rounded-full，保持一致的触控与外形。
// [契约] 可见内容只有图标，文案放在 sr-only 中并走 intl 的两个轮播 id。
// [契约] 底部导出五个组件、useCarousel 与 CarouselApi 类型，保持对外面稳定。
function CarouselPrevious({
  className,
  variant = "outline",
  size = "icon-sm",
  ...props
}: React.ComponentProps<typeof Button>) {
  const { orientation, scrollPrev, canScrollPrev } = useCarousel();
  const { intl } = useZCodeIntl();

  return (
    <Button
      data-slot="carousel-previous"
      variant={variant}
      size={size}
      className={cn(
        "absolute touch-manipulation rounded-full",
        orientation === "horizontal"
          ? "top-1/2 -left-12 -translate-y-1/2"
          : "-top-12 left-1/2 -translate-x-1/2 rotate-90",
        className,
      )}
      disabled={!canScrollPrev}
      onClick={scrollPrev}
      {...props}
    >
      <ChevronLeftIcon />
      <span className="sr-only">{intl.formatMessage({ id: "carousel.previousSlide" })}</span>
    </Button>
  );
}

function CarouselNext({
  className,
  variant = "outline",
  size = "icon-sm",
  ...props
}: React.ComponentProps<typeof Button>) {
  const { orientation, scrollNext, canScrollNext } = useCarousel();
  const { intl } = useZCodeIntl();

  return (
    <Button
      data-slot="carousel-next"
      variant={variant}
      size={size}
      className={cn(
        "absolute touch-manipulation rounded-full",
        orientation === "horizontal"
          ? "top-1/2 -right-12 -translate-y-1/2"
          : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
        className,
      )}
      disabled={!canScrollNext}
      onClick={scrollNext}
      {...props}
    >
      <ChevronRightIcon />
      <span className="sr-only">{intl.formatMessage({ id: "carousel.nextSlide" })}</span>
    </Button>
  );
}

export {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
  useCarousel,
};
