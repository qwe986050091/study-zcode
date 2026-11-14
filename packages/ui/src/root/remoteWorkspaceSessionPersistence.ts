// INV-01 身份键统一为 workspaceIdentity 的 trim 结果、缺失才退回 workspacePath；守住它：getRestorableWorkspaceKey 与 buildRemoteWorkspacePersistPatch 的 activeKey。改成纯路径比较会让同一远端在多处被当成两个条目，去重与活动位同时失效。
// INV-02 [事务] projectRemoteConversationWorkspacePurpose 只做读侧投影，并把需回写的条目单独放进 updatedEntries；守住它：该函数的返回对象。若在函数内直接改 settings，调用方与持久化层会出现两条写入路径，purpose 修复不再幂等。
// INV-03 只有「原 purpose 不是 conversation 且本次判为 conversation」的条目才进 updatedEntries；守住它：project 函数里的状况判断。放宽它会让同一批条目每轮投影都被标记，settings 反复落盘。
// INV-04 [失败路径] canonical 路径比较用全等，不做规范化、前缀或大小写折叠；守住它：resolveRemoteConversationWorkspacePurpose 的 return 三元。放宽后相邻目录会被误判成同一个 conversation。
// INV-05 身份解析必须经过 parseRemoteWorkspaceIdentity，输入缺失时传空串而不是跳过；守住它：resolveRemoteConversationWorkspacePurpose 的 parsedIdentity 行。跳过解析会让 sourceServerId 恒为空，canonical 路径永远是 undefined。
// INV-06 [事务] buildRemoteWorkspacePersistPatch 的三种返回必须区分开：找不到 tab 写 lastActiveWorkspace 为 null，远端无快照返回空对象，正常才返回补丁；守住它：三条 return。混淆 null 与空对象会让上次活动项永远清不掉，或多写一次旧值。
// INV-07 远端绑定进行中宁可返回空对象，也不能把远端路径写成本机目录；守住它：buildRemoteWorkspacePersistPatch 的 remote 三元分支。写错后重启会把远端 workspace 当成本地同名目录恢复。
// INV-08 [权衡] 窗口只拥有活动选择，项目集合与凭据快照由 Host 派生；守住它：buildRemoteWorkspacePersistPatch 的返回类型。往补丁里塞项目列表等于制造第二份项目状态，两边会越走越偏。
// INV-09 [失败路径] 恢复入口在无持久化条目且无 conversationWorkspacePath 时返回 undefined；守住它：restorePersistedRemoteWorkspaceSessions 的首个判断。删掉它就会以空列表恢复，清空窗口当前的 tab。
// INV-10 activeSessionIndex 必须夹在 0 到 persistedSessions.length 减一之间；守住它：restorePersistedRemoteWorkspaceSessions 里的 Math.min 与 Math.max 组合。越界后没有任何条目命中活动位，上次所在 tab 退化成第一个。
// INV-11 [事务] 本地条目恢复的语句次序是「判陈旧、去重、判可用性、推入 tabs」；守住它：该分支的 continue 位置。先去重再判陈旧会让 canonical 路径提前占位，真正的 conversation 反而被跳过。
// INV-12 [失败路径] 陈旧 conversation 只在 lastActiveWorkspace 未定义、canonical 路径存在、purpose 为 conversation 且路径不等时跳过，且只记日志不删数据；守住它：isStaleConversationWorkspace 的四个条件。放宽条件会让正常项目在恢复时消失。
// INV-13 默认项目不可用且它正是活动项时，必须改为激活 canonical conversation；守住它：availability 分支里 shouldActivateCanonicalConversation 的赋值。只标记不可用会让 WorkspaceShell 不挂载 composer。
// INV-14 [事务] 远程条目按身份键去重，重复即跳过；守住它：seenRemoteWorkspaceKeys 的 has 与 add 两处。改成按路径去重，会让同一服务端的两个挂载点争用同一份连接状态。
// INV-15 [资源] 远程恢复同时受 allowRemoteWorkspaceRestore 与 purpose 约束，跳过时不得清理会话数据与 canonical 映射；守住它：远程分支的两处 continue。顺手删数据会让重新开放入口后历史全丢。
// INV-16 [并发] active-first 的 deferredRestore 在补齐前必须复核活动 tab 是否仍然打开；守住它：startupActiveStillOpen 与 tabsToComplete 的过滤。省略复核会把用户刚关掉的 tab 按旧快照复活。
// INV-17 补齐条数日志要扣掉首帧已恢复的一项；守住它：completeTabRestore 之前的 count 表达式。直接取数组长度会让日志比真实补齐量多一项，排障时误判为丢 tab。
// INV-18 canonical conversation 缺失时要在末尾补建并强制标记 conversation；守住它：restorePersistedRemoteWorkspaceSessions 尾部的补建分支。漏补会让侧栏不订阅该 scope，purpose 丢失后又把它显示成项目。
//
// 模块职责：把窗口侧「上次活动的 workspace」投影成 settings 补丁，并在启动时把持久化的本地与远程 workspace 条目安全还原成 tab。
// 状态所有权：settings 归 Host，本模块只计算补丁；tab 集合归 tabStore，恢复只经 restoreTabs 与 completeTabRestore 提交。
// 阅读顺序：身份键与 purpose 解析 → projectRemoteConversationWorkspacePurpose → buildRemoteWorkspacePersistPatch → restorePersistedRemoteWorkspaceSessions（本地分支、远程分支、active-first 补齐）。
import type { AppSettings, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  buildWorkspaceSessionKey,
  readPersistedWorkspaceSessionEntries,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  isWorkspaceTab,
  type RestorableWorkspaceTab,
  type TabStore,
  type TabStoreState,
} from "@/store/tabStore.js";

