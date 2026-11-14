/**
 * ============================================================================
 * executor/hook-flow.ts —— 工具生命周期 hooks 的 runtime 适配
 * ============================================================================
 *
 * 四类 hook:
 *   PreToolUse          执行前:可 deny/ask/allow、可修改输入、可追加附加上下文;
 *   PermissionRequest   审批弹窗期间:由 Hook 自动应答(allow/deny/modify);
 *   PostToolUse         成功后:可追加附加上下文、记录 artifact 引用;
 *   PostToolUseFailure  失败后:可补充诊断上下文,不影响错误本身。
 *
 * 这里只负责把 runtime 状态整理成 HookRunner 需要的 payload,并归一化返回值;
 * Hook 的匹配、执行、超时与脚本沙箱由 hooks 模块负责。
 * ============================================================================
 */
import {
  CoreErrorType,
  HookEventName,
  isCoreError,
  type CollaborationMode,
  type PermissionBrokerResult,
  type TraceContext,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionDecisionResult } from "../../permission/service.js";
import { hookMatcherToolNamesForTool } from "../compat.js";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { previewHookValue } from "./utils.js";

/**
 * 执行 PreToolUse hooks。
 * matchValues 包含兼容别名,保证别名调用也能命中按 canonical 名称配置的 hook。
 *
 * payload 里的字段都是 hook 脚本判断"要不要干预"的依据:
 *   - riskLevel/sideEffectScope:让脚本按风险分级决策,而不必解析输入;
 *   - cwd/turnId/traceId:脚本可能按目录或链路做定向规则;
 *   - toolInput 是原始输入(未规范化),hook 要看到模型真正想做什么。
 * 没有 hookRunner 时返回空结果而不是抛错:hooks 是可选能力,
 * 缺失不能阻断工具执行。
 */
export async function runPreToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  entry: ToolEntry,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  // 没有 hookRunner 时返回空结果：hooks 是可选能力，缺失不能阻断工具执行。
  // 返回 additionalContexts:[] 而非 undefined：调用方直接解构不会报错。
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PreToolUse,
      mode,
      riskLevel: entry.metadata.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: entry.metadata.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

/**
 * 执行 PermissionRequest hooks:让自动化 Hook 在不弹窗的情况下应答审批。
 * 返回值优先级:preventContinuation > 显式 decision > permissionBehavior > undefined(不干预)。
 * modify 表示 Hook 修改了输入,后续仍需权限重判(见 permission-flow)。
 *
 * 与 PreToolUse 的定位差异:这里只能影响"这一次审批"的答复,
 * 不能反过来放宽规则(规则已在 permission-flow 里判定过);
 * 返回 undefined 等于"hook 不表态",后续照常弹窗给用户。
 */
export async function runPermissionRequestHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  requestId: string,
  permissionDecision: PermissionDecisionResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult | undefined> {
  // 没有 hookRunner 时返回 undefined：等同于"hook 不表态"，后续照常弹窗给用户。
  if (!deps.hookRunner) return undefined;
  const hookResult = await deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PermissionRequest,
      mode,
      reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
      requestId,
      riskLevel: permissionDecision.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: permissionDecision.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
  const decision = hookResult.permissionRequestResult;
  // preventContinuation 优先级最高:脚本明确要求"停下整条流程",
  // 此时即使它也给了 allow 也不能执行(停比放行更强势)。
  // 不变量 #3：hook 不能放宽 deny，只能收紧或在 ask 基础上放行。
  if (hookResult.preventContinuation) {
    return {
      decision: "deny",
      reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
    };
  }
  // 没有显式 decision 时退到 permissionBehavior 简化写法。
  if (!decision) {
    // permissionBehavior 是简化写法(只有 allow/deny),没有附带规则更新;
    // deny 时优先展示脚本给出的 stopReason,否则用通用文案。
    if (hookResult.permissionBehavior === "deny") {
      return {
        decision: "deny",
        reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
      };
    }
    // allow 返回放行，其他值（含 undefined）返回 undefined 表示不干预。
    return hookResult.permissionBehavior === "allow"
      ? {
          decision: "allow",
          reason: "Allowed by PermissionRequest hook",
        }
      : undefined;
  }
  // 显式 decision 的 deny：直接收口，不走下面的 allow/modify 判断。
  if (decision.behavior === "deny") {
    return {
      decision: "deny",
      reason: decision.message ?? "Denied by PermissionRequest hook",
    };
  }
  // permissionUpdates / updatedPermissions 是两代字段名,都沿用到返回结果里,
  // 让上层复用同一套"允许后落规则"的逻辑。
  const permissionUpdates = decision.permissionUpdates ?? decision.updatedPermissions;
  // updatedInput 存在 → modify:hook 改写了输入,必须回到权限流程重判,
  // 不能把它当成普通 allow(否则修改后的输入绕过了规则检查)。
  // 不变量 #3：modify 不是放宽，而是"改了输入后重新走规则"，所以必须返回 modify 而非 allow。
  return decision.updatedInput === undefined
    ? {
        decision: "allow",
        permissionUpdates,
        reason: "Allowed by PermissionRequest hook",
      }
    : {
        decision: "modify",
        modifiedInput: decision.updatedInput,
        permissionUpdates,
        reason: "Allowed with modified input by PermissionRequest hook",
      };
}

