/* ============================================================
 * MCP 网络与子进程环境适配（adapters/src/mcp/network.ts）
 *
 * 定位：为 MCP stdio server 组装环境变量，并为 HTTP/SSE server 提供带代理/CA 的 fetch。
 * 输入：宿主 env、NetworkEgressEnvPolicy（httpProxy / noProxy / caCertFile）。
 * 输出：过滤后的字符串 env（record）或与 globalThis.fetch 同签名的 fetch。
 * 副作用：读取 process.env（只读）；不写文件、不建连接；fetch 调用时才产生网络 IO。
 * 失败语义：组装阶段不抛错；代理/证书配置非法时由 createNetworkProxyFetch 决定行为。
 * 不变量：env 中非字符串值一律丢弃；ZCode 运行时变量先被清洗；PATH 中优先复用
 * 当前 Agent 的 Node 目录，使跨 SSH/WSL/Docker 的插件 `command: "node"` 可启动。
 * ============================================================ */

import { accessSync, constants } from "node:fs";
import { delimiter, posix, win32 } from "node:path";
import { sanitizeZCodeRuntimeEnv } from "@zcode/shared";
import { withoutNetworkCapture } from "@zcode/shared/node";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { applyNetworkEgressEnv, type NetworkEgressEnvPolicy } from "../network/subprocess-env.js";

export type { NetworkEgressEnvPolicy };

/**
 * 构造 MCP stdio 子进程环境。
 *
 * 输入 env 缺省用 process.env；network 决定代理 / 自定义 CA / no_proxy 注入。
 * 返回值为纯 string map（子进程环境不接受 undefined）。
 * 顺序：过滤非字符串 → 清洗 ZCode 内部变量 → 应用网络出口策略 → 前置 Node 目录。
 * 无文件/网络副作用；失败只会发生在下游策略实现，本函数自身不抛错。
 */
export function buildMcpStdioEnv(options: {
  env?: NodeJS.ProcessEnv;
  network?: NetworkEgressEnvPolicy;
}): Record<string, string> {
  const sourceEnv = options.env ?? process.env;
  return prependRunningNodeDirectory(
    applyNetworkEgressEnv(sanitizeZCodeRuntimeEnv(filterStringEnv(sourceEnv)), {
      network: options.network,
      sourceEnv,
    }),
  );
}

/**
 * 创建 MCP HTTP/SSE transport 专用 fetch。
 *
 * 复用统一代理实现（代理、自定义 CA、no_proxy），并用 withoutNetworkCapture 包一层，
 * 防止 MCP 请求被上层网络采集器重复记录（MCP body 可能含用户内容）。
 * 返回与 globalThis.fetch 同签名的函数；网络错误原样冒泡，不在此重试。
 */
export function createMcpTransportFetch(options: {
  env?: NodeJS.ProcessEnv;
  network?: NetworkEgressEnvPolicy;
}): typeof globalThis.fetch {
  const fetch = createNetworkProxyFetch({
    caCertFile: options.network?.caCertFile,
    env: options.env ?? process.env,
    httpProxy: options.network?.httpProxy,
    noProxy: options.network?.noProxy,
  });
  return (input, init) => withoutNetworkCapture(() => fetch(input, init));
}

/** 过滤 env：只保留 string 值；undefined 值（Windows 上常见）不进子进程环境。 */
function filterStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** PATH 前置逻辑的可注入依赖（execPath / 可执行判定 / 平台），便于跨平台测试。 */
interface RunningNodePathOptions {
  execPath: string;
  isExecutable: (path: string) => boolean;
  platform: NodeJS.Platform;
}

/** 默认使用当前进程的 Node 可执行路径与平台；仅在 execPath 名为 node/node.exe 时生效。 */
const DEFAULT_RUNNING_NODE_PATH_OPTIONS: RunningNodePathOptions = {
  execPath: process.execPath,
  isExecutable: isExecutableFile,
  platform: process.platform,
};

/**
 * 把当前 Node 可执行文件所在目录前置到 PATH（仅当当前进程确为 node 时）。
 *
 * 四种直接返回：
 * - execPath 不是 node/node.exe（例如打包后的独立二进制）：不干预；
 * - PATH 已包含该目录：幂等；
 * - PATH 中已有任一目录能解析到 node 可执行文件：尊重用户环境，不覆盖；
 * - 其余情况前置目录，空 PATH 时直接置为该目录。
 *
 * Windows 下键名大小写不敏感（Path/PATH），比较目录时同样忽略大小写并规范化。
 * 返回新对象，不修改入参。
 */
export function prependRunningNodeDirectory(
  env: Record<string, string>,
  options: RunningNodePathOptions = DEFAULT_RUNNING_NODE_PATH_OPTIONS,
): Record<string, string> {
  const pathApi = options.platform === "win32" ? win32 : posix;
  const pathDelimiter = options.platform === "win32" ? ";" : delimiter;
  const executableName = pathApi.basename(options.execPath).toLowerCase();
  if (executableName !== "node" && executableName !== "node.exe") {
    return env;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const nodeDirectory = pathApi.dirname(options.execPath);
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  if (
    pathEntries.some((entry) =>
      arePathEntriesEqual(entry, nodeDirectory, options.platform),
    )
  ) {
    return env;
  }

  const nodeExecutableName = options.platform === "win32" ? "node.exe" : "node";
  if (
    pathEntries.some((entry) =>
      options.isExecutable(pathApi.join(entry, nodeExecutableName)),
    )
  ) {
    return env;
  }

  // remote Agent 由 ~/.zcode/server/node 启动，但登录环境 PATH 不含该目录，
  // Plugin manifest 中标准的 command: "node" 因此无法启动 MCP。复用当前 Agent 的 Node
  // 目录可保持插件配置跨本地/SSH/WSL/Docker 可移植，同时不覆盖插件显式注入的环境。
  return {
    ...env,
    [pathKey]: currentPath
      ? `${nodeDirectory}${pathDelimiter}${currentPath}`
      : nodeDirectory,
  };
}

/** 比较两个 PATH 条目是否指向同一目录：先路径规范化，Windows 再转小写。 */
function arePathEntriesEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalize = (value: string) => {
    const normalized = pathApi.normalize(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

/** 以 X_OK 探测路径可执行；任何异常（不存在 / 权限不足）都视为不可执行。 */
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
