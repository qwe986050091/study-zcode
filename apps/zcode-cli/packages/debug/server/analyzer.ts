/**
 * 观测数据聚合分析：把日志/事件/SQLite 三源记录还原为 trace 列表、详情时间线、span、
 * 上下文快照、缓存报告与“需要业务侧补充埋点”的建议清单。
 *
 * 职责：唯一负责跨源关联（traceId/sessionId/turnId/toolCallId）与派生字段计算，
 * HTTP 层只做参数透传，前端只做展示。
 * 数据优先级：事件（eventlog）为事实来源；日志用于补充时间线与耗时；SQLite 作为缺失时的兜底。
 * 降级口径：某源缺失时仍返回其余源的结果，并通过 `sources` 与 `warnings` 标注完整性。
 * 失败语义：读取层的局部失败已在 sources 中转为 warning；本模块不吞掉结构性异常。
 * 不变量：所有输出按 traceId 精确过滤，跨 trace 的记录不得混入。
 */
// ============================================================================
// analyzer.ts — 观测数据聚合分析（debug 服务端唯一跨源关联层）
//
// 输入：日志（JSONL）、事件（eventlog JSONL）、SQLite 三源；
// 输出：trace 列表 / trace 详情（时间线 + span + 上下文快照 + 用量 + 缓存 + 埋点建议）。
//
// 三条数据优先级必须按顺序理解，任何降级都只允许往右走：
//   上下文正文：事件 model_request > context.built 日志 > 空（标 inferred）；
//   上下文用量：context.usage 日志 > 事件 usage > SQLite step-finish；
//   缓存：事件 cacheStats > 消息序列推断 > SQLite 会话聚合。
//
// 本文件是纯函数式派生层：不做 IO 之外的副作用，不写文件、不发网络请求。
// 因此每个 build* 函数都可以用固定输入做快照测试，测试失败基本等价于口径变更。
//
// INV 不变量表（每条注明守住它的位置；括号内是改错后的故障）
// INV-01 跨 trace 隔离：所有 build* 只接受 traceId 精确匹配的日志/事件。
//         守住：buildTimeline / buildTraceSpans / buildContextSnapshots / buildCacheReports 的首层过滤。
//         （混入后：详情页出现别的会话的消息，且按时间倒序看毫无破绽）
// INV-02 SQLite 没有 traceId，只能按会话集合关联。
//         守住：collectSessionsForTrace + 各处 sessions.has(sessionId)。
//         （用 traceId 直连 DB 永远命中 0 条）
// INV-03 会话集合是 DB 关联的唯一依据；显式 sessionId 与 session: 前缀都要并入。
//         守住：collectSessionsForTrace 的前两个 if。
//         （session 型 trace 永远查不到 DB 消息）
// INV-04 首条用户消息取「最早」，时间缺失时不得用后来的候选覆盖已有值。
//         守住：recordFirstUserMessage 的比较分支。
//         （列表首条用户输入会变成最后一条 DB 消息）
// INV-05 事件在时间相同时优先于 DB：DB 只补空，不抢占。
//         守住：compareIsoAsc(...) <= 0 即返回的严格比较。
// INV-06 时间线 id 必须带源前缀（log:/event:/sqlite:），保证跨源唯一。
//         守住：四个 timelineFrom* 的 id 模板。
//         （React key 冲突，时间线随机丢行）
// INV-07 时间排序统一走 compareIsoAsc/Desc；缺失时间排最后。
//         守住：sort 调用点，不得就地写 localeCompare。
// INV-08 span 配对必须晚于起始时间（任一方缺时间才放弃时间约束）。
//         守住：findMatchingEndEvent 的 timestamp < startAt 判断。
//         （上一轮的 turn_complete 会被配到本轮 start）
// INV-09 span 配对优先用关联 id，缺失时才退化为 session/turn。
//         守住：matchModelEvents / matchToolEvents / matchPermissionEvents / matchSubagentEvents。
// INV-10 span 泳道只影响展示分组，不得参与任何数值计算。
//         守住：spanLaneFromLog 的注释与唯一调用点。
// INV-11 上下文段落只按 markdown 一/二级标题切分，前言单独成段。
//         守住：deriveSectionsFromSystemPrompt 的正则与 preamble 分支。
// INV-12 段落 token 是粗估，percentTokens 只用于占比展示，不得当计费口径。
//         守住：estimateTokens 与 finalizeContextSnapshot。
// INV-13 percentTokens 在总 token 为 0 时必须为 0，不得除零得到 NaN。
//         守住：finalizeContextSnapshot 与 buildContextUsageSnapshots 的两个三元判断。
// INV-14 缺失分项一律保留 undefined 或 0 并配 warnings，绝不伪造归因。
//         守住：usageCategoryFromRecord 的 numberValue 兜底与 warnings 生成。
// INV-15 SQLite 兜底必须把 confidence 固定为 low，并写明无法拆分的原因。
//         守住：contextUsageSnapshotsFromDb / cacheReportsFromDb 的 limitations。
// INV-16 hitRate 的分母是 inputTokens；为 0 时返回 null 而不是 0。
//         守住：两处 hitRate 三元表达式。
//         （0% 命中率与「无数据」在前端无法区分）
// INV-17 缓存分段只在 lastCacheHit 且 cachedMessages 已知时才给出 hit/miss。
//         守住：cacheSegmentsFromMessages 的 hasPrefixStats。
// INV-18 usage 解析兼容 snake_case/camelCase，并优先 cache 子对象。
//         守住：extractUsage 的 ?? 链顺序。
// INV-19 文本抽取递归只认 content/text/message 三类键，且必须有深度终止条件。
//         守住：textFromContent 的三个分支。
// INV-20 埋点建议是只读输出，绝不修改采集配置。
//         守住：buildDeveloperRequests（全函数无副作用）。
// ============================================================================
import { basename } from "node:path";
import type {
  CacheReport,
  CacheSegment,
  ContextSectionSource,
  ContextSectionView,
  ContextSnapshotView,
  ContextUsageCategory,
  ContextUsageMessageBreakdown,
  ContextUsageSkillDetail,
  ContextUsageSnapshotView,
  ContextUsageToolDetail,
  DeveloperRequest,
  ProjectSummary,
  SourceStatus,
  TokenConfidence,
  TokenMethod,
  TimelineItem,
  TraceDetailResponse,
  TraceSpan,
  TraceSpanLane,
  TraceSpanStatus,
  TraceListResponse,
  TraceSummary,
} from "../src/shared.js";
import {
  isRecord,
  loadEventLog,
  loadLogs,
  loadSqlite,
  numberValue,
  stringValue,
} from "./sources.js";
import type {
  DbMessageRecord,
  DbObservation,
  DbPartRecord,
  EventRecord,
  LoadedObservation,
  LogRecord,
  ObservationOptions,
  SourceLoadResult,
} from "./types.js";

// 默认只返回 10 条 trace：列表页是「最近活动」视图，不是全量索引。
// limit 由调用方传入并原样截断，函数内部不做上限保护 ——
// HTTP 层负责把用户参数夹到合理范围。
const DEFAULT_TRACE_LIMIT = 10;

// 草稿比对外契约多一个 firstUserMessageAt：
// 它是「比较用」的时间刻度，不能出现在 API 响应里。
// toTraceSummary 负责剥掉它，这是本文件里唯一的字段裁剪点。
type TraceSummaryDraft = TraceSummary & {
  firstUserMessageAt?: string;
};

/**
 * 列出 trace 摘要。
 * 输入：`limit` 控制返回条数（缺省 10）；`projectId` 时先用 SQLite 会话映射到 sessionId 白名单。
 * 输出：源状态、项目聚合与按最近活动倒序的 trace 摘要。
 * 行为：先按日志/事件聚合 trace，再用 DB 用户消息补齐首条用户输入。
 * 失败语义：任一源读取失败只影响该源计数（warning 由源状态透出），不阻断列表返回。
 */
// 列表入口。三个返回字段互相独立：
// sources 表达完整性，projects 来自 DB 会话聚合，traces 由日志+事件+DB 共同推导。
// projectId 过滤发生在 buildTraceSummaries 内部，而不是先过滤源数据 ——
// 因为项目归属只能从 DB 会话映射出来，日志/事件里没有可靠的 project 字段。
// limit 先排序后截断，保证「最近 N 条」而不是「前 N 条里最近的」。
export async function listTraces(options: ObservationOptions = {}): Promise<TraceListResponse> {
  const observation = await loadObservation(options);
  return {
    sources: sourceStatuses(observation),
    projects: buildProjectSummaries(observation.db.records[0]),
    traces: buildTraceSummaries(
      observation,
      options.limit ?? DEFAULT_TRACE_LIMIT,
      options.projectId,
    ),
  };
}

/**
 * 获取单个 trace 的完整详情。
 * 输入：`traceId` 必填；`sessionId` 可选用于补全事件里缺失会话归属的场景。
 * 输出：时间线、span、上下文/用量快照、缓存报告与埋点建议，均只含该 trace 的数据。
 * 行为：先统一加载三源（带 traceId 过滤），再分别构建各视图；DB 视图按会话集合关联。
 * 失败语义：视图构建对缺失字段做空值降级（unknown/空数组），不因单条坏记录中断整体返回。
 * 不变量：`sessions` 结果去重排序，作为 DB 消息/片段的唯一关联依据。
 */
