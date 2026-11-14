// INV-01 拖动占比不进 React state：守住位置 dragRef；改错故障 pane 子树每帧重渲染。
// INV-02 拖动中只写 CSS 变量：守住位置 帧回调；改错故障 布局抖动。
// INV-03 每帧最多一次写入：守住位置 帧号判断；改错故障 指针事件洪泛。
// INV-04 主轴像素拖动期恒定：守住位置 regionPx；改错故障 占比随窗口漂移。
// INV-05 区域为零回退起点：守住位置 早退；改错故障 除零得到无穷大。
// INV-06 占比夹在合法区间：守住位置 clampSplitRatio；改错故障 面板被拖出边界。
// INV-07 只响应主键鼠标：守住位置 按键判断；改错故障 右键拖动误触。
// INV-08 指针捕获失败可继续：守住位置 try 块；改错故障 合成事件下拖动失效。
// INV-09 指针 id 必须匹配：守住位置 身份比较；改错故障 多指拖动互相抢占。
// INV-10 结束取消在途帧：守住位置 cancelAnimationFrame；改错故障 末帧覆盖最终值。
// INV-11 结束立即写入最终值：守住位置 设置属性；改错故障 松手后闪回。
// INV-12 结束一次性提交仓库：守住位置 onCommitRatio；改错故障 拖动过程频繁持久化。
// INV-13 卸载清理在途帧：守住位置 effect 返回闭包；改错故障 卸载后仍操作容器。
// INV-14 高亮态仅本地：守住位置 dragging；改错故障 全局状态被拖动污染。
// INV-15 角色为分隔条：守住位置 role；改错故障 读屏不知可调整。
// INV-16 方向映射无障碍朝向：守住位置 aria-orientation；改错故障 横竖方向播报相反。
// INV-17 触摸操作交给指针事件：守住位置 touch-none；改错故障 移动端触发滚动。
// INV-18 组件按 props 记忆化：守住位置 memo；改错故障 父级渲染连带重绘。
//
// 模块职责：渲染可拖拽的分屏分隔条，按行或列调整两侧占比。
// 状态所有权：拖动事实归引用；仅高亮态为组件本地状态。
// 阅读顺序：先看拖动换算，再看三个指针回调，最后看清理与渲染。
// 分屏拖拽分隔条（rAF + CSS 变量方案按分割节点泛化，行/列双向）：
// pointer capture 驱动，拖动中占比只走容器 CSS 变量（ref + rAF 合帧），
// 不进 React state——pane 内容子树在拖动期间零重渲染；
// pointerup 一次性提交到 paneLayoutStore（进持久化）。
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { TID_V4_SPLIT_DIVIDER } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { clampSplitRatio, type SplitDirection } from "@/v4/paneLayoutTree.js";
import { SPLIT_VAR_PREFIX } from "@/v4/workbenchLayout.js";

interface SplitDividerDragState {
  pointerId: number;
  /** 该分割节点区域主轴像素长度（containerRect 主轴 × regionFraction，拖动期间恒定）。 */
  regionPx: number;
  startClient: number;
  startRatio: number;
  latestClient: number;
  rafId: number | null;
}

export interface WorkbenchSplitDividerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  splitId: string;
  direction: SplitDirection;
  /** 当前已提交占比（store 值）；仅作为拖动起点，拖动过程不依赖它重渲染。 */
  ratio: number;
  /** 该分割节点区域占容器主轴的数值比例（拖拽像素→占比换算）。 */
  regionFraction: number;
  style: CSSProperties;
  onCommitRatio: (splitId: string, ratio: number) => void;
}

