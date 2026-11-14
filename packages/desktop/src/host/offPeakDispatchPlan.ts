// 闲时（off-peak）任务派发的形态判定与可派发性断言。
//
// 职责：根据请求里是否已有 conversationId / sessionId，决定这次派发是续跑、绑定会话首跑
// 还是新建会话；并提供绑定会话失败分类，供调度器区分「永久失败」与「退避重试」。
// 输入输出：输入只读请求信息，输出 OffPeakDispatchKind；断言函数无输出（失败即抛）。
// 副作用：无（纯判定，不写会话 mode、不发消息）。
// 失败语义：绑定会话已删除 → permanent（重试无意义）；会话忙 → 可重试；两类错误都必须在
// 写入 session mode 之前抛出（setMode 不校验活跃 turn，先写会污染用户会话权限）。

import { OffPeakPermanentDispatchError } from "@zcode/services/node";

/**
 * 闲时派发三分支：
 * - resume：conversation_id 已回填 = 已跑过，续跑同一 session 并发续跑提示词；
 * - bound-first-run：会话内创建绑定了 session_id 但尚未跑过，resume 绑定会话并发任务原 prompt
 *   （对齐 dispatchCronRun 的 targetTaskId 路径）；
 * - init：表单创建，新建专属 session。
 */
export type OffPeakDispatchKind = "resume" | "bound-first-run" | "init";

// 判定闲时派发形态：有 conversationId = 已跑过（resume），仅有 sessionId = 绑定但未跑过
//（bound-first-run），两者都无 = 表单新建（init）。
// 用 trim 后的非空判断而非真值判断，避免调度器传入空白字符串时误判为 resume。
// 分支顺序有意为 resume 优先：conversation_id 是「已经执行过」的更强证据。
export function resolveOffPeakDispatchKind(request: {
  conversationId?: string;
  sessionId?: string;
}): OffPeakDispatchKind {
  if (request.conversationId?.trim()) return "resume";
  if (request.sessionId?.trim()) return "bound-first-run";
  return "init";
}

// 绑定会话已被用户删除：属于永久失败。
// 继承 OffPeakPermanentDispatchError 让调度器停止退避；否则会一直重试到票过期再重新取号，
// 白白占用并发额度。sessionId 保留在错误对象上，便于日志定位。
/** 绑定会话已被用户删除：重试无意义，permanent（否则会一直退避到票过期再重取号）。 */
export class OffPeakBoundSessionDeletedError extends OffPeakPermanentDispatchError {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session was deleted: ${sessionId}`);
    this.name = "OffPeakBoundSessionDeletedError";
  }
}

/**
 * 绑定会话正在跑用户 turn：transient，交给调度器退避重试。
 * 必须在写入会话 mode 之前抛出——CLI 的 session/send 会以 -32010 拒绝，
 * 但 setMode 没有活跃 turn 检查，先写配置再撞忙会把用户会话悄悄切成任务的权限模式。
 */
export class OffPeakBoundSessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session is busy: ${sessionId}`);
    this.name = "OffPeakBoundSessionBusyError";
  }
}

// 派发前可派发性断言：先判删除（永久）再判忙（可重试）。
// 顺序不可交换：已删除的会话当然也不会 running，但必须报 permanent 才不会被无限退避。
// 失败语义：抛出上述两类错误；调用方必须在任何 session 写入之前调用本函数。
export function assertBoundSessionDispatchable(params: {
  sessionId: string;
  deleted: boolean;
  running: boolean;
}): void {
  if (params.deleted) throw new OffPeakBoundSessionDeletedError(params.sessionId);
  if (params.running) throw new OffPeakBoundSessionBusyError(params.sessionId);
}
