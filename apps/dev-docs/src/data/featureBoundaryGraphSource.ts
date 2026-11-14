// 图谱数据规范化层：把 YAML 解析出的 unknown 收敛为 FeatureBoundaryGraph，供 Vite 插件序列化注入。
// 原则是"尽量降级、不中断构建"：非法节点/边整条丢弃，缺省字段回退到安全值；
// 唯一硬失败是顶层缺少 nodes/edges 数组，说明数据源已损坏。
import type { FeatureBoundaryGraph, FeatureBoundaryNode } from "@/data/featureBoundaryGraph.js";

// 以下三个读取器只做类型收敛：非目标类型一律回退默认值，保证规范化结果字段必有值。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// 规范化入口：节点缺少 id 或边缺少 from/to 时整条丢弃（无法参与布局与连线）；
// 节点 kind 不做白名单校验，由类型断言承担，YAML 侧需自行保证取值合法；
// 边引用的未声明端点会补 kind=unresolved 占位节点，并按 id 排序以保证多次构建产物稳定。
// 纯函数，无 IO；返回新对象，不修改入参。
export function normalizeFeatureBoundaryGraph(value: unknown): FeatureBoundaryGraph {
  // 顶层结构损坏时无法降级，直接抛出，让 Vite 启动/HMR 暴露数据源错误。
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("feature-boundary graph YAML 必须包含 nodes 和 edges 数组");
  }

  const nodes = value.nodes.flatMap((nodeValue) => {
    // 缺少稳定 id 的节点无法被边引用，丢弃比补占位更安全。
    if (!isRecord(nodeValue) || typeof nodeValue.id !== "string") {
      return [];
    }
    const codeSeeds = Array.isArray(nodeValue.codeSeeds)
      ? nodeValue.codeSeeds.flatMap((seedValue) => {
          // codeSeeds 支持 {file, symbol} 结构；无 file 的项无法定位，直接跳过。
          if (!isRecord(seedValue) || typeof seedValue.file !== "string") {
            return [];
          }
          const symbol = typeof seedValue.symbol === "string" ? `${seedValue.symbol} · ` : "";
          return [`${symbol}${seedValue.file}`];
        })
      : [];
    return [
      {
        id: nodeValue.id,
        kind: readString(nodeValue.kind, "unresolved") as FeatureBoundaryNode["kind"],
        label: readString(nodeValue.label, nodeValue.id),
        aliases: readStringArray(nodeValue.aliases),
        docs: readStringArray(nodeValue.docs),
        codeSeeds,
        invariants: readStringArray(nodeValue.invariants),
      },
    ];
  });

  const edges = value.edges.flatMap((edgeValue, index) => {
    // 缺端点的边无法布局，直接丢弃；索引仅用于生成稳定回退 id。
    if (
      !isRecord(edgeValue) ||
      typeof edgeValue.from !== "string" ||
      typeof edgeValue.to !== "string"
    ) {
      return [];
    }
    return [
      {
        id: `edge-${index}`,
        from: edgeValue.from,
        to: edgeValue.to,
        type: readString(edgeValue.type, "related-to"),
        ...(typeof edgeValue.rank === "string"
          ? { rank: edgeValue.rank as FeatureBoundaryGraph["edges"][number]["rank"] }
          : {}),
        ...(typeof edgeValue.condition === "string" ? { condition: edgeValue.condition } : {}),
      },
    ];
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const missingEndpointIds = new Set<string>();
  for (const edge of edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!nodeIds.has(endpoint)) {
        missingEndpointIds.add(endpoint);
      }
    }
  }
  for (const id of [...missingEndpointIds].sort()) {
    // 排序后再补齐，保证同一份 YAML 多次构建得到字节级一致的模块产物。
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

  return {
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    graphId: readString(value.graphId, "zcode-feature-relationships"),
    purpose: readString(value.purpose),
    nodes,
    edges,
  };
}
