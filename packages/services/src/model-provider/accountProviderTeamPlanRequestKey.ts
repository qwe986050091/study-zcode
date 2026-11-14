import {
  BIGMODEL_PROVIDER_ID,
  ProjectAccessTokenClient,
  type ApiClient,
  type ProjectAccessTokenMaterial,
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type ZCodeAccountAccess,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readApiJson } from "#src/providers/api/apiJson.js";

// 团队套餐（team-coding-plan）的请求期换证：用 OAuth access token 换团队项目的 Project Token。
// INV-01：BigModel 族禁止用 ZCode JWT 充当 OAuth access token —— 旧版本曾误写同一槽位，
//          两值相等即视为脏数据并跳过换证。
// INV-02：换证是异步 IO，返回前必须复核 OAuth token 未变；变了就 clear 并抛固定错误码，
//          防止旧账号的令牌被新请求复用。
const log = createServiceLogger("account-provider-team-plan-request-key");
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const TEAM_PLAN_RUNTIME_KEY_REQUEST_TIMEOUT_MS = 15_000;

// 依赖全部注入：apiClient 负责 HTTP，credentialService 只读凭据，tokenClient 可被测试替换；
// access 已收窄为 team-coding-plan，保证 organizationId / projectId / productId 一定存在。
interface TeamPlanRequestKeyDependencies {
  readonly apiClient: ApiClient;
  readonly tokenClient?: ProjectAccessTokenClient;
  readonly accountIdentity?: string;
  readonly rejectedProjectTokenFingerprint?: string;
  readonly credentialService?: Pick<ICredentialService, "load">;
  readonly access: Extract<ZCodeAccountAccess, { planKind: "team-coding-plan" }>;
}

// 只要 token 的薄封装：团队换证失败返回 null（视为无凭据），不向调用方抛异常。
export async function resolveAccountTeamPlanRuntimeApiKey(
  params: TeamPlanRequestKeyDependencies,
): Promise<string | null> {
  return (await resolveAccountTeamPlanRuntimeMaterial(params))?.token ?? null;
}

// 团队换证主流程：读 OAuth token → 选域名 → 换 Project Token → 复核登录态。
// [失败路径] 返回 null 的三种情况：OAuth token 缺失、BigModel 误用旧 JWT、换证本身拿到空结果。
export async function resolveAccountTeamPlanRuntimeMaterial(
  params: TeamPlanRequestKeyDependencies,
): Promise<ProjectAccessTokenMaterial | null> {
// productId 不参与换证，只在上层凭证键里用于隔离不同产品线的团队令牌。
  const { family, organizationId, projectId } = params.access;
// OAuth 凭据键按 Provider 族拼装；这里的 providerId 是 OAuth 维度，与账号 Provider ID 不同。
  const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
  const token =
    (await params.credentialService?.load(`oauth:${oauthProviderId}:access_token`))?.trim() ?? "";
// [失败路径] 登录态缺失时返回 null 而不是抛错：调用方据此当作「未登录」降级。
  if (!token) {
    log.warn(undefined, "Team Plan runtime key projection skipped: OAuth token missing", {
      family,
      projectId,
    });
    return null;
  }
// [边界] 旧槽位 ZCODE_JWT_TOKEN_KEY 只用于脏数据识别：读不到按空串处理，不阻断正常投影流程。
  const zcodeJwtToken = (await params.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
// [权衡] 只在 bigmodel 族拦截：zai 族历史上允许 JWT 走同一槽位，统一拦截会误伤已登录用户；
// 相等判断是唯一可靠信号——JWT 与 access token 不会同值，除非写入路径出错。
  if (family === "bigmodel" && zcodeJwtToken && token === zcodeJwtToken) {
    // BigModel /api/biz 只接受登录 access token，不能使用旧版本误存的 ZCode JWT。
    log.warn(undefined, "Team Plan runtime key projection skipped: stale zcode JWT token", {
      family,
      projectId,
    });
    return null;
  }

// [权衡] 两族的域名解析函数不同：BigModel 支持环境变量覆盖，ZAI 使用固定 business base。
  const host =
    family === "zai"
      ? resolveZaiBusinessBaseUrl(process.env)
      : resolveBigModelApiOrigin(process.env);
// 未注入时构造一次性 tokenClient：15s 超时避免团队换证卡住整个模型请求；
// observe 只记 warn，配置错误由下面的结果判定统一暴露。
  const client =
    params.tokenClient ??
    new ProjectAccessTokenClient({
      request: (url, init) =>
        readApiJson(params.apiClient, url, {
          ...init,
          timeoutMs: TEAM_PLAN_RUNTIME_KEY_REQUEST_TIMEOUT_MS,
        }),
      observe: (event) => log.warn(undefined, "团队项目 Token 获取失败", event),
    });
// team 字段让换证服务按「组织 + 项目」精确签发，而不是回退到账号下的默认个人项目。
  const result = await client.resolve({
    origin: host,
    family,
    loginToken: token,
    accountId: params.accountIdentity ?? family,
    rejectedProjectTokenFingerprint: params.rejectedProjectTokenFingerprint,
// [并发] 团队三元组只在本次调用内使用；换证服务按它生成 locationKey，不写全局状态。
    team: { organizationId, projectId },
  });
// [并发] 换证期间登录态可能被登出或切换账号；用「token 是否仍是当前值」判定，
// 变了就丢弃结果并让本次请求失败，避免旧账号的 Project Token 进入新请求。
  if (
    (await params.credentialService?.load(`oauth:${oauthProviderId}:access_token`))?.trim() !==
    token
  ) {
// [资源] 清掉该实例的会话与令牌缓存，防止下次请求命中旧账号的项目定位。
    client.clear();
// [失败路径] 固定错误码：上层据此触发一次账号连接重解析，而不是无脑重试。
    throw new Error("project_token_scope_invalidated");
  }
  return result;
}
