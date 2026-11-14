// ============================================================
// 流式 tool call 组装器
// 定位：流式协议会先发 tool_input_start/delta/end，再发 tool_call；本类负责去重、归一化并只发一份。
// 输入：ModelStreamEvent 流。输出：可继续下发的同类型事件数组（可能为空表示吞掉重复）。
// 副作用：维护内部 Map/Set 状态；flush 清空状态但不产出事件。
// 失败语义：tool 名非法抛 AiSdkModelAdapterError（由 normalizeModelToolName 决定）；input 解析失败降级 {}。
// 不变量：同一 toolCallId 只下发一次 tool_call；进入流式 input 生命周期后，final call 不能替代
// 缺失的 tool_input_end（end gate 必须由原事件闭合）。
// ============================================================

import type { Logger, ModelStreamEvent, ModelToolCall } from "@zcode/contracts";
import { normalizeModelToolInput } from "./tool-input-normalization.js";
import { normalizeModelToolName } from "./tool-call-validation.js";

interface StreamingToolCallAssemblerOptions {
  logger?: Logger;
}

/**
 * 有状态组装器。三个集合分别记录：已归一化的调用（输出真相）、流式 input 已开始/已结束的 id、
 * 以及 start 事件携带的 provider 执行标记（final call 可能省略，需要补回）。
 */
export class StreamingToolCallAssembler {
  private readonly completedStreamingInputIds = new Set<string>();
  private readonly logger?: Logger;
  private readonly normalizedToolCalls = new Map<string, ModelToolCall>();
  private readonly providerExecutedById = new Map<string, boolean>();
  private readonly streamingInputIds = new Set<string>();

  constructor(options: StreamingToolCallAssemblerOptions = {}) {
    this.logger = options.logger;
  }

  /** 已归一化调用的快照（浅拷贝，调用方修改不会污染组装器内部状态）。 */
  snapshotNormalizedToolCalls(): ModelToolCall[] {
    return Array.from(this.normalizedToolCalls.values(), (toolCall) => ({ ...toolCall }));
  }

  /**
   * 事件入口：tool_input_* 与 tool_call 走内部状态机，其余事件原样透传。
   * finish 时先 flush（清空本轮状态）再追加 finish，确保下一轮从干净状态开始。
   */
  handle(event: ModelStreamEvent): ModelStreamEvent[] {
    switch (event.type) {
      case "tool_input_start":
        return this.handleToolInputStart(event);
      case "tool_input_delta":
        return this.normalizedToolCalls.has(event.id) ? [] : [event];
      case "tool_input_end":
        return this.handleToolInputEnd(event);
      case "tool_call":
        return this.handleToolCall(event.toolCall);
      case "finish":
        return [...this.flush(), event];
      default:
        return [event];
    }
  }

  /** 清空本轮所有 tool 相关状态；不产出事件，且不清理已归一化的 toolCalls（保留给 snapshot）。 */
  flush(): ModelStreamEvent[] {
    this.completedStreamingInputIds.clear();
    this.providerExecutedById.clear();
    this.streamingInputIds.clear();
    return [];
  }

  /**
   * 处理 tool_input_start：已归一化过则吞掉；否则校验/补全 toolName、记录 provider 执行标记，
   * 并标记该 id 已进入流式生命周期，返回改写后的事件。
   */
  private handleToolInputStart(
    event: Extract<ModelStreamEvent, { type: "tool_input_start" }>,
  ): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(event.id)) {
      return [];
    }

    const toolName = normalizeModelToolName(event.toolName, {
      providerExecuted: event.providerExecuted,
      source: "streamText",
      streamEventType: event.type,
      toolCallId: event.id,
    });
    if (event.providerExecuted !== undefined) {
      this.providerExecutedById.set(event.id, event.providerExecuted);
    }
    this.streamingInputIds.add(event.id);
    return [{ ...event, toolName }];
  }

  /** 记录 tool_input_end：已归一化的吞掉，否则标记完成，供 final call 的 end gate 判断。 */
  private handleToolInputEnd(
    event: Extract<ModelStreamEvent, { type: "tool_input_end" }>,
  ): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(event.id)) {
      return [];
    }
    this.completedStreamingInputIds.add(event.id);
    return [event];
  }

  /**
   * 处理最终 tool_call：已归一化则丢弃；仍在流式 input 中途（started 且未 end）也丢弃，
   * 因为此时下发会让上层提前执行工具，而输入尚未闭合。仅在结束后才归一化并下发一次。
   */
  private handleToolCall(toolCall: ModelToolCall): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(toolCall.id)) {
      return [];
    }
    if (
      this.streamingInputIds.has(toolCall.id) &&
      !this.completedStreamingInputIds.has(toolCall.id)
    ) {
      // 已经进入流式 input 生命周期时，final call 不能替代缺失的
      // tool-input-end；只移除“首次 JSON 可解析”合成，不改变既有 end gate。
      return [];
    }

    const providerExecuted =
      toolCall.providerExecuted ?? this.providerExecutedById.get(toolCall.id);
    // providerExecuted 可能只在 start 事件里出现；补回后再交给名称归一化，
    // 否则 provider 执行且空名的调用会被误判为需要闭合的 client 调用。
    const toolName = normalizeModelToolName(toolCall.name, {
      providerExecuted,
      source: "streamText",
      streamEventType: "tool_call",
      toolCallId: toolCall.id,
    });
    const normalizedToolCall = {
      ...toolCall,
      input: normalizeModelToolInput(toolCall.input, {
        logger: this.logger,
        source: "streamText",
        toolName,
      }),
      name: toolName,
      // 流式 start 可能携带 final call 省略的 provider 执行标记。
      // 这里只补回原有元数据，不改变工具提交、重试或执行语义。
      providerExecuted,
    };
    this.completedStreamingInputIds.delete(toolCall.id);
    this.providerExecutedById.delete(toolCall.id);
    this.streamingInputIds.delete(toolCall.id);
    this.normalizedToolCalls.set(normalizedToolCall.id, normalizedToolCall);
    return [{ type: "tool_call", toolCall: normalizedToolCall }];
  }
}
