// INV-01 展示模型的裁决顺序是 presentation 完整 → sessionId 非空 → 非 failed → 未取消 → 非 isError；守住位置可保证任一缺失即降级为普通记录，改错故障会让失败行争抢同一侧栏锚点。
// INV-02 toolSurfaceKey 由 surfaceTarget 与逻辑 scope 共同生成，routedSurfaceKey 仅在 presentation.surface 存在时补出面板 tab 键；守住位置避免两把键错位，改错故障会让侧栏查询打到空键。
// INV-03 sidePaneActive 同时查询工具卡片键与面板键，任一命中即视为侧栏已接管；守住位置可撤下内联锚点，改错故障会让同一活页面在两处同时渲染。
// INV-04 superseded 只来自时间线裁决，pinned 以手动记录优先、其次 forcedInline 与 autoExpand；守住位置可保住优先级次序，改错故障会把被替代的行重新钉回。
// INV-05 资源级 showInline 经 ref 读取句柄并靠 effect 回写固定，渲染期不直接采信；守住位置可避免派生抖动，改错故障会让首帧丢失常驻判定。
// INV-06 togglePin 只写入当前取反值，并以 sessionId 与 toolId 双键定位；守住位置保证同一行只留一条记录，改错故障会把旧行状态写到新行。
// INV-07 openInSidePane 对 surface 工具建面板 tab、对普通工具建工具卡片 tab，标题回退到 pluginId；守住位置保证路由参数与键同源，改错故障会把结果投进错的 tab。
// INV-08 handleDisplayModeRequest 在 fullscreen 且有侧栏入口时直接转开侧栏并回传 fullscreen，其余只改本地 displayMode；守住位置可保两端一致，改错故障会留下未打开却标成全屏的空壳。
// INV-09 业务失败可能仍是 completed 并携带 UI 元数据，故 supportedScope 独查终态标志；守住位置可让错误行只留普通记录，改错故障会让空白卡片抢走页面。
// INV-10 appAllowsFullscreen 初值为真，握手能力到达后回写，canOpenSidePane 同时要求回调与能力；守住位置可避免早于能力到达的越权入口，改错故障会在不支持全屏的页面给出侧栏按钮。
// INV-11 availableDisplayModes 由 canOpenSidePane 在两组常量间单选，作为页面握手声明的硬约束；守住位置保证声明与入口同源，改错故障会让页面声称支持却无入口。
// INV-12 resultReady 以 toolResult 是否存在判定，inlineActive 再叠加 not sidePaneActive 与 not superseded；守住位置保证沙箱在结果后才建，改错故障会在 pending 阶段生成空沙箱。
// INV-13 登记 effect 仅在 inlineActive 且 host.supported 时执行并返回释放函数，键固定为 toolSurfaceKey；守住位置保证登记与清理成对，改错故障会残留侧栏占用。
// INV-14 autoOpenKey 仅由 preferredDisplayMode 为 fullscreen 触发，且固定使用工具卡片粒度键；守住位置保证自动打开只认工具卡片，改错故障会让面板工具在错误键上补触发。
// INV-15 自动打开先经 sidePane 记忆键去重认领，再查路由键是否已在侧栏，最后才真正打开；守住位置保证单次消费，改错故障会在重挂载时覆盖用户关闭。
// INV-16 自动打开 effect 以 superseded 显式短路，历史展开重挂载的旧全屏行不得抢回侧栏；守住位置保证历史行只读，改错故障会让旧卡片夺走当前会话侧栏。
// INV-17 返回值里 pinned 与 onTogglePin 仅在 supportedScope 且非 superseded 时给出，文案统一走 intl；守住位置保证不可用行没有按钉入口，改错故障会暴露可点击的假状态。
// INV-18 prefersBorder 按资源级、工具级、默认真三级回退，surface 与 preferredDisplayMode 直出展示层；守住位置保证回退次序稳定，改错故障会让已声明边界的页面丢边框。
//
// 模块职责：把工具调用行适配成插件 UI 展示模型，集中 React 订阅、侧栏路由、展示模式协商与按钉状态，视图只做纯渲染。
// 状态所有权：订阅数据来自 disclosure、instance、surface 三个 store；本地 useState 只管宽度、displayMode 与全屏能力，沙箱归 usePluginUiHost 持有。
// 阅读顺序：先看 supportedScope 与 sidePaneActive 的裁决，再看 pinned 优先级与侧栏打开路径，最后看自动打开 effect 与返回值映射。
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildTaskSidePaneMemoryKey,
  claimPluginUiSidePaneAutoOpen,
} from "@/lib/taskSidePaneMemory.js";
import { createPluginUiInteractions } from "@/plugin-ui/adapters/pluginUiInteractions.js";
import { usePluginUiHost } from "@/plugin-ui/adapters/usePluginUiHost.js";
import {
  getPluginUiManualPin,
  setPluginUiManualPin,
  subscribePluginUiDisclosure,
} from "@/plugin-ui/app/pluginUiDisclosureStore.js";
import {
  getPluginUiRowDisposition,
  subscribePluginUiInstances,
} from "@/plugin-ui/app/pluginUiInstanceStore.js";
import {
  claimPluginUiSurface,
  getPluginUiSurface,
  subscribePluginUiSurfaces,
} from "@/plugin-ui/app/pluginUiSurfaceStore.js";
import { buildPluginUiSurfaceKey } from "@/plugin-ui/contract.js";
import { appAllowsDisplayMode } from "@/plugin-ui/domain/buildPluginUiHostContext.js";
import {
  buildPluginUiToolResult,
  isPluginUiToolCancelled,
  readPluginUiToolInput,
} from "@/plugin-ui/domain/pluginUiToolFeed.js";
import { readPluginUiPresentation } from "@/plugin-ui/domain/readPluginUiPresentation.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { resolveTheme } from "@/useTheme.js";
import type {
  McpAppsDisplayMode,
  PluginSandboxHandle,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { resolvePluginUiLogicalScope } from "../domain/pluginUiLogicalScope.js";

import type { PluginUiToolCallViewProps } from "@/plugin-ui/contract.js";

// 展示模式常量在模块级冻结，是否包含 fullscreen 决定页面握手声明的能力面。
// 资源级 showInline 从沙箱句柄读取，句柄为空时按未声明处理，不参与组合。
// 常量与句柄判定必须同源，否则侧栏入口与页面声明会各说一套。
// 两组常量是能力声明的唯一来源，不要在调用点临时拼数组。
const INLINE_AND_FULLSCREEN: readonly McpAppsDisplayMode[] = ["inline", "fullscreen"];
const host_resourceShowInline = (handle: PluginSandboxHandle | null) =>
  handle?.resourceMeta?.showInline === true;
const INLINE_ONLY: readonly McpAppsDisplayMode[] = ["inline"];

/** 工具行到插件 UI 的适配；React 生命周期与宿主动作集中于此，视图只接收展示模型。 */
// 入参只带工具行渲染上下文，返回值是去掉 fallback 的展示模型，视图不接触 React 状态。
// presentation 由原始 tool-call 解析并随 raw 记忆，标签、surface 声明都从它派生。
// scope 与 onOpenSidePane 由调用方注入，缺省时后续所有侧栏路径整体短路。
// 订阅、副作用与沙箱创建收敛在本 hook，重渲染时字段位置保持稳定。
// 宽度、展示模式、全屏能力三份本地状态不接受外部回灌，避免上行与下行互相覆盖。
export function usePluginUiToolCallModel(
  context: ToolCallBlockRenderContext,
): Omit<PluginUiToolCallViewProps, "fallback"> {
  const { intl, locale } = useZCodeIntl();
  const presentation = useMemo(
    () => readPluginUiPresentation(context.toolCallNode.toolCall.raw),
    [context.toolCallNode.toolCall.raw],
  );
  const scope = context.pluginUi?.scope;
  const onOpenSidePane = context.pluginUi?.onOpenSidePane;
  const toolCall = context.toolCallNode.toolCall;
  const [width, setWidth] = useState(0);
  const [displayMode, setDisplayMode] = useState<McpAppsDisplayMode>("inline");
  // 资源级 showInline 只随句柄到达；经 ref 读避免把 host 结果卷进渲染期的派生。
  // 句柄先落 ref 再读，渲染期只能看到上一帧句柄，资源级字段因此天然滞后一帧。
  // 每帧覆盖 ref 而不触发重渲染，showInline 的真实生效靠下方 effect 一次性回写。
  // 句柄若放进 state 会形成句柄与渲染互相驱动的环，这里刻意保留一帧延迟换稳定。
  // 回写 effect 的依赖必须包含句柄本身，否则常驻判定与渲染脱节。
  const hostHandleRef = useRef<PluginSandboxHandle | null>(null);
  const sessionId = scope?.sessionId ?? "";
  const toolScope = useMemo<PluginUiScopeRef>(
    () =>
      presentation?.surface
        ? { kind: "surface", surfaceId: presentation.surface }
        : { kind: "toolCall", toolCallId: toolCall.toolId },
    [toolCall.toolId, presentation?.surface],
  );
  const surfaceTarget = {
    workspacePath: scope?.workspacePath ?? context.workspacePath,
    workspaceIdentity: scope?.workspaceIdentity,
    sessionId,
    pluginId: presentation?.pluginId ?? "",
    serverName: presentation?.serverName,
    resourceUri: presentation?.resourceUri,
  };
  // 面板键由目标描述与逻辑 scope 共同生成，workspacePath 优先取 scope、回退到上下文。
  // 同一工具行可能同时有 `toolSurfaceKey` 与面板键，两者不可互相替代。
  // 键必须先于所有订阅查询成型，否则首帧会拿空键去登记。
  // pluginId 与 resourceUri 缺失时以空串占位，保证键结构稳定可比较。
  const toolSurfaceKey = buildPluginUiSurfaceKey(
    surfaceTarget,
    resolvePluginUiLogicalScope(presentation ?? {}, toolScope),
  );
  // 面板路由目标：工具声明了 surface 时，"侧栏是否已接管"看面板 tab 而不是工具卡片 tab。
  const routedSurfaceKey = presentation?.surface
    ? buildPluginUiSurfaceKey(surfaceTarget, { kind: "surface", surfaceId: presentation.surface })
    : null;
  // 服务端快照取假，避免订阅建立前误报侧栏已接管。
  // 两把键任一被标记为 side-pane 即算接管，路由键仅在存在 surface 时参与。
  // 该值只读不写，写入侧由登记与打开动作完成，形成单向数据流。
  // 快照函数是纯查询，重复调用无副作用，可被同步存储按需重算。
  const sidePaneActive = useSyncExternalStore(
    subscribePluginUiSurfaces,
    () =>
      getPluginUiSurface(toolSurfaceKey) === "side-pane" ||
      (routedSurfaceKey !== null && getPluginUiSurface(routedSurfaceKey) === "side-pane"),
    () => false,
  );

  const toolInput = useMemo(() => readPluginUiToolInput(toolCall), [toolCall]);
  const toolResult = useMemo(
    () => buildPluginUiToolResult(toolCall, presentation),
    [presentation, toolCall],
  );
  // 4b-1：时间线推导的展示裁决（被替代 / 强制常驻）与用户手动固定状态。
  const disposition = useSyncExternalStore(
    subscribePluginUiInstances,
    () => getPluginUiRowDisposition(sessionId, toolCall.toolId),
    () => undefined,
  );
  const manualPin = useSyncExternalStore(
    subscribePluginUiDisclosure,
    () => getPluginUiManualPin(sessionId, toolCall.toolId),
    () => undefined,
  );
  const superseded = disposition?.superseded === true;
  // 时间线裁决与手动记录是两条独立来源，手动记录非 undefined 时直接压过推导结果。
  // 资源级常驻叠加在推导值之上，句柄未到位时不会误伤用户的手动折叠。
  // 被替代的行即使常驻也不再占锚点，superseded 优先于常驻语义。
  // 取反写入时把当前 pinned 作为旧值交回 store，避免闭包读到过期状态。
  const forcedInline =
    disposition?.forcedInline === true || host_resourceShowInline(hostHandleRef.current);
  const pinned = manualPin ?? (forcedInline || disposition?.autoExpand === true);
  const togglePin = useCallback(() => {
    setPluginUiManualPin(sessionId, toolCall.toolId, !pinned);
  }, [pinned, sessionId, toolCall.toolId]);

  const openInSidePane = useCallback(() => {
    if (!presentation) return;

    onOpenSidePane?.({
      // surface 工具打开的是面板 tab（结果随后路由进面板），普通工具打开工具卡片 tab。
      ...(presentation.surface
        ? { surfaceId: presentation.surface, serverName: presentation.serverName }
        : { toolCallId: toolCall.toolId, serverName: presentation.serverName }),
      pluginId: presentation.pluginId,
      resourceUri: presentation.resourceUri,
      title: toolCall.title ?? presentation.pluginId,
    });
  }, [
    onOpenSidePane,
    presentation,
    routedSurfaceKey,
    toolCall.title,
    toolCall.toolId,
    toolSurfaceKey,
  ]);

  const handleDisplayModeRequest = useCallback(
    (mode: McpAppsDisplayMode) => {
      if (mode === "fullscreen" && onOpenSidePane) {
        openInSidePane();
        return "fullscreen";
      }
      setDisplayMode(mode);
      return mode;
    },
    [onOpenSidePane, openInSidePane],
  );
  const handleOpenExternal = useCallback(
    (url: string) => context.onOpenBrowserUrl?.(url),
    [context.onOpenBrowserUrl],
  );

  // MCP 的业务失败仍可能是 completed 且带 UI 元数据；只检查有结果会让错误行争抢同一页面并留下空白卡片。
  // 展示条件：失败/取消只留普通记录，不能建锚点或自动开侧栏；原始 tool-result 不改写。
  // 会话标识是硬门槛，缺 sessionId 时即使 presentation 完整也不建锚点。
  // 失败、取消与 isError 三类终态并列排除，业务失败可能仍是 completed。
  // `supportedScope` 是整条链路唯一闸门：沙箱 / 自动打开 / 按钉入口都必须先过。
  // 判定只读原始 tool-result，不回写也不修补上游状态。
  const supportedScope =
    Boolean(presentation && scope?.sessionId) &&
    toolCall.status !== "failed" &&
    !isPluginUiToolCancelled(toolCall) &&
    presentation?.isError !== true;
  // 页面握手声明的 availableDisplayModes 是硬约束（规范 MUST NOT）：不含 fullscreen 时不给侧栏入口、不自动打开。
  // 能力在 initialized 后才到，先按"都支持"起步；到达后经 availableDisplayModes 变化推 host-context-changed。
  const [appAllowsFullscreen, setAppAllowsFullscreen] = useState(true);
  const canOpenSidePane = Boolean(onOpenSidePane) && appAllowsFullscreen;
  const interactions = useMemo(
    () =>
      scope?.sessionId && presentation
        ? createPluginUiInteractions({
            ...scope,
            sessionId: scope.sessionId,
            pluginId: presentation.pluginId,
            scope: toolScope,
          })
        : undefined,
    [presentation, scope, toolScope],
  );
  // 侧栏接管时内联撤掉展示锚点，管理器继续持有同一个活页面。
  // 被替代的行只留普通记录；结果未就绪（pending / running）时只占位，沙箱在结果到达后才建。
  // 结果未就绪时保持占位，不创建沙箱，也不登记展示锚点。
  // 侧栏接管后内联撤锚，管理器持有同一个活页面，不重复建实例。
  // `inlineActive` 为假的行只留普通记录，常驻与自动打开都不生效。
  // 四个条件按 支持、未接管、未替代、结果就绪 的顺序短路，次序变动会改变首帧行为。
  const resultReady = toolResult !== undefined;
  const inlineActive = supportedScope && !sidePaneActive && !superseded && resultReady;
  const host = usePluginUiHost({
    presentation: presentation ?? { serverName: "", pluginId: "", resourceUri: "" },
    scope: {
      workspacePath: scope?.workspacePath ?? context.workspacePath,
      remoteSessionId: scope?.remoteSessionId ?? undefined,
      ...(scope?.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      sessionId,
      scope: toolScope,
    },
    theme: resolveTheme(context.theme ?? "system"),
    locale,
    displayMode,
    toolInput,
    toolResult,
    toolCallId: toolCall.toolId,
    toolCancelled: isPluginUiToolCancelled(toolCall),
    hostVersion: "zcode",
    // 没有侧栏入口（如只读 / 非桌面壳）或页面不支持 fullscreen 时只声明 inline。
    availableDisplayModes: canOpenSidePane ? INLINE_AND_FULLSCREEN : INLINE_ONLY,
    onDisplayModeRequest: handleDisplayModeRequest,
    onOpenExternal: handleOpenExternal,
    width,
    enabled: inlineActive,
    ...(interactions ? { interactions } : {}),
  });
  hostHandleRef.current = host.handle;
  useEffect(() => {
    setAppAllowsFullscreen(appAllowsDisplayMode(host.appCapabilities, "fullscreen"));
  }, [host.appCapabilities]);
  // 资源级 showInline（随句柄到达）：没有手动记录时写成固定，之后折叠边界据此重算。
  useEffect(() => {
    if (!supportedScope || host.handle?.resourceMeta?.showInline !== true || !sessionId) return;
    if (getPluginUiManualPin(sessionId, toolCall.toolId) === undefined) {
      setPluginUiManualPin(sessionId, toolCall.toolId, true);
    }
  }, [host.handle, sessionId, supportedScope, toolCall.toolId]);

  useEffect(() => {
    if (!inlineActive || !host.supported) return;
    return claimPluginUiSurface(toolSurfaceKey, "inline");
  }, [inlineActive, host.supported, toolSurfaceKey]);

  // preferredDisplayMode: fullscreen → 工具卡片一出现就自动打开侧栏一次。
  // 不等结果：replay / 极快模型下结果到达与回合收起可能在同一批提交，等结果会让 effect 永远没机会跑。
  // 结果稍后由侧栏从实时投影按 toolCallId / surfaceId 自行读取。
  const autoOpenKey =
    presentation?.preferredDisplayMode === "fullscreen"
      ? buildPluginUiSurfaceKey(surfaceTarget, { kind: "toolCall", toolCallId: toolCall.toolId })
      : null;
  // 自动打开键固定按工具卡片粒度生成，与页面是否声明 surface 无关。
  // 侧栏记忆键按任务维度拼装，重挂载后共享，用来记录一次性消费。
  // 消费顺序是先去重认领、再看是否已在侧栏、最后才打开，任一步提前返回都不产生副作用。
  // 自动打开不等结果，replay 与极快模型下结果到达与回合收起可能同批提交。
  // 依赖数组必须覆盖全部参与判定的值，漏项会让 effect 带着旧闭包触发打开。
  const sidePaneMemoryKey = buildTaskSidePaneMemoryKey({
    workspacePath: surfaceTarget.workspacePath,
    workspaceIdentity: surfaceTarget.workspaceIdentity,
    taskId: sessionId,
  });
  useEffect(() => {
    if (
      !supportedScope ||
      // 历史展开会重新挂载旧 fullscreen 行；必须同步禁止自动打开，否则旧卡片会抢回侧栏。
      superseded ||
      !host.supported ||
      !autoOpenKey ||
      !canOpenSidePane
    )
      return;
    // 已经在侧栏的调用也要消费；否则关闭后重新挂载会补触发，覆盖用户关闭状态。
    if (!claimPluginUiSidePaneAutoOpen(sidePaneMemoryKey, autoOpenKey)) return;
    if (getPluginUiSurface(routedSurfaceKey ?? toolSurfaceKey) === "side-pane") return;
    openInSidePane();
  }, [
    supportedScope,
    superseded,
    host.supported,
    autoOpenKey,
    sidePaneMemoryKey,
    canOpenSidePane,
    openInSidePane,
    routedSurfaceKey,
    toolSurfaceKey,
  ]);

  return {
    supported: supportedScope && host.supported,
    surface: presentation?.surface,
    preferredDisplayMode: presentation?.preferredDisplayMode ?? "inline",
    sidePaneActive,
    host,
    // 资源级声明优先，工具级兜底，都没有默认画边框。
    prefersBorder: host.handle?.resourceMeta?.prefersBorder ?? presentation?.prefersBorder ?? true,
    superseded,
    ...(supportedScope && !superseded ? { pinned, onTogglePin: togglePin } : {}),
    pinLabel: intl.formatMessage({ id: "pluginUi.pin" }),
    unpinLabel: intl.formatMessage({ id: "pluginUi.unpin" }),
    loadingLabel: intl.formatMessage({ id: "pluginUi.loading" }),
    errorLabel: intl.formatMessage({ id: "pluginUi.loadFailed" }),
    retryLabel: intl.formatMessage({ id: "pluginUi.retry" }),
    openedLabel: intl.formatMessage({ id: "pluginUi.openedInSidePane" }),
    openLabel: intl.formatMessage({ id: "pluginUi.openInSidePane" }),
    onWidthChange: setWidth,
    onOpenSidePane: canOpenSidePane ? openInSidePane : undefined,
  };
}
