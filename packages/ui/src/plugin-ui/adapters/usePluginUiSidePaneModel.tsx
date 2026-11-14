// INV-01 租约归属：守住位置 适配器内申请会话租约与卸载清理；改错故障：会话租约泄漏或提前释放。
// INV-02 读键一致：守住位置 读键的拼装调用；改错故障：读写两侧键不同，快照永远读不到。
// INV-03 占用键独立：守住位置 占用键的拼装；改错故障：把读键当占用键导致展示位置互相覆盖。
// INV-04 作用域分派：守住位置 作用域类型的三元分支；改错故障：工具卡片读到面板快照。
// INV-05 呈现来源：守住位置 呈现信息的推导；改错故障：面板标题随工具行变化而闪烁。
// INV-06 启动屏障：守住位置 宿主启用的布尔表达式；改错故障：首帧空渲染后控制器不再重启。
// INV-07 回内联前提：守住位置 可回内联的判定；改错故障：切回行内后没有宿主接收。
// INV-08 显示模式候选：守住位置 可用显示模式数组；改错故障：未接管内联卡片时仍给出行内选项。
// INV-09 空快照常量：守住位置 非面板分支的返回值；改错故障：每次渲染新建空对象，依赖列表频繁失效。
// INV-10 依赖完整：守住位置 交互桥的依赖数组；改错故障：闭包捕获旧会话信息。
// INV-11 主题解析：守住位置 主题取值与解析调用；改错故障：宿主拿到未解析的主题值。
// INV-12 宽度同步：守住位置 宽度回调；改错故障：宿主布局按 0 宽度初始化。
// INV-13 句柄降级：守住位置 返回值里的宿主句柄；改错故障：呈现信息缺失时仍暴露无效句柄。
// INV-14 阶段降级：守住位置 返回值里的宿主阶段；改错故障：准备中却显示就绪。
// INV-15 文案前缀：守住位置 三条 intl 消息 id；改错故障：侧栏出现其它模块的文案。
// INV-16 作用域容器：守住位置 侧栏作用域容器的拼装；改错故障：侧栏拿到错误的会话作用域。
// INV-17 可选字段：守住位置 条件展开写法；改错故障：空字符串身份被当作有效工作区。
// INV-18 纯归约：守住位置 渲染期读取投喂缓存；改错故障：读内存在渲染期产生写副作用。
//
// 模块职责：把会话投影、工具行与面板快照合成侧栏视图属性，并提供侧栏专用的会话作用域容器。
// 状态所有权：会话租约与投影归 V4 层；面板宽度、呈现阶段与宿主句柄归适配器自身。
// 阅读顺序：常量 → 租约与投影 → 读键与快照 → 呈现与交互 → 宿主连接 → 作用域容器。
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createPluginUiInteractions } from "@/plugin-ui/adapters/pluginUiInteractions.js";
import { usePluginUiResourceDeltaFeed } from "@/plugin-ui/adapters/pluginUiResourceDeltaFeed.js";
import { usePluginUiHost } from "@/plugin-ui/adapters/usePluginUiHost.js";
import {
  getPluginUiSurfaceFeed,
  offerPluginUiSurfaceFeed,
} from "@/plugin-ui/app/pluginUiSurfaceFeedStore.js";
import { claimPluginUiSurface } from "@/plugin-ui/app/pluginUiSurfaceStore.js";
import type {
  PluginUiPresentation,
  PluginUiSessionScope,
  PluginUiSidePaneTab,
  PluginUiSidePaneViewProps,
} from "@/plugin-ui/contract.js";
import { PLUGIN_UI_SIDE_PANE_TITLE_BAR, buildPluginUiSurfaceKey } from "@/plugin-ui/contract.js";
import { resolveSidePaneDisplayModeRequest } from "@/plugin-ui/domain/buildPluginUiHostContext.js";
import {
  EMPTY_PLUGIN_UI_SURFACE_FEED,
  buildPluginUiToolResult,
  findToolRowById,
  isPluginUiToolCancelled,
  readPluginUiToolInput,
  reducePluginUiSurfaceFeed,
} from "@/plugin-ui/domain/pluginUiToolFeed.js";
import { readPluginUiPresentation } from "@/plugin-ui/domain/readPluginUiPresentation.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import type { McpAppsDisplayMode, PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolvePluginUiLogicalScope } from "../domain/pluginUiLogicalScope.js";

// 显示模式候选：侧栏未接管内联卡片时只允许全屏，接管后同时给出行内与全屏。
// 两个数组必须保持字面量常量身份，供宿主做引用比较。
//
const FULLSCREEN_ONLY: readonly McpAppsDisplayMode[] = ["fullscreen"];
const INLINE_AND_FULLSCREEN: readonly McpAppsDisplayMode[] = ["inline", "fullscreen"];

