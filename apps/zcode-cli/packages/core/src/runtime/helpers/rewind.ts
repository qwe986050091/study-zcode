/**
 * ============================================================================
 * runtime/helpers/rewind.ts —— rewind/fork 的纯数据辅助（checkpoint 挑选、diff 提取、提示文案）
 * ============================================================================
 *
 * 【定位】methods/rewind.ts、rewind-message.ts、file-rewind.ts、workspace-fork.ts 共用：
 *   1) 从工具输出里提取"文件变更 checkpoint 候选"并序列化成 artifact；
 *   2) 从事件流里挑出可回退的 checkpoint / 评估项；
 *   3) 生成 rewind / fork 后注入模型的 system reminder 文案（统一 sanitize）。
 *
 * 【不做的事】本文件不执行文件回滚、不写存储、不发事件、不改消息历史；
 *   真正的 plan/apply/journal 补偿在 methods/file-rewind.ts。
 *
 * 【不变量】只有 scope 为 Workspace 或 Both 的 checkpoint 能用于文件回退；
 *   conversation-only 的 checkpoint 记录不携带工作区快照，不能被误用。
 * ============================================================================
 */
import {
  RewindScope,
  SessionEventType,
  parseCheckpointCreatedPayload,
  parseCompactBoundaryPayload,
} from "../deps.js";
import type {
  CompactBoundaryPayload,
  MessageId,
  MessageWithParts,
  SessionEvent,
  SessionId,
  DiffHunk,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  WorkspaceCheckpointArtifact,
  ToolExecutionResult,
} from "../deps.js";
import type { WorkspaceRewindRestoredFile } from "../types.js";
import { isPlainRecord, isRuntimeDiffHunk } from "./data.js";
import { sanitizeSystemReminderBody } from "../../system-reminder/source.js";

/** workspace checkpoint artifact 的 MIME 类型；artifactStore 依赖它识别"这是快照而非普通文本"。 */
export const WORKSPACE_CHECKPOINT_CONTENT_TYPE = "application/vnd.zcode.workspace-checkpoint+json";

/**
 * 从工具输出中提取文件变更候选（Edit/Write 一类工具的 output 契约）。
 * 字段口径：
 *   - filePath：被修改文件的绝对/工作区相对路径，缺失即不可作为 checkpoint；
 *   - originalFile：修改前内容，null 表示文件原本不存在（新建）；
 *   - structuredPatch：逐 hunk 的 diff，必须全部通过 isRuntimeDiffHunk 校验；
 *   - content：修改后内容（可选，缺失时只靠 patch 统计）；
 *   - type：工具自定义的类型标记（原样透传，不参与判定）。
 * 纯函数；形状不符（缺字段/类型错/含非法 hunk）一律返回 undefined，由调用方跳过 checkpoint。
 */
interface FileMutationCheckpointCandidate {
  content?: string;
  filePath: string;
  originalFile: string | null;
  structuredPatch: DiffHunk[];
  type?: string;
}

/**
 * rewind 评估项：一个可回退节点。
 * id：消息 id，或 `compact_boundary:<boundaryId>` 这种合成 id（compact 边界本身不是消息）。
 * compactBoundary：仅当该节点是压缩边界时存在，用于判定目标是否被 compact 覆盖。
 */
interface RewindEvaluationItem {
  compactBoundary?: CompactBoundaryPayload;
  id: string;
}

/**
 * 校验并提取"文件变更 checkpoint 候选"。
 *
 * 输入：任意工具 output（unknown）。输出：符合契约的候选，或 undefined（视为不是文件变更）。
 * 判定：必须是 plain record、filePath 非空字符串、structuredPatch 是数组且所有 hunk 合法、
 *   originalFile 只能是 string 或 null；任何一个不满足都整体拒绝（不部分接受）。
 * 副作用：无；只做过滤与浅拷贝。降级：拒绝即"本次工具不产生 checkpoint"，
 *   不抛错，避免一个非文件工具把 turn 打断。
 */
export function getFileMutationCheckpointCandidate(
  output: unknown,
): FileMutationCheckpointCandidate | undefined {
  if (!isPlainRecord(output)) return undefined;
  if (typeof output.filePath !== "string" || output.filePath.length === 0) return undefined;
  if (!Array.isArray(output.structuredPatch)) return undefined;
  if (output.originalFile !== null && typeof output.originalFile !== "string") return undefined;

  const structuredPatch = output.structuredPatch.filter(isRuntimeDiffHunk);
  if (structuredPatch.length !== output.structuredPatch.length) return undefined;

  return {
    content: typeof output.content === "string" ? output.content : undefined,
    filePath: output.filePath,
    originalFile: output.originalFile,
    structuredPatch,
    type: typeof output.type === "string" ? output.type : undefined,
  };
}

