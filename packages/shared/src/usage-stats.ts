// INV-01 估算比例只有一处定义：字符数经该常量换算为估算 token。守住位置：ESTIMATED_TOKEN_CHAR_DIVISOR 与 UsageStatsSnapshot.estimatedTokenCharDivisor；改错故障：消费端硬编码 3，常量调整后新旧快照混算，汇总总量与模型占比互不相等。
// INV-02 quota 契约只从 usage-quota.ts 来，此处仅 re-export。守住位置：第 5 行的星号 re-export 与第 6、7 行的 type 导入；改错故障：在此重定义 UsageQuotaSnapshot，结构兼容仍能编译，但 entitlement 与 mcpQuota 字段来源分叉，校验先于实现漂移。
// INV-03 两套区间词汇不可合并：App Usage 三档，Coding Plan 多一档 custom。守住位置：UsageStatsRange 与 CodingPlanUsageRange；改错故障：给前者补 custom 却不改聚合，自定义区间被当作 all，统计口径被静默放大。[权衡]
// INV-04 数据源必须显式声明。守住位置：UsageStatsRequest.dataSource 的 local 与 monitor 两值；改错故障：留空后由实现猜测来源，App Usage 读 monitor、Coding Plan 读本地 session，同一页面出现两组数字。
// INV-05 指定来源与禁止回退必须成对传。守住位置：preferredProviderId 与 requirePreferredProvider 同时出现在 UsageStatsRequest 与 UsageEntitlementRequest；改错故障：只传 id 不传标志，实现回退到第一家 provider，设置页显示的不是用户选中来源。
// INV-06 环境变量覆盖密钥可关闭。守住位置：allowEnvApiKey 在用量请求与权益请求两处的注释；改错故障：显式 provider 场景被 host 环境变量顶掉，请求打到非预期账号且难以复现。[失败路径]
// INV-07 时区由调用端决定，host 只做兜底。守住位置：UsageStatsRequest.timeZone 注释与 UsageStatsSnapshot.timeZone 必填；改错故障：快照不带时区，UI 按浏览器重算自然日，跨时区用户日桶与热力图整体错一天。
// INV-08 自定义区间按调用端自然日解释且上限 30 天。守住位置：CodingPlanUsageRequest 的 customStartDate、customEndDate 注释与 range 为 custom 的前提；改错故障：改收时间戳或放开长度，服务端按天补齐时溢出，折线点数与刻度不符。
// INV-09 高速 TPS 请求必须携带 accountAccess。守住位置：CodingPlanRegularTpsRequest.accountAccess 及其上方 Bug 原因注释；改错故障：缺失时鉴权解析返回空，节省时间静默不展示且无报错线索。[失败路径]
// INV-10 权益不得由额度反推。守住位置：UsageEntitlementRequest.includeSubscription 注释与 UsageEntitlementSnapshot.subscription 可空；改错故障：以剩余额度大于零判定已订阅，无 Plan 用户看到错误的权益入口。
// INV-11 本地生成时间与服务端时间必须分开。守住位置：UsageEntitlementSnapshot.generatedAt 与 serverTime；改错故障：用本地时钟冒充服务端时间，重置倒计时随时区与系统时钟漂移。
// INV-12 失效原因与 Plan 状态互斥。守住位置：unavailableReason 四值、startPlanExpired、teamPlanUnavailableReason 注释限定仅与 no_plan 同返；改错故障：团队原因在 no_plan 之外也下发，UI 同时渲染已过期与有权益。
// INV-13 MCP 额度是可选数据面，失败即 null。守住位置：UsageEntitlementSnapshot.mcpQuota 的可选可空类型与注释列举的三类失败情形；改错故障：失败抛错或填零，MCP 区块显示零额度，用户误判已用尽。[失败路径]
// INV-14 可空语义表示无数据而非零值。守住位置：CodingPlanUsageDetailSummary 的 cacheHitRate 与两个 trend 字段、UsageStatsSummary 的 mostActiveDay、favoriteModel、peakHour，以及 avgTimeToFirstTokenMs；改错故障：空数据填零后缓存命中率零与无缓存调用混为一谈，趋势线从零起跳。[权衡]
// INV-15 热力图补位单元必须可空。守住位置：UsageStatsHeatmapWeek.days 与 appUsageHeatmapWeekSchema.days 的 nullable 元素；改错故障：用零值单元补月初月末空位，热力图出现真实零 token 格子，连续天数被拉长。
// INV-16 日序列按日期连续补零。守住位置：UsageStatsSnapshot.daily 上方注释；改错故障：只在有数据的日子出点，横轴被压缩，7d、30d 与 all 的斜率不可比。
// INV-17 schema 与类型同源。守住位置：APP_USAGE_RANGES 同时喂给 z.enum 与 AppUsageRange，AppUsage 系列类型全部由 zod 推断；改错故障：另写一份 interface 后只改一侧，IPC 边界校验通过但字段缺失。[权衡]
// INV-18 时间轴与各序列等长。守住位置：CodingPlanModelUsageSnapshot、CodingPlanToolUsageSnapshot、CodingPlanHealthSnapshot 的 xTime 与 tokensUsage、usageCount、proMaxDecodeSpeed 等数组，以及 UsageStatsToolUsage.dailyCalls 对 daily；改错故障：某序列少一天，按索引对齐时错位到相邻日期，健康曲线与用量曲线不同步。
//
// 模块职责：定义 App Usage 与 Coding Plan 用量的请求、快照与聚合结果类型，以及 App Usage 的 zod 运行时校验，是 shared 协议层唯一的用量统计契约来源。
// 状态所有权：本文件只声明数据结构与常量，不持有状态、不发起请求、不做聚合；字符到 token 的换算与日桶补齐由各端聚合实现完成。
// 阅读顺序：先看额度类型 re-export 与估算除数，再看两类请求、权益快照，随后是 App Usage 的 schema 与推断类型，最后是 Coding Plan 与本地统计的快照结构。
/* eslint-disable max-lines -- Usage、Entitlement 与 Reset 的跨进程协议需要共享同一组 Account Access 字段和运行时 schema，暂时集中维护。 */
import { z } from "zod";