// 侧栏模型：把会话投影、工具行、面板快照与宿主连接合成一份视图属性。
// 入参 tab 是清单入口快照，作用域引用决定本面板是工具卡片还是一次面板。
// 会话租约由本适配器自己申请，侧栏不在会话面板树内，拿不到外层的租约。
// 两个拼装键分别用于读投喂缓存和登记占用，作用域不同不可互换。
// [资源] 租约在卸载时释放，否则会话引用计数只增不减。
//
export function usePluginUiSidePaneModel({
  tab,
  visible,
  scopeRef,
  onOpenBrowserUrl,
  onCloseTab,
}: {
  tab: PluginUiSidePaneTab;
  visible: boolean;
  scopeRef: PluginUiScopeRef;
  onOpenBrowserUrl?: (url: string) => void;
  onCloseTab?: (tabId: string) => void;
}): PluginUiSidePaneViewProps {
  const { intl, locale } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");

  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  // 会话投影：没有租约时为空，所有下游行查询与快照读取都必须容忍空值。
  // 投影按窗口裁剪，工具行一旦被裁掉就视为不可再接管。
  // 资源增量投喂跟着同一租约走，避免侧栏与主面板重复订阅。
  //
  const state = useConversationProjection(lease);
  // 4b-2 R4：侧栏不在 SessionPane 树内，自己把会话投影的资源通知接到路由表（按 store 引用计数，不重复投递）。
  const feedScope = useMemo<PluginUiSessionScope>(
    () => ({
      workspacePath: tab.workspacePath,
      remoteSessionId: tab.remoteSessionId,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      sessionId: tab.parentSessionId,
    }),
    [tab.parentSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  usePluginUiResourceDeltaFeed(lease?.store, feedScope);

  // 读键：由入口快照、父会话与作用域拼成，必须与写入侧使用同一份拼装函数。
  // 工具卡片只喂本行数据，面板才读归约后的快照。
  // 面板呈现信息取自 `rowPresentation` 而非工具行，标题与资源地址都由清单决定。
  // 归约是纯函数，读内存在渲染期发生，不会产生副作用。
  //
  const surfaceKey = buildPluginUiSurfaceKey({ ...tab, sessionId: tab.parentSessionId }, scopeRef);

  const rows = state.snapshot?.rows.window ?? null;
  // 工具卡片 tab：投喂本行。
  const row = useMemo(
    () =>
      scopeRef.kind === "toolCall" && rows ? findToolRowById(rows, scopeRef.toolCallId) : null,
    [rows, scopeRef],
  );
  const toolCall = useMemo(() => (row ? toolCallRowToLegacyNode(row).toolCall : null), [row]);
  const rowPresentation = useMemo(
    () => (toolCall ? readPluginUiPresentation(toolCall.raw) : null),
    [toolCall],
  );
  // 面板 tab（H06）：投喂"最后一次成功结果"快照，由投影窗口归约、合并进 renderer 内存 store；
  // 最新一行 running / failed 不覆盖上一份好结果，窗口裁掉旧行后快照仍在。归约是纯函数，读 store 在渲染期无副作用。
  // 面板快照归约：只认最后一次成功结果，运行中与失败不覆盖上一份好结果。
  // 窗口裁掉旧行后快照仍在，靠的是内存缓存而非投影窗口。
  // 工具卡片作用域直接给空快照，后续读取统一走空对象分支。
  //
  const feed = useMemo(
    () =>
      scopeRef.kind === "surface"
        ? reducePluginUiSurfaceFeed(
            getPluginUiSurfaceFeed(surfaceKey),
            rows ?? [],
            scopeRef.surfaceId,
            tab.pluginId,
            { serverName: tab.serverName, resourceUri: tab.resourceUri },
          )
        : EMPTY_PLUGIN_UI_SURFACE_FEED,
    [rows, scopeRef, surfaceKey, tab.pluginId, tab.serverName, tab.resourceUri],
  );
  useEffect(() => {
    if (scopeRef.kind === "surface") offerPluginUiSurfaceFeed(surfaceKey, feed);
  }, [feed, scopeRef.kind, surfaceKey]);
  // 面板的呈现信息来自 tab（清单入口），不随工具行变化；工具卡片 tab 仍以行上的 display.ui 为准。
  const presentation = useMemo<PluginUiPresentation | null>(() => {
    if (scopeRef.kind === "toolCall") return rowPresentation;
    return tab.serverName
      ? { serverName: tab.serverName, pluginId: tab.pluginId, resourceUri: tab.resourceUri }
      : null;
  }, [rowPresentation, scopeRef.kind, tab.pluginId, tab.resourceUri, tab.serverName]);
  // 占用键：呈现信息可能改变逻辑作用域，因此不能复用读键。
  // `placementKey` 登记侧栏模式：面板由侧栏展示时，内联卡片让位。
  // [并发] 同一面板在主区域与侧栏同时存在时，后登记者覆盖展示位置。
  //
  const placementKey = buildPluginUiSurfaceKey(
    { ...tab, sessionId: tab.parentSessionId },
    resolvePluginUiLogicalScope(presentation ?? {}, scopeRef),
  );
  useEffect(() => claimPluginUiSurface(placementKey, "side-pane"), [placementKey]);
  const toolInput = useMemo(
    () => (scopeRef.kind === "surface" ? feed.latest?.input : readPluginUiToolInput(toolCall)),
    [feed.latest, scopeRef.kind, toolCall],
  );
  const toolResult = useMemo(
    () =>
      scopeRef.kind === "surface"
        ? feed.result?.toolResult
        : buildPluginUiToolResult(toolCall, rowPresentation),
    [feed.result, rowPresentation, scopeRef.kind, toolCall],
  );
  const toolCallId = scopeRef.kind === "surface" ? feed.latest?.toolCallId : scopeRef.toolCallId;
  const toolCancelled =
    scopeRef.kind === "surface"
      ? feed.latest?.status === "cancelled"
      : isPluginUiToolCancelled(toolCall);
  // H10：只有该作用域在会话流里仍有内联卡片可接管（行在投影窗口内）且宿主给了关闭入口，才能回 inline。
  // 回内联前提：宿主提供了关闭入口，且会话流里仍有可接管的卡片或结果。
  // 任一不满足就只给全屏，避免显示模式切换后落到没有宿主的位置。
  //
  const canReturnInline =
    Boolean(onCloseTab) && (scopeRef.kind === "surface" ? feed.latest !== null : row !== null);
  const handleDisplayModeRequest = useCallback(
    (mode: McpAppsDisplayMode) => {
      const resolved = resolveSidePaneDisplayModeRequest(mode, canReturnInline);
      if (resolved === "inline") onCloseTab?.(tab.id);
      return resolved;
    },
    [canReturnInline, onCloseTab, tab.id],
  );
  const [width, setWidth] = useState(0);
  // 交互桥：把面板标识与会话作用域烘焙进回调，供宿主脚本调用。
  // 依赖列表逐项列出入口字段，漏项会让旧闭包捕获过期的会话信息。
  //
  const interactions = useMemo(
    () =>
      createPluginUiInteractions({
        workspacePath: tab.workspacePath,
        remoteSessionId: tab.remoteSessionId,
        workspaceIdentity: tab.workspaceIdentity,
        sessionId: tab.parentSessionId,
        pluginId: tab.pluginId,
        scope: scopeRef,
      }),
    [
      scopeRef,
      tab.parentSessionId,
      tab.pluginId,
      tab.workspacePath,
      tab.workspaceIdentity,
      tab.remoteSessionId,
    ],
  );
  // widgetState 初值由 usePluginUiHost 按同一 surfaceKey 从宿主内存 store 读取（4a-0），面板不另取。
  // 宿主连接：呈现信息缺失时用空资源占位，句柄最终由返回值决定是否暴露。
  // 启用条件是启动屏障：工具卡要等行进入投影，面板要等快照到达，否则首帧空渲染。
  //
  const host = usePluginUiHost({
    presentation: presentation ?? {
      serverName: "",
      pluginId: tab.pluginId,
      resourceUri: tab.resourceUri,
    },
    scope: {
      workspacePath: tab.workspacePath,
      remoteSessionId: tab.remoteSessionId ?? undefined,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      sessionId: tab.parentSessionId,
      scope: scopeRef,
    },
    theme: resolveTheme(theme),
    locale,
    displayMode: "fullscreen",
    toolInput,
    toolResult,
    toolCallId,
    toolCancelled,
    hostVersion: "zcode",
    availableDisplayModes: canReturnInline ? INLINE_AND_FULLSCREEN : FULLSCREEN_ONLY,
    onDisplayModeRequest: handleDisplayModeRequest,
    onOpenExternal: onOpenBrowserUrl,
    width,
    titleBar: PLUGIN_UI_SIDE_PANE_TITLE_BAR,
    interactions,
    // 启动屏障（H07）：工具卡片 tab 要等本行进投影（rowPresentation 才有 serverName，否则 prepareSandbox 被参数校验拒绝，
    // 而 identity 不变导致 controller 之后也不会重启）；面板 tab 要等投影快照到达（rows 非 null），
    // 否则第一次 setWidgetData 没有 toolInput / toolResult，页面先空渲染一次再收通知。
    enabled: presentation !== null && (scopeRef.kind === "toolCall" || rows !== null),
  });

  return {
    visible,
    scopeRef,
    host: {
      ...host,
      handle: presentation ? host.handle : null,
      phase: presentation ? host.phase : "preparing",
    },
    loadingLabel: intl.formatMessage({ id: "pluginUi.loading" }),
    errorLabel: intl.formatMessage({ id: "pluginUi.loadFailed" }),
    retryLabel: intl.formatMessage({ id: "pluginUi.retry" }),
    onWidthChange: setWidth,
  };
}

/** 侧栏不在 SessionPane 树内，由这个适配器复用原 workspace 的 V4 层与 lease。 */
export function PluginUiConversationScope({
  tab,
  children,
}: {
  tab: PluginUiSidePaneTab;
  children: ReactNode;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.workspacePath, tab.workspaceIdentity, tab.remoteSessionId],
  );
  return <V4PaneConversationProvider scope={scope}>{children}</V4PaneConversationProvider>;
}
