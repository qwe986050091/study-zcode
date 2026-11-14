// ============================================================
// Usage repositories (model / turn / tool)
// ============================================================
// 定位：三张用量表的写入与聚合查询。model_usage 按一次模型请求一行；turn_usage
// 按 (session_id, turn_id) 一行、随轮次推进合并；tool_usage 按工具调用一行。
// 输入输出：record/upsert 无返回值；queryAppUsage 返回跨表聚合（totals/turnTotals/
// toolTotals/models/tools/days/dayModels）；queryTaskUsage 返回单会话计数。
// 副作用：insert/update + 每次写入后调用 pruneUsage（保留 30 天前的数据会被删除），
// pruneUsage 在 `begin immediate` 内三表删除，失败 rollback。
// 失败语义：SQL 异常直接抛出；prune 失败回滚且不影响本次写入（写入已单独提交）。
// 不变量：token/字节等计数非负取整；completed_at/duration 等“已有值”用 coalesce
// 不被后续空值覆盖；started_at 取 min；tool 终态不会因迟到的 running 回退；
// task usage 的 input 口径必须扣除 compact 基线，且压缩后基线随新值下调。

// 职责边界（usage.ts）：只负责 model_usage / turn_usage / tool_usage 三张用量表的
// 写入（recordModelUsage / upsertTurnUsage / upsertToolUsage）、保留期清理（pruneUsage）
// 与两类只读聚合（queryAppUsage 跨会话统计、queryTaskUsage 单会话口径）。
// 做：领域记录 → SQL 参数映射、维护各表合并语义、按固定时区偏移切日、扣除 compact 基线。
// 不做：不计算 provider 计费、不决定保留策略、不做 migration、不发事件、不重试。
// 依赖：node:sqlite 的同步 DatabaseSync、@zcode/contracts 行类型、encodeJson。
// 边界：db 已打开且不在调用方事务内；每次写入是「单语句 + prune」两步，非原子，
// 写入已提交而 prune 失败时旧数据仍在，调用方看到的异常只代表清理失败。
//
// INV-01 断言：input 侧 token 优先 inputTokens，仅当它为 0 才回退 cache 读写之和 —— 守住它的位置：inputSideTokensFromNormalizedUsage 与 inputSideTokensFromStoredUsage 的返回处 —— 改错故障：无条件叠加 cache 会让 AI SDK v6 已含 cache 的历史行重复计数，task 用量虚高。
// INV-02 断言：历史行 cache 归属用 providerTotalTokens 的距离比较判定，不做版本探测 —— 守住它的位置：inputSideTokensFromStoredUsage 末尾 —— 改错故障：改成「input 永远含 cache」会让旧格式行少算 cache 写读，改成「永远加 cache」会让新格式行多算一倍。
// INV-03 断言：computed_total_tokens 缺省时按 input 侧 + output 计算，不用 provider 总值兜底 —— 守住它的位置：recordModelUsage 顶部 computedTotalTokens —— 改错故障：provider 总值缺失时统计归零，days 曲线整段塌陷。
// INV-04 断言：model_usage 的 upsert 覆盖全部列（不用 coalesce 保护旧值） —— 守住它的位置：on conflict(id) do update set 列表 —— 改错故障：重试的 attempt 只能拿到部分字段时，旧 attempt 的错误码/耗时残留，聚合 avg 被污染；反过来说这里也不许改成「只增不减」。
// INV-05 断言：turn_usage 的 started_at 取 min，first_* / completed_at / error_* 用 coalesce 且方向一致（旧值优先或新值优先必须成对） —— 守住它的位置：on conflict(session_id, turn_id) 分支 —— 改错故障：把 completed_at 写回 null 会让「进行中」快照抹掉终态，前端永远转圈。
// INV-06 断言：turn_usage 计数类字段用 excluded 直接覆盖，不在 SQL 里做累加 —— 守住它的位置：model_request_count / tool_call_count 等赋值 —— 改错故障：改成 sum 后同一轮被重复上报两次就翻倍；调用方已传入累计值。
// INV-07 断言：tool 终态（completed/error/cancelled）不被迟到的 running 回退 —— 守住它的位置：status 的 case when 表达式 —— 改错故障：乱序帧把已完成工具刷回运行中，UI 永久等待且 tool_call_count 与错误率失真。
// INV-08 断言：tool_name 为 unknown 时不覆盖已有名字 —— 守住它的位置：tool_name 的 case when 表达式 —— 改错故障：晚到的占位记录把真实工具名擦成 unknown，按工具聚合全部塌到一个桶。
// INV-09 断言：output_bytes / stdout_bytes / stderr_bytes / truncated 只取 max —— 守住它的位置：对应 update 赋值 —— 改错故障：增量快照携带较小中间值时会回退，截断标记丢失后大输出被当作完整结果。
// INV-10 断言：toolUsageValues 的参数顺序与 insert 列顺序逐项对应，undefined 保留 NULL —— 守住它的位置：toolUsageValues 数组 —— 改错故障：错位不会报错，只会把 approval_status 写进 read_only 这类位置，布尔/文本悄悄互换。
// INV-11 断言：pruneUsage 三表删除在 begin immediate 事务内，异常 rollback 后原样抛出 —— 守住它的位置：pruneUsage 的 try/catch —— 改错故障：吞掉异常会让调用方以为清理成功；拆成三事务会出现「模型删了、轮次没删」的半清理状态。
// INV-12 断言：所有计数入库前经 integer 归一为非负整数，非法值按 0 —— 守住它的位置：integer 函数与每个 integer(...) 调用点 —— 改错故障：NaN/负数入库后 sum 结果变 NaN 或负数，整张报表静默归零。
// INV-13 断言：三态布尔用 nullableBoolean 写 NULL，普通布尔用 0/1 —— 守住它的位置：nullableBoolean 与 boolean —— 改错故障：把未观测的 undefined 写成 false 会把「未知」呈现为「非破坏性」，权限审计结论反转。
// INV-14 断言：queryAppUsage 的时间窗口是闭区间 [since, until] —— 守住它的位置：每条 where started_at >= ? and started_at <= ? —— 改错故障：改成开区间后与前端按日分桶边界差一条，末帧数据日消失。
// INV-15 断言：按日分桶只用固定偏移 tzOffsetMs，不读数据库时区 —— 守住它的位置：dayIndex 的 cast 表达式 —— 改错故障：依赖本地时区会让同一份数据在跨时区机器上给出不同日曲线；DST 边界 1 小时误差是已接受的取舍。
// INV-16 断言：avg 类字段无样本返回 null，计数与求和类返回 0 —— 守住它的位置：queryAppUsage 返回对象里的 ?? 0 与 == null 判断 —— 改错故障：把 null 折成 0 后前端显示「平均 0ms」，与「无数据」不可区分。
// INV-17 断言：days 合并必须三类来源都要喂养同一个 dayMap，且按 dayIndex 升序输出 —— 守住它的位置：dayMap 的三段循环 + sort —— 改错故障：只从 model_usage 起桶会丢掉「只有轮次没有模型请求」的日期，日历出现空洞。
// INV-18 断言：queryTaskUsage 的 input 只累加超出历史基线的增量，基线随后下调到当前 input —— 守住它的位置：incrementalInputTokens 与 baseline 赋值处 —— 改错故障：按全量累加会让长会话上下文重复计数；压缩后不回扣但也不降基线，则后续每轮都按压缩前的高水位重复计入。
// INV-19 断言：cache 读写只对非基线来源（如 compact）全量累加 —— 守住它的位置：source === undefined 分支 —— 改错故障：基线来源也加 cache 会让 main_turn 的缓存命中被当作新增消耗。
// INV-20 断言：modelRequestCount 是行数，不是成功请求数 —— 守住它的位置：queryTaskUsage 返回的 rows.length —— 改错故障：改成过滤 error 后会让「请求数」口径与 model_usage 行数不一致，错误率分母错位。
//
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  AppUsageDayModelRow,
  AppUsageDayRow,
  AppUsageModelRow,
  AppUsageQueryInput,
  AppUsageQueryResult,
  AppUsageToolRow,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  ModelUsageRecord,
  ToolUsageRecord,
  TurnUsageRecord,
} from "@zcode/contracts";
import { encodeJson } from "../json.js";

