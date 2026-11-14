import ts from "typescript";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";
import {
  addPlaceholder,
  clearExact,
  cloneValue,
  collapse,
  collapseInto,
  COMPOUND_ASSIGNMENT_OPS,
  emptyValue,
  isNonArrowFunctionLike,
  liveField,
  mergeInto,
  peelPlace,
  readField,
  staticIndexKey,
  unionValues,
  type AbstractValue,
} from "./domain.js";
import { applyCall, evalCall } from "./calls.js";
import { applyConstructor, applyMixinConstructor, evalAwait, handleNewUnknown } from "./promise-ops.js";
import {
  classConstructor,
  classNodeOfSymbol,
  enclosingBaseInstance,
  enclosingClassInstance,
  evalClasses,
  hasUnresolvedHeritage,
  resolveClassNode,
} from "./classes.js";
import { handleAssignment, handleCompoundAssignment } from "./assign.js";
import { handleForIn, handleForOf, visitForStatement } from "./control-flow.js";
import { evalArrayLiteral, evalObjectLiteral } from "./literals.js";
import { bindPattern, extractField, selectField } from "./patterns.js";
import { TaintState } from "./state.js";

/**
 * The taint pass: a gen-only, may-flow dataflow analysis over the typed AST that
 * turns the site table into edge-bearing facts. It is the data half of the fused
 * interpreter (interpret.ts): the fixpoint here runs taint-only, and after
 * convergence the temporal walk (causality-order.ts) reads this pass's state as its
 * oracle. See domain.ts for the
 * abstract-value algebra, state.ts for the fixpoint storage, and calls.ts for the
 * call/relay transfer rules.
 *
 * ## Why flow-INsensitivity is sound here
 *
 * The analysis is gen-only: taint is a union over a finite powerset lattice, there
 * are no sanitizers and no strong updates (no kills). With no kills, the order in
 * which statements execute cannot remove a fact, so a single global environment with
 * weak (join-only) updates over-approximates every execution order at once. That is
 * exactly what a may-flow graph wants ("A may feed B"), and it makes loop-carried
 * variables (the planner/reviewer `feedback`) fall out for free: the reassignment
 * inside the loop just unions into the same binding the loop head reads. We iterate
 * the whole-script transfer to a fixpoint; monotonicity + the finite lattice
 * guarantee termination (a defensive cap throws if it ever fails to converge — a
 * thrown cap is a bug, never a silent truncation).
 */

// fixpoint 轮数上限：gen-only 单调 + 有限格本该必然收敛，触顶说明传递函数有 bug
//（常见原因是某个节点每轮新建、alias 目标身份不稳定），此时抛错而非静默截断结果。
const ITERATION_CAP = 100;

// 求值上下文：由顶层 iterate 或 evalFunction 构造，贯穿一次转移的全部子表达式；
// 两个字段都必需，onReturn 是该区域唯一的污点回写通道。
export interface EvalContext {
  // 数据流区域栈，最内层在末尾："top" / `fn@<id>` / `cand@<order>`；markCalled 与
  // facade sink 的归属都按它判定，不可为空数组。
  /** Enclosing dataflow regions, innermost last: "top", `fn@<id>`, `cand@<order>`. */
  regionStack: string[];
  // 本区域 `return` / `yield` 污点的收集器；实现方负责弱合并（顶层并入 returnVal，
  // 函数体并入该 id 的 summary），调用方不得假定它会同步返回结果。
  /** Sink for `return` statements in this region. */
  onReturn: (value: AbstractValue) => void;
}

// 求值器实例：持有单一 TaintState（fixpoint 存储）与共享 checker。整个 fixpoint 的所有
// 轮次必须复用同一实例——env、sink、占位符注册表、持久堆节点都挂在状态上，重建即丢失。
// 所有方法都可能置 `s.changed`（弱更新增长）或 markCalled，调用方不可缓存"无变化"假设。
/**
 * The taint half of the fused interpreter:
 * drive the whole-script transfer to a fixpoint. Emission is the caller's business —
 * interpret.ts reads the converged state through `emitFacts` / `emitOracle` and runs
 * the temporal walk over the same state.
 */
export class Evaluator {
  readonly s: TaintState;
  readonly checker: ts.TypeChecker;

  constructor(workflow: WorkflowProgram, table: SiteTable) {
    this.s = new TaintState(workflow, table);
    this.checker = this.s.checker;
  }

  // 驱动整脚本转移到不动点：每轮清 changed → iterate → 补算可达性与提升资格，
  // 只要还有增长就继续。返回 void，事实发射由调用方（interpret.ts）另行完成。
  // 失败语义：超过 ITERATION_CAP 直接抛错（这是分析器缺陷，不应降级为部分结果）。
  converge(): void {
    let iterations = 0;
    do {
      this.s.changed = false;
      iterations += 1;
      if (iterations > ITERATION_CAP) {
        throw new Error(`taint analysis failed to converge after ${ITERATION_CAP} iterations`);
      }
      this.iterate();
      this.s.propagateReachability();
      this.s.recomputePromotion();
    } while (this.s.changed);
  }