// 详情入口。六个 build* 顺序执行而不是并发：
// 它们共享同一份 observation，但各自读的内容不同，并发收益极小，
// 串行能保证将来引入缓存时的读取顺序稳定。
// sessions 只计算一次并同时喂给时间线/span/用量/缓存四处，
// 保证「同一次请求里 DB 关联口径完全一致」。
// 返回的 sessions 排序后输出：Set 的插入顺序取决于日志扫描顺序，不可作为契约。
export async function inspectTrace(
  traceId: string,
  options: ObservationOptions = {},
): Promise<TraceDetailResponse> {
  const observation = await loadObservation({ ...options, traceId });
  // 会话集合必须在所有 DB 视图之前算好。
  // options.sessionId 是外部补全入口：某些事件丢了 sessionId，
  // 但调用方（例如从会话页跳转）知道它属于哪个会话。
  const sessions = collectSessionsForTrace(traceId, observation, options.sessionId);
  const timeline = buildTimeline(traceId, sessions, observation);
  const spans = buildTraceSpans(traceId, sessions, observation);
  const contextSnapshots = buildContextSnapshots(traceId, observation);
  const contextUsageSnapshots = buildContextUsageSnapshots(traceId, sessions, observation);
  const cacheReports = buildCacheReports(traceId, sessions, observation);

  return {
    traceId,
    sessions: [...sessions].sort(),
    sources: sourceStatuses(observation),
    timeline,
    spans,
    contextSnapshots,
    contextUsageSnapshots,
    cacheReports,
    developerRequests: buildDeveloperRequests(observation, contextSnapshots, cacheReports),
  };
}

/** 并行读取日志与事件（异步 IO），SQLite 为同步只读打开；三者都按 options 过滤路径。 */
// 三源加载：日志与事件是异步 IO，SQLite 是同步只读打开。
// Promise.all 只包前两者，因为 SQLite 同步打开不能被打包进 Promise 并发，
// 硬写成 Promise.resolve(loadSqlite()) 不会带来任何并行收益，只会掩盖同步阻塞。
// 任一源失败由 sources 层转成 warning，这里不做 try/catch（见文件头失败语义）。
async function loadObservation(options: ObservationOptions): Promise<LoadedObservation> {
  const [logs, events] = await Promise.all([loadLogs(options), loadEventLog(options)]);
  return {
    logs,
    events,
    db: loadSqlite(options),
  };
}

// 源状态的顺序固定为 logs、events、db：
// 前端按数组下标或 kind 分组展示，顺序变化会影响「数据完整性」条目的阅读顺序。
function sourceStatuses(observation: LoadedObservation): SourceStatus[] {
  return [
    toSourceStatus(observation.logs),
    toSourceStatus(observation.events),
    toSourceStatus(observation.db),
  ];
}

// available 用 records.length > 0 判断，而不是错误为空：
// 文件存在但零记录（例如刚启动）与文件缺失在 UI 上应区分，
// 零记录仍算「可用但为空」，这样 warning 文案才有意义。
function toSourceStatus<TRecord>(source: SourceLoadResult<TRecord>): SourceStatus {
  return {
    kind: source.kind,
    label: source.label,
    path: source.path,
    available: source.records.length > 0,
    recordCount: source.records.length,
    warning: source.warning,
  };
}

/**
 * 聚合 trace 摘要。
 * 行为：日志贡献 logCount/时间/最后消息；事件贡献 eventCount/首条用户消息/缓存 token；
 * 最后用 DB 用户消息校正“首条用户输入”，避免日志里只有系统事件。
 * 输入：`limit` 截断前先按 lastAt 倒序；`projectId` 时只保留命中项目会话白名单的 trace。
 * 输出：按最近活动倒序、最多 limit 条的摘要（不含内部 firstUserMessageAt 字段）。
 */
// 列表聚合的核心。两轮扫描的顺序不可交换：
// 先日志建骨架（logCount/时间/最后消息），再事件补充计数与首条用户输入。
// 事件覆盖 lastMessage 是有意的：事件类型比日志文本更能代表「这条 trace 最后做了什么」。
// projectId 过滤放在排序之前：先过滤再排序能减少排序成本，
// 且不会影响结果（过滤是集合判定，与顺序无关）。
// 缓存 token 只从事件累加：日志里的 token 字段格式不统一，容易重复计数。
function buildTraceSummaries(
  observation: LoadedObservation,
  limit: number,
  projectId?: string,
): TraceSummary[] {
  const summaries = new Map<string, TraceSummaryDraft>();
  // 项目过滤白名单只在需要时构建，避免每次请求都遍历全部会话。
  // 白名单为空 Set 是合法结果（项目存在但没有会话），此时所有 trace 都会被过滤掉，
  // 这与「没有传 projectId」必须区分 —— 后者返回全部。
  const allowedSessionIds = projectId
    ? sessionIdsForProject(observation.db.records[0], projectId)
    : undefined;

  for (const log of observation.logs.records) {
    if (!log.traceId) continue;
    const summary = ensureTraceSummary(summaries, log.traceId);
    summary.logCount += 1;
    addSession(summary, log.sessionId);
    addTime(summary, log.timestamp);
    summary.lastMessage = log.message ?? log.event ?? summary.lastMessage;
  }

  for (const event of observation.events.records) {
    if (!event.traceId) continue;
    const summary = ensureTraceSummary(summaries, event.traceId);
    summary.eventCount += 1;
    addSession(summary, event.sessionId);
    addTime(summary, event.timestamp);
    // 事件类型直接作为最后消息，不做本地化：
    // analyzer 是服务端模块，本地化属于前端展示层。
    // 类型名（如 tool_call_result）比日志文本更稳定，适合作为列表摘要。
    summary.lastMessage = event.type;
    recordFirstUserMessage(summary, firstUserMessageFromEvent(event), event.timestamp);
    const usage = extractUsage(event.payload);
    summary.cacheReadTokens += usage.cacheReadTokens;
    summary.cacheWriteTokens += usage.cacheWriteTokens;
  }

  // DB 补充必须在日志/事件全量扫描之后：
  // 它依赖 summary.sessionIds 已经收集完整，否则会漏掉部分会话的映射。
  // 注意传的是 records[0]：SQLite 加载结果只会有一条记录，
  enrichTraceSummariesFromDbMessages(summaries, observation.db.records[0]);

  return [...summaries.values()]
    .filter((summary) => {
      if (!allowedSessionIds) return true;
      return summary.sessionIds.some((sessionId) => allowedSessionIds.has(sessionId));
    })
    .sort((left, right) => compareIsoDesc(left.lastAt, right.lastAt))
    .slice(0, limit)
    .map(toTraceSummary);
}

/** 按 projectId 聚合会话：projectId 缺失或异常时，同项目只保留最近更新的代表目录并累加会话数。 */
// 项目聚合完全依赖 DB 会话表，没有 DB 时返回空数组（不是错误）。
// 同一 projectId 的多条会话合并成一条，sessionCount 累加。
// 代表目录取「最近更新」的那条会话：项目可能被移动过，
// 取最新目录才能让后续跳转打开正确位置。
function buildProjectSummaries(db?: DbObservation): ProjectSummary[] {
  if (!db) return [];
  const byProject = new Map<string, ProjectSummary>();

  for (const session of db.sessions) {
    const existing = byProject.get(session.projectId);
    if (!existing) {
      byProject.set(session.projectId, {
        projectId: session.projectId,
        label: projectLabel(session.directory),
        directory: session.directory,
        sessionCount: 1,
        updatedAt: session.updatedAt,
      });
      continue;
    }

    existing.sessionCount += 1;
    if (!existing.updatedAt || (session.updatedAt && session.updatedAt > existing.updatedAt)) {
      existing.updatedAt = session.updatedAt;
      existing.directory = session.directory;
      existing.label = projectLabel(session.directory);
    }
  }

  return [...byProject.values()].sort((left, right) =>
    compareIsoDesc(left.updatedAt, right.updatedAt),
  );
}

// 项目 -> 会话 id 的扁平映射，只用于 trace 过滤。
// 没有 db 时返回空集合而不是 undefined：调用方统一走「有集合就过滤」的分支。
function sessionIdsForProject(db: DbObservation | undefined, projectId: string): Set<string> {
  const ids = new Set<string>();
  for (const session of db?.sessions ?? []) {
    if (session.projectId === projectId) ids.add(session.id);
  }
  return ids;
}

// 项目显示名取目录 basename，失败时回退到完整路径，最后才是占位文案。
// 三级回退是必要的：根目录 basename 可能为空串。
function projectLabel(directory: string): string {
  return basename(directory) || directory || "未命名项目";
}

