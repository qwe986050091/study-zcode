// INV-01 一张会话最多一个目标，session_id 是唯一键：守住位置 所有 where 条件与冲突分支；改错故障 同会话出现双目标，计量各写一半。
// INV-02 活跃输入与运行开始时间必须同时为空或同时非空：守住位置 写入与收口语句；改错故障 半开运行态让计时永远为 0 或翻倍。
// INV-03 累计 token 与累计秒数只增不减：守住位置 增量语句；改错故障 重放收口把用量算成负数。
// INV-04 更新时间一律用 max 单调推高：守住位置 所有 update 语句；改错故障 时钟回拨让会话列表顺序倒退。
// INV-05 写入后必须读回校验，读不到直接抛错：守住位置 mustReadTarget；改错故障 写路径与读路径不一致被静默吞掉。
// INV-06 覆盖式设置会重置运行态与计量：守住位置 setSessionTarget 的冲突分支；改错故障 新目标继承旧目标的用量。
// INV-07 fork 复制保留目标标识与创建时间：守住位置 cloneSessionTargetForFork；改错故障 子会话的续跑元数据与父目标对不上。
// INV-08 fork 不复制运行态：守住位置 三列写空的语句；改错故障 子会话显示「幽灵运行中」。
// INV-09 惰性创建用 insert or ignore，并以新标识判定是否新建：守住位置 createSessionTarget；改错故障 并发首条输入各建一个目标。
// INV-10 状态更新未命中时返回 null，不做隐式插入：守住位置 updateSessionTargetStatus；改错故障 删除后又冒出空目标。
// INV-11 启动运行必须带目标标识与活跃状态条件：守住位置 startSessionTargetRun 的 where；改错故障 已替换的目标被旧轮次挂上运行态。
// INV-12 心跳只推进最后在线时间，且用 max 与 coalesce 保证单调：守住位置 heartbeatSessionTargetRun；改错故障 乱序心跳让最后在线时间回退。
// INV-13 收口用旧输入与旧开始时间做比对更新：守住位置 finishSessionTargetRun 的 where；改错故障 重复收口累加两次用量。
// INV-14 未显式给状态时，达预算自动转受限态：守住位置 状态 case 表达式；改错故障 超预算目标继续以活跃态计费。
// INV-15 崩溃恢复以最后心跳作为结束时间：守住位置 recoverInterruptedSessionTargetRun；改错故障 离线时长被计入运行时长。
// INV-16 恢复后活跃转暂停，其余状态保持：守住位置 状态推导；改错故障 人工暂停被恢复成运行中。
// INV-17 直接记账在双增量为 0 时短路只读：守住位置 accountSessionTargetUsage 首段；改错故障 空记账也触发写入与时间戳推进。
// INV-18 概要标题写回带目标标识条件：守住位置 updateSessionTargetSummaryTitle；改错故障 旧目标的异步标题覆盖新目标。
//
// 模块职责：session_target 表的读写原语，负责目标生命周期、运行计时与用量累计。
// 状态所有权：目标行是本模块唯一事实源；会话活跃时间顺带单调推进，不回写其它会话字段。
// 阅读顺序：先看行结构与读取，再读设置、fork 与惰性创建，最后看运行开始、心跳、收口、恢复与记账。
// ============================================================
// SQLite session target helpers
// ============================================================
// 定位：session_target（会话目标 / goal）表的读写原语，供 session store 组合调用。
// 一张会话最多一个 target（session_id 唯一），记录 objective、预算与运行计时。
// 输入输出：read 返回 SessionGoal 或 null；写操作返回最新行（写入后必读），
// 未命中（changes=0）时返回当前行或 null，由调用方判断是否冲突。
// 副作用：insert/update/delete session_target，并顺带把 session.time_updated
// 单调推高（touchSessionForTarget），让会话列表按活跃度排序能看到目标变更。
// 失败语义：写入后读不到行 → throw；不使用事务，单条语句即原子，多语句组合
// 由上层事务包裹；active run 的收口使用 CAS（where 带旧的 input/started_at）。
// 不变量：active_input_id 与 active_run_started_at 必须同时非空或同时为空；
// tokens_used / time_used_seconds 只增不减；time_updated 使用 max() 单调递增。

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionId, SessionGoal, GoalStatus } from "@zcode/contracts";

