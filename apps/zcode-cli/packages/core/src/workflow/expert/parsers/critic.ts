import {
  WorkflowCriticReopenProposalSchema,
  WorkflowCriticResultSchema,
  type WorkflowCriticReopenProposal,
  type WorkflowCriticResult,
} from "@zcode/contracts";
import { isRecord, parsePlannerJson, stringValue } from "./json.js";

/**
 * ============================================================================
 * workflow/expert/parsers/critic.ts —— 终审 critic 结论的解析与归一化
 * ============================================================================
 *
 * 【定位】把 critic 子会话的回复解析成 WorkflowCriticResult。回答两个问题：
 *   verdict 是 pass 还是 fail；需要打回重开的节点清单是什么。
 *
 * 【宽松边界】兼容旧字段 passed / overallVerdict / reopen_proposals / reopenNodes，
 * 但 verdict 本身必须能确定，否则视为解析失败。
 *
 * 【失败语义】JSON 无法解析或无法确定 verdict 时抛 Error；critic-loop 不捕获，
 * 该次终审轮直接向上失败，不会把畸形输出当成"通过"或"零重开"。
 * ============================================================================
 */

/**
 * 解析 critic 回复为终审结论。
 * 输入：模型原始文本（可能带说明、围栏或旧字段形态）。
 * 输出：已通过 schema 校验的 WorkflowCriticResult。
 * 失败语义：JSON 不可解析、非对象、verdict 无法判定、schema 校验不通过时抛 Error。
 * 不变量：verdict 只会是 pass/fail，不存在"缺字段即通过"。
 * 下游：critic-loop 用 verdict 决定结束还是按 reopenProposals 打回节点。
 */
export function parseCriticResult(response: string): WorkflowCriticResult {
  const raw = parsePlannerJson(response);
  const normalized = normalizeCriticCandidate(raw);
  if (!normalized) {
    throw new Error("Workflow critic did not return JSON verdict data");
  }
  return normalized;
}

/**
 * 按 nodeId 对重开建议去重，保留首次出现的顺序与原因。
 * 输入可能包含同一节点的多条建议（不同理由/严重级别）；只保留第一条，
 * 避免 critic-loop 对同一节点重复调用 reopen 并叠加 reopenAttempts。
 * 纯函数，不抛错。
 */
export function dedupeReopenProposals(
  proposals: readonly WorkflowCriticReopenProposal[],
): WorkflowCriticReopenProposal[] {
  const seen = new Set<string>();
  const deduped: WorkflowCriticReopenProposal[] = [];
  for (const proposal of proposals) {
    if (seen.has(proposal.nodeId)) continue;
    seen.add(proposal.nodeId);
    deduped.push(proposal);
  }
  return deduped;
}

/**
 * 把任意候选值归一化为 critic 结论；无法判定时返回 null（不抛错）。
 * 非对象直接失败；含旧版字段的候选跳过直通校验，必须先做字段映射。
 */
function normalizeCriticCandidate(value: unknown): WorkflowCriticResult | null {
  if (!isRecord(value)) return null;
  // 只有不含旧字段形态时才尝试直通，避免直接 safeParse 把可修复的旧格式判死。
  if (!hasLegacyCriticFields(value)) {
    const direct = WorkflowCriticResultSchema.safeParse(value);
    if (direct.success) return direct.data;
  }

  // verdict 口径：显式 pass/fail 优先；其次 passed 布尔；最后 overallVerdict 字符串。
  // conditionallyApproved 归为 pass（带条件通过），其余未知字符串一律 fail。
  const verdict =
    value.verdict === "pass" || value.verdict === "fail"
      ? value.verdict
      : typeof value.passed === "boolean"
        ? value.passed
          ? "pass"
          : "fail"
        : typeof value.overallVerdict === "string"
          ? value.overallVerdict === "approved" || value.overallVerdict === "conditionallyApproved"
            ? "pass"
            : "fail"
          : undefined;
  if (!verdict) return null;

  const reasoning =
    stringValue(value.reasoning) ??
    stringValue(value.summary) ??
    (typeof value.verdict === "string" ? value.verdict : "");

  // 重开建议支持三种形态：对象数组、下划线命名对象数组、以及只给节点 id 的数组；
  // 最后一种用本轮 reasoning 兜底 reason，保证 schema 的 reason 必填约束可满足。
  const rawProposals = Array.isArray(value.reopenProposals)
    ? value.reopenProposals
    : Array.isArray(value.reopen_proposals)
      ? value.reopen_proposals
      : Array.isArray(value.reopenNodes)
        ? value.reopenNodes.map((nodeId) => ({
            nodeId,
            reason: reasoning || "critic requested reopen",
          }))
        : [];

  const reopenProposals = rawProposals
    .map(normalizeCriticReopenProposal)
    .filter((proposal): proposal is WorkflowCriticReopenProposal => proposal !== null);
  const acceptanceGaps = Array.isArray(value.acceptanceGaps)
    ? value.acceptanceGaps.map(stringValue).filter((gap): gap is string => gap !== undefined)
    : Array.isArray(value.acceptance_gaps)
      ? value.acceptance_gaps.map(stringValue).filter((gap): gap is string => gap !== undefined)
      : [];

  const parsed = WorkflowCriticResultSchema.safeParse({
    acceptanceGaps,
    reasoning,
    reopenProposals,
    verdict,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 判断候选是否带旧版 critic 字段。
 * 命中任一旧字段就放弃直通解析路径，改走下面的兼容映射。
 */
function hasLegacyCriticFields(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.acceptance_gaps) ||
    typeof value.overallVerdict === "string" ||
    typeof value.passed === "boolean" ||
    Array.isArray(value.reopenNodes) ||
    Array.isArray(value.reopen_proposals)
  );
}

/**
 * 归一化单条重开建议；缺 nodeId 或 reason 时返回 null 丢弃该条。
 * severity 仅接受 critical/major/minor，非法值被省略而不是让整条建议失效。
 */
function normalizeCriticReopenProposal(value: unknown): WorkflowCriticReopenProposal | null {
  if (!isRecord(value)) return null;
  const nodeId =
    stringValue(value.nodeId) ??
    stringValue(value.node_id) ??
    stringValue(value.nodeName) ??
    stringValue(value.node_name);
  const reason = stringValue(value.reason) ?? stringValue(value.issue);
  if (!nodeId || !reason) return null;
  const severity = value.severity;
  const parsed = WorkflowCriticReopenProposalSchema.safeParse({
    nodeId,
    reason,
    ...(severity === "critical" || severity === "major" || severity === "minor"
      ? { severity }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}
