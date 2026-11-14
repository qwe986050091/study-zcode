/**
 * ============================================================================
 * hooks/workspace-hook-telemetry.ts —— 工作区 Hook 信任链路的观测出口
 * ============================================================================
 *
 * 统一经 Logger Port 输出:事件名是封闭联合,字段只允许稳定 reason、generation、
 * 各类摘要与短错误消息;命令、脚本内容、source path 与 Trust payload 一律不出现。
 *
 * workspace identity 实际是绝对路径,必须先哈希成短摘要再发送（不变量 #19 的隐私侧）;
 * 新增可观测事件必须先进 WorkspaceHookTelemetryEvent,否则调用侧无法编译（链路 9）。
 * ============================================================================
 */
import { createHash } from "node:crypto";
import type { Logger, WorkspaceHookReasonCode } from "@zcode/contracts";

export type WorkspaceHookTelemetryEvent =
  | "workspace_hook.feature_disabled"
  | "workspace_hook.review_request_created"
  | "workspace_hook.trust_selected"
  | "workspace_hook.review_timeout"
  | "workspace_hook.review_superseded"
  | "workspace_hook.snapshot_mismatch"
  | "workspace_hook.policy_blocked"
  | "workspace_hook.trust_store_failure"
  | "workspace_hook.toggle_failure"
  | "workspace_hook.config_rebuild_failure"
  // revoke 需要专门观测：排查「撤销后面板失效」时，必须能从日志判断
  // 撤销是否成功、并区分随后的失败属于撤销还是授权，否则定位缓慢。
  | "workspace_hook.revoked"
  | "workspace_hook.stale_response";

export interface WorkspaceHookTelemetryFields {
  /** 只用于本地日志关联;落盘前会被哈希,不会以明文路径出现。 */
  workspaceIdentity?: string;
  bundleDigest?: string;
  declarationDigest?: string;
  reasonCode?: WorkspaceHookReasonCode;
  source?: string;
  action?: string;
  generation?: number;
  /**
   * 调用侧传入的 errorMessage 需要透传：否则原始错误在 emit 时被静默丢弃，
   * 日志里只剩 reasonCode，实际排查无法定位真实 cause。
   * 仅承载领域错误自身的短消息，不携带命令、脚本内容或 Trust payload。
   */
  errorMessage?: string;
  /**
   * Trust 落盘条数诊断：store 写入少于已选择声明时，decisionAccepted
   * 未抛错），日志无从判断是 request 少带了 item 还是写入阶段丢了记录。
   *
   * requestItemCount / requestEnabledCount 记录审核请求实际携带的条数；
   * grantedRecordCount 记录本次真正写入的条数。三者对不上即为静默丢失。
   */
  requestItemCount?: number;
  requestEnabledCount?: number;
  grantedRecordCount?: number;
  /** revoke 实际撤销的声明条数（与 grantedRecordCount 分开，避免语义混用）。 */
  revokedCount?: number;
}

// 错误消息截断上限:领域消息可能夹带长路径或脚本片段,进日志前必须限长。
const MAX_TELEMETRY_ERROR_MESSAGE_LENGTH = 300;

/**
 * Workspace Hook 的观测统一复用现有 Logger Port。
 * 只发送稳定 reason、generation 和摘要，不发送命令、脚本内容、路径或 Trust payload。
 */
export function emitWorkspaceHookTelemetry(
  logger: Logger | undefined,
  event: WorkspaceHookTelemetryEvent,
  fields: WorkspaceHookTelemetryFields = {},
): void {
  // 没有 logger 直接返回:遥测是尽力而为,不能因为缺观测通道影响信任判定本身。
  if (!logger) return;
  // 统一用 info:信任结论属于低频、可审计的生命周期事件,不是高频 debug 数据。
  logger.info("Workspace Hook Trust telemetry", {
    event,
    module: "workspace_hook_trust",
    // identity 是绝对路径,只发哈希摘要;明文路径不得进入日志。
    ...(fields.workspaceIdentity
      ? { workspaceIdentityDigest: workspaceIdentitySummary(fields.workspaceIdentity) }
      : {}),
    // digest 只发短摘要:完整 bundle/declaration 摘要足以指纹化整个仓库内容。
    ...(fields.bundleDigest ? { bundleDigest: digestSummary(fields.bundleDigest) } : {}),
    ...(fields.declarationDigest
      ? { declarationDigest: digestSummary(fields.declarationDigest) }
      : {}),
    ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.action ? { action: fields.action } : {}),
    // 用显式 undefined 判断而不是 ||:generation 为 0 是合法代际,不能被当成缺省。
    ...(fields.generation === undefined ? {} : { generation: fields.generation }),
    // 短消息截断:只保留可定位的因由,不带完整命令或脚本内容。
    ...(fields.errorMessage
      ? { errorMessage: fields.errorMessage.slice(0, MAX_TELEMETRY_ERROR_MESSAGE_LENGTH) }
      : {}),
    // 三个计数并列输出:请求条数与实际写入条数可直接比对,才看得出静默丢失。
    ...(fields.requestItemCount === undefined ? {} : { requestItemCount: fields.requestItemCount }),
    ...(fields.requestEnabledCount === undefined
      ? {}
      : { requestEnabledCount: fields.requestEnabledCount }),
    ...(fields.grantedRecordCount === undefined
      ? {}
      : { grantedRecordCount: fields.grantedRecordCount }),
    ...(fields.revokedCount === undefined ? {} : { revokedCount: fields.revokedCount }),
  });
}

export function digestSummary(value: string): string {
  // 只保留前 12 字符:足够做日志关联,又不足以还原原值。
  return value.length <= 12 ? value : value.slice(0, 12);
}

/**
 * workspace identity 的 SHA-256 短摘要。
 *
 * 本实现的 identity 就是绝对路径，明文要求 telemetry 不上传
 * 完整 workspace path、不记录 source path，因此任何要进入 telemetry 的文本
 * （含领域错误的 message）都必须先经此脱敏，而不是依赖下游过滤。
 */
export function workspaceIdentitySummary(value: string): string {
  // 先 SHA-256 再截断:哈希不可逆,截断只影响碰撞概率,不改变脱敏目标。
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
