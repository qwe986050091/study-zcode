/**
 * ============================================================================
 * executor/turn-control.ts —— 工具结果对 turn 的控制语义
 * ============================================================================
 *
 * 某些工具结果不只是"成功/失败",还会影响整个 turn 如何收口:
 *   automation_create_limit  创建定时任务达到上限 → 本 turn 降级纯文本,停止后续工具;
 *   plan_exit_denied         用户拒绝退出计划 → 停止 turn(避免模型自我重写计划);
 *   subagent_terminal        终态工具(submit_result 等)成功 → 立即结束 actor 的 turn;
 *   workflow_refine_feedback 运行确认被 Refine → 反馈升级为后续 user 输入(turn 继续)。
 *
 * 这些控制都以 turnControl / followUpUserInput 字段挂在 ToolExecutionResult 上,
 * 由 turn-tools.ts 的 settlement 读取并执行。
 * ============================================================================
 */
import {
  isAutomationCreateLimitError,
  CoreErrorType,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type CollaborationMode,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionResult } from "../types.js";

// 默认的 "Permission denied for ExitPlanMode" 文案会被当作"没有用户反馈"的哨兵:
// 用户直接点拒绝(而非输入修改意见)时,broker 返回的就是这句默认文案,
// 若把它升级成 followUpUserInput,模型会把系统文案当作用户新指令。
const DEFAULT_EXIT_PLAN_DENIED_MESSAGE = `Permission denied for ${EXIT_PLAN_MODE_TOOL_NAME}`;
const EXIT_PLAN_DENIED_BY_USER_MESSAGE = "The plan was not approved by the user.";
const WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE = "The workflow run was not approved by the user.";
const AUTOMATION_CREATE_LIMIT_MODEL_MESSAGE =
  "Automation creation was not performed because the global retained-task limit of 20 was reached. " +
  "This limit cannot be recovered automatically in the current turn. Do not list, delete, overwrite, " +
  "retry, or use another tool. Reply once in the user's language that they must manually delete an " +
  "existing task on the Automations page and then retry.";

/**
 * automation 创建上限:把原始错误替换成"请用户手动删除任务"的模型文案,
 * 并设置 stopTurnAfterResult,避免模型继续 List/Delete/Create 或尝试 Bash 绕过。
 *
 * 三个守卫缺一不可:
 *   - result.success:只有失败分支才可能带 limit 错误;
 *   - toolName === "CronCreate":其它工具也可能抛出同类业务码,不能误停 turn;
 *   - isAutomationCreateLimitError:按错误码而非文案判断,避免本地化文案漂移。
 */
export function withAutomationCreateLimitTurnStop(
  result: ToolExecutionResult,
  input: { error: unknown; toolName: string },
): ToolExecutionResult {
  if (
    result.success ||
    input.toolName !== "CronCreate" ||
    !isAutomationCreateLimitError(input.error)
  ) {
    // 不命中三条件时原样返回：只有 CronCreate 的 limit 错误才需要停 turn，
    // 其他工具的同类错误码或成功结果都走正常 settlement。
    return result;
  }

  // 创建上限是需要用户手动释放名额的产品边界，不是 Agent 可恢复错误。
  // 给模型隐藏带有“Delete...”诱导性的原始错误，并请求 executor 取消当前 step 的后续工具。
  return {
    ...result,
    modelContent: AUTOMATION_CREATE_LIMIT_MODEL_MESSAGE,
    turnControl: {
      reason: "automation_create_limit",
      stopTurnAfterResult: true,
    },
  };
}

/**
 * ExitPlanMode 被拒绝:
 *   - 若反馈是用户自定义输入 → 升级为 followUpUserInput(经 steer 成为真实 user 消息);
 *   - 否则停止 turn:拒绝退出计划代表用户还想讨论,不能让模型自行重写计划后重试。
 */
export function withPlanExitDeniedTurnStop(
  result: ToolExecutionResult,
  input: {
    mode: CollaborationMode;
    planEnabled?: boolean;
    toolName: string;
  },
): ToolExecutionResult {
  if (
    // planEnabled 显式值时优先于 mode 推断:port 缺失时才退回 mode === "plan",
    // 因为同一个会话可能"退出 plan 但预模式仍生效"。
    !(input.planEnabled ?? input.mode === "plan") ||
    input.toolName !== EXIT_PLAN_MODE_TOOL_NAME ||
    result.success
  ) {
    // 非 plan 模式/非 ExitPlanMode/成功 都不处理：只有"在 plan 模式下调用 ExitPlanMode 且被拒"
    // 才需要停止 turn，避免模型被拒后自行重写计划绕过用户决定。
    return result;
  }

  const feedback = readPlanExitDeniedFeedback(result);
  if (feedback) {
    // 用户输入了修改意见：升级为 followUpUserInput，经 steer 成为真实 user message，
    // 让模型按意见修订计划而不是当作普通错误重试。
    return {
      ...result,
      followUpUserInput: {
        input: feedback,
        reasonSource: "plan_approval_feedback",
      },
      // feedback 会通过 steer 成为真实 user message；tool_result 只能表达计划被拒绝，
      // 不能承诺反馈一定跟随，否则 steer 被拒绝时 provider 会看到不存在的后续 user message。
      modelContent: EXIT_PLAN_DENIED_BY_USER_MESSAGE,
    };
  }

  // 拒绝退出计划代表用户要继续讨论，不能把它当普通工具错误继续喂给模型自我重写计划。
  return {
    ...result,
    turnControl: {
      reason: "plan_exit_denied",
      stopTurnAfterResult: true,
    },
  };
}

