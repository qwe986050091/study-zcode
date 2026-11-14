// INV-01 [契约] 全文件只允许类型声明，运行时必须完全擦除；守住位置：ObservationSourceKind 到 TraceDetailResponse 的导出面；改错故障：混入值或函数后 web 端会把服务端模块打进 bundle，并在 Node 专属依赖上编译失败。
// INV-02 [契约] ObservationSourceKind 是封闭四值 log/eventlog/sqlite/network，SourceStatus.kind 与之一一对应；守住位置：kind 联合与 SourceStatus；改错故障：新增源未同步产出端与前端映射，该源面板落进默认空态并显示为未知。
// INV-03 [边界] traceId/sessionId/turnId/spanId/parentSpanId/toolCallId 全部可选，缺省表示源头未提供而非空串；守住位置：TimelineItem、TraceSpan、NetworkRequestAttribution；改错故障：消费方补造关联键，网络请求被错误并入无关 trace。
// INV-04 [权衡] 时间统一为 ISO 字符串，TraceSpan.startAt 必填、endAt 缺省即进行中；守住位置：TimelineItem.at 与 TraceSpan.startAt/endAt；改错故障：用 0 或空串占位，甘特图把未完成 span 画成已完成或负时长。
// INV-05 [契约] TraceSpanLane 是封闭九值集合，lane 决定甘特图的分行归属；守住位置：TraceSpan.lane；改错故障：新增 lane 未登记分组，该 span 在所有泳道里整行消失。
// INV-06 [失败路径] TraceSpanStatus 必须区分 error、cancelled 与 unknown，用户取消和解析失败都不得降级成 error；守住位置：TraceSpan.status；改错故障：取消被计入失败率，错误统计与重试建议全部失真。
// INV-07 [契约] severity 仅在可判定级别时出现，summary 是展示用单行文本；守住位置：TimelineItem.severity 与 summary；改错故障：未知级别塞默认值，配色和筛选把普通日志当成错误。
// INV-08 [契约] tokens 必须由 tokenMethod 说明来源，provider_count 与 estimated 不可直接比较；守住位置：TokenMeasurement 及 ContextUsage 的四个继承者；改错故障：估算值被当成精确值，缓存收益与预算判断被高估。
// INV-09 [契约] TokenConfidence 三档只描述置信度，不替代 tokenMethod 的算法口径；守住位置：TokenMeasurement.confidence；改错故障：界面用 confidence 反推统计方式，展示出错误的计量来源。
// INV-10 [契约] ContextSectionView.observable 与 ContextSnapshotView.observationLevel 同为 full/metadata/inferred，两处口径必须一致；守住位置：两个上下文档位接口；改错故障：快照显示 full 而分区只有 metadata，用户误以为上下文已完整采集。
// INV-11 [失败路径] 无法归因或缺失的部分必须写进警告数组，不得静默丢弃；守住位置：ContextSnapshotView.warnings、ContextUsageSnapshotView.warnings、CacheReport.limitations；改错故障：总量与分区之和对不上却没有任何提示。
// INV-12 [契约] percentTokens 是服务端算好的占比，前端不得用 tokens 除以总量重算；守住位置：ContextSectionView.percentTokens 与 ContextUsageCategory.percentTokens；改错故障：估算与 provider 口径混算，饼图各项之和偏离 100。
// INV-13 [权衡] CacheReport.hitRate 为 null 表示缺少命中与写入基数，不等于 0% 命中；守住位置：CacheReport.hitRate 与 CacheSegmentStatus.unknown；改错故障：无数据被渲染成零命中，用户误判缓存已失效。
// INV-14 [资源] 抓包记录只保留 header 计数与 body 字节数，正文默认不落盘；守住位置：NetworkRequestRecord 的 requestBodyBytes/responseBodyBytes；改错故障：新增正文字段会让 Cookie 与鉴权头随 SSE 泄露到前端。
// INV-15 [契约] NetworkCaptureEvent 以 type 判别四态，snapshot 全量替换、request 增量追加；守住位置：NetworkCaptureEvent 联合类型；改错故障：把 snapshot 当增量拼接，抓包列表出现重复条目。
// INV-16 [并发] ObservationChangeEvent.revision 单调递增，前端据此丢弃乱序或重复推送；守住位置：ObservationChangeEvent.revision；改错故障：旧 revision 覆盖新快照，指纹回退并触发无意义的重复刷新。
// INV-17 [契约] signature 只在同一组 kind、label、path 内比较，跨源签名相等不代表内容相同；守住位置：ObservationSourceFingerprint.signature；改错故障：不同源摘要碰撞导致变更事件漏报，面板长时间不刷新。
// INV-18 [契约] TraceListResponse 的 sources/projects/traces 同批返回，TraceDetailResponse 的全部区块按同一 traceId 聚合；守住位置：两个响应接口；改错故障：拆成多次请求后各区块来自不同快照，详情页自相矛盾。
//
// 模块职责：调试台前后端共享的数据契约，服务端（analyzer/sources/network-capture）产出、前端 App 消费，避免两侧字段口径漂移。
// 状态所有权：本文件不持有运行时状态；真实数据归各采集源与 SSE 推送，前端只读投影，不得回写或补造字段。
// 阅读顺序：先看 ObservationSourceKind 与 SourceStatus 确认数据来源，再看 TimelineItem/TraceSpan 时间线，最后看 Context/Cache/Network 三组快照与响应。
/**
 * 调试台前后端共享的数据契约。
 *
 * 职责：定义 SSE 事件、trace/span 时间线、上下文与缓存报告、抓包记录与 API 响应的结构，
 * 由服务端（analyzer/sources/network-capture）产出、前端 App 消费，避免两侧字段口径漂移。
 * 字段口径：时间均为 ISO 字符串；`traceId/sessionId/turnId` 为关联键，缺省表示源头未提供；
 * `observable` 用于标注上下文数据是完整采集、仅元数据还是推断值。
 * 副作用：纯类型声明，运行时擦除。
 */
