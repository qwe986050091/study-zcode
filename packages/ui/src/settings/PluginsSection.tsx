// ============================================================================
// PluginsSection —— 插件 / MCP / 技能 / 命令 四类能力设置的共享外壳
//
// 结构分两层：PluginsSection 负责 Scope（user / 具体 workspace）与 Tab 的编排，
// PluginList 负责插件列表、详情、安装/卸载/升级与配置草稿。市场数据来自
// pluginManagementStore 的 marketplaces + availablePlugins，已安装态来自
// installedPlugins + plugins，两者在 storeItemById 中按 id 合并。
//
// 不变量表（本文件维持或依赖；每条都对应一种「换个写法就出错」的具体故障）：
// INV-1: normalizePluginTab 必须把 commands 折回 plugins，因为 commands 不是插件 Tab 的一员。
//        破坏后果：保留 commands 会让 Tabs 的 value 落在不存在的 trigger 上，面板整块空白，
//        用户从命令入口切回时以为功能被移除。
// INV-2: 插件读写必须使用 targetServiceResolution 的服务，不能回退到当前 ServiceProvider。
//        破坏后果：在 B 的 Scope 下把 B 的路径发给 A 的 host，插件被装进另一个仓库。
// INV-3: storeMatchesTarget 必须同时比较 workspace key、authority 与 configScope 三者。
//        破坏后果：少比较 authority 时同路径的 remote/local 配置互相覆盖；少比较 scope 时
//        user 列表会渲染 workspace 的启用态。
// INV-4: storeMatchesTarget=false 时所有列表必须投影成空数组，不能保留上一帧数据。
//        破坏后果：切换 Scope 的过渡帧展示旧 Scope 的插件，用户可能在其上执行卸载。
// INV-5: storeItemById 是「市场元信息 + 本地安装信息」的唯一合并点，行内不得再各自拼装。
//        破坏后果：两处各拼一次，名称/更新徽标/菜单权限会来自不同来源，出现有更新但无按钮。
// INV-6: 详情页只有在 selectedPlugin 与 selectedStoreItem 同时存在且 rpcReady 时才渲染。
//        破坏后果：市场描述尚未返回就进入详情，会展示一个没有任何操作按钮的死页面。
// INV-7: selectedPluginId 必须在 targetKey 变化时清空，且选中项消失时也要关闭详情。
//        破坏后果：切换 workspace 后详情仍停留在上一个仓库的插件，配置保存到错误仓库。
// INV-8: 配置草稿里 null 是「清空该配置」的哨兵值，undefined 才是「没有草稿」。
//        破坏后果：把 null 当空值渲染，会丢掉用户的清除意图；把 undefined 当清空，
//        会在用户只改一个字段时把其他配置全部重置。
// INV-9: 保存配置时 options 与 clearOptionKeys 都为空必须直接返回，不发请求。
//        破坏后果：无操作保存会在 workspace 配置里制造空条目，后续「是否配置过」判断失真。
// INV-10: 保存失败时保留草稿（包括 null 清除意图），只在成功后删除草稿。
//         破坏后果：RPC 失败后界面看起来已提交，用户以为配置生效，实际仍是旧值。
// INV-11: 启用/禁用的单飞由 store 的 togglingPluginId 保证，行内只按它显示 loading 并禁用。
//         破坏后果：本地再维护一份 pending 会在 store 更新后失配，开关可连点，产生两次反向写入。
// INV-12: 卸载必须走 usePluginUninstall 的确认流程，onAfterUninstall 负责刷新。
//         破坏后果：绕过确认直接删目录，误触后无撤销；不刷新则列表仍显示已卸载插件。
// INV-13: 升级只在 store 没有 error 时刷新列表，失败时保留列表与错误供用户重试。
//         破坏后果：失败也刷新会让错误被一次成功的数据读取覆盖，用户不知道升级失败。
// INV-14: 市场入口只在 user Scope 显示；workspace Scope 只展示已安装配置。
//         破坏后果：在 workspace 下允许安装，会把包写进 workspace overlay，与 user 安装态分叉。
// INV-15: computerUse 的不可用占位只在 user Scope、非 loading、远程或 Linux 且搜索命中时出现。
//         破坏后果：桌面端也显示「不支持」，或搜索其他词时仍占位，列表看起来有空行。
// INV-16: 每个 Tab 的搜索词独立存储，切换 Tab 不得复用上一个 Tab 的 query。
//         破坏后果：在 MCP 页搜到一半切到技能，技能列表被同一关键词过滤成空。
// INV-17: mode 非 plugin 时 Tab 固定（fixedTab），交互式 Tab 状态只作为回退。
//         破坏后果：独立入口仍允许切换 Tab，用户会在 MCP 页里看到插件列表。
// INV-18: MCP/命令编辑器锁定的 Scope 失效（对应的 workspace tab 被关闭）时必须关闭编辑器，
//         并把 mcpTarget/commandTarget 置 null，绝不能回退到 preferredHost。
//         破坏后果：保存请求写到另一个项目，产生难以察觉的配置污染。
// INV-19: pickedScopeKey 指向的 workspace 消失时显式回退 user 并 toast，不得静默切换。
//         破坏后果：用户以为仍在看 workspace 配置，实际修改的是 user 级配置。
// INV-20: settingsSourceServerId 存在时 user Scope 的目标必须换成 source user 工作区。
//         破坏后果：来源设置页把改动写进本机 user 目录，而不是被查看的那台机器。
// INV-21: 各能力计数使用函数式更新并在值相同时返回原对象，避免无变化的重渲染。
//         破坏后果：每次子列表回调都新建对象，会让整页在滚动/刷新时反复渲染。
// INV-22: 面包屑与市场返回入口只在 plugin 模式且没有打开详情/编辑器时展示。
//         破坏后果：详情页顶部同时出现两级返回，点击后跳到错误层级。
// ============================================================================
import { useConfigWorkspaceTargets } from "@/workspace-config-catalog/index.js";
import { SettingsUserScopeProvider } from "@/settings/SettingsMachine.js";
/* eslint-disable max-lines -- 共享能力外壳聚合 Scope，并承载 Plugin tabs 与独立 Commands 入口。 */
import { PluginAddMenu } from "@/conversation-workspace-target/PluginAddMenu.js";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Monitor, Plus, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Switch } from "@/components/ui/switch.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TID_PLUGIN_STORE_BROWSE } from "@zcode/shared/test-ids";
import type { ZCodePluginInfo, ZCodePluginScope, ZCodePluginUserConfigOption } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { IServiceAccessor } from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { getPathLeaf } from "@/lib/path.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { McpSettingsSection } from "@/settings/McpSettingsSection.js";
import { SkillsSection } from "@/settings/SkillsSection.js";
import { CommandsSection } from "@/settings/CommandsSection.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { PluginInstallEmptyState, PluginLoadingState } from "@/settings/PluginInstallEmptyState.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { PluginConfigControls } from "@/settings/PluginConfigControls.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import {
  PluginStoreItemMenu,
  PluginStoreOpenUiButton,
  PluginStoreUpdateBadge,
  PluginStoreUpdateButton,
  type PluginStoreActions,
} from "@/settings/PluginStoreCard.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";
import {
  buildPluginConfigPatch,
  type PluginOptionDraftValue,
} from "@/settings/pluginConfigPatch.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import {
  buildStoreItems,
  type StorePluginItem,
  resolveManagedPluginDisplay,
  resolvePluginDisplayName,
} from "@/settings/pluginStoreListing.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import {
  filterPluginsByQuery,
  partitionPluginsForSettings,
  selectBuiltInPlugins,
  selectPluginsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import {
  isComputerUseRemoteOrLinux,
  matchesComputerUseSearch,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";
import { PluginScopeMenu, getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import {
  RemoteSyncDialogs,
  shouldShowRemoteSyncActions,
  useRemoteSyncDialogIntent,
} from "@/settings/RemoteSyncActions.js";
import { useServices } from "@/hooks/useServices.js";

// commands 只出现在「独立命令入口」这一种模式里，不是插件页的第四个 Tab。
// 因此目标类型包含它，而可交互 Tab 类型明确排除它（PluginTab），
// 让类型系统在编译期拦住「把 commands 写进 Tabs value」的改动。
type PluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
type PluginTab = Exclude<PluginTabTarget, "commands">;

// 归一化是所有 Tab 写入的唯一入口：initialTab、onValueChange、mode 变化都经过它。
// 若只在某一个调用点处理 commands，其余路径仍会把非法 value 写进 Tabs，
// Radix 找不到对应 trigger 时会静默不渲染面板（不是报错，因此很难发现）。
function normalizePluginTab(tab: PluginTabTarget): PluginTab {
  return tab === "commands" ? "plugins" : tab;
}

// 计数文字颜色跟随选中态，但字号固定：用选中态改字号会让 Tab 宽度变化，
// 高亮切换时整排按钮左右抖动，点击位置随之偏移。
function getPluginTabCountClass(tab: PluginTabTarget, selectedTab: PluginTabTarget): string {
  return tab === selectedTab
    ? "text-ui-sm text-foreground-subtle"
    : "text-ui-sm text-foreground-subtlest";
}

// Scope 用可辨识联合而不是两个可空字段：kind 为 user 时 key 必为 "user"，
// kind 为 workspace 时必然带完整 tab。这样下游取值不需要再判空，
// 也避免出现「kind=user 却带着 workspace key」这种无法处理的状态。
type PluginScope =
  | { kind: "user"; key: "user" }
  | { kind: "workspace"; key: string; tab: ConfigWorkspaceTarget };

// 这个组件同时服务四个入口（插件页、市场、MCP、技能），props 因此较多。
// 关键约定：调用方只传「入口意图」与「显式来源」，其余全部由内部 Scope 状态派生，
// 这样四个入口不会各自维护一份 scope / tab / 搜索状态。
interface PluginsSectionProps {
  // onScopeChange 在 pickedScopeKey 变化后通知父级，父级据此更新标题与面包屑；
  // 组件自身不反向读取父级的 scope，避免两处状态互相覆盖。
  onScopeChange?: (scopeKey: string) => void;
  onOpenUi?: (
    item: StorePluginItem,
    target: ConfigWorkspaceTarget | null,
    enable?: () => Promise<boolean>,
  ) => void;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
  initialTab?: PluginTabTarget;
  initialScopeKey?: string;
  mode?: "plugin" | "market" | "mcp" | "skill" | "command";
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
  settingsSourceServerId?: string | null;
  settingsSourceUserWorkspacePath?: string;
}

// workspaceKey 是所有 scope 比较的唯一实现：选中态、store 对齐、同步目标键都调用它。
// 若某处直接拼 identity/path，另一处用 getPluginWorkspaceKey，两边规则一旦不同，
// storeMatchesTarget 永远为 false，列表会稳定地渲染成空。
function workspaceKey(tab: ConfigWorkspaceTarget): string {
  return getPluginWorkspaceKey(tab);
}

// PluginList 是「某一 Scope 下的插件视图」，不持有 Scope 选择权：
// target 与 configScope 由父级传入，它只负责用与 target 匹配的服务读取 store。
// 这条边界是 INV-2 的保证：列表内任何地方都不得使用全局 ServiceProvider。
function PluginList({
  inMarketplace = false,
  onOpenUi,
  target,
  configScope,
  searchQuery,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  onAdd,
  onCreateTask,
  onDetailOpenChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  onVisibleCountChange,
  unscopedServices,
  cacheAuthorityKey,
}: {
  inMarketplace?: boolean;
  onOpenUi?: PluginsSectionProps["onOpenUi"];
  target: ConfigWorkspaceTarget | null;
  configScope: ZCodePluginScope;
  searchQuery: string;
  isDesktop: boolean;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  isWebRemoteControl: boolean;
  onAdd?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
  onVisibleCountChange?: (count: number) => void;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  // forceUnscoped 与 cacheAuthorityKey 联动：来源设置页（source settings）要读
  // 被查看机器的 user 目录，必须绕过当前激活 workspace 的服务解析，
  // 否则会把本机路径当成远端目标，读到的插件集合完全不同。
  const targetServiceResolution = useWorkspaceServicesResolution(
    target?.workspacePath,
    target?.remoteSessionId,
    target?.workspaceIdentity,
    target?.remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey) },
  );
  const baseServices = useBaseWorkspaceServices();
  // Scope 可选择非激活 workspace，若继续从当前 ServiceProvider 取服务，
  // 会把 B 的路径发往 A 的 host。插件读写必须和 Scope target 共用同一服务解析结果。
  // store hook 按 service 实例创建：不同 Scope 对应不同 store 分片，
  // 这正是「切 Scope 后列表随之切换」的机制。若把 hook 提到模块级复用同一个 store，
  // 所有 Scope 会共享一份 plugins，切换时看到的是最后一次读取的结果。
  const { pluginManagementService } = targetServiceResolution.services;
  const usePluginManagementStore = useScopedPluginManagementStore(pluginManagementService);
  // 每个字段单独订阅，而不是取整个 state：
  // 取整对象会让 status/诊断等任意字段变化都重渲染整个列表。
  const plugins = usePluginManagementStore((state) => state.plugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  // diagnostics 与 plugins 分开订阅：诊断只在打开详情时使用，
  // 若合并进 plugins 的订阅，任何一次诊断刷新都会让整个列表重渲染。
  // 这里仍需订阅它，是因为详情可能随时打开，不能等到打开时再读快照（会漏掉最新告警）。
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const currentWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const currentWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const setEnabled = usePluginManagementStore((state) => state.setEnabled);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const configurePlugin = usePluginManagementStore((state) => state.configurePlugin);
  const currentAuthorityKey = usePluginManagementStore((state) => state.authorityKey);
  const currentConfigScope = usePluginManagementStore((state) => state.configScope);
  const resetPluginConfig = usePluginManagementStore((state) => state.resetPluginConfig);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const activeOperations = usePluginManagementStore((state) => state.activeOperations);
  // 选中只存 id 而不是整个 plugin 对象：插件列表会在每次 initialize 后重建，
  // 存对象会让详情页持有过期快照，开关状态与列表显示不一致。
  // id 为空表示未进入详情，与「选中了一个后来被卸载的插件」是两种状态，由下面的 effect 收敛。
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [pluginOptionsDrafts, setPluginOptionsDrafts] = useState<
    Record<string, Record<string, PluginOptionDraftValue>>
  >({});
  // 设置页重构后只保留了 Plugin 管理列表，漏掉了旧版插件页的远端同步入口。
  // 同步目标必须沿用当前 Scope 的 target services，不能回退到激活 workspace 的 host。
  const connectedRemoteSyncTarget =
    targetServiceResolution.rpcReady &&
    shouldShowRemoteSyncActions({
      remoteSessionId: target?.remoteSessionId,
      remoteTarget: target?.remoteTarget,
      clientMode: isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
      hasLocalSourceService: Boolean(baseServices.pluginSyncService),
    }) &&
    target?.workspacePath
      ? target.remoteTarget
      : null;
  // 三个条件必须同时成立：rpc 已就绪、当前模式允许远程同步、且 Scope 真有 workspacePath。
  // 少任意一个都会把同步入口指向一个不存在的远端，点击后错误发生在服务层而不是这里。
  // 设置页重构时只迁移了插件远程同步操作，遗漏了当前远端工作区提示，
  // 用户无法确认插件列表实际对应的是哪个远程目标。
  // 标签在没有远端目标时返回空串而不是兜底文案：
  // 调用方用空串决定是否渲染提示，兜底文案会让本地 Scope 也出现「已连接远端」的假提示。
  // 第二个参数传 Scope 的 path 而不是激活 workspace 的 path，保证提示与实际同步目标一致。
  const remotePluginSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSkillSyncTarget(connectedRemoteSyncTarget, target?.workspacePath ?? "")
    : "";
  // target 为空时 targetKey 为空串，随后的 storeMatchesTarget 必然 false，
  // 列表投影成空；这条链路依赖空串的「不匹配一切」语义，不能改成 "user" 之类的兜底值。
  const targetKey = target ? workspaceKey(target) : "";
  // 同步对话框的键额外拼上 remoteSessionId：同一路径可能先后连到两个远端会话，
  // 只比路径会让第二次打开沿用上一次会话的已读状态与目标。
  // \u0000 作为分隔符避免路径与 session id 拼接产生歧义。
  const pluginSyncTargetKey = target
    ? `${targetKey}\u0000${target.remoteSessionId?.trim() ?? ""}`
    : "";
  // open 状态由 targetKey 驱动而不是普通 useState：
  // 切 Scope 时弹窗必须自动关闭，否则用户会在 B 的页面上确认一次发往 A 的同步请求。
  // 传 rpcReady 是为了在服务尚未可用时不弹出，避免确认后必然失败。
  const { open: remotePluginSyncOpen, setOpen: setRemotePluginSyncOpen } =
    useRemoteSyncDialogIntent({
      rpcReady: targetServiceResolution.rpcReady,
      targetKey: pluginSyncTargetKey,
    });
  // store 侧 key 与 targetKey 必须用同一套规则（identity 优先、path 兜底）：
  // 这里若改成 path 优先，同一仓库在「刚打开（只有 path）」与「identity 已解析」两阶段
  // 会得到不同 key，列表在启动瞬间闪一次空。
  const storeKey = currentWorkspaceIdentity?.trim() || currentWorkspacePath || "";
  // 三个比较分别防三类错配：workspace（同路径不同仓库）、authority（本机与远端）、
  // configScope（user 与 workspace）。缺任意一项都会把另一个 Scope 的数据当成当前 Scope。
  // 注意 authority 比较用 cacheAuthorityKey?.trim() || null，而不是空串：
  // store 侧未设置时是 null，用空串会让「无 authority」永远不匹配，列表恒空。
  const storeMatchesTarget =
    storeKey === targetKey &&
    currentAuthorityKey === (cacheAuthorityKey?.trim() || null) &&
    currentConfigScope === configScope;
  // 市场信息与安装信息的合并在 buildStoreItems 里一次完成，UI 只查这个 Map：
  // 行内若各自去 availablePlugins 里找一次、再和 plugins 拼一次，
  // 会出现「有更新徽标但没有更新按钮」这种字段来自不同来源的错位。
  // 依赖只列原始数组，不列 storeMatchesTarget：合并不依赖 Scope，过滤在消费端做。
  const storeItemById = useMemo(
    () =>
      new Map(
        buildStoreItems({
          marketplaces,
          marketplaceAvailabilityKnown,
          availablePlugins,
          installedPlugins,
          plugins,
          restorableBuiltins,
        }).map((item) => [item.id, item]),
      ),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  // 搜索与 Scope 过滤在同一个 memo 里完成，顺序固定为「先 scope 再 query」：
  // 反序会把另一个 Scope 的插件也纳入搜索命中数，用户看到搜索有结果但列表是空的。
  // storeMatchesTarget 为 false 时立即返回空数组，这是 INV-4 的实现点，
  // 不能依赖 filter 把不匹配数据过滤掉，因为此时数据整体都不属于当前 Scope。
  const visiblePlugins = useMemo(() => {
    if (!storeMatchesTarget) return [];
    return filterPluginsByQuery(
      selectPluginsForScope(plugins, installedPlugins, configScope),
      searchQuery,
      storeItemById,
      locale,
    );
  }, [
    configScope,
    installedPlugins,
    locale,
    plugins,
    searchQuery,
    storeItemById,
    storeMatchesTarget,
  ]);
  // 与 visiblePlugins 分开的「未搜索」全集：计数与「安装后是否存在」判断必须基于全集，
  // 若复用搜索结果，用户搜索一个不存在的词时安装数会显示 0，即使已装了插件。
  // 两个 memo 都做同样的空投影，是为了让下游无论从哪个入口拿数据都不会越界。
  const scopedPlugins = useMemo(
    () => (storeMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, configScope) : []),
    [configScope, installedPlugins, plugins, storeMatchesTarget],
  );
  // 内置插件 id 集合同时用于两个分组：可见列表与完整列表。
  // 用 Set 而不是在分组函数里每次 includes：插件数量可达上百，
  // 每行一次线性查找会在滚动时产生可感知的卡顿。
  const builtInPluginIds = useMemo(
    () => new Set(selectBuiltInPlugins(plugins, installedPlugins).map((plugin) => plugin.id)),
    [installedPlugins, plugins],
  );
  // 分组结果按搜索后的列表计算，「已安装/内置」两组的数量随搜索变化，
  // 这是有意的：搜索时分组标题上的数字必须与可见行数一致，
  // 若用全集计数，用户会看到「已安装 5」但列表只有 1 行。
  // 可见分组与完整分组必须分别 memo：可见分组依赖 searchQuery（经由 visiblePlugins），
  // 完整分组只依赖 Scope。把两者合成一个会让每次输入都重算完整分组，
  // 也会让 installedPluginCount 随搜索变化，空态判断随之失效。
  const visiblePluginGroups = useMemo(
    () => partitionPluginsForSettings(visiblePlugins, builtInPluginIds),
    [builtInPluginIds, visiblePlugins],
  );
  // 完整分组用未搜索的 scopedPlugins：它唯一的消费者是「已安装总数」，
  // 这个数字必须在搜索时保持不变，否则用户会以为搜索把插件删掉了。
  const scopedPluginGroups = useMemo(
    () => partitionPluginsForSettings(scopedPlugins, builtInPluginIds),
    [builtInPluginIds, scopedPlugins],
  );
  // 两组可见列表来自「搜索后」的分组，而 installedPluginCount 来自「未搜索」的分组：
  // visiblePluginGroups 驱动渲染，installedPluginCount 决定是否显示「一个都没装」的空态。
  // 若用可见长度判断空态，搜索一个不存在的词就会被判成未安装，展示出引导安装的按钮，
  // 而实际上用户只是搜错了。
  const visibleBuiltInPlugins = visiblePluginGroups.builtIn;
  const visibleInstalledPlugins = visiblePluginGroups.installed;
  const installedPluginCount = scopedPluginGroups.installed.length;
  // computerUse 是唯一一个「平台相关且可能是远程」的插件：可用性要同时看
  // 运行平台、Scope 的远端会话与 workspace identity。
  // 提前算成枚举而不是在 JSX 里散落条件，是为了让占位行与详情操作共用同一判断，
  // 避免出现「列表说不可用、详情却能启用」的矛盾。
  const computerUseAvailability = resolveComputerUseAvailability({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    remoteSessionId: target?.remoteSessionId,
    remoteTarget: target?.remoteTarget,
    workspaceIdentity: target?.workspaceIdentity,
  });
  // 占位行的五个条件缺一不可：
  // user Scope（workspace 下不能安装）、有 target、已加载完成、确实不支持、且搜索词命中。
  // 少「搜索命中」会让占位行在任何搜索下都出现，用户搜别的插件时列表底部多一条无关项；
  // 少「已加载完成」会在加载中闪现占位，安装完成后又消失，看起来像列表抖动。
  const showUnavailableComputerUse = Boolean(
    configScope === "user" &&
    target &&
    !loading &&
    isComputerUseRemoteOrLinux(computerUseAvailability) &&
    matchesComputerUseSearch(searchQuery),
  );
  // 空搜索结果必须在「占位行也满足条件」时让位：
  // 否则搜索 computerUse 时既有占位行又有「未找到」文案，两个互斥状态同时出现。
  // loading 期间不算空结果，否则慢盘上每次输入都会闪一次「未找到」。
  const hasEmptySearchResult = Boolean(
    target &&
    !loading &&
    searchQuery.trim() &&
    visibleInstalledPlugins.length === 0 &&
    visibleBuiltInPlugins.length === 0 &&
    !showUnavailableComputerUse,
  );
  // 搜索时若「已安装」组没有命中，整组连标题一起隐藏：
  // 保留一个空标题会让用户误以为该组还在加载，而不是被搜索过滤掉了。
  // 非搜索状态下即使为空也保留标题，此时用户需要看到「已安装 0」来确认当前 Scope 没有插件。
  const hideInstalledGroup = Boolean(searchQuery.trim() && visibleInstalledPlugins.length === 0);
  // 只上报两个长度而不是整个分组对象：父级只用于显示「共 N 个」，
  // 传对象会让引用每次渲染都变，父级 effect 反复触发并可能反向 setState 造成循环。
  // 依赖写 length 而不是数组本身，避免同一数量下数组重建引起的重复通知。
  useEffect(() => {
    onVisibleCountChange?.(visibleInstalledPlugins.length + visibleBuiltInPlugins.length);
  }, [onVisibleCountChange, visibleBuiltInPlugins.length, visibleInstalledPlugins.length]);
  // 安装/卸载/升级之后统一走这里重新 initialize，而不是让各动作自己拼刷新参数：
  // 四个参数（path、identity、authority、scope）与初次加载完全一致，
  // 少传任何一个都会让 store 把结果写进另一个 Scope，表现为「操作成功但列表没变」。
  // rpcReady=false 时直接跳过：此时服务不可用，强行 initialize 会覆盖已有缓存。
  const refreshAfterPluginChange = useCallback(async () => {
    if (!target || !targetServiceResolution.rpcReady) return;
    await initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [
    initialize,
    cacheAuthorityKey,
    configScope,
    pluginManagementService,
    target,
    targetServiceResolution.rpcReady,
  ]);
  // 开关的 UI 状态完全由 store 的 togglingPluginId 驱动，这里不再维护本地 pending：
  // 本地 pending 与 store 的更新时机不同，会在请求结束到 store 回写之间出现
  // 「开关已切换但列表仍是旧值」的跳变，用户会再点一次产生反向写入。
  const handleSetEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      // 名称从合并后的 storeItem 取，而不是用 plugin.name：
      // 内置插件的显示名可能来自市场元信息（本地名称是 id），直接用本地名会让 toast
      // 出现「已启用 zcode.builtin.xxx」这种用户无法对应到列表的文案。
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      // 返回值只看布尔，不在这里读 store 的 error 决定是否成功：
      // setEnabled 内部已按 Scope 完成写入并回写 store，布尔就是最终结论；
      // 再读一次 error 可能读到并发的另一次失败，把成功误报成失败。
      const succeeded = await setEnabled(pluginId, enabled, pluginManagementService, configScope);
      if (!succeeded) {
        // 失败文案优先用 store 里的具体错误（可能包含权限/路径原因），
        // 只有 store 没给原因时才回退到本地化的通用文案。
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      // workspace 与 user 使用不同文案：在 workspace 下启用只影响当前项目，
      // 若提示「已启用」会让用户以为全局生效，换项目后发现插件又没了。
      const messageId =
        configScope === "workspace"
          ? enabled
            ? "settings.plugins.toggle.workspaceEnabled"
            : "settings.plugins.toggle.workspaceDisabled"
          : enabled
            ? "settings.plugins.toggle.enabled"
            : "settings.plugins.toggle.disabled";
      // 成功后只 toast，不手动刷新列表：setEnabled 已经把新状态写回 store，
      // 再 initialize 一次会产生一次多余的全量读取，且可能覆盖刚落地的乐观状态。
      toast(intl.formatMessage({ id: messageId }, { plugin: pluginLabel }));
    },
    [configScope, intl, locale, pluginManagementService, plugins, setEnabled, storeItemById],
  );
  // 「恢复默认」固定按 workspace scope 重置，不跟随 configScope：
  // 它出现在 workspace 详情里，语义是「清掉本项目的覆盖配置」，
  // 若跟随 user scope 会把全局配置一起清掉，影响其他项目。
  // 该回调只在 configScope === "workspace" 时挂进 actions，user 页根本不会出现入口。
  const handleResetPluginConfig = useCallback(
    async (pluginId: string) => {
      const plugin = plugins.find((candidate) => candidate.id === pluginId);
      const pluginLabel = plugin
        ? resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name
        : pluginId;
      const restored = await resetPluginConfig(pluginId, pluginManagementService, "workspace");
      if (!restored) {
        toast(
          usePluginManagementStore.getState().error ??
            intl.formatMessage({ id: "settings.plugins.toggle.failed" }, { plugin: pluginLabel }),
          { variant: "warning" },
        );
        return;
      }
      toast(intl.formatMessage({ id: "settings.plugins.scope.restored" }, { plugin: pluginLabel }));
    },
    [intl, locale, pluginManagementService, plugins, resetPluginConfig, storeItemById],
  );
  // 卸载交给共享 hook，而不是在这里直接调 service：
  // hook 负责确认弹窗、活动操作互斥（activeOperations）与失败回滚，
  // 这三件事在任何调用点都必须一致，复制一份实现必然漏掉其中一条。
  // onAfterUninstall 只在真正删除成功后触发，取消确认不会刷新列表。
  const uninstall = usePluginUninstall({
    store: usePluginManagementStore,
    pluginService: pluginManagementService,
    installedPlugins,
    plugins,
    activeOperations,
    onAfterUninstall: refreshAfterPluginChange,
  });
  // 升级失败时直接 return，不刷新列表：
  // updatePlugin 失败会写 store.error 并保留旧版本信息，此时刷新会把错误信息
  // 与旧数据一起覆盖，用户看不到失败原因，还可能以为升级成功。
  // 读取用 getState() 而不是闭包里的 error：闭包值可能停留在本次 await 之前。
  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, pluginManagementService);
      if (usePluginManagementStore.getState().error) return;
      await refreshAfterPluginChange();
    },
    [pluginManagementService, refreshAfterPluginChange, updatePlugin],
  );
  // selectedPlugin 从当前 Scope 的 plugins 里实时查，而不是存快照：
  // 详情里的开关、配置、警告都需要与列表同一时刻的数据；
  // 找不到（null）是卸载/切 Scope 的信号，由下面的 effect 关闭详情。
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? null;
  // 插件自身 warning 诊断（如声明的技能路径扫描为空）：详情高级区展示，避免静默失败。
  // 只取 warning 级别：error 级别的诊断会阻止插件加载，此时详情主操作区已经
  // 显示失败原因，再列一遍会让用户以为需要分别处理两个问题。
  // 过滤按 pluginId 与取详情用同一个 id，避免显示了别的插件的告警。
  const pluginWarningsForSelected = selectedPlugin
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === selectedPlugin.id && diagnostic.severity === "warning",
      )
    : [];
  // 用 selectedPluginId 查而不是用 selectedPlugin.id：
  // 前者在插件刚被卸载、plugins 里已找不到时仍然有值，能多撑一帧让卸载确认框
  // 继续显示正确名称；用后者会在那一刻变成 undefined，确认框标题闪成空。
  const selectedStoreItem = selectedPluginId ? storeItemById.get(selectedPluginId) : undefined;
  // 关闭详情必须同时清 id 与通知父级，二者不能只做一半：
  // 只清 id 会让父级仍认为处于详情态，标题栏保持「返回」文案但没有可返回的页面；
  // 只通知父级会让详情组件仍挂载，用户能看到内容却无法操作。
  const closeDetail = useCallback(() => {
    setSelectedPluginId(null);
    onDetailOpenChange?.(false);
  }, [onDetailOpenChange]);
  // targetKey 变化即 Scope 切换，必须关闭详情（INV-7）：
  // 详情里所有操作都绑定旧 Scope 的 service，留在页面上会让用户在不知情时
  // 对新 Scope 之外的仓库执行卸载或配置写入。
  useEffect(() => {
    closeDetail();
  }, [closeDetail, targetKey]);
  // 选中项在当前 Scope 中消失（被卸载、被外部禁用过滤）时也要关闭：
  // 否则详情渲染 null 内容，父级却仍隐藏列表，用户卡在一个空白页面上。
  useEffect(() => {
    if (selectedPluginId && !selectedPlugin) closeDetail();
  }, [closeDetail, selectedPlugin, selectedPluginId]);
  // 草稿按 pluginId + optionKey 二层存储，而不是展开成 `${pluginId}:${key}`：
  // 用拼接键会在插件 id 本身含冒号时解析歧义，且删除单个插件的草稿需要遍历。
  // 合并时保留其他插件与其他字段，避免用户改一个选项就把同页其他草稿冲掉。
  // 传入 value 为 null 表示「清空」这一意图，因此这里的入参类型必须包含 null。
  const setPluginOptionDraft = (
    pluginId: string,
    key: string,
    value: string | number | boolean,
  ) => {
    setPluginOptionsDrafts((current) => ({
      ...current,
      [pluginId]: { ...current[pluginId], [key]: value },
    }));
  };
  const getPluginOptionValue = (
    plugin: ZCodePluginInfo,
    key: string,
    option: ZCodePluginUserConfigOption,
  ): string | number | boolean => {
    // 读取顺序固定为「草稿 → 已配置 → 默认值」：
    // 反序会让已保存值覆盖用户正在编辑的草稿，输入框在每次重渲染时回退。
    const draft = pluginOptionsDrafts[plugin.id]?.[key];
    // null 是显式清除意图，必须映射成空值而不是继续走 ?? 链：
    // 若用 ?? 继续回退，用户点了清除但输入框仍显示已保存的值，看起来像按钮失效。
    // 空字符串也是合法的用户输入，因此不能用 || 判断，只能精确比较 null。
    if (draft === null) return "";
    return (
      draft ??
      plugin.configuredOptions?.[key] ??
      // boolean 的默认值必须显式为 false，不能落到空串：
      // 开关组件把 "" 当作真值会渲染成开启，与实际默认关闭相反。
      option.default ??
      (option.type === "boolean" ? false : "")
    );
  };
  // 保存只提交「与已保存值不同的字段」与「显式清除的键」，由 buildPluginConfigPatch 计算：
  // 直接提交整份草稿会把用户没碰过的默认值也写成显式配置，
  // 之后插件升级改了默认值，用户仍停留在旧默认上而不知道。
  // 保存期间不禁用输入是有意的：RPC 很快，禁用来回切会打断连续编辑；
  // 由此产生的「保存的是点击瞬间的快照」由 patch 计算保证一致。
  const savePluginOptions = async (plugin: ZCodePluginInfo) => {
    const { options, clearOptionKeys } = buildPluginConfigPatch(
      plugin,
      pluginOptionsDrafts[plugin.id] ?? {},
    );
    // 没有显式修改时不写入空的 Workspace 配置，避免无操作保存制造配置足迹。
    if (Object.keys(options).length === 0 && clearOptionKeys.length === 0) return;
    // 传 configScope 而不是固定 "workspace"：user 详情页保存必须写 user 配置，
    // 固定 workspace 会让全局设置只在当前项目生效，换项目后配置「丢失」。
    // clearOptionKeys 与 options 必须一起传：分开两次调用会出现「先写后清」的中间态，
    // 若第二次失败，用户看到的是一个既保留了旧值又多了新值的配置。
    const configured = await configurePlugin(
      plugin.id,
      options,
      pluginManagementService,
      configScope,
      clearOptionKeys,
    );
    // 保存失败时保留用户输入和敏感字段清除意图，避免 RPC 错误后 UI 看起来像已提交。
    if (!configured) return;
    // 成功后只删当前插件的草稿，不整体重置：
    // 用户可能同时打开了别的插件详情并在其中编辑，整体清空会造成静默丢失。
    // 用函数式更新读取最新草稿表，避免与保存期间的其他编辑互相覆盖。
    setPluginOptionsDrafts((current) => {
      const next = { ...current };
      delete next[plugin.id];
      return next;
    });
  };
  // actions 对象整体 memo 化并显式列全依赖，是因为它会被列表每一行接收：
  // 每次渲染新建对象会让所有行（包括未变化的）一起重渲染，
  // 在插件多、搜索输入频繁的场景下每次按键都要重绘整页。
  const actions: PluginStoreActions = useMemo(
    () => ({
      // 打开详情同时通知父级，两个动作必须同帧完成：
      // 只改 id 会让父级在下一帧才知道进入详情，标题栏会闪一下列表态。
      onOpenDetail: (pluginId) => {
        setSelectedPluginId(pluginId);
        onDetailOpenChange?.(true);
      },
      // 只有未启用时才注入 enable 回调：已启用的插件打开 UI 前再 setEnabled 一次
      // 会触发一次多余的状态写入，插件若在启用时做了初始化，会被重复执行。
      // target 随 Scope 传入，保证 UI 打开的是当前 Scope 的插件而不是激活 workspace 的。
      onOpenUi: onOpenUi
        ? (item) =>
            onOpenUi(
              item,
              target,
              item.info?.enabled
                ? undefined
                : () => setEnabled(item.id, true, pluginManagementService, configScope),
            )
        : undefined,
      // 安装不直接执行，而是跳到插件市场：安装需要选择来源与版本，
      // 行内直接装会在多市场场景下随机选一个，用户无法控制来源。
      onInstall: () => onOpenPluginStore(),
      // 卸载入口直接暴露 hook 的 requestUninstall，由它负责确认弹窗；
      // 这里包一层自己的实现会绕过确认，让「删除」变成单击即生效的危险操作。
      onUninstall: uninstall.requestUninstall,
      // 用 void 丢弃 Promise：onSetEnabled 的签名是同步回调，
      // 返回 Promise 会让调用方误以为可以 await 到完成，实际 UI 状态由 store 驱动。
      onSetEnabled: (pluginId, enabled) => void handleSetEnabled(pluginId, enabled),
      // 恢复默认只在 workspace Scope 暴露：user Scope 没有「上层配置」可回退，
      // 显示一个永远无效的按钮会让用户以为功能损坏。
      onResetConfig:
        configScope === "workspace"
          ? (pluginId) => void handleResetPluginConfig(pluginId)
          : undefined,
      // 更新同样丢弃 Promise，原因与 onSetEnabled 一致；行内 loading 由 activeOperations 提供。
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      // activeOperations 与 togglingPluginId 直接透传 store 值，不在行内派生：
      // 这两个集合是「同一插件不能并发操作」的唯一事实来源，派生副本会与 store 脱节。
      activeOperations,
      togglingPluginId,
    }),
    [
      configScope,
      handleResetPluginConfig,
      handleSetEnabled,
      handleUpdatePlugin,
      onDetailOpenChange,
      onOpenPluginStore,
      activeOperations,
      togglingPluginId,
      uninstall.requestUninstall,
      onOpenUi,
      target,
      setEnabled,
      pluginManagementService,
    ],
  );
  // 初次加载与 Scope 变化共用同一个 effect：四个参数必须整体变化才重新 initialize，
  // 只对 path 变化做依赖会让「同一路径切换 user/workspace scope」不触发重载，
  // 列表停留在上一个 Scope 的数据上。
  // rpcReady 作为守卫而不是依赖：未就绪时不发请求，就绪后依赖变化会自然重跑。
  useEffect(() => {
    if (!target || !targetServiceResolution.rpcReady) return;
    void initialize({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope,
      pluginService: pluginManagementService,
    });
  }, [
    initialize,
    cacheAuthorityKey,
    configScope,
    pluginManagementService,
    target,
    targetServiceResolution.rpcReady,
  ]);

  // 行分隔线用「index > 0 时插入一个 1px div」而不是给每行加 border：
  // border 会让最后一行底部也多一条线，与外层圆角容器形成双层边框。
  // 用 Fragment 包住，保证分隔线与行在 flex 列布局里各自占位、不互相挤压。
  const renderPluginRows = (items: ZCodePluginInfo[]) => (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((plugin, index) => (
        <Fragment key={plugin.id}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          <div
            className="group/plugin-row flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
            data-testid="plugin-settings-plugin-row"
            data-plugin-id={plugin.id}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              onClick={() => actions.onOpenDetail(plugin.id)}
            >
              <PluginStoreAvatar
                item={storeItemById.get(plugin.id) ?? { name: plugin.name }}
                className="size-9 bg-background"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
                    {resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale).name}
                  </span>
                  <PluginStoreUpdateBadge item={storeItemById.get(plugin.id)} />
                </div>
                {resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale)
                  .description ? (
                  <div className="mt-0.5 line-clamp-1 text-ui-sm text-foreground-subtle">
                    {
                      resolveManagedPluginDisplay(plugin, storeItemById.get(plugin.id), locale)
                        .description
                    }
                  </div>
                ) : null}
                <div className="mt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SettingsScopeBadge
                      scope={plugin.enabledSource ?? "default"}
                      label={
                        configScope === "user" && plugin.enabledSource === "user"
                          ? intl.formatMessage({
                              id: "settings.plugins.scope.userDefault",
                            })
                          : plugin.enabledSource === "user"
                            ? intl.formatMessage({
                                id: "settings.plugins.scope.inheritedUser",
                              })
                            : plugin.enabledSource === "workspace"
                              ? intl.formatMessage({
                                  id: "settings.plugins.scope.workspaceOverride",
                                })
                              : undefined
                      }
                    />
                  </div>
                </div>
              </div>
            </button>
            <PluginStoreUpdateButton item={storeItemById.get(plugin.id)} actions={actions} />
            {storeItemById.get(plugin.id) && plugin.packageStatus !== "missing" ? (
              <PluginStoreItemMenu item={storeItemById.get(plugin.id)!} actions={actions} />
            ) : null}
            {storeItemById.get(plugin.id) ? (
              <PluginStoreOpenUiButton item={storeItemById.get(plugin.id)!} actions={actions} />
            ) : null}
            <div className="flex shrink-0 items-center gap-2">
              {togglingPluginId === plugin.id ? (
                <Loader2
                  className="size-4 animate-spin text-foreground-subtle"
                  data-testid="plugin-settings-enabled-pending"
                  aria-label={intl.formatMessage(
                    { id: "settings.plugins.toggle.pending" },
                    {
                      plugin: resolveManagedPluginDisplay(
                        plugin,
                        storeItemById.get(plugin.id),
                        locale,
                      ).name,
                    },
                  )}
                />
              ) : null}
              <Switch
                data-testid="plugin-settings-enabled-switch"
                data-plugin-id={plugin.id}
                checked={plugin.enabled}
                disabled={togglingPluginId === plugin.id}
                aria-busy={togglingPluginId === plugin.id}
                aria-label={intl.formatMessage(
                  {
                    id: plugin.enabled
                      ? "settings.plugins.toggle.disable"
                      : "settings.plugins.toggle.enable",
                  },
                  {
                    plugin: resolveManagedPluginDisplay(
                      plugin,
                      storeItemById.get(plugin.id),
                      locale,
                    ).name,
                  },
                )}
                onCheckedChange={(enabled) => {
                  // 直接转发目标值而不是取反本地状态：
                  // 受控开关在 store 回写前仍显示旧值，取反会让快速连点时第二次
                  // 计算出与用户意图相反的值，产生两次反向写入。
                  // 可选链保留是因为 user Scope 下 actions 可能不提供该能力（只读展示）。
                  actions.onSetEnabled?.(plugin.id, enabled);
                }}
              />
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );

  // 不可用占位行的文案由 availability.kind 分流：linux 与 remote 的原因不同，
  // 用同一句「不支持」会让用户按错误方向排查（例如在远端场景去装本机依赖）。
  // 这个占位行没有开关与详情入口，避免用户对不可用能力执行任何写入。
  const renderUnavailableComputerUse = () => (
    <div className="overflow-hidden rounded-xl bg-surface">
      <div className="flex min-w-0 items-center gap-3 px-4 py-3 text-foreground-subtle">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle">
          <Monitor className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.title" })}
          </div>
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id:
                computerUseAvailability.kind === "local-linux"
                  ? "settings.computerUse.unsupported.linuxDescription"
                  : "settings.computerUse.unsupported.remoteDescription",
            })}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-background px-2 py-1 text-ui-xs font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.badge" })}
        </span>
      </div>
    </div>
  );

  // 三个条件缺一不可（INV-6）：selectedPlugin 提供本地配置与警告，
  // selectedStoreItem 提供市场描述与操作定义，rpcReady 决定这些操作是否真的能执行。
  // 只有 selectedPlugin 时进入详情会渲染出一个没有描述、按钮点了报错的页面。
  if (selectedPlugin && selectedStoreItem && targetServiceResolution.rpcReady) {
    // 面包屑名称统一走 resolvePluginDisplayName，而不是 selectedPlugin.name：
    // 本地名称可能为空或是 id，市场名称才是用户能识别的标题。
    // 两处显示（面包屑与卸载确认）共用同一解析，避免同一插件出现两个名字。
    const pluginBreadcrumbLabel = resolvePluginDisplayName(selectedStoreItem, locale);
    const pluginsBreadcrumbLabel = intl.formatMessage({ id: "settings.plugins.title" });
    // Plugin 不打开仅含管理字段的简化弹窗：那会与插件商店详情形成两套内容模型，
    // 导致介绍、Hero、示例提示词与能力清单缺失。这里直接复用权威商店详情页，只注入已安装态高级配置。
    // 复用同一个详情组件也保证「未安装预览」与「已安装详情」的文案、权限提示完全一致。
    return (
      <section className="space-y-5">
        <Button variant="ghost" data-testid="plugin-settings-detail-back" onClick={closeDetail}>
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        {!inMarketplace ? (
          <SettingsBreadcrumbReporter
            items={
              showMarketplaceBreadcrumb
                ? [
                    { label: pluginsBreadcrumbLabel, onSelect: closeDetail },
                    { label: pluginBreadcrumbLabel },
                  ]
                : [{ label: pluginBreadcrumbLabel }]
            }
            onSectionSelect={showMarketplaceBreadcrumb ? onOpenPluginStore : closeDetail}
          />
        ) : null}
        <PluginStoreDetailView
          // item 必须传合并后的 storeItem，而不是 selectedPlugin 或市场原始项：
          // 详情页同时需要「已安装/可更新」与市场描述，缺任一半都会让操作区错配。
          item={selectedStoreItem}
          actions={actions}
          // onRetryDescribe 传空实现是有意的：设置页不负责重新拉取市场详情，
          // 描述失败时由市场页的刷新入口处理，这里保留按钮只为布局一致。
          onRetryDescribe={() => {}}
          onUsePrompt={(item, prompt) => {
            // 没有 onCreateTask 时静默返回：独立市场页可能不提供会话能力，
            // 弹一个「无法创建任务」的错误会让纯浏览场景变得打扰。
            if (!onCreateTask) return;
            onCreateTask({
              initialPrompt: buildPluginStoreTryPrompt({
                item,
                locale,
                prompt,
              }),
              initialPromptMention: buildPluginStoreTryMention({
                item,
                locale,
              }),
            });
          }}
          // packageStatus 为 missing 时不注入高级区：此时插件文件已被删除，
          // 展示 rootPath、hooks、配置控件只会让用户对不存在的目录做无效操作，
          // 应该只保留「重新安装」路径，由详情主操作区提供。
          advanced={
            selectedPlugin.packageStatus === "missing" ? undefined : (
              <PluginStoreAdvancedSection>
                {pluginWarningsForSelected.length > 0 ? (
                  <div>
                    <div className="mb-2 text-ui-xs font-medium text-foreground">
                      {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                    </div>
                    <PluginWarningList warnings={pluginWarningsForSelected} />
                  </div>
                ) : null}
                <PluginDetailRow
                  label={intl.formatMessage({
                    id: "settings.plugins.detail.rootPath",
                  })}
                  value={selectedPlugin.rootPath}
                />
                {(selectedPlugin.hookDetails ?? []).length > 0 ? (
                  <PluginHookDetails hooks={selectedPlugin.hookDetails ?? []} />
                ) : null}
                <PluginConfigControls
                  getValue={getPluginOptionValue}
                  isOptionClearPending={(pluginId, key) =>
                    pluginOptionsDrafts[pluginId]?.[key] === null
                  }
                  onClearOption={(pluginId, key, clear) =>
                    setPluginOptionsDrafts((current) => {
                      // 先浅拷贝该插件的草稿再删键，不能直接改 current[pluginId]：
                      // 原地修改会让 React 认为引用未变而跳过重渲染，勾选状态不更新。
                      // clear=true 写 null 是「清空已保存值」的哨兵（INV-8），
                      // clear=false 删除草稿表示「回到已保存值」，两者语义相反，不能都删。
                      const nextPluginDrafts = { ...current[pluginId] };
                      if (clear) nextPluginDrafts[key] = null;
                      else delete nextPluginDrafts[key];
                      return {
                        ...current,
                        [pluginId]: nextPluginDrafts,
                      };
                    })
                  }
                  onSave={(plugin) => void savePluginOptions(plugin)}
                  onSetDraft={setPluginOptionDraft}
                  activeOperations={activeOperations}
                  plugin={selectedPlugin}
                  scope={configScope}
                />
              </PluginStoreAdvancedSection>
            )
          }
        />
        <PluginUninstallConfirmDialog
          // open 由 pendingPlugin 派生而不是独立的 boolean：
          // 两个状态分开存会出现「弹窗开着但没有待卸载对象」的空确认框，
          // 点确认时 hook 内部找不到目标，表现为按钮无反应。
          open={uninstall.pendingPlugin !== null}
          // 名称先查 storeItemById 再用本地名称兜底：
          // 市场元信息可能已经更新或该插件从未进过市场，两种情况下都必须给出可读名称，
          // 否则确认框会显示空白，用户不知道该删什么。
          pluginName={
            uninstall.pendingPlugin
              ? resolvePluginDisplayName(
                  storeItemById.get(uninstall.pendingPlugin.id) ?? {
                    name: uninstall.pendingPlugin.name,
                  },
                  locale,
                )
              : ""
          }
          pending={uninstall.uninstalling}
          onCancel={uninstall.cancelUninstall}
          onConfirm={() => void uninstall.confirmUninstall()}
        />
      </section>
    );
  }

  // 列表态与详情态是两条独立 return：详情态不渲染搜索框与分组标题，
  // 因此不能靠条件隐藏实现，否则父级的标题栏与可见计数会与当前页面不匹配。
  return (
    <section className="space-y-6" aria-labelledby="plugin-installed-title">
      {hasEmptySearchResult ? (
        // 空搜索结果单独渲染在分组之外：分组块在 hideInstalledGroup 下整块隐藏，
        // 放在里面会导致搜索无结果时什么都不显示，用户以为页面加载失败。
        <EmptyState
          message={intl.formatMessage({
            id: "settings.plugin.plugins.empty",
          })}
        />
      ) : null}
      <div className={hideInstalledGroup ? "hidden" : "space-y-4"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3
            id="plugin-installed-title"
            className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground"
          >
            {intl.formatMessage({ id: "settings.plugin.plugins.installed" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleInstalledPlugins.length}
            </span>
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {connectedRemoteSyncTarget ? (
              // 这个入口只在真正连上远端时出现：仅配置了 remoteTarget 但 rpc 未就绪时
              // 显示按钮，点开只会得到一个无法执行的同步确认框。
              <ControlHintTooltip
                title={intl.formatMessage({
                  id: "settings.plugins.remoteSync.open",
                })}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon-md"
                  aria-label={intl.formatMessage({
                    id: "settings.plugins.remoteSync.open",
                  })}
                  onClick={() => setRemotePluginSyncOpen(true)}
                >
                  <UploadCloud className="size-3.5" aria-hidden="true" />
                </Button>
              </ControlHintTooltip>
            ) : null}
            <SettingsResourceHeaderActions onRefresh={() => void refreshAfterPluginChange()} />
            {configScope === "user" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  data-testid={TID_PLUGIN_STORE_BROWSE}
                  onClick={onAdd}
                >
                  {intl.formatMessage({ id: "settings.plugin.plugins.browse" })}
                </Button>
                <PluginAddMenu
                  testId="plugin-settings-add"
                  // onCreateTask 与 onAddMarketplace 是两条不同路径：
                  // 前者创建「从本地/会话安装」的任务，后者跳到市场添加来源。
                  // 合并成一个回调会让「添加市场」也去建任务，得到一个空任务页。
                  onCreateTask={onCreateTask}
                  isWebRemoteControl={isWebRemoteControl}
                  // 传 undefined 的 item 与 add-marketplace 意图，让市场页直接打开添加来源表单，
                  // 而不是先落到市场首页让用户自己找入口。
                  onAddMarketplace={() => onOpenPluginStore(undefined, "add-marketplace")}
                />
              </>
            ) : null}
          </div>
        </div>
        {configScope === "workspace" && target ? (
          // 提示条只在 workspace Scope 且有具体 target 时出现：
          // user Scope 下没有「只对本项目生效」这层语义，显示会造成误导。
          // data-testid 用于确认这条提示不会在 user 页被渲染出来。
          <div
            className="rounded-lg border border-border bg-card px-3 py-2 text-ui-sm text-foreground-subtle"
            data-testid="plugin-settings-workspace-scope-hint"
          >
            {intl.formatMessage({ id: "settings.plugins.scope.workspaceHint" })}
          </div>
        ) : null}
        {connectedRemoteSyncTarget ? (
          // 远端上下文提示要显示具体目标名：用户需要确认自己正在看的插件来自哪台机器，
          // 只写「已连接远端」无法区分多台设备，也无法判断同步会发往哪里。
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.remoteContext" },
              { target: remotePluginSyncTargetLabel },
            )}
          </div>
        ) : null}
        {!target ? (
          <EmptyState
            message={intl.formatMessage({
              id: "settings.plugin.noWorkspace",
            })}
          />
        ) : !targetServiceResolution.rpcReady ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
        ) : loading && visiblePlugins.length === 0 ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
        ) : visibleInstalledPlugins.length > 0 ? (
          // 有可见项就渲染行，即使同时存在占位行：占位行属于另一个分组，
          // 两者不在同一个条件分支里，混在一起会让「有已安装插件」时占位行消失。
          renderPluginRows(visibleInstalledPlugins)
        ) : installedPluginCount === 0 && !showUnavailableComputerUse ? (
          // 只有「确实一个都没装」且没有占位行时才展示安装引导：
          // 搜索无结果的情况已经由上方的 hasEmptySearchResult 处理，
          // 两者同时出现会给出「去安装」的错误建议。
          <PluginInstallEmptyState
            title={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledTitle",
            })}
            description={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledDescription",
            })}
            actions={
              onAdd ? (
                <Button type="button" variant="default" size="lg" onClick={onAdd}>
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  {intl.formatMessage({
                    id: "settings.plugin.plugins.browse",
                  })}
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
      {!hasEmptySearchResult && visibleBuiltInPlugins.length > 0 ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.plugin.plugins.builtIn" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleBuiltInPlugins.length}
            </span>
          </h3>
          {renderPluginRows(visibleBuiltInPlugins)}
        </div>
      ) : null}
      {showUnavailableComputerUse ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.unsupported.group" })}
          </h3>
          {renderUnavailableComputerUse()}
        </div>
      ) : null}
      <PluginUninstallConfirmDialog
        open={uninstall.pendingPlugin !== null}
        pluginName={
          uninstall.pendingPlugin
            ? resolvePluginDisplayName(
                storeItemById.get(uninstall.pendingPlugin.id) ?? {
                  name: uninstall.pendingPlugin.name,
                },
                locale,
              )
            : ""
        }
        pending={uninstall.uninstalling}
        onCancel={uninstall.cancelUninstall}
        onConfirm={() => void uninstall.confirmUninstall()}
      />
      <RemoteSyncDialogs
        canSyncSkills={false}
        canSyncMcp={false}
        canSyncPlugins={Boolean(connectedRemoteSyncTarget && target?.workspacePath)}
        skillOpen={false}
        mcpOpen={false}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={() => {}}
        onMcpOpenChange={() => {}}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localPluginSyncService={baseServices.pluginSyncService}
        remotePluginSyncService={targetServiceResolution.services.pluginSyncService}
        localZCodeAgentService={baseServices.zcodeAgentService}
        remoteZCodeAgentService={targetServiceResolution.services.zcodeAgentService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath=""
        mcpWorkspacePath=""
        pluginWorkspacePath={target?.workspacePath ?? ""}
        pluginLocalWorkspacePath={target?.localWorkspacePath}
        workspaceIdentity={target?.workspaceIdentity}
        onSkillsSynced={() => {}}
        onMcpSynced={() => {}}
        onPluginsSynced={refreshAfterPluginChange}
      />
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
      {message}
    </div>
  );
}

