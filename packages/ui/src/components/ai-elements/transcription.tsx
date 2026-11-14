// INV-01 容器外使用立即失败：守住位置 上下文判空；改错故障 子组件静默读到空值。
// INV-02 时间可受控可非受控：守住位置 受控状态 hook；改错故障 外部传入时间被忽略。
// INV-03 跳转回调只在点击时触发：守住位置 点击处理；改错故障 渲染期产生副作用。
// INV-04 上下文值必须有界重建：守住位置 依赖数组；改错故障 每次渲染都刷新下游。
// INV-05 空白段不渲染：守住位置 过滤条件；改错故障 出现不可读的空按钮。
// INV-06 段落三态互斥：守住位置 当前与已播判断；改错故障 同一段同时高亮与置灰。
// INV-07 无跳转回调时不可点：守住位置 光标样式条件；改错故障 出现点击无反应的按钮。
// INV-08 段序号与时间写入数据属性：守住位置 属性绑定；改错故障 外部无法定位段落。
// INV-09 按钮类型固定：守住位置 类型属性；改错故障 表单内触发提交。
// INV-10 原生点击回调仍被调用：守住位置 先跳转后透传；改错故障 外部点击逻辑失效。
// INV-11 当前时间边界左闭右开：守住位置 比较表达式；改错故障 相邻段同时高亮。
// INV-12 容器允许外部类名叠加：守住位置 合并函数；改错故障 布局类被覆盖。
// INV-13 上下文接口最小化：守住位置 四项字段；改错故障 子组件依赖实现细节。
// INV-14 段落文本原样输出：守住位置 直接渲染；改错故障 标点被转义。
// INV-15 类型来自上游契约：守住位置 类型别名；改错故障 本地重复定义漂移。
// INV-16 容器提供语义槽位：守住位置 数据槽属性；改错故障 样式钩子无处可挂。
// INV-17 段组件不写时间：守住位置 只读上下文；改错故障 点击同时改两份状态。
// INV-18 组件不引入全局状态：守住位置 上下文承载；改错故障 多实例互相干扰。
//
// 模块职责：转写文本的容器与可点击段落，按当前播放时间标记进度。
// 状态所有权：当前时间由容器持有，段落只读上下文并向上请求跳转。
// 阅读顺序：先看上下文与读取函数，再看容器，最后看段落的三态与点击。
"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { cn } from "../lib/utils.js";
import type { Experimental_TranscriptionResult as TranscriptionResult } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo } from "react";

type TranscriptionSegment = TranscriptionResult["segments"][number];

interface TranscriptionContextValue {
  segments: TranscriptionSegment[];
  currentTime: number;
  onTimeUpdate: (time: number) => void;
  onSeek?: (time: number) => void;
}

const TranscriptionContext = createContext<TranscriptionContextValue | null>(
  null
);

// useTranscription() 在 context 为空时立即抛错。
// 错误文案要求组件必须包在 Transcription 内。
// 读取函数直接返回 context，不做默认值兜底。
// currentTime 与 onSeek 都由 Transcription 注入。
// TranscriptionSegment 只读上下文，不写回。
const useTranscription = () => {
  const context = useContext(TranscriptionContext);
  if (!context) {
    throw new Error(
      "Transcription components must be used within Transcription"
    );
  }
  return context;
};

export type TranscriptionProps = Omit<ComponentProps<"div">, "children"> & {
  segments: TranscriptionSegment[];
  currentTime?: number;
  onSeek?: (time: number) => void;
  children: (segment: TranscriptionSegment, index: number) => ReactNode;
};

// currentTime 由 useControllableState() 同时兼容受控与非受控。
// 内部时间变化时经 onChange 回调外部 onSeek。
// contextValue 的 useMemo 依赖四项：currentTime / onSeek / setCurrentTime / segments。
// segments 先 filter(segment.text.trim()) 再渲染。
export const Transcription = ({
  segments,
  currentTime: externalCurrentTime,
  onSeek,
  className,
  children,
  ...props
}: TranscriptionProps) => {
  const [currentTime, setCurrentTime] = useControllableState({
    defaultProp: 0,
    onChange: onSeek,
    prop: externalCurrentTime,
  });

  const contextValue = useMemo(
    () => ({ currentTime, onSeek, onTimeUpdate: setCurrentTime, segments }),
    [currentTime, onSeek, setCurrentTime, segments]
  );

  return (
    <TranscriptionContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex flex-wrap gap-1 text-ui-base leading-relaxed",
          className
        )}
        data-slot="transcription"
        {...props}
      >
        {segments
          .filter((segment) => segment.text.trim())
          .map((segment, index) => children(segment, index))}
      </div>
    </TranscriptionContext.Provider>
  );
};

export type TranscriptionSegmentProps = ComponentProps<"button"> & {
  segment: TranscriptionSegment;
  index: number;
};

// isActive 与 isPast 分别按 startSecond、endSecond 判定。
// handleClick 只在 onSeek 存在时执行跳转。
// 样式按当前 / 已播 / 未播三种时间关系切换。
// data-index={index} 与 data-active 一并写入。
export const TranscriptionSegment = ({
  segment,
  index,
  className,
  onClick,
  ...props
}: TranscriptionSegmentProps) => {
  const { currentTime, onSeek } = useTranscription();

  const isActive =
    currentTime >= segment.startSecond && currentTime < segment.endSecond;
  const isPast = currentTime >= segment.endSecond;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (onSeek) {
        onSeek(segment.startSecond);
      }
      onClick?.(event);
    },
    [onSeek, segment.startSecond, onClick]
  );

  return (
    <button
      className={cn(
        "inline text-left",
        isActive && "text-primary",
        isPast && "text-muted-foreground",
        !(isActive || isPast) && "text-muted-foreground/60",
        onSeek && "cursor-pointer hover:text-foreground",
        !onSeek && "cursor-default",
        className
      )}
      data-active={isActive}
      data-index={index}
      data-slot="transcription-segment"
      onClick={handleClick}
      type="button"
      {...props}
    >
      {segment.text}
    </button>
  );
};
