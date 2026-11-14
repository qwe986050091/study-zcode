// Coding Plan 订阅协议共享类型：统一定义个人、团队、企业订阅的报价、支付、领奖与订单 DTO 形状。
// 职责边界：本文件只做类型声明，不读环境、不发请求、不做归一化；唯一运行时常量是 CODING_PLAN_SYSTEM_BUSY。
// 归一化（provider 标识、金额口径、时间单位）由调用方承担，这里只把字段名、可空性与单位钉死，让错误在编译期暴露。
// 跨端共用：Desktop、Web、services、RPC 引用同一份类型，任何只对某一端成立的字段都不应塞进这里。
//
// INV-01 断言：provider 标识只能取 BUILTIN_MODEL_PROVIDER_IDS 中的六个编码计划枚举 —— 守住它的位置：CodingPlanSubscriptionProviderId 联合类型 —— 改错故障：拼错时类型不报错，界面静默落到错误套餐或空列表。
// INV-02 断言：境内支付与海外支付是两组渠道，不能合进同一字段 —— 守住它的位置：CodingPlanPayType 与 CodingPlanOverseasPaymentChannel 分开声明 —— 改错故障：海外渠道进入境内签名接口，服务端报不支持的支付方式。
// INV-03 断言：报价金额按整单与月均两套口径分别下发，不得互相推导 —— 守住它的位置：CodingPlanProductPreviewPayment 的金额字段全部可选 —— 改错故障：季付套餐被按月价回填，用户看到的价格只有实际的三分之一。
// INV-04 断言：canPurchase 与 canRepurchase 是三态，null 表示未判定 —— 守住它的位置：两个字段的 boolean 与 null 联合 —— 改错故障：未登录用户被提前禁用购买按钮，登录入口随之下沉。
// INV-05 断言：priceUnit 与 priceCurrency 必须成对出现且值域封闭 —— 守住它的位置：两个枚举字段声明在同一接口内 —— 改错故障：币种与周期错配，海外用户看到人民币年价。
// INV-06 断言：静态套餐表允许缺少某个 provider —— 守住它的位置：CodingPlanStaticProductsConfig 使用 Partial 映射 —— 改错故障：改成完整映射后编译期强推补全不存在的套餐，运行时读到 undefined。
// INV-07 断言：静态兜底套餐与接口报价的同名字段语义一致，0 不代表免费 —— 守住它的位置：CodingPlanStaticProduct 的金额字段保持可选 —— 改错故障：零元占位被渲染成免费套餐，下单时才发现真实价格。
// INV-08 断言：企业套餐币种固定为人民币 —— 守住它的位置：CodingPlanStaticTeamProduct 的 priceCurrency 字面量类型 —— 改错故障：企业定价被海外渠道覆盖后，订单按美元结算。
// INV-09 断言：权益的额度、计量器、周期是计量口径，展示名只用于渲染 —— 守住它的位置：StartPlanPreviewEntitlement 与 ManualClaimPlanEntitlement 的字段划分 —— 改错故障：用展示名反推单位，额度卡片出现两种单位混排。
// INV-10 断言：生效时间是 Unix 秒，服务端时间是毫秒 —— 守住它的位置：ManualClaimPlanPreviewSnapshot 与 ClaimResult 的字段注释 —— 改错故障：毫秒被当秒使用，权益生效时间被推到几万年之后。
// INV-11 断言：failureEndsAt 只表活动结束，不是已领权益期限 —— 守住它的位置：ManualClaimPlanClaimResult.failureEndsAt —— 改错故障：领取失败后界面显示已到期，用户误以为领到额度并反复点击。
// INV-12 断言：服务端原始商品与前端报价投影是两个模型，不能互相赋值 —— 守住它的位置：CodingPlanProductInfo 与 CodingPlanProductPreviewPayment 字段集合刻意不同 —— 改错故障：原始售价被当应付金额，优惠被重复扣减。
// INV-13 断言：优惠明细只做解释，金额以顶层应付为准 —— 守住它的位置：CodingPlanCampaignDiscountDetail 不提供合计字段 —— 改错故障：前端累加明细出现浮点误差，实付与订单不一致。
// INV-14 断言：企业订单状态是开放联合，未知状态不得抛错 —— 守住它的位置：EnterpriseCodingPlanPaymentStatus 末尾的 string —— 改错故障：服务端新增状态后订单页白屏。
// INV-15 断言：企业余额三段由服务端给出，前端不得自行相加 —— 守住它的位置：EnterpriseCodingPlanBalanceResponse 的合计字段 —— 改错故障：重算合计与扣款口径分叉，余额充足却支付失败。
// INV-16 断言：企业定价请求的 family 缺省按 bigmodel 兼容 —— 守住它的位置：EnterpriseCodingPlanPricingRequest.family 可选 —— 改错故障：旧调用点不传 family 时整块企业定价报错。
//
import type { RequestVerificationProof } from "./request-security-edition/verification-policy.js";
/* eslint-disable max-lines -- Coding Plan 订阅协议类型需要集中导出给 UI、services 和 RPC 共享，拆散会增加跨包类型入口复杂度。 */
import type { Locale } from "./protocol.js";
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type { BUILTIN_MODEL_PROVIDER_IDS } from "./model-provider-types.js";

