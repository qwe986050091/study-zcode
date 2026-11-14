/* eslint-disable max-lines -- legacy monitor 与新版 credit-usage mapper 共享对齐/格式化逻辑，后续单独拆文件。 */
// ============================================================================
// BigModel monitor → ZCode 内部用量快照的纯映射层（无 IO、无状态）。
//
// INV-01：所有出口数值必须是有限数（守住：toFiniteNumber / normalizeNumberSeries）。
//   让 NaN/Infinity 流到 UI 会渲染成空图或 NaN%，且比较函数会把排序打乱。
// INV-02：monitor 返回的是“估算 token”，字符数必须乘 ESTIMATED_TOKEN_CHAR_DIVISOR
//   （守住：buildUsageStatsSnapshotFromMonitor 的 totalCharacters）。漏乘会让字符数
//   与旧的本地统计口径不一致，同比图表出现 3~4 倍跳变。
// INV-03：缺失字段与 0 必须区分（守住：totalUsage 分支与 pickFirstNonEmptySeries）。
//   缺失表示“上游没给”，应回退到 series 求和；0 表示“确实是 0”，直接采用。
// INV-04：modelDataList 与 mcpDataList 的下标必须与返回的 xTime 一一对应
//   （守住：alignUsageSeries）。错位会把 A 天的用量画到 B 天，且不会抛错。
// INV-05：拆分桶（缓存/未缓存/输出）不是模型（守住：isCreditUsageBreakdownBucket、
//   sumCreditModelTokens）。把它们当模型会让总用量翻倍并出现三个假图例。
// INV-06：时间轴归一化只改变格式、不改变顺序（守住：normalizeCodingPlanAxisValue）。
//   上游 'YYYY-MM-DD HH:mm:ss' 与本地轴可能不同，格式不统一会导致整条曲线归零。
// INV-07：上游字段改名（x_time/xTime、tokensUsage/totalTokensUsage、
//   mcpDataList/modelDataList）只在本文件收口；跨文件复制字段名是主要故障源。
//
// 本文件不做鉴权、不做重试、不记日志：失败语义由 provider 决定，映射只保证“坏数据不崩”。
// ============================================================================
import type {
  UsageStatsDaySummary,
  UsageStatsModelUsage,
  UsageStatsRequest,
  UsageStatsSnapshot,
  UsageStatsToolUsage,
  CodingPlanUsageGranularity,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  UsageQuotaSnapshot,
  UsageEntitlementProviderInfo,
  CodingPlanModelData,
  CodingPlanModelSummary,
  CodingPlanToolData,
  CodingPlanToolSummary,
  AppUsageHeatmap,
  AppUsageHeatmapCell,
  AppUsageHeatmapWeek,
} from "@zcode/shared";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";

// ============================================================================
// 把 BigModel monitor 接口数据(model-usage / tool-usage)转成 ZCode 内部统一
// 的 UsageStatsSnapshot 结构。
//
// monitor 接口直接返回估算 token 数,反推字符数以保持现有 UI 字段语义。
// ============================================================================

export interface BigModelUsageModelSummaryPayload {
  modelName?: string;
  totalTokens?: number;
  sortOrder?: number;
}

// modelDataList 的元素：名字 + 一条与 x_time 等长的 tokensUsage。
// 数组长度可能短于 x_time，mapper 以目标轴下标取值并补 0，不会越界。
// totalTokens 是整段合计，缺失时由序列求和兜底。
export interface BigModelUsageModelDataPayload {
  modelName?: string;
  totalTokens?: number;
  tokensUsage?: number[];
  sortOrder?: number;
}

// legacy monitor 的 model-usage 响应。三个数组共享 x_time 下标，长度可能不一致；
// 因此 mapper 一律以 xTime 为主轴取值并补 0，而不是假设长度相同直接 zip。
// totalUsage 是后端聚合值，modelSummaryList 是顶层兜底副本，二者都可能缺失。
// [权衡] 字段全部可选：上游在不同套餐下会省略部分 section，必填会让整包解析失败。
export interface BigModelUsageModelUsagePayload {
  x_time?: string[];
  granularity?: string;
  modelCallCount?: number[];
  tokensUsage?: number[];
  totalUsage?: {
    totalModelCallCount?: number;
    totalTokensUsage?: number;
    modelSummaryList?: BigModelUsageModelSummaryPayload[];
  };
  modelDataList?: BigModelUsageModelDataPayload[];
  modelSummaryList?: BigModelUsageModelSummaryPayload[];
}

// tool-usage 的按天数组分别对应三种内置 MCP，加上 totalUsage 的四个合计；
// search-mcp 没有按天序列，只有合计，所以不在日常数组里（见 buildToolUsages）。
// 团队项目无工具调用时后端可能整体省略 data，provider 侧已用 allowMissingData 处理。
export interface BigModelUsageToolUsagePayload {
  x_time?: string[];
  granularity?: string;
  networkSearchCount?: number[];
  webReadMcpCount?: number[];
  zreadMcpCount?: number[];
  totalUsage?: {
    totalNetworkSearchCount?: number;
    totalWebReadMcpCount?: number;
    totalZreadMcpCount?: number;
    totalSearchMcpCount?: number;
    toolSummaryList?: BigModelUsageToolSummaryPayload[];
  };
  toolDataList?: BigModelUsageToolDataPayload[];
  toolSummaryList?: BigModelUsageToolSummaryPayload[];
}

export interface BigModelCreditUsageMetricPayload {
  value?: number | string | null;
  trend?: number | string | null;
}

export interface BigModelCreditUsageActivitySummaryPayload {
  totalTokens?: number;
  peakDailyTokens?: number;
  peakDailyTokensDate?: string;
  totalUsageDurationMs?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
}

export interface BigModelCreditUsageActivitySeriesPayload {
  date?: string;
  totalTokens?: number;
  modelCallCount?: number;
  mcpCalls?: number;
}

// credit-usage/activity：summary 是区间汇总，series 是按天明细。
// summary 允许为 null（新账号无数据），series 允许缺失，两者都要能降级为空结构。
export interface BigModelCreditUsageActivityPayload {
  summary?: BigModelCreditUsageActivitySummaryPayload | null;
  series?: BigModelCreditUsageActivitySeriesPayload[];
}

