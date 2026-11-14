import type {
  createCodingPlanApiKeyResolver,
  createCliOAuthClient,
  BrowserOpenResult,
  CliOAuthInitData,
  CliOAuthPollData,
  CliOAuthUser,
  SharedZCodeCredentialStore,
} from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";

// 登录/配置/登出三条 CLI 命令的公共契约面：只描述输入输出、依赖注入与稳定错误码，
// 不含任何网络或磁盘实现。实现分别落在 auth-login.ts（OAuth 轮询）与 auth-login-persistence.ts。

export type CodingPlanProviderId = "bigmodel" | "zai";

export interface LoginZCodeCliOptions {
  /** 目标 Provider；缺省 zai。loginBigmodelCodingPlan 只是把它强制为 bigmodel。 */
  providerId?: CodingPlanProviderId;
  /** 调用方取消信号；与内部总超时合并成一个 signal，任一侧触发都停止后续步骤。 */
  abortSignal?: AbortSignal;
  /** 注入的访问材料解析器（测试/自建端点）；缺省按 provider 家族向服务端换取。 */
  apiKeyResolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
  /** OAuth 服务基址；缺省按 env 解析正式/测试环境，不硬编码域名。 */
  baseUrl?: string;
  /** 共享凭据存储；缺省按 env 创建。登录/登出必须操作同一份文件。 */
  credentialStore?: SharedZCodeCredentialStore;
  /** 环境变量表；缺省 process.env。端点、代理、CA 与遥测开关都从这里派生。 */
  env?: EnvRecord;
  /** HTTP 客户端（代理/CA/超时）；缺省按 env 的 network 配置构造。 */
  httpClient?: Parameters<typeof createCliOAuthClient>[0]["httpClient"];
  /** 只输出授权 URL、不自动开浏览器（headless/SSH 场景）。 */
  noBrowser?: boolean;
  /** 时间源，测试可注入；用于计算 deadline 与比较 init 的 expires_at。 */
  now?: () => number;
  /** init 返回后回调授权地址，由调用方决定如何展示。 */
  onAuthorizeUrl?: (data: CliOAuthInitData) => void | Promise<void>;
  /** 浏览器打开结果回调；成功/失败都交给调用方观察。 */
  onBrowserOpen?: (result: BrowserOpenResult) => void | Promise<void>;
  /** 每次轮询的状态回调，用于展示「等待授权 / 已授权」。 */
  onPollStatus?: (data: CliOAuthPollData) => void | Promise<void>;
  /** 浏览器打开实现；缺省调用 adapters 的 openUrlInBrowser。 */
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  /** 固定的轮询令牌；缺省随机生成，仅测试需要固定值。 */
  pollToken?: string;
  /** sleep 实现；缺省 timers/promises.delay 且同样受 signal 取消。 */
  sleep?: (ms: number) => Promise<void>;
  /** 总超时，缺省 5 分钟；实际 deadline 还会被服务端给的 expires_at 收紧。 */
  timeoutMs?: number;
  /** 个人 Provider 配置文件路径；缺省按 env 或凭据文件同目录推导。 */
  personalProviderConfigPath?: string;
}

export interface LoginZCodeCliResult {
  /** 浏览器打开结果；noBrowser 或未尝试打开时缺席。 */
  browser?: BrowserOpenResult;
  /** 写入默认模型选择后的个人 Provider 配置文件路径。 */
  configPath: string;
  /** 凭据存储文件路径（实际落盘的登录材料位置）。 */
  credentialsPath: string;
  /** 已设为默认的模型，格式 `${providerId}/${modelId}`。 */
  model: string;
  providerId: CodingPlanProviderId;
  /** 服务端返回的账号信息；仅用于展示，不作为后续鉴权依据。 */
  user: CliOAuthUser;
}

// BigModel 与 Z.ai 共用服务端轮询登录，只是 providerId 固定为 bigmodel。
export type LoginBigmodelCodingPlanOptions = Omit<LoginZCodeCliOptions, "providerId">;
export type LoginBigmodelCodingPlanResult = LoginZCodeCliResult & { providerId: "bigmodel" };

export interface ConfigureCodingPlanApiKeyOptions {
  /** 用户手填的 API Key；会先 trim，空值直接按配置失败拒绝。 */
  apiKey: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  personalProviderConfigPath?: string;
  providerId: CodingPlanProviderId;
}

export interface ConfigureCodingPlanApiKeyResult {
  configPath: string;
  /** 已设为默认的模型，格式 `${providerId}/${modelId}`。 */
  model: string;
  providerId: CodingPlanProviderId;
}

// 登出输入：只需定位凭据存储，不要求调用方知道具体登录过哪个 Provider（会遍历全部）。
export interface LogoutZCodeCliOptions {
  /** 共享凭据存储；缺省按 env 创建。 */
  credentialStore?: SharedZCodeCredentialStore;
  /** 环境变量表；用于解析要清理的 Provider 范围。 */
  env?: EnvRecord;
}

export interface LogoutZCodeCliResult {
  /** 被清理的凭据文件路径，供 CLI 打印。 */
  credentialsPath: string;
}

// 登录失败的稳定分类：
// - auth_failed：服务端明确拒绝/授权失败；
// - auth_timeout：总超时或授权码过期；
// - config_update_failed：登录成功但写默认模型/Provider 配置失败；
// - credential_write_failed：登录成功但凭据落盘失败。
// 后两者意味着「凭证可能已部分写入」，调用方不应提示用户重新走完整登录。
export class ZCodeCliLoginError extends Error {
  /** 稳定错误码：调用方据此决定是否提示重试，不依赖错误文本。 */
  readonly code:
    | "auth_failed"
    | "auth_timeout"
    | "config_update_failed"
    | "credential_write_failed";

  /** 保留原始 cause 供日志/诊断；message 只给用户看的可操作提示。 */
  constructor(
    code: ZCodeCliLoginError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ZCodeCliLoginError";
    this.code = code;
  }
}
