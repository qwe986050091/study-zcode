// INV-01 尝试号只增不减：守住位置 最大值加一；改错故障 重试覆盖历史记录。
// INV-02 读取与插入在同一连接上串行：守住位置 单条语句；改错故障 并发下拿到重复尝试号。
// INV-03 写后必读：守住位置 返回前的回查；改错故障 调用方拿到未落盘的空记录。
// INV-04 更新前先判存在：守住位置 入口读取；改错故障 静默更新零行。
// INV-05 缺省字段保留原值：守住位置 空值合并；改错故障 一次局部更新清空已有结果。
// INV-06 可空字段入库前归一：守住位置 编码前转换；改错故障 出现未定义绑定。
// INV-07 事件序号按运行单调：守住位置 最大值加一；改错故障 顺序错乱导致重放失效。
// INV-08 事件读取限量取最近：守住位置 子查询倒序再翻正；改错故障 拿到最旧的若干条。
// INV-09 非正限量视为不限：守住位置 条件归一；改错故障 负值被当成零条。
// INV-10 子会话标识唯一：守住位置 冲突子句；改错故障 同一子会话产生多条链接。
// INV-11 冲突只更新状态与时间：守住位置 更新列清单；改错故障 层级信息被覆盖。
// INV-12 深度缺省为零：守住位置 空值合并；改错故障 根节点深度为空。
// INV-13 缓存命中只认成功态：守住位置 状态过滤；改错故障 失败尝试被复用。
// INV-14 缓存按尝试号取最新：守住位置 排序与限量；改错故障 命中旧的重试结果。
// INV-15 输入摘要参与命中：守住位置 哈希条件；改错故障 参数变了仍复用旧结果。
// INV-16 活动按调用顺序稳定排序：守住位置 复合排序键；改错故障 同序号时顺序抖动。
// INV-17 写失败必须抛出：守住位置 必读回查；改错故障 上层继续用不存在的标识。
// INV-18 单条语句自持原子性：守住位置 单条写入；改错故障 依赖跨语句事务但缺锁。
//
// 模块职责：脚本工作流的活动、事件与子会话链接三张明细表的读写仓储。
// 状态所有权：无内存状态，序号与唯一性全部由数据库约束与查询保证。
// 阅读顺序：先看活动创建与更新，再看事件追加，最后看任务链接与必读回查。
// ============================================================
// Script workflow activities / events / task links
// ============================================================
// 定位：脚本工作流的执行明细：activity（一次 agent 调用，含 attempt 重试）、
// event（按 run 单调 sequence 的事件流）、session_task_link（子会话与父任务/活动的
// 映射，child_session_id 唯一）。
// 输入输出：create/update/append 返回写后必读记录；findCached 未命中返回 null；
// list 返回按 call_index/sequence 升序数组；空数组表示无明细。
// 副作用：insert/update 三张表，无显式事务（单条语句原子）。
// 失败语义：更新不存在 activity → throw；写后读不到 → throw。
// 不变量：attempt = 同 (run, call_path) 的 max+1，重试号递增；event sequence =
// 同 run 的 max+1；task_link 以 child_session_id 为唯一键，冲突只更新 status/时间；
// activity 缓存只认 completed/cached 且 input_hash 一致的最近一次 attempt。

import type { DatabaseSync } from "node:sqlite";
import type {
  CreateScriptWorkflowActivityInput,
  CreateSessionTaskLinkInput,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowEventRecord,
  SessionId,
  SessionTaskLinkRecord,
  UpdateScriptWorkflowActivityInput,
} from "@zcode/contracts";
import { encodeJson } from "../json.js";
import {
  decodeActivity,
  decodeEvent,
  decodeTaskLink,
  type SessionTaskLinkRow,
  type WorkflowActivityRow,
  type WorkflowEventRow,
} from "./script-workflow-codecs.js";

/**
 * 创建 activity：attempt 由同 (run_id, call_path) 当前最大值 +1 自动分配，
 * 因此同一调用点重试会得到递增 attempt 而不是覆盖旧记录。
 * 初始 status 缺省 queued，result/error/started/completed 为空。
 */
