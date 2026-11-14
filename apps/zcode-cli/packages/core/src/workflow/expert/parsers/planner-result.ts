import {
  WorkflowGraphPlannerResultSchema,
  type WorkflowGraphPlannerResult,
} from "@zcode/contracts";
import { normalizeWorkflowGraphSeedCandidate } from "./graph-seed.js";
import {
  isRecord,
  parsePlannerJson,
  readLooseBoolean,
  readLooseStringArray,
  stringValue,
} from "./json.js";

/**
 * ============================================================================
 * workflow/expert/parsers/planner-result.ts —— 集合扩张器（planner）输出解析
 * ============================================================================
 *
 * 【定位】scheduled-phase 的 plannerRunner 每跑完一轮 planner 子会话，
 * 都用它把模型回复转成 WorkflowGraphPlannerResult，再交给 applyPlannerExpansion。
 *
 * 【宽松/严格边界】先尝试满足 planner 结果的直通 schema；不满足时借用
 * graph-seed 的归一化能力，把同一份文本当作"图草案 + collectionNodeIds"来解读。
 *
 * 【失败语义】与 graph-seed 相反：任何无法成形的输出都抛 Error。上层
 * collection-planner 的 catch 会把它记为一次 planner 失败并累加 errorCount，
 * 达到 maxConsecutiveErrors 后集合被置为 exhausted，而不是静默空扩张。
 * ============================================================================
 */

/**
 * 解析 planner 回复为图扩张结果。
 * 输入：模型原始文本 + 缺省阶段名（用于节点/集合 phase 兜底）。
 * 输出：schema 校验通过的 WorkflowGraphPlannerResult（nodes/edges 缺省为空数组）。
 * 失败语义：JSON 不可解析、非对象、两次 schema 校验均失败时抛 Error。
 * 不变量：exhausted=true 时调度器会停止对该集合继续规划。
 * 下游影响：nodes/edges 被 applyPlannerExpansion 校验并合入快照，失败即本轮不扩张。
 */
export function parseWorkflowPlannerResult(
  response: string,
  defaultPhase: string,
): WorkflowGraphPlannerResult {
  const raw = parsePlannerJson(response);
  // 标准形态优先直通；命中时不再做任何宽松映射，避免把合法结果改写。
  const direct = WorkflowGraphPlannerResultSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (!isRecord(raw)) {
    throw new Error("Workflow planner did not return JSON graph expansion data");
  }
  const seed = normalizeWorkflowGraphSeedCandidate(raw, defaultPhase);
  // collectionNodeIds 口径：显式字段优先；缺失时退化为 seed 各集合 nodeIds 的并集，
  // 这样 planner 只给 nodes/collections 的旧格式也能把新节点归属到集合。
  const collectionNodeIds =
    readLooseStringArray(raw, [
      "collectionNodeIds",
      "collection_node_ids",
      "collectionUpdates",
      "collection_updates",
    ]) ?? seed?.collections.flatMap((collection) => collection.nodeIds);
  const parsed = WorkflowGraphPlannerResultSchema.safeParse({
    collectionNodeIds,
    edges: seed?.edges ?? [],
    exhausted: readLooseBoolean(raw, ["exhausted"]),
    nodes: seed?.nodes ?? [],
    reasoning: stringValue(raw.reasoning),
  });
  if (parsed.success) return parsed.data;
  throw new Error("Workflow planner did not return JSON graph expansion data");
}
