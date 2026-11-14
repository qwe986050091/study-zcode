import {
  WorkflowGraphPlannerResultSchema,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowGraphPlannerNode,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import {
  collectionFrontier,
  collectionNodeIdsForGraph,
  edgeId,
  graphCollections,
  normalizeCollection,
} from "./graph.js";
import type {
  AppliedPlannerExpansion,
  SchedulerCollection,
  WorkflowGraphRecordEdge,
  WorkflowGraphSchedulerPlannerRunResult,
} from "./types.js";

/**
 * ============================================================================
 * workflow/scheduler/planner-expansion.ts —— 把 planner 结果合入图
 * ============================================================================
 *
 * 【定位】collection-planner 拿到一轮 planner 输出后调用：校验新增节点/边，
 * 计算集合新状态，并构造包含增量图的新快照。
 *
 * 【严格边界】与解析器的宽松相反，这里对图结构零容忍：重复节点、重复边、
 * 自环、未知端点、成环都会抛 Error。抛出后由 collection-planner 的 catch 记为
 * 一次 planner 失败，累加 errorCount，而不是把坏图写进快照。
 *
 * 【状态迁移】exhausted=true → exhausted；无增量且 frontier 归零且无未分析完成
 * 节点 → 先 draining、再下一轮 exhausted；其余 → active。
 * ============================================================================
 */

/**
 * 校验并应用一轮 planner 扩张。
 * 输入：当前快照、集合、planner 原始结果（含节点/边/collectionNodeIds/exhausted）、
 * 本轮新完成的节点 id、时间戳。
 * 输出：AppliedPlannerExpansion（新增边、新增节点、更新后的集合、新快照）。
 * 失败语义：schema 不合法或图结构非法时抛 Error，不修改任何入参。
 * 副作用：无（纯函数），持久化由调用方负责。
 * 不变量：新增边的两个端点必须存在于旧图或新增节点中；集合 nodeIds 取并集去重。
 */
export function applyPlannerExpansion(
  snapshot: WorkflowRunSnapshot,
  collection: SchedulerCollection,
  rawResult: WorkflowGraphSchedulerPlannerRunResult,
  unseenCompletions: readonly string[],
  timestamp: string,
): AppliedPlannerExpansion {
  const result = WorkflowGraphPlannerResultSchema.parse(rawResult);
  const existingNodeIds = new Set(snapshot.graph.nodes.map((node) => node.id));
  const addedNodes = (result.nodes ?? []).map((node) =>
    workflowNodeFromPlannerNode(node, collection.collectionId),
  );
  for (const node of addedNodes) {
    if (existingNodeIds.has(node.id)) {
      throw new Error(`Planner returned duplicate workflow node: ${node.id}`);
    }
    existingNodeIds.add(node.id);
  }

  const addedEdges = normalizePlannerEdges(snapshot.graph, addedNodes, result.edges ?? []);
  validateNewEdges(snapshot.graph, addedNodes, addedEdges);

  const existingCollectionNodeIds = collectionNodeIdsForGraph(collection, snapshot.graph);
  const collectionNodeIds = [
    ...new Set([
      ...existingCollectionNodeIds,
      ...(result.collectionNodeIds ?? addedNodes.map((node) => node.id)),
    ]),
  ];
  const graphChanged = addedNodes.length > 0 || addedEdges.length > 0;
  // 状态口径：planner 明确耗尽即关闭；否则若本轮零增量、frontier 已归零且没有
  // 未分析的完成节点，说明已无可扩张空间——首次进入 draining 让本轮再确认一次，
  // 下一轮仍如此才转 exhausted，避免把"暂时没新节点"误判为永久耗尽。
  const nextStatus =
    result.exhausted === true
      ? "exhausted"
      : !graphChanged &&
          collectionFrontier(snapshot.graph, collection) === 0 &&
          unseenCompletions.length === 0
        ? collection.status === "draining"
          ? "exhausted"
          : "draining"
        : "active";
  const nextCollection = normalizeCollection({
    ...collection,
    analyzedNodeIds: [...new Set([...collection.analyzedNodeIds, ...unseenCompletions])],
    exhausted: nextStatus === "exhausted",
    lastGraphChangeAt: graphChanged ? timestamp : collection.lastGraphChangeAt,
    nodeIds: collectionNodeIds,
    status: nextStatus,
  });

  return {
    addedEdges,
    addedNodes,
    collection: nextCollection,
    snapshot: {
      ...snapshot,
      graph: {
        collections: graphCollections(snapshot.graph).map((item) =>
          item.collectionId === collection.collectionId ? nextCollection : item,
        ),
        edges: [...snapshot.graph.edges, ...addedEdges],
        nodes: [...snapshot.graph.nodes, ...addedNodes],
      },
      updatedAt: timestamp,
    },
  };
}

/**
 * 把 planner 节点转为图节点：状态一律 pending，kind 缺省 task。
 * collectionId 缺失时回填当前集合，保证新节点一定归属到触发它的集合。
 */
function workflowNodeFromPlannerNode(
  node: WorkflowGraphPlannerNode,
  fallbackCollectionId: string,
): WorkflowGraphNode {
  return {
    collectionId: node.collectionId ?? fallbackCollectionId,
    dependsOn: node.dependsOn ?? [],
    description: node.description,
    id: node.id,
    kind: node.kind ?? "task",
    phase: node.phase,
    prompt: node.prompt,
    status: "pending",
    title: node.title,
  };
}

/**
 * 合并 planner 显式边与 dependsOn 隐含边，按 from->to 去重。
 * 目的：planner 常常只给 dependsOn 不给 edges；不补边会让依赖不生效。
 * 返回新数组，不修改入参；重复判断覆盖"旧图 + planner 边 + 本次补边"。
 */
function normalizePlannerEdges(
  graph: WorkflowGraph,
  addedNodes: readonly WorkflowGraphNode[],
  plannerEdges: readonly WorkflowGraphRecordEdge[],
): WorkflowGraphRecordEdge[] {
  const edges = [...plannerEdges];
  const existing = new Set([...graph.edges, ...edges].map(edgeId));
  for (const node of addedNodes) {
    for (const dependencyId of node.dependsOn) {
      const edge = { from: dependencyId, to: node.id };
      if (existing.has(edgeId(edge))) continue;
      edges.push(edge);
      existing.add(edgeId(edge));
    }
  }
  return edges;
}

/**
 * 严格校验新增边：自环、未知来源/目标、与旧图或本轮重复、成环，任一命中即抛错。
 * 逐条增量检查（pendingEdges 累积），因此第 N 条边的合法性包含前 N-1 条的影响。
 */
function validateNewEdges(
  graph: WorkflowGraph,
  addedNodes: readonly WorkflowGraphNode[],
  addedEdges: readonly WorkflowGraphRecordEdge[],
): void {
  const nodeIds = new Set([
    ...graph.nodes.map((node) => node.id),
    ...addedNodes.map((node) => node.id),
  ]);
  const existingEdgeIds = new Set(graph.edges.map(edgeId));
  const pendingEdges = [...graph.edges];
  for (const edge of addedEdges) {
    if (edge.from === edge.to) {
      throw new Error(`Planner returned a self-loop edge: ${edge.from} -> ${edge.to}`);
    }
    if (!nodeIds.has(edge.from)) {
      throw new Error(`Planner returned an edge with unknown source node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`Planner returned an edge with unknown target node: ${edge.to}`);
    }
    const id = edgeId(edge);
    if (existingEdgeIds.has(id)) {
      throw new Error(`Planner returned duplicate workflow edge: ${id}`);
    }
    if (wouldFormCycle(pendingEdges, edge)) {
      throw new Error(`Planner returned an edge that would create a cycle: ${id}`);
    }
    existingEdgeIds.add(id);
    pendingEdges.push(edge);
  }
}

/**
 * 判断加入 newEdge 后是否成环：从 newEdge.to 沿既有出边做 BFS，
 * 若能回到 newEdge.from 则形成环。只看可达性，不区分路径长度。
 */
function wouldFormCycle(
  edges: readonly WorkflowGraphRecordEdge[],
  newEdge: WorkflowGraphRecordEdge,
): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const visited = new Set<string>();
  const queue: string[] = [newEdge.to];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === newEdge.from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return false;
}
