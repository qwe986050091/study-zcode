// ══════════════════════════════════════════════════════════════════════════
// 文件头：本文件维持 / 依赖的不变量
//
// Root 是应用唯一的装配点：Provider 顺序、启动期一次性副作用、鉴权门禁、路由分支
// 全在这里决定。它本身几乎没有业务逻辑，因此所有注释只在解释「顺序与生命周期」，
// 因为这类代码的错误不会在编译期暴露，只会在冷启动、二次挂载、Web/桌面分叉时
// 表现为白屏、重复订阅或状态被覆盖。下面是被多轮 bugfix 反推出来的前提。
// 阅读顺序：INV-1..5（Provider 顺序）→ INV-6..10（启动门禁）→
// INV-11..16（副作用与清理）→ INV-17..22（登录/主题/兜底）。
//
// INV-1: Provider 只能从外到内「服务 → 平台 → store → tab → 目录 → 能力开关」递增依赖 —— 破坏后果：内层 Provider 在挂载期读不到外层 context，hook 抛错导致整棵树白屏。
// INV-2: ServiceProvider 必须在所有消费 services 的 Provider 之外 —— 破坏后果：子组件拿到 undefined service，首个 effect 里直接 TypeError。
// INV-3: StoreProvider 必须在 TabStoreProvider 之外 —— 破坏后果：tab 恢复逻辑依赖用户态，顺序颠倒时恢复出未登录状态的 tab 集合。
// INV-4: TooltipProvider 与 LucideProvider 必须包住全部 UI —— 破坏后果：局部重新挂载的 tooltip 各自建 Radix 上下文，大会话下卡顿且 strokeWidth 回退成 2。
// INV-5: RequestSecurityHost 与 MarketingTouchProvider 的顺序不可交换 —— 破坏后果：安全校验请求在营销埋点初始化前发出，被当成匿名流量丢弃。
// INV-6: 启动 loading 的判据必须同时包含 auth 恢复、provider 同步、tab 恢复、初始 workspace —— 破坏后果：任一条件漏判都会先渲染空 Shell，再跳成真实界面（闪白）。
// INV-7: provider 登录门禁只能在「自己拥有」的 startup-provider-required 上收尾 —— 破坏后果：无条件清空会覆盖 session-expired，用户刚被登出又被送回工作区。
// INV-8: canRestoreWorkspaceSession 必须把 provider 启动检查算进去 —— 破坏后果：未连接账号时先恢复 tab，ChatView 预热草稿并在登录页背后报错。
// INV-9: isDesktop 上的 reporter 注册必须有清理函数，且 Web 端必须显式传 null —— 破坏后果：热更新重复注册导致埋点翻倍，或 Web 端写空实现时报错。
// INV-10: 全局广播监听的清理必须 dispose 到具体的 subscription —— 破坏后果：窗口二次挂载后每条广播被处理两次，跨窗口偏好被反复同步。
// INV-11: 一次性启动副作用必须用 ref 去重（launchReported / didRequestFallback / acknowledgingReleaseNotes） —— 破坏后果：React 严格模式下双执行，重复上报或重复创建 workspace。
// INV-12: 启动期异步副作用必须用 mounted ref 而不是 effect cleanup 作为取消标记 —— 破坏后果：cleanup 先跑导致 finally 被跳过，loading gate 永远为 true。
// INV-13: 兜底创建默认 workspace 之后必须按最新 activeWorkspacePath 再判一次 —— 破坏后果：迟到的默认项目抢走用户上次恢复的 tab。
// INV-14: nativeTheme 同步必须等启动壳真正退出后再开启 —— 破坏后果：macOS vibrancy 被应用主题提前改写，启动背景闪一下。
// INV-15: 设备返回（deviceAdditionReturn）必须用引用相等判定「还是不是当前 owner」 —— 破坏后果：迟到的连接结果把用户从新页面导航走，或复用到期的返回目标。
// INV-16: 取消类结果必须同时撤销在途 owner 与 completion 标记 —— 破坏后果：取消后又收到一次成功回调，重新打开已关闭的对话。
// INV-17: 远端项目意图用 epoch 版本号作废旧请求，不能只看 isCurrent 快照 —— 破坏后果：等待远端 IO 的副作用在用户换目录后仍然提交。
// INV-18: 关闭 active context 的请求必须先派发可取消事件，再回落到关窗 —— 破坏后果：side pane 有内容时直接关窗，用户丢失当前编辑。
// INV-19: 更新说明必须是「静默 ack」，不能写入展示状态 —— 破坏后果：每次自动更新都强制弹窗打断，pending 残留到下次启动。
// INV-20: 每个路由分支都必须保留 rootModelSelectionErrorNode 与 dialog 节点 —— 破坏后果：模型选型读取失败时提示被吞掉，用户看不到也无法重试。
// INV-21: 非桌面入口在没有 workspaceShellPath 时必须返回入口 loading，不能返回 null —— 破坏后果：浏览器露出白底，看起来像崩溃。
// INV-22: 远程 connection 的日志只能在「从空闲进入进行中」时重置一次 —— 破坏后果：每次进度更新都清空日志，用户看不到失败前的步骤。
// ══════════════════════════════════════════════════════════════════════════
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { RemoteProjectPicker } from "@/project-sidebar/RemoteProjectPicker.js";
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import type { RemoteProjectHost } from "@zcode/services";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { RemoteConnectionProgressProvider } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
/* eslint-disable max-lines -- Root 当前集中编排启动、workspace shell wiring 和 Web 远控同步，先保持入口收口避免跨层状态拆散。 */
import { RemoteProjectPresentationProvider } from "@/hooks/RemoteProjectPresentationContext.js";
import {
  RequestSecurityHost,
  RequestSecurityWorkspaceBridge,
  setRequestSecurityReporter,
} from "@/request-security-edition/index.js";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LucideProvider, RefreshCw } from "lucide-react";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  DesktopCommandIds,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
} from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider, useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  readComposerWorkspaceScope,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import {
  useDynamicWorkflowAvailabilityLoader,
  useDynamicWorkflowUserModeSync,
} from "@/hooks/useDynamicWorkflowAvailability.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { attachRemoteProjectWorkspace, resolveEntryProject } from "@/project-sidebar/index.js";
import { useTabPersistence, type WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import { useTokenRefresh } from "@/hooks/useTokenRefresh.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SSHDialog } from "@/SSHDialog.js";
import { SettingsPage } from "@/SettingsPage.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RewardsProvider } from "@/rewards/RewardsProvider.js";
import { WelcomeScreen, type LoginCompleteReason } from "@/WelcomeScreen.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { readRendererLaunchTimings, shouldReportLaunchToInput } from "@/lib/launchToInputReport.js";
import { reportUiLaunchToInput } from "@/lib/uiPerfArmsTelemetry.js";
import {
  isProviderStartupSyncPending,
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";
import { StoreProvider, useZCodeStore } from "@/store/StoreProvider.js";
import { setMcpStorePlatform } from "@/store/mcpStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isSettingsTab, isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { RootShell } from "@/root/RootShell.js";
import { RootWorkspaceContent } from "@/root/RootWorkspaceContent.js";
import { resolveConversationWorkspaceTarget } from "@/conversation-workspace-target/index.js";
import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { OccupationOnboarding } from "@/onboarding/OccupationOnboarding.js";
import { OnboardingDialog } from "@/onboarding/OnboardingDialog.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRemoteWorkspaceTabLifecycle } from "@/root/useRemoteWorkspaceTabLifecycle.js";
import { RemoteWorkspaceControllerProvider } from "@/remote/useRemoteWorkspaceController.js";
import { useRootProviderStateRefresh } from "@/root/useRootProviderStateRefresh.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useRootProviderSettingsSnapshot } from "@/root/useRootProviderSettingsSnapshot.js";
import { useWebRemoteControlAuthSync } from "@/web-remote-control/app/useWebRemoteControlAuthSync.js";
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";
import { consumeZcodeJwtInvalidRestartMarker } from "@/root/zcodeJwtInvalidRestartMarker.js";
import { useDesktopNativeThemeSync } from "@/root/useDesktopNativeThemeSync.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useBotBroadcastEffects } from "@/root/useBotBroadcastEffects.js";
import { registerBaseWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import type { RootProps } from "@/root/types.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import {
  WebRemoteControlFeatureProvider,
  useWebRemoteControlFeatureEnabled,
} from "@/WebRemoteControlFeatureProvider.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import {
  CODE_COMMENT_REMOVE_BROADCAST_CHANNEL,
  CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL,
  isCodeCommentPayload,
  isCodeCommentRemovePayload,
  markCodeCommentRemoved,
} from "@/lib/codeCommentContext.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { MarketingTouchProvider } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
import { setSessionOpenArmsReporter } from "@/lib/sessionOpenArmsTelemetry.js";
import { setSendFunnelArmsReporter } from "@/lib/sendFunnelArmsTelemetry.js";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";
import { ensureProviderFamilyDomainMigration } from "@/lib/providerFamilyDomainMigration.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT } from "@/lib/closeActiveContext.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  disposeConversationTelemetrySupervisors,
  reconcileConversationTelemetryWorkspaceScopes,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import { installConversationTelemetryParityE2EBridge } from "@/v4/telemetry/conversationTelemetryParityE2E.js";
import { useSourceServerUpdateNotifications } from "@/root/sourceServerUpdateNotifications.js";
import type {
  DeviceAdditionResult,
  DeviceAdditionReturnTarget,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";

// 常量而不是内联字面量：这个值同时决定「图标看起来多粗」，各处显式传 strokeWidth
// 的图标可以覆盖它，但默认值只能有一份。改内联会让某个子树的图标悄悄变粗。
const DEFAULT_LUCIDE_STROKE_WIDTH = 1.5;
// 用联合类型而不是 string：这些 reason 控制整棵树的渲染分支（登录页 / 启动页 / 主界面），
// 写错一个字母在 TS 里会变成永不命中的分支，界面上表现为停留在白屏。
type WelcomeScreenOpenReason =
  | "startup-provider-required"
  | "manual-login"
  | "provider-request"
  | "logout-provider-required"
  | "session-expired";

/**
 * Root —— 应用根组件
 *
 * 外层挂载 StoreProvider（连接广播服务）+ TabStoreProvider，内层处理认证和路由。
 */
export function Root(props: RootProps) {
  // 这一层刻意不放任何 hook 与副作用：它只负责把 Provider 树固定下来。
  // [并发] React 严格模式下本组件会挂载两次，任何在这里注册的全局监听都会翻倍，
  // 所以所有副作用都下沉到 RootInner（那里有明确的依赖数组与清理）。
  //
  // Provider 顺序是「依赖方向」而不是审美：
  // 1. Lucide / Tooltip 必须最外层——它们给所有后代提供视觉上下文；
  // 2. ServiceProvider 提供 services，之后所有 hook 才能取到服务；
  // 3. PlatformProvider 决定 isDesktop 分支，必须早于依赖平台的 store 初始化；
  // 4. StoreProvider 承载用户/主题/广播，TabStoreProvider 依赖它做恢复；
  // 5. 目录与能力开关（ProjectDirectory / DiffsWorker / WebRemote / CodeComment）
  //    只被 RootInner 之后的内容消费，放内层可以避免启动期就创建 worker；
  // 6. Rewards / MarketingTouch / RemoteConnectionProgress 是最内层的展示能力。
  // 把任意一层向内移，都会让「启动期不创建」变成「启动期创建」，破坏首次渲染时序。
  return (
    <LucideProvider strokeWidth={DEFAULT_LUCIDE_STROKE_WIDTH}>
      {/*
       * 之前通过 lucide.tsx 包装每个图标，把默认 strokeWidth 固定成 1.5。
       * 现在移除包装文件后，如果不在根层统一注入，按钮、列表和工具栏里的 Lucide 图标会回退到 2，
       * 导致同一套 size class 下视觉显得更粗、更挤。这里改用官方 LucideProvider 保持默认值，
       * 同时保留个别图标显式传入 strokeWidth 时的覆盖能力。
       */}
      <TooltipProvider>
        {/*
         * 大会话消息动作里会出现大量 tooltip。Provider 如果跟随每个 tooltip 实例创建，
         * React 点击切换任务时会同步构造数量级相同的 Radix 上下文树；根层共享一次即可保留零延迟配置。
         */}
        <ServiceProvider
          services={props.services}
          composerClientNamespace={props.composerClientNamespace}
        >
          <PlatformProvider platform={props.platform}>
            <StoreProvider
              broadcastService={props.services.broadcastService}
              initialIsRestoringOAuthSession
            >
              <TabStoreProvider>
                <ProjectDirectoryProvider isDesktop={props.isDesktop}>
                  <DiffsWorkerPoolProvider>
                    <WebRemoteControlFeatureProvider enabled={props.webRemoteControlFeatureEnabled}>
                      <AssistantCodeCommentFeatureProvider
                        enabled={props.assistantCodeCommentCardsEnabled}
                      >
                        <CodingPlanUpgradeDialogProvider>
                          <RewardsProvider desktop={props.isDesktop === true}>
                            <RequestSecurityHost />
                            <MarketingTouchProvider desktop={props.isDesktop === true}>
                              <RemoteConnectionProgressProvider>
                                <RootInner {...props} />
                              </RemoteConnectionProgressProvider>
                            </MarketingTouchProvider>
                          </RewardsProvider>
                        </CodingPlanUpgradeDialogProvider>
                      </AssistantCodeCommentFeatureProvider>
                    </WebRemoteControlFeatureProvider>
                  </DiffsWorkerPoolProvider>
                </ProjectDirectoryProvider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    </LucideProvider>
  );
}

function RootInner({
  services,
  platform,
  initialWorkspaceAbsPath,
  unavailableWorkspacePath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  initialTaskDraft,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  restoreSession = true,
  supportsSettings = true,
  allowOpenWorkspace = true,
  preferDirectoryBrowser,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
  allowRemoteWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  initialWorkspaceLoadingFallback,
}: RootProps) {
  // 下面这些 props 全部带默认值：测试入口常常只传 services/platform，
  // 若在这里出现 undefined 分支，每一处消费点都要重复兜底，遗漏一次就是渲染崩溃。
  // [资源] 五个 reporter 都是模块级单例：set* 写入全局，注册者必须成对清理。
  // 依赖数组只有 isDesktop / platform 而不是整个 props，是为了避免 RootInner 因
  // 业务 props 变化（tab、workspace）反复重注册，造成埋点计数翻倍（INV-9）。
  useEffect(() => {
    setRequestSecurityReporter(platform);
    setMcpStorePlatform(platform);
    // 对话 UI perf 只属于 desktop-continuous；Web/mobile 即使能看到权威状态也不装 reporter。
    setUiPerfArmsReporter(isDesktop ? platform : null);
    setSessionOpenArmsReporter(isDesktop ? platform : null);
    // 发送漏斗同理：只在 Electron 桌面端上报，Web/mobile 的 reportArmsCustomEvent 是空实现。
    setSendFunnelArmsReporter(isDesktop ? platform : null);
    return () => {
      // 必须逐个写回 null 而不是只清一个：五个单例各自独立，漏清任何一个都会
      // 在下一个窗口/下一次挂载里指向已经销毁的 platform 对象。
      setRequestSecurityReporter(null);
      setMcpStorePlatform(null);
      setUiPerfArmsReporter(null);
      setSessionOpenArmsReporter(null);
      setSendFunnelArmsReporter(null);
    };
  }, [isDesktop, platform]);

  // E2E 桥必须在最早期安装：它要在真实业务动作发生前就接管 parity 场景。
  // 返回值就是卸载函数，因此这里用隐式返回而不是再包一层 effect body。
  // 顺序上它排在 reporter 注册之后：桥内部会通过 reporter 发送帧，
  // 若先装桥后注册，桥在安装瞬间发出的合成帧会因为 reporter 为空被丢弃。
  useEffect(
    () =>
      installConversationTelemetryParityE2EBridge({
        platform,
        // 传布尔而不是三态：桥内部用它决定是否注册桌面专属通道，
        // undefined 会被当成 false，导致桌面测试入口漏掉桥接。
        isDesktop: isDesktop === true,
      }),
    [isDesktop, platform],
  );

  // [资源] 卸载时只销毁 supervisor，不 dispose 具体 workspace scope：
  // scope 是跨窗口共享的，本窗口退出不应清掉另一个窗口仍在用的订阅。
  // 失败/成功都用同一条清理路径，避免 supervisor 表随窗口切换累积。
  useEffect(
    () => () => {
      disposeConversationTelemetrySupervisors();
    },
    [],
  );

  // 动态工作流灰度快照的唯一取数点：
  // 放在 app 级 ServiceProvider 这一层取一次，自动化页与 run 面板只读。消费方可能位于
  // 工作区级 ServiceProvider 内（远程 Host 的 accessor），由它们取数会拿到另一台 Host 的答案。
  useDynamicWorkflowAvailabilityLoader(services.codingPlanSubscriptionService);

  const { intl, locale } = useZCodeIntl();
  // 这个 hook 同时承担「订阅更新通知」与「返回变更回调」两件事：
  // 返回值会传给远端连接对话框，不能在这里解构丢弃。
  const handleRemoteConnectionTargetChange = useSourceServerUpdateNotifications({
    enabled: isDesktop === true,
    management: services.sourceServerManagementService,
  });
  // [权衡] 逐字段用选择器而不是解构整个 store：Root 会订阅 store 的任何变化，
  // 一次全量订阅会让整个应用根部在每次消息流式更新时重渲染。
  const theme = useZCodeStore((state) => state.theme);
  const user = useZCodeStore((state) => state.user);
  const isRestoringOAuthSession = useZCodeStore((state) => state.isRestoringOAuthSession);
  // Web 远控的鉴权同步必须在 OAuth 恢复完成前就挂上，否则「恢复中」这一帧
  // 会被当成未登录，回传断开导致 WRC 端掉线。
  useWebRemoteControlAuthSync(platform, services.oauthService, user?.id, isRestoringOAuthSession);
  const setUser = useZCodeStore((state) => state.setUser);
  const setIsRestoringOAuthSession = useZCodeStore((state) => state.setIsRestoringOAuthSession);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const oauthPollingActive = useZCodeStore((state) => state.oauthPollingActive);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);
  const markOAuthSuccess = useZCodeStore((state) => state.markOAuthSuccess);
  const {
    settings: appSettings,
    refresh: refreshAppSettings,
    update: updateAppSettings,
  } = useSettings();
  // docs/dynamic-workflow/launch.md「The user's choice」：设置里的动态工作流选择变化后，通知本窗口
  // 的 Host 重发 CLI 策略（并转发给远程 Host），再重读灰度快照。
  useDynamicWorkflowUserModeSync({
    settingsLoaded: Boolean(appSettings),
    userMode: appSettings?.dynamicWorkflowMode,
    zcodeAgentService: services.zcodeAgentService,
    codingPlanSubscriptionService: services.codingPlanSubscriptionService,
  });
  const [welcomeScreenOpenReason, setWelcomeScreenOpenReason] =
    useState<WelcomeScreenOpenReason | null>(() =>
      // 惰性初始化只执行一次：读「上次是否因 JWT 失效重启」的标记文件。
      // 若写成普通表达式，每次渲染都会消费标记（该函数有副作用），第二次就成为 null。
      consumeZcodeJwtInvalidRestartMarker() ? "session-expired" : null,
    );
  // 迁移完成的布尔量是本文件最关键的门禁输入之一：它的初值必须是 false，
  // 即使迁移失败也要在 finally 里置 true，否则 provider 门禁永远等不到这一天（INV-6）。
  const [providerFamilyDomainMigrationComplete, setProviderFamilyDomainMigrationComplete] =
    useState(false);
  const loginEntryRequest = useZCodeStore((state) => state.loginEntryRequest);
  const rootModelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  // 只有 ready 才给下游 view：loading 与 error 都视为「还没有结论」，
  // 把半成品 view 传下去会让 provider 可用性判断基于空模型列表得出结论。
  const rootModelSelectionView =
    rootModelSelectionRead.state.status === "ready" ? rootModelSelectionRead.state.view : null;
  // 错误节点在四个路由分支里都要渲染（INV-20）：模型选型是所有会话的前提，
  // 读取失败时用户必须能看到原因与重试入口，而不是一个空白主界面。
  const rootModelSelectionErrorNode =
    rootModelSelectionRead.state.status === "error" ? (
      <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={rootModelSelectionRead.reload}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    ) : null;
  // 这个回调给重试按钮用：它直接读 service 的最新 view，而不是复用上面的状态。
  // 复用状态会在「点击重试」与「重新渲染」之间产生一帧旧值，用户看到按钮没反应。
  const readRootModelSelectionView = useCallback(
    () => services.modelSelectionService.getView(),
    [services.modelSelectionService],
  );
  // 这组 state 全部是「连接流程的瞬时状态」，刻意不放进 tab store：
  // 它们属于当前窗口的一次交互，持久化后重开会重新弹出对话框。
  const [remoteConnectionDialogOpen, setRemoteConnectionDialogOpen] = useState(false);
  const [remoteConnectionOpenPreference, setRemoteConnectionOpenPreference] =
    useState<RemoteConnectionOpenPreference | null>(null);
  // intentId 是给对话框的「重新打开」信号：值相同则对话框认为还是同一次意图，
  // 不会重置内部表单；递增一次就表示用户从新入口进来。
  const [remoteConnectionOpenIntentId, setRemoteConnectionOpenIntentId] = useState(0);
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [remoteConnectionInProgress, setRemoteConnectionInProgress] = useState(false);
  // requestId 用来把日志与一次具体连接绑定：没有它，多次重连的日志会混在一起。
  const [remoteConnectionRequestId, setRemoteConnectionRequestId] = useState<string | null>(null);
  const [isCreatingFallbackWorkspace, setIsCreatingFallbackWorkspace] = useState(false);
  const { connectionLogs: remoteConnectionLogs, resetConnectionLogs: resetRemoteConnectionLogs } =
    useRemoteConnectionLogs(remoteConnectionRequestId);
  // 初值取决于入口是否直接给了路径：给了就一定要先 bootstrap，否则首帧会短暂
  // 显示「没有 workspace」的中间态（INV-21 的同一类问题）。
  const [isBootstrappingInitialWorkspace, setIsBootstrappingInitialWorkspace] = useState(
    Boolean(initialWorkspaceAbsPath),
  );
  // 这三个 ref 是「一次性动作」的守卫（INV-11）：
  // acknowledgingReleaseNotes 防止重复 ack，previousInProgress 用于检测边沿，
  // didRequestFallback 保证兜底创建只发起一次。
  const acknowledgingReleaseNotesVersionRef = useRef<string | null>(null);
  const previousRemoteConnectionInProgressRef = useRef(false);
  const didRequestFallbackWorkspaceRef = useRef(false);
  // mounted ref 的初值必须是 true：它由下面的 effect 在卸载时置 false，
  // 而首次渲染时还没有执行任何 effect（INV-12）。
  const rootInnerMountedRef = useRef(true);
  const [hasEnteredNativeThemeSyncSurface, setHasEnteredNativeThemeSyncSurface] = useState(false);

  useEffect(() => {
    // 空依赖、只做清理：这个 effect 的作用就是登记「我卸载了」。
    // 不能把置位逻辑放到 cleanup 之外，否则重挂载时会复用同一个 ref 对象。
    return () => {
      rootInnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // 一个 effect 处理三条广播是刻意的：它们都写入 renderer 级 store，若拆成三个
    // effect，依赖数组会分别包含 refreshAppSettings / bots / agent，任一变化都会
    // 让局部重订阅，而重订阅期间漏掉的广播不会重放（INV-10）。
    const disposable = services.broadcastService.onMessage((message) => {
      // 三个分支都用 early return 串行判定，而不是 switch：channel 常量来自不同模块，
      // 未来新增 channel 时漏写分支只会「不处理」，不会误落到最后一个分支。
      if (message.channel === APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL) {
        // 跨版本窗口可能发来旧形状，必须先 safeParse：直接 as 会让坏数据进入两个
        // service 的 sync，产生「一边更新一边没更新」的半同步状态。
        const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(
          message.payload,
        );
        if (!parsed.success) {
          // 丢弃但只记 issue，不上报错误：这是对端版本问题，本窗口无法修复，
          // 弹错只会让用户看到无法处理的提示。
          logger.warn("[settings] 丢弃无效的运行时偏好广播", {
            issues: parsed.error.issues,
          });
          return;
        }
        // 两个 sync 分别 catch：一个服务失败不应阻止另一个更新，
        // 否则 agent 与 bots 的偏好会长期不一致。
        void refreshAppSettings();
        void services.zcodeAgentService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口运行时偏好失败", error);
        });
        void services.botsService.syncAppRuntimePreferences(parsed.data).catch((error) => {
          logger.warn("[settings] 同步跨窗口 Bot 运行时偏好失败", error);
        });
        return;
      }

      if (message.channel === CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL) {
        // id 必须存在：restore 是「按 id 挂回预览」，没有 id 的 payload 无法定位
        // 任何 comment，强行处理会在 store 里创建一条无主记录。
        if (!isCodeCommentPayload(message.payload) || !message.payload.id) {
          return;
        }
        useCodeCommentPreviewStore.getState().restoreCommentFromAttachment({
          ...message.payload,
          id: message.payload.id,
        });
        return;
      }

      if (message.channel !== CODE_COMMENT_REMOVE_BROADCAST_CHANNEL) {
        return;
      }

      if (!isCodeCommentRemovePayload(message.payload)) {
        return;
      }

      // 关闭文件 tab 后 PreviewPane 会卸载，不能再依赖 PreviewPane 自己监听跨窗口清理事件。
      // 这里在 Root 生命周期内同步清理 renderer 级 preview store，避免发送后重新打开文件又恢复旧 comment。
      // 两处清理是互补的：markCodeCommentRemoved 更新「已删除集合」（用于后续 restore 拒绝），
      // removeCommentBySource 清掉当前预览缓存。只做后者，迟到的 restore 广播会把已删的评论复活。
      markCodeCommentRemoved(message.payload);
      useCodeCommentPreviewStore.getState().removeCommentBySource(message.payload);
    });

    return () => {
      disposable.dispose();
    };
  }, [
    refreshAppSettings,
    services.botsService,
    services.broadcastService,
    services.zcodeAgentService,
  ]);

  useEffect(() => {
    if (!appSettings) {
      // appSettings 未加载时直接返回：此时两个偏好都是「未知」，
      // 若按默认值同步，会把用户已保存的 false/true 覆盖成默认（INV-6 同类问题）。
      return;
    }
    // 两个 service 各发一次、互不 await：它们是不同进程方向的通道，
    // 串行只会让启动多等一个 RTT，而失败已分别 catch。
    // 注意默认值方向不同（!== false vs === true）：前者默认开启、后者默认关闭，
    // 这是产品口径，不是笔误；改成同向会让 model IO 留存默认被打开。
    void services.zcodeAgentService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化运行时偏好失败", error);
      });
    void services.botsService
      .syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled:
          appSettings.askUserQuestionAutoResolutionEnabled !== false,
        modelIoFullRetentionEnabled: appSettings.modelIoFullRetentionEnabled === true,
      })
      .catch((error) => {
        logger.warn("[settings] 初始化 Bot 运行时偏好失败", error);
      });
  }, [
    appSettings?.askUserQuestionAutoResolutionEnabled,
    appSettings?.modelIoFullRetentionEnabled,
    services.botsService,
    services.zcodeAgentService,
  ]);

  const tabs = useTabStore((state) => state.tabs);
  // 过滤出 workspace tab 后再 resolve shell target：settings / 欢迎页 tab 没有路径，
  // 混进来会让 resolveRootWorkspaceShellTarget 选中一个无法 bootstrap 的 tab。
  const windowWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  // 用 id 去 tabs 里再查一次而不是直接用 activeTab 对象：tab store 的 tabs 数组
  // 是不可变替换，activeTabId 与 tabs 之间可能有一帧不同步（关闭 tab 时），
  // 直接引用旧对象会渲染一个已不存在的 tab。
  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;
  const activeWorkspaceTab = activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
  const isSettingsTabActive = activeTab ? isSettingsTab(activeTab) : false;
  const {
    workspaceShellPath,
    workspaceIdentity: workspaceShellIdentity,
    workspaceRemoteSessionId: workspaceShellRemoteSessionId,
  } = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    // Settings 覆盖时仍使用被覆盖 tab 的完整远程身份，避免通知与侧栏建立重复订阅。
    workspaceTabs: windowWorkspaceTabs,
  });
  const workspaceScopedServices = useWorkspaceServices(
    workspaceShellPath,
    workspaceShellRemoteSessionId,
    workspaceShellIdentity,
  );

  // 这个 selector 只服务远端连接对话框的「默认本地路径」。它必须排除四类 tab：
  // 远程会话、远程目标、带 identity 的 tab、以及 purpose=conversation 的会话页。
  // 少排除一类，对话框就会把远端路径当成可连接的本地目录，用户点了之后才发现失败。
  const localWorkspacePathForRemoteConnection = useTabStore((state) => {
    const activeTab = state.activeTabId
      ? state.tabs.find((tab) => tab.id === state.activeTabId)
      : null;
    if (
      !activeTab ||
      !isWorkspaceTab(activeTab) ||
      activeTab.remoteSessionId ||
      activeTab.remoteTarget ||
      activeTab.workspaceIdentity ||
      activeTab.workspacePurpose === "conversation"
    ) {
      return undefined;
    }
    return activeTab.workspacePath;
  });
  // 三个 store 引用与 api 在 Root 生命周期内稳定不变，放进依赖数组只会无谓重建；
  // addTab / activateTabByPath 供下面的设备返回与远端流程改写 tab 集合。
  const addTab = useTabStore((state) => state.addTab);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const tabStoreApi = useTabStoreApi();
  // [并发] deviceAdditionReturn 用 ref 而不是 state：它记录的是「一次导航意图」，
  // 更新它不需要重渲染；用 state 会让每次连接结果都触发整树重渲染。
  // owner 的判定方式是「引用相等」而不是 id 相等（INV-15）——同一次设备连接可能
  // 被新入口替换成结构相同但对象不同的 pending，id 相等会让旧结果仍然导航。
  const deviceAdditionReturn = useRef<{
    target: DeviceAdditionReturnTarget;
    completion?: "checking" | "delivered";
    tabId: string | null;
    workspaceKey?: string;
  } | null>(null);
  const finishDeviceAddition = useCallback(
    async (
      result: DeviceAdditionResult,
      background = false,
      canDeliver: () => boolean = () => true,
    ) => {
      const pending = deviceAdditionReturn.current;
      // 同步消费；异步资格校验仍保留同一 owner 标识，新入口替换后旧结果无权导航。
      if (!pending) return false;
      // [失败路径] 已经 delivered 的连接结果直接视为成功：重复回调（IPC 重发、
      // 用户连点）不能触发第二次导航，否则会覆盖用户已经切到的页面（INV-16）。
      if (pending.completion && result.kind === "connected") return true;
      // 先占位 checking 再 await：在 await 期间可能有第二个结果进来，
      // 这里必须先标记，才能让第二个结果知道自己不是唯一的执行者。
      pending.completion = "checking";
      const isCurrent = () =>
        deviceAdditionReturn.current === pending && pending.target.isCurrent();
      const deliver = (value: DeviceAdditionResult, inBackground: boolean) => {
        // 三重校验缺一不可：
        // 1) 仍是同一个 pending（没有被新入口替换）；
        // 2) target 仍认为自己是当前目标（用户没手动导航走）；
        // 3) tab 仍存在且 workspaceKey 未变（tab 没被关闭或改绑）。
        // 任一不成立都静默放弃——错误提示由发起方负责，这里再报会重复。
        if (!isCurrent()) return;
        const tabs = tabStoreApi.getState();
        const tab = tabs.tabs.find((item) => item.id === pending.tabId);
        // workspaceKey 优先用 identity：同路径的两个远端 workspace 只有 identity 能区分，
        // 用 path 比较会把它们视为同一个目标，从而把用户带到错误的分支。
        const workspaceKey =
          tab?.kind === "workspace"
            ? tab.workspaceIdentity?.trim() || tab.workspacePath
            : undefined;
        if ((pending.tabId && !tab) || pending.workspaceKey !== workspaceKey) return;
        // 后台结果不切 tab：设备连接可能在用户操作别的窗口时完成，
        // 此时强行激活 tab 会把用户从当前工作里拽走。
        if (pending.tabId && !inBackground) tabs.activateTab(pending.tabId);
        logger.debug("[Root] return from device addition", {
          kind: value.kind,
          tabId: pending.tabId,
        });
        pending.completion = "delivered";
        return pending.target.finish(value);
      };
      try {
        if (result.kind === "connected" && pending.target.canFinish) {
          const valid = await pending.target.canFinish(result);
          if (!isCurrent()) return true;
          if (!valid) {
            await deliver({ kind: "cancelled", background: true }, true);
            return true;
          }
        }
        if (result.kind === "connected" && !canDeliver()) {
          // 资格校验不通过时把 completion 还原成 undefined，而不是直接置 delivered：
          // 这条结果没有导航，用户稍后仍可能从同一入口重试（INV-16 的另一半）。
          pending.completion = undefined;
          return true;
        }
        const finished = deliver(result, background);
        // 显式取消必须撤销在途校验；迟到成功不能再使用同一返回引用恢复旧聊天。
        // 只有「仍是我」才置空：新入口已经替换 pending 时置空会误删别人的意图。
        if (result.kind === "cancelled" && deviceAdditionReturn.current === pending)
          deviceAdditionReturn.current = null;
        await finished;
      } catch (error) {
        // [失败路径] 这是「读取失败」而不是「用户取消」：两者在 UI 上都是失败态，
        // 但只有取消才应丢弃返回目标，读取失败要保留它以便重试。
        if (!isCurrent()) return true;
        // 读取失败不是取消。保留原 owner 和禁发约束，让连接 flow 显示原因并提供重试/取消。
        // completion 复位成 undefined，让下一次结果还能再执行一轮资格校验。
        pending.completion = undefined;
        throw error;
      }
      return true;
    },
    [tabStoreApi],
  );
  const webRemoteControlFeatureEnabled = useWebRemoteControlFeatureEnabled();
  // Bugfix: WebRemoteControlDialog 只是可开关的展示入口，不能由它的本地 state 决定全局远控状态。
  // Root 直接轮询 main 进程状态，让远控会话 running/active 成为唯一真值来源。
  const webRemoteControlStatus = useWebRemoteControlStatus({
    enabled: Boolean(webRemoteControlFeatureEnabled && isDesktop),
  });
  const webRemoteControlSessionActive =
    webRemoteControlStatus.status === "running" || webRemoteControlStatus.status === "active";
  const refreshProviderState = useRootProviderStateRefresh(services);
  useRootProviderSettingsSnapshot(services);
  useEffect(() => {
    // disposed 是「本 effect 的代际标记」，不是 mounted：它只关心这次异步流程
    // 是否已被下一次依赖变化取代，因此比 rootInnerMountedRef 更精确（INV-12）。
    let disposed = false;

    void (async () => {
      // 迁移必须在设置 complete 之前完成：complete=true 会放行 provider 门禁，
      // 而门禁判断依赖迁移后的 domain 字段，提前放行会读到旧 domain。
      try {
        await ensureProviderFamilyDomainMigration(services);
      } catch (error) {
        // [失败路径] 迁移失败仍然继续启动：这一步是兼容旧数据，失败时旧数据只是
        // 不被改写，不应阻塞用户进入主界面；错误留给日志与后续重试。
        logger.warn("[Root] provider family domain 迁移失败，继续启动", {
          error,
        });
      } finally {
        // finally 而不是 try 末尾：即使迁移抛错也必须把门禁标记置 true，
        // 否则 provider 启动检查永远 pending，整个应用停在启动页（INV-6）。
        if (!disposed) {
          setProviderFamilyDomainMigrationComplete(true);
          // 两个 refresh 用同一 try：它们刷新的是同一份可用性视图，
          // 任一失败都只记录，不改变已经放行的门禁。
          try {
            await refreshAppSettings();
            await refreshProviderState();
          } catch (refreshError) {
            logger.warn("[Root] provider family domain 迁移后刷新状态失败", {
              error: refreshError,
            });
          }
        }
      }
    })();

    // 依赖里带 services 而不是空数组：服务实例在测试/Web 入口可能被替换，
    // 沿用旧实例会让迁移写到一个已经被丢弃的 store。
    return () => {
      disposed = true;
    };
  }, [refreshAppSettings, refreshProviderState, services]);

  // 以下派生布尔值必须在同一次渲染里由 props 与已恢复状态算出：
  // 下游用它们决定「是否注册桌面通道」「门禁是否已放行」，若改成 effect 里
  // setState 再读回，首帧就会拿到上一轮的旧值，造成一帧错误分支。
  const shouldPreferDirectoryBrowser = Boolean(preferDirectoryBrowser);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const isResolvingStartupAuthState = isRestoringOAuthSession;
  // 可用性必须从模型选型「视图」派生而不是直接查服务：视图带上了加载中/报错
  // 两种中间态，直接查服务会把 undefined 解释成「没有 provider」，从而误弹登录门禁。
  const rootProviderAvailability = resolveProviderAvailabilityState({
    modelSelectionView: rootModelSelectionView,
  });
  // 模型选型读取失败也要视为「已 hydrated」：否则一次读取失败会让 provider 同步
  // 永远 pending，用户既看不到错误提示，也没有重试入口（INV-6 的失败路径）。
  const providerStartupSyncPending = isProviderStartupSyncPending({
    providerFamilyDomainMigrationComplete,
    modelSelectionViewHydrated:
      rootProviderAvailability.hydrated || rootModelSelectionRead.state.status === "error",
  });
  // 用 switcher 是否存在判断「这是 Web 远控根」而不是新增布尔 prop：
  // 只有 WRC 入口会注入 switcher，多一个 prop 就多一处可能与实际入口不一致的状态。
  const isWebRemoteControlRoot = Boolean(webRemoteControlWorkspaceSwitcher);
  // 门禁是否启用只看「是不是 Web 远控根」：Web 端没有本地 provider 概念，
  // 启用后会把用户永久挡在启动页，而不是像桌面端那样帮用户补配置。
  const providerAvailabilityLoginEntryGuardEnabled =
    shouldEnableProviderAvailabilityLoginEntryGuard({
      isWebRemoteControlRoot,
    });
  const { startupCheckCompleted: providerAvailabilityStartupCheckCompleted } =
    useProviderAvailabilityLoginEntryGuard({
      enabled: providerAvailabilityLoginEntryGuardEnabled,
      user,
      isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
      providerFamilyDomain: appSettings?.providerFamilyDomain,
      modelSelectionView: rootModelSelectionView,
      modelSelectionError:
        rootModelSelectionRead.state.status === "error"
          ? rootModelSelectionRead.state.error
          : undefined,
      refreshProviderState,
      readModelSelectionView: readRootModelSelectionView,
      setLoginEntryOpen: (open) => {
        setWelcomeScreenOpenReason((currentReason) => {
          if (open) {
            return "startup-provider-required";
          }
          // JWT 过期提示确认后会先写入 session-expired，随后 provider
          // 启动门禁以 open=false 收尾。这里若无条件清空，会覆盖重新登录页并回到工作区。
          // 门禁只能关闭自己拥有的启动登录态，不能清理其它交互来源的 reason。
          return currentReason === "startup-provider-required" ? null : currentReason;
        });
      },
    });
  // 三个入参逐一说明：isWebRemoteControlRoot 决定「没有本地 provider 概念」；
  // providerStartupSyncPending 表示配置正在从主进程同步；startupCheckCompleted
  // 表示首次可用性探测已有结论。三者任一为 false/true 都会改变门禁结论，
  // 因此这里必须先算出一个稳定的 isResolvingProviderStartupState，供下面复用。
  const isResolvingProviderStartupState = shouldResolveProviderStartupState({
    // 三个入参缺一不可：Web 远控根没有本地 provider 概念；同步中要等；
    // 启动检查未完成也必须等。少判定任一条件都会在该状态下提前恢复会话。
    isWebRemoteControlRoot,
    providerStartupSyncPending,
    providerAvailabilityStartupCheckCompleted,
  });
  const isStartupProviderLoginEntryOpen = welcomeScreenOpenReason === "startup-provider-required";
  // 首次安装时 provider 登录入口判定晚于 workspace 注入，ChatView 会先 mount 并触发草稿预热。
  // 这里把 provider 启动检查纳入 workspace 恢复门禁，避免未连接账号前启动 ZCode session。
  // 三个否定条件是与关系而不是或关系：任一为 true 都必须拒绝恢复，
  // 否则「登录恢复完成但 provider 未就绪」这一帧仍然会启动 session（INV-8）。
  const canRestoreWorkspaceSession =
    !isResolvingStartupAuthState &&
    !isResolvingProviderStartupState &&
    !isStartupProviderLoginEntryOpen;
  // 先给 canPersist:false 的保守初值，真正的闸门由 useTabPersistence 覆写：
  // 恢复完成前禁止写回，否则会把 active-first 的单 tab 投影落盘成完整集合。
  const workspacePersistenceGate = useMemo<WorkspacePersistenceGate>(
    () => ({ canPersist: false, restoreFailed: false }),
    [],
  );

  useEffect(() => {
    // 跨 workspace 任务列表需要一个稳定的“本地/root services”入口。
    // 桌面端 renderer 启动时会注册一次，但 Web 和测试入口也会直接挂 Root；
    // 这里再以 Root props 兜底注册，避免当前激活远端 workspace 时本地列表误用远端 host。
    // 注册是覆盖式且幂等，因此不需要清理；但必须在远端 workspace 的
    // ServiceProvider 之前执行（Root 层级天然满足），否则已注册的是远端实例。
    registerBaseWorkspaceServices(services);
  }, [services]);

  // Bot 的跨窗口广播副作用独立成 hook：它内部维护多条订阅与轮询，
  // 混在 Root 里会让本组件体积与依赖不可控。这里只传 services 与 tabStoreApi。
  useBotBroadcastEffects(services, tabStoreApi);

  const handleOpenRemoteConnection = useCallback(
    (preference?: RemoteConnectionOpenPreference) => {
      // 带返回目标的入口在「连接进行中」或「还有未完成的返回意图」时直接拒绝。
      // 返回 false 而不是静默打开：调用方据此决定是否切到设备设置页，
      // 静默打开会让用户以为点了没反应，实际上是流程正在忙。
      if (
        preference?.returnTarget &&
        (remoteConnectionInProgress ||
          (deviceAdditionReturn.current && !deviceAdditionReturn.current.completion))
      )
        return false;
      if (!remoteConnectionInProgress) {
        // 新入口替换尚在资格校验的旧返回，先解除旧 owner 的门禁，再使其迟到结果失效。
        // 必须显式 null 覆盖而不是只置 completion：引用相等判定才有意义（INV-15）。
        deviceAdditionReturn.current?.target.onVisibilityChange?.(false);
        const tabs = tabStoreApi.getState();
        const tab = tabs.tabs.find((item) => item.id === tabs.activeTabId);
        deviceAdditionReturn.current = preference?.returnTarget
          ? {
              target: preference.returnTarget,
              // tabId 与 workspaceKey 在此刻快照：连接过程中用户可能切 tab，
              // 结果回来时只有快照仍然一致才允许导航回这个 tab。
              tabId: tabs.activeTabId,
              workspaceKey:
                tab?.kind === "workspace"
                  ? tab.workspaceIdentity?.trim() || tab.workspacePath
                  : undefined,
            }
          : null;
        // 返回目标曾被等同于新增设备，导致已有设备重连也切到设置。
        if (preference?.returnTarget?.kind === "add-device") {
          setPendingSettingsSectionIntent("remoteDevices");
          tabStoreApi.getState().openSettingsTab();
        }
      }
      // 明确入口与卡片恢复分离：空闲流程接受新意图，即使 Profile/目标值相同也重新读取。
      // intentId 每次 +1 就是为了让「同一个 preference」也能触发对话框重新初始化。
      if (!remoteConnectionInProgress) {
        setRemoteConnectionOpenPreference(preference ?? null);
        setRemoteConnectionOpenIntentId((current) => current + 1);
      }
      // 可见性回调放在最后：它依赖上面可能刚替换的 owner，
      // 提前调用会让新 owner 收到两次 visible=true 或旧 owner 再被点亮一次。
      deviceAdditionReturn.current?.target.onVisibilityChange?.(true);
      setRemoteConnectionDialogOpen(true);
    },
    [remoteConnectionInProgress, tabStoreApi],
  );
  const handleOpenDirectoryBrowser = useCallback(() => {
    setDirectoryBrowserOpen(true);
  }, []);
  // `handleReauthenticationRequired` 只写入 `session-expired` 原因，跳转由门禁统一决定。
  // 若这里同时导航，会和「登录态恢复完成」的 effect 竞争，出现一帧登录页一帧工作区。
  const handleReauthenticationRequired = useCallback(() => {
    setWelcomeScreenOpenReason("session-expired");
  }, []);
  // 这一大组 workspace 动作全部来自子 hook：Root 只负责注入「本窗口的上下文」
  // （单例 api、当前路径、能力开关），不持有实现。这样热更新时动作逻辑可以独立重载。
  const {
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateTask,
    handleBackFromSettings,
  } = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi,
    addTab,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    supportsSettings,
    allowOpenWorkspace,
    preferDirectoryBrowser: shouldPreferDirectoryBrowser,
    openDirectoryBrowser: handleOpenDirectoryBrowser,
    refreshProviderState,
    updateAppSettings,
    setOAuthError,
    setUser,
    onProviderFamilyDomainClearedAfterLogout: () => {
      // 登出清空 domain 后必须弹「重新连接 provider」，而不是直接回登录页：
      // 用户的账号可能仍然有效，只是 provider 配置没了，此时要求重新登录是多余的门槛。
      setWelcomeScreenOpenReason("logout-provider-required");
    },
    userId: user?.id,
    // 只有允许远端时才注入回调：注入后再在内部判断会让对话框仍被渲染出来，
    // 用户能点到「添加设备」却拿不到任何响应。
    onOpenRemoteConnection: allowRemoteWorkspace ? handleOpenRemoteConnection : undefined,
    openRemoteProjectWorkspace: openPreparedRemoteProjectWorkspace,
    openMobileProjectDraft: webRemoteControlWorkspaceSwitcher?.openProjectDraft,
    // 两种客户端的语义不同：web-remote-replayable 允许重放远端事件，
    // desktop-continuous 要求连续流；写死一个会让另一端的 workbench 丢帧。
    workbenchGroupClientMode: isWebRemoteControlRoot
      ? "web-remote-replayable"
      : "desktop-continuous",
  });
  // [并发] 该回调由 workbench 在重连成功时触发，可能晚于 Root 卸载到达；
  // 它只写 store 不触碰 Root state，所以无需取消标记，但必须保持幂等可重入。
  const handleRemoteWorkspaceActivated = useCallback(
    ({
      workspacePath,
      workspaceIdentity,
      restoreSelection,
      projectId,
    }: {
      workspacePath: string;
      workspaceIdentity: string;
      restoreSelection?: boolean;
      projectId?: string | null;
    }) => {
      // 桌面重连只恢复连接，不得把已选会话覆盖成草稿；手机仍沿用 replayable 入口。
      // 取 activeTaskId 而不是「有没有 session」：空 session 的 workspace 也要走草稿，
      // 否则重连后界面会停在一个空白会话上，用户以为会话丢了。
      const selectedTask = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId;
      // 三个条件都必须成立才跳过草稿：桌面、要求恢复选择、且确有已选任务。
      // restoreSelection 为 false 表示这是「打开项目」而非「重连」，此时必须给新草稿。
      if (!isDesktop || !restoreSelection || !selectedTask) {
        // projectId 为 undefined 与 null 语义不同：undefined 表示调用方没提供，
        // 不能当成「清空项目」，否则会把远程项目归属抹掉。
        if (projectId !== undefined)
          logger.info("[Root] 按原项目初始化远程草稿", { workspaceIdentity, projectId });
        startDraftInWorkspace(workspacePath, workspaceIdentity, { projectId });
      }
    },
    [isDesktop, startDraftInWorkspace],
  );

  const {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceRecoveryByWorkspaceKey,
    remoteWorkspaceErrorByWorkspaceKey,

    buildPersistedTabPatch,
    restorePersistedSession: restoreWorkspaceTabs,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    remoteWorkspaceController,
  } = useRemoteWorkspaceHistory({
    intl,
    services,
    platform,
    supportsSettings,
    isDesktop,
    allowRemoteWorkspace,
    // conversation backing workspace 只属于本地桌面主恢复链路；远程窗口和手机
    // shared-host attachment 不能因此创建独立本地 runtime 或改变 replayable 边界。
    // 两个开关共用同一表达式是刻意的：一旦二者不一致，就会出现「先延迟恢复、
    // 但恢复时又去建 conversation workspace」的错配，产生重复 runtime。
    ensureConversationWorkspaceOnRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    deferInactiveWorkspaceRestore: isDesktop && restoreSession && !initialWorkspaceIdentity,
    unavailableWorkspacePath,
    tabStoreApi,
    activateTabByPath,
    addTab,
    persistenceGate: workspacePersistenceGate,
    onWorkspaceActivated: handleRemoteWorkspaceActivated,
    onOpenRemoteConnection: handleOpenRemoteConnection,
    // 只在对话框打开或连接进行中才限制「手动打开的 tab」：
    // 常驻传递会让恢复逻辑长期认为用户在手动操作，从而跳过自动恢复。
    manuallyOpeningWorkspaceTabId:
      remoteConnectionDialogOpen || remoteConnectionInProgress
        ? remoteConnectionOpenPreference?.preferredWorkspaceTabId
        : undefined,
  });

  async function openPreparedRemoteProjectWorkspace(target: {
    expectedMembershipId?: string;
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    projectId: string | null;
    isCurrent?: () => boolean;
  }): Promise<void> {
    // [失败路径] 两个前置条件用 throw 而不是静默返回：这是「打开远端项目」的
    // 主动操作，静默失败用户会看到一个没有反应的点击，且没有任何可诊断信息。
    if (!target.workspaceIdentity) throw new Error("project.workspace-identity-required");
    if (!services.remoteProjectService) throw new Error("remote-project.service-unavailable");
    // expectedMembershipId 存在时才注入 projectService：membership 校验需要它，
    // 没有 membership 的场景注入反而会让 attach 去查一个不存在的成员关系。
    await attachRemoteProjectWorkspace({
      ...target,
      workspaceIdentity: target.workspaceIdentity,
      remoteService: services.remoteProjectService,
      ...(target.expectedMembershipId ? { projectService: services.projectService } : {}),
      // findSession 按 identity 而不是 path 匹配：同一路径在不同 source server 上是
      // 两个不同会话，按 path 找会把已连接状态错认成另一台主机的。
      findSession: (identity) =>
        Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).find(
          (session) => session.workspaceIdentity === identity,
        ),
      connect: handleConnectRemote,
      cancel: handleCancelRemoteProject,
      bind: async (remoteSessionId, path, isCurrent) => {
        // session 可能刚被回收：用可选链取 sourceServerId 并回退空串，
        // dispatch 内部会按空串走「未知来源」分支并给出可读错误，而不是在这里抛 TypeError。
        const session = useRemoteWorkspaceSessionStore.getState().sessionsById[remoteSessionId];
        await remoteWorkspaceController.dispatch({
          type: "open-project",
          sourceServerId: session?.sourceServerId ?? "",
          path,
          remoteSessionId,
          // draftProjectId 与 preparedWorkspaceIdentity 一起传，保证绑定后草稿落在
          // 同一个项目下；只传其一会出现「有项目没 identity」的半归属状态。
          draftProjectId: target.projectId,
          preparedWorkspaceIdentity: target.workspaceIdentity,
          isCurrent,
        });
      },
    });
  }

  const handleResolveConversationWorkspaceForShell = useCallback(
    async () =>
      // Bug 原因：此前只回传 workspacePath，Shell 再按路径反查 identity；多设备 conversation 路径
      // 相同时会归到错误 Source。改为在这里按 Source 归属一次性解析 path + identity。
      await resolveConversationWorkspaceTarget({
        getTabs: () => tabStoreApi.getState().tabs,
        activeWorkspacePath,
        activeWorkspaceIdentity,
        resolveLocalConversationWorkspacePath: handleResolveConversationWorkspace,
      }),
    [activeWorkspacePath, activeWorkspaceIdentity, handleResolveConversationWorkspace, tabStoreApi],
  );

  useEffect(() => {
    // Web 远控重连入口只在宿主提供了能力时存在。这里返回 undefined 而不是空函数，
    // 让 effect 的清理语义保持「没有订阅就没有清理」，也不会在 React 里
    // 出现「effect 返回非函数」的运行时校验错误。
    if (!platform.onWebRemoteControlReconnectWorkspace) {
      return;
    }

    return platform.onWebRemoteControlReconnectWorkspace(async (request) => {
      try {
        // throwOnFailure:true 是关键：这个回调需要一个明确的 success 布尔回给宿主，
        // 若沿用默认「内部 toast 后吞掉错误」，宿主会永远收到 success=true。
        // activateWorkspaceAfterReconnect:false 也是刻意的——宿主自己决定何时切换，
        // 这边抢先激活会让手机端在重连完成前就跳到工作区。
        await handleReconnectRemoteWorkspace(request.workspaceKey, {
          activateWorkspaceAfterReconnect: false,
          showErrorToast: false,
          throwOnFailure: true,
        });
        // requestId 原样回传：宿主用它把响应匹配到发起请求的那一次重连，
        // 缺少它（或有误）时宿主会认为请求超时并重试。
        return {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: true,
        };
      } catch (error) {
        // [失败路径] 错误在这里被转成结构化结果而不是重新抛出：跨进程回调的
        // 异常无法穿过 IPC，抛出去只会变成 unhandled rejection，宿主仍然等不到响应。
        return {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }, [handleReconnectRemoteWorkspace, platform]);

  useEffect(() => {
    // Bugfix: fileDisplay 默认不传 basePath 时需要落到“当前激活 workspace”。
    // 之前纯工具层拿不到窗口内的 workspace 上下文，只能退回绝对路径，导致 mention / 文件展示在输入框里不够简洁。
    // 这里由 Root 在 workspace 切换时同步一份当前上下文，既保留工具层复用性，也不把 Zustand 依赖硬塞进工具函数。
    setDefaultFileDisplayBasePath(activeWorkspacePath);
  }, [activeWorkspacePath]);

  useEffect(() => {
    // 路径为空时不清错误：欢迎页没有「当前项目」，此时残留的错误属于刚关闭的
    // 那个 workspace，用户在欢迎页看到它只会困惑；真正的清理发生在新目录激活时。
    if (!activeWorkspacePath) {
      return;
    }

    // 切换 workspace 时清掉上一次的操作错误：错误属于旧目录，
    // 带到新目录会让用户以为当前项目出了问题。
    setWorkspaceActionError(null);
  }, [activeWorkspacePath, setWorkspaceActionError]);

  const composerClientNamespace = useComposerClientNamespace();
  const restorePersistedSession = useCallback(
    async (...args: Parameters<typeof restoreWorkspaceTabs>) => {
      const restored = await restoreWorkspaceTabs(...args);
      const restoreDraftIntents = () => {
        // 桌面刷新通过历史 tab 恢复，不经过 initialWorkspace 入口。先恢复项目意图，
        // 再打开首屏门禁，避免 Composer 按未归类范围读取并预热同目录的项目草稿。
        for (const tab of tabStoreApi.getState().tabs) {
          if (!isWorkspaceTab(tab)) continue;
          const workspace = useZCodeSessionStore
            .getState()
            .getWorkspaceState(tab.workspacePath, tab.workspaceIdentity);
          if (workspace.activeTaskId || workspace.draftProjectId !== undefined) continue;
          const scope = readComposerWorkspaceScope(
            tab.workspacePath,
            tab.workspaceIdentity,
            composerClientNamespace,
          );
          if (!scope) continue;
          const draft = readV4ComposerDraft(
            tab.workspacePath,
            tab.workspaceIdentity,
            V4_DRAFT_SCOPE_ROOT,
            scope,
          );
          useZCodeSessionStore
            .getState()
            .startDraft(tab.workspacePath, undefined, tab.workspaceIdentity, {
              projectId: scope.projectId,
              taskGroupId: draft?.taskGroupId,
            });
          logger.info("[Root] 已恢复新建草稿归属", {
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            projectId: scope.projectId,
          });
        }
      };
      restoreDraftIntents();
      return {
        ...restored,
        ...(restored.deferredRestore
          ? {
              deferredRestore: () => {
                restored.deferredRestore!();
                restoreDraftIntents();
              },
            }
          : {}),
      };
    },
    [restoreWorkspaceTabs, composerClientNamespace, tabStoreApi],
  );

  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
    settingService: supportsSettings ? services.settingService : undefined,
    // 首次安装未连接账号时，provider 登录入口判定会晚于 workspace 恢复。
    // 如果这里先恢复 workspace，ChatView mount 会触发草稿 session 预热并在登录页背后报错。
    restoreSession: restoreSession && canRestoreWorkspaceSession,
    persistSession: restoreSession && canRestoreWorkspaceSession,
    persistenceGate: workspacePersistenceGate,
    restorePersistedSession,
    buildPersistPatch: buildPersistedTabPatch,
  });

  useEffect(() => {
    // 两个条件同时成立才对外同步：非桌面（Web 没有 telemetry authority）、
    // 以及尚未完成全量恢复（此时 tabs 只是 active-first 投影）。
    // 少判「非桌面」会在浏览器里尝试建立 scope，服务端会以未知身份拒绝并刷错误日志。
    if (!isDesktop || !hasCompletedFullRestore) return;
    // Bug 原因：active-first 的单 workspace 只是 Renderer 首屏投影，若立刻对外同步，
    // 会短暂撤销其他 workspace 的 telemetry scope。完整补齐后才能发布全量集合。
    // 这里传的是「窗口内全部 workspace tab」而不是仅激活项：scope 必须覆盖
    // 所有可能产生事件的 workspace，否则后台 workspace 的埋点会因无 scope 被丢弃。
    reconcileConversationTelemetryWorkspaceScopes(
      windowWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      })),
    );
  }, [hasCompletedFullRestore, isDesktop, windowWorkspaceTabs]);

  // Bug 原因（2026-08-16 web 远控卡死）：官方版本请求安全校验应答方曾只随桌面正在展示的
  // session pane 挂载，web 远控新建会话时桌面没有对应 pane、web 端无应答方，
  // headers 请求永远滞留 pending，任务永久「工作中」。应答方必须常驻桌面窗口、
  // 覆盖每个打开的 workspace tab，与展示状态解耦；Web 端保持零订阅，桌面仍是唯一权威。
  const requestSecurityBridgeNode = isDesktop ? (
    <RequestSecurityWorkspaceBridge workspaceTabs={windowWorkspaceTabs} />
  ) : null;

  // 该 hook 只从 ServiceProvider 读 oauthService 并返回回调用法，本身不注册监听；
  // 因此它必须在 Provider 内部调用，真正的 401 监听在消费这些回调的下游组件里。
  const { tryRefresh, clearCredentials } = useTokenRefresh();
  // 两个回调在 Root 内没有调用点，但解构不能删：hook 的返回值是下游接线约定，
  // void 只是把「暂未接线」显式化，避免被 lint 当成误删候选直接删掉。
  void tryRefresh;
  void clearCredentials;
  // 启动阻塞是桌面窗口保护期，手机 Web 远控在进入 Root 前已有配对/加载页。
  // Web 端继续使用该 gate 会在 workspace tab 注入前渲染空 RootShell，露出浏览器白底。
  // 六个入参任一为真都会阻塞：漏掉 isBootstrappingInitialWorkspace 会让
  // Shell 先按空 tab 渲染一帧，再被注入的 workspace 替换（闪屏 + 重复挂载）。
  const isStartupRenderBlocked = shouldShowRootStartupLoading({
    isDesktop,
    welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
    isResolvingStartupAuthState,
    isResolvingProviderStartupState,
    isRestoring,
    isBootstrappingInitialWorkspace: isBootstrappingInitialWorkspace || isCreatingFallbackWorkspace,
  });

  const launchReportedRef = useRef(false);
  useEffect(() => {
    // 三重条件由 shouldReportLaunchToInput 收口：启动阻塞中、欢迎页、已上报 都不能发。
    // 判据放在工具函数而不是内联，是因为 e2e 也要复用同一套规则，
    // 两处实现分叉会让「测试通过但生产重复上报」。
    if (
      !shouldReportLaunchToInput({
        isStartupRenderBlocked,
        welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
        alreadyReported: launchReportedRef.current,
      })
    ) {
      return;
    }
    // 先置位再上报（INV-11）：上报本身是异步 IPC，置位放后面会在严格模式的
    // 第二次 effect 执行里再发一次。
    launchReportedRef.current = true;
    const timings = readRendererLaunchTimings();
    if (!timings || !timings.marks) {
      return; // 锚点缺失(非桌面/未注入 marks),整批跳过
    }
    // inputReady 用 Date.now() 而不是 timings 里的某个标记：T6 的定义是
    // 「输入框此刻可用」，只能由本次真正拿到渲染权的时间决定。
    reportUiLaunchToInput({
      marks: timings.marks,
      rendererStart: timings.rendererStart,
      reactCommit: timings.reactCommit,
      inputReady: Date.now(), // T6
      sessionId: `launch-${timings.marks.createdAt}`,
    });
  }, [isStartupRenderBlocked, welcomeScreenOpenReason]);

  useRootPlatformEffects({
    clientMode: isWebRemoteControlRoot ? "web-remote-replayable" : "desktop-continuous",
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    initialTaskId,
    initialTaskDraft,
    // Bugfix: 系统右键/Service 冷启动传入 initialWorkspacePath 时，必须先恢复历史 tabs，
    // 再把目标 workspace 合并并激活。否则先 addTab 会被 restoreTabs 整体替换掉；
    // 直接禁用 restoreSession 又会让其他 workspace 全部消失。
    canBootstrapInitialWorkspace: canRestoreWorkspaceSession && hasCompletedInitialRestore,
    addTab,
    setIsBootstrappingInitialWorkspace,
    platform,
    activateTabByPath,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    openWorkspace: handleOpenWorkspace,
    openWorkspacePath: (path) => {
      void handleSelectProject(path);
    },
    setWorkspaceActionError,
    allowOpenWorkspace,
    isDesktop,
    locale,
    tabs,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    webRemoteControlFeatureEnabled,
    hasCompletedFullTabRestore: hasCompletedFullRestore,
    intl,
    isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
  });

  useEffect(() => {
    // 宿主没提供这个能力时返回 undefined（不是 no-op 函数）：返回一个空函数会让
    // React 认为这里「有订阅」，但实际没有任何清理对象可回收，掩盖了平台能力缺失。
    if (!platform.onCloseActiveContextRequest) {
      return;
    }

    return platform.onCloseActiveContextRequest(() => {
      // [并发] 用可取消的 window 事件而不是直接调用 store：
      // 关闭请求可能同时被多个 layer（side pane / 编辑器 / 终端）抢答，
      // 只有 defaultPrevented 才能表达「有人处理了，别关窗」。
      const event = new Event(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, {
        cancelable: true,
      });
      window.dispatchEvent(event);
      if (event.defaultPrevented) {
        return;
      }

      // 关闭请求先广播给 workspace 层判断 side pane active tab。
      // 没有可见 workspace 或没有可关闭的 side pane tab 时，才回落到关窗口语义。
      // 顺序不能反：先关窗会让 side pane 的监听来不及派发，用户丢掉正在编辑的内容（INV-18）。
      void platform.executeDesktopCommand(DesktopCommandIds.CloseWindow);
    });
  }, [platform]);

  useRootOAuthEffects({
    // accountIntentKey 是把「账号 + provider 域 + 连接选择」压成一个字符串：
    // 三者任一变化都必须重跑 OAuth 恢复，用对象比较会因引用变化而每次都重跑。
    accountIntentKey: JSON.stringify([
      user?.id,
      appSettings?.providerFamilyDomain,
      appSettings?.providerFamilyConnectionSelections,
    ]),
    platform,
    services,
    refreshProviderState,
    refreshAppSettings,
    setUser,
    setIsRestoringOAuthSession,
    setOAuthError,
    oauthPollingActive,
    setOAuthPollingActive,
    markOAuthSuccess,
    onReauthenticationRequired: handleReauthenticationRequired,
  });

  useEffect(
    () =>
      platform.onPostUpdateReleaseNotes((payload) => {
        logger.info("[Root] 收到更新说明，改为静默确认", {
          version: payload.version,
          title: payload.title,
        });
        // 用 ref 去重同一个 version：主进程可能在下载完成与窗口聚焦时各推一次，
        // 不去重会 ack 两遍；但也不能用「已 ack 集合」永久记住，否则版本号复用
        // （测试环境）时第二次会被静默丢弃（INV-11）。
        if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
          return;
        }

        // 自动更新每次命中待展示 release notes 都会走到这里，
        // 之前 Root 会立刻把 payload 送进对话框状态，导致用户每次更新都被强制弹窗打断。
        // 这次需求只移除弹窗本身，因此这里改成收到后直接静默 ack，
        // 既不影响“更新已下载”按钮/菜单/安装链路，也避免 pending 状态残留到下次启动后再次触发。
        acknowledgingReleaseNotesVersionRef.current = payload.version;
        void platform
          .acknowledgePostUpdateReleaseNotes(payload.version)
          .then(() => {
            logger.info("[Root] 更新说明已静默确认", {
              version: payload.version,
            });
          })
          .catch((error) => {
            // [失败路径] ack 失败只记日志：release notes 是可选展示内容，
            // 让它冒泡会把一次「确认弹窗已读」变成未捕获异常，打断更新安装链路。
            // finally 里会复位 ref，因此主进程重推时还能再试一次。
            logger.error("[Root] 更新说明静默确认失败", {
              version: payload.version,
              error,
            });
          })
          .finally(() => {
            if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
              acknowledgingReleaseNotesVersionRef.current = null;
            }
          });
      }),
    [platform],
  );

  const canEnterNativeThemeSyncSurface = Boolean(
    // 三个条件表达的是「启动壳已经退出」：没有阻塞、没有欢迎页、并且真的有了
    // 可渲染的主界面（workspace shell 或设置页）。只看其中一个会在启动页
    // 提前进入同步，macOS 上表现为 vibrancy 背景先变一次色（INV-14）。
    !isStartupRenderBlocked &&
    !welcomeScreenOpenReason &&
    (workspaceShellPath || isSettingsTabActive),
  );

  useEffect(() => {
    // 单向置位、从不复位：一旦进入过主界面，后续即使回到欢迎页也不应停止主题同步，
    // 否则用户在设置与欢迎页之间来回切换时窗口背景会闪回默认色。
    if (!canEnterNativeThemeSyncSurface) {
      return;
    }

    // macOS nativeTheme 会影响窗口 vibrancy。这里等 RootStartupLoading
    // 真正退出并进入主界面/设置页后一轮再允许同步，避免启动壳背景被应用主题提前改写。
    setHasEnteredNativeThemeSyncSurface(true);
  }, [canEnterNativeThemeSyncSurface]);

  useDesktopNativeThemeSync({
    enabled: hasEnteredNativeThemeSyncSurface,
    isDesktop,
    platform,
    theme,
  });

  const handleRemoteWorkspaceUserClose = useCallback(
    (workspaceKeys: string[]) => {
      // 逐个派发而不是批量：controller 的 close-workspace 是幂等的单条命令，
      // 批量 API 一旦中途失败，后面的 workspace 会留在「已关闭 tab 但仍在线」的
      // 半状态，反而比逐条失败更难恢复。
      for (const workspaceKey of workspaceKeys) {
        void remoteWorkspaceController.dispatch({
          type: "close-workspace",
          workspaceKey,
          // origin 必须是 user-close：controller 用它区分「用户关 tab」与
          // 「远端主动断开」，后者的 UI 提示与重连策略完全不同。
          origin: "user-close",
        });
      }
    },
    [remoteWorkspaceController],
  );

  useRemoteWorkspaceTabLifecycle({
    tabs,
    activeWorkspaceTab,
    platform,
    tabStoreApi,
    onRemoteWorkspaceTabsClosed: handleRemoteWorkspaceUserClose,
  });

  useEffect(() => {
    // 七个前置条件全部是「不该兜底」的情形：
    // 仍在解析（auth/provider/restore/bootstrap）、欢迎页存在、已有可用 shell、
    // 设置页已打开、平台不允许打开工作区、或者已经发起过一次（INV-11）。
    // 少判 allowOpenWorkspace 会在手机 Web 远控端尝试创建目录，直接失败。
    if (
      shouldBlockRootRender({
        isResolvingStartupAuthState,
        isResolvingProviderStartupState,
        isRestoring,
        isBootstrappingInitialWorkspace,
      }) ||
      isStartupProviderLoginEntryOpen ||
      workspaceShellPath ||
      isSettingsTabActive ||
      !allowOpenWorkspace ||
      didRequestFallbackWorkspaceRef.current
    ) {
      return;
    }

    didRequestFallbackWorkspaceRef.current = true;
    setIsCreatingFallbackWorkspace(true);
    // 以前 tab store 的默认空态会把 Root 带到打开工作区中间页。
    // 删除整页流程后，启动恢复为空或入口没有传 initialWorkspacePath 时必须在 Root
    // 兜底落到默认 workspace，避免用户先看到一张“打开工作区”中间页或空白页。
    // 这里不能用当前 effect 的 cleanup 作为异步取消标记：setIsCreatingFallbackWorkspace
    // 或 addTab 后的 workspaceShellPath 变化都会让 React 先跑 cleanup，若因此跳过 finally，
    // 启动 loading gate 会永远保持 true。
    services.fileService
      .ensureConversationWorkspace()
      .then((result) => {
        // 启动兜底创建目录可能早于会话恢复发起、晚于恢复完成返回。
        // 返回后必须按 tab store 最新 active workspace 再判一次，避免迟到的默认项目抢走上次恢复的 tab。
        // shouldOpenFallbackWorkspaceAfterCreate 同时看 mounted：卸载后再 addTab
        // 会写进一个已经没有渲染者的 store，留下幽灵 tab（INV-12 / INV-13）。
        if (
          !shouldOpenFallbackWorkspaceAfterCreate({
            isMounted: rootInnerMountedRef.current,
            activeWorkspacePath: tabStoreApi.getState().activeWorkspacePath,
          })
        ) {
          return;
        }
        handleSelectConversationWorkspace(result.path);
      })
      .catch((error) => {
        // [失败路径] 已卸载就不写错误：此时用户已经离开这个窗口，
        // 写进 store 的错误会在下次挂载时被当成「当前项目失败」显示出来。
        if (!rootInnerMountedRef.current) {
          return;
        }
        logger.error("[Root] 启动兜底创建默认 workspace 失败", { error });
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        // finally 里同样要判 mounted：卸载后 setState 是空操作，但 rootInnerMountedRef
        // 为 false 时跳过可以避免 React 的「更新已卸载组件」警告（INV-12 的另一半）。
        if (rootInnerMountedRef.current) {
          setIsCreatingFallbackWorkspace(false);
        }
      });
  }, [
    allowOpenWorkspace,
    handleSelectConversationWorkspace,
    isBootstrappingInitialWorkspace,
    isResolvingProviderStartupState,
    isResolvingStartupAuthState,
    isRestoring,
    isSettingsTabActive,
    isStartupProviderLoginEntryOpen,
    services.fileService,
    setWorkspaceActionError,
    tabStoreApi,
    workspaceShellPath,
  ]);

  useEffect(() => {
    if (!workspaceShellPath) {
      return;
    }

    // 只记「设置页开关」与 shell 路径的日志，不参与渲染：它是排查闪屏问题时
    // 唯一能还原「哪一帧显示了什么」的线索，因此即使看起来冗余也保留。
    logger.info(
      `[Root] settings view ${isSettingsTabActive ? "open" : "closed"} workspace=${workspaceShellPath}`,
    );
  }, [isSettingsTabActive, workspaceShellPath]);

  useEffect(() => {
    if (!loginEntryRequest) {
      return;
    }
    // 登录入口已从模态弹窗收敛为 WelcomeScreen。
    // provider 连接请求仍要先退出首次启动引导语义，避免连接完成后误创建默认 workspace。
    setWelcomeScreenOpenReason("provider-request");
  }, [loginEntryRequest]);

  // 登录入口不依赖会话；保持引用稳定，避免草稿更新穿透侧栏 memo。
  const handleOpenLoginEntry = useCallback(() => {
    // 手动入口必须与「启动期 provider 引导」区分：前者的完成回调不应尝试创建
    // 默认 workspace，否则用户在欢迎页登录后会凭空多出一个项目（INV-6 的另一面）。
    setWelcomeScreenOpenReason("manual-login");
  }, []);
  const handleWelcomeScreenComplete = useCallback(
    async (reason: LoginCompleteReason) => {
      // 先刷新设置再决定分支：provider 可用性来自 appSettings，
      // 跳过刷新会让「刚登录就带 provider」的用户仍被判定为未配置。
      await refreshAppSettings();
      if (
        welcomeScreenOpenReason !== "startup-provider-required" ||
        workspaceShellPath ||
        !allowOpenWorkspace
      ) {
        // 四个分支合并成一个 early return：它们都表示「不应该由欢迎页收尾创建」，
        // 拆开写迟早会漏一个，导致重复创建默认 workspace。
        setWelcomeScreenOpenReason(null);
        return;
      }

      try {
        await handleEnsureConversationWorkspace();
      } catch (error) {
        // [失败路径] 创建失败也关闭欢迎页：留在欢迎页会让用户以为登录没成功，
        // 而实际上账号已经可用，错误交给 workspace 错误提示展示更准确。
        logger.error("[Root] 登录后创建默认 workspace 失败", {
          error,
          reason,
        });
      } finally {
        // finally 而不是成功分支：无论创建成败都必须退出欢迎页，
        // 否则用户被卡在一个已完成的登录界面上（INV-6）。
        setWelcomeScreenOpenReason(null);
      }
    },
    [
      allowOpenWorkspace,
      handleEnsureConversationWorkspace,
      refreshAppSettings,
      welcomeScreenOpenReason,
      workspaceShellPath,
    ],
  );
  // epoch 是「用户意图版本号」：任何新选择（改目录、关对话框）都会 +1，
  // 所有等待远端 IO 的异步分支在提交前都要复核它（INV-17）。
  const remoteProjectIntentEpoch = useRef(0);
  const [remoteProjectSelection, setRemoteProjectSelection] = useState<{
    host: RemoteProjectHost;
    path: string;
    sessionId: string;
  } | null>(null);
  const selectDirectoryForRemoteProject = useCallback(
    async (sessionId: string, path: string, localWorkspacePath?: string) => {
      // 在第一个 await 之前取 epoch：之后每一次远端读取都必须用这个快照比较，
      // 若在 await 之后再取，用户已经换选择时等于拿新值比较自己，永远相等。
      const epoch = remoteProjectIntentEpoch.current;
      const session = useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId];
      if (!session?.target || !services.remoteProjectService)
        throw new Error("project.connection-unavailable");
      // identity 的两种构造方式对应两种来源：带 sourceServerId 的走服务器维度，
      // 否则回落到旧 path+target。用错会把同一台主机的两个 workspace 合并成一个。
      const identity = session.sourceServerId
        ? buildServerRemoteWorkspaceIdentity({
            serverId: session.sourceServerId,
            workspacePath: path,
          })
        : buildRemoteWorkspaceIdentity(path, session.target);
      const hostId = remoteHostIdFromWorkspaceIdentity(identity);
      const directory = await services.remoteProjectService.readDirectory();
      // 第一次 epoch 复核：readDirectory 可能耗时数百毫秒，期间用户完全可能已改选。
      if (epoch !== remoteProjectIntentEpoch.current) throw new Error("project.creation-cancelled");
      const host = directory.hosts.find((item) => item.id === hostId);
      // host 消失不是「取消」而是「环境变了」：用不同的错误码让 UI 提示
      // 「主机已被移除」而不是静默关闭对话框。
      if (!host) throw new Error("remote-project.host-removed");
      if (
        remoteConnectionOpenPreference?.preferredWorkspaceTabId ||
        remoteConnectionOpenPreference?.preferredProjectEntryId
      ) {
        // 原项目的认证/安装/升级完成应回到原目录，不能误入新建项目编辑。
        const retained = directory.entries.find(
          (entry) =>
            entry.hostId === host.id &&
            (!remoteConnectionOpenPreference.preferredProjectEntryId ||
              entry.id === remoteConnectionOpenPreference.preferredProjectEntryId) &&
            (entry.roots.some((root) => root.rootPath === path) ||
              entry.legacyWorkspace?.workspacePath === path),
        );
        if (!retained)
          throw Object.assign(new Error("remote-project.entry-not-found"), {
            code: "remote-connection-canceled",
          });
        let draftProjectId: string | undefined;
        // 会话重连只恢复原选择；打开项目才解析草稿归属，避免阻止已删除项目的历史会话重连。
        if (!remoteConnectionOpenPreference.preferredWorkspaceTabId) {
          // projectService 缺失时直接抛：这里不能用可选链跳过校验，
          // 跳过会让 projectId 保持 undefined，最终把这个目录当成「无项目」而静默保存。
          if (!services.projectService) throw new Error("project.service-unavailable");
          // 入口 ID 只校验成员，不会初始化草稿归属；不能沿用本地同目录旧缓存。
          const project = resolveEntryProject(
            retained,
            await services.projectService.readTree({ hostId: host.id }),
          );
          if (!project || project.deleted || !project.roots.some((root) => root.rootPath === path))
            throw new Error("project.not-found");
          draftProjectId = project.id;
        }
        await remoteWorkspaceController.dispatch({
          type: "open-project",
          sourceServerId: session.sourceServerId ?? "",
          remoteSessionId: sessionId,
          path,
          localWorkspacePath,
          preparedWorkspaceIdentity: identity,
          draftProjectId,
          isCurrent: async () => {
            if (epoch !== remoteProjectIntentEpoch.current) return false;
            // bind 会等待远端 IO；初检快照不能授权迟到结果复活已移除/换代的成员。
            // membershipId 也要比较：主机可能被移除后以同 id 重新加入，
            // 只比 id 会让旧成员的绑定结果落到新成员身上。
            const current = await services.remoteProjectService!.readDirectory();
            return (
              epoch === remoteProjectIntentEpoch.current &&
              current.hosts.some(
                (item) => item.id === host.id && item.membershipId === host.membershipId,
              ) &&
              current.entries.some(
                (entry) =>
                  entry.id === retained.id &&
                  entry.hostId === host.id &&
                  (entry.roots.some((root) => root.rootPath === path) ||
                    entry.legacyWorkspace?.workspacePath === path),
              )
            );
          },
        });
        return;
      }
      // 选目录只进入项目编辑，保存与入口登记完成之前不打开会话。
      setRemoteProjectSelection({ host, path, sessionId });
    },
    [
      services.remoteProjectService,
      services.projectService,
      remoteConnectionOpenPreference,
      remoteWorkspaceController,
    ],
  );
  const handleRemoteConnectionDialogOpenChange = useCallback((open: boolean) => {
    // 已经 delivered 的返回目标视为「已消费」：再调 onVisibilityChange 会把它
    // 重新点亮，导致关闭对话框后原对话又被激活一次。
    const target =
      deviceAdditionReturn.current?.completion === "delivered"
        ? undefined
        : deviceAdditionReturn.current?.target;
    if (target?.isCurrent()) target.onVisibilityChange?.(open);
    // 关闭对话框就作废所有在途的远端项目意图（INV-17）：
    // 不 +1 的话，关闭瞬间还在跑的 readDirectory 完成后仍会提交并重新打开选择器。
    if (!open) remoteProjectIntentEpoch.current++;
    setRemoteConnectionDialogOpen(open);
  }, []);
  const handleRemoteProjectIntentCleared = useCallback(() => {
    // 改选新连接只清除原项目恢复意图；从设置进入仍须独立完成设备管理。
    // 保留 returnTarget 与 completion 是刻意的：设备管理流程结束后还要回到原页面，
    // 一并清空会让用户从设置里连完设备后无处可回。
    setRemoteConnectionOpenPreference((current) =>
      current?.completion === "device-management"
        ? { completion: "device-management", returnTarget: current.returnTarget }
        : null,
    );
  }, []);

  // 两个对话框节点在多个路由分支里被重复引用，因此必须先构造、再按分支选择，
  // 而不是在 JSX 里各自内联一份：内联会让每次分支判断都创建新的元素类型，
  // 已打开的对话框会被卸载重建（输入框内容丢失）。
  const remoteConnectionDialog = allowRemoteWorkspace ? (
    <>
      {remoteProjectSelection && services.projectService && services.remoteProjectService ? (
        <RemoteProjectPicker
          key={remoteProjectSelection.host.membershipId}
          host={remoteProjectSelection.host}
          initialRoots={[remoteProjectSelection.path]}
          service={services.projectService}
          remoteService={services.remoteProjectService}
          onClose={() => {
            // 关闭选择器要同时做三件事：作废在途意图、清空选择、释放 attachment。
            // 少做第一件时，一个还在跑的保存流程仍会提交并重新弹回选择器。
            remoteProjectIntentEpoch.current++;
            const sessionId = remoteProjectSelection.sessionId;
            setRemoteProjectSelection(null);
            void handleCancelRemoteProject(sessionId).catch((error) =>
              logger.warn("[Root] 释放项目创建 attachment 失败", error),
            );
          }}
          onSaved={async () => {}}
        />
      ) : null}
      <SSHDialog
        completion={remoteConnectionOpenPreference?.completion}
        onCancelled={(background) => {
          // background=true 表示「连接窗口被收起但流程仍在跑」，
          // 这里必须原样透传给 finishDeviceAddition，否则后台连接会被当成失败回滚。
          void finishDeviceAddition(
            { kind: "cancelled", ...(background ? { background: true } : {}) },
            background,
          ).catch((error) => logger.warn("[Root] device addition cancellation failed", error));
        }}
        onDeviceConnected={async (sourceServerId, canDeliver) => {
          // 先尝试「导航回原对话」：成功就什么都不做，用户留在原来位置。
          // 只有返回 false（没有可回的目标）才落到设置页的设备列表。
          if (await finishDeviceAddition({ kind: "connected", sourceServerId }, false, canDeliver))
            return;
          // 第二次 canDeliver 复核：finishDeviceAddition 内部可能 await 过，
          // 期间目标可能已失效（tab 关闭 / 用户切走），此时不应再打开设置页。
          if (canDeliver?.() === false) return;
          setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
          tabStoreApi.getState().openSettingsTab();
        }}
        onConnect={handleConnectRemote}
        onSelectProject={selectDirectoryForRemoteProject}
        onCancelSession={handleCancelRemoteProject}
        localWorkspacePath={localWorkspacePathForRemoteConnection}
        isWindowsDesktop={isWindowsDesktop}
        remoteWorkspaceSessions={remoteWorkspaceSessions}
        open={remoteConnectionDialogOpen && !remoteProjectSelection}
        onOpenChange={handleRemoteConnectionDialogOpenChange}
        onProjectIntentCleared={handleRemoteProjectIntentCleared}
        onFlowActiveChange={setRemoteConnectionInProgress}
        onFlowRequestIdChange={setRemoteConnectionRequestId}
        onFlowTargetChange={handleRemoteConnectionTargetChange}
        openIntentId={remoteConnectionOpenIntentId}
        initialFailure={remoteConnectionOpenPreference?.initialFailure}
        preferredKind={remoteConnectionOpenPreference?.preferredKind}
        preferredWslDistro={remoteConnectionOpenPreference?.preferredWslDistro}
        preferredSourceServerId={remoteConnectionOpenPreference?.preferredSourceServerId}
        preferredProfileId={remoteConnectionOpenPreference?.preferredProfileId}
        preferredDirectoryPath={remoteConnectionOpenPreference?.preferredDirectoryPath}
        preferredTarget={remoteConnectionOpenPreference?.preferredTarget}
        hideTriggerWhenClosed
      />
    </>
  ) : null;
  // 目录浏览器用 silent 错误边界：选目录失败时不应整页变错误页，
  // 用户仍需要一个可关闭的对话框继续别的操作。
  const directoryBrowserDialog = directoryBrowserOpen ? (
    <ScopedErrorBoundary
      scope="directory-browser"
      resetKeys={["directory-browser"]}
      variant="silent"
    >
      <DirectoryBrowser
        services={services}
        onCancel={() => setDirectoryBrowserOpen(false)}
        onSelect={(path) => {
          // 先关对话框再选择：handleSelectProject 会打开新 tab，
          // 若顺序反过来，选择过程中对话框仍覆盖在新界面上。
          setDirectoryBrowserOpen(false);
          void handleSelectProject(path);
        }}
      />
    </ScopedErrorBoundary>
  ) : null;

  useEffect(() => {
    // 只在「从空闲进入进行中」这一条边沿重置日志（INV-22）：
    // 每次进度更新都清空会让用户永远只看到最后一行，失败前的步骤全部丢失。
    const wasInProgress = previousRemoteConnectionInProgressRef.current;
    if (!wasInProgress && remoteConnectionInProgress) {
      resetRemoteConnectionLogs();
    }
    // 无论是否重置都要更新 ref：忘记更新会让下一次进入不再被识别为边沿。
    previousRemoteConnectionInProgressRef.current = remoteConnectionInProgress;
  }, [remoteConnectionInProgress, resetRemoteConnectionLogs]);

  // 设置页的 props 一次性构造：SettingsPage 被多处渲染（独立路由与 embedded 分支），
  // 内联会导致两处漏传字段；集中构造后改字段只改一处。
  // allowOpenWorkspace 原样透传而不是在这里再算一次：门禁的唯一来源必须是
  // 上面的 canRestoreWorkspaceSession 链路，二处判断迟早会不一致。
  const settingsLayerProps = {
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    isWebRemoteControl: Boolean(webRemoteControlWorkspaceSwitcher),
    captionWorkspacePath: activeWorkspacePath,
    onBack: activeWorkspacePath ? handleBackFromSettings : undefined,
    onCreateTask: handleCreateTask,
    onOpenWorkspace: handleOpenWorkspace,
    allowOpenWorkspace,
    onLogin: !user ? handleOpenLoginEntry : undefined,
    onLogout: user ? handleLogout : undefined,
    user,
  };

  // 启动阻塞分支必须排在最前：此后的分支都假定「启动壳已退出」，
  // 若把欢迎页判定放在它前面，用户在 provider 引导中会先看到欢迎页闪一下。
  if (isStartupRenderBlocked) {
    const loadingLabel = intl.formatMessage({ id: "common.loading" });
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        {/* 修复原因：HTML 启动壳已经展示 ZCode SVG，但 React 接管 root 后旧壳会被整棵替换。
            之前阻塞恢复 tab / 初始 workspace 注入时重新渲染纯文字“加载中...”，所以启动被拆成两套 loading。
            这里复用同一套 SVG 启动画面，只把文案保留到 aria-label，保证视觉始终连续且不牺牲可访问性。 */}
        <RootStartupLoading label={loadingLabel} />
      </RootShell>
    );
  }

  // 欢迎页分支同样要带满四个全局节点（INV-20）：登录页也可能因为模型选型失败
  // 而无法继续，错误提示必须在这里可见，而不是被欢迎页盖住。
  if (welcomeScreenOpenReason) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        <WelcomeScreen onComplete={handleWelcomeScreenComplete} />
      </RootShell>
    );
  }

  // 「只有设置页、没有 workspace」是独立分支：它不能落到最后的 workspace 分支，
  // 否则 OccupationOnboarding 会因为没有 shell 路径而渲染一个空引导层。
  if (!workspaceShellPath && isSettingsTabActive) {
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialog}
        {directoryBrowserDialog}
        <ScopedErrorBoundary
          scope="settings-page"
          resetKeys={["settings-root"]}
          variant="panel"
          className="h-full"
        >
          <SettingsPage {...settingsLayerProps} />
        </ScopedErrorBoundary>
      </RootShell>
    );
  }

  // [失败路径] 非桌面入口的兜底分支是 INV-21 的唯一执行点：
  // 四个条件同时成立时才返回入口 loading，顺序不能调换——先判 isDesktop
  // 会让桌面端在注入前也走这个分支，露出一个不该出现的加载层。
  if (
    !workspaceShellPath &&
    !isDesktop &&
    initialWorkspaceAbsPath &&
    initialWorkspaceLoadingFallback
  ) {
    // 非桌面入口的 workspace tab 由 effect 注入，首帧不能返回 null。
    // 这里延续入口 loading，等任务列表有 workspaceShellPath 后再切换，避免露出浏览器白底。
    return (
      <RootShell>
        {rootModelSelectionErrorNode}
        {requestSecurityBridgeNode}
        {initialWorkspaceLoadingFallback}
        {directoryBrowserDialog}
      </RootShell>
    );
  }

  // 真正「什么都没有」的分支：只有在对话框打开或模型选型报错时才渲染壳，
  // 否则返回 null（而不是空壳）。返回空壳会让欢迎页与主界面之间多出一帧空白，
  // 而返回 null 让上一个分支的画面保持到下一帧（React 会保留上一次 DOM）。
  if (!workspaceShellPath) {
    return remoteConnectionDialogOpen || directoryBrowserOpen || rootModelSelectionErrorNode ? (
      <RootShell>
        {rootModelSelectionErrorNode}
        {remoteConnectionDialogOpen ? remoteConnectionDialog : null}
        {directoryBrowserDialog}
      </RootShell>
    ) : null;
  }

  // 主界面分支：OccupationOnboarding 必须包在最外层，因为它负责窗口控制按钮与
  // 引导层的位置；放到里面会让 macOS 的红绿灯按钮在降级页上错位。
  // 里面的三元分支用 workspaceShellPath 而不是 isSettingsTabActive 判断：
  // 设置页在「有 workspace」时是内嵌在三栏布局里的，与独立设置页是两种布局。
  return (
    <RootShell>
      {rootModelSelectionErrorNode}
      {requestSecurityBridgeNode}
      {remoteConnectionDialog}
      {directoryBrowserDialog}
      <OccupationOnboarding
        showWindowControls={Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))}
        showChildrenWhileLoading={!workspaceShellPath && isSettingsTabActive}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        {/* 新引导属于应用级偏好；无项目时也要挂载，才能响应设置页的手动打开请求。 */}
        {!workspaceShellPath ? (
          isSettingsTabActive ? (
            <ScopedErrorBoundary
              scope="settings-page"
              resetKeys={["settings-root"]}
              variant="panel"
              className="h-full"
            >
              <SettingsPage {...settingsLayerProps} />
            </ScopedErrorBoundary>
          ) : null
        ) : (
          <RemoteWorkspaceControllerProvider controller={remoteWorkspaceController}>
            <RemoteProjectPresentationProvider
              reconnectingKeys={reconnectingRemoteWorkspaceKeys}
              errors={remoteWorkspaceErrorByWorkspaceKey}
              recovery={remoteWorkspaceRecoveryByWorkspaceKey}
              onReconnect={
                webRemoteControlWorkspaceSwitcher?.reconnectWorkspace ??
                handleReconnectRemoteWorkspace
              }
            >
              <RootWorkspaceContent
                workspaceScopedServices={workspaceScopedServices}
                baseFeedbackService={services.feedbackService}
                workspaceShellPath={workspaceShellPath}
                workspaceIdentity={workspaceShellIdentity}
                workspaceRemoteSessionId={workspaceShellRemoteSessionId}
                activeWorkspacePath={activeWorkspacePath}
                isSettingsTabActive={isSettingsTabActive}
                handleConnectRemote={handleConnectRemote}
                handleSelectRemoteProject={handleSelectRemoteProject}
                handleCancelRemoteProject={handleCancelRemoteProject}
                handleReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                handleCreateTask={handleCreateTask}
                handleCreateConversationTask={handleCreateConversationTask}
                handleResolveConversationWorkspace={handleResolveConversationWorkspaceForShell}
                handleOpenWorkspace={handleOpenWorkspace}
                handleOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                handleOpenRemoteWorkspace={
                  allowRemoteWorkspace ? handleOpenRemoteConnection : undefined
                }
                remoteConnectionInProgress={remoteConnectionInProgress}
                remoteWorkspaceSessions={remoteWorkspaceSessions}
                allowRemoteWorkspace={allowRemoteWorkspace}
                handleBackFromSettings={handleBackFromSettings}
                handleLogout={user ? handleLogout : undefined}
                onLogin={!user ? handleOpenLoginEntry : undefined}
                user={user}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                remoteConnectionLogs={remoteConnectionLogs}
                allowOpenWorkspace={allowOpenWorkspace}
                webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
                initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
                initialWebRemoteControlMobileNavigationIntent={
                  initialWebRemoteControlMobileNavigationIntent
                }
                webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                supportsEmbeddedBrowser={supportsEmbeddedBrowser}
              />
            </RemoteProjectPresentationProvider>
          </RemoteWorkspaceControllerProvider>
        )}
        <ScopedErrorBoundary
          scope="onboarding-dialog"
          resetKeys={[workspaceShellIdentity?.trim() || workspaceShellPath]}
          variant="silent"
        >
          <OnboardingDialog
            workspacePath={workspaceShellPath || undefined}
            workspaceIdentity={workspaceShellIdentity}
            isDesktop={isDesktop}
          />
        </ScopedErrorBoundary>
      </OccupationOnboarding>
    </RootShell>
  );
}
