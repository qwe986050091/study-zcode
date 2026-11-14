import type { Edge, Node } from "@xyflow/react";
import {
  capabilityEdges,
  capabilityGroups,
  capabilityNodes,
  capabilityRelationNames,
  capabilitySystems,
  type CapabilityEdge,
  type CapabilityCodeEstimateConfidence,
  type CapabilityGroup,
  type CapabilityNode,
  type CapabilityRelationType,
  type CapabilitySystem,
} from "@/data/productCapabilityMap.js";
import type { CapabilityEdgeRoute } from "@/capability-map/capabilityMapLayout.js";

// 能力地图的共享类型与派生索引：把静态数据（productCapabilityMap）整理成
// React Flow 节点/边所需的 data 形状，并提供分组查表、跨群度数、关系配色与格式化工具。
// 本模块在求值时一次性构建只读索引，无 IO 与副作用，可被渲染层与布局层直接引用。

// 连线范围："all" 展示全部关系；"cross" 只展示 source/target 属于不同能力群的跨群关系。
export type EdgeScope = "all" | "cross";
// 当前选中项：group 为整群选择，node 为单节点选择，null 表示未选中（画布默认态）。
// id 需能在 groupById / nodeById 中命中，调用方负责存在性校验后再写入选择状态。
export type CapabilitySelection =
  | { kind: "group"; id: string }
  | { kind: "node"; id: string }
  | null;

export interface CapabilitySystemNodeData extends Record<string, unknown> {
  // 数据层原始区域对象（name/description 等），只读展示，不在 UI 侧派生新字段。
  system: CapabilitySystem;
  // 因选择或搜索不相关而整体降低透明度；true 时节点仍可点击，不卸载。
  dimmed: boolean;
}

export interface CapabilityGroupNodeData extends Record<string, unknown> {
  // 数据层原始能力群对象，含 owner 与 codeEstimate 等展示字段。
  group: CapabilityGroup;
  // 因选择或搜索不相关而降透明度；不影响命中测试。
  dimmed: boolean;
  // 是否为当前选中的群，仅驱动边框高亮样式。
  selected: boolean;
}

export interface CapabilityItemNodeData extends Record<string, unknown> {
  // 数据层原始能力节点（label/scope/authority）。
  capability: CapabilityNode;
  // 与选择无关或未命中搜索时为 true，用于整体压暗。
  dimmed: boolean;
  // 是否命中当前搜索词；无搜索词时恒为 false，不参与常亮判断。
  searchMatch: boolean;
  // 是否为当前选中的节点。
  selected: boolean;
}

export interface CapabilityEdgeData extends Record<string, unknown> {
  // 数据层原始关系边，type 决定配色与图例名称。
  capability: CapabilityEdge;
  // 存在选择且该边不属于一阶关系时为 true。
  dimmed: boolean;
  // 是否与当前选择直接相连，驱动加粗箭头与标签显示。
  highlighted: boolean;
  // 是否显示关系标签：仅"选中节点 + 该边高亮"时为 true，避免群级视图标签过密。
  showLabel: boolean;
  // ELK 计算出的绝对折线路径；缺失时边组件回退到贝塞尔曲线，不影响渲染。
  route?: CapabilityEdgeRoute;
}

export interface CapabilityGroupComplexity {
  // 跨群入度：其他群指向本群的边数（同群内部边不计）。
  inDegree: number;
  // 跨群出度：本群指向其他群的边数（同群内部边不计）。
  outDegree: number;
}

// React Flow 节点类型的三种别名：区域框、群框、能力节点，type 字面量需与 nodeTypes 注册键一致。
export type CapabilityGroupFlowNode = Node<
  CapabilityGroupNodeData,
  "capability-group"
>;
export type CapabilityItemFlowNode = Node<
  CapabilityItemNodeData,
  "capability-item"
>;
export type CapabilitySystemFlowNode = Node<
  CapabilitySystemNodeData,
  "capability-system"
>;
// 画布中所有节点类型的联合，供 ReactFlow 泛型约束与 flowNodes 数组类型标注。
export type CapabilityFlowNode =
  | CapabilitySystemFlowNode
  | CapabilityGroupFlowNode
  | CapabilityItemFlowNode;
// 连线类型别名；type 固定为 "capability-edge"，与 edgeTypes 注册键对应。
export type CapabilityFlowEdge = Edge<CapabilityEdgeData, "capability-edge">;

// 静态数据的一次性查表索引：nodeById / groupById / systemById 三个 Map，键均为数据层 id。
// 重复 id 会被后者覆盖，属数据错误；读取结果为 undefined 表示引用不存在，调用方需显式处理而非假定存在。
// 索引在模块求值时构建后不再变更，静态数据改动必须重新求值本模块才能生效。
export const nodeById = new Map(capabilityNodes.map((node) => [node.id, node]));
export const groupById = new Map(
  capabilityGroups.map((group) => [group.id, group]),
);
export const systemById = new Map(
  capabilitySystems.map((system) => [system.id, system]),
);
// 跨群度数的累加器：先为每个能力群初始化 0/0，再遍历全部关系边累加。
// 只有两端都属于已登记群、且群 id 不同的边才计入，方向按 source→target 定义。
const mutableGroupComplexityById = new Map<string, CapabilityGroupComplexity>(
  capabilityGroups.map((group) => [
    group.id,
    {
      inDegree: 0,
      outDegree: 0,
    },
  ]),
);