// get-or-create 模式：日志与事件两轮扫描都通过它获取草稿，
// 因此同一个 traceId 只会有一个累加器，计数不会被拆分。
function ensureTraceSummary(
  summaries: Map<string, TraceSummaryDraft>,
  traceId: string,
): TraceSummaryDraft {
  const existing = summaries.get(traceId);
  if (existing) return existing;
  const summary: TraceSummary = {
    traceId,
    sessionIds: [],
    eventCount: 0,
    logCount: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  summaries.set(traceId, summary);
  return summary;
}

// 建立 sessionId -> 多个 summary 的反向索引：
// 一个会话可能出现在多条 trace 里（重试、并发 turn），不能假设一对一。
// 只取 role=user 的消息作为候选，且文本优先取 message.data，
// 为空时才拼接 parts（部分版本把文本存在 part 里）。
// partsByMessageId 一次性分组，避免对每条消息线性扫描全部 parts。
function enrichTraceSummariesFromDbMessages(
  summaries: Map<string, TraceSummaryDraft>,
  db?: DbObservation,
): void {
  if (!db || summaries.size === 0) return;
  const bySessionId = new Map<string, TraceSummaryDraft[]>();
  const partsByMessageId = groupPartsByMessageId(db.parts);
  for (const summary of summaries.values()) {
    for (const sessionId of summary.sessionIds) {
      const existing = bySessionId.get(sessionId);
      if (existing) {
        existing.push(summary);
      } else {
        bySessionId.set(sessionId, [summary]);
      }
    }
  }

  for (const message of db.messages) {
    if (message.role !== "user") continue;
    const matchedSummaries = bySessionId.get(message.sessionId);
    if (!matchedSummaries) continue;
    const text = textFromDbMessage(message) ?? textFromDbParts(partsByMessageId.get(message.id));
    for (const summary of matchedSummaries) {
      recordFirstUserMessage(summary, text, message.createdAt);
    }
  }
}

function groupPartsByMessageId(parts: DbPartRecord[]): Map<string, DbPartRecord[]> {
  const byMessageId = new Map<string, DbPartRecord[]>();
  for (const part of parts) {
    const existing = byMessageId.get(part.messageId);
    if (existing) {
      existing.push(part);
    } else {
      byMessageId.set(part.messageId, [part]);
    }
  }
  return byMessageId;
}

/**
 * 记录“首条用户消息”的候选值。
 * 行为：只保留最早的一条；时间缺失时不影响已确定值，时间相同则保留先到者（事件优先于 DB）。
 * 输出：返回是否更新了候选，供调用方决定后续以 DB 消息覆盖。
 */
// 整个函数只做一件事：维护「最早的用户消息」这一个不变量。
// 四种情况必须分清：
//   无候选 + 有时间 -> 直接采用 summary.firstUserMessage；
//   无候选 + 无时间 -> 仅在完全没有文本时才采用（避免时间缺失的候选覆盖已有值）；
//   有候选 + 新候选更早 -> 用新值替换 summary.firstUserMessageAt；
//   有候选 + 时间相同 -> 保留先到者（事件先于 DB，符合数据优先级）。
// 文本先 preview 再判空：只有空白的消息不应成为「首条用户输入」。
function recordFirstUserMessage(
  summary: TraceSummaryDraft,
  text: string | undefined,
  at?: string,
): void {
  const normalized = text ? preview(text, 120) : undefined;
  if (!normalized) return;
  if (summary.firstUserMessageAt) {
    if (!at || compareIsoAsc(summary.firstUserMessageAt, at) <= 0) return;
  } else if (summary.firstUserMessage && !at) {
    return;
  }

  summary.firstUserMessage = normalized;
  summary.firstUserMessageAt = at;
}

// 唯一的外发裁剪点：逐字段显式列出，而不是解构去掉 firstUserMessageAt。
// 显式列出的好处是新增草稿字段时不会意外泄漏到 API。
function toTraceSummary(summary: TraceSummaryDraft): TraceSummary {
  return {
    traceId: summary.traceId,
    sessionIds: summary.sessionIds,
    eventCount: summary.eventCount,
    logCount: summary.logCount,
    firstAt: summary.firstAt,
    lastAt: summary.lastAt,
    firstUserMessage: summary.firstUserMessage,
    lastMessage: summary.lastMessage,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
  };
}

// 去重靠 includes：sessionIds 通常只有个位数，
// 用 Set 会引入额外的序列化/排序负担，收益不明显。
function addSession(summary: TraceSummary, sessionId?: string): void {
  if (sessionId && !summary.sessionIds.includes(sessionId)) {
    summary.sessionIds.push(sessionId);
  }
}

// 同时维护 firstAt 与 lastAt 两个极值。
// 字符串比较依赖 ISO 8601 的字典序等于时间序，
// 这是本文件所有时间比较的共同前提，不要在这里改成 Date 解析（会有性能与非法值问题）。
function addTime(summary: TraceSummary, at?: string): void {
  if (!at) return;
  if (!summary.firstAt || at < summary.firstAt) summary.firstAt = at;
  if (!summary.lastAt || at > summary.lastAt) summary.lastAt = at;
}

/**
 * 收集 trace 关联的会话集合。
 * 口径：显式传入的 sessionId 优先；`traceId` 形如 `session:<id>` 时直接解析出会话；
 * 其余从日志/事件里按 traceId 收集 sessionId，用于后续按会话关联 DB 消息与片段。
 */
// 三个来源按优先级合并进同一个 Set：
//   1) 调用方显式给的 sessionId（最可信）；
//   2) traceId 形如 session:<id> 时直接解析（复制粘贴会话链接的场景）；
//   3) 日志与事件里按 traceId 命中的 sessionId（常规路径）。
// 三源都只做「加入」，不做覆盖：只要任一处指向该会话，就应参与 DB 关联。
function collectSessionsForTrace(
  traceId: string,
  observation: LoadedObservation,
  explicitSessionId?: string,
): Set<string> {
  const sessions = new Set<string>();
  if (explicitSessionId) sessions.add(explicitSessionId);
  if (traceId.startsWith("session:")) sessions.add(traceId.slice("session:".length));

  for (const log of observation.logs.records) {
    if (log.traceId === traceId && log.sessionId) sessions.add(log.sessionId);
  }
  for (const event of observation.events.records) {
    if (event.traceId === traceId && event.sessionId) sessions.add(event.sessionId);
  }

  return sessions;
}

/**
 * 构建统一时间线。
 * 行为：仅收 traceId 精确匹配的日志与事件；DB 侧只取会话集合内的消息/片段（DB 无 traceId）。
 * 输出：按时间倒序（缺失时间排最后），id 带源前缀保证跨源唯一。
 */
// 时间线由三源拼装，DB 侧需要额外的会话集合判定。
// 日志与事件严格按 traceId 相等；SQLite 只能按 sessions.has。
// 同一个 turn 的 DB 消息与日志条目可能描述同一件事，
// 这里不做去重 —— 时间线是「所有观测」的并集，去重会隐藏某一源的事实。
// buildTimeline 最后统一倒序：最新的在最上面，at 缺失的排最后。
function buildTimeline(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId) continue;
    items.push(timelineFromLog(log));
  }

  for (const event of observation.events.records) {
    if (event.traceId !== traceId) continue;
    items.push(timelineFromEvent(event));
  }

  const db = observation.db.records[0];
  if (db && sessions.size > 0) {
    for (const message of db.messages) {
      if (sessions.has(message.sessionId)) {
        items.push(timelineFromDbMessage(message));
      }
    }
    for (const part of db.parts) {
      if (sessions.has(part.sessionId)) {
        items.push(timelineFromDbPart(part));
      }
    }
  }

  return items.sort((left, right) => compareIsoDesc(left.at, right.at));
}

// 日志条目的 label 三级回退 event -> message -> "log"，
// 保证任何一条日志都有可读标题。
// payload 选 context 优先于 error：结构化上下文信息量更大，
// 错误对象仍可从 summary 或原始日志行看到。
function timelineFromLog(log: LogRecord): TimelineItem {
  const label = log.event ?? log.message ?? "log";
  return {
    id: `log:${log.sourcePath}:${log.line}`,
    at: log.timestamp,
    source: "log",
    kind: log.event ?? "log",
    label,
    severity: normalizeLogLevel(log.level),
    traceId: log.traceId,
    sessionId: log.sessionId,
    turnId: log.turnId,
    spanId: log.spanId,
    parentSpanId: log.parentSpanId,
    toolCallId: log.toolCallId,
    summary: log.message ?? log.event ?? "结构化日志条目",
    payload: log.context ?? log.error,
  };
}

// 事件条目的 id 用 event.id（事件源自带唯一 id），
// 不再拼 sourcePath，因为事件不来自可重复读取的行号。
// toolCallId 从 payload 里提取：事件外壳上没有该字段，这是协议差异，不是遗漏。
function timelineFromEvent(event: EventRecord): TimelineItem {
  return {
    id: `event:${event.id}`,
    at: event.timestamp,
    source: "eventlog",
    kind: event.type,
    label: event.type,
    traceId: event.traceId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    toolCallId: eventToolCallId(event.payload),
    summary: summarizeEvent(event),
    payload: event.payload,
  };
}

// DB 消息没有 traceId / turnId / spanId，这些字段在时间线里保持 undefined。
// timelineFromDbMessage 让 traceId/turnId 保持 undefined，前端据此区分「无归因」与「归因到空」。
function timelineFromDbMessage(message: DbMessageRecord): TimelineItem {
  return {
    id: `sqlite:message:${message.id}`,
    at: message.createdAt,
    source: "sqlite",
    kind: "message",
    label: `${formatRole(message.role)}消息`,
    sessionId: message.sessionId,
    summary: summarizeDbMessage(message),
    payload: message.data,
  };
}

// 片段类型未知时用 part:unknown 作为 kind、"未知" 作为 label，
// 两个占位必须一致，否则前端过滤 kind 时会漏掉这类片段。
function timelineFromDbPart(part: DbPartRecord): TimelineItem {
  return {
    id: `sqlite:part:${part.id}`,
    at: part.createdAt,
    source: "sqlite",
    kind: `part:${part.type ?? "unknown"}`,
    label: `${part.type ?? "未知"} 片段`,
    sessionId: part.sessionId,
    summary: summarizeDbPart(part),
    payload: part.data,
  };
}

/**
 * 构建 trace 的 span 集合。
 * 行为：先按事件类型配对（turn/model/tool/permission/subagent），再为带 durationMs 的日志反推起止时间生成 span。
 * 输出：按 startAt 升序；配对失败的 span 允许 endAt 为空、status=unknown。
 * 失败语义：事件缺失时间段时跳过该起始事件，不生成半成品 span。
 */