function getRestorableWorkspaceKey(tab: string | RestorableWorkspaceTab): string {
  if (typeof tab === "string") {
    return tab;
  }
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

// 纯函数：判断一条持久化条目在给定的 conversation 映射下，是否应被视作「无项目会话」。
// 只有映射中的 workspacePath 与条目路径完全相等才返回 conversation，其余一律回落条目自身的 workspacePurpose。
// 身份解析走 parseRemoteWorkspaceIdentity，identity 缺失时传空串而不是提前退出；否则带 sourceServerId 的条目永远拿不到 canonical 路径。
// [失败路径] 映射缺失（sourceServerId 无对应项或入参为 undefined）时 canonical 路径为 undefined，比较必然不等，条目保持原 purpose。
// 返回值直接复用 entry 上的 workspacePurpose，不造新字符串；调用方靠它区分「原本就是 conversation」与「本次被提升」。
// [权衡] 这里只读不写，不回填 settings；写回职责在 projectRemoteConversationWorkspacePurpose 的 updatedEntries。
function resolveRemoteConversationWorkspacePurpose(
  entry: Pick<
    RemoteWorkspaceSessionEntry,
    "workspaceIdentity" | "workspacePath" | "workspacePurpose"
  >,
  conversationWorkspaceMap: AppSettings["remoteConversationWorkspaceBySourceServerId"],
): RemoteWorkspaceSessionEntry["workspacePurpose"] {
  const parsedIdentity = parseRemoteWorkspaceIdentity(entry.workspaceIdentity ?? "");
  const canonicalConversationPath = parsedIdentity?.sourceServerId
    ? conversationWorkspaceMap?.[parsedIdentity.sourceServerId]?.workspacePath
    : undefined;
  return canonicalConversationPath === entry.workspacePath
    ? "conversation"
    : entry.workspacePurpose;
}

// 把远程会话列表投影成 purpose 已纠正的新数组，同时单独交出需要回写的条目清单。
// [事务] 投影是纯映射：未发生提升的条目原样返回同一引用，避免无谓复制改变下游的引用比较结果。
// updatedEntries 只收「原本不是 conversation、本次被判为 conversation」的条目，这是回写的幂等边界。
// 若把已是 conversation 的条目也塞进清单，持久化侧每轮都会重复写同一份 settings，形成无休止的脏标记。
// 回写条目只带 workspacePath 与可选的 workspaceIdentity，不带 target 等字段；多余字段会让持久化层误以为要重建远端快照。
// [失败路径] workspaceIdentity 为空时用条件展开省略该键，不能写成 undefined 键；下游按键是否存在判断远程身份。
// 返回顺序与入参一致，调用方据此把更新条目与原始列表下标对齐。
export function projectRemoteConversationWorkspacePurpose(
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
  conversationWorkspaceMap: AppSettings["remoteConversationWorkspaceBySourceServerId"],
): {
  remoteSessions: RemoteWorkspaceSessionEntry[];
  updatedEntries: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
} {
  const updatedEntries: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }> = [];
  const projectedSessions = remoteSessions.map((entry) => {
    const workspacePurpose = resolveRemoteConversationWorkspacePurpose(
      entry,
      conversationWorkspaceMap,
    );
    if (workspacePurpose !== "conversation" || entry.workspacePurpose === "conversation") {
      return entry;
    }
    updatedEntries.push({
      workspacePath: entry.workspacePath,
      ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
    });
    return { ...entry, workspacePurpose };
  });
  return { remoteSessions: projectedSessions, updatedEntries };
}

