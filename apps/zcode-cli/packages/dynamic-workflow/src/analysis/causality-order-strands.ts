import ts from "typescript";
import { isGlobalLibValue } from "./callbacks.js";
import { boundIdentifiers } from "./causality-order-functions.js";
import type { TraceState } from "./causality-order-state.js";

// 走查原本只有一个全局 `settled` 集合，于是内联的 `async` 体里的 `await` 会替整个
// 脚本把 step 结算掉——把 `A ∥ B → C` 压成一条串行时间线。改成「每条 strand 一个 frame」之后，记账（strand 记录、frame 栈、被 await 的
// 位置扫描、join 解析）本该落在 -state / -settle 两个兄弟模块，但它们已经贴着 oxlint
// max-lines 上限（400 行），所以单开本文件。这里只读写 {@link TraceState}，不递归进 walk；
// 公开面仍从 causality-order.ts 导出。

/**
 * One open activation's settled set. The root body is the first frame and is never a
 * strand; every strand pushes one more. A step is settled FROM A FRAME'S VIEW when some
 * frame on the stack holds it — which is the whole of the fix: a barrier inside a strand
 * no longer settles anything for the spawner, because the spawner's frame is below it and
 * the strand's frame is popped when the strand closes.
 */
export interface Frame {
  // 该 frame 所属的 call/fanout 区域 id；根 frame 为根区域，不对应任何 strand。
  readonly region: string;
  // 从「这一帧视角」已 settle 的 step 集合；只增不减，frame 弹出即随之消失。
  readonly settled: Set<string>;
}

/** One strand the walk spawned, in spawn order. */
// 一次 spawn 出来的并发支线（async 体 / fan-out 回调）。记录只属于本次走查，随 state 一起丢弃。
export interface StrandRecord {
  /** The `call` / `fanout` region that IS the strand. */
  readonly region: string;
  /**
   * Spawn order: this record's own index in `state.strands`. A barrier joins every strand
   * with `at >= the count it saw when it took its mark`, which is "spawned while the
   * operand was evaluated". Deliberately NOT an event index: a strand that emits no event
   * before the await inside it would then tie with that await's mark, and the barrier
   * would join the very strand it stands in (`await ask()` as the first statement of an
   * `async` helper settled the helper's own summary into its own frame).
   */
  readonly at: number;
  /** Steps issued inside it (the innermost open strand at each issue) — the lift rule. */
  readonly issued: Set<string>;
  /** What the strand itself awaited: its frame's settled set at close. */
  // 该 strand 关闭时其 frame 的 settled 快照，即「它自己等待过什么」；closeStrand 才赋值，
  // 关闭前为空集。join 时按此集合的确定性分级（certain / maybe）。
  summary: ReadonlySet<string>;
  /** False until the body finished. Only a CLOSED strand can be lifted. */
  // 体是否走完；未关闭的 strand 不能被 lift（它还在跑，其 issue 尚未可等待）。
  closed: boolean;
}

/** The awaited expression a barrier stands over, with the strand count it started at. */
// await 屏障的待等操作数：mark 为开始求值该操作数时的 strand 计数（用于「求值期间 spawn 的
// 支线」判定），operand 为表达式本身（用于扫描被 await 位置上的标识符）。两者一起构成语法侧 join。
export interface AwaitedOperand {
  /** `state.strands.length` where the operand's evaluation began. */
  mark: number;
  operand: ts.Expression;
}

/** The frame a fresh settle lands in: the innermost open one. */
export function currentFrame(state: TraceState): Frame {
  // 新 settle 落点：栈顶（最内层）frame。调用方须保证 frames 非空——根 frame 在走查开始时压入，
  // 任何 closeStrand 都不会弹到空，因此这里直接断言存在。
  return state.frames[state.frames.length - 1] as Frame;
}

/** True iff some frame on the stack has settled `step` — the freshness test. */
// 「可见已 settle」判定：栈上任意一帧包含该 step 即为真。这是 strand 模型的关键——strand 内
// 的屏障不会替 spawner 结算，因为 spawner 的帧在更下层、且随 strand 关闭被弹出。
export function isVisiblySettled(state: TraceState, step: string): boolean {
  return state.frames.some((frame) => frame.settled.has(step));
}

