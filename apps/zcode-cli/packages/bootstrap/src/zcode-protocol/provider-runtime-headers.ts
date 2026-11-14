import { requestVerificationTimeoutMessage } from "@zcode/shared";
import { randomUUID } from "node:crypto";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeProviderRuntimeHeadersResponseSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeAppOptions } from "../app/types.js";
import {
  ProtocolRequestError,
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// 无应答方时 UI 的 SDK 超时不会启动；端口总时限同时覆盖排队与凭据解析。
const PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS = 180_000;
const CLIENT_REQUEST_TIMEOUT_CODE = -32022;

/**
 * 构造"模型请求前刷新 provider 运行时身份头"的端口（ZCodeAppOptions.providerRuntimeHeadersPort）。
 * 每次请求都经 interaction/requestProviderRuntimeHeaders 反向询问 host；agent 不持有凭据，
 * 只拿到 headersApplied 结果。失败语义：取消/超时（-32022）先向 host 发 cancelled 通知释放队列，
 * 再把超时转成面向用户的超时错误；headersApplied=false 用 host 的 errorMessage 或通用文案报 -32031。
 * 该端口在场即开启；缺席时 App 不进入这条刷新链路（普通 API Key 请求不走此处）。
 */
export function createProviderRuntimeHeadersPort(
  context: ZCodeProtocolAgentServerContext,
  workspace: ZCodeWorkspaceRef,
): NonNullable<ZCodeAppOptions["providerRuntimeHeadersPort"]> {
  return {
    shouldRefreshBeforeModelRequest() {
      // 恒 true：是否需要鉴权由绑定模型/账号决定，端口不能在此提前排除 Account 请求。
      // Account 请求由绑定 Model 决定是否进入鉴权，不能把所有账号收窄到旧 Start ID。
      // 普通 API 不进入此端口；Team/Individual 继续复用请求级鉴权合同。
      return true;
    },
    async refreshBeforeModelRequest(input) {
      const requestId = `${input.sessionId}:provider-runtime-headers:${randomUUID()}`;
      let result;
      try {
        result = await context.requestClient(
          zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders,
          {
            // 同一毫秒内的并发请求不能共用关联键，否则 pending 应答会覆盖或串用。
            requestId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            workspace,
            modelSelection: { providerId: input.providerId, modelId: input.modelId },
            providerId: input.providerId,
            ...(input.accountAccess ? { accountAccess: input.accountAccess } : {}),
            ...(input.expectedAccountScope
              ? { expectedAccountScope: input.expectedAccountScope }
              : {}),
            ...(input.rejectedProjectTokenFingerprint
              ? { rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint }
              : {}),
            reason: input.reason,
          },
          zcodeProviderRuntimeHeadersResponseSchema,
          {
            signal: input.abortSignal,
            trace: protocolTraceFromTraceContext(input.traceContext),
            timeoutMs: PROVIDER_RUNTIME_HEADERS_TIMEOUT_MS,
          },
        );
      } catch (error) {
        // requestClient abort 只清理 CLI 等待，Host 仍占着凭据解析队列直到超时。
        // 仅此端口发送取消，不改变其他反向 RPC 的生命周期。
        const timedOut =
          error instanceof ProtocolRequestError && error.code === CLIENT_REQUEST_TIMEOUT_CODE;
        // 总时限与主动停止都必须释放 Host；否则 CLI 已失败，旧请求仍会占用队列。
        if (input.abortSignal?.aborted || timedOut) {
          context.notify({
            method: zcodeProtocolNotifications.providerRuntimeHeadersCancelled,
            trace: protocolTraceFromTraceContext(input.traceContext),
            params: { workspace, sessionId: input.sessionId, requestId },
          });
        }
        if (timedOut) {
          const timeoutError = new ProtocolRequestError(
            CLIENT_REQUEST_TIMEOUT_CODE,
            requestVerificationTimeoutMessage,
            error.data,
          );
          timeoutError.cause = error;
          throw timeoutError;
        }
        throw error;
      }
      if (!result.headersApplied) {
        // runtime header 刷新失败可能来自配置读取失败或凭据缺失；
        // 不能统一改写成单一失败文案，否则会掩盖真实根因并误导重试策略。
        throw new ProtocolRequestError(
          -32031,
          result.errorMessage ??
            "Provider runtime headers were not applied before model request attempt.",
          {
            providerId: input.providerId,
            ...(input.rejectedProjectTokenFingerprint
              ? { rejectedProjectTokenFingerprint: input.rejectedProjectTokenFingerprint }
              : {}),
            reason: input.reason,
            workspaceKey: workspace.workspaceKey,
          },
        );
      }
      // zcode-plan 的账号鉴权材料是每次请求刷新的运行时配置，
      // 但 provider registry revision 是 workspace 级全局状态；并发刷新时后一个请求会推进全局 revision，
      // 不能再用全局 revision 不相等误判当前请求的 headers 未应用。
      return result;
    },
  };
}
