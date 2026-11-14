import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint } from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import graph from "virtual:zcode-feature-boundary-graph";

// 节点宽高是布局与渲染的唯一来源：ELK 用它们计算坐标，React Flow 用同一常量设置节点 style；
// 两处若不一致会导致连线端点与节点边缘偏移。
export const FEATURE_BOUNDARY_NODE_WIDTH = 236;
export const FEATURE_BOUNDARY_NODE_HEIGHT = 72;

// 单个节点的布局结果：position 为 ELK 输出的左上角坐标，单位 px，原点是图层 padding 后的内容区。
export interface FeatureBoundaryNodeLayout {
  id: string;
  position: ElkPoint;
}

// 整图布局结果：width/height 为含 padding 的画布尺寸（px，ELK 返回值）；
// nodes 只包含 ELK 实际返回坐标的节点，缺失项不会补默认位置。
export interface FeatureBoundaryGraphLayout {
  width: number;
  height: number;
  nodes: FeatureBoundaryNodeLayout[];
}

// ELK 在异常输入下可能不返回 x/y/width/height；这里显式抛错而不是静默补 0，
// 让布局失败以错误提示暴露，避免画出一张位置全错但看似成功的图。
function requiredNumber(value: number | undefined, description: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`ELK 未返回有效的 ${description}`);
  }
  return value;
}

// 把领域图谱映射为 ELK 图：固定节点尺寸、左→右层次布局、正交连线，randomSeed 固定为 1
// 以保证同一输入输出稳定；边 id 缺失时按索引生成 edge-<index>，与视图侧回退规则一致。
// 只读取 virtual module 注入的只读图谱，无 IO。
function buildLayoutGraph(): ElkNode {
  return {
    id: "feature-boundary-graph",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.layered.spacing.nodeNodeBetweenLayers": "24",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      "elk.randomSeed": "1",
      "elk.spacing.edgeEdge": "10",
      "elk.spacing.edgeNode": "18",
      "elk.spacing.nodeNode": "18",
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: FEATURE_BOUNDARY_NODE_WIDTH,
      height: FEATURE_BOUNDARY_NODE_HEIGHT,
    })),
    edges: graph.edges.map(
      (edge, index): ElkExtendedEdge => ({
        id: edge.id ?? `edge-${index}`,
        sources: [edge.from],
        targets: [edge.to],
      }),
    ),
  };
}

// 在 Web Worker 中执行 ELK 布局，避免阻塞主线程；无论成功失败都在 finally 中 terminateWorker。
// 返回坐标为 px（ELK 输出），仅含 ELK 实际返回的节点；失败时 reject 原始错误，由视图降级为错误提示。
async function calculateFeatureBoundaryGraphLayout(): Promise<FeatureBoundaryGraphLayout> {
  const elk = new ELK({
    workerFactory: () => new ElkWorker(),
  });
  try {
    const result = await elk.layout(buildLayoutGraph());
    return {
      width: requiredNumber(result.width, "feature boundary graph width"),
      height: requiredNumber(result.height, "feature boundary graph height"),
      nodes: (result.children ?? []).map((node) => ({
        id: node.id,
        position: {
          x: requiredNumber(node.x, `${node.id}.x`),
          y: requiredNumber(node.y, `${node.id}.y`),
        },
      })),
    };
  } finally {
    elk.terminateWorker();
  }
}

// 模块加载即启动一次布局，全应用共享同一个 Promise（只计算一次）。
// Promise 失败后不重试；视图会长期展示错误，刷新页面才会重新计算。
export const featureBoundaryGraphLayoutPromise = calculateFeatureBoundaryGraphLayout();
