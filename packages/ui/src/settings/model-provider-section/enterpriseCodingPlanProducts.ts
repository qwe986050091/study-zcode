/* eslint-disable max-lines -- 企业套餐展示模型集中承载静态目录、实时定价与支付参数转换，拆分会模糊合并边界。 */
// 企业版 Coding Plan 展示模型层：把静态团队目录与实时 pricing 商品合并成卡片可消费的
// 展示模型，并收敛展示价推导、优惠金额还原、试算/下单请求组装、支付内容与状态判定。
// 边界：不做网络请求、不持有 React 状态、不渲染；个人版套餐口径与订阅写操作都不在此文件。
//
// 分层与失败语义（顺序敏感）：静态目录只描述可购买 SKU，读取失败与显式空数组结论相反；
// 实时 pricing 是订阅身份、席位与项目上下文的权威来源；试算/下单响应才带当前席位时长的总优惠。
//
// INV-01 断言：静态目录缺失时不得隐藏已购团队套餐 —— 守住它的位置：resolveEnterpriseCodingPlanProductList 的 Array.isArray 分支 —— 改错故障：读取失败的用户团队卡整体消失且刷新不自愈。
// INV-02 断言：静态目录显式空数组时只保留已购项 —— 守住它的位置：mergeEnterpriseCodingPlanProductList 的 purchasedPricingProducts 追加 —— 改错故障：运营关停 SKU 后仍出现可购买卡，下单必失败。
// INV-03 断言：同一 productId 只渲染一张卡 —— 守住它的位置：staticProductIds 去重集合 —— 改错故障：团队套餐重复展示两个价格。
// INV-04 断言：已购但静态目录缺项的 SKU 必须输出 —— 守住它的位置：purchasedPricingProducts 的过滤条件 —— 改错故障：灰度未下发时已购用户丢失连接方式与用量入口。
// INV-05 断言：卡片展示价取 payAmount 与 renewAmount 中可用金额的最小值 —— 守住它的位置：resolveEnterpriseCodingPlanDisplayPayAmount —— 改错故障：年付商品把原价当折后价展示。
// INV-06 断言：discountAmount 是优惠额而不是折后价 —— 守住它的位置：resolveEnterpriseCodingPlanDisplayPayAmount 的第二分支 —— 改错故障：卡片价格显示成接近 0。
// INV-07 断言：展示优惠与原价划线严格互补 —— 守住它的位置：calculateEnterpriseCodingPlanDisplayDiscountAmount —— 改错故障：原价减优惠不等于实付，用户质疑价格。
// INV-08 断言：总优惠需按席位与周期数放大 —— 守住它的位置：calculateEnterpriseCodingPlanPricingDiscountAmount 的 periodCount —— 改错故障：多席位确认页优惠偏小、实付偏高。
// INV-09 断言：活动金额分摊之和必须等于订单总优惠 —— 守住它的位置：resolvePricingCampaignDiscountAmount 的残差分支 —— 改错故障：明细合计与实付差 1 分。
// INV-10 断言：只有最后一档吃残差 —— 守住它的位置：index 等于 count 减 1 的分支 —— 改错故障：改为比例分摊后四舍五入尾差无处吸收。
// INV-11 断言：优惠明细三级回退顺序不可调换 —— 守住它的位置：buildEnterpriseCodingPlanCampaignDiscountDetails —— 改错故障：订单明细覆盖 pricing 活动名，优惠行文案丢失。
// INV-12 断言：零金额活动必须被过滤 —— 守住它的位置：mappedDetails 与 normalizePricingCampaignDiscountDetails 的过滤 —— 改错故障：确认页出现满减 0.00 的噪音行。
// INV-13 断言：二维码内容优先 payUrl —— 守住它的位置：buildEnterpriseCodingPlanPaymentContent —— 改错故障：超长 schema 导致二维码生成失败、扫码页空白。
// INV-14 断言：无三方支付内容时不进二维码页 —— 守住它的位置：isEnterpriseCodingPlanThirdPartyPaymentRequired —— 改错故障：赠金全额抵扣用户卡在完成支付页。
// INV-15 断言：duration 只在一次性购买模式下发 —— 守住它的位置：试算与下单请求的 duration 字段 —— 改错故障：订阅制被后端按周期数加价。
// INV-16 断言：下单金额必须原样取试算快照 —— 守住它的位置：buildEnterpriseCodingPlanCreateOrderRequest 的 estimate —— 改错故障：客户端重算导致订单金额校验失败。
import type {
  CodingPlanCampaignDiscountDetail,
  CodingPlanStaticTeamProduct,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanDiscountDetail,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanPaymentStatus,
  EnterpriseCodingPlanPricingProduct,
  EnterpriseCodingPlanSubscribePeriod,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  normalizeCodingPlanCardCopyItems,
  type CodingPlanPriceUnit,
  type CodingPlanProductDisplay,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";

// [契约] 展示模型 = 通用卡片字段 + 企业 pricing 原始商品引用 enterpriseProduct。
// 下游取价与优惠还原一律读 enterpriseProduct；展示层不要再存一份金额副本，
// 否则合并态与纯 pricing 态会给出两个不同的支付价。
export type EnterpriseCodingPlanProductDisplay = CodingPlanProductDisplay & {
  enterpriseProduct: EnterpriseCodingPlanPricingProduct;
  tier: EnterpriseCodingPlanPricingProduct["tier"];
  subscribeMode: EnterpriseCodingPlanPricingProduct["subscribeMode"];
  subscribePeriod: EnterpriseCodingPlanPricingProduct["subscribePeriod"];
  purchaseMethodName: string;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanPricingProduct["teamProjects"];
  apiKeyStatus?: EnterpriseCodingPlanPricingProduct["apiKeyStatus"];
  apiKeyUnavailableReason?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableReason"];
  apiKeyUnavailableMessage?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableMessage"];
  subscribed?: boolean | null;
  dynamicPricingAvailable?: boolean;
  staticCatalogAvailable?: boolean;
  /**
   * 该企业套餐所属的 family（zai / bigmodel）。
   * 原 UI 层把 team plan items 硬编码为 bigmodelCodingPlan 派生，
   * zai family 即使有订阅也无法渲染。加 family 标记后，下游可见性函数可按
   * product.family 找到对应 family 的 codingPlanItem 和 team key 前缀。
   * 缺省 bigmodel 保持向后兼容。
   */
  family?: ProviderFamilyDomain;
};

/** 旧商品缺少 family 时只在这一规范化边界解释为 BigModel。 */
// [契约] family 只在读取处归一为 bigmodel，不写回商品对象；写回会让未标注 family 的
// 灰度信息永久丢失，按 family 前缀匹配 team key 时无法区分历史商品与显式 bigmodel 商品。
export function resolveEnterpriseCodingPlanProductFamily(
  product: Pick<EnterpriseCodingPlanProductDisplay, "family">,
): ProviderFamilyDomain {
  return product.family ?? "bigmodel";
}

// [契约] 失败态只认这三个值；SUCCESS 之外还有进行中状态，不能按非成功即失败反推，
// 否则轮询中途会把在途订单当失败关闭弹窗。
// 该常量由 getEnterpriseCodingPlanFailureStatuses 复制导出，外部修改不影响内部判定。
const ENTERPRISE_CODING_PLAN_FAILURE_STATUSES = ["FAIL", "CLOSED", "CANCELLED"] as const;

// [契约] 纯 pricing 入口，输出与静态目录无关，dynamicPricingAvailable 恒为 true。
// 这里刻意不设置 staticCatalogAvailable：调用方需要区分目录里没有这个 SKU 与目录整体不可用。
// 展示价必须走 resolveEnterpriseCodingPlanDisplayPayAmount，不要直接取 product.payAmount，
// 否则年付商品会把原价当折后价展示。
export function buildEnterpriseCodingPlanProductList(
  products: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product): EnterpriseCodingPlanProductDisplay => {
    const purchaseMethodName = product.purchaseMethodName?.trim() ?? "";
    return {
      productId: product.productId,
      productName: formatEnterpriseCodingPlanTier(product.tier),
      productBigTitle: formatEnterpriseCodingPlanTier(product.tier),
      originalAmount: product.originalAmount,
      payAmount: resolveEnterpriseCodingPlanDisplayPayAmount(product),
      renewAmount: product.renewAmount,
      canRepurchase: product.canRepurchase,
      inCurrentPeriod: product.subscribed === true,
      campaignDiscountDetails: product.campaignDiscountDetails,
      priceUnit: mapEnterpriseCodingPlanPriceUnit(product.subscribePeriod),
      priceCurrency: "CNY",
      productEquityList: [],
      hasPreview: true,
      enterpriseProduct: product,
      tier: product.tier,
      subscribeMode: product.subscribeMode,
      subscribePeriod: product.subscribePeriod,
      purchaseMethodName,
      organizationId: product.organizationId,
      organizationName: product.organizationName,
      projectId: product.projectId,
      projectName: product.projectName,
      teamProjects: product.teamProjects,
      apiKeyStatus: product.apiKeyStatus,
      apiKeyUnavailableReason: product.apiKeyUnavailableReason,
      apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
      subscribed: product.subscribed,
      dynamicPricingAvailable: true,
    };
  });
}

