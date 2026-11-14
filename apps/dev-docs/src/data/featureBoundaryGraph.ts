// 本模块定义 feature-boundary 图谱的领域模型与只读查询函数；图谱数据由 Vite 虚拟模块
// 在构建期从 .agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml 读入并规范化。
// 所有函数均为纯函数，不读写 DOM/网络/存储，可在渲染期安全重复调用；入参图谱视为只读，不得原地修改。
export const featureBoundaryNodeKinds = [
  "capability",
  "ui-surface",
  "service",
  "state-owner",
  "persistence",
  "delivery-boundary",
  "shared-ui",
  "evidence",
  "boundary",
  "unresolved",
] as const;

// 节点类型枚举，决定视图配色与统计口径；"unresolved" 专指图谱中未声明的端点
// （由 unresolved 节点或边引用的缺失 id 补出），不代表真实能力。
export type FeatureBoundaryNodeKind = (typeof featureBoundaryNodeKinds)[number];

// 关系检查等级：must-inspect 必须检查 / should-inspect 建议检查 / conditional 条件成立才检查 /
// invariant-only 仅约束不变量 / evidence-only 仅作为证据；undefined 表示未分级，按"全部"保留。
export type FeatureBoundaryRelationRank =
  | "must-inspect"
  | "should-inspect"
  | "conditional"
  | "invariant-only"
  | "evidence-only";

// 图谱节点：id 为全局唯一键，同时用作 React Flow 节点 id；aliases 参与搜索匹配；
// docs/codeSeeds/invariants 为可读文本清单，允许空数组但不可缺省（规范化后保证字段必有值）。
// 该结构来自 YAML 静态数据，前端只读。
export interface FeatureBoundaryNode {
  id: string;
  kind: FeatureBoundaryNodeKind;
  label: string;
  aliases: string[];
  docs: string[];
  codeSeeds: string[];
  invariants: string[];
}

// 有向关系：from/to 为节点 id，允许指向未声明端点（统计时计入 unresolved）；
// id 可缺失，布局与视图按 from/to/index 生成回退 id；type 为自由文本关系名；
// rank 缺失表示未分级，condition 仅在条件性关系出现，缺省为 undefined。
export interface FeatureBoundaryEdge {
  id?: string;
  from: string;
  to: string;
  type: string;
  rank?: FeatureBoundaryRelationRank;
  condition?: string;
}

// 一张完整图谱：schemaVersion 当前固定为 1，供后续结构迁移判别；graphId 为图谱标识而非节点 id；
// nodes/edges 可为空数组但不可缺省；该对象由虚拟模块序列化注入，运行期只读。
export interface FeatureBoundaryGraph {
  schemaVersion: number;
  graphId: string;
  purpose: string;
  nodes: FeatureBoundaryNode[];
  edges: FeatureBoundaryEdge[];
}

// 统计口径：nodeCount/edgeCount 按数组长度计数（含重复边与自环）；
// unresolvedEndpointCount 为 unresolved 节点与"边引用但不存在节点"的 id 去重并集；
// kindCounts 只包含实际出现的 kind，读取缺省键得到 undefined 而非 0。
export interface FeatureBoundaryGraphStats {
  nodeCount: number;
  edgeCount: number;
  unresolvedEndpointCount: number;
  kindCounts: Partial<Record<FeatureBoundaryNodeKind, number>>;
}

// 一阶邻域边沿：在原始 edge 上补充 source/target 别名以适配 React Flow 字段命名；
// 原始 from/to 保留，详情面板仍需按方向筛选。
export interface FeatureBoundaryNeighborhoodEdge extends FeatureBoundaryEdge {
  source: string;
  target: string;
}

// 某节点的一阶邻域：nodes 含中心节点、直接相邻节点与补齐的 unresolved 占位节点；
// edges 仅保留两端都在 nodes 内的边且不去重；查询不存在的 nodeId 时返回单节点/空边集合而非抛错。
export interface FeatureBoundaryNeighborhood {
  nodes: FeatureBoundaryNode[];
  edges: FeatureBoundaryNeighborhoodEdge[];
}

// 计算图谱概览统计，复杂度 O(V+E)，每次调用重新建 Set，不做缓存。
// graph 视为只读；nodes/edges 为空时返回全 0 统计而不是抛错；无 IO/日志副作用。
// 供工具栏与详情空态展示使用。
export function getFeatureBoundaryGraphStats(
  graph: FeatureBoundaryGraph,
): FeatureBoundaryGraphStats {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const kindCounts: Partial<Record<FeatureBoundaryNodeKind, number>> = {};
  for (const node of graph.nodes) {
    kindCounts[node.kind] = (kindCounts[node.kind] ?? 0) + 1;
  }

  const unresolvedEndpointIds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind === "unresolved") {
      unresolvedEndpointIds.add(node.id);
    }
  }
  for (const edge of graph.edges) {
    for (const endpoint of [edge.from, edge.to]) {
      // 边可引用未声明节点；按 id 去重，避免同一缺失端点被重复计数。
      if (!nodeIds.has(endpoint)) {
        unresolvedEndpointIds.add(endpoint);
      }
    }
  }

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    unresolvedEndpointCount: unresolvedEndpointIds.size,
    kindCounts,
  };
}

// 取指定节点的直接入边/出边及其端点，供"点击节点突出一阶关系"使用。
// nodeId 不存在时不报错：返回该 id 的 unresolved 占位节点与所能收集到的关系。
// 边另一侧缺失的端点会补一个 kind=unresolved、label=id 的占位节点，保证视图连线不断裂。
// 返回新数组与新对象，不修改入参 graph。
export function getFeatureBoundaryNeighborhood(
  graph: FeatureBoundaryGraph,
  nodeId: string,
): FeatureBoundaryNeighborhood {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeIds = new Set<string>([nodeId]);

  for (const edge of graph.edges) {
    if (edge.from === nodeId) {
      nodeIds.add(edge.to);
    }
    if (edge.to === nodeId) {
      nodeIds.add(edge.from);
    }
  }

  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
  for (const id of nodeIds) {
    // 已声明节点已由上面的 filter 收集，跳过以免重复插入占位节点。
    if (nodeById.has(id)) {
      continue;
    }
    nodes.push({
      id,
      kind: "unresolved",
      label: id,
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    });
  }

  const edges = graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({
      ...edge,
      source: edge.from,
      target: edge.to,
    }));

  return { nodes, edges };
}

// 节点 kind 到中文展示名的完整映射；新增 kind 必须同步补全该 Record，否则类型检查失败。
// 仅用于 UI 文案，不参与数据持久化或协议交互。
export const featureBoundaryNodeKindLabels: Record<FeatureBoundaryNodeKind, string> = {
  capability: "能力",
  "ui-surface": "UI 入口",
  service: "服务",
  "state-owner": "状态归属",
  persistence: "持久化",
  "delivery-boundary": "交付边界",
  "shared-ui": "共享 UI",
  evidence: "证据",
  boundary: "架构边界",
  unresolved: "未声明端点",
};
