import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type CollaborationMode,
} from "@zcode/contracts";

// 计划模式切换判定的输入上下文；调用方直接透传当前会话状态，不做预归一。
interface PlanModeTransitionContext {
  // 本次调用的工具名，只有 EnterPlanMode/ExitPlanMode 会命中判定。
  toolName: string;
  // 当前协作模式；exit 判定在 planEnabled 未显式给出时以它为准。
  mode: CollaborationMode;
  // 显式 plan 能力开关；undefined 时回退到 mode === "plan"。
  planEnabled?: boolean;
  // 进入 plan 之前的模式，预留给恢复逻辑，不参与当前两条判定。
  prePlanMode?: Exclude<CollaborationMode, "plan">;
}

// 内部策略结论：behavior 直接映射为权限决策；reason 供 UI/日志展示，ruleId 用于审计去重。
export interface PlanModeTransitionPermission {
  behavior: "allow" | "deny";
  reason: string;
  ruleId: string;
}

// 对模式切换工具给出内置权限结论：进入 plan 直接放行，退出 plan 仅允许在 plan 生效时。
// 返回 undefined 表示"不是模式切换场景"，交由后续常规规则链继续判定，不视为放行。
// 纯函数，不写状态；allow/deny 的 reason 面向用户展示，ruleId 用于稳定审计。
export function resolvePlanModeTransitionPermission(
  context: PlanModeTransitionContext,
): PlanModeTransitionPermission | undefined {
  if (context.toolName === ENTER_PLAN_MODE_TOOL_NAME) {
    return {
      behavior: "allow",
      reason: "EnterPlanMode switches to plan mode without a permission prompt",
      ruleId: "tool.plan.enter",
    };
  }

  if (
    context.toolName === EXIT_PLAN_MODE_TOOL_NAME &&
    // 只有确认 plan 处于生效状态才允许退出；planEnabled 显式值时优先，否则看当前 mode。
    !(context.planEnabled ?? context.mode === "plan")
  ) {
    return {
      behavior: "deny",
      reason: "ExitPlanMode can only be used while plan mode is active",
      ruleId: "mode.plan.exitOnly",
    };
  }

  return undefined;
}
