/* eslint-disable max-lines -- quota、entitlement 与 monitor 请求共用同一套 provider 鉴权逻辑，拆文件会让 Coding Plan strict key 边界更难追踪。 */
// ============================================================================
// BigModel / Z.ai 使用额度聚合 Provider：entitlement、usage-stats、coding-plan reset。
//
// INV-01：返回快照前必须校验账号连接仍然“当前”（守住：getSnapshotForRequest 与
//   getUsageStatsSnapshot 里的 assertCurrent）。校验缺失时，切号瞬间的在途请求会把 A 的
//   额度渲染到 B 的界面，且失败退避会被错误清除。
// INV-02：entitlement.kind 为 unknown 且已具备查询身份时不得发布成功空快照（守住：同函数
//   unknown 抛错分支）。否则 hook 会把“查不到”落库成“没有权益”，已确认套餐被清空。
// INV-03：entitlement 与 quota 是两条独立数据面（守住：Promise.all 中对 fetchQuota 的 catch）。
//   额度接口抖动只允许 quota 为 null，不能连带否定“有没有套餐”这一事实。
// INV-04：时间出口统一为毫秒（守住：normalizeZaiStartPlanBalanceLimits、parseUnixSeconds）。
//   上游 balance 全是秒；漏乘 1000 会得到 1970 年，UI 永远显示“已重置/已过期”。
// INV-05：provider family 决定 token key、业务域名与 type 参数（守住：
//   resolveCodingPlanResetAuthorization、buildCreditUsageMonitorUrl）。跨 family 回退会把
//   zai 凭据发往 bigmodel 域名，表现为 401 或读到别人的团队数据。
// INV-06：reset 的 idempotencyKey 长度必须是 1~64（守住：useCodingPlanReset 与
//   requestCodingPlanResetOpportunity 的入口校验）。放行空值会让后端把重复点击当成多次
//   新请求，重复消耗用户有限的重置次数。
// INV-07：3301 的 next_try_at 必须原样透传（守住：requestCodingPlanResetOpportunity 的
//   3301 分支）。丢弃它会让 30 秒轮询持续撞限流，最终 429 把可用机会误报成不可用。
// INV-08：诊断日志只保留 origin+pathname 与 request id（守住：sanitizeMonitorDiagnosticUrl、
//   readApiDiagnosticHeaders）。日志会流入 RPC 与用户可见 warn，完整 URL 的 query 会泄露
//   组织/项目标识，等价于泄露账号结构。
//
// 分层：本文件只负责“取数、归一化、错误语义”，不持有缓存；快照生命周期由上层 hook 决定。
// ============================================================================
import { z } from "zod";
import type {
  ApiClient,
  ApiRequestInit,
  CodingPlanRegularTpsRequest,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageMcpQuotaSnapshot,
  UsageQuotaLimit,
  UsageStatsRequest,
  UsageStatsSnapshot,
  ZCodeAccountAccess,
} from "@zcode/shared";
import {
  ApiError,
  BUILTIN_MODEL_PROVIDER_IDS,
  isCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  isZaiCodingPlanProviderId,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";
import type { ProviderFamilyDomain } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ICredentialService } from "../../credential/credential.js";
import type { IAccountRequestAuthService } from "../../model-provider/accountRequestAuthService.js";
import { readApiJson } from "../../providers/api/apiJson.js";
import { readEnv } from "../../oauth/providers/configUtils.js";
import {
  buildZaiStartPlanBalanceUrl,
  fetchZaiStartPlanBalanceEnvelope,
  type ZaiStartPlanBalanceEnvelope,
  type ZaiStartPlanPlan,
} from "../../model-provider/zaiStartPlanBilling.js";
import type {
  BigModelUsageModelUsagePayload,
  BigModelUsageModelUsageEnvelope,
  BigModelUsageToolUsagePayload,
  BigModelUsageToolUsageEnvelope,
  BigModelCreditUsageActivityPayload,
  BigModelCreditUsageActivityEnvelope,
  BigModelCreditUsageDetailPayload,
  BigModelCreditUsageDetailEnvelope,
  BigModelUsageModelPerformancePayload,
  BigModelUsageModelPerformanceEnvelope,
} from "./bigmodelUsageMonitorMapper.js";
import {
  buildCodingPlanUsageSnapshotFromMonitor,
  buildUsageStatsSnapshotFromMonitor,
} from "./bigmodelUsageMonitorMapper.js";
import {
  resolveCodingPlanUsageTimeRange,
  resolveUsageTimeRange,
} from "./bigmodelUsageMonitorRange.js";
import { fetchBigModelSubscriptionSummary } from "./bigmodelSubscriptionProvider.js";
import {
  fetchMcpQuotaSnapshot,
  type OfficialMcpCredentialSource,
} from "./zcodeMcpQuotaProvider.js";
import type { BigModelUsageQuotaEnvelope } from "./bigmodelUsageQuotaMapper.js";
import { normalizeLimits, pickPrimaryLimit } from "./bigmodelUsageQuotaMapper.js";

// 常量区：这里的每个字面量都是对外契约的一部分，改动会直接影响鉴权与路由。
// 15s 超时高于普通 RPC：monitor 聚合要跨多个分片查询，过短会把正常慢查询降级成失败。
// EMPTY_* 常量是“上游确认成功但没有 data”时的占位对象，必须是全新的不可变空对象；
// 若复用同一个可变对象并让下游写入，第二次请求会读到上一次的残留用量。
// satisfies 只做类型收窄、不产生运行时包装，保证空对象在序列化/比较时仍是 {}。
const BIGMODEL_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const CODING_PLAN_RESET_BASE_PATH = "/api/v1/coding-plan/reset";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ZAI_OAUTH_ACCESS_TOKEN_KEY = "oauth:zai:access_token";
const BIGMODEL_OAUTH_ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("usage-stats");
const EMPTY_MODEL_USAGE_PAYLOAD = {} satisfies BigModelUsageModelUsagePayload;
const EMPTY_TOOL_USAGE_PAYLOAD = {} satisfies BigModelUsageToolUsagePayload;
const EMPTY_CREDIT_ACTIVITY_PAYLOAD = {} satisfies BigModelCreditUsageActivityPayload;
const EMPTY_CREDIT_DETAIL_PAYLOAD = {} satisfies BigModelCreditUsageDetailPayload;
const EMPTY_MODEL_PERFORMANCE_PAYLOAD = {} satisfies BigModelUsageModelPerformancePayload;

// reset 系列 schema 采用“宽信封 + 窄 data”的两段式校验：
// 信封只认 code/msg/data，因为后端在 4xx 时也走同一信封返回稳定业务码；
// data 才按接口各自收紧（如 used 必须为字面量 true）。
// [权衡] 不用 z.enum 约束 code：3301 是后来新增的限流码，枚举会让旧客户端在
// 未知新码时直接解析失败，丧失“把新码透传成可诊断错误”的能力。
// expire_at/used_at 要求 positive：0 与缺失语义相同（无机会），不能被当成合法时间戳，
// 否则 UI 会把“没有可重置次数”渲染成“1970 年过期”，引导用户去点一个不存在的入口。
const codingPlanResetEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});
const codingPlanResetOpportunitySchema = z.object({
  expire_at: z.number().finite().positive(),
});
const codingPlanResetHistorySchema = z.object({
  used_at: z.number().finite().positive(),
});
const codingPlanResetStatusDataSchema = z.object({
  available_five_hour_resets: z.array(codingPlanResetOpportunitySchema),
  available_week_resets: z.array(codingPlanResetOpportunitySchema),
  latest_five_hour_reset_history: codingPlanResetHistorySchema.nullable(),
  latest_week_reset_history: codingPlanResetHistorySchema.nullable(),
  has_unread_history: z.boolean(),
});
const codingPlanResetUseDataSchema = z.object({
  used: z.literal(true),
});
const codingPlanResetOpportunityGrantedDataSchema = z.object({
  granted: z.literal(true),
});
const codingPlanResetOpportunityDeniedDataSchema = z.object({
  granted: z.literal(false),
  next_try_at: z.number().int().positive(),
});

export interface UsageApiAuthorizationRequest {
  readonly preferredProviderId?: string;
  readonly requirePreferredProvider: boolean;
}

export interface UsageApiAuthorization {
  readonly authorization: string;
  readonly quotaUrl: string;
  readonly provider: ResolvedQuotaAuthorization["provider"];
}

