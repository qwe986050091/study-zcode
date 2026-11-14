import type {
  RemoteConnectionFeedbackOptions,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { requestRemoteProjectConnection } from "@/remote-connection-flow/contract.js";
import { requestRetainedRemoteProjectConnection } from "@/project-sidebar/remote-project-connection.js";
import {
  formatRemoteConnectionDescription,
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
/* eslint-disable max-lines -- Bugfix: 远端 workspace 历史目前需要在一个 hook 内同时收口恢复、重连、持久化和清理流程，先保留同文件协作边界，避免为过 lint 临时拆分后引入状态回归。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BindRemoteWorkspaceSessionContextResult,
  IPlatformService,
  RemoteTarget,
  RemoteSessionClosedEvent,
  RemoteSessionReconnectedEvent,
  SourceServerConnectionState,
  SourceServerManagementSnapshot,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import {
  buildSshRemoteHostKey,
  createUuid,
  parseRemoteWorkspaceIdentity,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  clearRemoteWorkspaceConnectionState,
  getRemoteWorkspaceSession,
  setRemoteWorkspaceConnectionState,
  type RemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
  getRemoteWorkspaceSessionEntries,
  projectRemoteWorkspaceSessionIdentityAliases,
  removeRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import type { RemoteWorkspaceRecoveryStatus } from "@/app-shell/types.js";
import {
  isWorkspaceTab,
  type TabStoreState,
  type WindowTabState,
  type WorkspaceTabState,
} from "@/store/tabStore.js";
import {
  buildRemoteWorkspacePersistPatch,
  projectRemoteConversationWorkspacePurpose,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import { useReconnectingRemoteWorkspaceLogs } from "@/root/useReconnectingRemoteWorkspaceLogs.js";
import {
  reconnectRemoteWorkspaceHistoryEntry,
  type ReconnectRemoteWorkspaceOptions,
  type SshReconnectCredentials,
} from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { createRemoteWorkspaceController } from "@/remote/remoteWorkspaceController.js";
import type { RemoteWorkspaceController } from "@/remote/remoteWorkspaceController.js";
import { buildRemoteTargetFromProfile } from "@/lib/remoteConnectionWizard.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { loadConnectionProfileCredentials } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import type { WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";

// =============================================================================
// useRemoteWorkspaceHistory —— 远端 workspace 历史的"恢复 / 重连 / 持久化 / 清理"中枢。
//
// 它维护的是这样一张表：每个远端 workspace 一条记录（entry），键是 workspaceKey，
// 值包含 target、workspacePath、workspaceIdentity、workspacePurpose 与本地工作区映射。
// 这条记录同时被四处消费：标签页（tab）、session store、监控日志、以及落盘的 settings。
// 因此本文件的核心难点不是"怎么连"，而是"四处状态如何保持一致，且失败时只留一份真相"。
//
// 关键概念：
//   workspaceKey：buildWorkspaceSessionKey(entry|tab) —— 历史的唯一身份；
//   workspaceIdentity：远端身份（server 时是 identity 串，ssh 时是 host+path），
//                       用于"同一个目录在不同设备上"的隔离；
//   recoveringKeys：正在恢复的 key 集合，驱动 UI 的"恢复中"占位；
//   pendingReconnectRequestIds：key → requestId，用于判定"当前是否已有一次重连在跑"。
//
// 不变量表（本文件内编号唯一）：
// INV-01：workspaceKey 是历史条目的唯一身份；禁止用 workspacePath 或 remoteSessionId
//         替代（守住：全部 buildWorkspaceSessionKey 调用点与 Map 键）。
// INV-02：path 与 identity 必须成对维护：path 用于执行（连接/列目录），identity 用于
//         隔离与恢复；只有其一就无法自动恢复（守住：bindRemoteWorkspaceContextAndGetSession）。
// INV-03：同一个 workspaceKey 同时至多一个重连请求（守住：inflightReconnectWorkspaceKeys /
//         pendingReconnectRequestIds 的写入点）。
// INV-04：每次重连都生成新的 requestId；迟到的结果按 requestId 丢弃，不得改 UI
//         （守住：createReconnectRequestId 与所有 requestId 比较）。
// INV-05：recoveringKeys 是乐观占位集合，恢复结束必须精确移除对应 key；
//         只增不减会让条目永久显示"恢复中"（守住：updateRemoteWorkspaceRecoveringKeys）。
// INV-06：bind 会替换同一 remoteSessionId 的 attachment/services，因此 bind 之后必须
//         按 sessionId 重新读取 session，不能复用 bind 前捕获的对象（守住：bind 函数中部）。
// INV-07：失败写盘有例外：WSL 目标且当前 key 已有 pending reconnect 时不得写 failed，
//         否则旧 session 的关闭事件会覆盖正在进行的重连结果（守住：shouldPersistRemoteWorkspaceFailure）。
// INV-08：无错误的 Source 主动关闭是"中性离线"，不算失败（守住：isRemoteWorkspaceCloseFailure）。
// INV-09：错误文案优先级：recoveryBudgetExhausted > error 原文 > 调用方 fallback >
//         通用 connectionClosed（守住：resolveRemoteWorkspaceClosedFallback）。
// INV-10：启动自动重连只在 Source 状态为 online 时尝试；offline 时重连必然失败，
//         还会制造一条假失败记录（守住：shouldAttemptStartupReconnectForSourceState）。
// INV-11：启动重连由 tab 变化触发，且只针对"新增的、无 remoteSessionId 的 server tab"；
//         已有的 tab 不重复触发（守住：shouldAttemptStartupReconnectForTabChange）。
// INV-12：处理关闭事件时必须按 remoteSessionId 反查当前 entry，不能信任事件自带的
//         路径/身份（那可能是上一个会话的残留）。
// INV-13：移除历史时必须同步清理 tab、session store、日志与 recoveringKeys，
//         只删列表会留下"点了能打开但打不开"的幽灵条目。
// INV-14：重连的步骤顺序：canonical path → connect → bind → addTab → 持久化；
//         中途失败要释放已建立的 session，不能留下未登记的 attachment。
// INV-15：所有异步 catch 在提示用户前都要确认"我仍是当前请求"，否则会弹出
//         属于上一次尝试的错误（守住：requestId / epoch 比较后的 toast）。
// INV-16：历史变更统一走 commitRemoteWorkspaceSessionMutation，保证内存列表与
//         settings 的写法一致（守住：唯一的 mutation 提交入口）。
// INV-17：日志按 workspaceKey 隔离，重连开始前重置，避免旧连接日志串进新连接。
// INV-18：本地工作区映射（localWorkspacePath）只在 Project 用途下有意义；
//         conversation 用途不得写它，否则会把对话 workspace 当成项目目录。
// INV-19：SSH 重连按 host key 分组，同 host 的断线条目共享一次认证；
//         分组不改变每个条目各自的成功/失败结果（守住：collectSshReconnectGroup）。
// INV-20：卸载时必须停止订阅与清理定时器；清理函数不得在渲染期被调用。
// INV-21：所有对 tab store 的读取都走 getState() 快照，不在渲染闭包里缓存；
//         否则会出现"用旧 tabs 计算结果"的一致性问题。
// =============================================================================
export { reconnectRemoteWorkspaceHistoryEntry };

// INV-05 的唯一实现：把"当前 tabs 对应的 key 集合"并入或移出 recoveringKeys。
// 两个方向都必须去重：
//   并入用 Set：同一个 key 重复恢复（用户连点）不得让数组里出现两份，否则后续
//   filter 移除只能移掉一份，另一份会让条目永久显示"恢复中"；
//   移除按 key 集合过滤，绝不按"清空"处理——清空会顺手抹掉其它正在恢复的条目。
// 纯函数形态让它可单测，也避免在 hook 里直接改 state 造成并发更新丢失。
export function updateRemoteWorkspaceRecoveringKeys(
  currentKeys: string[],
  tabs: WorkspaceTabState[],
  recovering: boolean,
): string[] {
  const workspaceKeys = new Set(tabs.map((tab) => buildWorkspaceSessionKey(tab)));
  if (recovering) return [...new Set([...currentKeys, ...workspaceKeys])];
  return currentKeys.filter((key) => !workspaceKeys.has(key));
}

// INV-10：只有 online 才值得自动重连。
// offline / connecting 状态下发起重连，要么立刻失败，要么与 Source 自己的启动流程
// 抢同一份配置（出现"重连把 Source 状态推成 error"的次生故障）。
// 单独抽成函数是为了让这条规则可被测试直接覆盖，而不是埋在 effect 的 if 里。
export function shouldAttemptStartupReconnectForSourceState(
  state: SourceServerConnectionState,
): boolean {
  return state === "online";
}

// INV-11：判定"这次 tab 变化是否引入了需要自动恢复的新条目"。
// 四个条件缺一不可：
//   1) isWorkspaceTab：普通 tab 不参与；
//   2) !tab.remoteSessionId：已有会话说明已经连上，不需要恢复；
//   3) workspaceIdentity.kind === "server"：只有 Source 类型支持启动自动重连，
//      SSH/WSL 需要凭据，不能无人值守地发起；
//   4) key 不在 previousTabs 里：只有"新增"才触发，避免每次任意 tab 变化都重扫全表。
// 用 key 集合而不是逐个 find，是为了让这段逻辑保持 O(n) 且不受顺序影响
// （tab 重排不应被误判为新增）。
export function shouldAttemptStartupReconnectForTabChange(
  tabs: readonly WindowTabState[],
  previousTabs: readonly WindowTabState[],
): boolean {
  const previousWorkspaceKeys = new Set(
    previousTabs.filter(isWorkspaceTab).map((tab) => buildWorkspaceSessionKey(tab)),
  );
  return tabs.some(
    (tab) =>
      isWorkspaceTab(tab) &&
      !tab.remoteSessionId &&
      parseRemoteWorkspaceIdentity(tab.workspaceIdentity ?? "")?.kind === "server" &&
      !previousWorkspaceKeys.has(buildWorkspaceSessionKey(tab)),
  );
}

/** 无错误的 Source 主动关闭是中性离线，不能制造未知连接失败并阻断原地重连。 */
// INV-08：区分"主动关闭"与"异常断开"。
// 五个判据任一成立即视为失败：
//   error：显式错误对象；
//   reasonCode：结构化原因（例如协议错误）；
//   recoveryBudgetExhausted：自动恢复次数用尽；
//   exitCode 非 0：进程异常退出；
//   signal：被信号杀死（崩溃/OOM）。
// 全部为空才是"用户主动关闭/正常退出"，此时不能写 failed——那会让用户下次打开
// 看到一条自己制造的"连接失败"，并可能阻断原地重连。
export function isRemoteWorkspaceCloseFailure(
  event: Pick<
    RemoteSessionClosedEvent,
    "error" | "reasonCode" | "exitCode" | "signal" | "recoveryBudgetExhausted"
  >,
): boolean {
  return Boolean(
    event.error ||
    event.reasonCode ||
    event.recoveryBudgetExhausted ||
    (event.exitCode != null && event.exitCode !== 0) ||
    event.signal,
  );
}

// INV-09：关闭原因的四级回退。顺序不是随意的：
//   1) 恢复预算耗尽必须单独成句（"已重试 N 次"比"连接已关闭"有用得多），
//      而且它通常没有 error 对象，若先取 error 会得到空串；
//   2) error 原文优先于调用方 fallback：调用方给的兜底是通用文案，真实错误更具体；
//   3) fallback 是给"已知场景但无错误文本"用的；
//   4) 最后才是通用 connectionClosed，保证永远有文案可显示。
export function resolveRemoteWorkspaceClosedFallback(params: {
  event: Pick<
    RemoteSessionClosedEvent,
    "error" | "recoveryAttempt" | "recoveryBudgetExhausted" | "recoveryLimit"
  >;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  defaultFallback?: string;
}): string {
  if (params.event.recoveryBudgetExhausted) {
    return params.formatMessage(
      { id: "remote.error.recoveryBudgetExhausted" },
      {
        attempt: params.event.recoveryAttempt ?? "?",
        limit: params.event.recoveryLimit ?? "?",
      },
    );
  }
  return (
    params.event.error?.trim() ||
    params.defaultFallback ||
    params.formatMessage({ id: "remote.error.connectionClosed" })
  );
}

// 把远端 session 绑定到具体 workspace（路径 + 身份 + 用途），并返回"绑定后"的 session。
// 这是 INV-02/INV-06 的落地：
//   1) 绑定前先确认 session 存在，否则 bind 会得到一个含糊的远端错误；
//   2) bind 会让同一 remoteSessionId 的 attachment/services 换代（A→B），
//      所以 bind 之后必须重新 getRemoteWorkspaceSession，不能返回 bind 前的对象；
//   3) identity 必须最终非空：path 决定"在哪工作"，identity 决定"这是谁的目录"，
//      缺少 identity 的条目在下次启动时无法匹配回原设备，只能让用户重选。
// binding.workspaceIdentity 优先于 session 上的旧值：服务端返回值才是权威，
// 旧值可能是上一次绑定留下的（例如用户重命名了设备）。
export async function bindRemoteWorkspaceContextAndGetSession(params: {
  platform: Pick<IPlatformService, "bindRemoteWorkspaceSessionContext">;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: "project" | "conversation";
}): Promise<RemoteWorkspaceSession> {
  if (!getRemoteWorkspaceSession(params.sessionId)) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  const binding = await params.platform.bindRemoteWorkspaceSessionContext?.({
    remoteSessionId: params.sessionId,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    workspacePurpose: params.workspacePurpose,
  });
  // bind 会让同一 remoteSessionId 的 attachment/services 从 A 换代到 B。
  // bind 前捕获的对象仍指向 A，因此必须在 ready ACK 后按 sessionId 重新读取当前 services。
  const currentSession = getRemoteWorkspaceSession(params.sessionId);
  if (!currentSession) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  const workspaceIdentity =
    binding?.workspaceIdentity?.trim() ||
    currentSession.workspaceIdentity?.trim() ||
    params.workspaceIdentity?.trim();
  if (!workspaceIdentity) {
    throw new Error(`远程 workspace bind 未返回权威 identity: ${params.sessionId}`);
  }
  return {
    ...currentSession,
    ...(binding?.sourceServerId ? { sourceServerId: binding.sourceServerId } : {}),
    workspacePath: binding?.workspacePath ?? currentSession.workspacePath ?? params.workspacePath,
    workspaceIdentity,
    ...(binding?.workspacePurpose
      ? { workspacePurpose: binding.workspacePurpose }
      : params.workspacePurpose
        ? { workspacePurpose: params.workspacePurpose }
        : {}),
    ...(binding?.previousWorkspaceIdentity
      ? { previousWorkspaceIdentity: binding.previousWorkspaceIdentity }
      : {}),
  };
}

type BoundRemoteWorkspaceScope = Pick<
  BindRemoteWorkspaceSessionContextResult,
  "workspacePath" | "workspaceIdentity" | "previousWorkspaceIdentity" | "workspacePurpose"
>;

// INV-07：决定"这次失败要不要写进 settings"。
// 非 WSL 一律写：其它类型的关闭事件是可靠的最终结果。
// WSL 特殊，是因为它的 session 可能在手动重连之后才收到旧关闭事件——
// 若此时把 failed 写死，用户会看到"刚刚重连成功，列表却显示失败"。
// 判据是"该 key 是否已有 pending 重连"：有就说明最终结果还没到，交给重连流程决定。
export function shouldPersistRemoteWorkspaceFailure(params: {
  pendingReconnectRequestIds: ReadonlyMap<string, string>;
  sessionEntry: RemoteWorkspaceSessionEntry;
  workspaceKey: string;
}): boolean {
  if (params.sessionEntry.target.kind !== "wsl") {
    return true;
  }

  // WSL 偶发断连时，旧 session 的关闭事件可能会晚于手动重连流程。
  // 只要当前 workspace 已经有 pending reconnect，就先别把 failed 写死到 setting，
  // 让最终结果由这次重连成功/失败决定。
  return !params.pendingReconnectRequestIds.has(params.workspaceKey);
}
interface RemoteWorkspaceTabStoreReader {
  getState(): {
    tabs: WindowTabState[];
  };
}

interface OpenRemoteWorkspaceFromHistoryParams {
  workspaceKey: string;
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  inflightReconnectWorkspaceKeys: Set<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<BoundRemoteWorkspaceScope>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
  }) => void;
  createReconnectRequestId?: () => string;
  pendingReconnectRequestIds?: Map<string, string>;
  reconnectImpl?: typeof reconnectRemoteWorkspaceHistoryEntry;
}

