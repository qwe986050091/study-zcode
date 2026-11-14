/* eslint-disable max-lines -- MCP store 集中维护配置加载、持久化、状态刷新与运行时状态合并，拆分会增加跨状态同步复杂度。 */
/**
 * MCP (Model Context Protocol) UI State Store
 */
// MCP UI 状态仓库：维护配置、原生服务器记录、状态快照与启用覆盖，并向 UI 与 Agent 投影。
// 做：配置加载与合并、scoped 增删改、启停、状态列表刷新与快照合并、workspace 切换重置。
// 不做：真实 MCP 连接与探活（由 agent 侧 mcp/list 完成）；不做远程会话鉴权。
// 依赖：mcpStoreDesktop（平台/目录服务）、mcpStoreMigration（旧 common 迁移）、mcpStoreHelpers（构建列表）。
// 边界：store 只保存 UI 投影与待写盘意图；磁盘配置与 agent 运行时才是事实源。
//
// INV-01 断言：配置写入必须先落盘再改本地 state —— 守住它的位置：persistScopedChange 后紧跟 updateNativeServer —— 改错故障：agent 读到旧 timeoutMs 或旧开关，健康状态长期不一致。
// INV-02 断言：source==="mcp" 必须映射为 zcodeagentmcp 且 persistScopedChange 对它直接 return —— 守住它的位置：targetSource 计算与早退 —— 改错故障：内置源被写进用户目录，出现重复定义。
// INV-03 断言：每次 scoped 变更前必须作废两条状态链路 —— 守住它的位置：add/update/delete 入口 —— 改错故障：旧 epoch 响应回填，刚改的配置被投影成旧状态。
// INV-04 断言：connect 与 status 必须各自独立计 epoch —— 守住它的位置：statusListEpochs —— 改错故障：OAuth 轮询与全量 list 互相作废，界面状态抖动。
// INV-05 断言：status-only 轮询不得清空 authorization/toolCount，也不得把其它 MCP 投影成 connecting —— 守住它的位置：beginServerStatusListRefresh 的 status 早退 —— 改错故障：轮询期间别的 MCP 变灰、要求重新授权。
// INV-06 断言：markServerStatusListRefreshFailed 对 status 模式必须 no-op —— 守住它的位置：该函数首行判断 —— 改错故障：一次临时轮询失败把整列连接中的 MCP 批量标红。
// INV-07 断言：失败回填只允许命中最新 epoch 且只处理 zcodeagentmcp+enabled+connecting —— 守住它的位置：条件块 —— 改错故障：迟到失败覆盖已完成的连接。
// INV-08 断言：status 模式快照必须 merge，connect 模式必须整体替换 —— 守住它的位置：nextStatusSnapshots —— 改错故障：局部子集替换全量后，缺失项被当成消失。
// INV-09 断言：markMissingConnectingAsError 只允许在 connect 模式为真 —— 守住它的位置：merge 调用参数 —— 改错故障：轮询缺失项被误标「agent 未返回」。
// INV-10 断言：enabledStates 是本地覆盖表，未知 id 必须回落到 server.enabled —— 守住它的位置：所有 ?? server.enabled —— 改错故障：默认启用被写成显式关闭或反之。
// INV-11 断言：toggleServer 必须先持久化 enable 覆盖再 set —— 守住它的位置：await 顺序 —— 改错故障：开关视觉生效但磁盘仍旧值，重连后回弹。
// INV-12 断言：启停持久化失败只告警，不阻断本地投影 —— 守住它的位置：catch —— 改错故障：写盘失败导致开关完全点不动。
// INV-13 断言：目录加载必须按 workspaceKey 去重并复用在飞 promise —— 守住它的位置：loadMcpWorkspaceKey —— 改错故障：并发调用发起多轮读取，互相覆盖 nativeServers。
// INV-14 断言：等待上一轮加载后必须用最新 identity 重新选择目录服务 —— 守住它的位置：latestWorkspaceKey 与 activeDirectoryService —— 改错故障：拿 B 的 remote service 读 C 的路径。
// INV-15 断言：异步读取返回后必须再比一次 currentWorkspaceKey，不一致就丢弃 —— 守住它的位置：该 if —— 改错故障：A 的 env/header/OAuth secret 被写进 B 的共享 store。
// INV-16 断言：加载失败必须返回 false 而不是给空配置 —— 守住它的位置：catch —— 改错故障：上层当作配置为空下发空 mcpServers，触发 replace 断开在跑的 MCP。
// INV-17 断言：只过滤 isRemoteWorkspaceDisconnectedError，其它错误必须 warn —— 守住它的位置：catch 内判断 —— 改错故障：真实目录或 RPC 故障被静默吞掉。
// INV-18 断言：finally 必须同时清 promise 与 workspaceKey —— 守住它的位置：finally —— 改错故障：残留 key 让下一次同 workspace 调用永久命中已结束的 promise。
// INV-19 断言：切换 workspace 必须清空 nativeServers 与 statusSnapshots —— 守住它的位置：setCurrentProjectPath —— 改错故障：A 的服务器与状态残留到 B，跨 workspace 串数据。
// INV-20 断言：下发给 agent 的列表只取 zcodeagentmcp，同名按 priority 合并 —— 守住它的位置：getEnabledMcpServersForZCode —— 改错故障：覆盖顺序不定，或把 CLI 源错误下发给 agent。
//
// 阅读顺序：先看 INV 清单，再看每个 mutation 的 [事务]/[并发] 标注。
// 约束：任何新增 mutation 都必须同时处理 epoch、落盘顺序与 workspace 切换三条边界。
import { create } from "zustand";
import type {
  ZCodeAgentMcpServer,
  CliMcpSource,
  McpConfig,
  McpScope,
  McpServerConfig,
  McpServerStatus,
  McpSource,
  NativeMcpServerRecord,
  ZCodeMcpListMode,
  ZCodeMcpServerStatusSnapshot,
  ZCodeMcpServer,
} from "@zcode/shared";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  fetchNativeMcpServers,
  migrateLegacyCommonMcpFromDesktop,
  persistCliMcpToUserDirectory,
  type McpDirectoryService,
  type McpPlatformService,
  type MigrateLegacyResult,
} from "@/store/mcpStoreDesktop.js";
import {
  importLegacyCommonServersToZCodeAgent,
  migrateStoredCommonMcpToZCodeAgent,
} from "@/store/mcpStoreMigration.js";
import {
  buildServerList,
  DEFAULT_MCP_CONFIG,
  getServerPriority,
  loadPersistedConfig,
  makeServerId,
  MCP_DELETED_PRELOAD_KEY,
  safeReadJson,
  safeWriteJson,
} from "@/store/mcpStoreHelpers.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { mergeMcpServerStatusSnapshots } from "@/store/mcpStoreStatusList.js";