// [契约] 四种源取值决定调试台分栏：日志、事件日志、SQLite、抓包各自独立采集，互不兜底。
// [失败路径] SourceStatus.available 为假时必须带 warning，前端展示不可用原因而不是空列表。
// [边界] recordCount 是该源原始记录数，不等于可归因到 trace 的条目数，两者不可互替。
// [权衡] path 仅用于展示与指纹比较，前端不得据此直接读文件，所有读取都走服务端。
// [契约] label 与 kind 共同构成用户可见的源身份，重命名 label 会让历史指纹全部失效。
// [回归] 新增源时先扩 kind 联合，再补 SourceStatus 产出，否则类型守卫会把它过滤掉。
export type ObservationSourceKind = "log" | "eventlog" | "sqlite" | "network";

export interface SourceStatus {
  kind: ObservationSourceKind;
  label: string;
  path?: string;
  available: boolean;
  recordCount: number;
  warning?: string;
}

/** trace 列表摘要；计数与首末时间来自事件/日志聚合，缓存 token 用于快速识别缓存收益。 */
export interface TraceSummary {
  traceId: string;
  sessionIds: string[];
  eventCount: number;
  logCount: number;
  firstAt?: string;
  lastAt?: string;
  firstUserMessage?: string;
  lastMessage?: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProjectSummary {
  projectId: string;
  label: string;
  directory: string;
  sessionCount: number;
  updatedAt?: string;
}

/** 统一时间线条目；`severity` 仅在可判定级别时有值，`summary` 为展示用单行文本。 */
// [契约] id 在单次 trace 内唯一，是前端列表 key 与选中态的唯一依据。
// [边界] at 可缺省；缺省表示源头没给时间，排序按到达顺序，不伪造当前时间。
// [权衡] payload 是 unknown 的原始负载，只用于展开详情，不参与筛选与搜索。
// [契约] source 与 kind 是两轴：source 说数据来自哪个源，kind 说事件语义，不可合并。
// [失败路径] severity 缺省表示无法判定级别，不能被前端默认成 info 或 error。
// [回归] summary 必须是单行文本，多行内容会撑破时间线行高并破坏虚拟滚动。
export interface TimelineItem {
  id: string;
  at?: string;
  source: ObservationSourceKind;
  kind: string;
  label: string;
  severity?: "debug" | "info" | "warn" | "error";
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  summary: string;
  payload?: unknown;
}

export type TraceSpanLane =
  | "turn"
  | "model"
  | "tool"
  | "network"
  | "permission"
  | "storage"
  | "subagent"
  | "event"
  | "log";

export type TraceSpanStatus = "running" | "ok" | "error" | "cancelled" | "unknown";

/** 甘特/泳道视图中的 span；`lane` 决定分行，`startAt` 必填、`endAt` 缺失表示仍在进行。 */
// [契约] startAt 必填、endAt 可缺省，缺省即进行中，这是判断未完成 span 的唯一信号。
// [权衡] durationMs 不在本文件冗余存储，展示层用起止时间相减，避免出现两个真相源。
// [边界] parentSpanId 指向同 trace 内的父 span，缺失表示根 span，不表示数据损坏。
// [契约] id 与 spanId 分工：id 是渲染行标识，spanId 是跨端关联的业务标识。
// [失败路径] lane 取值必须落在联合内，越界值会让该 span 在所有泳道都找不到归属。
// [回归] status 为 running 却带 endAt 属于自相矛盾，消费方以 endAt 缺失为准。
export interface TraceSpan {
  id: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  lane: TraceSpanLane;
  label: string;
  source: ObservationSourceKind;
  startAt: string;
  endAt?: string;
  status: TraceSpanStatus;
  summary?: string;
  payload?: unknown;
}

export type ContextSectionSource = "system_prompt" | "skills" | "tools" | "other";
export type TokenMethod = "estimated" | "provider_count" | "proportional_estimate" | "provider_usage";
export type TokenConfidence = "high" | "medium" | "low";

// [契约] TokenMeasurement 是 token 计量的最小单元，各统计结构通过继承复用它。
// [权衡] tokenMethod 缺省表示来源未知，展示为估算并降低 confidence，而不是当作精确值。
// [契约] proportional_estimate 表示按字符比例摊分，只适合分区展示，不适合计费。
// [失败路径] provider_usage 与 provider_count 不可互换：前者是实际用量，后者是计数接口。
// [边界] tokenizer 只记录分词器名称用于解释差异，不参与任何数值计算。
// [回归] 新增计量字段要同步四个继承者，漏改会让某一类分区丢掉口径变成裸数字。
export interface TokenMeasurement {
  tokens: number;
  tokenMethod?: TokenMethod;
  confidence?: TokenConfidence;
  tokenizer?: string;
}

export interface ContextSectionView {
  id: string;
  name: string;
  source: ContextSectionSource;
  chars: number;
  tokens: number;
  percentTokens: number;
  preview?: string;
  content?: string;
  observable: "full" | "metadata" | "inferred";
}

/** 上下文快照；`observable` 表示采集完整度，`warnings` 记录无法归因或缺失的部分。 */
export interface ContextSnapshotView {
  id: string;
  at?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  model?: string;
  totalChars: number;
  totalTokens: number;
  messageCount: number;
  sections: ContextSectionView[];
  systemPrompt?: string;
  observationLevel: "full" | "metadata" | "inferred";
  warnings: string[];
}

export type ContextUsageSource =
  | "system_prompt"
  | "meta_user_context"
  | "skills"
  | "tool_prompt"
  | "system_tool_schemas"
  | "mcp_tool_schemas"
  | "messages"
  | "other";

export interface ContextUsageCategory extends TokenMeasurement {
  id: string;
  name: string;
  source: ContextUsageSource;
  chars: number;
  percentTokens: number;
}

export interface ContextUsageToolDetail extends TokenMeasurement {
  name: string;
  source: "system_tool" | "mcp_tool";
  chars?: number;
  readOnly?: boolean;
  serverName?: string;
  sideEffectScope?: string;
}

export interface ContextUsageSkillDetail extends TokenMeasurement {
  name: string;
  source?: string;
  scope?: string;
  path?: string;
  chars?: number;
}

export interface ContextUsageMessageBreakdown extends TokenMeasurement {
  role: string;
  count: number;
  chars: number;
}

/** 上下文用量快照；token 数可能来自 provider 统计或估算，故携带 method/confidence 口径。 */
export interface ContextUsageSnapshotView {
  id: string;
  at?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  model?: string;
  totalChars: number;
  totalTokens: number;
  tokenMethod?: TokenMethod;
  confidence?: TokenConfidence;
  tokenizer?: string;
  categories: ContextUsageCategory[];
  systemTools: ContextUsageToolDetail[];
  mcpTools: ContextUsageToolDetail[];
  skills: ContextUsageSkillDetail[];
  messageBreakdown: ContextUsageMessageBreakdown[];
  warnings: string[];
}

export type CacheSegmentStatus = "hit" | "miss" | "unknown";

export interface CacheSegment {
  id: string;
  status: CacheSegmentStatus;
  role?: string;
  source?: ContextSectionSource | "message";
  tokens?: number;
  chars?: number;
  preview: string;
  contentHash?: string;
  reason?: string;
}

/** 缓存面板数据；`hitRate` 为 null 表示缺少可计算的命中/写入基数，区别于 0% 命中。 */
// [契约] hitRate 是服务端算好的比例，前端只做格式化，不用读写 token 重算。
// [权衡] cacheReadTokens 与 cacheWriteTokens 分开记账，写入不算命中，合并会虚高命中率。
// [失败路径] limitations 必须列出无法计算的原因，例如缺 usage 或缺分段，不能留空数组伪装完整。
// [边界] segments 顺序即上下文顺序，前端不得按 status 重排，否则对不上缓存分段布局。
// [契约] CacheSegment.preview 必填用于展示，content 可选且可能被裁剪，不能当全文使用。
// [资源] contentHash 只是分段指纹不落原文，据此判等即可，不要在前端回传内容比对。
export interface CacheReport {
  id: string;
  at?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hitRate: number | null;
  segments: CacheSegment[];
  limitations: string[];
}

export interface DeveloperRequest {
  title: string;
  reason: string;
  eventName: string;
  schema: string[];
}

export interface NetworkCaptureCertificateStatus {
  caDir?: string;
  caCertPath?: string;
  caPrivateKeyPath?: string;
  caPublicKeyPath?: string;
  caCertAvailable: boolean;
}

/** 抓包服务状态；`lastError` 非空表示代理启动/运行失败，前端据此展示降级提示。 */
export interface NetworkCaptureStatus {
  enabled: boolean;
  running: boolean;
  host?: string;
  port?: number;
  proxyUrl?: string;
  library: string;
  maxEntries: number;
  certificate: NetworkCaptureCertificateStatus;
  env: Record<string, string>;
  lastError?: string;
}

export interface NetworkRequestAttribution {
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
}

/**
 * 单条抓包记录。
 * 归因字段（traceId/sessionId/turnId/spanId）可能为空：无法关联时只展示网络视图，不并入 trace。
 * 体积字段记录 header 数与 body 字节数，正文默认不落盘，避免泄露敏感内容。
 */
// [契约] NetworkRequestAttribution 四键全可选：取不到就省略键而不是填空串，否则 trace 视图会按假归因并入错误链路。
// [失败路径] 未归因记录只进网络视图，不并入 trace 时间线，两条展示路径不可混用。
// [权衡] 只存 header 计数与 body 字节数、不存正文，体积统计与内容留存刻意解耦。
// [契约] status 三态 pending/complete/error 与 statusCode 正交，pending 时状态码可以不存在。
// [边界] protocol 覆盖 http/https/ws/wss，WebSocket 帧也按单条记录计，不能只按请求算。
// [资源] 请求与响应 header 已在服务端脱敏，前端不得再拼接原始 header 展示。
export interface NetworkRequestRecord extends NetworkRequestAttribution {
  id: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  protocol: "http" | "https" | "ws" | "wss";
  method: string;
  host: string;
  path: string;
  url: string;
  status: "pending" | "complete" | "error";
  statusCode?: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestHeaderCount: number;
  responseHeaderCount: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
  error?: string;
}

export interface NetworkRequestsResponse {
  status: NetworkCaptureStatus;
  requests: NetworkRequestRecord[];
}

/** 抓包 SSE 事件：status 状态变更、snapshot 全量快照、request 增量、reset 清空。 */
// [契约] type 是判别键：status 换状态、snapshot 全量、request 增量、reset 清空，四态互斥。
// [并发] snapshot 必须整体替换本地列表，与增量 request 交错到达时以 snapshot 为基线。
// [失败路径] reset 只清列表不清服务端状态，收到后仍需以 status 事件刷新运行态。
// [权衡] status 事件携带完整 NetworkCaptureStatus，避免前端为拿 lastError 再发一次请求。
// [边界] 事件只走 SSE 单向推送，前端不得据本地推测补发事件或回写服务端。
// [回归] 新增事件类型必须同步消费端穷举分支，否则未知 type 会被静默丢弃。
export type NetworkCaptureEvent =
  | { type: "status"; status: NetworkCaptureStatus }
  | { type: "snapshot"; requests: NetworkRequestRecord[] }
  | { type: "request"; request: NetworkRequestRecord }
  | { type: "reset" };

/** 观测源指纹；`signature` 是内容/元数据摘要，仅比较同 (kind,label,path) 的签名判断变化。 */
export interface ObservationSourceFingerprint {
  kind: ObservationSourceKind;
  label: string;
  path: string;
  exists: boolean;
  signature: string;
}

export interface ObservationHelloEvent {
  generatedAt: string;
  intervalMs: number;
  sources: ObservationSourceFingerprint[];
}

/** 变更事件；`revision` 单调递增，前端可据此丢弃乱序或重复推送。 */
export interface ObservationChangeEvent {
  revision: number;
  changedAt: string;
  changedSources: ObservationSourceFingerprint[];
  sources: ObservationSourceFingerprint[];
}

export interface ObservationSourceErrorEvent {
  checkedAt: string;
  message: string;
}

/** `/api/traces` 响应：源可用状态 + 项目聚合 + trace 摘要，三者同批返回避免前端多次请求。 */
export interface TraceListResponse {
  sources: SourceStatus[];
  projects: ProjectSummary[];
  traces: TraceSummary[];
}

/** trace 详情响应：时间线/span/上下文/缓存/扩展请求均按同一 trace 聚合输出。 */
export interface TraceDetailResponse {
  traceId: string;
  sessions: string[];
  sources: SourceStatus[];
  timeline: TimelineItem[];
  spans: TraceSpan[];
  contextSnapshots: ContextSnapshotView[];
  contextUsageSnapshots: ContextUsageSnapshotView[];
  cacheReports: CacheReport[];
  developerRequests: DeveloperRequest[];
}
