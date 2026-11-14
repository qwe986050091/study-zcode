import {
  readRequestVerificationConfig,
  requestVerificationClaimHeaders,
  isRequestVerificationMessage,
  type RequestVerificationClientConfig,
} from "@zcode/shared";
// 深度注释：BigModel / Z.ai Coding Plan 订阅与支付 provider。
// 本文件是「远端商务接口 → 本地订阅/支付视图」的唯一映射层，自身不持久化业务状态：
// 可变状态只有 client/configs 快照与在途请求，其余事实一律来自远端响应或凭据服务。
//
// INV-01：鉴权头只能由 family 虚方法产出（resolveEndpointConfig 与三个 createFamily* 委托），
//   任何业务方法不得自行读 token 拼头；绕过会让 zai token 发往 BigModel 域，既 401 又泄露凭据。
//   守住位置：resolveEndpointConfig、createFamilyEnterpriseAuthHeaders。
// INV-02：业务登录态接口的 Authorization 是裸 accessToken，不加 Bearer 前缀；
//   加前缀会被 bigmodel.cn 判为无效令牌，表现为「刚登录仍要求登录」。
//   守住位置：createBigModelLoginAuthHeaders、createZaiLoginAuthHeaders。
// INV-03：两套 envelope 成功码不同：/api/biz 与 /api/pay 用 code=200，
//   ZCode 平台 /api/v1（client/configs、billing/preview、billing/claim）用 code=0；
//   混用解包器会把合法响应当成失败。守住位置：unwrapEnvelope 与 unwrapClientConfig* 系列。
// INV-04：clientConfigSnapshot 必须与 expiresAt 同一时刻写入；先写快照后写过期时间会让缓存
//   永不过期，灰度开关翻转后客户端长期看不到新值。守住位置：getClientConfigs。
// INV-05：同一时刻最多一个 client/configs 在途请求，多个调用方共享同一个 Promise；
//   去掉合并会让设置页首屏并发打多次远端，并可能读到不同版本的快照。
//   守住位置：getClientConfigs 的 clientConfigRequest 分支。
// INV-06：oauth:bigmodel:access_token 若等于 zcodejwttoken，视为历史污染状态必须拒绝使用；
//   否则付费套餐预览会拿 zcode JWT 去打 bigmodel.cn，稳定报令牌过期。
//   守住位置：loadBigModelAccessToken。
// INV-07：Team Plan 项目 api key 预热按项目隔离失败，单个项目失败只降级为 unavailable；
//   抛出去会让一个团队报错导致其他团队入口全部不可见。
//   守住位置：ensureSubscribedTeamPlanProjectApiKeys 的 try/catch。
// INV-08：远端返回 HTML/WAF 页面时必须收敛为 CODING_PLAN_SYSTEM_BUSY；
//   原样透传会把整段 HTML 渲染进确认支付页。守住位置：readCodingPlanApiJson。
// 以上不变量都由本文件单点维护，改动时优先确认破坏的是哪一条，而不是就地加兜底分支。
/* eslint-disable max-lines -- Coding Plan provider 需要集中维护 BigModel 支付宝与 Z.ai Stripe/PayPal 接口映射，拆分会让共享鉴权和响应解包更难追踪。 */
import type {
  ApiClient,
  ApiRequestInit,
  RequestVerificationConfig,
  ForceUpdateConfig,
  CodingPlanAgreementResponse,
  CodingPlanBatchPreviewRequest,
  CodingPlanBatchPreviewResponse,
  CodingPlanCreateSignRequest,
  CodingPlanPaymentCheckRequest,
  CodingPlanPaymentCheckResponse,
  CodingPlanPendingOrderCheckResponse,
  CodingPlanPaypalSetupTokenRequest,
  CodingPlanPaypalSetupTokenResponse,
  CodingPlanPaypalSubscribeRequest,
  CodingPlanPaypalSubscribeResponse,
  CodingPlanPaypalSupportRequest,
  CodingPlanPaypalSupportResponse,
  CodingPlanProductInfo,
  CodingPlanProductInfoRequest,
  CodingPlanBillingDiscountConfig,
  CodingPlanStaticTeamProduct,
  CodingPlanStaticProductsConfig,
  CodingPlanStaticTeamProductsConfig,
  CodingPlanSubscriptionProviderId,
  CodingPlanPreviewRequest,
  CodingPlanPreviewResponse,
  CodingPlanStripeBindRequest,
  CodingPlanStripeBindResponse,
  CodingPlanStripeCard,
  CodingPlanStripePayRequest,
  CodingPlanStripePayResponse,
  CodingPlanStripeUnbindRequest,
  CodingPlanUpdateSignRequest,
  EnterpriseCodingPlanCancelOrderRequest,
  EnterpriseCodingPlanCancelOrderResponse,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanBalanceResponse,
  EnterpriseCodingPlanContinuePayRequest,
  EnterpriseCodingPlanOrderCalculateRequest,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanOrderStatusRequest,
  EnterpriseCodingPlanOrderStatusResponse,
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
  EnterpriseCodingPlanPricingProduct,
  EnterpriseCodingPlanProjectApiKeyUnavailableReason,
  EnterpriseCodingPlanProjectContext,
  StartPlanPreviewConfig,
  ManualClaimPlanClaimRequest,
  ManualClaimPlanClaimResult,
  ManualClaimPlanPreviewSnapshot,
  ZCodeModelContextBudgetStrategy,
  DynamicWorkflowClientConfig,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import type { OffPeakClientConfig } from "./codingPlanSubscription.js";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  REQUEST_VERIFICATION_REQUIRED,
  CODING_PLAN_SYSTEM_BUSY,
  buildRuntimeZCodeApiUrl,
  isZaiCodingPlanProviderId,
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  ZAI_PROVIDER_ID,
  ZCODE_VERSION,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  createDynamicWorkflowClientConfig,
  normalizeDynamicWorkflowMode,
  resolveDynamicWorkflowClientConfig,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { readApiJson } from "../providers/api/apiJson.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  ensureBigModelTeamPlanProjectApiKeyWithStatus,
  type BigModelTeamPlanApiKeyEnsureResult,
  type BigModelTeamPlanBizContext,
} from "#src/bigmodel/teamPlanApiKey.js";

// 两个 family 的前缀不同：BigModel 的订阅/支付都挂在 /api/biz 下，
// Z.ai 的 Stripe/PayPal 走独立的 /api/pay。路径拼接只发生在 post/get/postZaiPay/getZaiPay 四处，
// 其他方法只传相对 path，避免各处手拼前缀后拼出 /api/biz/api/pay 这类双前缀。
const BIGMODEL_CODING_PLAN_API_PREFIX = "/api/biz";
const ZAI_CODING_PLAN_PAY_API_PREFIX = "/api/pay";
const ZCODE_CLIENT_CONFIG_API_PREFIX = "/api/v1/client/configs";
const REQUEST_TIMEOUT_MS = 15_000;
// [权衡] 1h 是本文件唯一的时间型缓存，灰度开关（闲时任务/动态工作流）都走这条通道：
// TTL 太短会让配置接口成为会话创建路径上的热点，太长则灰度翻转最长 1h 不可见；
// 因此需要立即生效的调用方用 forceRefresh 显式清缓存，而不是调短 TTL 影响全局。
const CLIENT_CONFIG_CACHE_TTL_MS = 60 * 60 * 1000;
const CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED = "coding_plan_zai_overseas_payment_required";
// 与 OAuth 服务共用的凭据键，本文件只读不写（写方是 OAuth 登录流程）。
// 这里读它只有两个用途：manual claim 的 Bearer 头，以及识别 BigModel 令牌被污染的旧状态。
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const log = createServiceLogger("codingPlanSubscription");

// 合并时曾丢失秒到毫秒的边界转换，导致客户端用本机时间误判待生效权益。
// [权衡] 远端 server_time 是秒，且可能缺失/为负/非数字。统一在此换算成毫秒并返回 undefined
// 而不是 0：调用方靠「字段是否存在」区分「服务端没给」与「服务端给了 0」，
// 后者会让本机时间比较把待生效权益判成已生效。
function readServerTimeMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value * 1_000
    : undefined;
}

// /api/biz 与 /api/pay 的通用信封，成功判据见 unwrapEnvelope（code=200 成功）。
// 字段全可选是刻意的：WAF/网关层会返回只有 msg 或只有 success 的残缺体，
// 强制非空会在解包前抛类型错误，丢掉「错误码 → 文案」的映射机会。
interface RemoteEnvelope<T> {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: T | null;
}

// 手动领取页 preview 载荷，字段全为 snake_case，与对外暴露的 camelCase 视图一一对应。
// 这里只声明形状，合法化（trim、有限数判断）在 getManualClaimPlanPreviews 里逐字段做。
interface ManualClaimPlanPreviewPayload {
  server_time?: number;
  plans?: Array<{
    plan_id?: string;
    name?: string;
    description?: string;
    priority?: number;
    entitlements?: Array<{
      entitlement_id?: string;
      show_name?: string;
      meter?: string;
      unit_type?: string;
      capabilities?: string[];
      grant_units?: number;
      period?: string;
      priority?: number;
      effective_at?: number;
    }>;
  }>;
}

// claim 与 preview 共用 server_time 语义，但多出 plan 与 message。
// 失败时顶层 msg 不是用户文案、data.message 才是，两者不可混用（见 claimManualPlan）。
interface ManualClaimPlanClaimPayload {
  server_time?: number;
  message?: unknown;
  plan?: {
    user_plan_id?: string;
    plan_id?: string;
    status?: string;
    starts_at?: number;
    ends_at?: number;
    entitlements?: Array<{
      entitlement_id?: string;
      show_name?: string;
      effective_at?: number;
    }>;
  };
}

// ZCode 平台配置通道（/api/v1/client/configs）的信封，成功码是 code=0，与 /api/biz 的 200 不同（INV-03）。
// 内层 configs 的命名混排：产品配置用 camelCase，服务端灰度开关用 snake_case
// （offPeak.enable_offpeak_task）。灰度字段类型保持 unknown，取值域由 shared 的 normalize 裁决，
// 本文件不在类型层假设服务端合法。
interface ZCodeClientConfigEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: {
    configs?:
      | (RequestVerificationClientConfig & {
          forceUpdate?: ForceUpdateConfig | null;
          codingPlanBillingDiscount?: CodingPlanBillingDiscountConfig;
          codingPlanStaticProducts?: CodingPlanStaticProductsConfig;
          codingPlanStaticTeamProducts?: CodingPlanStaticTeamProductsConfig;
          startPlanPreview?: StartPlanPreviewConfig | null;
          // 闲时任务灰度（服务端）：内层字段服务端为 snake_case，与外层 camelCase 混排。
          offPeak?: {
            enable_offpeak_task?: boolean;
          } | null;
          modelContextBudget?: {
            strategy?: unknown;
          } | null;
          // 动态工作流灰度：mode 的取值域由
          // shared 的 normalizeDynamicWorkflowMode 裁决，这里保持 unknown，不在类型层假设服务端合法。
          dynamicWorkflow?: {
            mode?: unknown;
          } | null;
        })
      | null;
  } | null;
}