/** 窗口只拥有活动选择；项目集合与旧版凭据快照由 Host 派生。 */
// 窗口侧唯一负责持久化 lastActiveWorkspace 的入口：只写当前活动选择，不写项目集合与旧版凭据快照。
// activeKey 取 activeWorkspaceIdentity 的 trim 结果，为空才退回 activeWorkspacePath，与全仓身份键规则保持一致。
// 在 tabs 中先用 isWorkspaceTab 过滤，再按 buildWorkspaceSessionKey 精确匹配 activeKey，不做前缀或路径包含匹配。
// [失败路径] 找不到活动 tab 时写 lastActiveWorkspace 为 null：这是显式清空，和返回空对象代表的「不写」语义相反。
// 命中 tab 带 workspaceIdentity 或 remoteSessionId 时按远程处理，只在 remoteSessions 里找到同键快照才写回。
// [事务] 远端绑定进行中时快照尚不存在，此时返回空对象；若退回写本机路径，会把远端 workspace 记成同路径的本地目录。
// 本地分支固定写 kind 为 local，并按条件带上 workspacePurpose；缺 kind 会让下次启动无法判断条目类型。
// [权衡] 不在这里合并旧 settings：补丁只描述本次变化，合并与落盘交给调用方的写入流程。
export function buildRemoteWorkspacePersistPatch(
  state: TabStoreState,
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
): Partial<AppSettings> {
  const activeKey = state.activeWorkspaceIdentity?.trim() || state.activeWorkspacePath;
  const tab = state.tabs
    .filter(isWorkspaceTab)
    .find((candidate) => buildWorkspaceSessionKey(candidate) === activeKey);
  if (!tab) return { lastActiveWorkspace: null };
  if (tab.workspaceIdentity || tab.remoteSessionId) {
    const remote = remoteSessions.find((entry) => buildWorkspaceSessionKey(entry) === activeKey);
    // 绑定仍在进行时没有可保存的远端快照；不能把远端路径写成本机目录。
    return remote ? { lastActiveWorkspace: remote } : {};
  }
  return {
    lastActiveWorkspace: {
      kind: "local",
      workspacePath: tab.workspacePath,
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
    },
  };
}

