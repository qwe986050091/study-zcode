// INV-01 存储键固定为 zcode-v4-pane-layout:v2，读写共用同一常量；守住位置：写入与读取都引用 PANE_LAYOUT_STORAGE_KEY；改错故障：只改一侧会让布局写入后永远读不到。
// INV-02 读取时 v2 优先，v2 有值就只按 v2 解释；守住位置：readPersistedPaneLayout 的分支顺序；改错故障：v2 损坏时回落 v1，会让旧单分屏覆盖新布局。
// INV-03 任何一层校验失败都整份丢弃并回初始布局；守住位置：sanitizeNode 与 sanitizePersistedPaneLayout 的 null 传播；改错故障：局部救回会拼出缺绑定或断链的树。
// INV-04 叶子 id 必须唯一且 primary 恰好一个，同时不超过 MAX_WORKBENCH_PANES；守住位置：paneIds 的三项合并判断；改错故障：重复 id 会让两个 pane 共享同一份 session 绑定。
// INV-05 每个非 primary 叶子必须有合法绑定，scope 的 workspacePath 非空；守住位置：按 paneIds 遍历绑定表；改错故障：缺绑定的 pane 恢复后无法建立 workspace 路由。
// INV-06 primary 绑定不进入持久化表，由 shell props 提供；守住位置：写入循环跳过 primary、读取循环直接跳过；改错故障：把 primary 绑定落盘会与 activeTaskId 形成两份事实。
// INV-07 split 的 direction 只接受 row 与 column；守住位置：sanitizeNode 的 split 分支；改错故障：放行未知方向会让布局轴与 CSS flex 方向不一致，分屏比例错位。
// INV-08 ratio 一律经 clampSplitRatio 收口到 0.25 至 0.75，非法值回默认 0.5；守住位置：反序列化不直接使用磁盘比例；改错故障：绕过后拖拽与持久化出现两套阈值。
// INV-09 恢复出的 session 绑定补 restoredUnvalidated，且该标记不落盘；守住位置：sanitize 结果与 persist 投影；改错故障：标记被持久化会让重启后永久跳过 sessions-index 校验。
// INV-10 focusedPaneId 必须命中叶子清单，否则回退 primary；守住位置：sanitizePersistedPaneLayout 末尾的 focus 计算；改错故障：悬空焦点会让输入进入不存在的 pane。
// INV-11 v1 只在 workspaceKey 是可信本地绝对路径时迁移；守住位置：isPlausibleLocalPath 的入口判断；改错故障：把远程 identity 当路径会让文件操作指向错误目录。
// INV-12 v1 遗留 pane id 固定为 split，供 e2e 与 testid 契约沿用；守住位置：V4_LEGACY_SPLIT_PANE_ID 常量；改错故障：改名会同时打断迁移树与既有测试选择器。
// INV-13 localStorage 读写全部包在 try/catch 内并静默降级；守住位置：readPersistedPaneLayout 与 persistPaneLayout 的异常分支；改错故障：抛错会中断分屏初始化，界面白屏。
// INV-14 写入只投影已知字段，readOnly 与 restoredUnvalidated 不落盘；守住位置：persistPaneLayout 的绑定投影；改错故障：多余字段会被未来版本误读为持久化事实。
// INV-15 序列化结果与上次相同则跳过 setItem；守住位置：lastPersistedPaneLayout 比较；改错故障：每次状态变化都写存储会放大同步开销并触发无谓的 storage 事件。
// INV-16 去重缓存只在 setItem 成功后更新；守住位置：赋值顺序在写入之后；改错故障：写入抛错仍更新缓存，后续相同布局再也写不进去。
// INV-17 scope 的可选字段仅在类型正确且非空时写入，空 identity 不落盘；守住位置：sanitizeScope 的展开条件；改错故障：空串 identity 会让身份键退化为空，多个 pane 被误判同源。
// INV-18 无 storage 环境只是刷新后无法恢复，分屏本身仍可用；守住位置：persist 的异常分支只吞异常不降级内存布局；改错故障：把存储失败当致命错误会让隐身模式无法分屏。
//
// 模块职责：把分屏树与 pane 绑定在 localStorage 与内存快照之间来回转换，并在读取时对一切不可信输入做整体校验。
// 状态所有权：磁盘布局归本模块读写，session 有效性归 sessions-index，焦点单值归 Focus 层，本模块只负责恢复与回退。
// 阅读顺序：先看 sanitizePersistedPaneLayout 的整体校验，再看 sanitizeNode 与 sanitizeScope 的逐层规则，最后看 v1 迁移与读写入口。
// 分屏 Layout 层持久化（localStorage）：try/catch 静默降级；
// 损坏数据整体丢弃回初始布局（不部分救回）。
// 兼容读取旧版 v1（单值 splitPane），仅当 v1 workspaceKey 是可信本地路径时迁移。
// 本模块只依赖 paneLayoutTree 的纯函数与常量：clampSplitRatio 收口比例、leafPaneIds 提供叶子清单、上限与 primary 常量是校验口径。
// 类型以 type 形式引入，运行时只取常量与纯函数，避免把树状态逻辑复制到持久化层形成第二套实现。
// 依赖方向固定为持久化层指向树工具层，反向引用会让树模块依赖浏览器存储，破坏纯函数与单测环境。
// 改错故障：若在此内联比例边界或 pane 上限，会出现拖拽与持久化两套阈值，恢复出的布局可能越过 UI 允许范围。
import {
  clampSplitRatio,
  leafPaneIds,
  MAX_WORKBENCH_PANES,
  PRIMARY_LEAF,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneLayoutNode,
  type PaneLayoutSnapshot,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutTree.js";

// 对外契约：v2 键是唯一写入目标，旧版本读取方不再写回 v1，否则新旧格式会在同一浏览器里反复覆盖。
// 改键名等同放弃全部已存布局，属于破坏性变更，必须同时改读取路径与迁移测试。
// 键值带版本后缀，是因为 v2 从单值 splitPane 变成了树加绑定表，结构无法原地兼容。
export const PANE_LAYOUT_STORAGE_KEY = "zcode-v4-pane-layout:v2";
/** 一期单值分屏的旧 key（只读迁移，不再写入）。 */
export const PANE_LAYOUT_STORAGE_KEY_V1 = "zcode-v4-pane-layout:v1";

/** v1 迁移用的保留 pane id（一期 split pane 固定 id，e2e/testid 契约沿用）。 */
export const V4_LEGACY_SPLIT_PANE_ID = "split";

// 持久化形状与 PaneWorkspaceScope 刻意分离：磁盘上只出现可 JSON 化的字段，读取后再归一成内存类型。
// workspaceIdentity 与 remoteSessionId 可选，远程 scope 缺 identity 时由上层按路径兜底，持久化层不推断远程身份。
// 改错故障：若把整个 scope 直接展开写入，未来新增的内存字段会被无意持久化，恢复时又缺少对应校验。
interface PersistedScopeV2 {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface PersistedBindingV2 {
  workspaceScope: PersistedScopeV2;
  sessionId: string | null;
}

// 这是磁盘树的唯一形状：leaf 只认 paneId，split 只认 id、direction、ratio 与两个子节点，多余字段读取时被忽略。
// 递归类型让反序列化可以逐层校验，任何一层不合法都向上返回 null，从而整体丢弃而不是局部拼接。
// 改错故障：若放行未知 type，恢复出的树会带不可渲染节点，分屏区域直接空白。
type PersistedNodeV2 =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: PersistedNodeV2;
      second: PersistedNodeV2;
    };

interface PersistedPaneLayoutV2 {
  root: PersistedNodeV2;
  panes: Record<string, PersistedBindingV2>;
  focusedPaneId: string;
}

// 早返回策略：非对象、未知 type、缺 id 或非法 direction 一律返回 null，调用方据此放弃整份快照。
// 比例不信任磁盘值，统一交给 clampSplitRatio，NaN 或越界都会落回允许区间与默认值。
// 改错故障：若某一层返回部分树，父节点会用缺失子树拼出断链结构，后续叶子遍历会崩溃。
function sanitizeNode(raw: unknown): PaneLayoutNode | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedNodeV2> & Record<string, unknown>;
  if (record.type === "leaf") {
    return typeof record.paneId === "string" && record.paneId.length > 0
      ? { type: "leaf", paneId: record.paneId }
      : null;
  }
  // split 必须同时具备非空 id 与 row 或 column 方向，缺一不可，因为 id 是拖拽定位键，direction 决定布局轴。
  // 两个子节点都递归校验通过后才组装，任一子树失败即让整个 split 失败，保证结果是完整二叉树。
  // 改错故障：容忍空 id 会让两个 split 抢同一 CSS 变量，拖拽比例被写到错误节点。
  if (record.type === "split") {
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      (record.direction !== "row" && record.direction !== "column")
    ) {
      return null;
    }
    const first = sanitizeNode(record.first);
    const second = sanitizeNode(record.second);
    if (!first || !second) {
      return null;
    }
    return {
      type: "split",
      id: record.id,
      direction: record.direction,
      ratio: clampSplitRatio(
        typeof record.ratio === "number" ? record.ratio : Number.NaN,
      ),
      first,
      second,
    };
  }
  return null;
}

