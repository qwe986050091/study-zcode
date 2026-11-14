// 权限请求到 TUI 审批队列的桥接。
// 职责：把 broker 请求包装为 ApprovalPrompt，处理取消失败与交互式提问态。
// 边界：只做客户端应答，不改 core 的 alwaysAsk 语义与权限事件。
// 副作用：写审批队列与状态栏；resolve/reject 必须且只能调用一次。
// 失败语义：AskUserQuestion schema 校验失败直接 deny；signal 已中止立刻 reject。
// 例外：CreateWorkflow/AmendWorkflow 在客户端应答层自动放行，且不写 permissionUpdates。

import {
  AMEND_WORKFLOW_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionInputSchema,
  CREATE_WORKFLOW_TOOL_NAME,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import type React from "react";
import type { ApprovalPrompt } from "./app-model.js";
import { createQuestionPromptState } from "./app-question-state.js";
import type { TuiRequestPermission } from "./types.js";

/**
 * CreateWorkflow 的确认 gate 在 CLI 侧自动放行。
 *
 * 这是**记录在案的 CLI 例外**（user 裁定：
 * 终端用户已经在命令行语境里，摩擦大于保护）。旁路只在客户端应答层：core 的 `alwaysAsk` 语义、
 * hook 次序、权限事件、桌面确认窗全部不动。
 *
 * **绝不带 permissionUpdates**：那会持久化一条 allow 规则，把「跳过一次确认」变成真的授权。
 * gate 旁路不等于权限旁路——run 里的 actor 仍继承会话的权限 profile。
 */
function createWorkflowBypassResult(toolName: string): PermissionBrokerResult {
  return {
    decision: "allow",
    reason: `${toolName} auto-allowed in CLI (confirmation gate bypass)`,
    resolvedAt: new Date(),
  };
}

// 创建 TUI 权限请求器：把 broker 请求转为审批弹窗，并返回只 settle 一次的 Promise。
// 输出：resolve 为 allow/deny/modify 结果；reject 仅用于取消或内部失败。
// 副作用：写审批队列与状态栏；注册 signal abort 监听，结束或清理时移除。
// 降级：AskUserQuestion 输入校验失败直接 deny，不渲染弹窗。
export function createTuiPermissionRequester(input: {
  setApprovalQueue: React.Dispatch<React.SetStateAction<ApprovalPrompt[]>>;
  setStatus: (status: string) => void;
}): TuiRequestPermission {
  return (request, requestOptions) =>
    new Promise<PermissionBrokerResult>((resolve, reject) => {
      if (requestOptions?.signal?.aborted) {
        reject(new Error("Permission request cancelled"));
        return;
      }

      // 审批旁路：在建 approval 之前短路，所以审批面板根本不会被渲染（setApprovalQueue 不被触碰）。
      // AmendWorkflow 与 CreateWorkflow 同一道门、同一条例外。
      if (
        request.toolName === CREATE_WORKFLOW_TOOL_NAME ||
        request.toolName === AMEND_WORKFLOW_TOOL_NAME
      ) {
        resolve(createWorkflowBypassResult(request.toolName));
        return;
      }

      let settled = false;
      let approval: ApprovalPrompt;
      const parsedQuestion =
        request.toolName === ASK_USER_QUESTION_TOOL_NAME
          ? AskUserQuestionInputSchema.safeParse(request.input)
          : undefined;

      if (parsedQuestion && !parsedQuestion.success) {
        resolve({
          decision: "deny",
          reason: `Invalid AskUserQuestion input: ${
            parsedQuestion.error.issues[0]?.message ?? "schema validation failed"
          }`,
          resolvedAt: new Date(),
        });
        return;
      }

      const cleanup = () => {
        requestOptions?.signal?.removeEventListener("abort", abortHandler);
      };
      const settle = (result: PermissionBrokerResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          ...result,
          resolvedAt: result.resolvedAt ?? new Date(),
        });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abortHandler = () => {
        input.setApprovalQueue((current) => current.filter((item) => item !== approval));
        fail(new Error("Permission request cancelled"));
      };

      approval = {
        cleanup,
        questionState: parsedQuestion?.success
          ? createQuestionPromptState(parsedQuestion.data)
          : undefined,
        reject: fail,
        request,
        resolve: settle,
        selectedDecision: "deny",
      };

      requestOptions?.signal?.addEventListener("abort", abortHandler, { once: true });
      input.setApprovalQueue((current) => [...current, approval]);
      input.setStatus(
        approval.questionState
          ? "Answer the clarification question."
          : `Approval required for ${request.toolName}.`,
      );
    });
}
