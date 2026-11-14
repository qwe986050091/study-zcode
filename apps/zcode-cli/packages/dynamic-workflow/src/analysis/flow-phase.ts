import { UNPHASED_ID } from "./constants.js";
import type { OrderTrace } from "./causality-order.js";
import type { AnalysisCore } from "./core.js";
import {
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  type FlowEdge,
  type FlowHole,
  type FlowNode,
  type FlowPhase,
} from "./flow-graph.js";

/**
 * The phase quotient of the control-flow graph — the control-flow counterpart of
 * phase-graph.ts (which quotients the CAUSALITY graph). Same vocabulary, same all-or-nothing
 * contract, different question: this one says where execution can go between phases.
 *
 * `alongside` is folded here too, but it is not an edge and so not part of the quotient:
 * it is the union of the mark nodes' own `alongside` lists, because a phase entered twice
 * with different strands running is entered alongside both.
 */

/** Phases some node carries, in first-reach order, {@link UNPHASED_ID} first when present. */
// 只收节点上真实出现的阶段：按 trace 的 phase 表顺序，UNPHASED_ID 排最前。
// alongside 取该阶段全部 mark 节点并集（剔除自身）并按同一顺序去重，空集时省略字段。
// 输出只含实际出现的阶段，不做"阶段表全量展开"；空 nodes 返回空数组。
export function collectFlowPhases(trace: OrderTrace, nodes: readonly FlowNode[]): FlowPhase[] {
  const present = new Set(nodes.map((node) => node.phase));
  const rank = new Map<string, number>(trace.phases.map((phase, index) => [phase.id, index + 1]));
  rank.set(UNPHASED_ID, 0);
  const at = (id: string): number => rank.get(id) ?? rank.size;
  const running = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (node.alongside === undefined) continue;
    const into = running.get(node.phase) ?? new Set<string>();
    for (const id of node.alongside) if (id !== node.phase) into.add(id);
    running.set(node.phase, into);
  }
  const alongsideOf = (id: string): { alongside?: string[] } => {
    const ids = [...(running.get(id) ?? [])].sort((a, b) => at(a) - at(b));
    return ids.length === 0 ? {} : { alongside: ids };
  };
  const out: FlowPhase[] = [];
  if (present.has(UNPHASED_ID)) out.push({ id: UNPHASED_ID, ...alongsideOf(UNPHASED_ID) });
  for (const phase of trace.phases) {
    if (present.has(phase.id)) {
      out.push({
        id: phase.id,
        loc: phase.loc,
        name: phase.name,
        ...alongsideOf(phase.id),
        ...(phase.fill === undefined ? {} : { fill: phase.fill }),
      });
    }
  }
  return out;
}

/**
 * The open holes for the display (docs/dynamic-workflow/presentation.md, `holes`), in source
 * order. `phase` is the phase of the hole's FIRST issue node — where it stands; a hole the
 * walk never reached (none in practice: the sweep issues every step) carries none.
 */
// 输出按 hole.order（源码顺序）排列；phase 取该留白第一个 issue 节点的阶段，
// 走查从未到达该留白时省略 phase 字段（显示层按"位置未知"处理）。
// tail 只对尾部形式的留白出现（脚本末尾开放）；纯投影，不排序外部集合、不产生副作用。
export function collectFlowHoles(core: AnalysisCore, nodes: readonly FlowNode[]): FlowHole[] {
  const phaseOf = new Map<string, string>();
  for (const node of nodes) {
    // 只记第一条 issue 的阶段：同一留白可能被多次到达（循环内），首次即"站位"。
    if (node.kind === "issue" && node.site !== undefined && !phaseOf.has(node.site)) {
      phaseOf.set(node.site, node.phase);
    }
  }
  return [...core.sites.holes]
    .sort((a, b) => a.order - b.order)
    .map((hole) => {
      const phase = phaseOf.get(hole.id);
      return {
        siteId: hole.id,
        name: hole.name,
        type: hole.type,
        ...(phase === undefined ? {} : { phase }),
        ...(hole.tail ? { tail: true as const } : {}),
      };
    });
}

/**
 * Each occurrence edge projected onto the phases of its endpoints. Same-phase edges dissolve
 * unless they are `loop` back edges (a loop living inside one phase is a self-loop);
 * terminals project to themselves. Kinds are kept apart — the renderer merges arrows, the
 * model does not. No transitive reduction: a CFG never is.
 */
// 把每条"实际发生"的边投影到两端所属的阶段：同阶段边消解（loop 回边除外，它保留为自环），
// 终点为 entry/sink/abort 的边原样投射到终点。kind 不合并（渲染层自己并箭头），也不做
// 传递约简。输出按 (from rank, to rank, kind, via) 规范化排序，重复边按同一键去重；
// rank 对未知 id 取兜底值排在最后，因此输入里出现非节点 id 也不会打乱顺序。
export function quotientFlow(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  phases: readonly FlowPhase[],
): FlowEdge[] {
  const phaseOf = new Map<string, string>(nodes.map((node) => [node.id, node.phase]));
  const rank = new Map<string, number>(phases.map((phase, index) => [phase.id, index]));
  rank.set(FLOW_ENTRY, -1);
  rank.set(FLOW_SINK, phases.length);
  rank.set(FLOW_ABORT, phases.length + 1);
  const at = (id: string): number => rank.get(id) ?? phases.length + 2;
  const seen = new Set<string>();
  const out: FlowEdge[] = [];
  for (const edge of edges) {
    const from = phaseOf.get(edge.from) ?? edge.from;
    const to = phaseOf.get(edge.to) ?? edge.to;
    // 同阶段内部转移对"阶段之间能去哪"没有信息量；但 loop 回边是阶段内自环，必须保留。
    if (from === to && edge.kind !== "loop") continue;
    const key = `${from}|${to}|${edge.kind}|${edge.via ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, kind: edge.kind, to, ...(edge.via === undefined ? {} : { via: edge.via }) });
  }
  out.sort(
    (a, b) =>
      at(a.from) - at(b.from) ||
      at(a.to) - at(b.to) ||
      a.kind.localeCompare(b.kind) ||
      (a.via ?? "").localeCompare(b.via ?? ""),
  );
  return out;
}
