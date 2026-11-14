// ============================================================
// Script workflow row codecs
// ============================================================
// 定位：workflow_definition / workflow_run / workflow_activity / workflow_event /
// session_task_link 五行类型的解码边界（snake_case + JSON 文本 → 领域记录）。
// 输入输出：解码函数返回对应 Record；可选列 null → undefined；JSON 列空值 →
// undefined（不是 null）；数值型布尔列（0/1）转 boolean。
// 副作用：无（纯函数）；JSON.parse 对损坏 meta_json 会抛错。
// 失败语义：非法 JSON 直接抛出，由调用方视为数据损坏；不做静默兜底。
// 不变量：时间字段统一映射为 createdAt/updatedAt/startedAt/completedAt；
// enabled/trusted 严格按 ===1 判真，其它值一律 false。

import type {
  ScriptWorkflowActivityRecord,
  ScriptWorkflowActivityStatus,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  SessionId,
  SessionTaskLinkRecord,
  WorkflowAgentOptions,
  WorkflowScriptMeta,
} from "@zcode/contracts";
import { decodeJson } from "../json.js";

export interface WorkflowDefinitionRow {
  /** 0/1 布尔列；1 表示启用。 */
  enabled: number;
  id: string;
  /** WorkflowScriptMeta 的 JSON 文本（必填）。 */
  meta_json: string;
  name: string;
  /** 定义作用域：内置 / 显式导入 / 项目 / 用户。 */
  scope: "builtin" | "explicit" | "project" | "user";
  /** 脚本内容哈希，用于检测变更。 */
  script_hash: string;
  /** 脚本路径；null 表示内联脚本无独立文件。 */
  script_path: string | null;
  source: "builtin" | "user";
  time_created: number;
  time_updated: number;
  /** 0/1 布尔列；1 表示用户已信任。 */
  trusted: number;
}

export interface WorkflowRunRow {
  /** 参数哈希；null 表示未提供，用于判断参数是否变化。 */
  args_hash: string | null;
  args_json: string | null;
  /** 已花费预算（非负累计）。 */
  budget_spent: number;
  /** 预算上限；null 表示不限。 */
  budget_total: number | null;
  current_phase: string | null;
  cwd: string;
  definition_id: string | null;
  failure_json: string | null;
  id: string;
  /** 目前只有 script 一种运行类型。 */
  kind: "script";
  name: string;
  parent_session_id: SessionId | null;
  script_hash: string;
  script_path: string | null;
  stats_json: string | null;
  status: ScriptWorkflowRunStatus;
  time_completed: number | null;
  time_created: number;
  time_started: number | null;
  time_updated: number;
}

export interface WorkflowActivityRow {
  /** 同一 call_path 下的重试序号，从 1 开始递增。 */
  attempt: number;
  /** 脚本内调用的全局顺序。 */
  call_index: number;
  /** 调用路径（用于区分循环/嵌套调用点）。 */
  call_path: string;
  child_session_id: SessionId | null;
  error_json: string | null;
  id: string;
  /** 输入指纹，与 call_path/run 一起决定缓存命中。 */
  input_hash: string;
  label: string | null;
  opts_json: string | null;
  parent_activity_id: string | null;
  phase: string | null;
  prompt: string | null;
  result_json: string | null;
  run_id: string;
  status: ScriptWorkflowActivityStatus;
  time_completed: number | null;
  time_created: number;
  time_started: number | null;
  time_updated: number;
  type: ScriptWorkflowActivityRecord["type"];
}

export interface WorkflowEventRow {
  /** 关联 activity；null 表示 run 级事件。 */
  activity_id: string | null;
  id: string;
  /** 事件负载 JSON；null 表示无 payload。 */
  payload_json: string | null;
  phase: string | null;
  run_id: string;
  /** run 内单调序号，从 1 开始，用于事件流排序/去重。 */
  sequence: number;
  time_created: number;
  type: string;
}

