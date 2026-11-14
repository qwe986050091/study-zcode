// ============================================================================
// McpSettingsSection —— MCP 设置页（本地 server 列表 / 插件托管 MCP / OAuth 轮询）
//
// 数据来源三分：mcpStore 持有服务端回写的真实 server 与 status snapshot；
// pluginManagementStore 持有插件声明或托管的内置 MCP；本组件只做投影、编排与展示。
// 所有写入（toggle/add/update/delete）都走 store action 落到 settings 文件，
// 读到的状态永远以服务端事实为准，本地不维护第二份 server 列表。
//
// 不变量表（本文件维持或依赖；每条都对应一种「换个写法就出错」的具体故障）：
// INV-1: activeWorkspaceKey 必须是 authority\0identity|path 的组合，且与 store 侧 key 完全同构。
//        破坏后果：只比 path 无法区分同一路径的 Source authority，远端与本地配置互相覆盖。
// INV-2: mcpStoreMatchesActiveWorkspace=false 时 servers 必须投影成空数组、statusSnapshots 成空对象。
//        破坏后果：过渡帧把 A 仓库的 MCP 配置与凭据渲染到 B 仓库页面，并可能随下次请求发往 B。
// INV-3: mcpProjectionReady 为 false 时只渲染 loading，绝不渲染空态文案。
//        破坏后果：配置尚未加载就显示「暂无 MCP」，用户会重复新建同名 server。
// INV-4: autoStatusListRefreshKey 在配置未就绪、无 path、无 server 列表键时必须是空串。
//        破坏后果：空 key 仍触发刷新会高频打 mcp/list，且 workspace 切换后命中错误的去重记录。
// INV-5: transitionMcpAutoStatusListRefreshKey 在 nextKey 为空时必须把 lastRefreshKey 清成空串。
//        破坏后果：保留 A 的去重键后回到 A 会被判为已刷新，列表与 OAuth 轮询永久停在 unknown。
// INV-6: 刷新请求只能经由 createMcpStatusListRefreshQueue 串行化，同一时刻最多一个 in-flight。
//        破坏后果：并发 mcp/list 的响应乱序合并，旧快照覆盖新快照，状态灯回退。
// INV-7: 队列 rerun 采用「读取 latestRun」而不是重放旧闭包，do/while 直到没有新请求。
//        破坏后果：重放旧闭包会把已切换 workspace 的请求再发一次，或丢掉最后一次用户刷新。
// INV-8: 每个请求在发送前、响应后、合并前都要校验 active/store/configReady 三个 key 一致。
//        破坏后果：跨 workspace 返回的 status 被写进当前仓库，连接状态与工具清单错位。
// INV-9: status-only 模式只用于 OAuth 轮询；普通刷新必须用默认 connect 模式。
//        破坏后果：轮询用 connect 会 replace 掉无关 MCP 的连接，用户的 server 被反复断开重连。
// INV-10: status 模式遇到 protocol unsupported 后必须置 ref + state 双向标记并停止全部轮询。
//         破坏后果：旧 Agent 每秒返回同一条协议错误，OAuth 永远推进不了，日志被刷满。
// INV-11: OAuth 轮询是 1s 定时 + 5 分钟 deadline 的有界循环，deadline 不随 snapshot merge 续期。
//         破坏后果：每次 merge 重建 deadline，慢请求会让轮询无限续命，永不停止。
// INV-12: follow-up 轮询最多 10 次，只在 workspaceKey 匹配时执行，到上限必须清空 follow-up。
//         破坏后果：无限重试把 OAuth 完成后的短暂断连拖成持续请求；跨 workspace 复用旧配置。
// INV-13: pending/follow-up 轮询的 cleanup 必须置 cancelled=true 并 clearTimeout。
//         破坏后果：workspace 切换后旧定时器仍触发，把 A 的 pending 集合发给 B。
// INV-14: 删除必须二次确认后才调用 deleteScopedMcpServer；取消时不得改动任何状态。
//         破坏后果：误触直接把凭据与配置一起删除，且没有撤销入口。
// INV-15: 编辑时必须按 server 的 scope 与 projectPath 反解 ownerScopeKey，而不是沿用父页面 scope。
//         破坏后果：在 A 页编辑属于 B 的 server，保存会写进 A 的配置，产生两份分叉配置。
// INV-16: 保存时 projectPath 只由 formScopeKey 决定（user 为 undefined），不读 currentProjectPath。
//         破坏后果：表单切到 user scope 时仍把文件写进工作区目录。
// INV-17: toggle 关闭或没有 workspacePath 时只写本地 unknown，且 invalidateStatusListRequests=false。
//         破坏后果：推进 epoch 会把刚返回的 mcp/list 判为过期并丢弃，界面一直转圈。
// INV-18: 打开后的 connecting 只是展示态，最终 connected/error 必须等 agent 回写。
//         破坏后果：renderer 浅检查会把不存在的 stdio command 标成 connected，用户点工具才报错。
// INV-19: 凭据类字段只允许由服务端返回的元信息渲染，任何状态都不得把 secret 回显到表单或列表。
//         破坏后果：密钥出现在 DOM 与截图里，且随日志或诊断包外泄。
// INV-20: 远端同步上下文中必须隐藏插件托管 MCP 列表，只展示远端可读写资源。
//         破坏后果：用户以为在管理远端，实际操作的是本机插件。
// ============================================================================
/* eslint-disable max-lines -- MCP 设置页集中维护列表、插件分组、表单入口和标题行模式切换，拆分会增加跨状态传递复杂度。 */
/**
 * MCP Settings Section
 *
 * Manages MCP server configuration in the settings page.
 * Supports the unified ZCode Agent MCP source backed by settings directories.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_PLUGIN_MCP_SERVER_ROW,
  testId,
} from "@zcode/shared/test-ids";
import type {
  RemoteTarget,
  ZCodeAvailablePluginSummary,
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpServer,
  ZCodeMcpServerStatusSnapshot,
  ZCodePluginInfo,
} from "@zcode/shared";
import {
  isZCodeAgentMcpStatusModeUnsupportedError,
  type IServiceAccessor,
  type IMcpSyncService,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { logger } from "@/logger.js";
import { McpServerForm } from "@/settings/McpServerForm.js";
import { McpServerList, McpStatusDot } from "@/settings/McpServerList.js";
import {
  formToConfig,
  type FormState,
  type McpEditorMode,
  type ServerScope,
} from "@/settings/mcpSettingsShared.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  buildPluginMcpServerItems,
  filterLocalMcpServers,
  groupPluginMcpServersByPlugin,
  type PluginMcpServerItem,
} from "@/settings/pluginManagedResourceGroups.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "@/settings/McpFailurePresentation.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { McpServersImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { RemoteSyncDialogs, shouldShowRemoteSyncActions } from "@/settings/RemoteSyncActions.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useConfigWorkspaceServices as useWorkspaceServices } from "@/workspace-config-catalog/index.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { ExternalLink, Import, Plus, UploadCloud } from "lucide-react";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import { selectPluginsForScope } from "@/settings/pluginCapabilityProjection.js";

// 默认 source 固定为 zcodeagentmcp：这是唯一由本页读写、且能安全下发 mcp/list 的来源。
// 若回退到 common 或其他来源，新建的 server 会写进不受本页 manage 的目录，
// 保存成功但列表里立刻找不到，用户会重复新建。
const DEFAULT_MCP_SOURCE: ServerScope = "zcodeagentmcp";
// 1 秒间隔是「用户刚完成浏览器授权就切回来能看到绿点」与「不过度打 agent」之间的折中；
// 更长会让用户以为授权失败，更短会在旧 Agent 上放大协议错误的频率。
const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS = 1_000;
// 5 分钟硬截止：OAuth 窗口通常不会更久，超过后继续轮询只是浪费请求，
// 且用户可能已经放弃授权，继续请求会让页面一直保持「等待中」的假象。
const MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS = 5 * 60_000;
// follow-up 只覆盖「回调完成 → MCP 重连」之间的短暂窗口，10 次（约 10 秒）足够；
// 无上限会把一次连接异常拖成整页持续轮询。
const MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS = 10;

// 把 now 作为可注入参数而不是直接调用 Date.now：
// 轮询边界（刚好到期 / 差 1ms）无法用真实时钟稳定复测，注入后单测才能覆盖边界，
// 也避免测试依赖真实 5 分钟等待。
export function createMcpOAuthAuthorizationStatusRefreshDeadline(
  now: () => number = Date.now,
): number {
  // 返回绝对时间戳而不是剩余毫秒：deadline 会在多次 setTimeout 之间复用，
  // 存剩余时间会在每次调度时被重新计算，慢请求反而延长窗口。
  return now() + MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS;
}

// 用 >= 而不是 >：到期瞬间就应该停止，否则 1 秒间隔的轮询会在边界上多打一轮，
// 单测里也会出现「同一时刻既过期又未过期」的摇摆。
// deadline 为 0（没有 pending 授权时）会被立即判为过期，这是调用方依赖的短路语义。
export function isMcpOAuthAuthorizationStatusRefreshExpired(
  deadline: number,
  now: () => number = Date.now,
): boolean {
  return now() >= deadline;
}

// 三种 outcome 必须互斥且穷尽，调用方据此决定「合并、丢弃还是永久降级」：
// stale-workspace 是正常竞态（不能报错），status-mode-unsupported 是能力缺失（必须停轮询），
// 其余异常走 reject 而不是塞进枚举，避免调用方把网络失败当成功处理。
export type McpServerStatusListRefreshOutcome =
  | "refreshed"
  | "stale-workspace"
  | "status-mode-unsupported";

export async function refreshMcpServerStatusList({
  beginServerStatusListRefresh,
  markServerStatusListRefreshFailed,
  mergeServerStatusSnapshots,
  getCurrentWorkspaceKey,
  mode,
  mcpServers,
  requestedWorkspaceKey,
  workspaceIdentity,
  workspacePath,
  mcpSyncService,
}: {
  beginServerStatusListRefresh: (mode?: ZCodeMcpListMode) => number;
  markServerStatusListRefreshFailed?: (
    error: string,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  mergeServerStatusSnapshots: (
    statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  getCurrentWorkspaceKey: () => string;
  mode?: ZCodeMcpListMode;
  mcpServers?: ZCodeAgentMcpServer[];
  requestedWorkspaceKey: string;
  workspaceIdentity?: string;
  workspacePath: string;
  // mcp/list 收敛到 IMcpSyncService——UI 不直接触达 zcodeAgentService。
  mcpSyncService: Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;
}): Promise<McpServerStatusListRefreshOutcome> {
  // 发送前先校验 workspace：请求可能是在上一次渲染里排进队列的，
  // 等到真正执行时用户已经切走，此时发出去只会拿到另一份配置的 status。
  // 没有 requestedWorkspaceKey 也直接返回，避免拿空 key 去调 agent。
  if (!requestedWorkspaceKey || getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
    return "stale-workspace";
  }
  // mode 缺省为 connect：只有 OAuth 轮询会显式传 status，普通刷新必须走 connect，
  // 否则新启用的 server 永远不会真正建立连接，列表一直是 disconnected。
  const refreshMode = mode ?? "connect";
  // epoch 在发请求之前自增并记下：响应回来时若 epoch 已被更新的请求推进，
  // store 会拒绝这次合并，防止乱序响应覆盖新状态。
  const requestEpoch = beginServerStatusListRefresh(refreshMode);
  try {
    const result = await mcpSyncService.listWorkspaceMcpServerStatuses({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(mode ? { mode } : {}),
    });
    // 响应回来后再校验一次：请求在飞行中用户可能已经切 workspace，
    // 此时直接合并会把 A 的连接状态写进 B 的 store。
    if (getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
      return "stale-workspace";
    }
    // 合并必须带 requestEpoch：store 用它拒绝过期响应，
    // 这里若传 0 或新 epoch，会把已经在飞行中被取代的旧结果写回去。
    mergeServerStatusSnapshots(result.statuses, requestEpoch, refreshMode);
    return "refreshed";
  } catch (error) {
    // 失败也要先判 workspace：切走后旧请求的报错与新页面无关，
    // 若照常标记失败，新页面的列表会被打上上一轮的错误状态。
    if (getCurrentWorkspaceKey() !== requestedWorkspaceKey) {
      return "stale-workspace";
    }
    // 只有 status 模式才可能是「旧 Agent 不支持」：connect 模式返回同类错误
    // 说明是真实配置问题，必须冒泡给调用方提示，而不是静默降级。
    if (refreshMode === "status" && isZCodeAgentMcpStatusModeUnsupportedError(error)) {
      return "status-mode-unsupported";
    }
    // 标记失败要在 rethrow 之前：store 需要把 loading 态收尾并记录错误，
    // 否则抛错路径上的列表会永久停在 refreshing。
    markServerStatusListRefreshFailed?.(
      error instanceof Error ? error.message : String(error),
      requestEpoch,
      refreshMode,
    );
    throw error;
  }
}

// pending 记录「上一轮还在等待授权的 server 集合」以及它属于哪个 workspace：
// 只有带上 workspaceKey，下一轮状态变化时才能判断这份集合还能不能复用。
// mcpServers 存副本而不是引用：store 合并 snapshot 会重建数组，
// 引用会让「上一轮的 pending 集合」被下一次合并悄悄改写。
export interface McpOAuthAuthorizationPendingRefresh {
  mcpServers: ZCodeAgentMcpServer[];
  pendingKey: string;
  workspaceKey: string;
}

// 自动刷新去重键的三态转换：空 key 表示「当前没有可刷新的配置」，
// 此时必须同时清掉 lastRefreshKey 并把 shouldRefresh 置 false，而不是保持旧值。
// 把转换抽成纯函数，是为了让「切走再切回」这条最容易出错的路径可以单独单测。
export function transitionMcpAutoStatusListRefreshKey(
  previousKey: string,
  nextKey: string,
): { lastRefreshKey: string; shouldRefresh: boolean } {
  if (!nextKey) {
    // workspace 切换会先清空 server/status；若空状态仍保留 A 的去重 key，
    // 回到相同配置的 A 时会被误判为已刷新，列表和 OAuth 轮询永久停在 unknown。
    // 这里不返回 shouldRefresh=true：空 key 阶段还没有可下发的 server 集合，
    // 提前发请求只会拿到一份空列表，把刚清空的状态又写一遍。
    return { lastRefreshKey: "", shouldRefresh: false };
  }
  return {
    lastRefreshKey: nextKey,
    shouldRefresh: previousKey !== nextKey,
  };
}

// follow-up 是 pending 结束后的有界补救窗口：OAuth 回调完成到 MCP 真正重连之间
// authorizationUrl 会先消失，若此时立刻停止轮询，UI 会卡在 connecting。
// refreshKey 把 workspace 与那次 pending 的标识、时间戳组合起来，作为 effect 的重启键；
// 它变化代表「这是一次新的补救」，effect 必须重建定时器而不是沿用旧计数。
export interface McpOAuthAuthorizationFollowupRefresh {
  mcpServers: ZCodeAgentMcpServer[];
  refreshKey: string;
  workspaceKey: string;
}

export function transitionMcpOAuthAuthorizationPendingRefresh({
  activeWorkspaceKey,
  existingFollowup = null,
  mcpServers,
  now = Date.now,
  pendingKey,
  previous,
}: {
  activeWorkspaceKey: string;
  existingFollowup?: McpOAuthAuthorizationFollowupRefresh | null;
  mcpServers: ZCodeAgentMcpServer[];
  now?: () => number;
  pendingKey: string;
  previous: McpOAuthAuthorizationPendingRefresh | null;
}): {
  followup: McpOAuthAuthorizationFollowupRefresh | null;
  pending: McpOAuthAuthorizationPendingRefresh | null;
} {
  // 没有 active workspace 时两种状态都必须清空：保留 pending 会让下一次
  // 切到别的仓库时误以为还有授权在进行，从而立刻启动一组针对旧配置的轮询。
  if (!activeWorkspaceKey) {
    return { followup: null, pending: null };
  }
  // 仍有 pending 授权时永远不进入 follow-up：pending 阶段已经由 1 秒轮询覆盖，
  // 两个 effect 同时跑会让请求量翻倍，还会互相把对方的 cancelled 标记当成卸载。
  if (pendingKey) {
    return {
      followup: null,
      pending: {
        mcpServers: [...mcpServers],
        pendingKey,
        workspaceKey: activeWorkspaceKey,
      },
    };
  }
  if (existingFollowup?.workspaceKey === activeWorkspaceKey) {
    // follow-up 自己的 status merge 会改变 servers/snapshot 并重跑 transition；
    // 同 workspace 的有界重试窗口必须保持同一对象，不能在首包后把自己 cleanup。
    // 返回同一个引用还让 effect 依赖比较成立：新对象会让 refreshKey 变化，
    // 每次 merge 都重启 10 次计数，有界窗口退化成无限轮询。
    return { followup: existingFollowup, pending: null };
  }
  // 没有上一轮 pending，或上一轮属于别的 workspace，就不启动 follow-up：
  // 跨 workspace 复用会把 A 的 server 名发给 B，B 侧要么报未知 server，要么误连同名服务。
  if (!previous || previous.workspaceKey !== activeWorkspaceKey) {
    return { followup: null, pending: null };
  }
  // 只有「pending 刚刚清空」这一条路径能生成 follow-up，且 refreshKey 带 now()：
  // 时间戳保证同一次 pending 结束后即使再次进入也得到不同的 key，
  // 让 effect 能区分「新的补救窗口」与「同一次窗口的重渲染」。
  return {
    followup: {
      mcpServers: [...previous.mcpServers],
      refreshKey: `${activeWorkspaceKey}:${previous.pendingKey}:${now()}`,
      workspaceKey: activeWorkspaceKey,
    },
    pending: null,
  };
}

// 队列只暴露 request 一个入口，内部状态（inFlight / latestRun / rerunAfterCurrent）
// 全部闭包在 createMcpStatusListRefreshQueue 里：调用方无法绕过串行化直接发请求，
// 也就不会出现两处各自持有 in-flight 标记、互相以为对方没在跑的情况。
interface McpStatusListRefreshQueue {
  request: (runLatest: () => Promise<void>) => Promise<void>;
}

/** 刷新来源：manual 是用户点了刷新按钮，auto 是列表/配置变化驱动的自动刷新。 */
export type McpStatusListRefreshTrigger = "auto" | "manual";

