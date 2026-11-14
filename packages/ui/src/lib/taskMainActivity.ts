// INV-01 空批次视为主活动：守住位置 长度判断；改错故障 首帧没有运行指示。
// INV-02 用户消息必定激活：守住位置 类型判断；改错故障 发送后界面仍显示空闲。
// INV-03 其余操作递归判定：守住位置 逐条检查；改错故障 批量事件漏判主活动。
// INV-04 运行开始与目标迭代激活：守住位置 分支合并；改错故障 新回合不显示运行中。
// INV-05 文本块要求非空且属主代理：守住位置 双条件；改错故障 子代理输出点亮主会话。
// INV-06 工具调用只看归属：守住位置 归属判断；改错故障 子代理工具误报主活动。
// INV-07 未知事件一律不激活：守住位置 默认分支；改错故障 新事件类型误触发。
// INV-08 父工具标识存在即非主代理：守住位置 空值判断；改错故障 嵌套调用被当成主链路。
// INV-09 子代理来源标记同样排除：守住位置 原始字段检查；改错故障 转发的子代理事件误导。
// INV-10 前台流式消息要求助手角色：守住位置 角色判断；改错故障 用户草稿被当成流式。
// INV-11 时间线占位消息不算前台流式：守住位置 取反判断；改错故障 空壳消息让指示常亮。
// INV-12 时间线消息要求内容全空：守住位置 三段取反；改错故障 有内容的合成消息被忽略。
// INV-13 前台活动汇总两条来源：守住位置 或运算；改错故障 仅有时间线时显示空闲。
// INV-14 运行中状态限定三种：守住位置 相等比较；改错故障 空闲状态被当成忙碌。
// INV-15 创建与恢复阶段直接算忙碌：守住位置 早退分支；改错故障 准备阶段可重复提交。
// INV-16 提交中直接算忙碌：守住位置 状态比较；改错故障 连点产生两次提交。
// INV-17 显式前台活动优先于主活动：守住位置 判断顺序；改错故障 有活动却仍显示空闲。
// INV-18 主活动还需活跃输入或运行中：守住位置 合并条件；改错故障 空闲会话常年显示运行。
//
// 模块职责：判定任务流事件与消息是否构成主会话前台活动。
// 状态所有权：无状态；全部为只读判定函数。
// 阅读顺序：先看事件判定，再看消息判定，最后看综合忙碌条件。
import type { ZCodeStreamEvent, ZCodeTaskRuntimeStatus } from "@zcode/shared";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";
import { hasRunningZCodeTimeline } from "@/lib/zcodeTimelineRuntime.js";

type TaskStreamMirrorBatchEvent = Extract<ZCodeStreamEvent, { type: "task_stream_mirror_batch" }>;
type TaskStreamMirrorOp = TaskStreamMirrorBatchEvent["ops"][number];

export function shouldMarkMainActiveFromStreamMirrorOps(
  ops: readonly TaskStreamMirrorOp[],
): boolean {
  if (ops.length === 0) {
    return true;
  }
  return ops.some((op) => {
    if (op.kind === "user_message") {
      return true;
    }
    return shouldMarkMainActiveFromStreamEvent(op.event);
  });
}

// task_run_started 与 goal_iteration_started 两个 type 算激活。
// agent_message_chunk 与 agent_thought_chunk 要求 event.content 非空。
// tool_call 与 tool_call_update 只认 isMainAgentStreamEvent 为真。
// default 分支一律返回 false，不激活。
export function shouldMarkMainActiveFromStreamEvent(event: ZCodeStreamEvent): boolean {
  switch (event.type) {
    case "task_run_started":
    case "goal_iteration_started":
      return true;
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return event.content.length > 0 && isMainAgentStreamEvent(event);
    case "tool_call":
    case "tool_call_update":
      return isMainAgentStreamEvent(event);
    default:
      return false;
  }
}

// message.role 必须是 "assistant"。
// message.streaming 必须为 true。
// isTaskChatTimelineMessage 为真的占位消息不算。
export function hasForegroundStreamingAssistantMessage(
  messages: readonly TaskChatMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.streaming === true &&
      !isTaskChatTimelineMessage(message),
  );
}

function isTaskChatTimelineMessage(message: TaskChatMessage): boolean {
  if (!message.syntheticTimeline && !message.uiTimeline) return false;
  return !(
    message.content.trim() ||
    message.thought?.trim() ||
    (message.toolCalls && message.toolCalls.length > 0)
  );
}

function isTaskRuntimeBusy(taskStatus: ZCodeTaskRuntimeStatus): boolean {
  return taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming";
}

export function hasForegroundActivityFromMessages(messages: readonly TaskChatMessage[]): boolean {
  return hasForegroundStreamingAssistantMessage(messages) || hasRunningZCodeTimeline(messages);
}

// creating 与 restoring 阶段直接判忙碌。
// streaming 状态同样算忙碌。
// 最后再合并 hasForegroundActivityFromMessages 与运行态判定。
export function isMainActivityRuntimeBusy(params: {
  currentStatus?: "idle" | "submitting" | "streaming" | "error";
  runtimeState?: {
    activeInputId?: unknown;
    status: ZCodeTaskRuntimeStatus;
  } | null;
  isMainActive: boolean;
  hasForegroundActivity?: boolean;
}): boolean {
  const runtimeStatus = params.runtimeState?.status;
  const setupBusy = runtimeStatus === "creating" || runtimeStatus === "restoring";
  if (setupBusy) {
    return true;
  }
  if (params.currentStatus === "submitting") {
    return true;
  }
  if (params.hasForegroundActivity === true) {
    return true;
  }
  return (
    params.isMainActive &&
    (Boolean(params.runtimeState?.activeInputId) ||
      (runtimeStatus != null && isTaskRuntimeBusy(runtimeStatus)))
  );
}

function isMainAgentStreamEvent(
  event: Extract<
    ZCodeStreamEvent,
    { type: "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" }
  >,
): boolean {
  if (event.parentToolUseId != null) {
    return false;
  }
  return !("raw" in event && isSubagentToolRaw(event.raw));
}

function isSubagentToolRaw(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "source" in raw &&
    (raw as { source?: unknown }).source === "subagent"
  );
}
