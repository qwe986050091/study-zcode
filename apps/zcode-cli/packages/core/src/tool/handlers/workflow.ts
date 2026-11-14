/**
 * ============================================================================
 * tool/handlers/workflow.ts —— legacy Workflow 工具（脚本编排子会话）
 * ============================================================================
 *
 * 【定位】启动或恢复一个"确定性脚本工作流"：脚本由 WorkflowPort 解释执行，
 * 内部按脚本编排多个 child agent。与动态工作流（CreateWorkflow/AmendWorkflow）
 * 是两套东西：本工具是 legacy `Workflow`，任务类型 local_workflow，
 * 不可取消（取消分派里会落到 unsupported）。
 *
 * 【off-peak 禁止】assertNotOffPeakTurn：闲时轮里 Workflow 的脚本子会话
 * 按父会话常驻选择建模型，会落到用户 Coding Plan，因此整类拒绝，
 * 并提示改用前台 Agent 调用。
 *
 * 【端口缺失】WorkflowPort 未配置（精简 runtime）→ ConfigurationError，
 * 不静默返回空结果。
 * ============================================================================
 */

import {
  CoreErrorType,
  WorkflowInputJsonSchema,
  WorkflowInputSchema,
  WorkflowOutputJsonSchema,
  WorkflowOutputSchema,
  createCoreError,
  type TraceContext,
  type WorkflowInput,
} from "@zcode/contracts";
import type { ModelMessageContent } from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { WORKFLOW_TOOL_DESCRIPTION } from "./workflow-description.js";
import { assertNotOffPeakTurn } from "./off-peak.js";

const WORKFLOW_TOOL_NAME = "Workflow";
/**
 * D52：Workflow 的脚本子会话由 script-workflow-child-runtime 按父会话常驻选择建模型，
 * 不携带闲时轮的 modelExecution，同样会落到用户 Coding Plan，闲时轮内一并拒绝。
 */
const OFF_PEAK_WORKFLOW_HINT = "Run the child work with foreground Agent calls instead.";

const WORKFLOW_LAUNCH_TIMEOUT_MS = 30_000;
const WORKFLOW_MODEL_BYTES = 24_000;

/**
 * 启动/恢复脚本工作流。
 *
 * 透传给 WorkflowPort.start 的上下文包含：parentToolCallId（用于把子会话活动
 * 归属到本次工具调用）、sessionId、trace、turnId、workingDirectory/workspaceRoot。
 * 取消通过 context.abortSignal 传递，端口负责在收到信号后终止脚本子会话。
 *
 * 失败语义：off-peak 轮先被拒绝（业务失败，recoverable）；端口缺席抛 ConfigurationError
 * （不可恢复，说明宿主装配缺了一块）；端口 start 抛出的错误原样上抛，由 executor 收成这次
 * tool_call 的失败结果——三条路径都不会返回一个「假的空 run」，不变量 1 因此保持。
 * 副作用：创建后台脚本子会话（属于 workspace/进程内资源，不是立即写入的 durable 事实）。
 */
const workflowHandler: ToolHandler = async (input, context) => {
  const parsed = WorkflowInputSchema.parse(input) as WorkflowInput;
  // 闲时轮检查放在端口检查之前：即使端口齐全，这类子会话也会用用户 Coding Plan 建模型，
  // 属于「无论宿主怎么装配都必须拒绝」的规则，先于能力检查。
  assertNotOffPeakTurn(context, WORKFLOW_TOOL_NAME, {
    hint: OFF_PEAK_WORKFLOW_HINT,
    recoverable: true,
  });
  // 端口缺席是宿主装配问题（精简 runtime），recoverable=false：换参数重试没有意义。
  if (!context.workflowPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "WorkflowPort is not configured for Workflow tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: WORKFLOW_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return context.workflowPort.start(
    {
      ...parsed,
      parentToolCallId: context.toolCallId,
      sessionId: context.sessionId,
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sessionId: context.sessionId,
        turnId: context.turnId,
      } as TraceContext,
      turnId: context.turnId,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    },
    { signal: context.abortSignal },
  );
};

/**
 * legacy Workflow 的工具注册项。
 *
 * 关键口径（与动态工作流 CreateWorkflow 刻意不同）：
 *   - `destructive: true` / `riskLevel: "high"` / `needsApproval`：脚本会派生多个可写子会话，
 *     属于高影响动作；`alwaysAsk` 未设置，允许项目级规则持久化。
 *   - `timeoutMs` 30s **只覆盖启动**，不覆盖后台 run；`cancellation.supported: true` 指启动
 *     阶段可取消，取消后若还没拿到 runId 会给用户一句明确提示。
 *   - `maxOutputBytes` 24k 是启动回执的模型面预算，不是 run 产物预算。
 */
export const workflowToolEntry: ToolEntry = {
  capability:
    "Start or resume a deterministic script workflow that orchestrates multiple child agent sessions",
  metadata: {
    name: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    timeoutMs: WORKFLOW_LAUNCH_TIMEOUT_MS,
    maxOutputBytes: WORKFLOW_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
  },
  handler: workflowHandler,
  inputSchema: WorkflowInputJsonSchema,
  outputSchema: WorkflowOutputJsonSchema,
  runtimeInputSchema: WorkflowInputSchema,
  runtimeOutputSchema: WorkflowOutputSchema,
  formatModelContent: formatWorkflowModelContent,
  permission: {
    permission: "workflow",
    reason:
      "Workflow launches background child agents that may perform workspace-mutating work in yolo mode",
    riskLevel: "high",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: WORKFLOW_MODEL_BYTES,
    maxModelBytes: WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: WORKFLOW_LAUNCH_TIMEOUT_MS,
    maxMs: WORKFLOW_LAUNCH_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Workflow launch was cancelled before a run id was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// 启动回执的模型面渲染：首行带 status 与 runId（后续 Get/List 都靠它），scriptPath 只在
// 有时出现，response 是端口给的人类文案。schema 不合法时给一句固定失败文案而不是 JSON——
// 启动回执很短，把原始对象塞给模型只会增加噪声且可能含内部字段。
function formatWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = WorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "Workflow launch returned an invalid result.";

  const lines = [
    `Workflow ${parsed.data.status}: ${parsed.data.runId}`,
    parsed.data.scriptPath ? `scriptPath: ${parsed.data.scriptPath}` : undefined,
    parsed.data.response,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}
