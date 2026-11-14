/**
 * ============================================================================
 * workflow/expert/ids.ts —— 工作流内所有字符串标识的单一构造口径
 * ============================================================================
 *
 * 【定位】id 在快照、graph record、事件与文件路径四处被拼装，若各处各写一份
 * 格式就会对不上（例如重开节点时按 id 找不到节点）。因此 phase 节点 id、
 * 边 id、artifact/run 文件名都只在本文件生成。
 *
 * 【不变量】phaseNodeId 必须是双射：一个 phase 只对应一个 phase 节点，反向
 * 也成立；edgeId 必须与 lifecycle.ts 的去重格式一致（from->to），否则播种去重
 * 会把同一条边当成两条。
 * ============================================================================
 */

import type { WorkflowGraph, WorkflowGraphEdge, WorkflowRunStatus } from "@zcode/contracts";

/**
 * 阶段节点的图 id：固定 `phase:<阶段名>`。
 *
 * 输入是 definition 中的 phase 字符串（已由 schema 校验），输出同时用于
 * createPhaseGraph、appendGraphStatus 与 critic/retry 的节点定位。无副作用；
 * 不做任何转义，所以 phase 名必须来自受控定义而不是用户输入。
 */
export function phaseNodeId(phase: string): string {
  return `phase:${phase}`;
}

/**
 * 边的规范 id：`<from>-><to>`。
 *
 * 只用于去重/记录，不承载语义；必须与 ../lifecycle.ts 内部 edgeId 的格式保持
 * 一致，否则同一逻辑边会被重复播种（图记录里出现两条重复边）。
 */
export function edgeId(edge: WorkflowGraphEdge): string {
  return `${edge.from}->${edge.to}`;
}

/**
 * 计算某个阶段交给 scheduler 的可执行节点集合。
 *
 * 口径：属于该 phase（或未标 phase，视为全局可执行）的 task 节点优先；若一个
 * 都没有，则退化为 phase 节点自身，保证空图/纯阶段图时 scheduler 仍能判定
 * "完成"或"阻塞"，而不会因为集合为空直接报 deadlock。
 * 纯函数，不修改 graph；返回顺序沿用 graph.nodes 顺序。
 */
export function executableNodeIdsForPhase(graph: WorkflowGraph, phase: string): string[] {
  const taskIds = graph.nodes
    .filter((node) => node.kind === "task" && (node.phase === phase || !node.phase))
    .map((node) => node.id);
  return taskIds.length > 0 ? taskIds : [phaseNodeId(phase)];
}

/**
 * 把任意字符串压成可安全用作文件/目录名的片段。
 *
 * 规则：仅保留 [a-zA-Z0-9._-]，其余连续字符折叠为单个 `-`，再去掉首尾 `-`；
 * 结果为空时回退 "workflow"。用于 artifact 目录与 artifact 文件名，防止路径
 * 分隔符/空格/中文进入磁盘路径（跨平台兼容）。无副作用。
 */
export function safeArtifactName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "workflow";
}

/**
 * run id 中嵌入的 kind 片段。
 *
 * 在 safeArtifactName 基础上再去掉 `.`：runId 会出现在路径与日志行里，点号
 * 容易与扩展名/版本号混淆，也避免某些解析按 `.` 切分时出错。
 */
export function safeRunIdSegment(value: string): string {
  return safeArtifactName(value).replace(/[.]/g, "-");
}

/**
 * 判定 run 是否已进入终态。
 *
 * 终态集合只有 completed/failed/cancelled；paused 不是终态（可以通过 retry/resume
 * 继续），因此 status/cancel/resume 用本函数做"无需再操作"的短路判断。
 */
export function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
