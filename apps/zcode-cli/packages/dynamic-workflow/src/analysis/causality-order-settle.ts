import ts from "typescript";
import type { TaintOcc } from "./domain.js";
import { isFunctionLike } from "./sites.js";
import { boundIdentifiers } from "./causality-order-functions.js";
import type { TraceState } from "./causality-order-state.js";
import {
  currentFrame,
  isVisiblySettled,
  joinStrands,
  type AwaitedOperand,
} from "./causality-order-strands.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把 await 屏障与神谕读取
// 这一组（时间不变量准入、settle-certainty 规则、屏障、变量→step 绑定、守卫的控制依赖）拆到
// 本文件；公开面仍从 causality-order.ts 导出。它们只读写 {@link TraceState}，不递归进 walk。
// strand / frame 这一层的记账在 causality-order-strands.ts（同样是 400 行上限逼出来的）。

/** An oracle lookup split by the settle-certainty rule. Readonly because {@link NO_CLAIM}
 * is a shared singleton — an in-place edit of an empty result would leak everywhere. */
interface OracleClaim {
  certain: readonly string[];
  maybe: readonly string[];
}

// 神谕读取结果：certain 为可确定已 settle 的 step 集合，maybe 为可能 settle 的集合；
// 两集合互斥（一个 step 只落一边）。只读类型 + NO_CLAIM 单例，调用方不得原地修改。
const NO_CLAIM: OracleClaim = { certain: [], maybe: [] };

/**
 * The iteration constructs (loop statements and iteration-candidate callbacks) that
 * lexically enclose a node, memoized. Repetition is what makes a settle of a
 * not-yet-issued step realizable, so this is the test {@link admissionOf} needs.
 */
function iterationAncestorsOf(state: TraceState, node: ts.Node): Set<ts.Node> {
  // 取节点的「迭代祖先」集合（循环语句 + 迭代候选回调），结果按节点缓存在 state 中。
  // 缓存命中直接返回；注意返回的是共享 Set，调用方只能读，不能增删（否则污染其它查询）。
  const cached = state.iterationAncestorCache.get(node);
  if (cached !== undefined) return cached;
  const out = new Set<ts.Node>();
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (
      ts.isForStatement(cur) ||
      ts.isForOfStatement(cur) ||
      ts.isForInStatement(cur) ||
      ts.isWhileStatement(cur) ||
      ts.isDoStatement(cur) ||
      state.candByCallback.has(cur) ||
      state.eachCallbackFns.has(cur)
    ) {
      out.add(cur);
    }
  }
  state.iterationAncestorCache.set(node, out);
  return out;
}

/**
 * THE TEMPORAL INVARIANT: a promise cannot settle before its request issues. The oracle
 * is flow-INsensitive while this walk is flow-sensitive, so an occurrence set can name a
 * step that has not been issued at this point in evaluation order, and settling it here
 * would be a temporally impossible event. Returns HOW the witness was admitted, because
 * the two ways carry different certainty (see {@link claimAt}).
 *
 * Bug this fixes: in async-promise-double-await-mutate, `first.steps.push(extra)` merges
 * ask#2's label into the very slot `plan` denotes, so the EARLIER `await plan` read
 * {ask#1, ask#2}. That phantom settle of ask#2 both cost the await its singleton-exact
 * certainty and emitted `ask#2 -> ask#3 seq maybe`, which dedupeFacts' min-certainty
 * merge then used to demote a true `data always` edge.
 *
 * The `repetition` carve-out is not optional. A step issued LATER IN THE WALK but sharing
 * an enclosing iteration construct with the await is realizable by REPETITION: iteration
 * k's promise settles at iteration k+1's await, which is exactly the loop-carried settle
 * the oracle exists to find (reduce-accumulator awaits the accumulator, i.e. the previous
 * round's ask, before issuing this round's). A bare `issued.has(step)` test drops it, the
 * barrier falls through to a widening that finds nothing pending inside the region, and
 * the step loses its `serial` cue for a `stack` that claims N concurrent instances the
 * script serializes — trading a model-only certainty bit for a wrong cue that is DRAWN.
 * This mirrors `realizableCarry` in causality-graph.ts, which decides backwards edges by
 * the same "a shared iteration region is what repetition can realize" rule.
 */
