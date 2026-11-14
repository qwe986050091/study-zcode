/* oxlint-disable eslint(max-lines) -- session workbench group 先把纯模型、localStorage sanitize 和 Zustand 装配收口在一处，避免新功能初版跨文件追状态；后续扩展测试稳定后再拆分。 */
// v4 session workbench groups。
// 这里是 renderer-local 壳子状态：只管 session 到 pane/group 的归属与本地持久化，
// 不下沉到协议、agent、main process 或 web-remote replayable 状态。
// 文件头：v4 session workbench group 的 renderer-local 状态壳。
// 职责：session → pane/group 归属、分屏树投影、localStorage 持久化与恢复清理。
// 边界：不含协议/agent 事实、main 编排、remote replay 队列、会话生命周期。
//
// 不变量（INV）：
// INV-01 断言：web-remote-replayable 模式下 store 永不读写 localStorage。
// 守护：workbenchGroupsEnabled() 在 configureClientMode / persist / read 三处前置判断。
// 改错故障：远端会凭空恢复本地 group，并把隐藏态回写覆盖桌面快照。
// INV-02 断言：一个 session key 全局只属于一个 group（sessionIndex 唯一）。
// 守护：splitSessionIntoSnapshot 早期 return、promote 的 Set(size) 去重、bindPaneSession 换绑检查。
// 改错故障：同一 session 出现在两个 group，输入双写、关闭一个 pane 影响另一个。
// INV-03 断言：group 至少 2 个 pane，否则壳子必须解散为 null。
// 守护：closeWorkbenchGroupPane 与 sanitizeWorkbenchGroup 的 countPanes<2 分支。
// 改错故障：刷新后留下“假分屏”，focusedPaneId 指向不存在的 pane。
// INV-04 断言：primary pane 永不被 closePane 删除。
// 守护：closeWorkbenchGroupPane 首行 paneId===V4_PRIMARY_PANE_ID 直接返回 null。
// 改错故障：primaryBinding 失去归属，其余 pane 无法推导新的 primary。
// INV-05 断言：restoredUnvalidated 只存在于内存，绝不写回持久 schema。
// 守护：persistWorkbenchGroups 解构剔除该字段；sanitizeBinding 恢复时置 true。
// 改错故障：持久层出现半验证态字段，下次恢复跳过 sessions-index 校验。
// INV-06 断言：panes 的键集合必须与 root 的 leaf 集合一致（primary 除外）。
// 守护：sanitizeWorkbenchGroup 按 leafIds 遍历，而不是按 rawPanes 遍历。
// 改错故障：脏数据残留孤立 binding，或 leaf 缺 binding 时渲染空 pane。
// INV-07 断言：所有变更都是不可变替换，对象身份用于短路订阅通知。
// 守护：各 reducer 的 next === group ? state : replaceGroup(...) 比较。
// 改错故障：原地 mutate 导致 Zustand 不通知，UI 停留在旧树。
// INV-08 断言：sessionIndex 只能由 rebuildSessionIndex 从 groups 全量重建。
// 守护：replaceGroup/removeGroup 都整体重算，不做增量补丁。
// 改错故障：增量维护遗漏删除，索引指向已解散 group。
// INV-09 断言：split ratio 必须落在合法区间。
// 守护：sanitizePaneLayoutNode 使用 clampSplitRatio，setSplitRatio 走树层校验。
// 改错故障：0 或 NaN 比例让布局塌陷成 0 宽度。
// INV-10 断言：setSplitRatio 只替换 root，不重建 binding 与 sessionIndex。
// 守护：setSplitRatio 用 {...group, root} 而非 createXxx 重建。
// 改错故障：拖拽分隔条时丢失 workspaceIdentity/remoteSessionId。
// INV-11 断言：持久化失败（配额/权限/隐私模式）不影响内存态。
// 守护：persistWorkbenchGroups 的 try/catch 与 safeStorage 的 null 返回。
// 改错故障：setItem 抛错冒泡进 subscribe，后续所有 store 更新被中断。
// INV-12 断言：JSON 解析失败等同“无持久数据”，不得抛给调用方。
// 守护：readPersistedWorkbenchGroups 的 try/catch 整体包裹。
// 改错故障：坏快照让 renderer 启动即崩。
// INV-13 断言：readOnly binding 在恢复时被整组丢弃。
// 守护：sanitizeBinding 遇到 readOnly===true 返回 null，进而 group 返回 null。
// 改错故障：已迁到右侧 tabs 的 subagent 恢复后继续占用 4-pane workbench。
// INV-14 断言：focusedPaneId 必须落在 root 的 leaf 集合内。
// 守护：sanitizeWorkbenchGroup 用 uniqueLeafIds.has 校验，否则回落 primary。
// 改错故障：focusPane 失败，activeBinding 恒为 null。
// INV-15 断言：pane 数量上限由 MAX_WORKBENCH_PANES 统一约束。
// 守护：sanitizeWorkbenchGroup 的 leafIds.length 检查与 split 的 canAddPane。
// 改错故障：布局越界后无法排布，close 逻辑越界访问。
// INV-16 断言：hydrate 只在 desktop-continuous 首次 configure 时执行一次。
// 守护：desktopGroupsHydrated 标志，且切到 replayable 时重置为 false。
// 改错故障：重复 hydrate 用磁盘旧值覆盖用户当前操作。
// INV-17 断言：binding 相等性只看 (workspaceScope, sessionId)，不看只读/待验证标记。
// 守护：bindingSessionKey 与 sameSessionBinding 共用同一实现。
// 改错故障：同 session 因标记差异被当成两个 pane，触发重复打开。
// INV-18 断言：group id 单调递增且严格采用 group-<n> 格式。
// 守护：allocateGroupId 的 /^group-(\d+)$/ 解析与 sanitize 的 id 校验。
// 改错故障：id 碰撞覆盖既有 group，或非规范 id 让序号回退到 1。
import { create } from "zustand";
import type { ZCodeTaskClientMode } from "@zcode/shared";
import {
  INITIAL_PANE_LAYOUT,
  MAX_WORKBENCH_PANES,
  V4_PRIMARY_PANE_ID,
  canAddPane,
  clampSplitRatio,
  closePane,
  countPanes,
  focusPane,
  leafPaneIds,
  paneWorkspaceKey,
  setSplitNodeRatio,
  splitPaneAtSide,
  effectiveFocusedPaneId,
  type PaneBinding,
  type PaneLayoutSnapshot,
  type PaneLayoutNode,
  type PaneSplitSide,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutTree.js";

// [契约] 存储键带 :v1 后缀，schema 变更必须升版而不是原地改字段。
// 读方 sanitizePersistedWorkbenchGroups 对旧版本只做丢弃，不做迁移。
// 改成无版本键会让用户旧快照被新解析器误读。
export const WORKBENCH_GROUP_STORAGE_KEY = "zcode-v4-session-workbench-groups:v1";

// [契约] binding 只描述“哪个 workspace 的哪个 session”，不携带 UI 选中态。
// workspaceScope 是身份来源，sessionId 是运行时标识，两者缺一不可。
// 往这里加显示字段（标题/头像）会让持久化快照随 UI 漂移。
export interface WorkbenchSessionBinding {
  readonly workspaceScope: PaneWorkspaceScope;
  readonly sessionId: string;
  /** subagent 行内侧开的 child session 只读，不渲染 composer/input。 */
  // [权衡] readOnly 仅标记“subagent 行内打开的只读子会话”，不是权限系统。
  // 它只影响 composer/input 渲染与恢复时是否保留该 group。
  // 不要把它复用成通用“禁用交互”开关，权限判定在服务端。
  readonly readOnly?: boolean;
  /** 从持久化恢复、尚未经当前 scope sessions-index 验证。只存在于内存态。 */
  // [契约] 该标记只存在于内存，表示“从磁盘恢复但尚未经 sessions-index 校验”。
  // 唯一写入点是 sanitizeBinding，唯一清除点是 confirmRestoredWorkbenchGroupPane。
  // 写进 localStorage 等于跳过校验，属于 INV-05 违规。
  readonly restoredUnvalidated?: boolean;
}

// [契约] group 是分屏壳子的唯一事实来源：root 树 + pane binding + focused。
// primaryBinding 与 root 中 V4_PRIMARY_PANE_ID 的 leaf 是同一个逻辑 pane。
// panes 不含 primary，读取统一走 selectWorkbenchGroupPaneBinding。
export interface WorkbenchGroup {
  readonly id: string;
  readonly primaryBinding: WorkbenchSessionBinding;
  readonly root: PaneLayoutNode;
  readonly panes: Readonly<Record<string, WorkbenchSessionBinding>>;
  readonly focusedPaneId: string;
  readonly updatedAt: number;
}

// [契约] snapshot 是持久化单位，也是 Zustand state 的稳定子集。
// sessionIndex 是派生索引，必须与 groups 同步重建，不能单独维护。
// 新增字段要同步 persist/read/sanitize 三处，否则恢复时丢失。
export interface WorkbenchGroupSnapshot {
  readonly activeGroupId: string | null;
  readonly groups: Readonly<Record<string, WorkbenchGroup>>;
  readonly sessionIndex: Readonly<Record<string, string>>;
}

// [契约] 所有对外 action 返回 void 或 boolean，从不抛异常。
// 每个 action 首行先过 workbenchGroupsEnabled()，replayable 模式下静默 no-op。
// 调用方不要靠 action 抛错判定失败，改为读取 snapshot。
export interface WorkbenchGroupStore extends WorkbenchGroupSnapshot {
  configureClientMode: (clientMode: ZCodeTaskClientMode) => void;
  openSessionFromSidebar: (binding: WorkbenchSessionBinding) => void;
  splitSessionIntoGroup: (
    anchorPaneId: string,
    side: PaneSplitSide,
    binding: WorkbenchSessionBinding,
    fallbackPrimaryBinding?: WorkbenchSessionBinding,
  ) => void;
  promotePaneLayoutToGroup: (
    primaryBinding: WorkbenchSessionBinding,
    layout: PaneLayoutSnapshot,
  ) => boolean;
  focusPane: (groupId: string, paneId: string) => void;
  closePane: (groupId: string, paneId: string) => void;
  confirmRestoredPaneSession: (groupId: string, paneId: string) => void;
  bindPaneSession: (groupId: string, paneId: string, sessionId: string) => void;
  setSplitRatio: (groupId: string, splitId: string, ratio: number) => void;
  isSessionGrouped: (scope: PaneWorkspaceScope, sessionId: string | null | undefined) => boolean;
  getActiveContext: () => WorkbenchSessionBinding | null;
  deactivateActiveGroup: () => void;
  resetWorkbenchGroups: () => void;
}

// [并发] 该对象被 set 复用为“清空”动作，必须视为只读常量。
// 任何就地修改会污染所有后续 reset 与 remote 模式清理。
// 需要初始态请展开复制，不要直接持有 `initialState` 引用。
export const INITIAL_WORKBENCH_GROUP_STATE: WorkbenchGroupSnapshot = {
  activeGroupId: null,
  groups: {},
  sessionIndex: {},
};

// [契约] 模块级 clientMode 是 gate 的唯一来源，默认 desktop-continuous。
// 它在 configureClientMode 里先于 set() 赋值，保证清理动作本身不触盘。
// 不要在 action 内另读环境变量替代它，会造成同进程双口径。
let workbenchGroupClientMode: ZCodeTaskClientMode = "desktop-continuous";
// [并发] 单次 hydrate 闸门：防止重复 configure 用磁盘旧值覆盖当前内存。
// 切到 replayable 时必须重置为 false，否则切回 desktop 不会重新恢复。
// 它与 clientMode 共同构成配置状态机，改动需成对进行。
let desktopGroupsHydrated = false;

// [契约] 唯一 gate 函数；返回 false 时 store 既不读也不写 localStorage。
// 用“!== replayable”而不是“=== desktop-continuous”，未知模式仍启用。
// 新增模式时要显式决定是否进入 `PERSISTED_MODES` 链路。
function workbenchGroupsEnabled(): boolean {
  // [失败路径] replayable 下返回 false，所有 action 退化为 no-op。
  // 这是 INV-01 的执行点，删除会让手机远控写入桌面本地快照。
  // 不要在此加 localStorage 探测，探测本身在隐私模式下可能抛错。
  return workbenchGroupClientMode !== "web-remote-replayable";
}

// [契约] session key = paneWorkspaceKey(scope) + "::" + sessionId。
// 身份以 workspaceIdentity 优先、workspacePath 兜底，由 paneWorkspaceKey 统一。
// 任何地方手拼 key 都会与 sessionIndex 不一致，必须复用本函数。
export function buildWorkbenchSessionKey(scope: PaneWorkspaceScope, sessionId: string): string {
  return `${paneWorkspaceKey(scope)}::${sessionId}`;
}

// [契约] binding 相等性只看 (scope, sessionId)，readOnly/restored 不参与。
// 这保证“同一 session 只出现一次”在内存与磁盘两侧口径一致。
// 改这里会同时改变去重与索引语义，属于高风险改动。
function bindingSessionKey(binding: WorkbenchSessionBinding): string {
  return buildWorkbenchSessionKey(binding.workspaceScope, binding.sessionId);
}

// [契约] 用 key 比较代替字段比较，避免标记差异造成“伪不同”。
// 用于 findWorkbenchGroupPaneId 与分屏重复插入防护。
// 不要改成比较对象引用，binding 每次替换都是新对象。
function sameSessionBinding(a: WorkbenchSessionBinding, b: WorkbenchSessionBinding): boolean {
  return bindingSessionKey(a) === bindingSessionKey(b);
}

// [契约] 把 store binding 投影成树层 PaneBinding，只透传已有可选标记。
// 用条件展开保留 undefined 语义，避免写入 readOnly:false 污染判等。
// 树层不认识的 UI 字段一律不往下传。
function paneBinding(binding: WorkbenchSessionBinding): PaneBinding {
  return {
    workspaceScope: binding.workspaceScope,
    sessionId: binding.sessionId,
    ...(binding.readOnly ? { readOnly: true } : {}),
    ...(binding.restoredUnvalidated ? { restoredUnvalidated: true } : {}),
  };
}

// [失败路径] sessionId 非字符串时返回 null，调用方必须跳过而非降级。
// 空 pane 在树层合法，在 group 层不合法（INV-06）。
// 不要为 null 造占位 session，会让索引出现假条目。
function workbenchBinding(binding: PaneBinding): WorkbenchSessionBinding | null {
  return typeof binding.sessionId === "string"
    ? {
        workspaceScope: binding.workspaceScope,
        sessionId: binding.sessionId,
        ...(binding.readOnly ? { readOnly: true } : {}),
        ...(binding.restoredUnvalidated
          ? { restoredUnvalidated: true }
          : {}),
      }
    : null;
}

// [契约] 顺序固定为 primary 在前、panes 按 Object.values 顺序。
// 该顺序被 rebuildSessionIndex 与持久化去重依赖，不要改成 Set。
// 同 key 重复出现属于脏数据，由 promote 的 Set(size) 检查兜住。
function groupSessionBindings(group: WorkbenchGroup): WorkbenchSessionBinding[] {
  return [group.primaryBinding, ...Object.values(group.panes)];
}

// [契约] 用于分屏前判重：已在 group 内的 session 不得再次分屏。
// 比较走 bindingSessionKey，忽略 readOnly 差异。
// 去掉这层会把同一 session 插入两个 pane，产生双份订阅。
function groupContainsBinding(group: WorkbenchGroup, binding: WorkbenchSessionBinding): boolean {
  const key = bindingSessionKey(binding);
  return groupSessionBindings(group).some((candidate) => bindingSessionKey(candidate) === key);
}

// [契约] primary pane 的 binding 存在 group.primaryBinding，不在 panes 里。
// 读取顺序固定，禁止两处都存，否则出现两个真相。
// 返回 null 表示 paneId 不属于该 group，调用方需处理。
export function selectWorkbenchGroupPaneBinding(
  group: WorkbenchGroup,
  paneId: string,
): WorkbenchSessionBinding | null {
  if (paneId === V4_PRIMARY_PANE_ID) {
    return group.primaryBinding;
  }
  // [失败路径] panes 缺失即返回 null，不做 primary 兜底。
  // 兜底会让“已关闭 pane”的旧 id 静默指向 primary。
  // 上游以 null 判定 pane 失效并解散 group。
  return group.panes[paneId] ?? null;
}

// [契约] active binding = focusedPaneId 对应的 pane binding。
// focusedPaneId 已由 sanitize 与焦点函数保证落在 leaf 集合内。
// 若返回 null 说明状态被外部篡改，不在此函数内做修复。
export function selectWorkbenchGroupActiveBinding(
  group: WorkbenchGroup,
): WorkbenchSessionBinding | null {
  return selectWorkbenchGroupPaneBinding(group, group.focusedPaneId);
}

// [契约] 反查 binding 所在 pane：先 primary，再遍历 panes。
// 返回 null 表示该 binding 不在此 group，调用方不得假定存在。
// 遍历顺序影响多 pane 同 session 脏数据下的结果，正常态不应出现。
function findWorkbenchGroupPaneId(
  group: WorkbenchGroup,
  binding: WorkbenchSessionBinding,
): string | null {
  if (sameSessionBinding(group.primaryBinding, binding)) {
    return V4_PRIMARY_PANE_ID;
  }
  for (const [paneId, candidate] of Object.entries(group.panes)) {
    if (sameSessionBinding(candidate, binding)) {
      return paneId;
    }
  }
  return null;
}

// [契约] 分配 group-<max+1>，只认规范 id，其它 id 不参与序号计算。
// 删除中间 group 后序号不回退，避免复用旧 id 命中残留引用。
// 与 sanitize 的 id 校验配套，非规范 id 恢复后保留但不再生成。
function allocateGroupId(groups: Readonly<Record<string, WorkbenchGroup>>): string {
  let max = 0;
  for (const id of Object.keys(groups)) {
    // [契约] 严格匹配 group-<数字>；group-1a、Group-1 都不计入 max。
    // 这条正则就是 id 命名规范的可执行定义，改动需同步 sanitize。
    // 解析失败静默跳过，不抛错，保证脏 key 不影响分配。
    const match = /^group-(\d+)$/.exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `group-${max + 1}`;
}

// [契约] 从两个 session 与方向构造新 group，id/updatedAt 可注入（测试用）。
// 内部先 splitPaneAtSide(INITIAL_PANE_LAYOUT, primary, side, added)。
// 该函数不查 sessionIndex，查重责任在 splitSessionIntoSnapshot。
export function createWorkbenchGroupFromSessions(
  primary: WorkbenchSessionBinding,
  added: WorkbenchSessionBinding,
  side: PaneSplitSide,
  options: { readonly id?: string; readonly updatedAt?: number } = {},
): WorkbenchGroup {
  // [契约] 新 group 的树永远从 INITIAL_PANE_LAYOUT 起，primary 固定一侧。
  // side 决定 added 落在 primary 的哪边，影响初始 focusedPaneId。
  // 不要复用当前 active group 的树，那会继承无关 pane。
  const split = splitPaneAtSide(INITIAL_PANE_LAYOUT, V4_PRIMARY_PANE_ID, side, paneBinding(added));
  const panes: Record<string, WorkbenchSessionBinding> = {};
  for (const [paneId, binding] of Object.entries(split.panes)) {
    const converted = workbenchBinding(binding);
    if (converted) {
      panes[paneId] = converted;
    }
  }
  return {
    id: options.id ?? "group-1",
    primaryBinding: primary,
    root: split.root,
    panes,
    focusedPaneId: split.focusedPaneId,
    updatedAt: options.updatedAt ?? Date.now(),
  };
}

// [失败路径] leaf 少于 2 或不含 primary 时返回 null，调用方保持原 state。
// 用于把已有 paneLayout 快照提升为 group，每个非 primary leaf 都要有 binding。
// 任一 leaf 缺 binding 即整体失败，不做部分提升。
function createWorkbenchGroupFromPaneLayout(
  primary: WorkbenchSessionBinding,
  layout: PaneLayoutSnapshot,
  options: { readonly id?: string; readonly updatedAt?: number } = {},
): WorkbenchGroup | null {
  // [契约] leaf 集合是 panes 键集合的唯一来源（INV-06）。
  // 按 leaf 遍历而不是按 layout.panes 遍历，可自动丢弃孤立 binding。
  // 顺序由树的中序遍历决定，持久化后仍可复现。
  const leafIds = leafPaneIds(layout.root);
  if (leafIds.length < 2 || !leafIds.includes(V4_PRIMARY_PANE_ID)) {
    return null;
  }

  const panes: Record<string, WorkbenchSessionBinding> = {};
  for (const paneId of leafIds) {
    if (paneId === V4_PRIMARY_PANE_ID) {
      continue;
    }
    const binding = layout.panes[paneId];
    const converted = binding ? workbenchBinding(binding) : null;
    if (!converted) {
      return null;
    }
    panes[paneId] = converted;
  }

  return {
    id: options.id ?? "group-1",
    primaryBinding: primary,
    root: layout.root,
    panes,
    focusedPaneId: effectiveFocusedPaneId(layout),
    updatedAt: options.updatedAt ?? Date.now(),
  };
}

// [契约] 切换 focused pane；无效 paneId 时返回原对象以支持身份短路。
// 只有真正变化才更新 updatedAt，避免无意义持久化写盘。
// 调用方用 === 比较 snapshot 引用，不要深比较。
export function focusWorkbenchGroupPane(
  group: WorkbenchGroup,
  paneId: string,
  updatedAt = Date.now(),
): WorkbenchGroup {
  const focused = focusPane(group, paneId);
  return focused === group ? group : { ...group, focusedPaneId: focused.focusedPaneId, updatedAt };
}

// [失败路径] 已包含该 binding 或超过 MAX_WORKBENCH_PANES 时原样返回。
// canAddPane 是上限的唯一判定，另起计数会与树层分叉。
// splitPaneAtSide 返回原对象同样视为无变化。
export function splitWorkbenchGroupPane(
  group: WorkbenchGroup,
  anchorPaneId: string,
  side: PaneSplitSide,
  binding: WorkbenchSessionBinding,
  updatedAt = Date.now(),
): WorkbenchGroup {
  // [失败路径] 双重前置：重复 session 与 pane 上限，任一命中即 no-op。
  // 这两条对应 INV-02 与 INV-15，删除任一都会产生非法树。
  // 不要在这里抛错，UI 拖拽路径需要幂等。
  if (groupContainsBinding(group, binding) || !canAddPane(group)) {
    return group;
  }
  const next = splitPaneAtSide(group, anchorPaneId, side, paneBinding(binding));
  if (next === group) {
    return group;
  }
  const panes: Record<string, WorkbenchSessionBinding> = {};
  for (const [paneId, candidate] of Object.entries(next.panes)) {
    const converted = workbenchBinding(candidate);
    if (converted) {
      panes[paneId] = converted;
    }
  }
  return {
    ...group,
    root: next.root,
    panes,
    focusedPaneId: next.focusedPaneId,
    updatedAt,
  };
}

// [事务] 关闭非 primary pane：先让树层 closePane，再按结果决定是否解散 group。
// 返回 null 表示壳子解散，调用方必须走 removeGroup 而不是替换。
// 返回相同引用表示无变化。
export function closeWorkbenchGroupPane(
  group: WorkbenchGroup,
  paneId: string,
  updatedAt = Date.now(),
): WorkbenchGroup | null {
  if (paneId === V4_PRIMARY_PANE_ID) {
    // primary 被删除时没有稳定的“提升谁为新的 primary”语义；直接解散壳子，让剩余 session 走普通打开路径。
    return null;
  }
  const next = closePane(group, paneId);
  if (next === group) {
    return group;
  }
  const panes: Record<string, WorkbenchSessionBinding> = {};
  for (const [nextPaneId, binding] of Object.entries(next.panes)) {
    const converted = workbenchBinding(binding);
    if (converted) {
      panes[nextPaneId] = converted;
    }
  }
  const candidate = {
    ...group,
    root: next.root,
    panes,
    focusedPaneId: next.focusedPaneId,
    updatedAt,
  };
  // 壳子只在 2 个及以上 session 时存在；退回单 session 后交还给普通打开路径。
  // [契约] 剩余 pane 少于 2 时解散壳子（INV-03）。
  // 单 session 退回普通打开路径，避免刷新后出现假分屏。
  // 阈值 2 与 sanitizeWorkbenchGroup 的检查必须保持一致。
  return countPanes(candidate) < 2 ? null : candidate;
}

// [契约] 清除某个 pane 的 restoredUnvalidated，表示 sessions-index 已确认。
// primary 与普通 pane 两条路径都要解构剔除该字段，不能只改一处。
// 返回原对象表示该 pane 本就无需确认。
export function confirmRestoredWorkbenchGroupPane(
  group: WorkbenchGroup,
  paneId: string,
): WorkbenchGroup {
  if (paneId === V4_PRIMARY_PANE_ID) {
    // [失败路径] 已是确认态直接返回，避免无意义对象替换触发重渲染。
    // 该判断是幂等性的关键：confirm 可能被多次调用。
    // 后续解构剔除字段只在未确认时执行，减少分配。
    if (!group.primaryBinding.restoredUnvalidated) {
      return group;
    }
    const { restoredUnvalidated: _restored, ...primaryBinding } =
      group.primaryBinding;
    return { ...group, primaryBinding };
  }
  const binding = group.panes[paneId];
  if (!binding?.restoredUnvalidated) {
    return group;
  }
  const { restoredUnvalidated: _restored, ...confirmed } = binding;
  return {
    ...group,
    panes: { ...group.panes, [paneId]: confirmed },
  };
}

// [契约] 由 groups 全量重建 key → groupId 索引（INV-08）。
// 每次 replace/remove 都整体重算，不做增量增删。
// 复杂度 O(pane 数)，规模受 MAX_WORKBENCH_PANES 限制。
function rebuildSessionIndex(
  groups: Readonly<Record<string, WorkbenchGroup>>,
): Record<string, string> {
  const index: Record<string, string> = {};
  for (const group of Object.values(groups)) {
    for (const binding of groupSessionBindings(group)) {
      index[bindingSessionKey(binding)] = group.id;
    }
  }
  return index;
}

// [契约] 写入或替换 group，并把 activeGroupId 指向它。
// groups 用展开复制，绝不 mutate 原 record。
// sessionIndex 始终由 rebuildSessionIndex 重算。
function replaceGroup(
  state: WorkbenchGroupSnapshot,
  group: WorkbenchGroup,
): WorkbenchGroupSnapshot {
  const groups = { ...state.groups, [group.id]: group };
  return {
    activeGroupId: group.id,
    groups,
    sessionIndex: rebuildSessionIndex(groups),
  };
}

// [契约] 删除 group 时同步重算索引，并在 activeGroupId 指向它时置 null。
// 不递归清理其它 group，因为 INV-02 保证 key 唯一。
// 若外部已越界出现重复 key，这里也不做修复。
function removeGroup(state: WorkbenchGroupSnapshot, groupId: string): WorkbenchGroupSnapshot {
  const groups = { ...state.groups };
  delete groups[groupId];
  return {
    activeGroupId: state.activeGroupId === groupId ? null : state.activeGroupId,
    groups,
    sessionIndex: rebuildSessionIndex(groups),
  };
}

// [事务] 分屏完整决策入口：查重 → 有 active group 则拆分 → 否则用 fallback 新建。
// 早期 sessionIndex[sessionKey] 命中即返回原 state，是 INV-02 的第一道闸。
// 新建分支还要求 fallback 与目标不同且未被占用。
function splitSessionIntoSnapshot(
  state: WorkbenchGroupSnapshot,
  anchorPaneId: string,
  side: PaneSplitSide,
  binding: WorkbenchSessionBinding,
  fallbackPrimaryBinding?: WorkbenchSessionBinding,
): WorkbenchGroupSnapshot {
  const sessionKey = bindingSessionKey(binding);
  // [失败路径] session 已属于任意 group 时直接放弃分屏。
  // 这里不看是否属于当前 group，避免同 session 被拖进另一个 group。
  // 返回原 state 保持引用相等，Zustand 不通知订阅者。
  if (state.sessionIndex[sessionKey]) {
    return state;
  }

  const activeGroup = state.activeGroupId ? state.groups[state.activeGroupId] : undefined;
  if (activeGroup) {
    const nextGroup = splitWorkbenchGroupPane(activeGroup, anchorPaneId, side, binding);
    return nextGroup === activeGroup ? state : replaceGroup(state, nextGroup);
  }

  if (
    !fallbackPrimaryBinding ||
    sameSessionBinding(fallbackPrimaryBinding, binding) ||
    state.sessionIndex[bindingSessionKey(fallbackPrimaryBinding)]
  ) {
    return state;
  }

  const group = createWorkbenchGroupFromSessions(fallbackPrimaryBinding, binding, side, {
    id: allocateGroupId(state.groups),
  });
  return replaceGroup(state, group);
}

// [事务] 把 paneLayout 提升为 group；失败返回原 state。
// 先构造 group，再做 key 唯一性与占用检查，最后 replaceGroup。
// 检查顺序保证失败时不产生半成品 groups。
function promotePaneLayoutToGroupSnapshot(
  state: WorkbenchGroupSnapshot,
  primaryBinding: WorkbenchSessionBinding,
  layout: PaneLayoutSnapshot,
): WorkbenchGroupSnapshot {
  const group = createWorkbenchGroupFromPaneLayout(primaryBinding, layout, {
    id: allocateGroupId(state.groups),
  });
  if (!group) {
    return state;
  }

  // [契约] 同时检查组内重复（Set.size）与跨组占用（sessionIndex）。
  // 两条都命中才放弃提升，判断不可短路成任一条。
  // 这是 INV-02 在 promote 路径上的唯一守点。
  const sessionKeys = groupSessionBindings(group).map(bindingSessionKey);
  if (
    new Set(sessionKeys).size !== sessionKeys.length ||
    sessionKeys.some((key) => Boolean(state.sessionIndex[key]))
  ) {
    return state;
  }

  return replaceGroup(state, group);
}

// [契约] sidebar 点击 session：已分组则激活并聚焦，未分组则清空 activeGroupId。
// 未分组时返回去掉 active 的新 state，让普通打开路径接管。
// 不在此创建 group，创建只发生在 splitSessionIntoGroup。
function focusSessionInSnapshot(
  state: WorkbenchGroupSnapshot,
  binding: WorkbenchSessionBinding,
): WorkbenchGroupSnapshot {
  const groupId = state.sessionIndex[bindingSessionKey(binding)];
  if (!groupId) {
    return state.activeGroupId === null ? state : { ...state, activeGroupId: null };
  }
  const group = state.groups[groupId];
  if (!group) {
    return { ...state, activeGroupId: null };
  }
  const paneId = findWorkbenchGroupPaneId(group, binding);
  if (!paneId) {
    return state;
  }
  const focused = focusWorkbenchGroupPane(group, paneId);
  return replaceGroup(
    {
      ...state,
      activeGroupId: groupId,
    },
    focused,
  );
}

// [契约] 把 pane 的 sessionId 换成另一个 session，保持 scope/readOnly 不变。
// 目标已属于其它 group、或同组其它 pane 时放弃（返回原 state）。
// 这是 INV-02 在换绑路径的守点。
function bindPaneSessionInSnapshot(
  state: WorkbenchGroupSnapshot,
  groupId: string,
  paneId: string,
  sessionId: string,
): WorkbenchGroupSnapshot {
  const group = state.groups[groupId];
  const binding = group ? selectWorkbenchGroupPaneBinding(group, paneId) : null;
  if (!group || !binding || binding.sessionId === sessionId) {
    return state;
  }

  const nextBinding: WorkbenchSessionBinding = {
    workspaceScope: binding.workspaceScope,
    sessionId,
    ...(binding.readOnly ? { readOnly: true } : {}),
  };
  const nextKey = bindingSessionKey(nextBinding);
  const existingGroupId = state.sessionIndex[nextKey];
  if (existingGroupId && existingGroupId !== groupId) {
    return state;
  }
  if (existingGroupId === groupId && !sameSessionBinding(binding, nextBinding)) {
    return state;
  }

  const nextGroup: WorkbenchGroup =
    paneId === V4_PRIMARY_PANE_ID
      ? { ...group, primaryBinding: nextBinding, updatedAt: Date.now() }
      : {
          ...group,
          panes: { ...group.panes, [paneId]: nextBinding },
          updatedAt: Date.now(),
        };
  return replaceGroup(state, nextGroup);
}

// [资源] localStorage 在隐私模式或沙箱下访问即抛错，必须包裹。
// 返回 null 表示无可用存储，调用方据此跳过持久化。
// 不要缓存结果到模块级，运行中权限可能变化。
function safeStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// [失败路径] 递归校验分屏树：类型/方向/子节点任一不合法即整树判废。
// ratio 统一走 clampSplitRatio，非法值收敛而不是丢弃整节点。
// leaf 只接受字符串 paneId，不补默认值。
function sanitizePaneLayoutNode(value: unknown): PaneLayoutNode | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  if (value.type === "leaf") {
    return typeof value.paneId === "string" ? { type: "leaf", paneId: value.paneId } : null;
  }
  if (value.type !== "split") {
    return null;
  }
  const first = sanitizePaneLayoutNode(value.first);
  const second = sanitizePaneLayoutNode(value.second);
  if (
    !first ||
    !second ||
    typeof value.id !== "string" ||
    (value.direction !== "row" && value.direction !== "column")
  ) {
    return null;
  }
  return {
    type: "split",
    id: value.id,
    direction: value.direction,
    ratio: clampSplitRatio(typeof value.ratio === "number" ? value.ratio : Number.NaN),
    first,
    second,
  };
}

// [契约] 只接受含 workspacePath 字符串的 scope，identity/remoteSessionId 可选。
// 这三个字段决定身份 key，缺失或类型错会被上游判为不可恢复。
// 不做路径归一化，归一化属于 paneWorkspaceKey 的职责。
function sanitizeWorkspaceScope(value: unknown): PaneWorkspaceScope | null {
  if (!isRecord(value) || typeof value.workspacePath !== "string") {
    return null;
  }
  return {
    workspacePath: value.workspacePath,
    workspaceIdentity:
      typeof value.workspaceIdentity === "string" ? value.workspaceIdentity : undefined,
    remoteSessionId: typeof value.remoteSessionId === "string" ? value.remoteSessionId : undefined,
  };
}

// [失败路径] sessionId 非字符串返回 null；readOnly 为 true 时按迁移策略返回 null。
// 通过校验的 binding 一律置 restoredUnvalidated:true（INV-05）。
// 这让恢复数据默认处于待索引校验态，而不是直接可信。
function sanitizeBinding(value: unknown): WorkbenchSessionBinding | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    return null;
  }
  // [权衡] 历史 readOnly binding 只来自 subagent 行内分屏，已迁移到右侧 tabs。
  // 恢复时丢弃包含该 binding 的整个 group，避免升级后继续占用 4-pane workbench。
  // 普通 session 不带 readOnly，不受影响；不要改成只丢该 pane。
  if (value.readOnly === true) {
    // 迁移说明：历史 readOnly binding 只由“在分屏打开 subagent”产生。子会话详情已迁到
    // 右侧 tabs，恢复时丢弃包含该 binding 的旧 group，避免升级后继续占用 4-pane workbench；
    // 普通 session binding 没有 readOnly 标记，不受影响。
    return null;
  }
  // [失败路径] scope 非法时返回 null，binding 随之作废，进而 group 作废。
  // 这是“宁可少恢复也不要恢复错 workspace”的落点。
  // 不要用空 scope 兜底，否则 key 冲突会串组。
  const workspaceScope = sanitizeWorkspaceScope(value.workspaceScope);
  return workspaceScope
    ? {
        workspaceScope,
        sessionId: value.sessionId,
        // group 恢复过去绕过了 paneLayout 的 sessions-index 守卫，已删除
        // session 会永久留下空 pane；恢复 binding 必须显式进入待验证态。
        restoredUnvalidated: true,
      }
    : null;
}