// 依赖全部由构造参数注入，便于单测替换 apiClient 与凭证服务。
// resolveApiAuthorization 可选：未注入时只支持环境变量与 Coding Plan API Key 两条路径，
// 这是宿主未装配账号体系时的合法降级，不是错误配置。
// officialMcpCredentialSource 缺省则 mcpQuota 恒为 null（见字段注释），保证老装配零行为变化。
interface BigModelUsageQuotaProviderOptions {
  apiClient: ApiClient;
  accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  resolveApiAuthorization?: (
    request: UsageApiAuthorizationRequest,
  ) => Promise<UsageApiAuthorization | null>;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  /**
   * 官方 Server MCP 的凭证来源。缺省时 entitlement 快照的 mcpQuota 恒为 null，
   * 既有装配（含单测）无需改动即可保持原行为。
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
}

interface ResolvedQuotaAuthorization {
  authorization: string;
  quotaUrl: string;
  teamContext: TeamPlanContext | null;
  provider: {
    id: string;
    name: string;
  };
}

// Team Plan 上下文只在 planKind 为 team-coding-plan 时构造；
// organizationId/projectId 决定后端按哪个组织项目计费，缺失时不能退化成个人额度，
// 否则团队管理员会看到个人余额并据此误判预算。
interface TeamPlanContext {
  organizationId: string;
  projectId: string;
  // Team Plan 用量查询在 zai/bigmodel 两个 family 上对称存在，
  // 但复制团队项目 API Key 的 host、OAuth token key、鉴权 header 都按 family 分离。
  // 这里必须带上 family，下游 resolveTeamPlanProjectApiKey 才能选对 zai/bigmodel 的业务域名和 token。
  family: ProviderFamilyDomain;
}

interface CodingPlanResetAuthorization {
  zcodeAuthorization: string;
  codingPlanAuthorization: string;
  teamContext: TeamPlanContext | null;
}

// 这里刻意用索引访问从响应类型里“取”元素类型，而不是手写一个 Balance 接口：
// 后端新增 bucket/周期字段时，类型会自动跟上，不会出现“上游有值但本地类型没声明”。
// [权衡] 代价是本文件对 billing 模块的类型结构有隐式依赖，改动该类型需同步回归这里。
// 直接复用响应类型，避免本地副本遗漏新 bucket/周期字段。
type ZaiStartPlanBalance = NonNullable<
  NonNullable<ZaiStartPlanBalanceEnvelope["data"]>["balances"]
>[number];

// 所有字段 readonly：provider 是无状态单例，请求之间只共享注入的依赖。
// [并发] 实例会被多个 RPC 请求同时调用，因此禁止在实例上缓存“当前账号/当前额度”；
// 任何可变缓存都会让并发请求互相串号。账号级去重由上层 hook 按 identity key 完成。
export class BigModelUsageQuotaProvider {
  private readonly apiClient: ApiClient;
  private readonly accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  private readonly resolveApiAuthorization?: BigModelUsageQuotaProviderOptions["resolveApiAuthorization"];
  private readonly credentialService?: Pick<ICredentialService, "load">;
  private readonly env: NodeJS.ProcessEnv;
// 可选依赖只读保存，用于 entitlement 聚合时补 MCP 额度；
// 不参与鉴权决策，缺失时仅影响 mcpQuota 字段。
  private readonly officialMcpCredentialSource?: OfficialMcpCredentialSource;

  constructor(options: BigModelUsageQuotaProviderOptions) {
    this.apiClient = options.apiClient;
    this.accountRequestAuthService = options.accountRequestAuthService;
    this.resolveApiAuthorization = options.resolveApiAuthorization;
    this.credentialService = options.credentialService;
// 注入 env 优先：单测与多环境运行时必须能覆盖域名/Key，
// 直接读 process.env 会让同一进程内的测试互相污染。
    this.env = options.env ?? process.env;
    this.officialMcpCredentialSource = options.officialMcpCredentialSource;
  }

  async getSnapshot(): Promise<UsageEntitlementSnapshot> {
// 无参入口只服务于“当前账号”场景，等价于空 request；
// 保留它是因为老调用方与 RPC 契约仍按无参签名注册，删除会造成跨包编译失败。
    return this.getSnapshotForRequest({});
  }

// entitlement 主流程：解析账号 → 判定 Start Plan 分流 → 拉订阅 → 拉 quota/mcpQuota。
// 顺序不可交换：accountAccess 必须先物化，后续团队上下文、凭据选择、当前性校验都依赖它。
// [失败路径] 本函数允许抛错（订阅未知或当前性校验失败），由上层统一失败路径保留旧快照；
// 不允许在这里 fail-open 返回空对象，否则会覆盖已确认权益。
  async getSnapshotForRequest(
    request: UsageEntitlementRequest = {},
  ): Promise<UsageEntitlementSnapshot> {
    // 设置页只能从 Registry 取得静态 family/mode。动态 planKind 与 Team scope
    // 必须在服务边界读取当前账号连接；不能要求 UI 从 Effective Config 伪造动态权益事实。
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
// 用展开而不是原地赋值：request 由调用方持有，改写它会让上层看到的请求对象被污染。
    const resolvedRequest: UsageEntitlementRequest = {
      ...request,
      accountAccess,
    };
// Start Plan 走独立数据源（billing/balance），与 Coding Plan 的 monitor 完全不同；
// 必须在解析普通凭据之前分流，否则 Start Plan 身份会先被要求提供 API Key 而直接失败。
// 这里传 accountAccess 而不是 request.accountAccess：后者可能是带 mode 的未解析形态。
    if (request.preferredProviderId && isStartPlanModelProviderId(request.preferredProviderId)) {
      return this.getStartPlanSnapshot(
        request.preferredProviderId,
        accountAccess,
        request.invalidateBalanceCache,
      );
    }

    const generatedAt = Date.now();
    const teamContext = accountAccess ? resolveTeamPlanContext(accountAccess) : null;
    const providerId = request.preferredProviderId?.trim() ?? "";
    // 团队权益不以调用 Key 为前置条件；即使 Key 创建/复制失败也保留已确认的订阅。
// [失败路径] 团队订阅先单独查，authorization 传空串：后端按团队项目凭据判定，
// 不依赖调用者是否持有 API Key。这样即使 Key 创建/复制失败，已确认的团队套餐仍能展示。
// 若把 teamEntitlement 放进下面的 try 里与个人凭据一起解析，凭据异常会连带丢失团队事实。
// [权衡] 空 authorization 的请求会多一次网络往返，但换来“权益与 Key 解耦”，值得。
    const teamEntitlement = teamContext
      ? await fetchBigModelSubscriptionSummary({
          apiClient: this.apiClient,
          authorization: "",
          quotaUrl:
            resolveQuotaUrlFromEnv(this.env) ??
            (teamContext.family === "zai"
              ? buildZaiQuotaUrl(this.env)
              : buildBigModelQuotaUrl(this.env)),
          teamContext,
          businessToken: await this.credentialService?.load(
            `oauth:${teamContext.family}:access_token`,
          ),
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
      : null;
// [失败路径] 凭据解析失败只记 warn 并继续：entitlement 仍可由团队上下文或 unknown 分支给出。
// 这里吞掉异常是有边界的——后续 quota 与 subscription 都会因 resolved 为 null 而跳过，
// 不会用半残凭据发请求；最终是否失败由下面的 unknown 判定统一决定。
    let resolved: ResolvedQuotaAuthorization | null = null;
    try {
      resolved = await this.resolveAuthorization({
        preferredProviderId: request.preferredProviderId,
        accountAccess,
        requirePreferredProvider: request.requirePreferredProvider === true,
        allowEnvApiKey: request.allowEnvApiKey,
      });
    } catch (error) {
// 凭据失败只 warn 不抛：entitlement 仍可由团队订阅给出，
// 若在此处抛出，会让“团队套餐可见但 Key 暂不可用”的用户失去整个权益卡片。
// 日志记录 preferredProviderId，便于区分是某个 provider 装配问题还是全局故障。
// [权衡] 吞异常意味着个人订阅也会缺省为 unknown，由后续 unknown 判定统一兜底。
      log.warn(undefined, "读取用量凭据失败，保留独立订阅判定", {
        error: error instanceof Error ? error.message : String(error),
        preferredProviderId: providerId,
      });
    }
// 团队订阅优先于个人订阅：同一个人可能既在团队又在个人套餐下，
// 设置页当前展示的是团队上下文，用个人套餐覆盖会让额度数字与 scope 不一致。
    const entitlement =
      teamEntitlement ??
      (resolved
        ? await fetchBigModelSubscriptionSummary({
            apiClient: this.apiClient,
            authorization: resolved.authorization,
            quotaUrl: resolved.quotaUrl,
            timeoutMs: REQUEST_TIMEOUT_MS,
          })
        : { kind: "unknown" as const });
// [失败路径] 只有在“本来就没有查询身份”（未登录/未配置）时才允许把 unknown 展示为未配置；
// 一旦存在 resolved 凭据或 teamContext，unknown 就代表上游异常，必须抛错让 hook 走退避重试。
// 判据用 resolved || teamContext 而不是 authenticated：后者恒为 true，无法区分未配置与查询失败。
    // 订阅未知不能发布为成功空快照，否则 hook 会覆盖同身份已确认权益并清除失败退避。
    // 无凭据的未配置状态仍正常返回；已有查询身份时让统一失败路径保留快照。
    if (entitlement.kind === "unknown" && (resolved || teamContext)) {
      throw new Error("Coding Plan entitlement refresh failed");
    }
// 只有 kind=available 才构造 subscription；unavailable 与 unknown 都必须显式为 null，
// 否则 UI 会把上一次套餐的名称/到期时间继续展示，掩盖“套餐已失效”的事实。
    const subscription =
      entitlement.kind !== "available" ? null : buildSubscriptionSnapshot(entitlement.subscription);
// [并发] quota 与 mcpQuota 互不依赖，并行发起以压低设置页首屏延迟。
// 两者各自 catch 成 null：任一失败都不能 reject Promise.all 把整张面板打成错误态，
// 这正是 INV-03 的落地位置；resolved 为 null 时直接给 [null, null]，不发无凭据请求。
// [权衡] 并行会让两个请求同时占用连接，但二者都受 15s 超时约束，最坏延迟仍是单次超时。
    const [payload, mcpQuota] = resolved
      ? await Promise.all([
          this.fetchQuota(resolved).catch(() => null),
          this.fetchMcpQuota(resolved).catch(() => null),
        ])
      : [null, null];
    // quota 失败或 level 存在都不改变权益；额度耗尽也只影响用量显示。
// quota 失败或只返回 level 都不影响权益判定（见 INV-03），因此这里降级为 null 而不抛错；
// 额度耗尽同样只是用量显示问题，不能反过来改变 subscription。
    const quotaData = payload && isSuccessfulBigModelEnvelope(payload) ? payload.data : null;
// limits 归一化在 mapper 里完成（单位、缺省、排序），provider 只做透传；
// 在这里二次处理会让两处规则漂移，出现 entitlement 与用量页数字不一致。
    const limits = normalizeLimits(quotaData?.limits);
// remaining 卡只展示一个“主限额”，由 quota mapper 统一挑选；
// 这里不复用 limits[0]，避免顺序变化导致卡片数字跳动。
    const primaryLimit = pickPrimaryLimit(limits);
// [并发] 所有 await 结束后再校验“账号是否仍是当前”，这是防止切号竞态的最后一道闸。
// 校验放在组装返回值之前：若先组装再校验，抛错时浪费一次完整取数，且日志顺序会误导排查。
// 只有同时具备 accountAccess 与 providerId 才有校验对象；无 provider 的公共快照不校验。
    if (accountAccess && providerId) {
      await this.accountRequestAuthService.assertCurrent({
        providerId,
        accountAccess,
      });
    }
    return {
      generatedAt,
      authenticated: true,
// unavailableReason 的优先级：no_plan（明确无套餐）> unavailable（上游查询失败）>
// not_configured（从未配置身份）。三者对应完全不同的用户引导，不能合并。
// [权衡] 用条件展开而非在返回后赋值，保证该字段在类型上是可选的。
      ...(entitlement.kind === "available"
        ? {}
        : {
            unavailableReason:
              entitlement.kind === "unavailable"
                ? ("no_plan" as const)
                : resolved || teamContext
                  ? ("unavailable" as const)
                  : ("not_configured" as const),
          }),
      ...(teamEntitlement?.kind === "unavailable" && teamEntitlement.reason
        ? { teamPlanUnavailableReason: teamEntitlement.reason }
        : {}),
      context: resolved
        ? buildUsageEntitlementContext(resolved, subscription)
        : buildUsageEntitlementContextFromRequest(resolvedRequest),
      provider: resolved?.provider ?? null,
// remaining 是给“顶部余额卡”的单一数字，必须与 quota.limits 使用同一份归一化结果；
// count 缺失时补 0：卡片需要一个数字，undefined 会渲染成空白。
// nextResetTime 缺失显式为 null，让 UI 隐藏倒计时而不是显示 1970。
      remaining: primaryLimit
        ? {
            count: primaryLimit.remaining ?? 0,
            isShow: true,
            percentage: primaryLimit.percentage,
            nextResetTime: primaryLimit.nextResetTime ?? null,
          }
        : null,
      subscription,
// level 必须 trim 后判空：上游偶发返回全空格，直接透传会让 UI 出现一个空标题的额度组。
// limits 保留空数组而不是 null，表示“成功但没有任何限额”，与“接口失败”语义区分开。
      quota: quotaData ? { level: quotaData.level?.trim() || null, limits } : null,
// mcpQuota 为 null 表示“无该权益或查询失败”，UI 据此隐藏 MCP 区块而不是显示 0。
      mcpQuota,
    };
  }

// accountAccess 有两种形态：已解析的实体，或只带 mode 的“引用”。
// 引用形态必须在服务边界解析成实体，不能带到下游——下游只认 organizationId/family 等字段。
  private async resolveRequestAccountAccess(
    accountAccess: UsageEntitlementRequest["accountAccess"],
  ): Promise<ZCodeAccountAccess | undefined> {
    if (!accountAccess) return undefined;
    if (!("mode" in accountAccess)) return accountAccess;
    return (await this.accountRequestAuthService.resolveAccessCurrent(accountAccess)) ?? undefined;
  }

  /**
   * 读取官方 Server MCP 额度。仅 Coding Plan provider 会发起：
   * 环境变量 key、普通 API Key provider 与 Start Plan 都没有该权益。
   */
// MCP 额度只属于 Coding Plan：环境变量 Key、普通 API Key、Start Plan 都没有该权益。
// 在这里提前 return null 而不是让下游处理，避免对不具备权益的身份发请求并产生 403 噪音。
// requestScope 的 family 优先取 teamContext，保证团队项目查的是团队 MCP 池而不是个人池。
// MCP 额度是可选数据面：任何异常都由调用方 catch 成 null，
// 因此这里不做容错，保持“取数失败就抛”的单一语义。
// [并发] 与 quota 并行发起，二者互不依赖。
  private async fetchMcpQuota(
    resolved: ResolvedQuotaAuthorization,
  ): Promise<UsageMcpQuotaSnapshot | null> {
// 宿主未装配 MCP 凭证源时直接返回 null：这是可选能力，不是错误，
// 因此不能抛错，也不能发请求。
    if (!this.officialMcpCredentialSource) {
      return null;
    }
// 只有 Coding Plan 系 provider 才有 MCP 额度；普通 API Key 与 Start Plan 请求必然 403，
// 提前返回可以避免把无权益身份的错误日志算进接口健康度。
// 判据用 provider.id 而不是 family：家族决定域名，provider 决定权益。
    if (!isCodingPlanModelProviderId(resolved.provider.id)) {
      return null;
    }
    return fetchMcpQuotaSnapshot({
      apiClient: this.apiClient,
      credentialSource: this.officialMcpCredentialSource,
      env: this.env,
      requestScope: {
        providerFamily:
// family 的取值顺序：团队上下文（团队一定有 family）→ 按 provider 推断；
// 推断失败时落 bigmodel，与 resolveAccountProviderQuotaUrl 的默认保持一致，
// 避免请求域名与 MCP scope 指向不同 family。
          resolved.teamContext?.family ??
          (isZaiCodingPlanProviderId(resolved.provider.id) ? "zai" : "bigmodel"),
        organizationId: resolved.teamContext?.organizationId ?? null,
        projectId: resolved.teamContext?.projectId ?? null,
      },
    });
  }

// Start Plan 快照只依赖一次 billing/balance 请求，balance 同时给出 plans 与 balances。
// 未解析到凭据时返回 not_configured 而不是抛错：未登录是合法状态，不应触发失败退避。
// invalidateBalanceCache 透传到取数层，用于用户手动刷新时绕过缓存。
  private async getStartPlanSnapshot(
    providerId: string,
    accountAccess: ZCodeAccountAccess | undefined,
    invalidateBalanceCache = false,
  ): Promise<UsageEntitlementSnapshot> {
    const generatedAt = Date.now();
    const resolved = await this.resolveStartPlanAuthorization(providerId, accountAccess);
    if (!resolved) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "not_configured",
        context: { scope: "personal" },
        provider: null,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

// 先声明再赋值，是为了在 catch 里能访问已产生的 startedAt 等诊断变量；
// TypeScript 的确定赋值分析保证 throw 之后不会读到未初始化值。
    let balancePayload: ZaiStartPlanBalanceEnvelope;
    try {
// 在 try 内构造 URL：域名解析失败（如环境变量非法）也应走同一个失败日志路径，
// 否则会出现“有错误但没有请求日志”的排查盲区。
      const balanceUrl = buildZaiStartPlanBalanceUrl();
      const balanceStartedAt = Date.now();
      // billing/current 已废弃，balance 会同时返回 plans 与 balances。
      // Start Plan 快照必须只发起一次 balance 请求，避免冷启动重复请求并继续依赖旧接口。
// [失败路径] 取数异常统一记 warn 后原样抛出，保留 ApiError 的 status/headers：
// 429 需要调用方按退避处理，若在这里包装成普通 Error 会丢掉可重试语义。
// 日志里同时打 payload 与摘要：payload 供联调复现，摘要避免大数组刷爆日志。
      balancePayload = await fetchZaiStartPlanBalanceEnvelope(
        this.apiClient,
        resolved.authorization,
        invalidateBalanceCache,
      );
      log.info(undefined, "billing/balance 请求完成", {
        balanceCount: balancePayload.data?.balances?.length ?? 0,
        balances: summarizeStartPlanBalances(balancePayload.data?.balances),
        code: balancePayload.code ?? null,
        durationMs: Date.now() - balanceStartedAt,
        msg: balancePayload.msg ?? null,
        payload: balancePayload,
        planCount: balancePayload.data?.plans?.length ?? 0,
        plans: summarizeStartPlans(balancePayload.data?.plans),
        providerId,
        success: balancePayload.code === 0,
        url: balanceUrl,
      });
    } catch (error) {
// 失败日志保留 status/responseHeaders/url 三件套，供后端按 request id 对账；
// url 来自 buildZaiStartPlanBalanceUrl，只含域名与固定 path，不含用户参数。
// 记录后原样 throw，让上层决定退避，不在此处降级成空快照。
      log.warn(undefined, "billing/balance 请求失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
        responseHeaders: error instanceof ApiError ? (error.responseHeaders ?? null) : null,
        status: error instanceof ApiError ? error.status : null,
        url: buildZaiStartPlanBalanceUrl(),
      });
      // 保留 HTTP 429 等错误信息，让调用方退避并保留已确认的权益。
      throw error;
    }

// balance 的成功判据是 code===0，不能用 success 字段：该接口不返回 success。
// 业务失败必须抛错而不是返回空快照，否则会把“上游故障”显示成“没有套餐”。
    if (balancePayload.code !== 0) {
      throw new Error(balancePayload.msg || `Start Plan balance failed: ${balancePayload.code}`);
    }

// 没有 active 的 Start Plan 时返回 no_plan，并把“是否存在 expired 套餐”单独暴露，
// 让 UI 能区分“从未购买”与“已过期”，两者的引导文案完全不同。
// 此处仍返回 authenticated: true：身份有效、只是没有套餐，不能引导重新登录。
    const currentPlan = pickCurrentZaiStartPlan(balancePayload.data?.plans);
    if (!currentPlan) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "no_plan",
        startPlanExpired:
          balancePayload.data?.plans?.some((plan) => plan.status?.toLowerCase() === "expired") ??
          false,
        context: { scope: "personal" },
        provider: resolved.provider,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

// 在构造快照前做一次契约自检：无归属桶不会被任何套餐卡消费，
// 这类“数据存在但用户看不到”的问题只能靠日志暴露。
// [失败路径] warnOnUnattributedStartPlanBuckets 只写日志：无归属桶不阻断快照构造，正常数据下零输出。
    warnOnUnattributedStartPlanBuckets(
      balancePayload.data?.plans,
      readZaiStartPlanBalances(balancePayload),
    );