// 这里是字段改名陷阱最密集的地方，逐组说明：
// totalTokens 是标量合计，totalTokensUsage/tokensUsage 才是按时间轴序列；
// 标量与序列混用会让图表只画出一个点或总计为 NaN。
// cachedInput/uncachedInput/output 三组分别有 tokens 与 credits 两套序列，
// 单位不同（token vs 积分），任意一组错配都会让费用与用量互相矛盾。
// [权衡] 全部字段可选并逐个兜底，而不是用 zod 强校验：monitor 字段演进频繁，
// 严格校验会让后端加字段变成客户端故障。
export interface BigModelCreditUsageModelDataPayload {
  modelCode?: string;
  modelName?: string;
  sortOrder?: number;
  totalTokens?: number;
  totalCredits?: number;
  totalCreditsUsage?: BigModelUsageNumberSeries;
  cachedInputCreditsUsage?: BigModelUsageNumberSeries;
  uncachedInputCreditsUsage?: BigModelUsageNumberSeries;
  outputCreditsUsage?: BigModelUsageNumberSeries;
  tokensUsage?: BigModelUsageNumberSeries;
  totalTokensUsage?: BigModelUsageNumberSeries;
  cachedInputTokensUsage?: BigModelUsageNumberSeries;
  uncachedInputTokensUsage?: BigModelUsageNumberSeries;
  outputTokensUsage?: BigModelUsageNumberSeries;
}

// MCP 行同时可能有 mcpCode/mcpName 与 toolCode/toolName 两套标识：
// 前者是服务维度，后者是工具维度；mapper 优先取 mcp 维度，缺失才回退 tool。
// creditsUsage 与 usageCount/mcpCallCount 是不同量纲，不能互相兜底。
export interface BigModelCreditUsageMcpDataPayload {
  mcpCode?: string;
  mcpName?: string;
  toolCode?: string;
  toolName?: string;
  sortOrder?: number;
  totalCredits?: number;
  totalUsageCount?: number;
  creditsUsage?: BigModelUsageNumberSeries;
  mcpCallCount?: BigModelUsageNumberSeries;
  usageCount?: BigModelUsageNumberSeries;
}

type BigModelUsageNumberSeries = Array<number | string | null | undefined>;
// 这些 code 是计费拆分桶，不是模型行。同时收录 snake_case 与 camelCase，
// 因为两个后端版本对同一概念使用了不同命名。
// 维护约束：新增桶必须同时在此登记，否则总用量会被算成约 2 倍（见 sumCreditModelTokens）。
const CREDIT_USAGE_BREAKDOWN_BUCKET_CODES = new Set([
  "cached_input",
  "cachedInput",
  "cache_input",
  "cacheInput",
  "uncached_input",
  "uncachedInput",
  "output",
  "output_tokens",
  "outputTokens",
]);

// usage-detail 一次返回两类维度：modelUsage 与 mcpUsage，各自带独立的 xTime。
// 注意内层是 camelCase（xTime/modelDataList），与 legacy monitor 的 snake_case 不同。
// summary 的数值字段是 {value, trend} 包装，trend 可能为负，不能取绝对值。
export interface BigModelCreditUsageDetailPayload {
  summary?: {
    cacheHitRate?: BigModelCreditUsageMetricPayload;
    totalCredits?: BigModelCreditUsageMetricPayload;
    averageDailyCredits?: BigModelCreditUsageMetricPayload;
  } | null;
  modelUsage?: {
    xTime?: string[];
    periodTypes?: string[];
    modelDataList?: BigModelCreditUsageModelDataPayload[];
  } | null;
  mcpUsage?: {
    xTime?: string[];
    periodTypes?: string[];
    mcpDataList?: BigModelCreditUsageMcpDataPayload[];
  } | null;
}

// 性能接口同时存在 x_time（snake）与 xTime（camel）两种时间轴字段，
// 这是后端灰度期间的产物；读取顺序固定为 x_time → xTime，不能只认一个。
export interface BigModelUsageModelPerformancePayload {
  x_time?: string[];
  xTime?: string[];
  proMaxDecodeSpeed?: number[];
  liteDecodeSpeed?: number[];
}

// 工具明细行：usageCount 与 x_time 等长，totalUsageCount 是合计；
// 二者都应独立回退，不能用合计反推序列（会丢掉每日分布）。
export interface BigModelUsageToolDataPayload {
  toolCode?: string;
  toolName?: string;
  sortOrder?: number;
  usageCount?: number[];
  totalUsageCount?: number;
}

export interface BigModelUsageToolSummaryPayload {
  toolCode?: string;
  toolName?: string;
  totalUsageCount?: number;
  sortOrder?: number;
}

// 信封字段全部可选：成功判据由 provider 的 isSuccessfulBigModelEnvelope 统一裁决，
// 在这里用必填字段表达只会把“业务错误”变成“类型错误”。
export interface BigModelUsageModelUsageEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelUsageModelUsagePayload | null;
}

export interface BigModelUsageToolUsageEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelUsageToolUsagePayload | null;
}

export interface BigModelCreditUsageActivityEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelCreditUsageActivityPayload | null;
}

export interface BigModelCreditUsageDetailEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelCreditUsageDetailPayload | null;
}

export interface BigModelUsageModelPerformanceEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelUsageModelPerformancePayload | null;
}

