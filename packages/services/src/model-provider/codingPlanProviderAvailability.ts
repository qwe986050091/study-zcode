/* eslint-disable max-lines -- Coding Plan 登录、订阅与 Start/Coding 互斥校验需要集中维护，拆散会让系统禁用原因更难追踪。 */
import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
  resolveBigModelApiOrigin,
  ZAI_PROVIDER_ID,
  type ApiClient,
  type ProviderFamilyDomain,
  type ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import { type BigModelTeamPlanBizContext } from "#src/bigmodel/teamPlanApiKey.js";
import {
  fetchPersonalCodingPlanEntitlement,
  fetchTeamCodingPlanEntitlement,
} from "#src/bigmodel/codingPlanEntitlement.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import { resolveBigModelStartPlanZcodeJwt } from "./bigmodelStartPlanZcodeJwt.js";
import {
  buildZaiStartPlanBalanceUrl,
  fetchZaiStartPlanBalanceEnvelope,
  resolveZaiStartPlanBalanceModelIds,
  type ZaiStartPlanBalanceEnvelope,
} from "./zaiStartPlanBilling.js";
import {
  createBigModelLoginAuthHeaders,
  createZaiLoginAuthHeaders,
} from "../coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";

// INV-01：availability 只回答「这个 Provider 现在能不能执行」，不写配置、不改 enabled；
// 系统禁用原因由上层按 kind 投影，本文件不产生副作用。
// INV-02：凭据缺失/请求期 token 未就绪一律返回 unknown，不能用「查不到」证明「未订阅」。
// INV-03：401/403 映射为 coding_plan_auth_failed，其它网络错误映射为 unknown，两者语义不同。
// INV-04：Team 必须带具体 organizationId/projectId 才能查，个人与 Start 只看登录身份。
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("coding-plan-availability");
const BIGMODEL_SUBSCRIPTION_LIST_PATH = "/api/biz/subscription/list";

// 与 Start Plan 共用同一个凭据 key；这里只读不写，避免 availability 校验顺带修改登录态。
// BigModel 侧还用它识别旧版本误写进 access_token 的值（见下方 stale 判定）。
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

// 四类原因对应 UI 的四种引导：重新登录、连接套餐、检查凭据、购买/领取。
// 枚举值会随 Account State 跨进程传输，新增值必须同步 UI 映射。
// 不复用账号域枚举，否则套餐查询实现会泄漏到 UI 的类型空间。
export type CodingPlanUnavailableReason =
  | "coding_plan_not_authenticated"
  | "coding_plan_not_connected"
  | "coding_plan_auth_failed"
  | "coding_plan_not_entitled";

// URL 由 env 现算而不是复用 provider.endpoint：availability 在用户尚未填完配置时也要能工作。
// 路径必须与 OAuth business login 使用同一套 origin 分流，只允许 origin 不同。
function buildZaiSubscriptionListUrl(): string {
  // ZAI 测试环境业务 token 只能请求配置的 ZAI Business origin。
  // availability 校验必须和 OAuth business login 共用同一套 ZCODE_ENV 域名分流，只允许 origin 不同。
  return buildRuntimeZaiBusinessUrl(process.env, "/api/biz/subscription/list");
}

interface CodingPlanAvailabilityCredentialService {
  load(key: string): Promise<string | null>;
}

// 三个依赖都是可选的：缺少 apiClient 表示当前 Environment 无法发起校验，直接返回 unknown。
// 缺少 credentialService 时只能依赖 provider.apiKey（例如 Host 侧已解析好 Key）。
// selections 只用于判断当前选中的是个人还是 Team 套餐。
interface CodingPlanAvailabilityContext {
  apiClient?: ApiClient;
  credentialService?: CodingPlanAvailabilityCredentialService;
  providerFamilyConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
}

interface BigModelCustomerInfoEnvelope {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: BigModelCustomerInfo | null;
}

interface BigModelCustomerInfo {
  organizations?: Array<{
    organizationId?: string | null;
    projects?: Array<{
      projectId?: string | null;
      projectType?: number | string | null;
    }> | null;
  }> | null;
}