    return {
      generatedAt,
      authenticated: true,
      context: { scope: "personal" },
      provider: resolved.provider,
      // balance 的服务端时间与本响应的 effective_at 配对，不能用本机时钟覆盖。
      ...(typeof balancePayload.data?.server_time === "number" &&
      Number.isFinite(balancePayload.data.server_time) &&
      balancePayload.data.server_time >= 0
        ? { serverTime: balancePayload.data.server_time * 1_000 }
        : {}),
      remaining: buildZaiStartPlanRemaining(readZaiStartPlanBalances(balancePayload)),
      subscription: buildZaiStartPlanSubscription(balancePayload.data?.plans),
      quota: buildZaiStartPlanQuota(
        readZaiStartPlanBalances(balancePayload),
        balancePayload.data?.plans,
      ),
    };
  }

// 仅 planKind=start-plan 才继续；其余情况返回 null 交给调用方走 not_configured。
// [失败路径] resolveCurrent 的任何异常都收敛为 null：Start Plan 分支的“无凭据”与“取凭据失败”
// 对用户的表现都是未配置，区分它们只会制造无意义的错误页。
  private async resolveStartPlanAuthorization(
    providerId: string,
    accountAccess: ZCodeAccountAccess | undefined,
  ): Promise<{
    authorization: string;
    provider: ResolvedQuotaAuthorization["provider"];
  } | null> {
// planKind 是唯一可靠的 Start Plan 判据：provider id 可能被用户自定义覆盖，
// 用 id 判断会让改名后的账号落回 Coding Plan 分支并请求错误的接口。
// 缺失 accountAccess 时同样返回 null，由调用方给 not_configured。
    if (!accountAccess || accountAccess.planKind !== "start-plan") {
      return null;
    }
    let auth;
    try {
      auth = await this.accountRequestAuthService.resolveCurrent({
        providerId,
        accountAccess,
        reason: "usage",
      });
    } catch {
      return null;
    }
// trim 后判空是必须的：空格 Key 会被当作有效凭据发出去，得到 401 而不是 not_configured。
    const apiKey = auth.apiKey?.trim() ?? "";
// 空 Key 视为未配置，返回 null 让上层走 not_configured 引导，不抛错。
    if (!apiKey) return null;

    return {
      authorization: /^Bearer\s/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`,
      provider: {
        id: providerId,
        name: resolveAccountProviderLabel(providerId),
      },
    };
  }

// 设置页使用统计入口，与 entitlement 共享同一套凭据解析，但要求更强的收口：
// [失败路径] 解析不到凭据时直接抛 no_bigmodel_api_key，绝不回退到本地 session 聚合，
// 否则用户会看到“本地统计”冒充 Coding Plan 云端用量，两者口径不可比。
// model/tool 两个请求并行，且都不 catch：这里是显式用户操作，失败必须可见。
  async getUsageStatsSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
    const resolved = await this.resolveAuthorization({
      preferredProviderId: request.preferredProviderId,
      accountAccess: request.accountAccess,
      requirePreferredProvider: request.requirePreferredProvider === true,
      allowEnvApiKey: request.allowEnvApiKey,
    });
    if (!resolved) {
      // 设置页使用统计可被显式收口到 Coding Plan provider。
      // 严格指定 provider 时不允许回退到普通 API Key、环境变量或本地 session 聚合。
      throw new Error("no_bigmodel_api_key");
    }

// 时间窗由 range 和时间区共同决定，统一在 range 模块计算，避免两处口径漂移；
// 字符串格式固定为后端要求的 'YYYY-MM-DD HH:mm:ss'，本文件不再二次格式化。
    const { startTime, endTime } = resolveUsageTimeRange(request);
    const [modelPayload, toolPayload] = await Promise.all([
      this.fetchModelUsage(resolved, startTime, endTime),
// [并发] model 与 tool 并行：两者时间窗一致但数据源独立，串行只会拉长首屏。
      this.fetchToolUsage(resolved, startTime, endTime),
    ]);

// model 失败必须抛错：设置页的“使用统计”若静默为空，用户会以为这段时间没有调用；
// tool 失败允许为空（见下方 allowMissingData），两者的严格度不同是刻意的。
    const modelData = readSuccessfulBigModelMonitorData(
      modelPayload,
// model-usage 是必选数据面：缺 data 视为失败；tool-usage 允许缺 data（团队无工具调用），
// 这是两者的唯一差异，用 allowMissingData 显式表达，而不是让调用方自己判空。
      "BigModel model usage failed",
      EMPTY_MODEL_USAGE_PAYLOAD,
    );
// tool-usage 允许 data 缺失（团队项目无工具调用时后端会省略 data），
// 但业务错误仍需抛出，所以只放行 allowMissingData，不放行整段失败。
// 空 payload 会被 mapper 转成空工具列表，而不是让页面报错。
    const toolData = readSuccessfulBigModelMonitorData(
      toolPayload,
      "BigModel tool usage failed",
// 复用一个不可变的空对象常量，避免每次请求新建对象造成引用漂移。
      EMPTY_TOOL_USAGE_PAYLOAD,
      { allowMissingData: true },
    );

    return {
      ...buildUsageStatsSnapshotFromMonitor(request, modelData, toolData),
      sourceProvider: resolved.provider,
    };
  }

// reset status 是只读查询，但仍要求完整双重凭据（ZCode JWT + family 业务 JWT），
// 因为后端按两者联合定位用户与套餐；缺任一都在发请求前失败，避免产生 401 日志噪音。
// 返回结构把 snake_case 转成 camelCase，并保留毫秒语义（expireAt 已是毫秒时间戳）。
  async getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot> {
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/status`),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createCodingPlanResetHeaders(authorization, true),
      },
    );