export function PluginsSection({
  onScopeChange,
  onOpenUi,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  isWebRemoteControl = false,
  initialTab = "plugins",
  initialScopeKey,
  mode = "plugin",
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  settingsSourceServerId,
  settingsSourceUserWorkspacePath,
}: PluginsSectionProps) {
  const { intl } = useZCodeIntl();
  const storeActiveWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity ?? undefined;
  const currentServices = useServices();
  const workspaceTabs = useConfigWorkspaceTargets(settingsSourceServerId);
  // preferredHost 是「当前激活 workspace 在可配置列表里的那一项」，找不到时依次回退：
  // 列表第一项 → 用当前 path 临时构造 → null。
  // 这个回退顺序保证 user Scope 永远有一个可展示的目标，同时临时构造的对象不会被
  // 当成真实 tab 写回配置：它不在 workspaceTabs 里，save 时也无法被选中。
  const preferredHost = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          workspaceKey(tab) === (activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""),
      ) ??
      workspaceTabs[0] ??
      (activeWorkspacePath
        ? {
            workspacePath: activeWorkspacePath,
            workspaceIdentity: activeWorkspaceIdentity,
            label: getPathLeaf(activeWorkspacePath) || activeWorkspacePath,
          }
        : null),
    [activeWorkspaceIdentity, activeWorkspacePath, workspaceTabs],
  );
  // 来源设置页（source settings）的 user 目标必须显式构造，且 workspacePath 用的是
  // 被查看机器的 user 目录：这是唯一能保证写入落在远端而非本机的字段。
  // 缺少 serverId 或路径时返回 null 而不是回退 preferredHost：
  // 回退会让来源页看起来可用，实际把配置写进本机 user 目录（INV-20）。
  const sourceUserScopeTarget = useMemo<ConfigWorkspaceTarget | null>(() => {
    if (!settingsSourceServerId || !settingsSourceUserWorkspacePath?.trim()) return null;
    return {
      label: settingsSourceUserWorkspacePath,
      workspacePath: settingsSourceUserWorkspacePath,
    };
  }, [settingsSourceServerId, settingsSourceUserWorkspacePath]);
  // 用 settingsSourceServerId 是否存在来二选一，而不是「有 source 目标就用，否则回退」：
  // 后者在远端路径为空时会静默使用本机 preferredHost，把用户正在查看的远端
  // 当成编辑目标，这是最危险的一种降级。
  const userScopeTarget = settingsSourceServerId ? sourceUserScopeTarget : preferredHost;
  // 缓存 authority 必须带上 serverId：不同来源机器的 user 配置缓存在同一进程里，
  // 不带 id 会让两台机器的缓存互相命中，显示对方的插件列表。
  const sourceUserCacheAuthorityKey = settingsSourceServerId
    ? `source-settings:${settingsSourceServerId}`
    : undefined;
  // 初值用惰性初始化：initialScopeKey 只在首次挂载时生效，之后由用户交互与
  // 下面的同步 effect 接管。若每次渲染都读 initialScopeKey，用户手动切换 Scope 后
  // 父级任意重渲染都会把选择打回初始值。
  const [pickedScopeKey, setPickedScopeKey] = useState(() => initialScopeKey?.trim() || "user");
  // 通知放在 effect 而不是 setPickedScopeKey 的包装函数里：
  // 除了用户点击，initialScopeKey 同步与失效回退也会改这个值，包装函数会漏掉这些路径，
  // 导致父级标题与实际 Scope 不一致。
  useEffect(() => {
    onScopeChange?.(pickedScopeKey);
  }, [onScopeChange, pickedScopeKey]);
  // selectedScopeKey 目前只是别名，保留它是为了给「未来可能区分用户选择与生效 Scope」
  // 留出唯一的读取点；下游全部读它，届时只需改这一行。
  const selectedScopeKey = pickedScopeKey;
  // 独立入口（市场/MCP/技能/命令）把 Tab 固定住，只有 plugin 模式返回 null 表示可交互。
  // 不能反过来用「interactiveTab 是否被用户改过」判断：用户从未点击时两者相同，
  // 独立入口仍会显示一排可点的 Tab。
  const fixedTab: PluginTabTarget | null =
    mode === "market"
      ? "plugins"
      : mode === "mcp"
        ? "mcps"
        : mode === "skill"
          ? "skills"
          : mode === "command"
            ? "commands"
            : null;
  // interactiveTab 只保存「plugin 模式下用户选的 Tab」，初值经过 normalize：
  // 调用方可能传 commands（例如从命令页返回），直接存入会让 Tabs value 非法。
  const [interactiveTab, setInteractiveTab] = useState<PluginTab>(() =>
    normalizePluginTab(initialTab),
  );
  // initialTab 变化视为「外部要求切换 Tab」，覆盖用户当前选择；
  // 只在 initialTab 真正变化时触发，避免父级重渲染把手动切换打回。
  useEffect(() => setInteractiveTab(normalizePluginTab(initialTab)), [initialTab]);
  // initialScopeKey 同理：它变化代表父级切换了目标，必须同步；
  // 空值回退 "user" 而不是保持当前值，是为了让「清除 scope 参数」也有确定语义。
  useEffect(() => {
    setPickedScopeKey(initialScopeKey?.trim() || "user");
  }, [initialScopeKey]);
  // fixedTab 优先：独立入口即便用户此前在插件页选过别的 Tab，也不能改变入口语义。
  const selectedTab = fixedTab ?? interactiveTab;
  // 四个 Tab 各自独立的搜索词（INV-16）：
  // 共用一个 query 会让「在 MCP 搜索后切到技能」时技能列表被同一关键词过滤，
  // 用户以为技能丢了。commands 也占一个槽位，因为命令页有自己的搜索框。
  const [searchQueries, setSearchQueries] = useState<Record<PluginTabTarget, string>>({
    plugins: "",
    mcps: "",
    skills: "",
    commands: "",
  });
  // 计数按 Tab 分开存：四个子列表的可见条数互不相同，
  // 用单个数字会让切换 Tab 时标题上的数字短暂显示上一个 Tab 的数量。
  const [capabilityCounts, setCapabilityCounts] = useState<Record<PluginTabTarget, number>>({
    plugins: 0,
    mcps: 0,
    skills: 0,
    commands: 0,
  });
  // 编辑器/详情各有独立开关，而不是一个 "currentView" 枚举：
  // 它们由不同子组件回写，合并成枚举后任一子组件关闭都会覆盖其他子组件的状态，
  // 例如关闭技能详情会把已打开的 MCP 编辑器一起关掉。
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false);
  const [skillDetailOpen, setSkillDetailOpen] = useState(false);
  // formScopeKey 与 editorOpen 分开：编辑器打开后用户可在表单里改 Scope，
  // 但编辑器本身仍然属于最初进入时的 Tab 语义；null 表示尚未选择，跟随外层 SelectedScope。
  const [mcpFormScopeKey, setMcpFormScopeKey] = useState<string | null>(null);
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [commandFormScopeKey, setCommandFormScopeKey] = useState<string | null>(null);
  // 只取当前 Tab 的搜索词传给面板：四个面板共享同一份 state，
  // 但每个面板只应看到自己的 query，否则输入框会显示别的 Tab 的内容。
  const activeSearchQuery = searchQueries[selectedTab];
  // Scope 的合法性只在这里判定：只要 selectedScopeKey 在 workspaceTabs 里查不到，
  // 就一律降级为 user。这样「tab 被关闭但 key 还没被 effect 清理」的那几帧
  // 不会构造出指向已消失 tab 的 workspace Scope，从而避免用空 path 发请求。
  // 用 workspaceKey(tab) 而不是直接比较 key，保证与菜单项的生成规则一致。
  const selectedScope: PluginScope = useMemo(() => {
    const tab = workspaceTabs.find((candidate) => workspaceKey(candidate) === selectedScopeKey);
    return tab ? { kind: "workspace", key: workspaceKey(tab), tab } : { kind: "user", key: "user" };
  }, [selectedScopeKey, workspaceTabs]);
  const openPluginStoreForSelectedScope = useCallback(
    (_returnScopeKey?: string, intent?: "add-marketplace") => {
      // Workspace 是已安装 Plugin 的配置视图，不提供 Marketplace 入口；市场只在 User
      // 视图中负责 package/cache 生命周期。
      // 这个 return 是 INV-14 的强制点：入口按钮虽然已经按 scope 隐藏，
      // 但面包屑与键盘触发的回调仍可能到达这里，必须在动作层再拦一次。
      if (selectedScope.kind !== "user") return;
      onOpenPluginStore("user", intent);
    },
    [onOpenPluginStore, selectedScope.kind],
  );
  // workspace Scope 直接用选中的 tab，user Scope 用 userScopeTarget：
  // 后者可能是 preferredHost、来源页目标或 null，三者语义不同但都由上游决定，
  // 这里不再回退，保证「没有可用目标」时下游拿到 null 并渲染空态而不是随便挑一个。
  const target = selectedScope.kind === "workspace" ? selectedScope.tab : userScopeTarget;
  // 编辑器打开且用户改过表单 Scope 时以表单为准，否则跟随外层：
  // 反过来的话，用户在表单里切换 Scope 会被外层的重渲染立刻覆盖，
  // 表现为下拉框选了又跳回去。
  const effectiveMcpScopeKey =
    mcpEditorOpen && mcpFormScopeKey ? mcpFormScopeKey : selectedScopeKey;
  // 只查 workspaceTabs 而不查 preferredHost：编辑器锁定的必须是真实存在的 tab，
  // 临时构造的对象没有稳定的 key，下次渲染就查不到，会让编辑器状态在开与关之间跳动。
  const effectiveMcpWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveMcpScopeKey,
  );
  // 「user」是合法 Scope，不是缺失：把它排除在 missing 之外，
  // 否则用户在编辑器里选 user 会被立刻关闭，看起来像无法切换到全局配置。
  // 编辑器锁定的 Workspace 断连后，回退 preferredHost 会把保存请求发到
  // 另一个项目。失效当帧先移除写入目标，随后 effect 关闭编辑器，避免配置写错位置。
  const mcpEditorWorkspaceMissing = Boolean(
    mcpEditorOpen && mcpFormScopeKey && mcpFormScopeKey !== "user" && !effectiveMcpWorkspace,
  );
  // missing 时显式传 null 而不是回退 userScopeTarget（INV-18）：
  // 回退会让表单看起来可用并把请求写到另一个项目，是比「关闭编辑器」严重得多的故障。
  // 非 missing 但 effectiveMcpWorkspace 不存在，说明选的是 user，才回退 userScopeTarget。
  const mcpTarget = mcpEditorWorkspaceMissing ? null : (effectiveMcpWorkspace ?? userScopeTarget);
  // 命令编辑器与 MCP 编辑器是两套独立状态：共用 effectiveMcpScopeKey 会让
  // 打开命令编辑器时 MCP 的表单 Scope 影响命令保存位置。
  const effectiveCommandScopeKey =
    commandEditorOpen && commandFormScopeKey ? commandFormScopeKey : selectedScopeKey;
  const effectiveCommandWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveCommandScopeKey,
  );
  const commandEditorWorkspaceMissing = Boolean(
    commandEditorOpen &&
    commandFormScopeKey &&
    commandFormScopeKey !== "user" &&
    !effectiveCommandWorkspace,
  );
  // 与 mcpTarget 同样的 null 语义：缺失目标时宁可让保存按钮不可用，
  // 也不能把命令写到未预期的项目。
  const commandTarget = commandEditorWorkspaceMissing
    ? null
    : (effectiveCommandWorkspace ?? userScopeTarget);

  // 关闭编辑器放在 effect 里而不是渲染期直接 set：渲染期改状态会触发
  // 「另一个组件在渲染中更新」的警告，且在严格模式下会被执行两次。
  // 先置 null 再关 open：两个 set 在同一批次里提交，避免出现 open=false 但 scopeKey 残留的一帧。
  useEffect(() => {
    if (!mcpEditorWorkspaceMissing) return;
    setMcpEditorOpen(false);
    setMcpFormScopeKey(null);
  }, [mcpEditorWorkspaceMissing]);

  // 命令编辑器单独一套关闭逻辑：不能与 MCP 的合并成一个 effect，
  // 否则任一缺失都会同时关闭两个编辑器，用户正在另一处编辑的内容会丢失。
  useEffect(() => {
    if (!commandEditorWorkspaceMissing) return;
    setCommandEditorOpen(false);
    setCommandFormScopeKey(null);
  }, [commandEditorWorkspaceMissing]);

  useEffect(() => {
    if (
      pickedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => workspaceKey(tab) === pickedScopeKey)
    ) {
      // 判定用 workspaceTabs.some 而不是 selectedScope：后者已经把非法 key 降级成 user，
      // 用它判断会永远看不到「失效」这个事实，回退提示也就不会出现。
      // 市场返回记录的是具体 workspace identity；目标已关闭或断连时，
      // 静默选中 User 会让用户误以为 Workspace 配置仍在展示，因此提示并显式切换。
      setPickedScopeKey("user");
      toast(
        intl.formatMessage({
          id: "settings.plugin.scopeUnavailableFallback",
        }),
      );
    }
  }, [intl, pickedScopeKey, workspaceTabs]);
  // 该 key 用作计数回调的依赖：Scope 变化时回调身份变化，子列表的 effect 会重新上报，
  // 从而保证切换 Scope 后 Tab 上的数字立刻反映新 Scope，而不是沿用旧值。
  const selectedTargetKey = target ? workspaceKey(target) : "";

  // 四个计数回调都做「值相同返回原对象」的短路（INV-21）：
  // 子列表在搜索/滚动时可能以相同数量重复上报，不短路会让父级每次重渲染，
  // 进而让所有 Tab 内容重新渲染，输入框光标都可能被打断。
  // 依赖里带 selectedScope.key 与 selectedTargetKey 是有意的：Scope 变了即使数量相同，
  // 也应视为一次新上报，避免切换后数字停在旧 Scope 的值。
  const updatePluginCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.plugins === count ? current : { ...current, plugins: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateMcpCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.mcps === count ? current : { ...current, mcps: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateSkillCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.skills === count ? current : { ...current, skills: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateCommandCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.commands === count ? current : { ...current, commands: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  // 打开时不动 mcpFormScopeKey，保留上次选的 Scope：
  // 用户连续编辑同一 Scope 的多个 server 时不必每次重选。
  // 关闭时必须清空，否则下次「新建」会残留上一次的 Scope，配置写进非预期文件。
  const handleMcpEditorOpenChange = useCallback((open: boolean) => {
    setMcpEditorOpen(open);
    if (!open) setMcpFormScopeKey(null);
  }, []);

  // Provider 包在最外层：四个 Tab 内的 MCP/技能/命令面板都需要 user Scope 目标
  // 与来源 serverId，逐个传参会漏掉某个面板，导致它在来源模式下写错位置。
  return (
    <SettingsUserScopeProvider target={userScopeTarget} sourceServerId={settingsSourceServerId}>
      <div className="space-y-6">
        {mode === "plugin" &&
        showMarketplaceBreadcrumb &&
        !pluginDetailOpen &&
        !mcpEditorOpen &&
        !skillDetailOpen ? (
          <SettingsBreadcrumbReporter
            items={[
              {
                label: intl.formatMessage({
                  id: "settings.plugins.title",
                }),
              },
            ]}
            onSectionSelect={openPluginStoreForSelectedScope}
          />
        ) : null}
        <Tabs
          value={selectedTab}
          onValueChange={(value) => {
            // 独立入口不响应 Tab 切换：此时 TabsList 根本没渲染，
            // 但键盘与可访问性 API 仍可能触发 valueChange，不拦会把 fixedTab 覆盖掉，
            // 页面从 MCP 突然跳到插件列表。
            if (mode === "plugin") {
              setInteractiveTab(normalizePluginTab(value as PluginTabTarget));
            }
          }}
        >
          {!mcpEditorOpen && !pluginDetailOpen && !commandEditorOpen ? (
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <PluginScopeMenu
                  userTarget={userScopeTarget}
                  userSourceServerId={settingsSourceServerId}
                  align="start"
                  selectedScopeKey={selectedScopeKey}
                  triggerTestId="plugin-settings-scope-trigger"
                  userOptionTestId="plugin-settings-scope-user-option"
                  workspaceOptionTestIdPrefix="plugin-settings-scope-option"
                  workspaceTabs={workspaceTabs}
                  onScopeKeyChange={setPickedScopeKey}
                />
                <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
                {mode === "plugin" ? (
                  <TabsList variant="line" className="h-7 max-w-full gap-1 overflow-x-auto p-0">
                    <TabsTrigger
                      value="plugins"
                      className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                    >
                      {intl.formatMessage({
                        id: "settings.plugin.tab.plugins",
                      })}
                      <span className={getPluginTabCountClass("plugins", selectedTab)}>
                        {capabilityCounts.plugins}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="mcps"
                      className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                    >
                      {intl.formatMessage({
                        id: "settings.plugin.tab.mcps",
                      })}
                      <span className={getPluginTabCountClass("mcps", selectedTab)}>
                        {capabilityCounts.mcps}
                      </span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="skills"
                      className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
                    >
                      {intl.formatMessage({
                        id: "settings.plugin.tab.skills",
                      })}
                      <span className={getPluginTabCountClass("skills", selectedTab)}>
                        {capabilityCounts.skills}
                      </span>
                    </TabsTrigger>
                  </TabsList>
                ) : (
                  // 独立入口用静态标题 + 计数代替 TabsList：
                  // 仍渲染 TabsList 会让用户以为可以切到别的能力，点了却无反应。
                  // data-independent-capability-count 是该形态的测试锚点，不要改成按文本匹配。
                  <div
                    data-independent-capability-count="true"
                    className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
                  >
                    <span>
                      {intl.formatMessage({
                        id:
                          mode === "market"
                            ? "settings.plugin.tab.plugins"
                            : mode === "mcp"
                              ? "settings.plugin.tab.mcps"
                              : mode === "skill"
                                ? "settings.plugin.tab.skills"
                                : "settings.plugin.tab.commands",
                      })}
                    </span>
                    <span className="text-ui-sm text-foreground-subtle">
                      {mode === "market"
                        ? capabilityCounts.plugins
                        : mode === "mcp"
                          ? capabilityCounts.mcps
                          : mode === "skill"
                            ? capabilityCounts.skills
                            : capabilityCounts.commands}
                    </span>
                  </div>
                )}
              </div>
              <SettingsSearchInput
                data-testid="plugin-settings-search"
                containerClassName="w-full sm:ml-auto sm:w-64"
                clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
                value={activeSearchQuery}
                onClear={() => {
                  // 函数式更新 + 动态键：直接写死 plugins 会清掉另一个 Tab 的搜索词，
                  // 而用户清空当前 Tab 后切回去，发现之前的搜索还在（或反过来丢失）。
                  setSearchQueries((current) => ({
                    ...current,
                    [selectedTab]: "",
                  }));
                }}
                onChange={(event) => {
                  // 只写当前 Tab 的槽位（INV-16）：受控输入的值来自 activeSearchQuery，
                  // 若这里写到固定槽位，输入框会显示与列表过滤不一致的关键词。
                  const value = event.target.value;
                  setSearchQueries((current) => ({
                    ...current,
                    [selectedTab]: value,
                  }));
                }}
                placeholder={intl.formatMessage({
                  id:
                    selectedTab === "plugins"
                      ? "settings.plugin.plugins.searchPlaceholder"
                      : selectedTab === "mcps"
                        ? "settings.mcp.searchPlaceholder"
                        : selectedTab === "skills"
                          ? "settings.skills.searchPlaceholder"
                          : "settings.commands.searchPlaceholder",
                })}
              />
            </div>
          ) : null}
          {mode === "plugin" || mode === "market" ? (
            <TabsContent
              forceMount
              value="plugins"
              className={
                pluginDetailOpen
                  ? "data-[state=inactive]:hidden"
                  : "mt-6 data-[state=inactive]:hidden"
              }
            >
              <PluginList
                // inMarketplace 只影响面包屑与返回行为，不改变列表数据来源：
                // 市场与设置页展示的是同一份 storeItem，避免两处对「已安装」判断不一致。
                inMarketplace={mode === "market"}
                onOpenUi={onOpenUi}
                target={target}
                configScope={selectedScope.kind === "user" ? "user" : "workspace"}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                isWebRemoteControl={isWebRemoteControl}
                searchQuery={searchQueries.plugins}
                onAdd={selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined}
                onCreateTask={onCreateTask}
                onDetailOpenChange={setPluginDetailOpen}
                onOpenPluginStore={openPluginStoreForSelectedScope}
                showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                onVisibleCountChange={updatePluginCount}
                // 只有「来源页 + user Scope」才注入本机 services 作为非受控回退：
                // 其他情况传了会让列表用本机服务读取，展示的插件与保存位置分属两台机器。
                unscopedServices={
                  settingsSourceServerId && selectedScope.kind === "user"
                    ? currentServices
                    : undefined
                }
                // cacheAuthorityKey 必须与 unscopedServices 同时出现：
                // 只给 services 不给 authority，缓存会落在当前 workspace 分片下，
                // 来源页的内容会污染本地 user 缓存。
                cacheAuthorityKey={
                  settingsSourceServerId && selectedScope.kind === "user"
                    ? sourceUserCacheAuthorityKey
                    : undefined
                }
              />
            </TabsContent>
          ) : null}
          {mode === "plugin" || mode === "mcp" ? (
            <TabsContent
              forceMount
              value="mcps"
              className={
                mcpEditorOpen ? "data-[state=inactive]:hidden" : "mt-6 data-[state=inactive]:hidden"
              }
            >
              {mcpTarget ? (
                <McpSettingsSection
                  workspacePath={mcpTarget.workspacePath}
                  workspaceIdentity={mcpTarget.workspaceIdentity}
                  // 远端四件套整体透传，不要在中间挑选：只传 workspacePath 会让
                  // 远端目标的 MCP 走本机服务，保存到本机目录。
                  remoteSessionId={mcpTarget.remoteSessionId}
                  remoteTarget={mcpTarget.remoteTarget}
                  localWorkspacePath={mcpTarget.localWorkspacePath}
                  isWebRemoteControl={isWebRemoteControl}
                  // scopeFilter 用 effectiveMcpScopeKey 而不是 selectedScope.kind：
                  // 编辑器内改过 Scope 后，新建表单的默认落点必须跟随表单，而不是外层选择。
                  scopeFilter={effectiveMcpScopeKey === "user" ? "user" : "workspace"}
                  // parentScopeKey 传外层 selectedScopeKey：它是「编辑时反解 owner」的基准，
                  // 传 effectiveMcpScopeKey 会把表单当前选择当成服务器归属，保存到错误 scope。
                  parentScopeKey={selectedScopeKey}
                  workspaceTabs={workspaceTabs}
                  searchQuery={searchQueries.mcps}
                  onVisibleCountChange={updateMcpCount}
                  onEditorOpenChange={handleMcpEditorOpenChange}
                  onFormScopeKeyChange={setMcpFormScopeKey}
                  onOpenPluginStore={
                    selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined
                  }
                  showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                  unscopedServices={
                    settingsSourceServerId && effectiveMcpScopeKey === "user"
                      ? currentServices
                      : undefined
                  }
                  cacheAuthorityKey={
                    settingsSourceServerId && effectiveMcpScopeKey === "user"
                      ? sourceUserCacheAuthorityKey
                      : undefined
                  }
                />
              ) : (
                <EmptyState
                  message={intl.formatMessage({
                    id: "settings.plugin.noWorkspace",
                  })}
                />
              )}
            </TabsContent>
          ) : null}
          {mode === "plugin" || mode === "skill" ? (
            <TabsContent forceMount value="skills" className="mt-6 data-[state=inactive]:hidden">
              {target ? (
                <SkillsSection
                  workspacePath={target.workspacePath}
                  workspaceIdentity={target.workspaceIdentity}
                  remoteSessionId={target.remoteSessionId}
                  remoteTarget={target.remoteTarget}
                  isWebRemoteControl={isWebRemoteControl}
                  scopeFilter={selectedScope.kind === "user" ? "user" : "workspace"}
                  searchQuery={searchQueries.skills}
                  onCreateTask={onCreateTask}
                  onDetailOpenChange={setSkillDetailOpen}
                  onOpenPluginStore={
                    selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined
                  }
                  showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                  // 只有插件页模式才让技能详情上报面包屑：
                  // 独立技能入口已有自己的返回层级，再上报会出现两级面包屑。
                  reportDetailBreadcrumb={mode === "plugin"}
                  onVisibleCountChange={updateSkillCount}
                  unscopedServices={
                    settingsSourceServerId && selectedScope.kind === "user"
                      ? currentServices
                      : undefined
                  }
                  cacheAuthorityKey={
                    settingsSourceServerId && selectedScope.kind === "user"
                      ? sourceUserCacheAuthorityKey
                      : undefined
                  }
                />
              ) : (
                <EmptyState
                  message={intl.formatMessage({
                    id: "settings.plugin.noWorkspace",
                  })}
                />
              )}
            </TabsContent>
          ) : null}
          {mode === "command" ? (
            <TabsContent
              forceMount
              value="commands"
              className={
                commandEditorOpen
                  ? "data-[state=inactive]:hidden"
                  : "mt-6 data-[state=inactive]:hidden"
              }
            >
              {commandTarget ? (
                <CommandsSection
                  workspacePath={commandTarget.workspacePath}
                  workspaceIdentity={commandTarget.workspaceIdentity}
                  scopeFilter={effectiveCommandScopeKey === "user" ? "user" : "workspace"}
                  parentScopeKey={selectedScopeKey}
                  workspaceTabs={workspaceTabs}
                  searchQuery={searchQueries.commands}
                  onVisibleCountChange={updateCommandCount}
                  onEditorOpenChange={setCommandEditorOpen}
                  onFormScopeKeyChange={setCommandFormScopeKey}
                  unscopedServices={
                    settingsSourceServerId && effectiveCommandScopeKey === "user"
                      ? currentServices
                      : undefined
                  }
                  cacheAuthorityKey={
                    settingsSourceServerId && effectiveCommandScopeKey === "user"
                      ? sourceUserCacheAuthorityKey
                      : undefined
                  }
                />
              ) : (
                <EmptyState
                  message={intl.formatMessage({
                    id: "settings.plugin.noWorkspace",
                  })}
                />
              )}
            </TabsContent>
          ) : null}
        </Tabs>
      </div>
    </SettingsUserScopeProvider>
  );
}
