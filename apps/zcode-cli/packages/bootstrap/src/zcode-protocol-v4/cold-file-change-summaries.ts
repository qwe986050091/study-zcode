/**
 * ============================================================================
 * zcode-protocol-v4/cold-file-change-summaries.ts —— 冷恢复的单轮文件变更摘要
 * ============================================================================
 *
 * 【职责】把 workspace checkpoint artifact 聚合回"某条 user message 对应一轮"
 * 的 TurnFileChangeSummary（files/additions/deletions/items），供冷恢复时
 * 注入合成 ModelComplete，让刷新后的文件变更卡与 live 完全一致。
 *
 * 【口径】
 *   - checkpoint 顺序即同一轮写入顺序：串行聚合 first-before → final-after；
 *   - 有 afterContent 时按 before→after 生成最终 patch（覆盖中间多次写入）；
 *   - 没有 afterContent 时累加各 checkpoint 的 patch 行数，作为可解释降级；
 *   - split product turn（turnId 含 "~"）禁止按 runtime turnId 兜底，避免串轮。
 *
 * 【失败与降级】artifact 读取/解析失败只跳过该 messageId 并回调 onArtifactError；
 * 没有任何 checkpoint 时才退回 ModelComplete.fileChanges（仅旧 transcript）。
 * ============================================================================
 */
import {
  RewindScope,
  SessionEventType,
  parseCheckpointCreatedPayload,
  parseWorkspaceCheckpointArtifact,
  type DiffHunk,
  type SessionEvent,
  type TurnFileChangeSummary,
  type TurnId,
} from "@zcode/contracts";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import { applyPatch, structuredPatch, type StructuredPatch } from "diff";

/** 按路径聚合的中间态：first-before、最新的 final-after、累加行数与写入次数。 */
interface FileChangeAggregate {
  afterContent?: string;
  beforeContent: string | null;
  fallbackAdditions: number;
  fallbackDeletions: number;
  patches: DiffHunk[];
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

interface WorkspaceCheckpointWithTurn {
  checkpoint: ReturnType<typeof parseCheckpointCreatedPayload>;
  turnId: string | null;
}

type ReadArtifact = (snapshotRef: string) => Promise<string>;

/** split product turn 用 "~" 区分同 runtime turn 的多个 product 轮；不能按 runtime id 合并。 */
function isSplitProductTurnId(turnId: string | null | undefined): boolean {
  return Boolean(turnId?.includes("~"));
}

/** workspace scope（含 both）才带文件快照；纯 conversation checkpoint 不参与文件摘要。 */
function isWorkspaceCheckpoint(
  checkpoint: ReturnType<typeof parseCheckpointCreatedPayload>,
): boolean {
  return checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both;
}

/** 从事件流提取 workspace checkpoint，并保留事件 turnId 供 legacy 兜底。 */
function workspaceCheckpoints(events: readonly SessionEvent[]): WorkspaceCheckpointWithTurn[] {
  return events
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => ({
      checkpoint: parseCheckpointCreatedPayload(event.payload),
      turnId: event.turnId ? String(event.turnId) : null,
    }))
    .filter(({ checkpoint }) => isWorkspaceCheckpoint(checkpoint));
}

/**
 * 选出一轮对应的 checkpoint：优先按持久 messageId 精确匹配；
 * 只有无匹配、非 split turn 时，才用事件 turnId 兜底旧数据。
 */
function selectWorkspaceCheckpointsForFileSummary(
  events: readonly SessionEvent[],
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): WorkspaceCheckpointWithTurn[] {
  const messageIdSet = new Set(messageIds);
  const checkpoints = workspaceCheckpoints(events);
  const byMessageId = checkpoints.filter(({ checkpoint }) =>
    messageIdSet.has(String(checkpoint.targetMessageId ?? checkpoint.messageId)),
  );
  if (byMessageId.length > 0 || !targetTurnId || isSplitProductTurnId(String(targetTurnId))) {
    return byMessageId;
  }

  // 旧事件和缺失 user messageId 映射的普通 TurnStarted
  // 只能用事件 turnId 兜底。split product turn 带 "~q" 后缀，禁止按 runtime turnId
  // 合并，避免 queued/drained 场景串轮。
  return checkpoints.filter(({ turnId }) => turnId === String(targetTurnId));
}

