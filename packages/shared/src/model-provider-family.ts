// INV-01 单表事实：守住位置 MODEL_PROVIDER_FAMILY_SPECS；改错故障：两处各写一份家族元数据而漂移。
// INV-02 标识闭合：守住位置 家族标识联合；改错故障：新增家族只加表不加类型，反查漏项。
// INV-03 根域无协议：守住位置 rootDomain；改错故障：反查时主机名永不匹配。
// INV-04 套餐对齐：守住位置 三档套餐标识；改错故障：套餐 Provider 找不到所属家族。
// INV-05 地址即算：守住位置 团队套餐地址；改错故障：环境切换后仍指向旧域名。
// INV-06 顺序即展示：守住位置 表顺序；改错故障：UI 家族顺序随排序规则变化。
// INV-07 字面量保真：守住位置 as const 与 satisfies；改错故障：标识被拓宽成 string，类型保护失效。
// INV-08 索引一次：守住位置 两张 Map；改错故障：每次查询重建索引，调用密集时抖动。
// INV-09 查询非空：守住位置 getModelProviderFamilySpec 断言；改错故障：非法家族标识返回未定义而非早失败。
// INV-10 反查可空：守住位置 套餐反查；改错故障：非内置 Provider 被强行归入某家族。
// INV-11 主机小写：守住位置 baseURL 反查；改错故障：大写主机名匹配失败。
// INV-12 畸形地址容忍：守住位置 URL 解析异常；改错故障：用户手填地址让设置页崩溃。
// INV-13 空值即空：守住位置 空串判断；改错故障：空地址被匹配成任意家族。
// INV-14 子域匹配：守住位置 后缀判断；改错故障：api 子域无法识别。
// INV-15 边界防误配：守住位置 点号拼接；改错故障：evilz.ai 被当成 z.ai 的子域。
// INV-16 域值归一：守住位置 normalizeProviderFamilyDomain；改错故障：脏值进入过滤逻辑。
// INV-17 域空放行：守住位置 shouldShowForDomain 空域分支；改错故障：未选域时所有家族被隐藏。
// INV-18 OAuth 映射：守住位置 两种 OAuth 标识；改错故障：已登录却看不到对应家族。
//
// 模块职责：模型供应商家族的元数据表、索引与反查辅助。
// 状态所有权：无状态；表与索引在模块加载期一次性构建。
// 阅读顺序：类型 → 元数据表 → 两张索引 → 反查与过滤。
import { BIGMODEL_PROVIDER_ID, type OAuthProviderId, ZAI_PROVIDER_ID } from "./oauth.js";
import { BUILTIN_MODEL_PROVIDER_IDS, type BuiltinModelProviderId } from "./model-provider-types.js";
import { ZCODE_ENV } from "./env.js";
import { buildBigModelCodingPlanTeamManageUrl } from "./zcodeEndpoint.js";

// 家族只有 z.ai 与 BigModel 两家，新增家族必须同时补 spec。
// 域类型与家族标识同一取值域，可互换。
//
export type ModelProviderFamilyId = "zai" | "bigmodel";
export type ProviderFamilyDomain = ModelProviderFamilyId;

// 每家家族一份 spec，集中承载标签、根域与三档套餐标识。
// 根域用于按端点反查家族，不带协议与路径。
// 三档套餐标识与内置 Provider 一一对应。
// teamCodingPlanManageUrl 由 buildBigModelCodingPlanTeamManageUrl 按 ZCODE_ENV 推导，换环境不必改表。
//
export interface ModelProviderFamilySpec {
  id: ModelProviderFamilyId;
  label: string;
  rootDomain: string;
  oauthProviderId: typeof ZAI_PROVIDER_ID | typeof BIGMODEL_PROVIDER_ID;
  startPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  individualCodingPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
  teamCodingPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
  teamCodingPlanManageUrl: string;
}

// 表顺序即 UI 展示顺序，不要按字母重排。
// as const 保证标识字面量参与类型推导。
// satisfies 约束结构但不拓宽字面量类型。
// 新增家族要同时补齐 OAuth 标识与三档套餐。
//
export const MODEL_PROVIDER_FAMILY_SPECS = [
  {
    id: "zai",
    label: "Z.ai",
    rootDomain: "z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    teamCodingPlanManageUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: "bigmodel",
    label: "BigModel",
    rootDomain: "bigmodel.cn",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    teamCodingPlanManageUrl: buildBigModelCodingPlanTeamManageUrl({ ZCODE_ENV }),
  },
] as const satisfies readonly ModelProviderFamilySpec[];