// workspacePath 是绑定的硬前提：空串或非字符串直接判定绑定无效，避免恢复出无法定位工作区的 pane。
// 可选字段只在类型正确且非空时展开写入，空 identity 不落盘，防止把空串当成身份键参与去重。
// 改错故障：若保留空串 identity，身份键会退化为空值，多个 pane 被误判为同一 workspace。
function sanitizeScope(raw: unknown): PaneWorkspaceScope | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedScopeV2>;
  if (
    typeof record.workspacePath !== "string" ||
    record.workspacePath.length === 0
  ) {
    return null;
  }
  return {
    workspacePath: record.workspacePath,
    ...(typeof record.workspaceIdentity === "string" &&
    record.workspaceIdentity.trim().length > 0
      ? { workspaceIdentity: record.workspaceIdentity }
      : {}),
    ...(typeof record.remoteSessionId === "string" &&
    record.remoteSessionId.length > 0
      ? { remoteSessionId: record.remoteSessionId }
      : {}),
  };
}

/**
 * 把任意（可能损坏的）v2 持久化值归一为合法布局快照；不可救回 null（调用方回初始布局）。
 * 完整性要求（任一不满足即整体丢弃）：树结构合法、叶子 id 唯一、恰含一个 primary、
 * 叶子数 ≤ 上限、每个非 primary 叶子有合法绑定。恢复出的 session 绑定补
 * restoredUnvalidated（等 sessions-index 验证）；focusedPaneId 不在树中回 primary。
 */