// [失败路径] id/primary/root 缺失、leaf 重复、缺 primary、越上限均判废。
// 只保留 root leaf 对应且 binding 合法的 pane，孤立 pane 自动丢弃。
// focusedPaneId 非法时回落 primary，而不是丢弃整个 group。
function sanitizeWorkbenchGroup(value: unknown): WorkbenchGroup | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const primaryBinding = sanitizeBinding(value.primaryBinding);
  const root = sanitizePaneLayoutNode(value.root);
  if (!primaryBinding || !root) {
    return null;
  }

  const leafIds = leafPaneIds(root);
  // [契约] 同时用于 leaf 唯一性判断与 focusedPaneId 是否属于树。
  // 复用同一个 Set 避免两次 O(n) 构建，也保证判定口径一致。
  // 重复 leaf 意味着树被环形或重复引用，属于不可恢复脏数据。
  const uniqueLeafIds = new Set(leafIds);
  if (
    uniqueLeafIds.size !== leafIds.length ||
    !uniqueLeafIds.has(V4_PRIMARY_PANE_ID) ||
    leafIds.length > MAX_WORKBENCH_PANES
  ) {
    return null;
  }

  // [失败路径] panes 不是对象时按空对象处理，后续逐 leaf 取 binding。
  // 缺失 pane 的 binding 会返回 null 并导致整组判废（INV-06）。
  // 不要反过来遍历 rawPanes，否则会保留不在树中的条目。
  const rawPanes = isRecord(value.panes) ? value.panes : {};
  const panes: Record<string, WorkbenchSessionBinding> = {};
  for (const paneId of leafIds) {
    if (paneId === V4_PRIMARY_PANE_ID) {
      continue;
    }
    const binding = sanitizeBinding(rawPanes[paneId]);
    if (!binding) {
      return null;
    }
    panes[paneId] = binding;
  }

  const focusedPaneId =
    typeof value.focusedPaneId === "string" && uniqueLeafIds.has(value.focusedPaneId)
      ? value.focusedPaneId
      : V4_PRIMARY_PANE_ID;
  const group: WorkbenchGroup = {
    id: value.id,
    primaryBinding,
    root,
    panes,
    focusedPaneId,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
  // 恢复时发现只剩一个 session，直接丢弃壳子，避免刷新后出现“假分屏”。
  return countPanes(group) < 2 ? null : group;
}

