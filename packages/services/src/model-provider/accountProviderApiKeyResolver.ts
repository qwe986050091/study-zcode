import {
  ProjectAccessTokenClient,
  type ProjectAccessTokenMaterial,
  resolveBigModelApiOrigin,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { ZAI_API_HOST } from "../providers/api/apiEndpoints.js";
import {
  DEFAULT_ORG_NAME,
  DEFAULT_PROJECT_NAME,
  type AccountApiProviderId,
  type RemoteCustomerInfo,
} from "./accountProviderApiTypes.js";

// 账号 Provider 的项目级 API Key 解析器：把 OAuth 登录 token 换成短期 Project Token。
// INV-01：个人 Key 只能落在非 Team Plan 项目上，projectType === "2" 的项目必须被过滤，
//          否则个人请求会拿到团队项目 Token，按团队配额计费。
// INV-02：tokenClient 是唯一换证通道；本文件不缓存 Token、不读写长期 Key，缓存与去重都在
//          ProjectAccessTokenClient 内部（locations 与 ProjectAccessTokenCache）。
const log = createServiceLogger("account-project-token-resolver");

// 从 customerInfo 里挑出「个人可用」的机构与项目；找不到任何候选时返回 null，
// 由调用方按「无项目」降级，而不是抛错终止登录流程。
export function pickOrgAndProject(customerInfo: RemoteCustomerInfo): {
  organizationId: string;
  projectId: string;
} | null {
// 第一层过滤：先剔除 Team Plan 项目再判空。organization.projects 可能缺失或全是团队项目，
// 这类机构整体不可用，必须从候选里移除而不是回退到它。
  const personalOrganizations = (customerInfo.organizations ?? [])
    .map((organization) => ({
      organization,
      // Team Plan 项目会和个人项目一起返回；个人 Key 只能从非团队项目解析。
      projects: (organization.projects ?? []).filter(
        (project) => String(project.projectType ?? "").trim() !== "2",
      ),
    }))
// 只保留「有 organizationId 且至少剩一个项目」的机构：两者缺一都无法拼出换证路径。
    .filter(({ organization, projects }) =>
      Boolean(organization.organizationId && projects.length),
    );
// [失败路径] 空数组是正常业务结果（账号下没有个人项目），返回 null 而不是抛异常；
// 上层据此走无凭据路径，不会把登录判成失效。
  if (personalOrganizations.length === 0) {
    return null;
  }

// [权衡] 机构选择是「名字包含默认机构名优先，否则取第一个」：服务端不保证顺序，
// 名字启发式能让中文环境命中「默认机构」，同时保证英文账号仍可用。
  const selected =
    personalOrganizations.find(({ organization }) =>
      (organization.organizationName ?? "").includes(DEFAULT_ORG_NAME),
    ) ?? personalOrganizations[0];
// [失败路径] 再次判空是防御远端返回空串 ID：类型上非空不代表值可用。
  if (!selected?.organization.organizationId) {
    return null;
  }

// 项目沿用同一兜底策略（默认项目名优先、否则第一个），避免机构与项目两处选择规则分叉。
  const project =
    selected.projects.find((item) => (item.projectName ?? "").includes(DEFAULT_PROJECT_NAME)) ??
    selected.projects[0];
  if (!project?.projectId) {
    return null;
  }

  return {
// 只返回 ID，不返回名字：名字仅参与启发式匹配，后续换证只认 ID。
    organizationId: selected.organization.organizationId,
    projectId: project.projectId,
  };
}

// 持有一个 tokenClient 而不是每次新建：ProjectAccessTokenClient 内部按 origin+family
// 维护会话、项目定位与令牌缓存，多实例会让同一账号重复换证。
export class AccountProviderApiKeyResolver {
  readonly tokenClient: ProjectAccessTokenClient;
  constructor(
    fetchRemoteData: <T>(url: string, init: RequestInit) => Promise<T | null>,
    tokenClient?: ProjectAccessTokenClient,
  ) {
// 未注入时把 fetchRemoteData 适配成换证客户端需要的 { code, data } 信封；
// observe 只记 warn，换证失败由调用方按无 Key 处理，不在这里降级重试。
    this.tokenClient =
      tokenClient ??
      new ProjectAccessTokenClient({
        request: async (url, init) => ({
          code: 200,
          data: await fetchRemoteData(url, init),
        }),
        observe: (event) => log.warn(undefined, "项目 Token 获取失败", event),
      });
  }

// 兼容旧调用方：只需要字符串 Token，丢弃 apiKeyId 等项目定位信息。
  async resolveProviderApiKey(
    ...args: Parameters<AccountProviderApiKeyResolver["resolveProviderMaterial"]>
  ): Promise<string> {
    return (await this.resolveProviderMaterial(...args)).token;
  }

  async resolveProviderMaterial(
    provider: AccountApiProviderId,
    accessToken: string,
    accountIdentity: string = provider,
    rejectedProjectTokenFingerprint?: string,
  ): Promise<ProjectAccessTokenMaterial> {
// provider → family 的映射同时决定换证域名与计量口径；ZAI 与 BigModel 的 origin 不能混用。
    const family = provider === ZAI_PROVIDER_ID ? "zai" : "bigmodel";
// [并发] 本层不做请求去重：在途 Promise 与缓存都在 ProjectAccessTokenClient 内按会话去重；
// 两层各自缓存会引入两套过期时间，导致同一账号拿到新旧不同的令牌。
    const result = await this.tokenClient.resolve({
      origin: family === "zai" ? ZAI_API_HOST : resolveBigModelApiOrigin(process.env),
      family,
// 指纹透传给令牌缓存：命中时丢弃被 401 拒绝过的那份令牌并重新签发，而不是跳过整个定位流程。
      loginToken: accessToken,
      accountId: accountIdentity,
      rejectedProjectTokenFingerprint,
    });
// [失败路径] resolve 抛出的错误已被归一为固定错误码（不保留原始 message），这里原样上抛。
    return result;
  }
}
