import {
  SessionEventType,
  getCurrentModelInvocationContext,
  type Model,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
} from "@zcode/contracts";
import { withModelInvocationContext } from "../../runtime/methods/runtime-model.js";
import type { ToolExecutionContext } from "../types.js";

/**
 * 工具内部模型请求的默认状态出口。
 *
 * `statusSink` 不能是每个调用点各自的职责——WebSearch 记得设，WebFetch 处理没有。
 * 没有 sink 的请求照样过准入闸门、照样排队，但 runner 发的 queued / admitted / 429 事件没有去处：
 * 执行器的 deadline 不知道该暂停（实测 18 次 WebFetch 在队里等了 20–45 s 后按
 * 60 s 超时被取消，错误里 `queuedMs: 0`），driver 也看不见这个子代理在等。
 * 与准入端口同一处置：默认值绑在**边界**上而不是靠调用点记得——执行器交给 handler 的
 * `context.model` 先套一层，调用点没设 sink 时补上会话事件出口；调用点自己设了则原样保留。
 *
 * 维护不变量：补默认 sink 只能发生在 `withDefaultToolModelStatusSink` 边界处；本函数只把
 * `statusEvent` 包成一条 SessionEvent，不做节流/去重（由 sink 消费者自行决定）。
 */
export function createToolModelStatusSink(
  context: Pick<ToolExecutionContext, "emitEvent" | "sessionId" | "turnId" | "traceId">,
): ModelStatusSink | undefined {
  // 没有事件出口就不造 sink：返回 undefined 让调用方看到"无状态出口"，
  // 比给一个静默吞事件的假出口更诚实。
  if (!context.emitEvent) return undefined;

  return {
    publish: async (statusEvent: ModelNetworkStatusEvent) => {
      await context.emitEvent?.({
        id: crypto.randomUUID() as never,
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ModelNetworkStatus,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: statusEvent,
      });
    },
  };
}

/** 调用点未设 `statusSink` 时补默认出口；设了的保留（默认值不压调用层）。 */
/**
 * 给工具内部模型请求补默认 `statusSink`：只在调用点**没有**设置时注入，已设置的保留。
 *
 * 为什么必须在这里补：sink 不是每个调用点的职责（WebSearch 记得设、WebFetch 漏设）；
 * 缺 sink 的请求照样过准入与排队，但 queued/admitted/429 事件没有去处，执行器 deadline
 * 不知道该暂停、driver 也看不见子请求在等。
 *
 * 入参 `model` 或 `sink` 任一为 undefined 时原样返回（没有可补的位置）。实现用 invocation
 * context 的 patch 求值：已有 sink 时返回空 patch，绝不覆盖调用层。
 */
export function withDefaultToolModelStatusSink(
  model: Model | undefined,
  sink: ModelStatusSink | undefined,
): Model | undefined {
  if (model === undefined || sink === undefined) return model;
  return withModelInvocationContext(model, () =>
    // 已有 sink 时给空 patch：默认值只补缺，不覆盖调用层设置。
    getCurrentModelInvocationContext()?.statusSink === undefined ? { statusSink: sink } : {},
  );
}
