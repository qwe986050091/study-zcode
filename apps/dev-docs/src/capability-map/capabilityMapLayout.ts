// INV-01 必填数值缺失即抛错：守住位置 必填取数；改错故障 节点被画到原点。
// INV-02 非有限数视为缺失：守住位置 有限性判断；改错故障 无穷值进入坐标。
// INV-03 位置缺失带层级描述：守住位置 位置取数；改错故障 无法定位漏算阶段。
// INV-04 群图只喂本群节点：守住位置 节点过滤；改错故障 群框被外部节点撑大。
// INV-05 跨群边不参与群内布局：守住位置 边过滤；改错故障 为不存在邻居预留空间。
// INV-06 群节点 id 带前缀：守住位置 群 id 拼接；改错故障 与能力节点 id 冲突。
// INV-07 区域节点 id 带前缀：守住位置 区域 id 拼接；改错故障 两类节点互相覆盖。
// INV-08 群框顺序由关系决定：守住位置 排序函数；改错故障 跨群连线走向随机。
// INV-09 群尺寸来自第一阶段：守住位置 群布局表；改错故障 打包尺寸不符。
// INV-10 路径至少两点：守住位置 起止点拼接；改错故障 单点无法成线。
// INV-11 标签取最长线段中点：守住位置 标签计算；改错故障 标签压在节点边框。
// INV-12 空点集兜底原点：守住位置 默认值；改错故障 返回无效坐标。
// INV-13 平移返回新对象：守住位置 平移函数；改错故障 共享坐标被就地改写。
// INV-14 平移后重算标签：守住位置 路径平移；改错故障 标签停在旧坐标。
// INV-15 两阶段必须串行：守住位置 循环内等待；改错故障 共享 worker 状态互相干扰。
// INV-16 worker 必须终止：守住位置 finally；改错故障 后台线程长期残留。
// INV-17 模块求值即计算一次：守住位置 顶层 Promise；改错故障 每个消费者重复布局。
// INV-18 失败保持 rejected：守住位置 顶层 Promise；改错故障 静默重算掩盖错误。
//
// 模块职责：用 ELK 两阶段计算能力地图的区域、群、节点与连线坐标。
// 状态所有权：模块级单例 Promise；布局结果只读共享。
// 阅读顺序：先看两阶段构图，再看坐标提取与平移，最后看主流程拼装。
import ELK, {
  type ELK as ElkApi,
  type ElkEdgeSection,
  type ElkExtendedEdge,
  type ElkNode,
  type ElkPoint,
} from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import { orderGroupsByRelations } from "@/capability-map/capabilityMapGroupOrder.js";
import {
  capabilityEdges,
  capabilityGroups,
  capabilityNodes,
  capabilitySystems,
} from "@/data/productCapabilityMap.js";
import {
  CAPABILITY_GROUP_CONTENT_TOP,
  CAPABILITY_NODE_HEIGHT,
  CAPABILITY_NODE_WIDTH,
  CAPABILITY_SYSTEM_CONTENT_TOP,
} from "@/capability-map/capabilityMapGeometry.js";
import { buildCapabilitySystemPositions } from "@/capability-map/capabilityMapSystemPlacement.js";

// ELK 布局结果的对外形状：坐标均以根画布左上角为原点，单位为画布像素。
// 该结果在模块求值时计算一次并缓存，消费方只读，不得修改其中的数组/Map。
export interface CapabilitySystemLayout {
  // 顶层区域 id，与 capabilitySystems[].id 一致。
  id: string;
  // position 是区域左上角在根画布中的绝对坐标，单位为画布像素。
  position: ElkPoint;
  // 区域外框宽高（含头部与内边距），由 ELK rectpacking 计算。
  width: number;
  height: number;
}

