// 进程内 Project Token 读取服务：把 OAuth 登录态换成短期 Token，并对并发换证做合并。
// INV-01：pending 的 key 含 loginToken —— 登录态一变就不可能命中旧账号的在途请求。
// INV-02：换证返回后必须复核 OAuth token 未变，否则丢弃结果并抛 project_token_scope_invalidated。
// INV-03：本服务不落盘、不缓存成功 Token；缓存只存在于请求期间的 pending Map。
import type { ProviderFamilyDomain, ProjectAccessTokenMaterial } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

const log = createServiceLogger("account-project-token");
// 两个注入点：读 OAuth token、按 family 解析 Project Token 材料；
// accountIdentity 由调用方传入，本服务不认识账号结构。
interface AccountProviderCredentialServiceOptions {
  readonly loadOAuthAccessToken: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveProviderMaterial: (
    family: ProviderFamilyDomain,
    accessToken: string,
    accountIdentity: string,
    rejectedProjectTokenFingerprint?: string,
  ) => Promise<ProjectAccessTokenMaterial | null>;
}
// forceRefresh 只表达调用方意图：本服务不缓存成功结果，因此无需据此跳过任何缓存。
interface LoadCodingPlanApiKeyInput {
  readonly providerId: string;
  readonly family: ProviderFamilyDomain;
  readonly accountIdentity: string;
  readonly forceRefresh?: boolean;
  readonly rejectedProjectTokenFingerprint?: string;
}
// 字符串与材料两个入口共存：材料入口保留 apiKeyId，供日志与计量关联。
export interface AccountProviderCredentialService {
  loadCodingPlanApiKey(input: LoadCodingPlanApiKeyInput): Promise<string | null>;
  loadCodingPlanMaterial(
    input: LoadCodingPlanApiKeyInput,
  ): Promise<ProjectAccessTokenMaterial | null>;
}

/** 旧方法名兼容私有调用契约；返回值现在是请求期 Token，绝不读写长期 Key 缓存。 */
// 工厂闭包持有 pending，生命周期等于服务实例，随进程回收，无需显式清理。
export function createAccountProviderCredentialService(
  options: AccountProviderCredentialServiceOptions,
): AccountProviderCredentialService {
// [并发] pending 以「family + 账号 + loginToken + 被拒指纹」为键做请求合并：
// 同一时刻只有一次换证在飞，失败时所有等待者共享同一异常。
  const pending = new Map<string, Promise<ProjectAccessTokenMaterial | null>>();
  return {
// 只取 token 字段：null 与 undefined 都归一为 null，调用方不必区分两种空值。
    async loadCodingPlanApiKey(input) {
      return (await this.loadCodingPlanMaterial(input))?.token ?? null;
    },
    async loadCodingPlanMaterial(input) {
// [失败路径] 没有 OAuth token 说明未登录，直接返回 null，让上层走无凭据路径。
      const loginToken = (await options.loadOAuthAccessToken(input.family))?.trim();
      if (!loginToken) return null;
      // Map 仅存进程内并发状态；登录态变化不能加入旧账号请求。
      const key = JSON.stringify([
        input.family,
        input.accountIdentity,
        loginToken,
        input.rejectedProjectTokenFingerprint,
      ]);
// 命中在途请求时直接复用 Promise，避免同一账号并发换证产生多张令牌。
      const existing = pending.get(key);
      if (existing) return existing;
// [并发] operation 先登记再 await：若先 await 后 set，两个并发调用都会 miss 并各自换证；
// 副作用是同步抛出的异常也会变成 rejected Promise，统一走 finally 清理。
      const operation = (async () => {
        const token = await options.resolveProviderMaterial(
          input.family,
          loginToken,
          input.accountIdentity,
          input.rejectedProjectTokenFingerprint,
        );
// [并发] 换证期间登录态可能变化（登出/换号）；比对原始 loginToken 而不是重拼 key，
// 因为只关心「是否还是同一次登录」，不关心其它维度是否恰好相同。
        if ((await options.loadOAuthAccessToken(input.family))?.trim() !== loginToken) {
          log.warn(undefined, "项目 Token 签发期间登录态变化，丢弃结果", {
            family: input.family,
          });
// [失败路径] 固定错误码方便上层识别并重试一次；结果被丢弃即等于撤销这次换证。
          throw new Error("project_token_scope_invalidated");
        }
        return token ?? null;
      })();
      pending.set(key, operation);
      try {
        return await operation;
// [资源] 只有当前登记的仍是自己时才删除：防止后到的同 key 请求被先完成者清掉。
      } finally {
        if (pending.get(key) === operation) pending.delete(key);
      }
    },
  };
}