interface ZaiStartPlanPlan {
  plan_id?: string | null;
  name?: string | null;
  status?: string | null;
  starts_at?: number | string | null;
  ends_at?: number | string | null;
  entitlements?: Array<{
    period?: string | null;
  }>;
}

// 四种 kind 构成完整状态机：available 可用（可选模型白名单）、pending 已领取未生效、
// unavailable 必须带原因、unknown 表示无法判定（不得当作不可用处理）。
// pending 的 effectiveAt 取所有未来权益的最早生效时间，UI 据此倒计时。
// 返回对象不含 providerId：调用方按入参自行归属。
export type CodingPlanAvailabilityResult =
  | { kind: "available"; models?: readonly string[] }
  | { kind: "pending"; effectiveAt: number; models: readonly string[] }
  | { kind: "unavailable"; reason: CodingPlanUnavailableReason }
  | { kind: "unknown" };

// planKind 是套餐实例的静态身份（由 Provider 配置决定），不是用户当前选择。
// apiKey 可选：Team 套餐没有独立 Key，个人套餐的 Key 由调用方注入。
export interface CodingPlanAvailabilityProvider {
  readonly providerId: string;
  readonly family: ProviderFamilyDomain;
  readonly planKind: "start-plan" | "individual-coding-plan" | "team-coding-plan";
  readonly apiKey?: string | null;
}

// 单一 Provider 的校验入口：Start 走 balance、个人走 subscription list、
// Team 返回 unknown（需要项目上下文，必须走 validateSelectedTeamPlanAvailability）。
// [权衡] 不在这里统一处理 Team：它的上下文在 selection 里，而本函数只有 apiClient/credentials。
// 该函数是单 Provider 调用方唯一需要的入口，family 分流完全内聚。
export async function validateCodingPlanProviderAvailability(
  provider: CodingPlanAvailabilityProvider,
  context: CodingPlanAvailabilityContext,
): Promise<CodingPlanAvailabilityResult> {
  if (!context.apiClient) {
    return { kind: "unknown" };
  }

// 上面的 apiClient 判空保证后续不会用到未装配的客户端，因此分支内不再重复判断。
// Start Plan 有独立权益来源（balance.plans），即使当前选中的是个人套餐也要单独查。
// 先判 Start 再判个人：两者互斥，顺序只影响可读性。
  if (provider.planKind === "start-plan") {
    return validateStartPlanAvailability(provider, context);
  }

// 除 Start 与个人外只剩 Team：缺少项目上下文时只能返回 unknown。
  if (provider.planKind !== "individual-coding-plan") {
    return { kind: "unknown" };
  }

  if (provider.family === "zai") {
    return validateSubscriptionListAvailability(provider, context, buildZaiSubscriptionListUrl());
  }

  return validateSubscriptionListAvailability(
    provider,
    context,
    buildBigModelApiUrl(process.env, BIGMODEL_SUBSCRIPTION_LIST_PATH),
  );
}

// 一次取齐同 family 的三个 Provider 再统一查询：共享同一次设置读取，
// 且 Team 结果依赖同一份 selection 快照。
export async function validateZaiAccountProviderAvailability(
  providers: readonly CodingPlanAvailabilityProvider[],
  context: CodingPlanAvailabilityContext,
): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  const startProvider = findAvailabilityProvider(providers, "zai", "start-plan");
  const individualProvider = findAvailabilityProvider(providers, "zai", "individual-coding-plan");
  const teamProvider = findAvailabilityProvider(providers, "zai", "team-coding-plan");
  return validateFamilyAccountProviders({
    family: "zai",
    context,
    startProvider,
    individualProvider,
    teamProvider,
  });
}

export async function validateBigModelAccountProviderAvailability(
  providers: readonly CodingPlanAvailabilityProvider[],
  context: CodingPlanAvailabilityContext,
): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
  const startProvider = findAvailabilityProvider(providers, "bigmodel", "start-plan");
  const individualProvider = findAvailabilityProvider(
    providers,
    "bigmodel",
    "individual-coding-plan",
  );
  const teamProvider = findAvailabilityProvider(providers, "bigmodel", "team-coding-plan");
  return validateFamilyAccountProviders({
    family: "bigmodel",
    context,
    startProvider,
    individualProvider,
    teamProvider,
  });
}