export interface CapabilityGroupLayout {
  // 能力群 id（原始 id，不带 "group:" 前缀）。
  id: string;
  // 所属顶层区域 id，用于挂载 parentId 与后续偏移换算。
  systemId: string;
  // 群框相对所属区域左上角的坐标（React Flow 父子模式下直接作为 position）。
  position: ElkPoint;
  // 群框外框宽高，由 ELK 在区域内排布后返回。
  width: number;
  height: number;
}

export interface CapabilityNodeLayout {
  // 能力节点 id，与 capabilityNodes[].id 一致。
  id: string;
  // 所属能力群 id，决定节点挂在哪个群框内。
  groupId: string;
  // 节点相对群框左上角的坐标（含群头留白）。
  position: ElkPoint;
}

export interface CapabilityEdgeRoute {
  // 关系边 id，与 capabilityEdges[].id 一致，作 Map 键。
  id: string;
  // 已平移到根画布坐标系的折线点序列（首点为 startPoint，末点为 endPoint）。
  points: ElkPoint[];
  // 标签锚点：最长线段的中点，用于放置关系名称气泡。
  labelPosition: ElkPoint;
}

export interface CapabilityMapLayout {
  // 顶层区域框及其全局位置，顺序与数据层一致。
  systems: CapabilitySystemLayout[];
  // groups 的坐标相对各自所属区域，systemId 指明归属。
  groups: CapabilityGroupLayout[];
  // 所有能力节点，坐标相对所属群框。
  nodes: CapabilityNodeLayout[];
  // 连线折线路径索引；未包含某边 id 表示 ELK 未产出 route，渲染层会回退到贝塞尔。
  edgeRoutes: Map<string, CapabilityEdgeRoute>;
}

const capabilityGroupById = new Map(
  capabilityGroups.map((group) => [group.id, group]),
);

// ELK 内部中间结构：群内布局（未叠加区域偏移），节点/连线坐标相对群框左上角。
interface InternalGroupLayout {
  id: string;
  width: number;
  height: number;
  nodes: CapabilityNodeLayout[];
  edgeRoutes: CapabilityEdgeRoute[];
}

// ELK 内部中间结构：区域内布局（未叠加根偏移），群坐标相对区域左上角。
interface InternalSystemLayout {
  id: string;
  width: number;
  height: number;
  groups: CapabilityGroupLayout[];
}

// 读取 ELK 必填数值：缺失或非有限数（undefined/NaN/Infinity）一律抛错，
// 因为坐标缺失会让 React Flow 把节点画到 (0,0)，比显式失败更难排查。
// getRequiredNumber 对 undefined/NaN/Infinity 一律抛错，不静默归零。
// typeof value !== "number" 与 !Number.isFinite(value) 走同一分支。
// 错误信息拼入 description，指出缺失的是 width/height/x/y 哪一项。
// 显式失败优于让 React Flow 把节点画到 (0,0)。
function getRequiredNumber(value: number | undefined, description: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`ELK 未返回有效的 ${description}`);
  }
  return value;
}

// 从位置表取坐标；缺失时抛错并带上区域/群描述，便于定位是哪一层布局漏算。
function getRequiredPosition(
  positions: Map<string, ElkPoint>,
  id: string,
  description: string,
) {
  const position = positions.get(id);
  if (!position) {
    throw new Error(`缺少${description} ${id}`);
  }
  return position;
}

// ELK 内部节点 id 前缀，与 capabilityMapTypes 的 groupFlowNodeId/systemFlowNodeId 保持一致；
// ELK 图要求 id 全局唯一，故加前缀避免与能力节点 id 冲突。
function groupNodeId(groupId: string) {
  return `group:${groupId}`;
}

function systemNodeId(systemId: string) {
  return `system:${systemId}`;
}