/**
 * 旧 transcript 的兜底：取该 turn 最后一条 ModelComplete.fileChanges。
 * 只接受非 split 轮；字段缺失/负数按 0 处理，路径为空的条目剔除。
 * 无可用数据返回 null，由调用方产出空摘要。
 */
function readModelCompleteFileChangesFallback(
  events: readonly SessionEvent[],
  targetTurnId?: TurnId | null,
): V4ConversationFileChangesResult | null {
  if (!targetTurnId || isSplitProductTurnId(String(targetTurnId))) {
    return null;
  }
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === SessionEventType.ModelComplete &&
        String(candidate.turnId ?? "") === String(targetTurnId),
    );
  const fileChanges = (event?.payload as { fileChanges?: unknown } | undefined)?.fileChanges;
  if (typeof fileChanges !== "object" || fileChanges === null) {
    return null;
  }
  const rawItems = (fileChanges as { items?: unknown }).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return null;
  }
  const items = rawItems
    .flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string" || record.path.length === 0) return [];
      return [
        {
          path: record.path,
          additions:
            typeof record.additions === "number" && record.additions > 0 ? record.additions : 0,
          deletions:
            typeof record.deletions === "number" && record.deletions > 0 ? record.deletions : 0,
          writeCount:
            typeof record.writeCount === "number" && record.writeCount > 0 ? record.writeCount : 1,
          toolNames: [] as string[],
          patches: [] as DiffHunk[],
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (items.length === 0) return null;
  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

/**
 * 串行聚合一轮内多个 workspace checkpoint（顺序即写入顺序）。
 *
 * 每文件保留 first-before 与最新 final-after；有 afterContent 时最终生成
 * before→after 的单一 patch，行数按该 patch 统计；否则累加各段 patch 行数。
 * 最后按路径排序，保证输出稳定、可比较。副作用：只读 artifact，不写库。
 */
async function aggregateWorkspaceCheckpoints(
  checkpoints: readonly WorkspaceCheckpointWithTurn[],
  readArtifact: ReadArtifact,
): Promise<V4ConversationFileChangesResult> {
  const byPath = new Map<string, FileChangeAggregate>();

  // checkpoint 顺序就是同一轮文件写入顺序，必须串行聚合 first-before → final-after。
  for (const { checkpoint } of checkpoints) {
    const artifact = parseWorkspaceCheckpointArtifact(
      JSON.parse(await readArtifact(checkpoint.snapshotRef)),
    );
    for (const file of artifact.files) {
      const fallback = countPatchLines(file.structuredPatch);
      const afterContent = resolveCheckpointAfterContent(file);
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, {
          afterContent,
          beforeContent: file.beforeContent,
          fallbackAdditions: fallback.additions,
          fallbackDeletions: fallback.deletions,
          patches: file.structuredPatch,
          path: file.path,
          toolNames: new Set([artifact.toolName]),
          writeCount: 1,
        });
        continue;
      }
      existing.afterContent = afterContent ?? existing.afterContent;
      existing.fallbackAdditions += fallback.additions;
      existing.fallbackDeletions += fallback.deletions;
      existing.patches.push(...file.structuredPatch);
      existing.toolNames.add(artifact.toolName);
      existing.writeCount += 1;
    }
  }

  const items = Array.from(byPath.values())
    .map((entry) => {
      const patches =
        entry.afterContent === undefined
          ? entry.patches
          : createFinalPatch(entry.path, entry.beforeContent ?? "", entry.afterContent);
      const stat =
        entry.afterContent === undefined
          ? {
              additions: entry.fallbackAdditions,
              deletions: entry.fallbackDeletions,
            }
          : countPatchLines(patches);
      return {
        path: entry.path,
        additions: stat.additions,
        deletions: stat.deletions,
        writeCount: entry.writeCount,
        toolNames: Array.from(entry.toolNames).sort(),
        patches,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

/**
 * 单轮文件变更查询：优先 workspace checkpoint 聚合，其次旧 ModelComplete 兜底，
 * 最后返回空摘要（files/additions/deletions 全 0）。不抛 artifact 错误（由调用方处理）。
 */
export async function readConversationFileChangesFromEvents(input: {
  events: readonly SessionEvent[];
  messageIds: readonly string[];
  readArtifact: ReadArtifact;
  targetTurnId?: TurnId | null;
}): Promise<V4ConversationFileChangesResult> {
  const checkpoints = selectWorkspaceCheckpointsForFileSummary(
    input.events,
    input.messageIds,
    input.targetTurnId,
  );
  const result = await aggregateWorkspaceCheckpoints(checkpoints, input.readArtifact);
  if (result.items.length > 0) return result;
  return (
    readModelCompleteFileChangesFallback(input.events, input.targetTurnId) ?? {
      files: 0,
      additions: 0,
      deletions: 0,
      items: [],
    }
  );
}

/**
 * 批量构建单轮文件变更摘要（messageId → TurnFileChangeSummary）。
 *
 * 只处理 durable messageIds 对应的 checkpoint；最多 8 个并发 worker，
 * 单组 artifact 失败仅回调 onArtifactError 并跳过该组，不影响其他轮次。
 * 副作用：只读 artifact；返回新 Map，顺序稳定便于 snapshot 复现。
 */
export async function buildColdFileChangeSummaries(input: {
  events: readonly SessionEvent[];
  messageIds: readonly string[];
  onArtifactError?: (messageId: string, error: unknown) => void;
  readArtifact: ReadArtifact;
}): Promise<ReadonlyMap<string, TurnFileChangeSummary>> {
  const durableMessageIds = new Set(input.messageIds);
  const checkpointsByMessageId = new Map<string, WorkspaceCheckpointWithTurn[]>();
  for (const entry of workspaceCheckpoints(input.events)) {
    const messageId = String(entry.checkpoint.targetMessageId ?? entry.checkpoint.messageId);
    if (!durableMessageIds.has(messageId)) continue;
    const entries = checkpointsByMessageId.get(messageId) ?? [];
    entries.push(entry);
    checkpointsByMessageId.set(messageId, entries);
  }

  const summaries = new Map<string, TurnFileChangeSummary>();
  const groups = [...checkpointsByMessageId.entries()];
  let cursor = 0;
  const workerCount = Math.min(8, groups.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < groups.length) {
        const group = groups[cursor];
        cursor += 1;
        if (!group) continue;
        const [messageId, checkpoints] = group;
        try {
          const result = await aggregateWorkspaceCheckpoints(checkpoints, input.readArtifact);
          if (result.items.length === 0) continue;
          summaries.set(messageId, {
            additions: result.additions,
            deletions: result.deletions,
            files: result.files,
            items: result.items.map((item) => ({
              additions: item.additions,
              deletions: item.deletions,
              path: item.path,
              toolNames: item.toolNames,
              writeCount: item.writeCount,
            })),
          });
        } catch (error) {
          input.onArtifactError?.(messageId, error);
        }
      }
    }),
  );
  return summaries;
}

/** before→after 的最终 patch；5s 超时防止超长文件阻塞冷恢复。 */
function createFinalPatch(path: string, beforeContent: string, afterContent: string): DiffHunk[] {
  return (
    structuredPatch(path, path, beforeContent, afterContent, undefined, undefined, {
      timeout: 5_000,
    })?.hunks ?? []
  );
}

/**
 * 恢复该 checkpoint 写入后的文件内容：显式 afterContent 优先；
 * 否则对 beforeContent 应用 structuredPatch；无法重建时返回 undefined，
 * 由上层降级为累加 patch 行数。
 */
function resolveCheckpointAfterContent(
  file: ReturnType<typeof parseWorkspaceCheckpointArtifact>["files"][number],
): string | undefined {
  if (typeof file.afterContent === "string") return file.afterContent;
  if (!file.existedBefore && file.beforeContent === null && file.structuredPatch.length === 0) {
    return undefined;
  }
  const patch: StructuredPatch = {
    oldFileName: file.path,
    newFileName: file.path,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: file.structuredPatch,
  };
  const patched = applyPatch(file.beforeContent ?? "", patch, {
    autoConvertLineEndings: false,
    fuzzFactor: 0,
  });
  return typeof patched === "string" ? patched : undefined;
}

/** 统计 unified diff hunk 的新增/删除行；只认行首 +/-, 不解析文件头。 */
function countPatchLines(hunks: readonly DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}
