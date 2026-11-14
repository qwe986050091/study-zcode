// 计算 Agent 目标中位于视口外的下标集合，驱动“还有 N 处”胶囊的方向与计数。
// 边界：只读目标定位与画布矩形，不滚动、不改文档；结果为空时统一为 null，由 Shell 决定显隐。
// 副作用：订阅画布滚动/尺寸变化，并按帧与 500ms 兜底重算；卸载时清理监听、定时器与待执行帧。
import { useEffect, useState, type RefObject } from "react";
import type { AgentPointer } from "#ui/shell/state.ts";

// 屏外目标汇总：indexes 是 Agent targets 中不在可视区的下标，down 表示它们位于视口下方（否则上方）；
// null 表示没有屏外目标（或目标不足 2 个），此时不显示提示，调用方据此隐藏胶囊。
export interface OffscreenTargets {
  indexes: number[];
  down: boolean;
}

// 计算“还有 N 处”提示所需的下标集合：以 canvas 可视矩形为参照，8px 容差避免边缘抖动；
// 只报告单一方向（先下后上），因为胶囊一次只指向一个方向。
// 副作用：滚动时按帧重算，另有 500ms 兜底（图片/字体加载会移动目标而不触发 scroll）。
// 用 JSON 比较新旧结果，相同则保留原引用，避免每次滚动都触发重新渲染。
/**
 * Agent 标出的目标中不在可视区域内的那些，用于「还有 N 处」提示。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模，行为不变；setOffscreen 交还 Shell 供重置文档状态时清空。
 */
// 只在目标数 ≥2 时计算：单个目标不需方向提示，避免首页出现无意义的「还有 1 处」。
// 输入为 Agent 目标与视图引用；输出屏外目标汇总，空结果统一为 null 便于判空。
// 副作用：订阅滚动/尺寸变化重算，卸载时清理；比较结果相同则保持原引用，避免多余渲染。
export function useOffscreenTargets(
  canvasRef: RefObject<HTMLDivElement | null>,
  agent: AgentPointer | null,
) {
  const [offscreen, setOffscreen] = useState<OffscreenTargets | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    // 少于两个目标时没有“还有几处”的意义，直接清空提示，也省掉监听开销。
    if (!canvas || !agent || agent.targets.length < 2) {
      setOffscreen(null);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      const bounds = canvas.getBoundingClientRect();
      const below: number[] = [];
      const above: number[] = [];
      agent.targets.forEach((target, i) => {
        // 当前展示目标不算“屏外”，否则胶囊会与气泡指向同一处。
        if (i === agent.index) return;
        const box = target.locate();
        if (!box) return;
        if (box.top > bounds.bottom - 8) below.push(i);
        else if (box.bottom < bounds.top + 8) above.push(i);
      });
      // 优先提示下方的目标（更常见的阅读方向）；两方向都没有则清空。
      const next = below.length
        ? { indexes: below, down: true }
        : above.length
          ? { indexes: above, down: false }
          : null;
      setOffscreen((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    canvas.addEventListener("scroll", schedule, { capture: true, passive: true });
    const settle = setInterval(schedule, 500);
    return () => {
      canvas.removeEventListener("scroll", schedule, { capture: true });
      clearInterval(settle);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [agent, canvasRef]);
  return [offscreen, setOffscreen] as const;
}