/** The strand an `issue` belongs to: the innermost one still being walked. */
export function innermostOpenStrand(state: TraceState): StrandRecord | undefined {
  // 从最新往旧扫描，找到第一个未关闭的 strand 即「当前 issue 归属」；不存在（根体）返回 undefined。
  // 必须反向遍历：strands 按 spawn 顺序追加，最新的一定在末尾，倒扫是最坏 O(n) 的常用快路。
  for (let i = state.strands.length - 1; i >= 0; i -= 1) {
    const record = state.strands[i] as StrandRecord;
    if (!record.closed) return record;
  }
  return undefined;
}

/** Spawn a strand on `region`: record it and push its frame. */
export function openStrand(state: TraceState, region: string): StrandRecord {
  // 开启一条 strand：at 取当前计数（即本记录下标），同时压入同名 frame。
  // 记录与 frame 必须成对：closeStrand 依赖栈顶就是本条记录的 frame，中途不能穿插它们的压栈。
  const record: StrandRecord = {
    at: state.strands.length,
    closed: false,
    issued: new Set<string>(),
    region,
    summary: new Set<string>(),
  };
  state.strands.push(record);
  state.frames.push({ region, settled: new Set<string>() });
  return record;
}

/** Close a strand: pop its frame and keep what it awaited as the strand's summary. */
export function closeStrand(state: TraceState, record: StrandRecord): void {
  // 关闭 strand：弹出其 frame，并把该 frame 的 settled 快照保存为 summary（lift 的依据）。
  // 先置 closed=true 使后续 lift/issue 归属不再选中它；弹栈结果可能为空（防御性），此时用空集。
  const frame = state.frames.pop();
  record.summary = frame?.settled ?? new Set<string>();
  record.closed = true;
}

/** The walk's strand counter: the mark a caller takes before evaluating an expression. */
export function strandMark(state: TraceState): number {
  return state.strands.length;
}

/** Strand regions spawned at or after `mark`, in spawn order. */
export function strandsSince(state: TraceState, mark: number): string[] {
  return state.strands.filter((record) => record.at >= mark).map((record) => record.region);
}

/**
 * Bind strand regions to the identifiers a declaration or assignment introduces — the
 * syntactic half of the join, the exact shape `bindSteps` gives steps and for the same
 * reason: `const work = ids.map(async …)` issues nothing at the declaration, so only the
 * binding can tell a later `await Promise.all(work)` which strands `work` stands for.
 */
export function bindStrands(
  state: TraceState,
  name: ts.BindingName,
  regions: readonly string[],
): void {
  // 把 strand 区域绑定到声明/赋值引入的标识符：语法侧的 join 依据（`const work = ids.map(async…)`
  // 在声明处不 issue 任何东西，只能靠绑定告诉后续 `await Promise.all(work)`）。
  // regions 为空则直接返回；符号解析不到则跳过。集合语义为单调并集，多次绑定不覆盖。
  if (regions.length === 0) return;
  for (const identifier of boundIdentifiers(name)) {
    const symbol = state.checker.getSymbolAtLocation(identifier);
    if (symbol === undefined) continue;
    const set = state.strandsBySymbol.get(symbol) ?? new Set<string>();
    for (const region of regions) set.add(region);
    state.strandsBySymbol.set(symbol, set);
  }
}

/** True iff the applied function carries the `async` modifier — what makes a body a strand. */
export function isAsyncFunction(decl: ts.Node): boolean {
  // 判定函数节点是否带 async 修饰符（即其体是否应作为一条 strand）。无修饰符或非函数节点
  // 均返回 false；只读语法，不看类型，故无法识别「返回 Promise 的普通函数」。
  const { modifiers } = decl as { modifiers?: ts.NodeArray<ts.ModifierLike> };
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/** The promise combinators that adopt each argument, so each argument is an awaited position. */
const COMBINATORS: ReadonlySet<string> = new Set(["all", "allSettled", "race", "any"]);

function isPromiseCombinator(state: TraceState, node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !COMBINATORS.has(callee.name.text)) return false;
  return isGlobalLibValue(callee.expression, "Promise", state.checker, state.program);
}