// 额度类型拆在 usage-quota.ts，见该文件头部说明；这里 re-export 保持既有 import 路径不变。
// [边界] 本文件是 usage 统计的协议面：请求、快照、App Usage 的 zod schema 与推断类型。
// [边界] 额度类型与校验留在 usage-quota.ts，此处 re-export 只为保住既有导入路径，调用方无需改 import。
// [契约] 首行禁用 max-lines 的原因已写明：Account Access 字段要在 Usage、Entitlement、Reset 三处保持一致，拆分反而制造漂移风险。
// [契约] 两个 type 导入分别取额度快照与账号访问上下文，二者都在别的模块定义，本文件不复制字段。
// [权衡] accountAccess 统一写成静态类别与动态上下文的联合，避免每新增场景再加一个可选字段。
// [失败路径] 若在此新增实质逻辑，shared 会被迫依赖运行时实现，协议包反向依赖业务包。
export * from "./usage-quota.js";
import type { UsageMcpQuotaSnapshot, UsageQuotaSnapshot } from "./usage-quota.js";
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "./zcode-protocol/index.js";

// [契约] 常量名与快照字段同名同义：字符数经该除数换算为估算 token。
// [单位] totalCharacters 与 totalEstimatedTokens 成对存在，前者是原始字符，后者是估算值，UI 不得互换。
// [契约] 估算比例随快照下发，历史快照保留生成当时的除数，回放不会因常量变更而变形。
// [权衡] 用固定除数而非真实分词器，是为让本地聚合与远端聚合可比较，精度让位于一致性。
// [边界] 本文件只声明常量与字段，不做取整；四舍五入与截断由聚合实现承担。
// [失败路径] 消费端各自取整会在合计与分项间产生差额，占比相加不足百分之百。
export const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;

