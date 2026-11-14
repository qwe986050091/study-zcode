import ts from "typescript";
import { WORKFLOW_FUNCTION_NAME, type ScriptLoc } from "../compiler/compile.js";

/**
 * The abstract domain of the taint pass and the pure algebra over it. See taint.ts
 * for the analysis that drives these values to a fixpoint.
 *
 * An {@link AbstractValue} carries three orthogonal facts about a runtime value:
 *  - `occs`: the taint labels (artifact/actor site ids) that may have flowed into it,
 *    plus symbolic parameter {@link Placeholder}s when we are inside a function body;
 *  - `fields`: statically-known members (object-literal props, array/tuple indices),
 *    so `x.f` and `[a, b]` stay field-sensitive;
 *  - `fns`: script-local functions reachable as this value, keeping the call graph
 *    total under higher-order code.
 *
 * Every merge is a weak (join-only) union — the analysis is gen-only, so values only
 * ever grow, which is what drives the monotone fixpoint to convergence.
 */

/** A taint occurrence: a site/actor label with an exactness bit and optional join port. */
export interface TaintOcc {
  site: string;
  exact: boolean;
  port?: number;
}

/** Symbolic taint of a function parameter, used to express context-sensitive summaries. */
export interface Placeholder {
  fnId: number;
  param: number;
  /**
   * A rest parameter (`...parts`) is a single formal that gathers every actual at
   * index >= `param`. Resolution (substitute in calls.ts, emitFacts in state.ts)
   * unions ALL those actuals into the formal rather than the single positional one.
   */
  rest?: boolean;
}

// 抽象值 = 三类正交事实 + 两个可选扩展。所有合并都是弱并（gen-only，只增不减），
// 这正是单调不动点能收敛的前提；任何"写"都不得删除已有 taint。
export interface AbstractValue {
  /** Keyed by `${site}|${port ?? ""}`. */
  // 站点标签集合；同站点不同端口可共存，但"无端口"项会吞并同站点的所有带端口项。
  occs: Map<string, TaintOcc>;
  /** Keyed by `${fnId}:${param}`. */
  // 函数参数的符号占位（key 为 `fnId:param`），用于按调用点替换成实参 taint；空 Map 即无。
  phs: Map<string, Placeholder>;
  // 静态已知成员：对象字面量属性、数组/元组下标（key 为字符串化下标）；不建模动态键。
  fields: Map<string, AbstractValue>;
  // 该值可能代表的脚本内函数节点（Set 去重），保证高阶代码下调用图仍全；与 taint 无关。
  fns: Set<ts.Node>;
  /**
   * A partial-application prefix from `Function.prototype.bind`: `f.bind(null, a)` yields
   * a value carrying f in `fns` plus `bound = [a]`. At the eventual call the prefix is
   * PREPENDED to the actuals (`applyToFns`), so `g()` reaches f's param 0 as `a`. Rebinding
   * composes (earlier bind's args first). Because `fns` is a set, a merged bound/plain
   * value (`flag ? f : f.bind(null, a)`) can't say which fn is bound, so application unions
   * BOTH alignments (with and without the prefix) — sound either way. Undefined for the
   * overwhelmingly common non-bound value (kept off the hot path).
   */
  bound?: AbstractValue[];
  // mayAlias 口径：本值在运行时"可能就是"的那些活 place；写入必须按不精确方式回放到这些
  // 目标。仅在条件绑定/Promise.all 元素等可能别名处出现，绝大多数值为 undefined；
  // 目标必须来自 pass 稳定的 canonical heap（否则每次遍历都新增成员，永不收敛）。
  /**
   * MAY-ALIAS back-references: live places a WRITE through this value must ALSO weakly
   * reach, because at runtime this value may BE one of them. Set for a conditional binding
   * (`const a = flag ? box1 : box2` → a's value may-aliases box1 AND box2) and for a
   * `Promise.all` result element that aliases its (place) input. Consulted ONLY at the
   * write primitives ({@link replayMayAliasWrite} in writeField / handleHeapMutator): the
   * write is replayed into each target INEXACTLY (it happens on one arm only — never a
   * strong update), recursing into each target's OWN mayAlias (chained aliases). A Set so
   * unions dedup by slot IDENTITY (loop-carried merges stay finite → the fixpoint
   * terminates). Undefined for the overwhelmingly common non-aliased value.
   *
   * That termination argument has a PREMISE — the **canonical-heap invariant**: every
   * target is drawn from the pass-stable heap, i.e. values keyed by a static program point
   * and created once for the whole fixpoint (env slots per symbol, class instances per
   * class, join results per join call, conditional places per ternary node, and the
   * persistent fields of any of those). A per-pass temporary must NEVER become a target:
   * identity dedup cannot recognize it, so each pass would add one more member, `changed`
   * would stay true forever, and the analysis would hit `ITERATION_CAP` instead of
   * converging (state.ts `joinResultOf` / `condPlaceOf` record the two repros that did).
   */
  mayAlias?: Set<AbstractValue>;
}