// 这个结构把所有「能不能发请求」的前置条件集中在一处，
// 而不是散落在 effect 的 if 里：新增条件时只改 resolve 函数，
// 手动刷新与自动刷新不会因为漏加判断而走出两条不同路径。
export interface McpStatusListRefreshInput {
  activeWorkspaceKey: string;
  activeWorkspacePath?: string;
  // configReadyWorkspaceKey 是「配置已确认加载完成」的 workspace 键，
  // 与 activeWorkspaceKey 不同：前者是事实，后者是用户当前选择，两者相等才允许发请求。
  configReadyWorkspaceKey: string;
  isConfigLoaded: boolean;
  serverStatusListKey: string;
  storeWorkspaceKey: string;
}

// 返回 undefined 表示可以发请求，其余字符串既是日志里的原因码，也是排查时唯一能区分
// 「按钮没反应」到底是没 workspace、配置没加载还是 store 未对齐的依据。
// 顺序即优先级：先排除 workspace 不一致，再谈加载态，日志里才不会出现自相矛盾的原因。
export function resolveMcpStatusListRefreshSkipReason({
  input,
  requestedWorkspaceKey,
  trigger,
}: {
  input: McpStatusListRefreshInput;
  requestedWorkspaceKey: string;
  trigger: McpStatusListRefreshTrigger;
}): string | undefined {
  // 空 workspace key 时 store 里可能还留着上一个仓库的 servers，
  // 此时必须直接拒绝，否则会用空 path 发起一次 mcp/list。
  if (!requestedWorkspaceKey) return "no-active-workspace";
  // 捕获时的 key 与当前入参不一致，说明这是一次已经过期的调用：
  // 继续发请求只会把旧仓库的结果写进当前投影。
  if (input.activeWorkspaceKey !== requestedWorkspaceKey) {
    return "workspace-changed";
  }
  // store 侧 key 与活动 key 不一致，代表目录还没切到目标仓库；
  // 此时下发的 server 集合属于旧仓库，agent 会把它们配到错误的工作区。
  if (input.storeWorkspaceKey !== requestedWorkspaceKey) {
    return "mcp-store-not-aligned";
  }
  // configReady 标记「该 workspace 的配置已读完」：未就绪就请求，
  // 拿回的状态会缺少用户刚保存的 server，界面看起来像保存没生效。
  if (input.configReadyWorkspaceKey !== requestedWorkspaceKey) {
    return "config-not-ready";
  }
  // 已就绪但全局配置尚未 loaded，属于加载中的过渡态；
  // 自动刷新可以等，手动刷新会被 handleManualRefresh 先补一次加载。
  if (!input.isConfigLoaded) return "config-not-loaded";
  // 没有 path 时 mcp/list 无法定位 settings 目录，发出去只会得到错误或被宿主拒绝。
  if (!input.activeWorkspacePath) return "no-workspace-path";
  // 只有宿主/插件内置 MCP、没有任何用户 MCP 时 serverStatusListKey 会是空串。
  // 自动刷新据此去重没问题，但用户点了刷新就必须真的发一次请求，否则按钮看起来完全没反应。
  // 注意这里只放行 manual，不放行「manual 但没 path」：前一条已经拦掉了无 path 的情况，
  // 放行顺序不能调换，否则手动刷新会用空 path 打一次请求。
  if (!input.serverStatusListKey && trigger !== "manual") {
    return "empty-status-list-key";
  }
  return undefined;
}

