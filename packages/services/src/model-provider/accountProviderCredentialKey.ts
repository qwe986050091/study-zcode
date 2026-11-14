// Account Provider 凭据的物理 key 生成器：把账号 scope 编码成可持久化的唯一字符串。
// INV-01：key 只由本函数生成，其它模块不得手写前缀；格式变化会让已存凭据全部失配。
export type AccountProviderCredentialScope = {
  readonly providerId: string;
  readonly accountIdentity: string;
} & (
  | { readonly planKind: "start-plan" | "individual-coding-plan" }
  | {
      readonly planKind: "team-coding-plan";
      readonly productId: string;
      readonly organizationId: string;
      readonly projectId: string;
    }
);

/**
 * Credential Store 的私有物理 key。
 *
 * 旧账号标识同时承担 Config 身份和凭据缓存键，导致账号身份扩散到
 * Provider、Protocol 与 UI。物理键现在只留在拥有账号身份的 Services 凭据边界。
 */
export function accountProviderCredentialKey(input: AccountProviderCredentialScope): string {
// 必填字段先 trim 再判空：空串会生成 account-provider::account::…:api-key 这种无法区分账号的 key。
  // 必填字段统一走 required：它返回 trim 后的值，下面所有拼接都用归一后的结果。
  const providerId = required(input.providerId, "Provider ID");
  const accountIdentity = required(input.accountIdentity, "账号身份");
// 团队与个人使用不同前缀：团队包含 product/organization/project 三元组，个人只有 planKind+providerId；
// 两者不能共用 key，否则团队切换项目时会复用到旧项目的令牌。
  const scope =
    // 团队三元组逐项 required 后 map encodeURIComponent：任一项含冒号都会让 key 的分段结构错位。
    input.planKind === "team-coding-plan"
      ? [
          "team",
          providerId,
          required(input.productId, "Team Product ID"),
          required(input.organizationId, "Team Organization ID"),
          required(input.projectId, "Team Project ID"),
        ]
          // 编码而不是转义：encodeURIComponent 保证冒号只作为段分隔符出现，账号身份才可安全嵌入。
          .map(encodeURIComponent)
          .join(":")
      : `${input.planKind === "start-plan" ? "start-plan" : "coding-plan"}:${providerId}`;
  // account-provider: 前缀与 :api-key 后缀是持久化契约：改名等于已存凭据全部失配。
  return `account-provider:${scope}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

function required(value: string, label: string): string {
  // 只 trim 不编码：编码留给调用点按段处理，避免同一字段被编码两次。
  // 失败后果：空值必须在这里抛错，不能退化成默认值或空串——那会让两个不同账号生成同一个 key，凭据互相覆盖。
  const normalized = value.trim();
  if (!normalized) throw new Error(`Account Provider 缺少${label}`);
  return normalized;
}
