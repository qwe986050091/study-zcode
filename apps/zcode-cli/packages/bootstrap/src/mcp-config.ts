// MCP 配置的状态投影与 CUA 凭据注入。
//
// 信任边界：配置里没有任何「可信」布尔位。一个 server 是否可信由调用方传入的
// untrustedServerNames 决定（项目级 server 需用户显式连接后才移出该集合）；
// official CUA 的权威性则来自内存中 plugin registry 的「同一对象引用」，而不是名字/命令/env
// 的字符串相似——用户覆盖配置会替换对象，复制字段不会继承内置插件权限。
// 三层合并（user/project/plugin）发生在协议装配侧，这里只消费合并后的 configuredServers。
import type {
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpStdioServerConfig,
} from "@zcode/contracts";
import {
  getCapturedZCodeCuaBrokerCredentials,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";

export {
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY as ZCODE_CUA_BROKER_SOCKET_ENV,
} from "@zcode/shared";
// 保留环境变量名供旧诊断脚本读取；迁移后的配置路径不会据此启动独立 CUA MCP。
export const ZCODE_CUA_BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
// CLI 入口会先清理 broker 凭据；shared node_repl 的可信配置随后从进程内捕获快照恢复它们。
function resolveZCodeCuaBrokerSocket(): string | undefined {
  // captured 优先；运行时残留的 stale socket 不能覆盖可信快照。
  return (
    getCapturedZCodeCuaBrokerCredentials().socket ||
    process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim()
  );
}

function resolveZCodeCuaBrokerToken(): string | undefined {
  return (
    undefined
  );
}

const NODE_REPL_SERVER_NAME = "node_repl";
const REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";

/**
 * Derive official CUA provenance from the in-memory plugin registry rather than
 * from serializable MCP fields. A user/project override replaces the config
 * object in `configuredServers`, so copied names, commands, and env values do
 * not inherit the bundled plugin's authority.
 */
// 中文补充：判据是引用相等（configuredServers[name] === config），用户/项目覆盖会替换对象，
// 因此即便名字、command、env 全部照抄内置值，也不会被当成有权限的官方 server；
// 另外仍要求 stdio 且 _plugin id 指向 official CUA，避免同对象被复用给别的插件。
export function resolveTrustedOfficialCuaServerNames(
  configuredServers: Record<string, McpServerConfig>,
  pluginServers: Record<string, McpServerConfig>,
): Set<string> {
  return new Set(
    Object.entries(pluginServers)
      .filter(
        ([name, config]) =>
          configuredServers[name] === config &&
          config.type === "stdio" &&
          config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() ===
            ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      )
      .map(([name]) => name),
  );
}

/**
 * 合并「实时状态」与「配置态」生成设置页展示用的 status 投影。
 *
 * - liveStatuses 优先（MCP 端口已连接时以进程真实状态为准）；未连接时按配置推导：
 *   enabled=false → disabled，在 untrusted 集合中 → untrusted，否则 disconnected；
 * - untrusted 附带 failureKind=status_unavailable 与固定错误文案，提示用户先显式连接；
 * - 已退役的 zcode-cua server 不投影，避免设置页继续显示已删除的入口；
 * - live 中存在但配置已没了的 server 仍保留状态（仅排除退役 CUA），便于诊断残留进程。
 *
 * 注意：本函数只读，不会触发连接或启动 server。
 */
export async function listMcpServerStatuses(
  mcpPort: McpPort | undefined,
  servers: Record<string, McpServerConfig>,
  untrustedServerNames: ReadonlySet<string> = new Set(),
): Promise<Record<string, McpServerStatus>> {
  const liveStatuses = mcpPort ? await mcpPort.status() : {};
  const updatedAt = new Date().toISOString();
  const statuses: Record<string, McpServerStatus> = {};

  for (const [name, config] of Object.entries(servers)) {
    // 迁移后旧的 zcode-cua MCP 只是历史配置，不再进入状态投影；CUA
    // 由 shared node_repl 承载，避免设置页继续把已删除的 server 显示为可用。
    if (isRetiredCuaMcpServer(name, config)) continue;
    const configuredStatus = getConfiguredServerStatus(name, config, untrustedServerNames);
    statuses[name] = liveStatuses[name] ?? {
      status: configuredStatus,
      transport: config.type,
      toolCount: 0,
      updatedAt,
      error: getConfiguredServerError(name, config, untrustedServerNames),
      ...(configuredStatus === "untrusted" ? { failureKind: "status_unavailable" as const } : {}),
    };
  }

  for (const [name, status] of Object.entries(liveStatuses)) {
    if (!(name in statuses) && !isRetiredCuaMcpServer(name, servers[name])) statuses[name] = status;
  }

  return statuses;
}

/**
 * 应用「用户显式省略」集合后，再注入 broker 凭据。
 *
 * omittedNames 通常来自项目级/被拒绝的 server；与退役 CUA 判定一起在过滤阶段完成，
 * 之后才调用 inject，保证注入不会把刚被省略的 server 又带回来（注入只改已有 node_repl）。
 * 返回新对象（不修改入参），调用方可安全持有旧配置做比较。
 */
export function omitMcpServers(
  servers: Record<string, McpServerConfig>,
  omittedNames: ReadonlySet<string>,
  trustedOfficialCuaServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const kept = Object.fromEntries(
    Object.entries(servers).filter(
      ([name, config]) =>
        !omittedNames.has(name) &&
        !isRetiredCuaMcpServer(name, config),
    ),
  );

  return injectZCodeCuaBrokerMcpServers(
    kept,
    resolveZCodeCuaBrokerSocket(),
    resolveZCodeCuaBrokerToken(),
    trustedOfficialCuaServerNames,
  );
}

/**
 * 把 CUA broker socket/token 注入唯一受支持的 node_repl server。
 *
 * - 只有名字为 node_repl、有 socket、且出现在 trustedOfficialCuaServerNames 时才注入；
 *   其它 server 原样保留（不因为「看起来像 CUA」就获得凭据）；
 * - 顺手剔除退役的 CUA 形状 server（changed=true 表示确有删除/注入）；
 * - 没有任何变化时返回原对象（引用稳定），调用方可据此跳过无意义的配置重建。
 */
export function injectZCodeCuaBrokerMcpServers(
  servers: Record<string, McpServerConfig>,
  socketPath: string | undefined,
  token: string | undefined = undefined,
  trustedOfficialCuaServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const normalizedSocketPath = socketPath?.trim();
  const normalizedToken = token?.trim();

  let changed = false;
  const next: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (isRetiredCuaMcpServer(name, config)) {
      changed = true;
      continue;
    }
    if (
      name !== NODE_REPL_SERVER_NAME ||
      !normalizedSocketPath ||
      !trustedOfficialCuaServerNames.has(name)
    ) {
      next[name] = config;
      continue;
    }
    const injected = injectCuaCredentialsIntoNodeRepl(
      config,
      normalizedSocketPath,
      normalizedToken,
    );
    next[name] = injected;
    changed ||= injected !== config;
  }

  return changed ? next : servers;
}

