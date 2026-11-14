/* oxlint-disable eslint(max-lines) */
/**
 * Tab Store —— 多标签页状态管理
 *
 * 每个窗口拥有独立的 tab store（不跨窗口广播）。
 * 标签页状态通过 settingService 持久化（见 useTabPersistence）。
 */
// Tab Store —— 多标签页状态管理（window-scoped 唯一事实源）
//
// 职责边界：
// - 拥有：本窗口 tabs 有序数组、activeTabId 与 active workspace 投影、expandedWorkspacePaths、
//   lastClosedWorkspaceEvent 序列号、pendingFileManagerTarget 一次性导航请求。
// - 不拥有：任务/会话数据、workspace 目录真实存在性、跨窗口状态；不监听广播，也不直接读 settings。
// - 持久化：只经 workspaceExpansionPreference 写「展开」这一事实，顺序为先落盘后 set。
// - identity key 统一为 workspaceIdentity?.trim() || workspacePath；路径只作展示与本地兜底。
//
// INV 表（任一破口都会表现为标签错位、丢焦点或远端会话串号）：
// INV-01 断言：activeTabId 非 null 时必存在于 tabs —— 守住它的位置：addTab/ensure/activate 只在命中的 tab id 上赋值，closeTab 先过滤再取接替 —— 改错故障：主区渲染不存在的 tab，白屏且永不复位。
// INV-02 断言：tabs 中 settings 至多一个且 id 恒为 SETTINGS_TAB_ID —— 守住它的位置：openSettingsTab 先 find(isSettingsTab) —— 改错故障：多份设置页共享同一 id，React key 冲突、点击定位错乱。
// INV-03 断言：同一 identity key 至多一个 workspace tab —— 守住它的位置：addTab/ensureWorkspaceTab/completeTabRestore 统一走 isSameWorkspaceTab —— 改错故障：同路径远端重复，任务被写进非当前视图。
// INV-04 断言：newTabs 为空时 activeTabId=null 且不新建替代 tab —— 守住它的位置：closeTab 的 newTabs.length===0 分支 —— 改错故障：凭空造 tab 或 active 悬空，设置页无法打开。
// INV-05 断言：关闭激活 tab 后新 active 必须是右邻，末位取左邻 —— 守住它的位置：closeTab 的 min(index, len-1) —— 改错故障：焦点跳到无关 tab，用户上下文丢失。
// INV-06 断言：activeWorkspacePath 存在时其 key 必在 expandedWorkspacePaths —— 守住它的位置：closeTab/activate/addTab 均补 ensure —— 改错故障：已激活但折叠，侧栏与主区不一致。
// INV-07 断言：tab id 只由 createUuid 在新建时生成，复用路径保留 existing.id —— 守住它的位置：createWorkspaceTab 与 merge 分支 —— 改错故障：React 复用错误组件实例，会话视图串台。
// INV-08 断言：ensureWorkspaceTab/completeTabRestore 不得改变 activeTabId —— 守住它的位置：两处只写 tabs 与展开态 —— 改错故障：后台导入任务把用户从当前页面拉走。
// INV-09 断言：等值合并返回原 tab 与原 state.tabs —— 守住它的位置：mergeWorkspaceTabOptions 与 addTab 的引用比较 —— 改错故障：Cmd+N 触发全应用重渲染。
// INV-10 断言：先 persistWorkspaceExpandedPreference 再 set —— 守住它的位置：每个展开相关 action —— 改错故障：落盘与内存短暂不一致，重启后展开态回退。
// INV-11 断言：lastClosedWorkspaceEvent.sequence 严格递增且只对 workspace 发 —— 守住它的位置：closeTab 末尾的独立 set —— 改错故障：消费方漏判或重复释放会话。
// INV-12 断言：空输入不改 state，completeTabRestore 不覆盖首帧后新增 tab —— 守住它的位置：restoreTabs/completeTabRestore 的入口守卫 —— 改错故障：持久化缺失时清空窗口，或二次恢复重建 id。
//
// 事务观：每个 action 先算 nextState，再一次 set；关闭事件用独立 set 追加序列号。
// 并发观：store 无锁，但所有读改写都在 set(updater) 内基于 state 派生，禁止跨 await 持有旧快照。
//
// 阅读顺序：常量/类型 → 纯工具函数 → createTabStore 内各 action（add → ensure → close → 其余）。
// 维护要求：新增 action 必须复用 mergeWorkspaceTabOptions 与 resolveWorkspaceKey，不得手写 identity 拼接。
import { create } from "zustand";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";
import {
  createUuid,
  resolveWorkspaceKey,
  type RemoteTarget,
  type TabId,
  type TabState,
  type WorkspacePurpose,
} from "@zcode/shared";
import {
  persistWorkspaceExpandedPreference,
  readWorkspaceExpansionState,
  resolveExpandedWorkspacePaths,
  type WorkspaceExpansionState,
} from "@/lib/workspaceExpansionPreference.js";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";

