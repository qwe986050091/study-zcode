// HooksSection —— Hooks 设置页的主容器：作用域选择、本地与插件 Hook 的分组投影、
// 增删改导入信任的编排，以及审核绑定驱动的自动作用域切换。
//
// 职责边界
// 做：按作用域过滤 Hook、区分可编辑与兼容格式分组、维护搜索与视图模式、串行执行写操作。
// 不做：Hook 配置格式定义、运行时 discovery、配置文件落盘、信任状态持久化。
// 依赖：hooksStore 与 pluginManagementStore 两个只读投影，workspace 服务解析提供目标连接。
// 被谁用：设置页 Hooks 页签，宿主提供工作区上下文并接收面包屑与视图切换。
// 边界：所有写操作都带目标解析结果，组件内不缓存第二份 Hook 列表。
//
// INV 不变量（违反任意一条都会把 Hook 写进错误的工作区，或让信任入口失效）
// INV-01 读写目标只由选中作用域条目决定，未选中才沿用当前工作区 —— 守住它的位置：作用域目标解析函数 —— 改错故障：本机路径配上远端身份，远端建目录报权限错误。
// INV-02 选中条目时路径与身份必须成对取用 —— 守住它的位置：目标解析函数的返回对象 —— 改错故障：路径与身份来自不同工作区，写入落到错误主机。
// INV-03 可编辑判断优先尊重运行时标志 —— 守住它的位置：isEditableHook —— 改错故障：工作区 Hook 出现可编辑入口但保存必然失败。
// INV-04 只读 zcode 行必须留在已安装分组 —— 守住它的位置：只读判定与分组过滤 —— 改错故障：导入按钮必然失败，且无法逐条信任。
// INV-05 兼容分组等于「不可编辑且非只读 zcode」 —— 守住它的位置：兼容分组谓词 —— 改错故障：同一个 Hook 同时出现在两个分组。
// INV-06 最新审核按创建时间取最大，且严格大于才替换 —— 守住它的位置：绑定扫描循环 —— 改错故障：时间戳相同时目标来回跳动。
// INV-07 有身份按身份匹配页签，无身份才回退路径 —— 守住它的位置：页签查找分支 —— 改错故障：远程页签与本地同路径项目互相混淆。
// INV-08 找不到页签必须返回空，调用方不得切换 —— 守住它的位置：纯函数的最终返回 —— 改错故障：切到已关闭工作区，页面停在连接中。
// INV-09 插件 Hook 作用域未知时两个页签都保留 —— 守住它的位置：按作用域过滤 —— 改错故障：概览降级时真实存在的 Hook 被隐藏。
// INV-10 作用域未知不得伪造成用户级 —— 守住它的位置：插件行构建的映射 —— 改错故障：工作区 Hook 出现在用户页签。
// INV-11 源端用户级必须把读写锁到 user —— 守住它的位置：hooksService 的包装 —— 改错故障：覆盖源端工作区的项目配置。
// INV-12 信任动作使用 target 解析后的服务 —— 守住它的位置：行内信任 hook 的入参 —— 改错故障：越界请求打到激活页签的 host。
// INV-13 缓存权威键只在「有来源服务器且未选中项目」时生成 —— 守住它的位置：权威键计算 —— 改错故障：项目写入被当成用户级缓存。
// INV-14 服务解析四项入参必须同源 —— 守住它的位置：目标服务解析调用 —— 改错故障：远程工作区请求打到本地 host。
// INV-15 所有 RPC 以就绪标志为门禁 —— 守住它的位置：初始化与刷新 effect —— 改错故障：连接期以空数据覆盖缓存。
// INV-16 刷新并行等待 Hook 与插件两条链路 —— 守住它的位置：刷新回调 —— 改错故障：插件较慢时拖慢 Hook 可见时间。
// INV-17 审核自动切换只在交互标识变化时触发一次 —— 守住它的位置：自动切换 effect 与去重引用 —— 改错故障：待处理期间用户无法切走。
// INV-18 自动切换目标必须仍存在于页签集合 —— 守住它的位置：纯函数返回空的使用点 —— 改错故障：与失效作用域重置形成乒乓循环。
// INV-19 搜索用延迟值，输入框保持即时 —— 守住它的位置：延迟查询与归一化 —— 改错故障：长列表逐键输入明显卡顿。
// INV-20 两个 store 的数据必须校验归属后才参与投影 —— 守住它的位置：选择器与作用域过滤 —— 改错故障：展示其他 target 的插件 Hook。
//
// 三处看着可以简化、其实不能删的保护：
// 1) 目标解析里路径与身份成对取用，去掉后会出现本地路径配远端身份。
// 2) 只读 zcode 行留在已安装分组，挪去兼容分组会让导入按钮必然失败。
// 3) 审核切换的去重引用，删掉后待处理期间用户每次切换都会被拉回。
import { useConfigWorkspaceTargets } from "@/workspace-config-catalog/index.js";
import { SettingsUserScopeProvider } from "@/settings/SettingsMachine.js";
/* eslint-disable max-lines -- Hooks 页面聚合 Scope、插件投影、搜索与配置写入流程。 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Hook, HookConfig, ZCodeInstalledPluginSummary, ZCodePluginInfo } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { invalidateDeferredDraftSessionForRuntimeChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useHooksStore } from "@/store/hooksStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { HookForm } from "./HookForm.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import { HooksList, type HookScope, type PluginHookRow } from "./HooksList.js";
import { useWorkspaceHookInlineTrust } from "./useWorkspaceHookInlineTrust.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import { PluginScopeMenu, getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { PluginLoadingState, PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import {
  shouldShowWorkspaceHookTrustNotice,
  WorkspaceHookTrustNotice,
} from "@/settings/WorkspaceHookTrustNotice.js";

// [契约] 工作区路径与身份用于定位 Hook 的读写目标，身份缺失表示本地项目。
// [契约] 设置来源服务器标识只在源端设置页出现，它把作用域限定到源端用户级。
// [契约] 组件不接收服务实例，所有服务由工作区解析结果提供，避免调用方注入两套连接。
// [权衡] props 只有三项，页面级状态（视图模式、搜索词、作用域）全部留在组件内。
interface HooksSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  settingsSourceServerId?: string | null;
}

// [契约] 优先尊重运行时下发的可编辑标志：工作区 Hook 在运行时段不可直接改配置。
// [契约] 本地设置发现路径没有该标志时回退旧规则：无位置信息或来源为 zcode 即可编辑。
// [失败路径] 若忽略标志一律按旧规则判断，工作区 Hook 会出现可编辑但保存必然失败的入口。
// [权衡] 空值与假值语义不同，这里区分「未提供」与「明确不可编辑」两种情况。
// [契约] 这个判断只决定是否给出编辑入口，不参与实际写入权限校验。
function isEditableHook(hook: Hook): boolean {
  // workspace-hook-trust：运行时 discovery 会下发 editable 标志（工作区 Hook 在
  // runtime 侧不可直接改配置），优先尊重；本地 Settings 发现路径无该标志时回退旧规则。
  return hook.editable ?? (!hook.location || hook.location.source === "zcode");
}

// workspace-hook-trust：editable=false 且 source=zcode 的行是「上游/祖先 zcode.json
// 里的只读工作区 Hook」。它们不是外部格式兼容导入源，塞进 Legacy 会让 Import 按钮
// 必然失败（importHook 拒绝 source=zcode），也违反「只读但可逐条 Trust」的约定。
// 这类行应留在 Installed 分组，由信任状态门控 Switch，走行内 Trust 流程。
// [契约] 只读但可逐条信任的判定：可编辑标志为假且来源为 zcode 或缺失。
// [契约] 这类行留在已安装分组，由信任状态门控开关，而不是塞进兼容格式分组。
// [失败路径] 若归到兼容分组，导入按钮必然失败，因为导入链路拒绝 zcode 来源。
// [契约] 来源缺失按 zcode 处理，与上游默认来源保持一致。
// [权衡] 与可编辑判断拆开，是因为「只读」与「不可编辑但仍可信任」是两种不同处置。
export function isReadOnlyZCodeHook(hook: Hook): boolean {
  return hook.editable === false && (hook.location?.source ?? "zcode") === "zcode";
}

// [契约] 兼容格式分组等于「不可编辑且不是只读 zcode」的差集，两个判断都不能省。
// [失败路径] 若只判不可编辑，只读 zcode 行会同时出现在已安装与兼容两个分组。
// [契约] 这是纯谓词，分组顺序与展示标签由列表组件决定。
// [权衡] isInCompatibilitySection 用「非可编辑且非只读 zcode」的排除法，新增外部来源不必改这里。
function isInCompatibilitySection(hook: Hook): boolean {
  return !isEditableHook(hook) && !isReadOnlyZCodeHook(hook);
}

/**
 * workspace-hook-trust：解析「最新 review binding」对应的 scope 切换目标。
 * 纯函数（供 HooksSection 与单测共用）：
 * - 按 request.createdAt 取最新 binding（同一 runtime flow 的 generation 递增也会
 *   刷新 createdAt，语义是「最新出现的审核」）；
 * - identity 优先精确匹配 tab 的 scope key；无 identity 的旧本地 binding 才按
 *   workspacePath 回退（与 matchesWorkspaceBinding 的降级规则一致）；
 * - 找不到对应 tab（workspace 已关闭/未知）返回 null——调用方不得切过去。
 */