// attempt 先按 run_id 与 call_path 查 max 再 +1，insert 之前完成。
// attempt 不做回退式覆盖，重试产生的旧记录仍留在表里可追溯。
// status 为 undefined 时写入 "queued"，其余可空列一律传 null。
// phase 与 label 走 `?? null`，避免 undefined 绑定到 SQLite。
// insert 之后用 mustGetActivity 回读，返回值来自磁盘而不是入参。
export async function createScriptWorkflowActivity(
  db: DatabaseSync,
  input: CreateScriptWorkflowActivityInput,
): Promise<ScriptWorkflowActivityRecord> {
  const now = Date.now();
  const attemptRow = db
    .prepare(
      `
      select coalesce(max(attempt), 0) + 1 as next_attempt
      from workflow_activity where run_id = ? and call_path = ?
      `,
    )
    .get(input.runId, input.callPath) as { next_attempt: number } | undefined;
  const attempt = attemptRow?.next_attempt ?? 1;
  db
    .prepare(
      `
      insert into workflow_activity (
        id, run_id, parent_activity_id, call_index, call_path, attempt, type, phase,
        label, input_hash, prompt, opts_json, status, child_session_id, result_json,
        error_json, time_created, time_started, time_updated, time_completed
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, null, ?, null)
      `,
    )
    .run(
      input.id,
      input.runId,
      input.parentActivityId ?? null,
      input.callIndex,
      input.callPath,
      attempt,
      input.type,
      input.phase ?? null,
      input.label ?? null,
      input.inputHash,
      input.prompt ?? null,
      encodeJson(input.opts),
      input.status ?? "queued",
      now,
      now,
    );
  return mustGetActivity(db, input.id);
}

/**
 * 更新 activity 收口信息（局部语义）：未提供字段保持当前值；
 * status/childSessionId/result/error/started/completed 可显式覆盖，time_updated 必推进。
 */
export async function updateScriptWorkflowActivity(
  db: DatabaseSync,
  input: UpdateScriptWorkflowActivityInput,
): Promise<ScriptWorkflowActivityRecord> {
  const current = await getActivity(db, input.id);
  if (!current) throw new Error(`Workflow activity not found: ${input.id}`);
  const now = Date.now();
  db
    .prepare(
      `
      update workflow_activity set
        status = ?,
        child_session_id = ?,
        result_json = ?,
        error_json = ?,
        time_started = ?,
        time_updated = ?,
        time_completed = ?
      where id = ?
      `,
    )
    .run(
      input.status ?? current.status,
      input.childSessionId === undefined ? (current.childSessionId ?? null) : input.childSessionId,
      input.result === undefined ? encodeJson(current.result) : encodeJson(input.result),
      input.error === undefined ? encodeJson(current.error) : encodeJson(input.error),
      input.startedAt === undefined ? (current.startedAt ?? null) : input.startedAt,
      now,
      input.completedAt === undefined ? (current.completedAt ?? null) : input.completedAt,
      input.id,
    );
  return mustGetActivity(db, input.id);
}

/**
 * 复用检测：同 run + call_path + input_hash 下，最近一次成功（completed/cached）
 * 的 activity；无命中返回 null（调用方应真正执行）。cached 也算成功，避免二次缓存。
 */
export async function findCachedScriptWorkflowActivity(
  db: DatabaseSync,
  input: { callPath: string; inputHash: string; runId: string },
): Promise<ScriptWorkflowActivityRecord | null> {
  const row = db
    .prepare(
      `
      select * from workflow_activity
      where run_id = ? and call_path = ? and input_hash = ? and status in ('completed', 'cached')
      order by attempt desc
      limit 1
      `,
    )
    .get(input.runId, input.callPath, input.inputHash) as WorkflowActivityRow | undefined;
  return row ? decodeActivity(row) : null;
}

// 按调用顺序列 activity（call_index asc, id asc），同序用 id 兜底稳定。
export async function listScriptWorkflowActivities(
  db: DatabaseSync,
  input: { runId: string },
): Promise<ScriptWorkflowActivityRecord[]> {
  const rows = db
    .prepare("select * from workflow_activity where run_id = ? order by call_index asc, id asc")
    .all(input.runId) as unknown as WorkflowActivityRow[];
  return rows.map(decodeActivity);
}

/**
 * 追加事件：sequence 由同 run 当前最大值 +1 生成（并发写同 run 依赖 SQLite 写锁
 * 保证不重复）；phase/activityId/payload 可选。返回按 sequence 必读的记录。
 */