// 新建空值：四个容器都是新实例（不与任何已有值共享），因此可安全地作为落点被后续合并。
// 没有 bound/mayAlias 字段——它们按需创建，避免热路径上的无谓分配。
// 调用方获得所有权：返回对象可原地修改，不会牵连任何其他值。
export function emptyValue(): AbstractValue {
  return { fields: new Map(), fns: new Set(), occs: new Map(), phs: new Map() };
}

function occKey(site: string, port: number | undefined): string {
  return `${site}|${port ?? ""}`;
}

// 占位符的键：只按 (fnId,param) 去重，rest 位不是身份的一部分——同一形式参数可能以
// 普通/rest 两种见证到达，合并时只需把 rest 位置为 true（见 addPlaceholder）。
export function phKey(ph: Placeholder): string {
  return `${ph.fnId}:${ph.param}`;
}

/**
 * Add an occurrence, maintaining the port-subsumption invariant of every taint set:
 * occurrences are keyed by (site, port) and distinct ports of a site coexist, BUT a
 * portless occurrence of a site subsumes every ported occurrence of the same site
 * (merging their exactness). A whole-node read is portless, so it collapses element
 * precision; a selected element keeps its port until a whole-node read joins it.
 */
// 加入一条 occurrence，维护端口语义：无端口项吞并同站点的所有带端口项（精确位取或），
// 且无端口项一旦存在，带端口项只可能提升其 exact、不新增键。返回 true 表示值增长
// （供不动点 changed 信号）；重复加入同一键且 exact 不升时返回 false，纯幂等。
export function addOcc(target: AbstractValue, occ: TaintOcc): boolean {
  if (occ.port === undefined) return addPortless(target, occ);
  // Ported: if a portless occurrence of the site already exists, it subsumes this one.
  const portless = target.occs.get(occKey(occ.site, undefined));
  if (portless !== undefined) {
    if (occ.exact && !portless.exact) {
      portless.exact = true;
      return true;
    }
    return false;
  }
  return addExact(target, occ);
}

// 无端口加入：先删除同站点全部带端口键（把 exact 折叠进来），再以无端口键落位。
// 删除是唯一会缩小 occs 的操作，但它只是"用更粗的项替换更细的项"，taint 不丢。
function addPortless(target: AbstractValue, occ: TaintOcc): boolean {
  // Drop any ported occurrences of the same site, folding their exactness in.
  let exact = occ.exact;
  let changed = false;
  const drop: string[] = [];
  for (const [key, existing] of target.occs) {
    if (existing.site === occ.site && existing.port !== undefined) {
      exact = exact || existing.exact;
      drop.push(key);
    }
  }
  for (const key of drop) {
    target.occs.delete(key);
    changed = true;
  }
  return addExact(target, { exact, site: occ.site }) || changed;
}

// 按 (site,port) 落位；只在"新建键"或 exact 由 false 升 true 时报告增长，
// 因此重复合并同一 occurrence 不会让不动点多转一圈。
function addExact(target: AbstractValue, occ: TaintOcc): boolean {
  const key = occKey(occ.site, occ.port);
  const existing = target.occs.get(key);
  if (existing === undefined) {
    target.occs.set(key, { exact: occ.exact, port: occ.port, site: occ.site });
    return true;
  }
  if (occ.exact && !existing.exact) {
    existing.exact = true;
    return true;
  }
  return false;
}

// 加入参数占位：同 (fnId,param) 只保留一个对象，但 rest 标记只增不减（一旦为真即永真），
// 否则从非 rest 见证合并会丢掉"收集尾部实参"的语义。返回是否增长。
// 空 phs 的语义是"无参数依赖"，因此从不预置占位。
export function addPlaceholder(target: AbstractValue, ph: Placeholder): boolean {
  const key = phKey(ph);
  const existing = target.phs.get(key);
  if (existing !== undefined) {
    // A rest bit must not be lost when the same placeholder is merged from a
    // non-rest witness (e.g. the keystone rule) — otherwise resolution would
    // stop gathering the tail actuals.
    if (ph.rest === true && existing.rest !== true) {
      existing.rest = true;
      return true;
    }
    return false;
  }
  target.phs.set(key, { fnId: ph.fnId, param: ph.param, ...(ph.rest === true ? { rest: true } : {}) });
  return true;
}

