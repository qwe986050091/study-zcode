import type { ScriptLoc } from "../compiler/compile.js";
import type { JumpKind, OrderRegion } from "./causality-order.js";
import type { AnalysisCore } from "./core.js";
import { collectFlowHoles, collectFlowPhases, quotientFlow } from "./flow-phase.js";
import { createStrandPark } from "./flow-strands.js";
import { buildTree, type LeafNode, type RegionNode, type TreeNode } from "./flow-tree.js";

/**
 * The control-flow projection: "where can
 * execution go next", as opposed to the causality graph's "what must precede what".
 *
 * Input is the core's trace read as a STRUCTURED CONTROL TREE (flow-tree.ts): regions are
 * the inner nodes, events the leaves in pre-order, and each leaf's `regions` chain names
 * its ancestors. The walk already resolved everything that needed the AST — arm grouping (`choice`), helper
 * boundaries (`call`), try parts, and every `jump`'s target region — so this module is a
 * pure function of the core and must not import `typescript`.
 *
 * Nodes are OCCURRENCES (each `issue` leaf, each `mark` leaf), not sites: a helper called
 * twice contributes two nodes for one step id. The phase quotient (`phaseEdges`) folds
 * them back by phase. Neither level is transitively reduced — a CFG never is.
 *
 * The graph is CONCURRENT: a `strand` region (an asynchronous activation the walk inlined)
 * is entered by a `fork` and left by a `join` at the barrier that awaits its promise, not
 * at its spawn point. Its exits wait in the strand park (flow-strands.ts) in between, and a
 * `mark` reached while strands are parked records their phases as `alongside` — a node
 * fact, because "an earlier phase is still running here" is not a transfer of control and
 * cannot be read off the edges once they fold.
 */

// 控制流节点：按"出现"计数而非站点，同一 step 被调用两次就产生两个节点。
// id 为 `${step}@k`（第 k 次 issue）或 `${phase}@k`（mark），在整张图内唯一；
// site 仅 issue 节点带（跳回站点的原 id）；phase 是该叶子所处的阶段（mark 是切到的阶段）；
// alongside 仅 mark 携带（进入时仍在并发运行的阶段，按 phase 表顺序，空则省略）；
// detached 标记从未被调用的函数体被扫描补出的节点（位置未知，连接不保证可达）。
export type FlowNodeKind = "issue" | "mark";

export interface FlowNode {
  /** `${step}@${k}` — the k-th issue of that step; `${phase}@${k}` for a mark. */
  id: string;
  kind: FlowNodeKind;
  /** issue: the step's site id. */
  site?: string;
  /** The phase current at this leaf (a mark's is the phase it switched TO). */
  phase: string;
  /**
   * mark only: the phases whose strands are still running when this marker is entered —
   * every strand parked here, minus this node's own phase and minus any strand the marker
   * sits inside. In the trace's phase-table order, absent when empty. Flow-insensitive
   * across choice arms, like the walk's `issued` set: over-claiming "may run alongside" is
   * the licensed direction.
   */
  alongside?: string[];
  /** Inside a never-called body the sweep placed: runs at an unknown point, if at all. */
  detached?: true;
}

// 边种类：next 顺序后继；branch 进分支/可跳过选择的后继；loop 回边；exit 退出循环；
// fork/join 并发进入与在屏障处收束；jump 跨调用返回；throw/may-throw 异常到 catch/abort。
// 一条边可能跨多个边界，只保留路径上"权重最高"的那一种（见 RANK），kind 决定含义而非路径细节。
export type FlowEdgeKind =
  | "next" // sequential successor
  | "branch" // choice head -> an arm; or, for a skippable choice, head -> what follows it
  | "loop" // loop back edge (body end, `continue`, `recur`)
  | "exit" // loop exit (normal, `break`, or a never-entered loop skipped)
  | "fork" // into a fan-out body or a strand
  | "join" // out of one, at the barrier that joins it, or at the sink when nothing does
  | "jump" // `return` out of a call, or to the sink
  | "throw" // explicit `throw` -> catch entries or abort
  | "may-throw"; // an issue inside a try body -> catch entries (or finally, or abort)

