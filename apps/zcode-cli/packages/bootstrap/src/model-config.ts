// 组装 AiSdk 模型执行配置（headers/env/network/endpoint 路由）。
//
// 这里只做「纯配置合成」：不读凭据、不创建客户端、不访问网络。headers 用于让网关识别
// 客户端来源与版本；network 只保留显式配置的三个键；endpointRoutingPort 是可选能力，
// 缺席时由 adapters 走默认直连逻辑。
import type {
  AiSdkModelExecutionConfig,
  AiSdkNetworkConfig,
  EnvRecord,
} from "@zcode/adapters/model";
import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import {
  resolveRuntimeZCodeEnv,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_APP_VERSION_ENV,
} from "@zcode/shared";
import {
  createRuntimePlatformHeaders,
  normalizePrintableHeaderValue,
} from "./runtime-platform-headers.js";

export type ModelProviderSourceTitle = "cli" | "electron";

interface RuntimeExecutionConfigOptions {
  appVersion?: string;
  endpointRoutingPort?: ProviderEndpointRoutingPort;
  network?: AiSdkNetworkConfig;
  sourceTitle?: ModelProviderSourceTitle;
}

/**
 * 生成一次运行期执行配置。
 *
 * - defaultHeaders 由 buildCliZCodeSourceHeaders 统一产出（请求出口一致性）；
 * - env 原样透传，供 adapters 解析端点/代理/版本等；
 * - network 为空配置时整体省略，避免下游把空对象当成「显式无代理」；
 * - endpointRoutingPort 仅在提供时加入，未提供即保持旧直连行为。
 */
export function createRuntimeAiSdkModelExecutionConfig(
  env: EnvRecord = process.env,
  options: RuntimeExecutionConfigOptions = {},
): AiSdkModelExecutionConfig {
  const network = normalizeAiSdkNetworkConfig(options.network);
  return {
    defaultHeaders: buildCliZCodeSourceHeaders(env, options),
    env,
    ...(network ? { network } : {}),
    ...(options.endpointRoutingPort ? { endpointRoutingPort: options.endpointRoutingPort } : {}),
  };
}

// 只保留 caCertFile/httpProxy/noProxy 三个真正影响请求的键；三者全空返回 undefined，
// 让调用方以「字段缺席」表达默认网络行为，而不是传入一个含义模糊的空对象。
function normalizeAiSdkNetworkConfig(
  network: AiSdkNetworkConfig | undefined,
): AiSdkNetworkConfig | undefined {
  if (!network?.caCertFile && !network?.httpProxy && !network?.noProxy) return undefined;
  return {
    ...(network.caCertFile ? { caCertFile: network.caCertFile } : {}),
    ...(network.httpProxy ? { httpProxy: network.httpProxy } : {}),
    ...(network.noProxy ? { noProxy: network.noProxy } : {}),
  };
}

/**
 * 统一的请求来源头。
 *
 * - HTTP-Referer 指向运行时端点（随环境切换），User-Agent 形如 `ZCode/<version>`；
 * - appVersion 来源优先级：env[ZCODE_APP_VERSION_ENV] > options.appVersion > unknown；
 * - X-Title 区分 CLI/Electron，X-Release-Channel 来自运行时环境（prod/test 等）；
 * - locale/timezone 经 normalizePrintableHeaderValue 过滤不可打印字符，缺失时给 unknown；
 * - 平台头由 createRuntimePlatformHeaders 追加（OS/架构等），不覆盖上面已有键。
 */
export function buildCliZCodeSourceHeaders(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion" | "sourceTitle"> = {},
): Record<string, string> {
  const sourceTitle = options.sourceTitle ?? detectDefaultProviderSourceTitle();
  const appVersion = resolveAppVersionForHeaders(env, options);
  const locale = normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().locale);
  const timezone = normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return {
    "HTTP-Referer": resolveRuntimeZCodeEndpointOrigin(env),
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    "X-Release-Channel": resolveRuntimeZCodeEnv(env),
    "X-Client-Language": locale ?? "unknown",
    "X-Client-Timezone": timezone ?? "unknown",
    "X-ZCode-Agent": "glm",
    ...createRuntimePlatformHeaders(),
  };
}

// 版本头优先取进程环境（由宿主注入的真实版本），其次才用调用方传值；都必须可打印。
function resolveAppVersionForHeaders(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion">,
): string | undefined {
  return normalizePrintableHeaderValue(env[ZCODE_APP_VERSION_ENV] ?? options.appVersion);
}

// 通过 argv 判断宿主类型：app-server/agent-server 视为 Electron，其余为 CLI；
// 只是默认来源标签，调用方仍可用 sourceTitle 覆盖。
function detectDefaultProviderSourceTitle(): ModelProviderSourceTitle {
  return process.argv.includes("app-server") || process.argv.includes("agent-server")
    ? "electron"
    : "cli";
}