// [契约] 境内支付只承认支付宝与微信两种渠道，海外渠道另立一组 STRIPE_PAY 与 PAYPAL_PAY。
// [权衡] 不把 CodingPlanPayType 与 CodingPlanOverseasPaymentChannel 并成一个大联合：签名接口分境内与海外两条链路，合并后每次调用都要再判组别。
// [失败路径] 若把海外渠道值塞进本类型，类型检查会放行，直到创建签名请求才由服务端报不支持的支付方式。
export type CodingPlanPayType = "ALI" | "WECHAT";
export type CodingPlanOverseasPaymentChannel = "STRIPE_PAY" | "PAYPAL_PAY";
export type CodingPlanSubscriptionProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
// [契约] 这是本文件唯一的运行时常量：服务端用该病态码区分系统繁忙与业务失败，前端据此决定是否放出重试入口。
// [契约] as const 不可省略，去掉后类型退化为 string，所有比较分支都会编译通过，病态码特判形同虚设。
// [权衡] 不要把其他错误码也搬到这里：错误码属于协议面，散落在类型文件中会让前后端各维护一份真相。
export const CODING_PLAN_SYSTEM_BUSY = "coding_plan_system_busy" as const;

// [契约] 不可用原因只有未登录与请求失败，二者在界面上的处置完全不同：前者引导登录，后者提示重试。
// [失败路径] 不要补一个 unknown 兜底值，多一个值就多一条无人处理的展示分支，最终表现为空白卡片。
export type CodingPlanUnavailableReason = "not_authenticated" | "request_failed";

// [契约] 这是下单前的报价投影，金额字段全部可选，缺字段表示该口径不适用，而不是价格为零。
// [契约] 金额按两套口径成组：originalAmount、discountAmount、payAmount 是整单口径，monthlyOriginalAmount 等三个月均字段由服务端单独给值。
// [契约] canPurchase 与 canRepurchase 是三态布尔，null 表示尚未判定，调用方不得把它当 false 去禁用按钮。
// [权衡] 月均金额不由前端用总价除以月数计算，服务端会按首期优惠与续费价差分别给值，除出来的数与账单对不上。
// [失败路径] 把缺失的 payAmount 填成 0，零元订单会绕过支付校验，进入一条没有支付单的订阅流程。
export interface CodingPlanProductPreviewPayment {
  productId: string;
  productName?: string;
  productBigTitle?: string;
  productSmallTitle?: string;
  productIntroduction?: string;
  productDescription?: string;
  relateResourcePack?: string;
  inCurrentPeriod?: boolean;
  lastValid?: boolean;
  effectiveTime?: string | null;
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  monthlyOriginalAmount?: number;
  monthlyRenewAmount?: number;
  monthlyPayAmount?: number;
  renewAmount?: number;
  canPurchase?: boolean | null;
  soldOut?: boolean;
  hasFirstTimeSubscriptionPromo?: boolean;
  delay?: boolean;
  canRepurchase?: boolean | null;
  forbidden?: boolean;
  campaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
  productEquityList?: CodingPlanProductEquity[] | null;
  priceUnit?: "month" | "quarter" | "year";
  // [契约] 币种与计费周期是同一份报价的两个维度，必须成对下发，缺任一维时界面只能展示区间而非确定价格。
  // [契约] priceUnit 只允许月、季、年三档，新增档位要先确认服务端按比例折算的口径。
  // [失败路径] 不要按 provider 名称硬编码币种，同一 provider 在不同销售渠道可能给出不同的结算币种。
  priceCurrency?: "CNY" | "USD";
}

