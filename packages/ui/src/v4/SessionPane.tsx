/**
 * ============================================================================
 * ui/v4/SessionPane.tsx —— 单个会话 pane 的命令编排与渲染入口
 * ============================================================================
 *
 * 【定位】V4 UI 的"单 pane 竖切"：一个 SessionPane 对应一个 conversation，
 * 负责订阅 topic、发送 command、处理 stop/fork/edit/retry/queue/slash、
 * 并把 ConversationProjectionStore 的 rows 交给 Timeline / Composer / StatusPanel。
 *
 * 【状态边界】
 *   - 业务状态（turn、queue、goal、permission、interaction）全部来自 projection；
 *   - 本组件只持有 draft、滚动/焦点、局部弹层与按 commandId 的临时 optimistic overlay；
 *   - 不从消息数组重新推导 turn/timeline/endedness/availability。
 *
 * 【为什么命令组不拆散】dispatchCommand、snapshotRef 与订阅生命周期共享同一组
 * 闭包；把 fork/edit/retry/queue 拆到不同文件会让"命令发出时用的是哪份 snapshot"
 * 变得不可追踪。文件超限是有意接受的代价，优先保证时序可读。
 *
 * 【失败收口】command 失败必须撤掉对应 optimistic overlay，并以 projection 的
 * 下一帧为准；不能用本地状态覆盖服务端已发布的终态。
 * ============================================================================
 */
// ============================================================================
// INV 不变量表（本文件维持/依赖的跨函数约束；改动前先确认对应编号）
// 说明：INV-nn 只在本文件内编号；跨文件引用写 INV-<文件名>#nn，不复用已删除编号。
// ----------------------------------------------------------------------------
// INV-01：lease 必须与 (sessionId, layer) 同代；旧代 lease 不得进入渲染或命令闭包。
//         （守住它的位置：useSessionPaneLease、acquire effect、sessionLeaseReady）
// INV-02：换代时先释放旧 subscription 再 acquire 新代；顺序反了会同时挂两条订阅。
//         （守住它的位置：effectiveSessionId 的 acquire effect cleanup）
// INV-03：snapshot 是只读投影事实；稳定回调只经 ref 取最新值，不把它写进依赖数组。
//         （守住它的位置：snapshotRef、dispatchCommand 的依赖数组）
// INV-04：pane 绑定代次在渲染期同步递增；A→B→A 即使 sessionId 相同也算换绑。
//         （守住它的位置：paneBindingKey 比较、captureHighspeedPaneOrigin）
// INV-05：Highspeed 发送起点必须在同步阶段冻结，任何 await 之后再读 pane 绑定都是错的。
//         （守住它的位置：dispatchSendText、prepareHighspeedTurnFrom 的 origin 参数）
// INV-06：共享选择草稿有 pending / confirmed 两态；pending 只喂预检，不提交选择。
//         （守住它的位置：shareDraft.pendingExcludedRowIds、preflightShareProductTurnIds）
// INV-07：预检缓存以 (scope, productTurnId, turnFingerprint) 为键，fingerprint 变即失效。
//         （守住它的位置：sharePreflightCacheRef、selectedShareTurnFingerprints）
// INV-08：预检缓存只是发布前的提示；publish 阶段的 stat/read/SHA 才是权威校验。
//         （守住它的位置：handleConfirmShareDisclosure 与 sharePreflight 的注释）
// INV-09：每条上行命令必须先登记 pendingCommandRegistry 再发送，失败按 ack 收敛。
//         （守住它的位置：dispatchCommand 的 record / applyAck / settleCommand 三段）
// INV-10：optimistic overlay 只在 accepted/duplicate 保留，其它 ack 必须 settle 掉。
//         （守住它的位置：dispatchCommand 末尾的 settleCommand 条件）
// INV-11：requiresAcceptedInputProjection 的命令在 ACK 后要等权威 userInput row。
//         （守住它的位置：expectAcceptedInputProjection、notifyUserInputRendered）
// INV-12：队列撤回编辑是“删除 + 恢复草稿”的事务；ACK 前 pane 换绑则只删不恢复。
//         （守住它的位置：handleEditQueueItem、composerBindingRef 的校验）
// INV-13：同一时刻只允许一个队列编辑操作在途（queueEditOperation 非空即锁）。
//         （守住它的位置：queueEditOperationRef、Composer 的 disabled）
// INV-14：followupMode 的用户事实源是 app 设置；UI 只把它补发成 setFollowupMode。
//         （守住它的位置：followupModeSyncKeyRef effect、ensureDraftPrewarmConfigBeforeSend）
// INV-15：模型/模式属于“下一次 Submission”，点击只改 Composer intent，不改 Session。
//         （守住它的位置：handleSelectModel、handleSwitchMode、createSubmissionFromComposer）
// INV-16：只读 pane 不渲染 Composer、不下发编辑类命令；文件恢复需显式开关。
//         （守住它的位置：readOnly、workspaceFileRewindEnabled、rowContext 的 undefined）
// INV-17：timeline 只接收与当前 sessionId 同源的 rows；旧 lease 的 rows 一律按 null 处理。
//         （守住它的位置：timelineSnapshot 的三重条件）
// INV-18：底部 dock 顺序固定：配额 → 恢复 → hook → 队列 → 交互 → Composer → 推荐。
//         （守住它的位置：conversationBottomDockContent 的 JSX 顺序）
// INV-19：fileChanges 请求按 (logEpoch, revision/变更态, row/entity) 缓存并共享 in-flight。
//         （守住它的位置：handleFetchFileChanges、fileChangesRequestCache）
// INV-20：dismissedErrorKey 只屏蔽同一条错误指纹，新错误必须重新展示。
//         （守住它的位置：createSessionErrorKey、dismissedErrorKeys、handleDismissComposerError）
// INV-21：share 发布的 clientRequestId 由 attempt 键派生，同参数重试复用、改选后重建。
//         （守住它的位置：ensureConversationShareAttempt、handleConfirmShareDisclosure）
// INV-22：Highspeed 卡只属于一个 taskId；跨 task 的卡不得呈现，也不得作废别人的卡。
//         （守住它的位置：activeHighspeedCard 校验、invalidateActiveHighspeedCard）
// INV-23：草稿预热会话是 pane 内部 effective 目标，对外 sessionId 仍为 null。
//         （守住它的位置：useDraftSessionPrewarm、effectiveSessionId）
// INV-24：runtimeReady 是 runtime 已就绪的唯一门；未就绪时 timeline、命令、插件全关。
//         （守住它的位置：runtimeReady 的三重判定、rowContext 的 runtimeReady 门）
// INV-25：Esc-stop 的归属由 focus + DOM 包含关系 + 面板授权三者共同裁决，不能只看 canStop。
//         （守住它的位置：Esc keydown effect、allowEscapeStopOutsidePane）
// INV-26：只读观察视图复用本组件时，插件 UI、分享、选区动作必须整体关闭，不能部分放行。
//         （守住它的位置：PluginUiSessionProvider 的 readOnly、composerNode、sharePopoverContent）
// ============================================================================
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import {
  createRemoteWorkspaceDisconnectedError,
  getRemoteConnectionFailureCode,
} from "@/lib/remoteWorkspaceServiceError.js";
import { buildConversationShareItems } from "@/v4/conversationShareItems.js";
import { resolveSelectionSideInheritedModel } from "@/lib/selectionSideInheritedModel.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import type { SessionCreateSource } from "@zcode/shared";
import { reportSessionCreate } from "@/lib/sessionCreateTelemetry.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
import { BotGroupDeliveryProvider } from "@/v4/BotGroupDeliveryAction.js";
// 文件头说明见本文件顶部。
/* oxlint-disable eslint(max-lines) -- SessionPane 是单 pane 竖切的命令编排收口（订阅/发送/停止/fork/edit/retry/queue/slash 全集），与旧 ChatView 同粒度；HEAD 已超限（693 行计数），拆散命令组会打散 dispatchCommand/snapshotRef 的闭包纪律。 */
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Hand } from "lucide-react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildCustomSupplierKey,
  isHighspeedProviderId,
  isRemoteWorkspaceIdentity,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import { TID_CHAT_EMPTY, TID_V4_SESSION_PANE, testId } from "@zcode/shared/test-ids";
import type {
  ConversationShareAccessMode,
  GitChangeSourceId,
  HighspeedCardSnapshot,
  HighspeedPrepareTurnResult,
  GitRepositorySummary,
  ModelSelection,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  CommandType,
  ConversationSnapshot,
  ConversationRowTarget,
  SessionErrorInfo,
  SessionModelTransition,
  UserInputRow,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { PluginUiSessionProvider } from "@/plugin-ui/index.js";
import {
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
  resolveConversationSharePublishErrorMessageId,
  sanitizeConversationShareWarnings,
} from "@/lib/conversationShareError.js";
import { localizeConversationShareUrl } from "@zcode/shared";
import type {
  ConversationShareAllowedArtifact,
  ConversationShareTurnPreflightResult,
  ImportedConversationShare,
} from "@zcode/services";
import { useCodingPlanBillingDiscountFromService } from "@/CodingPlanBillingDiscount.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import { buildChatSessionScrollMemoryKey } from "@/lib/chatSessionScrollMemory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { browserGlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";
import {
  HIGHSPEED_SEND_WAIT_BUDGET_MS,
  prepareHighspeedSendContext,
  readRegularTpsWithinSendBudget,
  resolveHighspeedPrepareSelection,
  type HighspeedSendContext,
  type HighspeedTurnPreparer,
} from "@/highspeed/highspeedSend.js";
import {
  calculateHighspeedSavedDurationFromMetrics,
  readHighspeedRegularTpsFromHealth,
} from "@/highspeed/highspeedSavedTime.js";
import { buildHighspeedShareNotice } from "@/highspeed/highspeedShare.js";
import {
  claimHighspeedCardAutoShare,
  claimHighspeedHealthyAttempt,
  completeHighspeedTurn,
  discardHighspeedTurn,
  getHighspeedCardTps,
  getHighspeedTurnVersion,
  hydrateHighspeedTurnsFromTranscript,
  listExpiredHighspeedCardsAwaitingTps,
  listHighspeedCardAutoShareCandidates,
  listHighspeedTurnsAwaitingMetricsPersistence,
  listPendingHighspeedTurns,
  markHighspeedCardAutoShared,
  markHighspeedTurnMetricsPersisted,
  recordHighspeedTurn,
  resolveNextHighspeedAutoShareAt,
  setHighspeedCardTps,
  subscribeHighspeedTurns,
} from "@/highspeed/highspeedTurnStore.js";
import {
  claimHighspeedCardInvalidation,
  claimHighspeedFallbackToast,
  releaseHighspeedCardInvalidation,
} from "@/highspeed/highspeedToastClaims.js";
import {
  collectHighspeedCardShareBlockers,
  listHighspeedCardsAwaitingAutoShare,
} from "@/highspeed/highspeedShareDiagnostics.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";
import {
  workflowSessionModelOf,
  type WorkflowRunSettingsChange,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { usePlanIdentitySnapshot } from "@/hooks/usePlanIdentitySnapshot.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { buildGenUiModelContext } from "@zcode/shared/gen-ui";
import { useWorkspaceHomePath } from "@/hooks/useWorkspaceHomePath.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { prepareComposerRecentReceipt } from "@/lib/composerRecent.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  readPendingTaskDraft,
  resolveComposerScope,
  composerScopeKey,
} from "@/v4/composer/composerDraftStore.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { getProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import {
  buildDraftCreateConfigPayload,
  useDraftConfigControl,
} from "@/v4/composer/useDraftConfigControl.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import {
  createComposerSubmissionConfig,
  type ComposerSubmissionConfig,
} from "@/v4/composer/composerSubmissionConfig.js";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import { projectSessionConfigToTaskConfigOptions } from "@/v4/composer/sessionConfigTaskCache.js";
import { useDraftRuntimeRebuildGate } from "@/v4/composer/useDraftRuntimeRebuildGate.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
  getConversationShareDockState,
  getConversationShareSelectedProductTurnIds,
  useConversationShareSelectionStore,
  type ConversationShareDisplayWarnings,
} from "@/store/conversationShareSelectionStore.js";
import {
  ConversationComposer,
  type ComposerRestoreRequest,
  type ConversationComposerSendOptions,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { shouldIgnoreEscapeForStopGeneration } from "@/v4/composer/escapeStop.js";
import { useConversationPanePresentation } from "@/side-pane-full-view/index.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";
import { ConversationHeader, type PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";
import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import { WorkspaceHookPendingBanner } from "@/v4/WorkspaceHookPendingBanner.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationLatestTurnSummary } from "@/v4/conversationTimelineLiveTail.js";
import { ConversationShareImportNotice } from "@/v4/ConversationShareImportNotice.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";
import {
  ConversationSharePreflightStatus,
  type ConversationSharePreflightState,
} from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ConversationSharePopover } from "@/conversation-share-interaction/ConversationSharePopover.js";
import {
  conversationSharePreflightCacheKey,
  conversationShareTurnFingerprint,
  dedupeConversationShareIssues,
  aggregateConversationShareBlockingIssues,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";
import { createConversationSharePreflightResponseHandlers } from "@/conversation-share-interaction/conversationSharePreflightResponse.js";
import { scheduleConversationSharePreflightRequest } from "@/conversation-share-interaction/conversationSharePreflightRequest.js";
import { ConversationBottomDockTransition } from "@/v4/ConversationBottomDockTransition.js";
import {
  ensureConversationShareAttempt,
  retainConversationShareAttemptAfterFailure,
} from "@/v4/conversationShareAttempt.js";
import { resolveConversationSelectionTooltipEnabled } from "@/v4/conversationShareModePolicy.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { SessionPluginReferenceIconBoundary } from "@/v4/SessionPluginReferenceIconProvider.js";
import {
  resolveConversationStatusPanelVariant,
  shouldUseConversationStatusPanelInlineLayout,
} from "@/v4/conversationLayout.js";
import {
  buildConversationStatusPanelModel,
  resolveSoleRunningWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  buildWorkflowRunByRunId,
  buildWorkflowSaveCandidatesByRunId,
  buildWorkflowRunByToolCallId,
  buildWorkflowRunPendingQuestionsByRunId,
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
} from "@/v4/workflowRunCardJoin.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  countEndedWorkflowRuns,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";
import {
  hasOlderRows,
  requiresAcceptedInputProjection,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  createAssistantPreviewPptxAutoOpenGateState,
  resolveLatestCompletedAssistantPreviewTurn,
  type AssistantPreviewPptxAutoOpenTarget,
} from "@/v4/assistantPreviewPptxAutoOpen.js";
import {
  hasPluginReferenceUserRows,
  isSessionPluginCatalogReady,
} from "@/v4/pluginReferenceIconProjection.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import { recordV4CommandAck } from "@/v4/commandAckObservability.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  useScopedConversationTelemetryForegroundEnabled,
  useScopedConversationTelemetrySupervisor,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { resolveSendAckSettlement } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { useSessionSubscriptionErrorTelemetry } from "@/v4/telemetry/useSessionSubscriptionErrorTelemetry.js";
import { useSessionOpenArmsTelemetry } from "@/v4/telemetry/useSessionOpenArmsTelemetry.js";
import {
  parseV4VisibleSlashCommand,
  parseSelectionSideSlashCommand,
  v4QueuedCommandText,
  type V4VisibleSlashCommand,
} from "@/v4/slashCommands.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { usePendingCommandRecovery } from "@/v4/usePendingCommandRecovery.js";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";
import { resolveMcpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
} from "@/v4/chatLoadingVisibility.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type { ChatErrorBannerModelConfigTarget } from "@/ChatErrorBanner.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  SyncSubagentSessionTabsRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import {
  buildSelectionSideChatKey,
  clearSelectionSideChat,
  createSelectionSideChat,
  isSelectionSideChatBlocked,
  registerSelectionSideChatOpener,
  setSelectionSideChatBlocked,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import {
  normalizeSlashCommandValue,
  shouldOfferSideSlashCommand,
  type AppSlashCommand,
} from "@/slashCommandHelpers.js";
import {
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

  // 宿主契约：pane 只声明“怎么渲染当前会话”，不持有会话事实；turn / queue / goal / 权限
  // 全部来自 projection，组件内的 state 只允许放草稿、焦点、弹层与 optimistic overlay。
  // 这是本文件所有回调都长得像“转发”的原因：它们是能力的挂载点，不是业务实现。
  // 一旦在这里缓存第二份 accepted queue 或 turn 状态，冷恢复、远端回放都会出现两套真值。
  // 回调全部可选：缺省代表当前形态（只读 / 副屏 / 手机）不提供该能力，入口由这里收起。
export interface SessionPaneProps {
  paneId: string;
  sessionId: string | null;
  /** 低基数打开入口，由 pane 宿主提供；缺省仅用于兼容旧调用。 */
  openTrigger?: SessionOpenTrigger;
  rootSessionId?: string;
  // [权衡] readOnly 必须同时在渲染层与命令层生效：只隐藏按钮，快捷键或子组件仍可能调用
  // dispatchCommand，观察视图就写出了不属于自己的编辑；反过来只挡命令却仍渲染 Composer，
  // 用户会以为能输入，而输入框永远不提交。两处都收掉才不会出现半可用状态。
  /** subagent 右侧详情等观察视图：不显示 composer/input，也不发送行内编辑类命令。 */
  readOnly?: boolean;
  /** 观察视图的显式例外：允许文件摘要恢复 workspace，但不开放会话编辑能力。 */
  allowWorkspaceFileRewind?: boolean;
  // [并发] 副屏与只读视图是两种不同的收窄：副屏有独立 composer（会真正发命令），
  // 因此只能按行级能力关掉 edit/retry/fork/goal，不能复用 readOnly 的整体禁用。
  // 把两者合并会造成两种事故之一：副屏失去输入能力，或只读视图获得写入能力。
  /** 框选副屏：保留普通 composer/tools，但隐藏并禁止 edit/retry/fork/goal。 */
  selectionSideChat?: boolean;
  /** 主会话划词动作只投递到 Side Pane 当前激活的辅助 child。 */
  activeSelectionSideChatSessionId?: string | null;
  // [权衡] 身份与路径必须分传：workspaceIdentity 用于隔离键（去重、绑定、缓存、队列），
  // workspacePath 用于 cwd、Git 与展示；远程链路还必须带 remoteSessionId，否则
  // 同路径的不同远端会话会被当成同一个。用路径兼作身份会在多机同名目录下串会话。
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** Prompt 模板埋点当前仅覆盖 Desktop；Web / 手机远控保留 UI 行为但不触发该事件。 */
  isDesktop?: boolean;
  compactForRemoteControl?: boolean;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /** deleteSession：删除当前会话后回到 draft（shell 起新草稿）。 */
  onSessionDeleted?: () => void;
  /** 隐藏副屏的 child 已不存在时，由宿主移除对应 tab。 */
  onSelectionSideChatUnavailable?: () => void;
  // [并发] 分屏下会有多个 pane 同时挂 keydown；focused 是窗口级事件的唯一裁决位。
  // 若每个 pane 都按 canStop 自行消费 Esc，一次按键会同时停掉两个会话的执行。
  /**
   * Focus 层：全局快捷键（Esc stop）与 add-to-chat 事件只路由到
   * focused pane。单 pane 消费者（V4ChatPane）缺省 true。
   */
  focused?: boolean;
  // [失败路径] 该开关只扩大“哪些 DOM 区域算本 pane”，不改变 canStop 判定：
  // 面板关闭后焦点可能停在 body，没有这条授权就永远收不到 Esc，用户只能去点停止按钮。
  // 反过来若无条件放开，侧栏输入框里的 Esc 会把正在跑的会话停掉。
  /** 右侧面板关闭时，主区 focused pane 可接收对话外的 Esc。 */
  allowEscapeStopOutsidePane?: boolean;
  /**
   * pane 是否真实可见。分屏的非 focused pane 仍传 true；forceMount 的隐藏侧栏 tab 传 false。
   * 只影响 foreground UI telemetry，不影响 live subscription 或后台 /event/report。
   */
  telemetryVisible?: boolean;
  /** 关闭本窗格（仅非 primary pane 下发；关 pane ≠ 停 session）。 */
  onClosePane?: () => void;
  /** 跨 workspace pane 的归属徽标（pane workspace ≠ shell 当前 workspace 时下发）。 */
  workspaceBadge?: PaneWorkspaceBadge;
  /**
   * 草稿态 composer 上方的 contextHeader（m5：workspace 切换菜单 + Git 分支）。
   * 由 app-shell 构造下发（依赖 workspaceTabs / 远程连接回调等壳层能力）；
   * 非 primary pane 不下发（workspace 切换是壳级动作）。
   */
  draftComposerHeader?: ReactNode;
  /** 主草稿把 drop controller 提给 app shell 的标题栏；其他 pane 只在自身 surface 消费。 */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
  // Git / 任务摘要由壳层查询后下发：pane 只负责展示，不在这里发起仓库扫描，
  // 否则每个 pane 都会重复 fork 一次 git 命令，分屏时放大成 N 倍。
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** 通知行的产物 chip → 全尺寸查看 tab。 */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  /** 工具卡上的子代理药丸 → transcript tab；与详情页子代理行同一个宿主处理器。 */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** 工具卡上的脚本药丸 → 脚本 transcript tab；与详情页脚本行同一个宿主处理器。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  // 查找态只对当前 focused 且非草稿的 pane 生效：非焦点分屏沿用同一个 query 会
  // 把匹配高亮画到用户没在操作的会话里，导航请求 id 也会互相顶掉。
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

// [权衡] 500ms 是“ACK 已回但清场帧未到”的观察窗口，不是退避重试间隔：
// 太短会在正常往返中误触权威恢复（多一次全量订阅抖动），太长则旧 interaction 在
// 手机上滞留到用户下次点击。取 500ms 让 replayable 清场帧先有机会到达。
const MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS = 500;
// 错误指纹只用于“用户关掉横幅后不要立刻弹回”，因此必须包含足以区分两次错误事件的字段：
// code/at/message 是最小集，traceId 与 detail 用来区分同一 code 的两次不同故障。
// 故意不纳入 UI 文案或语言：切换 locale 不该让已 dismiss 的错误重新出现。
// 也故意不纳入 revision：流式增量会不断推高 revision，那会让 dismiss 完全失效。
function createSessionErrorKey(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): string {
  return [
    sessionId?.trim() || "draft",
    error.code,
    error.at,
    error.message,
    error.traceId ?? "",
    error.detail ?? "",
  ].join(":");
}

// [权衡] 用一个模块级冻结空投影而不是每次 `snapshot?.subagents ?? {...}` 现造对象：
// 后者每次渲染都产生新引用，会让依赖 subagents 的 memo 与 effect 在无数据时也反复触发。
// revision=0 还兼作“尚无权威投影”的哨兵，同步子代理 tab 的 effect 据此跳过。
const EMPTY_SUBAGENT_PROJECTION: NonNullable<ConversationSnapshot["subagents"]> = {
  revision: 0,
  childSessionIds: [],
  running: [],
  endedTotal: 0,
};

// [资源] 缓存上限只约束存在时长，不约束并发：一个长会话里滚过几十个工具卡后，
// 旧 Promise 仍被 Map 持有会让已完成 diff 的闭包（含完整 patch）留在内存里。
// 20 与虚拟列表的可视余量同量级，超过即按插入顺序淘汰最老项。
const MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES = 20;

// 投影错误到 UI 错误是“字段搬运 + 少量补语义”，不要在这里推导新的错误分类：
// • attribution 必须透传，否则同一底层故障会被拆到不同聚类里；
// • taskId 只在 sessionId 存在时补，草稿错误不带会话身份，避免埋点把它算进旧会话；
// • 所有可选字段用条件展开，保持 undefined 与空串的区分（空串是真实内容）。
function toComposerUiError(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): ZCodeUiError {
  return {
    code: error.code,
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.underlyingErrorMessage
      ? { underlyingErrorMessage: error.underlyingErrorMessage }
      : {}),
    ...(error.underlyingErrorDetail ? { underlyingErrorDetail: error.underlyingErrorDetail } : {}),
    // V4 snapshot 已携带安全归因；此处透传归因字段，保证错误按安全归因聚类。
    ...(error.attribution ? { attribution: error.attribution } : {}),
    ...(sessionId ? { taskId: sessionId } : {}),
  };
}

// 从命令 payload 反推“这次提交用的模型/模式”，只服务于两件事：Recent 记录与
// accepted 后写回用户选择。因此只认三种真正携带提交语义的命令：
// createSession 的 firstInput、sendText、sendGoalCommand；其它命令返回 null 是正常的。
// [失败路径] modelSelection 或 mode 缺任何一个都返回 null，而不是猜默认值——
// 猜出来的组合会被写进 Recent 与 Selection 缓存，污染下一次发送的起点。
function submissionConfigFromCommand(
  type: CommandType,
  payload: Record<string, unknown>,
): ComposerSubmissionConfig | null {
  const candidate =
    type === "createSession"
      ? (payload.firstInput as Record<string, unknown> | undefined)
      : type === "sendText" || type === "sendGoalCommand"
        ? payload
        : undefined;
  if (!candidate?.modelSelection || !candidate.mode) return null;
  return {
    modelSelection: candidate.modelSelection as ComposerSubmissionConfig["modelSelection"],
    mode: candidate.mode as ComposerSubmissionConfig["mode"],
    planEnabled:
      typeof candidate.planEnabled === "boolean"
        ? candidate.planEnabled
        : candidate.mode === "plan",
  };
}

// 只读模式下的拖拽语义是“明确拒绝”而不是“没反应”：必须 preventDefault 才不会被
// 浏览器当成默认导航（把文件拖进窗口会直接打开本地文件，丢掉当前会话）。
// dropEffect=none 让光标显示禁止符号，用户能立刻知道这里不接受文件。
function isConversationFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME) ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

// 撤回编辑需要同时给出“要恢复成什么”（文本/附件/配置）和“删除基于哪一版投影”
// （baseRevision）。两者不能分开取：分开取会在删除与恢复之间插入一次新的用户发送，
// 恢复出的草稿就盖住了别人刚发的内容。
// sourceCommandId 用于在删除成功后把 pending 账本一并结清，避免恢复横幅残留。
export interface QueuedComposerRestoreTarget {
  baseRevision: number;
  queueItemId: string;
  sourceCommandId: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: ComposerRestoreRequest["config"];
}

// [事务] 撤回编辑的读取阶段：必须在同一份 snapshot 上同时取 item 与 revision，
// 否则 find 命中的是旧版 item，而 baseRevision 来自新版，删除会因版本不匹配被拒。
// compact 项不返回草稿：它没有文本/附件，撤回成空草稿会让用户误以为消息丢了。
// [失败路径] 末尾的 `...config` 条件展开很关键：空对象不能写入，否则会把
// “未指定”覆盖成空配置，撤回后会清掉用户当前的模型选择。
export function resolveQueuedComposerRestore(
  snapshot: ConversationSnapshot,
  queueItemId: string,
): QueuedComposerRestoreTarget | null {
  const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item || item.kind === "compact") return null;
  const restoresModelSelection =
    item.modelSelection !== undefined &&
    // Bug 根因：旧版本曾把单轮 Highspeed Provider 持久化进队列；撤回编辑若恢复它，
    // Composer 与下一轮 fallback 都会被污染。新队列保存普通模型，这里只兼容旧快照。
    // 旧版本的污染重发可能留下不带卡元数据的此类项，所以只按 Provider Family 判断，
    // 与 CLI 提升迁移保持一致。
    !isHighspeedProviderId(item.modelSelection.providerId);
  const config = {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(restoresModelSelection ? { modelSelection: item.modelSelection } : {}),
  };
  return {
    baseRevision: snapshot.revision,
    queueItemId,
    sourceCommandId: item.sourceCommandId,
    inputKind: item.kind,
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

// [事务] duplicate 视同 accepted：命令已生效，只是我们的请求与既有记录重合。
// 若把 duplicate 当失败，用户会看到队列项已被删除却提示“撤回失败”，
// 下一步很可能再点一次，触发对不存在条目的第二次删除。
export function shouldRestoreQueuedComposerFromAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate";
}

// [并发] 这里的 origin 是一份“同步快照”，不是指针：发送要经过多轮 await（配置补齐、
// 预热会话、命令往返），期间用户可能切走 pane 或改草稿。等 prepare 回来再读当前绑定，
// 就会把卡呈现到错误的 pane 上，或把别人的 task 登记成本 pane 的激活项。
// draftId 单独记录是为了区分“同一 session 的两个草稿”与“草稿已被晋升成正式会话”。
/**
 * Highspeed 发送起点的 pane 绑定（spec §9.2）：在触发发送的同步阶段冻结，prepare 返回时据此
 * 判断 pane 是否仍停在本轮发送所属的 Task / 草稿，决定是否在本 pane 呈现卡并登记激活。
 */
interface HighspeedPaneOrigin {
  sessionId: string | null;
  /** 发送起点时的 pane 绑定代次；草稿首发据此判断 pane 是否离开过该草稿。 */
  paneBinding: number;
  draftId: string | null;
}

// 把 (sessionId, layer, lease) 作为一个不可拆的元组保存：三者只要有一个对不上，
// 这份 lease 就不能用。拆成三个 state 会出现“sessionId 已更新、lease 还是旧的”的中间帧。
interface SessionPaneLeaseBinding {
  sessionId: string | null;
  layer: object;
  lease: SessionLease | null;
}

// [并发] 这里是“渲染期 setState”的受控用法：同一帧内立即返回收紧后的 binding，
// 避免子组件在本次 render 里看到旧 lease；setBinding 只是把修正排给下一次渲染。
// [事务] promoted 分支守住草稿晋升：sessionId 从 null 变成真实 id、layer 未变、
// 且旧 lease 已指向该 session 时，说明正是这次晋升，必须沿用预热 lease，
// 否则会释放刚建立的连接再重订阅，首帧消息可能落在空窗里丢失。
// 原始 binding 留在独立 hook 作用域，不能让 SessionPane 的事件闭包捕获失效 owner。
export function useSessionPaneLease(sessionId: string | null, layer: object) {
  const [binding, setBinding] = useState<SessionPaneLeaseBinding>({
    sessionId,
    layer,
    lease: null,
  });
  if (binding.sessionId !== sessionId || binding.layer !== layer) {
    // Bug 根因：新 session 的首帧若读取旧 lease，稳定回调会捕获旧 snapshot/store，
    // 不同代的共享 render 闭包便会串成保留链。先收紧 owner，再让 acquire effect 接管。
    // 草稿晋升仍复用同一预热 lease；不重挂 Composer，也不提前释放原 effect 的资源。
    const promoted =
      binding.layer === layer &&
      binding.sessionId === null &&
      binding.lease?.sessionId === sessionId;
    const lease = promoted ? binding.lease : null;
    setBinding({ sessionId, layer, lease });
    return [lease, setBinding] as const;
  }
  return [binding.lease, setBinding] as const;
}

// [权衡] 本组件刻意违反“把 snapshot 放进依赖数组”的常规写法：snapshot 每次流式增量
// 都会换引用，若回调依赖它，每次 token 都会重建全部回调，memo 子组件随之整树重渲染。
// 代价是回调读到的是“调用时刻”的 ref 值，因此凡是需要与渲染一致的判定（pane 绑定、
// 队列编辑锁）都必须显式走 ref 或同步快照，不能依赖闭包里的旧变量。
// [并发] 只读/副屏/远控三种形态共用同一实现，靠 props 收窄能力，不 fork 组件树。
/**
 * 单 pane 竖切：订阅 → 渲染 rows → composer 发送 / stop（06-ui §SessionPane）。
 *
 * React 性能（vercel-react-best-practices）：
 * - 叶子组件（Header/Timeline/QueuePanel/InputControls/Composer/GoalBanner）均 memo；
 * - 所有回调用 useCallback 且**不依赖高频变化的 snapshot**——snapshot/composer 文本经 ref 读取，
 *   使回调在流式增量期间保持稳定引用，避免把新函数灌进 memo 子组件触发无谓重渲染；
 * - 模型表单的本地输入 state 下沉到对应子组件，输入时不牵动整个 pane。
 */
export function SessionPane({
  paneId,
  sessionId,
  openTrigger,
  rootSessionId,
  readOnly = false,
  allowWorkspaceFileRewind = false,
  selectionSideChat = false,
  activeSelectionSideChatSessionId = null,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isDesktop = false,
  compactForRemoteControl = false,
  provider,
  onSessionCreated,
  onSelectionSideChatUnavailable,
  focused = true,
  allowEscapeStopOutsidePane = false,
  telemetryVisible = true,
  onClosePane,
  workspaceBadge,
  draftComposerHeader,
  onDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenCodeViewer,
  onAutoOpenAssistantPptx,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenSelectionSideChat,
  onOpenPlanDetail,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  onOpenWorkflowRunDirectory,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: SessionPaneProps) {
  // [资源] paneRef 是分屏归属判定的锚点：Esc、add-to-chat、拖拽都靠 DOM 包含关系
  // 判断事件是否属于本 pane。它必须是真实根节点，不能指向会随空态切换而卸载的子树。
  const paneRef = useRef<HTMLDivElement>(null);
  const remoteAvailable = useRemoteConversationAvailable();
  const {
    layer,
    sendCommand,
    attachmentPut,
    attachmentRead,
    attachmentReadRange,
    onRuntimeRestart,
    onRuntimeLifecycle,
    fileChanges,
    fileRewindPreview,
  // layer 是传输层身份（含远端路由与鉴权上下文），必须与 sessionId 同代使用；
  // attachment* 是二进制通道，fileChanges/fileRewindPreview 是宿主注入的能力端口。
  // [权衡] 这些能力从 context 取而不是从 props 透传，是为了让同一 layer 下的
  // 多个 pane 共享连接与缓存，同时保证换 layer（换远端）时整棵子树自动失效。
  } = useV4Conversation();
  const platform = useOptionalPlatform();
  const {
    conversationShareService,
    highspeedCardService,
    modelSelectionService,
    usageStatsService,
    zcodeSessionService,
    zcodeTaskService,
  } = useServices();
  // [权衡] 文案与语言放在同一 hook 取，保证 share 预览、错误横幅、导出文件名用的是
  // 同一份 locale；分开取会在切换语言的那一帧出现中英混排。
  const { intl, locale } = useZCodeIntl();
  // 斜杠命令列表按 workspace 取：它是“当前工作区注册了哪些命令”的事实，不能跨工作区复用，
  // 否则换目录后仍能补全上一个仓库的自定义命令，执行时会得到 unknown command。
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  const baseWorkspaceServices = useBaseWorkspaceServices();
  const composerClientNamespace = useComposerClientNamespace();
  // [失败路径] draftProjectId 是“新任务草稿归属哪个项目”的唯一来源；它可能为 null
  // （用户还没选项目），此时 scope 仍需可解析——回退到 workspaceIdentity，避免草稿键变成 undefined。
  const composerProjectId = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).draftProjectId,
  );
  // scope 三元组（projectId, workspaceIdentity, clientNamespace）共同决定草稿的存储键。
  // [并发] 必须整体 memo：任何一项变化都代表“换了一个逻辑草稿空间”，
  // 只比较其中一项会让多客户端同名工作区互相读到对方草稿。
  const newTaskComposerScope = useMemo(
    () => resolveComposerScope(composerProjectId, workspaceIdentity, composerClientNamespace),
    [composerProjectId, workspaceIdentity, composerClientNamespace],
  );
  const composerDraftGeneration = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  // [失败路径] 进入 pane 时若存在“上次未发出”的 pending 草稿，需要把它恢复成可见草稿。
  // 三个前置条件缺一不可：当前不是既有会话、尚未选择项目（否则是项目内的新任务）、
  // 且记录的 workspacePath 与当前一致——否则会把 A 仓库的半成品恢复到 B 仓库。
  // composerDraftGeneration 进依赖是为了在用户手动清空草稿后不再把它拉回来。
  const pendingAtEntry = useMemo(() => {
    if (sessionId !== null || newTaskComposerScope.projectId !== null) return null;
    const pending = readPendingTaskDraft(newTaskComposerScope);
    return pending?.workspacePath === workspacePath && pending.commandId ? pending : null;
  }, [sessionId, workspacePath, newTaskComposerScope, composerDraftGeneration]);
  // 用 commandId 而不是文本做“已恢复”标记：用户可能把恢复出的草稿改得面目全非，
  // 按文本比较会反复恢复同一份旧内容。resolvedDraftCommand 一旦等于当前 pending 的
  // commandId，就说明这份草稿已经交给 Composer，后续重渲染不得再次覆盖用户输入。
  const [resolvedDraftCommand, setResolvedDraftCommand] = useState<string | null>(null);
  const recoveringDraft =
    pendingAtEntry?.commandId !== resolvedDraftCommand ? pendingAtEntry : null;
  // 主目录只用于展示“~”缩写与相对路径，不参与任何身份判定；
  // 远端会话的主目录由 remoteSessionId 决定，不能拿本地 HOME 顶替。
  const workspaceHomePath = useWorkspaceHomePath({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  });
  // SessionPane 已位于目标 Workspace 的 ServiceProvider 内，直接订阅该 Host Service；
  // 不再从展示组件二次解析 workspace/remote 路由。
  // [资源] telemetry supervisor 按 (workspace, identity, remote) 取，而不是按 sessionId：
  // 同一工作区的多个 pane 应共享一个上报通道；若按会话建，分屏会重复开连接。
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundEnabled = useScopedConversationTelemetryForegroundEnabled({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  // [并发] owner 必须是稳定对象：attachForeground 用它做引用计数与去重，
  // 每次渲染新建 {} 会让旧 owner 永远无法 detach，前台计数只增不减。
  const conversationTelemetryForegroundOwnerRef = useRef<object>({});
  // [失败路径] 四个条件任意一个不满足都不挂前台：没有 supervisor、宿主明确禁用、
  // 本 pane 不在前台（telemetryVisible=false）、或还没有真实 sessionId（草稿会话不上报）。
  // attachForeground 返回的是解除函数，必须原样作为 cleanup，不能包一层箭头函数丢掉返回值。
  useEffect(() => {
    if (
      !conversationTelemetry ||
      !conversationTelemetryForegroundEnabled ||
      !telemetryVisible ||
      !sessionId
    ) {
      return undefined;
    }
    return conversationTelemetry.attachForeground(
      conversationTelemetryForegroundOwnerRef.current,
      sessionId,
    );
  }, [conversationTelemetry, conversationTelemetryForegroundEnabled, sessionId, telemetryVisible]);
  // [并发] lease 是订阅句柄，不是普通状态：它由 hook 在渲染期收紧、由 effect 负责 acquire，
  // 组件只读不写。把 setLease 暴露给事件回调会制造“当前 render 用旧 lease、下一次却换了”的分裂。
  // 注意 lease 可以与 sessionId 不同代：acquisition 尚未完成时 lease 为 null 是合法中间态。
  const [lease, setLease] = useSessionPaneLease(sessionId, layer);
  // projection 只接受 lease；没有 lease 就没有投影。state 里的 snapshot 才是所有行数据的来源。
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // [并发] runtimeReady 必须同时满足“有 sessionId 时 snapshot 属于该 session”与
  // “runtimeInitialization 未开始或已 ready”。只看 snapshot 存在就放行，会把上一个
  // session 的 rows 当成新会话渲染一帧；只看 status 又会在草稿态（sessionId=null）卡住。
  const runtimeReady =
    sessionId === null ||
    (snapshot?.sessionId === sessionId &&
      (!snapshot.runtimeInitialization || snapshot.runtimeInitialization.status === "ready"));
  // 记录“本 pane 刚创建出来的 sessionId”，用于跳过新会话的入场滚动与已读上报：
  // 新会话的第一帧不应自动滚到“最新未读”，否则用户会看到一次无意义的跳动。
  const newlyCreatedSessionIdRef = useRef<string | null>(null);
  // [事务] share 的四组状态分属不同持久层：drafts 是选择草稿（pending/confirmed），
  // dockStates 是发布进度（可跨组件存活），preflight 缓存是纯内存，attempt 是重试身份。
  // 不能把它们合并成一个 reducer：发布进度必须在关闭弹层后仍可恢复，
  // 而选择草稿必须在取消时立刻丢弃，两者生命周期不同。
  const shareDraft = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.drafts[sessionId] : undefined,
  );
  const shareDockState = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.dockStates[sessionId] : undefined,
  );
  // [失败路径] 没有 dock 记录时用冻结默认值，而不是就地造对象：
  // 默认对象每次渲染换引用会让下面所有依赖 shareDock 的 memo 全部失效。
  // 字段级读取（而不是把 shareDock 整体传下去）让子组件只对真正用到的字段重渲染。
  const shareDock = shareDockState ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
  // 标题回退链：用户手填标题优先，其次会话 meta 标题，最后退回 sessionId。
  // meta.title 会随首条用户消息异步到达，因此这里必须允许空串回退，不能缓存首次结果。
  const shareTitle = shareDock.title ?? snapshot?.meta.title?.trim() ?? sessionId ?? "";
  const shareDisclosureAccepted = shareDock.disclosureAccepted;
  const sharePublishing = shareDock.publishing;
  const shareProgress = shareDock.progress;
  const shareCompletedArtifacts = shareDock.completedArtifacts;
  const shareTotalArtifacts = shareDock.totalArtifacts;
  const publishedShareUrl = shareDock.publishedShareUrl;
  const shareError = shareDock.error;
  const shareWarnings = shareDock.warnings;
  // [事务] shareActive 只表示“浮层打开”，不代表处于范围编辑；范围编辑由
  // pendingExcludedRowIds 是否存在决定（见下一行）。两者分开是状态机的最小形态：
  // 打开 → （可选）进入范围编辑 → 确认/取消。不要新增第三个 stage 字段去重复表达。
  const shareActive = shareDraft?.open === true;
  // pending 草稿存在即处于范围编辑，避免维护第二套 stage/view 状态。
  const shareSelectionPanelVisible = shareActive && shareDraft?.pendingExcludedRowIds != null;
  // 这些 action 选择器返回的是 store 上的稳定函数引用，不属于“会变化的状态”：
  // 订阅它们是为了在 store 重建（HMR / 换 Provider）时拿到新引用，不是为了触发重渲染。
  const closeShare = useConversationShareSelectionStore((value) => value.closeShare);
  const updateShareDockState = useConversationShareSelectionStore((value) => value.updateDockState);
  const confirmShareSelection = useConversationShareSelectionStore(
    (value) => value.confirmSelectionEdit,
  );
  const beginShareSelection = useConversationShareSelectionStore(
    (value) => value.beginSelectionEdit,
  );
  const syncAvailableTurns = useConversationShareSelectionStore(
    (value) => value.syncAvailableTurns,
  );
  const toggleShareRow = useConversationShareSelectionStore((value) => value.togglePendingRow);
  const setAllPendingShareRows = useConversationShareSelectionStore(
    (value) => value.setAllPendingRowsSelected,
  );
  const deselectShareProductTurn = useConversationShareSelectionStore(
    (value) => value.deselectProductTurn,
  );
  const setShareAccessMode = useConversationShareSelectionStore((value) => value.setAccessMode);
  const cancelShareSelection = useConversationShareSelectionStore(
    (value) => value.cancelSelectionEdit,
  );
  // 关闭选择面板 = 丢弃 pending 草稿（cancelSelectionEdit），而不是“隐藏面板”：
  // 隐藏而保留 pending 会让下一次打开直接进入范围编辑态，用户会以为上次的选择还在。
  // sessionId 为空时 no-op：草稿会话没有 share 记录，调用 store 只会创建脏键。
  const dismissShareSelectionPanel = useCallback(() => {
    if (sessionId) cancelShareSelection(sessionId);
  }, [sessionId, cancelShareSelection]);
  // [事务] 待确认行集合 = 可用行 − 排除行。排除源优先 pendingExcludedRowIds，
  // 回退到已确认的 excludedRowIds，这是“未进入编辑时预检仍可用”的关键：
  // 用户没点编辑也要能预览：`pendingShareRowIds` 先取 `pendingExcludedRowIds`，再回退到 `excludedRowIds`。
  // 结果必须转 Set：下面按 rowId 高频查询，数组 includes 在长会话里是 O(n²)。
  const pendingShareRowIds = useMemo(
    () =>
      new Set(
        (shareDraft?.availableRowIds ?? []).filter(
          (id) =>
            !(shareDraft?.pendingExcludedRowIds ?? shareDraft?.excludedRowIds ?? []).includes(id),
        ),
      ),
    [shareDraft],
  );
  // [事务] 计数按 productTurnId 去重，而不是按行数：一个 turn 可能有多行（助手 + 工具），
  // 分享单位是 turn。若按行计数，UI 会显示“将分享 3 项”但实际只产出 1 个产物。
  const pendingShareTurnCount = useMemo(
    () =>
      new Set([...pendingShareRowIds].map((id) => shareDraft?.productTurnIdByRowId[id] ?? id)).size,
    [pendingShareRowIds, shareDraft],
  );
  // 渲染单元只在 rows.window 变化时重建；分享面板与时间线共用这套单元，
  // 保证“看到的行”与“可分享的行”是同一份分组结果，不会出现面板里有、时间线里没有的项。
  const shareRenderUnits = useMemo(
    () => buildConversationTurnRenderUnits(snapshot?.rows.window ?? []),
    [snapshot?.rows.window],
  );
  // 预览文案依赖 intl，必须进依赖数组：切换语言后若沿用旧 items，分享面板会显示旧语言。
  // running 的助手 turn 不能被过滤掉，否则用户看不到“正在生成、暂不可分享”的提示，
  // 真正的过滤放在 eligibleShareItems，保留信息量与可选性两个层次。
  const shareItems = useMemo(
    () =>
      buildConversationShareItems(shareRenderUnits, {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, shareRenderUnits],
  );
  // [并发] 运行中的 turn 不能进入可选集：产物还没落盘，预检会得到“缺文件”，
  // 用户却会以为是权限或路径问题。等 turn 结束、window 更新后这里会自动放开。
  const eligibleShareItems = useMemo(
    () => shareItems.filter((item) => !item.isRunning),
    [shareItems],
  );
  // [事务] 把“可选行 → productTurnId”同步进 share store，是选择器能按 turn 操作的前提。
  // 只在浮层打开时同步：关闭状态下仍写 store 会让后台会话的 window 变化不断改写草稿。
  // rowsById 用当下 window 构建，找不到 productTurnId 的行直接丢弃，不做兜底猜测。
  useEffect(() => {
    if (!sessionId || !shareActive) return;
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    syncAvailableTurns(
      sessionId,
      eligibleShareItems.flatMap((item) => {
        const productTurnId = rowsById.get(item.rowId)?.productTurnId;
        return productTurnId ? [{ rowId: item.rowId, productTurnId }] : [];
      }),
    );
  }, [eligibleShareItems, sessionId, shareActive, snapshot?.rows.window, syncAvailableTurns]);
  // [并发] 直接从 store 同步取值而不是订阅派生：这里要的是“确认态”快照，
  // 依赖 shareDraft 只是借用它作为“草稿版本号”，任何一次选择变更都会让它换引用。
  // 若改成 useMemo 里读 store 却不带 shareDraft 依赖，确认后 UI 会一直显示旧选择。
  const selectedShareProductTurnIds = useMemo(
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
          )
        : [],
    [sessionId, shareDraft],
  );
  // [事务] 预检读取 pending 草稿，确认读取 confirmed：用户在范围编辑里勾选时就能看到
  // “哪些产物会被跳过/阻断”，但真正提交要等他点确认。若这里直接读 confirmed，
  // 预览会滞后一步；若直接提交 pending，取消操作就变得不可逆。
  // 依赖 shareDraft 仍是为了拿版本号：store 内部变化不会自动触发本 memo。
  const preflightShareProductTurnIds = useMemo(
    // 选择器预检读取待确认草稿；取消后自动回到已确认范围，不提前提交选择。
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
            "pending",
          )
        : [],
    [sessionId, shareDraft],
  );
  // [事务] 预检响应携带的“世界状态”（revision / logEpoch / 能力指纹 / 可分享类型）
  // 必须与结果一起保存，并在聚合时整体取用。只存逐 turn 结果而现读 snapshot，
  // 会让 UI 用新 revision 描述旧结果，发布时的权威校验必然对不上。
  // 用 ref 而不是 state：它只在收到响应时整体替换，不需要触发额外渲染。
  const sharePreflightMetaRef = useRef<{
    revision: number;
    logEpoch: string;
    capabilitiesFingerprint: string;
    supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  }>({
    revision: 0,
    logEpoch: "",
    capabilitiesFingerprint: "",
    supportedArtifactTypes: [],
  });
  // 版本号是“手动使 ref 失效”的渲染触发器：ref 变化本身不会重算 memo，
  // 因此清缓存、收到响应、重试之后都必须 bump 一次，让 sharePreflight 重新聚合。
  const [sharePreflightVersion, setSharePreflightVersion] = useState(0);
  // [事务] fingerprint 是缓存失效的唯一依据：它把“这个 turn 的行内容 + 工作区身份 +
  // 会话 revision/logEpoch + 能力指纹”压成一个字符串。任何一项变化都说明产物集合可能变了，
  // 旧预检结果必须弃用。少算某一项（常见是漏掉 capabilitiesFingerprint），
  // 会在权限/导出能力变更后继续复用旧结论，发布阶段才发现文件不可读。
  const selectedShareTurnFingerprints = useMemo(
    () =>
      new Map(
        preflightShareProductTurnIds.map((productTurnId) => [
          productTurnId,
          conversationShareTurnFingerprint(
            snapshot?.rows.window ?? [],
            productTurnId,
            workspacePath,
            {
              workspaceKey: workspaceIdentity?.trim() || workspacePath,
              remoteSessionId: remoteSessionId ?? "",
              sessionId: sessionId ?? "",
              revision: snapshot?.revision,
              logEpoch: snapshot?.logEpoch,
              capabilitiesFingerprint: sharePreflightMetaRef.current.capabilitiesFingerprint,
            },
          ),
        ]),
      ),
    [
      remoteSessionId,
      preflightShareProductTurnIds,
      sessionId,
      sharePreflightVersion,
      snapshot?.logEpoch,
      snapshot?.revision,
      snapshot?.rows.window,
      workspaceIdentity,
      workspacePath,
    ],
  );
  // [事务] 与 preflight 的 turn 列表刻意不同：这里是“当前真正可选的全部 turn”（含未勾选），
  // 用于“全选”与“可分享范围”展示；preflight 只看已选中的 turn，避免为无关 turn 发 RPC。
  // seen 去重是必要的：同一 productTurnId 可能对应多行，重复会让全选计数翻倍。
  const eligibleShareProductTurnIds = useMemo(() => {
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    const seen = new Set<string>();
    return eligibleShareItems.flatMap((item) => {
      const productTurnId = rowsById.get(item.rowId)?.productTurnId;
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
  }, [eligibleShareItems, snapshot?.rows.window]);
  // [资源] 缓存按 scope+cacheKey 放在 ref 而不是 state：预检响应可能并发返回，
  // 用 state 会触发成批重渲染，且响应处理里读不到最新 map。生命周期由下面的
  // scope 切换 / 浮层关闭两个 effect 显式清空，不能依赖组件卸载——pane 会长期存活。
  const sharePreflightCacheRef = useRef(new Map<string, ConversationShareTurnPreflightResult>());
  // [失败路径] 失败结果也进缓存，否则同一 turn 会在每次聚合时重发 RPC，形成失败风暴。
  // 代价是网络恢复后 UI 仍显示旧失败，因此必须提供一个显式的“重试”出口（下一行 token），
  // 由用户手势触发清缓存；不要在 effect 里自动重试，那会在离线时无限打转。
  // 传输类失败会被按 turn 缓存成阻断项，仅靠选择变化无法再次触发 RPC；
  // 重试 token 变化时清缓存并重新发起，避免一次网络抖动把用户卡死在选择阶段。
  const [sharePreflightRetryToken, setSharePreflightRetryToken] = useState(0);
  // scopeKey 用 \u0000 拼接而不是路径分隔符：三个字段都可能包含任意字符（尤其是
  // 远端标识与路径），用可打印字符拼接会出现 “a|b” 与 “a” + “b” 的歧义碰撞，
  // 串 scope 的后果是把 A 会话的预检结果当成 B 会话的。
  const sharePreflightScopeKey = `${workspaceIdentity?.trim() || workspacePath}\u0000${remoteSessionId ?? ""}\u0000${sessionId ?? ""}`;
  const sharePreflightScopeKeyRef = useRef<string | null>(null);
  const sharePreflightCacheKey = useCallback(
    (productTurnId: string) =>
      conversationSharePreflightCacheKey(sharePreflightScopeKey, productTurnId),
    [sharePreflightScopeKey],
  );
  // [失败路径] 重试是“删掉当前选中 turn 的缓存 + 同时 bump 重试 token 与版本号”。
  // 只清 map 不 bump，memo 不会重算，UI 仍是旧失败；只 bump 版本号不清 map，
  // effect 会认为缓存已齐全而不再发 RPC。两个动作必须成对。
  // 只删当前选中的 turn，不整表清空：未选中 turn 的缓存仍然有效，清掉纯属浪费。
  const retrySharePreflight = useCallback(() => {
    for (const productTurnId of preflightShareProductTurnIds) {
      sharePreflightCacheRef.current.delete(sharePreflightCacheKey(productTurnId));
    }
    setSharePreflightRetryToken((token) => token + 1);
    setSharePreflightVersion((version) => version + 1);
  }, [preflightShareProductTurnIds, sharePreflightCacheKey]);
  // 记录“已向服务端水合过哪些 session 的 share 状态”，避免每次打开浮层都重复 hydrate；
  // 只有 session 变化才重置，dock 的发布进度因此能在关闭/重开之间保留。
  const shareHydratedSessionRef = useRef<string | null>(null);
  // [事务] 预检聚合是一个三态状态机：idle（不适用）/ checking（有缺口）/ ready（全部命中）。
  // 必须逐 turn 校验 fingerprint，而不是“有缓存就算 ready”：缓存按 scope+turnId 存，
  // 同一 turn 内容变了但 id 没变时，只有 fingerprint 能识别出来。
  // [失败路径] 只要有一个 turn 缺结果就整体返回 checking，不能部分 ready——
  // 部分结果会让用户在“还有文件没检查”的情况下点发布，权威校验必然失败。
  const sharePreflight = useMemo<ConversationSharePreflightState>(() => {
    if (!shareActive || !sessionId || compactForRemoteControl) {
      return { status: "idle" };
    }
    if (preflightShareProductTurnIds.length === 0) {
      return { status: "idle" };
    }
    const entries = preflightShareProductTurnIds.map((productTurnId) => {
      const entry = sharePreflightCacheRef.current.get(sharePreflightCacheKey(productTurnId));
      return entry?.turnFingerprint === selectedShareTurnFingerprints.get(productTurnId)
        ? entry
        : undefined;
    });
    if (entries.some((entry) => entry === undefined)) {
      return { status: "checking" };
    }
    const resolvedEntries = entries.filter(
      (entry): entry is ConversationShareTurnPreflightResult => entry !== undefined,
    );
    return {
      status: "ready",
      ...sharePreflightMetaRef.current,
      blockingIssues: aggregateConversationShareBlockingIssues(resolvedEntries),
      skippableWarnings: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.skippableWarnings),
      ),
      deferredIssues: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.deferredIssues),
      ),
      turnResults: resolvedEntries,
    };
  }, [
    compactForRemoteControl,
    sessionId,
    preflightShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    shareActive,
    sharePreflightVersion,
  ]);

  // [事务] scope 切换必须整表失效并重置 meta：旧 scope 的 revision/logEpoch 与
  // 新会话完全无关，留着会让新会话的首个预检结果与旧 meta 混用。
  // 用 ref 比较而不是把它写进依赖判断，是为了让“仅 scope 变化”只触发一次清理，
  // 而 session 恢复（同 scope）不会误清。
  useEffect(() => {
    if (sharePreflightScopeKeyRef.current === sharePreflightScopeKey) return;
    sharePreflightScopeKeyRef.current = sharePreflightScopeKey;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sharePreflightScopeKey]);

  // [资源] 浮层关闭或没有会话时清空预检缓存：预检结果可能包含文件摘要与可分享类型，
  // 长期驻留既占内存也延长敏感信息的存活期；重开时重算一次代价可接受。
  // 条件用“非激活”而不是“组件卸载”：pane 常驻，卸载清理根本不会发生。
  useEffect(() => {
    if (shareActive && sessionId) return;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sessionId, shareActive]);

  // [并发] 请求只针对“缺结果”的 turn，已在途/已命中的不重复发；调度器负责合并同一帧内的
  // 多次触发。isCurrent 用 requestScopeKey 与当前 ref 比较，保证 A→B→A 快速切换时，
  // 第一段 A 的迟到响应不会写进第三段 A 的缓存（代次已变，scope 字符串却相同）。
  // [资源] 返回的 cleanup 由调度器取消未发出的请求，避免关闭浮层后仍打 RPC。
  useEffect(() => {
    // 预检结果按 turn 缓存：选择/取消只重新聚合当前选中项，只有首次加入或 turn fingerprint
    // 变化才触发 RPC；发布阶段仍走独立的权威 stat/read/SHA 校验，不能把这里的缓存当成最终事实。
    const requestScopeKey = sharePreflightScopeKey;
    if (
      !shareActive ||
      !sessionId ||
      compactForRemoteControl ||
      preflightShareProductTurnIds.length === 0
    ) {
      return undefined;
    }
    const missingProductTurnIds = getMissingConversationSharePreflightTurnIds(
      sharePreflightScopeKey,
      preflightShareProductTurnIds,
      sharePreflightCacheRef.current,
      selectedShareTurnFingerprints,
    );
    if (missingProductTurnIds.length === 0) return undefined;
    const requestRows = snapshot?.rows.window ?? [];
    return scheduleConversationSharePreflightRequest({
      request: () =>
        conversationShareService.preflight({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          selection: {
            kind: "productTurns",
            productTurnIds: missingProductTurnIds,
          },
        }),
      ...createConversationSharePreflightResponseHandlers({
        sessionId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        missingProductTurnIds,
        requestRows,
        selectedShareTurnFingerprints,
        sharePreflightCacheRef,
        sharePreflightMetaRef,
        sharePreflightCacheKey,
        isCurrent: () => shareActive && requestScopeKey === sharePreflightScopeKeyRef.current,
        onUpdated: () => setSharePreflightVersion((version) => version + 1),
      }),
    });
  }, [
    compactForRemoteControl,
    conversationShareService,
    remoteSessionId,
    preflightShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    sharePreflightRetryToken,
    sharePreflightScopeKey,
    sessionId,
    shareActive,
    snapshot?.rows.window,
    workspaceIdentity,
    workspacePath,
  ]);
  // [并发] sessionLeaseReady 是“lease 已指向当前 session”的判据，不等价于 snapshot 非空：
  // 订阅建立前 openTiming 等元数据仍属于旧代，全部置 undefined 才安全。
  // [事务] 已创建的会话不参与“打开耗时”统计，否则新会话首帧会被算成一次冷打开。
  const sessionLeaseReady = lease?.sessionId === sessionId;
  const shouldMeasureExistingSessionOpen =
    sessionLeaseReady && newlyCreatedSessionIdRef.current !== sessionId;
  // [并发] 打开耗时埋点必须整体绑定到“同一代 lease”：sessionId 与 lease 不同代时，
  // openTiming / rendererTiming / openKind 都不是这次打开的，混着上报会得到负值或错配。
  // enabled 额外排除新建会话，避免把“创建”误报成“打开”。
  useSessionOpenArmsTelemetry({
    sessionId,
    snapshot,
    openTiming: sessionLeaseReady ? state.openTiming : undefined,
    rendererTiming: sessionLeaseReady ? state.rendererTiming : undefined,
    openKind: sessionLeaseReady ? lease?.openKind : undefined,
    openTrigger,
    startedAt: sessionLeaseReady ? lease?.startedAt : undefined,
    status: state.status,
    lastError: state.lastError,
    enabled: shouldMeasureExistingSessionOpen,
    readOnly,
    reporter: platform,
  });
  // 会话被换掉后清掉“刚创建”标记，否则这个 id 会一直留着，导致下次回到同一会话时
  // 仍然跳过入场滚动与打开耗时统计。只在 id 确实变化时清，避免同一会话重渲染抖动。
  useEffect(() => {
    const newlyCreatedSessionId = newlyCreatedSessionIdRef.current;
    if (newlyCreatedSessionId !== null && newlyCreatedSessionId !== sessionId) {
      newlyCreatedSessionIdRef.current = null;
    }
  }, [sessionId]);
  // [资源] 手机 Plan 对账定时器按 interactionId 存：同一交互重复 ACK 时只保留一个定时器，
  // 否则 N 次点击会在 500ms 后触发 N 次权威恢复，把整个 store 重放一遍。
  const mobilePlanInteractionReconcileTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  // [资源] 换代（lease/sessionId 变化）必须清掉所有待触发的定时器：旧 lease 的定时器
  // 若在新代执行，会拿着旧 store 触发恢复，把已经切走的会话重新拉回权威态。
  // cleanup 里同时 delete 上的 clearTimeout，是因为 timers 是 ref，不会随渲染重建。
  useEffect(() => {
    const timers = mobilePlanInteractionReconcileTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [lease, sessionId]);
  // [并发] 只在远控（compactForRemoteControl）形态启用：桌面连续流会自然收到清场帧，
  // 额外恢复反而打断正在进行的回合。定时器回调里重新读 lease.store 的权威快照，
  // 而不是闭包里的 snapshot——500ms 内 snapshot 可能已经推进过多版。
  // 若 grace 后仍 pending，说明清场帧确实丢了，此时才走既有 same-sub recovery。
  const handleMobilePlanInteractionAccepted = useCallback(
    (interactionId: string) => {
      if (!compactForRemoteControl || !lease) return;
      const timers = mobilePlanInteractionReconcileTimersRef.current;
      if (timers.has(interactionId)) return;
      const timer = setTimeout(() => {
        timers.delete(interactionId);
        const authoritativeSnapshot = lease.store.getState().snapshot;
        const stillPending = authoritativeSnapshot?.pendingInteractions.some(
          (interaction) => interaction.interactionId === interactionId,
        );
        if (!stillPending) return;
        // Bug 根因：手机 Plan 回执 ACK 与 replayable 清场分属两条异步路径；清场帧
        // 丢失时旧 interaction 会永久驻留。只在 grace 后仍读到权威 pending 时复用
        // 既有 same-sub recovery，不本地隐藏弹窗，也不影响 desktop continuous。
        logger.warn("[v4-pane] 手机 Plan ACK 后 pending 未收口，触发权威恢复", {
          interactionId,
          sessionId,
          workspaceKey: workspaceIdentity?.trim() || workspacePath,
        });
        lease.store.recoverFromStaleAuthority();
      }, MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS);
      timers.set(interactionId, timer);
    },
    [compactForRemoteControl, lease, sessionId, workspaceIdentity, workspacePath],
  );
  // [并发] 插件引用图标必须同时满足“目录已就绪且属于当前 session”与“窗口里确实有
  // 引用插件的用户行”。只看 catalog 状态会让图标在没有任何引用时也出现；
  // 只看行又可能在目录未就绪时拿到空元数据，渲染出破图。
  const pluginReferenceIconsEnabled =
    isSessionPluginCatalogReady(state.status, sessionId, snapshot?.sessionId) &&
    hasPluginReferenceUserRows(snapshot?.rows.window ?? []);
  // [并发] 遍历整个 window 而不是只看尾部：后台结果行可能紧跟在用户消息后面，
  // 只看末尾会漏掉用户那一行，把已渲染误判成 render_timeout。supervisor 侧按
  // sourceCommandId 做 O(1) 过滤，历史回填推来的老 row 不会误触发。
  // send_result 的落定信号：用户消息真正画进对话历史。z-code 没有乐观渲染，
  // 气泡必须等投影回流出 userInput row 才出现，所以 ACK accepted 不能算发送完成。
  // 取 useEffect 而非 store 订阅回调 —— effect 在 DOM commit 之后跑，此刻气泡已在屏幕上。
  useEffect(() => {
    const rows = snapshot?.rows.window;
    if (!rows || rows.length === 0) return;
    // 不能只取最后一条 userInput：后台结果行可能紧随其后插到尾部，
    // 只看尾部会漏掉用户自己那条，误判成 render_timeout。supervisor 侧按
    // 待渲染表 O(1) 过滤，历史回填 / 切会话重载推来的老 row 不会误触发。
    for (const row of rows) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        conversationTelemetry?.notifyUserInputRendered(row.sourceCommandId);
      }
    }
  }, [conversationTelemetry, snapshot]);
  // [资源] 缓存按 (fileChanges 端口, sessionId, logEpoch) 重建：logEpoch 变化意味着
  // 会话日志可能被重写/压缩，旧的 diff Promise 结果不再可信。放在 useMemo 里
  // 而不是 ref，是为了让换代时新 map 立即生效，旧 map 随闭包自然回收。
  const fileChangesRequestCache = useMemo(
    () => new Map<string, Promise<V4ConversationFileChangesResult>>(),
    [fileChanges, sessionId, snapshot?.logEpoch],
  );
  // dismissedErrorKeys 存的是错误指纹而不是错误对象：对象在每次投影更新时都会换引用，
  // 用它做集合成员判断会让 dismiss 立即失效。数组而不是 Set 是为了能整体持久化/比较。
  // [失败路径] 这里只保存“用户主动关掉”的键，不清空来源错误；新错误指纹不同，仍会显示。
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<readonly string[]>([]);
  // sendSubmissionError 是“本 pane 发起、尚未被权威错误取代”的提交失败：
  // 它与 projection.error 分开，避免用户看到同一条错误出现两次（本地 + 权威）。
  const [sendSubmissionError, setSendSubmissionError] = useState<ZCodeUiError | null>(null);
  const [paneLocalSummaryPanelVariantOverride, setPaneLocalSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  // 三个折叠区的开合是纯 UI 记忆：不放进 store，避免分屏时两个 pane 联动展开；
  // 也不持久化，因为它们只对当前窗口尺寸下的阅读动线有意义。
  const [terminalSectionOpen, setTerminalSectionOpen] = useState(false);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [workflowSectionOpen, setWorkflowSectionOpen] = useState(false);
  // 拖拽控制器由 Composer 注册、pane 转发给宿主：宿主需要在整窗范围内画遮罩，
  // 因此必须拿到同一份 active/kind 状态，而不是各画各的。
  const [dropTargetController, setDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  // 本地 state 与宿主回调必须同时更新：只更新一处会导致“pane 内显示可拖入、
  // 宿主遮罩不出现”，或反之。回调是可选的外部观察者，不能让它决定本地状态。
  const handleDropTargetControllerChange = useCallback(
    (controller: ConversationDropTargetController | null) => {
      setDropTargetController(controller);
      onDropTargetControllerChange?.(controller);
    },
    [onDropTargetControllerChange],
  );
  // [权衡] 只读视图不“没有控制器”，而是拥有一个明确拒绝的控制器：
  // 返回 null 会让拖拽穿透到浏览器默认行为（打开本地文件），必须 preventDefault。
  // onDragOver 仍要判 isConversationFileDrag，普通文本拖拽应保持原生可选行为。
  // dropEffect="none" 是给用户的可视反馈，与 preventDefault 分工不同。
  const readOnlyDropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: false,
      kind: null,
      onDragLeave: () => {},
      onDragOver: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      },
      onDrop: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [],
  );
  // readOnly 在渲染层直接替换控制器，而不是在 Composer 里逐事件判断：
  // 后者只要漏掉一个 onDrop 分支，观察视图就能导入文件。替换保证没有第二份路径。
  const effectiveDropTargetController = readOnly
    ? readOnlyDropTargetController
    : dropTargetController;
  const isMobileTextInputViewport = useIsMobileTextInputViewport();

  // [并发] snapshotRef 必须每次渲染同步赋值（而不是放 useEffect）：命令回调可能在
  // commit 前的同一事件循环里被调用，effect 里的赋值会慢一拍，读到上一版 rows。
  // sessionIdRef 同理，用于判定 ACK 回来时 pane 是否还在同一会话。
  // 稳定回调读取的最新值经 ref 透传，避免回调依赖高频变化的 snapshot/文本。
  const snapshotRef = useRef<ConversationSnapshot | null>(snapshot);
  const sessionIdRef = useRef(sessionId);
  // [事务] 激活卡是“服务端已抽中、本 pane 正在展示”的那一张，必须带 cardId；
  // 它既驱动 Composer 的加速态，也决定模型选择是否被锁定。null 表示当前无卡，
  // 不能用一个布尔替代——布尔无法表达“换成了另一张卡”。
  const [activeHighspeedCard, setActiveHighspeedCard] = useState<HighspeedCardSnapshot | null>(
    null,
  );
  // [失败路径] 作废必须“先 claim 再调用”：同一失败可能由多个入口同时触发，
  // claim 保证只有一个请求真正发出；失败时 release，让用户重试仍有机会成功。
  // 成功回调里用 current?.cardId 比较，而不是无条件置 null：期间可能已经抽中新卡，
  // 旧失败的收尾不能把新卡一起清掉（对应 INV-22）。
  const invalidateActiveHighspeedCard = useCallback(
    (cardId: string, failureKey: string) => {
      if (!claimHighspeedCardInvalidation(failureKey)) return;
      void highspeedCardService
        .invalidateCard(cardId)
        .then(() => {
          // Bug 根因：Highspeed 失败后若卡仍留在服务里，Composer 会继续显示加速态并锁死模型选择。
          // Service 按 cardId 作废唯一真相，再清同一张卡的展示投影；旧失败不能清掉后来抽中的新卡。
          setActiveHighspeedCard((current) => (current?.cardId === cardId ? null : current));
        })
        .catch((error) => {
          releaseHighspeedCardInvalidation(failureKey);
          logger.warn("[highspeed] 作废失败的加速卡失败", {
            cardId,
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    [highspeedCardService, sessionId],
  );
  // [事务] 激活 id 是一次性令牌：发送路径抽中新卡时写入，Composer 消费一次即清。
  // 不能用 activeHighspeedCard 兼任，因为“同一张卡恢复展示”与“刚抽中新卡”的动效不同。
  // 激活动效的一次性请求：只由发送路径 draw 新命中登记，composer 锁定入场方式后消费。
  const [highspeedActivationCardId, setHighspeedActivationCardId] = useState<string | null>(null);
  // [并发] 记录“本 pane 已经呈现给用户的卡”。发送时如果拿到的还是同一张卡，
  // 说明这是恢复/复用而不是新命中，不应再播入场动效，也不应重复登记 metrics。
  // 本 pane 最近呈现过的卡片身份：恢复与复用同一张卡的发送据此判定不是新命中。
  const presentedHighspeedCardIdRef = useRef<string | null>(null);
  // [资源] 指标上报存在在途去重：同一 cardId 的曝光/消耗可能被多次渲染路径触发，
  // 用 Set 记录在途 key，完成后再删，避免重复计数；不做持久去重是因为重试应当重新上报。
  const highspeedMetricsInFlightRef = useRef(new Set<string>());
  // [并发] Highspeed turn 数据存在组件树之外的轻量 store 里，用 useSyncExternalStore 订阅：
  // 它变化频率高于 snapshot 但只影响加速卡的少量 UI，走 context 会牵动整棵 memo 树。
  // 第三个参数是 SSR/首帧快照，必须与客户端取同一函数，否则水合会因版本号不同而告警。
  const highspeedTurnVersion = useSyncExternalStore(
    subscribeHighspeedTurns,
    getHighspeedTurnVersion,
    getHighspeedTurnVersion,
  );
  const [highspeedAutoShareClock, refreshHighspeedAutoShareClock] = useState(0);
  // [并发] dispatchCommandRef 是打破循环依赖的桥：effect / 子组件回调需要下发命令，
  // 但 dispatchCommand 本身依赖大量 state 与 memo，直接进依赖数组会让它们每帧重建。
  // 因此这里只保存函数引用，真正的赋值在 dispatchCommand 定义之后完成；
  // 调用方必须容忍“首帧尚未赋值”的 null，不能假设它总是可用。
  const dispatchCommandRef = useRef<
    | ((
        type: CommandType,
        payload: Record<string, unknown>,
        targetSessionId: string | null,
        baseRevision?: number,
        baseLogEpoch?: string,
      ) => Promise<CommandAck>)
    | null
  >(null);
  // [事务] 自动打开 PPT 的去重键含文件路径与来源 turn：同一文件在同一 turn 只打开一次，
  // 但不同 turn 重新生成同一路径时应允许再次打开，否则用户看不到新版本。
  const autoOpenedAssistantPptxKeysRef = useRef<Set<string>>(new Set());
  const assistantPreviewPptxGateRef = useRef(createAssistantPreviewPptxAutoOpenGateState());
  const [assistantPreviewPptxAutoOpenTarget, setAssistantPreviewPptxAutoOpenTarget] =
    useState<AssistantPreviewPptxAutoOpenTarget | null>(null);
  const autoLoadIncompleteTurnCursorRef = useRef<string | null>(null);
  snapshotRef.current = snapshot;
  sessionIdRef.current = sessionId;
  // [失败路径] 先查重再登记，且登记同步完成：两个子组件在同一帧上报同一个 key 时，
  // 若等 await 之后再登记会双重打开。宿主未提供回调时直接返回，避免无意义占位。
  // key 一旦登记就不再删除，这是有意的：重新挂载 Timeline 不应重放自动打开。
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!onAutoOpenAssistantPptx || request.sources.length === 0) return;
      if (autoOpenedAssistantPptxKeysRef.current.has(request.key)) return;
      autoOpenedAssistantPptxKeysRef.current.add(request.key);
      onAutoOpenAssistantPptx(request);
    },
    [onAutoOpenAssistantPptx],
  );
  // [并发] Composer 的实时状态（是否有内容、是否忙）由子组件写入 ref，
  // 供跨 await 的发送/停止逻辑读取，避免把这些高频值提升成 pane state 触发整树重渲染。
  // 初始值 false/false 表示“尚未挂载”，调用方应把未挂载视为不可发送。
  const composerDraftStateRef = useRef({ hasContent: false, busy: false });
  // [事务] 队列编辑锁记录三件事：哪一项、属于哪个会话、哪个工作区。
  // 只记 queueItemId 不够：A 会话的撤回请求在途时切到 B，ACK 回来若无 session/workspace
  // 校验，就会把 B 的 Composer 恢复成 A 的草稿（对应 INV-12 / INV-13）。
  // 它同时是 Composer 的 disabled 依据，非空即表示有编辑事务在途。
  const [queueEditOperation, setQueueEditOperation] = useState<{
    queueItemId: string;
    sessionId: string;
    workspaceKey: string;
  } | null>(null);
  // queueEditOperationRef 与其 state 同步镜像：回调在 await 之后需要判断“锁是否还是我拿的”，
  // 不能读闭包里的旧 state。state 负责渲染，ref 负责事务判定，两者必须同帧一致。
  const queueEditOperationRef = useRef(queueEditOperation);
  queueEditOperationRef.current = queueEditOperation;
  // [事务] 恢复请求用自增 id 标识，Composer 消费后回执对应 id，避免“恢复 A 尚未应用、
  // 紧接着又恢复 B”时两次写入互相覆盖。请求对象只增不改，天然可比较。
  const [composerRestoreRequest, setComposerRestoreRequest] =
    useState<ComposerRestoreRequest | null>(null);
  const nextComposerRestoreRequestIdRef = useRef(1);
  const timelineScrollToBottomRef = useRef<(() => void) | null>(null);
  const timelineScrollToQueryRef = useRef<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >(null);
  // [资源] 容器 ref 用于测量可视区高度与滚动锚点；它必须挂在稳定的外层，
  // 不能挂在空态/时间线之间来回切换的节点上，否则布局切换会让测量瞬时归零。
  const conversationLayoutContainerRef = useRef<HTMLDivElement>(null);
  // [权衡] 摘要面板形态允许受控或非受控：宿主传了 onSummaryPanelVariantOverrideChange
  // 就完全交给宿主（便于多 pane 同步/持久化），否则退化为 pane 本地记忆。
  // 不能两者都写：双写会让宿主的受控值被本地下一次点击覆盖，出现“点了没反应”。
  const hasExternalSummaryPanelVariantControl = Boolean(onSummaryPanelVariantOverrideChange);
  const effectiveSummaryPanelVariantOverride = hasExternalSummaryPanelVariantControl
    ? (summaryPanelVariantOverride ?? null)
    : paneLocalSummaryPanelVariantOverride;
  const handleSummaryPanelVariantChange = useCallback(
    (variant: ChatViewSummaryPanelVariant | null) => {
      if (onSummaryPanelVariantOverrideChange) {
        onSummaryPanelVariantOverrideChange(variant);
        return;
      }
      setPaneLocalSummaryPanelVariantOverride(variant);
    },
    [onSummaryPanelVariantOverrideChange],
  );

  // workspaceKey 是“逻辑工作区”的稳定键：有 identity 时优先用它，路径只作回退。
  // 队列、缓存、绑定代次都以它为前缀，保证同路径不同远端不会互相命中。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // [并发] 渲染期同步推进代次，是给跨 await 的发送路径一个“同步冻结”的锚点：
  // A→B→A 时 sessionId 回到原值，但 generation 已 +2，发送回调据此知道 pane 离开过。
  // 若改成 effect 里递增，发送在 commit 前就能读到旧代次，起点的冻结就失效了。
  // pane 每次重新绑定 Task / 工作区时递增代次：A → B → A 后 sessionId 相同但代次不同。
  // 与 sessionIdRef 一样在渲染期同步，供跨 await 的发送回调读取最新绑定。
  const paneBindingKey = `${workspaceKey}\u0000${sessionId ?? ""}`;
  const paneBindingRef = useRef({ key: paneBindingKey, generation: 0 });
  if (paneBindingRef.current.key !== paneBindingKey) {
    paneBindingRef.current = {
      key: paneBindingKey,
      generation: paneBindingRef.current.generation + 1,
    };
  }
  // [并发] 恢复加速卡时要校验三个条件：卡属于当前 taskId、未过期、请求未被取代（disposed）。
  // 只校验 cardId 会把别的会话抽中的卡显示到本 pane；不校验过期会让僵尸卡重新出现。
  // 任何异常都降级为“无卡”，输入框按普通状态展示，绝不因为读卡失败而阻塞发送。
  useEffect(() => {
    let disposed = false;
    if (!sessionId) {
      setActiveHighspeedCard(null);
      return () => undefined;
    }
    void highspeedCardService
      .getSnapshot()
      .then((serviceSnapshot) => {
        if (disposed) return;
        const card = serviceSnapshot.card;
        const now = Date.now();
        if (!card || card.taskId !== sessionId || card.expiresAt <= now) {
          setActiveHighspeedCard(null);
          return;
        }
        presentedHighspeedCardIdRef.current = card.cardId;
        setActiveHighspeedCard(card);
      })
      .catch((error) => {
        if (disposed) return;
        setActiveHighspeedCard(null);
        logger.warn("[highspeed] 读取卡片状态失败，输入框按普通状态展示", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    return () => {
      disposed = true;
    };
  }, [highspeedCardService, sessionId]);
  // [失败路径] 这里是“用墙钟兜住单调时钟”的双保险：clearIfExpired 负责判定，
  // arm 负责在剩余时长后重判；visibilitychange/focus 负责页面被冻结后的补偿。
  // 三者缺一：只靠 timer 会被息屏冻住；只靠事件则常驻前台时永不到期。
  // 清卡时按 cardId 条件清除，避免清掉期间新抽中的卡（INV-22）。
  useEffect(() => {
    if (!activeHighspeedCard) return;
    const cardId = activeHighspeedCard.cardId;
    const expiresAt = activeHighspeedCard.expiresAt;
    // Bug 根因：清卡曾只依赖一次性 setTimeout；窗口隐藏/息屏时页面被 Chromium 冻结、
    // 定时器停摆，唤醒后积压的 timeout 迟迟不触发，而 composer 倒计时是每秒读 Date.now()
    // 的 interval、唤醒即自愈——出现「倒计时已到 00:00:00 但输入框加速态不退出」的僵尸卡，
    // 只能等下一条消息的 prepareTurn 救活。回到窗口时按真实时钟重估：已过期立即清卡，
    // 未过期重挂剩余时长（与下方分享时钟补偿同口径，spec §9.2/§9.3）。
    const clearIfExpired = () => {
      if (Date.now() < expiresAt) return false;
      setActiveHighspeedCard((current) => (current?.cardId === cardId ? null : current));
      return true;
    };
    if (clearIfExpired()) return;
    let timer: number | undefined;
    const arm = () => {
      window.clearTimeout(timer);
      // Bug 根因：setTimeout 按单调时钟计时，到期判定读墙钟 Date.now()；两者的毫秒级偏差或
      // NTP 回拨会让 timer 在墙钟到期前触发。只判定不重挂时，窗口常驻前台的加速态永不退出。
      timer = window.setTimeout(() => {
        if (!clearIfExpired()) arm();
      }, expiresAt - Date.now());
    };
    arm();
    const refreshFromWindowWake = () => {
      if (document.visibilityState === "hidden") return;
      if (!clearIfExpired()) arm();
    };
    document.addEventListener("visibilitychange", refreshFromWindowWake);
    window.addEventListener("focus", refreshFromWindowWake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshFromWindowWake);
      window.removeEventListener("focus", refreshFromWindowWake);
    };
  }, [activeHighspeedCard]);
  // [事务] 自动分享时钟的起点是整张卡的 expiresAt，而不是单轮 turn 完成：
  // 一次抽卡覆盖多轮时，按 turn 触发会在第一轮就提前发布不完整的卡。
  // +20ms 是为了跨过到期边界，保证 resolve 时读到的是“已到期”而非“还差 1ms”。
  // 依赖 highspeedTurnVersion 让新 turn 完成时重新计算下一次唤醒点。
  useEffect(() => {
    if (!sessionId) return;
    const nextAutoShareAt = resolveNextHighspeedAutoShareAt(sessionId);
    if (nextAutoShareAt === null) return;
    const delayMs = Math.max(0, nextAutoShareAt - Date.now()) + 20;
    // Bug 根因：旧逻辑以 Turn 完成为分享时钟，第一轮结束就发布卡片；这里改由整张卡
    // 的 expiresAt 唤醒聚合流程，卡到期时若仍有 Turn 运行，则等待其完成事件再次触发。
    const timer = window.setTimeout(
      () => refreshHighspeedAutoShareClock((revision) => revision + 1),
      delayMs,
    );
    return () => window.clearTimeout(timer);
  }, [highspeedTurnVersion, sessionId]);
  // [资源] 页面冻结期间的 timer 停摆不会补发，因此回窗时必须主动补一次时钟。
  // 聚合链路自身有 claim/幂等保护，所以这里可以放心地“可能重复触发”，
  // 不需要再做防抖；重复触发最多多一次空聚合。
  useEffect(() => {
    if (!sessionId) return;
    // Bug 根因（2026-08-31）：到期唤醒依赖 renderer setTimeout；窗口隐藏/被遮挡时页面被
    // Chromium 冻结，定时器停摆，卡级 TPS 采样与完成态持久化停在原地，footer 查看按钮
    // 一直置灰，直到用户再发一条消息才被 store 版本号变化救活（违反 spec 9.3「到期边界
    // 由会话时间时钟触发重渲染，不要求用户再发送一条消息」）。回到窗口时立即补一次
    // 时钟；聚合链路各入口均有 claim/幂等保护，重复触发无副作用。
    const refreshFromWindowWake = () => {
      if (document.visibilityState === "hidden") return;
      refreshHighspeedAutoShareClock((revision) => revision + 1);
    };
    document.addEventListener("visibilitychange", refreshFromWindowWake);
    window.addEventListener("focus", refreshFromWindowWake);
    return () => {
      document.removeEventListener("visibilitychange", refreshFromWindowWake);
      window.removeEventListener("focus", refreshFromWindowWake);
    };
  }, [refreshHighspeedAutoShareClock, sessionId]);
  // [事务] 从会话记录水合 Highspeed 统计：这是“冷启动/远端回放”时唯一能恢复已完成 turn 的路径。
  // 先按 userInput 行补登历史，再用权威行撤销“预登记但实际未提升”的 turn——
  // 后者是关键，否则卡过期后普通输出会被错误计入 Highspeed 分享指标。
  // 必须校验 snapshot.sessionId 与当前一致，避免把旧会话的 rows 水合进新会话。
  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const terminalStates = new Set(["completedSuccess", "completedInterrupted", "failed"]);
    hydrateHighspeedTurnsFromTranscript(
      sessionId,
      snapshot.rows.window
        .filter((row): row is UserInputRow => row.kind === "userInput")
        .map((row) => ({
          sourceCommandId: row.sourceCommandId,
          createdAt: row.createdAt,
          highspeed: row.highspeed,
        })),
    );
    const pendingTurns = listPendingHighspeedTurns(sessionId);
    for (const record of pendingTurns) {
      const userRow = snapshot.rows.window.find(
        (row) => row.kind === "userInput" && row.sourceCommandId === record.sourceCommandId,
      );
      if (userRow?.kind === "userInput" && !userRow.highspeed) {
        // Bug 根因：Highspeed queue 在 admission ACK 时先登记统计；若真正提升时卡已过期，
        // CLI 会移除 Highspeed intent 并走原模型。以权威 user row 撤销预登记，避免普通
        // 输出被错误计入 Highspeed 分享。
        discardHighspeedTurn(record.sourceCommandId);
        continue;
      }
      const header = snapshot.rows.window.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === record.sourceCommandId,
      );
      // 诊断（debug，随 snapshot 高频触发）：完成态统计迟迟收不了口时，日志直接点名卡在哪。
      if (!header || header.kind !== "turnHeader") {
        logger.debug("[highspeed] turn 统计未完成：rows.window 中缺少 turnHeader", {
          sourceCommandId: record.sourceCommandId,
        });
        continue;
      }
      if (!terminalStates.has(header.state) || header.outputTokens === undefined) {
        logger.debug("[highspeed] turn 统计未完成：turnHeader 非终态或无 outputTokens", {
          sourceCommandId: record.sourceCommandId,
          state: header.state,
          hasOutputTokens: header.outputTokens !== undefined,
        });
        continue;
      }
      const durationMs = Math.max(
        0,
        header.activeMs ?? (header.endedAt !== undefined ? header.endedAt - header.startedAt : 0),
      );
      completeHighspeedTurn({
        sourceCommandId: record.sourceCommandId,
        outputTokens: header.outputTokens,
        durationMs,
        ...(header.modelDurationMs !== undefined
          ? { modelDurationMs: header.modelDurationMs }
          : {}),
        ...(header.toolDurationMs !== undefined ? { toolDurationMs: header.toolDurationMs } : {}),
        ...(header.otherDurationMs !== undefined
          ? { otherDurationMs: header.otherDurationMs }
          : {}),
      });
    }

    // [事务] 卡级 TPS 只在“到期且尚缺数据”时查询一次，claim 用尽后不再重试：
    // 这是有意的上限，避免一个无法返回有效值的卡在每次 snapshot 更新时反复打服务。
    // 失败/无效数据都只记录诊断日志，不写任何本地统计，保证分享指标只来自权威值。
    const autoShareNow = Date.now();
    for (const card of listExpiredHighspeedCardsAwaitingTps(sessionId, autoShareNow)) {
      if (!claimHighspeedHealthyAttempt(card.cardId, card.allTurnsCompleted)) {
        // 诊断（debug）：每卡到期一次 + 完成后补查一次，机会用尽仍无 TPS 时分享链路必然停摆。
        logger.debug("[highspeed] 卡级 healthy 查询机会已用尽，仍无有效 TPS", {
          cardId: card.cardId,
          allTurnsCompleted: card.allTurnsCompleted,
        });
        continue;
      }
      void highspeedCardService
        .healthy(card.cardId)
        .then((usage) => {
          if (usage.completionTokens <= 0 || usage.durationSeconds <= 0) {
            logger.warn("[highspeed] 卡级 healthy 未返回有效 TPS，本轮完成后再补查", {
              cardId: card.cardId,
              completionTokens: usage.completionTokens,
              durationSeconds: usage.durationSeconds,
            });
            return;
          }
          setHighspeedCardTps(card.cardId, usage.completionTokens / usage.durationSeconds);
        })
        .catch((error) => {
          logger.warn("[highspeed] 卡级 healthy 查询失败，本轮完成后再补查", {
            cardId: card.cardId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    // [并发] dispatch 可能尚未赋值（dispatchCommand 定义在本 effect 之后）。
    // 拿不到就整段跳过是安全的：下一次 snapshot/时钟触发会重试，不会丢数据。
    const dispatch = dispatchCommandRef.current;
    if (dispatch) {
      for (const record of listHighspeedTurnsAwaitingMetricsPersistence(sessionId)) {
        if (!record.metrics || highspeedMetricsInFlightRef.current.has(record.sourceCommandId)) {
          continue;
        }
        const userRow = snapshot.rows.window.find(
          (row): row is UserInputRow =>
            row.kind === "userInput" && row.sourceCommandId === record.sourceCommandId,
        );
        const regularTps = record.card.regularTps ?? userRow?.highspeed?.regularTps;
        const highspeedTps = getHighspeedCardTps(record.card.cardId);
        // 诊断（debug）：持久化前置条件缺失会让该轮永远停在等待队列里，静默跳过无法定位。
        if (!userRow || !userRow.entityId || !regularTps || !highspeedTps) {
          logger.debug("[highspeed] 完成态持久化前置缺失，本轮暂不派发", {
            sourceCommandId: record.sourceCommandId,
            userRowInWindow: userRow !== undefined && userRow !== null,
            hasEntityId: Boolean(userRow?.entityId),
            hasRegularTps: Boolean(regularTps),
            hasCardTps: Boolean(highspeedTps),
          });
          continue;
        }
        const savedDurationMs = calculateHighspeedSavedDurationFromMetrics(
          record.metrics,
          regularTps,
          highspeedTps,
        );
        // [事务] 先把 sourceCommandId 放进在途集合再发命令，防止 effect 重入时重复派发；
        // finally 里无论成功失败都移除，让“失败后下次 snapshot 还能再试”。
        // metricsPersisted 只用于 ACK 成功后的显式唤醒，不能被 finally 的清理顺序影响。
        highspeedMetricsInFlightRef.current.add(record.sourceCommandId);
        let metricsPersisted = false;
        void dispatch(
          "setHighspeedMetrics",
          {
            target: { rowId: userRow.rowId, entityId: userRow.entityId },
            regularTps,
            outputTokens: record.metrics.outputTokens,
            durationMs: record.metrics.durationMs,
            highspeedTps,
            savedDurationMs,
            ...(record.metrics.modelDurationMs !== undefined
              ? { modelDurationMs: record.metrics.modelDurationMs }
              : {}),
            ...(record.metrics.toolDurationMs !== undefined
              ? { toolDurationMs: record.metrics.toolDurationMs }
              : {}),
            ...(record.metrics.otherDurationMs !== undefined
              ? { otherDurationMs: record.metrics.otherDurationMs }
              : {}),
          },
          sessionId,
          snapshot.revision,
          snapshot.logEpoch,
        )
          .then((ack) => {
            if (ack.status !== "accepted" && ack.status !== "duplicate") {
              logger.warn("[highspeed] 完成态统计持久化被拒绝", {
                reasonCode: ack.reasonCode,
                sourceCommandId: record.sourceCommandId,
                status: ack.status,
              });
              return;
            }
            markHighspeedTurnMetricsPersisted(record.sourceCommandId, savedDurationMs);
            metricsPersisted = true;
          })
          .catch((error) => {
            logger.warn("[highspeed] 完成态统计持久化失败", {
              error: error instanceof Error ? error.message : String(error),
              sourceCommandId: record.sourceCommandId,
            });
          })
          .finally(() => {
            highspeedMetricsInFlightRef.current.delete(record.sourceCommandId);
            // Bug 根因：持久化 ACK 触发的 store 更新可能先于 in-flight 清理被 React 消费，
            // 导致本轮重算被跳过；ACK 成功后显式唤醒一次，避免必须发送下一条 prompt。
            if (metricsPersisted) {
              refreshHighspeedAutoShareClock((revision) => revision + 1);
            }
          });
      }
    }

    // [事务] 自动分享必须先 claim 再发布：失败时只清 in-flight 会让下一次 snapshot
    // 重复触发同一张卡的发布，最终打爆通知/限流。claim 失败即静默跳过。
    // 分享内容全部来自本地统计（不再请求后端 share 接口），因此这里没有网络失败路径。
    for (const candidate of listHighspeedCardAutoShareCandidates(sessionId)) {
      if (candidate.expiresAt > autoShareNow) continue;
      // Bug 根因：失败后只清理 in-flight 会让后续 snapshot 重复触发自动分享，最终打到 429。
      if (!claimHighspeedCardAutoShare(candidate.cardId, autoShareNow)) continue;
      // 分享卡片改为客户端生成，不再请求后端 share 接口；到期后直接把本地统计发布到左下角。
      browserGlobalNoticeStore?.publish(
        buildHighspeedShareNotice({ cardId: candidate.cardId, metrics: candidate.metrics }),
      );
      markHighspeedCardAutoShared(candidate.cardId);
    }

    // 诊断（debug，随 snapshot 高频触发）：卡已到期、从未尝试分享、但也没进候选时，
    // 直接输出阻塞原因。2026-08-31 左下角分享卡停留在旧卡 36 分钟无任何日志可查，
    // 根因就是这些门禁此前全部静默跳过。
    for (const cardId of listHighspeedCardsAwaitingAutoShare(sessionId, autoShareNow)) {
      const blockers = collectHighspeedCardShareBlockers(cardId);
      if (blockers.length > 0) {
        logger.debug("[highspeed] 卡已到期但未进入自动分享，阻塞原因", {
          cardId,
          blockers,
        });
      }
    }
  }, [highspeedAutoShareClock, highspeedCardService, highspeedTurnVersion, sessionId, snapshot]);
  // 工作区级配置选项（模型/模式等目录）来自 session store，不是会话投影的一部分：
  // 它属于 workspace 事实源，切换会话不应重取；只有切换工作区才会变。
  const workspaceConfigOptions = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).configOptions,
  );
  // [事务] 该 effect 只做“把权威会话配置叠加到工作区目录缓存”，不改变任何事实源：
  // 既不改 session，也不改 workspace 默认值。四个前置条件保证快照完整且属于当前会话，
  // 缺一就不写缓存——半份配置写进去会让下一次新建任务继承到空模型。
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      !snapshot.config.provider.trim() ||
      !snapshot.config.model.trim() ||
      !workspaceConfigOptions?.length
    ) {
      return;
    }
    // Bug 原因：V4 session 配置只存在 ConversationSnapshot，legacy task 配置桶一直为空；
    // 用户从 custom model 会话新建任务时，startDraft 只能继承 workspace 默认模型。
    // 这里仅把权威配置叠到完整目录并按 task 缓存，不改变 session 或 workspace 事实源。
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(
        workspacePath,
        sessionId,
        projectSessionConfigToTaskConfigOptions(workspaceConfigOptions, snapshot.config),
        workspaceIdentity,
      );
  }, [
    sessionId,
    snapshot?.config.mode,
    snapshot?.config.model,
    snapshot?.config.provider,
    snapshot?.config.thought,
    snapshot?.sessionId,
    workspaceConfigOptions,
    workspaceIdentity,
    workspacePath,
  ]);
  // [事务] PPT 自动打开门禁是“每 scope 每 logEpoch 只推进一次”的显式状态机：
  // 把 enabled / scopeKey / logEpoch / phase / 最近完成 turn 一起交给 advance，
  // 由它决定是否产出 target。这些输入任何一项变化都要重新评估，因此全部进依赖。
  // 不用普通 ref 计数，是因为冻结/重放时同一 turn 可能被观察到多次。
  useEffect(() => {
    const scopeKey = `${workspaceKey}\u0000${sessionId ?? "draft"}`;
    const enabled = Boolean(onAutoOpenAssistantPptx && focused && sessionId);
    const result = advanceAssistantPreviewPptxAutoOpenGate(assistantPreviewPptxGateRef.current, {
      enabled,
      scopeKey,
      logEpoch: snapshot?.logEpoch,
      phase: snapshot?.control.phase,
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(snapshot?.rows.window ?? []),
    });
    assistantPreviewPptxGateRef.current = result.state;
    if (result.target !== undefined) {
      setAssistantPreviewPptxAutoOpenTarget(result.target);
    }
  }, [
    focused,
    onAutoOpenAssistantPptx,
    sessionId,
    snapshot?.control.phase,
    snapshot?.logEpoch,
    snapshot?.rows.window,
    workspaceKey,
  ]);
  useEffect(() => {
    // 防止切换 workspace/session/logEpoch 后沿用旧 key；key 本身已隔离，清理仅是
    // 生命周期边界，避免长时间 workbench 中 Set 随会话数增长。
    autoOpenedAssistantPptxKeysRef.current.clear();
  }, [sessionId, snapshot?.logEpoch, workspaceKey]);
  // [事务] 外部文本插入请求带 requestId：Composer 应用后回执该 id，store 才清除。
  // 只按内容判断会让“连续插入同一段文本”被合并成一次，用户第二次点击无效果。
  const composerTextInsertRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest,
  );
  // 滚到底部也是带 id 的一次性请求：用户可能连点两次，第二次必须滚动到“最新内容”，
  // 而不是被第一次请求的去重逻辑吞掉。
  const timelineBottomRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).timelineBottomRequest,
  );
  // 草稿 runtime 失效版本：宿主重建 runtime 后自增，用于让 Composer 丢弃旧的
  // 提交配置缓存并重新解析初始草稿配置；它不参与任何持久化键。
  const draftRuntimeInvalidationVersion = useZCodeSessionStore(
    (store) =>
      store.getWorkspaceState(workspacePath, workspaceIdentity).draftRuntimeInvalidationVersion,
  );
  // 回执按 requestId 清除，而不是清空整个请求：期间可能已有新的插入请求入队，
  // 无差别清空会让后一个请求永远等不到应用。
  const handleExternalTextInsertApplied = useCallback(
    (requestId: number) => {
      useZCodeSessionStore
        .getState()
        .clearComposerTextInsertRequest(workspacePath, requestId, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );
  // [并发] composerBindingRef 是“这次草稿属于哪个会话/工作区”的同步镜像，
  // 供跨 await 的恢复流程判断目标是否仍是同一个 Composer。它必须每帧直接赋值，
  // 不能放 effect：队列 ACK 可能在 commit 前到达，effect 版本会读到上一代绑定。
  const composerBindingRef = useRef({ sessionId, workspaceKey });
  composerBindingRef.current = { sessionId, workspaceKey };
  // [事务] 配置命令屏障把“连点模型/模式”串行化：前一条 setConfig 未 ACK 前，
  // 后一条会排在屏障后，避免两条命令基于同一 baseRevision 互相覆盖。
  // 每 pane 一个实例，不能放模块级，否则分屏之间会无谓互斥。
  const configCommandBarrier = useMemo(() => createConfigCommandBarrier(), []);
  // [权衡] 只有真正阻塞执行的交互才算 blocking：软审核（workspaceHookReview）
  // 只是一个提示，把它算进来会隐藏 Composer、禁用选区引用，用户反而无法继续工作。
  // 取第一个非软审核交互，保证 UI 只呈现一个“必须处理”的弹层。
  // 软审核不是阻塞交互，不能隐藏 Composer 或禁用选区引用。
  const blockingInteractionId =
    snapshot?.pendingInteractions.find(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    )?.interactionId ?? null;
  // [权衡] 呈现形态（docked / floating）决定“谁负责上报运行态”，而不是决定布局样式：
  // 同一棵组件树在两种形态下都渲染，只是上报通道不同。用 props 派生会让调用方
  // 必须知道内部实现，因此由 context 提供、pane 只读。
  const panePresentation = useConversationPanePresentation();
  const isFloatingPresentation = panePresentation.presentation === "floating";
  const isRunning = Boolean(snapshot?.control.canStop);
  const { reportFloatingStatus } = panePresentation;
  const floatingOwnerKey = sessionId ?? "__draft__";
  // [并发] 摘要记录必须带 ownerKey：时间线在切换会话的那一帧可能仍上报旧会话的摘要，
  // 不带 owner 就会把它显示到新会话的浮窗里。ownerKey 用 "__draft__" 区分草稿态。
  // 浮窗形态下由时间线上报最后一个回合（同一个 render unit 的运行状态、时长与最终回答）；
  // 记录带上 owner，切换会话后旧会话的摘要不会混进新会话。
  const [floatingLatestTurn, setFloatingLatestTurn] = useState<{
    ownerKey: string;
    summary: ConversationLatestTurnSummary;
  } | null>(null);
  // 上报时同步写入 ownerKey，读取时再比对：这样“旧会话的迟到上报”会自然落在
  // 旧 key 上，下一次读新 key 得到 null，而不是靠 effect 去清理竞态。
  const handleFloatingLatestTurnSummaryChange = useCallback(
    (summary: ConversationLatestTurnSummary) =>
      setFloatingLatestTurn({ ownerKey: floatingOwnerKey, summary }),
    [floatingOwnerKey],
  );
  const floatingLatestTurnSummary =
    isFloatingPresentation && floatingLatestTurn?.ownerKey === floatingOwnerKey
      ? floatingLatestTurn.summary
      : null;
  const floatingTurnKey = floatingLatestTurnSummary?.turnKey ?? null;
  const floatingTurnRunning = floatingLatestTurnSummary?.running ?? false;
  const floatingTurnAnswer = floatingLatestTurnSummary?.answer ?? null;
  const hasFloatingLatestTurn = floatingLatestTurnSummary !== null;
  // [并发] 只有 focused pane 才能上报浮窗状态：多个 pane 同时上报会互相覆盖，
  // 浮窗标题就会在会话之间闪烁。docked 形态下 reportFloatingStatus 是 noop，
  // 所以这里不额外判形态，避免两处条件不一致。
  useEffect(() => {
    // 完整视图浮窗只展示焦点 pane 的状态；docked 时 reportFloatingStatus 为 noop。
    if (!focused) return;
    reportFloatingStatus({
      running: isRunning,
      blockingInteractionId,
      ownerKey: floatingOwnerKey,
      latestTurn: hasFloatingLatestTurn
        ? { turnKey: floatingTurnKey, running: floatingTurnRunning, answer: floatingTurnAnswer }
        : null,
    });
  }, [
    blockingInteractionId,
    floatingOwnerKey,
    floatingTurnAnswer,
    floatingTurnKey,
    floatingTurnRunning,
    focused,
    hasFloatingLatestTurn,
    isRunning,
    reportFloatingStatus,
  ]);
  // 副屏会话键绑定 (workspace, session)：同一会话在不同工作区分屏是两条独立对话，
  // 只用 sessionId 会让 A 工作区的副屏状态泄漏到 B。草稿态没有副屏，故返回 null。
  const selectionSideChatKey = sessionId
    ? buildSelectionSideChatKey(workspaceKey, sessionId)
    : null;
  // [并发] 用 useSyncExternalStore 订阅“副屏是否被占用/阻塞”，而不是轮询或 state：
  // 该状态由另一个 pane 的 runtime 写入，本 pane 只需在变化时禁用选区动作。
  // 服务端快照固定 false，保证 SSR 首帧不会因为客户端状态不同而水合不一致。
  const selectionSideActionBlocked = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () =>
      activeSelectionSideChatSessionId
        ? isSelectionSideChatBlocked(activeSelectionSideChatSessionId)
        : false,
    () => false,
  );
  // 滚动记忆键含 paneId：分屏查看同一会话时，两个 pane 的滚动位置应各自独立；
  // workspace/path 一并纳入，避免换工作区后复用同名 session 的旧偏移。
  const timelineScrollMemoryKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId,
    taskId: null,
  });

  const {
    agentStartupAllowed: providerAgentStartupAllowed,
    error: draftModelReadinessError,
    dismissError: dismissDraftModelReadinessError,
    ensureReadyForSend: ensureDraftModelReadyForSend,
    markProviderNotReady: markDraftProviderNotReady,
  // [事务] 草稿模型就绪门禁把“provider 可用 / 模型已选 / 远端可达”收成一个布尔，
  // 并暴露 markProviderNotReady：发送失败时由这里降级，下一次发送前重新 gate。
  // 它只服务草稿（sessionId 为 null 或刚创建），既有会话的模型由权威配置驱动。
  } = useDraftModelReadinessGate({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    modelSelectionService,
  });

  // [并发] 草稿允许启动 = provider gate 通过 且 远端可用。远端不可用时 startDraft 必然失败，
  // 提前禁掉可以避免用户输入完才看到报错；但不禁用输入框本身，草稿仍可编辑。
  const draftAgentStartupAllowed = providerAgentStartupAllowed && remoteAvailable;

  // Composer 保存下一次 Submission 的 renderer intent；prewarm session 仅承载草稿预热。
  const {
    composerDraft,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    replaceComposerDraft,
    updateComposerContent,
  // [事务] 草稿配置控制只接受“同代且 runtimeReady”的 sessionConfig：
  // 否则会把上一会话的模型当成草稿初始值，用户新建任务时会带着旧模型发送。
  // promoteComposerDraft 是草稿晋升的唯一出口，替换草稿必须走 replaceComposerDraft，
  // 直接 setState 会绕过预热的 runtime 绑定。
  } = useDraftConfigControl({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig: runtimeReady && snapshot?.sessionId === sessionId ? snapshot.config : null,
    agentStartupAllowed: draftAgentStartupAllowed,
    modelSelectionService,
  });
  // [失败路径] 回合失败后是否退卡，必须由 Core 发布的结构化事实决定，而不是按错误码猜：
  // 只有 attribution.highspeedCardId 命中当前卡且 highspeedFallbackUnavailable 为 true，
  // 才说明“本轮用了卡、但退不回去”，此时留卡会锁死模型选择器。
  // 旧 Agent 没有该字段，只接受模型目录错误，并用 at >= issuedAt 防止旧错误清掉新卡。
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      snapshot.control.phase !== "error" ||
      !snapshot.control.lastError ||
      activeHighspeedCard?.taskId !== sessionId
    ) {
      return;
    }
    const lastError = snapshot.control.lastError;
    const attribution = lastError.attribution;
    if (attribution?.highspeedCardId !== undefined) {
      // 新 Agent 用 string/null 明确表达本轮是否使用 Highspeed，并在创建期或请求期失败命中退回声明、
      // 却没有任何退回目标可创建时发布 highspeedFallbackUnavailable（spec §2.2 失败即退卡）。
      // Bug 根因：这里曾只认 provider_not_found / model_not_found 两个目录错误码。请求期 3402 或网络
      // 失败无处可退时没有 fallback 事件，TurnError 的 code 是 provider 错误码 "3402"，白名单漏掉它，
      // 卡一直锁住模型选择器、下一轮继续复用已失效的卡。退卡只看 Core 发布的结构化事实，不再按错误码
      // 推断：超窗、本地 runtime 失败等不参与退回的错误不带该字段，不会误作废卡。
      if (
        attribution.highspeedCardId !== activeHighspeedCard.cardId ||
        attribution.highspeedFallbackUnavailable !== true
      ) {
        return;
      }
    } else if (
      !["provider_not_found", "model_not_found"].includes(lastError.code) ||
      lastError.at < activeHighspeedCard.issuedAt
    ) {
      // 兼容旧 Agent（无 highspeedCardId 字段）：只接受模型目录错误作为恢复边界，避免工具或本地运行时
      // 错误误作废卡；错误终态在下一轮开始前一直留在投影里，而抽卡发生在发送之前，时间下界保证上一轮的
      // 目录错误不清掉刚抽到的新卡（claim key 含新 cardId，去重防不住）。
      return;
    }
    // [事务] 作废仍走 Service owner，传 cardId 而不是只传 sessionId：
    // owner 才能保留 nextDrawAt 冷却，避免退卡后立刻重新抽到同一张坏卡。
    // failureKey 含 at，保证同一张卡的两次不同失败各自只 claim 一次。
    // 仍由 Service owner 按 cardId 作废，保留 nextDrawAt 冷却。
    invalidateActiveHighspeedCard(
      activeHighspeedCard.cardId,
      `turn-error:${sessionId}:${lastError.at}:${activeHighspeedCard.cardId}`,
    );
  }, [activeHighspeedCard, invalidateActiveHighspeedCard, sessionId, snapshot]);

  // [并发] fallback 行是历史事实，可能来自旧卡；只有卡身份与当前卡完全一致才允许作废。
  // 手机端（compactForRemoteControl）不执行写操作：权益写 RPC 未对远控开放，
  // 但 Toast 仍要独立展示历史事实，二者条件必须分开写。
  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const now = Date.now();
    for (const row of snapshot.rows.window) {
      if (
        row.kind !== "userInput" ||
        !row.sourceCommandId ||
        row.highspeed?.fallbackAt === undefined
      ) {
        continue;
      }
      const sourceCommandId = row.sourceCommandId;
      if (
        !compactForRemoteControl &&
        activeHighspeedCard?.taskId === sessionId &&
        activeHighspeedCard.cardId === row.highspeed.cardId
      ) {
        // Bug 根因：历史 fallback 行曾无条件作废“当前卡”，旧卡事件会误清新卡，手机端还会调用
        // 未开放的写 RPC。权益写操作只接受 Service 当前卡的精确身份；Toast 仍独立展示历史事实。
        invalidateActiveHighspeedCard(
          row.highspeed.cardId,
          `fallback:${sourceCommandId}:${row.highspeed.cardId}`,
        );
      }
      if (
        focused &&
        now - row.highspeed.fallbackAt >= -5_000 &&
        now - row.highspeed.fallbackAt <= 15_000 &&
        claimHighspeedFallbackToast(sourceCommandId)
      ) {
        // [权衡] Toast 只在 fallbackAt 的 [-5s, +15s] 窗口内提示：冷启动回放几十条历史
        // fallback 时若逐条弹，会瞬间刷屏。负下界容忍本机与远端时钟的轻微偏差。
        // claimHighspeedFallbackToast 保证同一 sourceCommandId 只提示一次。
        // 卡过期与加速服务不可用分别提示；旧数据没有 fallbackReason，按卡过期文案处理。
        toast(
          intl.formatMessage({
            id:
              row.highspeed.fallbackReason === "highspeed_card_expired" ||
              row.highspeed.fallbackReason === undefined
                ? "chat.highspeed.cardExpiredFallback"
                : "chat.highspeed.requestFailedFallback",
          }),
        );
      }
    }
  }, [
    activeHighspeedCard,
    compactForRemoteControl,
    focused,
    intl,
    invalidateActiveHighspeedCard,
    sessionId,
    snapshot,
  ]);
  // 模型选择视图只在 ready 时取值：loading/error 下的 view 是占位对象，
  // 把它传给推荐逻辑会得出基于空目录的“无推荐”，用户会误以为没有可用模型。
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  // [并发] 记录上一次看到的模型目录 revision，用于检测“目录在草稿期间发生了变化”。
  // 只在草稿态（sessionId=null）有效；切到正式会话立即置空，避免沿用旧基线。
  const draftModelSelectionRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionId !== null) {
      draftModelSelectionRevisionRef.current = null;
      return;
    }
    const revision = modelSelectionView?.revision ?? null;
    const previousRevision = draftModelSelectionRevisionRef.current;
    draftModelSelectionRevisionRef.current = revision;
    if (
      revision === null ||
      previousRevision === null ||
      revision === previousRevision ||
      (draftConfigRef.current.provider && draftConfigRef.current.model)
    ) {
      return;
    }
    // [事务] 只有“未发送、无显式选择”的草稿才回收预热 runtime：
    // 已显式选择模型或已有正式会话时，配置是用户/执行事实，不能因目录刷新而被改写。
    // 判断 draftConfigRef 里 provider 与 model 同时存在，避免半份配置被当成显式选择。
    // Bug 原因：冷启动时普通 Provider 会先让草稿预热，Account Overlay 随后才进入
    // Selection View。旧预热会话冻结了早期 fallback，即使最新 View 已包含当前账号连接，
    // Renderer 也会永久停在旧模型。未发送且无显式选择的草稿不是执行事实；View 更新时
    // 回收并按最新选择事实重建，已显式选择和正式会话仍保持冻结。
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [draftConfigRef, modelSelectionView?.revision, sessionId, workspaceIdentity, workspacePath]);
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  // [并发] 提交配置从 draftConfigRef 读最新值，而不是依赖 draftConfig：
  // 点击发送与 Composer 内部 setState 可能在同一帧发生，依赖快照会少一次模型切换。
  // modelSelectionView 决定可用模型校验，缺它会让已下线的模型仍被提交。
  const createSubmissionFromComposer = useCallback(
    () => createComposerSubmissionConfig(draftConfigRef.current, modelSelectionView),
    [draftConfigRef, modelSelectionView],
  );
  // 是否“可提交”只用于 UI 置灰，必须与真正发送时同一套构造逻辑，
  // 否则会出现按钮可点但发送时返回 null 的静默失败。
  const composerSubmissionReady = useMemo(
    () => createComposerSubmissionConfig(draftConfig, modelSelectionView) !== null,
    [draftConfig, modelSelectionView],
  );
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const billingDiscount = useCodingPlanBillingDiscountFromService(
    baseWorkspaceServices.codingPlanSubscriptionService,
  );
  const projectDirectory = useOptionalProjectDirectory();
  const commitCreatedTask = projectDirectory?.commitCreatedTask;
  const refreshTaskGroups = projectDirectory?.groups.refresh;
  // [事务] 创建会话的异步链（commitCreatedTask → organize → refresh）共用一个
  // AbortController：切工作区/会话时中止，避免“用户在 A 创建的会话被写到 B 的分组”。
  // controller 随 scope 重建而不是复用同一实例，是因为 abort 不可逆，复用会让新链继承已取消状态。
  const draftNavigation = useMemo(
    () => ({ controller: new AbortController() }),
    [workspaceKey, sessionId],
  );
  // StrictMode 会重放 effect：每次重放都换新 controller，旧 scope 的请求仍持有各自的
  // 取消信号；cleanup 只 abort 本次创建的那个，不会误杀后续请求。
  useEffect(() => {
    // StrictMode 会重放 effect；旧 scope 的请求仍使用各自的取消信号。
    draftNavigation.controller = new AbortController();
    return () => draftNavigation.controller.abort();
  }, [draftNavigation]);
  // [事务] 建会话埋点只上报一次，因此必须在 accepted 后立刻带 messageId 发出；
  // 等回复完成再报会在用户中途关闭时丢失，而且 messageId 本身就是完成态的关联键。
  // source 区分用户新建 / 草稿晋升 / fork 等入口，用于漏斗归因。
  // 首发 commandId 在 accepted 时已存在，也是 completion 的 message_id；不必等回复完成。
  const reportDraftCreated = useCallback(
    (createdSessionId: string, source: SessionCreateSource, messageId: string) => {
      void reportSessionCreate(platform, {
        sessionId: createdSessionId,
        messageId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        source,
        clientKind: isDesktop ? "desktop" : compactForRemoteControl ? "mobile" : "web",
      });
    },
    [
      platform,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      isDesktop,
      compactForRemoteControl,
    ],
  );
  // [事务] 草稿晋升分三步且顺序不可换：先标记“刚创建”（让打开耗时跳过本 pane 首次绑定），
  // 再 promoteComposerDraft（把预热草稿交给正式会话），最后通知宿主切 active task。
  // 反过来先通知宿主会让新 sessionId 先触发一次 acquire，再被 promote 打断，出现双订阅。
  // commitCreatedTask 存在时整段交给它串行化；不存在时用 void organize 保证 commit 不被阻塞。
  const handleDraftSessionCreated = useCallback(
    async (
      createdSessionId: string,
      createSource?: SessionCreateSource,
      messageId?: string,
      taskGroupId?: string | null,
    ) => {
      if (messageId) reportDraftCreated(createdSessionId, createSource ?? "session", messageId);
      const commit = () => {
        // [事务] 标记必须发生在 promote 之前：promote 会同步改 sessionId，
        // 一旦先 promote，打开耗时 hook 就可能用草稿期的 startedAt 记一次假打开。
        // Bug 根因：Session 打开埋点只衡量已有 Session，但草稿首发过去会把新建/预热提升的
        // sessionId 直接交给同一 hook。预热 lease 还保留草稿期的 startedAt 与空 snapshot timing，
        // 因而把数小时闲置时间误记为 total/react。创建边界先标记本 pane 的首次绑定；离开后
        // 再次显式打开同一 Session 时标记会清除，恢复正常的已有 Session 打开测量。
        newlyCreatedSessionIdRef.current = createdSessionId;
        promoteComposerDraft(createdSessionId);
        onSessionCreated?.(createdSessionId);
      };
      const organize =
        taskGroupId !== undefined
          ? async () => {
              const task = {
                taskId: createdSessionId,
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                hostId: remoteHostIdFromWorkspaceIdentity(workspaceIdentity ?? "") ?? "local",
              };
              const attempt = async () => {
                try {
                  if (!baseWorkspaceServices.taskGroupService)
                    throw new Error("task-group.service-unavailable");
                  await baseWorkspaceServices.taskGroupService.admit({
                    tasks: [task],
                    placement: {
                      task,
                      groupId: taskGroupId,
                      creationId: messageId ?? createdSessionId,
                    },
                  });
                  // [事务] 分组写入是“后置副作用”：会话已经创建成功，重读分组只影响列表，
                  // 因此 fire-and-forget，不 await，也不延长首发完成时间。
                  // 分组结构是独立投影；重读迟滞不能延长已接受首发或组织写入的完成时间。
                  void refreshTaskGroups?.();
                } catch (cause) {
                  // [失败路径] 分组失败绝不能向上抛：会话已存在，抛错会被发送层当成“发送失败”，
                  // 用户重发就会创建第二条会话。重试闭包只持有地址与 placement，不调用 create。
                  // 用 durationMs=0 + dedupeKey 保证同一次创建只留一条可操作 Toast。
                  // 会话已创建；组织失败不能向发送层抛错，否则会诱导用户再发一次。
                  // 重试闭包只持有这次创建的地址和 placement，绝不调用 createSession。
                  logger.error("[task-groups] 新任务归属提交失败", cause);
                  toast(intl.formatMessage({ id: "taskGroup.failed" }), {
                    durationMs: 0,
                    actionLabel: intl.formatMessage({ id: "taskGroup.retryPlacement" }),
                    onAction: () => void attempt(),
                    dedupeKey: `task-group:${createdSessionId}`,
                  });
                }
              };
              await attempt();
            }
          : undefined;
      if (commitCreatedTask) {
        await commitCreatedTask(
          { taskId: createdSessionId, workspacePath, workspaceIdentity },
          commit,
          draftNavigation.controller.signal,
          organize,
        );
      } else {
        void organize?.();
        commit();
      }
    },
    [
      commitCreatedTask,
      baseWorkspaceServices.taskGroupService,
      refreshTaskGroups,
      intl,
      draftNavigation,
      reportDraftCreated,
      onSessionCreated,
      promoteComposerDraft,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const { settings: sharedSettings } = useSettings();
  // [事务] 套餐身份快照按 providerFamilyDomain 取：同一账号域下的连接选择决定
  // 额度/折扣展示；跨域复用会把 A 账号的剩余额度显示到 B 账号的 pane 上。
  const readPlanIdentitySnapshot = usePlanIdentitySnapshot(
    sharedSettings?.providerFamilyDomain,
    sharedSettings?.providerFamilyDomain
      ? sharedSettings.providerFamilyConnectionSelections?.[sharedSettings.providerFamilyDomain]
      : undefined,
    baseWorkspaceServices.usageStatsService,
  );
  // appFollowupMode 是“用户设置”的事实值，不随会话变化；会话上的 followupMode 是执行事实。
  // 两者分开保存（见 INV-14），同步逻辑只在会话值缺失/落后时把 app 设置下发一次。
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const messageStreamShowReasoning = sharedSettings?.messageStreamShowReasoning ?? true;
  const messageStreamShowTodos = sharedSettings?.messageStreamShowTodos ?? false;
  const toolGroupingExploreEnabled = sharedSettings?.toolGroupingExploreEnabled ?? true;
  const toolGroupingTerminalEnabled = sharedSettings?.toolGroupingTerminalEnabled ?? true;
  const toolGroupingChangesEnabled = sharedSettings?.toolGroupingChangesEnabled ?? false;
  // 把三个高频判定值拍平成原始类型：它们会进入多个 useCallback 依赖数组，
  // 直接依赖 snapshot 对象会让每次 token 都重建回调；拍平后只有真正变化才重建。
  const snapshotSessionId = snapshot?.sessionId ?? null;
  const snapshotFollowupMode = snapshot?.config.followupMode ?? null;
  const snapshotRevision = snapshot?.revision ?? null;

  // [并发] theme 与 codePreviewSettings 经 context 注入行组件，而不是让每行自己取 store：
  // 长会话里每行都订阅 store 会产生上千个订阅者；统一取一次、经稳定 rowContext 下发，
  // 行组件才能安心 memo。rowContext 本身必须 useMemo，否则 memo 全部失效。
  // 注入模式对齐 PermissionDialog：theme/codePreviewSettings 在宿主取 store，
  // 经稳定引用的 rowContext 下发给 memo 行组件（MessageResponse/ToolCallBlocks）。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // [权衡] fork 跳转复用 onSessionCreated 而不是自己切路由：宿主对 primary / 分屏
  // 有不同的绑定策略，pane 直接改路由会绕过 pane 生命周期与滚动记忆。
  // rowId 目前恒为占位 0，因此显式忽略参数，等 Tier 2 精确滚动落地再启用。
  // Tier 1 fork 跳转：点 child 会话的 forkNotice → 把当前 pane 原地切到父会话，复用 fork
  // 落地同款 onSessionCreated（primary→setActiveTaskId、分屏→bindPaneSession）。rowId 预留
  // Tier 2 精确滚动——当前 forkNotice.parentRowId 恒为 0 占位，此处忽略。
  // 目标等于当前会话时直接返回：否则会触发一次“切到自身”的 acquire/释放循环，
  // 造成订阅抖动与滚动位置重置。空 target 也视为无效跳转。
  const handleNavigateToRow = useCallback(
    (targetSessionId: string, _rowId: number) => {
      if (!targetSessionId || targetSessionId === sessionId) {
        return;
      }
      onSessionCreated?.(targetSessionId);
    },
    [onSessionCreated, sessionId],
  );
  // [事务] dispatchCommand 是本文件唯一的“上行写入口”，职责分五段且顺序固定：
  // 1) 离线门禁 → 2) 冻结提交配置与组织归属 → 3) 生成 envelope 并登记 pending 账本
  // → 4) 发送并等待 ACK → 5) 按 ACK 收敛 optimistic overlay 与选择回写。
  // 任何一段顺序颠倒都会破坏 INV-09/10/11：先发送后登记会丢账本，先收敛后判断会误删。
  // 依赖数组刻意不含 snapshot：它通过 snapshotRef 读取，保证流式期间函数引用稳定。
  const dispatchCommand = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      targetSessionId: string | null,
      baseRevision?: number,
      baseLogEpoch?: string,
      telemetrySeed?: ConversationPromptTelemetrySeed,
      highspeedCard?: HighspeedCardSnapshot,
      onEnvelopeCreated?: (envelope: CommandEnvelope) => void,
      creationProjectId?: string | null,
      sessionCreateSource?: SessionCreateSource,
      recentSubmissionOverride?: ComposerSubmissionConfig | null,
      creationTaskGroupId?: string | null,
      submittedDraftText?: string,
    ): Promise<CommandAck> => {
      // [失败路径] 离线必须同步抛错，不能入队重试：一旦进入 accepted 账本，重连后
      // 会被自动重放，用户在离屏时的一次误触就变成真实发送。
      // 抛的是结构化 disconnected 错误，调用方据此展示“网络已断开”而不是通用失败。
      // 离线点击/快捷键不得进入 accepted 命令恢复账本，更不能在重连后自动发送。
      if (!remoteAvailable) throw createRemoteWorkspaceDisconnectedError();
      const submission = submissionConfigFromCommand(type, payload);
      // [事务] Recent 记录用调用方冻结的 submission（如果有），而不是从 payload 反推：
      // 加速轮 payload 里的 modelSelection 会被执行材料覆盖成隐藏 Provider，
      // 反推会把“隐藏模型”写进用户历史，下一轮草稿就带着它。
      // 加速轮 payload 的 modelSelection 会被执行材料覆盖为隐藏加速 Provider；Recent 记录的是
      // 用户在 Composer 的原始选择（新任务草稿的模型种子），加速轮必须由调用方传入发送前
      // 冻结的 submission（spec §5.1）。接纳写入另有加速身份兜底拦截。
      const recentSubmission = recentSubmissionOverride ?? submission;
      // [事务] 组织归属在同步阶段先按当前 scope 冻结，再做异步解析：
      // 同 cwd 可以属于多个项目，解析期间用户切页或 ACK 迟到都不能改写 target。
      // 解析结果只覆盖 projectId，hostId 等其余字段保持发送起点的值。
      // 发送时固定组织归属；同 cwd 可属于多个项目，切页和迟到 ACK 不得改写目标。
      let recentScope =
        creationProjectId === undefined
          ? newTaskComposerScope
          : { ...newTaskComposerScope, projectId: creationProjectId };
      // [并发] Recent 回执必须在 await 之前生成：它同时承载“发起顺序”，
      // 若等目录解析完再建，两次快速发送会按解析完成顺序落座，Recent 列表就是乱的。
      // scope 之后会被解析结果覆盖，但排序身份已经固定。
      // 在异步查询归属前冻结选择与发起顺序，避免慢查询把早发命令排成最新。
      const recentReceipt = recentSubmission
        ? prepareComposerRecentReceipt(recentScope, recentSubmission)
        : undefined;
      if (recentSubmission && sessionId && targetSessionId) {
        const projectService = baseWorkspaceServices.projectService;
        if (!projectService) throw new Error("project.service-unavailable");
        const directories = await projectService.resolveSessionDirectories(
          {
            workspacePath,
            workspaceIdentity,
            // 辅助 child 不进主任务索引；Recent 查所属主会话，输入仍发给 child。
            // 普通会话和 fork 即使带 rootSessionId 也必须保留自身项目归属。
            taskId:
              selectionSideChat && targetSessionId === sessionId && rootSessionId
                ? rootSessionId
                : targetSessionId,
          },
          recentScope.hostId,
        );
        recentScope = { ...recentScope, projectId: directories.projectId };
      }
      // [事务] 把解析出的 projectId 写回已冻结的回执：只改 scope，不改排序身份与时间戳。
      // 没有 projectId 时保持原样，不写 undefined，避免覆盖 hostId。
      if (recentReceipt) recentReceipt.scope = recentScope;
      // [事务] pending 草稿只在新任务、且尚未归属项目时读取：一旦选了项目，
      // 草稿属于项目空间，不能再把“待建任务”的临时记录写进命令账本。
      // 读取结果还要校验 workspacePath，防止把 A 仓库的 draftId 记到 B 的命令上。
      const pendingDraft =
        sessionId === null && recentScope.projectId === null
          ? readPendingTaskDraft(recentScope)
          : null;
      // [事务] 只有“当前会话或新会话”的提交才回写模型选择：给别的会话发命令时
      // 顺带改用户当前选择，会让下一条消息用上不属于它的模型。
      // capture 在 ACK accepted 后才真正生效，避免被拒绝的命令污染选择缓存。
      const acceptSelection =
        submission && (sessionId === null || targetSessionId === sessionId)
          ? captureAcceptedModelSelection(submission.modelSelection)
          : undefined;
      // [事务] envelope 在本地生成 commandId，之后所有环节（账本、ack、遥测、
      // optimistic overlay）都以它为主键。baseRevision/baseLogEpoch 只在有值时携带，
      // 用条件展开而不是写 undefined，避免序列化出显式的空字段影响服务端 CAS。
      const envelope = createCommandEnvelope({
        type,
        sessionId: targetSessionId,
        payload: payload as never,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(baseLogEpoch ? { baseLogEpoch } : {}),
      });
      // 回调必须在发送前触发：调用方据此尽早拿到 commandId 关联本地乐观项，
      // 若等 ACK 再通知，慢网络下用户会先看到“没有反应”。
      onEnvelopeCreated?.(envelope);
      const projectId =
        type === "createSession"
          ? creationProjectId !== undefined
            ? creationProjectId
            : useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                .draftProjectId
          : undefined;
      // [事务] 账本必须早于第一次上行：transport error 或 renderer 刷新后，
      // 只有账本能让恢复流程知道“这条命令可能已经到达服务端”。
      // createSession 与普通命令的账本形态不同：前者要带工作区/项目/草稿/分组等创建上下文，
      // 后者只在新任务首发时补项目与分组，既有会话不写这些字段。
      // 必须早于第一次上行：transport error/renderer refresh 后仍有可查询线索。
      pendingCommandRegistry.record(
        envelope,
        type === "createSession"
          ? {
              workspace: {
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
              },
              ...(projectId !== undefined ? { projectId } : {}),
              ...(recentReceipt
                ? {
                    composer: {
                      ...recentReceipt,
                      submittedText: submittedDraftText,
                      ...(pendingDraft?.workspacePath === workspacePath
                        ? { draftId: pendingDraft.draftId }
                        : {}),
                    },
                  }
                : {}),
              taskGroupId:
                creationTaskGroupId !== undefined
                  ? creationTaskGroupId
                  : useZCodeSessionStore
                      .getState()
                      .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId,
              sessionCreateSource:
                sessionCreateSource ??
                useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftCreateSource,
            }
          : recentReceipt
            ? {
                workspace: { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) },
                ...(sessionId === null
                  ? {
                      projectId: recentScope.projectId,
                      taskGroupId:
                        creationTaskGroupId ??
                        useZCodeSessionStore
                          .getState()
                          .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId,
                      sessionCreateSource:
                        sessionCreateSource ??
                        useZCodeSessionStore
                          .getState()
                          .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource,
                    }
                  : {}),
                composer: {
                  ...recentReceipt,
                  submittedText: submittedDraftText,
                  ...(pendingDraft?.workspacePath === workspacePath
                    ? { draftId: pendingDraft.draftId }
                    : {}),
                },
              }
            : undefined,
      );
      // [并发] 标记 pending 但只对非 createSession：新会话还没有 store，无法 mark；
      // 该标记让 Composer 在 ACK 前保持“已发出”状态，避免重复提交。
      if (lease?.store && type !== "createSession") {
        lease.store.markCommandPending({
          commandId: envelope.commandId,
          type: envelope.type,
          issuedAt: envelope.issuedAt,
        });
      }
      // [并发] sendCommand 是唯一可能抛错的 await 段；try 的边界刻意只包住发送，
      // 这样 catch 只需处理“传输/确定性拒绝”，不会误吞后面 ACK 收敛逻辑的异常。
      // TTFT 观测的 ack/exclude 必须与发送结果一一对应，不能放在 finally。
      let ack: CommandAck;
      try {
        // [事务] 本地 TTFT 观测只对“本机 workspace 且带 seed 的真实发送”开启：
        // 远端 workspace 的耗时包含网络跳数，混入本地基线会污染指标。
        // guard.heldQueueConfirmationStale 表示命令未真正出队，按 confirmationRetry 记，
        // 而不是记成一次成功或失败。
        if (telemetrySeed?.localTtft && !workspaceIdentity?.trim()) {
          envelope.ttft = getLocalTtftObserver()?.dispatch(
            telemetrySeed.localTtft,
            workspacePath,
            envelope.commandId,
            targetSessionId,
          );
        }
        ack =
          projectId !== undefined
            ? await sendCommand(envelope, { projectId })
            : await sendCommand(envelope);
        if (telemetrySeed?.localTtft && ack.reasonCode === "guard.heldQueueConfirmationStale")
          getLocalTtftObserver()?.confirmationRetry(telemetrySeed.localTtft);
        else if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.ack(telemetrySeed.localTtft, ack.status, ack.ttftExcluded);
      } catch (error) {
        if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        if (lease?.store) {
          lease.store.settleCommand(envelope.commandId);
        }
        if (isProviderNotReadyError(error)) {
          // provider_not_ready 在 Host getClient 前确定性拒绝，CLI 不可能已经
          // admission。若继续保留 renderer 恢复账本，重连 query 必然得到 unknown；即使
          // unknown 现已静默清账，也不应为确定性拒绝留下无效的恢复记录。
          pendingCommandRegistry.rejectCommand(envelope.sessionId, envelope.commandId);
        }
        recordV4CommandAck({
          type,
          status: "transport-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        // 发送漏斗落定：telemetrySeed 只有真实用户发送才携带，两步式 createSession
        // 与后台任务无 seed，天然不会伪造 send_result。
        if (telemetrySeed) {
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: targetSessionId,
            commandId: envelope.commandId,
            status: "fail",
            reasonCode: isProviderNotReadyError(error) ? "provider_not_ready" : "transport_error",
          });
        }
        throw error;
      }
      // [事务] applyAck 是账本收敛点：accepted/duplicate 会保留命令以便重放，
      // 其余状态在下面 settle。把它放在 try 之外，保证“发送成功但处理 ACK 抛错”
      // 仍会走统一异常出口，而不是把账本留在半更新状态。
      pendingCommandRegistry.applyAck(envelope, ack);
      if (ack.status === "accepted") {
        acceptSelection?.();
      }
      if (
        lease?.store &&
        requiresAcceptedInputProjection(type) &&
        (ack.status === "accepted" || ack.status === "duplicate")
      ) {
        // [失败路径] 只登记“等待权威输入投影”，不在本地伪造 user row：
        // 伪造会让 branch cut 后的真实 row 到达时出现重复消息，且无法被 watchdog 纠正。
        // duplicate 也要登记：它说明同一命令已被接受，权威 row 可能仍在路上。
        // Bug 根因：editUserQuery 会先发布 branch cut；若 replacement user row 的 topic
        // 投影静默，UI 只剩截断结果。ACK 后必须和 sendText 一样等待权威输入投影；
        // watchdog 只重订阅，不伪造消息、不恢复旧分支，也不重放命令。
        lease.store.expectAcceptedInputProjection(envelope.commandId);
      }
      if (ack.status === "accepted" && telemetrySeed) {
        const acceptedSessionId =
          ack.result?.type === "createSelectionSideSession"
            ? ack.result.sessionId
            : (targetSessionId ??
              (ack.result?.type === "createSession" ? ack.result.sessionId : null));
        if (acceptedSessionId) {
          conversationTelemetry?.acceptPromptSeed({
            ...telemetrySeed,
            sessionId: acceptedSessionId,
            sourceCommandId: envelope.commandId,
            memoryEnabled: ack.memoryEnabled,
          });
        }
      }
      // [事务] 只有在 accepted 时才登记 Highspeed turn：rejected 的命令没有真正执行，
      // 提前登记会让卡在过期时统计出 0 token，用户看到“加速无效”的错误结论。
      // targetSessionId 必须存在，否则无法把 turn 绑定到任何会话。
      if (ack.status === "accepted" && highspeedCard && targetSessionId) {
        recordHighspeedTurn({
          sessionId: targetSessionId,
          sourceCommandId: envelope.commandId,
          card: highspeedCard,
          createdAt: Date.now(),
        });
      }
      if (telemetrySeed) {
        // [事务] resolveSendAckSettlement 返回 null 表示“非终态”，必须原样跳过：
        // 队列二次确认的 ACK 也会走到这里，把它当结果落定会被 first-wins 逻辑吃掉真实结果。
        // awaitRender 与 settle 的分支由 outcome.kind 决定，不能按 ack.status 猜。
        // 队列二次确认的 ACK 返回 null（非终态），落定会让 first-wins 吃掉真实结果。
        const outcome = resolveSendAckSettlement(ack);
        if (outcome) {
          const settledSessionId =
            ack.result?.type === "createSelectionSideSession"
              ? ack.result.sessionId
              : (targetSessionId ??
                (ack.result?.type === "createSession" ? ack.result.sessionId : null));
          if (outcome.kind === "awaitRender") {
            // ACK 只代表 Host 收下了命令，用户气泡此刻还没画出来；
            // 等投影回流出 userInput row（或 30s 超时）再落定端到端耗时。
            conversationTelemetry?.awaitSendRender({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              ackStatus: outcome.ackStatus,
            });
          } else {
            conversationTelemetry?.settleSendResult({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              status: outcome.status,
              ackStatus: outcome.ackStatus,
              reasonCode: outcome.reasonCode,
            });
          }
        }
      }
      // [资源] ack 摘要只进有界调试缓冲，不写 renderer 日志：生产构建日志关闭，
      // 但 e2e/现场 probe 仍需要看到最近 N 条 ack。缓冲有界，避免长会话无限增长。
      // 生产构建 renderer 日志关闭，ack 摘要写入有界调试缓冲供 e2e/现场 probe。
      recordV4CommandAck({
        type,
        status: ack.status,
        ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
        revisionAtDecision: ack.revisionAtDecision,
        at: Date.now(),
      });
      // [并发] stale authority 不能只清 overlay：epoch/entity 已换代时，
      // 后续命令仍会带着旧 target 发出，必须整体 same-sub recovery 到新代再裁决。
      // 这里用可选链调用 store，是因为 createSession 场景可能没有 lease.store。
      if (shouldResyncForStaleAuthority(ack)) {
        // epoch/entity authority 已变化时只清 optimistic overlay 仍会继续拿旧
        // target 发命令；统一 same-sub recovery 后才能基于同代 rowId/entityId 再裁决。
        lease?.store?.recoverFromStaleAuthority();
      }
      // [失败路径] 非 accepted/duplicate 必须显式 settle，否则 optimistic overlay 永久残留：
      // 用户会看到一条“发送中”的幽灵消息，且无法删除。createSession 不在此列，
      // 因为它没有 overlay（新会话的首条消息由 createSession 的投影负责）。
      // accepted 也不 settle：输入投影尚未到达，overlay 要撑到权威 row 出现。
      // rejected/stale/failed 时若不 settle，optimistic overlay 会永久残留。
      if (
        lease?.store &&
        type !== "createSession" &&
        ack.status !== "accepted" &&
        ack.status !== "duplicate"
      ) {
        lease.store.settleCommand(envelope.commandId);
      }
      return ack;
    },
    [
      captureAcceptedModelSelection,
      newTaskComposerScope,
      baseWorkspaceServices.projectService,
      conversationTelemetry,
      lease,
      provider,
      sendCommand,
      remoteAvailable,
      rootSessionId,
      selectionSideChat,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  dispatchCommandRef.current = dispatchCommand;

  // [资源] fileChanges 请求按 cacheKey 共享 in-flight Promise：Timeline 里同一行的
  // diff 可能被多个子组件（摘要、文件列表、悬浮预览）在同一帧请求，若各自发 RPC，
  // 一次展开会打十几条相同的洪泛请求。缓存的是 Promise 而不是结果，天然合并并发。
  // [事务] 结果带 revision 与 logEpoch 双重身份：rewind 后同一 row 的 diff 语义变了，
  // 只有 revision 变化才能让缓存失效；只按 rowId 缓存会显示撤销前的旧 patch。
  const handleFetchFileChanges = useCallback(
    (target: ConversationRowTarget, options: ConversationFileChangesRequestOptions) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          files: 0,
          additions: 0,
          deletions: 0,
          items: [],
        });
      }
      const cacheKey = JSON.stringify([
        options.cachePolicy,
        sessionId,
        current.logEpoch,
        // rewind 会在同一 logEpoch、row/entity 下把 active 切为 reverted；
        // 终态缓存必须带上这个语义版本，不能继续复用撤销前的完整 diff。
        options.cachePolicy === "in-flight"
          ? current.revision
          : (options.fileChangesState ?? "unknown"),
        target.rowId,
        target.entityId,
      ]);
      // [资源] 命中后先 delete 再 set，做一次 LRU 触达：Map 的迭代顺序是插入顺序，
      // 不触达会让“刚刚还在用”的热行被下面的淘汰循环优先删掉，反复展开时重新打 RPC。
      const cachedRequest = fileChangesRequestCache.get(cacheKey);
      if (cachedRequest) {
        fileChangesRequestCache.delete(cacheKey);
        fileChangesRequestCache.set(cacheKey, cachedRequest);
        return cachedRequest;
      }

      // [权衡] 缓存放在 SessionPane 而不是行组件：虚拟化会卸载行、丢掉行内 state，
      // 复挂载后预览卡片会重复拉取包含完整 patch 的 fileChanges；提升到 pane 后，
      // 行、变更面板、悬浮预览共享同一请求。
      // 虚拟行卸载会丢失行内 state，复挂载后预览卡片会重复拉取包含完整
      // patch 的 fileChanges；缓存必须放在 SessionPane，才能与文件变更面板共享同一请求。
      let request: Promise<V4ConversationFileChangesResult>;
      request = fileChanges({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).then(
        (result) => {
          // [事务] 只在缓存里仍是“自己”时删除：期间可能有同 key 的新请求覆盖，
          // 旧 Promise 的完成回调不能把新请求删掉。in-flight 策略下成功即失效，
          // 因为结果只覆盖当前 revision 的局部 diff，不能给最终卡片复用。
          // 运行中成功结果仍可能只是当前 revision 的局部 diff；只共享
          // in-flight Promise，settled 后删除，避免最终卡片复用早期结果。
          if (
            options.cachePolicy === "in-flight" &&
            fileChangesRequestCache.get(cacheKey) === request
          ) {
            fileChangesRequestCache.delete(cacheKey);
          }
          return result;
        },
        (error: unknown) => {
          // [失败路径] 失败必须从缓存移除，否则用户重试会一直拿到同一个 rejected Promise。
          // 同样用“=== 自己”判断，避免迟到失败误删新请求；stale authority 额外触发恢复，
          // 但恢复是副作用，不能替代 throw——调用方仍需要知道这次请求失败了。
          // 失败不能污染后续重试；仅删除当前 Promise，避免旧请求误删同 key 的新请求。
          if (fileChangesRequestCache.get(cacheKey) === request) {
            fileChangesRequestCache.delete(cacheKey);
          }
          if (shouldResyncForStaleAuthority(error)) {
            lease?.store?.recoverFromStaleAuthority();
          }
          throw error;
        },
      );
      fileChangesRequestCache.set(cacheKey, request);
      // [资源] 淘汰最老项直到回到上限。while 而不是 if：一次插入理论上只多 1，
      // 但上限可能被热更新调小，循环保证任何情况下都能收敛。取不到 key 立即 break，
      // 防止 Map 被并发清空时空转。
      while (fileChangesRequestCache.size > MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES) {
        const oldestKey = fileChangesRequestCache.keys().next().value;
        if (oldestKey === undefined) break;
        fileChangesRequestCache.delete(oldestKey);
      }
      return request;
    },
    [fileChanges, fileChangesRequestCache, lease, sessionId],
  );

  // [事务] 预览是只读查询，可以安全重试；但它同样要带 baseRevision/baseLogEpoch，
  // 否则服务端无法判断“预览与当前日志是否同代”，可能给出过期的安全文件列表。
  // 无会话时返回 canApply:false 的全空结构，而不是 reject：UI 侧据此禁用按钮即可，
  // 抛错会让错误横幅在空态常驻。
  // [失败路径] stale authority 时先恢复订阅再 rethrow，保留调用方的失败感知。
  const handlePreviewFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          canApply: false,
          safeFiles: [],
          unsafeFiles: [],
          ignoredFiles: [],
        });
      }
      return fileRewindPreview({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).catch((error: unknown) => {
        if (shouldResyncForStaleAuthority(error)) {
          lease?.store?.recoverFromStaleAuthority();
        }
        throw error;
      });
    },
    [fileRewindPreview, lease, sessionId],
  );

  // [事务] 应用回退是写命令，必须走 dispatchCommand：只有它能带 CAS（baseRevision/
  // baseLogEpoch）并登记账本。直接调 fileRewind 会绕过乐观覆盖与 ACK 收敛。
  // 无会话时同步 throw 而不是返回 rejected Promise：调用点在事件处理器里，
  // 同步抛错能被上层 UI 的 try/catch 捕获并展示为“无法回退”，不会变成未处理拒绝。
  const handleApplyFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        throw new Error("Cannot apply file rewind without an active session revision");
      }
      return dispatchCommand(
        "applyFileRewind",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  // 打开子代理侧栏时补全上下文：rootSessionId 回退到本 pane 的根会话，
  // workspace 与 remote 透传，保证侧栏在远端工作区也能定位到同一份日志。
  // 可选字段用条件展开，避免把 undefined 显式传给宿主（宿主可能用 in 判断字段存在）。
  const handleOpenSubagentSession = useCallback(
    (request: OpenSubagentSideTabRequest) => {
      onOpenSubagentSession?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentSession, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  // [权衡] 子代理目录在手机远控下直接 no-op：宿主没有对应的侧栏容器，
  // 打开会落到空白面板。其余入口（单会话 transcript）仍保留，因为它能在抽屉里展示。
  // 判断放在回调内部而不是隐藏按钮，保证快捷键/程序化调用也走同一条门禁。
  const handleOpenSubagentDirectory = useCallback(
    (request: import("@/lib/workspaceSidePane.js").OpenSubagentDirectorySideTabRequest) => {
      if (compactForRemoteControl) return;
      onOpenSubagentDirectory?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [
      compactForRemoteControl,
      onOpenSubagentDirectory,
      remoteSessionId,
      rootSessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  // Plan 详情与 workflow 系列入口同构：卡片只发“打开哪个对象”的意图，
  // 会话/工作区/远端身份由 pane 补齐。卡片因此不依赖路由上下文，可复用于通知与推荐位。
  const handleOpenPlanDetail = useCallback(
    (request: OpenPlanDetailSideTabRequest) => {
      onOpenPlanDetail?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenPlanDetail, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 与 plan-detail 完全同构：卡片只发意图（runId + toolCallId + 展示名），
  // 会话与 workspace 身份一律由宿主（这里）补齐，卡片不感知 scope。
  const handleOpenWorkflowRun = useCallback(
    (request: OpenWorkflowRunSideTabRequest) => {
      onOpenWorkflowRun?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRun, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 药丸 → 子代理 transcript：与 plan-detail / workflow-run 同构，卡片只交出实例身份，scope 在这里补。
  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenWorkflowActorSessionSideTabRequest) => {
      onOpenWorkflowActorSession?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowActorSession, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 脚本药丸同构：卡片交出 run + 发起行 + 阶段，scope 在这里补。
  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenWorkflowWorkspaceSideTabRequest) => {
      onOpenWorkflowWorkspace?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowWorkspace, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 产物 chip 与 run 详情同构：卡片/通知行只发意图，scope 由这里补齐。
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenWorkflowArtifactSideTabRequest) => {
      onOpenWorkflowArtifact?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowArtifact, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // 工具卡 → workflow run 的关联表。权威来源是 workflowRuns 投影里每条 run 的 toolCallId
  // （schema 注释就写着它是「工具卡 → 详情页的关联键」）；工具行自己的 output 在 v4 下
  // 只剩 formatCreateWorkflowModelContent 挑出的那句散文，结构化字段拿不到。
  //
  // 值不只是 runId：run 态的卡片本身要渲染状态词与步数，所以联接一次就把摘要算完
  // （计数规则见 buildWorkflowRunByToolCallId，它的单测穷举 settled / observed 语义）。
  // 重启后投影不再为空：CLI 冷物化把 journal 回放进同一个 reducer，
  // 卡片 join 只读投影，不再合并发现查询。发现查询在这里只剩一个用途——
  //
  // `limit` 与 `refreshKey` 服务的是任务列表那条「已结束的工作流 · N」页脚行：
  // - 深度取 run 目录页的同一个常量，否则页脚行的计数与页面上的行会是两套口径；
  // - 触发器取**同一个派生函数**（run 数 + 已结算数），所以页脚行与它开出来的目录页新鲜度一致；
  //   接投影的 `revision` 则会把一次分页读变成一条跟着节点事件走的流。
  // [失败路径] 只读 pane（嵌套 transcript）必须关掉 journal 查询：子会话 id 去问
  // 按父会话建键的 journal，会让 CLI 冷会话为正在运行的 detached actor 再物化一个 runtime，
  // 造成双写与直播冻结。readOnly 与 runtimeReady 两个条件都不能省：前者防幽灵 runtime，
  // 后者防未就绪时用空 rows 建索引。
  // `limit` 与 refreshKey 服务任务列表的“已结束的工作流 · N”页脚，口径必须与目录页一致。
  const workflowRunJournalSummaries = useWorkflowRunJournalSummaries({
    sessionId,
    // Bug 根因（2026-08-24 实测）：嵌套只读 transcript（dwf actor / subagent）也是 SessionPane，
    // 无差别发这条查询等于拿子会话 id 去问一条按**父会话**建键的 journal；CLI 的冷会话前置
    // 随即为正在运行的 detached actor 会话物化第二个 runtime（幽灵），双写事件日志，
    // 直播冻结在「已工作 xx 秒」。只读 pane 也不消费 join 回退与任务列表页脚，直接关掉。
    enabled: !readOnly && runtimeReady,
    live: state.status === "live" && runtimeReady,
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(snapshot?.workflowRuns?.runs),
  });
  // 只统计“已结算”的 run：运行中的 run 计入页脚会让数字在跑动时不断跳，
  // 且与目录页的“已结束”过滤口径不一致。
  const endedWorkflowRunCount = useMemo(
    () => countEndedWorkflowRuns(workflowRunJournalSummaries),
    [workflowRunJournalSummaries],
  );
  // 联接表只依赖 workflowRuns 投影：工具行的 output 在 v4 下只剩散文，
  // 结构化字段必须从 run 投影取，因此不能改成按行 output 解析。
  const workflowRunByToolCallId = useMemo(
    () => buildWorkflowRunByToolCallId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // runId 键的同源表：ResumeWorkflowRun 工具行的联接入口（display 带 runId，投影的
  // toolCallId 跨 resume 沿用原始 CreateWorkflow 行，resume 行按 toolCallId 查不到）。
  // resume 工具行的 toolCallId 指向原始 Create 行，按 toolCallId 查不到；
  // 因此必须另建 runId 索引，两条索引缺一都会让部分卡片无法打开详情。
  const workflowRunByRunId = useMemo(
    () => buildWorkflowRunByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // 发起 toolCallId → 静态图：图是 run 的属性，
  // 三种来源的轮尾 run 卡都到这一张表取图。行窗口一遍建成，随窗口重建。
  // 静态图属于 run，但只有行窗口里才有发起 toolCallId；随窗口重建而不是缓存，
  // 保证历史分页加载后新进入窗口的 run 也能拿到图。
  const workflowGraphByToolCallId = useMemo(
    () => buildWorkflowGraphByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // runId → 最新补全的有效脚本图（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：补全之后
  // run 卡与侧板取它。行窗口一遍建成，随窗口重建。
  // 补全后的有效脚本图按 runId 取，必须晚于 fill 行出现；用窗口而不是投影，
  // 是因为补全信息只存在于行里，没有独立的 run 字段。
  const workflowFillGraphByRunId = useMemo(
    () => buildWorkflowFillGraphByRunId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // 工作流工具行 → 草稿位置：稿号与
  // 「后面还有更新的一稿」都只能从行序读出，行窗口一遍建成，随窗口重建。
  // 草稿序号与“是否还有更新一稿”只能从行序推出，因此必须基于已排序的窗口，
  // 不能用 run 投影的字段；分页边界处序号可能从中间开始，展示时需容忍。
  const workflowDraftByToolCallId = useMemo(
    () => buildWorkflowDraftByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // runId → 转写里认领过它的 SaveWorkflow 候选（docs/dynamic-workflow/transcript-and-notifications.md
  // 「Which workflow a run is saved as」规则 1）。行窗口一遍建成，随窗口重建。
  // SaveWorkflow 候选的认领关系来自转写行序（规则 1），同样只能从窗口构建；
  // 它是“这个 run 被保存成哪个 workflow”的唯一线索，run 投影里没有该字段。
  const workflowSaveCandidatesByRunId = useMemo(
    () => buildWorkflowSaveCandidatesByRunId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // Workflow 通知 manifest 的升级条目 Waiting→Answered 联查表（runId → 停驻 qid 集合）。
  // Waiting→Answered 的升级联查需要“停驻 qid 集合”，而 qid 只在通知 manifest 里；
  // 按 runId 建索引后，通知行渲染时无需再遍历整份 manifest。
  const workflowRunPendingQuestionsByRunId = useMemo(
    () => buildWorkflowRunPendingQuestionsByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // 详情页入口（面板 Workflows 分区的行）。行只把「打开哪个 run」交出来（runId + toolCallId），
  // 会话与 workspace 身份照旧由这里补齐——与工具卡走的是同一个 handler，不存在第二条打开路径。
  // 面板入口复用工具卡的 handleOpenWorkflowRun，而不是新开一条打开路径：
  // 两条路径会在“补齐 parentSessionId / scope”上逐渐分叉，最终出现面板能开、卡片打不开。
  // 面板行只交出 runId + toolCallId，这里补 sessionId 作为 parent。
  const handleOpenWorkflowRunFromPanel = useCallback(
    (target: ConversationStatusPanelWorkflowRunTarget) => {
      if (!sessionId) return;
      handleOpenWorkflowRun({ ...target, parentSessionId: sessionId });
    },
    [handleOpenWorkflowRun, sessionId],
  );
  // run 目录页的入口（同一条页脚行）。同样只补 scope，不在这里多造一条打开路径。
  const handleOpenWorkflowRunDirectoryFromPanel = useCallback(
    (request: OpenWorkflowRunDirectorySideTabRequest) => {
      onOpenWorkflowRunDirectory?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRunDirectory, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // [事务] 引用必须同时带 targetSessionId 与 workspaceKey：同一 child 会话可能在
  // 两个工作区被引用，只带一个键会把引用写进错误的选区历史。无会话时静默返回，
  // 因为选区动作在空态本身就不该出现。
  const handleAddSelectionToCurrentTask = useCallback(
    (reference: ConversationSelectionReference) => {
      if (!sessionId) return;
      dispatchConversationSelectionAdd({
        targetSessionId: sessionId,
        workspaceKey,
        reference,
      });
    },
    [sessionId, workspaceKey],
  );
  // [事务] 打开副屏分三种路径，顺序不能乱：
  // 1) 已有 child 且请求读得到 → 复用，只需追加引用；
  // 2) child 已被删（sessionNotFound）→ 记下 replacesChildSessionId，清本地缓存后新建；
  // 3) 没有 child → 通过 createSelectionSideChat 的 pending 合并并发创建。
  // 复用前必须 readSession 探测，否则会打开一个宿主里已不存在的 tab，界面空白且无法关闭。
  // [失败路径] 任何异常只记录 warn，不向调用方抛：选区动作是可选的辅助能力，
  // 抛错会冒泡成全局错误横幅，打断主对话。
  const handleOpenSelectionSideConversation = useCallback(
    async (reference?: ConversationSelectionReference, forceNew = false) => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) return;
      try {
        let targetChildSessionId = reference && !forceNew ? activeSelectionSideChatSessionId : null;
        let replacesChildSessionId: string | undefined;
        if (targetChildSessionId) {
          try {
            await zcodeSessionService.readSession({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              sessionId: targetChildSessionId,
              messageLimit: 1,
            });
          } catch (error) {
            if (!String(error).includes("sessionNotFound")) throw error;
            // [事务] 只吞 sessionNotFound，其余错误继续上抛给外层 warn：
            // 网络错误时若也走“删除重建”，会把仍健康的 child 从宿主里删掉。
            // replacesChildSessionId 让宿主原子地“删旧开新”，避免多开实现下残留失效 tab。
            // 多开后 tab id 包含 child，旧单例实现依靠新 child 覆盖同一个父 tab
            // 来移除失效项已不成立。这里显式携带 replacesChildSessionId，让宿主原子删旧开新。
            replacesChildSessionId = targetChildSessionId;
            clearSelectionSideChat(targetChildSessionId);
            clearConversationSelectionReferenceScope(targetChildSessionId, workspaceKey);
            targetChildSessionId = null;
          }
        }

        if (targetChildSessionId) {
          onOpenSelectionSideChat({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            parentSessionId: sessionId,
            childSessionId: targetChildSessionId,
          });
          if (reference) {
            dispatchConversationSelectionAdd({
              targetSessionId: targetChildSessionId,
              workspaceKey,
              reference,
            });
          }
          return;
        }

        // [并发] createSelectionSideChat 以 selectionSideChatKey 合并并发创建：
        // 用户连点两次“在副屏打开”时只发一条 createSelectionSideSession，
        // 两次调用拿到同一个 child。回调内部再校验 ack 类型，防止把 rejected 当成功。
        const childSessionId = await createSelectionSideChat(selectionSideChatKey, async () => {
          const ack = await dispatchCommand("createSelectionSideSession", {}, sessionId);
          if (
            (ack.status !== "accepted" && ack.status !== "duplicate") ||
            ack.result?.type !== "createSelectionSideSession"
          ) {
            throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
          }
          return ack.result.sessionId;
        });
        onOpenSelectionSideChat({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          parentSessionId: sessionId,
          childSessionId,
          ...(replacesChildSessionId ? { replacesChildSessionId } : {}),
        });
        if (reference) {
          dispatchConversationSelectionAdd({
            targetSessionId: childSessionId,
            workspaceKey,
            reference,
          });
        }
      } catch (error) {
        // [失败路径] 这里必须吞掉异常：调用点包括选区菜单与快捷键，抛出去会变成
        // 未处理的 Promise 拒绝。日志保留 parent/workspace，便于定位是哪一侧的创建失败。
        logger.warn("[v4-pane] 创建框选副屏会话失败", {
          error: error instanceof Error ? error.message : String(error),
          parentSessionId: sessionId,
          workspaceKey,
        });
      }
    },
    [
      activeSelectionSideChatSessionId,
      dispatchCommand,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
      zcodeSessionService,
    ],
  );

  // [事务] 带 prompt 的副屏是“创建 + 首发”合并：模型继承自父会话，推荐器可能改写选择。
  // 返回值三态：false 表示用户取消了推荐、true 表示已创建、抛错表示不可用。
  // 不能把 false 当失败：用户在推荐弹层点取消是正常路径，调用方不应展示错误。
  // [并发] pendingKey 含文本：同一文本的重复点击合并，不同文本必须各自建 child，
  // 否则两条 prompt 会被塞进同一个会话，顺序也无法保证。
  const handleOpenSelectionSideConversationWithPrompt = useCallback(
    async (text: string, telemetrySeed?: ConversationPromptTelemetrySeed): Promise<boolean> => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) {
        throw new Error("selection side chat is unavailable");
      }
      const inherited = resolveSelectionSideInheritedModel(
        snapshotRef.current?.config,
        modelSelectionView,
      );
      const chosen = inherited ? await recommendStartPlan(inherited) : undefined;
      if (chosen === null) return false;
      const modelSelection = chosen && chosen !== inherited ? chosen : undefined;
      // [权衡] chosen 与 inherited 相同时不显式传 modelSelection：让服务端走
      // “继承父会话”的默认路径，避免把父会话当前模型固化进 child 的配置。
      // chosen === null 是推荐器明确表示取消，必须原样返回 false，不能继续创建。
      // 参数命令每次都是新 child；同一条文本在 ACK 未回时重试仍复用 pending，
      // 不同文本则不能与 bare `/side` 或另一条 prompt 合并。
      const pendingKey = `${selectionSideChatKey}\u0000prompt\u0000${text}`;
      const childSessionId = await createSelectionSideChat(pendingKey, async () => {
        const ack = await dispatchCommand(
          "createSelectionSideSession",
          { firstInput: { text, ...(modelSelection ? { modelSelection } : {}) } },
          sessionId,
          undefined,
          undefined,
          telemetrySeed,
        );
        if (
          (ack.status !== "accepted" && ack.status !== "duplicate") ||
          ack.result?.type !== "createSelectionSideSession"
        ) {
          throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
        }
        return ack.result.sessionId;
      });
      onOpenSelectionSideChat({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        parentSessionId: sessionId,
        childSessionId,
      });
      return true;
    },
    [
      dispatchCommand,
      modelSelectionView,
      recommendStartPlan,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // [事务] 注册副屏 opener 是“把本 pane 的创建能力借给固定入口”的桥：
  // Side Pane 自身没有会话 Provider，只有主 pane 才能发 createSelectionSideSession。
  // 注册必须带阻塞状态：Permission/AskUser 等交互弹层期间，空白副屏入口应禁用，
  // 但“用已有引用打开”仍允许，所以 opener 内部对 reference 做了区分。
  // 六个前置条件缺一不可：副屏形态自身、只读、手机输入视口都不应再注册，否则会自递归。
  useEffect(() => {
    if (
      !selectionSideChatKey ||
      !sessionId ||
      readOnly ||
      selectionSideChat ||
      isMobileTextInputViewport ||
      !onOpenSelectionSideChat
    ) {
      return;
    }

    // [并发] 父会话即使处于阻塞态也保持注册：注册本身不创建会话，
    // 真正创建时才由第三个参数（blocked）决定是否允许。若在阻塞时注销，
    // 引用路由会以为“没有 opener”，把用户已有副屏判成不可用。
    // Side Pane 固定入口没有会话 Provider；这里只注册主 pane 已有的命令编排能力。
    // 父会话即使处于 Permission/AskUser 等阻塞态也保持注册，直接入口仍可创建/激活副屏。
    return registerSelectionSideChatOpener(
      selectionSideChatKey,
      // 合并时曾丢弃 reference，导致 Markdown 入口只建空白副屏；复用现有引用路由。
      (reference) => handleOpenSelectionSideConversation(reference, !reference),
      focused,
      Boolean(blockingInteractionId) || selectionSideActionBlocked,
    );
  }, [
    blockingInteractionId,
    selectionSideActionBlocked,
    focused,
    handleOpenSelectionSideConversation,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    selectionSideChatKey,
    sessionId,
  ]);

  // 命令名统一小写并规范化：用户可能输入 /Side 或带空格的变体，匹配必须大小写无关，
  // 否则同一个能力会因为 CLI 命令装配差异而出现两次。
  const cliSlashCommandNames = useMemo(
    () =>
      new Set(
        (slashCommands ?? []).map((command) =>
          normalizeSlashCommandValue(command.name).toLowerCase(),
        ),
      ),
    [slashCommands],
  );
  // [权衡] side/btw 是“本地能力”命令，只有在 CLI 没有同名命令时才补：
  // 若 CLI 也注册了 side，两边同时出现会让用户看到两个同名项且行为不同。
  const availableSelectionSideSlashCommandNames = useMemo(
    () => ["side", "btw"].filter((name) => !cliSlashCommandNames.has(name)),
    [cliSlashCommandNames],
  );

  // [事务] app 级命令（plan/side/btw）必须“选中即生效”，不能等发送时再解析文本：
  // 发送期解析会让用户在 Composer 里看到一段普通文本，却突然进入 plan 模式，
  // 无法撤销；这里直接改 Composer intent，用户可以再次切换回来。
  // readOnly 时返回 undefined，彻底不给入口，避免观察视图触发模式切换。
  // Plan 选中即开启标准 Composer 开关，不能等发送时解析文本；与 /side 共用本地操作入口。
  const appSlashCommands = useMemo<AppSlashCommand[] | undefined>(() => {
    if (readOnly) return undefined;
    const planAction: AppSlashCommand = {
      value: "plan",
      label: intl.formatMessage({ id: "chat.slash.app.plan.label" }),
      description: intl.formatMessage({ id: "chat.slash.app.plan.description" }),
      keywords: ["plan", "计划", "计划模式"],
      run: () => handleDraftSwitchMode("plan"),
    };
    // [失败路径] 任一副屏条件不满足都只返回 plan：side/btw 入口不能出现在
    // 无法创建副屏的形态里（手机、只读、本身就是副屏），否则点击后只会得到
    // 一条 warn 日志，用户界面没有任何反馈。
    if (
      !sessionId ||
      !onOpenSelectionSideChat ||
      !shouldOfferSideSlashCommand({
        isDraft: sessionId === null,
        selectionSideChat,
        readOnly,
        isMobileViewport: isMobileTextInputViewport,
      })
    ) {
      return [planAction];
    }
    const openNewSelectionSideChat = () => {
      void handleOpenSelectionSideConversation(undefined, true);
    };
    // [权衡] 关键词固定同时包含中英文别名，任一 locale 下输入 side / btw / 辅助
    // 都能搜到，不随 intl.locale 切换而变化；代价是非当前语言的关键词也占搜索位。
    // 两个条目共享同一个 run，但独立展示，因为用户对 btw 的心智是“顺便一问”。
    // 关键词固定同时包含中英文别名，任一 locale 下输入 side / btw / 辅助 都能搜到。
    // `/btw` 是 `/side` 的等价别名，适配不同用户输入习惯，面板中各自独立展示。
    const sharedKeywords = ["side", "btw", "side chat", "auxiliary", "辅助对话", "辅助", "侧边"];
    const description = intl.formatMessage({ id: "chat.slash.app.side.description" });
    return [
      planAction,
      ...[
        { value: "side", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
        { value: "btw", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
      ].filter((command) => !cliSlashCommandNames.has(command.value)),
    ];
  }, [
    cliSlashCommandNames,
    handleDraftSwitchMode,
    handleOpenSelectionSideConversation,
    intl,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    sessionId,
  ]);

  // [并发] “是否被交互阻塞”与“是否被后台工作阻塞”分开算：两者文案与恢复方式不同，
  // 合成一个布尔后 UI 无法告诉用户是去处理权限弹层还是等后台任务结束。
  // 两者都从 pendingInteractions/activeWorks 投影读取，不引入本地计数。
  const chatLoadingBlockedByInteraction = hasChatLoadingBlockingInteraction(
    snapshot?.pendingInteractions ?? [],
  );
  const chatLoadingBlockedByActiveWork = hasChatLoadingBlockingActiveWork(
    snapshot?.control.activeWorks ?? [],
  );
  // [权衡] 只读只收窄“会话内容编辑”，文件回退作用于 workspace 而非会话，
  // 因此单独由 allowWorkspaceFileRewind 放行；把两者绑在一起会让 subagent 观察视图
  // 连“恢复我的工作区文件”都做不到。
  // 子智能体详情的会话内容仍只读；文件撤销恢复的是 workspace，必须作为独立能力判断。
  const workspaceFileRewindEnabled = !readOnly || allowWorkspaceFileRewind;
  // cancelBackgroundWork：启动卡 / 后台任务卡的「取消」入口。定义在 rowContext memo 之前，
  // 供其绑定（onOpenWorkflowRun 同样在 memo 前定义）；只读模式下不下发（与 4213 处一致）。
  // [并发] 后台任务取消是 fire-and-forget：结果只记 warn，不进错误横幅。
  // 取消失败通常意味着任务已自行结束，向用户报错反而制造噪音。
  // accepted 与 noop 都算成功，noop 表示目标已不存在（幂等）。
  const handleCancelBackgroundWork = useCallback(
    (workId: string) => {
      if (!sessionId) return;
      void dispatchCommand("cancelBackgroundWork", { workId }, sessionId).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] cancelBackgroundWork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // [权衡] 灰度开关只在 Root 取一次，pane 只读：每个 pane 各自取会让分屏出现
  // “左 pane 已灰度、右 pane 未灰度”的撕裂，工具卡行为不一致。未就绪按未命中处理。
  // 动态工作流灰度快照：只读 store，
  // 取数在 Root 里做一次。未就绪时 enabled 为 false，按未命中处理。
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();

  // [事务] Resume 不携 baseRevision：恢复动作的权威对象是 run 目录里的 workId，
  // 而不是当前日志 revision；带 CAS 会让“日志刚追加了一行”就拒绝恢复。
  // name 只用于完成通知主题，缺省时服务端沿用 run 展示名。
  // resumeWorkflowRun：工具卡页脚的 Resume。与详情页
  // 同一条 v4 命令，不携 baseRevision；`name` 喂恢复后完成通知的主题。
  const handleResumeWorkflowRun = useCallback(
    (workId: string, name?: string) => {
      if (!sessionId) return;
      void dispatchCommand(
        "resumeWorkflowRun",
        { workId, ...(name ? { name } : {}) },
        sessionId,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] resumeWorkflowRun 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // [失败路径] amend 把 ACK 原样返回给弹层，而不是只记日志：配置冲突/校验失败
  // 需要展示在用户正在操作的表单里，控制台 warn 用户看不到，表单会误以为已保存。
  // 门与 Resume 相同（见 rowContext），但它额外要求 sessionId，因为写配置必须有目标。
  // amendWorkflowRunSettings：run 卡的「配置」。回 ACK 给弹层——拒绝理由画在弹层里，不是控制台的一行 warn。门与 Resume 相同。
  const handleAmendWorkflowRunSettings = useCallback(
    (workId: string, change: WorkflowRunSettingsChange): Promise<CommandAck> =>
      dispatchCommand("amendWorkflowRunSettings", { workId, ...change }, sessionId),
    [dispatchCommand, sessionId],
  );
  // [事务] 工作流会话模型必须取自“与当前 sessionId 同源”的 snapshot.config：
  // 切会话瞬间 snapshot 可能还是旧会话的，直接取会把上一个会话的模型显示到新会话的
  // 工作流配置里。条件不成立时返回 undefined，由上层回退到默认展示。
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(snapshot?.sessionId === sessionId ? snapshot?.config : undefined),
    [sessionId, snapshot?.config, snapshot?.sessionId],
  );

  // [并发] ref 在渲染中赋 null、挂载后再由下面赋值：rowContext 的 memo 工厂在
  // 同一次渲染里就会执行，若直接引用 handleSendText 会落进 TDZ。点击总发生在挂载后，
  // 因此运行时 ref 一定已就绪；null 只可能出现在极端早期调用，此时明确抛错。
  /**
   * 「让 ZCode 帮我提炼保存」那条用户消息的发送口（docs/dynamic-workflow/transcript-and-notifications.md
   * 「The message the lead sends」）：与中枢的「提升为全局」同一条先例——GUI 写、自动发、用户不再确认。
   *
   * 经 ref 转一手而不是直接引 `handleSendText`：后者定义在本文件更下面，而 rowContext 的 memo
   * 工厂在**同一次渲染里**就会跑到，直接引会落进 TDZ。ref 在渲染中赋值，点击总在挂载之后。
   */
  // [事务] 只要 send 没有返回 "sent" 就必须抛错：queued/blocked 都表示消息没有
  // 真正交给 ZCode，弹层应保持打开让用户重试。把 queued 当成功会让“提炼保存”
  // 看起来已完成，但实际没有任何消息被发出。
  const sendTextRef = useRef<typeof handleSendText | null>(null);
  const handleSendWorkflowSaveRequest = useCallback(async (text: string) => {
    const send = sendTextRef.current;
    if (send === null) throw new Error("send path not mounted");
    const result = await send(text);
    // 被挡下（会话忙着确认别的、队列暂停待确认）就不是「已交给 ZCode」：抛回弹层，让它留在原处。
    if (result !== "sent") throw new Error(`workflow save request not sent: ${result}`);
  }, []);

  // [并发] rowContext 是整棵 Timeline 的“能力与身份快照”，必须整体 memo：
  // 任何字段换引用都会让所有行组件重渲染。因此每个 handler 都用稳定 useCallback，
  // 每个可选能力都用 runtimeReady 门控成 undefined（而不是传一个会 no-op 的函数），
  // 行组件才能用 `=== undefined` 判断“该能力在当前形态不存在”。
  // [事务] logEpoch 一并下发：行内的 diff/附件请求需要它参与缓存键，缺了会跨代复用。
  // 只读/副屏/远控的收窄全部体现在这张表的 undefined 上，而不是散落在行组件里。
  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      workspaceRemoteSessionId: remoteSessionId ?? undefined,
      modelSelectionView,
      logEpoch: snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId: rootSessionId ?? sessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      onNavigateToRow: handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx: runtimeReady ? handleAutoOpenAssistantPptx : undefined,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession:
        runtimeReady && onOpenSubagentSession ? handleOpenSubagentSession : undefined,
      onOpenPlanDetail: runtimeReady && onOpenPlanDetail ? handleOpenPlanDetail : undefined,
      onOpenWorkflowRun: runtimeReady && onOpenWorkflowRun ? handleOpenWorkflowRun : undefined,
      onOpenWorkflowActor:
        runtimeReady && onOpenWorkflowActorSession ? handleOpenWorkflowActorSession : undefined,
      onOpenWorkflowWorkspace:
        runtimeReady && onOpenWorkflowWorkspace ? handleOpenWorkflowWorkspace : undefined,
      onOpenWorkflowArtifact:
        runtimeReady && onOpenWorkflowArtifact ? handleOpenWorkflowArtifact : undefined,
      onCancelBackgroundWork: readOnly || !runtimeReady ? undefined : handleCancelBackgroundWork,
      // [事务] Resume 的唯一供给点：灰度与只读两道门都在 resolveWorkflowResumeHandler 里，
      // 这里只负责把 handler 挂上去。断在这里等于工具卡页脚与摘要卡的按钮一起消失，
      // 因此改动这个字段前要同时检查两处消费方。
      // Resume 进入会话上下文的唯一供给点；灰度与只读两道门都在 resolveWorkflowResumeHandler 里，
      // 断在这里等于工具卡页脚与摘要卡的按钮一起消失。
      onResumeWorkflowRun: resolveWorkflowResumeHandler({
        readOnly: readOnly || !runtimeReady,
        dynamicWorkflowEnabled,
        handler: handleResumeWorkflowRun,
      }),
      onAmendWorkflowRunSettings:
        runtimeReady && sessionId
          ? resolveWorkflowResumeHandler({
              readOnly,
              dynamicWorkflowEnabled,
              handler: handleAmendWorkflowRunSettings,
            })
          : undefined,
      // [权衡] 写文件与起引擎共用“Resume 被收走的地方一并收走”的策略，
      // 但保存请求额外要求 sessionId：没有会话就没有可写入的工作流目录。
      // `onSendWorkflowSaveRequest` 这道门不含芯片：芯片只展示事实，不产生副作用。
      // 保存与 Resume 同一道门、同一个供给点：写文件与起引擎都属于「Resume 被收走的地方一并收走」
      // （docs/dynamic-workflow/launch.md「Gray release」）。芯片不经这道门，它只是一条事实。
      onSendWorkflowSaveRequest:
        runtimeReady && sessionId
          ? resolveWorkflowResumeHandler({
              readOnly,
              dynamicWorkflowEnabled,
              handler: handleSendWorkflowSaveRequest,
            })
          : undefined,
      workflowSaveCandidatesByRunId,
      ...(workflowSessionModel === undefined ? {} : { workflowSessionModel }),
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      // [失败路径] 所有跨进程能力（diff、附件、文件回退）都以 runtimeReady 为门：
      // 未就绪时传 undefined，行组件据此禁用入口并展示“正在初始化”，
      // 而不是传一个会 reject 的函数让每个行自己处理错误。
      // 文件回退额外叠加 workspaceFileRewindEnabled，与只读会话内容解耦。
      fetchFileChanges: runtimeReady ? handleFetchFileChanges : undefined,
      previewFileRewind:
        runtimeReady && workspaceFileRewindEnabled ? handlePreviewFileRewind : undefined,
      applyFileRewind:
        runtimeReady && workspaceFileRewindEnabled ? handleApplyFileRewind : undefined,
      readAttachment: runtimeReady ? attachmentRead : undefined,
      readAttachmentRange: runtimeReady ? attachmentReadRange : undefined,
    }),
    [
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      remoteSessionId,
      modelSelectionView,
      snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession,
      handleOpenSubagentSession,
      onOpenPlanDetail,
      handleOpenPlanDetail,
      onOpenWorkflowRun,
      handleOpenWorkflowRun,
      onOpenWorkflowActorSession,
      handleOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      handleOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      handleOpenWorkflowArtifact,
      readOnly,
      runtimeReady,
      handleCancelBackgroundWork,
      dynamicWorkflowEnabled,
      handleResumeWorkflowRun,
      handleAmendWorkflowRunSettings,
      handleSendWorkflowSaveRequest,
      workflowSaveCandidatesByRunId,
      workflowSessionModel,
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      workspaceFileRewindEnabled,
      handleFetchFileChanges,
      handlePreviewFileRewind,
      handleApplyFileRewind,
      attachmentRead,
      attachmentReadRange,
    ],
  );

  // [权衡] 预热会话只存在于 pane 内部，对外 activeTaskId 仍为 null：
  // 这样宿主的“新任务”入口不需要知道后台已经建了 draft，也不会把它列进会话历史。
  // enabled 的三条件缺一不可：只读/不可启动/正在恢复草稿时都不该新建预热，否则
  // 一份草稿可能同时存在两个载体，首发时命令落到错误的 session。
  // ── 草稿态 v4 draft session 预热（m5）──
  // pane 未绑定会话时后台建 phase=draft 会话作预热载体：配置写 CAS 直达、首发复用。
  // 对外绑定语义不变（shell activeTaskId 仍 null），预热会话只是 pane 内部 effective 订阅目标。
  const { binding: prewarmBinding, waitForSession: waitForDraftSession } = useDraftSessionPrewarm({
    enabled: sessionId === null && draftAgentStartupAllowed && !recoveringDraft,
    workspaceKey,
    paneId,
    invalidationVersion: draftRuntimeInvalidationVersion,
    // SessionDataLayer 来自 workspace connection registry：同 transport generation 的 pane/remount
    // 共享 identity；provider wrapper 重建产生的新 sendCommand 函数不能误判为 transport 换代。
    transportIdentity: layer,
    dispatchCommand,
    // 预热会话只消费当前 Root Composer Draft 的一次性初始化结果。
    resolveInitialConfig: resolveInitialDraftConfig,
  });
  // [并发] 每帧同步镜像 binding：发送路径在 await 之后需要知道“预热会话是否已就绪”，
  // 读 state 会慢一拍。ref 不做依赖，只做读取。
  const prewarmBindingRef = useRef(prewarmBinding);
  prewarmBindingRef.current = prewarmBinding;
  const prewarmSessionId = prewarmBinding?.sessionId ?? null;
  // [失败路径] runtime 重建期间必须禁发：预热会话已被 workspace-dispose 冲掉，
  // 此时发送会把附件挂到不存在的 session 上，得到 sessionNotFound，而用户看到的是
  // 一条无上下文的失败。rebuilding 只影响草稿态，既有会话不受 workspace 重建影响。
  // runtime 换代（CUA Helper 就绪、liveness 恢复等触发 workspace-dispose）会冲掉草稿态尚未
  // 持久化的预热会话。重建期间禁止发送，否则附件会挂在已消失的会话上（sessionNotFound）。
  const { rebuilding: draftRuntimeRebuilding } = useDraftRuntimeRebuildGate({
    enabled: sessionId === null,
    onRuntimeRestart,
    onRuntimeLifecycle,
    prewarmSessionId,
    workspaceIdentity,
    workspacePath,
  });
  // [事务] send 前补齐配置的钩子先用 no-op 占位，由真正的实现稍后写入 ref。
  // 占位返回 resolved Promise 而不是 reject：早期调用（如首帧恢复）不应因为
  // 钩子未就绪而失败，配置补齐本身会在下一轮发送时重试。
  const ensureDraftPrewarmConfigBeforeSendRef = useRef<(targetSessionId: string) => Promise<void>>(
    async () => undefined,
  );
  // [并发] effective 订阅目标的优先级：真实会话 > 恢复中的草稿会话 > 预热会话。
  // 三者互斥且按“离用户最近”排序：恢复中的草稿必须优先于新建的预热，否则恢复轮询
  // 与预热订阅会同时存在，用户可能看到两个空会话。对外 sessionId 仍保持 null。
  // 注意它可能不等于 sessionId：所有订阅/命令都必须用 effective，而不是 sessionId。
  const effectiveSessionId = sessionId ?? recoveringDraft?.sessionId ?? prewarmSessionId;
  useEffect(() => {
    if (!recoveringDraft?.commandId || !remoteAvailable) return;
    let current = true;
    const commandId = recoveringDraft.commandId;
    // [事务] 订阅命令的最终裁决，而不是只轮询一次：首发可能在查询返回后才被接受。
    // accepted/duplicate/authoritative 都意味着“会话已存在”，必须走 handleDraftSessionCreated
    // 完成晋升；failed/discarded 才标记本命令已解决，允许用户重新发。
    // 用 current 标志防止卸载后回调继续 setState，off 同时解除订阅。
    const off = pendingCommandRegistry.subscribeResolution(commandId, (resolution) => {
      if (!current) return;
      if (
        resolution === "accepted" ||
        resolution === "duplicate" ||
        resolution === "authoritative"
      ) {
        const entry = pendingCommandRegistry.findCommand(commandId);
        const recoveredSessionId = entry?.sessionId ?? recoveringDraft.sessionId;
        if (recoveredSessionId)
          void handleDraftSessionCreated(
            recoveredSessionId,
            entry?.clientContext?.sessionCreateSource,
            commandId,
            entry?.clientContext?.taskGroupId,
          );
      } else if (resolution === "failed" || resolution === "discarded") {
        setResolvedDraftCommand(commandId);
      }
    });
    // [失败路径] 恢复查询失败只 warn，不清 recoveringDraft：草稿身份必须保留，
    // 否则用户会看到输入内容消失，而命令可能仍被接受。下一次 effect 重跑会再查。
    // scope 用 workspaceIdentity 优先，保证远端工作区查的是同一本账。
    void pendingCommandRegistry
      .reconcileSession(
        pendingCommandRegistry.findCommand(commandId)?.sessionId ??
          recoveringDraft.sessionId ??
          null,
        (params) => layer.queryCommands(params),
        workspaceIdentity?.trim() || workspacePath,
      )
      .catch((error) => {
        logger.warn("[v4-composer] 首发结果恢复查询失败，保留草稿身份", error);
      });
    return () => {
      current = false;
      off();
    };
  }, [
    recoveringDraft,
    remoteAvailable,
    layer,
    handleDraftSessionCreated,
    newTaskComposerScope,
    workspacePath,
    workspaceIdentity,
  ]);
  // [权衡] 草稿态不弹“模型已切换”：此时模型选择就在 Composer 里可见，
  // 初始化/预热的 fallback 会被误报成一次会话内切换。只有在已有会话、且 provider
  // 或 model 真的变化时才提示，避免“初始化提示”淹没真正的切换。
  const showModelChangeNotice = useCallback(
    (sourceModel: ModelSelectionSource | null, targetModel: ModelSelectionSource) => {
      // Bug 原因：草稿尚未形成实际会话，模型选择本身已经在 composer 中可见；
      // 若此时重复弹出切换结果，会把初始化或 prewarm fallback 误报成一次会话内切换。
      if (sessionId === null) {
        return;
      }

      const fromProviderId = sourceModel?.provider ?? "";
      const fromModelId = sourceModel?.model ?? "";
      const providerChanged = Boolean(
        fromProviderId && targetModel.provider && fromProviderId !== targetModel.provider,
      );
      if (
        !fromModelId ||
        !targetModel.model ||
        (fromModelId === targetModel.model && !providerChanged)
      ) {
        return;
      }

      const fromProvider = resolveProviderLabel(fromProviderId, modelSelectionView);
      const toProvider = resolveProviderLabel(targetModel.provider, modelSelectionView);
      const fromModel = formatModelChangeLabel(fromProviderId, fromProvider, fromModelId, intl);
      const toModel = formatModelChangeLabel(
        targetModel.provider,
        toProvider,
        targetModel.model,
        intl,
      );
      toast(intl.formatMessage({ id: "chat.modelChangeNotice.changed" }, { fromModel, toModel }));
    },
    [intl, modelSelectionView, sessionId],
  );

  // [并发] online 模型切换只由 focused 且同代的 pane 消费：分屏里两个 pane 同时弹
  // “模型已切换”会重复提示，而且未聚焦 pane 的切换往往不是用户刚做的操作。
  // 过去 fallback 提示与偏好晋升分别由 online 事件和 snapshot 差异驱动，会出现
  // 同一次切换提示两次；现在统一消费 store 去重后的 realtime online 事件。
  const handleOnlineModelTransition = useCallback(
    (
      subscribedSessionId: string,
      _store: SessionLease["store"],
      transition: SessionModelTransition,
    ) => {
      if (!focused || subscribedSessionId !== effectiveSessionId) return;
      // Bug 原因：自动 fallback 的提示与偏好晋升过去分别由 online 事件和任意
      // snapshot 差异驱动，recovery/历史投影可能静默改写下一草稿。现在两者都只
      // 消费 store 已按 deliveryKind 去重后的同一 realtime online 事件。
      showModelChangeNotice(transition.from, transition.to);
    },
    [
      effectiveSessionId,
      focused,
      provider,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );
  // [并发] 用 layout effect 同步最新 handler 到 ref，供订阅层在 commit 后立即调用：
  // 普通 effect 会晚一帧，期间到达的 online 事件会调用旧 handler，漏掉一次切换提示。
  const onlineModelTransitionHandlerRef = useRef(handleOnlineModelTransition);
  useLayoutEffect(() => {
    onlineModelTransitionHandlerRef.current = handleOnlineModelTransition;
  }, [handleOnlineModelTransition]);

  // [事务] 可恢复命令列表只服务 UI 提示（“上次发送可能已送达”），不自动重放：
  // 自动重放会在用户不知情时产生第二条消息。effectiveSessionId 而非 sessionId，
  // 是因为草稿/恢复态的命令也挂在预热会话上，漏掉会让提示永远不出现。
  const recoverableCommands = usePendingCommandRecovery({
    layer,
    sessionId: effectiveSessionId,
    snapshot,
    status: state.status,
    subscriptionId: state.subscriptionId,
    workspacePath,
    workspaceIdentity,
  });

  // [并发] lease 的 acquire/release 必须成对且同代：effect 只依赖 (layer, effectiveSessionId)，
  // 换代时 cleanup 先 release 旧 lease，再 acquire 新 lease。若把 lease 写进依赖，
  // setLease 会触发 effect 重跑，导致 acquire→release→acquire 的自旋。
  // 无 effectiveSessionId 时也 setLease(null)，显式清掉旧代，避免 projection 继续读旧订阅。
  // [资源] acquire 会立即启动 connect，因此 cleanup 必须同步 release，不能延迟到下一帧。
  useEffect(() => {
    if (!effectiveSessionId) {
      setLease({ sessionId, layer, lease: null });
      return;
    }
    const nextLease = layer.acquire(effectiveSessionId);
    // [失败路径] online 模型切换是一次性帧，acquire 后可能在任何一次 snapshot 之前到达；
    // 必须同步订阅，不能靠“下一次 snapshot 对比”补偿，否则会漏掉首帧切换。
    // 订阅绑在 nextLease.store 上而不是全局 store，保证换代后旧事件不会串到新会话。
    // Bug 原因：acquire 会立即启动 connect，activation 可能在下一轮 effect 前释放
    // 一次性 online 帧；必须在 acquire 返回后同步监听，不能靠 snapshot 重放补偿。
    const offOnlineModelTransition = nextLease.store.onOnlineModelTransition((transition) => {
      onlineModelTransitionHandlerRef.current(effectiveSessionId, nextLease.store, transition);
    });
    setLease({ sessionId, layer, lease: nextLease });
    return () => {
      offOnlineModelTransition();
      nextLease.release();
    };
  }, [layer, effectiveSessionId]);

  // [事务] 计划目录刷新只在“lease 与 snapshot 都属于当前会话”时触发：
  // 否则会用旧 lease 去刷另一个会话的 plans，结果写回后被新会话的投影覆盖，
  // 造成一次无意义的全量请求。planDirectoryRevision 变化时重刷，保证侧栏不陈旧。
  useEffect(() => {
    if (!sessionId || !lease || snapshot?.sessionId !== sessionId) return;
    void lease.store.refreshPlans();
  }, [lease, sessionId, snapshot?.sessionId, state.planDirectoryRevision]);

  // [失败路径] 预热会话的订阅错误通常是 CLI 重启导致内存会话消失，此时 binding 已不可用。
  // 必须 discard 而不是重试：重试会反复打同一个不存在的 session；丢弃后下一次发送
  // 由 owner 重新建预热，是唯一能自愈的路径。只在草稿态处理，不影响真实会话的错误展示。
  // 预热会话订阅失败（CLI 重启内存会话消失等）→ 丢弃旧 binding，下一次发送由 owner 重试。
  useEffect(() => {
    if (sessionId === null && prewarmBinding && state.status === "error") {
      logger.warn("[v4-draft-prewarm] 预热会话订阅失败，丢弃旧 binding", {
        prewarmSessionId: prewarmBinding.sessionId,
        lastError: state.lastError ?? null,
      });
      prewarmBinding.discard();
    }
  }, [prewarmBinding, sessionId, state.lastError, state.status]);

  // [失败路径] 副屏 child 丢失（sessionNotFound）时只通知宿主清 tab，不在本 pane 重建：
  // 重建需要父会话上下文与用户手势，自动重建会打开一个用户没要求的空白面板。
  // 只匹配 sessionNotFound，其它错误仍走常规错误展示，避免把网络故障误判成会话丢失。
  useEffect(() => {
    if (
      !selectionSideChat ||
      state.status !== "error" ||
      !state.lastError?.includes("sessionNotFound")
    ) {
      return;
    }
    // 副屏是临时 UI 绑定；持久 child 丢失后清 tab，下一次框选按父会话重建。
    onSelectionSideChatUnavailable?.();
  }, [onSelectionSideChatUnavailable, selectionSideChat, state.lastError, state.status]);

  // [事务] 清空队列发送成功后，队列项的 sourceCommandId 也必须从账本结清：
  // 否则这些命令会一直以“可能已送达”出现在恢复提示里，用户会重复发送。
  // 只处理同一 session 的 snapshot，防止把别的会话的队列项错误结清。
  const settleCurrentQueueInputs = useCallback((targetSessionId: string) => {
    const current = snapshotRef.current;
    if (!current || current.sessionId !== targetSessionId) return;
    for (const item of current.queue.items) {
      pendingCommandRegistry.settle(targetSessionId, item.sourceCommandId);
    }
  }, []);

  // [事务] 斜杠命令是“发送入口的第二种形态”，与 sendText 共用 dispatchCommand，
  // 因此同样要处理：CAS（仅 resumeGoal）、held queue 处置、confirmationRequired、
  // 以及 accepted 后的队列结清。返回值三态：true=已处理、false=不支持、字符串=需确认。
  // 不能把 compact 当 CAS 命令：它是可排队 input，带 baseRevision 会在排队时被拒。
  // [失败路径] 空目标/不支持动作返回 true（已消费），避免 Composer 把原文当普通消息发出去。
  const dispatchSlashCommand = useCallback(
    async (
      command: V4VisibleSlashCommand,
      targetSessionId: string,
      baseRevision: number | undefined,
      heldQueueDisposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
      expectedHeldQueueItemIds?: readonly string[],
      submission?: ComposerSubmissionConfig,
      onAccepted?: (messageId: string) => void,
    ): Promise<boolean | "confirmationRequired"> => {
      let type: CommandType | null = null;
      let payload: Record<string, unknown> = {};
      // [事务] compact 只有在“路由模式确定且不是 startNow”时才预期入队：
      // 未知模式下不弹“已排队”提示，否则用户会以为命令已生效，实际可能立即执行。
      // resumeGoal 仍走 CAS；withBaseRevision 只影响最终 dispatch 的参数，不改 payload。
      // compact 是可排队 input command，不走 CAS；resumeGoal 仍是 CAS。
      let withBaseRevision = false;
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      const compactExpectedToQueue =
        command.kind === "compact" &&
        currentRoutingMode !== undefined &&
        currentRoutingMode !== "startNow";
      switch (command.kind) {
        case "compact":
          type = "compact";
          break;
        case "sendGoalCommand":
          type = "sendGoalCommand";
          // 人工合并曾让 /goal 在准备完成后重新读取 Composer，覆盖点击时已冻结的档位。
          // 与 sendText 一样沿用本次 Submission；后续菜单修改只影响下一次发送。
          if (!submission) return false;
          payload = {
            text: command.objective,
            displayText: command.displayText,
            ...submission,
            ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
            ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          };
          break;
        case "resumeGoal":
          type = "resumeGoal";
          withBaseRevision = true;
          break;
        case "emptyGoal":
          logger.warn("[v4-pane] /goal 需要目标文本");
          return true;
        case "unsupportedGoal":
          logger.warn(`[v4-pane] 暂不支持 /goal ${command.action}`);
          return true;
        default:
          return false;
      }
      // [失败路径] 缺 baseRevision 时返回 true 而不是 false：命令已被识别并消费，
      // 只是无法安全执行；返回 false 会让调用方把 /resume 当普通文本发送出去。
      // 同时只 warn，不弹横幅——这是内部状态不同步，不应打扰用户。
      if (withBaseRevision && baseRevision === undefined) {
        logger.warn(`[v4-pane] slash ${command.kind} 缺少 baseRevision`);
        return true;
      }
      const ack = await dispatchCommand(
        type,
        payload,
        targetSessionId,
        withBaseRevision ? baseRevision : undefined,
      );
      if (ack.status === "accepted") onAccepted?.(ack.commandId);
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired";
      }
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(
          `[v4-pane] slash ${command.kind} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
        );
        if (command.kind === "compact" && ack.reasonCode === "compactOperationLock") {
          toast(intl.formatMessage({ id: "chat.compact.duplicateBlocked" }));
        } else if (command.kind === "compact" && ack.reasonCode === "activeTurn") {
          // 兼容尚未升级的 CLI：旧端仍会返回 activeTurn，不能再次无声清空命令。
          toast(intl.formatMessage({ id: "chat.compact.runningBlocked" }));
        }
      } else if (command.kind === "compact" && compactExpectedToQueue) {
        toast(intl.formatMessage({ id: "chat.compact.queued" }));
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
      return true;
    },
    [dispatchCommand, intl, settleCurrentQueueInputs],
  );

  // [权衡] 草稿 id 用 store 的瞬时读取而不是订阅值：它只在“冻结发送起点”时用到，
  // 若订阅它，草稿焦点每次变化都会重建发送回调。注意这里读的是 draftFocusVersion
  // 而不是 draftId 本身，因为后者在预热创建后会变，前者才代表“用户当前在编辑哪份草稿”。
  const readGroupedDraftId = useCallback(
    () =>
      String(
        useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
          .draftFocusVersion,
      ),
    [workspacePath, workspaceIdentity],
  );
  // [并发] 这是 INV-05 的实现点：origin 必须在任何 await 之前同步取好。
  // 三个字段分别回答“哪个会话 / pane 第几代 / 哪份草稿”，缺任一个都无法在
  // prepare 返回时判断 pane 是否还停在起点。不要把 generation 换成 sessionId 比较：
  // A→B→A 的 sessionId 相同，但用户已经离开过，不能继续呈现。
  /**
   * 冻结本次发送起点（spec §9.2）。必须在触发发送的同步阶段调用：早于配置屏障、草稿模型就绪、
   * Start 套餐推荐、空 session 创建等所有发送前 await，否则起点会被读成用户切换后的 Task。
   */
  const captureHighspeedPaneOrigin = useCallback(
    (): HighspeedPaneOrigin => ({
      sessionId: sessionIdRef.current,
      paneBinding: paneBindingRef.current.generation,
      draftId: sessionIdRef.current === null ? readGroupedDraftId() : null,
    }),
    [readGroupedDraftId],
  );

  // [并发] 返回的是 preparer 闭包，origin 被固化在闭包里，之后无论调用多少次、
  // 中间隔了多少 await，判定基准都不变。闭包内每次都现读 sessionIdRef 与
  // paneBindingRef 作为“现在在哪”，与固化的 origin 对比，这正是起点绑定能成立的原因。
  // [失败路径] 任何 prepare 异常都降级为 null（普通发送），绝不阻塞用户输入。
  // [资源] 依赖数组不含 snapshot：projectedConfig 通过 snapshotRef 读取，避免每次 token 重建。
  const prepareHighspeedTurnFrom = useCallback(
    (origin: HighspeedPaneOrigin): HighspeedTurnPreparer =>
      async (
        taskId: string,
        submissionSelection?: ModelSelection,
      ): Promise<HighspeedPrepareTurnResult | null> => {
        // 规则 15：prepare 的选择与本次提交同源——用户刚切换的模型必须在首次发送就驱动
        // admission。曾按会话投影旧组合抽卡，抽中后把用户切到非 Coding Plan 模型的提交
        // 覆盖成卡模型，表现为"选了别的模型还是抽中加速"。
        const selection = resolveHighspeedPrepareSelection({
          submissionSelection,
          projectedConfig:
            snapshotRef.current?.sessionId === taskId ? snapshotRef.current.config : null,
          draftConfig: draftConfigRef.current,
          initialDraftConfig: resolveInitialDraftConfig(),
        });
        if (!selection) return null;
        // 加速卡沿用会话模型，必须带上会话生效的思考档位；缺档位时 CLI 会因 execution 选择
        // 不完整报 "Reasoning level is required" 让整轮发送失败。优先取提交选择的 options，
        // 再回落 thought（CLI 投影的生效档位）；空串表示该模型无档位，交给 service 省略 options。
        const { provider, model, reasoningLevel } = selection;
        try {
          const sendStartedAt = Date.now();
          const result = await highspeedCardService.prepareTurn({
            taskId,
            providerId: provider,
            model,
            ...(reasoningLevel ? { reasoningLevel } : {}),
            waitBudgetMs: HIGHSPEED_SEND_WAIT_BUDGET_MS,
          });
          if (result.kind === "accelerated") {
            // Bug 根因：该查询只决定节省时间展示，却曾在抽中后同步 await；monitor 侧 15s 超时把
            // 1s 发送承诺拉长到最多 16s（新会话首发尤其明显：空 session 已建、正文长期未发）。
            // 现在只在剩余发送预算内 best-effort 等待，超时/失败本轮不附加 regularTps，
            // 请求由 Service 层继续完成并缓存供下一轮（spec §3 规则 12、§9.4）。
            const regularTps = await readRegularTpsWithinSendBudget({
              read: async () => {
                // 节省时间的基准 TPS 来自 Coding Plan 用量健康接口，请求期鉴权只能由账号访问
                // 上下文解析。这里按当前选中的 Coding Plan Provider 现取快照，不订阅配置面
                // （SessionPane 不需要为此重渲染）；未连接或无权益时直接不展示节省时间。
                const providerSettingsState = getProviderSettingsSnapshot();
                const accountAccess =
                  providerSettingsState.status === "ready"
                    ? resolveEntitledAccountProviderAccess(providerSettingsState.view, provider)
                    : null;
                if (!accountAccess) return undefined;
                return readHighspeedRegularTpsFromHealth({
                  usageStatsService,
                  preferredProviderId: provider,
                  accountAccess: accountAccess.access,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
              },
              elapsedMs: Date.now() - sendStartedAt,
              onError: (error) =>
                logger.warn("[highspeed] 读取普通 Decode TPS 失败，本轮不展示节省时间", {
                  error: error instanceof Error ? error.message : String(error),
                  provider,
                  taskId,
                }),
              onTimeout: (budgetMs) =>
                logger.info(
                  "[highspeed] 普通 Decode TPS 未在发送预算内返回，本轮不附加 regularTps",
                  {
                    budgetMs,
                    provider,
                    taskId,
                  },
                ),
            });
            const acceleratedResult: HighspeedPrepareTurnResult = regularTps
              ? { ...result, card: { ...result.card, regularTps } }
              : result;
            const cardId = acceleratedResult.card.cardId;
            // Bug 根因：SessionPane 跨 Task 复用同一实例，发送前的配置屏障、套餐推荐、建会话以及
            // prepare 与 TPS 读取 await 期间用户都可能切到其他 Task；此时写卡片状态会把旧 Task 的卡
            // 呈现到新 Task 的输入框并播放激活。起点曾在 prepare 入口才读取，切换发生在 prepare 之前时
            // 起点已是新 Task，判定失效；现由调用方在发送同步阶段冻结。只有 pane 正显示卡所属 Task，
            // 或草稿首发且 pane 从未离开该草稿（首发 session 尚未绑定回 pane）时才呈现。卡仍交给本轮
            // 发送继续加速，只跳过本 pane 的呈现；切回所属 Task 由快照恢复按 restore 呈现。
            const paneSessionId = sessionIdRef.current;
            const paneShowsSendTarget =
              paneSessionId === taskId ||
              (origin.sessionId === null &&
                paneSessionId === null &&
                paneBindingRef.current.generation === origin.paneBinding &&
                readGroupedDraftId() === origin.draftId);
            if (!paneShowsSendTarget) {
              return acceleratedResult;
            }
            // Bug 根因：恢复链路与 draw 命中共用同一条卡片渲染路径，按“卡片出现”触发激活动效会在
            // 切回 Task 时重播；prepare 复用已有卡同样返回 accelerated。只有本 pane 首次呈现的卡才登记。
            if (presentedHighspeedCardIdRef.current !== cardId) {
              presentedHighspeedCardIdRef.current = cardId;
              setHighspeedActivationCardId(cardId);
            }
            setActiveHighspeedCard(acceleratedResult.card);
            return acceleratedResult;
          } else if (
            !result.card ||
            result.card.taskId !== taskId ||
            result.card.expiresAt <= Date.now()
          ) {
            setActiveHighspeedCard((current) => (current?.taskId === taskId ? null : current));
          }
          return result;
        } catch (error) {
          logger.warn("[highspeed] 抽卡失败，本轮按普通模型发送", {
            error: error instanceof Error ? error.message : String(error),
            taskId,
          });
          return null;
        }
      },
    [
      draftConfigRef,
      highspeedCardService,
      readGroupedDraftId,
      resolveInitialDraftConfig,
      usageStatsService,
    ],
  );

  // [事务] 配置屏障（config barrier）必须最先 await：它保证“先设置模型、再发送”
  // 的顺序在服务端串行执行。若把屏障放在建会话之后，首发送可能带着旧模型启动，
  // 于是首轮用错模型、第二轮才切换，用户会看到一次莫名其妙的模型跳变。
  // [并发] createSourceAtSend / taskGroupIdAtSend 是同步冻结的创建上下文，
  // 后续 await 期间切页不会改写它们；这是分组归属不错乱的前提。
  // [失败路径] 整个函数不向外抛错：内部把失败转成 Composer 错误态，避免未处理拒绝。
  const dispatchSendTextAfterConfig = useCallback(
    async (
      text: string,
      options: ConversationComposerSendOptions | undefined,
      createSourceAtSend: SessionCreateSource,
      highspeedOriginAtSend: HighspeedPaneOrigin,
      taskGroupIdAtSend?: string | null,
    ) => {
      let onAcceptedSelection: (() => void) | undefined;
      const prepareHighspeedTurn = prepareHighspeedTurnFrom(highspeedOriginAtSend);
      // [权衡] 这里按位置下标改写 dispatchCommand 的参数（9/11/12 位），因为该函数的
      // 参数表已经很长，再包一层对象会牵动所有调用点。风险是签名一变就会错位，
      // 因此只允许在“发送路径的私有包装”里做，且必须紧跟 dispatchCommand 的签名阅读。
      // 改写而不是新增参数，保证所有子路径（斜杠命令、建会话）共享同一份创建上下文。
      const dispatchSubmissionCommand = async (...args: Parameters<typeof dispatchCommand>) => {
        args[9] = createSourceAtSend;
        args[11] = taskGroupIdAtSend;
        args[12] = options?.submittedDraftText ?? text;
        if (
          args[0] === "sendText" &&
          args[2] &&
          baseWorkspaceServices.genUiService &&
          typeof args[1]?.text === "string"
        ) {
          // [失败路径] GenUI 上下文是增强信息，取不到就不附加：它只影响渲染提示，
          // 不能让一次 listState 失败把整条用户消息卡住。错误只进 warn，
          // 发送继续走“无 GenUI 上下文”的普通路径。
          try {
            const context = buildGenUiModelContext(
              await baseWorkspaceServices.genUiService.listState({
                workspacePath,
                workspaceIdentity,
                sessionId: args[2],
              }),
            );
            if (context) args[1] = { ...args[1], text: `${args[1].text}\n\n${context}` };
          } catch {
            // 状态是辅助上下文；读取失败不能阻断既有 CommandInbox 输入路径。
            logger.warn("[gen-ui] Widget context unavailable");
          }
        }
        const ack = await dispatchCommand(...args);
        // 在原 accepted 边界写回推荐选择，早于新 Session 的草稿转移；失败不改用户意图。
        if (ack.status === "accepted" && submissionConfigFromCommand(args[0], args[1]))
          onAcceptedSelection?.();
        return ack;
      };
      // [并发] 从这里开始只用这份同步快照，不再读 Composer/Session：
      // barrier 等待、推荐弹层、建会话都可能跨越数秒，期间用户继续输入或切模型，
      // 回读会让“已经点了发送的那条内容”变成“最新内容”，甚至重复发送。
      // 附件数组与 context 计数同样被冻结，避免上传完成状态在半途改变语义。
      // 进入 barrier 前已经冻结；等待配置/附件期间不再回读 Composer 或 Session。
      let submission = options?.submission ?? null;
      const heldQueueDisposition = options?.heldQueueDisposition;
      const expectedHeldQueueItemIds = options?.expectedHeldQueueItemIds;
      const readyAttachments = options?.attachments ?? [];
      const sharedContextRefs = options?.sharedContextRefs;
      const contextAttachmentCount = options?.contextAttachmentCount ?? 0;
      const slashCommand = parseV4VisibleSlashCommand(text, readyAttachments, {
        contextAttachmentCount,
      });

      // [失败路径] 模型未就绪时返回 blocked 而不是抛错：Composer 会保留文本并展示
      // “正在准备模型”，这是可恢复状态。若抛错，用户会看到红色横幅且输入可能被清空。
      // 该检查必须在 slash 解析之前：否则 /side 可能在没有模型的情况下先建出副屏会话。
      if (!(await ensureDraftModelReadyForSend())) {
        return "blocked" as const;
      }

      // [事务] /side、/btw 只在“已有会话 + CLI 确实暴露该命令”时解析：
      // 草稿态没有父会话可继承，强制解析会创建出无上下文的副屏。
      // enabledCommandNames 用上面的可用集合，保证与补全列表完全一致。
      const selectionSideSlashCommand =
        sessionId &&
        appSlashCommands?.some((command) => command.value === "side" || command.value === "btw")
          ? parseSelectionSideSlashCommand(text, readyAttachments, {
              contextAttachmentCount,
              enabledCommandNames: availableSelectionSideSlashCommandNames,
            })
          : null;
      if (sessionId && selectionSideSlashCommand) {
        const created = await handleOpenSelectionSideConversationWithPrompt(
          selectionSideSlashCommand.text,
          options?.telemetrySeed,
        );
        return created ? ("sent" as const) : ("blocked" as const);
      }
      // [事务] Plan 模式与 goal 互斥，必须在任何建会话/晋升之前拒绝：
      // 一旦先晋升，用户会得到一个“已创建但命令被拒”的空会话，输入也已被清空。
      // 这里只 toast + blocked，不写 sendSubmissionError——用户改模式即可重发。
      if (
        submission?.planEnabled &&
        slashCommand !== null &&
        (slashCommand.kind === "sendGoalCommand" ||
          slashCommand.kind === "resumeGoal" ||
          slashCommand.kind === "emptyGoal" ||
          slashCommand.kind === "unsupportedGoal")
      ) {
        // Plan 模式不能创建、更新或恢复 goal。必须在 draft promotion / command dispatch
        // 之前拒绝，否则即使 CLI 后续拒绝，composer 也会误以为发送成功并清空用户输入。
        toast(intl.formatMessage({ id: "chat.goal.planModeBlocked" }));
        return "blocked" as const;
      }
      // [失败路径] 缺配置直接 blocked 且只 warn：这通常意味着初始化尚未完成，
      // 展示成用户错误没有意义；保留输入让用户稍后重试是唯一正确处置。
      if (!submission) {
        logger.warn("[v4-pane] Submission 缺少完整模型或模式配置");
        return "blocked" as const;
      }
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      if (
        currentRoutingMode === "choice" &&
        !heldQueueDisposition &&
        (slashCommand === null || slashCommand.kind === "sendGoalCommand")
      ) {
        // UI choice 只对普通输入和 /goal <新目标> 生效；/compact 直接追加暂停队列，
        // resumeGoal 等控制命令也不应被发送消息确认框截获。
        return "confirmationRequired" as const;
      }
      // [并发] 套餐推荐是用户可感知的异步弹层，必须在建会话之前完成：
      // 推荐可能返回“取消”，此时不应留下任何 session。chosen !== original 时登记
      // captureAcceptedModelSelection，只有 ACK accepted 才写回选择，避免被拒命令污染。
      // slash 命令优先：已有 session 直接消费；draft 首发 /goal 复用同一个预热会话。
      if (slashCommand === null || slashCommand.kind === "sendGoalCommand") {
        const original = submission.modelSelection;
        const chosen = await recommendStartPlan(original);
        if (!chosen) return "blocked" as const;
        if (chosen !== original) {
          onAcceptedSelection = captureAcceptedModelSelection(chosen, original);
          submission = { ...submission, modelSelection: chosen };
        }
      }
      const prewarmTargetBeforeSend =
        sessionId === null ? prewarmBindingRef.current?.sessionId : null;
      // [事务] 首发前再同步一次草稿权威配置：屏障只能串行化“已入队”的命令，
      // 点击配置时如果预热 session 尚未就绪，那条命令当时没有目标，可能根本没入队。
      // 因此在拿到确定的 prewarmTarget 后再补一次，禁止 UI 新值与 runtime 旧值分叉。
      if (prewarmTargetBeforeSend) {
        // 屏障只保证已经入队的命令完成；若点击配置时预热 session/snapshot 尚未
        // 就绪，命令可能当时没有目标。首发绑定确定的预热 session 前再同步一次
        // 草稿权威配置，禁止 UI 新值与 runtime 旧值分叉。
        await ensureDraftPrewarmConfigBeforeSendRef.current(prewarmTargetBeforeSend);
      }
      // [事务] 已有会话的斜杠命令走独立分发，成功即 return，不再进入 sendText：
      // 否则命令文本会被当成普通消息再发一遍。confirmationRequired 必须原样返回，
      // 由 Composer 弹确认框；把它当“已消费”会让命令静默消失。
      // slash 命令优先：已有 session 直接消费；draft 首发 /goal 先建空会话再发命令。
      // 携带附件或网页元素上下文时不消费为 v4 原生命令（compact/goal 等无附件语义），随 sendText 直发。
      if (sessionId && slashCommand) {
        const consumed = await dispatchSlashCommand(
          slashCommand,
          sessionId,
          snapshotRef.current?.revision,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          onAcceptedSelection?.();
          return;
        }
      }
      // [权衡] 草稿态只把 goal 类命令当斜杠命令：compact 需要已有上下文，
      // 其它命令在空会话里没有意义。emptyGoal/unsupportedGoal 直接就地拒绝，
      // 用 "__draft__" 作为伪目标只是为了复用错误提示通道，不会真的发出去。
      const draftSlashCommand =
        slashCommand?.kind === "sendGoalCommand" ||
        slashCommand?.kind === "resumeGoal" ||
        slashCommand?.kind === "emptyGoal" ||
        slashCommand?.kind === "unsupportedGoal"
          ? slashCommand
          : null;
      if (!sessionId && draftSlashCommand) {
        if (
          draftSlashCommand.kind === "emptyGoal" ||
          draftSlashCommand.kind === "unsupportedGoal"
        ) {
          await dispatchSlashCommand(
            draftSlashCommand,
            prewarmBindingRef.current?.sessionId ?? "__draft__",
            undefined,
            heldQueueDisposition,
            expectedHeldQueueItemIds,
            submission,
          );
          return;
        }
      }
      // [并发] waitForDraftSession 返回的是“同一份”创建任务，所有并发首发（文本、
      // 附件、goal）都等它，因此不会建出两个会话。beginPromotion 是幂等认领：
      // 若预热在等待期间被换代，返回 false 直接抛错，保留草稿让用户重发。
      // Bug 根因：首发曾把 binding=null 当成无预热，绕过 owner 再建一个会话。
      // 文本、附件/context 和 goal 都等待同一创建任务，创建失败或换代直接保留草稿。
      const draftBinding = sessionId === null ? await waitForDraftSession() : null;
      if (draftBinding) {
        await ensureDraftPrewarmConfigBeforeSendRef.current(draftBinding.sessionId);
        if (!draftBinding.beginPromotion()) throw new Error("草稿会话已切换，请重新发送");
      }
      // [事务] targetSessionId 是后续所有步骤的唯一目标：一旦认领成功就必须用
      // draftBinding 的 sessionId，而不能重新读 sessionId（此时它仍为 null）。
      // 非空断言是安全的，因为 draftBinding 为 null 时 sessionId 必非 null。
      const targetSessionId = sessionId ?? draftBinding!.sessionId;
      // [事务] 草稿首发若被识别为 goal 命令，先发命令再 promote：promote 会把草稿
      // 转成正式会话并触发宿主切页，必须等命令已 accepted。顺序反了会出现
      // “页面已切到新会话、命令还在旧草稿上”的悬挂状态。
      // 只有 consumed 为真才 promote；confirmationRequired 直接返回，草稿保持原样。
      if (draftBinding && draftSlashCommand) {
        const consumed = await dispatchSlashCommand(
          draftSlashCommand,
          targetSessionId,
          0,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
          (messageId) => reportDraftCreated(targetSessionId, createSourceAtSend, messageId),
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          draftBinding.promote();
          await handleDraftSessionCreated(
            targetSessionId,
            createSourceAtSend,
            undefined,
            taskGroupIdAtSend,
          );
          return;
        }
      }
      // admission 写出后的失败或 transport error 不能证明 CLI 没有执行；保留原 binding
      // 的 pending 生命周期，交给 Composer 保留输入，禁止自动换会话/command 重发。
      // 附件 ref 已在 composer 预传状态机中收口。
      const highspeed = await prepareHighspeedSendContext(
        targetSessionId,
        prepareHighspeedTurn,
        submission.modelSelection,
      );
      // [事务] payload 用条件展开拼装而不是先建对象再删键：
      // 服务端用“字段是否存在”区分“未指定”和“显式空值”，传 undefined 会被序列化层
      // 保留成 null，语义完全不同。特别是 requestedDelivery 出现两次是有意的，
      // 后者补丁保证“已有会话 + 立即发送”走原子 stop+start，而不是队列中间态。
      const ack = await dispatchSubmissionCommand(
        "sendText",
        {
          text,
          ...submission,
          ...(options?.requestedDelivery ? { requestedDelivery: options.requestedDelivery } : {}),
          conversationQuotes: options?.conversationQuotes,
          ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
          ...(sessionId && options?.requestedDelivery
            ? {
                // Bug 根因：立即发送曾先投影 QueueItem，再等待二次
                // sendQueuedNow，导致队列中间态外泄且输入框延迟清空。现在由
                // CLI 原子 stop + start，accepted ACK 即是 Composer 清空边界。
                requestedDelivery: options.requestedDelivery,
              }
            : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
          ...(options?.source ? { source: options.source } : {}),
          ...highspeed.override,
        },
        targetSessionId,
        undefined,
        undefined,
        options?.telemetrySeed,
        highspeed.acceleratedCard,
        options?.onCommandCreated
          ? (envelope) => {
              if (envelope.type === "sendText") options.onCommandCreated?.(envelope.commandId);
            }
          : undefined,
        undefined,
        undefined,
        // Recent 记录加速前的 Composer 原始选择，不用被覆盖的 payload Selection。
        submission,
      );
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired" as const;
      }
      if (ack.status !== "accepted") {
        if (
          ack.reasonCode === "modelUnavailable" &&
          highspeed.acceleratedCard &&
          highspeed.override.modelExecution?.selectionFallback
        ) {
          // [事务] 作废键含 commandId 与 cardId：同一条命令重试、同一张卡再次失败
          // 都应是不同的 claim，不能被去重吞掉；而同一失败事件的重复回调只算一次。
          // 返回 blocked 而不是抛错，是为了走 Composer 的“恢复正文与附件”路径。
          // Bug 根因：Highspeed 与退回模型都不可用时，准入拒绝曾按普通发送异常处理，
          // Composer 虽保留输入，但卡仍锁住模型选择且显示无助于恢复的错误。作废 Service
          // 持有的同一张卡，并返回 blocked，让 Composer 的提交事务恢复正文和附件。
          setSendSubmissionError(null);
          invalidateActiveHighspeedCard(
            highspeed.acceleratedCard.cardId,
            `admission:${ack.commandId}:${highspeed.acceleratedCard.cardId}`,
          );
          return "blocked" as const;
        }
        // [失败路径] 这里必须抛：调用方据此把 ack.reasonCode 转成错误横幅或
        // Composer 的确认态。若在这里吞掉，Composer 会收到 undefined 并误判为 sent。
        throw new Error(ack.reasonCode ?? "sendText 被拒绝");
      }
      // [事务] accepted 之后才 promote 与上报创建：这是“草稿真正变成会话”的唯一时刻。
      // commandId 必须作为 messageId 传给埋点，否则 completion 漏斗缺关联键；
      // 预热空创建不会走到这里，因此计数不会重复。
      // [失败路径] handleDraftSessionCreated 内部已吞掉组织失败，这里无需 try。
      if (draftBinding) {
        // 合并后普通首发漏传 commandId；只在 accepted 边界统计，避免预热空创建重复计数。
        draftBinding.promote();
        await handleDraftSessionCreated(
          targetSessionId,
          createSourceAtSend,
          ack.commandId,
          taskGroupIdAtSend,
        );
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
    },
    [
      dispatchCommand,
      recommendStartPlan,
      baseWorkspaceServices,
      captureAcceptedModelSelection,
      dispatchSlashCommand,
      ensureDraftModelReadyForSend,
      availableSelectionSideSlashCommandNames,
      appSlashCommands,
      handleDraftSessionCreated,
      reportDraftCreated,
      handleOpenSelectionSideConversationWithPrompt,
      invalidateActiveHighspeedCard,
      intl,
      prepareHighspeedTurnFrom,
      resolveInitialDraftConfig,
      createSubmissionFromComposer,
      sessionId,
      settleCurrentQueueInputs,
      waitForDraftSession,
    ],
  );

  // [事务] dispatchSendText 是 Composer 的唯一发送入口，三层顺序不能动：
  // 1) 同步取 createSource / submission / highspeedOrigin / taskGroupId（必须最早）；
  // 2) enqueue 到 configCommandBarrier（串行化配置与发送）；
  // 3) 在 barrier 内调用 dispatchSendTextAfterConfig 并统一收口异常。
  // [并发] submission 若由调用方提供则不重算：编辑队列项重发时，配置必须保持“原来那条”
  // 的语义，重算会把它换成用户当前的模型，静默改写了历史消息的执行条件。
  const dispatchSendText = useCallback(
    (text: string, options?: ConversationComposerSendOptions) => {
      const createSource = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource;
      const submissionOptions = {
        ...options,
        submission:
          options?.submission === undefined ? createSubmissionFromComposer() : options.submission,
      };
      // [并发] 起点冻结必须发生在 enqueue 之前，而不是 barrier 回调内部：
      // enqueue 可能因为前一条命令未完成而排队数秒，回调执行时用户早已切走。
      // taskGroupId 同理，草稿分组在发送瞬间确定，排队期间新建分组不应影响本轮。
      // 进入配置屏障前冻结 Highspeed 发送起点；屏障与后续 await 期间用户可能切换 Task。
      const highspeedOrigin = captureHighspeedPaneOrigin();
      const taskGroupId =
        sessionId === null
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .draftTaskGroupId
          : undefined;
      // followupMode 仍通过 Session CAS 同步；模型和模式已封装进 Submission，不再
      // 依赖“配置命令先到、sendText 后到”的跨命令时序。
      // [事务] barrier 的返回值就是发送结果的三态；它不吞异常，异常由下面的 catch
      // 统一翻译成 blocked 或继续上抛。barrier 本身保证“配置命令 → sendText”的
      // 相对顺序，即使两条命令来自不同点击也能串行。
      return configCommandBarrier.enqueue(async () => {
        try {
          return await dispatchSendTextAfterConfig(
            text,
            submissionOptions,
            createSource,
            highspeedOrigin,
            taskGroupId,
          );
        } catch (error) {
          // [失败路径] 这是“UI 预检通过、但 Host 侧 registry 已失效”的竞态窗口：
          // 收敛成 `markDraftProviderNotReady()` 的正常等待态，不走错误横幅，用户只需重试。
          // 只对草稿生效：既有会话的模型不可用需要真实报错，不能静默 blocked。
          if (sessionId === null && isProviderNotReadyError(error)) {
            // UI 预检查与 Host getClient 之间 registry 仍可能失效。竞态命中时收敛成
            // 同一个正常等待态，不走异常发送路径，也不清空 composer。
            markDraftProviderNotReady();
            return "blocked" as const;
          }
          throw error;
        }
      });
    },
    [
      captureHighspeedPaneOrigin,
      configCommandBarrier,
      createSubmissionFromComposer,
      dispatchSendTextAfterConfig,
      markDraftProviderNotReady,
      sessionId,
      workspacePath,
      workspaceIdentity,
    ],
  );

  // [资源] 滚动到底部通过 ref 调用 Timeline 的内部方法，而不是自己操作 DOM：
  // 时间线可能有虚拟化/动画，直接 scrollTop 会跳错位置。ref 由 Timeline 挂载时赋值，
  // 这里只做一次可选调用，卸载后自然失效。
  const focusTimelineToLatest = useCallback(() => {
    timelineScrollToBottomRef.current?.();
  }, []);

  // [事务] handleSendText 是 Composer 回调的最终形态，负责“结果翻译”而不负责发送：
  // 成功 → 清本地提交错误、按需滚到底；blocked/confirmationRequired → 原样返回让
  // Composer 保留输入；异常 → 收口成 pane-local 错误并继续抛，保证 Composer 不误清。
  // [失败路径] 首发前 switchModelConfig 失败不会产生 snapshot.control.lastError，
  // 若不在这里落一条本地错误，用户看到的就是“点击没反应”。
  const handleSendText = useCallback(
    async (
      text: string,
      options?: ConversationComposerSendOptions,
    ): Promise<ConversationComposerSendResult> => {
      // [并发] 焦点决策必须在 await 之前算好：ACK 返回时 projection 可能已经切到 running，
      // 那时再读 inputRouting.mode 得到的不是“刚提交这条”的模式，
      // 会把“排队发送”误判成“立即发送”，滚动行为随之出错。
      // 发送前冻结本次 admission 预期：command ACK 回来时 projection 可能已经切到 running，
      // 不能用更新后的 enqueue mode 反推刚提交的 prompt 是否原本立即发送。
      const shouldFocusLatest = shouldFocusTimelineAfterComposerSend({
        draftMode: sessionId === null,
        inputRoutingMode: snapshotRef.current?.inputRouting.mode ?? null,
        heldQueueDisposition: options?.heldQueueDisposition,
      });
      try {
        const sendResult = await dispatchSendText(text, options);
        if (sendResult === "blocked" || sendResult === "confirmationRequired") {
          return sendResult;
        }
        setSendSubmissionError(null);
        if (shouldFocusLatest) {
          focusTimelineToLatest();
        }
        return "sent";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const runtimeModelUnavailable = detail.includes("provider.notInRegistry");
        // 首发前 switchModelConfig 失败只会抛回 Composer；Composer 为了保留草稿
        // 仅写日志，不会生成 snapshot.control.lastError，用户看到的结果就是“点击没反应”。
        // 这里把 admission 前失败收口为 pane-local 错误横幅，不改变 desktop continuous 或
        // Web remote replayable 的发送/恢复语义，草稿仍由 Composer 原路径保留。
        setSendSubmissionError({
          code:
            getRemoteConnectionFailureCode(error) ??
            (runtimeModelUnavailable ? "ZCODE_RUNTIME_MODEL_UNAVAILABLE" : "SEND_FAILED"),
          message: runtimeModelUnavailable
            ? detail
            : intl.formatMessage({ id: "chat.error.sendFailed" }),
          detail,
          ...(sessionId ? { taskId: sessionId } : {}),
        });
        throw error;
      }
    },
    [dispatchSendText, focusTimelineToLatest, intl, sessionId],
  );
  // 上面那个 ref 的唯一赋值点（见 handleSendWorkflowSaveRequest 的说明）。
  sendTextRef.current = handleSendText;

  // [并发] Composer 通过这个回调把“是否有内容/是否忙”写进 ref，而不是提升成 state：
  // 发送与停止路径需要跨 await 读它，但 UI 不需要因它重渲染（Composer 自己已渲染）。
  // 空依赖是安全的：写入目标是稳定 ref，不捕获任何会变化的闭包变量。
  const handleComposerDraftStateChange = useCallback(
    (state: { hasContent: boolean; busy: boolean }) => {
      composerDraftStateRef.current = state;
    },
    [],
  );
  // [事务] 清锁必须同时清 ref 与 state：只清 state 会让并发的 ACK 仍看到旧锁并跳过恢复，
  // 只清 ref 则 Composer 永远保持 disabled。这是队列编辑事务唯一的释放点，
  // 成功、失败、被取代三条路径都必须经过它。
  const clearQueueEditOperation = useCallback(() => {
    queueEditOperationRef.current = null;
    setQueueEditOperation(null);
  }, []);
  // [事务] 回执带 requestId，只有“当前请求就是我”时才清空：用户可能连续触发两次恢复，
  // 第一次的迟到回执不能把第二次的请求清掉，否则第二次草稿永远不落地。
  // 无论是否命中都清锁：锁代表“本次编辑事务”，Composer 应用完就该解除，
  // 即使请求已被取代，也不应让界面停在 disabled。
  const handleComposerRestoreApplied = useCallback(
    (requestId: number) => {
      setComposerRestoreRequest((current) => (current?.requestId === requestId ? null : current));
      clearQueueEditOperation();
    },
    [clearQueueEditOperation],
  );
  // [并发] 按 cardId 消费：迟到的旧卡回调不能清掉新卡的激活请求，
  // 否则用户切回新卡时不会播放入场动效。只清“同一个 id”是这里唯一的条件。
  const handleHighspeedActivationApplied = useCallback((cardId: string) => {
    // 按 cardId 消费：迟到的旧卡回调不能清掉新卡的激活请求。
    setHighspeedActivationCardId((current) => (current === cardId ? null : current));
  }, []);

  // [事务] fork 是 CAS 命令：baseRevision/logEpoch 取“点击瞬间”的投影，
  // 不能在 ACK 后再取（那时已经多了一条 child）。accepted/duplicate 都表示已创建，
  // 用 ack.result.sessionId 原地切走；其它状态只 warn，不做本地乐观切换——
  // 切到不存在的 child 会让 pane 进入永久加载态。
  const handleFork = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // forkAssistant 是 CAS 命令：baseRevision 取当前投影 revision。
      void dispatchCommand(
        "forkAssistant",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          logger.warn(`[v4-pane] fork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          return;
        }
        if (ack.result?.type === "forkAssistant") {
          // 原地切到 child session（与新建会话同一选择路径）。
          onSessionCreated?.(ack.result.sessionId);
        }
      });
    },
    [dispatchCommand, onSessionCreated, sessionId],
  );

  // [事务] 行内编辑是完整的 CAS 写事务，顺序不可换：
  // 1) 先判空内容（含附件/引用），避免发出一次必然无意义的 edit；
  // 2) 再 prepare Highspeed（可能 await 抽卡），期间 session 可能被切走；
  // 3) 因此必须重读 latest 并校验 sessionId，不能沿用 prepare 前的 revision；
  // 4) 最后用 latest.revision/logEpoch 发送，保证 CAS 针对“当前这一版”生效。
  // [权衡] attachments 只在显式传入时才写 payload：undefined 表示“保留原附件”，
  // 空数组表示“用户删光了”；把两者合并会让用户无法删除全部附件。
  const handleEdit = useCallback(
    async (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
      workspaceMode: "preserve" | "rewind" = "preserve",
      conversationQuotes?: import("@zcode/shared").ConversationSelectionText[],
    ) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      if (
        !newText.trim() &&
        (!attachments || attachments.length === 0) &&
        !conversationQuotes?.length
      ) {
        logger.warn("[v4-pane] edit 跳过：行内编辑内容为空且无附件");
        return false;
      }
      // [并发] 起点在 prepare 之前同步冻结，但这里关心的是“prepare 期间是否换了会话”：
      // 两个判断都要做，因为 origin 决定卡是否呈现，latest.sessionId 决定编辑是否还能发。
      // 换会话时直接返回 false，保留行内编辑器内容，让用户在新会话里重新决定。
      const highspeed = await prepareHighspeedSendContext(
        sessionId,
        prepareHighspeedTurnFrom(captureHighspeedPaneOrigin()),
      );
      const latest = snapshotRef.current;
      if (!latest || latest.sessionId !== sessionId) {
        logger.warn("[v4-pane] edit 跳过：Highspeed prepare 后 session 已切换");
        return false;
      }
      const ack = await dispatchCommand(
        "editUserQuery",
        {
          target,
          newText,
          workspaceMode,
          conversationQuotes,
          // editUserQuery 的 attachments 缺省表示保留 canonical 原附件；
          // 只有显式透传 []，CLI 才能区分“用户删除全部”与“调用方未修改附件”。
          ...(attachments ? { attachments: [...attachments] } : {}),
          ...highspeed.override,
        },
        sessionId,
        latest.revision,
        latest.logEpoch,
        undefined,
        highspeed.acceleratedCard,
      );
      // [失败路径] 拒绝时返回 false 而不是抛错：行内编辑器据此保持打开并展示冲突提示。
      // 抛错会把整个 Timeline 的错误边界拉起来，用户会失去正在编辑的文本。
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        logger.warn(`[v4-pane] edit 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        return false;
      }
      // fork ACK 只做旧协议解码兼容；新 edit 永不导航 child。blocked 由行内冲突弹窗处理。
      return ack;
    },
    [captureHighspeedPaneOrigin, dispatchCommand, prepareHighspeedTurnFrom, sessionId],
  );

  // [事务] retry 单独抽出而不是内联，是为了“throw 版”和“void 版”两条调用路径共用：
  // 行内按钮走 fire-and-forget 并只记 warn，其它入口可能需要拿到 CommandAck 做后续。
  // 缺投影时抛错而不是返回 null，避免调用方误以为重试已提交。
  const dispatchRetryTurn = useCallback(
    async (target: ConversationRowTarget): Promise<CommandAck> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) {
        throw new Error("retryTurn 缺少当前 session 投影");
      }
      // retryTurn 是 CAS 命令：baseRevision 取当前投影 revision。
      return dispatchCommand(
        "retryTurn",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  // [失败路径] retry 是“用户点一下就该有反应”的动作，但失败无需横幅：
  // 投影不变本身已经说明没有新回合，warn 日志足够定位。catch 必须显式挂上，
  // 否则 dispatchCommand 的异常会变成未处理 Promise 拒绝。
  const handleRetry = useCallback(
    (target: ConversationRowTarget) => {
      void dispatchRetryTurn(target)
        .then((ack) => {
          if (ack.status !== "accepted") {
            logger.warn(`[v4-pane] retry 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
        })
        .catch((error: unknown) => {
          logger.warn("[v4-pane] retry 提交失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [dispatchRetryTurn],
  );

  // [事务] 反馈是 CAS 写命令，必须带 revision/logEpoch：同一条助手消息可能正在被
  // 另一处修改（例如重新生成），不带 CAS 会覆盖新内容。返回布尔而不是抛错，
  // 行内按钮据此回滚本地选中态；duplicate 也算成功，避免重复点击后图标跳回。
  const handleAssistantFeedback = useCallback(
    async (
      target: ConversationRowTarget,
      feedback: "like" | "dislike" | null,
    ): Promise<boolean> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      const ack = await dispatchCommand(
        "setAssistantFeedback",
        { target, feedback },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      const accepted = ack.status === "accepted" || ack.status === "duplicate";
      if (!accepted) {
        logger.warn(`[v4-pane] assistant 反馈被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
      return accepted;
    },
    [dispatchCommand, sessionId],
  );

  // [事务] 删除队列项前先记下 sourceCommandId，成功后把它从 pending 账本结清：
  // 否则这条命令会永远停留在“可能已送达”，恢复横幅一直提示用户重发。
  // noop 视为成功：条目可能已被别的 pane 删掉，账本仍需结清（幂等）。
  const handleDeleteQueueItem = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      const sourceCommandId = current.queue.items.find(
        (item) => item.queueItemId === queueItemId,
      )?.sourceCommandId;
      void dispatchCommand("deleteQueueItem", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] deleteQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
            return;
          }
          if (sourceCommandId) pendingCommandRegistry.settle(sessionId, sourceCommandId);
        },
      );
    },
    [dispatchCommand, sessionId],
  );

  // [事务] 撤回编辑是本文件最完整的“删除 + 恢复”事务，五道门缺一不可：
  // 1) 传入时 queueEditOperationRef 非空 → 已有事务在途，直接返回（INV-13）；
  // 2) Composer 有内容/正忙 → 拒绝并提示，避免覆盖用户未发送的编辑；
  // 3) resolveQueuedComposerRestore 失败 → 条目不可编辑（compact/已消失）；
  // 4) 先登记操作锁，再 await 删除，保证并发点击只有一个能进入；
  // 5) ACK 后校验 composerBinding，pane 已切走则只删不恢复（INV-12）。
  // [失败路径] 删除被拒或抛错时都要 clearQueueEditOperation + toast，
  // 否则 Composer 永久 disabled，用户只能刷新页面。
  const handleEditQueueItem = useCallback(
    async (queueItemId: string): Promise<void> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null || queueEditOperationRef.current) return;
      // [权衡] 有草稿内容时不做“合并”而是直接拒绝：把队列项追加到现有草稿会产生
      // 一条用户没写过的混合消息，且无法再拆回原来的队列项。提示用户先清空再撤回。
      // busy 也拒绝：正在发送的 Composer 无法接收恢复请求，接受后会被静默丢弃。
      if (composerDraftStateRef.current.hasContent || composerDraftStateRef.current.busy) {
        toast(intl.formatMessage({ id: "chat.queue.editDraftConflict" }));
        return;
      }
      const restoreTarget = resolveQueuedComposerRestore(current, queueItemId);
      if (!restoreTarget) {
        logger.warn(`[v4-pane] queue 撤回编辑跳过：queue item 不存在或不可编辑 ${queueItemId}`);
        return;
      }
      // [并发] 锁在 await 之前落库（ref 立即、state 下一帧）：两次快速点击撤回时，
      // 第二次会在第一行判断就被 ref 挡下，不会发第二次 delete。
      // operation 携带 sessionId/workspaceKey，供 ACK 后判断事务归属是否仍有效。
      const operation = { queueItemId, sessionId, workspaceKey };
      queueEditOperationRef.current = operation;
      setQueueEditOperation(operation);
      try {
        const ack = await dispatchCommand(
          "deleteQueueItem",
          { queueItemId },
          sessionId,
          restoreTarget.baseRevision,
        );
        // [失败路径] 非 accepted/duplicate 时队列项仍在，因此什么都不能恢复：
        // 既不能清账本，也不能改写草稿。提示“撤回失败”并立即释放锁，
        // 让用户可以重试或改用“立即发送”。
        if (!shouldRestoreQueuedComposerFromAck(ack.status)) {
          logger.warn(`[v4-pane] queue 撤回编辑被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
          clearQueueEditOperation();
          return;
        }
        pendingCommandRegistry.settle(sessionId, restoreTarget.sourceCommandId);
        // [并发] 这是 INV-12 的判定点：删除已经在服务端生效（不能撤销），
        // 但本地恢复必须绑定到“发起时的 Composer”。session/workspace 任一不同，
        // 恢复就会把旧会话的文本写进新任务，因此只保留删除结果、放弃恢复。
        const currentBinding = composerBindingRef.current;
        if (
          currentBinding.sessionId !== sessionId ||
          currentBinding.workspaceKey !== workspaceKey
        ) {
          // delete ACK 异步返回时 pane 可能已切 task；旧实现若直接 setText，
          // 会把原 session 的 queue payload 写进新 task。权威删除保留，但本地恢复必须放弃。
          logger.warn("[v4-pane] queue 撤回编辑未恢复：ACK 返回前 composer 已切换", {
            queueItemId,
            sessionId,
            workspaceKey,
          });
          clearQueueEditOperation();
          return;
        }
        // [事务] 恢复请求带自增 id 与完整绑定信息：Composer 侧再用 session/workspace
        // 做一次兜底校验，防止“请求已入队、绑定在下一帧才更新”的窗口。
        // config 可能为空对象，必须原样传，表示“不覆盖当前配置”。
        setComposerRestoreRequest({
          requestId: nextComposerRestoreRequestIdRef.current++,
          sessionId,
          workspaceKey,
          inputKind: restoreTarget.inputKind,
          text: restoreTarget.text,
          attachments: restoreTarget.attachments,
          config: restoreTarget.config,
        });
      } catch (error) {
        logger.warn("[v4-pane] queue 撤回编辑命令失败", error);
        toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
        clearQueueEditOperation();
      }
    },
    [clearQueueEditOperation, dispatchCommand, intl, sessionId, workspaceKey],
  );

  // [事务] 立即发送比普通发送多一层“刷新卡”逻辑，因为队列项可能已经排了很久：
  // 原卡可能过期或 runtime 已释放，必须在提升前重新 prepare 一次。
  // [权衡] 刷新只接受“同一张卡”的 override：服务若返回不同卡，说明原意图已失效，
  // 此时不带 override 发送（普通模型执行），而不是悄悄把用户绑到另一张卡上。
  // [并发] 起点在点击瞬间冻结，prepare 之后必须重读队列项与 revision，
  // 队列可能在等待期间被别的 pane 删除或重排。
  const handleSendQueuedNow = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // 用户明确点击“立即发送”时，视觉意图等价于点击“滚动到底部”；command 的
      // reserve/stop/promote 生命周期仍由 CLI 裁决，不把滚动状态混入协议。
      focusTimelineToLatest();
      const highspeedOrigin = captureHighspeedPaneOrigin();
      void (async () => {
        const queueItem = current.queue.items.find((item) => item.queueItemId === queueItemId);
        let highspeedOverride: HighspeedSendContext["override"] = {};
        if (queueItem?.highspeed && queueItem.highspeed.expiresAt > Date.now()) {
          const refreshed = await prepareHighspeedSendContext(
            sessionId,
            prepareHighspeedTurnFrom(highspeedOrigin),
            queueItem.modelSelection,
          );
          // Bug 原因：CLI 暂存 runtime 可能跨异步边界缺失；手动提升时补充同一张卡的
          // 新 runtime。若服务返回了不同卡，不得把原队列意图悄悄改绑到另一张卡。
          if (refreshed.acceleratedCard?.cardId === queueItem.highspeed.cardId) {
            highspeedOverride = refreshed.override;
          }
        }
        // [并发] 三重校验：快照存在、仍属于同一 session、队列项仍在。
        // 任一不满足就返回 null，调用方据此不发送；用 latest.revision 而不是
        // 点击时的 revision，保证 CAS 针对当前队列状态。
        const latest = snapshotRef.current;
        const latestQueueItem = latest?.queue.items.find(
          (item) => item.queueItemId === queueItemId,
        );
        if (!latest || latest.sessionId !== sessionId || !latestQueueItem) {
          logger.warn("[v4-pane] sendQueuedNow 跳过：Highspeed prepare 后队列状态已变化", {
            queueItemId,
          });
          return null;
        }
        return dispatchCommand(
          "sendQueuedNow",
          { queueItemId, ...highspeedOverride },
          sessionId,
          latest.revision,
        );
      })().then((ack) => {
        if (!ack) return;
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] sendQueuedNow 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [
      captureHighspeedPaneOrigin,
      dispatchCommand,
      focusTimelineToLatest,
      prepareHighspeedTurnFrom,
      sessionId,
    ],
  );

  // [事务] 重排同样走 CAS：不带 revision 的重排在并发编辑下会把队列拧成两份顺序。
  // noop 视为成功（条目已不在原位置），accepted 才算真正移动；失败只 warn，
  // 因为下一次投影会回到权威顺序，不需要用户处理。
  const handleReorderQueueItem = useCallback(
    (queueItemId: string, beforeQueueItemId: string | null) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      void dispatchCommand(
        "reorderQueueItem",
        { queueItemId, beforeQueueItemId },
        sessionId,
        current.revision,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] reorderQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // [事务] 恢复队列必须带上当前 revision 做 CAS：暂停期间另一处可能已经改过队列，
  // 不带 CAS 的“恢复”会把期间新增/删除的项一起放行。已自动排空或队列为空时
  // 直接返回，避免一次无意义的命令写入与 ack 噪音。
  const handleResumeQueue = useCallback(async () => {
    const current = snapshotRef.current;
    if (!sessionId || !current || current.queue.autoDrain || current.queue.items.length === 0) {
      return;
    }
    const ack = await dispatchCommand(
      "setAutoDrain",
      { autoDrain: true },
      sessionId,
      current.revision,
    );
    if (ack.status !== "accepted" && ack.status !== "noop") {
      logger.warn(`[v4-pane] 恢复暂停队列被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
    }
  }, [dispatchCommand, sessionId]);

  // 配置面 CAS 命令的 stale 重试。模型→思考深度→模式连续操作时，前一条命令的
  // revision bump 可能尚未回流到本地投影，直接用本地 revision 会被 CAS 判 stale。
  // stale ack 带 revisionAtDecision（CLI 当前 revision），用它重试即可收敛（有界 3 次）。
  // m5：目标 = effective session（已绑定会话或草稿预热会话）；投影必须与目标
  // 同源（snapshot.sessionId 校验），防止预热切换瞬间用错 revision。
  const dispatchConfigCas = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      options?: { initialBaseRevision?: number; targetSessionId?: string },
    ): Promise<CommandAck | null> => {
      const targetSessionId =
        options?.targetSessionId ?? sessionId ?? prewarmBindingRef.current?.sessionId ?? null;
      const current = snapshotRef.current;
      if (!targetSessionId) {
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "skipped",
          reasonCode: "no-session",
          at: Date.now(),
        });
        return null;
      }
      // draft 预热会话已经创建、snapshot 尚未投影时，旧逻辑直接跳过
      // 配置 CAS；首发随后沿用 runtime 的 build 缺省。CAS 本身支持 stale revision
      // 回包重试，因此无 snapshot 时从 0 起步也能确定收敛，不能把“未投影”当成功。
      // [事务] baseRevision 的三级来源：调用方显式指定 > 同源投影 > 0。
      // 取 0 不是“猜”，而是让 CAS 用 stale 回包把权威 revision 带回来；
      // 直接把“尚未投影”当成功会让首发沿用 runtime 缺省配置，静默丢失用户选择。
      let baseRevision =
        options?.initialBaseRevision ??
        (current?.sessionId === targetSessionId ? current.revision : 0);
      // [失败路径] lastAck 保存最后一次 stale 回包：重试耗尽后返回它，
      // 调用方能看到“确实是 stale”而不是 null，从而走冲突提示而非“无响应”。
      let lastAck: CommandAck | null = null;
      try {
        // [事务] 有界重试且只对 stale 重试：accepted/noop 立即返回，其它拒绝立即返回。
        // 每次 stale 都用服务端给出的 revisionAtDecision 作为下一轮基准，
        // 而不是本地投影的 revision——后者可能仍落后，会连续 stale 到耗尽次数。
        // 3 次上限覆盖“模型→思考深度→模式”连续点击的典型突刺，再多说明存在别的写入方。
        for (let attempt = 0; attempt < 3; attempt++) {
          const ack = await dispatchCommand(type, payload, targetSessionId, baseRevision);
          lastAck = ack;
          if (ack.status === "stale") {
            baseRevision = ack.revisionAtDecision;
            continue;
          }
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] ${type} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
          return ack;
        }
        // [失败路径] 耗尽重试不抛错，只 warn 并返回最后一次 stale：
        // 配置类命令失败不应阻断用户继续输入，下一次点击会重新发起。
        logger.warn(`[v4-pane] ${type} 连续 stale，放弃重试`);
        return lastAck;
      } catch (error) {
        if (isProviderNotReadyError(error)) {
          // provider readiness 竞态被配置 CAS 吞成 null 后，首发会改写成
          // missing-ack，草稿页无法恢复成模型配置引导。确定性启动门禁必须原样上抛。
          throw error;
        }
        // 生产 renderer 日志关闭，异常也进 ack 调试缓冲，避免静默丢失。
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "dispatch-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        logger.warn(`[v4-pane] ${type} 失败: ${String(error)}`);
        return null;
      }
    },
    [dispatchCommand, sessionId],
  );
  // [事务] 首发前的配置补齐只补“会话级行为设置”（followupMode），
  // 模型与模式属于本次 Submission，随 sendText 一起原子提交：通过 CAS 预改写
  // 共享 Session 会让同一会话里其它 pane 的下一次发送继承到不属于它的选择。
  // [失败路径] 任一配置未在首发前 accepted/noop/duplicate 收敛就抛错，
  // 由调用方 restore 输入并提示，绝不带着半份配置发送。
  const ensureDraftPrewarmConfigBeforeSend = useCallback(
    async (targetSessionId: string) => {
      // followupMode 仍是 Session 行为设置；模型与模式属于本次 Submission，随 sendText
      // 原子提交，不能在发送前通过 CAS 改写共享 Session。
      const desiredConfig = buildDraftCreateConfigPayload(
        draftConfigRef.current,
        appFollowupMode,
      ).config;
      if (!desiredConfig) return;
      const projectedConfig =
        snapshotRef.current?.sessionId === targetSessionId ? snapshotRef.current.config : null;

      // [事务] duplicate 也算收敛：命令此前已生效，重复发送不改变配置。
      // missing-ack（null）是最危险的情况——我们不知道服务端是否收到，
      // 因此按失败处理，宁可让用户重试，也不带着未知配置发送。
      const requireAcceptedConfigAck = (type: CommandType, ack: CommandAck | null) => {
        if (
          ack &&
          (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate")
        ) {
          return;
        }
        throw new Error(
          `${type} 未在首发前收敛: ${ack?.status ?? "missing-ack"} ${ack?.reasonCode ?? ""}`,
        );
      };

      if (
        desiredConfig.followupMode &&
        desiredConfig.followupMode !== projectedConfig?.followupMode
      ) {
        const ack = await dispatchConfigCas(
          "setFollowupMode",
          { mode: desiredConfig.followupMode },
          { targetSessionId },
        );
        requireAcceptedConfigAck("setFollowupMode", ack);
      }
    },
    [appFollowupMode, dispatchConfigCas, draftConfigRef],
  );
  // [并发] 每帧把最新实现写进 ref，而不是用 effect：发送路径在 await 配置补齐时
  // 会调用 ref.current，若用 effect 更新，首帧发送可能拿到 no-op 占位实现，
  // 导致 followupMode 没补上就发出首条消息。
  ensureDraftPrewarmConfigBeforeSendRef.current = ensureDraftPrewarmConfigBeforeSend;

  // [事务] followupMode 同步是“设置 → 会话”的单向投影，必须满足四个前提：
  // 有目标会话（含预热）、app 有值、投影已就绪且与目标同源。缺任何一条都不写，
  // 否则会把上一个会话的 revision/值写进新会话。
  // syncKey 含 revision：同一次设置变更在 revision 前进后允许再同步一次，
  // 用于修复“设置已改但上一条命令丢失”的情况；synced 后缀表示已一致，直接短路。
  const followupModeSyncKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const targetSessionId = sessionId ?? prewarmSessionId;
    if (!targetSessionId || !appFollowupMode || snapshotRevision === null) return;
    if (snapshotSessionId !== targetSessionId) return;
    if (snapshotFollowupMode === appFollowupMode) {
      followupModeSyncKeyRef.current = `${targetSessionId}:${appFollowupMode}:synced`;
      return;
    }
    const syncKey = `${targetSessionId}:${appFollowupMode}:${snapshotRevision}`;
    if (followupModeSyncKeyRef.current === syncKey) return;
    followupModeSyncKeyRef.current = syncKey;
    // 交互行为的用户事实源是 app 设置页；v4 投影 followupMode 只是
    // CLI/runtime 同步结果。这里把设置变更补发成既有 setFollowupMode 命令，
    // 避免 composer 再暴露一个同义“追加模式”入口造成上下游分叉。
    // [并发] 走 configCommandBarrier 而不是直接 dispatch：用户可能在设置页改完
    // followupMode 立刻回到 Composer 点发送，同步命令必须排在 sendText 之前，
    // 否则首发会以旧 followupMode 启动，首轮行为与设置不一致。
    void configCommandBarrier.enqueue(() =>
      dispatchConfigCas("setFollowupMode", { mode: appFollowupMode }),
    );
  }, [
    appFollowupMode,
    configCommandBarrier,
    dispatchConfigCas,
    prewarmSessionId,
    sessionId,
    snapshotFollowupMode,
    snapshotRevision,
    snapshotSessionId,
  ]);

  // Composer 选择表达“下一次提交”。点击只更新 renderer intent；Session Selection
  // 在 Submission 真正开跑（Guide 为下一次 model-step）时由 CLI/Core 更新。
  const handleSelectModel = useCallback(
    (
      modelProvider: string,
      model: string,
      sourceModel: ModelSelectionSource | null,
      reasoningLevel?: string,
    ) => {
      // 加速卡在本轮已把 Selection 锁定成卡上模型，选型菜单此时不可用；仍有快捷键
      // 或竞态调用进来时明确提示，不能静默把草稿改成另一个模型。
      if (activeHighspeedCard) {
        toast(intl.formatMessage({ id: "chat.highspeed.modelLocked" }));
        return;
      }
      const resolvedProvider =
        modelProvider || draftConfigRef.current.provider || sourceModel?.provider || "";
      logger.debug("[v4-pane] onSelectModel", {
        modelProvider: resolvedProvider,
        model,
        branch: "composer-submission-intent",
      });
      handleDraftSelectModel(resolvedProvider, model, reasoningLevel);
    },
    [activeHighspeedCard, draftConfigRef, handleDraftSelectModel, intl],
  );

  // 思考深度与模型同属 Submission intent：这里只转交 draft 控制层，
  // 不直接发 setConfig——直接发会让“切模型 + 切深度”变成两条独立的 CAS 写，
  // 中途被拒时用户会看到模型已变而深度没变。
  const handleSelectThought = useCallback(
    (thought: string, _modelContext: { provider: string; model: string }) => {
      handleDraftSelectThought(thought);
    },
    [handleDraftSelectThought],
  );

  // [事务] 自定义 provider 的恢复是一次“重启 runtime + 重新准备 workspace”的重操作，
  // 只在 configOptions 已进入 error 且用户主动选型时触发。四个阶段顺序固定：
  // 1) 解析 value 并补全缺失模型；2) 先把 resolution 置为 loading（UI 立刻反馈）；
  // 3) restartWorkspaceProcess 带 bumpRuntimeEpoch，强制丢掉旧 epoch 的所有缓存；
  // 4) prepareWorkspace 成功后一次性写回 configOptions/slashCommands 并置 ready。
  // [失败路径] 任何一步失败都必须把状态落成 error 再 rethrow：只 rethrow 不落状态，
  // UI 会永远停在 loading，用户以为在恢复，实际已经结束。
  // [并发] 没有 providerId 时静默返回，不落 error：这是一个尚未成形的选项，不是故障。
  const handleRecoverCustomModelSelection = useCallback(
    async (value: string, sourceModel: ModelSelectionSource | null) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.providerId) {
        return;
      }
      // [失败路径] 缺少模型名时用该 provider 的首个模型兜底；若目录仍未知
      // （modelSelectionView 为 null）则 fallbackModel 为 null 并放弃恢复，
      // 而不是猜一个 modelId——猜错会在启动 runtime 时才失败，代价更高。
      const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
      let modelValue = value;
      if (!decoded.modelName) {
        const fallbackModel =
          modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )?.models[0]?.modelId ?? (modelSelectionView ? null : undefined);
        if (!fallbackModel) {
          logger.warn("[v4-pane] custom provider 恢复跳过：provider 没有可用模型", {
            customProviderId: decoded.providerId,
            workspacePath,
          });
          return;
        }
        modelValue = encodeCustomModelValue(decoded.providerId, fallbackModel);
      }
      const modelSelection = parseModelPickerValue(modelValue);
      // Bug 原因：configOptions error 的 custom provider 选择绕过普通 onSelectModel；
      // 已绑定任务仍复用同一提示入口，草稿态由入口统一静默。
      showModelChangeNotice(sourceModel, {
        provider: modelSelection.providerId,
        model: modelSelection.modelId,
      });
      // [事务] 先写 resolution 与 loading，再重启进程：重启是长操作，
      // 若等它返回才更新状态，用户点完选型会有数秒“无反应”。
      // 这里的 store 是面板级缓存（按 workspace + identity），不是会话投影。
      const store = useZCodeSessionStore.getState();
      store.setModelSelectionResolution(
        workspacePath,
        {
          selectedSupplierKey: buildCustomSupplierKey(decoded.providerId),
          isGhostSupplier: false,
          supplierMismatchReason: null,
        },
        workspaceIdentity,
      );
      store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
      logger.info("[v4-pane] configOptions error custom provider recovery start", {
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });

      // [资源] bumpRuntimeEpoch 是关键：不 bump 的话 restart 后仍可能有旧 epoch 的
      // 命令/订阅引用继续写入，configOptions 会混合两个 runtime 的结果。
      // 顺序上必须先 restart 再 prepare，prepare 内部会重新建立 CLI 连接。
      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          bumpRuntimeEpoch: true,
        });

        const prepareResult = await prepareWorkspaceWithZCodeSessionService({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          zcodeSessionService,
        });
        handleDraftSelectModel(modelSelection.providerId, modelSelection.modelId);
        store.setConfigOptions(workspacePath, prepareResult.configOptions ?? [], workspaceIdentity);
        store.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        store.setSlashCommands(workspacePath, prepareResult.slashCommands ?? [], workspaceIdentity);
        logger.info("[v4-pane] configOptions error custom provider recovery done", {
          configOptionsCount: prepareResult.configOptions?.length ?? 0,
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
      } catch (error) {
        // [失败路径] 先把状态落成 error 再抛出：调用方负责展示提示，但状态必须
        // 先回到可用态，否则下拉框会一直转圈且无法再次选择。
        store.setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn("[v4-pane] configOptions error custom provider recovery failed", {
          error: error instanceof Error ? error.message : String(error),
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
        throw error;
      }
    },
    [
      provider,
      handleDraftSelectModel,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspacePath,
      zcodeSessionService,
      zcodeTaskService,
    ],
  );

  // 模式与模型一样属于下一次 Submission；选择时只更新 Composer。
  const handleSwitchMode = useCallback(
    (mode: string) => {
      handleDraftSwitchMode(mode);
    },
    [handleDraftSwitchMode],
  );

  // [事务] 压缩入口复用可见斜杠命令解析，而不是直接发 type=compact：
  // 解析层负责识别“/compact 附加参数”与命令是否对当前 CLI 可见；
  // 绕过它会让不支持的 CLI 收到未知命令，得到一条无意义的失败。
  // 无会话或无解析结果时静默返回，context 面板本身只在有会话时出现。
  // context usage 面板的压缩入口（命令文本 = "/compact"，复用 slash 解析路径）。
  const handleSendCompressionCommand = useCallback(
    (command: string) => {
      if (!sessionId) return;
      const parsed = parseV4VisibleSlashCommand(command);
      if (!parsed) return;
      void dispatchSlashCommand(parsed, sessionId, snapshotRef.current?.revision, undefined);
    },
    [dispatchSlashCommand, sessionId],
  );

  // 误停排障需要区分按钮与 Esc；普通 info 在生产禁用，必须走生命周期日志。
  // [事务] stop 带 expectedForegroundExecutionId，是一种轻量 CAS：只停用户看到的那次
  // 前台执行。不带它会在“用户点停止的同时上一轮结束、下一轮刚开始”时误停新回合。
  // [失败路径] 无 canStop 时直接 return 并记 lifecycle：不能发空 stop，
  // 那会在服务端产生一条无目标的命令，且 Esc 的误触无法与真实停止区分。
  // [并发] source 参与日志：排障时需要区分按钮与 Esc，后者可能被焦点逻辑误路由。
  const handleStop = useCallback(
    (source: "button" | "escape") => {
      const current = snapshotRef.current;
      if (!sessionId || !current?.control.canStop) {
        logger.lifecycle.info("[v4-pane] stop 命令被跳过（无可停执行）", {
          source,
          sessionId: sessionId ?? "",
        });
        return;
      }
      // [并发] foregroundExecutionId 取“当前投影里标记为前台”的那一条：
      // 后台 work 不应被按钮停止，后台有自己的取消入口。找到就带 id，
      // 找不到则发普通 stop（兼容尚未上报 id 的旧 runtime）。
      const foregroundExecutionId = current.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      )?.foregroundExecutionId;
      logger.lifecycle.info("[v4-pane] stop 命令发出", {
        source,
        sessionId,
        foregroundExecutionId: foregroundExecutionId ?? "",
      });
      void dispatchCommand(
        "stop",
        foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {},
        sessionId,
      ).catch((error) => {
        logger.lifecycle.warn(`[v4-pane] stop 失败: ${String(error)}`);
      });
    },
    [dispatchCommand, sessionId],
  );

  const handlePauseGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.pauseGoal.allowed) return;
    void dispatchCommand("pauseGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] pauseGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  // [事务] resumeGoal 除了 canStop 之外还看 availability.resumeGoal.allowed：
  // 前者是“有执行可停”，后者才是“存在可恢复的目标”。两者混淆会让按钮在
  // 没有 goal 时也出现，点击后服务端拒绝，用户以为功能坏了。
  const handleResumeGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.resumeGoal.allowed) return;
    void dispatchCommand("resumeGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] resumeGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  // 主、辅对话可同时 focused（各自布局的可见态），不能据此争抢窗口 Esc。
  // 面板打开时按 DOM 归属隔离；关闭时由 Shell 授权主区接收对话外 Esc，避免焦点离开输入框后无法停止。
  // 保留窗口冒泡阶段，让 mention/slash 的 preventDefault 和 dialog 优先处理。
  useEffect(() => {
    if (!focused || readOnly) return;
    if (!sessionId || !snapshot?.control.canStop) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!paneRef.current) return;
      if (!allowEscapeStopOutsidePane && !event.composedPath().includes(paneRef.current)) return;
      if (shouldIgnoreEscapeForStopGeneration(event)) return;
      event.preventDefault();
      handleStop("escape");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    allowEscapeStopOutsidePane,
    focused,
    handleStop,
    readOnly,
    sessionId,
    snapshot?.control.canStop,
  ]);

  // handleStop 带 source 参数（button / escape 两个调用点），但 ConversationComposer 是 memo：
  // 直接写 onStop={() => handleStop("button")} 每次 render 都换引用，memo 白做，而 composer
  // 恰好是每次输入都可能重渲染的组件。这里固定 button 版的引用，不动 handleStop 的双入口设计。
  const handleStopFromButton = useCallback(() => handleStop("button"), [handleStop]);

  // [失败路径] retry 订阅由 lease.store 自己实现退避与单飞，pane 不额外防抖：
  // 在这里加防抖会与 store 的退避叠加，用户需要连点很多次才能恢复。
  // lease 为 null 时可选链直接 no-op，错误横幅上的按钮在换代窗口里也能安全点击。
  const handleRetrySubscribe = useCallback(() => {
    void lease?.store.retry();
  }, [lease]);

  // loadOlder 触发（接近顶部自动预取）。store 内部单飞防重入。
  const handleLoadOlder = useCallback(() => {
    return lease?.store.loadOlder();
  }, [lease]);

  // [事务] loadAllOlder 在没有 lease 时返回 stale 而不是 reject：
  // 分享目录补全对它做 fire-and-forget，reject 会变成未处理拒绝；
  // 返回 stale 同时带上当前 logEpoch，调用方可以据此判断“不是失败，只是没数据”。
  const handleLoadAllOlder = useCallback(() => {
    return lease
      ? lease.store.loadAllOlder()
      : Promise.resolve({
          status: "stale" as const,
          logEpoch: snapshot?.logEpoch ?? "unknown",
        });
  }, [lease, snapshot?.logEpoch]);

  // [事务] 分享目录必须覆盖“全部可分享 turn”，但本地只加载了窗口内的 rows；
  // 打开浮层时若还有更早的行，就先一次性 loadAllOlder 再让预检看到完整 turn 集。
  // 去重键含 logEpoch：日志重写后早先的“已补齐”不再成立，必须重新补。
  // 失败时清空去重键，允许用户下次打开浮层时重试，而不是永久停留在半份目录。
  useEffect(() => {
    if (!shareActive || !sessionId || !hasOlderRows(snapshot)) return;
    const key = `${sessionId}:${snapshot?.logEpoch ?? "unknown"}`;
    if (shareHydratedSessionRef.current === key) return;
    shareHydratedSessionRef.current = key;
    void handleLoadAllOlder().catch((error) => {
      shareHydratedSessionRef.current = null;
      logger.warn("[conversation-share] 补齐分享目录失败", { error });
    });
  }, [handleLoadAllOlder, sessionId, shareActive, snapshot]);

  useEffect(() => {
    if (
      !sessionId ||
      !lease?.store ||
      !shouldAutoLoadIncompleteLeadingTurn(snapshot, state.loadingOlder)
    ) {
      return;
    }
    const firstRowId = snapshot?.rows.window[0]?.rowId;
    if (firstRowId === undefined) return;
    // [资源] cursorKey 含 subscriptionId：重连后即使首行相同，也说明窗口来源变了，
    // 需要重新判断完整性。比较后立刻写入，保证“同一次不完整”只补拉一次，
    // 避免空 range 或 loadOlder 失败时 effect 自旋。
    const cursorKey = `${sessionId}:${state.subscriptionId ?? "connecting"}:${firstRowId}`;
    if (autoLoadIncompleteTurnCursorRef.current === cursorKey) return;
    autoLoadIncompleteTurnCursorRef.current = cursorKey;

    // snapshotTailWindowRows 按 row 截尾，可能把一个长 turn 的 header/user
    // 留在窗口外。旧 UI 只在 scroll 事件到达顶边时 loadOlder；内容不足一屏或 scrollTop
    // 已经为 0 时不会再产生事件，于是只渲染 assistant，必须先下滚再上滚。检测到首 turn
    // 缺 header 后立即逐窗补齐；cursor 去重避免空 range 或失败时 effect 自旋。
    logger.debug("[v4-pane] 冷快照首 turn 不完整，自动补拉更早行", {
      firstRowId,
      sessionId,
      turnId: snapshot?.rows.window[0]?.turnId,
    });
    void lease.store.loadOlder();
  }, [lease, sessionId, snapshot, state.loadingOlder, state.subscriptionId]);

  // subscribe ACK 会先把 store 置 live，initial snapshot 稍后才到；只看
  // status 会在无投影窗口提前启用编辑器。正式 session 必须等首个 snapshot 才可输入。
  const connecting =
    sessionId !== null &&
    (snapshot === null || (state.status === "connecting" && !snapshot.runtimeInitialization));
  // [并发] 编辑锁必须同时匹配 session 与 workspace 才算“属于当前 Composer”：
  // 只比 queueItemId 会在切会话后仍把新 Composer 锁住，用户无法输入。
  const queueEditActiveForCurrentComposer =
    queueEditOperation?.sessionId === sessionId && queueEditOperation.workspaceKey === workspaceKey;
  // 草稿态没有订阅，错误来自本地发送而不是投影；errored 只对真实会话成立，
  // 用同一个值驱动错误横幅与遥测，避免两处口径不同。
  const errored = sessionId !== null && state.status === "error";
  useSessionSubscriptionErrorTelemetry({
    supervisor: conversationTelemetry,
    sessionId,
    lastError: state.lastError,
    visible: errored && telemetryVisible && conversationTelemetryForegroundEnabled,
  });
  // retry 的产品裁决属于行级权威投影。这里仅提供命令能力，入口是否展示
  // 完全读取 row.actions.canRetry，禁止再用 pane phase 形成第二套 guard。
  // [权衡] 三个 ActionsEnabled 都只是“能力是否存在”，不是“这一行是否可操作”：
  // 行级权限由 row.actions.canRetry/canFork 决定。pane 侧只叠加 runtime、
  // 只读、副屏与 sessionId 四道全局门，避免形成第二套行级 guard。
  // 若在这里再判断 phase，会出现“行说可重试、pane 说不行”的互相矛盾。
  const retryActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  // fork 可用性完全由 row.actions.canFork（CLI stable resolver 投影）裁决；pane 只提供命令回调。
  const forkActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  // editUserQuery 已由 command 层防御 latest real user query，并在 running
  // 提交时先 stop barrier 再 rewind/rerun；UI 不应再用 completed gate 把入口整轮隐藏。
  const editActionsEnabled = runtimeReady && !readOnly && !selectionSideChat && Boolean(sessionId);
  const isDraft = sessionId === null;
  // 滚动恢复必须使用与 sessionId 匹配的 lease projection。切换 session 的 render 与
  // passive effect 不在同一时刻，旧 lease 的 rows 若提前交给 timeline，会让新记忆按旧
  // 内容高度 clamp，后续目标 rows 到达时也无法区分这次临时落点。
  const timelineSnapshot =
    !isDraft && (lease === null || sessionLeaseReady) && snapshot?.sessionId === sessionId
      ? snapshot
      : null;
  // 交接上下文只在 import 尚未 discarded 时可用：discarded 表示用户已丢弃导入的
  // 分享对话，此时顶部只读块必须消失，而不是继续展示一份“已删除”的内容。
  const shareHandoverContext =
    snapshot?.sharedContextImport && "contextId" in snapshot.sharedContextImport
      ? snapshot.sharedContextImport
      : null;
  // 导入的分享对话：读取落盘的公开 rows 用于会话顶部的只读块。
  // 分享页可能过期或未上线，所以只读本地副本，不回源。
  const [importedShare, setImportedShare] = useState<ImportedConversationShare | null>(null);
  const importedShareContextId =
    shareHandoverContext && shareHandoverContext.status !== "discarded"
      ? shareHandoverContext.contextId
      : null;
  // [并发] 手机远控不读导入分享：该形态下只读块不渲染，读它纯属浪费一次磁盘 IO，
  // 且可能把大段 markdown 带进内存。切走时显式 setImportedShare(null)，防止旧内容
  // 在下次打开时先闪现一帧。disposed 标志保证卸载后的响应不 setState。
  // [失败路径] 读取失败只 warn 并清空，不展示错误：只读块是增强信息，
  // 它的缺失不应阻断主对话或弹出横幅。
  useEffect(() => {
    if (!importedShareContextId || compactForRemoteControl) {
      setImportedShare(null);
      return;
    }
    let disposed = false;
    void conversationShareService
      .getImportedConversation({
        workspacePath,
        contextId: importedShareContextId,
      })
      .then((imported) => {
        if (disposed) return;
        setImportedShare(imported);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // 只读块是增强，读不到就不渲染，不打断会话。
        logger.warn("[conversation-share] 读取导入的分享对话失败", { error });
        setImportedShare(null);
      });
    return () => {
      disposed = true;
    };
  }, [compactForRemoteControl, conversationShareService, importedShareContextId, workspacePath]);
  // normalizeConversationShareMarkdown 在 artifactNames 里找不到匹配名字时，会把正文里的
  // 文件引用替换成空字符串（直接删掉）。不接这份映射，只读块里的文件引用会静默消失。
  // [事务] artifactId→displayName 映射交给 markdown 归一化使用：缺了它，
  // 正文里的文件引用会被替换成空串（静默删掉），用户会以为分享内容缺了一段。
  // 只从本地副本构建，不回源：分享页可能已过期，回源会让只读块在离线时变空。
  const importedShareArtifactNames = useMemo(
    () =>
      new Map(
        (importedShare?.artifacts ?? []).map((artifact) => [
          artifact.artifactId,
          artifact.displayName,
        ]),
      ),
    [importedShare],
  );
  // 只收录有 workspaceRelativePath 的产物：没有相对路径就无法映射到本地文件，
  // 放进去只会得到一条不可点击的链接。
  const importedShareArtifactWorkspaceRelativePaths = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const artifact of importedShare?.artifacts ?? []) {
      if (artifact.workspaceRelativePath) {
        entries.push([artifact.artifactId, artifact.workspaceRelativePath]);
      }
    }
    return new Map(entries);
  }, [importedShare]);
  // [并发] 滚到底请求必须在“分享块已挂载、本地副本与 task 对上”之后消费：
  // 分享块是异步插入顶部的，提前滚会在布局变化后停在半途。这里等两帧
  // （rAF 嵌套）让 markdown 与图片完成首轮布局，再消费请求并清除。
  // [失败路径] action 尚未挂载时返回 false，不消费请求，下一帧/下次渲染还能重试。
  useLayoutEffect(() => {
    if (
      compactForRemoteControl ||
      !timelineBottomRequest ||
      timelineBottomRequest.taskId !== sessionId ||
      !importedShare ||
      importedShare.contextId !== importedShareContextId
    ) {
      return;
    }
    // [资源] 清理必须取消两帧：只取消第一帧时，回调里已排的第二帧仍会执行并
    // 在组件卸载后访问 ref。secondFrame 用 null 表示尚未排上，避免取消 0 号帧。
    // 分享块是异步挂载的；请求保留到目标 task 与本地副本都就绪，再在布局稳定后消费。
    const scrollToBottom = () => {
      const action = timelineScrollToBottomRef.current;
      if (!action) return false;
      action();
      return true;
    };
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToBottom();
      secondFrame = window.requestAnimationFrame(() => {
        if (!scrollToBottom()) return;
        useZCodeSessionStore
          .getState()
          .clearTimelineBottomRequest(
            workspacePath,
            timelineBottomRequest.requestId,
            workspaceIdentity,
          );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    compactForRemoteControl,
    importedShare,
    importedShareContextId,
    sessionId,
    timelineBottomRequest,
    workspaceIdentity,
    workspacePath,
  ]);
  // [事务] 持久化的是规范 /cn/share/ 路径，打开时才按当前 locale 本地化：
  // 存本地化 URL 会让分享链接在切换语言后失效。宿主没给 onOpenBrowserUrl
  // （如只读嵌入）时不打开，保持按钮可见但无副作用的降级。
  const handleOpenImportedShareUrl = useCallback(() => {
    if (!shareHandoverContext || !onOpenBrowserUrl) return;
    // 持久化的是规范 /cn/share/ 路径；展示/打开时才按界面语言本地化。
    onOpenBrowserUrl(localizeConversationShareUrl(shareHandoverContext.shareUrl, locale));
  }, [locale, onOpenBrowserUrl, shareHandoverContext]);
  // 诊断用的初始草稿配置只在草稿态解析：已绑定会话的配置来自投影，
  // 再解析一份会让日志同时出现两个来源，排障时无法判断哪个生效。
  const initialDraftConfigForDiagnostics = isDraft ? resolveInitialDraftConfig() : undefined;
  const telemetryDraftConfig = draftConfig;
  // CLI V4 projection 是 running/count/manifest 的唯一权威；renderer 不再在 spawn
  // 事件后另发查询拼接第二份状态，避免并发 child 的 in-flight refresh 丢更新。
  const subagents = snapshot?.subagents ?? EMPTY_SUBAGENT_PROJECTION;
  // [事务] revision=0 是“尚无权威投影”的哨兵：此时 childSessionIds 是空数组，
  // 若照样同步，宿主会把所有已有 subagent tab 判成无效并关掉。
  // rootSessionId 回退到当前 session，保证从子会话里打开时仍指向整棵树的根。
  useEffect(() => {
    if (!sessionId || subagents.revision === 0 || !onSyncSubagentSessionTabs) return;
    onSyncSubagentSessionTabs({
      rootSessionId: rootSessionId ?? sessionId,
      parentSessionId: sessionId,
      validChildSessionIds: subagents.childSessionIds,
    });
  }, [
    onSyncSubagentSessionTabs,
    rootSessionId,
    sessionId,
    subagents.childSessionIds,
    subagents.revision,
  ]);
  // [并发] 副屏被阻塞的状态写回全局 store，供其它 pane 的选区动作判断；
  // cleanup 必须显式置 false：pane 卸载或退出副屏形态时若不清，其它 pane
  // 会一直以为副屏被占用，选区入口永久禁用。
  useEffect(() => {
    if (!selectionSideChat || !sessionId) return;
    setSelectionSideChatBlocked(sessionId, Boolean(blockingInteractionId));
    return () => setSelectionSideChatBlocked(sessionId, false);
  }, [blockingInteractionId, selectionSideChat, sessionId]);
  const isOfficeMode = useIsOfficeMode();
  // [事务] 状态面板模型是“只读派生”，输入全部来自投影与宿主下发的 git 摘要；
  // 副屏形态下把 goal 置 null：副屏用于旁支提问，展示父会话的执行目标会误导用户。
  // 不要把 runningXxxCount 直接塞进 builder，它需要按类型分组，计数由下面统一算，
  // 保证面板、胶囊、Composer 徽标三处用的是同一份模型。
  // 依赖里的 snapshot?.xxx 是刻意的字段级依赖：整个 snapshot 会让每次 token 重建模型。
  const statusPanelModel = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        workspacePath,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal: selectionSideChat ? null : (snapshot?.goal ?? null),
        sessionPlans: state.sessionPlans,
        plan: snapshot?.plan ?? null,
        backgroundWorks: snapshot?.backgroundWorks ?? [],
        runningSubagents: subagents.running,
        workflowRuns: snapshot?.workflowRuns?.runs ?? [],
      }),
    [
      isOfficeMode,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      snapshot?.backgroundWorks,
      snapshot?.goal,
      snapshot?.plan,
      snapshot?.workflowRuns,
      state.sessionPlans,
      selectionSideChat,
      subagents.running,
      workspacePath,
    ],
  );
  // 三类计数从同一份模型派生，保证“徽标数字 = 各分区条目数之和”。
  // 分开维护计数会漏掉某一类，用户点开面板发现少了一条。
  const runningBackgroundWorkCount =
    statusPanelModel.runningBashWorks.length +
    statusPanelModel.runningSubagentWorks.length +
    statusPanelModel.runningWorkflowRuns.length;
  const runningTerminalCount = statusPanelModel.runningBashWorks.length;
  const runningAgentCount = statusPanelModel.runningSubagentWorks.length;
  const runningWorkflowCount = statusPanelModel.runningWorkflowRuns.length;
  // [权衡] 换会话时强制折起终端与智能体分区，但工作流分区由下面的“是否有活 run”
  // 单独决定：统一折起会把正在跑的工作流藏起来，与胶囊“点开反而更少”的问题同源。
  // 只在 sessionId 变化时执行，不依赖运行数，避免运行数波动时反复折起用户的手动展开。
  useEffect(() => {
    setTerminalSectionOpen(false);
    setAgentSectionOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (runningTerminalCount === 0) {
      setTerminalSectionOpen(false);
    }
  }, [runningTerminalCount]);
  // 「工作流」分区跟着「有没有活的 run」走（docs/dynamic-workflow/presentation.md「Other places a
  // run appears」）：在跑数从 0 变成 ≥1 时打开、归零时折起，进入会话时按该会话重新判定。只在这个
  // 布尔翻转（或换会话）时写入，所以读者手动折起后，run 还在跑就一直保持折起。
  // Bug 原因：过去它和终端 / 智能体一样默认折起；胶囊改为按名字显示工作流后，点开胶囊反而把刚才
  // 看到的那条 run 折进了分区里——展开后看到的比胶囊还少。
  const hasLiveWorkflowRun = runningWorkflowCount > 0;
  useEffect(() => {
    setWorkflowSectionOpen(hasLiveWorkflowRun);
  }, [hasLiveWorkflowRun, sessionId]);
  useEffect(() => {
    if (runningAgentCount === 0) {
      setAgentSectionOpen(false);
    }
  }, [runningAgentCount]);
  // composer 徽标直达：唯一在跑的是一条可开
  // 详情页的 workflow run 时，徽标点击直接开它的 side tab，胶囊不动。判定吃胶囊的同一份模型；
  // 宿主没给 onOpenWorkflowRun（面板行同样不可点）时不直达。
  // [事务] 唯一在跑的 workflow run 才允许“徽标直达详情”：多条时无法确定用户想看哪条，
  // 必须落到面板让用户选。判定复用面板模型，避免两条打开路径给出不同结论。
  // 宿主未提供 onOpenWorkflowRun 时返回 null，保证点击仍走“展开面板”的通用行为。
  const soleRunningWorkflowRunTarget = useMemo(
    () => (onOpenWorkflowRun ? resolveSoleRunningWorkflowRunTarget(statusPanelModel) : null),
    [onOpenWorkflowRun, statusPanelModel],
  );
  const handleOpenRunningBackgroundWorks = useCallback(() => {
    if (runningBackgroundWorkCount === 0) return;
    if (soleRunningWorkflowRunTarget) {
      // 与面板行同一个 handler：不存在第二条打开路径。
      handleOpenWorkflowRunFromPanel(soleRunningWorkflowRunTarget);
      return;
    }
    // 产品规则：Composer 是全部实时活动的入口；分区拆开后一次点击仍要展开所有非空类型，
    // 但三个区块后续保持独立折叠状态，不能再共享一个 open 布尔值。
    setTerminalSectionOpen(runningTerminalCount > 0);
    setAgentSectionOpen(runningAgentCount > 0);
    setWorkflowSectionOpen(runningWorkflowCount > 0);
    handleSummaryPanelVariantChange("panel");
  }, [
    handleOpenWorkflowRunFromPanel,
    handleSummaryPanelVariantChange,
    runningAgentCount,
    runningBackgroundWorkCount,
    runningTerminalCount,
    runningWorkflowCount,
    soleRunningWorkflowRunTarget,
  ]);
  // [权衡] variant 允许被外部覆盖（多 pane 同步），未覆盖时按内容自动决定。
  // 自动判定只能在这里做一次并同时喂给布局与面板：两边各算一次会出现
  // “面板认为自己是 inline、时间线仍按 overlay 留白”的重叠。
  const statusPanelVariant = resolveConversationStatusPanelVariant({
    variantOverride: effectiveSummaryPanelVariantOverride,
  });
  // 若只有 status panel 内部知道自动展开态，而 timeline/composer 未同步调整布局，
  // 宽屏下就会出现面板覆盖内容。因此外层布局也必须使用同一展开状态。
  const shouldUseStatusPanelInlineLayout =
    !isDraft &&
    shouldUseConversationStatusPanelInlineLayout({
      hasContent: statusPanelModel.hasContent,
      variant: statusPanelVariant,
    });
  // [事务] 草稿态强制 none：新任务没有可展示的状态，inline 会凭空占一列并挤压 Composer。
  // auto/inline 的区别只在宽度断点，交给同一函数决定，避免 CSS 与 JS 各有一份阈值。
  const statusPanelLayout = !shouldUseStatusPanelInlineLayout
    ? "none"
    : statusPanelVariant === "auto"
      ? "auto"
      : "inline";
  const controlLastError = snapshot?.control.lastError ?? null;
  // [并发] 指纹必须用“错误所属的 sessionId”（snapshot 的），而不是当前 props 的：
  // 切会话瞬间两者不同，用当前 id 会让同一条错误在新会话里换一个 key，
  // 用户刚 dismiss 的横幅立刻重新出现。
  const controlLastErrorKey = controlLastError
    ? createSessionErrorKey(snapshot?.sessionId ?? sessionId, controlLastError)
    : null;
  // [事务] 投影错误只有在“有 key 且未被 dismiss”时才转为 UI 错误；
  // 转换发生在渲染期而不是 effect，保证错误横幅与 dismiss 在同一帧生效。
  // 额度横幅接管时这里仍会算，但由下面的 composerError 决定是否让位，
  // 不做两处条件，避免“横幅消失但错误已丢”的中间态。
  const projectedComposerError =
    controlLastError && controlLastErrorKey && !dismissedErrorKeys.includes(controlLastErrorKey)
      ? toComposerUiError(snapshot?.sessionId ?? sessionId, controlLastError)
      : null;
  // 官方 Server MCP 不可用（额度耗尽 / 无 Coding Plan）：事实来自 tool row 上的结构化标识，
  // 与模型额度是两条独立信息通道，这里只做投影。
  const mcpUnavailableNotice = useMemo(
    () => resolveMcpUnavailableNotice(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // [失败路径] 额度横幅与通用错误横幅共用 control.lastError，takesOverError 保证
  // 同一事实只出现一次；否则用户会看到“额度耗尽”和一条泛化的失败叠在一起。
  // 优先级：草稿模型就绪错误 > 本地提交错误 > 投影错误，前者更贴近用户当前动作。
  const quotaBanner = useV4SessionQuotaBanner({
    sessionId: snapshot?.sessionId ?? sessionId,
    error: controlLastError,
    errorKey: controlLastErrorKey,
    phase: snapshot?.control.phase ?? null,
    providerId: snapshot?.config.provider ?? null,
    modelId: snapshot?.config.model ?? null,
    usageStatsService: baseWorkspaceServices.usageStatsService,
    mcpUnavailableNotice,
  });
  // [事务] 本地提交错误在换会话时清空：它只对“发起它的那个 Composer”有意义，
  // 带到新会话会让用户以为新消息也发失败了。投影错误不走这个清理，
  // 因为它是服务端事实，换回来时应该还在。
  const composerError =
    draftModelReadinessError ??
    sendSubmissionError ??
    (quotaBanner.takesOverError ? null : projectedComposerError);
  useEffect(() => {
    setSendSubmissionError(null);
  }, [sessionId]);
  // [事务] dismiss 必须按“错误来源”分流，不能统一清投影：
  // 草稿模型错误来自本地 gate，提交错误来自本地 state，只有最后一类才是投影事实。
  // 投影错误写入有界指纹列表（保留最近 20 条）：只保留最后一条会在用户 dismiss
  // 两条不同错误后，让较早那条重新出现。
  // [失败路径] 没有 key 时直接返回：无指纹的错误无法安全 dismiss，
  // 强行写入会让下一次任意错误都被误屏蔽。
  const handleDismissComposerError = useCallback(() => {
    if (draftModelReadinessError) {
      dismissDraftModelReadinessError();
      return;
    }
    if (sendSubmissionError) {
      setSendSubmissionError(null);
      return;
    }
    if (!controlLastErrorKey) return;
    // v4 control.lastError 是投影事实，单纯关闭 banner 不会改投影。
    // 这里只记录当前错误指纹，避免下一次 render 把同一条错误立刻重新顶回来；新错误 at/message 变化仍会显示。
    setDismissedErrorKeys((keys) =>
      keys.includes(controlLastErrorKey) ? keys : [...keys.slice(-19), controlLastErrorKey],
    );
  }, [
    controlLastErrorKey,
    dismissDraftModelReadinessError,
    draftModelReadinessError,
    sendSubmissionError,
  ]);
  // 远端 workspace 的模型目录来自远端 Registry；本机配置保存后由 Provisioning 自动下发，
  // 因此缺模型横幅只切换措辞，配置/升级动作仍统一指向本机。
  const modelConfigTarget: ChatErrorBannerModelConfigTarget = isRemoteWorkspaceIdentity(
    workspaceIdentity ?? "",
  )
    ? "remote"
    : "local";
  // [权衡] 设置入口先写“待跳转分区”再开设置页：设置页是独立窗口/标签，
  // 不能通过 props 传初值，只能借 store 传递一次性意图。写入必须早于 open，
  // 否则设置页首次渲染读不到分区，会落在默认页。
  const handleOpenModelSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  // [事务] 升级 provider 由账号族决定（bigmodel / zai），不能从当前模型反推：
  // 用户可能正用第三方模型，但套餐仍属于账号族。拿不到弹层句柄时静默返回，
  // 按钮在无弹层的宿主里应被隐藏（由上层决定），这里不做二次 UI 判断。
  const handleOpenModelUpgrade = useCallback(() => {
    if (!codingPlanUpgradeDialog) return;
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    codingPlanUpgradeDialog.openCodingPlanUpgrade({ providerId });
  }, [codingPlanUpgradeDialog, sharedSettings?.providerFamilyDomain]);
  // [事务] quotaBanner.upgradeProviderId 为空表示“没有可升级的 provider”，
  // 此时不打开弹层：打开一个没有 provider 的购买页会让用户看到空白套餐列表。
  // funnelContext 只建立漏斗上下文，真正的转化事件由购买面板打开后统一上报，
  // 避免这里点一下就记一次曝光。
  const handleOpenQuotaUpgrade = useCallback(() => {
    const providerId = quotaBanner.upgradeProviderId;
    if (!providerId || !codingPlanUpgradeDialog) return;
    const eventText = intl.formatMessage({
      id: quotaBanner.upgradeActionLabelId,
    });
    // 横幅只建立漏斗上下文；coding_plan_upgrade_ck 仍由真实购买面板打开后统一上报。
    codingPlanUpgradeDialog.openCodingPlanUpgrade({
      providerId,
      funnelContext: createCodingPlanFunnelContext({
        providerId,
        upgradeSource: "session_quota_alert",
        eventRegion: "app.session",
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanState({
          providerId,
          displayStatus: "purchased",
          planLevel: "start",
        }),
      }),
    });
  }, [
    codingPlanUpgradeDialog,
    intl,
    quotaBanner.upgradeActionLabelId,
    quotaBanner.upgradeProviderId,
  ]);

  const handleConfirmShareDisclosure = useCallback(async () => {
    if (!sessionId || !shareDraft || sharePublishing) return;
    const productTurnIds = getConversationShareSelectedProductTurnIds(
      useConversationShareSelectionStore.getState(),
      sessionId,
    );
    // [失败路径] 提前返回而不是抛错：空选择可能来自“另一个 pane 同时清空了它”，
    // 报错会让用户看到一条无从处理的提示；空标题同理，输入框本身会标红。
    // 用 store 的瞬时选择而不是 props：点击确认与最后一次勾选可能在同一帧，
    // 读 props 会漏掉最后一次选择。
    if (productTurnIds.length === 0 || !shareTitle.trim()) return;
    // [事务] attemptKey 是发布幂等的身份：标题 + 访问模式 + 选中 turn + 世界版本。
    // 同参数重试复用同一个 clientRequestId（服务端据此去重）；任一参数变化就生成
    // 新的 attempt，避免把“改了标题”的发布误判成重复而不生效。
    // revision/logEpoch 必须纳入：它们变化意味着产物可能已重建，不能复用旧幂等键。
    const attemptKey = JSON.stringify({
      title: shareTitle.trim(),
      accessMode: shareDraft.accessMode,
      productTurnIds,
      revision: snapshot?.revision ?? null,
      logEpoch: snapshot?.logEpoch ?? null,
    });
    const shareAttempt = ensureConversationShareAttempt(
      getConversationShareDockState(useConversationShareSelectionStore.getState(), sessionId)
        .attempt,
      attemptKey,
      sessionId,
      { randomUUID: () => globalThis.crypto?.randomUUID?.() },
    );
    // [资源] operationId 是进度订阅的句柄：每次确认都新建一个，确保并发/重试的
    // 进度事件不会互相覆盖。crypto.randomUUID 不可用时退回时间戳，只要求本次进程内唯一。
    const operationId = `share-operation-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    // [事务] activePhase 与 collectedWarnings 是进度订阅与最终结果之间的共享可变状态：
    // 进度可能先于 publish Promise 结算到达，最终 catch/成功分支要用“最后一次进度”
    // 判断是否已经进入不可回滚阶段。用局部变量而不是 ref，保证每次确认互相隔离。
    let activePhase = "collecting";
    let collectedWarnings: ConversationShareDisplayWarnings | null = null;
    // [并发] 进度订阅必须在 publish 之前建立，否则会漏掉第一批 collecting 事件，
    // 进度条从 0 直接跳到 50%，用户以为卡住了。返回值是取消订阅函数，
    // 必须在 finally 里调用，避免失败后订阅泄漏并在下次发布时重复累加进度。
    const progressSubscription = conversationShareService.onDynamicPublishProgress(operationId)((
      progress,
    ) => {
      activePhase = progress.phase;
      updateShareDockState(sessionId, {
        progress: progress.phase === "complete" ? "checking" : progress.phase,
        completedArtifacts: progress.completedArtifacts,
        totalArtifacts: progress.totalArtifacts,
      });
      // [事务] warning 也要 sanitize：服务端返回的 issues 可能包含本地路径或超长文本，
      // 直接展示会泄露工作区结构。omittedIssueCount 用条件展开保留“还有更多”的语义，
      // 不能写成 0，否则 UI 会显示“共 0 条省略”。
      const warnings = sanitizeConversationShareWarnings(progress.warnings);
      if (warnings.length > 0) {
        collectedWarnings = {
          issues: warnings,
          issueCount: warnings.length,
          ...(progress.omittedWarningCount
            ? { omittedIssueCount: progress.omittedWarningCount }
            : {}),
        };
      }
    });
    updateShareDockState(sessionId, {
      attempt: shareAttempt,
      publishing: true,
      progress: "collecting",
      completedArtifacts: 0,
      totalArtifacts: 0,
      publishedShareUrl: null,
      error: null,
      warnings: null,
    });
    try {
      const share = await conversationShareService.publish(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          title: shareTitle.trim(),
          accessMode: shareDraft.accessMode,
          selection: { kind: "productTurns", productTurnIds },
          clientRequestId: shareAttempt.clientRequestId,
          disclosureAcceptedAt: shareAttempt.disclosureAcceptedAt,
          locale,
        },
        operationId,
      );
      const warnings = collectedWarnings as ConversationShareDisplayWarnings | null;
      updateShareDockState(sessionId, {
        publishedShareUrl: share.share_url,
        warnings,
      });
      // collectedWarnings 只在 progress 回调里赋值，TS 的控制流分析看不到跨闭包写入，
      // 会把它收窄成 null，这里显式还原真实类型。
      if (warnings) {
        toast(
          intl.formatMessage(
            { id: "conversationShare.publishSucceededWithSkips" },
            { count: warnings.issueCount },
          ),
        );
      } else {
        toast(intl.formatMessage({ id: "conversationShare.publishSucceeded" }));
      }
    } catch (error) {
      const details = getConversationShareErrorDetails(error);
      // 401 等传输错误通常没有服务端 issues，不能再降级成 collecting 阶段的通用文案。
      const resolvedMessageId = resolveConversationSharePublishErrorMessageId(error);
      const messageId =
        resolvedMessageId === "conversationShare.publishFailed" ? undefined : resolvedMessageId;
      updateShareDockState(sessionId, {
        attempt: retainConversationShareAttemptAfterFailure(shareAttempt, details.code),
        error:
          details.issues && details.issues.length > 0
            ? {
                issues: details.issues,
                issueCount: details.issueCount ?? details.issues.length,
                omittedIssueCount: details.omittedIssueCount,
                requestId: details.requestId,
                clientRequestId: details.clientRequestId,
                operationId,
                status: details.status,
                code: details.code,
                rejection: details.rejection,
              }
            : {
                issues: [
                  {
                    code: resolveConversationShareFallbackIssueCode(details),
                    scope: "transport",
                    phase: activePhase as "collecting" | "uploading" | "checking" | "complete",
                  },
                ],
                issueCount: 1,
                requestId: details.requestId,
                clientRequestId: details.clientRequestId,
                operationId,
                status: details.status,
                code: details.code,
                rejection: details.rejection,
                messageId,
              },
      });
      logger.warn("[conversation-share] 会话发布失败", {
        sessionId,
        operationId,
        phase: activePhase,
        accessMode: shareDraft.accessMode,
        selectedProductTurnCount: productTurnIds.length,
        remoteWorkspace: Boolean(workspaceIdentity || remoteSessionId),
        errorName: details.name,
        kind: details.kind,
        ...(details.reasonCode === undefined ? {} : { reasonCode: details.reasonCode }),
        ...(details.diagnostics === undefined ? {} : { diagnostics: details.diagnostics }),
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.code === undefined ? {} : { code: details.code }),
        ...(details.rejection ? { rejection: details.rejection } : {}),
        ...(details.requestId === undefined ? {} : { requestId: details.requestId }),
      });
    } finally {
      progressSubscription.dispose();
      updateShareDockState(sessionId, { publishing: false });
    }
  }, [
    conversationShareService,
    intl,
    remoteSessionId,
    sessionId,
    shareDraft,
    sharePublishing,
    shareTitle,
    snapshot?.logEpoch,
    snapshot?.revision,
    updateShareDockState,
    workspaceIdentity,
    workspacePath,
  ]);

  // [失败路径] 复制返回布尔而不是只 toast：调用方据此决定是否关闭弹层/继续提示。
  // clipboard 不存在（非安全上下文）与写入失败分开处理——前者连尝试都做不到，
  // 仍统一提示“复制失败”，避免用户以为已复制而丢了分享链接。
  const handleCopyPublishedShare = useCallback(async () => {
    if (!publishedShareUrl || !navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(publishedShareUrl);
      toast(intl.formatMessage({ id: "conversationShare.copySucceeded" }));
      return true;
    } catch {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return false;
    }
  }, [intl, publishedShareUrl]);

  // [权衡] 宿主没有 onOpenBrowserUrl（只读嵌入/测试环境）时不打开，
  // 但按钮仍可见：链接本身可复制，隐藏入口反而让用户无法使用已发布的内容。
  const handleOpenPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !onOpenBrowserUrl) return;
    // 服务端保存规范 /cn/share/ 路径；打开时再按当前界面语言切换落地页路径。
    onOpenBrowserUrl(localizeConversationShareUrl(publishedShareUrl, locale));
  }, [locale, onOpenBrowserUrl, publishedShareUrl]);

  const handleCopyShareRequestId = useCallback(() => {
    const requestId = shareError?.requestId;
    if (!requestId || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return;
    }
    void navigator.clipboard.writeText(requestId).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, shareError?.requestId]);

  // [事务] 发布中禁止取消：此时服务端可能已经写入产物，本地关闭浮层会让
  // “已发布但用户看不到结果”的悬挂状态出现。取消只关闭选择浮层，不撤销发布。
  const handleShareCancel = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    closeShare(sessionId);
  }, [closeShare, sessionId, sharePublishing]);

  const handleConfirmShareSelection = useCallback(() => {
    if (!sharePublishing && sessionId) confirmShareSelection(sessionId);
  }, [confirmShareSelection, sessionId, sharePublishing]);

  const handleDismissShareError = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { error: null });
  }, [sessionId, updateShareDockState]);
  const handleDismissShareWarnings = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { warnings: null });
  }, [sessionId, updateShareDockState]);

  const handleDeselectShareTurn = useCallback(
    (productTurnId: string) => {
      if (!sessionId || !productTurnId) return;
      // 按 product turn 身份整轮移除：service 的 issue 已带 productTurnId，
      // 不再用 turnOrdinal 索引 UI 的 per-query 列表（两套编号会错位）。
      deselectShareProductTurn(sessionId, productTurnId);
    },
    [deselectShareProductTurn, sessionId],
  );

  // [事务] 改标题/访问模式会连带作废三个下游事实：disclosureAccepted（用户确认的是
  // 旧标题与旧可见范围）、publishedShareUrl（旧链接对应旧内容）、error/warnings
  // （针对旧参数的校验结论）。少清任何一个都会让用户带着旧确认发布新内容。
  // 只在 sessionId 存在时写，草稿态没有 share dock。
  const handleShareTitleChange = useCallback(
    (value: string) => {
      if (!sessionId) return;
      updateShareDockState(sessionId, {
        title: value,
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, updateShareDockState],
  );

  // [事务] 访问模式切换先写选择（setShareAccessMode），再清确认态：
  // 顺序反了会出现“确认态已清、模式还没变”的一帧，用户可能在这一帧点确认，
  // 于是以旧模式发布。这两个写操作都在同一事件循环内，但渲染可能插在中间。
  const handleShareAccessModeChange = useCallback(
    (accessMode: ConversationShareAccessMode) => {
      if (!sessionId) return;
      setShareAccessMode(sessionId, accessMode);
      updateShareDockState(sessionId, {
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, setShareAccessMode, updateShareDockState],
  );

  // 内联回调会让 memo 确认 Dock 每次重渲染；依赖当前 session，避免切换后写回旧会话。
  const handleShareDisclosureAcceptedChange = useCallback(
    (accepted: boolean) => {
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: accepted });
      }
    },
    [sessionId, updateShareDockState],
  );

  // [事务] 已发布或有链接时不允许再进入范围编辑：此时修改选择会让“已发布内容”
  // 与“当前选择”不一致，而链接已经流出去、无法追回。用户必须先重新发布。
  // 先清 error 再 begin：否则旧错误会带进新的选择态，弹层一打开就是红的。
  const handleEditShareSelection = useCallback(() => {
    if (sharePublishing || publishedShareUrl || !sessionId) return;
    updateShareDockState(sessionId, { error: null });
    beginShareSelection(sessionId);
  }, [beginShareSelection, publishedShareUrl, sessionId, sharePublishing, updateShareDockState]);

  // [事务] 确认按钮的四道门与 handleConfirmShareDisclosure 内部的检查刻意重复：
  // 这里负责 UI 不可点，那里负责“即便被程序化调用也不发”。只留一处会让
  // 快捷键/回车绕过按钮态直接发布未预检的内容。
  // preflight.status 必须是 ready 且无 blockingIssues：checking 阶段点确认会得到
  // 一条“文件缺失”的误报，而用户其实只是还没等预检完成。
  // `shareSelectionPanelVisible` 为真时禁止确认：用户还在编辑范围，确认等同于放弃编辑。
  const handleShareConfirm = useCallback(() => {
    if (
      !shareDisclosureAccepted ||
      shareSelectionPanelVisible ||
      sharePreflight.status !== "ready" ||
      sharePreflight.blockingIssues.length > 0
    )
      return;
    void handleConfirmShareDisclosure();
  }, [
    handleConfirmShareDisclosure,
    shareDisclosureAccepted,
    shareSelectionPanelVisible,
    sharePreflight,
  ]);

  const handleShareSelectionToggle = useCallback(
    (rowId: number) => {
      if (sessionId) toggleShareRow(sessionId, rowId);
    },
    [sessionId, toggleShareRow],
  );

  const handleShareSelectionInspect = useCallback(
    (target: { unitIndex: number; rowId: number }) => {
      timelineScrollToQueryRef.current?.(target);
    },
    [],
  );

  const recoverableCommand = recoverableCommands[0] ?? null;
  const handleDismissPendingRecovery = useCallback(() => {
    if (!recoverableCommand) return;
    pendingCommandRegistry.dismissRecovery(
      recoverableCommand.sessionId,
      recoverableCommand.commandId,
    );
  }, [recoverableCommand]);
  const handleResendPendingCommand = useCallback(() => {
    if (!recoverableCommand) return;
    const replay = pendingCommandRegistry.consumeReplay({
      sessionId: recoverableCommand.sessionId,
      commandId: recoverableCommand.commandId,
    });
    if (!replay) return;
    void dispatchCommand(
      replay.type,
      replay.payload,
      replay.sessionId,
      replay.baseRevision,
      undefined,
      undefined,
      undefined,
      undefined,
      replay.clientContext?.projectId,
      replay.clientContext?.sessionCreateSource,
      undefined,
      replay.clientContext?.taskGroupId,
    )
      .then((ack) => {
        if (
          replay.type === "createSession" &&
          (ack.status === "accepted" || ack.status === "duplicate") &&
          ack.result?.type === "createSession"
        ) {
          const originWorkspace = replay.clientContext?.workspace;
          const originWorkspaceKey =
            originWorkspace?.workspaceIdentity?.trim() || originWorkspace?.workspacePath;
          if (originWorkspaceKey && originWorkspaceKey !== workspaceKey) {
            // 防御 stale UI/旧闭包直接触发跨 workspace replay；正常入口已在 hook 过滤。
            logger.error("[v4-pending-command] 拒绝跨 workspace 提交 createSession 恢复结果", {
              originWorkspaceKey,
              workspaceKey,
            });
            return;
          }
          return handleDraftSessionCreated(
            ack.result.sessionId,
            replay.clientContext?.sessionCreateSource,
            replay.payload.firstInput ? ack.commandId : undefined,
            replay.clientContext?.taskGroupId,
          );
        }
      })
      .catch((error) => {
        // 新 command 已先写入 registry；本次 transport 失败仍可在下次连接继续对账。
        logger.warn("[v4-pending-command] 用户确认重发失败", error);
      });
  }, [dispatchCommand, handleDraftSessionCreated, recoverableCommand, workspaceKey]);

  // subagent 右侧 child tab 是观察视图；复用普通 SessionPane 时
  // 若仍创建 composer，会让用户误以为可以直接向 child session 继续输入。
  // [权衡] composerNode 是整份“输入能力”的装配，只读时直接返回 null 而不是渲染禁用态：
  // 观察视图里出现一个灰掉的输入框会让用户反复尝试。用 key 固定为常量，是让
  // 在同一 pane 内切换 session 时复用同一个 Composer 实例（保留草稿与聚焦）。
  // [并发] disabled 是四类互斥原因的并集：连接中、runtime 重建、队列编辑锁、额度阻断。
  // 注意 submissionReady 与 disabled 分开传：前者控制“能否提交”，后者控制“能否编辑”，
  // 二者合并会让 runtime 未就绪时用户连草稿都写不了。
  const composerNode = readOnly ? null : (
    <ConversationComposer
      key="conversation-composer"
      // Snapshot 仍服务用量、路由与运行态；工具栏的 mode/model 只读下方 Composer Draft。
      snapshot={snapshot}
      sessionId={sessionId}
      // 草稿 taskId 仍为 null，但 prewarm 已经拥有独立 AgentRuntime。
      // 只给 Skill catalog 下发 effective id，避免 UI 扫到 prewarm runtime 尚未加载的新 Skill。
      skillCatalogSessionId={effectiveSessionId}
      draftMode={isDraft}
      draftConfig={draftConfig}
      composerDraft={composerDraft}
      rootDraftScopeKey={composerScopeKey(newTaskComposerScope)}
      replaceComposerDraft={replaceComposerDraft}
      submissionReady={composerSubmissionReady && runtimeReady && !recoveringDraft}
      updateComposerContent={updateComposerContent}
      createSubmissionFromComposer={createSubmissionFromComposer}
      telemetryDraftConfig={telemetryDraftConfig}
      // 完整视图浮窗默认是一条输入框：草稿项目栏不进入浮窗，切到对话 tab 再选择项目。
      contextHeader={isDraft && !isFloatingPresentation ? draftComposerHeader : undefined}
      centered={isDraft}
      layout={isFloatingPresentation ? "inline" : "stacked"}
      workingDurationMs={
        floatingTurnRunning ? floatingLatestTurnSummary?.workDurationMs : undefined
      }
      blockingRequestId={blockingInteractionId}
      listenAddToChatEvents={focused}
      externalTextInsertRequest={focused && sessionId === null ? composerTextInsertRequest : null}
      onExternalTextInsertApplied={handleExternalTextInsertApplied}
      autoFocusEnabled={focused}
      disabled={
        connecting ||
        draftRuntimeRebuilding ||
        queueEditActiveForCurrentComposer ||
        quotaBanner.state.blocksSubmit
      }
      isWebRemoteControl={compactForRemoteControl}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId ?? undefined}
      modelSelectionView={
        modelSelectionView ??
        (modelSelectionRead.state.status === "loading" ? modelSelectionRead.state.catalog : null)
      }
      modelSelectionState={modelSelectionRead.state}
      modelSelectionReload={modelSelectionRead.reload}
      modelSelectionRefresh={modelSelectionRead.refresh}
      attachmentSessionId={effectiveSessionId}
      attachmentPut={attachmentPut}
      onRuntimeRestart={onRuntimeRestart}
      onRuntimeLifecycle={onRuntimeLifecycle}
      provider={provider}
      telemetryVisible={telemetryVisible && conversationTelemetryForegroundEnabled}
      readPlanIdentitySnapshot={readPlanIdentitySnapshot}
      onSendText={handleSendText}
      highspeedCard={activeHighspeedCard}
      highspeedActivationCardId={highspeedActivationCardId}
      onHighspeedActivationApplied={handleHighspeedActivationApplied}
      onDraftStateChange={handleComposerDraftStateChange}
      composerRestoreRequest={composerRestoreRequest}
      onComposerRestoreApplied={handleComposerRestoreApplied}
      onStop={handleStopFromButton}
      onSelectModel={handleSelectModel}
      onSelectThought={handleSelectThought}
      onSwitchMode={handleSwitchMode}
      onOpenRunningBackgroundWorks={
        sessionId && runningBackgroundWorkCount > 0 ? handleOpenRunningBackgroundWorks : undefined
      }
      backgroundWorkOpenTarget={soleRunningWorkflowRunTarget ? "workflow-run" : "panel"}
      // 父轮结束后 subagents.running 的目录投影可能短暂落后于仍为 running 的
      // backgroundWorks；Composer 若直接读目录会提前隐藏 Agent 入口。这里复用状态面板按
      // childSessionId 精确回退后的计数，让两个入口共享同一份运行态真值。
      runningSubagentCount={runningAgentCount}
      onRecoverCustomModelSelection={handleRecoverCustomModelSelection}
      onSendCompressionCommand={handleSendCompressionCommand}
      error={composerError}
      onDismissError={handleDismissComposerError}
      onRetryInitialization={handleRetrySubscribe}
      onOpenModelSettings={handleOpenModelSettings}
      onOpenModelUpgrade={handleOpenModelUpgrade}
      modelConfigTarget={modelConfigTarget}
      onOpenCodeViewer={onOpenCodeViewer}
      suppressGoalCommands={selectionSideChat}
      appSlashCommands={appSlashCommands}
      onDropTargetControllerChange={handleDropTargetControllerChange}
    />
  );
  // [资源] 预检状态块单独 memo：它随选中项与预检结果变化，但不应带着整个
  // Confirmation Dock 一起重建。依赖里只放三个真正参与渲染的值，
  // handleDeselectShareTurn/retrySharePreflight 本身是稳定回调。
  const sharePreflightContent = useMemo(
    () => (
      <ConversationSharePreflightStatus
        preflight={sharePreflight}
        onDeselectTurn={handleDeselectShareTurn}
        onRetryPreflight={retrySharePreflight}
      />
    ),
    [sharePreflight, handleDeselectShareTurn, retrySharePreflight],
  );
  const handleSelectAllShareRows = useCallback(
    (selected: boolean) => {
      if (sessionId) setAllPendingShareRows(sessionId, selected);
    },
    [sessionId, setAllPendingShareRows],
  );
  // pending guide 是“队列里等待用户确认的引导项”，与 queue.items 分开展示：
  // 它还不是真正的队列项，混进队列会让用户以为已经排队。snapshot 为空时保持 null，
  // 不伪造一个空投影，避免下游把“未加载”当成“没有”。
  const pendingGuideProjection = snapshot ? projectPendingGuideQueue(snapshot.queue) : null;
  // [事务] 浮层内容有且只有两态：已发布（成功 Dock）与未发布（确认 Dock）。
  // 已发布时不再渲染确认面板，避免用户以为还能改参数；改动参数只能先取消/重新编辑。
  // [失败路径] readOnly 或无 sessionId 时直接 null：只读观察视图不能发起分享，
  // 草稿会话没有 share dock 记录，渲染任何一个 Dock 都会读到空状态。
  // preflightChecking 覆盖 checking/stale/idle-有选中：三种都意味着“结果还不可用”，
  // 必须显示加载而不是让确认按钮短暂可点。
  const sharePopoverContent =
    readOnly || !sessionId ? null : publishedShareUrl ? (
      <ConversationShareSuccessDock
        url={publishedShareUrl}
        title={shareTitle}
        warnings={shareWarnings}
        onOpen={handleOpenPublishedShare}
        onCopy={handleCopyPublishedShare}
        onDismiss={handleShareCancel}
      />
    ) : (
      <ConversationShareConfirmationDock
        preflightChecking={
          sharePreflight.status === "checking" ||
          sharePreflight.status === "stale" ||
          (sharePreflight.status === "idle" && preflightShareProductTurnIds.length > 0)
        }
        selectionEditing={shareSelectionPanelVisible}
        publishDisabled={
          sharePreflight.status !== "ready" || sharePreflight.blockingIssues.length > 0
        }
        preflightContent={sharePreflightContent}
        selectedCount={selectedShareProductTurnIds.length}
        totalCount={eligibleShareProductTurnIds.length}
        title={shareTitle}
        accessMode={shareDraft?.accessMode ?? DEFAULT_CONVERSATION_SHARE_ACCESS_MODE}
        progressLabel={intl.formatMessage({
          id:
            shareProgress === "uploading"
              ? "conversationShare.progress.uploading"
              : shareProgress === "checking"
                ? "conversationShare.progress.checking"
                : "conversationShare.progress.collecting",
        })}
        progressPhase={shareProgress}
        completedArtifacts={shareCompletedArtifacts}
        totalArtifacts={shareTotalArtifacts}
        pending={sharePublishing}
        error={shareError}
        warnings={shareWarnings}
        onDismissError={handleDismissShareError}
        onDismissWarnings={handleDismissShareWarnings}
        onCopyRequestId={handleCopyShareRequestId}
        onDeselectTurn={handleDeselectShareTurn}
        onTitleChange={handleShareTitleChange}
        onAccessModeChange={handleShareAccessModeChange}
        disclosureAccepted={shareDisclosureAccepted}
        onDisclosureAcceptedChange={handleShareDisclosureAcceptedChange}
        onCancel={handleShareCancel}
        onEditSelection={handleEditShareSelection}
        onConfirm={handleShareConfirm}
      />
    );
  // [事务] 底部 dock 的挂载顺序即优先级（INV-18）：配额 → 恢复 → hook 审核 → 队列 →
  // 交互 → Composer → 推荐。顺序影响用户先看到什么，也影响键盘焦点顺序；
  // 不能在中间插入新的区块而不更新这里与右下角的渲染顺序。
  // [权衡] readOnly 时整块为 null：观察视图不应出现任何可写入口，包括“重发上次命令”。
  const conversationBottomDockContent = readOnly ? null : (
    <>
      {quotaBanner.state.visible &&
      !quotaBanner.dismissed &&
      (!projectedComposerError || quotaBanner.takesOverError || quotaBanner.state.blocksSubmit) ? (
        <ConversationQuotaBanner
          state={quotaBanner.state}
          onShown={quotaBanner.markShown}
          billingDiscountActive={billingDiscount.active}
          billingDiscountConfig={billingDiscount.config}
          upgradeActionLabelId={quotaBanner.upgradeActionLabelId}
          onUpgrade={
            quotaBanner.upgradeProviderId && codingPlanUpgradeDialog
              ? handleOpenQuotaUpgrade
              : undefined
          }
          onDismiss={quotaBanner.dismiss}
        />
      ) : null}
      {recoverableCommand ? (
        <PendingCommandRecoveryBanner
          entry={recoverableCommand}
          onResend={
            recoverableCommand.replay.kind === "input" ? handleResendPendingCommand : undefined
          }
          onDismiss={handleDismissPendingRecovery}
        />
      ) : null}
      {sessionId && snapshot?.workspaceHookAdmission ? (
        <WorkspaceHookPendingBanner
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          admission={snapshot.workspaceHookAdmission}
        />
      ) : null}
      {sessionId && snapshot ? (
        <ConversationQueuePanel
          key="conversation-queue"
          queue={pendingGuideProjection?.visibleQueue ?? snapshot.queue}
          onDeleteItem={handleDeleteQueueItem}
          onEditItem={handleEditQueueItem}
          pendingEditQueueItemId={
            queueEditActiveForCurrentComposer ? queueEditOperation.queueItemId : null
          }
          onSendNow={handleSendQueuedNow}
          onMoveItem={handleReorderQueueItem}
          onResume={handleResumeQueue}
        />
      ) : null}
      {/* Bugfix: v4 权限/问答等待态只是 runtime 的阻塞交互，必须和 composer
          共享 timeline bottom dock；渲染在 SessionPane 外层会脱离主列宽度并挤占下半屏。 */}
      {sessionId && snapshot ? (
        <V4InteractionDialogs
          key="conversation-interactions"
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          provider={provider}
          snapshot={snapshot}
          onPlanInteractionAccepted={
            compactForRemoteControl ? handleMobilePlanInteractionAccepted : undefined
          }
        />
      ) : null}
      {composerNode}
      {/* 办公模式显示主动任务推荐；编程模式保留原有小型场景入口。 */}
      {/* 完整视图浮窗只露出输入框，草稿推荐提示不进入浮窗。 */}
      {isDraft &&
      !isFloatingPresentation &&
      (!isOfficeMode || sharedSettings?.proactiveSuggestionsEnabled === true) ? (
        <ConversationDraftSuggestedPromptsContainer
          className={isOfficeMode ? "mt-4" : "mt-6"}
          proactive={isOfficeMode}
          onOpenAutomations={
            onOpenAutomationsMain && !compactForRemoteControl
              ? (automationTab) => onOpenAutomationsMain(undefined, automationTab)
              : undefined
          }
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          isDesktop={isDesktop}
        />
      ) : null}
    </>
  );
  // 插件 ui/message 的图片走与粘贴截图相同的 v4 attachmentPut；草稿（无 sessionId）没有插件 UI。
  const pluginUiUploadAttachment = useCallback(
    async (input: { fileName: string; mime: string; dataBase64: string }) => {
      if (!sessionId) throw new Error("Plugin UI attachments need an open session");
      const { ref } = await attachmentPut({ sessionId, ...input });
      const padding = input.dataBase64.endsWith("==") ? 2 : input.dataBase64.endsWith("=") ? 1 : 0;
      return {
        ref,
        fileName: input.fileName,
        mime: input.mime,
        bytes: Math.floor((input.dataBase64.length * 3) / 4) - padding,
      };
    },
    [attachmentPut, sessionId],
  );
  // 分享浮窗不再替换输入区，保持 Composer 与对话滚动位置稳定。
  const conversationBottomDock = conversationBottomDockContent ? (
    <ConversationBottomDockTransition mode="chat">
      {conversationBottomDockContent}
    </ConversationBottomDockTransition>
  ) : null;

  return (
    <PluginUiSessionProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      sessionId={runtimeReady ? sessionId : null}
      readOnly={readOnly || !runtimeReady}
      sendText={dispatchSendText}
      uploadAttachment={pluginUiUploadAttachment}
      projectionStore={sessionLeaseReady ? lease?.store : null}
    >
      <div
        ref={paneRef}
        data-testid={testId(TID_V4_SESSION_PANE, paneId)}
        data-session-id={sessionId ?? "draft"}
        data-initial-draft-provider={initialDraftConfigForDiagnostics?.provider ?? ""}
        data-initial-draft-model={initialDraftConfigForDiagnostics?.model ?? ""}
        data-projection-seq={snapshot?.seq ?? ""}
        data-running-subagent-ids={subagents.running.map((item) => item.childSessionId).join(",")}
        data-running-subagent-work-ids={(snapshot?.backgroundWorks ?? [])
          .filter((work) => work.kind === "subagent" && work.status === "running")
          .map((work) => work.childSessionId ?? work.workId)
          .join(",")}
        data-v4-conversation-drop-target="true"
        onDragOver={effectiveDropTargetController?.onDragOver}
        onDragLeave={effectiveDropTargetController?.onDragLeave}
        onDrop={effectiveDropTargetController?.onDrop}
        className={cn(
          "relative flex h-full min-h-0 flex-col",
          compactForRemoteControl && "min-w-0",
        )}
      >
        {effectiveDropTargetController?.active ? (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>
                {intl.formatMessage({
                  id:
                    effectiveDropTargetController.kind === "workspace"
                      ? "chat.composer.workspaceFileDragHint"
                      : "chat.attachments.dragHint",
                })}
              </span>
            </div>
          </div>
        ) : null}
        <ConversationHeader
          title={snapshot?.meta.title ?? ""}
          onClosePane={onClosePane}
          workspaceBadge={workspaceBadge}
        />

        <div
          ref={conversationLayoutContainerRef}
          className={cn(
            "@container/conversation relative flex min-h-0 flex-1 flex-col",
            compactForRemoteControl && "min-w-0",
          )}
        >
          {sessionId && !compactForRemoteControl ? (
            <ConversationSharePopover
              key={sessionId}
              sessionId={sessionId}
              open={shareActive}
              publishing={sharePublishing}
              selecting={shareSelectionPanelVisible}
              onClose={handleShareCancel}
              onCancelSelection={dismissShareSelectionPanel}
            >
              {sharePopoverContent}
            </ConversationSharePopover>
          ) : null}
          <ConversationShareSelectionPanel
            visible={shareSelectionPanelVisible}
            items={shareItems}
            selectedRowIds={pendingShareRowIds}
            selectedCount={pendingShareTurnCount}
            preflight={sharePreflight}
            onSelectAllChange={handleSelectAllShareRows}
            onToggle={handleShareSelectionToggle}
            onInspect={handleShareSelectionInspect}
            onConfirm={handleConfirmShareSelection}
            onCancel={dismissShareSelectionPanel}
          />
          {!isDraft ? (
            <ConversationStatusPanel
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              gitSummary={gitSummary}
              gitDirtyFileCount={gitDirtyFileCount}
              gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
              gitWorktreeChangeSummary={gitWorktreeChangeSummary}
              activeTaskChangeSummary={activeTaskChangeSummary}
              goal={selectionSideChat ? null : (snapshot?.goal ?? null)}
              sessionPlans={state.sessionPlans}
              plan={snapshot?.plan ?? null}
              backgroundWorks={snapshot?.backgroundWorks ?? []}
              runningSubagents={subagents.running}
              workflowRuns={snapshot?.workflowRuns?.runs ?? []}
              endedSubagentCount={subagents.endedTotal}
              rootSessionId={rootSessionId ?? sessionId ?? undefined}
              parentSessionId={sessionId ?? undefined}
              isWebRemoteControl={compactForRemoteControl}
              isMobileViewport={isMobileTextInputViewport}
              layoutMode={statusPanelLayout}
              summaryPanelVariantOverride={effectiveSummaryPanelVariantOverride}
              onVariantChange={handleSummaryPanelVariantChange}
              terminalSectionOpen={terminalSectionOpen}
              onTerminalSectionOpenChange={setTerminalSectionOpen}
              agentSectionOpen={agentSectionOpen}
              onAgentSectionOpenChange={setAgentSectionOpen}
              workflowSectionOpen={workflowSectionOpen}
              onWorkflowSectionOpenChange={setWorkflowSectionOpen}
              onRefreshGit={onRefreshGit}
              onOpenGitReview={onOpenGitReview}
              onPauseGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.pauseGoal.allowed
                  ? handlePauseGoal
                  : undefined
              }
              onResumeGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.resumeGoal.allowed
                  ? handleResumeGoal
                  : undefined
              }
              onOpenPlanDetail={onOpenPlanDetail ? handleOpenPlanDetail : undefined}
              onOpenBackgroundBash={
                onOpenBackgroundBash && sessionId
                  ? (work) =>
                      onOpenBackgroundBash({
                        workspacePath,
                        workspaceIdentity: workspaceIdentity ?? undefined,
                        remoteSessionId: remoteSessionId ?? undefined,
                        rootSessionId: rootSessionId ?? sessionId,
                        sessionId,
                        workId: work.workId,
                        title: work.title,
                      })
                  : undefined
              }
              onCancelBackgroundWork={readOnly ? undefined : handleCancelBackgroundWork}
              onOpenSubagentSession={onOpenSubagentSession ? handleOpenSubagentSession : undefined}
              onOpenSubagentDirectory={
                onOpenSubagentDirectory && !compactForRemoteControl
                  ? handleOpenSubagentDirectory
                  : undefined
              }
              onOpenWorkflowRun={
                onOpenWorkflowRun && sessionId ? handleOpenWorkflowRunFromPanel : undefined
              }
              endedWorkflowRunCount={endedWorkflowRunCount}
              onOpenWorkflowRunDirectory={
                onOpenWorkflowRunDirectory && !compactForRemoteControl
                  ? handleOpenWorkflowRunDirectoryFromPanel
                  : undefined
              }
            />
          ) : null}

          {readOnly && controlLastError ? (
            <div
              role="alert"
              data-testid="v4-subagent-readonly-error"
              className="mx-4 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-ui-base text-[var(--color-danger)]"
            >
              {controlLastError.message}
            </div>
          ) : null}

          {errored && remoteAvailable ? (
            <SessionSubscriptionErrorPanel
              error={state.lastError ?? intl.formatMessage({ id: "chat.error.connectionLost" })}
              sessionId={sessionId}
              workspacePath={workspacePath}
              onReconnect={handleRetrySubscribe}
            />
          ) : (
            <SessionPluginReferenceIconBoundary
              enabled={pluginReferenceIconsEnabled}
              remoteSessionId={remoteSessionId}
              sessionId={sessionId}
              workspaceIdentity={workspaceIdentity}
              workspacePath={workspacePath}
            >
              <BotGroupDeliveryProvider
                taskId={sessionId}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
              >
                <ConversationTimeline
                  compactForRemoteControl={compactForRemoteControl}
                  scrollToBottomActionRef={timelineScrollToBottomRef}
                  scrollToQueryActionRef={timelineScrollToQueryRef}
                  selectionPanelLayoutContainerRef={conversationLayoutContainerRef}
                  rows={timelineSnapshot?.rows.window ?? []}
                  pendingGuides={timelineSnapshot ? pendingGuideProjection?.pendingGuides : []}
                  apiRetry={timelineSnapshot?.control.apiRetry ?? null}
                  totalCount={timelineSnapshot?.rows.totalCount ?? 0}
                  sessionKey={sessionId ?? "draft"}
                  scrollMemoryKey={timelineScrollMemoryKey}
                  rowContext={rowContext}
                  onFork={forkActionsEnabled ? handleFork : undefined}
                  onRetry={retryActionsEnabled ? handleRetry : undefined}
                  onFeedbackChange={
                    !readOnly && !selectionSideChat && sessionId
                      ? handleAssistantFeedback
                      : undefined
                  }
                  onEdit={editActionsEnabled ? handleEdit : undefined}
                  canLoadOlder={timelineSnapshot ? hasOlderRows(timelineSnapshot) : false}
                  loadingOlder={timelineSnapshot ? state.loadingOlder : false}
                  onLoadOlder={handleLoadOlder}
                  onLoadAllOlder={handleLoadAllOlder}
                  turnNavigatorDirectoryRevision={state.turnNavigatorDirectoryRevision}
                  bottomDock={conversationBottomDock}
                  hideTurnNavigator={shareSelectionPanelVisible && !compactForRemoteControl}
                  backgroundScrollLocked={false}
                  headerSlot={
                    // unsupportedRowCount 也要开这个门：整份副本的行都被本 build 跳过时
                    // rows 为空，但只读块必须留下来显示「需要更新 ZCode」，不能整块消失。
                    importedShare &&
                    (importedShare.rows.length > 0 || importedShare.unsupportedRowCount > 0) ? (
                      <ConversationShareImportNotice
                        rows={importedShare.rows}
                        contentBlocks={importedShare.contentBlocks}
                        unsupportedRowCount={importedShare.unsupportedRowCount}
                        artifactNames={importedShareArtifactNames}
                        artifactWorkspaceRelativePaths={importedShareArtifactWorkspaceRelativePaths}
                        workspacePath={workspacePath}
                        {...(workspaceIdentity ? { workspaceIdentity } : {})}
                        {...(remoteSessionId ? { workspaceRemoteSessionId: remoteSessionId } : {})}
                        locale={locale}
                        theme={theme}
                        codePreviewSettings={codePreviewSettings}
                        onOpenShareUrl={onOpenBrowserUrl ? handleOpenImportedShareUrl : undefined}
                        onOpenFileLink={onOpenFileLink}
                        onOpenCodeViewer={onOpenCodeViewer}
                      />
                    ) : null
                  }
                  emptyState={
                    !remoteAvailable ? (
                      <div className="p-6 text-center text-ui-base text-foreground-subtle">
                        {intl.formatMessage({ id: "remote.conversation.placeholder" })}
                      </div>
                    ) : isDraft ? (
                      <div data-testid={TID_CHAT_EMPTY} className="w-full">
                        <ConversationDraftEmptyState
                          compactForRemoteControl={compactForRemoteControl}
                        />
                      </div>
                    ) : null
                  }
                  // 浮窗形态只露出底部输入区，空会话也必须贴底，不能居中。
                  centerEmptyStateWithDock={isDraft && !isFloatingPresentation}
                  floatingComposerDock={isFloatingPresentation}
                  onComposerDockHeightChange={
                    isFloatingPresentation && focused
                      ? panePresentation.reportComposerDockHeight
                      : undefined
                  }
                  onLatestTurnSummaryChange={
                    isFloatingPresentation && focused
                      ? handleFloatingLatestTurnSummaryChange
                      : undefined
                  }
                  compactEmptyStateWithDock={compactForRemoteControl}
                  summaryPanelLayout={statusPanelLayout}
                  conversationFindQuery={!isDraft && focused ? conversationFindQuery : ""}
                  conversationFindActiveIndex={
                    !isDraft && focused ? conversationFindActiveIndex : -1
                  }
                  conversationFindNavigationRequestId={
                    !isDraft && focused ? conversationFindNavigationRequestId : 0
                  }
                  onConversationFindMatchStateChange={
                    !isDraft && focused ? onConversationFindMatchStateChange : undefined
                  }
                  searchResultHighlightRequest={isDraft ? null : searchResultHighlightRequest}
                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                  sessionPhase={isDraft ? undefined : snapshot?.control.phase}
                  selectionActions={
                    !isDraft &&
                    sessionId &&
                    !readOnly &&
                    !selectionSideChat &&
                    !isMobileTextInputViewport
                      ? {
                          enabled: resolveConversationSelectionTooltipEnabled({
                            selectionActionsEnabled: focused && !blockingInteractionId,
                            partialShareActive: shareActive,
                          }),
                          sideActionDisabled: selectionSideActionBlocked,
                          onAddToCurrentTask: handleAddSelectionToCurrentTask,
                          onAskInSideChat: handleOpenSelectionSideConversation,
                        }
                      : undefined
                  }
                />
              </BotGroupDeliveryProvider>
            </SessionPluginReferenceIconBoundary>
          )}
        </div>
      </div>
    </PluginUiSessionProvider>
  );
}