interface ReconnectRemoteWorkspaceByKeyParams {
  workspaceKey: string;
  canUseRemoteWorkspace: boolean;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  runReconnectRemoteWorkspace: (
    sessionEntry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  options?: ReconnectRemoteWorkspaceOptions;
}

// 按 key 重连的薄封装：先做能力门禁，再按 key 查条目，最后交给注入的重连实现。
// 为什么重连实现是注入的（runReconnectRemoteWorkspace）：
// 本函数被菜单/快捷键等非 React 上下文调用，直接依赖 hook 闭包会拿到过期状态；
// 注入后调用方每次传当前的 `runReconnectRemoteWorkspace`，天然规避陈旧闭包。
// 找不到条目时抛错而不是静默返回：调用方（用户点击）需要知道"这个 workspace 不在
// 当前窗口"，否则表现为"点了没反应"。
export async function reconnectRemoteWorkspaceByKey({
  workspaceKey,
  canUseRemoteWorkspace,
  getRemoteSessions,
  runReconnectRemoteWorkspace,
  options,
}: ReconnectRemoteWorkspaceByKeyParams): Promise<boolean> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    throw new Error(`远程 workspace 不在当前窗口中，无法重连: ${workspaceKey}`);
  }

  await runReconnectRemoteWorkspace(sessionEntry, options);
  return true;
}

