// INV-01 目录每次现读不缓存：守住位置 读取入口；改错故障 登录流程看到旧目录。
// INV-02 注入投影不再读文件：守住位置 配置分支；改错故障 测试与线上走不同源。
// INV-03 只收完整条目：守住位置 四条件判断；改错故障 缺模型条目进入登录列表。
// INV-04 文件模式必须释放源：守住位置 最终清理；改错故障 句柄泄漏。
// INV-05 家族必须唯一：守住位置 数量判断；改错故障 静默取第一个。
// INV-06 身份键拒绝空标识：守住位置 非空判断；改错故障 生成跨 Provider 串号键。
// INV-07 来源键不做去空白：守住位置 文档约定；改错故障 键口径与写入端不一致。
// INV-08 手工身份不可逆：守住位置 摘要算法；改错故障 明文密钥进凭据键。
// INV-09 三段读取缩小范围：守住位置 分批读取；改错故障 手工模式读到 OAuth 密文。
// INV-10 缺身份显式离线：守住位置 空值分支；改错故障 账号断开后仍在线。
// INV-11 缺凭据显式离线：守住位置 授权判断；改错故障 删除凭据后 Provider 不退出。
// INV-12 目录失败向上抛：守住位置 不捕获；改错故障 登录误判为无套餐。
// INV-13 访问判定任一在线：守住位置 存在判断；改错故障 多 Provider 时误判未登录。
// INV-14 请求期先校验中断：守住位置 首尾中断检查；改错故障 取消后仍发请求。
// INV-15 请求身份必须匹配模式：守住位置 访问判断；改错故障 非套餐账号套用桥接。
// INV-16 迟到签发复核登录态：守住位置 三重读取；改错故障 已退出账号仍拿到令牌。
// INV-17 来源不明拒绝猜测：守住位置 末尾抛错；改错故障 旧格式被当 OAuth。
// INV-18 手工模式拒绝范围参数：守住位置 参数判断；改错故障 手工模式接受 OAuth 指纹。
//
// 模块职责：无托管账号 Profile 的独立登录态 Provider 运行时桥。
// 状态所有权：身份与凭据归凭据库，本模块只做投影与请求期解析。
// 阅读顺序：先看目录解析与键口径，再看离线快照，最后看请求期端口。
/**
 * standalone-account-provider-runtime：独立（无托管账号 Profile）登录态的 Provider 运行时桥。
 * 定位：读内建 Provider 目录 → 从 Credential Store 取账号身份与授权来源 → 生成
 *   AccountProviderConfigSnapshot（entitled 真/假）供 Registry 判断 Provider 是否在线；
 *   另提供请求期 header 端口：按来源（oauth/manual）解析 API Key，并复核账号是否仍是同一登录态。
 * 凭据键口径（全部是 Standalone Credential Store 私有键，不进 Provider Config / Model / Protocol）：
 *   account-provider:<id>:identity、:auth-source、
 *   account-provider:coding-plan:<id>:account:<encodeURIComponent(identity)>:api-key。
 * 失败语义：目录缺失 / 家族不唯一 / 凭据缺失都抛稳定 message；请求期在 abort、身份失效、
 *   来源不明时抛 project_token_* 稳定码，禁止"猜一个来源"回退。
 * 不变量：entitled 只有显式 true 才在线——缺成员表示"不覆盖"，无法表达"账号已断开"。
 */
