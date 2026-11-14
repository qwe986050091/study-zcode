/**
 * ============================================================================
 * tool/deferred-call.ts —— DeferredToolCall 的统一准入解析
 * ============================================================================
 *
 * DeferredToolCall 是"延迟工具的二级入口":模型先 ToolSearch 发现工具,
 * 再用 DeferredToolCall({name, input}) 调用。调度、流式协调器、executor
 * 都必须在同一处把包装调用解析成真实工具调用,否则会出现"不同层看到不同工具名"。
 *
 * 【失败语义】解析失败返回 { call: 原始 call, error }:
 *   - call 保持原始包装身份(name 仍是 DeferredToolCall);
 *   - error 是可恢复的 ToolExecutionFailed。
 * 调用方(如目标生命周期)据此知道"这是一次失败的包装调用",不会误判成真实工具。
 *
 * 【只接受延迟工具】ToolSearch/DeferredToolCall 自身、providerNative 工具、
 * 非 deferred 工具都必须直接调用,不能绕一层包装。
 * ============================================================================
 */
import {
  CoreErrorType,
  createCoreError,
  DEFERRED_TOOL_CALL_NAME,
  DeferredToolCallInputSchema,
  TOOL_SEARCH_NAME,
  type ToolSearchExecutionContext,
} from "@zcode/contracts";
import type { ExecutableToolCall } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import { deferredToolCallEntry } from "./handlers/deferred-tool-call.js";
import { validateInitialModelToolInput } from "./executor/validation.js";

// 调度、流式准入与 executor 共用同一解析边界；失败保持包装身份，不触发目标生命周期。
export function resolveDeferredToolCall<T extends ExecutableToolCall>(
  call: T,
  search: ToolSearchExecutionContext | undefined,
  registry: Pick<ToolRegistry, "get">,
): { call: T; error?: Error } {
  const original = call;
  // 非包装调用原样返回(引用相等):调用方可以据此判断"没有发生解析"。
  // 直接走正常工具执行路径，避免对普通调用做无意义的 schema 校验。
  if (original.name !== DEFERRED_TOOL_CALL_NAME) return { call };
  const reject = (message: string) => ({
    // 失败时保留原始 call(仍是 DeferredToolCall),只附带 error:
    // 上层据此走"包装调用失败"的收口,而不是伪造一个不存在的真实工具。
    call: original,
    error: createCoreError(CoreErrorType.ToolExecutionFailed, message, { recoverable: true }),
  });
  if (
    // 只有 native + local 模式且本次 catalog 真的暴露了 DeferredToolCall 才可用;
    // 否则模型调它只是幻觉,必须给出明确拒绝而不是尝试解析。
    // 三条件任一不满足都 reject：search 未启用 / 非 local 模式 / catalog 不含该工具。
    !search?.enabled ||
    search.mode !== "local" ||
    !search.catalog.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME)
  )
    return reject("DeferredToolCall is not available for this request.");
  // 先按 DeferredToolCall 自己的 schema 校验(能得到字段级错误),
  // 再解析 name/input;顺序反了会先得到模糊的 "Invalid input"。
  const validation = validateInitialModelToolInput(original.input, deferredToolCallEntry);
  if (validation) return { call: original, error: validation };
  const parsed = DeferredToolCallInputSchema.safeParse(original.input);
  // schema 校验失败说明 name/input 字段缺失或类型错误，此时 validation 可能通过
  // （inputSchema 可能比 DeferredToolCallInputSchema 宽松），所以这里做二次精确校验。
  if (!parsed.success) return reject("Invalid DeferredToolCall input.");
  const { name, input } = parsed.data;
  const candidate = search.catalog.find((tool) => tool.name === name);
  const entry = registry.get(name);
  // 两处都要存在:
  //   catalog 证明"本次请求确实向模型暴露过该工具"(不是模型臆造);
  //   registry 证明"runtime 当前能执行它"(catalog 可能来自旧快照)。
  // 任一缺失都 reject：不能执行一个模型没被授权看到或 runtime 已下线的工具。
  if (!candidate || !entry) return reject(`Tool not available in this request: ${name}`);
  if (
    // 这些目标必须直接用正常工具调用:
    //   ToolSearch/DeferredToolCall 自身是发现协议,再包一层会形成循环;
    //   providerNative 由 provider 侧执行,本地包装会破坏其执行位置;
    //   非 deferred 工具本来就在 schema 里,包装只会多一层无意义的中转。
    // 不变量：包装层只服务于 deferred 工具，不能成为绕过正常调用路径的后门。
    name === TOOL_SEARCH_NAME ||
    name === DEFERRED_TOOL_CALL_NAME ||
    entry.providerNative ||
    !candidate.deferred
  ) {
    return reject(
      `Call ${name} directly using its normal tool call; DeferredToolCall only accepts deferred tools.`,
    );
  }
  return {
    call: {
      ...original,
      // 保留原始 call 的 id/trace 等字段,只替换 name/input 并记录包装关系:
      // 这样事件、part、统计仍归到同一次模型声明。
      name,
      input,
      modelCallWrapper: DEFERRED_TOOL_CALL_NAME,
    },
  };
}