/**
 * 把候选 + 工具结果序列化成 workspace checkpoint artifact 的 JSON 文本。
 *
 * 输入：候选（before/after/patch/path）与 ToolExecutionResult（提供 toolCallId/toolName）。
 * 输出：格式化后的 JSON 字符串，交由 artifactStore 以 WORKSPACE_CHECKPOINT_CONTENT_TYPE 落盘。
 * 副作用：无 I/O（只生成本文）；createdAt 取当前时间，因此**同一次调用结果不是确定性的**。
 * 字段口径：existedBefore 由 originalFile !== null 推导；afterContent 缺失时省略该字段
 *   （而不是写 undefined），保证 JSON 可解析。
 */
export function stringifyWorkspaceCheckpointArtifact(
  candidate: FileMutationCheckpointCandidate,
  result: ToolExecutionResult,
): string {
  const artifact: WorkspaceCheckpointArtifact = {
    createdAt: new Date().toISOString(),
    files: [
      {
        ...(candidate.content !== undefined ? { afterContent: candidate.content } : {}),
        afterContentLength: candidate.content?.length,
        beforeContent: candidate.originalFile,
        existedBefore: candidate.originalFile !== null,
        path: candidate.filePath,
        structuredPatch: candidate.structuredPatch,
      },
    ],
    kind: "workspace_file_before_change",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    version: 1,
  };

  return JSON.stringify(artifact, null, 2);
}

/**
 * 从事件流挑选可用于**文件回退**的 checkpoint。
 *
 * 输入：按时间顺序的会话事件；可选 checkpointId 精确指定。
 * 输出：匹配的 CheckpointCreatedPayload，没有则 undefined。
 * 过滤：只接受 scope === Workspace 或 Both —— conversation-only 的 checkpoint 不带工作区
 *   快照，用它回退文件会得到空操作或被误判为"已恢复"。
 * 选择：指定 id 时取第一个匹配（理论上 id 唯一）；未指定时取**最后一个**（最近的快照）。
 * 副作用：无；纯读事件。降级：payload 解析失败由 parseCheckpointCreatedPayload 处理，本函数不兜底。
 */
export function selectCheckpointForRewind(
  events: readonly SessionEvent[],
  checkpointId?: string,
): CheckpointCreatedPayload | undefined {
  const checkpoints = events
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => parseCheckpointCreatedPayload(event.payload))
    .filter(
      (checkpoint) =>
        checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both,
    );

  if (checkpointId) {
    return checkpoints.find((checkpoint) => checkpoint.checkpointId === checkpointId);
  }

  return checkpoints.at(-1);
}

/**
 * 单条消息的 checkpoint 选择：语义等价于 selectCheckpointsForMessages([id]) 取最后一个。
 *
 * 用于"回退到某条消息前"的调用方，一条消息可能对应多个 checkpoint（同一步多条工具写文件），
 * 取最后一个即为该消息结束时的工作区状态。无匹配返回 undefined，调用方据此决定提示文案。
 */
export function selectCheckpointForMessage(
  events: readonly SessionEvent[],
  targetMessageId: MessageId,
): CheckpointCreatedPayload | undefined {
  return selectCheckpointForMessages(events, [targetMessageId]);
}

/**
 * 多消息版本的 checkpoint 选择：返回**按事件顺序**命中的所有 checkpoint（可能多条）。
 *
 * 输入：事件流 + 消息 id 集合（Iterable，先转 Set 去重）。
 * 输出：数组，保持事件流中的先后顺序；调用方通常取最后一个作为最终快照。
 * 匹配口径：checkpoint 记录的 messageId / targetMessageId / toolMessageId 任一命中即可，
 *   覆盖"直接请求消息""目标消息""触发工具那条 assistant 消息"三种记录方式。
 * 早退：目标集合为空直接返回 []，避免下游把"没有目标"误当成"取最近 checkpoint"。
 */
export function selectCheckpointsForMessages(
  events: readonly SessionEvent[],
  targetMessageIds: Iterable<MessageId>,
): CheckpointCreatedPayload[] {
  const targetMessageIdSet = new Set(targetMessageIds);
  if (targetMessageIdSet.size === 0) return [];

  return events
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => parseCheckpointCreatedPayload(event.payload))
    .filter(
      (checkpoint) =>
        checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both,
    )
    .filter((checkpoint) =>
      Array.from(targetMessageIdSet).some((targetMessageId) =>
        checkpointMatchesMessage(checkpoint, targetMessageId),
      ),
    );
}