// 依赖只注入三样：HTTP 客户端、凭据读取（只要求 load）、可选的闲时模型视图解析器。
// 刻意不给凭据写权限：provider 不是认证事实源，只能消费 OAuth 写好的凭据。
interface BigModelCodingPlanSubscriptionProviderOptions {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
}

// 单个团队项目的 api key 预热结果。unavailable 必须带 reason，UI 据此区分
// 「服务端说没有有效团队授权」（引导重新授权）与「请求失败」（可重试）。
interface TeamPlanProjectApiKeyPrewarmStatus {
  status: "available" | "unavailable";
  reason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason;
  message?: string | null;
}

// 一次请求的完整寻址结果：providerId 决定错误文案与成功码，host 由 family 决定。
// 三者绑定返回，避免调用方拿到 host 后自行拼 headers 造成鉴权域与域名错配（INV-01）。
interface CodingPlanEndpointConfig {
  providerId: CodingPlanSubscriptionProviderId;
  host: string;
  headers: Record<string, string>;
}

// customerInfo 是企业团队项目的兜底事实源：pricing 只回 productId/tier 时，
// 靠 organizations[].projects[] 的 projectType 找回真实团队项目（见 resolveBigModelTeamProjects）。
interface BigModelCustomerInfoResponse {
  organizations?: Array<{
    organizationId?: string | null;
    organizationName?: string | null;
    projects?: Array<{
      projectId?: string | null;
      projectName?: string | null;
      projectType?: number | string | null;
    }> | null;
  }> | null;
}

// [并发] 实例按 Host 单例使用。除 clientConfig 三个字段外无可变状态，多页面并发调用安全。
// 凭据不缓存：每次请求前从 credentialService 读，保证 logout / 切换账号立即生效；
// credentialService.load 走本地 I/O，开销比一次网络往返低两个数量级，所以不缓存凭据。
// [资源] 本类不持有定时器、连接或文件句柄，无 dispose 需求；clientConfigRequest 只在请求存续期
// 持有，且 finally 中一定会被清空。
export class BigModelCodingPlanSubscriptionProvider {
  protected readonly apiClient: ApiClient;
  protected readonly credentialService: Pick<ICredentialService, "load">;
  private readonly resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
// [并发] 缓存三件套：snapshot 是最近一次成功的完整信封；expiresAt 与它同一时刻写入（INV-04），
// 0 表示无缓存；request 是在途请求（INV-05），非 null 时所有调用方 await 同一个 Promise。
// 三者都不加锁：JS 单线程下「检查-赋值」之间没有 await，不会出现部分写入的中间态。
// 之所以不用 Map 按 provider 分桶：client/configs 与 family 无关，全 provider 共用一份。
  private clientConfigSnapshot: ZCodeClientConfigEnvelope | null = null;
// 与 snapshot 配套的过期时刻，必须与 snapshot 同时写（INV-04）。
// 单独重置它而不清 snapshot 会让旧快照被当成永不过期；forceRefresh 两个字段一起清零正是这个原因。
// 初值 0 表示「无缓存」，因此首次调用一定走远端。
  private clientConfigSnapshotExpiresAt = 0;
  private clientConfigRequest: Promise<ZCodeClientConfigEnvelope> | null = null;

// apiClient 与 credentialService 只保存引用；resolveOffPeakModelSelectionView 允许缺省，
// 缺省时闲时配置按「无可用模型」处理（见 resolveOffPeakClientConfig 的 hasModels）。
  constructor(options: BigModelCodingPlanSubscriptionProviderOptions) {
    this.apiClient = options.apiClient;
    this.credentialService = options.credentialService;
    this.resolveOffPeakModelSelectionView = options.resolveOffPeakModelSelectionView;
  }

  // ─────────── family 维度抽象（供 ZaiCodingPlanSubscriptionProvider 覆盖）───────────
  // 原 enterprise 读方法（getEnterprisePricing / enrichEnterprisePricingTeamProjects 等）
  // 把 family 硬编码成 bigmodel：providerId=bigmodelCodingPlan、host=resolveBigModelApiOrigin、
  // token=loadBigModelAccessToken。zai family 对称化时无法复用。
  // 这里把 family 维度抽成 protected 虚方法，bigmodel 默认实现保持原行为，zai 子类覆盖即可。

  /** 当前 family 的 Coding Plan providerId（bigmodelCodingPlan / zaiCodingPlan）。 */
// family 维度的四个虚方法：ProviderId / Host / Token / AuthHeaders。
// 默认实现全部指向 bigmodel，Zai 子类只覆盖这四点即可复用全部接口映射。
// 不要在具体业务方法里判断 providerId 后分叉——那会让新增 family 时改动扩散到每个接口。
  protected codingPlanProviderId(): CodingPlanSubscriptionProviderId {
    return BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
  }

  /** 当前 family 的业务域名（bigmodel 域 / zai 域）。 */
// 域名来自环境变量而非常量：E2E/测试用 ZCODE_*_BASE_URL 指向本地 mock。
// 硬编码线上域名会让套餐状态不可控（同 getClientConfigs 的说明）。
  protected resolveFamilyEnterpriseHost(): string {
    return resolveBigModelApiOrigin(process.env);
  }

  /** 当前 family 的业务 OAuth token。 */
// 返回裸 accessToken，不含任何前缀；前缀与拼接由 createFamilyEnterpriseAuthHeaders 独占（INV-02）。
  protected async loadFamilyEnterpriseToken(): Promise<string> {
// 企业接口与个人支付接口共用同一个 BigModel 令牌，子类只需换掉这一个来源。
// 不在此处缓存 token：logout 后必须立即失效（见类注释）。
    return this.loadBigModelAccessToken();
  }

  /** 当前 family 的业务鉴权头。 */
// 企业接口与个人支付接口共用同一套 bigmodel 登录态头，故直接委托给导出的工厂函数，避免两处漂移。
  protected createFamilyEnterpriseAuthHeaders(token: string): Record<string, string> {
// 返回值直接作为请求头使用，调用方不得再追加 Authorization，否则同键覆盖顺序未定义。
// 头里的 Content-Type 对 GET 无害，统一给出可减少分支。
    return createBigModelLoginAuthHeaders(token);
  }

// 批量预览只透传 invitationCode：域名由 providerId 决定，其余字段由远端按渠道默认值补齐。
  async batchPreview(
    request: CodingPlanBatchPreviewRequest = {},
  ): Promise<CodingPlanBatchPreviewResponse> {
    return this.post<CodingPlanBatchPreviewResponse>(request.providerId, "/pay/batch-preview", {
      invitationCode: request.invitationCode,
    });
  }

// 静态目录的三个读法共用一次 client/configs（缓存 + 在途合并），同屏渲染不会打三次远端。
// 三者都不吞异常：目录缺失属于配置故障，必须让 UI 回落到实时 pricing，而不是展示空套餐。
  async getStaticProducts(): Promise<CodingPlanStaticProductsConfig> {
    const payload = await this.getClientConfigs();
// 解包在本模块实现：目录键别名换算与形状校验都属于配置边界，不适合下放到 shared。
// 不缓存解包结果：缓存只保留原始信封，避免多份派生视图互相不一致。
    return unwrapClientConfigProducts(payload);
  }

// 团队目录额外做逐项形状校验（见 unwrapClientConfigTeamProducts）：远端配置没有类型保障。
  async getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig> {
    const payload = await this.getClientConfigs();
// 团队目录与个人目录共用同一个信封，两次读取必然合并成一次请求（INV-05）。
// 校验失败的异常由调用方处理，本方法不做降级。
    return unwrapClientConfigTeamProducts(payload);
  }

// null 表示服务端未开启首购预览，属于正常态；字段缺失才是错误，由解包函数区分。
  async getStartPlanPreview(): Promise<StartPlanPreviewConfig | null> {
    const payload = await this.getClientConfigs();
// 首购预览是「有则展示」的配置，缺省返回 null 而不是空对象，方便调用方直接判断。
// 与套餐目录不同，这里不缓存二次解析结果。
    return unwrapClientConfigStartPlanPreview(payload);
  }

// 手动领取页的套餐快照，三条约束：
// 1) 未登录也要能看套餐，token 缺失时只去掉 Authorization，不短路返回错误；
// 2) 成功码是 0（平台 envelope），不能套 /api/biz 的 200 解包器，否则合法 preview 被判失败；
// 3) server_time 透传给 UI 做倒计时，缺失就不带该字段，让 UI 退回本机时间。
  async getManualClaimPlanPreviews(): Promise<ManualClaimPlanPreviewSnapshot> {
    const token = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim();
// 必须走 buildRuntimeZCodeApiUrl 而不是拼字符串：E2E 用 ZCODE_BASE_URL 把该请求导向本地 mock，
// 手拼域名会让套餐预览在离线环境直接打线上。
    const url = new URL(buildRuntimeZCodeApiUrl(process.env, "/api/v1/zcode-plan/billing/preview"));
    url.searchParams.set("app_version", ZCODE_VERSION);
    url.searchParams.set("platform", resolveClientPlatformKey());
// 平台 billing 接口的成功码是 0，与 /api/biz 的 200 不同，因此这里只能手工判 code，不能复用 this.get。
    const payload = await readCodingPlanApiJson<RemoteEnvelope<ManualClaimPlanPreviewPayload>>(
      this.apiClient,
      url,
      {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    // 新 ZCode billing 接口沿用平台 envelope（code=0 成功），不能复用
    // BigModel 支付接口的 code=200 解包器，否则合法 preview 会被误判失败。
    if (payload.code !== undefined && payload.code !== 0) {
      throw new Error(payload.msg?.trim() || "manual_claim_preview_failed");
    }
    if (!payload.data) {
      throw new Error(payload.msg?.trim() || "manual_claim_preview_missing_data");
    }
    const data = payload.data;
    const serverTime = readServerTimeMilliseconds(data.server_time);
// 用 flatMap + 空数组实现过滤：没有 planId 的条目直接丢弃而非产生占位项，
// 避免 UI 渲染出无法领取的空卡片；entitlement 层同理。
    const plans = (data.plans ?? []).flatMap((plan) => {
      const planId = plan.plan_id?.trim() ?? "";
// plan_id 是 claim 的唯一入参，缺失即不可领取。静默丢弃比抛错更合适：
// 用 flatMap 返回空数组而不是 filter：类型收窄后下面的 planId 已是非空 string。
      if (!planId) return [];
      return [
        {
          planId,
          name: plan.name?.trim() || planId,
          description: plan.description?.trim() ?? "",
          priority: Number.isFinite(plan.priority) ? (plan.priority ?? 0) : 0,
          entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
            const entitlementId = entitlement.entitlement_id?.trim() ?? "";
            if (!entitlementId) return [];
            return [
              {
                entitlementId,
                showName: entitlement.show_name?.trim() ?? "",
                meter: entitlement.meter?.trim() ?? "",
                unitType: entitlement.unit_type?.trim() ?? "",
                capabilities: entitlement.capabilities ?? [],
                grantUnits: Number.isFinite(entitlement.grant_units)
                  ? (entitlement.grant_units ?? 0)
                  : 0,
                period: entitlement.period?.trim() ?? "",
                priority: Number.isFinite(entitlement.priority) ? (entitlement.priority ?? 0) : 0,
                ...(Number.isFinite(entitlement.effective_at)
                  ? { effectiveAt: entitlement.effective_at }
                  : {}),
              },
            ];
          }),
        },
      ];
    });
// [权衡] serverTime 用条件展开而不是显式赋 undefined：字段存在性本身就是语义（服务端是否给时间）。
// 写成 serverTime: undefined 会留下一个存在的属性，下游用 in 判断与用值判断将得出不同结论。
// 同样地，服务端给了 0 时字段必须保留，因此判据是 === undefined 而不是 falsy。
    return { ...(serverTime === undefined ? {} : { serverTime }), plans };
  }

// 领取是有副作用的 POST：这里不做任何重试，失败原样返回 code 交给 UI 决策，
// 避免网络抖动下的重复领取。
  async claimManualPlan(request: ManualClaimPlanClaimRequest): Promise<ManualClaimPlanClaimResult> {
    const token = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim();
    if (!token) {
// 没有 zcode JWT 时不发请求：远端必然 401，本地直接给同一语义，省一次往返也避免文案差异。
      return { success: false, code: 401, message: "" };
    }
    const payload = await readCodingPlanApiJson<
      Omit<RemoteEnvelope<ManualClaimPlanClaimPayload>, "code"> & { code?: number | string }
    >(
      this.apiClient,
      new URL(buildRuntimeZCodeApiUrl(process.env, "/api/v1/zcode-plan/billing/claim")),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...requestVerificationClaimHeaders(request),
          "X-ZCode-App-Version": ZCODE_VERSION,
          "X-Platform": resolveClientPlatformKey(),
        },
        body: JSON.stringify({ plan_id: request.planId }),
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    // 领取接口的错误码可能是数字字符串；缺失 code 仍不推断成功。
// 领取接口的 code 可能是数字、数字字符串或缺失。非数字一律归一为 -1 而不是 0：
// 缺失 code 不能被推断成成功（成功还会被 data.plan 是否存在二次校验）。
    const rawCode = payload.code;
    const code =
      typeof rawCode === "number"
        ? rawCode
        : typeof rawCode === "string" && /^\d+$/.test(rawCode)
          ? Number(rawCode)
          : -1;
// 失败分支也带 serverTime：UI 需要在错误态继续显示倒计时与服务端时间基准。
// 缺失时不写该字段（见 readServerTimeMilliseconds 的返回值约定）。
    const serverTime = readServerTimeMilliseconds(payload.data?.server_time);
// 失败判据包含「领取成功但没回 plan」：这种响应无法构造本地权益，只能按失败处理。
// failureEndsAt 只是兼容字段，营销文案不再据它推导，避免把「领取失败」说成「已生效」。
// message 优先取 data.message（服务端已翻译），为空则交给 UI 本地化。
    if (code !== 0 || !payload.data?.plan) {
      const failureEndsAt = payload.data?.plan?.ends_at;
      return {
        success: false,
        code,
        // 服务端已完成翻译，顶层 msg 不是用户文案；空值由 UI 本地化兜底。
        message: typeof payload.data?.message === "string" ? payload.data.message : "",
        ...(serverTime === undefined ? {} : { serverTime }),
        // 保留既有结果字段兼容其他调用方；营销提示不再据此推导文案。
        ...(Number.isFinite(failureEndsAt) ? { failureEndsAt } : {}),
      };
    }
// 走到这里 code 必为 0 且 data.plan 存在（上面一个联合条件已拦掉所有失败形态），
// 因此下方不再重复判空。
// [权衡] 若把成功判据拆成两个 if，失败分支要重复计算一次 failureEndsAt。
    const plan = payload.data.plan;
    return {
      success: true,
      code,
      message: payload.msg?.trim() ?? "",
      ...(serverTime === undefined ? {} : { serverTime }),
      plan: {
        userPlanId: plan.user_plan_id?.trim() ?? "",
        planId: plan.plan_id?.trim() || request.planId,
        status: plan.status?.trim() ?? "",
        ...(Number.isFinite(plan.starts_at) ? { startsAt: plan.starts_at } : {}),
        ...(Number.isFinite(plan.ends_at) ? { endsAt: plan.ends_at } : {}),
        entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
          const entitlementId = entitlement.entitlement_id?.trim() ?? "";
          if (!entitlementId) return [];
          return [
            {
              entitlementId,
              showName: entitlement.show_name?.trim() ?? "",
              ...(Number.isFinite(entitlement.effective_at)
                ? { effectiveAt: entitlement.effective_at }
                : {}),
            },
          ];
        }),
      },
    };
  }

  /**
   * 闲时任务灰度配置：复用 client/configs 通道零新增请求。
   * forceRefresh 供"打开 Automations 入口补拉"（1h 快照否则灰度翻转最长 1h 不可见）。
   */
