// ============================================================
// Turn Machine - State machine for turn lifecycle
// 职责：以不可变快照（TurnState）驱动单个 turn 的相位流转，聚合工具调用、权限请求、
// 流式正文与排队输入；全部状态只存在 state 字段，不落盘、不发事件、不写日志。
// 口径：方法返回新的 TurnState 快照，调用方负责替换引用、持久化与广播。
// 失败语义：仅非法相位转移抛 CoreError(InvalidTurnPhase, recoverable=true)；
// fail() 可绕过相位校验直接进入 Error 终态，用于不可恢复错误的兜底落点。
// 不变量：除 fail() 外任何相位变更都必须经过 transition()；旧快照不被就地修改。
// ============================================================

import type {
  TurnState,
  TurnPhase,
  ToolCall,
  ToolScheduleState,
  PermissionRequestState,
  PermissionDecision,
  TurnResultType,
  TurnErrorState,
  ModelRequestState,
} from "./turn-state.js";
import {
  TurnPhase as Phase,
  createTurnState,
  canTransitionTo,
  isTerminalPhase,
} from "./turn-state.js";
import type {
  ModelMessageContent,
  SessionId,
  TraceId,
  ToolCallId,
  TurnId,
} from "@zcode/contracts";
import type { PendingTurnInput } from "@zcode/contracts";
import {
  createTurnId,
  createCoreError,
  CoreErrorType,
  modelMessageContentToText,
} from "@zcode/contracts";

// -----------------------------------------------
// Turn Machine
// -----------------------------------------------

// Turn 生命周期的状态机契约：所有方法接收并返回 TurnState 快照，本身不持有外部副作用。
// 调用方按 phase 推进流程；实现层对非法顺序抛 InvalidTurnPhase（recoverable=true）。
export interface TurnMachine {
  // 当前 turn 的不可变快照；每次调用后应由调用方替换为方法返回值。
  state: TurnState;
  // 收下用户输入后的起始动作：进入 ProcessingInput。
  start(): TurnState;
  // 发起模型请求：仅允许从 ProcessingInput / AggregatingResults 进入 AwaitingModelResponse。
  startModelRequest(model: string, messages: ModelRequestState["messages"]): TurnState;
  // 收到模型完整响应（非流式路径）：进入 Streaming 并累积正文。
  receiveModelResponse(content: string): TurnState;
  // 追加一段流式增量：进入 Streaming 并拼接 streamingContent。
  addStreamingContent(content: string): TurnState;
  // 登记本轮工具调用与调度策略：进入 SchedulingTools，覆盖上一轮的调用列表。
  scheduleTools(toolCalls: ToolCall[], schedule: ToolScheduleState): TurnState;
  // 开始执行工具：存在待授权调用时停在 AwaitingPermission，否则进入 ExecutingTools。
  startToolExecution(): TurnState;
  // 结清单个工具：按 success 置 completed/failed，并把结果追加到 toolResults。
  completeTool(
    toolCallId: ToolCallId,
    result: { success: boolean; content: ModelMessageContent },
  ): TurnState;
  // busy 期间的新输入入队；不改相位，等本轮结束统一 drain。
  queuePendingInput(input: PendingTurnInput): TurnState;
  // 一次性取走全部排队输入并清空队列，返回输入与更新后的快照。
  drainPendingInputs(): { inputs: PendingTurnInput[]; state: TurnState };
  // 登记权限请求：进入 AwaitingPermission，并把目标调用置为 waiting_permission。
  requestPermission(request: PermissionRequestState): TurnState;
  // 结清权限请求：deny 置 permission_denied，allow 保留原状态，可携带修改后的入参。
  resolvePermission(
    toolCallId: ToolCallId,
    decision: PermissionDecision,
    modifiedInput?: unknown,
  ): TurnState;
  // 工具阶段收束：进入 AggregatingResults。
  aggregateResults(): TurnState;
  // 正常收尾：进入 Completing 并写入 finalResponse、resultType 与 completedAt。
  complete(response: string, resultType?: TurnResultType): TurnState;
  // 异常收尾：直接进入 Error 终态，记录错误与完成时间（跳过相位校验）。
  fail(error: TurnErrorState): TurnState;
  // 纯推断下一步相位，不修改状态；无法判断时原样返回当前相位。
  getNextPhase(): TurnPhase;
  // 是否已处于终态，语义由 turn-state 的 isTerminalPhase 定义。
  isComplete(): boolean;
}