// status 的 data 结构比 use/opportunity 复杂（两组数组 + 两条可空历史），
// 因此用独立 schema 严格校验；数组元素非法会让整个响应判为 invalid，
// [权衡] 这是有意的严格：重置入口宁可报错，也不能展示错误的可用次数。
    const data = readCodingPlanResetEnvelopeData(payload, codingPlanResetStatusDataSchema);
    return {
// 五小时窗口与周窗口是两个独立配额池，不能合并成一条列表：
// 合并会让 UI 无法按“短期/长期”分别提示，用户可能误以为周额度也能五小时刷新。
// 历史字段为 nullable：从未使用过重置时是 null，不是“1970 年使用过”。
      availableFiveHourResets: data.available_five_hour_resets.map((item) => ({
        expireAt: item.expire_at,
      })),
      availableWeekResets: data.available_week_resets.map((item) => ({
        expireAt: item.expire_at,
      })),
      latestFiveHourResetHistory: data.latest_five_hour_reset_history
        ? { usedAt: data.latest_five_hour_reset_history.used_at }
        : null,
      latestWeekResetHistory: data.latest_week_reset_history
        ? { usedAt: data.latest_week_reset_history.used_at }
        : null,
// 未读标记只表达“有新的重置历史”，与可用次数正交：
// 合成一个字段会让 UI 无法区分“有历史未读”和“有次数可用”。
      hasUnreadHistory: data.has_unread_history,
    };
  }

// 消耗一次重置机会，是写操作，因此先做本地幂等键校验再发请求（INV-06）。
// 长度上限 64 来自后端列宽；超长会被截断成相同前缀，导致两次点击被判为同一请求或相反。
// 响应只接受 used===true 字面量：后端若回 false 说明机会未扣减，不能向用户报成功。
  async useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 64) {
      throw new Error("coding_plan_reset_invalid_idempotency_key");
    }
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/use`),
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: {
          ...createCodingPlanResetHeaders(authorization, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          reset_type: request.resetType,
        }),
      },
    );
    const data = readCodingPlanResetEnvelopeData(payload, codingPlanResetUseDataSchema);
// 只回传 used 布尔值，不透传后端其他字段：调用方唯一需要知道的是“是否扣减成功”。
    return { used: data.used };
  }

// 申请额外重置机会：成功返回 granted，被限流返回 granted:false + nextTryAt。
// acceptedBusinessCodes 只放行 3301，其余非零业务码仍按错误抛出，避免把失败伪装成拒绝。
// [失败路径] HTTP 429 不带 3301 信封与 next_try_at，必须单独映射成 throttled，
// 让客户端写兜底冷却，而不是每 30 秒继续撞限流。
  async requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 64) {
      throw new Error("coding_plan_reset_invalid_idempotency_key");
    }
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    let payload: unknown;
    try {
      payload = await readCodingPlanResetApiJson(
        this.apiClient,
        buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/opportunity`),
        {
          method: "POST",
          timeoutMs: REQUEST_TIMEOUT_MS,
          headers: {
            ...createCodingPlanResetHeaders(authorization, true),
            "content-type": "application/json",
          },
          body: JSON.stringify({ idempotency_key: idempotencyKey }),
        },
        { acceptedBusinessCodes: [3301] },
      );
    } catch (error) {
      // 后端在请求过快/发卡锁竞争时直接回 HTTP 429，不带 3301 信封和 next_try_at。
      // 映射成稳定错误码，客户端据此写兜底冷却，避免 30 秒轮询持续撞限流。
// [权衡] 429 单独映射：后端在请求过快时不返回 3301 信封，也没有 next_try_at，
// 只能由客户端写本地冷却。若原样抛出 ApiError，调用方只能看到状态码，无法与业务拒绝区分。
      if (error instanceof ApiError && error.status === 429) {
        throw new Error("coding_plan_reset_opportunity_throttled", {
          cause: error,
        });
      }
      throw error;
    }
    const envelope = codingPlanResetEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new Error("coding_plan_reset_invalid_response");
    }
    // 3301 的 next_try_at 是服务端限流边界，必须完整透传给客户端；
    // 丢弃该字段会让 30 秒轮询持续触发资格判断，绕过后端要求的重试间隔。
// 3301 是“服务端要求稍后再试”，语义等于 granted:false 而非失败，故走正常返回路径。
// next_try_at 必须是正整数：缺失或非数说明契约破坏，宁可报 invalid_response 也不能
// 用本地默认冷却值顶替——那会让客户端按错误节奏重试。
    if (envelope.data.code === 3301) {
      const denied = codingPlanResetOpportunityDeniedDataSchema.safeParse(envelope.data.data);
      if (!denied.success) {
        throw new Error("coding_plan_reset_invalid_response");
      }
      return { granted: false, nextTryAt: denied.data.next_try_at };
    }
    const data = readCodingPlanResetEnvelopeData(
      payload,
      codingPlanResetOpportunityGrantedDataSchema,
    );
// 成功授予时 nextTryAt 必须是 null 而不是 0：0 会被当成“立即重试”的合法边界。
    return { granted: data.granted, nextTryAt: null };
  }