// 单个能力群的内部布局图：layered 从左到右，节点尺寸固定，只喂入两端都在本群的边。
// 跨群边不参与群内 layered，否则 ELK 会为不存在的邻居预留空间、把群框撑大。
// buildGroupGraph 只把两端都在本群的边喂给 ELK layered。
// buildGroupGraph 的 edges 只保留两端都在本群节点集合中的边，跨群边留给上层。
// 节点尺寸取自 CAPABILITY_NODE_WIDTH 与 CAPABILITY_NODE_HEIGHT。
function buildGroupGraph(groupId: string): ElkNode {
  const groupNodeIds = new Set(
    capabilityNodes
      .filter((node) => node.groupId === groupId)
      .map((node) => node.id),
  );
  return {
    id: groupNodeId(groupId),
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
      "elk.layered.greedySwitch.activationThreshold": "4",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "8",
      "elk.layered.spacing.edgeNodeBetweenLayers": "16",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.padding": `[top=${CAPABILITY_GROUP_CONTENT_TOP},left=12,bottom=12,right=12]`,
      "elk.randomSeed": "1",
      "elk.spacing.edgeEdge": "8",
      "elk.spacing.edgeNode": "14",
      "elk.spacing.nodeNode": "8",
    },
    children: capabilityNodes
      .filter((node) => node.groupId === groupId)
      .map((node) => ({
        id: node.id,
        width: CAPABILITY_NODE_WIDTH,
        height: CAPABILITY_NODE_HEIGHT,
      })),
    edges: capabilityEdges
      .filter(
        // 只保留群内边：source/target 必须都在本群节点集合中。
        (edge) =>
          groupNodeIds.has(edge.source) && groupNodeIds.has(edge.target),
      )
      .map(
        (edge): ElkExtendedEdge => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target],
        }),
      ),
  };
}

// 单个区域的布局图：rectpacking 把群框紧凑排成矩形，aspectRatio=1.5 控制宽高比。
// 群框输入顺序由 orderGroupsByRelations 决定——打包顺序影响最终位置，从而影响跨群连线走向。
// 群尺寸必须来自已算好的群布局，缺失时抛错（说明第一阶段漏算该群）。
// buildSystemGraph 的 children 顺序由 orderGroupsByRelations 决定。
// 群框宽高取自第一阶段 groupLayoutsById，不在此重算。
// groupLayout 缺失时抛错，说明第一阶段漏算该群。
function buildSystemGraph(
  systemId: string,
  groupLayoutsById: Map<string, InternalGroupLayout>,
): ElkNode {
  return {
    id: systemNodeId(systemId),
    layoutOptions: {
      "elk.algorithm": "rectpacking",
      "elk.aspectRatio": "1.5",
      "elk.padding": `[top=${CAPABILITY_SYSTEM_CONTENT_TOP},left=16,bottom=16,right=16]`,
      "elk.randomSeed": "1",
      "elk.spacing.nodeNode": "24",
    },
    children: orderGroupsByRelations(systemId).map((groupId) => {
      const groupLayout = groupLayoutsById.get(groupId);
      if (!groupLayout) {
        throw new Error(`缺少能力群布局 ${groupId}`);
      }
      return {
        id: groupNodeId(groupId),
        width: groupLayout.width,
        height: groupLayout.height,
      };
    }),
  };
}

// 取一条 ELK 路径的全部点：startPoint + 可选 bendPoints + endPoint，至少 2 个点。
function getRoutePoints(section: ElkEdgeSection) {
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
}

// 标签锚点取"最长线段"的中点，而不是整条折线的几何中点：
// 长边通常位于两节点之间，标签落在这里更易读，也不会压在节点边框上。
// points 为空时兜底为原点，保证返回值始终是合法坐标。
// getRouteLabelPosition 遍历相邻点，取 Math.hypot 最长的那一段。
// points 为空时 labelPosition 兜底为 { x: 0, y: 0 }。
// 返回值始终是合法 ElkPoint，渲染层不必再做空值判断。
function getRouteLabelPosition(points: ElkPoint[]) {
  let longestLength = 0;
  let labelPosition = points[0] ?? { x: 0, y: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) {
      continue;
    }
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longestLength) {
      longestLength = length;
      labelPosition = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      };
    }
  }
  return labelPosition;
}

