import { getUnavailableReplyFallback } from "#src/bots/groupReply.js";
import { setTimeout as sleep } from "node:timers/promises";
// bots/groupResultDelivery.ts — 群结果消息的落盘、鉴权、发送与有限重试。
//
// INV-01 发送前先落盘 unknown：进程中断后不能把“不确定是否已发”当成未发送，
//        否则重启会重复投递。
// INV-02 同一 id 只有一个 inFlight 操作；重复调用复用同一 Promise。
// INV-03 只有非 failed 的记录才会跳过；retry=true 允许重发 failed。
// INV-04 自动重试最多 2 次，退避 250ms..30s；只有明确 retryAfterMs 才重试。
// INV-05 只有 deliveryRejected + deliveryReplyUnavailable 才做引用降级，
//        普通失败不降级，避免吞掉真实错误。
// INV-06 project 只把 inFlight 记录投影成 pending，绝不改写恢复记录。
import type { BotGroupDelivery } from "@zcode/shared";

// 依赖注入：存储、鉴权、发送全部外部化，便于测试。
interface GroupDeliveryDependencies {
  read(id: string): Promise<BotGroupDelivery | undefined>;
  write(result: BotGroupDelivery): Promise<void>;
  authorized(result: BotGroupDelivery): Promise<boolean>;
  send(result: BotGroupDelivery): Promise<void | { providerMessageId: string }>;
  onSettled?(): Promise<void>;
  delay?(milliseconds: number): Promise<void>;
}

/** 只保存和发送已生成结果；不持有任务执行或输入队列。 */
export function createGroupResultDelivery(deps: GroupDeliveryDependencies) {
  // id → 正在进行的投递；finally 中删除。
  const inFlight = new Map<string, Promise<void>>();
  // 幂等入口：同一 id 正在发送时直接返回既有 Promise。
  const deliver = (result: BotGroupDelivery, retry = false): Promise<void> => {
    const existing = inFlight.get(result.id);
    if (existing) return existing;
    // 整个发送流程在一个异步闭包里，finally 统一清理。
    const operation = (async () => {
      // 以 `deps.read` 的落盘记录为准；`result` 只在首次发送时兜底。
      const saved = await deps.read(result.id);
      const current = saved ?? result;
      // 已 sent/unknown/invalidated 的都不重发（见 INV-03）。
      if (saved && (saved.status !== "failed" || !retry)) return;
      let attemptResult = current;
      let retries = 0;
      for (;;) {
        // 每次尝试前重新鉴权；授权失效直接判 invalidated。
        if (!(await deps.authorized(attemptResult))) {
          await deps.write({ ...attemptResult, status: "invalidated", updatedAt: Date.now() });
          return;
        }
        // 请求前落盘 unknown，进程中断后不得把不确定结果当作未发送。
        // 先落 unknown 再发送（见 INV-01）。
        await deps.write({ ...attemptResult, status: "unknown", updatedAt: Date.now() });
        try {
          // 发送成功才写 sent，并清理 lastError。
          const sent = await deps.send(attemptResult);
          await deps.write({
            ...attemptResult,
            ...(sent ? { providerMessageId: sent.providerMessageId } : {}),
            status: "sent",
            lastError: undefined,
            updatedAt: Date.now(),
          });
          return;
        } catch (error) {
          const details = error as {
            deliveryRejected?: boolean;
            deliveryReplyUnavailable?: boolean;
            retryAfterMs?: number;
          } | null;
          // 只有明确拒绝才进入失败/降级分支。
          const rejected = details?.deliveryRejected === true;
          await deps.write({
            ...attemptResult,
            status: rejected ? "failed" : "unknown",
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: Date.now(),
          });
          // 只有明确拒绝才降级；普通群去掉引用，话题最多退到根锚点，群目标仍由闭包固定。
          // `deliveryReplyUnavailable` 为真时走降级：普通群去引用，话题退到根锚点。
          if (rejected && details?.deliveryReplyUnavailable) {
            const fallback = getUnavailableReplyFallback(attemptResult);
            // 无可用降级时保持 failed，由上层提示。
            if (fallback) {
              attemptResult = { ...attemptResult, ...fallback };
              continue;
            }
          }
          if (
            // 限流重试要求服务端给出 retryAfterMs（见 INV-04）。
            rejected &&
            typeof details?.retryAfterMs === "number" &&
            Number.isFinite(details.retryAfterMs) &&
            retries < 2
          ) {
            // 计数只在真正等待重试时递增。
            retries += 1;
            // 退避 = retryAfterMs * 次数，并钳在 250ms..30s。
            await (deps.delay ?? sleep)(
              Math.max(250, Math.min(30_000, details.retryAfterMs * retries)),
            );
            continue;
          }
          return;
        }
      }
    })().finally(async () => {
      // 先释放槽位再触发 onSettled，避免回调里重入被误判为在途。
      inFlight.delete(result.id);
      await deps.onSettled?.();
    });
    inFlight.set(result.id, operation);
    return operation;
  };
  return Object.assign(deliver, {
    isInFlight: (id: string) => inFlight.has(id),
    // Bug 原因：崩溃恢复用的 unknown 曾直接触发 UI 告警；活跃发送只投影 pending，不能改写恢复记录。
    // 只读投影；不写库（见 INV-06）。
    project: (result: BotGroupDelivery): BotGroupDelivery =>
      inFlight.has(result.id) ? { ...result, status: "pending" } : result,
  });
}