// 用量保留期：30 天。所有写入后都会触发一次 prune，避免表无限增长。
// [资源] 保留期 30 天是产品承诺，不是可随手调的缓存 TTL：下调会删掉用户仍在对账的历史曲线，上调会让三张表无限膨胀。
// prune 由每次写入顺带触发，因此写入频率决定清理频率；写入稀疏时旧数据会多留一阵，这属于可接受偏差，不要改成定时器。
// 调用方若要「先写后读」的一致性快照，必须自己控制顺序：prune 可能在本事务之外删掉刚跨过期限的行。
// debug 时不要手工把这里改小来验证删除，测试用 beforeTime 参数即可，否则会把本机真实用量表清空。
const USAGE_RETENTION_DAYS = 30;
const USAGE_RETENTION_MS = USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * 记录一次模型请求（按 id upsert）。computed_total_tokens 在调用方未给时，
 * 用 input 侧 token + output 兜底；attempt 正在重试时同 id 会被覆盖成最新值。
 * 写入后触发 prune（可能删掉 30 天前的行）。reasoningLevel 写入历史列 variant。
 */
export async function recordModelUsage(db: DatabaseSync, input: ModelUsageRecord): Promise<void> {
  // [权衡] 这里的顺序不能交换：先算出 input 侧，再叠加 output；cache 字段只在 inputTokens 为 0 时参与，见 INV-01。
  // 拿不到 provider 总值时才走这条兜底路径；一旦 provider 给了总值，聚合里用的是 provider 值，两者口径不同不能混算。
  // attempt 重试会以同 id 覆盖整行，所以这里算出来的值必须自洽，不能依赖上一次 attempt 残留的列。
  // 把 output 也算进 input 侧是常见误改：output 在 turn 汇总里另有累加，重复计入会让 turn 用量超过 model 用量。
  const computedTotalTokens =
    input.computedTotalTokens ??
    inputSideTokensFromNormalizedUsage(
      input.inputTokens,
      input.cacheCreationInputTokens,
      input.cacheReadInputTokens,
    ) + integer(input.outputTokens);

  // [契约] 映射是单向的：领域层叫 reasoningLevel，库里叫 variant，改列名需要 migration，改字段名会静默写空。
  // 拒绝顺手把列名改新：旧 CLI 版本仍按 variant 读，混合版本会出现一半有值一半 NULL。
  // 列顺序即参数顺序，下面的 values 占位符分四行排布只是为了可读，不要重排。
  // 数据库沿用 0010 创建的历史列名；领域层使用更准确的 reasoningLevel。
  db.prepare(
    `
      insert into model_usage (
        id,
        logical_request_id,
        attempt_index,
        session_id,
        turn_id,
        trace_id,
        span_id,
        assistant_message_id,
        parent_user_message_id,
        query_source,
        provider_id,
        model_id,
        variant,
        agent,
        mode,
        task_type,
        status,
        started_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        finish_reason,
        tool_call_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        provider_total_tokens,
        computed_total_tokens,
        retry_count,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code,
        error_message,
        raw_usage_json,
        provider_metadata_json
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        logical_request_id = excluded.logical_request_id,
        attempt_index = excluded.attempt_index,
        session_id = excluded.session_id,
        turn_id = excluded.turn_id,
        trace_id = excluded.trace_id,
        span_id = excluded.span_id,
        assistant_message_id = excluded.assistant_message_id,
        parent_user_message_id = excluded.parent_user_message_id,
        query_source = excluded.query_source,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        variant = excluded.variant,
        agent = excluded.agent,
        mode = excluded.mode,
        task_type = excluded.task_type,
        status = excluded.status,
        started_at = excluded.started_at,
        first_token_at = excluded.first_token_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms,
        time_to_first_token_ms = excluded.time_to_first_token_ms,
        finish_reason = excluded.finish_reason,
        tool_call_count = excluded.tool_call_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        provider_total_tokens = excluded.provider_total_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = excluded.error_type,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        raw_usage_json = excluded.raw_usage_json,
        provider_metadata_json = excluded.provider_metadata_json
      `,
  ).run(
    input.id,
    input.logicalRequestId,
    integer(input.attemptIndex),
    input.sessionID,
    input.turnID ?? null,
    input.traceID ?? null,
    input.spanID ?? null,
    input.assistantMessageID ?? null,
    input.parentUserMessageID ?? null,
    input.querySource,
    input.providerId,
    input.modelId,
    input.reasoningLevel ?? null,
    input.agent ?? null,
    input.mode ?? null,
    input.taskType ?? null,
    input.status,
    input.startedAt,
    input.firstTokenAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstTokenMs ?? null,
    input.finishReason ?? null,
    integer(input.toolCallCount),
    integer(input.inputTokens),
    integer(input.outputTokens),
    integer(input.reasoningTokens),
    integer(input.cacheCreationInputTokens),
    integer(input.cacheReadInputTokens),
    input.providerTotalTokens ?? null,
    computedTotalTokens,
    integer(input.retryCount),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    boolean(input.contextExceeded),
    input.errorType ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    encodeJson(input.rawUsage),
    // [失败路径] raw_usage_json 与 provider_metadata_json 是唯一的原始证据，抛错时不要为了「写进主流程」而跳过它们。
    // encodeJson 不接受 undefined，调用方的可选字段已经在上文统一折成 null，别在这里改成 input.providerMetadata ?? undefined。
    // 这条 prepare/run 是同步的：异常直接冒泡到调用方，本函数不再包装，避免丢失 sqlite 的错误码。
    // 运行到这里时前面的列已经全部绑定，抛错意味着整条 insert 未生效，不存在半行写入。
    encodeJson(input.providerMetadata),
  );
  // [事务] 写入语句与 prune 是两个独立事务：prune 失败只回滚删除，本行已经提交。
  // 所以调用方收到异常时不能假设记录没写进去；重试前应先按 id 读一次，否则会重复计数（虽然 upsert 幂等，但事件/日志会重复）。
  await pruneUsage(db);
}

