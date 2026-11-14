// ============================================================
// executor/permission-input-recheck.ts —— Hook 改写输入后的权限重判
// ============================================================
// 只服务一个场景：PreToolUse / PermissionRequest hook 把入参改掉后，必须按新输入重新判权。
// 与首次判定同源：同一份上下文、同一份 projectRules、同一份 memoryRoot；但不再合并 hook 结论
// （修改本身就来自 hook，且首轮的 allow/ask 已经消费过）。
// 返回口径：{permissionDecision} 表示需要按该结论继续（deny 直接收口 / ask 重新弹窗）；
// 返回 {} 表示"本次改写无需再问"，由调用方（permission-flow）按 allow 收口。
// 不变量：重判不会产生额外授权来源——只用规则 + 能力 + 记忆边界，与首次判定同一套输入。

import { type CollaborationMode, type PermissionRuleset } from "@zcode/contracts";

import type { PermissionDecisionResult, PermissionContext } from "../../permission/service.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { applyMemoryFilePermission, targetsMemoryFile } from "./memory-file-permission.js";
import { resolveRuntimePermissionCapability } from "./permission-capability.js";
import type { ToolExecutorDeps } from "./types.js";

export interface PermissionHookInputRecheckResult {
  permissionDecision?: PermissionDecisionResult;
}

/**
 * 用改写后的输入重跑 checkPermission + 记忆目录收紧，回答"这次改写之后还要不要问用户"。
 * 输入：modifiedInput（已 normalize/validate）、首次判定的上下文与 projectRules。
 * 输出：只携带 permissionDecision 的轻量结果；请求登记/发布/终态仍由 permission-flow 统一处理。
 * 不做 IO、不发事件、不写规则；底层 checkPermission 不抛异常，失败在调用方的重判分支收口。
 */
export function recheckPermissionHookModifiedInput(input: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  mode: CollaborationMode;
  modifiedInput: unknown;
  projectRules: PermissionRuleset | null;
  toolCall: ExecutableToolCall;
  /** 与首次判权同一份上下文（mode、bashShellSelection、cwd 快照），由 executor 构造并透传。 */
  context: ToolRuntimePermissionCapabilityContext & {
    workingDirectory: string;
    workspaceRoot: string;
  };
}): PermissionHookInputRecheckResult {
  // 根因（2026-09-17 review）：此前在此重新构造只含 runtimeScope/cwd 的缩减上下文，丢掉 mode 与
  // bashShellSelection；一旦 guarded 复用重判路径，matcher 会静默失效。上下文只能有一个构造点。
  const { context: runtimePermissionContext } = input;
  const { workingDirectory, workspaceRoot } = runtimePermissionContext;
  // 与首次判定逐字段同源（mode/prePlanMode/planEnabled/riskLevel/cwd）；任何一处漏传都会让 matcher 静默失效。
  const permissionContext: PermissionContext = {
    input: input.modifiedInput,
    mode: input.mode,
    prePlanMode: input.deps.sessionModePort?.getPrePlanMode(),
    planEnabled: input.deps.sessionModePort?.isPlanEnabled?.(),
    riskLevel: input.entry.metadata.riskLevel,
    toolName: input.toolCall.name,
    // 与首次判定同源：hook 改过 input 之后，草稿免确认仍要按同一个工作目录复核。
    workingDirectory,
  };
  const rulePolicy = input.entry.resolvePermissionRulePolicy?.(
    input.modifiedInput,
    runtimePermissionContext,
  );
  let decision = input.deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(input.entry, input.modifiedInput, runtimePermissionContext),
    input.projectRules,
    rulePolicy,
  );
  // Hook 放行也不能绕过记忆目录边界：记忆规则统一在通用判定之后收紧，位置与首次判定一致。
  decision = applyMemoryFilePermission({
    decision,
    executionInput: input.modifiedInput,
    memoryRoot: input.deps.getMemoryRoot?.(),
    toolName: input.toolCall.name,
    workingDirectory,
    workspaceRoot,
  });

  // deny 直接收口：重判只会更严，不需要再问用户。
  if (decision.decision === "deny") {
    return {
      permissionDecision: decision,
    };
  }
  // 只有两类 ask 需要重新发起确认：项目规则兜底 ask、或新输入仍命中记忆目标。
  // 其余 ask 来源（模式兜底、alwaysAsk 等）不在这里回传，调用方会按 allow 收口——这是既有行为，
  // 改动前必须确认不会放过"必须询问"的声明。
  if (
    decision.decision !== "ask" ||
    (decision.ruleId !== "rule.project.ask" &&
      !targetsMemoryFile({
        executionInput: input.modifiedInput,
        memoryRoot: input.deps.getMemoryRoot?.(),
        toolName: input.toolCall.name,
        workingDirectory,
        workspaceRoot,
      }))
  ) {
    return {};
  }

  // 仅返回旧模式需要保留的策略事实；请求登记/发布/终态全部由 executor 统一处理。
  return { permissionDecision: decision };
}