/**
 * Fixed cap on field nesting. Beyond it, structure collapses into the occurrence set,
 * keeping the lattice finite in the presence of cyclic (`a.self = a`) and
 * recursively-grown heap — the premise the monotone fixpoint needs to converge. With
 * place-aliasing an abstract value can be genuinely cyclic (a field pointing back at
 * its container is a single shared node), so every recursive walk below is also
 * cycle-safe (identity guards / visited sets); the two together make divergence and
 * the `ITERATION_CAP` throw unreachable.
 */
// 深度上限（含根为 0）：到达此层不再向下合并，剩余结构折叠进 occs。这不是精度参数，
// 而是有限格的硬保证——循环自引用与递归增长都必须在有限步内收敛，否则会撞 ITERATION_CAP。
// 8 层覆盖真实脚本的嵌套；超过即按不精确涂抹处理，属精度换终止性的显式取舍。
export const VALUE_DEPTH_CAP = 8;

/** Deep weak-merge `source` into `target`; returns true iff `target` grew. */
// 唯一会原地修改 target 的合并入口：调用方必须保证 target 是"可增长落点"（持久 place
// 或新建值），不能是别处仍在使用的精确副本；返回 true 即告诉不动点"还需要再跑一遍"。
export function mergeInto(target: AbstractValue, source: AbstractValue, depth = 0): boolean {
  if (target === source) return false; // identity guard: mergeInto(x, x) is a no-op (cycle-safe)
  // 逐槽位弱并：occs/phs/fns/bound/mayAlias 先并入，字段在深度允许时按 key 递归向下合并。
  let changed = false;
  for (const occ of source.occs.values()) changed = addOcc(target, occ) || changed;
  for (const ph of source.phs.values()) changed = addPlaceholder(target, ph) || changed;
  for (const fn of source.fns) {
    if (!target.fns.has(fn)) {
      target.fns.add(fn);
      changed = true;
    }
  }
  if (source.bound !== undefined) changed = mergeBound(target, source.bound, depth) || changed;
  if (source.mayAlias !== undefined) {
    // Union may-alias back-references, deduped by slot IDENTITY (Set): a conditional
    // binding merged across fixpoint passes must reach a fixed point, not append duplicates.
    const targets = (target.mayAlias ??= new Set());
    for (const m of source.mayAlias) {
      if (!targets.has(m)) {
        targets.add(m);
        changed = true;
      }
    }
  }
  if (depth >= VALUE_DEPTH_CAP) {
    // Depth cap reached: do not descend (a cycle would recurse forever, and unbounded
    // nesting would break the finite-lattice premise). Fold the remaining structure
    // into this node's occurrence set instead. collapseInto is cycle-safe and reports
    // growth, so the fixpoint's `changed` signal stays sound.
    for (const field of source.fields.values()) changed = collapseInto(target, field) || changed;
    return changed;
  }
  for (const [key, field] of source.fields) {
    let slot = target.fields.get(key);
    if (slot === undefined) {
      slot = emptyValue();
      target.fields.set(key, slot);
    }
    changed = mergeInto(slot, field, depth + 1) || changed;
  }
  return changed;
}

/**
 * Union a bind prefix into `target` element-wise (position i of one bind maps to position
 * i of another). Beyond the depth cap the prefix folds into `target`'s occurrences (an
 * inexact smear that keeps every bound label alive — never a drop), keeping deeply-nested
 * bind-of-bind structure finite.
 *
 * The prefix's LENGTH is capped the same way, at {@link VALUE_DEPTH_CAP} positions — a
 * partial application longer than that is degenerate, and the cap is what keeps the lattice
 * finite along the OTHER axis. A self-rebind (`let h = f; h = h.bind(null, "x")`)
 * grows the prefix by one element per fixpoint pass — the value gets LONGER, never deeper,
 * so the depth cap never fires; without the length cap this loop would extend
 * `target.bound` by index and report `changed` forever, until the analysis hits
 * `ITERATION_CAP`. Over-cap elements collapse into
 * `target`'s occurrences, the identical degrade the depth cap uses. Honesty note: that keeps
 * every label alive ON THE VALUE, but a tracked dispatch does not fold callee-value
 * occurrences into parameters or results, so a prefix with more than CAP *distinct* bound
 * values loses routing for the tail — reachable only by a hand-written >8-argument partial
 * application (the loop-grown repro merely duplicates labels already present in-cap, so it
 * loses nothing). Accepted trade against the ITERATION_CAP crash. Prefixes are only ever
 * BUILT over-length by a per-pass temporary (calls.ts handleInvocationForwarding composes
 * `[...receiver.bound, ...prefixArgs]`); every path into persistent storage runs through
 * here, so persistent `bound` arrays never exceed the cap — which is also what bounds
 * `substitute`, whose output prefix is a 1:1 map of an already-capped summary prefix.
 */