function admissionOf(
  state: TraceState,
  awaitNode: ts.Node,
  step: string,
): "issued" | "repetition" | undefined {
  // 时间不变量准入判定：step 已在本走查中 issue → "issued"；否则仅当 await 与 step 的调用点
  // 共享同一迭代祖先时才算 "repetition"（重复执行可让后一轮 await 等到前一轮的 issue）。
  // 都不满足返回 undefined = 此刻不可能 settle（必须丢弃该幻影见证）。
  if (state.issued.has(step)) return "issued";
  const call = state.callByStep.get(step);
  // 没有调用点就无法判断重复性（非 ask 类 step），保守地拒绝。
  if (call === undefined) return undefined;
  const enclosing = iterationAncestorsOf(state, awaitNode);
  // await 本身不在任何迭代结构里，就不可能靠重复实现，直接拒绝。
  if (enclosing.size === 0) return undefined;
  for (const ancestor of iterationAncestorsOf(state, call)) {
    if (enclosing.has(ancestor)) return "repetition";
  }
  return undefined;
}

/**
 * Read one oracle position and split it by the SETTLE-CERTAINTY RULE: a singleton exact
 * witness is certain, anything else is a may-claim.
 *
 * `admit` applies the temporal invariant ({@link admissionOf}) BEFORE the singleton
 * judgement, and that order is load-bearing: dropping a phantom witness is what lets the
 * surviving set be a singleton and settle certainly. Judging first and filtering after
 * would leave the phantom's vote counted.
 *
 * A witness admitted by REPETITION never settles certainly, even as a singleton exact
 * one, because the ordering it would claim fails at BOTH ends of the loop: the first
 * iteration awaits the initial value and settles nothing, and the last iteration's issue
 * escapes the loop unawaited (the head await of iteration k+1 never runs), so that
 * instance is still pending afterwards. A certain claim there would assert a post-loop
 * ordering the final instance violates — over-ordering as a may-claim is the licensed
 * direction, over-CERTAINTY on a real edge is not. `order-loop-head-await-tail-issue`
 * pins it. The demotion costs the multiplicity cue nothing: `settledInside` records the
 * step whatever the event's certainty, so a `serial` cue survives it.
 *
 * Guard lookups pass no `admit` — see the note on {@link controllersOf}.
 */
function claimAt(
  state: TraceState,
  map: Map<number, TaintOcc[]>,
  at: number,
  admit?: (step: string) => "issued" | "repetition" | undefined,
): OracleClaim {
  const occs = (map.get(at) ?? []).filter((occ) => state.realSteps.has(occ.site));
  // Dedupe by site, OR-ing exactness the way the domain's own addOcc merges witnesses.
  // `certainOk` is per-SITE: admission is a property of the site, not of an occurrence.
  const bySite = new Map<string, { exact: boolean; certainOk: boolean }>();
  for (const occ of occs) {
    const how = admit === undefined ? "issued" : admit(occ.site);
    if (how === undefined) continue; // temporally impossible at this point in the walk
    // 同一站点多条见证：exact 取逻辑或（任一精确即精确），certainOk 以首次出现的准入方式为准。
    const existing = bySite.get(occ.site);
    if (existing === undefined)
      bySite.set(occ.site, { certainOk: how === "issued", exact: occ.exact });
    else existing.exact = existing.exact || occ.exact;
  }
  const sites = [...bySite.keys()];
  if (sites.length === 0) return NO_CLAIM;
  const only = sites[0] as string;
  const solo = bySite.get(only) as { exact: boolean; certainOk: boolean };
  if (sites.length === 1 && solo.exact && solo.certainOk) return { certain: [only], maybe: [] };
  return { certain: [], maybe: sites };
}

export function settlesAt(state: TraceState, node: ts.Node, at: number): OracleClaim {
  // 读取位置 `at` 上的 settle 神谕，并按 settle-certainty 规则拆分，同时施加时间不变量准入
  // （node 是该位置的语法节点，用于判断「重复是否可实现」）。无见证时返回共享 NO_CLAIM。
  return claimAt(state, state.oracle.awaitSettles, at, (step) => admissionOf(state, node, step));
}