// span 五泳道固定顺序：turn、model、tool、permission、subagent。
// 五组配置只有 lane/事件类型/标签/匹配函数不同，其余结构完全一致，
// 所以抽成 spansFromEventPairs + SpanPairConfig，而不是写五份循环。
// 事件先按时间升序排序：配对是「向后找第一个结束事件」，顺序错会配到更晚的同类事件。
// 日志反推 span 放在事件配对之后，因此同一时刻的事件 span 排在日志 span 之前（稳定排序）。
// _sessions 未使用：保留参数是为了与其它 build* 的签名一致，方便将来按会话补充日志反推。
function buildTraceSpans(
  traceId: string,
  _sessions: Set<string>,
  observation: LoadedObservation,
): TraceSpan[] {
  const spans: TraceSpan[] = [];
  const traceEvents = observation.events.records
    .filter((event) => event.traceId === traceId)
    .sort((left, right) => compareIsoAsc(left.timestamp, right.timestamp));

  spans.push(
    ...spansFromEventPairs(traceEvents, {
      lane: "turn",
      startType: "turn_started",
      endTypes: ["turn_complete", "turn_error"],
      label: (event) => `Turn ${event.turnId ?? event.sessionId ?? event.id}`,
      match: matchTurnEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "model",
      startType: "model_request",
      endTypes: ["model_complete", "model_error"],
      label: (event) => modelName(event.payload) ?? "模型请求",
      match: matchModelEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "tool",
      startType: "tool_call_started",
      endTypes: ["tool_call_result", "tool_call_error"],
      label: (event) =>
        eventToolName(event.payload) ?? eventToolCallId(event.payload) ?? "工具调用",
      match: matchToolEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "permission",
      startType: "permission_requested",
      endTypes: ["permission_resolved", "permission_denied"],
      label: (event) =>
        eventToolName(event.payload) ?? eventToolCallId(event.payload) ?? "权限请求",
      match: matchPermissionEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "subagent",
      startType: "subagent_spawned",
      endTypes: ["subagent_stopped"],
      label: (event) => subagentLabel(event),
      match: matchSubagentEvents,
    }),
  );

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId) continue;
    // 日志只有耗时、没有起止事件时，用 durationMs 反推 startAt，补充到 log 泳道。
    const span = spanFromLog(log);
    if (span) spans.push(span);
  }

  return spans.sort((left, right) => compareIsoAsc(left.startAt, right.startAt));
}

// 配对配置的五个字段就是「一条泳道的全部语义」。
// match 是纯函数，允许每种泳道自定义关联键，但都必须先满足时间约束。
// endTypes 用数组而不是单值：一轮对话可能以 complete 或 error 结束。
type SpanPairConfig = {
  lane: TraceSpanLane;
  startType: string;
  endTypes: string[];
  label: (event: EventRecord) => string;
  match: (start: EventRecord, end: EventRecord) => boolean;
};

/**
 * 把起始事件与结束事件配对成 span。
 * 行为：只处理带时间戳的 startType 事件，向后续事件查找第一个满足匹配规则的结束事件。
 * 输出：配对失败时 endAt/status 缺失，前端按“进行中/未知”渲染；payload 同时保留起止原始数据。
 */
// 只遍历起始事件，结束事件由 findMatchingEndEvent 负责。
// span 的 spanId/parentSpanId 优先取起始事件，缺失时才用结束事件补：
// 起始事件是「本次操作」的定义者，结束事件可能复用外层 span。
// 配对失败不丢弃 span：endAt 为空、status=unknown，前端按「进行中」渲染。
// payload 同时保留起止原始数据，便于详情页展开对照。
function spansFromEventPairs(events: EventRecord[], config: SpanPairConfig): TraceSpan[] {
  const spans: TraceSpan[] = [];

  for (const start of events) {
    if (start.type !== config.startType || !start.timestamp) continue;
    const end = findMatchingEndEvent(events, start, config.endTypes, config.match);
    spans.push({
      id: `span:event:${start.id}`,
      traceId: start.traceId,
      sessionId: start.sessionId,
      turnId: start.turnId,
      spanId: start.spanId ?? end?.spanId,
      parentSpanId: start.parentSpanId ?? end?.parentSpanId,
      toolCallId: eventToolCallId(start.payload) ?? eventToolCallId(end?.payload),
      lane: config.lane,
      label: config.label(start),
      source: "eventlog",
      startAt: start.timestamp,
      endAt: end?.timestamp,
      status: spanStatusFromEndEvent(end),
      summary: end ? summarizeEvent(end) : summarizeEvent(start),
      payload: {
        start: eventPayloadForSpan(start),
        end: end ? eventPayloadForSpan(end) : undefined,
      },
    });
  }

  return spans;
}

function eventPayloadForSpan(event: EventRecord): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload,
  };
}

/**
 * 在有序事件列表中查找结束事件。
 * 不变量：结束事件必须晚于起始时间（任一方缺时间则不做时间约束），避免把上一轮结束误配到本轮。
 */
// events 必须已按时间升序（唯一调用点保证）。
// 返回第一个匹配项而不是最优匹配：事件流是追加写的，第一顺位即最可能的结束事件。
// 时间约束在两个时间都存在时才生效，这是为了兼容早期没有 timestamp 的事件格式。
function findMatchingEndEvent(
  events: EventRecord[],
  start: EventRecord,
  endTypes: string[],
  match: (start: EventRecord, end: EventRecord) => boolean,
): EventRecord | undefined {
  const startAt = start.timestamp ?? "";
  return events.find((event) => {
    if (!endTypes.includes(event.type)) return false;
    if (startAt && event.timestamp && event.timestamp < startAt) return false;
    return match(start, event);
  });
}

function matchTurnEvents(start: EventRecord, end: EventRecord): boolean {
  return matchSessionTurn(start, end);
}

/**
 * 模型事件配对：优先按 requestId 等关联 id；缺失关联 id 时退化为同 session/turn，
 * 兼容早期未携带 requestId 的事件格式。
 */
// 优先 modelRequestId，其次 requestId，最后 id：
// 三种键来自不同版本的埋点，顺序体现「语义精确度」而不是数组顺序随意。
// 只有双方都取到 id 时才比较；任一方缺失就退化到 session/turn，
// 不能因为一方缺失就判为不匹配（会把老版本事件全部配不上）。
function matchModelEvents(start: EventRecord, end: EventRecord): boolean {
  const startId = eventCorrelationId(start.payload, ["modelRequestId", "requestId", "id"]);
  const endId = eventCorrelationId(end.payload, ["modelRequestId", "requestId", "id"]);
  if (startId && endId) return startId === endId;
  return matchSessionTurn(start, end);
}

function matchToolEvents(start: EventRecord, end: EventRecord): boolean {
  const startToolCallId = eventToolCallId(start.payload);
  const endToolCallId = eventToolCallId(end.payload);
  if (startToolCallId && endToolCallId) return startToolCallId === endToolCallId;
  return matchSessionTurn(start, end);
}

// 权限事件没有统一的 permissionId，部分版本只有 requestId。
// 两个都缺失时退化到 matchToolEvents：权限请求通常挂在某次工具调用上。
function matchPermissionEvents(start: EventRecord, end: EventRecord): boolean {
  const startPermissionId = eventCorrelationId(start.payload, ["permissionId", "requestId"]);
  const endPermissionId = eventCorrelationId(end.payload, ["permissionId", "requestId"]);
  if (startPermissionId && endPermissionId) return startPermissionId === endPermissionId;
  return matchToolEvents(start, end);
}

// 子 Agent 的身份键有四种历史写法，按「越具体越靠前」排列。
// sessionId 作为最后兜底键是有风险的（父会话与子会话可能同名），
// 但只在前面三种全缺失时才启用，属于可接受的降级。
function matchSubagentEvents(start: EventRecord, end: EventRecord): boolean {
  const startSubagentId = eventCorrelationId(start.payload, [
    "subagentId",
    "subagentSessionId",
    "childSessionId",
    "sessionId",
  ]);
  const endSubagentId = eventCorrelationId(end.payload, [
    "subagentId",
    "subagentSessionId",
    "childSessionId",
    "sessionId",
  ]);
  if (startSubagentId && endSubagentId) return startSubagentId === endSubagentId;
  return matchSessionTurn(start, end);
}

// 兜底匹配：两方都有值时才要求相等。
// 任一为空即视为「无法证伪」，返回 true ——
// 这是刻意的宽松，因为旧版本事件普遍缺 turnId，严格比较会让整个 span 消失。
function matchSessionTurn(start: EventRecord, end: EventRecord): boolean {
  if (start.sessionId && end.sessionId && start.sessionId !== end.sessionId) return false;
  if (start.turnId && end.turnId && start.turnId !== end.turnId) return false;
  return true;
}

// 按 names 顺序返回第一个非空字符串值。
// 名字数组的顺序即优先级，调用方负责把最具体的键放在最前。
// 空串被 stringValue 归一为 undefined，因此空白 id 不会参与配对。
function eventCorrelationId(
  payload: Record<string, unknown> | undefined,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = stringValue(payload?.[name]);
    if (value) return value;
  }
  return undefined;
}

// 状态只由结束事件的类型后缀决定，不看 payload。
// cancelled 与 canceled 两种拼写都要接：不同 provider 的埋点用词不一致。
// permission_denied 单独判为 error，因为它不是 _error 后缀。
function spanStatusFromEndEvent(event: EventRecord | undefined): TraceSpanStatus {
  if (!event) return "unknown";
  if (event.type.endsWith("_error") || event.type === "permission_denied") return "error";
  if (event.type.endsWith("_cancelled") || event.type.endsWith("_canceled")) return "cancelled";
  return "ok";
}

// 日志反推 span 的三个必要条件：有时间、有耗时、耗时 > 0。
// durationMs 为 0 也跳过：0 毫秒的 span 在时间轴上没有宽度，只会制造噪声。
// endAt 取日志时间戳、startAt 由 durationMs 反推，
// 这意味着日志时间戳被假定为「结束时刻」，与结构化日志的写法一致。
function spanFromLog(log: LogRecord): TraceSpan | undefined {
  if (!log.timestamp || log.durationMs === undefined || log.durationMs <= 0) return undefined;
  const lane = spanLaneFromLog(log);
  const endAt = log.timestamp;
  return {
    id: `span:log:${log.sourcePath}:${log.line}`,
    traceId: log.traceId,
    sessionId: log.sessionId,
    turnId: log.turnId,
    spanId: log.spanId,
    parentSpanId: log.parentSpanId,
    toolCallId: log.toolCallId,
    lane,
    label: log.event ?? log.message ?? "结构化日志",
    source: "log",
    startAt: subtractMs(endAt, log.durationMs),
    endAt,
    status: spanStatusFromLog(log),
    summary: log.message ?? log.event,
    payload: log.context ?? log.error,
  };
}