// 闲时任务灰度：复用 client/configs 快照，零新增请求通道。
// forceRefresh 供「打开 Automations 入口时补拉」使用，否则 1h 快照会让灰度翻转最长 1h 不可见。
  async getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig> {
// mock 已明确替代远端曝光配置，不能再先等 /client/configs：离线 Desktop E2E 会一直停在 Loading，
// 根本进不到闲时执行链。因此 mock 分支必须在 getClientConfigs 之前返回。
    if (process.env["ZCODE_OFFPEAK_MOCK"] === "1") {
      // mock 已经明确替代远端曝光配置，不能再先等待 /client/configs：
      // 离线 Desktop E2E 会一直停在 Loading，根本无法进入闲时执行链。
      const modelSelectionView = await this.resolveOffPeakModelSelectionView?.();
      return resolveOffPeakClientConfig({}, process.env, modelSelectionView);
    }
    if (options?.forceRefresh) {
      this.clientConfigSnapshot = null;
      this.clientConfigSnapshotExpiresAt = 0;
    }
    const payload = await this.getClientConfigs();
    const modelSelectionView = await this.resolveOffPeakModelSelectionView?.();
    return resolveOffPeakClientConfig(payload, process.env, modelSelectionView);
  }

  /**
   * 动态工作流灰度快照：与闲时任务同走
   * client/configs，零新增请求。三条边界：
   *   1. 本地覆盖（ZCODE_DYNAMIC_WORKFLOW_MODE）在任何网络动作之前裁决，命中即返回——
   *      preview 构建和开发者手测因此不受 1h 快照与首次 Host 竞态影响；
   *   2. forceRefresh 与 Off-Peak 同义，清掉快照后重拉（灰度翻转最长 1h 不可见）；
   *   3. 请求失败 fail-closed：返回 default（disabled）并 warn，绝不把异常抛给调用方——
   *      调用方在 session create/client 就绪路径上，灰度读失败不能阻断普通聊天。
   */
// 动态工作流灰度快照，实现层补充两点：
// 本地覆盖在任何网络动作之前裁决，preview 构建与开发者手测不受 1h 快照和首次 Host 竞态影响；
// 请求失败 fail-closed 返回 default(disabled)——调用方在 session create 路径上，不能阻断普通聊天。
  async getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig> {
    // 覆盖合法即短路：判据（normalize）与快照构造（resolve）都留在 shared，这里不复述取值域。
    if (normalizeDynamicWorkflowMode(process.env[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV])) {
      return resolveDynamicWorkflowClientConfig({ remote: undefined, env: process.env });
    }
    if (options?.forceRefresh) {
      this.clientConfigSnapshot = null;
      this.clientConfigSnapshotExpiresAt = 0;
    }
    try {
      const payload = await this.getClientConfigs();
      return resolveDynamicWorkflowClientConfig({
        remote: payload.data?.configs?.dynamicWorkflow,
        env: process.env,
      });
    } catch (error) {
      log.warn(undefined, "动态工作流灰度配置读取失败，按关闭处理", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
    }
  }

// 保留兼容方法但不再请求远端：每次建会话都等配置会让首字延迟受网络影响，
// 预算策略已统一为 preflight-v1，远端值不再参与决策。
  async getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy> {
    // 3.12.2：预算统一为 preflight-v1；保留兼容方法，但不能再为每次建会话等待远端配置。
    return DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
  }

// undefined 表示服务端没下发该字段（不是空折扣），UI 据此决定是否展示折扣标签。
  async getBillingDiscount(): Promise<CodingPlanBillingDiscountConfig | undefined> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigBillingDiscount(payload);
  }

// 验证码配置与其它客户端配置同源，登录前不额外发请求；null 表示未配置校验。
  async getRequestVerificationConfig(): Promise<RequestVerificationConfig | null> {
    return readRequestVerificationConfig((await this.getClientConfigs()).data?.configs);
  }

// 强制更新配置同样走缓存通道；解析失败按 null（不强制）处理，防止配置写坏锁死启动。
  async getForceUpdateConfig(): Promise<ForceUpdateConfig | null> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigForceUpdate(payload);
  }

// 试算：salesChannel 缺省补 zcode，远端按渠道做归因与折扣，缺字段会丢来源统计。
// providerId 同时决定路径（Z.ai 走 /pay/zai-preview）与后续鉴权域。
  async preview(request: CodingPlanPreviewRequest): Promise<CodingPlanPreviewResponse> {
    return this.post<CodingPlanPreviewResponse>(
      request.providerId,
      resolvePreviewPath(request.providerId),
      {
        productId: request.productId,
        invitationCode: request.invitationCode,
        imRef: request.imRef ?? null,
        ticket: request.ticket ?? null,
        randstr: request.randstr ?? null,
        // Coding Plan 试算接口默认按 Maas 渠道处理，不显式标记会丢失 zcode 来源归因。
        salesChannel: request.salesChannel ?? "zcode",
      },
    );
  }

// GET + query 参数而非 POST body：该接口在网关侧按可缓存 GET 处理，改方法会丢缓存并可能被拒。
  async productInfo(request: CodingPlanProductInfoRequest): Promise<CodingPlanProductInfo> {
    const url = new URL(
      `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/product/info`,
    );
    url.searchParams.set("productId", request.productId);
// productInfo 不含订阅态，是静态商品信息，可被 UI 缓存展示。
// 真正决定「是否已购」的是 pricing 与企业接口。
    return this.get<CodingPlanProductInfo>(request.providerId, url);
  }

// 签约（支付宝代扣）只对 BigModel 国内主体开放。Z.ai 主体必须显式拒绝并给出稳定错误码，
// 让 UI 引导到 Stripe/PayPal，而不是把请求发到一个不存在的接口。
  async createSign(request: CodingPlanCreateSignRequest): Promise<CodingPlanAgreementResponse> {
    if (request.providerId && isZaiCodingPlanProviderId(request.providerId)) {
      throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
    }

    return this.post<CodingPlanAgreementResponse>(request.providerId, "/pay/create-sign", {
      bizId: request.bizId,
      payType: request.payType ?? "ALI",
      invitationCode: request.invitationCode,
      renew: request.renew ?? null,
      isDelay: request.isDelay ?? 0,
      effectiveTime: request.effectiveTime ?? null,
    });
  }