function sanitizePersistedWorkbenchGroups(value: unknown): WorkbenchGroupSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const rawGroups = isRecord(value.groups) ? Object.values(value.groups) : [];
  const groups: Record<string, WorkbenchGroup> = {};
  const sessionIndex: Record<string, string> = {};
  for (const rawGroup of rawGroups) {
    const group = sanitizeWorkbenchGroup(rawGroup);
    if (!group || groups[group.id]) {
      continue;
    }
    const keys = groupSessionBindings(group).map(bindingSessionKey);
    if (keys.some((key) => sessionIndex[key])) {
      continue;
    }
    groups[group.id] = group;
    for (const key of keys) {
      sessionIndex[key] = group.id;
    }
  }
  if (Object.keys(groups).length === 0) {
    return null;
  }
  const activeGroupId =
    typeof value.activeGroupId === "string" && groups[value.activeGroupId]
      ? value.activeGroupId
      : null;
  return { activeGroupId, groups, sessionIndex };
}

export function persistWorkbenchGroups(snapshot: WorkbenchGroupSnapshot): void {
  if (!workbenchGroupsEnabled()) {
    return;
  }
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    const groups = Object.fromEntries(
      Object.entries(snapshot.groups).map(([groupId, group]) => {
        const {
          restoredUnvalidated: _primaryRestored,
          ...primaryBinding
        } = group.primaryBinding;
        const panes = Object.fromEntries(
          Object.entries(group.panes).map(([paneId, binding]) => {
            const { restoredUnvalidated: _restored, ...persisted } = binding;
            return [paneId, persisted];
          }),
        );
        return [groupId, { ...group, primaryBinding, panes }];
      }),
    );
    storage.setItem(
      WORKBENCH_GROUP_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeGroupId: snapshot.activeGroupId,
        // restoredUnvalidated 是本次 hydration 的内存状态，不能写回成为持久 schema。
        groups,
        sessionIndex: snapshot.sessionIndex,
      }),
    );
  } catch {
    // localStorage 配额/权限失败不影响 renderer 内存态。
  }
}

