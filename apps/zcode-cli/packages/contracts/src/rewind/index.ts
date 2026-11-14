// ============================================================
// Rewind Contracts - checkpoint payloads and compact-aware helpers
// ============================================================
//
// 【定位】rewind 是"把对话/工作区退回某个历史点"的跨层契约：checkpoint 事件记录
// 变更前的文件快照（真实的文件内容在 snapshotRef 指向的 artifact 里），rewind 事件
// 记录一次退回请求及其可执行策略；evaluateRewindTarget 负责在 compact 之后判断
// 目标还能否在活动分支上直接退回，还是只能文件回滚、必须 fork，或彻底不可达。
//
// 【生产者】core 的 rewind 编排（runtime/methods/rewind.ts）、workspace-checkpoints
// 与 file-rewind 产生 CheckpointCreated / RewindTriggered 事件；【消费者】bootstrap
// 的 product-projection 做 UI 投影，runtime resume 与 cold projection 用
// selectActiveConversationBranch 重建活动分支。
//
// 【不变量】payload 里的 messageId/targetMessageId/toolMessageId 是 SessionStore 中
// 真实存在的消息 id（不是 checkpoint id、不是 artifact 路径），类型别名里收窄成
// MessageId 只为编译期区分语义。三个事件 schema 全部 strict() 且新增字段一律可选，
// 否则已落盘的旧 transcript 将无法解析。transcript 本身 append-only：rewind 不删除
// 旧消息，只通过分支游标改变"哪一段属于活动分支"。
// ============================================================

import { z } from "zod";

import { isCompactBoundaryItem, parseCompactBoundaryPayload } from "../compact/index.js";
import type { CompactBoundaryPayload, CompactContextItem } from "../compact/index.js";
import type { MessageId } from "../interfaces/shared.js";

// 单个 unified diff hunk（与 `git diff` 的 hunk 头同构）：old/new 的起始行与行数
// 均为 1-based 位置描述，lines 保留原始 +/-/空格前缀。它只用于展示与人工核对，
// 回滚依赖的是 beforeContent，而不是从 patch 反推。
const diffHunkSchema = z
  .object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })
  .strict();

// 回退范围：conversation 只裁剪对话分支，workspace 只用 checkpoint 还原文件，
// both 两者都做。注意范围决定的是"允许做什么"，不是"一定做了什么"——
// evaluateRewindTarget 会在 compact/checkpoint 缺失时把请求降级或拒绝。
export const RewindScope = {
  Conversation: "conversation",
  Workspace: "workspace",
  Both: "both",
} as const;

// 范围常量的类型镜像（值域见上方说明）。
export type RewindScope = (typeof RewindScope)[keyof typeof RewindScope];

// 实际可执行的退法：active_chain 在现行分支上直接裁剪；file_only 只还原文件、
// 不动对话（目标消息已被 compact 覆盖时的降级结果）；fork_required 需另起分支；
// unavailable 表示当前状态下无法安全回退（缺 checkpoint、目标不存在等）。
export const RewindStrategy = {
  ActiveChain: "active_chain",
  FileOnly: "file_only",
  ForkRequired: "fork_required",
  Unavailable: "unavailable",
} as const;

// 策略常量的类型镜像（值域见上方说明）。
export type RewindStrategy = (typeof RewindStrategy)[keyof typeof RewindStrategy];

// 目标消息相对于活动 provider history 的位置：active_chain 仍在边界之后、可直接裁；
// covered_by_compact 已被某个 compact 边界吞进摘要（原文只存在于 append-only store）；
// missing 找不到该 id。它描述"事实位置"，与上面描述"动作"的 RewindStrategy 不能混用。
export const RewindTargetStatus = {
  ActiveChain: "active_chain",
  CoveredByCompact: "covered_by_compact",
  Missing: "missing",
} as const;

// 目标状态常量的类型镜像（值域见上方说明）。
export type RewindTargetStatus = (typeof RewindTargetStatus)[keyof typeof RewindTargetStatus];

