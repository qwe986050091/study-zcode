// INV-01 标识生成只走统一工具：守住位置 标识函数；改错故障：各处自行拼串会让标识格式分叉。
// INV-02 订阅超时是固定两分钟：守住位置 常量；改错故障：各处自定超时会让预置流程行为不一致。
// INV-03 注册与购买链接由共享工具按环境拼出：守住位置 链接常量；改错故障：写死域名会让测试环境打到生产。
// INV-04 预置厂商只列启动套餐两家：守住位置 预置表；改错故障：把套餐厂商标成预置会让侧栏多出入口。
// INV-05 预置厂商的 id 与展示名成对出现：守住位置 表项结构；改错故障：缺展示名会让入口没有可读文字。
// INV-06 预置厂商按 id 建索引供查表：守住位置 索引常量；改错故障：每次线性查找会让渲染路径多一次扫描。
// INV-07 编码套餐 id 只含六个内置标识：守住位置 联合类型；改错故障：放开为任意字符串会让规格表查不到。
// INV-08 编码套餐状态是固定字面量：守住位置 状态类型；改错故障：自由字符串会让状态分支漏判。
// INV-09 团队不可用原因只有三种：守住位置 原因类型；改错故障：新增原因不更新分支会落到默认展示。
// INV-10 编码套餐规格按 id 唯一：守住位置 规格表；改错故障：重复 id 会让查表结果依赖表顺序。
// INV-11 每条规格带 oauth 标识与展示标签：守住位置 表项结构；改错故障：缺标识会让连接流程不知道走哪家授权。
// INV-12 购买链接缺失表示不支持自助购买：守住位置 可选字段；改错故障：统一兜底链接会把用户带到错误页面。
// INV-13 个人与团队套餐共用同一展示标签：守住位置 标签取值；改错故障：分叉文案会让同一套餐出现两个名字。
// INV-14 启动套餐显示名统一为 Start Plan：守住位置 展示名解析；改错故障：按品牌显示会让两个入口看起来很不一样。
// INV-15 未识别的厂商回落到通用表单标签：守住位置 解析末尾；改错故障：返回空会让侧栏出现无名项。
// INV-16 导航项按类型区分五种形态：守住位置 联合类型；改错故障：合并成一种形态会让可选字段互相污染。
// INV-17 团队项额外带团队名与组织项目身份：守住位置 团队分支；改错故障：缺身份会让团队额度查询打错组织。
// INV-18 加载项不携带状态字段：守住位置 加载分支；改错故障：沿用状态字段会让占位项被当成已连接。
//
// 模块职责：CODING_PLAN_PROVIDER_SPECS —— 保存预置厂商与编码套餐的静态表，并解析它们的展示名与导航项形态。
// 状态所有权：无状态；全部是模块级常量与纯函数。
// 阅读顺序：先看预置厂商与索引，再看编码套餐 id、状态与规格表，最后看展示名解析与导航项联合类型。
import {
  BIGMODEL_PROVIDER_ID,
  buildBigModelApiUrl,
  buildBigModelCodingPlanPersonalManageUrl,
  BUILTIN_MODEL_PROVIDER_IDS,
  createUuid,
  type OAuthProviderId,
  ZCODE_ENV,
  ZAI_PROVIDER_ID,
  type BuiltinModelProviderId,
  type UsageQuotaLimit,
  type UsageEntitlementSubscriptionDetail,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";

// generateId 只转调 createUuid：集中在统一工具里，各处自己拼串会让 id 格式分叉；本函数无副作用。
export function generateId(): string {
  return createUuid();
}

export const PRESET_SUBSCRIPTION_TIMEOUT_MS = 2 * 60 * 1000;
export const BIGMODEL_REGISTRATION_URL = buildBigModelApiUrl({ ZCODE_ENV }, "/login");
export const BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL = buildBigModelCodingPlanPersonalManageUrl({
  ZCODE_ENV,
});

export interface PresetProviderSpec {
  id: BuiltinModelProviderId;
  displayName: string;
  oauthProviderId?: OAuthProviderId;
}

// PRESET_PROVIDER_SPECS 只列启动套餐两家，数组顺序就是侧栏展示顺序（顺序漂移会让入口位置变化）。
// 每项带 oauthProviderId 走对应授权流程；PRESET_PROVIDER_SPEC_BY_ID 在模块加载时一次建好，预置厂商不查额度。
export const PRESET_PROVIDER_SPECS: PresetProviderSpec[] = [
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    displayName: "Z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    displayName: "BigModel",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
  },
];

export const PRESET_PROVIDER_SPEC_BY_ID = new Map<BuiltinModelProviderId, PresetProviderSpec>(
  PRESET_PROVIDER_SPECS.map((item) => [item.id, item]),
);

// CodingPlanProviderId 是六个内置标识的字面量联合：个人与团队与启动三类各两家，覆盖 Z.ai 与 BigModel。
// 用字符串字面量而非枚举：序列化后天然可读，且不做运行期校验；新增标识必须同步规格表与展示名分支。
export type CodingPlanProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;

export type CodingPlanStatus =
  | "disconnected"
  | "checking"
  | "notPurchased"
  | "purchased"
  | "unavailable"
  | "unsupported";

export type TeamPlanAvailabilityReason = "not-allocated" | "expired" | "credential-unavailable";