export type UsageStatsRange = "all" | "7d" | "30d";
export type CodingPlanUsageRange = "today" | "7d" | "30d" | "custom";
export type CodingPlanUsageGranularity = "hour" | "day";
export type CodingPlanUsageDetailMetric = "credits" | "usage";
export type CodingPlanUsageDetailSubject = "model" | "tool";

// [契约] 请求只描述意图，不携带账号凭证；鉴权由 accountAccess 在调用边界解析。
// [状态] dataSource 显式区分本地 session 聚合与 monitor 接口，缺省即歧义。
// [状态] preferredProviderId 仅在设置页或聊天输入区已选中时传入，未选则留空由实现回退。
// [契约] requirePreferredProvider 为真时不允许回退到其它 provider 或本地聚合。
// [契约] allowEnvApiKey 默认允许 host 环境变量覆盖，显式 provider 场景应显式关闭。
// [边界] timeZone 缺省时 host 回退系统时区，快照必须回写实际采用的时区。
export interface UsageStatsRequest {
  range: UsageStatsRange;
  /** 使用统计数据源。App Usage 显式使用本地 session 聚合,Coding Plan 显式使用 monitor 接口。 */
  dataSource?: "local" | "monitor";
  /** 设置页可传入用户当前选中的 Z.AI / BigModel 来源，避免两边都配置时只隐式读取第一家。 */
  preferredProviderId?: string;
  /** Registry 静态访问类别，或调用边界已解析的动态账号访问上下文。 */
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  /** 指定来源的场景必须命中 preferredProviderId,否则不允许回退到其它 provider 或本地聚合。 */
  requirePreferredProvider?: boolean;
  /** 是否允许 host 环境变量覆盖 provider key。默认允许,显式 provider 场景可关闭。 */
  allowEnvApiKey?: boolean;
  /**
   * 统计按调用端时区归桶。
   * UI 默认传入浏览器当前时区；缺省时 host 侧回退到系统时区。
   */
  timeZone?: string;
}

// [契约] 自定义区间只在 range 为 custom 时生效，日期按调用端自然日解释。
// [边界] 起止日期最大跨度 30 天，超出由调用方收敛，聚合侧不假设更长区间。
// [状态] preferredProviderId 与 accountAccess 在此为必填，Coding Plan 查询不接受缺省来源。
// [失败路径] 高速 TPS 请求少传 accountAccess 时，鉴权解析返回空，节省时间静默消失。
// [契约] 三个请求共用 accountAccess 的联合类型，Team scope 由上下文本体携带，不再单列 organizationId。
// [权衡] 保留 includeSubscription 仅为兼容旧调用方，权益判定已改为查询订阅。
export interface CodingPlanUsageRequest {
  range: CodingPlanUsageRange;
  /** 自定义日期范围。仅 range=custom 时生效，按调用端自然日解释，最大 30 天。 */
  customStartDate?: string | null;
  customEndDate?: string | null;
  preferredProviderId: string;
  /** Registry 静态访问类别，或本次 Team 查询绑定的动态账号访问上下文。 */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  timeZone?: string;
}

/** Highspeed 只读取普通 Pro/Max decode TPS，不触发完整 Coding Plan 用量聚合。 */
export interface CodingPlanRegularTpsRequest {
  preferredProviderId: string;
  /**
   * Registry 静态访问类别，或调用边界已解析的动态账号访问上下文。
   *
   * Bug 原因：此前该请求只带 organizationId/projectId，请求期鉴权靠 host 自行按 provider
   * 猜测账号。Provider 重构后 Coding Plan 授权统一由 accountAccess 解析（Team scope 也内含
   * 其中），缺失时 resolveAuthorization 必定返回 null，节省时间会静默不展示。
   */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  timeZone?: string;
}

