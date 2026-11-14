import {
  deriveWorkflowSchedulerState,
  deriveWorkflowSessionLinks,
  type WorkflowActivitySnapshot,
  type WorkflowArtifact,
  type WorkflowGraph,
  type WorkflowGraphCollection,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import type { SchedulerCollection, WorkflowGraphRecordEdge } from "./types.js";

/**
 * ============================================================================
 * workflow/scheduler/graph.ts —— 调度视图与快照的纯函数工具
 * ============================================================================
 *
 * 【定位】把图（节点/边/集合）推导成可派发视图，并按不可变方式更新快照。
 * 本文件不碰 I/O、不写事件；持久化由调用方（scheduler/node-runner）负责。
 *
 * 【ready 口径】直接复用 contracts 的 deriveWorkflowSchedulerState：
 *   入边 = dependsOn ∪ edges；依赖不存在或未终结 → blocked；只有 pending 且
 *   无阻塞才是 ready。调度器派发与死锁判定必须使用同一口径。
 *
 * 【完成口径】cancelled/completed/skipped 视为"已结束"，failed 不算结束；
 *   这里与依赖解锁的口径不同：failed 的依赖会解锁下游，但图不会算完成。
 * ============================================================================
 */

// 判定"节点已结束"的唯一集合：failed 故意不在此列，否则失败节点会让整图误判完成。
const COMPLETED_NODE_STATUSES = new Set<WorkflowNodeStatus>(["cancelled", "completed", "skipped"]);

/**
 * 取当前可派发节点：派生调度态中的 ready 节点 ∩ 可执行节点集合。
 * 输入是图与本次 run 的可执行范围（阶段裁剪可能只覆盖部分子图）。
 * 纯函数、无副作用；返回顺序沿用 graph.nodes 的原始顺序。
 * 不变量：不会返回状态非 pending、或有未终结依赖的节点。
 */
export function readyExecutableNodes(
  graph: WorkflowGraph,
  executableNodeIds: Set<string>,
): WorkflowGraphNode[] {
  const state = deriveWorkflowSchedulerState(graph);
  const readyNodeIds = new Set(state.readyNodeIds);
  return graph.nodes.filter((node) => executableNodeIds.has(node.id) && readyNodeIds.has(node.id));
}

/**
 * 对 ready 节点排序：工程节点优先，探索节点按集合轮转（round-robin）交错。
 * 目的：未归入可探索集合的节点先推进；属于多个集合的探索节点按集合公平分配，
 * 避免某个集合一次占满并发窗口。已 exhausted 的集合不参与轮转。
 * 纯函数；每个节点最多出现一次，顺序稳定（同集合内保持图原始顺序）。
 */
export function orderedReadyExecutableNodes(
  graph: WorkflowGraph,
  executableNodeIds: Set<string>,
): WorkflowGraphNode[] {
  const readyNodes = readyExecutableNodes(graph, executableNodeIds);
  const explorationNodeIds = new Set<string>();
  const explorationByCollection = new Map<string, WorkflowGraphNode[]>();
  for (const collection of graphCollections(graph)) {
    if (!collection.explorable || collection.exhausted) continue;
    const nodeIds = new Set(collectionNodeIdsForGraph(collection, graph));
    for (const node of readyNodes) {
      if (!nodeIds.has(node.id)) continue;
      explorationNodeIds.add(node.id);
      const list = explorationByCollection.get(collection.collectionId) ?? [];
      list.push(node);
      explorationByCollection.set(collection.collectionId, list);
    }
  }

  const engineeringNodes = readyNodes.filter((node) => !explorationNodeIds.has(node.id));
  const explorationNodes: WorkflowGraphNode[] = [];
  const collectionIds = [...explorationByCollection.keys()];
  let index = 0;
  while (collectionIds.length > 0) {
    const collectionIndex = index % collectionIds.length;
    const collectionId = collectionIds[collectionIndex]!;
    const nodes = explorationByCollection.get(collectionId) ?? [];
    const node = nodes.shift();
    if (node) explorationNodes.push(node);
    if (nodes.length === 0) {
      collectionIds.splice(collectionIndex, 1);
    } else {
      index++;
    }
  }

  return [...engineeringNodes, ...explorationNodes];
}

/**
 * 取当前被阻塞的可执行节点及其阻塞依赖列表。
 * 只返回状态为 pending 且 blockedBy 非空的节点（failed 的依赖不算阻塞）。
 * 用于 frontier_changed 载荷与死锁（deadlock）判定的诊断信息。
 */
export function blockedExecutableNodes(
  graph: WorkflowGraph,
  executableNodeIds: Set<string>,
): Array<{ blockedBy: string[]; nodeId: string }> {
  return deriveWorkflowSchedulerState(graph).blockedNodes.filter((entry) =>
    executableNodeIds.has(entry.nodeId),
  );
}

/**
 * 判断本轮调度是否可以以 completed 结束。
 * 条件一：所有可执行节点都处于 completed/cancelled/skipped（failed/pending/active 都不算）。
 * 条件二：若接入了 planner（waitsForCollections），所有"有成员且可探索"的集合
 *   必须 already exhausted；否则集合还能继续扩张，不能提前收尾。
 * 纯函数；调度器还要求 active 为空才真正返回 completed。
 */
export function areExecutableNodesComplete(
  graph: WorkflowGraph,
  executableNodeIds: Set<string>,
  waitsForCollections: boolean,
): boolean {
  const executableNodes = graph.nodes.filter((node) => executableNodeIds.has(node.id));
  if (!executableNodes.every((node) => COMPLETED_NODE_STATUSES.has(node.status))) {
    return false;
  }
  if (!waitsForCollections) return true;
  return graphCollections(graph)
    .filter((collection) => collection.explorable && isCollectionRelevant(collection, graph))
    .every((collection) => collection.exhausted || collection.status === "exhausted");
}

/**
 * 返回替换了单个节点字段的新快照（只允许 attempts/error/status）。
 * 不可变更新：其余节点、边、集合保持原引用；不写 updatedAt，由上层决定时间口径。
 * 找不到 nodeId 时原样返回新快照（不抛错），便于幂等写入。
 */
export function updateGraphNode(
  snapshot: WorkflowRunSnapshot,
  nodeId: string,
  patch: Partial<Pick<WorkflowGraphNode, "attempts" | "error" | "status">>,
): WorkflowRunSnapshot {
  return {
    ...snapshot,
    graph: {
      collections: snapshot.graph.collections,
      edges: snapshot.graph.edges,
      nodes: snapshot.graph.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              ...patch,
            }
          : node,
      ),
    },
  };
}

