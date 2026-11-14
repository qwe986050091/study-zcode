/**
 * ============================================================================
 * workflow/expert/formatters.ts —— workflow 命令的人类可读文案（纯函数）
 * ============================================================================
 *
 * 【定位】只做快照到文本的投影，不读写 store、不发事件、不做状态判断。所有
 * 命令回执（start/status/resume/retry/cancel）都复用它，保证同一 run 在 TUI
 * 与协议侧看到一致的措辞。
 *
 * 【口径】输出面向人而不是模型：包含 runId、status、task、cwd、更新时间、
 * 阶段列表；阶段行首用 [x]/>/- 表示 completed/active/其余，错误与 activity/
 * session 以括号追加。文案变化不影响状态机，但可能被外部按行解析，改动需谨慎。
 * ============================================================================
 */

import type { ExpertWorkflowRunSnapshot } from "@zcode/contracts";

/**
 * 完整状态视图（多行）。
 *
 * 输入快照按字段顺序渲染：runId → status → task → cwd → updatedAt → 阶段列表
 * （含 error/activity/session 细节）→ reportPath（仅完成写报告后）。纯函数，
 * 无副作用；缺失字段直接省略，不填占位符。
 */
export function formatExpertWorkflowStatus(snapshot: ExpertWorkflowRunSnapshot): string {
  const lines = [
    `Expert workflow ${snapshot.runId}`,
    `Status: ${snapshot.status}`,
    `Task: ${snapshot.task}`,
    `Directory: ${snapshot.cwd}`,
    `Updated: ${snapshot.updatedAt}`,
    "",
    "Phases:",
  ];
  for (const phase of snapshot.phases) {
    // 标记口径与阶段状态一一对应：completed=[x]、active=>，pending/failed 等用 -。
    const marker = phase.status === "completed" ? "[x]" : phase.status === "active" ? ">" : "-";
    const detail = phase.error ? ` (${phase.error})` : "";
    const activityDetail = phase.activityId
      ? ` | activity ${phase.activityId}${phase.sessionId ? ` | session ${phase.sessionId}` : ""}`
      : "";
    lines.push(`  ${marker} ${phase.phase}: ${phase.status}${activityDetail}${detail}`);
  }
  if (snapshot.reportPath) {
    lines.push("", `Report: ${snapshot.reportPath}`);
  }
  return lines.join("\n");
}

/**
 * 完成/收尾时的简短回执（三行以内）。
 *
 * 只保留 runId+status、原始 task 与 reportPath 三项，用作命令最终返回值中的
 * response；reportPath 缺失（例如最终阶段失败）时该行被过滤而不是留空。
 * 纯函数，无副作用；不渲染阶段细节（详情走 formatExpertWorkflowStatus）。
 */
export function formatExpertWorkflowCompletion(snapshot: ExpertWorkflowRunSnapshot): string {
  return [
    `Expert workflow ${snapshot.runId} ${snapshot.status}.`,
    `Task: ${snapshot.task}`,
    snapshot.reportPath ? `Report: ${snapshot.reportPath}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