export function readPersistedWorkbenchGroups(): WorkbenchGroupSnapshot | null {
  if (!workbenchGroupsEnabled()) {
    return null;
  }
  const storage = safeStorage();
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(WORKBENCH_GROUP_STORAGE_KEY);
    return raw ? sanitizePersistedWorkbenchGroups(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export const useWorkbenchGroupStore = create<WorkbenchGroupStore>()((set, get) => ({
  ...INITIAL_WORKBENCH_GROUP_STATE,

  configureClientMode: (clientMode) => {
    if (clientMode === "web-remote-replayable") {
      // 过去 remote 只在聊天区隐藏 activeGroup，store 仍会在模块加载时
      // 恢复并由 sidebar/new-task 消费，还会把隐藏状态继续写回。先切换 gate 再清
      // 内存，确保清理动作本身也不会触碰 remote 的 localStorage。
      workbenchGroupClientMode = clientMode;
      desktopGroupsHydrated = false;
      set(INITIAL_WORKBENCH_GROUP_STATE);
      return;
    }

    workbenchGroupClientMode = clientMode;
    if (desktopGroupsHydrated) {
      return;
    }
    desktopGroupsHydrated = true;
    const restored = readPersistedWorkbenchGroups();
    if (restored) {
      set(restored);
    }
  },

  openSessionFromSidebar: (binding) => {
    if (!workbenchGroupsEnabled()) {
      return;
    }
    set((state) => focusSessionInSnapshot(state, binding));
  },

  splitSessionIntoGroup: (anchorPaneId, side, binding, fallbackPrimaryBinding) => {
    if (!workbenchGroupsEnabled()) {
      return;
    }
    set((state) =>
      splitSessionIntoSnapshot(state, anchorPaneId, side, binding, fallbackPrimaryBinding),
    );
  },

  promotePaneLayoutToGroup: (primaryBinding, layout) => {
    if (!workbenchGroupsEnabled()) {
      return false;
    }
    const current = get();
    const next = promotePaneLayoutToGroupSnapshot(current, primaryBinding, layout);
    if (next === current) {
      return false;
    }
    set(next);
    return true;
  },

  focusPane: (groupId, paneId) => {
    if (!workbenchGroupsEnabled()) {
      return;
    }
    set((state) => {
      const group = state.groups[groupId];
      if (!group) {
        return state;
      }
      const focused = focusWorkbenchGroupPane(group, paneId);
      return focused === group && state.activeGroupId === groupId
        ? state
        : replaceGroup({ ...state, activeGroupId: groupId }, focused);
    });
  },

  closePane: (groupId, paneId) => {
    if (!workbenchGroupsEnabled()) {
      return;
    }
    set((state) => {
      const group = state.groups[groupId];
      if (!group) {
        return state;
      }
      const nextGroup = closeWorkbenchGroupPane(group, paneId);
      if (!nextGroup) {
        return removeGroup(state, groupId);
      }
      return nextGroup === group ? state : replaceGroup(state, nextGroup);
    });
  },

  confirmRestoredPaneSession: (groupId, paneId) => {
    if (!workbenchGroupsEnabled()) {
      return;
    }
    set((state) => {
      const group = state.groups[groupId];
      if (!group) {
        return state;
      }
      const confirmed = confirmRestoredWorkbenchGroupPane(group, paneId);
      return confirmed === group ? state : replaceGroup(state, confirmed);
    });
  },

  bindPaneSession: (groupId, paneId, sessionId) => {
    if (!workbenchGroupsEnabled()) {
      return;
    }
    set((state) => bindPaneSessionInSnapshot(state, groupId, paneId, sessionId));
  },

  setSplitRatio: (groupId, splitId, ratio) => {
    if (!workbenchGroupsEnabled()) {
      return;
    }
    set((state) => {
      const group = state.groups[groupId];
      if (!group) {
        return state;
      }
      const nextLayout = setSplitNodeRatio(group, splitId, ratio);
      if (nextLayout.root === group.root) {
        return state;
      }
      // promote 后可见布局的唯一 owner 是 group；占比更新只替换 root，
      // workspaceIdentity/remoteSessionId binding 与 sessionIndex 必须原样保留。
      return replaceGroup(state, {
        ...group,
        root: nextLayout.root,
        updatedAt: Date.now(),
      });
    });
  },

  isSessionGrouped: (scope, sessionId) => {
    if (!workbenchGroupsEnabled() || !sessionId) {
      return false;
    }
    return Boolean(get().sessionIndex[buildWorkbenchSessionKey(scope, sessionId)]);
  },

  getActiveContext: () => {
    if (!workbenchGroupsEnabled()) {
      return null;
    }
    const state = get();
    const group = state.activeGroupId ? state.groups[state.activeGroupId] : undefined;
    return group ? selectWorkbenchGroupActiveBinding(group) : null;
  },

  deactivateActiveGroup: () => {
    if (!workbenchGroupsEnabled()) {
      return;
    }
    set((state) => (state.activeGroupId === null ? state : { ...state, activeGroupId: null }));
  },

  resetWorkbenchGroups: () => {
    set(INITIAL_WORKBENCH_GROUP_STATE);
  },
}));

useWorkbenchGroupStore.subscribe((state) => {
  if (workbenchGroupsEnabled()) {
    persistWorkbenchGroups(state);
  }
});