// [契约] 合并顺序 = 静态目录顺序在前，随后追加已购但静态目录没有的 pricing 商品。
// 顺序决定卡片排序，不能改成 Set 或按 id 排序，否则已购 Team Plan 会跳到列表首位。
// [权衡] 同一 productId 以 pricing 金额为准，名称与权益文案仍取静态目录，
// 这样运营改文案不必发 pricing 版本；代价是 pricing 改名不会即时生效。
// [失败路径] 静态目录为空数组但 pricing 有已购项时，仍必须产出已购卡，见下方追加逻辑。
export function mergeEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[],
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  const pricingByProductId = new Map(
    pricingProducts.map((product) => [product.productId, product]),
  );
  // [契约] 该集合只用于去重：已在静态目录出现的 productId 不再作为已购追加项输出，
  // 否则同一团队套餐会渲染两张卡，一张静态价一张 pricing 价。
  const staticProductIds = new Set(staticProducts.map((product) => product.productId));
  const mergedStaticProducts = staticProducts.map((staticProduct) => {
    const pricingProduct = pricingByProductId.get(staticProduct.productId);
    // [失败路径] 静态 SKU 在 pricing 中缺席时用静态字段兜底成 pricing 形状，
    // 兜底对象的 canRepurchase 固定 false：没有实时定价无法保证可复购，宁可置灰也不要让用户点了报错。
    // 该兜底对象不带团队项目与密钥状态，下游必须容忍 undefined 而不是假定有值。
    const enterpriseProduct: EnterpriseCodingPlanPricingProduct = pricingProduct ?? {
      productId: staticProduct.productId,
      tier: staticProduct.tier,
      subscribeMode: staticProduct.subscribeMode,
      subscribePeriod: staticProduct.subscribePeriod,
      purchaseMethodName: staticProduct.purchaseMethodName,
      originalAmount: staticProduct.originalAmount,
      discountAmount: staticProduct.discountAmount,
      payAmount: staticProduct.payAmount,
      renewAmount: staticProduct.renewAmount,
      canRepurchase: false,
    };
    const display = buildEnterpriseCodingPlanProductList([enterpriseProduct])[0]!;
    return {
      ...display,
      productName: staticProduct.productName,
      productBigTitle: staticProduct.productName,
      originalAmount: pricingProduct?.originalAmount ?? staticProduct.originalAmount,
      payAmount: pricingProduct
        ? display.payAmount
        : (staticProduct.payAmount ?? staticProduct.renewAmount),
      renewAmount: pricingProduct?.renewAmount ?? staticProduct.renewAmount,
      priceCurrency: staticProduct.priceCurrency,
      equity: normalizeCodingPlanCardCopyItems(staticProduct.equity ?? []),
      descriptionItems: normalizeCodingPlanCardCopyItems(staticProduct.description ?? []),
      dynamicPricingAvailable: pricingProduct !== undefined,
      staticCatalogAvailable: true,
    };
  });
  // [并发] 这里是已购但静态目录缺失的唯一补位：静态目录灰度为空、加载失败或漏发商品时，
  // 真实团队订阅仍要能展示连接方式与用量入口。
  // 该 SKU 的 staticCatalogAvailable 置 false，让卡片知道只能管理、不可新购。
  // [失败路径] 若改成静态目录为空则整体返回空，已购用户会突然丢失团队卡片。
  const purchasedPricingProducts = pricingProducts
    .filter((product) => product.subscribed === true && !staticProductIds.has(product.productId))
    .map((product) => ({
      ...buildEnterpriseCodingPlanProductList([product])[0]!,
      // client/configs 的团队静态目录只负责可购买 SKU 展示；
      // 已购 Team Plan 身份来自 pricing/customerInfo，不能因为静态目录灰度为空或漏发商品
      // 就把真实团队连接方式和使用统计入口隐藏。
      staticCatalogAvailable: false,
    }));
  return [...mergedStaticProducts, ...purchasedPricingProducts];
}

