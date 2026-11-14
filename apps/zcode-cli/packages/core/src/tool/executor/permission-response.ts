// ============================================================
// executor/permission-response.ts —— 审批应答的终态翻译
// ============================================================
// 把 broker/hook 的原始 PermissionBrokerResult 翻译成 permission-flow 的两种转换：
//   complete：得到最终 allowed/denied 结果（含错误形态与 reason 来源）；
//   rewrite：Hook 改写了输入，本轮审批作废，调用方换新 requestId 重判。
// 输入：原始 broker 结果 + 当前 mode/decision/requestId；输出 transition，不写存储、不发事件。
// 不变量：授权只认真实 responder（outcome.source），响应载荷不能自报"用户已批准"；
//   guarded 下所有应答先做结构校验，非法响应一律 InvalidInput（fail-closed，绝不降级放行）。
// 失败语义：deny/escalate 都返回 allowed:false，区别只在错误类型与是否 recoverable。

import {
  CoreErrorType,
  createCoreError,
  type CollaborationMode,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import type { PermissionDecisionResult } from "../../permission/service.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { preparePermissionInput, snapshotPermissionInput } from "./permission-input.js";
import type { PermissionResponderRaceOutcome } from "./permission-responder-race.js";
import type { ToolExecutorDeps } from "./types.js";

export type PermissionFlowResult =
  | {
      allowed: true;
      // 真正进 handler 的输入：可能经 hook 改写、guarded 冻结、或确认窗调整，调用方必须用它执行。
      executionInput: unknown;
      // 本次审批累计等待毫秒；0/缺席表示没等过审批（规则或工具审批门直接放行）。
      permissionWaitMs?: number;
      /** 确认窗里的调整中实际生效的那部分（applyInputAdjustments 的 applied）。 */
      inputAdjustments?: Readonly<Record<string, unknown>>;
    }
  | { allowed: false; result: ToolExecutionResult };

export type PermissionResponseTransition =
  // rewrite：审批针对的是"被改写后的输入"，必须回 while 顶部用新 requestId 再判再问。
  | { kind: "rewrite"; input: unknown }
  // complete：本轮审批已终态，直接返回 allowed 或失败结果。
  | { kind: "complete"; result: PermissionFlowResult };

/** 应答来源取真实 responder；响应载荷不能自行声明授权豁免。 */
export function interpretPermissionResponse(params: {
  deps: ToolExecutorDeps;
  toolCall: ExecutableToolCall;
  entry: ToolEntry;
  input: unknown;
  mode: CollaborationMode;
  decision: PermissionDecisionResult;
  outcome: PermissionResponderRaceOutcome;
  requestId: string;
}): PermissionResponseTransition {
  const { deps, toolCall, entry, mode, decision, outcome, requestId } = params;
  const response = outcome.result;
  // guarded 的应答直接决定"批准了什么字节"，非法结构不能降级放行，必须先校验（fail-closed）。
  if (mode === "guarded")
    validatePermissionResponse(response, decision.approvalMode === "user-once");
  // deny 一旦产生不可被下游放宽；reasonSource 只影响"能否升级为用户消息"，不影响拒绝本身。
  if (response.decision === "deny") {
    return {
      kind: "complete",
      result: {
        allowed: false,
        result: createPermissionErrorResult(
          toolCall,
          response.reason,
          { mode, requestId, ruleId: decision.ruleId, reasonSource: response.reasonSource },
          response.preserveReasonFormatting ? { preserveReasonFormatting: true } : undefined,
        ),
      },
    };
  }
  // escalate 是自动化任务的"交给人"信号：按可恢复错误回灌，turn 仍可继续而不是当成拒绝。
  if (response.decision === "escalate") {
    return {
      kind: "complete",
      result: {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(
            CoreErrorType.PermissionEscalation,
            response.reason ?? "Permission escalation requested",
            {
              context: { mode, requestId, ruleId: decision.ruleId, toolName: toolCall.name },
              recoverable: true,
            },
          ),
        ),
      },
    };
  }
  let input = params.input;
  // modify 只在非 guarded 下由 broker 提供；guarded 的 modifiedInput 也必须重新规范化+校验。
  // 这里的校验失败会抛出，由 permission-flow 的 catch 收口成 PermissionDenied/ToolExecutionFailed。
  if (
    response.decision === "modify" ||
    (mode === "guarded" && response.modifiedInput !== undefined)
  ) {
    input = preparePermissionInput(response.modifiedInput ?? input, entry, deps);
    if (mode === "guarded") {
      input = snapshotPermissionInput(input);
      // 根因：把用户已批准的修改当作 Hook 提案会重复询问；broker 的批准/答案均完成本次请求。
      // 来源取真实 responder，Hook 改写仍重判，不能通过响应载荷自报为用户批准。
      if (outcome.source === "hook") return { kind: "rewrite", input };
    }
  }
  // 其余情况（allow / 非 guarded 的 broker modify）：用户已看到并选择这份输入，直接生效、不再重判。
  return { kind: "complete", result: { allowed: true, executionInput: input } };
}

/**
 * guarded 应答的运行时校验（wire 上是不可信输入）：
 *   - decision 只能是 allow/deny/modify，user-once 时额外禁止 escalate；
 *   - reason 必须是字符串；modify 必须带 modifiedInput；
 *   - user-once 不允许携带任何持久化规则（permissionUpdates/sessionPermissionUpdates）——
 *     一次性确认不能被悄悄升级成永久规则。
 * 失败一律抛 InvalidInput，让调用方按 fail-closed 处理，绝不"校验失败就当 allow"。
 */
function validatePermissionResponse(response: PermissionBrokerResult, once: boolean): void {
  if (
    !response ||
    !["allow", "deny", "modify", ...(once ? [] : ["escalate"])].includes(response.decision) ||
    (response.reason !== undefined && typeof response.reason !== "string") ||
    (response.permissionUpdates !== undefined &&
      (!Array.isArray(response.permissionUpdates) ||
        (once && response.permissionUpdates.length > 0))) ||
    (response.decision === "modify" && response.modifiedInput === undefined) ||
    (response.sessionPermissionUpdates !== undefined &&
      (!Array.isArray(response.sessionPermissionUpdates) ||
        (once && response.sessionPermissionUpdates.length > 0)))
  ) {
    // 结构与策略错误统一为 InvalidInput：guarded 里任何"不确定"都不能被理解为批准。
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "Invalid permission response; single-use requests cannot persist project rules",
      { recoverable: true },
    );
  }
}
