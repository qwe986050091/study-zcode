import type { ModelRequestAuth } from "@zcode/contracts";
import type { ModelExecutionInput, ModelExecutionContext } from "./contract.js";

// 关键口径：
// - selectionScope 固定 "execution"：本次请求只做执行绑定，不回写用户保存的选择意图；
// - requestAuth 逐字段拷贝后冻结，并包装成惰性 resolve，避免凭证进入可序列化 intent/日志；
// - 可选字段只在传入时出现，缺席不写默认值（wire 上「未表达 = 用宿主默认」）。
/** 两种输入协议共用执行材料投影；不把 Secret/Ticket 放入可持久化的 intent。 */
export function createModelExecutionContext(input: ModelExecutionInput): ModelExecutionContext {
  const requestAuth = input.requestAuth ? freezeRequestAuth(input.requestAuth) : undefined;
  return {
    ...(input.memoryExtraction ? { memoryExtraction: input.memoryExtraction } : {}),
    selectionScope: "execution",
    ...(input.offPeak ? { offPeak: input.offPeak } : {}),
    ...(requestAuth
      ? {
          requestDependencies: { requestAuth: { source: { resolve: async () => requestAuth } } },
        }
      : {}),
    ...(input.subagents ? { subagents: input.subagents } : {}),
    ...(input.selectionFallback ? { selectionFallback: input.selectionFallback } : {}),
  };
}

// 逐字段挑选并冻结鉴权材料：不整对象复制，避免调用方多带的内部字段进入执行上下文；
// undefined 的键直接省略，保持「未提供」与「提供空串」可区分。
function freezeRequestAuth(input: ModelRequestAuth): ModelRequestAuth {
  return Object.freeze({
    ...(input.accountScope ? { accountScope: input.accountScope } : {}),
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
    ...(input.headers ? { headers: Object.freeze({ ...input.headers }) } : {}),
  });
}