// [契约] 三态语义：undefined 或非数组 = 目录不可用，退化为纯 pricing；
// 显式空数组 = 运营关闭全部团队 SKU，合并后自然只剩已购项；真数组 = 正常合并。
// 用 Array.isArray 而不是真值判断，是为了把读取失败与读取成功但为空区分开，
// 两者在业务上是相反结论。
export function resolveEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[] | undefined,
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  // [失败路径] 下面这个三元不是冗余防御：读取异常会被调用方降级成 undefined 传进来，
  // 此时若继续走合并，已购团队套餐会被误判成目录已下架而全部隐藏。
  // 静态目录缺失或读取失败时，pricing 仍是团队订阅身份与项目上下文的权威来源；
  // 只有成功读取到显式空数组时，才按配置语义隐藏全部团队 SKU。
  return !Array.isArray(staticProducts)
    ? buildEnterpriseCodingPlanProductList(pricingProducts)
    : mergeEnterpriseCodingPlanProductList(staticProducts, pricingProducts);
}

// [契约] 展示价 = payAmount 与 renewAmount 中可用金额的最小值。
// 年付约定 payAmount 为原价、renewAmount 为折后价，取最小值才得到折后价；月付两者相等不受影响。
// [权衡] 不要在调用侧按 subscribePeriod 分支取字段，新增周期类型时会漏改。
// 候选金额先过滤掉 undefined、NaN 与负数，直接取最小会被 undefined 污染成 NaN。
function resolveEnterpriseCodingPlanDisplayPayAmount(
  product: EnterpriseCodingPlanPricingProduct,
): number | undefined {
  const candidateAmounts = [product.payAmount, product.renewAmount].filter(hasPositiveOrZeroAmount);
  if (candidateAmounts.length > 0) {
    // 真实企业 pricing 年付商品会下发 payAmount=originalAmount、renewAmount=折后价。
    // 卡片要和个人套餐一致展示“折后价 + 原价划线”，因此显示价取可用支付金额里的最低值。
    return Math.min(...candidateAmounts);
  }
  if (
    hasPositiveOrZeroAmount(product.originalAmount) &&
    hasPositiveAmount(product.discountAmount)
  ) {
    // 个人套餐卡片展示的是折后价 + 原价划线；企业 pricing 的 discountAmount 是优惠金额，
    // 不能直接传给通用卡片当价格，但年付商品可能只下发 originalAmount + discountAmount。
    // [权衡] 只有年付等场景才仅下发 originalAmount 与 discountAmount，此时按优惠额反推折后价。
    // 优惠额不是折后价，直接当价格传给卡片会显示成接近 0。
    // 取原价减优惠额后与 0 取最大，防止后端下发超额优惠时算出负价。
    return roundCurrencyAmount(Math.max(0, product.originalAmount - product.discountAmount));
  }
  return undefined;
}

