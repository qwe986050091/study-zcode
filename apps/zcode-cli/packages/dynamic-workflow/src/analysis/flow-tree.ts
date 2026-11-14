import type { OrderEvent, OrderRegion, OrderTrace } from "./causality-order.js";

/**
 * The trace's leaf stream re-read as the STRUCTURED CONTROL TREE that the control-flow
 * projection (flow-graph.ts) recurses over: regions are the inner nodes, events the
 * leaves, and every leaf sits in the innermost region of its own `regions` chain.
 *
 * Children are ordered by first leaf, which is the evaluation order the walk recorded. A
 * region holding no leaf sorts last among its siblings: it cannot affect the flow (an
 * empty region passes control straight through), only its EXISTENCE can (an empty `catch`
 * still catches).
 *
 * Its own file because flow-graph.ts sits at the 400-line cap and the tree is the one part
 * of it that owes nothing to the flow recursion. Like its siblings it must not import
 * `typescript`, and nothing here reaches the package barrels — flow-graph.ts is the only
 * consumer.
 */

// 控制树的内节点：包住一个 OrderRegion，children 是它的子区域与直属叶子。
// first 是子树里最小叶子下标（无叶子时 Infinity），父级排序只读这个缓存，不再重走子树。
// 无副作用、不可变输入；这里不碰 AST，只读 trace 的纯数据。
export interface RegionNode {
  type: "region";
  region: OrderRegion;
  children: TreeNode[];
  /** Index of the first leaf in this subtree; Infinity when it holds none. */
  first: number;
}

// 控制树的叶子：一个 OrderEvent（issue/mark/jump/settle/spawn）加它在 events 里的下标。
// index 既是排序键，也是"求值顺序"的唯一口径；不复制事件内容，引用 trace 里的原对象。
// 节点只存引用与下标，不复制事件字段；因此树的形状与 trace 始终一一对应。
export interface LeafNode {
  type: "leaf";
  event: OrderEvent;
  index: number;
}

// 树节点判别联合：type 是唯一判别式，region 分支有 children，leaf 分支带事件下标。
// 判别用 type 字段在编译期可收窄；运行时不额外校验，调用方负责构造合法节点。
export type TreeNode = RegionNode | LeafNode;

// 从叶子流重建控制树，返回 root 与按 region id 索引的 byId（flow-graph 用它解析跳转目标
// 和祖先链）。前置条件：trace.root 必须出现在 trace.regions 里，否则取 root 后断言失败；
// 空 regions 的 trace 不在本函数契约内。区域无叶子时 first 保持 Infinity，排序自然靠后。
// 纯内存操作：不改写 trace，不改写传入的 region/event 对象（只新建节点并挂接引用）。
/** Rebuild the tree from the leaf stream, and index every region by id. */
export function buildTree(trace: OrderTrace): { root: RegionNode; byId: Map<string, RegionNode> } {
  const byId = new Map<string, RegionNode>();
  for (const region of trace.regions) {
    byId.set(region.id, { children: [], first: Number.POSITIVE_INFINITY, region, type: "region" });
  }
  // 顶层 region（root）没有 parent，不参与挂接；它只经 byId 暴露。
  for (const region of trace.regions) {
    if (region.parent === undefined) continue;
    byId.get(region.parent)?.children.push(byId.get(region.id) as RegionNode);
  }
  trace.events.forEach((event, index) => {
    // 事件归属 regions 链最内层；空链（顶层事件）回落到 root。
    const home = event.regions[event.regions.length - 1] ?? trace.root;
    byId.get(home)?.children.push({ event, index, type: "leaf" });
  });
  // Bottom-up: each child is ordered (and its `first` cached) BEFORE the parent sorts, so
  // the comparator reads a number instead of re-walking the subtree. A comparator that
  // called `order(child)` itself would re-sort and re-walk the whole subtree on every
  // comparison — exponential in nesting depth (a 2,500-region trace of inlined helpers
  // took 45 s before the projection had produced a single edge).
  const firstOf = (node: TreeNode): number => (node.type === "leaf" ? node.index : node.first);
  const order = (node: TreeNode): number => {
    if (node.type === "leaf") return node.index;
    for (const child of node.children) node.first = Math.min(node.first, order(child));
    node.children.sort((a, b) => firstOf(a) - firstOf(b));
    return node.first;
  };
  const root = byId.get(trace.root) as RegionNode;
  order(root);
  return { byId, root };
}
