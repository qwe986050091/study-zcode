import { UNPHASED_ID } from "./constants.js";
import type { PhaseInfo } from "./causality-order.js";
import type { Src } from "./flow-graph.js";

/**
 * Where a strand's exits wait between the `fork` that starts it and the `join` that
 * collects it — the one piece of state the concurrent control-flow graph (flow-graph.ts)
 * keeps outside its recursion over the control tree.
 *
 * A strand region is flowed at its SPAWN point, because that is where the trace records
 * it, but its exits do not belong there: they belong at the barrier that awaits its
 * promise, an arbitrary distance later in the leaf stream and possibly in another region.
 * So a strand parks its exits under its own region id and the spawner carries on
 * unchanged; the `settle` leaf whose `joins` names the region unparks them and merges them
 * into its own outgoing sources. A strand is joined at most once, exactly as the walk's
 * `joined` set says. Whatever is still parked when the root's sequence ends joins the
 * sink: nothing awaited it, so all that is known is that the script did not outlive it.
 *
 * The park also answers `alongside` for a `mark` leaf — which phases are still running
 * when this one is entered — which is why it carries each strand's phases and not only its
 * exits. Like every other projection module it must not import `typescript`; it is a
 * separate file only because flow-graph.ts sits at the 400-line cap.
 */
// 里停放区：并发分支（strand）挂起中的出口在 fork 与 join 之间暂存在这里，
// 是 flow-graph 递归之外唯一保存的跨区域状态。key 是 strand 区域 id，value 是它的
// 待接出口与被其内部节点创建过的阶段（供 mark 判断 alongside）。每个 strand 至多被 join 一次。
export interface StrandPark {
  /** Phases running alongside a mark: everything parked, minus its own and its ancestors'. */
  alongside: (phase: string, regions: readonly string[]) => string[];
  /** Forget everything parked, connecting nothing: a detached body's strands have no position. */
  discard: () => void;
  /** Take every exit still parked (the sink's share), leaving the park empty. */
  drain: () => Src[];
  /** Take the exits of the named strands; a name that parked nothing contributes none. */
  join: (regions: readonly string[]) => Src[];
  /** Record one strand's exits and the phases of the nodes its body created. */
  park: (region: string, exits: readonly Src[], phases: readonly string[]) => void;
}

/**
 * `phases` is the trace's phase table, which orders every list this module returns:
 * {@link UNPHASED_ID} first (as in `collectFlowPhases`), then first-reach order.
 */
// 由 trace 的阶段表建立停放区；返回值是闭包上的有状态操作集合（parked 是唯一可变状态）。
// 所有返回的阶段列表都按 phase 表顺序（UNPHASED_ID 最前）；drain/join 都会清掉对应条目，
// 因此对同一批 strand 重复 join 不会产生重复边（名字未停放时贡献空集合）。
export function createStrandPark(phases: readonly PhaseInfo[]): StrandPark {
  const parked = new Map<string, { exits: Src[]; phases: readonly string[] }>();
  const rank = new Map<string, number>(phases.map((phase, index) => [phase.id, index + 1]));
  rank.set(UNPHASED_ID, 0);
  const at = (id: string): number => rank.get(id) ?? rank.size;
  return {
    alongside: (phase, regions) => {
      // A mark inside a strand is not alongside it: the strand is where the mark IS. The
      // whole enclosing chain is excluded, not just the innermost region.
      const enclosing = new Set(regions);
      const running = new Set<string>();
      for (const [region, strand] of parked) {
        // mark 所在整条祖先链都排除：strand 是 mark 的"所在"，不是"并行"。
        if (enclosing.has(region)) continue;
        for (const id of strand.phases) if (id !== phase) running.add(id);
      }
      return [...running].sort((a, b) => at(a) - at(b));
    },
    discard: () => parked.clear(),
    drain: () => {
      const out = [...parked.values()].flatMap((strand) => strand.exits);
      parked.clear();
      return out;
    },
    join: (regions) => {
      const out: Src[] = [];
      for (const region of regions) {
        const strand = parked.get(region);
        // 名字没停放任何东西（或已被先前 join 取走）就不贡献出口，静默跳过。
        if (strand === undefined) continue;
        parked.delete(region);
        out.push(...strand.exits);
      }
      return out;
    },
    park: (region, exits, phaseIds) => {
      parked.set(region, { exits: [...exits], phases: [...phaseIds] });
    },
  };
}