// 按位置并 bind 前缀：短于 CAP 的部分逐槽递归弱并，超出部分折叠进 target 的 occs
// （只增不减）；深度或长度到顶后不再增长结构，避免自 rebind 每轮变长导致不收敛。
// 每轮至多新增 CAP 个槽位，且槽位只增不减，因此长度封顶后 bound 结构不再变化。
export function mergeBound(target: AbstractValue, sourceBound: AbstractValue[], depth: number): boolean {
  let changed = false;
  if (depth >= VALUE_DEPTH_CAP) {
    for (const el of sourceBound) changed = collapseInto(target, el) || changed;
    return changed;
  }
  if (target.bound === undefined) target.bound = [];
  const tb = target.bound;
  for (let i = 0; i < sourceBound.length; i += 1) {
    const el = sourceBound[i] as AbstractValue;
    if (i >= VALUE_DEPTH_CAP) {
      changed = collapseInto(target, el) || changed; // degrade: smear into occs (never drop)
      continue;
    }
    let slot = tb[i];
    if (slot === undefined) {
      slot = emptyValue();
      tb[i] = slot;
      changed = true;
    }
    changed = mergeInto(slot, el, depth + 1) || changed;
  }
  return changed;
}

// 复制值：新建空值后深弱并，返回与输入结构独立的副本（字段对象全部新建）。
// 供"写入前快照/条件分支合并"使用；深拷贝到新字段对象，但 fns 只复制节点身份，不复制 AST。
export function cloneValue(v: AbstractValue): AbstractValue {
  const out = emptyValue();
  mergeInto(out, v);
  return out;
}

/** Union of several values into a fresh owned value. */
// 新值 union：复制后逐字段弱并，返回全新独立对象（不与入参共享容器），供"多来源合并"用。
// 与 cloneValue 的区别：入参可有多个，且返回值的字段对象绝不与任何入参共享。
export function unionValues(...values: AbstractValue[]): AbstractValue {
  const out = emptyValue();
  for (const v of values) mergeInto(out, v);
  return out;
}

// 单 occurrence 值：新建空值并加一条标签；port 可选，exact 必须显式给出（调用点说清精度）。
// 用于"该值只可能来自这一处"的精确事实，如直接 world-read 结果、字面量构造的站点值。
export function singleOcc(site: string, exact: boolean, port?: number): AbstractValue {
  const out = emptyValue();
  addOcc(out, { exact, port, site });
  return out;
}

/**
 * Fold a value to its taint occurrences (occs + placeholders), dropping FIELD STRUCTURE
 * but keeping the tracked function values found anywhere in it. Ports are preserved per
 * occurrence; the port-subsumption invariant (a portless occurrence shadows ported ones
 * of the same site) is maintained by {@link addOcc}, so a whole-node read that mixes the
 * node's own portless label with per-element ported labels folds to the single portless
 * label.
 *
 * Widening folds LABELS, never the call graph: a collapsed /
 * computed-access read carries every function value nested in the
 * structure, so a callee selected by `fns[i]` or reached through an iterated element
 * still dispatches to its summary (widened, inexact) rather than becoming an unknown
 * call. Fns sets are finite (bounded by the script's function nodes), so carrying them
 * through collapse stays monotone and cannot diverge the fixpoint.
 */
// 折叠：丢弃字段结构，只保留 occs/phs 与任意深度的 fns（调用图不能因加宽而丢候选）。
// 端口保持逐 occurrence 的原样语义；无端口项会按 addOcc 规则吞并同站点端口项。
// 返回新的独立值；不修改输入。
export function collapse(v: AbstractValue): AbstractValue {
  const out = emptyValue();
  collapseInto(out, v);
  return out;
}

/**
 * Fold `v`'s taint (occs + placeholders + fns, recursively through fields) into `out`;
 * returns true iff `out` grew. Cycle-safe via `seen`: a shared/cyclic field object is
 * folded once (its occs already contributed on first visit), so `a.self = a` folds in
 * finite time. Returning growth keeps the depth-cap fold in {@link mergeInto} sound.
 */