/** 按事件/模块/消息关键字把日志归入泳道；仅用于展示分组，不影响任何计算口径。 */
// 关键字归组的顺序即优先级：tool 先于 model，model 先于 permission。
// 顺序会改变结果（一条日志可能同时含 tool 与 model），因此不能随意调整。
// 该函数只决定展示泳道，不影响任何 token/耗时计算。
function spanLaneFromLog(log: LogRecord): TraceSpanLane {
  const subject = `${log.event ?? ""} ${log.module ?? ""} ${log.message ?? ""}`.toLowerCase();
  if (subject.includes("tool")) return "tool";
  if (subject.includes("model") || subject.includes("provider")) return "model";
  if (subject.includes("permission") || subject.includes("approval")) return "permission";
  if (subject.includes("subagent")) return "subagent";
  if (subject.includes("network") || subject.includes("http")) return "network";
  if (subject.includes("sqlite") || subject.includes("storage") || subject.includes("cache")) {
    return "storage";
  }
  if (subject.includes("turn")) return "turn";
  return "log";
}

// 先看显式 status 字符串，再看 level=error，最后 unknown。
// level 兜底放在最后：level 是日志级别，不等于业务状态，
// 只有没有任何 status 信息时才借用它。
function spanStatusFromLog(log: LogRecord): TraceSpanStatus {
  const normalized = log.status?.toLowerCase();
  if (normalized === "running" || normalized === "pending") return "running";
  if (normalized === "ok" || normalized === "success" || normalized === "completed") return "ok";
  if (normalized === "error" || normalized === "failed" || normalized === "failure") return "error";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "aborted") {
    return "cancelled";
  }
  if (log.level === "error") return "error";
  return "unknown";
}

// 非法时间原样返回而不是抛错或返回空串：
// span 的 startAt 可以为空，前端会退化成「未知起点」，
// 抛错则会让整条 trace 的详情接口失败。
function subtractMs(value: string, durationMs: number): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  return new Date(time - durationMs).toISOString();
}

/**
 * 构建上下文快照。
 * 数据优先级：事件里的 model_request 消息列表最完整；缺失时用 context.built 日志的元数据；
 * 两者都没有则返回空数组，由前端展示“未采集”。
 * 输出：每项的 `observable` 标注采集级别（full/metadata/inferred），`warnings` 记录无法归因的缺口。
 * 不变量：系统提示词与消息内容只做截断展示，不改写原文。
 */
// 上下文快照有两个来源，且不做合并：
//   事件 model_request 有完整 messages 时产出 full；
//   context.built 日志只有 section 元数据时产出 metadata。
// 同一 turn 可能两者都有，此时会出现两条快照 —— 这是有意的，
// 让用户能对比「运行时实际发的」与「构建时记录的」。
// observationLevel 的三元链对应 full / metadata / inferred，
// warnings 与它严格配对：full 必须为空数组。
function buildContextSnapshots(
  traceId: string,
  observation: LoadedObservation,
): ContextSnapshotView[] {
  const snapshots: ContextSnapshotView[] = [];

  for (const event of observation.events.records) {
    if (event.traceId !== traceId || event.type !== "model_request") continue;
    const messages = arrayValue(event.payload?.messages).filter(isRecord);
    const systemMessage = messages.find((message) => message.role === "system");
    const systemPrompt = stringValue(systemMessage?.content);
    const sections = systemPrompt
      ? deriveSectionsFromSystemPrompt(systemPrompt)
      : sectionsFromPayload(event.payload);
    snapshots.push(
      finalizeContextSnapshot({
        id: `event:${event.id}:context`,
        at: event.timestamp,
        traceId: event.traceId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        model: modelName(event.payload),
        messageCount: messages.length,
        sections,
        systemPrompt,
        observationLevel: systemPrompt ? "full" : sections.length > 0 ? "metadata" : "inferred",
        warnings: systemPrompt ? [] : ["当前数据源里的 model_request 没有完整 system prompt。"],
      }),
    );
  }

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId || !isContextBuiltLog(log)) continue;
    const sections = sectionsFromContextBuiltLog(log);
    const hasFullContent = sections.some((section) => section.content);
    snapshots.push(
      finalizeContextSnapshot({
        id: `log:${log.sourcePath}:${log.line}:context`,
        at: log.timestamp,
        traceId: log.traceId,
        sessionId: log.sessionId,
        turnId: log.turnId,
        messageCount: 0,
        sections,
        observationLevel: hasFullContent ? "full" : "metadata",
        warnings: hasFullContent
          ? []
          : ["结构化日志只包含 section 元数据，没有完整 section 文本。"],
      }),
    );
  }

  return snapshots.sort((left, right) => compareIsoAsc(left.at, right.at));
}

/**
 * 构建上下文用量快照。
 * 数据优先级：带 usage 的日志（context.usage）→ 事件 model_request 的 usage → SQLite step 记录。
 * 输出：token 数与 method/confidence 一并透出，缺失分项时以 warnings 说明，而不是伪造 0。
 */
// 用量快照只从专用日志构建，缺失时才整批回落到 DB。
// 注意是「整批回落」而不是逐条补：混合来源会让同一 trace 的 token 口径不一致。
// totalTokens/totalChars 优先读显式字段，缺失才用分类求和；
// percentTokens 同理，显式值优先，否则用 tokens/totalTokens。
// 所有 arrayValue(...).filter(isRecord) 都是防御不可信 JSON 的边界，不要内联成 as 断言。
function buildContextUsageSnapshots(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): ContextUsageSnapshotView[] {
  const snapshots: ContextUsageSnapshotView[] = [];

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId || !isContextUsageSnapshotLog(log)) continue;
    const context = log.context ?? {};
    const categories = arrayValue(context.categories)
      .filter(isRecord)
      .map((category, index) => usageCategoryFromRecord(category, index));
    const totalTokens =
      numberValue(context.totalTokens) ??
      categories.reduce((sum, category) => sum + category.tokens, 0);
    const totalChars =
      numberValue(context.totalChars) ??
      categories.reduce((sum, category) => sum + category.chars, 0);
    const categoriesWithPercent = categories.map((category) => ({
      ...category,
      percentTokens:
        numberValue(category.percentTokens) ??
        (totalTokens > 0 ? category.tokens / totalTokens : 0),
    }));

    snapshots.push({
      id: `log:${log.sourcePath}:${log.line}:context-usage`,
      at: log.timestamp,
      traceId: log.traceId,
      sessionId: log.sessionId,
      turnId: log.turnId,
      model: stringValue(context.model),
      totalChars,
      totalTokens,
      tokenMethod: tokenMethodValue(context.tokenMethod),
      confidence: tokenConfidenceValue(context.confidence),
      tokenizer: stringValue(context.tokenizer),
      categories: categoriesWithPercent,
      systemTools: arrayValue(context.systemTools).filter(isRecord).map(usageToolFromRecord),
      mcpTools: arrayValue(context.mcpTools).filter(isRecord).map(usageToolFromRecord),
      skills: arrayValue(context.skills).filter(isRecord).map(usageSkillFromRecord),
      messageBreakdown: arrayValue(context.messageBreakdown)
        .filter(isRecord)
        .map(usageMessageBreakdownFromRecord),
      warnings: arrayValue(context.warnings).filter(
        (warning): warning is string => typeof warning === "string",
      ),
    });
  }

  if (snapshots.length === 0) {
    snapshots.push(...contextUsageSnapshotsFromDb(traceId, sessions, observation.db.records[0]));
  }

  return snapshots.sort((left, right) => compareIsoAsc(left.at, right.at));
}

/**
 * 从 SQLite 记录兜底还原上下文用量。
 * 局限：DB 只保存总计/未分块的 token 统计，只能给出 system/context/system_prompt 粗粒度归类，
 * 因此 confidence 固定为 low，并记录无法拆分到工具/技能的原因。
 */
// DB 兜底只认 step-finish 片段，且 input token 必须为正。
// 分类固定为一条「模型输入（SQLite 聚合）」，percentTokens 恒为 1：
// 既然只有一个分类，占比就是 100%，不要按总 token 再算一次。
// 两条 warnings 是给用户看的「为什么这里只有总数」，不要删减。
function contextUsageSnapshotsFromDb(
  traceId: string,
  sessions: Set<string>,
  db?: DbObservation,
): ContextUsageSnapshotView[] {
  if (!db || sessions.size === 0) return [];
  const snapshots: ContextUsageSnapshotView[] = [];

  for (const part of db.parts) {
    if (!sessions.has(part.sessionId) || part.type !== "step-finish") continue;
    const tokens = isRecord(part.data.tokens) ? part.data.tokens : undefined;
    if (!tokens) continue;
    const inputTokens = numberValue(tokens.input) ?? 0;
    if (inputTokens <= 0) continue;

    snapshots.push({
      id: `sqlite:${part.id}:context-usage`,
      at: part.createdAt,
      traceId,
      sessionId: part.sessionId,
      totalChars: 0,
      totalTokens: inputTokens,
      tokenMethod: "provider_usage",
      confidence: "low",
      categories: [
        {
          id: `sqlite-input:${part.id}`,
          name: "模型输入（SQLite 聚合）",
          source: "other",
          chars: 0,
          tokens: inputTokens,
          percentTokens: 1,
          tokenMethod: "provider_usage",
          confidence: "low",
        },
      ],
      systemTools: [],
      mcpTools: [],
      skills: [],
      messageBreakdown: [],
      warnings: [
        "SQLite step-finish 只保存聚合 input token，无法拆分系统提示、技能、工具和消息。",
        "要看真实上下文分块，需要用 dev 运行形态重新运行被测 CLI。",
      ],
    });
  }

  return snapshots;
}

