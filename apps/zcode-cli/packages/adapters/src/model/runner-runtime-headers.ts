// ============================================================
// 每次 attempt 的运行时鉴权刷新
// 定位：Start Plan 等账号的凭据需按 attempt 重取；本文件在发请求前把新鉴权投影回模型绑定。
// 输入：attempt 序号、刷新原因、请求（含 abortSignal）、resolveModel 回调。
// 输出：带新 auth 的 ResolvedAiSdkModel；无 refresh 能力时返回原绑定。
// 副作用：调用 refreshRuntimeHeadersBeforeAttempt（可能读凭据/网络）；不写共享 Registry。
// 失败语义：abort 原样抛；ModelRequestAuthMissing 原样抛（已有稳定 code）；
// 其余刷新失败包装为 RuntimeHeadersRefreshError（保留 cause）。
// 不变量：刷新结果必须 headersApplied 且带 requestAuth；作用域校验由 core 一侧负责，此处不伪造。
// ============================================================

import type { RequestVerificationReason } from "@zcode/shared";
import type { ModelRequestAuth } from "@zcode/contracts";
import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

/**
 * 刷新鉴权失败的包装错误：保留原始 cause 与 message，name 稳定，
 * 便于 runner 在分类时区分"刷新失败"与 provider 响应失败。
 */
export class RuntimeHeadersRefreshError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RuntimeHeadersRefreshError";
  }
}

/**
 * 为本次 attempt 解析模型：先检查 abort，再取默认绑定；有 refresh 能力时才调用它。
 * 刷新期间与刷新后都要重查 abort（等待可能很长），刷新结果不完整即视为配置失败。
 * 成功时用新 requestAuth 重新 resolveModel，让绑定把鉴权投影到私有请求，不重新选模型。
 */
export async function resolveModelForAttempt(input: {
  attempt: number;
  reason?: RequestVerificationReason;
  request: AiSdkModelTextRequest;
  resolveModel: (requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel;
}): Promise<ResolvedAiSdkModel> {
  const signal = input.request.abortSignal;
  signal?.throwIfAborted();
  const boundModel = input.resolveModel();
  if (!input.request.refreshRuntimeHeadersBeforeAttempt) return boundModel;
  try {
    const refreshResult = await waitForHeaders(
      () =>
        input.request.refreshRuntimeHeadersBeforeAttempt!({
          attempt: input.attempt,
          reason: input.reason ?? "model-request",
          abortSignal: signal,
          providerId: String(boundModel.providerId),
          modelId: String(boundModel.modelId),
          traceContext: input.request.traceContext,
        }),
      signal,
    );
    signal?.throwIfAborted();
    if (!refreshResult.headersApplied || !refreshResult.requestAuth) {
      throw new Error("Provider request auth was not returned before model request attempt.");
    }
    // 当前绑定负责将完整鉴权材料投影到私有请求，不写共享 Registry，也不重新选择模型。
    return input.resolveModel(refreshResult.requestAuth);
  } catch (error) {
    if (signal?.aborted) throw error;
    // 执行作用域凭据缺失已有稳定错误码；不能被 headers 等待的通用包装吞掉。
    if (
      error instanceof ModelProtocolError &&
      error.code === ModelErrorCode.ModelRequestAuthMissing
    )
      throw error;
    throw new RuntimeHeadersRefreshError(error);
  }
}

async function waitForHeaders<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  // 有 signal 时把刷新 promise 与 abort 竞速：凭据读取可能卡在 I/O，Stop 不能被它拖住。
  if (!signal) return run();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