function readPlanExitDeniedFeedback(result: ToolExecutionResult): string | undefined {
  // 只处理 PermissionDenied：其他错误类型（如 schema 失败、超时）不携带用户反馈，
  // 读 reasonSource 会拿到 undefined，直接返回即可。
  if (result.error?.type !== CoreErrorType.PermissionDenied) {
    return undefined;
  }
  // project rule / hook / broker 也可能返回 deny + reason；
  // 只有 ExitPlanMode 审批自定义输入带上的专用 source 才能被解释为用户修改意见。
  // 否则模型会把"被规则拦截"的 reason 当成"用户在给我提需求"。
  if (result.error.reasonSource !== "plan_approval_feedback") {
    return undefined;
  }
  const message = result.error.message.trim();
  // 空消息与默认哨兵都视为"用户只是拒绝,没有额外意见":
  // 前者没有可升级内容,后者是 broker 的系统文案,不能伪装成用户输入。
  // 若误升级为 followUpUserInput，模型会把系统默认文案当作用户指令执行。
  if (!message || message === DEFAULT_EXIT_PLAN_DENIED_MESSAGE) {
    return undefined;
  }
  return message;
}

/**
 * workflow 运行确认窗的 Refine 应答。
 * 与 withPlanExitDeniedTurnStop 同构但更窄：只有反馈升级，没有停 turn 分支——
 * 普通 Deny 沿用既有语义（喂标准权限错误，turn 继续），反馈经 steer 成为真实
 * user message 后模型在同一 turn 内修订脚本重提，重提自然触发新一轮确认。
 * 不按 mode 键入：CreateWorkflow 的 ask 本就无视模式（alwaysAsk）。
 */
export function withWorkflowRefineDeniedFollowUp(
  result: ToolExecutionResult,
  input: { toolName: string },
): ToolExecutionResult {
  if (
    (input.toolName !== CREATE_WORKFLOW_TOOL_NAME && input.toolName !== AMEND_WORKFLOW_TOOL_NAME) ||
    result.success
  ) {
    // 非 workflow 创建/修订工具或成功结果都不处理：
    // 只有这两个工具的确认窗才会产生 Refine 反馈，成功则无需反馈。
    return result;
  }
  const feedback = readWorkflowRefineDeniedFeedback(result);
  if (!feedback) {
    // 没有用户反馈时原样返回：普通 Deny 走标准权限错误语义，turn 继续，
    // 模型会收到 PermissionDenied 并自行决定是否重试。
    return result;
  }
  return {
    ...result,
    followUpUserInput: {
      input: feedback,
      reasonSource: "workflow_refine_feedback",
    },
    // tool_result 只能表达运行未获批准，不能承诺反馈一定跟随，
    // 否则 steer 被拒绝时 provider 会看到不存在的后续 user message。
    modelContent: WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE,
  };
}

function readWorkflowRefineDeniedFeedback(result: ToolExecutionResult): string | undefined {
  if (result.error?.type !== CoreErrorType.PermissionDenied) {
    return undefined;
  }
  // 同 readPlanExitDeniedFeedback：hook / project rule 的 deny + reason 不带该专用 source，
  // 不得被升级成用户消息。
  if (result.error.reasonSource !== "workflow_refine_feedback") {
    return undefined;
  }
  const message = result.error.message.trim();
  return message || undefined;
}

// submit_result 之类的终态工具在其 ToolEntry.metadata 上声明 stopTurnOnSuccess=true：它们的
// 成功结果表示一次终态提交，必须结束 actor 的 turn。这里读声明式 metadata，而不是按工具名硬编码
// ——终态是一种一般性的内在能力（任何未来的终态工具都可复用），与失败侧
// withPlanExitDeniedTurnStop / withAutomationCreateLimitTurnStop 按 tool 特定 error/state 键入的
// 条件性 stop 不同。这些工具的 handler 保证成功⟺该终止（gate 抛错、reject 走失败），故无需
// handler 侧信号通道。
/**
 * 终态工具(stopTurnOnSuccess=true)成功即结束 turn。
 * 读取的是声明式 metadata,而不是按工具名硬编码,方便未来新增终态工具复用。
 */
export function withTerminalToolTurnStop(
  result: ToolExecutionResult,
  input: { entry: ToolEntry },
): ToolExecutionResult {
  // 只看"成功 + 声明"两个条件:
  //   - 失败时 handler 已经保证了不构成终态提交(gate 抛错/reject 走失败路径);
  //   - stopTurnOnSuccess 是工具级声明,不按名字硬编码,未来新增终态工具无需改这里。
  // 任一条件不满足都原样返回：非终态工具的成功结果不应该意外停 turn。
  if (!result.success || input.entry.metadata.stopTurnOnSuccess !== true) {
    return result;
  }
  return {
    ...result,
    turnControl: {
      reason: "subagent_terminal",
      stopTurnAfterResult: true,
    },
  };
}
