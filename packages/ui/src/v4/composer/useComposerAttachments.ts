// ============================================================================
// [b18 深注] 文件头：useComposerAttachments.ts —— 职责边界
//   composer 附件区唯一状态机：采集（文件/粘贴/拖拽/白板）、按 scope 入队上传、
//   session 换代时作废与重传、发送前的 ready 门禁与 adopt 移交。
//   不负责：字节传输实现（attachmentUpload.ts / transferService）、远端暂存协议、
//   runtime 生命周期判定（只消费 onRuntimeLifecycle 信号）、消息发送本身。
// ============================================================================
// 不变量（INV）表：断言 —— 守住位置 —— 改错后的故障
//   INV-01 每个 composer 一组附件，key=(identity||path)+NUL+scopeId —— buildScopeKey —— 改错：多窗口草稿串台。
//   INV-02 上传并发不超过 COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY —— pumpQueue 的 activeUploadsRef 比较 —— 改错：并发上传打爆 IPC。
//   INV-03 队列必须按 scopeKey+attachmentId 去重 —— enqueueUpload 的 exists 判断 —— 改错：同一附件被上传两次。
//   INV-04 每个附件同时只有一个 AbortController，且回调写回前按对象身份比对 —— controllersRef —— 改错：旧上传覆盖新状态。
//   INV-05 finally 必须递减 activeUploadsRef 并再次 pump —— runUpload —— 改错：并发计数泄漏，队列永久卡死。
//   INV-06 remove/clear 必须同时清队列、complete、retry、controller 与远端暂存 —— 三处清理逻辑 —— 改错：幽灵上传与远端残留。
//   INV-07 远端判定只认 remoteSessionId 或非空 workspaceIdentity —— isRemoteAttachmentTarget —— 改错：远端路径被当本地零拷贝直读。
//   INV-08 远端缺 remoteSessionId 一律降级 waitingSession —— runUpload 早退分支 —— 改错：远端 Agent 读到不存在的路径。
//   INV-09 stage 返回 staged=false 必须报错终止 —— RemoteAttachmentNotStagedError —— 改错：发送无法物化的附件引用。
//   INV-10 换代作废只处理 composer 所有权、非 zero-copy、非 failed 的项 —— invalidateAttachmentsForRuntimeChange 的过滤 —— 改错：session 资产被误清或被重复重传。
//   INV-11 重传配额只增不减，达到上限必须转 failed 且不可静默 —— runtimeRebuildRetryCount —— 改错：无限重传或失败永不可见。
//   INV-12 作废与唤醒必须解耦：作废只降级，入队交给 restartEpoch 唤醒 —— 两个 effect —— 改错：陈旧 sessionId 入队直撞 sessionNotFound。
//   INV-13 onRuntimeLifecycle 与 onRuntimeRestart 二选一订阅 —— 订阅 effect 的早退 —— 改错：同一次换代作废两次，白烧配额。
//   INV-14 attachmentSessionId 变化与 restartEpoch 都必须触发唤醒 —— 唤醒 effect 依赖数组 —— 改错：正式会话恢复后附件永久 waitingSession。
//   INV-15 prepareForSend 只在全部 ready 且都有 ref 时放行 —— 该函数 —— 改错：提交半成品附件。
//   INV-16 adopt 失败不得回滚 composer 状态 —— adoptSentAttachments 的 catch —— 改错：已发送附件重新出现在输入框。
//   INV-17 超过 MAX_CHAT_ATTACHMENTS 的部分必须 revoke —— addPreparedAttachments —— 改错：Blob URL 泄漏。
//   INV-18 拖拽反馈必须有 window/document 级兜底清理 —— 反馈 effect —— 改错：拖出窗口后高亮残留。
//   INV-19 白板 add-to-chat 事件必须按 listenAddToChatEvents 门控并比对 workspace key —— 事件 effect —— 改错：后台 composer 被静默塞附件。
//   INV-20 paste 优先 files，但表格文本优先时不吞事件 —— handlePaste —— 改错：从 Excel 复制时丢格式或重复添加。
//   INV-21 store selector 必须回落到稳定空数组 —— 订阅处 —— 改错：每次渲染返回新数组，无限重渲染。
//   INV-22 清理定时器时必须 delete map 条目 —— finishWithReady 与重试分支 —— 改错：map 无限增长且旧定时器误改新项。
/* oxlint-disable eslint(max-lines) -- 附件采集、分 scope 上传调度和生命周期必须在同一 hook 中原子收口。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { nanoid } from "nanoid";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import {
  MAX_CHAT_ATTACHMENTS,
  MissingInlinePdfContentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
  createChatComposerAttachment,
  createChatComposerPathAttachment,
  createClipboardTextAttachmentFilenameForDate,
  createClipboardTextPathComposerAttachment,
  formatAttachmentSize,
  revokeChatComposerAttachment,
  serializeChatComposerAttachment,
  shouldCreateClipboardTextAttachment,
  shouldPreferSpreadsheetClipboardText,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import {
  WHITEBOARD_ADD_TO_CHAT_EVENT,
  buildWhiteboardWorkspaceKey,
  createWhiteboardPngFile,
  isWhiteboardAddToChatEvent,
} from "@/lib/whiteboard.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import type { ChatComposerPasteEvent } from "@/LexicalChatInput.js";
import type { IPromptAttachmentTransferService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  exposeComposerAttachmentScopeKeyForE2E,
  readComposerAttachmentScope,
  updateComposerAttachmentScope,
  useComposerAttachmentUploadStore,
  type ComposerAttachmentUploadItem,
  type ComposerAttachmentUploadStatus,
} from "@/store/composerAttachmentUploadStore.js";
import { uploadComposerAttachment, type AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";

// [资源] 并发上限 2：每次上传都伴随 IPC 与磁盘读，过高会挤占消息流带宽。
// 调整该值必须同时验证 pumpQueue 的计数逻辑与进度条抖动。
// 不要改成 0 或负数：while 条件直接空转退出，队列永远不消费。
// 该常量是模块级只读，不随 workspace 或设备变化。
export const COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY = 2;
// [权衡] 瞬时失败只自动重试一次，延迟 500ms 给 runtime 喘息时间。
// 常量只影响 runUpload 中安排重试的 setTimeout，不影响用户手动重试。
export const COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS = 500;
// [契约] ready 后展示完成态的时长；zero-copy 项不展示（finishWithReady 的 showComplete）。
// 缩短到 0 会让完成态闪一下就消失，用户无法确认上传成功。
export const COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS = 300;
/**
 * 换代重传的兜底上限。dev 实测同一 workspace 可达 runtimeGeneration=4（3 次换代），
 * 取 5 留余量；它只防 Helper 反复崩溃时的无限重传，正常使用不该触达。
 */
// [资源] 换代重传的兜底上限，只防 Helper 反复崩溃时的无限重传。
// 计数只在 invalidateAttachmentsForRuntimeChange 中递增，retryAttachment 会清零。
// 达到上限必须转 failed 并写错误，静默降级到此为止。
// 正常使用不该触达：dev 实测同一 workspace 最多 3 次换代。
export const COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT = 5;
// [契约] 稳定空数组：selector 回落到它，避免每次渲染返回新引用导致重渲染。
// 禁止在此数组上 push 或 sort：它被所有 scope 共享。
const EMPTY_COMPOSER_ATTACHMENTS: ComposerAttachmentUploadItem[] = [];
// [契约] 错误码与 RemoteAttachmentNotStagedError 共用，供重试判定精确排除。
// 修改该字符串会让已持久化的日志与分析脚本失配。
const REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE = "remoteAttachmentNotStaged";
export type {
  ComposerAttachmentUploadItem,
  ComposerAttachmentUploadStatus,
} from "@/store/composerAttachmentUploadStore.js";

// [契约] 渲染期写入 targetsRef 的 per-scope 目标；sessionId 可能陈旧（换代事件先于渲染）。
// attachmentPut 与 transferService 是两条通道：本地字节写入与远端暂存。
// remoteSessionId 缺失时远端路径必须先等待会话，不能退回本地 put。
interface UploadTarget {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  attachmentPut: AttachmentPutFn;
  transferService: IPromptAttachmentTransferService;
}

