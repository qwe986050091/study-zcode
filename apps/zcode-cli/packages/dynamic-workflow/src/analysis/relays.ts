import ts from "typescript";
import { addOcc, collapse, liveField, mergeInto, singleOcc, type AbstractValue } from "./domain.js";
import type { EvalContext, Evaluator } from "./taint.js";

/**
 * Facade sink and relay transfers: `Agent.ask`, `files.glob`/`read` (world reads), and
 * `Promise.all` join relays. Split out of calls.ts (pure move, no behavior change) to keep
 * that file under the line cap; `evalCall` dispatches here via the site lookups.
 */

// 处理 `agent().ask(prompt, instructions?)`：标记当前 region 命中 facade，并把 receiver
//（agent 值）与 instructions 的 collapse 分别记进 askRecv / askInstr 两个 sink。
// 站点查不到（askId 未登记）时只跳过记录、不抛错；instructions 缺省时不建该 sink。
// 其余实参逐个求值只为副作用（其中的 heap 写与 facade sink 不能漏）。
// 返回值是 singleOcc(askId, true)，代表"ask 结果"这一不透明值，无字段结构。
export function handleAsk(ev: Evaluator, node: ts.CallExpression, askId: string, ctx: EvalContext): AbstractValue {
  ev.s.markFacade(ctx.regionStack);
  const site = ev.s.askSites.get(askId);
  if (site !== undefined) {
    ev.s.mergeSink(ev.s.askRecv, askId, collapse(ev.evalExpr(site.receiver, ctx)));
    if (site.instructions !== undefined) {
      ev.s.mergeSink(ev.s.askInstr, askId, collapse(ev.evalExpr(site.instructions, ctx)));
    }
  }
  // Evaluate any extra arguments for their side effects (heap writes etc.).
  node.arguments.forEach((arg, index) => {
    if (index !== 0) ev.evalExpr(arg, ctx);
  });
  return singleOcc(askId, true);
}

// 处理 `files.glob` / `files.read` / `git.diff` 等 world read：每个位置实参都是 sink
//（各 op 元数不同，任一实参携带 artifact 即构成数据依赖），统一记进 worldRead[id]。
// 实参为空时只 markFacade、不产生边；任何实参求值失败都退化为空污点，不抛错。
// 返回值是 singleOcc(id, true)，代表读取结果的不透明值。
export function handleWorldRead(
  ev: Evaluator,
  id: string,
  args: readonly ts.Expression[],
  ctx: EvalContext,
): AbstractValue {
  ev.s.markFacade(ctx.regionStack);
  // Every positional argument is a sink: ops differ in arity (`files.grep(pattern, glob?)`,
  // `git.diff(base?, path?)`), and an artifact reaching any of them is a data dependency.
  for (const arg of args) ev.s.mergeSink(ev.s.worldRead, id, collapse(ev.evalExpr(arg, ctx)));
  return singleOcc(id, true);
}

// 处理 `Promise.all(x)`：返回值是该调用点的 PERSISTENT 节点（state.ts joinResultOf），
// 不是每轮新建值——canonical-heap 不变量要求每个 alias 目标具有跨轮稳定身份。
// 分支口径：静态数组字面量（无 spread）逐元素建立 port 关系，元素的 place 记入 mayAlias
//（`Promise.all([secret, box])` 中 box 解析为它自身）；非字面量/含 spread 的迭代对象退化
// 为 -1 号端口（整只 collapse 并入），无法定位元素时宁可不建端口。
// 合并全部是弱更新：凡有增长即置 ev.s.changed，否则只在 result 增长的轮次会提前收敛，
// 使本轮早先求值的消费者（函数体、后续重读）永远看不到新污点。
export function handleJoin(
  ev: Evaluator,
  node: ts.CallExpression,
  id: string,
  arg: ts.Expression | undefined,
  ctx: EvalContext,
): AbstractValue {
  ev.s.markFacade(ctx.regionStack);
  // The join result is the PERSISTENT node of this call site (state.ts joinResultOf), NOT a
  // fresh value per pass: it is a place other values may-alias, and the canonical-heap
  // invariant requires every alias target to have pass-stable identity. Each merge below is
  // therefore weak and reports its growth into `ev.s.changed` — a pass in which only this
  // node grew must not terminate the fixpoint, or a consumer evaluated earlier in the pass
  // (a function body, a later re-read) would never observe the growth.
  const result = ev.s.joinResultOf(node);
  if (arg !== undefined && ts.isArrayLiteralExpression(arg) && !arg.elements.some(ts.isSpreadElement)) {
    // 元素位置必须是静态可枚举的：一旦出现 spread，端口序号就不可靠，落到下方 portless
    // 分支按整体并入，避免伪造 `res[k]` 的对应关系。
    // Static array literal: element positions become ports.
    arg.elements.forEach((el, port) => {
      const elemValue = ev.evalExpr(el, ctx);
      ev.s.mergeJoinIn(id, port, collapse(elemValue));
      const field = liveField(result, String(port));
      if (mergeInto(field, elemValue)) ev.s.changed = true;
      if (addOcc(field, { exact: true, port, site: id })) ev.s.changed = true;
      // A place element aliases its slot in the resolved tuple: `Promise.all([secret, box])`
      // resolves the non-promise `box` to box ITSELF, so a write through `res[k]` / a
      // destructured element reaches the original (weak, inexact via mayAlias). The field
      // KEEPS the join port occ (added above), so no relay edge is lost.
      const elemPlace = ev.resolvePlace(el);
      if (elemPlace !== undefined) {
        const targets = (field.mayAlias ??= new Set());
        if (!targets.has(elemPlace)) {
          targets.add(elemPlace);
          ev.s.changed = true;
        }
      }
    });
    if (addOcc(result, { exact: true, site: id })) ev.s.changed = true;
    return result;
  }
  // Non-literal iterable: portless in-taint; the result is an additive relay.
  if (arg !== undefined) {
    const argCollapsed = collapse(ev.evalExpr(arg, ctx));
    ev.s.mergeJoinIn(id, -1, argCollapsed);
    if (mergeInto(result, argCollapsed)) ev.s.changed = true;
  }
  if (addOcc(result, { exact: true, site: id })) ev.s.changed = true;
  return result;
}