/**
 * 返回更新或插入单个集合后的新快照。
 * 已存在则覆盖并重算默认值；不存在则追加（以 collectionId 补齐）。
 * normalizeCollection 保证 analyzedNodeIds/errorCount/exhausted/status 等字段有口径，
 * 避免集合对象在不同路径上出现"有的有默认值、有的没有"。
 */
export function updateGraphCollection(
  snapshot: WorkflowRunSnapshot,
  collectionId: string,
  patch: Partial<WorkflowGraphCollection>,
  timestamp: string,
): WorkflowRunSnapshot {
  const collections = graphCollections(snapshot.graph);
  const existing = collections.find((collection) => collection.collectionId === collectionId);
  const nextCollection = normalizeCollection({
    ...(existing ?? { collectionId }),
    ...patch,
    collectionId,
  });
  const found = existing !== undefined;
  return {
    ...snapshot,
    graph: {
      collections: found
        ? collections.map((collection) =>
            collection.collectionId === collectionId ? nextCollection : collection,
          )
        : [...collections, nextCollection],
      edges: snapshot.graph.edges,
      nodes: snapshot.graph.nodes,
    },
    updatedAt: timestamp,
  };
}

/**
 * 按 activityId 替换或追加活动，并重建 sessionLinks 投影。
 * sessionLinks 不是独立事实源，永远从 activities 派生，防止两份链接数据漂移。
 * 纯函数；不校验 activity 是否属于该 run。
 */
export function upsertActivity(
  snapshot: WorkflowRunSnapshot,
  activity: WorkflowActivitySnapshot,
  timestamp: string,
): WorkflowRunSnapshot {
  const activities = [
    ...snapshot.activities.filter((item) => item.activityId !== activity.activityId),
    activity,
  ];
  return {
    ...snapshot,
    activities,
    sessionLinks: deriveWorkflowSessionLinks({ activities, runId: snapshot.runId }),
    updatedAt: timestamp,
  };
}

/**
 * 按 path 替换或追加产物引用。
 * 同一路径重复登记只保留最新一条，避免快照 artifacts 无限增长。
 */