// [契约] 队列只存定位键，不存 item 快照：入队后状态仍以 store 为准。
// scopeKey 内含 NUL 分隔，避免路径与 scope 拼接产生歧义。
interface UploadQueueEntry {
  scopeKey: string;
  attachmentId: string;
}

// [契约] 这是 composer 与附件区之间的唯一通道；新增字段必须同步 return useMemo 与依赖数组。
// hasUnreadyAttachments 是发送按钮的只读门禁。
// clearAttachments 的 id 参数语义是「只清这批」，不传才是全清。
export interface ComposerAttachmentsApi {
  attachments: ComposerAttachmentUploadItem[];
  attachmentError: string | null;
  hasAttachments: boolean;
  hasUnreadyAttachments: boolean;
  composerDragKind: "attachment" | "workspace" | null;
  isDraggingOverComposer: boolean;
  attachmentInputRef: React.RefObject<HTMLInputElement | null>;
  openAttachmentPicker: () => void;
  handleAttachmentInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (event: ChatComposerPasteEvent) => void;
  handleDragOverComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDragLeaveComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDropComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleWhiteboardMentionSelected: (boardId: string) => Promise<void>;
  /** 程序化加入文件（插件 UI 图片上下文等）；返回被接受的附件 id，超出上限的部分被丢弃。 */
  addAttachmentFiles: (files: File[]) => string[];
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  /** 发送成功只清冻结的附件 id；不传表示用户主动清空整个附件区。 */
  clearAttachments: (attachmentIds?: readonly string[]) => void;
  /** 草稿跨工作区时重新准备附件，不能继承旧 session 的上传引用。 */
  restoreDraftAttachments: (attachments: readonly ChatComposerAttachment[]) => void;
  /** 把已由 session 接管的 queue refs 原样恢复为 ready chips；不触发 upload/adopt。 */
  restoreSessionOwnedAttachments: (attachments: readonly AttachmentRef[]) => boolean;
  /** 只返回已 ready ref；任一附件未就绪时返回 null 作 submit 二次门禁。 */
  prepareForSend: () => Promise<AttachmentRef[] | null>;
  /** sendText accepted 后才移交远端暂存内容，发送失败时仍由草稿持有。 */
  adoptSentAttachments: (attachmentIds: readonly string[]) => Promise<void>;
  setAttachmentError: (message: string | null) => void;
}

// [契约] listenAddToChatEvents 由调用方传 listenAddToChatEvents && !disabled，hook 内不推断聚焦。
// onRuntimeLifecycle 优先于 onRuntimeRestart；两者都传时后者被忽略。
// scopeId 区分同一 workspace 的多个 composer，必须稳定。
// disabled 只影响粘贴与交互入口，不影响已在跑的上传。
export interface UseComposerAttachmentsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  scopeId: string;
  attachmentSessionId?: string | null;
  attachmentPut: AttachmentPutFn;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /**
   * 承载 transport 暴露 runtime 存活态时优先用它，替代 onRuntimeRestart。
   * unavailable 在 workspace-dispose 当场到达，把作废与唤醒拆到两个真实时点。
   */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  disabled?: boolean;
  /**
   * 是否消费全局 add-to-chat 事件（whiteboard 引用）。
   * 语义与 useWebElementContexts 等一致：由调用方传 `listenAddToChatEvents && !disabled`
   * （SessionPane 以 focused 区分聚焦 composer）。SidePane forceMount 常驻多个同
   * workspace 的 SessionPane，若不门控，一次白板引用会被所有 composer 同时
   * preventDefault 并各自注入附件，用户看不见的后台草稿被静默塞入画板内容。
   */
  listenAddToChatEvents?: boolean;
}

// [契约] 优先多选；平台不支持多选时退回单选并归一为数组。
// 空字符串路径必须过滤，否则会生成无本地路径的附件项。
export async function selectAttachmentLocalPaths(
  platform: Pick<IPlatformService, "selectFile" | "selectFiles">,
): Promise<string[]> {
  // [契约] 能力探测用真值判断，不依赖平台版本号。
  // 两条分支都必须归一为数组，调用方不再判空。
  const selectedPaths = platform.selectFiles
    ? await platform.selectFiles()
    : await platform.selectFile().then((selectedPath) => (selectedPath ? [selectedPath] : []));
  // [失败路径] 过滤空白路径：空路径无法生成 File 或读取，会导致上传阶段空转。
  return selectedPaths.filter((path) => path.trim().length > 0);
}

