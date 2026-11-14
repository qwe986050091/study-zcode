import { SettingsMachinesProvider } from "@/settings/SettingsMachine.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { resolveRemoteConnectionNavigationPresentation } from "@/lib/remoteConnectionPresentation.js";
/* oxlint-disable eslint(max-lines) */
import { ArrowLeft, Rocket, type LucideIcon } from "lucide-react";
import { useStore } from "zustand";
// 营销入口（升级横幅等）通过一个全局 store 请求“跳到某个设置分区”：
// 它跨页面存在，请求必须由设置页显式 finish，否则会一直挂着（INV-14）。
import {
  marketingNavigation,
  finishMarketingNavigation,
  marketingSettingsSections,
} from "@/lib/marketingNavigation.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type {
  AppSettings,
  DesktopCloseToTrayCapability,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  Locale,
  UsageEntitlementSnapshot,
  UserInfo,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_USAGE_TAB,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { getPathLeaf } from "@/lib/path.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
// settingsNavigation 里的 pending 槽位全是模块级单例：写入方（quickpick/marketplace）
// 与消费方（本页）不共享组件树，只能靠这个模块传参。因此这里的每个 consume* 都
// 兼具“读取 + 清空”语义，调用次序就是协议本身（INV-03）。
import {
  addPendingSettingsSectionListener,
  clearPendingSettingsPluginOrigin,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsSourceServerId,
  consumePendingSettingsSourceServerDetails,
  consumePendingSettingsPluginOrigin,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsPluginTab,
  consumePendingSettingsModelProviderTarget,
  consumePendingSettingsUsageTab,
  resolveSettingsSection,
  setPendingSettingsSectionIntent,
  shouldFallbackSettingsUsageTabToApp,
  writeLastSettingsSectionPreference,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { readSidebarUsageCodingPlanSourcePreference } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
// 用量相关的三个依赖各司其职：access 决定“是否有权限看”，fingerprint 决定
// “缓存属于哪个账号”，cacheKey 把两者与 providerId 合成缓存键（INV-09）。
import {
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
} from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import { ArchiveManagement, useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import { resolveRecentRemoteProjectPreference } from "@/project-sidebar/remote-project-connection.js";
// 每个设置分区对应一个 Section 组件，统一约定：
//   props 只收“值 + onChange + workspace 坐标”，不直接访问 store / services；
//   跨分区跳转通过 onNavigate 之类的回调上抛，由本页决定落到哪个 section（INV-19）。
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import { UsageStatsSection, type UsageStatsSectionTab } from "@/settings/UsageStatsSection.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/settings/usage-stats/CodingPlanUsagePanel.js";
import { buildPersonalCodingPlanUsageSource } from "@/lib/codingPlanUsageSources.js";
import { SubagentsSection } from "@/settings/SubagentsSection.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { SegmentPill } from "@/settings/PluginStoreListView.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { HooksSection } from "@/settings/HooksSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { MemorySettingsSection } from "@/settings/MemorySettingsSection.js";
import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import { MigrationSection } from "@/settings/MigrationSection.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { Theme } from "@/useTheme.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";

import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import type { AppToolSearchMode } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CreateTaskRequest, RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";
// settingsPageHelpers 提供“平台裁剪后的分区表”和 General 区内容：
// 分区 id 的可用性判断集中在这里，本页只消费结果，避免各分支各写一套 if（INV-02）。
import {
  createSettingsPageConfig,
  GeneralSectionContent,
  GeneralSectionHeader,
  TaskAutoArchiveSettings,
  isSettingsSectionAvailable,
  resolveSettingsSectionForPlatform,
} from "@/settingsPageHelpers.js";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { AppearanceSectionContent } from "./settingsCodePreview.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import {
  runUserAction,
  runUserActionAsync,
  type UserActionResult,
  type UserActionTrigger,
} from "@/lib/userActionTelemetry.js";
import type { SettingsUserActionFeatureId } from "@/lib/userActionTraceCatalog.js";

// ============================================================
// INV 不变量表（SettingsPage）
// ============================================================
//
// INV-01：activeSection 的初始化优先级只能是「一次性 pending 意图 → 上次离开的分区
//         偏好 → 平台默认分区」。把默认值放到最前会让所有深链入口失效；把偏好放到
//         pending 前会让“从插件市场点设置”永远落在用户上次停留的页面。
//         （守住：useState<SettingsSectionId>(...) 的懒初始化）
// INV-02：section id 只是字符串，随时可能因为版本升级/平台差异不存在；每次渲染都
//         必须经 resolveSettingsSectionForPlatform 兜底。直接按 id 取配置会在远程/
//         非桌面端抛 undefined，整页白屏。
//         （守住：settingsSectionGroups / settingsSections 的 useMemo）
// INV-03：所有 consumePendingXxx 是一次性消费：读到值的同时必须把 pending 槽位清空，
//         否则用户从设置页返回再进入时会重复执行同一个深链跳转（表现为“退不出去”）。
//         （守住：多个 useEffect 中的 consume* 调用）
// INV-04：面包屑由子分区通过 setSettingsBreadcrumbItems 上报，属于“子覆盖父”的临时
//         状态；离开该分区时必须复位为空，否则下一个分区顶部会残留上一页的面包屑。
//         （守住：setSettingsBreadcrumbItems / SettingsHeaderBreadcrumb）
// INV-05：插件页的 origin 与 scopeKey 必须成对建立、成对清理。只清 origin 会让再次
//         进入插件页时沿用旧 scope，打开的是上一次的插件详情而不是列表。
//         （守住：pluginNavigationOrigin / pluginScopeKey 及其清理逻辑）
// INV-06：用量页签不可用时只能回落到 app：shouldFallbackSettingsUsageTabToApp 是
//         唯一判定入口。反序（先渲染再纠正）会让用户看到一帧空白用量页。
//         （守住：UsageStatsSection 的 activeTab 解析）
// INV-07：Coding Plan 页签 id 必须编码 sourceId（codingPlan:<id>），不能用数组下标：
//         套餐列表会随账号变化重排，下标会让用户点 A 看到 B 的用量。
//         （守住：createSettingsUsageCodingPlanTabId / resolve...SourceId）
// INV-08：团队套餐与个人套餐的展示名规则不同；hasMultiplePersonalSources 只统计个人源。
//         把团队源计入“多个人源”会让个人套餐多出一个无意义的后缀，反之团队名会被截断。
//         （守住：resolveSettingsUsageCodingPlanTabLabel / isTeamCodingPlanUsageSource）
// INV-09：权益快照的缓存 key 必须包含账号 provider 指纹；只按用户 id 缓存会让切换
//         账号后继续显示上一个账号的套餐额度（且不会自动刷新）。
//         （守住：buildUsageEntitlementCacheKey 的入参）
// INV-10：远程 workspace 控制器是可选的：远程能力未注入时设置页必须以本地模式完整
//         可用。把 useOptionalRemoteWorkspaceController 的结果当成必需值会在桌面
//         普通窗口下直接抛错。
//         （守住：remoteWorkspaceController 的每个使用点）
// INV-11：主题/界面模式/字体大小等设置以 store 为唯一真源，页面不得保存影子 state；
//         影子值会让“设置页改完、其它窗口没变”或反之，且刷新后回退。
//         （守住：useZCodeStore 选择器与 setter）
// INV-12：字体大小写回必须 clamp 到 UI 支持区间并与 store 的同一常量对齐；随手写
//         一个数字会让用户把界面调到不可用的字号后无法恢复。
//         （守住：setUiFontSizePx 的调用点）
// INV-13：通知开关直接映射 store 布尔值，不能在 UI 层做“先乐观更新再持久化”的两份
//         状态；两份状态在持久化失败时会永久分叉（开关显示开、实际没开）。
//         （守住：notificationEnabled / notificationSoundEnabled 绑定）
// INV-14：marketingNavigation 的 request 是一次性事件：处理完必须 finishMarketingNavigation，
//         否则同一个营销入口会在每次进入设置页时重复抢占 activeSection。
//         （守住：marketingRequest 的 useEffect）
// INV-15：设置页整体渲染在 DesktopWindowFrame 内，返回按钮只负责“回到 chat”，
//         不销毁窗口 frame；把返回做成关闭窗口会让桌面端丢掉整个工作区布局。
//         （守住：TID_SETTINGS_BACK_BUTTON 的 onClick）
// INV-16：Linux close-to-tray 是异步能力查询：未就绪时必须按“不支持”渲染且不写设置。
//         先乐观渲染开关会让用户点到一个尚未安装的能力上（点了没反应）。
//         （守住：linuxCloseToTrayCapability 的 effect 与 linuxCloseToTray）
// INV-17：目录选择能力在远程模式不可用：此时应隐藏入口而不是让点击抛错。
//         远程 workspace 上的“选择本地目录”本身就没有语义。
//         （守住：useSelectDirectory 的使用点 / 远程分支）
// INV-18：settingsSectionNavigationVersion 只在“导航到同一分区”时递增，用于强制
//         子页面重挂或回到顶部；把它混进普通渲染依赖会让每次输入都重置滚动位置。
//         （守住：setSettingsSectionNavigationVersion 的调用点）
// INV-19：子分区拿到的 onNavigate 必须保留 SettingsSectionId 语义（含子页 deep link），
//         不能退化成“关闭设置页”。退化后子页里的“去配置模型”会直接退出设置。
//         （守住：各 Section 组件的 onNavigate / onOpenXxx props）
// INV-20：设置页卸载时必须移除 pending section 监听与所有一次性订阅；漏移除会在
//         HMR 或多次进出后累积回调，旧实例仍然 setState（React 警告 + 内存泄漏）。
//         （守住：addPendingSettingsSectionListener 对应的 cleanup）
//
// 阅读提示：设置页同时承担「路由（section）+ 表单（设置写回）+ 能力差异（平台/远程）」
// 三件事；下文注释里 [事务] 多指“一次设置写回”，[失败路径] 多指“能力缺失或持久化失败”。
// ============================================================
// 设置写回的统一包装：所有“改设置”的异步操作都必须走这里，保证 telemetry 的
// featureId/action/completed 三件套完整；漏传 completed 会让埋点里出现永远“进行中”的
// 记录，后续按完成率分析时把成功操作统计成失败。
function runSettingsActionAsync<T>(options: {
  featureId: SettingsUserActionFeatureId;
  action: string;
  trigger: UserActionTrigger;
  operation: () => Promise<T>;
  completed: UserActionResult;
  failureStage?: string;
}): Promise<T> {
  return runUserActionAsync({
    input: {
      featureId: options.featureId,
      action: options.action,
      trigger: options.trigger,
    },
    operation: options.operation,
    completed: options.completed,
    failureStage: options.failureStage ?? "settings_commit",
  });
}

// 用量页的页签条：第一项永远是“应用用量”，其余由 Coding Plan 数据源动态拼出。
// 页签必须在渲染期同步构造（而不是 effect 里 setState），否则首帧会出现只有
// “应用用量”的闪动，用户点到一半又消失。
function SettingsUsageProviderTabs({
  activeTab,
  codingPlanSources,
  onTabChange,
}: {
  activeTab: UsageStatsSectionTab;
  codingPlanSources: CodingPlanUsageSource[];
  onTabChange: (tab: UsageStatsSectionTab) => void;
}) {
  const { intl } = useZCodeIntl();
  // 页签 id 直接复用 source.id 编码，避免“页签顺序 = 数据源顺序”的隐式假设；
  // 数据源增删时 key 保持稳定，选中态不会漂移到相邻套餐。
  const tabItems = [
    // “应用用量”永远排第一且不参与后端排序：它是唯一不依赖 Coding Plan 数据的页签，
    // 若让动态来源排在前面，网络慢时用户首帧就看不到当前账号的基础用量。
    {
      id: "app" as const,
      label: intl.formatMessage({ id: "settings.usage.tab.appUsage" }),
    },
    ...codingPlanSources.map((source, index) => ({
      id: createSettingsUsageCodingPlanTabId(source.id),
      label: resolveSettingsUsageCodingPlanTabLabel({
        defaultLabel: intl.formatMessage({
          id: "settings.usage.tab.codingPlan",
        }),
        hasMultiplePersonalSources:
          codingPlanSources.filter((item) => !isTeamCodingPlanUsageSource(item)).length > 1,
        index,
        source,
      }),
    })),
  ];
  // 历史/偏好里可能保存着旧的 "codingPlan" 聚合 id；它没有 sourceId，无法定位具体套餐，
  // 因此这里把它映射到第一个数据源，而不是让整条页签条处于无选中态。
  const visibleActiveTab =
    activeTab === "codingPlan" && codingPlanSources[0]
      ? createSettingsUsageCodingPlanTabId(codingPlanSources[0].id)
      : activeTab;

  return (
    <div className="flex items-center gap-1.5">
      {tabItems.map((item) => (
        <SegmentPill
          key={item.id}
          // 选中态用“归一后的 activeTab”比较，而不是原始值：这样历史遗留的
          // "codingPlan" 聚合值也能正确高亮第一份来源，不会出现整条页签无选中。
          active={visibleActiveTab === item.id}
          label={item.label}
          testId={testId(TID_SETTINGS_USAGE_TAB, item.id)}
          onClick={() => onTabChange(item.id)}
        />
      ))}
    </div>
  );
}

// 团队套餐的判定必须看 accountAccess.planKind；用 label 关键字判断会在
// 本地化/改名后静默失效（团队套餐被当成个人套餐，展示名被错误截断）。
function isTeamCodingPlanUsageSource(source: CodingPlanUsageSource): boolean {
  return "planKind" in source.accountAccess && source.accountAccess.planKind === "team-coding-plan";
}

// 前缀既是“页签种类”标记，也是 sourceId 的载荷。改前缀等于让所有已保存的
// 用量页签偏好失配，因此这里集中定义，读写两侧共用同一函数。
function createSettingsUsageCodingPlanTabId(sourceId: string): UsageStatsSectionTab {
  return `codingPlan:${sourceId}`;
}

// 解析失败返回 null（而不是抛错或返回空串）：调用方据此回落到 app 页签，
// 空串会被当成一个“存在的但无数据”的 sourceId，进而请求一个不存在的套餐。
function resolveSettingsUsageCodingPlanSourceId(tab: UsageStatsSectionTab): string | null {
  return tab.startsWith("codingPlan:") ? tab.slice("codingPlan:".length) : null;
}

// 展示名规则：团队套餐去掉 "BigModel - " 前缀，个人套餐在存在多源时去掉
// " - Coding Plan" 后缀；只有单一来源时才使用默认文案，避免“团队”和“个人”
// 两个页签标题一模一样导致用户无法区分。
function resolveSettingsUsageCodingPlanTabLabel({
  defaultLabel,
  hasMultiplePersonalSources,
  source,
}: {
  defaultLabel: string;
  hasMultiplePersonalSources: boolean;
  index: number;
  source: CodingPlanUsageSource;
}): string {
  if (isTeamCodingPlanUsageSource(source)) {
    return source.label.replace(/^BigModel\s*-\s*/i, "").trim() || source.label;
  }
  if (hasMultiplePersonalSources) {
    return source.label.replace(/\s*-\s*Coding Plan$/i, "").trim() || source.label;
  }
  return defaultLabel;
}

// 判断“当前 provider 是否有可展示的套餐”：[失败路径] quota 查询失败时服务仍能
// 确认 provider 归属，此时必须保留入口；只有明确 no_plan 才隐藏，否则网络抖动
// 会让用户的套餐页签凭空消失且无法恢复。
function hasActiveCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  return (
    snapshot?.provider?.id === providerId &&
    snapshot.unavailableReason !== "no_plan" &&
    (Boolean(snapshot.subscription?.details.length) ||
      // quota 暂时失败时服务仍能确认当前 provider，但旧过滤条件会把
      // Coding Plan tab 当成未开通套餐删除。只有明确 no_plan 才应隐藏入口。
      snapshot.unavailableReason === "unavailable")
  );
}

