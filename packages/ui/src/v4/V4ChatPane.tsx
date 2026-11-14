// INV-01 单一面板：守住位置 固定面板标识；改错故障：同一工作区出现两份会话归属。
// INV-02 归属唯一：守住位置 工作区路径传参；改错故障：面板挂到错误工作区。
// INV-03 上下文先行：守住位置 提供者包裹；改错故障：面板拿不到会话上下文。
// INV-04 断线可见：守住位置 横幅注入；改错故障：连接断开时界面无提示。
// INV-05 不可用回退：守住位置 回退组件；改错故障：远程不可用时白屏。
// INV-06 默认齐备：守住位置 解构默认值；改错故障：渲染体里出现未定义分支。
// INV-07 透传不改写：守住位置 属性原样下传；改错故障：下游记忆化被新对象击穿。
// INV-08 打开归因：守住位置 触发来源默认值；改错故障：埋点把侧栏打开记成其它入口。
// INV-09 只读透传：守住位置 只读开关；改错故障：只读面板出现编辑入口。
// INV-10 草稿语义：守住位置 空会话标识；改错故障：空值被当成真实会话去订阅。
// INV-11 桌面标记：守住位置 桌面开关；改错故障：模板埋点在非桌面环境触发。
// INV-12 远程紧凑：守住位置 紧凑开关；改错故障：远程控制界面出现完整布局。
// INV-13 查找三元：守住位置 查询与索引默认值；改错故障：查找态在未搜索时被激活。
// INV-14 高亮请求：守住位置 请求对象透传；改错故障：搜索结果无法定位。
// INV-15 回调可选：守住位置 全部可选回调；改错故障：未接回调时点击报错。
// INV-16 无本地状态：守住位置 组件体；改错故障：面板在本地缓存会话导致不同步。
// INV-17 无副作用：守住位置 渲染路径；改错故障：渲染期间触发导航或订阅。
// INV-18 接口即契约：守住位置 属性类型；改错故障：外壳与面板对字段理解分叉。
//
// 模块职责：以工作区为界装配会话上下文与主面板，并把外壳属性原样下传。
// 状态所有权：会话与连接状态归上下文层；本组件不持有状态。
// 阅读顺序：属性接口 → 解构默认 → 提供者 → 回退与横幅 → 主面板。
import {
  RemoteConversationBanner,
  RemoteConversationDisconnected,
} from "@/project-sidebar/RemoteConversationDisconnected.js";
import type { ReactNode } from "react";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type {
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { V4ConversationProvider } from "@/v4/V4ConversationContext.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

// 属性全部由外壳传入，组件不读取全局状态。
// 可选属性都有明确默认，避免在渲染体里补默认值。
//
export interface V4ChatPaneProps {
  // 工作区路径是会话归属的唯一依据。
  // 随面板挂载固定，切换工作区由外壳重建。
  //
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt 模板埋点当前仅覆盖 Desktop。 */
  isDesktop?: boolean;
  readOnly?: boolean;
  allowEscapeStopOutsidePane?: boolean;
  compactForRemoteControl?: boolean;
  /** CLI session id；null = draft 首发。 */
  sessionId: string | null;
  /** 当前 workspace 主 pane 的打开入口，未提供时按 sidebar 统计。 */
  // 未指定时按侧栏统计，保持埋点口径一致。
  // openTrigger 只影响埋点归因，不改变打开行为。
  //
  openTrigger?: SessionOpenTrigger;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /** deleteSession：删除当前会话后回到 draft。 */
  onSessionDeleted?: () => void;
  /** 草稿态 composer contextHeader（m5，壳层构造下发）。 */
  draftComposerHeader?: ReactNode;
  // 仓库摘要为空表示当前不是仓库。
  // gitSummary 为空时下层不展示评审入口。
  //
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
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  // conversationFindQuery 为空时默认不启用搜索态。
  // 索引默认负一表示尚未定位。
  //
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

/**
 * 竖切聊天区：替换 ChatView 的最小入口。
 * 外层按 workspace 包 V4ConversationProvider；单 pane paneId 固定 workspace-main。
 */
// 外层用 V4ConversationProvider 包上下文，内层固定单一面板。
// paneId 固定为 workspace-main，保证会话归属稳定。
// unavailableFallback 与断线横幅由 Provider 统一注入。
// 其余 props 原样透传给会话面板，不做二次解释。
//
export function V4ChatPane({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  allowEscapeStopOutsidePane = false,
  compactForRemoteControl = false,
  sessionId,
  openTrigger = "sidebar",
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
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
}: V4ChatPaneProps) {
  // 结构只有上下文提供者与单一面板两层。
  // 不在此处做分支渲染，避免状态与归属错位。
  //
  return (
    // 不可用回退与断线横幅都带上会话与工作区。
    // 两者由 V4ConversationProvider 决定何时展示。
    //
    <V4ConversationProvider
      sessionId={sessionId ?? null}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      unavailableFallback={
        <RemoteConversationDisconnected
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={sessionId}
        />
      }
      disconnectedBanner={
        <RemoteConversationBanner
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={sessionId}
        />
      }
    >
      <SessionPane
        paneId="workspace-main"
        readOnly={readOnly}
        allowEscapeStopOutsidePane={allowEscapeStopOutsidePane}
        sessionId={sessionId}
        openTrigger={openTrigger}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        isDesktop={isDesktop}
        compactForRemoteControl={compactForRemoteControl}
        provider={provider}
        onSessionCreated={onSessionCreated}
        onSessionDeleted={onSessionDeleted}
        draftComposerHeader={draftComposerHeader}
        gitSummary={gitSummary}
        gitDirtyFileCount={gitDirtyFileCount}
        gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
        gitWorktreeChangeSummary={gitWorktreeChangeSummary}
        activeTaskChangeSummary={activeTaskChangeSummary}
        summaryPanelVariantOverride={summaryPanelVariantOverride}
        onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
        onRefreshGit={onRefreshGit}
        onOpenGitReview={onOpenGitReview}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenAutomationsMain={onOpenAutomationsMain}
        onOpenCodeViewer={onOpenCodeViewer}
        onAutoOpenAssistantPptx={onAutoOpenAssistantPptx}
        onOpenFileLink={onOpenFileLink}
        onOpenSubagentSession={onOpenSubagentSession}
        onOpenBackgroundBash={onOpenBackgroundBash}
        onOpenSubagentDirectory={onOpenSubagentDirectory}
        onSyncSubagentSessionTabs={onSyncSubagentSessionTabs}
        onOpenPlanDetail={onOpenPlanDetail}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        onOpenWorkflowRunDirectory={onOpenWorkflowRunDirectory}
        onOpenWorkflowActorSession={onOpenWorkflowActorSession}
        onOpenWorkflowWorkspace={onOpenWorkflowWorkspace}
        conversationFindQuery={conversationFindQuery}
        conversationFindActiveIndex={conversationFindActiveIndex}
        conversationFindNavigationRequestId={conversationFindNavigationRequestId}
        onConversationFindMatchStateChange={onConversationFindMatchStateChange}
        searchResultHighlightRequest={searchResultHighlightRequest}
        onSearchResultHighlightDone={onSearchResultHighlightDone}
      />
    </V4ConversationProvider>
  );
}
