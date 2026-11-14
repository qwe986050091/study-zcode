// 用量统计服务：把三类用量视图（App Usage / Coding Plan 监控 / Entitlement）
// 路由到各自唯一的数据源，并用 TTL 缓存与在途合并约束对上游的调用频率。
// INV-01：App Usage 只经 zcodeAgentService 读 agent 数据库，不回退本地 session JSON（守住：getAppUsageSnapshot）。
// INV-02：Coding Plan 链路只接受预置 provider，其它 id 一律抛 no_bigmodel_api_key（守住：各入口守卫）。
// 破坏任一后果：UI 会混出两套无法解释的数值，或用错的凭据打外部配额接口。
import type {
  ApiClient,
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanRegularTpsRequest,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@zcode/shared";
import { isCodingPlanModelProviderId } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";
import {
  BigModelUsageQuotaProvider,
  type UsageApiAuthorizationRequest,
  type UsageApiAuthorization,
} from "./providers/bigmodelUsageQuotaProvider.js";
import type { OfficialMcpCredentialSource } from "./providers/zcodeMcpQuotaProvider.js";

interface UsageStatsServiceDependencies {
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
  /** App Usage 经 ZCode Protocol 读取 agent 数据库真实统计。 */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  /**
   * 官方 Server MCP 额度的凭证来源（与 server MCP 调用同一套 5 个身份头）。
   * 缺省时 entitlement 快照不含 MCP 额度。
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
}

// Regular TPS 是低频变化的观测值，5 分钟窗口只用来吸收页面轮询；
// 窗口过短等于把监控页变成压测流量，过长则用户改配置后长时间看不到新值。
const CODING_PLAN_REGULAR_TPS_CACHE_MS = 5 * 60_000;

// 只做身份判定，不解析凭据：返回 boolean 让各入口自行映射错误码，
// 避免把「未配置 key」与「provider 不匹配」两种原因压缩成同一条异常。
function isCodingPlanProviderId(providerId: string | undefined): boolean {
  return Boolean(providerId && isCodingPlanModelProviderId(providerId));
}

// 工厂持有两组进程内状态（TTL 缓存、在途 Promise 表），随实例存活且不持久化：
// TPS 是实时观测值，跨重启复用旧值会与账号当前套餐不一致。
export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
// 所有 Coding Plan/Entitlement 调用共享同一个 provider 实例，从而共享其授权解析与
// token 缓存；若逐个方法各建实例，换票次数会随页面请求数线性放大。
  const quotaProvider = new BigModelUsageQuotaProvider({
    apiClient: dependencies.apiClient,
    accountRequestAuthService: dependencies.accountRequestAuthService,
    resolveApiAuthorization: dependencies.resolveApiAuthorization,
    credentialService: dependencies.credentialService,
    env: dependencies.env,
    ...(dependencies.officialMcpCredentialSource
      ? { officialMcpCredentialSource: dependencies.officialMcpCredentialSource }
      : {}),
  });
// [资源] 缓存靠 expiresAt 惰性过期，不做主动清理：条目数被 provider × accountAccess ×
// timeZone 的组合封顶，量级极小；挂定时器反而会在服务销毁后留下悬挂句柄。
  const regularTpsCache = new Map<
    string,
    { expiresAt: number; value: number | undefined }
  >();
// [并发] 同 key 并发只发一次上游请求，其余挂到同一 Promise：监控页多组件同时挂载
// 会天然产生重复请求，去重后避免把配额接口打到限流。
  const regularTpsInFlight = new Map<string, Promise<number | undefined>>();

// key 必须含完整请求身份（accountAccess 与 timeZone）：只按 provider 建 key 会让
// 切换账号/团队后读到上一个身份的 TPS。JSON.stringify 保证字段顺序稳定可比。
  function regularTpsCacheKey(request: CodingPlanRegularTpsRequest): string {
    return JSON.stringify([
      request.preferredProviderId,
      // Team scope（organizationId/projectId）已内含在 accountAccess 里，整体入 key，
      // 避免同一 provider 下不同账号或不同团队项目共用同一条 TPS 缓存。
      request.accountAccess,
      request.timeZone ?? null,
    ]);
  }

  return {
// [权衡] 这里直接透传、不叠加服务层缓存：agent 侧已按 range 聚合，
// 再缓存会让新会话产生的用量长时间不反映到统计页。
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      // App Usage 现读取 agent 数据库真实统计（model_usage/turn_usage/tool_usage），
      // 经 ZCode Protocol usage/stats 取回。不再读本地 session JSON 估算。
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
    async getCodingPlanUsageSnapshot(
      request: CodingPlanUsageRequest,
    ): Promise<CodingPlanUsageSnapshot> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        // Coding Plan 页面只允许预置的 Z.AI/BigModel Coding Plan 账号。
        // 普通 provider id 不能进入 monitor 链路，避免误读 API Key 或环境变量。
        throw new Error("no_bigmodel_api_key");
      }
// 该 provider 守卫在 TPS/Reset 各入口重复出现是刻意的：每个方法都要能独立拒绝非 Coding Plan 身份。
      return quotaProvider.getCodingPlanUsageSnapshot(request);
    },
    async getCodingPlanRegularTps(
      request: CodingPlanRegularTpsRequest,
    ): Promise<number | undefined> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      const key = regularTpsCacheKey(request);
      const cached = regularTpsCache.get(key);
// 命中未过期缓存即返回，包括 value 为 undefined 的负结果：否则上游不支持 TPS
// 的场景会在每次页面刷新时重打一次接口。
      if (cached && cached.expiresAt > Date.now()) return cached.value;
// [并发] 先查缓存、再查在途表：顺序反了会让「缓存刚过期、首个请求在途」的窗口里
// 并发调用者绕过去重，各发一次上游请求。
      const existing = regularTpsInFlight.get(key);
      if (existing) return existing;

      const requestPromise = quotaProvider
        .getCodingPlanRegularTps(request)
// 先写缓存再返回值：并发拿到同一 Promise 的调用者与后续缓存命中者必须看到同一个数，
// 否则同一时刻不同组件会显示不同 TPS。
        .then((value) => {
          regularTpsCache.set(key, {
            expiresAt: Date.now() + CODING_PLAN_REGULAR_TPS_CACHE_MS,
            value,
          });
          return value;
        })
// [资源] 在 finally 删除在途登记：成功、抛错、调用方取消都要清，
// 否则一次失败会让该 key 永久复用已 reject 的 Promise。
        .finally(() => {
          regularTpsInFlight.delete(key);
        });
      regularTpsInFlight.set(key, requestPromise);
      return requestPromise;
    },
// 以下 Reset 系列（查状态/申请机会/使用/标记已读）都会改动服务端配额，
// 因此不缓存也不去重：重放一次就多消耗一次重置机会。
    async getCodingPlanResetStatus(
      request: CodingPlanResetScopeRequest,
    ): Promise<CodingPlanResetStatusSnapshot> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.getCodingPlanResetStatus(request);
    },
    async requestCodingPlanResetOpportunity(
      request: CodingPlanResetOpportunityRequest,
    ): Promise<CodingPlanResetOpportunityResult> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.requestCodingPlanResetOpportunity(request);
    },
    async useCodingPlanReset(
      request: CodingPlanResetUseRequest,
    ): Promise<CodingPlanResetUseResult> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.useCodingPlanReset(request);
    },
    async markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      await quotaProvider.markCodingPlanResetHistoryRead(request);
    },
// [权衡] 明确不做本地回退：monitor 失败要把错误暴露给 UI，
// 用旧缓存冒充实时用量会让用户按错误余额做升级或等待决策。
    async getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
      // App Usage 已迁移到 getAppUsageSnapshot（agent 数据库）。getSnapshot 仅服务 Coding Plan monitor 链路。
      // 任何 monitor 失败都不能回退本地数据，保持数据源隔离。
      return quotaProvider.getUsageStatsSnapshot(request);
    },
// Entitlement 是纯读快照，直接委托；request 默认空对象允许前端不传范围，
// provider 内部补默认值，这里不重复校验以免两处默认值漂移。
    async getEntitlementSnapshot(
      request: UsageEntitlementRequest = {},
    ): Promise<UsageEntitlementSnapshot> {
      return quotaProvider.getSnapshotForRequest(request);
    },
  };
}