// 纯坐标平移：返回新对象，不修改入参 point，避免共享坐标被就地改写。
function offsetPoint(point: ElkPoint, offset: ElkPoint) {
  return {
    x: point.x + offset.x,
    y: point.y + offset.y,
  };
}

// 从 ELK 边结果提取折线路径；每条边只取第一个 section（复合边可能有多段），
// 无 section 的边直接跳过——该 id 不会进入 edgeRoutes，渲染层会自动回退到贝塞尔曲线。
function getEdgeRoutes(edges: ElkExtendedEdge[] | undefined) {
  const routes: CapabilityEdgeRoute[] = [];
  for (const edge of edges ?? []) {
    const section = edge.sections?.[0];
    if (!section) {
      continue;
    }
    const points = getRoutePoints(section);
    routes.push({
      id: edge.id,
      points,
      labelPosition: getRouteLabelPosition(points),
    });
  }
  return routes;
}

// 第一阶段：对单个能力群执行 ELK layered 布局，返回群框尺寸与群内节点/连线。
// 异步失败（worker 错误）会向上抛，由最终 Promise 统一被 hook 捕获并展示。
async function calculateGroupLayout(elk: ElkApi, groupId: string) {
  const graph = await elk.layout(buildGroupGraph(groupId));
  return {
    id: groupId,
    width: getRequiredNumber(graph.width, `${graph.id}.width`),
    height: getRequiredNumber(graph.height, `${graph.id}.height`),
    nodes: (graph.children ?? []).map((node) => ({
      id: node.id,
      groupId,
      position: {
        x: getRequiredNumber(node.x, `${node.id}.x`),
        y: getRequiredNumber(node.y, `${node.id}.y`),
      },
    })),
    edgeRoutes: getEdgeRoutes(graph.edges),
  } satisfies InternalGroupLayout;
}

// 第二阶段：把已算好的群框作为不可拆分矩形做 rectpacking，返回区域尺寸与群在区域内的位置。
// ELK 返回的子节点 id 带 "group:" 前缀，这里剥离回原始群 id，供上层按数据键查表。
async function calculateSystemLayout(
  elk: ElkApi,
  systemId: string,
  groupLayoutsById: Map<string, InternalGroupLayout>,
) {
  const graph = await elk.layout(
    buildSystemGraph(systemId, groupLayoutsById),
  );
  return {
    id: systemId,
    width: getRequiredNumber(graph.width, `${graph.id}.width`),
    height: getRequiredNumber(graph.height, `${graph.id}.height`),
    groups: (graph.children ?? []).map((group) => ({
      id: group.id.replace(/^group:/u, ""),
      systemId,
      position: {
        x: getRequiredNumber(group.x, `${group.id}.x`),
        y: getRequiredNumber(group.y, `${group.id}.y`),
      },
      width: getRequiredNumber(group.width, `${group.id}.width`),
      height: getRequiredNumber(group.height, `${group.id}.height`),
    })),
  } satisfies InternalSystemLayout;
}

// 把群内相对路径平移到根画布坐标系；平移后必须重算标签位置，否则标签会停留在旧的相对坐标。
function offsetRoute(route: CapabilityEdgeRoute, offset: ElkPoint) {
  const points = route.points.map((point) => offsetPoint(point, offset));
  return {
    id: route.id,
    points,
    labelPosition: getRouteLabelPosition(points),
  };
}

