/**
 * ============================================================================
 * hooks/workspace-hook-trust-types.ts —— 信任存储与快照评估的类型口径
 * ============================================================================
 *
 * 这两个类型是 coordinator 与运行期准入之间的稳定契约:
 * storeStatus 表达"持久记录是否可信",SnapshotEvaluation 表达一次评估的全量结论。
 * 独立成文件是为了让两边都只依赖契约,避免准入层反向导入 coordinator 实现（链路 9）。
 * ============================================================================
 */
import type {
  WorkspaceHookEffectiveState,
  WorkspaceHookPolicy,
  WorkspaceHookReasonCode,
  WorkspaceHookSecurityRevision,
} from "@zcode/contracts";

export type WorkspaceHookTrustStoreStatus = "missing" | "ok" | "corrupt";

export interface WorkspaceHookTrustStoreState {
  /** missing:尚未建立;ok:可读;corrupt:内容不可信,整份按未信任处理。 */
  status: WorkspaceHookTrustStoreStatus;
  /** 损坏时保留的原始文件路径:供诊断与人工恢复,不参与判定。 */
  recoveredCorruptPath?: string;
}

export interface WorkspaceHookSnapshotEvaluation {
  workspaceIdentity: string;
  bundleDigest: string;
  policy: WorkspaceHookPolicy;
  /** 评估时刻的安全修订号:上报/落库后据此判断该结论是否已过期（不变量 #10）。 */
  securityRevision: WorkspaceHookSecurityRevision;
  storeStatus: WorkspaceHookTrustStoreStatus;
  reasonCode?: WorkspaceHookReasonCode;
  /** 逐条结论(trustState + effectiveRunnable),准入与 UI 都只读这里。 */
  items: WorkspaceHookEffectiveState[];
}
