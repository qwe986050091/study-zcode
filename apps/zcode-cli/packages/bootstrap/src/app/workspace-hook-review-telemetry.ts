import type { Logger, WorkspaceHookReasonCode } from "@zcode/contracts";
import {
  emitWorkspaceHookTelemetry,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Workspace Hook 审核链路的遥测出口：把每个关键节点映射成固定的 `workspace_hook.*` 事件。
 *
 * 每次 emit 都从 admission 取**当前** workspaceIdentity（不信任调用方传入的路径），再合并
 * 调用方字段；不发命令正文 / 绝对路径 / 凭据。事件选择是语义契约：被 superseded 的响应记
 * stale_response，其他拒绝记 snapshot_mismatch；toggle 失败按错误 code 分三路，避免把写前
 * 失败误记成 config_rebuild_failure。所有方法都只写日志、不抛错、不改变审核状态。
 */
export class WorkspaceHookReviewTelemetry {
  constructor(
    private readonly admission: WorkspaceHookRuntimeAdmissionPort,
    private readonly logger?: Logger,
  ) {}

  requestCreated(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_request_created", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      // Trust 落盘条数诊断：记录 request 与实际 grant 数，识别静默丢失。
      requestItemCount: request.items.length,
      requestEnabledCount: request.items.filter((item) => item.configuredEnabled).length,
    });
  }

  timeout(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_timeout", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      reasonCode: "workspace_hooks_interaction_timeout",
    });
  }

  responseRejected(target: WorkspaceHookReviewTarget, reasonCode: WorkspaceHookReasonCode): void {
    this.emit(
      reasonCode === "workspace_hooks_review_superseded"
        ? "workspace_hook.stale_response"
        : "workspace_hook.snapshot_mismatch",
      { bundleDigest: target.bundleDigest, reasonCode },
    );
  }

  decisionAccepted(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
    counts?: { grantedRecordCount?: number; requestEnabledCount?: number },
  ): void {
    this.emit("workspace_hook.trust_selected", {
      action: decision.action,
      bundleDigest: target.bundleDigest,
      generation: target.generation,
      // 与 requestEnabledCount 对不上即为静默丢失：decisionAccepted 只在 applyDecision
      // 成功后发出，因此「已接受却少写」无法从既有字段看出。
      ...(counts?.grantedRecordCount === undefined
        ? {}
        : { grantedRecordCount: counts.grantedRecordCount }),
      ...(counts?.requestEnabledCount === undefined
        ? {}
        : { requestEnabledCount: counts.requestEnabledCount }),
    });
  }

  /**
   * revoke 观测：撤销是否成功、撤了几条都需要可见，否则排障时无从判断。
   */
  revoked(bundleDigest: string, revokedCount: number): void {
    this.emit("workspace_hook.revoked", {
      bundleDigest,
      reasonCode: "workspace_hooks_revoked",
      revokedCount,
    });
  }

  trustStoreFailure(bundleDigest: string, errorMessage?: string): void {
    this.emit("workspace_hook.trust_store_failure", {
      bundleDigest,
      reasonCode: "workspace_hooks_trust_store_corrupt",
      // applyDecision 可因非存储原因抛错（resolveWorkspaceHookReviewDigests
      // 对未知 reviewItemId、coordinator 内部错误等）。若全部失败一律报成
      // trust_store_corrupt 且丢弃 cause，日志只剩 reasonCode，排查无从定位真实原因。
      // reasonCode 保持不变（新增需 contracts 枚举评审），errorMessage 用于回溯真实原因。
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  toggleFailure(
    bundleDigest: string,
    reasonCode: WorkspaceHookReasonCode,
    errorMessage?: string,
  ): void {
    this.emit(
      // toggle 失败按 WorkspaceHookMutationError.code 透传，reasonCode 覆盖 write/rebuild
      // 之外的情况：mismatch 走专属事件，其余未归类失败记为 toggle_failure，
      // 避免把写前失败误记成 config_rebuild_failure（错误归属倒错）。
      reasonCode === "workspace_hooks_snapshot_mismatch"
        ? "workspace_hook.snapshot_mismatch"
        : reasonCode === "workspace_hooks_config_rebuild_failed"
          ? "workspace_hook.config_rebuild_failure"
          : "workspace_hook.toggle_failure",
      { bundleDigest, reasonCode, ...(errorMessage ? { errorMessage } : {}) },
    );
  }

  superseded(request: WorkspaceHookReviewRequestPayload): void {
    this.emit("workspace_hook.review_superseded", {
      bundleDigest: request.bundleDigest,
      generation: request.generation,
      reasonCode: "workspace_hooks_review_superseded",
    });
  }

  private emit(
    event: Parameters<typeof emitWorkspaceHookTelemetry>[1],
    fields: Parameters<typeof emitWorkspaceHookTelemetry>[2],
  ): void {
    emitWorkspaceHookTelemetry(this.logger, event, {
      workspaceIdentity: this.admission.getCurrentSnapshot().workspaceIdentity,
      ...fields,
    });
  }
}
