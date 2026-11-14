// 登录结果的持久化与登出清理。
//
// 登录写两样东西：共享凭据文件（凭据/账号身份/authSource）与个人 Provider 配置里的默认
// 模型选择。顺序固定为「凭据先、配置后」：凭据是运行时鉴权的唯一来源，配置只是默认档位的
// 意图；配置失败时登录本身仍算成功（调用方包装成 config_update_failed）。
// 登出必须只删旧值（deleteIfValues），不能整文件清空，否则会误删并发登录刚写入的新材料。
import {
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { dirname, join } from "node:path";
import type {
  CodingPlanProviderId,
  LogoutZCodeCliOptions,
  LogoutZCodeCliResult,
} from "./auth-login-contract.js";
import { readLegacyCliPersonalProviderConfig } from "./app/legacy-cli-personal-provider-config-importer.js";
import {
  hasStandaloneCodingPlanAccess,
  readStandaloneCodingPlanProviders,
  resolveStandaloneCodingPlanProvider,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "./app/standalone-account-provider-runtime.js";

/**
 * 持久化结果：mainModel 是 `${providerId}/${modelId}`，path 是实际被 patch 的个人 Provider 配置文件。
 * 两者都回给 CLI 展示，避免调用方自己再猜默认值或文件位置。
 */
export interface StandaloneCodingPlanPersistenceResult {
  readonly mainModel: string;
  readonly path: string;
}

/**
 * 把一次成功的登录固化成「可直接运行」的状态。
 *
 * 步骤与顺序：
 * 1. resolveStandaloneCodingPlanProvider：把入参 providerId 映射到真实 providerId/modelId；
 * 2. 凭据 saveMany：账号身份、authSource（oauth/manual）与可选 API Key 一次写入，
 *    账号身份 key 由 providerId + identity 派生，不同账号不会互相覆盖；
 * 3. 配置仓库：首次写入仍 importLegacy 保留旧用户 Provider，不能只写默认值丢历史配置；
 * 4. saveConfiguredDefault 后无论成败都 dispose 两个仓库（关闭轮询，不留文件句柄）。
 *
 * 失败语义：任一步抛错都原样上抛，由调用方决定映射成 credential_write_failed 还是
 * config_update_failed；这里不做部分回滚（凭据已写入时回滚会更让用户困惑）。
 */
export async function persistStandaloneCodingPlanConnection(input: {
  readonly accountIdentity: string;
  readonly apiKey?: string;
  readonly authSource?: "oauth";
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly env: EnvRecord;
  readonly personalProviderConfigPath?: string;
  readonly providerId: CodingPlanProviderId;
}): Promise<StandaloneCodingPlanPersistenceResult> {
  const configuredProvider = await resolveStandaloneCodingPlanProvider(input.providerId, input.env);
  const providerId = configuredProvider.providerId;
  const modelId = configuredProvider.modelId;
  const credentialKey = standaloneAccountProviderCredentialKey({
    providerId,
    accountIdentity: input.accountIdentity,
  });
  await input.credentialStore.saveMany({
    [standaloneAccountIdentityCredentialKey(providerId)]: input.accountIdentity,
    [standaloneAccountAuthSourceCredentialKey(providerId)]: input.authSource ?? "manual",
    ...(input.apiKey ? { [credentialKey]: input.apiKey } : {}),
  });
  const path =
    input.personalProviderConfigPath ??
    input.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ??
    join(dirname(input.credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 登录与运行时共享文件和事务；首次写入仍先保留旧用户 Provider，不能仅写默认值。
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: path,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({
    personalRepository,
  });
  // 配置仓库与模型选择仓库共享同一文件/事务；成功后 dispose 关闭轮询，失败也走 finally。
  try {
    await repository.saveConfiguredDefault({ providerId, modelId });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return {
    mainModel: `${providerId}/${modelId}`,
    path,
  };
}

// 仅做只读探测：不创建凭据文件。用于「是否已登录」等状态查询。
export async function hasConfiguredStandaloneCodingPlan(
  options: {
    credentialStore?: SharedZCodeCredentialStore;
    env?: EnvRecord;
  } = {},
): Promise<boolean> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  return hasStandaloneCodingPlanAccess(credentialStore, options.env ?? process.env);
}

/**
 * 清理当前环境的全部 Coding Plan 登录态。
 *
 * - 先按 env 解析所有已知 providerId（不看当前活动 Provider），登出必须覆盖全部痕迹；
 * - 只对「读到的非 null 值」执行 deleteIfValues：删除条件绑定旧值，
 *   并发登录刚写入的新值不会被误删；
 * - 动态 API Key 的派生 key 需要账号身份，仅 manual 来源可推导；oauth 来源跳过；
 * - 返回凭据文件路径，便于 CLI 提示「已清理哪个文件」。
 */
export async function logoutZCodeCli(
  options: LogoutZCodeCliOptions = {},
): Promise<LogoutZCodeCliResult> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const providerIds = (await readStandaloneCodingPlanProviders(options.env ?? process.env)).map(
    ({ providerId }) => providerId,
  );
  const identityKeys = providerIds.map(standaloneAccountIdentityCredentialKey);
  const sourceKeys = providerIds.map(standaloneAccountAuthSourceCredentialKey);
  const identities = await credentialStore.loadMany([...identityKeys, ...sourceKeys]);
  const dynamicApiKeyKeys = providerIds.flatMap((providerId) => {
    // OAuth 退出不能解密旧派生 Key；坏密文不应阻止清理当前登录态。
    if (identities[standaloneAccountAuthSourceCredentialKey(providerId)] !== "manual") return [];
    const identity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    return identity
      ? [
          standaloneAccountProviderCredentialKey({
            providerId,
            accountIdentity: identity,
          }),
        ]
      : [];
  });
  const keys = [
    ...Object.values(SHARED_ZCODE_CREDENTIAL_KEYS),
    ...identityKeys,
    ...sourceKeys,
    ...dynamicApiKeyKeys,
  ];
  const current = await credentialStore.loadMany(keys);
  // 快照-比较-删除：仅清理本次读到的旧值，避免与并发登录的 save 竞争。
  await credentialStore.deleteIfValues(
    Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
    ),
  );
  return {
    credentialsPath: credentialStore.filePath,
  };
}