// 把 v 的 taint（occs/phs/fns）递归折叠进 out；seen 按对象身份去重，保证 a.self=a 只走一遍，
// 返回值是 out 是否增长，调用方据此维持不动点信号。纯增长，不删除任何已有标签。
// 折叠不影响 fns：嵌套函数值继续参与分派，否则加宽会让高阶调用漏候选。
export function collapseInto(out: AbstractValue, v: AbstractValue, seen = new Set<AbstractValue>()): boolean {
  if (seen.has(v)) return false;
  seen.add(v);
  let changed = false;
  for (const occ of v.occs.values()) changed = addOcc(out, occ) || changed;
  for (const ph of v.phs.values()) changed = addPlaceholder(out, ph) || changed;
  // Carry nested function values so widening never drops a callee (see collapse's doc).
  for (const fn of v.fns) {
    if (!out.fns.has(fn)) {
      out.fns.add(fn);
      changed = true;
    }
  }
  for (const field of v.fields.values()) changed = collapseInto(out, field, seen) || changed;
  // Bound-prefix args carry taint (occs/placeholders/fns) that must survive folding —
  // otherwise a bound function collapsed at a summary/emission boundary silently drops its
  // captured labels.
  for (const el of v.bound ?? []) changed = collapseInto(out, el, seen) || changed;
  return changed;
}

/**
 * Read a statically-known field using smear-on-read: the field's own value
 * unioned with the CONTAINER's own container-level occurrences (occs + placeholders,
 * not its other fields). A write smeared into the container through an untracked path
 * (root-identifier fold, computed index, `push`) lands in the container's occs, and a
 * precise field read must never hide it. Absent field → whole-value read (collapse,
 * exactness preserved — not a widening).
 *
 * 读字段口径：存在字段 = 字段值 + 容器自身容器级 occs/phs（读时涂抹），字段不存在 = 整体
 * collapse（保留 exact，不是加宽）。涂抹只为兜住"经未追踪路径（根标识符折叠、计算下标、
 * push）写进容器级"的标签；同站点已带端口的字段不会被无端口容器项压掉端口，保住 join 端口精度。
 * The smear is strictly ADDITIVE: a portless container occurrence is NOT merged when the
 * field already carries a ported occurrence of that same site, because addOcc's
 * port-subsumption would otherwise collapse the port. That preserves join-port precision
 * — reading element `k` of a join result keeps `join#K|port=k` rather than folding it to
 * the join's whole-node portless label — while still surfacing genuine untracked writes
 * (which never have a matching ported field occ).
 */
export function readField(container: AbstractValue, key: string): AbstractValue {
  const field = container.fields.get(key);
  if (field === undefined) return collapse(container);
  const out = cloneValue(field);
  for (const occ of container.occs.values()) {
    if (occ.port === undefined && hasPortedOcc(out, occ.site)) continue;
    addOcc(out, occ);
  }
  for (const ph of container.phs.values()) addPlaceholder(out, ph);
  return out;
}

function hasPortedOcc(v: AbstractValue, site: string): boolean {
  for (const occ of v.occs.values()) {
    if (occ.site === site && occ.port !== undefined) return true;
  }
  return false;
}

/** Copy of `v` with every occurrence's exactness bit cleared (recursively). */
// 复制后把全部 exact 置 false（含字段与 bind 前缀，按对象身份防环）；用于可能别名写、
// 折叠式写等"只可能发生在其中一条路径"的场景，不做原地修改。
// 只清 occurrence 的 exact；port 保留，bound/mayAlias 不在此列（它们不是 occurrence）。
export function clearExact(v: AbstractValue): AbstractValue {
  const out = cloneValue(v);
  clearExactInPlace(out);
  return out;
}

function clearExactInPlace(v: AbstractValue, seen = new Set<AbstractValue>()): void {
  if (seen.has(v)) return; // cycle-safe: a shared/cyclic field is cleared once
  seen.add(v);
  for (const occ of v.occs.values()) occ.exact = false;
  for (const field of v.fields.values()) clearExactInPlace(field, seen);
  for (const el of v.bound ?? []) clearExactInPlace(el, seen);
}

/** True for actor labels; everything else (ask/world-read/join/fan-out) is an artifact. */
export { isActorSite } from "./core.js";

/** Provisional fan-out id used inside occurrences before ordinals are assigned. */
// 临时 fan-out id：分析期用它标记 occurrence，mintCore 时按源码顺序统一重命名为
// `fan-out#N`；`@` 前缀保证临时 id 不可能与用户站点 id 冲突。
// order 只用于生成分析期的临时唯一键；最终编号在 mintCore 里按源码顺序重排。
export function provisionalFanoutId(order: number): string {
  return `fan-out@${order}`;
}