// 侧栏导航按钮同时服务桌面（图标 + 文案）与窄屏（仅图标 + tooltip）两种形态：
// label 既作可见文案又作 aria-label，不能只传其中之一，否则窄屏下按钮对读屏是空的。
// 窄屏隐藏文案用的是 sr-only（保留可访问性树），不是 hidden——换成 hidden 后
// 读屏只会播报“按钮”，用户无法判断这是哪个分区。
function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    // 提示只在“图标轨”形态下才真正被看到（文案被 sr-only 隐藏），但组件不判断断点：
    // 始终包 tooltip 让宽窄切换时不需要卸载重建按钮（会丢焦点）。
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        // 先展开调用方 props，再写 type 默认值：反序会让默认值覆盖调用方的 type="submit"，
        // 在表单里产生一次意外的提交（设置页目前没有 form，但这是通用组件）。
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors",
          // 图标轨形态下按钮收成 40px 正方形并居中：宽度必须由 size-10 固定，
          // 若只隐藏文案，按钮会塌成一条细线，点击热区也随之消失。
          "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0",
          active
            // 选中态用 surface-hover（与工作区侧栏一致），不使用 accent：
            // accent 是“可点击主操作”的语义，用在这里会让导航项看起来像按钮。
            ? "bg-surface-hover text-foreground"
            : "text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1 max-lg:sr-only">
          {children ?? <span className="truncate text-ui-base text-foreground">{label}</span>}
        </span>
      </button>
    </ControlHintTooltip>
  );
}