// [契约] 取创建时间最新的审核绑定，同一流程的多次生成会刷新时间戳，语义是「最新出现的审核」。
// [契约] 有身份时按身份精确匹配页签，无身份的旧本地绑定才按路径回退。
// [契约] 找不到对应页签返回空，调用方不得切换过去，这是防止切到已关闭工作区的第一道闸。
// [失败路径] 若按路径优先匹配，远程页签与本地同路径项目会被混淆。
// [权衡] 纯函数形式便于单测直接构造绑定与页签，不依赖 store。
// [契约] 时间戳相同时保留先遍历到的绑定，遍历顺序由对象键序决定，结果稳定。
export function resolveLatestReviewScopeTarget(
  bindings: Record<
    string,
    {
      request: { interactionId: string; createdAt: number; workspaceIdentity?: string };
      workspacePath: string;
    }
  >,
  workspaceTabs: readonly { workspacePath: string; workspaceIdentity?: string }[],
): { interactionId: string; scopeKey: string } | null {
  let latest: {
    interactionId: string;
    createdAt: number;
    workspaceIdentity?: string;
    workspacePath: string;
  } | null = null;
  // [契约] 单趟扫描取最大创建时间，不排序也不拷贝整张表。
  // [契约] 严格大于才替换，相等时保留先遇到的一条，避免同一时间戳反复换人。
  // [契约] 绑定字段被摊平成扁平结构，后续匹配只依赖工作区路径与身份。
  // [权衡] 绑定数量是个位数级，线性扫描比建索引更直观。
  for (const binding of Object.values(bindings)) {
    if (!latest || binding.request.createdAt > latest.createdAt) {
      latest = {
        interactionId: binding.request.interactionId,
        createdAt: binding.request.createdAt,
        workspaceIdentity: binding.request.workspaceIdentity,
        workspacePath: binding.workspacePath,
      };
    }
  }
  if (!latest) return null;
  // key 规则与 getPluginWorkspaceKey 一致（identity 优先，回退 workspacePath），
  // 这里内联而非复用，避免 helper 依赖 WorkspaceTabState 完整类型、便于单测。
  const scopeKeyOf = (tab: { workspacePath: string; workspaceIdentity?: string }) =>
    tab.workspaceIdentity?.trim() || tab.workspacePath;
  const identity = latest.workspaceIdentity?.trim();
  const tab = identity
    ? workspaceTabs.find((candidate) => scopeKeyOf(candidate) === identity)
    : workspaceTabs.find((candidate) => candidate.workspacePath === latest!.workspacePath);
  return tab ? { interactionId: latest.interactionId, scopeKey: scopeKeyOf(tab) } : null;
}

