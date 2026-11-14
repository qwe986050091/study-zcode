import {
  WorkflowGraphSeedSchema,
  type WorkflowGraphEdge,
  type WorkflowGraphSeed,
} from "@zcode/contracts";
import { edgeId } from "../ids.js";
import {
  isRecord,
  parsePlannerJson,
  readLooseArray,
  readLooseBoolean,
  readLoosePositiveInteger,
  readLooseString,
  readLooseStringArray,
  readLooseValue,
  stringValue,
} from "./json.js";

/**
 * ============================================================================
 * workflow/expert/parsers/graph-seed.ts —— 阶段产物到工作流图的播种解析
 * ============================================================================
 *
 * 【定位】把某阶段（如计划/细化）模型产出的图草案解析为 WorkflowGraphSeed，
 * 供 graph-artifacts.seedGraphFromPhaseArtifact 增量合入快照。
 *
 * 【宽松/严格边界】字段名、数组/对象包裹形态都尽量宽松；但节点 id、边端点、
 * 集合 id 这类图结构必需字段缺失时丢弃该条目。整体解析失败返回 null 而不是
 * 抛错——播种只是增强，失败时阶段仍可继续，快照保持原样。
 *
 * 【下游影响】返回的节点一律不带 status（由 applyWorkflowGraphSeed 补 pending）；
 * 此处的重复节点/边与环不会被静默修正，交给 lifecycle 的严格校验拒绝。
 * ============================================================================
 */

/**
 * 解析阶段回复并归一化为图草案。
 * 输入：模型原始文本 + 缺省阶段名（用于未标 phase 的节点/集合）。
 * 输出：WorkflowGraphSeed，或 null（JSON 不可解析 / 结构不合法）。
 * 失败语义：这里主动吞掉 parsePlannerJson 的抛错并返回 null；调用方看到
 * null 或 nodes+collections 皆空时直接跳过写快照与事件。
 */
export function parseWorkflowGraphSeed(
  response: string,
  defaultPhase: string,
): WorkflowGraphSeed | null {
  let raw: unknown;
  try {
    raw = parsePlannerJson(response);
  } catch {
    return null;
  }
  return normalizeWorkflowGraphSeedCandidate(raw, defaultPhase);
}

/**
 * 给"根节点"补一条来自闸门节点的入边，使新播种的子图必须等闸门阶段结束后才可执行。
 * 判定根节点 = 无 dependsOn 且不是任何既有边的终点；一个根都没有时原样返回。
 * 副作用：无，返回新对象；边按 from->to 去重，dependsOn 同步补齐但仍去重。
 * 不变量：补边与补 dependsOn 必须成对，否则 deriveWorkflowSchedulerState 的
 * 两种入边口径会不一致。
 */
export function gateRootSeedNodes(seed: WorkflowGraphSeed, gateNodeId: string): WorkflowGraphSeed {
  const incomingNodeIds = new Set(seed.edges.map((edge) => edge.to));
  const rootNodeIds = new Set(
    seed.nodes
      .filter((node) => (node.dependsOn ?? []).length === 0 && !incomingNodeIds.has(node.id))
      .map((node) => node.id),
  );
  if (rootNodeIds.size === 0) return seed;

  const edgeIds = new Set(seed.edges.map(edgeId));
  const edges = [...seed.edges];
  for (const nodeId of rootNodeIds) {
    const edge = { from: gateNodeId, to: nodeId };
    if (edgeIds.has(edgeId(edge))) continue;
    edgeIds.add(edgeId(edge));
    edges.push(edge);
  }

  return {
    ...seed,
    edges,
    nodes: seed.nodes.map((node) =>
      rootNodeIds.has(node.id)
        ? {
            ...node,
            dependsOn: [...new Set([...(node.dependsOn ?? []), gateNodeId])],
          }
        : node,
    ),
  };
}

/**
 * 把任意候选值归一化为图草案；无法形成合法结构时返回 null。
 * 支持三种整体数组形态（纯集合列表 / 纯节点列表 / 纯边列表）和常规对象形态。
 * 字段读取走 readLoose*，因此 camelCase、snake_case 与近义键都能命中。
 * 最后统一 safeParse；缺省 phase 用 defaultPhase 填充，kind 非 phase 一律 task。
 */