export function SettingsPage({
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  // 缺省 false：只有 Web 远控入口会显式传 true。普通桌面/网页误判成远控会隐藏
  // 一批本机可用的入口（插件安装、目录选择），所以默认值必须偏保守。
  isWebRemoteControl = false,
  // 这个 prop 以 _ 前缀保留在签名里是为了对齐 Root 的统一传参（所有页面都收同一组
  // 窗口参数）；设置页自己用 CSS 固定留白，不需要按像素动态计算，因此不解构使用。
  windowsWindowControlsRightPaddingPx: _windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  onOpenRemoteWorkspace,
  // 默认允许打开 workspace：只有以只读/嵌入形态挂载设置页的调用方才显式传 false，
  // 若反过来默认 false，普通入口的设备卡片会全部变成不可点击。
  allowOpenWorkspace = true,
  onLogin,
  onLogout,
  user,
}: {
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;
  /** 远程设备卡「新任务」：激活该设备已打开的 tab 并开新草稿（Root 注入）。 */
  allowOpenWorkspace?: boolean;
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}) {
  // 分区表按平台生成并 memo：配置里含图标组件与顺序，每次渲染重建会让侧栏
  // 每帧都拿到新数组，SettingsSidebarButton 的 memo 全部失效（且选中态比较失效）。
  // 依赖只放三个平台布尔，不放 isWebRemoteControl——远控只是 UI 形态，不改分区集合。
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const { settingsSectionGroups, settingsSections } = useMemo(
    () =>
      createSettingsPageConfig({
        isDesktop: Boolean(isDesktop),
        isMacDesktop: Boolean(isMacDesktop),
        isWindowsDesktop: Boolean(isWindowsDesktop),
      }),
    [isDesktop, isMacDesktop, isWindowsDesktop],
  );
  // 平台按“排除法”推导 Linux：既不是 mac 也不是 win 的桌面就是 Linux。
  // [权衡] 新增平台（如 BSD）会被归到 Linux 分支，这是可接受的：Linux 专属逻辑
  // 只有托盘探测，探测失败会自愈为不可用。Windows/Linux 用内联窗控，mac 用原生红绿灯。
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const platform = usePlatform();
  // 远程控制器可选（INV-10）：Web/普通窗口下为 undefined，所有使用点都必须容错，
  // 不能在这里抛错或强制要求 Root 注入。
  const remoteWorkspaceController = useOptionalRemoteWorkspaceController();
  // 懒初始化只跑一次：consumeInitialSettingsSection 会清空 pending 槽位，放进 effect
  // 里再读就会读到空值（且 StrictMode 下会被消费两次）。
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const initialSection = consumeInitialSettingsSection("general");
    const visibleInitialSection = resolveSettingsSectionForPlatform(
      initialSection,
      settingsSections,
    );
    // 设置页首次挂载时也要写入当前落点。否则用户直接打开再退出，
    // 下一次仍可能因为没有偏好记录而回到旧默认入口。
    writeLastSettingsSectionPreference(visibleInitialSection);
    return visibleInitialSection;
  });
  // 服务器管理深链的两个参数同样一次性消费：id 驱动选中项，details 决定是否直接
  // 展开详情。分开存储是为了让“只带 id”的入口也能定位到列表行而不打开抽屉。
  const [targetSourceServerId, setTargetSourceServerId] = useState(
    consumePendingSettingsSourceServerId,
  );
  const [targetSourceServerDetails, setTargetSourceServerDetails] = useState(
    consumePendingSettingsSourceServerDetails,
  );
  // 插件页的初始 tab 来自“插件市场 → 设置”的深链；默认值由 lib 层决定，
  // 这里不写死 "installed"，否则市场入口会永远停在已安装列表。
  const [pluginTab, setPluginTab] = useState(() => consumePendingSettingsPluginTab());
  // Linux 关闭驻留托盘能力查询（spec：docs/desktop/linux-close-to-tray.md）：打开设置页时
  // 经 platform IPC 触发 main 侧探测（带 stale 缓存），用户装完 AppIndicator 扩展重开
  // 设置页即可解除置灰；Web/远控无桥不查询。
  const [linuxCloseToTrayCapability, setLinuxCloseToTrayCapability] =
    useState<DesktopCloseToTrayCapability | null>(null);
  useEffect(() => {
    if (!isLinuxDesktop) {
      return;
    }
    let cancelled = false;
    platform
      .getCloseToTrayCapability?.()
      .then((capability) => {
        // 页面可能在 IPC 返回前就卸载（用户点了返回）；这里必须丢弃结果，
        // 否则会对已卸载组件 setState，StrictMode 下还会覆盖新实例的探测结果。
        if (!cancelled) {
          setLinuxCloseToTrayCapability(capability);
        }
      })
      // 旧平台可能没有该 IPC：静默失败，让 UI 停留在“探测中 → 不可用”，
      // 不要 toast 打扰用户，也不要把它当成“支持”。
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLinuxDesktop, platform]);
  // 非 Linux 不构造这个能力对象：传 undefined 让 General 区完全不渲染该项，
  // 而不是渲染一个永远 disabled 的开关（Windows 侧另有 closeToTrayOnWindows）。
  const linuxCloseToTray = isLinuxDesktop
    ? {
        // 探测中按不可用锁定，防止查询完成前误开导致关窗失联
        // （开关可点但能力未确认时，用户一开窗就会“点关闭 → 进程直接退出”）。
        disabled: linuxCloseToTrayCapability === null || !linuxCloseToTrayCapability.supported,
        unavailable: linuxCloseToTrayCapability?.supported === false,
        gnomeLikeHint:
          linuxCloseToTrayCapability?.supported === false &&
          linuxCloseToTrayCapability.gnomeLikeWithoutTray,
      }
    : undefined;
  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  // 营销入口只在“目标分区确实存在且已到达”时结束：提前 finish 会让请求在
  // activeSection 还没切过去时就被丢弃，用户点了营销卡片却停在原分区。
  useEffect(() => {
    if (marketingRequest?.target.page !== "settings") return;
    const target = marketingRequest.target;
    const section = target.section ? marketingSettingsSections[target.section] : activeSection;
    if (!settingsSections.some((item) => item.id === section)) {
      // 目标分区在当前平台/灰度下不存在：必须 finish 并带错误，否则请求永远挂着，
      // 用户下次进设置页仍会被同一个营销请求劫持（INV-14）。
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_navigation_unavailable"));
    } else if (activeSection === section && !target.provider_id) {
      // 带 provider_id 的请求不在这里 finish：它还要落到具体 provider 详情，
      // 由 ModelProviderSection 消费 pendingModelProviderTarget 后再结束。
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [activeSection, marketingRequest, settingsSections]);
  // origin 与 scopeKey 必须成对初始化、成对清理（INV-05）：
  // origin 决定面包屑与返回目标，scopeKey 决定插件列表读 user 还是 workspace。
  // 只消费其中一个会让“从市场进入”落到 workspace 列表（看上去插件全没了）。
  const [pluginNavigationOrigin, setPluginNavigationOrigin] = useState(() =>
    consumePendingSettingsPluginOrigin(),
  );
  const [pluginScopeKey, setPluginScopeKey] = useState(() =>
    consumePendingSettingsPluginScopeKey(),
  );
  const [settingsSectionNavigationVersion, setSettingsSectionNavigationVersion] = useState(0);
  // 版本号只用于“同一个分区被再次导航”时强制子页重挂 + 回到顶部（INV-18）。
  // 它刻意不进任何数据依赖：混进去会让每次输入都重置滚动位置。
  useEffect(() => {
    // React Strict Mode 会双执行 state initializer；来源和 scopeKey 都在挂载完成后再清理，
    // Marketplace 只返回 User 已安装视图；Workspace 仍通过设置页自身的配置层切换进入。
    // 注意：清理放在 effect（而非 initializer）里，因为 initializer 可能被丢弃不提交，
    // 在那里清空会让真正提交的那次读到空值。
    clearPendingSettingsPluginOrigin();
    clearPendingSettingsPluginScopeKey();
  }, []);
  // 面包屑是“子分区临时覆盖”的状态，默认空数组表示由设置页自己渲染顶层路径；
  // 用 readonly 数组避免子分区拿到引用后原地 push（父层不会感知变化）。
  const [settingsBreadcrumbItems, setSettingsBreadcrumbItems] = useState<
    readonly SettingsBreadcrumbItem[]
  >([]);
  // 下面这些 store 值全部“读值 + 取 setter”成对出现：设置页只做受控展示，
  // 写回统一走 store action（带持久化与跨窗口广播），页面不缓存副本（INV-11）。
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  // 代码预览设置是一个对象 patch：读出来整体展示，写回时按 key 合并，
  // 因此不能像枚举那样把 setter 直接交给下拉，必须走带埋点的 patch handler。
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const setCodePreviewSettings = useZCodeStore((state) => state.setCodePreviewSettings);
  // 字号是连续数值：滑杆每帧都会触发写入，clamp 与节流都在 store 内部完成，
  // 页面若再加一层防抖，拖动末尾的值会丢失（松手后字号回弹一档）。
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  const notificationEnabled = useZCodeStore((state) => state.notificationEnabled);
  const setNotificationEnabled = useZCodeStore((state) => state.setNotificationEnabled);
  const notificationSoundEnabled = useZCodeStore((state) => state.notificationSoundEnabled);
  const setNotificationSoundEnabled = useZCodeStore((state) => state.setNotificationSoundEnabled);
  // provider 视图在 loading/error 时都视为不可用；这里刻意区分“未 ready”与
  // “ready 但为空”：前者用于显示检查中，后者才代表确实没有可用的 Coding Plan provider。
  const usageProviderSettingsRead = useProviderSettingsView();
  // 未 ready 时显式归一为 null：把 loading 当成“没有 provider”会让用量页在首帧
  // 渲染成空态并额外触发一次 entitlement 请求（缓存 key 用到了 fingerprint）。
  const usageProviderSettingsView =
    usageProviderSettingsRead.state.status === "ready"
      ? usageProviderSettingsRead.state.view
      : null;
  const usageProviderSettingsLoading = usageProviderSettingsRead.state.status !== "ready";
  // provider 可能不存在（未登录、被裁剪、配置尚未加载），因此这两个 find 的结果
  // 全程按可选处理；下游任何 `!` 断言都会在未登录时直接崩溃。
  // 内置 Coding Plan provider 的 id 一律取自共享常量而不是字面量：模型侧改名时这里会
  // 编译失败；写字符串则只会静默查不到 provider（表现为套餐页签永远不出现）。
  const usageZaiProvider = usageProviderSettingsView?.providers.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const usageBigmodelProvider = usageProviderSettingsView?.providers.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  // 每个内置 Coding Plan provider 都取三样东西：provider 本身（用于展示）、
  // access（是否已开通）与 fingerprint（缓存 key）。fingerprint 必须按 provider 分别取，
  // 共用一个会让两个套餐的 entitlement 缓存互相覆盖（INV-09）。
  const usageZaiProviderAccess = resolveEntitledAccountProviderAccess(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const usageBigmodelProviderAccess = resolveEntitledAccountProviderAccess(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const usageZaiProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const usageBigmodelProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  // team 与 individual 是两套账号体系，fingerprint 必须分别解析：
  // 复用个人 fingerprint 会让团队商品列表命中个人缓存，表现为“团队套餐看不到商品”。
  const usageZaiTeamProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  );
  const usageBigmodelTeamProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    usageProviderSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  );
  // [资源] entitlement 请求只在“用量页可见 + provider 指纹已知”时发起：
  // 进设置页就无条件拉取会让每天只改主题的用户也消耗套餐查询配额。
  const usageZaiEntitlement = useUsageEntitlement({
    enabled:
      activeSection === "usage" &&
      !usageProviderSettingsLoading &&
      Boolean(usageZaiProviderFingerprint),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: usageZaiProviderAccess?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    // cacheKey 把“账号身份”编码进缓存：同一台机器切换账号后 key 变化，
    // 旧账号的额度不会被复用；去掉 fingerprint 会串号（INV-09）。
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: usageZaiProviderFingerprint,
    }),
    // 个人 Usage source 依赖 entitlement snapshot；冷启动无缓存时若不先探测，
    // source 不会渲染，子面板也无法触发 access 刷新。共享 freshness window 继续负责限频。
    refreshOnMount: true,
  });
  // bigmodel 与 zai 是两套独立订阅：enabled / cacheKey / preferredProviderId 必须各自成立，
  // 合并成一次 hook 调用会让其中一个账号未登录时另一个也停止探测。
  const usageBigmodelEntitlement = useUsageEntitlement({
    enabled:
      activeSection === "usage" &&
      !usageProviderSettingsLoading &&
      Boolean(usageBigmodelProviderFingerprint),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: usageBigmodelProviderAccess?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: usageBigmodelProviderFingerprint,
    }),
    refreshOnMount: true,
  });
  // 原只拉 bigmodel family 的企业 pricing，zai team plan 在使用统计页
  // 永远拿不到 team project 上下文；后续又误用 Individual Provider 的权益作为 Team
  // 商品门禁，导致仅有 Team Plan 的账号仍然没有 Usage 来源。企业商品只依赖对应的
  // Team Account Provider，个人额度继续依赖 Individual Provider，避免两个产品身份串线。
  const usageBigmodelEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled: !usageProviderSettingsLoading && Boolean(usageBigmodelTeamProviderFingerprint),
    authenticated: true,
    family: "bigmodel",
  });
  const usageZaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled: !usageProviderSettingsLoading && Boolean(usageZaiTeamProviderFingerprint),
    authenticated: true,
    family: "zai",
  });
  // 商品列表来自两个 family，只保留 subscribed 的条目：未订阅的 team 商品
  // 不应生成用量来源（否则用户点进去看到的是“开通”而不是用量）。
  const usageSubscribedTeamProducts = useMemo(
    () => [
      ...(usageBigmodelEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(usageZaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [
      usageBigmodelEnterpriseProducts.snapshot?.productList,
      usageZaiEnterpriseProducts.snapshot?.productList,
    ],
  );
  // 用量页签同样一次性消费：保留旧的聚合值 "codingPlan" 以兼容历史深链，
  // 其余未知值一律回落到 app（不能把任意字符串当页签 id 透传）。
  const [usageActiveTab, setUsageActiveTab] = useState<UsageStatsSectionTab>(() => {
    const pendingTab = consumePendingSettingsUsageTab();
    return pendingTab === "codingPlan" ? "codingPlan" : (pendingTab ?? "app");
  });
  // 个人套餐来源必须同时满足“账号已开通该 provider”与“快照确认有套餐”：
  // 只看 access 会把已下线/未开通的套餐列出来，点进去全是空数据。
  // 先 zai 后 bigmodel：顺序固定，页签顺序才稳定；用 Object.values 之类的遍历
  // 会随 provider 加载顺序变化，用户的页签位置在刷新后乱跳。
  const usagePersonalCodingPlanSources = useMemo(() => {
    const sources: CodingPlanUsageSource[] = [];
    if (
      usageZaiProviderAccess &&
      hasActiveCodingPlanSnapshot(
        usageZaiEntitlement.snapshot,
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      )
    ) {
      sources.push(
        buildPersonalCodingPlanUsageSource({
          providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          accountAccess: usageZaiProviderAccess.access,
          label: usageZaiProvider?.providerName,
        }),
      );
    }
    if (
      usageBigmodelProviderAccess &&
      hasActiveCodingPlanSnapshot(
        usageBigmodelEntitlement.snapshot,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      )
    ) {
      sources.push(
        buildPersonalCodingPlanUsageSource({
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          accountAccess: usageBigmodelProviderAccess.access,
          label: usageBigmodelProvider?.providerName,
        }),
      );
    }
    return sources;
  }, [
    usageBigmodelEntitlement.snapshot,
    usageBigmodelProvider,
    usageBigmodelProviderAccess,
    usageZaiEntitlement.snapshot,
    usageZaiProvider,
    usageZaiProviderAccess,
  ]);
  // 团队来源由 buildCodingPlanUsageSources 统一构造：这里先把两个 team provider 的
  // access 归一成“存在才放入”的稀疏对象，避免把 undefined 当成“无权限”传下去。
  // 这里对同一个 provider 调用了两次 resolve（判空 + 取值）：这是为了在对象字面量里
  // 完成类型收窄，避免先赋值给临时变量。有副作用的风险为零（纯函数），但若将来
  // 改成远程查询，必须改回单次调用，否则一次渲染会发两次请求。
  const usageTeamCodingPlanSources = useMemo(
    () =>
      buildCodingPlanUsageSources({
        accountAccesses: {
          ...(resolveEntitledAccountProviderAccess(
            usageProviderSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
          )?.access
            ? {
                zai: resolveEntitledAccountProviderAccess(
                  usageProviderSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
                )!.access,
              }
            : {}),
          ...(resolveEntitledAccountProviderAccess(
            usageProviderSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
          )?.access
            ? {
                bigmodel: resolveEntitledAccountProviderAccess(
                  usageProviderSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
                )!.access,
              }
            : {}),
        },
        subscribedTeamProducts: usageSubscribedTeamProducts,
      }),
    [usageProviderSettingsView, usageSubscribedTeamProducts],
  );
  // 页签渲染顺序固定为“个人在前、团队在后”：这是用户心智顺序，也是页签 id
  // 默认值的来源（聚合 "codingPlan" 映射到第一个来源）。
  const usageCodingPlanSources = useMemo(
    () => [...usagePersonalCodingPlanSources, ...usageTeamCodingPlanSources],
    [usagePersonalCodingPlanSources, usageTeamCodingPlanSources],
  );
  // 当前选中的来源 id：聚合页签取第一个来源，其余从 id 前缀里解出 sourceId。
  // 解析失败时保持 null（页面渲染空态），不要错误地落到第一个来源上。
  const selectedUsageCodingPlanSourceId =
    usageActiveTab === "codingPlan"
      ? (usageCodingPlanSources[0]?.id ?? null)
      : resolveSettingsUsageCodingPlanSourceId(usageActiveTab);
  // 选中来源必须从当前 sources 里重新 find，而不是缓存上一帧的对象：套餐下线或换账号后
  // 旧对象仍存在，直接传给子面板会请求一个已不存在的套餐（空数据且没有错误提示）。
  const selectedUsageCodingPlanSource =
    usageCodingPlanSources.find((source) => source.id === selectedUsageCodingPlanSourceId) ?? null;
  // 是否有任何 Coding Plan 来源决定页签条是否出现；为 false 时不应渲染空页签，
  // 否则用户会看到一个点了没内容的 Coding Plan 页签（INV-06 的前置判断）。
  const showUsageCodingPlanTab = usageCodingPlanSources.length > 0;
  // “检查中”只包含 loading 或无结果无错误两种情况；已经有 error 时不能再显示 spinner，
  // 否则一次失败会变成永久加载（用户无法重试、页签也不出现）。
  // 一次失败后停止 spinner（error 参与判断）比“无限重试”更安全：重试由用户点击
  // 刷新触发，避免 401/断网时把请求打成忙循环。
  const checkingUsageZaiCodingPlanTab = Boolean(
    usageZaiProviderFingerprint &&
    (usageZaiEntitlement.loading || (!usageZaiEntitlement.snapshot && !usageZaiEntitlement.error)),
  );
  const checkingUsageBigmodelCodingPlanTab = Boolean(
    usageBigmodelProviderFingerprint &&
    (usageBigmodelEntitlement.loading ||
      (!usageBigmodelEntitlement.snapshot && !usageBigmodelEntitlement.error)),
  );
  // 汇总态：任一来源仍在探测就整体显示“检查中”。这里不能只看 loading，
  // 还要包含 settings 本身未 ready 与企业商品列表未返回的两种情况。
  const checkingUsageCodingPlanTab =
    usageProviderSettingsLoading ||
    checkingUsageZaiCodingPlanTab ||
    checkingUsageBigmodelCodingPlanTab ||
    usageBigmodelEnterpriseProducts.loading ||
    usageZaiEnterpriseProducts.loading;
  // 模型 provider 深链目标同样是“消费一次、之后由本地 state 持有”：
  // 直接依赖 pending 会因为它被清空而在下一次渲染丢掉目标，导致打开的是列表首页。
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  // 两个 state 是有意拆开的：initialModelProviderTarget 是“挂载时那一次深链”，
  // 永不变化；pending 则允许页面存续期间再次收到导航请求覆盖它。
  // 合并成一个会让后续导航无法替换目标（或让首次目标被提前清空）。
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const [pendingModelProviderTarget, setPendingModelProviderTarget] = useState<
    SettingsModelProviderTarget | undefined
  >(() => initialModelProviderTarget);
  // 页签切换只改本地选中值，不立刻写偏好：偏好写入由“更多”入口显式完成，
  // 每次点页签都写会让用户在别的入口下次打开时被强制带回这里。
  const handleUsageTabSelect = useCallback((tab: UsageStatsSectionTab) => {
    setUsageActiveTab(tab);
  }, []);
  /*
   * 使用统计是账号级 sources，不再绑定当前 workspace 连接方式。
   * 旧入口只会写入 "codingPlan" 意图；等 sources 加载后需要落到真实来源。
   * 剩余额度「更多」等入口会先写入来源偏好（当前 coding plan 类型/团队项目），
   * 解析时优先选中该来源，缺失或已不可用时回退第一份真实来源。
   */
  useEffect(() => {
    // 只在“聚合页签 + 已有来源”时解析一次，并用 setState 立即改成具体 id；
    // 这样 effect 的依赖条件下次就不再满足，不会形成循环（见下一行早退）。
    if (usageActiveTab !== "codingPlan" || !usageCodingPlanSources[0]) {
      return;
    }
    const preferredSourceId = readSidebarUsageCodingPlanSourcePreference();
    const preferredSource = preferredSourceId
      ? usageCodingPlanSources.find((source) => source.id === preferredSourceId)
      : undefined;
    setUsageActiveTab(
      createSettingsUsageCodingPlanTabId((preferredSource ?? usageCodingPlanSources[0]).id),
    );
  }, [usageActiveTab, usageCodingPlanSources]);
  // 兜底：偏好里的具体 sourceId 失效（套餐下线/换账号）时回落到第一个来源或 app。
  // 若这里不做纠正，页签条会没有选中项，内容区永远空着。
  useEffect(() => {
    if (
      usageActiveTab === "app" ||
      usageActiveTab === "codingPlan" ||
      selectedUsageCodingPlanSource
    ) {
      return;
    }
    setUsageActiveTab(
      usageCodingPlanSources[0]
        ? createSettingsUsageCodingPlanTabId(usageCodingPlanSources[0].id)
        : "app",
    );
  }, [selectedUsageCodingPlanSource, usageActiveTab, usageCodingPlanSources]);
  const setNewUserOnboardingOpen = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  // 引导弹窗的开关在全局 store 里：它会盖住整个应用（不仅是设置页），
  // 因此不能由本页的局部 state 控制，否则关闭设置页会把弹窗一起卸载。
  const requestOnboardingDialog = () => setNewUserOnboardingOpen(true);
  // 分区切换的唯一入口：先经 resolveSettingsSection 校验目标 id 是否存在，
  // 再落 state 并立即写偏好。绕过这里直接 setActiveSection 会漏掉持久化和兜底，
  // 深链到已删除分区时页面会空。
  const setActiveSettingsSection = useCallback(
    (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
      const resolvedSection = resolveSettingsSection(section, fallbackSection);
      setActiveSection(resolvedSection);
      writeLastSettingsSectionPreference(resolvedSection);
    },
    [activeSection],
  );
  // 非桌面端没有“远程设备”概念：直接落到 general，而不是渲染一个空的分区页。
  // 用 effect 纠正是为了覆盖“偏好里存着 remoteDevices 后换到 Web 打开”的情况。
  useEffect(() => {
    if (!isDesktop && activeSection === "remoteDevices") {
      setActiveSettingsSection("general");
    }
  }, [activeSection, isDesktop, setActiveSettingsSection]);
  // 升级弹窗的 providerId 与 funnelContext 原样透传：funnel 埋点依赖入口上下文，
  // 在这里补默认值会把所有入口都记成同一个来源。
  const handleOpenCodingPlanUpgradeSettings = useCallback(
    (
      providerId: string,
      funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext,
    ) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext,
      });
    },
    [openCodingPlanUpgrade],
  );
  // 子代理区的“管理模型”只做一次分区内跳转，不关闭设置页：
  // 用户配完模型后应该按返回回到 subagents，而不是回到工作区（INV-19）。
  const handleOpenModelProviderSettings = useCallback(() => {
    setActiveSettingsSection("modelProvider");
  }, [setActiveSettingsSection]);
  const handleOpenUsageSettings = useCallback(() => {
    // 设置页 sidebar footer 里的齿轮/返回按钮复用 onBack，
    // 但头像菜单的“使用统计”应该停留在设置页并切到 Usage，不能跟着返回工作区。
    setActiveSettingsSection("usage");
  }, [setActiveSettingsSection]);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  // activateTab / openSettingsTab 都来自 tabStore：设置页通过它们驱动工作区导航，
  // 不自己构造 tab 对象，否则会与 Root 的 tab 状态形成两份真源。
  const activateTab = useTabStore((state) => state.activateTab);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const tabs = useTabStore((state) => state.tabs);
  // 只保留 workspace tab 并 memo：下游（消息范围、插件作用域）把它当依赖数组，
  // 每次 filter 出新数组会让这些 useMemo 全部重算。
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  // Settings 打开后 activeTab 会变成 settings，本地反查 activeTab 读 identity 会稳定丢失。
  // 这里改为读取 tabStore 维护的“最近激活 workspace identity”，让插件管理继续命中正确远端。
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  // 选中 tab 的匹配优先用 identity（远端/本地可同路径），identity 缺失时才退化到
  // “无 identity 的 tab”；直接取 matchingTabs[0] 会在远端与本地同路径时选错。
  const activeWorkspaceTab = useTabStore((state) => {
    const workspacePath = state.activeWorkspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentity = state.activeWorkspaceIdentity ?? undefined;
    const matchingTabs = state.tabs
      .filter(isWorkspaceTab)
      .filter((tab) => tab.workspacePath === workspacePath);
    return (
      matchingTabs.find((tab) =>
        workspaceIdentity ? tab.workspaceIdentity === workspaceIdentity : !tab.workspaceIdentity,
      ) ??
      matchingTabs[0] ??
      null
    );
  });
  // 模型连通性测试只能打到“本机可达”的 workspace：远端 workspace 的路径在本地
  // 不存在，直接用 activeWorkspacePath 会让请求打到一个不存在的目录。
  const localModelProviderConnectivityWorkspacePath = useMemo(
    () =>
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeWorkspaceTab,
        workspaceTabs,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath, activeWorkspaceTab, workspaceTabs],
  );
  // 三个来源任一存在即视为远端：identity 可能来自远端 tab、remoteSessionId 或
  // remoteTarget（连接中尚未拿到 session）。只看 identity 会漏掉“正在连接”的状态。
  const isRemoteModelProviderWorkspace = Boolean(
    activeWorkspaceIdentity?.trim() ||
    activeWorkspaceTab?.remoteSessionId?.trim() ||
    activeWorkspaceTab?.remoteTarget,
  );
  // 远程 workspace 上目录选择不可用（没有本地文件系统对话框）；
  // 该 hook 会返回 undefined，General 区据此隐藏“浏览”按钮而不是报错（INV-17）。
  const selectDirectory = useSelectDirectory();
  // services 是“当前 workspace 的 services”（可能是远端）；凡是必须落在本机的能力
  // （共享设置、模型配置、记忆库、Source 管理）都显式用 localHostServices，二者不可混用。
  const services = useServices();
  // onboarding record 是账号级偏好（换机/换号同步的来源），因此跟随 workspace services；
  // 它与 sharedSettings 存在字段重叠，写回时两处都要更新（见 handleMemoryEnabledChange）。
  const onboardingRecordService = services.onboardingRecordService;
  const localHostServices = useBaseWorkspaceServices();
  // projectDirectory 是可选的“最近项目”上下文，只在从侧栏目录入口进入时注入；
  // 远程项目跳转需要它匹配偏好，缺失时按“入口不存在”处理而不是猜一个路径。
  const projectDirectory = useOptionalProjectDirectory();
  // SettingsPage 可能挂在远端 workspace 的 ServiceProvider 下；共享设置属于本机 Host，
  // 读写必须固定走本机 settingService，否则会写进远端 setting。
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings({
    services: localHostServices,
  });
  // SourceServer 管理描述的是“这台机器能连到哪里”，属于本机能力，
  // 因此固定取本机 management service；用 workspace services 会在远端页读到远端管理的设备。
  const sourceManagement = localHostServices.sourceServerManagementService;
  // snapshot 只在管理 service 存在时订阅；onError 只记日志不弹 toast，
  // 因为设备列表读失败不应阻断设置页其它分区的正常使用。
  const { snapshot: sourceManagementSnapshot } = useSourceServerManagementSnapshot(
    sourceManagement,
    {
      onError: (error) =>
        logger.warn("[SettingsPage] 读取 Source 状态失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
    },
  );
  // 侧栏的“远端连接状态点”由 snapshot 纯函数推导：不额外维护本地状态，
  // 这样服务端推送新 snapshot 时无需任何同步逻辑（避免状态副本漂移）。
  const remoteDevicesPresentation = useMemo(
    () => resolveRemoteConnectionNavigationPresentation(sourceManagementSnapshot),
    [sourceManagementSnapshot],
  );
  const memoryWorkspaceDisplayNames = useMemo(() => {
    const names = new Set<string>();
    // Memory Scope 的项目顺序以 settings.json recentProjects 为准；打开中的
    // Workspace 只补充尚未持久化的项目，不能抢占最近项目排序。
    for (const path of sharedSettings?.recentProjects ?? []) {
      const name = getPathLeaf(path).trim();
      if (name) names.add(name);
    }
    for (const tab of workspaceTabs) {
      const name = tab.label.trim() || getPathLeaf(tab.workspacePath).trim();
      if (name) names.add(name);
    }
    return [...names];
  }, [sharedSettings?.recentProjects, workspaceTabs]);
  // 这几个布尔用“默认值语义”而不是 ?? 兜底：`!== false` 表示缺省即开启（老配置没有
  // 这个字段时新功能应生效），`=== true` 表示缺省即关闭（必须显式开启）。把两者都
  // 写成 Boolean(...) 会让“默认开启”的开关在首次安装时全是关的。
  const memoryEnabled = sharedSettings?.memoryEnabled === true;
  const toolSearchMode = sharedSettings?.toolSearchMode ?? "off";
  const nativeSearchEnhancementsEnabled = sharedSettings?.nativeSearchEnhancementsEnabled !== false;
  const askUserQuestionAutoResolutionEnabled =
    sharedSettings?.askUserQuestionAutoResolutionEnabled !== false;
  const modelIoFullRetentionEnabled = sharedSettings?.modelIoFullRetentionEnabled === true;
  // 表单草稿：先给安全默认值，随后由“读取 settings / system.info”的 effect 覆盖。
  // 这些 state 不是第二份真源，而是“编辑中的受控副本”——写回后仍以持久化值为准；
  // 因此默认值必须保守（代理为空、字体为空 = 跟随系统），不能猜一个用户没选过的值。
  const [dataBaseDir, setDataBaseDir] = useState("");
  const [terminalInheritSystemProfile, setTerminalInheritSystemProfile] = useState(true);
  const [terminalFontFamily, setTerminalFontFamily] = useState("");
  const [integratedTerminalShell, setIntegratedTerminalShell] =
    useState<IntegratedTerminalShellSelection>({ mode: "auto" });
  const [integratedTerminalShellOptions, setIntegratedTerminalShellOptions] = useState<
    IntegratedTerminalShellOption[]
  >([]);
  // 代理三件套（地址 / 排除列表 / 自定义 CA）只影响本机网络进程，
  // 与 workspace 无关；因此它们和“允许不安全证书”放在同一组、同一份本机 setting 里。
  const [httpProxy, setHttpProxy] = useState("");
  const [httpProxyNoProxy, setHttpProxyNoProxy] = useState("");
  const [httpProxyCaCertPath, setHttpProxyCaCertPath] = useState("");
  const [embeddedBrowserAllowInsecureCertificates, setEmbeddedBrowserAllowInsecureCertificates] =
    useState(false);
  // 归档默认关闭（false）而托盘在 Windows 上默认开启：这两个默认值来自产品约定，
  // 不是“顺手写的初值”。托盘默认 true 是因为 Windows 用户关闭窗口时期望进托盘；
  // 自动归档默认 false 是因为自动删除任务必须由用户显式授权。
  const [taskAutoArchiveEnabled, setTaskAutoArchiveEnabled] = useState(false);
  const [taskAutoArchiveOlderThanDays, setTaskAutoArchiveOlderThanDays] = useState(30);
  const [closeToTrayOnWindows, setCloseToTrayOnWindows] = useState(Boolean(isWindowsDesktop));
  // 硬件加速默认开启：关闭后 WebGL/Canvas 会退化为软件渲染，滚动与动画明显卡顿。
  // 只有用户主动关闭（例如遇到 GPU 驱动崩溃）才写 false，读回时用 ?? true 恢复默认。
  const [
    desktopChromiumHardwareAccelerationEnabled,
    setDesktopChromiumHardwareAccelerationEnabled,
  ] = useState(true);
  // 预览通道与自动下载默认都关闭：二者都会改变实际运行的二进制来源，
  // 属于用户必须显式同意的行为，不能因为“更方便”就在首次安装时替用户打开。
  const [receivePreviewUpdates, setReceivePreviewUpdates] = useState(false);
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  // 两个展示开关的默认方向不同：推理默认展开（用户需要看到模型在想什么），
  // todo 默认折叠（列表变化频繁，展开会淹没正文）。读回时缺省值必须与此一致。
  const [messageStreamShowReasoning, setMessageStreamShowReasoning] = useState(true);
  const [messageStreamShowTodos, setMessageStreamShowTodos] = useState(false);
  // 工具分组按工具族拆成三个开关：explore（搜索/读取）与 terminal（命令）默认开，
  // changes（diff）默认关——合并 diff 会隐藏逐文件改动，默认隐藏属于过度折叠。
  const [toolGroupingExploreEnabled, setToolGroupingExploreEnabled] = useState(true);
  const [toolGroupingTerminalEnabled, setToolGroupingTerminalEnabled] = useState(true);
  const [toolGroupingChangesEnabled, setToolGroupingChangesEnabled] = useState(false);
  // 默认 queue：任务运行中继续输入时排队等待，而不是打断当前回合。
  // 默认值写错会让用户第一次在运行中发消息就意外取消任务（看到已完成的回答被截断）。
  const [zcodeInteractionBehavior, setZCodeInteractionBehavior] =
    useState<ZCodeInteractionBehavior>("queue");
  // 这两个值由 system.info 异步回填：空串表示“尚未探测”，只用于占位提示与是否
  // 渲染 shell 下拉；绝不能把它们当成真实路径或默认平台去做持久化。
  const [defaultHomeDir, setDefaultHomeDir] = useState("");
  const [hostPlatform, setHostPlatform] = useState("");

  useEffect(() => {
    if (
      !shouldFallbackSettingsUsageTabToApp({
        activeTab: usageActiveTab === "app" ? "app" : "codingPlan",
        checkingCodingPlanTab: checkingUsageCodingPlanTab,
        loadingModelProviders: usageProviderSettingsLoading,
        showCodingPlanTab: showUsageCodingPlanTab,
      })
    ) {
      return;
    }

    // 剩余额度入口会先写入 Coding Plan tab 意图，再打开设置页。
    // 如果首帧 provider/entitlement 仍在加载就立刻回退，会让“更多”看起来只打开了 App Usage。
    // 这里等数据确认没有套餐后再回退，避免空入口误导用户。
    setUsageActiveTab("app");
  }, [
    checkingUsageCodingPlanTab,
    showUsageCodingPlanTab,
    usageSubscribedTeamProducts.length,
    usageActiveTab,
    usageProviderSettingsLoading,
  ]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // SettingsPage 已打开时再次从 quickpick 点“个性化/MCP”等设置入口，
        // 页面不会重新挂载，之前写入的 pending section 无人消费，看起来像点击没反应。
        // 这里订阅同窗口跳转意图，立即切换当前设置分区。
        setActiveSettingsSection(section, activeSection);
        // 设置入口是一级路由边界。即使仍落在同一 section，也必须销毁旧的 New/Edit/Detail 子状态。
        setSettingsSectionNavigationVersion((version) => version + 1);
        setTargetSourceServerId(section === "remoteDevices" ? detail?.sourceServerId : undefined);
        setTargetSourceServerDetails(
          section === "remoteDevices" && detail?.sourceServerDetails === true,
        );
        if (section === "usage" && detail?.usageTab) {
          setUsageActiveTab(detail.usageTab);
        }
        if (resolveSettingsSection(section) === "plugin" && detail?.pluginTab) {
          setPluginTab(detail.pluginTab);
          setPluginNavigationOrigin(detail.pluginOrigin);
          setPluginScopeKey(detail.pluginScopeKey);
        } else if (resolveSettingsSection(section) !== "plugin") {
          setPluginNavigationOrigin(undefined);
        }
        if (section === "modelProvider" && detail?.modelProviderId) {
          setPendingModelProviderTarget({
            providerId: detail.modelProviderId,
          });
        }
      }),
    [activeSection, setActiveSettingsSection],
  );

  useEffect(() => {
    // [资源] active 标记代替 AbortController：这里只有两次一次性读取，卸载后丢弃
    // 响应即可；不做这个判断会在返回工作区时对已卸载页面 setState。
    let active = true;
    // 修复原因：远程 tab 的 services 属于 Source，但 Main 启动、native picker 和
    // 本机 shell 枚举都使用 Desktop 配置；读写必须同属 base Host，不能随 tab 切换。
    localHostServices.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        // 只回填本页自己负责的字段；sharedSettings 管理的字段由另一个 effect 覆盖。
        // 两条读路径若都写同一字段，后返回的那次会覆盖用户刚改的草稿（写入竞态）。
        setDataBaseDir(settings.dataBaseDir ?? "");
        setIntegratedTerminalShell(settings.integratedTerminalShell ?? { mode: "auto" });
        setHttpProxy(settings.httpProxy ?? "");
        setHttpProxyNoProxy(settings.httpProxyNoProxy ?? "");
        setHttpProxyCaCertPath(settings.httpProxyCaCertPath ?? "");
        setEmbeddedBrowserAllowInsecureCertificates(
          settings.embeddedBrowserAllowInsecureCertificates ?? false,
        );
        setCloseToTrayOnWindows(settings.closeToTrayOnWindows ?? Boolean(isWindowsDesktop));
        setDesktopChromiumHardwareAccelerationEnabled(
          settings.desktopChromiumHardwareAccelerationEnabled ?? true,
        );
      })
      // 读失败时保持表单默认值：设置页本身必须可用，不能因为读不到配置就整页报错。
      // 用户此时若修改并保存，写入的是“默认值 + 本次修改”，与磁盘旧值合并由服务端负责。
      .catch(() => {});
    // setting.get 与 system.info 互不依赖，并行发起即可；串行只会让首屏多等一个 RTT，
    // 而两者都不会修改对方的字段，不存在读写顺序问题。
    localHostServices.systemService
      .info()
      .then((info) => {
        if (!active) return;
        // homedir 用作目录选择器的初始位置，platform 决定是否显示 shell 下拉；
        // 二者必须来自同一次探测，混用两次调用的结果会在平台识别失败时自相矛盾。
        setDefaultHomeDir(info.homedir);
        setHostPlatform(info.platform);
        // 终端 shell 枚举只有 Windows 有（PowerShell/cmd/WSL）；其他平台清空列表，
        // 避免 UI 里出现一个选了也不生效的 shell 下拉框。
        if (info.platform !== "win32") {
          setIntegratedTerminalShellOptions([]);
          return;
        }
        void localHostServices.systemService
          .listIntegratedTerminalShells()
          .then((options) => {
            if (active) setIntegratedTerminalShellOptions(options);
          })
          .catch(() => {
            if (active) setIntegratedTerminalShellOptions([]);
          });
      })
      // [失败路径] 探测失败时保持空值：不显示 shell 下拉、初始目录留空，
      // 而不是猜一个平台去渲染控件——猜错会让用户选到本机不存在的 shell。
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [localHostServices.systemService, localHostServices.settingService, isWindowsDesktop]);

  useEffect(() => {
    let active = true;
    // 终端 Profile 与任务归档由目标 Environment 消费，仍读 Source；切换后丢弃旧响应。
    // 注意这里的默认值方向不一致：继承系统 Profile 默认 true（新用户直接可用），
    // 归档默认 false（自动删任务必须显式开启），改错任一方向都会造成用户数据意外变化。
    services.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        setTerminalInheritSystemProfile(settings.terminalInheritSystemProfile ?? true);
        setTerminalFontFamily(settings.terminalFontFamily ?? "");
        setTaskAutoArchiveEnabled(settings.taskAutoArchiveEnabled ?? false);
        setTaskAutoArchiveOlderThanDays(settings.taskAutoArchiveOlderThanDays ?? 30);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [services.settingService]);

  // 这个 effect 依赖整个 sharedSettings：另一窗口改了任意一项都会把本地草稿整体
  // 覆盖一遍。这是有意为之——sharedSettings 是唯一真源，设置页的本地 state 只是
  // 编辑缓冲（见上方 INV-11）。正因为如此，这里不需要 active 取消标记：
  // 覆盖是幂等的，晚到的响应也只是把界面刷成最新值。
  useEffect(() => {
    if (!sharedSettings) {
      return;
    }
    setMessageStreamShowReasoning(sharedSettings.messageStreamShowReasoning ?? true);
    setMessageStreamShowTodos(sharedSettings.messageStreamShowTodos ?? false);
    setToolGroupingExploreEnabled(sharedSettings.toolGroupingExploreEnabled ?? true);
    setToolGroupingTerminalEnabled(sharedSettings.toolGroupingTerminalEnabled ?? true);
    setToolGroupingChangesEnabled(sharedSettings.toolGroupingChangesEnabled ?? false);
    setZCodeInteractionBehavior(sharedSettings.zcodeInteractionBehavior ?? "queue");
    setReceivePreviewUpdates(sharedSettings.receivePreviewUpdates ?? false);
    setAutoDownloadAndInstallUpdates(sharedSettings.autoDownloadAndInstallUpdates ?? false);
  }, [sharedSettings]);
  // [事务] 所有设置写回都是“先 await 持久化，成功后才更新本地草稿”：
  // 反过来（先 setState 再写盘）在写失败时会留下“界面已开启、磁盘仍是旧值”的分叉，
  // 刷新后开关自己跳回去，用户会认为设置没保存。
  const handleTerminalInheritSystemProfileChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "toggle_system_profile",
        trigger: "switch",
        operation: () => services.settingService.update({ terminalInheritSystemProfile: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTerminalInheritSystemProfile(enabled);
    },
    [services.settingService],
  );
  // 先 trim 再写：字体族末尾的空格会让 CSS font-family 解析失败（回退到默认字体），
  // 而界面显示“已配置”，用户无法从 UI 看出问题。
  const handleTerminalFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      const normalizedFontFamily = fontFamily.trim();
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "save_font_family",
        trigger: "button",
        operation: () =>
          services.settingService.update({ terminalFontFamily: normalizedFontFamily }),
        completed: { resultSource: "setting_service", configured: normalizedFontFamily.length > 0 },
      });
      setTerminalFontFamily(normalizedFontFamily);
    },
    [services.settingService],
  );
  // shell 选择写 localHostServices 而不是 services：壳枚举属于本机 Host，
  // 写到远端 Source 上会让本机终端读到远端不存在的 shell 路径。
  const handleIntegratedTerminalShellChange = useCallback(
    async (selection: IntegratedTerminalShellSelection) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "change_shell",
        trigger: "select",
        operation: () =>
          localHostServices.settingService.update({ integratedTerminalShell: selection }),
        completed: {
          resultSource: "setting_service",
          valueAfter: selection.mode === "auto" ? "auto" : "explicit",
        },
      });
      setIntegratedTerminalShell(selection);
    },
    [localHostServices.settingService],
  );
  // 共享设置走 updateSharedSettings（带跨窗口广播），与 settingService 路径分开：
  // 这两类配置的存储位置不同，混用会让另一窗口收不到变更。
  const handleToolSearchModeChange = useCallback(
    async (mode: AppToolSearchMode) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "change_tool_search_mode",
        trigger: "select",
        operation: () => updateSharedSettings({ toolSearchMode: mode }),
        completed: { resultSource: "shared_settings", valueAfter: mode },
      });
    },
    [updateSharedSettings],
  );
  // 原生搜索增强依赖各平台自带的检索二进制，切换后由服务层重新初始化索引；
  // 因此这里只写开关，不做“立即重建索引”，否则一次点击会阻塞主进程数秒。
  const handleNativeSearchEnhancementsEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "toggle_native_search",
        trigger: "switch",
        operation: () => updateSharedSettings({ nativeSearchEnhancementsEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  // 自动回答反问会改变模型行为（不再把问题抛给用户），属于“高风险便利开关”：
  // 只写偏好，不撤销已经弹出、正在等待用户输入的问题，避免打断当前交互。
  const handleAskUserQuestionAutoResolutionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_ask_user_auto_resolution",
        trigger: "switch",
        operation: () => updateSharedSettings({ askUserQuestionAutoResolutionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  // 模型 IO 全量保留是隐私敏感开关：只影响后续写入，不追溯删除已有记录，
  // 也不因为企业版而默认开启（默认值来自服务端，设置页不覆盖）。
  const handleModelIoFullRetentionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_model_io_retention",
        trigger: "switch",
        operation: () => updateSharedSettings({ modelIoFullRetentionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  // memoryEnabled 同时写两处：sharedSettings（运行时真源）与 onboarding record
  // （换机/换号同步的来源）。只写前者会在登录另一台设备时被旧记录覆盖回 true。
  const handleMemoryEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.memory",
        action: "toggle_memory",
        trigger: "switch",
        operation: async () => {
          await updateSharedSettings({ memoryEnabled: enabled });
          // 手动修改反向回写 record，换号同步不会复活旧值；失败不阻塞开关。
          await onboardingRecordService
            ?.updateRecordPreferences({ memoryEnabled: enabled })
            .catch((cause: unknown) => {
              console.warn("[settings] 回写引导记录失败", String(cause));
            });
        },
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  // 代理修改需要重启才生效：保存成功后显式 toast 告知，completed.requiresRestart
  // 让埋点能区分“已保存但未生效”，避免被统计成完全成功。
  const handleHttpProxyChange = useCallback(
    async (proxy: string) => {
      const normalizedProxy = proxy.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_http_proxy",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: RPC 会丢弃 undefined；清空代理必须传空串，由服务层删除旧字段。
            httpProxy: normalizedProxy,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedProxy.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxy(normalizedProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  // no_proxy 是逗号分隔的域名列表：逐项 trim 并丢弃空项，避免出现 ",, example.com"
  // 这种让底层解析器把空串当通配符（等于全部绕过代理）的输入。
  const handleHttpProxyNoProxyChange = useCallback(
    async (noProxy: string) => {
      const normalizedNoProxy = noProxy
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .join(",");
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_no_proxy",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: 清空 No Proxy 必须传空串，否则旧绕过规则会继续影响下次启动。
            httpProxyNoProxy: normalizedNoProxy,
          }),
        completed: { resultSource: "setting_service", configured: normalizedNoProxy.length > 0 },
      });
      setHttpProxyNoProxy(normalizedNoProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  // CA 证书路径在 Electron 启动参数里被读取（NODE_EXTRA_CA_CERTS），运行期改不了；
  // 故这里只持久化 caCertPath 并提示重启，不热更新证书链。
  const handleHttpProxyCaCertPathChange = useCallback(
    async (caCertPath: string) => {
      const normalizedCaCertPath = caCertPath.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_ca_certificate",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: 清空自定义 CA 必须传空串，否则旧 NODE_EXTRA_CA_CERTS 路径会残留。
            httpProxyCaCertPath: normalizedCaCertPath,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedCaCertPath.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxyCaCertPath(normalizedCaCertPath);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  // 空串必须转换为 undefined（“使用默认目录”），而不是写成 ""：
  // 空字符串会被路径拼接当成相对路径，数据目录会落到进程 cwd 下。
  const handleDataBaseDirChange = useCallback(
    async (dir: string) => {
      await runSettingsActionAsync({
        featureId: "settings.storage",
        action: "change_data_directory",
        trigger: "button",
        operation: () => localHostServices.settingService.updateDataBaseDir(dir || undefined),
        completed: { resultSource: "setting_service", requiresRestart: true },
        failureStage: "data_directory_update",
      });
      // Bugfix: 迁移失败时不能先把本地状态改成失败路径，否则设置页会误显示为已切换。
      setDataBaseDir(dir);
    },
    [localHostServices.settingService],
  );
  // 自动归档会真正删除任务：必须先 await 写盘成功再置本地开关，写失败时保持关闭。
  // 反过来（先亮起再落盘）会让用户以为策略已生效，实际下次启动什么都没归档。
  const handleTaskAutoArchiveEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "toggle_auto_archive",
        trigger: "switch",
        operation: () => services.settingService.update({ taskAutoArchiveEnabled: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTaskAutoArchiveEnabled(enabled);
    },
    [services.settingService],
  );
  // 归档阈值与开关分开持久化：关掉自动归档时仍记住用户选过的天数，
  // 下次重新开启不需要再选一遍。
  const handleTaskAutoArchiveOlderThanDaysChange = useCallback(
    async (days: number) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "change_auto_archive_days",
        trigger: "select",
        operation: () => services.settingService.update({ taskAutoArchiveOlderThanDays: days }),
        completed: { resultSource: "setting_service", valueAfter: String(days) },
      });
      setTaskAutoArchiveOlderThanDays(days);
    },
    [services.settingService],
  );
  // syncAppSettings 只是把“托盘行为”这一运行时偏好通知 main 进程，真源仍是磁盘配置；
  // 因此它放在持久化成功之后调用，失败时不会把 main 的运行时状态改成未保存的值。
  const handleCloseToTrayOnWindowsChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_close_to_tray",
        trigger: "switch",
        operation: () => localHostServices.settingService.update({ closeToTrayOnWindows: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      platform.syncAppSettings?.({ closeToTrayOnWindows: enabled });
      setCloseToTrayOnWindows(enabled);
    },
    [localHostServices.settingService, platform],
  );
  // keep-awake：走 useSettings 统一写盘 + syncAppSettings，和 Automations/创建页入口共享同一状态源。
  const handleKeepAwakeWhileRunningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_keep_awake",
        trigger: "switch",
        operation: () => updateSharedSettings({ keepAwakeWhileRunning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  // 硬件加速开关只在下次启动生效（Chromium 启动参数），UI 必须提示重启；
  // 运行期切换 disableHardwareAcceleration 不会真的改 GPU 进程。
  const handleDesktopChromiumHardwareAccelerationChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_hardware_acceleration",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            desktopChromiumHardwareAccelerationEnabled: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setDesktopChromiumHardwareAccelerationEnabled(enabled);
      toast(
        intl.formatMessage({
          id: "settings.desktopChromiumHardwareAccelerationSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl],
  );
  // 允许不安全证书只作用于内嵌浏览器（不是全进程 Node 请求），用于本地自签服务；
  // 打开后必须提示重启，因为 verifyProc 在 Session 创建时就装好了。
  const handleEmbeddedBrowserAllowInsecureCertificatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.browser",
        action: "toggle_insecure_certificates",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            embeddedBrowserAllowInsecureCertificates: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setEmbeddedBrowserAllowInsecureCertificates(enabled);
      // 证书策略在 main 启动时装到 Session 上，改完必须重启才会换掉 verifyProc。
      toast(
        intl.formatMessage({
          id: "settings.embeddedBrowserAllowInsecureCertificatesSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl],
  );
  // 预览通道是“账号级”偏好：写入 sharedSettings 后由更新服务读取，
  // 本地 state 只用于即时回显（写失败时不会 set，见 handle 开头的通用约束）。
  const handleReceivePreviewUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_preview_updates",
        trigger: "switch",
        operation: () => updateSharedSettings({ receivePreviewUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setReceivePreviewUpdates(enabled);
    },
    [updateSharedSettings],
  );
  // 自动下载与安装在下载阶段可以随时开始，但安装会延迟到当前任务空闲；
  // 这里只写偏好，不触发 checkForUpdates，用户可能在截图或演示。
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_auto_update",
        trigger: "switch",
        operation: () => updateSharedSettings({ autoDownloadAndInstallUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setAutoDownloadAndInstallUpdates(enabled);
    },
    [updateSharedSettings],
  );
  // 这两个开关只影响“消息流如何展示”（是否打印推理、是否展示 todo），
  // 不参与模型调用参数。因此写入 sharedSettings 而不是 provider 配置；
  // 若误接到请求参数上，关掉展示会连带改变模型行为。
  const handleMessageStreamShowReasoningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_reasoning",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowReasoning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowReasoning(enabled);
    },
    [updateSharedSettings],
  );
  // todo 展示与“工具分组”互不影响：前者决定消息流里是否出现 todo 卡片，
  // 后者决定工具调用是否折叠成分组；把二者绑到同一个 key 会让用户关掉一个时另一个也失效。
  const handleMessageStreamShowTodosChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_todos",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowTodos: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowTodos(enabled);
    },
    [updateSharedSettings],
  );
  // 工具分组是三个独立开关（explore / terminal / changes），分别对应不同的工具族；
  // 打开或关闭其一不得重写另外两个，否则用户在三个开关之间来回切会互相抵消。
  const handleToolGroupingExploreEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_explore_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingExploreEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingExploreEnabled(enabled);
    },
    [updateSharedSettings],
  );
  // terminal 分组只影响“命令类工具调用”的折叠；它和 explore 分组写入不同的 key，
  // 因此切换其中一个不能顺手把另外两个也重置（否则用户来回点会互相抵消）。
  const handleToolGroupingTerminalEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_terminal_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingTerminalEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingTerminalEnabled(enabled);
    },
    [updateSharedSettings],
  );
  // changes 分组默认关闭，因此这里的写入更多是“用户主动展开 diff 汇总”：
  // 关闭时不能清空其它分组开关，也不能反过来把 messageStreamShowTodos 一起改掉。
  const handleToolGroupingChangesEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_changes_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingChangesEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingChangesEnabled(enabled);
    },
    [updateSharedSettings],
  );
  // 交互行为枚举由类型约束，但运行期仍只接受三种已知值；这里原样写入，
  // 不做字符串映射——映射表一旦和枚举新增不同步，会写进一个后端不认识的值。
  const handleZCodeInteractionBehaviorChange = useCallback(
    async (behavior: ZCodeInteractionBehavior) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "change_interaction_behavior",
        trigger: "select",
        operation: () => updateSharedSettings({ zcodeInteractionBehavior: behavior }),
        completed: { resultSource: "shared_settings", valueAfter: behavior },
      });
      setZCodeInteractionBehavior(behavior);
    },
    [updateSharedSettings],
  );
  // 语言下拉的值来自 DOM（string），必须显式白名单收窄：未知值直接忽略，
  // 不能“回退到 system”，否则新增但尚未支持的语言会被静默改成跟随系统。
  const handleFooterLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        runUserAction({
          input: { featureId: "settings.locale", action: "change_locale", trigger: "select" },
          operation: () => setLocalePreference("system"),
          completed: { resultSource: "local_commit", valueAfter: "system" },
          failureStage: "local_commit",
        });
        return;
      }
      if (value === "zh-CN" || value === "en-US") {
        runUserAction({
          input: { featureId: "settings.locale", action: "change_locale", trigger: "select" },
          operation: () => setLocalePreference(value as Locale),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setLocalePreference],
  );
  // 主题 id 必须逐个列举：setTheme 的类型是 Theme，但 select 的 value 是 string；
  // 新增主题时如果忘记加到这里，下拉会显示新项但选择无效（点了没反应）。
  const handleFooterThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        runUserAction({
          input: { featureId: "settings.appearance", action: "change_theme", trigger: "select" },
          operation: () => setTheme(value as Theme),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setTheme],
  );
  // patch 里通常只有一个键：这里用第一个键推导埋点 action。
  // [权衡] 若调用方一次传多个键，埋点只会记录第一个，但写入仍是完整的 patch——
  // 宁可埋点少记，也不能为“准确埋点”把一次原子更新拆成多次写盘。
  const handleCodePreviewSettingsChange = useCallback(
    (patch: Parameters<typeof setCodePreviewSettings>[0]) => {
      const [key] = Object.keys(patch);
      const action =
        key === "lightTheme"
          ? "change_code_light_theme"
          : key === "darkTheme"
            ? "change_code_dark_theme"
            : key === "showLineNumbers"
              ? "toggle_code_line_numbers"
              : key === "wrapLongLines"
                ? "toggle_code_line_wrap"
                : "change_code_font_size";
      const value = Object.values(patch)[0];
      return runUserAction({
        input: { featureId: "settings.appearance", action, trigger: "select" },
        operation: () => setCodePreviewSettings(patch),
        completed: {
          resultSource: "local_commit",
          ...(typeof value === "boolean"
            ? { stateAfter: value ? ("enabled" as const) : ("disabled" as const) }
            : { valueAfter: String(value) }),
        },
        failureStage: "local_commit",
      });
    },
    [setCodePreviewSettings],
  );
  // 查找而不是断言：灰度/平台裁剪会改变 settingsSections，activeSection 可能暂时
  // 不在列表里。下面的兜底 effect 会纠正它，但本帧仍必须能安全渲染（return null），
  // 否则一次异步裁决就会把整页打成白屏。
  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection);
  // 灰度裁决异步到达：sections 列表可能在挂载后变化（如 computerUse 区被灰度移除）。
  // 若用户正停留在被移除的 section，回落到第一个可见区，避免整页 return null。
  // 用裸 setActiveSection 而不是 setActiveSettingsSection：这里是“纠正非法值”，
  // 不该把纠正结果写进用户偏好（否则下次打开又被带回这个非法值）。
  useEffect(() => {
    setActiveSection((current) => resolveSettingsSectionForPlatform(current, settingsSections));
  }, [settingsSections]);
  if (!activeSectionMeta) {
    return null;
  }

  // 侧栏用 titleId，内容页头可用 contentTitleId 覆盖（例如“插件”在页头叫“插件管理”）；
  // 两者不能合并成同一个字段，否则侧栏会被页头的长标题撑成两行。
  const activeSectionLabel = intl.formatMessage({
    id: activeSectionMeta.contentTitleId ?? activeSectionMeta.titleId,
  });
  // 从插件市场进入时，面包屑首段显示“插件市场”而不是“插件”，
  // 用户才能看出返回键会回到市场而不是设置首页。
  const settingsBreadcrumbSectionLabel =
    activeSection === "plugin" && pluginNavigationOrigin === "plugin-store"
      ? intl.formatMessage({ id: "workspace.openPluginsSettings" })
      : activeSectionLabel;
  // 子分区上报的面包屑只有在“首段与当前分区一致”时才采信：切换分区后旧数组
  // 尚未被清理的那一帧必须丢弃，否则页面顶部会闪一下上一页的路径（INV-04）。
  const visibleSettingsBreadcrumbItems =
    settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel
      ? settingsBreadcrumbItems
      : [];
  // 只有“分区 + 至少一层子页”的第二段才算真正的下钻路径；单段面包屑等价于
  // 页头标题本身，用它来隐藏 h2 会让页面失去可见标题（读屏层级也随之断掉）。
  const hasVisibleSettingsBreadcrumb = visibleSettingsBreadcrumbItems.length >= 2;
  const showActiveSectionTitle =
    !hasVisibleSettingsBreadcrumb ||
    (activeSection === "plugin" && pluginNavigationOrigin === "plugin-store");

  return (
    // 最外层是一个 fragment：DesktopWindowFrame 提供窗口 chrome，内部 div 才是
    // 设置页的两列网格。两者不能合并——frame 还服务于其它页面，改动会影响全站窗口。
    // 网格固定为 [68px | 1fr]，lg 断点扩到 268px：68px 是图标轨模式（窄窗仍可用），
    // 268px 才显示完整文案。行高用 minmax(0,1fr) 让内部滚动容器拿到确定高度（见下方注释）。
    <>
      <DesktopWindowFrame
        // frame 的 title 只用于窗口标题与读屏的页面标识，页面内标题由 activeSectionLabel
        // 决定；两者不能复用一个 intl id，否则切换分区时任务栏标题也跟着变。
        title={intl.formatMessage({ id: "settings.title" })}
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div
          // data-active-section 是自动化测试与样式钩子的锚点，必须是稳定的 section id，
          // 不能写成本地化后的标题（切语言会让所有选择器失效）。
          data-testid={TID_SETTINGS_PAGE}
          data-active-section={activeSection}
          // 隐式 auto 行会按 Memory viewer 的内容高度撑出窗口，随后被 DesktopWindowFrame 裁切且没有滚动条。
          // 固定为单个 minmax(0, 1fr) 行，让普通设置页和内部滚动 viewer 都以窗口剩余高度为边界。
          className="relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)]"
        >
          {isWindowsDesktop ? <WindowsTopLeftLogo /> : null}

          {usesInlineWindowControls ? (
            <div
              className={cn(
                "absolute z-30 mt-px mr-px flex h-12 items-center gap-0.5 px-2 pointer-events-auto [app-region:no-drag]",
                // 外沿留白变化后，悬浮操作组也必须同步，否则与内容 Header 错位。
                isWindowsDesktop ? "right-1.5 top-1.5" : "right-1 top-1",
              )}
            >
              {/* Bug 原因：Windows/Linux 设置页仍保留旧 caption 下箭头，与主界面和 macOS 的帮助入口不一致。
                  统一复用问号帮助按钮，并让它在普通 flex 流中紧邻自绘窗控。
                  Settings 的独立标题层还需计入 4px 外层留白和 1px 边框，才能与 Workspace 控制组对齐。 */}
              <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} />
              <DesktopWindowControls />
            </div>
          ) : null}
          <aside className="min-w-0">
            <div className="flex h-full flex-col">
              <div className="h-12 [app-region:drag]"></div>
              <div className="px-2 pb-3 pt-3">
                {onBack ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "workspace.backToWorkspace",
                    })}
                    side="right"
                    align="center"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      data-testid={TID_SETTINGS_BACK_BUTTON}
                      aria-label={intl.formatMessage({
                        id: "workspace.backToWorkspace",
                      })}
                      className="m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl bg-surface px-1.5 text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground max-lg:m-1 max-lg:size-10 max-lg:justify-center max-lg:px-0"
                      // 从插件市场进入时，必须先 requestPluginStoreOpen 再 onBack：
                      // 反序会让 onBack 先清掉 pluginNavigationOrigin，随后请求只能回到
                      // 插件列表而不是市场，用户点“返回”落错页面。
                      onClick={() => {
                        runUserAction({
                          input: {
                            featureId: "settings.navigation",
                            action: "back_to_workspace",
                            trigger: "button",
                          },
                          operation: () => {
                            if (pluginNavigationOrigin === "plugin-store") {
                              requestPluginStoreOpen("user");
                            }
                            onBack?.();
                          },
                          completed: { resultSource: "local_commit" },
                          failureStage: "navigation_commit",
                        });
                      }}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="max-lg:sr-only">
                        {intl.formatMessage({
                          id: "workspace.backToWorkspace",
                        })}
                      </span>
                    </Button>
                  </ControlHintTooltip>
                ) : null}
              </div>

              <nav
                // nav 必须有 aria-label：页面里还有内容区与面包屑的其它 nav 语义，
                // 没有标签时读屏只能播报“导航”，用户无法区分是侧栏还是内容区。
                aria-label={intl.formatMessage({ id: "settings.navLabel" })}
                className="flex-1 overflow-y-auto px-2 pb-3"
              >
                <div className="space-y-4">
                  {settingsSectionGroups.map((group, groupIndex) => {
                    const groupLabel = intl.formatMessage({
                      id: group.titleId,
                    });
                    const groupLabelId = `settings-sidebar-group-${group.id}`;

                    return (
                      <div
                        key={group.id}
                        role="group"
                        // 分组用 aria-labelledby 而不是 aria-label：窄屏下组标题被 sr-only
                        // 隐藏但仍需被读屏关联，所以标题节点必须留在 DOM 里（不能 display:none）。
                        aria-labelledby={groupLabelId}
                        className={cn(
                          "space-y-1",
                          // 窄屏（图标轨）下组标题不可见，只能靠这条分隔线表达分组；
                          // 宽屏已有标题文字，再加线会让侧栏显得杂乱。
                          groupIndex > 0 && "max-lg:border-t max-lg:border-border max-lg:pt-3",
                        )}
                      >
                        <div
                          id={groupLabelId}
                          className="px-2.5 pb-1 text-ui-sm font-medium text-remote-foreground-muted max-lg:sr-only"
                        >
                          {groupLabel}
                        </div>
                        {group.sections
                          .filter(({ id }) => isSettingsSectionAvailable(id, Boolean(isDesktop)))
                          // 平台过滤必须在渲染期同步完成：不可用分区不能“先渲染再隐藏”，
                          // 否则键盘 Tab 会落到一个不可见的按钮上（焦点丢失）。
                          .map(({ id, icon: Icon, titleId }) => {
                            const isActive = activeSection === id;
                            const label = intl.formatMessage({ id: titleId });

                            return (
                              <SettingsSidebarButton
                                key={id}
                                icon={Icon}
                                label={label}
                                active={isActive}
                                aria-current={isActive ? "page" : undefined}
                                data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                                data-settings-section-nav={id}
                                // 切换分区前必须先清掉一次性目标（插件 origin / serverId），
                                // 否则新分区会继承上一页的深链目标并直接打开错误详情。
                                // 版本号自增让子页面重挂，滚回顶部并重置内部选中态（INV-18）。
                                onClick={() => {
                                  runUserAction({
                                    input: {
                                      featureId: "settings.navigation",
                                      action: "open_section",
                                      trigger: "button",
                                    },
                                    operation: () => {
                                      setPluginNavigationOrigin(undefined);
                                      setTargetSourceServerId(undefined);
                                      setSettingsSectionNavigationVersion((version) => version + 1);
                                      setActiveSettingsSection(id);
                                    },
                                    completed: { resultSource: "local_commit", sectionId: id },
                                    failureStage: "navigation_commit",
                                  });
                                }}
                              >
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="truncate text-ui-base text-foreground">
                                    {label}
                                  </span>
                                  {id === "remoteDevices" ? (
                                    // 连接状态点纯展示：不绑定点击、不拦截事件，
                                    // 点击它应与点击整个导航项等价，否则会出现“点小圆点没反应”。
                                    <RemoteConnectionNavigationDot
                                      presentation={remoteDevicesPresentation}
                                    />
                                  ) : null}
                                </span>
                              </SettingsSidebarButton>
                            );
                          })}
                      </div>
                    );
                  })}
                </div>

                <SettingsSidebarButton
                  icon={Rocket}
                  label={intl.formatMessage({ id: "settings.onboarding" })}
                  // 虚线边框把它与“分区导航”区分开：这不是一个 section，而是弹窗入口；
                  // 用与其它项相同的外观会让用户以为点了会切换页面。
                  className="mt-4 border border-dashed border-border hover:border-border-hover"
                  onClick={() => {
                    runUserAction({
                      input: {
                        featureId: "settings.navigation",
                        action: "open_onboarding",
                        trigger: "button",
                      },
                      operation: requestOnboardingDialog,
                      completed: { resultSource: "local_commit" },
                      failureStage: "dialog_open",
                    });
                  }}
                >
                  <span className="text-ui-base text-foreground">
                    {intl.formatMessage({ id: "settings.onboarding" })}
                  </span>
                </SettingsSidebarButton>
              </nav>

              <div className="max-lg:hidden">
                <WorkspaceSidebarFooter
                  // footer 是工作区共享组件：这里传的 theme/locale 都来自 store 真源，
                  // 所以在设置页切换主题或语言时，底部选择器与外观分区会同步更新。
                  theme={theme}
                  localeMenuValue={localePreference}
                  onLocaleChange={handleFooterLocaleChange}
                  onThemeChange={handleFooterThemeChange}
                  onSettingsButtonClick={onBack}
                  // 使用统计与升级都必须“留在设置页”内跳转：直接 onBack 会让用户
                  // 为了看一眼用量就丢掉当前编辑中的设置页上下文。
                  onUsageClick={handleOpenUsageSettings}
                  onUpgradeClick={handleOpenCodingPlanUpgradeSettings}
                  onLogin={onLogin}
                  onLogout={onLogout}
                  // settingsButtonMode="back" 让底部按钮从“打开设置”变成“返回工作区”：
                  // 设置页里再出现一个“设置”按钮是无效入口，也会让用户误以为点错。
                  settingsButtonMode="back"
                  user={user}
                  // 头像菜单是 WorkspaceSidebarFooter 的共享菜单，Settings 场景不能丢失桌面平台能力。
                  // 之前这里没透传 isDesktop，导致同一个头像菜单在设置页缺少界面缩放入口。
                  isDesktop={isDesktop}
                />
              </div>
            </div>
          </aside>

          <section
            // data-* 仅供布局测试与样式覆盖定位（面板 inset 三层结构），
            // 不参与业务逻辑；改名会破坏设置页的截图基线。
            data-settings-content-frame="true"
            className={cn(
              "flex min-h-0 flex-col",
              // 桌面平台统一复用主工作区的面板 inset；左侧仍与导航相接，顶部由独立拖拽留白承接。
              // Web 端 p-0：没有窗口 chrome，额外内边距只会让内容离屏幕边缘过远。
              isDesktop ? (isWindowsDesktop ? "pr-1.5 pb-1.5" : "pr-1 pb-1") : "p-0",
            )}
          >
            <div
              // 这层留白既承接窗口拖拽，又给下方圆角面板让出边距；它的高度必须由
              // 平台固定（见 className），不能按内容自适应，否则面板会随窗口宽度抖动。
              data-settings-top-inset={isDesktop ? "true" : undefined}
              // 下方面板使用 h-full；顶部留白不能参与 flex 收缩，否则 6px 会变成小数像素。
              // mac 窄屏用 h-16：这里还要给红绿灯与拖拽区让位，右侧帮助按钮才不会压住。
              className={cn(
                "shrink-0 [app-region:drag]",
                isDesktop && (isWindowsDesktop ? "h-1.5" : "h-1"),
                isMacDesktop && "max-lg:h-16",
              )}
            />
            <div
              data-settings-panel-frame="true"
              className={cn(
                "relative flex flex-col min-h-0 h-full border border-border bg-background",
                // 直接写像素圆角会绕过设计 token；设置页与工作区统一复用 rounded-md（默认 6px）。
                // Windows 原生窗控与直角边框更贴合，非 Windows 用 rounded-xl 与主面板一致。
                isWindowsDesktop ? "rounded-md" : "rounded-xl",
              )}
            >
              {!usesInlineWindowControls ? (
                <div
                  className={cn(
                    // Settings 使用和 new task 一致的问号定位：在内容面板内定位，外层让出自绘窗口按钮区，内层保持 top-2.5/right-2.5。
                    // 只有“未内联窗口按钮”时才单独画帮助按钮：内联组里已经包含帮助入口，
                    // 再画一个会出现两个问号且点击热区重叠。
                    "absolute top-0 z-50 h-10 w-10 pointer-events-auto [app-region:no-drag]",
                    "right-0",
                  )}
                >
                  <div className="absolute right-2.5 top-2.5 pointer-events-auto [app-region:no-drag]">
                    <WorkspaceHelpMenuButton
                      className="relative z-50 [app-region:no-drag]"
                      isDesktop={Boolean(isDesktop)}
                    />
                  </div>
                </div>
              ) : null}
              <SettingsBreadcrumbProvider
                // 子分区通过 context 上报面包屑，父层只保留“当前可见的那一份”；
                // 切换分区时不主动清空也能靠 label 校验过滤掉旧路径（INV-04）。
                onItemsChange={setSettingsBreadcrumbItems}
                sectionLabel={settingsBreadcrumbSectionLabel}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0">
                    <div
                      // Settings 窄布局会像左侧导航一样在 max-lg 收成 icon rail。
                      // 此时外层已经提供 max-lg:h-16 的顶部拖拽/避让区，内层 h-10 再保留会把内容额外压低。
                      // Electron 的 drag 区不能和右上角帮助/窗口按钮命中区域重叠；
                      // 这里把右侧按钮区域从拖拽条里让出来，避免真实鼠标点击被标题栏拖拽吞掉。
                      // Windows/Linux 设置页共同避开右上角菜单与内联窗控组。
                      // 固定 h-12 而不是自适应：面包屑行高一旦随文字变化，主内容整体会上下跳一两个像素。

                      className={cn(
                        "min-w-0 flex-1 [app-region:drag]",
                        // 四个 28px 按钮、组内 2px 间距和左右 8px padding，共 134px。
                        usesInlineWindowControls ? "mr-[134px]" : "mr-12",
                      )}
                    >
                      <SettingsHeaderBreadcrumb
                        // 面包屑自身是一个 nav 语义区域，必须单独给 ariaLabel：
                        // 与侧栏导航重名时读屏无法区分“当前位置”和“可跳转分区”。
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                        items={visibleSettingsBreadcrumbItems}
                      />
                    </div>
                  </div>
                  <SettingsMachinesProvider servers={sourceManagementSnapshot?.servers ?? []}>
                    <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                      <div
                        className={cn(
                          SETTINGS_FRAME_CONTENT_CLASSNAME,
                          // 内容宽度与左右内边距由共享常量提供，和工作区主面板保持一致；
                          // 这里只追加分区之间的纵向节奏，改宽度必须改常量而不是覆盖 class。
                          "flex flex-col gap-8",
                          isMacDesktop && "pt-0",
                          // isWindowsDesktop && "pt-12",
                        )}
                      >
                        {/* 归档设置迁入后也需要公共页头，不能再因列表自带标题而隐藏页面标题。 */}
                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-3">
                              {showActiveSectionTitle ? (
                                // 标题只在“没有子页面面包屑”或“从插件市场进入”时显示：
                                // 有面包屑说明用户已下钻，页头应当让位给路径而不是重复分区名。
                                <h2 className="text-ui-settings-title font-semibold tracking-tight text-foreground lg:text-ui-settings-title-lg">
                                  {activeSectionLabel}
                                </h2>
                              ) : null}
                              {!hasVisibleSettingsBreadcrumb && activeSectionMeta.titleBadgeId ? (
                                // badge 描述的是“分区本身”（如 Beta / 企业版），因此只在
                                // 页头显示分区名时出现；配合子页面路径会出现语义冲突。
                                <span className="inline-flex h-6 items-center rounded-md border border-border px-2 text-ui-xs font-semibold tracking-normal text-foreground">
                                  {intl.formatMessage({
                                    id: activeSectionMeta.titleBadgeId,
                                  })}
                                </span>
                              ) : null}
                              {activeSection === "usage" ? (
                                <SettingsUsageProviderTabs
                                  // 页签级选中值仍由本页持有（而非 URL）：设置页没有独立
                                  // 路由，写 URL 会让“返回”行为与工作区导航冲突。
                                  activeTab={usageActiveTab}
                                  codingPlanSources={usageCodingPlanSources}
                                  onTabChange={handleUsageTabSelect}
                                />
                              ) : null}
                            </div>
                          </div>
                          {activeSection === "general" ? (
                            // General 的页头带“当前语言”等只读上下文，因此独立于通用 h2；
                            // 其它分区没有这类信息，复用 h2 即可，不必为对称而强加一个组件。
                            <GeneralSectionHeader localePreference={localePreference} />
                          ) : null}
                        </div>
                        <div className="space-y-8">
                          {activeSection === "general" ? (
                            <GeneralSectionContent
                              localePreference={localePreference}
                              // interfaceMode 与 theme 都直接来自 store：General 区只负责展示
                              // 与触发 setter，不持有副本，避免与外观分区出现两套选中态。
                              interfaceMode={interfaceMode}
                              setInterfaceMode={setInterfaceMode}
                              // 平台能力原样下传（不在这里折算成布尔）：General 区需要
                              // 区分“开关不存在”和“开关存在但不可用”，例如 Linux 托盘探测中。
                              isDesktop={isDesktop}
                              isWindowsDesktop={isWindowsDesktop}
                              isLinuxDesktop={isLinuxDesktop}
                              linuxCloseToTray={linuxCloseToTray}
                              platform={platform}
                              // 通知开关是 store 直连值（INV-13）；这里不包一层本地 state，
                              // 否则持久化失败时开关会停留在错误的“已开启”外观上。
                              notificationEnabled={notificationEnabled}
                              notificationSoundEnabled={notificationSoundEnabled}
                              // 托盘与硬件加速同属“本机进程行为”：Web 端传值也无副作用，
                              // 因为 General 区会按 isDesktop 决定是否渲染这些开关。
                              closeToTrayOnWindows={closeToTrayOnWindows}
                              keepAwakeWhileRunning={sharedSettings?.keepAwakeWhileRunning ?? false}
                              desktopChromiumHardwareAccelerationEnabled={
                                desktopChromiumHardwareAccelerationEnabled
                              }
                              receivePreviewUpdates={receivePreviewUpdates}
                              autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
                              // dataBaseDir 是“上次保存的选择”而非运行时路径：服务端要重启才
                              // 真正切换目录，因此这里回显草稿值，不读当前进程的实际工作目录。
                              dataBaseDir={dataBaseDir}
                              terminalInheritSystemProfile={terminalInheritSystemProfile}
                              terminalFontFamily={terminalFontFamily}
                              integratedTerminalShell={integratedTerminalShell}
                              integratedTerminalShellOptions={integratedTerminalShellOptions}
                              // toolSearchMode 属于 sharedSettings（跨窗口同步），因此值来自
                              // 共享设置派生而不是本地 state，另一个窗口改完后这里会立刻刷新。
                              toolSearchMode={toolSearchMode}
                              onToolSearchModeChange={handleToolSearchModeChange}
                              nativeSearchEnhancementsEnabled={nativeSearchEnhancementsEnabled}
                              // 代理三件套是本机进程级配置：即使当前激活远端 workspace，
                              // 这里编辑的仍是本机值，不能替换成 workspace services。
                              httpProxy={httpProxy}
                              httpProxyNoProxy={httpProxyNoProxy}
                              httpProxyCaCertPath={httpProxyCaCertPath}
                              // defaultHomeDir 只作为“默认目录”的占位提示，真正生效的是
                              // dataBaseDir；为空时不能拼成 "/" 之类的伪路径传给选择器。
                              defaultHomeDir={defaultHomeDir}
                              // shell 下拉的可见性由探测到的平台决定，而不是编译期常量：
                              // 同一份 Web 构建也可能跑在 Windows，误判会让下拉永远不出现。
                              showIntegratedTerminalShell={hostPlatform === "win32"}
                              setLocalePreference={handleFooterLocaleChange}
                              // 通知开关直接调用 store setter，不走 await 型 handle：
                              // store 内部负责持久化与跨窗口同步，这里再包一层只会多一份状态。
                              setNotificationEnabled={(enabled) =>
                                runUserAction({
                                  input: {
                                    featureId: "settings.notification",
                                    action: "toggle_notification",
                                    trigger: "switch",
                                  },
                                  operation: () => setNotificationEnabled(enabled),
                                  completed: {
                                    resultSource: "local_commit",
                                    stateAfter: enabled ? "enabled" : "disabled",
                                  },
                                  failureStage: "local_commit",
                                })
                              }
                              setNotificationSoundEnabled={(enabled) =>
                                runUserAction({
                                  input: {
                                    featureId: "settings.notification",
                                    action: "toggle_notification_sound",
                                    trigger: "switch",
                                  },
                                  operation: () => setNotificationSoundEnabled(enabled),
                                  completed: {
                                    resultSource: "local_commit",
                                    stateAfter: enabled ? "enabled" : "disabled",
                                  },
                                  failureStage: "local_commit",
                                })
                              }
                              // 展示类与工具分组类开关共用 sharedSettings 真源，props 与
                              // 上面的 handler 必须成对出现：只传值不传 onChange 会让开关变只读，
                              // 只传 onChange 不传值则每次渲染都回到默认态。
                              messageStreamShowReasoning={messageStreamShowReasoning}
                              messageStreamShowTodos={messageStreamShowTodos}
                              toolGroupingExploreEnabled={toolGroupingExploreEnabled}
                              toolGroupingTerminalEnabled={toolGroupingTerminalEnabled}
                              toolGroupingChangesEnabled={toolGroupingChangesEnabled}
                              zcodeInteractionBehavior={zcodeInteractionBehavior}
                              // 两个“数据保留/自动决策”开关只在 Desktop 生效：
                              // General 区会按 isDesktop 决定是否渲染，这里仍原样传值，
                              // 避免把“能力判断”复制两份（INV-10 的同类约束）。
                              askUserQuestionAutoResolutionEnabled={
                                askUserQuestionAutoResolutionEnabled
                              }
                              modelIoFullRetentionEnabled={modelIoFullRetentionEnabled}
                              // 目录选择按钮与 General 区共用同一个 selectDirectory：
                              // 远程模式下它内部会返回 undefined（能力不可用），
                              // 由 General 区隐藏入口而不是在这里抛错（INV-17）。
                              onDataBaseDirChange={handleDataBaseDirChange}
                              onSelectDataBaseDir={selectDirectory}
                              // 关闭“继承系统 Profile”不会清空已填写的字体族：用户重新开启时
                              // 还能回到上次的选择，而不是面对一个空输入框重新配置。
                              onTerminalInheritSystemProfileChange={
                                handleTerminalInheritSystemProfileChange
                              }
                              onTerminalFontFamilyChange={handleTerminalFontFamilyChange}
                              onIntegratedTerminalShellChange={handleIntegratedTerminalShellChange}
                              onNativeSearchEnhancementsEnabledChange={
                                handleNativeSearchEnhancementsEnabledChange
                              }
                              onModelIoFullRetentionEnabledChange={
                                handleModelIoFullRetentionEnabledChange
                              }
                              // 三个代理回调都由“保存”按钮触发（trigger: button），不能做成
                              // 输入即写：半截地址会被下次启动读取，直接把本机网络打断。
                              onHttpProxyChange={handleHttpProxyChange}
                              onHttpProxyNoProxyChange={handleHttpProxyNoProxyChange}
                              onHttpProxyCaCertPathChange={handleHttpProxyCaCertPathChange}
                              onCloseToTrayOnWindowsChange={handleCloseToTrayOnWindowsChange}
                              onKeepAwakeWhileRunningChange={handleKeepAwakeWhileRunningChange}
                              onDesktopChromiumHardwareAccelerationChange={
                                handleDesktopChromiumHardwareAccelerationChange
                              }
                              // 更新相关开关只写偏好，不在这里触发一次检查/下载：
                              // 真正的调度由 updateService 负责，本开关只写偏好。
                              onReceivePreviewUpdatesChange={handleReceivePreviewUpdatesChange}
                              onAutoDownloadAndInstallUpdatesChange={
                                handleAutoDownloadAndInstallUpdatesChange
                              }
                              onMessageStreamShowReasoningChange={
                                handleMessageStreamShowReasoningChange
                              }
                              onMessageStreamShowTodosChange={handleMessageStreamShowTodosChange}
                              onToolGroupingExploreEnabledChange={
                                handleToolGroupingExploreEnabledChange
                              }
                              onToolGroupingTerminalEnabledChange={
                                handleToolGroupingTerminalEnabledChange
                              }
                              onToolGroupingChangesEnabledChange={
                                handleToolGroupingChangesEnabledChange
                              }
                              onZCodeInteractionBehaviorChange={
                                handleZCodeInteractionBehaviorChange
                              }
                              onAskUserQuestionAutoResolutionEnabledChange={
                                handleAskUserQuestionAutoResolutionEnabledChange
                              }
                              // onboarding 弹窗与侧栏底部按钮共用同一个 requestOnboardingDialog：
                              // 两处独立实现会让“已看过”状态与埋点各算各的。
                              onOpenOnboardingDialog={() =>
                                runUserAction({
                                  input: {
                                    featureId: "settings.navigation",
                                    action: "open_onboarding",
                                    trigger: "button",
                                  },
                                  operation: requestOnboardingDialog,
                                  completed: { resultSource: "local_commit" },
                                  failureStage: "dialog_open",
                                })
                              }
                            />
                          ) : activeSection === "remoteDevices" ? (
                            // 远程设备页需要三件套同时就绪：共享设置（含功能开关）、
                            // 桌面宿主、以及设备管理快照。任一缺失都直接落到后续分支，
                            // 而不是渲染一个半残的设备列表（例如 Web 端没有 sourceManagement）。
                            sharedSettings && isDesktop && sourceManagement ? (
                              <SourceServerManagementPanel
                                // 版本号变化时强制重挂：深链目标与内部选中态都在子组件里，
                                // 不换 key 会沿用上一次进入时的选中行（INV-18）。
                                key={`remote:${settingsSectionNavigationVersion}`}
                                targetSourceServerId={targetSourceServerId}
                                targetSourceServerDetails={targetSourceServerDetails}
                                // 深链目标被定位后立刻清空：否则用户手动切走再回来，
                                // 面板会再次自动跳到同一个服务器详情（无法留在列表）。
                                onTargetSourceServerFocused={() => {
                                  setTargetSourceServerId(undefined);
                                  setTargetSourceServerDetails(false);
                                }}
                                // 直接传 service 而不是快照列表：面板内部自己订阅变化，
                                // 设置页每次 snapshot 更新都重挂列表会丢掉用户的展开状态。
                                management={sourceManagement}
                                // 优先用 remoteWorkspaceController 派发（能复用已建立的连接），
                                // 只有控制器未注入时才回退到 onOpenRemoteWorkspace（走连接向导）。
                                // 两套都不可用时传 undefined，让面板隐藏入口而不是渲染死按钮。
                                onCreateConnection={
                                  onOpenRemoteWorkspace
                                    ? () =>
                                        onOpenRemoteWorkspace({ completion: "device-management" })
                                    : undefined
                                }
                                onConnectProfile={
                                  remoteWorkspaceController
                                    ? (profileId) =>
                                        remoteWorkspaceController.dispatch({
                                          type: "connect-device",
                                          profileId,
                                          effect: "device-management",
                                        })
                                    : onOpenRemoteWorkspace
                                      ? (profileId) =>
                                          onOpenRemoteWorkspace({
                                            preferredProfileId: profileId,
                                            completion: "device-management",
                                          })
                                      : undefined
                                }
                                onDisconnectSource={
                                  remoteWorkspaceController
                                    ? (sourceServerId) =>
                                        remoteWorkspaceController.dispatch({
                                          type: "disconnect-device",
                                          sourceServerId,
                                        })
                                    : undefined
                                }
                                // 打开项目走 Root 注入的 onOpenRemoteWorkspace：连接建立与
                                // tab 激活都由它负责，设置页只做一次导航，不自己拼连接流程。
                                onOpenProject={
                                  onOpenRemoteWorkspace
                                    ? async (sourceServerId, path, profileId) => {
                                        // 仅传目录会被 Root 当成新建；复用侧栏唯一目录 owner，同步固定原入口。
                                        const preference =
                                          projectDirectory &&
                                          resolveRecentRemoteProjectPreference(
                                            projectDirectory.directory,
                                            {
                                              sourceServerId,
                                              path,
                                              profileId,
                                            },
                                          );
                                        if (!preference) {
                                          throw Object.assign(
                                            new Error("remote-project.entry-not-found"),
                                            {
                                              code: "recent-project-unresolved",
                                            },
                                          );
                                        }
                                        onBack?.();
                                        onOpenRemoteWorkspace(preference);
                                      }
                                    : undefined
                                }
                                // 更新详情本质是“深链到设备详情页”：必须写 pending intent 再
                                // openSettingsTab，因为此刻设置页可能尚未挂载（见下方注释）。
                                onShowUpdateDetails={(sourceServerId) => {
                                  // 先写 pending intent 再 openSettingsTab：如果设置页已经挂载，
                                  // 监听器会消费它；如果尚未挂载，新实例的懒初始化会消费它。
                                  // 反序（先打开再写）在“首次打开”时目标会被初始化读到空值。
                                  setPendingSettingsSectionIntent("remoteDevices", {
                                    sourceServerId,
                                    sourceServerDetails: true,
                                  });
                                  openSettingsTab();
                                }}
                                // 跳转需要在完整 workspace 列表里反查目标（含远端），
                                // 因此传全量 tab 而不是只传当前激活的那一个。
                                workspaceTabs={workspaceTabs}
                                // 侧栏定位只能按 identity 匹配：远端与本地可能存在同名路径，
                                // 用 path 查找会在同名项目时滚动到错误的那一行。
                                onShowInSidebar={(sourceServerId) => {
                                  // 先按 sourceServerId 反查目标 workspace tab，再返回工作区：
                                  // 找不到时也必须 onBack（否则用户困在设置页），只是不激活任何 tab。
                                  const target = workspaceTabs.find(
                                    (tab) =>
                                      getWorkspaceSourceServerId(tab, {
                                        workspaceHistory:
                                          sourceManagementSnapshot?.workspaceHistory,
                                      }) === sourceServerId,
                                  );
                                  onBack?.();
                                  if (target) {
                                    activateTab(target.id);
                                    // 必须等一帧：切 tab 后侧栏列表才把对应行渲染出来，
                                    // 同步 querySelector 拿不到节点；滚动与聚焦分成两步，
                                    // preventScroll 防止 focus 再次把列表滚回顶部。
                                    requestAnimationFrame(() => {
                                      const row = Array.from(
                                        document.querySelectorAll<HTMLElement>(
                                          "[data-remote-project-identity]",
                                        ),
                                      ).find(
                                        (element) =>
                                          element.dataset.remoteProjectIdentity ===
                                          target.workspaceIdentity,
                                      );
                                      row?.scrollIntoView({ block: "center" });
                                      row
                                        ?.querySelector<HTMLElement>('[role="button"]')
                                        ?.focus({ preventScroll: true });
                                    });
                                  }
                                }}
                                // 设备的显示/同步偏好存放在 sharedSettings：面板自己调
                                // onUpdateSettings 写回，设置页不复制一份受控 state。
                                settings={sharedSettings}
                                onUpdateSettings={updateSharedSettings}
                              />
                            ) : (
                              // sharedSettings 为空代表“还在读配置”，此时显示 loading；
                              // 已有配置却没有 sourceManagement 才是真的空态。
                              // 用同一个条件区分两态，避免用户看到一句空白无从判断。
                              <p className="text-ui-sm text-remote-foreground-muted">
                                {intl.formatMessage({
                                  id: sharedSettings ? "settings.source.empty" : "common.loading",
                                })}
                              </p>
                            )
                          ) : activeSection === "appearance" ? (
                            // 外观区几乎全是“即时写 store”的控件（主题、字号），没有保存按钮：
                            // 这与 general 区“逐项 await 写盘”的模式不同，因此控件直接收 store setter。
                            // 唯一例外是 codePreviewSettings：它是一次性 patch 写回，走带埋点的 handler。
                            <AppearanceSectionContent
                              // 代码预览设置是外观区唯一的 patch 写回项：其余控件直接收
                              // store setter，只有它需要一次合并多个键并补埋点。
                              codePreviewSettings={codePreviewSettings}
                              setCodePreviewSettings={handleCodePreviewSettingsChange}
                              theme={theme}
                              // 复用 footer 的 handleFooterThemeChange：主题切换要同时更新
                              // 侧栏底部选择器与 store，两处各写一份会出现“选完闪回旧主题”。
                              setTheme={(nextTheme) => handleFooterThemeChange(nextTheme)}
                              // 字号是 store 真源：拖动过程中 store 已在 clamp，因此这里传当前值
                              // 而不是本地草稿，避免松手瞬间出现“草稿值 → 真源值”的二次回弹。
                              uiFontSizePx={uiFontSizePx}
                              // 字号来自滑杆/方向键，因此 trigger 记为 keyboard；
                              // 真正的 clamp 在 store 内部完成（INV-12），这里不重复实现。
                              setUiFontSizePx={(fontSizePx) =>
                                runUserAction({
                                  input: {
                                    featureId: "settings.appearance",
                                    action: "change_ui_font_size",
                                    trigger: "keyboard",
                                  },
                                  operation: () => setUiFontSizePx(fontSizePx),
                                  completed: {
                                    resultSource: "local_commit",
                                    valueAfter: String(fontSizePx),
                                  },
                                  failureStage: "local_commit",
                                })
                              }
                            />
                          ) : activeSection === "shortcuts" ? (
                            // 快捷键注册依赖 Electron 的全局菜单/accelerator，Web 端只有
                            // 编辑器内快捷键；因此把 isDesktop 传下去让它隐藏无效项，
                            // 而不是在设置页这一层过滤（会与 ShortcutSettingsSection 的 registry 脱节）。
                            <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
                          ) : activeSection === "modelProvider" ? (
                            // ServiceProvider 明确包本地 Host：模型配置是本机全局事实源，
                            // 即使当前激活的是远端 workspace，也不能把远端 services 注入进来。
                            // 否则“远端无模型”会导致本机模型列表变空，看起来像配置丢失。
                            <ServiceProvider services={localHostServices}>
                              {/* 模型配置属于本机全局事实源；激活远端 workspace 时也不能注入远端 Host。 */}
                              <ModelProviderSection
                                workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
                                // 连通性探测用“本机可达路径”，展示用“当前 workspace 路径”：
                                // 远端项目下这两者不同，混用会让测试总是连到错误目录。
                                connectivityWorkspacePath={
                                  localModelProviderConnectivityWorkspacePath
                                }
                                connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}
                                // 首次深链与页面存续期间的再次导航共用同一个 prop：初始值来自
                                // 挂载时消费的一次性目标，之后由 pending section 监听覆盖。
                                pendingModelProviderTarget={pendingModelProviderTarget}
                                // 目标被消费后立刻置空：ModelProviderSection 内部只处理一次，
                                // 不清空会在每次重渲染时再次打开同一个 provider 详情。
                                onConsumePendingModelProviderTarget={() =>
                                  setPendingModelProviderTarget(undefined)
                                }
                              />
                            </ServiceProvider>
                          ) : activeSection === "memory" ? (
                            // 与模型配置同理：记忆 catalog 存放在本机，远端 workspace 只是
                            // 记忆条目的作用域标签，不能替换 Host，否则会读到远端空库。
                            <ServiceProvider services={localHostServices}>
                              {/* Memory catalog 始终使用本地 Host，避免远程 workspace 误读本机数据。 */}
                              <MemorySettingsSection
                                memoryEnabled={memoryEnabled}
                                // 记忆库固定使用本机 service：远端 workspace 只是条目的作用域标签，
                                // 换成远端 Host 会读到一份空库，看起来像“记忆全丢了”。
                                memoryService={localHostServices.memoryService}
                                onMemoryEnabledChange={handleMemoryEnabledChange}
                                // 项目记忆查看器依赖本机文件系统浏览；Web/远控下不提供，
                                // 传 false 让组件隐藏入口而不是在点击时报“无法打开”。
                                projectMemoryViewerAvailable={Boolean(isDesktop)}
                                workspaceDisplayNames={memoryWorkspaceDisplayNames}
                              />
                            </ServiceProvider>
                          ) : activeSection === "plugin" ? (
                            // 插件是唯一会同时接收 workspace 坐标与平台能力的 section：
                            // scope 决定读 user 还是 workspace 安装列表，平台决定哪些安装入口可用。
                            <PluginsSection
                              key={`plugin:${settingsSectionNavigationVersion}`}
                              // 插件分区同时需要平台能力与“是否 Web 远控”，因为安装入口
                              // 在本机与远控下走不同的 RPC；少传一个会让入口点了没反应。
                              isDesktop={Boolean(isDesktop)}
                              isMacDesktop={Boolean(isMacDesktop)}
                              isWindowsDesktop={Boolean(isWindowsDesktop)}
                              isWebRemoteControl={isWebRemoteControl}
                              // initialTab 只在挂载时读取一次：之后页签由组件内部管理，
                              // 本页重渲染（例如切换主题）不会把用户打回初始页签。
                              initialTab={pluginTab}
                              // scopeKey 与 workspaceIdentity 必须成对：user scope 不携带
                              // workspace，workspace scope 必须带 identity；错配会让插件列表
                              // 读到一个空 scope（看起来“插件全丢了”）。
                              initialScopeKey={pluginScopeKey}
                              // workspacePath 与 identity 必须同时传：path 决定安装目录，
                              // identity 决定远端同名项目的归属，只传其一会在远端写错位置。
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              // 只有从插件市场进入才显示“插件市场”面包屑，普通入口显示“插件”，
                              // 否则用户会误以为自己一直在市场里。
                              showMarketplaceBreadcrumb={pluginNavigationOrigin === "plugin-store"}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "mcp" ? (
                            <PluginsSection
                              key={`mcp:${settingsSectionNavigationVersion}`}
                              // 同一组件承载 plugin / mcp / skill 三种模式：mode 决定数据源与
                              // 详情面板形态，key 前缀保证在三个分区之间切换时彻底重挂，
                              // 不把上一个模式的搜索词与选中项带过来。
                              mode="mcp"
                              // mcp 分支不传 isDesktop/isMac：MCP 配置在桌面与 Web 走同一套
                              // 远端 Host 逻辑，多传平台布尔反而会让组件误判可用能力。
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "skill" ? (
                            // skill 与 mcp 共用同一份实现，但数据源、安装目标与详情面板不同；
                            // 这里没有额外 props 是正常的：差异全部由 mode="skill" 与 key 前缀表达。
                            <PluginsSection
                              key={`skill:${settingsSectionNavigationVersion}`}
                              mode="skill"
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "migration" ? (
                            <MigrationSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              // 迁移需要读写本机文件系统与旧版本数据目录，Web 端无法完成；
                              // 传原始 isDesktop 让组件决定隐藏还是禁用，而不是这里替它决定。
                              isDesktop={isDesktop}
                            />
                          ) : activeSection === "archives" ? (
                            // 顺序有意为之：自动归档策略在上（配置），手动归档管理在下（操作）；
                            // 反过来会让用户先看到一长串历史任务，找不到策略开关。
                            <div className="min-w-0 space-y-6">
                              <TaskAutoArchiveSettings
                                taskAutoArchiveEnabled={taskAutoArchiveEnabled}
                                taskAutoArchiveOlderThanDays={taskAutoArchiveOlderThanDays}
                                onTaskAutoArchiveEnabledChange={handleTaskAutoArchiveEnabledChange}
                                onTaskAutoArchiveOlderThanDaysChange={
                                  handleTaskAutoArchiveOlderThanDaysChange
                                }
                              />
                              <ArchiveManagement />
                            </div>
                          ) : activeSection === "usage" ? (
                            <UsageStatsSection
                              // 页签值由本页持有并原样下传：用量区只负责渲染对应数据，
                              // 不自己维护第二份选中态，否则两处切换会短暂不一致。
                              activeTab={usageActiveTab}
                              // 加载中也不禁用页签，只是数据为空：否则用户点页签时
                              // 焦点会从按钮上消失（disabled 元素不可聚焦）。
                              providerSourcesLoading={usageProviderSettingsLoading}
                              selectedCodingPlanSource={selectedUsageCodingPlanSource}
                              // 应用用量按 workspace 拆分统计，identity/path 缺一不可：
                              // 只给 path 会把远端与本地同名项目合并成一行。
                              workspaceIdentity={activeWorkspaceIdentity}
                              workspacePath={activeWorkspacePath ?? undefined}
                            />
                          ) : activeSection === "subagents" ? (
                            <SubagentsSection
                              // 子代理模型配置不是一个弹窗，而是跳到 modelProvider 分区：
                              // 弹窗会复制一份模型选择 UI，两处规则的漂移无法避免（INV-19）。
                              // 子代理的“管理模型”只做分区内跳转，不关闭设置页：用户配置完
                              // 后按返回回到 subagents，而不是被丢回工作区（INV-19）。
                              onManageModels={handleOpenModelProviderSettings}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "automations" ? (
                            // automations 的编辑界面在设置页内嵌，但“运行”发生在工作区：
                            // 因此只传坐标，不在这里触发运行（运行入口统一在 WorkspaceShell）。
                            <AutomationsSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "commands" ? (
                            // [权衡] commands 分支没有 key 前缀：它依赖 mode 变化让 PluginsSection
                            // 内部重置数据源。若将来把 mode 只当“初始值”，这里必须补一个
                            // key={`command:${version}`}，否则从 mcp 切过来会残留旧列表。
                            <PluginsSection
                              mode="command"
                              isWebRemoteControl={isWebRemoteControl}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              onCreateTask={onCreateTask}
                              onOpenPluginStore={(_returnScopeKey, intent) => {
                                // 添加市场与浏览插件都先离开设置层，再显示商店。
                                requestPluginStoreOpen({ returnScopeKey: "user", intent });
                                onBack?.();
                              }}
                            />
                          ) : activeSection === "hooks" ? (
                            // hooks 的配置落盘在 workspace 的 .zcode/hooks（远端则写远端）：
                            // 因此必须带 identity，纯 path 会在同名项目间写错文件。
                            <HooksSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "workspaceFileSearch" ? (
                            // 文件搜索的排除规则按 workspace 存储（.gitignore 语义之外的一层），
                            // 远端项目必须写回远端，不能落到本机同名目录。
                            <WorkspaceFileSearchSection
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                            />
                          ) : activeSection === "browser" ? (
                            // 浏览器安全选项是本机进程级配置：远端 workspace 时仍要写本机，
                            // 因为内嵌浏览器跑在本机 Electron 里，不在远端主机上。
                            <BrowserSettingsSection
                              // 浏览器安全选项由本机 Electron 提供：Web 端传 false 让组件
                              // 隐藏入口，而不是渲染一个点了没有效果的开关。
                              isDesktop={Boolean(isDesktop)}
                              isWindowsDesktop={isWindowsDesktop}
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              embeddedBrowserAllowInsecureCertificates={
                                embeddedBrowserAllowInsecureCertificates
                              }
                              onEmbeddedBrowserAllowInsecureCertificatesChange={
                                handleEmbeddedBrowserAllowInsecureCertificatesChange
                              }
                            />
                          ) : activeSection === "computerUse" ? (
                            <ComputerUseSection
                              // computer-use 依赖屏幕录制/辅助功能等本机权限：Web 端传 false，
                              // 让组件隐藏入口而不是渲染一个点了会被系统拒绝的按钮。
                              isDesktop={Boolean(isDesktop)}
                              isMacDesktop={Boolean(isMacDesktop)}
                              isWindowsDesktop={Boolean(isWindowsDesktop)}
                              // 远控坐标三件套原样来自 activeWorkspaceTab：computer-use 需要在
                              // 正确的设备上截屏/点击，缺 remoteSessionId 会退化成操作本机。
                              workspacePath={activeWorkspacePath}
                              workspaceIdentity={activeWorkspaceIdentity}
                              // 三个坐标必须一起传：缺 remoteSessionId 会退化成操作本机，
                              // 缺 remoteTarget 则无法解析目标设备，二者任一缺失都不安全。
                              remoteSessionId={activeWorkspaceTab?.remoteSessionId}
                              remoteTarget={activeWorkspaceTab?.remoteTarget}
                              localWorkspacePath={activeWorkspaceTab?.localWorkspacePath}
                            />
                          ) : null}
                        </div>
                      </div>
                    </main>
                  </SettingsMachinesProvider>
                </div>
              </SettingsBreadcrumbProvider>
            </div>
          </section>
        </div>
      </DesktopWindowFrame>
    </>
  );
}
