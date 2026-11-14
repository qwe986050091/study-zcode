import type { SessionTaskType } from "@zcode/contracts";

/**
 * 左侧任务列表的 session 类型投影。
 *
 * 列表可见性不能用 `parent_id is null` 的层级查询代替：显式 fork
 * 这类有 parent 的主任务会在 CLI 重启后被冷启动种子过滤。可见性必须由 taskType 决定，
 * 而辅助对话、subagent 与 workflow child 继续由各自专用投影承载。
 */
// 可见性白名单：interactive（普通会话）、fork（显式分叉的主任务）、workflow_parent
// （workflow 主任务）。辅助对话/subagent/workflow child 不在其中，由各自投影承载。
// 该名单是 taskType → 列表可见性的唯一裁决依据，不再回退到 parent_id 层级判断。
export const TASK_LIST_SESSION_TYPES = [
  "interactive",
  "fork",
  "workflow_parent",
] as const satisfies readonly SessionTaskType[];

const TASK_LIST_SESSION_TYPE_SET = new Set<SessionTaskType>(
  TASK_LIST_SESSION_TYPES,
);

/**
 * 判断某 session 是否应出现在左侧任务列表。
 * 输入：session 的 taskType（可能缺失）；输出：true = 属于列表可见集合。
 * 口径：缺省按 "interactive" 处理，让旧数据/未标注任务保持可见；未知新类型默认不可见，
 * 必须显式加入白名单才会展示，避免新子类型意外污染主列表。纯查表，无副作用。
 */
export function isTaskListSessionType(
  taskType: SessionTaskType | undefined,
): boolean {
  return TASK_LIST_SESSION_TYPE_SET.has(taskType ?? "interactive");
}
