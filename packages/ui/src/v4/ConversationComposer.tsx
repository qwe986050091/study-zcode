// 本文件是 v4 会话输入区的唯一装配点：把编辑器、附件、上下文 chip、草稿持久化、
// 发送门禁与工具条拼成一台状态机。它只拥有“未提交的草稿”与编辑器实例，
// 已提交的消息/队列/运行态一律读 snapshot 投影，禁止在此维护第二事实源。
//
// INV-01：composer 只拥有草稿与编辑器实例，不拥有已提交队列、消息与运行态；这些必须
//         从 snapshot 投影读取（守住它的位置：ConversationComposerImpl 的入参解构）。
// INV-02：draftScopeId 由 sessionId 或 rootDraftScopeKey 推导；提交期间不得重算，
//         发送开始时必须冻结成 submittedScopeKey（守住它的位置：submit 内 submittedScopeKey）。
// INV-03：草稿落盘必须经 updateComposerContent，且 suppressDraftPersistRef 为 true 时
//         禁止任何写盘；否则已发送正文会被当成草稿恢复（守住它的位置：persistDraftNow）。
// INV-04：scope 切换顺序固定为：清旧 timer → 记录旧正文 → 判定 transfer → 落新 scope →
//         恢复正文；换序会让用户看到上一会话的内容（守住它的位置：scope switch effect）。
// INV-05：草稿恢复优先级为 editorStateJson > 结构化 mention > 纯文本；editorStateJson
//         解析失败只能降级并告警，不能抛出中断恢复（守住它的位置：restorePersistedComposerDraftIntoInput）。
// INV-06：canSend 是 disabled/pending/内容/路由/附件就绪/Submission/runtime 的合取；
//         任何一项缺失都不得放行（守住它的位置：canSend 的声明）。
// INV-07：submit 内必须重新计算门禁，不能信任按钮 disabled；按钮点击与 Enter 共用同一条
//         submit 路径，否则两条入口会各自漂移（守住它的位置：submit 开头的早退条件）。
// INV-08：pending 是单一在途提交闩锁，必须在 finally 复位；任何提前 return 都不能跳过
//         复位，否则 composer 永久卡在发送中（守住它的位置：submit 的 try/finally）。
// INV-09：附件发送只消费 prepareForSend 返回的就绪快照；返回 null 时不得回落重新上传，
//         否则会把“未完成”伪装成“已发送”（守住它的位置：prepareForSend 的返回值判断）。
// INV-10：乐观清空只对 requestedDelivery === "startNow" 生效；其余投递必须等权威结算，
//         提前清空会让用户在拒绝时看到正文凭空消失（守住它的位置：editorClearedOptimistically）。
// INV-11：失败回滚只恢复“用户没有继续编辑”的正文，判据是 contentRevisionRef 未变化；
//         否则会用旧失败回包覆盖用户新输入（守住它的位置：restoreSubmittedDraft）。
// INV-12：结算清理必须使用发送瞬间捕获的 id 列表，禁止回读发送后的可变数组；promotion
//         或并发增删都会让“清空”误伤下一次提交（守住它的位置：settleSubmittedContent）。
// INV-13：prompt history 必须在真实发送前同步写盘；失败回滚前先比对当前值等于写入值，
//         不相等说明他人已写入，只能刷新 state 而不能覆盖（守住它的位置：rollbackPromptHistory）。
// INV-14：一次提交只创建一个 telemetry seed；队列二次确认必须复用首次 seed，保证
//         send_click 与 send_result 严格一一配对（守住它的位置：existingTelemetrySeed 分支）。
// INV-15：recordSendClick 的返回值必须回填为 seed，丢弃它会让后端拿不到关联键，
//         send_result 被判定为后台任务而丢弃（守住它的位置：conversationTelemetry?.recordSendClick）。
// INV-16：队列确认弹窗冻结 queueItemIds 与 delivery；跨端 stale 时用最新投影替换并
//         要求重新确认，不能静默沿用旧 id（守住它的位置：confirmationRequired 分支）。
// INV-17：外部文本插入与草稿恢复请求都以 requestId 幂等；允许下一帧重试，但同一
//         requestId 不得重复应用（守住它的位置：applied*RequestRef 的读写）。
// INV-18：自动聚焦先置 pendingFocusRef 再尝试兑现；disabled 时只暂存意图，恢复可编辑
//         后必须兑现一次（守住它的位置：flushPendingFocus / requestComposerFocus）。
// INV-19：程序性聚焦与用户点击共享同一个 DOM focus 事件，必须用一次性标记区分，
//         否则会把回焦误报成用户行为（守住它的位置：programmaticFocusRef）。
// INV-20：Enter 语义统一由 enterSubmits / modifiedEnterSubmits 裁决（含 IME 与手机视口），
//         组件内不得另写平台判断，否则三端行为会分叉（守住它的位置：handleEditorSubmit）。
// INV-21：上下文沿用固定序列化顺序（selection → code comment → web → pptx → plugin），
//         发送成功后再按捕获列表逐类清空；顺序变化会让历史解析错位（守住它的位置：serializeComposerPromptContexts）。
// INV-22：共享上下文只能从 snapshot 推导，不得读取平行 prop；平行 prop 曾经无人传入，
//         导致首条消息永远不带 sharedContextRefs（守住它的位置：resolveAttachableShareContext）。
// INV-23：被 bottom dock 阻塞时 composer 只隐藏不卸载；卸载会丢失草稿、附件与编辑器
//         内部状态（守住它的位置：isBlockedByInteraction 的 render 分支）。
// INV-24：config picker 状态按 scopeKey 归属；跨 scope 必须立即归零，旧 Radix layer 的
//         迟到 close 事件一律丢弃（守住它的位置：handleConfigPickerOpenChange）。
// INV-25：附件网格的展示顺序（媒体优先）只影响渲染，不得改变上传与发送集合；发送集合
//         永远以 attachmentsApi.attachments 为准（守住它的位置：orderedComposerAttachments）。
// INV-26：composer 不得直接操作宿主 tab/导航；重连、打开设置等动作一律经注入回调，
//         否则桌面与 Web 壳会各自产生一条旁路（守住它的位置：onOpenModelSettings / reconnectProject）。
// INV-27：draft 持久化是防抖 350ms 的“最终一致”，pagehide/blur 必须强制 flush；
//         只靠防抖会在关窗时丢掉最后一段输入（守住它的位置：pagehide effect）。
import { ComposerSubmissionPendingContext } from "@/project-sidebar/index.js";
/* oxlint-disable eslint(max-lines) -- composer 集中收口输入区 wiring（附件/草稿/历史/mention），拆分会打散收口粒度。 */
import { useRemoteProjectReconnect } from "@/hooks/RemoteProjectPresentationContext.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
/**
 * v4 会话 composer（composer parity）。
 *
 * 壳：ChatPromptEditor（Lexical 编辑器 + 动作菜单 + 拖拽反馈 + sticky 底座视觉），
 * 附件预览网格/大图预览/错误提示区一并提供。
 *
 * 芯：全新 v4 wiring——
 * - 路由/状态一律读 v4 投影 snapshot.inputRouting / control / config / usage；
 * - 发送键状态机对齐旧 UI：canSend（有文本或附件+路由允许）/ pending spinner /
 *   running+空草稿 → Stop（v4 stop 命令）/ 暂停队列（choice）→ 发送后弹清空/保留确认框；
 * - 附件全链路见 useComposerAttachments（发送经 v4 sendText attachments）；
 * - mention（@ 文件/画板、# 会话、$ 技能）与 slash 目录全集在 LexicalChatInput 内接线；
 * - 草稿 per-session 持久化（composerDraftStore）+ prompt history（promptHistoryStorage）；
 * - 工具条（模型/思考深度/模式/context usage）见 V4ComposerToolbar。
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { HighspeedComposerBackground } from "@/highspeed/HighspeedActivationVisual.js";
import { useHighspeedComposerEntrance } from "@/highspeed/useHighspeedComposerEntrance.js";
import {
  type HighspeedCardSnapshot,
  type PlanIdentitySnapshot,
  type ZCodeProvider,
} from "@zcode/shared";
import {
  TID_CHAT_ATTACHMENT_BUTTON,
  TID_CHAT_ATTACHMENT_MENU_ITEM,
  TID_V4_COMPOSER,
  TID_V4_COMPOSER_CLEAR_QUEUE_SEND,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_KEEP_QUEUE_SEND,
  TID_V4_COMPOSER_SEND,
  TID_V4_PAUSED_QUEUE_SEND_DIALOG,
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  TID_V4_STOP,
  testId,
} from "@zcode/shared/test-ids";
import type {
  AttachmentRef,
  ConversationSnapshot,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ArrowUpIcon,
  ClipboardPenLineIcon,
  InfoIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  ChatErrorBanner,
  resolveChatErrorBannerDisplayMessage,
  shouldSuppressChatErrorBanner,
  type ChatErrorBannerModelConfigTarget,
} from "@/ChatErrorBanner.js";
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { advanceComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { runUserAction, startUserAction } from "@/lib/userActionTelemetry.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  isImageChatComposerAttachment,
  isPdfChatComposerAttachment,
  isMediaChatComposerAttachment,
  isVideoChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { resolveChatPlaceholderKey } from "@/lib/chatPlaceholder.js";
import {
  resolveChatEnterShortcut,
  resolveChatEnterSubmits,
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import { appendPromptHistoryEntry } from "@/lib/promptHistory.js";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  readWorkspaceFileDragPayload,
  isWorkspaceFileAddToChatEvent,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { resolveProviderBaseURL } from "@/lib/registryProviderView.js";
import type { ModelSelectionView } from "@zcode/services";
import type {
  ModelSelectionState,
  ModelSelectionRefreshResult,
} from "@/hooks/useModelSelectionView.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  resolveComposerAutoFocus,
  type ComposerAutoFocusOptions,
} from "@/v4/composer/composerAutoFocus.js";
import { V4_DRAFT_SCOPE_ROOT, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  resolveOppositeFollowupDelivery,
  resolveFollowupModifierTooltip,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { usePrimaryFollowupModifier } from "@/v4/composer/usePrimaryFollowupModifier.js";
import {
  consumeV4ComposerDraftAttachments,
  registerV4ComposerDraftReader,
  consumeV4ComposerDraftWorkspaceTransferRequest,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import { removeCodeCommentPreview } from "@/v4/composer/codeCommentPreviewSync.js";
import {
  countComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import {
  PluginUiModelContextChip,
  usePluginUiContextImages,
  usePluginUiModelContexts,
} from "@/plugin-ui/index.js";
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import { ConversationBackgroundWorkTrigger } from "@/v4/composer/ConversationBackgroundWorkTrigger.js";
import { V4ComposerCuaEntry } from "@/v4/composer/V4ComposerCuaEntry.js";
import {
  V4ComposerModeSwitch,
  V4ComposerModelControls,
  type ModelSelectionSource,
} from "@/v4/composer/V4ComposerToolbar.js";
import {
  resolveV4ComposerConfigPickerState,
  type V4ComposerConfigPicker,
} from "@/v4/composer/configPickerState.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import type { AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { buildV4ConversationPromptTelemetryExtraDetail } from "@/v4/telemetry/conversationPromptTelemetry.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import {
  subscribeComposerSubmissionSettled,
  trackUnsettledComposerSubmission,
} from "@/v4/composer/composerSubmissionSettlement.js";
import { resolveAttachableShareContext } from "@/lib/conversationShareContext.js";

// 模型视图未就绪时的稳定占位。用模块级常量而不是每次新建对象，是为了让下游
// useMemo 依赖比较拿到同一引用，避免流式刷新期间重复重建工具条子树。
const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

// 发送选项是 composer 与宿主之间的“意图清单”：renderer 只描述用户本次想怎么发，
// 协议组装、鉴权与重试都在宿主侧完成。字段全部可选，因为按钮、快捷键、插件代发
// 能提供的信息不同；宿主必须把缺失字段理解为“未提供”，不能自行补默认值。
export interface ConversationComposerSendOptions {
  /** 原始正文供接纳恢复对账；协议正文可能已经附加文件或页面上下文。 */
  submittedDraftText?: string;
  /** 点击发送时复制的配置；null 表示未完成选择，Host 不得从 Session 补齐。 */
  submission?: ComposerSubmissionConfig | null;
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
  /** 发送确认框打开时看到的暂停队列 ID；CLI 用它拦截跨端增删竞态。 */
  expectedHeldQueueItemIds?: readonly string[];
  /** 附件命令面：已序列化附件（宿主转 AttachmentRef 后随 v4 sendText/createSession 发送）。 */
  attachments?: AttachmentRef[];
  /** Prompt 文本内携带的上下文附件数量；用于阻止 /goal 等本地命令误消费。 */
  contextAttachmentCount?: number;
  conversationQuotes?: import("@zcode/shared").ConversationSelectionText[];
  /** renderer-only：ACK accepted 后由 SessionPane 绑定真实 commandId/sessionId。 */
  telemetrySeed?: ConversationPromptTelemetrySeed;
  /** 本次 busy input 的一次性投递覆盖，不改 session 偏好。 */
  requestedDelivery?: "startNow" | "queue" | "guide";
  /** 提交命令创建后由 Composer 订阅权威 projection，覆盖 ACK 丢失后的收口。 */
  onCommandCreated?: (commandId: string) => void;
  sharedContextRefs?: Array<{ kind: "shared_context_import"; context_id: string }>;
  /** 插件 UI 代发：随 sendText 持久化，用户消息卡片显示"来自插件 X"。 */
  source?: import("@zcode/shared/zcode-protocol-v4").ConversationInputSource;
}

// 三态返回值决定 composer 的后续动作：sent 走结算清理，blocked 回滚并保留草稿，
// confirmationRequired 弹队列确认框。状态集合必须保持封闭，新增状态会让调用方漏分支。
export type ConversationComposerSendResult = "sent" | "blocked" | "confirmationRequired";
// 附件角标只用于展示：优先取扩展名，取不到才退回 MIME 子类型。
// 这里不承担格式校验，未知类型也必须返回可显示文本，否则角标会空白。
function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

// 外部预填请求携带 requestId，用于同一文本连续两次取回时仍能各触发一次插入。
// mode 决定是覆盖正文还是“仅当缺失时前置”：后者用于安装完成后的回放，避免覆盖
// 用户在安装期间已经写下的内容。
export interface ExternalTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

// 把持久化草稿写回编辑器。三条路径按保真度降序尝试：
//   1) editorStateJson 能完整还原 mention pill 与段落结构；
//   2) 结构化 mention + 尾部纯文本，用于 JSON 不可用的旧草稿；
//   3) 纯文本兜底。
// 任何一步失败都只降级并告警，不向上抛错：草稿恢复失败不应阻止用户继续输入。
export function restorePersistedComposerDraftIntoInput({
  draft,
  inputApi,
  onEditorStateError,
}: {
  draft: Pick<V4ComposerDraft, "editorStateJson" | "mention" | "text">;
  inputApi: Pick<
    LexicalChatInputHandle,
    "getMarkdown" | "setEditorStateJson" | "setMention" | "setText"
  >;
  onEditorStateError?: (error: unknown) => void;
}): string {
  if (draft.editorStateJson) {
    try {
      inputApi.setEditorStateJson(draft.editorStateJson);
      return inputApi.getMarkdown();
    } catch (error) {
      onEditorStateError?.(error);
    }
  }
  if (draft.mention && draft.text.startsWith(draft.mention.markdown)) {
    // Workspace 插件详情会卸载聊天 Composer。结构化 mention 必须从共享草稿事实源恢复，
    // 不能只依赖一次性插入事件，否则重挂载时会退化成 canonical 普通文本。
    inputApi.setMention(draft.mention, draft.text.slice(draft.mention.markdown.length));
    return draft.text;
  }
  inputApi.setText(draft.text);
  return draft.text;
}