// [契约] 试算请求只带商品维度参数，不带任何展示金额；服务端按席位与时长的乘积重算。
// 时长仅一次性购买模式有意义，订阅制传 undefined，避免后端把时长当订阅周期数。
// 保留时长字段而非省略，是为了让调用方漏传时在结构对比中可见。
export function buildEnterpriseCodingPlanCalculateRequest({
  product,
  maxSeats,
  duration,
  giveAmount = 0,
  balanceDeductAmount = 0,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
  giveAmount?: number;
  balanceDeductAmount?: number;
}) {
  return {
    productId: product.productId,
    maxSeats,
    subscribePeriod: product.subscribePeriod,
    subscribeMode: product.subscribeMode,
    duration: product.subscribeMode === "ONE_TIME" ? duration : undefined,
    giveAmount,
    balanceDeductAmount,
  };
}

// [契约] 下单请求在试算请求基础上追加 purchaseType 与三项金额快照。
// 金额必须原样取试算响应，不能在客户端重算，否则与后端订单实付不一致会校验失败。
// [事务] 快照必须来自同一次试算：用户改席位后未重新试算就下单，estimate 会过期，
// 后端按新价扣款而前端展示旧价。
export function buildEnterpriseCodingPlanCreateOrderRequest({
  product,
  maxSeats,
  duration,
  estimate,
  giveAmount = 0,
  balanceDeductAmount = 0,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
  giveAmount?: number;
  balanceDeductAmount?: number;
  estimate: Pick<
    EnterpriseCodingPlanOrderCalculateResponse,
    "totalOriginalAmount" | "totalPayAmount" | "thirdPayAmount"
  >;
}): EnterpriseCodingPlanCreateOrderRequest {
  return {
    productId: product.productId,
    maxSeats,
    subscribePeriod: product.subscribePeriod,
    subscribeMode: product.subscribeMode,
    purchaseType: "PAY",
    duration: product.subscribeMode === "ONE_TIME" ? duration : undefined,
    giveAmount,
    balanceDeductAmount,
    totalOriginalAmount: estimate.totalOriginalAmount,
    totalPayAmount: estimate.totalPayAmount,
    thirdPayAmount: estimate.thirdPayAmount,
  };
}