// [契约] 静态权益只有标题与详情两段文本，是纯展示兜底，不含任何额度数字。
// [权衡] 不给它加 grantUnits，静态配置一旦携带额度，就会与 availability 接口的实时快照形成两个事实源。
export interface CodingPlanStaticProductEquity {
  productEquityTitle: string;
  productEquityDetails?: string;
}

export interface CodingPlanCardCopyItem {
  text: string;
  tooltip?: string;
}

// [契约] 运营文案允许写成纯字符串或带 tooltip 的对象，解析责任在展示层，类型层只约束形状。
// [权衡] 不在类型上强制统一成对象，历史配置全是字符串，强转会导致整批线上配置解析失败。
export type CodingPlanCardCopyConfigItem = string | CodingPlanCardCopyItem;

export interface CodingPlanStaticProduct {
  productId: string;
  productName: string;
  productSmallTitle?: string;
  equity?: CodingPlanCardCopyConfigItem[];
  description?: string | CodingPlanCardCopyConfigItem[];
  productEquityList?: CodingPlanStaticProductEquity[];
  priceUnit: "month" | "quarter" | "year";
  displayOrder: number;
  priceCurrency: "CNY" | "USD";
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  monthlyOriginalAmount?: number;
  monthlyRenewAmount?: number;
  monthlyPayAmount?: number;
  renewAmount?: number;
}

// [契约] 静态套餐按 provider 分桶，外层 Partial 表示这个 provider 没有静态兜底是合法状态。
// [契约] 改成 Record 是常见误改，它要求六个 provider 全部给值，而线上一直只配置了部分家族。
// [失败路径] 消费者必须自行判空，本文件不提供默认空数组，避免配置缺失与空套餐被混为一谈。
export type CodingPlanStaticProductsConfig = Partial<
  Record<CodingPlanSubscriptionProviderId, CodingPlanStaticProduct[]>
>;

// [契约] 企业静态套餐由档位、订阅模式、订阅周期三者共同决定商品唯一性，缺一个都无法定位到具体商品。
// [契约] purchaseMethodName 是给运营看的购买方式名，不能参与商品匹配。
// [失败路径] 不要把档位写成字符串，LITE、PRO、MAX 之外的值会让定价表查询返回空。
export interface CodingPlanStaticTeamProduct {
  productId: string;
  productName: string;
  tier: EnterpriseCodingPlanTier;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  purchaseMethodName: string;
  // [契约] CodingPlanStaticTeamProduct.priceCurrency 钉死为 "CNY"，这是业务事实而非漏写美元。
  // [契约] 企业定价与个人定价共用金额字段名，但币种域刻意更窄，调用方不得把两者互相赋值。
  // [失败路径] 改成人民币或美元双选后，企业订单计算会收到非法币种，金额按人民币算却按美元展示。
  priceCurrency: "CNY";
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  renewAmount?: number;
  equity?: CodingPlanCardCopyConfigItem[];
  description?: CodingPlanCardCopyConfigItem[];
}

export type CodingPlanStaticTeamProductsConfig = Partial<
  Record<CodingPlanSubscriptionProviderId, CodingPlanStaticTeamProduct[]>
>;

export interface CodingPlanBillingDiscountLocaleCopy {
  cardTitle?: string;
  cardBody?: string;
  badgeBody?: string;
  infoTitle?: string;
  infoBody?: string;
}

// [契约] 计费优惠文案按语言分桶，未配置的语言回落到默认文案，因此外层必须是 Partial。
// [契约] 末尾交叉任意键是为了兼容运营额外塞入的自定义键，读取方不得假设这些键有固定结构。
// [权衡] 不把未知键收窄成具体形状，配置由服务端下发，收窄后每次运营加字段都要客户端发版。
// [失败路径] 把外层改成完整的语言映射，缺一种语言就会让该语言用户看到空白优惠说明。
export type CodingPlanBillingDiscountConfig = Partial<
  Record<Locale, CodingPlanBillingDiscountLocaleCopy>
> &
  Record<string, unknown>;

// [契约] 体验包权益由额度、计量器、周期、展示名、单位类型五段组成，展示名只用于渲染。
// [契约] meter 与 unitType 是计量口径，grantUnits 是数量，三者不能被压缩成一个字符串。
// [失败路径] 用展示名反推单位会在多语言下失效，同一个权益在英文环境被显示成另一种单位。
export interface StartPlanPreviewEntitlement {
  grantUnits: number;
  meter: string;
  period: string;
  showName: string;
  unitType: string;
}

