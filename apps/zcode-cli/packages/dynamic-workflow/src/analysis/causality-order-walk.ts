import ts from "typescript";
import { isFunctionLike } from "./sites.js";
import { applyAt, walkCall } from "./causality-order-calls.js";
import { walkLoop } from "./causality-order-loops.js";
import {
  innermost,
  issuesSince,
  jump,
  locOf,
  openRegion,
  phaseIdOf,
  type TraceState,
} from "./causality-order-state.js";
import { barrier, bindSteps, recordControl, settlesAt } from "./causality-order-settle.js";
import { bindStrands, strandMark, strandsSince } from "./causality-order-strands.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把节点访问器本体
// （语句表走查、await / 赋值 / 短路 / 分支 / switch / try / 跳转的分支）拆到本文件；循环与
// 调用两组各在同名兄弟模块。公开面仍从 causality-order.ts 导出。if 链的判定顺序与原文件
// 逐字一致：`walkLoop` 占原来四个循环分支的位置，之后才落到 forEachChild 兜底。

/** Open a guarded `branch` region and record its control dependence, if any. */
function guarded(
  state: TraceState,
  guard: ts.Expression | undefined,
  node: ts.Node,
  chain: readonly string[],
): readonly string[] {
  // 开一个「受守卫的 branch」区域并返回新的 chain（原 chain 不变）。guard 存在时登记控制依赖；
  // 一律 entered:false（分支体可能不执行），最终 certainty 由父 choice 的 exhaustive 决定。
  const id = openRegion(state, "branch", innermost(state, chain), {
    entered: false,
    loc: locOf(state, node),
  });
  if (guard !== undefined) recordControl(state, guard, id);
  return [...chain, id];
}

/**
 * The region a `break` / `continue` transfers to. Labeled: the labeled statement's own
 * region (a label on a plain block has none — such a jump is dropped, which reads as
 * fall-through; no corpus fixture does this). Unlabeled: the nearest enclosing loop, or
 * for `break` the nearest loop OR switch. Never crosses a function boundary — the
 * language does not let it either.
 */
function jumpTargetOf(state: TraceState, node: ts.BreakOrContinueStatement): string | undefined {
  // 解析 break/continue 的目标区域：带标签时只匹配同标签语句；无标签时取最近循环
  // （break 还接受最近 switch）。
  // 返回 undefined 表示「无处可跳」（如标签落在普通块上 / 不在任何循环内），调用方应丢弃该跳转，
  // 行为上等价于顺序贯穿。循环上界必须停在函数边界：语言本身也不允许跨函数跳转。
  const { regionByStatement } = state;
  const isBreak = ts.isBreakStatement(node);
  for (let cur = node.parent; cur !== undefined && !isFunctionLike(cur); cur = cur.parent) {
    if (node.label !== undefined) {
      if (ts.isLabeledStatement(cur) && cur.label.text === node.label.text) {
        return regionByStatement.get(cur.statement);
      }
      continue;
    }
    if (ts.isIterationStatement(cur, false)) return regionByStatement.get(cur);
    if (isBreak && ts.isSwitchStatement(cur)) return regionByStatement.get(cur);
  }
  return undefined;
}

/**
 * Walk a statement list in order, threading the current phase with REST-OF-BLOCK
 * extent: a marker statement re-points the local, every later statement in the list
 * (and everything nested under it, inlined helper bodies included) inherits it, and the
 * list's end restores what was current on entry. There is no other phase mechanism —
 * every construct that holds a statement list routes through here.
 *
 * A marker NOT in a statement list (`if (x) phase("a");` without braces) is therefore
 * inert: it has no rest-of-list to claim, which is the same "no effect, no diagnostic"
 * status assigned to a marker at the tail of its block.
 */
export function walkStatements(
  state: TraceState,
  statements: readonly ts.Statement[],
  chain: readonly string[],
): void {
  // 按顺序走查语句列表，并以「本列表剩余部分」为范围维护当前阶段：marker 语句改写局部变量，
  // 其后同列表的语句（含嵌套/内联体内）都继承它；列表结束恢复进入时的阶段。
  // 副作用：更新 state.currentPhase 并追加 mark 事件；不返回任何值。
  // 口径：不在语句列表中的 marker（如无花括号的 if 分支）不生效——它没有剩余范围可声明。
  const outer = state.currentPhase;
  for (const statement of statements) {
    const marker = state.markerByStatement.get(statement);
    if (marker !== undefined) {
      // 无名 marker 不会铸造 phase（phaseIdOf 返回 undefined），此时只走查语句、不切阶段。
      const id = phaseIdOf(state, marker);
      if (id !== undefined) {
        state.currentPhase = id;
        // The marker is a leaf of its own: a phase with no step is still a position
        // control passes through (control-flow projection); phase MEMBERSHIP stays on
        // issue events and does not read this.
        state.events.push({ at: "mark", phase: id, regions: chain });
      }
    }
    state.walk(statement, chain);
  }
  state.currentPhase = outer;
}

