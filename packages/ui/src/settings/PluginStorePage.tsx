// ============================================================================
// 文件头：职责边界与不变量（INV）
// ============================================================================
//
// 【职责边界】
// - 插件商店容器：只编排列表/详情/管理三种视图、市场源对话框、卸载确认与试用跳转；
//   数据与写操作一律委托 pluginManagementStore 与 plugin service，不在页面里另存状态。
// - 所有平台能力经 usePlatform / useServices 注入，不直接触碰 window.zcode。
//
// 【不变量 INV】
// INV-01 服务实例只从 useServices/usePlatform 获取；直接 import 实现会绕过注入，
//   Web 与 Desktop 行为分叉且测试无法替换。
// INV-02 跨域去重键统一为 workspaceIdentity?.trim() || workspacePath；
//   只比较 workspacePath 会让同一远程工作区被当成两个作用域。
// INV-03 initialize 必须带完整依赖数组（initialize/pluginService/workspace-*）；
//   漏依赖会让切换工作区后仍展示上一个工作区的插件。
// INV-04 页面状态只来自 scoped store 的 selector；在组件里再复制一份 installedPlugins
//   会出现「列表已更新、详情仍旧」的双份事实。
// INV-05 安装/卸载/更新成功后必须走 refreshAfterPluginChange；跳过会让草稿会话
//   继续持有旧 Skill/Command/MCP 定义。
// INV-06 安装/更新失败时不得失效草稿运行时；无差别 refresh 会误伤正在编辑的会话。
// INV-07 进入详情前记录 storeScrollTopRef，返回时恢复；丢掉它会让用户每次返回都回顶部。
// INV-08 详情条目从 itemById 消失时必须回到列表；否则渲染空详情并停留在不可用路由。
// INV-09 官方市场自动刷新必须经 claimMarketplaceAutoRefresh 节流占位；绕过会让每次
//   重挂载都打一次 CDN，且并发请求互相覆盖。
// INV-10 marketing 导航必须以 finishMarketingNavigation 结束且只结束一次；
//   漏结束会让营销入口一直等待，重复结束会覆盖首次结果。
// INV-11 曝光埋点用 IntersectionObserver 的 visible 边沿触发，且卸载时 disconnect；
//   去掉边沿判断会在滚动中重复上报。
// INV-12 addSourceOpen 为 true 时不渲染全局错误条：否则错误被 Dialog 遮罩压住，
//   用户在提交处看不到失败原因。
// INV-13 embedded 模式不消费导航目标、不渲染面包屑，且只在会话内市场提供「打开 UI」。
// INV-14 actions 的所有回调与依赖必须同步进 useMemo 依赖数组；漏项会让卡片按钮
//   指向旧的 workspace/scope 闭包。
// INV-15 列表用 hidden 隐藏而非卸载：保留滚动位置与已加载状态，避免切回列表时闪白。
// INV-16 启停插件必须用 workspace scope；用 user scope 会改到其他项目的生效配置。
import { withPluginTelemetry } from "@zcode/services";
import { usePlatform } from "@/hooks/usePlatform.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
/* eslint-disable max-lines -- 插件商店容器统一编排列表/详情、市场源对话框、卸载确认、试用跳转与技能刷新收尾，集中维护保证交互一致。 */
import { PluginAddMenu } from "@/conversation-workspace-target/PluginAddMenu.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { marketingNavigation, finishMarketingNavigation } from "@/lib/marketingNavigation.js";
import { ArrowLeft, RefreshCw, Store } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useScopedPluginManagementStore } from "@/store/pluginManagementStore.js";
import { useMarketPluginUi } from "@/plugin-ui/index.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { resolvePluginUiSurfaceTitle } from "@/plugin-ui/index.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import {
  PluginDetailRow,
  PluginHookDetails,
  PluginWarningList,
} from "@/settings/InstalledPluginManagement.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import { PluginStoreListView, type PluginStoreSegment } from "@/settings/PluginStoreListView.js";
import {
  PluginStoreAdvancedSection,
  PluginStoreDetailView,
} from "@/settings/PluginStoreDetailView.js";
import { PluginStoreSourcesDialog } from "@/settings/PluginStoreSourcesDialog.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import {
  buildStoreItems,
  canUpdatePluginItem,
  isPluginUpdatePending,
  resolveItemDisplayName,
  resolvePluginDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { PluginUninstallConfirmDialog } from "@/settings/PluginUninstallConfirmDialog.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import { claimMarketplaceAutoRefresh } from "@/settings/officialMarketplaceAutoRefresh.js";
import { consumePluginStoreOpenTarget } from "@/lib/pluginStoreNavigation.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";

// [契约] 平台差异用显式 props 注入（isDesktop/isMacDesktop/isWindowsDesktop），
// 不在组件内读全局平台常量，保证同一组件可在 Web/桌面/远控下渲染。
// onCreateTask 由 Root 提供，本页不自行创建会话。
interface PluginStorePageProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  sessionId?: string | null;
  remoteSessionId?: string | null;
  embedded?: boolean;
  onBack?: () => void;
}

type PluginStoreView = "store" | "detail" | "manage";

