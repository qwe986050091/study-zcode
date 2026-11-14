import type { ModelUsage } from "@zcode/contracts";
import { formatTaskNotification } from "../runtime-task/notification.js";

// 本地 subagent 任务的终态：正常完成 / 异常失败 / 被取消或中止。
// 只有 failed 会携带 error 文案进入通知摘要；completed/stopped 忽略 error 字段。
export type LocalAgentTaskNotificationStatus =
  | "completed"
  | "failed"
  | "stopped";

// 组装一条 subagent 完成通知所需的全部事实，来自 runtime task 注册表的终态记录。
export interface LocalAgentTaskNotificationInput {
  // 子 agent 实例 id，同时用作通知 taskId，保证父子任务可关联。
  agentId: string;
  // 子 agent 类型名（如 Explore / general-purpose），用于通知前缀与类型展示。
  agentType: string;
  // 调用方给出的任务描述，进入通知摘要，必须非空。
  description: string;
  // 仅 status 为 failed 时有意义；空串或纯空白时视为无失败原因。
  error?: string;
  // 子 agent 输出文件路径（绝对路径），供父 agent 按需读取完整结果。
  outputFile: string;
  // 触发该子 agent 的父级工具调用 id，用于把通知挂回原 tool call。
  parentToolCallId: string;
  // 终态结果文本；可能为空（如失败前无输出），由调用方决定是否展示。
  result?: string;
  // 任务终态，决定摘要动词与是否拼接 error。
  status: LocalAgentTaskNotificationStatus;
  // 端到端耗时（毫秒），undefined 表示未采集。
  totalDurationMs?: number;
  // 累计 token 数（输入+输出口径由上游统计），undefined 表示未采集。
  totalTokens?: number;
  // 工具调用次数，undefined 表示未采集。
  totalToolUseCount?: number;
  // 结构化模型用量，用于渲染分模型明细；undefined 时通知只显示汇总值。
  usage?: ModelUsage;
}

// 把本地 subagent 终态映射为统一的 runtime task 通知文本（纯字符串拼装）。
// 输入为完整终态事实；输出为可直接进入父会话上下文的 Markdown 文本。
// 副作用：无 IO、无事件、无日志，仅调用纯格式化函数，便于测试与重放。
// 口径转换：agentType→subagentType，agentId→taskId，parentToolCallId→toolUseId，
// taskType 固定为 local_agent；usage 中的空字段原样透传，由格式化层决定省略。
export function formatLocalAgentTaskNotification(
  input: LocalAgentTaskNotificationInput,
): string {
  return formatTaskNotification({
    agentId: input.agentId,
    description: input.description,
    error: input.error,
    outputFile: input.outputFile,
    result: input.result,
    status: input.status,
    subagentType: input.agentType,
    summary: formatLocalAgentNotificationSummary(input),
    taskId: input.agentId,
    taskType: "local_agent",
    toolUseId: input.parentToolCallId,
    usage: {
      durationMs: input.totalDurationMs,
      modelUsage: input.usage,
      toolUseCount: input.totalToolUseCount,
      totalTokens: input.totalTokens,
    },
  });
}

// 生成通知摘要行：固定为 `Agent <type> task "<desc>" <status>.`。
// 失败时在保留原前缀的前提下追加失败原因，避免与 <error> 段文案不一致。
// 只在 failed 且 error 去空白后非空时追加；其余状态不引入 error，语义保持稳定。
function formatLocalAgentNotificationSummary(
  input: Pick<
    LocalAgentTaskNotificationInput,
    "agentType" | "description" | "error" | "status"
  >,
): string {
  const summary = `Agent ${input.agentType} task "${input.description}" ${input.status}.`;
  const error =
    input.status === "failed" && input.error?.trim() ? input.error : undefined;
  // 修复原因：失败 summary 是 Agent 卡“子智能体输出”的来源，必须保留原前缀并
  // 直接追加与 <error> 相同的失败原因；completed/stopped 文案保持不变。
  return error ? `${summary} ${error}` : summary;
}