import { createHash } from "node:crypto";
import {
  createCodingPlanApiKeyResolver,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import { createConfig } from "@zcode/adapters/config";
import type { ProviderRuntimeHeadersPort } from "@zcode/core";
import {
  createAccountProviderConfigSnapshot,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderConfigSnapshot,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import type { ProviderFamilyDomain } from "@zcode/shared";

/** 一个可用于独立登录的计划型 Provider：家族 + 默认模型 + 目录里的 providerId。 */
export interface StandaloneCodingPlanProvider {
  readonly family: ProviderFamilyDomain;
  readonly modelId: string;
  readonly providerId: string;
}

/** 只读目录投影：每次调用都重新解析 Built-in Config，不缓存（登录流程需要看到最新目录）。 */
export async function readStandaloneCodingPlanProviders(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StandaloneCodingPlanProvider[]> {
  return (await readStandaloneCodingPlanCatalog(env)).providers;
}

/**
 * 目录解析核心：注入 snapshot 时直接投影；否则读 env 指定的 Built-in Config 文件。
 * 只收 access.type=zhipu-account && mode=individual-coding-plan && accountType && 非空 modelId 的条目。
 * 文件模式必须 dispose 源（watch:false 也会持有句柄）：finally 保证异常路径同样释放。
 */
async function readStandaloneCodingPlanCatalog(
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<{
  readonly zcodeBuiltinRevision: string;
  readonly providers: readonly StandaloneCodingPlanProvider[];
}> {
  if (config)
    return {
      zcodeBuiltinRevision: config.revision,
      providers: config.providers.entries().flatMap(([providerId, provider]) => {
        const access = provider.access;
        const modelId = provider.builtinModelIds?.find((candidate) => candidate.trim())?.trim();
        return access?.type === "zhipu-account" &&
          access.mode === "individual-coding-plan" &&
          access.accountType &&
          modelId
          ? [{ family: access.accountType, modelId, providerId }]
          : [];
      }),
    };
  const filePath = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!filePath) {
    throw new Error(`${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required for login`);
  }
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: filePath,
    watch: false,
  });
  try {
    const snapshot = await source.read();
    return readStandaloneCodingPlanCatalog(env, snapshot);
  } finally {
    source.dispose();
  }
}

/** 按家族解析唯一 Provider：0 条或多条都抛，不做"取第一个"的猜测（目录是产品契约，必须唯一）。 */
export async function resolveStandaloneCodingPlanProvider(
  family: ProviderFamilyDomain,
  env: Readonly<Record<string, string | undefined>>,
): Promise<StandaloneCodingPlanProvider> {
  const matches = (await readStandaloneCodingPlanProviders(env)).filter(
    (provider) => provider.family === family,
  );
  if (matches.length !== 1) {
    throw new Error(
      `ZCode Built-in Config 必须为 ${family} 声明唯一 Individual Coding Plan Provider`,
    );
  }
  return matches[0]!;
}

/** 身份键：trim 后必须非空，否则抛（避免生成 ":identity" 造成跨 Provider 串号）。 */
export function standaloneAccountIdentityCredentialKey(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) throw new Error("Standalone Account Provider ID 不能为空");
  return `account-provider:${normalized}:identity`;
}

/** 授权来源键（值 "oauth" | "manual"）；此处不做 trim 校验，调用方必须传规范化后的 providerId。 */
export function standaloneAccountAuthSourceCredentialKey(providerId: string): string {
  return `account-provider:${providerId}:auth-source`;
}
function oauthCredentialKey(family: ProviderFamilyDomain): string {
  return family === "zai"
    ? SHARED_ZCODE_CREDENTIAL_KEYS.zaiAccessToken
    : SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelAccessToken;
}