// 更新签约与 createSign 同一边界：payType 缺省 ALI，Z.ai 同样不支持。
  async updateSign(request: CodingPlanUpdateSignRequest): Promise<CodingPlanAgreementResponse> {
    if (request.providerId && isZaiCodingPlanProviderId(request.providerId)) {
      throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
    }

    return this.post<CodingPlanAgreementResponse>(request.providerId, "/pay/product/update/sign", {
      bizId: request.bizId,
      payType: request.payType ?? "ALI",
    });
  }

// 支付结果查询是幂等 GET，由前端轮询调用：不做缓存也不重试，每次轮询都反映远端真实状态，
// 超时由 REQUEST_TIMEOUT_MS 兜底。
  async checkPayment(
    request: CodingPlanPaymentCheckRequest,
  ): Promise<CodingPlanPaymentCheckResponse> {
    const url = new URL(
      `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/pay/check`,
    );
    url.searchParams.set("bizId", request.bizId);
// 该接口的 data 本身就是纯字符串状态（如 SUCCESS/PENDING），不要按对象解包。
    const status = await this.get<string>(request.providerId, url);
    return { status };
  }

// 待支付订单检查同样幂等；返回结构直接透传，不在本地推断订单状态机。
  async checkPendingOrders(
    request: {
      providerId?: CodingPlanSubscriptionProviderId;
    } = {},
  ): Promise<CodingPlanPendingOrderCheckResponse> {
    return this.get<CodingPlanPendingOrderCheckResponse>(
      request.providerId,
      new URL(
        `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/pay/check-pending-orders`,
      ),
    );
  }

// 以下 Stripe/PayPal 方法统一走 /api/pay 前缀，并由 postZaiPay/getZaiPay 断言 provider 属于 Z.ai。
  async queryStripeCards(
    request: {
      providerId?: CodingPlanSubscriptionProviderId;
    } = {},
  ): Promise<CodingPlanStripeCard[]> {
    return this.getZaiPay<CodingPlanStripeCard[]>(request.providerId, "/stripe/query");
  }

// 绑定卡片必须带 returnUrl：3DS 验证由浏览器完成后回跳到该地址，缺失会直接绑定失败。
  async bindStripeCard(
    request: CodingPlanStripeBindRequest,
  ): Promise<CodingPlanStripeBindResponse> {
    return this.postZaiPay<CodingPlanStripeBindResponse>(request.providerId, "/stripe/bind", {
      paymentMethodId: request.paymentMethodId,
      returnUrl: request.returnUrl,
      trackingContext: request.trackingContext,
    });
  }

// 解绑返回纯字符串（网关结果），不解包成对象；不要按 envelope.data 的结构强转。
  async unbindStripeCard(request: CodingPlanStripeUnbindRequest): Promise<string> {
    return this.postZaiPay<string>(request.providerId, "/stripe/unbind", {
      paymentMethodId: request.paymentMethodId,
    });
  }

// [失败路径] 扣款请求不重试：网络超时也可能已经扣款成功，重试会造成重复支付，
// 调用方应改用 checkPayment / checkPendingOrders 对账。
// isSubscribe 缺省 true：该接口的默认语义是订阅首扣，不是单次购买。
  async payStripe(request: CodingPlanStripePayRequest): Promise<CodingPlanStripePayResponse> {
    return this.postZaiPay<CodingPlanStripePayResponse>(request.providerId, "/stripe/pay", {
      productId: request.productId,
      paymentMethodId: request.paymentMethodId,
      isSubscribe: request.isSubscribe ?? true,
      returnUrl: request.returnUrl,
      channelCode: request.channelCode,
      estimatePayAmount: request.estimatePayAmount,
      invitationCode: request.invitationCode,
      bizId: request.bizId,
      renew: request.renew ?? false,
    });
  }

// PayPal 支持能力由服务端按地区/币种判定，客户端不内置白名单。
  async checkPaypalSupport(
    request: CodingPlanPaypalSupportRequest = {},
  ): Promise<CodingPlanPaypalSupportResponse> {
    return this.getZaiPay<CodingPlanPaypalSupportResponse>(request.providerId, "/paypal/isSupport");
  }

// setupToken 是 PayPal 订阅的前置：先拿 token、再前端跳转授权、最后 subscribe。
// cancelUrl 必须与 returnUrl 同时给出，否则用户取消时会丢失回跳目标。
  async createPaypalSetupToken(
    request: CodingPlanPaypalSetupTokenRequest,
  ): Promise<CodingPlanPaypalSetupTokenResponse> {
    return this.postZaiPay<CodingPlanPaypalSetupTokenResponse>(
      request.providerId,
      "/paypal/setupToken",
      {
        returnUrl: request.returnUrl,
        cancelUrl: request.cancelUrl,
      },
    );
  }

// 订阅提交必须带 setupTokenId 与 bizId：前者兑换授权，后者把扣款绑到本地订单。
// 与 payStripe 相同，这里不重试（非幂等扣款）。
  async subscribePaypal(
    request: CodingPlanPaypalSubscribeRequest,
  ): Promise<CodingPlanPaypalSubscribeResponse> {
    return this.postZaiPay<CodingPlanPaypalSubscribeResponse>(
      request.providerId,
      "/paypal/subscribe",
      {
        productId: request.productId,
        productDesc: request.productDesc,
        setupTokenId: request.setupTokenId,
        amount: request.amount,
        isSubscribe: request.isSubscribe ?? true,
        estimatePayAmount: request.estimatePayAmount,
        invitationCode: request.invitationCode,
        bizId: request.bizId,
        channelCode: request.channelCode,
      },
    );
  }

// 企业定价有两条互斥通路：
// - 未登录（authenticated === false）走公开 partner pricing，不带鉴权头；
// - 已登录走 v2 pricing，返回后补齐团队项目上下文（见 enrichEnterprisePricingTeamProjects）。
// 两条通路 envelope 成功码都是 200，但匿名分支不做 team 补全——没有登录态取不到 customerInfo。
  async getEnterprisePricing(
    request: EnterpriseCodingPlanPricingRequest = {},
  ): Promise<EnterpriseCodingPlanPricingResponse> {
    const providerId = this.codingPlanProviderId();
    const host = this.resolveFamilyEnterpriseHost();
// 匿名分支直接调 readCodingPlanApiJson 而不走 this.get：this.get 会先解析 endpoint 并读 token，
// 未登录时读不到 token 会抛 bigmodel_oauth_required，把「可展示的价格」变成登录错误。
// 也正因如此这里不能调用 enrich 逻辑，否则同样会在无 token 时失败。
    if (request.authenticated === false) {
      const payload = await readCodingPlanApiJson<
        RemoteEnvelope<EnterpriseCodingPlanPricingResponse>
      >(
        this.apiClient,
        `${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/campaign/partner/enterprise/pricing`,
        {
          method: "GET",
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      );
      return unwrapEnvelope(payload, providerId);
    }

    const response = await this.get<EnterpriseCodingPlanPricingResponse>(
      providerId,
      new URL(`${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/pricing`),
    );
    return this.enrichEnterprisePricingTeamProjects(response);
  }

// 以下企业 v2 接口固定使用 bigmodel family 常量：余额/订单属于 BigModel 企业主体，
// 即使子类把 codingPlanProviderId 覆盖成 zai，也不应改写这些调用点。
  async getEnterpriseBalance(): Promise<EnterpriseCodingPlanBalanceResponse> {
    return this.get<EnterpriseCodingPlanBalanceResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      new URL(
        `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/balance`,
      ),
    );
  }

// 试算无副作用，可被 UI 反复调用；不做本地缓存，保证改配置后金额立即变化。
  async calculateEnterpriseOrder(
    request: EnterpriseCodingPlanOrderCalculateRequest,
  ): Promise<EnterpriseCodingPlanOrderCalculateResponse> {
    return this.post<EnterpriseCodingPlanOrderCalculateResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      "/subscription/enterprise/v2/order/calculate",
      { ...request },
    );
  }

// [失败路径] 建单非幂等：超时后重试可能产生两张待支付订单。因此不重试，超时错误直接上抛；
// 重复订单由 getEnterprisePendingOrders 对账清理。
  async createEnterpriseOrder(
    request: EnterpriseCodingPlanCreateOrderRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse> {
    return this.post<EnterpriseCodingPlanCreateOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      "/subscription/enterprise/v2/order",
      { ...request },
    );
  }

// 待支付订单是建单超时后的唯一对账入口，必须是幂等 GET。
  async getEnterprisePendingOrders(): Promise<EnterpriseCodingPlanPendingOrder[]> {
    const url = new URL(
      `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/orders/pending`,
    );
    return this.get<EnterpriseCodingPlanPendingOrder[]>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      url,
    );
  }

// orderNo 必须 encodeURIComponent：订单号可能含 / 或空格，未编码会拼出错误路径并命中别的接口。
  async cancelEnterpriseOrder(
    request: EnterpriseCodingPlanCancelOrderRequest,
  ): Promise<EnterpriseCodingPlanCancelOrderResponse> {
    return this.post<EnterpriseCodingPlanCancelOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      `/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/cancel`,
      {},
    );
  }

// 继续支付复用已有订单号，是幂等的「重新发起支付」，不会修改订单金额。
  async continueEnterpriseOrderPayment(
    request: EnterpriseCodingPlanContinuePayRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse> {
    return this.post<EnterpriseCodingPlanCreateOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      `/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/pay`,
      {},
    );
  }

// 订单状态查询供前端轮询，语义与 checkPayment 一致：只读、不缓存、不重试。
  async checkEnterpriseOrderStatus(
    request: EnterpriseCodingPlanOrderStatusRequest,
  ): Promise<EnterpriseCodingPlanOrderStatusResponse> {
    const url = new URL(
      `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/status`,
    );
    return this.get<EnterpriseCodingPlanOrderStatusResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      url,
    );
  }

// 四个私有发送器只做三件事：解析 endpoint（决定 host 与鉴权头）、发请求、解包 envelope。
// 业务方法不得绕过它们直接调 apiClient，否则会漏掉解包约定与错误映射（INV-01、INV-03）。
// dropUndefined 在此统一执行：远端把 null 与缺失视为不同语义，undefined 必须先剔除。
  private async post<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${BIGMODEL_CODING_PLAN_API_PREFIX}${path}`,
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
        body: JSON.stringify(dropUndefined(body)),
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

// GET 不发送 body；timeoutMs 与 POST 共用同一常量，保证前端超时预期一致。
  private async get<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    url: URL,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(this.apiClient, url, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: endpoint.headers,
    });
    return unwrapEnvelope(payload, endpoint.providerId);
  }

// assertZaiPaymentProvider 在每个 Z.ai 支付调用点各跑一次，而不是只在构造时校验：
// providerId 来自每次请求入参、运行时可变，构造期校验覆盖不到。
  private async postZaiPay<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    assertZaiPaymentProvider(endpoint.providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${ZAI_CODING_PLAN_PAY_API_PREFIX}${path}`,
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
        body: JSON.stringify(dropUndefined(body)),
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

