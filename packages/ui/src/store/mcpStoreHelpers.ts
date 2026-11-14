// INV-01 键名集中一处：守住位置 三个导出常量；改错故障 读写键不一致导致配置丢失。
// INV-02 缺省配置全空：守住位置 默认对象；改错故障 首次启动读到脏数据。
// INV-03 读取永不抛出：守住位置 捕获包裹；改错故障 损坏的本地数据白屏。
// INV-04 非浏览器环境安全：守住位置 环境判断；改错故障 服务端渲染直接崩。
// INV-05 写入失败静默：守住位置 捕获分支；改错故障 存储配额不足阻断交互。
// INV-06 缺省配置每次新对象：守住位置 浅拷贝；改错故障 调用方修改污染常量。
// INV-07 旧版配置只读：守住位置 独立读取函数；改错故障 迁移时覆盖原生配置。
// INV-08 迁移后清理旧键：守住位置 移除调用；改错故障 每次启动重复迁移。
// INV-09 作用域键去尾分隔符：守住位置 正则裁剪；改错故障 同一目录出现两个键。
// INV-10 作用域取末两级：守住位置 片段拼接；改错故障 不同项目撞键。
// INV-11 空路径归全局：守住位置 早退分支；改错故障 全局配置写进工作区。
// INV-12 标识字符集受限：守住位置 归一化正则；改错故障 标识含空格导致选择器失效。
// INV-13 标识空值兜底：守住位置 默认字符串；改错故障 生成空标识互相覆盖。
// INV-14 目录来源参与标识：守住位置 来源拼接；改错故障 同名服务器互相覆盖。
// INV-15 已有条目复用：守住位置 按标识建表；改错故障 刷新后启用状态被重置。
// INV-16 配置变化才清状态：守住位置 配置比较；改错故障 改超时后仍显示旧连接结果。
// INV-17 启用状态三级回退：守住位置 空值合并；改错故障 手动关闭被原生配置覆盖。
// INV-18 已删除不复活：守住位置 预载过滤；改错故障 用户删掉的服务器又出现。
//
// 模块职责：MCP 配置的本地持久化、作用域标识生成与服务列表合并。
// 状态所有权：配置与启用状态存本地存储；原生服务器记录由调用方传入。
// 阅读顺序：先看存储读写，再看标识生成，最后看列表合并。
import type {
  McpConfig,
  McpServerConfig,
  McpSource,
  NativeMcpServerRecord,
  ZCodeMcpServer,
} from "@zcode/shared";

export const MCP_CONFIG_KEY = "zcode-mcp-config";
export const MCP_ENABLED_STATES_KEY = "zcode-mcp-enabled-states";
export const MCP_DELETED_PRELOAD_KEY = "zcode-mcp-deleted-preload";

export const DEFAULT_MCP_CONFIG: McpConfig = {
  mcp: { mcpServers: {} },
  zcodeagentmcp: { mcpServers: {}, projects: {} },
  claudeclimcp: { mcpServers: {}, projects: {} },
  geminiclimcp: { mcpServers: {}, projects: {} },
  codexclimcp: { mcpServers: {}, projects: {} },
  opencodemcp: { mcpServers: {}, projects: {} },
};