interface TargetRow {
  session_id: string;
  target_id: string;
  objective: string;
  /** 异步生成的概要标题；null 表示尚未生成或已被清空。 */
  summary_title: string | null;
  /** GoalStatus：active / paused / budget_limited 等，字符串存储以兼容演进。 */
  status: string;
  /** token 预算上限；null 表示不限额。 */
  token_budget: number | null;
  /** 累计消耗 token 数，单调递增，单位 token。 */
  tokens_used: number;
  /** 累计运行秒数，按 active_run_last_seen_at 与开始时刻的差累加并向上取整。 */
  time_used_seconds: number;
  /** 当前正在结算的 session_input id；null 表示没有运行中的 run。 */
  active_input_id: string | null;
  /** 当前 run 开始时间（epoch ms）；null 表示无活跃 run。 */
  active_run_started_at: number | null;
  /** 最后一次心跳时间（epoch ms）；用于崩溃恢复时截断离线时长。 */
  active_run_last_seen_at: number | null;
  /** 创建时间 epoch ms。 */
  time_created: number;
  /** 最后更新时间 epoch ms，所有写入用 max() 保持单调。 */
  time_updated: number;
}

// 读取会话目标；无目标行返回 null（调用方据此区分“未设置 goal”与“已清空”）。
// 读取是零副作用的：不触碰会话时间戳，也不做缺失补建。
// 返回 null 表示该会话从未设置过目标。
// 行到领域对象的转换由解码函数统一负责，调用方不见列名。
// [并发] 单条查询不加锁，读到的是语句开始时的快照。
// 查询走主键，调用方无需额外索引。
export function readSessionTarget(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const row = db
    .prepare("select * from session_target where session_id = ?")
    .get(input.sessionID) as TargetRow | undefined;
  return row ? decodeTargetRow(row) : null;
}

/**
 * 覆盖式设置目标：同一 session 已存在目标时整行替换（on conflict update），
 * 新 target_id、重置 tokens/time_used 与 active run 字段。用于用户明确设置/替换 goal。
 * 返回写入后的最新行；写入后读不到 → throw（说明并发删除或事务异常）。
 */
// [事务] 单条 upsert 自身原子，跨语句的多步组合由上层事务包裹。
// 覆盖语义：新目标标识、清零用量、清空运行态与概要标题。
// 创建与更新时间同取一次当前时刻，保证首帧一致。
// 写入成功后单调推高会话更新时间，让列表按活跃度排序可见。
// 读回失败说明并发删除或事务异常，直接抛错而不是返回空。
export function setSessionTarget(
  db: DatabaseSync,
  input: {
    objective: string;
    sessionID: SessionId;
    status: GoalStatus;
    tokenBudget?: number | null;
  },
): SessionGoal {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
    ) values (?, ?, ?, null, ?, ?, 0, 0, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
    `,
  ).run(
    input.sessionID,
    targetID,
    input.objective,
    input.status,
    input.tokenBudget ?? null,
    now,
    now,
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

/**
 * fork 时把父会话目标复制到子会话：保留 target_id 与原始时间戳，不复制运行态
 * （active_input_id / run 时间戳强制为 null），避免子会话显示“幽灵运行中”。
 * status 由调用方指定，不会从父目标继承。
 */
// fork 是会话状态分支而不是新建目标，因此沿用一个目标标识。
// 创建时间沿用父目标，保证已复制的续跑元数据继续对齐。
// 运行态三列强制为空，子会话不得继承父会话的进行中运行。
// 状态由调用方指定，不继承父目标，避免已完成状态被复制。
export function cloneSessionTargetForFork(
  db: DatabaseSync,
  input: {
    source: SessionGoal;
    sessionID: SessionId;
    status: GoalStatus;
  },
): SessionGoal {
  const now = Date.now();
  const source = input.source;
  // fork 是 session state branch，不是新建 goal。必须保留 target_id 和
  // 原始 created time，让已复制的 goal-continuation / verifier metadata 能继续对齐。
  // active run 字段属于父 session 当前运行态，child 不能继承，否则会显示幽灵运行中。
  db.prepare(
    `
    insert into session_target (
      session_id,
      target_id,
      objective,
      summary_title,
      status,
      token_budget,
      tokens_used,
      time_used_seconds,
      active_input_id,
      active_run_started_at,
      active_run_last_seen_at,
      time_created,
      time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
    `,
  ).run(
    input.sessionID,
    source.targetID,
    source.objective,
    source.summaryTitle,
    input.status,
    source.tokenBudget,
    source.tokensUsed,
    source.timeUsedSeconds,
    source.time.created,
    source.time.updated,
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

/**
 * 仅在目标不存在时创建（insert or ignore，status=active，预算可选）。
 * 返回 null 表示已有目标、本次未写入；否则返回新建行。用于从首条输入惰性建目标。
 */
// 只在新会话首次输入时惰性创建，已有目标时什么都不做。
// 用新标识比对该行判断本次是否真的插入，而不是看变更数。
// 已有目标时返回 null，调用方据此跳过后续初始化。
// 新建行的状态固定活跃、用量归零、预算可空。
export function createSessionTarget(
  db: DatabaseSync,
  input: { objective: string; sessionID: SessionId; tokenBudget?: number | null },
): SessionGoal | null {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert or ignore into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
    ) values (?, ?, ?, null, 'active', ?, 0, 0, ?, ?)
    `,
  ).run(input.sessionID, targetID, input.objective, input.tokenBudget ?? null, now, now);

  const target = readSessionTarget(db, { sessionID: input.sessionID });
  if (target?.targetID !== targetID) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return target;
}