// 与 postZaiPay 对称；解包仍走同一个 unwrapEnvelope，保证错误文案按 provider 区分。
  private async getZaiPay<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    assertZaiPaymentProvider(endpoint.providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${ZAI_CODING_PLAN_PAY_API_PREFIX}${path}`,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

// [并发] client/configs 是唯一的共享缓存点，读顺序为：命中快照 → 复用在途请求 → 新建请求。
// 三条不变量：
// - INV-04：snapshot 与 expiresAt 必须同一时刻写入；
// - INV-05：在途请求只允许一个，多调用方共享同一个 Promise 引用；
// - 无论成功失败，finally 必清 clientConfigRequest，否则一次失败会让所有调用方永久拿到
//   被拒绝的 Promise，配置通道再也不会恢复。
  private async getClientConfigs(): Promise<ZCodeClientConfigEnvelope> {
// 用 > 而不是 >=：expiresAt 恰好等于当前时刻视为过期，避免在边界上返回刚失效的快照。
    if (this.clientConfigSnapshot && this.clientConfigSnapshotExpiresAt > Date.now()) {
      return this.clientConfigSnapshot;
    }
// [并发] 复用而非新建：返回的是同一个 Promise 引用，调用方无法感知是否由自己发起。
// 这里不 catch：错误必须传播给所有等待者，让各自调用方按自己的策略降级。
    if (this.clientConfigRequest) {
      return await this.clientConfigRequest;
    }

    // client/configs 和其他 ZCode 平台接口必须共享运行时 endpoint；
    // E2E/测试环境会通过 ZCODE_BASE_URL 指向本地 mock，硬编码线上域名会让套餐状态不可控。
// 必须经 resolveCodingPlanClientConfigUrl 构造：内部走 buildRuntimeZCodeApiUrl，
// E2E/测试的 ZCODE_BASE_URL 覆盖才能生效。
// 这里读 process.env 而不是注入的 env：provider 实例不持有环境副本。
    const url = resolveCodingPlanClientConfigUrl(process.env);
    url.searchParams.set("app_version", ZCODE_VERSION);
    url.searchParams.set("platform", resolveClientPlatformKey());
    // StartPlanCard 和套餐列表都来自同一个 client/configs。
    // 同屏分别读取 preview/products 时必须合并请求，避免未登录设置页重复打远端配置。
// 先赋值再 await：赋值与 await 之间没有让出点，因此不存在两个调用方同时新建请求的窗口。
    this.clientConfigRequest = readCodingPlanApiJson<ZCodeClientConfigEnvelope>(
      this.apiClient,
      url,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    try {
      const payload = await this.clientConfigRequest;
      this.clientConfigSnapshot = payload;
      this.clientConfigSnapshotExpiresAt = Date.now() + CLIENT_CONFIG_CACHE_TTL_MS;
      return payload;
// [资源] 释放在途请求槽位。清空必须无条件执行：成功时快照已写入，失败时留给下一次重试；
// 若只在成功分支清空，一次失败会让 clientConfigRequest 永远指向被拒绝的 Promise。
    } finally {
      this.clientConfigRequest = null;
    }
  }

// 寻址与鉴权一起决定，调用方拿到即用（INV-01）。
// 缺省 providerId 归一为 bigmodel 个人版：历史调用点都不传 providerId，默认值必须保持兼容。
  private async resolveEndpointConfig(
    providerId: CodingPlanSubscriptionProviderId | undefined,
  ): Promise<CodingPlanEndpointConfig> {
// 缺省 providerId 归一为 bigmodel 个人版：历史调用点都不传，默认值必须保持兼容。
// 归一后只做一次 family 判断，避免下游每个头构造函数各判一次导致分支漂移。
    const normalizedProviderId =
      providerId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
// Z.ai 分支：域、令牌键、鉴权头三者必须同源，任一取错都会 401。
// [并发] loadZaiAuthorization 只做本地读、不触发刷新；并发请求各读一次，
// 但读到的是同一个已落盘值，因此不会产生两套鉴权。
    if (isZaiCodingPlanProviderId(normalizedProviderId)) {
      const authorization = await this.loadZaiAuthorization();
      return {
        providerId: normalizedProviderId,
        host: resolveZaiCodingPlanHost(),
        headers: createZaiLoginAuthHeaders(authorization),
      };
    }

// 只有 BigModel 分支读 bigmodel 令牌；zai 分支在上面已 return，不会误读另一个 family。
// 该调用可能抛 bigmodel_oauth_required，此处不捕获，交由上层映射成登录提示。
    const token = await this.loadBigModelAccessToken();
    return {
      providerId: normalizedProviderId,
      host: resolveBigModelApiOrigin(process.env),
      headers: createBigModelLoginAuthHeaders(token),
    };
  }

// BigModel 业务令牌只从这里读，键固定为 oauth:bigmodel:access_token。
// 读不到即抛 bigmodel_oauth_required 而不是返回空串：空串会发出无鉴权请求，远端 401 后
// 文案变成「令牌过期」，把用户引向错误的自助修复路径。
  private async loadBigModelAccessToken(): Promise<string> {
    const token = (
      await this.credentialService.load(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`)
    )?.trim();
    if (!token) {
      throw new Error("bigmodel_oauth_required");
    }
    const zcodeJwtToken = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim();
// [失败路径] 旧版 OAuth callback 曾把 zcode JWT 同时写进 oauth:bigmodel:access_token。
// 两个键值相同只可能是这种污染状态（正常登录两者不同源），因此在服务边界拦截，
// 不再向 bigmodel.cn 发送错误凭据——否则付费预览稳定报令牌过期且无法自愈（INV-06）。
    if (zcodeJwtToken && token === zcodeJwtToken) {
      // 旧版 BigModel OAuth callback 曾把 zcode JWT 同时写进
      // oauth:bigmodel:access_token，付费套餐预览会拿它去打 bigmodel.cn 并报令牌过期。
      // 这里在服务边界拦截旧污染状态，避免继续向 BigModel 业务接口发送错误凭据。
// warn 而非 error：这是可自愈的历史数据问题，用户重新登录即可，不需要告警升级。
// 日志不带 token 值本身，避免把凭据写进日志。
      log.warn(undefined, "BigModel access token is stale zcode JWT; login required");
      throw new Error("bigmodel_oauth_required");
    }
    return token;
  }

// 企业 pricing 补全流程，决定「已登录用户能否看到团队套餐入口」：
// 1) 已有 subscribed 且都带 org/project → 直接预热 api key 返回（快路径）；
// 2) 否则拉 customerInfo，按 projectType=2 找回团队项目；
// 3) 有 subscribed 时按 org/project 匹配，没有时先选 fallback 商品反向标记；
// 4) 最后统一预热 api key 并回写状态。
// 步骤 2 失败向上抛：拿不到团队项目就给不出连接方式，返回半成品会让 UI 展示不可用入口。
  protected async enrichEnterprisePricingTeamProjects(
    response: EnterpriseCodingPlanPricingResponse,
  ): Promise<EnterpriseCodingPlanPricingResponse> {
// 空商品列表直接返回：后续步骤都依赖商品上的 org/project，空表没必要再打 customerInfo。
// 这是唯一一个「不补全也不报错」的提前返回。
// [权衡] 不返回带 apiKeyStatus 的空数组，保持引用与入参一致。
    if (response.productList.length === 0) {
      return response;
    }
// 存在任意 subscribed 商品即认为账号已有企业订阅。两个判据基于同一份 productList，
// 中间没有 await，因此不会出现「有订阅」与「缺上下文」互相矛盾的结果。
// [权衡] 不用一次遍历算出全部判据：分开写更容易看出快路径条件。
    const hasSubscribedProduct = response.productList.some(
      (product) => product.subscribed === true,
    );
    const hasSubscribedProductMissingProjectContext = response.productList.some(
      (product) =>
        product.subscribed === true &&
        (!product.projectId?.trim() || !product.organizationId?.trim()),
    );
// 快路径：pricing 已给全上下文时不再拉 customerInfo，省一次网络往返。
// 条件是「存在 subscribed」且「没有任何一个 subscribed 缺 org/project」；缺一个就必须走慢路径，
// 否则多机构账号里缺上下文的那部分商品永远补不上。
    if (hasSubscribedProduct && !hasSubscribedProductMissingProjectContext) {
      const apiKeyStatuses = await this.ensureSubscribedTeamPlanProjectApiKeys(
        response,
        await this.loadFamilyEnterpriseToken(),
      );
      return applyTeamPlanProjectApiKeyStatuses(response, apiKeyStatuses);
    }

    const token = await this.loadFamilyEnterpriseToken();
    const host = this.resolveFamilyEnterpriseHost();
// 直接读 apiClient 而非 this.get：customerInfo 必须与 pricing 打到同一 family host，
// 且这里已持有 token，避免再读一次凭据后两次请求用了不同 token。
    const customerInfo = await readCodingPlanApiJson<RemoteEnvelope<BigModelCustomerInfoResponse>>(
      this.apiClient,
      `${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/customer/getCustomerInfo`,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: this.createFamilyEnterpriseAuthHeaders(token),
      },
    );
// customerInfo 可能为 null（无机构），提取函数对空值安全，这里不抛错：
// 这里只做附加：teamProjects 为空时 response 引用原样返回，不新建 envelope。
// 只有请求本身失败（readCodingPlanApiJson 抛错）才向上传播。
    const teamProjects = resolveBigModelTeamProjects(customerInfo.data);
    if (teamProjects.length === 0) {
      return response;
    }
// [权衡] 已有 subscribed 时不做 fallback：宁可少标一个入口，也不能把未购套餐伪装成已订阅。
// 只有「一个 subscribed 都没有」才启用，因为测试环境账号 pricing 全为 false 而 customerInfo
// 已有团队项目，此时 customerInfo 是更可靠的已购凭据。
    const fallbackSubscribedProductId = hasSubscribedProduct
      ? null
      : (resolveFallbackEnterpriseTeamPlanProduct(response.productList)?.productId ?? null);

