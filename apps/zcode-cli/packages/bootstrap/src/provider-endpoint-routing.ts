// 进程级 Provider 端点路由端口（endpoint routing）装配。
//
// 端口按「endpointOrigin + network 四元组」缓存：同一进程内相同端点/代理/CA 配置只建一个，
// 避免每个 session 重复建 HTTP 客户端与缓存；不同环境（生产/测试）或不同代理配置互不复用。
// ZCode JWT 与来源头都是惰性读取：JWT 每次请求现读凭据文件（登出/刷新后立即生效），
// sourceHeaders 每次调用重新生成（版本/设备信息不冻结在端口创建时刻）。
import { createConfig, type ConfigResult } from "@zcode/adapters/config";
import {
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
} from "@zcode/adapters/auth";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import { createProviderEndpointRoutingPort } from "@zcode/adapters/model";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import type { Logger, LoggerFactory, ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ModelProviderSourceTitle } from "./model-config.js";
import { createProviderEndpointRoutingSourceHeaders } from "./provider-endpoint-routing-source-headers.js";

const processRoutingPorts = new Map<string, ProviderEndpointRoutingPort>();

type NetworkConfig = ConfigResult["config"]["network"];

export interface ResolveProcessProviderEndpointRoutingPortOptions {
  /** 客户端版本；进入请求头，缺省时由 env 的 ZCODE_APP_VERSION 兜底。 */
  appVersion?: string;
  /** 环境变量表；决定端点 origin、代理与凭据文件位置。 */
  env?: NodeJS.ProcessEnv;
  /** 已解析的 logger；会派生子 logger（module=adapters.model.provider_endpoint_routing）。 */
  logger: Logger;
  /** 网络配置；参与缓存键，代理/CA 变化会创建新端口。 */
  network: NetworkConfig;
  /** 来源标签（cli/electron）；影响请求头中的 X-Title。 */
  sourceTitle?: ModelProviderSourceTitle;
}

export interface CreateDefaultProviderEndpointRoutingPortOptions {
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  loggerFactory?: LoggerFactory;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  sourceTitle?: ModelProviderSourceTitle;
  userConfigPath?: string;
  workingDirectory: string;
}

/**
 * 取得（必要时创建）进程内唯一的 endpoint routing 端口。
 *
 * 缓存命中直接返回既有端口，不重新读凭据/网络配置；创建时：
 * - credentialStore 共享同一个凭据文件，readZCodeJwt 每次请求现读，登出后自然失效；
 * - httpClient 只应用本次 network 的 ca/proxy/noProxy；
 * - sourceHeaders 回调每次重新生成，不缓存设备信息（deviceMid 读取有独立缓存）。
 *
 * 注意：返回值含共享可变的鉴权状态，调用方不得 dispose 或替换内部字段。
 */
export function resolveProcessProviderEndpointRoutingPort(
  options: ResolveProcessProviderEndpointRoutingPortOptions,
): ProviderEndpointRoutingPort {
  const env = options.env ?? process.env;
  const endpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);
  const key = routingRegistryKey(endpointOrigin, options.network);
  const existing = processRoutingPorts.get(key);
  if (existing) {
    return existing;
  }

  const credentialStore = createSharedZCodeCredentialStore({ env });

  const port = createProviderEndpointRoutingPort({
    appVersion: options.appVersion,
    endpointOrigin,
    httpClient: createNodeHttpClientAdapter({
      caCertFile: options.network.caCertFile,
      env,
      noProxy: options.network.noProxy,
      proxyUrl: options.network.httpProxy,
    }),
    logger: options.logger.child({
      module: "adapters.model.provider_endpoint_routing",
    }),
    readZCodeJwt: () => credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken),
    sourceHeaders: () =>
      createProviderEndpointRoutingSourceHeaders({
        appVersion: options.appVersion,
        env,
        sourceTitle: options.sourceTitle,
      }),
  });
  processRoutingPorts.set(key, port);
  return port;
}

// 便捷入口：先解析用户/项目配置与日志工厂，再把 network 交给进程级缓存逻辑；
// workingDirectory 参与配置定位，但不进入缓存键（同端点同网络即复用）。
export function createDefaultProviderEndpointRoutingPort(
  options: CreateDefaultProviderEndpointRoutingPortOptions,
): ProviderEndpointRoutingPort {
  const env = options.env ?? process.env;
  const configResult = createConfig({
    env,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory: options.workingDirectory,
  });
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env });
  const logger = loggerFactory.createLogger("zcode").child({
    module: "bootstrap.provider_endpoint_routing",
  });
  return resolveProcessProviderEndpointRoutingPort({
    appVersion: options.appVersion,
    env,
    logger,
    network: configResult.config.network,
    sourceTitle: options.sourceTitle,
  });
}

// 缓存键只包含真正改变网络行为的四项；JSON.stringify 保证键稳定且无歧义。
// 不要加入 appVersion/sourceTitle：它们只影响请求头，端口可安全复用。
function routingRegistryKey(endpointOrigin: string, network: NetworkConfig): string {
  return JSON.stringify({
    caCertFile: network.caCertFile,
    endpointOrigin,
    httpProxy: network.httpProxy,
    noProxy: network.noProxy,
  });
}