// 只改 status 与 time_updated；目标不存在（changes=0）返回 null，不做隐式插入。
export function updateSessionTargetStatus(
  db: DatabaseSync,
  input: { sessionID: SessionId; status: GoalStatus },
): SessionGoal | null {
  const now = Date.now();
  const result = db
    .prepare(
      `
      update session_target
      set status = ?, time_updated = ?
      where session_id = ?
      `,
    )
    .run(input.status, now, input.sessionID);
  if (result.changes === 0) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

/**
 * 标记某个 session_input 对应的 run 开始：写 active_input_id + 起止/心跳时间，
 * 条件带 target_id 与 status='active'（非 active 目标不进入运行态）。
 * 未命中时返回当前行（可能已被并发收口），不报错，实现幂等。
 */
export function startSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  },
): SessionGoal | null {
  const startedAt = Math.max(0, input.startedAtMs);
  // goal live 计时必须跟随 agent 运行边界落库，不能再由 UI 从 assistant
  // message timestamp 反推；恢复 snapshot 时该 timestamp 可能是旧轮次，导致切回后异常增长。
  const result = db
    .prepare(
      `
      update session_target
      set
        active_input_id = ?,
        active_run_started_at = ?,
        active_run_last_seen_at = ?,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and status = 'active'
      `,
    )
    .run(input.inputID, startedAt, startedAt, startedAt, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, startedAt);
  return mustReadTarget(db, input.sessionID);
}

/**
 * 运行中心跳：仅在 active_input_id 匹配且已有 started_at 时推进 last_seen_at，
 * 取 max(coalesce(...)) 保证单调（乱序/重复心跳不会回退）。
 */
export function heartbeatSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  },
): SessionGoal | null {
  const seenAt = Math.max(0, input.seenAtMs);
  const result = db
    .prepare(
      `
      update session_target
      set
        active_run_last_seen_at = max(coalesce(active_run_last_seen_at, 0), ?),
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at is not null
      `,
    )
    .run(seenAt, seenAt, input.sessionID, input.targetID, input.inputID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, seenAt);
  return mustReadTarget(db, input.sessionID);
}

/**
 * 收口一次 run：累加 token/time、可选覆盖 status，并在未显式给 status 时
 * 若 active 且 token 达预算则自动转 budget_limited；随后清空 active run 字段。
 * CAS 条件带上旧的 active_input_id + started_at，重复收口第二次 changes=0，只读返回。
 */
// 先读当前行做前置校验，避免无谓写入。
// [事务] 收口语句同时累加用量、推导状态并清空运行态。
// 比对条件带旧输入与旧开始时间，第二次收口自然未命中。
// 未命中时返回当前行，调用方可见「已被别处收口」而无需重试。
export function finishSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (
    !current ||
    current.targetID !== input.targetID ||
    current.activeInputId !== input.inputID ||
    current.activeRunStartedAtMs == null
  ) {
    return current;
  }

  const endedAt = Math.max(0, input.endedAtMs);
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when ? is not null then ?
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          else status
        end,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      tokenDelta,
      timeDelta,
      input.status ?? null,
      input.status ?? null,
      tokenDelta,
      endedAt,
      input.sessionID,
      input.targetID,
      input.inputID,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  return mustReadTarget(db, input.sessionID);
}

/**
 * 崩溃/退出后的恢复收口：用 last_seen_at（缺失则 started_at）作为结束时间，
 * 而不是 Date.now()，避免把应用离线时间计进运行时长；active → paused。
 * 没有活跃 run 时直接返回当前行，不产生写入。
 */
