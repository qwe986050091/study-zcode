import ts from "typescript";
import {
  addOcc,
  addPlaceholder,
  bindingPropertyKey,
  collapse,
  emptyValue,
  mergeInto,
  readField,
  type AbstractValue,
} from "./domain.js";
import type { EvalContext, Evaluator } from "./taint.js";

/**
 * Destructuring / aliasing bind machinery, split out of the core evaluator (taint.ts) like
 * the call/relay rules in calls.ts and the assignment rules in assign.ts — same `Evaluator`
 * instance, free-function shape. Declarations, for-of/for-in initializers and callback
 * parameters all route through {@link bindPattern}.
 */

/**
 * Bind a destructuring pattern (or a single name). When `sourcePlace` is a LIVE place,
 * pattern elements selecting a statically-known field ALIAS to that live field (the
 * extracted binding and the container share one object), so `const { o } = wrap; o.f = t`
 * is visible through `wrap.o`. See {@link extractField} for the seed-on-absent handling
 * that preserves opaque containers' collapse-fallback flow. Rest elements and non-place
 * sources keep value semantics (a folded / field-selected clone).
 */
// 绑定一个解构模式（单个标识符也算）：声明、for-of/for-in 初始化、回调参数都走这里。
// sourcePlace 是"活 place"时，静态字段元素与容器共享同一子对象（别名）；否则按值语义
// 折叠/选字段。返回值为 void，副作用是写环境槽（bindSymbol）并可能置 changed。
// 不变量：rest 元素永远按值语义（无法表示"剩余共享"），避免凭空制造别名。
export function bindPattern(
  ev: Evaluator,
  name: ts.BindingName,
  value: AbstractValue,
  ctx: EvalContext,
  sourcePlace?: AbstractValue,
): void {
  if (ts.isIdentifier(name)) {
    const sym = ev.checker.getSymbolAtLocation(name);
    if (sym !== undefined) ev.s.bindSymbol(sym, value);
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      // rest 元素按值语义折叠；非 rest 且有静态 key 时优先走活字段别名。
      if (element.dotDotDotToken !== undefined) {
        bindPattern(ev, element.name, collapse(value), ctx); // rest: fold, exact preserved (value semantics)
        continue;
      }
      const key = bindingPropertyKey(element);
      if (sourcePlace !== undefined && key !== undefined) {
        bindPatternElement(ev, element.name, extractField(ev, sourcePlace, key), element.initializer, ctx);
      } else {
        bindPattern(ev, element.name, key === undefined ? collapse(value) : selectField(value, key), ctx);
      }
    }
    return;
  }
  let index = 0;
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      index += 1;
      continue;
    }
    if (element.dotDotDotToken !== undefined) {
      bindPattern(ev, element.name, collapse(value), ctx); // rest: value semantics
      continue;
    }
    if (sourcePlace !== undefined) {
      bindPatternElement(ev, element.name, extractField(ev, sourcePlace, String(index)), element.initializer, ctx);
    } else {
      bindPattern(ev, element.name, selectField(value, String(index)), ctx);
    }
    index += 1;
  }
}

/**
 * Bind one destructuring element to a LIVE field: a default initializer weak-merges into
 * the field (runtime may bind either the field or the default — a sound over-approx), and
 * the field is passed as both value and source so nested patterns keep aliasing.
 */
// 绑定单个解构元素到"活字段"：默认值先弱并入字段（运行时可能绑字段，也可能取默认值，
// 两种都算，属于保守上近似），再把字段同时作为 value 与 sourcePlace 递归，嵌套模式继续别名。
function bindPatternElement(
  ev: Evaluator,
  name: ts.BindingName,
  field: AbstractValue,
  initializer: ts.Expression | undefined,
  ctx: EvalContext,
): void {
  if (initializer !== undefined && mergeInto(field, ev.evalExpr(initializer, ctx))) ev.s.changed = true;
  bindPattern(ev, name, field, ctx, field);
}

/**
 * The live field at `key` of a place, for destructuring aliasing. An existing field is
 * returned as-is (a real sub-object). An ABSENT field is created and SEEDED with the
 * container's own occurrences + placeholders (occs-only) — exactly what a read of the
 * field would collapse to on an opaque container (`const { feedback } = review`), so the
 * extraction never drops taint; and because it is now a shared field, a later write
 * through the extracted binding lands where the container sees it too. Never re-seeds an
 * existing field (that would over-smear a precise sub-object).
 */
// 取 place 在 key 处的活字段，用于解构别名：已存在的字段原样返回（是真实子对象）；
// 缺失时新建并用容器的 occs + placeholders（只含容器级，不含兄弟字段）播种——等价于
// 对不透明容器读取该字段时的折叠结果，所以解构不会丢 taint；此后经该绑定写入也会落到
// 容器可见的同一字段。只播种一次，已有字段绝不重复播种（否则精确子对象被过度涂抹）。
// 副作用：可能新增字段并置 ev.s.changed。
export function extractField(ev: Evaluator, container: AbstractValue, key: string): AbstractValue {
  const existing = container.fields.get(key);
  if (existing !== undefined) return existing;
  const field = emptyValue();
  for (const occ of container.occs.values()) addOcc(field, occ);
  for (const ph of container.phs.values()) addPlaceholder(field, ph);
  container.fields.set(key, field);
  ev.s.changed = true;
  return field;
}

// 读取静态已知字段：字段存在时按读时涂抹（字段值并上容器级 occs/占位符），
// 不存在时整体折叠（保留 exactness，不做加宽）。纯读，不改变容器。
/** Read a statically-known field with smear-on-read, else collapse (exact preserved). */
// 字段不存在时整体折叠（保留 exact，不使用涂抹），由调用方自行判断是否降级为整值读取。
export function selectField(value: AbstractValue, key: string): AbstractValue {
  return readField(value, key);
}