  // 单轮转移的固定顺序：函数声明名先绑定（hoisting）→ 顶层语句 → 类体 → 各函数体。
  // 顺序只为让首轮就能看到已绑定的值；无 kill 的格上顺序不改变最终不动点。
  private iterate(): void {
    // Pre-bind function-declaration names to their function value (hoisting).
    for (const fn of this.s.functions) {
      if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) {
        const sym = this.checker.getSymbolAtLocation(fn.name);
        if (sym !== undefined) {
          const val = emptyValue();
          val.fns.add(fn);
          this.s.bindSymbol(sym, val);
        }
      }
    }

    const topCtx: EvalContext = {
      onReturn: (value) => this.s.mergeReturn(collapse(value)),
      regionStack: ["top"],
    };
    for (const stmt of this.s.body.statements) this.visit(stmt, topCtx);

    // Class bodies run after top-level statements (field initializers may read top-level
    // bindings) and before the function pass (methods must be registered as instance
    // fields before dispatch): field/static initializers, static blocks, method/accessor
    // field registration, and the `extends` merge. The fixpoint reconciles any ordering.
    evalClasses(this);

    for (const fn of this.s.functions) this.evalFunction(fn);
  }

  private evalFunction(fn: ts.Node): void {
    const id = this.s.fnId.get(fn);
    if (id === undefined) return;
    this.s.bindPlaceholderParams(fn, id);

    const ctx: EvalContext = {
      onReturn: (value) => {
        if (mergeInto(this.s.summaryOf(id), value)) this.s.changed = true;
      },
      regionStack: [`fn@${id}`],
    };
    // Binding-pattern parameters (`function f([x, y]) {}`, a `.then(([x, y]) => …)` callback)
    // carry no symbol in fnParamSymbols, so bindPlaceholderParams cannot bind them. Bind the
    // whole pattern to this param's placeholder through the shared pattern machinery, so the
    // extracted names resolve to the recorded actuals (incl. the keystone rule's pessimistic
    // application). Before this loop existed, these params stayed undefined, so the
    // body's reads of the destructured names saw nothing — a dropped may-flow.
    (fn as ts.SignatureDeclaration).parameters.forEach((param, index) => {
      if (ts.isIdentifier(param.name)) return;
      const val = emptyValue();
      const rest = param.dotDotDotToken !== undefined;
      addPlaceholder(val, { fnId: id, param: index, ...(rest ? { rest: true } : {}) });
      this.bindPattern(param.name, val, ctx);
    });
    // Default parameter initializers join into the parameter alongside call actuals.
    // Previously they were never evaluated, so `build(prefix = s)` called with no
    // argument dropped `s`'s taint entirely (the placeholder resolved to nothing).
    for (const param of (fn as ts.SignatureDeclaration).parameters) {
      if (param.initializer === undefined) continue;
      this.bindPattern(param.name, this.evalExpr(param.initializer, ctx), ctx);
    }
    const bodyNode = (fn as ts.SignatureDeclaration & { body?: ts.Node }).body;
    if (bodyNode === undefined) return;
    if (ts.isBlock(bodyNode)) {
      for (const stmt of bodyNode.statements) this.visit(stmt, ctx);
    } else {
      // Concise arrow body: the body expression is the return value.
      ctx.onReturn(this.evalExpr(bodyNode as ts.Expression, ctx));
    }
  }

  // 只记录、不流动：guard 值按"节点起始偏移"并入 guardVal sink，供因果图判定控制依赖。
  // 键必须是 `node.getStart(scriptFile)`——与 traceOrder 交给 controllersOf 的节点同一，
  // 括号表达式不能被穿透，否则两侧键对不上、控制边丢失。返回值 void，不参与数据并集。
  /**
   * Record a guard expression's value as the control-dependence oracle, keyed by the
   * guard node's START OFFSET — the same node `traceOrder` hands to `controllersOf`, so a
   * parenthesized guard is keyed by its ParenthesizedExpression. This is a SINK, not a
   * flow: the value is recorded and not joined into anything, because a condition does not
   * join the data contract (see the ConditionalExpression case in evalExpr). Consumed only
   * by the causality graph.
   */
  recordGuard(node: ts.Expression, value: AbstractValue): void {
    this.s.mergeSink(this.s.guardVal, node.getStart(this.s.scriptFile), value);
  }

  // -- statement visitor ---------------------------------------------------

  // 语句层分发（无返回值、无 IO）：各语句自行把污点写回 ctx.onReturn 或 sink；
  // 形状未覆盖的语句静默跳过——分析器不承担语法告警，错误交给编译期诊断。
  // 函数/类声明在此故意为 no-op：它们在类遍/函数遍求值，名字已由 iterate 预绑定。
  visit(node: ts.Node, ctx: EvalContext): void {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) this.handleDeclaration(decl, ctx);
    } else if (ts.isExpressionStatement(node)) {
      this.evalExpr(node.expression, ctx);
    } else if (ts.isReturnStatement(node)) {
      ctx.onReturn(node.expression === undefined ? emptyValue() : this.evalExpr(node.expression, ctx));
    } else if (ts.isForOfStatement(node)) {
      handleForOf(this, node, ctx);
    } else if (ts.isIfStatement(node)) {
      this.recordGuard(node.expression, this.evalExpr(node.expression, ctx));
      this.visit(node.thenStatement, ctx);
      if (node.elseStatement !== undefined) this.visit(node.elseStatement, ctx);
    } else if (ts.isBlock(node)) {
      for (const stmt of node.statements) this.visit(stmt, ctx);
    } else if (ts.isForStatement(node)) {
      visitForStatement(this, node, ctx);
    } else if (ts.isForInStatement(node)) {
      handleForIn(this, node, ctx);
    } else if (ts.isWhileStatement(node)) {
      // A `while` condition decides whether the body runs at all, so it is a guard sink.
      this.recordGuard(node.expression, this.evalExpr(node.expression, ctx));
      this.visit(node.statement, ctx);
    } else if (ts.isDoStatement(node)) {
      // Split out of the shared while/do arm deliberately: a `do…while` body is
      // unconditional on first entry, so its condition guards nothing and must NOT be
      // recorded. Same fact that makes that region `entered` in the ordering walk. Evaluation order is unchanged.
      this.evalExpr(node.expression, ctx);
      this.visit(node.statement, ctx);
    } else if (ts.isSwitchStatement(node)) {
      // Recorded ONCE on the switch expression, not per clause: the ordering walk opens a
      // branch region per clause but reads every one of their controllers off this node.
      this.recordGuard(node.expression, this.evalExpr(node.expression, ctx));
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) this.evalExpr(clause.expression, ctx);
        for (const stmt of clause.statements) this.visit(stmt, ctx);
      }
    } else if (ts.isTryStatement(node)) {
      this.visit(node.tryBlock, ctx);
      if (node.catchClause !== undefined) {
        // Every catch binding reads the whole script-global thrown-value set (a clone
        // each pass so binding stays monotone). Previously the catch variable was never
        // bound, so throw→catch dataflow (and any read of the caught value) was lost.
        const vd = node.catchClause.variableDeclaration;
        if (vd !== undefined) this.bindPattern(vd.name, cloneValue(this.s.thrownVal), ctx);
        this.visit(node.catchClause.block, ctx);
      }
      if (node.finallyBlock !== undefined) this.visit(node.finallyBlock, ctx);
    } else if (ts.isThrowStatement(node)) {
      // `throw e` joins collapse(e) into the global thrown set.  ThrowStatement
      // was absent from the visitor, so its subexpression's facade sites (e.g. an
      // `agent().ask()` in the thrown value) were never evaluated at all.
      this.s.mergeThrown(collapse(this.evalExpr(node.expression, ctx)));
    } else if (ts.isLabeledStatement(node)) {
      this.visit(node.statement, ctx);
    }
    // Function/class declarations carry no top-level dataflow here: functions are
    // evaluated in their own pass and their names are pre-bound (hoisting).
  }

  // 变量声明转移：无 initializer（`let x;`）不产生绑定，也不产生流，直接返回。
  // RHS 是 place 时按别名绑定（共享同一 live 值，之后任一 alias 的写入双向可见），
  // 否则按值绑定。解构 + place 的组合必须先对 RHS 求副作用（join 边、thenable 的 then），
  // 再按 place 解构——否则只有 alias 没有边，或只有边没有 alias。
  handleDeclaration(decl: ts.VariableDeclaration, ctx: EvalContext): void {
    if (decl.initializer === undefined) return;
    // Aliasing binding: `const alias = box` / `const b = arr[0]` bind the symbol to the
    // LIVE value the place denotes (shared reference), so a later write through any
    // alias is visible through the original. Destructuring off a place aliases each
    // extracted element to a live field (see bindPattern). Non-place RHS keeps value
    // semantics.
    const place = this.resolvePlace(decl.initializer);
    if (ts.isIdentifier(decl.name)) {
      if (place !== undefined) {
        const sym = this.checker.getSymbolAtLocation(decl.name);
        if (sym !== undefined) {
          // Evaluate the initializer for its side effects before aliasing: a place peeled
          // out of a comma (`(f(), box)`) or an `await` discards operands / a thenable's
          // `then` whose facade sinks must still be visited. For the plain place forms
          // (identifier / static field chain) this is a graph no-op (reads emit no sinks).
          this.evalExpr(decl.initializer, ctx);
          this.s.bindSymbol(sym, place);
          return;
        }
      }
      this.bindPattern(decl.name, this.evalExpr(decl.initializer, ctx), ctx);
      return;
    }
    // Destructuring off a live place aliases each extracted element to a live field. When the
    // place is present, still evaluate the initializer for effect (a join's edges, an awaited
    // thenable's `then`) — the alias binds to the place, not the discarded snapshot. 
    // `const [sec, alias] = await Promise.all([secret, box])` needs both the join edges AND
    // the element aliasing (alias IS box) so a write through `alias` reaches box.
    if (place !== undefined) {
      this.evalExpr(decl.initializer, ctx);
      this.bindPattern(decl.name, place, ctx, place);
      return;
    }
    this.bindPattern(decl.name, this.evalExpr(decl.initializer, ctx), ctx);
  }

  // 返回值是 LIVE 共享值（不可 clone），只供写侧与别名绑定使用；读侧一律走 evalExpr。
  // 返回 undefined 表示"该表达式不是 place"，语义是退化为值语义，而不是错误。
  // 不变量：同一语法 place 必须返回同一对象身份（跨轮亦尽量稳定），否则 mayAlias 的
  // 身份去重失效、changed 永不落定。本函数不置 changed、不写 sink。
  /**
   * The LIVE (shared, unclonable) abstract value a *place expression* denotes, or
   * undefined for non-places (calls, literals, computed access, operators). A place is
   * an identifier (its env slot) or a chain of static property / literal-index element
   * accesses rooted at a place. Value-preserving wrappers (parens / `as` / `satisfies` /
   * non-null / type assertion) are peeled at every level. This is the single primitive
   * behind aliasing: bindings, container-literal fields, write receivers and param
   * write-back all resolve places through it. Reads must NOT call this (they clone).
   *
   * `create` governs missing field slots. WRITE receivers create empty fields on demand
   * (`arr[0].f = t` materializes `arr[0]`). Read-side callers (aliasing binds,
   * container-literal embedding, write-back actuals) pass `create=false`: an absent field
   * returns undefined so the caller falls back to value semantics (readField's collapse),
   * which correctly surfaces the container's own occurrences. Fabricating an empty field
   * there would alias to a phantom and DROP the opaque container's taint (e.g. reading
   * `review.feedback` off an opaque ask result must yield collapse(review), not ∅).
   */
  resolvePlace(expr: ts.Expression, create = false): AbstractValue | undefined {
    const e = peelPlace(expr);
    if (ts.isAwaitExpression(e)) {
      // `await p` settles to the promise's ONE resolved object, so it IS the operand's
      // place — awaiting the same promise twice yields the same object, and a mutation
      // between the awaits is visible through the second (`async-promise-double-await-mutate`).
      // A custom THENABLE is the exception: its `then` transforms the value, so the result
      // is NOT the operand; detect that by a tracked `then` field and fall back to value
      // semantics (evalAwait models the continuation flow there).
      const inner = this.resolvePlace(e.expression, create);
      if (inner === undefined) return undefined;
      const thenField = inner.fields.get("then");
      return thenField !== undefined && thenField.fns.size > 0 ? undefined : inner;
    }
    if (e.kind === ts.SyntaxKind.ThisKeyword) {
      // `this` is the LIVE shared instance, so `this.x = v` mutates the value every alias
      // (and every other instance of the class) sees.
      return enclosingClassInstance(this, e);
    }
    if (e.kind === ts.SyntaxKind.SuperKeyword) {
      // `super.x = v` writes the BASE class's shared instance (which the derived instance
      // weak-merges in), so the write is visible through the derived `this` too.
      return enclosingBaseInstance(this, e);
    }
    if (ts.isIdentifier(e)) {
      const sym = this.checker.getSymbolAtLocation(e);
      if (sym === undefined) return undefined;
      // A class-name place (`C.staticField = v`) is the shared instance — static writes
      // conflate with instance state.
      const cls = classNodeOfSymbol(this, sym);
      if (cls !== undefined) return this.s.instanceOf(cls);
      return this.s.envSlot(sym);
    }
    if (ts.isPropertyAccessExpression(e)) {
      const base = this.resolvePlace(e.expression, create);
      return base === undefined ? undefined : this.placeField(base, e.name.text, create);
    }
    if (ts.isElementAccessExpression(e)) {
      const key = staticIndexKey(e.argumentExpression);
      if (key === undefined) return undefined;
      const base = this.resolvePlace(e.expression, create);
      return base === undefined ? undefined : this.placeField(base, key, create);
    }
    if (ts.isConditionalExpression(e)) {
      // `flag ? box1 : box2` may BE either arm at runtime, so a write through the binding
      // must weakly reach BOTH (never strong-update one). Return a value carrying mayAlias =
      // {each arm's place}; writeField/handleHeapMutator replay the write into every target
      // inexactly. The value also snapshots the arms' current taint (a read of the binding
      // unions the arms, matching the prior evalExpr union).
      // The ternary was not a place, so the alias write
      // reached neither box. Requires ALL arms to be places — if any arm is a non-place value
      // (e.g. `flag ? plain : f.bind(null, pre)`, whose bound prefix only evalExpr computes),
      // fall back to value semantics so that arm's value is not lost. Nothing is persisted on
      // that failure path: an expression that is not a place owns no heap node.
      const whenTrue = this.resolvePlace(e.whenTrue, create);
      const whenFalse = this.resolvePlace(e.whenFalse, create);
      if (whenTrue === undefined || whenFalse === undefined) return undefined;
      // The wrapper is the PERSISTENT node of this ConditionalExpression (state.ts
      // condPlaceOf), never a fresh value per pass — the canonical-heap invariant
      // (see joinResultOf). Without it, a syntactically NESTED ternary place
      // (`f2 ? (f ? box1 : box2) : box3`) would put the inner pass-fresh wrapper into
      // the outer's mayAlias set, which dedups by IDENTITY, so `changed` would never
      // settle and the fixpoint would hit ITERATION_CAP. (A ternary chained through
      // `const` bindings converged only because env-slot adoption happened to make its
      // wrapper persistent.)
      const out = this.s.condPlaceOf(e);
      const targets = (out.mayAlias ??= new Set());
      for (const arm of [whenTrue, whenFalse]) {
        if (!targets.has(arm)) {
          targets.add(arm);
          this.s.changed = true;
        }
        // The wrapper also snapshots the arms' current taint, so a READ of the binding
        // unions the arms (matching the prior evalExpr union).
        if (mergeInto(out, arm)) this.s.changed = true;
      }
      return out;
    }
    if (ts.isCallExpression(e)) {
      // A `Promise.all` join result is a live place: its element fields carry may-alias
      // back-references to the (place) inputs (see handleJoin), so destructuring / indexing
      // the awaited result aliases the originals. Any other call is not a place.
      //
      // Gated on `joinResults` — the registry handleJoin populates — NOT on the site table:
      // several read-side callers are `resolvePlace(x) ?? evalExpr(x)` (literals.ts
      // fieldValue, heap-ops.ts Object.assign source, array-methods.ts reduce seed), and
      // their contract is that a place resolves only once it has been EVALUATED. Resolving a
      // join eagerly off `joinByCall` short-circuits those callers, so handleJoin never runs
      // for a join in one of those positions and the site, its edges, markFacade and fan-out
      // promotion all vanish. Undefined-until-first-evaluated is therefore load-bearing; the
      // node handed out is still the one canonical object, which is all the fixpoint needs.
      return this.s.joinResults.get(e);
    }
    return undefined;
  }

  private placeField(container: AbstractValue, key: string, create: boolean): AbstractValue | undefined {
    const field = container.fields.get(key);
    if (field !== undefined) return field;
    return create ? liveField(container, key) : undefined;
  }

  // 非 place 实参只有对象/数组字面量才回写：返回其求值结果（即分配点 place，字段本身
  // 是 live place）。其余一律返回 undefined 表示"不回写"——这是能力降级而非错误，
  // 调用方（recordCall 的 argPlaces）必须容忍 undefined。
  /**
   * The parameter write-back target for an actual argument `arg` whose evaluated value is
   * `value`. A place actual resolves to its live slot (write-back aliases through it, as
   * before). An object/array LITERAL's evaluated value IS its allocation-site place
   * (state.literalPlaceOf), and its FIELDS hold live places (`poke({ box })` — the literal's
   * `box` field IS the box slot), so that value is the write-back target: `mergeHeapEffects`
   * descends into it and a field the callee wrote through `p.box` lands on the shared `box`
   * slot, while a field written on the literal itself (`tag({ name }, t)` → `box.note = t`)
   * persists on the place and reaches whoever the callee hands the object to.
   * A literal argument once skipped write-back entirely, so mutations through its live
   * sub-objects were invisible to the caller; and when the literal was a per-pass fresh
   * value, that write-back re-reported a change on every pass and the fixpoint never
   * settled.
   */
  argWriteBackPlace(arg: ts.Expression, value: AbstractValue): AbstractValue | undefined {
    const place = this.resolvePlace(arg);
    if (place !== undefined) return place;
    const peeled = peelPlace(arg);
    return ts.isObjectLiteralExpression(peeled) || ts.isArrayLiteralExpression(peeled) ? value : undefined;
  }

  /**
   * Bind a destructuring pattern (or a single name). See {@link bindPattern} in patterns.ts;
   * exposed as a thin method because the aliasing-bind machinery is used across modules.
   */
  bindPattern(name: ts.BindingName, value: AbstractValue, ctx: EvalContext, sourcePlace?: AbstractValue): void {
    bindPattern(this, name, value, ctx, sourcePlace);
  }

  /** The live field at `key` of a place, for destructuring aliasing (see patterns.ts). */
  extractField(container: AbstractValue, key: string): AbstractValue {
    return extractField(this, container, key);
  }

  /** Read a statically-known field with smear-on-read, else collapse (see patterns.ts). */
  selectField(value: AbstractValue, key: string): AbstractValue {
    return selectField(value, key);
  }

  // -- expression evaluator ------------------------------------------------

  // 表达式求值主分发：恒返回抽象值，永不返回 null/undefined。副作用包括读写 env、
  // 记录 sink、markCalled、置 ev.s.changed，以及可能创建持久堆节点。
  // 未识别形态回落到 emptyValue()，含义是"无污点"，不是"分析失败"，调用点不得据此判定。
  // 纯包装（括号 / as / satisfies / 非空断言 / 类型断言）只透传内层，不额外求值。
  evalExpr(node: ts.Expression, ctx: EvalContext): AbstractValue {
    switch (node.kind) {
      case ts.SyntaxKind.Identifier:
        return this.evalIdentifier(node as ts.Identifier);
      case ts.SyntaxKind.ParenthesizedExpression:
        return this.evalExpr((node as ts.ParenthesizedExpression).expression, ctx);
      case ts.SyntaxKind.AwaitExpression:
        return evalAwait(this, node as ts.AwaitExpression, ctx);
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression:
        return this.evalExpr((node as ts.AsExpression).expression, ctx);
      case ts.SyntaxKind.NonNullExpression:
        return this.evalExpr((node as ts.NonNullExpression).expression, ctx);
      case ts.SyntaxKind.TypeAssertionExpression:
        return this.evalExpr((node as ts.TypeAssertion).expression, ctx);
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction: {
        const out = emptyValue();
        out.fns.add(node);
        return out;
      }
      case ts.SyntaxKind.ThisKeyword: {
        // `this` resolves to the enclosing class's shared instance (a live reference, read
        // here as a clone like an identifier). Outside any class it is empty. Writes
        // (`this.x = v`) go through resolvePlace's ThisKeyword case, which returns the
        // live instance so the mutation lands on the shared value.
        const instance = enclosingClassInstance(this, node);
        return instance === undefined ? emptyValue() : cloneValue(instance);
      }
      case ts.SyntaxKind.SuperKeyword: {
        // `super` resolves to the BASE class's shared instance, so `super.reveal()` dispatches
        // to the base method summary and `super.x` reads the base field. (`super(args)` is a
        // CallExpression intercepted in evalCall before this.) Empty outside a derived class.
        // SuperKeyword previously had no case → emptyValue → `super.m` had no fns → unknown call.
        const base = enclosingBaseInstance(this, node);
        return base === undefined ? emptyValue() : cloneValue(base);
      }
      default:
        break;
    }
    if (ts.isCallExpression(node)) return evalCall(this, node, ctx);
    if (ts.isPropertyAccessExpression(node)) return this.evalPropertyAccess(node, ctx);
    if (ts.isElementAccessExpression(node)) return this.evalElementAccess(node, ctx);
    if (ts.isBinaryExpression(node)) return this.evalBinary(node, ctx);
    if (ts.isTemplateExpression(node)) {
      const out = emptyValue();
      for (const span of node.templateSpans) collapseInto(out, this.evalExpr(span.expression, ctx));
      return out;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      // A tagged template calls tag(strings, ...values). Without this case,
      // evalExpr would fall through to emptyValue() and lose all interpolated
      // taint, for both String.raw and user-defined tags.
      const argVals: AbstractValue[] = [emptyValue()]; // the frozen strings array (untainted)
      if (ts.isTemplateExpression(node.template)) {
        for (const span of node.template.templateSpans) argVals.push(this.evalExpr(span.expression, ctx));
      }
      return applyCall(this, node.tag, argVals, ctx, undefined, undefined, node);
    }
    if (ts.isYieldExpression(node)) {
      // `yield e` / `yield* e` joins the operand into the enclosing function's return
      // summary; the yield expression's own value is empty. Previously `yield` had no
      // case, so a generator's yielded (tainted) values never entered its summary.
      if (node.expression !== undefined) ctx.onReturn(this.evalExpr(node.expression, ctx));
      return emptyValue();
    }
    if (ts.isConditionalExpression(node)) {
      // Evaluate the condition for effect (asks/reads inside it must be visited so their
      // in/out edges are emitted); its taint is NOT unioned into the result — control
      // dependence is not part of the may-flow data contract, mirroring how `if`/`while`
      // conditions are handled. Previously the condition was never visited, so a facade
      // sink sitting in it (`(await ask()) ? … : …`) vanished from the graph entirely.
      // Phase 2 RECORDS it as a guard sink, which does not contradict the above: a sink
      // says what the branch reads, it still joins nothing into the value.
      this.recordGuard(node.condition, this.evalExpr(node.condition, ctx));
      return unionValues(this.evalExpr(node.whenTrue, ctx), this.evalExpr(node.whenFalse, ctx));
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      return collapse(this.evalExpr(node.operand, ctx));
    }
    // `typeof`/`void`/`delete` are DISTINCT node kinds (not PrefixUnaryExpression), so the
    // operand needs its own evaluation or a facade call inside it loses all edges. All three evaluate the operand for effects; `typeof` yields a string derived
    // from it (collapse — "strings launder nothing"), `void`/`delete` yield undefined /
    // boolean (empty), and `delete` performs NO kill (gen-only).
    if (ts.isTypeOfExpression(node)) return collapse(this.evalExpr(node.expression, ctx));
    if (ts.isVoidExpression(node) || ts.isDeleteExpression(node)) {
      this.evalExpr(node.expression, ctx);
      return emptyValue();
    }
    // A container literal evaluates to its allocation-site PLACE (state.literalPlaceOf): the
    // fresh per-pass evaluation is merged into the persistent place and the place is what
    // flows on — so a write through it (parameter write-back, a later field assignment through
    // an alias) lands on storage that survives the pass.
    if (ts.isArrayLiteralExpression(node)) return this.s.literalPlaceOf(node, evalArrayLiteral(this, node, ctx));
    if (ts.isObjectLiteralExpression(node)) return this.s.literalPlaceOf(node, evalObjectLiteral(this, node, ctx));
    if (ts.isNewExpression(node)) {
      // `new C(args)` on a script-local class applies the constructor (placeholder actuals
      // + param write-back) and returns a REFERENCE to the class's shared abstract
      // instance, so `const h = new C(s)` aliases h to that instance (all instances of a
      // class are conflated — weak).
      const cls = resolveClassNode(this, node.expression);
      if (cls !== undefined) {
        const ctor = classConstructor(this, cls);
        const ctorId = ctor === undefined ? undefined : this.s.fnId.get(ctor);
        const args = node.arguments ?? [];
        const argVals = args.map((arg) => this.evalExpr(arg, ctx));
        if (ctorId !== undefined) {
          const argPlaces = args.map((arg, i) => this.argWriteBackPlace(arg, argVals[i] as AbstractValue));
          applyConstructor(this, ctorId, ctx, argVals, argPlaces, node);
        } else if (hasUnresolvedHeritage(this, cls)) {
          // No resolvable constructor because the base is a mixin CALL (`class D extends
          // mix(Base)`): the inherited ctor may store any argument in any field, so smear the
          // args (inexact) into the instance. Sound over-approximation (see applyMixinConstructor).
          applyMixinConstructor(this, ctx, this.s.instanceOf(cls), argVals);
        }
        return this.s.instanceOf(cls);
      }
      // Non-class callee (`new Set([x])`, `new Promise(exec)`): the unknown-`new` keystone —
      // union of the argument collapses PLUS pessimistic application of function-valued args
      // AND the promise-executor rule (what a function arg feeds to its own params joins the
      // result). The old branch only collapsed arguments, so `new Promise((resolve) =>
      // resolve(draft))` never let draft reach the promise's value (no keystone for `new`).
      return handleNewUnknown(this, node, ctx);
    }
    if (ts.isSpreadElement(node)) return collapse(this.evalExpr(node.expression, ctx));
    return emptyValue();
  }

  private evalIdentifier(node: ts.Identifier): AbstractValue {
    const sym = this.checker.getSymbolAtLocation(node);
    if (sym === undefined) return this.argumentsValue(node) ?? emptyValue();
    // A class-name reference reads the class's shared instance (static access conflates
    // with instance access — `C.staticProp` and `this.prop` hit the one instance value).
    const cls = classNodeOfSymbol(this, sym);
    if (cls !== undefined) return cloneValue(this.s.instanceOf(cls));
    const slot = this.s.env.get(sym);
    if (slot !== undefined) return cloneValue(slot);
    // Unbound identifier: the implicit `arguments` object of the enclosing (non-arrow)
    // function resolves to a rest-like placeholder over ALL its actuals; everything else
    // is empty.
    return this.argumentsValue(node) ?? emptyValue();
  }

  /**
   * The implicit `arguments` object as a rest-like placeholder gathering every actual of
   * the nearest enclosing NON-arrow function (param index 0, rest). `arguments[i]` then
   * reads a field of it → collapse keeps the placeholder → emission expands it to all
   * recorded actuals (a sound over-approximation: `arguments[0]` yields the whole list).
   * Arrow functions have no own `arguments`, so the ancestor walk skips them and binds the
   * enclosing function's — matching JS's lexical `arguments`. Previously `arguments`
   * resolved to the lib symbol with no env slot, so `arguments[0]` dropped every
   * actual's taint.
   */
  private argumentsValue(node: ts.Identifier): AbstractValue | undefined {
    if (node.text !== "arguments") return undefined;
    const fn = ts.findAncestor(node, (a) => isNonArrowFunctionLike(a));
    const id = fn === undefined ? undefined : this.s.fnId.get(fn);
    if (id === undefined) return undefined;
    const val = emptyValue();
    addPlaceholder(val, { fnId: id, param: 0, rest: true });
    return val;
  }

  // 二元运算分派：`=` 与复合赋值交给 assign.ts；逗号保留右值结构（左值只求副作用）；
  // 短路运算符把左值记 guard 后与右值并集（右值可能不执行，仍按 may-flow 并入）；
  // 其余算术/比较把两侧 collapse 后并集——结果是原始值，字段结构被丢弃。
  private evalBinary(node: ts.BinaryExpression, ctx: EvalContext): AbstractValue {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken) return handleAssignment(this, node, ctx);
    if (COMPOUND_ASSIGNMENT_OPS.has(op)) return handleCompoundAssignment(this, node, ctx);
    if (op === ts.SyntaxKind.CommaToken) {
      // The comma (sequence) operator evaluates its left operand for effect (facade sinks
      // inside it must be visited) and yields the RIGHT operand's value UNCOLLAPSED — the
      // sequence's result IS the right operand, so its field structure is preserved (a
      // later `(f(), box).note` read and comma-aliasing both need that). Previously the
      // comma fell through to the value-producing default, which collapsed the result
      // and unioned the discarded left operand's taint into it.
      this.evalExpr(node.left, ctx);
      return this.evalExpr(node.right, ctx);
    }
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      // Short-circuit: the LEFT operand decides whether the right one evaluates, so it is
      // a guard sink — the ordering walk opens a `branch` region over the right operand
      // and reads its controllers off this same node.
      const left = this.evalExpr(node.left, ctx);
      this.recordGuard(node.left, left);
      return unionValues(left, this.evalExpr(node.right, ctx));
    }
    // Value-producing operators (concat, arithmetic, comparison): union of operand
    // taints, fields dropped — the result is a primitive.
    return unionValues(collapse(this.evalExpr(node.left, ctx)), collapse(this.evalExpr(node.right, ctx)));
  }

  // 具名属性读取：字段敏感 readField（含 smear-on-read，把容器级污点并回读值）；
  // 静态键不存在的字段折叠为整值读，宁可多污也不丢污。
  private evalPropertyAccess(node: ts.PropertyAccessExpression, ctx: EvalContext): AbstractValue {
    const receiver = this.evalExpr(node.expression, ctx);
    // Field-sensitive read with smear-on-read (readField unions the container's own
    // container-level occurrences); unknown field folds to the whole-value read.
    return readField(receiver, node.name.text);
  }

  // 字面量/静态索引走字段敏感读；其余计算索引执行 widening：整容器读并清 exact，
  // 索引表达式只求副作用、不并入读值（键文本不属于存储值的内容）。
  private evalElementAccess(node: ts.ElementAccessExpression, ctx: EvalContext): AbstractValue {
    const receiver = this.evalExpr(node.expression, ctx);
    const literalKey = staticIndexKey(node.argumentExpression);
    if (literalKey !== undefined) return readField(receiver, literalKey);
    // Computed index: evaluate the key for effect (a facade sink can sit in it, e.g.
    // `o[await ask()]`); its taint is NOT joined into the read value — the value stored at a
    // key does not textually contain the key, same convention as a ternary condition. THE
    // widening rule: whole-container read, exactness cleared.
    this.evalExpr(node.argumentExpression, ctx);
    return clearExact(collapse(receiver));
  }

  // 仅当接收者是标识符时解析符号，供调用点做菜单体/静态分派；其它形态返回 undefined，
  // 调用方按"接收者未知"降级处理，不得抛错。
  receiverSymbol(expr: ts.Expression): ts.Symbol | undefined {
    return ts.isIdentifier(expr) ? this.checker.getSymbolAtLocation(expr) : undefined;
  }
}
