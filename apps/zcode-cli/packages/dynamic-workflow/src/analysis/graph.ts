import type { AnalysisCore, CoreSimpleSite, CoreTypes } from "./core.js";
import { isActorSite } from "./core.js";
import type { TaintOcc } from "./domain.js";
import type { ActorSite, SiteEdge, SiteGraph, SiteNode } from "./types.js";

/**
 * The site-graph projection: graph assembly and edge emission over the
 * {@link AnalysisCore} —
 * data edges from each label's site to the sink reading it, the
 * pairwise context relation over asks sharing an actor, dedup, source completion,
 * and relay pruning.
 *
 * A PURE projection: everything
 * position- or checker-shaped — `within` containment, fan-out ordinal renames,
 * artifact types — was digested at core minting (interpret.ts), so this module
 * never imports `typescript` and never sees the AST. The core's ids are final
 * (`fan-out#N`), and its type keys match.
 */

const SOURCE_NODE: SiteNode = { id: "source", kind: "source", label: "source" };
const SINK_NODE: SiteNode = { id: "sink", kind: "sink", label: "sink" };

interface OrderedNode extends SiteNode {
  order: number;
}

/** Project the site graph off the core. */
// 站点图投影的唯一入口：从 core 的 sites/facts/types 组装节点与边，顺序固定为
// source → 按 order 的站点（fan-out 与 ask 混排）→ sink。所有 id 已是最终 `fan-out#N`
// 口径，本函数不再重命名、不读 AST、不产生 IO；输出纯字符串/数字结构，可直接序列化。
// 节点集合先补全（无入边者接 source）、再剪掉无关联的 relay（join/fan-out），
// 因此输出图的每条 relay 至少有一条边，且除 join 外每个节点都有数据入边。
export function projectSiteGraph(core: AnalysisCore): SiteGraph {
  const { facts, sites, types } = core;

  const fanoutNodes: OrderedNode[] = sites.fanouts.map((site) => {
    const artifactType = types.siteType.get(site.id);
    return {
      id: site.id,
      kind: "fan-out" as const,
      label: site.label,
      loc: site.loc,
      order: site.order,
      ...(site.within === undefined ? {} : { within: site.within }),
      ...(artifactType === undefined ? {} : { artifactType }),
    };
  });

  // Ask nodes carry their actor-lane membership: the deduped actor site ids their
  // receiver resolves to, ordered by actor source order.
  const actorOrder = new Map(sites.actors.map((actor) => [actor.id, actor.order]));
  // 同一 ask 的 receiver 可能解析到多个 actor：按站点 id 去重后按 actor 源码顺序稳定排序。
  const askActors = (id: string): string[] =>
    [...new Set((facts.askActor.get(id) ?? []).map((occ) => occ.site))].sort(
      (a, b) => (actorOrder.get(a) ?? 0) - (actorOrder.get(b) ?? 0),
    );

  const siteNodes: OrderedNode[] = [
    ...sites.asks.map((site) => {
      const actors = askActors(site.id);
      const artifactType = types.siteType.get(site.id);
      return {
        id: site.id,
        kind: "ask" as const,
        label: site.label,
        ...(site.labelPattern === undefined ? {} : { labelPattern: site.labelPattern }),
        loc: site.loc,
        order: site.order,
        ...(actors.length > 0 ? { actors } : {}),
        ...(site.within === undefined ? {} : { within: site.within }),
        ...(artifactType === undefined ? {} : { artifactType }),
      };
    }),
    ...sites.worldReads.map((site) => plainNode(site, "world-read", types)),
    ...sites.joins.map((site) => plainNode(site, "join", types)),
    ...fanoutNodes,
    // 开放的留白是一个节点：名字是标签，类型实参是它的产物类型（docs/analysis.md「Sites」）。
    // 留白节点 label 用留白名而非 id；artifactType 缺席时省略该字段。
    ...sites.holes.map((site) => plainNode({ ...site, label: site.name }, "hole", types)),
  ].sort((a, b) => a.order - b.order);

  const edges: SiteEdge[] = [];
  // Resolve the producer's artifact type for a data edge. Port refinement applies ONLY
  // to edges OUT OF a join (the from-side is a join and the occurrence selected an
  // element port): the join's per-element type, falling back to its whole tuple/array
  // type when that element's type is unknown. Edges INTO a join (`intoJoin`) also carry
  // a `port`, but there it is the join's INPUT position — the edge takes the producer's
  // (from-side) whole artifact type, never a port lookup.
  // 数据边的产物类型：只有"从 join 出发"且 occ 带端口时才查该端口的元素类型；
  // 查不到元素类型就退回整个值类型。指向 join 的边虽有 port，但那是输入位置，不做端口查表。
  const edgeType = (from: string, occ: TaintOcc, intoJoin: boolean): string | undefined => {
    const whole = types.siteType.get(from);
    if (!intoJoin && occ.port !== undefined) {
      const ports = types.joinPortTypes.get(from);
      if (ports !== undefined) return ports[occ.port] ?? whole;
    }
    return whole;
  };
  // 生成一条 data 边：exact 取自 occurrence（精确还是加宽），port/type 无值时省略字段。
  const dataEdge = (from: string, to: string, occ: TaintOcc, intoJoin = false): void => {
    const type = edgeType(from, occ, intoJoin);
    edges.push({
      exact: occ.exact,
      from,
      kind: "data",
      to,
      ...(occ.port === undefined ? {} : { port: occ.port }),
      ...(type === undefined ? {} : { type }),
    });
  };

  // 1. Data edges into every sink.
  for (const [askId, occs] of facts.askData) for (const occ of occs) dataEdge(occ.site, askId, occ);
  for (const [worldId, occs] of facts.worldReadData)
    for (const occ of occs) dataEdge(occ.site, worldId, occ);
  for (const [joinId, occs] of facts.joinIn)
    for (const occ of occs) dataEdge(occ.site, joinId, occ, true);
  for (const [fanoutId, occs] of facts.fanoutIn)
    for (const occ of occs) dataEdge(occ.site, fanoutId, occ);
  for (const [holeId, occs] of facts.holeData)
    for (const occ of occs) dataEdge(occ.site, holeId, occ);
  for (const occ of facts.returnData) dataEdge(occ.site, "sink", occ);

  // 上下文边解释：同一 actor 上的两次 ask 两两相连，方向按源码顺序（早 → 晚），
  // 只在两侧 actor 集合有交集时产生；exact 要求两侧都恰好一个同 actor 且都精确。
  // 2. Context edges: pairwise over asks whose actor sets intersect, earlier -> later.
  const askOrder = new Map(sites.asks.map((site) => [site.id, site.order]));
  const contextAsks = sites.asks
    .map((site) => ({ actors: facts.askActor.get(site.id) ?? [], id: site.id }))
    .filter((entry) => entry.actors.length > 0);
  for (let i = 0; i < contextAsks.length; i += 1) {
    for (let j = i + 1; j < contextAsks.length; j += 1) {
      const a = contextAsks[i];
      const b = contextAsks[j];
      if (a === undefined || b === undefined) continue;
      if (!actorsIntersect(a.actors, b.actors)) continue;
      const [from, to] = (askOrder.get(a.id) ?? 0) <= (askOrder.get(b.id) ?? 0) ? [a.id, b.id] : [b.id, a.id];
      edges.push({ exact: contextExact(a.actors, b.actors), from, kind: "context", to });
    }
  }

  // 3. 去重键 (from,to,kind,port)：多个见证合并为一条，exact 取见证的"或"。
  // 3. Deduplicate by (from, to, kind, port); exact is the OR over witnesses.
  const deduped = dedupeEdges(edges);

  // 4. Source completion: ask/world-read/fan-out nodes with no incoming data edge.
  const hasIncomingData = new Set<string>();
  for (const edge of deduped) if (edge.kind === "data") hasIncomingData.add(edge.to);
  for (const node of siteNodes) {
    // join 的输入语义由 joinIn 描述；缺失即真空而非"来自外部"，因此不补 source 边。
    if (node.kind === "join") continue;
    if (!hasIncomingData.has(node.id)) {
      deduped.push({ exact: true, from: "source", kind: "data", to: node.id });
    }
  }

  // 5. relay（join/fan-out）若无任何关联边就是纯中转噪音，整节点剪除；
  //    普通站点不剪（孤立站点仍需显示为"来自 source"）。
  // 5. Prune relay nodes (join / fan-out) that ended up with no incident edges.
  const incident = new Set<string>();
  for (const edge of deduped) {
    incident.add(edge.from);
    incident.add(edge.to);
  }
  const keptNodes = siteNodes.filter(
    (node) => (node.kind !== "join" && node.kind !== "fan-out") || incident.has(node.id),
  );

  // 6. Node order: source, sites in source order (fan-outs merged by order), sink.
  const nodes: SiteNode[] = [SOURCE_NODE, ...keptNodes.map(stripOrder), SINK_NODE];
  const actors: ActorSite[] = sites.actors.map((actor) => ({
    id: actor.id,
    loc: actor.loc,
    ...(actor.name === undefined ? {} : { name: actor.name }),
    ...(actor.namePattern === undefined ? {} : { namePattern: actor.namePattern }),
    ...(actor.within === undefined ? {} : { within: actor.within }),
  }));

  return { actors, edges: deduped, nodes };
}

