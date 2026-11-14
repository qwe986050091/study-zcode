import { basename, relative } from "node:path";
import {
  WORKSPACE_HOOK_REVIEW_TIMEOUT_MS,
  type WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import type { WorkspaceHookReviewTarget, WorkspaceHookSnapshotEvaluation } from "@zcode/core";
import type { WorkspaceHookReviewRequestPayload } from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookReviewHostPort } from "./workspace-hook-review-types.js";

/**
 * 把审核快照 + 信任评估组装成协议层 review 请求（纯投影，不做 I/O、不改快照）。
 *
 * 逐项字段口径：`displayName` 是 `event · matcher`（无 matcher 只显示 event）；
 * `displayCommand` 对 process 是 `command + args` 拼接，command 型直接用声明；`sourcePath` 是
 * 相对来源路径（绝不发绝对路径）；`executionMode` 由 type=command 且 async 决定 background；
 * `trustState` 来自 evaluation.items，缺省按 blocked_untrusted（安全侧）。
 * 汇总：eventCount 去重；pendingCount 只数 pending_trust / revoked / stale_digest，刻意不看
 * configuredEnabled（协议 schema 如此校验；未启用也可信任，开关只管运行）。
 * `deadlineAt = createdAt + 审核超时`；interactionId 由 createId 生成，是本次交互的关联键。
 */
export function buildWorkspaceHookReviewRequest(input: {
  snapshot: WorkspaceHookBundleSnapshot;
  evaluation: WorkspaceHookSnapshotEvaluation;
  reviewFlowId: string;
  generation: number;
  sessionId: string;
  host: WorkspaceHookReviewHostPort;
  now: () => number;
  createId: () => string;
}): WorkspaceHookReviewRequestPayload {
  const createdAt = input.now();
  const stateByItem = new Map(
    input.evaluation.items.map((item) => [item.reviewItemId, item.trustState] as const),
  );
  const items = input.snapshot.hooks.map((entry) => ({
    reviewItemId: entry.reviewItemId,
    event: entry.event,
    ...(entry.matcher ? { matcher: entry.matcher } : {}),
    type: entry.type,
    displayName: entry.matcher ? `${entry.event} · ${entry.matcher}` : entry.event,
    displayCommand:
      entry.type === "process" ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.command,
    sourcePath: entry.sourceRelativePath,
    resolvedTimeoutMs: entry.resolvedTimeoutMs,
    resolvedMaxOutputBytes: entry.resolvedMaxOutputBytes,
    executionMode:
      entry.type === "command" && entry.async ? ("background" as const) : ("foreground" as const),
    configuredEnabled: entry.configuredEnabled,
    editable: entry.editable,
    trustState: stateByItem.get(entry.reviewItemId) ?? "blocked_untrusted",
  }));
  return {
    kind: "workspaceHookReview",
    reviewFlowId: input.reviewFlowId,
    generation: input.generation,
    interactionId: `workspace-hook-interaction:${input.createId()}`,
    sessionId: input.sessionId,
    taskId: input.host.taskId,
    runId: input.host.runId,
    workspaceIdentity: input.snapshot.workspaceIdentity,
    workspaceLabel: input.host.workspaceLabel,
    ...(input.host.remoteSessionId ? { remoteSessionId: input.host.remoteSessionId } : {}),
    bundleDigest: input.snapshot.bundleDigest,
    createdAt,
    deadlineAt: createdAt + WORKSPACE_HOOK_REVIEW_TIMEOUT_MS,
    sourceFiles: input.snapshot.sourceFiles.map((source) => ({
      path: source.canonicalPath,
      displayPath: relative(source.baseDir, source.canonicalPath) || basename(source.canonicalPath),
      editable: source.editable,
    })),
    summary: {
      eventCount: new Set(items.map((item) => item.event)).size,
      hookCount: items.length,
      // 注意：pendingCount 是协议契约字段，shared 的
      // workspaceHookReviewRequestPayloadSchema 以「trustState ∈ {pending_trust,
      // revoked, stale_digest}」校验它，刻意不看 configuredEnabled——单边加过滤会
      // 直接违约。
      //
      // 未启用的 Hook 也可随当前不可变审核快照一并信任，因此这里不按
      // configuredEnabled 过滤；开关只控制运行，信任只控制准入。
      pendingCount: items.filter((item) =>
        ["pending_trust", "revoked", "stale_digest"].includes(item.trustState),
      ).length,
    },
    items,
    warningCode: "workspace_hooks_execute_code",
  };
}

/**
 * 把用户选中的 reviewItemId 映射成声明的 hook digest：先去重（同一项重复选择只算一次），
 * 未知 id 直接抛错——信任写入不能基于猜出来的摘要。返回顺序与首次出现顺序一致。
 */
export function resolveWorkspaceHookReviewDigests(
  snapshot: WorkspaceHookBundleSnapshot,
  reviewItemIds: readonly string[],
): string[] {
  const byId = new Map(snapshot.hooks.map((entry) => [entry.reviewItemId, entry] as const));
  return [...new Set(reviewItemIds)].map((reviewItemId) => {
    const entry = byId.get(reviewItemId);
    if (!entry) throw new Error(`Unknown Workspace Hook review item: ${reviewItemId}`);
    return entry.hookDeclarationDigest;
  });
}

/**
 * 抽取 core 侧关联键（session / task / run / workspace / bundle / flow / generation /
 * interaction），用于把后续 decision 与发起时的快照对齐；`remoteSessionId` 只在存在时带出。
 * 纯字段搬运，不含审核内容本身。
 */
export function toWorkspaceHookReviewTarget(
  request: WorkspaceHookReviewRequestPayload,
): WorkspaceHookReviewTarget {
  return {
    sessionId: request.sessionId,
    taskId: request.taskId,
    runId: request.runId,
    ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
    workspaceIdentity: request.workspaceIdentity,
    bundleDigest: request.bundleDigest,
    reviewFlowId: request.reviewFlowId,
    generation: request.generation,
    interactionId: request.interactionId,
  };
}
