/**
 * ============================================================================
 * hooks/output.ts —— Hook 输出的语义归一与多 hook 结果合并
 * ============================================================================
 *
 * hook 可返回 continue / decision / hookSpecificOutput 三种形状;本文件把它们
 * 折叠成统一的 HookRunResult,再交给 hook-flow 决定最终权限与阻断行为。
 *
 * 【不变量 #3】hook 只能收紧:allow 只是"不提新要求",deny 一旦出现不可撤销;
 * 合并按 deny > ask > 后续值,后跑的 hook 不能把前一个 hook 的 deny 洗掉。
 * 【形状校验】hookSpecificOutput 的事件名必须与当前事件一致,否则直接报错,
 * 防止用别的事件的字段影响本事件决策（链路 9 的 fail closed 取向）。
 * ============================================================================
 */
import {
  CoreErrorType,
  HookEventName,
  createCoreError,
  type HookJSONOutput,
  type HookPermissionDecision,
  type HookSpecificOutput,
} from "@zcode/contracts";
import type { HookRunResult } from "./types.js";

export function processHookOutput(
  expectedEvent: HookEventName,
  output: HookJSONOutput | void,
): HookRunResult {
  const result: HookRunResult = {
    additionalContexts: [],
  };
  // hook 没有输出(脚本静默退出)等于"不发表意见":返回空结果,
  // 不能默认放行,也不能默认阻断。
  if (!output) return result;

  // continue=false 是"停止本次请求";Stop 事件语义相反(此时 continue=true 才是续跑),
  // 所以这里必须排除 Stop,否则会把"停止"错读成"继续"。
  if (output.continue === false && expectedEvent !== HookEventName.Stop) {
    result.blockRequested = true;
    result.stopReason = output.stopReason ?? output.reason;
    // 只有会触发后续动作的事件才需要"阻止继续";PostToolUse 之类的阻断止于本步。
    if (shouldPreventContinuation(expectedEvent)) {
      result.preventContinuation = true;
    }
    // 权限事件收到 continue=false 必须落成 deny:只 block 不 deny 会留下
    // "被拦下但仍可批准"的口子（不变量 #3）。
    if (isPermissionEvent(expectedEvent)) {
      result.permissionBehavior = "deny";
    }
  }
  // Stop 事件里 continue=true 表示"别停,继续跑":由 stopShouldContinue 驱动续轮。
  if (expectedEvent === HookEventName.Stop && output.continue === true) {
    result.stopShouldContinue = true;
    result.stopReason = output.stopReason ?? output.reason;
  }
  // approve 只对权限事件有效;其它事件上的 approve 不能被当成权限放行,
  // 否则 hook 可借普通事件绕过权限面（不变量 #3）。
  if (output.decision === "approve" && isPermissionEvent(expectedEvent)) {
    result.permissionBehavior = "allow";
  }
  if (output.decision === "block") {
    result.blockRequested = true;
    result.stopReason = output.stopReason ?? output.reason ?? output.systemMessage;
    if (isPermissionEvent(expectedEvent)) result.permissionBehavior = "deny";
    if (shouldPreventContinuation(expectedEvent)) result.preventContinuation = true;
    // Stop 上的 block 语义是"不许结束":转成续跑,并把给模型的说明并入上下文。
    if (expectedEvent === HookEventName.Stop) {
      result.stopShouldContinue = true;
      if (output.systemMessage) result.additionalContexts.push(output.systemMessage);
      if (output.reason) result.additionalContexts.push(output.reason);
    }
  }
  // 兼容两种命名:snake_case 来自外部脚本,camelCase 是内部主契约,都要收。
  if (output.additionalContext) result.additionalContexts.push(output.additionalContext);
  if (output.additional_context) result.additionalContexts.push(output.additional_context);

  const specific = output.hookSpecificOutput;
  if (!specific) return result;
  if (specific.hookEventName !== expectedEvent) {
    // 事件名不一致视为 hook 契约错误:宁可直接失败,也不让错事件的字段参与决策。
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Hook returned wrong event name", {
      context: {
        expectedEvent,
        hookEventName: specific.hookEventName,
      },
      recoverable: true,
    });
  }

  applyHookSpecificOutput(result, specific);
  return result;
}

