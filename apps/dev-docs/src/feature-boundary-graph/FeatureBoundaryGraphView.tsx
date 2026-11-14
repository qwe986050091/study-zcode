// FeatureBoundaryGraphView —— feature boundary 图谱页面（React Flow 画布 + 工具栏 + 详情侧栏）。
//
// 职责边界：
//   - 拥有：搜索词、关系等级筛选、选中节点三态，以及由它们派生的 dimmed/searchMatch/highlighted 展示态。
//   - 拥有：布局 Promise 的消费与三种视图态（计算中占位、布局成功、布局失败整页降级）。
//   - 不拥有：图谱内容（virtual:zcode-feature-boundary-graph 构建期只读）与 ELK 坐标（共享布局单例）。
//   - 不拥有：统计口径与 kind 文案（@/data/featureBoundaryGraph.js），本文件只调用不复制规则。
//   - 不拥有：React Flow 的缩放/平移视口，它只存在于 RF 实例内部，也不回写图谱。
//
// INV 表（断言 —— 守住它的位置 —— 改错故障）：
// INV-01 断言：graph 及 graphStats/graphNodeById 为模块级只读快照 —— 守住它的位置：模块顶层的 const 声明 —— 改错故障：交互期重算导致统计与节点索引分叉，详情显示陈旧计数。
// INV-02 断言：flowNodes/flowEdges 只由 graph + layout + 三态派生，绝不写回 graph —— 守住它的位置：flowNodes/flowEdges 的 useMemo —— 改错故障：筛选与选中污染源数据，重置后无法回到初始图。
// INV-03 断言：节点坐标只来自 layout.nodes，此处不重算布局 —— 守住它的位置：flowNodes 内的 positions Map —— 改错故障：视图里出现第二套布局，坐标漂移、边端点错位。
// INV-04 断言：布局缺失坐标的节点整条跳过，不落到 (0,0) —— 守住它的位置：flatMap 中的 position 缺失分支 —— 改错故障：节点堆叠在原点，遮挡他人并让「未布局」被误读为结构关系。
// INV-05 断言：节点尺寸恒为 FEATURE_BOUNDARY_NODE_WIDTH/HEIGHT —— 守住它的位置：flowNodes 的 style —— 改错故障：ELK 按固定尺寸算出的坐标与实际渲染不符，边压住节点。
// INV-06 断言：rankFilter 只收缩边集合，节点集合始终完整 —— 守住它的位置：visibleEdges 与 graph.nodes 全量遍历 —— 改错故障：筛选后出现孤立点，用户误判图谱结构缺失。
// INV-07 断言：选中邻域基于 visibleEdges 计算 —— 守住它的位置：connectedNodeIds 的 useMemo —— 改错故障：突出已被筛掉的边，高亮与可见边口径不一致。
// INV-08 断言：空查询不产生匹配集合，搜索态由 normalizedQuery 判定 —— 守住它的位置：matchingNodeIds 的早返回 —— 改错故障：空串把全部节点标记为未匹配，整图变暗。
// INV-09 断言：dimmed 是选中与搜索的或关系，两者可叠加 —— 守住它的位置：flowNodes 的 dimmed 表达式 —— 改错故障：搜索命中但非邻居的节点被错误提亮或压暗。
// INV-10 断言：边 id 回退规则与布局、详情侧一致（edge.id ?? 序号） —— 守住它的位置：flowEdges 的 edgeId 计算 —— 改错故障：无 id 的边在多处生成不同 key，高亮丢失或 React 复用错位。
// INV-11 断言：sourceHandle/targetHandle 与节点两个 Handle 的 id 严格对齐 —— 守住它的位置：flowEdges 的 handle 字段与 NodeView —— 改错故障：连线锚点失效，边画到节点中心或直接消失。
// INV-12 断言：布局 Promise 只在挂载时订阅一次，卸载后丢弃迟到结果 —— 守住它的位置：useFeatureBoundaryGraphLayout 的 active 标志 —— 改错故障：卸载后 setState 警告，重复订阅导致多份 layout 竞争。
// INV-13 断言：fitView 只在 layout 落地后与重置时触发，且走 requestAnimationFrame —— 守住它的位置：布局 effect 与 clear —— 改错故障：节点未测量就适配，缩放比例与可视区域算错。
// INV-14 断言：布局失败整页降级为错误提示，不渲染空画布 —— 守住它的位置：if (error) 早返回 —— 改错故障：用户把布局故障误读为「图谱为空」。
// INV-15 断言：选中 id 不在 graphNodeById 中时详情返回 null，不抛错 —— 守住它的位置：FeatureBoundaryDetail 的 node 判空 —— 改错故障：数据热更新后详情显示空字段或整块崩溃。
/* eslint-disable max-lines -- 图谱节点、关系筛选和详情面板需要共享同一套交互状态。 */
// 数据流：virtual module 提供只读图谱 → featureBoundaryGraphLayoutPromise 提供 ELK 坐标 →
// 本文件的筛选/搜索/选中状态只在渲染层派生 flowNodes/flowEdges，不回写图谱本身。
// 交互口径：点击节点选中并突出其一阶关系；点击画布空白清除选中；关系等级筛选只影响可见边，
// 不影响节点集合；搜索与选中可同时生效，两者各自决定节点/边的 dimmed。
import "@xyflow/react/dist/style.css";
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Filter, Network, RotateCcw, Search } from "lucide-react";
import graph from "virtual:zcode-feature-boundary-graph";
import {
  featureBoundaryNodeKindLabels,
  getFeatureBoundaryGraphStats,
  type FeatureBoundaryEdge,
  type FeatureBoundaryGraph,
  type FeatureBoundaryNode,
  type FeatureBoundaryNodeKind,
  type FeatureBoundaryRelationRank,
} from "@/data/featureBoundaryGraph.js";
import {
  FEATURE_BOUNDARY_NODE_HEIGHT,
  FEATURE_BOUNDARY_NODE_WIDTH,
  featureBoundaryGraphLayoutPromise,
  type FeatureBoundaryGraphLayout,
} from "@/feature-boundary-graph/featureBoundaryGraphLayout.js";