/**
 * 重载：多消息集合的"最终快照"视图。
 *
 * 与 selectCheckpointsForMessages 相同过滤/匹配规则，但只返回最后一个命中项（最近状态）；
 * 无命中时返回 undefined，区别于空数组，让调用方区分"没有目标"与"有目标但无 checkpoint"。
 */
export function selectCheckpointForMessages(
  events: readonly SessionEvent[],
  targetMessageIds: Iterable<MessageId>,
): CheckpointCreatedPayload | undefined {
  return selectCheckpointsForMessages(events, targetMessageIds).at(-1);
}

/**
 * 计算"回退到某消息"时需要删除的活跃分支后缀。
 *
 * 输入：当前活跃分支（已展开的消息数组）+ 目标消息 id。
 * 输出：从目标消息**含自身**到末尾的消息 id 列表（切片保持原顺序）。
 * 口径：包含目标消息本身，因为对话回退语义是"回到目标之前的会话状态"，
 *   目标用户消息及其后续模型输出都应被裁掉。
 * 降级：目标不在当前分支（targetIndex < 0）返回 []，不抛错 —— 由调用方转成
 *   target_message_not_found 的提示响应。
 */
export function activeSuffixMessageIdsForRewind(
  messages: readonly MessageWithParts[],
  targetMessageId: MessageId,
): MessageId[] {
  const targetIndex = messages.findIndex((message) => message.info.id === targetMessageId);
  if (targetIndex < 0) return [];

  return messages.slice(targetIndex).map((message) => message.info.id as MessageId);
}

/**
 * checkpoint 与消息的归属判定（私有）。
 *
 * 一个 checkpoint 可能挂在三类消息 id 上：messageId（产生快照的 assistant 消息）、
 * targetMessageId（回退目标）、toolMessageId（承载工具调用的消息）。三者都算命中，
 * 因为不同写入路径记录的主 id 不同；只认单字段会漏掉一部分可回退节点。
 */
function checkpointMatchesMessage(
  checkpoint: CheckpointCreatedPayload,
  targetMessageId: MessageId,
): boolean {
  return (
    checkpoint.messageId === targetMessageId ||
    checkpoint.targetMessageId === targetMessageId ||
    checkpoint.toolMessageId === targetMessageId
  );
}

/**
 * 取一条消息的文本预览（用于 rewind/fork 提示里的"目标问题"摘要）。
 *
 * 选择顺序：优先**非 synthetic** 的 text part（真实用户/模型文本），没有再退而取 synthetic
 *   文本（例如系统注入的占位），最后仍没有则 undefined。
 * 归一化：把连续空白折叠成单空格并 trim；空串视作无预览（返回 undefined）。
 * 截断：超过 140 字符截成 137 + "..."，保证插入 system reminder 时不撑爆上下文。
 * 副作用：无；纯读。
 */
export function previewTextFromMessage(message: MessageWithParts): string | undefined {
  const textPart =
    message.parts.find((part) => part.type === "text" && !part.synthetic) ??
    message.parts.find((part) => part.type === "text");
  if (!textPart || textPart.type !== "text") return undefined;

  const compact = textPart.text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) return undefined;
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

/**
 * 由活跃消息列表构造 rewind 评估项（供 UI/决策判断哪些节点可回退、是否被 compact 覆盖）。
 *
 * 输入：当前分支消息数组。输出：与消息**一一对应**的评估项数组（顺序不变）。
 * 口径：若消息内嵌 compaction part 且带 compactBoundary，则附带解析后的边界信息，
 *   使下游能识别"该消息历史上被压缩过"，从而要求走 fork 而不是直接裁剪会话。
 * 解析失败/无 compaction part 时只返回 { id }，不抛错；副作用无。
 */
export function buildMessageRewindEvaluationItems(
  messages: readonly MessageWithParts[],
): RewindEvaluationItem[] {
  return messages.map((message) => {
    const compactionPart = message.parts.find(
      (part) => part.type === "compaction" && part.compactBoundary,
    );
    if (compactionPart?.type !== "compaction" || !compactionPart.compactBoundary) {
      return { id: message.info.id };
    }

    return {
      id: message.info.id,
      compactBoundary: parseCompactBoundaryPayload(compactionPart.compactBoundary),
    };
  });
}

/**
 * 由事件流派生 rewind 评估项（与 buildMessageRewindEvaluationItems 的事件版对应）。
 *
 * 只关心两类事件：CheckpointCreated 产出以目标消息 id 为 key 的节点（targetMessageId 优先，
 *   回落到 messageId）；CompactBoundary 产出 `compact_boundary:<boundaryId>` 的合成 id。
 * 合成 id 的意义：压缩边界不是真实消息，但仍要作为可选回退点出现在评估列表里。
 * 输出按事件顺序累积；未识别的其它事件被静默跳过（不报错）。
 */