/**
 * An `await` barrier over the union of what the two halves resolved, plus the summaries of
 * the STRANDS it joins: `certain` settles as a certainty, `maybe` as a may-claim (a step
 * claimed by both counts as certain). Steps already settled IN A VISIBLE FRAME drop out,
 * and a claim that has entirely settled already is a no-op. Widening is reached only when
 * the claim and every joined summary were empty to begin with.
 *
 * The already-settled no-op is not new; what changed is that it became REACHABLE. Before
 * the settle oracle, an indirect await (`await held`, `await p` in a helper, a second await of
 * one promise) resolved to the empty set, so every such await fell through to widening and
 * manufactured `seq maybe` claims over unrelated steps still in flight. The oracle makes
 * the claim non-empty, so the no-op catches it and those spurious barriers disappear —
 * which is why several async-promise-* snapshots got STRONGER certainties once the oracle
 * landed rather than gaining edges.
 *
 * Two frame rules carry the strand model:
 * freshness is judged against EVERY frame on the stack, because a step the spawner
 * already awaited is settled for the strands it spawns; fresh steps are recorded in the
 * CURRENT frame alone, because this activation's await tells the spawner nothing.
 * `awaited` is the operand this barrier stands over, which {@link joinStrands} scans for
 * the promises it names; a barrier with no operand (a deferred callback's receiver
 * prologue) can still LIFT a strand out of its own claim.
 */
export function barrier(
  state: TraceState,
  certain: readonly string[],
  maybe: readonly string[],
  chain: readonly string[],
  awaited?: AwaitedOperand,
): void {
  // 职责：在 chain 所指区域上发出 await 屏障事件，把 certain/maybe 两半的 step、以及所连接
  // strand 的摘要，登记为已 settle（同一 step 两边都命中按 certain 计）。
  // 输入：certain/maybe 为神谕结论（可为空数组）；awaited 可选，用于 joinStrands 扫描其命名的 promise。
  // 输出：无返回值，只写 state.events 与当前 frame.settled（供后续「可见帧已 settle」判断）。
  // 分级：先过滤掉在可见帧里已 settle 的 step，只记录新的；全部已 settle 则退化为 join-only 事件。
  // 兜底：两半都为空且无待决 step 时什么都不发；有待决 step 时做 widening（假定在飞的全部已 settle），
  // 方向是过序（低估并发），绝不虚构并发。
  const { events, issued } = state;
  const joins = joinStrands(state, certain, maybe, awaited);
  const summaryOf = (regions: readonly string[]): string[] =>
    regions.flatMap((region) => [
      ...(state.strands.find((record) => record.region === region)?.summary ?? []),
    ]);
  // A joined strand contributes what IT awaited: syntactically joined certainly, lifted
  // with the certainty of the claim that lifted it.
  const allCertain = [...certain, ...summaryOf(joins.certain)];
  const allMaybe = [...maybe, ...summaryOf(joins.maybe)];
  const joined = [...joins.certain, ...joins.maybe];

  const frame = currentFrame(state);
  const freshCertain: string[] = [];
  for (const step of allCertain) {
    if (!isVisiblySettled(state, step) && !freshCertain.includes(step)) freshCertain.push(step);
  }
  for (const step of freshCertain) frame.settled.add(step);
  const freshMaybe: string[] = [];
  for (const step of allMaybe) {
    if (!isVisiblySettled(state, step) && !freshMaybe.includes(step)) freshMaybe.push(step);
  }
  for (const step of freshMaybe) frame.settled.add(step);

  // `joins` rides the FIRST event this barrier emits: it is a property of the barrier, not
  // of either certainty side, and the control-flow projection reads it as one set.
  const withJoins = joined.length === 0 ? {} : { joins: joined };
  if (freshCertain.length > 0) {
    events.push({ at: "settle", maybe: false, regions: chain, steps: freshCertain, ...withJoins });
  }
  if (freshMaybe.length > 0) {
    events.push({
      at: "settle",
      maybe: true,
      regions: chain,
      steps: freshMaybe,
      ...(freshCertain.length > 0 ? {} : withJoins),
    });
  }
  if (freshCertain.length > 0 || freshMaybe.length > 0) return;
  // Nothing fresh to settle, but a join is a control-flow fact of its own: it is where the
  // strand's parked exits reconnect, so it is recorded even with no steps to its name.
  const joinOnly = (): void => {
    if (joined.length === 0) return;
    events.push({ at: "settle", joins: joined, maybe: false, regions: chain, steps: [] });
  };
  if (allCertain.length > 0 || allMaybe.length > 0) {
    joinOnly(); // already settled: adds no step
    return;
  }
  // Widened barrier: neither half resolved anything, so assume everything in flight
  // settled. Over-orders (understates parallelism), never invents concurrency.
  const pending = [...issued].filter((step) => !isVisiblySettled(state, step));
  if (pending.length === 0) {
    joinOnly();
    return;
  }
  for (const step of pending) frame.settled.add(step);
  events.push({ at: "settle", maybe: true, regions: chain, steps: pending, ...withJoins });
}