// 不修改入参 response：pricing 结果可能被上层持有或被多处共享，
// 原地写会让「未补全」与「已补全」两种视图混在同一个对象上。
// 这里只重建 productList，其余字段保持原引用。
    const enrichedResponse = {
      ...response,
      productList: response.productList.map((product) => {
// 只补全 subscribed 商品（或 fallback 选中的那一个）：给未购商品塞团队项目会让列表出现
// 重复的「已连接」入口。
        const shouldEnrichProduct =
          product.subscribed === true ||
          (fallbackSubscribedProductId !== null &&
            product.productId === fallbackSubscribedProductId);
        if (!shouldEnrichProduct) {
          return product;
        }
// 商品与团队项目是多对多关系：一个机构下可能有多个项目，全部带回给 UI 供用户选择。
// 匹配不到时原样返回商品，不臆造 projectId。
        const matchedTeamProjects = resolveProductTeamProjects(product, teamProjects);
        if (matchedTeamProjects.length === 0) {
          return product;
        }
// 取首项作为商品主展示的 org/project。
// [权衡] 不再按 projectType 或创建时间排序：远端顺序即其推荐顺序，
// 本地重排会让多机构账号的默认项目与官网不一致。
        const primaryProject = matchedTeamProjects[0];
        return {
          ...product,
          // 企业 pricing 的 subscribed 商品只返回 productId/tier，不返回 org/project。
          // 有些账号只返回 organizationId，不返回 projectId；必须继续读取 customerInfo.organizations 数组，
          // 并按机构匹配团队项目，否则多机构账号会漏掉真实 Team Plan 连接方式。
          // 另有测试环境账号 pricing 全部返回 subscribed=false，但 customerInfo 已有 projectType=2 团队项目；
          // 此时 customerInfo 是更可靠的已购凭据，需要反向补出当前团队套餐入口。
          organizationId: primaryProject?.organizationId ?? product.organizationId,
          organizationName: primaryProject?.organizationName ?? product.organizationName,
          projectId: primaryProject?.projectId ?? product.projectId,
          projectName: primaryProject?.projectName ?? product.projectName,
          teamProjects: matchedTeamProjects,
          subscribed: true,
        };
      }),
    };
    const apiKeyStatuses = await this.ensureSubscribedTeamPlanProjectApiKeys(
      enrichedResponse,
      token,
    );
    return applyTeamPlanProjectApiKeyStatuses(enrichedResponse, apiKeyStatuses);
  }