/**
 * 轮次用量合并写入（键 session_id+turn_id）。同一轮的多次调用会叠加/修正：
 * started_at 取更早值，首次时间戳只填一次，计数类字段用最新值（由调用方传入
 * 累计后结果），error/completed 仅在非空时覆盖，避免“进行中”快照抹掉终态。
 */
export async function upsertTurnUsage(db: DatabaseSync, input: TurnUsageRecord): Promise<void> {
  // [契约] turn_usage 的唯一键是 (session_id, turn_id)，不是 id：同一轮没有独立主键，所有合并都压在这一个 conflict 分支上。
  // started_at 用 min 是刻意的：多次上报可能来自不同阶段，最早的那个才是轮次真实起点。
  // 计数类字段整列覆盖，因为调用方传的是「本轮累计值」；在 SQL 里再加一次就翻倍（见 INV-06）。
  // 不要为「只更新部分列」加 update 分支：两条写入路径会让终态与计数来自不同快照。
  db.prepare(
    `
      insert into turn_usage (
        session_id,
        turn_id,
        trace_id,
        user_message_id,
        status,
        started_at,
        first_model_start_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        model_request_count,
        model_retry_count,
        tool_call_count,
        tool_error_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        computed_total_tokens,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      on conflict(session_id, turn_id) do update set
        trace_id = coalesce(excluded.trace_id, turn_usage.trace_id),
        user_message_id = coalesce(excluded.user_message_id, turn_usage.user_message_id),
        status = excluded.status,
        started_at = min(turn_usage.started_at, excluded.started_at),
        first_model_start_at = coalesce(turn_usage.first_model_start_at, excluded.first_model_start_at),
        first_token_at = coalesce(turn_usage.first_token_at, excluded.first_token_at),
        completed_at = coalesce(excluded.completed_at, turn_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, turn_usage.duration_ms),
        time_to_first_token_ms = coalesce(excluded.time_to_first_token_ms, turn_usage.time_to_first_token_ms),
        model_request_count = excluded.model_request_count,
        model_retry_count = excluded.model_retry_count,
        tool_call_count = excluded.tool_call_count,
        tool_error_count = excluded.tool_error_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = coalesce(excluded.error_type, turn_usage.error_type),
        error_code = coalesce(excluded.error_code, turn_usage.error_code)
      `,
  ).run(
    input.sessionID,
    input.turnID,
    input.traceID ?? null,
    input.userMessageID ?? null,
    input.status,
    input.startedAt,
    // [并发] 三个首字节/首模型时间只填一次（coalesce 旧值优先），并发写不会互相覆盖成后到者。
    // 重排参数顺序会把 first_model_start_at 与 first_token_at 互换，两者都有值时不报错，TTFT 曲线整体错位。
    input.firstModelStartAt ?? null,
    input.firstTokenAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstTokenMs ?? null,
    integer(input.modelRequestCount),
    integer(input.modelRetryCount),
    integer(input.toolCallCount),
    integer(input.toolErrorCount),
    integer(input.inputTokens),
    integer(input.outputTokens),
    integer(input.reasoningTokens),
    integer(input.cacheCreationInputTokens),
    integer(input.cacheReadInputTokens),
    integer(input.computedTotalTokens),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    boolean(input.contextExceeded),
    input.errorType ?? null,
    input.errorCode ?? null,
  );
  // [事务] 与 model 行同理：本轮用量已提交，清理失败不撤销写入。
  // 轮次是最常被按日聚合的表，因此 prune 失败的表现是「旧日期突然变多」，不是数据丢失。
  await pruneUsage(db);
}