export interface UsageEntitlementRequest {
  /** 购买或领取完成后，使对应 Start Plan balance 短期缓存失效。 */
  invalidateBalanceCache?: boolean;
  /** 兼容旧调用方的提示；Coding Plan 权益必须查询订阅并返回摘要，不再允许仅用额度推断权益。 */
  includeSubscription?: boolean;
  /** 聊天输入区可传入当前选中的内置供应商,确保 BigModel/Z.AI 用量跟随模型选择。 */
  preferredProviderId?: string;
  /** 指定 Account Provider 的静态访问类别，或调用边界已解析的动态账号访问上下文。 */
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  /** 当前模型已明确选中该内置供应商时，即使供应商列表里被隐藏也允许读取其 key。 */
  allowDisabledPreferredProvider?: boolean;
  /** 指定来源的场景必须命中 preferredProviderId,否则不允许回退到其它 provider。 */
  requirePreferredProvider?: boolean;
  /** 是否允许 host 环境变量覆盖 provider key。默认允许,显式 provider 场景可关闭。 */
  allowEnvApiKey?: boolean;
}

// [状态] generatedAt 是本地快照生成时刻，serverTime 是额度响应的服务端时刻，二者不可合并。
// [状态] unavailableReason 覆盖未登录、未配置、无 Plan、不可用四种终态，UI 据此选文案。
// [契约] startPlanExpired 与 teamPlanUnavailableReason 是补充原因，后者仅在 no_plan 时出现。
// [契约] context 标记本次查询的个人或团队归属，供设置页判定连接方式。
// [边界] provider、remaining、subscription、quota 均可为 null，表示该项无数据而非查询失败。
// [契约] mcpQuota 可选可空，沿用 entitlement 的缓存、进行中请求合并与 TTL，失败不影响主快照。
// [权衡] MCP 额度与 quota 同批下发是为复用缓存策略，不代表两者口径合并。
export interface UsageEntitlementSnapshot {
  generatedAt: number;
  /** 当前额度响应的服务端时间（毫秒）；与本地快照生成时间 generatedAt 分离。 */
  serverTime?: number;
  authenticated: boolean;
  unavailableReason?: "not_authenticated" | "not_configured" | "no_plan" | "unavailable";
  /** 无可用 Start Plan 时，保留明确过期原因用于展示。 */
  startPlanExpired?: boolean;
  /** 团队订阅明确失效的原因，仅与 no_plan 一起返回。 */
  teamPlanUnavailableReason?: "expired" | "unassigned";
  /** 当前 entitlement 查询对应的个人 / 团队上下文，用于设置页连接方式主判定。 */
  context?: UsageEntitlementContext | null;
  /** 当前用于查询 quota 的模型供应商信息。 */
  provider: UsageEntitlementProviderInfo | null;
  remaining: UsageEntitlementRemaining | null;
  subscription: UsageEntitlementSubscription | null;
  quota: UsageQuotaSnapshot | null;
  /**
   * ZCode 官方 Server MCP 的调用额度（`/api/v1/mcp/usage`）。
   * 与 quota 同一份快照下发，是为了继承 entitlement 已有的缓存 / in-flight 合并 / TTL 策略；
   * 拉取失败、未开通 Coding Plan、或该额度不属于本次查询的连接时一律为 null（可选数据面）。
   */
  mcpQuota?: UsageMcpQuotaSnapshot | null;
}

export interface UsageEntitlementContext {
  scope: "personal" | "team";
  organizationId?: string | null;
  projectId?: string | null;
  displayName?: string | null;
  productId?: string | null;
}

export type PlanIdentityStatus = "coding_plan" | "start_plan" | "no_plan" | "unknown";

export interface PlanIdentitySnapshot {
  generatedAt: number;
  planStatus: PlanIdentityStatus;
  planProductId: string;
}

export interface UsageEntitlementRemaining {
  count: number;
  isShow: boolean;
  percentage?: number;
  nextResetTime?: number | null;
}

export interface UsageEntitlementProviderInfo {
  id: string;
  name: string;
}