interface CodingPlanProviderSpec {
  id: CodingPlanProviderId;
  oauthProviderId: OAuthProviderId;
  label: string;
  providerName: string;
  purchaseUrl?: string;
}

// CODING_PLAN_PROVIDER_SPECS 按 id 排布可购套餐，数组顺序即展示顺序。
// 每条给 OAuth 标识与展示标签；providerName 供品牌前缀，purchaseUrl 缺失即视为不支持自助购买。
// 个人与团队共用同一展示标签；启动套餐同样在表内，复用同一套连接流程（上层拿不到链接会兜底到错误页面）。
export const CODING_PLAN_PROVIDER_SPECS: CodingPlanProviderSpec[] = [
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    oauthProviderId: ZAI_PROVIDER_ID,
    label: "Z.ai - Coding Plan",
    providerName: "Z.ai",
    purchaseUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    oauthProviderId: ZAI_PROVIDER_ID,
    label: "Z.ai - Coding Plan",
    providerName: "Z.ai",
    purchaseUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    label: "BigModel - Coding Plan",
    providerName: "BigModel",
    purchaseUrl: BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL,
  },
  {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    label: "BigModel- Coding Plan",
    providerName: "BigModel",
    purchaseUrl: BIGMODEL_CODING_PLAN_PERSONAL_MANAGE_URL,
  },
];

export interface CodingPlanEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

// resolveModelProviderDisplayName 只按 providerId 精确比较：两个个人/团队标识都给 "Z.ai - Coding Plan"，两个启动标识都给 "Start Plan"。
// 其余厂商回落到 getProviderFormLabel；返回的是纯展示文案，不参与业务分支，也不读运行期配置。
export function resolveModelProviderDisplayName(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "config">,
): string {
  if (
    provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  ) {
    return "Z.ai - Coding Plan";
  }

  if (provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
    return "Start Plan";
  }

  if (provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan) {
    return "Start Plan";
  }

  return getProviderFormLabel(provider);
}

// ModelProviderNavItem 按 type 分五种形态：preset / coding-plan / team / loading / custom，各分支只声明自己有的字段。
// team 比个人项多团队名与组织项目身份，loading 只有展示字段；公共字段在各分支重复声明是为了各自收窄。
export type ModelProviderNavItem =
  | {
      key: string;
      type: "preset";
      /** 品牌入口图标独立于其历史 Start 导航身份。 */
      logo?: ProviderSettingsFormProvider["config"]["logo"];
      /** 账号组圆点只展示当前具体连接的公共执行结果。 */
      statusProvider?: ProviderSettingsFormProvider | null;
      presetId: BuiltinModelProviderId;
      label: string;
      provider: ProviderSettingsFormProvider | null;
      displayName: string;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "codingPlan";
      presetId: CodingPlanProviderId;
      oauthProviderId: OAuthProviderId;
      label: string;
      providerName: string;
      provider: ProviderSettingsFormProvider | null;
      /** Account Overlay 是否已启用该 Provider。 */
      accountEntitled?: boolean;
      status: CodingPlanStatus;
      planLevel?: string | null;
      currentProductId?: string | null;
      subscriptionBillingCycle?: string | null;
      subscriptionRenewTime?: string | null;
      subscriptionExpireTime?: string | null;
      subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
      quotaLimits?: UsageQuotaLimit[];
      /** 官方 Server MCP 额度（服务端下发的总额度）。不在 quota.limits[] 里，单独透传给额度卡片。 */
      mcpQuotaLimit?: UsageQuotaLimit | null;
      purchaseUrl?: string;
      /** 权益查询明确要求重新登录；文案不参与操作分支判定。 */
      accountLoginRequired?: boolean;
      statusLabelId?: string;
      statusMessage?: string | null;
      inactivePlanTitle?: string | null;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "teamPlan";
      presetId: CodingPlanProviderId;
      oauthProviderId: OAuthProviderId;
      label: string;
      providerName: string;
      teamPlanName: string;
      organizationId?: string | null;
      projectId?: string | null;
      provider: ProviderSettingsFormProvider | null;
      /** Account Overlay 是否已启用该 Provider。 */
      accountEntitled?: boolean;
      status: CodingPlanStatus;
      planLevel?: string | null;
      currentProductId?: string | null;
      subscriptionBillingCycle?: string | null;
      subscriptionRenewTime?: string | null;
      subscriptionExpireTime?: string | null;
      subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
      quotaLimits?: UsageQuotaLimit[];
      /** 官方 Server MCP 额度（服务端下发的总额度）。不在 quota.limits[] 里，单独透传给额度卡片。 */
      mcpQuotaLimit?: UsageQuotaLimit | null;
      purchaseUrl?: string;
      statusLabelId?: string;
      statusMessage?: string | null;
      /** Team 状态的业务原因。交互不得再从 i18n 文案反推。 */
      availabilityReason?: TeamPlanAvailabilityReason;
      inactivePlanTitle?: string | null;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "codingPlanLoading";
      label: string;
      providerName: string;
      oauthProviderId?: OAuthProviderId;
    }
  | {
      key: string;
      type: "custom";
      label: string;
      provider: ProviderSettingsFormProvider;
      statusActive: boolean;
    };

export type ModelProviderNavGroupId = "preset" | "custom";

export interface ModelProviderNavGroup {
  id: ModelProviderNavGroupId;
  title: string;
  items: ModelProviderNavItem[];
}
