/**
 * ============================================================================
 * zcode-protocol-v4/queue-auto-drain.ts —— 普通队列的自动提升闸门
 * ============================================================================
 *
 * 【定位】V4 队列只有在"空闲且没有被 goal 阻塞"时才允许自动把队首提升为
 * 正式输入。这个判断被 gateway 与 queue 自动消费路径共用，必须是唯一入口。
 *
 * 【四个条件全部满足才提升】
 *   - autoDrain 开启；
 *   - 队首 dispatchState 是 queued（reserved/promoting 表示已经被别的路径拿走）；
 *   - session 不忙（没有 active turn）；
 *   - target 为 null 或 complete。
 *
 * 【fail-open 不在这里开旁路】verifier 自身失败时会先把 target 持久化为
 * complete，再走这里；如果在这里放宽 target 条件，等于给"未验证完成"的 goal
 * 开第二种例外，会产生两条不一致的提升路径。
 * ============================================================================
 */
import type { GoalStatus } from "@zcode/contracts";

/**
 * 纯判定：普通 V4 队列队首此刻是否允许被自动提升为正式输入。
 *
 * 输入口径：autoDrain = 投影 queue.autoDrain；dispatchState = 队首 dispatch.state，
 * 只有 "queued" 才算"还没被任何路径拿走"（reserved/promoting 说明已有提升在途，
 * 再判一次会产生第二条提升路径）；sessionBusy = 是否存在 active turn；targetStatus =
 * goal 状态，null 表示本会话没有 goal。
 *
 * 输出：四条件全真才 true，调用方据此执行提升；本函数无副作用、不写 durable、
 * 不发事件，也不负责失败降级（目标状态不可达时一律 false，即"不提升"）。
 * 不变量：这里是自动消费的唯一闸门；verifier 的 fail-open 必须先持久化 complete，
 * 不得在此放宽 target 条件，否则会出现两套不一致的提升语义。
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
}): boolean {
  // 顺序不改变结果，但先便宜的布尔量、再 target 语义；整体是"全部满足"而非优先级。
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    !input.sessionBusy &&
    (input.targetStatus === null || input.targetStatus === "complete")
  );
}
