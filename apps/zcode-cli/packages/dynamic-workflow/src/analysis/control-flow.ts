import ts from "typescript";
import { addOcc, cloneValue, collapse, mergeInto, provisionalFanoutId, type AbstractValue } from "./domain.js";
import { bindForInitializer } from "./assign.js";
import type { EvalContext, Evaluator } from "./taint.js";

/**
 * Loop / iteration statement handlers: `for`, `for-of`, and `for-in`. Split out of the core
 * evaluator (taint.ts) like the call/relay rules in calls.ts and the assignment rules in
 * assign.ts — same `Evaluator` instance, free-function shape. The `visit` dispatcher in
 * taint.ts routes the three loop statement kinds here. Plain `while`/`do` carry no binding, so
 * they stay inline in `visit`. Gen-only weak updates over-approximate every iteration order at once,
 * so a loop body is evaluated exactly like straight-line code.
 */

/** `for (init; cond; incr) body`: evaluate every clause for effect, then the body. */
// 职责：for 语句的求值顺序——初始化 → 条件（登记 guard）→ 增量 → 循环体，逐子句求值以产生
// 副作用（sink 记录、赋值、函数应用），本函数不返回任何值。
// 输入：node 各子句均可缺省（`for (;;)`），缺省即跳过对应步骤；init 为变量声明列表时走
// handleDeclaration，否则按表达式求值。
// 副作用：可能写符号环境/sink/guard 记录；无 IO、无日志。循环体只走查一次（gen-only 弱更新
// 已按「任意迭代顺序」过近似，见文件头）。
// 失败语义：求值失败不会发生在本层；表达式无值也照常继续（只关心副作用）。
export function visitForStatement(ev: Evaluator, node: ts.ForStatement, ctx: EvalContext): void {
  if (node.initializer !== undefined) {
    if (ts.isVariableDeclarationList(node.initializer)) {
      for (const decl of node.initializer.declarations) ev.handleDeclaration(decl, ctx);
    } else {
      // 非声明形式（`for (i = 0; …)`）只是普通表达式求值，绑定由赋值规则负责，这里不重复绑定。
      ev.evalExpr(node.initializer, ctx);
    }
  }
  if (node.condition !== undefined) ev.recordGuard(node.condition, ev.evalExpr(node.condition, ctx));
  if (node.incrementor !== undefined) ev.evalExpr(node.incrementor, ctx);
  ev.visit(node.statement, ctx);
}

/**
 * `for (x of xs) body`: the element value is the collapsed iterable (+ a fan-out label when the
 * loop is a promoted iteration candidate), bound through the same machinery as any other loop
 * variable. Derived, not a place, so binding keeps value semantics.
 */