/** Standalone Credential Store 私有键；不得进入 Provider Config、Model 或 Protocol。 */
export function standaloneAccountProviderCredentialKey(input: {
  readonly providerId: string;
  readonly accountIdentity: string;
}): string {
  const providerId = input.providerId.trim();
  const accountIdentity = input.accountIdentity.trim();
  if (!providerId) throw new Error("Standalone Account Provider ID 不能为空");
  if (!accountIdentity) throw new Error("Standalone Account Identity 不能为空");
  return `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

/** 没有账号 Profile 的手工 Key 登录使用稳定、不可逆的连接身份。 */
/** 注意：返回值会进入凭据键（经 encodeURIComponent），算法变更等于所有手工 Key 登录失效。 */
export function createStandaloneAccountIdentityFromSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) throw new Error("Standalone Account Secret 不能为空");
  return `key-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

/**
 * 账号 Overlay 快照：目录 providers × 已存身份 × 授权来源 → entitled 真/假。
 * 三段 loadMany 分开（身份 → 来源 → 凭据）：OAuth 不读旧 Key，manual 也不碰 OAuth 密文，缩小读取面。
 * 缺身份或缺凭据都显式写 entitled=false（而不是省略成员），Registry 才能感知"账号已断开"。
 * 失败语义：目录读取失败上抛；凭据读取缺失只降级为 entitled=false，不报错。
 */
export async function readStandaloneAccountProviderConfigSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<AccountProviderConfigSnapshot> {
  const catalog = await readStandaloneCodingPlanCatalog(env, config);
  const configuredProviders = catalog.providers;
  const identityKeys = configuredProviders.map(({ providerId }) =>
    standaloneAccountIdentityCredentialKey(providerId),
  );
  const identities = await credentialStore.loadMany(identityKeys);
  const candidates = configuredProviders.flatMap(({ family, providerId }) => {
    const accountIdentity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    if (!accountIdentity) return [];
    const credentialKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity,
    });
    return [{ accountIdentity, credentialKey, family, providerId }] as const;
  });
  const sources = await credentialStore.loadMany(
    candidates.map(({ providerId }) => standaloneAccountAuthSourceCredentialKey(providerId)),
  );
  // 先按来源选择读取范围；OAuth 不解密旧 Key，手工模式也不依赖无关 OAuth 密文。
  const credentials = await credentialStore.loadMany(
    candidates.map(({ credentialKey, providerId, family }) =>
      sources[standaloneAccountAuthSourceCredentialKey(providerId)] === "manual"
        ? credentialKey
        : oauthCredentialKey(family),
    ),
  );
  const candidateByProviderId = new Map(
    candidates.map((candidate) => [candidate.providerId, candidate]),
  );
  const providers = new ProviderConfigMap(
    configuredProviders.map(({ family, providerId }) => {
      const candidate = candidateByProviderId.get(providerId);
      const source = sources[standaloneAccountAuthSourceCredentialKey(providerId)];
      const requestCredentialKey =
        source === "manual" ? candidate?.credentialKey : oauthCredentialKey(family);
      const authorized = Boolean(requestCredentialKey && credentials[requestCredentialKey]?.trim());
      if (!candidate || !authorized) {
        // Bug 根因：账号 Overlay 缺少成员表示“不覆盖”，不能表达账号已断开；必须显式
        // entitled=false，才能让 Built-in 账号 Provider 在凭据删除后从 Registry 退出。
        return [
          providerId,
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: false }),
          }),
        ] as const;
      }
      return [
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
        }),
      ] as const;
    }),
  );
  return createAccountProviderConfigSnapshot(catalog.zcodeBuiltinRevision, providers);
}

/** 任一 Provider entitled=true 即视为已登录；每次现算 snapshot，不缓存。 */
export async function hasStandaloneCodingPlanAccess(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return (await readStandaloneAccountProviderConfigSnapshot(credentialStore, env)).providers
    .entries()
    .some(([, provider]) =>
      provider.access?.type === "zhipu-account" ? provider.access.entitled === true : false,
    );
}

/**
 * 造"请求期注入凭据"的 header 端口（供 Provider Runtime 调用）。
 * 输入：credentialStore 需具备 load/loadMany/save/delete；env 决定代理/CA/超时；resolver 可注入以便测试。
 * 输出：shouldRefreshBeforeModelRequest 恒 true + refreshBeforeModelRequest + clearProjectTokens /
 *   invalidateChangedCredentials 两个缓存失效入口。
 * 顺序语义：先判来源（oauth/manual）→ 取对应密文 → OAuth 经 resolver 换 project token →
 *   签发后再复核身份/来源仍是同一登录态（迟到签发不得覆盖已切换或已退出的登录）。
 * 失败语义：abort 透传；身份/家族缺失 → account_required；无登录态 → login_required；
 *   期望 scope 不符或被拒指纹 → scope_invalidated；来源不明一律 login_required（绝不猜回退）。
 * 不变量：manual 请求若携带 expectedAccountScope 或 rejectedFingerprint 一律 scope_invalidated。
 */