// [契约] 二维码内容优先 payUrl（PC 扫码），回退 alipayJumpSchema（移动端拉起支付宝）。
// [失败路径] 顺序不能反：schema 串极长，用作二维码会导致生成失败或扫码无法识别，
// 历史上正是这个顺序错误造成企业套餐扫码页空白。
export function buildEnterpriseCodingPlanPaymentContent(
  order: Pick<EnterpriseCodingPlanCreateOrderResponse, "alipayJumpSchema" | "payUrl">,
): string {
  // Bugfix: 企业套餐 PC 扫码二维码按接口文档使用 payUrl；alipayJumpSchema 是移动端拉起支付宝的 schema，内容过长时会导致二维码生成失败。
  return order.payUrl?.trim() || order.alipayJumpSchema?.trim() || "";
}

// [契约] 是否需要三方支付 = 三方应付金额大于 0 或存在可支付内容，两者取或。
// [失败路径] 赠金或余额全额抵扣时后端会创建无三方支付内容的订单，
// 若只看三方应付金额，字段缺失时会把用户送进二维码页并永远等不到支付。
// `isEnterpriseCodingPlanThirdPartyPaymentRequired` 用支付内容兜底：拿不到可扫内容即不需要三方支付。
export function isEnterpriseCodingPlanThirdPartyPaymentRequired(
  order: Pick<
    EnterpriseCodingPlanCreateOrderResponse,
    "alipayJumpSchema" | "payUrl" | "thirdPayAmount"
  >,
): boolean {
  // Bugfix: 企业套餐使用赠金/余额全额抵扣时，后端会创建无三方支付内容的订单。
  // 这种订单不应该进入支付宝二维码页，否则用户会卡在“当前支付页完成支付”。
  return order.thirdPayAmount > 0 || buildEnterpriseCodingPlanPaymentContent(order) !== "";
}