export function buildRewindEvaluationItems(
  events: readonly SessionEvent[],
): RewindEvaluationItem[] {
  const items: RewindEvaluationItem[] = [];
  for (const event of events) {
    if (event.type === SessionEventType.CheckpointCreated) {
      const checkpoint = parseCheckpointCreatedPayload(event.payload);
      items.push({ id: checkpoint.targetMessageId ?? checkpoint.messageId });
      continue;
    }

    if (event.type === SessionEventType.CompactBoundary) {
      const compactBoundary = parseCompactBoundaryPayload(event.payload);
      items.push({
        id: `compact_boundary:${compactBoundary.boundaryId}`,
        compactBoundary,
      });
    }
  }
  return items;
}

/**
 * 生成"对话已回退"的 system reminder 正文（对话侧，不动工作区文件时使用）。
 *
 * 输入：rewindId、目标消息 id、保留消息数、可选预览。
 * 输出：经 sanitizeSystemReminderBody 处理的文本行；空行（含未提供 preview 的 undefined）被过滤。
 * 语义重点：最后一句明确要求模型"不要把目标消息之后的历史当作本分支已发生"，
 *   这是防止模型沿用被裁掉上下文的唯一硬约束。
 * 副作用：无。
 */
export function formatConversationRewindNoticeBody(options: {
  keptMessageCount: number;
  preview?: string;
  rewindId: string;
  targetMessageId: MessageId;
}): string {
  return sanitizeSystemReminderBody([
    "Conversation rewind applied.",
    `rewindId: ${options.rewindId}`,
    `targetMessageId: ${options.targetMessageId}`,
    `keptMessageCount: ${options.keptMessageCount}`,
    options.preview ? `rewoundPromptPreview: ${options.preview}` : undefined,
    "Continue from the conversation state before the target user message. Do not assume messages after that target happened in this active branch.",
  ].filter((line): line is string => typeof line === "string" && line.length > 0));
}

/**
 * 生成"工作区已回退"的 system reminder 正文（文件恢复，可能不伴随会话裁剪）。
 *
 * 输入：所用 checkpoint、评估结果（提供 strategy）、恢复文件清单、rewindId。
 * 输出：sanitize 后的多行文本；restoredFiles 每行写成 `<action> <path>`。
 * 语义重点：末尾声明"本次文件恢复没有改写对话历史"，避免模型误以为上下文也被裁掉。
 * 副作用：无；空行由 filter 剔除。
 */
export function formatWorkspaceRewindNoticeBody(options: {
  checkpoint: CheckpointCreatedPayload;
  evaluation: RewindTargetEvaluation;
  restoredFiles: WorkspaceRewindRestoredFile[];
  rewindId: string;
}): string {
  const fileLines = options.restoredFiles.map((file) => `${file.action} ${file.path}`).join("\n");
  return sanitizeSystemReminderBody([
    "Workspace rewind applied.",
    `rewindId: ${options.rewindId}`,
    `checkpointId: ${options.checkpoint.checkpointId}`,
    `strategy: ${options.evaluation.strategy}`,
    `restoredFiles: ${options.restoredFiles.length}`,
    fileLines,
    "Conversation history was not rewritten by this file restore.",
  ].filter((line) => line.length > 0));
}

/**
 * 生成"带工作区快照的 fork"提示正文。
 *
 * 与 rewind 的区别：这是**新会话**，因此给出 parentSessionId、checkpointId、
 *   targetMessageId 与 snapshotRef（快照引用），方便追溯来源。
 * 输出：sanitize 后的多行文本；最后一句要求模型不要把 fork 点之后的历史带入新会话。
 * 副作用：无。
 */
export function formatWorkspaceForkNoticeBody(options: {
  checkpoint: CheckpointCreatedPayload;
  parentSessionId: SessionId;
  restoredFiles: WorkspaceRewindRestoredFile[];
}): string {
  const fileLines = options.restoredFiles.map((file) => `${file.action} ${file.path}`).join("\n");
  return sanitizeSystemReminderBody([
    "This session was forked from a previous session checkpoint.",
    `parentSessionId: ${options.parentSessionId}`,
    `checkpointId: ${options.checkpoint.checkpointId}`,
    `targetMessageId: ${options.checkpoint.messageId}`,
    `restoredSnapshotRef: ${options.checkpoint.snapshotRef}`,
    `restoredFiles: ${options.restoredFiles.length}`,
    fileLines,
    "Continue from this fork. Do not assume messages after the fork point happened in this session.",
  ].filter((line) => line.length > 0));
}

