// INV-01 载荷优先：守住位置 工具载荷分支；改错故障：有工具结果时仍渲染普通分段，内容重复。
// INV-02 双形态：守住位置 载荷选择；改错故障：只认结果或只认调用，另一形态空白。
// INV-03 去空白：守住位置 载荷与分段文本处理；改错故障：首尾空行堆出大片留白。
// INV-04 错误着色：守住位置 错误载荷样式；改错故障：失败输出与成功输出视觉无法区分。
// INV-05 测量有界：守住位置 measureOverflow；改错故障：展开后仍判溢出，按钮永远显示收起。
// INV-06 容差判定：守住位置 高度比较；改错故障：亚像素误差造成假溢出。
// INV-07 卸载安全：守住位置 元素判空；改错故障：首帧无元素时抛错，整块内容不渲染。
// INV-08 监听对称：守住位置 resize 与观察器清理；改错故障：重复挂载后测量回调累积。
// INV-09 展开复位：守住位置 open 变化处理；改错故障：重新打开仍保持上次展开高度。
// INV-10 搜索揭示：守住位置 contentExpanded；改错故障：命中搜索仍被折叠遮罩盖住。
// INV-11 裁剪条件：守住位置 clipped；改错故障：未溢出也显示渐隐与展开按钮。
// INV-12 遮罩固定：守住位置 maskImage；改错故障：渐变随高度缩放，遮罩比例失真。
// INV-13 标签可选：守住位置 名字与标识行；改错故障：缺失元数据时渲染空标签栏。
// INV-14 标识截断：守住位置 标识样式；改错故障：长标识撑破行宽。
// INV-15 文本分段保留：守住位置 无载荷分支；改错故障：普通消息内容完全丢失。
// INV-16 工具头隐藏：守住位置 分段视图参数；改错故障：每段重复渲染工具头。
// INV-17 按钮门控：守住位置 搜索揭示判断；改错故障：搜索命中时仍显示展开按钮。
// INV-18 图标成对：守住位置 展开图标选择；改错故障：展开态仍显示展开图标。
//
// 模块职责：轨迹消息展开态的正文渲染，含溢出测量与展开切换。
// 状态所有权：展开与溢出状态归本组件；消息与文案由外部传入。
// 阅读顺序：类型 → 组件骨架 → 溢出测量 → 展开派生 → 正文与按钮。
import type { ZCodeModelTrajectoryMessage } from "@zcode/services";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ContentPartView } from "@/ModelTrajectoryPaneDetails.js";
import {
  trajectoryToolCallInputs,
  trajectoryToolHasError,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
} from "@/ModelTrajectoryToolPayload.js";

// 从 intl 钩子反推类型，避免直接依赖 react-intl 包；该类型只用于格式化文案，不参与数据推导。
//
type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