/**
 * Hook 读写目标只由选中的 Scope 条目决定。
 * Bug 根因：选中本地项目（无 identity）时曾用 `??` 回退到活动聊天工作区的 identity，
 * 活动工作区是远端时就把本机路径配上远端身份发往 Source Server，远端 `mkdir '/Users'` 报 EACCES。
 * User Scope 未选项目时仍沿用当前 workspace 路由（R3 §8.2）。
 */
// [契约] 读写目标只由选中的作用域条目决定；未选中项目时才沿用当前工作区。
// [契约] 选中条目时路径与身份必须成对取用，不能一个来自条目、一个来自当前工作区。
// [失败路径] 曾经用空值合并回退身份，结果把本机路径配上远端身份发往源端，远端建目录直接报权限错误。
// [契约] 未选中项目时保持原有路由语义，这是用户级作用域的既定行为。
// [权衡] 保持纯函数，便于用单测覆盖四种输入组合。
// [契约] 身份允许为空，空身份代表本地项目，不能在这里补默认值。
export function resolveHookScopeTarget(
  selectedWorkspace: { workspacePath: string; workspaceIdentity?: string } | undefined,
  workspacePath: string | null | undefined,
  workspaceIdentity: string | undefined,
): { workspacePath: string | null | undefined; workspaceIdentity: string | undefined } {
  return selectedWorkspace
    ? {
        workspacePath: selectedWorkspace.workspacePath,
        workspaceIdentity: selectedWorkspace.workspaceIdentity,
      }
    : { workspacePath, workspaceIdentity };
}