// React Flow 节点携带的展示态：node 为只读领域节点；selected 表示当前详情选中；
// dimmed 由"选中后非一阶邻居"或"搜索不匹配"推导；searchMatch 只表示搜索命中，不改变选中语义。
type FeatureBoundaryFlowNodeData = {
  node: FeatureBoundaryNode;
  selected: boolean;
  dimmed: boolean;
  searchMatch: boolean;
};

type FeatureBoundaryFlowNode = Node<FeatureBoundaryFlowNodeData, "feature-boundary-node">;

// React Flow 边携带的展示态：highlighted 表示与选中节点直接相连，dimmed 为选中态下的其余边；
// showLabel 仅在 highlighted 时开启，避免全图标签互相遮挡。
type FeatureBoundaryFlowEdgeData = {
  edge: FeatureBoundaryEdge;
  highlighted: boolean;
  dimmed: boolean;
  showLabel: boolean;
};

type FeatureBoundaryFlowEdge = Edge<FeatureBoundaryFlowEdgeData, "feature-boundary-edge">;

// 关系等级筛选项，顺序即下拉框展示顺序；"all" 是唯一表示不筛选的哨兵值。
// 与 FeatureBoundaryRelationRank 同步维护，新增等级需在此补中文文案。
const rankOptions: Array<[FeatureBoundaryRelationRank | "all", string]> = [
  ["all", "全部关系"],
  ["must-inspect", "必须检查"],
  ["should-inspect", "建议检查"],
  ["conditional", "条件关系"],
  ["invariant-only", "仅不变量"],
  ["evidence-only", "仅证据"],
];

// 图谱在模块加载期只读一次：统计供工具栏/空态展示，索引供详情与关系列表 O(1) 反查。
// 两者都基于同一份 virtual module 数据，运行期不随交互变化。
// [契约] 统计与节点索引同源：都在模块加载期从同一份 graph 计算一次，运行期只读。
// 统计只服务展示（工具栏计数、空态侧栏），不参与任何可见性或 dimmed 判断。
// 不要在组件内按筛选条件重算统计；rankFilter 属于渲染期状态，不是数据事实。
// 新增指标时连同 getFeatureBoundaryGraphStats 的返回类型一起改，本文件不自行拼装口径。
// 两者必须基于同一 graph 引用，否则统计与详情可能指向不同版本的图谱。
const graphStats = getFeatureBoundaryGraphStats(graph);
// [资源] 索引是一次性内存映射，容量由图谱节点数决定，运行期不增删。
// 若未来改为懒加载图谱，应替换此处索引来源，而不是在组件里做增量合并。
// 反查只用于详情与关系列表，不参与渲染顺序，因此除覆盖全量外没有额外语义。
const graphNodeById = new Map(graph.nodes.map((node) => [node.id, node]));