// 布局主流程（两阶段 + 全局拼装），只在模块求值时执行一次：
// 1) 逐群 layered 布局，得到群尺寸与群内节点/连线；2) 逐区域 rectpacking 得到群在区域内的位置；
// 3) 由系统摆放规则确定区域全局坐标；4) 把群/节点坐标与连线折算到根画布坐标系。
// 所有 ELK 计算串行执行，共用一个 worker；最终在 finally 中终止 worker 释放线程。
// 失败语义：任一阶段缺少尺寸/坐标即抛 Error，Promise reject，由 useCapabilityMapLayout 转成 error 文本。
// 两阶段串行共用 worker。
// 结束时必须终止 worker。
// 任一缺失即整体失败。
async function calculateCapabilityMapLayout(): Promise<CapabilityMapLayout> {
  // 使用 Worker 版 ELK：布局计算放到独立线程，避免长时间阻塞主线程导致画布假死。
  const elk = new ELK({
    workerFactory: () => new ElkWorker(),
  });
  try {
    const groupLayouts: InternalGroupLayout[] = [];
    for (const group of capabilityGroups) {
      // 串行而非 Promise.all：共享同一个 ELK worker，并发调用并不能提高吞吐，反而干扰内部状态。
      groupLayouts.push(await calculateGroupLayout(elk, group.id));
    }
    const groupLayoutsById = new Map(
      groupLayouts.map((groupLayout) => [groupLayout.id, groupLayout]),
    );

    const systemLayouts: InternalSystemLayout[] = [];
    for (const system of capabilitySystems) {
      systemLayouts.push(
        await calculateSystemLayout(elk, system.id, groupLayoutsById),
      );
    }
    // 区域坐标由独立规则计算（运行时区域首行 + 工程基础设施置底），不依赖 ELK 的顶层排布。
    const systemPositions = buildCapabilitySystemPositions(systemLayouts);
    const groups = systemLayouts.flatMap((systemLayout) => systemLayout.groups);
    const groupLayoutPositions = new Map(
      groups.map((group) => [group.id, group.position]),
    );
    const nodes = groupLayouts.flatMap((groupLayout) => groupLayout.nodes);
    const edgeRoutes = new Map<string, CapabilityEdgeRoute>();
    for (const groupLayout of groupLayouts) {
      const group = capabilityGroupById.get(groupLayout.id);
      const systemPosition = group
        ? systemPositions.get(group.systemId)
        : undefined;
      const groupPosition = groupLayoutPositions.get(groupLayout.id);
      if (!systemPosition || !groupPosition) {
        // 群不在任何区域或缺少区域坐标：拼装阶段无法得到绝对路径，直接判为布局失败。
        throw new Error(`缺少能力群全局位置 ${groupLayout.id}`);
      }
      // 绝对偏移 = 区域全局坐标 + 群在区域内的相对坐标（群内连线点仍相对群框）。
      const offset = {
        x: systemPosition.x + groupPosition.x,
        y: systemPosition.y + groupPosition.y,
      };
      for (const route of groupLayout.edgeRoutes) {
        // Map 以边 id 为键，同一 id 后写覆盖先写；数据层保证边只属于一个群，不会跨群重复。
        const globalRoute = offsetRoute(route, offset);
        edgeRoutes.set(globalRoute.id, globalRoute);
      }
    }

    return {
      systems: systemLayouts.map((systemLayout) => ({
        id: systemLayout.id,
        position: getRequiredPosition(
          systemPositions,
          systemLayout.id,
          "顶层区域全局位置",
        ),
        width: systemLayout.width,
        height: systemLayout.height,
      })),
      groups,
      nodes,
      edgeRoutes,
    };
  } finally {
    // 无论成功或抛错都要终止 worker；否则页面卸载后仍遗留后台线程。
    elk.terminateWorker();
  }
}

// 模块级单例 Promise：首个 import 即开始布局，全站共享同一份结果，不重复计算。
// 失败时 Promise 保持 rejected（不会自动重试），需由使用方展示错误而不是静默重算。
// 消费方只读其结果；若要刷新布局（例如数据热更新），需重新导入本模块或另行实现重建。
// capabilityMapLayoutPromise 在模块求值时调用 calculateCapabilityMapLayout。
// 全站共享同一份 Promise，各消费方 await 同一结果。
// 失败保持 rejected。
export const capabilityMapLayoutPromise = calculateCapabilityMapLayout();
