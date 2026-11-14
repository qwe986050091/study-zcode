import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
} from "@zcode/shared";
import { accountProviderCredentialKey } from "../model-provider/accountProviderCredentialKey.js";
import type { AccountProviderCredentialStore } from "../model-provider/accountProviderCredentialStore.js";

// 登出处理器只清理 OAuth 账号维度的凭据，不触碰本机其他账号的登录信息，
// [边界] deleteApiKey 只删当前 accountProvider 维度：切换账号或退出登录时，其余已登录账号的凭据不受影响。
// 依赖以接口注入，便于测试替换凭据存储与刷新回调，也避免直接耦合具体实现。
interface OAuthProviderLogoutDependencies {
  readonly accountProviderCredentialStore: Pick<AccountProviderCredentialStore, "deleteApiKey">;
  readonly refreshAccountProviders?: (reason: string) => Promise<unknown>;
}

// 返回的异步函数是登出入口：按 provider 解析出对应的 coding plan 模型 ID，
// 删除该账号的 API key 后触发 provider 列表刷新。
// 设计为幂等：未识别 provider 或无账号标识时静默返回，重复调用不会产生额外副作用。
export function createOAuthProviderLogoutHandler(
  dependencies: OAuthProviderLogoutDependencies,
): (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void> {
  return async (provider, accountIdentity) => {
// 仅内置的 Z.ai / BigModel 提供 coding plan 凭据，其余 provider 没有对应条目，
// 直接返回可避免向存储写入无意义的 key。
// 解析结果为空即代表该 provider 无 OAuth 登出需求，这是正常分支而非错误。
    const providerIds = resolveProviderIds(provider);
    if (!providerIds) return;

// 账号标识是删除凭据的必要条件；为空时只做刷新，避免退化成按 provider 全量删除。
// trim 后判空可兼容上游传入空串或纯空白的边界情况。
// 凭据 key 由 accountProviderCredentialKey 统一生成，保证与写入侧完全一致。
    if (accountIdentity?.trim()) {
      await dependencies.accountProviderCredentialStore.deleteApiKey(
        accountProviderCredentialKey({
          providerId: providerIds.codingPlan,
          planKind: "individual-coding-plan",
          accountIdentity,
        }),
      );
    }
// 刷新是可选副作用：回调未注入时跳过，但凭据删除已经生效，调用方不应依赖刷新的完成时序。
// reason 携带 provider，便于上层日志区分不同登出来源。
    await dependencies.refreshAccountProviders?.(`oauth-logout:${provider}`);
  };
}

function resolveProviderIds(provider: OAuthProviderId): {
  readonly codingPlan: string;
} | null {
  if (provider === ZAI_PROVIDER_ID) {
    return {
      codingPlan: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    };
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return {
      codingPlan: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    };
  }
  return null;
}
