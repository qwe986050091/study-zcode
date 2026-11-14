// OAuth provider 适配器契约：把各家协议差异收敛在实现内部，上层只依赖本接口。
// 边界：本文件只声明形状与语义，provider 特例、网络调用与凭据存储都由实现承担。
// INV：token 与错误归一化必须由 provider 自己完成，调用方不得做 provider 分支判断。
import type {
  ApiClient,
  OAuthCallbackParams,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";

/** Provider 执行上下文 */
export interface OAuthProviderContext {
  // providerId 标明当前上下文归属：解析回调时用它选适配器。
  providerId: OAuthProviderId;
  // state 必须在授权 URL 与回调解析两侧一致：它是 CSRF 判据，不是展示字段。
  state: string;
  // redirectUri 由调用方传入：同一 provider 可能被不同入口复用。
  redirectUri: string;
  // now 注入时钟：授权 URL 的过期与 state 时间戳在测试里可固定。
  now: () => number;
}

/** OAuth provider 适配器：隔离协议差异 */
export interface OAuthProviderAdapter {
  // providerId 是路由键：调用方据此选实现，禁止用 meta.name 反推。
  readonly providerId: OAuthProviderId;
  // meta 提供展示名与端点：登录页只读它，不读 provider 源码。
  readonly meta: OAuthProviderMeta;
  // redirectUri 与 meta 分开：回跳地址可被运行时覆盖，meta 是静态声明。
  readonly redirectUri: string;
  // apiClient 是唯一出站通道：适配器不得自建 fetch，否则超时与代理配置会分叉。
  readonly apiClient: ApiClient;

// 回调解析不得信任 URL 参数：state 校验与授权码缺失都需归一化为本地错误。
  parseCallbackParams(url: string): OAuthCallbackParams;
  // buildAuthorizeUrl 必须自行带上 state 与 redirect_uri：调用方不做参数补全。
  buildAuthorizeUrl(context: OAuthProviderContext): string;
// 换取 token 是最多一次的网络写操作，适配器内不得隐式重试，重试策略归上层。
  exchangeToken(params: OAuthCallbackParams, context: OAuthProviderContext): Promise<OAuthTokenSet>;
  /** 将后端 polling 返回的 provider token 归一化为 Desktop 持久化语义。 */
  normalizePolledTokenSet?(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet>;
  // fetchUserInfo 可选：部分 provider 只发 token 不提供资料接口。
  fetchUserInfo?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthUserProfile>;
  // refreshToken 可选：不支持刷新的 provider 不实现，调用方按能力表判断。
  refreshToken?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthTokenSet>;

  /** provider 级 legacy 凭据读取（用于升级兼容） */
  loadLegacyTokenSet?(
    // loadCredential 由上层注入：适配器不直接依赖凭据服务，便于测试替换。
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null>;

// 错误归一化必须脱敏：不得把 provider 原始响应、授权码或凭据写进 message。
  normalizeError(error: unknown): Error;
}