export function TrajectoryExpandedContent({
  message,
  role,
  open,
  searchRevealed,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  role: "system" | "user" | "assistant" | "tool";
  open: boolean;
  searchRevealed: boolean;
  intl: IntlShape;
}) {
  // contentRef 只挂在可滚动的正文容器上：测量读的是它的 scrollHeight/clientHeight，
  // 挂到外层 shell 会把标签栏高度也算进溢出判定，导致一条矮消息也显示展开按钮。
  // ref 与下面的两个状态都只服务于测量与展开，不向外暴露。
  const contentRef = useRef<HTMLDivElement>(null);
  // 两个状态各自独立：isOverflowing 只由测量写入，showAll 只由用户按钮与 open 复位写入；
  // 合并成一个状态会让测量结果和用户意图互相覆盖，收起按钮就会失灵。
  // 初始都取 false：首帧按折叠态渲染，等测量结果再决定是否显示按钮。
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // metadata 与错误标记都来自消息本身，不依赖渲染顺序；先取出再分支，避免 JSX 里重复调用。
  // trajectoryToolMetadata 返回 names/ids 两个可选字段，渲染时各自判空（INV-13）。
  const metadata = trajectoryToolMetadata(message);
  // toolPayloadHasError 只看工具结果段是否带 error，与消息级错误无关，所以单独取一次。
  const toolPayloadHasError = trajectoryToolHasError(message);
  // 有 tool-result 就只渲染工具输出，否则退回工具调用入参：两种形态互斥，
  // 同时渲染会让同一段工具内容出现两遍（INV-01/INV-02）。
  // 选择只看 parts 里有没有 tool-result，不看 role：同一 role 也可能既有调用又有结果。
  const toolPayloads = message.parts.some((part) => part.kind === "tool-result")
    ? trajectoryToolOutputs(message)
    : trajectoryToolCallInputs(message);

  // 已展开（showAll）或 ref 尚未挂载时直接返回：前者不必再判溢出，后者首帧高度不可信（INV-05/INV-07）。
  // 回调依赖 showAll：收起后重建回调，下一次 effect 立即重新判定，无需等 resize（INV-09）。
  const measureOverflow = useCallback(() => {
    const element = contentRef.current;
    if (!element || showAll) return;
    // 2px 容差吸收亚像素与缩放误差：严格比较会在 125% 缩放下稳定误报溢出（INV-06）。
    // 这里只写 isOverflowing，不改 showAll：测量不应该替用户收起或展开。
    setIsOverflowing(element.scrollHeight > element.clientHeight + 2);
  }, [showAll]);

  // useLayoutEffect 在浏览器绘制前测量，避免折叠高度先闪一帧再被裁剪；
  // showAll 变化会重建回调并重跑这次测量，收起后立即恢复判定。
  useLayoutEffect(() => {
    measureOverflow();
  }, [measureOverflow]);

  useEffect(() => {
    const element = contentRef.current;
    // 首次渲染时 ref 尚未挂载，直接返回等下一次 effect；这里不能抛错，否则整块消息都不渲染。
    // 依赖里带 measureOverflow，挂载完成后的首次测量就由这次 effect 触发。
    if (!element) return;
    // ResizeObserver 若不存在（旧内核或测试环境），则退化为 null 只监听 window resize，
    // 而不是直接抛错让整块内容不渲染（INV-07）。
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    // 观察的是正文容器而不是 shell：拿 shell 的高度测不出内部滚动，永远不会判定溢出。
    observer?.observe(element);
    // window resize 兜住容器宽度变化引发的换行重排，以及 ResizeObserver 观测不到的字体缩放。
    window.addEventListener("resize", measureOverflow);
    // 清理必须与注册一一对应：漏掉任一条，重复挂载后 measureOverflow 会被调用多次（INV-08）。
    // disconnect 与 removeEventListener 是两套系统，少解绑一个都会留下悬挂回调。
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [measureOverflow]);

  // 折叠时复位展开态：再次打开应回到“未展开”，而不是沿用上次阅读位置（INV-09）。
  // 只依赖 open：搜索揭示关闭不重置用户的手动展开。
  useEffect(() => {
    if (!open) setShowAll(false);
  }, [open]);

  // 展开有两个来源：用户点按钮（showAll）或搜索命中自动揭示（searchRevealed）；
  // searchRevealed 由搜索层传入，组件不自行判断命中。
  // 只要 showAll 或 searchRevealed 成立就不再裁剪，但仍保留 isOverflowing 的测量结果。
  // 裁剪标记同时暴露给样式（data-overflow-clipped）与端到端测试。
  const contentExpanded = showAll || searchRevealed;
  // 裁剪只在“确实溢出且未展开”时成立：未溢出却显示渐隐和按钮会让用户以为还有内容（INV-11）。
  const clipped = isOverflowing && !contentExpanded;
  // 遮罩固定 72px 渐隐而不按百分比：容器高度变化时渐变区不应缩放，否则遮罩比例失真（INV-12）。
  // 裁剪用 max-h-64 与遮罩同开同关：只截断不加渐隐会留下硬切边，看起来像内容被切坏。
  const maskImage = clipped
    ? "linear-gradient(to bottom, black 0%, black calc(100% - 72px), transparent 100%)"
    : undefined;

  // 壳层只做定位、不参与滚动与裁剪，所以裁剪、遮罩与 max-h-64 都落在内层内容容器上，
  // 标签栏、正文与展开按钮的 absolute 定位都以这层为参照。
  return (
    <div data-trajectory-expanded-content-shell="" className="relative min-w-0">
      <div
        ref={contentRef}
        data-trajectory-message-content=""
        data-trajectory-user-content-card={role === "user" ? "" : undefined}
        data-overflow-clipped={clipped || undefined}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1.5 overflow-hidden px-3 pt-0",
          isOverflowing ? "pb-14" : "pb-2",
          !contentExpanded && "max-h-64",
        )}
        style={{ maskImage, WebkitMaskImage: maskImage }}
      >
        {metadata.names || metadata.ids ? (
          <div className="flex min-w-0 items-center gap-1">
            {metadata.names ? (
              <Badge
                data-trajectory-expanded-tool-name=""
                data-trajectory-search-field="tool-name"
                variant="outline"
                className="h-5 rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle"
                title={metadata.names}
              >
                {metadata.names}
              </Badge>
            ) : null}
            {metadata.ids ? (
              <Badge
                data-trajectory-expanded-tool-id=""
                data-trajectory-search-field="tool-id"
                variant="outline"
                className="h-5 min-w-0 truncate rounded-full border-border bg-tag px-2 font-mono text-ui-xs text-foreground-subtle"
                title={metadata.ids}
              >
                {metadata.ids}
              </Badge>
            ) : null}
          </div>
        ) : null}
        {toolPayloads.length > 0
          ? toolPayloads.map((output, outputIndex) => (
              <pre
                key={outputIndex}
                data-trajectory-search-field="content"
                data-trajectory-tool-error-content={toolPayloadHasError ? "" : undefined}
                className={cn(
                  "min-w-0 whitespace-pre-wrap break-words font-mono text-ui-sm leading-relaxed",
                  toolPayloadHasError
                    ? "rounded-lg bg-destructive/10 px-2 py-1.5 text-destructive"
                    : "text-foreground",
                )}
              >
                {output.trim()}
              </pre>
            ))
          : message.parts.map((part, partIndex) => (
              <div key={partIndex} data-trajectory-search-field="content">
                <ContentPartView
                  part={
                    "text" in part && typeof part.text === "string"
                      ? { ...part, text: part.text.trim() }
                      : part
                  }
                  intl={intl}
                  showToolHeader={false}
                />
              </div>
            ))}
      </div>
      {isOverflowing && !searchRevealed ? (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
          <Button
            data-trajectory-overflow-toggle=""
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full bg-surface/90 px-2 text-ui-sm shadow-sm supports-[backdrop-filter]:bg-surface/70 supports-[backdrop-filter]:backdrop-blur-md"
            onClick={() => setShowAll((current) => !current)}
          >
            {showAll ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
            {intl.formatMessage({
              id: showAll ? "modelTrajectory.collapseContent" : "modelTrajectory.showAll",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
