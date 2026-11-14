/* eslint-disable max-lines -- 技能管理面板需共享筛选、安装与开关交互状态，集中维护更便于一致性 */
// ============================================================================
// SkillsSection.tsx — 设置页「技能」资源区（列表 / 开关 / 删除 / 导入 / 详情）
//
// 职责边界：
//   - 只做 UI 编排：数据读写全部经 skillsService / skillSyncService /
//     pluginManagementService；本文件不直接碰文件系统，也不拼 RPC 报文。
//   - 服务实例必须来自 targetServiceResolution（按 workspace + remote target 解析），
//     不得从全局 ServiceProvider 直接取——那会把请求发到错误的 host。
//
// 渲染状态机（顺序不可交换）：
//   !rpcReady              → 连接中
//   loading || 投影不匹配  → 加载中
//   搜索无结果             → 搜索空态
//   其余                   → 列表（本地分组 + 插件分组）
//
// 不变量（INV）。每条注明「守住它的位置」；改错故障写的是线上真实表现。
//
// INV-01 所有异步读取都必须用 latestRequestIdRef 做代次校验。
//   守住它的位置：loadSkills 的 requestId 比较（成功与 catch 两处都要）。
//   改错故障：快速切换工作区时旧响应后到，把 A 的技能列表盖到 B 上；
//   开关一个技能后列表会短暂显示上一个 target 的 enabled 状态。
//
// INV-02 rpcReady=false 时不发任何请求，并主动清空列表与弹窗。
//   守住它的位置：loadSkills 首行、同步 effect 的 rpcReady 分支、三段式渲染首段。
//   改错故障：远程连接未就绪时发 list，得到 undefined 服务调用异常；
//   残留的 import/remote-sync 弹窗会在下一 target 上继续操作，写错工作区。
//
// INV-03 服务实例只能来自 targetServiceResolution.services。
//   守住它的位置：顶部解构 pluginManagementService / skillSyncService / skillsService。
//   改错故障：跨远程 host 误路由，技能读写落到本机，远端列表永远不更新。
//
// INV-04 activeSkillTargetKey 与 requestTargetKey 必须用同一个构造函数。
//   守住它的位置：activeSkillTargetKey 与 loadSkills 内的 requestTargetKey。
//   改错故障：两边字段顺序或来源不一致，projectionMatchesTarget 永远为 false，
//   列表进入无限 loading。
//
// INV-05 loadedSkillTargetKey 表示「当前 skills 属于哪个 target」，成功与失败都要写。
//   守住它的位置：try 的末尾与 catch 的首部。
//   改错故障：失败时不写会让 projectionMatchesTarget 保持为真，
//   上一 target 的数据被当作当前 target 展示。
//
// INV-06 首屏与切换 target 必须走 loadSkills(true)（阻塞 loading）。
//   守住它的位置：同步 effect 内的 void loadSkills(true)。
//   改错故障：改成后台刷新会让切换工作区时先看到旧列表，用户误以为切换没生效。
//
// INV-07 手动刷新与开关/删除后的重载必须走 loadSkills(false)。
//   守住它的位置：refresh、setEnabled、handleDeleteSkill 内的调用。
//   改错故障：用阻塞 loading 会在每次开关时整块闪白，丢失滚动位置。
//
// INV-08 开关状态只写 ZCODE_AGENT_PROVIDER，不写三方 provider。
//   守住它的位置：setEnabled 内的 effectiveProvider 常量。
//   改错故障：按旧 provider 前缀分桶写盘，开关看起来生效但下次加载回弹。
//
// INV-09 plugin 作用域技能不可单独开关、不可单独删除。
//   守住它的位置：行内 Switch 的 scope 判断与 handleDeleteSkill 的首行守卫。
//   改错故障：单独禁用会被下一次插件同步覆盖；单独删除会留下残缺插件。
//
// INV-10 删除必须先经过 confirmDialog，且取消时不得发请求。
//   守住它的位置：handleDeleteSkill 的 confirmed 判断。
//   改错故障：误触即删，且无法撤销（技能删除是物理删除）。
//
// INV-11 删除当前正在看详情的技能后必须关闭详情。
//   守住它的位置：selectedSkill?.id === skill.id 时 setSelectedSkill(null)。
//   改错故障：弹窗继续展示已删除的技能；再点路径会打开不存在的目录。
//
// INV-12 开关/删除/导入/远端同步后都要让草稿会话失效。
//   守住它的位置：四处 invalidateDeferredDraftSessionForSkillChange 调用。
//   改错故障：Composer 里保留着已失效的 skill mention，提交后注入不存在的技能。
//
// INV-13 插件分组的数据必须确认「插件 store 的 scope 与当前 target 一致」才可用。
//   守住它的位置：pluginStoreMatchesTarget 的三元判断。
//   改错故障：把 A 工作区的插件技能挂到 B 工作区的技能列表里，点击后 404。
//
// INV-14 技能列表必须同时经过 provider 过滤与 scope 投影。
//   守住它的位置：scopedProviderSkills 内 filterSkillsForProvider + selectSkillsForScope。
//   改错故障：混入其它 provider 的同名技能，开关写错分桶。
//
// INV-15 搜索无结果只影响列表区，不影响顶部诊断条与错误条。
//   守住它的位置：hasEmptySearchResult 只在三段式渲染的第三分支之后判断。
//   改错故障：搜索时诊断信息一起消失，用户以为警告被修复了。
//
// INV-16 搜索时隐藏「已安装」空分组，但不隐藏整个分区容器。
//   守住它的位置：hideInstalledGroup 与 section 的 hidden class。
//   改错故障：用条件卸载代替 hidden 会让每次输入都重建子树，输入框失焦。
//
// INV-17 诊断条数不等于失败技能数：必须按 severity 分 error / warning 统计。
//   守住它的位置：diagnosticErrorCount 与 diagnosticWarningCount。
//   改错故障：把 warning 计入失败，界面显示「全部技能加载失败」的假警报。
//
// INV-18 创建技能的入口必须委托 onCreateTask，不得自行写 session store。
//   守住它的位置：handleCreateSkill 末尾的 onCreateTask 调用。
//   改错故障：文本进不了新 Composer，草稿持久化与 workspaceIdentity 隔离被绕过。
//
// INV-19 详情对象每次渲染都要从最新 skills 里按 id 重新解析。
//   守住它的位置：detailSkill 的 find(...) ?? selectedSkill。
//   改错故障：详情弹窗停留在开关前的旧快照，状态字段与列表不一致。
//
// INV-20 行内激活必须同时支持 click 与 Enter/Space，且 Space 要 preventDefault。
//   守住它的位置：role=button 容器的 onClick / onKeyDown。
//   改错故障：键盘 Space 会先滚动页面再触发选中；读屏用户无法打开详情。
//
// INV-21 导入与远端同步弹窗的 open 必须与 rpcReady 做与运算。
//   守住它的位置：SkillsImportDialog.open 与 RemoteSyncDialogs.skillOpen。
//   改错故障：目标切换后弹窗仍开着，提交时用的是新 target 的服务，
//   用户以为在往旧工作区导入。
//
// INV-22 表单/详情的空值一律渲染 null，不渲染空标签占位。
//   守住它的位置：SkillDetailField 的 if (!value) return null。
//   改错故障：详情里出现一排只有标题没有值的字段，看起来像加载失败。
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Import,
  Plus,
  Trash2,
  UploadCloud,
  WandSparkles,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Switch } from "@/components/ui/switch.js";
