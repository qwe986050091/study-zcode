// INV-01 默认超时五分钟：守住位置 DEFAULT_LOGIN_TIMEOUT_MS；改错故障 无响应时长挂不退出。
// INV-02 外部取消与超时合并：守住位置 AbortSignal.any；改错故障 两条取消来源互相覆盖。
// INV-03 服务端过期时间收紧截止：守住位置 取较小值；改错故障 过期后仍在轮询。
// INV-04 每步之后复查取消：守住位置 throwIfAborted；改错故障 迟到的成功仍写入凭据。
// INV-05 无浏览器模式仍可轮询：守住位置 noBrowser 判断；改错故障 无头环境无法登录。
// INV-06 打开浏览器失败不阻断：守住位置 可选回调；改错故障 浏览器异常导致登录失败。
// INV-07 睡眠可被取消打断：守住位置 delay 的 signal；改错故障 退出后仍等待。
// INV-08 访问材料换取同样可取消：守住位置 waitWithAbort；改错故障 网络卡住无法退出。
// INV-09 登录身份按提供方分流：守住位置 providerId 判断；改错故障 跨提供方串用身份。
// INV-10 凭据写入失败单独归因：守住位置 credential_write_failed；改错故障 提示用户重新授权。
// INV-11 配置写入失败单独归因：守住位置 config_update_failed；改错故障 用户误以为登录未成功。
// INV-12 BigModel 入口固定提供方：守住位置 返回值覆盖；改错故障 继承选项里的默认值。
// INV-13 手填密钥先裁剪再校验：守住位置 trim；改错故障 纯空白密钥被接受。
// INV-14 密钥身份由摘要派生：守住位置 createStandaloneAccountIdentityFromSecret；改错故障 同一密钥落到不同槽位。
// INV-15 端点地址不在登录路径硬编码：守住位置 运行时派生；改错故障 私有化环境无法登录。
// INV-16 网络出口沿用用户配置：守住位置 createDefaultHttpClient；改错故障 登录绕过代理。
// INV-17 解析器可由调用方注入：守住位置 resolver 选项；改错故障 测试无法替换端点。
// INV-18 计时器在收尾时清理：守住位置 finally 分支；改错故障 进程被悬挂定时器拖住。
//
// 模块职责：实现 OAuth 轮询登录、BigModel 专用入口与手填密钥三条配置路径。
// 状态所有权：截止时间、计时器与信号均为单次登录调用的局部状态。
// 阅读顺序：先看超时与信号合并，再看轮询与写凭据，最后看两个辅助入口。
// 登录命令实现：OAuth 初始化 → 打开浏览器 → 轮询 ready → 换取访问材料 → 凭据落盘 → 默认模型配置。
// 外部取消（abortSignal）与总超时合并成同一个 signal；所有网络/睡眠都可被取消，
// 且每个关键步骤之后都重新检查 signal，保证迟到的成功响应不会在取消后写入凭据。
// 凭据写入与配置更新分两步独立报错（credential_write_failed / config_update_failed），
// 因为此时登录已经成功，不应提示用户重新授权。
export { hasConfiguredStandaloneCodingPlan, logoutZCodeCli } from "./auth-login-persistence.js";
import {
  persistStandaloneCodingPlanConnection,
  type StandaloneCodingPlanPersistenceResult,
} from "./auth-login-persistence.js";
export { ZCodeCliLoginError } from "./auth-login-contract.js";
export type {
  CodingPlanProviderId,
  LoginZCodeCliOptions,
  LoginZCodeCliResult,
  LoginBigmodelCodingPlanOptions,
  LoginBigmodelCodingPlanResult,
  ConfigureCodingPlanApiKeyOptions,
  ConfigureCodingPlanApiKeyResult,
  LogoutZCodeCliOptions,
  LogoutZCodeCliResult,
} from "./auth-login-contract.js";
import {
  ZCodeCliLoginError,
  type CodingPlanProviderId,
  type LoginZCodeCliOptions,
  type LoginZCodeCliResult,
  type LoginBigmodelCodingPlanOptions,
  type LoginBigmodelCodingPlanResult,
  type ConfigureCodingPlanApiKeyOptions,
  type ConfigureCodingPlanApiKeyResult,
} from "./auth-login-contract.js";
import {
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  createCliOAuthClient,
  createCliOAuthPollToken,
  openUrlInBrowser,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type CliOAuthClient,
} from "@zcode/adapters";
import { createConfig } from "@zcode/adapters/config";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import type { EnvRecord } from "@zcode/adapters/model";
import { buildZCodeEndpointUrls, resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import { setTimeout as delay } from "node:timers/promises";
import { createStandaloneAccountIdentityFromSecret } from "./app/standalone-account-provider-runtime.js";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";
import { pollUntilReady } from "./auth-login-polling.js";

// deadline 会先按默认 5 分钟计时；拿到 init 的 expires_at 后必须收紧到两者较小值，
// 否则授权码过期后仍在轮询，只会拿到 auth_failed/超时。
// DEFAULT_LOGIN_TIMEOUT_MS 只是初值，最终 deadline 取它与服务端窗口的较小者。
// initData.expires_at 到达后重算 remainingMs，并把 timer 重置到该窗口。
// 授权码过期后 pollUntilReady 只会返回 auth_failed 或超时。
// options.timeoutMs 可覆盖默认值，测试里常用它缩短等待。
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Z.ai 与 BigModel 共用服务端轮询登录：init 拿授权地址，浏览器授权后轮询到 ready，
 * 再解析项目访问材料并写入凭据与默认模型。OAuth 登录不落盘派生 API Key，
 * 运行时按 `authSource: "oauth"` 用访问令牌换取请求凭据。
 */
// loginZCodeCli 一次调用内先 init 再 poll，最后 resolveCodingPlanMaterial。
// init 只取 authorize_url 与 expires_at，不写任何凭据。
// pollUntilReady 阻塞到 ready 或被 abort，期间只上报 onPollStatus。
// resolveCodingPlanMaterial 的 accessToken 来自 readyData，不接受外部传入。
export async function loginZCodeCli(
  options: LoginZCodeCliOptions = {},
): Promise<LoginZCodeCliResult> {
  // credentialStore、oauthClient、httpClient 都由 options 注入，缺省才回落到工厂。
  // 先统一解析 env、providerId、now、timeoutMs 的缺省，函数体内不再重复。
  // now 可注入，deadline 计算不直接调用 Date.now。
  // 提供方缺省为 zai。
  const env = options.env ?? process.env;
  const providerId = options.providerId ?? "zai";
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadlineMs = now() + timeoutMs;
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = () =>
    new ZCodeCliLoginError("auth_timeout", "Authorization timed out. Please retry login.");
  let timer = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  try {
    throwIfAborted(signal);
    const pollToken = options.pollToken ?? createCliOAuthPollToken();
    const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
    const oauthClient = createOAuthClient(options, env);
    const initData = await waitWithAbort(oauthClient.init({ pollToken }, { signal }), signal);
    // remainingMs 用 min(deadline, 服务端 expires_at) 重算，并把 timer 重置到该窗口。
    const remainingMs = Math.min(deadlineMs, initData.expires_at * 1_000) - now();
    if (remainingMs <= 0) throw timeoutError();
    clearTimeout(timer);
    timer = setTimeout(() => timeoutController.abort(timeoutError()), remainingMs);
    await options.onAuthorizeUrl?.(initData);
    throwIfAborted(signal);
    // noBrowser 时跳过打开步骤，但仍可正常轮询（用户自行在其它设备完成授权）。
    const browser = options.noBrowser
      ? undefined
      : await waitWithAbort(
          (options.openBrowser ?? openUrlInBrowser)(initData.authorize_url),
          signal,
        );
    if (browser) await options.onBrowserOpen?.(browser);
    const readyData = await pollUntilReady({
      abortSignal: signal,
      initData,
      now,
      oauthClient,
      onPollStatus: options.onPollStatus,
      pollToken,
      sleep: options.sleep ?? ((ms) => delay(ms, undefined, { signal })),
      timeoutMs: Math.max(0, deadlineMs - now()),
      createError: (code) =>
        code === "auth_timeout"
          ? timeoutError()
          : new ZCodeCliLoginError(code, "Authorization failed. Please retry login."),
    });
    // 用轮询拿到的 access token 向服务端换取项目级访问材料；这一步同样可取消。
    const material = await waitWithAbort(
      resolveCodingPlanMaterial({
        accessToken: readyData.accessToken,
        env,
        httpClient: options.httpClient,
        family: providerId,
        resolver: options.apiKeyResolver,
        signal,
      }),
      signal,
    );
    // 已取消或已超时的登录不能把迟到的 ready 响应写入凭据。
    throwIfAborted(signal);
    // Z.ai 以账号用户 ID 作为连接身份；BigModel 的项目令牌按组织与项目签发，
    // 连接身份沿用组织与项目的稳定摘要，与运行时的令牌缓存范围一致。
    const accountIdentity =
      providerId === "zai"
        ? readyData.user.user_id
        : createStandaloneAccountIdentityFromSecret(
            JSON.stringify([material.organizationId, material.projectId]),
          );
    // 写凭据：zai 走专门的 access+jwt+user 组合；bigmodel 需同时记录 activeProvider、
    // JWT、访问令牌、可选 refresh token 与用户信息，运行时据此决定刷新策略。
    try {
      if (providerId === "zai") {
        await credentialStore.saveZaiLoginCredentials({
          accessToken: readyData.accessToken,
          jwtToken: readyData.token,
          user: readyData.user,
        });
      } else {
        const displayName = readyData.user.name || readyData.user.email || readyData.user.user_id;
        await credentialStore.saveMany({
          [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: providerId,
          [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: readyData.token,
          [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelAccessToken]: readyData.accessToken,
          ...(readyData.refreshToken
            ? { [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelRefreshToken]: readyData.refreshToken }
            : {}),
          [SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelUserInfo]: JSON.stringify({
            id: accountIdentity,
            username: displayName,
            displayName,
            rawProfile: readyData.user,
          }),
        });
      }
    } catch (error) {
      throw new ZCodeCliLoginError(
        "credential_write_failed",
        "Login succeeded but writing credentials failed.",
        { cause: error },
      );
    }
    throwIfAborted(signal);
    // 配置写入阶段：凭据已落盘，此步失败映射为 config_update_failed 而非重新登录。
    let configPatch: StandaloneCodingPlanPersistenceResult;
    try {
      configPatch = await persistStandaloneCodingPlanConnection({
        accountIdentity,
        authSource: "oauth",
        credentialStore,
        env,
        personalProviderConfigPath: options.personalProviderConfigPath,
        providerId,
      });
    } catch (error) {
      throw new ZCodeCliLoginError(
        "config_update_failed",
        "Login succeeded but updating ZCode config failed.",
        { cause: error },
      );
    }
    return {
      ...(browser ? { browser } : {}),
      configPath: configPatch.path,
      credentialsPath: credentialStore.filePath,
      model: configPatch.mainModel,
      providerId,
      user: readyData.user,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * BigModel 专用入口：仅把 providerId 固定为 bigmodel，其余流程完全复用 loginZCodeCli。
 * 返回值再次覆盖 providerId，避免调用方误以为继承了 option 里的默认值。
 */
// loginBigmodelCodingPlan 只把 providerId 固定为 "bigmodel"。
// 其余 options 用展开原样交给 loginZCodeCli，不做二次加工。
// 返回对象再把 providerId 覆盖一次，不依赖被测函数的透传。
// 这样调用方拿到的 providerId 一定等于 "bigmodel"，不会被默认值污染。
export async function loginBigmodelCodingPlan(
  options: LoginBigmodelCodingPlanOptions = {},
): Promise<LoginBigmodelCodingPlanResult> {
  return {
    ...(await loginZCodeCli({ ...options, providerId: "bigmodel" })),
    providerId: "bigmodel",
  };
}

/**
 * 手填 API Key 的接入口（不经 OAuth）：trim 后为空直接拒绝，不写任何凭据。
 *
 * 连接身份由 API Key 摘要派生（createStandaloneAccountIdentityFromSecret），
 * 这样同一把 Key 多次配置会命中同一套凭据槽位，不同 Key 不会互相覆盖。
 * 失败会原样抛出（配置失败），本函数不再额外包装错误码。
 */
export async function configureCodingPlanApiKey(
  options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ZCodeCliLoginError("config_update_failed", "API key must not be empty.");
  }
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const configPatch = await persistStandaloneCodingPlanConnection({
    accountIdentity: createStandaloneAccountIdentityFromSecret(apiKey),
    apiKey,
    credentialStore,
    env: options.env ?? process.env,
    personalProviderConfigPath: options.personalProviderConfigPath,
    providerId: options.providerId,
  });
  return {
    configPath: configPatch.path,
    model: configPatch.mainModel,
    providerId: options.providerId,
  };
}

// 构造 CLI OAuth 客户端：baseUrl 由运行时端点派生（支持测试/私有化环境），
// providerId 默认 zai；未注入 httpClient 时使用按 env 网络配置构造的默认客户端。
function createOAuthClient(options: LoginZCodeCliOptions, env: EnvRecord): CliOAuthClient {
  return createCliOAuthClient({
    baseUrl:
      options.baseUrl ?? buildZCodeEndpointUrls(resolveCliZCodeEndpointOrigin(env)).apiBaseUrl,
    providerId: options.providerId ?? "zai",
    httpClient: options.httpClient ?? createDefaultHttpClient(env),
  });
}

// 单独的薄封装，便于测试替换运行时端点解析；不要在登录路径内硬编码域名。
function resolveCliZCodeEndpointOrigin(env: EnvRecord): string {
  return resolveRuntimeZCodeEndpointOrigin(env);
}

// 默认 HTTP 客户端：代理、noProxy、CA 与超时全部来自用户配置的 network 段，
// 登录请求与后续运行时请求应尽量保持同一套网络出口语义。
function createDefaultHttpClient(env: EnvRecord) {
  const config = createConfig({ env });
  return createNodeHttpClientAdapter({
    env,
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}

// 访问材料解析：resolver 可由调用方注入（测试/自建端点），否则按默认网络配置新建；
// 无论哪种来源都透传 signal，保证取消能中断换取过程。
async function resolveCodingPlanMaterial(input: {
  accessToken: string;
  env: EnvRecord;
  httpClient?: Parameters<typeof createCodingPlanApiKeyResolver>[0]["httpClient"];
  family: CodingPlanProviderId;
  signal?: AbortSignal;
  resolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
}) {
  const resolver =
    input.resolver ??
    createCodingPlanApiKeyResolver({
      httpClient: input.httpClient ?? createDefaultHttpClient(input.env),
    });
  return resolver.resolveMaterial(
    {
      accessToken: input.accessToken,
      family: input.family,
    },
    { signal: input.signal },
  );
}