// 团队项目 api key 预热，约定：
// - 只处理 subscribed 商品上的团队项目，去重键为 org + project；
// - 串行执行：并发建 key 会触发远端限流，且单项失败信息互相淹没；
// - 单项失败降级为 unavailable + reason，不中断其余项目（INV-07）。
  protected async ensureSubscribedTeamPlanProjectApiKeys(
    response: EnterpriseCodingPlanPricingResponse,
    token: string,
  ): Promise<Map<string, TeamPlanProjectApiKeyPrewarmStatus>> {
// 预热范围取自「已订阅商品」而不是 pricing 全表：给未购套餐建 key 会浪费远端写配额，
// 也可能让用户看到并不属于它的团队项目。
// 集合内部已按 org+project 去重，因此这里可以直接顺序遍历。
    const teamContexts = collectSubscribedTeamPlanProjectContexts(response.productList);
// 以 org+project 为键聚合结果；空 Map 表示没有需要预热的项目，回写阶段据此直接返回原响应。
// 不用数组：回写时按商品/项目逐个查表，键查找避免 O(n*m)。
    const statuses = new Map<string, TeamPlanProjectApiKeyPrewarmStatus>();
    if (teamContexts.length === 0) {
      return statuses;
    }
    const host = this.resolveFamilyEnterpriseHost();
// 一次请求只记一条 started：团队数量放在字段里，不要为每个项目各记一条。
// info 级别用于生产可观测的一次性初始化事件。
    log.info(undefined, "Team Plan project api key prewarm started", {
      family: this.codingPlanProviderId(),
      teamProjectCount: teamContexts.length,
    });
// 顺序 await 而非 Promise.all：失败隔离需要逐项捕获；团队数量是个位数，串行代价可接受。
    for (const teamContext of teamContexts) {
      try {
// [资源] 该调用会读/建远端 api key，属有副作用的写操作。这里不自行重试：
// 一次页面加载打出多倍写请求的代价远大于偶发失败。
// diagnostics 只进日志，不进入 UI 文案。
        const result = await ensureBigModelTeamPlanProjectApiKeyWithStatus({
          apiClient: this.apiClient,
          authorization: token,
          host,
          teamContext,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        log.info(undefined, "Team Plan project api key prewarm result", {
          family: this.codingPlanProviderId(),
          diagnostics: result.diagnostics,
          organizationId: teamContext.organizationId,
          projectId: teamContext.projectId,
          status: result.status,
        });
        statuses.set(
          createTeamPlanProjectStatusKey(teamContext),
          createTeamPlanProjectApiKeyPrewarmStatusFromEnsureResult(result),
        );
      } catch (error) {
        // 多团队套餐每个项目都需要独立 zcode-team-api-key。
        // 单个团队项目创建失败不能阻断 pricing 返回，否则会让其他团队入口一起不可见。
// 失败按项目逐条记录 org/project，便于定位多机构账号里的具体项目。
// 这里只 warn 不抛：单个项目不可用不应阻断整页 pricing（INV-07）。
// 错误消息进日志但不进 UI 文案，UI 只看 reason 字段。
        log.warn(undefined, "Team Plan project api key prewarm failed", {
          family: this.codingPlanProviderId(),
          organizationId: teamContext.organizationId,
          projectId: teamContext.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
// 失败也写一条 unavailable，而不是跳过：跳过会让回写阶段查不到状态，
// UI 会把这项目当成「未预热」而不是「不可用」，用户看到可点击但没有反应的入口。
// reason 固定 request_failed，message 保留原始错误便于排查。
        statuses.set(createTeamPlanProjectStatusKey(teamContext), {
          status: "unavailable",
          reason: "request_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return statuses;
  }

// Z.ai 业务 JWT 与 BigModel 完全隔离：键不同、域不同、不加 Bearer。
// 读不到抛 zai_oauth_required，让上层按「未登录」处理而不是发出匿名请求。
  protected async loadZaiAuthorization(): Promise<string> {
    const token = (
      await this.credentialService.load(`oauth:${ZAI_PROVIDER_ID}:access_token`)
    )?.trim();
    if (!token) {
      throw new Error("zai_oauth_required");
    }

    return token;
  }
}

// 导出给测试与 E2E 复用，保证「客户端实际请求的地址」与断言用的是同一个构造函数。
export function resolveCodingPlanClientConfigUrl(env: NodeJS.ProcessEnv): URL {
// 使用传入的 env 而非 process.env：单测可注入自定义环境而不改全局。
// 返回 URL 对象，便于调用方继续追加 app_version/platform 查询参数。
  return new URL(buildRuntimeZCodeApiUrl(env, ZCODE_CLIENT_CONFIG_API_PREFIX));
}

// fallback 商品选择：PRO > 一次性 > 月付，取分数最高者。
// 这是启发式而非协议约定，只用于「pricing 全为未订阅但 customerInfo 有团队项目」的场景，
// 因此权重差距必须显著（100/20/10），避免把两个商品判成等价。
function resolveFallbackEnterpriseTeamPlanProduct(
  products: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanPricingProduct | null {
  let selected: EnterpriseCodingPlanPricingProduct | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (const product of products) {
    const score = getEnterpriseTeamPlanFallbackProductScore(product);
    if (score > selectedScore) {
      selected = product;
      selectedScore = score;
    }
  }
  return selected;
}

// 把预热结果回写到 pricing 视图。statuses 为空时直接返回原对象，
// 保持引用不变以便上层做浅比较，避免无意义的重渲染。
function applyTeamPlanProjectApiKeyStatuses(
  response: EnterpriseCodingPlanPricingResponse,
  statuses: Map<string, TeamPlanProjectApiKeyPrewarmStatus>,
): EnterpriseCodingPlanPricingResponse {
  if (statuses.size === 0) {
    return response;
  }
  return {
    ...response,
    productList: response.productList.map((product) =>
      applyTeamPlanProjectApiKeyStatus(product, statuses),
    ),
  };
}

// 商品级与项目级状态都要写：商品上的字段供列表渲染，teamProjects 上的字段供展开后的项目列表。
function applyTeamPlanProjectApiKeyStatus(
  product: EnterpriseCodingPlanPricingProduct,
  statuses: Map<string, TeamPlanProjectApiKeyPrewarmStatus>,
): EnterpriseCodingPlanPricingProduct {
  const teamProjects = product.teamProjects?.map((project) =>
    applyTeamPlanProjectContextApiKeyStatus(project, statuses),
  );
  const productStatus = getTeamPlanProjectApiKeyStatus(
    {
      organizationId: product.organizationId ?? "",
      projectId: product.projectId ?? "",
    },
    statuses,
  );
  return {
    ...product,
    ...(teamProjects ? { teamProjects } : {}),
    ...(productStatus ? createTeamPlanProjectApiKeyStatusFields(productStatus) : {}),
  };
}

// 查不到状态时原样返回同一对象引用，不构造等价新对象，避免下游浅比较失效。
function applyTeamPlanProjectContextApiKeyStatus(
  project: EnterpriseCodingPlanProjectContext,
  statuses: Map<string, TeamPlanProjectApiKeyPrewarmStatus>,
): EnterpriseCodingPlanProjectContext {
  const status = getTeamPlanProjectApiKeyStatus(project, statuses);
  if (!status) {
    return project;
  }
  return {
    ...project,
    ...createTeamPlanProjectApiKeyStatusFields(status),
  };
}

// available 时必须把 reason/message 显式置 null：残留上一次失败的字段会让 UI 展示错误的不可用原因。
function createTeamPlanProjectApiKeyStatusFields(
  status: TeamPlanProjectApiKeyPrewarmStatus,
): Pick<
  EnterpriseCodingPlanProjectContext,
  "apiKeyStatus" | "apiKeyUnavailableReason" | "apiKeyUnavailableMessage"
> {
  return {
    apiKeyStatus: status.status,
    apiKeyUnavailableReason: status.status === "unavailable" ? (status.reason ?? null) : null,
    apiKeyUnavailableMessage: status.status === "unavailable" ? (status.message ?? null) : null,
  };
}

// org 或 project 缺失时返回 null 而不是查空键：空键会命中冒号拼接出的伪组合，
// 把某个团队的状态错配到没有上下文的商品上。
function getTeamPlanProjectApiKeyStatus(
  project: Pick<EnterpriseCodingPlanProjectContext, "organizationId" | "projectId">,
  statuses: Map<string, TeamPlanProjectApiKeyPrewarmStatus>,
): TeamPlanProjectApiKeyPrewarmStatus | null {
// 入参可能来自远端 JSON（null 或缺失），统一 trim 成可比较字符串。
// 空串表示「无法定位」，调用方据此跳过而不是拼出一个空键。
  const organizationId = project.organizationId?.trim() ?? "";
  const projectId = project.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return null;
  }
  return statuses.get(createTeamPlanProjectStatusKey({ organizationId, projectId })) ?? null;
}

// 把预热结果归一成 UI 可判定的两态：有 apiKey 即 available；否则按远端文案区分
// 「无有效团队授权」与「请求失败」，前者引导重新授权，后者可重试。
function createTeamPlanProjectApiKeyPrewarmStatusFromEnsureResult(
  result: BigModelTeamPlanApiKeyEnsureResult,
): TeamPlanProjectApiKeyPrewarmStatus {
  if (result.apiKey) {
    return { status: "available" };
  }
  return {
    status: "unavailable",
    reason: isNoValidTeamPlanAuthorizationMessage(result.diagnostics.create?.msg)
      ? "no_valid_team_plan_authorization"
      : "request_failed",
    message: result.diagnostics.create?.msg ?? result.diagnostics.list.msg ?? null,
  };
}

// 键格式必须与 collectSubscribedTeamPlanProjectContexts 的去重键语义一致（org + project）。
// 两侧都先 trim：远端可能给出带空白的 id，不 trim 会写进去却读不出来。
function createTeamPlanProjectStatusKey(
  project: Pick<EnterpriseCodingPlanProjectContext, "organizationId" | "projectId">,
): string {
  return `${project.organizationId.trim()}:${project.projectId.trim()}`;
}

// 只能按远端中文文案识别：该接口没有稳定错误码。文案变化只会退化为 demand 重试，不会误判成功。
function isNoValidTeamPlanAuthorizationMessage(message: string | null | undefined): boolean {
  return Boolean(message?.includes("暂无有效的团队套餐授权记录"));
}

// 打分只用于排序，不参与订购判断；新增维度时要保证权重不重叠，否则顺序退化成未定义。
function getEnterpriseTeamPlanFallbackProductScore(
  product: EnterpriseCodingPlanPricingProduct,
): number {
  let score = 0;
  if (product.tier === "PRO") {
    score += 100;
  }
  if (product.subscribeMode === "ONE_TIME") {
    score += 20;
  }
  if (product.subscribePeriod === "MONTHLY") {
    score += 10;
  }
  return score;
}

// 匹配采用「已知维度才比较」：商品只有 organizationId 时匹配该机构下全部团队项目；
// 两个都缺时返回全部，此时无法收窄，交由调用方取首项。
function resolveProductTeamProjects(
  product: EnterpriseCodingPlanPricingProduct,
  teamProjects: EnterpriseCodingPlanProjectContext[],
): EnterpriseCodingPlanProjectContext[] {
  const organizationId = product.organizationId?.trim() ?? "";
  const projectId = product.projectId?.trim() ?? "";
  return teamProjects.filter((project) => {
    if (organizationId && project.organizationId !== organizationId) {
      return false;
    }
    if (projectId && project.projectId !== projectId) {
      return false;
    }
    return true;
  });
}

// 收集需要预热的项目上下文。去重键用 \0 拼接而不是冒号，避免 id 本身含分隔符时
// 两个不同项目被判成同一个（例如 a:b 与 c 拼出的键，和 a 与 b:c 拼出的键相同）。
function collectSubscribedTeamPlanProjectContexts(
  products: readonly EnterpriseCodingPlanPricingProduct[],
): BigModelTeamPlanBizContext[] {
  const result: BigModelTeamPlanBizContext[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    if (product.subscribed !== true) {
      continue;
    }
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              projectId: product.projectId ?? null,
            },
          ];
    for (const projectContext of projectContexts) {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) {
        continue;
      }
      const key = `${organizationId}\0${projectId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ organizationId, projectId });
    }
  }
  return result;
}

// 从 customerInfo 提取团队项目：机构 id 或项目 id 为空即跳过，
// 因为下游预热与状态回写都要求两者齐全（见 getTeamPlanProjectApiKeyStatus）。
function resolveBigModelTeamProjects(
  customerInfo: BigModelCustomerInfoResponse | null | undefined,
): EnterpriseCodingPlanProjectContext[] {
  const result: EnterpriseCodingPlanProjectContext[] = [];
  for (const organization of customerInfo?.organizations ?? []) {
    const organizationId = organization.organizationId?.trim() ?? "";
    if (!organizationId) {
      continue;
    }
    for (const project of organization.projects ?? []) {
      const projectId = project.projectId?.trim() ?? "";
// 两个条件缺一不可：没有 projectId 无法建 key，projectType 不是 2 则不是团队套餐项目。
// 刻意不做名称匹配——名称会随改名/国际化变化（见 isBigModelTeamCodingPlanProject）。
// 跳过的项目不会进入结果集，因此也不会产生预热条目。
      if (!projectId || !isBigModelTeamCodingPlanProject(project)) {
        continue;
      }
      result.push({
        organizationId,
        organizationName: organization.organizationName ?? null,
        projectId,
        projectName: project.projectName ?? null,
      });
    }
  }
  return result;
}

// 判据只看 projectType=2，不看名称：团队项目改名或走国际化后名称会变，按名字匹配会漏选。
function isBigModelTeamCodingPlanProject(
  project: NonNullable<
    NonNullable<BigModelCustomerInfoResponse["organizations"]>[number]["projects"]
  >[number],
): boolean {
  // 团队套餐项目类型由 customerInfo.projectType 标识。
  // 不能写死项目名称，否则团队项目改名或国际化名称变化后会漏选。
  return String(project.projectType ?? "").trim() === "2";
}

// 导出以便其他模块复用同一套头，避免各处分叉后漏改；鉴权前缀错误只表现为 401，极难排查。
export function createBigModelLoginAuthHeaders(token: string): Record<string, string> {
  return {
    // BigModel 登录态业务接口要求 Authorization 直接传 accessToken。
    // 这里不能套 Bearer；Bearer 只适用于模型/API Key 类接口。
    Authorization: token,
    "Content-Type": "application/json",
  };
}

// 与 BigModel 版头内容相同，分开导出是为了让调用点显式表达「这是哪个 family」的令牌。
export function createZaiLoginAuthHeaders(token: string): Record<string, string> {
  return {
    // Z.ai provider connection 已把 access_token 持久化为业务 JWT。
    // 这里不能使用模型 API key，也不能给业务 JWT 添加 Bearer 前缀。
    Authorization: token,
    "Content-Type": "application/json",
  };
}

// 用于「只有 providerId、还没有 token」的场合（如 productInfo 先拼 URL 再由 this.get 取 token）。
function resolveCodingPlanHost(providerId: CodingPlanSubscriptionProviderId | undefined): string {
  return providerId && isZaiCodingPlanProviderId(providerId)
    ? resolveZaiCodingPlanHost()
    : resolveBigModelApiOrigin(process.env);
}

function resolveZaiCodingPlanHost(): string {
  // Z.ai Coding Plan 的 /api/biz 与 /api/pay 业务接口必须跟随产品环境。
  // 业务 token 必须发送到 .env 配置的 ZAI Business origin；未覆盖时默认 api.z.ai。
  return resolveZaiBusinessBaseUrl(process.env);
}

function resolveBigModelEnterpriseHost(): string {
  // 企业套餐 token 必须发送到 .env 配置的 BigModel origin；未覆盖时默认 bigmodel.cn，
  // 服务端返回空响应后被归一成系统繁忙。
  return resolveBigModelApiOrigin(process.env);
}

function resolvePreviewPath(providerId: CodingPlanSubscriptionProviderId | undefined): string {
  return providerId && isZaiCodingPlanProviderId(providerId) ? "/pay/zai-preview" : "/pay/preview";
}

// 抛错而不是静默改写 providerId：把 bigmodel 请求发到 zai 域会拿到难以归因的 404/401。
function assertZaiPaymentProvider(providerId: CodingPlanSubscriptionProviderId): void {
  if (!isZaiCodingPlanProviderId(providerId)) {
    throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
  }
}

// /api/biz 与 /api/pay 的统一解包器，成功判据依次为：
// 1) code 有值且不等于 200 → 失败（注意 code=0 在这里是失败，平台接口请用 unwrapClientConfig*）；
// 2) success === false → 失败（部分网关只回 success，没有 code）；
// 3) data 为 null/undefined → 失败，避免调用方拿到 null 后在 .map 处崩溃。
// 错误文案统一过 normalizeRemoteErrorMessage，保证 WAF/验证码场景有稳定错误码（INV-08）。
function unwrapEnvelope<T>(
  payload: RemoteEnvelope<T>,
  providerId: CodingPlanSubscriptionProviderId,
): T {
  if (payload.code !== undefined && payload.code !== 200) {
    throw new Error(normalizeRemoteErrorMessage(payload.msg, providerId, payload.code));
  }
  if (payload.success === false) {
    throw new Error(normalizeRemoteErrorMessage(payload.msg, providerId));
  }
  if (payload.data === null || payload.data === undefined) {
    const providerName = resolveCodingPlanProviderName(providerId);
    throw new Error(payload.msg?.trim() || `${providerName} response missing data`);
  }
  return payload.data;
}

// 目录键别名只在这一处换算：一旦把 builtin:* 带进运行时，provider 判定、凭据键拼接、
// 错误文案都会出现两套身份。
/** 旧服务端目录仍使用 builtin 键；只在配置边界转换，不能扩散成运行时身份别名。 */
function normalizeStaticProductProviderIds<T>(
  products: Partial<Record<CodingPlanSubscriptionProviderId, T[]>>,
): Partial<Record<CodingPlanSubscriptionProviderId, T[]>> {
  const normalized = { ...products };
  const raw = products as Record<string, T[]>;
  for (const [legacyId, currentId] of [
    ["builtin:bigmodel-coding-plan", BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan],
    ["builtin:zai-coding-plan", BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan],
  ] as const) {
    // 显式空数组表示关闭该目录；只有旧键不存在时才使用新键，不能用长度判断回退。
    if (Object.hasOwn(raw, legacyId)) normalized[currentId] = raw[legacyId];
    delete (normalized as Record<string, T[]>)[legacyId];
  }
  return normalized;
}

// 平台通道解包：code 缺失视为成功（本地 mock 可能只回 data），非 0 一律失败。
// 缺商品目录直接抛错，让 UI 回落到实时 pricing；返回空目录会让付费页看起来「没有套餐」。
function unwrapClientConfigProducts(
  payload: ZCodeClientConfigEnvelope,
): CodingPlanStaticProductsConfig {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
// 目录缺失与类型错误都抛错：静态目录是付费页的主数据源，
// 静默返回空对象会让页面显示「暂无套餐」，把配置故障伪装成业务结果。
// 返回前经 normalizeStaticProductProviderIds 做旧键换算。
  const products = payload.data?.configs?.codingPlanStaticProducts;
  if (!products || typeof products !== "object") {
    throw new Error("ZCode client config missing Coding Plan products");
  }
  return normalizeStaticProductProviderIds(products);
}

// 团队目录额外做整表校验：任一项形状不合法就整体失败，不过滤坏项。
// 团队目录直接决定团队订阅入口，部分合法会导致入口结构错乱、金额与权益错配。
function unwrapClientConfigTeamProducts(
  payload: ZCodeClientConfigEnvelope,
): CodingPlanStaticTeamProductsConfig {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
// 声明为 unknown 再逐项校验：远端配置没有编译期类型保障，
// 直接断言会让非法金额/周期静默进入下单参数。
// 校验通过后才做键别名换算。
  const products: unknown = payload.data?.configs?.codingPlanStaticTeamProducts;
  if (!products || typeof products !== "object") {
    throw new Error("ZCode client config missing Coding Plan team products");
  }
  for (const providerProducts of Object.values(products)) {
    if (
      !Array.isArray(providerProducts) ||
      !providerProducts.every(isCodingPlanStaticTeamProduct)
    ) {
      // 远端配置没有运行时类型保障；无效静态目录必须整体降级为读取失败，
      // 让 UI 继续使用实时 pricing 恢复团队订阅身份，不能在合并阶段抛错。
      throw new Error("ZCode client config has invalid Coding Plan team products");
    }
  }
  return normalizeStaticProductProviderIds(products as CodingPlanStaticTeamProductsConfig);
}

// 运行时校验必须与类型定义逐字段对齐：远端配置无 schema 保障，漏校验会让非法金额/周期
// 进入下单参数。新增字段时两侧要一起改。
function isCodingPlanStaticTeamProduct(value: unknown): value is CodingPlanStaticTeamProduct {
  if (!value || typeof value !== "object") {
    return false;
  }
  const product = value as Record<string, unknown>;
  return (
    isNonEmptyString(product.productId) &&
    isNonEmptyString(product.productName) &&
    (product.tier === "LITE" || product.tier === "PRO" || product.tier === "MAX") &&
    (product.subscribeMode === "CONTINUOUS" || product.subscribeMode === "ONE_TIME") &&
    (product.subscribePeriod === "MONTHLY" ||
      product.subscribePeriod === "QUARTERLY" ||
      product.subscribePeriod === "YEARLY") &&
    isNonEmptyString(product.purchaseMethodName) &&
    product.priceCurrency === "CNY" &&
    isValidCardCopyConfig(product.equity) &&
    isValidCardCopyConfig(product.description)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// 文案配置允许 undefined（不展示）与字符串/对象数组两种形态；其它形态一律视为目录非法。
function isValidCardCopyConfig(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isValidCardCopyConfigItem));
}

// 空字符串视为非法：远端用空串表示「不展示」时应该直接省略该项，否则会渲染出空白行。
function isValidCardCopyConfigItem(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    isNonEmptyString(item.text) && (item.tooltip === undefined || typeof item.tooltip === "string")
  );
}

// 折扣配置缺失返回 undefined（正常态），响应错误则抛异常：两者不能混，
// 否则网络故障会被 UI 当成「无折扣」静默展示原价。
function unwrapClientConfigBillingDiscount(
  payload: ZCodeClientConfigEnvelope,
): CodingPlanBillingDiscountConfig | undefined {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
  const configs = payload.data?.configs;
  if (!configs || !("codingPlanBillingDiscount" in configs)) {
    return undefined;
  }
  return configs.codingPlanBillingDiscount;
}

// unwrapClientConfigStartPlanPreview 只校验 code 与必要字段，单条权益异常过滤掉而不是整体返回 null。
function unwrapClientConfigStartPlanPreview(
  payload: ZCodeClientConfigEnvelope,
): StartPlanPreviewConfig | null {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }
// 缺失或为 null 都表示服务端未开启该能力，返回 null；
// 只有「存在但结构不对」才抛错，用于暴露配置错误。
  const preview = payload.data?.configs?.startPlanPreview;
  if (!preview) {
    return null;
  }
  if (
    typeof preview.planId !== "string" ||
    typeof preview.name !== "string" ||
    !Array.isArray(preview.entitlements)
  ) {
    throw new Error("ZCode client config invalid Start Plan preview");
  }
  return {
    planId: preview.planId,
    name: preview.name,
    entitlements: preview.entitlements.filter(isValidStartPlanPreviewEntitlement),
  };
}

// minimalVersion 为空或非字符串一律按「不强制更新」处理：配置写坏不能把用户锁在启动页。
function unwrapClientConfigForceUpdate(
  payload: ZCodeClientConfigEnvelope,
): ForceUpdateConfig | null {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "ZCode client config request failed");
  }

  const forceUpdate = payload.data?.configs?.forceUpdate;
  if (!forceUpdate) {
    return null;
  }

  const minimalVersion = forceUpdate.minimalVersion;
  if (typeof minimalVersion !== "string" || minimalVersion.trim() === "") {
    return null;
  }

  return { minimalVersion: minimalVersion.trim() };
}

// 只校验展示所需字段的类型；数值合法性交给展示层，避免这里过严导致预览整体为空。
function isValidStartPlanPreviewEntitlement(
  entitlement: StartPlanPreviewConfig["entitlements"][number],
): boolean {
  return (
    typeof entitlement?.grantUnits === "number" &&
    typeof entitlement.meter === "string" &&
    typeof entitlement.period === "string" &&
    typeof entitlement.showName === "string" &&
    typeof entitlement.unitType === "string"
  );
}

// 平台键用于远端按端下发配置（灰度/强制更新），格式需与其它端保持一致，不要改成自定义枚举。
function resolveClientPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

// 错误映射的唯一出口，顺序即优先级：
// 1) WAF/HTML 类不可渲染文案 → 系统繁忙；
// 2) 人机验证文案 → REQUEST_VERIFICATION_REQUIRED（UI 据此弹验证而非报错）；
// 3) 其余原样透传，缺失时用 provider 名 + code 兜底。
// 调换顺序会让验证码提示被吞成「系统繁忙」。
function normalizeRemoteErrorMessage(
  msg: string | undefined,
  providerId: CodingPlanSubscriptionProviderId,
  code?: number,
) {
  const message = msg?.trim();
// 不可渲染文案统一收敛成系统繁忙：既不把网关 HTML 泄露给 UI，也不让它决定展示什么。
// 只替换文案、不改变错误类型，调用方的 catch 逻辑不受影响。
  if (message && isUnrenderableRemoteErrorMessage(message)) {
    return CODING_PLAN_SYSTEM_BUSY;
  }
// 人机验证优先于「原样透传」：UI 收到固定码才会弹验证面板，
// 否则用户只看到一句无法操作的服务端文案。
// 该判断放在兜底之前，且与 WAF 判断互斥（两类文案不重叠）。
  if (message && isRequestVerificationMessage(message)) {
    return REQUEST_VERIFICATION_REQUIRED;
  }
  const providerName = resolveCodingPlanProviderName(providerId);
  return message || `${providerName} request failed${code ? `: ${code}` : ""}`;
}

// 所有 Coding Plan 远端请求的唯一 HTTP 入口：负责超时、WAF 收敛与错误归一。
// 只改写「不可渲染」这一类错误，其余原样抛，保留 401/403 等语义供上层识别。
async function readCodingPlanApiJson<T>(
  apiClient: ApiClient,
  input: string | URL,
  init?: ApiRequestInit,
): Promise<T> {
  try {
    return await readApiJson<T>(apiClient, input, init);
  } catch (error) {
// readRemoteErrorMessage 兼容 Error、带 message 的对象与原始值：
// ApiClient 在不同传输层抛出的形状不一致，统一取字符串后才能做 WAF 判定。
// 判定不成立时原样 rethrow，保留原始错误对象与堆栈。
    const message = readRemoteErrorMessage(error);
    if (isUnrenderableRemoteErrorMessage(message)) {
      // 支付接口偶发返回 WAF/HTML 页面或非 JSON 响应，原样透传会把整段
      // HTML 渲到确认支付页。服务边界先收敛为稳定错误码，UI 再做本地化提示。
// 只改写这一类错误：401/403 等语义必须原样上抛，
// 上层要靠它们区分「需要重新登录」与「服务暂不可用」。
      throw new Error(CODING_PLAN_SYSTEM_BUSY);
    }
    throw error;
  }
}

// 提取顺序：Error.message → Error.name → 对象上的 message → String(error)。
// message 为空时退回 name，避免把所有此类错误都归成空串而漏掉 WAF 特征。
function readRemoteErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

// 判据覆盖三类真实故障：网关返回 HTML 页、阿里云 WAF 拦截页、JSON 解析失败的固定文案。
// 只做字符串判定不尝试解析内容——目的是给 UI 稳定文案，而不是还原故障原因。
function isUnrenderableRemoteErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
// 先看 doctype 前缀，再用带词边界的标签正则，避免用户文案里出现 html 字样就误判。
// 末尾几条是 JSON 解析失败的固定英文文案。
// 阿里云 WAF 拦截页会同时带 errors.aliyun.com 与 request has been blocked 两个特征串。
    normalized.startsWith("<!doctype") ||
    /<\s*(html|head|body|script|style|title|meta)\b/.test(normalized) ||
    normalized.includes("errors.aliyun.com") ||
    normalized.includes("request has been blocked") ||
    normalized.includes("unexpected token '<'") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("invalid json response")
  );
}

// 错误文案的主体名由 family 决定，不要写死 BigModel：Z.ai 用户看到错误主体错误会更困惑。
function resolveCodingPlanProviderName(providerId: CodingPlanSubscriptionProviderId): string {
  return isZaiCodingPlanProviderId(providerId) ? "Z.ai" : "BigModel";
}

// 远端把「字段缺失」与「字段为 null」当不同语义：null 显式表示清空，undefined 表示不传。
// JSON.stringify 会把 undefined 丢成缺失，这里先剔除，保证两者不被混淆。
function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/**
 * 闲时任务灰度判据（纯函数供单测）：远端只提供曝光开关，模型成员和事实
 * 来自 ZCode Built-in Provider / Model Config。
 * mock 模式（ZCODE_OFFPEAK_MOCK=1）只替代产品曝光与套餐状态；模型候选仍来自 Registry。
 */
// 纯函数，供单测直接调用：远端只提供曝光开关，模型成员与套餐事实来自别处。
// mock 模式只替代产品曝光与套餐状态，模型候选仍来自 Registry（hasModels 判断）。
export function resolveOffPeakClientConfig(
  payload: ZCodeClientConfigEnvelope,
  env: NodeJS.ProcessEnv,
  modelSelectionView: ModelSelectionView = EMPTY_OFF_PEAK_MODEL_SELECTION_VIEW,
): OffPeakClientConfig {
// 灰度只控制「是否暴露」，能否真正执行还要看有没有可用模型：
// 远端打开开关但没有模型时仍然关闭，避免用户进入一个空列表。
// some 而非 find：只关心存在性，不消费匹配项。
  const hasModels = modelSelectionView.providers.some((provider) => provider.models.length > 0);
  if (env["ZCODE_OFFPEAK_MOCK"] === "1") {
    return {
      enabled: hasModels,
      modelSelectionView,
      // ZCODE_OFFPEAK_MOCK_NO_PLAN=1 演示「非 coding plan 锁定」态；缺省视为已订阅。
      codingPlanActive: env["ZCODE_OFFPEAK_MOCK_NO_PLAN"] !== "1",
    };
  }
// 非 mock 分支：只有远端显式为 true 才启用，缺失或类型不符都按关闭处理（fail-closed）。
// 真实环境不返回 codingPlanActive：套餐状态由套餐接口决定，本函数不臆测。
// 这正是 mock 与真实分支字段不同的原因——mock 需要覆盖套餐锁定态。
  const raw = payload.data?.configs?.offPeak;
  return {
    enabled: raw?.enable_offpeak_task === true && hasModels,
    modelSelectionView,
  };
}

// 冻结的单例空视图：作为默认参数每次新建对象会让下游 useMemo/浅比较全部失效，
// 冻结同时防止调用方意外改写共享常量。
const EMPTY_OFF_PEAK_MODEL_SELECTION_VIEW: ModelSelectionView = Object.freeze({
  revision: 0,
  providers: Object.freeze([]),
});
