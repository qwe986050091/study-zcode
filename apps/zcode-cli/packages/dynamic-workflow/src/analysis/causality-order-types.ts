import type ts from "typescript";
import type { ScriptLoc } from "../compiler/compile.js";
import type { TaintOcc } from "./domain.js";
import type { ApplicationVia } from "./state.js";
import type { JumpKind, TraceRegionKind } from "./constants.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把追踪产物的类型
// （区域、事件、控制事实、OrderTrace）与走查读取的神谕接口拆到本文件；公开面仍从
// causality-order.ts 导出（那里原样再导出这些类型，既有的 `from "./causality-order.js"`
// 引用一个不改）。本文件只含类型，不 import `typescript` 的运行时值。

/**
 * The taint facts this walk reads, narrowed to the two members it actually uses so the
 * ordering pass does not depend on the whole emission surface. Produced by
 * `TaintState.emitOracle` off the CONVERGED interpreter state (interpret.ts).
 * Both maps are keyed by `node.getStart(scriptFile)`.
 */
export interface OrderOracle {
  /** Step occurrences the operand of each `await` carries. */
  // 键为 await 操作数的源码偏移；值为该操作数携带的 step occurrence 列表。
  // 缺失键表示「该位置没有神谕见证」，读取方按空集合处理（不能据此断言无 settle）。
  awaitSettles: Map<number, TaintOcc[]>;
  /** Step occurrences each guard expression reads. */
  // 键为 guard 表达式起始偏移；值为该 guard 读到的 step occurrence。
  // 与语法侧 stepsBySymbol 扫描合并使用，两者互补，任一侧不可单独省略。
  guardReads: Map<number, TaintOcc[]>;
  /**
   * The call oracle: per call / `new` / tagged-template node, the script functions the
   * interpreter applied there and how (`TaintState.applications`). The walk inlines exactly
   * these bodies at exactly these sites.
   */
  applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>;
}

export interface OrderRegion {
  // 区域唯一 id（如 loop#1 / choice#2 / call#3）；在 trace 内唯一，供事件与跳转引用。
  id: string;
  // 区域种类：seq/choice/loop/call/fanout/attempt/phase 等，决定投影如何渲染。
  kind: TraceRegionKind;
  // 父区域 id；缺失表示挂在根（root）之下。
  parent?: string;
  // 源码位置；由分析合成、不对应真实位置的区域（如 sweep 的 detached 体）可能缺省。
  loc?: ScriptLoc;
  /** Derivable literal round count of a `for` loop; model-only (never displayed). */
  bound?: number;
  /** fanout: the iterated expression; loop: the recursive helper's name; call: the helper's name. */
  label?: string;
  /**
   * True iff running the parent provably runs this region's body at least once: a
   * `do…while` body, a `for` whose literal bound is positive, or an inlined call.
   * Drives the certainty carve-out.
   */
  entered: boolean;
  /** choice: one arm MUST run (if/else, ternary, switch with default). Absent = skippable. */
  exhaustive?: boolean;
  /**
   * loop: a recursion SCC folded into a loop, not a loop statement. Only re-entrant calls
   * (`recur` jumps) close it; its body completing normally is the helper returning.
   */
  recursive?: boolean;
  /** choice: an arm completing normally continues into the next arm (switch). */
  fallthrough?: boolean;
  /**
   * branch: a never-called function body the end-of-walk sweep placed here. It runs at
   * an unknown point, if at all; its position in the stream is an artifact of the sweep.
   */
  detached?: boolean;
  /**
   * `call` / `fanout` only: this region is a STRAND — one asynchronous activation that
   * runs alongside the body that spawned it (an inlined `async` body, or a deferred
   * callback). Its `await`s suspend the strand, never the spawner, so the walk gives it a
   * settled set of its own and the spawner learns of its completion only by awaiting its
   * promise ({@link SettleEvent.joins}).
   */
  strand?: true;
}

