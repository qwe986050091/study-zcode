import ts from "typescript";
import {
  adoptFields,
  cloneValue,
  collapseInto,
  emptyValue,
  mergeInto,
  type AbstractValue,
} from "./domain.js";
import type { EvalContext, Evaluator } from "./taint.js";

/**
 * Array- and object-literal evaluation, split out of the core evaluator (taint.ts) like
 * the call/relay rules in calls.ts — same `Evaluator` instance, free-function shape. A
 * container literal is field-sensitive: a place element/property stores the LIVE value it
 * denotes (aliasing), and spread copies its source's fields by reference (shallow copy).
 *
 * Both functions build a FRESH value for this pass; the evaluator hands it to
 * `state.literalPlaceOf`, which adopts it on first sight and merges it into the persistent
 * allocation-site place afterwards. So the value that flows on from a literal is storage
 * that survives the pass (a callee may write through it), and the `changed` signal for a
 * re-evaluation that grew is raised there — neither function touches `ev.s.changed`.
 */

// 求数组字面量的值：元素是 place 时存"活引用"（数组元素与变量共享同一对象），
// 否则按元素位置（"0"、"1"…）放进 fields；展开元素按浅拷贝共享（仅单一展开的 place 情形，
// 其余按值折叠，不建模引用共享）。返回本次遍历的新值，不触碰 ev.s.changed——写入持久
// 分配点 place 并上报增长是 state.literalPlaceOf 的职责。
export function evalArrayLiteral(ev: Evaluator, node: ts.ArrayLiteralExpression, ctx: EvalContext): AbstractValue {
  const out = emptyValue();
  if (node.elements.some((el) => ts.isSpreadElement(el))) {
    // Sole-spread `[...xs]` where xs is a place: array spread shallow-copies, so each
    // numeric element reference is shared (a write through `copy[k]` stays visible via
    // `xs[k]`) — a plain fold would drop that sharing, hence spreadShare below.
    // A spread beside other elements, or a non-place spread, still folds by value;
    // reference sharing is not modeled for those cases.
    const sole = node.elements[0];
    if (node.elements.length === 1 && sole !== undefined && ts.isSpreadElement(sole) && spreadShare(ev, out, sole.expression)) {
      return out;
    }
    for (const el of node.elements) collapseInto(out, ev.evalExpr(el, ctx));
    return out;
  }
  // An element that is a place stores the LIVE reference, so an object stored in an array
  // stays aliased with its name (a write through either is seen through both).
  node.elements.forEach((el, index) => out.fields.set(String(index), fieldValue(ev, el, ctx)));
  return out;
}

