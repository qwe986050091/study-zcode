// 请求期账号鉴权解析：把「静态 Provider 视图 + 当前账号连接」解析成一次请求可用的材料。
// INV-01：start-plan 只取 zcodeJwtToken；个人/团队套餐只用 Project Token，两类凭据不交叉。
// INV-02：accountScope = sha256(family, planKind, 团队三元组, accessToken, zcodeJwtToken)，
//          换证前后必须一致，否则抛 project_token_scope_invalidated。
// INV-03：本文件不持久化、不缓存 Token；缓存责任在 CredentialService 与 ProjectAccessTokenClient。
import type { RequestVerificationReason } from "@zcode/shared";
import { createHash } from "node:crypto";
import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderId,
  type ProviderFamilyDomain,
  type ProjectAccessTokenMaterial,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";

// 传出的鉴权材料：apiKey 是本次请求真正要用的值（start-plan 为 JWT，套餐为 Project Token），
// 字段名保留 apiKey 只为兼容下游传输契约，不能据此推断它是长期 Key。
export interface AccountRequestAuthMaterial {
  /** 私有传输字段兼容旧命名；套餐 OAuth 实际传入短期 Project Token。 */
  apiKey?: string;
  apiKeyId?: string;
  headers?: Record<string, string>;
  accountScope?: string;
}

// reason 决定是否做 scope 校验：usage 统计默认跳过，但只要给了 expectedAccountScope 就必须校验。
export interface AccountRequestAuthInput {
  providerId: string;
  modelId?: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  expectedAccountScope?: string;
  rejectedProjectTokenFingerprint?: string;
  reason: RequestVerificationReason | "off-peak" | "usage";
}

// 仅做身份存活性检查的输入：assertCurrent 不返回材料，避免调用方顺手缓存凭据。
export interface AccountAccessIdentityInput {
  providerId: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

// [失败路径] 统一「凭据不可用」错误类型：上层用 instanceof 区分「需要重新登录」与网络/协议错误，
// 其它地方不要用普通 Error 表达同一语义。
export class AccountRequestCredentialUnavailableError extends Error {
  constructor(readonly providerId: string) {
    super(`Account request credential is unavailable: ${providerId}`);
    this.name = "AccountRequestCredentialUnavailableError";
  }
}

// 三个方法对应三种粒度：只解析连接、解析本次材料、只断言连接仍有效。
export interface AccountRequestAuthResolver {
  resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  resolveCurrent(input: AccountRequestAuthInput): Promise<AccountRequestAuthMaterial>;
  assertCurrent(input: AccountAccessIdentityInput): Promise<void>;
}

// 四个注入点把 IO 全部外置，类本身只做编排：账号连接解析、OAuth Token 读取、
// 个人套餐换证、团队套餐换证。
interface AccountProviderRequestAuthServiceOptions {
  resolveCurrentAccountAccess(
    access: ZCodeProviderAccountAccess,
  ): Promise<ZCodeAccountAccess | null>;
// 允许返回 null（未登录）或字段为空；每个调用点都必须按「缺失即不可用」处理。
  loadOAuthTokenSet(providerId: OAuthProviderId): Promise<{
    accessToken?: string | null;
    zcodeJwtToken?: string | null;
  } | null>;
  loadIndividualPlanMaterial(
    providerId: string,
    family: ProviderFamilyDomain,
    rejectedProjectTokenFingerprint?: string,
  ): Promise<ProjectAccessTokenMaterial | null>;
  resolveTeamPlanMaterial(
    access: Extract<ZCodeAccountAccess, { planKind: "team-coding-plan" }>,
    rejectedProjectTokenFingerprint?: string,
  ): Promise<ProjectAccessTokenMaterial | null>;
}

// 私有字段 #options 阻止外部改写依赖，保证实例生命周期内解析路径稳定。
class AccountProviderRequestAuthService implements AccountRequestAuthResolver {
  readonly #options: AccountProviderRequestAuthServiceOptions;

