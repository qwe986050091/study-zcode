import {
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type ApiClient,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import type { LegacyTeamConnection } from "#src/setting/legacyAccountConnectionSettings.js";
import type {
  RemoteCustomerInfo,
  RemoteEnvelope,
} from "#src/model-provider/accountProviderApiTypes.js";

/** 仅供旧连接导入：只读 OAuth 用户信息，不依赖当前 Provider，也不申请团队 Key。退役旧版后删除。 */
// INV-01：只有「恰好一个组织包含该项目」时才返回组织 ID；多组织命中返回 null，
// 调用方按未知处理，否则团队会员会被挂到错误组织下。
// [并发] 请求前后各读一次 OAuth token，两次不一致说明期间换了账号，本次结果作废。
// [失败路径] 网络失败、非 2xx、业务码非 0/200 一律返回 null，不抛错打断旧连接导入。
export function createLegacyTeamOrganizationResolver(dependencies: {
  apiClient: ApiClient;
  loadOAuthTokenSet: (
    family: ProviderFamilyDomain,
  ) => Promise<{ accessToken: string; zcodeJwtToken?: string | null } | null>;
}): (connection: LegacyTeamConnection) => Promise<string | null> {
// 每次调用重新加载 token，不复用闭包缓存：导入按 connection 逐个处理，
// 期间用户可能已经重新登录。
  return async ({ family, projectId }) => {
// [失败路径] 未登录时返回 null，这里不视为异常，只表示无法确认组织。
    const tokens = await dependencies.loadOAuthTokenSet(family);
    const token = tokens?.accessToken.trim();
    if (!token || (family === "bigmodel" && token === tokens?.zcodeJwtToken)) return null;
// 两个业务域共用同一路径但域名不同，必须按 family 分流，否则测试环境 token 会打到生产网关。
    const origin =
      family === "zai"
        ? resolveZaiBusinessBaseUrl(process.env)
        : resolveBigModelApiOrigin(process.env);
// 超时 15s：旧连接导入是启动期串行步骤，单次挂起会拖慢整个设置加载。
    const response = await dependencies.apiClient.request(
      `${origin}/api/biz/customer/getCustomerInfo`,
      {
        method: "GET",
        timeoutMs: 15_000,
        // 两个业务域都使用原始 OAuth token；不能添加 Bearer 或使用模型 API Key。
        headers: { Authorization: token, "Content-Type": "application/json" },
      },
    );
// 4xx/5xx 与网络失败同义，都按「无法确认」处理，不区分原因。
    if (!response.ok) return null;
    const payload = (await response.json()) as RemoteEnvelope<RemoteCustomerInfo>;
// 业务码存在才校验：部分网关直接返回裸 data，不携带 code。
    if (payload.code !== undefined && payload.code !== 0 && payload.code !== 200) return null;
    // 账号切换使旧查询失去权威，即使项目 ID 碰巧相同也不能把组织写给新账号。
    if ((await dependencies.loadOAuthTokenSet(family))?.accessToken.trim() !== token) return null;
    const organizations = new Set(
      (payload.data?.organizations ?? [])
        .filter((org) => org.projects?.some((project) => project.projectId?.trim() === projectId))
        .map((org) => org.organizationId?.trim())
        .filter((id): id is string => Boolean(id)),
    );
    return organizations.size === 1 ? [...organizations][0]! : null;
  };
}
