// Host 消息入口的 MessagePort 守卫。
//
// 职责：在解析跨进程消息时保证被 transfer 的 MessagePort 不会被泄漏：schema 校验失败或
// 服务尚未就绪时，端口不会再被任何 ChannelServer 接管，必须就地 close。
// 输入输出：parseHostIncomingMessageEvent 返回共享 schema 的 safeParse 结果（成功保留 ports）；
// rejectUnavailableAttachedServicePort 返回是否已拒绝并关闭。
// 副作用：关闭传入的 port（best-effort）。
// 失败语义：close 抛错被吞掉，不能遮蔽原始 schema / 初始化错误。
// 维护的不变量：失败路径必须关闭全部 transferred ports；成功路径绝不能提前 close，
// 端口所有权随消息交给下游 ChannelServer。

import { hostIncomingMessageSchema } from "@zcode/shared";

export interface CloseableTransferredPort {
  close(): void;
}

export interface HostIncomingMessageEventLike {
  data: unknown;
  ports: readonly CloseableTransferredPort[];
}

// 关闭单个 port；undefined 与异常都安全忽略。
// 用于所有「消息不会被接管」的失败路径，避免 EventPort 泄漏后远端调用永久 pending。
function closeTransferredPort(port: CloseableTransferredPort | undefined): void {
  try {
    port?.close();
  } catch {
    // rejection cleanup 是 best effort；close 异常不能遮蔽原始 schema/初始化错误。
  }
}

// 解析 Host 入站消息；失败时关闭随消息 transfer 的所有 port。
// 返回值刻意标注为 schema 的 safeParse 返回类型，避免 .d.ts 引用 @zcode/shared 私有
// node_modules 中的 ZodSafeParseResult（clean pnpm install 下不可移植）。
// 失败语义：不抛出；失败信息在 result.success=false 中返回。
/** schema invalid 时 transferred port 不会再被任何 ChannelServer 接管，必须就地关闭。 */
export function parseHostIncomingMessageEvent(
  event: HostIncomingMessageEventLike,
): ReturnType<typeof hostIncomingMessageSchema.safeParse> {
  // clean pnpm install 下 zod 会位于 @zcode/shared 私有 node_modules；导出函数若
  // 依赖推断返回型，.d.ts 会引用不可移植的私有 ZodSafeParseResult 路径。
  const result = hostIncomingMessageSchema.safeParse(event.data);
  if (!result.success) {
    for (const port of event.ports) closeTransferredPort(port);
  }
  return result;
}

// services 未就绪时拒绝 AttachServicePort：关闭端口并返回 true 表示已拒绝。
// 必须主动 close，否则对端会一直等一个永不到来的 attach ack（RPC 永久 pending）。
// 就绪时返回 false 且不动端口，所有权继续交给正常 attach 流程。
/** AttachServicePort 早于 activeServices 就绪时拒绝并关闭，避免远端 RPC 永久 pending。 */
export function rejectUnavailableAttachedServicePort(
  port: CloseableTransferredPort,
  servicesReady: boolean,
): boolean {
  if (servicesReady) return false;
  closeTransferredPort(port);
  return true;
}
