import type { SiteGraph, SiteLoc, SiteNode } from "./types.js";

/**
 * The actor graph: a derived, presentation-level view of a {@link SiteGraph} with
 * **actors as nodes and messages as edges**. It is a PURE projection of an
 * already-built site graph (no program/table access); the site graph stays canonical
 * (journal, ordinals, and runtime marks all key off sites) and this view is recovered
 * on demand, the same category as SCC loop-box recovery. An agent-relevance filter
 * keeps the view about collaboration: an edge must touch at least one actor, so
 * endpoint-to-endpoint plumbing is dropped and endpoints left dangling are pruned.
 * Aggregated actor edges also carry the deduped producer artifact types of their
 * contributing site edges as `types` — the message types flowing between the lanes.
 */

/** A node: an actor lane, or one of the virtual endpoints `source` / `sink` / `workspace`. */
// 角色视图的节点定义。三种形态混在同一数组里，消费方一律先按 id 判定是否为虚拟端点，
// 不能假设所有节点都对应真实 ask 站点。该接口是纯投影结果，不持有任何运行时句柄。
export interface ActorNode {
  /**
   * An actor-site id (`actor#1`); `"source"` / `"sink"` — the orchestrator's enter
   * and exit roles, kept unmerged so the graph reads as a pipeline; or `"workspace"`.
   */
  id: string;
  // 展示名；来源是站点图中的 actor 名，未解析/未登记时为 undefined，渲染侧需自行兜底成 id。
  name?: string;
  // 源站位置（文件 + 行号区间）；虚拟端点无源位置，恒为 undefined。
  loc?: SiteLoc;
  /** Enclosing promoted fan-out id when the actor site is a lane family (×N). */
  // 提升后的 fan-out 家族 id（×N 泳道族）；仅当该 actor 站点由 fan-out 展开产生时存在，
  // 值为家族根站点 id，用于渲染时把同一族的泳道分组，普通单例 actor 为 undefined。
  family?: string;
}

/** A message edge: aggregated site data-flow between two actor lanes. */
// 聚合边：多条站点数据流边折叠成一条角色间消息边。from/to 均为节点 id（actor 站点 id
// 或虚拟端点），聚合键是 `from|to`，因此同一对泳道之间只会有一条边；自环（actor 到自己）
// 理论上可由同一 ask 的多个站点各自连出而出现，消费方需容忍。
export interface ActorEdge {
  // 消息方向的起点节点 id；聚合后仍保留站点图的 from->to 语义，不做双向归一化。
  from: string;
  // 消息方向的终点节点 id；与 from 构成聚合键，保证同一方向至多一条边。
  to: string;
  /** OR over the contributing site edges' exactness (a may-projection forces false). */
  // 精确度是所有贡献边的逻辑或：任一贡献边为 may（不确定落到哪个泳道）即整条边降级为 false。
  exact: boolean;
  // 折叠进本条边的站点数据边条数；用于渲染权重（粗细/标签）或调试溯源，恒 >= 1。
  /** How many site data-edges collapsed into this actor edge. */
  count: number;
  /**
   * The producer artifact types carried by the contributing site edges — the message
   * types on this actor edge (provenance: values of these types flow `from` -> `to`).
   * Deduped, in contribution order (site-edge iteration order). Present iff non-empty;
   * contributing edges with no type (e.g. `source` edges) add nothing.
   */
  // 消息类型集合：来自贡献边的 producer artifact type，按站点边遍历顺序去重；
  // 为空或全无类型时字段整体缺省（undefined），消费方需按「无类型信息」处理而非空数组。
  types?: string[];
}

// 角色图视图的顶层容器：nodes 与 edges 由 toActorGraph 一次性生成，彼此已保证引用一致
// （edges 端点必在 nodes 中）。节点顺序固定为 source、workspace、actors、sink，边按该顺序排序。
export interface ActorGraph {
  nodes: ActorNode[];
  // 已按 (from 序号, to 序号) 稳定排序的聚合边；空图时为 []，不会是 undefined。
  edges: ActorEdge[];
}

// 三个虚拟端点 id：source/sink 是编排器自身的进入与退出角色，刻意不合并（合并会把流水线
// 压成一个带自环的枢纽）；workspace 承载所有 world-read 来源，本身也是一个 origin。
// 这些 id 在渲染层作为保留字使用，不能与 actor 站点 id 冲突。
const SOURCE = "source";
const SINK = "sink";
const WORKSPACE = "workspace";