// legacy 设置页统计：把 model/tool 两份 payload 合成为 UsageStatsSnapshot。
// 纯函数保证同一输入永远得到同一快照（除 generatedAt），便于单测与缓存比对。
// [权衡] totalSessions/totalMessages 都直接复用“调用次数”：monitor 不提供会话数，
// 伪造一个估算值会让“平均每会话消息数”出现无意义的小数。
export function buildUsageStatsSnapshotFromMonitor(
  request: UsageStatsRequest,
  modelData: BigModelUsageModelUsagePayload,
  toolData: BigModelUsageToolUsagePayload,
): UsageStatsSnapshot {
// xTime 是整张图的主轴：后续所有按天数组都以它的下标记为对齐依据。
// 缺失时退化为空数组，让 daily 为空而不是抛错（monitor 可能只给 totalUsage）。
  const xTime = modelData.x_time ?? [];
  const tokensUsage = modelData.tokensUsage ?? [];
  const modelCallCount = modelData.modelCallCount ?? [];

// 逐日条目以 xTime 为基准生成，缺失的 tokens/message 补 0：
// 上游数组短于时间轴时，缺的那天应显示 0 而不是整段被跳过。
// sessionCount 用“当天是否有调用”表示 0/1，因为 monitor 没有真实会话数。
  const daily: UsageStatsDaySummary[] = xTime.map((date, index) => {
// 这里是 INV-02 的落地：token 是估算值，字符数必须按固定除数换算，
// 且除数来自 shared 常量，保证与本地统计、UI 提示文案使用同一口径。
    const totalEstimatedTokens = tokensUsage[index] ?? 0;
// 按 index 取值而不是 find：modelCallCount 与 xTime 共享下标语义（INV-04），
// 越界时补 0，保证 daily 与 xTime 长度严格一致。
    const messageCount = modelCallCount[index] ?? 0;
    return {
      date,
      label: date,
      totalCharacters: totalEstimatedTokens * ESTIMATED_TOKEN_CHAR_DIVISOR,
      totalEstimatedTokens,
// 用 0/1 表达“当天是否活跃”，而不是把调用次数当会话数：
// 会话数在后端不可得，写错会让“平均每会话消息数”出现小于 1 的结果。
      sessionCount: messageCount > 0 ? 1 : 0,
      messageCount,
      activityScore: totalEstimatedTokens,
    };
  });

// 汇总值优先用后端 totalUsage，而不是对 daily 求和：
// daily 可能被截断（窗口外），求和会小于后端真实总量，导致占比之和不等于 1。
// 缺省 0 是安全的：totalTokens 只作为 share 的分母，为 0 时 share 统一给 0。
  const totalTokens = modelData.totalUsage?.totalTokensUsage ?? 0;
  const totalCalls = modelData.totalUsage?.totalModelCallCount ?? 0;
  const activeDayCount = daily.filter((day) => day.totalEstimatedTokens > 0).length;
// 峰值日取自 daily；严格大于才替换，保证并列时保留最早的一天（输出稳定）。
// 空集合返回 null，UI 据此隐藏“最活跃日”而不是显示 1970-01-01。
  const mostActiveDay =
    daily.reduce<UsageStatsDaySummary | null>((best, day) => {
      if (!best || day.totalEstimatedTokens > best.totalEstimatedTokens) {
        return day;
      }
      return best;
    }, null) ?? null;
// 首末活跃日以 totalEstimatedTokens > 0 为准，而不是数组首尾：
// 窗口左右常有补 0 的空日，用数组首尾会把统计区间拉宽。
  const firstActiveDay = daily.find((day) => day.totalEstimatedTokens > 0) ?? null;
  const lastActiveDay = [...daily].reverse().find((day) => day.totalEstimatedTokens > 0) ?? null;

// 模型汇总有两份来源，优先 totalUsage 内嵌版本（与总量同源），
// 缺失时才回退顶层副本；两者择一可避免同一模型出现两次。
  const summaryList = modelData.totalUsage?.modelSummaryList ?? modelData.modelSummaryList ?? [];
// 过滤掉没有 modelName 的行：这些行无法作为图例，保留会产生空标签。
// input/output 维度 monitor 不提供，固定 0；调用方必须据此判断“输入输出不可用”，
// 不能把 0 当成真实的零输入。
// share 以后端总量为分母，保证各模型占比之和≈1（而非按样本重算）。
  const models: UsageStatsModelUsage[] = summaryList
    .filter((entry): entry is BigModelUsageModelSummaryPayload => Boolean(entry?.modelName))
    .map((entry) => {
      const totalEstimatedTokens = entry.totalTokens ?? 0;
      return {
        modelId: entry.modelName ?? null,
        totalCharacters: totalEstimatedTokens * ESTIMATED_TOKEN_CHAR_DIVISOR,
        totalEstimatedTokens,
        inputCharacters: 0,
        inputEstimatedTokens: 0,
        outputCharacters: 0,
        outputEstimatedTokens: 0,
        sessionCount: 0,
        messageCount: 0,
// 分母为 0 时给 0 而不是 NaN/Infinity（INV-01）；
// 这里用后端总量而非样本求和，保证占比之和≈1。
        share: totalTokens > 0 ? totalEstimatedTokens / totalTokens : 0,
      };
    })
// 显式按 token 降序再切首个元素作为 favoriteModel：
// 依赖后端顺序会让“最常用模型”随上游改动漂移。
    .sort((left, right) => right.totalEstimatedTokens - left.totalEstimatedTokens);

// models 已按 token 降序，首位即最常用模型；直接取而不是再 reduce 一次。
  const favoriteModel = models[0]
    ? {
        modelId: models[0].modelId,
        totalCharacters: models[0].totalCharacters,
        totalEstimatedTokens: models[0].totalEstimatedTokens,
        share: models[0].share,
      }
    : null;

  return {
    range: request.range,
    generatedAt: Date.now(),
    timeZone: request.timeZone ?? "UTC",
    estimatedTokenCharDivisor: ESTIMATED_TOKEN_CHAR_DIVISOR,
    summary: {
      totalSessions: totalCalls,
      totalCharacters: totalTokens * ESTIMATED_TOKEN_CHAR_DIVISOR,
      totalEstimatedTokens: totalTokens,
      totalMessages: totalCalls,
      activeDays: activeDayCount,
      mostActiveDay,
      favoriteModel,
      longestSessionMs: 0,
      longestStreakDays: 0,
      currentStreakDays: 0,
      firstActivityDate: firstActiveDay?.date ?? null,
      lastActivityDate: lastActiveDay?.date ?? null,
      peakHour: null,
    },
    daily,
    // 热力图已从设置页移除;保留空结构以满足类型,避免下游消费方报错。
// [契约] heatmap 结构仅为类型兼容而保留：设置页已不再渲染热力图，字段值恒为空。
// weeks 恒为空数组，不要据此推断“没有活动”。
// startDate/endDate 仍按真实活跃区间给值，供其他消费方使用。
    heatmap: {
      startDate: firstActiveDay?.date ?? null,
      endDate: lastActiveDay?.date ?? null,
      maxActivityScore: daily.reduce(
        (max, day) => (day.activityScore > max ? day.activityScore : max),
        0,
      ),
      weeks: [],
      monthLabels: [],
    },
    models,
// source 是快照来源的唯一标识，UI 据此区分“云端统计”与“本地聚合”，
// 改这个字符串会让历史快照无法被识别为同源数据。
    source: "bigmodel-monitor",
    tools: buildToolUsages(toolData),
  };
}

