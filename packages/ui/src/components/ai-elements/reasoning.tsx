/*
 * Derived from vercel/ai-elements (packages/elements/src/reasoning.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
// Reasoning —— ai-elements 思考过程展示组件族：折叠容器 + 运行时长 + 流式摘要 + 可滚动内容。
// 做：维护开合（受控与非受控）、流式计时、自动收起、延迟卸载、摘要横向滚动与内容滚动遮罩；
//     Trigger 展示思考状态与最后一行流式文本，Content 以纯文本承载完整思考内容。
// 不做：不解析 Markdown、不请求模型、不持久化开合、不决定思考内容如何生成。
// 依赖：radix 的 useControllableState 负责受控桥接，Collapsible 负责高度动画与 Presence，
//     scrollMask 工具负责上下渐隐，QueuedSummaryContent 负责摘要文字的滚动排布。
// 被调用：消息时间线里的思考块；调用方传入 isStreaming、autoCollapseKey 与 streamingText。
// 边界：只做展示与本地交互状态；时长与内容的真实来源都在调用方，本文件不另行计算事实。
//
// INV-01 断言：Context 默认值是 null，缺 Provider 必须抛错 —— 守住它的位置：useReasoning 的 if (!context) —— 改错故障：忘记包裹的调用方会静默渲染出永远收起且点不开的思考块。
// INV-02 断言：受控优先，open 传入时开合只由外部决定 —— 守住它的位置：isOpenControlled 与 useControllableState 的 prop —— 改错故障：内部规则把外部展开态关回，开合反复抖动。
// INV-03 断言：用户交互后自动收起永久失效 —— 守住它的位置：handleOpenChange 里的 userInteractedRef 置位 —— 改错故障：用户刚展开就被下一段流式输出收起。
// INV-04 断言：只有 autoCollapseKey 发生变化才自动收起 —— 守住它的位置：shouldAutoCollapseReasoning 的相等比较 —— 改错故障：同一段输出内反复收起，内容频繁闪烁。
// INV-05 断言：空 key 不触发自动收起 —— 守住它的位置：shouldAutoCollapseReasoning 的 null 判断 —— 改错故障：没有边界信号的调用方永远看不到展开的思考内容。
// INV-06 断言：时长起点只在流式开始时记录一次 —— 守住它的位置：计时 effect 的 startTimeRef === null 判断 —— 改错故障：每次渲染都重置起点，计时永远停在一秒。
// INV-07 断言：流式结束必须先用旧起点结算再清空 —— 守住它的位置：计时 effect 的 !isStreaming 分支顺序 —— 改错故障：顺序颠倒后结算出零秒或负时长。
// INV-08 断言：收起态不得启动每秒定时器 —— 守住它的位置：计时 effect 里的 if (!isOpen) return —— 改错故障：隐藏内容仍持续驱动重渲染，长会话明显掉帧。
// INV-09 断言：每分钟刷新的定时器必须被清理 —— 守住它的位置：计时 effect 的 return 清理函数 —— 改错故障：卸载后继续写入状态，控制台告警并泄漏句柄。
// INV-10 断言：渲染内容与是否展开是两个状态 —— 守住它的位置：shouldRenderContent 的独立 useState —— 改错故障：合并后收起瞬间卸载内容，高度动画直接跳变。
// INV-11 断言：收起后必须等待 300ms 才卸载 —— 守住它的位置：延迟卸载 effect 的 setTimeout —— 改错故障：Radix 在 closed 阶段量不到内容高度，收起动画丢失。
// INV-12 断言：展开时必须取消待执行的卸载任务 —— 守住它的位置：延迟卸载 effect 的展开分支 —— 改错故障：刚展开就被上一轮定时器卸载，内容闪现即消失。
// INV-13 断言：组件卸载必须清掉卸载定时器 —— 守住它的位置：空依赖 effect 的返回函数 —— 改错故障：定时器在卸载后触发状态写入，触发 React 警告。
// INV-14 断言：流式时长至少显示一秒 —— 守住它的位置：updateDuration 的 Math.max(1, ...) —— 改错故障：短回复显示零秒，用户以为计时坏了。
// INV-15 断言：流式摘要只取最后一个非空行 —— 守住它的位置：resolveReasoningStreamingSummary 的倒序循环 —— 改错故障：摘要停在旧行，看起来像不再输出。
// INV-16 断言：摘要 key 使用行号而不是文本 —— 守住它的位置：返回对象里的 key: String(index) —— 改错故障：同文本重复出现时滚动动画不重放。
// INV-17 断言：溢出判定必须保留 1px 容差 —— 守住它的位置：isReasoningSummaryOverflowing 的加法比较 —— 改错故障：亚像素宽度差导致遮罩无端出现。
// INV-18 断言：不溢出时遮罩样式必须返回 undefined —— 守住它的位置：getReasoningSummaryMaskStyle 的提前返回 —— 改错故障：短摘要两端被永久淡出，文字读不全。
// INV-19 断言：观察者必须断开 —— 守住它的位置：摘要与内容两个 effect 的 cleanup —— 改错故障：节点脱离文档后仍被观察，内存与回调持续增长。
// INV-20 断言：思考内容按纯文本渲染 —— 守住它的位置：ReasoningContent 直接输出 children —— 改错故障：接回 Markdown 渲染后每个 chunk 重解析，长思考明显卡顿。
//
// 阅读顺序：先看根组件的四条状态与三个 effect，再看 Trigger 的摘要视口，最后看 Content 的滚动与遮罩。
// 常见误改：删掉 300ms 延迟卸载、把 userInteractedRef 改成 state、把计时器的清理函数省掉。
// 与外部的关系：ReasoningProps 的四个可选属性是对外契约，新增必填属性属于破坏性变更。
// 测试关注点：流式结束后的时长冻结、用户手动展开后不再自动收起、收起动画结束才卸载内容。
// 样式边界：类名只负责布局与弱化色，扫光动画与遮罩渐变属于视觉语义，不要在组件内写死主题色。
// 国际化边界：思考中与已思考等文案全部来自 intl，本文件不保留硬编码文案。
// 性能边界：收起态不跑计时器、内容按纯文本渲染、ResizeObserver 只监听必要的两个节点。
// 可访问性：触发器语义由 Radix 提供，滚动摘要是装饰内容，避免读屏重复播报。
// 维护提示：新增自动收起信号时必须同时考虑用户已交互的短路条件，否则会抢走用户的选择。
// 安全边界：思考内容可能包含敏感片段，本文件只渲染，不上报、不持久化。
"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import { TID_CHAT_REASONING_CONTENT, TID_CHAT_REASONING_TRIGGER } from "@zcode/shared/test-ids";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { QueuedSummaryContent } from "@/ToolCallBlocks/QueuedSummaryContent.js";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import {
  EMPTY_SCROLL_MASK_STATE,
  getVerticalScrollMaskStyle,
  resolveVerticalScrollMaskState,
  type ScrollMetrics,
  type ScrollMaskState,
} from "@/mentions/components/scrollMask.js";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// [契约] Context 只承载四项：流式标记、开合、是否渲染内容、时长与 setter，多一个字段都会扩大重渲染面。
// shouldRenderContent 与 isOpen 必须分开：前者管挂载，后者管显隐，合并会破坏收起动画。
// duration 允许 undefined，表示尚未产生可展示时长，不要用 0 代替。
// [边界] setter 只暴露根组件持有的那个，子件不得自行创建第二份开合状态。
interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  shouldRenderContent: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

// [契约] 默认值 null，缺失 Provider 时由 useReasoning 显式抛错。
// 不要用空对象当默认值：它会让忘记包裹的调用方静默渲染出永远收起的内容。
// Context 不做 selector 化，消费件数量有限，整块重渲染是可接受的成本。
// [权衡] 若后续消费件变多，应拆成两个 context，而不是在这里加记忆化判断。
// [边界] 该 context 不对外导出，只导出读取钩子，保证读取路径唯一。
const ReasoningContext = createContext<ReasoningContextValue | null>(null);

// [契约] 唯一的读取入口，错误信息写明必须包在 Reasoning 内。
// `useReasoning` 在渲染期抛错：属于开发期就能发现的错误，不能降级成警告日志。
// [失败路径] 抛错而不是返回兜底值，避免「按钮点了没反应」这类难查的问题。
// 返回值不做浅拷贝，直接给出 context 引用，减少一次分配。
// [边界] 这里不校验字段合法性，Provider 的构造处负责保证完整。
export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  autoCollapseKey?: string | number | null;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const MS_IN_S = 1000;
const REASONING_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS = 300;
const REASONING_BOTTOM_LOCK_DISTANCE_PX = 2;

// [契约] 自动收起需要同时满足三个条件：有新 key、key 确实变化、用户尚未交互。
// key 为 null 或 undefined 时一律不收起，因为空 key 表示调用方没有提供边界信号。
// [并发] 比较的是上一个 key 而不是当前开合状态，避免同一次流式更新里反复收起。
// 用户交互后的短路是硬约束：自动规则永远不能覆盖用户的手动选择。
// [权衡] 把判断抽成纯函数，是为了让边界条件可以单独测试而不必渲染组件。
export function shouldAutoCollapseReasoning({
  autoCollapseKey,
  previousAutoCollapseKey,
  userInteracted,
}: {
  autoCollapseKey: string | number | null | undefined;
  previousAutoCollapseKey: string | number | null | undefined;
  userInteracted: boolean;
}) {
  return autoCollapseKey != null && autoCollapseKey !== previousAutoCollapseKey && !userInteracted;
}

export function getReasoningBottomDistance({
  clientHeight,
  scrollHeight,
  scrollTop,
}: ScrollMetrics) {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function isReasoningScrollAtBottom(metrics: ScrollMetrics) {
  return getReasoningBottomDistance(metrics) <= REASONING_BOTTOM_LOCK_DISTANCE_PX;
}

// [契约] 根组件是唯一持有开合与计时的位置，子件通过 Context 读取。
// memo 包裹防止父级无关更新导致整块思考内容重渲染。
// 剩余属性整体透传给 Collapsible，调用方仍可覆盖测试标识等属性。
// [边界] 本组件不渲染任何具体文案，标题与摘要都来自子件。
// [权衡] 默认收起而不是默认展开，避免长思考内容在首屏占据过多高度。
export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    autoCollapseKey = null,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const isOpenControlled = open !== undefined;
    // [契约] 开合走受控桥接，open 传入时以外部值为唯一事实。
    // defaultProp 只在首次挂载读取，运行期修改默认值不会生效也不应该生效。
    // onChange 只在内部写入时触发，外部改 prop 不会回调，避免自激循环。
    // [并发] `useControllableState` 在受控切换瞬间可能多渲染一次：属于桥接库的既定行为，不要加防抖掩盖。
    // [边界] 这里不缓存开合值，任何派生都直接用当前值，避免读到过期快照。
    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    // [契约] 开始时间放 ref，不参与渲染，写入不触发重渲染。
    // 流式开始时只记录一次；重复进入该分支不能重置起点，否则时长会回退。
    // 流式结束时按 `startTimeRef` 里那份起点算总时长并立即清空：下一轮不能继承旧起点。
    // [并发] 快速开始、结束、再开始依赖这里的清空动作，漏掉会让第二轮时长包含上一轮。
    // [资源] 不保存日期对象，只保存毫秒数，减少常驻内存。
    const startTimeRef = useRef<number | null>(null);
    // [契约] 延迟卸载的句柄独立保存在 ref，重渲染不会丢失。
    // 它同时被三处使用：展开时取消、收起时注册、卸载时清理，任何一处漏掉都会留下悬挂定时器。
    // [资源] 句柄允许为 null，表示当前没有待执行的卸载任务。
    // [失败路径] 定时器回调里先置空再卸载，避免回调重入时重复清理同一个句柄。
    // [并发] 收起后立刻再展开必须在同一个同步块里取消，否则旧回调会在展开后卸载内容。
    const contentUnmountDelayRef = useRef<number | null>(null);
    const userInteractedRef = useRef(false);
    const previousAutoCollapseKeyRef = useRef<string | number | null>(null);
    // [契约] 初值取开合状态，保证首帧展开时内容立即可见，不出现一帧空白。
    // 它与开合是两个状态：一个管是否挂载，一个管是否显示。
    // [并发] 展开路径在开合回调里同步置真，不等 effect，避免动画开始时内容还没挂载。
    // 收起路径不立即置假，交给延迟卸载 effect 处理。
    // [边界] 该状态只在根组件维护，子件只读，不允许反向写入。
    const [shouldRenderContent, setShouldRenderContent] = useState(() => isOpen);
    // [契约] 任何开合变化都先标记用户已交互，再决定是否需要挂载内容。
    // 标记必须写在最前面：即使后续 setter 抛错，也不能让自动收起再次生效。
    // 展开时立即把是否渲染内容置真，保证高度动画有内容可量。
    // [并发] 依赖数组只放 setter，交互标记走 ref，避免闭包捕获过期的交互状态。
    // [边界] 这里不做开合节流，连续点击的最终值由受控桥接收敛。
    const handleOpenChange = useCallback(
      (nextOpen: boolean) => {
        userInteractedRef.current = true;
        if (nextOpen) {
          setShouldRenderContent(true);
        }
        setIsOpen(nextOpen);
      },
      [setIsOpen],
    );

    // [契约] 该 effect 负责两件事：流式结束后结算时长，流式中按秒刷新。
    // 结束分支必须先结算再清空起点，顺序颠倒会算出零或负时长。
    // [资源] 收起态直接返回，不为隐藏内容跑每秒定时器，这是有意的性能取舍。
    // interval 的清理函数必须返回，否则组件卸载后仍在写入状态。
    // [并发] 依赖包含开合与流式标记，任一变化都会重建定时器，避免读到旧起点。
    useEffect(() => {
      if (!isStreaming) {
        if (startTimeRef.current !== null) {
          setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        }
        startTimeRef.current = null;
        return;
      }

      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }

      // 收起态展示流式摘要，不需要为了隐藏的耗时每秒触发整块 reasoning 重渲染；
      // 展开时再按同一个开始时间补算并持续更新时间。
      if (!isOpen) {
        return;
      }

      const updateDuration = () => {
        if (startTimeRef.current === null) {
          return;
        }
        setDuration(Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S)));
      };

      updateDuration();
      const durationTimer = window.setInterval(updateDuration, MS_IN_S);
      return () => window.clearInterval(durationTimer);
    }, [isOpen, isStreaming, setDuration]);

    // [契约] 先把上一个 key 写进 ref，再判断，保证同一次更新内比较的是上一轮值。
    // 受控时直接返回：外部既然接管开合，本文件就不能再擅自收起。
    // [并发] key 的比较必须发生在写入之前，顺序反了会永远判定为未变化。
    // 用户交互标记用 ref 读取而不是 state，避免它进入依赖导致规则重放。
    // [边界] 该 effect 不清理任何资源，它只做一次性判断。
    useEffect(() => {
      const previousAutoCollapseKey = previousAutoCollapseKeyRef.current;
      previousAutoCollapseKeyRef.current = autoCollapseKey;

      if (isOpenControlled) {
        return;
      }

      // 输出边界是结束收起的补充信号；用户手动操作后，自动规则不能覆盖选择。
      if (
        shouldAutoCollapseReasoning({
          autoCollapseKey,
          previousAutoCollapseKey,
          userInteracted: userInteractedRef.current,
        })
      ) {
        setIsOpen(false);
      }
    }, [autoCollapseKey, isOpenControlled, setIsOpen]);

    // [契约] 展开时立即取消待卸载任务并把内容标记为需渲染。
    // 收起时不马上卸载，而是等 300ms 让高度动画读完真实内容高度。
    // [资源] 返回的清理函数在依赖变化或卸载时清掉句柄，防止旧任务在新的展开态里生效。
    // [失败路径] 内容已标记为不需渲染时直接返回，避免注册空转定时器。
    // [并发] 定时器回调里同时置空句柄与状态，保证下一次收起能重新注册。
    useEffect(() => {
      if (isOpen) {
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

      // 思考内容收起时不能立刻卸载 children。Radix 的高度动画需要
      // closed 阶段仍能读到真实内容高度；先让 300ms 收起动画跑完，再卸载重 DOM。
      contentUnmountDelayRef.current = window.setTimeout(() => {
        setShouldRenderContent(false);
        contentUnmountDelayRef.current = null;
      }, REASONING_CONTENT_COLLAPSE_UNMOUNT_DELAY_MS);

      return () => {
        if (contentUnmountDelayRef.current !== null) {
          window.clearTimeout(contentUnmountDelayRef.current);
          contentUnmountDelayRef.current = null;
        }
      };
    }, [isOpen, shouldRenderContent]);

    useEffect(() => {
      return () => {
        if (contentUnmountDelayRef.current !== null) {
          window.clearTimeout(contentUnmountDelayRef.current);
        }
      };
    }, []);

    // [契约] 五项依赖缺一不可：时长、开合、流式标记、setter、是否渲染内容。
    // 漏掉是否渲染内容会让内容在收起后无法延迟卸载。
    // 漏掉 setter 会让子件拿到旧闭包，开合点击偶发失效。
    // [权衡] 不拆 context 是因为消费件都在同一棵子树内，拆分的收益低于维护成本。
    // [边界] 这里不做深比较，依赖都是原始值或稳定引用。
    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen, shouldRenderContent }),
      [duration, isOpen, isStreaming, setIsOpen, shouldRenderContent],
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose flex flex-col", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
  streamingText?: string;
};

export function scrollReasoningSummaryToEnd(
  viewport: Pick<HTMLElement, "scrollLeft" | "scrollWidth">,
) {
  viewport.scrollLeft = viewport.scrollWidth;
}

export function isReasoningSummaryOverflowing({
  clientWidth,
  scrollWidth,
}: Pick<HTMLElement, "clientWidth" | "scrollWidth">) {
  return scrollWidth > clientWidth + 1;
}

export function resolveReasoningStreamingSummary(
  streamingText: string,
): { key: string; text: string } | null {
  const lines = streamingText.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]?.trim() ?? "";
    if (text.length > 0) {
      return { key: String(index), text };
    }
  }
  return null;
}

const REASONING_SUMMARY_MASK =
  "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";

export function getReasoningSummaryMaskStyle(isOverflowing: boolean): CSSProperties | undefined {
  if (!isOverflowing) {
    return undefined;
  }
  return {
    WebkitMaskImage: REASONING_SUMMARY_MASK,
    maskImage: REASONING_SUMMARY_MASK,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage,
    streamingText = "",
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();
    const { intl } = useZCodeIntl();
    // [契约] 只有流式且收起时才计算摘要，展开后完整内容已经可见，摘要没有意义。
    // 摘要取最后一段非空文本，对齐用户观察最新 token 的直觉。
    // [并发] 该派生只做纯计算，不在这里写入任何状态。
    // [边界] 返回 null 表示没有可展示摘要，触发器据此决定是否渲染右侧区域。
    // [权衡] 摘要不复用完整内容的首段，避免与正文重复展示同一段文字。
    const streamingSummary =
      isStreaming && !isOpen ? resolveReasoningStreamingSummary(streamingText) : null;
    const streamingSummaryRef = useRef<HTMLSpanElement | null>(null);
    const streamingSummaryTextRef = useRef<HTMLSpanElement | null>(null);
    const [isStreamingSummaryOverflowing, setIsStreamingSummaryOverflowing] = useState(false);

    useEffect(() => {
      const viewport = streamingSummaryRef.current;
      if (!viewport || !streamingSummary) {
        return;
      }

      // [契约] 同时同步两件事：是否溢出与是否滚到末尾，二者必须在同一帧完成。
      // 先把滚动位置推到末尾再判断溢出，否则新文本到达时遮罩会滞后一帧。
      // [并发] 溢出状态用函数式更新并做相等短路，避免每次尺寸变化都触发重渲染。
      // [资源] 观察者同时监听视口与文本节点，任一尺寸变化都要重新吸底。
      // [边界] 不支持尺寸观察的环境直接返回，退化为首次同步后的静态展示。
      const syncSummaryViewport = () => {
        setIsStreamingSummaryOverflowing((current) => {
          const next = isReasoningSummaryOverflowing(viewport);
          return current === next ? current : next;
        });
        // 流式摘要超过可用宽度后，普通 overflow-hidden 会固定显示旧前缀，
        // 最新 token 被裁在右侧。每次内容增长后把单行视口推到末尾，让旧内容向左移。
        scrollReasoningSummaryToEnd(viewport);
      };

      syncSummaryViewport();
      if (typeof ResizeObserver === "undefined") {
        return;
      }
      const resizeObserver = new ResizeObserver(syncSummaryViewport);
      resizeObserver.observe(viewport);
      if (streamingSummaryTextRef.current) {
        resizeObserver.observe(streamingSummaryTextRef.current);
      }
      return () => resizeObserver.disconnect();
    }, [streamingSummary?.text]);

    // [契约] 文案优先级：调用方自定义、流式中、未产生时长、已产生时长。
    // 流式中显示动效文案，结束后才显示思考了多久，两者不能同时出现。
    // [边界] 未产生时长与零秒是不同语义，这里用可选值判断而不是数值比较。
    // [权衡] 文案全部走 intl，不在组件内拼接语序，避免不同语言顺序写死。
    // 该值只用于渲染，不进入 Context，避免切换文案导致内容重渲染。
    const thinkingMessage =
      getThinkingMessage?.(isStreaming, duration) ??
      (isStreaming && !isOpen ? (
        <span className="animated-gradient-text font-medium">
          {intl.formatMessage({ id: "chat.reasoning.thinking" })}
        </span>
      ) : duration === undefined ? (
        <span className="inline-flex items-center gap-2">
          {/* 完成态“思考”单独使用 semibold，比同列工具类型标签更粗。
              统一为 medium，保持对话时间线的视觉层级一致。 */}
          <span className="font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.reasoning.thought" })}
          </span>
          <span className="font-normal text-foreground-subtlest">·</span>
          <span className="font-normal text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.reasoning.durationFewSeconds" })}
          </span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className="font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.reasoning.thought" })}
          </span>
          <span className="font-normal text-foreground-subtlest">·</span>
          <span className="font-normal text-foreground-subtlest">
            {intl.formatMessage(
              { id: "chat.reasoning.durationSeconds" },
              { seconds: String(duration) },
            )}
          </span>
        </span>
      ));

    return (
      <CollapsibleTrigger
        data-testid={TID_CHAT_REASONING_TRIGGER}
        className={cn(
          "group/reasoning inline-flex max-w-full min-w-0 items-center gap-2 self-start text-ui-base transition-colors",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            {/* thinking 会在长流式回复里持续存在，旋转 loader 会长期占用渲染资源；
            运行态保留文案扫光，图标固定为静态思考语义。 */}
            <BrainIcon className="size-4 shrink-0 text-foreground-subtlest" />
            {/* 右侧流式摘要是可伸缩内容；如果左侧标签也参与 flex shrink，
                长摘要会把思考状态标签挤成多行。固定语义标签宽度，只让摘要占剩余空间。 */}
            <span className="shrink-0 whitespace-nowrap" data-reasoning-label="true">
              {thinkingMessage}
            </span>
            {streamingSummary ? <span className="shrink-0 text-foreground-subtlest">·</span> : null}
            {streamingSummary ? (
              <span
                ref={streamingSummaryRef}
                className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-foreground-subtle"
                data-reasoning-streaming-mask={isStreamingSummaryOverflowing ? "both" : "none"}
                data-reasoning-streaming-line="true"
                data-reasoning-streaming-roll="true"
                style={getReasoningSummaryMaskStyle(isStreamingSummaryOverflowing)}
              >
                <QueuedSummaryContent
                  contentKey={`reasoning-line:${streamingSummary.key}`}
                  contentRefreshVersion={streamingSummary.text}
                  primaryText={
                    <span
                      ref={streamingSummaryTextRef}
                      className="inline-block min-w-max"
                      data-reasoning-streaming-text="true"
                    >
                      {streamingSummary.text}
                    </span>
                  }
                  enabled
                />
              </span>
            ) : null}
            <ChevronRightIcon
              className={cn(
                "size-4 shrink-0 text-foreground-subtlest transition-opacity transition-transform",
                isOpen
                  ? "rotate-90 opacity-100"
                  : "rotate-0 opacity-0 group-hover/reasoning:opacity-100",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
  variant?: "default" | "nested";
};

export const ReasoningContent = memo(
  ({ className, children, forceMount, variant = "default", ...props }: ReasoningContentProps) => {
    const { isOpen, shouldRenderContent } = useReasoning();
    // [契约] 三个来源取或：正在展开、尚未完成延迟卸载、外部强制挂载。
    // forceMount 是调用方绕过卸载优化的唯一开关，保留它是为了兼容外部动画库。
    // [并发] 该值每次渲染重算，不缓存，保证收起瞬间立刻切换到延迟卸载路径。
    // [边界] 它只决定是否渲染内容，不决定动画容器的挂载，两者职责不同。
    // [权衡] 关闭时返回空而不是隐藏节点，避免长文本继续占用布局与内存。
    const shouldRenderChildren = isOpen || shouldRenderContent || Boolean(forceMount);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const autoFollowBottomRef = useRef(true);
    const [scrollMaskState, setScrollMaskState] =
      useState<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE);
    // [契约] 遮罩状态完全由滚动容器的三个尺寸推导，不额外保存滚动位置。
    // 节点不存在时显式复位成空状态，避免沿用上一个容器的遮罩。
    // [并发] 滚动事件与尺寸观察都会调用它，函数本身必须幂等。
    // [资源] 依赖数组为空，是因为它只读容器引用，不捕获任何外部变量。
    // [边界] 这里不做节流，滚动回调本身足够轻，节流反而会让遮罩滞后。
    const updateScrollMaskState = useCallback(() => {
      const scrollNode = scrollRef.current;
      if (!scrollNode) {
        setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
        return;
      }

      setScrollMaskState(
        resolveVerticalScrollMaskState({
          clientHeight: scrollNode.clientHeight,
          scrollHeight: scrollNode.scrollHeight,
          scrollTop: scrollNode.scrollTop,
        }),
      );
    }, []);
    const scrollToReasoningBottom = useCallback(() => {
      const scrollNode = scrollRef.current;
      if (!scrollNode) {
        return;
      }

      scrollNode.scrollTop = scrollNode.scrollHeight;
      updateScrollMaskState();
    }, [updateScrollMaskState]);
    const handleScroll = useCallback(() => {
      const scrollNode = scrollRef.current;
      if (!scrollNode) {
        return;
      }

      autoFollowBottomRef.current = isReasoningScrollAtBottom({
        clientHeight: scrollNode.clientHeight,
        scrollHeight: scrollNode.scrollHeight,
        scrollTop: scrollNode.scrollTop,
      });
      updateScrollMaskState();
    }, [updateScrollMaskState]);

    useEffect(() => {
      if (!shouldRenderChildren) {
        autoFollowBottomRef.current = true;
        setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
        return;
      }

      const scrollNode = scrollRef.current;
      if (!scrollNode || typeof ResizeObserver === "undefined") {
        if (autoFollowBottomRef.current) {
          scrollToReasoningBottom();
        } else {
          updateScrollMaskState();
        }
        return;
      }

      // thought 内容流式追加时 scrollHeight 会变化；同时监听容器和内容尺寸。
      // 默认吸底跟随最新思考；用户主动离底后暂停，直到用户自己滚回底部再恢复。
      const syncScrollPosition = () => {
        if (autoFollowBottomRef.current) {
          scrollToReasoningBottom();
          return;
        }
        updateScrollMaskState();
      };
      syncScrollPosition();
      const resizeObserver = new ResizeObserver(syncScrollPosition);
      resizeObserver.observe(scrollNode);
      if (contentRef.current) {
        resizeObserver.observe(contentRef.current);
      }

      return () => {
        resizeObserver.disconnect();
      };
    }, [scrollToReasoningBottom, shouldRenderChildren, updateScrollMaskState]);

    useEffect(() => {
      if (!shouldRenderChildren) {
        return;
      }
      if (autoFollowBottomRef.current) {
        scrollToReasoningBottom();
        return;
      }
      updateScrollMaskState();
    }, [children, scrollToReasoningBottom, shouldRenderChildren, updateScrollMaskState]);

    const scrollMaskStyle = getVerticalScrollMaskStyle(scrollMaskState);
    const scrollMaskData =
      scrollMaskState.showTop && scrollMaskState.showBottom
        ? "both"
        : scrollMaskState.showTop
          ? "top"
          : scrollMaskState.showBottom
            ? "bottom"
            : "none";

    return (
      <CollapsibleContent
        data-reasoning-content="true"
        data-reasoning-content-variant={variant}
        data-testid={TID_CHAT_REASONING_CONTENT}
        forceMount={forceMount}
        className={className}
        {...props}
      >
        {shouldRenderChildren ? (
          <div className="pt-3">
            <div
              ref={scrollRef}
              className={cn(
                "max-h-60 space-y-2 overflow-auto text-ui-base text-foreground-subtlest",
                // CUA Group 已提供清晰的父级边界；子思考继续显示左导线与缩进会形成重复层级。
                variant === "default" && "ml-2 border-border border-l pl-3.5",
              )}
              data-reasoning-scroll-mask={scrollMaskData}
              onScroll={handleScroll}
              style={scrollMaskStyle}
            >
              {/* 思考块之前打开时把 Radix content 一起按需挂载并强制 forceMount，
                  content 首帧已经是 open 状态，高度动画来不及从 closed 状态过渡，看起来像突然展开。
                  这里和工具详情保持一致：CollapsibleContent 只负责 Presence/高度动画，重内容单独延迟卸载；
                  间距放在动画内容内部，避免 closed 动画结束时父级 gap/padding 被移除造成末帧跳动。
                  性能修复：thought 内容可能非常长且会流式追加，展开后如果继续走 MessageResponse/Streamdown，
                  每次 chunk 都会重跑 Markdown 解析和插件渲染，字数越多越卡；这里按纯文本展示并保留换行。 */}
              <div
                ref={contentRef}
                className="min-w-0 whitespace-pre-wrap break-words text-foreground-subtlest"
              >
                {children}
              </div>
            </div>
          </div>
        ) : null}
      </CollapsibleContent>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