// 串行队列实现「合并 + 补跑最后一次」：同一时刻只有一个请求在飞，
// 期间到来的请求不排队逐个执行，只覆盖 latestRun，等当前请求结束后再跑最新的一次。
// 这样既避免并发 mcp/list 的乱序合并，也不会在连续刷新的场景下堆积请求。
export function createMcpStatusListRefreshQueue(): McpStatusListRefreshQueue {
  // inFlight 只用局部闭包持有，不放进 ref：ref 会在组件重挂载时保留旧 Promise，
  // 新实例会误以为已有请求在跑而永远不执行自己的第一次刷新。
  let inFlight: Promise<void> | null = null;
  // latestRun 保存「最近一次请求想要执行的动作」，它可能属于新的 workspace 或新的触发源，
  // 因此每次调用都必须覆盖写。
  let latestRun: (() => Promise<void>) | null = null;
  // rerunAfterCurrent 只是「有没有新请求插队」的标记，不记录次数：
  // 连续 10 次调用也只需要再跑一次最新状态。
  let rerunAfterCurrent = false;

  return {
    async request(runLatest) {
      // 先写 latestRun 再判断 inFlight：即便当前没有在跑的请求，
      // 后面 do/while 也会读到同一份函数，避免两处使用不同闭包。
      latestRun = runLatest;
      if (inFlight) {
        // 已有请求在飞时不直接 return，而是标记补跑并等待当前请求结束：
        // 直接 return 会让用户最后一次刷新被丢弃，界面停在上一轮结果。
        rerunAfterCurrent = true;
        await inFlight;
        return;
      }

      inFlight = (async () => {
        try {
          do {
            // 每轮先清标记再读 latestRun：顺序反过来会把本轮执行期间
            // 新到的请求也误判成本轮已覆盖，循环立即退出。
            rerunAfterCurrent = false;
            const run = latestRun ?? runLatest;
            // 取出后立刻置空：若 run 内部再次触发 request，新请求应进入下一轮，
            // 而不是被本轮重复执行一次。
            latestRun = null;
            await run();
          } while (rerunAfterCurrent);
        } finally {
          // finally 里清 inFlight 而不是成功分支：run 抛错时若不清，
          // 之后所有刷新都会卡在「已有请求在飞」并静默丢弃。
          inFlight = null;
        }
      })();

      // 返回同一个 Promise 给所有等待者：调用方 await 到的完成时刻一致，
      // 便于 handleManualRefresh 在请求真正结束后再收起 loading。
      await inFlight;
    },
  };
}

// 轮询只下发「仍在等待授权」的 server 子集，而不是全量：
// 全量会让 status-only 请求携带无关 server 名，旧 Agent 可能把它们当成待连接项。
// 判定同时看本地配置（server.authorization）与运行态 snapshot：两者更新时刻不同，
// 只看一边会在回调刚完成或刚发起的那一秒漏掉 server。
export function buildMcpOAuthAuthorizationStatusRefreshServers(
  servers: ZCodeMcpServer[],
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): ZCodeAgentMcpServer[] {
  // 先从运行态 snapshot 里收集 pending 名称：snapshot 由 agent 回写，
  // 比本地配置更接近真实连接状态，但可能比配置晚一帧。
  const pendingSnapshotNames = new Set(
    Object.entries(statusSnapshots)
      .filter(([, snapshot]) => Boolean(snapshot.authorization?.authorizationUrl))
      .map(([serverName]) => serverName),
  );
  const result: ZCodeAgentMcpServer[] = [];
  const seenNames = new Set<string>();

  for (const server of servers) {
    // 只处理本页可管理的 source 且已启用：未启用的 server 即使配置里留着
    // 上次的 authorizationUrl，也不应该被持续轮询，否则禁用后仍在后台请求。
    if (server.source !== "zcodeagentmcp" || !server.enabled) {
      continue;
    }
    // 两处任一存在 pending 即视为等待中：本地 authorization 能覆盖「刚点授权、
    // snapshot 还没回来」的窗口，snapshot 能覆盖「本地已清理、运行态仍在等回调」的窗口。
    const hasPendingAuthorization =
      Boolean(server.authorization?.authorizationUrl) || pendingSnapshotNames.has(server.name);
    if (!hasPendingAuthorization || seenNames.has(server.name)) {
      continue;
    }
    // 转换失败（配置缺 command/url 等）时跳过而不是发送原始配置：
    // agent 侧对非法配置会返回整体失败，一条坏配置会让同批其他 server 的状态也刷不出来。
    const zcodeAgentServer = convertToZCodeAgentMcpServer(server.name, server.config);
    if (!zcodeAgentServer) {
      continue;
    }
    // seenNames 防止同名 server 在 common 与 workspace 两个 scope 各存一份时被下发两次：
    // 重复名称会让 agent 的返回按名合并，后一条覆盖前一条，状态随机闪烁。
    seenNames.add(server.name);
    result.push(zcodeAgentServer);
  }

  return result;
}

// 轮询请求的参数由这个函数集中构造，保证所有调用点都显式带 mode: status。
// 直接内联写对象时很容易漏掉 mode，退化成 connect 后会把无关 MCP 重连一遍，
// 用户看到的是「授权期间其他 server 集体掉线」。
export function buildMcpOAuthAuthorizationStatusRefreshOptions(mcpServers: ZCodeAgentMcpServer[]): {
  mode: "status";
  mcpServers: ZCodeAgentMcpServer[];
} {
  return {
    // OAuth pending/follow-up/focus 刷新只读运行态，不能让 pending 子集进入 connect replace 路径。
    mode: "status",
    mcpServers,
  };
}

// 这个 key 是自动刷新的去重依据，必须覆盖「会影响连接状态」的全部输入：
// id、启用态、完整 config。少任何一项都会让用户在改了配置之后看不到刷新，
// 例如只取 id 时改 URL 不会重连，状态灯一直沿用旧连接。
export function buildMcpServerStatusListKey(servers: ZCodeMcpServer[]): string {
  return servers
    // 只看本页管理的 source：把其他来源也算进来会让 key 随无关配置变化，
    // 触发大量与 MCP 连接无关的重复刷新。
    .filter((server) => server.source === "zcodeagentmcp")
    .map((server) => {
      const enabledKey = server.enabled ? "enabled" : "disabled";
      // 用 JSON.stringify 而不是自定义摘要：配置字段会随协议演进增加，
      // 手写拼接必然漏字段，漏掉的字段改动不会触发刷新。
      return `${server.id}:${enabledKey}:${JSON.stringify(server.config)}`;
    })
    // 用 | 连接保持可读，便于日志里直接定位是哪个 server 触发的刷新。
    .join("|");
}

// 插件托管的 MCP 也要参与刷新去重：插件启用/禁用会启动或停止一组 server，
// 但它们的配置不在 mcpStore 的 servers 里，只靠上一个 key 永远发现不了变化。
// 三种来源（声明、运行态、宿主内置）都要进 key，任一变化都会改变实际连接集合。
export function buildPluginMcpServerStatusListKey(plugins: ZCodePluginInfo[]): string {
  return plugins
    .map((plugin) => {
      const declaredNames = plugin.declaredMcpServerNames ?? [];
      const runtimeNames = plugin.mcpServerNames;
      const hostNames = plugin.hostMcpServerNames ?? [];
      // 完全无贡献的插件返回空串，最后被 filter(Boolean) 去掉：
      // 让未安装或无 MCP 的插件不影响 key，否则安装任意插件都会触发一次无意义刷新。
      if (
        (!plugin.enabled && hostNames.length === 0) ||
        (declaredNames.length === 0 && runtimeNames.length === 0 && hostNames.length === 0)
      ) {
        return "";
      }
      // 名称数组排序后再拼接：插件声明顺序可能随版本变化，不排序会让 key
      // 在同一组 server 的情况下抖动，造成无意义的重复连接。
      const pluginKey = `${plugin.id}:${plugin.enabled ? "enabled" : "disabled"}:${[
        ...declaredNames,
      ]
        .sort()
        .join(",")}:${[...runtimeNames].sort().join(",")}`;
      // 宿主内置 MCP 单独加 host= 前缀而不是并入 runtimeNames：
      // 两者来源不同、连接主体也不同，混在一起会让「宿主升级新增了内置 server」
      // 被误判成插件声明变化，插件分组里会出现不该有的条目。
      return hostNames.length > 0
        ? `${pluginKey}:host=${[...hostNames].sort().join(",")}`
        : pluginKey;
    })
    .filter(Boolean)
    .join("|");
}

// 远端同步上下文里插件 MCP 列表必须隐藏：该列表来自本机 pluginManagementStore，
// 展示在远端页面上会让用户误以为正在管理远端资源，实际读写的是本机插件。
// 抽成 `shouldShowPluginMcpServersInMcpSettings` 而非内联取反，新增上下文时只改 1 处。
export function shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext: boolean): boolean {
  return !isRemoteSyncContext;
}

// pending key 决定「要不要启动/重启 1 秒轮询」：它必须只包含「等待授权的身份」，
// 不含 toolCount 等运行态细节，否则每次 status merge 都会改变 key，
// 轮询 effect 被反复重建，deadline 也跟着重算，5 分钟窗口永不结束。
export function buildPendingMcpOAuthAuthorizationRefreshKey(
  servers: ZCodeMcpServer[],
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): string {
  // 本地配置只取 source、enabled、authorizationUrl 与 startedAt：
  // startedAt 区分「同一次授权」与「重新发起授权」，后者需要重置轮询窗口。
  const localPendingKeys = servers
    .filter(
      (server) =>
        server.source === "zcodeagentmcp" &&
        server.enabled &&
        Boolean(server.authorization?.authorizationUrl),
    )
    .map((server) => `${server.id}:${server.authorization?.startedAt ?? ""}`);
  // 运行态 pending 用 serverName 而不是 id：snapshot 的键就是 agent 侧的名字，
  // 与本地 id 未必一致，取错字段会让两处 key 永远对不上，轮询反复重启。
  const runtimePendingKeys = Object.entries(statusSnapshots)
    .filter(([, snapshot]) => Boolean(snapshot.authorization?.authorizationUrl))
    .map(([serverName, snapshot]) => `${serverName}:${snapshot.authorization?.startedAt ?? ""}`);
  // Set 去重后仍保留首次出现顺序，key 在同样的 pending 集合下保持稳定；
  // 排序反而会把「本地先出现、运行态后补上」的先后丢失，无助于稳定性。
  return Array.from(new Set([...localPendingKeys, ...runtimePendingKeys])).join("|");
}