  constructor(options: AccountProviderRequestAuthServiceOptions) {
// 保存引用而非深拷贝：依赖是端口对象，复制会丢失其内部状态（如缓存与并发合并）。
    this.#options = options;
  }

// 纯委托：连接的最新性由 options.resolveCurrentAccountAccess 保证，本层不缓存结果。
  resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null> {
    return this.#options.resolveCurrentAccountAccess(access);
  }

// 单请求主流程：先确认真实账号连接（而非调用方传入的静态视图），再按 planKind 选凭据来源。
// [并发] 两次 #resolveAccess 之间账号可能变化，因此 scoped 分支在换证后还要复算一次 scope。
  async resolveCurrent(input: AccountRequestAuthInput): Promise<AccountRequestAuthMaterial> {
// providerId 只用于错误信息与 per-provider 换证，不参与凭据键拼接（键由上层 CredentialService 生成）。
    const providerId = input.providerId.trim();
    const access = await this.#resolveAccess(input.accountAccess);
// [失败路径] 解析不到当前连接说明已登出或连接被删除：立即失败，不回退到调用方传入的静态 access。
    if (!access) throw new AccountRequestCredentialUnavailableError(providerId);

// start-plan 使用 BigModel 的 zcodeJwtToken：它由 OAuth callback 阶段落盘，不能用 access token 现场兑换。
// 这条路径不计算 accountScope，因为不涉及项目级换证。
    if (access.planKind === "start-plan") {
      const tokenSet = await this.#options.loadOAuthTokenSet(resolveOAuthProviderId(access.family));
      return { apiKey: requireApiKey(tokenSet?.zcodeJwtToken, providerId) };
    }

// usage 统计默认跳过 scope 计算，省一次凭据读取；但调用方一旦给出 expectedAccountScope，
// 就必须计算并比较，否则等于放弃串号防护。
    const scoped = input.reason !== "usage" || input.expectedAccountScope !== undefined;
// [失败路径] 有被拒指纹却没有期望 scope：无法判断新账号是否同一项目，按失效处理最安全。
    if (input.rejectedProjectTokenFingerprint && !input.expectedAccountScope)
      throw new Error("project_token_scope_invalidated");
// scope 在换证前计算，作为「换证前后是否同一账号/项目」的基准值。
    const accountScope = scoped ? await this.#scope(access) : undefined;
// [失败路径] 与调用方期望不一致立即失败：重试队列可能正拿着旧账号的 scope。
    if (input.expectedAccountScope !== undefined && input.expectedAccountScope !== accountScope)
      throw new Error("project_token_scope_invalidated");
// [权衡] 个人与团队走不同换证入口：个人按 family 解析默认项目，团队按组织+项目精确签发；
// 合并成一个函数会把团队三元组降级为可选参数，容易漏传。
    const material =
      access.planKind === "individual-coding-plan"
        ? await this.#options.loadIndividualPlanMaterial(
            providerId,
            access.family,
            input.rejectedProjectTokenFingerprint,
          )
        : await this.#options.resolveTeamPlanMaterial(
            access,
            input.rejectedProjectTokenFingerprint,
          );
// 只有计算过 scope 的路径才复核；usage 快路径不做第二次连接读取。
    if (scoped) {
      // 换证 IO 前后校验原请求身份，避免 401 重试或闲时票据串用新账号/项目。
// [并发] 二次读取当前连接：期间登出或切换账号会让 latest 为空（或 scope 不同）。
      const latest = await this.#resolveAccess(input.accountAccess);
      if (!latest || accountScope !== (await this.#scope(latest)))
        throw new Error("project_token_scope_invalidated");
    }
    return {
// [失败路径] material 为空表示换证失败，requireApiKey 抛 CredentialUnavailable 而不是返回空串；
// accountScope 只在计算过时附带，避免给下游一个假的空 scope。
      apiKey: requireApiKey(material?.token, providerId),
      apiKeyId: material?.apiKeyId,
      ...(accountScope ? { accountScope } : {}),
    };
  }

// scope 必须覆盖所有影响换证结果的维度：族、套餐类型、团队三元组、两种 Token。
// [失败路径] 缺少 accessToken 说明登录态不完整，抛 CredentialUnavailable 而不是算出空 scope。
  async #scope(access: ZCodeAccountAccess): Promise<string> {
    const login = await this.#options.loadOAuthTokenSet(resolveOAuthProviderId(access.family));
    if (!login?.accessToken?.trim())
      throw new AccountRequestCredentialUnavailableError(access.family);
// [权衡] 用 JSON 数组而不是字符串拼接：字段值里出现分隔符时不会造成不同输入同哈希。
    return createHash("sha256")
      .update(
        JSON.stringify([
          access.family,
          access.planKind,
          access.planKind === "team-coding-plan"
            ? [access.organizationId, access.projectId, access.productId]
            : null,
          login.accessToken.trim(),
          login.zcodeJwtToken?.trim() ?? null,
        ]),
      )
      .digest("hex");
  }

// 只断言连接仍可解析，不读取 Token；供高频路径（模型列表刷新）低成本校验。
  async assertCurrent(input: AccountAccessIdentityInput): Promise<void> {
    if (!(await this.#resolveAccess(input.accountAccess))) {
      throw new AccountRequestCredentialUnavailableError(input.providerId);
    }
  }

// 静态 access（无 mode 字段）直接返回，避免对已是事实源的视图再查一次；
// 带 mode 的是 Provider 视图，必须回查账号连接才能拿到当前 planKind。
  #resolveAccess(
    access: ZCodeProviderAccountAccess | ZCodeAccountAccess,
  ): Promise<ZCodeAccountAccess | null> {
    return "mode" in access
      ? this.#options.resolveCurrentAccountAccess(access)
      : Promise.resolve(access);
  }
}

// family 与 OAuth providerId 是两套命名；映射集中在此，避免各处手写三元表达式。
function resolveOAuthProviderId(family: ProviderFamilyDomain): OAuthProviderId {
  return family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
}

// [失败路径] 空串或纯空白一律视为缺失：换证服务可能返回空 token 而不报错。
function requireApiKey(value: string | null | undefined, providerId: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new AccountRequestCredentialUnavailableError(providerId);
  }
  return normalized;
}

// 工厂只做装配，不暴露类本身，调用方无法绕过注入点。
export function createAccountProviderRequestAuthService(
  options: AccountProviderRequestAuthServiceOptions,
): AccountProviderRequestAuthService {
  return new AccountProviderRequestAuthService(options);
}