// [契约] key = (workspaceIdentity.trim() || workspacePath) + NUL + scopeId。
// NUL 分隔防止路径本身含分隔符造成碰撞。
// 不要在 key 中加入 sessionId：session 换代会改变 key，草稿随之丢失。
// key 同时用于 E2E 暴露，格式变更需同步测试。
function buildScopeKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}\u0000${scopeId}`;
}

// [失败路径] 只认 name=AbortError，并沿 cause 链递归。
// 取消不是可重试错误：isTransientAttachmentUploadError 的首个判断依赖它。
function isAbortError(error: unknown): boolean {
  // [失败路径] 只按 name 判定，兼容不同实现抛出的取消错误。
  if (error instanceof Error && error.name === "AbortError") return true;
  return error instanceof Error && error.cause !== undefined ? isAbortError(error.cause) : false;
}

// [失败路径] 携带固定 code，供重试判定精确排除。
// 语义是「远端 Agent 读不到该文件」，必须让用户看见，不能自动重试。
class RemoteAttachmentNotStagedError extends Error {
  readonly code = REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE;
}

// [失败路径] 黑名单优先：取消、三类结构化超限、未暂存都不可重试。
// 其余按 message 正则排除不可恢复错误（权限、缺文件、不支持等）。
// 新增错误类型应加显式 instanceof 判断，不要扩正则。
// 扩大正则会误伤 image 超限的既有判定，属于回归风险。
// 该函数只做分类，不写 UI 状态。
export function isTransientAttachmentUploadError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof OversizedInlineVideoAttachmentError) return false;
  if (error instanceof OversizedInlinePdfAttachmentError) return false;
  if (error instanceof MissingInlinePdfContentError) return false;
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  // video 超限错误必须在黑名单里，否则会触发一次无意义重试；按错误类型精确拦截，
  // 避免扩大 message 正则后改变 image 超限的既有判定。
  return !/(?:payloadTooLarge|invalidBase64|invalidServerProgress|frameTooLarge|permission|EACCES|ENOENT|not found|unsupported|附件缺少|缺少可读取内容|远端附件未完成物化)/iu.test(
    message,
  );
}

// [契约] 上限 99：100 只由 finishWithReady 写入，避免进度条提前满格。
// totalBytes<=0 时返回 0，不做除零。
function progressPercent(uploadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  // [契约] 取整并夹在 0..99，保证进度单调且不满格。
  return Math.min(99, Math.max(0, Math.floor((uploadedBytes / totalBytes) * 99)));
}

// [契约] 只要 remoteSessionId 或非空 workspaceIdentity 即视为远端，fail-closed。
// 不要用解析器识别 identity 格式：新格式或暂非规范值会被误判为本地。
// 误判的后果是把 host localPath 零拷贝交给远端 Agent，读取必然失败。
// 该判断在渲染期与上传期都会调用，必须是无副作用的纯函数。
function isRemoteAttachmentTarget(
  target: Pick<UploadTarget, "remoteSessionId" | "workspaceIdentity">,
) {
  // 这里曾要求 workspaceIdentity 能被当前解析器识别。远端 identity 新增格式或
  // 暂时非规范时，在 remoteSessionId 注入前会被误判为本地 workspace，使 host localPath
  // 直接走零复制交给远端 Agent。identity 只承担隔离语义；任意非空值都必须按远端 fail closed。
  return Boolean(target.remoteSessionId?.trim() || target.workspaceIdentity?.trim());
}

// [契约] hook 内所有 ref 与 map 都属于单个 scope 实例；跨 scope 只通过 store 通信。
// 返回对象由 useMemo 固定，依赖数组必须覆盖全部回调。
// hook 不做副作用以外的状态归属：accepted 队列仍在 runtime。
export function useComposerAttachments(
  options: UseComposerAttachmentsOptions,
): ComposerAttachmentsApi {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId,
    attachmentSessionId = null,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled = false,
    listenAddToChatEvents = true,
  } = options;
  const platform = usePlatform();
  const { promptAttachmentTransferService } = useServices();
  const { intl } = useZCodeIntl();
  // [契约] 每渲染重算，但只依赖三个稳定参数，值不变。
  // E2E 通过 exposeComposerAttachmentScopeKeyForE2E 读取该值，改格式需同步。
  const scopeKey = buildScopeKey(workspacePath, workspaceIdentity, scopeId);
  exposeComposerAttachmentScopeKeyForE2E(scopeKey);

  // [资源] ref 分工：targets 目标、uploadQueue 待跑、activeUploads 并发计数、controllers 取消、两种 timers 定时器。
  // 写 targetsRef 在渲染期完成，其 sessionId 可能落后于 store，入队前必须复查。
  // 这些 ref 不参与渲染，改了不该触发重渲染。
  // 不要改成 state：每次上传都会重建闭包并打断在跑的任务。
  const targetsRef = useRef(new Map<string, UploadTarget>());
  const uploadQueueRef = useRef<UploadQueueEntry[]>([]);
  const activeUploadsRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const completeTimersRef = useRef(new Map<string, number>());
  const retryTimersRef = useRef(new Map<string, number>());
  const pumpQueueRef = useRef<() => void>(() => {});
  // [契约] selector 只取当前 scope，缺失时回落稳定空数组。
  // 不要在此做 map 或 filter：会破坏引用相等并引起重渲染。
  const attachments = useComposerAttachmentUploadStore(
    (state) => state.scopes[scopeKey] ?? EMPTY_COMPOSER_ATTACHMENTS,
  );
  // [契约] 只承载附件区级别的展示错误；单点上传失败走 item.uploadError。
  // 不随 scope 切换自动清空，由各操作显式置空。
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /**
   * runtime 换代计数。换代后 attachmentSessionId 可能原地不变（正式会话由 cold-resume 恢复），
   * 只靠它做依赖会漏掉唤醒，附件将永久停在 waitingSession。
   */
  // [并发] runtime 换代计数：attachmentSessionId 可能原地不变（cold-resume），只靠它做依赖会漏唤醒。
  // 递增只在 runtime 可用信号到达后发生，保证唤醒时不撞死进程。
  // 不要用它替代 attachmentSessionId 判断。
  // 该 state 只服务于唤醒 effect，不对外暴露。
  const [restartEpoch, setRestartEpoch] = useState(0);
  const [composerDragKind, setComposerDragKind] = useState<"attachment" | "workspace" | null>(null);
  // [契约] 拖拽态由 kind 派生，避免两个 state 不一致。
  const isDraggingOverComposer = composerDragKind !== null;
  // [资源] 隐藏 input 的引用，仅在平台不支持路径选择时使用。
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const dragFeedbackTimerRef = useRef<number | null>(null);

  // [并发] 渲染期无条件覆盖，保证 target 反映最新 props。
  // 其它 scope 的条目不清空：未完成上传仍持有引用。
  // 换代期间写入的 sessionId 陈旧，runUpload 必须容忍 sessionNotFound 并降级。
  targetsRef.current.set(scopeKey, {
    sessionId: attachmentSessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    attachmentPut,
    transferService: promptAttachmentTransferService,
  });

  // [契约] 唯一写 store 的入口，所有变更都按 scope 收敛。
  // 不要在别处直接调用 updateComposerAttachmentScope。
  const commitScope = useCallback(
    (
      targetScopeKey: string,
      update: (current: ComposerAttachmentUploadItem[]) => ComposerAttachmentUploadItem[],
    ) => {
      updateComposerAttachmentScope(targetScopeKey, update);
    },
    [],
  );

  // [契约] 按 ttachmentId 精确更新，找不到时静默无操作（条目可能已被移除）。
  // 基于 commitScope 实现，不得绕过。
  const updateItem = useCallback(
    (
      targetScopeKey: string,
      attachmentId: string,
      update: (item: ComposerAttachmentUploadItem) => ComposerAttachmentUploadItem,
    ) => {
      commitScope(targetScopeKey, (current) =>
        current.map((item) => (item.id === attachmentId ? update(item) : item)),
      );
    },
    [commitScope],
  );

  // [并发] 按 scopeKey+id 去重，防止同一附件重复上传。
  // 投递 pump 用 queueMicrotask，避免渲染期同步触发上传。
  // 是否可传由 pumpQueue 判定，本函数不检查 sessionId。
  // 入队不代表会被消费：状态不匹配时 pump 会丢弃。
  const enqueueUpload = useCallback((targetScopeKey: string, attachmentId: string) => {
    // [并发] 去重是防止「重试 + 唤醒」双路径重复入队的关键。
    const exists = uploadQueueRef.current.some(
      (entry) => entry.scopeKey === targetScopeKey && entry.attachmentId === attachmentId,
    );
    if (!exists) uploadQueueRef.current.push({ scopeKey: targetScopeKey, attachmentId });
    // [并发] 走 ref 而不是直接调用，保证拿到最新闭包。
    queueMicrotask(() => pumpQueueRef.current());
  }, []);

  // [资源] 写 ready 并清空错误字段；staged 表示远端已物化，供 adopt 与 cleanup 使用。
  // 完成态展示用定时器延时关闭，重复调用先清旧定时器。
  // zero-copy 项不展示完成态。
  // 定时器回调里必须先从 map 删除再更新，避免清除到新条目的定时器。
  const finishWithReady = useCallback(
    (targetScopeKey: string, attachmentId: string, ref: AttachmentRef, staged: boolean) => {
      updateItem(targetScopeKey, attachmentId, (item) => ({
        ...item,
        uploadStatus: "ready",
        uploadProgress: 100,
        uploadError: undefined,
        uploadErrorKind: undefined,
        attachmentRef: ref,
        staged,
        showComplete: !item.localZeroCopy,
      }));
      const timerKey = `${targetScopeKey}\u0000${attachmentId}`;
      const previousTimer = completeTimersRef.current.get(timerKey);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      const timer = window.setTimeout(() => {
        completeTimersRef.current.delete(timerKey);
        updateItem(targetScopeKey, attachmentId, (item) => ({
          ...item,
          showComplete: false,
        }));
      }, COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS);
      completeTimersRef.current.set(timerKey, timer);
    },
    [updateItem],
  );

  // [资源] 三段式：本地 put、远端 stage、早退等待会话；每条路径都必须落到 finally。
  // 所有回调与结果写回前先比对 controllersRef 的对象身份，防止被新一轮覆盖。
  // finally 中 dispose 进度订阅、删 controller、递减并发并再次 pump。
  // 远端 stage 走 transferService，本地走 attachmentPut，两者不可混用。
  // 任何早退 return 都不能跳过并发计数递减。
  const runUpload = useCallback(
    async (targetScopeKey: string, attachmentId: string, target: UploadTarget) => {
      const controllerKey = `${targetScopeKey}\u0000${attachmentId}`;
      // [资源] 每个上传任务独立 controller，并立即登记到 controllersRef 供取消使用。
      const controller = new AbortController();
      controllersRef.current.set(controllerKey, controller);
      updateItem(targetScopeKey, attachmentId, (item) => ({
        ...item,
        uploadStatus: "uploading",
        uploadProgress: Math.min(item.uploadProgress, 99),
        uploadError: undefined,
        uploadErrorKind: undefined,
      }));
      let progressSubscription: { dispose(): void } | null = null;
      try {
        const item = readComposerAttachmentScope(targetScopeKey).find(
          (candidate) => candidate.id === attachmentId,
        );
        // [失败路径] 条目已被移除或会话尚未就绪：直接返回，状态由唤醒 effect 负责。
        if (!item || !target.sessionId) return;
        if (item.localPath && isRemoteAttachmentTarget(target)) {
          if (!target.remoteSessionId) {
            updateItem(targetScopeKey, attachmentId, (current) => ({
              ...current,
              uploadStatus: "waitingSession",
            }));
            return;
          }
          // [资源] 进度订阅按 operationId 建立，必须在 finally 释放。
          // 回调内先比对 controller 身份，再写状态，避免旧任务覆盖新进度。
          // committing 阶段单独投影，UI 据此显示最后一步。
          progressSubscription = target.transferService.onDynamicProgress(item.operationId)(
            (progress) => {
              if (controllersRef.current.get(controllerKey) !== controller) return;
              updateItem(targetScopeKey, attachmentId, (current) => ({
                ...current,
                uploadStatus: progress.phase === "committing" ? "committing" : current.uploadStatus,
                uploadProgress: Math.max(
                  current.uploadProgress,
                  progressPercent(progress.uploadedBytes, progress.totalBytes),
                ),
              }));
            },
          );
          // [契约] 远端暂存显式传 sessionId、workspace 与 localPath，由服务端负责物化。
          // 实现中绝不能把本地路径直接当作可读引用返回。
          // 该调用是网络操作，必须容忍 abort 与 sessionNotFound。
          const result = await target.transferService.stage({
            operationId: item.operationId,
            sessionId: target.sessionId,
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            remoteSessionId: target.remoteSessionId,
            localPath: item.localPath,
            fileName: item.filename,
            mime: item.mimeType,
            sizeBytes: item.sizeBytes,
          });
          if (controllersRef.current.get(controllerKey) !== controller) return;
          // 远端 ServiceAccessor 曾错误注入本地 transfer service，并返回
          // staged:false + host localPath。远端 Agent 无法读取该路径，因此必须阻止发送。
          if (!result.staged) {
            throw new RemoteAttachmentNotStagedError(
              intl.formatMessage({
                id: "chat.attachments.upload.remoteMaterializationRequired",
              }),
            );
          }
          finishWithReady(
            targetScopeKey,
            attachmentId,
            {
              ref: result.ref,
              fileName: item.filename,
              mime: item.mimeType,
              bytes: result.bytes,
              ...(item.sourceKind
                ? { sourceKind: item.sourceKind, messageCount: item.messageCount }
                : {}),
            },
            result.staged,
          );
          return;
        }

        const serialized = await serializeChatComposerAttachment(item);
        // [契约] 本地通道：序列化后按字节上传，返回可发送的 AttachmentRef。
        // signal 用于取消，进度回调只在 controller 仍是当前任务时生效。
        // 返回空 ref 视为失败，向上抛「缺少可读取内容」。
        const ref = await uploadComposerAttachment(
          target.attachmentPut,
          target.sessionId,
          serialized,
          {
            signal: controller.signal,
            onProgress(progress) {
              if (controllersRef.current.get(controllerKey) !== controller) return;
              updateItem(targetScopeKey, attachmentId, (current) => ({
                ...current,
                uploadStatus: progress.phase === "committing" ? "committing" : "uploading",
                uploadProgress: Math.max(
                  current.uploadProgress,
                  progressPercent(progress.uploadedBytes, progress.totalBytes),
                ),
              }));
            },
          },
        );
        if (!ref) throw new Error("附件缺少可读取内容");
        if (controllersRef.current.get(controllerKey) !== controller) return;
        finishWithReady(targetScopeKey, attachmentId, ref, false);
      } catch (error) {
        if (controllersRef.current.get(controllerKey) !== controller || controller.signal.aborted) {
          return;
        }
        const current = readComposerAttachmentScope(targetScopeKey).find(
          (candidate) => candidate.id === attachmentId,
        );
        if (!current) return;
        // 结构化超限错误在 UI 层按 locale 格式化（与 chatAttachments 序列化边界约定一致）。
        // [契约] 结构化超限错误按 `locale` 格式化，与 `chatAttachments` 的序列化边界同源。
        // 未知错误退回 error.message 或 String(error)，不做二次包装。
        const message =
          error instanceof OversizedInlineVideoAttachmentError
            ? intl.formatMessage(
                { id: "chat.attachments.oversizedInlineVideo" },
                {
                  filename: error.filename,
                  size: formatAttachmentSize(error.sizeBytes),
                  maxSize: formatAttachmentSize(error.maxSizeBytes),
                },
              )
            : error instanceof OversizedInlinePdfAttachmentError
              ? intl.formatMessage(
                  { id: "chat.attachments.oversizedInlinePdf" },
                  {
                    filename: error.filename,
                    size: formatAttachmentSize(error.sizeBytes),
                    maxSize: formatAttachmentSize(error.maxSizeBytes),
                  },
                )
              : error instanceof MissingInlinePdfContentError
                ? intl.formatMessage(
                    { id: "chat.attachments.missingInlinePdfContent" },
                    { filename: error.filename },
                  )
                : error instanceof Error
                  ? error.message
                  : String(error);
        // [失败路径] 瞬时错误且尚未自动重试过时降级为 queued 并延时重入队。
        // 否则转 failed 并保留原始 message 供用户查看。
        // transient 同时用于 uploadErrorKind，UI 据此显示可重试样式。
        const transient = isTransientAttachmentUploadError(error);
        if (transient && current.autoRetryCount < 1) {
          updateItem(targetScopeKey, attachmentId, (item) => ({
            ...item,
            uploadStatus: "queued",
            uploadProgress: 0,
            uploadError: message,
            uploadErrorKind: "transient",
            autoRetryCount: item.autoRetryCount + 1,
          }));
          const timerKey = `${targetScopeKey}\u0000${attachmentId}`;
          const timer = window.setTimeout(() => {
            retryTimersRef.current.delete(timerKey);
            enqueueUpload(targetScopeKey, attachmentId);
          }, COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS);
          retryTimersRef.current.set(timerKey, timer);
        } else {
          updateItem(targetScopeKey, attachmentId, (item) => ({
            ...item,
            uploadStatus: "failed",
            uploadProgress: Math.min(item.uploadProgress, 99),
            uploadError: message,
            uploadErrorKind: transient ? "transient" : "permanent",
          }));
          logger.warn("[v4-composer-attachments] 附件上传失败", {
            attachmentId,
            error: message,
            scopeKey: targetScopeKey,
          });
        }
      } finally {
        // [资源] 订阅必须在 finally 中释放，否则 runtime 事件会一直持有闭包。
        progressSubscription?.dispose();
        if (controllersRef.current.get(controllerKey) === controller) {
          controllersRef.current.delete(controllerKey);
        }
        activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
        pumpQueueRef.current();
      }
    },
    [enqueueUpload, finishWithReady, intl, updateItem],
  );

  // [资源] 循环消费直到达到并发上限；每轮重新读 store，避免用陈旧快照。
  // 状态不是 queued 或 waitingSession 的条目直接丢弃（已移除或已完成）。
  // 远端缺 remoteSessionId 时只降级 waitingSession，不占并发槽。
  // activeUploadsRef 必须在调用 runUpload 之前递增，否则上限失效。
  // pump 不 await 上传：它只负责派发，完成信号靠 runUpload 的 finally。
  const pumpQueue = useCallback(() => {
    while (
      activeUploadsRef.current < COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY &&
      uploadQueueRef.current.length > 0
    ) {
      // [并发] 取出即出队，失败时由重试逻辑重新入队，不在队列中保留失败项。
      const entry = uploadQueueRef.current.shift();
      if (!entry) break;
      const item = readComposerAttachmentScope(entry.scopeKey).find(
        (candidate) => candidate.id === entry.attachmentId,
      );
      if (!item || (item.uploadStatus !== "queued" && item.uploadStatus !== "waitingSession")) {
        continue;
      }
      const target = targetsRef.current.get(entry.scopeKey);
      // [并发] 远端项在 remoteSessionId 到位前不占据并发槽，避免空跑。
      // 降级为 waitingSession 后由唤醒 effect 重新入队。
      // 本地附件不受远程 `maxAttachments` 配额限制。
      const waitingForRemoteSession = Boolean(
        target && item.localPath && isRemoteAttachmentTarget(target) && !target.remoteSessionId,
      );
      if (!target?.sessionId || waitingForRemoteSession) {
        updateItem(entry.scopeKey, entry.attachmentId, (current) => ({
          ...current,
          uploadStatus: "waitingSession",
        }));
        continue;
      }
      activeUploadsRef.current += 1;
      void runUpload(entry.scopeKey, entry.attachmentId, target);
    }
  }, [runUpload, updateItem]);
  // [并发] 把最新闭包挂到 ref，供 runUpload 的 finally 与 enqueueUpload 调用。
  // 不这样做会捕获旧闭包，导致上传结束后不再消费新队列。
  pumpQueueRef.current = pumpQueue;

  useEffect(() => {
    const current = readComposerAttachmentScope(scopeKey);
    // [并发] 唤醒条件：附件会话就绪且远端目标已拿到 remoteSessionId。
    // 只把等待中的项降级为 queued 并入队，其它状态不动。
    // 依赖 restartEpoch，保证 cold-resume 场景也能唤醒。
    // 本 effect 只负责唤醒，不作废。
    const remoteTargetReady =
      !isRemoteAttachmentTarget({ remoteSessionId, workspaceIdentity }) || Boolean(remoteSessionId);
    if (attachmentSessionId && remoteTargetReady) {
      for (const item of current) {
        if (item.uploadStatus === "waitingSession") {
          updateItem(scopeKey, item.id, (candidate) => ({
            ...candidate,
            uploadStatus: "queued",
          }));
          enqueueUpload(scopeKey, item.id);
        }
      }
    }
  }, [
    attachmentSessionId,
    enqueueUpload,
    remoteSessionId,
    restartEpoch,
    scopeKey,
    updateItem,
    workspaceIdentity,
  ]);

  /**
   * 换代作废：撤掉 in-flight 上传与远端暂存，把附件降回 waitingSession 等新会话。
   * silent=true 时不写错误文案——那是一次全自动恢复（作废 → 预热重建 → 重传，1-2s 内完成），
   * 报错只会让用户以为出了问题；waitingSession 本身已渲染成「正在等待会话」。
   */
  // [资源] 遍历全部 scope：跳过 session 所有权、zero-copy 与已 failed 的项。
  // 先 abort controller 并删条目，再对已 staged 的项 cleanup 远端。
  // 配额耗尽必须转 failed 并写错误，无论 silent。
  // 未耗尽统一降级为 waitingSession 并递增配额；silent 时不写错误文案。
  // 降级而不是立即入队：targetsRef 中的 sessionId 此刻必然陈旧。
  // 该函数不直接调用 pump，唤醒交给依赖 restartEpoch 的 effect。
  const invalidateAttachmentsForRuntimeChange = useCallback(
    ({ silent }: { silent: boolean }) => {
      for (const [targetScopeKey, items] of Object.entries(
        useComposerAttachmentUploadStore.getState().scopes,
      )) {
        const target = targetsRef.current.get(targetScopeKey);
        if (!target) continue;
        for (const item of items) {
          if (
            item.referenceOwnership === "session" ||
            item.localZeroCopy ||
            item.uploadStatus === "failed"
          ) {
            continue;
          }
          const key = `${targetScopeKey}\u0000${item.id}`;
          controllersRef.current.get(key)?.abort();
          controllersRef.current.delete(key);
          if (item.staged) void target?.transferService.cleanup(item.operationId).catch(() => {});
          if (item.runtimeRebuildRetryCount >= COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT) {
            // 重传配额用尽是真失败，无论静默与否都必须让用户看见。
            updateItem(targetScopeKey, item.id, (current) => ({
              ...current,
              uploadStatus: "failed",
              uploadProgress: 0,
              uploadError: intl.formatMessage({
                id: "chat.attachments.upload.runtimeRestarted",
              }),
              uploadErrorKind: "runtimeRestarted",
              attachmentRef: undefined,
              staged: false,
              adopted: false,
              showComplete: false,
            }));
            continue;
          }
          // 换代后 targetsRef 里的 sessionId 必然陈旧（它在渲染期写入，而换代事件先于
          // 下一次渲染到达），拿它入队会直撞 sessionNotFound。一律降到 waitingSession，
          // 由 restartEpoch / 新 attachmentSessionId 驱动的唤醒 effect 在会话可用后统一入队。
          updateItem(targetScopeKey, item.id, (current) => ({
            ...current,
            uploadStatus: "waitingSession",
            uploadProgress: 0,
            ...(silent
              ? { uploadError: undefined, uploadErrorKind: undefined }
              : {
                  uploadError: intl.formatMessage({
                    id: "chat.attachments.upload.runtimeRestarted",
                  }),
                  uploadErrorKind: "runtimeRestarted" as const,
                }),
            attachmentRef: undefined,
            staged: false,
            adopted: false,
            showComplete: false,
            runtimeRebuildRetryCount: current.runtimeRebuildRetryCount + 1,
          }));
        }
      }
    },
    [intl, updateItem],
  );

  useEffect(() => {
    // 二选一订阅：两条通道都订会让同一次换代作废两次，白烧一次重传配额。
    // [并发] 两条通道二选一：都订阅会让同一次换代作废两次。
    // unavailable 只作废、不递增 epoch，避免旧 CLI 已死时唤醒入队。
    // available 只递增 epoch，由唤醒 effect 统一入队。
    // onRuntimeRestart 语义较旧：作废并立即递增 epoch。
    // 返回的 dispose 由 effect 清理函数统一调用。
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        if (state === "unavailable") {
          // 作废与唤醒到此才真正解耦：此刻旧 CLI 已死、新的还没起来，递增 restartEpoch 会让
          // 唤醒 effect 立即入队并直撞死进程（正式会话态 sessionId 原地不变时尤其明显）。
          invalidateAttachmentsForRuntimeChange({ silent: true });
          return;
        }
        // 草稿态实际由重建后的新 attachmentSessionId 唤醒；这一路是正式会话态的兜底。
        setRestartEpoch((current) => current + 1);
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(() => {
      invalidateAttachmentsForRuntimeChange({ silent: false });
      // 作废与唤醒解耦：这里只负责作废，入队交给依赖 restartEpoch 的唤醒 effect。
      setRestartEpoch((current) => current + 1);
    });
  }, [invalidateAttachmentsForRuntimeChange, onRuntimeLifecycle, onRuntimeRestart]);

  // [契约] 用 dedupeKey 按 scope 去重，避免同一输入框堆叠 toast。
  // 每次超限都要提示：只改底部文案时用户缺少反馈。
  const showAttachmentLimitWarning = useCallback(() => {
    // 只更新输入框底部文字时，重复超限缺少明显反馈；每次添加都弹提示，同一输入框不堆叠。
    toast(
      intl.formatMessage(
        { id: "chat.attachments.maxFiles" },
        { count: String(MAX_CHAT_ATTACHMENTS) },
      ),
      { variant: "warning", position: "bottom-center", dedupeKey: `attachment-limit:${scopeKey}` },
    );
  }, [intl, scopeKey]);

  // [契约] 按 MAX_CHAT_ATTACHMENTS 截断，超出部分必须 revoke 释放 Blob。
  // 每项生成 operationId 与初始状态：远端未就绪时 waitingSession。
  // localZeroCopy 只在本地 target 且有 localPath 时成立，直接给 ready 与路径 ref。
  // commit 之后再统一入队，避免入队时读不到新条目。
  // 返回接受的 id 列表，被拒绝的项已 revoke。
  const addPreparedAttachments = useCallback(
    (selectedAttachments: ChatComposerAttachment[]): string[] => {
      if (selectedAttachments.length === 0) return [];
      const current = readComposerAttachmentScope(scopeKey);
      // [契约] 上限按当前 scope 条数计算，不看其它 scope。
      // remainingSlots<=0 时全部 revoke 并提示，不保留半截数据。
      // 截断与提示分两处：截断必须发生，提示只在真有丢弃时发。
      const remainingSlots = MAX_CHAT_ATTACHMENTS - current.length;
      if (remainingSlots <= 0) {
        selectedAttachments.forEach(revokeChatComposerAttachment);
        showAttachmentLimitWarning();
        return [];
      }
      const accepted = selectedAttachments.slice(0, remainingSlots);
      selectedAttachments.slice(remainingSlots).forEach(revokeChatComposerAttachment);
      const target = targetsRef.current.get(scopeKey);
      const items: ComposerAttachmentUploadItem[] = accepted.map((attachment) => {
        // 远端 identity 往往早于 remoteSessionId 注入；这段窗口不能退化为本地路径直读。
        // [契约] 只有本地 target 且有 localPath 才允许零拷贝，远端一律走暂存。
        // 该判定决定初始状态是 ready 还是 queued，改错会让远端项直接可用。
        // localZeroCopy 同时控制完成态展示与 cleanup 语义。
        const localZeroCopy = Boolean(
          attachment.localPath && target && !isRemoteAttachmentTarget(target),
        );
        return {
          ...attachment,
          referenceOwnership: "composer",
          operationId: `prompt-attachment-${attachment.id}`,
          uploadStatus: localZeroCopy ? "ready" : target?.sessionId ? "queued" : "waitingSession",
          uploadProgress: localZeroCopy ? 100 : 0,
          ...(localZeroCopy && attachment.localPath
            ? {
                attachmentRef: {
                  ref: attachment.localPath,
                  fileName: attachment.filename,
                  mime: attachment.mimeType,
                  bytes: attachment.sizeBytes,
                },
              }
            : {}),
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: false,
          showComplete: false,
          localZeroCopy,
        };
      });
      commitScope(scopeKey, (existing) => [...existing, ...items]);
      setAttachmentError(null);
      if (selectedAttachments.length > remainingSlots) showAttachmentLimitWarning();
      for (const item of items) {
        if (item.uploadStatus === "queued") enqueueUpload(scopeKey, item.id);
      }
      return items.map((item) => item.id);
    },
    [commitScope, enqueueUpload, scopeKey, showAttachmentLimitWarning],
  );

  // [契约] File 需经 platform.getPathForFile 解析本地路径；失败时退回 Web bytes。
  // 解析失败只告警，不阻断添加。
  // Electron 32+ 的 File 必须走 preload webUtils，否则拿不到路径。
  // 该函数不读取文件内容，读取发生在上传阶段。
  const addAttachmentFiles = useCallback(
    (selectedFiles: File[]): string[] => {
      return addPreparedAttachments(
        selectedFiles.map((file) => {
          let localPath: string | undefined;
          try {
            const resolvedPath = platform.getPathForFile?.(file);
            localPath = resolvedPath?.trim() ? resolvedPath : undefined;
          } catch (error) {
            // Electron 32+ 的 File 需要经 preload webUtils 解析；失败时仍可走 Web bytes。
            logger.warn("[v4-composer-attachments] 解析附件本地路径失败", error);
          }
          return createChatComposerAttachment(file, localPath);
        }),
      );
    },
    [addPreparedAttachments, platform],
  );

  // [契约] 纯路径导入：不读文件，由上传阶段读取。
  // 与 addAttachmentFiles 共用上限与去重逻辑。
  const addAttachmentLocalPaths = useCallback(
    (selectedPaths: string[]) => {
      addPreparedAttachments(selectedPaths.map(createChatComposerPathAttachment));
    },
    [addPreparedAttachments],
  );

  // [失败路径] 已达上限直接提示，不打开选择器。
  // 平台支持路径选择时走 selectAttachmentLocalPaths（可多选），否则回退 input.click。
  // 选择失败写入 attachmentError，不静默。
  const openAttachmentPicker = useCallback(() => {
    if (readComposerAttachmentScope(scopeKey).length >= MAX_CHAT_ATTACHMENTS) {
      showAttachmentLimitWarning();
      return;
    }
    if (!platform.canSelectFilePath) {
      attachmentInputRef.current?.click();
      return;
    }
    void selectAttachmentLocalPaths(platform)
      .then((paths) => addAttachmentLocalPaths(paths))
      .catch((error) => {
        logger.warn("[v4-composer-attachments] 选择附件路径失败", error);
        setAttachmentError(
          intl.formatMessage(
            { id: "chat.attachments.readFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      });
  }, [addAttachmentLocalPaths, intl, platform, scopeKey, showAttachmentLimitWarning]);

  // [契约] 读完后立即清空 input.value，否则同一文件二次选择不触发 change。
  // 事件对象只在回调内有效，必须先取出 files。
  const handleAttachmentInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      addAttachmentFiles(files);
    },
    [addAttachmentFiles],
  );

  // [契约] 优先 files；但表格文本优先时不吞事件，交给文本粘贴。
  // shouldCreateClipboardTextAttachment 判定为长文本时走临时文件，避免超长内联。
  // 所有被消费的分支都必须 preventDefault 与 stopPropagation，防止父级重复处理。
  // 临时文件创建失败写入 attachmentError 并告警。
  // disabled 时完全跳过，不消费事件。
  // debug 日志只记录类型与长度，不记录正文。
  const handlePaste = useCallback(
    (event: ChatComposerPasteEvent) => {
      if (disabled || !event.clipboardData) return;
      // [契约] 先取 files 再取文本：files 存在时是富媒体粘贴，文本只是伴生表示。
      const files = Array.from(event.clipboardData.files);
      const text = event.clipboardData.getData("text/plain");
      const html = event.clipboardData.getData("text/html");
      // [权衡] 表格从 Excel 复制会同时带文件与 HTML 文本，优先文本可保留格式。
      // 只看 text 与 html 的组合，不解析具体表格内容。
      // 该判定影响是否吞掉事件，改错会造成重复添加。
      const prefersSpreadsheetText =
        files.length > 0 && shouldPreferSpreadsheetClipboardText(text, html);
      if (files.length > 0) {
        logger.debug("[v4-composer-attachments] 识别剪贴板多表示 payload", {
          clipboardTypes: Array.from(event.clipboardData.types),
          fileTypes: files.map((file) => file.type),
          prefersSpreadsheetText,
          textLength: text.length,
        });
      }
      if (files.length > 0 && !prefersSpreadsheetText) {
        event.preventDefault();
        event.stopPropagation?.();
        addAttachmentFiles(files);
        return;
      }
      if (!shouldCreateClipboardTextAttachment(text)) return;
      event.preventDefault();
      event.stopPropagation?.();
      void (async () => {
        try {
          const attachment = await platform.createTempTextAttachment?.({
            text,
            filename: createClipboardTextAttachmentFilenameForDate(),
          });
          if (!attachment) throw new Error("当前平台不支持临时文本附件");
          addPreparedAttachments([createClipboardTextPathComposerAttachment(text, attachment)]);
        } catch (error) {
          logger.warn("[v4-composer-attachments] 创建粘贴文本临时附件失败", error);
          setAttachmentError(
            intl.formatMessage(
              { id: "chat.attachments.readFailed" },
              { message: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      })();
    },
    [addAttachmentFiles, addPreparedAttachments, disabled, intl, platform],
  );

  // [资源] 清定时器后必须置 null，避免悬空句柄被误判为仍有待执行任务。
  // 该函数幂等，可被多处兜底调用。
  const clearDragFeedbackTimer = useCallback(() => {
    if (dragFeedbackTimerRef.current !== null) {
      window.clearTimeout(dragFeedbackTimerRef.current);
      dragFeedbackTimerRef.current = null;
    }
  }, []);
  // [契约] 复位拖拽类型并清定时器；只改 UI 状态，不碰附件数据。
  const resetComposerDragFeedback = useCallback(() => {
    clearDragFeedbackTimer();
    setComposerDragKind(null);
  }, [clearDragFeedbackTimer]);
  // [资源] 300ms 延时复位，防止 dragleave 抖动导致高亮闪烁。
  // 重复调用先清旧定时器，保证只有一个待执行。
  const scheduleComposerDragFeedbackReset = useCallback(() => {
    clearDragFeedbackTimer();
    dragFeedbackTimerRef.current = window.setTimeout(resetComposerDragFeedback, 300);
  }, [clearDragFeedbackTimer, resetComposerDragFeedback]);

  useEffect(() => {
    // [资源] 挂 window 的 dragend/drop/blur 与 document 的 dragleave 兜底，覆盖拖出窗口。
    // 仅 relatedTarget 为 null（真正离开文档）时复位。
    // 卸载必须移除全部监听并清定时器，否则泄漏到其它窗口。
    const handleDocumentDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) resetComposerDragFeedback();
    };
    window.addEventListener("dragend", resetComposerDragFeedback);
    window.addEventListener("drop", resetComposerDragFeedback);
    window.addEventListener("blur", resetComposerDragFeedback);
    document.addEventListener("dragleave", handleDocumentDragLeave);
    return () => {
      clearDragFeedbackTimer();
      window.removeEventListener("dragend", resetComposerDragFeedback);
      window.removeEventListener("drop", resetComposerDragFeedback);
      window.removeEventListener("blur", resetComposerDragFeedback);
      document.removeEventListener("dragleave", handleDocumentDragLeave);
    };
  }, [clearDragFeedbackTimer, resetComposerDragFeedback]);

  // [契约] 只接受 file item、Files 类型或 workspace 拖拽 MIME，其余直接返回不 preventDefault。
  // workspace 拖拽只做视觉反馈，实际落盘由上层处理。
  // 必须设置 dropEffect=copy，否则光标显示禁止。
  // 每次 dragover 都重置反馈定时器，保证长拖拽期间高亮不消失。
  const handleDragOverComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const types = Array.from(event.dataTransfer.types);
      // [契约] items 可能为空（部分平台只填 types），因此还要回退检查 Files 类型。
      // 只认 kind=file，忽略字符串拖拽。
      // workspace MIME 单独识别，走视觉反馈分支。
      const hasFiles = Array.from(event.dataTransfer.items ?? []).some(
        (item) => item.kind === "file",
      );
      if (!hasFiles && !types.includes("Files") && !types.includes(WORKSPACE_FILE_DRAG_MIME)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setComposerDragKind(types.includes(WORKSPACE_FILE_DRAG_MIME) ? "workspace" : "attachment");
      scheduleComposerDragFeedbackReset();
    },
    [scheduleComposerDragFeedbackReset],
  );
  // [契约] 只有真正离开容器（relatedTarget 不在内部）才复位，避免子元素间移动时闪烁。
  const handleDragLeaveComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      // [契约] relatedTarget 可能为 null（移出窗口），此时按离开处理。
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
        resetComposerDragFeedback();
      }
    },
    [resetComposerDragFeedback],
  );
  // [契约] workspace MIME 的 drop 只重置反馈，不当作附件消费。
  // 有文件时 preventDefault 并添加，随后无论成功与否都复位反馈。
  // 不在 drop 里直接上传，统一交给 addAttachmentFiles。
  const handleDropComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (Array.from(event.dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME)) {
        event.preventDefault();
        resetComposerDragFeedback();
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        event.preventDefault();
        addAttachmentFiles(files);
      }
      resetComposerDragFeedback();
    },
    [addAttachmentFiles, resetComposerDragFeedback],
  );

  // [失败路径] 白板不存在时写 exportMissing 错误并返回。
  // 导出 PNG 失败写 exportFailed，不自动重试。
  // 成功后走 addAttachmentFiles，与普通文件共用上限与上传链路。
  // board 查找必须带 workspaceIdentity 与 workspacePath，避免同名跨区。
  const addWhiteboardToChat = useCallback(
    async (boardId: string) => {
      // [契约] 直接从 store 取快照，不订阅：该操作是一次性导出。
      // 必须带 workspaceIdentity 与 workspacePath，避免同名跨区命中。
      // 取不到时按 exportMissing 提示，不创建空画板。
      const board = useWhiteboardStore.getState().getBoard({
        boardId,
        workspaceIdentity,
        workspacePath,
      });
      if (!board) {
        setAttachmentError(intl.formatMessage({ id: "whiteboard.exportMissing" }));
        return;
      }
      try {
        addAttachmentFiles([createWhiteboardPngFile(board)]);
      } catch (error) {
        setAttachmentError(
          intl.formatMessage(
            { id: "whiteboard.exportFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      }
    },
    [addAttachmentFiles, intl, workspaceIdentity, workspacePath],
  );
  // [契约] 供 mention 选择器调用，与全局 add-to-chat 事件共用同一实现。
  const handleWhiteboardMentionSelected = useCallback(
    async (boardId: string) => addWhiteboardToChat(boardId),
    [addWhiteboardToChat],
  );
  useEffect(() => {
    // 与 useWebElementContexts 等同款早退。SidePane forceMount 使非聚焦
    // 会话的 SessionPane 常驻，只有聚焦 composer（listenAddToChatEvents）才允许消费
    // add-to-chat 事件，否则同 workspace 的多个 composer 会同时注入附件。
    // [并发] 必须门控：SidePane forceMount 让多个同 workspace composer 常驻。
    // 不门控会让一次白板引用被所有 composer 消费，后台草稿被静默塞入附件。
    // 事件还要比对 workspace key，避免跨工作区注入。
    // 卸载必须移除监听。
    // 该 early return 也让 SSR 环境安全。
    if (!listenAddToChatEvents || typeof window === "undefined") return;
    const handle = (event: Event) => {
      if (!isWhiteboardAddToChatEvent(event)) return;
      if (
        buildWhiteboardWorkspaceKey(event.detail) !==
        buildWhiteboardWorkspaceKey({ workspacePath, workspaceIdentity })
      ) {
        return;
      }
      event.preventDefault();
      void addWhiteboardToChat(event.detail.boardId);
    };
    // [资源] 与清理函数严格配对，缺少会导致同一事件被重复处理。
    window.addEventListener(WHITEBOARD_ADD_TO_CHAT_EVENT, handle);
    return () => window.removeEventListener(WHITEBOARD_ADD_TO_CHAT_EVENT, handle);
  }, [addWhiteboardToChat, listenAddToChatEvents, workspaceIdentity, workspacePath]);

  // [资源] 清理链路：abort、出队、清两种定时器、revoke、远端 cancel 或 cleanup、删 store 项。
  // 远端取消只在 staged 或 uploading/committing 时发起，避免无意义 IPC。
  // map 删除必须与 abort 同处，防止残留 controller 被新条目复用。
  // 找不到条目直接返回，保证幂等。
  // 清空 attachmentError 属于用户主动操作的反馈复位。
  const removeAttachment = useCallback(
    (id: string) => {
      const current = readComposerAttachmentScope(scopeKey);
      const item = current.find((candidate) => candidate.id === id);
      if (!item) return;
      const key = `${scopeKey}\u0000${id}`;
      controllersRef.current.get(key)?.abort();
      controllersRef.current.delete(key);
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (entry) => !(entry.scopeKey === scopeKey && entry.attachmentId === id),
      );
      const completeTimer = completeTimersRef.current.get(key);
      if (completeTimer !== undefined) window.clearTimeout(completeTimer);
      const retryTimer = retryTimersRef.current.get(key);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      completeTimersRef.current.delete(key);
      retryTimersRef.current.delete(key);
      revokeChatComposerAttachment(item);
      const target = targetsRef.current.get(scopeKey);
      if (item.staged || item.uploadStatus === "uploading" || item.uploadStatus === "committing") {
        void target?.transferService.cancel(item.operationId).catch((error) => {
          logger.warn("[v4-composer-attachments] 取消远程附件失败", error);
        });
      }
      commitScope(scopeKey, (items) => items.filter((candidate) => candidate.id !== id));
      setAttachmentError(null);
    },
    [commitScope, scopeKey],
  );

  // [失败路径] 只允许 failed 项重试，其它状态忽略。
  // 重试前 cleanup 远端残留，再重置两个重试计数。
  // 有 sessionId 时入队，否则降级 waitingSession 等唤醒。
  // 重试不重新读取文件：仍使用原有 localPath 或 File。
  const retryAttachment = useCallback(
    (id: string) => {
      const current = readComposerAttachmentScope(scopeKey).find(
        (candidate) => candidate.id === id,
      );
      if (!current || current.uploadStatus !== "failed") return;
      const target = targetsRef.current.get(scopeKey);
      void target?.transferService.cleanup(current.operationId).catch(() => {});
      updateItem(scopeKey, id, (item) => ({
        ...item,
        uploadStatus: target?.sessionId ? "queued" : "waitingSession",
        uploadProgress: 0,
        uploadError: undefined,
        uploadErrorKind: undefined,
        attachmentRef: undefined,
        autoRetryCount: 0,
        runtimeRebuildRetryCount: 0,
        staged: false,
        adopted: false,
        showComplete: false,
      }));
      if (target?.sessionId) enqueueUpload(scopeKey, id);
    },
    [enqueueUpload, scopeKey, updateItem],
  );

  // [资源] 传 ids 只清冻结批次；不传表示用户主动清空。
  // 逐项清理与 removeAttachment 同链路，未 adopted 的 staged 项必须 cleanup。
  // 队列过滤要保留等待期间新加入的附件；ids 为 null 时才全清。
  // ACK 后清空整个 scope 是最危险路径，必须按 ids 精确过滤。
  // commitScope 最后一次写 store，中间不产生渲染可见的中间态。
  const clearAttachments = useCallback(
    (attachmentIds?: readonly string[]) => {
      const ids = attachmentIds ? new Set(attachmentIds) : null;
      const current = readComposerAttachmentScope(scopeKey).filter(
        (item) => !ids || ids.has(item.id),
      );
      const target = targetsRef.current.get(scopeKey);
      for (const item of current) {
        const key = `${scopeKey}\u0000${item.id}`;
        controllersRef.current.get(key)?.abort();
        controllersRef.current.delete(key);
        const completeTimer = completeTimersRef.current.get(key);
        if (completeTimer !== undefined) window.clearTimeout(completeTimer);
        const retryTimer = retryTimersRef.current.get(key);
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
        completeTimersRef.current.delete(key);
        retryTimersRef.current.delete(key);
        revokeChatComposerAttachment(item);
        if (
          !item.adopted &&
          (item.staged || item.uploadStatus === "uploading" || item.uploadStatus === "committing")
        ) {
          void target?.transferService.cleanup(item.operationId).catch((error) => {
            logger.warn("[v4-composer-attachments] 清理未发送附件失败", error);
          });
        }
      }
      // ACK 到达后清空整个 scope，会顺手删除等待期间新加入的附件。
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (entry) => entry.scopeKey !== scopeKey || (ids !== null && !ids.has(entry.attachmentId)),
      );
      commitScope(scopeKey, (items) => (ids ? items.filter((item) => !ids.has(item.id)) : []));
      setAttachmentError(null);
    },
    [commitScope, scopeKey],
  );

  // [契约] 跨工作区恢复草稿：保留 File 与 localPath，重新生成预览与上传归属。
  // 先清空再添加，避免旧 scope 的残留。
  // 不继承旧 session 的上传引用与 operationId。
  // 该函数不校验新 target 是否为远端，由 addPreparedAttachments 统一判定。
  const restoreDraftAttachments = useCallback(
    (source: readonly ChatComposerAttachment[]) => {
      // 新项目可能使用另一 Host/session；保留原始 File/路径，重新生成预览和上传归属。
      const restored = source.map((item) => ({
        sourceKind: item.sourceKind,
        messageCount: item.messageCount,
        lineCount: item.lineCount,
        charCount: item.charCount,
        ...(item.file
          ? createChatComposerAttachment(item.file, item.localPath)
          : createChatComposerPathAttachment(item.localPath!)),
      }));
      clearAttachments();
      addPreparedAttachments(restored);
    },
    [addPreparedAttachments, clearAttachments],
  );

  // [契约] 仅在当前 scope 为空时恢复，返回 false 表示调用方需自行处理。
  // referenceOwnership=session 且 adopted=true，禁止再走 upload 或 adopt。
  // 若按普通 composer 文件重建，会在撤回后重复上传，并在 runtime restart 时误清引用。
  // 恢复项不需要 network，全部由 session 侧持有。
  const restoreSessionOwnedAttachments = useCallback(
    (attachmentRefs: readonly AttachmentRef[]): boolean => {
      if (attachmentRefs.length === 0) return true;
      if (readComposerAttachmentScope(scopeKey).length > 0) return false;
      const restored: ComposerAttachmentUploadItem[] = attachmentRefs.map((attachmentRef) => {
        const id = nanoid();
        return {
          id,
          filename: attachmentRef.fileName,
          ...(attachmentRef.sourceKind
            ? { sourceKind: attachmentRef.sourceKind, messageCount: attachmentRef.messageCount }
            : {}),
          mimeType: attachmentRef.mime,
          sizeBytes: attachmentRef.bytes,
          referenceOwnership: "session",
          uploadStatus: "ready",
          uploadProgress: 100,
          attachmentRef: { ...attachmentRef },
          operationId: `session-owned-${id}`,
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: true,
          showComplete: false,
          localZeroCopy: false,
        };
      });
      // queue 中的 AttachmentRef 已在首次发送时由 session 接管；若按普通
      // composer 文件重建，会在撤回后重复 upload/adopt，并在 runtime restart 时误清引用。
      commitScope(scopeKey, () => restored);
      setAttachmentError(null);
      return true;
    },
    [commitScope, scopeKey],
  );

  // [契约] 任一附件非 ready 或缺 ref 即返回 null，作为 submit 的二次门禁。
  // 返回顺序与 store 顺序一致，保证消息内引用稳定。
  const prepareForSend = useCallback(async (): Promise<AttachmentRef[] | null> => {
    const current = readComposerAttachmentScope(scopeKey);
    if (current.some((item) => item.uploadStatus !== "ready" || !item.attachmentRef)) {
      return null;
    }
    return current.flatMap((item) => (item.attachmentRef ? [item.attachmentRef] : []));
  }, [scopeKey]);

  // [失败路径] 只移交本次 Submission 的 id，不碰后续新增附件。
  // adopt 失败只告警：sendText 已成功，不能把消息退回 composer。
  // adopted 标记必须在成功后写入，供 clearAttachments 判断是否 cleanup。
  // 逐项 await 保证回执顺序与发送顺序一致。
  const adoptSentAttachments = useCallback(
    async (attachmentIds: readonly string[]): Promise<void> => {
      const ids = new Set(attachmentIds);
      // 移交边界必须与本次 Submission 一致，不把下一条消息的附件提前交给 Session。
      const current = readComposerAttachmentScope(scopeKey).filter((item) => ids.has(item.id));
      const target = targetsRef.current.get(scopeKey);
      for (const item of current) {
        if (item.staged && !item.adopted) {
          try {
            await target?.transferService.adopt(item.operationId);
          } catch (error) {
            // sendText 已成功，不能因 adopt 回执失败把同一条消息重新留在 composer。
            logger.warn("[v4-composer-attachments] 附件发送后 adopt 失败", error);
          }
          updateItem(scopeKey, item.id, (candidate) => ({
            ...candidate,
            adopted: true,
          }));
        }
      }
    },
    [scopeKey, updateItem],
  );

  // [契约] 返回对象必须与依赖数组严格一致，漏项会造成闭包陈旧。
  // 新增 API 字段要同时改这里与 ComposerAttachmentsApi。
  // 依赖数组中的回调都由 useCallback 固定，本对象才能真正稳定。
  return useMemo(
    () => ({
      attachments,
      attachmentError,
      composerDragKind,
      hasAttachments: attachments.length > 0,
      hasUnreadyAttachments: attachments.some((item) => item.uploadStatus !== "ready"),
      isDraggingOverComposer,
      attachmentInputRef,
      openAttachmentPicker,
      handleAttachmentInputChange,
      handlePaste,
      handleDragOverComposer,
      handleDragLeaveComposer,
      handleDropComposer,
      handleWhiteboardMentionSelected,
      addAttachmentFiles,
      removeAttachment,
      retryAttachment,
      clearAttachments,
      restoreDraftAttachments,
      restoreSessionOwnedAttachments,
      prepareForSend,
      adoptSentAttachments,
      setAttachmentError,
    }),
    [
      addAttachmentFiles,
      attachmentError,
      adoptSentAttachments,
      attachments,
      composerDragKind,
      clearAttachments,
      restoreDraftAttachments,
      restoreSessionOwnedAttachments,
      handleAttachmentInputChange,
      handleDragLeaveComposer,
      handleDragOverComposer,
      handleDropComposer,
      handlePaste,
      handleWhiteboardMentionSelected,
      isDraggingOverComposer,
      openAttachmentPicker,
      prepareForSend,
      removeAttachment,
      retryAttachment,
    ],
  );
}
