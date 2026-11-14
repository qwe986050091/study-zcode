// ============================================================
// Workflow Escalate Port - actor 向主代理升级阻塞问题的边界
// ============================================================
// 与 {@link WorkflowSubmitPort} 完全同构且刻意分开：
// submit 结算的是**这次 ask 的结果**（引擎裁决），escalate 结算的是**一次问答**（主代理作答），
// 两者的对端、生命周期与失败形态都不同，合并成一个端口只会让两条时序互相解释不清。

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

/**
 * 【契约坐标】生产者：actor 子会话执行 `escalate` 时的 driver 包装（路由身份 run / actor /
 * session / instance 由端口 closure 绑定，模型改不了）；消费者：bootstrap 的升级注册表与
 * `ResolveWorkflowQuestion` 的停驻表。`toolCallId` 是**子会话内**的调用 id，只用于审计与
 * 并发去重，不是跨会话路由键；`question` / `context` 是模型可写的唯一内容，端口不做改写。
 */
export interface EscalateQuestionRequest {
  /** 发起 `escalate` 调用的 actor 子会话内的 tool call id。 */
  toolCallId: ToolCallId | string;
  /** 阻塞点本身：一个聚焦的、可用一句话回答的问题。 */
  question: string;
  /** 可选的补充上下文（actor 已经试过什么、卡在哪一行）。 */
  context?: string;
  trace: TraceContext;
}

/**
 * 【契约坐标】请求-响应按 **qid 关联**：端口在停驻时铸一个全局唯一的 `dwfq-<runId 片段>-<seq>`，
 * 主代理经 `ResolveWorkflowQuestion` 带同一个 id 作答；qid 只供日志与人类追溯，模型不需要读。
 * 两支都是普通 tool_result（不是抛错），因为错误会被模型当作可重试故障并反复撞墙。
 * `budget_exhausted` 是 per-ask 的升级次数上限；`no_active_ask` 表示本会话此刻没有在飞
 * ask、问题无处停驻——两种拒绝都零副作用，不写 journal。
 *
 * 一次升级的结局。**两支都是普通的工具结果**，不是错误：预算耗尽时返回
 * 「自行推进」的正常结果，而不是抛错（错误会让模型把它当成可重试的故障，反复撞同一堵墙）。
 *
 * 用判别式而不是纯文本，是因为调用方（core 的工具处理器）要据此决定渲染成什么样的
 * tool_result（house rule：错误码而非错误文本做流程判断）。
 */
export type WorkflowEscalateOutcome =
  | {
      kind: "answered";
      /** 主代理经 `ResolveWorkflowQuestion` 给出的答案文本，原样成为工具结果。 */
      answer: string;
      /** 本次问答的全局唯一 id（供日志与人类追溯；模型不需要读它）。 */
      qid: string;
    }
  | {
      kind: "refused";
      /**
       * `budget_exhausted`：本次 ask 的升级次数已用尽（per-ask 上限，与 nudge 预算同族）。
       * `no_active_ask`：本会话此刻没有在飞的 ask，问题无处停驻（不应发生，但绝不悬挂）。
       */
      reason: "budget_exhausted" | "no_active_ask";
      /** 面向模型的文案，陈述现状与下一步。 */
      message: string;
    };

/**
 * 【契约坐标】唯一方法在**端口层不设超时**：resolve 可能等任意长，超时后「自行判断」正是本
 * 特性要消灭的投机绕过。逃生舱是取消——driver 的 `cancelAsk` 会把停驻中的升级 deferred 一并
 * 拒绝，行为与进程亡故一致。生产者：actor 子会话的 driver；消费者：core 的
 * `ResolveWorkflowQuestion` handler（主代理作答）与 bootstrap 的升级注册表。停驻表是内存的，
 * 进程亡故后未作答的升级随 run 一起消失，不做持久恢复。
 */
export interface WorkflowEscalatePort {
  /**
   * 升级一个阻塞问题并**阻塞**等待主代理作答。
   *
   * 与 {@link WorkflowSubmitPort.respond} 同一条纪律：resolve 可能耗时任意长（按设计不设
   * 超时——「超时后自行判断」恰恰重新引入本特性要消灭的投机绕过）。逃生舱是既有的取消：
   * driver 的 `cancelAsk` 会连同停驻中的升级 deferred 一起拒绝，于是 run cancel 与进程亡故
   * 的行为与今天完全一致。
   *
   * 路由身份（run/actor/session/instance）由端口 closure 绑定，模型无法覆盖。
   */
  escalate(request: EscalateQuestionRequest): Promise<WorkflowEscalateOutcome>;
}