// typeof window 为 undefined 时直接返回 fallback。
// localStorage.getItem 拿到空值返回 fallback。
// JSON.parse 抛错时 catch 里返回 fallback。
// 读取只调用 localStorage.getItem，不修改存储内容。
// 返回类型与 fallback 的泛型 T 保持一致。
export function safeReadJson<T>(key: string, fallback: T): T {
  try {
    if (typeof window === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function safeWriteJson(key: string, value: unknown): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // ignore storage errors
  }
}

export function loadPersistedConfig(): McpConfig {
  return { ...DEFAULT_MCP_CONFIG };
}

export function readLegacyCommonMcpServers(): Record<string, McpServerConfig> {
  const saved = safeReadJson<Record<string, unknown>>(MCP_CONFIG_KEY, {});
  const legacyServers = (saved.mcp as { mcpServers?: Record<string, McpServerConfig> } | undefined)?.mcpServers;
  return legacyServers && typeof legacyServers === "object" ? legacyServers : {};
}

export function clearLegacyCommonMcpServers(): void {
  try {
    if (typeof window !== "undefined") {
      localStorage.removeItem(MCP_CONFIG_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

// projectPath 为空时归为 "global"。
// 先用 replace 去掉尾部路径分隔符。
// 只剩分隔符时 normalized 为空，归为 "workspace"。
// segments 取末两级目录拼成键。
// 单级目录直接返回 segments[0]。
// toScopeKey 只生成键，不改动 projectPath。
function toScopeKey(projectPath?: string): string {
  if (!projectPath) {
    return "global";
  }

  const normalized = projectPath.replace(/[\\/]+$/, "");
  if (!normalized) {
    return "workspace";
  }

  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[segments.length - 2]}-${segments[segments.length - 1]}`;
  }
  return segments[0] ?? "workspace";
}

function toIdKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "default";
}

// directorySource 只对 zcodeagentmcp 来源生效。
// 其余来源的 sourceKey 保持 source 原名。
// toScopeKey 与 toIdKey 分别归一化作用域和名称。
// 三段 sourceKey / scope / name 用连字符拼接。
// makeServerId 是纯函数，相同输入永远得到相同 id。
export function makeServerId(source: McpSource, name: string, projectPath?: string, directorySource?: NonNullable<NativeMcpServerRecord["location"]>["source"]): string {
  const sourceKey = source === "zcodeagentmcp" && directorySource && directorySource !== "zcode"
    ? `${source}-${directorySource}`
    : source;
  return `${sourceKey}-${toIdKey(toScopeKey(projectPath))}-${toIdKey(name)}`;
}

// existingServers 按 id 建 existingById 索引，复用时取 prev。
// configChanged 时把 status 与 error 重置为 unknown / undefined。
// enabled 按 enabledStates → prev.enabled → enabledBySource 三级回退。
// deletedPreload.has(serverId) 的服务器在循环内跳过。
export function buildServerList(
  _config: McpConfig,
  nativeServers: NativeMcpServerRecord[],
  enabledStates: Record<string, boolean>,
  deletedPreload: Set<string>,
  existingServers: ZCodeMcpServer[],
): ZCodeMcpServer[] {
  const existingById = new Map(existingServers.map((s) => [s.id, s]));

  function makeServer(
    serverId: string,
    name: string,
    serverConfig: McpServerConfig,
    source: McpSource,
    scope: ZCodeMcpServer["scope"],
    enabledBySource?: boolean,
    projectPath?: string,
    file?: ZCodeMcpServer["file"],
    location?: ZCodeMcpServer["location"],
  ): ZCodeMcpServer {
    const prev = existingById.get(serverId);
    const configChanged = prev ? !isSameMcpServerConfig(prev.config, serverConfig) : true;
    return {
      id: serverId,
      name,
      config: serverConfig,
      enabled: enabledStates[serverId] ?? prev?.enabled ?? enabledBySource ?? true,
      // MCP 配置保存后会触发设置页状态刷新；如果继续沿用旧健康状态，
      // 用户修改 timeoutMs 后会短暂看到上一版连接结果，依赖 changed 的检查也不会重新执行。
      changed: prev ? prev.changed || configChanged : true,
      status: configChanged ? "unknown" : (prev?.status ?? "unknown"),
      error: configChanged ? undefined : prev?.error,
      toolCount: configChanged ? undefined : prev?.toolCount,
      lastConnected: configChanged ? undefined : prev?.lastConnected,
      source,
      scope,
      projectPath,
      location,
      file,
    };
  }

  const servers: ZCodeMcpServer[] = [];

  for (const server of nativeServers) {
    const serverId = makeServerId(server.source, server.name, server.projectPath, server.location?.source);
    if (!deletedPreload.has(serverId)) {
      servers.push(
        makeServer(
          serverId,
          server.name,
          server.config,
          server.source,
          server.scope,
          server.enabled,
          server.projectPath,
          server.file,
          server.location,
        ),
      );
    }
  }

  return servers;
}

function isSameMcpServerConfig(left: McpServerConfig, right: McpServerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function getServerPriority(server: ZCodeMcpServer): number {
  if (server.scope === "workspace") return 2;
  if (server.scope === "user") return 1;
  return 0;
}