/**
 * The identifiers in an AWAITED POSITION of an awaited expression: the operand itself,
 * each argument of `Promise.all` / `allSettled` / `race` / `any`, each element of an array
 * literal, a spread's operand, and through parentheses and type assertions. Every other
 * expression is OPAQUE — this mirrors how the runtime adopts promises, and it is what
 * keeps `await f(aWork.length)` from joining the strands `aWork` holds.
 */
function awaitedIdentifiers(state: TraceState, operand: ts.Expression): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const scan = (node: ts.Expression): void => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSpreadElement(node)
    ) {
      scan(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      out.push(node);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) scan(element);
      return;
    }
    if (ts.isCallExpression(node) && isPromiseCombinator(state, node)) {
      for (const argument of node.arguments) scan(argument);
    }
  };
  scan(operand);
  return out;
}

/**
 * The strands a barrier waits for, split by the certainty each one's summary settles with,
 * and MARKED JOINED so a second await of the same promise adds nothing (exactly as a
 * second settle of one step already does).
 *
 * Two ways in. SYNTACTIC — spawned while the operand was evaluated, or bound to an
 * identifier in an awaited position of it — settles the summary certainly: the await
 * provably waits for that activation. LIFTED — a closed, not-yet-joined strand one of whose
 * issued steps this barrier claims — settles it with the certainty the claim came in with:
 * the promise reached the await through a container or a helper, and all we know is that
 * something the strand issued has settled.
 */
export function joinStrands(
  state: TraceState,
  certain: readonly string[],
  maybe: readonly string[],
  awaited: AwaitedOperand | undefined,
): { certain: string[]; maybe: string[] } {
  // 职责：计算一个屏障应当 join 的 strand 集合，并按 summary 的确定性分成 certain/maybe。
  // 输入：certain/maybe 为本屏障已确定的 step 集合；awaited 为待等操作数（deferred 回调
  // 前奏等场景没有操作数，传 undefined，只走 lifted 路径）。
  // 输出：新对象，两数组为区域 id；已 join 过的区域不会重复出现（joined 集合去重）。
  // 两条入路：syntactic（操作数求值期间 spawn 的、或绑定在待等位置标识符上的）→ certain；
  // lifted（已关闭、未 join、且有 issued step 被本屏障 claim 的）→ 跟随 claim 的确定性。
  // 副作用：把入选区域写入 state.joined（第二次 await 同一 promise 不再新增）。
  const joins: { certain: string[]; maybe: string[] } = { certain: [], maybe: [] };
  const take = (region: string, side: string[]): void => {
    // 已 join 过就丢弃：重复 await 同一 promise 不应制造第二次 join 事实。
    if (state.joined.has(region)) return;
    state.joined.add(region);
    side.push(region);
  };
  if (awaited !== undefined) {
    for (const region of strandsSince(state, awaited.mark)) take(region, joins.certain);
    for (const identifier of awaitedIdentifiers(state, awaited.operand)) {
      const symbol = state.checker.getSymbolAtLocation(identifier);
      const bound = symbol === undefined ? undefined : state.strandsBySymbol.get(symbol);
      for (const region of bound ?? []) take(region, joins.certain);
    }
  }
  for (const record of state.strands) {
    // 只 lift 已关闭的 strand：未关闭的还在跑，其 issue 尚未可等待，join 会虚构排序。
    if (!record.closed || state.joined.has(record.region)) continue;
    // certain 优先：同一 strand 同时被两边命中时按确定处理（更弱的一侧不再重复计入）。
    if (certain.some((step) => record.issued.has(step))) take(record.region, joins.certain);
    else if (maybe.some((step) => record.issued.has(step))) take(record.region, joins.maybe);
  }
  return joins;
}
