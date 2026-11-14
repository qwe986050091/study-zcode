// Bash / MCP 工具进度投影的纯函数出口。
//
// 这里只覆盖「已在运行」的工具行增量：进度与输出预览都是对既有行的修饰，
// 不创建新行、不把终态或后台任务重新点亮。所有 delta 仍由调用方
// （ProductProjection.applyEventInternal）放进同一个投影事务并统一绑定 revision。
import {
  executionOutputPreviewSchema,
  type ConversationDelta,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SessionEventType,
  type SessionEvent,
  type ToolCallProgressPayload,
  type ToolCallStartedPayload,
} from "@zcode/contracts";

/**
 * 把一次工具活动事件投影成对既有 ToolCallRow 的增量。
 *
 * 输入：SessionEvent（ToolCallStarted / ToolCallProgress）与按 toolCallId 找到的行。
 * 输出：row.upserted 序列；行不存在时返回空数组（不补建行）。
 * 边界：只有 running 且未 backgrounded 的 Bash 行接受输出预览；终态、后台任务
 * 迟到进度一律丢弃，避免状态回退。ToolCallStarted 会把行从 inputStreaming/
 * pendingApproval 推进到 running，并只补 mcp_tool 展示元信息。
 * 副作用：无，纯函数；调用方负责 revision 与 snapshot 提交。
 */
/** 进度只能更新已运行的 Bash，不创建行、不把终态或后台任务复活。 */
export function projectToolActivity(
  event: SessionEvent,
  row: ToolCallRow | undefined,
): ConversationDelta[] {
  if (!row) return [];
  if (event.type === SessionEventType.ToolCallStarted) {
    const payload = event.payload as ToolCallStartedPayload;
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          status: "running",
          startedAt: event.timestamp.getTime(),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
    ];
  }
  if (row.toolName !== "Bash" || row.status !== "running" || row.backgrounded) return [];
  const parsed = executionOutputPreviewSchema.safeParse(
    (event.payload as ToolCallProgressPayload).outputPreview,
  );
  if (!parsed.success) return [];
  return [{ op: "row.upserted", row: { ...row, outputPreview: parsed.data } }];
}

/**
 * 在同一投影事务里剥掉已不再运行的 tool row 的 outputPreview。
 *
 * 触发面：tool result/error、Stop、转后台、turn 收口等所有收口路径统一调用，
 * 保证终态行不会残留“仍在输出”的视觉。仍 running 且未 backgrounded 的行保留预览。
 * 只改写 row.upserted / row.appended 且 kind=toolCall 的 delta，其余原样透传；
 * 返回新数组，不修改入参。纯函数，不负责 revision/seq 记账。
 */
/** 统一在投影事务中清掉预览，涵盖 result/error、Stop、转后台与轮次收口。 */
export function clearSettledOutputPreviews(deltas: ConversationDelta[]): ConversationDelta[] {
  return deltas.map((delta) => {
    if (
      (delta.op !== "row.upserted" && delta.op !== "row.appended") ||
      delta.row.kind !== "toolCall" ||
      !delta.row.outputPreview ||
      (delta.row.status === "running" && !delta.row.backgrounded)
    )
      return delta;
    const { outputPreview: _preview, ...row } = delta.row;
    return { ...delta, row };
  });
}
