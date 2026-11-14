/* eslint-disable max-lines -- Settings 与输入框共用连接方式可见性规则，集中放置避免 Start/Coding/Team/API 条件漂移。 */
// 职责边界：本文件是供应商家族连接方式可见性的唯一投影层，只读事实、只算可见性。
// 它不持有状态、不发请求、不写持久化，也不决定排序与文案样式，改渲染不该改这里。
// 输入三份只读事实：账号权益快照、企业团队套餐列表、shared settings 已保存的家族选择。
// 输出两份投影：按家族过滤后的连接项列表，以及由同一列表派生的可见 key 集合。
// 三个状态词互斥：已连接看账号事实，已配置看用户选择，可用看额度与凭据事实，不可互相代替。
// 家族维度只有 family：bigmodel 与 zai 必须对称，任何一家缺基线时只跳过该家，不许整体短路。
// 被隐藏的项一经过滤就不再参与计数、去重、锚点定位与合并，避免隐藏项反向污染可见结果。
// 无法判定时保留 checking 或 unavailable，绝不把未知折叠成未连接或未开通。
// Team Plan 的展示字段继承所属家族的 codingPlan 项，管理入口则指向团队套餐页。
// 改本文件只允许增删可见性规则，改账号事实、额度事实或存储格式都必须回到上游文件。
//
// INV 表：下列断言各有一条单点破坏路径，修复时先回到守住它的位置核对。
// INV-01 断言：账号未明确拥有权益时不得由旧凭据推出已连接 —— 守住它的位置：可检查性判定的早退分支 —— 改错故障：未登录却点亮连接态并读回旧凭据。
// INV-02 断言：首份权益视图晚于旧快照的窗口必须保持检查中 —— 守住它的位置：不可检查且仍在加载的返回块 —— 改错故障：窗口期误判断开并把用户踢回登录。
// INV-03 断言：拥有权益为假不等于没连上，必须按账号不可用原因分流 —— 守住它的位置：不可检查主分支的未开通与凭据失效判定 —— 改错故障：欠费或凭据失效被显示成未连接。
// INV-04 断言：服务端明确无个人套餐只算未开通，不算连接故障 —— 守住它的位置：未开通分支的未购买结果 —— 改错故障：引导用户重复登录或重试无效请求。
// INV-05 断言：凭据失效属于权益同步失败，必须保留可重试入口 —— 守住它的位置：凭据失效分支的不可用结果 —— 改错故障：用户没有重新登录入口。
// INV-06 断言：刷新期间保留上一轮快照，仅在无有效订阅时回退检查中 —— 守住它的位置：加载且无订阅的分支 —— 改错故障：已购用户状态卡每次刷新闪回加载中。
// INV-07 断言：权益请求失败必须退出加载态 —— 守住它的位置：无快照且有错误的分支 —— 改错故障：状态卡永久转圈且没有失败提示。
// INV-08 断言：已购判定以订阅详情为准，商品名缺失时才回退等级与商品标识 —— 守住它的位置：套餐字段派生段 —— 改错故障：有订阅却被判成未购买。
// INV-09 断言：快照无订阅且结论为失效才是未开通 —— 守住它的位置：失效结论的返回块 —— 改错故障：试用过期与从未购买被混为一谈。
// INV-10 断言：未知证据只能展示暂不可用，不能越权裁决账号断开 —— 守住它的位置：未知结论的返回块 —— 改错故障：已连接账号被权益层强制判成断开。
// INV-11 断言：Start Plan 条目只有在已登录或已有团队套餐时才保留 —— 守住它的位置：登录事实聚合处的已登录判定 —— 改错故障：未登录用户看到无法使用的连接方式。
// INV-12 断言：Start Plan 是独立连接，个人与团队 Coding 权益不参与其可见性 —— 守住它的位置：过滤末尾的保留条件 —— 改错故障：个人套餐订阅错误点亮或隐藏 Start Plan。
import type {
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
  UsageEntitlementSubscriptionDetail,
  UsageQuotaLimit,
} from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  getModelProviderFamilySpec,
  isIndividualCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  MODEL_PROVIDER_FAMILY_SPECS,
  resolveModelProviderFamilySpecByProviderId,
} from "@zcode/shared";
import { resolveMcpQuotaLimit } from "@/lib/codingPlanQuotaPresentation.js";
import { resolveUsageEntitlementOutcome } from "@/lib/codingPlanProvider.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";
import {
  resolveEnterpriseCodingPlanProductFamily,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import {
  type CodingPlanEntitlementState,
  type CodingPlanStatus,
  type ModelProviderNavGroup,
} from "@/settings/model-provider-section/constants.js";

type TeamPlanNavItem = Extract<ModelProviderNavGroup["items"][number], { type: "teamPlan" }>;

// [契约] teamPlan 导航 key 由家族、商品、组织、项目四段组成，缺段会与别家或别项目撞号。
// 每段先单独编码再拼接，避免组织名中的分隔符把后续段错位解析。
// key 只用于识别与选择恢复，不承载鉴权身份，改格式会让已保存的团队选择找不到落点。
function createTeamPlanNavigationKey(
  family: ProviderFamilyDomain,
  input: { productId: string; organizationId: string; projectId: string },
): string {
  return ["team", family, input.productId, input.organizationId, input.projectId]
    .map(encodeURIComponent)
    .join(":");
}

export interface ResolvedCodingPlanEntitlementState {
  statusLabelId?: string;
  status: CodingPlanStatus;
  planLevel: string | null;
  currentProductId: string | null;
  subscriptionBillingCycle: string | null;
  subscriptionRenewTime: string | null;
  subscriptionExpireTime: string | null;
  subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
  quotaLimits: UsageQuotaLimit[];
  /**
   * 官方 Server MCP 额度（服务端下发的总额度）。它不在 quota.limits[] 里，只在有套餐快照的分支填充；
   * 其余分支保持缺省（等价于不展示），避免十余处早退分支都要跟着改。
   */
  mcpQuotaLimit?: UsageQuotaLimit | null;
}

// [契约] 本函数只回答权益侧当前状态，不判断某个连接方式是否显示，也不决定文案。
// 已连接看账号快照，已配置看家族选择，可用看额度与凭据事实，这里只合并权益相关结论。
// 所有早退分支必须填齐同一组字段，缺字段会让下游状态卡把缺失当成空值展示。
export function resolveCodingPlanEntitlementState({
  providerId,
  accountEntitled,
  accountAvailability,
  accountUnavailableReason,
  entitlement,
  modelProvidersLoading,
}: {
  providerId: string;
  /** 当前账号是否明确拥有该 Provider 对应的产品权益。 */
  accountEntitled: boolean;
  accountAvailability?: import("@zcode/provider").AccountProviderState["availability"];
  accountUnavailableReason?: import("@zcode/provider").AccountProviderState["unavailableReason"];
  entitlement?: CodingPlanEntitlementState;
  modelProvidersLoading: boolean;
}): ResolvedCodingPlanEntitlementState {
  // [失败路径] 可检查性先于加载态判定：拥有权益、状态待定、以及 Start 的未知都允许继续读取。
  // Start 的校验失败是未知事实，不是未登录，回退成未登录会掐掉唯一的读取与重试路径。
  // 两段顺序不能调换，否则加载窗口会把可检查账号提前判成断开。
  // Start 校验失败是未知，仍允许读取/重试，不能回退为未登录。
  const canInspect =
    accountEntitled ||
    accountAvailability === "pending" ||
    (isStartPlanModelProviderId(providerId) && accountAvailability === "unknown");
  // [并发] 新 Host 启动时账号覆盖层首份视图可能晚于旧供应商快照到达。
  // 该窗口只能返回检查中，既不能读旧凭据，也不能提前判定断开。
  // 用加载态把时间差显式化后，后续分支才能安全地按不可用原因分流，否则用户会看到虚假的断开闪烁。
  if (!canInspect && modelProvidersLoading) {
    return {
      // 新 Host 启动时 Account Overlay 的首份 View 可能晚于旧
      // Provider 快照。该窗口必须保持 checking，不能读旧 Key，也不能提前判定断开。
      status: "checking",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }
  // [失败路径] 到这里说明账号侧明确不可检查，权益层无权再发查询，只能按随状态下发的原因分流。
  // 原因只在账号不可用时成立，未知表示本轮无法判定，不能当成不可用处理。
  // 个人 Coding 与 Start 走原因分流，团队继续由团队权益快照组装，两条路径不互相兜底。
  if (!canInspect) {
    // entitled=false 不等于"没连上"。provider-refactor 之后 Account Overlay 只发布
    // entitled 布尔值，"已登录且服务端明确回答没有个人套餐"与"未连接"被合并渲染成
    // "未连接 + 连接按钮"（不由权益快照的 no_plan 判定为"未开通"），且不可用 provider
    // 不会再发起权益查询，UI 无法自行还原原因，只能依赖随 State 下发的原因分流。
    // Start 常驻后同样按原因展示；Team Plan 继续由团队权益快照组装。
    // 原因只在 availability === "unavailable" 时成立，unknown 表示本轮无法判定。
    if (
      accountAvailability === "unavailable" &&
      (isIndividualCodingPlanModelProviderId(providerId) || isStartPlanModelProviderId(providerId))
    ) {
      // [契约] 未拥有个人套餐是服务端明确回答，语义是未开通，不是连接故障。
      // Start 过期时补过期标签，其余情况只给未购买状态。
      // 这里不提供重试入口，因为重试同一个无权益请求不会改变结论。
      if (accountUnavailableReason === "not-entitled") {
        return {
          // 服务端明确无个人套餐：这是"未开通"，不是连接故障。
          status: "notPurchased",
          ...(isStartPlanModelProviderId(providerId) && entitlement?.snapshot?.startPlanExpired
            ? { statusLabelId: "settings.modelProvider.startPlan.status.expired" }
            : {}),
          planLevel: null,
          currentProductId: null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          quotaLimits: [],
        };
      }
      // [失败路径] 凭据失效属于权益同步失败，必须保留可重试与重新登录的可能。
      // 因此返回不可用而不是未购买，避免把技术故障说成没买。
      // 它与未开通分支的区别只在状态取值，字段集合必须完全一致。
      if (accountUnavailableReason === "credential-failed") {
        return {
          // 凭据失效属于权益同步失败，不是未购买；保持可重试/重新登录入口。
          status: "unavailable",
          planLevel: null,
          currentProductId: null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          quotaLimits: [],
        };
      }
    }
    return {
      // 套餐连接是 Account Overlay 事实，不是 Renderer 能读取的
      // API Key 事实。新 Host 明确传入 false 后，旧 Key 不得再点亮连接态。
      status:
        isStartPlanModelProviderId(providerId) && accountAvailability === "unknown"
          ? "unavailable"
          : "disconnected",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  const snapshot = entitlement?.snapshot ?? null;
  // [权衡] 刷新会保留上一轮快照，所以加载态只在没有有效订阅时才可见。
  // 已购用户的旧快照继续作为展示事实，避免每次刷新都闪回检查中。
  // 一旦存在订阅就必须走已购分支，不能让加载态覆盖既有的购买结论。
  if (entitlement?.loading && !snapshot?.subscription) {
    return {
      // refresh 会保留上一轮 snapshot；只有没有有效 subscription 时才显示 checking。
      status: "checking",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  // [失败路径] 请求失败且没有旧快照时必须退出加载态，否则状态卡会永久转圈。
  // 退出方式是返回不可用，把失败暴露给调用方，而不是伪造未购买。
  // 有旧快照时失败不影响展示，只在已购结果上补一个不可用标签。
  if (!snapshot && entitlement?.error) {
    return {
      // 权益请求失败时必须退出 loading 态。
      status: "unavailable",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  const currentSubscription = snapshot?.subscription?.details[0] ?? null;
  // [契约] 套餐字段全部从订阅详情首条派生，额度与官方 MCP 额度只在该分支填充。
  // 商品名优先于额度等级，再退到商品标识，保证已购判定不会因缺名而落空。
  // 订阅列表整体保留给详情页，首条只用于状态卡主商品，缺省额度等价于不展示。
  const subscriptionDetails = snapshot?.subscription?.details ?? [];
  const currentProductId = currentSubscription?.productId ?? null;
  const planLevel =
    currentSubscription?.productName ?? snapshot?.quota?.level ?? currentProductId ?? null;
  const subscriptionBillingCycle = currentSubscription?.billingCycle ?? null;
  const subscriptionRenewTime = currentSubscription?.renewTime ?? null;
  const subscriptionExpireTime = currentSubscription?.expireTime ?? null;

  // [契约] currentSubscription 非空即判 purchased，不再拿 quota 是否存在做二次判定。
  // 即使本轮同步带了错误，也只附一个不可用标签，不降级成未购买或断开。
  // 该分支同时产出个人与团队共用的额度字段，后续分支不得再改写。
  if (currentSubscription) {
    return {
      // Z.AI/BigModel 的真实套餐状态来自 subscription/list。
      status: "purchased",
      ...(entitlement?.error
        ? { statusLabelId: "settings.modelProvider.codingPlan.status.unavailable" }
        : {}),
      planLevel,
      currentProductId,
      subscriptionBillingCycle,
      subscriptionRenewTime,
      subscriptionExpireTime,
      subscriptionDetails,
      quotaLimits: snapshot?.quota?.limits ?? [],
      mcpQuotaLimit: resolveMcpQuotaLimit(snapshot),
    };
  }

  // [契约] 没有订阅时由快照结论决定未开通、未知还是已购兜底，三种结论互斥。
  // 失效表示明确不可用，未知表示证据不足，其余情况按已购兜底。
  // 顺序不能交换，未知若先被当成未开通，会把试用过期与从未购买混在一起。
  const entitlementOutcome = resolveUsageEntitlementOutcome(snapshot);
  // [契约] 失效结论是明确的未开通，过期标签只对 Start 生效。
  // 该分支不返回额度，避免详情页展示已失效套餐的残留限制。
  if (entitlementOutcome === "inactive") {
    return {
      status: "notPurchased",
      ...(isStartPlanModelProviderId(providerId) && snapshot?.startPlanExpired
        ? { statusLabelId: "settings.modelProvider.startPlan.status.expired" }
        : {}),
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  // [失败路径] 未知证据只能展示暂不可用，绝不能被当成断开或未购买。
  // 账号已连接时，权益侧的未知不得反向裁决账号事实。
  // 这也是过去把非明确无套餐快照兜底成未购买的修正点。
  if (entitlementOutcome === "unknown") {
    return {
      // 过去把非 no_plan 的未知快照兜底成“未购买”，并让 entitlement
      // 越权裁决 Account 是否断开。账号已连接时，未知证据只能展示暂不可用。
      status: "unavailable",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  return {
    status: "purchased",
    ...(entitlement?.error
      ? { statusLabelId: "settings.modelProvider.codingPlan.status.unavailable" }
      : {}),
    planLevel,
    currentProductId,
    subscriptionBillingCycle,
    subscriptionRenewTime,
    subscriptionExpireTime,
    subscriptionDetails,
    quotaLimits: snapshot?.quota?.limits ?? [],
    mcpQuotaLimit: resolveMcpQuotaLimit(snapshot),
  };
}

// [契约] 可见性装配只做两段：先按权益过滤 Start Plan，再按家族追加团队套餐项。
// 过滤在前、追加在后，保证团队项以过滤后的列表为基线定位插入点。
// 本函数不读账号与额度原始快照，只消费调用方传入的权益状态与产品列表，隐藏项不占位。
export function buildVisibleFamilyConnectionItems({
  items,
  codingPlanEntitlements = {},
  subscribedTeamProducts,
  connectionSelections,
  teamPlanSelections,
  showPurchasedTeamPlanFallback,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements?: Partial<Record<string, CodingPlanEntitlementState>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  teamPlanSelections?: Partial<
    Record<
      ProviderFamilyDomain,
      Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>
    >
  >;
}): ModelProviderNavGroup["items"] {
  return appendSubscribedTeamPlanItems({
    items: filterStartPlanItemsByEntitlement({
      items,
      codingPlanEntitlements,
      subscribedTeamProducts,
      connectionSelections,
    }),
    codingPlanEntitlements,
    teamPlanSelections,
    showPurchasedTeamPlanFallback,
    subscribedTeamProducts,
  });
}

// [权衡] 可见 key 复用同一套装配逻辑，但把权益、家族选择与团队选择一并清空。
// 这样得到的集合只反映结构上必然可见的连接方式，不随实时权益抖动。
// 被隐藏的项不会出现在集合里，因此下游计数与对比天然排除隐藏项。
export function buildVisibleFamilyConnectionKeys({
  items,
  subscribedTeamProducts,
  showPurchasedTeamPlanFallback,
  modelProviders,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback: boolean;
  modelProviders: readonly ProviderSettingsFormProvider[];
}): Set<string> {
  const visibleItems = buildVisibleFamilyConnectionItems({
    items,
    codingPlanEntitlements: {},
    subscribedTeamProducts,
    connectionSelections: {},
    teamPlanSelections: {},
    showPurchasedTeamPlanFallback,
  });
  const keys = new Set(visibleItems.map((item) => item.key));
  void modelProviders;
  return keys;
}

// [契约] 该过滤只处理 Start 家族条目，其他家族条目原样放行。
// 登录事实由条目自身、同家族个人 Coding 条目、已解析状态以及团队套餐共同聚合。
// 任一来源成立即视为已登录，结果只决定可见性，不改写条目内的状态与文案。
function filterStartPlanItemsByEntitlement({
  items,
  codingPlanEntitlements,
  subscribedTeamProducts,
  connectionSelections,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
}): Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>> {
  // 原变量名 hasBigModelTeamPlan 暗示只服务 bigmodel，但逻辑
  // （entitlement 或 subscribedTeamProducts）本身是 family 无关的。
  // 重命名为中性名称，并在下方 filter 去掉 familySpec.id === "bigmodel" 守卫，
  // 让 zai family 也能因 team plan 过滤 Start Plan 入口。
  // [契约] 团队套餐事实对家族无差别：权益快照出现团队范围，或企业产品列表非空都算。
  // 变量名刻意保持中性，避免历史命名让人误以为只服务单一家族。
  // 该事实只用于放行 Start Plan，不参与团队项自身的构造。
  const hasAnyTeamPlan =
    hasEntitlementTeamPlan(codingPlanEntitlements) || subscribedTeamProducts.length > 0;
  return items.filter((item) => {
    if (!isStartPlanModelProviderId(item.presetId)) {
      return true;
    }
    // [契约] 家族规格按条目预设反查，反查不到说明该条目不属于任何已注册家族。
    // 无法归类时直接隐藏，宁可少一个入口，也不让孤立条目连到错误的套餐上下文。
    // 家族规格同时给出个人与团队的 Coding 预设，是后续聚合的唯一来源。
    const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
    if (!familySpec) {
      return false;
    }
    const codingItem = items.find(
      (candidate) => candidate.presetId === familySpec.individualCodingPlanProviderId,
    );
    const hasStartPlanEntitlement = item.status === "purchased";
    const isSelectedStartPlan = connectionSelections?.[familySpec.id]?.kind === "start-plan";
    const shouldPreserveUnresolvedSelection =
      isSelectedStartPlan && (item.status === "checking" || item.status === "unavailable");
    const loggedIn =
      item.accountEntitled === true ||
      codingItem?.accountEntitled === true ||
      isResolvedEntitlementStatus(item.status) ||
      isResolvedEntitlementStatus(codingItem?.status ?? "disconnected") ||
      hasAnyTeamPlan;

    // [契约] 未登录时体验套餐只作为详情页引导，不作为连接方式出现在列表里。
    // 未登录只过滤体验套餐的列表入口，loggedIn 变真后同一次计算即可恢复。
    // 隐藏项从此刻起不参与后续任何计数与去重。
    if (!loggedIn) {
      // 未登录时体验套餐只作为详情页引导入口，不作为连接方式。
      return false;
    }

    // Start Plan 是独立连接；个人/团队 Coding 权益不再参与可见性判断。
    // 查询中或临时不可用时保留用户已选项，只有自身明确无权益才隐藏。
    // [失败路径] Start Plan 是独立连接，个人与团队 Coding 权益不再参与它的可见性。
    // 自身已购才常驻，查询中或临时不可用时保留用户已选项，避免选择被瞬间清空。
    // 只有自身明确无权益才隐藏，未知一律按保留处理，且该豁免只对已选家族生效。
    return hasStartPlanEntitlement || shouldPreserveUnresolvedSelection;
  });
}

/**
 * 按 family 查找对应 family 的 Coding Plan nav item。
 * 原 appendSubscribedTeamPlanItems 硬编码找 bigmodelCodingPlan，
 * zai team plan items 无对应展示基线。zai/bigmodel 对称化后，team item 的
 * providerName、provider 等展示字段应继承自所属 family 的 codingPlanItem。
 */
function resolveCodingPlanItemForFamily(
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>,
  family: ProviderFamilyDomain,
): Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }> | undefined {
  const codingPlanProviderId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  return items.find((item) => item.presetId === codingPlanProviderId);
}

// [契约] 团队项按三个来源构造：权益快照、已保存选择兜底、企业订阅产品，再合并去重。
// 三路都以所属家族的个人 Coding 项为展示基线，缺基线就跳过该家族，不整体短路。
// 历史实现以单一家族为前置守卫，会让另一家族的团队入口永不生成，合并优先级固定为权益、兜底、产品。
function appendSubscribedTeamPlanItems({
  items,
  codingPlanEntitlements,
  teamPlanSelections,
  showPurchasedTeamPlanFallback,
  subscribedTeamProducts,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  teamPlanSelections?: Partial<
    Record<
      ProviderFamilyDomain,
      Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>
    >
  >;
  showPurchasedTeamPlanFallback: boolean;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
}): ModelProviderNavGroup["items"] {
  // 原实现先 items.find(bigmodelCodingPlan)，不存在时直接 return items。
  // 当设置页只展示 zai family（providerFamilyDomain === "zai"）时，codingPlanItems 里
  // 没有 bigmodelCodingPlan，这个守卫会让 appendSubscribedTeamPlanItems 整体短路，
  // zai teamPlan item 永远不生成 → pickFamilyModeNavigationItem 找不到 saved team item
  // → selectedNavItem=null → 右侧 Plan Card 永远卡在 "加载中"。
  // 对称化：去掉 bigmodel 硬编码前置守卫，entitlement/fallback/product 三个 builder
  // 各自按 family 解析对应 codingPlanItem，不存在就跳过该 family。

  // entitlement + fallback 两个 builder 原来只对 bigmodelCodingPlanItem 调用，
  // zai 的 entitlement snapshot 和 fallback selectedKey 永远不生成 team item（断裂）。
  // 遍历两个 family，各用对应 codingPlanItem 派生 entitlement team items + fallback。
  // [契约] 权益团队项按家族规格逐个展开，每个家族只读自己团队预设对应的权益桶。
  // 家族缺展示基线时返回空数组，其他家族照常产出。
  // entitlementTeamItems 保持原样不去重，重复项在校正阶段按 resolveTeamPlanProjectKey 合并。
  const entitlementTeamItems: TeamPlanNavItem[] = MODEL_PROVIDER_FAMILY_SPECS.flatMap(
    ({ id: family }) => {
      const codingPlanItem = resolveCodingPlanItemForFamily(items, family);
      if (!codingPlanItem) {
        return [];
      }
      return buildEntitlementTeamPlanItems(codingPlanItem, codingPlanEntitlements, family);
    },
  );
  // [契约] fallbackTeamItems 只在 teamPlanSelections[family] 与 codingPlanItem 同时存在时生成。
  // 它解决企业产品列表尚未返回时，设置页与输入框选择短暂断裂的问题。
  // showPurchasedTeamPlanFallback 为假时 buildSelectedTeamPlanFallbackItems 返回空，兜底项不会出现。
  const fallbackTeamItems: TeamPlanNavItem[] = MODEL_PROVIDER_FAMILY_SPECS.flatMap(
    ({ id: family }) => {
      const selection = teamPlanSelections?.[family];
      const codingPlanItem = resolveCodingPlanItemForFamily(items, family);
      return selection && codingPlanItem
        ? buildSelectedTeamPlanFallbackItems({
            codingPlanItem,
            selection,
            showPurchasedTeamPlanFallback,
            family,
          })
        : [];
    },
  );
  if (
    entitlementTeamItems.length === 0 &&
    fallbackTeamItems.length === 0 &&
    subscribedTeamProducts.length === 0
  ) {
    return items;
  }

  const seenTeamKeys = new Set<string>();
  const productTeamItems: TeamPlanNavItem[] = subscribedTeamProducts.flatMap((product) => {
    // 按 product.family 找对应 family 的 codingPlanItem 作为 team item 的展示基线。
    // 缺省 bigmodel，向后兼容未标记 family 的旧数据。
    const productFamily = resolveEnterpriseCodingPlanProductFamily(product);
    const codingPlanItemForProduct = resolveCodingPlanItemForFamily(items, productFamily);
    if (!codingPlanItemForProduct) {
      return [];
    }
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              organizationName: product.organizationName ?? null,
              projectId: product.projectId ?? null,
              projectName: product.projectName ?? null,
              apiKeyStatus: product.apiKeyStatus,
              apiKeyUnavailableReason: product.apiKeyUnavailableReason,
              apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
            },
          ];

    return projectContexts.flatMap((projectContext) => {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectKey = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectKey) {
        return [];
      }
      // 去重 key 必须包含 family 维度，否则 zai/bigmodel 相同 productId+org+project 会互相覆盖。
      // [事务] 产品团队项的去重键必须带家族维度，否则两家相同商品与组织会互相覆盖。
      // 四段拼接在一次遍历内完成判重与登记，保证同一项目只产出一个连接项。
      // 组织或项目为空的上下文在进入这里之前已被过滤，不参与去重登记。
      const teamKey = `${productFamily}:${product.productId}:${organizationId}:${projectKey}`;
      if (seenTeamKeys.has(teamKey)) {
        return [];
      }
      seenTeamKeys.add(teamKey);
      const teamPlanName = resolveTeamPlanDisplayName({
        ...product,
        organizationName: projectContext.organizationName ?? product.organizationName,
        projectName: projectContext.projectName ?? product.projectName,
      });
      if (!teamPlanName) {
        // Team Plan 可见文案只允许使用组织名；缺失时不能渲染空白连接项。
        return [];
      }
      // [契约] 团队项不可用由两个独立事实合并：项目凭据不可用，或团队额度未分配。
      // 前者来自组织与项目维度的凭据状态，后者来自团队范围额度快照的缺失。
      // 两者可同时成立，展示原因优先取凭据不可用，因为它是更前置的阻断，但条目不会被隐藏。
      const teamProjectApiKeyUnavailable = projectContext.apiKeyStatus === "unavailable";
      const teamQuotaUnavailable = isTeamPlanQuotaUnavailable({
        codingPlanEntitlements,
        family: productFamily,
        organizationId,
        projectId: projectKey,
      });
      const teamPlanUnavailable = teamProjectApiKeyUnavailable || teamQuotaUnavailable;
      const availabilityReason = teamProjectApiKeyUnavailable
        ? ("credential-unavailable" as const)
        : teamQuotaUnavailable
          ? ("not-allocated" as const)
          : undefined;
      return [
        {
          ...codingPlanItemForProduct,
          // 展示 key 按 family 和完整团队项目生成，不复用请求鉴权身份。
          key: createTeamPlanNavigationKey(productFamily, {
            productId: product.productId,
            organizationId,
            projectId: projectKey,
          }),
          presetId: getModelProviderFamilySpec(productFamily).teamCodingPlanProviderId,
          type: "teamPlan" as const,
          label: `${codingPlanItemForProduct.providerName} - ${teamPlanName}`,
          teamPlanName,
          organizationId,
          projectId: projectKey,
          // Team Plan 状态卡应和连接方式使用同一个团队显示名。
          // 直接展示 productName/tier 会在中文环境退回“标准版/高级版”，丢失项目或组织名称。
          planLevel: teamPlanName,
          inactivePlanTitle: teamPlanName,
          currentProductId: product.productId,
          // Team Plan 复用对应 family 的 Coding Plan provider，但管理入口必须进入团队套餐页；
          // 继续继承个人 Coding Plan 的 personal/overview 会把用户带到错误的套餐上下文。
          purchaseUrl: getModelProviderFamilySpec(productFamily).teamCodingPlanManageUrl,
          // 修复原因：Team Plan 入口存在、项目 Key ID 已就绪，都不能证明团队套餐有效。
          // 有效性必须由团队 quota snapshot 决定，避免继续显示个人套餐的已启用状态。
          status: teamPlanUnavailable ? ("unavailable" as const) : ("purchased" as const),
          // Project Key 不可用和 Team quota 未分配是不同事实。
          // 只有服务端明确没有团队额度时才展示“团队套餐未分配”。
          statusLabelId:
            availabilityReason === "not-allocated"
              ? "settings.modelProvider.codingPlan.status.teamUnavailable"
              : undefined,
          availabilityReason,
          statusMessage: teamProjectApiKeyUnavailable
            ? (projectContext.apiKeyUnavailableMessage?.trim() ?? null)
            : null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          // 修复原因：Team Plan 项目无法取得专用 Key ID 时不能换 Token，连接方式应标为不可用。
          // 服务端会按组织/项目返回 apiKeyStatus；UI 需要在连接项和状态卡中明确标成不可用。
          statusActive: !teamPlanUnavailable,
        },
      ];
    });
  });

  // [事务] 产品团队项按项目键建索引，再用它校正权益与兜底两路同项目的条目。
  // 校正只替换展示字段，不新增或删除项目，保证三路对同一项目给出同一份事实。
  // 项目键由组织与项目拼成，缺失时退到导航 key，且该步骤必须发生在合并之前。
  const productTeamItemsByProjectKey = new Map(
    productTeamItems.map((item) => [resolveTeamPlanProjectKey(item), item] as const),
  );
  const correctedEntitlementTeamItems = entitlementTeamItems.map(
    (item) => productTeamItemsByProjectKey.get(resolveTeamPlanProjectKey(item)) ?? item,
  );
  const correctedFallbackTeamItems = fallbackTeamItems.map(
    (item) => productTeamItemsByProjectKey.get(resolveTeamPlanProjectKey(item)) ?? item,
  );
  const correctedProjectKeys = new Set(
    correctedEntitlementTeamItems.map(resolveTeamPlanProjectKey),
  );
  const correctedFallbackProjectKeys = new Set(
    correctedFallbackTeamItems.map(resolveTeamPlanProjectKey),
  );
  // [契约] 合并顺序固定：校正后的权益项、未被权益覆盖的兜底项、剩余产品项。
  // 两级过滤都以项目键为口径，先到者优先，后到者必须让位。
  // 被 filter 淘汰的项不进 teamItems，所以既不计入条数也不参与 resolveTeamPlanProjectKey 锚点定位。
  const teamItems: ModelProviderNavGroup["items"] = [
    ...correctedEntitlementTeamItems,
    ...correctedFallbackTeamItems.filter(
      (item) => !correctedProjectKeys.has(resolveTeamPlanProjectKey(item)),
    ),
    ...productTeamItems.filter(
      (item) =>
        !correctedProjectKeys.has(resolveTeamPlanProjectKey(item)) &&
        !correctedFallbackProjectKeys.has(resolveTeamPlanProjectKey(item)),
    ),
  ];

  if (teamItems.length === 0) {
    return items;
  }

  // 原写法硬编码 items.findIndex(bigmodelCodingPlanItem.key) 作为插入点，
  // zai-only 视图下 bigmodelCodingPlanItem 不存在会 throw（.key 访问 undefined）。
  // 改为按首个 team item 所属 family 找对应 codingPlanItem 作为插入锚点；
  // 找不到就追加到末尾（与原 fallback 语义一致）。
  // [资源] 插入锚点取首个团队项所属家族的 Coding 项，找不到就整体追加到末尾。
  // 这样在只展示单一家族的视图里也有合法锚点，不会再解引用不存在的条目。
  // 锚点只影响位置，不影响团队项内容与可见性。
  const firstTeamFamily = resolveModelProviderFamilySpecByProviderId(
    (teamItems[0] as TeamPlanNavItem | undefined)?.presetId ?? "",
  )?.id;
  const anchorCodingPlanItem = firstTeamFamily
    ? resolveCodingPlanItemForFamily(items, firstTeamFamily)
    : undefined;
  const codingPlanIndex = anchorCodingPlanItem
    ? items.findIndex((item) => item.key === anchorCodingPlanItem.key)
    : -1;
  if (codingPlanIndex < 0) {
    return [...items, ...teamItems];
  }
  return [
    ...items.slice(0, codingPlanIndex + 1),
    ...teamItems,
    ...items.slice(codingPlanIndex + 1),
  ];
}

function resolveTeamPlanDisplayName(product: EnterpriseCodingPlanProductDisplay): string | null {
  return formatTeamPlanDisplayName(product);
}

// [契约] 团队权益存在要求快照范围是团队，且组织与项目同时非空。
// 只判断存在性，不判断额度、状态或是否已购。
// 它只服务于登录事实聚合，不能拿来当团队项有效性证据。
function hasEntitlementTeamPlan(
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>,
): boolean {
  return Object.values(codingPlanEntitlements).some(
    (entitlement) =>
      entitlement?.snapshot?.context?.scope === "team" &&
      Boolean(entitlement.snapshot.context.organizationId?.trim()) &&
      Boolean(entitlement.snapshot.context.projectId?.trim()),
  );
}

// [契约] 权益团队项以团队范围快照为主数据源，缺失或范围不符时返回空。
// 商品标识与团队名按快照上下文、订阅详情、展示基线依次回退，最后给中性兜底。
// 该路产出的条目状态恒为已购，后续由产品团队项按项目键校正。
function buildEntitlementTeamPlanItems(
  codingPlanItem: Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>,
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>,
  family: ProviderFamilyDomain,
): TeamPlanNavItem[] {
  // 原硬编码读 bigmodelCodingPlan bucket + bigmodel team key。
  // zai/bigmodel 对称化后，按 family 读对应 codingPlan bucket、生成对应前缀 team key。
  const familySpec = getModelProviderFamilySpec(family);
  const codingPlanProviderId = familySpec.teamCodingPlanProviderId;
  const entitlement = codingPlanEntitlements[codingPlanProviderId];
  if (!entitlement) {
    return [];
  }
  const snapshot = entitlement.snapshot ?? null;
  if (snapshot?.context?.scope !== "team") {
    return [];
  }
  const organizationId = snapshot.context.organizationId?.trim() ?? "";
  const projectId = snapshot.context.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return [];
  }
  const currentSubscription = snapshot.subscription?.details[0] ?? null;
  const productId =
    snapshot.context.productId?.trim() ||
    currentSubscription?.productId?.trim() ||
    codingPlanItem.currentProductId?.trim() ||
    "current";
  const teamPlanName =
    snapshot.context.displayName?.trim() ||
    currentSubscription?.productName?.trim() ||
    codingPlanItem.planLevel?.trim() ||
    "Team";
  return [
    {
      ...codingPlanItem,
      key: createTeamPlanNavigationKey(family, {
        productId,
        organizationId,
        projectId,
      }),
      presetId: codingPlanProviderId,
      type: "teamPlan" as const,
      label: `${codingPlanItem.providerName} - ${teamPlanName}`,
      teamPlanName,
      organizationId,
      projectId,
      status: "purchased" as const,
      // Team Plan 连接项先以 entitlement snapshot 为主数据源。
      // enterprise pricing/customerInfo 只负责后续校正名称和商品字段，不能让连接方式退回 Coding Plan。
      planLevel: teamPlanName,
      currentProductId: productId,
      purchaseUrl: familySpec.teamCodingPlanManageUrl,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      statusActive: true,
    },
  ];
}

// [契约] 兜底团队项直接由已保存选择构造，代表用户已配置这一事实。
// 它不断言额度有效，只保证设置页与输入框看到同一个选择。
// 条目是否真正出现还取决于购买兜底开关，开关是唯一外部条件。
function buildSelectedTeamPlanFallbackItems({
  codingPlanItem,
  selection,
  showPurchasedTeamPlanFallback,
  family,
}: {
  codingPlanItem: Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>;
  selection: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
  showPurchasedTeamPlanFallback: boolean;
  family: ProviderFamilyDomain;
}): TeamPlanNavItem[] {
  if (!showPurchasedTeamPlanFallback) {
    return [];
  }
  const teamPlanName = codingPlanItem.planLevel?.trim() || "Team";
  const familySpec = getModelProviderFamilySpec(family);
  const teamProviderId = familySpec.teamCodingPlanProviderId;
  return [
    {
      ...codingPlanItem,
      key: createTeamPlanNavigationKey(family, {
        productId: selection.productId,
        organizationId: selection.organizationId,
        projectId: selection.projectId,
      }),
      presetId: teamProviderId,
      type: "teamPlan" as const,
      label: `${codingPlanItem.providerName} - ${teamPlanName}`,
      teamPlanName,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
      status: "purchased" as const,
      // enterprise pricing 可能尚未返回 subscribed 团队项目，
      // 但 shared settings 已保存 Team Plan selectedKey。设置页需要先展示同一连接方式，
      // 避免和输入框/registry 的 Team Plan 选择短暂断裂。
      planLevel: teamPlanName,
      currentProductId: selection.productId,
      purchaseUrl: familySpec.teamCodingPlanManageUrl,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      statusActive: true,
    },
  ];
}

// [契约] 该判定只回答团队额度是否明确未分配，不做任何猜测。
// 仅当权益已加载、无错误、范围是团队、组织与项目完全匹配且快照无额度时才成立。
// 判定为真会把团队项降级为不可用并附未分配标签，但不隐藏条目。
function isTeamPlanQuotaUnavailable({
  codingPlanEntitlements,
  family,
  organizationId,
  projectId,
}: {
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  family: ProviderFamilyDomain;
  organizationId: string;
  projectId: string;
}): boolean {
  const codingPlanProviderId = getModelProviderFamilySpec(family).teamCodingPlanProviderId;
  const entitlement = codingPlanEntitlements[codingPlanProviderId];
  // loading/error 都表示额度事实尚未确定，不能把暂时没有 quota
  // 当成服务端明确返回的“团队套餐未分配”。详情页仍会主动刷新这条连接。
  // [失败路径] 缺少权益、加载中或有错误，都表示额度事实尚未确定。
  // 此时一律返回非未分配，避免把暂时没有额度说成服务端明确拒绝。
  // 详情页仍会主动刷新这条连接，临时假阴性比误报更安全。
  if (!entitlement || entitlement.loading || entitlement.error) {
    return false;
  }
  const snapshot = entitlement.snapshot ?? null;
  if (snapshot?.context?.scope !== "team") {
    return false;
  }
  if (
    snapshot.context.organizationId?.trim() !== organizationId ||
    snapshot.context.projectId?.trim() !== projectId
  ) {
    return false;
  }
  return !snapshot.quota;
}

function resolveTeamPlanProjectKey(item: TeamPlanNavItem): string {
  const organizationId = item.organizationId?.trim() || "";
  const projectId = item.projectId?.trim() || "";
  if (organizationId && projectId) {
    return `${organizationId}:${projectId}`;
  }
  return item.key;
}

// [契约] 已解析状态排除检查中与断开，其余都算账号侧已有结论。
// 该判定用于登录事实聚合，不区分已购、未开通与不可用。
// 放宽或收紧它都会直接改变 Start Plan 的可见性。
function isResolvedEntitlementStatus(status: CodingPlanStatus): boolean {
  return status !== "checking" && status !== "disconnected";
}