// 插件托管 MCP 是只读列表：没有开关、没有编辑，唯一动作是「打开授权页」。
// 之所以不提供 toggle：这些 server 的生命周期由插件启用态决定，UI 单独改会与
// 插件声明冲突，下次插件重载又被覆盖，用户会以为开关坏了。
function PluginMcpServerList({
  items,
  pluginListingById,
  onOpenAuthorization,
}: {
  items: PluginMcpServerItem[];
  pluginListingById: ReadonlyMap<string, ZCodeAvailablePluginSummary["listing"]>;
  onOpenAuthorization?: (item: PluginMcpServerItem) => void;
}) {
  const { intl } = useZCodeIntl();
  // 授权按钮的可见文字与 aria-label/title 共用同一份文案：
  // 分两次 formatMessage 一旦 key 不同，窄屏隐藏文字后读屏读到的说明与视觉不一致。
  const openAuthorizationLabel = intl.formatMessage({
    id: "settings.mcp.oauth.openAuthorization",
  });

  // 状态描述按「授权中 → 失败 → 活跃细分 → 插件禁用 → 不可用」的优先级判定，
  // 顺序不能调换：授权中如果先被判成 error，用户会去改配置而不是完成授权；
  // 插件禁用如果先被判成 disconnected，用户会反复点重连一个永远不会启动的 server。
  function resolveStatusDescription(item: PluginMcpServerItem): string {
    if (item.authorization?.authorizationUrl) {
      // 有授权链接时优先于任何 status 展示：此时 server 可能仍显示 connecting，
      // 但用户唯一能推进状态的动作是去浏览器完成授权，文案必须指向它。
      return intl.formatMessage({
        id: "settings.mcp.plugin.authorizationRequiredDescription",
      });
    }
    if (item.status === "error") {
      // 失败原因按 failureKind 映射而不是直接展示 error 字符串：
      // 原始错误可能是英文栈信息，给用户的可操作建议必须本地化。
      return intl.formatMessage({
        id: resolveMcpFailureMessageId(item.failureKind),
      });
    }
    if (item.active) {
      if (item.status === "connecting") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.connectingDescription",
        });
      }
      if (item.status === "connected") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.connectedDescription",
        });
      }
      if (item.status === "disconnected") {
        return intl.formatMessage({
          id: "settings.mcp.plugin.disconnectedDescription",
        });
      }
      return item.hostProvided
        ? intl.formatMessage(
            { id: "settings.mcp.host.activeDescription" },
            { pluginName: item.pluginName },
          )
        : intl.formatMessage({ id: "settings.mcp.plugin.activeDescription" });
    }
    if (!item.pluginEnabled) {
      // 插件被禁用是一个确定性状态，必须在「不可用」之前判断：
      // 否则用户只看到笼统的「不可用」，不知道去插件页启用就能恢复。
      return intl.formatMessage({
        id: "settings.mcp.plugin.disabledDescription",
      });
    }
    // 兜底文案只描述「当前不可用」，不猜测原因：
    // 这里剩下的情况包含未安装、未激活、宿主未注入等多种可能，猜错会误导排查方向。
    return intl.formatMessage({
      id: "settings.mcp.plugin.unavailableDescription",
    });
  }

  // 以 id 作为列表 key 而不是 runtimeServerName：
  // 插件升级可能改运行时名，用名字当 key 会让整行卸载重建，状态点闪一下。
  return (
    <SettingsResourceList
      items={items}
      getKey={(item) => item.id}
      renderItem={(item) => {
        // 描述只算一次并复用到状态点 reason 与下方文本：
        // 两处各算一次会在 intl 上下文切换的中间帧出现两种描述。
        const statusDescription = resolveStatusDescription(item);
        return (
          // data-mcp-* 属性是测试与诊断的稳定锚点：状态点、工具数与行身份都从这里读，
          // 不要再从 class 名或 DOM 结构推断，否则一次样式调整就会让诊断脚本失效。
          <div
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
            data-mcp-status={item.status ?? ""}
            data-mcp-tool-count={item.toolCount}
            data-testid={testId(TID_PLUGIN_MCP_SERVER_ROW, item.runtimeServerName)}
          >
            <div className="relative size-9 shrink-0" data-mcp-status-dot-placement="icon-corner">
              <PluginStoreAvatar
                item={{
                  name: item.pluginName,
                  listing: pluginListingById.get(item.pluginId),
                }}
                className="size-9 bg-background"
              />
              <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background">
                <McpStatusDot
                  // attention 由授权链接派生而不是 status：授权中 server 往往仍报
                  // connecting，只看 status 会把「等待用户操作」画成普通加载态，
                  // 用户就不会去点授权，页面停在 connecting 直到轮询超时。
                  status={item.status}
                  attention={Boolean(item.authorization?.authorizationUrl)}
                  disabled={!item.pluginEnabled}
                  reason={statusDescription}
                />
              </span>
            </div>
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.status === "error" ? (
                <McpFailurePresentation error={item.error} failureKind={item.failureKind} />
              ) : (
                <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
                  {statusDescription}
                </div>
              )}
            </div>
            {item.authorization?.authorizationUrl ? (
              <div className="flex min-w-0 max-w-full shrink-0 items-center gap-2">
                <Button
                  variant="link"
                  size="sm"
                  className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
                  aria-label={openAuthorizationLabel}
                  data-testid={testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, item.runtimeServerName)}
                  title={openAuthorizationLabel}
                  onClick={() => onOpenAuthorization?.(item)}
                >
                  <ExternalLink className="size-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{openAuthorizationLabel}</span>
                </Button>
              </div>
            ) : null}
          </div>
        );
      }}
    />
  );
}

// props 里同时存在 workspacePath 与 remoteSessionId 等多种入口，
// 是因为同一组件被本地设置页、远端设置页和标题行三处复用。
// 优先级由调用方在传参时决定，组件内不再二次判断「到底用哪个」：
// 一旦组件内也判断，就会出现两处规则不一致，切仓库后读到旧配置。
interface McpSettingsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  // remoteSessionId 存在时不再使用 workspacePath 构建服务：
  // 远端 MCP 必须走 session 通道，用本地 path 会尝试读写本机文件。
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  isWebRemoteControl?: boolean;
  // scopeFilter 只影响「新建表单默认落在哪个 scope」，
  // 不影响列表展示范围：列表始终展示 user + workspace 两份配置的并集。
  scopeFilter: "user" | "workspace";
  // parentScopeKey 是父级当前选中的作用域，编辑时必须用它反解 ownerScopeKey，
  // 不能直接用 scopeFilter 推断，否则会把 workspace 级的 server 保存到 user 级。
  parentScopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
  onOpenPluginStore?: () => void;
  showMarketplaceBreadcrumb?: boolean;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