export function bindSteps(state: TraceState, name: ts.BindingName, steps: readonly string[]): void {
  // 把一组 step 绑定到绑定名引入的所有符号上，供后续 guard 扫描（stepsBySymbol）识别数据来源。
  // steps 为空时直接返回（避免为无来源的绑定建空集合）；符号解析不到（未命名/无法解析）则跳过。
  // 单调累加语义：同一符号多次绑定只做集合并，不覆盖先前来源。
  if (steps.length === 0) return;
  for (const identifier of boundIdentifiers(name)) {
    const symbol = state.checker.getSymbolAtLocation(identifier);
    if (symbol === undefined) continue;
    const set = state.stepsBySymbol.get(symbol) ?? new Set<string>();
    for (const step of steps) set.add(step);
    state.stepsBySymbol.set(symbol, set);
  }
}

/**
 * Steps whose answers the guard expression reads, as the UNION of the syntactic
 * `stepsBySymbol` scan (certain witnesses) and the taint oracle's `guardReads`. A step
 * both sides claim counts once, as certain.
 *
 * Do not "simplify" this into the oracle alone. The scan is the ONLY side that sees an
 * implicit flow — `const flag = (await ask()) ? 1 : 2; if (flag)` taints nothing, because
 * a condition never joins the data contract — and the oracle is the only side that sees a
 * derived binding (`const ok = t.escalate`), whose declaration issues nothing for the
 * scan to record. Dropping either half silently loses a `control` edge; both cases are
 * pinned (order-implicit-flow-guard, order-derived-guard-control).
 */
function controllersOf(
  state: TraceState,
  guard: ts.Expression,
): { controllers: string[]; maybeControllers: string[] } {
  const controllers: string[] = [];
  const scan = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (ts.isIdentifier(node)) {
      const symbol = state.checker.getSymbolAtLocation(node);
      const steps = symbol === undefined ? undefined : state.stepsBySymbol.get(symbol);
      if (steps !== undefined) {
        for (const step of steps) if (!controllers.includes(step)) controllers.push(step);
      }
      return;
    }
    ts.forEachChild(node, scan);
  };
  scan(guard);
  const claim = claimAt(state, state.oracle.guardReads, guard.getStart(state.scriptFile));
  for (const step of claim.certain) if (!controllers.includes(step)) controllers.push(step);
  return {
    controllers,
    maybeControllers: claim.maybe.filter((step) => !controllers.includes(step)),
  };
}

/** Record a guard's control dependence against a region, when it has any. */
export function recordControl(state: TraceState, guard: ts.Expression, region: string): void {
  // 记录「该 region 的控制依赖来自这个 guard」；只有存在控制方（确定或可能）时才写一条，
  // 避免为无来源的 guard 生成空 controls 条目。副作用：向 state.controls 追加。
  const { controllers, maybeControllers } = controllersOf(state, guard);
  if (controllers.length > 0 || maybeControllers.length > 0) {
    state.controls.push({ controllers, maybeControllers, region });
  }
}