/** A phase the walk reached: `phase#N` numbered by FIRST REACH of a new name. */
export interface PhaseInfo {
  // 阶段 id `phase#N`，按首次到达的新名字编号；同名 marker 不会新建阶段。
  id: string;
  /** The author's verbatim word. Always present — a nameless marker never mints a phase. */
  // 作者原样写下的阶段名（verbatim，不做 normalize）；恒存在，无名 marker 不会铸造阶段。
  name: string;
  /** The first marker that minted this phase; later same-name markers do not move it. */
  // 铸造该阶段的第一个 marker 位置，用于展示跳转来源；后续同名 marker 不覆盖。
  loc: ScriptLoc;
  /**
   * The filled hole whose body wrote this phase (docs/analysis.md「Sites」): a marker or a hole
   * (open or filled) inside a body carries the innermost enclosing filled hole's id. Absent
   * outside every fill — a top-level hole's own phase has none.
   */
  // 写下该阶段的最近外层「已补全留白」id；任何补全体外（含顶层洞自身）的阶段都没有该字段。
  fill?: string;
}

/** A step's request was sent (the facade call expression was evaluated). */
export interface IssueEvent {
  at: "issue";
  // 被签发（issue）的 step id；是步骤在时间线中的身份，后续 settle/join 都按它引用。
  step: string;
  // 事件发生时的区域栈（由外到内），用于把事件挂回结构位置。
  regions: readonly string[];
  /**
   * The phase current where the call was evaluated — {@link UNPHASED_ID} outside every
   * marker's extent. Issue is the step's identity moment, so this is the whole of phase
   * membership.
   */
  // 求值该调用时所在的阶段；不在任何 marker 范围内时为 UNPHASED_ID（合成值，不是真实阶段）。
  phase: string;
}

/** An `await` barrier: these steps' promises are known to have settled here. */
export interface SettleEvent {
  at: "settle";
  // 本屏障结算的 step 列表。join-only 事件里为空数组（表示只连接 strand、不新增 settle），
  // 因此读取方不能把空数组理解为「无事件」。
  /**
   * EMPTY when the barrier only joined strands: awaiting a strand whose summary is
   * already settled (or empty) settles nothing new, but the join itself is a control-flow
   * fact — it is where the strand's parked exits reconnect — so the event is still
   * recorded. Readers iterate `steps` and see nothing; readers of {@link joins} see the
   * join. `maybe` is meaningless on such an event and is written `false`.
   */
  steps: readonly string[];
  /**
   * True when this settle is a MAY-claim rather than a certainty. Two sources: the
   * barrier widened (nothing resolvable settled here, so everything in flight is assumed
   * to have), or the oracle's witness set was ambiguous — several witnesses, of which
   * exactly one settles at runtime, or a single inexact one smeared through a container.
   */
  maybe: boolean;
  /** Region chain the barrier sits in — a loop's carry edge needs to know. */
  regions: readonly string[];
  /**
   * The STRAND regions this barrier waits for, in join order: the strands whose promises
   * the awaited expression names (spawned while it was evaluated, or bound to an
   * identifier in an awaited position) plus the ones lifted because a settled step was
   * issued inside them. A strand joins once — a second await of the same promise lists
   * nothing. Absent when the barrier joins no strand.
   */
  joins?: string[];
}

/** An `agent()` call was evaluated — the lane's creation point, for family depth. */
// 角色创建事件：记录 agent() 调用的位置与所处阶段；只用于计算泳道族深度与站点阶段戳，
// 不进入核心文本渲染。
export interface ActorEvent {
  at: "actor";
  actor: string;
  regions: readonly string[];
  /**
   * The phase current where the call was evaluated, as on {@link IssueEvent}: a lane's birth
   * phase for the engine's lexical stamp (`collectSitePhases`). Not rendered in the core's
   * text form — the `spawn` line predates it and the site-phase table has its own tests.
   */
  phase: string;
}