// [契约] 把插件详情摊平成行，每行携带插件启用态、插件标识与作用域。
// [契约] 作用域来自已安装插件摘要的映射，详情本身不携带作用域。
// [契约] 市场可用性未知时不给作用域，不能伪造成用户级。
// [失败路径] 若把未知作用域填成用户级，两个页签都会显示这条 Hook，过滤结果也随之错误。
// [权衡] 用扁平映射一次遍历生成所有行，避免嵌套结构在列表层再展开。
export function buildPluginHookRows(
  plugins: readonly Pick<ZCodePluginInfo, "enabled" | "hookDetails" | "id" | "name">[],
  installedPlugins: readonly Pick<ZCodeInstalledPluginSummary, "id" | "scope">[],
  scopeMetadataKnown: boolean,
): PluginHookRow[] {
  const scopeByPluginId = new Map(
    installedPlugins.map((plugin) => [plugin.id, plugin.scope] as const),
  );
  return plugins.flatMap((plugin) =>
    (plugin.hookDetails ?? []).map((detail) => ({
      detail,
      pluginEnabled: plugin.enabled,
      pluginId: plugin.id,
      pluginName: plugin.name,
      // overview 降级时 installedPlugins=[] 表示 scope 未知，不能伪造成 User。
      pluginScope: scopeMetadataKnown ? scopeByPluginId.get(plugin.id) : undefined,
    })),
  );
}

// [契约] 项目页签对应工作区作用域，用户页签对应用户作用域，映射只有这一处。
// [契约] 作用域未知的行在两个页签都保留，交给列表标记，避免降级时隐藏真实存在的 Hook。
// [失败路径] 若把未知行直接过滤掉，插件概览降级期间用户会以为 Hook 消失。
// [权衡] 过滤是纯函数，作用域映射写在函数内部而不是调用方，减少口径漂移。
// [契约] 这里只筛插件 Hook，本地 Hook 的分组由另一条路径负责。
export function filterPluginHooksByScope(
  pluginHooks: readonly PluginHookRow[],
  scope: HookScope,
): PluginHookRow[] {
  const expectedScope = scope === "project" ? "workspace" : "user";
  // 未知 scope 在两个 Tab 都保留并由列表标记，避免降级时隐藏真实存在的插件 Hook。
  return pluginHooks.filter(
    (hook) => hook.pluginScope === undefined || hook.pluginScope === expectedScope,
  );
}

