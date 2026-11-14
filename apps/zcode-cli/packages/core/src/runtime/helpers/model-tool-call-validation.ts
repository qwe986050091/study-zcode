import { CoreErrorType, createCoreError, traceContextToLogContext } from "../deps.js";
import type { Logger, Model, ModelToolCall, ToolCall, TraceContext } from "../deps.js";

/**
 * 模型工具调用校验上下文。
 * logger 可选：缺失时只抛错、不写 warn（供无日志的宿主/测试路径）。
 * model 只取身份字段（providerId/modelId），用于错误 context 与日志归因。
 * source 标记调用来源（chat/stream/subagent 等），便于遥测区分噪声来源。
 * traceContext 必须透传，禁止在此丢弃 traceId。
 */
interface ModelToolCallValidationContext {
  logger?: Logger;
  model: Pick<Model, "providerId" | "modelId">;
  source: string;
  traceContext: TraceContext;
}

/**
 * 归一化模型返回的一批 toolCalls：逐个 trim 工具名，非法名按统一规则处理。
 *
 * 输入：模型原始 toolCalls（可能缺省/为空）+ 校验上下文。
 * 输出：新的数组（浅拷贝每个调用，仅替换 name）；**空数组与 undefined 都归为 undefined**，
 *   让调用方用"有无工具"一个判据即可，不必再判空数组。
 * 副作用：无（不改入参）；非法名直接抛 CoreError（由 throwInvalidRuntimeToolName 记录 warn）。
 * 不变量：client-executed 且 id 非空的空名调用要原样保留（见 normalizeRuntimeModelToolName）。
 */
export function normalizeModelToolCallsForRuntime(
  toolCalls: readonly ModelToolCall[] | undefined,
  context: ModelToolCallValidationContext,
): ModelToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined;
  }

  return toolCalls.map((toolCall, index) => ({
    ...toolCall,
    name: normalizeRuntimeModelToolName(toolCall.name, {
      ...context,
      providerExecuted: toolCall.providerExecuted,
      toolCallId: toolCall.id,
      toolCallIndex: index,
    }),
  }));
}

/**
 * 执行前的强制工具名校验：trim 后必须非空，否则抛 ModelError。
 * 与 normalizeModelToolCallsForRuntime 的差异：这里没有 providerExecuted/id 例外，
 *   用于 executor 准入阶段——工具即将执行，空名无法路由 registry，必须 fail closed。
 * 纯校验 + 可能抛错（并写 warn 日志）；不修改入参。
 */
export function requireRuntimeToolCallName(
  toolCall: Pick<ModelToolCall | ToolCall, "id" | "name">,
  context: ModelToolCallValidationContext,
): string {
  return requireRuntimeToolName(toolCall.name, {
    ...context,
    toolCallId: toolCall.id,
  });
}

/**
 * 严格版工具名归一化：只接受 trim 后非空的字符串。
 * 空串/非字符串一律失败（调用 throwInvalidRuntimeToolName 抛错并记录上下文）。
 */
function requireRuntimeToolName(
  value: unknown,
  context: ModelToolCallValidationContext & {
    toolCallId?: string;
    toolCallIndex?: number;
  },
): string {
  const toolName = typeof value === "string" ? value.trim() : "";
  if (toolName) {
    return toolName;
  }

  return throwInvalidRuntimeToolName(context);
}

/**
 * 宽松版工具名归一化：字符串 trim 后非空即返回。
 *
 * 例外（刻意保留空名）：providerExecuted !== true（client-executed）且 toolCallId 非空时，
 *   返回原始空串，让 runtime admission 与 Adapter 保持同一口径——该调用仍可被后续
 *   配对/合成结果闭合，不能在此把整个 turn 截断。
 * 其余非法形态统一抛错；非字符串永远不通过。
 */
function normalizeRuntimeModelToolName(
  value: unknown,
  context: ModelToolCallValidationContext & {
    providerExecuted?: boolean;
    toolCallId?: string;
    toolCallIndex?: number;
  },
): string {
  if (typeof value === "string") {
    const toolName = value.trim();
    if (toolName) {
      return toolName;
    }
    if (
      context.providerExecuted !== true &&
      typeof context.toolCallId === "string" &&
      context.toolCallId.trim().length > 0
    ) {
      // Adapter 后仍可能存在自定义 Model 实现；runtime admission 必须与
      // Adapter 一致保留可闭合的 client-executed 空名，而不是再次把 turn 截断。
      return value;
    }
  }

  return throwInvalidRuntimeToolName(context);
}

/**
 * 统一的非法工具名失败出口：先写 warn（含 trace/模型/source/toolCall 定位），
 * 再抛 CoreError(ModelError, retryable=false)。
 * retryable=false 的原因：同一模型响应重复请求只会再犯一次；是否重试由上层
 *   恢复链（selection fallback / 重新请求）决定，而不是把错误交给 provider 重试。
 * 返回类型 never，表示调用后必定中断当前路径。
 */
function throwInvalidRuntimeToolName(
  context: ModelToolCallValidationContext & {
    toolCallId?: string;
    toolCallIndex?: number;
  },
): never {
  const logContext = {
    ...traceContextToLogContext(context.traceContext),
    event: "model.invalid_tool_call",
    module: "core.runtime",
    model: `${context.model.providerId}/${context.model.modelId}`,
    modelId: context.model.modelId,
    providerId: context.model.providerId,
    source: context.source,
    status: "failed" as const,
    toolCallId: context.toolCallId,
    toolCallIndex: context.toolCallIndex,
  };
  context.logger?.warn("Model returned invalid tool call", logContext);

  throw createCoreError(
    CoreErrorType.ModelError,
    "Model returned an invalid tool call: tool name is empty.",
    {
      context: logContext,
      recoverable: true,
      retryable: false,
    },
  );
}