import type {
  ZCodeProvider,
  SkillDiagnostic,
  SkillDiagnosticCode,
  SkillSummary,
  SkillsCapability,
  RemoteTarget,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { groupSkillsByPlugin } from "@/settings/pluginManagedResourceGroups.js";
import { SkillsImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import { RemoteSyncDialogs, shouldShowRemoteSyncActions } from "@/settings/RemoteSyncActions.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { buildSourceSettingsProjectionKey } from "@/settings/settingsSourceWorkspace.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  groupScopedSkillsBySource,
  selectPluginsForScope,
  selectSkillsForScope,
} from "@/settings/pluginCapabilityProjection.js";

// 取路径最后一段作为展示名。刻意同时按 Windows 与 POSIX 分隔符切分：
// 远程 target 传回的路径可能是 POSIX，本机是 Windows，只按一种切会得到整条路径。
function getWorkspaceBasename(workspacePath: string | null): string {
  // [失败路径] 空路径返回空串而不是抛错：调用方用 || 回退到通用文案。
  if (!workspacePath) return "";
  // filter(Boolean) 先吃掉尾部分隔符与连续分隔符；at(-1) 为空时回退原串，
  // 保证根路径（如 /）也有可展示文本而不是空。
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

// 发布时间的展示格式化：输出 ISO 串交给上层统一排版。
// 返回 null 表示「无此字段」，调用方据此隐藏整行详情。
function formatSkillPublishedAt(timestamp: number | undefined): string | null {
  // [失败路径] 只判 undefined 不判 null：类型契约里该字段是 number | undefined，
  // 放宽成 falsy 判断会把合法的时间戳 0 也当成缺失。
  if (timestamp === undefined) {
    return null;
  }
  const date = new Date(timestamp);
  // 非法时间戳（越界或 NaN）同样返回 null：toISOString 对 Invalid Date 会抛 RangeError，
  // 不拦会导致整个详情弹窗白屏。
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

// 详情字段的通用渲染器。空值返回 null 是契约（INV-22），
// 调用方因此可以无条件列出所有字段，由组件自己决定是否出现。
function SkillDetailField({
  label,
  value,
  mono = false,
  className = "",
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  className?: string;
}) {
  // [权衡] 用 falsy 判断而不是 === null：空串、undefined 都应视为无值；
  // 这些字段没有「合法的 0」语义（版本号/ID 均为字符串）。
  if (!value) {
    return null;
  }
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div
        className={[
          "mt-1 break-words text-ui-base text-foreground-subtle",
          mono ? "break-all font-mono" : "",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}

function SkillPathDetailField({
  label,
  path,
  openLabel,
  onOpen,
}: {
  label: string;
  path: string;
  openLabel: string;
  onOpen: () => void;
}) {
  return (
    // 路径字段固定占两列：路径通常很长，单列会被挤成多行并撑高整个网格。
    <div className="min-w-0 col-span-2">
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div className="mt-1">
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-label={openLabel}
          title={openLabel}
          className="inline-flex h-auto max-w-full items-baseline gap-1.5 whitespace-normal break-all px-0 py-0 text-left align-baseline font-mono text-ui-base font-normal text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline"
          onClick={onOpen}
        >
          <span>{path}</span>
          <ExternalLink className="relative top-px size-3 shrink-0" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

interface SkillsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  isWebRemoteControl?: boolean;
  scopeFilter: "user" | "workspace";
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore?: () => void;
  showMarketplaceBreadcrumb?: boolean;
  reportDetailBreadcrumb?: boolean;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

// 技能区入口。props 分三类：target 身份（workspace / remote）、外部筛选（scope / query）、
// 以及向上汇报的回调；本组件不持有 workspace 状态，全部由上层传入。
export function SkillsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  isWebRemoteControl = false,
  scopeFilter,
  searchQuery,
  onVisibleCountChange,
  onCreateTask,
  onDetailOpenChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  reportDetailBreadcrumb = false,
  unscopedServices,
  cacheAuthorityKey,
}: SkillsSectionProps) {
  // locale 单独取出：插件展示名需要按语言选择 listing 的本地化字段，
  // 而 intl 只负责文案 key。
  const { intl, locale } = useZCodeIntl();
  // [资源] 平台能力只用于「在文件管理器中打开」；Web 环境下该调用会返回 success=false，
  // 由 openSkillFilePath 转成 toast，不做能力探测。
  const platform = usePlatform();
  // 本机基础服务只取 skillSyncService 一项，用于判断「本地是否有可同步的源」。
  // 远端读写一律走下面的 targetServiceResolution，二者不可混用。
  const baseServices = useBaseWorkspaceServices();
  // [并发] 四个 selector 分开取而不是取整个 store：
  // 整对象订阅会在任意插件字段变化时重渲染整个技能列表。
  const plugins = usePluginManagementStore((state) => state.plugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  // 把 availablePlugins 拍平成 id → listing 的 Map，供分组标题与行内图标复用；
  // 不建索引就要在每个分组、每一行里线性查找，长列表下是 O(n²)。
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  // 插件 store 自己的工作区身份，用于和当前 target 比对（INV-13）；
  // 它与 activeWorkspacePath 同名但语义不同：前者是「插件数据属于谁」。
  const pluginWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  // initialize 从 store 取出后作为稳定依赖使用；它在 store 内做了幂等与代次控制，
  // 因此本文件可以放心在 target 变化时重复调用。
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  // useConfirmDialog 是纯 Zustand selector（不含 useState），放在这里不会影响 SkillsSection
  // 既有的「按 useState 调用次序」单测桩（见下方 selectedSkill 附近的注释）。
  // [权衡] 复用根部的确认弹窗 store（纯 selector，不含 useState），
  // 避免在本组件内新增 useState 打乱既有单测的 hook 调用次序。
  const confirmDialog = useConfirmDialog();
  // 统一把 undefined 归一化为 null：下游的 key 构造与 effect 依赖都以 null 为「无工作区」。
  const activeWorkspacePath = workspacePath ?? null;
  const activeWorkspaceIdentity = workspaceIdentity;
  // [事务] 这是本文件唯一的服务来源（INV-03）。forceUnscoped 由 cacheAuthorityKey 触发：
  // 带权威 key 时表示调用方已确定 target，禁止再按默认 scope 回退。
  const targetServiceResolution = useWorkspaceServicesResolution(
    activeWorkspacePath,
    remoteSessionId,
    activeWorkspaceIdentity,
    remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey) },
  );
  // PluginsSection 已把 Scope target 传入，但 Skills 仍从当前 ServiceProvider
  // 取服务，导致跨远程 host 误路由。技能读写和远端同步都改用同一 target 解析结果。
  // 只解构三个用得到的服务；targetServiceResolution.services 里还有 settingsSyncService，
  // 它在渲染期直接从对象取，避免无关服务变化引起重渲染。
  const { pluginManagementService, skillSyncService, skillsService } =
    targetServiceResolution.services;
  // skills 是远端投影的本地镜像，不是真源：任何写操作后都必须重新 load，
  // 不做乐观更新——技能文件可能被外部编辑，乐观状态会与磁盘不一致。
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [capability, setCapability] = useState<SkillsCapability | null>(null);
  // 记录「当前 skills 属于哪个 target」，是 projectionMatchesTarget 的另一半（INV-05）。
  const [loadedSkillTargetKey, setLoadedSkillTargetKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 搜索词由上层持有（便于全局搜索联动），本组件不维护输入状态，也不做防抖。
  const query = searchQuery;
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  useEffect(() => {
    // 详情开关向上汇报，供设置页隐藏侧栏或锁定滚动；回调可选，独立使用时静默跳过。
    onDetailOpenChange?.(selectedSkill !== null);
  }, [onDetailOpenChange, selectedSkill]);
  const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  // [并发] 代次计数器只增不减，用 ref 而非 state：它不参与渲染，
  // 放进 state 会在每次请求时多一轮无意义的重渲染。
  const latestRequestIdRef = useRef(0);
  // 与 loadSkills 内的 requestTargetKey 必须同源（INV-04）；
  // 两者分别代表「期望的 target」与「请求发出时的 target」。
  const activeSkillTargetKey = buildSourceSettingsProjectionKey(
    activeWorkspacePath,
    activeWorkspaceIdentity,
    cacheAuthorityKey,
  );
  // [失败路径] 无工作区时视为匹配：没有 target 就没有可加载的数据，
  // 若判为不匹配会进入永久 loading，遮住「无工作区」的空态。
  const projectionMatchesTarget =
    !activeWorkspacePath || loadedSkillTargetKey === activeSkillTargetKey;

  useEffect(() => {
    // 插件初始化同样受 target 与就绪状态双重约束；缺一不可，否则会往未连接的服务发请求。
    if (!activeWorkspacePath || !targetServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
      pluginService: pluginManagementService,
    });
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    cacheAuthorityKey,
    initializePlugins,
    pluginManagementService,
    scopeFilter,
    targetServiceResolution.rpcReady,
  ]);

  // 工作区展示名只算一次，供 scope 标签与来源分组标题共用，避免两处格式不一致。
  const workspaceLabel = getWorkspaceBasename(activeWorkspacePath);
  // [事务] 三个条件同时成立才算「有可同步的远端」：就绪、策略允许、且有工作区。
  // shouldShowRemoteSyncActions 还会按客户端模式与本地源能力判断，
  // 本文件不得绕过它单独判断 remoteTarget 是否存在。
  const connectedRemoteSyncTarget =
    targetServiceResolution.rpcReady &&
    shouldShowRemoteSyncActions({
      remoteSessionId,
      remoteTarget,
      clientMode: isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
      hasLocalSourceService: Boolean(baseServices.skillSyncService),
    }) &&
    activeWorkspacePath
      ? remoteTarget
      : null;
  // 目标描述串只在确实要展示远端上下文时计算，未连接时为空串。
  const remoteSkillSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSkillSyncTarget(connectedRemoteSyncTarget, activeWorkspacePath ?? "")
    : "";

  // 作用域标签的三分支：workspace 显示目录名、plugin 显示插件展示名、其余归为个人。
  // 依赖里带 availablePlugins 与 pluginListingById，保证插件改名后标签同步。
  const renderScopeLabel = useCallback(
    (skill: SkillSummary): string => {
      switch (skill.scope) {
        case "workspace":
          // workspace 作用域显示 workspace 名，没有 workspace 时退回到通用文案。
          return (
            workspaceLabel ||
            intl.formatMessage({
              id: "settings.skills.scope.workspaceFallback",
            })
          );
        // [权衡] 插件名优先走 listing 的本地化展示名，失败再按名字唯一匹配；
        // 找不到时回退通用「插件」文案，而不是显示原始 pluginName 造成半截英文。
        case "plugin":
          return skill.pluginName?.trim()
            ? resolvePluginDisplayName(
                {
                  name: skill.pluginName,
                  listing:
                    (skill.pluginId ? pluginListingById.get(skill.pluginId) : undefined) ??
                    resolveUniquePluginListingByName(availablePlugins, skill.pluginName),
                },
                locale,
              )
            : intl.formatMessage({ id: "settings.skills.scope.plugin" });
        // [失败路径] default 与 user 合并：未知 scope 归为个人，宁可标签略宽也不抛错。
        case "user":
        default:
          return intl.formatMessage({ id: "settings.skills.scope.personal" });
      }
    },
    [availablePlugins, intl, locale, pluginListingById, workspaceLabel],
  );

  // 诊断码的文案 key 由码值拼成；新增码只需补 i18n，不需要改这里。
  const renderDiagnosticCodeLabel = useCallback(
    (code: SkillDiagnosticCode): string =>
      intl.formatMessage({ id: `settings.skills.diagnostics.code.${code}` }),
    [intl],
  );

  // 唯一读取入口。showBlockingLoading 区分「首屏/切 target」与「后台刷新」两种语义（INV-06/07）。
  const loadSkills = useCallback(
    async (showBlockingLoading: boolean) => {
      // [并发] 未就绪直接返回，连 loading 都不置：就绪状态由同步 effect 负责清理，
      // 这里再改 state 会与那条路径抢同一份状态。
      if (!targetServiceResolution.rpcReady) return;
      if (!activeWorkspacePath) {
        // [失败路径] 无工作区时清空全部四份状态并重置 target key，
        // 否则会残留上一个工作区的技能与诊断，切到空工作区后仍显示旧数据。
        setSkills([]);
        setCapability(null);
        setDiagnostics([]);
        setError(null);
        setLoading(false);
        setLoadedSkillTargetKey("");
        return;
      }
      const requestTargetKey = buildSourceSettingsProjectionKey(
        activeWorkspacePath,
        activeWorkspaceIdentity,
        cacheAuthorityKey,
      );
      // 只在这一处按参数设置 loading；catch 与成功分支都显式置 false，
      // 不要依赖 finally——代次不符时提前 return 会跳过 finally 之外的收尾。
      setLoading(showBlockingLoading);
      setError(null);
      // [并发] 先自增再发请求：任何后发的请求都会让先发的响应作废（INV-01）。
      const requestId = ++latestRequestIdRef.current;
      try {
        // list 的 provider 固定 ZCODE_AGENT_PROVIDER：移除三方来源后技能统一归到 ZCode Agent 上下文。
        const result = await skillsService.list({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          provider: ZCODE_AGENT_PROVIDER,
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setSkills(result.skills);
        setCapability(result.capability);
        // 诊断随列表一起回填；不要把它拆成第二次请求——两次响应之间列表与诊断会不一致。
        setDiagnostics(result.diagnostics);
        setLoadedSkillTargetKey(requestTargetKey);
        setLoading(false);
      // [失败路径] 失败时同样要写 loadedSkillTargetKey（INV-05），
      // 否则 projectionMatchesTarget 仍为真，错误被当作「已加载的当前 target」继续渲染。
      } catch (loadError) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setLoadedSkillTargetKey(requestTargetKey);
        setLoading(false);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      cacheAuthorityKey,
      skillsService,
      targetServiceResolution.rpcReady,
    ],
  );

  useEffect(() => {
    // [资源] 就绪状态回退时主动让在途请求作废（自增代次），并关闭两个弹窗：
    // 弹窗里的服务引用在 target 切换后已经指向新连接，继续提交会写错目标。
    if (!targetServiceResolution.rpcReady) {
      latestRequestIdRef.current += 1;
      setLoading(false);
      setError(null);
      setImportDialogOpen(false);
      setRemoteSkillSyncOpen(false);
      return;
    }
    // 首屏或切换 Scope target 时必须显示阻塞 loading；手动刷新仍走后台刷新，
    // 避免有当前 target 数据时整块闪烁。
    // 首屏与切 target 都走阻塞加载（INV-06）；依赖里同时有 activeWorkspacePath 与 loadSkills，
    // 而 loadSkills 已包含 workspaceIdentity / cacheAuthorityKey，故无需重复列出。
    void loadSkills(true);
  }, [activeWorkspacePath, loadSkills, targetServiceResolution.rpcReady]);

  // 手动刷新走后台模式，保留当前列表与滚动位置（INV-07）。
  const refresh = useCallback(async () => {
    await loadSkills(false);
  }, [loadSkills]);

  // 共享技能 store 是 Composer 等处的读取源；技能变更后必须同步刷新，
  // 否则设置页已更新、输入框的 skill 列表还是旧的。
  const refreshSharedSkillStoreForCurrentWorkspace = useCallback(async () => {
    await refreshSharedSkillStoreForWorkspace({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      skillsService,
    });
  }, [activeWorkspaceIdentity, activeWorkspacePath, skillsService]);

  // 开关写操作。没有乐观更新：写入成功后统一重载列表与共享 store，
  // 失败则把错误写进 error 条（列表保持原状态，不假装成功）。
  const setEnabled = useCallback(
    async (skillId: string, enabled: boolean) => {
      if (!activeWorkspacePath) {
        return;
      }
      // 移除三方来源后，技能状态统一写入 ZCode Agent 上下文，避免旧 provider 前缀带来分桶漂移。
      // 从当前列表回查 scope 并随请求带上：某些 provider 需要 scope 才能定位技能目录，
      // 只传 id 会落到默认作用域。
      const targetSkill = skills.find((skill) => skill.id === skillId);
      // INV-08：写死 ZCode Agent provider，不跟随技能自身的 provider 字段。
      // 否则旧数据里的三方前缀会把开关写进另一个分桶，表现为「关了又自己打开」。
      const effectiveProvider: ZCodeProvider = ZCODE_AGENT_PROVIDER;
      try {
        // 写操作本身不做防抖或串行队列：Switch 在请求期间不禁用，
        // 连续切换由后端最后写入胜出；这是刻意的，避免用户快速纠错时被 UI 拦住。
        await skillsService.setEnabled({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          provider: effectiveProvider,
          scope: targetSkill?.scope,
          skillId,
          enabled,
        });
        // INV-12：任何技能可用性变化都要让草稿会话失效，
        // 否则 Composer 里的 mention 仍指向旧状态，提交后注入失败或注入已禁用的技能。
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          reason: "settings-skill-enabled",
        });
        // [并发] 列表与共享 store 并发刷新，两者互不依赖；串行只会拉长开关的反馈时间。
        await Promise.all([loadSkills(false), refreshSharedSkillStoreForCurrentWorkspace()]);
      } catch (setEnabledError) {
        setError(
          setEnabledError instanceof Error ? setEnabledError.message : String(setEnabledError),
        );
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      loadSkills,
      refreshSharedSkillStoreForCurrentWorkspace,
      skills,
      skillsService,
    ],
  );

  // 删除本地技能：plugin 作用域技能不可单独删除（由卸载插件管理），调用方已在 UI 层屏蔽其入口。
  // 复用应用根部已挂载的确认弹窗 store（useConfirmDialog），与子智能体删除流程保持一致。
  // `deleteSkill` 流程：作用域守卫 → 确认弹窗 → 远端删除 → 草稿失效 → 关详情 → 重载。
  // 步骤顺序不可交换：先关详情再删会让失败时详情已消失。
  const handleDeleteSkill = useCallback(
    async (skill: SkillSummary) => {
      // [失败路径] 双重守卫：plugin 作用域由插件卸载管理（INV-09），
      // UI 层已屏蔽入口，这里是防绕过（键盘、脚本、复用的行渲染器）。
      if (!activeWorkspacePath || skill.scope === "plugin") {
        return;
      }
      // [事务] 确认弹窗是异步的：等待期间 target 可能已切换，
      // 因此确认后仍要用最新的 activeWorkspacePath 发请求，不能在点确认前就捕获参数。
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.skills.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.skills.delete.description" },
          { name: skill.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      // 取消时静默返回，不写 error、不刷新——用户主动放弃不是错误状态。
      if (!confirmed) {
        return;
      }
      try {
        // 删除只传 workspace + identity + skillId，不带 scope：
        // 服务端按 id 定位，避免前端 scope 过期导致删错目录。
        await skillsService.deleteSkill({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          skillId: skill.id,
        });
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          reason: "settings-skill-delete",
        });
        // INV-11：删除的正好是详情中的技能时先关弹窗，再重载列表。
        if (selectedSkill?.id === skill.id) {
          setSelectedSkill(null);
        }
        await loadSkills(false);
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      confirmDialog,
      intl,
      loadSkills,
      selectedSkill,
      skillsService,
    ],
  );

  // 两级投影：先按 provider 过滤（INV-14），再按 scope 与插件来源投影。
  // 插件源只有在 pluginStoreMatchesTarget 为真时才注入（INV-13）。
  const scopedProviderSkills = useMemo(() => {
    // provider 过滤放在 scope 之前：插件投影只应看到属于当前 provider 的技能，
    // 反过来先投影会把三方技能带进插件分组。
    const allProviderSkills = filterSkillsForProvider(skills, ZCODE_AGENT_PROVIDER);
    // [事务] 身份比对前先 trim，且 workspaceIdentity 优先于 path；空串与 undefined 归一化，
    // 避免「同一个工作区两种写法」被误判为不一致而丢掉插件分组。
    const pluginStoreMatchesTarget =
      (pluginWorkspaceIdentity?.trim() || pluginWorkspacePath || "") ===
        (activeWorkspaceIdentity?.trim() || activeWorkspacePath || "") &&
      pluginConfigScope === scopeFilter;
    // scope 不匹配时传空插件列表而不是不调用：本地技能仍需按 scope 投影，
    // 否则 user / workspace 两种视图会混在一起。
    return selectSkillsForScope(
      allProviderSkills,
      pluginStoreMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, scopeFilter) : [],
      scopeFilter,
    );
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    installedPlugins,
    pluginWorkspaceIdentity,
    pluginWorkspacePath,
    pluginConfigScope,
    plugins,
    scopeFilter,
    skills,
  ]);
  // 分组与搜索合并在一次 useMemo 内完成：先把技能按插件归组，再按 query 过滤，
  // 两件事共享同一份中间结果，拆开会让过滤逻辑出现两份口径。
  const groupedSkills = useMemo(
    () => groupSkillsByPlugin(scopedProviderSkills, query),
    [query, scopedProviderSkills],
  );
  // 来源分组的标题按 scopeFilter 取「个人/工作区」，与列表顶部的作用域切换保持一致。
  const skillSourceGroups = useMemo(() => {
    return groupScopedSkillsBySource(
      [...groupedSkills.local, ...groupedSkills.plugin],
      scopeFilter === "user"
        ? intl.formatMessage({ id: "settings.scope.user" })
        : workspaceLabel || intl.formatMessage({ id: "settings.scope.workspace" }),
    );
  }, [groupedSkills.local, groupedSkills.plugin, intl, scopeFilter, workspaceLabel]);
  // 可见数只统计列表真正渲染的两组，插件分组区不重复计数；
  // 这个值会通过 onVisibleCountChange 上报给外层搜索摘要。
  const filteredSkillCount = groupedSkills.local.length + groupedSkills.plugin.length;
  // [失败路径] 必须先 trim 再判空：只输入空格不应进入搜索空态（INV-15）。
  const hasEmptySearchResult = Boolean(query.trim()) && filteredSkillCount === 0;
  // 直接安装数用于区分两种空态：真的没有技能 vs 搜索没命中；
  // 统计时排除 plugin 技能，因为插件技能不由本页安装。
  const directInstalledSkillCount = scopedProviderSkills.filter(
    (skill) => skill.scope !== "plugin",
  ).length;
  // INV-16：搜索且本地组为空时只隐藏该 section，不卸载——
  // 卸载会重建子树并让搜索框失焦。
  const hideInstalledGroup = Boolean(query.trim()) && groupedSkills.local.length === 0;
  // 行内图标只依赖 id、name、listing 三项，单独建 Map 避免整份插件对象进入渲染依赖。
  const pluginIconItemById = useMemo(
    () =>
      new Map(
        plugins.map((plugin) => [
          plugin.id,
          { name: plugin.name, listing: pluginListingById.get(plugin.id) },
        ]),
      ),
    [pluginListingById, plugins],
  );
  useEffect(() => {
    // 可见数变化即上报；回调可选，且必须放在 effect 里，不能在渲染期调用（会触发父组件 setState 警告）。
    onVisibleCountChange?.(filteredSkillCount);
  }, [filteredSkillCount, onVisibleCountChange]);
  // [事务] 创建技能不是「本地新建文件」，而是打开一个新任务并预填 skill-creator mention，
  // 因此必须先有 onCreateTask 与工作区（INV-18）。
  const handleCreateSkill = () => {
    if (!activeWorkspacePath || !onCreateTask) {
      return;
    }
    const effectiveProvider: ZCodeProvider = ZCODE_AGENT_PROVIDER;
    // 按名字查找 skill-creator：找不到也继续，mention 仍会以固定 id 生成，
    // 只是缺少 path/scope 元数据——不能因此阻断入口。
    const skillCreator = filterSkillsForProvider(skills, effectiveProvider).find(
      (skill) => skill.name === "skill-creator",
    );
    // mention 的 markdown 与 initialPrompt 必须由同一个构造器生成，保证文本与 chip 一致。
    const markdown = buildSkillMentionMarkdown("skill-creator", skillCreator?.path);

    // v4 迁移删除旧 pendingComposerPrefill 后，这个入口仍手工操作 session
    // store，只剩返回聊天页的导航，skill-creator 文本没有进入新 Composer。统一委托
    // Root 的新任务入口，让草稿持久化、workspaceIdentity 隔离和 Composer 插入保持单一路径。
    // [权衡] 全部委托给上层新任务入口：草稿持久化、workspaceIdentity 隔离、
    // Composer 插入都只有这一条路径。自行写 session store 会出现「文本没进 Composer」的回归。
    onCreateTask({
      provider: effectiveProvider,
      initialPrompt: `${markdown} `,
      initialPromptMention: {
        id: `skill:${skillCreator?.id ?? "skill-creator"}`,
        category: "skills",
        label: "skill-creator",
        value: "skill-creator",
        markdown,
        ...(skillCreator?.description ? { description: skillCreator.description } : {}),
        ...(skillCreator
          ? {
              data: {
                path: skillCreator.path,
                scope: skillCreator.scope,
              },
            }
          : {}),
      },
    });
  };

  // INV-19：每次渲染按 id 重新取最新对象；找不到时退回选中快照，
  // 保证删除瞬间弹窗不会因为对象消失而崩。
  const detailSkill = selectedSkill
    ? (skills.find((skill) => skill.id === selectedSkill.id) ?? selectedSkill)
    : null;
  // 发布时间在渲染期格式化；null 时详情字段组件自动隐藏整行。
  const selectedSkillPublishedAt = formatSkillPublishedAt(detailSkill?.metadata?.publishedAt);
  // [失败路径] 平台调用返回 success=false 只 toast，不写 error 条：
  // 打开文件管理器失败是局部操作失败，不应污染技能列表的错误状态。
  const openSkillFilePath = useCallback(
    async (path: string) => {
      const result = await platform.openInFileManager(path);
      // Web 环境与无权限路径都会走到这里；文案复用 appHeader 的通用失败提示。
      if (!result.success) {
        toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
      }
    },
    [intl, platform],
  );

  // 诊断条数不等于加载失败的技能数；同一次扫描可以返回可用技能和多个目录级警告。
  // 按严重级别展示真实统计，避免把 warning 误报成“所有技能加载失败”。
  // INV-17：按 severity 精确统计。诊断条数可以大于失败技能数——
  // 同一次扫描会同时返回可用技能与多个目录级警告。
  const diagnosticErrorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  // warning 用总数减 error 得到：诊断只有 error / warning 两级，
  // 新增级别时必须回来改这里，否则会被静默计入 warning。
  const diagnosticWarningCount = diagnostics.length - diagnosticErrorCount;
  const diagnosticsSummary =
    diagnostics.length > 0
      ? intl.formatMessage(
          { id: "settings.skills.diagnostics.summary" },
          {
            errorCount: String(diagnosticErrorCount),
            warningCount: String(diagnosticWarningCount),
          },
        )
      : "";
  // 行渲染器在每次渲染时重建（未 memo）：它闭包了 intl 与多个回调，
  // 缓存反而会拿到过期的文案与 target 状态。
  const renderSkillRow = (skill: SkillSummary) => {
    // 图标解析三级回退：pluginId 索引 → 按 pluginName 唯一匹配 → 无图标。
    const pluginIconItem = skill.pluginId
      ? pluginIconItemById.get(skill.pluginId)
      : skill.pluginName
        ? {
            name: skill.pluginName,
            listing: resolveUniquePluginListingByName(availablePlugins, skill.pluginName),
          }
        : undefined;
    return (
      <div
        key={skill.id}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover"
      >
        {skill.scope === "plugin" && pluginIconItem ? (
          <PluginStoreAvatar item={pluginIconItem} className="size-9 bg-background" />
        ) : (
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
            aria-hidden="true"
          >
            <WandSparkles className="size-4" />
          </div>
        )}
        <div
          // [权衡] 用 div + role=button 而不是 button：行内还要放 Switch 与删除按钮，
          // 嵌套 button 是非法 HTML，浏览器会重排 DOM 导致事件错乱。
          role="button"
          tabIndex={0}
          className="min-w-0 cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          onClick={() => setSelectedSkill(skill)}
          // INV-20：Space 必须 preventDefault，否则会先滚动页面；
          // Enter 不需要，但统一阻止可以避免触发外层的表单提交。
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelectedSkill(skill);
            }
          }}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-ui-base font-medium text-foreground">{skill.name}</span>
          </div>
          <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">
            {skill.description ||
              intl.formatMessage({
                id: "settings.skills.noDescription",
              })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {skill.scope === "plugin" ? null : (
            <>
              <Switch
                checked={skill.enabled}
                onCheckedChange={(checked) => {
                  void setEnabled(skill.id, checked);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:bg-destructive/10 hover:text-destructive"
                aria-label={intl.formatMessage({ id: "common.delete" })}
                title={intl.formatMessage({ id: "common.delete" })}
                onClick={() => void handleDeleteSkill(skill)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </>
          )}
        </div>
      </div>
    );
  };

  // 列表容器统一走 SettingsResourceList，虚拟化与空态由它处理，本文件只提供 key 与行渲染。
  const renderSkillList = (groupSkills: SkillSummary[]) => (
    <SettingsResourceList
      items={groupSkills}
      getKey={(skill) => skill.id}
      renderItem={renderSkillRow}
    />
  );

  // 三个头部动作：刷新、导入、新建。刷新是「列表 + 共享 store」的组合刷新（INV-12 的读取侧）。
  const skillHeaderActions = (
    <SettingsResourceHeaderActions
      // [并发] 两个刷新并发且都以 void 丢弃 Promise：失败已由 loadSkills 写入 error 条，
      // 这里再 catch 会产生重复提示。
      onRefresh={() => void Promise.all([refresh(), refreshSharedSkillStoreForCurrentWorkspace()])}
      onImport={() => setImportDialogOpen(true)}
      onNew={handleCreateSkill}
      // [失败路径] capability 未回填时按「不可导入」处理（undefined 取反为 true），
      // 宁可暂时禁用，也不要在不支持的环境里弹出导入框。
      importDisabled={!capability?.userScopeAvailable}
      importActionId="settings.skills.import.open"
      newActionId="settings.skills.create.open"
    />
  );
  // 远端同步按钮只在 connectedRemoteSyncTarget 非空时挂载（INV-03 的展示侧）。
  const remoteSyncAction = connectedRemoteSyncTarget ? (
    <ControlHintTooltip title={intl.formatMessage({ id: "settings.skills.remoteSync.open" })}>
      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        aria-label={intl.formatMessage({
          id: "settings.skills.remoteSync.open",
        })}
        onClick={() => setRemoteSkillSyncOpen(true)}
      >
        <UploadCloud className="size-3.5" aria-hidden="true" />
      </Button>
    </ControlHintTooltip>
  ) : null;

  return (
    <div className="space-y-4">
      {/* Bug 原因：独立 Skills 分区的详情是弹窗，不属于页面级导航；只有插件容器需要上报详情层级。 */}
      {reportDetailBreadcrumb && detailSkill ? (
        <SettingsBreadcrumbReporter
          items={
            showMarketplaceBreadcrumb
              ? [
                  {
                    label: intl.formatMessage({ id: "settings.plugins.title" }),
                    onSelect: () => setSelectedSkill(null),
                  },
                  { label: detailSkill.name },
                ]
              : [{ label: detailSkill.name }]
          }
          onSectionSelect={
            showMarketplaceBreadcrumb && onOpenPluginStore
              ? onOpenPluginStore
              : () => setSelectedSkill(null)
          }
        />
      ) : null}
      {remoteSyncAction ? <div className="flex justify-end">{remoteSyncAction}</div> : null}

      {connectedRemoteSyncTarget ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.skills.remoteContext" },
            { target: remoteSkillSyncTargetLabel },
          )}
        </div>
      ) : null}

      {targetServiceResolution.rpcReady && diagnostics.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/10 text-ui-base text-foreground">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            onClick={() => setDiagnosticsOpen((prev) => !prev)}
            aria-expanded={diagnosticsOpen}
            aria-label={
              diagnosticsOpen
                ? intl.formatMessage({
                    id: "settings.skills.diagnostics.collapse",
                  })
                : intl.formatMessage({
                    id: "settings.skills.diagnostics.expand",
                  })
            }
          >
            {diagnosticsOpen ? (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            <span className="flex-1 truncate font-medium">{diagnosticsSummary}</span>
          </button>
          {diagnosticsOpen ? (
            <ul className="space-y-1 border-t border-amber-500/30 px-3 py-2">
              {diagnostics.map((diagnostic, index) => (
                // [失败路径] key 用 code + path + index 三拼：同一码同一路径可能重复出现，
                // 只用前两者会触发 React 重复 key 警告并错配展开状态。
                <li
                  key={`${diagnostic.code}-${diagnostic.path ?? "no-path"}-${index}`}
                  className="min-w-0"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={
                        // 严重级别标签同时决定颜色与文案；error 用 destructive，warning 用 amber，
                        // 两者不能只靠颜色区分（还有文字本身）。
                        diagnostic.severity === "error"
                          ? "shrink-0 text-ui-xs font-semibold uppercase tracking-wide text-destructive"
                          : "shrink-0 text-ui-xs font-semibold uppercase tracking-wide text-amber-500"
                      }
                    >
                      {diagnostic.severity}
                    </span>
                    <span className="font-medium text-foreground">
                      {renderDiagnosticCodeLabel(diagnostic.code)}
                    </span>
                    {diagnostic.skillName ? (
                      <span className="text-foreground-subtle">· {diagnostic.skillName}</span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 break-words text-foreground-subtle">
                    {diagnostic.message}
                  </div>
                  {diagnostic.path ? (
                    <div className="mt-0.5 break-all font-mono text-ui-xs text-foreground-subtle">
                      {diagnostic.path}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {targetServiceResolution.rpcReady && !capability?.userScopeAvailable ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.skills.userScopeDesktopOnly" })}
        </div>
      ) : null}

      {targetServiceResolution.rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      // [失败路径] projectionMatchesTarget=false 也走加载态：
      // 这表示数据属于旧 target，宁可显示 loading 也不能展示错工作区的技能。
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      // 搜索空态在列表之前判断：此时两组都为空，继续渲染只会得到两个空 section。
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.skills.searchEmpty",
          })}
        />
      ) : (
        <div className="space-y-6">
          <section className={hideInstalledGroup ? "hidden" : "space-y-4"}>
            <div data-skills-plugin-direct-actions="true">
              <SettingsResourceGroupHeader
                actions={skillHeaderActions}
                count={groupedSkills.local.length}
                title={intl.formatMessage({
                  id: "settings.plugin.skills.installed",
                })}
              />
            </div>
            {groupedSkills.local.length > 0 ? (
              renderSkillList(groupedSkills.local)
            // [权衡] 只有「一个直接安装的技能都没有」且「没有搜索词」才展示引导安装空态；
            // 搜索无结果交给上面的搜索空态，避免两套空态同时出现。
            ) : directInstalledSkillCount === 0 && !query.trim() ? (
              <PluginInstallEmptyState
                title={intl.formatMessage({
                  id: "settings.plugin.skills.emptyInstalledTitle",
                })}
                description={intl.formatMessage({
                  id: "settings.plugin.skills.emptyInstalledDescription",
                })}
                actions={
                  <>
                    <Button type="button" variant="default" size="lg" onClick={handleCreateSkill}>
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.plugin.skills.newSkill",
                      })}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      disabled={!capability?.userScopeAvailable}
                      onClick={() => setImportDialogOpen(true)}
                    >
                      <Import data-icon="inline-start" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "settings.skills.import.action",
                      })}
                    </Button>
                  </>
                }
              />
            ) : null}
          </section>
          {skillSourceGroups
            .filter((group) => group.id.startsWith("plugin:"))
            .map((group) => (
              <section key={group.id} className="space-y-4">
                <SettingsResourceGroupHeader
                  count={group.skills.length}
                  title={resolvePluginDisplayName(
                    {
                      name: group.label,
                      listing:
                        (group.pluginId ? pluginListingById.get(group.pluginId) : undefined) ??
                        resolveUniquePluginListingByName(availablePlugins, group.label),
                    },
                    locale,
                  )}
                />
                {renderSkillList(group.skills)}
              </section>
            ))}
        </div>
      )}
      <Dialog
        // onOpenChange 只在关闭时清空；打开动作统一来自行点击，不从外部注入。
        open={selectedSkill !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSkill(null);
          }
        }}
      >
        <DialogContent className="max-h-[min(80vh,640px)] max-w-xl overflow-hidden p-0">
          {detailSkill ? (
            <div className="flex min-h-0 flex-col">
              <DialogHeader className="border-b border-popover-border px-4 pt-4 pb-3">
                <DialogTitle className="truncate pr-8 text-ui-lg">{detailSkill.name}</DialogTitle>
              </DialogHeader>
              <div className="min-h-0 space-y-4 overflow-auto px-4 py-5">
                <div className="grid gap-1.5">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "settings.skills.detail.description",
                    })}
                  </div>
                  <div className="max-h-40 overflow-auto whitespace-pre-wrap text-ui-base/relaxed text-foreground-subtle">
                    {detailSkill.description ||
                      intl.formatMessage({
                        id: "settings.skills.noDescription",
                      })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.scope",
                    })}
                    value={renderScopeLabel(detailSkill)}
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.status",
                    })}
                    value={
                      detailSkill.enabled
                        ? intl.formatMessage({
                            id: "settings.skills.detail.enabled",
                          })
                        : intl.formatMessage({
                            id: "settings.skills.detail.disabled",
                          })
                    }
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.version",
                    })}
                    value={detailSkill.metadata?.version}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.slug",
                    })}
                    value={detailSkill.metadata?.slug}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.publishedAt",
                    })}
                    value={selectedSkillPublishedAt}
                    mono
                  />
                  <SkillDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.ownerId",
                    })}
                    value={detailSkill.metadata?.ownerId}
                    mono
                    className="col-span-2"
                  />
                  <SkillPathDetailField
                    label={intl.formatMessage({
                      id: "settings.skills.detail.path",
                    })}
                    path={detailSkill.path}
                    openLabel={intl.formatMessage({
                      id: "settings.skills.detail.openPath",
                    })}
                    onOpen={() => void openSkillFilePath(detailSkill.path)}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <SkillsImportDialog
        // 条件里显式带上 rpcReady，而不是在 setState 时判断：
        // 这样连接断开导致的自动关闭也走同一条路径。
        open={importDialogOpen && targetServiceResolution.rpcReady}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={targetServiceResolution.services.settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: activeWorkspacePath,
            workspaceIdentity: activeWorkspaceIdentity,
            reason: "settings-skill-import",
          });
          await refresh();
        }}
      />
      <RemoteSyncDialogs
        canSyncSkills={Boolean(
          targetServiceResolution.rpcReady && connectedRemoteSyncTarget && activeWorkspacePath,
        )}
        canSyncMcp={false}
        skillOpen={remoteSkillSyncOpen && targetServiceResolution.rpcReady}
        mcpOpen={false}
        onSkillOpenChange={setRemoteSkillSyncOpen}
        onMcpOpenChange={() => {}}
        localSkillSyncService={baseServices.skillSyncService}
        remoteSkillSyncService={skillSyncService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath={activeWorkspacePath ?? ""}
        mcpWorkspacePath=""
        workspaceIdentity={activeWorkspaceIdentity}
        onSkillsSynced={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: activeWorkspacePath,
            workspaceIdentity: activeWorkspaceIdentity,
            reason: "settings-remote-skill-sync",
          });
          await Promise.all([refresh(), refreshSharedSkillStoreForCurrentWorkspace()]);
        }}
        onMcpSynced={() => {}}
      />
    </div>
  );
}