export function createStandaloneProviderRuntimeHeadersPort(
  credentialStore: Pick<SharedZCodeCredentialStore, "load" | "loadMany" | "save" | "delete">,
  env: Readonly<Record<string, string | undefined>>,
  injectedResolver?: ReturnType<typeof createCodingPlanApiKeyResolver>,
): ProviderRuntimeHeadersPort & {
  clearProjectTokens(): void;
  invalidateChangedCredentials(): Promise<void>;
} {
  const config = createConfig({ env }).config;
  const resolver =
    injectedResolver ??
    createCodingPlanApiKeyResolver({
      httpClient: createNodeHttpClientAdapter({
        env,
        proxyUrl: config.network.httpProxy,
        noProxy: config.network.noProxy,
        caCertFile: config.network.caCertFile,
        timeoutMs: config.network.timeout,
      }),
      locationStore: credentialStore,
      observe: (event) => console.warn("[project-access-token]", event),
    });
  // 记录"本次请求实际用到哪些凭据键、值是什么"：invalidateChangedCredentials 据此判断
  // 登录是否已变更；clearProjectTokens 与变更检测都会整体丢弃（避免把旧 Key 当缓存复用）。
  const authSnapshots = new Map<string, string>();
  return {
    clearProjectTokens() {
      authSnapshots.clear();
      resolver.clear();
    },
    async invalidateChangedCredentials() {
      const values = await credentialStore.loadMany([...authSnapshots.keys()]);
      if ([...authSnapshots].some(([key, value]) => values[key]?.trim() !== value)) {
        authSnapshots.clear();
        resolver.clear();
      }
    },
    shouldRefreshBeforeModelRequest() {
      return true;
    },
    async refreshBeforeModelRequest(input) {
      input.abortSignal?.throwIfAborted();
      const providerId = input.providerId.trim();
      const access = input.accountAccess;
      if (!access || access.mode !== "individual-coding-plan") {
        throw new Error(`Standalone Account Provider 请求身份无效: ${providerId}`);
      }
      const currentIdentity = (
        await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId))
      )?.trim();
      if (!currentIdentity)
        throw new Error(`Standalone Account Provider 凭据已经失效: ${providerId}`);
      const family = access.accountType;
      if (!family) throw new Error("project_token_account_required");
      const sourceKey = standaloneAccountAuthSourceCredentialKey(providerId);
      const source = await credentialStore.load(sourceKey);
      const oauthKey = oauthCredentialKey(family);
      const oauth =
        source === "manual" ? undefined : (await credentialStore.load(oauthKey))?.trim();
      // 来源缺省但确有 OAuth 密文时按 oauth 处理（兼容未写 auth-source 的旧数据）；
      // 显式 manual 则永不读、永不使用 OAuth 密文。
      const useOAuth = source === "oauth" || (source !== "manual" && Boolean(oauth));
      let apiKey: string | undefined;
      let apiKeyId: string | undefined;
      let accountScope: string | undefined;
      if (useOAuth) {
        if (!oauth) {
          resolver.clear();
          throw new Error("project_token_login_required");
        }
        accountScope = createHash("sha256")
          .update(JSON.stringify([providerId, family, currentIdentity, oauth]))
          .digest("hex");
        if (
          (input.expectedAccountScope && input.expectedAccountScope !== accountScope) ||
          (input.rejectedProjectTokenFingerprint && !input.expectedAccountScope)
        )
          throw new Error("project_token_scope_invalidated");
        if (source !== "oauth") await credentialStore.save(sourceKey, "oauth");
        authSnapshots.set(oauthKey, oauth);
        authSnapshots.set(standaloneAccountIdentityCredentialKey(providerId), currentIdentity);
        authSnapshots.set(sourceKey, "oauth");
        const material = await resolver.resolveMaterial(
          {
            family,
            accessToken: oauth,
            accountIdentity: currentIdentity,
            rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint,
            trace: input.traceContext,
          },
          { signal: input.abortSignal },
        );
        apiKey = material.token;
        apiKeyId = material.apiKeyId;
        // 请求期只交付当前账号的 Token；迟到签发不能覆盖已退出/切换的登录态。
        if (
          (await credentialStore.load(oauthKey))?.trim() !== oauth ||
          (
            await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId))
          )?.trim() !== currentIdentity ||
          (await credentialStore.load(sourceKey)) !== "oauth"
        ) {
          resolver.clear();
          throw new Error("project_token_scope_invalidated");
        }
      } else if (source === "manual") {
        if (input.expectedAccountScope || input.rejectedProjectTokenFingerprint)
          throw new Error("project_token_scope_invalidated");
        apiKey = (
          await credentialStore.load(
            standaloneAccountProviderCredentialKey({
              providerId,
              accountIdentity: currentIdentity,
            }),
          )
        )?.trim();
      }
      if (!useOAuth && source !== "manual") {
        // 旧格式无法区分手工和 OAuth 派生 Key；无登录态时要求重新选择登录方式，禁止猜测回退。
        resolver.clear();
        throw new Error("project_token_login_required");
      }
      input.abortSignal?.throwIfAborted();
      if (!apiKey) {
        throw new Error(`Standalone Account Provider 缺少请求凭据: ${providerId}`);
      }
      return {
        headersApplied: true,
        requestAuth: {
          apiKey,
          ...(apiKeyId ? { apiKeyId } : {}),
          ...(accountScope ? { accountScope } : {}),
        },
      };
    },
  };
}