export function addArtifact(
  snapshot: WorkflowRunSnapshot,
  artifact: WorkflowArtifact,
  timestamp: string,
): WorkflowRunSnapshot {
  return {
    ...snapshot,
    artifacts: [...snapshot.artifacts.filter((item) => item.path !== artifact.path), artifact],
    updatedAt: timestamp,
  };
}

/**
 * 取出图中全部集合并逐项补默认字段（collections 缺失时为空数组）。
 * 所有集合读取都应经过这里，保证后续读到的是同一套默认口径。
 */
export function graphCollections(graph: WorkflowGraph): SchedulerCollection[] {
  return (graph.collections ?? []).map(normalizeCollection);
}

/**
 * 为集合补齐调度器使用的默认值。
 * 口径：analyzedNodeIds/nodeIds 空数组、errorCount/plannerRuns 0、
 * exhausted/explorable false、status "active"；已有值一律保留。
 */
export function normalizeCollection(collection: WorkflowGraphCollection): SchedulerCollection {
  return {
    ...collection,
    analyzedNodeIds: collection.analyzedNodeIds ?? [],
    errorCount: collection.errorCount ?? 0,
    exhausted: collection.exhausted ?? false,
    explorable: collection.explorable ?? false,
    nodeIds: collection.nodeIds ?? [],
    plannerRuns: collection.plannerRuns ?? 0,
    status: collection.status ?? "active",
  };
}

/**
 * 计算集合成员：collection.nodeIds ∪ 节点侧 collectionId 匹配项，并去重。
 * 这是"集合成员"的唯一口径（frontier、完成判定、phase 判定都依赖它），
 * 不能只看单侧，否则种子播种与 planner 追加会出现成员遗漏。
 */
export function collectionNodeIdsForGraph(
  collection: WorkflowGraphCollection,
  graph: WorkflowGraph,
): string[] {
  return [
    ...new Set([
      ...(collection.nodeIds ?? []),
      ...graph.nodes
        .filter((node) => node.collectionId === collection.collectionId)
        .map((node) => node.id),
    ]),
  ];
}

/**
 * 构造事件 payload 前剔除 undefined 字段。
 * 目的：事件落库/传输时不出现 "key": undefined 这类无效项，字段缺失即不出现。
 */
export function compactWorkflowPayload(
  value: Record<string, unknown | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Record<string, unknown>;
}

/**
 * 集合 frontier：成员中状态为 pending 或 active 的节点数。
 * 口径是"仍在队列或在跑"的待办量，completed 不计；planner 据此判断是否还需扩张。
 */
export function collectionFrontier(
  graph: WorkflowGraph,
  collection: WorkflowGraphCollection,
): number {
  return collectionNodeIdsForGraph(collection, graph).filter((nodeId) => {
    const status = nodeById(graph, nodeId)?.status;
    return status === "pending" || status === "active";
  }).length;
}

/**
 * 按 id 查节点，找不到返回 undefined（不抛错）。
 * 只做线性扫描；调度循环内调用频繁，但图规模有限，暂不引入索引。
 */
export function nodeById(graph: WorkflowGraph, nodeId: string): WorkflowGraphNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

/**
 * 判断集合是否属于当前执行阶段。
 * 集合显式标了 phase 时必须完全相等；未标 phase 时退化为"成员中至少一个属于
 * 本阶段可执行集合"（成员为空则视为属于本阶段，避免空集合永远不被规划）。
 */
export function isCollectionInPhase(
  collection: WorkflowGraphCollection,
  graph: WorkflowGraph,
  executableNodeIds: Set<string>,
  phase: string,
): boolean {
  if (collection.phase) return collection.phase === phase;
  const nodeIds = collectionNodeIdsForGraph(collection, graph);
  return nodeIds.length === 0 || nodeIds.some((nodeId) => executableNodeIds.has(nodeId));
}

/**
 * 集合是否"有实际成员"；完成判定只要求 explorable 且有成员的集合都耗尽，
 * 空集合与非 explorable 集合都不阻止本轮收尾。
 */
function isCollectionRelevant(
  collection: WorkflowGraphCollection,
  graph: WorkflowGraph,
): boolean {
  return collectionNodeIdsForGraph(collection, graph).length > 0;
}

/**
 * 边的稳定标识：`from->to`。
 * 事件 payload、图记录去重与前端定位都用这一口径；节点 id 里若含 "->"
 * 会产生歧义，但当前 id 生成规则不允许该字符。
 */
export function edgeId(edge: WorkflowGraphRecordEdge): string {
  return `${edge.from}->${edge.to}`;
}