// 组件体只做三件事：把两份 store 投影成当前 workspace 的视图数据、
// 用串行队列驱动 status 刷新、把写入动作转交给 store action。
// 任何「本地缓存一份 server 列表」的改动都会破坏 INV-2/INV-8，
// 因为 store 才是跨窗口合并与 epoch 校验的唯一持有者。
export function McpSettingsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  localWorkspacePath,
  isWebRemoteControl = false,
  scopeFilter,
  parentScopeKey,
  workspaceTabs,
  searchQuery,
  onVisibleCountChange,
  onEditorOpenChange,
  onFormScopeKeyChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  unscopedServices,
  cacheAuthorityKey,
}: McpSettingsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  // forceUnscoped 只在有 cacheAuthorityKey 时开启：
  // 该场景下服务必须走缓存 authority 而不是当前激活 workspace，
  // 否则后台缓存的 MCP 配置会被写到前台仓库的 settings 里。
  const services = useWorkspaceServices(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey) },
  );
  const platform = usePlatform();
  const baseServices = useBaseWorkspaceServices();

  // 选择器只取原始数组/对象，不在选择器里做过滤或映射：
  // zustand 用引用相等判断是否重渲染，选择器里新建数组会让每次 store 更新都触发渲染，
  // 在 status 每秒合并的场景下会把整页打满。
  const storedServers = useMcpStore((s) => s.servers);
  const storedStatusSnapshots = useMcpStore((s) => s.statusSnapshots);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const pluginStoreWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginStoreWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginStoreAuthorityKey = usePluginManagementStore((state) => state.authorityKey);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  // mcpStore 侧的三元组是「配置当前属于谁」，与 props 侧的 active 三元组分别读取：
  // 两者相等才允许投影，这个比较是 INV-2 的唯一实现点。
  const currentProjectPath = useMcpStore((s) => s.currentProjectPath);
  const currentWorkspaceIdentity = useMcpStore((s) => s.currentWorkspaceIdentity);
  const currentAuthorityKey = useMcpStore((s) => s.currentAuthorityKey);
  // tabStore 只作为 fallback：显式传 workspacePath 的调用方（远端、缓存）优先级更高，
  // 否则远端设置页会被本地激活 tab 覆盖，展示成完全无关的仓库。
  const storeActiveWorkspacePath = useTabStore((s) => s.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((s) => s.activeWorkspaceIdentity ?? undefined);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity;
  // key 由 authority + identity/path 组成，用 \0 分隔：
  // 用 | 或 : 分隔时路径里可能包含同样的字符，会拼出两个不同 workspace 的相同 key，
  // 后果是把一个仓库的 MCP 配置当成另一个仓库的。
  // 空 identity 时回退 path，是为了在未登录/无 identity 的本地场景仍能区分仓库。
  const activeWorkspaceKey = `${cacheAuthorityKey?.trim() || "workspace"}\0${activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""}`;
  // 这里必须用与 activeWorkspaceKey 完全相同的拼接规则，否则两边永远不相等，
  // 列表会一直投影成空数组，页面表现为「MCP 配置全丢了」。
  const currentMcpStoreWorkspaceKey = `${currentAuthorityKey?.trim() || "workspace"}\0${currentWorkspaceIdentity?.trim() || currentProjectPath}`;
  // 修复原因：active tab 会先于异步 MCP 目录加载切换；过渡帧不能把 A 的配置和
  // snapshot 投影到 B，更不能让后续 effect 把这些敏感配置发送给 B 的 Agent。
  // Boolean(activeWorkspaceKey) 不可省：两个空 key 相等，否则「尚未确定 workspace」
  // 会被判成匹配，从而把 store 里残留的上一个仓库配置展示出来。
  const mcpStoreMatchesActiveWorkspace =
    Boolean(activeWorkspaceKey) && currentMcpStoreWorkspaceKey === activeWorkspaceKey;
  // 不匹配时投影成空数组/空对象，而不是保留上一帧的引用：
  // 保留会让子组件用旧 servers 继续渲染，也会让后续 effect 把旧配置发出去。
  const servers = mcpStoreMatchesActiveWorkspace ? storedServers : [];
  const statusSnapshots = mcpStoreMatchesActiveWorkspace ? storedStatusSnapshots : {};
  const isConfigLoaded = useMcpStore((s) => s.isConfigLoaded);
  const ensureLoadedForWorkspace = useMcpStore((s) => s.ensureLoadedForWorkspace);
  const loadMcpFromUserDirectory = useMcpStore((s) => s.loadMcpFromUserDirectory);
  const toggleServer = useMcpStore((s) => s.toggleServer);
  const addScopedMcpServer = useMcpStore((s) => s.addScopedMcpServer);
  const updateScopedMcpServer = useMcpStore((s) => s.updateScopedMcpServer);
  const deleteScopedMcpServer = useMcpStore((s) => s.deleteScopedMcpServer);
  const updateServerStatus = useMcpStore((s) => s.updateServerStatus);
  const beginServerStatusListRefresh = useMcpStore((s) => s.beginServerStatusListRefresh);
  const markServerStatusListRefreshFailed = useMcpStore((s) => s.markServerStatusListRefreshFailed);
  const mergeServerStatusSnapshots = useMcpStore((s) => s.mergeServerStatusSnapshots);

  // 表单作用域初值取 parentScopeKey 的当前值，而不是每次都跟随它：
  // 父级 tab 切换时若强制同步，用户正在表单里选好的 scope 会被改掉，
  // 保存时写进非预期的配置文件。表单打开后由用户显式改。
  const [showForm, setShowForm] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState(parentScopeKey);
  // editingServer 非空即编辑态：它与 showForm 分开，才能区分「新建」与「编辑」，
  // 同时用 isFormView 把两者合并给父级，父级只关心「是否占用了内容区」。
  const [editingServer, setEditingServer] = useState<ZCodeMcpServer | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  const query = searchQuery;
  const [editorMode, setEditorMode] = useState<McpEditorMode>("form");
  // configReady 用「key」而不是布尔：布尔无法表达「这份就绪属于哪个 workspace」，
  // 切仓库后旧的就绪标记会让新仓库跳过配置加载，直接拿空配置去刷新。
  const [mcpConfigReadyWorkspaceKey, setMcpConfigReadyWorkspaceKey] = useState("");
  // follow-up 状态存整个对象而不是 count：refreshKey 变化代表新一次补救窗口，
  // effect 依赖它重建定时器；只存 count 无法区分「同一窗口内重渲染」与「新窗口」。
  const [mcpOAuthAuthorizationFollowupRefresh, setMcpOAuthAuthorizationFollowupRefresh] =
    useState<McpOAuthAuthorizationFollowupRefresh | null>(null);
  // ref 与 state 双份存「status 模式不支持」：
  // ref 供请求回调同步读取（避免闭包读到旧 state），state 供渲染展示禁用提示。
  // 只留其中一个会导致「提示不出现」或「停止轮询晚一拍」。
  const [mcpStatusOnlyUnsupported, setMcpStatusOnlyUnsupported] = useState(false);
  const mcpStatusOnlyUnsupportedRef = useRef(false);
  const isFormView = showForm || editingServer !== null;
  // `onEditorOpenChange` 同步 `isFormView`，父级隐藏列表标题与搜索框。
  // 放在 effect 里而不是 render 中，是为了避免在渲染阶段调用父级 setState
  // 触发 React 的「渲染期间更新另一个组件」警告与额外的重渲染。
  useEffect(() => {
    onEditorOpenChange?.(isFormView);
  }, [isFormView, onEditorOpenChange]);
  useEffect(
    () => () => {
      onEditorOpenChange?.(false);
    },
    [onEditorOpenChange],
  );
  // 用户 MCP 与插件 MCP 的 key 合成「一个」去重键，而不是各用各的：
  // 两者共享同一次 mcp/list（插件托管的 server 也必须下发），
  // 分开刷新会在插件启用时产生两次请求，两个响应互相覆盖状态。
  // filter(Boolean) 去掉空段，避免「只有插件没有用户 server」时 key 以 | 开头变化。
  const serverStatusListKey = useMemo(
    () =>
      [buildMcpServerStatusListKey(servers), buildPluginMcpServerStatusListKey(plugins)]
        .filter(Boolean)
        .join("|"),
    [plugins, servers],
  );
  // 队列实例用 ref 惰性创建，且不能在 render 里每次 new：
  // 每次渲染新建会让 inFlight 标记随之重置，串行化失效，并发请求又回来了。
  // 用条件赋值而不是 useMemo，是因为 useMemo 在并发渲染下可能被丢弃重算。
  const statusListRefreshQueueRef = useRef<McpStatusListRefreshQueue | null>(null);
  if (!statusListRefreshQueueRef.current) {
    statusListRefreshQueueRef.current = createMcpStatusListRefreshQueue();
  }
  const latestStatusListRefreshInputRef = useRef<{
    activeWorkspaceIdentity?: string;
    activeWorkspaceKey: string;
    activeWorkspacePath?: string;
    configReadyWorkspaceKey: string;
    storeWorkspaceKey: string;
    isConfigLoaded: boolean;
    serverStatusListKey: string;
  }>({
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    configReadyWorkspaceKey: mcpConfigReadyWorkspaceKey,
    isConfigLoaded,
    serverStatusListKey,
    storeWorkspaceKey: currentMcpStoreWorkspaceKey,
  });
  // 每次渲染都同步覆盖 ref，而不是只初始化一次：
  // 队列里的 runner 可能在若干次渲染之后才执行，它必须读到「执行这一刻」的
  // workspace/configReady 组合，才能通过 INV-8 的三 key 校验。
  latestStatusListRefreshInputRef.current = {
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    configReadyWorkspaceKey: mcpConfigReadyWorkspaceKey,
    isConfigLoaded,
    serverStatusListKey,
    storeWorkspaceKey: currentMcpStoreWorkspaceKey,
  };
  // 自动刷新的去重键必须把「workspace 身份」也编进去：
  // 只放 server 列表键时，两个仓库恰好有同名同配置的 server 会被判为已刷新，
  // 切过去后连接状态继承上一个仓库，显示成已连接但实际没连。
  // 五个前置条件任一不满足都返回空串（INV-4），空串在 transition 里会清空去重记录。
  const autoStatusListRefreshKey = useMemo(() => {
    if (
      // 配置未加载：此时 servers 还是空/旧值，据此发请求会拿到错误集合。
      !isConfigLoaded ||
      // 无路径：mcp/list 无法定位 settings，请求必然失败。
      !activeWorkspacePath ||
      // 无 workspace key：无法判断结果属于谁，也不能通过 INV-8 校验。
      !activeWorkspaceKey ||
      // 配置就绪标记不属于当前仓库，说明切换尚未完成，先等下一轮。
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      // 没有任何 MCP：没有可下发对象，请求只会返回空列表并重置状态。
      !serverStatusListKey
    ) {
      return "";
    }
    // 用 \n 分隔而不是 |：路径里可能含 |，而换行在路径与 server 名中都不可能出现，
    // 这样三段拼接不会产生歧义碰撞。
    return [activeWorkspaceIdentity ?? "", activeWorkspacePath, serverStatusListKey].join("\n");
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    isConfigLoaded,
    mcpConfigReadyWorkspaceKey,
    serverStatusListKey,
  ]);
  // key 与 servers 分成两个 memo：key 只有「pending 集合变化」才变，
  // servers 数组则可能每次 snapshot merge 都重建。合并成一个 memo 会让
  // 轮询 effect 的依赖每帧都变，1 秒轮询退化成「每次 merge 重启一次」。
  const pendingMcpOAuthAuthorizationRefreshKey = useMemo(
    () => buildPendingMcpOAuthAuthorizationRefreshKey(servers, statusSnapshots),
    [servers, statusSnapshots],
  );
  // 下发集合按当前 pending 过滤，避免把全部 server 名发给 status-only 请求：
  // 旧 Agent 对不认识的 server 会返回错误，整批状态都刷不出来。
  const pendingMcpOAuthAuthorizationRefreshServers = useMemo(
    () => buildMcpOAuthAuthorizationStatusRefreshServers(servers, statusSnapshots),
    [servers, statusSnapshots],
  );
  const pendingMcpOAuthAuthorizationRefreshDeadline = useMemo(
    () =>
      activeWorkspaceKey && pendingMcpOAuthAuthorizationRefreshKey
        ? createMcpOAuthAuthorizationStatusRefreshDeadline()
        : 0,
    // status snapshot merge 会重建 pending server 数组并重启轮询 effect；
    // deadline 只能随 workspace/pending 授权窗口变化，否则慢请求会不断续期 5 分钟窗口。
    [activeWorkspaceKey, pendingMcpOAuthAuthorizationRefreshKey],
  );
  // 上一轮 pending 集合只存在 ref 里：它只在 transition 计算与 effect 之间传递，
  // 不参与渲染；放进 state 会让每次 pending 变化多触发一轮渲染，
  // 而那一轮渲染又可能改变 memo，形成额外的心跳。
  const lastPendingMcpOAuthAuthorizationRefreshRef =
    useRef<McpOAuthAuthorizationPendingRefresh | null>(null);
  const lastAutoStatusListRefreshKeyRef = useRef("");
  const requestMcpServerStatusList = useCallback(
    async (options?: {
      mcpServers?: ZCodeAgentMcpServer[];
      mode?: ZCodeMcpListMode;
      trigger?: McpStatusListRefreshTrigger;
    }) => {
      // trigger 缺省为 auto：调用方忘记传时按自动处理，最坏结果是少一条手动刷新日志，
      // 反成 manual 会让 guard 走「无 key 也放行」的分支，发出不必要的请求。
      const trigger = options?.trigger ?? "auto";
      // requestedWorkspaceKey 在闭包创建时固化，后面所有校验都拿它做基准：
      // 这样即便 activeWorkspaceKey 在 await 期间变化，本次请求仍能识别为过期。
      const requestedWorkspaceKey = activeWorkspaceKey;
      // 输入快照取 ref 的当前值：调用方（定时器）可能在很久之后才执行到这里，
      // 直接读 props 闭包会拿到定时器创建时的旧 workspace。
      const requestedInput = latestStatusListRefreshInputRef.current;
      // 队列 runner 和 in-flight response 都可能跨 workspace 生命周期；
      // active/store/readiness 三个 key 必须仍一致，才能发送请求或合并结果。
      const getCurrentRefreshWorkspaceKey = () => {
        const latest = latestStatusListRefreshInputRef.current;
        return latest.activeWorkspaceKey === latest.storeWorkspaceKey &&
          latest.configReadyWorkspaceKey === latest.activeWorkspaceKey
          ? latest.activeWorkspaceKey
          : "";
      };
      // 「当前是否还是发起请求时的仓库」单独封装，因为它在四个位置被使用：
      // 入队前、runner 内、响应后、合并前。任何一处漏判都会让旧结果写进新仓库。
      const isRequestCurrent = () => getCurrentRefreshWorkspaceKey() === requestedWorkspaceKey;
      // skipReason 同时服务自动与手动两条路径，返回具体原因码：
      // 自动刷新静默丢弃，手动刷新会把它写进日志，避免「点了没反应又查不到」。
      const skipReason = resolveMcpStatusListRefreshSkipReason({
        input: requestedInput,
        requestedWorkspaceKey,
        trigger,
      });
      if (skipReason) {
        // 这些 guard 过去全是静默 return，用户点刷新后既没有请求也没有任何痕迹，
        // 复现时无法从日志判断"没发请求"还是"发了但读到旧状态"。
        if (trigger === "manual") {
          logger.warn("[mcp] manual status refresh skipped", {
            reason: skipReason,
            workspacePath: requestedInput.activeWorkspacePath,
          });
        }
        return;
      }
      // 已经确认旧 Agent 不支持 status 模式后，不再入队：
      // 继续入队会让队列每 1 秒执行一次注定失败的请求，还把手动刷新挤在后面。
      // 读 ref 而不是 state，是因为闭包创建时 state 可能还没更新到 true。
      if (options?.mode === "status" && mcpStatusOnlyUnsupportedRef.current) {
        return;
      }
      // 路径从快照取，不使用 activeWorkspacePath 变量：
      // 后者是本次渲染的值，而请求真正执行时可能已经切走，必须与 requestedInput 保持一致。
      const requestedWorkspacePath = requestedInput.activeWorkspacePath;
      // skipReason 已经覆盖了这个分支，这里只为类型收窄。
      if (!requestedWorkspacePath) return;
      // 显式传入 mcpServers 的调用方（OAuth 轮询）只带 pending 子集；
      // 其余调用方走 store 的 getEnabled 投影，而不是用组件里的 servers：
      // 组件 servers 可能被 scope 过滤，漏掉 user 级配置，导致状态刷新不完整。
      const requestedMcpServers =
        options?.mcpServers ?? useMcpStore.getState().getEnabledMcpServersForZCode("zcode");
      // 入队而不是直接 await 刷新：同一时刻只允许一个 mcp/list，
      // 队列会把期间到来的多次刷新合并成最后一次，避免响应乱序覆盖。
      await statusListRefreshQueueRef.current?.request(async () => {
        // runner 真正执行时可能已经排了很久，先确认目标仓库未变：
        // 不确认就用旧 path 发请求，agent 会把配置写进已关闭的仓库。
        if (!isRequestCurrent()) {
          return;
        }
        if (options?.mode === "status" && mcpStatusOnlyUnsupportedRef.current) {
          return;
        }

        // outcome 只有三种：refreshed 表示已合并，stale-workspace 表示要静默丢弃，
        // status-mode-unsupported 表示要永久降级。catch 里返回 "failed" 是为了让
        // 下面的 stale 判断不依赖异常类型，同时保证 promise 一定 resolve。
        const outcome = await refreshMcpServerStatusList({
          beginServerStatusListRefresh,
          getCurrentWorkspaceKey: getCurrentRefreshWorkspaceKey,
          markServerStatusListRefreshFailed,
          mergeServerStatusSnapshots,
          // 设置页列表可能来自 `.agents/mcp.json` fallback；agent 侧 mcp/list 自己
          // createConfig 读不到这批 UI-resolved MCP，必须和真实 session 一样显式下发。
          mcpServers: requestedMcpServers,
          mode: options?.mode,
          requestedWorkspaceKey,
          workspaceIdentity: requestedInput.activeWorkspaceIdentity,
          workspacePath: requestedWorkspacePath,
          mcpSyncService: services.mcpSyncService,
        }).catch((error) => {
          logger.warn("[mcp] list server statuses failed", {
            error: error instanceof Error ? error.message : String(error),
            workspacePath: requestedWorkspacePath,
          });
          if (trigger === "manual") {
            // Bugfix：手动刷新失败过去只进日志，用户看到的仍是旧状态且毫无提示。
            const message = error instanceof Error ? error.message : String(error);
            toast(intl.formatMessage({ id: "settings.mcp.refreshFailed" }, { error: message }), {
              durationMs: 8_000,
            });
          }
          return "failed" as const;
        });
        // 双重校验：outcome 自己判过一次 workspace，这里再按 ref 判一次。
        // 因为 refresh 内部判的是「发送时/合并时」，而这次判断覆盖「合并完成后到
        // 这里执行之间」的窗口，少了它仍可能把 A 的 failed 状态提示到 B 页面上。
        if (outcome === "stale-workspace" || !isRequestCurrent()) {
          return;
        }
        if (outcome === "status-mode-unsupported") {
          // 旧 Agent 会稳定拒绝 mode=status；继续 pending 定时器和焦点监听
          // 只会每秒制造同一条协议错误，且不可能推进 OAuth 状态。
          // 三件事必须同时做：置 ref 阻止后续 status 请求入队、清 lastPending 让
          // transition 不再生成 follow-up、清 state 停止已经挂着的 1 秒定时器。
          // 只置其中一个都会留下一条仍在跑的轮询链。
          mcpStatusOnlyUnsupportedRef.current = true;
          lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
          setMcpOAuthAuthorizationFollowupRefresh(null);
          setMcpStatusOnlyUnsupported(true);
          logger.warn("[mcp] status-only refresh unsupported; stop OAuth status polling", {
            workspacePath: requestedWorkspacePath,
          });
          toast(intl.formatMessage({ id: "settings.mcp.statusOnlyUnsupported" }), {
            durationMs: 8_000,
          });
        } else if (outcome === "refreshed" && options?.mode !== "status") {
          // 只有非 status 的成功刷新才清除「不支持」标记：
          // 该标记描述的是 Agent 能力，一次普通 connect 刷新成功即可证明 Agent 已升级；
          // 但 status 刷新本身成功时无需清，避免同一轮里反复切换提示。
          mcpStatusOnlyUnsupportedRef.current = false;
          setMcpStatusOnlyUnsupported(false);
        }
      });
    },
    [
      activeWorkspaceKey,
      beginServerStatusListRefresh,
      intl,
      markServerStatusListRefreshFailed,
      mergeServerStatusSnapshots,
      services.mcpSyncService,
    ],
  );

  const [refreshingStatusList, setRefreshingStatusList] = useState(false);
  // 刷新按钮过去点了没有任何可见反馈——请求可能被 guard 静默丢弃，也可能在飞行中。
  // 这里统一：先确保配置已加载，再以 manual 触发发一次请求，期间按钮进入 loading 态。
  const handleManualRefresh = useCallback(async () => {
    if (refreshingStatusList) return;
    setRefreshingStatusList(true);
    try {
      await loadMcpFromUserDirectory(
        services.mcpSyncService,
        activeWorkspaceIdentity,
        cacheAuthorityKey,
      );
      // 手动刷新要「先补加载再请求」：用户点击时配置可能还没读完，
      // 直接发请求会被 skipReason 判成 config-not-ready，按钮看起来完全没反应。
      // 只在 configReady 为空时补一次，已有就绪标记时不重复读文件。
      if (activeWorkspacePath && !mcpConfigReadyWorkspaceKey) {
        const loaded = await ensureLoadedForWorkspace(
          activeWorkspacePath,
          services.mcpSyncService,
          activeWorkspaceIdentity,
          cacheAuthorityKey,
        );
        // 加载完成后再从 store 读一次 key，而不是信任传入的 activeWorkspaceKey：
        // ensureLoaded 内部可能已经把 store 切到另一个仓库，此时标记就会张冠李戴。
        const state = useMcpStore.getState();
        const loadedWorkspaceKey = `${state.currentAuthorityKey?.trim() || "workspace"}\0${state.currentWorkspaceIdentity?.trim() || state.currentProjectPath}`;
        // loaded 与 key 两个条件都要满足：loaded=false 说明读取失败，
        // 标成就绪会让后续刷新拿空配置去请求，错误被推迟到更难排查的位置。
        if (loaded && loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
          // ref 只在 render 时同步；这里补写一次，否则同一 tick 内紧接着的请求仍会
          // 因为 config-not-ready 被跳过，用户就得再点一次刷新。
          latestStatusListRefreshInputRef.current = {
            ...latestStatusListRefreshInputRef.current,
            configReadyWorkspaceKey: activeWorkspaceKey,
          };
        }
      }
      await requestMcpServerStatusList({ trigger: "manual" });
    } finally {
      setRefreshingStatusList(false);
    }
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    cacheAuthorityKey,
    ensureLoadedForWorkspace,
    loadMcpFromUserDirectory,
    mcpConfigReadyWorkspaceKey,
    refreshingStatusList,
    requestMcpServerStatusList,
    services.mcpSyncService,
  ]);

  // 切 workspace 或换服务实例时必须清空三类跨仓库状态：
  // pending 记录、follow-up、status 不支持标记。前两者属于旧仓库的授权流程，
  // 后者属于旧 agent 的能力判断；复用它们会让新仓库继承错误的轮询行为。
  useEffect(() => {
    lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
    setMcpOAuthAuthorizationFollowupRefresh(null);
    // 重置时 state 与 ref 必须一起改：只改 state 会让请求回调在下一帧仍读到 true，
    // 从而继续跳过 status 请求。
    mcpStatusOnlyUnsupportedRef.current = false;
    setMcpStatusOnlyUnsupported(false);
  }, [activeWorkspaceKey, services.mcpSyncService]);

  // 配置加载与 workspace 绑定：每次切换先清空就绪标记再重新加载，
  // 不清空的话新仓库会短暂沿用旧仓库的「已就绪」，在那几帧里发出的请求
  // 会用空 servers 覆盖列表，用户看到列表闪空一次。
  useEffect(() => {
    let cancelled = false;
    setMcpConfigReadyWorkspaceKey("");
    // 没有 path 或 key 时不加载也不报错：这通常是「尚未选择仓库」的初始态，
    // 打 warn 会让每次启动都产生一条无意义的日志。
    if (!activeWorkspacePath || !activeWorkspaceKey) {
      return;
    }

    void ensureLoadedForWorkspace(
      activeWorkspacePath,
      services.mcpSyncService,
      activeWorkspaceIdentity,
      cacheAuthorityKey,
    )
      .then((loaded) => {
        // cancelled 检查防止旧 workspace 的加载结果写进新 workspace：
        // 该 effect 的 cleanup 只会置标记，不会取消底层 promise。
        // !loaded 表示读取失败，保持 key 为空让下一轮重试，而不是标成就绪。
        if (cancelled || !loaded) {
          return;
        }
        const state = useMcpStore.getState();
        const loadedWorkspaceKey = `${state.currentAuthorityKey?.trim() || "workspace"}\0${state.currentWorkspaceIdentity?.trim() || state.currentProjectPath}`;
        if (loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
        }
      })
      .catch((error) => {
        // 加载失败只记日志、不 toast：页面仍能展示 store 里已有的缓存配置，
        // 弹错误会让「打开设置页」这个常规动作看起来像出了故障。
        logger.warn("[mcp] load workspace config before status refresh failed", {
          error: error instanceof Error ? error.message : String(error),
          workspacePath: activeWorkspacePath,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    cacheAuthorityKey,
    ensureLoadedForWorkspace,
    services.mcpSyncService,
  ]);

  // 插件列表初始化与 MCP 配置加载相互独立：插件托管 MCP 出现在列表里
  // 依赖 pluginManagementStore 的声明数据，缺了它只会少一组行，不应阻塞 MCP 列表。
  // 因此这里单独一个 effect，失败也不影响主流程。
  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }
    void initializePlugins({
      pluginService: services.pluginManagementService,
      workspaceIdentity: activeWorkspaceIdentity,
      workspacePath: activeWorkspacePath,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
    });
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    cacheAuthorityKey,
    initializePlugins,
    scopeFilter,
    services.pluginManagementService,
  ]);

  // 自动刷新由「去重键变化」驱动，而不是每次渲染都尝试：
  // 键覆盖 workspace 与 server 配置集合，只有它们真的变了才发请求，
  // 这样 OAuth 的 status merge 不会反过来触发一次全量 connect 刷新。
  useEffect(() => {
    const transition = transitionMcpAutoStatusListRefreshKey(
      lastAutoStatusListRefreshKeyRef.current,
      autoStatusListRefreshKey,
    );
    // 先写回 lastRefreshKey 再判断是否刷新：顺序反了会在刷新失败时反复重试，
    // 因为 ref 始终停留在旧键上，下一次渲染又被判为新变化。
    lastAutoStatusListRefreshKeyRef.current = transition.lastRefreshKey;
    if (!transition.shouldRefresh) {
      return;
    }
    void requestMcpServerStatusList();
  }, [autoStatusListRefreshKey, requestMcpServerStatusList]);

  // pending 集合的转换在 effect 里做，而不是在渲染期算：
  // 它要写 ref 与 state 两份副作用，渲染期写会在 React 严格模式下被执行两次，
  // 第一次就把 previous 清掉，第二次会生成错误的 follow-up。
  useEffect(() => {
    // 未就绪时主动清空：否则旧仓库的 pending 会一直留在 ref 里，
    // 等新仓库就绪时 transition 会误以为「pending 刚刚结束」，凭空生成 follow-up。
    if (!activeWorkspaceKey || mcpConfigReadyWorkspaceKey !== activeWorkspaceKey) {
      lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
      setMcpOAuthAuthorizationFollowupRefresh(null);
      return;
    }
    const transition = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey,
      existingFollowup: mcpOAuthAuthorizationFollowupRefresh,
      mcpServers: pendingMcpOAuthAuthorizationRefreshServers,
      pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
      previous: lastPendingMcpOAuthAuthorizationRefreshRef.current,
    });
    // 先写 pending 再写 followup：followup 的生成依赖 previous.pending，
    // 顺序反了同一个 effect 内会用旧 pending 再算一次，重复生成窗口。
    lastPendingMcpOAuthAuthorizationRefreshRef.current = transition.pending;
    // OAuth 回调完成到 MCP 重新连通之间会短暂清掉 authorizationUrl；
    // follow-up 必须携带原 workspaceKey，切换 workspace 时不能复用旧配置。
    // 这里无条件 set：transition 已保证同窗口返回同一引用，不会造成多余定时器重建。
    setMcpOAuthAuthorizationFollowupRefresh(transition.followup);
  }, [
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpOAuthAuthorizationFollowupRefresh,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
  ]);

  // 1 秒轮询只在「有 pending 授权 + workspace 就绪 + Agent 支持 status」时启动：
  // 四个条件缺一都会产生无意义请求，尤其是 mcpStatusOnlyUnsupported，
  // 漏判它会让旧 Agent 每秒收到一条必然失败的 status 请求。
  useEffect(() => {
    if (
      !pendingMcpOAuthAuthorizationRefreshKey ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    // cancelled 与 timeoutId 是 effect 级别的所有权标记：
    // 它们保证这个 effect 创建的定时器只由自己的 cleanup 清除，
    // 不会误清 follow-up effect 的定时器（两者都调用同一个 request）。
    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;
    // deadline 从 memo 读一次并在整个 effect 生命周期内保持不变：
    // 在循环里重新 create 会让 5 分钟窗口随每次请求后移，实际永不结束。
    const deadline = pendingMcpOAuthAuthorizationRefreshDeadline;

    // 下一次调度只在「未取消且未到期」时创建：
    // 在 timer 回调里再判一次是必要的，因为清理发生在 setTimeout 已入队之后，
    // 只靠外层判断会让已卸载组件再打一次请求。
    const scheduleNextRefresh = () => {
      if (cancelled || isMcpOAuthAuthorizationStatusRefreshExpired(deadline)) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        if (cancelled || isMcpOAuthAuthorizationStatusRefreshExpired(deadline)) {
          return;
        }
        attempts += 1;
        logger.debug("[mcp] refresh status while OAuth authorization is pending", {
          attempt: attempts,
          deadline,
          pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
          workspacePath: activeWorkspacePath,
        });
        // 修复原因：mcp/list 为了尽快返回 authorizationUrl 会让 agent 在后台等待 OAuth
        // 回调并重连；如果当前设置页不继续拉取 snapshot，UI 会停留在 connecting，直到切 tab 重挂载。
        // OAuth 轮询是高频请求，只能走 status-only，避免 pending 子集触发 replace 语义断开无关 MCP。
        void requestMcpServerStatusList(
          buildMcpOAuthAuthorizationStatusRefreshOptions(
            pendingMcpOAuthAuthorizationRefreshServers,
          ),
        // 用 finally 而不是 then：请求失败也必须继续下一轮，
        // 否则一次网络抖动就让授权状态永久停在 connecting。
        ).finally(scheduleNextRefresh);
      }, MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS);
    };

    // 先立即调度而不是先发一次请求：打开页面时通常刚点完授权，
    // 立即发会与用户点击触发的刷新撞在一起，等 1 秒能让两个请求合并成一次。
    scheduleNextRefresh();

    return () => {
      // 置标记 + 清定时器缺一不可：只置标记时已入队的 timer 仍会执行回调，
      // 回调里虽会提前 return，但闭包持有的 servers 会阻止 GC 直到 timer 触发。
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpStatusOnlyUnsupported,
    pendingMcpOAuthAuthorizationRefreshDeadline,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
    requestMcpServerStatusList,
  ]);

  // follow-up 是 pending 结束后的补救轮询：它必须再次校验 workspaceKey，
  // 因为 follow-up 对象可能比当前 workspace 活得更久（effect 清理是异步的），
  // 只校验 activeWorkspaceKey 存在会把 A 的 server 集合发给 B。
  useEffect(() => {
    if (
      !mcpOAuthAuthorizationFollowupRefresh ||
      mcpOAuthAuthorizationFollowupRefresh.workspaceKey !== activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;

    const scheduleNextRefresh = () => {
      if (cancelled) {
        return;
      }
      // 到上限后清空 follow-up，且用函数式更新校验 refreshKey：
      // 直接 set(null) 会误清掉这期间新生成的窗口，导致新一轮补救还没跑就消失。
      // 达到上限说明连接没有在预期时间内恢复，继续轮询只会制造重复错误日志。
      if (attempts >= MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS) {
        setMcpOAuthAuthorizationFollowupRefresh((current) =>
          current?.refreshKey === mcpOAuthAuthorizationFollowupRefresh.refreshKey ? null : current,
        );
        return;
      }
      timeoutId = window.setTimeout(() => {
        attempts += 1;
        logger.debug("[mcp] refresh status after OAuth authorization state changed", {
          attempt: attempts,
          followupKey: mcpOAuthAuthorizationFollowupRefresh.refreshKey,
          workspacePath: activeWorkspacePath,
        });
        void requestMcpServerStatusList(
          buildMcpOAuthAuthorizationStatusRefreshOptions(
            mcpOAuthAuthorizationFollowupRefresh.mcpServers,
          ),
        ).finally(scheduleNextRefresh);
      }, MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS);
    };

    // 先立刻请求一次再进入定时：follow-up 的触发时刻就是「pending 刚消失」，
    // 等 1 秒会让连接恢复多延迟一拍，用户看到状态点晚一秒才变绿。
    void requestMcpServerStatusList(
      buildMcpOAuthAuthorizationStatusRefreshOptions(
        mcpOAuthAuthorizationFollowupRefresh.mcpServers,
      ),
    ).finally(scheduleNextRefresh);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpOAuthAuthorizationFollowupRefresh,
    mcpStatusOnlyUnsupported,
    requestMcpServerStatusList,
  ]);

  useEffect(() => {
    if (
      !pendingMcpOAuthAuthorizationRefreshKey ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    const refreshAfterReturnFromBrowser = () => {
      logger.debug("[mcp] refresh status after returning from OAuth browser", {
        pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
        workspacePath: activeWorkspacePath,
      });
      void requestMcpServerStatusList(
        buildMcpOAuthAuthorizationStatusRefreshOptions(pendingMcpOAuthAuthorizationRefreshServers),
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshAfterReturnFromBrowser();
      }
    };

    window.addEventListener("focus", refreshAfterReturnFromBrowser);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", refreshAfterReturnFromBrowser);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpStatusOnlyUnsupported,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
    requestMcpServerStatusList,
  ]);

  const scopedServers = useMemo(
    () =>
      servers.filter(
        (server) =>
          server.scope === scopeFilter || (scopeFilter === "user" && server.scope === "common"),
      ),
    [scopeFilter, servers],
  );
  const filteredServers = useMemo(
    () => filterLocalMcpServers(scopedServers, query),
    [query, scopedServers],
  );
  const connectedRemoteSyncTarget =
    shouldShowRemoteSyncActions({
      remoteSessionId,
      remoteTarget,
      clientMode: isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
      hasLocalSourceService: Boolean(baseServices.mcpSyncService),
    }) && activeWorkspacePath
      ? remoteTarget
      : null;
  const isRemoteSyncContext = Boolean(connectedRemoteSyncTarget);
  const pluginMcpServers = useMemo(() => {
    if (!shouldShowPluginMcpServersInMcpSettings(isRemoteSyncContext)) {
      // 插件 MCP 列表来自本机插件管理 store，不是当前远端目标。
      // 远端 MCP 设置页必须和 Skills 一样只展示远端工作区可读写的资源。
      return [];
    }
    // 插件 store 的 key 必须与 pluginManagementStoreLoading.buildWorkspaceKey 同格式
    // （authority\0identity|path），否则带 Source authority 的 activeWorkspaceKey 永远匹配不上。
    const pluginStoreWorkspaceKey = `${pluginStoreAuthorityKey?.trim() || "workspace"}\0${
      pluginStoreWorkspaceIdentity?.trim() || pluginStoreWorkspacePath || ""
    }`;
    const pluginStoreMatchesTarget =
      pluginStoreWorkspaceKey === activeWorkspaceKey && pluginConfigScope === scopeFilter;
    if (!pluginStoreMatchesTarget) {
      return [];
    }
    const scopedPlugins = selectPluginsForScope(plugins, installedPlugins, scopeFilter).filter(
      (plugin) => plugin.enabled,
    );
    return buildPluginMcpServerItems(scopedPlugins, query, statusSnapshots);
  }, [
    installedPlugins,
    activeWorkspaceKey,
    isRemoteSyncContext,
    pluginConfigScope,
    pluginStoreAuthorityKey,
    pluginStoreWorkspaceIdentity,
    pluginStoreWorkspacePath,
    plugins,
    query,
    scopeFilter,
    statusSnapshots,
  ]);
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const filteredMcpCount = filteredServers.length + pluginMcpServers.length;
  const pluginMcpGroups = useMemo(
    () => groupPluginMcpServersByPlugin(pluginMcpServers),
    [pluginMcpServers],
  );
  const mcpProjectionReady =
    !activeWorkspacePath ||
    (mcpStoreMatchesActiveWorkspace && mcpConfigReadyWorkspaceKey === activeWorkspaceKey);
  const hasEmptySearchResult = Boolean(query.trim()) && filteredMcpCount === 0;
  const installedServers = useMemo(
    () =>
      filteredServers
        .map((server, index) => ({ index, server }))
        .toSorted((left, right) => {
          // Bug 原因：Source authority 提交从旧基线重放时恢复了已废弃的「需要关注」分组，
          // 把诊断分组改版重新拆成两套列表。异常项只在 Installed 内稳定置顶，避免重复分组。
          const leftAttention = Boolean(
            left.server.authorization?.authorizationUrl || left.server.status === "error",
          );
          const rightAttention = Boolean(
            right.server.authorization?.authorizationUrl || right.server.status === "error",
          );
          return Number(rightAttention) - Number(leftAttention) || left.index - right.index;
        })
        .map(({ server }) => server),
    [filteredServers],
  );
  const hideInstalledGroup = Boolean(query.trim()) && installedServers.length === 0;
  useEffect(() => {
    onVisibleCountChange?.(filteredMcpCount);
  }, [filteredMcpCount, onVisibleCountChange]);
  const remoteMcpSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSkillSyncTarget(connectedRemoteSyncTarget, activeWorkspacePath ?? "")
    : "";

  async function handleToggle(id: string, enabled: boolean) {
    await toggleServer(id, enabled);

    if (!enabled) {
      // 禁用后的 unknown 只是本地展示态；toggleServer 已经作废旧请求，
      // 这里不能再推进 epoch，否则刚返回的 mcp/list 会被丢弃并造成反复转圈。
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }

    // renderer 侧浅检查无法真实启动 stdio MCP，曾把不存在的 command 误判为 connected。
    // 打开后只展示连接中，最终绿/红状态统一等待 agent 侧 mcp/list 真实 connect/listTools 回写。
    if (!activeWorkspacePath) {
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }
    // connecting 只是等待真实 mcp/list 的临时展示态，不能作废随后发出的批量请求。
    updateServerStatus(id, "connecting", undefined, {
      invalidateStatusListRequests: false,
    });
    void requestMcpServerStatusList();
  }

  async function handleSave(form: FormState, prev?: ZCodeMcpServer) {
    if (!activeWorkspacePath) {
      return;
    }
    const loaded = await ensureLoadedForWorkspace(
      activeWorkspacePath,
      services.mcpSyncService,
      activeWorkspaceIdentity,
      cacheAuthorityKey,
    );
    if (!loaded) {
      return;
    }
    const config = {
      ...formToConfig(form),
      ...(prev?.enabled === false ? { enable: false } : {}),
    };
    // 表单 Scope 可以独立于父页面切换，不能继续读取可能仍属于旧目标的
    // currentProjectPath；保存目标必须使用表单已解析并完成加载的 workspace props。
    const projectPath = formScopeKey === "user" ? undefined : activeWorkspacePath;

    if (prev) {
      await updateScopedMcpServer(DEFAULT_MCP_SOURCE, prev.name, config, projectPath);
    } else {
      await addScopedMcpServer(DEFAULT_MCP_SOURCE, form.name, config, projectPath);
    }

    setShowForm(false);
    setEditingServer(null);
    onFormScopeKeyChange?.(null);
  }

  async function handleDelete(server: ZCodeMcpServer) {
    const confirmed = await confirmDialog({
      confirmVariant: "destructive",
      title: intl.formatMessage({ id: "settings.mcp.deleteConfirmTitle" }, { name: server.name }),
      description: intl.formatMessage({
        id: "settings.mcp.deleteConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({
        id: "settings.mcp.deleteConfirmAction",
      }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });

    if (!confirmed) {
      return;
    }

    await deleteScopedMcpServer(server.source, server.name, server.projectPath);
    setEditingServer(null);
    setShowForm(false);
    setEditorMode("form");
    onFormScopeKeyChange?.(null);
  }

  function handleEdit(server: ZCodeMcpServer) {
    const ownerWorkspace = workspaceTabs.find((tab) => tab.workspacePath === server.projectPath);
    const ownedScopeKey =
      server.scope === "workspace"
        ? ownerWorkspace
          ? getPluginWorkspaceKey(ownerWorkspace)
          : parentScopeKey
        : "user";
    setFormScopeKey(ownedScopeKey);
    onFormScopeKeyChange?.(ownedScopeKey);
    setEditingServer(server);
    setShowForm(false);
    setEditorMode("form");
  }

  function handleCreate() {
    setFormScopeKey(parentScopeKey);
    onFormScopeKeyChange?.(parentScopeKey);
    setEditingServer(null);
    setEditorMode("form");
    setShowForm(true);
  }

  function handleOpenAuthorization(server: ZCodeMcpServer) {
    const authorizationUrl = server.authorization?.authorizationUrl;
    if (!authorizationUrl) {
      return;
    }
    platform.openExternal(authorizationUrl);
  }

  function handleOpenPluginAuthorization(item: PluginMcpServerItem) {
    const authorizationUrl = item.authorization?.authorizationUrl;
    if (!authorizationUrl) {
      return;
    }
    platform.openExternal(authorizationUrl);
  }

  if (isFormView) {
    const closeFormView = () => {
      setShowForm(false);
      setEditingServer(null);
      setEditorMode("form");
      onFormScopeKeyChange?.(null);
    };
    const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });
    const formBreadcrumbLabel =
      editingServer?.name ?? intl.formatMessage({ id: "settings.mcp.form.createTitle" });
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={
            showMarketplaceBreadcrumb
              ? [
                  { label: pluginsBreadcrumbLabel, onSelect: closeFormView },
                  { label: formBreadcrumbLabel },
                ]
              : [{ label: formBreadcrumbLabel }]
          }
          onSectionSelect={
            showMarketplaceBreadcrumb && onOpenPluginStore ? onOpenPluginStore : closeFormView
          }
        />
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h3 className="text-ui-xl font-semibold text-foreground">
                {editingServer
                  ? intl.formatMessage({ id: "settings.mcp.form.editTitle" })
                  : intl.formatMessage({ id: "settings.mcp.form.createTitle" })}
              </h3>
              <p className="text-ui-base text-foreground-subtle">
                {editingServer
                  ? intl.formatMessage({
                      id: "settings.mcp.form.editDescription",
                    })
                  : intl.formatMessage({
                      id: "settings.mcp.form.createDescription",
                    })}
              </p>
            </div>
            <div className="shrink-0 self-end">
              <SettingsSegmentedTabs
                value={editorMode}
                items={[
                  {
                    value: "form",
                    label: intl.formatMessage({
                      id: "settings.mcp.form.mode.form",
                    }),
                  },
                  { value: "json", label: "JSON" },
                ]}
                onValueChange={setEditorMode}
              />
            </div>
          </div>

          <McpServerForm
            initial={editingServer ?? undefined}
            editingId={editingServer?.id}
            editorMode={editorMode}
            source={editingServer?.source ?? DEFAULT_MCP_SOURCE}
            scopeKey={formScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={(nextScopeKey) => {
              setFormScopeKey(nextScopeKey);
              onFormScopeKeyChange?.(nextScopeKey);
            }}
            onEditorModeChange={setEditorMode}
            onSave={handleSave}
            onDelete={editingServer ? handleDelete : undefined}
            onCancel={closeFormView}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {connectedRemoteSyncTarget ? (
        <div className="flex justify-end">
          <ControlHintTooltip title={intl.formatMessage({ id: "settings.mcp.remoteSync.open" })}>
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              aria-label={intl.formatMessage({
                id: "settings.mcp.remoteSync.open",
              })}
              onClick={() => setRemoteMcpSyncOpen(true)}
            >
              <UploadCloud className="size-3.5" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      ) : null}

      {connectedRemoteSyncTarget ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.mcp.remoteContext" },
            { target: remoteMcpSyncTargetLabel },
          )}
        </div>
      ) : null}

      {!mcpProjectionReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.mcp.searchEmpty",
          })}
        />
      ) : null}
      <div
        className={!mcpProjectionReady || hasEmptySearchResult ? "hidden" : "space-y-6"}
        data-mcp-list-layout="grouped"
      >
        <section
          className={hideInstalledGroup ? "hidden" : "space-y-4"}
          data-mcp-plugin-group="installed"
        >
          <div data-mcp-plugin-installed-actions="true">
            <SettingsResourceGroupHeader
              actions={
                <SettingsResourceHeaderActions
                  onRefresh={() => void handleManualRefresh()}
                  refreshing={refreshingStatusList}
                  onImport={() => setImportDialogOpen(true)}
                  onNew={handleCreate}
                  importActionId="settings.mcp.import.open"
                  newActionId="settings.mcp.create.open"
                />
              }
              count={installedServers.length}
              title={intl.formatMessage({
                id: "settings.plugin.mcp.installed",
              })}
            />
          </div>
          {installedServers.length > 0 ? (
            <McpServerList
              hideMetadata
              servers={installedServers}
              onCreate={handleCreate}
              onEdit={handleEdit}
              onToggle={handleToggle}
              onOpenAuthorization={handleOpenAuthorization}
              emptyTitle={intl.formatMessage({ id: "settings.mcp.emptyTitle" })}
              emptyDescription={intl.formatMessage({
                id: "settings.mcp.emptyDescription",
              })}
            />
          ) : scopedServers.length === 0 && !query.trim() ? (
            <PluginInstallEmptyState
              title={intl.formatMessage({
                id: "settings.plugin.mcp.emptyInstalledTitle",
              })}
              description={intl.formatMessage({
                id: "settings.plugin.mcp.emptyInstalledDescription",
              })}
              actions={
                <>
                  <Button
                    type="button"
                    variant="default"
                    size="lg"
                    onClick={() => {
                      handleCreate();
                    }}
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({
                      id: "settings.plugin.mcp.newServer",
                    })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={() => setImportDialogOpen(true)}
                  >
                    <Import data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.mcp.import.action" })}
                  </Button>
                </>
              }
            />
          ) : null}
        </section>
        {pluginMcpGroups.map((group) => (
          <section
            key={group.pluginId}
            className="space-y-4"
            data-mcp-plugin-group={group.pluginId}
          >
            <SettingsResourceGroupHeader
              count={group.items.length}
              title={resolvePluginDisplayName(
                {
                  name: group.pluginName,
                  listing: pluginListingById.get(group.pluginId),
                },
                locale,
              )}
            />
            <PluginMcpServerList
              items={group.items}
              pluginListingById={pluginListingById}
              onOpenAuthorization={handleOpenPluginAuthorization}
            />
          </section>
        ))}
      </div>
      <McpServersImportDialog
        // 对话框携带的是 mcpStore 的 currentProjectPath，只有它与当前 target
        // 一致时才和 services 的 host 同源；不一致的过渡帧不能让导入按 A 的 host 落盘 B 的路径。
        open={importDialogOpen && mcpStoreMatchesActiveWorkspace}
        workspacePath={currentProjectPath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={services.settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await loadMcpFromUserDirectory(
            services.mcpSyncService,
            activeWorkspaceIdentity,
            cacheAuthorityKey,
          );
        }}
      />
      <RemoteSyncDialogs
        canSyncSkills={false}
        canSyncMcp={Boolean(connectedRemoteSyncTarget && activeWorkspacePath)}
        skillOpen={false}
        mcpOpen={remoteMcpSyncOpen}
        onSkillOpenChange={() => {}}
        onMcpOpenChange={setRemoteMcpSyncOpen}
        localMcpSyncService={baseServices.mcpSyncService}
        remoteMcpSyncService={services.mcpSyncService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath=""
        mcpWorkspacePath={activeWorkspacePath ?? ""}
        mcpLocalWorkspacePath={localWorkspacePath}
        onSkillsSynced={() => {}}
        onMcpSynced={async () => {
          const loaded = await loadMcpFromUserDirectory(
            services.mcpSyncService,
            activeWorkspaceIdentity,
            cacheAuthorityKey,
          );
          if (loaded) {
            await requestMcpServerStatusList();
          }
        }}
      />
    </div>
  );
}
