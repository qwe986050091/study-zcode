/**
 * ============================================================================
 * executor/permission-flow.ts —— 工具权限判定与审批交互
 * ============================================================================
 *
 * 【判定顺序(每轮 while 迭代)】
 *   1. 加载项目权限规则(失败 → StorageError,不放行);
 *   2. permissionService.checkPermission:
 *      工具能力 + 当前 mode/plan + 规则集 + 工具自定义规则策略;
 *   3. 首次判定才合并 PreToolUse hook 的 allow/ask(输入被修改后不再重复合并);
 *   4. 覆盖 memory 文件的特殊权限(只能读取自身记忆目录等);
 *   5. allow → 直接放行;deny → 发 PermissionDenied 并按权限错误返回;
 *   6. 仍需要审批 → 过 resolveToolApproval(plan/guarded 等门),必要时弹确认窗:
 *        - 先跑 PermissionRequest hook(自动化可代答);
 *        - 用户/Hook 返回 allow/deny/modify;
 *        - modify 时在非 guarded 下先重判新输入,避免"迟到响应批准了新输入";
 *   7. 成功后应用 permissionUpdates 与 inputAdjustments;
 *   8. transition.kind="rewrite" 说明审批针对的是修改后的输入,用新输入重跑整个判定。
 *
 * 【关键不变量】
 *   - 每个权限请求只发一次终态事件(PermissionResolved);
 *   - guarded 模式下输入先做快照,审批与执行看到同一份字节;
 *   - 已 deny 的判定不能被 hook 放宽(见 hook-flow.applyPreToolPermissionDecision)。
 * ============================================================================
 */
import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
  type ToolExecutionSpanWriter,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { resolveToolApproval } from "./approval-gate.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied, emitPermissionResolved } from "./events.js";
import { applyPreToolPermissionDecision } from "./hook-flow.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { preparePermissionInput } from "./permission-input.js";
import { applyPermissionInputAdjustments } from "./permission-input-adjustments.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
import { requestPermissionResponse } from "./permission-request.js";
import {
  interpretPermissionResponse,
  type PermissionFlowResult,
  type PermissionResponseTransition,
} from "./permission-response.js";
import {
  loadProjectPermissionRuleset,
  applyGrantedPermissionUpdates,
} from "./permission-rules-persistence.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";

/**
 * 解析一次工具权限,返回 allowed + 最终执行输入(可能被 Hook/用户修改)。
 *
 * while 循环处理"审批改写了输入"的情况:rewrite 会携带新输入回到循环顶部重新判定,
 * 但 hooks 只允许在第一轮参与(hooksAvailable),避免把用户问答答案当成新操作反复询问。
 *
 * 参数口径:
 *   - executionInput:本次待判定的输入(可能已被 preflight/草稿阶段规范化);
 *   - preToolHookResult:executor 在进入权限流程前已经跑过 PreToolUse hook,
 *     这里只消费其结果,避免同一次调用重复执行 hook;
 *   - preparedContext:调用方(如草稿预批)预先算好的 cwd/workspace,复用它保证
 *     "预览看到什么目录"与"执行写什么目录"是同一个;
 *   - telemetry:perf 观测,记录 not_required/granted/denied 三种终态;
 *   - 返回值 executionInput 是**最终**输入,调用方必须用它执行,不能用原始入参。
 */