// 已读游标按用户共享，不按团队项目隔离，所以这里故意不发送 target scope 头；
// 若补上团队头，同一用户在两个项目下会各自维护游标，未读红点去不掉。
// 返回 void：后端不返回业务数据，读信封只为确认 code===0。
  async markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void> {
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/history/read`),
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        // history/read 使用当前 Coding Plan credential 校验身份，但按用户共享已读游标，不带 target scope。
        headers: createCodingPlanResetHeaders(authorization, false),
      },
    );
    readCodingPlanResetEnvelope(payload);
  }

// reset 需要“ZCode 身份 + 对应 family 的业务身份”两份凭据，缺一不可。
// [并发] assertCurrent 必须在读凭据之前：否则切号后可能读到新账号的 token 却配旧账号的
// accountAccess，请求会打到错误组织。
// [权衡] 这里不做跨 family 回退（见 INV-05），代价是部分用户需重新登录，收益是绝不串号。
  private async resolveCodingPlanResetAuthorization(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetAuthorization> {
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    if (!accountAccess) {
      throw new Error("coding_plan_reset_account_access_required");
    }
    await this.accountRequestAuthService.assertCurrent({
      providerId: request.preferredProviderId,
      accountAccess,
    });
    const zcodeJwt = (await this.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
    if (!zcodeJwt) {
      throw new Error("coding_plan_reset_zcode_jwt_required");
    }
    // reset 同时支持 Z.ai 与 BigModel Coding Plan。固定读取 oauth:bigmodel:access_token
    // 会让只登录 Z.ai 的用户在请求发出前失败；业务 JWT 必须跟随当前 provider family
    // 精确选择，禁止跨 family 回退。Header 仍按后端契约直传且不套 Bearer。
// [失败路径] family 缺失时无法判定该读哪把业务 JWT，只能落到 bigmodel 分支；
// 因此上游必须保证 accountAccess.family 始终存在，不能只在团队场景补齐。
    const codingPlanJwtKey =
      accountAccess.family === "zai" ? ZAI_OAUTH_ACCESS_TOKEN_KEY : BIGMODEL_OAUTH_ACCESS_TOKEN_KEY;
// 业务 JWT 只在对应 family 的 key 下取，不做跨 family 回退（见 INV-05）。
// [失败路径] credentialService 未注入时得到空串，随后抛 maas_jwt_required，
// 这比发出无鉴权请求更早暴露装配错误。
    const codingPlanJwt = (await this.credentialService?.load(codingPlanJwtKey))?.trim() ?? "";
    if (!codingPlanJwt) {
      throw new Error("coding_plan_reset_maas_jwt_required");
    }
    return {
      zcodeAuthorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
      codingPlanAuthorization: codingPlanJwt,
      teamContext: resolveTeamPlanContext(accountAccess),
    };
  }

// Coding Plan 用量面板：quota 必须成功，其余四路为可选数据面。
// requirePreferredProvider 固定 true、allowEnvApiKey 固定 false：面板身份必须来自当前账号，
// 不能用环境变量或本地聚合冒充，否则团队/个人口径会混在同一张图里。
  async getCodingPlanUsageSnapshot(
    request: CodingPlanUsageRequest,
  ): Promise<CodingPlanUsageSnapshot> {
    const resolved = await this.resolveAuthorization({
      preferredProviderId: request.preferredProviderId,
      accountAccess: request.accountAccess,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
    if (!resolved) {
      // Coding Plan 用量现在直接使用对应 Coding Plan provider 的 API Key。
      // 缺少 key 时不能回退普通 API Key、环境变量、OAuth 或本地 App Usage。
      throw new Error(resolveCodingPlanApiKeyError(request.preferredProviderId));
    }

// [权衡] monitor 请求不做“全有全无”：quota 传输失败整体失败，业务失败降级为 null；
// activity/detail/health 传输失败只清空各自区域并记 warn。任一路故障都不能拖垮整张面板，
// 但 HTTP 200 + 业务错误（如 token expired）仍会抛错——鉴权问题必须可见，不能伪装成空用量。
// xTime 与 granularity 由同一函数算出，保证四条曲线共用同一条时间轴。
    const usageRange = resolveCodingPlanUsageTimeRange(request);
    // monitor 请求不能全有全无。quota 保持原有必须成功语义
    // （传输失败时整体失败，业务失败降级为 quota: null）；activity / detail / health
    // 是可选数据面，传输失败只清空对应区域并记 warn，任一路故障不能拖垮整张面板。
    const [quotaPayload, activityData, modelDetailData, toolDetailData, health7dData] =
      await Promise.all([
// [并发] quota 不做 catch：传输失败要整体失败，业务失败再降级为 null（见下方判定）。
        this.fetchQuota(resolved),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageActivity(resolved, request.timeZone),
          "BigModel activity usage failed",
          EMPTY_CREDIT_ACTIVITY_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageDetail(resolved, usageRange.startTime, usageRange.endTime, "MODEL"),
          "BigModel model usage detail failed",
          EMPTY_CREDIT_DETAIL_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchCreditUsageDetail(resolved, usageRange.startTime, usageRange.endTime, "MCP"),
          "BigModel tool usage detail failed",
          EMPTY_CREDIT_DETAIL_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          this.fetchModelPerformanceDay(resolved, request.timeZone, "7d"),
          "BigModel model performance failed",
          EMPTY_MODEL_PERFORMANCE_PAYLOAD,
        ),
      ]);

// quota 先判信封成功再判 data 存在：code=200 但 data 缺失说明后端异常，按失败处理；
// 成功且 data 存在时才归一化 limits，空 limits 保留为空数组表示“无任何限额”。
    const quota =
      isSuccessfulBigModelEnvelope(quotaPayload) && quotaPayload.data
        ? {
            level: quotaPayload.data.level?.trim() || null,
            limits: normalizeLimits(quotaPayload.data.limits),
          }
        : null;

    return buildCodingPlanUsageSnapshotFromMonitor({
      request,
      provider: resolved.provider,
// 把归一化后的 quota 原样交给 mapper，避免在组装处二次解释字段。
      quota,
      granularity: usageRange.granularity,
      xTime: usageRange.xTime,
      startDateKey: usageRange.startDateKey,
      endDateKey: usageRange.endDateKey,
      activityData,
      modelDetailData,
      toolDetailData,
      healthData: health7dData,
    });
  }

// 普通 TPS 健康检查返回单个数值，取不到时返回 undefined 而不是 0：
// 0 会被 UI 当成“速度为零”的严重告警，undefined 才表示“没有样本”。
  async getCodingPlanRegularTps(
    request: CodingPlanRegularTpsRequest,
  ): Promise<number | undefined> {
    const startedAt = Date.now();
    let requestUrl: string | undefined;
    let responseHeaders: Record<string, string> = {};
    let responseStatus: number | undefined;
    let responseStatusText: string | undefined;
    let responseCode: number | undefined;
    try {
      const resolved = await this.resolveAuthorization({
        preferredProviderId: request.preferredProviderId,
        accountAccess: request.accountAccess,
        requirePreferredProvider: true,
        allowEnvApiKey: false,
      });
      if (!resolved) throw new Error(resolveCodingPlanApiKeyError(request.preferredProviderId));

// 固定取 7 天窗口：TPS 曲线只用于判断近期是否劣化，窗口过长会被历史正常值稀释。
      const timeRange = resolveModelPerformanceTimeRange(request.timeZone, "7d");
      requestUrl = buildModelPerformanceMonitorUrl(
        resolved,
        timeRange.startTime,
        timeRange.endTime,
      );
      const response = await this.apiClient.request(requestUrl, {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      });
// HTTP 失败优先于解析失败：即使 body 不是 JSON，也应以状态码和 message 为主错误，
// 把 parseError 作为 cause 保留，便于区分“网关返回 HTML”与“业务返回坏 JSON”。
      responseStatus = response.status;
      responseStatusText = response.statusText;
      responseHeaders = readApiDiagnosticHeaders(response.headers) ?? {};
// [失败路径] 先单独解析 JSON 再判 HTTP 状态：4xx/5xx 也可能带回业务 message，
// 丢了 envelope 就只能给用户一个裸状态码。parseError 另存，避免与状态错误混淆。
// responseCode 只在解析出数字时记录，供日志对账；解析失败时保持 undefined。
      let payload: BigModelUsageModelPerformanceEnvelope | undefined;
      let parseError: unknown;
      try {
        payload = JSON.parse(await response.text()) as BigModelUsageModelPerformanceEnvelope;
        responseCode = typeof payload.code === "number" ? payload.code : undefined;
      } catch (error) {
        parseError = error;
      }
      if (!response.ok) {
        throw new ApiError({
          message: readApiErrorMessage(payload, `HTTP ${response.status}`),
          url: requestUrl,
          method: "GET",
          status: response.status,
          responseHeaders,
          cause: parseError,
        });
      }
      if (parseError !== undefined || payload === undefined) {
        throw new ApiError({
          message: parseError instanceof Error ? parseError.message : "Invalid JSON response",
          url: requestUrl,
          method: "GET",
          status: response.status,
          responseHeaders,
          cause: parseError,
        });
      }
      const data = readSuccessfulBigModelMonitorData<BigModelUsageModelPerformancePayload>(
        payload,
        "BigModel model performance failed",
        EMPTY_MODEL_PERFORMANCE_PAYLOAD,
        { allowMissingData: true },
      );
// [权衡] 取最后一个 >0 的有限值而不是平均值：窗口末尾的最新样本最能反映当前健康度，
// 平均值会把故障前的正常样本混进来，掩盖正在发生的降速。
// 全为 0/NaN 时返回 undefined，明确表达“无有效样本”，不伪造 0 TPS。
      return data.proMaxDecodeSpeed?.findLast(
        (value) => Number.isFinite(value) && value > 0,
      );
    } catch (error) {
      // Bug 原因：Highspeed 仅在 Renderer 记录了 TPS 读取失败文案，Host 层丢失了
      // monitor 的 HTTP status 和 request id，无法与后端日志对账。只输出 ApiError 中的安全诊断头。
      log.warn(undefined, "Highspeed 普通 TPS 健康检查失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId: request.preferredProviderId,
        durationMs: Date.now() - startedAt,
        status: error instanceof ApiError ? error.status : (responseStatus ?? null),
        statusText: responseStatusText ?? null,
        responseCode: responseCode ?? null,
        responseHeaders:
          error instanceof ApiError ? (error.responseHeaders ?? responseHeaders) : responseHeaders,
        url: sanitizeMonitorDiagnosticUrl(error instanceof ApiError ? error.url : requestUrl),
      });
      throw error;
    }
  }

// [失败路径] 凭据优先级：环境变量（仅非严格模式）→ Coding Plan 账号 Key → 注入的
// resolveApiAuthorization。顺序不可颠倒，否则本地联调的环境变量会覆盖真实账号身份。
// 返回 null 表示“没有可用身份”，由调用方决定是抛错还是降级，本函数不自行抛错。
  private async resolveAuthorization(
    request: {
      preferredProviderId?: string;
      accountAccess?: UsageEntitlementRequest["accountAccess"];
      requirePreferredProvider?: boolean;
      allowEnvApiKey?: boolean;
    } = {},
  ): Promise<ResolvedQuotaAuthorization | null> {
// [权衡] 环境变量通道只在“未指定 provider 且未要求严格 provider”时开放：
// 设置页可借此在无账号环境跑通，但 Coding Plan 面板会传 allowEnvApiKey:false 显式关闭，
// 以防止把本地 Key 的额度当成账号套餐额度展示。
// teamContext 恒为 null：环境变量没有组织/项目概念，不能伪造团队上下文。
    if (request.allowEnvApiKey !== false && request.requirePreferredProvider !== true) {
      const envApiKey =
        readEnv(this.env, "ZCODE_BIGMODEL_USAGE_API_KEY") ??
        readEnv(this.env, "BIGMODEL_USAGE_API_KEY");
      if (envApiKey) {
        return {
          authorization: envApiKey,
          quotaUrl: resolveQuotaUrlFromEnv(this.env) ?? buildBigModelQuotaUrl(this.env),
          teamContext: null,
          provider: {
            id: "env:bigmodel-usage",
            name: "BigModel",
          },
        };
      }
    }

    const providerId = request.preferredProviderId?.trim() ?? "";
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    if (providerId && isCodingPlanModelProviderId(providerId)) {
      if (!accountAccess) return null;
      const auth = await this.accountRequestAuthService.resolveCurrent({
        providerId,
        accountAccess,
        reason: "usage",
      });
      const authorization = auth.apiKey?.trim() ?? "";
      if (!authorization) return null;
      return {
        authorization,
        quotaUrl:
          resolveQuotaUrlFromEnv(this.env) ?? resolveAccountProviderQuotaUrl(providerId, this.env),
        teamContext: resolveTeamPlanContext(accountAccess),
        provider: {
          id: providerId,
          name: resolveAccountProviderLabel(providerId),
        },
      };
    }

// 账号体系未注入时返回 null（可选链），这是合法装配而非异常；
// 注入时由宿主决定使用哪把 token，本文件不感知其内部策略。
    const apiAuthorization = await this.resolveApiAuthorization?.({
      preferredProviderId: providerId || undefined,
      requirePreferredProvider: request.requirePreferredProvider === true,
    });
    return apiAuthorization ? { ...apiAuthorization, teamContext: null } : null;
  }

// quota/limit 是唯一同时被 entitlement 与用量面板依赖的接口；
// 这里只负责取数，成功/失败语义由调用方按各自场景判定。
  private async fetchQuota(
    resolved: ResolvedQuotaAuthorization,
  ): Promise<BigModelUsageQuotaEnvelope> {
    return readApiJson<BigModelUsageQuotaEnvelope>(this.apiClient, buildQuotaLimitUrl(resolved), {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    });
  }

// model-usage 与 tool-usage 共用基址构造函数，仅 endpoint 与返回类型不同；
// 本层不做业务判定，成功/失败由 readSuccessfulBigModelMonitorData 统一裁决。
  private async fetchModelUsage(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
  ): Promise<BigModelUsageModelUsageEnvelope> {
    return readApiJson<BigModelUsageModelUsageEnvelope>(
      this.apiClient,
      buildUsageMonitorUrl(resolved, "model-usage", startTime, endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

// tool-usage 在团队无调用时可能省略 data，因此调用方必须传 allowMissingData。
  private async fetchToolUsage(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
  ): Promise<BigModelUsageToolUsageEnvelope> {
    return readApiJson<BigModelUsageToolUsageEnvelope>(
      this.apiClient,
      buildUsageMonitorUrl(resolved, "tool-usage", startTime, endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

// activity 的时间窗固定 365 天且由本函数内部计算，调用方只传时区，
// 防止上层用请求 range 覆盖，导致热力图与 quota 周期错位。
  private async fetchCreditUsageActivity(
    resolved: ResolvedQuotaAuthorization,
    timeZone: string | undefined,
  ): Promise<BigModelCreditUsageActivityEnvelope> {
    const range = resolveCreditUsageActivityTimeRange(timeZone);
    return readApiJson<BigModelCreditUsageActivityEnvelope>(
      this.apiClient,
      buildCreditUsageMonitorUrl(resolved, "activity", range.startTime, range.endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

// usageType 区分 MODEL/MCP 两次调用，后端不接受一次返回合并结果；
// 两次请求共用时间窗，确保模型与工具的图例在时间维度上可对比。
  private async fetchCreditUsageDetail(
    resolved: ResolvedQuotaAuthorization,
    startTime: string,
    endTime: string,
    usageType: "MODEL" | "MCP",
  ): Promise<BigModelCreditUsageDetailEnvelope> {
    return readApiJson<BigModelCreditUsageDetailEnvelope>(
      this.apiClient,
      buildCreditUsageMonitorUrl(resolved, "usage-detail", startTime, endTime, usageType),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }

// range 只允许 7d/30d，与后端既有的两个聚合粒度一一对应；
// 传其他值会被后端拒绝，所以在类型层面就收窄。
  private async fetchModelPerformanceDay(
    resolved: ResolvedQuotaAuthorization,
    timeZone: string | undefined,
    range: "7d" | "30d",
  ): Promise<BigModelUsageModelPerformanceEnvelope> {
    const timeRange = resolveModelPerformanceTimeRange(timeZone, range);
    return readApiJson<BigModelUsageModelPerformanceEnvelope>(
      this.apiClient,
      buildModelPerformanceMonitorUrl(resolved, timeRange.startTime, timeRange.endTime),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      },
    );
  }
}

// reset 的鉴权头与 monitor 完全不同：Authorization 是 ZCode JWT，
// X-Bigmodel-Authorization 才是业务 JWT，且两者都不加 Bearer 前缀（zcode 侧已在上游补好）。
// includeTargetScope 为 false 时只带身份不带目标：已读游标按用户共享（见 markCodingPlanResetHistoryRead）。
// [权衡] 团队头只在有 teamContext 时出现，个人请求不能带空的组织/项目头，
// 否则后端会按“组织为空”判为非法请求。
function createCodingPlanResetHeaders(
  authorization: CodingPlanResetAuthorization,
  includeTargetScope: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: authorization.zcodeAuthorization,
    "X-Bigmodel-Authorization": authorization.codingPlanAuthorization,
  };
  if (!includeTargetScope) {
    return headers;
  }
// target-type 决定后端在团队池与个人池之间选择，缺省时按个人处理；
// 团队身份漏传该头会读到个人额度，且不会报错，是最难发现的一类串号。
  headers["Bigmodel-Target-Type"] = authorization.teamContext ? "TEAM" : "PERSONAL";
  if (authorization.teamContext) {
    headers["Bigmodel-Organization"] = authorization.teamContext.organizationId;
    headers["Bigmodel-Project"] = authorization.teamContext.projectId;
  }
  return headers;
}

// 错误文案按 error → message → msg → detail 的顺序取第一个非空字符串：
// 不同后端接口用的键不同，顺序固定是为了同一类故障始终产出同一条文案，便于日志聚合。
// 全部缺失时用调用方的 fallback（通常是 HTTP 状态），不能返回空串。
function readApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["error", "message", "msg", "detail"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

// 只摘三个排障用的追踪头，且逐个 trim 后判空：
// 空字符串头等于没有，写进日志会让人误以为存在但丢失了值。
// 一个都没有时返回 undefined，保证日志里不会出现空对象噪音。
function readApiDiagnosticHeaders(headers: Headers): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const name of ["x-request-id", "x-trace-id", "x-span-id"] as const) {
    const value = headers.get(name)?.trim();
    if (value) {
      result[name] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// 联调对账后缀：envelope 业务错误（如 2007 依赖失败）需要把后端 x-request-id
// 带进错误 message，RPC 日志和 UI warn 才能与后端日志按请求 id 精确对上。
// 仅用于日志定位，客户端不做分支；缺失时返回空串保持原 message 契约。
function readCodingPlanResetErrorDiagnostics(headers: Headers): string {
  const requestId = headers.get("x-request-id")?.trim();
  return requestId ? ` (x-request-id:${requestId})` : "";
}

async function readCodingPlanResetApiJson(
  apiClient: ApiClient,
  input: string,
  init: ApiRequestInit,
  options: { acceptedBusinessCodes?: readonly number[] } = {},
): Promise<unknown> {
// [失败路径] 与 monitor 的读取顺序相反：reset 必须“先读信封 code，再看 HTTP 状态”。
// 后端在 HTTP 4xx 时仍用统一信封返回稳定业务码，先抛 HTTP 错误会丢掉可分支的 code。
// acceptedBusinessCodes 内的 code 视为成功返回原始 payload，交给调用方按语义处理（如 3301）。
// 业务错误 message 带 x-request-id，保证 RPC 日志能与后端日志按请求对账。
  const response = await apiClient.request(input, init);
  let payload: unknown;
  let parseError: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    parseError = error;
  }

  // reset 后端在 HTTP 4xx 时仍通过统一 envelope 返回稳定业务 code。
  // 必须先读取 code，不能把易变的 msg 当成客户端分支依据。
  const envelope = codingPlanResetEnvelopeSchema.safeParse(payload);
  if (envelope.success && envelope.data.code !== 0) {
    if (options.acceptedBusinessCodes?.includes(envelope.data.code)) {
      return payload;
    }
    throw new Error(
      `coding_plan_reset_api_error:${envelope.data.code}${readCodingPlanResetErrorDiagnostics(response.headers)}`,
    );
  }

  if (!response.ok) {
    throw new ApiError({
      message: readApiErrorMessage(payload, `HTTP ${response.status}`),
      url: input,
      method: init.method,
      status: response.status,
      responseHeaders: readApiDiagnosticHeaders(response.headers),
      cause: parseError,
    });
  }
  if (parseError !== undefined) {
    throw new Error("coding_plan_reset_invalid_response", {
      cause: parseError,
    });
  }
  return payload;
}

// 严格信封校验：结构不符与 code 非零都归为同一类错误，调用方无需区分；
// 但错误文案区分 invalid_response 与 api_error:code，便于日志统计后端故障类型。
function readCodingPlanResetEnvelope(
  payload: unknown,
): z.infer<typeof codingPlanResetEnvelopeSchema> {
  const result = codingPlanResetEnvelopeSchema.safeParse(payload);
  if (!result.success) {
    throw new Error("coding_plan_reset_invalid_response");
  }
  if (result.data.code !== 0) {
    throw new Error(`coding_plan_reset_api_error:${result.data.code}`);
  }
  return result.data;
}

// 先校验信封再校验 data：顺序反了会用“data 不合法”掩盖真正的业务错误码。
// 泛型保留 schema 的推断类型，避免各处手写响应接口与 schema 漂移。
function readCodingPlanResetEnvelopeData<TSchema extends z.ZodType>(
  payload: unknown,
  schema: TSchema,
): z.infer<TSchema> {
  const envelope = readCodingPlanResetEnvelope(payload);
  const result = schema.safeParse(envelope.data);
  if (!result.success) {
    throw new Error("coding_plan_reset_invalid_response");
  }
  return result.data;
}

function resolveTeamPlanContext(accountAccess: ZCodeAccountAccess): TeamPlanContext | null {
  return accountAccess.planKind === "team-coding-plan"
    ? {
        organizationId: accountAccess.organizationId,
        projectId: accountAccess.projectId,
        family: accountAccess.family,
      }
    : null;
}

// 无凭据时也要给出可信 context：只能依据请求里的 accountAccess 推断团队范围，
// 不能用“默认个人”掩盖团队身份，否则未登录的团队成员会看到个人 scope。
function buildUsageEntitlementContextFromRequest(
  request: Pick<UsageEntitlementRequest, "accountAccess">,
): UsageEntitlementSnapshot["context"] {
  if (
    !request.accountAccess ||
    !("planKind" in request.accountAccess) ||
    request.accountAccess.planKind !== "team-coding-plan"
  ) {
    return { scope: "personal" };
  }
  return {
    scope: "team",
    organizationId: request.accountAccess.organizationId,
    projectId: request.accountAccess.projectId,
  };
}

// 有凭据时根据 teamContext 判定 scope，并顺带把套餐的 productId/displayName 挂到 context；
// 这两项取 details[0]：订阅接口按重要性排序，首条即当前主套餐。
// [权衡] productName 缺失时用 null 而不是空串，让 UI 能区分“无名称”与“空名称”。
function buildUsageEntitlementContext(
  resolved: ResolvedQuotaAuthorization,
  subscription: UsageEntitlementSnapshot["subscription"],
): UsageEntitlementSnapshot["context"] {
  if (!resolved.teamContext) {
    return {
      scope: "personal",
      productId: subscription?.details[0]?.productId || null,
      displayName: subscription?.details[0]?.productName || null,
    };
  }
  return {
    scope: "team",
    organizationId: resolved.teamContext.organizationId,
    projectId: resolved.teamContext.projectId,
    productId: subscription?.details[0]?.productId || null,
    displayName: subscription?.details[0]?.productName || null,
  };
}

// monitor 的 authorization 必须原样透传完整凭据，不能补 Bearer：
// 该接口同时接受环境变量 Key 与 Coding Plan API Key，两者的前缀规则由调用方决定。
// 团队头按组织和项目隔离余额；只带 provider id 会固定读默认项目，多团队时数据错位。
function createBigModelUsageHeaders(resolved: ResolvedQuotaAuthorization): Record<string, string> {
  const headers: Record<string, string> = {
    // monitor 接口要求 authorization 直接传完整凭据。
    // 普通用量和 Coding Plan 用量都走 API Key，不能额外加 Bearer 前缀。
    authorization: resolved.authorization,
  };
  if (resolved.teamContext) {
    // Team Plan 的 quota / usage 按组织和项目隔离。
    // 只用 provider id 会固定读取默认项目，多个团队时余额会和当前选择不一致。
    headers["bigmodel-organization"] = resolved.teamContext.organizationId;
    headers["bigmodel-project"] = resolved.teamContext.projectId;
  }
  return headers;
}

// [失败路径] 团队额度必须加 type=2：只换 Key 和 header 仍会命中个人 Coding Plan 分支，
// 后端会返回“当前用户不存在 coding plan”，看起来像权限问题，实际是路由参数缺失。
// 用 URL API 修改而不是字符串拼接，避免 quotaUrl 自带 query 时拼出两个问号。
function buildQuotaLimitUrl(resolved: ResolvedQuotaAuthorization): string {
  if (!resolved.teamContext) {
    return resolved.quotaUrl;
  }

  // BigModel Team Plan 的 quota/limit 后端按 type=2 路由到团队套餐。
  // 只切换团队项目 key/header 仍会走个人 Coding Plan 分支并返回“当前用户不存在 coding plan”。
  const url = new URL(resolved.quotaUrl);
  url.searchParams.set("type", "2");
  return url.toString();
}

// 三类失败必须区分：信封不成功 → 抛业务 message；data 缺失且不允许 → 抛 fallback；
// data 缺失但允许且存在显式成功信号 → 返回空的不可变占位对象。
// “显式成功”限定 success=true 或 code 0/200，避免把 {} 这类无信号响应当成功。
function readSuccessfulBigModelMonitorData<TData extends object>(
  payload: {
    code?: number;
    message?: string;
    msg?: string;
    success?: boolean;
    data?: TData | null;
  },
  fallbackMessage: string,
  emptyData: TData,
  options: { allowMissingData?: boolean } = {},
): TData {
  if (!isSuccessfulBigModelEnvelope(payload)) {
    throw new Error(readBigModelEnvelopeMessage(payload) || fallbackMessage);
  }
  if (payload.data) {
    return payload.data;
  }
  if (options.allowMissingData === true && hasExplicitBigModelSuccessSignal(payload)) {
    // BigModel monitor 的 tool-usage 在团队项目无工具调用时会返回
    // code=200、msg=“操作成功”但省略 data。空用量应显示为空统计，不能中断整个统计页。
    return emptyData;
  }
  throw new Error(readBigModelEnvelopeMessage(payload) || fallbackMessage);
}

// credit-usage/activity、usage-detail、model-performance-day 是可选数据面。
// 传输层失败（HTTP 非 2xx、超时、断网）时只清空对应区域并记 warn，不能让
// Promise.all 提前 reject 拖垮整张 Coding Plan Usage 面板。HTTP 200 但业务信封失败
// （如 token expired）仍由 readSuccessfulBigModelMonitorData 抛错：鉴权/后端错误必须
// 显式暴露给用户，不能伪装成空用量（既有测试已锁定该语义）。
async function readBestEffortBigModelMonitorData<TData extends object>(
  request: Promise<{
    code?: number;
    message?: string;
    msg?: string;
    success?: boolean;
    data?: TData | null;
  }>,
  fallbackMessage: string,
  emptyData: TData,
): Promise<TData> {
// [失败路径] 这里只吞“传输层”异常（超时、断网、非 2xx）；HTTP 200 的业务错误仍会由
// readSuccessfulBigModelMonitorData 抛出，保证鉴权失败不会被降级成空图表。
// 降级时记 warn 并带上 ApiError.status，便于区分是后端故障还是用户网络问题。
  let payload: Awaited<typeof request> | null = null;
  try {
    payload = await request;
  } catch (error) {
    log.warn(undefined, `${fallbackMessage}，该区域降级为空统计`, {
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof ApiError ? error.status : null,
    });
    return emptyData;
  }
  return readSuccessfulBigModelMonitorData(payload, fallbackMessage, emptyData, {
    allowMissingData: true,
  });
}

// msg 优先于 message：monitor 系接口用 msg，老接口用 message，两者同时存在时以 msg 为准。
function readBigModelEnvelopeMessage(payload: { message?: string; msg?: string }): string {
  return payload.msg?.trim() || payload.message?.trim() || "";
}

// 只保留 origin 与 pathname，丢弃 query：query 里含组织/项目/时间窗，属于账号结构信息。
// 解析失败返回固定占位符，绝不回显原始字符串——原始串可能本身就带敏感参数。
function sanitizeMonitorDiagnosticUrl(url: string | undefined): string {
  if (!url) return "<unknown-monitor-url>";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-monitor-url>";
  }
}

// 只有 success=true 或 code 为 0/200 才算“后端明确说成功”，
// 用于允许 data 缺失的场景；没有信号时仍按失败处理，防止把空响应当空用量。
function hasExplicitBigModelSuccessSignal(payload: { code?: number; success?: boolean }): boolean {
  return payload.success === true || payload.code === 0 || payload.code === 200;
}

// 成功判据必须同时容忍 code=0 与 code=200：monitor/quota 两套后端口径不同，
// 只认 200 会把团队用量的成功包误判为失败。success===false 是显式否定，优先级最高。
// code 缺失视为成功：部分接口只回 data，没有 code 字段。
function isSuccessfulBigModelEnvelope(payload: { code?: number; success?: boolean }): boolean {
  const code = payload.code;
  // BigModel monitor/quota 后端存在 code=0 且 msg=“操作成功”的成功响应。
  // 只按 code=200 判断会把团队用量统计的成功包误抛成错误，导致设置页显示无法读取统计。
  return (
    payload.success !== false && (code === undefined || code === null || code === 0 || code === 200)
  );
}

// 订阅摘要转统一结构：identityType 固定 unknown，因为该接口不返回身份类型；
// purchaseTime/beginTime 置 null 而不是用 renewTime 顶替，避免 UI 展示错误的购买时间。
function buildSubscriptionSnapshot(summary: {
  productId: string;
  productName: string;
  billingCycle: string | null;
  renewTime: string | null;
  expireTime: string | null;
}): UsageEntitlementSnapshot["subscription"] {
  return {
    identityType: "unknown",
    identityMasked: null,
    details: [{ ...summary, purchaseTime: null, beginTime: null }],
  };
}

// 只把 active 套餐写进 subscription：expired/pending 出现在卡片上会误导用户以为仍可用。
// productId 缺失时回空串而非丢弃整条：套餐卡仍需展示名称与到期时间。
// renewTime 恒为 null，续期语义由每个 limit 的 nextResetTime 与 expireTime 分担。
function buildZaiStartPlanSubscription(
  plans: ZaiStartPlanPlan[] | undefined,
): UsageEntitlementSnapshot["subscription"] {
  const activePlans = (plans ?? []).filter(
    (plan) => readNonEmptyString(plan.status)?.toLowerCase() === "active",
  );
  return {
    identityType: "unknown",
    identityMasked: null,
    details: activePlans.map((plan) => ({
      productId: readNonEmptyString(plan.plan_id) ?? "",
      productName: readNonEmptyString(plan.name) ?? "编程套餐",
      purchaseTime: null,
      beginTime: formatUnixSecondsAsIso(plan.starts_at),
      billingCycle: pickZaiStartPlanBillingCycle(plan),
      // Start Plan 卡片不展示套餐级续期时间：额度桶刷新时间由每个 limit 的
      // nextResetTime（balance.expires_at）表达，套餐到期由 expireTime（ends_at）表达。
      renewTime: null,
      expireTime: formatUnixSecondsAsIso(plan.ends_at),
      entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
        const entitlementId = readNonEmptyString(entitlement.entitlement_id);
        if (!entitlementId) return [];
        return [
          {
            entitlementId,
            showName: readNonEmptyString(entitlement.show_name),
            effectiveTime: formatUnixSecondsAsIso(entitlement.effective_at),
          },
        ];
      }),
    })),
  };
}

/**
 * tripwire：服务端契约保证 balances 只属于 active plans、每个桶都能按
 * plan_id 归属到套餐卡。出现无归属桶（含缺失 plan_id 的桶）说明契约被破坏——
 * 设置页多卡路径会静默丢弃这些桶，必须在 provider 层显式暴露，避免「额度去哪了」
 * 类问题无迹可查。正常数据下此日志零输出，用 warn 保证生产环境可见。
 */
function warnOnUnattributedStartPlanBuckets(
  plans: ZaiStartPlanPlan[] | undefined,
  balances: ZaiStartPlanBalance[] | undefined,
): void {
// tripwire 只做观测、不改变返回值：无归属桶说明后端契约被破坏，
// 设置页多卡路径会静默丢弃它们，必须在 provider 层留痕，否则“额度去哪了”无迹可查。
  const activePlanIds = new Set(
    (plans ?? [])
      .filter((plan) => readNonEmptyString(plan.status)?.toLowerCase() === "active")
      .map((plan) => readNonEmptyString(plan.plan_id))
      .filter((planId): planId is string => Boolean(planId)),
  );
// 缺 plan_id 的桶同样算无归属：后端契约要求每个桶都带 plan_id，
// 缺失说明数据被裁剪或版本不匹配，下游会静默丢弃。
  const orphanBuckets = (balances ?? []).filter((balance) => {
    const planId = readNonEmptyString(balance.plan_id);
    return !planId || !activePlanIds.has(planId);
  });
  if (orphanBuckets.length === 0) {
    return;
  }
  log.warn(undefined, "billing/balance 返回无法归属到 active 套餐的额度桶", {
    orphanCount: orphanBuckets.length,
    orphanPlanIds: orphanBuckets.map((balance) => balance.plan_id ?? null),
    activePlanIds: [...activePlanIds],
  });
}

// remaining 是跨桶聚合值：分子分母必须来自同一批 limit，混用会导致百分比失真。
// nextResetTime 取最近的一次重置（升序第一个），因为用户最关心“什么时候能回血”。
// 没有 limit 时返回 null 而不是 {count:0}：0 会被渲染成“额度已用尽”。
function buildZaiStartPlanRemaining(
  balances: ZaiStartPlanBalance[] | undefined,
): UsageEntitlementSnapshot["remaining"] {
  const limits = normalizeZaiStartPlanBalanceLimits(balances);
  if (limits.length === 0) {
    return null;
  }

// [权衡] 用 total>0 才给 percentage：total 为 0 时任何除法都无意义，
// 给 undefined 让 UI 隐藏进度条，比显示 0% 或 100% 更诚实。
  const total = limits.reduce((sum, limit) => sum + (limit.number ?? 0), 0);
  const remaining = limits.reduce((sum, limit) => sum + (limit.remaining ?? 0), 0);
  return {
    count: remaining,
    isShow: true,
    percentage: total > 0 ? remaining / total : undefined,
    nextResetTime:
      limits
        .map((limit) => limit.nextResetTime)
        .filter((value): value is number => typeof value === "number")
        .sort((left, right) => left - right)[0] ?? null,
  };
}

function buildZaiStartPlanQuota(
  balances: ZaiStartPlanBalance[] | undefined,
  plans?: ZaiStartPlanPlan[],
): UsageEntitlementSnapshot["quota"] {
  const limits = normalizeZaiStartPlanBalanceLimits(balances, plans);
  if (limits.length === 0) {
    return null;
  }

  return {
    level: "Start",
    limits,
  };
}

// 单个桶的归一化是单位与语义最容易出错的地方，逐项说明：
// total/used/remaining 允许字符串数字（后端部分字段是 string），全部走 parseNumber；
// 三者全无效则丢弃该桶——没有可展示数字的桶只会产生空白卡片；
// 其余时间字段一律由秒转毫秒出口，见 INV-04。
function normalizeZaiStartPlanBalanceLimits(
  balances: ZaiStartPlanBalance[] | undefined,
  plans?: ZaiStartPlanPlan[],
): UsageQuotaLimit[] {
// 非数组视为“没有额度桶”，返回空数组让上层把 remaining/quota 置 null；
// 抛错会把“套餐未开通额度”渲染成加载失败。
  if (!Array.isArray(balances)) {
    return [];
  }

  return balances
    .map((balance) => {
      const total = parseNumber(balance.total_units);
      const used = parseNumber(balance.used_units);
      // Start Plan 余额卡必须展示后端给出的 remaining_units。
      // available_units 会再扣除进行中请求的 reserved_units，不能作为“剩余”兜底。
      const remaining = parseNumber(balance.remaining_units);
// 三个核心数字全缺失才丢弃该桶；只要有一个可展示就保留，
// 因为部分套餐只下发 used_units，丢弃会导致用户看不到已用量。
      if (total === null && used === null && remaining === null) {
        return null;
      }
      // 额度桶的真实重置边界由 balance.expires_at 表达；服务端契约保证每个桶都带该字段。
// 每个额度桶各自有独立重置边界，不能取所有桶的最大/最小值统一展示：
// 五小时桶与周桶的重置时刻不同，合并会让用户错过最近一次可回血时间。
      const nextResetSeconds = parseUnixSeconds(balance.expires_at);
// capabilities 既用于 usageDetails 的模型列表，也在 entitlement_id 缺失时兜底为 type；
// 因此必须先去掉 'model:' 前缀并过滤空白，否则图例会显示成 model:glm-4。
// plan 通过 user_plan_id 优先匹配：同一 plan_id 可能被用户重复购买，只有 user 级 id 唯一。
      const capabilityLabels = normalizeZaiStartPlanCapabilities(balance.capabilities);
      const capabilityType = readNonEmptyString(capabilityLabels.join(", "));
      const displayName = readNonEmptyString(balance.show_name);
      const planId = readNonEmptyString(balance.plan_id);
      const userPlanId = readNonEmptyString(balance.user_plan_id);
// [权衡] 匹配失败时 period 为 undefined 而不是报错：周期只影响展示文案，
// 缺失不应让整张额度卡消失。
      const plan = plans?.find((candidate) =>
        userPlanId && candidate.user_plan_id
          ? candidate.user_plan_id === userPlanId
          : candidate.plan_id === planId,
      );
      const period = plan?.entitlements?.find(
        (entry) => entry.entitlement_id === balance.entitlement_id,
      )?.period;
// 周期起止与 nextResetTime 是两种不同语义：前者描述账期，后者描述额度桶刷新；
// 混用会让“本周期已用”与“下次刷新”两处文案互相矛盾。
      const periodStart = parseUnixSeconds(balance.period_start);
      const periodEnd = parseUnixSeconds(balance.period_end);

      return {
        // 旧映射丢弃 bucket 和周期字段，Renderer 只能用变化的余额去重，导致反复提醒。
        bucketId: readNonEmptyString(balance.bucket_id) ?? undefined,
        userPlanId: userPlanId ?? undefined,
        periodStart: periodStart === null ? undefined : periodStart * 1000,
        periodEnd: periodEnd === null ? undefined : periodEnd * 1000,
        period: readNonEmptyString(period) ?? undefined,
        meter: readNonEmptyString(balance.meter) ?? undefined,
        unitType: readNonEmptyString(balance.unit_type) ?? undefined,
        type:
          readNonEmptyString(balance.entitlement_id) ??
          capabilityType ??
          readNonEmptyString(balance.meter) ??
          "model_usage",
        // planId 用于设置页按套餐卡片分组额度桶；服务端契约保证每个桶都携带 plan_id。
        ...(planId ? { planId } : {}),
        unit: total ?? undefined,
        number: total ?? undefined,
        usage: used ?? undefined,
        currentValue: used ?? undefined,
        remaining: remaining ?? undefined,
        percentage:
          total !== null && remaining !== null && total > 0 ? remaining / total : undefined,
        nextResetTime: nextResetSeconds === null ? undefined : nextResetSeconds * 1000,
        usageDetails: capabilityLabels.map((modelCode) => ({
          modelCode,
          // 两个 Start Plan 的 Today's balance 接口已经返回面向用户的 show_name。
          // 继续从 capabilities 推导会把 GLM-5-Turbo 显示成 GLM-5Turbo，并且丢失服务端名称语义。
          ...(displayName ? { displayName } : {}),
// usageDetails 是模型级明细，缺 used 时补 0 而不是 undefined：
// 该结构用于渲染每个模型的用量条，undefined 会产生 NaN 宽度。
          usage: used ?? 0,
        })),
      };
    })
    .filter((limit): limit is NonNullable<typeof limit> => limit !== null);
}

// 非数组一律当空数组：上游偶尔把单值字符串塞进本应是数组的字段。
function normalizeZaiStartPlanCapabilities(capabilities: string[] | undefined): string[] {
  if (!Array.isArray(capabilities)) {
    return [];
  }

  return capabilities
    .map((capability) =>
      capability.startsWith("model:") ? capability.slice("model:".length) : capability,
    )
    .filter((capability) => capability.trim().length > 0);
}

// 额度字段可能是 number 或数字字符串，空串/空白必须视为缺失而不是 0：
// Number('') === 0，若不先判 trim 长度，缺额会被显示成“已用尽”。
// 非有限值（NaN/Infinity）同样归为缺失，避免污染后续求和与百分比。
function parseNumber(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numericValue) ? numericValue : null;
}

// 必须同时满足 status=active 与名称/ID 含 start-plan：只看 status 会把用户的其他
// 编程套餐误判为 Start Plan，进而用 balance 数据覆盖其额度。
// 名称匹配同时覆盖 'start-plan' 与 'start plan' 两种写法，避免拼写差异导致漏识别。
function pickCurrentZaiStartPlan(plans: ZaiStartPlanPlan[] | undefined): ZaiStartPlanPlan | null {
  return (
    plans?.find((plan) => {
      const status = readNonEmptyString(plan.status)?.toLowerCase();
      const planId = readNonEmptyString(plan.plan_id)?.toLowerCase();
      const name = readNonEmptyString(plan.name)?.toLowerCase();
      return (
        status === "active" && (isZaiStartPlanIdentity(planId) || isZaiStartPlanIdentity(name))
      );
    }) ?? null
  );
}

// 只做类型断言、不做校验：balance 的字段全部经过 parseNumber/parseUnixSeconds 二次归一化，
// 在此处再校验一遍只会重复开销。
function readZaiStartPlanBalances(
  payload: ZaiStartPlanBalanceEnvelope,
): ZaiStartPlanBalance[] | undefined {
  return payload.data?.balances as ZaiStartPlanBalance[] | undefined;
}

// 日志摘要只保留 name/plan_id/status 三个定位字段，
// 其余字段（entitlements 等）体积大且含配额细节，放进来会淹没关键信息。
function summarizeStartPlans(plans: ZaiStartPlanPlan[] | undefined): Array<{
  name: string | null;
  plan_id: string | null;
  status: string | null;
}> {
  return (plans ?? []).map((plan) => ({
    name: plan.name ?? null,
    plan_id: plan.plan_id ?? null,
    status: plan.status ?? null,
  }));
}

// [权衡] 日志只摘出额度相关字段，不打印整个 balance 对象：
// 完整对象含用户与套餐标识，且体积大，会稀释日志可读性。
function summarizeStartPlanBalances(balances: ZaiStartPlanBalance[] | undefined): Array<{
  entitlement_id: string | null;
  show_name: string | null;
  total_units: number | string | null;
  used_units: number | string | null;
  remaining_units: number | string | null;
  available_units: number | string | null;
  reserved_units: number | string | null;
}> {
  return (balances ?? []).map((balance) => ({
    entitlement_id: balance.entitlement_id ?? null,
    show_name: balance.show_name ?? null,
    total_units: balance.total_units ?? null,
    used_units: balance.used_units ?? null,
    remaining_units: balance.remaining_units ?? null,
    available_units: balance.available_units ?? null,
    reserved_units: balance.reserved_units ?? null,
  }));
}

// 同时接受连字符与空格两种写法：后端 plan_id 与展示名历史上都用过，
// 只匹配一种会让部分用户的 Start Plan 被当成普通套餐。
// 全部小写化后再比较，调用方负责传入已经 lowercase 的值。
function isZaiStartPlanIdentity(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.includes("start-plan") || value.includes("start plan");
}

// 计费周期挂在每个 entitlement 上，取第一个非空值即可：
// 同一套餐的多个 entitlement 周期一致，逐项比较没有收益。
function pickZaiStartPlanBillingCycle(plan: ZaiStartPlanPlan): string | null {
  return (
    plan.entitlements
      ?.map((item) => readNonEmptyString(item.period))
      .find((period): period is string => Boolean(period)) ?? null
  );
}

// 统一 trim 后再判空，返回 trimmed 值：
// 后端偶发返回全空格，直接透传会让 UI 出现看似存在但不可读的字段。
// 返回 null 而非 undefined，是为了让调用方统一用 ?? 处理缺失。
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// 入参是秒，出口是 ISO 字符串；<=0 与非法值都返回 null（见 parseUnixSeconds）。
// 不能返回 new Date(0) 的 1970 年字符串，那会被 UI 当成“上次续期时间”。
function formatUnixSecondsAsIso(value: number | string | null | undefined): string | null {
  const numericValue = parseUnixSeconds(value);
  if (numericValue === null) {
    return null;
  }

// 秒转毫秒后输出 UTC ISO 串：跨时区展示由 UI 统一格式化，服务层不做本地化。
  return new Date(numericValue * 1000).toISOString();
}

// 秒级时间戳解析：0 与负数视为缺失，因为后端用 0 表示“未设置”。
// 与 parseNumber 分开是刻意的：金额/额度允许 0，时间戳不允许，混用会把 0 当成合法时刻。
function parseUnixSeconds(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue;
}

// 以已经解析好的 quotaUrl 为基址替换 pathname，保证自定义域名/代理路径被继承；
// 团队场景同样需要 type=2，理由与 buildQuotaLimitUrl 相同。
function buildUsageMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  endpoint: "model-usage" | "tool-usage",
  startTime: string,
  endTime: string,
): string {
  const url = new URL(resolved.quotaUrl);
// 基于配额 URL 替换末尾 path，而不是重新拼 host：
// 这样自定义网关路径（如 /proxy/bigmodel/api/...）会被完整继承。
// 正则锚定结尾的 /quota/limit，避免误替换路径中段同名片段。
  url.pathname = url.pathname.replace(/\/quota\/limit$/, `/${endpoint}`);
  if (resolved.teamContext) {
    // BigModel Team Plan 的 monitor 用量接口和 quota/limit 一样按 type=2 路由。
    // 只带团队项目 key/header 时仍会落到个人 Coding Plan 分支并返回不存在套餐。
    url.searchParams.set("type", "2");
  }
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  return url.toString();
}

// credit-usage 的 type 语义与 quota/limit 不同：个人 1、团队 3。
// 沿用 type=2 会命中“仅企业主账号可查询企业汇总数据”分支，团队成员直接失败。
function buildCreditUsageMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  endpoint: "activity" | "usage-detail",
  startTime: string,
  endTime: string,
  usageType?: "MODEL" | "MCP",
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/usage\/quota\/limit$/, `/credit-usage/${endpoint}`);
  // Team Plan 的 quota/limit 仍用 type=2，但 credit-usage 使用 type=3；
  // 继续沿用 type=2 会触发后端“仅企业主账号可查询企业汇总数据”分支。
// credit-usage 必须显式带 type：个人 1、团队 3（不是 quota 的 2），
// 漏传时后端按缺省个人口径返回，团队管理员会看到被截断的汇总。
  url.searchParams.set("type", resolved.teamContext ? "3" : "1");
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  if (usageType) {
    url.searchParams.set("usageType", usageType);
  }
  return url.toString();
}

function buildModelPerformanceMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  startTime: string,
  endTime: string,
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/quota\/limit$/, "/model-performance-day");
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  return url.toString();
}

// 活动热力图固定回看 365 天，按用户时区取“今天”作为右边界；
// 用 addDaysToDateKey 做 UTC 日历运算，避免本地 DST 让窗口少/多一天。
function resolveCreditUsageActivityTimeRange(timeZone: string | undefined): {
  startTime: string;
  endTime: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), timeZone);
// 含首尾共 366 天：热力图按自然年回看，少一天会让年初/年末的格子缺失。
// 时间边界用 00:00:00 ~ 23:59:59，后端按闭区间过滤。
  const startDateKey = addDaysToDateKey(endDateKey, -365);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
  };
}

function resolveModelPerformanceTimeRange(
  timeZone: string | undefined,
  range: "7d" | "30d",
): {
  startTime: string;
  endTime: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), timeZone);
  const startDateKey = addDaysToDateKey(endDateKey, range === "7d" ? -6 : -29);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
  };
}

// 用 en-CA 的 YYYY-MM-DD 顺序取 part，而不是 toISOString 后截断：
// 后者是 UTC 日期，会把东八区凌晨算成前一天。
// timeZone 为空时交给运行时默认时区，不硬编码 UTC。
function formatDateInTimeZone(date: Date, timeZone: string | undefined): string {
// 用 formatToParts 而不是 format：后者受 locale 影响可能带非 ISO 分隔符，
// 逐字段取值后再拼 YYYY-MM-DD，保证输出与后端约定的日期格式完全一致。
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

// 在 UTC 上做日历加减，规避本地时区的 DST 跳变；返回值手工补齐两位月/日。
// 解构默认值 1970-01-01 只防御格式异常，正常路径不会用到。
function addDaysToDateKey(dateKey: string, days: number): string {
  const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// 两个环境变量名并存是历史兼容：ZCODE_ 前缀优先，其次是无前缀版本。
function resolveQuotaUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return readEnv(env, "ZCODE_BIGMODEL_USAGE_QUOTA_URL") ?? readEnv(env, "BIGMODEL_USAGE_QUOTA_URL");
}

// 错误码按 family 区分，UI 据此给出“去登录 Z.ai”或“去配置 BigModel”的不同引导。
function resolveCodingPlanApiKeyError(providerId: string | undefined): string {
  if (providerId && isZaiCodingPlanProviderId(providerId)) {
    return "zai_coding_plan_api_key_required";
  }
  return "bigmodel_coding_plan_api_key_required";
}

// 按 provider 选业务域名，不能因为当前是团队身份就统一走 bigmodel：
// zai 账号的团队数据只存在于 zai 业务域。
function resolveAccountProviderQuotaUrl(providerId: string, env: NodeJS.ProcessEnv): string {
  return isZaiCodingPlanProviderId(providerId) ? buildZaiQuotaUrl(env) : buildBigModelQuotaUrl(env);
}

// 展示名同时覆盖 zai 个人 Coding Plan 与 Start Plan，两者在 UI 上共用同一品牌文案；
// 其余一律归为 BigModel，避免出现空 provider 名。
function resolveAccountProviderLabel(providerId: string): string {
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    ? "Z.ai - Coding Plan"
    : "BigModel - Coding Plan";
}

// 默认参数 process.env 只用于非依赖注入场景；provider 内部始终显式传 this.env。
function buildBigModelQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  return buildBigModelApiUrl(env, BIGMODEL_QUOTA_PATH);
}

// [失败路径] Z.ai 的 usage/quota 必须走业务域名而不是 api.z.ai：
// 测试环境只有业务 origin 被代理，发往生产会携带测试 token 并产生真实鉴权失败日志。
function buildZaiQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  // ZAI usage/quota 与 business login 共用业务域名。
  // 测试环境必须请求 配置的 ZAI Business origin，不能把测试 token 发送到生产 api.z.ai。
// path 与 BIGMODEL_QUOTA_PATH 相同，但基址必须走 zai 业务域；
// 两处字符串重复是刻意的：两个 family 的上游接口可能独立演进。
  return buildRuntimeZaiBusinessUrl(env, "/api/monitor/usage/quota/limit");
}