// 分类缺少 name 时用「分类 N」占位，id 再基于 index+name 生成 slug：
// 只用 name 做 id 会在多条同名分类时冲突。
// 数值字段统一 numberValue 兜底为 0，method/confidence 保留 undefined 表示「未声明」。
function usageCategoryFromRecord(
  category: Record<string, unknown>,
  index: number,
): ContextUsageCategory {
  const name = stringValue(category.name) ?? `分类 ${index + 1}`;
  return {
    id: stringValue(category.id) ?? slug(`${index}-${name}`),
    name,
    source: contextUsageSourceValue(category.source),
    chars: numberValue(category.chars) ?? 0,
    tokens: numberValue(category.tokens) ?? 0,
    percentTokens: numberValue(category.percentTokens) ?? 0,
    tokenMethod: tokenMethodValue(category.tokenMethod),
    confidence: tokenConfidenceValue(category.confidence),
    tokenizer: stringValue(category.tokenizer),
  };
}

// 工具来源只有两种：mcp_tool 与 system_tool。
// 非 mcp_tool 一律归为 system_tool，不做第三态 ——
// 协议上工具只可能来自这两处，多一个 unknown 会让前端多一条无意义分支。
// readOnly 只在确实是 boolean 时才透出，字符串 "true" 不算。
function usageToolFromRecord(tool: Record<string, unknown>): ContextUsageToolDetail {
  return {
    name: stringValue(tool.name) ?? "unknown",
    source: stringValue(tool.source) === "mcp_tool" ? "mcp_tool" : "system_tool",
    chars: numberValue(tool.chars),
    tokens: numberValue(tool.tokens) ?? 0,
    tokenMethod: tokenMethodValue(tool.tokenMethod),
    confidence: tokenConfidenceValue(tool.confidence),
    tokenizer: stringValue(tool.tokenizer),
    readOnly: typeof tool.readOnly === "boolean" ? tool.readOnly : undefined,
    serverName: stringValue(tool.serverName),
    sideEffectScope: stringValue(tool.sideEffectScope),
  };
}

function usageSkillFromRecord(skill: Record<string, unknown>): ContextUsageSkillDetail {
  return {
    name: stringValue(skill.name) ?? "unknown",
    source: stringValue(skill.source),
    scope: stringValue(skill.scope),
    path: stringValue(skill.path),
    chars: numberValue(skill.chars),
    tokens: numberValue(skill.tokens) ?? 0,
    tokenMethod: tokenMethodValue(skill.tokenMethod),
    confidence: tokenConfidenceValue(skill.confidence),
    tokenizer: stringValue(skill.tokenizer),
  };
}

// 按 role 聚合的消息分块。role 缺失时记 unknown 而不是丢弃：
// 总数仍然要能对上，丢掉会让 sum(breakdown) 小于 totalTokens。
function usageMessageBreakdownFromRecord(
  message: Record<string, unknown>,
): ContextUsageMessageBreakdown {
  return {
    role: stringValue(message.role) ?? "unknown",
    count: numberValue(message.count) ?? 0,
    chars: numberValue(message.chars) ?? 0,
    tokens: numberValue(message.tokens) ?? 0,
    tokenMethod: tokenMethodValue(message.tokenMethod),
    confidence: tokenConfidenceValue(message.confidence),
    tokenizer: stringValue(message.tokenizer),
  };
}

// 统一计算 totalChars/totalTokens 与每段占比。
// 占比用「段 token / 总 token」，因此所有段的 percentTokens 之和为 1；
// 总 token 为 0 时全部置 0，这是 INV-13 的唯一实现点。
// 注意 sections 是浅拷贝：不修改调用方传入的数组元素。
function finalizeContextSnapshot(
  input: Omit<ContextSnapshotView, "totalChars" | "totalTokens">,
): ContextSnapshotView {
  const totalTokens = input.sections.reduce((sum, section) => sum + section.tokens, 0);
  const totalChars = input.sections.reduce((sum, section) => sum + section.chars, 0);
  const sections = input.sections.map((section) => ({
    ...section,
    percentTokens: totalTokens > 0 ? section.tokens / totalTokens : 0,
  }));
  return {
    ...input,
    totalChars,
    totalTokens,
    sections,
  };
}

/**
 * 按 markdown 标题从系统提示词推导段落。
 * 行为：只识别一级/二级标题作为段边界；未匹配到的前言归入 preamble 段。
 * 输出：段落 token 数为字符粗估（见 `estimateTokens`），仅用于展示占比，不作为计费依据。
 */
