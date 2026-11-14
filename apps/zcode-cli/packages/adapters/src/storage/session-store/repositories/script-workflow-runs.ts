// ============================================================
// Script workflow runs repository
// ============================================================
// 定位：workflow_definition（脚本定义，含信任/启用/哈希）与 workflow_run
// （一次执行的状态机快照）的持久化。
// 输入输出：upsert/create/update 返回写入后必读的完整记录；get 无结果返回 null；
// list 返回按 time_updated desc 排序的数组。
// 副作用：insert/update 两张表；单条语句原子，无显式事务。
// 失败语义：更新不存在的 run → throw；写入后读不到 → throw（防止静默丢失）。
// 不变量：definition.id 与 run.id 全局唯一；upsert definition 保留 time_created，
// 只推进 time_updated；run 的 budget_spent 单调由调用方保证（此处直接覆盖）；
// script_hash 与 run 绑定，用于检测脚本变更后拒绝复用旧缓存。

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  CreateScriptWorkflowRunInput,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  UpsertScriptWorkflowDefinitionInput,
  UpdateScriptWorkflowRunInput,
} from "@zcode/contracts";
import { encodeJson } from "../json.js";
import {
  decodeDefinition,
  decodeRun,
  type WorkflowDefinitionRow,
  type WorkflowRunRow,
} from "./script-workflow-codecs.js";

/**
 * 定义 upsert：按 id 覆盖名称/来源/作用域/信任/启用/路径/哈希/meta，
 * 冲突时保留首次 time_created。scope 缺省按 source 推导（builtin→builtin，否则 explicit）；
 * enabled 缺省 true（只有显式 false 才关闭）。
 */
export async function upsertScriptWorkflowDefinition(
  db: DatabaseSync,
  input: UpsertScriptWorkflowDefinitionInput,
): Promise<ScriptWorkflowDefinitionRecord> {
  const now = Date.now();
  db
    .prepare(
      `
      insert into workflow_definition (
        id, name, source, scope, trusted, enabled, script_path, script_hash, meta_json,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        source = excluded.source,
        scope = excluded.scope,
        trusted = excluded.trusted,
        enabled = excluded.enabled,
        script_path = excluded.script_path,
        script_hash = excluded.script_hash,
        meta_json = excluded.meta_json,
        time_updated = excluded.time_updated
      `,
    )
    .run(
      input.id,
      input.name,
      input.source,
      input.scope ?? (input.source === "builtin" ? "builtin" : "explicit"),
      input.trusted === true ? 1 : 0,
      input.enabled === false ? 0 : 1,
      input.scriptPath ?? null,
      input.scriptHash,
      JSON.stringify(input.meta),
      now,
      now,
    );
  return mustGetDefinition(db, input.id);
}

/**
 * 新建一次脚本运行（kind 固定 'script'）：初始 status 缺省 pending，
 * budget_spent 从 0 开始，current_phase/failure/started/completed 均为空。
 * args 序列化为 JSON，args_hash 可选（用于参数变更判定）。
 */
export async function createScriptWorkflowRun(
  db: DatabaseSync,
  input: CreateScriptWorkflowRunInput,
): Promise<ScriptWorkflowRunRecord> {
  const now = Date.now();
  db
    .prepare(
      `
      insert into workflow_run (
        id, definition_id, name, kind, parent_session_id, cwd, script_path, script_hash,
        args_json, args_hash, status, current_phase, budget_total, budget_spent,
        stats_json, failure_json, time_created, time_started, time_updated, time_completed
      ) values (?, ?, ?, 'script', ?, ?, ?, ?, ?, ?, ?, null, ?, 0, ?, null, ?, null, ?, null)
      `,
    )
    .run(
      input.id,
      input.definitionId ?? null,
      input.name,
      input.parentSessionId ?? null,
      input.cwd,
      input.scriptPath ?? null,
      input.scriptHash,
      encodeJson(input.args),
      input.argsHash ?? null,
      input.status ?? "pending",
      input.budgetTotal ?? null,
      encodeJson(input.stats),
      now,
      now,
    );
  return mustGetRun(db, input.id);
}