// TurnMachine 的标准实现：不额外持有状态存储，全部“当前值”都在实例的 state 快照上。
// 每个方法返回新对象（浅拷贝 + 必要的数组重建），调用方负责替换引用与持久化。
export class TurnMachineImpl implements TurnMachine {
  state: TurnState;

  // 用已有快照恢复机器（例如从持久化的 turn 状态续跑）；直接持有入参引用，不做深拷贝。
  constructor(state: TurnState) {
    this.state = state;
  }

  // 新建 turn：turnId / traceId 缺省时各自生成；turnNumber 由调用方递增，这里不校验唯一性。
  // traceId 用于把本轮及其子调用挂到同一调用链，缺省自行补一个以保持链路可观测。
  static create(
    sessionId: SessionId,
    turnNumber: number,
    input: string,
    traceId?: TraceId,
    turnId?: TurnId,
  ): TurnMachineImpl {
    const state = createTurnState(
      turnId ?? createTurnId(),
      sessionId,
      turnNumber,
      traceId ?? (crypto.randomUUID() as TraceId),
      input,
    );
    return new TurnMachineImpl(state);
  }

  // 常规相位变更的唯一入口：非法转移抛 InvalidTurnPhase（recoverable=true），不做静默纠正。
  // 返回浅拷贝快照，保证调用方持有的旧引用不会被改写。
  private transition(phase: TurnPhase): TurnState {
    // 相位机是顺序的唯一权威；显式校验能让调用顺序错误尽早暴露，而不是被后续逻辑掩盖。
    if (!canTransitionTo(this.state.phase, phase)) {
      throw createCoreError(
        CoreErrorType.InvalidTurnPhase,
        `Cannot transition from ${this.state.phase} to ${phase}`,
        {
          context: { current: this.state.phase, target: phase },
          recoverable: true,
        },
      );
    }
    return { ...this.state, phase };
  }

  // 起始动作：进入 ProcessingInput，供上层开始采集/解析本轮用户输入。
  start(): TurnState {
    return this.transition(Phase.ProcessingInput);
  }

  // 发起模型请求：只允许从 ProcessingInput 或 AggregatingResults 进入，覆盖首轮与工具后的二次请求。
  // 写入 modelRequest（模型名 + 消息列表）；消息由调用方按上下文构造，本方法不裁剪、不校验。
  startModelRequest(model: string, messages: ModelRequestState["messages"]): TurnState {
    // 其他相位意味着已有在途请求或已收尾，重复发起会覆盖在途状态，因此抛错而不是覆盖。
    if (
      this.state.phase !== Phase.ProcessingInput &&
      this.state.phase !== Phase.AggregatingResults
    ) {
      throw createCoreError(
        CoreErrorType.InvalidTurnPhase,
        "Must be in ProcessingInput or AggregatingResults phase",
        {
          context: { current: this.state.phase },
          recoverable: true,
        },
      );
    }

    const state = this.transition(Phase.AwaitingModelResponse);
    return {
      ...state,
      modelRequest: {
        model,
        messages,
      },
    };
  }

  // 接收模型完整响应（非流式路径）：进入 Streaming 并把正文追加到 streamingContent。
  // 累加语义：多次调用会拼接，调用方需保证同一轮只提交一次完整响应。
  receiveModelResponse(content: string): TurnState {
    const state = this.transition(Phase.Streaming);
    return {
      ...state,
      streamingContent: state.streamingContent + content,
    };
  }

  // 追加一段流式增量：进入 Streaming 并拼接内容；增量到达顺序即拼接顺序。
  // 空串也会触发相位校验，调用方不应把“无 delta”的心跳当成增量。
  addStreamingContent(content: string): TurnState {
    const state = this.transition(Phase.Streaming);
    return {
      ...state,
      streamingContent: state.streamingContent + content,
    };
  }