export interface StartPlanPreviewConfig {
  planId: string;
  name: string;
  entitlements: StartPlanPreviewEntitlement[];
}

export interface ManualClaimPlanEntitlement {
  entitlementId: string;
  showName: string;
  meter: string;
  unitType: string;
  capabilities: string[];
  grantUnits: number;
  period: string;
  priority: number;
  effectiveAt?: number;
}

export interface ManualClaimPlanPreview {
  planId: string;
  name: string;
  description: string;
  priority: number;
  entitlements: ManualClaimPlanEntitlement[];
}

// [契约] 快照里的服务端时间是毫秒，而每个权益的生效时间是 Unix 秒，两个单位刻意不统一。
// [契约] 前者用于客户端校时，后者会原样回传给领取接口，任何换算都只能发生在展示层。
// [失败路径] 把毫秒当秒交给倒计时组件，剩余时间会瞬间变成负数并触发一次无意义的刷新。
// [契约] plans 为空数组表示当前没有可领活动，不等于请求失败，界面应展示空态而不是错误态。
export interface ManualClaimPlanPreviewSnapshot {
  /** 本次响应的服务端时间（毫秒）；生效时间 effectiveAt 仍为 Unix 秒。 */
  serverTime?: number;
  plans: ManualClaimPlanPreview[];
}

// [契约] 领取请求继承人机验证凭证，说明领取是写操作，必须携带验证证明。
// [契约] planId 由活动快照下发，客户端不得自行拼接或猜测。
// [失败路径] 去掉继承后类型仍能编译，但服务端会以缺少凭证拒绝，前端拿不到可展示的原因。
export interface ManualClaimPlanClaimRequest extends RequestVerificationProof {
  planId: string;
}

export interface ManualClaimPlanClaimEntitlement {
  entitlementId: string;
  showName: string;
  /** Claim 返回的权益生效时间，Unix 秒；0 表示立即生效。 */
  effectiveAt?: number;
}

// [契约] success 与 code 同时存在，前者是业务结论，后者是服务端原始码，二者不得互相替代。
// [契约] 失败响应里的活动结束时间只用于额度耗尽提示，不能当作已领取权益的期限。
// [契约] serverTime 属于本次响应，不得与其他接口的时间戳混用做校时。
// [契约] plan 缺省表示领取未产生有效订阅，此时不要读取其中的权益数组。
// [失败路径] 把失败响应的结束时间渲染成权益到期，用户会误以为已经领到额度并反复点击。
export interface ManualClaimPlanClaimResult {
  success: boolean;
  code: number;
  message: string;
  /** 失败响应中的活动结束时间，用于额度耗尽提示；不得当作已领取权益期限。 */
  failureEndsAt?: number;
  /** 领取接口返回的服务端时间（毫秒），不与其他响应的时间混用。 */
  serverTime?: number;
  plan?: {
    userPlanId: string;
    planId: string;
    status: string;
    startsAt?: number;
    endsAt?: number;
    entitlements?: ManualClaimPlanClaimEntitlement[];
  };
}

// [契约] 强更配置只有一个最小版本号字段，比较规则在客户端，类型层不承载语义。
// [权衡] 不要在这里加开关字段，是否强制更新由版本号单独决定，多一个开关就多一种前后端不一致的组合。
export interface ForceUpdateConfig {
  minimalVersion: string;
}

/**
 * 闲时任务客户端配置：client/configs 只下发入口曝光开关；模型展示来自 Built-in
 * offpeak Provider。准入/低峰判断仍以服务端为准（3006 兜底）。
 * 有效开启判据 = enable_offpeak_task===true 且 Built-in 模型成员非空。
 * 额度不再经 client/configs 下发；改由专用 availability 接口提供服务端即时快照。
 */
// [契约] provider 标识可选，不传时由服务层按当前登录身份推断家族。
// [契约] 一旦传入就必须是六个编码计划枚举之一，而不是任意字符串。
// [失败路径] 在类型层把它设为必填会打断既有调用点，推断逻辑反而被迫挪进每个页面。
export interface CodingPlanProductInfoRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  productId: string;
}

// [契约] 服务端权益条目保留创建与更新时间，它们是审计字段，不参与权益展示。
// [失败路径] 用权益标题作为唯一键会重复，标题允许重名，定位必须靠标识。
export interface CodingPlanProductEquity {
  id?: number;
  productId?: string;
  productEquityTitle?: string;
  productEquityDetails?: string;
  createTime?: string;
  updateTime?: string;
}