/**
 * 更新运行状态（局部语义）：未提供的字段保持当前值（含“显式 undefined 表示不改”），
 * 提供则覆盖。time_updated 总是推进；run 不存在 → throw。
 * failure/stats 用 undefined 区分“不改”，null 表示清空。
 */
export async function updateScriptWorkflowRun(
  db: DatabaseSync,
  input: UpdateScriptWorkflowRunInput,
): Promise<ScriptWorkflowRunRecord> {
  const current = await getScriptWorkflowRun(db, input.id);
  if (!current) throw new Error(`Workflow run not found: ${input.id}`);
  const now = Date.now();
  db
    .prepare(
      `
      update workflow_run set
        status = ?,
        current_phase = ?,
        budget_spent = ?,
        stats_json = ?,
        failure_json = ?,
        time_started = ?,
        time_updated = ?,
        time_completed = ?
      where id = ?
      `,
    )
    .run(
      input.status ?? current.status,
      input.currentPhase === undefined ? (current.currentPhase ?? null) : input.currentPhase,
      input.budgetSpent ?? current.budgetSpent,
      input.stats === undefined ? encodeJson(current.stats) : encodeJson(input.stats),
      input.failure === undefined ? encodeJson(current.failure) : encodeJson(input.failure),
      input.startedAt === undefined ? (current.startedAt ?? null) : input.startedAt,
      now,
      input.completedAt === undefined ? (current.completedAt ?? null) : input.completedAt,
      input.id,
    );
  return mustGetRun(db, input.id);
}

// 单条运行读取；不存在返回 null。
export async function getScriptWorkflowRun(
  db: DatabaseSync,
  runId: string,
): Promise<ScriptWorkflowRunRecord | null> {
  const row = db.prepare("select * from workflow_run where id = ?").get(runId) as
    | WorkflowRunRow
    | undefined;
  return row ? decodeRun(row) : null;
}

/**
 * 列出运行：可选 cwd / statuses 过滤，limit<=0 视为不限；恒按 time_updated desc,
 * id desc（同毫秒用 id 兜底稳定序）。空过滤条件返回全量。
 */
export async function listScriptWorkflowRuns(
  db: DatabaseSync,
  input: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  } = {},
): Promise<ScriptWorkflowRunRecord[]> {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (input.cwd) {
    clauses.push("cwd = ?");
    values.push(input.cwd);
  }
  if (input.statuses && input.statuses.length > 0) {
    clauses.push(`status in (${input.statuses.map(() => "?").join(", ")})`);
    values.push(...input.statuses);
  }
  const limit = input.limit && input.limit > 0 ? input.limit : undefined;
  if (limit !== undefined) values.push(limit);
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const limitSql = limit === undefined ? "" : " limit ?";
  const rows = db
    .prepare(`select * from workflow_run ${where} order by time_updated desc, id desc${limitSql}`)
    .all(...values) as unknown as WorkflowRunRow[];
  return rows.map(decodeRun);
}

// 写后必读：定义行不存在说明写入被回滚/丢失，直接 throw。
async function mustGetDefinition(
  db: DatabaseSync,
  definitionId: string,
): Promise<ScriptWorkflowDefinitionRecord> {
  const row = db.prepare("select * from workflow_definition where id = ?").get(definitionId) as
    | WorkflowDefinitionRow
    | undefined;
  if (!row) throw new Error(`Workflow definition not found after write: ${definitionId}`);
  return decodeDefinition(row);
}

// 写后必读：run 不存在 → throw，避免调用方拿到 undefined 继续推进状态机。
async function mustGetRun(db: DatabaseSync, runId: string): Promise<ScriptWorkflowRunRecord> {
  const run = await getScriptWorkflowRun(db, runId);
  if (!run) throw new Error(`Workflow run not found after write: ${runId}`);
  return run;
}