// 求对象字面量的值，逐成员分派：普通属性/简写属性/展开/方法/取值器/计算键。
// 静态键的成员放进 fields（值是 place 时存活引用）；计算键无法追踪名，把键表达式与
// 值都折叠进容器 occs（键字符串也是可观察属性名，taint 一并记上，字符串不洗白）。
// 方法存成可调用的函数值，取值器存返回摘要的克隆；只写成员、不改变外部状态。
export function evalObjectLiteral(ev: Evaluator, node: ts.ObjectLiteralExpression, ctx: EvalContext): AbstractValue {
  const out = emptyValue();
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && !ts.isComputedPropertyName(prop.name)) {
      out.fields.set(prop.name.getText(ev.s.scriptFile), fieldValue(ev, prop.initializer, ctx));
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      // Shorthand `{ o }` stores o's live value (aliasing) when it is a place; an
      // unresolvable name folds to empty (evalIdentifier would return the same).
      // getSymbolAtLocation(prop.name) would return the object's
      // PROPERTY symbol here, not the referenced local's value symbol, so envSlot
      // would fabricate a fresh empty slot and the wrapped taint would be dropped at the
      // literal — invisible at every downstream emission. getShorthandAssignmentValueSymbol
      // resolves the actual value binding (the same symbol `{ o: o }` would read).
      const sym = ev.checker.getShorthandAssignmentValueSymbol(prop);
      out.fields.set(prop.name.text, sym === undefined ? emptyValue() : ev.s.envSlot(sym));
    } else if (ts.isSpreadAssignment(prop)) {
      // Object spread `{ ...o }` shallow-copies: nested field references are shared, so a
      // write through the literal's sub-object stays visible through o (spreadShare adopts
      // o's fields by reference when o is a place). A plain mergeInto would deep-copy
      // structure into independent nodes, hiding such a mutation from o.
      if (!spreadShare(ev, out, prop.expression)) mergeInto(out, ev.evalExpr(prop.expression, ctx));
    } else if (ts.isMethodDeclaration(prop) && !ts.isComputedPropertyName(prop.name)) {
      // Shorthand method: a function-valued field, callable through it (obj.run(x)).
      // Without this case `obj.run` would resolve to no fns and the unknown-call
      // fallback would never record its param actuals.
      const fnVal = emptyValue();
      fnVal.fns.add(prop);
      out.fields.set(prop.name.getText(ev.s.scriptFile), fnVal);
    } else if (ts.isGetAccessorDeclaration(prop) && !ts.isComputedPropertyName(prop.name)) {
      // Getter: the field's read value IS the getter's return summary (re-read each pass;
      // the fixpoint converges) — without this case accessor fields would be invisible.
      const id = ev.s.fnId.get(prop);
      out.fields.set(prop.name.getText(ev.s.scriptFile), id === undefined ? emptyValue() : cloneValue(ev.s.summaryOf(id)));
    } else if (ts.isPropertyAssignment(prop)) {
      // Computed key: cannot track the field name; fold the value into occs. The key
      // expression must be evaluated too — both for effect (a facade sink inside the key
      // was never visited, so its edges vanished) and because the key STRING becomes an
      // observable property name (`Object.keys(o)`), so its taint joins the object
      // ("strings launder nothing").
      if (ts.isComputedPropertyName(prop.name)) collapseInto(out, ev.evalExpr(prop.name.expression, ctx));
      collapseInto(out, ev.evalExpr(prop.initializer, ctx));
    } else if (
      (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) &&
      ts.isComputedPropertyName(prop.name)
    ) {
      // Computed method/accessor name (`{ [await ask()]() {} }`): the name becomes an
      // observable key (`Object.keys`) and may host a facade sink, so evaluate the key and
      // fold its taint in — same treatment as a computed property key. The member value can't
      // be tracked under a dynamic key (opaque). The `!isComputedPropertyName` guards
      // above exclude computed method/accessor names from every earlier branch, so this
      // is the only place their key gets visited.
      collapseInto(out, ev.evalExpr(prop.name.expression, ctx));
    }
    // SetAccessorDeclaration carries no read value; its writes are handled globally by
    // settersByProp (see recordSetterWrite).
  }
  return out;
}

// 容器字面量成员要存的值：表达式可解析为 place 时存活引用（保持一致别名），
// 否则对它求值得到独立值。纯选择，无副作用（求值本身的副作用由 evalExpr 承担）。
/** The value to store in a container-literal field: the live place if any, else a clone. */
function fieldValue(ev: Evaluator, expr: ts.Expression, ctx: EvalContext): AbstractValue {
  return ev.resolvePlace(expr) ?? ev.evalExpr(expr, ctx);
}

/**
 * Shallow-copy spread sharing for a literal: if `expr` resolves to a place, adopt its
 * field objects into `out` BY REFERENCE (+ merge container-level occs) and return true,
 * so a write through the copy's sub-object stays visible through the source. `out` is this
 * pass's fresh evaluation; the fixpoint change is signalled when it is merged into the
 * literal's persistent place (state.literalPlaceOf), so this must NOT touch ev.s.changed
 * (doing so would spin forever).
 */
// 字面量的浅拷贝共享：expr 能解析为 place 时，把它的字段对象按引用并入 out（加上容器级
// occs），返回 true，使经由副本子对象的写入在源对象上同样可见。expr 不是 place 时返回
// false，调用方退回按值合并。约定：本函数绝不设置 ev.s.changed（out 是每遍临时值，
// 增长信号由 state.literalPlaceOf 在并入持久 place 时统一上报，否则不动点会空转）。
function spreadShare(ev: Evaluator, out: AbstractValue, expr: ts.Expression): boolean {
  const place = ev.resolvePlace(expr);
  if (place === undefined) return false;
  // adoptFields can weak-merge a colliding field INTO the (persistent) source field without
  // reporting growth here — a deliberate non-report, per this function's no-`changed`
  // contract above. Safe: the merged-in value is the one runtime overwrites, so the fact is a
  // spurious over-approximation whose propagation is merely DELAYED to the next pass that
  // touches the source through a reporting path; it can never be lost, because nothing in
  // this gen-only analysis removes it.
  adoptFields(out, place);
  mergeInto(out, place);
  return true;
}
