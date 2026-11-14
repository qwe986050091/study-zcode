// INV-01 折叠高度统一常量：守住位置 模块常量；改错故障 各处高度不一致。
// INV-02 溢出判断带一像素容差：守住位置 isUserInputContentOverflowing；改错故障 临界值反复闪烁。
// INV-03 展开高度不小于折叠高度：守住位置 resolveUserInputContentMaxHeight；改错故障 展开后内容被裁。
// INV-04 收起态固定为折叠高度：守住位置 分支；改错故障 收起仍显示全高。
// INV-05 内容变化即收起：守住位置 effect 依赖；改错故障 换消息后沿用展开态。
// INV-06 高度仅在变化时写入：守住位置 条件 set；改错故障 每次测量触发重渲染。
// INV-07 展开后不再改可展开性：守住位置 expanded 判断；改错故障 展开中按钮消失。
// INV-08 通知按帧合并：守住位置 animationFrameRef；改错故障 长会话测量堆积。
// INV-09 同一消息只排一帧：守住位置 早退分支；改错故障 重复申请帧。
// INV-10 帧号零表示在途：守住位置 哨兵值；改错故障 并发申请覆盖帧号。
// INV-11 尺寸观察优先：守住位置 ResizeObserver；改错故障 内容变化不更新。
// INV-12 不支持时监听窗口：守住位置 回退分支；改错故障 旧环境高度失效。
// INV-13 清理释放观察与监听：守住位置 返回闭包；改错故障 卸载后仍回调。
// INV-14 在途帧必须取消：守住位置 cancelAnimationFrame；改错故障 卸载后访问节点。
// INV-15 引用始终指向最新节点：守住位置 contentRef；改错故障 测量旧节点。
// INV-16 按钮标签随状态切换：守住位置 toggleLabel；改错故障 展开后仍写展开。
// INV-17 按钮带展开语义：守住位置 aria-expanded；改错故障 读屏不知当前状态。
// INV-18 内容容器标记可选：守住位置 data 属性；改错故障 选区引用无法定位。
//
// 模块职责：渲染用户输入正文，按内容高度提供折叠与展开。
// 状态所有权：高度与展开态为组件局部状态；正文由 props 传入。
// 阅读顺序：先看三个纯函数，再看测量 effect，最后看渲染树。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX 是折叠态的统一高度常量。
// scrollHeight 超出该常量时出现展开按钮。
// 展开态高度由 resolveUserInputContentMaxHeight 按内容测量。
export const COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX = 120;
const USER_INPUT_CONTENT_OVERFLOW_TOLERANCE_PX = 1;

// isUserInputContentOverflowing 多留 1px 容差。
// USER_INPUT_CONTENT_OVERFLOW_TOLERANCE_PX 避免边界高度反复抖动。
// isUserInputContentOverflowing 是纯函数，便于独立测试。
export function isUserInputContentOverflowing(scrollHeight: number): boolean {
  return (
    scrollHeight >
    COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX + USER_INPUT_CONTENT_OVERFLOW_TOLERANCE_PX
  );
}

export function resolveUserInputContentMaxHeight(
  expanded: boolean,
  contentScrollHeight: number,
): string {
  const height = expanded
    ? Math.max(contentScrollHeight, COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX)
    : COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX;
  return `${height}px`;
}

export function ConversationUserInputBody({
  children,
  contentText,
  rowId,
}: {
  children: ReactNode;
  contentText: string;
  rowId: string | number;
}) {
  const { intl } = useZCodeIntl();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  // contentScrollHeight 初值取 COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX。
  // setContentScrollHeight 仅在数值变化时更新。
  // contentScrollHeight 供展开高度计算使用。
  const [contentScrollHeight, setContentScrollHeight] = useState(
    COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX,
  );
  const [expandable, setExpandable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const toggleLabel = intl.formatMessage({
    id: expanded ? "chat.message.collapse" : "chat.message.expand",
  });

  useEffect(() => {
    // contentText 或 rowId 变化即收起。
    // setExpanded(false) 避免旧展开态被沿用。
    // effect 依赖 [contentText, rowId]。
    setExpanded(false);
  }, [contentText, rowId]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) {
      setExpandable(false);
      return;
    }

    const updateOverflow = () => {
      const nextScrollHeight = content.scrollHeight;
      setContentScrollHeight((current) =>
        current === nextScrollHeight ? current : nextScrollHeight,
      );
      if (!expanded) {
        const nextExpandable = isUserInputContentOverflowing(nextScrollHeight);
        setExpandable((current) => (current === nextExpandable ? current : nextExpandable));
      }
    };
    // 同一消息只排一帧，animationFrameRef 记录待处理帧。
    // 多个 ResizeObserver 通知合并到同一帧。
    // requestAnimationFrame 缺失时同步执行，兼容测试。
    const scheduleOverflowUpdate = () => {
      if (animationFrameRef.current !== null) return;

      // 长会话会同时 mount 多条 userInput；逐条同步读取 scrollHeight 会把布局测量
      // 堆进同一提交。用 RAF 合并同一条消息的 ResizeObserver 通知，并兼容测试里的同步 RAF。
      animationFrameRef.current = -1;
      const frameId = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        updateOverflow();
      });
      if (animationFrameRef.current !== null) {
        animationFrameRef.current = frameId;
      }
    };

    scheduleOverflowUpdate();

    // 优先使用 ResizeObserver 监听尺寸。
    // 不支持时退回 window resize 监听。
    // 清理函数同时释放 observer 与 resize 监听。
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(scheduleOverflowUpdate);
      observer.observe(content);
    } else {
      window.addEventListener("resize", scheduleOverflowUpdate);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleOverflowUpdate);
      if (animationFrameRef.current !== null && animationFrameRef.current >= 0) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
    };
  }, [contentText, expanded, rowId]);

  const resolvedMaxHeight = resolveUserInputContentMaxHeight(expanded, contentScrollHeight);

  return (
    <div data-conversation-selectable="true" className="relative min-w-0 flex-1">
      <div
        ref={contentRef}
        data-v4-user-input-collapsible-content="true"
        style={{ maxHeight: resolvedMaxHeight }}
        className={cn(
          "min-w-0 overflow-hidden whitespace-pre-wrap break-words transition-[max-height] duration-300 ease-out motion-reduce:transition-none",
          !expanded && expandable
            ? "[mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_70%,transparent_100%)]"
            : "",
        )}
      >
        {children}
      </div>
      {expandable ? (
        <div
          className={cn(
            "flex items-center justify-center",
            expanded ? "w-full pt-2" : "absolute inset-x-0 bottom-0 mx-auto",
          )}
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={toggleLabel}
            aria-expanded={expanded}
            title={toggleLabel}
            onClick={() => setExpanded((current) => !current)}
            className="rounded-full bg-background shadow-sm backdrop-blur-sm transition-colors"
          >
            {expanded ? (
              <ChevronUpIcon aria-hidden="true" className="size-4" />
            ) : (
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
