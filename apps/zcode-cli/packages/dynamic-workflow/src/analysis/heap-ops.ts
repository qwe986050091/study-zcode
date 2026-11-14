import ts from "typescript";
import { adoptFields, collapse, emptyValue, mergeInto, replayMayAliasMerge, type AbstractValue } from "./domain.js";
import { mergeIntoRootIdentifier } from "./assign.js";
import type { EvalContext, Evaluator } from "./taint.js";

/**
 * In-place heap-mutation transfers: `Object.assign` and the receiver-mutating array /
 * collection methods (`push`, `Map.set`, …). Extracted from calls.ts (pure move, no
 * behavior change) to keep that file under the line cap.
 */

// 判断一次属性访问是否是 `Object.assign`：要求接收者是全局标识符 Object 且成员名 assign。
// 只做语法形状判定（不看作用域/类型），因此脚本里同名局部遮蔽时会被当成内置——
// 但该判定只会多走"浅拷贝共享字段"的保守路径，不会丢 taint，属于可接受的过近似。
/** `Object.assign` — a free function (not a method) that mutates its target in place. */
export function isObjectAssign(access: ts.PropertyAccessExpression): boolean {
  return ts.isIdentifier(access.expression) && access.expression.text === "Object" && access.name.text === "assign";
}

// 处理原地堆写方法（push/unshift/splice/set/add/send）：把每个实参的 taint 弱并入
// 接收者的"活值"place，使别名视图同步可见；返回值恒为空值（这些方法的结果是长度/自身，
// 不是被追踪的产物，调用方也不该依赖其 taint）。有副作用：会增长活 place，必要时置
// ev.s.changed 驱动不动点。接收者无法解析为 place 时降级为根标识符涂抹，绝不静默丢弃。
export function handleHeapMutator(
  ev: Evaluator,
  node: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  ctx: EvalContext,
): AbstractValue {
  // Resolve the receiver to its LIVE value so a mutator on a nested place
  // (`wrap.items.push(x)`, `state.map.set(k, v)`) writes the shared container, visible
  // through every alias. `Map.set`/`Set.add` fold their args in the same way as the
  // array mutators (key taint included — a sound over-approximation).
  const container = ev.resolvePlace(access.expression, true);
  // An unresolvable receiver (computed element access `state.buffers[i].push(x)`,
  // a call result `log().push(x)`) used to skip BOTH halves of the transfer — the argument
  // taint merged nowhere (a silent total drop of the flow) and the receiver expression was
  // never evaluated, so a facade sink sitting in receiver position was never visited at
  // all. Mirror writeTarget's unresolvable-receiver path (assign.ts): evaluate the receiver
  // for effect and smear each argument into the chain's root identifier.
  if (container === undefined) ev.evalExpr(access.expression, ctx);
  for (const arg of node.arguments) {
    const argVal = collapse(ev.evalExpr(arg, ctx));
    // 有活接收者：只增不改地并进去；有条件绑定/join 元素接收者时，再按可能别名逐个涂一遍。
    if (container !== undefined) {
      if (mergeInto(container, argVal)) ev.s.changed = true;
      // A conditional-binding / join-element receiver mutated in place reaches every
      // candidate place it may BE (weak, inexact).
      if (replayMayAliasMerge(container, argVal)) ev.s.changed = true;
    } else {
      mergeIntoRootIdentifier(ev, access.expression, argVal);
    }
  }
  return emptyValue();
}

/** `Object.assign(target, ...sources)`: merge each source into the target's live value. */
// `Object.assign(target, ...sources)`：每个 source 先按 place 取活值（取不到才求值），
// 然后按"浅拷贝语义"把 source 的字段按引用塞进 target 的活值，同时把 source 的容器级
// taint 弱并入 target；返回值是 target 的值（assign 返回目标本身）。无 target 时返回
// 空值（非法调用，不进图）。副作用为增长 place 并置 changed。
export function handleObjectAssign(ev: Evaluator, node: ts.CallExpression, ctx: EvalContext): AbstractValue {
  const [targetArg, ...sources] = node.arguments;
  if (targetArg === undefined) return emptyValue();
  const targetLive = ev.resolvePlace(targetArg, true);
  const result = ev.evalExpr(targetArg, ctx); // Object.assign returns the target
  for (const src of sources) {
    const srcPlace = ev.resolvePlace(src);
    const srcVal = srcPlace ?? ev.evalExpr(src, ctx);
    if (targetLive !== undefined) {
      // Object.assign shallow-copies: an object-valued source field is copied by
      // REFERENCE, so after the call `target.f` and `src.f` are one shared object and a
      // write through either is visible through the other. When the source is a place,
      // adopt its field objects by reference; container-level occs (and any non-place
      // source, e.g. `{ f: secret }`) still weak-merge in as before, so
      // `Object.assign(target, { f: secret })` makes `target.f` observe secret.
      // The old deep `mergeInto` materialized independent target
      // fields, so a mutation through target's shared sub-object was invisible via src.
      if (srcPlace !== undefined && adoptFields(targetLive, srcPlace)) ev.s.changed = true;
      if (mergeInto(targetLive, srcVal)) ev.s.changed = true;
    }
    mergeInto(result, srcVal);
  }
  return result;
}
