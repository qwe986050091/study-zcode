// ============================================================
// 错峰（off-peak）请求鉴权刷新
// 定位：错峰通道使用短生命周期 PAT，每个 HTTP attempt 前都需向账户 owner 重新解析。
// 输入：派发快照 auth（含 accountScope 与 headers）+ 账号登录态 + 可选 refresh 回调。
// 输出：新的 ModelRequestAuth（替换 x-coding-plan-api-key）；无 accountScope 时原样返回同一对象。
// 副作用：调用 refresh 回调（可能触发网络/持久化读取），不写全局状态。
// 失败语义：无 refresh 回调或缺 accountScope 票据时抛错；作用域不一致抛 project_token_scope_invalidated。
// 不变量：返回的票据作用域必须与派发快照一致；旧 coding-plan 头必须先删再写，不能叠加。
// ============================================================

import type {
  ModelInvocationContext,
  ModelRequestAuth,
  ModelRequestAuthSourceInput,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";

/** 派发快照只固定票据与登录作用域；短期 PAT 必须在每个 HTTP attempt 向原 owner 解析。 */
/**
 * 刷新错峰请求的鉴权头。
 * 非错峰请求（auth.accountScope 为空）直接返回原对象，不触发额外 refresh；
 * 错峰请求若未注入 refresh 能力则 fail-closed 抛错，因为无法取得新的短期 PAT。
 * refresh 结果必须同时满足 headersApplied、非空 apiKey、accountScope 未漂移，否则视为
 * owner 已拒绝/已切换登录，抛 project_token_scope_invalidated 让上层重试或提示重新登录。
 */
export async function refreshOffPeakRequestAuth(params: {
  auth: ModelRequestAuth;
  input: ModelRequestAuthSourceInput & { rejectedProjectTokenFingerprint?: string };
  accountAccess: ZCodeProviderAccountAccess;
  refresh?: ModelInvocationContext["refreshRuntimeHeadersBeforeAttempt"];
}): Promise<ModelRequestAuth> {
  const { auth } = params;
  if (!auth.accountScope) return auth;
  if (!params.refresh) throw new Error("Off-peak request auth owner is unavailable");
  const result = await params.refresh({
    ...params.input,
    accountAccess: params.accountAccess,
    expectedAccountScope: auth.accountScope,
    reason: "model-request",
  });
  if (
    !result.headersApplied ||
    !result.requestAuth?.apiKey?.trim() ||
    result.requestAuth.accountScope !== auth.accountScope
  )
    throw new Error("project_token_scope_invalidated");
  const headers = { ...auth.headers };
  // 旧快照可能已带 coding-plan 头；先按大小写不敏感全部删除，避免同时出现新旧两个凭据。
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-coding-plan-api-key") delete headers[name];
  }
  return {
    ...auth,
    apiKeyId: result.requestAuth.apiKeyId,
    headers: { ...headers, "X-Coding-Plan-Api-Key": result.requestAuth.apiKey },
  };
}