export function restorePersistedRemoteWorkspaceSessions({
  settings,
  tabStoreApi,
  allowRemoteWorkspaceRestore = true,
  unavailableWorkspacePath,
  conversationWorkspacePath,
  remoteConversationWorkspaceBySourceServerId,
  restoreMode = "all",
}: {
  settings: AppSettings;
  tabStoreApi: TabStore;
  allowRemoteWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  conversationWorkspacePath?: string;
  remoteConversationWorkspaceBySourceServerId?: AppSettings["remoteConversationWorkspaceBySourceServerId"];
  restoreMode?: "all" | "active-first";
}): { deferredRestore?: () => void } | undefined {
  // 恢复入口先读持久化条目，再解析 conversation 映射：入参优先，缺省才回落到 settings 里的同名字段。
  // 条目为空且没有 conversationWorkspacePath 时立即返回 undefined，表示本窗口没有需要恢复的组合。
  // [失败路径] 这个提前返回同时承担「不碰 tab」的职责；改成继续执行会以空列表提交恢复，清掉窗口已有的 tab。
  // restoredTabs 的推入顺序即最终 tab 顺序，restoredActiveIndex 始终是它在数组中的下标，不是持久化条目的下标。
  // seenLocalWorkspacePaths 与 seenRemoteWorkspaceKeys 分开维护：本地按路径去重，远程按身份键去重，两套键不可混用。
  // [并发] activeSessionIndex 把 lastActiveTabIndex 夹进合法区间；越界下标匹配不到任何条目，最终只会激活第一个 tab。
  const persistedSessions = readPersistedWorkspaceSessionEntries(settings);
  const conversationWorkspaceMap =
    remoteConversationWorkspaceBySourceServerId ??
    settings.remoteConversationWorkspaceBySourceServerId;

  if (persistedSessions.length === 0 && !conversationWorkspacePath) {
    return;
  }

  const restoredTabs: Array<string | RestorableWorkspaceTab> = [];
  const seenLocalWorkspacePaths = new Set<string>();
  const seenRemoteWorkspaceKeys = new Set<string>();
  // Renderer 恢复导航位置；Host 的本地预热筛选不能决定当前页签，否则远程焦点会丢失。
  const activeSessionIndex = Math.min(
    Math.max(settings.lastActiveTabIndex ?? 0, 0),
    persistedSessions.length - 1,
  );
  let restoredActiveIndex = 0;
  let canonicalConversationRestoredIndex: number | null = null;
  let shouldActivateCanonicalConversation = false;

  for (const [index, persistedEntry] of persistedSessions.entries()) {
    // 本地条目分支：先判陈旧 conversation，再去重、判可用性，最后才推入 restoredTabs。
    // 陈旧条件要四条同时成立：lastActiveWorkspace 未定义、canonical 路径存在、purpose 为 conversation、路径与 canonical 不等。
    // [事务] 跳过陈旧项只记 warn 并 continue，不删除持久化数据；清理属于后续 settings 写入，不在恢复路径里做。
    // 被跳过的项若正好是活动位，就改为激活已恢复的 canonical conversation，而不是让活动位悬空。
    // 重复的本地路径在推入前被 seenLocalWorkspacePaths 拦下；漏掉这层会让同一路径出现两个 tab，侧栏出现多个同名项目。
    // availability 只在非 conversation 且路径等于 unavailableWorkspacePath 时置为 unavailable-local-directory，其余保持 undefined。
    if (persistedEntry.kind === "local") {
      const isStaleConversationWorkspace = Boolean(
        settings.lastActiveWorkspace === undefined &&
        conversationWorkspacePath &&
        persistedEntry.workspacePurpose === "conversation" &&
        persistedEntry.workspacePath !== conversationWorkspacePath,
      );
      if (isStaleConversationWorkspace) {
        // 测试数据根目录或旧 data root 可能把多个 conversation backing path
        // 持久化下来；它们是同一个逻辑“无项目会话”，恢复时必须以 service 给出的
        // canonical path 为准，否则侧栏和定时任务选择器都会出现多个 default。
        logger.warn("[Root] 跳过非 canonical conversation workspace 恢复", {
          workspacePath: persistedEntry.workspacePath,
          conversationWorkspacePath,
        });
        if (index === activeSessionIndex) {
          shouldActivateCanonicalConversation = true;
          if (canonicalConversationRestoredIndex !== null) {
            restoredActiveIndex = canonicalConversationRestoredIndex;
          }
        }
        continue;
      }

      if (seenLocalWorkspacePaths.has(persistedEntry.workspacePath)) {
        logger.warn("[Root] 跳过重复的本地 workspace 恢复", {
          workspacePath: persistedEntry.workspacePath,
        });
        continue;
      }

      const isConversationWorkspace =
        persistedEntry.workspacePath === conversationWorkspacePath ||
        persistedEntry.workspacePurpose === "conversation";
      const workspacePurpose = isConversationWorkspace
        ? "conversation"
        : persistedEntry.workspacePurpose;
      const availability =
        !isConversationWorkspace && persistedEntry.workspacePath === unavailableWorkspacePath
          ? "unavailable-local-directory"
          : undefined;
      if (availability && index === activeSessionIndex && conversationWorkspacePath) {
        // Bug 根因：只标记不可用仍会激活失效项目，WorkspaceShell 不挂载 composer。
        // 恢复时直接选择已解析的无项目 cwd，保留失效入口供用户查看历史。
        shouldActivateCanonicalConversation = true;
        logger.info("[Root] 默认项目不可用，恢复无项目草稿", {
          workspacePath: persistedEntry.workspacePath,
          conversationWorkspacePath,
        });
      }
      restoredTabs.push(
        workspacePurpose || availability
          ? {
              workspacePath: persistedEntry.workspacePath,
              workspacePurpose,
              availability,
            }
          : persistedEntry.workspacePath,
      );
      seenLocalWorkspacePaths.add(persistedEntry.workspacePath);
      const restoredIndex = restoredTabs.length - 1;
      if (isConversationWorkspace) {
        canonicalConversationRestoredIndex = restoredIndex;
      }
      if (
        index === activeSessionIndex ||
        (isConversationWorkspace && shouldActivateCanonicalConversation)
      ) {
        restoredActiveIndex = restoredIndex;
      }
      continue;
    }

    // 远程条目分支：先用 resolveRemoteWorkspaceSessionIdentity 取身份，键取 trim 后的身份，缺失才退回路径。
    // [失败路径] purpose 为 conversation 的远程条目直接跳过恢复，但不删除会话数据与 canonical 历史映射。
    // 身份键重复时记 warn 后跳过；同一 sourceServerId 下两个不同路径会让两个 tab 争用同一份连接注册表。
    // allowRemoteWorkspaceRestore 为假时静默跳过、不产生 tab；否则用户看不到远程入口，却仍出现断连态远程项。
    // [权衡] 恢复只还原断开的远程 tab，不触发重连；lastConnectionStatus 必须保留上次真实结果，被关闭的 tab 也不该被拉回。
    const workspaceIdentity = resolveRemoteWorkspaceSessionIdentity(persistedEntry);
    const workspaceKey = workspaceIdentity?.trim() || persistedEntry.workspacePath;
    const workspacePurpose = resolveRemoteConversationWorkspacePurpose(
      persistedEntry,
      conversationWorkspaceMap,
    );
    // 停用远程无项目 UI 只跳过恢复，不能删除会话数据或 canonical 历史映射。
    if (workspacePurpose === "conversation") continue;
    if (seenRemoteWorkspaceKeys.has(workspaceKey)) {
      logger.warn("[Root] 跳过身份冲突的远程 workspace 恢复", {
        workspacePath: persistedEntry.workspacePath,
        workspaceIdentity,
      });
      continue;
    }

    if (!allowRemoteWorkspaceRestore) {
      // 远程连接入口被策略隐藏时，启动恢复不能悄悄拉起远程 workspace tab。
      // 否则用户看不到入口却仍保留“断连态远程项”，会造成展示与能力不一致。
      continue;
    }

    // 启动只恢复“断开态远程 tab”，不做自动重连。
    // 这样 setting.json 中的 lastConnectionStatus 才能真实反映上次结果，
    // 用户关闭的远端 tab 也不会在下次启动被后台拉回。
    restoredTabs.push({
      workspacePath: persistedEntry.workspacePath,
      remoteTarget: persistedEntry.target,
      workspaceIdentity,
      ...(workspacePurpose ? { workspacePurpose } : {}),
    });
    seenRemoteWorkspaceKeys.add(workspaceKey);
    if (index === activeSessionIndex) {
      restoredActiveIndex = restoredTabs.length - 1;
    }
  }

  if (
    (!settings.lastActiveWorkspace || shouldActivateCanonicalConversation) &&
    conversationWorkspacePath &&
    !seenLocalWorkspacePaths.has(conversationWorkspacePath)
  ) {
    // 修复原因：conversation backing workspace 是 app-owned cwd，旧设置里缺少它时，
    // 侧栏就不会订阅该 scope；若 purpose 丢失又会被当成项目。恢复阶段以 service
    // 解析出的 canonical path 为权威，非激活补建并强制标记 conversation。
    restoredTabs.push({
      workspacePath: conversationWorkspacePath,
      workspacePurpose: "conversation",
    });
    canonicalConversationRestoredIndex = restoredTabs.length - 1;
  }

  if (shouldActivateCanonicalConversation && canonicalConversationRestoredIndex !== null) {
    restoredActiveIndex = canonicalConversationRestoredIndex;
  }

  if (restoredTabs.length > 0) {
    // active-first 只为首帧提速：先只恢复活动 tab，其余交给 deferredRestore 在空闲回调里补齐。
    // activeTab 由 restoredActiveIndex 取得，活动键仍用 getRestorableWorkspaceKey 计算，保证与补齐阶段比较口径一致。
    // [并发] 补齐前重新检查活动 tab 是否仍打开；期间被用户关闭的 tab 属于本窗口新意图，不能按旧快照复活。
    // startupActiveStillOpen 为真时整份 restoredTabs 交给 completeTabRestore，为假时过滤掉活动键对应的条目。
    // 补齐条数日志扣掉首帧已恢复的那一项，避免把总数误读成补齐量。
    if (restoreMode === "active-first" && restoredTabs.length > 1) {
      const activeTab = restoredTabs[restoredActiveIndex];
      if (activeTab) {
        const activeWorkspaceKey = getRestorableWorkspaceKey(activeTab);
        logger.info("[Root] 优先恢复 active workspace", {
          deferredCount: restoredTabs.length - 1,
        });
        tabStoreApi.getState().restoreTabs([activeTab], 0);
        return {
          deferredRestore: () => {
            const startupActiveStillOpen = tabStoreApi
              .getState()
              .tabs.filter(isWorkspaceTab)
              .some(
                (tab) =>
                  (tab.workspaceIdentity?.trim() || tab.workspacePath) === activeWorkspaceKey,
              );
            // active-first 保存的是旧 settings 快照；idle callback 前用户若关闭 active tab，
            // 直接 complete 会把它从旧快照复活。关闭属于本窗口新意图，补齐时必须排除该 identity。
            const tabsToComplete = startupActiveStillOpen
              ? restoredTabs
              : restoredTabs.filter(
                  (restoredTab) => getRestorableWorkspaceKey(restoredTab) !== activeWorkspaceKey,
                );
            logger.info("[Root] 首帧后补齐 inactive workspace", {
              count: tabsToComplete.length - (startupActiveStillOpen ? 1 : 0),
            });
            tabStoreApi.getState().completeTabRestore(tabsToComplete);
          },
        };
      }
    }
    logger.info("[Root] 恢复组合 workspace 会话", {
      count: restoredTabs.length,
      activeIndex: restoredActiveIndex,
    });
    tabStoreApi.getState().restoreTabs(restoredTabs, restoredActiveIndex);
  }
  return undefined;
}