export interface UsageEntitlementSubscription {
  identityType: "email" | "phoneNumber" | "unknown";
  identityMasked: string | null;
  details: UsageEntitlementSubscriptionDetail[];
}

export interface UsageEntitlementSubscriptionDetail {
  productId: string;
  productName: string;
  purchaseTime: string | null;
  beginTime: string | null;
  billingCycle?: string | null;
  renewTime?: string | null;
  expireTime: string | null;
  /** Start Plan balance 套餐下的权益生效时间；其他订阅类型可不提供。 */
  entitlements?: Array<{
    entitlementId: string;
    /** 服务端 entitlement show_name，用于待生效提示。 */
    showName?: string | null;
    effectiveTime: string | null;
  }>;
}

// [契约] 快照是纯数据视图，不持有定时器或订阅，刷新由上层调用触发。
// [状态] range、timeZone、estimatedTokenCharDivisor 随快照固定，保证同一份数据可重复渲染。
// [顺序] daily 已按日期连续补齐，空白日补零，趋势图直接按下标取值。
// [契约] heatmap 的补位单元为 null，与真实零活动格子区分。
// [契约] models 按模型聚合字符与估算 token，share 为占比，模型未知时 modelId 为 null。
// [状态] source 区分 bigmodel-monitor 与 local，sourceProvider 提供展示名，二者不可互相推断。
// [边界] tools 仅远端 tool-usage 接口填充，本地聚合留空，UI 需容忍缺失。
export interface UsageStatsSnapshot {
  range: UsageStatsRange;
  generatedAt: number;
  timeZone: string;
  estimatedTokenCharDivisor: number;
  summary: UsageStatsSummary;
  /** 按日期连续补齐后的日序列，空白日期会补 0，供趋势图直接使用。 */
  daily: UsageStatsDaySummary[];
  heatmap: UsageStatsHeatmap;
  models: UsageStatsModelUsage[];
  /**
   * 数据来源标识：用于 UI 识别供应商 monitor 接口或本地 session 聚合数据。
   * App Usage 显式读取本地 session 聚合；Coding Plan 显式读取当前 provider monitor。
   */
  source?: "bigmodel-monitor" | "local";
  /** 远端用量来源供应商，用于 UI 展示 BigModel / Z.AI 等来源。 */
  sourceProvider?: UsageEntitlementProviderInfo | null;
  /** 工具调用维度（仅 BigModel tool-usage 接口可用，本地聚合不填）。 */
  tools?: UsageStatsToolUsage[];
}

// ── App Usage（agent 数据库真实统计）────────────────────────────────
// [契约] APP_USAGE_RANGES 是唯一来源，同时驱动运行时枚举与类型，新增档位只改这一处。
// [契约] appUsageSnapshotSchema 的 source 固定为 agent-db，用来与 monitor 来源彻底区分。
// [契约] AppUsage 系列字段全部必填，可空只用在确实可能无值的模型标识与均值上。
// [边界] 热力图 level 限定 0 到 4 的字面量联合，越界值在校验期被拒。
// [契约] days 数组元素可空，用于月初月末补位，按周索引排列。
// [权衡] 类型一律由 zod 推断，避免 schema 与手写 interface 双维护。
export const APP_USAGE_RANGES = ["all", "7d", "30d"] as const;
export type AppUsageRange = (typeof APP_USAGE_RANGES)[number];

export const appUsageFavoriteModelSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  share: z.number(),
});

export const appUsageSummarySchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheHitRate: z.number(),
  totalSessions: z.number(),
  totalTurns: z.number(),
  toolCallCount: z.number(),
  toolErrorRate: z.number(),
  modelErrorRate: z.number(),
  avgTimeToFirstTokenMs: z.number().nullable(),
  avgTurnDurationMs: z.number().nullable(),
  activeDays: z.number(),
  currentStreakDays: z.number(),
  longestSessionMs: z.number(),
  longestStreakDays: z.number(),
  peakDayTokens: z.number(),
  favoriteModel: appUsageFavoriteModelSchema.nullable(),
});

