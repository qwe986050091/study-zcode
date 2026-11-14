// ============================================================
// 文件定位：给子进程环境注入网络出口策略（代理、NO_PROXY、CA 证书）与用户环境透传。
// 输入输出：输入基础 env 与策略/来源环境，原地修改并返回同一个 env 对象。
// 副作用：只改传入的 env 对象，不读写 process.env、不联网。
// 失败语义：非法代理值按“未配置”跳过；不抛错，保证子进程总能启动。
// 不变量：键写入前先删除同名键（Windows 大小写不敏感），避免大小写重复项。
// ============================================================
import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  readZCodeToolEnvPassthroughEnv,
} from "@zcode/shared";

export interface NetworkEgressEnvPolicy {
  // 自定义 CA 证书路径；会写入 NODE_EXTRA_CA_CERTS 等一组键。
  caCertFile?: string;
  // 代理地址；写入 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 的大小写两套键。
  httpProxy?: string;
  // 直连列表；写入 NO_PROXY/no_proxy。
  noProxy?: string;
}

// 注入选项：不提供策略时仍会处理工具环境透传（除非显式关闭）。
interface NetworkEgressEnvOptions {
  // 网络出口策略；缺省为空对象。
  network?: NetworkEgressEnvPolicy;
  // 平台，决定环境变量键是否大小写不敏感；默认 process.platform。
  platform?: NodeJS.Platform;
  // 来源环境（通常是父进程 env 的快照），用于读取 ZCODE_* 与用户透传值。
  sourceEnv?: Record<string, string | undefined>;
  // 是否把工具环境透传键合并进子进程；false 时显式跳过。
  toolEnvPassthrough?: boolean;
}

// 代理键全集：主流工具分别读大写或小写，必须两套都写才能对所有子进程生效。
const ALL_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
// NO_PROXY 只认这两种写法；其余大小写变体不属于通用约定，不额外扩散。
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;
// CA 证书来源键：用于从父环境继承用户已配置的证书路径。
const CA_SOURCE_KEYS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
] as const;
// 写入目标与来源键相同：让 Node/Python/cURL/git 等各自认领同一份证书路径。
const CA_TARGET_KEYS = CA_SOURCE_KEYS;
const EXPLICIT_CA_SOURCE_KEYS = [ZCODE_AGENT_CA_CERT_ENV_KEY] as const;
// ZCODE_NO_PROXY 与网络策略 noProxy 等价，作为来源环境中的显式配置。
const EXPLICIT_NO_PROXY_SOURCE_KEYS = [ZCODE_NO_PROXY_ENV_KEY] as const;

/**
 * 注入顺序固定：清透传标记 → 合并透传环境 → 代理 → NO_PROXY → CA。
 * 先清后写保证子进程不会残留父进程的 ZCODE_TOOL_ENV_PASSTHROUGH 元数据。
 */
export function applyNetworkEgressEnv(
  env: Record<string, string>,
  options: NetworkEgressEnvOptions,
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.sourceEnv ?? {};
  const network = options.network ?? {};

  deleteEnvKey(env, ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY, platform);
  if (options.toolEnvPassthrough !== false) {
    applyToolEnvPassthroughEnv(env, sourceEnv, platform);
  }
  applyProxyEnv(env, sourceEnv, network, platform);
  applyNoProxyEnv(env, sourceEnv, network, platform);
  applyCaEnv(env, sourceEnv, network, platform);
  return env;
}

// 把父环境里“用户允许透传”的键原样复制给子进程；单个键写入失败不影响其他键。
function applyToolEnvPassthroughEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  const passthroughEnv = readZCodeToolEnvPassthroughEnv(sourceEnv);
  for (const [key, value] of Object.entries(passthroughEnv)) {
    setEnvKey(env, key, value, platform);
  }
}

/**
 * 代理注入：显式 network.httpProxy 优先，其次 ZCODE_HTTP_PROXY；命中即写全部大小写键并返回。
 * 两者都缺失时什么都不写，保留子进程原有的代理设置（不做清空）。
 */
function applyProxyEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const configuredProxy = normalizeProxyValue(network.httpProxy);
  if (configuredProxy) {
    for (const key of ALL_PROXY_KEYS) {
      setEnvKey(env, key, configuredProxy, platform);
    }
    return;
  }

  const zcodeProxy = normalizeProxyValue(
    getFirstEnvValue(sourceEnv, [ZCODE_HTTP_PROXY_ENV_KEY], platform),
  );
  if (zcodeProxy) {
    for (const key of ALL_PROXY_KEYS) {
      setEnvKey(env, key, zcodeProxy, platform);
    }
    return;
  }
}

/**
 * NO_PROXY 注入：显式 network.noProxy 优先，其次 ZCODE_NO_PROXY。
 * 未配置时直接返回，避免为子进程凭空写一个空 NO_PROXY 而改变其语义。
 */
function applyNoProxyEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const noProxy =
    normalizeEnvValue(network.noProxy) ??
    getFirstEnvValue(sourceEnv, EXPLICIT_NO_PROXY_SOURCE_KEYS, platform);
  if (!noProxy) {
    return;
  }
  for (const key of NO_PROXY_KEYS) {
    setEnvKey(env, key, noProxy, platform);
  }
}

/**
 * CA 证书注入：显式 network.caCertFile 优先，其次 ZCODE_AGENT_CA_CERT。
 * 写 NODE_EXTRA_CA_CERTS/SSL_CERT_FILE/REQUESTS_CA_BUNDLE/CURL_CA_BUNDLE/GIT_SSL_CAINFO。
 */
function applyCaEnv(
  env: Record<string, string>,
  sourceEnv: Record<string, string | undefined>,
  network: NetworkEgressEnvPolicy,
  platform: NodeJS.Platform,
): void {
  const caCertFile =
    normalizeEnvValue(network.caCertFile) ??
    getFirstEnvValue(sourceEnv, EXPLICIT_CA_SOURCE_KEYS, platform);
  if (!caCertFile) {
    return;
  }
  for (const key of CA_TARGET_KEYS) {
    setEnvKey(env, key, caCertFile, platform);
  }
}

// 代理值规范化：去空白；缺协议时补 http://（多数工具要求显式 scheme）。
function normalizeProxyValue(value: string | undefined): string | undefined {
  const trimmed = normalizeEnvValue(value);
  if (!trimmed) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

// 环境值裁剪：去首尾空白，空串视为未设置（避免把 "" 写进子进程）。
function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// 按键优先级取第一个非空值；Windows 下按键名大小写不敏感查找。
function getFirstEnvValue(
  env: Record<string, string | undefined>,
  keys: readonly string[],
  platform: NodeJS.Platform,
): string | undefined {
  for (const key of keys) {
    const value = getEnvValue(env, key, platform);
    if (normalizeEnvValue(value)) {
      return value;
    }
  }
  return undefined;
}

// 写入前先删同名键，保证 Windows 上不会同时存在 "Path" 与 "PATH" 这类重复项。
function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  deleteEnvKey(env, key, platform);
  env[key] = value;
}

/**
 * 删除环境键：POSIX 精确匹配；Windows 大小写不敏感（环境块本身不区分大小写），
 * 因此要遍历现有键删除所有大小写变体。
 */
function deleteEnvKey(env: Record<string, string>, key: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }

  const lowerKey = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === lowerKey) {
      delete env[existingKey];
    }
  }
}

// 读环境键：POSIX 精确匹配；Windows 忽略大小写找实际键名再取值。
function getEnvValue(
  env: Record<string, string | undefined>,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return env[key];
  }
  const lowerKey = key.toLowerCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return actualKey ? env[actualKey] : undefined;
}