// --- small AST helpers shared by the analysis ------------------------------

/**
 * Method names that mutate their receiver in place: array (`push`/`unshift`/`splice`)
 * and collection (`Map.set`, `Set.add`) writes. The transfer weak-merges each
 * argument's taint into the receiver's live value; an unresolvable receiver falls back
 * to the root-identifier smear (never a silent drop — see handleHeapMutator). `set`/`add`
 * are common names, but a false match cannot lose flow: mutator handling only ADDS taint
 * (a sound over-approximation, never a kill), and a member that actually HOLDS a tracked
 * script-local function dispatches as an ordinary call (see evalCall's mutator branch).
 */
// `send` 是 facade `Channel<T>` 的入队（docs/dynamic-workflow/authoring.md「Streams」）：一次向容器
// 写入，与 push / Map.set 同规——`ch.send(x)` 把 x 的 taint 并进 channel 的 place，`for await` 再从
// place 读出，于是每个生产者到每个消费者各画一条数据边。按名字匹配（与其余 mutator 一致），
// 脚本自己声明的 `send` 方法照旧走 calls.ts 里「成员持有脚本函数则按调用分派」的守卫。
export const HEAP_MUTATORS = new Set<string>(["push", "unshift", "splice", "set", "add", "send"]);

/**
 * Every compound-assignment token (`+=`, `-=`, … and the logical `||=`/`&&=`/`??=`).
 * These read-modify-write the target: gen-only has no kills, so the transfer just
 * weak-merges the RHS into the target (the old value stays) and yields their union.
 */
// 复合赋值运算符全集（含逻辑 ||= &&= ??=）：gen-only 无 kill，转移只把 RHS 弱并入目标
// 并返回并集（旧值保留）。Set 用于 O(1) 判定，不参与序列化。
// 15 个 token 覆盖全部复合赋值（含逻辑三种）；漏判只会让值更不精确，不会漏 taint。
export const COMPOUND_ASSIGNMENT_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

// 定位 workflow 包装函数的函数体；找不到即抛错（编译产物约定，不是用户输入可恢复错误）。
// 只取第一条同名函数声明；包装器保证唯一，因此不处理重复或嵌套声明。
export function findWorkflowBody(scriptFile: ts.SourceFile): ts.Block {
  for (const statement of scriptFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === WORKFLOW_FUNCTION_NAME &&
      statement.body !== undefined
    ) {
      return statement.body;
    }
  }
  throw new Error(`workflow wrapper function ${WORKFLOW_FUNCTION_NAME} not found`);
}

// 是否是"函数样"节点（声明/表达式/箭头/方法/getter/setter/构造器），用于确定 summary
// 边界与 arguments 归属；纯语法判定，不看类型。箭头函数另见 isNonArrowFunctionLike。
// 构造器也算函数样（有自己的 this/arguments），可承载 summary。
export function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * A function-like node that owns its own `arguments` object — every kind except an arrow
 * (arrows see the lexically-enclosing function's `arguments`). Used to resolve `arguments`
 * to the right function's actuals.
 */
// 用途：解析 `arguments` 时向上找第一个非箭头函数；箭头继续向外透传。
export function isNonArrowFunctionLike(node: ts.Node): boolean {
  return isFunctionLike(node) && !ts.isArrowFunction(node);
}

/** A directly-referenced callee (an identifier or a function literal) preserves exactness. */
// 直接引用的被调者（标识符/属性访问/函数字面量/箭头）保留 exact；其它表达式
// （调用结果、下标等）视为间接，调用点产生的东西要降级为不精确。
// 括号包装先剥掉再判定，因此 `(f)()` 仍算直接调用。
export function isDirectCallee(callee: ts.Expression): boolean {
  const expr = ts.isParenthesizedExpression(callee) ? callee.expression : callee;
  return (
    ts.isIdentifier(expr) ||
    ts.isPropertyAccessExpression(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isArrowFunction(expr)
  );
}

// 语法形状判定 `JSON.stringify`：接收者必须是全局名 JSON、成员名 stringify。与 isObjectAssign
// 同样不看作用域，误判只会多走保守路径，不会漏 taint。
// 误判后果仅是把它当内置处理（保守），不会凭空产生或丢失数据边。
export function isJsonStringify(access: ts.PropertyAccessExpression): boolean {
  return (
    ts.isIdentifier(access.expression) && access.expression.text === "JSON" && access.name.text === "stringify"
  );
}

/** The static field key for `x[k]` when `k` is a string/number literal, else undefined. */
// 静态下标口径：数字字面量保留原始文本（`0` 与 `"0"` 归一到同一 key），字符串字面量
// 取内容；模板串/变量返回 undefined，调用方据此走折叠（整值读取）分支。
// 计算键、模板、变量等无法静态命名的属性统一走 collapse，不建字段。
export function staticIndexKey(arg: ts.Expression): string | undefined {
  if (ts.isNumericLiteral(arg)) return arg.text;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  return undefined;
}

/**
 * Peel value-preserving wrappers that can sit on a place expression. Besides the pure
 * type-level / grouping wrappers (parens, `as`/`satisfies`, non-null, type assertion),
 * the comma operator `(a, box)` evaluates to its LAST operand, so it IS that place
 * (`control-flow-comma-alias-write`); the discarded operands carry no place and are
 * evaluated for effect separately by callers on the aliasing path. `await` is NOT peeled
 * here — it is a place only when the awaited value is a genuine promise (not a custom
 * thenable, whose `then` transforms the result), a distinction resolvePlace makes on the
 * evaluated value.
 */
// 剥离"值保持"包装：括号、non-null、as/satisfies、类型断言、逗号表达式（取右操作数）。
// 这些包装不改变运行时身份，因此剥掉后仍是同一 place；await 刻意不剥（自定义 thenable
// 可能改写结果，是否 place 由 resolvePlace 按求值后的值判定）。循环直到没有可剥包装。
export function peelPlace(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (true) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) cur = cur.right;
    else if (ts.isCommaListExpression(cur) && cur.elements.length > 0) {
      cur = cur.elements[cur.elements.length - 1] as ts.Expression;
    } else return cur;
  }
}

