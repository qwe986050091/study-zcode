// 子 Agent 事件谓词模块：识别转发到主会话流的子会话工具镜像事件，并判定哪些事件会改变子 Agent 目录。
// 边界：只做纯判断，不投影 transcript、不触发请求、不读写任何状态。
// 口径：工具镜像以 payload.source === "subagent" 标记；目录只随生命周期/轮次级事件变化，逐 token 流不触发。
// 失败语义：payload 缺失或非对象时按"非镜像"处理，未知事件类型不改变目录。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";

// 子 Agent 工具事件镜像集合：这些事件可能由子会话转发到主会话流中，用于判断是否需要过滤。
const TOOL_EVENTS = new Set<string>([
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallProgress,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
]);

// 判断事件是否为子 Agent 工具调用的镜像：类型属于工具事件，且 payload.source === "subagent"。
// 这类事件不属于主会话 transcript，主视图与目录刷新都应忽略（payload 为 null 时按非镜像处理）。
// 返回 true 表示应跳过，false 表示该事件可以正常参与主会话投影。
export function isSubagentToolMirror(event: SessionEvent): boolean {
  return (
    TOOL_EVENTS.has(event.type) &&
    (event.payload as Record<string, unknown> | null)?.source === "subagent"
  );
}

/** Directory refreshes follow lifecycle boundaries, never individual tokens. */
// 目录刷新判定：过滤掉子 Agent 工具镜像后，只有生命周期/轮次/权限类事件才会改变目录内容。
// 逐 token 的流式事件不在集合内，因此不会触发高频刷新。
// 调用方据该返回值决定是否重新读取目录快照；返回 false 时不应发起请求。
export function changesSubagentDirectory(event: SessionEvent): boolean {
  // 工具调用结果只有在主会话内发生时才可能改变目录（例如主会话派发了新的子任务）。
  return !isSubagentToolMirror(event) && DIRECTORY_EVENTS.has(event.type);
}

// 会改变子 Agent 目录的事件集合：子会话创建/停止、后台任务状态、轮次起止/错误、
// 权限请求与恢复会话。目录是"会话结构"的投影，不随流式内容变化。
const DIRECTORY_EVENTS = new Set<string>([
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentStopped,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  SessionEventType.ToolCallResult,
  SessionEventType.TurnStarted,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.SessionResumed,
]);
