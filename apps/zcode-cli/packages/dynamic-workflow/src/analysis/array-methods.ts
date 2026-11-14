import ts from "typescript";
import type { IterationCandidate } from "./sites.js";
import {
  addOcc,
  cloneValue,
  collapse,
  emptyValue,
  mergeInto,
  provisionalFanoutId,
  unionValues,
  type AbstractValue,
} from "./domain.js";
import { applyCallbackFns } from "./calls.js";
import type { EvalContext, Evaluator } from "./taint.js";

/**
 * Per-element callback calls (the callback registry's `each` entries — `map` / `forEach` /
 * `reduce` / … on a receiver, `Array.from(xs, fn)`) promoted to fan-out relays: `iterated`
 * fans out to the callback's element parameter(s), the callback body runs in a
 * `cand@<order>` region, and its return joins back. `evalCall` dispatches here via
 * `candByCall`.
 *
 * Two callback shapes, one contract:
 *  - an INLINE literal is evaluated in place with its parameters bound directly (it is not a
 *    tracked function — the callback IS the body);
 *  - any other expression (`xs.map(review)`, `xs.map(this.f)`) is evaluated to its function
 *    values and those tracked functions are applied with registry-shaped positional actuals,
 *    recorded as `argument` applications at the call so the ordering walk inlines the same
 *    bodies inside the same `fanout` region.
 */