// CheckpointCreated 事件的 payload（strict，向后新增字段必须可选）。逐字段口径：
// - checkpointId：checkpoint 自身的业务 id，用于 rewind 时按 targetCheckpointId 引用；
// - messageId：触发该 checkpoint 的那条消息（工具调用/变更发生的上下文位置）；
// - targetMessageId：可选，checkpoint 语义上对应的"回退锚点"消息，范围回滚时使用；
// - toolMessageId：可选，引发文件变更的工具消息 id，用于把变更与工具调用对齐；
// - scope：该 checkpoint 覆盖的范围，文件变更类固定为 workspace；
// - snapshotRef：指向持久化 artifact 的引用（不是内联内容），必须能在重启后解析；
// - diffRef：可选，指向可展示的 diff artifact；
// - fileCount：可选，本次变更涉及的文件数（UI 摘要用，缺失不等于 0）；
// - compactBoundaryId/coveredByCompact：可选，记录该 checkpoint 关联的 compact 边界
//   以及是否已落在被压缩的区间内，供 rewind 时判断是否还能回到该点。
export const checkpointCreatedPayloadSchema = z
  .object({
    checkpointId: z.string().min(1),
    messageId: z.string().min(1),
    targetMessageId: z.string().min(1).optional(),
    toolMessageId: z.string().min(1).optional(),
    scope: z.enum([RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]),
    snapshotRef: z.string().min(1),
    diffRef: z.string().min(1).optional(),
    fileCount: z.number().int().nonnegative().optional(),
    compactBoundaryId: z.string().min(1).optional(),
    coveredByCompact: z.boolean().optional(),
  })
  .strict();

// 把 payload 里的三个 id 字段从 string 收窄为 MessageId。运行时形状不变（仍是
// 字符串），收窄只是为了在调用处区分"消息 id"与普通 checkpoint/artifact id，
// 避免把 checkpointId 误传进按消息 id 查找的 API。
export type CheckpointCreatedPayload = Omit<
  z.infer<typeof checkpointCreatedPayloadSchema>,
  "messageId" | "targetMessageId" | "toolMessageId"
> & {
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
};