// [契约] 待支付订单转试算视图：总额视为原价，实付金额视为成交价。
// 优惠额优先取后端抵扣字段，缺失时用原价减实付兜底，保证明细合计能对上。
// [权衡] 三方应付金额用实付占位，因为待支付列表接口没有该字段；
// 真正拉起支付时会用继续支付接口返回值刷新，展示层不要把它当最终三方金额。
export function buildEnterpriseCodingPlanEstimateFromPendingOrder(
  order: EnterpriseCodingPlanPendingOrder,
): EnterpriseCodingPlanOrderCalculateResponse {
  const discountAmount = hasPositiveAmount(order.deductionAmount)
    ? order.deductionAmount
    : Math.max(0, order.totalAmount - order.amount);
  return {
    totalOriginalAmount: order.totalAmount,
    campaignDiscountAmount: discountAmount,
    totalPayAmount: order.amount,
    // Bugfix: 待支付订单列表接口没有 thirdPayAmount 字段，确认页必须用待支付实付金额占位；
    // 真正拉起支付时会再用继续支付接口返回的 thirdPayAmount 刷新二维码弹窗金额。
    thirdPayAmount: order.amount,
  };
}

export function buildEnterpriseCodingPlanEstimateFromOrderResponse(
  order: EnterpriseCodingPlanCreateOrderResponse,
): EnterpriseCodingPlanOrderCalculateResponse {
  return {
    totalOriginalAmount: order.totalOriginalAmount,
    campaignDiscountAmount: order.campaignDiscountAmount,
    discountDetails: order.discountDetails,
    totalPayAmount: order.totalPayAmount,
    thirdPayAmount: order.thirdPayAmount,
  };
}

// [契约] 优惠明细三级回退：pricing 活动明细、订单优惠明细、单个总优惠额。
// 顺序即优先级：pricing 带活动名与场景，信息最全；订单明细次之；只剩总额时只能给出无名优惠。
// [权衡] 三级都空时返回空数组而非零金额条目，卡片据此隐藏优惠行。
// 返回一条金额为 0 的记录，会让明细出现 0.00 的假优惠。
export function buildEnterpriseCodingPlanCampaignDiscountDetails({
  campaignDiscountAmount,
  discountDetails,
  pricingCampaignDiscountDetails,
}: {
  campaignDiscountAmount?: number;
  discountDetails?: EnterpriseCodingPlanDiscountDetail[];
  pricingCampaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
}): CodingPlanCampaignDiscountDetail[] {
  const pricingDetails = normalizePricingCampaignDiscountDetails(
    pricingCampaignDiscountDetails,
    campaignDiscountAmount,
  );
  if (pricingDetails.length > 0) {
    return pricingDetails;
  }

  const mappedDetails = (discountDetails ?? []).flatMap((detail) => {
    if (typeof detail.discountAmount !== "number" || detail.discountAmount <= 0) {
      return [];
    }
    const discountName = detail.discountName?.trim();
    return [
      {
        campaignName: discountName || undefined,
        campaignDiscountAmount: detail.discountAmount,
        rewardDetail: discountName || undefined,
        applyScene: detail.discountType,
      },
    ];
  });
  if (mappedDetails.length > 0) {
    return mappedDetails;
  }
  if (typeof campaignDiscountAmount === "number" && campaignDiscountAmount > 0) {
    return [{ campaignDiscountAmount }];
  }
  return [];
}