// 对外契约：输入任意 unknown，输出合法快照或 null，绝不抛异常，也不返回半合法布局。
// 校验顺序固定为根节点、叶子清单、数量与唯一性、非 primary 绑定、焦点回退，前一步失败立即返回。
// 完整性是原子条件：任一 pane 绑定缺失或 scope 非法都整份丢弃，因为缺绑定的 pane 无法建立 session 路由。
// 改错故障：若跳过 primary 计数，可能出现零个或多个主 pane，焦点与 shell props 的归属随即冲突。
export function sanitizePersistedPaneLayout(
  raw: unknown,
): PaneLayoutSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Partial<PersistedPaneLayoutV2>;
  const root = sanitizeNode(record.root);
  if (!root) {
    return null;
  }
  // 三项条件合并在同一次判断：叶子数不超上限、id 无重复、primary 恰好一个，任一不满足即返回 null。
  // 重复 id 会让 React key 与 store 绑定表互相覆盖，所以必须在进入绑定校验前拦住。
  // 改错故障：只校验数量不校验唯一性，重复 id 会让两个视觉 pane 共享一份 session 绑定。
  const paneIds = leafPaneIds(root);
  if (
    paneIds.length > MAX_WORKBENCH_PANES ||
    new Set(paneIds).size !== paneIds.length ||
    paneIds.filter((paneId) => paneId === V4_PRIMARY_PANE_ID).length !== 1
  ) {
    return null;
  }
  const rawPanes =
    typeof record.panes === "object" && record.panes !== null
      ? (record.panes as Record<string, unknown>)
      : {};
  const panes: Record<string, PaneBinding> = {};
  for (const paneId of paneIds) {
    if (paneId === V4_PRIMARY_PANE_ID) {
      continue;
    }
    const rawBinding = rawPanes[paneId];
    if (typeof rawBinding !== "object" || rawBinding === null) {
      return null;
    }
    const scope = sanitizeScope(
      (rawBinding as Partial<PersistedBindingV2>).workspaceScope,
    );
    if (!scope) {
      return null;
    }
    const rawSessionId = (rawBinding as Partial<PersistedBindingV2>).sessionId;
    const sessionId =
      typeof rawSessionId === "string" && rawSessionId.length > 0
        ? rawSessionId
        : null;
    panes[paneId] = {
      workspaceScope: scope,
      sessionId,
      ...(sessionId !== null ? { restoredUnvalidated: true as const } : {}),
    };
  }
  // 焦点是单值且必须落在当前树内：磁盘值不在叶子清单时回退 primary，而不是保留悬空 id。
  // 改错故障：保留悬空焦点会让键盘与命令面板把输入送到不存在的 pane，表现为输入丢失。
  // 回退只影响焦点，不触发树重建，因此不会与恢复出的 session 绑定产生竞争。
  const focusedPaneId =
    typeof record.focusedPaneId === "string" &&
    paneIds.includes(record.focusedPaneId)
      ? record.focusedPaneId
      : V4_PRIMARY_PANE_ID;
  return { root, panes, focusedPaneId };
}

/** v1 workspaceKey 只在是可信本地绝对路径时才能当 workspacePath 迁移（POSIX / Windows 盘符）。 */
// v1 的 workspaceKey 可能是 identity 也可能是路径，只有 POSIX 绝对路径或 Windows 盘符路径才敢当 workspacePath 迁移。
// 无法还原远程 scope 时宁可放弃迁移，因为把 identity 误当路径会让后续文件操作指向不存在的目录。
// 改错故障：放宽判断会把远程 identity 写成路径，Git 与命令 cwd 全部落到错误位置。
function isPlausibleLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * 旧版 v1（单值 splitPane）→ v2 迁移：v1 只存了 workspaceKey（identity ?? path），
 * 无法还原远程 scope——仅当它是可信本地路径时迁移为双叶子树，否则丢弃回单 pane（null）。
 */
