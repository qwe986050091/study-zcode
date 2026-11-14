/**
 * 甘特图条目渲染的样式常量与工具函数。
 *
 * 不变量：`range` 条目保留最小宽度，保证极短区间仍然可见且可被指针命中；
 * `point` 条目不加宽度约束，由调用方以时间点标记呈现，避免被拉成细条。
 */
export const GANTT_BAR_MIN_WIDTH_PX = 18;

type GanttItemType = "range" | "point";

/**
 * 计算甘特条目的内联样式。
 *
 * 输入：`type` 区分区间条（`range`）与时间点（`point`）。
 * 输出：`range` 返回仅含 min-width 的样式串；`point` 返回 undefined，表示不施加宽度约束。
 * 副作用：无，纯函数，渲染层可重复调用。
 */
export function ganttItemStyle(type: GanttItemType): string | undefined {
  if (type !== "range") return undefined;
  return `min-width: ${GANTT_BAR_MIN_WIDTH_PX}px;`;
}