export interface SessionTaskLinkRow {
  activity_id: string | null;
  agent_type: string | null;
  /** 子会话 id，本表唯一键。 */
  child_session_id: SessionId;
  /** 任务树深度，根为 0。 */
  depth: number;
  id: string;
  label: string | null;
  model: string | null;
  parent_link_id: string | null;
  parent_session_id: SessionId | null;
  /** 任务树路径（如 /root/child），用于展示与定位。 */
  path: string;
  phase: string | null;
  role: string;
  root_workflow_run_id: string | null;
  status: string;
  time_created: number;
  time_updated: number;
}

// 定义行解码：0/1 列转布尔，meta_json 必填会 parse；脚本路径 null → undefined。
export function decodeDefinition(row: WorkflowDefinitionRow): ScriptWorkflowDefinitionRecord {
  return {
    enabled: row.enabled === 1,
    id: row.id,
    meta: JSON.parse(row.meta_json) as WorkflowScriptMeta,
    name: row.name,
    scope: row.scope,
    scriptHash: row.script_hash,
    scriptPath: row.script_path ?? undefined,
    source: row.source,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
    trusted: row.trusted === 1,
  };
}

// 运行行解码：所有可空时间/JSON 列 null → undefined；budget_spent 原样（非空）。
export function decodeRun(row: WorkflowRunRow): ScriptWorkflowRunRecord {
  return {
    args: decodeJson(row.args_json),
    argsHash: row.args_hash ?? undefined,
    budgetSpent: row.budget_spent,
    budgetTotal: row.budget_total ?? undefined,
    completedAt: row.time_completed ?? undefined,
    createdAt: row.time_created,
    currentPhase: row.current_phase ?? undefined,
    cwd: row.cwd,
    definitionId: row.definition_id ?? undefined,
    failure: decodeJson(row.failure_json),
    id: row.id,
    kind: row.kind,
    name: row.name,
    parentSessionId: row.parent_session_id ?? undefined,
    scriptHash: row.script_hash,
    scriptPath: row.script_path ?? undefined,
    startedAt: row.time_started ?? undefined,
    stats: decodeJson(row.stats_json),
    status: row.status,
    updatedAt: row.time_updated,
  };
}

// activity 行解码：opts_json 解为 WorkflowAgentOptions；可空列统一转 undefined。
export function decodeActivity(row: WorkflowActivityRow): ScriptWorkflowActivityRecord {
  return {
    attempt: row.attempt,
    callIndex: row.call_index,
    callPath: row.call_path,
    childSessionId: row.child_session_id ?? undefined,
    completedAt: row.time_completed ?? undefined,
    createdAt: row.time_created,
    error: decodeJson(row.error_json),
    id: row.id,
    inputHash: row.input_hash,
    label: row.label ?? undefined,
    opts: decodeJson<WorkflowAgentOptions>(row.opts_json),
    parentActivityId: row.parent_activity_id ?? undefined,
    phase: row.phase ?? undefined,
    prompt: row.prompt ?? undefined,
    result: decodeJson(row.result_json),
    runId: row.run_id,
    startedAt: row.time_started ?? undefined,
    status: row.status,
    type: row.type,
    updatedAt: row.time_updated,
  };
}

// 事件行解码：payload 空值 → undefined；sequence 原样用于排序/断点续读。
export function decodeEvent(row: WorkflowEventRow): ScriptWorkflowEventRecord {
  return {
    activityId: row.activity_id ?? undefined,
    createdAt: row.time_created,
    id: row.id,
    payload: decodeJson(row.payload_json),
    phase: row.phase ?? undefined,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
  };
}

// 任务链接解码：可空层级/活动/模型字段转 undefined，childSessionId 必须存在。
export function decodeTaskLink(row: SessionTaskLinkRow): SessionTaskLinkRecord {
  return {
    activityId: row.activity_id ?? undefined,
    agentType: row.agent_type ?? undefined,
    childSessionId: row.child_session_id,
    createdAt: row.time_created,
    depth: row.depth,
    id: row.id,
    label: row.label ?? undefined,
    model: row.model ?? undefined,
    parentLinkId: row.parent_link_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    path: row.path,
    phase: row.phase ?? undefined,
    role: row.role,
    rootWorkflowRunId: row.root_workflow_run_id ?? undefined,
    status: row.status,
    updatedAt: row.time_updated,
  };
}