// [契约] 设置页不是 workspace：它没有 workspacePath/identity，也不参与远端会话隔离与展开态持久化。
// id 固定为常量而非 createUuid，是为了让 openSettingsTab 的“窗口内唯一”可以只靠 find(isSettingsTab) 判定。
// 外部若需要跨窗口定位设置页，也只能依赖这个哨兵值，不能另造 id。
export const SETTINGS_TAB_ID = "__settings__" satisfies TabId;

export type WorkspaceAvailability = "available" | "unavailable-local-directory";

export interface SettingsTabState {
  id: typeof SETTINGS_TAB_ID;
  kind: "settings";
  label: "settings";
}

// [契约] 持久化字段（workspacePath、identity、远程会话、purpose、availability）来自 RestorableWorkspaceTab，可跨启动恢复。
// [契约] 非持久化字段只活一个生命周期：restorePaneSession 供启动恢复消费，previousWorkspaceIdentity 只做一次 rekey 判定。
// availability 是启动期一次性校验结果，运行期不重检；把它当实时事实会得到“目录已恢复但仍显示不可用”的错觉。
export interface WorkspaceTabState extends TabState {
  kind: "workspace";
  /** 启动恢复的激活页签可消费既有 pane 选择；只属窗口导航，不写回 settings。 */
  restorePaneSession?: boolean;
  /** 启动期一次性校验结果；不持久化，运行期间不重检。 */
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  /** Host bind rekey 的前一个 identity；仅用于一次生命周期 transition 判定，不持久化。 */
  previousWorkspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface WorkspaceTabOptions {
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  /** Host stable identity 换代前的 route identity，只用于原子 rekey 已有 tab。 */
  previousWorkspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface RestorableWorkspaceTab {
  workspacePath: string;
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export type WindowTabState = WorkspaceTabState | SettingsTabState;

export function isWorkspaceTab(tab: WindowTabState): tab is WorkspaceTabState {
  return tab.kind === "workspace";
}

export function isWorkspaceTabReadOnly(tab: WindowTabState): tab is WorkspaceTabState & {
  availability: "unavailable-local-directory";
} {
  return isWorkspaceTab(tab) && tab.availability === "unavailable-local-directory";
}

// [契约] 只读判定按 identity key 而非裸路径比较：同路径远端不可用不应把本地同名目录一起标成只读。
// key 归一与 tabs 去重共用同一条规则，避免“这里查不到、那里重复”的分裂。
// 调用方传入的 workspaceIdentity 为空时退回 workspacePath，保持本地目录的旧行为。
export function isWorkspaceReadOnly(
  state: Pick<TabStoreState, "tabs">,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return state.tabs.some(
    (tab) =>
      isWorkspaceTabReadOnly(tab) &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
  );
}

export function isSettingsTab(tab: WindowTabState): tab is SettingsTabState {
  return tab.kind === "settings";
}

// ============================================================================
// State 定义
// ============================================================================

// [契约] 这里是本窗口标签域的唯一事实源：tabs 顺序即展示顺序，active* 只是投影。
// [契约] activeWorkspacePath/Identity 允许在 activeTabId 为 null 时保留“最近一次”的值，设置页需要它继续命中同一远端。
// [权衡] action 全部同步：store 内不做 IO 等待，落盘失败只降级为“下次启动少一个展开态”。
export interface TabStoreState {
  /** 仅窗口内的一次性导航请求，目标 Shell 消费后清除，不持久化。 */
  pendingFileManagerTarget: FileManagerTarget | null;
  requestFileManager: (target: FileManagerTarget) => void;
  consumeFileManager: (target: FileManagerTarget) => boolean;
  /** 当前窗口所有打开的标签页（有序） */
  tabs: WindowTabState[];
  /** 当前激活的标签页 ID，null 表示无激活标签 */
  activeTabId: TabId | null;
  /** 当前或最近一次激活的 workspace 路径 */
  activeWorkspacePath: string | null;
  /** 当前或最近一次激活的 workspace identity（远端同路径隔离） */
  activeWorkspaceIdentity: string | null;
  /** 左侧侧边栏中已展开的 workspace 路径集合 */
  expandedWorkspacePaths: Set<string>;
  /** 新增标签页，返回新 tab 的 ID */
  addTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** 确保 workspace 出现在任务区数据源中，但不抢走当前焦点 */
  ensureWorkspaceTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** 关闭标签页 */
  closeTab: (tabId: TabId, origin?: "user-close" | "restore" | "rekey") => void;
  /** Renderer lifecycle 使用的显式 close intent；不是持久化业务状态。 */
  // [并发] sequence 是窗口内单调计数器，消费方据此丢弃重复/乱序的关闭通知。
  // [事务] 只有真正的 workspace tab 关闭才发事件；关设置页不产生该事件，避免上层误清理 workspace 资源。
  // origin 区分用户关闭、启动恢复置换与 rekey，消费方按语义决定是否释放会话。
  lastClosedWorkspaceEvent: {
    sequence: number;
    workspaceKey: string;
    origin: "user-close" | "restore" | "rekey";
  } | null;
  /** 激活指定标签页 */
  activateTab: (tabId: TabId) => void;
  /** 拖拽排序：将 fromIndex 位置的 tab 移动到 toIndex */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  /** 仅按 workspace 子序列重排，保留设置页等非 workspace tab 的位置槽位 */
  reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => void;
  /** 打开设置标签页（窗口内唯一） */
  openSettingsTab: () => void;
  /** 通过 workspace 路径激活 tab（跨窗口 focus 用），返回是否找到 */
  activateTabByPath: (path: string, options?: { workspaceIdentity?: string }) => boolean;
  /** 切换 workspace 的展开/收起态 */
  toggleWorkspaceExpanded: (path: string) => void;
  /** 展开当前任务区里的全部 workspace */
  expandAllWorkspaceTabs: (paths: string[]) => void;
  /** 收起当前任务区里的全部 workspace */
  collapseAllWorkspaceTabs: (paths: string[]) => void;
  /** 批量恢复标签页（启动时从持久化数据恢复用） */
  restoreTabs: (tabs: Array<string | RestorableWorkspaceTab>, activeIndex: number) => void;
  /** 启动首帧后补齐持久化标签页；保留当前 active identity 和用户在此期间新增的标签页。 */
  completeTabRestore: (tabs: Array<string | RestorableWorkspaceTab>) => void;
}

// ============================================================================
// 工具函数
// ============================================================================

/** 从路径提取文件夹名作为标签显示名 */
function labelFromPath(path: string): string {
  // 兼容 Windows 反斜杠和 Unix 正斜杠
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

// [契约] 新建 tab 的 id 只在这里由 createUuid 生成；任何复用路径都必须沿用 existing.id，不得重新生成。
// label 由路径末段派生，仅作展示；路径变化时才需要重建，不参与 identity 判定。
// [权衡] options 全量透传但允许 undefined：缺省字段保持“未知”，不与“显式空值”混为一谈。
function createWorkspaceTab(
  workspacePath: string,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  return {
    id: createUuid(),
    kind: "workspace",
    workspacePath,
    label: labelFromPath(workspacePath),
    availability: options?.availability,
    remoteSessionId: options?.remoteSessionId,
    remoteTarget: options?.remoteTarget,
    workspaceIdentity: options?.workspaceIdentity,
    previousWorkspaceIdentity: options?.previousWorkspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose,
  };
}

// [契约] 合并语义是“新值非空则覆盖，否则保留旧值”，因此 undefined 不会清掉已有 remoteSessionId。
// [资源] 等值合并必须返回原对象引用：Cmd+N 复用当前 tab 时若制造新引用，会让 App 与整个项目侧栏重渲染。
// [契约] previousWorkspaceIdentity 也参与合并，但只用于一次 rekey 判定，下一次合并即被新值替换。
// [失败路径] 不做深比较，只看顶层字段；嵌套对象（remoteTarget）更换引用即视为变更。
function mergeWorkspaceTabOptions(
  tab: WorkspaceTabState,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  const merged: WorkspaceTabState = {
    ...tab,
    availability: options?.availability ?? tab.availability,
    remoteSessionId: options?.remoteSessionId ?? tab.remoteSessionId,
    remoteTarget: options?.remoteTarget ?? tab.remoteTarget,
    remoteHistoryId: options?.remoteHistoryId ?? tab.remoteHistoryId,
    workspaceIdentity: options?.workspaceIdentity ?? tab.workspaceIdentity,
    previousWorkspaceIdentity: options?.previousWorkspaceIdentity ?? tab.previousWorkspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath ?? tab.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose ?? tab.workspacePurpose,
  };
  // Cmd+N 会复用当前 tab；等值元数据不应制造新引用，导致 App 和整个项目侧栏重渲染。
  return Object.entries(merged).every(([key, value]) =>
    Object.is(tab[key as keyof WorkspaceTabState], value),
  )
    ? tab
    : merged;
}

function normalizeRestorableWorkspaceTab(
  tab: string | RestorableWorkspaceTab,
): RestorableWorkspaceTab {
  if (typeof tab === "string") {
    return {
      workspacePath: tab,
    };
  }

  return tab;
}

function createSettingsTab(): SettingsTabState {
  return {
    id: SETTINGS_TAB_ID,
    kind: "settings",
    label: "settings",
  };
}

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (!movedItem) {
    return nextItems;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function ensureWorkspaceExpanded(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.add(workspacePath);
  return next;
}

function pruneExpandedWorkspace(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (!expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.delete(workspacePath);
  return next;
}

// ============================================================================
// Store 创建
// ============================================================================

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// [资源] storage 由调用方注入，缺省 undefined 时回落到 localStorage；测试与 SSR 可显式传 null 关闭持久化。
// [契约] 每个窗口调用一次本工厂，得到独立实例；跨窗口共享靠广播，不靠共享 store。
// [事务] 工厂内所有 action 共用同一个 set/get 闭包，禁止在外部再构造第二个实例持有同一 storage 键。
// [权衡] 展开态持久化是 best-effort：写失败不抛错、不回滚内存 state。
export function createTabStore(storage: StorageLike | null | undefined = undefined) {
  return create<TabStoreState>()((set, get) => ({
    tabs: [],
    pendingFileManagerTarget: null,
    // [事务] 先登记目标再 addTab：目标 Shell 需要看到 pending 才切换任务归属，顺序反了会写到旧任务下。
    // [契约] 只透传 workspacePath/identity/remoteSessionId，其余字段由 addTab 的查重逻辑决定是否复用。
    // [失败路径] 目标对象按引用比较，调用方不得在登记后重建等值对象，否则 consumeFileManager 永远不命中。
    // [资源] 该字段不持久化，窗口重载后自然清空，不需要显式清理路径。
    requestFileManager: (target) => {
      // 先记录目标再激活 workspace，目标 Shell 完成切换后才创建标签，避免借用旧任务归属。
      set({ pendingFileManagerTarget: target });
      get().addTab(target.workspacePath, {
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.workspaceRemoteSessionId,
      });
    },
    // [并发] 读-比较-清空三步在同一个同步块内完成，中间不让出事件循环，因此不会双重消费。
    // [失败路径] 引用不等或已被消费时返回 false，且不改 state，调用方可安全重试。
    // [契约] 只有持有同一对象引用的 Shell 才能消费，这是防止跨任务误吞导航请求的唯一屏障。
    consumeFileManager: (target) => {
      if (get().pendingFileManagerTarget !== target) return false;
      set({ pendingFileManagerTarget: null });
      return true;
    },
    activeTabId: null,
    activeWorkspacePath: null,
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: new Set<string>(),

    // [契约] addTab 只有两条分支：命中已有 tab 则复用并激活，未命中则新建并置顶。
    // [并发] 查重与写入不在同一原子内，但 store 同步执行且无 await，单线程下等价原子。
    // [契约] 复用分支必须同时刷新 active* 与展开态，否则会出现“激活了但侧栏折叠”的不自洽。
    addTab: (workspacePath: string, options) => {
      // 之前复用 tab 只按 workspacePath + history/session 片段判断，
      // 同路径不同远端（例如 10.0.0.1:/home/dev 与 10.0.0.2:/home/dev）会被当成一个 tab。
      // 这里优先按 workspaceIdentity（authority + canonicalPath）匹配，路径只作为最后兜底。
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        const merged = mergeWorkspaceTabOptions(existing, options);
        persistWorkspaceExpandedPreference(
          resolveWorkspaceKey({
            ...existing,
            workspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity,
          }),
          true,
          storage,
        );
        set((state) => ({
          // 远程 workspace 手动重连成功后会再次走 addTab，
          // 但这里之前命中已有 tab 只做激活，不把新的 remoteSessionId 等元数据写回旧 tab。
          // 结果 UI 仍然读到“remoteSessionId 还没更新”的旧状态，
          // reconnect 按钮就会一直显示，像是还没连上。这里在复用 tab 时同步覆盖远程会话字段。
          tabs:
            merged === existing
              ? state.tabs
              // [资源] 引用稳定：merged === existing 时直接复用 state.tabs，不产生新数组。
              // [事务] 有变更时只替换目标元素，其余 tab 原样保留，保证 React 侧按 id 订阅不受影响。
              // [失败路径] 若 merged 丢了 id 字段，这里会静默不替换；id 由 mergeWorkspaceTabOptions 的展开保证。
              : state.tabs.map((tab) => (tab.id === existing.id ? merged : tab)),
          activeTabId: existing.id,
          activeWorkspacePath: existing.workspacePath,
          // Settings 页的插件管理要按“最近激活 workspace”的 identity 继续命中同一远端。
          // 之前这里只保存路径，切到 settings tab 后 identity 会丢失，导致同路径远端隔离失效。
          // [契约] identity 优先取本次 options：重连后 identity 换代必须立刻反映到 active 投影。
          // 没有新值时保留旧 identity，而不是退回路径，避免 Settings 页按路径误命中另一个远端。
          // [权衡] 这里只投影不校验，identity 是否有效由调用方与 Host 保证。
          activeWorkspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity ?? null,
          expandedWorkspacePaths: ensureWorkspaceExpanded(
            state.expandedWorkspacePaths,
            resolveWorkspaceKey({
              ...existing,
              workspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity,
            }),
          ),
        }));
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(resolveWorkspaceKey(tab), true, storage);
      set((state) => ({
        // 左侧 workspace 列表现在支持手动排序，但新打开项目仍然默认追加到底部，
        // 连续开新项目时最新 workspace 总要滚到下面找，和侧栏“最新上下文优先”的浏览方式不一致。
        // 这里改成把新 workspace 插到最前面，让新打开的项目直接出现在列表顶部。
        tabs: [tab, ...state.tabs],
        activeTabId: tab.id,
        activeWorkspacePath: workspacePath,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          resolveWorkspaceKey(tab),
        ),
      }));
      return tab.id;
    },

    ensureWorkspaceTab: (workspacePath: string, options) => {
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        persistWorkspaceExpandedPreference(
          resolveWorkspaceKey({
            ...existing,
            workspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity,
          }),
          true,
          storage,
        );
        set((state) => {
          // [契约] ensure 不改变焦点，但当命中的就是当前（或最近）workspace 时必须同步 active identity。
          // [并发] 判定基于 set 回调内的最新 state，而不是函数入口的快照，避免与并行激活交错。
          // [权衡] 两个条件取或：activeTabId 命中覆盖“当前指向该 tab”，路径+identity 命中覆盖“刚关闭后暂留的投影”。
          const rekeysActiveWorkspace =
            state.activeTabId === existing.id ||
            (state.activeWorkspacePath === existing.workspacePath &&
              state.activeWorkspaceIdentity === existing.workspaceIdentity);
          return {
            tabs: state.tabs.map((tab) =>
              tab.id !== existing.id || !isWorkspaceTab(tab)
                ? tab
                : mergeWorkspaceTabOptions(tab, options),
            ),
            // Bug 原因：stable identity 原地 rekey 只更新了 tab，activeWorkspaceIdentity
            // 仍保留 legacy route key，当前或最近焦点会继续按旧 scope 查询任务与服务。
            // ensure 不改变焦点，但必须让 active workspace identity 与 tab 本体原子一致。
            // [事务] tab 本体与 active identity 在同一次 set 内更新，读者看不到“tab 已换、投影还旧”的中间态。
            // [契约] 不命中时原样返回 state.activeWorkspaceIdentity，保证 ensure 的“不抢焦点”语义。
            // [失败路径] 取不到新 identity 时落 null 而非旧值，避免把过期 scope 继续带给任务查询。
            activeWorkspaceIdentity: rekeysActiveWorkspace
              ? (options?.workspaceIdentity ?? existing.workspaceIdentity ?? null)
              : state.activeWorkspaceIdentity,
            expandedWorkspacePaths: ensureWorkspaceExpanded(
              state.expandedWorkspacePaths,
              resolveWorkspaceKey({
                ...existing,
                workspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity,
              }),
            ),
          };
        });
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(resolveWorkspaceKey(tab), true, storage);
      set((state) => ({
        // Bugfix: Claude 历史导入可能把任务写入一个“当前窗口从未打开过”的 workspace。
        // 项目树的行集合来自 Host readProjects，不依赖 tab；但导入目录若没有 tab，本窗口就没有
        // 可导航到它的入口。这里补一个仅确保可见的入口，不打断用户当前正在看的 tab / settings 上下文。
        tabs: [tab, ...state.tabs],
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          resolveWorkspaceKey(tab),
        ),
      }));
      return tab.id;
    },

    lastClosedWorkspaceEvent: null,

    closeTab: (tabId: TabId, origin = "user-close") => {
      const stateBefore = get();
      const { tabs, activeTabId } = stateBefore;
      // [契约] 关闭以 id 定位，不按路径：同路径可能存在本地与多个远端 tab。
      // [事务] 先取 stateBefore 快照，再一次性构造 nextState，最后单次 set；中途不二次 get。
      // [资源] 关闭本身不释放会话，只发事件由上层决定，避免 store 承担资源生命周期。
      const index = tabs.findIndex((t) => t.id === tabId);
      // [失败路径] id 已不存在时静默返回，closeTab 天然幂等，双击关闭或恢复期重复调用都不破坏状态。
      // [契约] 这里不补发 lastClosedWorkspaceEvent，避免上层对不存在的 workspace 做二次清理。
      if (index === -1) {
        return;
      }

      const closingTab = tabs[index] ?? null;
      const newTabs = tabs.filter((t) => t.id !== tabId);
      const closedWorkspaceKey =
        closingTab && isWorkspaceTab(closingTab)
          ? closingTab.workspaceIdentity?.trim() ||
            (closingTab.remoteSessionId || closingTab.remoteTarget
              ? closingTab.workspacePath
              : null)
          : null;

      // 如果关闭的是当前激活的 tab，需要切换到相邻 tab
      // [契约] 关闭非激活 tab 时 active 完全不动，这是“关后台不打断用户”的核心保证。
      // [契约] 关闭激活 tab 时右邻接替，末位取左邻，用 min(index, len-1) 一步完成。
      // [并发] 接替项从过滤后的 newTabs 计算，绝不会选中刚被关闭的 id。
      let newActiveTabId = activeTabId;
      if (activeTabId === tabId) {
        // [契约] 关闭窗口内最后一个 tab 是唯一允许 activeTabId 变 null 的路径，不制造替代 tab。
        // [契约] activeWorkspacePath/Identity 仍保留关闭前的值，供设置页与下次打开沿用。
        // [权衡] 保留“最近 workspace”而非清空，代价是投影不等于事实；换取关完后设置页仍有远端 scope。
        if (newTabs.length === 0) {
          newActiveTabId = null;
        } else {
          // 优先激活右边的 tab，如果是最后一个则激活左边
          const newIndex = Math.min(index, newTabs.length - 1);
          newActiveTabId = newTabs[newIndex]!.id;
        }
      }

      const nextWorkspaceTab = newTabs.find((tab) => tab.id === newActiveTabId);
      // [契约] 兜底顺序：新激活 tab（若是 workspace）→ 剩余任意 workspace → 关闭前投影。
      // [契约] 关闭设置页时 closingTab 不是 workspace，直接沿用 stateBefore 投影，不误清 workspace。
      // [并发] 全部基于本次快照推导，不二次 get()，避免与并发 set 交叉产生两份事实。
      const fallbackWorkspacePath = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspacePath;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspacePath ?? null;
        }

        return stateBefore.activeWorkspacePath;
      })();
      const fallbackWorkspaceIdentity = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspaceIdentity ?? null;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspaceIdentity ?? null;
        }

        return stateBefore.activeWorkspaceIdentity;
      })();

      const nextState = {
        tabs: newTabs,
        activeTabId: newActiveTabId,
        activeWorkspacePath: fallbackWorkspacePath,
        activeWorkspaceIdentity: fallbackWorkspaceIdentity,
        expandedWorkspacePaths: (() => {
          const prunedExpandedWorkspacePaths =
            closingTab && isWorkspaceTab(closingTab)
              ? pruneExpandedWorkspace(
                  stateBefore.expandedWorkspacePaths,
                  resolveWorkspaceKey(closingTab),
                )
              : stateBefore.expandedWorkspacePaths;

          // 关闭当前 workspace 后，主内容会自动切到相邻 tab。
          // 之前侧边栏把展开态放在组件本地状态时，会在 workspacePath 变化后顺手把接替项展开；
          // 现在改由 store 托管后，这个兜底也要一起搬过来，否则“关闭当前 tab”会留下一个已激活但折叠的 workspace。
          return fallbackWorkspacePath
            ? ensureWorkspaceExpanded(
                prunedExpandedWorkspacePaths,
                fallbackWorkspaceIdentity?.trim() || fallbackWorkspacePath,
              )
            : prunedExpandedWorkspacePaths;
        })(),
      };

      if (fallbackWorkspacePath) {
        persistWorkspaceExpandedPreference(
          fallbackWorkspaceIdentity?.trim() || fallbackWorkspacePath,
          true,
          storage,
        );
      }

      set(nextState);
      // [事务] 状态落盘与事件发布分两次 set：先保证 tabs 一致，再追加序列号，读方看到事件时标签已就绪。
      // [并发] 序列号取自 updater 内最新 state，绝不用入口快照，防止并发关闭产生重复 sequence。
      // [契约] 只有带 identity 或远端会话的 workspace 才有 key，本地无远端时关闭不发事件。
      if (closedWorkspaceKey) {
        set((state) => ({
          lastClosedWorkspaceEvent: {
            sequence: (state.lastClosedWorkspaceEvent?.sequence ?? 0) + 1,
            workspaceKey: closedWorkspaceKey,
            origin,
          },
        }));
      }
    },

    activateTab: (tabId: TabId) => {
      const stateBefore = get();
      // [契约] 激活只改 active* 与展开态，不动 tabs 顺序，保证用户排序不被点击打乱。
      // [失败路径] id 不存在时直接返回，不把 active 清空，避免失效点击造成白屏。
      // [事务] 展开态持久化在 set 之前完成，落盘失败也不阻断内存激活。
      const tab = stateBefore.tabs.find((t) => t.id === tabId);
      if (!tab) {
        return;
      }

      const nextState = {
        activeTabId: tabId,
        activeWorkspacePath: isWorkspaceTab(tab)
          ? tab.workspacePath
          : stateBefore.activeWorkspacePath,
        activeWorkspaceIdentity: isWorkspaceTab(tab)
          ? (tab.workspaceIdentity ?? null)
          : stateBefore.activeWorkspaceIdentity,
        expandedWorkspacePaths: isWorkspaceTab(tab)
          ? ensureWorkspaceExpanded(stateBefore.expandedWorkspacePaths, resolveWorkspaceKey(tab))
          : stateBefore.expandedWorkspacePaths,
      };

      if (isWorkspaceTab(tab)) {
        persistWorkspaceExpandedPreference(resolveWorkspaceKey(tab), true, storage);
      }

      set(nextState);
    },

    // [契约] 全量重排面向包含设置页的完整列表，索引语义与 UI 拖拽一致。
    // [失败路径] 越界或同位置返回原 state 引用，不产生新数组，避免无意义重渲染。
    // [并发] 边界校验读的是 updater 内最新 tabs 长度，不是渲染时的长度。
    reorderTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= state.tabs.length ||
          toIndex >= state.tabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const newTabs = moveItem(state.tabs, fromIndex, toIndex);
        return { tabs: newTabs };
      });
    },

    // [契约] 只重排 workspace 子序列，设置页占用的槽位保持原位，因此两个索引都相对 workspace 列表。
    // [事务] 先把子序列重排好，再按原槽位回填，一次 set 完成，不出现空槽。
    // [失败路径] 越界校验基于 workspaceTabs 长度，与 reorderTabs 的语义刻意不同。
    // [资源] 非 workspace tab 原样返回引用，React 侧不会因其位置变化而重建。
    reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        const workspaceTabs = state.tabs.filter(isWorkspaceTab);
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= workspaceTabs.length ||
          toIndex >= workspaceTabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const reorderedWorkspaceTabs = moveItem(workspaceTabs, fromIndex, toIndex);
        let workspaceIndex = 0;
        const newTabs = state.tabs.map((tab) => {
          if (!isWorkspaceTab(tab)) {
            return tab;
          }

          return reorderedWorkspaceTabs[workspaceIndex++] ?? tab;
        });

        return { tabs: newTabs };
      });
    },

    // [契约] 窗口内唯一：已存在则只切换 activeTabId，不新建第二个设置页。
    // 新建时追加到末尾而非置顶，保持用户既有排序，也不抢 workspace 的展开态。
    // [失败路径] 这里不清空 active workspace 投影，设置页需要它继续查询当前远端。
    openSettingsTab: () => {
      const existing = get().tabs.find(isSettingsTab);
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }

      const settingsTab = createSettingsTab();
      set((state) => ({
        tabs: [...state.tabs, settingsTab],
        activeTabId: settingsTab.id,
      }));
    },

    // [契约] 入参是 identity key（已由调用方归一），store 不再二次拼接，避免两套规则。
    // [事务] 先复制 Set 再改，保持不可变更新；先落盘再返回新 state。
    // [权衡] 落盘不 await：展开是低价值偏好，失败时以内存为准。
    toggleWorkspaceExpanded: (path: string) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        const nextExpanded = !expandedWorkspacePaths.has(path);
        if (expandedWorkspacePaths.has(path)) {
          expandedWorkspacePaths.delete(path);
        } else {
          expandedWorkspacePaths.add(path);
        }

        persistWorkspaceExpandedPreference(path, nextExpanded, storage);

        return { expandedWorkspacePaths };
      });
    },

    expandAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.add(path);
          persistWorkspaceExpandedPreference(path, true, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    collapseAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.delete(path);
          persistWorkspaceExpandedPreference(path, false, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    // [契约] 跨窗口 focus 只按路径找 tab；给了 identity 时必须精确相等，否则宁可找不到。
    // [失败路径] 找不到返回 false 且不改任何状态，调用方可据此回退到新建窗口。
    // [契约] 命中后同步展开并落盘，保证别的窗口跳转过来看到的是展开的任务区。
    activateTabByPath: (path: string, options) => {
      const stateBefore = get();
      const tab = stateBefore.tabs.find((currentTab): currentTab is WorkspaceTabState => {
        if (!isWorkspaceTab(currentTab) || currentTab.workspacePath !== path) {
          return false;
        }

        if (options?.workspaceIdentity) {
          return currentTab.workspaceIdentity === options.workspaceIdentity;
        }

        return true;
      });
      if (!tab) {
        return false;
      }

      const nextState = {
        activeTabId: tab.id,
        activeWorkspacePath: path,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          stateBefore.expandedWorkspacePaths,
          resolveWorkspaceKey(tab),
        ),
      };

      persistWorkspaceExpandedPreference(resolveWorkspaceKey(tab), true, storage);

      set(nextState);
      return true;
    },

    // [契约] 启动恢复是替换式写入：tabs 整体重建、id 全新，随后 completeTabRestore 只做增量补齐。
    // [事务] active 下标先夹到合法区间，再取 tab 并标记 restorePaneSession，消费后即失效。
    // [资源] 展开态从 storage 一次读出后整体投影，不逐条写回，减少启动期 IO。
    restoreTabs: (tabsInput, activeIndex: number) => {
      if (tabsInput.length === 0) return;
      const tabs = tabsInput.map((tab) => {
        const normalized = normalizeRestorableWorkspaceTab(tab);
        return createWorkspaceTab(normalized.workspacePath, {
          remoteSessionId: normalized.remoteSessionId,
          remoteTarget: normalized.remoteTarget,
          workspaceIdentity: normalized.workspaceIdentity,
          workspacePurpose: normalized.workspacePurpose,
          availability: normalized.availability,
        });
      });
      const safeIndex = Math.min(Math.max(activeIndex, 0), tabs.length - 1);
      const activeWorkspaceTab = tabs[safeIndex];
      if (!activeWorkspaceTab || !isWorkspaceTab(activeWorkspaceTab)) {
        return;
      }
      activeWorkspaceTab.restorePaneSession = true;
      const expansionState: WorkspaceExpansionState = readWorkspaceExpansionState(storage);
      set({
        tabs,
        activeTabId: activeWorkspaceTab.id,
        activeWorkspacePath: activeWorkspaceTab.workspacePath,
        activeWorkspaceIdentity: activeWorkspaceTab.workspaceIdentity ?? null,
        expandedWorkspacePaths: resolveExpandedWorkspacePaths(
          tabs.map(resolveWorkspaceKey),
          expansionState,
        ),
      });
    },

    // [契约] 第二阶段只合并缺失 tab，并显式保留当前 active 与投影，不重建已有 id。
    // [契约] 排列顺序为：首帧后新增的 workspace → 补全的持久化 tab → 非 workspace tab。
    // [并发] 全部逻辑在 set updater 内基于最新 state 执行，用户在此期间新开的 tab 不会被覆盖。
    completeTabRestore: (tabsInput) => {
      if (tabsInput.length === 0) return;
      set((state) => {
        // [契约] consumed 集合保证一个已有 tab 只被一个持久化条目认领，避免重复条目吃同一个 tab。
        // [事务] 认领与合并按输入顺序推进、先到先得，后续同 identity 条目退化为新建。
        // [契约] isSameWorkspaceTab 复用与 addTab 完全一致的匹配语义：identity 优先、路径兜底。
        const consumedTabIds = new Set<TabId>();
        const completedTabs = tabsInput.map((tabInput) => {
          const normalized = normalizeRestorableWorkspaceTab(tabInput);
          const options: WorkspaceTabOptions = {
            remoteSessionId: normalized.remoteSessionId,
            remoteTarget: normalized.remoteTarget,
            workspaceIdentity: normalized.workspaceIdentity,
            localWorkspacePath: normalized.localWorkspacePath,
            workspacePurpose: normalized.workspacePurpose,
            availability: normalized.availability,
          };
          const existing = state.tabs.find(
            (tab): tab is WorkspaceTabState =>
              isWorkspaceTab(tab) &&
              !consumedTabIds.has(tab.id) &&
              isSameWorkspaceTab(tab, normalized.workspacePath, options),
          );
          if (existing) {
            consumedTabIds.add(existing.id);
            return mergeWorkspaceTabOptions(existing, options);
          }
          return createWorkspaceTab(normalized.workspacePath, options);
        });
        const extraWorkspaceTabs = state.tabs.filter(
          (tab): tab is WorkspaceTabState => isWorkspaceTab(tab) && !consumedTabIds.has(tab.id),
        );
        const nonWorkspaceTabs = state.tabs.filter((tab) => !isWorkspaceTab(tab));
        const tabs = [...extraWorkspaceTabs, ...completedTabs, ...nonWorkspaceTabs];
        // [资源] 补齐阶段再读一次 storage，是为了拿到首帧期间用户手动展开/收起后的最新偏好。
        // [契约] 只投影 workspace tab 的 key，设置页不参与展开态。
        const expansionState = readWorkspaceExpansionState(storage);

        // active-first 的第二阶段若再次调用 restoreTabs，会重建 active tab id，
        // 让已经挂载的会话视图丢失 identity；用户在首帧后新开的 tab 也会被覆盖。
        // 补齐阶段只合并缺失 tab，明确保留当前焦点和 active workspace 投影。
        return {
          tabs,
          activeTabId: state.activeTabId,
          activeWorkspacePath: state.activeWorkspacePath,
          activeWorkspaceIdentity: state.activeWorkspaceIdentity,
          expandedWorkspacePaths: resolveExpandedWorkspacePaths(
            tabs.filter(isWorkspaceTab).map(resolveWorkspaceKey),
            expansionState,
          ),
        };
      });
    },
  }));
}

export type TabStore = ReturnType<typeof createTabStore>;
