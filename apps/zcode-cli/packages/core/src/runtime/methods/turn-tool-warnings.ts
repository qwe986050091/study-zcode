/**
 * ============================================================================
 * turn-tool-warnings.ts —— 工具调用异常的告警注入与事件
 * ============================================================================
 * 定位：链路 2/3 的 anomaly guard，在一批 tool call 发出前评估预算与重复调用。
 * 输入/输出：输入 RegularTurnLoopState + 本批 ModelToolCall；输出 turnRequestEntries 与事件。
 * 关键不变量：告警只提示、不拦工具（长程任务不以调用次数硬停止）；warningInjected 只在
 *       首次跨阈值时注入，避免每批重复提醒；事件先 append 再入内存 state，保证两者一致。
 * ============================================================================
 */
import { SessionEventType } from "../deps.js";
import type { ModelToolCall, TraceContext } from "../deps.js";
import {
  buildRepeatedToolCallReminderBody,
  buildToolCallBudgetReminderBody,
  detectRepeatedToolCallWarnings,
  detectToolCallBudgetWarning,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { systemReminderAttachmentEntry, toModelToolCall } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

export async function handleToolCallAnomalyWarnings(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    modelTraceContext: TraceContext;
    toolCalls: ModelToolCall[];
  },
): Promise<void> {
  // 按累计计数 + 本批长度评估预算；guard 关闭或未超阈值时返回 undefined。
  const budgetWarning = detectToolCallBudgetWarning(
    state.toolCallCount,
    options.toolCalls.length,
    state,
    runtime.config.modelAnomalyGuard,
  );
  if (budgetWarning) {
    if (budgetWarning.warningInjected) {
      // 首次跨阈值才把 system reminder 提交进本轮请求；后续批次不再重复打扰模型。
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildToolCallBudgetReminderBody(budgetWarning.observedCount),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      // 无论是否注入都发事件：UI/遥测要看「观察到多少次」，与是否打扰模型是两个维度。
      SessionEventType.ModelAnomalyWarning,
      {
        category: "tool_call_budget",
        severity: "warning",
        observedCount: budgetWarning.observedCount,
        threshold: budgetWarning.threshold,
        warningInjected: budgetWarning.warningInjected,
      },
      options.modelTraceContext,
    );
    // 先持久化再 push：append 失败时不把内存 state 标记成「事件已发出」。
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    // 同步写入本轮 loop state，供后续请求/收尾读取同一份事件。
    state.events.push(warningEvent);
  }

  // 把本批 tool call 映射成统一形状后与历史比较，检测同名/同参的重复调用。
  const repeatedWarnings = detectRepeatedToolCallWarnings(
    options.toolCalls.map(toModelToolCall),
    state,
    runtime.config.modelAnomalyGuard,
  );
  for (const warning of repeatedWarnings) {
    // 每条新重复告警单独注入/发事件；warning 自带 toolName/toolCallId 便于定位。
    if (warning.warningInjected) {
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildRepeatedToolCallReminderBody(warning.toolName, warning.observedCount),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      // 重复调用同样先用 reminder 纠偏；仍然只告警，不阻止本批工具执行。
      SessionEventType.ModelAnomalyWarning,
      {
        category: "repeated_tool_call",
        severity: "warning",
        observedCount: warning.observedCount,
        threshold: warning.threshold,
        toolCallId: warning.toolCallId,
        toolName: warning.toolName,
        warningInjected: warning.warningInjected,
      },
      options.modelTraceContext,
    );
    // 与预算告警同一顺序：先持久化事件，再写入本轮 state，避免失败时内存与 store 不一致。
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    // state.events 是后续请求/收尾的读取面，必须在 append 成功后同步。
    state.events.push(warningEvent);
  }
}