/** The live field object at `key`, created empty on demand (shared reference). */
// 取字段的"活对象"：缺失时新建并挂上（因此后续写入对所有别名路径可见）；
// 与 readField 不同，本函数不做读时涂抹，纯取引用。
// 返回的是共享的可变槽位：对它的写入会同时反映到容器上（别名语义），不要私自复制后改。
export function liveField(container: AbstractValue, key: string): AbstractValue {
  let field = container.fields.get(key);
  if (field === undefined) {
    field = emptyValue();
    container.fields.set(key, field);
  }
  return field;
}

/**
 * Replay a field write into `container`'s may-alias targets: `container.f = value` must
 * also reach `target.f` for every place `container` may-alias (a conditional binding's arms,
 * a join result element's input). INEXACT: a may-alias write happens on one arm only, so it
 * clears exactness and never strong-updates a target (the direct write into the container's
 * own slot stays exact — this only affects the replay). Recurses into each target's OWN
 * mayAlias (chained aliases: `d = f2 ? a : e` where `a = f ? b : c`), cycle-safe via an
 * identity seen-set and depth-capped (beyond the cap the collapsed write smears into the
 * target's occs — a widening, never a drop). Returns true iff any target grew.
 */
// 把 `container.f = value` 回放到 container 的 mayAlias 目标：写入先清 exact（只可能在
// 其中一条路径发生，绝不强更新），再逐目标写入并递归链式别名/深度上限，按身份防环。
// 无 mayAlias 时直接返回 false（绝大多数值走这条快路）。
export function replayMayAliasWrite(container: AbstractValue, key: string, value: AbstractValue): boolean {
  if (container.mayAlias === undefined) return false;
  return replayFieldInto(container.mayAlias, key, clearExact(value), new Set(), 0);
}

function replayFieldInto(
  targets: Set<AbstractValue>,
  key: string,
  write: AbstractValue,
  seen: Set<AbstractValue>,
  depth: number,
): boolean {
  let changed = false;
  for (const target of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    if (depth >= VALUE_DEPTH_CAP) {
      changed = collapseInto(target, write) || changed; // degrade: smear into occs (never drop)
      continue;
    }
    changed = mergeInto(liveField(target, key), write) || changed;
    if (target.mayAlias !== undefined) changed = replayFieldInto(target.mayAlias, key, write, seen, depth + 1) || changed;
  }
  return changed;
}

/**
 * Replay an in-place mutation (`push`/`Map.set`/…) into a container's may-alias targets:
 * the collapsed value smears (INEXACT) into each target's occs, recursing into chained
 * aliases. Same soundness contract as {@link replayMayAliasWrite}. Returns true iff any
 * target grew.
 */