// Coding Plan 用量总装配：detail(credit-usage) 优先，缺失时回退 legacy monitor。
// 两套数据源的字段名与单位都不同，必须在这里统一选择，调用方不应感知差异。
// [权衡] 选择以“整块 detail 是否存在”为单位，而不是逐字段回退：
// 混用两源会让同一张图里的曲线来自不同统计口径。
export function buildCodingPlanUsageSnapshotFromMonitor(params: {
  request: CodingPlanUsageRequest;
  provider: UsageEntitlementProviderInfo;
  quota: UsageQuotaSnapshot | null;
  granularity: CodingPlanUsageGranularity;
  xTime: string[];
  activityData?: BigModelCreditUsageActivityPayload;
  modelDetailData?: BigModelCreditUsageDetailPayload;
  toolDetailData?: BigModelCreditUsageDetailPayload;
  healthData?: BigModelUsageModelPerformancePayload;
  startDateKey: string;
  endDateKey: string;
  modelData?: BigModelUsageModelUsagePayload;
  toolData?: BigModelUsageToolUsagePayload;
}): CodingPlanUsageSnapshot {
// 用 null 判定“detail 是否可用”，而不是用空数组：
// 空数组是合法的“有数据源但没有行”，此时不应回退 legacy。
// toolUsage 取自 mcpUsage，命名不同是后端契约，不是笔误。
  const modelUsage = params.modelDetailData?.modelUsage ?? null;
  const toolUsage = params.toolDetailData?.mcpUsage ?? null;
// 三个列表（模型汇总/模型明细/工具明细）各自独立选择数据源，
// 但都遵循“detail 存在就用 detail”的一致规则，避免同一张图混用两套口径。
  const modelSummaryList = modelUsage
    ? normalizeCreditModelSummaryList(modelUsage)
    : normalizeModelSummaryList(params.modelData ?? {});
  const toolSummaryList = toolUsage
    ? normalizeCreditToolSummaryList(toolUsage)
    : normalizeToolSummaryList(params.toolData ?? {});
  const modelDataList = modelUsage
    ? normalizeCreditModelDataList(modelUsage, params.xTime, params.granularity)
    : normalizeModelDataList(params.modelData ?? {}, params.xTime, params.granularity);
  const toolDataList = toolUsage
    ? normalizeCreditToolDataList(toolUsage, params.xTime, params.granularity)
    : normalizeToolDataList(params.toolData ?? {}, params.xTime, params.granularity);
// 总量同样跟随数据源：detail 用桶排除后的求和，legacy 用后端给定的 total。
// 两者不能相加，否则 detail 与 legacy 同时存在时总量会翻倍。
// [权衡] detail 的求和会多做一次遍历，但能保证与列表数字自洽。
  const totalTokensUsage = modelUsage
    ? sumCreditModelTokens(modelUsage)
    : (params.modelData?.totalUsage?.totalTokensUsage ?? 0);
// activity 与 detail 独立降级：前者来自 activity 接口，缺失只影响热力图区域。
  const activity = buildCodingPlanActivitySnapshot(params.activityData);
  return {
    range: params.request.range,
// 区间键来自 provider 计算好的时间窗，mapper 不重新推导，
// 保证标题区间与后端实际查询窗口一致。
    rangeStartDate: params.startDateKey,
    rangeEndDate: params.endDateKey,
    generatedAt: Date.now(),
    sourceProvider: params.provider,
    quota: params.quota,
    activity: {
      ...activity,
      summary: { ...activity.summary, favoriteModelName: modelSummaryList[0]?.modelName ?? null },
    },
    detail: buildCodingPlanUsageDetailSnapshot(params.modelDetailData, params.toolDetailData),
    modelUsage: {
      xTime: params.xTime,
      granularity: params.granularity,
// 调用次数在 detail 下没有独立字段，只能用 modelDataList 的行数；
// legacy 下取后端 totalUsage 的真实值。两者语义不同，不能互相推断。
      totalModelCallCount:
        modelUsage?.modelDataList?.length ?? params.modelData?.totalUsage?.totalModelCallCount ?? 0,
      totalTokensUsage,
      modelDataList,
      modelSummaryList,
    },
    toolUsage: {
      xTime: params.xTime,
      granularity: params.granularity,
      toolDataList,
      toolSummaryList,
    },
    health: buildCodingPlanHealthSnapshot(params.healthData),
  };
}

// activity 汇总的每个数值都走 toFiniteNumber + 默认 0：
// 新账号/空区间时字段缺失是常态，用 0 表达“本期没有用量”是准确的。
// peakDailyTokensDate 用 trim 后判空，全空格视为 null。
function buildCodingPlanActivitySnapshot(
  payload: BigModelCreditUsageActivityPayload | undefined,
): CodingPlanUsageSnapshot["activity"] {
// 热力图只依赖 series；summary 缺失不影响格子，两者数据面独立。
  const heatmap = buildCodingPlanActivityHeatmap(payload?.series ?? []);
  return {
    summary: {
      totalTokens: toFiniteNumber(payload?.summary?.totalTokens) ?? 0,
      peakDailyTokens: toFiniteNumber(payload?.summary?.peakDailyTokens) ?? 0,
      peakDailyTokensDate: payload?.summary?.peakDailyTokensDate?.trim() || null,
      totalUsageDurationMs: toFiniteNumber(payload?.summary?.totalUsageDurationMs) ?? 0,
      currentStreakDays: toFiniteNumber(payload?.summary?.currentStreakDays) ?? 0,
      longestStreakDays: toFiniteNumber(payload?.summary?.longestStreakDays) ?? 0,
      favoriteModelName: null,
    },
    heatmap,
  };
}

function buildCodingPlanActivityHeatmap(
  series: BigModelCreditUsageActivitySeriesPayload[],
): AppUsageHeatmap {
// 先过滤非法日期再排序：非法日期会让 Date 解析出 NaN，
// 进而污染 weekStart 计算，使整周格子错位到 1970 年。
// 排序后同一 date 的重复行仍会保留，但 byDate 以后写覆盖前写（后出现者胜）。
  const cells = series
    .map((item) => {
      const date = item.date?.trim() ?? "";
      const totalTokens = toFiniteNumber(item.totalTokens) ?? 0;
      const turnCount = toFiniteNumber(item.modelCallCount) ?? 0;
// 只接受严格的 YYYY-MM-DD：上游偶发返回 ISO 带时间或本地化格式，
// 放行会让后续 UTC 日期运算按“本地时区解析”产生偏差。
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        return null;
      }
      return {
        date,
        totalTokens,
        turnCount,
        toolCallCount: toFiniteNumber(item.mcpCalls) ?? 0,
      };
    })
    .filter((cell): cell is Omit<AppUsageHeatmapCell, "level"> => cell !== null)
    .sort((left, right) => left.date.localeCompare(right.date));
// 至少留 0 作为下界：cells 为空时 Math.max(...[]) 是 -Infinity，
// 会让 levelForTokens 的 max<=0 判定失效并产生 NaN 等级。
  const maxTokens = Math.max(0, ...cells.map((cell) => cell.totalTokens));
  const weeks = buildAppUsageHeatmapWeeks(cells, maxTokens);
  return {
    startDate: cells[0]?.date ?? null,
    endDate: cells.at(-1)?.date ?? null,
    maxTokens,
    weeks,
  };
}

