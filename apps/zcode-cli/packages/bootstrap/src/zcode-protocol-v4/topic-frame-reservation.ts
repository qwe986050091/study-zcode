import type { TopicFrameDeliveryKind } from "@zcode/shared/zcode-protocol-v4";

// 所有权：reservation 只由 publisher 的 reserveFrame 创建并同时写入 subscription.inFlight；
// 调用方拿到后必须在“physical emit 全部成功”时 commit，或在失败时调用配套 rollback。
// 泄漏防护：同一 subscription 同时只有一个 inFlight；新的 reservation 会把旧的置为
// 失配，旧句柄再 commit 因身份不匹配返回 false（既不推进水位，也不会重复发送）。
// 水位语义：commit 成功才把 sentSeq 推进到 frame.toSeq；未 commit 的帧视为未送达，
// 后续 recovery 仍从客户端上报的 base 重放，绝不按服务端 sentSeq 猜测。
/** publisher 水位的两阶段提交句柄。 */
export interface TopicFrameReservation<F> {
  /** 由 publisher admission 权威赋值，物理分片与 consumer 不得按时序猜测。 */
  readonly deliveryKind: TopicFrameDeliveryKind;
  // 逻辑帧 id：由 subscriptionId 与自增 serial 组成，跨物理分片保持不变，便于关联诊断。
  readonly logicalFrameId: string;
  /** 同一 subscription 内单调递增；用于拒绝 PersistentProtocol 旧帧 replay。 */
  readonly logicalFrameOrdinal: number;
  // 已编码好的完整帧体；commit 前不得对外宣告已送达。
  readonly frame: F;
  // 幂等：同一句柄重复 commit 返回 true（仅首次真正推进水位）；被 supersede/退订后返回 false。
  /** 只有当前 subscription generation 仍有效时推进水位。 */
  commit(): boolean;
}