export const appUsageHeatmapCellSchema = z.object({
  date: z.string(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  totalTokens: z.number(),
  turnCount: z.number(),
  toolCallCount: z.number(),
});

export const appUsageHeatmapWeekSchema = z.object({
  weekIndex: z.number(),
  days: z.array(appUsageHeatmapCellSchema.nullable()),
});

export const appUsageHeatmapSchema = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  maxTokens: z.number(),
  weeks: z.array(appUsageHeatmapWeekSchema),
});

export const appUsageDailyModelItemSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
});

export const appUsageDailyModelUsageSchema = z.object({
  date: z.string(),
  models: z.array(appUsageDailyModelItemSchema),
});

export const appUsageModelUsageSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  requestCount: z.number(),
  share: z.number(),
});

export const appUsageToolUsageSchema = z.object({
  toolName: z.string(),
  callCount: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
  avgDurationMs: z.number().nullable(),
});

export const appUsageSnapshotSchema = z.object({
  range: z.enum(APP_USAGE_RANGES),
  generatedAt: z.number(),
  timeZone: z.string(),
  source: z.literal("agent-db"),
  summary: appUsageSummarySchema,
  heatmap: appUsageHeatmapSchema,
  dailyModelUsage: z.array(appUsageDailyModelUsageSchema),
  models: z.array(appUsageModelUsageSchema),
  tools: z.array(appUsageToolUsageSchema),
});

export type AppUsageSummary = z.infer<typeof appUsageSummarySchema>;
export type AppUsageHeatmapCell = z.infer<typeof appUsageHeatmapCellSchema>;
export type AppUsageHeatmapWeek = z.infer<typeof appUsageHeatmapWeekSchema>;
export type AppUsageHeatmap = z.infer<typeof appUsageHeatmapSchema>;
export type AppUsageDailyModelItem = z.infer<typeof appUsageDailyModelItemSchema>;
export type AppUsageDailyModelUsage = z.infer<typeof appUsageDailyModelUsageSchema>;
export type AppUsageModelUsage = z.infer<typeof appUsageModelUsageSchema>;
export type AppUsageToolUsage = z.infer<typeof appUsageToolUsageSchema>;
export type AppUsageFavoriteModel = z.infer<typeof appUsageFavoriteModelSchema>;
export type AppUsageSnapshot = z.infer<typeof appUsageSnapshotSchema>;

export interface AppUsageRequest {
  range: AppUsageRange;
  timeZone?: string;
}

export interface CodingPlanUsageSnapshot {
  range: CodingPlanUsageRange;
  rangeStartDate: string;
  rangeEndDate: string;
  generatedAt: number;
  sourceProvider: UsageEntitlementProviderInfo;
  quota: UsageQuotaSnapshot | null;
  activity: CodingPlanActivitySnapshot;
  detail: CodingPlanUsageDetailSnapshot;
  modelUsage: CodingPlanModelUsageSnapshot;
  toolUsage: CodingPlanToolUsageSnapshot;
  health: CodingPlanHealthSnapshot;
}

export interface CodingPlanActivitySnapshot {
  summary: CodingPlanActivitySummary;
  heatmap: AppUsageHeatmap;
}

export interface CodingPlanActivitySummary {
  totalTokens: number;
  peakDailyTokens: number;
  peakDailyTokensDate: string | null;
  totalUsageDurationMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  favoriteModelName: string | null;
}

export interface CodingPlanUsageDetailSnapshot {
  model: CodingPlanUsageDetailSummary;
  tool: CodingPlanUsageDetailSummary;
}

export interface CodingPlanUsageDetailSummary {
  cacheHitRate: number | null;
  cacheHitRateTrend: number | null;
  totalCredits: number;
  totalCreditsTrend: number | null;
  averageDailyCredits: number;
  averageDailyCreditsTrend: number | null;
}