/**
 * 工具调用记录（按 id upsert）。合并规则偏向“只增不减”：
 * tool_name=unknown 不覆盖已知名字；终态 completed/error/cancelled 不被迟到的
 * running 覆盖；输出字节/truncated 取 max；started_at 取 min；错误信息 coalesce。
 */
export async function upsertToolUsage(db: DatabaseSync, input: ToolUsageRecord): Promise<void> {
  // [契约] tool_usage 的唯一键是 id，且合并规则整体偏向「只增不减」，与 model_usage 的全列覆盖刻意不同。
  // 两套合并语义不能统一：工具调用是增量上报（先 running 后 completed），模型请求是终态快照。
  // 注意 side_effect_scope / read_only / destructive 只用 coalesce 保护旧值：晚到的空值不能把已声明的权限语义擦掉。
  db.prepare(
    `
      insert into tool_usage (
        id,
        session_id,
        turn_id,
        trace_id,
        tool_call_id,
        tool_name,
        side_effect_scope,
        read_only,
        destructive,
        approval_status,
        status,
        started_at,
        first_output_at,
        completed_at,
        duration_ms,
        time_to_first_output_ms,
        exit_code,
        output_bytes,
        stdout_bytes,
        stderr_bytes,
        truncated,
        retry_count,
        retryable,
        cancelled_by_user,
        error_type,
        error_code,
        error_message
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        turn_id = coalesce(excluded.turn_id, tool_usage.turn_id),
        trace_id = coalesce(excluded.trace_id, tool_usage.trace_id),
        tool_call_id = excluded.tool_call_id,
        tool_name = case
          when excluded.tool_name = 'unknown' then tool_usage.tool_name
          else excluded.tool_name
        end,
        side_effect_scope = coalesce(excluded.side_effect_scope, tool_usage.side_effect_scope),
        read_only = coalesce(excluded.read_only, tool_usage.read_only),
        destructive = coalesce(excluded.destructive, tool_usage.destructive),
        approval_status = coalesce(excluded.approval_status, tool_usage.approval_status),
        status = case
          when tool_usage.status in ('completed', 'error', 'cancelled') and excluded.status = 'running'
            then tool_usage.status
          else excluded.status
        end,
        started_at = min(tool_usage.started_at, excluded.started_at),
        first_output_at = coalesce(tool_usage.first_output_at, excluded.first_output_at),
        completed_at = coalesce(excluded.completed_at, tool_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, tool_usage.duration_ms),
        time_to_first_output_ms = coalesce(excluded.time_to_first_output_ms, tool_usage.time_to_first_output_ms),
        exit_code = coalesce(excluded.exit_code, tool_usage.exit_code),
        output_bytes = max(tool_usage.output_bytes, excluded.output_bytes),
        stdout_bytes = max(tool_usage.stdout_bytes, excluded.stdout_bytes),
        stderr_bytes = max(tool_usage.stderr_bytes, excluded.stderr_bytes),
        truncated = max(tool_usage.truncated, excluded.truncated),
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        error_type = coalesce(excluded.error_type, tool_usage.error_type),
        error_code = coalesce(excluded.error_code, tool_usage.error_code),
        error_message = coalesce(excluded.error_message, tool_usage.error_message)
      `,
  ).run(...toolUsageValues(input));
  // [资源] 工具行是三者中增长最快的（每个 tool call 一行），因此这条 prune 最关键。
  // 写入成功而 prune 失败时最坏情况是表膨胀，不会读到错误数据；不要为了避免膨胀把 prune 放到写入之前。
  await pruneUsage(db);
}

/**
 * 删除 started_at 早于截止点的三类用量行；beforeTime 缺省为 now-30d。
 * 在 `begin immediate` 事务中三表一起删，保证不会出现“模型删了、轮次没删”的
 * 半清理状态；失败 rollback 后抛出。空区间（未来时间）也不会报错。
 */