/** Project a site graph to its derived actor graph (pure). */
// 把站点图投影成角色图：无 IO、无副作用、不修改入参，可重复调用且结果仅依赖入参内容。
// 输入 graph 须已建好（nodes/edges/actors 一致）；输出是新建对象，与站点图不共享可变结构。
// 投影语义：world-read → workspace；ask → 其解析出的 actor 集合（未解析则为空集，该边被丢弃）；
// join/fan-out 等 relay → 空集（丢弃，因为其直连的 producer→consumer 边已存在，不丢传递信息）。
// 丢弃口径：端点两侧都是虚拟端点的边（如 workspace→sink）以及失去所有关联边的虚拟端点节点；
// actor 节点即使无边也保留，保证角色不被静默隐藏。失败路径只有空图，返回 { nodes: [], edges: [] }。
export function toActorGraph(graph: SiteGraph): ActorGraph {
  const kindOf = new Map<string, SiteNode["kind"]>(graph.nodes.map((node) => [node.id, node.kind]));
  const actorsOf = new Map<string, string[]>(
    graph.nodes.filter((node) => node.kind === "ask").map((node) => [node.id, node.actors ?? []]),
  );

  // The lane(s) a site projects onto. The virtual source/sink pass through UNMERGED
  // (two roles of the orchestrator, kept apart so the graph reads as a pipeline
  // rather than a hub with back-edges into its start); world-reads -> the single
  // workspace node; asks -> their actor set (empty when unresolved); join/fan-out
  // relays -> nothing (dropped: additive relay labels guarantee a direct
  // producer -> consumer edge already exists, so no transitive composition is lost).
  const project = (id: string): string[] => {
    if (id === SOURCE || id === SINK) return [id];
    const kind = kindOf.get(id);
    if (kind === "world-read") return [WORKSPACE];
    if (kind === "ask") return actorsOf.get(id) ?? [];
    return [];
  };

  // Aggregate contributed edges by (from, to): count them, OR their exactness, and
  // collect the deduped producer types in contribution order.
  const agg = new Map<string, ActorEdge>();
  const contribute = (from: string, to: string, exact: boolean, type: string | undefined): void => {
    const key = `${from}|${to}`;
    const existing = agg.get(key);
    if (existing === undefined) {
      // 首条边只建骨架：types 仅在确实带类型时创建，避免留下一个「有字段但空」的假类型信息。
      agg.set(key, { count: 1, exact, from, to, ...(type === undefined ? {} : { types: [type] }) });
      return;
    }
    existing.count += 1;
    existing.exact = existing.exact || exact;
    if (type !== undefined) {
      const types = (existing.types ??= []);
      // 线性去重（类型集合规模很小）：保持首次贡献顺序，渲染标签的顺序才稳定可复现。
      if (!types.includes(type)) types.push(type);
    }
  };

  for (const edge of graph.edges) {
    if (edge.kind !== "data") continue; // context edges dissolve (same actor = same node)
    // source -> world-read drops: the workspace is itself an origin, not fed by source.
    if (edge.from === SOURCE && kindOf.get(edge.to) === "world-read") continue;
    const fromNodes = project(edge.from);
    const toNodes = project(edge.to);
    if (fromNodes.length === 0 || toNodes.length === 0) continue; // a relay endpoint: drop
    // A non-singleton (may) projection on either side forces every contributed edge
    // inexact — the ask might run in any of its candidate lanes.
    const exact = edge.exact && fromNodes.length === 1 && toNodes.length === 1;
    // 多候选泳道（may 投影）需要笛卡尔展开成多条聚合边，每条都按上面降级后的 exactness 计入。
    for (const from of fromNodes) for (const to of toNodes) contribute(from, to, exact, edge.type);
  }

  // Agent-relevance filter: an actor edge must touch at least one actor, so
  // endpoint-to-endpoint plumbing (e.g. `workspace -> sink`, a world read flowing
  // untouched into the result) is dropped — honest in the site graph, noise in a
  // collaboration view. We filter the aggregated set (one pass) rather than skipping
  // at contribution, so the rule sits in one place next to the pruning it feeds.
  const isEndpoint = (id: string): boolean => id === SOURCE || id === SINK || id === WORKSPACE;
  const kept = [...agg.values()].filter((edge) => !(isEndpoint(edge.from) && isEndpoint(edge.to)));
  // 只有实际出现在 kept 边里的端点才会被收集；被过滤掉的端点若再无其它关联边即自然缺席。

  // Prune any endpoint node the filter (or the projection) leaves with no incident
  // edge — a dangling source/workspace/sink bubble is as noisy as the edge was. Actor
  // nodes always render, even edge-less.
  const incident = new Set<string>();
  for (const edge of kept) {
    incident.add(edge.from);
    incident.add(edge.to);
  }

  // Node order: source first, workspace second, actors in site order (graph.actors is
  // already source-ordered), sink LAST — so `flowchart LR` reads as a pipeline.
  const nodes: ActorNode[] = [];
  if (incident.has(SOURCE)) nodes.push({ id: SOURCE });
  if (incident.has(WORKSPACE)) nodes.push({ id: WORKSPACE });
  for (const actor of graph.actors) {
    nodes.push({
      id: actor.id,
      loc: actor.loc,
      ...(actor.name === undefined ? {} : { name: actor.name }),
      ...(actor.within === undefined ? {} : { family: actor.within }),
    });
  }
  if (incident.has(SINK)) nodes.push({ id: SINK });

  const position = new Map(nodes.map((node, index) => [node.id, index]));
  const rank = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  const edges = kept.sort((a, b) => rank(a.from) - rank(b.from) || rank(a.to) - rank(b.to));

  return { edges, nodes };
}