// sequence 由同一条 select 的 max(sequence)+1 取得，避免先读后写的窗口。
// 同一 run_id 的并发追加依赖 SQLite 库级写锁串行化，不在应用层加锁。
// phase 与 activityId 缺省时写入 null，payload 走 encodeJson。
// 回读走 mustGetEvent 并传入 runId 与 sequence，不是按 id 查。
// mustGetEvent 查不到记录会抛错，不返回空壳。
export async function appendScriptWorkflowEvent(
  db: DatabaseSync,
  input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  },
): Promise<ScriptWorkflowEventRecord> {
  const now = Date.now();
  const sequenceRow = db
    .prepare(
      `
      select coalesce(max(sequence), 0) + 1 as next_sequence
      from workflow_event where run_id = ?
      `,
    )
    .get(input.runId) as { next_sequence: number } | undefined;
  const sequence = sequenceRow?.next_sequence ?? 1;
  db
    .prepare(
      `
      insert into workflow_event (
        id, run_id, sequence, type, phase, activity_id, payload_json, time_created
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.id,
      input.runId,
      sequence,
      input.type,
      input.phase ?? null,
      input.activityId ?? null,
      encodeJson(input.payload),
      now,
    );
  return mustGetEvent(db, input.runId, sequence);
}

/**
 * 列事件：limit<=0 视为不限。有限量时先取最后 limit 条（sequence desc）再翻回
 * 升序，保证返回的是“最近 N 条且按时间正序”，而不是最早的 N 条。
 */
export async function listScriptWorkflowEvents(
  db: DatabaseSync,
  input: { limit?: number; runId: string },
): Promise<ScriptWorkflowEventRecord[]> {
  const limit = input.limit && input.limit > 0 ? input.limit : undefined;
  const rows = limit
    ? (db
        .prepare(
          `
          select * from (
            select * from workflow_event where run_id = ? order by sequence desc limit ?
          ) order by sequence asc
          `,
        )
        .all(input.runId, limit) as unknown as WorkflowEventRow[])
    : (db
        .prepare("select * from workflow_event where run_id = ? order by sequence asc")
        .all(input.runId) as unknown as WorkflowEventRow[]);
  return rows.map(decodeEvent);
}

/**
 * 建立子会话与工作流任务/活动的映射。child_session_id 是唯一键：冲突时只更新
 * status 与 time_updated（同一子会话被再次登记时保留原始层级/路径/模型信息）。
 * 返回按 child_session_id 必读的记录。
 */
// child_session_id 上有唯一约束，冲突时走 on conflict do update。
// 冲突分支只改 status 与 time_updated 两列。
// path、depth、model 等在重复登记时保留首次写入的值。
// depth 未提供时取 0，根会话与子会话共用同一张表。
// 回读走 mustGetTaskLink 并按 childSessionId 定位，键不是自增 id。
export async function createSessionTaskLink(
  db: DatabaseSync,
  input: CreateSessionTaskLinkInput,
): Promise<SessionTaskLinkRecord> {
  const now = Date.now();
  db
    .prepare(
      `
      insert into session_task_link (
        id, root_workflow_run_id, parent_link_id, activity_id, parent_session_id,
        child_session_id, role, depth, path, phase, label, agent_type, model, status,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(child_session_id) do update set
        status = excluded.status,
        time_updated = excluded.time_updated
      `,
    )
    .run(
      input.id,
      input.rootWorkflowRunId ?? null,
      input.parentLinkId ?? null,
      input.activityId ?? null,
      input.parentSessionId ?? null,
      input.childSessionId,
      input.role,
      input.depth ?? 0,
      input.path,
      input.phase ?? null,
      input.label ?? null,
      input.agentType ?? null,
      input.model ?? null,
      input.status,
      now,
      now,
    );
  return mustGetTaskLink(db, input.childSessionId);
}

// 内部单条读取；不存在返回 null（用于 update 前的存在性检查）。
async function getActivity(
  db: DatabaseSync,
  activityId: string,
): Promise<ScriptWorkflowActivityRecord | null> {
  const row = db.prepare("select * from workflow_activity where id = ?").get(activityId) as
    | WorkflowActivityRow
    | undefined;
  return row ? decodeActivity(row) : null;
}

// 写后必读：activity 缺失说明写入未落盘，throw 让调用方感知而不是继续。
async function mustGetActivity(
  db: DatabaseSync,
  activityId: string,
): Promise<ScriptWorkflowActivityRecord> {
  const activity = await getActivity(db, activityId);
  if (!activity) throw new Error(`Workflow activity not found after write: ${activityId}`);
  return activity;
}

// 写后按 (run, sequence) 必读事件；读不到 → throw。
async function mustGetEvent(
  db: DatabaseSync,
  runId: string,
  sequence: number,
): Promise<ScriptWorkflowEventRecord> {
  const row = db
    .prepare("select * from workflow_event where run_id = ? and sequence = ?")
    .get(runId, sequence) as WorkflowEventRow | undefined;
  if (!row) throw new Error(`Workflow event not found after write: ${runId}:${sequence}`);
  return decodeEvent(row);
}

// 写后按 child_session_id 必读任务链接；读不到 → throw。
async function mustGetTaskLink(
  db: DatabaseSync,
  childSessionId: SessionId,
): Promise<SessionTaskLinkRecord> {
  const row = db
    .prepare("select * from session_task_link where child_session_id = ?")
    .get(childSessionId) as SessionTaskLinkRow | undefined;
  if (!row) throw new Error(`Session task link not found after write: ${childSessionId}`);
  return decodeTaskLink(row);
}
