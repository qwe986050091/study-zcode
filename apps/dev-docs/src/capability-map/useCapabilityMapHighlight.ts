import { useMemo } from "react";
import {
  capabilityNodes,
  type CapabilityEdge,
} from "@/data/productCapabilityMap.js";
import {
  nodeById,
  type CapabilitySelection,
} from "@/capability-map/capabilityMapTypes.js";

// 由当前选择推导画布高亮集合，纯计算、无副作用。
// 输入口径：selection 为 null 表示无选择；visibleEdges 已剔除被工具栏关系类型/范围过滤掉的连线。
// 输出口径：connectedNodeIds 为需保持常亮的节点（选中节点本身，或选中群的全部成员，再加高亮连线两端）；
// highlightedEdgeIds 为与选择直接相连的一阶关系连线 id。
// 空选择时两个集合均为空 Set（非 null），调用方可直接 has() 判断；
// 集合只在 selection 或可见边变化时重建，渲染层不应原地修改返回的 Set。
export function useCapabilityMapHighlight(
  selection: CapabilitySelection,
  visibleEdges: readonly CapabilityEdge[],
) {
  const highlightedEdgeIds = useMemo(() => {
    if (!selection) {
      // 无选择即不点亮任何连线；空集合也避免下游把 undefined 当作"全部高亮"。
      return new Set<string>();
    }
    return new Set(
      visibleEdges
        .filter((edge) => {
          if (selection.kind === "node") {
            return edge.source === selection.id || edge.target === selection.id;
          }
          return (
            nodeById.get(edge.source)?.groupId === selection.id ||
            nodeById.get(edge.target)?.groupId === selection.id
          );
        })
        .map((edge) => edge.id),
    );
  }, [selection, visibleEdges]);

  const connectedNodeIds = useMemo(() => {
    const connected = new Set<string>();
    if (!selection) {
      return connected;
    }
    if (selection.kind === "node") {
      connected.add(selection.id);
    } else {
      // 选群时把该群全部节点计入常亮；群内节点即便没有对外连线也应保持可见。
      for (const node of capabilityNodes) {
        if (node.groupId === selection.id) {
          connected.add(node.id);
        }
      }
    }
    // 高亮连线的两端节点一并点亮，保证选中节点的一阶邻居不被压暗。
    for (const edge of visibleEdges) {
      if (highlightedEdgeIds.has(edge.id)) {
        connected.add(edge.source);
        connected.add(edge.target);
      }
    }
    return connected;
  }, [highlightedEdgeIds, selection, visibleEdges]);

  return {
    connectedNodeIds,
    highlightedEdgeIds,
  };
}
