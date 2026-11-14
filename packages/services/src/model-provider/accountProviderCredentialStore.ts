// Account Provider 请求期凭据的键值门面：只做 key 规范化、空值折叠与委托，不持有状态。
// INV-01：空或纯空白 key 一律抛错，绝不写入 Credential Store（否则会产生不可寻址的条目）。
// INV-02：空或纯空白 value 等价于删除，读取端永远拿不到空串。
import type { ICredentialService } from "#src/credential/credential.js";

export interface AccountProviderCredentialStore {
  loadApiKey(credentialKey: string): Promise<string | null>;
  saveApiKey(credentialKey: string, apiKey: string): Promise<void>;
  deleteApiKey(credentialKey: string): Promise<void>;
}

export interface AccountProviderCredentialStoreOptions {
  readonly credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
}

/**
 * 保存 Account Provider 的请求期凭据。
 *
 * 只读取账号 Credential Store；旧 Provider Store 不再作为凭据来源。
 */
export function createAccountProviderCredentialStore(
  options: AccountProviderCredentialStoreOptions,
): AccountProviderCredentialStore {
  return {
// [失败路径] 未命中或值为空都返回 null（normalizeApiKey 把空串折叠为 null），调用方按无凭据处理。
    async loadApiKey(credentialKey) {
      // 读取前先校验 key：空 key 直接抛错，不会落到凭据服务产生不可寻址的条目。
      const key = requireCredentialKey(credentialKey);
      // 存储层可能返回空串或空白，normalizeApiKey 把这些形态折叠成 null，读取端只看 null 与非 null。
      return normalizeApiKey(await options.credentialService.load(key));
    },

    async saveApiKey(credentialKey, apiKey) {
      // 写入沿用同一校验口径：读写两侧对 key 的定义必须完全一致。
      const key = requireCredentialKey(credentialKey);
      // 写入前先走 normalizeApiKey：空值走删除分支，避免把「存在但无效」的条目留在存储里。
      const normalized = normalizeApiKey(apiKey);
      // 空值等价于删除，与 INV-02 一致；不写入空串，读取端就永远拿不到空串。
      if (!normalized) {
        // 空值直接删除：与读取侧「空串折叠为 null」配对，存储里不保留空条目。
        await options.credentialService.delete(key);
        return;
      }
      // 归一后的非空值才写入；保存成功即代表该 scope 的请求期凭据可用。
      await options.credentialService.save(key, normalized);
    },

// 删除幂等：底层 delete 对不存在的 key 不报错。
    async deleteApiKey(credentialKey) {
      // 删除同样校验 key；底层 delete 对不存在的 key 幂等，因此不先查存在性。
      await options.credentialService.delete(requireCredentialKey(credentialKey));
    },
  };
}

// key 只做 trim，不做大小写或编码变换：保证同一 scope 生成的字符串可直接寻址。
function requireCredentialKey(value: string): string {
  // 只 trim 不改大小写或编码：同一 scope 生成的字符串必须能直接寻址。
  // 抛错而不是返回 null：返回 null 会让调用方跳过读写，问题被推迟到读取时才暴露，且更难定位。
  const normalized = value.trim();
  if (!normalized) throw new Error("Account Provider Credential Key 不能为空");
  return normalized;
}

function normalizeApiKey(value: string | null | undefined): string | null {
  // 粘贴的 token 常带换行，去掉首尾空白即可；内部空白属于 token 本身，不能一起清掉。
  // 空串与 null 折叠成同一个 null：两种空值若分开表达，读取端就要写两条判断，容易漏掉一条。
  const apiKey = value?.trim() ?? "";
  return apiKey || null;
}
