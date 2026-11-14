import { channelReplyResultSchema } from "@zcode/shared";
import { randomUUID } from "node:crypto";
import type { TopicResourcePort } from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeTopicResourceReadResultSchema,
  zcodeTopicResourceCancelResultSchema,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// topic 资源读取可能跨回合，给 2 分钟；reply 用较短的 60s。
const RESOURCE_TIMEOUT_MS = 120_000;

/**
 * 构造 topic 资源的反向请求端口（由 ZCodeApp 的 session runtime 调用）。
 * reply：直接转发给 Host 的 channelReply；read：生成 requestId 并在 abort 时尽力发 cancel，
 * 读取与取消共用一个 trace，超时/断连错误原样冒泡。取消失败被吞掉（不能从 abort listener 终止 CLI）。
 * 端口不缓存结果、不做重试；调用方用 signal 控制生命周期。
 */
export function createProtocolTopicResourcePort(
  context: ZCodeProtocolAgentServerContext,
): TopicResourcePort {
  return {
    async reply(request, options) {
      options.signal.throwIfAborted();
      return context.requestClient(
        zcodeProtocolMethods.channelReply,
        request,
        channelReplyResultSchema,
        {
          signal: options.signal,
          trace: options.trace ? protocolTraceFromTraceContext(options.trace) : undefined,
          timeoutMs: 60_000,
        },
      );
    },
    async read(request, options) {
      options.signal.throwIfAborted();
      const requestId = randomUUID();
      // 原因：Core trace 含 sessionId 等额外字段，原样发送会让 Host 严格校验失败并断开整个 CLI。
      const trace = options.trace ? protocolTraceFromTraceContext(options.trace) : undefined;
      const cancel = async () => {
        try {
          await context.requestClient(
            zcodeProtocolMethods.topicResourceCancel,
            { requestId, taskId: request.taskId },
            zcodeTopicResourceCancelResultSchema,
            { timeoutMs: RESOURCE_TIMEOUT_MS, trace },
          );
        } catch {
          // 原因：断连时 requestClient 会同步抛错，不能从 abort listener 冒泡并终止 CLI。
          // 取消是尽力通知；原读取请求仍保留取消／断连错误，不重连或重新执行。
        }
      };
      options.signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await context.requestClient(
          zcodeProtocolMethods.topicResourceRead,
          { ...request, requestId },
          zcodeTopicResourceReadResultSchema,
          { signal: options.signal, trace, timeoutMs: RESOURCE_TIMEOUT_MS },
        );
        options.signal.throwIfAborted();
        return result;
      } finally {
        options.signal.removeEventListener("abort", cancel);
      }
    },
  };
}