export type FlowVia = "continue" | "break" | "return" | "recur";

// 一条已发出的边：from/to 是节点 id 或终结符 id；kind 见 FlowEdgeKind；via 记录背后的
// 跳转语句（continue/break/return/recur），无跳转语句时省略。边集合已去重且规范排序。
export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  /** The jump statement kind behind a `loop` / `exit` / `jump` / `join` edge, when any. */
  via?: FlowVia;
}

// 阶段商图里的一个阶段：id 为阶段 id（UNPHASED_ID 也在其中，且 name/loc 缺席）；
// name 是作者给的名字，loc 是首个 mark 的位置（渲染用，不参与语义）；alongside 为进入
// 该阶段时仍在运行的阶段并集（空则省略）；fill 指写出该阶段的已补全留白。
export interface FlowPhase {
  id: string;
  /** Absent for {@link UNPHASED_ID}. */
  name?: string;
  /** The first marker that minted the phase; absent for {@link UNPHASED_ID}. */
  loc?: ScriptLoc;
  /**
   * Phases whose strands were still running when this one was entered: the union of
   * {@link FlowNode.alongside} over the phase's mark nodes, in phase-table order, absent
   * when empty. All-or-nothing with the rest of the phase vocabulary.
   */
  alongside?: string[];
  /** The filled hole whose body wrote this phase (a hole's own phase names the hole enclosing it). */
  fill?: string;
}

/**
 * An OPEN hole as the display lists it (docs/dynamic-workflow/presentation.md, `holes`): the
 * station the rail draws dashed ahead of the run. `phase` is where the hole STANDS — the
 * phase of its issue node, the hole's own memberless phase being `siteId` itself.
 */
// 显示层的一个开放留白：siteId 是留白站点 id；name 是作者写的留白名（阶段名）；
// type 是类型实参的原始拼写（契约文本，不是解析后的类型）；phase 是留白"站位"的阶段
// （其 issue 节点所在阶段，未知时省略）；tail 表示 `return await hole<T>(...)` 的尾部形式。
export interface FlowHole {
  siteId: string;
  name: string;
  /** The author's spelling of the type argument. */
  type: string;
  phase?: string;
  /** The tail form `return await hole<T>(...)`: the script's end is open. */
  tail?: true;
}

// 三个终结节点 id（不是真实节点）：entry 是唯一入口，sink 表示脚本正常结束（与因果图
// 同一语义），abort 表示异常逃逸到顶层。它们只出现在边的端点，排序时被固定到两端。
/** Terminal node ids. `sink` is the causality graph's sink: the script completed normally. */
export const FLOW_ENTRY = "entry";
export const FLOW_SINK = "sink";
export const FLOW_ABORT = "abort";

// 控制流图：nodes 按叶子流顺序（detached 的排最后），edges 已去重并按规范顺序排列。
// phaseEdges/phases 是"是否声明了 phase()"的全有全无语义：没有 phase 时两者都缺席；
// holes 仅在脚本含开放留白时出现（空集合时不发字段），序列化/快照必须逐字节稳定。
export interface ControlFlowGraph {
  /** Leaf-stream order; detached nodes last (the sweep runs after the main walk). */
  nodes: FlowNode[];
  /** Canonical order: by from-node, to-node, kind, via; `entry` first, terminals last. */
  edges: FlowEdge[];
  /**
   * The phase quotient, present iff the script declares a phase (all-or-nothing, exactly
   * like the causality graph's `phaseEdges`). Same-phase edges dissolve except `loop`
   * back edges, which stay as self-loops.
   */
  phaseEdges?: FlowEdge[];
  /** Phases that appear on some node, in first-reach order, {@link UNPHASED_ID} first. */
  phases?: FlowPhase[];
  /** The open holes in source order; present iff the script has one (see {@link FlowHole}). */
  holes?: FlowHole[];
}

