// INV-01 布局未就绪时 flowNodes 与 flowEdges 必须返回空数组；守住位置：两条 memo 内的 layout 空值短路；改错故障：按空坐标渲染，节点全部堆叠在左上角。
// INV-02 enabledRelations 初值必须由工厂函数懒创建；守住位置：enabledRelations 的 useState 初始化工厂；改错故障：多个挂载实例共享同一个可变 Set，勾选互相联动。
// INV-03 空关系集合表示不显示任何连线而非回退全部；守住位置：visibleEdges 内对 enabledRelations 的 has 判断；改错故障：全部取消勾选后仍显示满图连线，用户误以为筛选失效。
// INV-04 关系范围过滤仅跨群时按两端 groupId 不等判定；守住位置：visibleEdges 中的 edgeScope 分支；改错故障：同群内部边被错误保留或剔除，结果与图例不符。
// INV-05 压暗必须是选择态与搜索态的或关系；守住位置：system、group、item 三类节点的 dimmed 计算；改错故障：搜索时已压暗的节点重新点亮，视觉焦点丢失。
// INV-06 选中态只有 selection 一个真源；守住位置：setSelection 仅出现在 selectNode、selectGroup、clearHighlight、reset 四处；改错故障：派生布尔并发漂移，详情面板与画布高亮不一致。
// INV-07 节点选中前必须校验 id 存在于 nodeById；守住位置：selectNode 的 has 守卫；改错故障：脏 id 进入 selection，详情面板渲染空态并闪烁。
// INV-08 群选中同样需要 groupById 守卫；守住位置：selectGroup；改错故障：非法 groupId 覆盖合法选择，画布高亮突然整体恢复。
// INV-09 画布空白点击只能清空选择，不得重新取景；守住位置：clearHighlight 不复用 reset；改错故障：用户刚调整好的缩放与平移被抹掉。
// INV-10 reset 必须在下一帧再调用 fitView；守住位置：reset 内的 requestAnimationFrame 回调；改错故障：在旧布局尺寸上取景，重置后视野偏移。
// INV-11 flowEdges 必须始终覆盖全量关系，仅用 hidden 表达过滤；守住位置：capabilityEdges 的全量映射与 hidden 字段；改错故障：数组增删触发 React Flow 重建内部边状态，动画抖动。
// INV-12 边的 zIndex 必须按高亮、同群、跨群三档取值；守住位置：flowEdges 的 zIndex 三元表达式；改错故障：跨群长边压住同群短边，交叉处不可读。
// INV-13 无搜索词时命中集合必须为空 Set 而非全量；守住位置：matchingNodeIds 对 normalizedQuery 的早返回；改错故障：未搜索被判定为全部命中，选择态压暗逻辑失效。
// INV-14 搜索必须使用延迟值归一化后的结果；守住位置：normalizedQuery 由 useDeferredValue 派生；改错故障：大图逐字符同步过滤，输入明显卡顿。
// INV-15 布局 id 与静态数据不一致必须抛错而非渲染空框；守住位置：systems、groups、items 三处未知 id 分支；改错故障：界面出现无内容空区域，掩盖数据源错误。
// INV-16 节点层级必须用 parentId 加 extent 表达，zIndex 取 -1、1、3；守住位置：三类 flow node 的构造；改错故障：群框遮挡能力节点，或子节点脱离父容器。
// INV-17 布局错误必须整页替换，不渲染工具栏与画布；守住位置：顶层的 error 早返回分支；改错故障：无坐标空图与工具栏并存，用户反复点击无效操作。
// INV-18 重置与关系开关必须以新集合替换旧引用；守住位置：setEnabledRelations 的拷贝写入；改错故障：原地修改不触发重渲染，勾选无反应。
//
// 模块职责：能力地图主视图，把静态布局结果转换为 React Flow 的节点与边，并承载搜索、关系范围、关系类型与选中四类纯 UI 状态。
// 状态所有权：layout 与 error 归 useCapabilityMapLayout，高亮归 useCapabilityMapHighlight，本组件只拥有 query、edgeScope、enabledRelations、selection。
// 阅读顺序：先看四个 useState 与 normalizedQuery，再看 visibleEdges、matchingNodeIds、flowNodes、flowEdges 四条派生链，最后看回调与 error 早返回分支。
import "@xyflow/react/dist/style.css";
// 依赖面收敛：样式表、React 状态与派生 hook、React Flow 实例 API 都在文件头部一次性引入。
// 本文件不直接访问服务或存储，节点与关系的来源全部是 @/data/productCapabilityMap.js 的静态导出。
// 改错提示：新增状态时先复用已有的四个 useState，避免在同一视图里再开并行真源。
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { MarkerType, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import {
  capabilityEdges,
  capabilityNodes,
  type CapabilityRelationType,
} from "@/data/productCapabilityMap.js";
import {
  // 几何常量与节点尺寸同源：CAPABILITY_NODE_HEIGHT 与 WIDTH 只在 item 节点的 style 中使用，保证与布局算法算出的间距一致。
  // 改这两项必须同步调整 useCapabilityMapLayout 的测距口径，否则节点会溢出群框或留下大片空隙。
  // [权衡] 尺寸写死为常量而非从 DOM 测量，换取首帧即可定位，代价是不支持自适应内容高度。
  CAPABILITY_NODE_HEIGHT,
  CAPABILITY_NODE_WIDTH,
} from "@/capability-map/capabilityMapGeometry.js";
import { CapabilityMapDetail } from "@/capability-map/CapabilityMapDetail.js";
import { CapabilityMapGraph } from "@/capability-map/CapabilityMapGraph.js";
import { CapabilityMapToolbar } from "@/capability-map/CapabilityMapToolbar.js";
import { useCapabilityMapHighlight } from "@/capability-map/useCapabilityMapHighlight.js";
import { useCapabilityMapLayout } from "@/capability-map/useCapabilityMapLayout.js";
import {
  groupById,
  groupFlowNodeId,
  nodeById,
  relationColors,
  relationTypes,
  type CapabilityFlowEdge,
  type CapabilityFlowNode,
  type CapabilityGroupFlowNode,
  type CapabilityItemFlowNode,
  type CapabilitySelection,
  type CapabilitySystemFlowNode,
  type EdgeScope,
  systemById,
  systemFlowNodeId,
} from "@/capability-map/capabilityMapTypes.js";

// 能力地图的主容器：把布局结果（layout）转成 React Flow 的 nodes/edges，并集中维护
// 搜索词、关系范围、关系类型开关与选中态四类纯 UI 状态；不读写任何持久化数据。
// 派生口径：flowNodes 仅在 layout 就绪时生成，缺失数据直接抛错（属静态数据不一致）；
// flowEdges 始终覆盖全部关系，用 hidden 表达过滤结果，避免过滤时触发 React Flow 重建拓扑。
// 无选择时所有节点常亮；有选择时非一阶节点/边压暗；有搜索词时未命中节点压暗并叠加。
// 组件入口先取 React Flow 实例上下文，再读布局状态，最后声明四个局部状态，顺序即依赖顺序。
// 所有 hook 都位于 error 早返回之前，保证重渲染之间 hooks 调用次数恒定。
// [失败路径] 布局 Promise 在模块级启动，挂载后的首帧可能出现 error 为空且 layout 为空，该中间态由下游 layoutReady 与空数组兜底。
function CapabilityMapCanvas() {
  const { fitView } = useReactFlow<CapabilityFlowNode, CapabilityFlowEdge>();
  // layout 与 error 由 useCapabilityMapLayout 独占，本组件只读不写，不缓存也不重试。
  // [资源] 布局是模块级 Promise 的一次性结果，多次挂载不会重复计算。
  // [失败路径] error 只可能来自布局计算或静态数据不一致，一旦出现即走整页错误分支。
  // 改错故障：在此处给 layout 补默认值，会掩盖数据错误并让下游的抛错点失效。
  const { error, layout } = useCapabilityMapLayout();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [edgeScope, setEdgeScope] = useState<EdgeScope>("all");
  // selection 是选中态唯一真源，用判别联合区分 node 与 group，避免布尔组合产生非法状态。
  // 清空只能写 null，不接受空字符串或空对象占位。
  // 改错故障：额外维护 selectedId 之类的镜像字段，两处会在连续点击时不同步。
  const [selection, setSelection] = useState<CapabilitySelection>(null);
  // 初值必须由工厂函数创建独立 Set，避免多个实例共享同一个可变集合。
  const [enabledRelations, setEnabledRelations] = useState(
    () => new Set<CapabilityRelationType>(relationTypes),
  );
  // 搜索使用延迟值：输入框即时更新，过滤在低优先级渲染中执行，避免大图逐字符卡顿。
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();

  // 可见边 = 已勾选关系类型 + 范围过滤；"仅跨群"通过比较两端节点所属 groupId 判定。
  // 空集合（全部取消勾选）表示不显示任何连线，而非回退到"全部"。
  // visibleEdges 是唯一过滤口径，边的高亮与可见性集合都从它派生。
  // [权衡] 过滤在 memo 内完成而非渲染期逐条判断，代价是范围或勾选集变化时整表重算。
  // 改错故障：此处漏掉关系类型判断，flowEdges 会把被勾除的边重新显示出来。
  const visibleEdges = useMemo(
    () =>
      capabilityEdges.filter((edge) => {
        if (!enabledRelations.has(edge.type)) {
          return false;
        }
        return (
          edgeScope === "all" ||
          nodeById.get(edge.source)?.groupId !==
            nodeById.get(edge.target)?.groupId
        );
      }),
    [edgeScope, enabledRelations],
  );

  const { connectedNodeIds, highlightedEdgeIds } = useCapabilityMapHighlight(
    selection,
    visibleEdges,
  );

  // 搜索命中集合：无搜索词时返回空 Set（调用方据此区分"未搜索"与"搜索无结果"）。
  // 命中字段包含节点标签/范围/权威状态，以及所属群名/owner 与区域名，便于按维护方检索。
  // 命中字段覆盖节点自身与所属群、区域，让用户既能按能力名也能按 owner 检索。
  // 返回空 Set 表示未搜索，与搜索无结果在语义上区分，但当前 UI 表现一致。
  // 归一化统一走 trim 与 toLocaleLowerCase，与 normalizedQuery 的生成方式保持同一口径。
  // [并发] 依赖只有 normalizedQuery，输入变化经延迟值节流后才触发重算。
  const matchingNodeIds = useMemo(() => {
    if (!normalizedQuery) {
      return new Set<string>();
    }
    return new Set(
      capabilityNodes
        .filter((node) => {
          const group = groupById.get(node.groupId);
          const system = group ? systemById.get(group.systemId) : undefined;
          return [
            node.label,
            node.scope,
            node.authority,
            group?.name ?? "",
            group?.owner ?? "",
            system?.name ?? "",
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery);
        })
        .map((node) => node.id),
    );
  }, [normalizedQuery]);

  // 生成三类 React Flow 节点：区域框（zIndex -1）→ 群框（1）→ 能力节点（3），
  // 层级由 parentId/extent=parent 建立，React Flow 会按父子关系计算相对坐标。
  // dimmed 的判定：选择态下非一阶节点压暗；搜索态下未命中节点压暗；两者为"或"关系。
  // flowNodes 一次生成三类节点，顺序为 systems、groups、items，父节点必须先于子节点出现。
  // 所有节点固定 draggable 为 false，布局是静态的，拖拽会与取景逻辑冲突。
  // systems 不可选，groups 与 items 承担选中交互。
  // [失败路径] layout 为空时返回空数组，而不是抛错或渲染占位节点。
  const flowNodes = useMemo<CapabilityFlowNode[]>(() => {
    if (!layout) {
      return [];
    }
    const systems: CapabilitySystemFlowNode[] = layout.systems.map(
      (systemLayout) => {
        const system = systemById.get(systemLayout.id);
        if (!system) {
          // 布局 id 与数据源不一致属静态数据错误，直接抛出而非渲染空框。
          throw new Error(`未知顶层区域 ${systemLayout.id}`);
        }
        const systemNodeIds = capabilityNodes
          .filter((node) => groupById.get(node.groupId)?.systemId === system.id)
          .map((node) => node.id);
        const active =
          !selection ||
          systemNodeIds.some((nodeId) => connectedNodeIds.has(nodeId));
        const hasSearchMatch =
          !normalizedQuery ||
          systemNodeIds.some((nodeId) => matchingNodeIds.has(nodeId));
        return {
          id: systemFlowNodeId(system.id),
          type: "capability-system",
          position: systemLayout.position,
          style: {
            height: systemLayout.height,
            width: systemLayout.width,
            zIndex: -1,
          },
          data: {
            system,
            dimmed: !active || !hasSearchMatch,
          },
          draggable: false,
          selectable: false,
        };
      },
    );
    const groups: CapabilityGroupFlowNode[] = layout.groups.map(
      (groupLayout) => {
        const group = groupById.get(groupLayout.id);
        if (!group) {
          throw new Error(`未知能力群 ${groupLayout.id}`);
        }
        const groupNodeIds = capabilityNodes
          .filter((node) => node.groupId === group.id)
          .map((node) => node.id);
        const active =
          !selection ||
          groupNodeIds.some((nodeId) => connectedNodeIds.has(nodeId));
        const hasSearchMatch =
          !normalizedQuery ||
          groupNodeIds.some((nodeId) => matchingNodeIds.has(nodeId));
        return {
          id: groupFlowNodeId(group.id),
          type: "capability-group",
          parentId: systemFlowNodeId(group.systemId),
          extent: "parent",
          position: groupLayout.position,
          style: {
            height: groupLayout.height,
            width: groupLayout.width,
            zIndex: 1,
          },
          data: {
            group,
            selected: selection?.kind === "group" && selection.id === group.id,
            dimmed: !active || !hasSearchMatch,
          },
          draggable: false,
          selectable: true,
        };
      },
    );
    const items: CapabilityItemFlowNode[] = layout.nodes.map((nodeLayout) => {
      const capability = nodeById.get(nodeLayout.id);
      if (!capability) {
        // 缺少节点数据同样视为数据不一致；抛错可让布局失败面板统一暴露问题。
        throw new Error(`未知能力节点 ${nodeLayout.id}`);
      }
      const searchMatch = normalizedQuery
        ? matchingNodeIds.has(capability.id)
        : false;
      return {
        id: capability.id,
        type: "capability-item",
        parentId: groupFlowNodeId(nodeLayout.groupId),
        extent: "parent",
        position: nodeLayout.position,
        style: {
          height: CAPABILITY_NODE_HEIGHT,
          width: CAPABILITY_NODE_WIDTH,
          zIndex: 3,
        },
        data: {
          capability,
          selected:
            selection?.kind === "node" && selection.id === capability.id,
          searchMatch,
          dimmed:
            (Boolean(selection) && !connectedNodeIds.has(capability.id)) ||
            (Boolean(normalizedQuery) && !searchMatch),
        },
        draggable: false,
        selectable: true,
      };
    });
    return [...systems, ...groups, ...items];
  }, [connectedNodeIds, layout, matchingNodeIds, normalizedQuery, selection]);

  // 用 Set 做 O(1) 可见性判断：flowEdges 每条都要查一次，线性 includes 在数百条边上会明显变慢。
  // 把可见边 id 收成 Set，供 flowEdges 内每条边做常数时间判断。
  // [权衡] 多一次 Set 构造换掉数百次线性查找，边数越多收益越明显。
  // 改错故障：直接对 visibleEdges 做 includes，边数量上来后每次渲染都会明显变慢。
  const visibleEdgeIdSet = useMemo(
    () => new Set(visibleEdges.map((edge) => edge.id)),
    [visibleEdges],
  );

  // 边始终按全量关系生成，过滤只落到 hidden 标志：避免 React Flow 因 edges 数组增删重建内部状态。
  // zIndex：高亮边最高，同群内部边次之，跨群普通边最低，保证短连线不被群框遮挡。
  // flowEdges 只读 capabilityEdges 与 layout 的边路由表，不改写任何静态数据。
  // highlighted 决定箭头尺寸、zIndex 与标签可见性，dimmed 仅在选择态下成立。
  // showLabel 只在节点选择且边被高亮时打开，避免全图标签互相遮挡。
  const flowEdges = useMemo<CapabilityFlowEdge[]>(() => {
    if (!layout) {
      return [];
    }
    return capabilityEdges.map((edge) => {
      const highlighted = highlightedEdgeIds.has(edge.id);
      const sourceGroup = nodeById.get(edge.source)?.groupId;
      const targetGroup = nodeById.get(edge.target)?.groupId;
      return {
        id: edge.id,
        type: "capability-edge",
        source: edge.source,
        sourceHandle: "source",
        target: edge.target,
        targetHandle: "target",
        hidden: !visibleEdgeIdSet.has(edge.id),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: relationColors[edge.type],
          height: highlighted ? 17 : 13,
          width: highlighted ? 17 : 13,
        },
        zIndex: highlighted ? 4 : sourceGroup === targetGroup ? 3 : 1,
        data: {
          capability: edge,
          route: layout.edgeRoutes.get(edge.id),
          highlighted,
          dimmed: Boolean(selection) && !highlighted,
          showLabel: selection?.kind === "node" && highlighted,
        },
        selectable: false,
      };
    });
  }, [highlightedEdgeIds, layout, selection, visibleEdgeIdSet]);

  // 选中前再做一次存在性校验：React Flow 的点击事件不保证 id 仍存在于静态数据中。
  const selectNode = useCallback((nodeId: string) => {
    if (nodeById.has(nodeId)) {
      setSelection({ kind: "node", id: nodeId });
    }
  }, []);

  // 群选择同理：groupId 未登记时保持原选择不变，避免详情面板出现空态闪烁。
  const selectGroup = useCallback((groupId: string) => {
    if (groupById.has(groupId)) {
      setSelection({ kind: "group", id: groupId });
    }
  }, []);

  const clearHighlight = useCallback(() => {
    // 修复原因：画布空白点击只表示取消当前高亮；复用完整重置会调用 fitView，
    // 抹掉用户刚调整好的缩放与平移视角。
    setSelection(null);
  }, []);

  // 重置会恢复全部默认筛选并重新 fitView；rAF 等待节点按新筛选完成布局后再取景，
  // 避免在旧尺寸上 fitView 导致重置后视野偏移。
  // reset 是唯一的全量重置路径，四项状态与取景一起恢复默认。
  // [资源] 取景放在下一帧，等 React Flow 按新筛选完成节点尺寸测量。
  // fitView 的 duration、maxZoom、padding 是固定口径，改动需同步检查移动端表现。
  // 改错故障：同步调用会读到旧节点边界，重置后视图停在错误位置。
  const reset = useCallback(() => {
    setQuery("");
    setSelection(null);
    setEdgeScope("all");
    setEnabledRelations(new Set(relationTypes));
    window.requestAnimationFrame(() => {
      void fitView({ duration: 220, maxZoom: 0.8, padding: 0.08 });
    });
  }, [fitView]);

  // 以新 Set 替换旧值触发重渲染；原地 add/delete 不会改变引用，React 无法感知更新。
  const toggleRelation = useCallback((type: CapabilityRelationType) => {
    setEnabledRelations((current) => {
      const next = new Set(current);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // error 分支是整体性失败，直接返回独立页面，不渲染工具栏、画布与详情。
  // [失败路径] 错误文案直接展示 error 内容，不吞掉原始信息。
  // 改错故障：若在错误态仍渲染画布，用户会看到无坐标空图并反复点击。
  if (error) {
    // 布局失败为整体性错误：直接替换整页，不渲染工具栏/画布，避免展示无坐标的空图。
    return (
      <main className="p-4">
        <div className="rounded-lg border border-warning/35 bg-card p-4 text-ui-base text-foreground">
          能力图布局失败：{error}
        </div>
      </main>
    );
  }

  return (
    // 正常态为工具栏加两栏区：左侧画布弹性，右侧详情固定 320px，xl 以下自动堆叠。
    // layoutReady 传 Boolean(layout)，画布据此区分空态与未就绪，不做额外判断。
    // 详情面板与工具栏共享同一份 edgeScope 与 enabledRelations，避免两处各自过滤。
    <main className="grid gap-4 px-4 py-4">
      <CapabilityMapToolbar
        edgeScope={edgeScope}
        enabledRelations={enabledRelations}
        onEdgeScopeChange={setEdgeScope}
        onQueryChange={setQuery}
        onReset={reset}
        onToggleRelation={toggleRelation}
        query={query}
      />
      <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <CapabilityMapGraph
          edges={flowEdges}
          layoutReady={Boolean(layout)}
          nodes={flowNodes}
          onPaneClick={clearHighlight}
          onSelectGroup={selectGroup}
          onSelectNode={selectNode}
        />
        <CapabilityMapDetail
          edgeScope={edgeScope}
          enabledRelations={enabledRelations}
          onSelectGroup={selectGroup}
          onSelectNode={selectNode}
          selection={selection}
        />
      </section>
    </main>
  );
}

// 能力地图对外的唯一入口：包一层 ReactFlowProvider 以提供 fitView 等实例上下文，
// 本组件无 props、不持有状态，挂载即开始等待模块级布局 Promise。
// 对外入口只做 Provider 包裹，不含任何状态与副作用。
// ReactFlowProvider 提供 fitView 等实例上下文，必须包住真正使用它的画布组件。
// 本组件无 props，数据源完全由静态模块决定，无法从外部注入。
// 改错故障：Provider 放到画布内部会让实例上下文为空，取景调用直接失败。
export default function CapabilityMapView() {
  return (
    <ReactFlowProvider>
      <CapabilityMapCanvas />
    </ReactFlowProvider>
  );
}