// [契约] 这是服务端原始商品模型，字段名与报价投影不同：原始售价不是应付金额。
// [契约] stock 与 userAllowBuyNum 是库存与限购两个概念，不能互相顶替。
// [权衡] 不为它补应付金额字段，补齐后两个模型看起来一样，调用方会直接把原始商品当报价渲染。
// [失败路径] 用原始售价顶替应付金额，优惠会被重复扣减，实付金额偏低。
export interface CodingPlanProductInfo {
  id?: number;
  productId: string;
  productName?: string;
  productBigTitle?: string;
  productSmallTitle?: string;
  productIntroduction?: string;
  buyLimit?: number;
  salePrice?: number;
  productStatus?: string;
  description?: string;
  relateResourcePack?: string;
  stock?: number;
  saleCount?: number;
  userAllowBuyNum?: number;
  isAllowBuy?: boolean;
  isEnable?: boolean;
  errorMessage?: string | null;
  displayOrder?: number;
  productEquityList?: CodingPlanProductEquity[] | null;
  priceUnit?: "month" | "quarter" | "year";
}

export interface CodingPlanCampaignDiscountDetail {
  campaignName?: string;
  campaignDiscountAmount?: number;
  rewardMode?: string;
  rewardAmount?: number;
  rewardDetail?: string;
  applyScene?: string;
}

export interface CodingPlanBatchPreviewRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  invitationCode?: string;
}

// [契约] 批量预览同时返回是否已订阅与登录态，登录态为 null 表示服务端无法判定。
// [契约] null 不能等同于未登录，它只说明当前无法给出结论。
// [失败路径] 把 null 当 false，首屏会闪一次请登录，随后又被真实状态覆盖。
export interface CodingPlanBatchPreviewResponse {
  productList: CodingPlanProductPreviewPayment[];
  isSubscribed: boolean;
  isAuthenticated: boolean | null;
}

// [契约] 预览请求携带邀请码与验证码票据，二者都可选，但一旦传入就必须原样透传。
// [契约] salesChannel 只用于服务端归因，客户端不得据此改变报价展示。
// [失败路径] 前端提前校验邀请码格式会误杀服务端新增的码型，用户看到邀请码无效却无法下单。
export interface CodingPlanPreviewRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  productId: string;
  invitationCode?: string;
  imRef?: string | null;
  ticket?: string | null;
  randstr?: string | null;
  salesChannel?: string;
}

// [契约] 上次订阅摘要只保留商品、订单与协议号，用于续费时回填。
// [失败路径] 把摘要当完整订单使用，缺金额字段会让续费页展示为零元。
export interface CodingPlanLastSubscriptionSummary {
  productId?: string;
  orderNo?: string;
  agreementNo?: string;
}

// [契约] 预览响应继承报价字段并追加订单级金额，bizId 是后续签约的唯一凭据。
// [契约] 退款拆分可空，null 表示本单不涉及退款，而不是退款为零。
// [契约] renew 为 null 表示服务端未判定是否续费，界面应保持中性文案。
// [失败路径] 把 null 当零元退款展示，用户会以为订单已经退过钱。
export interface CodingPlanPreviewResponse extends CodingPlanProductPreviewPayment {
  bizId: string;
  cashAmount?: number;
  giveAmount?: number;
  thirdPartyAmount?: number;
  refundAmount?: number;
  residualAmount?: number;
  renew?: boolean | null;
  refundBreakdown?: {
    cashRefund?: number;
    giveRefund?: number;
    thirdPartyRefund?: number;
  } | null;
  orderValueCompositionFeatureEnabled?: boolean;
  lastSubscriptionSummary?: CodingPlanLastSubscriptionSummary | null;
}

// [契约] 签约请求以 bizId 为核心，支付方式省略时由服务端按渠道默认值决定。
// [契约] isDelay 用 0 和 1 而不是布尔值，这是服务端既有契约。
// [失败路径] 改成布尔类型会让序列化结果与网关不匹配，签名校验直接失败。
export interface CodingPlanCreateSignRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  bizId: string;
  payType?: CodingPlanPayType;
  invitationCode?: string;
  renew?: boolean | null;
  isDelay?: 0 | 1;
  effectiveTime?: string | null;
}

export interface CodingPlanUpdateSignRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  bizId: string;
  payType?: CodingPlanPayType;
}

// [契约] 签约结果只有订单号与签名字段，签名必须原样交给支付 SDK。
// [权衡] 不在这里解析签名内容，解析规则随渠道版本变化，放在共享类型层会把渠道差异泄漏给所有端。
export interface CodingPlanAgreementResponse {
  orderId?: string;
  sign: string;
  signType?: string;
}

export interface CodingPlanPaymentCheckRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  bizId: string;
}

export interface CodingPlanPaymentCheckResponse {
  status: string;
}

export interface CodingPlanEstimatePayAmount {
  cashPayAmount?: number;
  givePayAmount?: number;
  thirdPartyPayAmount?: number;
}

// [契约] 银行卡展示只用品牌与后四位，完整卡号字段不应出现在共享类型里。
// [契约] isDeleted 与 isDefault 是两张独立的标记，已删除的卡也可能仍是默认卡。
// [资源] 支付方式标识是唯一必要的定位符，其余字段缺失时退化为通用卡图标。
export interface CodingPlanStripeCard {
  id?: number;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  isDefault?: boolean;
  isDeleted?: boolean;
  paymentMethodId: string;
}

export interface CodingPlanStripeBindRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  paymentMethodId: string;
  returnUrl?: string;
  trackingContext?: Record<string, unknown>;
}

// [契约] 绑卡响应用 clientSecret 与 requiresAction 表示需要二次验证，二者必须一起看。
// [失败路径] 只看错误详情判断绑卡失败，需要二次验证的卡会被误判成绑定失败。
export interface CodingPlanStripeBindResponse extends CodingPlanStripeCard {
  errorDetail?: string;
  clientSecret?: string;
  requiresAction?: boolean;
}

export interface CodingPlanStripeUnbindRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  paymentMethodId: string;
}

// [契约] 支付请求既可用已创建订单号续付，也可只带商品标识现建单，两条路径互斥。
// [契约] CodingPlanStripePayRequest.estimatePayAmount 只是渠道侧提示，真实金额以服务端下单结果为准。
// [失败路径] 同时传订单号与不一致的商品标识，服务端按订单商品结算，界面展示的却是另一件商品。
export interface CodingPlanStripePayRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  productId: string;
  paymentMethodId?: string;
  isSubscribe?: boolean;
  returnUrl?: string;
  channelCode?: string;
  estimatePayAmount?: CodingPlanEstimatePayAmount;
  invitationCode?: string;
  bizId?: string;
  renew?: boolean;
}

export interface CodingPlanStripePayResponse {
  orderId?: string;
  paymentIntentId?: string;
  clientSecret?: string;
  amount?: number;
  status?: string;
  createTime?: string;
  paymentMethodBrand?: string;
  paymentMethodLast4?: string;
  requiresAction?: boolean;
  agreementNo?: string;
  isThirdPartyPayment?: boolean;
}

export interface CodingPlanPaypalSupportRequest {
  providerId?: CodingPlanSubscriptionProviderId;
}

export interface CodingPlanPaypalSupportResponse {
  resultStatus?: string;
  isSupport?: boolean;
}

export interface CodingPlanPaypalSetupTokenRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  returnUrl: string;
  cancelUrl: string;
}

export interface CodingPlanPaypalSetupTokenResponse {
  resultStatus?: string;
  setupTokenId?: string;
  approveUrl?: string;
  paymentTokenStatus?: string;
}

export interface CodingPlanPaypalSubscribeRequest {
  providerId?: CodingPlanSubscriptionProviderId;
  productId: string;
  productDesc?: string;
  setupTokenId?: string;
  amount?: number;
  isSubscribe?: boolean;
  estimatePayAmount?: CodingPlanEstimatePayAmount;
  invitationCode?: string;
  bizId?: string;
  channelCode?: string;
}

// [契约] PayPal 订阅结果有接口结果与支付状态两层，前者表示调用是否成功，后者表示钱是否到账。
// [契约] 订单号可能延迟返回，缺失时不能据此判定订阅失败。
// [失败路径] 只看支付状态会漏掉接口级失败，用户被引导到一个不存在的订单页。
export interface CodingPlanPaypalSubscribeResponse {
  resultStatus?: string;
  payStatus?: string;
  orderId?: string;
}

