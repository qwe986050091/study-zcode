// 源服务器/连接 Profile 管理面板：把 Host 的 source-server 快照投影成
// “设备卡片 + 连接列表 + 迁移/更新日志”的三层视图，并承载增删改查与连通性操作。
// 它只拥有“面板操作防重”与展开态等纯 UI 状态；业务事实（连接、工作区、日志）
// 一律以 management 快照为准，禁止在此维护第二份连接状态。
//
// INV-01：同设备的不同连接互斥，不同设备并行；任何写操作都必须经 run() 申请 scope，
//         不得绕过它直接调用 management（守住它的位置：run 的入口检查）。
// INV-02：run 必须同时用 ref 与 state 记录在途操作，ref 负责同步防重，state 负责渲染；
//         只留 state 会让同一帧的连点穿透（守住它的位置：operationsRef.current）。
// INV-03：在途记录必须在 finally 中删除，任何 return/抛错都不能跳过，
//         否则该设备会永久处于“忙碌”而无法再操作（守住它的位置：run 的 finally）。
// INV-04：操作成功必须优先使用返回值里的新快照，没有返回值才回退 refresh；
//         回退是慢路径，滥用会让每次点击都多一次全量拉取（守住它的位置：run 的 try）。
// INV-05：删除 Profile / 源服务器必须先弹确认框，确认前不得发起任何写请求；
//         取消是正常路径，不是错误（守住它的位置：removeProfile / removeSourceServer）。
// INV-06：错误统一写入面板级 error state，由错误横幅呈现；操作函数不得自行 toast，
//         否则同一次失败会出现两条提示（守住它的位置：run 的 catch）。
// INV-07：mountedRef 用于拦截卸载后的异步 setState；所有 await 之后的写入前
//         必须先检查它（守住它的位置：mountedRef 的 effect）。
// INV-08：目标设备聚焦是一次性的：由 focusedTargetRef 记录已处理的 key，
//         同一 target 不得重复滚动/聚焦，否则快照刷新会把页面拽回去。
// INV-09：相对时间由 60s 心跳驱动重绘，不依赖连接事件；停止心跳会让人看到
//         “1 分钟前”一直不变（守住它的位置：setClockTick 的 interval）。
// INV-10：展开态（设备/项目/日志）只记录“用户显式切换过”的项；
//         未切换时由“设备是否失败”等派生默认值决定，二者不可混写。
// INV-11：日志展开状态按 sourceServerId 归属而不是 profileId：一个设备下可能挂着
//         多条连接，日志视图是按设备聚合的。
// INV-12：迁移报告按 sourceServerId 缓存，切换设备时不得清空其它设备的报告：
//         报告生成代价高，用户会来回比对。
// INV-13：投影使用 buildRemoteWorkspaceProjection 统一构造，面板不得自行拼装
//         workspace 列表，否则侧边栏与设置页会展示不同的项目集合。
// INV-14：启动自动重连开关是受控的乐观状态：本地 setState 后仍会跟随 settings 回填，
//         避免 Host 拒绝写入时 UI 停在错误值。
// INV-15：所有危险操作（删除、迁移、强制更新）必须携带明确的 scope，
//         便于并行判断与错误归因；跨设备操作不得共享同一个 scope。
import {
  useRemoteConnectionProgress,
  RemoteConnectionMinimizedProgress,
} from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { DesktopCommandIds } from "@zcode/shared";
/* eslint-disable max-lines -- Source/Profile/迁移三类管理操作共享同一 Host 快照和错误状态。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileWarning,
  Folder,
  ListTree,
  Loader2,
  Pencil,
  Plus,
  Server,
  Box,
  TerminalSquare,
  Copy,
  Trash2,
} from "lucide-react";
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  ConnectionProfile,
  AppSettings,
  SourceServerManagementSnapshot,
  SourceServerMigrationReport,
  SourceServerRecord,
  SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import { getPathLeaf } from "@/lib/path.js";
import { toast } from "@/components/ui/toast.js";
import { getSourceServerManagementErrorMessage } from "@/lib/sourceServerManagementError.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useSourceServerOperationLogs } from "@/hooks/useSourceServerOperationLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SourceServerMigrationReportPanel } from "@/settings/SourceServerMigrationReportPanel.js";
import {
  SourceServerLogList,
  SourceServerUpdateActivity,
} from "@/settings/SourceServerUpdateActivity.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import {
  resolveRemoteConnectionPresentation,
  getRemoteDevicePresentationInput,
  classifyRemoteConnectionError,
  type RemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import {
  sourceServerUpdatePreferences,
  sourceServerUpdateKey,
  useDeferredSourceServerUpdates,
} from "@/lib/sourceServerUpdatePreferences.js";
import {
  getSourceServerForceUpdateDescription,
  runSourceServerUpdate,
} from "@/lib/sourceServerUpdateAction.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { EditConnectionProfileDialog } from "@/remote-connection/EditConnectionProfileDialog.js";
import {
  formatConnectionProfileTarget,
  RemoteConnectionKindTag,
  RemoteConnectionStatusTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { buildRemoteWorkspaceProjection } from "@/remote/remoteWorkspaceProjection.js";

// [权衡] 绝对时间只用于 tooltip 等需要精确值的场景：列表主文案用相对时间，
// 绝对时间在长列表里噪声太大。
function formatTimestamp(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// [权衡] 分档用固定阈值而非 Intl.RelativeTimeFormat：后者在“48 小时内”会输出
// “昨天/前天”的歧义结果，而这个面板需要的是稳定、可预期的中文档位。
// [失败路径] 时钟回拨（timestamp 在未来）时用 Math.max(0, ...) 兜底为“刚刚”，
// 不能出现“-3 分钟前”。
// [事务] 超过 48 小时回落到日期：继续用“N 天前”会让人无法判断具体哪天，
// 而设备连接时间往往需要精确到日。
function formatRelativeTimestamp(
  timestamp: number,
  locale: string,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return formatMessage({ id: "common.justNow" });
  if (elapsed < 60 * 60_000) {
    return formatMessage({ id: "common.minutesAgo" }, { count: Math.floor(elapsed / 60_000) });
  }
  if (elapsed < 24 * 60 * 60_000) {
    return formatMessage({ id: "common.hoursAgo" }, { count: Math.floor(elapsed / (60 * 60_000)) });
  }
  if (elapsed < 48 * 60 * 60_000) return formatMessage({ id: "common.yesterday" });
  return new Date(timestamp).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

// [并发] 项目数用 Set 去重：同一个 workspacePath 可能同时出现在历史与当前会话里，
// 直接 length 会把一个项目算成两个。
// [事务] 当前会话指定了 workspacePath 时优先用它过滤：这台设备可能连过多个项目，
// 只应统计“当前正在用的”那个。
// [失败路径] 缺少 remoteConversationWorkspaceBySourceServerId 时退回全部历史，
// 而不是返回 0：没有映射信息说明是旧版本数据，显示 0 会让人以为项目丢了。
export function getProjectCount(
  snapshot: SourceServerManagementSnapshot,
  sourceServerId: string,
  remoteConversationWorkspaceBySourceServerId?: AppSettings["remoteConversationWorkspaceBySourceServerId"],
): number {
  return new Set(
    snapshot.workspaceHistory
      .filter(
        (entry) =>
          entry.sourceServerId === sourceServerId &&
          remoteConversationWorkspaceBySourceServerId?.[sourceServerId]?.workspacePath !==
            entry.workspacePath,
      )
      .map((entry) => resolveWorkspaceKey(entry)),
  ).size;
}

const COLLAPSED_PROJECT_COUNT = 3;

// [事务] 复制 Set 再增删，返回新引用而不是原地修改：
// React 的展开态是 state，原地改会导致引用不变、界面不刷新。
function toggleSetItem(current: Set<string>, item: string): Set<string> {
  const next = new Set(current);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

// [事务] scope 的优先级固定：有 sourceServerId 时按设备聚合，否则按连接。
// 这样同一设备下的多条连接共享一个互斥域，避免并发删除/更新互相踩踏。
// [并发] 前缀必须区分 source:/profile:：两类 id 可能字面相同，
// 去掉前缀会让不同实体错误地互斥。
function profileOperationScope(profile: ConnectionProfile): string {
  return profile.sourceServerId
    ? `source:${profile.sourceServerId}`
    : `profile:${profile.profileId}`;
}

// [事务] 面板的入参分两类：management 提供数据与写接口，其余回调都是“导航/弹窗”
// 出口。面板不得自己打开全局连接弹窗，必须经 onConnectProfile 交给 Root，
// 否则会绕过全局进度与互斥控制（守住 INV-01 的边界）。
// [并发] workspaceTabs 只用于判断“哪些设备有已打开的项目”，不参与数据写入；
// 传入的可能是上一次渲染的旧数组，禁止据此做删除/迁移决策。
// [失败路径] settings 允许为 null（首帧配置未到达）：此时相关开关回落默认值，
// 面板仍需可渲染，不能因为缺配置整块消失。
export function SourceServerManagementPanel({
  management,
  targetSourceServerId,
  targetSourceServerDetails = false,
  onTargetSourceServerFocused,
  onCreateConnection,
  onConnectProfile,
  onDisconnectSource,
  onShowInSidebar,
  onOpenProject,
  onShowUpdateDetails,
  workspaceTabs = [],
  settings,
  onUpdateSettings,
}: {
  management: ISourceServerManagementService;
  targetSourceServerId?: string;
  targetSourceServerDetails?: boolean;
  onTargetSourceServerFocused?: () => void;
  onCreateConnection?: () => void;
  /** 用户点击连接时交给 Root 的全局弹窗，以 preferredProfileId 直达第 4 步。 */
  onConnectProfile?: (profileId: string) => Promise<void> | void;
  /** 用户断开设备时交给 Root 的统一 RemoteWorkspaceController。 */
  onDisconnectSource?: (sourceServerId: string) => Promise<void>;
  /** 「在侧边栏中显示」菜单项：返回工作区主界面（侧边栏设备分组所在处）。 */
  onShowInSidebar?: (sourceServerId: string) => void;
  onOpenProject?: (sourceServerId: string, path: string, profileId?: string) => Promise<void>;
  onShowUpdateDetails?: (sourceServerId: string) => void;
  workspaceTabs?: WorkspaceTabState[];
  /** 「新任务」按钮（原型 L763）：激活该设备已打开的 workspace tab 并开新草稿。 */
  /** 有已打开 workspace tab 的设备 id 集合；「新任务」仅对这些设备渲染。 */
  settings?: Pick<
    AppSettings,
    "remoteStartupAutoReconnectEnabled" | "remoteConversationWorkspaceBySourceServerId"
  > | null;
  onUpdateSettings?: (patch: Partial<AppSettings>) => Promise<unknown> | void;
}) {
  // [并发] background 是“全局正在连接”的投影，可能由设置页之外的入口发起；
  // 面板只用它渲染未完成连接与忙碌态，不得据此修改连接记录。
  // [事务] 它与 snapshot 是两条数据流：snapshot 是权威列表，background 是瞬时进度，
  // 任何“以 background 为准”的删除判断都会在断线时误删。
  const background = useRemoteConnectionProgress();
  const { intl, locale } = useZCodeIntl();
  // [事务] confirmDialog 是全局唯一的确认弹窗实例：多个面板同时打开会互相覆盖，
  // 因此危险操作的确认必须串行发起（见 removeProfile / removeSourceServer）。
  const confirmDialog = useConfirmDialog();
  // [权衡] platform 只用于“能否打开外部链接/是否有原生菜单”等能力判断，
  // 不参与连接逻辑；缺失时相关入口降级隐藏而不是报错。
  // [资源] deferredUpdates 是“稍后提醒”偏好的本地存储视图，读写都在内存里完成，
  // 面板卸载后由 storage 自身持久化，无需显式 flush。
  const platform = useOptionalPlatform();
  const deferredUpdates = useDeferredSourceServerUpdates();
  // [事务] 自动重连开关是“本地乐观值 + settings 回填”的双写：点击时立刻改本地值，
  // Host 推送新 settings 后再覆盖，保证写入失败时 UI 最终回到真实值。
  // [失败路径] settings 为 null 时默认开启，与本机 Host 的初始默认保持一致。
  const [startupAutoReconnect, setStartupAutoReconnect] = useState(
    settings?.remoteStartupAutoReconnectEnabled ?? true,
  );
  // [事务] settings 回填与本地乐观值共用同一份 state：Host 推送新配置时整体覆盖，
  // 用户刚才的点击若被拒绝，会在这里被纠正回真实值（守住 INV-14）。
  // [失败路径] settings 为 null（配置尚未到达）时回填默认值 true，
  // 与 useState 的初值保持一致，避免出现“先 false 后 true”的闪烁。
  // [并发] 依赖只取 enable 字段：settings 的其它字段变化不应重置这个开关。
  useEffect(() => {
    setStartupAutoReconnect(settings?.remoteStartupAutoReconnectEnabled ?? true);
  }, [settings?.remoteStartupAutoReconnectEnabled]);
  // [事务] 编辑弹窗的目标是一个“连接 + 可选所属设备 + 聚焦字段”的复合对象：
  // 三者缺一都无法定位表单（设备决定 SSH 默认值，字段决定初始焦点）。
  // [并发] 同一时刻只允许一个编辑目标，再次编辑会整体替换而不是叠加。
  const [editingConnection, setEditingConnection] = useState<{
    profile: ConnectionProfile;
    server?: SourceServerRecord;
    focusField?: "host" | "auth";
  } | null>(null);
  // [事务] 错误详情弹窗保存的是“连接对象”而不是 profileId：弹窗要用 target 做错误分类，
  // 只存 id 会在快照刷新后丢失 target 信息（连接可能已被删除）。
  // [并发] errorDetailsProfile 与编辑目标分开存，查看错误不打断正在填写的编辑表单。
  // [失败路径] 详情为 null 时弹窗关闭，这是唯一的关闭信号，不额外维护 open 布尔。
  const [errorDetailsProfile, setErrorDetailsProfile] = useState<ConnectionProfile | null>(null);
  // [事务] 三块折叠态分别由 expandedSavedConnectionSources 与另两个 Set 持有，任一块翻转不会带动其他两块重渲染。
  // 合并成一个 Map 会让一次点击触发三块重渲染。
  // [权衡] 默认全部折叠：设备多时展开会让首屏过长，且折叠态更利于快速扫描。
  const [expandedSavedConnectionSources, setExpandedSavedConnectionSources] = useState<Set<string>>(
    new Set(),
  );
  // [权衡] 项目展开态不设默认值：默认只显示最近三个项目，展开是用户显式意图，
  // 若按设备数量自动展开，长列表会让首屏无法快速扫读。
  // [并发] 只存“已展开”的设备 id：未记录即折叠，避免为每台设备维护两条状态。
  const [expandedProjectSources, setExpandedProjectSources] = useState<Set<string>>(new Set());
  // 只记录用户手动切换过的日志展开状态；未切换时由设备是否失败决定默认值。
  const [logExpansionBySource, setLogExpansionBySource] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  // 这里只拥有面板操作的防重状态；业务状态与快照版本仍由 Host 和快照 hook 负责。
  // [并发] operationsRef 是同步事实源，busyOperations 是它的渲染投影：
  // 每次变更都整体替换 Map（而不是 mutate），保证 React 能感知。
  // [事务] busyScopes 额外并入全局进度（background）：Root 侧发起的连接操作
  // 也要让本面板的对应设备显示忙碌，否则用户会重复点击。
  // [失败路径] background 的 sourceServerId 与 profileId 二选一，先设备后连接：
  // 两者同时存在时以设备为准，避免同一操作被算成两个 scope。
  // [资源] operationsRef 不随渲染重建，卸载时随组件回收，不需要显式清理。
  const operationsRef = useRef(new Map<string, readonly string[]>());
  const [busyOperations, setBusyOperations] = useState<ReadonlyMap<string, readonly string[]>>(
    new Map(),
  );
  // [并发] busyScopes 是“当前所有在途操作的 scope 并集”，供渲染期一次性判断；
  // 每次 busyOperations 变化都会重建 Set，因此不要把它当作稳定引用放进依赖数组。
  const busyScopes = new Set([...busyOperations.values()].flat());
  if (background?.sourceServerId) busyScopes.add(`source:${background.sourceServerId}`);
  else if (background?.profileId) busyScopes.add(`profile:${background.profileId}`);
  // [并发] 只读 ref，不依赖 state：它要在 run() 的同步入口里判断，
  // 用 state 会拿到上一帧的值（守住 INV-02）。
  // [失败路径] 判据是“任一 scope 命中”，而不是精确匹配 key：
  // 同一设备下不同连接的操作必须互相阻塞。
  const hasBusyScope = useCallback(
    (scope: string) => [...operationsRef.current.values()].some((scopes) => scopes.includes(scope)),
    [],
  );
  // [事务] mountedRef 在挂载时置 true、卸载时置 false；异步回调写 state 前
  // 必须先看它，否则会触发 React 的“对已卸载组件 setState”警告（守住 INV-07）。
  // [并发] 复用同一个 ref 而不是每次新建：StrictMode 下会执行一次“挂载→卸载→挂载”，
  // 复用才能让第二次挂载恢复为 true。
  const mountedRef = useRef(true);
  useEffect(() => {
    // [资源] 这里用空依赖只注册一次清理函数：它必须在整个组件生命周期内始终有效，
    // 若随依赖变化重建，两次注册之间的空窗期会漏掉一次卸载标记（守住 INV-07）。
    // [失败路径] 清理不区分 StrictMode 的模拟卸载：ref 置 false 后再次挂载
    // 会被 effect 重新置 true，因此不会出现“异步回调永久沉默”的副作用。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // 相对时间必须随时钟更新，不能依赖连接事件才重绘。
  // [资源] 60s 心跳只在面板挂载期间存在，卸载必须 clearInterval（守住 INV-09）；
  // 频率刻意慢于秒级，避免长列表每秒重渲染。
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  // [事务] error 是面板级唯一错误位：所有 run() 失败都会覆盖它，展示在顶部横幅；
  // 操作函数不再各自弹 toast（守住 INV-06）。
  // [并发] migrationReports 用 Record 按设备累积，只写不删（守住 INV-12）：
  // 同一设备的再次生成会覆盖旧报告，其它设备保持不变。
  const [error, setError] = useState<string | null>(null);
  const [migrationReports, setMigrationReports] = useState<
    Record<string, SourceServerMigrationReport | undefined>
  >({});

  // [事务] 快照 hook 是面板唯一的数据来源：snapshot/ready 由它维护，applySnapshot
  // 用于“写操作直接带回新快照”的快路径，refresh 只在没有返回值时使用（守住 INV-04）。
  // [失败路径] onError 只写入面板错误位，不抛出：快照读取失败不应让整块面板崩溃，
  // 用户仍可看到上一次成功的快照。
  const {
    snapshot,
    ready,
    applySnapshot,
    refresh: refreshSnapshot,
  } = useSourceServerManagementSnapshot(management, {
    onError: (cause) => setError(getSourceServerManagementErrorMessage(cause, intl.formatMessage)),
  });
  // [事务] 目标聚焦分三段：无 target 时清空已处理标记；未 ready 或已处理过则返回；
  // 真正滚动/聚焦后才记录 key（守住 INV-08）。
  // [并发] ready 是必须条件：卡片要等快照渲染出来才存在，提前查 ref 永远拿不到元素。
  // [失败路径] 找不到卡片就返回且不记 key：设备可能在后续快照里才出现，
  // 记录成已处理会让它永远不再被聚焦。
  // [事务] 聚焦到失败设备时顺带打开错误详情：用户从外部跳转进来通常就是为了看失败原因。
  // [资源] deviceCardsRef 只存 DOM 引用，随卡片卸载被覆盖，不额外持有监听。
  const focusedTargetRef = useRef<string | undefined>(undefined);
  // [资源] deviceCardsRef 是“sourceServerId → DOM”的索引，仅供外部跳转时聚焦；
  // 卡片卸载必须删除对应项，否则会聚焦到一个已脱离文档的节点。
  const deviceCardsRef = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (!targetSourceServerId) {
      focusedTargetRef.current = undefined;
      return;
    }
    const targetKey = `${targetSourceServerId}:${targetSourceServerDetails}`;
    if (!ready || focusedTargetRef.current === targetKey) return;
    const card = deviceCardsRef.current.get(targetSourceServerId);
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.focus({ preventScroll: true });
    const failedProfileId = snapshot?.states.find(
      (state) => state.sourceServerId === targetSourceServerId && state.state === "failed",
    )?.profileId;
    const failedProfile = snapshot?.profiles.find(
      (profile) => profile.profileId === failedProfileId,
    );
    if (targetSourceServerDetails && failedProfile) setErrorDetailsProfile(failedProfile);
    focusedTargetRef.current = targetKey;
    onTargetSourceServerFocused?.();
  }, [
    ready,
    snapshot,
    targetSourceServerId,
    targetSourceServerDetails,
    onTargetSourceServerFocused,
  ]);
  // [并发] 日志订阅只按 profileId 列表重建：列表内容不变时 hook 内部保持连接，
  // 传入新数组会触发一次无意义的重新订阅。
  // [资源] 订阅在组件卸载时由 hook 释放；这里不额外保存返回值。
  // [失败路径] 某条连接的日志不存在时返回空数组，由渲染侧显示“暂无日志”，
  // 不影响其它连接。
  const { logsByProfileId } = useSourceServerOperationLogs(
    management,
    snapshot?.profiles.map((profile) => profile.profileId),
  );
  // [事务] 投影统一走 buildRemoteWorkspaceProjection（守住 INV-13）：面板与侧边栏
  // 必须得到同一份 workspace 列表，任何本地拼装都会造成两处展示不一致。
  // [并发] tabs 传空数组：设置页不是 tab 宿主，用它来补全会把“已打开但未持久化”
  // 的临时工作区泄漏进项目列表。
  const projection = useMemo(
    () =>
      buildRemoteWorkspaceProjection({
        managementSnapshot: snapshot,
        tabs: [],
        remoteConversationWorkspaceBySourceServerId:
          settings?.remoteConversationWorkspaceBySourceServerId,
      }),
    [snapshot, settings?.remoteConversationWorkspaceBySourceServerId],
  );
  // [事务] refresh 只是快照 hook 的透传：不要在面板层加节流或去重，
  // 去重需要知道“哪些操作已有返回值”，而那是 run() 的职责。
  const refresh = useCallback(async () => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  // [并发] 用 Map 建 profileId → state 索引，避免在渲染里对每条连接做 O(n) 查找；
  // 依赖只取 states 数组本身，快照的其它字段变化不会重建索引。
  const stateByProfile = useMemo(
    () => new Map(snapshot?.states.map((state) => [state.profileId, state]) ?? []),
    [snapshot?.states],
  );

  // [事务] run 是所有写操作的唯一入口，固定为「查重 → 占位 → 执行 → 应用快照 → 释放」。
  // [并发] 两个查重条件都必须有：key 精确防同操作重入，scopes 防同设备的不同操作并发。
  // [并发] 占位必须在 await 之前同步写入 ref，否则同一帧的第二次点击看到的是旧 Map。
  // [失败路径] 失败只写 error，不 rethrow：调用方都是 UI 事件处理器，抛出会成为
  // 未捕获 rejection 且用户看不到任何提示。
  // [事务] 有返回值才 applySnapshot，否则 refresh；这是快/慢两条路径（守住 INV-04）。
  // [资源] finally 里删除占位并重建 Map；缺少这一步会让设备永久忙碌（守住 INV-03）。
  // [权衡] 失败时不清空已有快照：让用户继续看到上一次成功的连接列表，
  // 比清空成错误页更有用。
  const run = useCallback(
    async (
      key: string,
      operation: () => Promise<SourceServerManagementSnapshot | void>,
      scopes: readonly string[] = [key],
    ) => {
      // 同设备的不同连接互斥；无关设备和日志查看独立，不用全局锁阻塞长时间更新。
      // [并发] 这里必须同步判 ref：两次点击可能发生在同一帧，state 还没刷新，
      // 用 busyOperations 判断会让第二次点击穿透（守住 INV-02）。
      // [失败路径] 命中查重时静默返回而不是提示“正在执行”：重复点击是误操作，
      // 弹 toast 反而像在报错。
      if (operationsRef.current.has(key) || scopes.some(hasBusyScope)) return;
      operationsRef.current.set(key, scopes);
      setBusyOperations(new Map(operationsRef.current));
      // [事务] 新操作开始即清空上一次错误：错误横幅描述的是“最近一次操作”，
      // 不清空会让用户误以为当前操作也失败了。
      setError(null);
      try {
        // [事务] 快路径与慢路径的分支必须在这里闭合：有返回值就直接应用，
        // 没有才 refresh；反过来先 refresh 会多一次全量拉取并在慢网络上回退 UI。
        // [失败路径] operation 抛出的错误交给 catch 统一处理，此处不做局部 try。
        const nextSnapshot = await operation();
        if (nextSnapshot) applySnapshot(nextSnapshot);
        else refreshSnapshot();
      } catch (cause) {
        setError(getSourceServerManagementErrorMessage(cause, intl.formatMessage));
      } finally {
        operationsRef.current.delete(key);
        setBusyOperations(new Map(operationsRef.current));
      }
    },
    // [事务] 依赖里保留 hasBusyScope：它是 useCallback 稳定的只读判据，
    // 省略会让 run 捕获旧的 scope 判断逻辑（扩展互斥规则时会失效）。
    [applySnapshot, refreshSnapshot, intl, hasBusyScope],
  );

  // [事务] 删除连接必须先确认再执行（守住 INV-05）：确认文案里带上展示名/传输方式，
  // 避免用户删错同名连接。
  // [失败路径] 用户取消时直接 return，不写 error 也不占用 scope：取消是正常路径。
  // [并发] key 与 scope 都用 profileOperationScope：同一设备下的其它连接
  // 也会被正确阻塞。
  const removeProfile = useCallback(
    async (profile: ConnectionProfile) => {
      if (!management) return;
      // [失败路径] management 缺失时直接返回：只读宿主没有删除能力，
      // 此时弹确认框会让用户以为可以删，确认后再无下文更令人困惑。
      // [事务] 确认框必须在 run 之外 await：run 的 scope 一旦占住，
      // 用户犹豫期间整台设备都会被标记忙碌。
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.source.removeProfileTitle" }),
        description: intl.formatMessage(
          { id: "settings.source.removeProfileDescription" },
          { name: profile.displayName ?? profile.transport },
        ),
        confirmLabel: intl.formatMessage({
          id: "settings.source.removeProfile",
        }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      // [事务] 删除成功后 Host 回传新快照，run 走快路径；若宿主实现只返回 void，
      // 才由 run 回落到 refresh（守住 INV-04）。
      await run(`remove:${profile.profileId}`, () => management.removeProfile(profile.profileId), [
        profileOperationScope(profile),
      ]);
    },
    [confirmDialog, intl, management, run],
  );

  // [事务] 删除源服务器是不可逆操作：确认框必须说明“其下所有连接会一起删除”，
  // 只写“删除设备”会让用户误以为连接还在。
  // [并发] 整个设备是一个 scope，删除期间该设备下的所有连接操作都被阻塞。
  // [失败路径] 删除失败后不清空本地展开态与报告：用户重试时上下文仍在。
  const removeSourceServer = useCallback(
    async (server: SourceServerRecord) => {
      if (hasBusyScope(`source:${server.sourceServerId}`)) return;
      // [事务] 影响范围要按 workspace 历史反解归属，不能只看 tab 的字段：
      // tab 可能来自旧版本、尚未写入 sourceServerId（守住 INV-13 的同一套归一逻辑）。
      // [失败路径] workspaceTabs 是外部传入的快照，可能滞后；这里只用于提示文案，
      // 真正的删除由 Host 做幂等处理，不据此拦截。
      const affectedProjects = workspaceTabs.filter(
        (tab) =>
          getWorkspaceSourceServerId(tab, { workspaceHistory: snapshot?.workspaceHistory }) ===
          server.sourceServerId,
      );
      const projectNotice =
        affectedProjects.length > 0
          ? intl.formatMessage(
              { id: "settings.source.removeOpenProjects" },
              {
                projects: affectedProjects
                  .map((tab) => `${tab.label} (${tab.workspacePath})`)
                  .join("\n"),
              },
            )
          : intl.formatMessage({ id: "settings.source.noOpenProjects" });
      const confirmed = await confirmDialog({
        title: intl.formatMessage({
          id: "settings.source.removeSourceServer",
        }),
        description:
          intl.formatMessage(
            { id: "settings.source.removeSourceServerDescription" },
            { name: server.displayName },
          ) +
          "\n\n" +
          projectNotice,
        confirmLabel: intl.formatMessage({
          id: "settings.source.removeSourceServer",
        }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      // [并发] key 与 scope 前缀不同：key 用于精确防重（同一设备只能有一次删除），
      // scope 用于粗粒度互斥（该设备上的连接/更新/迁移都要被挡住）。
      await run(
        `remove-source:${server.sourceServerId}`,
        () => management.removeSourceServer(server.sourceServerId),
        [`source:${server.sourceServerId}`],
      );
    },
    [confirmDialog, intl, management, run, snapshot?.workspaceHistory, workspaceTabs, hasBusyScope],
  );

  // [事务] 迁移报告按需生成：只在用户展开某一设备时请求，避免一次性为所有设备
  // 跑迁移分析（代价高且大多无人查看）。
  // [并发] 报告写回 Record 时按 sourceServerId 覆盖，不影响其它设备（守住 INV-12）。
  // [失败路径] 生成失败只写 error，不删除旧报告：旧报告仍有参考价值。
  const loadMigrationReport = useCallback(
    async (sourceServerId: string) => {
      if (!management) return;
      await run(`report:${sourceServerId}`, async () => {
        // [事务] 报告在 run 内部写入 state：scope 释放与数据落地同属一个事务边界，
        // 这样同一设备的并发展开不会出现“报告已写、忙碌未清”的中间态。
        // [失败路径] 契约要求返回 migrationCounts 之外的完整快照，缺失时 run 会走
        // refresh 慢路径，因此这里不再手动补一次全量拉取（守住 INV-04）。
        const report = await management.getMigrationReport(sourceServerId);
        setMigrationReports((current) => ({ ...current, [sourceServerId]: report }));
      });
    },
    [management, run],
  );

  // [事务] 展开与加载是两件事：展开只切 UI，加载才发请求；已有报告时直接展开，
  // 避免每次折叠/展开都重新生成。
  // [失败路径] 加载失败仍保持展开，让用户看到错误与重试入口，而不是悄悄折回去。
  const toggleMigrationReport = useCallback(
    (sourceServerId: string) => {
      if (migrationReports[sourceServerId]) {
        setMigrationReports((current) => {
          const next = { ...current };
          delete next[sourceServerId];
          return next;
        });
        return;
      }
      void loadMigrationReport(sourceServerId);
    },
    [loadMigrationReport, migrationReports],
  );

  // [事务] 迁移操作（真正的数据搬迁）必须独占设备 scope：它与连接/删除
  // 不能并行，否则会在搬迁过程中改写源目录。
  // [并发] 操作完成后用返回快照刷新，保证设备列表立刻反映新的源服务器。
  // [失败路径] 失败写入面板错误位并保留报告，用户可据报告内容决定是否重试。
  const runMigrationOperation = useCallback(
    async (
      key: string,
      sourceServerId: string,
      operation: () => Promise<SourceServerMigrationReport>,
    ) => {
      await run(key, async () => {
        // [事务] 迁移类操作一律以设备作为 scope：搬迁/放弃/重试都会改写该设备下的
        // 工作区归属，与连接、删除共享同一个互斥域（守住 INV-15）。
        // [失败路径] 操作抛错时不写报告：保留上一份成功结果，用户可对照着重试。
        const report = await operation();
        setMigrationReports((current) => ({ ...current, [sourceServerId]: report }));
      }, [`source:${sourceServerId}`]);
    },
    [run],
  );

  // [事务] 更新连接走 run 的“带返回值”快路径：Host 会回传新快照，避免再拉一次全量。
  // [并发] 用 profileOperationScope(profile) 而不是 key 里的 profileId：
  // 同一设备下的更新与删除必须互斥。
  // [失败路径] 失败时保留编辑弹窗（由调用方决定），面板只负责把错误写进 error；
  // 直接关闭弹窗会让用户丢失刚填的内容。
  const updateProfile = useCallback(
    async (profile: ConnectionProfile) => {
      await run(
        `update:${profile.profileId}`,
        async () => {
          // [事务] 强制更新可能改写宿主二进制，必须先确认再执行；确认文案由
          // getSourceServerForceUpdateDescription 动态生成，不能写死。
          // [失败路径] 更新失败要给出“查看详情”的 toast：更新可跨面板生命周期完成，
          // 面板可能已卸载，此时必须把查看动作交给 onShowUpdateDetails。
          // [并发] 失败后再 throw，让 run() 统一写 error 并释放 scope；toast 只是补充信息。
          let next: SourceServerManagementSnapshot | null;
          try {
            // [并发] 强制更新确认框在 run 内部弹出是被允许的：该分支只会在
            // scope 已占位后出现，用户等待期间重复点击会被 run 的查重直接挡掉。
            // [失败路径] 用户取消强制更新时 runSourceServerUpdate 会返回 null，
            // 视为“无需更新”，不得当成失败去写 error。
            next = await runSourceServerUpdate({
              management,
              profileId: profile.profileId,
              confirmForce: async () =>
                await confirmDialog({
                  title: intl.formatMessage({
                    id: "settings.source.forceUpdateTitle",
                  }),
                  description: await getSourceServerForceUpdateDescription(
                    management,
                    profile.profileId,
                    (id) => intl.formatMessage({ id }),
                  ),
                  confirmLabel: intl.formatMessage({
                    id: "settings.source.forceUpdate",
                  }),
                  confirmVariant: "destructive",
                }),
            });
          } catch (cause) {
            // [失败路径] 先 toast 再 throw：toast 负责让用户知道“哪台设备更新失败”，
            // throw 负责让 run 写面板错误并释放 scope，两者缺一都会丢失信息。
            // [并发] onAction 里按 mountedRef 分叉：面板还在就开详情弹窗，
            // 已卸载则交给全局回调，绝不能对已卸载组件 setState（守住 INV-07）。
            toast(
              intl.formatMessage(
                { id: "sourceServer.updateFailedToast" },
                { source: profile.displayName ?? profile.transport },
              ),
              {
                variant: "warning",
                actionLabel: intl.formatMessage({ id: "remote.action.details" }),
                onAction: () => {
                  // 更新可跨面板生命周期完成，不能让全局 toast 捕获已卸载组件的 setter。
                  if (mountedRef.current) setErrorDetailsProfile(profile);
                  else if (profile.sourceServerId) onShowUpdateDetails?.(profile.sourceServerId);
                },
              },
            );
            throw cause;
          }
          // [事务] 只有 next 非空才提示“更新完成”：null 表示无需更新（已是最新），
          // 此时弹完成提示会让用户以为刚装了什么。
          if (next)
            toast(
              intl.formatMessage(
                { id: "sourceServer.updateCompletedToast" },
                { source: profile.displayName ?? profile.transport },
              ),
              { variant: "source-server-update" },
            );
          // [事务] 无更新时返回 undefined 而不是 null：run 以真值判断是否走
          // applySnapshot 快路径，null 会被当成“有返回值”的空快照应用。
          return next ?? undefined;
        },
        [profileOperationScope(profile)],
      );
    },
    [confirmDialog, intl, management, onShowUpdateDetails, run],
  );

  // [事务] 三个派生列表一次性算清：active / retired / unbound 互不重叠，
  // 渲染时直接按类遍历，避免在 JSX 里反复 filter 造成 N 次遍历。
  // [并发] 全部以 snapshot 为准，不在本地缓存：删除/退役后必须立刻从列表消失。
  // [失败路径] snapshot 为空时退化为空数组，首次加载显示空态而不是报错。
  const servers = snapshot?.servers ?? [];
  const profiles = snapshot?.profiles ?? [];
  // [事务] 列表按生命周期三分：active（在用）、retired（已退役，仅存档展示）、
  // unbound（还没绑定到设备）。三类互斥，渲染与操作都按类分别处理。
  // [并发] 全部从同一份 snapshot 派生，避免三处各自 filter 得到不一致的结果。
  const activeProfiles = profiles.filter((profile) => profile.lifecycleState !== "retired");
  const retiredProfiles = profiles.filter((profile) => profile.lifecycleState === "retired");
  // [事务] 未绑定连接单独成区：它们没有设备卡片的宿主，无法参与设备级操作，
  // 只能“连接”或“删除”，因此必须与设备列表分开渲染。
  // [失败路径] 设备删除后其连接会落到这里（sourceServerId 被清空），
  // 这段同时承担“孤儿连接”的兜底展示。
  const unboundProfiles = activeProfiles.filter((profile) => !profile.sourceServerId);

  // [事务] 身份确认按钮是“安全动作”，必须同时受两条条件约束：该连接 scope 不忙，
  // 且状态不是 updating；只判其中一条会在更新期间允许确认，导致身份写回被覆盖。
  // [并发] 点击后经 confirmDialog 二次确认才调用 run，scope 用 profileOperationScope。
  // [失败路径] 未确认时返回 undefined，不发起请求、不占 scope、不写错误。
  const renderIdentityConfirmation = (profile: ConnectionProfile, size: "sm" | "xs") => (
    <Button
      type="button"
      variant="outline"
      // [权衡] 这里用 outline 而非 primary：身份确认不是日常主路径，
      // 高亮它会让用户误以为“必须点一下才能继续使用”。
      size={size}
      disabled={
        busyScopes.has(profileOperationScope(profile)) ||
        stateByProfile.get(profile.profileId)?.state === "updating"
      }
      // [失败路径] 确认框 promise 链里用三元返回 undefined，避免把取消当成
      // 未处理的 rejection；run 的 finally 仍会正常释放 scope。
      // [事务] 身份确认只写回该连接的信任指纹，不重建连接：用户无需重新输入凭据。
      onClick={() =>
        void confirmDialog({
          title: intl.formatMessage({ id: "settings.source.identityChangeTitle" }),
          description: intl.formatMessage({ id: "settings.source.identityChangeDescription" }),
          confirmLabel: intl.formatMessage({ id: "settings.source.identityChangeConfirm" }),
        }).then((confirmed) =>
          confirmed
            ? run(
                `identity:${profile.profileId}`,
                () => management.confirmIdentityChange(profile.profileId),
                [profileOperationScope(profile)],
              )
            : undefined,
        )
      }
    >
      {busyOperations.has(`identity:${profile.profileId}`) ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : null}
      {intl.formatMessage({ id: "settings.source.identityChangeConfirm" })}
    </Button>
  );

  // [事务] 设备卡片的主动作完全由 presentation.primaryAction 决定，面板不自行推断
  // “该显示连接还是更新”；推断逻辑集中在 remoteConnectionPresentation。
  // [并发] security/details 不受忙碌限制：用户在任何时候都应该能查看错误与安全信息；
  // 其余动作在 scope 忙碌时直接返回，防止重复点击。
  // [失败路径] disconnect 缺少 onDisconnectSource 时静默不处理，而不是抛错：
  // 该回调在只读宿主里可能不存在。
  // [失败路径] connect 的默认分支必须包在 run 里：连接是长操作，需要占住设备 scope，
  // 否则用户会在连接过程中再次点击。
  const handleProfileAction = (
    profile: ConnectionProfile,
    presentation: RemoteConnectionPresentation,
    server?: SourceServerRecord,
  ) => {
    if (
      !["security", "details"].includes(presentation.primaryAction) &&
      hasBusyScope(profileOperationScope(profile))
    )
      return;
    // [事务] switch 必须覆盖 presentation 的全部取值：default 分支当作“连接”处理，
    // 新增动作类型若忘了在这里映射，会静默退化成重连而不是报错。
    // [失败路径] 每个分支要么 return 要么 void run，绝不能让控制流落到下一个 case：
    // 否则一次点击会触发两个动作（例如同时更新并断开）。
    switch (presentation.primaryAction) {
      // [事务] update-desktop 走平台级命令更新本机二进制，因此按全局操作处理而不挂到某个设备。
      // 与具体设备记录无关，因此不占设备 scope，也不写设备错误。
      // [失败路径] platform 缺失时操作是空转，但不报错：Web 端没有桌面命令通道。
      case "update-desktop":
        void run("desktop-update", async () => {
          await platform?.executeDesktopCommand(DesktopCommandIds.CheckForUpdates);
        });
        return;
      case "update-server":
        void updateProfile(profile);
        return;
      // [并发] 断开按设备而不是按连接记录：同设备的其它连接会一起下线，
      // 因此 key 用 disconnect:sourceServerId，重复点击会被 run 挡住。
      // [失败路径] 缺少 sourceServerId 说明是孤儿连接，没有可断开的会话，直接跳过。
      case "disconnect":
        if (profile.sourceServerId && onDisconnectSource)
          void run(
            `disconnect:${profile.sourceServerId}`,
            () => onDisconnectSource(profile.sourceServerId!),
            [profileOperationScope(profile)],
          );
        return;
      // [事务] 凭据与地址分开聚焦：同一个编辑弹窗按 focusField 决定初始焦点，
      // 依赖错误类型不同，用户需要修改的字段也不同。
      // [并发] 编辑不占 scope：它只改本地草稿，真正写回发生在弹窗保存时（走 run）。
      // [失败路径] 传 server 是为了让弹窗回填设备级默认值，缺失时按纯连接编辑处理。
      case "credentials":
      case "edit-auth":
        setEditingConnection({ profile, server, focusField: "auth" });
        return;
      case "edit-host":
        setEditingConnection({ profile, server, focusField: "host" });
        return;
      case "security":
      case "details":
        setErrorDetailsProfile(profile);
        return;
      case "none":
        return;
      default:
        void run(
          `connect:${profile.profileId}`,
          async () => {
            await onConnectProfile?.(profile.profileId);
          },
          [profileOperationScope(profile)],
        );
    }
  };

  // [事务] renderProfile 只做“读取 + 组合”：所有状态都从快照与投影派生，
  // 不在渲染期写 state（唯一例外是父级 effect 触发的聚焦/详情弹窗）。
  // [并发] mutationBusy 合并了两类信号：本面板操作与 presentation.status === connecting；
  // 只判其一会让“别处正在连”的设备仍可被点击。
  // [失败路径] actionBusy 在 security/details 时强制为 false：即使设备正忙，
  // 用户也必须能查看错误详情。
  // [失败路径] connectionErrorText 只在“设备级错误不属于当前连接”时展示，
  // 否则同一错误会在每条连接上重复出现。
  const renderProfile = (profile: ConnectionProfile, server?: SourceServerRecord) => {
    const state = stateByProfile.get(profile.profileId);
    // [失败路径] 查不到 state 不视为错误：快照里可能只有连接记录、还没有状态
    // （刚创建尚未连接），此时按离线渲染并给出“连接”按钮。
    const isOnline = state?.state === "online";
    const identityChangePending = state?.state === "identity-change-pending";
    const profileName = profile.displayName ?? profile.transport;
    const presentation = resolveRemoteConnectionPresentation({ ...state, target: profile.target });
    const mutationBusy =
      busyScopes.has(profileOperationScope(profile)) || presentation.status === "connecting";
    const actionBusy =
      mutationBusy && !["security", "details"].includes(presentation.primaryAction);
    // [事务] 设备级 presentation 单独计算：它描述整台设备的主状态，
    // 而 connectionErrorText 要判断“当前错误是否属于这条连接”，两者不能混用。
    // [失败路径] 没有 server 时不计算设备级状态，避免把连接错误误判为设备错误。
    const devicePresentation = server
      ? resolveRemoteConnectionPresentation(
          getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
        )
      : null;
    const connectionErrorText =
      presentation.reason && devicePresentation?.profileId !== profile.profileId
        ? intl.formatMessage({ id: presentation.reason.titleId }, presentation.reason.values)
        : null;
    // [事务] 行容器整体由 profileId 标识：删除/新增连接时 React 必须按记录复用
    // 而不是按位置复用，否则焦点与 hover 态会漂移到别的连接上。
    // [权衡] 每行独立计算 presentation，而不是在父级批量算：连接数量通常很少，
    // 换来实现上的直观与“行内数据自洽”。
    return (
      <div
        key={profile.profileId}
        className="group/line -mx-2 flex min-w-0 flex-wrap items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover"
        // [并发] key 用 profileId 而不是索引：列表会因删除而重排，
        // 索引 key 会让错误详情/展开态错位到另一条连接上。
        // [权衡] flex-wrap 让窄屏下操作按钮自动换行，不隐藏任何按钮：
        // 隐藏会让用户在手机上找不到断开/编辑入口。
        // [事务] hover 高亮只做视觉反馈，不承载任何状态判断。
      >
        <RemoteConnectionKindTag kind={profile.transport} />
        {!server ? <RemoteConnectionStatusTag presentation={presentation} /> : null}
        <span className="shrink-0 text-ui-sm font-medium text-foreground">{profileName}</span>
        <span className="min-w-0 truncate font-mono text-ui-xs text-remote-foreground-muted">
          {formatConnectionProfileTarget(profile)}
        </span>
        {server?.preferredProfileId === profile.profileId ? (
          <span className="shrink-0 rounded-md bg-tag px-2 py-0.5 text-ui-xs text-remote-foreground-muted">
            {intl.formatMessage({ id: "settings.source.defaultProfile" })}
          </span>
        ) : null}
        <span className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          {connectionErrorText ? (
            <span
              className="max-w-64 truncate text-ui-xs text-destructive-surface-foreground"
              // [事务] 错误文案优先于“最后连接时间”：同时存在时说明当前连接有问题，
              // 展示时间会掩盖真正的失败原因。
              title={connectionErrorText}
            >
              {connectionErrorText}
            </span>
          ) : profile.lastConnectedAt ? (
            <span
              className="text-ui-xs text-remote-foreground-muted"
              // [权衡] 相对时间做主文案，绝对时间放 title：列表扫读要的是“多久之前”，
              // 精确时间只在悬停时才有价值。
              title={formatTimestamp(profile.lastConnectedAt, locale)}
            >
              {intl.formatMessage(
                { id: "settings.source.lastConnected" },
                {
                  time: formatRelativeTimestamp(
                    profile.lastConnectedAt,
                    locale,
                    intl.formatMessage,
                  ),
                },
              )}
            </span>
          ) : null}
          {!isOnline && !identityChangePending ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              // [事务] 离线且无待确认身份时才显示“连接”类主动作：
              // 在线时该位置应留给断开/查看，重复出现会让人误点导致重连。
              // [并发] disabled 只跟随 actionBusy，不跟随设备级忙碌：
              // 同一设备下其它连接的操作不应禁用这条连接的按钮。
              disabled={actionBusy}
              onClick={() =>
                handleProfileAction(
                  profile,
                  resolveRemoteConnectionPresentation({
                    ...stateByProfile.get(profile.profileId),
                    target: profile.target,
                  }),
                )
              }
            >
              {intl.formatMessage({
                id: resolveRemoteConnectionPresentation({ ...state, target: profile.target })
                  .actionMessageId,
              })}
            </Button>
          ) : null}
          {identityChangePending ? renderIdentityConfirmation(profile, "xs") : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            // [权衡] 编辑用 ghost：它是低频的维护动作，主按钮应留给连接/断开。
            // [并发] 忙碌时禁用编辑，避免在连接过程中改写凭据导致握手中断。
            aria-label={intl.formatMessage({
              id: "settings.source.editConnection",
            })}
            disabled={busyScopes.has(profileOperationScope(profile))}
            onClick={() => setEditingConnection({ profile })}
          >
            <Pencil className="size-3.5" />
            {intl.formatMessage({ id: "settings.source.editConnection" })}
          </Button>
          {server && server.preferredProfileId !== profile.profileId ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              // [事务] 仅当该连接不是设备首选时展示“设为默认”：首选线路本身不需要
              // 这个按钮，显示它会让用户以为当前默认还没设置成功。
              // [并发] 走 run 并占 profileOperationScope：切换偏好与删除
              // 必须互斥，否则可能把已删除的连接设为默认。
              disabled={mutationBusy}
              onClick={() =>
                void run(
                  `preferred:${profile.profileId}`,
                  () => management.setPreferredProfile(server.sourceServerId, profile.profileId),
                  [profileOperationScope(profile)],
                )
              }
            >
              {intl.formatMessage({ id: "settings.source.setDefault" })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            // [失败路径] 删除入口在 mutationBusy 时禁用，但不禁用“查看详情”：
            // 删除按钮按 mutationBusy 禁用，但查看详情必须保持可点，方便用户看到出错原因。
            disabled={mutationBusy}
            onClick={() => void removeProfile(profile)}
          >
            <Trash2 className="size-3.5" />
            {intl.formatMessage({ id: "settings.source.removeProfile" })}
          </Button>
        </span>
      </div>
    );
  };

  // [事务] aria-busy 汇总“面板内有任何在途操作”，屏幕阅读器据此提示区域正在更新；
  // 它不参与禁用判断，具体按钮能否点击仍由各自的 scope 决定。
  // [并发] 这里读的是 state 投影而不是 operationsRef：渲染期必须依赖可变状态才会重绘。
  // [失败路径] 渲染阶段不发起任何请求，所有数据来自快照与已有 state。
  // [权衡] 面板不做整体骨架屏：局部加载态（未完成连接、更新横幅）比整块闪烁更稳。
  return (
    <div className="flex flex-col gap-4" aria-busy={busyOperations.size > 0}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({ id: "settings.remoteDevicesDescription" })}
          </p>
          {error ? (
            <p role="alert" className="mt-2 text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {onCreateConnection && (!ready || profiles.length > 0 || servers.length > 0) ? (
          <Button type="button" size="sm" onClick={onCreateConnection}>
            <Plus className="size-3.5" />
            {intl.formatMessage({ id: "settings.source.newConnection" })}
          </Button>
        ) : null}
      </div>
      {background &&
      !servers.some((server) => server.sourceServerId === background.sourceServerId) &&
      !unboundProfiles.some((profile) => profile.profileId === background.profileId) ? (
        <section
          data-unfinished-background-connection
          className="rounded-xl border border-card-border bg-card pt-3"
          // [事务] 这段只在“后台连接不属于任何已展示设备/连接”时出现：
          // 否则同一设备会出现两条进度（卡片内一条、这里一条）。
        >
          <p className="px-4 text-ui-sm font-medium">
            {intl.formatMessage({ id: "settings.source.unfinishedConnections" })}
          </p>
          <RemoteConnectionMinimizedProgress {...background} />
        </section>
      ) : null}
      {!ready && !error ? (
        <p
          role="status"
          className="flex items-center gap-2 text-ui-sm text-remote-foreground-muted"
          // [失败路径] 加载态与错误态互斥（!error）：错误已展示时再显示 spinner
          // 会让用户以为“还在试”，而实际上已经停了。
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      <div className="min-w-0 space-y-3">
        {servers.length > 0 ? (
          <h3 className="flex items-center gap-2 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.source.devicesHeading" })}
            <span className="text-ui-xs font-normal text-remote-foreground-muted">
              {servers.length}
            </span>
          </h3>
        ) : null}
        {servers.map((server) => {
          const device = projection.devices.find(
            (candidate) => candidate.sourceServerId === server.sourceServerId,
          );
          const serverProfiles = device?.profiles ?? [];
          const preferredProfile =
            serverProfiles.find((profile) => profile.profileId === server.preferredProfileId) ??
            serverProfiles[0];
          // 旧 Source 在确认前仍可能是 uninstalled；恢复入口不能藏在安装状态或首选线路折叠后面。
          // [事务] 身份待确认必须独立于在线/首选线路计算：设备安装状态可能是
          // uninstalled，但身份确认入口仍必须可见，否则用户无法完成恢复。
          const pendingIdentityProfiles = serverProfiles.filter(
            (profile) => stateByProfile.get(profile.profileId)?.state === "identity-change-pending",
          );
          const identityChangeProfile =
            pendingIdentityProfiles.find((profile) => profile === preferredProfile) ??
            pendingIdentityProfiles[0];
          // [事务] 当前在线连接优先展示，其次才回落到设备首选：一个设备可能同时
          // 有多条可用线路，展示首选会让用户误以为在线的是另一条。
          const currentProfile = serverProfiles.find(
            (profile) => stateByProfile.get(profile.profileId)?.state === "online",
          );
          const displayedProfile = currentProfile ?? preferredProfile;
          // [权衡] 图标按传输方式分三档（docker/wsl/其它=SSH）：这是用户唯一
          // 能一眼区分连接类型的视觉线索，缺失时会退化为通用 Server 图标。
          const ConnectionIcon =
            displayedProfile?.transport === "docker"
              ? Box
              : displayedProfile?.transport === "wsl"
                ? TerminalSquare
                : Server;
          // 同一项目可能有多条历史（不同连接），保留最近一次，并按最近打开倒序展示。
          // [并发] 同一项目可能有多条历史（不同连接路径），按 resolveWorkspaceKey
          // 归一后只保留 lastOpenedAt 最新的一条，避免列表出现重复项目。
          // [事务] 用 Map 做“后写覆盖”而不是排序后去重：历史数组本身无序，
          // 只能逐项比较时间。
          const latestProjectByKey = new Map<string, SourceServerWorkspaceHistoryEntry>();
          for (const project of device?.knownProjects ?? []) {
            const key = resolveWorkspaceKey(project);
            const existing = latestProjectByKey.get(key);
            if (!existing || project.lastOpenedAt >= existing.lastOpenedAt)
              latestProjectByKey.set(key, project);
          }
          const projects = [...latestProjectByKey.values()].sort(
            (left, right) => right.lastOpenedAt - left.lastOpenedAt,
          );
          const projectsExpanded = expandedProjectSources.has(server.sourceServerId);
          // [事务] 项目可见性由“未安装设备一律隐藏”与“最多展示 N 条”两条规则合成：
          // 前者是为了避免给未安装设备显示一个点不开的路径，后者是为了控制卡片高度。
          // [失败路径] 设备状态缺失时按“未安装”处理：宁可少显示，也不展示不可用入口。
          const visibleProjects = projectsExpanded
            ? projects
            : projects.slice(0, COLLAPSED_PROJECT_COUNT);
          // [事务] “已打开”判定只读 workspaceTabs，不读本地记忆：tab 是当前窗口
          // 的事实源，本地记忆会跨窗口串味。
          // [并发] 用 resolveWorkspaceKey 的 sourceServerId 比对而不是路径前缀：
          // 同路径可能被不同设备挂载。
          const openedProjectPaths = new Set(
            workspaceTabs
              .filter(
                (tab) =>
                  getWorkspaceSourceServerId(tab, {
                    workspaceHistory: snapshot?.workspaceHistory,
                  }) === server.sourceServerId,
              )
              .map((tab) => tab.workspacePath),
          );
          // [事务] “其它连接”要排除当前展示的那条与待确认身份的那些：
          // 否则同一连接会在主行和折叠区各出现一次，删除时容易点错。
          const otherProfiles = displayedProfile
            ? serverProfiles.filter(
                (profile) =>
                  profile !== displayedProfile && !pendingIdentityProfiles.includes(profile),
              )
            : [];
          const online = device?.aggregatedStatus === "online";
          const migrationReport = migrationReports[server.sourceServerId];
          const migrationCount = snapshot?.migrationCounts.find(
            (count) => count.sourceServerId === server.sourceServerId,
          );
          const showServerLines = server.installState !== "uninstalled";
          // 覆盖可更新/必须升级/更新中/更新失败四态：更新中不再携带 updateAvailability，也要选中。
          const profileStates = serverProfiles
            .map((profile) => stateByProfile.get(profile.profileId))
            .filter((state) => state !== undefined);
          // [事务] 设备主状态由 shared 的 presentation 纯函数裁决，面板不自行推导：
          // “连接/更新/查看错误”的优先级规则必须在桌面与 Web 端保持一致。
          // [失败路径] presentation.reason 同时用于主按钮与错误文案，
          // 两处必须引用同一个对象，避免按钮说“重试”而文案说“已失败”。
          const presentation = resolveRemoteConnectionPresentation(
            getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
          );
          const actionProfile =
            serverProfiles.find((profile) => profile.profileId === presentation.profileId) ??
            preferredProfile;
          // [并发] 设备级忙碌只看 source: scope；连接级忙碌另算。合并成一个布尔
          // 会让“设备正在更新”把每条连接的操作按钮都禁掉。
          const deviceBusy = busyScopes.has(`source:${server.sourceServerId}`);
          // [并发] actionBusy 聚合四种在途操作：断开按设备记，连接/更新按 profile 记，
          // 桌面更新按全局 key 记；漏掉任一类都会出现“按钮可点但请求被 run 拒绝”的死点击。
          const actionBusy =
            busyOperations.has(`disconnect:${server.sourceServerId}`) ||
            busyOperations.has(`connect:${actionProfile?.profileId}`) ||
            busyOperations.has(`update:${actionProfile?.profileId}`) ||
            (busyOperations.has("desktop-update") &&
              presentation.primaryAction === "update-desktop");
          const preferredConnectionErrorText = presentation.reason
            ? intl.formatMessage({ id: presentation.reason.titleId }, presentation.reason.values)
            : null;
          // [事务] 状态选取优先“更新中”，其次“任一可更新/必须升级”：两者同时存在时
          // 必须展示进度条，而不是重复的“有新版本”按钮。
          const serverState =
            profileStates.find((state) => state.state === "updating") ??
            profileStates.find(
              (state) =>
                (state.updateAvailability && state.updateAvailability !== "none") ||
                state.state === "updating",
            );
          const updateFailed = serverState?.state === "failed";
          // [事务] updateKey 由设备 id 与目标版本拼接：版本变化后“稍后提醒”应当失效，
          // 只按设备记 key 会让新版本永远被旧的延迟偏好挡住。
          const updateKey = sourceServerUpdateKey(
            server.sourceServerId,
            serverState?.availableVersion ?? "",
          );
          // [权衡] “稍后提醒”只抑制“可选更新”，不抑制“必须升级”与“更新中”：
          // 推迟一个安全更新是可以接受的，推迟强制升级会让连接直接不可用。
          const showUpdate =
            serverState &&
            !(
              serverState.updateAvailability === "available" &&
              serverState.state !== "updating" &&
              deferredUpdates.has(updateKey)
            );

          const updateFailureText =
            updateFailed && serverState
              ? formatRemoteConnectionError({
                  fallback: intl.formatMessage({ id: "settings.source.operationFailed" }),
                  reasonCode: serverState.errorCode,
                  retryable: serverState.retryable,
                  recoveryAttempt: serverState.recoveryAttempt,
                  recoveryLimit: serverState.recoveryLimit,
                  formatMessage: intl.formatMessage,
                })
              : null;
          // [事务] 判断“更新失败是不是本次连接失败的原因”要三个条件同时成立：
          // 有更新、profile 对得上、失败文案完全一致；只比对状态会把无关的
          // 历史更新失败也当成当前连接错误。
          // [失败路径] 文案比较完全相等是刻意的：两边都来自同一个格式化函数，
          // 若字符串不等，说明它们描述的是不同错误。
          const updateExplainsConnectionError = Boolean(
            showUpdate &&
            serverState?.profileId === presentation.profileId &&
            (serverState?.state === "updating" ||
              (updateFailed && updateFailureText === preferredConnectionErrorText) ||
              (serverState?.updateAvailability === "required" &&
                presentation.reason?.category === "source-server-upgrade-required")),
          );

          // [并发] 日志按 serverState 的 profile 优先、其次主操作 profile 取：
          // 更新中的日志属于被更新的那条连接，不能用首选线路去查。
          const operationLogs =
            logsByProfileId[serverState?.profileId ?? actionProfile?.profileId ?? ""] ?? [];
          const showOtherProfiles = showServerLines && otherProfiles.length > 0;
          const otherProfilesExpanded =
            showOtherProfiles && expandedSavedConnectionSources.has(server.sourceServerId);
          // 更新中由更新横幅展示进度与日志，页脚不重复。
          const showRecentLog = operationLogs.length > 0 && serverState?.state !== "updating";
          // [事务] 日志默认展开条件是“用户显式切换过”，否则仅在设备失败时自动展开：
          // 成功的连接每天都会产生日志，全展开会把页面撑到无法浏览（守住 INV-10）。
          // [并发] 按 sourceServerId 记录而不是 profileId：日志视图是按设备聚合的
          // （守住 INV-11）。
          const logExpanded =
            showRecentLog &&
            (logExpansionBySource.get(server.sourceServerId) ?? presentation.status === "failed");
          return (
            <section
              key={server.sourceServerId}
              data-source-server-card={server.sourceServerId}
              tabIndex={-1}
              // [资源] ref 回调在卸载时传 null，必须同时从 Map 删除：
              // 只写不删会让已卸载的 DOM 一直被引用（内存泄漏 + 聚焦到幽灵元素）。
              // [并发] tabIndex=-1 让卡片可被程序聚焦但不进入 Tab 顺序，
              // 供外部“跳转到设备”使用。
              ref={(element) => {
                if (element) deviceCardsRef.current.set(server.sourceServerId, element);
                else deviceCardsRef.current.delete(server.sourceServerId);
              }}
              className="overflow-hidden rounded-xl border border-card-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
            >
              {background?.sourceServerId === server.sourceServerId ? (
                <RemoteConnectionMinimizedProgress {...background} />
              ) : null}
              <div className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-4">
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface text-remote-foreground-muted",
                    server.installState === "uninstalled" && "opacity-60",
                  )}
                  // [权衡] 未安装设备只降透明度而不隐藏图标：隐藏后卡片会失去
                  // 左侧对齐基准，整行看起来像坏掉了。
                  // [并发] 图标由 displayedProfile 的传输方式决定，切换在线连接时
                  // 会跟着变，它是当前展示连接的属性而不是设备属性。
                >
                  <ConnectionIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-ui-base font-semibold text-foreground">
                      {server.displayName}
                    </p>
                    <RemoteConnectionStatusTag presentation={presentation} />
                  </div>
                </div>
                <div
                  className="order-2 basis-full min-w-0 flex flex-wrap items-center gap-2 text-ui-sm text-remote-foreground-muted"
                  data-device-connection
                  // [事务] order-2/basis-full 让连接信息独占一行：它与项目列表、
                  // 操作按钮在同一 flex 容器里，不能挤在一行否则窄屏会换行错位。
                  // [并发] 这里只展示 displayedProfile 一条连接，其余连接在折叠区，
                  // 避免同一设备出现多行相同地址。
                >
                  {displayedProfile ? (
                    <>
                      <RemoteConnectionKindTag kind={displayedProfile.transport} />
                      <span
                        className="min-w-0 truncate font-mono"
                        title={formatConnectionProfileTarget(displayedProfile)}
                        // [权衡] 地址用 mono 并截断：长 SSH 地址会把整行撑破，
                        // 完整值放 title 供悬停查看。
                      >
                        {formatConnectionProfileTarget(displayedProfile)}
                      </span>
                      {/* 只有一条连接时“当前 / 默认”没有区分意义，不显示。 */}
                      {serverProfiles.length > 1 && currentProfile ? (
                        <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">
                          {intl.formatMessage({
                            id: "settings.source.currentProfile",
                          })}
                        </span>
                      ) : null}
                      {serverProfiles.length > 1 &&
                      displayedProfile.profileId === server.preferredProfileId ? (
                        <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">
                          {intl.formatMessage({ id: "settings.source.defaultProfile" })}
                        </span>
                      ) : null}
                      {displayedProfile.profileId !== server.preferredProfileId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          // [事务] 设备级忙碌（deviceBusy）而不是连接级：切换默认线路
                          // 会改写 Source 记录，与同一设备上的任何写操作都冲突。
                          disabled={deviceBusy}
                          onClick={() =>
                            void run(
                              `preferred:${displayedProfile.profileId}`,
                              () =>
                                management.setPreferredProfile(
                                  server.sourceServerId,
                                  displayedProfile.profileId,
                                ),
                              [`source:${server.sourceServerId}`],
                            )
                          }
                        >
                          {intl.formatMessage({ id: "settings.source.setDefault" })}
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  {server.lastSeenVersion ? (
                    <span
                      className="shrink-0"
                      title={intl.formatMessage({ id: "settings.source.info.version" })}
                      // [权衡] 版本号去掉前缀 v 再拼回，避免上游数据自带 v 时出现 vv1.2.3；
                      // 只在渲染时用 server.lastSeenVersion.replace(/^v/i, "") 去前缀，存储值保持上游原样。
                    >
                      {displayedProfile ? "· " : ""}v{server.lastSeenVersion.replace(/^v/i, "")}
                    </span>
                  ) : null}
                  {server.lastOnlineAt && !online ? (
                    <span className="shrink-0" title={formatTimestamp(server.lastOnlineAt, locale)}>
                      {displayedProfile || server.lastSeenVersion ? "· " : ""}
                      {intl.formatMessage(
                        { id: "settings.source.lastOnline" },
                        {
                          time: formatRelativeTimestamp(
                            server.lastOnlineAt,
                            locale,
                            intl.formatMessage,
                          ),
                        },
                      )}
                    </span>
                  ) : null}
                </div>
                <div className="order-3 basis-full min-w-0" data-device-projects>
                  {projects.length === 0 ? (
                    <p className="text-ui-sm text-remote-foreground-muted">
                      {intl.formatMessage({ id: "settings.source.projectCount" }, { count: 0 })}
                    </p>
                  ) : (
                    <>
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <p className="text-ui-xs font-medium text-remote-foreground-muted">
                          {intl.formatMessage({ id: "settings.source.recentProjects" })}
                        </p>
                        {/* Bug 原因：旧实现超出三个只显示不可点击的 +N，其余项目在此处无法打开。 */}
                        {projects.length > COLLAPSED_PROJECT_COUNT ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="text-remote-foreground-muted"
                            aria-expanded={projectsExpanded}
                            onClick={() =>
                              setExpandedProjectSources((current) =>
                                toggleSetItem(current, server.sourceServerId),
                              )
                            }
                          >
                            {intl.formatMessage(
                              {
                                id: projectsExpanded
                                  ? "settings.source.showLessProjects"
                                  : "settings.source.showAllProjects",
                              },
                              { count: projects.length },
                            )}
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-1 min-w-0">
                        {visibleProjects.map((project) => {
                          // [事务] 项目显示名优先取设备声明的 label，其次才是路径叶子：
                          // 用户可以给同一路径起别名，展示路径会丢掉这层语义。
                          // [失败路径] 找不到声明时回落 getPathLeaf，绝不返回空串：
                          // 空标题会让整行看起来像一条坏数据。
                          const projectName =
                            server.declaredWorkspaces?.find(
                              (item) => item.workspacePath === project.workspacePath,
                            )?.label ?? getPathLeaf(project.workspacePath);
                          return (
                            <Button
                              key={resolveWorkspaceKey(project)}
                              data-device-project
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="group/project -mx-2 h-auto w-[calc(100%+1rem)] min-w-0 justify-start gap-2 px-2 py-1.5"
                              // [事务] disabled 同时受 deviceBusy 与“是否有打开回调”约束：
                              // 只读宿主的 onOpenProject 为 undefined，按钮必须体现不可用。
                              // [并发] run 的 scope 是设备级：打开项目与更新设备互斥，
                              // 避免在设备重启过程中拉取工作区。
                              // [失败路径] onOpenProject 缺失时 Promise.resolve() 兜底，
                              // 而不是抛错，保证 run 的 finally 仍能正常释放。
                              // [失败路径] 项目行整体不可点击时仍保留 aria-label：
                              // 项目行在 disabled 时仍挂 aria-label={projectName}，让读屏用户听得到条目而不是整条消失。
                              aria-label={projectName}
                              title={project.workspacePath}
                              disabled={!onOpenProject || deviceBusy}
                              onClick={() =>
                                void run(
                                  `open:${resolveWorkspaceKey(project)}`,
                                  () =>
                                    onOpenProject?.(
                                      server.sourceServerId,
                                      project.workspacePath,
                                      displayedProfile?.profileId,
                                    ) ?? Promise.resolve(),
                                  [`source:${server.sourceServerId}`],
                                )
                              }
                            >
                              <Folder className="size-3.5 text-remote-foreground-muted" />
                              <span className="max-w-48 shrink-0 truncate text-ui-sm font-medium">
                                {projectName}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-left font-mono text-ui-xs text-remote-foreground-muted">
                                {project.workspacePath}
                              </span>
                              {openedProjectPaths.has(project.workspacePath) ? (
                                <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs text-remote-foreground-muted">
                                  {intl.formatMessage({ id: "settings.source.projectOpened" })}
                                </span>
                              ) : null}
                              <span className="shrink-0 text-ui-xs text-remote-foreground-muted">
                                {formatRelativeTimestamp(
                                  project.lastOpenedAt,
                                  locale,
                                  intl.formatMessage,
                                )}
                              </span>
                              <ArrowUpRight className="size-3.5 text-remote-foreground-muted opacity-0 group-hover/project:opacity-100 group-focus-visible/project:opacity-100" />
                            </Button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
                <div className="order-1 ml-auto flex flex-wrap items-center gap-1">
                  {presentation.primaryAction === "confirm-identity" && identityChangeProfile ? (
                    renderIdentityConfirmation(identityChangeProfile, "sm")
                  ) : presentation.primaryAction !== "none" ? (
                    <Button
                      type="button"
                      // 已连接时断开是低频操作，降为 ghost；任务继续提示放进按钮说明，不常驻占行。
                      variant={presentation.primaryAction === "disconnect" ? "ghost" : "outline"}
                      size="sm"
                      // [事务] 主按钮的禁用条件必须与 handleProfileAction 的分支一致：
                      // security/details 即使设备忙碌也要可点，其余动作要禁用。
                      // [并发] aria-busy 只跟随 actionBusy 而不含 deviceBusy：
                      // 设备级后台任务不应让主按钮显示成“正在执行本操作”。
                      // [权衡] 只有断开才附带 title 说明：连接/更新按钮的语义已经由文案表达，
                      // 再挂 tooltip 会让鼠标悬停变成噪声。
                      title={
                        presentation.primaryAction === "disconnect"
                          ? intl.formatMessage({ id: "settings.source.disconnectHint" })
                          : undefined
                      }
                      disabled={
                        (deviceBusy &&
                          !["security", "details"].includes(presentation.primaryAction)) ||
                        actionBusy ||
                        presentation.status === "connecting"
                      }
                      aria-busy={actionBusy}
                      onClick={() => {
                        if (actionProfile) handleProfileAction(actionProfile, presentation, server);
                        else onCreateConnection?.();
                      }}
                    >
                      {actionBusy ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : null}
                      {intl.formatMessage({
                        id:
                          server.installState === "uninstalled" &&
                          presentation.primaryAction === "install"
                            ? "settings.source.reinstallAndConnect"
                            : presentation.actionMessageId,
                      })}
                    </Button>
                  ) : null}
                  {presentation.primaryAction === "update-desktop" && preferredProfile ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      // [事务] 桌面端更新失败时提供“重连当前线路”作为兜底动作：
                      // 它不改动二进制，只重建连接，是用户此刻唯一可自救的操作。
                      // [并发] 用连接级 scope 而不是设备级：重连不应该阻塞
                      // 同一设备上其它连接的操作。
                      disabled={deviceBusy}
                      aria-busy={busyOperations.has(`connect:${preferredProfile.profileId}`)}
                      onClick={() =>
                        void run(
                          `connect:${preferredProfile.profileId}`,
                          async () => {
                            await onConnectProfile?.(preferredProfile.profileId);
                          },
                          [profileOperationScope(preferredProfile)],
                        )
                      }
                    >
                      {busyOperations.has(`connect:${preferredProfile.profileId}`) ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : null}
                      {intl.formatMessage({ id: "remote.action.connect" })}
                    </Button>
                  ) : null}
                  {displayedProfile ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      // [事务] 主行编辑只传 profile（不传 server），表示“仅改这条连接”；
                      // 设备级字段（名称/图标）走设备菜单，两者不能混在一个弹窗里。
                      aria-label={intl.formatMessage({
                        id: "settings.source.editConnection",
                      })}
                      disabled={deviceBusy}
                      onClick={() =>
                        setEditingConnection({
                          profile: displayedProfile,
                          server,
                        })
                      }
                    >
                      <Pencil className="size-3.5" />
                      {intl.formatMessage({ id: "settings.source.editConnection" })}
                    </Button>
                  ) : null}
                  {
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          // [权衡] 设备菜单是低频但危险动作的集合，用 icon 按钮收敛；
                          // 文字按钮会让卡片操作区过宽。
                          aria-label={intl.formatMessage({ id: "common.more" })}
                        >
                          <Ellipsis className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        // [权衡] 菜单右对齐：触发按钮在卡片最右侧，左对齐会超出视口。
                        // [事务] min-w 与 nowrap 由菜单统一控制，避免每条 item 自己写
                        // 截断样式导致中英文文案换行不一致。
                        align="end"
                        className="w-max min-w-64 [&_[data-slot=dropdown-menu-item]]:whitespace-nowrap"
                        // [事务] 菜单内容对“已安装/未安装”都渲染（特别是移除入口）：
                        // 离线设备的移除不依赖远端在线，Host 会先幂等断开再删记录。
                        // [并发] “在侧边栏显示”仍保留在线条件：离线设备没有可展示的会话。
                      >
                        {/*
                          Bug 原因：「移除全部连接」曾被包在 online 分支里，简化 UI 删掉离线态的
                          「重命名 / 迁移报告」后离线菜单变成空壳，离线设备再无任何移除入口。
                          移除只删本机记录与凭据，Host removeSourceServer 会先幂等断开再删记录，
                          不依赖远端在线；因此对所有已安装状态都渲染，只有「在侧边栏中显示」保留在线条件。
                        */}
                        {onShowInSidebar &&
                        workspaceTabs.some(
                          (tab) =>
                            getWorkspaceSourceServerId(tab, {
                              workspaceHistory: snapshot?.workspaceHistory,
                            }) === server.sourceServerId,
                        ) ? (
                          <>
                            <DropdownMenuItem
                              onSelect={() => onShowInSidebar(server.sourceServerId)}
                            >
                              <ListTree className="size-3.5" />
                              {intl.formatMessage({
                                id: "settings.source.showInSidebar",
                              })}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        ) : null}
                        <div
                          className="max-w-80 space-y-1 px-2 py-2 text-ui-sm text-remote-foreground-muted"
                          data-device-info
                          // [权衡] 信息区放在菜单里而不是卡片上：它是排障时才需要的数据，
                          // 常驻会稀释连接状态与项目列表的信息密度。
                          // [事务] 四行信息的字段顺序即优先级：版本/主机名/系统用户/设备 id，
                          // 用户排查问题时通常先看版本与主机名。
                          // [失败路径] 缺失值统一显示“暂不可用”，不隐藏整行：
                          // 行缺失会让用户以为字段被删了。
                        >
                          {[
                            ["version", server.lastSeenVersion],
                            ["hostname", server.hostname],
                            ["osUser", server.osUser],
                            ["deviceId", server.sourceServerId],
                          ].map(([key, value]) => (
                            <p key={key} className="break-all whitespace-normal">
                              <span>
                                {intl.formatMessage({ id: `settings.source.info.${key}` })}:{" "}
                              </span>
                              {value ?? intl.formatMessage({ id: "remote.infoUnavailable" })}
                            </p>
                          ))}
                        </div>
                        <DropdownMenuItem
                          onSelect={() =>
                            void run(`copy:${server.sourceServerId}`, async () => {
                              // [失败路径] clipboard 在非安全上下文会 reject，
                              // 交给 run 统一写 error，避免静默失败。
                              await navigator.clipboard.writeText(server.sourceServerId);
                            })
                          }
                        >
                          <Copy className="size-3.5" />
                          {intl.formatMessage({ id: "settings.source.copyDeviceId" })}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          // [事务] 移除设备是破坏性动作，禁用条件用设备级忙碌：
                          // 迁移/更新期间删除会让 Host 正在使用的记录消失。
                          // [失败路径] 点击后仍要经过 removeSourceServer 的确认框，
                          // 菜单本身不直接执行删除。
                          disabled={deviceBusy}
                          onSelect={() => void removeSourceServer(server)}
                        >
                          <Trash2 className="size-3.5" />
                          {intl.formatMessage({
                            id: "settings.source.removeSourceServer",
                          })}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                </div>
              </div>
              {/* 更新失败只替代同一连接的相同原因，其他连接和可选更新不能吞掉连接错误。 */}
              {preferredConnectionErrorText && !updateExplainsConnectionError ? (
                <div className="mx-4 mb-3 rounded-md bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground">
                  {preferredConnectionErrorText}
                </div>
              ) : null}
              {showUpdate && serverState ? (
                <div
                  className={cn(
                    "mx-4 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-ui-sm",
                    presentation.updateNotice.surface,
                    presentation.updateNotice.foreground,
                  )}
                  // [事务] 更新横幅的配色由 presentation.updateNotice 提供，不在这里
                  // 按状态硬编码：四态的底色/前景是产品统一规范。
                  // [失败路径] 文案优先级：进行中 > 失败 > 必须升级 > 可选版本；
                  // 顺序反了会让“更新中”显示成“有新版本”。
                  // [并发] 更新中只渲染进度组件，不渲染“稍后/更新”按钮：
                  // 并发点击会让同一设备发起两次更新。
                >
                  <span>
                    {serverState.state === "updating"
                      ? intl.formatMessage({
                          id: "settings.source.updateInProgress",
                        })
                      : updateFailed
                        ? updateFailureText
                        : serverState.updateAvailability === "required"
                          ? intl.formatMessage({
                              id: "settings.source.updateRequired",
                            })
                          : intl.formatMessage(
                              { id: "settings.source.updateAvailableVersion" },
                              {
                                version: serverState.availableVersion?.replace(/^v/i, "") ?? "",
                              },
                            )}
                  </span>
                  {serverState.updateAvailability === "available" &&
                  serverState.state !== "updating" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      // [事务] “稍后”只写本地延迟偏好，不发任何网络请求：
                      // 它不代表忽略更新，刷新后会重新评估（守住 INV-10 的派生约定）。
                      onClick={() => sourceServerUpdatePreferences.defer(updateKey)}
                    >
                      {intl.formatMessage({ id: "updateDialog.later" })}
                    </Button>
                  ) : null}
                  {serverState.state !== "updating" &&
                  presentation.primaryAction !== "update-server" &&
                  presentation.primaryAction !== "update-desktop" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      // [事务] 升级分为“更新桌面端”与“更新源服务器”两条路径：
                      // upgradeTarget 决定走哪条，不能靠按钮文案反推。
                      // [并发] 桌面更新用全局 key "desktop-update"，与设备操作共享
                      // 同一个互斥域，避免同时触发两次宿主更新。
                      disabled={deviceBusy || busyOperations.has("desktop-update")}
                      onClick={() => {
                        // [事务] 必须按 serverState.profileId 找回连接再更新：
                        // 主操作线路可能不是被更新的那条，用 actionProfile 会更新错对象。
                        // [并发] 两条分支各自占 scope：桌面更新是全局，源更新走连接级。
                        // [失败路径] profile 找不到时不做任何事，而不是退化成更新首选线路：
                        // 静默改错连接比“没反应”更糟。
                        const profile = serverProfiles.find(
                          (candidate) => candidate.profileId === serverState.profileId,
                        );
                        if (serverState.upgradeTarget === "controller")
                          void run("desktop-update", async () => {
                            await platform?.executeDesktopCommand(
                              DesktopCommandIds.CheckForUpdates,
                            );
                          });
                        else if (profile) void updateProfile(profile);
                      }}
                    >
                      {intl.formatMessage({
                        id:
                          serverState.upgradeTarget === "controller"
                            ? "remote.action.update-desktop"
                            : updateFailed
                              ? "remote.action.retry"
                              : "remote.action.update-server",
                      })}
                    </Button>
                  ) : null}
                  {serverState.state === "updating" ? (
                    <SourceServerUpdateActivity
                      active={serverState.state === "updating"}
                      // [并发] active 与顶部判定同源（state==="updating"），
                      // 不另设 prop，避免出现“横幅说更新中、日志说已结束”。
                      logs={operationLogs}
                    />
                  ) : serverState.currentVersion && serverState.minimumVersion ? (
                    <p className="basis-full text-ui-xs opacity-80">
                      {intl.formatMessage(
                        { id: "settings.source.versionDetails" },
                        {
                          current: serverState.currentVersion.replace(/^v/i, ""),
                          minimum: serverState.minimumVersion.replace(/^v/i, ""),
                        },
                      )}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {pendingIdentityProfiles.length > 1 ? (
                <div className="border-t border-border px-4 py-2">
                  {pendingIdentityProfiles
                    .filter((profile) => profile !== identityChangeProfile)
                    .map((profile) => renderProfile(profile, server))}
                </div>
              ) : null}
              {showOtherProfiles || showRecentLog ? (
                <div className="border-t border-border px-4 py-2" data-device-card-footer>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {showOtherProfiles ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-ml-2 text-remote-foreground-muted"
                        aria-label={intl.formatMessage({
                          id: "settings.source.otherSavedConnections",
                        })}
                        aria-expanded={otherProfilesExpanded}
                        onClick={() =>
                          setExpandedSavedConnectionSources((current) =>
                            toggleSetItem(current, server.sourceServerId),
                          )
                        }
                      >
                        {otherProfilesExpanded ? (
                          <ChevronDown className="size-3.5" />
                        ) : (
                          <ChevronRight className="size-3.5" />
                        )}
                        {intl.formatMessage(
                          { id: "settings.source.otherSavedConnectionsCount" },
                          { count: otherProfiles.length },
                        )}
                      </Button>
                    ) : null}
                    {showRecentLog ? (
                      <Button
                        data-source-server-log-toggle
                        type="button"
                        variant="ghost"
                        size="sm"
                        // 只有日志入口时靠左，避免页脚左侧空出一整行。
                        className={cn(
                          "text-remote-foreground-muted",
                          showOtherProfiles ? "-mr-2 ml-auto" : "-ml-2",
                        )}
                        aria-expanded={logExpanded}
                        onClick={() =>
                          setLogExpansionBySource((current) =>
                            new Map(current).set(server.sourceServerId, !logExpanded),
                          )
                        }
                      >
                        <ChevronRight
                          className={cn(
                            "size-3.5 transition-transform",
                            logExpanded && "rotate-90",
                          )}
                        />
                        {intl.formatMessage({ id: "settings.source.recentLog" })}
                      </Button>
                    ) : null}
                  </div>
                  {otherProfilesExpanded ? (
                    <div className="mt-1 px-2 py-1">
                      {otherProfiles.map((profile) => renderProfile(profile, server))}
                    </div>
                  ) : null}
                  {logExpanded ? (
                    <div className="mt-1 pb-1">
                      <SourceServerLogList logs={operationLogs} />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {/* 产品边界：迁移账本是内部兼容机制，仅在存在待处理问题时以用户可理解的连接历史提醒暴露。 */}
              {showServerLines &&
              migrationCount?.status === "available" &&
              migrationCount.failedPathCount + migrationCount.abandonedPathCount > 0 ? (
                <div className="border-t border-border">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    // [权衡] 迁移提醒条用 ghost + 通栏：它是提示而不是主操作，
                    // 用主色按钮会把用户的注意力从连接问题上抢走。
                    // [事务] 点击只切换报告展开，不发起任何写操作（生成报告走 loadMigrationReport）。
                    className="w-full justify-start rounded-none px-4 py-2.5 text-ui-sm text-remote-foreground-muted"
                    onClick={() => toggleMigrationReport(server.sourceServerId)}
                  >
                    {migrationReport ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                    <FileWarning className="size-3.5 text-warning" />
                    {intl.formatMessage({
                      id: "settings.source.connectionHistoryNeedsAttention",
                    })}
                    <span className="font-medium text-warning">
                      {intl.formatMessage(
                        { id: "settings.source.pendingMigrationCount" },
                        {
                          count: migrationCount.failedPathCount + migrationCount.abandonedPathCount,
                        },
                      )}
                    </span>
                  </Button>
                  {migrationReport ? (
                    <SourceServerMigrationReportPanel
                      // [失败路径] disabled 用设备级忙碌：放弃/重试都会改写该设备的工作区归属，
                      // 与同一设备上的其它写操作共享互斥域。
                      report={migrationReport}
                      disabled={deviceBusy}
                      // [事务] 放弃迁移同样先确认再执行：它会删除该路径的迁移账本，
                      // 之后无法再自动重试，只能手工处理（守住 INV-05 的确认约定）。
                      // [失败路径] 用户取消时直接 return，不占 scope、不写错误。
                      onAbandon={(workspacePath, migrationId) => {
                        void confirmDialog({
                          title: intl.formatMessage({
                            id: "settings.source.abandonMigrationTitle",
                          }),
                          description: intl.formatMessage({
                            id: "settings.source.abandonMigrationDescription",
                          }),
                          confirmLabel: intl.formatMessage({
                            id: "settings.source.abandonMigration",
                          }),
                          confirmVariant: "destructive",
                        }).then((confirmed) => {
                          if (!confirmed) return;
                          void runMigrationOperation(
                            `abandon:${server.sourceServerId}:${migrationId}`,
                            server.sourceServerId,
                            () =>
                              management.abandonWorkspaceMigration(
                                server.sourceServerId,
                                workspacePath,
                                migrationId,
                              ),
                          );
                        });
                      }}
                      onRetry={(workspacePath, migrationId) =>
                        // [事务] 重试与放弃同属迁移操作，key 里带 migrationId 保证只重试这一条。
                        void runMigrationOperation(
                          `retry:${server.sourceServerId}:${migrationId}`,
                          server.sourceServerId,
                          () =>
                            management.retryWorkspaceMigration(
                              server.sourceServerId,
                              workspacePath,
                              migrationId,
                            ),
                        )
                      }
                    />
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
        {unboundProfiles.length > 0 ? (
          <details
            open={
              background &&
              !background.sourceServerId &&
              unboundProfiles.some((profile) => profile.profileId === background.profileId)
                ? true
                : undefined
            }
            data-unfinished-connections
            // [事务] open 是受控但不是常量：只有后台进度正好属于某条未绑定连接时才自动展开，
            // 否则保持原生 details 的折叠行为，由用户自己点击（不写死 open=true）。
            // [并发] 该 details 不参与 busyScopes 计算：它的展开状态纯 UI，不影响操作。
            // [失败路径] 后台进度结束后 open 变回 undefined，但用户手动展开的状态仍保留，
            // 因为这里没有绑定 onToggle 去强行改写 DOM 的 open 属性。
            className="group/unfinished border-t border-border pt-4"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 text-ui-base font-medium">
              <ChevronRight className="size-3.5 transition-transform group-open/unfinished:rotate-90" />
              {intl.formatMessage({ id: "settings.source.unfinishedConnections" })}
              <span className="rounded-md bg-tag px-1.5 py-0.5 text-ui-xs font-normal text-remote-foreground-muted">
                {unboundProfiles.length}
              </span>
            </summary>
            <div className="mt-2 space-y-2">
              {unboundProfiles.map((profile) => (
                <div key={profile.profileId}>
                  {renderProfile(profile)}
                  {background &&
                  !background.sourceServerId &&
                  background.profileId === profile.profileId ? (
                    <RemoteConnectionMinimizedProgress {...background} />
                  ) : null}
                  {(logsByProfileId[profile.profileId]?.length ?? 0) > 0 ? (
                    <SourceServerUpdateActivity
                      active={false}
                      recent
                      logs={logsByProfileId[profile.profileId] ?? []}
                    />
                  ) : null}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busyOperations.has("clear-unfinished") ||
                  unboundProfiles.some((profile) => busyScopes.has(profileOperationScope(profile)))
                }
                // [并发] 禁用条件同时包含自身 key 与所有未绑定连接的 scope：
                // 漏掉后者会在“某条连接正在连接中”时把它一并删掉。
                // [事务] 清理是批量删除，必须走全局确认框；这是唯一不按单个 profile 确认的入口，
                // 因此在确认文案里明确“全部未完成连接”。
                // [失败路径] 删除中途某条失败时整个 run 进入 catch，已删除的不会回滚，
                // 但下一次刷新会反映真实结果，用户可重复执行剩余清理。
                onClick={() => {
                  void confirmDialog({
                    title: intl.formatMessage({ id: "settings.source.clearUnfinished" }),
                    description: intl.formatMessage({
                      id: "settings.source.clearUnfinishedDescription",
                    }),
                    confirmLabel: intl.formatMessage({ id: "settings.source.clearUnfinished" }),
                    confirmVariant: "destructive",
                  }).then((confirmed) => {
                    if (confirmed)
                      void run(
                        "clear-unfinished",
                        async () => {
                          // [事务] 必须重新拉一次快照再删：面板里的 unboundProfiles 是点击时的
                          // 旧视图，期间某条连接可能刚成功并绑定了设备。
                          // [失败路径] 逐条 await 删除并应用返回快照，中途失败即中断；
                          // 已完成的删除已经生效，不尝试补偿回滚（Host 无此接口）。
                          // 清理时复核归属，连接刚成功的设备不能被旧列表误删。
                          const latest = await management.getSnapshot();
                          for (const profile of latest.profiles) {
                            if (!profile.sourceServerId && profile.lifecycleState !== "retired")
                              applySnapshot(await management.removeProfile(profile.profileId));
                          }
                        },
                        unboundProfiles.map(profileOperationScope),
                      );
                  });
                }}
              >
                {intl.formatMessage({ id: "settings.source.clearUnfinished" })}
              </Button>
            </div>
          </details>
        ) : null}
        {retiredProfiles.length > 0 ? (
          <details className="group/retired border-t border-border pt-4">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-ui-base font-medium text-foreground">
              <ChevronRight className="size-3.5 shrink-0 text-remote-foreground-muted transition-transform group-open/retired:rotate-90" />
              {intl.formatMessage(
                { id: "settings.source.retiredProfilesWithCount" },
                { count: retiredProfiles.length },
              )}
              <span className="text-ui-xs font-normal text-remote-foreground-muted">
                {intl.formatMessage({
                  id: "settings.source.retiredProfilesDescription",
                })}
              </span>
            </summary>
            <div className="mt-2 space-y-1 pl-6">
              {retiredProfiles.map((profile) => (
                <div
                  key={profile.profileId}
                  className="flex min-w-0 flex-wrap items-center gap-2 py-1.5 text-remote-foreground-muted"
                >
                  <span className="font-mono text-ui-sm">
                    {profile.displayName ?? profile.transport}
                    {intl.formatMessage({
                      id: "settings.source.retiredNameSuffix",
                    })}
                  </span>
                  <span className="text-ui-xs">
                    {profile.retiredAt
                      ? `${intl.formatMessage(
                          { id: "settings.source.archivedAt" },
                          {
                            time: formatRelativeTimestamp(
                              profile.retiredAt,
                              locale,
                              intl.formatMessage,
                            ),
                          },
                        )} · ${intl.formatMessage({
                          id: "settings.source.retiredEntryNote",
                        })}`
                      : intl.formatMessage({
                          id: "settings.source.retiredEntryNote",
                        })}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <section className="border-t border-border pt-4">
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({
              id: "settings.source.connectionPreferences",
            })}
          </h3>
          <div className="mt-3 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-ui-sm text-foreground">
                  {intl.formatMessage({
                    id: "settings.source.startupAutoReconnect",
                  })}
                </p>
                <p className="text-ui-xs text-remote-foreground-muted">
                  {intl.formatMessage({
                    id: "settings.source.startupAutoReconnectDescription",
                  })}
                </p>
              </div>
              <Switch
                // [事务] 受控开关：checked 永远来自 state，点击只触发“乐观更新 + 写回”，
                // 不允许 Switch 自己维护内部值（否则 settings 回填会被覆盖）。
                // [并发] busy 时禁用：写回在途期间再次切换会让两次写入竞争，
                // 最终值取决于响应顺序而不是用户最后一次点击。
                // [失败路径] 写回失败时回滚到 previous，并把错误交给 run 统一展示。
                checked={startupAutoReconnect}
                disabled={busyOperations.has("startup-reconnect") || !onUpdateSettings}
                aria-busy={busyOperations.has("startup-reconnect")}
                onCheckedChange={(checked) => {
                  const previous = startupAutoReconnect;
                  setStartupAutoReconnect(checked);
                  // [事务] 先记 previous 再写乐观值：回滚必须回到“点击前”的值，
                  // 而不是检查当前值（并发下当前值可能已被别处改写）。
                  // [并发] run 的 key 固定为 startup-reconnect：同一设置的并发写回只允许一次。
                  void run("startup-reconnect", async () => {
                    try {
                      await onUpdateSettings?.({ remoteStartupAutoReconnectEnabled: checked });
                    } catch (cause) {
                      setStartupAutoReconnect(previous);
                      throw cause;
                    }
                  });
                }}
                aria-label={intl.formatMessage({
                  id: "settings.source.startupAutoReconnect",
                })}
              />
            </div>
          </div>
        </section>
        {ready && profiles.length === 0 && servers.length === 0 ? (
          <div className="space-y-3 py-4 text-center text-ui-sm text-remote-foreground-muted">
            <p>{intl.formatMessage({ id: "settings.source.empty" })}</p>
            {onCreateConnection ? (
              <Button type="button" size="sm" onClick={onCreateConnection}>
                <Plus className="size-3.5" />
                {intl.formatMessage({ id: "settings.source.newConnection" })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog
        open={Boolean(errorDetailsProfile)}
        // [事务] 只处理关闭方向：open=true 由 state 驱动，回调里不能再写一遍，
        // 否则会与 setErrorDetailsProfile(profile) 形成两次渲染。
        // [失败路径] 关闭时清空整个对象而不是保留最后一次详情：
        // 连接可能已被删除，残留数据会在下次打开时闪现旧错误。
        onOpenChange={(open) => {
          if (!open) setErrorDetailsProfile(null);
        }}
      >
        <DialogContent>
          {errorDetailsProfile
            ? (() => {
                // [事务] 弹窗内容用 IIFE 是为了在渲染期就地派生局部变量，
                // 不给组件再引入一份“弹窗专用 state”造成双份数据源。
                // [失败路径] state 可能已被快照移除（连接删除后详情仍打开），
                // 此时 errorCode/error 为空，分类会退化到 target 的推断结果。
                // [并发] 弹窗打开期间快照仍可能刷新，这里的读取每次渲染都重新执行，
                // 保证展示的是最新状态而不是打开瞬间的快照。
                const state = stateByProfile.get(errorDetailsProfile.profileId);
                // [失败路径] 分类结果只用于标题与描述文案，不参与任何控制流；
                // 未识别的错误码会走通用标题，绝不能因此不渲染详情。
                const classified = classifyRemoteConnectionError({
                  errorCode: state?.errorCode,
                  error: state?.error,
                  target: errorDetailsProfile.target,
                });
                return (
                  <>
                    <DialogHeader>
                      <DialogTitle>{intl.formatMessage({ id: classified.titleId })}</DialogTitle>
                      <DialogDescription>
                        {intl.formatMessage({ id: classified.reasonId })}
                      </DialogDescription>
                    </DialogHeader>
                    <details>
                      <summary>{intl.formatMessage({ id: "remote.error.details" })}</summary>
                      <pre className="whitespace-pre-wrap break-words text-ui-sm">
                        {state?.error ?? errorDetailsProfile.lastConnectError}
                      </pre>
                    </details>
                    <SourceServerUpdateActivity
                      active={false}
                      recent
                      logs={logsByProfileId[errorDetailsProfile.profileId] ?? []}
                    />
                  </>
                );
              })()
            : null}
        </DialogContent>
      </Dialog>
      <EditConnectionProfileDialog
        open={editingConnection !== null}
        profile={editingConnection?.profile ?? null}
        source={editingConnection?.server}
        focusField={editingConnection?.focusField}
        // [事务] management 直接透传而不是包一层回调：弹窗内部自己调用写接口，
        // 面板不复制一份“保存”逻辑，避免两处校验规则不一致。
        // [并发] 关闭即清空目标：弹窗卸载后残留的 profile 会让下一次编辑
        // 先闪一帧上一条连接的数据。
        // [失败路径] 保存失败由弹窗内部处理（保留输入），面板只负责在 onSaved 后刷新。
        management={management}
        onOpenChange={(open) => {
          if (!open) setEditingConnection(null);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