// 订阅共享布局 Promise，并把结果/错误写入本地 state。
// layout 初值 null 表示"计算中"，视图据此显示占位而非空图；error 非空时优先展示错误。
// 布局是全应用单例，本 hook 不触发重算，只消费 featureBoundaryGraphLayoutPromise。
// [并发] 布局是应用级单例 Promise，本 hook 只订阅不创建，避免同一图谱被并行布局多次。
// 多个画布实例共享同一 Promise 结果，因此 layout 对象视为不可变，禁止原地修改坐标。
// 订阅时机固定为挂载；重复挂载只会多一次 then，不会触发重算。
// 若将来引入重算，必须替换 Promise 引用并让本 hook 重新订阅，不能在 effect 内轮询。
// hook 只返回 layout/error，不返回 setter，写入权完整留在此函数内部。
function useFeatureBoundaryGraphLayout() {
  const [layout, setLayout] = useState<FeatureBoundaryGraphLayout | null>(null);
  // [失败路径] 三个视图态互斥：layout 空且 error 空＝计算中；error 非空＝整页降级；否则渲染画布。
  // error 只由 Promise 拒绝写入，成功分支不清空它，避免出现「已成功又有错误」的非法组合。
  // layout 与 error 分开存储而不用 union，降低渲染分支的判定成本。
  // 错误信息取 Error.message 或 String(原始值)，保留原文供排查，不做归类吞并。
  // 挂载前 layout 为 null 是合法初始态，不能当作失败。
  const [error, setError] = useState("");

  useEffect(() => {
    // Promise 不可取消，用 active 标志在卸载后丢弃迟到结果，避免 setState 警告。
    // [并发] Promise 不可取消，active 标志只负责丢弃卸载后的迟到结果，不负责中断计算。
    // 清理函数只置位不 setState，避免卸载路径触发 React 警告。
    // strict mode 下双挂载会得到两个独立闭包，各管各的 state，互不干扰。
    // 若把 active 放到依赖数组之外重建，会造成旧回调写入新 state 的竞态。
    // 订阅没有超时兜底：布局 Promise 永不 settle 时视图停在计算中占位，不伪造空图。
    let active = true;
    void featureBoundaryGraphLayoutPromise
      .then((nextLayout) => {
        if (active) {
          setLayout(nextLayout);
        }
      })
      .catch((layoutError: unknown) => {
        // 失败时 layout 保持 null，视图会优先展示 error，不会渲染半成品图。
        if (active) {
          setError(layoutError instanceof Error ? layoutError.message : String(layoutError));
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return { error, layout };
}

// 生成节点 kind 对应的样式类名；类名必须与 styles.css 中的 feature-boundary-node--* 规则保持一致，
// 否则仅丢失配色，不影响交互。
function getFeatureBoundaryKindClass(kind: FeatureBoundaryNodeKind) {
  return `feature-boundary-node--${kind}`;
}

// 自定义节点：只渲染 kind 文案与 label，宽高由 flowNodes.style 固定；
// 左右 Handle 的 id 必须与 flowEdges 的 sourceHandle/targetHandle 一致，否则连线无法锚定。
// 节点不可拖拽/不可连线，选中只由外层 onNodeClick 驱动。
// [契约] 节点只读渲染：label 与 kind 文案全部取自 data.node，组件内不做数据推导。
// 宽高由 flowNodes.style 固定，节点自身不设尺寸，否则与 ELK 的假设尺寸不一致。
// 两个 Handle 的 id 「target」/「source」是连线契约，必须与 flowEdges 逐字一致。
// 选中/搜索/暗淡三个类名只影响配色，不承载可见性语义（可见性由 flowNodes 决定）。
// aria-label 由 label + kind 文案拼成，只服务可访问性，不参与样式或筛选。
function FeatureBoundaryNodeView({ data }: NodeProps<FeatureBoundaryFlowNode>) {
  // [契约] 解构只读取 data，不改写；React Flow 传入的节点数据视为不可变。
  // 四个展示态均由画布预计算，节点组件不做二次判定，保证同一节点多处渲染结论一致。
  // 字段名与 FeatureBoundaryFlowNodeData 一一对应，删字段要同步改解构与类名判定。
  const { node, searchMatch, selected, dimmed } = data;
  return (
    <article
      aria-label={`${node.label}，${featureBoundaryNodeKindLabels[node.kind]}`}
      className={`feature-boundary-node ${getFeatureBoundaryKindClass(node.kind)} ${
        selected ? "is-selected" : ""
      } ${searchMatch ? "is-search-match" : ""} ${dimmed ? "is-dimmed" : ""}`}
    >
      <Handle
        className="feature-boundary-handle"
        id="target"
        position={Position.Left}
        type="target"
      />
      <span className="feature-boundary-node-kind">{featureBoundaryNodeKindLabels[node.kind]}</span>
      <span className="feature-boundary-node-label" title={node.label}>
        {node.label}
      </span>
      <Handle
        className="feature-boundary-handle"
        id="source"
        position={Position.Right}
        type="source"
      />
    </article>
  );
}

// 自定义边：固定右→左的 smoothstep 折线，坐标由 React Flow 按源/目标 Handle 计算后传入。
// data 在 React Flow 内部可能短暂为空，读取时统一用可选链兜底；标签只在相邻选中时渲染。
function FeatureBoundaryEdgeView({
  data,
  markerEnd,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps<FeatureBoundaryFlowEdge>) {
  // [契约] 边坐标全部由 React Flow 按源/目标 Handle 实测后传入，本组件不估算端点。
  // 固定 Right→Left 与节点的左右 Handle 对应；改方向必须同时改 NodeView 的 position。
  // labelX/labelY 只用于标签定位，不参与路径计算，上移 12px 是纯视觉补偿。
  // data 在挂载瞬间可能为空，读取一律走可选链，缺失按未高亮处理而不是抛错。
  // 折线拐角样式由全局 css 决定，此处不内联 stroke，避免覆盖选中态配色。
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left,
  });
  return (
    <>
      <BaseEdge
        className={`feature-boundary-edge ${
          data?.highlighted ? "is-highlighted" : ""
        } ${data?.dimmed ? "is-dimmed" : ""}`}
        markerEnd={markerEnd}
        path={path}
      />
      {data?.showLabel ? (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-ui-xs text-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY - 12}px)`,
            }}
          >
            {data.edge.type}
            {data.edge.rank ? ` · ${data.edge.rank}` : ""}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

// React Flow 类型注册表：键必须与 flowNodes/flowEdges 使用的 type 字面量完全一致。
// [契约] 注册表的键是 flowNodes/flowEdges type 字面量的唯一真源，两侧必须逐字相同。
// 注册表必须是模块级常量：每次渲染新建对象会迫使 React Flow 重挂全部节点。
// 节点与边各自一个注册表、不合并，避免同名 type 冲突时静默降级为默认渲染。
// 新增可视化类型时先加注册表再改 useMemo 的 type 字段，顺序反了会整图降级。
// 注册表只登记组件，不在此处注入数据，数据仍由 flowNodes 的 data 单向下发。
const featureBoundaryNodeTypes = {
  "feature-boundary-node": FeatureBoundaryNodeView,
};

const featureBoundaryEdgeTypes = {
  "feature-boundary-edge": FeatureBoundaryEdgeView,
};

// 画布主体：把只读图谱 + ELK 坐标投影为可交互的 flowNodes/flowEdges。
// 状态仅含搜索词、关系等级筛选与选中节点；匹配集合、可见边、邻域均 useMemo 派生，不重复存状态。
// 布局未就绪时显示占位文字；布局失败时整页降级为错误提示。
// [权衡] 画布只持三态（query/rankFilter/selection），其余全部 useMemo 派生，避免重复状态。
// 缩放与平移属于 React Flow 实例内部状态，本组件既不读取也不回写，源数据因此不受视图影响。
// 派生链固定为 graph → 匹配集合/可见边 → 邻域 → flowNodes/flowEdges，单向无回环。
// 若把 dimmed 也存成 state，会出现派生值与源状态不同步的双写问题。
// 本组件状态随画布卸载而销毁，不做跨页缓存，避免离开页面后选中残留。
function FeatureBoundaryGraphCanvas() {
  const { fitView } = useReactFlow<FeatureBoundaryFlowNode, FeatureBoundaryFlowEdge>();
  const { error, layout } = useFeatureBoundaryGraphLayout();
  const [query, setQuery] = useState("");
  // [权衡] 搜索用 useDeferredValue 降优先级：输入框立即响应，匹配重算延后一帧。
  // 派生集合一律基于 deferredQuery 而非 query，保证同一次渲染里匹配与展示一致。
  // 延迟会带来短暂不一致（输入已变、高亮未变），这是可接受取舍，不加加载态提示。
  // 清空搜索时 deferredQuery 也会追上，不需要额外重置逻辑。
  // 规范化（trim + 小写折叠）只做一次并在此处定稿，下游不再重复处理。
  const deferredQuery = useDeferredValue(query);
  const [rankFilter, setRankFilter] = useState<FeatureBoundaryRelationRank | "all">("all");
  const [selection, setSelection] = useState<string | null>(null);
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();

  // [契约] 匹配集合只由 normalizedQuery 决定，大小写折叠统一走 toLocaleLowerCase。
  // 空查询返回空集合而非全量集合；画布用 normalizedQuery 判断搜索态，二者必须成对使用。
  // 匹配字段固定为 id/label/aliases，新增可搜索字段要同步这里的拼接，不引入第二套规则。
  // 结果是 id 集合、不携带节点对象，避免与 graph 快照形成第二份引用。
  // 搜索只决定 dimmed 与 is-search-match，从不改变节点集合，也不会自动选中。
  const matchingNodeIds = useMemo(() => {
    // 空查询返回空集合，视图侧用 normalizedQuery 判断是否启用搜索态，避免把全部节点当作未匹配。
    if (!normalizedQuery) {
      return new Set<string>();
    }
    return new Set(
      graph.nodes
        .filter((node) =>
          [node.id, node.label, ...node.aliases]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        )
        .map((node) => node.id),
    );
  }, [normalizedQuery]);

  // 等级筛选只作用于边；节点始终全部渲染，避免筛选后出现孤立点造成结构误读。
  // 「all」是唯一不筛选的哨兵值，与 rankOptions 首项保持一致。
  // visibleEdges 同时供 flowEdges 与 connectedNodeIds 使用，筛选口径只有这一处。
  // 不要在渲染分支里再过滤一次边，重复过滤会让邻域与可见边不一致。
  // 筛选不回写 graph.edges，原始边集合始终完整，重置时无需重新取数。
  const visibleEdges = useMemo(
    () => graph.edges.filter((edge) => rankFilter === "all" || edge.rank === rankFilter),
    [rankFilter],
  );

  // 选中节点的可见一阶邻域；筛选变化会收缩邻域，避免突出已被筛掉的边。
  // [契约] 一阶邻域基于 visibleEdges 计算：被筛掉的边不参与邻域，高亮与可见性保持一致。
  // 未选中时返回空集合，调用方用 Boolean(selection) 区分「无选中」与「选中但无邻居」。
  // 邻域集合包含选中节点自身，便于 dimmed 表达式统一处理。
  // 边按无向语义计算（from/to 都算一阶），与详情侧栏的出/入边口径刻意不同。
  // 邻域只影响展示态，不裁剪节点数组，因此选中不会引起 React Flow 重排。
  const connectedNodeIds = useMemo(() => {
    if (!selection) {
      return new Set<string>();
    }
    const ids = new Set([selection]);
    for (const edge of visibleEdges) {
      if (edge.from === selection) {
        ids.add(edge.to);
      }
      if (edge.to === selection) {
        ids.add(edge.from);
      }
    }
    return ids;
  }, [selection, visibleEdges]);

  // [契约] 节点数据来源单一：集合永远是 graph.nodes 全量，坐标永远来自 layout，按 id 对齐。
  // 选中不改变节点集合，只改 data 上的 selected/dimmed/searchMatch，节点数量因此稳定。
  // style 尺寸必须与布局常量同源，改一处即改变 ELK 的碰撞假设。
  // 依赖数组需覆盖全部派生输入，漏掉任一会产生陈旧的高亮或暗淡状态。
  // 节点保持不可拖拽：拖动只改视图坐标而不改 layout，会让重置与缩放后的位置对不上。
  const flowNodes = useMemo<FeatureBoundaryFlowNode[]>(() => {
    if (!layout) {
      return [];
    }
    // [契约] 坐标唯一来源是 layout.nodes：本文件不排序、不抖动、不做增量微调。
    // positions 每次派生重建，只做 id→position 的只读查表，键必须与图谱节点 id 同一命名空间。
    // 布局坐标视为稳定输入：同一 layout 对象的多次渲染必须得到完全相同的节点位置。
    // 若在此加入随机扰动或碰撞修正，缩放/重置后节点会漂移，破坏用户的空间记忆。
    // 坐标对象直接引用 layout 中的值，不克隆不改写，避免与共享布局单例脱钩。
    const positions = new Map(layout.nodes.map((node) => [node.id, node.position]));
    // [资源] 空图时 flatMap 返回空数组，画布渲染空白、工具栏计数为 0，不另造空态分支。
    // 超大图靠 onlyRenderVisibleElements + minZoom 0.04 + 固定尺寸节点控制渲染量，不在数据层裁剪。
    // 用 flatMap 而非 map：布局缺失的节点返回空数组即可剔除，无需二次 filter。
    // 坐标缺失即跳过，避免落到 (0,0) 与首节点重叠，把「未布局」误读成结构关系。
    // 此处不排序节点：顺序变化会让 React Flow 复用错误的实例，选中态串位。
    return graph.nodes.flatMap((node) => {
      const position = positions.get(node.id);
      // 布局缺失的节点直接跳过，避免渲染到 (0,0) 与其他节点重叠。
      if (!position) {
        return [];
      }
      const searchMatch = normalizedQuery ? matchingNodeIds.has(node.id) : false;
      return [
        {
          id: node.id,
          type: "feature-boundary-node",
          position,
          style: {
            width: FEATURE_BOUNDARY_NODE_WIDTH,
            height: FEATURE_BOUNDARY_NODE_HEIGHT,
          },
          data: {
            node,
            selected: selection === node.id,
            searchMatch,
            dimmed:
              (Boolean(selection) && !connectedNodeIds.has(node.id)) ||
              (Boolean(normalizedQuery) && !searchMatch),
          },
          draggable: false,
          selectable: true,
        },
      ];
    });
  }, [connectedNodeIds, layout, matchingNodeIds, normalizedQuery, selection]);

  // 边 id 与布局侧保持同一回退规则；箭头尺寸随高亮变化，其余样式沿用全局默认。
  // [契约] 边 id 与布局、详情侧共用同一回退规则（edge.id ?? 序号），保证同一条边身份一致。
  // source/target 与 handle 名必须能在 flowNodes 中找到对应节点与 Handle，否则边静默丢失。
  // 箭头尺寸随高亮变化属于展示态，不改变拓扑；selectable 恒为 false，选中只由节点驱动。
  // visibleEdges 是唯一输入，flowEdges 不再按搜索裁剪，避免出现两套可见性规则。
  // 标签只在 highlighted 时开启，防止全图标签互相遮挡拖慢超大图渲染。
  const flowEdges = useMemo<FeatureBoundaryFlowEdge[]>(
    () =>
      visibleEdges.map((edge, index) => {
        const edgeId = edge.id ?? `edge-${index}`;
        const highlighted =
          Boolean(selection) && (edge.from === selection || edge.to === selection);
        return {
          id: edgeId,
          type: "feature-boundary-edge",
          source: edge.from,
          sourceHandle: "source",
          target: edge.to,
          targetHandle: "target",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--color-foreground-subtlest)",
            height: highlighted ? 16 : 12,
            width: highlighted ? 16 : 12,
          },
          data: {
            edge,
            highlighted,
            dimmed: Boolean(selection) && !highlighted,
            showLabel: highlighted,
          },
          selectable: false,
        };
      }),
    [selection, visibleEdges],
  );

  useEffect(() => {
    // 布局未就绪时无可适配内容，等 layout 落地后再触发。
    if (!layout) {
      return;
    }
    // 等一帧再 fitView，确保 React Flow 已完成节点测量，否则缩放范围计算不准。
    window.requestAnimationFrame(() => {
      void fitView({ duration: 220, maxZoom: 0.82, padding: 0.08 });
    });
  }, [fitView, layout]);

  // 重置同时清空三类交互状态并重新适配视图，保证与初次进入时的视觉一致。
  // [权衡] 重置只清三态并重新 fitView，不重建 graph/layout，也不接管 React Flow 的缩放实现。
  // fitView 走 requestAnimationFrame：等节点测量完成再适配，缩放范围才包含真实尺寸。
  // 缩放与平移始终是视图操作，改动只落在 React Flow 内部视口，源图与坐标不被修改。
  // maxZoom 0.82 与 padding 0.08 在两处（fitViewOptions 与此处）保持一致，避免首屏与重置跳变。
  // 重置不清空布局错误：失败态下画布不渲染，重试只能靠刷新，避免给出可重试的错觉。
  const clear = useCallback(() => {
    setQuery("");
    setRankFilter("all");
    setSelection(null);
    window.requestAnimationFrame(() => {
      void fitView({ duration: 220, maxZoom: 0.82, padding: 0.08 });
    });
  }, [fitView]);

  // 布局失败即整页降级，避免在无坐标状态下渲染空画布让用户误以为图谱为空。
  // [失败路径] 布局失败整页降级：宁可显示明确错误，也不渲染空画布让人误判图谱为空。
  // 降级分支不读 layout 与图谱统计，避免在故障路径上引入新的失败点。
  // 错误文案前缀固定便于检索，原始 message 原样透出，不截断不脱敏处理内容。
  // 该分支位于 hook 调用之后、JSX 之前，保证 hooks 调用顺序在两种视图态下一致。
  // 恢复方式只有重新加载（布局是模块级 Promise），此处不提供重试按钮。
  if (error) {
    return (
      <main className="p-4">
        <div className="rounded-lg border border-warning/35 bg-card p-4 text-ui-base text-foreground">
          Feature boundary 图谱布局失败：{error}
        </div>
      </main>
    );
  }

  return (
    <main className="grid gap-4 px-4 py-4">
      <FeatureBoundaryToolbar
        matchingCount={normalizedQuery ? matchingNodeIds.size : graph.nodes.length}
        onQueryChange={setQuery}
        onRankFilterChange={setRankFilter}
        onReset={clear}
        query={query}
        rankFilter={rankFilter}
      />
      <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="feature-boundary-graph-canvas min-w-0 overflow-hidden rounded-lg border border-card-border bg-card">
          {layout ? (
            <ReactFlow<FeatureBoundaryFlowNode, FeatureBoundaryFlowEdge>
              defaultEdgeOptions={{ type: "feature-boundary-edge" }}
              edges={flowEdges}
              edgeTypes={featureBoundaryEdgeTypes}
              fitView
              fitViewOptions={{ maxZoom: 0.82, padding: 0.08 }}
              maxZoom={2.4}
              minZoom={0.04}
              nodeTypes={featureBoundaryNodeTypes}
              nodes={flowNodes}
              nodesConnectable={false}
              nodesDraggable={false}
              onlyRenderVisibleElements
              onNodeClick={(_event, node) => setSelection(node.id)}
              onPaneClick={() => setSelection(null)}
              panOnDrag
              panOnScroll={false}
              proOptions={{ hideAttribution: true }}
              zoomOnScroll
            >
              <Background color="var(--color-border)" gap={24} size={1} />
              <Controls fitViewOptions={{ maxZoom: 0.82, padding: 0.08 }} showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="grid h-full min-h-[720px] place-items-center text-ui-base text-foreground-subtle">
              正在计算 feature boundary 布局…
            </div>
          )}
        </div>
        <FeatureBoundaryDetail
          graph={graph}
          rankFilter={rankFilter}
          selection={selection}
          onSelectNode={setSelection}
        />
      </section>
    </main>
  );
}

// 工具栏：query 与 rankFilter 都是受控输入，只把 onQueryChange/onRankFilterChange 回传画布；
// matchingCount 是画布派生的匹配数，此处只展示不重复计算。
function FeatureBoundaryToolbar({
  matchingCount,
  onQueryChange,
  onRankFilterChange,
  onReset,
  query,
  rankFilter,
}: {
  matchingCount: number;
  onQueryChange: (query: string) => void;
  onRankFilterChange: (rank: FeatureBoundaryRelationRank | "all") => void;
  onReset: () => void;
  query: string;
  rankFilter: FeatureBoundaryRelationRank | "all";
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
        <label className="relative min-w-0 flex-1">
          <span className="mb-1 block text-ui-sm font-medium text-foreground-subtle">查找节点</span>
          <Search className="pointer-events-none absolute bottom-2 left-2.5 size-4 text-foreground-subtlest" />
          <input
            className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-mobile-input-safe text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused md:text-ui-base"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="例如：模型选择、workspace identity、MCP"
            type="search"
            value={query}
          />
          <span className="mt-1 block text-ui-xs text-foreground-subtlest">
            {matchingCount} 个匹配节点 · {graphStats.nodeCount} 个节点 · {graphStats.edgeCount} 条边
          </span>
        </label>
        <label className="min-w-48">
          <span className="mb-1 flex items-center gap-1 text-ui-sm font-medium text-foreground-subtle">
            <Filter className="size-3.5" />
            关系等级
          </span>
          <select
            className="h-8 w-full rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground outline-none focus:border-input-border-focused focus:bg-input-focused"
            onChange={(event) =>
              onRankFilterChange(event.target.value as FeatureBoundaryRelationRank | "all")
            }
            value={rankFilter}
          >
            {rankOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-ui-sm text-foreground hover:bg-surface-hover"
          onClick={onReset}
          type="button"
        >
          <RotateCcw className="size-3.5" />
          重置
        </button>
      </div>
    </section>
  );
}

// 详情侧栏：无选中时展示图谱统计与操作提示；选中节点时展示出/入边、文档、代码种子与不变量。
// selection 指向不存在的节点时返回 null（不渲染），避免抛出；relation 列表可沿图切换选中。
// [失败路径] 详情是纯展示组件：接收 graph/selection/rankFilter，不持状态、不触发取数。
// selection 为 null 时保留侧栏骨架并展示统计，避免点击/取消导致右侧列宽跳变。
// 选中 id 不存在时返回 null 而非兜底文案，防止数据热更新后显示空字段。
// 出/入边列表直接过滤 currentGraph，不依赖画布可见边：详情要完整关系，画布要筛选视图。
// 统计值来自模块级 graphStats，与当前选中无关，避免每次点击重算全图。
function FeatureBoundaryDetail({
  graph: currentGraph,
  onSelectNode,
  rankFilter,
  selection,
}: {
  graph: FeatureBoundaryGraph;
  onSelectNode: (nodeId: string | null) => void;
  rankFilter: FeatureBoundaryRelationRank | "all";
  selection: string | null;
}) {
  if (!selection) {
    // 空选中态保留侧栏骨架并展示统计，避免点击/取消时右侧布局宽度跳变。
    return (
      <aside className="self-start rounded-lg border border-card-border bg-card p-4 xl:sticky xl:top-20">
        <div className="flex items-center gap-2 text-brand">
          <Network className="size-4" />
          <span className="text-ui-sm font-medium">Feature boundary graph</span>
        </div>
        <h2 className="mt-2 text-ui-lg font-medium">选择一个节点</h2>
        <p className="mt-2 text-ui-base leading-6 text-foreground-subtle">
          图谱来自 feature-boundary-planner 的 YAML。点击节点突出一阶关系，滚轮缩放，拖拽平移。
        </p>
        <div className="mt-4 grid gap-2 border-t border-border pt-3 text-ui-sm">
          <DetailFact label="声明节点" value={`${graphStats.nodeCount} 个`} />
          <DetailFact label="语义边" value={`${graphStats.edgeCount} 条`} />
          <DetailFact label="未声明端点" value={`${graphStats.unresolvedEndpointCount} 个`} />
          <DetailFact
            label="当前关系筛选"
            value={rankOptions.find(([value]) => value === rankFilter)?.[1] ?? "全部关系"}
          />
        </div>
      </aside>
    );
  }

  // [失败路径] 查不到节点即静默不渲染：选中 id 可能来自旧数据，不能假设一定存在。
  // 此处不回退到首个节点，避免用户的选择被悄悄替换成别的节点。
  // directEdges 在节点存在后才计算，保证空选与失效选两条路径都不会产生无意义遍历。
  // 若把该分支改成抛错，图谱热更新会让整个详情区崩溃而不是局部消失。
  // 节点对象取自模块级索引，与画布 flowNodes 中的 data.node 是同一引用，展示不会分叉。
  const node = graphNodeById.get(selection);
  // 选中 id 已不在图谱中（如数据热更新后）时静默不渲染，避免详情显示空字段。
  if (!node) {
    return null;
  }
  const directEdges = currentGraph.edges.filter(
    (edge) => edge.from === selection || edge.to === selection,
  );
  const renderList = (items: string[], emptyLabel = "—") =>
    items.length ? (
      <ul className="mt-1 grid gap-1 pl-4 text-ui-sm text-foreground-subtle">
        {items.map((item) => (
          <li className="break-words" key={item}>
            <code>{item}</code>
          </li>
        ))}
      </ul>
    ) : (
      <p className="mt-1 text-ui-sm text-foreground-subtlest">{emptyLabel}</p>
    );

  return (
    <aside
      aria-live="polite"
      className="self-start rounded-lg border border-card-border bg-card p-4 xl:sticky xl:top-20"
    >
      <div className="text-ui-sm font-medium text-brand">
        {featureBoundaryNodeKindLabels[node.kind]}
      </div>
      <h2 className="mt-2 text-ui-lg font-medium text-foreground">{node.label}</h2>
      <p className="mt-1 break-words font-mono text-ui-xs text-foreground-subtlest">{node.id}</p>
      <p className="mt-2 text-ui-sm text-foreground-subtle">{directEdges.length} 条直接关系</p>
      <div className="mt-4 grid gap-3">
        <DetailFact label="别名" value={node.aliases.length ? node.aliases.join("、") : "—"} />
        <DetailBlock label="出边">
          <RelationList
            edges={directEdges.filter((edge) => edge.from === selection)}
            onSelectNode={onSelectNode}
            direction="out"
          />
        </DetailBlock>
        <DetailBlock label="入边">
          <RelationList
            edges={directEdges.filter((edge) => edge.to === selection)}
            onSelectNode={onSelectNode}
            direction="in"
          />
        </DetailBlock>
        <DetailBlock label="文档">{renderList(node.docs)}</DetailBlock>
        <DetailBlock label="代码种子">{renderList(node.codeSeeds)}</DetailBlock>
        <DetailBlock label="不变量">
          {node.invariants.length ? (
            <ul className="mt-1 grid gap-1 pl-4 text-ui-sm text-foreground-subtle">
              {node.invariants.map((invariant) => (
                <li className="break-words" key={invariant}>
                  {invariant}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-ui-sm text-foreground-subtlest">—</p>
          )}
        </DetailBlock>
      </div>
    </aside>
  );
}

// 关系列表：direction 决定展示对端（out 取 to，in 取 from），对端不存在时回退显示原始 id；
// 点击任意关系即把选中切到对端（onSelectNode），形成沿图游走。
// 圆点颜色按 rank 区分：must-inspect 用品牌色、evidence-only 弱化，其余用警示色。
function RelationList({
  direction,
  edges,
  onSelectNode,
}: {
  direction: "in" | "out";
  edges: FeatureBoundaryEdge[];
  onSelectNode: (nodeId: string) => void;
}) {
  if (!edges.length) {
    // 空列表用「—」占位，保持 RelationList 与详情分区的行高一致。
    return <p className="mt-1 text-ui-sm text-foreground-subtlest">—</p>;
  }
  return (
    <div className="mt-1 grid gap-1">
      {edges.map((edge, index) => {
        const otherId = direction === "out" ? edge.to : edge.from;
        const otherNode = graphNodeById.get(otherId);
        return (
          <button
            className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)] gap-2 rounded-md px-1 py-1.5 text-left hover:bg-menu-hover"
            key={edge.id ?? `${edge.from}-${edge.to}-${edge.type}-${index}`}
            onClick={() => onSelectNode(otherId)}
            type="button"
          >
            <i
              aria-hidden="true"
              className={`mt-1 size-2.5 rounded-full ${
                edge.rank === "must-inspect"
                  ? "bg-brand"
                  : edge.rank === "evidence-only"
                    ? "bg-foreground-subtlest"
                    : "bg-warning"
              }`}
            />
            <span className="min-w-0">
              <span className="block break-words text-ui-sm font-medium text-foreground">
                {direction === "out" ? "→" : "←"} {otherNode?.label ?? otherId}
              </span>
              <span className="mt-0.5 block break-words font-mono text-ui-xs text-foreground-subtlest">
                {edge.type}
                {edge.rank ? ` · ${edge.rank}` : ""}
              </span>
              {edge.condition ? (
                <span className="mt-0.5 block break-words text-ui-xs text-foreground-subtlest">
                  {edge.condition}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// DetailBlock 只做标题与上分隔线的布局，不读取任何 graph 数据。
function DetailBlock({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="border-t border-border pt-3">
      <h3 className="text-ui-sm font-medium text-foreground">{label}</h3>
      {children}
    </section>
  );
}

// 键值展示行：label 为口径名，value 已由调用方格式化，组件不做空值转换。
function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-border pt-3">
      <p className="text-ui-xs text-foreground-subtlest">{label}</p>
      <p className="mt-1 break-words text-ui-sm text-foreground">{value}</p>
    </div>
  );
}

// 页面入口：画布内部使用 useReactFlow 获取 fitView，因此必须由 ReactFlowProvider 包裹。
// 本组件只做 Provider 装配，不持有业务状态。
export default function FeatureBoundaryGraphView() {
  return (
    <ReactFlowProvider>
      <FeatureBoundaryGraphCanvas />
    </ReactFlowProvider>
  );
}