/** The node visitor: one evaluation-order step over `node`. Bound as `state.walk`. */
// 职责：节点访问器，按求值顺序推进一个节点；所有语句/表达式的时序事实（issue、settle、jump、
// 区域开闭、阶段、控制依赖）都在此产生。chain 为当前区域栈，新区域以 innermost 为父。
// 返回 void（无值语义）；不抛错，未识别节点一律递归子节点兜底（forEachChild），保证不漏走。
// 副作用：写 state（events/regions/phase/栈），纯内存，无 IO。
// 关键口径：函数体不在定义处执行，改由调用点内联；未被调用的函数体在走查末尾统一清扫。
// 不变量：分支判定顺序（函数/块/await/调用/new/tagged/声明/二元/分支/跳转/try/循环/兜底）与
// 原 causality-order.ts 逐字一致，调整顺序会改变事件次序。
export function walkNode(state: TraceState, node: ts.Node, chain: readonly string[]): void {
  const { events, regionByStatement, returnTargets, root, scriptFile, throwTargets, walk } = state;
  // A function body runs when it is called, not where it is written; call sites
  // inline it (see `applyAt` / `inlineBody`), and never-called bodies are swept up at the end.
  if (isFunctionLike(node)) {
    // Bug: the body is deferred, but a COMPUTED MEMBER NAME is not — `{ [await
    // agent(..).ask(..)]() {} }` evaluates the key where it is written, at object
    // construction. Bailing on the whole node left that ask unreached by the walk, so
    // it fell through to the terminal synthetic issue and got a position at the very
    // END of the script. A real forward edge out of it then looked like a back edge
    // and was retyped `carry` (see emission-graph-computed-method-name-obj).
    const { name } = node as ts.NamedDeclaration;
    if (name !== undefined && ts.isComputedPropertyName(name)) walk(name.expression, chain);
    return;
  }

  if (ts.isBlock(node)) {
    // Ordering-wise identical to the `forEachChild` fallthrough; routed here so a
    // marker's extent ends with the block (function bodies included).
    walkStatements(state, node.statements, chain);
    return;
  }

  if (ts.isAwaitExpression(node)) {
    // mark 取「操作数求值前」的事件长度：求值期间产生的 issue 就是本 await 的语法侧确定见证。
    // spawned 取求值前的 strand 计数：求值期间 spawn 的支线都属于本 await 的语法侧 join。
    const mark = events.length;
    const spawned = strandMark(state);
    walk(node.expression, chain);
    // The syntactic half (steps issued while evaluating the operand) is certain; the
    // oracle adds whatever labels the awaited VALUE carries. The operand goes to the
    // barrier as well: it is where the STRANDS this await joins are named.
    const claim = settlesAt(state, node, node.getStart(scriptFile));
    barrier(state, [...issuesSince(state, mark), ...claim.certain], claim.maybe, chain, {
      mark: spawned,
      operand: node.expression,
    });
    return;
  }

  if (ts.isCallExpression(node)) {
    walkCall(state, node, chain);
    return;
  }

  // `new C(args)` applies C's constructor (a script class) or a library constructor's
  // callbacks (`new Promise(executor)`); a tagged template is the call `tag(strings, …)`.
  // Both evaluate their operands first, then apply whatever the oracle recorded there.
  if (ts.isNewExpression(node)) {
    walk(node.expression, chain);
    for (const argument of node.arguments ?? []) walk(argument, chain);
    applyAt(state, node, chain);
    return;
  }
  if (ts.isTaggedTemplateExpression(node)) {
    walk(node.tag, chain);
    walk(node.template, chain);
    applyAt(state, node, chain);
    return;
  }

  if (ts.isVariableDeclaration(node)) {
    if (node.initializer !== undefined) {
      // 声明点不产生 issue，只能靠「初始化表达式求值期间」的范围把 step/strand 绑定到绑定名，
      // 供后续 guard 扫描与 await 语法侧 join 使用。
      const mark = events.length;
      const spawned = strandMark(state);
      walk(node.initializer, chain);
      bindSteps(state, node.name, issuesSince(state, mark));
      bindStrands(state, node.name, strandsSince(state, spawned));
    }
    return;
  }

  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      // Short-circuit: the right operand is guarded by the left — a one-arm, skippable
      // choice.
      walk(node.left, chain);
      const choice = [
        ...chain,
        openRegion(state, "choice", innermost(state, chain), {
          entered: true,
          loc: locOf(state, node),
        }),
      ];
      walk(node.right, guarded(state, node.left, node.right, choice));
      return;
    }
    if (operator === ts.SyntaxKind.EqualsToken) {
      // 赋值同声明：只能用右侧求值期间的范围绑定到左侧标识符；非标识符目标（成员/元素访问）
      // 不建立符号绑定，其值流由 taint 侧负责，这里只保证时序正确。
      const mark = events.length;
      const spawned = strandMark(state);
      walk(node.right, chain);
      if (ts.isIdentifier(node.left)) {
        bindSteps(state, node.left, issuesSince(state, mark));
        bindStrands(state, node.left, strandsSince(state, spawned));
      }
      walk(node.left, chain);
      return;
    }
    walk(node.left, chain);
    walk(node.right, chain);
    return;
  }

  // Branching constructs open a `choice` group whose arms are the guarded `branch`
  // regions. The group records what the arms alone cannot: whether one of them MUST run
  // (`exhaustive`) and whether an arm falls into the next (`fallthrough`, switch only).
  if (ts.isConditionalExpression(node)) {
    walk(node.condition, chain);
    const choice = [
      ...chain,
      openRegion(state, "choice", innermost(state, chain), {
        entered: true,
        exhaustive: true,
        loc: locOf(state, node),
      }),
    ];
    walk(node.whenTrue, guarded(state, node.condition, node.whenTrue, choice));
    walk(node.whenFalse, guarded(state, node.condition, node.whenFalse, choice));
    return;
  }

  if (ts.isIfStatement(node)) {
    walk(node.expression, chain);
    const choice = [
      ...chain,
      openRegion(state, "choice", innermost(state, chain), {
        entered: true,
        loc: locOf(state, node),
        ...(node.elseStatement === undefined ? {} : { exhaustive: true }),
      }),
    ];
    walk(node.thenStatement, guarded(state, node.expression, node.thenStatement, choice));
    if (node.elseStatement !== undefined) {
      walk(node.elseStatement, guarded(state, node.expression, node.elseStatement, choice));
    }
    return;
  }

  if (ts.isSwitchStatement(node)) {
    walk(node.expression, chain);
    const clauses = node.caseBlock.clauses;
    const id = openRegion(state, "choice", innermost(state, chain), {
      entered: true,
      fallthrough: true,
      loc: locOf(state, node),
      ...(clauses.some((clause) => ts.isDefaultClause(clause)) ? { exhaustive: true } : {}),
    });
    const choice = [...chain, id];
    regionByStatement.set(node, id); // `break` inside a clause exits the switch
    for (const clause of clauses) {
      if (ts.isCaseClause(clause)) walk(clause.expression, choice);
      const inside = guarded(state, node.expression, clause, choice);
      walkStatements(state, clause.statements, inside);
    }
    regionByStatement.delete(node);
    return;
  }

  // Unstructured transfers: evaluate the operand first (`throw new Error(await x.ask())`
  // issues a step), then record the jump with its target already resolved to a region.
  if (ts.isReturnStatement(node)) {
    if (node.expression !== undefined) walk(node.expression, chain);
    jump(state, "return", returnTargets[returnTargets.length - 1] ?? root, chain);
    return;
  }

  if (ts.isThrowStatement(node)) {
    walk(node.expression, chain);
    jump(state, "throw", throwTargets[throwTargets.length - 1] ?? root, chain);
    return;
  }

  if (ts.isBreakOrContinueStatement(node)) {
    const target = jumpTargetOf(state, node);
    if (target !== undefined)
      jump(state, ts.isBreakStatement(node) ? "break" : "continue", target, chain);
    return;
  }

  if (ts.isTryStatement(node)) {
    const group = openRegion(state, "try", innermost(state, chain), {
      entered: true,
      loc: locOf(state, node),
    });
    const inGroup = [...chain, group];
    const attempt = openRegion(state, "attempt", group, {
      entered: true,
      loc: locOf(state, node.tryBlock),
    });
    throwTargets.push(attempt);
    walk(node.tryBlock, [...inGroup, attempt]);
    throwTargets.pop();
    if (node.catchClause !== undefined) {
      // The clause's binding (`catch (e)`) declares nothing that issues; only the block
      // is walked. A `throw` inside it resolves to the OUTER attempt — catch is a sibling
      // of attempt, not a child.
      const id = openRegion(state, "catch", group, {
        entered: false,
        loc: locOf(state, node.catchClause),
      });
      walk(node.catchClause.block, [...inGroup, id]);
    }
    if (node.finallyBlock !== undefined) {
      const id = openRegion(state, "finally", group, {
        entered: true,
        loc: locOf(state, node.finallyBlock),
      });
      walk(node.finallyBlock, [...inGroup, id]);
    }
    return;
  }

  if (walkLoop(state, node, chain)) return;

  ts.forEachChild(node, (child) => walk(child, chain));
}
