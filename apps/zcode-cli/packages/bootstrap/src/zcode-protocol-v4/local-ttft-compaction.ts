import {
  SessionEventType,
  type SessionEvent,
  type CompactLifecyclePayload,
} from "@zcode/contracts";
import { LOCAL_TTFT_MAX_DETAILS, type LocalTtftFacts } from "@zcode/shared";

/**
 * 把 Compact 生命周期事件记进本次输入的 detail 列表（stage = "compaction"）。
 *
 * 输入：待补全的 LocalTtftFacts、SessionEvent、当前单调时钟 now。
 * 输出：true 表示该事件与本记录相关（调用方据此 checkpoint）；false 表示无关，保持原样。
 * 口径：只接受与记录同一 turnId 且首输出尚未发生的事件；同一 operationId 的 started/completed/failed
 * 合并成一条明细，terminated 状态归一到 completed/failed/cancelled（interrupted）。
 * 失败/降级：detail 数量超上限时置 truncated 并停止新增；now < start 视为时钟回拨，
 * 置 clockInvalid 而不写入负时长。无 IO、无广播副作用，只改传入记录。
 */
/** Compact 的实际生命周期可以与 main attempt 交错，不能由主请求差额推算。 */
export function observeLocalTtftCompaction(
  record: LocalTtftFacts,
  event: SessionEvent,
  now: number,
): boolean {
  if (record.turnId !== event.turnId || record.outputAt !== undefined) return false;
  if (
    event.type !== SessionEventType.CompactStarted &&
    event.type !== SessionEventType.CompactCompleted &&
    event.type !== SessionEventType.CompactFailed
  )
    return false;
  const payload = event.payload as CompactLifecyclePayload;
  const details = (record.details ??= []);
  const id = `compact:${payload.operationId}`;
  let detail = details.find((item) => item.id === id);
  if (!detail && event.type === SessionEventType.CompactStarted) {
    if (details.length >= LOCAL_TTFT_MAX_DETAILS) {
      record.truncated = true;
      return true;
    }
    detail = { id, stage: "compaction", start: now, source: "cli" };
    details.push(detail);
  }
  if (detail && event.type !== SessionEventType.CompactStarted && detail.end === undefined) {
    if (now < detail.start) {
      record.clockInvalid = true;
      return true;
    }
    detail.end = now;
    detail.outcome =
      payload.status === "interrupted"
        ? "cancelled"
        : event.type === SessionEventType.CompactCompleted
          ? "completed"
          : "failed";
  }
  return true;
}
