import ts from "typescript";
import {
  innermost,
  issuesSince,
  locOf,
  openRegion,
  type TraceState,
} from "./causality-order-state.js";
import { barrier, recordControl, settlesAt } from "./causality-order-settle.js";
import { strandMark } from "./causality-order-strands.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把循环语句的访问器
// （for / for-of / for-in / while / do…while）连同 `for` 字面量轮数的推导拆到本文件；公开面
// 仍从 causality-order.ts 导出。{@link walkLoop} 在 walk 的 if 链里占原来四个分支的位置，
// 判定顺序与原文件逐字一致。

/** Walk a loop body with its statement registered as a jump target for the duration. */
// 走查循环体：先把循环语句本身登记为跳转目标（regionByStatement），再以追加了 loop 区域的
// chain 走查 body，结束后立刻移除登记。登记期间该语句上的 break/continue 才能解析到对应区域；
// 必须是成对的 set/delete，否则后续走查会误命中残留映射。
function walkLoopBody(
  state: TraceState,
  statement: ts.Node,
  body: ts.Node,
  chain: readonly string[],
): void {
  state.regionByStatement.set(statement, innermost(state, chain));
  state.walk(body, chain);
  state.regionByStatement.delete(statement);
}

/** The loop cases of the visitor. Returns false when `node` is not a loop statement. */
// 职责：识别并走查五类循环语句（for / for-of / for-in / while / do…while），返回是否已处理。
// 返回 false 表示「不是循环语句」，调用方继续尝试后面的分支；返回 true 时已完成整个循环走查。
// 输入 chain 为当前区域栈（由外到内），新 loop 区域以 innermost(state, chain) 为父。
// 副作用：写 state（events、regions、regionByStatement），无 IO。
// 语义口径：for 的 entered 由字面量轮数推导决定；for-of/for-in/while 一律 entered:false（可能零次），
// do…while 首次必然进入故 entered:true 且条件不作为 guard。
export function walkLoop(state: TraceState, node: ts.Node, chain: readonly string[]): boolean {
  const { walk } = state;
  if (ts.isForStatement(node)) {
    // 初始化/条件/增量都必须先走查：它们内部可能有 sink（如条件里调 ask），且顺序即求值顺序。
    const { bound, entered } = literalForBound(node);
    if (node.initializer !== undefined) walk(node.initializer, chain);
    if (node.condition !== undefined) walk(node.condition, chain);
    if (node.incrementor !== undefined) walk(node.incrementor, chain);
    const id = openRegion(state, "loop", innermost(state, chain), {
      entered,
      loc: locOf(state, node),
      ...(bound === undefined ? {} : { bound }),
    });
    if (node.condition !== undefined) recordControl(state, node.condition, id);
    walkLoopBody(state, node, node.statement, [...chain, id]);
    return true;
  }

  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const mark = state.events.length;
    const spawned = strandMark(state);
    // 先记录 mark/strand 再走表达式：for-await 的屏障需要「表达式及其内部 spawn」的范围起点。
    walk(node.expression, chain);
    const id = openRegion(state, "loop", innermost(state, chain), {
      entered: false,
      loc: locOf(state, node),
    });
    const inside = [...chain, id];
    // `for await (… of …)` awaits every element, so each iteration opens with a
    // barrier over whatever the iterated expression issued — plus, from the oracle,
    // whatever labels that expression's VALUE carries (an array of pending promises
    // issues nothing at this point, which is the whole reason the oracle exists).
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
      const claim = settlesAt(state, node.expression, node.expression.getStart(state.scriptFile));
      barrier(state, [...issuesSince(state, mark), ...claim.certain], claim.maybe, inside, {
        mark: spawned,
        operand: node.expression,
      });
    }
    walk(node.initializer, inside);
    walkLoopBody(state, node, node.statement, inside);
    return true;
  }

  if (ts.isWhileStatement(node)) {
    walk(node.expression, chain);
    const id = openRegion(state, "loop", innermost(state, chain), {
      entered: false,
      loc: locOf(state, node),
    });
    recordControl(state, node.expression, id);
    walkLoopBody(state, node, node.statement, [...chain, id]);
    return true;
  }

  if (ts.isDoStatement(node)) {
    // A `do…while` body is unconditional on first entry, so it is `entered` and its
    // condition is NOT a guard.
    const id = openRegion(state, "loop", innermost(state, chain), {
      entered: true,
      loc: locOf(state, node),
    });
    walkLoopBody(state, node, node.statement, [...chain, id]);
    walk(node.expression, [...chain, id]);
    return true;
  }

  return false;
}

/**
 * A `for` loop's provable entry and round count: `for (let i = <a>; i < <b>; i++)`
 * with numeric literals and `a < b` runs `b - a` times. `entered` needs only the
 * literal comparison; `bound` additionally needs a unit increment, or the count would
 * be a guess.
 */
function literalForBound(node: ts.ForStatement): { entered: boolean; bound?: number } {
  // 推导 for 的可证明进入性与轮数：仅识别 `for (let i = <数值字面量>; i < <数值字面量>; i++)`
  // 这类形态。任一环节不匹配就返回 { entered: false }（不猜），调用方据此不写 bound。
  // entered 只需要字面量比较成立；bound 还需要单位步增，否则轮数只是猜测。
  const initializer = node.initializer;
  const condition = node.condition;
  if (initializer === undefined || !ts.isVariableDeclarationList(initializer)) {
    return { entered: false };
  }
  const decl = initializer.declarations[0];
  if (decl === undefined || !ts.isIdentifier(decl.name) || decl.initializer === undefined) {
    return { entered: false };
  }
  const start = numericValue(decl.initializer);
  if (start === undefined || condition === undefined || !ts.isBinaryExpression(condition)) {
    return { entered: false };
  }
  if (!ts.isIdentifier(condition.left) || condition.left.text !== decl.name.text) {
    // 比较左侧必须正是被声明的循环变量，否则无法把轮数与该变量绑定，宁可不给 bound。
    return { entered: false };
  }
  const limit = numericValue(condition.right);
  if (limit === undefined) return { entered: false };

  const operator = condition.operatorToken.kind;
  const rounds =
    operator === ts.SyntaxKind.LessThanToken && start < limit
      ? limit - start
      : operator === ts.SyntaxKind.LessThanEqualsToken && start <= limit
        ? limit - start + 1
        : undefined;
  if (rounds === undefined) return { entered: false };
  return isUnitIncrement(node.incrementor, decl.name.text)
    ? { bound: rounds, entered: true }
    : { entered: true };
}

function numericValue(expr: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = numericValue(expr.operand);
    return inner === undefined ? undefined : -inner;
  }
  return undefined;
}

function isUnitIncrement(incrementor: ts.Expression | undefined, name: string): boolean {
  if (incrementor === undefined) return false;
  if (
    ts.isPostfixUnaryExpression(incrementor) &&
    incrementor.operator === ts.SyntaxKind.PlusPlusToken
  ) {
    return ts.isIdentifier(incrementor.operand) && incrementor.operand.text === name;
  }
  if (
    ts.isPrefixUnaryExpression(incrementor) &&
    incrementor.operator === ts.SyntaxKind.PlusPlusToken
  ) {
    return ts.isIdentifier(incrementor.operand) && incrementor.operand.text === name;
  }
  if (
    ts.isBinaryExpression(incrementor) &&
    incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    ts.isIdentifier(incrementor.left) &&
    incrementor.left.text === name
  ) {
    return numericValue(incrementor.right) === 1;
  }
  return false;
}