/** A `phase("…")` marker statement was evaluated: the current phase switched to `phase`. */
export interface MarkEvent {
  at: "mark";
  /** The phase current from here to the end of the enclosing statement list. */
  // 从本语句起、到所在语句列表结束为止的当前阶段；后续语句在同一列表内沿用该阶段。
  phase: string;
  // 事件发生时的区域栈；用于把阶段切换挂到正确的结构位置（同一阶段可在多个区域出现）。
  regions: readonly string[];
}

/**
 * An unstructured transfer of control, with its target already resolved to a region id so
 * projections never touch the AST: `continue`/`break` name the `loop` (or, for a `break`
 * inside a switch, the `choice`); `return` names the enclosing `call` / `fanout` /
 * detached body, else the root; `throw` names the enclosing `attempt`, else the root
 * (uncaught); `recur` is a recursive call cut at re-entry, naming the SCC's `loop`.
 */
export interface JumpEvent {
  at: "jump";
  // 跳转种类：continue/break/return/throw/recur；决定目标区域如何解析与投影画法。
  kind: JumpKind;
  // 已解析的区域 id 目标（不再保留 AST），投影层直接按 id 连线，不触碰语法节点。
  target: string;
  // 事件发生时的区域栈；与 target 一起确定跳转的前后结构位置。
  regions: readonly string[];
  /** The phase current where the jump was evaluated (a phase CFG edge leaves from here). */
  // 求值跳转时所在阶段：阶段 CFG 的边从这里出发（触发跳转的那条语句所处阶段）。
  phase: string;
}

export type OrderEvent = IssueEvent | SettleEvent | ActorEvent | MarkEvent | JumpEvent;

// 走查事件的可辨识联合，按 at 字段区分五种：issue / settle / actor / mark / jump。
// 事件按发生顺序追加，投影层依赖顺序还原时间线，禁止重排。

/** `controllers`' answers decide whether the steps inside `region` are issued. */
// 控制事实：某区域内部 step 是否会被签发，取决于这些控制方的结果。
// controllers 与 maybeControllers 必须互斥（后者不含前者），渲染时分别按确定/可能处理。
export interface ControlFact {
  /** Controllers the analysis is sure of: a syntactic witness, or a singleton-exact one. */
  // 确定控制方：来自语法见证，或由神谕单例精确见证；空数组表示无确定来源。
  controllers: readonly string[];
  /** Controllers only the ambiguous half of the oracle claims; disjoint from the above. */
  // 仅神谕模糊侧声称的控制方；与 controllers 不相交，空数组表示无可能来源。
  maybeControllers: readonly string[];
  // 受控区域 id（choice/loop 等）；必存在于 trace.regions 中。
  region: string;
}

export interface OrderTrace {
  // 按发生顺序排列的事件流；投影与阶段 CFG 都以此顺序为准，调用方不得重排。
  events: OrderEvent[];
  // 所有区域（含根）；按创建顺序，id 在数组内唯一。
  regions: OrderRegion[];
  // 控制依赖事实；可为空数组（无控制依赖时）。
  controls: ControlFact[];
  /** The root `seq` region id; every other region descends from it. */
  // 根 seq 区域 id；其它区域的 parent 链最终都收敛到它，投影从该 id 起遍历。
  root: string;
  /**
   * Phases the walk reached, in first-reach order. Empty for a script with no markers,
   * which is what makes the whole phase vocabulary absent downstream. {@link UNPHASED_ID}
   * is NOT listed here — it is synthetic, and the projection adds it only if it has
   * members.
   */
  // 走查到达的阶段，按首次到达顺序；无 marker 的脚本为空数组，下游据此整体不启用阶段词汇。
  // UNPHASED_ID 不在此列表内（它是合成值，投影仅在有成员时补入）。
  phases: PhaseInfo[];
}