export const WorkbenchSplitDivider = memo(function WorkbenchSplitDivider({
  containerRef,
  splitId,
  direction,
  ratio,
  regionFraction,
  style,
  onCommitRatio,
}: WorkbenchSplitDividerProps) {
  // dragRef 存放 SplitDividerDragState，拖动期间不触发 React 重渲染。
  // 不触发 React 重渲染。
  // pointerup 与卸载时都把 dragRef.current 置回 null。
  const dragRef = useRef<SplitDividerDragState | null>(null);
  // 仅分隔条自身的高亮态；切换时 memo pane 子树不受影响。
  // dragging 只驱动分隔条自身高亮，memo 后的 pane 子树不重绘。
  // 不进入 pane 子树。
  // pointerdown 时先 setDragging(true)，endDrag 时再置 false，各提交一次。
  const [dragging, setDragging] = useState(false);
  const isRow = direction === "row";

  // ratioFromDrag 在 drag.regionPx <= 0 时直接返回 startRatio。
  // 位移 latestClient - startClient 除以 regionPx 得到占比增量。
  // clampSplitRatio 把结果夹在合法区间，面板不会被拖出边界。
  const ratioFromDrag = useCallback((drag: SplitDividerDragState): number => {
    if (drag.regionPx <= 0) {
      return drag.startRatio;
    }
    return clampSplitRatio(
      drag.startRatio + (drag.latestClient - drag.startClient) / drag.regionPx,
    );
  }, []);

  // pointerdown 只在 event.button !== 0 且 pointerType === "mouse" 时忽略。
  // setPointerCapture 包在 try 里，e2e 合成事件失败也不中断拖动。
  // dragRef.current 写入 pointerId、regionPx、startClient/startRatio 三个字段。
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") {
        return;
      }
      const container = containerRef.current;
      if (!container) {
        return;
      }
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // e2e 合成 PointerEvent 无活跃 pointerId 时 capture 会抛错；拖动逻辑不依赖 capture 成立。
      }
      const containerRect = container.getBoundingClientRect();
      const client = isRow ? event.clientX : event.clientY;
      dragRef.current = {
        pointerId: event.pointerId,
        regionPx:
          (isRow ? containerRect.width : containerRect.height) * regionFraction,
        startClient: client,
        startRatio: ratio,
        latestClient: client,
        rafId: null,
      };
      setDragging(true);
    },
    [containerRef, isRow, ratio, regionFraction],
  );

  // handlePointerMove 先比对 event.pointerId 与 drag.pointerId。
  // rafId 非 null 说明已有在途帧，本帧直接返回。
  // requestAnimationFrame 回调里只写 SPLIT_VAR_PREFIX + splitId 的 CSS 变量。
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      drag.latestClient = isRow ? event.clientX : event.clientY;
      if (drag.rafId !== null) {
        return;
      }
      drag.rafId = requestAnimationFrame(() => {
        drag.rafId = null;
        containerRef.current?.style.setProperty(
          `${SPLIT_VAR_PREFIX}${splitId}`,
          String(ratioFromDrag(drag)),
        );
      });
    },
    [containerRef, isRow, ratioFromDrag, splitId],
  );

  // endDrag 先 cancelAnimationFrame(drag.rafId) 并置 null。
  // 末次坐标写入 drag.latestClient 后立即算出 finalRatio。
  // onCommitRatio 在 pointerup 时一次性提交，拖动过程不持久化。
  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      if (drag.rafId !== null) {
        cancelAnimationFrame(drag.rafId);
        drag.rafId = null;
      }
      drag.latestClient = isRow ? event.clientX : event.clientY;
      const finalRatio = ratioFromDrag(drag);
      containerRef.current?.style.setProperty(
        `${SPLIT_VAR_PREFIX}${splitId}`,
        String(finalRatio),
      );
      dragRef.current = null;
      setDragging(false);
      // 提交进 store（→ localStorage）；容器 style 下次渲染写入同值，无视觉跳变。
      onCommitRatio(splitId, finalRatio);
    },
    [containerRef, isRow, onCommitRatio, ratioFromDrag, splitId],
  );

  // 卸载（布局变化/关 pane）时清理未跑完的 rAF。
  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.rafId != null) {
        cancelAnimationFrame(drag.rafId);
      }
      dragRef.current = null;
    },
    [],
  );

  return (
    <div
      data-testid={TID_V4_SPLIT_DIVIDER}
      data-split-id={splitId}
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      data-dragging={dragging ? "true" : "false"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={style}
      className={cn(
        "group absolute z-10 touch-none select-none",
        isRow ? "cursor-col-resize" : "cursor-row-resize",
      )}
    >
      <div
        className={cn(
          "pointer-events-none transition-colors",
          isRow ? "mx-auto h-full w-px" : "my-auto h-px w-full",
          dragging
            ? "bg-[var(--color-brand)]"
            : "bg-[var(--color-border)] group-hover:bg-[var(--color-brand)]",
        )}
      />
    </div>
  );
});