for (const edge of capabilityEdges) {
  const sourceGroupId = nodeById.get(edge.source)?.groupId;
  const targetGroupId = nodeById.get(edge.target)?.groupId;
  if (!sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId) {
    // 端点缺群信息或同群内部边：不构成跨群依赖，直接跳过。
    continue;
  }
  const sourceComplexity = mutableGroupComplexityById.get(sourceGroupId);
  const targetComplexity = mutableGroupComplexityById.get(targetGroupId);
  if (!sourceComplexity || !targetComplexity) {
    // 数据引用了未登记的能力群：静默跳过，避免单条脏数据让整张地图求值失败。
    continue;
  }
  sourceComplexity.outDegree += 1;
  targetComplexity.inDegree += 1;
}

// 对外暴露的只读快照：逐条浅拷贝，渲染层拿不到累加器本身，避免共享计数被篡改。
// 快照在模块求值后不再变化，关系数据改动需重新构建本模块。
// 读取方应把该 Map 当作只读；其内容与 getCapabilityGroupComplexity 的返回值一致。
export const groupComplexityById = new Map(
  [...mutableGroupComplexityById].map(([groupId, complexity]) => [
    groupId,
    { ...complexity },
  ]),
);

// 关系类型集合与展示顺序：直接取关系名称字典的键序，工具栏勾选项与详情图例依赖此顺序。
// 该顺序属于对外展示契约，调整字典键序会同时改变工具栏与图例的排列。
// 字典为空时返回空数组，此时工具栏没有任何可勾选类型（不会自动补默认值）。
export const relationTypes = Object.keys(
  capabilityRelationNames,
) as CapabilityRelationType[];

// 关系类型 → 连线/图例颜色，值为主题 CSS 变量而非固定色号，保证深浅色切换时同步。
// delivery/invariant/runtime/shared/state 五类语义由数据层定义，新增类型需在此补色。
// 键集合必须与 relationTypes 完全一致，缺色会让该类型连线落到默认描边色。
export const relationColors: Record<CapabilityRelationType, string> = {
  delivery: "var(--color-relation-delivery)",
  invariant: "var(--color-relation-invariant)",
  runtime: "var(--color-relation-runtime)",
  shared: "var(--color-relation-shared)",
  state: "var(--color-relation-state)",
};

// 代码估算置信度的中文展示名，键为数据层英文枚举；Record 类型保证枚举新增时编译期报缺项。
// 仅用于详情面板与群头徽标的文案，不参与任何过滤或排序逻辑。
// 若运行时拿到未登记的枚举值，查表结果为 undefined，调用方需自行兜底。
export const capabilityCodeEstimateConfidenceNames: Record<
  CapabilityCodeEstimateConfidence,
  string
> = {
  high: "高（High）",
  "medium-high": "中高（Medium-high）",
  medium: "中（Medium）",
  "medium-low": "中低（Medium-low）",
};

// 千分位格式化器复用同一实例，避免每次渲染重复构造 Intl.NumberFormat。
const integerFormatter = new Intl.NumberFormat("zh-CN");

// 紧凑口径：按百行四舍五入到 0.1k，输出形如 "≈12.3k LOC"，用于群头徽标等窄区域。
// 入参为生产代码行数（不含测试与生成代码）；0~49 行会显示 ≈0k，属展示近似而非精确值。
// 输出固定带 "≈" 前缀，提醒读者这是估算值；不处理负数与 NaN（数据层保证合法）。
export function formatCapabilityCodeEstimateCompact(productionLines: number) {
  const thousands = Math.round(productionLines / 100) / 10;
  return `≈${thousands}k LOC`;
}

// 完整口径：千分位分隔并加"约"前缀，输出形如 "约 12,300 行"，用于详情面板；
// 不做四舍五入，负数或非法值会原样参与格式化（数据层保证为非负整数）。
// 与紧凑口径共享同一入参语义，切换展示位置时数字口径应保持一致。
export function formatCapabilityCodeEstimateFull(productionLines: number) {
  return `约 ${integerFormatter.format(productionLines)} 行`;
}

// 取群的跨群入/出度快照；groupId 未登记时抛错，因为群头与详情面板都依赖该值，
// 静默返回 0 会把数据缺失伪装成"无跨群关系"，因此按错误处理、由调用方暴露。
// 返回对象来自只读快照，调用方不应就地修改（修改也不会影响其他调用方）。
export function getCapabilityGroupComplexity(groupId: string) {
  const complexity = groupComplexityById.get(groupId);
  if (!complexity) {
    throw new Error(`能力群不存在，无法计算复杂度：${groupId}`);
  }
  return complexity;
}

// React Flow 群节点 id 前缀约定："group:<groupId>"，与 capabilityMapLayout 内部节点 id 保持一致；
// 修改前缀需同步布局层的解析逻辑（其用 replace(/^group:/) 还原原始 id）。
// 该函数只做拼接，不校验 groupId 是否存在；空 id 会生成 "group:"，调用方需保证入参非空。
export function groupFlowNodeId(groupId: string) {
  return `group:${groupId}`;
}

// React Flow 区域节点 id 前缀约定："system:<systemId>"，群节点的 parentId 依赖它挂到区域框内。
// 区域节点在画布中承担分组容器职责，id 冲突会导致整组节点错挂到别的区域。
// 同样只做拼接、不校验存在性，数据层 id 必须唯一。
export function systemFlowNodeId(systemId: string) {
  return `system:${systemId}`;
}
