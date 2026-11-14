// ============================================================
// 确认窗里的入参调整：授权之后、handler 之前的那一步
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// broker 把用户在确认窗里改过的字段放在结果的 `inputAdjustments` 上；这里把它交给工具自己的
// `applyInputAdjustments`，换回调整后的入参。放在 permission flow 的尾部而不是 handler 里，是因为
// 调整属于「用户批准了什么」，而 handler 只该面对一份已经落定的入参——与 `resolveInput` 同一条理由。
//
// 输出口径：ok=false 时携带可直接回灌模型的 ToolExecutionResult（handler 不跑）；
// ok=true 且带 applied 时只含"实际生效的字段"（与入参原值相同的改动不算）。
// 不变量：调整只发生在 allow 之后；未声明 applyInputAdjustments 的工具忽略调整、仍按原入参执行。

import { traceContextToLogContext, type TraceContext } from "@zcode/contracts";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolExecutionResult,
  ToolInputResolutionContext,
} from "../types.js";
import {
  createErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
} from "./errors.js";
import type { ToolExecutorDeps } from "./types.js";

export type PermissionInputAdjustmentOutcome =
  | { ok: true; executionInput: unknown; applied?: Readonly<Record<string, unknown>> }
  | { ok: false; result: ToolExecutionResult };

/**
 * `resolveInput` 与 `applyInputAdjustments` 共用的上下文。两处读的必须是同一组端口：确认窗之前按
 * 这份目录解析过的模型，批准之后也按这份目录再解析一遍。
 */
export function buildToolInputResolutionContext(
  deps: ToolExecutorDeps,
): ToolInputResolutionContext {
  const workingDirectory = deps.getWorkingDirectory?.();
  return {
    // 每次现取 cwd：批准与执行之间目录可能变化，必须与 resolveInput 同源。
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    runtimeTaskRegistry: deps.runtimeTaskRegistry,
    // 可选端口只在存在时才透传：缺席让工具走自己的降级路径，而不是收到一个 undefined 字段。
    ...(deps.dynamicWorkflowRunPort === undefined
      ? {}
      : { dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort }),
    ...(deps.modelCatalogPort === undefined ? {} : { modelCatalogPort: deps.modelCatalogPort }),
    sessionId: deps.sessionId,
    ...(deps.hasLoadedSkill === undefined ? {} : { hasLoadedSkill: deps.hasLoadedSkill }),
  };
}

/**
 * 授权之后、handler 之前应用确认窗里的入参调整。
 * 输入 adjustments 是 broker 的 `inputAdjustments`（键为工具入参字段名），为空即原样返回。
 * 副作用：调用工具的 applyInputAdjustments（约定为纯计算、只读已有端口、不做 IO）与 info/warn 日志。
 * 失败语义：工具返回 ToolHandlerFailure 时转成错误结果，handler 不执行；工具未声明该能力时
 * 忽略调整并保留原入参——用户批准的仍是这次调用，不能因此替他拒绝。
 */
export function applyPermissionInputAdjustments(options: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  toolCall: ExecutableToolCall;
  executionInput: unknown;
  adjustments: Readonly<Record<string, unknown>> | undefined;
  traceContext: TraceContext;
}): PermissionInputAdjustmentOutcome {
  const { adjustments, deps, entry, executionInput, toolCall, traceContext } = options;
  // 没有调整就没有第二步：保持入参引用不变，避免无谓复制。
  if (adjustments === undefined || Object.keys(adjustments).length === 0) {
    return { ok: true, executionInput };
  }
  const logContext = {
    ...traceContextToLogContext(traceContext),
    adjustedKeys: Object.keys(adjustments),
    module: "core.tool.executor",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
  };
  if (!entry.applyInputAdjustments) {
    // broker 只为声明了这一步的工具合成调整；走到这里说明 broker 与工具声明不同步。照原入参执行
    // 并留痕，而不是替用户拒绝一次他已经批准的调用。
    deps.logger?.warn("Permission input adjustments ignored: the tool does not apply them", {
      ...logContext,
      event: "tool.permission.input_adjustments_ignored",
      status: "completed",
    });
    return { ok: true, executionInput };
  }
  const outcome = entry.applyInputAdjustments(
    executionInput,
    adjustments,
    buildToolInputResolutionContext(deps),
  );
  if (isToolHandlerFailure(outcome)) {
    // 调整失败即工具失败：不能带着半套配置执行，也不把失败降级成"按原入参跑"。
    deps.logger?.warn("Permission input adjustments rejected", {
      ...logContext,
      errorCode: outcome.errorCode,
      event: "tool.permission.input_adjustments_rejected",
      status: "failed",
    });
    return {
      ok: false,
      result: createErrorResult(toolCall, createToolHandlerFailureError(toolCall, outcome)),
    };
  }
  deps.logger?.info("Permission input adjustments applied", {
    ...logContext,
    appliedKeys: Object.keys(outcome.applied ?? {}),
    event: "tool.permission.input_adjustments_applied",
    status: "completed",
  });
  return {
    ok: true,
    executionInput: outcome.input,
    // 只透传 applied（实际生效的键）：UI/审计据此展示"哪些值被改过"，而不是把整份调整回显。
    ...(outcome.applied === undefined ? {} : { applied: outcome.applied }),
  };
}