// --- Flow ---------------------------------------------------------------------------------

/**
 * A dangling exit: the edge it will make once it learns where control goes next. Exported
 * for flow-strands.ts only — a strand's exits leave this module to wait for their join —
 * and deliberately not re-exported from the package barrels.
 */
// 悬空出口：已经知道"从谁出发、走哪种边"，但还不知道下一跳。只有这两个字段，
// 由外层构造在区域闭合/屏障到来时补上目标；flow-strands 用它把并发出口暂存起来。
// 本模块内部类型，仅导出给 flow-strands.ts，刻意不经包 barrel 再导出。
export interface Src {
  from: string;
  kind: FlowEdgeKind;
  via?: FlowVia;
}

/** A jump registered against its target region, resolved when that region completes. */
interface Pending {
  target: string;
  kind: JumpKind;
  srcs: Src[];
}

/**
 * One edge stands for the whole path from its source node to its target node, and that path
 * may cross several boundaries (leave a choice arm, exit an inner loop, close the outer
 * loop). The edge takes the MOST SIGNIFICANT transition on the path, by this rank: a plain
 * successor < entering a branch or fan-out < leaving a loop / fan-out / call < closing a
 * loop < an exception. `via` names the jump statement behind the kind and survives only
 * while the kind does.
 */
// 边类别权重：一条边代表源到目标之间的整段路径，多边界重叠时只保留最重要的那次转移。
// 数值越大越"显著"：next < branch/fork < exit/join/jump < loop < throw/may-throw。
const RANK: Readonly<Record<FlowEdgeKind, number>> = {
  next: 0,
  branch: 1,
  fork: 1,
  exit: 2,
  join: 2,
  jump: 2,
  loop: 3,
  throw: 4,
  "may-throw": 4,
};

// 按权重升级边种类：只在新区类比旧种类更显著时改写，否则保留原样（信息不会倒退）。
function retype(srcs: readonly Src[], kind: FlowEdgeKind, via?: FlowVia): Src[] {
  return srcs.map((src) =>
    RANK[kind] > RANK[src.kind] ? { from: src.from, kind, ...(via === undefined ? {} : { via }) } : src,
  );
}

/** Force a kind regardless of rank: where a construct RESOLVES a jump (a `return` reaching its call). */
// 无条件改写边种类：构造真正"消化"了这次跳转时（如 return 抵达调用点），语义由构造决定，
// 不再让权重比较压过它。via 跟着新的 kind 一起给出（未给则不写）。
function settle(srcs: readonly Src[], kind: FlowEdgeKind, via?: FlowVia): Src[] {
  return srcs.map((src) => ({ from: src.from, kind, ...(via === undefined ? {} : { via }) }));
}