function buildAppUsageHeatmapWeeks(
  cells: Array<Omit<AppUsageHeatmapCell, "level">>,
  maxTokens: number,
): AppUsageHeatmapWeek[] {
// 日期 → 单元格的索引用于把稀疏 series 铺进完整 7 天网格；
// 没有索引就必须每天做一次线性查找。
  const byDate = new Map(cells.map((cell) => [cell.date, cell] as const));
// 以“周起始日序号”为键聚合，天然去重且保持插入顺序；
// 每个周对象固定 7 个槽位，空槽为 null，前端可直接按列渲染。
  const weekStarts = new Map<number, AppUsageHeatmapWeek>();
  for (const cell of cells) {
// 无法解析的日期直接跳过而不是补到 1970：
// 错误数据只应丢失自身，不能污染整周布局。
    const dayIndex = dateKeyToUtcDayIndex(cell.date);
    if (dayIndex === null) continue;
// 以 UTC 周日为每周起点：getUTCDay 在 UTC 日期上稳定，
// 用本地 getDay 会在跨时区用户处把同一份数据切成不同的周。
    const weekStart = dayIndex - new Date(dayIndex * DAY_MS).getUTCDay();
    let week = weekStarts.get(weekStart);
    if (!week) {
      week = {
        weekIndex: weekStarts.size,
        days: Array.from({ length: 7 }, (_, index) => {
          const date = utcDayIndexToDateKey(weekStart + index);
          const source = byDate.get(date);
          return source
            ? { ...source, level: levelForTokens(source.totalTokens, maxTokens) }
            : null;
        }),
      };
      weekStarts.set(weekStart, week);
    }
  }
// 按周起始日排序后重新编号 weekIndex：
// 插入顺序来自 series 顺序，直接使用会让 weekIndex 与真实时间顺序不一致。
  return [...weekStarts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, week], index) => ({ ...week, weekIndex: index }));
}

// 固定 86400000 而不是用日历库：热力图只需“日期序号”的相对差，
// UTC 下不存在 DST，等长毫秒即等于等长天。
const DAY_MS = 86_400_000;

// 把日期键转成“UTC 日序号”，用于加减与求星期，避免反复构造 Date 比较；
// 非法日期返回 null 而不是 NaN，让调用方能显式跳过。
function dateKeyToUtcDayIndex(dateKey: string): number | null {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / DAY_MS);
}