// 同一 family 下每种 planKind 最多一个 Provider，按 family+planKind 定位即可。
function findAvailabilityProvider(
  providers: readonly CodingPlanAvailabilityProvider[],
  family: ProviderFamilyDomain,
  planKind: CodingPlanAvailabilityProvider["planKind"],
): CodingPlanAvailabilityProvider | undefined {
  return providers.find((provider) => provider.family === family && provider.planKind === planKind);
}

// 先全部预置为 not_connected，再用实际查询结果覆盖：
// 任何查询路径提前返回时，UI 看到的都是「未连接」而不是缺失字段。
// Start 与个人独立查询、互不继承结果；Team 仅在当前选中 Team 时查询。
// 预置顺序固定为 start → individual → team，与返回对象的键顺序无关。
async function validateFamilyAccountProviders(params: {
  family: ProviderFamilyDomain;
  context: CodingPlanAvailabilityContext;
  startProvider?: CodingPlanAvailabilityProvider;
  individualProvider?: CodingPlanAvailabilityProvider;
  teamProvider?: CodingPlanAvailabilityProvider;
}): Promise<Partial<Record<string, CodingPlanAvailabilityResult>>> {
// 复用一个常量对象：它只作为初始值写入 result，后续会被实际结果覆盖。
  const unavailable = {
    kind: "unavailable" as const,
    reason: "coding_plan_not_connected" as const,
  };
  const result: Record<string, CodingPlanAvailabilityResult> = {};
  for (const provider of [params.startProvider, params.individualProvider, params.teamProvider]) {
    if (provider) result[provider.providerId] = unavailable;
  }

// selection 只影响 Team：个人与 Start 的权益与当前选择无关，不能因为「没选中」就跳过查询。
// 从上下文读而不是参数传入：调用方与单 Provider 入口共享同一份选择快照。
  const selection = params.context.providerFamilyConnectionSelections?.[params.family];
  // Start Plan 是独立权益：即使当前连接仍是个人/Team Coding Plan，也必须单独查询，
  // 否则领取后待生效或已拥有的 Start Plan 会被错误地当成“未连接”，设置页无法展示。
// Start 查询只依赖登录身份，不读 selection，因此放在 selection 赋值之后不受影响。
  if (params.startProvider) {
    result[params.startProvider.providerId] = await validateStartPlanAvailability(
      params.startProvider,
      params.context,
    );
  }
  // 个人订阅和 Start 独立查询，不以当前选中状态代替权益。Team 必须有具体项目身份。
// 只有拿到真实查询结果才替换预置值；查询内部已把异常折叠成 unknown。
  if (params.individualProvider) {
    result[params.individualProvider.providerId] = await validateCodingPlanProviderAvailability(
      params.individualProvider,
      params.context,
    );
  }
// 只有当前选中 Team 时才查项目归属：未选中的 Team Provider 保持 unknown，
// 避免用猜测的项目身份去请求后端。
  if (selection?.kind === "team-coding-plan" && params.teamProvider) {
    result[params.teamProvider.providerId] = await validateSelectedTeamPlanAvailability(
      params.family,
      params.context,
    );
  } else if (params.teamProvider) {
    result[params.teamProvider.providerId] = { kind: "unknown" };
  }
  return result;
}