// [契约] 待支付检查只回答有或无，具体订单信息必须再查一次。
// [失败路径] 从本响应推断金额或商品，会拿到 undefined，并在待支付拦截弹窗里渲染空内容。
export interface CodingPlanPendingOrderCheckResponse {
  hasPendingOrders: boolean;
}

export interface CodingPlanPendingOrderCheckRequest {
  providerId?: CodingPlanSubscriptionProviderId;
}

export type EnterpriseCodingPlanTier = "LITE" | "PRO" | "MAX";
export type EnterpriseCodingPlanSubscribeMode = "CONTINUOUS" | "ONE_TIME";
export type EnterpriseCodingPlanSubscribePeriod = "MONTHLY" | "QUARTERLY" | "YEARLY";
export type EnterpriseCodingPlanPurchaseType = "PAY" | "RENEW";
// [契约] 企业订单状态是开放联合，末尾追加字符串是刻意的，服务端新增状态时前端不得崩溃。
// [权衡] 收窄成五个字面量会让未知状态在反序列化处就报错，而订单页只需要把它显示成处理中。
// [失败路径] 展示层对未知状态抛错，历史订单列表会出现打不开的条目。
export type EnterpriseCodingPlanPaymentStatus =
  | "WAIT_PAY"
  | "SUCCESS"
  | "FAIL"
  | "CLOSED"
  | "CANCELLED"
  | string;

// [契约] EnterpriseCodingPlanPricingProduct 的价格按组织与项目两个维度取上下文，同档位在不同项目下可能不同。
// [契约] 密钥状态的三态与不可用原因分开，unknown 表示尚未探测，不是不可用。
// [契约] 已订阅与可复购是独立标记，已订阅不代表不能再买。
// [失败路径] 把 unknown 当不可用展示，首次进入页面的用户会看到一条并不存在的错误。
export interface EnterpriseCodingPlanPricingProduct {
  productId: string;
  tier: EnterpriseCodingPlanTier;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  purchaseMethodName?: string;
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  renewAmount?: number;
  canRepurchase?: boolean | null;
  subscribed?: boolean | null;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanProjectContext[];
  apiKeyStatus?: EnterpriseCodingPlanProjectApiKeyStatus;
  apiKeyUnavailableReason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason | null;
  apiKeyUnavailableMessage?: string | null;
  campaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
}

export interface EnterpriseCodingPlanProjectContext {
  organizationId: string;
  organizationName?: string | null;
  projectId: string;
  projectName?: string | null;
  apiKeyStatus?: EnterpriseCodingPlanProjectApiKeyStatus;
  apiKeyUnavailableReason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason | null;
  apiKeyUnavailableMessage?: string | null;
}

// [契约] 探测未完成时必须停在 unknown，提前落成可用或不可用都会制造闪烁。
// [失败路径] 三个值缺一个，类型层就无法表达还没查，调用方只能拿 false 顶替。
export type EnterpriseCodingPlanProjectApiKeyStatus = "available" | "unavailable" | "unknown";

export type EnterpriseCodingPlanProjectApiKeyUnavailableReason =
  | "no_valid_team_plan_authorization"
  | "request_failed";

export interface EnterpriseCodingPlanPricingResponse {
  productList: EnterpriseCodingPlanPricingProduct[];
}

// [契约] 家族字段缺省时按 bigmodel 处理，这是向后兼容契约，不是延迟加载。
// [契约] 服务层据此路由到对应家族的订阅 provider，路由依据只有这一个字段。
// [契约] 改动缺省行为会影响所有不传家族的旧调用点，必须当成协议变更对待。
// [契约] authenticated 只影响服务端是否回填订阅态，不改变定价本身。
// [失败路径] 把缺省改成必填或直接抛错，旧入口的企业定价整块不可用。
export interface EnterpriseCodingPlanPricingRequest {
  authenticated?: boolean;
  /**
   * 指定按哪个 family 读取企业定价。
   * 缺省时按 bigmodel 处理，向后兼容既有调用点。
   * service 层据此路由到对应 family 的 subscription provider。
   */
  // [契约] 该字段只接受家族域枚举，不接受 provider 标识，二者层级不同。
  // [失败路径] 传入具体 provider 标识会命中不到路由表，最终回落到默认家族并返回错误价格。
  family?: ProviderFamilyDomain;
}