// RewindTriggered 事件的 payload（strict）。逐字段口径：
// - rewindId：本次回退操作的 id，UI 去重与幂等处理用它；
// - scope：请求的范围（conversation/workspace/both），由用户意图决定；
// - strategy：实际采用的退法，可能因 compact/checkpoint 条件被降级（见 evaluateRewindTarget）；
// - targetMessageId：可选，要退回到的消息 id；目标可能在活动分支、也可能已被 compact 覆盖；
// - targetCheckpointId：可选，workspace 回滚时使用哪个 checkpoint；
// - compactBoundaryId：可选，本次回退关联的 compact 边界 id，用于确定重建起点；
// - restoredSnapshotRef：可选，实际被还原的 workspace artifact 引用；
// - branchCutAfterMessageId：可选，新语义的分支游标——该消息之后的内容不再属于活动分支，
//   之后追加的任意 canonical message 自动进入新分支（旧消息仍留在 append-only store）；
// - branchGeneration：可选，分支代数，与 branchCutAfterMessageId 一起标识"哪一代 cut"，
//   连续多次 rewind 时用它区分游标属于哪一次，避免新旧 cut 混用；
// - createdMessageId：可选，仅用于兼容旧 transcript 的"回退后插入的消息"锚点；
//   新语义不再依赖它，消费方应优先看 branchGeneration + branchCutAfterMessageId；
// - reason：可选，可读的原因说明（例如降级原因），仅供展示，不参与判定。
export const rewindTriggeredPayloadSchema = z
  .object({
    rewindId: z.string().min(1),
    scope: z.enum([RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]),
    strategy: z.enum([
      RewindStrategy.ActiveChain,
      RewindStrategy.FileOnly,
      RewindStrategy.ForkRequired,
      RewindStrategy.Unavailable,
    ]),
    targetMessageId: z.string().min(1).optional(),
    targetCheckpointId: z.string().min(1).optional(),
    compactBoundaryId: z.string().min(1).optional(),
    restoredSnapshotRef: z.string().min(1).optional(),
    branchCutAfterMessageId: z.string().min(1).optional(),
    branchGeneration: z.number().int().nonnegative().optional(),
    createdMessageId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

// 三个消息 id 字段收窄为 MessageId（理由同 CheckpointCreatedPayload）。其中
// branchCutAfterMessageId 是分支裁剪游标，createdMessageId 只为旧数据兼容保留。
export type RewindTriggeredPayload = Omit<
  z.infer<typeof rewindTriggeredPayloadSchema>,
  "targetMessageId" | "branchCutAfterMessageId" | "createdMessageId"
> & {
  branchCutAfterMessageId?: MessageId;
  targetMessageId?: MessageId;
  createdMessageId?: MessageId;
};

// workspace checkpoint 的持久化 artifact 形状（由 snapshotRef 指向的 JSON）。
// version 固定 1、kind 固定 "workspace_file_before_change"，用作内容判别与向前兼容；
// createdAt 为 ISO 字符串；toolCallId/toolName 定位产生这次变更的工具调用；
// files 至少一项，每项记录：path（相对工作区路径）、existedBefore（新建文件为 false，
// 回滚时应删除）、beforeContent（变更前全文，null 表示原先不存在）、afterContent/
// afterContentLength（可选，仅用于展示，不是回滚依据）、structuredPatch（供 diff UI）。
// strict() 保证 artifact 不会被无关字段污染——它会被重新读取并直接用于写盘还原。
export const workspaceCheckpointArtifactSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("workspace_file_before_change"),
    createdAt: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            existedBefore: z.boolean(),
            beforeContent: z.string().nullable(),
            afterContent: z.string().optional(),
            afterContentLength: z.number().int().nonnegative().optional(),
            structuredPatch: z.array(diffHunkSchema),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

// artifact 的类型镜像；写盘/读盘两端都应按上面的 schema 校验后再使用。
export type WorkspaceCheckpointArtifact = z.infer<typeof workspaceCheckpointArtifactSchema>;

// checkpoint 在 UI 投影层的信息：由 CheckpointCreatedPayload 加上 createdAt 得到。
// messageId 是触发消息，targetMessageId 是回退锚点，toolMessageId 是变更来源，
// 三者语义不同不可互换；snapshotRef 必须在投影后仍可解析（UI 可能用它打开 diff）。
// 这里字段全部保留可选性，因为旧事件可能没有 compact 相关字段。
export interface CheckpointProjectionInfo {
  checkpointId: string;
  compactBoundaryId?: string;
  coveredByCompact?: boolean;
  createdAt: Date;
  fileCount?: number;
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
  scope: RewindScope;
  snapshotRef: string;
}

// rewind 在 UI 投影层的信息：由 RewindTriggeredPayload 加上 triggeredAt 得到。
// 注意这里刻意不含 branchCutAfterMessageId/branchGeneration/createdMessageId——
// 投影只负责"展示发生过一次什么策略的回退"，不参与分支重建；分支游标由
// ActiveConversationBranchOptions 直接携带，二者不要混用。
export interface RewindProjectionInfo {
  compactBoundaryId?: string;
  reason?: string;
  rewindId: string;
  scope: RewindScope;
  strategy: RewindStrategy;
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  triggeredAt: Date;
}

// evaluateRewindTarget 的判定结果：strategy 是"能做/建议怎么做"，targetStatus 是
// "目标客观在哪"，allowedScopes 是本次真正允许的范围（调用方必须用它覆盖用户请求，
// 不能自己再放宽）。compactBoundary/compactBoundaryId 回传命中的最新边界，供上层
// 决定重建起点；reason 是稳定的机器可读原因码（不面向用户直接展示）。
export interface RewindTargetEvaluation {
  allowedScopes: RewindScope[];
  compactBoundary?: CompactBoundaryPayload;
  compactBoundaryId?: string;
  reason: string;
  strategy: RewindStrategy;
  targetStatus: RewindTargetStatus;
}

// 判定入参：items 是待检上下文（消息或 compact item），targetMessageId 是目标 id；
// getId/isBoundary 允许调用方自定义 id 提取与边界识别（默认分别取 item.id 与
// isCompactBoundaryItem）；checkpointAvailable 告诉判定"工作区回滚是否还有依据"，
// 不传按 false 处理，因此纯 conversation 场景无需关心 workspace。
export interface EvaluateRewindTargetInput<T extends { id: string }> {
  checkpointAvailable?: boolean;
  getId?: (item: T) => string;
  isBoundary?: (item: T) => boolean;
  items: readonly T[];
  scope: RewindScope;
  targetMessageId: MessageId | string;
}

// selectActiveConversationBranch 的输入游标（全部可选，缺省即"无 rewind，返回全量"）：
// rewindTargetMessageId 是回退目标（裁剪到它之前）；rewindKeptMessageIds 是精确保留集
// （优先于按目标裁剪）；branchCutAfterMessageId 是新语义的分支游标（该消息之后的追加
// 内容归入新分支）；rewindCreatedMessageId 只服务旧 transcript 的"回退后插入消息"锚点。
export interface ActiveConversationBranchOptions {
  branchCutAfterMessageId?: MessageId;
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
}

// 纯函数，无 I/O：给定完整 transcript 与 rewind 游标，返回"当前活动分支"的消息序列。
// 两代语义并存：有 branchCutAfterMessageId 时走新语义（kept 之后拼接 cut 之后追加的
// 消息，等价于把 cut 点当作新分支起点）；没有 cut 时退化为旧语义（按目标 index 裁剪，
// 再从 createdMessageId 起保留回退后插入的消息）。找不到游标一律保守返回不裁剪，
// 避免误删当前对话；调用方不得依赖本函数修改原数组。
/** runtime resume、cold projection 与 stable fork 共用的 conversation active-branch 裁剪。 */
export function selectActiveConversationBranch<T extends { info: { id: MessageId } }>(
  messages: readonly T[],
  options: ActiveConversationBranchOptions = {},
): T[] {
  if (!options.rewindTargetMessageId) return [...messages];
  const messagesById = new Map(messages.map((message) => [message.info.id, message]));
  const targetIndex = messages.findIndex(
    (message) => message.info.id === options.rewindTargetMessageId,
  );
  const kept = options.rewindKeptMessageIds
    ? options.rewindKeptMessageIds
        .map((messageId) => messagesById.get(messageId))
        .filter((message): message is T => message !== undefined)
    : targetIndex >= 0
      ? messages.slice(0, targetIndex)
      : [...messages];

  if (options.branchCutAfterMessageId) {
    const cutIndex = messages.findIndex(
      (message) => message.info.id === options.branchCutAfterMessageId,
    );
    // rewind 不再写 model-visible reminder。cut 游标直接指向提交前 transcript
    // 尾部，之后追加的任意 canonical message 自动属于新分支；旧分支仍留在 append-only store。
    return cutIndex >= 0 ? [...kept, ...messages.slice(cutIndex + 1)] : kept;
  }

  if (options.rewindKeptMessageIds) {
    if (!options.rewindCreatedMessageId) return kept;
    const createdIndex = messages.findIndex(
      (message) => message.info.id === options.rewindCreatedMessageId,
    );
    return createdIndex >= 0 ? [...kept, ...messages.slice(createdIndex)] : kept;
  }
  if (targetIndex < 0) return [...messages];
  if (!options.rewindCreatedMessageId) return kept;
  const createdIndex = messages.findIndex(
    (message) => message.info.id === options.rewindCreatedMessageId,
  );
  return createdIndex >= 0 ? [...kept, ...messages.slice(createdIndex)] : kept;
}

// 解析 CheckpointCreated 事件 payload。事件来自已落盘日志，可能由更早的版本写入，
// 因此这里用容错解析（可选字段缺省即旧格式）而不是直接信任内存对象；解析失败会抛
// zod 错误，调用方需按"事件损坏"处理，不能静默跳过。as 收窄只是把 id 换成 MessageId。
export function parseCheckpointCreatedPayload(input: unknown): CheckpointCreatedPayload {
  return checkpointCreatedPayloadSchema.parse(input) as CheckpointCreatedPayload;
}

// 解析 RewindTriggered 事件 payload。兼容旧 payload 的原因：早期版本只写
// createdMessageId（没有 branchCutAfterMessageId/branchGeneration），新版本读取时
// 必须仍能解析并走旧分支语义；schema 用 strict() + 全可选新字段来同时满足两代事件。
export function parseRewindTriggeredPayload(input: unknown): RewindTriggeredPayload {
  return rewindTriggeredPayloadSchema.parse(input) as RewindTriggeredPayload;
}

// 解析 checkpoint artifact。artifact 会在回滚时被重新读入并用于写盘，属于"可执行数据"，
// 所以必须先过 schema（尤其 version/kind 与 files 非空）再交给文件系统端口。
export function parseWorkspaceCheckpointArtifact(input: unknown): WorkspaceCheckpointArtifact {
  return workspaceCheckpointArtifactSchema.parse(input) as WorkspaceCheckpointArtifact;
}

// 判定"能否回退到 targetMessageId"。核心口径：
// - boundaryIndex 取"最后一个 compact 边界"；targetIndex < boundaryIndex 即 target
//   已落在被摘要覆盖的区间（coveredByCompact），否则仍在活动链上；
// - target 不存在 → missing/unavailable，即使有 checkpoint 也不猜测意图；
// - 未覆盖：conversation 永远可裁；workspace/both 必须有 checkpoint，否则
//   unavailable 并把 allowedScopes 收窄到 conversation；
// - 已覆盖 + 请求 workspace：有 checkpoint 则降级为 file_only（只还原文件，不动对话），
//   没有则 unavailable；
// - 已覆盖 + 请求 conversation：仍可 active_chain——message/part 是 append-only，
//   compact 只是派生边界，先 branch cut 再重建 compact scope 即可，无需强制 fork。
// 返回的 allowedScopes 是权威结果，调用方不得再按原请求放宽。
export function evaluateRewindTarget<T extends { id: string }>(
  input: EvaluateRewindTargetInput<T>,
): RewindTargetEvaluation {
  const getId = input.getId ?? ((item: T) => item.id);
  const targetIndex = input.items.findIndex((item) => getId(item) === input.targetMessageId);
  const boundaryIndex = input.items.findLastIndex(
    input.isBoundary ?? ((item) => isCompactBoundaryItem(item as CompactContextItem)),
  );
  const compactBoundary =
    boundaryIndex >= 0
      ? parseCompactBoundaryPayload(
          (input.items[boundaryIndex] as CompactContextItem).compactBoundary,
        )
      : undefined;

  if (targetIndex < 0) {
    return {
      allowedScopes: [],
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "target_not_found",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.Missing,
    };
  }

  const checkpointAvailable = input.checkpointAvailable === true;
  const coveredByCompact = boundaryIndex >= 0 && targetIndex < boundaryIndex;

  if (!coveredByCompact) {
    const allowedScopes = activeChainAllowedScopes(checkpointAvailable);
    if (!isRequestedScopeAllowed(input.scope, allowedScopes)) {
      return {
        allowedScopes,
        compactBoundary,
        compactBoundaryId: compactBoundary?.boundaryId,
        reason: "checkpoint_required_for_workspace_rewind",
        strategy: RewindStrategy.Unavailable,
        targetStatus: RewindTargetStatus.ActiveChain,
      };
    }

    return {
      allowedScopes,
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "target_in_active_chain",
      strategy: RewindStrategy.ActiveChain,
      targetStatus: RewindTargetStatus.ActiveChain,
    };
  }

  if (input.scope === RewindScope.Workspace && checkpointAvailable) {
    return {
      allowedScopes: [RewindScope.Workspace],
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "target_covered_by_compact_file_only_available",
      strategy: RewindStrategy.FileOnly,
      targetStatus: RewindTargetStatus.CoveredByCompact,
    };
  }

  if (input.scope === RewindScope.Workspace) {
    return {
      allowedScopes: [],
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "target_covered_by_compact_without_checkpoint",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.CoveredByCompact,
    };
  }

  const allowedScopes = checkpointAvailable
    ? [RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]
    : [RewindScope.Conversation];
  if (!isRequestedScopeAllowed(input.scope, allowedScopes)) {
    return {
      allowedScopes,
      compactBoundary,
      compactBoundaryId: compactBoundary?.boundaryId,
      reason: "checkpoint_required_for_workspace_rewind",
      strategy: RewindStrategy.Unavailable,
      targetStatus: RewindTargetStatus.CoveredByCompact,
    };
  }
  // message/part 是 append-only，compact 只是 active provider history 的派生边界。
  // conversation rewind 可以先 branch cut 再重建 compact scope，不应再强制创建 child。
  return {
    allowedScopes,
    compactBoundary,
    compactBoundaryId: compactBoundary?.boundaryId,
    reason: "target_covered_by_compact_active_branch_rebuild",
    strategy: RewindStrategy.ActiveChain,
    targetStatus: RewindTargetStatus.CoveredByCompact,
  };
}

// 活动链上允许的回退范围：workspace/both 需要 checkpoint 作为文件还原依据，
// 没有 checkpoint 时只剩 conversation。该规则同时用于"未覆盖"与"已覆盖"两处判定，
// 因此抽成函数，避免两处口径漂移。
function activeChainAllowedScopes(checkpointAvailable: boolean): RewindScope[] {
  return checkpointAvailable
    ? [RewindScope.Conversation, RewindScope.Workspace, RewindScope.Both]
    : [RewindScope.Conversation];
}

// 请求范围是否落在允许集合内：不匹配时调用方应把 strategy 降为 unavailable，
// 而不是悄悄缩小范围继续执行。严格相等匹配，不做 conversation ⊂ both 之类的包含推导。
function isRequestedScopeAllowed(
  scope: RewindScope,
  allowedScopes: readonly RewindScope[],
): boolean {
  return allowedScopes.includes(scope);
}