// INV-19：把"同一台 SSH 主机的所有断线 workspace"收成一个重连组。
// 目的很实际：SSH 的一次认证（密码/密钥/passphrase）只对一台 host 有效，
// 逐条重连会让用户为同一台机器输入 N 次密码。
// 入选条件（三者同时成立）：
//   1) 目标是 ssh 且 host key 相同（buildSshRemoteHostKey 会归一端口/用户名差异）；
//   2) 该条目确实在断线集合里（tab 无 remoteSessionId）——不能把已连上的条目拉进来，
//      否则重置凭据会把正在使用的连接踢掉；
//   3) 它还在当前 sessions 列表里（可能已被用户移除）。
// 非 SSH 目标直接返回单元素组：没有共享认证可言，分组只会增加协调成本。
// 返回顺序由调用方保证（见下方 initiator 注释），本函数不重排。
export function collectSshReconnectGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  sessions: RemoteWorkspaceSessionEntry[];
  tabs: WindowTabState[];
}): RemoteWorkspaceSessionEntry[] {
  if (params.selected.target.kind !== "ssh") {
    return [params.selected];
  }
  const remoteHostKey = buildSshRemoteHostKey(params.selected.target);
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      if (!isWorkspaceTab(tab) || tab.remoteSessionId) {
        return [];
      }
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const reconnectGroup = params.sessions.filter(
    (entry) =>
      entry.target.kind === "ssh" &&
      buildSshRemoteHostKey(entry.target) === remoteHostKey &&
      disconnectedWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  if (!reconnectGroup.some((entry) => buildWorkspaceSessionKey(entry) === selectedWorkspaceKey)) {
    return [params.selected];
  }

  // 历史记录顺序不代表本次重连发起者。initiator 必须固定在首位，
  // 否则并发加载凭据时 sibling 可能先创建共享 Host，导致整组误用旧凭据。
  return [
    params.selected,
    ...reconnectGroup.filter((entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey),
  ];
}

interface RemoteWorkspaceReconnectRendererState {
  attemptedWorkspaceKeys: Set<string>;
  currentRendererDisconnectedSourceServerIds: Set<string>;
  pendingTerminallyDisconnectedSourceServerIds: Set<string>;
  observedOnlineSourceServerIds: Set<string>;
}

// 启动阶段的重连分组（按 Source 设备聚合）。与 SSH 组不同，这里的"组"不是共享认证，
// 而是共享一台 Source 的物理连接：Source 已 online 时，其下所有 workspace 理论上
// 都能直接挂 attachment，不需要再建 Host。
// 准入判定 resolveEligibleSourceServerId 依次排除：
//   - conversation 用途：对话工作区不自动重连（它由对话自身生命周期管理）；
//   - identity 不是 server：SSH/WSL 不能无人值守重连；
//   - 设备处于"终止性断开"：重连必然失败，还会产生假失败记录；
//   - 该 tab 不在断线集合里：已经连上的不要重复创建 attachment；
//   - 本 Renderer 已尝试过且未观察到本次断开：防重，但设备真的掉线后要允许重试；
//   - 设备不在 online 集合里：最终门槛（INV-10 的批量版）。
// 手动向导正在打开的 tab 要排除：它会自己 bind，重复挂载会产生两个 attachment。
export function collectStartupRemoteWorkspaceReconnectGroups(params: {
  sessions: RemoteWorkspaceSessionEntry[];
  manuallyOpeningWorkspaceTabId?: string;
  tabs: WindowTabState[];
  attemptedWorkspaceKeys: ReadonlySet<string>;
  onlineSourceServerIds: ReadonlySet<string>;
  currentRendererDisconnectedSourceServerIds?: ReadonlySet<string>;
  pendingTerminallyDisconnectedSourceServerIds?: ReadonlySet<string>;
}): Array<{ sourceServerId: string; entries: RemoteWorkspaceSessionEntry[] }> {
  // Bug 原因：设备级 7 天门禁已由 Host 启动重连按 lastOnlineAt 执行；这里再按工作区
  // lastOpenedAt 过滤，只会让同一设备下部分 tab 上线、部分停留在未连接。Renderer 挂回
  // 只看 open membership、稳定 identity 与设备 online，不再按工作区年龄过滤。
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      // 手动向导持有该 tab 的绑定意图，Source online 不能同时重复创建 attachment。
      if (tab.id === params.manuallyOpeningWorkspaceTabId) return [];
      if (!isWorkspaceTab(tab) || tab.remoteSessionId || tab.workspacePurpose === "conversation")
        return [];
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const resolveEligibleSourceServerId = (session: RemoteWorkspaceSessionEntry): string | null => {
    if (session.workspacePurpose === "conversation") return null;
    const workspaceKey = buildWorkspaceSessionKey(session);
    const parsed = session.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(session.workspaceIdentity)
      : null;
    // identity 解析失败（老数据/被篡改）时 sourceServerId 为 undefined，
    // 后续所有条件都会失败 → 该条目不会自动重连，但也不会被删除。
    const sourceServerId = parsed?.kind === "server" ? parsed.sourceServerId : undefined;
    // 区分"本 Renderer 观察到设备掉线"与"仅历史里标过 attempted"：
    // 只有观察到掉线，才允许对同一 key 再试一次（见 INV 的防重语义）。
    const disconnectedInCurrentRenderer = Boolean(
      sourceServerId && params.currentRendererDisconnectedSourceServerIds?.has(sourceServerId),
    );
    if (
      (sourceServerId &&
        params.pendingTerminallyDisconnectedSourceServerIds?.has(sourceServerId)) ||
      !disconnectedWorkspaceKeys.has(workspaceKey) ||
      (params.attemptedWorkspaceKeys.has(workspaceKey) && !disconnectedInCurrentRenderer)
    ) {
      return null;
    }
    return sourceServerId && params.onlineSourceServerIds.has(sourceServerId)
      ? sourceServerId
      : null;
  };
  // 用 Map 聚合而非排序后相邻合并：sessions 的顺序来自持久化存储，
  // 同一设备的条目可能不相邻（用户可按最近打开时间交错排列）。
  // Map 同时保证"每个设备只出现一组"，组内顺序保留 sessions 原序（便于稳定输出）。
  const groups = new Map<string, RemoteWorkspaceSessionEntry[]>();
  for (const session of params.sessions) {
    const sourceServerId = resolveEligibleSourceServerId(session);
    if (!sourceServerId) {
      continue;
    }
    // Bug 根因：断开会把保留工作区全部写成 failed，冷启动再以 connected 历史准入会
    // 永久跳过已 online 的设备。Host online 是连接权威，历史结果不再否决 open attachment 恢复。
    const entries = groups.get(sourceServerId) ?? [];
    entries.push(session);
    groups.set(sourceServerId, entries);
  }
  return [...groups].map(([sourceServerId, entries]) => ({
    sourceServerId,
    entries,
  }));
}

// 设备离开 online 时，清掉该设备下所有 workspace 的"已尝试"标记。
// 这是"一次性防重"与"可重试"之间的平衡点：
//   不清 → 设备重启回来后，历史里那些 workspace 会永远被当成"试过了"而不再挂载；
//   全清 → 同一连接周期内的反复渲染会不断重试，造成重连风暴。
// 因此只清"当前确实不在 online"的那台设备，其余保留。
// 早退条件（online / 已在 online 集合 / 无 sourceServerId）都表示"设备没掉线"，
// 此时清标记等于允许重复重连，是错的。
export function updateStartupRemoteWorkspaceReconnectAttemptsForSourceState(params: {
  state: {
    state: SourceServerConnectionState;
    sourceServerId?: string;
  };
  onlineSourceServerIds: ReadonlySet<string>;
  sessions: readonly RemoteWorkspaceSessionEntry[];
  attemptedWorkspaceKeys: Set<string>;
}): void {
  const sourceServerId = params.state.sourceServerId;
  if (
    !sourceServerId ||
    params.state.state === "online" ||
    params.onlineSourceServerIds.has(sourceServerId)
  ) {
    return;
  }
  // Bug 原因：启动恢复的去重标记过去覆盖整个 Renderer 生命周期，设备断开后仍未失效。
  // 下一次 Source 虽然恢复为 online，已有 workspace 会继续被当成“尝试过”而跳过重挂。
  // 设备真正离开 online 时只清理该 Source 的标记，保留同一连接周期内的一次性防重语义。
  for (const session of params.sessions) {
    const parsed = session.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(session.workspaceIdentity)
      : null;
    if (parsed?.kind === "server" && parsed.sourceServerId === sourceServerId) {
      params.attemptedWorkspaceKeys.delete(buildWorkspaceSessionKey(session));
    }
  }
}

// 执行一个重连组（SSH 组或单条）。这是本文件并发语义最重的地方，设计目标是：
//   A. initiator（用户点的那条）先建好共享 Host，其余 sibling 再并行挂 attachment；
//   B. sibling 的失败不影响 initiator，也不互相影响（allSettled）；
//   C. throwOnFailure 只对"调用方明确要求感知失败"的路径生效（例如用户手动重连）。
// 非 SSH 目标退化为"单条重连"，但仍保留 throwOnFailure 语义：
// 这是唯一的兼容分支，别把 SSH 的组逻辑套进去（没有 Host 可共享）。
export async function reconnectRemoteWorkspaceGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  reconnectGroup: RemoteWorkspaceSessionEntry[];
  reconnectEntry: (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<boolean>;
  options?: ReconnectRemoteWorkspaceOptions;
}): Promise<void> {
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  const siblings = params.reconnectGroup.filter(
    (entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey,
  );

  if (params.selected.target.kind !== "ssh") {
    try {
      await params.reconnectEntry(params.selected, {
        ...params.options,
        throwOnFailure: true,
      });
    } catch (error) {
      if (params.options?.throwOnFailure) {
        throw error;
      }
    }
    return;
  }

  type InitiatorHostGate =
    | { status: "ready"; credentials: SshReconnectCredentials }
    | { status: "skipped" }
    | { status: "failed"; error: unknown };
  // Host 就绪门：一个手写的、只能 resolve 一次的 Promise。
  // 用 Promise 而不是 setState/事件，是因为这里要在"异步回调与 Promise 结果"之间做 race，
  // Promise 是唯一能同时表达"还没好 / 好了 / 直接失败"的原语。
  // resolveHostReady 的 definite-assignment 断言是必要的：tsc 无法证明
  // executor 会同步执行，实际语义上它一定先于任何 await 被赋值。
  // hostReadyCredentials 单独存一份：sibling 需要的是凭据值，而不只是"已就绪"信号。
  let hostReadyCredentials: SshReconnectCredentials | undefined;
  let resolveHostReady!: (result: InitiatorHostGate) => void;
  const hostReadyPromise = new Promise<InitiatorHostGate>((resolve) => {
    resolveHostReady = resolve;
  });

  // 组内并发连接会让最先完成 credential load 的 sibling 抢建共享 Host。
  // initiator 先负责把 Host 建到 ready；后续 provider/task 初始化不再阻塞 sibling attachment。
  const initiatorPromise = params.reconnectEntry(params.selected, {
    ...params.options,
    throwOnFailure: true,
    onSshHostReady: (credentials) => {
      if (hostReadyCredentials) {
        return;
      }
      hostReadyCredentials = credentials;
      resolveHostReady({ status: "ready", credentials });
    },
  });
  // "initiator 先结束、Host 却从未就绪"的三个分支必须显式处理，否则 race 会永远挂着：
  //   - 有凭据但没触发回调：说明回调在完成后才到，仍按 ready 放行；
  //   - 成功返回却没就绪：属于实现违约，转成 failed，避免 sibling 无限等待；
  //   - 直接失败：原样透传（含 throwOnFailure 时的上抛）。
  // 把 reject 也映射成值而不是继续抛：race 的另一头是 hostReadyPromise，
  // 若这里保留 reject，Promise.race 会把未处理的拒绝泄漏成全局错误。
  const initiatorFinishedBeforeReady = initiatorPromise.then<InitiatorHostGate, InitiatorHostGate>(
    (didReconnect) => {
      if (hostReadyCredentials) {
        return { status: "ready", credentials: hostReadyCredentials };
      }
      return didReconnect
        ? {
            status: "failed",
            error: new Error("SSH initiator completed without reporting Host ready"),
          }
        : { status: "skipped" };
    },
    (error: unknown) =>
      hostReadyCredentials
        ? { status: "ready", credentials: hostReadyCredentials }
        : { status: "failed", error },
  );
  // 只等"第一个确定的结论"：Host 就绪，或 initiator 提前结束/失败。
  // 注意这里不 await initiatorPromise：它的后续 provider/task 初始化可能很久，
  // 等它会把 sibling 全部拖住，违背"Host ready 即可挂 attachment"的设计。
  const hostGate = await Promise.race([hostReadyPromise, initiatorFinishedBeforeReady]);
  if (hostGate.status !== "ready") {
    // skipped 表示"initiator 判定没什么可做"（例如已被别处连接），此时不启动 sibling：
    // 它们共享同一台 host，initiator 的结果对它们同样成立。
    if (hostGate.status === "failed" && params.options?.throwOnFailure) {
      throw hostGate.error;
    }
    return;
  }

  // sibling 只复用 initiator credential 命中 ready Host，不再读取各自历史 credential；
  // path/provider/task 初始化与 initiator 并行并保持独立失败语义。
  // 两个必须保留的参数：
  //   activateWorkspaceAfterReconnect:false —— 只有用户点的那条才切前台，
  //     否则恢复 5 个 workspace 会把 tabs 连续切 5 次，视觉上像闪烁；
  //   sshCredentialsOverride —— 绕过各自的 credential 读取，避免同一 host 反复弹密码。
  // allSettled 是刻意的：任一条目失败只影响它自己，不能让整组结果被一个坏条目污染。
  const siblingPromise = Promise.allSettled(
    siblings.map((entry) =>
      params.reconnectEntry(entry, {
        ...params.options,
        activateWorkspaceAfterReconnect: false,
        sshCredentialsOverride: hostGate.credentials,
      }),
    ),
  );
  const [initiatorResult] = await Promise.all([
    initiatorPromise.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    siblingPromise,
  ]);
  if (initiatorResult.status === "rejected" && params.options?.throwOnFailure) {
    throw initiatorResult.error;
  }
}

// Source 设备级恢复：与 SSH 组的关键区别是"没有 Host gate"。
// Source 的物理连接由 Management 持有并已确认 online，这里只需要逐个挂 logical
// attachment，所以串行即可（并发创建会争抢同一台 Source 的目录监听，反而不稳）。
// 每个条目独立 try/catch：某一条次的 path 失效（目录被删/权限变化）不能阻断其它目录恢复。
export async function restoreSourceRemoteWorkspaceGroup(params: {
  entries: RemoteWorkspaceSessionEntry[];
  reconnectEntry: (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<boolean>;
  options?: ReconnectRemoteWorkspaceOptions;
}): Promise<void> {
  // Source 已由 Management 确认为 online；此处只恢复 logical attachments，不再用某个
  // workspace 充当 physical Host gate。成员 live/inflight 返回 false 只结算自己，不能终止 siblings。
  for (const entry of params.entries) {
    try {
      await params.reconnectEntry(entry, params.options);
    } catch (error) {
      if (params.options?.throwOnFailure) throw error;
    }
  }
}

// 判断"重新连上的这个 workspace 是否仍然开着 tab"。
// 为什么需要它：连接是异步的，用户在连接期间可能已经关掉了那个 tab；
// 此时不该再为它写历史、加 tab 或弹提示。
// 匹配用两个条件做"或"：
//   1) identity（缺省回退 path）相等 —— 同一身份的不同路径也算命中；
//   2) path 完全相等 —— 兼容 identity 缺失的老条目。
// 只在 identity 缺失时才回退到 path 作 key，是为了避免两个不同设备的同名路径
// （/home/dev）互相命中，导致"关掉 A 的 tab 却把 B 也跳过了"。
function shouldKeepRemoteWorkspaceInTabs(params: {
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  workspacePath: string;
  workspaceIdentity?: string;
}): boolean {
  const reconnectWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return params.tabStoreApi
    .getState()
    .tabs.some(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        ((tab.workspaceIdentity?.trim() || tab.workspacePath) === reconnectWorkspaceKey ||
          tab.workspacePath === params.workspacePath),
    );
}

// 批量取消"仍在等待中的重连请求"（例如用户清空历史、关闭窗口）。
// 三个要点：
//   1) 先在所有 key 上 delete，再统一发取消：若边删边发，某个取消回调里再读到
//     pendingRequestIds 时状态是不完整的，会漏取消；
//   2) 没有注入 cancelPendingRemoteConnection（旧平台不支持）时只清表不发请求：
//      清表保证后续 UI 不再认为"还在连"，但不假装已经取消成功；
//   3) 每个取消都 catch 成 warn：取消失败只意味着远端会话会自然超时，
//      不该让"关闭窗口"这个动作因为清理失败而报错。
export async function cancelPendingRemoteReconnectsForWorkspaceKeys(params: {
  workspaceKeys: string[];
  pendingRequestIds: Map<string, string>;
  cancelPendingRemoteConnection?: (requestId?: string) => Promise<void>;
  logger: Pick<typeof logger, "warn">;
}): Promise<void> {
  const requestIds = params.workspaceKeys.flatMap((workspaceKey) => {
    const requestId = params.pendingRequestIds.get(workspaceKey);
    if (!requestId) {
      return [];
    }

    params.pendingRequestIds.delete(workspaceKey);
    return [requestId];
  });

  if (!params.cancelPendingRemoteConnection || requestIds.length === 0) {
    return;
  }

  await Promise.all(
    requestIds.map(async (requestId) => {
      try {
        await params.cancelPendingRemoteConnection?.(requestId);
      } catch (error) {
        params.logger.warn("[Root] 取消远程 workspace 重连失败", {
          requestId,
          error,
        });
      }
    }),
  );
}

// 从历史列表点击一个条目：三种结局，且都必须幂等。
//   1) 条目已不在列表 → 静默返回（用户可能在别处删除了它）；
//   2) 该 key 已在重连中 → 静默返回（防重，INV-03）；
//   3) 已有 remoteSessionId 的 tab → 只激活，不重连（这是"打开"而不是"重连"）。
// 只有"存在且未连接"才真正发起重连，并在此过程中：
//   - 重置该 key 的日志（INV-17），
//   - 占用 inflight 标记（INV-03），
//   - 生成 requestId 并登记到 pending 表（INV-04），
//   - finally 中按 requestId 精确释放（避免误删下一次重连的登记）。
export async function openRemoteWorkspaceFromHistoryEntry({
  workspaceKey,
  tabStoreApi,
  getRemoteSessions,
  inflightReconnectWorkspaceKeys,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  bindRemoteWorkspaceScope,
  disposeRemoteWorkspaceSession,
  addTab,
  commitRemoteWorkspaceSessionMutation,
  resetLogsForWorkspaceKey,
  createReconnectRequestId,
  pendingReconnectRequestIds,
  reconnectImpl = reconnectRemoteWorkspaceHistoryEntry,
  onWorkspaceActivated,
}: OpenRemoteWorkspaceFromHistoryParams): Promise<void> {
  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    return;
  }

  // INV-03：inflight 是同步 Set，在事件入口即可判定，不受 React 渲染延迟影响。
  // 这里 return 而不是抛错：重复点击是正常用户行为，不该报错。
  if (inflightReconnectWorkspaceKeys.has(workspaceKey)) {
    return;
  }

  const existingWorkspaceTab = tabStoreApi
    .getState()
    .tabs.find(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
    );
  // 已连接的情况只激活 tab：不能再走 reconnectImpl，否则会在已有 attachment 之上
  // 再建一个，两个 owner 抢同一 workspace，表现为"目录列表偶尔空、偶尔重复"。
  // 用 tab 上的 workspacePath 而不是 sessionEntry 的 path：tab 才是用户肉眼看到的那个。
  if (existingWorkspaceTab?.remoteSessionId) {
    activateTabByPath(existingWorkspaceTab.workspacePath, {
      workspaceIdentity: existingWorkspaceTab.workspaceIdentity,
    });
    return;
  }

  // 选择页远程历史与侧栏重连都属于“恢复已有 remote workspace”语义。
  // 如果这里缺少“仍需保留该 workspace”的二次校验，用户在重连中移除后仍会被成功回调重新加回 tab。
  // 这里复用同一套 shouldKeep 判定，保证两条入口的竞态行为一致。
  // 顺序：先清日志，再占 inflight，最后登记 requestId。
  // 清日志放在最前，保证"重连开始"这条日志不会混进上一次的残留；
  // 占 inflight 必须在第一个 await 之前完成，否则两个同步点击能同时通过上面的检查。
  resetLogsForWorkspaceKey(workspaceKey);
  inflightReconnectWorkspaceKeys.add(workspaceKey);
  const requestId = createReconnectRequestId?.();
  if (requestId) {
    pendingReconnectRequestIds?.set(workspaceKey, requestId);
  }
  try {
    await reconnectImpl({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath,
      bindRemoteWorkspaceIdentity,
      upsertWorkspaceTab: addTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions,
      logger,
      toast,
      shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
        shouldKeepRemoteWorkspaceInTabs({
          tabStoreApi,
          workspacePath,
          workspaceIdentity,
        }),
      onWorkspaceActivated: (target) => {
        logger.debug("[Root] 远程历史 workspace ready，提交 tab 与 draft 激活", target);
        onWorkspaceActivated?.(target);
      },
      options: {
        // 历史入口固定 activateWorkspaceAfterReconnect:true（用户点了它就是要进去），
        // 且 showErrorToast:true（此处没有别的错误出口，必须让用户看到失败）。
        // requestId 透传下去，供 helper 内部做"迟到结果丢弃"。
        // 历史入口过去只回填 connected tab，却没有提交 tab activation 和 draft owner，
        // 所以连接成功后右侧仍停留在旧 workspace。共享 helper 只会在 services ready 后执行此提交，
        // 不会提前暴露缺少 remoteSessionId 的 remote-waiting tab。
        activateWorkspaceAfterReconnect: true,
        showErrorToast: true,
        requestId,
      },
    });
  } finally {
    // finally 在成功与异常路径都会执行，是唯一可靠的释放点。
    // pending 表的删除必须比对 requestId（INV-04）：若用户在这条重连结束前又触发了
    // 一次新的重连，表里存的已是新 id，此处删除会抹掉新请求的登记。
    // inflight Set 则可以直接按 key 删除：同一个 key 在 set 中不区分代次，
    // 但新请求只会在旧请求释放后才开始（由上面的 has 判断保证）。
    inflightReconnectWorkspaceKeys.delete(workspaceKey);
    if (requestId && pendingReconnectRequestIds?.get(workspaceKey) === requestId) {
      pendingReconnectRequestIds.delete(workspaceKey);
    }
  }
}

// 向导提交目录的纯函数主体（不依赖 React）。整个流程是一个"要么全部成功、要么回滚"的事务：
//   canonical 归一 → 复用/新建 tab → bind scope → 写历史 → addTab → 激活。
// 事务边界由注入的 isCurrent 控制：每个 await 之后都要求它仍为真，否则释放 session 并退出。
// 三个易错点已在实现处标注：
//   1) 已存在的断连 tab 不能先 activate 再 bind（会短暂用旧 scope 渲染目录）；
//   2) 写历史必须早于 addTab（否则崩溃重启后 tab 在、历史没了）；
//   3) 取消与失败是两种语义，前者不写 failed 历史、不弹错误。
export async function selectRemoteWorkspaceProjectFromDialog({
  canUseRemoteWorkspace,
  sessionId,
  path,
  preparedWorkspaceIdentity,
  draftProjectId,
  localWorkspacePath,
  loadingMessage,
  getRemoteWorkspaceSession,
  connectionTarget,
  getWorkspaceTabs,
  restoringWorkspaceTabId,
  resolveRemoteWorkspaceCanonicalPath,
  activateTabByPath,
  handleCancelRemoteProject,
  bindRemoteWorkspaceScope,
  workspacePurpose,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  addTab,
  onWorkspaceActivated,
  isCurrent,
}: {
  canUseRemoteWorkspace: boolean;
  isCurrent?: () => boolean | Promise<boolean>;
  sessionId: string;
  path: string;
  preparedWorkspaceIdentity?: string;
  draftProjectId?: string | null;
  workspacePurpose?: "project" | "conversation";
  localWorkspacePath?: string;
  loadingMessage: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  connectionTarget?: Parameters<IPlatformService["connectRemote"]>[0];
  getWorkspaceTabs: () => WindowTabState[];
  /** 手动向导正在重连的 tab；目标与它同 workspace 时挂回原会话，不新建任务。 */
  restoringWorkspaceTabId?: string;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  handleCancelRemoteProject: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<BoundRemoteWorkspaceScope>;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  bindRemoteWorkspacePath: (workspacePath: string, sessionId: string) => void;
  bindRemoteWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
    },
  ) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
    projectId?: string | null;
  }) => void;
}): Promise<void> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  // 三步式提交的核心守卫：每个 await 之后都重新确认"这次目录选择是否仍然有效"。
  // 为什么必须有这个函数：选目录包含 realpath、bind、写盘、建 tab 四段 IO，
  // 用户完全可能在中途取消或切到别的项目；没有这道检查，取消之后仍会落库并打开 tab。
  // 错误用 code 标记为 remote-connection-canceled，调用方据此走"取消"而不是"失败"分支。
  const assertCurrent = async () => {
    // 原项目成员由 Host 持有；异步校验必须等到结果，不能把 Promise 当作有效意图。
    if ((await isCurrent?.()) === false)
      throw Object.assign(new Error("project.navigation-cancelled"), {
        code: "remote-connection-canceled",
      });
  };
  await assertCurrent();
  const remoteSession = getRemoteWorkspaceSession(sessionId);
  if (!remoteSession) {
    throw new Error(loadingMessage);
  }
  const remoteTarget = connectionTarget ?? remoteSession.target;
  if (!remoteTarget) {
    // 手机 web relay 复用 remote session store 只做服务路由，没有本地可重连 target。
    // 远程历史的选目录/持久化流程必须有 target，缺失时直接阻断，避免把无 target 的桥接 session 写进历史。
    throw new Error(`远程 workspace session 缺少连接目标: ${sessionId}`);
  }

  // Bug 原因：项目已经给出 Host 的 cwd/identity，再 realpath 会将路径别名拆成两个 scope。
  // 只有普通目录选择解析用户路径；已准备的目录仍由 Host bind 校验，不能放宽 owner 判断。
  const canonicalPath = preparedWorkspaceIdentity
    ? path
    : await resolveRemoteWorkspaceCanonicalPath(sessionId, path);
  // Bug 原因：Renderer 过去用 transport target 生成 route-derived identity，与 Host 已绑定的
  // remote:server:* stable identity 分裂。先完成 Host bind，再只消费权威 scope。
  // 这次 bind 同时决定手机远控能否桥接：新建连接不带 context 时 main descriptor 停在连接根目录 "/"，
  // bridge 按 tab 的 path/identity 三元比对 descriptor，缺少 bind 会被 REMOTE_WORKSPACE_IDENTITY_MISMATCH
  // 拒绝（3.12.0 曾因此连不上远程项目）。bind 失败由 hook 侧回收 session 并抛回弹窗，不落库、不建 tab。
  await assertCurrent();
  const boundScope = await bindRemoteWorkspaceScope(
    sessionId,
    canonicalPath,
    preparedWorkspaceIdentity,
    workspacePurpose ?? "project",
  );
  await assertCurrent();
  const workspacePath = boundScope.workspacePath;
  const workspaceIdentity = boundScope.workspaceIdentity;
  const existingWorkspaceTab = getWorkspaceTabs().find(
    (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
      isWorkspaceTab(tab) &&
      tab.workspacePath === workspacePath &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceIdentity,
  );
  // Bug 根因：会话横幅“重新连接”→ 向导“重试”成功后走的是普通“打开项目”路径，激活回调
  // 没带 restoreSelection，Root 据此把原会话覆盖成空白草稿（RDUX-09 要求挂回保持原选择）。
  // bcc1ae5fc8 曾在调用点补过这层判断，合并时丢失；现在由本函数按向导持有的 tab 意图统一决定。
  const restoringTab = restoringWorkspaceTabId
    ? getWorkspaceTabs().find((tab) => tab.id === restoringWorkspaceTabId)
    : undefined;
  const activation = {
    workspacePath,
    workspaceIdentity,
    ...(draftProjectId !== undefined ? { projectId: draftProjectId } : {}),
    // 显式项目草稿与恢复旧会话互斥；后台重连中的同一 tab 不能覆盖新建意图。
    ...(draftProjectId === undefined &&
    restoringTab &&
    isWorkspaceTab(restoringTab) &&
    buildWorkspaceSessionKey(restoringTab) ===
      buildWorkspaceSessionKey({ workspacePath, workspaceIdentity })
      ? { restoreSelection: true }
      : {}),
  };

  if (
    existingWorkspaceTab?.remoteSessionId &&
    activateTabByPath(workspacePath, { workspaceIdentity })
  ) {
    if (
      workspacePurpose === "conversation" &&
      existingWorkspaceTab.workspacePurpose !== "conversation"
    ) {
      addTab(workspacePath, {
        remoteSessionId: existingWorkspaceTab.remoteSessionId,
        remoteTarget: stripRemoteTargetSecrets(remoteTarget),
        workspaceIdentity,
        workspacePurpose: "conversation",
      });
    }
    clearRemoteWorkspaceConnectionState(workspaceIdentity);
    if (boundScope.previousWorkspaceIdentity) {
      clearRemoteWorkspaceConnectionState(boundScope.previousWorkspaceIdentity);
    }
    onWorkspaceActivated?.(activation);
    // Bug 原因：项目历史会复用当前 owner；旧分支将它误当临时连接取消，导致任务重开后断线。
    if (existingWorkspaceTab.remoteSessionId !== sessionId)
      await handleCancelRemoteProject(sessionId);
    return;
  }

  // 走到这里说明"还没有可用的已连接 tab"，要新建或修复一条。
  // 两段式提交：
  //   A. 先写 settings（commitMutation），状态为 connected；
  //   B. 再写内存绑定（bindPath / bindIdentity）并 addTab。
  // 顺序是刻意的：settings 是"下次启动能否恢复"的依据，必须先落；
  // 若先写内存绑定再写盘，写盘失败会留下"本窗口能打开、重启后消失"的条目。
  // assertCurrent 夹在 A、B 之间，确保取消后不会继续建 tab。
  // 断连 tab 以前会在 provider/session 绑定完成前先被 activateTabByPath 激活，
  // V4PaneConversationProvider 此时只能得到 remote-waiting，因 rpcReady=false 返回 null，
  // 右侧便会先空白，等后续 addTab 写回 remoteSessionId 后才出现新建对话。
  // 断连 tab 与首次连接统一等到服务绑定完成后再由 addTab 原子激活，避免暴露半连接 workspace。

  // Bug 原因：远程首次选目录时如果先写 lastWorkspaceSession，再执行 Host bind，
  // bind 失败会留下“记录显示已连接但实际 session 已回收”的脏状态。
  // 这里先完成 Host bind 成功，再提交 connected 状态，保证持久化状态与真实连接一致。
  await commitRemoteWorkspaceSessionMutation(
    buildRemoteWorkspaceSessionMutation({
      remoteSessions: getRemoteSessions(),
      workspacePath,
      localWorkspacePath,
      workspaceIdentity,
      target: remoteTarget,
      workspacePurpose: workspacePurpose ?? "project",
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    }),
  );

  await assertCurrent();
  bindRemoteWorkspacePath(workspacePath, sessionId);
  bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);
  // Bug 原因：旧版 route tab 与新版 stable identity 不相等时，直接 addTab 会制造第二个
  // workspace。Host 返回的 previousWorkspaceIdentity 只用于 TabStore 原地 rekey，保留原 tab。
  addTab(workspacePath, {
    remoteSessionId: sessionId,
    remoteTarget: stripRemoteTargetSecrets(remoteTarget),
    workspaceIdentity,
    ...(boundScope.previousWorkspaceIdentity
      ? { previousWorkspaceIdentity: boundScope.previousWorkspaceIdentity }
      : {}),
    localWorkspacePath,
    workspacePurpose: workspacePurpose ?? "project",
  });
  // Bug 根因：设备重连弹窗直接走 workspace select，不经过侧栏 reconnect wrapper；只写回
  // remoteSessionId 而不清 overlay 会让已恢复的 task 继续显示“远程连接暂不可用”。attachment
  // 已绑定成功后立即按 stable identity 收敛连接事实，legacy rekey 残留也一并清理。
  clearRemoteWorkspaceConnectionState(workspaceIdentity);
  if (boundScope.previousWorkspaceIdentity) {
    clearRemoteWorkspaceConnectionState(boundScope.previousWorkspaceIdentity);
  }
  // 修复原因：旧链路等待无人消费的列表缓存，导致 tab 与草稿 owner 交接分叉。
  // attachment 和 tab 已就绪后立即提交同一 workspaceKey 的草稿，项目树自行读取权威行。
  onWorkspaceActivated?.(activation);
}