export interface CodingPlanModelUsageSnapshot {
  xTime: string[];
  granularity: CodingPlanUsageGranularity;
  totalModelCallCount: number;
  totalTokensUsage: number;
  modelDataList: CodingPlanModelData[];
  modelSummaryList: CodingPlanModelSummary[];
}

export interface CodingPlanModelData {
  modelName: string;
  sortOrder: number;
  tokensUsage: number[];
  creditsUsage?: number[];
  cachedInputTokensUsage?: number[];
  uncachedInputTokensUsage?: number[];
  outputTokensUsage?: number[];
  cachedInputCreditsUsage?: number[];
  uncachedInputCreditsUsage?: number[];
  outputCreditsUsage?: number[];
  totalTokens: number;
  totalCredits?: number;
}

export interface CodingPlanModelSummary {
  modelName: string;
  totalTokens: number;
  totalCredits?: number;
  sortOrder: number;
}

export interface CodingPlanToolUsageSnapshot {
  xTime: string[];
  granularity: CodingPlanUsageGranularity;
  toolDataList: CodingPlanToolData[];
  toolSummaryList: CodingPlanToolSummary[];
}

export interface CodingPlanToolData {
  toolCode: string;
  toolName: string;
  sortOrder: number;
  usageCount: number[];
  creditsUsage?: number[];
  totalUsageCount: number;
  totalCredits?: number;
}

export interface CodingPlanToolSummary {
  toolCode: string;
  toolName: string;
  totalUsageCount: number;
  totalCredits?: number;
  sortOrder: number;
}

export interface CodingPlanHealthSnapshot {
  xTime: string[];
  proMaxDecodeSpeed: number[];
  liteDecodeSpeed: number[];
}

export interface UsageStatsToolUsage {
  /** 工具内部代号：search-prime / web-reader / zread / search-mcp 等。 */
  toolCode: string;
  /** 用于展示的人类可读名称。 */
  displayName: string;
  totalCalls: number;
  /** 与 daily 同长度的按天调用次数，便于绘制趋势。 */
  dailyCalls: number[];
}

export interface UsageStatsSummary {
  totalSessions: number;
  totalMessages: number;
  totalCharacters: number;
  totalEstimatedTokens: number;
  activeDays: number;
  mostActiveDay: UsageStatsDaySummary | null;
  favoriteModel: UsageStatsFavoriteModel | null;
  longestSessionMs: number;
  longestStreakDays: number;
  currentStreakDays: number;
  firstActivityDate: string | null;
  lastActivityDate: string | null;
  peakHour: UsageStatsPeakHour | null;
}

export interface UsageStatsPeakHour {
  hour: number;
  totalEstimatedTokens: number;
  messageCount: number;
}

export interface UsageStatsFavoriteModel {
  modelId: string | null;
  totalCharacters: number;
  totalEstimatedTokens: number;
  share: number;
}

export interface UsageStatsDaySummary {
  date: string;
  label: string;
  totalCharacters: number;
  totalEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  activityScore: number;
}

export interface UsageStatsHeatmap {
  startDate: string | null;
  endDate: string | null;
  maxActivityScore: number;
  weeks: UsageStatsHeatmapWeek[];
  monthLabels: UsageStatsHeatmapMonthLabel[];
}

export interface UsageStatsHeatmapWeek {
  weekIndex: number;
  days: Array<UsageStatsHeatmapCell | null>;
}

export interface UsageStatsHeatmapMonthLabel {
  weekIndex: number;
  date: string;
}

export interface UsageStatsHeatmapCell {
  date: string;
  level: 0 | 1 | 2 | 3 | 4;
  totalCharacters: number;
  totalEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  activityScore: number;
}

export interface UsageStatsModelUsage {
  modelId: string | null;
  totalCharacters: number;
  totalEstimatedTokens: number;
  inputCharacters: number;
  inputEstimatedTokens: number;
  outputCharacters: number;
  outputEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  share: number;
}