// 只识别 # 与 ## 两级标题：### 及更深层视为正文，
// 否则一个层级很深的提示词会被切成几十个无意义的段。
// 没有任何标题时整段作为「系统提示」一段返回，而不是返回空（空会让前端显示未采集）。
// preamble 只取第一个标题之前的非空内容，避免开头的换行变成独立段。
function deriveSectionsFromSystemPrompt(systemPrompt: string): ContextSectionView[] {
  const matches = [...systemPrompt.matchAll(/^(#{1,2})\s+(.+)$/gm)];
  if (matches.length === 0) {
    return [
      makeSection({
        id: "system-prompt",
        name: "系统提示",
        source: "system_prompt",
        content: systemPrompt,
        observable: "full",
      }),
    ];
  }

  const sections: ContextSectionView[] = [];
  const firstIndex = matches[0]?.index ?? 0;
  if (firstIndex > 0) {
    const preamble = systemPrompt.slice(0, firstIndex).trim();
    if (preamble.length > 0) {
      sections.push(
        makeSection({
          id: "preamble",
          name: "系统提示",
          source: "system_prompt",
          content: preamble,
          observable: "full",
        }),
      );
    }
  }

  for (const [index, match] of matches.entries()) {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? systemPrompt.length;
    const name = match[2]?.trim() ?? "段落";
    const content = systemPrompt.slice(start, end).trim();
    sections.push(
      makeSection({
        id: slug(`${index}-${name}`),
        name,
        source: categorizeSection(name),
        content,
        observable: "full",
      }),
    );
  }

  return sections;
}

// 从事件 payload 的 contextSnapshot 读段落元数据。
// 没有 contextSnapshot 时返回空数组，由 observationLevel 标记为 inferred。
function sectionsFromPayload(payload?: Record<string, unknown>): ContextSectionView[] {
  const snapshot = isRecord(payload?.contextSnapshot) ? payload.contextSnapshot : undefined;
  const rawSections = arrayValue(snapshot?.sections).filter(isRecord);
  return rawSections.map((section, index) => sectionFromMetadata(section, `payload-${index}`));
}

function sectionsFromContextBuiltLog(log: LogRecord): ContextSectionView[] {
  const rawSections = arrayValue(log.context?.sections).filter(isRecord);
  return rawSections.map((section, index) => sectionFromMetadata(section, `log-${index}`));
}

// 元数据段落：chars 优先显式值，其次 preview 长度；
// tokens 优先显式值，其次按 preview 估算（不是按原文字符数，因为原文可能不可得）。
// observable 只由「有没有 content」决定，preview 不算全文。
function sectionFromMetadata(
  section: Record<string, unknown>,
  fallbackId: string,
): ContextSectionView {
  const name = stringValue(section.name) ?? fallbackId;
  const preview = stringValue(section.preview);
  return {
    id: stringValue(section.id) ?? slug(name),
    name,
    source: categorizeSection(stringValue(section.source) ?? name),
    chars: numberValue(section.chars) ?? preview?.length ?? 0,
    tokens: numberValue(section.tokens) ?? estimateTokens(preview ?? ""),
    percentTokens: 0,
    preview,
    content: stringValue(section.content),
    observable: stringValue(section.content) ? "full" : "metadata",
  };
}

// 从完整文本构造段落：chars 用原文长度，tokens 用估算函数。
// percentTokens 先置 0，由 finalizeContextSnapshot 统一回填 ——
// 在单段构造阶段算占比会拿到错误的分母。
function makeSection(input: {
  id: string;
  name: string;
  source: ContextSectionSource;
  content: string;
  observable: "full" | "metadata" | "inferred";
}): ContextSectionView {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    percentTokens: 0,
    preview: preview(input.content),
    content: input.content,
    observable: input.observable,
  };
}

/**
 * 构建缓存报告。
 * 行为：优先读取事件中的 cacheStats（model_complete/turn_complete）；缺失时按消息序列前缀推断分段；
 * 事件完全缺失时回落到 SQLite 会话级统计。
 * 输出：`hitRate` 无基数时为 null；`limitations` 说明推断型数据的可靠性边界。
 */
// 缓存报告以 model_request 为主键，一个请求一条报告。
// complete 与 turnComplete 都向后查找：cacheStats 通常落在 turn_complete 上，
// usage 落在 model_complete 上，两者不能互相替代。
// hitRate 的语义是「缓存读 token / 输入 token」，不是「命中消息数 / 总消息数」，
// 两者数值差异很大，不要为了好看而换分母。
// 只有完全没有报告时才整体回落到 DB，理由同用量快照。
function buildCacheReports(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): CacheReport[] {
  const reports: CacheReport[] = [];
  const traceEvents = observation.events.records
    .filter((event) => event.traceId === traceId)
    .sort((left, right) => compareIsoAsc(left.timestamp, right.timestamp));
  const modelRequests = traceEvents.filter((event) => event.type === "model_request");

  for (const request of modelRequests) {
    const complete = findNextEvent(traceEvents, request, "model_complete");
    const turnComplete = findNextEvent(traceEvents, request, "turn_complete");
    const usage = extractUsage(complete?.payload);
    const cacheStats = isRecord(turnComplete?.payload?.cacheStats)
      ? turnComplete?.payload?.cacheStats
      : undefined;
    const messages = arrayValue(request.payload?.messages).filter(isRecord);
    reports.push({
      id: `cache:${request.id}`,
      at: complete?.timestamp ?? request.timestamp,
      traceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      model: modelName(request.payload),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      hitRate: usage.inputTokens > 0 ? usage.cacheReadTokens / usage.inputTokens : null,
      segments: cacheSegmentsFromMessages(messages, cacheStats, usage.cacheReadTokens),
      limitations: cacheLimitations(messages, cacheStats, usage.cacheReadTokens),
    });
  }

  if (reports.length === 0) {
    reports.push(...cacheReportsFromDb(traceId, sessions, observation.db.records[0]));
  }

  return reports;
}

// 按 type + turnId + 时间三重约束向后查找。
// turnId 两方都有值时才比较：同一请求的 complete 可能不带 turnId。
// 返回第一个命中项，与 findMatchingEndEvent 保持同一策略。
function findNextEvent(
  events: EventRecord[],
  current: EventRecord,
  type: string,
): EventRecord | undefined {
  const currentAt = current.timestamp ?? "";
  return events.find((event) => {
    if (event.type !== type) return false;
    if (current.turnId && event.turnId !== current.turnId) return false;
    return !currentAt || !event.timestamp || event.timestamp >= currentAt;
  });
}

/**
 * 依据连续消息的缓存标记推断分段。
 * 行为：同 cached=true 的相邻消息合并为一段，段起点为“首个未命中位置”，用于近似还原前缀缓存边界。
 * 局限：消息级标记无法反映 provider 实际分块策略，故结果属于推断值而非精确统计。
 */
// 分段是「消息级近似」，不是 provider 的真实 cache block。
// hasPrefixStats 的两个条件缺一不可：
//   lastCacheHit 为真表示确实发生过前缀命中；
//   cachedMessages 已知才能划分 hit/miss 边界。
// status=unknown 时仍然保留消息条目，让总数与输入一致。
// reason 的优先级：有前缀统计 > 有缓存 token 但无归因 > 完全没有归因。
function cacheSegmentsFromMessages(
  messages: Record<string, unknown>[],
  cacheStats: Record<string, unknown> | undefined,
  cacheReadTokens: number,
): CacheSegment[] {
  const cachedMessages = numberValue(cacheStats?.cachedMessages);
  const lastCacheHit = cacheStats?.lastCacheHit === true;

  return messages.map((message, index) => {
    const content = String(message.content ?? "");
    const hasPrefixStats = lastCacheHit && cachedMessages !== undefined;
    const status = hasPrefixStats ? (index < cachedMessages ? "hit" : "miss") : "unknown";
    return {
      id: `message-${index}`,
      status,
      role: stringValue(message.role),
      source: "message",
      tokens: estimateTokens(content),
      chars: content.length,
      preview: preview(content),
      reason: hasPrefixStats
        ? "根据 runtime 的 cachedMessages 前缀统计推断。"
        : cacheReadTokens > 0
          ? "Provider 返回了缓存 token，但没有逐文本归因。"
          : "这条消息没有缓存归因信息。",
    };
  });
}

/** 汇总缓存数据的已知局限（缺失字段、推断来源），供前端以提示语展示，避免用户误读命中率。 */
// cacheLimitations 的三条文案互不排斥，可以同时出现。
// 这些文案直接面向排查者，修改时必须保持「说清不能做什么」而不是「说明没数据」。
function cacheLimitations(
  messages: Record<string, unknown>[],
  cacheStats: Record<string, unknown> | undefined,
  cacheReadTokens: number,
): string[] {
  const limitations: string[] = [];
  if (messages.length === 0) {
    limitations.push("当前观测源没有 provider 可见的 messages。");
  }
  if (!cacheStats) {
    limitations.push("缺少 turn_complete.cacheStats，无法判断逐文本命中状态。");
  }
  if (cacheReadTokens > 0) {
    limitations.push("Provider 的缓存 token 不会标出具体命中文本。");
  }
  return limitations;
}

// DB 兜底只认 step-finish，且 tokens 必须是对象。
// read/write 缺失时按 0 处理，但 limitations 会区分「有缓存 token」与「未观察到缓存」，
// 避免用户把「没采到」误读为「确实没命中」。
// segments 固定为空数组：DB 没有逐文本信息，不能伪造分段。
function cacheReportsFromDb(
  traceId: string,
  sessions: Set<string>,
  db?: DbObservation,
): CacheReport[] {
  if (!db || sessions.size === 0) return [];
  const reports: CacheReport[] = [];

  for (const part of db.parts) {
    if (!sessions.has(part.sessionId) || part.type !== "step-finish") continue;
    const tokens = isRecord(part.data.tokens) ? part.data.tokens : undefined;
    if (!tokens) continue;
    const cache = isRecord(tokens?.cache) ? tokens.cache : undefined;
    const read = numberValue(cache?.read) ?? 0;
    const write = numberValue(cache?.write) ?? 0;
    const inputTokens = numberValue(tokens?.input) ?? 0;
    reports.push({
      id: `sqlite-cache:${part.id}`,
      at: part.createdAt,
      traceId,
      sessionId: part.sessionId,
      inputTokens,
      outputTokens: numberValue(tokens?.output) ?? 0,
      totalTokens: numberValue(tokens?.total) ?? 0,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      hitRate: inputTokens > 0 ? read / inputTokens : null,
      segments: [],
      limitations:
        read > 0 || write > 0
          ? ["SQLite 里有聚合缓存 token，但没有逐文本 cache report。"]
          : ["SQLite 里有 token usage，未观察到 cache read/write。"],
    });
  }

  return reports;
}

/**
 * 生成“需要业务侧补充埋点”的建议清单。
 * 逻辑：逐项检查观测能力（上下文正文、token 分项、缓存、工具耗时、归因 id），
 * 缺失时输出可执行的补充建议（建议事件名 + 期望字段）。
 * 输出：仅建议，不修改任何采集配置；排查时可作为埋点补齐的 checklist。
 */
// 三条建议对应三种观测断点，判定条件彼此独立：
//   1) 没有 full 级上下文快照 -> 补 context_snapshot；
//   2) 没有逐文本缓存归因 -> 补 prompt_cache_report；
//   3) 完全没有事件 -> 补 Session event JSONL sink。
// hasExactCache 要求同时有 contentHash 与确定的 hit/miss：
// 只有 status 没有 hash 的分段无法用于跨请求比对，不算「精确」。
// 本函数只产出建议，不修改任何采集配置（INV-20）。
function buildDeveloperRequests(
  observation: LoadedObservation,
  snapshots: ContextSnapshotView[],
  reports: CacheReport[],
): DeveloperRequest[] {
  const requests: DeveloperRequest[] = [];
  const hasFullSnapshot = snapshots.some((snapshot) => snapshot.observationLevel === "full");
  const hasExactCache = reports.some((report) =>
    report.segments.some(
      (segment) =>
        Boolean(segment.contentHash) && (segment.status === "hit" || segment.status === "miss"),
    ),
  );

  if (!hasFullSnapshot) {
    requests.push({
      title: "在 model request 前产出 context_snapshot",
      eventName: "context_snapshot",
      reason: "当前数据源只能看到上下文元数据，或完全看不到 system prompt 文本。",
      schema: [
        "traceId/sessionId/turnId/modelRequestId",
        "sections[].name/source/chars/tokens/contentHash/preview/artifactRef",
        "messages[].role/chars/tokens/contentHash/sectionRefs",
      ],
    });
  }

  if (!hasExactCache) {
    requests.push({
      title: "产出逐文本 prompt cache report",
      eventName: "prompt_cache_report",
      reason: "Provider usage 只有缓存 token，没有说明哪些文本片段命中缓存。",
      schema: [
        "traceId/sessionId/turnId/modelRequestId",
        "usage.input/output/total/cacheRead/cacheWrite",
        "segments[].messageIndex/role/source/contentHash/tokens/cacheStatus/reason",
      ],
    });
  }

  if (observation.events.records.length === 0) {
    requests.push({
      title: "增加开发期 Session event JSONL sink",
      eventName: "session_event_jsonl_sink",
      reason: "结构化日志更像诊断索引；Session events 才是还原 trace 的事实来源。",
      schema: [
        "append-only JSONL through SessionEventSink",
        "same envelope fields as docs/design/v2/logging.md",
        "redacted artifact refs for large payloads",
      ],
    });
  }

  return requests;
}

/**
 * 从事件 payload 提取 usage。
 * 兼容性：同时接受 snake_case 与 camelCase 字段，并优先读取 `cache` 子对象中的缓存读写量；
 * 缺失分项返回 undefined，调用方据此标记“未采集”而不是 0。
 */
// payload.usage 是标准位置，但部分事件把 usage 字段平铺在 payload 上，
// 因此 usage 存在就用它，否则退回 payload 自身。
// 每个字段的 ?? 链顺序 = 字段名优先级：camelCase > snake_case > cache 子对象。
// cache.read/write 放在最后，因为旧版本只有平铺的 cacheReadTokens。
// 全部缺失时返回 0 而不是 undefined：调用方以数字参与求和。
function extractUsage(payload?: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const usage = isRecord(payload?.usage) ? payload.usage : payload;
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  return {
    inputTokens: numberValue(usage.inputTokens) ?? numberValue(usage.input) ?? 0,
    outputTokens: numberValue(usage.outputTokens) ?? numberValue(usage.output) ?? 0,
    totalTokens: numberValue(usage.totalTokens) ?? numberValue(usage.total) ?? 0,
    cacheReadTokens:
      numberValue(usage.cacheReadTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.read : undefined) ??
      0,
    cacheWriteTokens:
      numberValue(usage.cacheWriteTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.write : undefined) ??
      0,
  };
}

// 事件摘要按 type 分派，每个分支都必须能在 payload 缺失时给出可读文本。
// model_request 会展开 provider messages，是详情页信息量最大的一条；
// tool_* 四类共用一个分支，只换标题行，避免四处重复。
// default 分支保留 type 原文：新增事件类型至少不会显示空白行。
function summarizeEvent(event: EventRecord): string {
  const payload = event.payload;
  switch (event.type) {
    case "model_request": {
      const title = `模型请求 ${modelName(payload) ?? ""}`.trim();
      const messages = summarizeProviderMessages(payload);
      return messages ? `${title}\n${messages}` : title;
    }
    case "model_complete": {
      const usage = extractUsage(payload);
      const title = `模型完成，${usage.totalTokens || usage.inputTokens + usage.outputTokens} Token`;
      const content = textFromPayload(payload);
      return content ? `${title}\n${content}` : title;
    }
    case "tool_call_scheduled":
    case "tool_call_started":
    case "tool_call_result":
    case "tool_call_error":
      return [
        `${stringValue(payload?.toolName) ?? "工具"} ${stringValue(payload?.toolCallId) ?? ""}`.trim(),
        textFromPayload(payload),
      ]
        .filter(Boolean)
        .join("\n");
    case "turn_complete":
      return `轮次完成：${stringValue(payload?.resultType) ?? "success"}`;
    case "user_message":
    case "assistant_message":
      return textFromPayload(payload) ?? String(payload?.content ?? event.type);
    default:
      return [event.type, textFromPayload(payload)].filter(Boolean).join("\n");
  }
}

function summarizeDbMessage(message: DbMessageRecord): string {
  const text = stringValue(message.data.text) ?? stringValue(message.data.content);
  const title = `${formatRole(message.role)}消息 ${message.id}`;
  return text ? `${title}: ${text}` : title;
}

function summarizeProviderMessages(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const messages = arrayValue(payload?.messages).filter(isRecord);
  if (messages.length === 0) return undefined;

  return messages
    .map((message, index) => {
      const role = stringValue(message.role) ?? `message ${index + 1}`;
      const content = textFromPayload(message) ?? stringifyTimelineValue(message);
      return `${role}: ${content}`;
    })
    .join("\n");
}

function firstUserMessageFromEvent(event: EventRecord): string | undefined {
  if (event.type === "user_message") {
    return textFromPayload(event.payload);
  }

  const messages = arrayValue(event.payload?.messages).filter(isRecord);
  const userMessage = messages.find((message) => stringValue(message.role) === "user");
  return userMessage ? textFromPayload(userMessage) : undefined;
}

function textFromDbMessage(message: DbMessageRecord): string | undefined {
  return textFromPayload(message.data);
}

function textFromDbParts(parts: DbPartRecord[] | undefined): string | undefined {
  const textParts = parts
    ?.map((part) => textFromPayload(part.data))
    .filter((text): text is string => Boolean(text?.trim()));
  if (!textParts || textParts.length === 0) return undefined;
  return textParts.join("\n");
}

// 文本提取的三级回退 content -> text -> message，
// 对应三种历史上出现过的字段命名。
// 返回 undefined 而不是空串：调用方用它区分「没有文本」与「空文本」。
function textFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  return (
    textFromContent(payload.content) ??
    textFromContent(payload.text) ??
    textFromContent(payload.message)
  );
}

// 递归抽取任意 content 结构里的文本：
//   字符串直接返回；
//   数组逐项抽取并过滤空值后以空格连接；
//   对象再看 text / content 两个键。
// 递归深度由数据结构本身限制（协议不会无限嵌套），因此不需要显式 depth 参数。
// 数组里非字符串非对象的项被丢弃，不以 [object Object] 形式混入摘要。
function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        return textFromContent(part.text) ?? textFromContent(part.content) ?? "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (isRecord(content)) {
    return textFromContent(content.text) ?? textFromContent(content.content);
  }
  return undefined;
}