export function migratePersistedPaneLayoutV1(
  raw: unknown,
): PaneLayoutSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as {
    splitPane?: { workspaceKey?: unknown; sessionId?: unknown } | null;
    focusedPaneId?: unknown;
    splitRatio?: unknown;
  };
  const workspaceKey = record.splitPane?.workspaceKey;
  if (
    typeof workspaceKey !== "string" ||
    workspaceKey.length === 0 ||
    !isPlausibleLocalPath(workspaceKey)
  ) {
    return null;
  }
  const rawSessionId = record.splitPane?.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0
      ? rawSessionId
      : null;
  return {
    root: {
      type: "split",
      id: "n1",
      direction: "row",
      ratio: clampSplitRatio(
        typeof record.splitRatio === "number" ? record.splitRatio : Number.NaN,
      ),
      first: PRIMARY_LEAF,
      second: { type: "leaf", paneId: V4_LEGACY_SPLIT_PANE_ID },
    },
    panes: {
      [V4_LEGACY_SPLIT_PANE_ID]: {
        workspaceScope: { workspacePath: workspaceKey },
        sessionId,
        ...(sessionId !== null ? { restoredUnvalidated: true as const } : {}),
      },
    },
    focusedPaneId:
      record.focusedPaneId === V4_LEGACY_SPLIT_PANE_ID
        ? V4_LEGACY_SPLIT_PANE_ID
        : V4_PRIMARY_PANE_ID,
  };
}

/** 读取持久化布局（v2 优先，缺失时尝试 v1 迁移）；无记录/损坏/无 storage 环境返回 null。 */
// 读取顺序固定 v2 优先：只要 v2 有值就只按 v2 解释，即使解析失败也不回退 v1，避免旧数据覆盖新布局。
// localStorage 在隐身模式或测试环境可能抛异常，异常分支把缺存储、JSON 损坏、校验失败统一收敛为 null。
// 改错故障：若在异常分支回退 v1，用户升级后的新布局会被旧单分屏反复覆盖。
export function readPersistedPaneLayout(): PaneLayoutSnapshot | null {
  try {
    const rawV2 = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    if (rawV2) {
      return sanitizePersistedPaneLayout(JSON.parse(rawV2));
    }
    const rawV1 = localStorage.getItem(PANE_LAYOUT_STORAGE_KEY_V1);
    if (rawV1) {
      return migratePersistedPaneLayoutV1(JSON.parse(rawV1));
    }
    return null;
  } catch {
    return null;
  }
}

function serializeNode(node: PaneLayoutNode): PersistedNodeV2 {
  if (node.type === "leaf") {
    return { type: "leaf", paneId: node.paneId };
  }
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: node.ratio,
    first: serializeNode(node.first),
    second: serializeNode(node.second),
  };
}

// 去重写入：subscribe 对任何状态变化都触发，序列化相同（例如 restoredUnvalidated
// 清除，不进持久化面）时跳过 setItem。
let lastPersistedPaneLayout: string | null = null;

// 写入前先投影成 PersistedBindingV2：只保留 path、两个可选 scope 字段与 sessionId，readOnly 与 restoredUnvalidated 不进磁盘。
// 序列化结果与 lastPersistedPaneLayout 相同时直接返回，避免 subscribe 每次状态变化都触发存储写入。
// 改错故障：若把 restoredUnvalidated 持久化，重启后会永久跳过 sessions-index 校验，已删除的 session 也被当成有效绑定。
export function persistPaneLayout(snapshot: PaneLayoutSnapshot): void {
  const panes: Record<string, PersistedBindingV2> = {};
  for (const [paneId, binding] of Object.entries(snapshot.panes)) {
    panes[paneId] = {
      workspaceScope: {
        workspacePath: binding.workspaceScope.workspacePath,
        ...(binding.workspaceScope.workspaceIdentity
          ? { workspaceIdentity: binding.workspaceScope.workspaceIdentity }
          : {}),
        ...(binding.workspaceScope.remoteSessionId
          ? { remoteSessionId: binding.workspaceScope.remoteSessionId }
          : {}),
      },
      sessionId: binding.sessionId,
    };
  }
  const payload: PersistedPaneLayoutV2 = {
    root: serializeNode(snapshot.root),
    panes,
    focusedPaneId: snapshot.focusedPaneId,
  };
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === lastPersistedPaneLayout) {
      return;
    }
    localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, serialized);
    lastPersistedPaneLayout = serialized;
  } catch {
    // 无 storage 环境（测试/隐身）静默降级：刷新恢复不可用，但不影响正常分屏。
  }
}