// 与 dateKeyToUtcDayIndex 互为逆运算，截取 ISO 前 10 位得到 YYYY-MM-DD。
function utcDayIndexToDateKey(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

// 等级映射：0 与空值固定 0 级；其余按比例分 4 档，且至少 1 级，
// 保证“有数据但很小”与“没有数据”在视觉上可区分。
// Math.min(4, ...) 是防御 max 计算误差导致 >4，越界等级会让样式表取不到类名。
function levelForTokens(value: number, max: number): AppUsageHeatmapCell["level"] {
// 0 与空值都是 0 级；max<=0 时所有点都无意义，统一 0 级避免除零。
// 这里先返回，后续计算才能安全地假定 max>0。
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as AppUsageHeatmapCell["level"];
}

// detail 区块的 model 与 tool 复用同一个汇总函数：两侧字段结构一致，
// 分开实现只会让 trend 的处理规则出现分歧。
function buildCodingPlanUsageDetailSnapshot(
  modelDetailData: BigModelCreditUsageDetailPayload | undefined,
  toolDetailData: BigModelCreditUsageDetailPayload | undefined,
): CodingPlanUsageSnapshot["detail"] {
  return {
    model: buildCodingPlanUsageDetailSummary(modelDetailData?.summary),
    tool: buildCodingPlanUsageDetailSummary(toolDetailData?.summary),
  };
}

// 注意 value 与 trend 的缺失语义不同：value 缺失补 0（展示需要数字），
// trend 缺失保持 null（UI 应隐藏涨跌箭头，而不是显示 0% 的持平）。
// cacheHitRate 不做 0~1 与 0~100 的换算，后端给什么单位就展示什么。
function buildCodingPlanUsageDetailSummary(
  summary: BigModelCreditUsageDetailPayload["summary"] | undefined,
): CodingPlanUsageSnapshot["detail"]["model"] {
  return {
    cacheHitRate: toFiniteNumber(summary?.cacheHitRate?.value),
    cacheHitRateTrend: toFiniteNumber(summary?.cacheHitRate?.trend),
    totalCredits: toFiniteNumber(summary?.totalCredits?.value) ?? 0,
    totalCreditsTrend: toFiniteNumber(summary?.totalCredits?.trend),
    averageDailyCredits: toFiniteNumber(summary?.averageDailyCredits?.value) ?? 0,
    averageDailyCreditsTrend: toFiniteNumber(summary?.averageDailyCredits?.trend),
  };
}

// 健康度只保留两条解码速度曲线，时间轴按 x_time → xTime 顺序取；
// 序列统一经 normalizeNumberSeries 清洗，保证 UI 拿到的数组可安全求最大/最小。
// 缺失的曲线给空数组而不是 null，前端可直接 map 而无需判空。
function buildCodingPlanHealthSnapshot(
  payload: BigModelUsageModelPerformancePayload | undefined,
): CodingPlanUsageSnapshot["health"] {
  return {
// 两个时间轴字段择一，顺序固定为 snake → camel（INV-07）；
// 都缺失时给空数组，让图表隐藏而不是报错。
    xTime: payload?.x_time ?? payload?.xTime ?? [],
    proMaxDecodeSpeed: normalizeNumberSeries(payload?.proMaxDecodeSpeed),
    liteDecodeSpeed: normalizeNumberSeries(payload?.liteDecodeSpeed),
  };
}

// legacy monitor 的模型行：只有 modelName 可作为标识，缺名直接丢弃；
// tokensUsage 必须按 payload.x_time（源轴）对齐到 target xTime，不能按下标硬塞。
// sortOrder 缺失时用原数组下标，保持后端给出的顺序语义。
function normalizeModelDataList(
  payload: BigModelUsageModelUsagePayload,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
): CodingPlanModelData[] {
  return (payload.modelDataList ?? [])
    .filter((item): item is BigModelUsageModelDataPayload => Boolean(item?.modelName?.trim()))
    .map((item, index) => ({
      modelName: item.modelName!.trim(),
      sortOrder: item.sortOrder ?? index,
      tokensUsage: alignUsageSeries(payload.x_time ?? [], xTime, item.tokensUsage, granularity),
      totalTokens: item.totalTokens ?? 0,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

// credit 版模型行同时可能只有 modelCode 或 modelName，过滤条件是“任一非空”；
// 先剔除拆分桶再对齐，避免为桶做无意义的序列映射。
// 六条明细序列（三组 token/credit）各自独立对齐，任一缺失都补 0 序列。
// token 总量按 totalTokensUsage → tokensUsage → 三组求和 的顺序回退：
// 直接求和会在上游已给 total 时重复计算缓存命中部分。
function normalizeCreditModelDataList(
  payload: NonNullable<BigModelCreditUsageDetailPayload["modelUsage"]>,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
): CodingPlanModelData[] {
  return (payload.modelDataList ?? [])
    .filter((item): item is BigModelCreditUsageModelDataPayload =>
      Boolean(item?.modelName?.trim() || item?.modelCode?.trim()),
    )
    .filter((item) => !isCreditUsageBreakdownBucket(item))
    .map((item, index) => {
// 分类序列全部走同一个对齐函数：源轴与目标轴可能不同粒度，
// 只有统一归一化才能保证同一 model 的缓存/未缓存/输出在时间上可相加。
      const cachedInputTokensUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.cachedInputTokensUsage,
        granularity,
      );
      const uncachedInputTokensUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.uncachedInputTokensUsage,
        granularity,
      );
      const outputTokensUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.outputTokensUsage,
        granularity,
      );
      const cachedInputCreditsUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.cachedInputCreditsUsage,
        granularity,
      );
      const uncachedInputCreditsUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.uncachedInputCreditsUsage,
        granularity,
      );
      const outputCreditsUsage = alignUsageSeries(
        payload.xTime ?? [],
        xTime,
        item.outputCreditsUsage,
        granularity,
      );
      const tokenSeries =
        pickFirstNonEmptySeries([
          item.totalTokensUsage,
          item.tokensUsage,
          sumSeries([
            item.cachedInputTokensUsage,
            item.uncachedInputTokensUsage,
            item.outputTokensUsage,
          ]),
        ]) ?? [];
      const creditSeries =
        pickFirstNonEmptySeries([
          item.totalCreditsUsage,
          sumSeries([
            item.cachedInputCreditsUsage,
            item.uncachedInputCreditsUsage,
            item.outputCreditsUsage,
          ]),
        ]) ?? [];
// 展示名优先 modelName、其次 modelCode；两者都空时用 "unknown"，
// 因为过滤阶段已保证至少一个非空，这里只是类型兜底，不会产生多个同名 unknown。
      const modelName = item.modelName?.trim() || item.modelCode?.trim() || "unknown";
      return {
        modelName,
        sortOrder: item.sortOrder ?? index,
        tokensUsage: alignUsageSeries(payload.xTime ?? [], xTime, tokenSeries, granularity),
        creditsUsage: alignUsageSeries(payload.xTime ?? [], xTime, creditSeries, granularity),
        cachedInputTokensUsage,
        uncachedInputTokensUsage,
        outputTokensUsage,
        cachedInputCreditsUsage,
        uncachedInputCreditsUsage,
        outputCreditsUsage,
        totalTokens: toFiniteNumber(item.totalTokens) ?? sumNumbers(tokenSeries),
        totalCredits: toFiniteNumber(item.totalCredits) ?? sumNumbers(creditSeries),
      };
    })
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

// INV-05 的判定入口：先按 modelCode 命中已知桶名，再按中文展示名兜底。
// [失败路径] 判定错误会让拆分行进入模型列表，总量翻倍且图例出现“缓存/输出”，
// 因此新增后端桶名时必须同步 CREDIT_USAGE_BREAKDOWN_BUCKET_CODES。
function isCreditUsageBreakdownBucket(item: BigModelCreditUsageModelDataPayload): boolean {
// code 比较区分大小写（集合里两种写法都登记了），不做 toLowerCase：
// 后端 code 是受控枚举，宽松匹配会把真实模型 code 误判成桶。
  const code = item.modelCode?.trim();
  if (code && CREDIT_USAGE_BREAKDOWN_BUCKET_CODES.has(code)) {
    return true;
  }
  const name = item.modelName?.trim().toLowerCase();
  // BigModel usage-detail 的 MODEL 数据有时返回“缓存/未缓存/输出”
  // 这种 token 拆分桶。它们是计费组成，不是模型维度，不能作为使用详情的模型图例。
  return name === "缓存" || name === "未缓存" || name === "输出";
}

// 总量必须排除拆分桶，但要在“仅返回桶”时回退到桶求和：
// 若一律排除，只有桶的老响应会让总量变成 0，比翻倍更难排查。
// 每行优先用标量 totalTokens，缺失才用序列求和，避免两条路径重复累加。
function sumCreditModelTokens(
  payload: NonNullable<BigModelCreditUsageDetailPayload["modelUsage"]>,
): number {
  // usage-detail 有时会同时返回真实模型行和“缓存/未缓存/输出”拆分桶，
  // 桶是全部模型 token 的计费组成而非模型维度，直接全量求和会把总用量算成约 2 倍。
  // 存在真实模型行时只统计模型行；仅返回拆分桶时才用桶求和兜底（保持原有语义）。
// 先判定是否存在真实模型行，再决定过滤策略，是这里唯一正确的顺序：
// 先过滤会让“全是桶”的响应变成空集，无法再回退。
  const items = payload.modelDataList ?? [];
  const hasRealModelRow = items.some((item) => !isCreditUsageBreakdownBucket(item));
  const effectiveItems = hasRealModelRow
    ? items.filter((item) => !isCreditUsageBreakdownBucket(item))
    : items;
  return sumNumbers(
    effectiveItems.flatMap((item) => {
      const tokenSeries =
        pickFirstNonEmptySeries([
          item.totalTokensUsage,
          item.tokensUsage,
          sumSeries([
            item.cachedInputTokensUsage,
            item.uncachedInputTokensUsage,
            item.outputTokensUsage,
          ]),
        ]) ?? [];
      const totalTokens = toFiniteNumber(item.totalTokens);
      return totalTokens === null ? tokenSeries : [totalTokens];
    }),
  );
}

// 汇总列表优先取顶层 modelSummaryList，缺失才回退 totalUsage 内嵌版本；
// 与 buildUsageStatsSnapshotFromMonitor 的顺序相反（那里优先 totalUsage），
// 因为 Coding Plan 面板以顶层列表为图例主源，总量字段另行计算。
function normalizeModelSummaryList(
  payload: BigModelUsageModelUsagePayload,
): CodingPlanModelSummary[] {
  return (payload.modelSummaryList ?? payload.totalUsage?.modelSummaryList ?? [])
    .filter((item): item is BigModelUsageModelSummaryPayload => Boolean(item?.modelName?.trim()))
    .map((item, index) => ({
      modelName: item.modelName!.trim(),
      totalTokens: item.totalTokens ?? 0,
      sortOrder: item.sortOrder ?? index,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

// 汇总直接复用明细归一化再投影，避免两套过滤/排序规则分叉；
// 粒度由 xTime 是否含 HH:mm 推断，推断错只会影响轴格式，不影响数值。
function normalizeCreditModelSummaryList(
  payload: NonNullable<BigModelCreditUsageDetailPayload["modelUsage"]>,
): CodingPlanModelSummary[] {
  return normalizeCreditModelDataList(
    payload,
    payload.xTime ?? [],
    (payload.xTime ?? []).some((value) => /\d{2}:\d{2}/u.test(value)) ? "hour" : "day",
  ).map((item) => ({
    modelName: item.modelName,
    totalTokens: item.totalTokens,
    totalCredits: item.totalCredits,
    sortOrder: item.sortOrder,
  }));
}

// legacy 工具行：code 与 name 互为兜底，且都缺失时用 unknown/Unknown 占位，
// 保证图例至少可渲染。usageCount 需按 x_time 对齐到目标时间轴。
function normalizeToolDataList(
  payload: BigModelUsageToolUsagePayload,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
): CodingPlanToolData[] {
  return (payload.toolDataList ?? [])
    .filter((item): item is BigModelUsageToolDataPayload =>
      Boolean(item?.toolCode?.trim() || item?.toolName?.trim()),
    )
    .map((item, index) => ({
      toolCode: item.toolCode?.trim() || item.toolName?.trim() || "unknown",
      toolName: item.toolName?.trim() || item.toolCode?.trim() || "Unknown",
      sortOrder: item.sortOrder ?? index,
      usageCount: alignUsageSeries(payload.x_time ?? [], xTime, item.usageCount, granularity),
      totalUsageCount: item.totalUsageCount ?? 0,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

// MCP 行有四套标识（mcpCode/mcpName/toolCode/toolName），优先级为
// mcp 维度优先、tool 维度兜底；code 与 name 不能交叉取错维度，
// 否则同一个 MCP 会在图例里分裂成两项。
// usage 序列优先 mcpCallCount，credit 序列只认 creditsUsage（两者量纲不同）。
function normalizeCreditToolDataList(
  payload: NonNullable<BigModelCreditUsageDetailPayload["mcpUsage"]>,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
): CodingPlanToolData[] {
  return (payload.mcpDataList ?? [])
    .filter((item): item is BigModelCreditUsageMcpDataPayload =>
      Boolean(
        item?.mcpCode?.trim() ||
        item?.mcpName?.trim() ||
        item?.toolCode?.trim() ||
        item?.toolName?.trim(),
      ),
    )
    .map((item, index) => {
// 两个调用次数字段择一：取第一个“存在非零值”的序列，
// 全零时返回 undefined 并退化为空数组，表示本期确实没有调用。
      const usageSeries = pickFirstNonEmptySeries([item.mcpCallCount, item.usageCount]) ?? [];
// credits 序列不做 mcpCallCount 那种“择一”回退：两者量纲不同，
// 用调用次数冒充积分会让费用图出现数量级错误。
      const creditSeries = item.creditsUsage ?? [];
// toolName 的兜底链最后一环是 toolCode 而不是字符串常量：
// 至少保证 name 与 code 一致，用户仍能对应到具体 MCP。
      const toolCode =
        item.mcpCode?.trim() || item.toolCode?.trim() || item.mcpName?.trim() || "unknown";
      const toolName =
        item.mcpName?.trim() || item.toolName?.trim() || item.mcpCode?.trim() || toolCode;
      return {
        toolCode,
        toolName,
        sortOrder: item.sortOrder ?? index,
        usageCount: alignUsageSeries(payload.xTime ?? [], xTime, usageSeries, granularity),
        creditsUsage: alignUsageSeries(payload.xTime ?? [], xTime, creditSeries, granularity),
// 合计缺失时用序列求和兜底，但绝不把“0”当缺失：
// 后端明确返回 0 表示本期无调用，回退求和会得到同值却不必要地多算一次。
// [权衡] ?? 对 0 不生效，恰好满足这一语义，因此这里无需显式判 null。
        totalUsageCount: toFiniteNumber(item.totalUsageCount) ?? sumNumbers(usageSeries),
        totalCredits: toFiniteNumber(item.totalCredits) ?? sumNumbers(creditSeries),
      };
    })
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

// 工具汇总的字段来源与明细不同（toolSummaryList vs toolDataList），
// 但同样是顶层优先、totalUsage 兜底；两处顺序必须一致，否则图例与总量不匹配。
function normalizeToolSummaryList(payload: BigModelUsageToolUsagePayload): CodingPlanToolSummary[] {
  return (payload.toolSummaryList ?? payload.totalUsage?.toolSummaryList ?? [])
    .filter((item): item is BigModelUsageToolSummaryPayload =>
      Boolean(item?.toolCode?.trim() || item?.toolName?.trim()),
    )
    .map((item, index) => ({
      toolCode: item.toolCode?.trim() || item.toolName?.trim() || "unknown",
      toolName: item.toolName?.trim() || item.toolCode?.trim() || "Unknown",
      totalUsageCount: item.totalUsageCount ?? 0,
      sortOrder: item.sortOrder ?? index,
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

// 与 credit 模型汇总同构：复用明细归一化再投影，保证 code/name 的兜底规则唯一。
function normalizeCreditToolSummaryList(
  payload: NonNullable<BigModelCreditUsageDetailPayload["mcpUsage"]>,
): CodingPlanToolSummary[] {
  return normalizeCreditToolDataList(
    payload,
    payload.xTime ?? [],
    (payload.xTime ?? []).some((value) => /\d{2}:\d{2}/u.test(value)) ? "hour" : "day",
  ).map((item) => ({
    toolCode: item.toolCode,
    toolName: item.toolName,
    totalUsageCount: item.totalUsageCount,
    totalCredits: item.totalCredits,
    sortOrder: item.sortOrder,
  }));
}

// INV-01 的唯一收口点：number 直接判有限；字符串先 trim 再转，空串视为缺失；
// 其余类型（null/undefined/对象）一律 NaN 后被判缺失。
// 返回 null 而不是 0，让调用方自行决定“缺失”的业务含义（见 INV-03）。
function toFiniteNumber(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numericValue) ? numericValue : null;
}

// 序列清洗把缺失/非法元素补 0：图表需要等长数值数组，null 会导致路径断裂。
// 这一步不做去重或排序，保持与时间轴的下标对应关系（INV-04）。
function normalizeNumberSeries(
  values: Array<number | string | null | undefined> | undefined,
): number[] {
  return (values ?? []).map((value) => toFiniteNumber(value) ?? 0);
}

// 求和同样逐个走 toFiniteNumber：直接 reduce 遇到 null 会得到 NaN 并污染整条链路。
function sumNumbers(values: BigModelUsageNumberSeries | undefined): number {
  return (values ?? []).reduce<number>((sum, value) => sum + (toFiniteNumber(value) ?? 0), 0);
}

// 按位置把多条序列相加，用于“总量缺失时用分项求和”的兜底；
// 长度取最长者，短序列缺位按 0 处理，保证结果不与任何一条输入等长错位。
// 全部为空时返回 undefined 而不是 []：调用方据此判断“无法求和”，与真实的空序列区分。
function sumSeries(seriesList: Array<BigModelUsageNumberSeries | undefined>): number[] | undefined {
  const maxLength = Math.max(0, ...seriesList.map((series) => series?.length ?? 0));
  if (maxLength === 0) return undefined;
  return Array.from({ length: maxLength }, (_, index) =>
    seriesList.reduce((sum, series) => sum + (toFiniteNumber(series?.[index]) ?? 0), 0),
  );
}

// “非空”的定义是“存在任一大于 0 的有限值”，不是 length>0：
// 后端常返回全 0 的占位序列，若按长度选中它，会挡住后面真正有数据的字段。
// 选中后统一 normalize，保证返回的一定是 number[]。
function pickFirstNonEmptySeries(
  seriesList: Array<BigModelUsageNumberSeries | undefined>,
): number[] | undefined {
  const series = seriesList.find(
    (item) => Array.isArray(item) && item.some((value) => (toFiniteNumber(value) ?? 0) > 0),
  );
  return series ? normalizeNumberSeries(series) : undefined;
}

// INV-04 的核心实现：把源时间轴上的值按“归一化时间键”搬到目标时间轴。
// 三条分支的取舍：源轴为空且长度恰好匹配时直接按位复用（最快、最准）；
// 源轴为空但长度不匹配时仍按位取，缺失补 0（无键可对，只能信下标）；
// 源轴非空时严格按时间键匹配，匹配不到补 0——绝不用邻近值填充，
// 因为“补 0”只影响单点显示，而“错位填充”会把周数据画到错误的日期上。
function alignUsageSeries(
  sourceXTime: string[],
  targetXTime: string[],
  values: BigModelUsageNumberSeries | undefined,
  granularity: CodingPlanUsageGranularity,
): number[] {
// 先归一化源序列：后续按时间键建索引时，值已保证是有限数，
// 缺失位置补 0，避免 undefined 被写进 Map 后在目标轴显示为空洞。
  const sourceValues = normalizeNumberSeries(values);
// 快路径：无源轴但长度一致，说明两份数据按同一顺序生成，直接返回可跳过建图。
// 这个条件必须两个都满足；只判长度会误把不同粒度的序列当成对齐结果。
  if (sourceXTime.length === 0 && sourceValues.length === targetXTime.length) {
    return sourceValues;
  }

// 用 Map 建索引而不是双重循环：目标轴通常 24~365 个点，O(n*m) 会明显放大耗时。
// 同一归一化键重复出现时后写覆盖前写，与后端“后到为准”的语义一致。
  const valuesByTime = new Map<string, number>();
  sourceXTime.forEach((time, index) => {
    valuesByTime.set(normalizeCodingPlanAxisValue(time, granularity), sourceValues[index] ?? 0);
  });

// 目标轴驱动输出：每个目标点都必须有值，因此匹配失败一律补 0。
// 源轴为空时退回下标取值，并且只在长度足够时命中，越界仍是 0。
  return targetXTime.map((time, index) => {
    const normalizedTime = normalizeCodingPlanAxisValue(time, granularity);
    return (
      valuesByTime.get(normalizedTime) ??
      (sourceXTime.length === 0 ? (sourceValues[index] ?? 0) : 0)
    );
  });
}

// 时间键归一化只做格式统一（时分秒补零、日期截到天），不改顺序、不转时区。
// [权衡] 不做时区换算：上游时间已是用户时区的本地时间字符串，换算反而会二次偏移。
// 两个正则都失败时原样返回，保证无法识别的键仍可与自身匹配。
function normalizeCodingPlanAxisValue(
  value: string,
  granularity: CodingPlanUsageGranularity,
): string {
// 小时粒度下键精确到秒（缺秒补 00），因为同一小时内可能有多个采样点；
// 日粒度只保留日期，丢弃时间部分，避免 '2026-01-01 00:00:00' 与 '2026-01-01' 无法匹配。
  if (granularity === "hour") {
// 时粒度键统一成 HH:mm:ss，缺秒补 00：
// 上游有时只给 HH:mm，不补齐会与带秒的键无法匹配，整段曲线归零。
    const timeMatch = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
    if (timeMatch) {
      return `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3] ?? "00"}`;
    }
  }

// 日粒度的兜底匹配：即使输入带时间后缀也裁成日期，
// 保证 '2026-01-01' 与 '2026-01-01 12:00:00' 归一到同一个键。
  const dateMatch = /(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (dateMatch) {
    return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
  }
  return value;
}

// 三种内置 MCP 用固定表驱动，顺序即 UI 展示顺序，不能改成按用量排序：
// 固定顺序让用户在不同日期之间对比时不会因为排序变化而找不到同一项。
// totalCalls 优先用后端合计，缺失才按 daily 求和（daily 可能被窗口截断）。
function buildToolUsages(toolData: BigModelUsageToolUsagePayload): UsageStatsToolUsage[] {
  const tools: UsageStatsToolUsage[] = [];

// toolCode 是稳定标识，displayName 是会变的展示文案；两者不可互换：
// 下游按 toolCode 做国际化与埋点，按 displayName 匹配会在改文案时失效。
  const definitions: Array<{
    toolCode: string;
    displayName: string;
    daily?: number[];
    total?: number;
  }> = [
    {
      toolCode: "network-search",
      displayName: "联网搜索 MCP",
      daily: toolData.networkSearchCount,
      total: toolData.totalUsage?.totalNetworkSearchCount,
    },
    {
      toolCode: "web-reader",
      displayName: "网页读取 MCP",
      daily: toolData.webReadMcpCount,
      total: toolData.totalUsage?.totalWebReadMcpCount,
    },
    {
      toolCode: "zread",
      displayName: "开源仓库 MCP",
      daily: toolData.zreadMcpCount,
      total: toolData.totalUsage?.totalZreadMcpCount,
    },
  ];

  for (const def of definitions) {
    const dailyCalls = Array.isArray(def.daily) ? def.daily : [];
// 仅当 total 是非 undefined 的 number 才采用；用 typeof 判定而不是 ??，
// 因为后端可能回 null，而 null ?? 求和会静默回退，掩盖“合计缺失”。一样的语义但更显式。
// daily 元素允许 null，求和时按 0 处理。
    const totalCalls =
      typeof def.total === "number"
        ? def.total
        : dailyCalls.reduce((sum, value) => sum + (value ?? 0), 0);
    tools.push({
      toolCode: def.toolCode,
      displayName: def.displayName,
      totalCalls,
      dailyCalls,
    });
  }

// search-mcp 只在 totalUsage 里出现，因此按天数组为空；只有总量 > 0 才追加，
// 否则会多出一个永远为 0 的图例项。
// [权衡] 它和 network-search 语义相近但不合并：后端分开计费，合并会让用户对账不上。
  // search-mcp 没有按天数据,只有合计;有数值时单独追加一条。
  const totalSearchMcp = toolData.totalUsage?.totalSearchMcpCount ?? 0;
  if (totalSearchMcp > 0) {
    tools.push({
      toolCode: "search-mcp",
      // 该接口同时有 network-search 和 search-mcp 两个搜索类统计项。
      // 网页截图只明确了前者叫“联网搜索 MCP”，这里保留 Search MCP 避免两个搜索项重名。
      displayName: "Search MCP",
      totalCalls: totalSearchMcp,
      dailyCalls: [],
    });
  }

  return tools;
}