// zai/bigmodel Team Plan 对称化。原硬编码 bigmodel host/token/header，
// zai team plan 永远不校验 customerInfo（被移出团队也不禁用）。
// 泛化为 family-aware：按 family 选 host（zai 用配置的 ZAI Business origin）、token（oauth:zai:）、header（Bearer）。
// 已验证 zai 域名 getCustomerInfo 返回结构与 bigmodel 同构（organizations/projects）。
// Team 校验两步：先确认「当前登录账号仍在该项目里」，再查项目订阅权益。
// 缺任一步都会把已被移出团队的用户判成可用，因此两步必须基于同一 token。
// [失败路径] 网络/鉴权错误分类后返回，不向上抛：availability 是视图数据，不是控制流。
// 该函数只处理选中项，未选中的 Team 由调用方预置 unknown。
async function validateSelectedTeamPlanAvailability(
  family: ProviderFamilyDomain,
  context: CodingPlanAvailabilityContext,
): Promise<CodingPlanAvailabilityResult> {
  if (!context.apiClient) {
    return { kind: "unknown" };
  }
// 没有选中 Team 或 selection 类型不符时返回 null，调用方转成 unknown。
  const selectedTeamContext = resolveSelectedTeamContext(
    family,
    context.providerFamilyConnectionSelections,
  );
  if (!selectedTeamContext) {
    return { kind: "unknown" };
  }
  const { projectId } = selectedTeamContext;
  const oauthProvider = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
// 用 OAuth access token 查 customerInfo（不是模型 API Key）：业务域只认登录态。
// trim 后再判空，避免只有空白的 token 造成一次必然 401 的请求。
  const token = (
    await context.credentialService?.load(`oauth:${oauthProvider}:access_token`)
  )?.trim();
// 没有 access token 说明未登录，按 not_connected 处理而不是 unknown。
  if (!token) {
    return { kind: "unavailable", reason: "coding_plan_not_connected" };
  }
// 读取共享 JWT 仅用于识别 BigModel 旧版本写坏 access token 的情况。
  const zcodeJwtToken = (await context.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim();
  // BigModel 旧版本可能把 zcodejwttoken 误写进 oauth access token；
  // 但 Z.ai 的 business JWT 本身就是合法 Bearer token，不能套用这个 stale-token 防御。
// 命中说明这是旧版本误写入的 zcodejwttoken，无法作为 customerInfo 凭据，按未连接处理。
  if (family === "bigmodel" && zcodeJwtToken && token === zcodeJwtToken) {
    return { kind: "unavailable", reason: "coding_plan_not_connected" };
  }

  try {
    // zai 走 buildRuntimeZaiBusinessUrl（测试环境配置的 ZAI Business origin），
    // bigmodel 走 resolveBigModelApiOrigin。路径 /api/biz/customer/getCustomerInfo 两边同构。
// [权衡] host 只用一次却单独赋值：后续 subscription 调用必须复用同一 origin，
// 否则项目归属校验与权益查询可能落到不同环境，结论互相矛盾。
    const host =
      family === "zai"
        ? buildRuntimeZaiBusinessUrl(process.env, "")
        : resolveBigModelApiOrigin(process.env);
    const authHeaders =
      family === "zai" ? createZaiLoginAuthHeaders(token) : createBigModelLoginAuthHeaders(token);
// 复用 readApiJson：超时、非 2xx 与 JSON 解析失败都抛 ApiError，交给 classifyAvailabilityError。
// headers 由 family 对应的登录鉴权构造器生成，保证与 OAuth 登录同一套协议。
// 这里必须用非空断言：入口已判空，但 TS 无法跨 await 保留收窄。
    const payload = await readApiJson<BigModelCustomerInfoEnvelope>(
      context.apiClient!,
      `${host}/api/biz/customer/getCustomerInfo`,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: authHeaders,
      },
    );
// 业务码失败或 organizations 缺失都返回 unknown：无法区分「无权限」与「后端异常」时不能下结论。
    if (!isSuccessfulBusinessEnvelope(payload)) return { kind: "unknown" };
    if (!Array.isArray(payload.data?.organizations)) return { kind: "unknown" };
// 在返回的组织树里找 selected project，且 projectType 必须为 2（团队项目）。
    const resolvedTeamContext = resolveBigModelTeamProjectContext(
      payload.data,
      selectedTeamContext,
    );
    log.info(undefined, "Team Plan 入口项目校验完成", {
      family,
      projectId,
      organizationId: selectedTeamContext.organizationId,
      hasSelectedTeamProject: Boolean(resolvedTeamContext),
      organizationCount: payload.data?.organizations?.length ?? 0,
    });
// `resolvedTeamContext` 为空（找到项目但类型不符）等价于「不在所属团队项目中」，属于明确无权益。
    if (!resolvedTeamContext) {
      return { kind: "unavailable", reason: "coding_plan_not_entitled" };
    }
// 归属确认后继续查项目订阅：只有两层都通过才算 available。
    return validateTeamPlanSubscriptionAvailability({
      apiClient: context.apiClient,
      authorization: token,
      family,
      host,
      teamContext: resolvedTeamContext,
    });
  } catch (error) {
    log.warn(undefined, "Team Plan 入口项目校验失败", {
      family,
      error: error instanceof Error ? error.message : String(error),
      projectId,
      status: error instanceof ApiError ? error.status : null,
    });
    return classifyAvailabilityError(error);
  }
}

