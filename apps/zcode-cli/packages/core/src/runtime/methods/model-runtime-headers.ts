/**
 * ============================================================================
 * model-runtime-headers.ts —— "每次模型 attempt 前刷新运行时请求头"
 * ============================================================================
 *
 * Start Plan 的账号鉴权材料按请求刷新：adapter 内部重试、WebSearch/native tool
 * 请求、标题/compact 等独立模型请求，都必须在每个真实 attempt 发送前重新获取；
 * 复用进入 adapter 前的旧材料会导致鉴权过期。
 *
 * 【触发点】回调被 Model 包装层在每次 generate/stream 前调用，
 *   attempt 级重试由 adapter 内部再次调用，因此这里的"每次 attempt"不是估算。
 *
 * 【返回 undefined】provider 不需要刷新（或不支持）→ 调用方直接发请求，
 *   不产生额外开销。
 *
 * 【刷新失败必抛】headersApplied=false 时抛错而不是继续：宁可不发请求，
 *   也不能带过期鉴权材料发出（否则会把鉴权失败伪装成模型错误）。
 *
 * 【child runtime 身份】子 runtime 的端口由父 runtime 派生，sessionId 会被
 *   改写成客户端认识的根会话；这里仍传 runtime.sessionId，由端口侧做映射。
 * ============================================================================
 */
import type { RequestVerificationReason } from "@zcode/shared";
import { traceContextToLogContext } from "../deps.js";
import type { ModelRequestAuth } from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { Model, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 构造一个"attempt 前刷新请求头"的回调;provider 不需要刷新时返回 undefined。 */
export function createRefreshRuntimeHeadersBeforeModelAttempt(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    model: Model;
    traceContext: TraceContext;
  },
):
  | ((attemptInput: {
      accountAccess?: ZCodeProviderAccountAccess;
      expectedAccountScope?: string;
      rejectedProjectTokenFingerprint?: string;
      attempt: number;
      reason?: RequestVerificationReason;
      abortSignal?: AbortSignal;
    }) => Promise<{
      headersApplied: boolean;
      requestAuth?: ModelRequestAuth;
    }>)
  | undefined {
  const runtimeHeadersPort = runtime.providerRuntimeHeadersPort;
  if (
    !runtimeHeadersPort ||
    !(
      runtimeHeadersPort.shouldRefreshBeforeModelRequest?.({
        providerId: String(input.model.providerId),
        modelId: String(input.model.modelId),
      }) ?? true
    )
  ) {
    return undefined;
  }

  return async (attemptInput) => {
    // Start Plan 的账号鉴权材料按请求刷新，adapter 内部 retry、WebSearch/native tool
    // 请求和标题/compact 等单独模型请求都必须在每个真实请求 attempt 发送前刷新，
    // 不能复用进入 adapter 前的旧材料。
    // 路由身份：主 runtime 报自己的会话；child runtime 拿到的端口由父 runtime 派生
    // （helpers/child-client-ports.ts），把 sessionId 改写成客户端认识的根会话。
    const refreshResult = await runtimeHeadersPort.refreshBeforeModelRequest({
      accountAccess: attemptInput.accountAccess,
      expectedAccountScope: attemptInput.expectedAccountScope,
      rejectedProjectTokenFingerprint: attemptInput.rejectedProjectTokenFingerprint,
      abortSignal: attemptInput.abortSignal ?? input.abortSignal,
      modelId: String(input.model.modelId),
      providerId: String(input.model.providerId),
      reason: attemptInput.reason ?? "model-request",
      sessionId: runtime.sessionId,
      traceContext: input.traceContext,
      turnId: input.traceContext.turnId,
    });
    if (!refreshResult.headersApplied) {
      throw new Error("Provider runtime headers were not applied before model request attempt.");
    }
    runtime.logger?.debug("Provider runtime headers refreshed before model request attempt", {
      ...traceContextToLogContext(input.traceContext),
      attempt: attemptInput.attempt,
      event: "model.request.runtime_headers_refreshed",
      headersApplied: refreshResult.headersApplied,
      module: "core.runtime",
      providerId: String(input.model.providerId),
    });
    return refreshResult;
  };
}
