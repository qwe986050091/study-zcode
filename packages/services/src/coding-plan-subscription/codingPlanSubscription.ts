// 文件职责：Coding Plan 订阅的 RPC 契约，只声明方法与非实现细节；
// Host 实现通过 ServiceChannels.CodingPlanSubscription 绑定到该 descriptor。
// INV-01：只依赖 @zcode/shared 与 @zcode/provider 的类型，不 import 任何实现或宿主模块。
//   破坏后：Web 端打包会拖入 Node 依赖，UI 与 Host 发生实现耦合。
// INV-02：每个方法都必须有配对的请求/响应类型（守住位置：ICodingPlanSubscriptionService）。
//   破坏后：跨端字段漂移只能在运行期暴露，协议缺失运行时校验。
import type {
  RequestVerificationConfig,
  CodingPlanAgreementResponse,
  CodingPlanBatchPreviewRequest,
  CodingPlanBatchPreviewResponse,
  CodingPlanCreateSignRequest,
  CodingPlanPaymentCheckRequest,
  CodingPlanPaymentCheckResponse,
  CodingPlanPendingOrderCheckRequest,
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
  CodingPlanStaticProductsConfig,
  CodingPlanStaticTeamProductsConfig,
  CodingPlanPreviewRequest,
  CodingPlanPreviewResponse,
  CodingPlanStripeBindRequest,
  CodingPlanStripeBindResponse,
  CodingPlanStripeCard,
  CodingPlanStripePayRequest,
  CodingPlanStripePayResponse,
  CodingPlanStripeUnbindRequest,
  CodingPlanUpdateSignRequest,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanCancelOrderRequest,
  EnterpriseCodingPlanCancelOrderResponse,
  EnterpriseCodingPlanBalanceResponse,
  EnterpriseCodingPlanContinuePayRequest,
  EnterpriseCodingPlanOrderCalculateRequest,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanOrderStatusRequest,
  EnterpriseCodingPlanOrderStatusResponse,
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
  StartPlanPreviewConfig,
  ZCodeModelContextBudgetStrategy,
  ForceUpdateConfig,
  ManualClaimPlanPreviewSnapshot,
  ManualClaimPlanClaimRequest,
  ManualClaimPlanClaimResult,
  DynamicWorkflowClientConfig,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 闲时任务灰度配置的客户端视图：enabled 是远端开关折叠本地覆盖后的最终值，缺省 false；
// modelSelectionView 给出该灰度下允许的模型集合，缺省时 UI 回退到全量模型。
// codingPlanActive 仅供 mock 演示强制通道，真实路径不下发；把它当权益开关会让演示环境绕过校验。
export interface OffPeakClientConfig {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  /** mock 演示强制通道：真实路径不下发，UI 使用 Host 的 Account support。 */
  readonly codingPlanActive?: boolean;
}

// 服务边界：所有方法都以「用户已登录」为前提，未登录由调用方在进入前拦截，本接口不返回鉴权错误。
// 方法之间没有隐式顺序依赖；唯一例外是先 createSign/updateSign 再 checkPayment，由 UI 流程保证。
export interface ICodingPlanSubscriptionService {
  batchPreview(request?: CodingPlanBatchPreviewRequest): Promise<CodingPlanBatchPreviewResponse>;
  getStaticProducts(): Promise<CodingPlanStaticProductsConfig>;
  getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig>;
  // null 表示当前用户/环境下没有首购引导，属于正常结果而非错误；调用方不得把它当失败重试。
  getStartPlanPreview(): Promise<StartPlanPreviewConfig | null>;
  getManualClaimPlanPreviews(): Promise<ManualClaimPlanPreviewSnapshot>;
  claimManualPlan(request: ManualClaimPlanClaimRequest): Promise<ManualClaimPlanClaimResult>;
  /** 闲时任务灰度配置（D31）：forceRefresh 供入口打开时补拉（绕过 1h 快照缓存）。 */
  // [并发] forceRefresh 会绕过 1h 快照缓存并触发远端拉取；同一时刻多个入口同时强制刷新时，
  // 实现需自行合并请求，否则会放大启动瞬间的配置接口压力。
  getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig>;
  /**
   * 动态工作流灰度快照：远端 `configs.dynamicWorkflow.mode`
   * 与本地覆盖折叠后的结果；forceRefresh 绕过 1h 快照缓存。请求失败 fail-closed（disabled/default）。
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  /** 兼容接口：固定返回 preflight-v1，不读取远端配置或缓存。 */
  getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy>;
  // undefined 表示「当前没有任何生效折扣」，不是加载失败。
  // 不要用空对象代替：UI 依据 undefined 决定是否整块隐藏折扣区域。
  getBillingDiscount(): Promise<CodingPlanBillingDiscountConfig | undefined>;
  // null 表示该环境未开启请求校验；返回 null 时客户端必须跳过校验流程而不是失败重试，
  // 否则未配置校验的本地环境将无法完成订阅。
  getRequestVerificationConfig(): Promise<RequestVerificationConfig | null>;
  getForceUpdateConfig(): Promise<ForceUpdateConfig | null>;
  // productInfo 返回含实时价格的单品详情，preview 在其上叠加优惠与税费；
  // 两者必须用同一份远端商品配置，否则下单页展示价与实际扣款会不一致。
  productInfo(request: CodingPlanProductInfoRequest): Promise<CodingPlanProductInfo>;
  preview(request: CodingPlanPreviewRequest): Promise<CodingPlanPreviewResponse>;
  // 协议签署为幂等操作：已签用户重复调用应返回当前协议而不是报错，因此 UI 重试安全；
  // updateSign 用于协议版本升级后的补签。
  createSign(request: CodingPlanCreateSignRequest): Promise<CodingPlanAgreementResponse>;
  updateSign(request: CodingPlanUpdateSignRequest): Promise<CodingPlanAgreementResponse>;
  // 支付结果由客户端轮询获取，服务端不主动推送；实现必须容忍重复轮询，
  // 并保证「已开通」状态只做一次权益发放。
  checkPayment(request: CodingPlanPaymentCheckRequest): Promise<CodingPlanPaymentCheckResponse>;
  // 启动时补查未完成订单，覆盖「支付成功但页面已关闭」的断点；
  // 请求参数可省略即查全部渠道，返回空列表表示无待处理项。
  checkPendingOrders(
    request?: CodingPlanPendingOrderCheckRequest,
  ): Promise<CodingPlanPendingOrderCheckResponse>;
  // Stripe 绑卡信息只返回脱敏后的展示字段，不含任何可用于扣款的凭据；
  // bind/unbind 成功后由调用方重新 query 刷新列表，接口不返回新列表。
  queryStripeCards(request?: {
    providerId?: CodingPlanPreviewRequest["providerId"];
  }): Promise<CodingPlanStripeCard[]>;
  bindStripeCard(request: CodingPlanStripeBindRequest): Promise<CodingPlanStripeBindResponse>;
  unbindStripeCard(request: CodingPlanStripeUnbindRequest): Promise<string>;
  payStripe(request: CodingPlanStripePayRequest): Promise<CodingPlanStripePayResponse>;
  checkPaypalSupport(
    request?: CodingPlanPaypalSupportRequest,
  ): Promise<CodingPlanPaypalSupportResponse>;
  createPaypalSetupToken(
    request: CodingPlanPaypalSetupTokenRequest,
  ): Promise<CodingPlanPaypalSetupTokenResponse>;
  subscribePaypal(
    request: CodingPlanPaypalSubscribeRequest,
  ): Promise<CodingPlanPaypalSubscribeResponse>;
  // 企业版接口共用主体与管理员身份：pricing/balance 只读，calculateOrder 仅试算，
  // createOrder 才真正锁定席位与价格。企业订单与个人订阅互不影响，
  // UI 不得用个人 preview 结果拼接企业下单参数。
  getEnterprisePricing(
    request?: EnterpriseCodingPlanPricingRequest,
  ): Promise<EnterpriseCodingPlanPricingResponse>;
  getEnterpriseBalance(): Promise<EnterpriseCodingPlanBalanceResponse>;
  calculateEnterpriseOrder(
    request: EnterpriseCodingPlanOrderCalculateRequest,
  ): Promise<EnterpriseCodingPlanOrderCalculateResponse>;
  createEnterpriseOrder(
    request: EnterpriseCodingPlanCreateOrderRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  getEnterprisePendingOrders(): Promise<EnterpriseCodingPlanPendingOrder[]>;
  cancelEnterpriseOrder(
    request: EnterpriseCodingPlanCancelOrderRequest,
  ): Promise<EnterpriseCodingPlanCancelOrderResponse>;
  continueEnterpriseOrderPayment(
    request: EnterpriseCodingPlanContinuePayRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  checkEnterpriseOrderStatus(
    request: EnterpriseCodingPlanOrderStatusRequest,
  ): Promise<EnterpriseCodingPlanOrderStatusResponse>;
}

export const ICodingPlanSubscriptionService =
  createServiceDescriptor<ICodingPlanSubscriptionService>(ServiceChannels.CodingPlanSubscription);