// [契约] 输出当前席位与周期数相乘后的总优惠，供确认页与支付明细使用。
// 优先用 pricing 的优惠额；它为 0 时用原价与展示价的差额还原，因为年付折扣只体现在这两者之间。
// 返回 undefined 表示无优惠，调用方据此隐藏优惠行而不是显示 0。
export function calculateEnterpriseCodingPlanPricingDiscountAmount({
  product,
  maxSeats,
  duration,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
}): number | undefined {
  const discountAmount = product.enterpriseProduct.discountAmount;
  const displayDiscountAmount = hasPositiveAmount(discountAmount)
    ? discountAmount
    : calculateEnterpriseCodingPlanDisplayDiscountAmount(product);
  if (!hasPositiveAmount(displayDiscountAmount)) {
    return undefined;
  }
  // [契约] 订阅制按 1 个周期计，因为价格本身已是单周期价；一次性购买按时长倍数放大。
  // 用取最大值的方式防止时长传 0 或负数时把优惠算成 0 或负值。
  const periodCount = product.subscribeMode === "ONE_TIME" ? Math.max(1, duration) : 1;
  return roundCurrencyAmount(
    // 修复原因：企业 pricing 的 discountAmount 可能为 0，真实年付折扣体现在 originalAmount 与 renewAmount 差额；
    // 这里按卡片展示价还原单席位优惠金额，参与确认/支付明细。
    displayDiscountAmount * Math.max(1, maxSeats) * periodCount,
  );
}

function calculateEnterpriseCodingPlanDisplayDiscountAmount(
  product: EnterpriseCodingPlanProductDisplay,
): number | undefined {
  const displayPayAmount = resolveEnterpriseCodingPlanDisplayPayAmount(product.enterpriseProduct);
  if (
    !hasPositiveAmount(product.enterpriseProduct.originalAmount) ||
    !hasPositiveOrZeroAmount(displayPayAmount)
  ) {
    return undefined;
  }
  const discountAmount = product.enterpriseProduct.originalAmount - displayPayAmount;
  return discountAmount > 0 ? roundCurrencyAmount(discountAmount) : undefined;
}

// [契约] pricing 活动金额是单席位单周期口径，需按订单总优惠重新分配后才可展示。
// 过滤条件放宽到有金额或有名称或说明：只下发文案不减免的活动仍需展示。
// 分配按 flatMap 顺序累加已分配额，最后一档吃残差，
// 因此顺序不能重排（例如按金额排序），否则尾差会落到另一条活动上。
function normalizePricingCampaignDiscountDetails(
  details: CodingPlanCampaignDiscountDetail[] | undefined,
  campaignDiscountAmount: number | undefined,
): CodingPlanCampaignDiscountDetail[] {
  const sourceDetails = (details ?? []).filter(
    (detail) =>
      hasPositiveAmount(detail.campaignDiscountAmount) ||
      Boolean(detail.campaignName?.trim()) ||
      Boolean(detail.rewardDetail?.trim()),
  );
  if (sourceDetails.length === 0) {
    return [];
  }

  const totalDiscountAmount = hasPositiveAmount(campaignDiscountAmount)
    ? campaignDiscountAmount
    : undefined;
  const sourceAmountSum = sourceDetails.reduce(
    (sum, detail) =>
      sum + (hasPositiveAmount(detail.campaignDiscountAmount) ? detail.campaignDiscountAmount : 0),
    0,
  );
  let allocatedAmount = 0;

  return sourceDetails.flatMap((detail, index) => {
    const amount = resolvePricingCampaignDiscountAmount({
      detail,
      index,
      count: sourceDetails.length,
      totalDiscountAmount,
      sourceAmountSum,
      allocatedAmount,
    });
    allocatedAmount += amount;
    if (!hasPositiveAmount(amount)) {
      return [];
    }
    return [
      {
        ...detail,
        // 修复原因：企业 pricing 返回的是单席位/单周期活动信息，试算/下单返回的是当前席位和时长的总优惠；
        // 展示时保留 pricing 的活动名与说明，但金额必须使用当前订单总优惠，避免多席位采购折扣显示偏小。
        campaignDiscountAmount: amount,
      },
    ];
  });
}