// 把原地变更（push/Map.set 等）回放到 mayAlias 目标：折叠后的值以不精确方式并进每个
// 目标的容器级 occs（不建字段），并递归链式别名；用于"同一次写入可能落在任一别名上"。
// 返回 true 表示至少一个目标增长；不改动 container 自身，也不创建任何字段。
export function replayMayAliasMerge(container: AbstractValue, value: AbstractValue): boolean {
  if (container.mayAlias === undefined) return false;
  return replayMergeInto(container.mayAlias, clearExact(collapse(value)), new Set());
}

function replayMergeInto(targets: Set<AbstractValue>, write: AbstractValue, seen: Set<AbstractValue>): boolean {
  let changed = false;
  for (const target of targets) {
    if (seen.has(target)) continue;
    seen.add(target);
    changed = mergeInto(target, write) || changed;
    if (target.mayAlias !== undefined) changed = replayMergeInto(target.mayAlias, write, seen) || changed;
  }
  return changed;
}

/**
 * Shallow-copy field sharing: `target` adopts each of `source`'s statically-known field
 * value objects BY REFERENCE, so a later write through `target.f`'s sub-object stays
 * visible through `source.f` and vice versa. Models `Object.assign(target, source)` and
 * spread (`{ ...source }`, `[...source]`), which shallow-copy at runtime — an
 * object-valued property is copied as a shared reference. A colliding target field is weak-merged INTO the
 * source's field first (runtime overwrites; gen-only keeps the union) before both names
 * adopt that one shared object. Returns true iff `target` grew. Only top-level fields are
 * shared (a genuine shallow copy), so no recursion / cycle risk.
 */
// 浅拷贝共享：target 按引用收养 source 的顶层字段对象（不递归、不深拷贝），因此经副本
// 子对象的写入在源对象侧同样可见。字段键冲突时先把 target 的旧字段弱并进 source 字段
// （运行时是覆盖，gen-only 只能保留并集），再让两边都指向同一对象。返回是否增长。
export function adoptFields(target: AbstractValue, source: AbstractValue): boolean {
  let changed = false;
  for (const [key, srcField] of source.fields) {
    const existing = target.fields.get(key);
    if (existing === srcField) continue;
    if (existing !== undefined) mergeInto(srcField, existing);
    target.fields.set(key, srcField);
    changed = true;
  }
  return changed;
}

/** The statically-known member name a binding element reads, if any. */
// 解构元素读取的静态成员名：显式 propertyName 优先，否则用自身名；计算键返回 undefined。
// 非标识符/字符串/数字的属性名视为动态，返回 undefined 交由折叠处理。
// 结果只做字段 key 查表，不解析嵌套路径（嵌套由 bindPattern 逐层递归处理）。
export function bindingPropertyKey(element: ts.BindingElement): string | undefined {
  if (element.propertyName !== undefined) {
    if (
      ts.isIdentifier(element.propertyName) ||
      ts.isStringLiteralLike(element.propertyName) ||
      ts.isNumericLiteral(element.propertyName)
    ) {
      return element.propertyName.text;
    }
    return undefined;
  }
  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

// 边生成所需的事实集合：每个 Map 的 key 是 sink 站点 id，value 是到达该处的 occurrence
// 列表（保持发射顺序）；空集合表示"无数据流入"，但通常该类 key 不会出现。
// promoted 记录待提升的迭代候选（临时 id `fan-out@N`），mintCore 时才重命名为最终 id。
/** The edge-bearing facts consumed by graph assembly. Fan-out ids are provisional. */
export interface TaintFacts {
  /** Artifact occurrences reaching each ask instruction (data in-edges to the ask). */
  askData: Map<string, TaintOcc[]>;
  /** Actor occurrences of each ask receiver (drive the context relation). */
  askActor: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each world-read argument. */
  worldReadData: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each OPEN hole's prompt (a sink, like an ask's instructions). */
  holeData: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each join, carrying the join input port. */
  joinIn: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each promoted fan-out (provisional id). */
  fanoutIn: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching the script's return expression(s). */
  returnData: TaintOcc[];
  /** Promoted iteration candidates, in source order; `id` is provisional (`fan-out@N`). */
  promoted: PromotedFanout[];
}

// 已提升迭代候选：order 是源码顺序（决定最终编号），id 为临时 `fan-out@N`，
// loc 是源码位置（渲染/诊断用），label 恒为 "fan-out"。重命名发生在 mintCore。
// 该结构只在分析期存在：mintCore 之后不再出现在 AnalysisCore 中。
export interface PromotedFanout {
  order: number;
  id: string;
  loc: ScriptLoc;
  label: string;
}