// [契约] giveBalance、cashBalance、totalBalance 三段余额全部由服务端给出，前端不得自行相加。
// [契约] 合计不是前端可重算的派生值，扣款顺序由服务端决定。
// [失败路径] 前端自行相加会与服务端扣款口径不一致，用户看到余额充足却支付失败。
export interface EnterpriseCodingPlanBalanceResponse {
  giveBalance: number;
  cashBalance: number;
  totalBalance: number;
}

export interface EnterpriseCodingPlanDiscountDetail {
  discountType?: string;
  discountName?: string;
  discountAmount?: number;
}

export interface EnterpriseCodingPlanOrderCalculateRequest {
  productId: string;
  maxSeats: number;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  duration?: number | null;
  giveAmount?: number;
  balanceDeductAmount?: number;
}

// [契约] EnterpriseCodingPlanOrderCalculateResponse 的 totalOriginalAmount/totalPayAmount/thirdPayAmount 三个顶层金额必填。
// [契约] discountDetails 只作解释，金额以 totalPayAmount 等顶层字段为准。
// [契约] 明细可能为空数组，表示未命中活动，不是试算失败。
// [失败路径] 用明细累加覆盖应付金额，浮点误差会让下单金额与试算差一分钱。
export interface EnterpriseCodingPlanOrderCalculateResponse {
  totalOriginalAmount: number;
  campaignDiscountAmount?: number;
  discountDetails?: EnterpriseCodingPlanDiscountDetail[];
  totalPayAmount: number;
  giveDeductAmount?: number;
  balanceDeductAmount?: number;
  thirdPayAmount: number;
}

// [契约] 建单请求把试算得到的三个金额原样回传，服务端会核对。
// [契约] EnterpriseCodingPlanCreateOrderRequest 的 giveAmount 与 balanceDeductAmount 可缺省，缺省即不使用该项抵扣。
// [失败路径] 客户端重新计算或四舍五入后金额与试算不一致，建单会被拒绝，用户只看到参数错误。
export interface EnterpriseCodingPlanCreateOrderRequest {
  productId: string;
  maxSeats: number;
  subscribePeriod?: EnterpriseCodingPlanSubscribePeriod;
  subscribeMode?: EnterpriseCodingPlanSubscribeMode;
  purchaseType: EnterpriseCodingPlanPurchaseType;
  duration?: number | null;
  giveAmount?: number;
  balanceDeductAmount?: number;
  totalOriginalAmount: number;
  totalPayAmount: number;
  thirdPayAmount: number;
  subscriptionNo?: string;
}

export interface EnterpriseCodingPlanCreateOrderResponse {
  orderNo: string;
  subscriptionNo?: string;
  totalOriginalAmount: number;
  campaignDiscountAmount?: number;
  totalPayAmount: number;
  thirdPayAmount: number;
  discountDetails?: EnterpriseCodingPlanDiscountDetail[];
  payUrl?: string | null;
  alipayJumpSchema?: string | null;
  expireTime?: string | null;
}

// [契约] EnterpriseCodingPlanPendingOrder 的 amount 是本次应付，totalAmount 是订单原值。
// [契约] 座位数独立于金额，不能由总额推算。
// [失败路径] 用订单总额展示应付，会把优惠金额也算进去，用户看到的价格偏高。
export interface EnterpriseCodingPlanPendingOrder {
  orderNo: string;
  productId: string;
  amount: number;
  totalAmount: number;
  deductionAmount?: number;
  paymentStatus: EnterpriseCodingPlanPaymentStatus;
  createTime: string;
  subscriptionNo?: string;
  seatCount: number;
}

export interface EnterpriseCodingPlanCancelOrderRequest {
  orderNo: string;
}

export interface EnterpriseCodingPlanCancelOrderResponse {
  orderNo: string;
  status: EnterpriseCodingPlanPaymentStatus;
}

export interface EnterpriseCodingPlanContinuePayRequest {
  orderNo: string;
}

export interface EnterpriseCodingPlanOrderStatusRequest {
  orderNo: string;
}

// [契约] 订单状态查询会回带购买类型，值域开放，个人与企业订单共用同一个查询入口。
// [契约] 组织与项目标识可能为空，缺失表示该订单不绑定项目。
// [失败路径] 按字面量穷举购买类型，企业新增类型会走到未处理的兜底分支。
export interface EnterpriseCodingPlanOrderStatusResponse {
  orderNo: string;
  paymentStatus: EnterpriseCodingPlanPaymentStatus;
  productPurchaseType?: "ENTERPRISE" | "PERSONAL" | string;
  organizationId?: string | null;
  projectId?: string | null;
}
