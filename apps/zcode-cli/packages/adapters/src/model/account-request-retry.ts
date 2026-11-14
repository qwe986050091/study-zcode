// ============================================================
// 账号级请求重试（请求签名校验 + project token 刷新）
// 定位：包在单次 model 请求外，处理两类"换凭据后重发"的特殊失败：请求安全校验失败、
// 项目 PAT 被上游 401 拒绝。它不属于普通瞬态重试，不消耗 retry 预算。
// 输入：待发请求、已解析模型（含 accountAccess）、可选 logger。
// 输出：claim() 返回布尔——true 表示已被本组件认领并允许重发一次。
// 副作用：包装 refreshRuntimeHeadersBeforeAttempt（可能取新票据）、写 warn 日志。
// 失败语义：刷新后 accountScope 漂移时抛 project_token_scope_invalidated；其余失败不吞，原样上抛。
// 不变量：project token 刷新最多一次（#used）；#pending 标记"本次重试源于被拒票据"，
// 刷新一次即清空，避免同一失败被无限认领。
// ============================================================

import type { RequestVerificationReason } from "@zcode/shared";
import { projectAccessTokenFingerprint, isRequestSecurityFailure } from "@zcode/shared";
import type { Logger, ModelRequestAuth } from "@zcode/contracts";
import { RequestVerificationRetry } from "./request-security-edition/recovery.js";
import { inspectProviderFailure } from "./failure-classifier.js";
import {
  getApiCallResponseBody,
  getHttpResponseStatus,
  unwrapRetryError,
} from "./failure-inspection.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

/**
 * 账号级重试协调器。额外尝试次数 = 签名修复额外次数 + 是否已用掉的一次 PAT 刷新。
 * 每次请求前替换 refresh 回调，使其顺带记录本次拿到的 auth，供后续判断被拒的是哪个票据。
 */
export class AccountRequestRetry {
  readonly #verification: RequestVerificationRetry;
  #used = false;
  #pending = false;
  #auth?: ModelRequestAuth;

  constructor(
    private readonly request: AiSdkModelTextRequest,
    private readonly model: ResolvedAiSdkModel,
    private readonly logger?: Logger,
  ) {
    this.#verification = new RequestVerificationRetry(request, model);
  }

  /** 额外尝试预算：签名修复的可重试次数 + 已消耗的 PAT 刷新次数（0 或 1）。 */
  get extraAttempts(): number {
    return this.#verification.extraAttempts + Number(this.#used);
  }

  takeReason(): RequestVerificationReason {
    return this.#verification.takeReason();
  }

  /**
   * 包装请求的 refresh 回调：每次 attempt 前先取一次凭据并记在 #auth。
   * 若本次是"PAT 被拒后的重试"（#pending），把上次被拒票据的 fingerprint 与作用域一并带给 owner，
   * 让 owner 精确作废该票据；刷新后作用域若已漂移（用户切换了账号/计划），直接抛错要求重新登录。
   */
  prepareRequest(request: AiSdkModelTextRequest): AiSdkModelTextRequest {
    const refresh = request.refreshRuntimeHeadersBeforeAttempt;
    if (!refresh) return request;
    return {
      ...request,
      refreshRuntimeHeadersBeforeAttempt: async (input) => {
        const previous = this.#auth;
        const recover = this.#pending;
        this.#pending = false;
        this.#auth = undefined;
        const token = previous && this.#token(previous);
        const result = await refresh({
          ...input,
          ...(recover && token && previous?.accountScope
            ? {
                expectedAccountScope: previous.accountScope,
                rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint(token),
              }
            : {}),
        });
        if (recover && result.requestAuth?.accountScope !== previous?.accountScope)
          throw new Error("project_token_scope_invalidated");
        this.#auth = result.headersApplied ? result.requestAuth : undefined;
        return result;
      },
    };
  }

  /**
   * 认领失败：先交给签名校验重试判定；否则再判断能否走 PAT 刷新。
   * 认领成功即消耗唯一一次机会并置 pending，日志只记录 provider/model/trace/status，不含凭据原文。
   * 返回 false 表示本组件不处理，由上层按普通失败分类处理。
   */
  claim(error: unknown, blocked = false): boolean {
    if (this.#verification.claim(error, blocked)) return true;
    if (!this.canRecoverProjectToken(error, blocked)) return false;
    this.#used = true;
    this.#pending = true;
    this.logger?.warn("Model PAT rejected; refreshing once before retry", {
      event: "model.project_token.refresh_retry",
      providerId: String(this.model.providerId),
      modelId: String(this.model.modelId),
      traceId: this.request.traceContext?.traceId,
      statusCode: 401,
    });
    return true;
  }

  /**
   * PAT 刷新是否可行的完整前置条件集合：未被 blocked、未用过、未 abort、有 refresh 能力、
   * 账号模式必须是编码套餐或错峰、当前 auth 有 accountScope 与票据、且错误确实是 401 项目票据拒绝。
   * 任一不满足即 false，避免对普通 401（例如 API key 失效）做无意义刷新。
   */
  canRecoverProjectToken(error: unknown, blocked = false): boolean {
    const mode = this.model.accountAccess?.mode;
    if (
      blocked ||
      this.#used ||
      this.request.abortSignal?.aborted ||
      !this.request.refreshRuntimeHeadersBeforeAttempt ||
      !["individual-coding-plan", "team-coding-plan", "off-peak"].includes(mode ?? "") ||
      !this.#auth?.accountScope ||
      !this.#token(this.#auth) ||
      !isProjectTokenRejection(error)
    )
      return false;
    return true;
  }

  /** 取当前票据：off-peak 模式票据在 header 里（x-coding-plan-api-key），其他模式用 auth.apiKey。 */
  #token(auth: ModelRequestAuth): string | undefined {
    return this.model.accountAccess?.mode === "off-peak"
      ? Object.entries(auth.headers ?? {}).find(
          ([key]) => key.toLowerCase() === "x-coding-plan-api-key",
        )?.[1]
      : auth.apiKey;
  }
}

/**
 * 是否为"项目 PAT 被拒"：解包重试包装后状态码恰为 401，且错误链中没有其它鉴权类失败。
 * 排除其它鉴权失败是关键，否则会把 provider 的通用鉴权错误误判成可刷新票据。
 */
export function isProjectTokenRejection(error: unknown): boolean {
  return (
    getHttpResponseStatus(unwrapRetryError(error)) === 401 &&
    !isOtherAuthRejection(error, new WeakSet<object>())
  );
}

/**
 * 沿 cause 链递归检查是否含请求安全（签名/加密）类失败；用 WeakSet 防环，避免异常链成环导致栈溢出。
 * 命中任一环即认为不是纯 PAT 问题，PAT 刷新无法修复。
 */
function isOtherAuthRejection(error: unknown, seen: WeakSet<object>): boolean {
  const current = unwrapRetryError(error);
  if (!current || typeof current !== "object" || seen.has(current)) return false;
  seen.add(current);
  const details = inspectProviderFailure(current);
  return (
    isRequestSecurityFailure(getApiCallResponseBody(current), [
      details.providerErrorCode,
      details.providerErrorMessage,
    ]) ||
    ("cause" in current && isOtherAuthRejection(current.cause, seen))
  );
}