/** 执行 PostToolUse hooks:携带输出预览与 artifact 引用,返回可追加的附加上下文。 */
export async function runPostToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  output: unknown,
  artifactPath: string | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  // 没有 hookRunner 时返回空结果：hooks 是可选能力，缺失不能阻断工具执行。
  // 返回 additionalContexts:[] 而非 undefined：调用方直接解构不会报错。
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      // artifactRefs 只在存在持久化产物时传:hook 可以直接读文件做审计/格式化,
      // 不必从 output 里反推路径。
      artifactRefs: artifactPath ? [artifactPath] : undefined,
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PostToolUse,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      // toolResponse 是原始输出,previewHookValue 版本供只需要摘要的脚本使用,
      // 避免每个 hook 都自己实现截断逻辑。
      toolResponse: output,
      toolResultPreview: previewHookValue(output),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

/** 执行 PostToolUseFailure hooks:把错误类型/是否中断传给 Hook,收集诊断上下文。 */
export async function runPostToolUseFailureHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  error: unknown,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  // 没有 hookRunner 时返回空结果：失败 hook 也是可选能力，不能因为缺少它改变错误本身。
  if (!deps.hookRunner) return { additionalContexts: [] };
  // 非 Error 归一化为 Error：hook payload 需要稳定的 message/type 字段，
  // 原始 throw 的字符串/对象直接用会让脚本拿到无意义的 [object Object]。
  const normalized = error instanceof Error ? error : new Error(String(error));
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      // error.type 用 CoreError 的稳定类型(而非 JS 构造函数名),
      // hook 才能按 ToolCancelled/ToolExecutionFailed 等做稳定判断。
      error: {
        message: normalized.message,
        type: isCoreError(normalized) ? normalized.type : normalized.name,
      },
      hookEventName: HookEventName.PostToolUseFailure,
      // isInterrupt 区分"用户取消"与"真正失败":取消不需要上报错误诊断,
      // 否则每次 Stop 都会触发一堆无意义的失败处理脚本。
      isInterrupt: isCoreError(normalized) && normalized.type === CoreErrorType.ToolCancelled,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

/**
 * 把 PreToolUse hook 的 allow/ask 合并进权限判定:
 *   - 已 deny 的保持 deny(权限只能更严,不能被 Hook 放宽);
 *   - Hook allow 且非 alwaysAsk → 放行(alwaysAsk 必须走正式审批,不能被静默抹掉);
 *   - Hook ask 且原本 allow → 升级为需要审批。
 *
 * 方向性:合并只会"更严"或"在原本 ask 的前提下放行",绝不会把 allow 变 deny 之外
 * 再制造新的宽松路径。ruleId 用 hook.PreToolUse.* 前缀,日志/UI 能把这次判定
 * 归因到 hook 而不是用户规则。
 */
export function applyPreToolPermissionDecision(
  permissionDecision: PermissionDecisionResult,
  hookResult: HookRunResult,
  mode: CollaborationMode,
): PermissionDecisionResult {
  // 不变量 #3：权限只能收紧，hook 不能放宽 deny。
  // 已 deny 的直接短路返回——PreToolUse hook 的 allow/ask 对 deny 一律无效，
  // 否则恶意/有误的 hook 可以把"规则明确拒绝"的操作放行，破坏权限边界。
  if (permissionDecision.decision === "deny") return permissionDecision;
  // alwaysAsk 声明出来的确认（如 workflow 运行确认）不能被 PreToolUse hook
  // 的整体 allow 悄悄抹掉——那等于给"任何模式都要问"开了一个静默后门。自动化仍有正规出口：
  // PermissionRequest hook 可以应答这次弹窗（见 runPermissionRequestHooks）。
  if (
    hookResult.permissionBehavior === "allow" &&
    permissionDecision.decision === "ask" &&
    !permissionDecision.alwaysAsk
  ) {
    return {
      ...permissionDecision,
      allowed: true,
      decision: "allow",
      // escalated=false:这是 hook 放宽,不是规则升级,
      // 统计侧据此区分"原本就问"与"hook 才问"。
      escalated: false,
      mode,
      reason: hookResult.hookPermissionDecisionReason ?? "Tool was allowed by PreToolUse hook",
      ruleId: "hook.PreToolUse.allow",
    };
  }
  // 反向:规则原本 allow,但 hook 要求 ask → 升级为审批。
  // 只处理 allow→ask,不改写其他状态(deny 已在上面短路)。
  // 这是"收紧"操作，符合不变量 #3：hook 只能让权限更严（allow→ask），不能更松。
  if (hookResult.permissionBehavior === "ask" && permissionDecision.decision === "allow") {
    return {
      ...permissionDecision,
      allowed: false,
      decision: "ask",
      escalated: true,
      mode,
      reason:
        hookResult.hookPermissionDecisionReason ?? "Tool requires approval by PreToolUse hook",
      ruleId: "hook.PreToolUse.ask",
    };
  }
  return permissionDecision;
}

export function formatHookAdditionalContexts(additionalContexts: string[]): string {
  return [
    "[Hook additional context]",
    ...additionalContexts.map((context, index) => `#${index + 1}\n${context}`),
  ].join("\n");
}
