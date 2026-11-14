/**
 * projection-anchor.ts —— 消息投影锚点(v4 transcript 的 additive 字段)
 *
 * 旧数据可能没有 anchor,读侧必须宽容降级;这里只产出"有值才带"的对象,
 * 避免把 undefined/空串写进持久化 JSON。
 */
import type {
  MessageAnchorOrigin,
  MessageProjectionAnchor,
  SyntheticUserMessageSource,
  TraceContext,
} from "../deps.js";

// ── v4 transcript 锚点（清单）──
// additive JSON：旧数据无 anchor，读侧宽容降级；turnId 取值现成（traceContext）。
// sourceCommandId 在 v4 command inbox 接线后随命令执行上下文写入。
// 只有至少一个字段有值时才返回对象；全空返回 undefined，调用方应省略该字段而非写 null。
// 各字段用条件展开，保证 falsy/空串不会进入持久化 JSON（旧数据无需 anchor 也能读）。
export function buildProjectionAnchor(
  traceContext: TraceContext,
  origin?: MessageAnchorOrigin,
  sourceCommandId?: string,
): MessageProjectionAnchor | undefined {
  if (traceContext.turnId === undefined && origin === undefined && sourceCommandId === undefined) {
    return undefined;
  }
  return {
    ...(traceContext.turnId ? { turnId: traceContext.turnId } : {}),
    ...(origin ? { origin } : {}),
    ...(sourceCommandId ? { sourceCommandId } : {}),
  };
}

// 旧 SyntheticUserMessageSource → v4 userInput.origin 词表的只读映射。
// background_task 与 subagent 统一归为 backgroundResult（对读侧都是后台产物）；
// 未列出的来源（含 goal-continuation 以外的值）一律落到 synthetic，保证返回值必非空。
export function mapSyntheticSourceToAnchorOrigin(
  source: SyntheticUserMessageSource,
): MessageAnchorOrigin {
  switch (source) {
    case "background_task":
    case "subagent":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    default:
      return "synthetic";
  }
}