// [契约] 组件是 Hook 页面状态的唯一所有者：视图模式、编辑对象、搜索词与选中作用域。
// [契约] 服务全部来自工作区解析结果，不直接使用全局上下文里的当前连接。
// [契约] 列表数据来自 Hook store 与插件 store 两个只读投影。
// [失败路径] 若在组件内另建一份 Hook 数组，刷新后会与服务端投影分叉。
// [权衡] 过滤用 deferredSearchTerm 而不是实时输入，输入框保持即时响应，列表稍后跟上。
export function HooksSection({
  workspacePath,
  workspaceIdentity,
  settingsSourceServerId,
}: HooksSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const currentServices = useServices();
  const hooksState = useHooksStore();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const pluginsLoading = usePluginManagementStore((state) => state.loading);
  const pluginsError = usePluginManagementStore((state) => state.error);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const [viewMode, setViewMode] = useState<"list" | "form">("list");
  const [editingHook, setEditingHook] = useState<Hook | null>(null);
  const [query, setQuery] = useState("");
  const workspaceTabs = useConfigWorkspaceTargets(settingsSourceServerId);
  const [selectedScopeKey, setSelectedScopeKey] = useState("user");
  const deferredQuery = useDeferredValue(query);
  const selectedWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === selectedScopeKey,
  );
  const activeScope: HookScope = selectedWorkspace ? "project" : "user";
  const { workspacePath: targetWorkspacePath, workspaceIdentity: targetWorkspaceIdentity } =
    resolveHookScopeTarget(selectedWorkspace, workspacePath, workspaceIdentity);
  const targetWorkspaceKey = targetWorkspacePath
    ? getWorkspaceKey(targetWorkspacePath, targetWorkspaceIdentity)
    : null;
  // [契约] 只有在「有来源服务器且未选中项目」时才生成缓存权威键，语义是源端用户级。
  // [契约] 权威键同时传给服务解析与 store 初始化，两处必须一致，否则缓存归属错位。
  // [失败路径] 若在选中项目时也生成权威键，项目写入会被当成用户级缓存处理。
  // [权衡] 键里带来源服务器标识而不是路径，避免同一源端多个路径产生多份缓存。
  // [契约] 无来源服务器时保持未定义，表示按普通工作区语义解析。
  const cacheAuthorityKey =
    settingsSourceServerId && !selectedWorkspace
      ? `source-settings:${settingsSourceServerId}`
      : undefined;
  // [契约] 服务解析的四项入参必须同源：目标路径、远程会话、身份、远程目标。
  // [契约] 无作用域服务与强制无作用域只在源端用户级场景同时为真，二者必须成对。
  // [契约] 解析结果的就绪标志是下方所有请求的门禁，不能只看服务是否存在。
  // [失败路径] 若漏传远程目标，切换到远程工作区后请求会打到本地 host。
  // [权衡] 不使用额外 memo 包裹，hook 内部按参数记忆化。
  const targetServiceResolution = useWorkspaceServicesResolution(
    targetWorkspacePath,
    selectedWorkspace?.remoteSessionId,
    targetWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
    {
      unscopedServices: settingsSourceServerId && !selectedWorkspace ? currentServices : undefined,
      forceUnscoped: Boolean(settingsSourceServerId && !selectedWorkspace),
    },
  );
  // Scope 切到另一个远程 workspace 后，路径已切换但 hooks/plugin 服务仍来自
  // 当前激活 workspace。这里让服务 host 与 target 身份同源，等待连接时不发送越界 RPC。
  const { hooksService: targetHooksService, pluginManagementService } =
    targetServiceResolution.services;
  // [契约] 源端用户级作用域需要把读写强制锁到用户级，不能把源端主目录当成工作区。
  // [契约] hooksService 包装只重写 loadHooks 与 saveHooks 并转发 grantWorkspaceHookTrust，其余能力原样透传。
  // [契约] 包装只在「有来源服务器且当前为用户作用域」时生效，项目作用域直接返回原服务。
  // [失败路径] 若不锁定作用域，保存会覆盖源端工作区的项目配置，而不是用户级配置。
  // [契约] 信任方法只在原服务提供时才转发，避免伪造不存在的能力。
  // [权衡] 每次依赖变化重建包装对象，代价很小，换来作用域语义始终正确。
  const hooksService = useMemo<IHooksService>(() => {
    if (!settingsSourceServerId || activeScope !== "user") return targetHooksService;
    // Bug 原因：Source user scope 需要一个远端路径作 RPC 锚点，但该路径不是 project。
    // 强制 user-only 合同，避免把 Source home 误当 workspace 并覆盖其 .zcode/config.json。
    return {
      loadHooks: (params) => targetHooksService.loadHooks({ ...params, scope: "user" }),
      saveHooks: (params) => targetHooksService.saveHooks({ ...params, scope: "user" }),
      ...(targetHooksService.grantWorkspaceHookTrust
        ? {
            grantWorkspaceHookTrust:
              targetHooksService.grantWorkspaceHookTrust.bind(targetHooksService),
          }
        : {}),
    };
  }, [activeScope, settingsSourceServerId, targetHooksService]);
  // workspace-hook-trust：信任操作绑定到当前选中的 workspace（多 workspace scope 场景
  // 下 review binding 可能属于其他 workspace，此时切换 scope 菜单到对应 workspace）。
  // hooksService 必须传 target 解析结果：scope 选中远程 workspace 时 context 服务指向
  // 激活 tab 的 host，越界 RPC 会打到错误 host。
  // [契约] trustHook 拿到的是 targetWorkspacePath 与 targetWorkspaceIdentity，而不是审核绑定所属的工作区。
  // [契约] 服务参数传解析后的目标服务，作用域选中远程时不能指向激活页签的 host。
  // [契约] 连接未就绪时传空服务，hook 内部据此禁用信任入口。
  // [失败路径] 若传当前上下文服务，越界请求会打到错误 host 并表现为信任失败。
  // [权衡] 权限键与目标解析共用同一个权威键，保证缓存命中同一作用域。
  const { trustActionAvailable, trustingHookId, trustHook } = useWorkspaceHookInlineTrust({
    workspacePath: targetWorkspacePath,
    workspaceIdentity: targetWorkspaceIdentity,
    authorityKey: cacheAuthorityKey,
    hooksService: targetServiceResolution.rpcReady ? hooksService : undefined,
    rpcReady: targetServiceResolution.rpcReady,
  });
  const reviewBindings = useWorkspaceHookReviewStore((state) => state.bindings);

  // [契约] 可编辑分组包含「可编辑」与「只读 zcode」两类，它们都要留在已安装分组。
  // [契约] activeScope 缺省时按 "user" 处理，与上游 hook 配置的默认作用域一致。
  // [失败路径] 若把只读 zcode 排除，这些行既不在已安装也不在兼容分组，用户无法信任它们。
  // [契约] 过滤结果只依赖 store 中的 Hook 列表与当前作用域。
  // [权衡] 两个分组各自独立计算，不做一次分组再拆分，避免中间结构泄漏到渲染层。
  const editableHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          (isEditableHook(hook) || isReadOnlyZCodeHook(hook)) &&
          (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const compatibilityHooks = useMemo(
    () =>
      hooksState.hooks.filter(
        (hook) =>
          isInCompatibilitySection(hook) && (hook.location?.scope ?? "user") === activeScope,
      ),
    [activeScope, hooksState.hooks],
  );
  const pluginHooks = useMemo(
    () => buildPluginHookRows(plugins, installedPlugins, marketplaceAvailabilityKnown),
    [installedPlugins, marketplaceAvailabilityKnown, plugins],
  );
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  // [契约] 插件 Hook 先按作用域过滤，再补上插件图标信息，顺序不能反。
  // [契约] 图标信息来自可用插件的列表映射，查不到时留空由卡片回退。
  // [失败路径] 若先补图标再过滤，被过滤掉的行也会参与映射构造，纯属浪费。
  // [契约] 结果保留原始行的全部字段，只新增图标字段，不修改来源数据。
  // [权衡] 每次依赖变化重建数组，规模是插件 Hook 数量，可以接受。
  const scopedPluginHooks = useMemo(
    () =>
      filterPluginHooksByScope(pluginHooks, activeScope).map((hook) => ({
        ...hook,
        pluginIconItem: {
          name: hook.pluginName,
          listing: pluginListingById.get(hook.pluginId),
        },
      })),
    [activeScope, pluginHooks, pluginListingById],
  );
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredEditableHooks = useMemo(
    () => editableHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [editableHooks, normalizedQuery],
  );
  const filteredCompatibilityHooks = useMemo(
    () => compatibilityHooks.filter((hook) => hookMatchesQuery(hook, normalizedQuery)),
    [compatibilityHooks, normalizedQuery],
  );
  const filteredPluginHooks = useMemo(
    () =>
      scopedPluginHooks.filter((hook) =>
        [
          hook.pluginName,
          hook.detail.event,
          hook.detail.type,
          hook.detail.matcher,
          hook.detail.command,
          hook.detail.sourcePath,
        ].some((value) => value?.toLowerCase().includes(normalizedQuery)),
      ),
    [normalizedQuery, scopedPluginHooks],
  );

  // [并发] 初始化只在连接就绪后执行，未就绪直接返回，不发起任何请求。
  // [契约] 传入目标路径、身份、服务与权威键四项，store 据此判断数据归属。
  // [契约] 依赖包含服务对象与权威键，切换作用域或重连会重新初始化。
  // [失败路径] 若漏掉就绪判断，连接建立前的初始化会以空列表覆盖缓存。
  // [权衡] 不做额外的重复初始化拦截，重复初始化由 store 自身幂等处理。
  useEffect(() => {
    if (!targetServiceResolution.rpcReady) return;
    void hooksState.initialize(
      targetWorkspacePath ?? undefined,
      targetWorkspaceIdentity,
      hooksService,
      cacheAuthorityKey,
    );
  }, [
    hooksService,
    cacheAuthorityKey,
    hooksState.initialize,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  useEffect(() => {
    if (!targetWorkspacePath || !targetServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      authorityKey: cacheAuthorityKey,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    cacheAuthorityKey,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  // [并发] 刷新并行等待 Hook 与插件两条链路，任一失败都会让整体失败。
  // [契约] 未就绪时直接返回，连接中的刷新按钮不应产生请求。
  // [契约] 没有工作区路径时跳过插件初始化，但仍要刷新用户级 Hook。
  // [失败路径] 若串行执行，插件初始化较慢时会拖慢 Hook 列表的可见时间。
  // [权衡] 用并行等待换取更短的刷新窗口，两条链路互不依赖。
  const handleRefresh = useCallback(async () => {
    if (!targetServiceResolution.rpcReady) return;
    await Promise.all([
      hooksState.initialize(
        targetWorkspacePath ?? undefined,
        targetWorkspaceIdentity,
        hooksService,
        cacheAuthorityKey,
      ),
      targetWorkspacePath
        ? initializePlugins({
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            authorityKey: cacheAuthorityKey,
            pluginService: pluginManagementService,
          })
        : Promise.resolve(),
    ]);
  }, [
    hooksService,
    cacheAuthorityKey,
    hooksState.initialize,
    initializePlugins,
    pluginManagementService,
    targetServiceResolution.rpcReady,
    targetWorkspaceIdentity,
    targetWorkspacePath,
  ]);

  useEffect(() => {
    if (
      selectedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => getPluginWorkspaceKey(tab) === selectedScopeKey)
    ) {
      setSelectedScopeKey("user");
    }
  }, [selectedScopeKey, workspaceTabs]);

  // workspace-hook-trust（修复）：会话区对 workspace B 发起审核时，把 scope 菜单
  // 自动切到 B 一次。两条硬约束：
  // 1. 只在「新 interaction 出现」时切——B 的 review 仍 pending 期间用户手动切去
  //    A/User 属于主动选择，不得被持续抢回（否则 pending 期间设置页被锁死在 B）。
  // 2. 目标 workspace 必须仍存在于 workspaceTabs——binding 指向已关闭/断连的
  //    workspace 时切过去只会停在 Connecting，还会与上面的「失效 scope 重置 user」
  //    effect 形成乒乓循环。
  // [契约] 审核绑定的最新目标由纯函数计算，不在渲染中读取 store 快照的其他字段。
  // [契约] 依赖绑定表与页签集合，任一变化都会重算目标。
  // [契约] latestReviewScopeTarget 为空说明 binding 指向已关闭工作区，effect 不得切换 activeScope。
  // [失败路径] 若在这里直接写状态，渲染期更新会触发额外的更新循环。
  // [权衡] 计算结果只作为 effect 的输入，真正切换动作发生在 effect 内。
  // [契约] 输出包含交互标识，供下方的去重引用判断是否已处理过。
  const latestReviewScopeTarget = useMemo(
    () => resolveLatestReviewScopeTarget(reviewBindings, workspaceTabs),
    [reviewBindings, workspaceTabs],
  );
  const handledReviewInteractionRef = useRef<string | null>(null);
  // [契约] 只在出现新的交互标识时切换一次作用域，之后用户手动切换不得被抢回。
  // [契约] 已处理标识存在 ref 里，effect 重跑不会重复触发同一条审核。
  // [契约] 只有目标作用域与当前不同才写入，避免无意义的状态更新。
  // [失败路径] 若去掉去重引用，审核待处理期间用户每次切换作用域都会被拉回。
  // [契约] 目标为空时提前返回，与「失效作用域重置」的 effect 不会形成乒乓。
  // [权衡] 用 ref 而不是 state 记录已处理标识，避免为一次副作用多一轮渲染。
  useEffect(() => {
    if (!latestReviewScopeTarget) return;
    if (handledReviewInteractionRef.current === latestReviewScopeTarget.interactionId) return;
    handledReviewInteractionRef.current = latestReviewScopeTarget.interactionId;
    if (latestReviewScopeTarget.scopeKey !== selectedScopeKey) {
      setSelectedScopeKey(latestReviewScopeTarget.scopeKey);
    }
  }, [latestReviewScopeTarget, selectedScopeKey]);

  const invalidateDraft = useCallback(
    async (reason: string) => {
      await invalidateDeferredDraftSessionForRuntimeChange({
        logScope: "hooks",
        reason,
        workspaceIdentity: targetWorkspaceIdentity,
        workspacePath: targetWorkspacePath,
      });
    },
    [targetWorkspaceIdentity, targetWorkspacePath],
  );

  const handleSaveHook = useCallback(
    async (config: HookConfig) => {
      try {
        if (editingHook) {
          await hooksState.updateHook(editingHook.id, config, hooksService);
          await invalidateDraft("hook-updated");
        } else {
          await hooksState.addHook(config, hooksService);
          await invalidateDraft("hook-added");
        }
        setViewMode("list");
        setEditingHook(null);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [editingHook, hooksService, hooksState.addHook, hooksState.updateHook, invalidateDraft],
  );
  const handleCreateHook = useCallback(() => {
    setEditingHook(null);
    setViewMode("form");
  }, []);

  const handleDelete = useCallback(
    async (hook: Hook) => {
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.hooks.delete" }),
        description: intl.formatMessage(
          { id: "settings.hooks.deleteDescription" },
          { event: hook.event },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) return;
      try {
        await hooksState.deleteHook(hook.id, hooksService);
        await invalidateDraft("hook-deleted");
        setEditingHook(null);
        setViewMode("list");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [confirmDialog, hooksService, hooksState.deleteHook, intl, invalidateDraft],
  );

  const handleToggle = useCallback(
    async (hook: Hook, enabled: boolean) => {
      try {
        await hooksState.toggleHook(hook.id, enabled, hooksService);
        await invalidateDraft(enabled ? "hook-enabled" : "hook-disabled");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.toggleHook, invalidateDraft],
  );

  const handleImport = useCallback(
    async (hook: Hook) => {
      try {
        await hooksState.importHook(hook.id, hooksService);
        await invalidateDraft("hook-imported");
        toast(intl.formatMessage({ id: "settings.hooks.imported" }));
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      }
    },
    [hooksService, hooksState.importHook, intl, invalidateDraft],
  );

  if (viewMode === "form" && targetServiceResolution.rpcReady) {
    return (
      <>
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingHook?.event ?? intl.formatMessage({ id: "settings.hooks.add" }),
            },
          ]}
          onSectionSelect={() => {
            setEditingHook(null);
            setViewMode("list");
          }}
        />
        <SettingsUserScopeProvider
          target={{ workspaceIdentity }}
          sourceServerId={settingsSourceServerId}
        >
          <HookForm
            hook={editingHook ?? undefined}
            workspaceAvailable={Boolean(targetWorkspacePath)}
            defaultStorageLevel={activeScope}
            selectedScopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
            onSave={handleSaveHook}
            onDelete={editingHook ? handleDelete : undefined}
            onCancel={() => {
              setEditingHook(null);
              setViewMode("list");
            }}
            isEditing={Boolean(editingHook)}
          />
        </SettingsUserScopeProvider>
      </>
    );
  }

  const loading = hooksState.loading || pluginsLoading;
  const error = hooksState.error || pluginsError;
  const visibleCount =
    filteredEditableHooks.length + filteredCompatibilityHooks.length + filteredPluginHooks.length;
  const totalCount = editableHooks.length + compatibilityHooks.length + scopedPluginHooks.length;
  const hasSearchResultEmpty = Boolean(normalizedQuery) && visibleCount === 0;
  const showWorkspaceHookTrustNotice = shouldShowWorkspaceHookTrustNotice({
    hooks: editableHooks,
    loadedWorkspaceKey: hooksState.loadedWorkspaceKey,
    rpcReady: targetServiceResolution.rpcReady,
    targetWorkspaceKey,
  });
  return (
    <div className="space-y-6" data-testid="hooks-settings-section">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PluginScopeMenu
            userTarget={{ workspaceIdentity }}
            userSourceServerId={settingsSourceServerId}
            align="start"
            selectedScopeKey={selectedScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={setSelectedScopeKey}
          />
          <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
          <div
            data-independent-capability-count="true"
            className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
          >
            <span>{intl.formatMessage({ id: "settings.hooks.title" })}</span>
            <span className="text-ui-sm text-foreground-subtle">{visibleCount}</span>
          </div>
        </div>
        <SettingsSearchInput
          containerClassName="w-full sm:ml-auto sm:w-64"
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          value={query}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.hooks.searchPlaceholder",
          })}
        />
      </div>

      {showWorkspaceHookTrustNotice ? <WorkspaceHookTrustNotice hooks={editableHooks} /> : null}

      {targetServiceResolution.rpcReady && error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!targetServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading && totalCount === 0 ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasSearchResultEmpty ? (
        <PluginSearchEmptyState label={intl.formatMessage({ id: "settings.hooks.searchEmpty" })} />
      ) : (
        <HooksList
          compatibilityHooks={filteredCompatibilityHooks}
          editableHooks={filteredEditableHooks}
          operatingHookId={hooksState.operatingHookId}
          pluginHooks={filteredPluginHooks}
          showInstalledSection={!normalizedQuery}
          installedEmptyTitle={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledTitle",
          })}
          installedEmptyDescription={intl.formatMessage({
            id: "settings.plugin.hooks.emptyInstalledDescription",
          })}
          installedEmptyActions={
            <Button type="button" variant="default" size="lg" onClick={handleCreateHook}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.hooks.add" })}
            </Button>
          }
          installedAction={
            <SettingsResourceHeaderActions
              onRefresh={() => void handleRefresh()}
              onNew={handleCreateHook}
              newActionId="settings.hooks.add"
            />
          }
          formatPluginName={(name, pluginId) =>
            resolvePluginDisplayName(
              {
                name,
                listing:
                  (pluginId ? pluginListingById.get(pluginId) : undefined) ??
                  resolveUniquePluginListingByName(availablePlugins, name),
              },
              locale,
            )
          }
          onEdit={(target) => {
            setEditingHook(target);
            setViewMode("form");
          }}
          onImport={handleImport}
          onTrust={trustHook}
          trustActionAvailable={trustActionAvailable}
          trustingHookId={trustingHookId}
          onToggle={handleToggle}
        />
      )}
    </div>
  );
}

function hookMatchesQuery(hook: Hook, normalizedQuery: string): boolean {
  if (!normalizedQuery) {
    return true;
  }
  return [
    hook.event,
    hook.type,
    hook.matcher,
    hook.command,
    ...(hook.args ?? []),
    hook.location?.directoryPath,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}