// [契约] 金额分配四分支：无总优惠原样返回；单条全给；源金额和为零时全记第一条；
// 最后一条交给 `roundCurrencyAmount` 吃残差，其余按源金额占比分摊到分。
// 只有最后一条吃残差，才能保证各条之和精确等于订单总优惠；
// 全部按比例分摊会因四舍五入产生分位差，确认页合计与实付对不上。
function resolvePricingCampaignDiscountAmount({
  detail,
  index,
  count,
  totalDiscountAmount,
  sourceAmountSum,
  allocatedAmount,
}: {
  detail: CodingPlanCampaignDiscountDetail;
  index: number;
  count: number;
  totalDiscountAmount: number | undefined;
  sourceAmountSum: number;
  allocatedAmount: number;
}): number {
  if (!hasPositiveAmount(totalDiscountAmount)) {
    return hasPositiveAmount(detail.campaignDiscountAmount) ? detail.campaignDiscountAmount : 0;
  }

  if (count === 1) {
    return totalDiscountAmount;
  }

  if (sourceAmountSum <= 0) {
    return index === 0 ? totalDiscountAmount : 0;
  }

  // [契约] 残差 = 总优惠 − 已分配额，由 `roundCurrencyAmount` 收敛到分。
  // 若换成最后一条也按比例算，多条活动时合计可能偏离订单总优惠 1 分。
  // 累计额不包含被过滤掉的 0 元条目，必须与 flatMap 同序推进。
  if (index === count - 1) {
    return roundCurrencyAmount(totalDiscountAmount - allocatedAmount);
  }

  const sourceAmount = hasPositiveAmount(detail.campaignDiscountAmount)
    ? detail.campaignDiscountAmount
    : 0;
  return roundCurrencyAmount((totalDiscountAmount * sourceAmount) / sourceAmountSum);
}

function hasPositiveAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasPositiveOrZeroAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// [契约] 统一按分四舍五入，加 Number.EPSILON 抵消 1.005 类浮点表示误差；
// 展示价与请求金额都必须过这一层，否则会出现 99.999999 这类脏值。
function roundCurrencyAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function isEnterpriseCodingPlanPaymentSuccessStatus(
  status: EnterpriseCodingPlanPaymentStatus,
): boolean {
  return status === "SUCCESS";
}

// [契约] 用常量表包含判断而非相等比较，新增失败态只需改常量。
// 未登记的 status 安全返回 false（视作进行中），不会误关支付弹窗。
export function isEnterpriseCodingPlanPaymentFailureStatus(
  status: EnterpriseCodingPlanPaymentStatus,
): boolean {
  return ENTERPRISE_CODING_PLAN_FAILURE_STATUSES.includes(
    status as (typeof ENTERPRISE_CODING_PLAN_FAILURE_STATUSES)[number],
  );
}

export function getEnterpriseCodingPlanFailureStatuses(): string[] {
  return [...ENTERPRISE_CODING_PLAN_FAILURE_STATUSES];
}

// [契约] 档位首字母大写作为商品名，空串原样返回避免显示空标题。
// 只做首字母加其余小写，不处理下划线或连字符；后端新增带分隔符的档位需在此补规则。
function formatEnterpriseCodingPlanTier(tier: EnterpriseCodingPlanPricingProduct["tier"]): string {
  const normalized = tier.trim();
  if (!normalized) {
    return tier;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function mapEnterpriseCodingPlanPriceUnit(
  period: EnterpriseCodingPlanSubscribePeriod,
): CodingPlanPriceUnit {
  return period === "YEARLY" ? "year" : period === "QUARTERLY" ? "quarter" : "month";
}