/**
 * 生成"按消息位置 fork 并回滚文件"的提示正文。
 *
 * 与 formatWorkspaceForkNoticeBody 的差异：这里没有单一 checkpoint，而是把目标消息之后
 *   的多个 checkpoint **依次补偿回滚**，所以上报 undoneCheckpointCount（撤销了几个快照），
 *   而不是 snapshotRef。
 * 输出：sanitize 后多行文本，显式说明"fork 点之后变更的工作区文件已被还原"。
 * 副作用：无。
 */
export function formatWorkspaceForkAtMessageNoticeBody(options: {
  parentSessionId: SessionId;
  restoredFiles: WorkspaceRewindRestoredFile[];
  targetMessageId: MessageId;
  undoneCheckpointCount: number;
}): string {
  const fileLines = options.restoredFiles.map((file) => `${file.action} ${file.path}`).join("\n");
  return sanitizeSystemReminderBody([
    "This session was forked from a previous session message.",
    `parentSessionId: ${options.parentSessionId}`,
    `targetMessageId: ${options.targetMessageId}`,
    `undoneCheckpointCount: ${options.undoneCheckpointCount}`,
    `restoredFiles: ${options.restoredFiles.length}`,
    fileLines,
    "Workspace files changed after the fork point were restored to their state at the fork point.",
    "Continue from this fork. Do not assume messages after the fork point happened in this session.",
  ].filter((line) => line.length > 0));
}

/**
 * 生成"仅对话 fork"的提示正文（没有可用工作区快照时的降级文案）。
 *
 * 输入：父会话 id 与 fork 目标消息 id。输出：sanitize 后的多行文本。
 * 关键一句 "No workspace checkpoint was restored for this fork." 是安全声明：
 *   新会话的文件状态与父会话当前状态一致，模型不应假设文件回到了 fork 点。
 */
export function formatConversationForkNoticeBody(options: {
  parentSessionId: SessionId;
  targetMessageId: MessageId;
}): string {
  return sanitizeSystemReminderBody([
    "This session was forked from a previous session message.",
    `parentSessionId: ${options.parentSessionId}`,
    `targetMessageId: ${options.targetMessageId}`,
    "No workspace checkpoint was restored for this fork.",
    "Continue from this fork. Do not assume messages after the fork point happened in this session.",
  ]);
}

/**
 * 把 rewind 失败原因码翻译成面向用户的英文说明（tool 响应文本）。
 *
 * 输入：reason（内部错误码，可能来自 methods 层）+ 可选 checkpointId / targetMessageId。
 * 输出：单行人类可读文本；未知 reason 走默认分支，原样回显 reason 便于排障。
 * 文案口径：区分"没有快照""找不到目标""目标不在活跃分支""目标不是用户提问"
 *   "存储/文件系统未配置""快照 artifact 丢失""被 compact 覆盖需 fork"。
 * 降级：拼接目标 id 时按存在与否选择带 id 或省略的句式，不抛错。
 */
export function formatUnavailableRewindResponse(
  reason: string,
  checkpointId?: string,
  targetMessageId?: MessageId,
): string {
  const target = checkpointId ? ` ${checkpointId}` : "";
  const messageTarget = targetMessageId ? ` ${targetMessageId}` : "";
  switch (reason) {
    case "no_checkpoint_available":
      return "No workspace checkpoint is available yet.";
    case "target_checkpoint_not_found":
      return targetMessageId
        ? `No workspace checkpoint was found for message${messageTarget}.`
        : `Checkpoint${target} was not found.`;
    case "target_message_not_found":
      return `Message${messageTarget} is not available in the active conversation branch.`;
    case "target_message_is_not_user_prompt":
      return `Message${messageTarget} is not a rewindable user prompt.`;
    case "conversation_rewind_requires_session_store":
      return "Conversation rewind is unavailable because session storage is not configured.";
    case "artifact_store_not_configured":
      return "Workspace rewind is unavailable because artifact storage is not configured.";
    case "file_system_port_not_configured":
      return "Workspace rewind is unavailable because file-system access is not configured.";
    case "checkpoint_snapshot_unavailable":
      return `Checkpoint${target} cannot be restored because its snapshot artifact is unavailable.`;
    case "target_covered_by_compact_requires_fork":
      return `Message${messageTarget || target} is covered by compact for conversation rewind; create a fork to rewind conversation history.`;
    default:
      return `Workspace rewind is unavailable: ${reason}.`;
  }
}