// 构造注入后的 env：socket/marker/plugin authority 来自私有凭据快照，
// 并把 host 标记与 official plugin id 写死，防止配置侧伪造身份。
function injectCuaCredentialsIntoNodeRepl(
  config: McpServerConfig,
  socketPath: string,
  token: string | undefined,
): McpServerConfig {
  if (config.type !== "stdio") return config;
  const captured = getCapturedZCodeCuaBrokerCredentials();
  const pluginAuthority = captured.pluginAuthority;
  // CLI runtime env 会在 bootstrap 前被清理。marker 必须和 socket/token 一样取自私有凭据快照，
  // 否则 SDK 迁移后 broker 虽然存活，权限刷新仍会静默停止。
  const refreshMarker = captured.refreshMarker || process.env[REFRESH_MARKER_ENV]?.trim();
  return {
    ...config,
    env: {
      ...config.env,
      [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: socketPath,
      ...(refreshMarker ? { [REFRESH_MARKER_ENV]: refreshMarker } : {}),
      ...(pluginAuthority ? { [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: pluginAuthority } : {}),
      [ZCODE_CUA_NODE_REPL_HOST_ENV_KEY]: "1",
      [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
    },
  };
}

// 判定是否为 CUA 形状的 stdio server（四道判据按强度递减：固定名 → _plugin id →
// 命令路径 → 包参数），与 desktop/services 共用 shared 单一事实源，避免注入入口漂移。
function isZCodeCuaStdioServer(
  name: string,
  config: McpServerConfig,
): config is McpStdioServerConfig {
  if (config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // 内置 official zcode-cua plugin 的 MCP server 走 __zcode-plugin-host，command 是 Helper
  // (非 zcode-cua)、args 是 [zcode.cjs, __zcode-plugin-host, server.js]（非 zcode-cua package arg），
  // 上面的 name/command/args 三条都匹配不到。_plugin id 由 adapters resolver 权威写入 env
  // （manifest/user env 不可覆盖），用它识别 official plugin server。
  if (
    config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() === ZCODE_CUA_OFFICIAL_PLUGIN_ID
  ) {
    return true;
  }
  // 判定与 desktop/services 共用 @zcode/shared 的单一事实源，避免两条注入入口漂移。
  if (isZCodeCuaMcpCommand(config.command)) return true;
  return (config.args ?? []).some(isZCodeCuaMcpPackageArg);
}

// node_repl 是唯一受支持的 CUA 宿主（可与 CUA 插件共享 authority 标记），
// 其余任何 CUA 形状的 MCP 条目都视为退役配置，从状态投影与注入结果中剔除。
function isRetiredCuaMcpServer(name: string, config: McpServerConfig | undefined): boolean {
  // node_repl is the single supported CUA host and may share the CUA plugin's
  // authority marker; all other CUA-shaped MCP entries are retired.
  return name !== NODE_REPL_SERVER_NAME && config !== undefined && isZCodeCuaStdioServer(name, config);
}

// 无实时状态时的配置态：disabled 优先于 untrusted（用户主动关闭不需要再提示连接）；
// 其余一律 disconnected，等首次连接后再由 live 状态覆盖。
function getConfiguredServerStatus(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): McpServerStatus["status"] {
  if (config.enabled === false) return "disabled";
  return untrustedServerNames.has(name) ? "untrusted" : "disconnected";
}

// 只有「启用且未信任」才给错误文案；disabled 或无实时状态时保持 undefined，
// 避免设置页把未连接误显示成错误。
function getConfiguredServerError(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): string | undefined {
  if (config.enabled === false || !untrustedServerNames.has(name)) return undefined;
  return "Project MCP server requires explicit connection before use.";
}