// 对话 workspace 的打开流程（独立于项目流程）：
//   1) 解析 Source：session 上可能没带 sourceServerId，需要从 identity 再取；
//   2) 确保对话根目录存在（由 Source management 负责，可能需要远端建目录）；
//   3) 连接/复用 session → 选目录（用途 conversation）→ 持久化。
// 与项目流程最大的不同：目录不由用户指定，因此不需要 canonical 冲突处理与"用户意图"确认；
// 但同样必须处理"步骤中途 session 被取消"的回滚，否则会留下一个已 bind 但无人使用的 session。
export async function openRemoteConversationWorkspace(params: {
  sessionId: string;
  sourceServerId?: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  getSettings: () => Promise<
    Pick<AppSettings, "sourceServerWorkspaceHistory" | "connectionProfiles">
  >;
  loadCredential: (key: string) => Promise<string | null>;
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
  ) => Promise<string>;
  waitForRemoteWorkspaceSessionReady: (sessionId: string) => Promise<void>;
  ensureConversationWorkspace: (sourceServerId: string) => Promise<{ path: string }>;
  selectRemoteWorkspace: (
    sessionId: string,
    workspacePath: string,
    workspacePurpose: "conversation",
  ) => Promise<void>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
}): Promise<void> {
  const initialSession = params.getRemoteWorkspaceSession(params.sessionId);
  let conversationSessionId = params.sessionId;
  let remoteSession = initialSession;
  let resolvedSourceServerId = params.sourceServerId ?? remoteSession?.sourceServerId;
  let ownedConversationSessionId: string | undefined;

  try {
    // 每次新建使用独立 cwd；已绑定的 project / conversation 都必须保留原 logical scope。
    // 本函数创建的新 session
    // 在成功交给 tab 前由本函数独占，任何 ensure/bind/provider 失败都必须在这里回收。
    // Bug 根因：刚连接但尚未 bind 的 session 也携带 bootstrap 根路径；仅凭 workspacePath
    // 会把它误判成 project 并查询不存在的 project history。purpose 才是 logical scope 的权威。
    if (remoteSession?.workspacePath && remoteSession.workspacePurpose) {
      const settings = await params.getSettings();
      const history = (settings.sourceServerWorkspaceHistory ?? []).find(
        (entry) =>
          entry.workspacePath === remoteSession?.workspacePath &&
          entry.workspaceIdentity === remoteSession?.workspaceIdentity,
      );
      const profile = history?.profileId
        ? settings.connectionProfiles?.find(
            (candidate) => candidate.profileId === history.profileId,
          )
        : undefined;
      if (!profile) {
        throw new Error("Remote project connection profile is unavailable");
      }
      const target = buildRemoteTargetFromProfile(profile);
      const credentials = await loadConnectionProfileCredentials({
        profile,
        loadCredential: params.loadCredential,
      });
      const targetWithCredentials =
        target.kind === "ssh" && credentials
          ? {
              ...target,
              ...(credentials.password ? { password: credentials.password } : {}),
              ...(credentials.privateKeyPassphrase
                ? { privateKeyPassphrase: credentials.privateKeyPassphrase }
                : {}),
            }
          : target;
      conversationSessionId = await params.connectRemoteWorkspaceTarget(targetWithCredentials);
      ownedConversationSessionId = conversationSessionId;
      await params.waitForRemoteWorkspaceSessionReady(conversationSessionId);
      remoteSession = params.getRemoteWorkspaceSession(conversationSessionId);
      resolvedSourceServerId = resolvedSourceServerId ?? profile.sourceServerId;
    }
    if (!resolvedSourceServerId) {
      throw new Error("Remote conversation requires an identified Source Server");
    }
    const conversation = await params.ensureConversationWorkspace(resolvedSourceServerId);
    await params.selectRemoteWorkspace(conversationSessionId, conversation.path, "conversation");
    ownedConversationSessionId = undefined;
  } catch (error) {
    if (ownedConversationSessionId) {
      await params
        .disposeRemoteWorkspaceSession(ownedConversationSessionId)
        .catch((disposeError) => {
          logger.warn("[Root] 回收失败的远程 conversation session 失败", {
            sessionId: ownedConversationSessionId,
            error: disposeError,
          });
        });
    }
    throw error;
  }
}

// 计算"某台 Source 的对话 workspace 投影"：把持久化的 per-source 对话目录映射成
// 列表项需要的形状（key、path、label、是否存在）。
// 纯函数，不做 IO：调用方（UI）可以高频重算而不触发网络/磁盘访问。
// 缺失映射返回 null，而不是造一个默认目录——对话目录必须由 Source 真实创建过，
// 凭空给一个路径会让用户点进一个不存在的目录。
export async function resolveSourceRemoteConversationWorkspaceProjection(params: {
  sourceServerId: string;
  remoteSessions: readonly RemoteWorkspaceSessionEntry[];
  conversationWorkspaceMap: AppSettings["remoteConversationWorkspaceBySourceServerId"];
  ensureConversationWorkspace: (sourceServerId: string) => Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
}): Promise<{
  conversationWorkspaceMap: NonNullable<AppSettings["remoteConversationWorkspaceBySourceServerId"]>;
  remoteSessions: RemoteWorkspaceSessionEntry[];
  updatedEntries: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
}> {
  let conversationWorkspaceMap = params.conversationWorkspaceMap ?? {};
  if (!conversationWorkspaceMap[params.sourceServerId]) {
    const conversation = await params.ensureConversationWorkspace(params.sourceServerId);
    conversationWorkspaceMap = {
      ...conversationWorkspaceMap,
      [params.sourceServerId]: {
        workspacePath: conversation.path,
        lastResolvedAt: Date.now(),
      },
    };
  }
  return {
    conversationWorkspaceMap,
    ...projectRemoteConversationWorkspacePurpose(params.remoteSessions, conversationWorkspaceMap),
  };
}