  // 登记本轮工具调用：进入 SchedulingTools，用入参整体覆盖 toolCalls（不与上一轮合并）。
  // 每个调用统一置 scheduled，scheduledAt 仅作诊断时间戳，不参与调度或排序决策。
  scheduleTools(toolCalls: ToolCall[], schedule: ToolScheduleState): TurnState {
    const state = this.transition(Phase.SchedulingTools);
    return {
      ...state,
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id as ToolCallId,
        name: tc.name,
        input: tc.input,
        status: "scheduled" as TurnState["toolCalls"][number]["status"],
        scheduledAt: new Date(),
      })),
      scheduledTools: schedule,
    };
  }

  // 开始执行工具：只要存在 waiting_permission 的调用就停在 AwaitingPermission，否则进入 ExecutingTools。
  // 已等待授权的调用保留原 startedAt，避免把授权等待时长算进工具执行时长。
  startToolExecution(): TurnState {
    const needsPermission = this.state.toolCalls.some((tc) => tc.status === "waiting_permission");
    // 有调用在等授权时不能进入 ExecutingTools，否则执行器会把它们当成可立即运行的任务。
    const nextPhase = needsPermission ? Phase.AwaitingPermission : Phase.ExecutingTools;

    const state = this.transition(nextPhase);
    return {
      ...state,
      toolCalls: state.toolCalls.map((tc) => ({
        ...tc,
        status:
          tc.status === "waiting_permission"
            ? tc.status
            : ("running" as TurnState["toolCalls"][number]["status"]),
        startedAt: tc.status !== "waiting_permission" ? new Date() : tc.startedAt,
      })),
    };
  }

  // 结清单个工具调用：按 success 置 completed/failed 并写完成时间，同时向 toolResults 追加结果。
  // 找不到 toolCallId 时不报错，toolCalls 保持原样，但仍会追加一条 toolResults 记录（调用方应保证 id 有效）。
  // 失败结果的 error.message 由 content 转文本得到，recoverable 固定 true，本轮可继续下一个工具。
  completeTool(
    toolCallId: ToolCallId,
    result: { success: boolean; content: ModelMessageContent },
  ): TurnState {
    // 失败时把结构化内容拍平成文本供展示与日志；成功路径不解析，省一次转换开销。
    const errorMessage = result.success ? undefined : modelMessageContentToText(result.content);
    const updatedToolCalls = this.state.toolCalls.map((tc) =>
      tc.id === toolCallId
        ? {
            ...tc,
            status: (result.success
              ? "completed"
              : "failed") as TurnState["toolCalls"][number]["status"],
            completedAt: new Date(),
            result: {
              success: result.success,
              content: result.content,
            },
          }
        : tc,
    );

    return {
      ...this.state,
      toolCalls: updatedToolCalls,
      toolResults: [
        ...this.state.toolResults,
        {
          success: result.success,
          content: result.content,
          error: result.success
            ? undefined
            : { type: "tool_error", message: errorMessage ?? "", recoverable: true },
        },
      ],
    };
  }

  // 把 busy 期间的新输入入队：追加语义，不改变相位，也不检查队列上限（admission 由上层负责）。
  queuePendingInput(input: PendingTurnInput): TurnState {
    return {
      ...this.state,
      pendingInputs: [...this.state.pendingInputs, input],
    };
  }

  // 一次性取走全部排队输入并清空队列；返回的 inputs 是原数组引用，调用方不应再就地修改。
  drainPendingInputs(): { inputs: PendingTurnInput[]; state: TurnState } {
    return {
      inputs: this.state.pendingInputs,
      state: {
        ...this.state,
        pendingInputs: [],
      },
    };
  }

  // 登记权限请求：进入 AwaitingPermission，把目标调用置 waiting_permission 并追加到 pendingPermissions。
  // 不校验 toolCallId 是否存在：未知 id 只追加请求、不改调用状态，一致性由上层保证。
  requestPermission(request: PermissionRequestState): TurnState {
    const state = this.transition(Phase.AwaitingPermission);
    return {
      ...state,
      toolCalls: state.toolCalls.map((tc) =>
        tc.id === request.toolCallId
          ? { ...tc, status: "waiting_permission" as TurnState["toolCalls"][number]["status"] }
          : tc,
      ),
      pendingPermissions: [...state.pendingPermissions, request],
    };
  }

  // 结清权限请求：从 pendingPermissions 移除该调用，并连同决策与修改入参记入 resolvedPermissions。
  // deny 时调用状态置 permission_denied；allow 保留原状态；modifiedInput 为 undefined 表示沿用原入参。
  // 不推进相位，后续由 startToolExecution 统一决定是执行还是继续等待。
  resolvePermission(
    toolCallId: ToolCallId,
    decision: PermissionDecision,
    modifiedInput?: unknown,
  ): TurnState {
    const updatedToolCalls = this.state.toolCalls.map((tc) =>
      tc.id === toolCallId
        ? {
            ...tc,
            status:
              // 只有 deny 需要在这里改调用状态；allow 的执行推进交给 startToolExecution，避免两处写状态。
              decision === "deny"
                ? ("permission_denied" as TurnState["toolCalls"][number]["status"])
                : tc.status,
            input: modifiedInput ?? tc.input,
          }
        : tc,
    );

    return {
      ...this.state,
      toolCalls: updatedToolCalls,
      pendingPermissions: this.state.pendingPermissions.filter((p) => p.toolCallId !== toolCallId),
      resolvedPermissions: [
        ...this.state.resolvedPermissions,
        {
          toolCallId,
          decision,
          modifiedInput,
          resolvedAt: new Date(),
        },
      ],
    };
  }

  // 工具阶段收束：进入 AggregatingResults，表示已无 running/waiting_permission 的工具待处理。
  aggregateResults(): TurnState {
    return this.transition(Phase.AggregatingResults);
  }

  // 正常收尾：进入 Completing 并落 finalResponse、resultType（缺省 success）与 completedAt。
  // 不检查是否仍有未完成工具，调用方应先通过 getNextPhase() 判断是否该收尾。
  complete(response: string, resultType: TurnResultType = "success"): TurnState {
    const state = this.transition(Phase.Completing);
    return {
      ...state,
      finalResponse: response,
      resultType,
      completedAt: new Date(),
    };
  }

  // 异常收尾：绕过 transition() 直接置 Error 终态，因为崩溃可能发生在任意中间相位。
  // 覆盖既有 error 字段，不保留上一次错误原因；completedAt 取当前时间。
  fail(error: TurnErrorState): TurnState {
    return {
      ...this.state,
      phase: Phase.Error,
      error,
      completedAt: new Date(),
    };
  }

  // 纯推断下一相位，不修改状态；无法判断时原样返回当前相位，便于调用方无限轮询而不产生副作用。
  // 规则：Streaming 且声明了工具 → SchedulingTools；Streaming 有正文无工具 → Completing；
  // ExecutingTools 且无 running/waiting_permission → AggregatingResults；
  // AggregatingResults 有失败工具 → Completing，否则回到 AwaitingModelResponse 让模型续写。
  getNextPhase(): TurnPhase {
    const { phase, toolCalls, streamingContent } = this.state;

    if (phase === Phase.Streaming && toolCalls.length > 0) {
      // 有工具就先调度：正文已存在 streamingContent 里，不会因为转向调度而丢失。
      return Phase.SchedulingTools;
    }

    if (phase === Phase.Streaming && toolCalls.length === 0 && streamingContent) {
      return Phase.Completing;
    }

    if (phase === Phase.ExecutingTools) {
      const pendingTools = toolCalls.filter(
        (tc) => tc.status === "running" || tc.status === "waiting_permission",
      );
      // 仍有在跑或等授权的工具时留在当前相位，返回自身即可让轮询安全带自旋。
      if (pendingTools.length === 0) {
        return Phase.AggregatingResults;
      }
    }

    if (phase === Phase.AggregatingResults) {
      const failedTools = toolCalls.filter(
        (tc) => tc.status === "failed" || tc.status === "permission_denied",
      );
      // 有失败或拒绝的调用就不再请求模型，直接收尾，避免把失败结果反复喂回形成死循环。
      if (failedTools.length > 0) {
        return Phase.Completing;
      }
      return Phase.AwaitingModelResponse;
    }

    return phase;
  }

  // 终态判定委托给 turn-state 的 isTerminalPhase，避免本类与相位定义出现两套口径。
  isComplete(): boolean {
    return isTerminalPhase(this.state.phase);
  }
}