export async function pruneUsage(
  db: DatabaseSync,
  input: { beforeTime?: number } = {},
): Promise<void> {
  // [事务] beforeTime 在事务外计算一次，保证三条 delete 使用同一个截止点；放到事务内重算会跨过毫秒边界。
  // 未来时间不会报错，只会删空；调用方若传错单位（秒 vs 毫秒）会一次性清空全部历史，这是最危险的误用。
  // 测试传入固定时间即可复现，不要依赖系统时钟。
  // 默认值每次都重新取 now，所以同一进程内两次调用可能落在不同边界，属预期。
  const beforeTime = input.beforeTime ?? Date.now() - USAGE_RETENTION_MS;
  // [并发] 用 immediate 而不是默认 deferred：三表删除要立刻拿写锁，避免升级锁时被其他写者打断。
  // 这里假设 db 上没有外层事务；若调用方已开启事务，begin 会抛错，这是刻意保留的早期失败。
  // 三表必须同一事务，否则会出现「模型删了、轮次没删」的半清理状态（见 INV-11）。
  // 不要把 try 包到 commit 之外再去 await 其他异步工作：同步 sqlite 事务期间不应让出事件循环。
  db.exec("begin immediate");
  try {
    db.prepare("delete from model_usage where started_at < ?").run(beforeTime);
    // [失败路径] 中途失败时已执行的 delete 由 rollback 撤销，异常原样抛出，不做降级。
    // 不要在这里单独 catch 后继续删下一张表：部分清理会让按日聚合出现三表日期不一致。
    // 条件用 < 而不是 <=：正好等于截止点的行保留，避免同一毫秒的数据在相邻两次调用间抖动。
    db.prepare("delete from turn_usage where started_at < ?").run(beforeTime);
    db.prepare("delete from tool_usage where started_at < ?").run(beforeTime);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

// [契约] 这个函数存在的唯一理由是让 27 个参数与列顺序在一处可核对；插到调用点会让两份顺序各自漂移。
// boolean 用 0/1，三态用 nullableBoolean：混用会把「未观测」写成 false。
// 不要让这里做业务判断（例如把某状态改成错误码），它只做归一化。
// 参数数量与 insert 列数必须一致，sqlite 的参数个数错误在运行时才暴露。
// 工具行的 SQL 参数列表：undefined → NULL（保留“未知”），boolean → 0/1，
// 计数类经 integer 归一为非负整数；顺序必须与 insert 列顺序严格一致。
function toolUsageValues(input: ToolUsageRecord): SQLInputValue[] {
  // [契约] 顺序即列顺序，逐项对应上面的 insert 列表；插入新列时两处必须同时改。
  // trim 后相同的行在这个数组里很多，编辑时请按上方列名逐段核对，不要靠肉眼整体替换。
  return [
    input.id,
    input.sessionID,
    input.turnID ?? null,
    input.traceID ?? null,
    input.toolCallID,
    // [权衡] 名字来自调用方的占位解析，可能先是 unknown；这里不做「空串也保护」的额外兜底，空串是脏数据，应该暴露。
    // 改名（例如 MCP 工具重命名）会体现在新记录上，旧行保留旧名，按工具聚合会出现两个桶，这是可接受的。
    // 不要把 unknown 的保护下沉到读取侧：聚合 SQL 简单按 tool_name 分组，写入侧保证名字单调前进即可。
    // 如果将来 tool_name 允许为空，必须同步改这个保护条件，否则空串会覆盖真实名字。
    input.toolName,
    input.sideEffectScope ?? null,
    nullableBoolean(input.readOnly),
    nullableBoolean(input.destructive),
    input.approvalStatus ?? null,
    input.status,
    input.startedAt,
    input.firstOutputAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstOutputMs ?? null,
    input.exitCode ?? null,
    integer(input.outputBytes),
    integer(input.stdoutBytes),
    integer(input.stderrBytes),
    boolean(input.truncated),
    integer(input.retryCount),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    input.errorType ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
  ];
}

// 说明：按本地日归桶用固定偏移 tzOffsetMs，dayIndex = floor((started_at + off)/DAY)。
// DST 跨日边界存在最多 1 小时误差，对用量统计可接受。
/**
 * 应用级用量聚合：按 [since, until] 闭区间统计 model/turn/tool 三表，
 * 并按固定时区偏移切日（dayIndex = floor((started_at+tzOffsetMs)/DAY)）。
 * avg 类字段无样本时为 null；其余计数/求和无数据时为 0。days 升序返回。
 */
// [契约] 这是纯读路径：不得写入、不得触发 prune、不得修改传入的 input。
// 返回结构是跨表拼接的展示投影，字段口径（null vs 0）已经在返回值处固定，前端依赖它区分无数据。
// 所有子查询共用同一个 [since, until]，任何一条漏传都会让某块统计悄悄变大。
// 不要在这里做权限或可见性过滤：调用方负责范围，本函数只做时间窗口。
export async function queryAppUsage(
  db: DatabaseSync,
  input: AppUsageQueryInput,
): Promise<AppUsageQueryResult> {
  const { since, until, tzOffsetMs } = input;
  // [权衡] 固定 86400000 而不是读时区库：DST 切换日会有最多 1 小时偏差，这是为可预测性付出的代价。
  // 与 tzOffsetMs 搭配时按「先加偏移再整除」分桶，反过来的顺序在负偏移下会错一天。
  // 不要把 DAY_MS 提到模块级：局部常量避免它被其它聚合误用成别的时间单位。
  const DAY_MS = 86_400_000;

  const totals = db
    .prepare(
      `select
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         coalesce(sum(reasoning_tokens), 0) as reasoningTokens,
         coalesce(sum(cache_creation_input_tokens), 0) as cacheCreationTokens,
         coalesce(sum(cache_read_input_tokens), 0) as cacheReadTokens,
         count(*) as modelRequestCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as modelErrorCount,
         avg(time_to_first_token_ms) as avgTimeToFirstTokenMs
       from model_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number | null>;

  // [契约] turnTotals 的 totalSessions 用 distinct session_id，与下面按日统计的轮次数不是同一口径。
  // avgTurnDurationMs 只对 completed 取平均，进行中的轮次不计入，否则均值被 0 拉低。
  // 改这里的 where 条件时必须与 longestSession 子查询同步，否则会话数与会话时长来自不同集合。
  const turnTotals = db
    .prepare(
      `select
         count(distinct session_id) as totalSessions,
         count(*) as totalTurns,
         avg(case when status = 'completed' then duration_ms else null end) as avgTurnDurationMs
       from turn_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number | null>;
  // [权衡] 会话最长时长用「同 session 内 completed 轮次时长求和」再取 max，不是墙钟时长。
  // 与 turnTotals 不同，这里对未完成的轮次按 0 计，所以进行中的会话不会因为越界而虚高。
  // 子查询必须保留 group by session_id，去掉它就会退化成「全局总时长」。
  const longestSession = db
    .prepare(
      `select coalesce(max(sessionDurationMs), 0) as longestSessionMs
       from (
         select coalesce(sum(case when status = 'completed' then duration_ms else 0 end), 0)
           as sessionDurationMs
         from turn_usage
         where started_at >= ? and started_at <= ?
         group by session_id
       )`,
    )
    .get(since, until) as Record<string, number | null>;

  const toolTotals = db
    .prepare(
      `select
         count(*) as toolCallCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as toolErrorCount
       from tool_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number>;

  const models = db
    .prepare(
      `select
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         count(*) as requestCount
       from model_usage
       where started_at >= ? and started_at <= ?
       group by model_id
       order by totalTokens desc`,
    )
    .all(since, until) as unknown as AppUsageModelRow[];

  const tools = db
    .prepare(
      `select
         tool_name as toolName,
         count(*) as callCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as errorCount,
         avg(duration_ms) as avgDurationMs
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by tool_name
       order by callCount desc`,
    )
    .all(since, until) as unknown as AppUsageToolRow[];

  // [契约] 日桶以 model_usage 为主干；turnDays / toolDays 只补字段，不能反过来重建，否则没有模型请求的日期会丢。
  // dayIndex 是 integer 除法，JS 侧用 Number 再转，避免 sqlite 返回浮点。
  // 这条查询不带 model 维度，按日总量与 dayModels 的逐模型之和必须相等，改口径时要同时改两处。
  // 按 dayIndex 分组背后假设 started_at 是毫秒；若上游改成秒，整条曲线会塌到 1970 附近。
  const days = db
    .prepare(
      `select
         cast((started_at + ?) / ? as integer) as dayIndex,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; totalTokens: number }>;

  // [契约] 只取 count(*)，不叠加 duration，避免与 totals 的时长口径冲突。
  // group by dayIndex 使用与 days 相同的 cast 表达式，任何一处参数顺序变化都会让两类日期错位。
  // 空结果由后续 dayMap 合并逻辑吸收，不需要在这里补零。
  const turnDays = db
    .prepare(
      `select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as turnCount
       from turn_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; turnCount: number }>;

  // [契约] 工具日桶同样只计数；错误数在 toolTotals 里统计，不在日维度重复展示。
  // 注意这里统计的是工具调用条数，不是轮次条数，两者不能共用同一个 dayMap 字段。
  // 参数顺序 tzOffsetMs, DAY_MS, since, until 必须与 SQL 中的 ? 顺序一致。
  const toolDays = db
    .prepare(
      `select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as toolCallCount
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; toolCallCount: number }>;

  // [契约] 合并顺序是「先建桶、再补轮次、最后补工具」，每一步都用 ?? 建默认桶，所以任一来源都可能成为起点。
  // 不能在补轮次时用 dayMap.get(...)! 断言：只有模型请求的日期没有轮次行，直接解引用会抛错。
  // 两次覆盖 creator 字段时只用 Number 转换，不重新计算 totalTokens，保证总量始终来自 model_usage。
  // 把三个循环合并成一个会丢失「某个来源当天为空」的情况，先建后补是刻意的。
  // 合并三类按日统计到同一 dayIndex
  const dayMap = new Map<number, AppUsageDayRow>();
  for (const row of days) {
    dayMap.set(row.dayIndex, {
      dayIndex: row.dayIndex,
      totalTokens: Number(row.totalTokens),
      turnCount: 0,
      toolCallCount: 0,
    });
  }
  for (const row of turnDays) {
    const existing = dayMap.get(row.dayIndex) ?? {
      dayIndex: row.dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    existing.turnCount = Number(row.turnCount);
    dayMap.set(row.dayIndex, existing);
  }
  for (const row of toolDays) {
    const existing = dayMap.get(row.dayIndex) ?? {
      dayIndex: row.dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    existing.toolCallCount = Number(row.toolCallCount);
    dayMap.set(row.dayIndex, existing);
  }

  // [契约] dayModels 是 day 曲线下钻用的第二维度，必须保留 model_id 分组，不能为了省查询复用到 models。
  // order by 缺失是刻意的：前端按 dayIndex 自行排序，SQL 排序只会增加成本。
  // modelId 允许为 null（历史行没有 model_id），下游要按 null 单独成桶。
  const dayModels = db
    .prepare(
      `select
         cast((started_at + ?) / ? as integer) as dayIndex,
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex, model_id`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as unknown as AppUsageDayModelRow[];

  // [契约] 这里的 ?? 0 只用于计数/求和；avg 字段必须保持 null，见 INV-16。
  // totals 与 turnTotals 来自不同查询，理论上会有毫秒级时间差，不要把它们当成同一快照做减法。
  // days 在这里才排序：中间过程依赖 Map 插入顺序，提前排序没有意义。
  // 新增字段时同步更新 contracts 的行类型，否则 TS 只在调用侧报错，运行时会多出 silent undefined。
  return {
    totals: {
      totalTokens: Number(totals.totalTokens ?? 0),
      inputTokens: Number(totals.inputTokens ?? 0),
      outputTokens: Number(totals.outputTokens ?? 0),
      reasoningTokens: Number(totals.reasoningTokens ?? 0),
      cacheCreationTokens: Number(totals.cacheCreationTokens ?? 0),
      cacheReadTokens: Number(totals.cacheReadTokens ?? 0),
      modelRequestCount: Number(totals.modelRequestCount ?? 0),
      modelErrorCount: Number(totals.modelErrorCount ?? 0),
      avgTimeToFirstTokenMs:
        totals.avgTimeToFirstTokenMs == null ? null : Number(totals.avgTimeToFirstTokenMs),
    },
    turnTotals: {
      totalSessions: Number(turnTotals.totalSessions ?? 0),
      totalTurns: Number(turnTotals.totalTurns ?? 0),
      avgTurnDurationMs:
        turnTotals.avgTurnDurationMs == null ? null : Number(turnTotals.avgTurnDurationMs),
      longestSessionMs: Number(longestSession.longestSessionMs ?? 0),
    },
    toolTotals: {
      toolCallCount: Number(toolTotals.toolCallCount ?? 0),
      toolErrorCount: Number(toolTotals.toolErrorCount ?? 0),
    },
    models: models.map((m) => ({
      modelId: m.modelId ?? null,
      totalTokens: Number(m.totalTokens),
      inputTokens: Number(m.inputTokens),
      outputTokens: Number(m.outputTokens),
      requestCount: Number(m.requestCount),
    })),
    tools: tools.map((t) => ({
      toolName: t.toolName,
      callCount: Number(t.callCount),
      errorCount: Number(t.errorCount),
      avgDurationMs: t.avgDurationMs == null ? null : Number(t.avgDurationMs),
    })),
    days: [...dayMap.values()].sort((a, b) => a.dayIndex - b.dayIndex),
    dayModels: dayModels.map((d) => ({
      dayIndex: Number(d.dayIndex),
      modelId: d.modelId ?? null,
      totalTokens: Number(d.totalTokens),
    })),
  };
}

/**
 * 单会话任务用量：按 started_at 升序逐行累加，input 侧按 querySource 维护基线——
 * main_turn/subagent/workflow_child 的 input 会随上下文增长重复计数，只累加
 * “超出历史基线的增量”；压缩导致 input 变小时不回扣已计总量，但基线同步下调。
 * 非基线来源（如 compact）直接全量累加。返回 modelRequestCount=总行数。
 */
// [契约] 本函数返回的是「单会话口径」的累计值，不能直接用 queryAppUsage 的跨会话结果近似。
// inputBaselineBySource 必须回传给调用方：它是后续增量计算的唯一状态，丢了就会重新按全量累加。
// 这是同步读，但保持 async 签名以对齐其它 query 接口，内部没有 await。
// 不要在这里加 session 归属校验，调用方已按 session_id 过滤。
export async function queryTaskUsage(
  db: DatabaseSync,
  input: TaskUsageQueryInput,
): Promise<TaskUsageQueryResult> {
  // [契约] 排序必须是 started_at asc, id asc：同毫秒的多行靠 id 稳定，否则基线增量会随查询计划变化。
  // 只查需要的列，reasoning/cache 都要带上，否则下面的累加会静默变成 0。
  // providerTotalTokens 允许 null，这里保留 null 而不是 coalesce，是为了让下游区分「provider 没给」和「provider 给了 0」。
  // 不要在这里加 limit 分页：基线是顺序累积的，截断会让最后几轮增量算错。
  const rows = db
    .prepare(
      `select
         id,
         query_source as querySource,
         status,
         input_tokens as inputTokens,
         output_tokens as outputTokens,
         reasoning_tokens as reasoningTokens,
         cache_creation_input_tokens as cacheCreationTokens,
         cache_read_input_tokens as cacheReadTokens,
         computed_total_tokens as computedTotalTokens,
         provider_total_tokens as providerTotalTokens
       from model_usage
       where session_id = ?
       order by started_at asc, id asc`,
    )
    .all(input.sessionID) as Array<{
    cacheCreationTokens: number;
    cacheReadTokens: number;
    computedTotalTokens: number;
    inputTokens: number;
    outputTokens: number;
    providerTotalTokens: number | null;
    querySource: string;
    reasoningTokens: number;
    status: string;
  }>;

  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let modelErrorCount = 0;
  // [契约] 基线按 querySource 分开存，不能用一个全局基线：main_turn 与 subagent 的上下文互不相干。
  // 基线的初值是 undefined 而不是 0；用 0 起算会让第一轮的全量 input 被当作增量，反而正确，但可读性差且无法区分来源。
  // 这个对象会原样返回给调用方，字段名即是 source 字符串，新增来源必须同步 taskUsageInputBaselineSource。
  // 不要把它做成 Map：返回类型是 Record，序列化后再恢复会因为 Map 丢失结构。
  const inputBaselineBySource: Record<string, number> = {};

  // [契约] 单次顺序遍历是刻意的：增量依赖上一行的基线，任何并行/分组都会破坏「只累加增量」的定义。
  // 循环内所有累加都用 +=，不要改成先收集再 reduce，减少一次内存拷贝但失去顺序语义。
  // 每行都要算 inputSideTokens 与 baseline，即便该行 status 是 error：失败请求同样消耗了上下文。
  // 如果将来允许乱序写入，必须改成先按 started_at 排序再算，当前 SQL 已保证，别在内存里再排序。
  for (const row of rows) {
    const rawTotalTokens = Number(row.providerTotalTokens ?? row.computedTotalTokens ?? 0);
    const inputSideTokens = inputSideTokensFromStoredUsage(row);
    const source = taskUsageInputBaselineSource(row.querySource);
    const incrementalInputTokens =
      source === undefined
        ? inputSideTokens
        : Math.max(0, inputSideTokens - (inputBaselineBySource[source] ?? 0));
    // [权衡] 只有三类持续增长来源更新基线；compact 等来源不更新，避免把「压缩后的首轮」当成新基准。
    // 这里更新基线用的是 inputSideTokens 而不是增量值，这是压缩后不回扣历史的关键（见 INV-18）。
    // 把赋值放到增量计算之前会差一轮；放到循环外则整段基线失效。
    // 错误请求也走这条分支：它们同样推进上下文，如果不推进，下一轮会把这段重复计入。
    if (source !== undefined) {
      // 压缩会让后续 context input 变小；累计消耗不能因此回扣历史，
      // 但 baseline 必须降到压缩后的值，后续新增轮次才能继续按增量计算。
      inputBaselineBySource[source] = inputSideTokens;
    }

    // [失败路径] 减法可能为负（provider 总值比 input 侧还小，历史脏数据），max(0) 是明确的口径修正而不是兜底。
    // nonInput 包含 output/reasoning 等非 input 部分，直接加到 total 上，不再重复加 output。
    // 不要把它改成绝对值：负差代表数据不一致，钳到 0 才能不让错误扩散到累计值。
    const nonInputTokens = Math.max(0, rawTotalTokens - inputSideTokens);
    const rowOutputTokens = Number(row.outputTokens ?? 0);
    const rowReasoningTokens = Number(row.reasoningTokens ?? 0);
    totalTokens += incrementalInputTokens + nonInputTokens;
    inputTokens += incrementalInputTokens;
    outputTokens += rowOutputTokens;
    reasoningTokens += rowReasoningTokens;
    if (source === undefined) {
      cacheCreationTokens += Number(row.cacheCreationTokens ?? 0);
      cacheReadTokens += Number(row.cacheReadTokens ?? 0);
    }
    // [失败路径] 错误计数只统计 status 恰好为 error 的行；cancelled/timeout 不算，改这里会影响错误率定义。
    // 必须在累加之后执行，保证错误行的 token 已进入总量，错误率与用量来自同一集合。
    // 不要在这里提前 continue，否则该行的输入增量会被丢弃。
    if (row.status === "error") {
      modelErrorCount += 1;
    }
  }

  return {
    sessionID: input.sessionID,
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    modelRequestCount: rows.length,
    modelErrorCount,
    inputBaselineBySource,
  };
}

// input 侧 token 口径：优先 inputTokens；为 0 时把 cache 读写也算入输入。
// [契约] 只处理「新写入」的归一化记录，历史行的归属判断在 inputSideTokensFromStoredUsage，两者不能合并。
// input > 0 时直接返回，包含 cache 的 inputTokens 是 AI SDK v6 的正常形态。
// cache 两个字段分别 integer 后再相加，避免其中一个为 null 时整个表达式变 NaN。
function inputSideTokensFromNormalizedUsage(
  inputTokens: number | null | undefined,
  cacheCreationTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
): number {
  const input = integer(inputTokens);
  if (input > 0) {
    return input;
  }
  return integer(cacheCreationTokens) + integer(cacheReadTokens);
}

// 历史行的 input 口径判定：用 provider 总 token 距离比较两种假设，
// 判断 cache 是否已被包含在 inputTokens 内，避免重复叠加导致 task 用量虚高。
// [权衡] 用「距离 provider 总值更近」来猜 cache 是否已包含，是历史数据缺失版本标记时的唯一可用信号。
// 两个假设分别是 input+output 与 input+cache+output，距离相等时保留 input（偏向新版语义），这个 tie-break 不能反。
// total<=0 时直接返回 input：没有第三方参照，任何猜测都是编造。
// 这个函数只读不写，不要在这里顺带修正行数据——修正会破坏只增注释/只增数据的迁移前提。
function inputSideTokensFromStoredUsage(row: {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  computedTotalTokens: number;
  inputTokens: number;
  outputTokens: number;
  providerTotalTokens: number | null;
}): number {
  const input = integer(row.inputTokens);
  const cache = integer(row.cacheCreationTokens) + integer(row.cacheReadTokens);
  if (input <= 0) {
    return cache;
  }
  if (cache <= 0) {
    return input;
  }

  // [契约] output 只用于上面的距离比较，不参与累加，别把它当成返回值的一部分。
  // providerTotalTokens 优先于 computedTotalTokens，因为前者是 provider 原话，后者是本地兜底。
  // 两个都是 null 时 total=0，函数会走「无参照」分支，不会误判。
  const output = integer(row.outputTokens);
  const total = integer(row.providerTotalTokens ?? row.computedTotalTokens);
  if (total > 0) {
    const totalInputDistance = Math.abs(total - (input + output));
    const noCacheInputDistance = Math.abs(total - (input + cache + output));
    if (noCacheInputDistance < totalInputDistance) {
      return input + cache;
    }
  }

  // AI SDK v6 写入的 inputTokens 已经是 total input；历史表里 cache 字段只是 breakdown。
  // task usage 和 compact 基线不能再把 cache read/write 叠到 inputTokens 上。
  return input;
}

// 只有三类“上下文持续增长”的来源需要基线；其它来源（compact 等）按全量计。
// [契约] 白名单必须是显式的三类；用「不等于 compact」这类黑名单会让新来源默认进入基线逻辑，行为不可预期。
// 返回值就是基线 key，不要改成布尔：调用方需要按来源分别维护基线。
// 新增来源（例如 workflow_root）时要同时评估它是否真的持续增长，否则基线会永远偏低。
function taskUsageInputBaselineSource(querySource: string): string | undefined {
  if (
    querySource === "main_turn" ||
    querySource === "subagent" ||
    querySource === "workflow_child"
  ) {
    return querySource;
  }
  return undefined;
}

// 历史记录可能带字符串/null；统一转非负整数，非法值按 0 处理。
// [失败路径] NaN/Infinity/非 number 一律归 0，这是本文件所有统计不出现 NaN 的唯一保证。
// 用 Math.trunc 而不是 round：token 计数没有小数语义，四舍五入会让单行 result 与 provider 总值对不上。
// Math.max(0, ...) 吸收负值；负数在旧记录里出现过，不代表可以进入 sum。
function integer(value: number | null | undefined): number {
  // providerTotalTokens 这类旧记录字段可能是 null；adapters 独立 tsc 需要先完成类型收窄。
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function boolean(value: boolean | undefined): number {
  return value ? 1 : 0;
}

// 三态布尔：undefined 保留 NULL（表示“未观测到”），true/false 写成 1/0。
// [契约] undefined 映射 NULL 与 false 映射 0 必须严格区分，见 INV-13。
// 不要加 null 入参支持：契约里只有 undefined 表示未观测，null 会污染三态语义。
// 本函数只在 tool_usage 的参数列表里使用，model/turn 的布尔是必填的 0/1。
function nullableBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : boolean(value);
}