// 有活跃运行才需要恢复，否则原样返回。
// 结束时间取 active_run_last_seen_at；缺失时退回 active_run_started_at，绝不用 Date.now()。
// 只把活跃转暂停，其余状态保持不变。
// 恢复同样带比对条件，避免与正常收口竞争时重复计时。
export function recoverInterruptedSessionTargetRun(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (!current || !current.activeInputId || current.activeRunStartedAtMs == null) {
    return current;
  }

  // 进程崩溃/退出后，active_run_started_at 只能说明上次没有正常收口。
  // 恢复时不能用 Date.now() 结算，否则 app 离线时间会被计入 goal 运行时长。
  const endedAt = current.activeRunLastSeenAtMs ?? current.activeRunStartedAtMs;
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const nextStatus: GoalStatus = current.status === "active" ? "paused" : current.status;
  const result = db
    .prepare(
      `
      update session_target
      set
        time_used_seconds = time_used_seconds + ?,
        status = ?,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      timeDelta,
      nextStatus,
      endedAt,
      input.sessionID,
      current.targetID,
      current.activeInputId,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  return mustReadTarget(db, input.sessionID);
}

/**
 * 直接记账（不经 run 生命周期）：累加 token/time 并更新预算状态。
 * 两个 delta 都为 0 时短路只读返回；条件带 target_id，避免写到被替换的新目标上。
 */
export function accountSessionTargetUsage(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  },
): SessionGoal | null {
  const now = Date.now();
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = Math.max(0, input.timeUsedSecondsDelta ?? 0);
  if (tokenDelta === 0 && timeDelta === 0) {
    return readSessionTarget(db, { sessionID: input.sessionID });
  }

  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          else status
        end,
        time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(tokenDelta, timeDelta, tokenDelta, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

/**
 * 写回异步生成的概要标题。带 target_id 条件做 CAS，防止旧 objective 的
 * 标题 sidecar 迟到后覆盖用户已 replace 的新目标。
 */
export function updateSessionTargetSummaryTitle(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  },
): SessionGoal | null {
  const now = Date.now();
  // goal 概要由异步 title sidecar 生成；用户可能在模型返回前 replace/clear goal。
  // 必须带 target_id 条件写回，避免旧 objective 的概要覆盖新目标。
  const result = db
    .prepare(
      `
      update session_target
      set summary_title = ?, time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(input.summaryTitle, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

// 删除目标；返回 boolean 表示是否真的删掉了行（false = 本来就不存在）。
export function clearSessionTarget(db: DatabaseSync, input: { sessionID: SessionId }): boolean {
  const now = Date.now();
  const result = db.prepare("delete from session_target where session_id = ?").run(input.sessionID);
  if (result.changes === 0) return false;
  touchSessionForTarget(db, input.sessionID, now);
  return true;
}

// 写入后必须能读回刚写的行；读不到说明写路径与读路径不一致，直接 throw。
function mustReadTarget(db: DatabaseSync, sessionID: SessionId): SessionGoal {
  const target = readSessionTarget(db, { sessionID });
  if (!target) {
    throw new Error(`Session target not found after write: ${sessionID}`);
  }
  return target;
}

// goal 变更也算会话变更：用 max() 单调推高 session.time_updated，不倒退。
function touchSessionForTarget(db: DatabaseSync, sessionID: SessionId, timeUpdated: number): void {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    sessionID,
  );
}

// 行 → 领域对象：snake_case 转 camelCase，时间字段聚合为 time{created,updated}。
function decodeTargetRow(row: TargetRow): SessionGoal {
  return {
    sessionID: row.session_id as SessionId,
    targetID: row.target_id,
    objective: row.objective,
    summaryTitle: row.summary_title,
    status: row.status as GoalStatus,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    activeInputId: row.active_input_id,
    activeRunStartedAtMs: row.active_run_started_at,
    activeRunLastSeenAtMs: row.active_run_last_seen_at,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  };
}

// target id 生成：时间前缀便于排序，随机后缀保证唯一（无需查库自增）。
function createStorageTargetId(): string {
  return `target_${Date.now().toString(36)}_${randomUUID()}`;
}

// 秒数向上取整且非负：避免系统时钟回拨产生负时长。
function elapsedSecondsBetween(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, Math.ceil((endedAtMs - startedAtMs) / 1000));
}