export function mergeHookRunResult(target: HookRunResult, next: HookRunResult): void {
  // 上下文只做追加:任何 hook 的补充说明都不能覆盖已有内容。
  target.additionalContexts.push(...next.additionalContexts);
  // 阻断只增不减:once blocked 不会被后续 hook 的输出撤销。
  if (next.blockRequested) {
    target.blockRequested = true;
    target.stopReason = next.stopReason ?? target.stopReason;
  }
  // stopReason 随 preventContinuation 一起更新,保证阻断原因与触发点对应。
  if (next.preventContinuation) {
    target.preventContinuation = true;
    target.stopReason = next.stopReason;
  }
  // Stop 续跑是后写覆盖:后续 hook 可以决定"这轮到底还跑不跑"。
  if (next.stopShouldContinue !== undefined) {
    target.stopShouldContinue = next.stopShouldContinue;
    target.stopReason = next.stopReason ?? target.stopReason;
  }
  // updatedInput 以后写为准:后跑的 hook 看到的是已修改输入,它再改才有效。
  if (next.updatedInput !== undefined) {
    target.updatedInput = next.updatedInput;
  }
  if (next.permissionRequestResult) {
    target.permissionRequestResult = next.permissionRequestResult;
  }
  if (next.hookPermissionDecisionReason) {
    target.hookPermissionDecisionReason = next.hookPermissionDecisionReason;
  }
  // 权限结论必须走单调合并,不能简单覆盖——否则后一个 allow 会洗掉前一个 deny。
  if (next.permissionBehavior) {
    target.permissionBehavior = mergePermissionBehavior(
      target.permissionBehavior,
      next.permissionBehavior,
    );
  }
}

export function matchesHookMatcher(
  matchValue: string | undefined,
  matcher: string | undefined,
): boolean {
  // 无 matcher 或 "*" 表示该事件全匹配;此时不再要求 matchValue 存在。
  if (!matcher || matcher === "*") return true;
  // 有 matcher 却没有可匹配值:判为不匹配,避免空值被当作"全部命中"。
  if (!matchValue) return false;
  // 纯单词/竖线形式按枚举列表精确比较(工具名场景),不做子串匹配。
  if (/^[a-zA-Z0-9_|]+$/u.test(matcher)) {
    return matcher.split("|").includes(matchValue);
  }
  try {
    // 其余按正则处理;非法正则返回 false,等价于该 hook 不参与本次运行(fail closed)。
    return new RegExp(matcher).test(matchValue);
  } catch {
    return false;
  }
}

function isPermissionEvent(event: HookEventName): boolean {
  // 只有这两个事件承载权限判定;其它事件里的 allow/deny 字段一律不映射为权限结论。
  return event === HookEventName.PreToolUse || event === HookEventName.PermissionRequest;
}

function applyHookSpecificOutput(result: HookRunResult, specific: HookSpecificOutput): void {
  // 按事件类型只取该事件允许的字段:veto 与输入修改都必须在正确的事件语义下解释。
  switch (specific.hookEventName) {
    case HookEventName.PreToolUse:
      // hook 给出的 permissionDecision 只是收紧建议;updatedInput 是候选输入,
      // 之后仍要重新过权限规则,guarded 模式还会冻结输入（不变量 #3）。
      if (specific.permissionDecision) {
        result.permissionBehavior = specific.permissionDecision;
        result.hookPermissionDecisionReason = specific.permissionDecisionReason;
      }
      if ("updatedInput" in specific && specific.updatedInput !== undefined) {
        result.updatedInput = specific.updatedInput;
      }
      if (specific.additionalContext) result.additionalContexts.push(specific.additionalContext);
      break;
    case HookEventName.PermissionRequest:
      // 这是审批流里的一个答复,不是最终权限结论;由权限流合并后再生效。
      if (specific.decision) {
        result.permissionRequestResult = specific.decision;
      }
      break;
    case HookEventName.PostToolUse:
    case HookEventName.PostToolUseFailure:
    case HookEventName.UserPromptSubmit:
    case HookEventName.SessionStart:
    case HookEventName.Stop:
      // 这些事件只允许追加上下文;任何权限字段都不在此解析,避免越权。
      if (specific.additionalContext) result.additionalContexts.push(specific.additionalContext);
      break;
  }
}

function mergePermissionBehavior(
  current: HookPermissionDecision | undefined,
  next: HookPermissionDecision,
): HookPermissionDecision {
  // deny 优先:任一侧 deny 即 deny,与合并顺序无关（不变量 #3 的"不可放宽"）。
  if (current === "deny" || next === "deny") return "deny";
  // ask 次优先:allow 不能把已存在的 ask 降级成放行。
  if (current === "ask" || next === "ask") return "ask";
  // 两侧都不含 deny/ask 时以后者为准(allow 覆盖 allow,或首次出现值)。
  return next;
}

function shouldPreventContinuation(event: HookEventName): boolean {
  // 只在这三个"会开启后续动作"的事件上阻断继续;
  // PostToolUse/Stop 的阻断由各自语义表达,不能复用这一位。
  return (
    event === HookEventName.PreToolUse ||
    event === HookEventName.PermissionRequest ||
    event === HookEventName.UserPromptSubmit
  );
}