// 角色展示名带尾随空格，供调用方直接拼「消息」二字。
// 未知角色返回空串而不是 unknown：时间线标题会退化成「消息」，比「unknown 消息」更可读。
function formatRole(role?: string): string {
  switch (role) {
    case "system":
      return "system ";
    case "user":
      return "user ";
    case "assistant":
      return "assistant ";
    case "tool":
      return "tool ";
    default:
      return "";
  }
}

function summarizeDbPart(part: DbPartRecord): string {
  const text = stringValue(part.data.text) ?? stringValue(part.data.output);
  return text ? `${part.type ?? "片段"}: ${text}` : `${part.type ?? "片段"} ${part.id}`;
}

// 工具调用 id 只认 toolCallId 这一个键。
// 不要在这里兼容 tool_call_id：snake_case 的转换已在事件解析层完成，
// 在分析层再兼容会让「协议字段」与「展示兜底」的界限变模糊。
function eventToolCallId(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolCallId);
}

function eventToolName(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolName) ?? stringValue(payload?.name);
}

function subagentLabel(event: EventRecord): string {
  return (
    stringValue(event.payload?.name) ??
    stringValue(event.payload?.subagentId) ??
    stringValue(event.payload?.subagentSessionId) ??
    "子 Agent"
  );
}

// 模型名优先从 modelSelection.modelId 取，其次才是平铺的 model。
// modelSelection 是较新的协议位置；平铺字段只用于兼容旧事件。
function modelName(payload?: Record<string, unknown>): string | undefined {
  const modelSelection = isRecord(payload?.modelSelection) ? payload.modelSelection : undefined;
  return stringValue(modelSelection?.modelId) ?? stringValue(payload?.model);
}

// 同时匹配人类可读 message 与结构化 event 两种写法：
// 不同运行形态输出的日志格式不同，只认一种会漏掉一半数据。
function isContextBuiltLog(log: LogRecord): boolean {
  return log.message === "Context built" || log.event === "context.built";
}

function isContextUsageSnapshotLog(log: LogRecord): boolean {
  return log.message === "Context usage snapshot" || log.event === "context_usage_snapshot";
}

// 白名单枚举，未知值统一归为 other。
// 这里不能用 as：该值来自外部 JSON，直接断言会把非法字符串带进类型系统。
function contextUsageSourceValue(value: unknown): ContextUsageCategory["source"] {
  switch (value) {
    case "system_prompt":
    case "meta_user_context":
    case "skills":
    case "tool_prompt":
    case "system_tool_schemas":
    case "mcp_tool_schemas":
    case "messages":
    case "other":
      return value;
    default:
      return "other";
  }
}

// 未知 method 返回 undefined 而不是 other：
// method 缺失表示「未声明」，与「声明为其他方法」语义不同。
function tokenMethodValue(value: unknown): TokenMethod | undefined {
  switch (value) {
    case "estimated":
    case "provider_count":
    case "proportional_estimate":
    case "provider_usage":
      return value;
    default:
      return undefined;
  }
}

function tokenConfidenceValue(value: unknown): TokenConfidence | undefined {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return undefined;
  }
}

// 按名称关键字归类段落，中英文都要匹配：
// 标题来自系统提示，是自然语言，categorizeSection 不能假设只有英文。
// 判断顺序 skills -> tools -> system_prompt，
// 因为「tool instructions」这类标题同时含 tool 与 instruction，应归到 tools。
function categorizeSection(nameOrSource: string): ContextSectionSource {
  const normalized = nameOrSource.toLowerCase();
  if (normalized.includes("skill") || normalized.includes("技能")) return "skills";
  if (normalized.includes("tool") || normalized.includes("工具")) return "tools";
  if (
    normalized.includes("identity") ||
    normalized.includes("system") ||
    normalized.includes("instruction") ||
    normalized.includes("env") ||
    normalized.includes("project") ||
    normalized.includes("prompt") ||
    normalized.includes("user_instructions") ||
    normalized.includes("project_context")
  ) {
    return "system_prompt";
  }
  return "other";
}

// 只接受四个标准级别，其余返回 undefined。
// 返回 undefined 而不是 info：前端据此可以把「未标注级别」渲染成中性样式，
// 与真正的 info 区分开。
function normalizeLogLevel(level?: string): TimelineItem["severity"] {
  switch (level) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      return undefined;
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringifyTimelineValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// 预览先折叠所有空白为单空格，再按长度截断并补省略号。
// 截断长度减 1 是给省略号留位置：
// 保证输出总长不超过 maxLength，否则列表行高会被撑开。
function preview(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

/** 粗略 token 估算：ASCII 约 4 字符/token，中文约 2 字符/token；只用于占比展示，不作为真实计费口径。 */
// 粗估公式：(中文字数 * 2 + 其他字符数) / 3 向上取整。
// 等价于中文约 1.5 字/token、英文约 3 字符/token，是保守估计。
// 该值只用于占比展示，任何计费或配额判断都不得使用它。
function estimateTokens(text: string): number {
  const chineseChars = text.match(/[一-鿿]/g)?.length ?? 0;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / 3);
}

// slug 化：小写、非字母数字转连字符、去首尾连字符。
// 结果为空时回退到 section：纯中文标题会被完全过滤掉，
// 没有兜底会让多个段落共用空 id，进而在 React 列表里互相覆盖。
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

// 缺失时间统一排最后：两个都缺返回 0（保持稳定），左缺返回 1，右缺返回 -1。
// 有值时用 localeCompare，不做 Date 解析 ——
// ISO 字符串的字典序与时间序一致，且不会因非法值产生 NaN。
function compareIsoAsc(left?: string, right?: string): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
}

function compareIsoDesc(left?: string, right?: string): number {
  return compareIsoAsc(right, left);
}
