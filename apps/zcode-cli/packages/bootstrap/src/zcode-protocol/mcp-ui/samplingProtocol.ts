import {
  zcodeMcpUiSamplingParamsSchema,
  zcodeMcpUiCancelSamplingParamsSchema,
} from "@zcode/shared";
import { mcpAppsSamplingResultSchema } from "@zcode/shared/mcp-apps";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "../server-types.js";
import { mcpUiInstances } from "./instances.js";
import { McpUiSamplingCalls } from "./samplingCalls.js";

// 进程级唯一账本：终态与并发额度跨请求共享，不能按会话或请求新建，否则取消/重放语义失效。
const calls = new McpUiSamplingCalls();
/**
 * mcp/uiSampling：页面请求模型采样。校验凭证与 server 归属后才进入账本；执行前后都重新 validate，
 * 防止在采样期间实例被关闭/换页后仍回传结果。成功结果按 mcpAppsSamplingResultSchema 校验，
 * 结构不符即抛错（不把畸形结果交给页面）。取消/超时统一映射为 -32000。
 */
export async function sampleMcpUi(context: ZCodeProtocolAgentServerContext, raw: unknown) {
  const params = parseParams(zcodeMcpUiSamplingParamsSchema, raw);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiSampling" });
  const validate = () =>
    mcpUiInstances.validate(
      params.instance,
      params,
      record.app.getMcpAppConnectionSnapshot(params.serverName),
    );
  const active = validate();
  return calls.execute(
    { token: params.instance.token, sessionId: params.sessionId, signal: active.cancel.signal },
    params.operationId,
    async (signal) => {
      const pin = mcpUiInstances.retain(params.instance.token, params.operationId);
      const release = () => pin.release();
      signal.addEventListener("abort", release, { once: true });
      try {
        signal.throwIfAborted();
        validate();
        const result = await record.app.sampleModel(
          {
            request: params.request,
            source: {
              pluginId: params.pluginId,
              serverName: params.serverName,
              appIdentity: params.instance.appIdentity,
            },
          },
          { abortSignal: signal, traceContext: record.traceContext },
        );
        signal.throwIfAborted();
        validate();
        return mcpAppsSamplingResultSchema.parse(result);
      } finally {
        signal.removeEventListener("abort", release);
        release();
      }
    },
  );
}
/**
 * mcp/uiCancelSampling：取消指定 operationId。与 sample 一样先验凭证归属，再交给账本；
 * 取消先于请求到达时也会留下终态，之后同 id 的请求不会执行。
 */
export function cancelMcpUiSampling(context: ZCodeProtocolAgentServerContext, raw: unknown) {
  const params = parseParams(zcodeMcpUiCancelSamplingParamsSchema, raw);
  const record = requireSession(context, params.sessionId, { operation: "mcp/uiCancelSampling" });
  const active = mcpUiInstances.validate(
    params.instance,
    params,
    record.app.getMcpAppConnectionSnapshot(params.serverName),
  );
  return calls.cancel(
    { token: params.instance.token, sessionId: params.sessionId, signal: active.cancel.signal },
    params.operationId,
  );
}