export function handleForOf(ev: Evaluator, node: ts.ForOfStatement, ctx: EvalContext): void {
  // 职责：for-of 求值——把被遍历表达式的 collapse 结果作为元素值，绑定到循环变量后走查体。
  // 输入输出：无返回值；cand 缺失（非迭代候选）时按普通循环处理，不建 fan-out 区域。
  // 提升语义：只有 promotedOrders 命中才写 fanoutInVal 并给元素打 exact fan-out 标签；
  // 未提升的循环是局部值，不虚构出处（但元素仍可携带被遍历集合的既有 occurrence）。
  // 副作用：awaitModifier 存在时写 awaitVal sink（供 settle 神谕按该表达式偏移查找）；
  // 体走查使用追加了 cand@order 的区域栈；最后把元素字段效果回写到集合 place。
  // 不变量：区域栈只在 cand 存在时追加，避免给非候选循环制造虚假区域。
  const cand = ev.s.candByForOf.get(node);
  const iterated = collapse(ev.evalExpr(node.expression, ctx));
  // `for await (… of …)` awaits every element, so the ITERATED expression is the settle
  // oracle for the loop's per-iteration barrier — and the ordering walk puts that barrier
  // at exactly this expression's position, which is the key it looks the oracle up under.
  if (node.awaitModifier !== undefined) {
    ev.s.mergeSink(ev.s.awaitVal, node.expression.getStart(ev.s.scriptFile), iterated);
  }
  const element = cloneValue(iterated);
  let regionStack = ctx.regionStack;
  if (cand !== undefined) {
    const fanoutId = provisionalFanoutId(cand.order);
    // 提升判定必须在写 sink 之前完成：未提升时该循环没有 fan-out 语义，sink 与标签都不得出现。
    if (ev.s.promotedOrders.has(cand.order)) {
      ev.s.mergeSink(ev.s.fanoutInVal, fanoutId, iterated);
      addOcc(element, { exact: true, site: fanoutId });
    }
    regionStack = [...ctx.regionStack, `cand@${cand.order}`];
  }
  // The element value is derived (collapsed iterable + fan-out label), not a place, so for-of
  // binding keeps value semantics. Only the declaration form used to be bound; an
  // assignment-form initializer (`for (cur of xs)`, or a destructuring target) bound nothing,
  // dropping the element's taint into every read of the loop variable.
  bindForInitializer(ev, node.initializer, element, ctx);
  ev.visit(node.statement, { onReturn: ctx.onReturn, regionStack });
  // Element-mutation write-back: the loop variable may-aliases the iterable's elements, so a
  // field written through it (`for (const y of b) y.note = t`) reaches the collection. Weak-
  // merge the element's FIELD effects (collapsed) into the collection place — a later
  // `b[k].note` read smears them out. Mirrors the array-method fan-out write-back. Without
  // this write-back, for-of element writes would be invisible to the collection.
  //
  // The write-back used to scan only THIS pass's fresh `element` clone, but
  // body writes land on the loop variable's persistent env slot — bindSymbol ADOPTS the pass-1
  // object and later passes merely merge the fresh clone INTO it. A clone of the collapsed
  // iterable has no fields, so element-field taint first arriving on pass >= 2 (exactly the
  // loop-carried flows) was never written back, and a DESTRUCTURED loop variable
  // (`for (const { doc } of items) doc.note = t`), whose sub-bindings hold their own slots,
  // never populated `element.fields` at all. Write back from the slots the body actually
  // wrote through: every binding of the initializer, plus `element` itself (which still
  // carries pass-1 writes for the identifier form).
  const collectionPlace = ev.resolvePlace(node.expression);
  if (collectionPlace !== undefined) {
    // 先回写 element 本身（覆盖标识符形式在第 1 轮的写入），再回写每个绑定槽（覆盖解构形式
    // 与循环携带流）；顺序不影响单调合并结果，但能尽早刷新 changed。
    const writeBackFields = (holder: AbstractValue): void => {
      for (const field of holder.fields.values()) {
        if (mergeInto(collectionPlace, collapse(field))) ev.s.changed = true;
      }
    };
    writeBackFields(element);
    for (const sym of boundSymbolsOfForInitializer(ev, node.initializer)) {
      const slot = ev.s.env.get(sym);
      // 槽位等于集合本身时跳过：自身合并无信息，且可能让 element 与 collection 形成无意义自引用。
      if (slot !== undefined && slot !== collectionPlace) writeBackFields(slot);
    }
  }
}

/**
 * The symbols a for-of initializer binds — the slots its body writes element mutations
 * through. Declaration form walks the (possibly destructuring) binding name; assignment
 * form covers the plain-identifier target (destructuring assignment targets write through
 * the heap paths of assign.ts, which need no loop write-back).
 */
function boundSymbolsOfForInitializer(ev: Evaluator, initializer: ts.ForInitializer): ts.Symbol[] {
  // 收集 for-of 初始化器绑定的符号：声明形式递归展开（可能解构的）绑定名，赋值形式只取
  // 普通标识符目标。返回新数组，源码顺序；无法解析符号的标识符被跳过（不补占位）。
  // 解构赋值目标不在此收集：它们通过 assign.ts 的堆路径写入，不需要循环回写。
  const out: ts.Symbol[] = [];
  const addName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      const sym = ev.checker.getSymbolAtLocation(name);
      if (sym !== undefined) out.push(sym);
      return;
    }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) addName(el.name);
    }
  };
  if (ts.isVariableDeclarationList(initializer)) {
    const decl = initializer.declarations[0];
    if (decl !== undefined) addName(decl.name);
    return out;
  }
  if (ts.isIdentifier(initializer)) {
    const sym = ev.checker.getSymbolAtLocation(initializer);
    if (sym !== undefined) out.push(sym);
  }
  return out;
}

/**
 * `for (k in obj) body`: for-in enumerates the object's KEYS; each key string is derived from
 * that object ("strings launder nothing"), so the loop variable carries its collapsed taint.
 * For-in used to share the while/do arm (which binds nothing), so key-derived flow
 * (`keys += k`) was dropped for both the declaration and assignment initializer forms.
 */
export function handleForIn(ev: Evaluator, node: ts.ForInStatement, ctx: EvalContext): void {
  // 职责：for-in 求值——键字符串派生自被枚举对象（字符串不洗白来源），循环变量携带其
  // collapse 后的污点。输入为声明或赋值形式的初始化器，绑定后走查体（无返回值）。
  // 副作用：可能写符号环境/sink；无 IO。语义口径：只为枚举对象本身取一次值，键不单独建模。
  // 与 for-of 的差异：不建立 fan-out 区域、不做元素字段回写（键不是元素别名）。
  bindForInitializer(ev, node.initializer, collapse(ev.evalExpr(node.expression, ctx)), ctx);
  ev.visit(node.statement, ctx);
}
