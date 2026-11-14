import { Background, Controls, ReactFlow } from "@xyflow/react";
import {
  capabilityMapEdgeTypes,
  capabilityMapNodeTypes,
} from "@/capability-map/CapabilityMapFlowElements.js";
import type {
  CapabilityFlowEdge,
  CapabilityFlowNode,
} from "@/capability-map/capabilityMapTypes.js";

// 能力地图画布外壳：负责 React Flow 的挂载、节点/边类型注册与基础交互，不参与数据推导。
// 入参 nodes/edges 均为上层已算好的扁平数组（含 parentId 层级），本组件只做渲染；
// layoutReady=false 时渲染"正在计算 ELK 布局"占位，避免在无坐标情况下闪出零尺寸节点。
// onNodeClick 按节点 type 分发到 onSelectGroup / onSelectNode，未知 type 静默忽略；
// onPaneClick 等价于清空选择，由上层决定是否保留当前视口（本组件不做 fitView）。
export function CapabilityMapGraph({
  edges,
  layoutReady,
  nodes,
  onPaneClick,
  onSelectGroup,
  onSelectNode,
}: {
  edges: CapabilityFlowEdge[];
  layoutReady: boolean;
  nodes: CapabilityFlowNode[];
  onPaneClick: () => void;
  onSelectGroup: (groupId: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="capability-map-canvas min-w-0 overflow-hidden rounded-lg border border-card-border bg-card">
      {layoutReady ? (
        // 只有拿到 ELK 坐标后才挂载 ReactFlow；fitView 依赖节点已有真实宽高。
        <ReactFlow<CapabilityFlowNode, CapabilityFlowEdge>
          defaultEdgeOptions={{ type: "capability-edge" }}
          edges={edges}
          edgeTypes={capabilityMapEdgeTypes}
          fitView
          fitViewOptions={{ maxZoom: 0.8, padding: 0.08 }}
          maxZoom={2.4}
          minZoom={0.08}
          nodeTypes={capabilityMapNodeTypes}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          onlyRenderVisibleElements
          onNodeClick={(_event, node) => {
            if (node.type === "capability-group") {
              onSelectGroup(node.data.group.id);
            } else if (node.type === "capability-item") {
              onSelectNode(node.data.capability.id);
            }
          }}
          onPaneClick={onPaneClick}
          // 交互约定：滚轮缩放，平移只通过拖拽；panOnScroll 会吞掉滚轮缩放。
          panOnDrag
          panOnScroll={false}
          proOptions={{ hideAttribution: true }}
          zoomOnScroll
        >
          <Background color="var(--color-border)" gap={24} size={1} />
          <Controls
            fitViewOptions={{ maxZoom: 0.8, padding: 0.08 }}
            position="top-right"
            showInteractive={false}
          />
        </ReactFlow>
      ) : (
        <div className="grid h-full place-items-center text-ui-base text-foreground-subtle">
          正在计算 ELK 复合群组布局…
        </div>
      )}
    </div>
  );
}