export function useRemoteWorkspaceHistory({
  intl,
  services,
  platform,
  supportsSettings,
  isDesktop = false,
  allowRemoteWorkspace = true,
  ensureConversationWorkspaceOnRestore = false,
  deferInactiveWorkspaceRestore = false,
  unavailableWorkspacePath,
  tabStoreApi,
  activateTabByPath,
  addTab,
  persistenceGate,
  onWorkspaceActivated,
  onOpenRemoteConnection,
  manuallyOpeningWorkspaceTabId,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  services: IServiceAccessor;
  platform: IPlatformService;
  supportsSettings: boolean;
  isDesktop?: boolean;
  allowRemoteWorkspace?: boolean;
  ensureConversationWorkspaceOnRestore?: boolean;
  /** 仅 Desktop 主窗口：输入可用后再把 inactive workspace 加入 sidebar/task 数据源。 */
  deferInactiveWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  persistenceGate?: WorkspacePersistenceGate;
  /** 仅用于从已保存 Profile 发起普通连接；实际连接仍由唯一 SSHDialog 承载。 */
  onOpenRemoteConnection?: (preference?: RemoteConnectionOpenPreference) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
    projectId?: string | null;
  }) => void;
  manuallyOpeningWorkspaceTabId?: string;
}) {
  // 能力门禁只有一个来源：入口可见性 × 外部允许。所有"能否连接/恢复"的判断都从它派生，
  // 避免出现"按钮隐藏了但快捷键还能连"这类越权路径。
  // allowRemoteWorkspaceRestore 目前与 canUse 同值，但语义独立（"恢复"比"新建"更危险，
  // 未来若需要"可新建不可自动恢复"的降级模式，只需要改这一行）。
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const allowRemoteWorkspaceRestore = canUseRemoteWorkspace;
  const [remoteWorkspaceSessions, setRemoteWorkspaceSessions] = useState<
    RemoteWorkspaceSessionEntry[]
  >([]);
  // state 与 ref 双份保存历史列表：state 驱动列表渲染，ref 供 await 回调读取。
  // 每次更新必须同时写两者（见 syncPersistedWorkspaceSession），否则会出现
  // "界面已删掉某条目，但重连逻辑仍认为它存在"的分裂真相。
  const remoteWorkspaceSessionsRef = useRef<RemoteWorkspaceSessionEntry[]>([]);
  // 渲染期直接给 ref 赋值（而不是放进 effect）：这个值在事件回调里被同步读取，
  // effect 的写入时机太晚，会导致"刚点开向导的下一帧"读到上一个 tab id。
  const manuallyOpeningWorkspaceTabIdRef = useRef(manuallyOpeningWorkspaceTabId);
  manuallyOpeningWorkspaceTabIdRef.current = manuallyOpeningWorkspaceTabId;
  // 延迟删除凭据：删除历史条目时如果立刻删 keychain，而写 settings 还没落盘，
  // 进程崩溃会留下"条目还在、凭据没了"的不可恢复状态。
  // 因此先把要删的 key 攒起来，等 persistenceGate 真正允许持久化时再执行。
  // Set 去重：同一 key 可能在多次移除中被重复登记。
  const pendingCredentialDeletesRef = useRef<Set<string>>(new Set());
  // flush 是"一次性取走再清空"：先 [...set] + clear()，再并发删除。
  // 顺序不能反——先 clear 再取会丢 key；边删边读 set 会在 await 期间把新登记的一起删掉
  // （那些属于下一次落盘的语义，不该被这一次消费）。
  // 单个删除失败只 warn：凭据残留是可接受的降级（多一个无用密钥），
  // 比"因为一个 keychain 报错就永远无法落盘"要好。
  const flushPendingCredentialDeletes = useCallback(async () => {
    const credentialKeys = [...pendingCredentialDeletesRef.current];
    pendingCredentialDeletesRef.current.clear();
    await Promise.all(
      credentialKeys.map(async (credentialKey) => {
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] 延迟删除远程 workspace 凭据失败", {
            credentialKey,
            error,
          });
        }
      }),
    );
  }, [services.credentialService]);
  // 把 flush 挂到门禁上（而不是自己监听某个事件）：门禁是"现在能落盘了"的唯一信号，
  // 由它回调才能保证"先落盘、再删凭据"的顺序；反过来先删，崩溃就会丢凭据。
  // 直接赋值而非 addEventListener：门禁只允许一个消费者，多挂会让清理动作被执行多次。
  if (persistenceGate) {
    persistenceGate.onCanPersist = flushPendingCredentialDeletes;
  }
  // reconnectingRemoteWorkspaceKeys 是"当前正在重连"的 key 列表（驱动列表项的 spinner 与
  // "恢复中"文案）。用数组而不是 Set，是因为它要参与 React 的引用比较与渲染序；
  // 真正的并发保护在下面的 ref 里。
  const [reconnectingRemoteWorkspaceKeys, setReconnectingRemoteWorkspaceKeys] = useState<string[]>(
    [],
  );
  // 恢复状态按 key 存：error / cancel / budgetExhausted 等，供列表行展示"为什么没恢复"。
  // 与 reconnectingKeys 分开：后者是"进行中"，前者是"上次结果"，可用于回显失败原因。
  const [remoteWorkspaceRecoveryByWorkspaceKey, setRemoteWorkspaceRecoveryByWorkspaceKey] =
    useState<Record<string, RemoteWorkspaceRecoveryStatus>>({});
  // 两个 ref 是并发控制真相（INV-03/04）：
  //   inflight：同步不可重入集合，防连点；
  //   pendingRequestIds：key → 本次请求 id，用于"迟到结果丢弃"与精确清理。
  // 它们刻意不进 state：更新它们不该触发渲染，而且要在 await 之间保持最新。
  const inflightReconnectWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const pendingReconnectRequestIdsRef = useRef<Map<string, string>>(new Map());
  const pendingConnectionTargetsBySessionIdRef = useRef<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >(new Map());
  // R3 只允许每个 stable workspace 在本次 Renderer 生命周期尝试一次；同时复用旧 ref hook slot，
  // 避免 Fast Refresh 把后续 useState 落到历史 useRef 位置。不能按 Source 去重，否则 active-first
  // 首帧只恢复一个 tab 时，会永久漏掉稍后进入 TabStore 的同 Source sibling。
  const remoteStartupReconnectRefreshCompatibilityRef = useRef<
    Set<string> | RemoteWorkspaceReconnectRendererState
  >(new Set());
  // 兼容旧形态：历史版本这个 ref 里存的是裸 Set，热更新后仍可能拿到 Set。
  // 检测到 Set 就地升级成完整结构（四个集合），保证 Fast Refresh 期间不丢失已尝试的 key。
  // 这不是抽象，而是"升级路径"，所以这里允许出现 instanceof 这种看起来别扭的写法。
  const remoteWorkspaceReconnectRendererState =
    remoteStartupReconnectRefreshCompatibilityRef.current instanceof Set
      ? {
          attemptedWorkspaceKeys: remoteStartupReconnectRefreshCompatibilityRef.current,
          currentRendererDisconnectedSourceServerIds: new Set<string>(),
          pendingTerminallyDisconnectedSourceServerIds: new Set<string>(),
          observedOnlineSourceServerIds: new Set<string>(),
        }
      : remoteStartupReconnectRefreshCompatibilityRef.current;
  // 复用历史 ref hook slot，避免新增 useRef 破坏 Fast Refresh 的 Hook 顺序；扩展出的状态
  // 只属于当前 Renderer 生命周期，不会把 failed history 持久化成自动恢复资格。
  remoteStartupReconnectRefreshCompatibilityRef.current = remoteWorkspaceReconnectRendererState;
  const {
    logsByWorkspaceKey: reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  } = useReconnectingRemoteWorkspaceLogs({
    platform,
    reconnectingWorkspaceKeys: reconnectingRemoteWorkspaceKeys,
    resolveWorkspaceTargetByKey: (workspaceKey) =>
      remoteWorkspaceSessionsRef.current.find(
        (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
      )?.target ?? null,
    resolveWorkspaceRequestIdByKey: (workspaceKey) =>
      pendingReconnectRequestIdsRef.current.get(workspaceKey) ?? null,
  });

  // "同步内存 + 有条件落盘"的唯一入口。
  // 先写 state 与 ref（本地立刻一致），再判两道门禁：
  //   supportsSettings：无设置能力的平台（浏览器预览）只保留内存态；
  //   persistenceGate.canPersist：窗口还没完成初始化时禁止写盘，避免用空列表覆盖磁盘。
  // 两份数组都做浅拷贝：调用方传进来的可能是一个会被后续就地修改的数组，
  // 直接存引用会让"已保存的快照"跟着变。
  const syncPersistedWorkspaceSession = useCallback(
    async (nextRemoteSessions: readonly RemoteWorkspaceSessionEntry[]) => {
      setRemoteWorkspaceSessions([...nextRemoteSessions]);
      remoteWorkspaceSessionsRef.current = [...nextRemoteSessions];

      if (!supportsSettings) {
        return;
      }
      if (persistenceGate && !persistenceGate.canPersist) {
        return;
      }

      // 只更新 sourceServerWorkspaceHistory 一个字段，不整体替换 settings：
      // 并发写入（例如同时改主题）时，整体替换会丢掉别人的改动。
      await services.settingService.update(
        buildRemoteWorkspacePersistPatch(tabStoreApi.getState(), nextRemoteSessions),
      );
    },
    [persistenceGate, services.settingService, supportsSettings, tabStoreApi],
  );

  // INV-16：历史变更的唯一提交入口。它把一次变更拆成三个有序步骤：
  //   1) 删除待清理凭据（门禁未开则延后登记，绝不抢先删）；
  //   2) 保存新凭据；
  //   3) 写内存 + 落盘列表。
  // 顺序的设计理由：凭据删除不可逆，必须排在"新状态已确定"之后；
  // 若先删再算列表，中途抛错会得到"凭据没了但条目还在"的坏状态。
  // 返回值是 mutation.entry，让调用方拿到"归一后的条目"（含 canonical path/identity），
  // 而不是继续用自己手里的原始入参。
  const commitRemoteWorkspaceSessionMutation = useCallback(
    async (mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>) => {
      for (const credentialKey of mutation.credentialKeysToDelete) {
        if (persistenceGate && !persistenceGate.canPersist) {
          pendingCredentialDeletesRef.current.add(credentialKey);
          continue;
        }
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] 删除远程 workspace 凭据失败", {
            credentialKey,
            error,
          });
        }
      }

      for (const credential of mutation.credentialsToSave) {
        await services.credentialService.save(credential.key, credential.value);
      }

      await syncPersistedWorkspaceSession(mutation.nextRemoteSessions);
      return mutation.entry;
    },
    [persistenceGate, services.credentialService, syncPersistedWorkspaceSession],
  );

  // 等待 renderer 侧 session 真正进入 store。
  // 为什么需要轮询：main/host 的 connectRemote 返回时只保证 Host 侧建好 session，
  // MessagePort 的注册是异步的（下一拍/下一帧）。此时若立刻 addTab，首屏会拿不到
  // remote services 而回退到本地 services，表现为"远端目录里出现本地文件"。
  // 50ms / 3s 的取值是权衡：太小会自旋浪费，太大则连接成功的首屏明显延迟；
  // 3 秒超时足以覆盖慢速 MessagePort 注册，又不会让用户以为卡死。
  const waitForRemoteWorkspaceSessionReady = useCallback(async (sessionId: string) => {
    if (getRemoteWorkspaceSession(sessionId)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const pollTimer = window.setInterval(() => {
        if (getRemoteWorkspaceSession(sessionId)) {
          window.clearInterval(pollTimer);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= 3000) {
          window.clearInterval(pollTimer);
          reject(new Error(`等待远程 workspace session 就绪超时: ${sessionId}`));
        }
      }, 50);
    });
  }, []);

  const connectRemoteWorkspaceTarget = useCallback(
    async (
      target: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
      feedback?: RemoteConnectionFeedbackOptions,
    ) => {
      // context 不为空表示"这是一次带 workspace scope 的连接"（reconnect 路径）：
      // 此时 Host 会直接把 session 绑到目标目录，不需要再走选目录流程。
      // context 为空则是"裸连接"，成功后必须把 target 暂存到 pending 表，
      // 供用户真正选目录时使用（见下面的 pendingConnectionTargetsBySessionIdRef）。
      const result = await platform.connectRemote(target, requestId, context);
      if (!result.success) {
        // 失败结果被重建成 Error 并"展开"四个结构化字段：
        //   code：上层据此分支（升级/安装/凭据缺失）；
        //   retryable：决定是否展示"重试"按钮；
        //   profileId / resolvedWslTarget：供升级确认与 WSL 精确重连使用。
        // 直接 throw result.error 会丢掉这些字段，上层只能靠 message 猜，非常脆弱。
        const error = new Error(getErrorMessage(result.error || "Connection failed")) as Error & {
          code?: string;
          retryable?: boolean;
          profileId?: string;
          resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
        };
        if (result.reasonCode) error.code = result.reasonCode;
        if (result.retryable !== undefined) error.retryable = result.retryable;
        if (result.profileId) error.profileId = result.profileId;
        if (result.resolvedWslTarget) error.resolvedWslTarget = result.resolvedWslTarget;
        throw error;
      }

      // success 但没有 sessionId 属于协议违约：继续往下会在 addTab 时写入 undefined，
      // 变成一个永远无法恢复的 tab。这里立刻失败，错误信息直指原因。
      if (!result.sessionId) {
        throw new Error("Remote session was not created");
      }

      // 远程连接成功只代表 main/host 已经建好 session，
      // renderer 侧的 MessagePort 仍然可能在下一拍才注册进 zustand store。
      // 如果此时立刻 addTab，会短暂走到本地 services，导致首屏读目录/预热 ZCode Agent 命中错误服务。
      // 这里等 session 真正挂进 store 再继续。
      await waitForRemoteWorkspaceSessionReady(result.sessionId);
      // 只有"裸连接"才登记 pending target。带 context 的连接已经在 Host 侧绑好了 scope，
      // 若也登记，会让后续选目录逻辑误以为这是一个"还没决定目录"的 session。
      // 存的是 result.reusedConnectionTarget ?? target：复用连接时真正生效的是 Host 回传的
      // 脱敏目标，而不是本地这份可能带凭据的 target。
      if (!context) {
        // 共享 Host 只向 renderer store 回传脱敏 target；完整凭据只在选目录流程完成前临时保留。
        // Host 复用时本次密码从未参与认证；选目录也只能持久化实际连接的脱敏目标。
        pendingConnectionTargetsBySessionIdRef.current.set(
          result.sessionId,
          result.reusedConnectionTarget ?? target,
        );
      }
      if (result.reusedConnectionTarget && feedback?.announceReusedConnection) {
        toast(
          intl.formatMessage(
            { id: "remote.reusedConnection" },
            { connection: formatRemoteConnectionDescription(result.reusedConnectionTarget) },
          ),
          { variant: "info", durationMs: 8000 },
        );
      }
      return result.sessionId;
    },
    [intl, platform, waitForRemoteWorkspaceSessionReady],
  );

  // realpath 归一是"路径 → identity"之前必须做的一步（INV-02 的前置）。
  // 失败时回退原路径而不是抛错：resolvePath 依赖远端连接，若此刻 session 已断，
  // 归一化失败不该阻断"取消/关闭"这类清理路径；代价是极端情况下会短暂保留别名路径，
  // 下一次成功连接时会再次归一。
  const resolveRemoteWorkspaceCanonicalPath = useCallback(
    async (sessionId: string, workspacePath: string): Promise<string> => {
      const remoteSession = getRemoteWorkspaceSession(sessionId);
      if (!remoteSession) {
        return workspacePath;
      }

      try {
        // 同一目录可能通过符号链接别名输入（例如 /dev 与 /home/dev），
        // 之前直接持久化用户输入会把同一 workspace 识别成两个身份。
        // 这里在远端 host 上做一次 realpath 归一化，再参与 identity 计算与持久化。
        return await remoteSession.services.fileService.resolvePath({
          path: workspacePath,
        });
      } catch {
        return workspacePath;
      }
    },
    [],
  );

  // 持久化补丁：把"当前 tabs 中的远端 workspace"投影成 settings 片段。
  // 读的是 ref 而不是 state：这个函数会被 TabStore 的持久化中间件在任意时刻调用，
  // 那时 React 闭包里的 remoteWorkspaceSessions 可能落后一帧，会写出旧列表。
  // 依赖数组为空（稳定引用）：它只依赖 ref 与服务函数，不需要随渲染重建，
  // 否则每次历史变化都会让 TabStore 重新注册补丁生成器。
  const buildPersistedTabPatch = useCallback(
    (state: TabStoreState) =>
      buildRemoteWorkspacePersistPatch(state, remoteWorkspaceSessionsRef.current),
    [],
  );

  // 取消"选目录"：释放 session，并在 finally 里无条件清本地映射。
  // try/finally 而不是 try/catch：dispose 失败没有可采取的动作（远端会自然超时），
  // 但本地映射必须清——否则下次打开向导会复用一条已失效的 session 记录，
  // 表现为"一打开就报 session not found"。
  // 这里不 rethrow：调用方（向导的取消按钮）不需要感知 dispose 失败。
  const handleCancelRemoteProject = useCallback(
    async (sessionId: string) => {
      try {
        await platform.disposeRemoteSession(sessionId);
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
        // 远程目录选择如果在确认前就取消，session 释放失败也不能把前端状态卡在“仍有一个待选远程 session”。
        // 这里始终清掉本地映射，避免下次再次打开弹窗时复用到一条已经失效的 session 记录。
        unregisterRemoteWorkspaceSession(sessionId);
      }
    },
    [platform],
  );

  // 绑定 workspace scope 并归一化返回值。三件事在这里完成：
  //   1) 调 Host bind（会换代 attachment，因此不能复用旧 session 对象）；
  //   2) 用 Host 返回的 workspacePath/workspaceIdentity 覆盖用户输入（canonical 优先）；
  //   3) previousWorkspaceIdentity 只在 Desktop 透传，供 TabStore 原地 rekey（见 INV-02 注释）。
  // 失败必须回收 session：半绑定的 session 既不属于用户选中目录、也不属于任何 tab，
  // 继续 open tab 会让 Renderer 与 Host 的 scope 判定分裂。
  const bindRemoteWorkspaceScope = useCallback(
    async (
      sessionId: string,
      workspacePath: string,
      workspaceIdentity?: string,
      workspacePurpose?: "project" | "conversation",
    ) => {
      try {
        const remoteSession = await bindRemoteWorkspaceContextAndGetSession({
          platform,
          sessionId,
          workspacePath,
          workspaceIdentity,
          workspacePurpose,
        });
        // 以 Host 返回值为准：用户输入的可能是符号链接或大小写不同的路径，
        // 只有 Host 的 realpath 结果才是后续 identity 计算与持久化的唯一基准。
        const boundWorkspacePath = remoteSession.workspacePath ?? workspacePath;
        const boundWorkspaceIdentity = remoteSession.workspaceIdentity;
        // identity 为空是不可接受的：没有它，下次启动无法把条目匹配回这台设备，
        // 用户会看到条目存在但永远恢复不了。直接在 bind 阶段失败比留下坏条目好。
        if (!boundWorkspaceIdentity) {
          throw new Error(`远程 workspace bind 缺少 stable identity: ${sessionId}`);
        }
        return {
          workspacePath: boundWorkspacePath,
          workspaceIdentity: boundWorkspaceIdentity,
          ...(remoteSession.workspacePurpose
            ? { workspacePurpose: remoteSession.workspacePurpose }
            : workspacePurpose
              ? { workspacePurpose }
              : {}),
          ...(isDesktop && remoteSession.previousWorkspaceIdentity
            ? {
                previousWorkspaceIdentity: remoteSession.previousWorkspaceIdentity,
              }
            : {}),
        };
      } catch (error) {
        // Bug 原因：Host bind 失败意味着 attachment 没有换代、也拿不到 remote:server:* 权威 identity，
        // 继续打开 tab 会让 Renderer 用半绑定的 session 与 Host 的 workspace scope 分裂。
        // 这里失败即回收 session，确保“打开 remote tab = Host 已完成 workspace bind”。
        await handleCancelRemoteProject(sessionId);
        throw error;
      }
    },
    [handleCancelRemoteProject, isDesktop, platform],
  );

  const runReconnectRemoteWorkspaceEntry = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ): Promise<boolean> => {
      // 这一层是"侧栏/菜单重连"的入口，比 RemoteWorkspaceKey 封装更底层：
      // 它自己维护 inflight 与 requestId（而不是依赖调用方），因为可能被非 UI 路径调用。
      // 三个 early return 都是"静默失败"：
      //   已在重连中 / tab 不存在 / tab 已有 session。它们不是异常，重连没有必要发生。
      const workspaceKey = buildWorkspaceSessionKey(sessionEntry);
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) {
        return false;
      }
      const workspaceTab = tabStoreApi
        .getState()
        .tabs.find(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
        );
      // 注意这里读的是 getState() 快照而不是渲染闭包：这个函数可能在很久之后
      // 才被调用（例如重连组的 sibling），闭包里的 tabs 早已过期（INV-21）。
      if (!workspaceTab || workspaceTab.remoteSessionId) {
        return false;
      }

      resetLogsForWorkspaceKey(workspaceKey);
      inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
      const requestId = createUuid();
      const recoveryMode = options?.recoveryMode ?? "manual";
      pendingReconnectRequestIdsRef.current.set(workspaceKey, requestId);
      // 记录"本次恢复的模式"（manual / startup / group-sibling）：
      // finally 里用它判断"要不要清理这条记录"——如果期间已被另一次恢复覆盖，
      // 直接 delete 会把新记录一起删掉（用 mode 相等做守卫，见 finally）。
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => ({
        ...current,
        [workspaceKey]: { mode: recoveryMode },
      }));
      // 连接事实投影（overlay）同步切到 reconnecting：侧栏据此显示"恢复中"而不是"已断开"。
      setRemoteWorkspaceConnectionState(workspaceKey, "reconnecting");
      let reconnected = false;
      try {
        // 重连期间只静默回填 ready 的 remoteSessionId；激活统一由 reconnect helper
        // 在回填之后执行，避免 active tab 暴露 remote-waiting 中间态。
        const upsertWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
        logger.debug("[Root] 远程 workspace 重连中，保留当前 conversation", {
          workspaceKey,
        });
        await reconnectRemoteWorkspaceHistoryEntry({
          sessionEntry,
          activateTabByPath,
          setReconnectingRemoteWorkspaceKeys,
          loadCredential: services.credentialService.load,
          getSettings: services.settingService.get,
          connectRemoteWorkspaceTarget,
          resolveRemoteWorkspaceCanonicalPath,
          bindRemoteWorkspaceScope,
          disposeRemoteWorkspaceSession: handleCancelRemoteProject,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          upsertWorkspaceTab,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          logger,
          toast,
          shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
            shouldKeepRemoteWorkspaceInTabs({
              tabStoreApi,
              workspacePath,
              workspaceIdentity,
            }),
          onWorkspaceActivated: (target) => {
            logger.debug("[Root] 远程 workspace ready，提交 tab 与 draft 激活", target);
            onWorkspaceActivated?.(target);
          },
          formatError: (error) => {
            const normalized = error as Error & {
              code?: string;
              retryable?: boolean;
              recoveryAttempt?: number;
              recoveryLimit?: number;
            };
            return formatRemoteConnectionError({
              fallback: getErrorMessage(error),
              reasonCode: normalized.code,
              retryable: normalized.retryable,
              recoveryAttempt: normalized.recoveryAttempt,
              recoveryLimit: normalized.recoveryLimit,
              formatMessage: intl.formatMessage,
            });
          },
          options: {
            ...options,
            requestId,
          },
        });
        // 成功才清 overlay：失败时 overlay 必须变成 disconnected 而不是"消失"，
        // 否则列表会回退到"看起来正常"的状态，用户不知道这次恢复失败了。
        reconnected = true;
        clearRemoteWorkspaceConnectionState(workspaceKey);
        return true;
      } finally {
        if (!reconnected) {
          setRemoteWorkspaceConnectionState(workspaceKey, "disconnected");
        }
        inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        if (pendingReconnectRequestIdsRef.current.get(workspaceKey) === requestId) {
          pendingReconnectRequestIdsRef.current.delete(workspaceKey);
        }
        setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
          if (current[workspaceKey]?.mode !== recoveryMode) return current;
          const next = { ...current };
          delete next[workspaceKey];
          return next;
        });
      }
    },
    [
      activateTabByPath,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      services.credentialService,
      services.settingService,
      bindRemoteWorkspaceScope,
      tabStoreApi,
      intl,
    ],
  );

  // 对外的"重连这条 workspace"：先算 SSH 同主机组，再交给组执行器。
  // 为什么分组放在这里而不是组执行器内部：组的输入需要"当前 tabs"，
  // 而 tabs 必须在调用时刻取快照（INV-21）；放进执行器会拿到它自己闭包里的旧 tabs。
  // 单条重连也会走到这里，此时组大小为 1，逻辑不变。
  const runReconnectRemoteWorkspace = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ) => {
      const reconnectGroup = collectSshReconnectGroup({
        selected: sessionEntry,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
      });
      await reconnectRemoteWorkspaceGroup({
        selected: sessionEntry,
        reconnectGroup,
        reconnectEntry: runReconnectRemoteWorkspaceEntry,
        options,
      });
    },
    [runReconnectRemoteWorkspaceEntry, tabStoreApi],
  );

  // 启动自动恢复的总 effect。三件事同时在这里发生：
  //   1) 订阅 Source 状态，聚合出"哪些设备 online"；
  //   2) 处理 identity 迁移（legacy → stable），保证恢复判定不会因为旧 identity 落空；
  //   3) 在合适的时机（online / 新增 tab / Directory 变更）重算一次恢复候选。
  // 它依赖 remoteWorkspaceSessions（数组引用）是有意的：历史列表变化代表"可能出现
  // 新的可恢复条目"，需要重新评估；用 ref 会导致这个 effect 永远不重跑。
  // disposed 是唯一的结果丢弃开关：cleanup 之后任何回调都不许再 setState（INV-20）。
  useEffect(() => {
    const sourceManagement = services.sourceServerManagementService;
    if (!canUseRemoteWorkspace || remoteWorkspaceSessions.length === 0 || !sourceManagement) {
      return;
    }
    let disposed = false;
    let observedManagementGeneration = 0;
    const sourceStateByProfileId = new Map<
      string,
      Awaited<ReturnType<typeof sourceManagement.getSnapshot>>["states"][number]
    >();
    const collectOnlineSourceServerIds = () =>
      new Set(
        [...sourceStateByProfileId.values()].flatMap((state) =>
          state.state === "online" && state.sourceServerId ? [state.sourceServerId] : [],
        ),
      );
    // 每次拿到新的 Source 状态后更新"本 Renderer 观察到的可用性"，并结算"待定断开"。
    // 为什么要有 pendingTerminallyDisconnected 这层缓冲：
    // 主动断开时，Source 会先发一个中间态（retrying/offline），再被判定为终止性断开；
    // 若第一时间就认定"掉了"，正在进行的自动恢复会被误判成"设备已死"而放弃。
    // 只有到下一次快照里它仍然不在 online，才把"待定"落实为"确实断开"，
    // 从而允许该设备的 workspace 在设备回来后重试。
    const updateObservedSourceAvailability = () => {
      const onlineSourceServerIds = collectOnlineSourceServerIds();
      const reconnectState = remoteWorkspaceReconnectRendererState;
      reconnectState.observedOnlineSourceServerIds = onlineSourceServerIds;
      for (const sourceServerId of reconnectState.pendingTerminallyDisconnectedSourceServerIds) {
        if (onlineSourceServerIds.has(sourceServerId)) continue;
        reconnectState.pendingTerminallyDisconnectedSourceServerIds.delete(sourceServerId);
        reconnectState.currentRendererDisconnectedSourceServerIds.add(sourceServerId);
      }
    };
    const applyDirectoryWorkspaceIdentityProjection = (settings: {
      sourceServerWorkspaceHistory: SourceServerManagementSnapshot["workspaceHistory"];
      connectionProfiles: SourceServerManagementSnapshot["profiles"];
      remoteConversationWorkspaceBySourceServerId?: AppSettings["remoteConversationWorkspaceBySourceServerId"];
    }) => {
      // 投影只做"legacy identity → stable identity"的原地改写，不新增/删除条目。
      // 没有 rekey 时立刻返回，避免后面无意义的 setState（每次快照都会调用本函数）。
      const projection = projectRemoteWorkspaceSessionIdentityAliases(
        remoteWorkspaceSessionsRef.current,
        settings,
      );
      if (projection.identityRekeys.length === 0) return;

      // Bug 根因：同一 Renderer 生命周期内完成首次识别/版本升级后，Directory 已把
      // history 改成 stable identity，但内存 session/tab 仍停在 legacy route identity。
      // online 恢复门禁因此无法归属 Source，必须在重连判定前先原地重投影控制端状态。
      remoteWorkspaceSessionsRef.current = projection.remoteSessions;
      setRemoteWorkspaceSessions(projection.remoteSessions);
      const ensureWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
      for (const rekey of projection.identityRekeys) {
        const matchingTab = tabStoreApi
          .getState()
          .tabs.find(
            (tab) =>
              isWorkspaceTab(tab) &&
              tab.workspacePath === rekey.workspacePath &&
              tab.workspaceIdentity === rekey.previousWorkspaceIdentity,
          );
        if (!matchingTab) continue;
        // Bug 原因：首次识别时 project/conversation attachment 可能已经 ready；过去只
        // rekey 断连 tab，live tab 继续持有 legacy identity，随后 canonical purpose
        // 自愈按 stable workspaceKey 精确匹配时必然漏掉它。原地 rekey 会保留 remoteSessionId。
        ensureWorkspaceTab(rekey.workspacePath, {
          previousWorkspaceIdentity: rekey.previousWorkspaceIdentity,
          workspaceIdentity: rekey.workspaceIdentity,
        });
      }
    };
    // 计算并启动这一轮恢复。两个"副作用先于 IO"的细节：
    //   1) 先把本批 key 写进 attemptedWorkspaceKeys，再发起连接：否则同一批里
    //      某条成功触发的 tab 变化会让 attemptReconnect 重入并把同批再算一次；
    //   2) 先把设备从"当前 Renderer 已断开"集合移除，再恢复：否则恢复过程中
    //      再算候选时它仍被当成断线设备，产生重复组。
    // 并发模型：设备之间并发（不同 Source 物理连接互不影响），
    // 同设备内串行（restoreSourceRemoteWorkspaceGroup 逐个挂 attachment）。
    const attemptReconnect = () => {
      const attemptedWorkspaceKeys = remoteWorkspaceReconnectRendererState.attemptedWorkspaceKeys;
      const groups = collectStartupRemoteWorkspaceReconnectGroups({
        manuallyOpeningWorkspaceTabId: manuallyOpeningWorkspaceTabIdRef.current,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
        attemptedWorkspaceKeys,
        onlineSourceServerIds: collectOnlineSourceServerIds(),
        currentRendererDisconnectedSourceServerIds:
          remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds,
        pendingTerminallyDisconnectedSourceServerIds:
          remoteWorkspaceReconnectRendererState.pendingTerminallyDisconnectedSourceServerIds,
      });
      if (groups.length === 0) return;
      for (const group of groups) {
        remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds.delete(
          group.sourceServerId,
        );
        for (const entry of group.entries) {
          attemptedWorkspaceKeys.add(buildWorkspaceSessionKey(entry));
        }
      }

      // Bug 原因：R3 Host 冷启动只恢复 physical Source，Renderer 仍沿用 R1 的“全部断连占位”
      // 旧语义，导致 online Source 下 A/B 永远没有新 remoteSessionId。按 Source 并发、组内串行恢复
      // logical attachments；physical Source 已 online，不再让某个 workspace 充当 Host gate。
      void Promise.all(
        groups.map(async (group) => {
          const groupWorkspaceKeys = new Set(
            group.entries.map((entry) => buildWorkspaceSessionKey(entry)),
          );
          await restoreSourceRemoteWorkspaceGroup({
            entries: remoteWorkspaceSessionsRef.current.filter((entry) =>
              groupWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
            ),
            reconnectEntry: runReconnectRemoteWorkspaceEntry,
            options: {
              activateWorkspaceAfterReconnect: false,
              showErrorToast: false,
              recoveryMode: "automatic",
            },
          });
        }),
      );
    };

    // 快照刷新的合并器（coalescing）：
    //   refreshInFlight：当前这一次读取（同一时刻只允许一个 getSnapshot）；
    //   refreshQueued：期间又来了请求，完成后必须再跑一次（否则会漏掉最新状态）；
    //   refreshQueuedReconnect：排队期间是否有任何一次要求"顺带重连"——用 ||= 合并，
    //     保证不会因为后到的一次是 false 而丢掉前一次的重连请求。
    // 比节流更精确：`refreshQueued` 不丢请求，只合并已经在路上的那一段。
    let refreshInFlight: Promise<void> | null = null;
    let refreshQueued = false;
    let refreshQueuedReconnect = false;
    const refreshSnapshot = (shouldAttemptReconnect: boolean) => {
      if (refreshInFlight) {
        refreshQueued = true;
        refreshQueuedReconnect ||= shouldAttemptReconnect;
        return;
      }
      refreshInFlight = sourceManagement
        .getSnapshot()
        .then(async (snapshot) => {
          // generation 单调递增，旧快照必须丢弃：并发 fetch 时它们的完成顺序不保证，
          // 用 generation 比"到达时间"更可靠（后者会被调度抖动影响）。
          if (disposed || snapshot.generation < observedManagementGeneration) return;
          observedManagementGeneration = snapshot.generation;
          let settings: Pick<AppSettings, "remoteConversationWorkspaceBySourceServerId"> = {};
          try {
            settings = await services.settingService.get();
          } catch (error) {
            // alias 读取失败不能阻断 Source 状态刷新；没有 map 时继续保持原有 fail-closed 行为。
            logger.warn("[Root] 读取 conversation workspace alias 失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          // 读取设置期间向导意图可能变化；已清理的订阅不能继续提交旧投影/恢复候选。
          if (disposed) return;
          applyDirectoryWorkspaceIdentityProjection({
            sourceServerWorkspaceHistory: snapshot.workspaceHistory,
            connectionProfiles: snapshot.profiles,
            remoteConversationWorkspaceBySourceServerId:
              settings.remoteConversationWorkspaceBySourceServerId,
          });
          // 用 clear + 全量重建而不是增量 merge：快照是权威全量，
          // 增量更新会留下"已经删除的 profile"的残影，导致 collectOnlineSourceServerIds
          // 继续把一台不存在的设备算作 online。
          sourceStateByProfileId.clear();
          for (const state of snapshot.states) sourceStateByProfileId.set(state.profileId, state);
          updateObservedSourceAvailability();
          // 只有调用方明确要求时才重连：Directory 变更引起的刷新必须传 false，
          // 否则"重命名设备/删除线路"会被当成连接信号触发一轮恢复（见下方订阅注释）。
          if (shouldAttemptReconnect) attemptReconnect();
        })
        .catch((error) => {
          if (!disposed) {
            logger.warn("[Root] 读取 Source 启动恢复状态失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          // 先释放 in-flight 再处理排队：反过来的话，递归调用 refreshSnapshot 会看到
          // inFlight 仍非空，直接把新请求塞回队列，形成"永远在排队"的活锁。
          refreshInFlight = null;
          if (!disposed && refreshQueued) {
            const queuedReconnect = refreshQueuedReconnect;
            refreshQueued = false;
            refreshQueuedReconnect = false;
            refreshSnapshot(queuedReconnect);
          }
        });
    };

    // Bug 原因：Renderer 过去在 Host 的 10 秒 startup flight 仍进行时就主动 connectProfile，
    // 既把“Host 只试一次”扩成第二条恢复入口，也会 join 同一超时 flight 后制造迟到连接。
    // logical workspace 只消费 Host 权威 online 状态；failed/offline 保持手动入口。
    // 单台设备的状态增量订阅。它只做三件轻量事：
    //   1) 按 generation 丢弃旧事件（乱序保护）；
    //   2) 更新本地状态表 + 观察集合；
    //   3) 仅当状态变成 online 时才尝试恢复（INV-10），并结算 attempted 标记。
    // 刻意不在这里调用 getSnapshot：高频道事件下每次都全量拉取会打爆主进程。
    const managementSubscription = sourceManagement.onDidChangeState((delta) => {
      if (disposed || delta.generation < observedManagementGeneration) return;
      observedManagementGeneration = delta.generation;
      sourceStateByProfileId.set(delta.state.profileId, delta.state);
      updateObservedSourceAvailability();
      // Bug 根因：主动断开会先发布 retrying/offline；这些状态不是启动恢复信号，
      // 只有 Source 真正进入 online 才允许重算历史 workspace 候选。
      if (shouldAttemptStartupReconnectForSourceState(delta.state.state)) {
        attemptReconnect();
      }
      updateStartupRemoteWorkspaceReconnectAttemptsForSourceState({
        state: delta.state,
        onlineSourceServerIds: collectOnlineSourceServerIds(),
        sessions: remoteWorkspaceSessionsRef.current,
        attemptedWorkspaceKeys: remoteWorkspaceReconnectRendererState.attemptedWorkspaceKeys,
      });
    });
    const directorySubscription = sourceManagement.onDidChangeDirectory?.(() => {
      // Directory 变更只刷新权威投影，不触发自动重连；重命名/删线路/打开项目不能被误判为连接信号。
      refreshSnapshot(false);
    });
    refreshSnapshot(true);
    // Desktop active-first 会在首帧后才补齐 inactive tabs；订阅 tabs 才能在 A/B 真正进入
    // TabStore 后重新计算一次候选。attempted workspace set 阻止其它 tab 变化重复连接已处理项，
    // 同时允许迟到的同 Source sibling 补上 logical session。
    const tabSubscription = tabStoreApi.subscribe((state, previousState) => {
      // Bug 根因：主动断开先清除已有 tab 的 remoteSessionId，再异步发布 Source offline；
      // 任意 tab 变化都会在这段窗口内误触发 startup reconnect。只对 active-first 新增的
      // 断连 tab 重算候选，已有 tab 的 live -> disconnected 变化保持手动重连语义。
      if (shouldAttemptStartupReconnectForTabChange(state.tabs, previousState.tabs)) {
        attemptReconnect();
      }
    });
    return () => {
      disposed = true;
      managementSubscription.dispose();
      directorySubscription?.dispose();
      tabSubscription();
    };
  }, [
    canUseRemoteWorkspace,
    manuallyOpeningWorkspaceTabId,
    remoteWorkspaceSessions,
    runReconnectRemoteWorkspaceEntry,
    services.settingService,
    services.sourceServerManagementService,
    syncPersistedWorkspaceSession,
    tabStoreApi,
  ]);

  // 启动恢复的入口：从 settings 读历史，先建立"断连态"的 tab，再做（可选的）阶段二。
  // 做的第一件事是把历史写进 state 与 ref（不落盘），保证后续任何 UI 订阅
  // （侧栏/列表）都能立刻看到条目；这也是"内存为真相、落盘为副本"的体现。
  // ensureConversationWorkspaceOnRestore 只在需要时创建对话根目录：
  // 失败仅 warn，因为一个目录创建失败不应阻断真实项目的恢复（INV-14 的降级版）。
  const restorePersistedSession = useCallback(
    async (settings: AppSettings) => {
      // 先落 state 再落 ref，且两者写同一份数组引用：如果只写 state，后续 await
      // 期间的回调读到的是旧 ref（INV-21 的镜像问题）；如果只写 ref，UI 不刷新。
      // 这里没有竞态风险：恢复是串行的，且 setState 与 ref 赋值之间没有 await。
      const persistedRemoteSessions = getRemoteWorkspaceSessionEntries(settings);
      setRemoteWorkspaceSessions(persistedRemoteSessions);
      remoteWorkspaceSessionsRef.current = persistedRemoteSessions;
      let conversationWorkspacePath: string | undefined;
      if (ensureConversationWorkspaceOnRestore) {
        try {
          conversationWorkspacePath = (await services.fileService.ensureConversationWorkspace())
            .path;
        } catch (error) {
          // 路径创建失败不能连带吞掉真实项目恢复；后续显式新建对话仍会走原有可重试错误入口。
          logger.warn("[Root] 恢复阶段解析 conversation workspace 失败", {
            error,
          });
        }
      }
      // 两阶段恢复（这是本文件的核心设计之一）：
      //   阶段一（这里）：同步把历史条目恢复成"断连 tab"，不建任何远端连接。
      //     好处是首屏立刻有完整侧栏（`workspaceHistory` 直出）：用户点哪条才连哪条，不必等网络。
      //   阶段二（上方 effect）：只对"近 7 天 + Source 已 online + stable identity"的条目
      //     自动挂 attachment。legacy identity / 过期条目保持手动入口，避免启动时
      //     一口气建立几十个连接。
      // deferInactiveWorkspaceRestore（active-first）把非活动 tab 的恢复推迟到首帧之后，
      // 因为 Desktop 首帧前拿不到完整 tabs，同步恢复会与 TabStore 的补齐竞争。
      // R3 先把历史恢复为断连 tab；上方自动恢复 effect 只消费近 7 天、Source 已 online 的
      // remote:server stable history。legacy/过期历史仍保持手动入口，Web 普通模式则
      // 继续把 allowRemoteWorkspaceRestore 置为 false，不恢复 tab 或创建远端 runtime。
      const workspaceRestore = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        allowRemoteWorkspaceRestore,
        unavailableWorkspacePath,
        conversationWorkspacePath,
        remoteConversationWorkspaceBySourceServerId:
          settings.remoteConversationWorkspaceBySourceServerId,
        restoreMode: deferInactiveWorkspaceRestore ? "active-first" : "all",
      });
      // 返回值是"恢复的副作用出口"，不是恢复结果本身：
      //   excludedRecentProjectPaths：对话根目录要从"最近项目"里排除，否则它会以
      //     项目身份出现在列表里，用户点进去得到一条错误用途的会话；
      //   deferredRestore：非活动 tab 的恢复被推迟，必须把句柄交还给调用方，
      //     否则这部分 tab 永远不会被补齐（首屏只恢复 active 的代价）。
      return {
        ...(conversationWorkspacePath
          ? { excludedRecentProjectPaths: [conversationWorkspacePath] }
          : {}),
        ...(workspaceRestore?.deferredRestore
          ? { deferredRestore: workspaceRestore.deferredRestore }
          : {}),
      };
    },
    [
      allowRemoteWorkspaceRestore,
      deferInactiveWorkspaceRestore,
      ensureConversationWorkspaceOnRestore,
      services.fileService,
      tabStoreApi,
      unavailableWorkspacePath,
    ],
  );

  // 向导"确认目录"的桥接：把 Root 侧的最新能力（tabs 快照、canonical 归一、bind、
  // 提交历史、addTab、draft owner）全部注入纯函数 selectRemoteWorkspaceProjectFromDialog。
  // 为什么不在纯函数里直接 import store：选目录需要在多个 await 之间读"最新"的 tabs
  // 与历史，而 store 的 getState 只有 Root 这层能保证与服务实例同版本（多窗口/预览模式）。
  // onWorkspaceActivated 的默认实现用于"草稿项目"：没有外部 owner 时由这里启动 draft，
  // 保证 draftProjectId 能同步到内存与持久化范围（INV-18 的配套）。
  const selectRemoteProjectFromDialog = useCallback(
    async (
      sessionId: string,
      path: string,
      localWorkspacePath?: string,
      workspacePurpose: "project" | "conversation" = "project",
      draftProjectId?: string | null,
      preparedWorkspaceIdentity?: string,
      isCurrent?: () => boolean | Promise<boolean>,
    ) => {
      try {
        // 这里把所有依赖都显式传下去（而不是让被调函数自己 import/读 store）：
        // 选目录流程需要 guest 侧的"当前 tabs / 当前历史 / 当前向导 tab"，
        // 而这些只能在 Root 这一层取到最新快照（INV-21）。
        // connectionTarget 从 pending 表取：裸连接时暂存的 target 只在这里被消费。
        await selectRemoteWorkspaceProjectFromDialog({
          canUseRemoteWorkspace,
          isCurrent,
          sessionId,
          path,
          preparedWorkspaceIdentity,
          draftProjectId,
          localWorkspacePath,
          workspacePurpose,
          loadingMessage: intl.formatMessage({ id: "common.loading" }),
          getRemoteWorkspaceSession,
          connectionTarget: pendingConnectionTargetsBySessionIdRef.current.get(sessionId),
          getWorkspaceTabs: () => tabStoreApi.getState().tabs,
          restoringWorkspaceTabId: manuallyOpeningWorkspaceTabIdRef.current,
          resolveRemoteWorkspaceCanonicalPath,
          activateTabByPath,
          handleCancelRemoteProject,
          bindRemoteWorkspaceScope,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          addTab,
          // 原项目 ID 必须到达 Root 的草稿 owner，由它同步内存与持久化范围。
          onWorkspaceActivated:
            onWorkspaceActivated ??
            (draftProjectId === undefined
              ? undefined
              : ({ workspacePath, workspaceIdentity }) => {
                  useZCodeSessionStore
                    .getState()
                    .startDraft(workspacePath, undefined, workspaceIdentity, {
                      projectId: draftProjectId,
                    });
                }),
        });
      } finally {
        // 无论成功、失败还是取消都删：pending target 是一次性的"连接凭据"，
        // 留在表里等于让一个已使用的 target 可以被第二次消费（可能连到错误的机器）。
        // 放在 finally 而不是成功分支，是为了失败重试时也能走完整的"重新连接"流程。
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
      }
    },
    [
      activateTabByPath,
      addTab,
      tabStoreApi,
      commitRemoteWorkspaceSessionMutation,
      handleCancelRemoteProject,
      intl,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      canUseRemoteWorkspace,
    ],
  );

  // 打开对话 workspace：与"打开项目"共用选目录流程，但用途固定为 conversation，
  // 且目录由 Source 的 ensureConversationWorkspace 决定（用户不需要选）。
  // 依赖数组里用服务对象而不是 RPC getter：getter 每次返回新函数，
  // 直接依赖会让这条链路在每次 Root 渲染时重建（并向下传播不必要的更新）。
  const openRemoteConversation = useCallback(
    async (sessionId: string, sourceServerId?: string) =>
      await openRemoteConversationWorkspace({
        sessionId,
        sourceServerId,
        getRemoteWorkspaceSession,
        getSettings: services.settingService.get,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        waitForRemoteWorkspaceSessionReady,
        ensureConversationWorkspace: async (resolvedSourceServerId) => {
          const management = services.sourceServerManagementService;
          if (!management) {
            throw new Error("Remote conversation requires an identified Source Server");
          }
          return management.ensureConversationWorkspace(resolvedSourceServerId);
        },
        selectRemoteWorkspace: async (conversationSessionId, conversationPath, workspacePurpose) =>
          await selectRemoteProjectFromDialog(
            conversationSessionId,
            conversationPath,
            undefined,
            workspacePurpose,
          ),
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
      }),
    [
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      selectRemoteProjectFromDialog,
      // RPC getter 每次返回新函数；依赖服务身份，避免普通 Root 更新重建整条导航链。
      services.credentialService,
      services.settingService,
      services.sourceServerManagementService,
      waitForRemoteWorkspaceSessionReady,
    ],
  );
  // 对外暴露的"裸连接"（向导底层的 connectRemote）。这里只做能力门禁，
  // 不做任何重试/降级：重试策略属于调用方（向导），混进来会让"用户点重试"
  // 与"内部自动重试"叠加，产生成倍请求。
  const handleConnectRemote = useCallback(
    async (
      options: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
      feedback?: RemoteConnectionFeedbackOptions,
    ) => {
      if (!canUseRemoteWorkspace) {
        throw new Error("Remote workspace is disabled in this mode");
      }

      return connectRemoteWorkspaceTarget(options, requestId, context, feedback);
    },
    [canUseRemoteWorkspace, connectRemoteWorkspaceTarget],
  );

  // 按 key 重连的"策略层"（真正实现委托给 runReconnectRemoteWorkspace）。
  // 两条通道：
  //   A. 无向导（手机/自动恢复/要求抛错）→ 直接重连，返回 boolean；
  //   B. 有向导（桌面用户点击）→ 优先打开向导让用户确认/补凭据，
  //      并在 tab/entry 已不存在时走 remoteProjectService 的兜底路径。
  // 合并 options（{...options, ...nextOptions}）而不是替换：调用方可能只补一个字段，
  // 覆盖式替换会把 recoveryMode 之类丢失，导致"手动重连被当成自动恢复"。
  const runReconnectRemoteWorkspaceByKey = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      const reconnect = async (nextOptions?: ReconnectRemoteWorkspaceOptions) => {
        await reconnectRemoteWorkspaceByKey({
          workspaceKey,
          canUseRemoteWorkspace,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          runReconnectRemoteWorkspace,
          options: { ...options, ...nextOptions },
        });
      };
      // 手机 RPC/自动恢复沿用既有返回与错误语义，不打开桌面向导。
      // 三种情况：
      //   throwOnFailure：调用方要求"失败必须抛"，向导会吞掉错误（走 UI 展示），语义不符；
      //   automatic：自动恢复不能弹窗打断用户，静默失败即可；
      //   !onOpenRemoteConnection：当前环境没有向导（手机/Web），只能直接连。
      // 这三条都走同一条"直连"路径，保证返回 boolean 与抛错行为一致。
      if (
        options?.throwOnFailure ||
        options?.recoveryMode === "automatic" ||
        !onOpenRemoteConnection
      ) {
        await reconnect(options);
        return;
      }
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) return;
      const tab = tabStoreApi
        .getState()
        .tabs.find(
          (candidate) =>
            isWorkspaceTab(candidate) && buildWorkspaceSessionKey(candidate) === workspaceKey,
        );
      const entry = remoteWorkspaceSessionsRef.current.find(
        (candidate) => buildWorkspaceSessionKey(candidate) === workspaceKey,
      );
      if (!tab || !isWorkspaceTab(tab) || !entry) {
        if (!services.remoteProjectService) throw new Error("remote-project.service-unavailable");
        inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
        try {
          await requestRetainedRemoteProjectConnection({
            workspaceKey,
            service: services.remoteProjectService,
            getSnapshot: services.sourceServerManagementService
              ? () => services.sourceServerManagementService!.getSnapshot()
              : undefined,
            openWizard: onOpenRemoteConnection,
          });
        } finally {
          inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        }
        return;
      }
      // snapshot 只为"给向导提供设备展示信息（名称/错误码/线路）"，读失败不影响重连：
      // 向导会退化成只显示路径的最小信息，用户仍可继续。
      // 用可选链 + catch 而不是 try/catch 包住整段：这里没有"失败分支要做的事"。
      const snapshot = await services.sourceServerManagementService
        ?.getSnapshot()
        .catch(() => undefined);
      // isCurrent 绑定的是 tab.id 而不是 key：用户可能删掉这个 tab 又新建了一个同路径的，
      // 那种情况下"旧 tab 还在吗"才是正确的问题（新 tab 有自己的连接流程）。
      const isCurrent = () =>
        tabStoreApi.getState().tabs.some((candidate) => candidate.id === tab.id);
      if (!isCurrent()) return;
      const sourceId = getWorkspaceSourceServerId(tab, {
        workspaceHistory: snapshot?.workspaceHistory,
      });
      const device = sourceId ? getRemoteDevicePresentationInput(snapshot, sourceId) : undefined;
      const profile = snapshot?.profiles.find(
        (candidate) => candidate.profileId === device?.profileId,
      );
      const presentation = resolveRemoteConnectionPresentation({
        ...device,
        attached: false,
        projectError: entry.lastConnectionError,
      });
      await requestRemoteProjectConnection({
        // 偏好顺序体现"哪个来源最可信"：
        //   profile（当前线路）优先：线路可能已改过 host/凭据，比 tab 里的旧 target 新；
        //   没有 profile 时才回退 tab.remoteTarget（可能是历史快照）。
        // workspaceTabId 传下去是为了让向导在成功后复用这个 tab，而不是新开一个。
        preference: {
          preferredWorkspaceTabId: tab.id,
          preferredDirectoryPath: entry.workspacePath,
          preferredProfileId: profile?.profileId,
          preferredTarget: profile ? buildRemoteTargetFromProfile(profile) : tab.remoteTarget,
        },
        presentation,
        failure: {
          code: device?.errorCode,
          message: device?.error ?? entry.lastConnectionError ?? "",
          logs: reconnectingRemoteWorkspaceLogsByWorkspaceKey[workspaceKey] ?? [],
        },
        reconnect,
        openWizard: onOpenRemoteConnection,
        isCurrent,
      });
    },
    [
      canUseRemoteWorkspace,
      runReconnectRemoteWorkspace,
      onOpenRemoteConnection,
      tabStoreApi,
      services.sourceServerManagementService,
      services.remoteProjectService,
      reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    ],
  );

  // 供侧栏/菜单直接调用的"从历史打开"包装：只补上本 hook 的运行时能力
  // （tabs、历史快照、reconnect 实现、日志/状态写回），其余判定保持在纯函数里。
  // 依赖数组里刻意包含 services.*（稳定对象）而不是它们的 getter，
  // 避免每次渲染都重建回调并让侧栏列表整体重渲染。
  const handleOpenRemoteWorkspaceFromHistory = useCallback(
    async (workspaceKey: string) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      // 远程历史入口与侧栏重连都可能命中“重连中被用户移除”的竞态。
      // 这里抽成统一入口，确保两条路径共享相同的并发保护、保留校验与错误处理语义。
      await openRemoteWorkspaceFromHistoryEntry({
        workspaceKey,
        tabStoreApi,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        inflightReconnectWorkspaceKeys: inflightReconnectWorkspaceKeysRef.current,
        activateTabByPath,
        setReconnectingRemoteWorkspaceKeys,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        resolveRemoteWorkspaceCanonicalPath,
        bindRemoteWorkspaceScope,
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
        addTab,
        commitRemoteWorkspaceSessionMutation,
        createReconnectRequestId: createUuid,
        pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
        resetLogsForWorkspaceKey,
        onWorkspaceActivated,
      });
    },
    [
      activateTabByPath,
      addTab,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      onWorkspaceActivated,
      services.credentialService,
      bindRemoteWorkspaceScope,
      tabStoreApi,
      canUseRemoteWorkspace,
    ],
  );

  const handleRemoteWorkspaceSessionClosed = useCallback(
    async (event: RemoteSessionClosedEvent) => {
      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      // INV-12：只按 sessionId 反查，不使用 event 里可能带上的 path/identity。
      // 原因：关闭事件由 Host 在 session 销毁后发出，它携带的路径可能是"上一个绑定"的值
      // （bind 换代过），用它匹配会让本次关闭被算到另一个 workspace 头上。
      // matchedTabs 可能为空（session 还没绑定 tab，或 tab 已被关闭）：
      // 此时只注销 session 表项即可，不能凭空造出一条失败历史。
      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && tab.remoteSessionId === sessionId,
        );
      if (matchedTabs.length === 0) {
        unregisterRemoteWorkspaceSession(sessionId);
        return;
      }

      // 可恢复断连分支：只做软降级，绝不写 `disconnected` 这类终态。
      // 三件事：注销失效 services（旧 attachment 已不可用）、把连接事实投影成 reconnecting、
      // 记录 recoveryAttempt/limit 供 UI 显示"第 N/M 次重试"。
      // 关键不写的东西：
      //   - 不清 remoteSessionId：Host 可能会用同一 workspace 起新 session 并补发 reconnected 事件，
      //     提前清掉会让那个事件匹配不到 tab；
      //   - 不写 failed 历史：几秒后重连成功时无法回滚，用户会看到"明明连上了却标着失败"；
      //   - 不把远端 task 标记 failed：进程可能还在跑。
      if (event.recoverable === true) {
        // Bug 原因：transient Source close 在 Main 转发时丢失 recoverable，Renderer 会立即
        // 清 remoteSessionId、标记运行任务失败并写 failed history；几秒后重连却无法回滚这些
        // 终态副作用。恢复预算内只释放失效 services，tab/session id 留给换代事件匹配。
        unregisterRemoteWorkspaceSession(sessionId);
        for (const tab of matchedTabs) {
          setRemoteWorkspaceConnectionState(buildWorkspaceSessionKey(tab), "reconnecting");
        }
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, true),
        );
        setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
          const next = { ...current };
          for (const tab of matchedTabs) {
            next[buildWorkspaceSessionKey(tab)] = {
              mode: "automatic",
              ...(event.recoveryAttempt ? { attempt: event.recoveryAttempt } : {}),
              ...(event.recoveryLimit ? { limit: event.recoveryLimit } : {}),
            };
          }
          return next;
        });
        logger.info("[Root] 远程 workspace session 进入可恢复断连状态", {
          sessionId,
        });
        return;
      }

      // 终态分支的清理顺序：
      //   1) 先移除"恢复中"占位（否则会一直转圈）；
      //   2) 再删恢复状态记录（attempt/limit 已无意义）。
      // 两步都是 setState 的函数式更新：并发到达的多个 close 事件不会互相覆盖。
      setReconnectingRemoteWorkspaceKeys((currentKeys) =>
        updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, false),
      );
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
        const next = { ...current };
        for (const tab of matchedTabs) delete next[buildWorkspaceSessionKey(tab)];
        return next;
      });

      // Bug 根因：terminal close 可能先于 Source offline 到达；旧 online 快照不能立即撤销断开。
      // 先等待权威 Source 离开 online，下一次 online 才允许重置该 Source 的尝试记录并恢复。
      // 把"这台设备的 workspace 断了"记到两处之一：
      //   observedOnline 还在 → 放进 pendingTerminallyDisconnected，等下一次快照确认
      //     （避免 close 先于 Source offline 到达时误判）；
      //   已经不在 online → 直接记 currentRendererDisconnected，允许设备回来时重试。
      // 只处理 server 身份：SSH/WSL 的"设备"概念由连接配置承担，不走 Source 恢复路径。
      for (const tab of matchedTabs) {
        const identity = tab.workspaceIdentity
          ? parseRemoteWorkspaceIdentity(tab.workspaceIdentity)
          : null;
        if (identity?.kind === "server" && identity.sourceServerId) {
          if (
            remoteWorkspaceReconnectRendererState.observedOnlineSourceServerIds.has(
              identity.sourceServerId,
            )
          ) {
            remoteWorkspaceReconnectRendererState.pendingTerminallyDisconnectedSourceServerIds.add(
              identity.sourceServerId,
            );
          } else {
            remoteWorkspaceReconnectRendererState.currentRendererDisconnectedSourceServerIds.add(
              identity.sourceServerId,
            );
          }
        }
      }

      // Bugfix: 远端 host 退出后，tab 上的 remoteSessionId 之前不会被清空。
      // UI 因此持续显示“已连接”，并继续把请求路由到失效 session。
      // 这里在收到 main 进程的 session-close 事件时立即降级为断连态，后续只走用户手动重连。
      // 清 remoteSessionId 是"降级为断连态"的关键一步：
      // 不清的话，UI 仍认为已连接，会把请求路由到一个已经不存在的 session，
      // 用户看到的是"一直转圈 + 无错误"。清掉后所有入口都会提示"需要重新连接"。
      // 用 remoteSessionId === sessionId 精确匹配，不按路径：路径可能重复（多窗口）。
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) && tab.remoteSessionId === sessionId
            ? { ...tab, remoteSessionId: undefined }
            : tab,
        ),
      }));
      unregisterRemoteWorkspaceSession(sessionId);

      // 去重：多个 tab 可能来自同一个 workspaceKey（同一目录被开了两次）。
      // 后面的落盘与状态更新都以 key 为单位，重复会让同一条历史被写多次。
      const matchedWorkspaceKeys = [
        ...new Set(matchedTabs.map((tab) => buildWorkspaceSessionKey(tab))),
      ];
      const reason = formatRemoteConnectionError({
        fallback: resolveRemoteWorkspaceClosedFallback({
          event,
          formatMessage: intl.formatMessage,
          defaultFallback: [
            intl.formatMessage({ id: "remote.error.connectionClosed" }),
            event.exitCode != null ? `exitCode=${event.exitCode}` : null,
            event.signal ? `signal=${event.signal}` : null,
          ]
            .filter(Boolean)
            .join(" "),
        }),
        reasonCode: event.reasonCode,
        retryable: event.retryable,
        recoveryAttempt: event.recoveryAttempt,
        recoveryLimit: event.recoveryLimit,
        formatMessage: intl.formatMessage,
      });
      for (const workspaceKey of matchedWorkspaceKeys) {
        // 连接事实与远端 task terminal 状态分离：断连只更新 renderer overlay，
        // 不能把远端仍可能运行的 task 写成本地 failed。
        // overlay 是"本窗口认为的连接状态"，不落盘；它的存在让侧栏能立即显示断线，
        // 而不必等 failed 历史写入完成（写入是异步且可能被门禁延后）。
        setRemoteWorkspaceConnectionState(workspaceKey, "disconnected");
      }

      logger.warn("[Root] 远程 workspace session 已关闭", {
        sessionId,
        reason: event.reason,
        exitCode: event.exitCode,
        signal: event.signal,
        matchedWorkspaceKeys,
      });

      for (const workspaceKey of matchedWorkspaceKeys) {
        const sessionEntry = remoteWorkspaceSessionsRef.current.find(
          (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
        );
        if (!sessionEntry) {
          continue;
        }

        const pendingReconnectRequestId = pendingReconnectRequestIdsRef.current.get(workspaceKey);
        if (
          !shouldPersistRemoteWorkspaceFailure({
            pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
            sessionEntry,
            workspaceKey,
          })
        ) {
          logger.info("[Root] WSL workspace session 关闭时跳过失败落盘，等待重连结果", {
            pendingReconnectRequestId,
            sessionId,
            workspaceIdentity: sessionEntry.workspaceIdentity ?? null,
            workspacePath: sessionEntry.workspacePath,
            workspaceKey,
          });
          continue;
        }

        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: sessionEntry.workspacePath,
            workspaceIdentity: sessionEntry.workspaceIdentity,
            target: createRemoteTargetFromSnapshot(sessionEntry.target, {
              password: null,
              privateKeyPassphrase: null,
            }),
            lastConnectionStatus: "failed",
            lastConnectionError: isRemoteWorkspaceCloseFailure(event) ? reason : "",
            touchOpenedAt: false,
          }),
        );
      }
    },
    [commitRemoteWorkspaceSessionMutation, intl, tabStoreApi],
  );

  const handleRemoteWorkspaceSessionReconnected = useCallback(
    (event: RemoteSessionReconnectedEvent) => {
      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) &&
            tab.workspacePath === event.workspacePath &&
            tab.workspaceIdentity === event.workspaceIdentity &&
            (!tab.remoteSessionId || tab.remoteSessionId === event.previousSessionId),
        );
      if (matchedTabs.length === 0) return;
      setReconnectingRemoteWorkspaceKeys((currentKeys) =>
        updateRemoteWorkspaceRecoveringKeys(currentKeys, matchedTabs, false),
      );
      for (const tab of matchedTabs) {
        clearRemoteWorkspaceConnectionState(buildWorkspaceSessionKey(tab));
      }
      setRemoteWorkspaceRecoveryByWorkspaceKey((current) => {
        const next = { ...current };
        for (const tab of matchedTabs) delete next[buildWorkspaceSessionKey(tab)];
        return next;
      });
      unregisterRemoteWorkspaceSession(event.previousSessionId);
      bindRemoteWorkspacePath(event.workspacePath, event.sessionId);
      bindRemoteWorkspaceIdentity(event.workspaceIdentity, event.sessionId);
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) &&
          tab.workspacePath === event.workspacePath &&
          tab.workspaceIdentity === event.workspaceIdentity &&
          (!tab.remoteSessionId || tab.remoteSessionId === event.previousSessionId)
            ? { ...tab, remoteSessionId: event.sessionId }
            : tab,
        ),
      }));
    },
    [tabStoreApi],
  );

  useEffect(() => {
    return platform.onRemoteSessionClosed((event) => {
      void handleRemoteWorkspaceSessionClosed(event);
    });
  }, [handleRemoteWorkspaceSessionClosed, platform]);

  useEffect(() => {
    return (
      platform.onRemoteSessionReconnected?.((event) => {
        handleRemoteWorkspaceSessionReconnected(event);
      }) ?? (() => {})
    );
  }, [handleRemoteWorkspaceSessionReconnected, platform]);

  // 侧栏/窗口关闭 remote tab 时的清理。四步，顺序不可换：
  //   1) 清 overlay（UI 立刻反应）；
  //   2) 精确取消仍在排队的重连（按 requestId）——否则 tab 已消失、后台 upload 还在跑；
  //   3) 清 recoveringKeys，防止 reopen 同 key 时"一打开就是恢复中"；
  //   4) 删历史 + 删该条目独占的凭据。
  // 之所以要 2：断连 tab 上还没有 remoteSessionId，只能靠 pending requestId 定位；
  // 用 path 去取消会误伤同 path 的另一个窗口。
  const handleRemoteWorkspaceTabsClosed = useCallback(
    (workspaceKeys: string[]) => {
      if (workspaceKeys.length === 0) {
        return;
      }

      const workspaceKeySet = new Set(workspaceKeys);
      for (const workspaceKey of workspaceKeys) {
        clearRemoteWorkspaceConnectionState(workspaceKey);
      }

      void (async () => {
        // 关闭断连态 remote tab 时，tab 上还没有 remoteSessionId，但 main 进程可能已经在上传 remote runtime。
        // 这里用重连 requestId 精准取消 pending host，避免 UI 已移除而后台 upload 继续跑。
        await cancelPendingRemoteReconnectsForWorkspaceKeys({
          workspaceKeys,
          pendingRequestIds: pendingReconnectRequestIdsRef.current,
          cancelPendingRemoteConnection: platform.cancelPendingRemoteConnection
            ? (requestId) =>
                platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve()
            : undefined,
          logger,
        });
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          currentKeys.filter((key) => !workspaceKeySet.has(key)),
        );

        const removal = removeRemoteWorkspaceSessionEntries(
          remoteWorkspaceSessionsRef.current,
          workspaceKeys,
        );
        // 没有实际变化就别写盘：关闭一个从未持久化的 tab（例如刚建就关）时，
        // 无谓的 update 会触发磁盘写与 settings 事件风暴。
        // 两个条件都要判：列表长度没变且没有待删凭据，才说明真的没变化。
        if (
          removal.nextRemoteSessions.length === remoteWorkspaceSessionsRef.current.length &&
          removal.credentialKeysToDelete.length === 0
        ) {
          return;
        }

        // 用户在侧栏“移除”远程 workspace 后，只删 tab 不够：
        // remoteWorkspaceSessionsRef 仍被持久化补丁合并回 setting.json，
        // 所以下次启动又会恢复同一个断连项。这里把显式移除视为删除远程历史，
        // 同时清理该历史独占的 SSH 凭据，避免留下不可达的 credential key。
        await syncPersistedWorkspaceSession(removal.nextRemoteSessions);
        for (const credentialKey of removal.credentialKeysToDelete) {
          if (persistenceGate && !persistenceGate.canPersist) {
            pendingCredentialDeletesRef.current.add(credentialKey);
            continue;
          }
          try {
            await services.credentialService.delete(credentialKey);
          } catch (error) {
            logger.warn("[Root] 删除已移除远程 workspace 凭据失败", {
              credentialKey,
              error,
            });
          }
        }
      })();
    },
    [persistenceGate, platform, services.credentialService, syncPersistedWorkspaceSession],
  );

  // RemoteWorkspaceController 是"给非 React 调用方（手机 RPC / 菜单命令）的统一门面"。
  // 它把本 hook 内的能力包成命令对象，调用方只发 dispatch({type})，不需要知道实现细节。
  // 用 useMemo 固定引用：controller 会作为 context/依赖向下传，引用一变就会引发大范围重渲染；
  // 依赖列表里放的都是 useCallback 稳定函数，因此它只在这些能力真正变化时才重建。
  // 每个命令都自己做"能力检查"（dialog 是否存在 / management 是否存在 / session 是否唯一），
  // 而不是假设调用方已经检查过——RPC 入口没有 UI 状态可依赖。
  const remoteWorkspaceController = useMemo<RemoteWorkspaceController>(
    () =>
      createRemoteWorkspaceController({
        connectDevice: async (profileId, effect) => {
          if (!onOpenRemoteConnection) {
            throw new Error("Remote connection dialog is unavailable");
          }
          // 发起入口保留完成意图；凭据、安装、升级和错误仍由唯一向导承载。
          onOpenRemoteConnection({
            preferredProfileId: profileId,
            ...(effect === "device-management" ? { completion: effect } : {}),
          });
        },
        disconnectDevice: async (sourceServerId) => {
          const management = services.sourceServerManagementService;
          if (!management) {
            throw new Error("Source Server management is unavailable");
          }
          await management.disconnectSource(sourceServerId);
        },
        // 打开对话：允许只给 sourceServerId（手机端从设备进入），此时在 store 里找
        // 该设备当前已挂载的 session；找不到就报错而不是新建——对话必须依附一个
        // 已经协商好 scope 的 session，凭空建出来的 session 没有 workspace 归属。
        openConversation: async ({ sourceServerId, remoteSessionId }) => {
          const resolvedSessionId =
            remoteSessionId ??
            Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
              (session) => session.sourceServerId === sourceServerId,
            )?.sessionId;
          if (!resolvedSessionId) {
            throw new Error("Remote conversation intent requires an attached session");
          }
          await openRemoteConversation(resolvedSessionId, sourceServerId);
        },
        openProject: async ({
          sourceServerId,
          path,
          localWorkspacePath,
          remoteSessionId,
          draftProjectId,
          preparedWorkspaceIdentity,
          isCurrent,
        }) => {
          const sessions = Object.values(
            useRemoteWorkspaceSessionStore.getState().sessionsById,
          ).filter((session) =>
            remoteSessionId
              ? session.sessionId === remoteSessionId
              : sourceServerId
                ? session.sourceServerId === sourceServerId
                : !session.sourceServerId,
          );
          // 严格要求"恰好一个"候选 session：0 个说明连接还没建立；
          // 多于 1 个说明同一设备挂了多个 attachment（异常状态），此时任选一个都可能
          // 绑到错误的 workspace。宁可报错让调用方重试，也不猜。
          if (sessions.length !== 1) {
            throw new Error(
              `Remote project requires one attached session for Source Server: ${sourceServerId}`,
            );
          }
          await selectRemoteProjectFromDialog(
            sessions[0]!.sessionId,
            path,
            localWorkspacePath,
            "project",
            draftProjectId,
            preparedWorkspaceIdentity,
            isCurrent,
          );
        },
        reconnectWorkspace: async (workspaceKey, options) => {
          await runReconnectRemoteWorkspaceByKey(workspaceKey, options);
        },
        closeWorkspace: async (workspaceKey) => {
          handleRemoteWorkspaceTabsClosed([workspaceKey]);
        },
      }),
    [
      handleRemoteWorkspaceTabsClosed,
      onOpenRemoteConnection,
      openRemoteConversation,
      runReconnectRemoteWorkspaceByKey,
      selectRemoteProjectFromDialog,
      services.sourceServerManagementService,
    ],
  );

  // "已连接 session → 打开项目"的轻量入口：只负责把 sessionId 补成 sourceServerId，
  // 真正的打开逻辑全部交给 controller 的 open-project 命令（单一入口，便于串行化）。
  // 不在这里做 isCurrent 之外的校验：session 可能在 dispatch 排队期间被关闭，
  // 因此把 isCurrent 继续下传，由命令执行时再判定（INV-15）。
  const handleSelectRemoteProject = useCallback(
    async (
      sessionId: string,
      path: string,
      localWorkspacePath?: string,
      preparedWorkspaceIdentity?: string,
      isCurrent?: () => boolean | Promise<boolean>,
    ) => {
      const session = getRemoteWorkspaceSession(sessionId);
      await remoteWorkspaceController.dispatch({
        type: "open-project",
        isCurrent,
        sourceServerId: session?.sourceServerId ?? "",
        path,
        localWorkspacePath,
        remoteSessionId: sessionId,
        ...(preparedWorkspaceIdentity ? { preparedWorkspaceIdentity } : {}),
      });
    },
    [remoteWorkspaceController],
  );

  // 对话入口同理，但 sourceServerId 允许由调用方直接给出：
  // 对话可能在 session 尚未携带 sourceServerId 的时机被打开（例如启动恢复），
  // 此时优先用调用方已知的 Source，再退回 session 上可能为空的值。
  // 空串不是"合法 Source"，下游 ensureConversationWorkspace 会据此报错，而不是瞎猜一个。
  const handleOpenRemoteConversation = useCallback(
    async (sessionId: string, sourceServerId?: string) => {
      await remoteWorkspaceController.dispatch({
        type: "open-conversation",
        sourceServerId:
          sourceServerId ?? getRemoteWorkspaceSession(sessionId)?.sourceServerId ?? "",
        remoteSessionId: sessionId,
      });
    },
    [remoteWorkspaceController],
  );

  // 重连入口只做转发：options 里可能带凭据/SSH 复用信息，不能在 Root 层缓存
  // （缓存会让下一次连接复用上一次的密码），必须逐次透传给 controller。
  const handleReconnectRemoteWorkspace = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      await remoteWorkspaceController.dispatch({
        type: "reconnect-workspace",
        workspaceKey,
        options,
      });
    },
    [remoteWorkspaceController],
  );

  // 把"每个 entry 的 lastConnectionError"摊平成 key → message 的映射，供列表行直接查。
  // 过滤掉空白错误：空串表示"上次是正常断开"，不能渲染成一条错误提示。
  // flatMap + 条件空数组比 reduce 更直观，也避免在对象里塞 undefined 值。
  const remoteWorkspaceErrorByWorkspaceKey = useMemo(
    () =>
      Object.fromEntries(
        remoteWorkspaceSessions.flatMap((entry) =>
          entry.lastConnectionError?.trim()
            ? [[buildWorkspaceSessionKey(entry), entry.lastConnectionError] as const]
            : [],
        ),
      ),
    [remoteWorkspaceSessions],
  );

  // 对外契约刻意保持"数据 + 命令"两组：
  //   数据（sessions / keys / error 映射）是渲染用的只读投影，调用方不得就地修改；
  //   命令（handle* / restorePersistedSession / controller）是唯一能改状态的路径，
  //     这样"谁改了历史"始终可枚举，回归时能一眼定位到具体入口。
  // 不暴露 setRemoteWorkspaceSessions：绕过 commit 入口会破坏 INV-16
  // （内存列表与 settings 不一致，重启后条目消失）。
  return {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleOpenRemoteConversation,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleOpenRemoteWorkspaceFromHistory,
    handleRemoteWorkspaceTabsClosed,
    remoteWorkspaceController,
  };
}