export function handleArrayMethod(
  ev: Evaluator,
  node: ts.CallExpression,
  cand: IterationCandidate,
  ctx: EvalContext,
): AbstractValue {
  // 职责：把一个已登记的迭代回调调用（map/forEach/reduce/Array.from 等）求值成抽象值，
  // 同时把回调按元素展开成 fan-out 区域、把回调返回值合并回调用点结果。
  // 输入：node 为调用表达式（用于取 reduce 初始值实参与记录 application），cand 提供
  // iterated / callback / callbackExpr / order / semantics（semantics 可缺省，缺省时按
  // element=0、whole=2、无 accumulator 的默认形状处理）。
  // 输出：回调返回 ∪ 元素值；无回调可应用时退化为元素值本身，不会是 undefined。
  // 副作用：写 Evaluator 状态（fanoutInVal、promotedOrders 的 sink、changed 标记、
  // reduceAcc、fnId 应用记录），因此必须在 fixpoint 循环内调用，且重复调用是幂等的收敛行为。
  // 失败语义：参数缺失/未解析一律静默跳过（不抛错），保证分析尽量保守地继续。
  // 不变量：element 是 iterated 的克隆并携带 fan-out occ；回调参数的绑定都走同一份 clone，
  // 保证回调内读到的元素与传出结果同源。
  const semantics = cand.semantics;
  const iterated = collapse(ev.evalExpr(cand.iterated, ctx));
  const fanoutId = provisionalFanoutId(cand.order);
  const promoted = ev.s.promotedOrders.has(cand.order);
  if (promoted) ev.s.mergeSink(ev.s.fanoutInVal, fanoutId, iterated);

  const element = cloneValue(iterated);
  // 只有被提升（promoted）的 fan-out 才挂标签：未提升时该调用按普通局部值处理，不应虚构 fan-out 出处。
  if (promoted) addOcc(element, { exact: true, site: fanoutId });

  const regionStack = [...ctx.regionStack, `cand@${cand.order}`];
  const isReduce = semantics?.accumulatorParam !== undefined;
  const elementParams = semantics?.elementParams ?? [0];
  const wholeParams = semantics?.wholeParams ?? [2];

  // The accumulator (reduce): initial-value argument ∪ the callback return chained across
  // fixpoint passes. The callback return is a FRESH local each fixpoint pass and is
  // empty when we bind the param, so binding acc from it directly never carries the callback's
  // return taint — sequential ask-chaining through the accumulator would be silently dropped. A
  // persistent per-candidate accumulator (seeded from prior passes' returns) lets the
  // accumulator's taint reach the body and converge like everything else.
  // With NO initial-value argument the accumulator starts as element 0 at runtime, so
  // the seed is the element value (not empty) — otherwise the first element's taint never
  // reaches the body through the accumulator.
  const seedArg = node.arguments[1];
  const accumulator = (): { place?: AbstractValue; value: AbstractValue } => {
    // 每次调用都重新取跨 fixpoint 的链；chain 只在 reduce 场景有内容，其它场景为空值。
    const chain = ev.s.reduceAccOf(cand.order);
    const seedPlace = seedArg === undefined ? undefined : ev.resolvePlace(seedArg);
    if (seedPlace !== undefined) {
      // The initial value is a PLACE: at runtime the accumulator IS that object until the
      // callback returns something else (`acc.items.push(item)` fills the seed), so alias acc
      // to the live seed. JOIN the cross-pass callback-return chain into it — never replace:
      // for a reduce that returns a FRESH object each iteration, losing the chain component
      // would drop the accumulator's carried taint. Spurious later writes into the seed are a
      // sound over-approximation — a cloned seed would instead keep
      // `acc.items.push` from reaching the live seed.
      if (mergeInto(seedPlace, chain)) ev.s.changed = true;
      return { place: seedPlace, value: seedPlace };
    }
    const initial = seedArg === undefined ? element : ev.evalExpr(seedArg, ctx);
    return { value: unionValues(initial, chain) };
  };

  const callbackReturn = emptyValue();
  const cb = cand.callback;
  if (cb !== undefined) {
    const cbCtx: EvalContext = {
      onReturn: (value) => void mergeInto(callbackReturn, value),
      regionStack,
    };
    if (isReduce) bindCallbackParam(ev, cb, semantics?.accumulatorParam ?? 0, accumulator().value, cbCtx);
    // Element parameters bind the fanned-out element; the standard whole-collection parameter
    // (the third of `map`-likes) IS the receiver at runtime, so it binds the same fanned-out
    // value: reads of it inside the promoted callback are downstream of the fan-out, same as
    // element reads. A positional index parameter stays unbound — it carries no element data
    // (same convention as a ternary condition / computed key), so it originates no data edge.
    elementParams.forEach((index, i) => bindCallbackParam(ev, cb, index, i === 0 ? element : cloneValue(element), cbCtx));
    for (const index of wholeParams) bindCallbackParam(ev, cb, index, cloneValue(element), cbCtx);

    if (ts.isBlock(cb.body)) {
      // 块体：逐语句求值，return 值经 cbCtx.onReturn 汇总，因此中途 return 与末尾 return 语义一致。
      for (const stmt of cb.body.statements) ev.visit(stmt, cbCtx);
    } else {
      // 箭头函数的表达式体等价于隐式 return，直接并入 callbackReturn。
      mergeInto(callbackReturn, ev.evalExpr(cb.body, cbCtx));
    }
  } else if (cand.callbackExpr !== undefined) {
    // Non-literal callback: apply every script function the argument holds, per element, with
    // the registry's positional shape. An untracked value (`xs.map(Boolean)`) applies nothing;
    // the element still flows to the result as it did before.
    const fns = [...ev.evalExpr(cand.callbackExpr, ctx).fns].filter((fn) => ev.s.fnId.has(fn));
    if (fns.length > 0) {
      // 槽位数由所有可能位置的参数下标取最大值 +1 推出；因此未被语义登记的槽位保持空值，
      // 不会把「位置不存在」误当成「位置传了空」。
      const slots = Math.max(-1, ...elementParams, ...wholeParams, semantics?.accumulatorParam ?? -1) + 1;
      const actuals: AbstractValue[] = Array.from({ length: slots }, () => emptyValue());
      if (isReduce) actuals[semantics?.accumulatorParam ?? 0] = accumulator().value;
      for (const index of elementParams) actuals[index] = cloneValue(element);
      for (const index of wholeParams) actuals[index] = cloneValue(element);
      mergeInto(callbackReturn, applyCallbackFns(ev, fns, actuals, regionStack, node));
    }
  }

  // Element-mutation write-back: the element parameter may-aliases the collection's elements
  // (they are references at runtime), so a field written through it (`x.note = t`) must reach
  // the collection. Weak-merge the element's FIELD effects (collapsed) into the collection
  // place's occs — a later `xs[k].note` read smears them out. Only element FIELDS propagate:
  // the element's seed occs and fan-out label live in `occs`, so they never flow back (no
  // fan-out self-label).
  const collectionPlace = ev.resolvePlace(cand.iterated);
  if (collectionPlace !== undefined) {
    // 接收者必须是可寻址的 place 才能回写；临时表达式（如 xs.filter(...).map(...) 的中间数组）
    // 没有 place，其元素字段改动只影响本轮抽象值，不落回原集合——这是有意的保守近似。
    for (const field of element.fields.values()) {
      // 只对字段做 collapse 后弱合并，保留 collectionPlace 已有的精确 occ，避免破坏其别名信息。
      if (mergeInto(collectionPlace, collapse(field))) ev.s.changed = true;
    }
  }

  // Thread this pass's callback return into the persistent accumulator so the next
  // pass's accumulator param observes it (drives the reduce chain to a fixpoint).
  if (isReduce) ev.s.mergeReduceAcc(cand.order, callbackReturn);

  // Result: callback return ∪ element value (the fan-out label already rides on element).
  return unionValues(callbackReturn, element);
}

function bindCallbackParam(
  ev: Evaluator,
  cb: ts.FunctionExpression | ts.ArrowFunction,
  index: number,
  value: AbstractValue,
  ctx: EvalContext,
): void {
  // 按位置下标把抽象值绑定到回调形参；内部函数，只服务上方两种回调形态。
  // index 越界（语义登记了下标但源码参数更少）时直接跳过：运行时该位置本就是 undefined，
  // 不绑定即可，不能抛出或补造参数。绑定时统一走 bindPattern 以支持解构形参。
  const param = cb.parameters[index];
  if (param === undefined) return;
  // Route through the Evaluator's pattern machinery so a binding-pattern parameter
  // (`.map(({ q }) => …)`, `.then(([x, y]) => …)`) binds its extracted names. The
  // old identifier-only guard silently bound nothing for a destructured param, dropping
  // both the element's taint and the fan-out label into every read of the pattern's names.
  ev.bindPattern(param.name, value, ctx);
}