// 项目订阅查询独立封装，便于与个人订阅共用同一套错误分类。
// ZAI 需要显式 Bearer 前缀，BigModel 的 entitlement 客户端自行拼接，因此按 family 分流。
// 这里复用已解析的 host，避免第二次 env 求值得到不同 origin。
async function validateTeamPlanSubscriptionAvailability(params: {
  apiClient: ApiClient;
  authorization: string;
  family: ProviderFamilyDomain;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
}): Promise<CodingPlanAvailabilityResult> {
  try {
// unavailable 统一映射为 not_entitled：项目存在但无订阅，是用户可理解的稳定原因。
// 其它 kind 原样透传（available / pending 的字段由 entitlement 客户端给出）。
    const result = await fetchTeamCodingPlanEntitlement({
      ...params,
      authorization:
        params.family === "zai" ? `Bearer ${params.authorization}` : params.authorization,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return result.kind === "unavailable"
      ? { kind: "unavailable", reason: "coding_plan_not_entitled" }
      : { kind: result.kind };
  } catch (error) {
    return classifyAvailabilityError(error);
  }
}

// zai/bigmodel Team Plan 对称化。原仅解析 bigmodel selectedKey，
// zai team key 永远返回 null（availability 不校验 zai team project）。
// 泛化为 family-aware，按 family 读对应 selectedKey bucket + family-aware parse。
// 只有 kind=team-coding-plan 的 selection 才带项目身份，其它类型返回 null。
// 这里不做 family 特判：两个域的 selection 结构已对称化。
// organizationId 允许为空：旧版 selection 只记了 projectId。
// 返回新对象，调用方不会意外修改设置快照。
function resolveSelectedTeamContext(
  family: ProviderFamilyDomain,
  selections: ProviderFamilyConnectionSelectionSettings | null | undefined,
): {
  organizationId: string | null;
  projectId: string;
} | null {
// 按 family 取桶：zai 与 bigmodel 各自保存选择，不能互相回退。
  const selection = selections?.[family];
  if (selection?.kind !== "team-coding-plan") return null;
  return {
    organizationId: selection.organizationId,
    projectId: selection.projectId,
  };
}

// organizationId 是可选约束：selection 里有时只记了 projectId，此时遍历全部组织。
// projectType 必须等于 2：普通项目（1）不承载 Team 套餐。
// projectId 用 trim 后精确相等，不做前缀匹配，避免把相似 ID 的项目当成同一团队。
// [失败路径] 找不到匹配返回 null，由调用方转成 not_entitled。
function resolveBigModelTeamProjectContext(
  customerInfo: BigModelCustomerInfo | null | undefined,
  selectedContext: {
    organizationId: string | null;
    projectId: string;
  },
): BigModelTeamPlanBizContext | null {
// 逐组织、逐项目线性扫描：组织数量是个位数，建索引反而增加维护成本。
// organizationId 为空的组织无法作为业务上下文，在匹配条件里一并排除。
  for (const organization of customerInfo?.organizations ?? []) {
    const organizationId = organization.organizationId?.trim() ?? "";
// 指定了 organizationId 时严格限定：同名项目可能存在于多个组织。
    if (selectedContext.organizationId && organizationId !== selectedContext.organizationId) {
      continue;
    }
    for (const project of organization.projects ?? []) {
      if (
        project.projectId?.trim() === selectedContext.projectId &&
        String(project.projectType ?? "").trim() === "2" &&
        organizationId
      ) {
        return {
          organizationId,
          projectId: selectedContext.projectId,
        };
      }
    }
  }
  return null;
}

// 个人订阅校验：Key 即凭据，直接查 subscription/list。
// URL 由调用方按 family 传入，本函数不关心域名分流。
// apiClient 用非空断言：所有调用点都已通过 validateCodingPlanProviderAvailability 判空。
async function validateSubscriptionListAvailability(
  provider: CodingPlanAvailabilityProvider,
  context: CodingPlanAvailabilityContext,
  url: string,
): Promise<CodingPlanAvailabilityResult> {
  // 账号凭据已是三段 PAT；旧手工 Key 归一化会按 id.secret 截掉签名。
// 归一化后立即用于一次请求，不写回 provider：availability 不得修改配置。
// 账号凭据已是三段 PAT，只去掉可能存在的 Bearer 前缀，不按 id.secret 截断。
  const authorization = (provider.apiKey ?? "").trim().replace(/^Bearer\s+/i, "").trim();
  // 请求期 Token 尚未准备好只能表示权益未知；不能用凭据缺失证明未订阅。
// 空凭据不发请求：避免用空 Bearer 触发一次必然 401 的往返。
  if (!authorization) return { kind: "unknown" };
  try {
    const result = await fetchPersonalCodingPlanEntitlement({
      apiClient: context.apiClient!,
      authorization,
      url,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return result.kind === "unavailable"
      ? { kind: "unavailable", reason: "coding_plan_not_entitled" }
      : { kind: result.kind };
  } catch (error) {
    return classifyAvailabilityError(error);
  }
}

// missingReason 让「拿不到凭据」的原因可区分，调用方直接透传为 unavailable 原因。
// value 为空串表示没有可用 Bearer，不区分「未登录」与「凭据读取失败」。
interface StartPlanAuthorization {
  value: string;
  missingReason: CodingPlanUnavailableReason;
}

// Start 只查 balance 一次：billing/current 已废弃，plans 是可用性的权威来源。
// 日志记录完整 payload 与耗时，便于排查后端状态漂移。
// 异常一律分类后返回，不向上抛。
// 该函数不写缓存：in-flight 复用由 fetchZaiStartPlanBalanceEnvelope 负责。
async function validateStartPlanAvailability(
  provider: CodingPlanAvailabilityProvider,
  context: CodingPlanAvailabilityContext,
): Promise<CodingPlanAvailabilityResult> {
// 授权解析与请求分离：解析失败时不需要发请求，也能给出准确原因。
  const authorization = await resolveStartPlanAuthorization(provider, context);
// 拿不到 Bearer 说明登录态缺失，按 not_authenticated 处理，不重试。
  if (!authorization.value) {
    return {
      kind: "unavailable",
      reason: authorization.missingReason,
    };
  }

  try {
    const startedAt = Date.now();
    // billing/current 已废弃，balance 的 data.plans 是 Start Plan 可用性权威来源。
    // availability 只请求一次 balance，避免冷启动在入口校验阶段重复打旧 current 接口。
// 复用 in-flight 缓存：账号校验与用量面板通常在同一秒内各查一次，这里只打一次后端。
// balance 的 data.plans 既用于可用性判定，也用于模型白名单解析。
    const payload = await fetchZaiStartPlanBalanceEnvelope(context.apiClient!, authorization.value);
    const activeStartPlan = hasActiveStartPlan(payload.data?.plans);
    log.info(undefined, "billing/balance 请求完成", {
      durationMs: Date.now() - startedAt,
      hasActiveStartPlan: activeStartPlan,
      msg: payload.msg ?? null,
      payload,
      planCount: payload.data?.plans?.length ?? 0,
      plans: summarizeStartPlans(payload.data?.plans),
      providerId: provider.providerId,
      success: isSuccessfulBusinessEnvelope(payload),
      url: buildZaiStartPlanBalanceUrl(),
      code: payload.code ?? null,
    });
// 解析与请求分离：纯函数部分可单测，不必构造 HTTP。
    return resolveStartPlanBalanceAvailability(payload);
  } catch (error) {
    log.warn(undefined, "billing/balance 请求失败", {
      error: error instanceof Error ? error.message : String(error),
      providerId: provider.providerId,
      responseHeaders: error instanceof ApiError ? (error.responseHeaders ?? null) : null,
      status: error instanceof ApiError ? error.status : null,
      url: buildZaiStartPlanBalanceUrl(),
    });
    return classifyAvailabilityError(error);
  }
}

// BigModel 走 zcodejwttoken（Start Plan 专用 JWT），ZAI 优先凭据里的 JWT，再退回 provider.apiKey。
// [权衡] 两域授权来源不同，仍共用同一返回结构，让上层只处理「有/没有 Bearer」。
// 两域缺失原因都是 not_authenticated：其它原因由调用方按 providerId 补足。
// 不做网络请求，纯读 `zcodejwttoken` 与 `provider.apiKey` 凭据。
async function resolveStartPlanAuthorization(
  provider: CodingPlanAvailabilityProvider,
  context: CodingPlanAvailabilityContext,
): Promise<StartPlanAuthorization> {
// BigModel 的 Start Plan 需要单独的 JWT：模型 API Key 无法访问 billing 接口。
// 该 JWT 由 bigmodelStartPlanZcodeJwt 统一解析，包含必要的登录态兼容逻辑。
  if (provider.family === "bigmodel") {
    const zcodeJwtToken = await resolveBigModelStartPlanZcodeJwt({
      credentialService: context.credentialService,
      provider,
    });
    return {
      value: zcodeJwtToken ? `Bearer ${zcodeJwtToken}` : "",
      missingReason: "coding_plan_not_authenticated",
    };
  }

// 先读共享凭据再退回配置里的 Key：前者由登录刷新，后者可能是旧的手工值。
// 两步都 trim 并剥前缀，保证最终只拼一次 Bearer。
  const credentialJwt = await loadZaiProviderConnectionZcodeJwtToken(context);
  const providerJwt = (provider.apiKey ?? "").trim().replace(/^Bearer\s+/i, "").trim();
  return {
    value: credentialJwt || providerJwt ? `Bearer ${credentialJwt || providerJwt}` : "",
    missingReason: "coding_plan_not_authenticated",
  };
}

// 业务失败 → auth_failed，无 active Start → not_entitled，其余按模型白名单判定。
// 判定顺序保证原因稳定：先区分「鉴权失败」再区分「未购买」。
// 时间基准优先用 server_time，缺失才用本地时间，避免机器时钟偏移导致 pending 误判。
function resolveStartPlanBalanceAvailability(
  payload: ZaiStartPlanBalanceEnvelope,
): CodingPlanAvailabilityResult {
// 这里不能返回 unknown：balance 明确失败通常是 token 失效，UI 应引导重新登录。
// 401/403 与业务失败在这里合并处理，因为该接口用业务码表达鉴权结果。
  if (!isSuccessfulBusinessEnvelope(payload)) {
    return { kind: "unavailable", reason: "coding_plan_auth_failed" };
  }
// 没有 active Start Plan 是明确的无权益，而不是「查不到」。
  if (!hasActiveStartPlan(payload.data?.plans)) {
    return { kind: "unavailable", reason: "coding_plan_not_entitled" };
  }
// 模型白名单来自 balances 的 capabilities，可能为空（套餐可用但没有模型映射）。
  const models = resolveZaiStartPlanBalanceModelIds(payload);
  const serverTime = payload.data?.server_time;
  const nowSeconds =
    typeof serverTime === "number" && Number.isFinite(serverTime) && serverTime >= 0
      ? serverTime
      : Date.now() / 1000;
  const effectiveTimes = (payload.data?.plans ?? [])
    .filter((plan) => plan.status?.toLowerCase() === "active")
    .flatMap((plan) =>
      plan.entitlements?.length
        ? plan.entitlements.map((entry) => entry.effective_at)
        : [plan.starts_at],
    )
    .map((value) =>
      value === null || value === undefined || value === "" ? undefined : Number(value),
    );
  // 只有明确所有权益都在未来才标 pending；缺失时间不伪造日期，模型仍由余额白名单决定。
  if (
// 三个条件必须同时成立才标 pending：任一权益时间缺失就退回 available，不猜测生效时间。
// Math.min 取最早一条权益，UI 依此倒计时。
// 只用 active 计划的权益时间：已过期的桶不应影响待生效判断。
    models.length === 0 &&
    effectiveTimes.length > 0 &&
    effectiveTimes.every(
      (value) => value !== undefined && Number.isFinite(value) && value > nowSeconds,
    )
  ) {
    return {
      kind: "pending",
      effectiveAt: Math.min(...(effectiveTimes as number[])),
      models: [],
    };
  }
// 有模型白名单就带 models；否则返回裸 available 表示「套餐可用、模型不限制」。
// 冻结数组防止调用方修改后影响同一次请求的其它消费者。
  return models.length > 0
    ? { kind: "available", models: Object.freeze(models) }
    : { kind: "available" };
}

async function loadZaiProviderConnectionZcodeJwtToken(
  context: CodingPlanAvailabilityContext,
): Promise<string> {
  return (await context.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() || "";
}

// 只把 401/403 当成鉴权失败：超时、5xx、DNS 失败都属于「无法判定」。
// 误判成 auth_failed 会让用户被反复要求重新登录，成本远高于显示 unknown。
// ApiError 之外的一切异常（含 JSON 解析错误）都归 unknown。
// 该函数不记日志：调用点已经记录过带上下文的 warn。
function classifyAvailabilityError(error: unknown): CodingPlanAvailabilityResult {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return { kind: "unavailable", reason: "coding_plan_auth_failed" };
  }
  return { kind: "unknown" };
}

// success=false 优先于 code：部分接口用 success 表达业务失败但仍返回 code=200。
// code 缺失时视为成功，兼容只返回裸 data 的网关。
function isSuccessfulBusinessEnvelope(payload: { code?: number; success?: boolean }): boolean {
  return (
    payload.success !== false &&
    (payload.code === undefined || payload.code === 0 || payload.code === 200)
  );
}

// status 与身份同时成立才算可用：只有 active 但身份不符（例如别的套餐）不算 Start Plan。
// 身份缺失时放行：无法证明它不是 Start Plan，避免新命名导致误判。
// 该判定是纯函数、不依赖时间：过期由 normalizeStartPlanExpiry 在数据层处理。
function hasActiveStartPlan(plans: ZaiStartPlanPlan[] | undefined): boolean {
  return Boolean(
    plans?.some((plan) => {
      const status = plan.status?.trim().toLowerCase();
      const planId = plan.plan_id?.trim().toLowerCase();
      const name = plan.name?.trim().toLowerCase();
      // billing/balance 的 plans 真实返回的是 `plan_id=zcode-v3-start-plan`
      // 和 `name=ZCode V3 Start Plan`；只认 `name === "start plan"` 的话，
      // 已激活的 Start Plan 会被误写成 coding_plan_not_entitled。
      const identityMatches =
        !planId && !name ? true : isZaiStartPlanIdentity(planId) || isZaiStartPlanIdentity(name);
      return status === "active" && identityMatches;
    }),
  );
}

// 同时接受连字符与空格两种写法：后端在不同接口里对同一套餐用了不同拼写。
// 用 includes 而不是相等：版本号会进入 plan_id（zcode-v3-start-plan）。
function isZaiStartPlanIdentity(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.includes("start-plan") || value.includes("start plan");
}

// 日志摘要只取身份/状态三类字段：完整 payload 已单独记录，摘要用于快速扫读。
function summarizeStartPlans(
  plans: ZaiStartPlanPlan[] | undefined,
): Array<Pick<ZaiStartPlanPlan, "name" | "plan_id" | "status">> {
  return (plans ?? []).map((plan) => ({
    name: plan.name ?? null,
    plan_id: plan.plan_id ?? null,
    status: plan.status ?? null,
  }));
}