// 应用一次性外部文本插入。requestId 相等即视为已应用并原样返回，保证 StrictMode
// 双调用与下一帧重试都不会重复插入同一段文本。
// prepend-if-missing 走节点级前置以保留用户当前正文；其余模式按 mention 形态分派，
// 返回新的 appliedRequestId 由调用方落库并回执宿主。
export function applyExternalTextInsertRequestToComposer({
  appliedRequestId,
  inputApi,
  request,
  requestFocus,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  inputApi: Pick<
    LexicalChatInputHandle,
    | "getMarkdown"
    | "prependMentionIfMissing"
    | "setMention"
    | "setText"
    | "setTextWithPluginMentions"
  > | null;
  request: ExternalTextInsertRequest | null | undefined;
  requestFocus: () => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (!inputApi) {
    return appliedRequestId;
  }
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Bug 原因：安装完成后若回放点击时保存的旧 prompt，会覆盖用户安装期间的编辑。
    // 节点级前置保留编辑器当前的 mention 与段落结构，再从编辑器读取 canonical 草稿。
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // 根因：商店试用以前只传 canonical 文本，Lexical 无法知道开头链接是结构化 Plugin mention。
    // request 同时携带 display-only 节点数据；发送与草稿事实源仍使用 request.text 原文。
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // 推荐任务可在正文中组合多个插件；按原位置构造成真实提及节点。
    inputApi.setTextWithPluginMentions(request.text);
  } else {
    inputApi.setText(request.text);
  }
  updateText(request.text);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

// 队列“编辑”撤回的恢复请求。sessionId + workspaceKey 是绑定条件：不匹配说明用户
// 已切走，必须放弃恢复，避免把内容写进另一个会话的草稿。
export interface ComposerRestoreRequest {
  requestId: number;
  sessionId: string;
  workspaceKey: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: Pick<V4ComposerDraft, "mode" | "planEnabled" | "modelSelection">;
}

// 恢复撤回内容的前提是“目标会话仍当前、workspace 未变、草稿为空、编辑器已就绪”。
// 任一不满足就返回原 appliedRequestId，让宿主保持请求待处理而不是误判已消费；
// 附件恢复失败同理，用户仍可稍后重试。
export function applyComposerRestoreRequestToComposer({
  appliedRequestId,
  currentSessionId,
  currentWorkspaceKey,
  hasDraftContent,
  inputApi,
  request,
  requestFocus,
  restoreSessionOwnedAttachments,
  restoreDraftConfig,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  currentSessionId: string | null;
  currentWorkspaceKey: string;
  hasDraftContent: boolean;
  inputApi: Pick<LexicalChatInputHandle, "setText"> | null;
  request: ComposerRestoreRequest | null | undefined;
  requestFocus: () => void;
  restoreSessionOwnedAttachments: (attachments: readonly AttachmentRef[]) => boolean;
  restoreDraftConfig?: (config: NonNullable<ComposerRestoreRequest["config"]>) => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (
    request.sessionId !== currentSessionId ||
    request.workspaceKey !== currentWorkspaceKey ||
    hasDraftContent ||
    !inputApi
  ) {
    return appliedRequestId;
  }
  if (!restoreSessionOwnedAttachments(request.attachments)) {
    return appliedRequestId;
  }
  inputApi.setText(request.text);
  updateText(request.text);
  if (request.config) restoreDraftConfig?.(request.config);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}

// history 回滚需要判断“当前写盘值是否仍是我写入的那一份”，逐项比较即可；
// 用引用比较会因每次 read 都新建数组而永远不等，导致回滚静默失效。
function arePromptHistoryEntriesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

// 宿主注入的全部能力面。约定：composer 不直接操作宿主导航或 tab，需要重连、打开
// 设置、打开代码查看器等动作一律走这里的回调，保证桌面与 Web 两个壳只有一条路径。
export interface ConversationComposerProps {
  snapshot: ConversationSnapshot | null;
  /** 草稿 scope（sessionId；draft 态 null → "__draft__" scope）。 */
  sessionId?: string | null;
  /** Skill catalog authority；草稿预热完成后为 prewarmSessionId，不改变 task/draft 身份。 */
  skillCatalogSessionId?: string | null;
  /** draft 态无 snapshot，但仍可 createSession 首发。 */
  draftMode?: boolean;
  /** renderer 当前草稿配置意图；只在 draftMode 下覆盖迟到的 prewarm projection。 */
  draftConfig?: Partial<SessionConfigState>;
  /** SessionPane 注入的完整 Draft owner；生产路径不再由编辑器直接覆盖持久记录。 */
  composerDraft: V4ComposerDraft;
  rootDraftScopeKey?: string;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** 当前 Composer 是否能构造完整 Submission；空模型或空 Reasoning 时为 false。 */
  submissionReady?: boolean;
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null;
  /** 仅供发送埋点冻结模型维度；包含草稿初始化 config 与显式 intent 的合并值。 */
  telemetryDraftConfig?: Partial<SessionConfigState>;
  /**
   * 空态 contextHeader（m5-composer-parity）：workspace 切换菜单 + Git 分支
   * 切换器，渲染在编辑器上方（旧 ChatViewComposer contextHeaderContent 同位）。
   * 仅草稿态由宿主下发；会话建立后为空。
   */
  contextHeader?: ReactNode;
  /** 居中草稿布局（旧 shouldUseCenteredDraftChatLayout）：收窄 max-w-2xl、去 sticky。 */
  centered?: boolean;
  /** 输入框布局，见 ChatPromptEditor；inline 是 Side Pane 完整视图浮窗的单行形态。 */
  layout?: "stacked" | "inline";
  /**
   * 单行布局下对话运行中的工作时长（与流式消息「工作中 N 秒」同值），
   * 占位文字改为「工作中 {时长}」；undefined 时沿用原占位。
   */
  workingDurationMs?: number;
  /**
   * v4 bottom dock 阻塞交互 id。存在时 composer 只隐藏不卸载，保留草稿、附件与编辑器实例。
   */
  blockingRequestId?: string | null;
  disabled?: boolean;
  onRetryInitialization?: () => void;
  /** 当前 Task 可用的 Highspeed 卡；只影响静态标识和模型锁定。 */
  highspeedCard?: HighspeedCardSnapshot | null;
  /**
   * 发送路径 draw 新命中登记的一次性激活请求（值为 cardId）。
   * 命中当前卡时才播放激活动效，composer 锁定入场方式后经回调消费；切回、恢复与重挂载不重播。
   */
  highspeedActivationCardId?: string | null;
  onHighspeedActivationApplied?: (cardId: string) => void;
  /**
   * 是否在新建任务 / 切换会话 / 挂载后自动把光标聚焦到输入框（默认开）。
   * 竖切多 pane 时由宿主传入 SessionPane.focused，仅焦点 pane 聚焦、后台 pane 不抢焦点。
   */
  autoFocusEnabled?: boolean;
  /** 当前 composer 是否运行在手机 Web 远控壳中。 */
  isWebRemoteControl?: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** SessionPane 从目标 Host 原子读取的选择事实；Composer 不自行解析 Host。 */
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  /** Model Selection 首次读取失败后的显式重试入口。 */
  modelSelectionReload?: () => void;
  modelSelectionRefresh?: () => Promise<ModelSelectionRefreshResult>;
  /** 草稿态使用预热 session 作附件 transaction 载体。 */
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。 */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  provider?: ZCodeProvider;
  /** 宿主 pane 与 workspace 遮罩共同裁决的真实可见性，仅用于 visible-only telemetry。 */
  telemetryVisible?: boolean;
  /** 点击发送时读取套餐身份；二次确认会继续复用同一份冻结 seed。 */
  readPlanIdentitySnapshot?: () => PlanIdentitySnapshot;
  onSendText: (
    text: string,
    options?: ConversationComposerSendOptions,
  ) => Promise<ConversationComposerSendResult | void>;
  /** 把当前输入文本上抛给父组件（editUserQuery 用 composer 文本作 newText）。 */
  onTextChange?: (text: string) => void;
  /** queue 撤回 admission 读取的完整 composer 占用态；附件包含上传中状态。 */
  onDraftStateChange?: (state: { hasContent: boolean; busy: boolean }) => void;
  onStop: () => void;
  /** 目录选中模型（providerId/modelId）；thought/revision 由宿主从最新投影补齐。 */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void;
  /** 选中思考深度；同时带上用户操作时看到的模型，避免异步回流后把 thought 归到另一模型。 */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** 打开当前 session 的 Status panel，并直达 Running 明细。 */
  onOpenRunningBackgroundWorks?: () => void;
  /**
   * 后台任务入口点击的落点：`"workflow-run"` = 唯一在跑的工作流直达详情页（宿主判定），
   * 缺省 `"panel"` = 展开状态胶囊。入口据此换 tooltip；行为本身在 onOpenRunningBackgroundWorks 里。
   */
  backgroundWorkOpenTarget?: "panel" | "workflow-run";
  runningSubagentCount?: number;
  /** prepare/configOptions 失败时，custom provider 选择走 workspace recovery 链。 */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  /** context usage 面板的 /compact 入口（宿主走 v4 compact 命令）。 */
  onSendCompressionCommand?: (command: string) => void;
  /** v4 会话级错误（snapshot.control.lastError），展示在输入框上方。 */
  error?: ZCodeUiError | null;
  onDismissError?: () => void;
  /** 无可用模型横幅的恢复动作；由 SessionPane 注入壳层导航，组件不直接操作 tab。 */
  onOpenModelSettings?: () => void;
  onOpenModelUpgrade?: () => void;
  modelConfigTarget?: ChatErrorBannerModelConfigTarget;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /**
   * 是否监听全局「加入对话」事件（workspace file tree / 画板按钮）。
   * 分屏时仅 primary pane 监听，避免一次点击插入两份。
   */
  listenAddToChatEvents?: boolean;
  /**
   * 外部一次性文本预填请求（Example Prompt 等）。
   * requestId 保证同一文本可连续取回两次时仍能触发回填。
   */
  externalTextInsertRequest?: ExternalTextInsertRequest | null;
  onExternalTextInsertApplied?: (requestId: number) => void;
  /**
   * 队列“编辑”在 delete ACK 后把完整未来意图取回输入框。
   * requestId + session/workspace binding 保证幂等且不会串写其他 task。
   */
  composerRestoreRequest?: ComposerRestoreRequest | null;
  onComposerRestoreApplied?: (requestId: number) => void;
  /** 副屏会话不提供 goal 能力；协议层仍会拒绝直接调用。 */
  suppressGoalCommands?: boolean;
  /** App 层本地斜杠命令（如 `/side`），由 SessionPane 按门禁组装后透传。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** 把 composer 的 drop 路由暴露给整个对话 pane / 桌面草稿标题栏。 */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
}

// 行数按 locale 格式化；缺失行数按 0 处理，避免出现 NaN 或空角标文案。
function formatAttachmentLineCount(attachment: ChatComposerAttachment, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return formatter.format(typeof attachment.lineCount === "number" ? attachment.lineCount : 0);
}

// 实现组件本身不套 memo，导出时统一 memo：这样 props 比较策略全仓只有一处。
// 解构处写的默认值就是“缺省语义”，调用方传 undefined 与不传必须等价，
// 避免宿主在两种写法间得到不同行为。
function ConversationComposerImpl({
  snapshot,
  sessionId = null,
  skillCatalogSessionId = sessionId,
  draftMode = false,
  draftConfig,
  composerDraft,
  rootDraftScopeKey,
  updateComposerContent,
  replaceComposerDraft,
  submissionReady = true,
  createSubmissionFromComposer,
  telemetryDraftConfig,
  contextHeader,
  centered = false,
  layout = "stacked",
  workingDurationMs,
  blockingRequestId = null,
  disabled: disabledProp = false,
  onRetryInitialization,
  highspeedCard = null,
  highspeedActivationCardId = null,
  onHighspeedActivationApplied,
  autoFocusEnabled = true,
  isWebRemoteControl = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  modelSelectionRefresh,
  attachmentSessionId = null,
  attachmentPut,
  onRuntimeRestart,
  onRuntimeLifecycle,
  provider,
  telemetryVisible = true,
  readPlanIdentitySnapshot,
  onSendText,
  onTextChange,
  onDraftStateChange,
  onStop,
  onSelectModel,
  onSelectThought,
  onSwitchMode,
  onOpenRunningBackgroundWorks,
  backgroundWorkOpenTarget = "panel",
  runningSubagentCount = 0,
  onRecoverCustomModelSelection,
  onSendCompressionCommand,
  error,
  onDismissError,
  onOpenModelSettings,
  onOpenModelUpgrade,
  modelConfigTarget = "local",
  onOpenCodeViewer,
  listenAddToChatEvents = true,
  externalTextInsertRequest = null,
  onExternalTextInsertApplied,
  composerRestoreRequest = null,
  onComposerRestoreApplied,
  suppressGoalCommands = false,
  appSlashCommands,
  onDropTargetControllerChange,
}: ConversationComposerProps) {
  // 远控可用性是全局门禁：不可用时 composer 仍渲染（保留草稿），但所有发送入口关闭。
  const remoteAvailable = useRemoteConversationAvailable();
  // 远控 workspace controller 与 reconnectProject 二选一存在：桌面壳注入 reconnect，
  // Web 远控壳注入 controller，错误横幅的重连按钮因此必须两者都判。
  const remoteController = useOptionalRemoteWorkspaceController();
  const reconnectProject = useRemoteProjectReconnect();
  // 用当前 workspace 的 Tab 反查远控目标类型，只服务错误横幅的展示，不参与发送判定。
  const remoteKind = useOptionalTabStore((state) =>
    state.tabs.find(
      (tab) =>
        tab.kind === "workspace" &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
          (workspaceIdentity?.trim() || workspacePath),
    ),
  );
  // workspace 切换确认进行中时临时禁用输入：此时 composer 即将被换成新 workspace 的实例，
  // 继续接受输入会被随后到来的 props 覆盖，用户会看到文字凭空消失。
  const [targetSelectionPending, setTargetSelectionPending] = useState(false);
  // ref 与 state 双写：提交入口在事件回调里需要同步读到最新值，不能等下一次 render。
  const targetSelectionPendingRef = useRef(false);
  const updateTargetSelectionPending = useCallback((pending: boolean) => {
    targetSelectionPendingRef.current = pending;
    setTargetSelectionPending(pending);
  }, []);
  // disabled 是“外部禁用 ∪ 远控不可用 ∪ 切换确认中”的合并结果；
  // 所有下游（编辑器、附件、发送键）都只认这一个值，避免各自漏判。
  const disabled = disabledProp || !remoteAvailable || targetSelectionPending;
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  // telemetry supervisor 按 workspace 维度作用域挂载；远程会话额外带 remoteSessionId，
  // 否则本地与远程会共用一条采样上下文。
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  // 草稿 scope 的推导规则：有 sessionId 就用会话 id；草稿态用 root 前缀 + 宿主 root key；
  // 都没有时退回全局 __draft__。同一 workspace 下多个 draft 必须靠 root key 区分，
  // 否则并排的两个草稿面板会互相覆盖。
  const draftScopeId =
    sessionId ??
    (rootDraftScopeKey ? `${V4_DRAFT_SCOPE_ROOT}:${rootDraftScopeKey}` : V4_DRAFT_SCOPE_ROOT);
  // workspaceKey 统一 identity 优先、path 兜底；手写路径比较会在远程项目切换后失配。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // picker 状态按“workspace + 草稿 scope”隔离，同进程里两个 composer 不会互相关闭菜单。
  const configPickerScopeKey = `${workspaceKey}\0${draftScopeId}`;
  // text 只是渲染镜像；同步事实在 textRef，避免异步回调读到过期闭包。
  const [text, setText] = useState("");
  // pending 是“本次提交在途”的唯一闩锁，按钮 spinner、发送禁用、重复提交防护都读它。
  const [pending, setPending] = useState(false);
  const [presentedHighspeedCardId, setPresentedHighspeedCardId] = useState<string | null>(null);
  const [highspeedSweepActive, setHighspeedSweepActive] = useState(false);
  const highspeedCardId = highspeedCard?.cardId ?? null;
  const highspeedEntrance = useHighspeedComposerEntrance({
    cardId: highspeedCardId,
    activationCardId: highspeedActivationCardId,
    onActivationApplied: onHighspeedActivationApplied,
  });
  // 入场动画只服务“本次 draw 新命中”的一次性交接；恢复、切回、重挂载都不播，
  // 否则用户每次回到任务都会被动画打断。
  const highspeedEntranceAnimated = highspeedEntrance === "activation";
  // 恢复入场（切回 Task、快照恢复、重挂载）不经扩散交接，卡片出现即呈现模型与倒计时。
  const highspeedPresented =
    highspeedCardId !== null &&
    (!highspeedEntranceAnimated || presentedHighspeedCardId === highspeedCardId);
  const handleHighspeedModelTransitionStart = useCallback(() => {
    // 只记录已完成视觉交接的卡片身份，不改变卡片有效性或发送状态。
    setPresentedHighspeedCardId(highspeedCardId);
  }, [highspeedCardId]);
  useEffect(() => {
    // 扫光属于激活动效，只在 draw 新命中的交接后播放一次。
    if (!highspeedPresented || !highspeedEntranceAnimated) {
      setHighspeedSweepActive(false);
      return;
    }
    const timer = window.setTimeout(() => setHighspeedSweepActive(true), 1_900);
    return () => window.clearTimeout(timer);
  }, [highspeedEntranceAnimated, highspeedPresented]);
  // picker 状态同时记录 scopeKey：读取时先校验 scope，避免上一个会话的关闭事件
  // 把当前会话刚打开的菜单关掉。
  const [configPickerState, setConfigPickerState] = useState<{
    scopeKey: string;
    activePicker: V4ComposerConfigPicker | null;
  }>(() => ({
    scopeKey: configPickerScopeKey,
    activePicker: null,
  }));
  // 固定 key 的 SessionPane 会跨 task/draft 复用 composer，旧 picker owner
  // 因此跟着实例进入新 scope。提交新 scope portal 前同步归零，避免菜单闪现一帧；
  // 旧 Radix layer 随后到达的 close 事件由下方 scope guard 丢弃。
  if (configPickerState.scopeKey !== configPickerScopeKey) {
    setConfigPickerState({
      scopeKey: configPickerScopeKey,
      activePicker: null,
    });
  }
  const activeConfigPicker =
    configPickerState.scopeKey === configPickerScopeKey ? configPickerState.activePicker : null;
  const handleConfigPickerOpenChange = useCallback(
    (picker: V4ComposerConfigPicker, open: boolean) => {
      // composer 内容为导航 rail 恢复 pointer-events 后，三个 Radix modal
      // picker 的独立 open 状态会在同一次 pointerdown 中竞争，旧 layer 无法可靠 dismiss。
      // 关闭回调可能晚于兄弟 picker 的打开回调，只允许它清理自己，避免误关接管者。
      setConfigPickerState((current) => {
        if (current.scopeKey !== configPickerScopeKey) {
          return current;
        }
        return {
          scopeKey: current.scopeKey,
          activePicker: resolveV4ComposerConfigPickerState(current.activePicker, picker, open),
        };
      });
    },
    [configPickerScopeKey],
  );
  // 队列确认弹窗冻结发送瞬间的队列项 id 与投递覆盖；确认时原样回传给宿主，
  // 让宿主能识别“用户看到的队列”与“当前队列”是否已跨端漂移。
  const [heldQueueConfirmation, setHeldQueueConfirmation] = useState<{
    queueItemIds: readonly string[];
    telemetrySeed: ConversationPromptTelemetrySeed;
    requestedDelivery?: "startNow" | "queue" | "guide";
  } | null>(null);
  const [sendTooltipOpen, setSendTooltipOpen] = useState(false);
  // 一组“同步事实”ref：textRef 供异步回调读取最新正文，contentRevisionRef 是内容版本号，
  // pendingRef 防重入，snapshotRef 让 submit 回调不依赖 snapshot 的每次变更。
  // 它们只在事件/effect 内读写，不参与渲染，因此不会引入额外重渲染。
  // submit 经 ref 读取最新文本/pending，避免回调随每次输入变更引用。
  const textRef = useRef("");
  const contentRevisionRef = useRef(0);
  const pendingRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // 这条线断过一次：composer 原本读一个平行的 sharedContextImport prop，而 SessionPane 从没
  // 传过它（全仓 `sharedContextImport=` 零命中），于是首条消息永远不带 sharedContextRefs。
  // 现在从必然拿到的 snapshot 推导，理由与边界见 resolveAttachableShareContext。
  // pending 态要单独取出：它既算“有草稿内容”（不能把空文本误判为可丢弃），
  // 又要随本次发送一起上传，两处判断必须引用同一个对象。
  const activeShareContext = resolveAttachableShareContext(snapshot?.sharedContextImport);
  const pendingShareContext = activeShareContext?.status === "pending" ? activeShareContext : null;
  // 编辑器命令式句柄：清空、回填 editorState、取 markdown 都经它；
  // 命令解析的取消函数集中登记，卸载时统一释放，避免订阅泄漏。
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const commandResolutionCleanupsRef = useRef(new Set<() => void>());
  // reportedErrorKeysRef 记录已上报的 key：同一次挂载内同一错误只上报一次，避免流式刷新刷出多条样本。
  const reportedErrorKeysRef = useRef(new Set<string>());
  // [并发] 视口与平台能力集中读取一次，供 Enter 语义、聚焦策略与 placeholder
  // 三处共用；分散读取会在同一帧得到不一致的视口判断。
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const primaryModifierPressed = usePrimaryFollowupModifier();
  const appleKeyboardPlatform = isAppleKeyboardPlatform();
  // Bugfix：M3 删除旧 ChatView 后，M5 只恢复了桌面端的 false 硬编码，已登记的手机远控
  // 接线没有补回，导致 Enter 误发送。恢复旧语义：手机视口下 Enter 换行并用按钮发送；
  // 桌面端仍由 resolveChatEnterSubmits 的视口门禁保持 Enter 发送。
  const enterSubmits = resolveChatEnterSubmits({
    isMobileTextInputViewport,
    preferEnterNewline: isWebRemoteControl,
  });
  // 手机端还有两条平台约束：iOS 聚焦会触发页面缩放，必须改用不聚焦放大字号的方式；
  // 完整 placeholder 在 40px 编辑区里会盖住工具条，因此手机端只显示短文案。
  // 这两条都依赖同一组视口/远控入参，集中在这里算一次，避免 JSX 里重复判断。
  // 修复原因：旧 ChatView 删除后，iOS 防聚焦放大的接线没有迁到 v4 composer，
  // 手机 Web 远控输入框会重新触发 Safari 的页面缩放。
  const avoidIosInputFocusZoom = shouldAvoidIosInputFocusZoom({
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // Bugfix：手机远控把完整能力说明放进绝对定位 placeholder 后，三行英文会越过
  // 40px 编辑区并覆盖工具栏。手机端改用短文案并限制两行；桌面端继续保留完整提示。
  const compactMobilePlaceholder = isWebRemoteControl && isMobileTextInputViewport;
  // [并发] 快捷键展示由 enterSubmits 派生，与 handleEditorSubmit 的判定同源：
  // 单独按平台判断会出现“提示 Enter 发送、实际 Enter 换行”。
  const sendShortcut = resolveChatEnterShortcut({ enterSubmits });
  // updateText 是所有正文写入的唯一入口：同步 ref → 递增内容版本 → 推进草稿修订号 →
  // 更新渲染 state → 通知宿主。递增版本是关键，失败回滚与结算清理都靠它判断
  // “用户是否已经在旧正文上继续编辑”。
  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      contentRevisionRef.current += 1;
      advanceComposerDraftRevision(workspacePath, workspaceIdentity);
      setText(next);
      onTextChange?.(next);
    },
    [onTextChange, workspaceIdentity, workspacePath],
  );

  // runtimeInitialization 未 ready 时只限制“执行”，不隐藏输入：用户仍可先写好内容，
  // 等初始化完成后再发；runtimeBlocked 与 disabled 分开，避免把“暂不可发”做成“不可编辑”。
  const initialization = snapshot?.runtimeInitialization;
  const runtimeBlocked = initialization !== undefined && initialization.status !== "ready";

  // 附件状态完全由 useComposerAttachments 持有：选择、粘贴、拖拽、上传、重试、预传
  // 都收口在那一个 hook 里。composer 只负责渲染与把“就绪快照”交给发送链路，
  // 不复制附件列表，否则两处列表会在并发上传时失配。
  // listenAddToChatEvents 还必须叠加 disabled/runtimeBlocked：被禁用的 composer
  // 不能再接收全局“加入对话”事件，否则会把内容写进即将被替换的实例。
  // ── 附件全链路（选择/粘贴/拖拽/画板/预传/门禁）──
  const attachmentsApi = useComposerAttachments({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId: draftScopeId,
    attachmentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled: disabled || runtimeBlocked,
    listenAddToChatEvents: listenAddToChatEvents && !disabled && !runtimeBlocked,
  });
  // 对齐旧版 useChatComposer：窗口级 dragover 会在指针进入 ChatView 前预先点亮
  // 整个聊天区与桌面草稿标题栏；workspace payload 的文案优先于系统附件。
  // 下面三个 handler 必须保持引用稳定：dropTargetController 会被整个对话 pane
  // 与桌面草稿标题栏订阅，引用一变就会触发宿主重渲染与事件重绑。
  const { externalFileDragging, workspaceFileDragging } = usePromptEditorDragState({
    enableExternalFileDrop: true,
    enableWorkspaceFileDrop: true,
  });
  const handleConversationDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragOverComposer(event);
    },
    [attachmentsApi.handleDragOverComposer],
  );
  const handleConversationDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragLeaveComposer(event);
    },
    [attachmentsApi.handleDragLeaveComposer],
  );
  // drop 是唯一分叉点：workspace 文件树 payload 只插 mention，绝不进上传队列；
  // OS File[] 才交给附件 hook。两类 payload 的语义不同，合并处理会凭空多出上传。
  const handleConversationDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const workspaceFilePayload = readWorkspaceFileDragPayload(event.dataTransfer);
      if (workspaceFilePayload) {
        // 文件树 payload 与 OS File[] 语义不同：只插入 mention，绝不能进入上传队列。
        event.preventDefault();
        attachmentsApi.handleDropComposer(event);
        appendWorkspaceFileMentionToComposer({
          inputApiRef,
          currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: updateText,
        });
        return;
      }
      attachmentsApi.handleDropComposer(event);
    },
    [attachmentsApi.handleDropComposer, updateText, workspaceIdentity, workspacePath],
  );
  // 展示用的拖拽类型按优先级取：workspace 文案 > 外部文件 > 附件 hook 自身判定。
  // 这里只决定高亮文案，不影响 drop 行为。
  const conversationDragKind = workspaceFileDragging
    ? "workspace"
    : externalFileDragging
      ? "attachment"
      : (attachmentsApi.composerDragKind ??
        (attachmentsApi.isDraggingOverComposer ? "attachment" : null));
  // 把 drop 路由打包成稳定控制器上抛；卸载时必须回调 null，否则宿主会继续向
  // 已卸载的 composer 派发拖拽事件。
  const dropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: conversationDragKind !== null,
      kind: conversationDragKind,
      onDragOver: handleConversationDragOver,
      onDragLeave: handleConversationDragLeave,
      onDrop: handleConversationDrop,
    }),
    [
      conversationDragKind,
      handleConversationDragLeave,
      handleConversationDragOver,
      handleConversationDrop,
    ],
  );
  useEffect(() => {
    onDropTargetControllerChange?.(dropTargetController);
    return () => onDropTargetControllerChange?.(null);
  }, [dropTargetController, onDropTargetControllerChange]);
  // [权衡] 预览 index 与 open 拆成两个 state：合成一个 nullable 目标会让关闭动画
  // 期间目标先变 null，Dialog 在退场帧渲染空内容，视觉上闪一下白。
  // [资源] 图片/视频/PDF 预览共用这批 state，同一时刻只允许一个 portal 存活；
  // 同时打开两个会各自安装焦点陷阱，Esc 只关得掉最后挂载的那个。
  // [失败路径] index 可能因预览期间删除附件而越界；越界只在渲染侧 clamp，
  // 禁止在 effect 里回写，否则用户“当前查看项”会被悄悄改成最后一张。
  // [并发] pdfAttachmentPreview 打开前必须覆盖图片目标，二者互斥而非叠加，
  // 否则关掉 PDF 会露出底下那张已经过期的图片预览。
  // [失败路径] 关闭只置 open=false，保留 index 与目标，让退场动画有内容可画。
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState(0);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [pdfAttachmentPreview, setPdfAttachmentPreview] =
    useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfAttachmentPreviewOpen, setPdfAttachmentPreviewOpen] = useState(false);
  const attachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const videoAttachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  // [权衡] 只投影 hook 的布尔值，不在 composer 内重算长度：二次计算会让
  // “是否已就绪”与真正发送集合出现两个事实源。
  // [并发] 该值仅在渲染期读取；提交时必须用 attachmentsApi.attachments 的瞬时快照，
  // 不能用这个布尔反推数量，否则预览删除与提交之间会有窗口差。
  const hasAttachments = attachmentsApi.hasAttachments;
  // [并发] 网页上下文按 draftScopeId 归属：切草稿/切会话时 hook 内部换桶，
  // 上一个 scope 选中的元素不能漏进新草稿被顺手发出去。
  // [并发] listenAddToChatEvents 与 !disabled 相与：队列撤回等待 ACK 期间 composer
  // 只读，此时若仍接收全局 add-to-chat，会写进一个即将被权威删除的草稿。
  // [失败路径] 删除/清空一律走 hook 的 remove/clear，不在本地数组上过滤：本地过滤
  // 会让上下文仓库与 UI 分叉，下次恢复又把已删元素带回来。
  // [资源] 窗口级监听由 hook 在卸载时解绑，composer 不额外持有 listener。
  const {
    contexts: webElementContexts,
    hasContexts: hasWebElementContexts,
    removeContext: removeWebElementContext,
    clearContexts: clearWebElementContexts,
  } = useWebElementContexts({
    workspacePath,
    workspaceIdentity,
    // queue 撤回等待 ACK 时 composer 处于 disabled；此时也要阻止全局 add-to-chat
    // 写入网页上下文，避免权威删除成功后撞上 ACK 窗口内的新草稿。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  // 插件 UI 经 ui/update-model-context 附加的上下文；按 sessionId 接收，随发送清空。
  // [并发] 插件上下文只按 sessionId 接收、不按草稿 scope：插件侧没有草稿概念，
  // 换草稿就清空会让“插件刚附上的文件”莫名消失。
  // [权衡] 来源是 ui/update-model-context 的推送而非 composer 自采，因此这里只做
  // 投影与删除，绝不在此重新组装 payload，避免与插件侧格式双写。
  // [资源] image 块必须在本回合发送时就地转成附件：上下文在发送成功后即被清空，
  // 延迟到下一回合转换会丢掉图片本体。
  // [失败路径] 转换失败只告警不阻断文字发送，保证用户至少能发出纯文本部分。
  const {
    contexts: pluginUiContexts,
    hasContexts: hasPluginUiContexts,
    removeContext: removePluginUiContext,
    clearContexts: clearPluginUiContexts,
  } = usePluginUiModelContexts({ sessionId, workspacePath, workspaceIdentity });
  // 上下文里的 image 块 → 本 composer 的图片附件，随下一回合发送。
  usePluginUiContextImages(pluginUiContexts, attachmentsApi);
  // [并发] PPTX 元素引用同样按 draftScopeId 分桶，但打开动作额外带 remoteSessionId：
  // 远端会话里点击引用要回到远端宿主打开，不能在本机按同名路径找文件。
  // [并发] 与网页上下文同款 ACK 门禁：disabled 期间不接受新的 add-to-chat，
  // 防止权威删除与新增写入在同一 scope 上互相覆盖。
  // [失败路径] 引用打不开只提示，不从列表里静默移除；移除必须由用户显式触发，
  // 否则用户会以为“点了没反应”且丢失上下文。
  const {
    references: pptxElementReferences,
    hasReferences: hasPptxElementReferences,
    removeReference: removePptxElementReference,
    clearReferences: clearPptxElementReferences,
  } = usePptxElementReferences({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  // [失败路径] 打开动作只借用宿主的 onOpenCodeViewer 回调，composer 不自己导航：
  // 桌面、Web 壳与移动端的“打开文件”落点不同，各写一份必然分叉。
  // [并发] 远端会话下 workspacePath 是本机镜像路径，必须连同 remoteSessionId 一起下发，
  // 否则会在错误的工作区里打开同名文件。
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenCodeViewer,
  });
  // [并发] 会话引用按 sessionId 而非草稿 scope 归属：引用的是已提交消息里的原文，
  // 同一会话的不同草稿应共享同一批引用。
  // [权衡] 这里额外读 limitReason 只为在 UI 上解释“为什么不能再选”，
  // 配额裁决仍在 hook 内，composer 不做第二次计数。
  // [失败路径] 删除引用必须逐条按 id 下沉，不能在本地数组上 splice：
  // 引用同时被侧栏与编辑器消费，本地删除会让两边不同步。
  const {
    references: conversationSelectionReferences,
    limitReason: conversationSelectionLimitReason,
    removeReference: removeConversationSelectionReference,
    clearReferences: clearConversationSelectionReferences,
  } = useConversationSelectionReferences({
    sessionId,
    workspaceKey,
    draftScopeKey: rootDraftScopeKey,
  });
  const hasConversationSelectionReferences = conversationSelectionReferences.length > 0;

  // ── 草稿 per-session 持久化（切会话/刷新不丢；mention pill 经 editorStateJson 保真）──
  // [并发] draftScopeRef 保存“当前生效的 scope”，与组件渲染入参分离：异步落盘
  // 回调只应写自己启动时对应的 scope，读 state 会拿到切换后的新值。
  // [并发] draftTargetRef 额外带 workspacePath/Identity：同一个 scopeId 可能在解绑
  // 项目后指向另一个工作区，只比 scopeId 会漏判成“没切换”。
  // [事务] ownerDraftRef 是草稿的“已提交副本”，供外部 reader 与恢复请求读取；
  // 它与编辑器正文之间以 sync 方式推进，任何一方都不得单方面清空。
  // [资源] draftPersistTimerRef 是唯一的防抖定时器句柄，切换 scope、提交、卸载
  // 三处都必须先清掉它，否则会有一个指向旧 scope 的迟到落盘。
  // [事务] suppressDraftPersistRef 是落盘总闸：提交期间为 true，期间任何
  // persistDraftNow 都必须直接返回，不能靠调用方自觉跳过。
  const draftScopeRef = useRef(draftScopeId);
  const draftTargetRef = useRef({
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const ownerDraftRef = useRef({
    draft: composerDraft,
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const draftPersistTimerRef = useRef<number | null>(null);
  const suppressDraftPersistRef = useRef(false);

  const snapshotDraftOfEditor = useCallback((): {
    text: string;
    editorStateJson?: string;
  } => {
    // [权衡] 以 textRef 为准而不是编辑器实时状态：textRef 是本组件唯一认可的
    // “用户可见正文”，高级编辑器状态只是它的保真附件。
    // [失败路径] editorState 序列化必须吞掉异常并降级为纯文本：草稿落盘是后台动作，
    // 抛出去会打断输入，用户却看不出任何收益。
    // [权衡] 正文为空时强制丢弃 editorStateJson，避免把一堆空段落/光标位置存成草稿，
    // 导致下次进入时编辑器“看起来有内容”却发不出去。
    const currentText = textRef.current;
    let editorStateJson: string | undefined;
    try {
      const editorState = inputApiRef.current?.getEditorState();
      editorStateJson = editorState ? JSON.stringify(editorState.toJSON()) : undefined;
    } catch (error) {
      logger.warn(`[v4-composer] 草稿 editorState 序列化失败: ${String(error)}`);
    }
    return currentText.trim()
      ? { text: currentText, ...(editorStateJson ? { editorStateJson } : {}) }
      : { text: "" };
  }, []);

  useEffect(() => {
    // 新建 scope 已包含项目身份；不能只匹配旧的裸 __draft__ 而漏掉当前编辑器。
    // [并发] 只有草稿 scope 才注册 reader：会话 scope 的正文归属会话投影，
    // 再注册一份会让“工作区转移”读到已提交内容。
    // [并发] 回调内每次都重新取 ownerDraftRef 与编辑器快照，不闭包捕获首帧值：
    // reader 可能在任意时刻被外部调用，闭包旧值会把刚输入的内容漏掉。
    // [资源] 返回值是反注册函数，effect 依赖变化时必须解绑，否则旧 workspaceKey
    // 的 reader 会一直留在模块级表里。
    if (!draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT)) return;
    return registerV4ComposerDraftReader(workspaceKey, () => ({
      draft: { ...ownerDraftRef.current.draft, ...snapshotDraftOfEditor() },
      attachments: attachmentsApi.attachments,
    }));
  }, [draftScopeId, workspaceKey, snapshotDraftOfEditor, attachmentsApi.attachments]);

  // [事务] 落盘前先查总闸，再取编辑器快照；顺序反过来会在提交已开始后仍把正文写回旧草稿。
  // [并发] 只有 scopeId 仍等于当前生效 scope 才写入；不等说明这是“迟到的旧 scope 落盘”，
  // 必须丢弃而不是写进旧桶，否则会把当前会话内容串到上一会话。
  // [权衡] 这里不抛错也不重试：草稿是尽力而为的持久化，失败由下次输入或强制 flush 补写，
  // 在输入热路径上弹错误只会打断用户。
  const persistDraftNow = useCallback(
    (scopeId: string) => {
      if (suppressDraftPersistRef.current) return;
      const content = snapshotDraftOfEditor();
      if (scopeId === draftScopeRef.current) {
        updateComposerContent(content);
        return;
      }
    },
    [snapshotDraftOfEditor, updateComposerContent, workspaceIdentity, workspacePath],
  );

  // [资源] 防抖窗口固定 350ms：更短会在中文输入法组词期间反复序列化 editorState，
  // 更长会让切会话前最后一次输入只能依赖 blur/pagehide 兜底才落盘。
  // [并发] 新建定时器前必须清掉旧句柄，否则两个 timer 会先后触发，
  // 后一个写入的可能已是被切掉的 scope。
  // [失败路径] 回调触发时重新读 draftScopeRef，不闭包捕获调度时刻的 scope。
  const scheduleDraftPersist = useCallback(() => {
    if (typeof window === "undefined") return;
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      persistDraftNow(draftScopeRef.current);
    }, 350);
  }, [persistDraftNow]);

  // ── 自动聚焦（新建任务 / 切会话 / 挂载后把光标交还输入框）──
  // 触发源：startDraft 递增的 draftFocusVersion（覆盖 Cmd/Ctrl+N 与所有「新建任务」入口）、
  // sessionId→draftScopeId 变化（切会话/切草稿）、以及挂载。三者置位聚焦意图；因切到需
  // 连接的会话时 composer 短暂 disabled，聚焦意图暂存，待可编辑时兑现一次。
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  // [事务] 附件恢复与正文恢复分开：附件放在模块级待领取表里，必须由 nonce 领取一次；
  // 提前在渲染期消费会让 StrictMode 的双调用把附件原地吞掉。
  // [并发] 只对草稿 scope 领取：会话 scope 的附件归属该会话，不应被“新建任务”抢走。
  useEffect(() => {
    if (!draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT)) return;
    const attachments = consumeV4ComposerDraftAttachments(workspaceKey, draftFocusVersion);
    if (attachments) attachmentsApi.restoreDraftAttachments(attachments);
  }, [draftFocusVersion, draftScopeId, workspaceKey, attachmentsApi.restoreDraftAttachments]);
  // [并发] pendingFocusRef 记录“已表达但尚未兑现”的聚焦意图；连接中 disabled 时
  // 只置位不聚焦，等 disabled 翻转后由 flushPendingFocus 兑现且只兑现一次。
  // [失败路径] applied*RequestRef 存最近一次已应用的 requestId：外部请求可能因
  // 编辑器未就绪重试一帧，靠它保证同一 requestId 不会把正文插入两遍。
  const pendingFocusRef = useRef(false);
  // 本次 focus 是否由程序触发（见 flushPendingFocus），供 send_input_focus 过滤非用户动作。
  const programmaticFocusRef = useRef(false);
  // 发送键与 Enter 共用同一个 form submit；按钮 onClick 早于 submit 触发，
  // 借此区分 send_click 的 send_trigger，读取后立刻复位回默认的 shortcut。
  const sendTriggerRef = useRef<"button" | "shortcut">("shortcut");
  // 修饰键点击先于 form submit；这里只保存这一拍的 delivery 反转意图，submit 消费后清零。
  const reversePointerDeliveryRef = useRef(false);
  const appliedComposerRestoreRequestRef = useRef<number | null>(null);
  const appliedExternalTextInsertRequestRef = useRef<number | null>(null);
  // 决策入参经 ref 读取，避免把 autoFocusEnabled/disabled/viewport 灌进 scope effect 依赖，
  // 触发多余的草稿重恢复（disabled 变化本不应重放草稿）。
  const focusOptsRef = useRef<ComposerAutoFocusOptions>({
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  });
  focusOptsRef.current = {
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  };
  // [事务] 三步顺序固定：有意图 → 当前允许聚焦 → 编辑器已就绪；任一不满足就保持
  // pending，不能提前清标记，否则 disabled 期间那次聚焦意图会被永久丢弃。
  // [并发] 清 pending 与置 programmatic 标记必须在同一拍完成；先清标记再置位
  // 会让中间插入的 DOM focus 被误判成用户行为。
  // [失败路径] 聚焦排到下一帧并容错 inputApi 为空：Lexical root 拆卸竞态下
  // 直接调用会抛错，而这里没有调用方能接住。
  const flushPendingFocus = useCallback(() => {
    if (!pendingFocusRef.current) return;
    if (resolveComposerAutoFocus(focusOptsRef.current) !== "focus-now") return;
    if (!inputApiRef.current) return;
    pendingFocusRef.current = false;
    // 程序性聚焦与用户点击输入框会触发同一个 DOM focus 事件；置位后由 handleEditorFocus
    // 消费，避免把「切会话 / 挂载回焦 / 上下文块移除后回焦」误报成 send_input_focus。
    programmaticFocusRef.current = true;
    // Lexical root 可能晚一帧就绪，聚焦排到下一帧（与草稿回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => inputApiRef.current?.focus());
    } else {
      inputApiRef.current.focus();
    }
  }, []);
  // [权衡] skip 时直接返回且不置 pending：skip 表示“当前上下文根本不该聚焦”，
  // 例如移动端为避免软键盘顶起布局；置 pending 会在下次 disabled 翻转时意外弹键盘。
  // [事务] 置位后立刻尝试兑现，避免“本可聚焦却要等下一次 disabled 变化”才生效。
  const requestComposerFocus = useCallback(() => {
    if (resolveComposerAutoFocus(focusOptsRef.current) === "skip") return;
    pendingFocusRef.current = true;
    flushPendingFocus();
  }, [flushPendingFocus]);

  // [事务] 删除代码评论要同时通知宿主广播服务，让其他窗口的同一评论预览一起消失；
  // 只在本地删会让另一窗口继续展示已失效的引用。
  // [失败路径] 广播失败不影响本地删除，评论从 composer 移除即视为成功。
  const handleCodeCommentRemoved = useCallback(
    (comment: Parameters<typeof removeCodeCommentPreview>[0]) => {
      removeCodeCommentPreview(comment, services?.broadcastService);
    },
    [services?.broadcastService],
  );
  // [并发] scopeKey 由 workspaceKey 与 draftScopeId 拼接：同一草稿 id 在不同工作区
  // 可能重复，只按 draftScopeId 分桶会让两个项目的评论互相串。
  // [失败路径] onContextRemoved 在删除评论时同步清掉宿主侧预览；requestFocus
  // 让键盘用户删完仍留在输入框，而不是焦点掉回 body。
  // [并发] 与网页/PPTX 相同，disabled（ACK 等待）期间停止接收 add-to-chat。
  const {
    contexts: codeCommentContexts,
    hasContexts: hasCodeCommentContexts,
    removeContext: removeCodeCommentContext,
    clearContexts: clearCodeCommentContexts,
    getContexts: getCodeCommentContexts,
  } = useCodeCommentContexts({
    // queue 撤回等待 ACK 时 composer 处于 disabled；与网页上下文保持同一写入门禁。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    onContextRemoved: handleCodeCommentRemoved,
    requestFocus: requestComposerFocus,
    scopeKey: `${workspaceKey}\0${draftScopeId}`,
  });

  // [事务] 恢复请求是一次性外部指令：先按 requestId 幂等，再校验 session/workspace 是否
  // 仍是发起时那个；跨会话迟到的请求必须丢弃，否则会把 A 会话的撤回内容填进 B 会话。
  // [并发] hasDraftContent 汇总全部上下文种类：只要用户已经重新输入，就不能用恢复
  // 请求覆盖，宁可让宿主提示“目标已有内容”。
  // [失败路径] 编辑器未就绪时只重试一帧，不做无限轮询：编辑器挂载失败时宁可丢弃请求，
  // 也不能让 effect 永久悬挂。
  useEffect(() => {
    if (!composerRestoreRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyComposerRestoreRequestToComposer({
        appliedRequestId: appliedComposerRestoreRequestRef.current,
        currentSessionId: sessionId,
        currentWorkspaceKey: workspaceKey,
        hasDraftContent:
          textRef.current.length > 0 ||
          attachmentsApi.attachments.length > 0 ||
          codeCommentContexts.length > 0 ||
          webElementContexts.length > 0 ||
          pptxElementReferences.length > 0 ||
          conversationSelectionReferences.length > 0 ||
          pluginUiContexts.length > 0,
        inputApi: inputApiRef.current,
        request: composerRestoreRequest,
        requestFocus: requestComposerFocus,
        restoreSessionOwnedAttachments: attachmentsApi.restoreSessionOwnedAttachments,
        // 撤回项携带独立 Submission 配置；沿用草稿 owner，一次恢复且保留已处理授权标记。
        restoreDraftConfig: (config) =>
          replaceComposerDraft({
            ...ownerDraftRef.current.draft,
            ...config,
            text: composerRestoreRequest.text,
            editorStateJson: undefined,
            mention: undefined,
          }),
        scheduleDraftPersist,
        updateText,
      });
      // [事务] appliedNow 只认“本次调用首次应用成功”这一拍：重复渲染或 StrictMode
      // 二次执行时不能再回调宿主，否则宿主会把同一次撤回记成两次。
      // [并发] 无论是否 appliedNow 都要推进 appliedRequestId，保证失败的旧请求
      // 不会在下一帧被当成新请求再试一次。
      const appliedNow =
        nextAppliedRequestId === composerRestoreRequest.requestId &&
        appliedComposerRestoreRequestRef.current !== composerRestoreRequest.requestId;
      appliedComposerRestoreRequestRef.current = nextAppliedRequestId;
      if (appliedNow) onComposerRestoreApplied?.(composerRestoreRequest.requestId);
      return nextAppliedRequestId === composerRestoreRequest.requestId;
    };
    // [失败路径] 首帧同步应用失败才排下一帧：直接无条件 rAF 会让已成功的请求
    // 在下一帧再插一次正文（编辑器尚未清理时表现为重复文本）。
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    attachmentsApi.attachments.length,
    attachmentsApi.restoreSessionOwnedAttachments,
    codeCommentContexts.length,
    composerRestoreRequest,
    conversationSelectionReferences.length,
    onComposerRestoreApplied,
    replaceComposerDraft,
    requestComposerFocus,
    scheduleDraftPersist,
    sessionId,
    updateText,
    webElementContexts.length,
    pptxElementReferences.length,
    pluginUiContexts.length,
    workspaceKey,
  ]);

  // scope 切换：先落旧 scope 草稿，再恢复新 scope（editorStateJson 优先，退纯文本）。
  // [事务] 顺序不可交换：先恢复后落盘会把新 scope 的正文写进旧 scope 的桶。
  // [并发] 判断“是否切换”必须同时比 scope 与 workspace 身份，只比 scopeId 会漏掉
  // 项目解绑/重绑这种 scope 不变但归属已变的情况。
  // [资源] 进入切换分支第一件事是清防抖定时器，之后才快照正文；反序会让定时器
  // 在快照之后、切换之前再写一次旧正文。
  // [失败路径] suppress 期间完全跳过落盘与转移：提交中的正文属于在途请求，
  // 既不能存成草稿，也不能被当作“切换前草稿”搬到新 scope。
  useEffect(() => {
    const previousTarget = draftTargetRef.current;
    const targetChanged =
      previousTarget.scopeId !== draftScopeId ||
      previousTarget.workspacePath !== workspacePath ||
      previousTarget.workspaceIdentity !== workspaceIdentity;
    let transferredDraft: ReturnType<typeof snapshotDraftOfEditor> | null = null;
    if (targetChanged && !suppressDraftPersistRef.current) {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      // [事务] 转移是一次性凭据：consume 成功才把旧正文带过去，且仅限两侧都是
      // 草稿 scope；带进会话 scope 会让“已提交会话”凭空多出一份未发送正文。
      const previousDraft = snapshotDraftOfEditor();
      const shouldTransferDraft =
        previousTarget.scopeId.startsWith(V4_DRAFT_SCOPE_ROOT) &&
        draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT) &&
        consumeV4ComposerDraftWorkspaceTransferRequest({
          sourceWorkspacePath: previousTarget.workspacePath,
          sourceWorkspaceIdentity: previousTarget.workspaceIdentity,
          targetWorkspacePath: workspacePath,
          targetWorkspaceIdentity: workspaceIdentity,
        });
      if (shouldTransferDraft) {
        // 项目解绑只改变草稿的 cwd；输入正文、mention editor state 和组件内附件继续保留。
        replaceComposerDraft({ ...ownerDraftRef.current.draft, ...previousDraft });
        transferredDraft = previousDraft;
      }
    }
    draftScopeRef.current = draftScopeId;
    draftTargetRef.current = {
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };

    // [事务] 恢复分三类来源：本帧刚转移的草稿优先，其次才是持久化草稿；用 transferred
    // 覆盖可以避免“转移完成后又被旧持久化值盖回去”。
    const draft = transferredDraft ?? composerDraft;
    // [失败路径] 目标 scope 无草稿时必须主动清空编辑器：切到空会话还留着上一会话正文，
    // 用户一点发送就发错内容。
    const restoreDraftInto = (api: LexicalChatInputHandle) => {
      if (!draft) {
        if (textRef.current) {
          api.clear();
          updateText("");
        }
        return;
      }
      updateText(
        restorePersistedComposerDraftIntoInput({
          draft,
          inputApi: api,
          onEditorStateError: (error) => {
            logger.warn(`[v4-composer] 草稿 editorState 恢复失败，退纯文本: ${String(error)}`);
          },
        }),
      );
    };
    // [并发] 结算订阅在恢复正文之后才建立，且必须与本次回填的 text/revision 绑定：
    // 用切换后的实时值判断会把用户新输入误认成“那次提交”，从而清错正文。
    // [失败路径] 订阅回调只处理文本完全一致且 revision 未前进的提交；任一不满足就
    // 让用户继续持有正文，重复发送的风险由用户可见的正文兜底。
    let unsubscribeSettled: (() => void) | null = null;
    const applyDraft = () => {
      const api = inputApiRef.current;
      if (!api) return;
      restoreDraftInto(api);
      // Bug 根因（R3A-B-07）：ACK 丢失时传输先 reject，提交正文被恢复回草稿；随即断连让
      // SessionPane 连同本组件卸载，闭包里的结算订阅一起消失。重连重挂后正文从草稿回填，
      // 权威 projection 到达却无人清空，用户再点发送就重复归属。这里在回填后向模块级账本
      // 认领该 scope 尚未结算的提交：结算已到则同步清空，否则等它到达。
      const restoredText = draft?.text ?? "";
      const restoredRevision = contentRevisionRef.current;
      unsubscribeSettled = subscribeComposerSubmissionSettled(
        `${workspaceKey}\0${draftScopeId}`,
        (submission) => {
          // 只清"确实是那次提交、且用户还没在其上继续编辑"的正文；编辑器把回填正文
          // 重新序列化后若与提交原文一致，也视为未编辑。
          if (submission.text !== restoredText) return;
          if (
            contentRevisionRef.current !== restoredRevision &&
            textRef.current !== submission.text
          ) {
            return;
          }
          inputApiRef.current?.clear();
          updateText("");
          updateComposerContent({ text: "" });
        },
      );
      // 草稿恢复后把光标交还输入框（切会话/切草稿/挂载）；连接中会话待可编辑后兑现。
      requestComposerFocus();
    };
    // Lexical root 可能晚一帧就绪；draft 恢复排到下一帧（与旧 initialValue 回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(applyDraft);
      return () => {
        cancelAnimationFrame(frame);
        unsubscribeSettled?.();
      };
    }
    applyDraft();
    return () => unsubscribeSettled?.();
    // 依赖收敛到 scope/workspace：draft 恢复只应发生在 scope 切换或 workspace 切换。
  }, [
    draftScopeId,
    persistDraftNow,
    requestComposerFocus,
    snapshotDraftOfEditor,
    updateText,
    updateComposerContent,
    workspaceIdentity,
    workspacePath,
    replaceComposerDraft,
  ]);

  // [事务] ownerDraftRef 只做镜像，不触发落盘：它服务于外部 reader 与撤回恢复，
  // 若在这里顺手 persist 会与防抖定时器形成两条写路径。
  useEffect(() => {
    ownerDraftRef.current = {
      draft: composerDraft,
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };
  }, [composerDraft, draftScopeId, workspaceIdentity, workspacePath]);

  // 外部预填和 scope 恢复可能在同一轮发生。若预填 effect 先执行，后续恢复会用旧草稿
  // 覆盖用户刚点的 Example Prompt；因此必须在 scope 恢复之后应用并确认单次插入请求。
  // [并发] 预填请求同样按 requestId 幂等，并在应用成功后回执宿主；失败只重试一帧。
  // [事务] 预填正文要立即调度草稿落盘：用户可能在预填后直接关窗，等不到 350ms。
  // [失败路径] 编辑器未就绪时不清空已应用的 requestId，但也不会重复插入：
  // 下一帧仍走同一个幂等判断。
  useEffect(() => {
    if (!externalTextInsertRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyExternalTextInsertRequestToComposer({
        appliedRequestId: appliedExternalTextInsertRequestRef.current,
        inputApi: inputApiRef.current,
        request: externalTextInsertRequest,
        requestFocus: requestComposerFocus,
        scheduleDraftPersist,
        updateText,
      });
      const applied = nextAppliedRequestId === externalTextInsertRequest.requestId;
      appliedExternalTextInsertRequestRef.current = nextAppliedRequestId;
      if (applied) {
        onExternalTextInsertApplied?.(externalTextInsertRequest.requestId);
      }
      return applied;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    externalTextInsertRequest,
    onExternalTextInsertApplied,
    requestComposerFocus,
    scheduleDraftPersist,
    updateText,
  ]);

  // 新建任务（含已在草稿态重复 Cmd/Ctrl+N，scope 未变）：startDraft 递增 nonce 即重新聚焦。
  // [并发] 用 ref 记录上次见过的 nonce，而不是把 nonce 放进 effect 依赖做“初次跳过”：
  // 后者在挂载时也会执行一次，导致每次打开 composer 都抢焦点。
  const lastFocusVersionRef = useRef(draftFocusVersion);
  useEffect(() => {
    if (lastFocusVersionRef.current === draftFocusVersion) return;
    lastFocusVersionRef.current = draftFocusVersion;
    requestComposerFocus();
  }, [draftFocusVersion, requestComposerFocus]);

  // 切到需连接的会话时 disabled=true，聚焦意图 defer；连接完成 disabled→false 时兑现一次。
  // [事务] 只在 disabled 变化时尝试兑现聚焦；把其它输入也纳入依赖会在用户打字、
  // 附件变化时反复抢光标。
  useEffect(() => {
    flushPendingFocus();
  }, [disabled, flushPendingFocus]);

  // 刷新/关窗前落盘当前草稿。
  // [失败路径] pagehide/blur 是最后的落盘机会：移动端切后台或直接杀进程时，
  // 防抖定时器未必有机会触发，只靠 350ms 会丢掉最后一段输入。
  // [资源] 卸载清理里必须再 flush 一次并清掉定时器，否则组件已卸载仍有回调写入。
  // [资源] 同时清空命令结算订阅：这些订阅挂在模块级表上，不随组件卸载自动消失，
  // 遗留会让下一次挂载收到上一轮 command 的结算。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => persistDraftNow(draftScopeRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      for (const cleanup of commandResolutionCleanupsRef.current) cleanup();
      commandResolutionCleanupsRef.current.clear();
    };
  }, [persistDraftNow]);

  // ── prompt history（per-workspace localStorage，↑/↓ 导航由 PromptHistoryPlugin 消费）──
  // [权衡] 初始值用惰性读取而不是空数组再 effect 填充：否则首次渲染会把 ↑ 导航
  // 短暂关掉，用户按上键时拿不到历史。
  // [事务] 换 workspace 时必须整表重读，不能沿用旧值：历史按工作区分桶，
  // 跨工作区复用会把 A 项目的提示词发给 B 项目。
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(workspacePath),
  );
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(workspacePath));
  }, [workspacePath]);

  // [权衡] mode 缺失时按 startNow 兜底，而不是禁用发送：prewarm 未到时禁用会让
  // 用户在首屏就点不动按钮；真正能否发送仍由 submit 内的二次门禁裁决。
  // [并发] 修饰键语义由 shared 的纯函数统一裁决，组件内不再写平台分支：三端
  // （桌面/移动/远控）判定不同，各自实现必然分叉。
  const mode = snapshot?.inputRouting.mode ?? "startNow";
  const modifiedEnterSubmits = shouldEnableModifiedEnterSubmit({
    inputRoutingMode: mode,
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // [权衡] 只有“可停止”时修饰键才有反转语义：没有在跑的 turn 就无从“插队”，
  // 此时反转只会让用户以为发送方式被吞掉。
  const canStop = Boolean(snapshot?.control.canStop);
  const modifiedEnterReversesDelivery = modifiedEnterSubmits && canStop;
  // [事务] 发送判定用 trim 后的正文：纯空白不应点亮发送键，但 hasComposerDraftContent
  // 仍保留原文长度，两者刻意不同。
  const hasText = text.trim().length > 0;
  // [事务] hasDraftToSubmit 是“这一拍能否提交”的合取：正文、各类附件与上下文、
  // 分享 handover 任一存在即可；遗漏任一项都会让用户看到内容却按不动发送。
  const hasDraftToSubmit =
    hasText ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  // [权衡] hasComposerDraftContent 与 hasDraftToSubmit 几乎同构，但语义不同：
  // 前者用 text.length 判断“宿主是否该保留 draft tab”，后者用 trim 判断“能否发送”。
  // 合并会让只输入空格时 tab 消失或发送键误亮，二者必须各留一份。
  const hasComposerDraftContent =
    text.length > 0 ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  // [并发] 每次内容/忙碌态变化都主动上报宿主，供“关闭 draft tab 前确认”使用；
  // 上报的是渲染期值，不在 effect 里再读一次 state，避免与下一次渲染错位。
  useEffect(() => {
    onDraftStateChange?.({
      hasContent: hasComposerDraftContent,
      busy: pending,
    });
  }, [hasComposerDraftContent, onDraftStateChange, pending]);
  // choice 保留正常发送按钮；提交后由 SessionPane 按 slash 语义决定是否弹确认框。
  // V4 重构时把 guide 当成“不可提交”状态，导致按钮和 Enter 同时失效；
  // guide 是 CLI 已授权的 busy 输入路由，是否最终 steer 或回退 queue 由命令层裁决。
  // [权衡] draftMode 下无条件放行路由：草稿态还没有 snapshot，等它到达才放行会让
  // 首条消息的发送键一直灰着；真正的拒绝由命令层在提交后返回 blocked。
  const routingAllowsSend = draftMode || (snapshot !== null && mode !== "reject");
  // [并发] 附件未就绪时禁用发送：提交路径会再次检查 prepareForSend，这里只是
  // 让按钮状态与真实能力一致，避免用户点了才被拒。
  const attachmentsReady = !attachmentsApi.hasUnreadyAttachments;
  // [事务] canSend 是按钮侧的合取门禁，与 submit 内的二次门禁逐项对应；
  // 任何一项新增都必须同时加到两处，否则会出现“亮着却点不动”或“灰着却能发”。
  // [失败路径] runtimeBlocked 表示 composer 被权限/问答卡片占用，必须参与判定，
  // 否则用户会在一个被覆盖的输入框上凭空触发发送。
  const canSend =
    !disabled &&
    !pending &&
    hasDraftToSubmit &&
    routingAllowsSend &&
    attachmentsReady &&
    submissionReady &&
    !runtimeBlocked;
  // 旧 UI 状态机：streaming + 空草稿 → Stop；有草稿 → 发送键（入队）。
  // [权衡] Stop 只在“有 turn 可停且草稿为空”时显示：有草稿时按钮必须回到发送，
  // 否则用户被迫先清空输入才能继续对话。
  // [并发] canStop 只读 snapshot 投影，不缓存本地副本：本地副本在 ACK 丢失时
  // 会一直停在 true，按钮永远停在 Stop。
  const showStopControl = canStop && !hasDraftToSubmit;

  // [失败路径] 一旦不可发送就强制收起 tooltip：受控 open 不会因按钮 disabled
  // 自动关闭，残留提示会浮在一个点不动的按钮上。
  useEffect(() => {
    if (!canSend) setSendTooltipOpen(false);
  }, [canSend]);

  const submit = useCallback(
    async (
      heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
      expectedHeldQueueItemIds?: readonly string[],
      existingTelemetrySeed?: ConversationPromptTelemetrySeed,
      requestedDelivery?: "startNow" | "queue" | "guide",
    ) => {
      // [事务] submit 开头先把“这一拍要提交什么”全部捕获成局部常量：正文、附件 id、
      // 五类上下文与订阅队列的 id 都在任何 await 之前冻结，后续只读局部变量。
      // [并发] 捕获必须早于 await：等待期间用户可能继续输入或删除附件，
      // 回读 state/ref 会把“下一次提交的内容”混进这一次。
      // [失败路径] 捕获之后所有清理都按这份冻结列表逐项删除，漏一项就会留下
      // 重复发送的上下文。
      const trimmed = textRef.current.trim();
      const submittedQueueItemIds =
        snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
      const hasPendingAttachments = attachmentsApi.attachments.length > 0;
      const currentCodeCommentContexts = getCodeCommentContexts();
      const hasPendingCodeCommentContexts = currentCodeCommentContexts.length > 0;
      const currentWebElementContexts = webElementContexts;
      const hasPendingWebElementContexts = currentWebElementContexts.length > 0;
      const currentPluginUiContexts = pluginUiContexts;
      const hasPendingPluginUiContexts = currentPluginUiContexts.length > 0;
      const currentPptxElementReferences = pptxElementReferences;
      const hasPendingPptxElementReferences = currentPptxElementReferences.length > 0;
      const currentConversationSelections = conversationSelectionReferences;
      const hasPendingConversationSelections = currentConversationSelections.length > 0;
      const submittedShareContext = pendingShareContext;
      // 草稿首发 accepted 后同一 composer 会原地从 __draft__ promotion 到
      // session scope；若成功清理时再读可变 ref，会误清新 scope，并把首条输入残留在
      // __draft__，下次新建任务又恢复。发送开始时冻结真正提交的 scope。
      const submittedDraft = snapshotDraftOfEditor();
      const submittedScopeKey = `${workspaceKey}\0${draftScopeRef.current}`;
      // [事务] cleanupRevision 是“发送时刻的内容版本”；回滚与结算都用它判断
      // 用户是否在等待期间继续编辑，版本前进即视为新内容，不得覆盖。
      let cleanupRevision = contentRevisionRef.current;
      const submission = createSubmissionFromComposer?.() ?? null;
      const submittedAttachmentIds = attachmentsApi.attachments.map((item) => item.id);
      // [事务] 第二道门禁与按钮 disabled 同构但不共享实现：按钮可能被平台样式或
      // 宿主误放行，提交入口必须自己再判一次，任一条件不满足就静默返回。
      // [并发] pendingRef 用 ref 而不是 state 判断：同一帧内连点两次按钮时 state
      // 还没提交更新，只有 ref 能挡住第二次进入。
      // [失败路径] createSubmissionFromComposer 存在却返回 null，说明附件/上下文
      // 组装失败；此时必须中止，不能发出一条缺字段的消息。
      if (
        (!trimmed &&
          !hasPendingAttachments &&
          !hasPendingCodeCommentContexts &&
          !hasPendingWebElementContexts &&
          !hasPendingPptxElementReferences &&
          !hasPendingConversationSelections &&
          !hasPendingPluginUiContexts &&
          !submittedShareContext) ||
        pendingRef.current ||
        targetSelectionPendingRef.current ||
        !remoteAvailable ||
        !submissionReady ||
        runtimeBlocked ||
        (createSubmissionFromComposer !== undefined && submission === null) ||
        attachmentsApi.hasUnreadyAttachments
      ) {
        return;
      }
      // [事务] startUserAction 必须在门禁之后、置 pending 之前创建：它记录的是
      // “用户真实发起的一次发送”，提前创建会给被拒绝的点击也记一条 action。
      const sendAction = startUserAction({
        featureId: "conversation.composer.message",
        action: "send",
        trigger: sendTriggerRef.current === "button" ? "button" : "shortcut",
        workspaceKind: workspaceIdentity?.trim() ? "remote" : "local",
      });
      pendingRef.current = true;
      setPending(true);
      // Bug 根因：草稿 intent 只保存用户显式改动，正常继承模型位于冻结初始化 config。
      // prewarm snapshot 尚未到达时若只读 draftConfig，send_btn 会错误落成空模型/glm。
      // [权衡] 遥测配置按 draftConfig → snapshot → 初始化 config 取值，仅用于上报
      // “用户看到的模型”，不参与真实发送；真实配置由命令层与提交参数决定。
      const telemetryConfig = telemetryDraftConfig ?? snapshotRef.current?.config ?? draftConfig;
      let telemetrySeed: ConversationPromptTelemetrySeed;
      // [事务] seed 的生命周期跨越队列确认往返：二次确认必须复用首次 seed 并在
      // 同一 seed 上落定，否则一次发送会产出两条 send_result。
      // [失败路径] 复用 seed 时把 localTtft 的 confirmation 标记复位，避免把
      // “确认弹窗已展示”误算成 TTFB 的终点。
      if (existingTelemetrySeed) {
        // 队列二次确认复用首次点击的 seed：不重报 send_click，也不重置发送触发来源，
        // 保证 send_click 与 send_result 严格 1:1。
        telemetrySeed = existingTelemetrySeed;
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, false);
      } else {
        // [并发] localTtft 只在本机会话（无 workspaceIdentity）时启动：远端发送的
        // 首字节时间由宿主侧观测，本机再起一份会得到错误的分母。
        // [权衡] start 的第三个参数用“是否 slash 命令”预判实时性，而不是等命令
        // 解析完成：观测器要在发送前就挂上，否则会漏掉极快的首包。
        // [失败路径] extraDetail 全部做空值容错，遥测字段缺失远好于阻断发送。
        const freshSeed: ConversationPromptTelemetrySeed = {
          sendTime: Date.now(),
          localTtft: !workspaceIdentity?.trim()
            ? getLocalTtftObserver()?.start(
                workspacePath,
                (snapshotRef.current !== null &&
                  snapshotRef.current.inputRouting.mode !== "startNow") ||
                  false,
                trimmed.startsWith("/"),
              )
            : undefined,
          extraDetail: buildV4ConversationPromptTelemetryExtraDetail({
            askMode: telemetryConfig?.mode,
            modelName: telemetryConfig?.model,
            configProvider: telemetryConfig?.provider,
            agentProvider: provider,
            providerBaseURL: resolveProviderBaseURL(telemetryConfig?.provider, modelSelectionView),
            planIdentitySnapshot: readPlanIdentitySnapshot?.(),
          }),
        };
        const sendTrigger = sendTriggerRef.current;
        sendTriggerRef.current = "shortcut";
        // recordSendClick 回填 sendClickId，必须用它的返回值作为后续 seed，
        // 否则落定时拿不到关联键，send_result 会被当成后台任务跳过。
        telemetrySeed =
          conversationTelemetry?.recordSendClick({
            sessionId: sessionId ?? null,
            seed: freshSeed,
            trigger: sendTrigger,
          }) ?? freshSeed;
      }
      // [事务] 三个 history 变量都是本次提交的本地快照：发送前的值、追加后的值、
      // 是否真的写过盘；回滚只在这三者齐备时执行，否则说明从未写入、无需回滚。
      let promptHistoryBeforeSend: readonly string[] | null = null;
      let promptHistoryAfterAppend: readonly string[] | null = null;
      let promptHistoryWasPersisted = false;
      let draftSubmissionClaimed = false;
      let editorClearedOptimistically = false;
      let submittedCommandId: string | null = null;
      let submittedCommandResolved = false;
      // [事务] claim 是“把草稿从持久化系统里摘出来”的唯一入口：先停防抖、再关总闸、
      // 最后清空公开副本；三步缺一都会让在途正文被当成草稿再次恢复。
      // [并发] 必须在 onSendText 之前完成：首发 promotion 会在其返回前切换 scope，
      // 那时旧 effect 若还能落盘，新 Composer 就会把已发送正文恢复出来。
      const claimSubmittedDraft = () => {
        if (draftPersistTimerRef.current !== null) {
          window.clearTimeout(draftPersistTimerRef.current);
          draftPersistTimerRef.current = null;
        }
        // 首发 promotion 会在 onSendText 返回前切换 scope 或重建 Composer。
        // 若仍允许旧 scope effect 落盘，新 Composer 会把已经发送的正文当草稿恢复。
        // 提交前先占用并隐藏该草稿；失败路径再恢复，避免用等待时间掩盖竞态。
        suppressDraftPersistRef.current = true;
        updateComposerContent({ text: "" });
        draftSubmissionClaimed = true;
      };
      // [事务] 回滚只恢复“用户没继续编辑”的正文，判据是 cleanupRevision 未前进；
      // 否则用旧失败回包覆盖用户新输入。
      // [失败路径] 已发出的 command 尚未有权威结论时，把 scope 与正文登记到模块级账本，
      // 让卸载重挂后的 composer 仍能收口（ACK 丢失场景）。
      // [并发] 恢复编辑器内容与恢复 textRef 必须成对执行：只恢复其中一边会让
      // 发送键状态与可见正文不一致。
      const restoreSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        // 用户在等待期间已经产生更新时，当前完整正文是更新后的事实；旧失败回包不能覆盖。
        if (contentRevisionRef.current === cleanupRevision) {
          updateComposerContent(submittedDraft);
          if (submittedCommandId && !submittedCommandResolved) {
            // 传输层失败不等于 CLI 未 admission（ACK 丢失即如此）。正文虽已恢复回草稿，
            // 该 command 仍待权威结论；登记到模块级账本，让卸载重挂后的 composer 也能收口。
            trackUnsettledComposerSubmission(submittedScopeKey, {
              commandId: submittedCommandId,
              text: submittedDraft.text,
            });
          }
        }
        suppressDraftPersistRef.current = false;
        draftSubmissionClaimed = false;
        if (editorClearedOptimistically && contentRevisionRef.current === cleanupRevision) {
          if (submittedDraft.editorStateJson) {
            inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
          } else {
            inputApiRef.current?.setText(submittedDraft.text);
          }
          updateText(submittedDraft.text);
          editorClearedOptimistically = false;
        }
      };
      const finalizeSubmittedDraft = () => {
        if (!draftSubmissionClaimed) return;
        suppressDraftPersistRef.current = false;
        draftSubmissionClaimed = false;
      };
      let submittedContentSettled = false;
      // [事务] 结算必须先把附件“过继”给已有消息，再清空编辑器：反序会让附件列表
      // 先消失，消息侧却还没接住，用户看到附件凭空丢失。
      // [并发] 幂等标记 submittedContentSettled 用局部变量而非 state：结算可能同时
      // 由命令订阅与 await 返回触发，state 更新有延迟挡不住重入。
      // [并发] 清理逐类按冻结列表删除，不调用 clear* 全量清空：等待期间新增的
      // 上下文属于下一次提交，不能被这一次顺手清掉。
      const settleSubmittedContent = async () => {
        if (submittedContentSettled) return;
        submittedContentSettled = true;
        await attachmentsApi.adoptSentAttachments(submittedAttachmentIds);
        // 权威 projection 已确认原 command 被接管；等待期间的新正文属于下一次提交。
        if (contentRevisionRef.current === cleanupRevision) {
          inputApiRef.current?.clear();
          updateText("");
          updateComposerContent({ text: "" });
        }
        attachmentsApi.clearAttachments(submittedAttachmentIds);
        currentCodeCommentContexts.forEach(removeCodeCommentContext);
        currentWebElementContexts.forEach((context) => removeWebElementContext(context.id));
        currentPluginUiContexts.forEach((context) => removePluginUiContext(context.id));
        currentPptxElementReferences.forEach((reference) =>
          removePptxElementReference(reference.id),
        );
        currentConversationSelections.forEach((reference) =>
          removeConversationSelectionReference(reference.id),
        );
        finalizeSubmittedDraft();
      };
      // [事务] 订阅只需建立一次，且只能由 accepted/duplicate/authoritative 触发结算；
      // 其它结论一律不清理，避免把被拒绝的正文从界面上抹掉。
      // [资源] 回调里先 cleanup 再判断：无论结论如何，这条 command 都不需要再听，
      // 留在注册表里会随会话增长泄漏。
      // [失败路径] active 标记兜住“订阅同步回调后立刻卸载”的竞态，防止对已卸载
      // 组件调用 setState。
      const subscribeToCommandResolution = (commandId: string) => {
        let active = true;
        let cleanup = () => undefined;
        submittedCommandId = commandId;
        const unsubscribe = pendingCommandRegistry.subscribeResolution(commandId, (resolution) => {
          if (!active) return;
          submittedCommandResolved = true;
          cleanup();
          if (
            resolution !== "accepted" &&
            resolution !== "duplicate" &&
            resolution !== "authoritative"
          ) {
            return;
          }
          void settleSubmittedContent();
        });
        cleanup = () => {
          if (!active) return;
          active = false;
          unsubscribe();
          commandResolutionCleanupsRef.current.delete(cleanup);
        };
        commandResolutionCleanupsRef.current.add(cleanup);
      };
      // [并发] 回滚前必须重读磁盘并与“追加后值”比对：不相等说明别的窗口已写入
      // 新历史，此时只能刷新 state，不能把对方的记录覆盖回发送前快照。
      // [事务] 相等才回写到发送前值，并同步 state；写盘与内存值必须同拍更新，
      // 否则 ↑ 导航会读到一条实际不存在的记录。
      // [失败路径] 三个前置快照任一为空说明从未写盘，直接返回，不做无意义回滚。
      const rollbackPromptHistory = () => {
        if (!promptHistoryWasPersisted || !promptHistoryBeforeSend || !promptHistoryAfterAppend) {
          return;
        }
        const currentPromptHistory = readPromptHistoryEntries(workspacePath);
        if (arePromptHistoryEntriesEqual(currentPromptHistory, promptHistoryAfterAppend)) {
          persistPromptHistoryEntries(workspacePath, promptHistoryBeforeSend);
          setPromptHistory(promptHistoryBeforeSend);
          return;
        }
        setPromptHistory(currentPromptHistory);
      };
      // [事务] try 范围从附件就绪检查开始：此刻已置 pending、已创建 sendAction，
      // 任何提前 return 都必须先把 telemetry 与 action 落定，否则留下悬空样本。
      // [失败路径] prepareForSend 返回 null 表示“有附件尚未就绪”，此时不得回落
      // 重新上传：那会把“没发出去”伪装成“已发送”，用户以为附件已随消息送达。
      try {
        // 二次门禁：只消费预传完成的 ref，不在点击发送时回落上传。
        const readyAttachmentRefs = await attachmentsApi.prepareForSend();
        if (readyAttachmentRefs === null) {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
          // send_click 已上报，此处不落定会留下无配对的悬空样本，污染成功率分母。
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "attachment_not_ready",
          });
          sendAction.fail({ failureStage: "attachment_not_ready" });
          return;
        }
        // 外部上下文不走协议附件；按 selection -> code comment -> web -> PPTX 的固定尾块顺序
        // 序列化，历史 user row 才能按相反顺序无损解析并隐藏内部 prompt block。
        //
        // 分享 handover 不在这里序列化：share URL 块纯粹是 renderer 自产自销（CLI/shared
        // 里没有任何东西解析它），唯一作用是驱动一个已被产品裁掉的 chip，代价却是把一个
        // share URL 塞进发给模型的正文。模型侧内容由隐藏的 shared_context 消息经
        // inputIntent.sharedContextRefs 注入，与正文无关。
        // [事务] 序列化只消费本轮冻结的上下文，且顺序写死：解析侧按相反顺序剥离，
        // 顺序一旦变化，历史消息会把内部 prompt block 当作正文渲染出来。
        // [并发] conversationSelections 传空数组而不是真实引用：会话引用走结构化
        // conversationQuotes 通道，若同时塞进正文会被模型看到两遍。
        const promptText = serializeComposerPromptContexts(trimmed, {
          codeComments: currentCodeCommentContexts,
          conversationSelections: [],
          webElements: currentWebElementContexts,
          pptxElements: currentPptxElementReferences,
          pluginUiContexts: currentPluginUiContexts,
        });
        // [事务] 只统计真正随消息下发的上下文：分享 handover 单独 +1，其余由
        // 序列化函数按类计数；两处口径必须一致，否则遥测的附件数与实际不符。
        const contextAttachmentCount =
          countComposerPromptContexts({
            codeComments: currentCodeCommentContexts,
            conversationSelections: currentConversationSelections,
            webElements: currentWebElementContexts,
            pptxElements: currentPptxElementReferences,
            pluginUiContexts: currentPluginUiContexts,
          }) + (submittedShareContext ? 1 : 0);
        if (trimmed) {
          // [事务] 历史写盘必须发生在真实发送之前，且是同步写：首发 accepted 后
          // SessionPane 会立刻 promote 并可能卸载本组件，异步写会丢记录。
          // [失败路径] 写盘失败不阻断发送：历史是便利功能，不能因为 localStorage
          // 不可用就让用户发不出消息；此时 promptHistoryWasPersisted 保持 false，
          // 回滚路径会自然跳过。
          promptHistoryBeforeSend = readPromptHistoryEntries(workspacePath);
          promptHistoryAfterAppend = appendPromptHistoryEntry(promptHistoryBeforeSend, trimmed);
          if (!arePromptHistoryEntriesEqual(promptHistoryBeforeSend, promptHistoryAfterAppend)) {
            // 预热首发 accepted 后，SessionPane 会立即 promote 到新 session，
            // draft composer 可能在 await 恢复前卸载；不能把写盘藏在 React state updater 里。
            // 这里继续沿用旧 UI 的 localStorage history，不接 input_history 数据库：
            // 发起真实发送前先同步写盘，若发送失败再恢复到发送前快照。
            persistPromptHistoryEntries(workspacePath, promptHistoryAfterAppend);
            promptHistoryWasPersisted = true;
            setPromptHistory(promptHistoryAfterAppend);
          }
        }
        // [事务] claim 必须紧贴 onSendText 之前：太早会隐藏用户正文且无回滚窗口，
        // 太晚则首发 promotion 可能已切 scope，旧正文被新 Composer 恢复。
        // [并发] 只有 startNow 才做乐观清空；queue/guide 必须等权威结算，
        // 提前清空会让“入队失败”表现为正文凭空消失。
        claimSubmittedDraft();
        if (requestedDelivery === "startNow") {
          // 原子抢占需要等旧 turn 退出并提交新 TurnStarted ACK；
          // 若编辑器也等整条链路才清空，用户会误以为快捷键未生效。
          // 先清空可见正文；命令拒绝时用冻结 editor state 原样恢复。
          inputApiRef.current?.clear();
          updateText("");
          cleanupRevision = contentRevisionRef.current;
          editorClearedOptimistically = true;
        }
        // [事务] payload 中所有可选字段都用展开语法：省略而不是传 undefined，
        // 让协议侧能区分“没带”与“显式置空”。
        // [并发] onCommandCreated 必须随请求下发：命令 id 可能在 Promise 返回前
        // 就产生，晚订阅会错过已有的结算结论。
        // [失败路径] 附件只在确有就绪项时才带；传空数组会被协议当成“清空附件”。
        const sendResult = await onSendText(promptText, {
          submittedDraftText: submittedDraft.text,
          submission,
          ...(currentConversationSelections.length
            ? {
                conversationQuotes: currentConversationSelections.map(
                  ({ text, path, senderName, senderId, messageId, sentAt }) => ({
                    text,
                    path,
                    senderName,
                    senderId,
                    messageId,
                    sentAt,
                  }),
                ),
              }
            : {}),
          telemetrySeed,
          onCommandCreated: subscribeToCommandResolution,
          ...(requestedDelivery ? { requestedDelivery } : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(readyAttachmentRefs.length > 0 ? { attachments: readyAttachmentRefs } : {}),
          ...(contextAttachmentCount > 0 ? { contextAttachmentCount } : {}),
          ...(submittedShareContext
            ? {
                sharedContextRefs: [
                  {
                    kind: "shared_context_import" as const,
                    context_id: submittedShareContext.contextId,
                  },
                ],
              }
            : {}),
        });
        // [失败路径] blocked 是产品 guard 的正常拒绝，不是异常：回滚历史、恢复正文，
        // 但不触碰附件与上下文，用户切换模式后可直接重试。
        // [事务] 必须落定 telemetry 与 userAction，否则会留下只有 send_click 的悬空样本。
        if (sendResult === "blocked") {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
          // 产品 guard 是一次正常拒绝，不应借异常路径表达；回滚发送前暂记的 history，
          // 同时不 clear editor/draft/附件，让用户切换模式后可以直接重试。
          rollbackPromptHistory();
          restoreSubmittedDraft();
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: sessionId ?? null,
            status: "fail",
            reasonCode: "blocked",
          });
          sendAction.reject({ resultSource: "authority_ack", admissionResult: "rejected" });
          return;
        }
        // [事务] 二次确认弹窗必须冻结当时的队列 id，并复用本次 seed 与 delivery；
        // 重新生成 seed 会让确认后的落定找不到 send_click。
        // [并发] 跨端 stale 时以最新投影替换 id 集合并要求重新确认：沿用旧 id
        // 会在另一端的队列已变化时误清用户的消息。
        // [失败路径] 弹窗打开期间不置 pending 完成态，finally 复位后按钮恢复可用，
        // 但确认路径会带着 existingTelemetrySeed 重新进入。
        if (sendResult === "confirmationRequired") {
          if (telemetrySeed.localTtft)
            getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, true);
          rollbackPromptHistory();
          restoreSubmittedDraft();
          const latestQueueItemIds =
            snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
          // 首次提交冻结当前队列；跨端 stale 后用最新投影替换，要求用户重新确认。
          setHeldQueueConfirmation({
            // 标记 queueConfirmed：确认后复用该 seed 落定，send_cost_ms 含用户在弹窗上的停留。
            telemetrySeed: { ...telemetrySeed, queueConfirmed: true },
            ...(requestedDelivery ? { requestedDelivery } : {}),
            queueItemIds:
              latestQueueItemIds.length > 0 ? latestQueueItemIds : submittedQueueItemIds,
          });
          sendAction.noop();
          return;
        }
        // [事务] 走到这里说明发送已被接受：先关确认框，再按冻结列表结算；
        // 结算内部还会再校验一次用户是否继续编辑。
        setHeldQueueConfirmation(null);
        // 发送成功或 ACK 丢失后由权威 projection 结算：清本次提交捕获的内容，
        // prompt history 已在真实发送前同步写盘，避免首发 promote 丢失或误清新 scope。
        await settleSubmittedContent();
        sendAction.complete({ resultSource: "authority_ack", admissionResult: "accepted" });
      } catch (error) {
        // [失败路径] 权威投影可能先于 reject 回调到达；结算已开始就不能再把旧草稿
        // 恢复回来，否则会把已进入消息列表的正文重新放回输入框。
        // [事务] 失败一律保留草稿在输入框，只记录原因并落定遥测；不弹阻断式错误，
        // 让用户可以直接重试。
        rollbackPromptHistory();
        // 权威 ACK/投影可能在 Promise 失败回调前先到达；清理已开始时不能再把旧草稿恢复回来。
        if (!submittedContentSettled) restoreSubmittedDraft();
        if (telemetrySeed.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        // 发送失败草稿保留在输入框（不清空），仅记录原因。
        logger.warn(`[v4-composer] 发送失败: ${String(error)}`);
        // ACK 侧失败已由 SessionPane 落定；能走到这里的是 composer 自身链路异常。
        conversationTelemetry?.settleSendResult({
          seed: telemetrySeed,
          sessionId: sessionId ?? null,
          status: "fail",
          reasonCode: "composer_error",
        });
        sendAction.fail({ failureStage: "composer_send" });
      } finally {
        // [事务] pending 是单一在途闩锁，必须在 finally 复位：任何提前 return 或
        // 抛错都不能跳过，否则 composer 会永久卡在“发送中”。
        // [并发] ref 与 state 同时复位；只复位 state 时同帧连点仍能穿过门禁。
        pendingRef.current = false;
        setPending(false);
      }
    },
    [
      attachmentsApi,
      conversationSelectionReferences,
      conversationTelemetry,
      draftConfig,
      createSubmissionFromComposer,
      submissionReady,
      remoteAvailable,
      runtimeBlocked,
      getCodeCommentContexts,
      telemetryDraftConfig,
      modelSelectionView,
      onSendText,
      pendingShareContext,
      provider,
      readPlanIdentitySnapshot,
      removeCodeCommentContext,
      removeConversationSelectionReference,
      removePptxElementReference,
      removeWebElementContext,
      removePluginUiContext,
      pluginUiContexts,
      sessionId,
      snapshotDraftOfEditor,
      updateText,
      updateComposerContent,
      webElementContexts,
      pptxElementReferences,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // Lexical onChange（首字符也稳定回传，见 LexicalChatInput.TextContentPlugin）。
  const handleEditorChange = useCallback(
    (value: string) => {
      // [事务] 每次变更同步推进两个事实源：textRef（供 submit 读取）与草稿内存副本；
      // 防抖落盘只补最新 editorState，不承担正文同步。
      // [资源] 遥测在这里采样文本长度即可，不能记录正文内容。
      conversationTelemetry?.recordComposerTextChange(value);
      updateText(value);
      // 正文先进入与 mode/model 相同的内存 Draft；防抖只负责补充最新 Lexical JSON。
      updateComposerContent({ text: value });
      scheduleDraftPersist();
    },
    [conversationTelemetry, scheduleDraftPersist, updateComposerContent, updateText],
  );

  // [并发] 程序性聚焦标记必须一次性消费：若不复位，后续用户真实点击也会被吞掉，
  // send_input_focus 将永远少一条。
  const handleEditorFocus = useCallback(() => {
    conversationTelemetry?.recordComposerFocus();
    // 程序性聚焦不算「点击输入框」；标记一次性消费，之后的手动 focus 照常上报。
    if (programmaticFocusRef.current) {
      programmaticFocusRef.current = false;
      return;
    }
    conversationTelemetry?.recordComposerFocusClick({
      sessionId: sessionId ?? null,
    });
  }, [conversationTelemetry, sessionId]);

  // 编辑器提交（Enter / 发送键 form submit 同路径）。返回 false：编辑器不自行 reset，
  // 由 submit 成功后经 inputApiRef.clear() 清空——失败时草稿留在输入框。
  // [事务] 提交前把编辑器最新值写入 textRef，避免受控值落后一帧导致发旧内容。
  // [并发] 反向投递标记只消费这一拍，读完立刻清零：留着会影响下一次普通发送。
  // [失败路径] 返回 false 让编辑器不自行清空，清空权归 submit 的成功路径，
  // 这样发送失败时草稿仍留在输入框。
  const handleEditorSubmit = useCallback(
    (value: string) => {
      textRef.current = value;
      const reverseDelivery = reversePointerDeliveryRef.current;
      reversePointerDeliveryRef.current = false;
      const followupMode = snapshotRef.current?.config.followupMode;
      void submit(
        undefined,
        undefined,
        undefined,
        reverseDelivery && followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  // [权衡] 组合键不读 inputRouting 推断空闲：turn 启动初期该值仍是 startNow，
  // 只能由“反向 delivery”表达意图，空闲时命令层自然回落为 startNow。
  const handleModifiedEditorSubmit = useCallback(
    (value: string) => {
      const followupMode = snapshotRef.current?.config.followupMode;
      textRef.current = value;
      // inputRouting 在 turn 启动初期可能仍为 startNow，不能用它
      // 推断空闲。组合键始终表达单次反向 delivery；空闲时 CLI 自然 startNow。
      void submit(
        undefined,
        undefined,
        undefined,
        followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  // [事务] 确认框的两个动作都必须透传冻结的 queueItemIds 与 seed：少了任一参数，
  // submit 会把“确认后的重试”当成一次全新发送。
  const handleClearQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "clearQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  // [事务] 保留队列发送与清空队列发送必须共用同一份冻结上下文，只在 disposition
  // 上分叉；两者各自重新组参会得到不一致的 seed。
  const handleKeepQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "keepQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  // [失败路径] 停止走 runUserAction 统一埋点：即使 onStop 抛错也要把失败阶段上报，
  // 不能让“点了没反应”既无日志也无指标。
  const handleStopClick = useCallback(() => {
    runUserAction({
      input: { featureId: "conversation.composer.message", action: "stop", trigger: "button" },
      operation: onStop,
      completed: { resultSource: "optimistic_projection" },
      failureStage: "stop_generation",
    });
  }, [onStop]);

  // 发送键是 type="submit"，与 Enter 共用 handleEditorSubmit；DOM 事件顺序保证 click 早于
  // submit，故这里只置标记，由 submit() 读取并复位。
  // [并发] 只在 onClick 里置标记、绝不在 onClick 里直接 submit：按钮是 type=submit，
  // 直接提交会让同一次点击触发两遍。
  // [权衡] 反转判定交给 shared 的指针纯函数，含平台差异；组件内只透传修饰键状态。
  const handleSendButtonClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      sendTriggerRef.current = "button";
      reversePointerDeliveryRef.current = shouldReverseFollowupDeliveryForPointer({
        enabled: modifiedEnterReversesDelivery,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isApplePlatform: appleKeyboardPlatform,
      });
    },
    [appleKeyboardPlatform, modifiedEnterReversesDelivery],
  );

  // ── 「加入对话」全局事件（workspace file tree 右键/按钮）→ mention 插入 ──
  // [资源] 全局 add-to-chat 监听必须在 listen 关闭或卸载时解绑：它是 window 级事件，
  // 残留会让“加入对话”写进一个已不可见的 composer。
  // [失败路径] 不是本应用的文件 payload 直接忽略，不 preventDefault，避免劫持
  // 浏览器原生的文件拖放行为。
  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleWorkspaceFileAddToChat = (event: Event) => {
      if (!isWorkspaceFileAddToChatEvent(event)) {
        return;
      }
      event.preventDefault();
      appendWorkspaceFileMentionToComposer({
        inputApiRef,
        currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
        payload: event.detail,
        workspacePath,
        workspaceIdentity,
        onTextChange: updateText,
      });
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    return () => {
      window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    };
  }, [listenAddToChatEvents, updateText, workspaceIdentity, workspacePath]);

  // 动态 placeholder（旧 chatViewPlaceholder 语义）：无历史 → newTask；
  // 有历史空闲 → followUpAsk；有历史处理中 → followUpQueue；
  // 完整视图浮窗（单行）运行中 → 「工作中 {时长}」，与流式消息同值同格式。
  // [权衡] 运行中优先展示“工作中 {时长}”而不是排队提示：两者信息量不同，
  // 时长是用户唯一能判断“要不要等”的依据。
  const workingDurationLabel =
    layout === "inline" && canStop
      ? formatConversationWorkDuration(workingDurationMs, intl, locale)
      : null;
  // [失败路径] placeholder 的 key 由快照推导而非本地状态：本地记录“是否处理中”
  // 在断线重连后会失真，用户会看到“可以继续提问”但其实 turn 还在跑。
  const normalPlaceholder = workingDurationLabel
    ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: workingDurationLabel })
    : intl.formatMessage({
        id: resolveChatPlaceholderKey({
          hasHistoryMessages: (snapshot?.rows.totalCount ?? 0) > 0,
          isTaskProcessing: canStop,
          // 单行输入框放不下完整的新任务提示，沿用手机远控的短文案。
          compactNewTask: compactMobilePlaceholder || layout === "inline",
        }),
      });
  // [权衡] tooltip 文案跟随 routing mode：enqueue 下必须明确写“加入队列”，
  // 否则用户会以为点下去是立刻打断当前 turn。
  const sendTooltipTitle = intl.formatMessage({
    id: mode === "enqueue" ? "chat.queue.enqueue" : "chat.send",
  });
  // [权衡] 修饰键提示只在“确实会改变行为”时出现：条件不满足时返回空，
  // 避免在按钮旁挂一条永远不成立的快捷键说明。
  // [并发] canSend 参与提示判定：按钮不可用时提示“按住发送到队列”只会误导用户。
  const modifierTooltip = resolveFollowupModifierTooltip({
    enabled: modifiedEnterReversesDelivery,
    canSend,
    modifierPressed: primaryModifierPressed,
    followupMode: snapshot?.config.followupMode,
    isApplePlatform: appleKeyboardPlatform,
  });
  // [事务] 提示标题按“修饰键提示优先、默认发送文案兜底”取值，顺序固定：
  // 反过来会让默认文案盖掉更有信息量的修饰键说明。
  const resolvedSendTooltipTitle = modifierTooltip
    ? intl.formatMessage({ id: modifierTooltip.titleId })
    : sendTooltipTitle;
  // [并发] 快捷键展示必须与当前平台一致：Mac 显示 ⌘、其它显示 Ctrl，
  // 由 shared 统一裁决而非组件内判断 navigator。
  const resolvedSendTooltipShortcut = modifierTooltip?.shortcut ?? sendShortcut;
  // [权衡] 停止按钮的 tooltip 不参与修饰键提示逻辑：停止没有“反向”语义，
  // 复用发送提示会让用户以为停止也能按修饰键切换行为。
  const stopTooltipTitle = intl.formatMessage({ id: "chat.stop" });
  // [事务] 错误横幅的可见性由 suppression 统一裁决：这里只做投影，
  // 不在这里改写 error，保证“是否展示”只有一个判定点。
  const visibleError = error && !shouldSuppressChatErrorBanner(error) ? error : null;

  // [并发] 用稳定 key 去重而不是按对象引用：同一条错误会因多次渲染产生新对象，
  // 不去重会把一次故障统计成几十次曝光。
  // [事务] 只有真正进入 render 的错误才上报；被 suppression 拦下的错误不该污染指标。
  // [资源] reportedErrorKeysRef 随组件生命周期回收，不做全局持久化，避免长期占用。
  useEffect(() => {
    if (!visibleError || !conversationTelemetry || !telemetryVisible) return;
    const telemetryKey = [
      visibleError.taskId ?? sessionId ?? "",
      visibleError.code ?? "",
      visibleError.traceId ?? "",
      visibleError.message,
    ].join(":");
    if (reportedErrorKeysRef.current.has(telemetryKey)) return;
    reportedErrorKeysRef.current.add(telemetryKey);
    // 错误只有经过 suppression 后真实进入 render 才曝光；同一 composer mount 相同 key 一次。
    conversationTelemetry.reportVisibleChatError({
      errorKey: telemetryKey,
      displayMessage: resolveChatErrorBannerDisplayMessage(visibleError, intl),
      error: visibleError,
    });
  }, [conversationTelemetry, intl, sessionId, telemetryVisible, visibleError]);

  // [失败路径] 附件选择器的埋点包在 runUserAction 里：选择被用户取消时也应记为
  // 一次正常完成，而不是失败，避免把取消行为算进错误率。
  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.composer.attachment" }),
      menuItemTestId: TID_CHAT_ATTACHMENT_MENU_ITEM,
      onSelect: () =>
        runUserAction({
          input: {
            featureId: "conversation.composer.attachment",
            action: "add",
            trigger: "button",
          },
          operation: attachmentsApi.openAttachmentPicker,
          completed: { resultSource: "local_commit" },
          failureStage: "attachment_picker",
        }),
      testId: TID_CHAT_ATTACHMENT_BUTTON,
    }),
    [intl, attachmentsApi.openAttachmentPicker],
  );

  // ── 附件预览网格 ──
  // [并发] 每次渲染都取一次当前数组，不缓存到 state：附件可能由 hook 内部异步
  // 追加，缓存副本会导致预览网格少一张。
  const composerAttachments = attachmentsApi.attachments;
  // [权衡] 排序只影响渲染：媒体在前更易辨认，但发送集合始终读 attachmentsApi 原数组，
  // 保证“看到的顺序”与“上传/发送的顺序”解耦。
  const orderedComposerAttachments = useMemo(() => {
    // 媒体组（图片/视频）优先、文件在后；组内保持添加顺序。
    const media: (typeof composerAttachments)[number][] = [];
    const files: (typeof composerAttachments)[number][] = [];
    for (const attachment of composerAttachments) {
      (isMediaChatComposerAttachment(attachment) ? media : files).push(attachment);
    }
    return [...media, ...files];
  }, [composerAttachments]);
  // [失败路径] 只有带 objectUrl 的媒体才可预览：缺 objectUrl 说明上传/解码尚未完成，
  // 硬塞进预览会得到一张破图。
  const composerMediaPreviewItems = useMemo(
    () =>
      composerAttachments.flatMap((attachment) =>
        attachment.objectUrl && isMediaChatComposerAttachment(attachment)
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [composerAttachments],
  );
  // [并发] 空态判断必须覆盖全部上下文类型：只判附件会让“只有代码评论”的草稿
  // 上方留出一条空行。
  // [失败路径] 预览区若为空则整块返回 null，不渲染空容器：空容器会吃掉
  // 编辑区上方的间距，让输入框在无附件时也显得下移。
  const topContentNode = useMemo(() => {
    if (
      composerAttachments.length === 0 &&
      codeCommentContexts.length === 0 &&
      webElementContexts.length === 0 &&
      pptxElementReferences.length === 0 &&
      conversationSelectionReferences.length === 0 &&
      pluginUiContexts.length === 0
    ) {
      return null;
    }
    return (
      <div className="flex max-w-full flex-col items-start gap-2">
        {composerAttachments.length > 0 ? (
          <Attachments
            variant="inline"
            className="flex max-w-full flex-wrap gap-2"
            data-composer-file-attachments-row="true"
          >
            {orderedComposerAttachments.map((attachment) => {
              const isClipboardTextAttachment = attachment.sourceKind === "clipboard-text";
              const isMediaAttachment = isMediaChatComposerAttachment(attachment);
              const isVideoAttachment = isVideoChatComposerAttachment(attachment);
              const isPdfAttachment = isPdfChatComposerAttachment(attachment);
              const mediaType = attachment.objectUrl
                ? attachment.mimeType
                : attachment.mimeType.startsWith("image/")
                  ? "application/octet-stream"
                  : attachment.mimeType;
              const canPreviewImageAttachment =
                Boolean(attachment.objectUrl) && isImageChatComposerAttachment(attachment);
              const canPreviewVideoAttachment = Boolean(attachment.objectUrl) && isVideoAttachment;
              const canPreviewPdfAttachment = Boolean(attachment.objectUrl) && isPdfAttachment;
              const fileDisplayDescriptor = resolveFileDisplayDescriptor(
                attachment.localPath ?? attachment.filename,
              );
              const uploadStatusLabel =
                attachment.uploadStatus === "uploading"
                  ? intl.formatMessage(
                      { id: "chat.attachments.upload.uploading" },
                      { progress: String(attachment.uploadProgress) },
                    )
                  : attachment.uploadStatus === "failed"
                    ? intl.formatMessage(
                        { id: "chat.attachments.upload.failed" },
                        { message: attachment.uploadError ?? "unknown" },
                      )
                    : intl.formatMessage({
                        id: `chat.attachments.upload.${attachment.uploadStatus}`,
                      });
              const showUploadStatus =
                !attachment.localZeroCopy &&
                (attachment.uploadStatus !== "ready" || attachment.showComplete);
              return (
                <Attachment
                  key={attachment.id}
                  variant={isMediaAttachment ? "grid" : "inline"}
                  data-composer-attachment-kind={
                    isVideoAttachment
                      ? "video"
                      : isMediaAttachment
                        ? "image"
                        : isPdfAttachment
                          ? "pdf"
                          : "file"
                  }
                  data-testid={testId(TID_V4_ATTACHMENT, attachment.id)}
                  data-upload-status={attachment.uploadStatus}
                  className={
                    isMediaAttachment
                      ? "relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                      : "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
                  }
                  data={{
                    id: attachment.id,
                    type: "file",
                    filename: attachment.filename,
                    ...(isClipboardTextAttachment
                      ? {
                          description: intl.formatMessage(
                            {
                              id: "chat.attachments.clipboardText.description",
                            },
                            {
                              lineCount: formatAttachmentLineCount(attachment, locale),
                            },
                          ),
                          displayName: intl.formatMessage({
                            id: "chat.attachments.clipboardText",
                          }),
                          sourceKind: "clipboard-text" as const,
                        }
                      : {}),
                    mediaType,
                    url: attachment.objectUrl ?? "",
                  }}
                  onRemove={() => attachmentsApi.removeAttachment(attachment.id)}
                  // 附件支持非图片格式，PDF 走独立 PdfViewer，
                  // 其他文件展示类型图标和文件名，避免 doc 等普通文件被当成图片渲染失败。
                  // 图片与视频统一按添加顺序进入发送前 gallery，
                  // 保证同一组媒体可以连续导航。
                  onOpen={
                    canPreviewImageAttachment || canPreviewVideoAttachment
                      ? () => {
                          const previewIndex = composerMediaPreviewItems.findIndex(
                            (item) => item.src === attachment.objectUrl,
                          );
                          if (previewIndex < 0) return;
                          setAttachmentPreviewIndex(previewIndex);
                          setAttachmentPreviewOpen(true);
                        }
                      : canPreviewPdfAttachment
                        ? () => {
                            setPdfAttachmentPreview({
                              filename: attachment.filename,
                              mediaType: "application/pdf",
                              url: attachment.objectUrl,
                            });
                            setPdfAttachmentPreviewOpen(true);
                          }
                        : undefined
                  }
                  openLabel={
                    canPreviewVideoAttachment
                      ? videoAttachmentPreviewTitle
                      : canPreviewImageAttachment
                        ? attachmentPreviewTitle
                        : canPreviewPdfAttachment
                          ? intl.formatMessage({ id: "chat.attachments.preview.openPdf" })
                          : undefined
                  }
                >
                  <div
                    className={cn(
                      "relative shrink-0",
                      isMediaAttachment ? "size-full" : "size-9 rounded-md bg-background",
                    )}
                  >
                    <AttachmentPreview
                      className={cn(
                        isMediaAttachment ? "size-full rounded-none" : "size-9 rounded-md",
                      )}
                      fallbackIcon={
                        isClipboardTextAttachment ? (
                          <ClipboardPenLineIcon className="size-3.5 text-muted-foreground" />
                        ) : (
                          <FileDisplayIcon
                            src={fileDisplayDescriptor.fileIconSrc}
                            size={16}
                            className="size-4 shrink-0"
                          />
                        )
                      }
                    />
                    {showUploadStatus && isMediaAttachment ? (
                      <span
                        data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                        role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                        aria-label={uploadStatusLabel}
                        className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
                      >
                        <svg
                          aria-hidden="true"
                          className="absolute inset-0 size-full -rotate-90 text-brand"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="stroke-border"
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeWidth="2"
                          />
                          <circle
                            className={
                              attachment.uploadStatus === "failed"
                                ? "stroke-destructive"
                                : "stroke-current"
                            }
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeDasharray={`${attachment.uploadProgress} 100`}
                            strokeLinecap="round"
                            strokeWidth="2"
                          />
                        </svg>
                        <span className="relative">
                          {attachment.uploadStatus === "failed"
                            ? "!"
                            : `${attachment.uploadProgress}%`}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {!isMediaAttachment ? (
                    isClipboardTextAttachment ? (
                      <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                    ) : (
                      <div className="min-w-0 max-w-40 flex-1">
                        <span
                          className="block truncate text-ui-base font-medium text-foreground"
                          title={attachment.filename}
                        >
                          {attachment.sourceKind === "topic-history"
                            ? intl.formatMessage(
                                { id: "chat.attachments.topicHistory" },
                                { count: attachment.messageCount ?? 0 },
                              )
                            : attachment.filename}
                        </span>
                        <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                          {getComposerAttachmentTypeLabel(attachment.filename, attachment.mimeType)}
                        </span>
                      </div>
                    )
                  ) : null}
                  {showUploadStatus && !isMediaAttachment ? (
                    <span
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                      role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                      title={uploadStatusLabel}
                      className={cn(
                        "max-w-28 truncate text-ui-sm font-normal text-foreground-subtle",
                        attachment.uploadStatus === "failed" && "text-destructive",
                      )}
                    >
                      {attachment.uploadStatus === "uploading"
                        ? `${attachment.uploadProgress}%`
                        : uploadStatusLabel}
                    </span>
                  ) : null}
                  {attachment.uploadStatus === "failed" ? (
                    <button
                      type="button"
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, attachment.id)}
                      aria-label={intl.formatMessage({
                        id: "chat.attachments.upload.retry",
                      })}
                      title={uploadStatusLabel}
                      className="grid size-5 shrink-0 place-items-center rounded-md text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        attachmentsApi.retryAttachment(attachment.id);
                      }}
                    >
                      <RotateCcwIcon className="size-3" />
                    </button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-composer-attachment-remove={attachment.id}
                    aria-label={intl.formatMessage({
                      id: "chat.attachments.remove",
                    })}
                    className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      attachmentsApi.removeAttachment(attachment.id);
                    }}
                  >
                    <XIcon className="size-2.5" />
                  </Button>
                </Attachment>
              );
            })}
          </Attachments>
        ) : null}
        {codeCommentContexts.length > 0 ||
        webElementContexts.length > 0 ||
        pptxElementReferences.length > 0 ||
        conversationSelectionReferences.length > 0 ||
        pluginUiContexts.length > 0 ? (
          <div
            className="flex max-w-full flex-wrap items-center gap-2"
            data-composer-context-attachments-row="true"
          >
            <CodeCommentAttachmentChip
              comments={codeCommentContexts}
              onRemove={removeCodeCommentContext}
              onRemoveAll={clearCodeCommentContexts}
            />
            <WebElementContextAttachmentChip
              contexts={webElementContexts}
              onRemove={removeWebElementContext}
              onRemoveAll={clearWebElementContexts}
            />
            <PluginUiModelContextChip
              contexts={pluginUiContexts}
              onRemove={removePluginUiContext}
              onRemoveAll={clearPluginUiContexts}
            />
            <PptxElementReferenceChip
              references={pptxElementReferences}
              onOpen={onOpenCodeViewer ? openPptxElementReference : undefined}
              onRemove={removePptxElementReference}
              onRemoveAll={clearPptxElementReferences}
            />
            <ConversationSelectionReferenceChip
              references={conversationSelectionReferences}
              onRemove={removeConversationSelectionReference}
              onRemoveAll={clearConversationSelectionReferences}
            />
          </div>
        ) : null}
      </div>
    );
  }, [
    attachmentPreviewTitle,
    attachmentsApi,
    clearCodeCommentContexts,
    clearConversationSelectionReferences,
    clearWebElementContexts,
    clearPluginUiContexts,
    clearPptxElementReferences,
    codeCommentContexts,
    composerAttachments,
    composerMediaPreviewItems,
    orderedComposerAttachments,
    intl,
    locale,
    removeCodeCommentContext,
    removeConversationSelectionReference,
    removeWebElementContext,
    removePluginUiContext,
    removePptxElementReference,
    conversationSelectionReferences,
    pendingShareContext,
    webElementContexts,
    pluginUiContexts,
    pptxElementReferences,
    onOpenCodeViewer,
    openPptxElementReference,
  ]);

  // 发送/停止控制簇（对齐旧 ChatViewComposer.submitControlNode 结构：
  // 左侧 model/thought/usage 簇 + 右侧 stop 或 send）。
  // useMemo：composer 随流式 snapshot 高频重渲染，控制簇只在语义依赖变化时重建，
  // 避免每个 token 批次都重建 Tooltip/Select 子树。
  const composerUsage = snapshot?.usage ?? null;
  const composerPhase = snapshot?.control.phase ?? null;
  const handleSelectModelTrace = useCallback(
    (
      nextProvider: string,
      nextModel: string,
      sourceModel: ModelSelectionSource | null,
      reasoningLevel?: string,
    ) =>
      runUserAction({
        input: {
          featureId: "conversation.composer.config",
          action: "change_model",
          trigger: "select",
        },
        operation: () =>
          reasoningLevel === undefined
            ? onSelectModel(nextProvider, nextModel, sourceModel)
            : onSelectModel(nextProvider, nextModel, sourceModel, reasoningLevel),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "model_change",
      }),
    [onSelectModel],
  );
  // [事务] 发送/停止控制簇按“能否停止 + 是否有草稿”二分，二者互斥：
  // 同时渲染会让同一位置出现两个主操作，用户无法判断哪个会真正生效。
  // [失败路径] 远端不可用时仍渲染禁用态按钮而不是隐藏：隐藏会让工具栏塌陷，
  // 用户在连接恢复后找不到发送键。
  const submitControlNode = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1">
        {!remoteAvailable ? (
          <span
            data-testid="remote-send-unavailable"
            className="max-w-40 text-right text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage({ id: "remote.conversation.sendUnavailable" })}
          </span>
        ) : null}
        {remoteAvailable ? (
          <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
            <V4ComposerModelControls
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              modelSelectionView={modelSelectionView}
              modelSelectionState={modelSelectionState}
              modelSelectionReload={modelSelectionReload}
              modelSelectionRefresh={modelSelectionRefresh}
              sessionId={sessionId ?? null}
              phase={composerPhase}
              provider={provider}
              isWebRemoteControl={isWebRemoteControl}
              isMobileViewport={isMobileTextInputViewport}
              draftMode={draftMode}
              draftConfig={draftConfig}
              usage={composerUsage}
              disabled={disabled || runtimeBlocked}
              modelLocked={highspeedCard !== null}
              highspeedPresented={highspeedPresented}
              highspeedEntranceAnimated={highspeedEntranceAnimated}
              highspeedSweepActive={highspeedSweepActive}
              highspeedExpiresAt={highspeedCard?.expiresAt}
              highspeedModel={highspeedCard?.model}
              activeConfigPicker={activeConfigPicker}
              onConfigPickerOpenChange={handleConfigPickerOpenChange}
              onSelectModel={handleSelectModelTrace}
              onSelectThought={onSelectThought}
              onSwitchMode={onSwitchMode}
              onRecoverCustomModelSelection={onRecoverCustomModelSelection}
              onSendCompressionCommand={onSendCompressionCommand}
            />
          </span>
        ) : null}
        {showStopControl ? (
          <ControlHintTooltip title={stopTooltipTitle} shortcut="Esc">
            <Button
              type="button"
              variant="secondary"
              size="icon-md"
              onClick={handleStopClick}
              data-testid={TID_V4_STOP}
              aria-label={stopTooltipTitle}
            >
              <SquareIcon className="size-4 fill-current" />
              <span className="sr-only">{stopTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        ) : (
          <ControlHintTooltip
            title={resolvedSendTooltipTitle}
            shortcut={resolvedSendTooltipShortcut}
            open={Boolean(modifierTooltip) || sendTooltipOpen}
            onOpenChange={setSendTooltipOpen}
          >
            <Button
              type="submit"
              size="icon-md"
              disabled={!canSend}
              onClick={handleSendButtonClick}
              data-testid={TID_V4_COMPOSER_SEND}
              aria-label={resolvedSendTooltipTitle}
              className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
            >
              {pending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
              <span className="sr-only">{resolvedSendTooltipTitle}</span>
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    ),
    [
      canSend,
      activeConfigPicker,
      composerPhase,
      composerUsage,
      disabled,
      runtimeBlocked,
      draftConfig,
      draftMode,
      handleStopClick,
      handleSendButtonClick,
      handleConfigPickerOpenChange,
      highspeedCard,
      highspeedEntranceAnimated,
      highspeedPresented,
      highspeedSweepActive,
      isWebRemoteControl,
      mode,
      handleSelectModelTrace,
      modelSelectionReload,
      modelSelectionRefresh,
      modelSelectionState,
      modelSelectionView,
      onSelectThought,
      onRecoverCustomModelSelection,
      onSendCompressionCommand,
      onSwitchMode,
      pending,
      provider,
      modifierTooltip,
      resolvedSendTooltipShortcut,
      resolvedSendTooltipTitle,
      sendTooltipOpen,
      remoteAvailable,
      sendShortcut,
      sendTooltipTitle,
      sessionId,
      showStopControl,
      stopTooltipTitle,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // 左下：模式选择 + CUA 入口 + 当前 session 后台任务入口。followupMode 由 app 设置页同步到 CLI，
  // 不在 composer 暴露局部开关；后台入口只消费同一 snapshot，不维护第二份任务状态。
  // [权衡] 左侧动作区只装配入口，不承载业务判断：模型/模式切换的可用性由各自
  // 组件读取快照决定，避免 composer 变成第二个配置事实源。
  const leadingActionsNode = useMemo(
    () => (
      <>
        <V4ComposerModeSwitch
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          provider={provider}
          draftConfig={draftConfig}
          disabled={disabled || runtimeBlocked}
          activeConfigPicker={activeConfigPicker}
          onConfigPickerOpenChange={handleConfigPickerOpenChange}
          onSwitchMode={onSwitchMode}
        />
        {/* Bug 原因：附件画廊 rebase 曾整段覆盖 leadingActions，误删 staging 的 CUA 常驻入口。
            入口自身继续负责平台、远程与设置可见性，不在 composer 重复判定。 */}
        <V4ComposerCuaEntry
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId}
          isWebRemoteControl={isWebRemoteControl}
          currentSessionBusy={canStop}
        />
        <ConversationBackgroundWorkTrigger
          backgroundWorks={snapshot?.backgroundWorks ?? []}
          runningSubagentCount={runningSubagentCount}
          onOpen={onOpenRunningBackgroundWorks}
          openTarget={backgroundWorkOpenTarget}
        />
      </>
    ),
    [
      activeConfigPicker,
      canStop,
      disabled,
      runtimeBlocked,
      draftConfig,
      handleConfigPickerOpenChange,
      isWebRemoteControl,
      backgroundWorkOpenTarget,
      onOpenRunningBackgroundWorks,
      onSwitchMode,
      provider,
      remoteSessionId,
      runningSubagentCount,
      snapshot?.backgroundWorks,
      workspaceIdentity,
      workspacePath,
    ],
  );
  // [权衡] 被 bottom dock 阻塞时只隐藏不卸载：卸载会丢掉草稿、附件与编辑器内部状态；
  // 用 display:none 同时保留布局占位与无障碍可访问性都由外层控制。
  const isBlockedByInteraction = blockingRequestId !== null;
  // [并发] 阻塞期间 aria-hidden 与 display 必须同时作用：只隐藏视觉会让读屏
  // 仍然聚焦到一个不可交互的输入框。

  // v4 pendingInteractions 是 bottom dock 阻塞态；composer 必须保留挂载，
  // 只在视觉和可访问树中隐藏，避免权限/问答卡片出现时丢失草稿和编辑器内部状态。
  return (
    // 外层 bottom dock 负责 sticky 与横向主列宽度；composer 自身组织错误提示与输入壳。
    // centered（居中草稿布局，m5）：收窄 max-w-2xl（旧
    // getChatViewComposerWidthClassName 的 draft 档），由宿主的居中容器摆位。
    // 有 contextHeader（草稿态）时，内层输入 surface 套旧 ChatViewComposer 同款卡：
    // rounded-2xl bg-surface shadow-xl/5；会话态回落不透明页面底色。
    // 错误横幅虽然排在 contextHeader 前面，但不能与输入区共用同一个圆角 surface，
    // 视觉上会被误认为输入卡标题栏；将 surface 边界收窄到工作区头和编辑器后，桌面与手机
    // Web 仍共享同一 DOM 顺序，同时恢复错误提示与输入卡之间的独立层级。
    <div
      data-testid={TID_V4_COMPOSER}
      data-input-routing={mode}
      aria-hidden={isBlockedByInteraction ? true : undefined}
      style={isBlockedByInteraction ? { display: "none" } : undefined}
      className={cn(
        "chat-composer-region z-20 w-full shrink-0 @container/composer",
        centered && "max-w-2xl",
      )}
    >
      {/* 旧 ChatViewComposer 同款隐藏 file input（web/无 native picker 平台回退）。 */}
      <input
        ref={attachmentsApi.attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={attachmentsApi.handleAttachmentInputChange}
      />
      {visibleError ? (
        // 仅展示附件错误会漏掉会话级 lastError，任务失败后也应在输入框上方显示原因。
        // 这里复用旧 ChatErrorBanner 壳，只接收 SessionPane 已归一化后的当前错误。
        // 错误横幅独立于输入 surface，并先于桌面和手机共用的 contextHeader。
        <div className="mb-6 w-full shrink-0">
          <ChatErrorBanner
            error={visibleError}
            remoteKind={
              remoteKind?.kind === "workspace" ? remoteKind.remoteTarget?.kind : undefined
            }
            onReconnect={
              reconnectProject || remoteController
                ? () => {
                    const request = reconnectProject
                      ? reconnectProject(workspaceKey)
                      : remoteController?.dispatch({ type: "reconnect-workspace", workspaceKey });
                    void request?.catch((error: unknown) =>
                      logger.warn("[v4-composer] 项目重连失败", { error }),
                    );
                  }
                : undefined
            }
            onDismiss={onDismissError}
            onOpenModelSettings={onOpenModelSettings}
            onOpenUpgrade={onOpenModelUpgrade}
            modelConfigTarget={modelConfigTarget}
          />
        </div>
      ) : null}
      {initialization?.status === "failed" ? (
        // 初始化中只限制执行，不额外显示提示；失败时才显示错误和重试。
        // 状态条悬在可滚动正文上方；必须使用不透明 card，避免历史文字透入错误提示。
        <div
          data-testid="v4-session-initialization"
          role="alert"
          className="mb-2 flex w-full flex-wrap items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "chat.initialization.failed" })}
          </span>
          {onRetryInitialization ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="v4-session-initialization-retry"
              onClick={onRetryInitialization}
            >
              {intl.formatMessage({ id: "chat.initialization.retry" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        data-highspeed-composer={highspeedCard ? "true" : undefined}
        data-highspeed-entrance={highspeedCard ? highspeedEntrance : undefined}
        className={cn(
          "chat-composer-input-surface relative w-full",
          contextHeader && "rounded-2xl bg-surface shadow-xl/5",
          highspeedCard && "highspeed-composer-surface",
          highspeedPresented && "highspeed-placeholder-presented",
        )}
      >
        {highspeedCard ? (
          <HighspeedComposerBackground
            key={highspeedCard.cardId}
            animated={highspeedEntranceAnimated}
            onModelTransitionStart={handleHighspeedModelTransitionStart}
          />
        ) : null}
        {contextHeader ? (
          // 旧 ChatViewComposer contextHeaderContent 同款包装（workspace 菜单 + Git 分支）。
          <div className="relative z-10 p-1.5 flex min-w-0 flex-wrap items-center gap-0">
            <ComposerSubmissionPendingContext.Provider value={updateTargetSelectionPending}>
              {contextHeader}
            </ComposerSubmissionPendingContext.Provider>
          </div>
        ) : null}
        {conversationSelectionLimitReason ? (
          <div
            role="alert"
            className="relative z-10 mb-2 w-full rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-ui-base text-foreground"
          >
            {intl.formatMessage({
              id: `chat.selections.limit.${conversationSelectionLimitReason}`,
            })}
          </div>
        ) : null}
        <ChatPromptEditor
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={sessionId}
          skillCatalogSessionId={skillCatalogSessionId}
          placeholder={
            remoteAvailable
              ? normalPlaceholder
              : intl.formatMessage({ id: "remote.conversation.sendUnavailable" })
          }
          disabled={disabled || mode === "reject"}
          submitting={pending}
          submitDisabled={
            runtimeBlocked || pending || !routingAllowsSend || !attachmentsReady || !submissionReady
          }
          allowSubmitWhenEmpty={
            // 发送按钮已把代码评论视为可发送上下文，但这里曾漏掉同一状态，
            // 导致空文本仅附代码评论时 Enter 被编辑器判为空，必须改点发送按钮。
            hasCodeCommentContexts ||
            hasAttachments ||
            hasWebElementContexts ||
            hasPptxElementReferences ||
            hasConversationSelectionReferences ||
            hasPluginUiContexts
          }
          enterSubmits={enterSubmits}
          onModifiedSubmit={modifiedEnterSubmits ? handleModifiedEditorSubmit : undefined}
          submitLabel={sendTooltipTitle}
          showSlashButton
          // @ 是 Plugin / 文件 / 对话 / 画板主入口；# 会话与 $ / ¥ / ￥ Skills
          // 仍由 MentionPlugin 保留兼容触发，但不在 + 菜单重复展示。
          showMentionButton
          topContent={topContentNode}
          attachmentAction={runtimeBlocked ? undefined : attachmentAction}
          inputTestId={TID_V4_COMPOSER_INPUT}
          inputApiRef={inputApiRef}
          promptHistory={promptHistory}
          avoidIosInputFocusZoom={avoidIosInputFocusZoom}
          compactPlaceholder={compactMobilePlaceholder}
          // Bugfix 原因：命令目录必须完整来自 CLI workspace slash catalog；UI 只在
          // secondary pane 按产品能力隐藏 goal，不再追加任何内建命令或别名。
          excludedSlashCommandNames={suppressGoalCommands ? ["goal"] : undefined}
          appSlashCommands={runtimeBlocked ? [] : appSlashCommands}
          enableMentionPanel
          leadingActions={leadingActionsNode}
          submitControl={submitControlNode}
          layout={layout}
          className="p-0"
          shellClassName={
            highspeedCard
              ? "relative z-10 !rounded-none !border-0 !bg-transparent !transition-none hover:!border-transparent focus-within:!border-transparent focus-within:!bg-transparent"
              : undefined
          }
          onChange={handleEditorChange}
          onFocus={handleEditorFocus}
          onSubmit={handleEditorSubmit}
          onWhiteboardMentionSelected={attachmentsApi.handleWhiteboardMentionSelected}
          onPaste={attachmentsApi.handlePaste}
        />
        {attachmentsApi.attachmentError ? (
          <p className="flex items-start gap-2 p-3 text-ui-base text-warning">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <span>{attachmentsApi.attachmentError}</span>
          </p>
        ) : null}
      </div>
      <ImagePreviewDialog
        initialIndex={attachmentPreviewIndex}
        items={composerMediaPreviewItems}
        onOpenChange={setAttachmentPreviewOpen}
        open={attachmentPreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfAttachmentPreview}
        open={pdfAttachmentPreviewOpen}
        onOpenChange={(open) => {
          setPdfAttachmentPreviewOpen(open);
          if (!open) setPdfAttachmentPreview(null);
        }}
      />
      <Dialog
        open={heldQueueConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !pendingRef.current) {
            if (heldQueueConfirmation?.telemetrySeed.localTtft)
              getLocalTtftObserver()?.exclude(
                heldQueueConfirmation.telemetrySeed.localTtft,
                "cancelled",
              );
            setHeldQueueConfirmation(null);
          }
        }}
      >
        <DialogContent
          data-testid={TID_V4_PAUSED_QUEUE_SEND_DIALOG}
          showCloseButton={false}
          className="max-w-xl gap-6 p-6 sm:p-8"
        >
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={pending}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute top-4 right-4"
            >
              <XIcon className="size-5" />
            </Button>
          </DialogClose>
          <DialogHeader className="gap-3 pr-8">
            <DialogTitle className="text-xl font-semibold sm:text-2xl">
              {intl.formatMessage({ id: "chat.queue.sendConfirm.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-base sm:text-ui-lg">
              {intl.formatMessage(
                { id: "chat.queue.sendConfirm.description" },
                {
                  count: String(heldQueueConfirmation?.queueItemIds.length ?? 0),
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:gap-3">
            <Button
              type="button"
              variant="destructive"
              size="lg"
              data-testid={TID_V4_COMPOSER_CLEAR_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleClearQueueSend}
            >
              {intl.formatMessage({ id: "chat.queue.sendConfirm.clear" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_V4_COMPOSER_KEEP_QUEUE_SEND}
              disabled={pending}
              className="min-w-32 rounded-full"
              onClick={handleKeepQueueSend}
            >
              {pending ? <Spinner className="size-4" /> : null}
              {intl.formatMessage({ id: "chat.queue.sendConfirm.keep" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// [权衡] 导出层用 memo 包裹，比较的是父级传入的 props 引用：宿主必须保证回调稳定，
// 否则每次渲染都会击穿 memo，把整棵编辑器子树重建。
// [并发] memo 不改变内部状态机语义：所有在途提交/草稿状态都活在 Impl 内，
// 重新渲染不会重置；真正的重置只由 scope 切换触发。
export const ConversationComposer = memo(ConversationComposerImpl);