// [契约] 所有 entry 相关 props 均有安全默认值，保证直接渲染不传参也不会崩；
// embedded 默认为 false，因为主导航市场是默认形态。
// 新增 prop 时保持可选，避免所有调用点被迫同步改动。
export function PluginStorePage({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  isWebRemoteControl = false,
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  sessionId,
  remoteSessionId,
  embedded = false,
  onBack,
}: PluginStorePageProps) {
  // [契约] 平台能力只经此注入实例使用；埋点等副作用需要的也是这个实例，
  // 不要在回调里另取 window 上的平台对象。
  // 该值参与 IntersectionObserver effect 依赖，切换平台时会重建观察器。
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const { order: storeOrder, refresh: refreshStoreOrder } = usePluginStoreOrder();
  const { pluginManagementService, skillsService } = useServices();
  const usePluginManagementStore = useScopedPluginManagementStore(pluginManagementService);
  // [契约] UI surface 的打开/选择状态由专用 hook 管理，页面只消费 surfaces 与 open；
  // 自己维护一份选中 surface 会与 hook 内部状态竞争。
  // workspace/session/remoteSession 四个键决定 UI 归属，缺一个就会落到错误会话。
  // surfaces 长度大于 1 时才弹选择框，单选时直接打开。
  const pluginUi = useMarketPluginUi({
    workspacePath,
    workspaceIdentity,
    sessionId,
    remoteSessionId,
  });
  // [契约] 管理视图的作用域是纯 UI 记忆（用户/工作区切换），不写入 store；
  // 默认 user 与「安装属于 Host User inventory」的语义一致。
  // 该值只透传给 PluginsSection 的 initialScopeKey。
  const [managementScope, setManagementScope] = useState("user");
  // [契约] 每个字段独立 selector 订阅，避免整个 store 变化导致整页重渲染；
  // 合并成对象 selector 需要浅比较，容易引入无效渲染。
  // 这些字段都是只读投影，写入必须调用下方 action。
  const plugins = usePluginManagementStore((state) => state.plugins);
  // [契约] 诊断是全量列表，页面只按详情条目过滤，不在 store 侧按插件切片；
  // 因为管理视图也需要完整诊断。
  // 新增诊断类别时保持 severity 语义，warn 以上才在详情展示。
  const pluginDiagnostics = usePluginManagementStore((state) => state.diagnostics);
  const marketplaces = usePluginManagementStore((state) => state.marketplaces);
  const marketplaceAvailabilityKnown = usePluginManagementStore(
    (state) => state.marketplaceAvailabilityKnown,
  );
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const restorableBuiltins = usePluginManagementStore((state) => state.restorableBuiltins);
  const loading = usePluginManagementStore((state) => state.loading);
  const loadedWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const loadedWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const error = usePluginManagementStore((state) => state.error);
  const activeOperations = usePluginManagementStore((state) => state.activeOperations);
  const describeCache = usePluginManagementStore((state) => state.describeCache);
  const initialize = usePluginManagementStore((state) => state.initialize);
  const updateMarketplace = usePluginManagementStore((state) => state.updateMarketplace);
  const addMarketplace = usePluginManagementStore((state) => state.addMarketplace);
  const removeMarketplace = usePluginManagementStore((state) => state.removeMarketplace);
  const installPlugin = usePluginManagementStore((state) => state.installPlugin);
  const describePlugin = usePluginManagementStore((state) => state.describePlugin);
  const updatePlugin = usePluginManagementStore((state) => state.updatePlugin);
  const restoreBuiltin = usePluginManagementStore((state) => state.restoreBuiltin);
  const setEnabled = usePluginManagementStore((state) => state.setEnabled);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);

  // [契约] 三视图是互斥的本地路由状态，不写 URL：设置页内切换不产生历史记录。
  // 外部（营销入口/打开目标）只能通过 effect 驱动它，不能直接读取。
  const [view, setView] = useState<PluginStoreView>("store");
  // [契约] 所有写操作统一包一层 telemetry，entry/client_kind 在调用时定型，
  // 保证埋点与真实入口一致，而不是由各按钮各自上报。
  // [权衡] 依赖 view 会让切换视图时重建 service 包装；这是有意的，因为 entry
  // 取值依赖当前视图，复用旧实例会报错误的入口。
  const operationService = useMemo(() => {
    // [契约] entry 与 client_kind 在包装时定型并随服务实例一起缓存，
    // 埋点因此反映「用户从哪个入口发起」，而不是上报时的当前视图。
    // isWebRemoteControl 为真即 mobile：远控页面与桌面客户端的漏斗分开统计。
    const telemetry = {
      entry: embedded
        ? ("side_pane_market" as const)
        : view === "detail"
          ? ("store_detail" as const)
          : ("store_list" as const),
      client_kind: isWebRemoteControl ? ("mobile" as const) : ("desktop" as const),
    };
    return withPluginTelemetry(pluginManagementService, telemetry);
  }, [pluginManagementService, embedded, isWebRemoteControl, view]);

  // [契约] 详情用 id 而不是 item 对象：条目可能因刷新被替换，持有对象会渲染旧数据。
  // 因此 detailItem 必须每帧从 itemById 重新查，见下方派生。
  const [detailPluginId, setDetailPluginId] = useState<string | null>(null);
  // [契约] 分段（public/personal）是纯展示过滤，初始为 public；
  // 添加自定义源成功后强制切到 personal，否则用户看不到刚加的源。
  // 该状态不持久化，重新进入商店回到默认分段。
  const [segment, setSegment] = useState<PluginStoreSegment>("public");
  // [契约] 搜索词是本地 UI 状态，不写入 store：刷新列表不应清空用户输入，
  // 但重新进入商店会重置。
  // 营销导航未命中插件时会用它填入 stable id，形成可解释的空结果。
  const [query, setQuery] = useState("");
  // [并发] refreshing 既是按钮禁用条件也是 loading 文案来源，
  // 避免用户在请求在飞时重复触发 updateMarketplace 全量拉取。
  // 它只覆盖顶栏刷新，市场更新中的状态另由 activeOperations 表达。
  const [refreshing, setRefreshing] = useState(false);
  // [契约] `marketSourceDialogOpen` 由页面持有，弹窗只受控并在关闭时回报。
  // 关闭时不做额外清理，源列表是 store 派生的。
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // [契约] 添加源弹窗与 sources 弹窗并列，二者可同时存在但互不依赖；
  // 打开前必须清空 addMarketplaceError，见下方按钮与导航分支。
  // 该状态同时被 error 渲染条件引用（Dialog 遮罩问题）。
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  // [契约] 添加市场源的错误单独存放，因为 Dialog 打开时全局错误条被遮罩挡住；
  // 关闭/重新打开弹窗时必须清空，否则会残留上一次失败文案。
  // 成功时置 null，保证「失败→重试成功」后不显示旧错误。
  const [addMarketplaceError, setAddMarketplaceError] = useState<string | null>(null);
  // [契约] 根节点 ref 同时服务于滚动容器查找与可见性观察，只挂根 div，
  // 不要挂到内部列表项上，否则观察器会随列表重建。
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 返回列表页时恢复进入详情前的滚动位置（设置页 main 容器滚动）。
  // [契约] 滚动位置存 ref 而非 state：它不参与渲染，写 state 会让每次进出详情多一轮渲染。
  // 只在 openDetail 写入、backToStore 读取；其他路径（如外部导航）不应覆盖它。
  const storeScrollTopRef = useRef(0);
  // [契约] 打开目标只在首次挂载时消费一次（useState 惰性初始化），后续重渲染不重复读取；
  // embedded 模式直接忽略，因为侧边市场没有独立的导航目标。
  // 该值同时存入 ref 供初始化 effect 使用，避免 effect 依赖变化导致重复执行。
  const [initialNavigationTarget] = useState(() =>
    embedded ? null : consumePluginStoreOpenTarget(),
  );
  // [契约] ref 用于「消费一次」语义：effect 处理完立即置 null，
  // 即使依赖变化再次执行也不会重复打开同一个插件。
  // 不要改成 state，置 null 会触发额外渲染并可能打断导航动画。
  const initialNavigationTargetRef = useRef(initialNavigationTarget);
  useEffect(() => {
    // [契约] intent 只有 add-marketplace 时需要自动开弹窗，其余目标由下面的
    // 插件 id effect 处理；两个 effect 分工明确，不要合并。
    // 此处只依赖 initialNavigationTarget，值在挂载后不变，因此只执行一次。
    if (initialNavigationTarget?.intent === "add-marketplace") setAddSourceOpen(true);
  }, [initialNavigationTarget]);

  // [契约] 归一一次并全页复用，确保与 store 的 loadedWorkspaceIdentity 可比；
  // 各处临时 trim 会出现「看起来相等但比较失败」的问题。
  // 空串归一为 null，与「未提供 identity」保持同一语义。
  const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;

  useEffect(() => {
    if (!workspacePath) {
      return;
    }
    // 安装仍属于 Host User inventory；卡片启停展示当前项目的实际生效配置。
    // [契约] 无 workspacePath 时不初始化，避免把商店绑定到空工作区。
    // 显式把 pluginService 传进去，使 store 的 action 不依赖全局单例；
    // void 表示不等待：加载态由 store 的 loading 字段驱动。
    // [并发] 每次依赖变化都会重新 initialize，store 内部需自行去重。
    void initialize({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [initialize, pluginManagementService, workspaceIdentity, workspacePath]);

  // 目录自动刷新（Catalog Auto-Refresh）：只针对 ZCode 官方市场。每次进入商店页都刷新 CDN 目录，
  // 否则新上架插件要等用户手动点刷新才可见；以 10 分钟窗口节流，并在发起时占位防抖（失败/在飞不重复），
  // 判据见 officialMarketplaceAutoRefresh。状态放模块级而非组件 ref，因为每次进入都是重新挂载。
  useEffect(() => {
    // [契约] 自动刷新只针对官方市场；自定义源可能在 git 上，自动拉取会放大网络与鉴权风险。
    // 必须先在已加载的 marketplaces 中找到该源，找不到说明列表未就绪，本次跳过。
    // claimMarketplaceAutoRefresh 用 lastUpdated 做 10 分钟节流，见下方 effect。
    const official = marketplaces.find((item) => item.id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID);
    if (
      official &&
      claimMarketplaceAutoRefresh(ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, official.lastUpdated)
    ) {
      void updateMarketplace(
        ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
        withPluginTelemetry(pluginManagementService, {
          trigger: "automatic",
          client_kind: isWebRemoteControl ? "mobile" : "desktop",
        }),
      );
    }
  }, [marketplaces, isWebRemoteControl, pluginManagementService, updateMarketplace]);

  // [契约] 列表条目由六个来源纯函数合并（市场/可用/已安装/运行时/可恢复内置），
  // 不要在渲染中做二次过滤，过滤口径属于 buildStoreItems 的职责。
  // 依赖必须列全：漏 marketplaceAvailabilityKnown 会把「未知」误判为「无」。
  const items = useMemo(
    () =>
      buildStoreItems({
        marketplaces,
        marketplaceAvailabilityKnown,
        availablePlugins,
        installedPlugins,
        plugins,
        restorableBuiltins,
      }),
    [
      availablePlugins,
      installedPlugins,
      marketplaceAvailabilityKnown,
      marketplaces,
      plugins,
      restorableBuiltins,
    ],
  );
  // [契约] id 索引只在 items 变化时重建，供详情、卸载确认与营销导航 O(1) 查找；
  // 不要在渲染里 items.find，列表规模变大后会成为热点。
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  // [契约] 详情条目每帧从索引重查，刷新后自动拿到新对象；
  // 返回 null 是合法状态（条目被移除），由下方 effect 负责退回列表。
  const detailItem = detailPluginId ? (itemById.get(detailPluginId) ?? null) : null;
  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  // [契约] 营销导航只在「当前活动 tab 就是目标工作区」时才完成，否则用户会被
  // 悄悄切走上下文。
  // 比较键与全页保持一致：workspaceIdentity?.trim() || workspacePath。
  // tab store 可选，未挂载 Provider 时返回 undefined，不应抛错。
  const isMarketingDestinationVisible = useOptionalTabStore((state) => {
    const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
    return Boolean(
      tab &&
      isWorkspaceTab(tab) &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
        (workspaceIdentity?.trim() || workspacePath),
    );
  });
  useEffect(() => {
    // [契约] 曝光观察只在商店/详情视图生效，manage 视图不上报，避免把管理操作算作发现。
    // 环境不支持 IntersectionObserver 时直接返回，不做降级上报，防止重复计数。
    const root = rootRef.current;
    if (!root || view === "manage" || typeof IntersectionObserver === "undefined") return;
    let visible = false;
    // [并发] 用 visible 做边沿检测：进入视口只上报一次，持续可见不重复；
    // 离开后再进入才重新上报。
    // [资源] 回调里调用 reportAppTelemetryEvent 用 void，不阻塞观察器；
    // 上报失败被吞掉是有意的，埋点不能影响功能。
    const observer = new IntersectionObserver(([entry]) => {
      const next = Boolean(entry?.isIntersecting);
      if (next && !visible) {
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "plugin_discovery",
            eventRegion: "app",
            eventType: "view",
            eventExtraDetail: {
              schema_version: "1",
              action: view === "detail" ? "detail_view" : "store_view",
              entry: embedded
                ? "side_pane_market"
                : view === "detail"
                  ? "store_detail"
                  : "store_list",
              client_kind: isWebRemoteControl ? "mobile" : "desktop",
              ...(view === "detail" && detailPluginId ? { plugin_id: detailPluginId } : {}),
            },
          },
          "plugin-discovery",
        );
      }
      visible = next;
    });
    // [资源] effect 返回 disconnect，视图或依赖变化时立即释放观察器；
    // 漏掉会造成观察器累积并在卸载后继续持有 DOM。
    // root 为空时已提前返回，这里可安全 observe。
    observer.observe(root);
    return () => observer.disconnect();
  }, [platform, view, detailPluginId, embedded, isWebRemoteControl]);
  useEffect(() => {
    // [契约] 只有主导航市场响应营销导航；embedded 侧边市场不参与全局导航。
    // target.page 不是 plugin_marketplace 时保持请求挂起，由其它页面处理。
    if (embedded || marketingRequest?.target.page !== "plugin_marketplace") return;
    // [契约] 非当前 tab 时直接返回且不结束请求：等用户切到该 tab 后 effect 再执行。
    // 若在这里 finish，用户会在别的上下文里丢失跳转。
    if (!isMarketingDestinationVisible) return;
    // [契约] plugin_id 可缺省：缺省表示只要求打开插件市场列表，而不是某个详情。
    // 该值只用于比较与查找，不参与渲染；未命中时回退为搜索 stable id。
    const pluginId = marketingRequest.target.plugin_id;
    // [契约] 无工作区时整页降级为提示文案，不渲染列表与动作；
    // 此时不能调用任何 store action，否则会写进空作用域。
    // 该分支在 hooks 之后，保证 hooks 顺序稳定。
    if (!workspacePath) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_navigation_unavailable"));
      return;
    }
    if (
      loading ||
      loadedWorkspacePath !== workspacePath ||
      loadedWorkspaceIdentity !== normalizedWorkspaceIdentity
    )
      return;
    // [失败路径] 加载失败或目标插件不存在时以错误结束导航，让入口得到明确结果；
    // 不留在 pending，否则营销入口会一直等待。
    // 错误码 marketing_plugin_unavailable 是稳定的对外契约，不要改成自由文本。
    if (error || (pluginId && !itemById.has(pluginId))) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_plugin_unavailable"));
    } else if (pluginId ? view === "detail" && detailPluginId === pluginId : view === "store") {
      finishMarketingNavigation(marketingRequest.id);
    } else {
      setDetailPluginId(pluginId ?? null);
      setView(pluginId ? "detail" : "store");
      setQuery("");
    }
  }, [
    embedded,
    marketingRequest,
    isMarketingDestinationVisible,
    workspacePath,
    loading,
    loadedWorkspacePath,
    loadedWorkspaceIdentity,
    normalizedWorkspaceIdentity,
    error,
    itemById,
    view,
    detailPluginId,
  ]);
  // 插件自身 warning 诊断（如声明的技能路径扫描为空）：详情高级区展示，避免静默失败。
  // [契约] 详情警告只取 severity=warning 且同 pluginId 的诊断，
  // 错误级诊断由全局错误条负责，混进详情会让同一问题展示两次。
  const detailPluginInfo = detailItem?.info;
  // [契约] 诊断按 pluginId + severity 过滤，且只在有运行时信息时计算；
  // info 为空时不展示警告区，因为此时诊断可能尚未加载。
  // 结果用于详情高级区，不能提升为全局错误条，否则离开详情就消失。
  const detailPluginWarnings = detailPluginInfo
    ? pluginDiagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === detailPluginInfo.id && diagnostic.severity === "warning",
      )
    : [];

  // 详情页数据补齐：无运行时信息的条目（未安装候选）按需 describe，拿组件清单 + manifest 回退字段。
  useEffect(() => {
    // [契约] 仅对「详情视图 + 条目存在 + 尚无运行时信息」的候选按需 describe；
    // 用 detailItem.info 判断而不是 installed，因为未安装候选也可能有描述。
    // [并发] describe 结果写入 store 的 describeCache，重复请求由 store 合并。
    if (view !== "detail" || !detailItem || detailItem.info) return;
    void describePlugin(
      detailItem.id,
      detailItem.name,
      detailItem.marketplace,
      pluginManagementService,
    );
  }, [describePlugin, detailItem, pluginManagementService, view]);

  // 详情条目消失（卸载可恢复内置后 restorable 记录被移除等）时回到列表，避免空详情。
  useEffect(() => {
    if (view === "detail" && detailPluginId && !itemById.has(detailPluginId)) {
      setView("store");
      setDetailPluginId(null);
    }
  }, [detailPluginId, itemById, view]);

  // [契约] 滚动容器是设置页的 main，而不是组件自身；
  // 改为 rootRef.current 会恢复错误容器的滚动位置。
  // 取不到时返回 null，调用方按无操作处理，不抛错。
  const scrollContainer = (): HTMLElement | null => rootRef.current?.closest("main") ?? null;

  // [契约] 进入详情前记录当前滚动位置，并把自己的滚动重置到顶部；
  // 两个动作必须成对，否则返回时恢复的是详情页的位置。
  // requestAnimationFrame 保证在布局提交后再改 scrollTop，否则会被
  // 同一帧的列表渲染覆盖。
  const openDetail = useCallback((pluginId: string) => {
    storeScrollTopRef.current =
      (rootRef.current?.closest("main") as HTMLElement | null)?.scrollTop ?? 0;
    setDetailPluginId(pluginId);
    setView("detail");
    requestAnimationFrame(() => {
      const main = rootRef.current?.closest("main");
      if (main) main.scrollTop = 0;
    });
  }, []);

  useEffect(() => {
    const target = initialNavigationTargetRef.current;
    if (
      !target?.pluginId ||
      loading ||
      loadedWorkspacePath !== workspacePath ||
      loadedWorkspaceIdentity !== normalizedWorkspaceIdentity
    ) {
      return;
    }
    // [契约] 在处理前先置 null，保证「已消费」与后续判断解耦；
    // 即使下面的分支提前返回，也不会再次尝试打开同一目标。
    initialNavigationTargetRef.current = null;
    // [失败路径] 目标存在才打开详情；不存在时回退为以 stable id 搜索，
    // 让用户看到明确空结果，而不是渲染错误详情或静默失败。
    // 回退路径同时把视图切回 store，避免停留在旧详情。
    if (itemById.has(target.pluginId)) {
      openDetail(target.pluginId);
      return;
    }
    // 刷新后候选仍不存在时保留 stable ID 搜索，让用户看到明确的空结果而不是错误详情。
    setView("store");
    setQuery(target.pluginId);
  }, [
    itemById,
    loadedWorkspaceIdentity,
    loadedWorkspacePath,
    loading,
    normalizedWorkspaceIdentity,
    openDetail,
    workspacePath,
  ]);

  // [契约] 返回列表时先切视图与清 id，再在下一帧恢复滚动；顺序反过来会记录到详情页位置。
  // 依赖数组为空是安全的：只读 ref 与稳定 setter。
  const backToStore = useCallback(() => {
    setView("store");
    setDetailPluginId(null);
    requestAnimationFrame(() => {
      const main = scrollContainer();
      if (main) main.scrollTop = storeScrollTopRef.current;
    });
  }, []);

  // 顶栏刷新 = 真网络更新：updateMarketplace(null) 重拉全部市场 manifest（含 CDN 与 git 源，
  // 操作内部完成后会重载概览），随后按更新徽标数量给完成提示。只做本地重载时，
  // 用户点了刷新看不到 CDN 新插件（与规格「刷新→update(null)」不符）。
  // [契约] 顶栏刷新是网络更新：先刷新排序，再 updateMarketplace(null) 重拉全部 manifest。
  // [资源] refreshing 置 true 后再 await，finally 复位；不放在 try 前是为了
  // 让同步抛错也能正确收尾。
  // 只做本地重载会让用户看不到 CDN 新插件，与规格不符。
  const handleRefresh = async () => {
    void refreshStoreOrder(true);
    setRefreshing(true);
    try {
      await handleCheckForUpdates();
    } finally {
      setRefreshing(false);
    }
  };

  // 插件 package 变更（安装 / 卸载 / 更新）后统一收尾：失效草稿会话并刷新技能，
  // 避免会话里残留悬挂或旧版本能力。
  // [契约] 插件包变更后的统一收尾：先失效草稿会话，再刷新共享技能库。
  // 顺序不能反：先刷新技能会让旧会话短暂持有半新半旧的技能表。
  // [失败路径] 两个 await 都会向上抛，由调用方决定是否提示；这里不吞错。
  const refreshAfterPluginChange = useCallback(async () => {
    await invalidateDeferredDraftSessionForSkillChange({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity ?? undefined,
      reason: "settings-plugin-enabled",
    });
    await refreshSharedSkillStoreForWorkspace({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      skillsService,
    });
  }, [normalizedWorkspaceIdentity, skillsService, workspacePath]);

  // [契约] 卸载流程（确认弹窗、进行中态、错误）全部在 hook 内，页面只接返回值；
  // 自己实现一份会让两处状态不同步。
  // onAfterUninstall 复用 refreshAfterPluginChange，保证卸载后能力立刻失效。
  // store 传入的是 scoped hook，不是全局 store，避免跨工作区串状态。
  const uninstall = usePluginUninstall({
    store: usePluginManagementStore,
    pluginService: operationService,
    installedPlugins,
    plugins,
    activeOperations,
    onAfterUninstall: async () => {
      await refreshAfterPluginChange();
    },
  });

  // [契约] restorable 条目走 restoreBuiltin，其余走 installPlugin；
  // 两者失败语义一致，都以布尔返回，不抛错。
  // [失败路径] succeeded=false（含目标已切换）时不失效草稿运行时：
  // 否则用户正在编辑的内容会因为一次失败安装被清空能力。
  const handleInstall = useCallback(
    async (item: StorePluginItem) => {
      // [契约] 可恢复内置走 restoreBuiltin，普通插件走 installPlugin，两者都返回布尔；
      // 用三元而不是两次 if，保证「恢复失败」不会被误当成「安装成功」。
      // installPlugin 的 scope 固定 user：安装属于 Host 级 inventory。
      const succeeded = item.restorable
        ? await restoreBuiltin(item.id, operationService)
        : await installPlugin(item.name, item.marketplace, operationService, "user");
      // 失败或目标已切换时没有可交付的新能力，不能失效草稿运行时。
      if (!succeeded) return;
      await refreshAfterPluginChange();
    },
    [installPlugin, operationService, refreshAfterPluginChange, restoreBuiltin],
  );

  // [契约] 更新成功后必须刷新技能与草稿会话：升级会同时替换 Skill/Command/MCP 定义。
  // [失败路径] 用 store.getState().error 判失败而不是返回值，是因为不能只看
  // 单个 action 的返回，错误可能来自前置步骤。
  // 确认失败后直接 return，跳过刷新，避免把失败当成功处理。
  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      // [契约] 更新使用带 telemetry 的 operationService，而不是原始 service，
      // 保证商店入口的操作都能被统计。
      // [失败路径] 该调用不抛错，失败通过 store.error 表达，见下方判断。
      await updatePlugin(pluginId, operationService);
      if (usePluginManagementStore.getState().error) {
        return;
      }
      // 升级会同时替换 Skill、Command 与 MCP 定义；旧入口只刷新商店列表，
      // 已预热的草稿 session 继续携带旧版本甚至空能力，导致“升级成功”后新会话仍不可用。
      await refreshAfterPluginChange();
    },
    [operationService, refreshAfterPluginChange, updatePlugin],
  );

  // [契约] 这是「检查更新」的唯一实现：updateMarketplace(null) 拉全部源，
  // 失败时用 store 中的错误文本提示一次，不重复 toast。
  // 成功时按 isPluginUpdatePending 统计待更新数，0 与 >0 给不同文案。
  // [契约] 统计读的是 getState() 的最新快照，render 期闭包可能已过期。
  const handleCheckForUpdates = useCallback(async () => {
    // [契约] 传 null 表示重拉全部市场源（含 CDN 与 git），是「检查更新」的唯一正确入口；
    // 传具体 id 只会刷新单个源，漏掉其他源的新版本。
    // 返回值只表达成败，具体错误文本需从 store 读取。
    const succeeded = await updateMarketplace(null, operationService);
    if (!succeeded) {
      const message = usePluginManagementStore.getState().error;
      if (message) {
        toast(message);
      }
      return;
    }
    // [契约] 待更新数从 getState() 的最新快照统计，不能用渲染期闭包里的 installedPlugins；
    // await 之后组件可能已重渲染，闭包值是旧的。
    // 只统计 update-available 状态，pending/running 不算待更新。
    const pendingCount = usePluginManagementStore
      .getState()
      .installedPlugins.filter((item) => isPluginUpdatePending(item.updateStatus)).length;
    if (pendingCount > 0) {
      toast(
        intl.formatMessage(
          { id: "settings.plugins.checkForUpdates.found" },
          { count: String(pendingCount) },
        ),
      );
      return;
    }
    toast(intl.formatMessage({ id: "settings.plugins.checkForUpdates.none" }));
  }, [intl, operationService, updateMarketplace]);

  // [契约] 返回布尔给 Dialog 决定是否关闭，因此不能在失败时提前 return。
  // [失败路径] 错误写进本地 addMarketplaceError 而不是只依赖全局 error：
  // Dialog 打开时全局错误条会被遮罩压住。
  // 成功后切到 personal 分段，让用户立刻看到新增来源。
  const handleAddMarketplace = useCallback(
    async (source: string) => {
      // [契约] 添加源的成败只由返回值判断，错误文本随后从 store 读取；
      // 不要用 try/catch 包裹，store action 内部已归一错误。
      const succeeded = await addMarketplace(source, operationService);
      // 添加市场源的错误要和提交入口同层展示；否则全局错误条会被 Dialog 遮罩压到下面。
      setAddMarketplaceError(
        succeeded ? null : (usePluginManagementStore.getState().error ?? null),
      );
      // 自定义市场不属于公开分段；添加成功后直接切到「个人」，让用户立刻看到刚加的来源。
      // [契约] 只有成功才切分段：失败时留在原分段，避免用户误以为已添加。
      // personal 对应自定义源列表，切过去能立刻看到结果。
      if (succeeded) setSegment("personal");
      return succeeded;
    },
    [addMarketplace, operationService],
  );

  // [契约] 未安装时先引导安装，不新建会话：避免用空插件创建无效任务。
  // 缺少 workspacePath 或 onCreateTask 时静默返回，不弹错误。
  // [契约] 新建任务统一委托 Root（onCreateTask），本页不直接写 session store，
  // 否则 Settings 遮罩不退出且 composer 可能覆盖预填内容。
  const handleUsePrompt = useCallback(
    (item: StorePluginItem, prompt: string) => {
      // 未安装时点提示词先引导安装，不新建会话。
      // [契约] 未安装条目的「试用」先安装再让用户重新点击，不在同一个动作里隐式安装并建任务；
      // 隐式安装会让用户在没有确认的情况下改变本地环境。
      // 这里用 void 调用，不等待结果，安装进度由卡片状态展示。
      if (!item.installed) {
        void handleInstall(item);
        return;
      }
      // [失败路径] 缺少工作区或创建回调时静默返回：两者都是宿主未就绪的临时状态，
      // 弹错误只会打扰用户。
      // 不要在这里回退为直接写 session store，那会绕过 Root 的编排。
      if (!workspacePath || !onCreateTask) {
        return;
      }
      // 原入口绕过 Root 的标准新建任务编排，只写 session store，
      // Settings 遮罩不会退出，composer remount 还可能覆盖预填。现在统一委托 Root，
      // 同时复用 @ Picker 的 canonical Plugin 链接，不新增第二套引用语义。
      onCreateTask({
        initialPrompt: buildPluginStoreTryPrompt({ item, locale, prompt }),
        initialPromptMention: buildPluginStoreTryMention({ item, locale }),
      });
    },
    [handleInstall, locale, onCreateTask, workspacePath],
  );

  // [契约] 卡片动作集必须保持引用稳定，否则列表项每帧重渲染；
  // 依赖数组要覆盖所有回调，漏 uninstall.requestUninstall 会让确认弹窗指向旧记录。
  // [契约] onOpenUi 只在 embedded 提供：主导航市场整行进入详情，不直接开 UI。
  // 启停统一走 workspace scope，见文件头 INV-16。
  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: openDetail,
      // 打开 UI 只在会话右侧市场（embedded）提供；主导航市场整行进入详情。
      onOpenUi: embedded
        ? (item) =>
            void pluginUi.open(
              item.id,
              item.info?.enabled
                ? undefined
                : () => setEnabled(item.id, true, operationService, "workspace"),
            )
        : undefined,
      // [契约] 启停写 workspace scope：卡片展示的是当前项目的实际生效配置，
      // 写 user scope 会改到其他项目；这里用 void 是因为错误由 store.error 统一呈现。
      // 不要在此乐观切换本地状态，否则失败时开关会与真实状态不一致。
      onSetEnabled: (pluginId, enabled) => {
        void setEnabled(pluginId, enabled, operationService, "workspace");
      },
      onInstall: (item) => void handleInstall(item),
      onUninstall: uninstall.requestUninstall,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      activeOperations,
      togglingPluginId,
    }),
    [
      handleInstall,
      handleUpdatePlugin,
      openDetail,
      activeOperations,
      uninstall.requestUninstall,
      pluginUi,
      operationService,
      setEnabled,
      togglingPluginId,
      embedded,
    ],
  );

  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.noWorkspace" })}
      </div>
    );
  }

  // [契约] 更新徽标与按钮共用这一个判定，避免「显示有更新但按钮禁用」。
  // detailItem 可能为 null，canUpdatePluginItem 需自行容忍，调用处不重复判空。
  const detailUpdatePending = canUpdatePluginItem(detailItem);

  return (
    <div
      ref={rootRef}
      className="@container/plugin-store space-y-5"
      data-testid="plugin-store-root"
      data-view={view}
    >
      {!embedded ? (
        <SettingsBreadcrumbReporter
          items={
            view === "detail" && detailItem
              ? [{ label: resolveItemDisplayName(detailItem, locale) }]
              : []
          }
          onSectionSelect={backToStore}
        />
      ) : null}
      {view === "detail" ? (
        <Button variant="ghost" data-testid="plugin-store-detail-back" onClick={backToStore}>
          {intl.formatMessage({ id: "settings.plugins.store.browseAll" })}
        </Button>
      ) : null}
      {view === "store" ? (
        // 对齐原型：标题与动作同一行、去掉副标题，压缩头部信息密度。
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {onBack ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={intl.formatMessage({ id: "project.back" })}
                onClick={onBack}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
            <h1
              data-testid="plugin-store-title"
              className="text-ui-xl font-semibold tracking-tight text-foreground"
            >
              {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
            </h1>
          </div>
          {/* 顶栏动作：刷新 / 市场源管理 / 添加 / 插件管理。 */}
          <div className="flex flex-wrap items-center gap-2">
            <ControlHintTooltip
              title={
                refreshing
                  ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                  : intl.formatMessage({ id: "settings.plugins.refresh" })
              }
            >
              <Button
                type="button"
                data-testid="plugin-store-refresh"
                variant="secondary"
                size="icon-lg"
                aria-label={
                  refreshing
                    ? intl.formatMessage({ id: "settings.plugins.refreshing" })
                    : intl.formatMessage({ id: "settings.plugins.refresh" })
                }
                onClick={() => void handleRefresh()}
                disabled={refreshing}
              >
                <RefreshCw
                  className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
                  aria-hidden="true"
                />
              </Button>
            </ControlHintTooltip>
            <ControlHintTooltip
              title={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
            >
              <Button
                type="button"
                data-testid="plugin-store-sources-open"
                variant="secondary"
                size="icon-lg"
                aria-label={intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
                onClick={() => setSourcesOpen(true)}
              >
                <Store className="size-3.5" aria-hidden="true" />
              </Button>
            </ControlHintTooltip>
            <PluginAddMenu
              testId="plugin-store-create"
              variant="secondary"
              size="lg"
              isWebRemoteControl={isWebRemoteControl}
              onCreateTask={onCreateTask}
              onAddMarketplace={() => {
                setAddMarketplaceError(null);
                setAddSourceOpen(true);
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="font-medium"
              data-testid="plugin-store-manage-open"
              onClick={() => setView("manage")}
            >
              {intl.formatMessage({ id: "settings.plugins.store.manageInstalled" })}
            </Button>
          </div>
        </div>
      ) : null}

      {error && !addSourceOpen ? (
        <div
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
          data-testid="plugin-store-error"
        >
          {error}
        </div>
      ) : null}

      {view === "manage" ? (
        <div data-testid="plugin-store-manage" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-ui-xl font-semibold">
              {intl.formatMessage({ id: "settings.plugins.store.manageInstalled" })}
            </h1>
            <Button variant="outline" data-testid="plugin-store-browse-all" onClick={backToStore}>
              {intl.formatMessage({ id: "settings.plugins.store.browseAll" })}
            </Button>
          </div>
          <PluginsSection
            mode="market"
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            isWebRemoteControl={isWebRemoteControl}
            initialScopeKey={managementScope}
            onScopeChange={setManagementScope}
            onCreateTask={onCreateTask}
            onOpenPluginStore={(_scope, intent) => {
              backToStore();
              if (intent === "add-marketplace") setAddSourceOpen(true);
            }}
            onOpenUi={
              embedded
                ? (item, target, enable) => {
                    if (
                      (target?.workspaceIdentity?.trim() || target?.workspacePath) !==
                      (workspaceIdentity?.trim() || workspacePath)
                    ) {
                      toast(intl.formatMessage({ id: "settings.plugins.store.ui.needsSession" }));
                      return;
                    }
                    void pluginUi.open(item.id, enable);
                  }
                : undefined
            }
          />
        </div>
      ) : view === "detail" && detailItem ? (
        <PluginStoreDetailView
          item={detailItem}
          actions={actions}
          describeEntry={describeCache[detailItem.id]}
          onRetryDescribe={() =>
            void describePlugin(
              detailItem.id,
              detailItem.name,
              detailItem.marketplace,
              operationService,
              true,
            )
          }
          onUsePrompt={handleUsePrompt}
          advanced={
            detailItem.info ? (
              <div className="space-y-4">
                {detailUpdatePending ? (
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-ui-base font-medium text-foreground">
                        {detailItem.installedMeta?.updateStatus === "update-available"
                          ? intl.formatMessage(
                              { id: "settings.plugins.detail.updateAvailable" },
                              { version: detailItem.installedMeta?.latestVersion ?? "" },
                            )
                          : intl.formatMessage({ id: "settings.plugins.detail.versionChanged" })}
                      </p>
                      <p className="text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({
                          id: "settings.plugins.detail.updateNewSessionsNote",
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      data-testid="plugin-store-detail-update"
                      variant="outline"
                      size="sm"
                      disabled={activeOperations.some(
                        (operation) => operation.id === `plugin:update:${detailItem.id}`,
                      )}
                      onClick={() => void handleUpdatePlugin(detailItem.id)}
                    >
                      {intl.formatMessage({ id: "settings.plugins.detail.update" })}
                    </Button>
                  </div>
                ) : null}
                <PluginStoreAdvancedSection>
                  {detailPluginWarnings.length > 0 ? (
                    <div>
                      <div className="mb-2 text-ui-xs font-medium text-foreground">
                        {intl.formatMessage({ id: "settings.plugins.detail.warnings" })}
                      </div>
                      <PluginWarningList warnings={detailPluginWarnings} />
                    </div>
                  ) : null}
                  <PluginDetailRow
                    label={intl.formatMessage({ id: "settings.plugins.detail.rootPath" })}
                    value={detailItem.info.rootPath}
                  />
                  {(detailItem.info.hookDetails ?? []).length > 0 ? (
                    <PluginHookDetails hooks={detailItem.info.hookDetails ?? []} />
                  ) : null}
                </PluginStoreAdvancedSection>
              </div>
            ) : undefined
          }
        />
      ) : null}
      <div hidden={view !== "store"}>
        <PluginStoreListView
          order={storeOrder}
          items={items}
          marketplaces={marketplaces}
          actions={actions}
          loading={
            loading ||
            activeOperations.some((operation) => operation.id.startsWith("marketplace:update:"))
          }
          query={query}
          onQueryChange={setQuery}
          onSearchSubmit={() => {
            if (!query.trim()) return;
            void reportAppTelemetryEvent(
              platform,
              {
                elementName: "plugin_discovery",
                eventRegion: "app",
                eventType: "view",
                eventExtraDetail: {
                  schema_version: "1",
                  action: "search",
                  entry: embedded ? "side_pane_market" : "store_list",
                  client_kind: isWebRemoteControl ? "mobile" : "desktop",
                },
              },
              "plugin-discovery",
            );
          }}
          segment={segment}
          onSegmentChange={setSegment}
        />
      </div>

      <Dialog
        open={pluginUi.surfaces.length > 1}
        onOpenChange={(open) => {
          if (!open) pluginUi.closeSelection();
        }}
      >
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.plugins.store.ui.chooseSurface" })}
          </DialogTitle>
          {pluginUi.surfaces.map((surface) => (
            <Button
              key={surface.id}
              variant="outline"
              onClick={() => pluginUi.selectSurface(surface)}
            >
              {resolvePluginUiSurfaceTitle(surface.title, locale)}
            </Button>
          ))}
        </DialogContent>
      </Dialog>

      <PluginUninstallConfirmDialog
        open={uninstall.pendingPlugin !== null}
        pluginName={
          uninstall.pendingPlugin
            ? resolvePluginDisplayName(
                itemById.get(uninstall.pendingPlugin.id) ?? {
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
      <PluginStoreSourcesDialog
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        marketplaces={marketplaces}
        onUpdateMarketplace={(marketplace) => void updateMarketplace(marketplace, operationService)}
        onRemoveMarketplace={(marketplace) => void removeMarketplace(marketplace, operationService)}
        activeOperations={activeOperations}
      />
      <AddMarketplaceSourceDialog
        open={addSourceOpen}
        onOpenChange={setAddSourceOpen}
        onAddMarketplace={handleAddMarketplace}
        activeOperations={activeOperations}
        error={addMarketplaceError}
      />
    </div>
  );
}