// [契约] 平台服务与目录服务都是模块级单例，通过 setter 注入，store 不自行探测环境。
// [并发] 两者可在运行期被重置为 null（登出/切远端），所有使用点必须容忍空值。
// [失败路径] 缓存成闭包局部变量后，注入顺序变化会让后续调用永远读到旧实现。
// [权衡] 用可变单例而非参数透传：调用点遍布 UI，透传会污染全部签名。
// [边界] 这里只存引用，不判断实现是 desktop 还是 web。
let mcpPlatformService: McpPlatformService | null = null;
let mcpDirectoryService: McpDirectoryService | null = null;

export function setMcpStorePlatform(platform: McpPlatformService | null): void {
  mcpPlatformService = platform;
}

export function setMcpStoreDirectoryService(service: McpDirectoryService | null): void {
  mcpDirectoryService = service;
}

interface UpdateServerStatusOptions {
  invalidateStatusListRequests?: boolean;
}

interface McpStoreState {
  config: McpConfig;
  nativeServers: NativeMcpServerRecord[];
  servers: ZCodeMcpServer[];
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot>;
  currentProjectPath: string;
  currentWorkspaceIdentity?: string;
  currentAuthorityKey?: string;
  enabledStates: Record<string, boolean>;
  deletedPreloadMcpServers: Set<string>;
  isConfigLoaded: boolean;
  currentSessionId: string | null;
  loadConfig: () => void;
  loadMcpFromUserDirectory: (
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string,
    authorityKey?: string,
  ) => Promise<boolean>;
  ensureLoadedForWorkspace: (
    workspacePath?: string,
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string,
    authorityKey?: string,
  ) => Promise<boolean>;
  saveConfig: () => void;
  addMcpServer: (name: string, config: McpServerConfig) => void;
  updateMcpServer: (name: string, config: McpServerConfig) => void;
  deleteMcpServer: (name: string) => void;
  addScopedMcpServer: (source: McpSource, name: string, config: McpServerConfig, projectPath?: string) => Promise<void>;
  updateScopedMcpServer: (source: McpSource, name: string, config: McpServerConfig, projectPath?: string) => Promise<void>;
  deleteScopedMcpServer: (source: McpSource, name: string, projectPath?: string) => void;
  addZCodeAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateZCodeAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteZCodeAgentMcpServer: (name: string, projectPath?: string) => void;
  addClaudeCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateClaudeCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteClaudeCliMcpServer: (name: string, projectPath?: string) => void;
  addGeminiCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateGeminiCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteGeminiCliMcpServer: (name: string, projectPath?: string) => void;
  addCodexCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateCodexCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteCodexCliMcpServer: (name: string, projectPath?: string) => void;
  addOpenCodeMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateOpenCodeMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteOpenCodeMcpServer: (name: string, projectPath?: string) => void;
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  updateServerStatus: (
    id: string,
    status: McpServerStatus,
    error?: string,
    options?: UpdateServerStatusOptions,
  ) => void;
  beginServerStatusListRefresh: (mode?: ZCodeMcpListMode) => number;
  markServerStatusListRefreshFailed: (
    error: string,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  mergeServerStatusSnapshots: (
    statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: "connect" | "status",
  ) => void;
  getServer: (id: string) => ZCodeMcpServer | undefined;
  setCurrentProjectPath: (
    path: string,
    workspaceIdentity?: string,
    directoryService?: McpDirectoryService | null,
    authorityKey?: string,
  ) => void;
  getEnabledMcpServersForZCode: (provider: string) => ZCodeAgentMcpServer[];
  checkAllServerStatus: (tester: (config: McpServerConfig) => Promise<{ success: boolean; error?: string }>) => Promise<void>;
  mergePreloadedMcpServers: (preloaded: Record<string, McpServerConfig>) => void;
  deletePreloadedMcpServer: (source: McpSource, name: string) => void;
  setCurrentSessionId: (sessionId: string | null) => void;
  migrateLegacyCommonMcp: () => Promise<MigrateLegacyResult>;
}

// [契约] 闭包内的 loadMcpPromise、loadMcpWorkspaceKey、epochs 是唯一并发闸门，禁止下沉到组件。
// [失败路径] 把它们搬进 store state 会让每次 set 触发订阅重渲染并改变闸门语义。
// [并发] set 与 get 必须成对使用：写入前用 get() 读最新值，不能用闭包快照。
// [权衡] 单 store 承载全部 MCP 视图态：拆分会引入双份 epoch 与双份 nativeServers。
// [边界] 该闭包不持有 AbortSignal，取消由上层调用方负责。
export const useMcpStore = create<McpStoreState>((set, get) => {
  // [契约] loadMcpPromise 表示「当前在飞的目录加载」，结束后必须置回 null。
  // [契约] loadMcpWorkspaceKey 与 promise 同生命周期，二者不能只清一个。
  // [失败路径] 只清 promise 会留下陈旧 key，后续同 workspace 调用会 await 一个已结束的 promise。
  // [并发] 判断顺序固定为：同 key 复用 → 不同 key 等待 → 再抢锁。
  // [边界] 该闸门只覆盖目录加载，不覆盖状态列表刷新。
  let loadMcpPromise: Promise<boolean> | null = null;
  let loadMcpWorkspaceKey: string | null = null;
  // [契约] connect 与 status 各自独立计数，任何一方递增都不得影响另一方。
  // [失败路径] 合并成单计数会让 OAuth 1s 轮询把正在进行的全量 list 判为过期。
  // [并发] 读改写必须同步完成，中间不能 await，否则两个请求拿到同一 epoch。
  // [权衡] 用 number 递增而非 Symbol：epoch 需要跨闭包比较且便于日志排查。
  // [边界] 不处理数值溢出，进程生命周期内到不了安全整数上限。
  const statusListEpochs: Record<ZCodeMcpListMode, number> = {
    connect: 0,
    status: 0,
  };

  // [契约] 任何配置 mutation 都必须先作废两条链路的 epoch，再写盘与 set。
  // [失败路径] 顺序颠倒会让在飞的旧响应在新配置落地后回填。
  // [并发] 必须同步递增，不得包在 Promise 里。
  // [边界] 只递增计数，不主动发起刷新。
  function invalidateStatusListRequests(): void {
    statusListEpochs.connect += 1;
    statusListEpochs.status += 1;
  }

  // [契约] 目录服务只在「有 workspaceIdentity」时启用，本地 workspace 必须走平台路径。
  // [失败路径] 本地也返回目录服务会跳过 desktop 上旧 common MCP 到用户级的迁移。
  // [并发] 默认值取 get().currentWorkspaceIdentity，必须在调用时读取而不是定义时。
  // [权衡] identity 优先于 path：远程 workspace 路径可能重名。
  // [边界] 传入的 directoryService 优先于注入单例，允许单次调用覆盖。
  function resolveMcpDirectoryService(
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string | null,
  ): McpDirectoryService | null {
    const effectiveWorkspaceIdentity = workspaceIdentity ?? get().currentWorkspaceIdentity;
    if (!effectiveWorkspaceIdentity?.trim()) {
      // 本地 workspace 仍要走 desktop platform 路径，才能执行旧 common MCP
      // 到用户级 ZCode Agent MCP 的迁移；目录服务只用于远端 workspace 覆盖路由。
      return null;
    }
    return directoryService ?? mcpDirectoryService;
  }

  // [契约] commitState 是唯一允许从 config/nativeServers 重算 servers 的入口。
  // [契约] 未传的字段必须沿用当前 state，不能退化为默认值。
  // [失败路径] 直接展开 partial 会丢掉未涉及的字段，导致整表被清空。
  // [并发] 内部用 get() 取当前值，保证与最近一次 set 一致。
  // [边界] 它不写盘，只产出下一个 state 片段。
  function commitState(partial: { config?: McpConfig; nativeServers?: NativeMcpServerRecord[] }): Partial<McpStoreState> {
    const state = get();
    const nextConfig = partial.config ?? state.config;
    const nextNativeServers = partial.nativeServers ?? state.nativeServers;
    return {
      config: nextConfig,
      nativeServers: nextNativeServers,
      servers: buildServerList(nextConfig, nextNativeServers, state.enabledStates, state.deletedPreloadMcpServers, state.servers),
    };
  }

  // [契约] 命中已有记录时只替换 config，保留 enabled/scope/projectPath 等既有字段。
  // [契约] 未命中时必须 push 新记录，scope 由 projectPath 是否存在推导。
  // [失败路径] 用整体替换会重置 enabled，用户刚关掉的服务器被重新打开。
  // [并发] 先 slice 再改再 set，禁止原地修改 state 中的数组。
  // [边界] 匹配键是 source+name+projectPath 三元组，缺一不可。
  function updateNativeServer(source: CliMcpSource, name: string, config: McpServerConfig, projectPath?: string) {
    const nativeServers = get().nativeServers.slice();
    const targetIndex = nativeServers.findIndex((server) => server.source === source && server.name === name && server.projectPath === projectPath);
    if (targetIndex >= 0) {
      const existing = nativeServers[targetIndex];
      if (!existing) {
        return;
      }
      nativeServers[targetIndex] = {
        ...existing,
        config,
      };
    } else {
      // 添加新的服务器记录
      const scope: McpScope = projectPath ? "workspace" : "user";
      nativeServers.push({
        source,
        scope,
        name,
        config,
        enabled: true,
        projectPath,
      });
    }
    set(commitState({ nativeServers }));
  }

  // [契约] 写盘失败只告警、不抛出：本地状态已推进，抛出会让内存与磁盘长期分叉。
  // [失败路径] 让错误冒泡会打断 mutation 链，后续 updateNativeServer 不再执行。
  // [并发] 该函数 await 写盘，调用方必须按「先落盘后 set」的顺序使用。
  // [权衡] 不做重试：重复写同一份配置会放大竞态，交由下一次用户操作自然修复。
  // [边界] 目录服务在此处按当前 workspace 重新解析，不复用入参。
  async function persistScopedChange(
    source: McpSource,
    payload: { action: "upsert" | "delete"; source: CliMcpSource; name: string; config?: McpServerConfig; projectPath?: string },
  ): Promise<void> {
    // [契约] 内置 mcp 源不写用户目录，直接早退。
    // [失败路径] 去掉早退会把内置源复制进用户级配置，重启后出现重名服务器。
    // [权衡] 判断用 source 而非 targetSource：映射后的 zcodeagentmcp 必须可写。
    // [边界] 早退发生在任何 IO 之前，保证零副作用。
    if (source === "mcp") {
      return;
    }

    await persistCliMcpToUserDirectory(
      mcpPlatformService,
      payload,
      resolveMcpDirectoryService(),
    ).catch((error) => {
      logger.warn(`[mcpStore] persist ${source} MCP failed`, String(error));
    });
  }

  return {
    config: { ...DEFAULT_MCP_CONFIG },
    nativeServers: [],
    servers: [],
    statusSnapshots: {},
    currentProjectPath: "",
    currentWorkspaceIdentity: undefined,
    currentAuthorityKey: undefined,
    enabledStates: {},
    deletedPreloadMcpServers: new Set(),
    isConfigLoaded: false,
    currentSessionId: null,

    loadConfig: () => {
      const config = loadPersistedConfig();
      // MCP 启停状态已经迁移到 ~/.zcode/cli/config.json，不能再读取旧 localStorage，
      // 否则旧的本地开关会覆盖新的 ZCode Agent 配置来源。
      // [契约] 启停状态一律从 ZCode Agent 配置推导，禁止再读旧 localStorage 开关。
      // [失败路径] 读取旧开关会用过期值覆盖新的配置来源，表现为「改了又不生效」。
      // [权衡] 局部空表 + buildServerList 推导，比在此逐条 merge 更不易漏源。
      // [边界] deletedPreload 仍从独立的 deleted key 恢复。
      // [资源] 该 key 只用于本次初始化，不进入持久化投影。
      const enabledStates: Record<string, boolean> = {};
      const deletedPreload = new Set<string>(safeReadJson<string[]>(MCP_DELETED_PRELOAD_KEY, []));
      const servers = buildServerList(config, [], enabledStates, deletedPreload, []);
      set({ config, nativeServers: [], enabledStates, deletedPreloadMcpServers: deletedPreload, servers, statusSnapshots: {}, isConfigLoaded: true });
    },

    // [契约] 该 action 是唯一从目录读取 MCP 配置的入口，返回布尔表示是否已成功载入。
    // [契约] 返回 false 只表示「不要当作已就绪」，不表示配置为空。
    // [失败路径] 用空数组冒充成功会让上层下发空 mcpServers，触发 replace 断开在跑的 MCP。
    // [并发] 必须在第一个 await 之前算完全部 key，保证去重判定基于同一快照。
    // [边界] 非浏览器环境直接返回 false。
    loadMcpFromUserDirectory: async (directoryService, workspaceIdentity, authorityKey) => {
      if (typeof window === "undefined") {
        return false;
      }

      const requestWorkspacePath = get().currentProjectPath || undefined;
      const requestWorkspaceIdentity = workspaceIdentity ?? get().currentWorkspaceIdentity;
      // [契约] workspaceKey 固定为 authorityKey（缺省 workspace）+ NUL + identity（缺省 path）。
      // [失败路径] 用冒号或横线连接会让不同组合拼出同一字符串，造成跨 workspace 串读。
      // [权衡] authority 缺省写成常量 workspace，保证本地与远程 key 空间不冲突。
      // [并发] request* 三个变量必须在同一同步段内取齐。
      // [边界] key 只用于比较与去重，不参与持久化。
      const requestAuthorityKey = authorityKey ?? get().currentAuthorityKey;
      const requestWorkspaceKey = `${requestAuthorityKey?.trim() || "workspace"}\0${requestWorkspaceIdentity?.trim() || requestWorkspacePath || ""}`;
      if (loadMcpPromise && loadMcpWorkspaceKey === requestWorkspaceKey) {
        return await loadMcpPromise;
      }
      if (loadMcpPromise) {
        await loadMcpPromise;
      }

      const latestWorkspacePath = get().currentProjectPath || undefined;
      const latestWorkspaceIdentity = get().currentWorkspaceIdentity;
      const latestAuthorityKey = get().currentAuthorityKey;
      const latestWorkspaceKey = `${latestAuthorityKey?.trim() || "workspace"}\0${latestWorkspaceIdentity?.trim() || latestWorkspacePath || ""}`;
      // [契约] 等待上一轮加载后必须重新计算 latest key，与请求 key 不一致就放弃。
      // [失败路径] 不比较会把 B 的目录服务用来读 C，越权读取并写脏共享 store。
      // [并发] 这是「等待后再判」的第二次闸门，不能与第一次合并。
      // [权衡] 返回 false 而不是抛错：切换 workspace 不是异常路径。
      // [边界] 放弃后由 C 自己的 ensure/load 调用收尾。
      if (latestWorkspaceKey !== requestWorkspaceKey) {
        // 该调用等待上一轮 load 时已从 B 切到 C；B 调用持有的 remote
        // directoryService 不得继续读取 C，交给 C 自己发起的 ensure/load 调用处理。
        return false;
      }
      // 等待上一 workspace load 期间可能再次切换；目录服务必须按等待后的
      // 最新 identity 重新选择，不能拿 B 的 remote service 去读取 C 的路径。
      const activeDirectoryService = resolveMcpDirectoryService(
        directoryService,
        latestWorkspaceIdentity,
      );
      if (loadMcpPromise && loadMcpWorkspaceKey === latestWorkspaceKey) {
        return await loadMcpPromise;
      }

      // [契约] 先写 key 再建 promise，保证 finally 之前其它调用看到同一闸门。
      // [失败路径] 顺序颠倒会让第二个调用看到 promise 却读到旧 key，重复发起加载。
      // [并发] 赋值与 promise 创建之间不得 await。
      // [边界] key 必须用 latest 而非 request 值。
      loadMcpWorkspaceKey = latestWorkspaceKey;
      loadMcpPromise = (async () => {
        try {
          logger.info(
            `[mcpStore] loadMcpFromUserDirectory workspace=${latestWorkspacePath ?? "<none>"} identity=${latestWorkspaceIdentity ?? "<none>"}`,
          );
          let servers = await fetchNativeMcpServers(
            mcpPlatformService,
            { workspacePath: latestWorkspacePath },
            activeDirectoryService,
          );
          if (!activeDirectoryService) {
            servers = await migrateStoredCommonMcpToZCodeAgent(
              mcpPlatformService,
              servers,
              latestWorkspacePath,
            );
          }
          const currentState = get();
          const currentWorkspaceKey = `${currentState.currentAuthorityKey?.trim() || "workspace"}\0${currentState.currentWorkspaceIdentity?.trim() || currentState.currentProjectPath}`;
          // [契约] 异步读取返回后必须用当前 state 再算一次 key 并比较。
          // [失败路径] 不比较会把 A 的 env/header/OAuth secret 写进 B 的共享 store。
          // [权衡] 丢弃而不是排队重试：C 自己的调用会拿到正确结果。
          // [并发] 该判定必须发生在 set 之前的最后一步。
          // [边界] 比较用 authority+identity（缺省 path），与请求 key 同一构造。
          if (currentWorkspaceKey !== latestWorkspaceKey) {
            // workspace A 的异步目录读取可能晚于切换到 B 才返回；
            // 旧结果包含 env/header/OAuth secret，不能写回共享 store 后被 B 的 Agent 消费。
            return false;
          }
          set(commitState({ nativeServers: servers }));
          return true;
        } catch (e) {
          // 读取失败不是“配置为空”；调用方必须保持 workspace not-ready，
          // 否则会显式下发空 mcpServers 并触发 replace，断开仍在运行的 MCP。
          // remote session attachment 绑定前只能拿到断连代理；这是初始化时序，不是
          // MCP 配置读取失败。只过滤该精确错误码，避免吞掉真实的目录或 RPC 故障。
          if (!isRemoteWorkspaceDisconnectedError(e)) {
            logger.warn("[mcpStore] loadMcpFromUserDirectory failed", String(e));
          }
          return false;
        } finally {
          loadMcpPromise = null;
          loadMcpWorkspaceKey = null;
        }
      })();

      return await loadMcpPromise;
    },

    // [契约] 该 action 负责「确保指定 workspace 已加载」：必要时先切上下文再 load。
    // [契约] 切换判定必须同时比较 path、identity、authority 三者。
    // [失败路径] 只比较 path 会让远程换账号后沿用上一账号的配置。
    // [并发] 先 setCurrentProjectPath 再 load，保证 load 读到的是新 key。
    // [边界] 未初始化配置时先同步 loadConfig。
    ensureLoadedForWorkspace: async (workspacePath, directoryService, workspaceIdentity, authorityKey) => {
      if (!get().isConfigLoaded) {
        get().loadConfig();
      }

      const normalizedWorkspacePath = workspacePath ?? "";
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      const normalizedAuthorityKey = authorityKey?.trim() || undefined;
      if (
        normalizedWorkspacePath !== get().currentProjectPath ||
        normalizedWorkspaceIdentity !== get().currentWorkspaceIdentity ||
        normalizedAuthorityKey !== get().currentAuthorityKey
      ) {
        get().setCurrentProjectPath(
          normalizedWorkspacePath,
          normalizedWorkspaceIdentity,
          directoryService,
          normalizedAuthorityKey,
        );
      }

      return await get().loadMcpFromUserDirectory(
        directoryService,
        normalizedWorkspaceIdentity,
        normalizedAuthorityKey,
      );
    },

    saveConfig: () => {
      const { deletedPreloadMcpServers } = get();
      safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(deletedPreloadMcpServers));
    },

    addMcpServer: (name, config) => get().addZCodeAgentMcpServer(name, config),
    updateMcpServer: (name, config) => get().updateZCodeAgentMcpServer(name, config),
    deleteMcpServer: (name) => get().deleteZCodeAgentMcpServer(name),
    addScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 设置页保存后会马上触发 agent 侧 mcp/list 重连。
      // 先等配置落盘，再更新本地 store，避免 agent 读到旧 timeoutMs 后展示旧健康状态。
      await persistScopedChange(targetSource, { action: "upsert", source: targetSource, name, config, projectPath });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    updateScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 修复原因同新增：本地状态变化会驱动健康状态刷新，必须在磁盘配置更新后发生。
      await persistScopedChange(targetSource, { action: "upsert", source: targetSource, name, config, projectPath });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    deleteScopedMcpServer: (source, name, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      persistScopedChange(targetSource, { action: "delete", source: targetSource, name, projectPath });
      set(commitState({
        nativeServers: get().nativeServers.filter((server) => !(server.source === targetSource && server.name === name && server.projectPath === projectPath)),
      }));
    },
    addClaudeCliMcpServer: (name, config, projectPath) => get().addScopedMcpServer("claudeclimcp", name, config, projectPath),
    updateClaudeCliMcpServer: (name, config, projectPath) => get().updateScopedMcpServer("claudeclimcp", name, config, projectPath),
    deleteClaudeCliMcpServer: (name, projectPath) => get().deleteScopedMcpServer("claudeclimcp", name, projectPath),
    addGeminiCliMcpServer: (name, config, projectPath) => get().addScopedMcpServer("geminiclimcp", name, config, projectPath),
    updateGeminiCliMcpServer: (name, config, projectPath) => get().updateScopedMcpServer("geminiclimcp", name, config, projectPath),
    deleteGeminiCliMcpServer: (name, projectPath) => get().deleteScopedMcpServer("geminiclimcp", name, projectPath),
    addCodexCliMcpServer: (name, config, projectPath) => get().addScopedMcpServer("codexclimcp", name, config, projectPath),
    updateCodexCliMcpServer: (name, config, projectPath) => get().updateScopedMcpServer("codexclimcp", name, config, projectPath),
    deleteCodexCliMcpServer: (name, projectPath) => get().deleteScopedMcpServer("codexclimcp", name, projectPath),
    addOpenCodeMcpServer: (name, config, projectPath) => get().addScopedMcpServer("opencodemcp", name, config, projectPath),
    updateOpenCodeMcpServer: (name, config, projectPath) => get().updateScopedMcpServer("opencodemcp", name, config, projectPath),
    deleteOpenCodeMcpServer: (name, projectPath) => get().deleteScopedMcpServer("opencodemcp", name, projectPath),
    addZCodeAgentMcpServer: (name, config, projectPath) => get().addScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    updateZCodeAgentMcpServer: (name, config, projectPath) => get().updateScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    deleteZCodeAgentMcpServer: (name, projectPath) => get().deleteScopedMcpServer("zcodeagentmcp", name, projectPath),

    // [契约] 启停必须先持久化再更新本地，因为 agent 会立刻按磁盘配置重连。
    // [失败路径] 先改本地会让 agent 读到旧开关，UI 显示与真实连接不一致。
    // [并发] 进入即作废 epoch，避免在飞的状态响应回填旧开关。
    // [权衡] 持久化失败仅告警、本地仍切换：用户意图优先，下次重连可自愈。
    // [边界] 内置 mcp 源不写盘，但仍要更新本地投影。
    toggleServer: async (id, enabled) => {
      invalidateStatusListRequests();
      const targetServer = get().servers.find((server) => server.id === id);
      if (targetServer && targetServer.source !== "mcp") {
        // 开关变化会触发 agent 侧 mcp/list 读取磁盘配置做真实连接。
        // 必须先等 enable 状态落盘，再更新本地列表驱动刷新，否则 agent 会读到旧开关。
        await persistCliMcpToUserDirectory(mcpPlatformService, {
          action: "set-enabled",
          source: targetServer.source,
          name: targetServer.name,
          enabled,
          projectPath: targetServer.projectPath,
          location: targetServer.location,
        }, resolveMcpDirectoryService()).catch((error) => {
          logger.warn("[mcpStore] persist MCP enabled override failed", String(error));
        });
      }

      set((state) => {
        const nextEnabledStates = { ...state.enabledStates, [id]: enabled };
        return {
          enabledStates: nextEnabledStates,
          servers: state.servers.map((s) => (s.id === id ? { ...s, enabled } : s)),
        };
      });
    },

    // [契约] 状态更新必须清空 authorization/serverRequestId，非 connected 时清 toolCount。
    // [失败路径] 残留上一次的 authorization 会让 UI 显示已授权但实际需重新登录。
    // [契约] failureKind 只在 error 时写 connection_failed，其余必须清空。
    // [并发] 请求是否作废由调用方控制，这里不自行比较 epoch。
    // [边界] lastConnected 只在 connected 时刷新，changed 只在 error 时保留。
    updateServerStatus: (id, status, error, options) => {
      if (options?.invalidateStatusListRequests !== false) {
        invalidateStatusListRequests();
      }
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id
            ? {
                ...s,
                status,
                authorization: undefined,
                error,
                failureKind: status === "error" ? "connection_failed" : undefined,
                serverRequestId: undefined,
                toolCount: status === "connected" ? s.toolCount : undefined,
                changed: status === "error" ? s.changed : false,
                lastConnected: status === "connected" ? new Date() : s.lastConnected,
              }
            : s,
        ),
      }));
    },

    // [契约] connect 模式会先把「变更过或未知」的 zcodeagentmcp 投影成 connecting。
    // [失败路径] 对 status 模式也这么做会让 1s 轮询反复打断用户正在看的连接态。
    // [契约] status 模式只递增计数并立刻返回，不触碰 servers 与 authorization。
    // [并发] 递增与读取必须在同一同步段完成，返回值即本次请求的 epoch。
    // [边界] 该函数不发起任何网络请求。
    beginServerStatusListRefresh: (mode = "connect") => {
      statusListEpochs[mode] += 1;
      const requestEpoch = statusListEpochs[mode];
      if (mode === "status") {
        // OAuth 1s status-only 轮询只读取 runtime snapshot；不能反复清空
        // authorization/toolCount 或把用户同时编辑的其他 MCP 投影成 connecting。
        return requestEpoch;
      }
      // agent 侧 mcp/list 会等待所有 MCP 连接完成才返回；如果插件 MCP 还在 30s 超时中，
      // 修改 timeoutMs 后本地列表会长时间停在 unknown，看起来像没有立即重新检查。
      set((state) => ({
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (
            server.source !== "zcodeagentmcp" ||
            !enabled ||
            (!server.changed && server.status !== "unknown")
          ) {
            return server;
          }
          return {
            ...server,
            status: "connecting",
            authorization: undefined,
            error: undefined,
            failureKind: undefined,
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
      return requestEpoch;
    },

    // [契约] 非最新 epoch 或 status 模式的失败必须直接 return。
    // [失败路径] 去掉 epoch 比较会让迟到的失败覆盖已成功的新一轮结果。
    // [失败路径] 对 status 模式生效会清空 authorization 并把整列标红。
    // [边界] 只处理 zcodeagentmcp 且 enabled 且处于 connecting 的项。
    markServerStatusListRefreshFailed: (error, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode] || mode === "status") {
        // OAuth 轮询是只读的 best-effort status 请求；临时失败不能清空已有
        // authorization snapshot，也不能把同一列表中仍在连接的 MCP 批量标红。
        return;
      }
      set((state) => ({
        statusSnapshots: {},
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (
            server.source !== "zcodeagentmcp" ||
            !enabled ||
            server.status !== "connecting"
          ) {
            return server;
          }
          return {
            ...server,
            status: "error",
            authorization: undefined,
            error,
            failureKind: "status_unavailable",
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
    },

    // [契约] status 模式必须 merge 到既有快照，connect 模式必须整体替换。
    // [失败路径] status 也用替换会让只含 pending 子集的响应抹掉其它已知状态。
    // [契约] markMissingConnectingAsError 只在 connect 模式为真。
    // [失败路径] status 模式置真会把未出现在响应里的 MCP 误标为 agent 未返回。
    // [并发] epoch 不匹配直接丢弃，不产生任何 set。
    mergeServerStatusSnapshots: (statuses, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode]) {
        return;
      }
      set((state) => {
        const nextStatusSnapshots =
          mode === "status"
            ? { ...state.statusSnapshots, ...statuses }
            : statuses;
        return {
          statusSnapshots: nextStatusSnapshots,
          servers: mergeMcpServerStatusSnapshots(
            state.servers,
            nextStatusSnapshots,
            {
              // Bugfix：OAuth 轮询的 status-only 响应可能只包含 pending 子集。
              // 缺失项不能按全量 mcp/list 处理，否则会把其他 MCP 误标为 agent 未返回。
              markMissingConnectingAsError: mode !== "status",
            },
          ),
        };
      });
    },

    getServer: (id) => get().servers.find((s) => s.id === id),

    // [契约] 切换 workspace 必须清空 nativeServers 与 statusSnapshots，并重建 servers。
    // [失败路径] 保留旧 nativeServers 会把 A 的 env/header/OAuth 暴露给 B。
    // [契约] 只有 path、identity、authority 任一变化才算 workspaceChanged。
    // [并发] 赋值与重建必须在同一个 set 完成，避免中间态被订阅者看到。
    // [边界] 配置未加载时不自动触发 load。
    setCurrentProjectPath: (path, workspaceIdentity, directoryService, authorityKey) => {
      invalidateStatusListRequests();
      const {
        config,
        currentProjectPath,
        currentWorkspaceIdentity,
        currentAuthorityKey,
        deletedPreloadMcpServers,
        enabledStates,
        isConfigLoaded,
        nativeServers,
        servers,
      } = get();
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      const normalizedAuthorityKey = authorityKey?.trim() || undefined;
      const workspaceChanged =
        path !== currentProjectPath ||
        normalizedWorkspaceIdentity !== currentWorkspaceIdentity ||
        normalizedAuthorityKey !== currentAuthorityKey;
      const nextNativeServers = workspaceChanged ? [] : nativeServers;
      set({
        currentProjectPath: path,
        currentWorkspaceIdentity: normalizedWorkspaceIdentity,
        currentAuthorityKey: normalizedAuthorityKey,
        nativeServers: nextNativeServers,
        statusSnapshots: {},
        servers: buildServerList(
          config,
          nextNativeServers,
          enabledStates,
          deletedPreloadMcpServers,
          workspaceChanged ? [] : servers,
        ),
      });
      // [契约] 只有「已加载过配置」且「workspace 变了」才异步补载目录配置。
      // [失败路径] 未加载就补载会和首次 loadConfig 竞争，写出空配置。
      // [并发] 该调用是 fire-and-forget，但 load 内部有 key 闸门保证不重复。
      // [权衡] 不 await：setCurrentProjectPath 是同步 API，等待会阻塞 UI 切换。
      // [边界] 失败由 load 自身返回 false，不在此处处理。
      if (isConfigLoaded && workspaceChanged) {
        // 切换到远程 workspace 后配置加载是异步的；等待期间必须先清空 A 的
        // user-level MCP，不能把其 env/header/OAuth clientSecret 暂存为 B 的可发送配置。
        void get().loadMcpFromUserDirectory(directoryService, normalizedWorkspaceIdentity, normalizedAuthorityKey);
      }
    },

    // [契约] 只投影 zcodeagentmcp 源，其它 CLI 源一律不下发给 agent。
    // [失败路径] 同名按 priority 取高值；先到先得会让 user 覆盖 workspace。
    // [权衡] provider 参数保留占位，当前实现不区分 provider。
    // [资源] 只读当前 servers 与 enabledStates 快照，不触发额外加载。
    // [边界] workspace 作用域必须匹配当前 projectPath 才参与候选。
    getEnabledMcpServersForZCode: (_provider) => {
      const { servers, enabledStates, currentProjectPath } = get();
      const candidates = new Map<string, ZCodeMcpServer>();

      for (const server of servers) {
        const isEnabled = enabledStates[server.id] ?? server.enabled;
        if (!isEnabled) continue;
        if (server.source !== "zcodeagentmcp") continue;
        if (server.scope === "workspace" && server.projectPath !== currentProjectPath) continue;

        const existing = candidates.get(server.name);
        if (!existing || getServerPriority(server) > getServerPriority(existing)) {
          candidates.set(server.name, server);
        }
      }

      const result: ZCodeAgentMcpServer[] = [];
      for (const server of candidates.values()) {
        const zcodeAgentServer = convertToZCodeAgentMcpServer(server.name, server.config);
        if (zcodeAgentServer) result.push(zcodeAgentServer);
      }
      return result;
    },

    checkAllServerStatus: async (tester) => {
      for (const server of get().servers) {
        const isEnabled = get().enabledStates[server.id] ?? server.enabled;
        if (!isEnabled || (!server.changed && server.status !== "unknown")) continue;

        get().updateServerStatus(server.id, "connecting");
        try {
          const result = await tester(server.config);
          get().updateServerStatus(server.id, result.success ? "connected" : "error", result.success ? undefined : (result.error ?? "Connection failed"));
        } catch (e) {
          get().updateServerStatus(server.id, "error", String(e));
        }
      }
    },

    // `presetServers` 只在用户没删过且尚不存在时注入，避免复活已删条目。
    // [失败路径] 忽略 deleted 集合会让用户删掉的预置项每次启动复活。
    // [失败路径] 忽略 exists 会产生重复记录，列表出现同名两行。
    // [边界] 无任何新增时不 set，避免无意义重渲染。
    // [权衡] 注入的同时 fire-and-forget 写盘，保持与 scoped 新增同一语义。
    mergePreloadedMcpServers: (preloaded) => {
      const { deletedPreloadMcpServers, nativeServers } = get();
      const targetSource: CliMcpSource = "zcodeagentmcp";
      const nextNativeServers = nativeServers.slice();
      let changed = false;

      for (const [name, cfg] of Object.entries(preloaded)) {
        const serverId = makeServerId(targetSource, name);
        const exists = nextNativeServers.some((server) => server.source === targetSource && server.name === name && !server.projectPath);
        if (deletedPreloadMcpServers.has(serverId) || exists) continue;
        nextNativeServers.push({
          source: targetSource,
          scope: "user",
          name,
          config: cfg,
          enabled: true,
        });
        persistScopedChange(targetSource, { action: "upsert", source: targetSource, name, config: cfg });
        changed = true;
      }

      if (!changed) return;
      set(commitState({ nativeServers: nextNativeServers }));
    },

    deletePreloadedMcpServer: (source, name) => {
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      const key = makeServerId(targetSource, name);
      persistScopedChange(targetSource, { action: "delete", source: targetSource, name });
      set((state) => {
        const nextDeleted = new Set(state.deletedPreloadMcpServers);
        nextDeleted.add(key);
        safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(nextDeleted));
        const nextNativeServers = state.nativeServers.filter((server) => !(server.source === targetSource && server.name === name && !server.projectPath));
        return {
          deletedPreloadMcpServers: nextDeleted,
          nativeServers: nextNativeServers,
          servers: buildServerList(state.config, nextNativeServers, state.enabledStates, nextDeleted, state.servers),
        };
      });
    },

    setCurrentSessionId: (sessionId) => set({ currentSessionId: sessionId }),

    migrateLegacyCommonMcp: async () => {
      const result = await migrateLegacyCommonMcpFromDesktop(mcpPlatformService);
      const latestWorkspacePath = get().currentProjectPath || undefined;
      const currentNativeServers = get().nativeServers.length > 0
        ? get().nativeServers
        : await fetchNativeMcpServers(mcpPlatformService, { workspacePath: latestWorkspacePath });
      const migration = await importLegacyCommonServersToZCodeAgent(mcpPlatformService, result.servers ?? {}, currentNativeServers, result.sourcePath);
      if (migration.changed) {
        const servers = await fetchNativeMcpServers(mcpPlatformService, { workspacePath: latestWorkspacePath });
        set(commitState({ nativeServers: servers }));
      }
      return migration;
    },
  };
});
