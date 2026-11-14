/**
 * ============================================================================
 * tool-part-persistence.ts —— 工具 part 的"首次落盘"与空名投影
 * ============================================================================
 *
 * 工具声明一到(runtime admission 通过),就要先写一条 pending part:
 *   - 用户在工具执行前 Stop/崩溃时,冷恢复仍能看到工具卡与输入;
 *   - 执行阶段只需更新同一条 part 的状态,不会出现"半条工具消息"。
 *
 * 空名工具(模型返回 name="" 等异常)不能直接用空字符串落库:
 *   - 空名进入 UI 会与合法工具产生身份碰撞;
 *   - storage/DB 可能拒空名。这里投影成占位名,并把原始名放进 metadata 保留证据。
 * ============================================================================
 */
import type {
  CompletedToolPartMetadata,
  MessageId,
  Model,
  PartId,
  ToolCall,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { requireRuntimeToolCallName } from "../helpers/index.js";

const EMPTY_TOOL_NAME_PLACEHOLDER = "empty_tool_name";
const PROVIDER_TOOL_NAME_METADATA_KEY = "providerToolName";

interface NonEmptyToolNameProjection {
  metadata?: Record<string, unknown>;
  toolName: string;
}

/**
 * 把工具名投影成"可落库/可展示"的非空名称:
 * 正常名原样返回;空名 → 占位名 + metadata.providerToolName(保留原始值供排障)。
 */
export function projectToolNameForNonEmptyBoundary(toolName: string): NonEmptyToolNameProjection {
  // 用 trim 判断而非 length：只有空白的名字同样会与合法工具碰撞身份、也可能被 DB 拒写，
  // 不能当成"有名字"放过。
  if (toolName.trim().length > 0) {
    return { toolName };
  }
  return {
    metadata: { [PROVIDER_TOOL_NAME_METADATA_KEY]: toolName },
    toolName: EMPTY_TOOL_NAME_PLACEHOLDER,
  };
}

/**
 * 写入一条 pending 工具 part(状态=running 之前的初始态)。
 * 注意:raw 字段保存原始 tool+input 的 JSON,供冷恢复/调试还原模型当时看到的调用。
 */
export async function persistPendingToolPart(
  runtime: AgentRuntimeInternal,
  options: {
    assistantMessageId: MessageId;
    declarationIndex: number;
    input: Record<string, unknown>;
    partID: PartId;
    toolCall: ToolCall;
    traceContext: TraceContext;
    metadata?: CompletedToolPartMetadata;
    model: Model;
  },
): Promise<void> {
  const projected =
    // 空名分支不调用 requireRuntimeToolCallName:那里会抛"空名非法",
    // 但 pending part 的职责是"即使非法也要留下可恢复的证据",
    // 所以空名走占位名 + providerToolName 元数据。
    typeof options.toolCall.name === "string" && options.toolCall.name.trim().length === 0
      ? projectToolNameForNonEmptyBoundary(options.toolCall.name)
      : {
          toolName: requireRuntimeToolCallName(options.toolCall, {
            logger: runtime.logger,
            model: options.model,
            source: "persistPendingToolPart",
            traceContext: options.traceContext,
          }),
        };
  // pending part 是工具调用的首个 durable 证据：这里失败必须直接抛，
  // 不能带着"无 part 的 call"进入执行器，否则冷恢复看不到工具输入（不变量 1 无证据）。
  await runtime.persistPart(
    {
      id: options.partID,
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "tool",
      callID: options.toolCall.id,
      // declarationIndex 保留模型声明顺序：冷恢复/UI 靠它把同一 assistant 的多个
      // tool part 排回原序；缺失会退化成存储顺序，工具卡顺序会漂移。
      declarationIndex: options.declarationIndex,
      tool: projected.toolName,
      metadata: {
        // 合并顺序 = 优先级递增:
        //   1) 空名投影产生的 providerToolName(证据字段);
        //   2) 调用方传入的展示元数据(MCP presentation 等);
        //   3) modelCallWrapper(本次调用的真实包装关系)。
        // wrapper 放最后,保证它与"实际执行的 call"一致,不会被外部 metadata 覆盖。
        ...projected.metadata,
        ...options.metadata,
        ...(options.toolCall.modelCallWrapper
          ? { modelCallWrapper: options.toolCall.modelCallWrapper }
          : {}),
      },
      state: {
        // pending 而不是 running:此时还没有进入执行阶段,写 running 会让 UI
        // 显示"正在运行";running 由执行器的 onBatchStart 用同一 partID 覆盖。
        status: "pending",
        input: options.input,
        // raw 保留模型原始调用(含未归一化的 input),供冷恢复/排障还原现场;
        // 与 input(归一化后供 UI 展示)刻意分开,避免展示逻辑污染证据。
        raw: JSON.stringify({
          tool: projected.toolName,
          input: options.toolCall.input,
        }),
      },
    },
    options.traceContext,
  );
}