export async function resolveToolPermission(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: HookRunResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
  telemetry?: ToolExecutionSpanWriter,
  preparedContext?: ToolRuntimePermissionCapabilityContext,
): Promise<PermissionFlowResult> {
  // context 三层合并:端口默认值 < 调用方预置(preparedContext) < 本次 mode/目录。
  // preparedContext 优先是刻意的:草稿预批在"用户点确认之前"就跑过一次判定,
  // 真正执行时必须沿用同一次 cwd/workspace 快照,否则规则匹配会漂移。
  const context = {
    ...resolveRuntimePermissionContext(deps),
    ...preparedContext,
    mode,
    workingDirectory: preparedContext?.workingDirectory ?? deps.getWorkingDirectory(),
    workspaceRoot: preparedContext?.workspaceRoot ?? deps.getWorkspaceRoot(),
  };
  let projectRules: PermissionRuleset | null;
  try {
    // 项目规则读取失败属于存储异常,不能按"无规则"放行。
    projectRules = await loadProjectPermissionRuleset(deps);
  } catch (error) {
    // 项目规则读取失败属于存储异常,不能按"无规则"放行——
    // fail closed：没有规则集意味着无法判断权限边界，宁可拒绝也不冒"无限制执行"的风险。
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to load project permission rules", {
          cause: error instanceof Error ? error : undefined,
          recoverable: true,
        }),
      ),
    };
  }
  // firstInput:当前输入是否是"模型最初声明的输入"。
  //   - PreToolUse hook 只作用于原始声明,避免对"用户/Hook 改写后的版本"重复施加同一策略;
  //   - 每轮 rewrite 都会把 firstInput 置 false,所以改写后的重判只走规则/记忆检查。
  let firstInput = true;
  // hooksAvailable:审批 hook 是否还能参与。
  //   - 一次调用最多让 PermissionRequest hook 应答一次;首次应答后必须落到用户,
  //     否则 hook 的"自动 allow"会被无限复用,用户永远看不到弹窗。
  let hooksAvailable = true;
  // 累计"用户/审批实际等待时间",供 telemetry 区分"规则直接放行(not_required)"
  // 和"真的等过审批(granted)"。
  let permissionWaitMs = 0;
  // 根因：递归重入会重跑 Hook，并把问答答案当新操作；显式转换仅重判新输入。
  while (true) {
    // 循环顶部先查取消:用户可能在上一轮审批/重判期间已经 Stop,
    // 此时任何后续判定都不该继续(更不该弹窗)。
    // 不变量：取消信号必须在所有可能产生副作用的操作之前检查，包括权限规则加载之后。
    if (signal?.aborted)
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", {
            recoverable: true,
          }),
        ),
      };
    // 每轮都基于"当前输入"重算 rulePolicy:rewrite 之后输入已变,
    // 若沿用上一轮策略,规则建议(尤其是修改输入后的 suggestedPermissionUpdates)会失真。
    const rulePolicy = entry.resolvePermissionRulePolicy?.(executionInput, context);
    // 判定输入固定使用 toolName + 当前 input:name 可能已被 admission 规范化
    // (DeferredToolCall → 真实工具),不能用模型原始名去匹配规则。
    let decision = deps.permissionService.checkPermission(
      {
        toolName: toolCall.name,
        input: executionInput,
        riskLevel: entry.metadata.riskLevel,
        mode,
        // planEnabled/prePlanMode 供 plan 模式的规则使用:退出 plan 后的"预模式"
        // 决定某些工具是否需要额外确认。
        planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
        prePlanMode: deps.sessionModePort?.getPrePlanMode(),
        // 草稿预批与实际工具输入共用已准备的 cwd，不能在合并 Guarded 时漏传。
        workingDirectory: context.workingDirectory,
      },
      // 能力上下文(目录、workspace、mode 等)与工具自身声明一起决定最终判定,
      // 单独看规则集无法判断"这个工具在当前上下文是否被允许"。
      resolveRuntimePermissionCapability(entry, executionInput, context),
      projectRules,
      rulePolicy,
    );
    // 首次判定合并 PreToolUse hook;用户审批改写输入后的重判不再重复合并。
    // user-once 例外:hook 的 allow 不能替用户完成"一次性确认"。
    if (firstInput && decision.approvalMode !== "user-once") {
      decision = applyPreToolPermissionDecision(decision, preToolHookResult, mode);
    }
    firstInput = false;
    // memory 目录的特殊规则(例如只能访问自身 memory root)在通用判定之后收紧。
    // 放在 hook 之后:即使 hook 放行,记忆目录边界仍不能被绕过。
    decision = applyMemoryFilePermission({
      decision,
      executionInput,
      memoryRoot: deps.getMemoryRoot?.(),
      toolName: toolCall.name,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    });
    // 修复原因：统一审批流程曾丢失原日志合同；恢复关联字段，输入仍只记录结构摘要。
    deps.logger?.debug("Tool permission evaluated", {
      ...traceContextToLogContext(traceContext),
      decision: decision.decision,
      event: "tool.permission.evaluated",
      inputSummary: summarizeInput(toolCall.input),
      mode,
      module: "core.tool.executor",
      reason: decision.reason,
      riskLevel: decision.riskLevel,
      ruleId: decision.ruleId,
      sideEffectScope: decision.sideEffectScope,
      status:
        decision.decision === "allow"
          ? "completed"
          : decision.decision === "ask"
            ? "waiting"
            : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    if (decision.allowed) {
      // permissionWaitMs > 0 说明曾经弹过窗(rewrite 后这次终于 allow):
      // telemetry 记为 granted 而不是 not_required,避免统计低估审批成本。
      // 返回 executionInput 是当前轮的输入：调用方必须用这个而不是原始入参执行。
      telemetry?.setPermissionDecision(permissionWaitMs ? "granted" : "not_required");
      return { allowed: true, executionInput, permissionWaitMs };
    }
    if (decision.decision === "deny") {
      telemetry?.setPermissionDecision("denied");
      // deny 也要发事件:UI 需要展示"被哪条规则/原因拒绝",
      // 返回的 PermissionDenied 结果会作为工具结果回给模型。
      // 不变量：每个权限请求只有一个终态——deny 是终态之一，发完事件就返回，不再继续审批。
      await emitPermissionDenied(deps, toolCall, decision.reason, traceContext);
      deps.logger?.warn("Tool permission denied", {
        ...traceContextToLogContext(traceContext),
        decision: decision.decision,
        event: "tool.permission.denied",
        mode,
        module: "core.tool.executor",
        reason: decision.reason,
        ruleId: decision.ruleId,
        status: "failed",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      return {
        allowed: false,
        result: createPermissionErrorResult(toolCall, decision.reason, {
          mode,
          ruleId: decision.ruleId,
        }),
      };
    }

    // 需要审批:先过工具审批门(plan/guarded 等),再弹确认窗或让 PermissionRequest hook 代答。
    // 工具预览只能控制普通审批,不能覆盖 Guarded 的单次确认。
    // user-once 直接视为 ask:一次性确认不允许被工具自报的 prepareApproval 短路,
    // 否则"每次都问"的声明会被静默放行。
    const approval =
      decision.approvalMode === "user-once"
        ? { gate: "ask" as const }
        : resolveToolApproval(deps, toolCall, entry, executionInput, traceContext);
    if (approval.gate === "proceed") {
      // proceed 表示工具自己声明"此输入无需人工确认"(如纯预览类操作):
      // 仍算 allow,但不计入 permissionWaitMs(用户确实没等)。
      telemetry?.setPermissionDecision("not_required");
      return { allowed: true, executionInput, permissionWaitMs };
    }

    // requestId 每次弹窗/询问都新建,且带 "perm_" 前缀便于日志检索。
    // 不复用旧 id 是关键:上一轮已结束的审批响应若迟到,不能套用到新输入上。
    const requestId = "perm_" + crypto.randomUUID();
    const startedAt = Date.now();
    // 建议持久化的权限更新:
    //   - user-once 不产生建议(用户明确只要这一次,不写规则);
    //   - 优先用工具自定义策略的建议(比通用规则更精确),否则用默认建议。
    // 这些建议只是"候选项",真正落盘要等用户选择 allow 后由
    // applyGrantedPermissionUpdates 处理。
    const suggestedPermissionUpdates =
      decision.approvalMode === "user-once"
        ? []
        : (rulePolicy?.suggestedPermissionUpdates ??
          buildDefaultPermissionUpdates(
            toolCall.name,
            executionInput,
            entry.permissionCapabilityGroup,
          ));
    telemetry?.markPermissionRequested();
    let transition: PermissionResponseTransition;
    let resolved: PermissionBrokerResult;
    try {
      let outcome = await requestPermissionResponse({
        deps,
        toolCall,
        input: executionInput,
        decision,
        mode,
        requestId,
        traceContext,
        suggestedPermissionUpdates,
        approval,
        // hook 只在首轮、且不是 user-once 时参与:
        // 首轮之后 hooksAvailable 变 false,保证"hook 代答失败/无 hook"时一定落到用户。
        runHooks: hooksAvailable && decision.approvalMode !== "user-once",
        signal,
      });
      hooksAvailable = false;
      let rewrite: PermissionResponseTransition | undefined;
      // 非 guarded 保留已发布的 Hook/project/Memory 重判范围与授权语义。
      // guarded 不走这里:guarded 的输入是"审批时快照",审批后原样执行,
      // 不允许 Hook 再改输入(否则用户批准的是 A,执行的却是 B)。
      // 不变量 #3：guarded 模式下输入冻结，审批与执行看到同一份字节。
      if (mode !== "guarded" && outcome.source === "hook" && outcome.result.decision === "modify") {
        // preparePermissionInput:把 hook 给的 modifiedInput 规范化
        // (补默认字段/转换类型),后续重判必须基于规范化后的输入。
        const normalized = preparePermissionInput(
          outcome.result.modifiedInput ?? executionInput,
          entry,
          deps,
        );
        // 重判范围与首次判定一致(project 规则 + memory 边界 + capability),
        // 但不再合并 PreToolUse hook(那是首轮专属,且修改本身来自 hook)。
        const recheck = recheckPermissionHookModifiedInput({
          context,
          deps,
          entry,
          mode,
          modifiedInput: normalized,
          projectRules,
          toolCall,
        });
        if (recheck.permissionDecision?.decision === "ask") {
          // 旧分支用同一 requestId 再次调用 broker，迟到响应可能批准新输入。
          // 保留原有 project/Memory 重判范围，生命周期改走相同的结束→新建转换。
          // rewrite 的语义:本轮审批结果作废,回到 while 顶部用新输入
          // 生成新 requestId,让用户对"真正要执行的输入"重新确认。
          rewrite = { kind: "rewrite", input: normalized };
        } else {
          // 重判已 allow/deny:无需再问用户,直接把新输入与结论替换进 outcome,
          // 并把 modifiedInput 清空,避免下游重复处理"已消费的改写"。
          executionInput = normalized;
          outcome = {
            source: "hook",
            result: {
              ...outcome.result,
              modifiedInput: undefined,
              decision: recheck.permissionDecision?.decision === "deny" ? "deny" : "allow",
              reason: recheck.permissionDecision?.reason ?? outcome.result.reason,
            },
          };
        }
      }
      // interpretPermissionResponse 把 broker 的原始响应翻译成 allowed/denied 结果:
      // 它负责生成最终 executionInput、错误文案、以及 permissionUpdates 等字段。
      transition =
        rewrite ??
        interpretPermissionResponse({
          deps,
          toolCall,
          entry,
          input: executionInput,
          mode,
          decision,
          outcome,
          requestId,
        });
      // resolvedAt 兜底:部分响应(如测试桩/取消)不带时间,统计需要一个稳定的收口时间。
      resolved = { ...outcome.result, resolvedAt: outcome.result.resolvedAt ?? new Date() };
    } catch (error) {
      // 审批链路抛错时也要产出一个"终态":
      //   - guarded:把异常归为执行失败(说明环境/服务异常,而非用户拒绝);
      //   - 其它模式:按 PermissionDenied 处理,模型看到的是"未获批准"。
      // 无论哪种,下面都会发 PermissionResolved,保持"一次请求一个终态"的不变量。
      // guarded 用 ToolExecutionFailed 是因为 guarded 下审批异常通常是环境问题
      // （如沙箱服务不可用），不应让模型误以为是"用户拒绝"。
      const coreError = isCoreError(error)
        ? error
        : createCoreError(
            mode === "guarded" ? CoreErrorType.ToolExecutionFailed : CoreErrorType.PermissionDenied,
            "Permission request failed",
            {
              cause: error instanceof Error ? error : undefined,
              context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
              recoverable: true,
            },
          );
      resolved = { decision: "deny", reason: coreError.message, resolvedAt: new Date() };
      transition = {
        kind: "complete",
        result: { allowed: false, result: createErrorResult(toolCall, coreError) },
      };
    }
    // 审批结果解释:
    //   rewrite → 用户/Hook 修改了输入,回到 while 顶部用新输入重新判定;
    //   complete → 得到最终的 allowed/denied 结果;
    //   permissionWaitMs 累计用户等待时间,用于 perf 统计。
    // 计时终点在这里(而非 await 结束处):把事件/日志发送的开销也算进审批等待,
    // 统计口径是"从弹窗到用户可以继续"的完整时间。
    permissionWaitMs += Math.max(0, Date.now() - startedAt);
    // 只有此处结束请求：校验错误、取消、改写和正常响应都发一次终态。
    // 这也是外部(UI/adapter)唯一可信的收口信号,不能被提前 breakdown 成两次。
    // 不变量：每个 requestId 只发一次 PermissionResolved，无论结果是 allow/deny/modify。
    await emitPermissionResolved(deps, toolCall, requestId, resolved, traceContext);
    deps.logger?.info("Tool permission resolved", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.resolved",
      module: "core.tool.executor",
      requestId,
      mode,
      ruleId: decision.ruleId,
      decision: resolved.decision,
      reason: resolved.reason,
      status:
        resolved.decision === "allow" || resolved.decision === "modify" ? "completed" : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    if (transition.kind === "rewrite") {
      // 新输入回到循环顶部:重新加载规则(projectRules 已缓存)、重新判定、
      // 重新收窄 memory 边界,并用新 requestId 再次询问。
      // 不能在这里直接 return,否则新输入会绕过规则检查静默执行。
      // 不变量：rewrite 必须重新走完整判定链，不能跳过任何步骤直接放行。
      executionInput = transition.input;
      continue;
    }
    const result = transition.result;
    telemetry?.setPermissionDecision(result.allowed ? "granted" : "denied");
    if (!result.allowed) return result;
    // 审批期间用户可能已经取消:此时即使拿到 allow 也不能执行,
    // 否则"点了 Stop 还在跑工具"会破坏取消的语义。
    // 这是第二次取消检查（循环顶部已有一次）：审批耗时可能很长，
    // 必须在"即将放行"这个最后关口再确认一次。
    if (signal?.aborted)
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", {
            recoverable: true,
          }),
        ),
      };
    // 放行后的收尾:
    //   - 应用用户选择的 permissionUpdates(可能写入项目规则);
    //   - 应用 inputAdjustments(例如补充沙箱参数);
    //   任一步失败都返回错误结果,不带着不完整配置执行。
    //
    // 顺序不能反:先落规则,再调整输入。调整可能依赖"这次已被允许"的规则状态
    // (如把路径写进允许清单后才补沙箱参数),反过来会得到不一致的执行环境。
    const updateFailure = await applyGrantedPermissionUpdates({
      deps,
      permissionUpdates: resolved.permissionUpdates,
      requestId,
      sessionPermissionUpdates: resolved.sessionPermissionUpdates,
      toolCall,
      traceContext,
    });
    if (updateFailure) return { allowed: false, result: updateFailure };
    // adjusted.executionInput 才是真正进入 handler 的输入(可能已补沙箱/超时等参数);
    // adjusted.applied 只是"改了什么"的说明,存在时透传给结果用于 UI/审计展示。
    const adjusted = applyPermissionInputAdjustments({
      deps,
      entry,
      toolCall,
      executionInput: result.executionInput,
      adjustments: resolved.inputAdjustments,
      traceContext,
    });
    if (!adjusted.ok) return { allowed: false, result: adjusted.result };
    return {
      ...result,
      executionInput: adjusted.executionInput,
      permissionWaitMs,
      ...(adjusted.applied === undefined ? {} : { inputAdjustments: adjusted.applied }),
    };
  }
}
