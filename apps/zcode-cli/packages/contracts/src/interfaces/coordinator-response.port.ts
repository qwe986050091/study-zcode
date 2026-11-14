import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

/**
 * 【契约坐标】`childToolCallId` 是**子会话内**的调用 id，随消息带回父队列用于追溯；
 * `summary` / `message` 是给主代理（coordinator）的两段文本。子会话、agent、父会话与父
 * tool call 的完整路由身份由端口 closure 绑定，模型无法覆盖——因此本请求里没有 parent /
 * agent 字段。生产者：core 的 `respond_to_coordinator` 工具 handler；消费者：父 runtime 的
 * 消息队列。
 */
export interface CoordinatorResponseRequest {
  childToolCallId: ToolCallId | string;
  summary: string;
  message: string;
  trace: TraceContext;
}

/**
 * 【契约坐标】`responseId` 是**入队关联键**（实现体铸 `response_<uuid>`，也可注入生成器供
 * 测试）；它只用于父队列内的追溯，不是跨进程的持久 id。`status: "success"` 表示已同步入队，
 * 不表示主代理已读到；`failed` 时 `error` 携带入队失败原因，此时消息**没有**进入父队列。
 * 两条路都返回同一个 responseId，便于日志把「尝试」与「结果」对上。生产者：core 的
 * `createCoordinatorResponsePort`；消费者：子代理的 tool_result。
 */
export interface CoordinatorResponseResult {
  status: "success" | "failed";
  responseId: string;
  message: string;
  error?: string;
}

/**
 * 【契约坐标】刻意是**同步**返回而不是 Promise：入队必须先于子代理的 tool result 完成，
 * 否则子代理会先报告「已回复」而消息仍在父队列之外，顺序颠倒。与
 * {@link WorkflowSubmitPort.respond} 的阻塞语义不同——这里不等主代理处理，只保证入队；
 * 与 `WorkflowEscalatePort` 更不同——那里等待人类/主代理作答，这里只是一条单向消息。
 * 生产者：子代理 runtime 的工具面；消费者：父 runtime 的命令队列。
 */
export interface CoordinatorResponsePort {
  // child session/agent/parent identity 由 port closure 绑定，模型不能覆盖路由。
  // 同步返回确保 response command 入父队列后，child tool result 才能完成。
  respond(request: CoordinatorResponseRequest): CoordinatorResponseResult;
}