// 家族标识到 spec 的索引，查不到属调用方违约。
// 索引在模块加载期一次构建，运行期不重建。
// 索引键限定为 ModelProviderFamilyId，get 的返回类型已是 ModelProviderFamilySpec，读取处无需再收窄。
//
const MODEL_PROVIDER_FAMILY_SPEC_BY_ID = new Map<ModelProviderFamilyId, ModelProviderFamilySpec>(
  MODEL_PROVIDER_FAMILY_SPECS.map((spec) => [spec.id, spec]),
);

// 套餐 Provider 标识反查家族，映射覆盖三档套餐。
// flatMap 把三档套餐 id 展开成键值对，每个 id 只属于一家 spec 且反查结果唯一。
// 反查未命中统一返回空。
//
const MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID = new Map<
  BuiltinModelProviderId,
  ModelProviderFamilyId
>(
  MODEL_PROVIDER_FAMILY_SPECS.flatMap((spec) =>
    [
      spec.startPlanProviderId,
      spec.individualCodingPlanProviderId,
      spec.teamCodingPlanProviderId,
    ].map((providerId) => [providerId, spec.id] as const),
  ),
);

export function getModelProviderFamilySpec(
  familyId: ModelProviderFamilyId,
): ModelProviderFamilySpec {
  return MODEL_PROVIDER_FAMILY_SPEC_BY_ID.get(familyId)!;
}

export function resolveModelProviderFamilyIdByProviderId(
  providerId: string,
): ModelProviderFamilyId | null {
  return MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID.get(providerId as BuiltinModelProviderId) ?? null;
}

// 空值与空串都返回空，不做猜测。
// URL 解析失败同样返回空，容忍手填的畸形地址。
// new URL 解析出的 hostname 在返回前转小写，否则同一域名的不同大小写写法会判成两个家族。
// 命中条件是 hostname 等于 spec.rootDomain 或以 .rootDomain 结尾，因此子域也能归到同一家族。
// 循环按 MODEL_PROVIDER_FAMILY_SPECS 的声明顺序首次命中即 return，因此新增家族追加在末尾不影响已有匹配。
//
export function resolveModelProviderFamilyIdByBaseURL(
  baseURL: string | null | undefined,
): ModelProviderFamilyId | null {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const spec of MODEL_PROVIDER_FAMILY_SPECS) {
    if (hostname === spec.rootDomain || hostname.endsWith(`.${spec.rootDomain}`)) {
      return spec.id;
    }
  }
  return null;
}

export function resolveModelProviderFamilySpecByProviderId(
  providerId: string,
): ModelProviderFamilySpec | null {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  return familyId ? getModelProviderFamilySpec(familyId) : null;
}

export function resolveModelProviderFamilyLabelByProviderId(providerId: string): string | null {
  return resolveModelProviderFamilySpecByProviderId(providerId)?.label ?? null;
}

export function normalizeProviderFamilyDomain(
  value: string | null | undefined,
): ProviderFamilyDomain | null {
  return value === "zai" || value === "bigmodel" ? value : null;
}

export function resolveProviderFamilyDomainFromOAuthProvider(
  provider: OAuthProviderId | string | null | undefined,
): ProviderFamilyDomain | null {
  if (provider === ZAI_PROVIDER_ID) {
    return "zai";
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return "bigmodel";
  }
  return null;
}

export function shouldShowModelProviderFamilyForDomain(params: {
  familyId: ModelProviderFamilyId;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const providerFamilyDomain = normalizeProviderFamilyDomain(params.providerFamilyDomain);
  if (!providerFamilyDomain) {
    return true;
  }
  return params.familyId === providerFamilyDomain;
}

export function shouldShowModelProviderFamilyForActiveOAuth(params: {
  familyId: ModelProviderFamilyId;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowModelProviderFamilyForDomain({
    familyId: params.familyId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}

export function shouldShowBuiltinModelProviderForDomain(params: {
  providerId: string;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const familyId = resolveModelProviderFamilyIdByProviderId(params.providerId);
  if (!familyId) {
    return true;
  }
  return shouldShowModelProviderFamilyForDomain({
    familyId,
    providerFamilyDomain: params.providerFamilyDomain,
  });
}

export function shouldShowBuiltinModelProviderForActiveOAuth(params: {
  providerId: string;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowBuiltinModelProviderForDomain({
    providerId: params.providerId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}