export function normalizeWorkflowGraphSeedCandidate(
  value: unknown,
  defaultPhase: string,
): WorkflowGraphSeed | null {
  // 整体是数组时按元素特征猜它代表哪一类实体；三者都不满足则继续走对象分支。
  if (Array.isArray(value)) {
    if (value.every(isCollectionLikeSeedRecord)) {
      return normalizeWorkflowGraphSeedCandidate({ collections: value }, defaultPhase);
    }
    if (value.every(isNodeLikeSeedRecord)) {
      return normalizeWorkflowGraphSeedCandidate({ nodes: value }, defaultPhase);
    }
    if (value.every(isEdgeLikeSeedRecord)) {
      return normalizeWorkflowGraphSeedCandidate({ edges: value }, defaultPhase);
    }
  }

  if (!isRecord(value)) return null;
  const nodeCandidates = readLooseArray(value, ["nodes", "newNodes", "new_nodes"]);
  const edgeCandidates = readLooseArray(value, ["edges", "newEdges", "new_edges"]);
  const collectionCandidates =
    readLooseArray(value, ["collections"]) ??
    (isCollectionLikeSeedRecord(value) ? [value] : undefined);
  const nodes = (nodeCandidates ?? [])
    .map((node) => normalizeWorkflowGraphSeedNode(node, defaultPhase))
    .filter((node): node is WorkflowGraphSeed["nodes"][number] => node !== null);
  const edges = (edgeCandidates ?? [])
    .map(normalizeWorkflowGraphSeedEdge)
    .filter((edge): edge is WorkflowGraphEdge => edge !== null);
  const collections = (collectionCandidates ?? [])
    .map((collection) => normalizeWorkflowGraphSeedCollection(collection, defaultPhase))
    .filter(
      (collection): collection is WorkflowGraphSeed["collections"][number] => collection !== null,
    );
  const parsed = WorkflowGraphSeedSchema.safeParse({
    collections,
    edges,
    nodes,
    reasoning: stringValue(value.reasoning),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 归一化单个节点候选；缺 id 返回 null 丢弃该节点。
 * title 缺失时回退为 id，dependsOn 缺失为空数组；status 不在这里设置。
 */
function normalizeWorkflowGraphSeedNode(
  value: unknown,
  defaultPhase: string,
): WorkflowGraphSeed["nodes"][number] | null {
  if (!isRecord(value)) return null;
  const id = readLooseString(value, ["id", "name", "nodeName", "node_name"]);
  if (!id) return null;
  const title = readLooseString(value, ["title", "summary"]) ?? id;
  const dependsOn =
    readLooseStringArray(value, ["dependsOn", "depends_on", "references", "inputs"]) ?? [];
  return {
    collectionId: readLooseString(value, ["collectionId", "collection_id", "collection"]),
    dependsOn,
    description: readLooseString(value, ["description", "goal"]),
    id,
    kind: value.kind === "phase" ? "phase" : "task",
    phase: readLooseString(value, ["phase"]) ?? defaultPhase,
    prompt: readLooseString(value, ["prompt", "instructions"]),
    title,
  };
}

/**
 * 归一化单条边候选；from/to 任一缺失返回 null 丢弃。
 * 未知端点与重复边不在这一层校验，由 applyWorkflowGraphSeed 统一拒绝。
 */
function normalizeWorkflowGraphSeedEdge(value: unknown): WorkflowGraphEdge | null {
  if (!isRecord(value)) return null;
  const from = readLooseString(value, ["from", "source"]);
  const to = readLooseString(value, ["to", "target"]);
  if (!from || !to) return null;
  return { from, to };
}

/**
 * 归一化单个集合候选；缺 collectionId 返回 null 丢弃。
 * nodeIds 只保留非空字符串；explorable/frontierTarget 缺失保持 undefined，
 * 让生命周期层按集合默认值处理，而不是在这里写成 false/固定数字。
 */
function normalizeWorkflowGraphSeedCollection(
  value: unknown,
  defaultPhase: string,
): WorkflowGraphSeed["collections"][number] | null {
  if (!isRecord(value)) return null;
  const collectionId = readLooseString(value, [
    "collectionId",
    "collection_id",
    "name",
    "id",
    "collectionsname",
  ]);
  if (!collectionId) return null;
  return {
    collectionId,
    explorable: readLooseBoolean(value, ["explorable"]),
    frontierTarget: readLoosePositiveInteger(value, ["frontierTarget", "frontier_target"]),
    goal: readLooseString(value, ["goal"]),
    metric: readLooseString(value, ["metric"]),
    nodeIds: readLooseStringArray(value, ["nodeIds", "node_ids", "nodeNames", "node_names"]) ?? [],
    phase: readLooseString(value, ["phase"]) ?? defaultPhase,
    title: readLooseString(value, ["title"]) ?? collectionId,
  };
}

/**
 * 判断数组元素是否"像节点"：有 kind、id/name、description/goal 或 dependsOn 任一项即可。
 * 仅用于整体数组形态的类型猜测，宁可放过（交由后续归一化丢弃）也不误判。
 */
function isNodeLikeSeedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === "task" ||
      value.kind === "phase" ||
      typeof readLooseValue(value, ["id", "name", "nodeName", "node_name"]) === "string" ||
      typeof readLooseValue(value, ["description", "goal"]) === "string" ||
      Array.isArray(readLooseValue(value, ["dependsOn", "depends_on", "references", "inputs"])))
  );
}

/**
 * 判断数组元素是否"像边"：出现 from/source 或 to/target 任一字符串即可。
 */
function isEdgeLikeSeedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof readLooseValue(value, ["from", "source"]) === "string" ||
      typeof readLooseValue(value, ["to", "target"]) === "string")
  );
}

/**
 * 判断记录是否"像集合"：有 collectionId/name/id、nodeIds、goal、metric 或 explorable。
 * 对象形态下也用它决定是否把整个对象当作单集合候选。
 */
function isCollectionLikeSeedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof readLooseValue(value, ["collectionId", "collection_id", "name", "id"]) === "string" ||
      Array.isArray(readLooseValue(value, ["nodeIds", "node_ids", "nodeNames", "node_names"])) ||
      typeof readLooseValue(value, ["goal"]) === "string" ||
      typeof readLooseValue(value, ["metric"]) === "string" ||
      typeof readLooseValue(value, ["explorable"]) === "boolean")
  );
}
