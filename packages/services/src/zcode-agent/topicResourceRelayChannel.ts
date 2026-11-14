import { channelReplyHostRequestSchema } from "@zcode/shared";
import type { IServerChannel, CancellationToken } from "@zcode/rpc";
import {
  zcodeTopicResourceRelayRequestSchema,
  zcodeTopicResourceRelayKeySchema,
} from "@zcode/shared";
import {
  createTopicResourceRelay,
  type TopicResourceRelayDependencies,
} from "./topicResourceRelay.js";

/** 只注册在已鉴权远程连接的反向 server 上，不暴露在 Renderer/手机 service collection。 */
export function createTopicResourceRelayChannel(deps: TopicResourceRelayDependencies) {
  const relay = createTopicResourceRelay(deps);
// [资源] 鉴权请求与传输分开限流：鉴权同样可能阻塞，
// 单独登记才能被 dispose 一次性打断。
  const validations = new Set<AbortController>();
// 销毁标志一经置位就不再回调外部依赖，所有入口都先检查它。
  let disposed = false;
  const channel: IServerChannel = {
    async call<T>(
      _context: string,
      command: string,
      value?: unknown,
      token?: CancellationToken,
    ): Promise<T> {
// [失败路径] 连接已关或调用方已取消，直接拒绝，不再进入命令分发。
      if (disposed || token?.isCancellationRequested)
        throw new Error("Topic resource connection closed");
// reply 是宿主回执通道，未注入时明确报错而不是静默丢弃。
      if (command === "reply") {
        if (!deps.reply) throw new Error("Channel reply unavailable");
        return (await deps.reply(channelReplyHostRequestSchema.parse(value))) as T;
      }
// validate 走独立分支：它需要自己的限流、超时与取消桥接。
      if (command === "validate") {
        const request = zcodeTopicResourceRelayRequestSchema.parse(value);
// 与传输一样最多两条并发：鉴权通常很快，超过说明对端行为异常。
        if (validations.size >= 2) throw new Error("Topic resource validation busy");
        const controller = new AbortController();
        validations.add(controller);
// [并发] RPC 取消与本地超时都收敛到同一个 AbortController，
// 下游只需要处理一种取消信号。
        const subscription = token?.onCancellationRequested(() => controller.abort());
// 120s 上限与传输超时保持一致，避免鉴权把连接挂死。
        const timer = setTimeout(() => controller.abort(), 120_000);
        try {
// 真正执行鉴权，成功后由上层统一包装成 valid 结果；
// 异常直接冒泡，调用方只会看到失败而不会拿到模糊的布尔值。
          await deps.validate(request, controller.signal);
          controller.signal.throwIfAborted();
// 返回结构固定为 valid，不把依赖实现的具体返回值透出去。
          return { valid: true } as T;
        } finally {
          clearTimeout(timer);
          subscription?.dispose();
          validations.delete(controller);
        }
      }
// 白名单之外一律拒绝：反向通道只暴露这四个传输动作。
      if (!["begin", "chunk", "finish", "cancel"].includes(command))
        throw new Error("Unsupported topic resource operation");
// 这里只做键提取，完整校验仍交给 relay 内部的 schema，避免两处规则漂移。
      const request = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
// 取消桥接需要最小键，先归一化再登记：非法入参不会污染 relay 状态。
      const key = zcodeTopicResourceRelayKeySchema.parse({
        requestId: request.requestId,
        taskId: request.taskId,
      });
// [并发] 取消只作用于本条传输，不影响同连接上的另一条；
// 传输结束时必须 dispose 订阅，否则 token 会持有闭包导致泄漏。
      const subscription = token?.onCancellationRequested(() => {
        relay.cancel(key);
      });
      try {
        if (command === "begin") return (await relay.begin(value)) as T;
        if (command === "chunk") return (await relay.chunk(value)) as T;
        if (command === "finish") return (await relay.finish(value)) as T;
        return { cancelled: relay.cancel(value) } as T;
      } finally {
        subscription?.dispose();
      }
    },
// 该通道只有请求-响应语义，没有事件流，显式拒绝避免调用方误解。
    listen() {
      throw new Error("Topic resource events are unavailable");
    },
  };
// 返回通道与销毁函数：调用方必须先 dispose 再丢弃引用，否则传输状态不会释放。
  return {
// channel 是唯一对外暴露的调用面，内部 relay 不直接可见。
    channel,
// [资源] 销毁顺序：先停止接受新调用，再释放 relay，最后打断鉴权。
    dispose() {
      disposed = true;
      relay.dispose();
// 进行中的鉴权必须被打断，否则它们仍持有连接与依赖引用。
      for (const controller of validations) controller.abort();
      validations.clear();
    },
  };
}
