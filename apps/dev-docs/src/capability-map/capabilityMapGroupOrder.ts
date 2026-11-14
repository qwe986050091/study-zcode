import {
  capabilityEdges,
  capabilityGroups,
  capabilityNodes,
} from "@/data/productCapabilityMap.js";

// 能力群在所属顶层区域内的排列顺序：用跨群连线的对称权重做贪心聚类，
// 让关系密集的群彼此相邻，降低 ELK rectpacking 之后的连线交叉与折返。
// 纯计算、无副作用；输入为静态数据，输出仅包含该区域内的群 id 数组。
const capabilityNodeById = new Map(
  capabilityNodes.map((node) => [node.id, node]),
);
const capabilityGroupById = new Map(
  capabilityGroups.map((group) => [group.id, group]),
);
const capabilityGroupOrder = new Map(
  capabilityGroups.map((group, index) => [group.id, index]),
);

// 构建区域内群之间的无向权重图：每条跨群边在正反两个方向各 +1，
// 只统计两端同属 systemId 且群 id 不同的边，跨区域关系不参与本区域排序。
function buildGroupRelationWeights(systemId: string) {
  const systemGroups = capabilityGroups.filter(
    (group) => group.systemId === systemId,
  );
  const weights = new Map(
    systemGroups.map((group) => [group.id, new Map<string, number>()]),
  );
  for (const edge of capabilityEdges) {
    const sourceGroupId = capabilityNodeById.get(edge.source)?.groupId;
    const targetGroupId = capabilityNodeById.get(edge.target)?.groupId;
    if (
      !sourceGroupId ||
      !targetGroupId ||
      sourceGroupId === targetGroupId ||
      capabilityGroupById.get(sourceGroupId)?.systemId !== systemId ||
      capabilityGroupById.get(targetGroupId)?.systemId !== systemId
    ) {
      // 端点缺群、同群、或任一端不在本区域时跳过：这类边不参与本区域内的邻近度计算。
      continue;
    }
    const sourceWeights = weights.get(sourceGroupId);
    const targetWeights = weights.get(targetGroupId);
    sourceWeights?.set(
      targetGroupId,
      (sourceWeights.get(targetGroupId) ?? 0) + 1,
    );
    targetWeights?.set(
      sourceGroupId,
      (targetWeights.get(sourceGroupId) ?? 0) + 1,
    );
  }
  return weights;
}

// 加权度数 = 与全部邻居的边权和；缺少该群条目时按 0 处理，用于在直接权重相同时比较整体活跃度。
function getWeightedDegree(
  groupId: string,
  relationWeights: Map<string, Map<string, number>>,
) {
  return [...(relationWeights.get(groupId)?.values() ?? [])].reduce(
    (sum, weight) => sum + weight,
    0,
  );
}

// 排序规则优先级：与当前群之间的直接权重降序 → 加权度数降序 → 数据原始顺序升序。
// currentId 缺省时只按后两级比较，用于选出首个种子群。
function compareGroupIds(
  leftId: string,
  rightId: string,
  relationWeights: Map<string, Map<string, number>>,
  currentId?: string,
) {
  const currentWeights = currentId
    ? relationWeights.get(currentId)
    : undefined;
  const directDifference =
    (currentWeights?.get(rightId) ?? 0) -
    (currentWeights?.get(leftId) ?? 0);
  if (directDifference !== 0) {
    return directDifference;
  }
  const degreeDifference =
    getWeightedDegree(rightId, relationWeights) -
    getWeightedDegree(leftId, relationWeights);
  if (degreeDifference !== 0) {
    return degreeDifference;
  }
  return (
    // 未登记的顺序索引兜底为 MAX_SAFE_INTEGER：位置靠后但彼此比较相等，保证排序稳定。
    (capabilityGroupOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
    (capabilityGroupOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER)
  );
}

// 返回 systemId 下全部能力群 id 的排列结果；该区域没有群或 systemId 不存在时返回空数组。
// 算法：外层每次从未访问集合里挑一个"最核心"的种子（加权度数最高），
// 内层用 BFS 逐个吸收种子的一阶邻居，使同一关系簇在输出中连续。
// 输出不含重复 id，顺序与数据原始顺序仅在权重完全相同时才一致。
export function orderGroupsByRelations(systemId: string) {
  const systemGroupIds = capabilityGroups
    .filter((group) => group.systemId === systemId)
    .map((group) => group.id);
  const relationWeights = buildGroupRelationWeights(systemId);
  const remaining = new Set(systemGroupIds);
  const ordered: string[] = [];

  // 外层循环用于多个互不相连的关系簇：每个簇单独重新挑种子，避免只覆盖最大连通分量。
  while (remaining.size > 0) {
    const seed = [...remaining].sort((leftId, rightId) =>
      compareGroupIds(leftId, rightId, relationWeights),
    )[0];
    if (!seed) {
      // remaining 非空时理论必有种子；此处仅防御数组取值返回 undefined 的边界情况。
      break;
    }
    remaining.delete(seed);
    const queue = [seed];
    // 内层 BFS：入队即视为已访问，出队时直接追加到结果，保证每个群只出现一次。
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) {
        continue;
      }
      ordered.push(currentId);
      const neighbors = [...(relationWeights.get(currentId)?.keys() ?? [])]
        .filter((groupId) => remaining.has(groupId))
        .sort((leftId, rightId) =>
          compareGroupIds(
            leftId,
            rightId,
            relationWeights,
            currentId,
          ),
        );
      for (const neighborId of neighbors) {
        // 先移出 remaining 再入队：同一群不会被两个邻居重复排队，也不会重复输出。
        remaining.delete(neighborId);
        queue.push(neighborId);
      }
    }
  }

  return ordered;
}