// 出口列表按 (from, kind, via) 去重并保序：connect 本就按边键去重，重复项不携带信息，
// 却会在每个无节点区域上翻倍，最终可能撑爆调用栈；这里是所有构造的共同收口。
function dedupeSrcs(srcs: readonly Src[]): Src[] {
  const seen = new Set<string>();
  return srcs.filter((src) => {
    const key = `${src.from}|${src.kind}|${src.via ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The edge a jump of `kind` makes at its target. `return` into a fan-out is decided there. */
// 把 trace 的跳转类别映射成此处要画的边：continue/recur 是回边，break 是循环退出，
// return 是跨调用的 jump，throw 是异常边。fan-out 内的 return 由 fanout() 再改写为 join。
function jumpEdge(kind: JumpKind): { kind: FlowEdgeKind; via?: FlowVia } {
  switch (kind) {
    case "continue":
      return { kind: "loop", via: "continue" };
    case "recur":
      return { kind: "loop", via: "recur" };
    case "break":
      return { kind: "exit", via: "break" };
    case "return":
      return { kind: "jump", via: "return" };
    case "throw":
      return { kind: "throw" };
  }
}

// 控制流投影的主入口：把 core.trace 读成控制树后递归下降，产出节点、边、阶段商图与留白。
// 输入只有 core（本模块不碰 AST/checker）；输出是全有全无的图结构，空图由调用方决定怎么展示。
// 步骤：建树 → 递归 flow（每个构造返回其出口 Src 列表）→ 根序列接到 entry/sink/abort
// → 扫 detached 体 → 规范排序 → 阶段商图与留白。无 IO、无日志；失败只在输入违反
// trace 结构约定时以断言形式暴露（不做静默降级）。
export function projectControlFlow(core: AnalysisCore): ControlFlowGraph {
  const trace = core.trace;
  const { byId, root } = buildTree(trace);

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const edgeKeys = new Set<string>();
  const pending: Pending[] = [];
  const occurrences = new Map<string, number>();
  const park = createStrandPark(trace.phases);
  let placeholders = 0;

  const emit = (from: string, to: string, kind: FlowEdgeKind, via?: FlowVia): void => {
    // 同一 (from,to,kind,via) 只画一条：不同构造路径可能重复连接同一对节点，名字相同即语义相同。
    const key = `${from}|${to}|${kind}|${via ?? ""}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, kind, to, ...(via === undefined ? {} : { via }) });
  };
  const connect = (srcs: readonly Src[], to: string): void => {
    for (const src of srcs) emit(src.from, to, src.kind, src.via);
  };
  /** Remove and return the registered jumps of these kinds aimed at `target`. */
  const take = (target: string, kinds: readonly JumpKind[]): Src[] => {
    const out: Src[] = [];
    // 从尾部倒序遍历：splice 只影响已处理过的后半段，索引始终有效；unshift 维持原始注册顺序。
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i] as Pending;
      if (entry.target !== target || !kinds.includes(entry.kind)) continue;
      out.unshift(...entry.srcs);
      pending.splice(i, 1);
    }
    return out;
  };
  /** The nearest enclosing `attempt` of a region: where an exception escaping it lands. */
  const enclosingAttempt = (region: OrderRegion): string | undefined => {
    let parent = region.parent === undefined ? undefined : byId.get(region.parent)?.region;
    while (parent !== undefined) {
      if (parent.kind === "attempt") return parent.id;
      parent = parent.parent === undefined ? undefined : byId.get(parent.parent)?.region;
    }
    return undefined;
  };
  const raiseOutward = (from: OrderRegion, srcs: readonly Src[]): void => {
    if (srcs.length === 0) return;
    const attempt = enclosingAttempt(from);
    // 外侧没有 attempt 承接：异常真正逃出顶层，直接落到 abort，不凭空造路径。
    if (attempt === undefined) connect(srcs, FLOW_ABORT);
    else pending.push({ kind: "throw", srcs: [...srcs], target: attempt });
  };
  const subtreeIds = (node: RegionNode, into = new Set<string>()): Set<string> => {
    into.add(node.region.id);
    for (const child of node.children) if (child.type === "region") subtreeIds(child, into);
    return into;
  };

  const leaf = (node: LeafNode, incoming: readonly Src[]): Src[] => {
    const { event } = node;
    if (event.at === "actor") return [...incoming];
    // A barrier is transparent to the main line and is where the strands it awaits rejoin
    // it: their parked exits continue from here, beside the sources that arrived.
    // settle 屏障对主线透明，同时是它等待的 strand 出口回到主线的位置。
    if (event.at === "settle") return [...incoming, ...park.join(event.joins ?? [])];
    if (event.at === "jump") {
      const { kind, via } = jumpEdge(event.kind);
      pending.push({ kind: event.kind, srcs: retype(incoming, kind, via), target: event.target });
      return [];
    }
    const key = event.at === "issue" ? event.step : event.phase;
    const k = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, k);
    const id = `${key}@${k}`;
    const alongside = event.at === "mark" ? park.alongside(event.phase, event.regions) : [];
    nodes.push({
      id,
      kind: event.at,
      ...(event.at === "issue" ? { site: event.step } : {}),
      phase: event.phase,
      ...(alongside.length === 0 ? {} : { alongside }),
    });
    connect(incoming, id);
    return [{ from: id, kind: "next" }];
  };

  /** Flow children in order: a sequential container. */
  const sequence = (children: readonly TreeNode[], incoming: readonly Src[]): Src[] => {
    let cur = [...incoming];
    for (const child of children) cur = flow(child, cur);
    return cur;
  };

  /**
   * Flow a body while learning its ENTRY nodes: the body is fed a placeholder source, the
   * nodes the placeholder reached are the entries, and the real incoming sources are then
   * connected to them — each edge ranked between what the source already carried and what
   * the body's first construct assigned. Incoming sources that came out the other end
   * without meeting a node are returned separately as `passed`: a path through the body
   * that touched nothing is not an iteration anyone can see, so it must not close a loop.
   */
  // 先用占位源跑一遍体，再回填真实来源：占位源连到哪些节点，这些节点就是区域的入口。
  // entries 按首见顺序排列；passed 表示"穿过体但没碰到任何节点"的来源——那不是可观察的
  // 一次迭代，因此不能被当成循环体出口（否则会画出不存在的回边）。
  const withEntries = (
    children: readonly TreeNode[],
    incoming: readonly Src[],
  ): { entries: string[]; exits: Src[]; passed: Src[] } => {
    placeholders += 1;
    const ph = `$entry${placeholders}`;
    const pendingMark = pending.length;
    const exits = sequence(children, [{ from: ph, kind: "next" }]);
    // 占位源发出的边全部撤回：它们是探测用的，回填后由真实来源以同等 kind/via 重新连。
    const entries: string[] = [];
    for (let i = edges.length - 1; i >= 0; i -= 1) {
      const edge = edges[i] as FlowEdge;
      if (edge.from !== ph) continue;
      edges.splice(i, 1);
      edgeKeys.delete(`${edge.from}|${edge.to}|${edge.kind}|${edge.via ?? ""}`);
      if (!entries.includes(edge.to)) entries.unshift(edge.to);
      connect(retype(incoming, edge.kind, edge.via), edge.to);
    }
    // A jump as the body's first leaf registered the placeholder as its source.
    for (const entry of pending.slice(pendingMark)) {
      entry.srcs = entry.srcs.flatMap((src) =>
        src.from === ph ? incoming.map((real) => ({ ...src, from: real.from })) : [src],
      );
    }
    return {
      entries,
      exits: exits.filter((src) => src.from !== ph),
      passed: exits.some((src) => src.from === ph) ? [...incoming] : [],
    };
  };

  const choice = (node: RegionNode, incoming: readonly Src[]): Src[] => {
    const { region } = node;
    let cur = [...incoming]; // a case-clause expression that issues runs before the arms
    const exits: Src[] = [];
    let carried: Src[] = []; // switch fallthrough: the previous arm's normal completion
    let sawArm = false;
    // 非 branch 子的节点（case 表达式等）在分支之前执行，它们的出口继续传入第一个分支。
    for (const child of node.children) {
      if (child.type !== "region" || child.region.kind !== "branch") {
        cur = flow(child, cur);
        continue;
      }
      sawArm = true;
      const armExits = sequence(child.children, [...retype(cur, "branch"), ...carried]);
      if (region.fallthrough) carried = armExits;
      else exits.push(...armExits);
    }
    if (region.fallthrough) exits.push(...carried);
    // 非穷尽选择（或无分支）可能一个分支都不进，于是还保留"直接走到后继"的出口。
    if (!region.exhaustive || !sawArm) exits.push(...retype(cur, "branch"));
    // `break` out of a switch is just choosing the successor: a `branch`, not a loop exit.
    exits.push(...settle(take(region.id, ["break"]), "branch"));
    return exits;
  };

  const loop = (node: RegionNode, incoming: readonly Src[]): Src[] => {
    const { region } = node;
    const { entries, exits: bodyExits, passed } = withEntries(node.children, incoming);
    const breaks = take(region.id, ["break"]);
    const jumpsBack = take(region.id, ["continue", "recur"]);
    if (region.recursive) {
      // A recursion SCC: only the re-entrant calls close the loop. The body completing
      // normally is the helper RETURNING — that is the exit, and nothing is skipped.
      // 递归 SCC：只有重入调用构成回边；体正常走完是 helper 返回，属于出口而非迭代。
      for (const src of jumpsBack) for (const entry of entries) emit(src.from, entry, src.kind, src.via);
      return [...bodyExits, ...passed, ...breaks];
    }
    const back = [...retype(bodyExits, "loop"), ...jumpsBack];
    for (const src of back) for (const entry of entries) emit(src.from, entry, src.kind, src.via);
    if (entries.length === 0) {
      // No node inside: the loop is invisible, except that a `break` may have consumed the
      // incoming sources and a never-entered loop still lets them pass.
      return dedupeSrcs([...bodyExits, ...passed, ...breaks, ...(region.entered ? [] : incoming)]);
    }
    const exits = [...retype(bodyExits, "exit"), ...retype(passed, "exit"), ...breaks];
    if (!region.entered) exits.push(...retype(incoming, "exit"));
    return dedupeSrcs(exits);
  };

  const fanout = (node: RegionNode, incoming: readonly Src[]): Src[] => {
    const { entries, exits: bodyExits, passed } = withEntries(node.children, retype(incoming, "fork"));
    const returns = settle(take(node.region.id, ["return"]), "join", "return");
    // 体内无节点时没有 fork/join 的可见结构，只把"穿过去"和已完成的分支并入出口。
    if (entries.length === 0) return dedupeSrcs([...bodyExits, ...passed, ...returns]);
    return dedupeSrcs([...retype(bodyExits, "join"), ...retype(passed, "join"), ...returns]);
  };

  /**
   * A STRAND: one asynchronous activation that runs alongside the body that spawned it.
   * Control forks into it here, where the trace records it, but leaves it at the barrier
   * that awaits its promise — so its exits (the body's, and its `return`s, all `join`) are
   * parked under its region id for that barrier to collect, and the spawner carries on
   * with exactly the sources it arrived with.
   *
   * `passed` is dropped, and so is any exit still standing on one of the strand's own
   * incoming sources: both are the spawner's control, not the strand's, and they leave
   * with `incoming`. Parking one would draw a second, `join`-kinded copy of the
   * pass-through edge the spawner already makes. A strand left with nothing to park is
   * invisible and parks nothing.
   *
   * "Nothing" is judged on the EXITS, never on `entries`. Both corners that rule out the
   * tempting `entries.length === 0` test are in the corpus, and both were measured:
   *  - a body that meets no node of its own can still have real exits. The `.finally` of
   *    `async-promise-then-both-callbacks` holds no call, but its barrier joins the two
   *    `.then` strands and their exits surface in `bodyExits`. `entries` is built from
   *    the edges leaving the entry PLACEHOLDER, which never reached a node here, so the
   *    entries test drops them and leaves two ask nodes with no outgoing edge at all.
   *  - a body full of nodes can still carry an exit that met none. A `return` whose path
   *    touched nothing stands on whatever `withEntries` rewrote the placeholder to; on
   *    `functions-summaries-mutual-recursion` that is an enclosing body's placeholder,
   *    and parking it emitted `$entry1 -> sink`, an edge out of a node that never was.
   */
  const strandRegion = (node: RegionNode, incoming: readonly Src[]): Src[] => {
    const nodeMark = nodes.length;
    const spawner = new Set(incoming.map((src) => src.from));
    const { exits: bodyExits } = withEntries(node.children, retype(incoming, "fork"));
    const returns = settle(take(node.region.id, ["return"]), "join", "return");
    const all = dedupeSrcs([...retype(bodyExits, "join"), ...returns]);
    // 仍站在 spawner 自己的入边上的出口是 spawner 的控制流，不是 strand 的；留给 incoming。
    const exits = all.filter((src) => !spawner.has(src.from));
    const phases = new Set(nodes.slice(nodeMark).map((inner) => inner.phase));
    // 判定"有内容"看 exits 与阶段，而不是 entries（见上方注释：两种语料反例都证明那会漏出口）。
    if (exits.length > 0 || phases.size > 0) park.park(node.region.id, exits, [...phases]);
    return [...incoming];
  };

  // A `return` reaching its call resumes at the call site: from the caller's point of view a
  // plain successor. (`return` to the root is a `jump` to the sink; see the root below.)
  const call = (node: RegionNode, incoming: readonly Src[]): Src[] => [
    ...sequence(node.children, incoming),
    // 有 return 时它已消化"离开调用"的语义，边种类强制为 next（调用点继续执行）。
    ...settle(take(node.region.id, ["return"]), "next"),
  ];

  const tryGroup = (node: RegionNode, incoming: readonly Src[]): Src[] => {
    const part = (kind: OrderRegion["kind"]): RegionNode | undefined =>
      node.children.find((child): child is RegionNode => child.type === "region" && child.region.kind === kind);
    const attempt = part("attempt");
    const handler = part("catch");
    const finalizer = part("finally");
    if (attempt === undefined) return sequence(node.children, incoming);
    const inside = subtreeIds(node);
    // 记下进入 try 前的两个水位：只把本 try 内新产生的 issue/挂起跳转当作异常源。
    const pendingMark = pending.length;
    const nodeMark = nodes.length;

    let normal = sequence(attempt.children, incoming);
    // Every issue lexically inside the try body may reject there; explicit throws targeting
    // this attempt join them. Nothing outside a try body gets an implicit exception edge.
    // (An issue inside a NESTED try also lands here — its own catch may rethrow, so the
    // outer handler stays reachable; over-approximating is the licensed direction.)
    let raised: Src[] = [
      ...nodes.slice(nodeMark).filter((n) => n.kind === "issue").map((n): Src => ({ from: n.id, kind: "may-throw" })),
      ...take(attempt.region.id, ["throw"]),
    ];
    if (handler !== undefined) {
      normal = [...normal, ...sequence(handler.children, raised)];
      raised = [];
    }
    if (finalizer === undefined) {
      // 没有 finally：正常路径直接成为出口，异常继续向外层 attempt 冒泡（最外层落 abort）。
      raiseOutward(node.region, raised);
      return normal;
    }
    // Jumps out of the try body / catch block pass through finally first: they are pulled
    // off the pending list, fed into finally, and re-registered from finally's exits.
    const escaping: Pending[] = [];
    for (let i = pending.length - 1; i >= pendingMark; i -= 1) {
      const entry = pending[i] as Pending;
      if (inside.has(entry.target)) continue;
      escaping.unshift(entry);
      pending.splice(i, 1);
    }
    const finallyExits = sequence(finalizer.children, [
      ...normal,
      ...raised,
      ...escaping.flatMap((entry) => entry.srcs),
    ]);
    for (const entry of escaping) {
      const { kind, via } = jumpEdge(entry.kind);
      pending.push({ kind: entry.kind, srcs: retype(finallyExits, kind, via), target: entry.target });
    }
    if (raised.length > 0) raiseOutward(node.region, retype(finallyExits, "throw"));
    return normal.length > 0 ? finallyExits : [];
  };

  // A source list is a SET: `connect` dedups the edges it makes, so duplicates carry no
  // information — but they multiply. A skippable choice with nothing inside returns its
  // incoming sources twice (once through the arm, once past it), and a helper inlined a
  // hundred times contributes thousands of such leafless regions in sequence: the multiset
  // doubled at each one until `push(...exits)` overflowed the call stack with 135,200 copies
  // of ONE source. Dedup at the one seam every construct flows through, so no list ever
  // exceeds |nodes| × |kinds| entries whatever the shape.
  const flow = (node: TreeNode, incoming: readonly Src[]): Src[] => dedupeSrcs(flowRaw(node, incoming));
  // 构造分派：strand 覆盖 call/fanout 的写法差异——关键是"并发"，不是它长什么样。
  const flowRaw = (node: TreeNode, incoming: readonly Src[]): Src[] => {
    if (node.type === "leaf") return leaf(node, incoming);
    // `strand` rides on a `call` or a `fanout` and overrides both: what matters is that
    // the body runs concurrently with its spawner, not how it was written.
    if (node.region.strand === true) return strandRegion(node, incoming);
    switch (node.region.kind) {
      case "choice":
        return choice(node, incoming);
      case "loop":
        return loop(node, incoming);
      case "fanout":
        return fanout(node, incoming);
      case "call":
        return call(node, incoming);
      case "try":
        return tryGroup(node, incoming);
      default:
        return sequence(node.children, incoming);
    }
  };

  // --- Root: entry, the main sequence, the terminals, then the detached bodies ------------
  const detached = root.children.filter(
    (child): child is RegionNode => child.type === "region" && child.region.detached === true,
  );
  const main = root.children.filter((child) => !detached.includes(child as RegionNode));
  const exits = sequence(main, [{ from: FLOW_ENTRY, kind: "next" }]);
  // 主线走完就是正常结束；顶层 return 直达 sink，顶层 throw 直达 abort。
  connect(exits, FLOW_SINK);
  connect(take(trace.root, ["return"]), FLOW_SINK);
  connect(take(trace.root, ["throw"]), FLOW_ABORT);
  // No barrier ever awaited these strands. All that is known is that the script did not
  // outlive them, so they join the sink — the same terminal the main line reaches.
  connect(park.drain(), FLOW_SINK);
  for (const body of detached) {
    const pendingMark = pending.length;
    const nodeMark = nodes.length;
    sequence(body.children, []);
    for (const node of nodes.slice(nodeMark)) node.detached = true;
    // 无位置就没有可画的目标：本体内挂起的跳转与并发的 strand 一并丢弃，避免悬空边。
    // A detached body has no position, so nothing it jumps to can be drawn — and neither
    // can the strands it spawns, which go the same way as its pending jumps.
    pending.splice(pendingMark);
    park.discard();
  }

  sortEdges(nodes, edges);
  const phases = collectFlowPhases(trace, nodes);
  const holes = collectFlowHoles(core, nodes);
  return {
    edges,
    nodes,
    ...(trace.phases.length === 0 ? {} : { phaseEdges: quotientFlow(nodes, edges, phases), phases }),
    ...(holes.length === 0 ? {} : { holes }),
  };
}

// 规范排序：先 from 再 to 再 kind 再 via；entry 固定最前、sink/abort 固定最后，
// 未知 id 取兜底值排末尾。排序只影响输出文本/快照，不改变图语义。
function sortEdges(nodes: readonly FlowNode[], edges: FlowEdge[]): void {
  const rank = new Map<string, number>(nodes.map((node, index) => [node.id, index]));
  rank.set(FLOW_ENTRY, -1);
  rank.set(FLOW_SINK, nodes.length);
  rank.set(FLOW_ABORT, nodes.length + 1);
  const at = (id: string): number => rank.get(id) ?? nodes.length + 2;
  edges.sort(
    (a, b) =>
      at(a.from) - at(b.from) ||
      at(a.to) - at(b.to) ||
      a.kind.localeCompare(b.kind) ||
      (a.via ?? "").localeCompare(b.via ?? ""),
  );
}

