// ============================================================
// Workflow Submit Port - actor terminal-result verdict boundary
// ============================================================
//
// 【定位】actor（子代理）用 `submit_result` 交还**结构化终态结果**，引擎校验后给一个裁决：
// 接受则 turn 应当终止，拒绝则把违规列表当作同一会话内的修复输入。它与
// `WorkflowEscalatePort` 刻意分开：submit 的对端是引擎裁决，escalate 的对端是主代理作答。
//
// 【请求-响应关联】关联键是**端口 closure 绑定的 (run, actor, instance)**，不是模型可写的
// id：同一 actor 的 submit 天然串行，引擎侧不需要再开一个查询表。取消不由本端口表达——中止
// tool call（abort）即由 driver 转成带外的 ask 取消，因此响应可能以 abort 而非 verdict 结束。
//
// 【持久性】裁决本身不落 journal；落库的是引擎在 ask 结算时写下的结果与状态，所以冷恢复只
// 需要 journal，不需要回放端口。

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

/**
 * 【契约坐标】结构逐字段对齐 dynamic-workflow 合成侧的 `Violation`，由 driver 原样映射——
 * contracts 不反向依赖 dynamic-workflow。`path` 是 JSON 路径（`$` / `$.foo` /
 * `$.items[0]`），`expected` / `got` 是给人看的短描述而不是 schema 原文。生产者：引擎的结果
 * 校验器；消费者：`SubmitRejected` 的 tool_result（模型据此在同一 actor 会话内修复重试）。
 *
 * 校验器产出的单条违规，设计成可直接进入修复用的 tool_result：一行一条，包含
 * JSON 路径、期望（expected）与实得（got）。
 *
 * 结构与 dynamic-workflow 合成侧的 Violation 一致；driver 负责把引擎
 * 的 Violation 原样映射到本端口，contracts 不反向依赖 dynamic-workflow。
 */
export interface SubmitViolation {
  /** 违规所在位置的 JSON 路径，形如 `$`、`$.foo`、`$.items[0]`。 */
  path: string;
  /** 期望的形状/取值的简短描述。 */
  expected: string;
  /** 实际取到的值的简短描述。 */
  got: string;
}

/**
 * 【契约坐标】`result` 是**未经校验的任意 JSON**：端口故意不在请求类型上收紧形状，校验是引擎
 * 的职责（`SubmitViolation` 才是放弃后的产物）。`toolCallId` 是 actor 子会话内的调用 id，
 * 用于审计与日志，不是路由键——路由身份由端口 closure 绑定。生产者：actor 的
 * `submit_result` 工具 handler；消费者：引擎的 `respond` 校验路径。
 */
export interface SubmitResultRequest {
  /** 发起 submit_result 调用的 actor 子会话内的 tool call id。 */
  toolCallId: ToolCallId | string;
  /** 模型提交的原始结构化结果（未经本端口校验的任意 JSON）。 */
  result: unknown;
  trace: TraceContext;
}

/**
 * 【契约坐标】`accept: true` 是**终止信号**而非提示：driver 收到它后结束 actor turn，引擎在
 * ask 结算时落库结果。没有额外字段是刻意的——判定成功时除了「可以停了」没有别的信息要传，
 * 任何附加 payload 都会诱使调用方在端口之外再造一份结果副本。生产者：引擎校验器；消费者：
 * actor 的 tool_result 与 turn 收尾。
 */
/** 引擎接受本次提交：actor turn 应当在结果返回后终止。 */
export interface SubmitAccepted {
  accept: true;
}

/**
 * 【契约坐标】`accept: false` 后 actor turn **不结束**：违规列表作为同一条 tool_result 回给
 * 模型，修复发生在本会话内，不新建 ask、不重置预算。`violations` 是只读、可为空（模型交了个
 * 完全不符形状的结果时校验器仍应给出一条 `$` 层面的违规，空数组意味着「拒绝但无具体项」）。
 * 生产者：引擎校验器；消费者：actor 的 tool_result。
 */
/** 引擎拒绝本次提交：返回违规列表供模型在同一会话内修复重试。 */
export interface SubmitRejected {
  accept: false;
  violations: readonly SubmitViolation[];
}

/**
 * 【契约坐标】判别式二选一，`accept` 字面量就是判别键：调用方据此决定「结束 turn」还是
 * 「把 violations 当修复输入」。没有第三种形态——超时与取消不在这里表达（它们以 abort
 * 结束 `respond`），所以裁决只可能是引擎真实给出的两种之一。
 */
export type SubmitVerdict = SubmitAccepted | SubmitRejected;

/**
 * 【契约坐标】**阻塞**等待引擎裁决：引擎可能在带外跑多轮修复 / 预算判定，resolve 可能耗时
 * 任意长，端口刻意不设超时（超时会被模型读成「可以硬交」，重新引入本特性要消灭的绕过）。
 * 取消只经 tool call 的 abort，由 driver 把带外的 ask 取消转成 turn abort。生产者：actor
 * 子会话的 driver；消费者：引擎的 `respond` 校验路径与 actor 的 turn 收尾。
 */
export interface WorkflowSubmitPort {
  /**
   * 提交 actor 的结构化终态结果并等待引擎裁决。
   *
   * 与 CoordinatorResponsePort 不同，这里 **阻塞** 直到引擎完成校验：引擎可能在带外
   * 跑多轮修复/预算判定，因此 resolve 可能耗时任意长。取消不由本端口表达——由中止
   * 该 tool call（abort）来处理，driver 会把带外的 ask 取消转成 turn abort。
   *
   * 路由身份（instance/actor/session）由端口 closure 绑定，模型无法覆盖。
   */
  respond(request: SubmitResultRequest): Promise<SubmitVerdict>;
}