// 简单站点（world-read / join / hole）转成节点：统一补 artifactType（无则省略）与 within。
function plainNode(
  site: CoreSimpleSite,
  kind: "world-read" | "join" | "hole",
  types: CoreTypes,
): OrderedNode {
  const artifactType = types.siteType.get(site.id);
  return {
    id: site.id,
    kind,
    label: site.label,
    loc: site.loc,
    order: site.order,
    ...(site.within === undefined ? {} : { within: site.within }),
    ...(artifactType === undefined ? {} : { artifactType }),
  };
}

// 去掉排序辅助字段 order：SiteGraph 的公开节点形状不暴露投影内部排序键。
function stripOrder({ order: _order, ...node }: OrderedNode): SiteNode {
  return node;
}

// 两个 actor 集是否共享至少一个站点（按 occ.site 比较，不看 exact/port）。
function actorsIntersect(a: TaintOcc[], b: TaintOcc[]): boolean {
  const sites = new Set(a.map((occ) => occ.site));
  return b.some((occ) => sites.has(occ.site));
}

/** Context exact iff both actor sets are the same singleton and both occs are exact. */
// 上下文边精确当且仅当两侧各只有一个 occurrence、指向同一 actor 且两者都 exact。
function contextExact(a: TaintOcc[], b: TaintOcc[]): boolean {
  if (a.length !== 1 || b.length !== 1) return false;
  const [oa] = a;
  const [ob] = b;
  return oa !== undefined && ob !== undefined && oa.site === ob.site && oa.exact && ob.exact;
}

// 按 (from,to,kind,port) 合并边：重复见证合并为一条，exact 取或，type 取首个非空值
// （同一 (from,port) 的类型是确定性的，见证间本应一致，空值只可能来自加宽路径）。
// actor 站点永远不会生成 data 边，这里直接丢弃（防御性，不依赖上游）。
function dedupeEdges(edges: SiteEdge[]): SiteEdge[] {
  const byKey = new Map<string, SiteEdge>();
  for (const edge of edges) {
    if (isActorSite(edge.from) && edge.kind === "data") continue; // actor labels never make data edges
    const key = `${edge.from}|${edge.to}|${edge.kind}|${edge.port ?? ""}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...edge });
    } else {
      if (edge.exact && !existing.exact) existing.exact = true;
      // Type is deterministic per (from, port), so witnesses agree; keep the first
      // non-undefined one (a widened witness path can lack the type another kept).
      if (existing.type === undefined && edge.type !== undefined) existing.type = edge.type;
    }
  }
  return [...byKey.values()];
}
