/**
 * ============================================================================
 * executor/call-runner.ts —— 单个工具调用的完整执行管线
 * ============================================================================
 *
 * 【在整条链路里的位置】
 *   batch-runner.executeToolBatch
 *     └─ ToolExecutorImpl.execute → executeToolCall(本文件)
 *
 * 【执行顺序(也是失败能发生的每个阶段)】
 *   1. registry 准入:延迟工具解析、空名/未注册工具直接失败(仍要发 ToolCallError);
 *   2. lifetime 保留(工具实例可能被并发/外部生命周期约束);
 *   3. 模型原始参数校验(失败带 schema 细节回灌模型);
 *   4. 工具专属语义校验(entry.validateInput,必须在 hook 之前);
 *   5. 输入归一化(entry.resolveInput,在 hook/权限/handler 之前完成,保证三方看到同一份输入);
 *   6. PreToolUse hooks(可 deny / 修改输入 / 追加附加上下文);
 *   7. 权限判定(permission-flow:项目规则、能力、审批弹窗、用户反馈改写);
 *   8. 发 ToolCallStarted,建立可暂停 deadline,构建 ToolExecutionContext;
 *   9. 执行 handler(executeWithTimeout),校验输出;
 *   10. 序列化结果(可能落 artifact)、PostToolUse hooks、生成展示与用量;
 *   11. 成功:构造 ToolExecutionResult(+ turnControl)、发结果事件、跟踪后台任务;
 *   12. 失败:PostToolUseFailure hooks、错误结果、automation 上限短路、发错误事件、telemetry。
 * ============================================================================
 */
import { resolveDeferredToolCall } from "../deferred-call.js";
import {
  type AgentTelemetryErrorCategory,
  CoreErrorType,
  createChildTraceContext,
  createCoreError,
  createRootTraceContext,
  getCurrentTraceContext,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
  type SessionEvent,
} from "@zcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
} from "@zcode/zcode-cua/frame-contract";
import {
  normalizeToolExecutionInput,
  prepareInitialToolExecutionInput,
} from "../input-normalization.js";
import { hasOfficialCuaFrameAuthority } from "../../mcp/image-normalization.js";
import type { SkillTelemetryMetadata } from "@zcode/contracts";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
import type { ToolEntry } from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import {
  createErrorResult,
  createPermissionErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
  isToolHandlerFailureError,
} from "./errors.js";
import { emitToolCallError, emitToolCallResult, emitToolCallStarted } from "./events.js";
import {
  formatHookAdditionalContexts,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "./hook-flow.js";
import { resolveToolCallCapabilityFlags } from "./permission-capability.js";
import { resolveToolPermission } from "./permission-flow.js";
import { snapshotPermissionInput } from "./permission-input.js";
import { buildToolInputResolutionContext } from "./permission-input-adjustments.js";
import { createMcpToolDisplay, createToolResultDisplay } from "./result-display.js";
import { appendHookAdditionalContexts, serializeOutput } from "./result-serialization.js";
import {
  ToolDeadline,
  executeWithTimeout,
  linkAbortSignal,
  observeToolAdmissionClock,
  resolveTimeoutMs,
} from "./timeout.js";
import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";
import { runToolCallWithTelemetry } from "./telemetry.js";
import {
  withAutomationCreateLimitTurnStop,
  withPlanExitDeniedTurnStop,
  withTerminalToolTurnStop,
  withWorkflowRefineDeniedFollowUp,
} from "./turn-control.js";
import { mergeToolExecutionTelemetry, readToolExecutionTelemetry } from "../handlers/tool-perf.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateInitialModelToolInput, validateInput, validateOutput } from "./validation.js";
import type { ExecutableToolCall } from "../types.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { resolveToolEntryModelContract } from "../model-contract.js";

const UNDISCOVERED_TOOL_SCHEMA_EXPLANATION =
  "\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. " +
  "Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ";

/**
 * 执行单个工具的外层入口:先做 registry 准入与 canonical 名称归一,
 * 再用 runToolCallWithTelemetry 包裹真正的执行(保证每次调用都有 trace span)。
 *
 * 未注册/空名工具不会进入 handler,但仍会返回 ToolExecutionResult 并发布 ToolCallError,
 * 否则 UI 的工具行会永久停在 inputStreaming。
 */
export async function executeToolCall(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  options?: ToolExecuteOptions,
): Promise<ToolExecutionResult> {
  // 再次准入(幂等):流式协调器已经准入过的 call 会被原样返回;
  // 但批次执行路径(未经协调器/恢复路径)也必须在此解析 DeferredToolCall,
  // 所以这一步不能依赖调用方先做。
  const admission = resolveDeferredToolCall(toolCall, options?.toolSearch, deps.registry);
  if (admission.error) {
    // 准入失败不进入 handler,但仍要发 ToolCallError:否则 UI 工具行会停在 inputStreaming,
    // 且模型永远收不到配对结果。
    const result = createErrorResult(admission.call, admission.error);
    await emitToolCallError(
      deps,
      toolCall.id,
      options?.traceContext ??
        deps.traceContext ??
        createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId }),
      deps.turnId,
      result.error,
    );
    return result;
  }
  // 历史只保存一份原始目标参数；执行/Hook 可修改的对象在执行入口独立复制。
  // 只对 modelCallWrapper(即 DeferredToolCall 解包后的 call)做 clone:
  // 这类 call 的 input 会被 hook/权限改写,不能影响"模型声明时的原始参数";
  // 普通 call 直接引用,避免克隆大 payload(图片 base64 等)带来的额外内存。
  toolCall = admission.call.modelCallWrapper
    ? { ...admission.call, input: structuredClone(admission.call.input) }
    : admission.call;
  const totalStartedAt = Date.now();
  // 空名不走 registry.get:某些 registry 实现会对非法 key 抛错,
  // 而空名属于"模型输出错误",应该走 ToolNotFound 的可解释路径。
  const entry = isEmptyToolName(toolCall.name) ? undefined : deps.registry.get(toolCall.name);
  // 别名调用统一改成 canonical 名:handler、hook 匹配、事件与日志都用 canonical,
  // 但上面结果/错误里仍会保留模型原始名称,便于模型自己对照。
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  // 隐私与基数边界：未注册工具名来自模型输出，不能假定是受控枚举。
  // 业务错误仍保留真实名称供模型自修复，远端 Trace 统一落入固定 unknown 桶。
  const telemetryToolCall = entry ? canonicalToolCall : { ...toolCall, name: "unknown" };
  return runToolCallWithTelemetry(deps, telemetryToolCall, options, (telemetry) =>
    executeToolCallImpl(deps, backgroundTasks, toolCall, totalStartedAt, options, telemetry),
  );
}

/**
 * 真正的单工具执行管线(按文件头的 1-12 顺序推进)。
 * 所有提前返回都必须"发事件 + 结束 telemetry",不能静默 return。
 */
async function executeToolCallImpl(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  totalStartedAt: number,
  options?: ToolExecuteOptions,
  telemetry?: ToolExecutionSpanWriter,
): Promise<ToolExecutionResult> {
  // trace 上下文兜底顺序:显式传入 > 当前 async 上下文 > deps 默认 > 新建 root。
  // 新建 root 只发生在测试/无 runtime 上下文的直接调用,保证 trace 字段永不为 undefined。
  const parentTraceContext =
    options?.traceContext ??
    getCurrentTraceContext() ??
    deps.traceContext ??
    createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
  const emptyToolName = isEmptyToolName(toolCall.name);
  const registeredEntry = emptyToolName ? undefined : deps.registry.get(toolCall.name);
  const model = options?.model ?? deps.model;
  // registry entry 需要再按当前模型解析一次:同一工具在不同模型下可能暴露不同能力
  // (如模型专属参数/模型契约),直接用注册表静态项会丢这些差异。
  const entry = registeredEntry
    ? resolveToolEntryModelContract(registeredEntry, {
        model,
      })
    : undefined;
  const pluginId = entry?.metadata.mcpPresentation?.pluginId;
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  // 子 span 携带 toolCallId/toolName:一个 turn 里有多个工具时,
  // trace 视图靠这两个属性把"哪次调用"区分开。
  const traceContext = createChildTraceContext(parentTraceContext, {
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    attributes: {
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    },
  });
  const traceId = traceContext.traceId;
  const turnId = traceContext.turnId ?? deps.turnId;

  // registry miss:发生在 handler/ToolCallStarted 之前。
  // 空名与未注册工具都必须返回配对结果并发布错误事件,保证模型能自修复、UI 能收口。
  // 这里用原始 toolCall(而非 canonicalToolCall):没有 entry 就没有 canonical 名可言。
  if (!entry) {
    const result = createErrorResult(
      toolCall,
      createCoreError(
        CoreErrorType.ToolNotFound,
        emptyToolName
          ? "Model returned an invalid tool call: tool name is empty."
          : `Tool not found: ${toolCall.name}`,
        {
          context: { toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: false,
        },
      ),
    );
    if (emptyToolName) {
      // 空名在 admission 阶段停止会让模型永远收不到配对结果。复用
      // registry-miss 生命周期，但 provider 内容严格保留模型返回的原始空白名称。
      result.modelContent = `<tool_use_error>Error: No such tool available: ${toolCall.name}</tool_use_error>`;
    }
    // registry miss 发生在 handler/ToolCallStarted 之前；旧代码只把失败
    // 返回给 provider，没有发布 ToolCallError，V4 tool row 因而永久停在 inputStreaming。
    await emitToolCallError(
      deps,
      toolCall.id,
      traceContext,
      turnId,
      result.error,
      undefined,
      pluginId,
    );
    deps.logger?.warn("Tool call rejected because the tool is not registered", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.not_found",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    telemetry?.finishFailed("lookup", "configuration", result.error);
    return result;
  }

  // 工具实例保留:某些工具需要在整个执行期间独占实例;
  // 失败则直接返回 ToolCancelled,不进入后续校验/权限/handler。
  // catch 里的错误按"实例不可用"处理:此时还没开始执行,回灌 ToolCancelled
  // 比抛出裸异常更符合工具协议(模型会理解为"这次调用被取消,可重试")。
  let lifetime: ReturnType<NonNullable<ToolEntry["retainExecution"]>> | undefined;
  try {
    lifetime = entry.retainExecution?.(canonicalToolCall.id);
  } catch (error) {
    // lifetime retain 失败按 ToolCancelled 收口：实例不可用不是"工具执行失败"，
    // 而是"这次调用无法开始"，模型应理解为可重试的取消而非系统故障。
    // 不变量 #1：即使在 retain 阶段失败，也必须发 ToolCallError 并返回配对结果，
    // 否则 UI 工具行会卡在 inputStreaming。
    const result = createErrorResult(
      canonicalToolCall,
      createCoreError(
        CoreErrorType.ToolCancelled,
        error instanceof Error ? error.message : "Tool instance is unavailable",
      ),
    );
    await emitToolCallError(
      deps,
      canonicalToolCall.id,
      traceContext,
      turnId,
      result.error,
      undefined,
      pluginId,
    );
    return result;
  }
  if (lifetime)
    // 两个取消源都要生效:调用方 signal(用户 Stop)与实例 lifetime(如子进程退出)。
    // AbortSignal.any 让任一触发即中断,且不必手动转发事件。
    options = {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, lifetime.signal])
        : lifetime.signal,
    };
  try {
    const mode = deps.getMode();

    if (options?.signal?.aborted) {
      // 执行前再次检查取消：用户可能在 registry lookup 或 lifetime retain 期间 Stop。
      // 这里不发 ToolCallError（还没到 ToolCallStarted 阶段），只返回 cancelled 结果。
      // 不变量 #1：返回配对结果，但事件侧由外层 batch-runner/协调器负责收口。
      const result = createErrorResult(
        canonicalToolCall,
        createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled"),
      );
      telemetry?.finishCancelled("abort_signal");
      return result;
    }

    // 模型原始参数校验:失败属于"模型该自己修"的错误,返回带 schema 细节的 modelContent。
    // prepare 阶段先做两件事:把顶层 JSON 字符串化的参数展开、跑 runtime schema
    // (含默认值/preprocess)。runtime schema 失败时只带回 issues,不替换输入,
    // 让下面的 JSON Schema 校验给出统一格式的错误,避免两套错误文案互相覆盖。
    const preparedInitialInput = prepareInitialToolExecutionInput({
      entry,
      input: canonicalToolCall.input,
      logger: deps.logger,
    });
    let executionInput = preparedInitialInput.input;
    const initialInputValidation = validateInitialModelToolInput(
      executionInput,
      entry,
      preparedInitialInput.runtimeValidationIssues,
    );
    if (initialInputValidation) {
      const result = createErrorResult(canonicalToolCall, initialInputValidation);
      const search = options?.toolSearch;
      // 延迟 schema 未加载只提供纠错提示，不增加工具执行拒绝条件。
      if (
        search?.enabled &&
        !search.discovered.has(canonicalToolCall.name) &&
        search.catalog.some((tool) => tool.name === canonicalToolCall.name && tool.deferred)
      ) {
        // 原提示省略了类型退化原因；完整解释与 schema 一并提供，避免只引导盲目重试。
        result.modelContent =
          (result.modelContent ?? initialInputValidation.message) +
          UNDISCOVERED_TOOL_SCHEMA_EXPLANATION +
          `Load the tool first: call ToolSearch with query "select:${canonicalToolCall.name}", then retry this call. ` +
          `For reference, this tool's input schema is: ${JSON.stringify(entry.inputSchema)}` +
          (search.mode === "local"
            ? `\nCall DeferredToolCall with {name: "${canonicalToolCall.name}", input: {...}}.`
            : "");
      }
      // schema 失败与 registry miss 同属 handler/ToolCallStarted 之前的早退；旧代码
      // 只把失败回灌模型，没有发布 ToolCallError，V4 tool row 因而在整个 turn 里停在
      // inputStreaming（CreateWorkflow 卡持续显示「正在编写工作流」），模型重试后又叠一张。
      await emitToolCallError(
        deps,
        canonicalToolCall.id,
        traceContext,
        turnId,
        result.error,
        undefined,
        pluginId,
      );
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }

    // 工具专属语义校验:必须在 Hook 之前结束,避免无效调用先弹审批窗/触发 failure hook。
    // validateInput 是"业务语义"层(如 file_path 必须存在),与上面的 schema 层分开:
    // schema 层保证结构可解析,语义层保证这次调用在业务上成立。
    const toolInputValidation = entry.validateInput?.(executionInput, {
      runtimeTaskRegistry: deps.runtimeTaskRegistry,
    });
    if (toolInputValidation && isToolHandlerFailure(toolInputValidation)) {
      // tool-specific 语义校验原先只能放在 handler，导致无效调用仍先执行
      // PreToolUse、权限和 failure hook；语义校验必须在 hook 前结束。
      const result = createErrorResult(
        canonicalToolCall,
        createToolHandlerFailureError(canonicalToolCall, toolInputValidation),
      );
      await emitToolCallError(
        deps,
        canonicalToolCall.id,
        traceContext,
        turnId,
        result.error,
        undefined,
        pluginId,
      );
      // 工具专属校验以普通失败结果返回，不走 handler 执行的 try/catch 失败收口。
      // 先发出 ToolCallError 更新工具行，再显式标记遥测失败，避免被记录为 abandoned。
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }

    // 归一化：把模型发出的入参换成「将要发生的执行事实」。位置刻意在 hook **之前**——此后
    // hook、权限规则、确认窗载荷、prepareApproval 与 handler 读的都是同一份输入，于是
    // 「策略看得到真正的脚本」「跨版本可见」「确认与执行同字节」三件事一次到位。
    if (entry.resolveInput) {
      const resolution = await entry.resolveInput(
        executionInput,
        buildToolInputResolutionContext(deps),
      );
      if (isToolHandlerFailure(resolution)) {
        // 与 validateInput 同一条生命周期出口：解析不出来是模型该立刻拿回去修的东西，
        // 不该先弹一次注定失败的确认窗。
        const result = createErrorResult(
          canonicalToolCall,
          createToolHandlerFailureError(canonicalToolCall, resolution),
        );
        await emitToolCallError(
          deps,
          canonicalToolCall.id,
          traceContext,
          turnId,
          result.error,
          undefined,
          pluginId,
        );
        telemetry?.finishFailed("validation", "parse", result.error);
        return result;
      }
      executionInput = resolution.input;
    }

    // PreToolUse hooks:Hook 可以 deny/preventContinuation(按权限错误收口),
    // 也可以修改输入(修改后必须重新校验 schema),还可以只追加附加上下文。
    const preToolHookResult = await runPreToolUseHooks(
      deps,
      canonicalToolCall,
      executionInput,
      entry,
      mode,
      traceContext,
      options?.signal,
    );
    if (preToolHookResult.permissionBehavior === "deny" || preToolHookResult.preventContinuation) {
      // deny/preventContinuation 都按权限错误收口:
      //   - withPlanExitDeniedTurnStop:若是"退出 plan 被拒",要升级成"停止 turn"的控制指令,
      //     而不是普通错误(否则模型会继续重试同一个被拒操作);
      //   - appendPreToolAdditionalContextsToErrorResult:hook 给的诊断上下文必须让模型看到,
      //     否则它只能看到一句 "Blocked by PreToolUse hook",无法自我修正。
      const result = appendPreToolAdditionalContextsToErrorResult(
        withPlanExitDeniedTurnStop(
          createPermissionErrorResult(
            canonicalToolCall,
            preToolHookResult.hookPermissionDecisionReason ??
              preToolHookResult.stopReason ??
              "Blocked by PreToolUse hook",
            {
              decision: "deny",
              mode,
              reason:
                preToolHookResult.hookPermissionDecisionReason ?? preToolHookResult.stopReason,
              source: "hook.PreToolUse",
            },
          ),
          {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          },
        ),
        preToolHookResult.additionalContexts,
      );
      telemetry?.setPermissionDecision("denied");
      telemetry?.finishDenied("policy_denied");
      return result;
    }
    if (preToolHookResult.updatedInput !== undefined) {
      // hook 改写输入后必须重新规范化 + 重新校验:
      //   - source="hook" 让规范化按"外部修改"的宽松度处理;
      //   - 校验失败走与 deny 相同的附加上下文契约,模型才能拿到 hook 的诊断信息。
      executionInput = normalizeToolExecutionInput({
        entry,
        input: preToolHookResult.updatedInput,
        logger: deps.logger,
        source: "hook",
      });
      const hookInputValidation = validateInput(executionInput, entry);
      if (hookInputValidation) {
        // Hook 修改后的输入校验失败会在 handler 前直接返回，旧分支没有走
        // PreToolUse context 的统一追加逻辑，导致模型只看到 schema error，看不到 Hook
        // 已产生的诊断上下文；与 deny、permission-deny 的提前失败契约不一致。
        const result = appendPreToolAdditionalContextsToErrorResult(
          createErrorResult(canonicalToolCall, hookInputValidation),
          preToolHookResult.additionalContexts,
        );
        telemetry?.finishFailed("validation", "parse", result.error);
        return result;
      }
    }

    // Shell 已由 session owner 固定；匹配和执行复用同一选择，不为不存在的热切换再建快照。
    const bashShellSelection = deps.getBashShellSelection?.() ?? deps.bashShellSelection;
    // guarded 模式:审批窗看到的是"冻结的输入快照"和"固定的 cwd",
    // 执行阶段必须复用同一份,避免审批后目录变化导致"批准 A 却执行 B"。
    // 不变量 #3：guarded 输入冻结——snapshotPermissionInput 深拷贝输入，
    // guardedWorkingDirectory 固定 cwd，审批与执行看到同一份字节。
    const guardedWorkingDirectory = mode === "guarded" ? deps.getWorkingDirectory() : undefined;
    if (mode === "guarded") executionInput = snapshotPermissionInput(executionInput);
    // 权限判定:项目规则 → 能力策略 → 工具审批门 → 必要时弹确认窗/询问 Hook。
    // 拒绝时按错误类型回灌模型;Plan/Workflow 的"用户反馈拒绝"会升级为后续 user 输入。
    // 注意传入的是 preToolHookResult:PreToolUse 的 allow/ask 合并发生在权限流程内部,
    // 这样"规则 deny 不能被 hook 放宽"的约束只在一个地方维护。
    const permissionResult = await resolveToolPermission(
      deps,
      canonicalToolCall,
      entry,
      executionInput,
      preToolHookResult,
      mode,
      traceContext,
      options?.signal,
      telemetry,
      {
        mode,
        bashShellSelection,
        ...(guardedWorkingDirectory === undefined
          ? {}
          : { workingDirectory: guardedWorkingDirectory }),
      },
    );
    if (!permissionResult.allowed) {
      // 拒绝也要带 hook 上下文,并区分两类 turnControl:
      //   - plan exit 被拒 → 停止 turn;
      //   - workflow refine 被拒 → 转成后续 user 反馈(而不是让模型继续重试)。
      const result = appendPreToolAdditionalContextsToErrorResult(
        withWorkflowRefineDeniedFollowUp(
          withPlanExitDeniedTurnStop(permissionResult.result, {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          }),
          { toolName: canonicalToolCall.name },
        ),
        preToolHookResult.additionalContexts,
      );
      // 只有"用户明确拒绝"记为 user_denied;规则拒绝/加载失败等归为 permission 失败,
      // 否则统计会把策略拦截也算成用户行为。
      if (result.error?.type === CoreErrorType.PermissionDenied) {
        telemetry?.finishDenied("user_denied");
      } else {
        telemetry?.finishFailed(
          "permission",
          errorCategoryForToolError(result.error?.type),
          result.error,
        );
      }
      return result;
    }
    executionInput = permissionResult.executionInput;
    const permissionWaitMs = permissionResult.permissionWaitMs;
    const inputAdjustments = permissionResult.inputAdjustments;

    const startTime = Date.now();
    // 按**执行入参**解析一次副作用旗标（Bash 的只读命令判定就在这里落定），随 ToolCallStarted 发出：
    // 事件先于 handler，所以订阅者（dynamic-workflow driver 的导入缓存关门）在第一个字节落盘前就知道。
    // ToolCallStarted 必须在 handler 之前发出:订阅者(如 workflow driver)需要在
    // 第一个字节落盘前就知道"这次调用已通过权限、即将执行",并按副作用旗标关门。
    // 此处 executionInput 已经是权限调整后的最终输入,旗标必须反映"真正要跑的版本",
    // 用模型原始参数会让只读判定与实际执行不一致。
    await emitToolCallStarted(
      deps,
      canonicalToolCall,
      traceContext,
      turnId,
      startTime,
      createMcpToolDisplay(entry.metadata.mcpPresentation),
      resolveToolCallCapabilityFlags(deps, entry, executionInput),
    );

    deps.logger?.info("Tool call started", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.started",
      module: "core.tool.executor",
      status: "started",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    });

    // 超时可由工具/输入/模型三者覆盖:例如长任务工具按输入里的 timeout 放大上限,
    // 某些模型下的工具需要更短的保护时间。
    const timeoutMs = resolveTimeoutMs(entry, executionInput, deps.defaultTimeoutMs, {
      model,
    });
    // 执行期使用独立 controller:parent signal 通过 linkAbortSignal 单向转发,
    // finally 里 unlink 防止监听器泄漏到后续调用。
    const executionAbortController = new AbortController();
    const unlinkParentAbort = linkAbortSignal(options?.signal, executionAbortController);
    // 可暂停的 deadline：本次调用内部的模型请求在准入闸门前排队时暂停计时。排队的两端
    // 以本 toolCallId 的 ModelNetworkStatus 会话事件到达，所以在事件出口拦一层即可，handler 无感。
    const deadline = new ToolDeadline(timeoutMs);
    // emitEvent 包一层观测:工具内部模型请求的状态事件会经过这里,
    // deadline 据此区分"真的在跑"和"在闸门前排队"。
    const emitEvent =
      deps.emitEvent === undefined
        ? undefined
        : async (event: SessionEvent): Promise<void> => {
            observeToolAdmissionClock(event, canonicalToolCall.id, deadline);
            await deps.emitEvent(event);
          };
    let readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
    let skillTelemetryMetadata: SkillTelemetryMetadata | undefined;
    // failureStage 是遥测归因用的"当前阶段"游标:handler 内抛错 → handler,
    // 序列化/CUA attestation 抛错 → serialize,PostToolUse hook 抛错 → post_hook。
    // 在每个阶段前更新,保证 catch 里记录的是真实失败点而不是笼统的 internal。
    let failureStage: "handler" | "serialize" | "post_hook" = "handler";

    try {
      // 这里的 model 与外层同名变量是有意的:工具内部请求必须使用本次调用的模型
      // (可能已被 subagent override 影响),而不是 deps 的静态默认值。
      const model = options?.model ?? deps.model;
      const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
        bashAvailable: deps.registry.has("Bash"),
      });
      // ToolExecutionContext 是所有 handler 的唯一运行时入口:
      // 每加一个端口都要在这里显式透传,漏传会让工具的某项能力静默失效。
      const context: ToolExecutionContext = {
        toolCallId: canonicalToolCall.id,
        toolSearch: options?.toolSearch,
        telemetry,
        automationTurn: options?.automationTurn,
        offPeakTurn: options?.offPeakTurn,
        traceContext,
        traceId,
        spanId: traceContext.spanId,
        parentSpanId: traceContext.parentSpanId,
        abortSignal: executionAbortController.signal,
        backgroundTaskControlPort: deps.backgroundTaskControlPort,
        emitEvent,
        executionPort: deps.executionPort,
        browserControlPort: deps.browserControlPort,
        browserDocumentationRoot: deps.browserDocumentationRoot,
        fileSystemPort: deps.fileSystemPort,
        httpClientPort: deps.httpClientPort,
        imageProcessorPort: deps.imageProcessorPort,
        pdfDocumentPort: deps.pdfDocumentPort,
        // 工具内部的模型请求默认把状态事件发进会话：deadline 暂停与 driver 相位都靠这条流。
        model: withDefaultToolModelStatusSink(
          model,
          createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
        ),
        subagentModelOverride: options?.subagentModelOverride,
        embeddedSearch: {
          ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
          enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
          ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
        },
        skillPort: deps.skillPort,
        subagentPort: deps.subagentPort,
        coordinatorResponsePort: deps.coordinatorResponsePort,
        workflowSubmitPort: deps.workflowSubmitPort,
        workflowEscalatePort: deps.workflowEscalatePort,
        artifactStore: deps.artifactStore,
        automationPort: deps.automationPort,
        offPeakPort: deps.offPeakPort,
        topicResourcePort: deps.topicResourcePort,
        sessionStore: deps.sessionStore,
        sessionModePort: deps.sessionModePort,
        workflowPort: deps.workflowPort,
        dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
        dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
        modelCatalogPort: deps.modelCatalogPort,
        runtimeTaskRegistry: deps.runtimeTaskRegistry,
        readFileState: deps.readFileState,
        recordReadFileStateMetadata: (metadata) => {
          // 回调而不是直接字段:handler 只在"确实读过文件"时才知道 metadata,
          // 这里收集后由成功结果带回,避免给所有工具都塞一份空状态。
          readFileStateMetadata = metadata;
        },
        recordSkillTelemetryMetadata: (metadata) => {
          // 成功/失败都要归因到具体 skill,所以这个回调的生命周期覆盖整个 try,
          // 失败收口的 emitToolCallError 也会用到它。
          skillTelemetryMetadata = metadata;
        },
        bashShellSelection,
        setWorkingDirectory: deps.setWorkingDirectory,
        workingDirectory: guardedWorkingDirectory ?? deps.getWorkingDirectory(),
        workspaceRoot: deps.getWorkspaceRoot(),
        workspaceIdentity: deps.workspaceIdentity,
        remoteSessionId: deps.remoteSessionId,
        clientMode: deps.clientMode,
        deliveryKind: deps.deliveryKind,
        memoryRoot: deps.getMemoryRoot?.(),
        runtimeScope: deps.runtimeScope,
        // providerVisibleToolNames 只列"实际暴露给模型"的工具:
        // 工具(如 ToolSearch 类)用它判断"某个工具名是否在本次请求的 schema 里",
        // providerVisible === false 的内部工具不应出现在这份名单里。
        providerVisibleToolNames: deps.registry
          .list()
          .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
        sessionId: deps.sessionId,
        turnId,
        // inputAdjustments 只在权限阶段真的做了调整时出现:
        // 工具可据此知道"沙箱/超时等参数是系统补的",而不是用户显式要求。
        ...(inputAdjustments === undefined ? {} : { inputAdjustments }),
      };

      // 执行 handler:超时/取消由 executeWithTimeout + ToolDeadline 统一控制;
      // handler 返回值可能是业务失败(isToolHandlerFailure),这里转成异常走统一失败收口。
      const output = await executeWithTimeout(
        entry.handler,
        executionInput,
        context,
        deadline,
        executionAbortController,
        entry,
      );
      const durationMs = Date.now() - startTime;
      if (isToolHandlerFailure(output)) {
        // handler 用返回值表达可预期业务失败；这里只转换到既有异常控制流，
        // 继续复用原来的 failure hook、事件和日志，不引入第二套执行生命周期。
        // durationMs 也会随异常丢弃,由 catch 重新计时;两者差异极小,不做特判。
        throw createToolHandlerFailureError(canonicalToolCall, output);
      }
      // 输出校验在序列化之前:不合法输出不能进入 resultBudget/artifact 流程,
      // 否则会先落盘一份"格式错误但已完成"的产物。
      validateOutput(output, entry);
      // node_repl 同时承载 Browser Use 与 CUA，不能在注册时把整个 server 标成 official。
      // CUA SDK 结果带 producer integrity metadata 时，才为本次序列化临时打开原子帧保护；
      // 否则通用 resultBudget 会截断/重排 image_ref，或非 authority 路径会把引用剥掉。
      const modelOutputEntry = resolveModelOutputEntry(entry, output);
      // 序列化结果(可能截断/落 artifact),随后跑 PostToolUse hooks,
      // 把 Pre/Post 两批 additionalContext 合并进最终 modelContent。
      // 先 serialize 再 hook:hook 需要拿到 artifactPath 才能去读真正的落盘产物;
      // 合并时用 modelOutputEntry(可能已临时开启 CUA 保护),不能用原始 entry。
      failureStage = "serialize";
      let serialization = await serializeOutput(
        deps,
        output,
        modelOutputEntry,
        traceContext,
        canonicalToolCall.id,
        executionAbortController.signal,
      );
      failureStage = "post_hook";
      const postToolHookResult = await runPostToolUseHooks(
        deps,
        canonicalToolCall,
        executionInput,
        output,
        serialization.artifactPath,
        traceContext,
        options?.signal,
      );
      serialization = appendHookAdditionalContexts(
        serialization,
        [...preToolHookResult.additionalContexts, ...postToolHookResult.additionalContexts],
        modelOutputEntry,
      );
      const display = createToolResultDisplay(canonicalToolCall.name, output, {
        mcp: entry.metadata.mcpPresentation,
        officialCua: entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
      });
      const perf = mergeToolExecutionTelemetry(readToolExecutionTelemetry(output), {
        permissionWaitMs,
        // totalMs 是用户感知的工具生命周期：registry lookup、校验、Hook、权限等待、
        // handler、序列化与 PostToolUse。durationMs 继续只表示 handler 主执行段。
        totalMs: Date.now() - totalStartedAt,
      });

      const finalModelContent = serialization.modelContent ?? serialization.content;
      const modelContentProtection = modelOutputEntry.modelContentProtection
        ? attestOfficialCuaFrameContent(finalModelContent, modelOutputEntry.modelContentProtection)
        : undefined;
      // 最终 attestation 是"fail closed"关卡:声明了内容保护、结果里也确实带 image 块,
      // 却拿不到合法 attestation → 宁可失败也不发一张无法校验的栅格。
      // 不变量 #11：本地 CUA 包无法 attest 时 core 必须 fail closed——
      // 没有 attestation 的栅格可能是伪造的 frame authority，绝不能交给模型。
      // 序列化阶段已经按 image_ref 结构做过一次投影,这里校验的是"最终要发给模型的字节"。
      if (
        modelOutputEntry.modelContentProtection &&
        Array.isArray(finalModelContent) &&
        finalModelContent.some((block) => block.type === "image") &&
        !modelContentProtection
      ) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          "Official CUA frame failed final model-content attestation",
          { recoverable: true },
        );
      }

      // 成功结果:补上 perf(权限等待/总时长)、可选 CUA 内容保护、终止工具 turnControl。
      // withTerminalToolTurnStop 只对"声明为终止型"的工具(如提交计划)改写 turnControl,
      // 普通工具返回原 result,不产生额外字段。
      const result: ToolExecutionResult = withTerminalToolTurnStop(
        {
          toolCallId: canonicalToolCall.id,
          toolName: canonicalToolCall.name,
          success: true,
          output,
          display,
          modelContent: finalModelContent,
          ...(readFileStateMetadata ? { readFileStateMetadata } : {}),
          performance: perf,
          serialization,
          durationMs,
          startedAt: new Date(startTime),
          completedAt: new Date(),
        },
        { entry },
      );

      // 发结果事件并登记后台任务(如 Bash 后台运行会在这里挂到 BackgroundTaskTracker)。
      // 顺序固定:先发结果事件(UI 收口工具卡),再登记后台任务(开始轮询/通知)。
      // 反过来会在"任务已开始但卡片还没结束"的窗口里产生状态错位。
      await emitToolCallResult(
        deps,
        canonicalToolCall,
        traceContext,
        turnId,
        serialization,
        durationMs,
        display,
        perf,
        skillTelemetryMetadata,
        pluginId,
      );

      await backgroundTasks.trackBackgroundTask(canonicalToolCall, output, traceContext, turnId);

      deps.logger?.info("Tool call completed", {
        ...traceContextToLogContext(traceContext),
        durationMs,
        event: "tool.call.completed",
        module: "core.tool.executor",
        status: "completed",
        toolCallId: canonicalToolCall.id,
        toolName: canonicalToolCall.name,
      });

      telemetry?.setOutputBytes(serialization.returnedBytes);
      telemetry?.setOutputTruncated(serialization.truncated);
      telemetry?.finishCompleted();
      return result;
    } catch (error) {
      // 失败收口:先跑 PostToolUseFailure hooks,再把错误统一包装成 ToolExecutionResult。
      // automation create limit 会在这一步被转换成"停止 turn"控制(见 turn-control.ts)。
      // post hook 自身再失败不能覆盖原错误:这里只取它返回的 additionalContexts。
      const durationMs = Date.now() - startTime;
      const failureHookResult = await runPostToolUseFailureHooks(
        deps,
        canonicalToolCall,
        executionInput,
        error,
        traceContext,
        options?.signal,
      );
      let result = createErrorResult(
        canonicalToolCall,
        error instanceof Error ? error : new Error(String(error)),
        durationMs,
      );
      // modelContent 的拼装规则:
      //   - handler failure 已经带了自己的可读文案,优先用它,不要退化成 error.message;
      //   - 有 failure hook 上下文时,把 Pre + Post 两批一起追加(模型需要完整的因果链);
      //   - 没有 failure 上下文但有 Pre 上下文时,也要保留 Pre(常见于 post hook 失败)。
      const baseModelContent = result.error
        ? isToolHandlerFailureError(error) && typeof result.modelContent === "string"
          ? result.modelContent
          : result.error.message
        : undefined;
      if (failureHookResult.additionalContexts.length > 0 && baseModelContent) {
        result.modelContent = [
          baseModelContent,
          formatHookAdditionalContexts([
            ...preToolHookResult.additionalContexts,
            ...failureHookResult.additionalContexts,
          ]),
        ].join("\n\n");
      } else if (preToolHookResult.additionalContexts.length > 0 && baseModelContent) {
        result.modelContent = [
          baseModelContent,
          formatHookAdditionalContexts(preToolHookResult.additionalContexts),
        ].join("\n\n");
      }
      result = withAutomationCreateLimitTurnStop(result, {
        error,
        toolName: canonicalToolCall.name,
      });

      // Skill 已解析成功后，serialize/post_hook 仍可能失败；错误事件也要保留
      // resolved metadata，否则失败的 Skill agent_step 无法归因到具体 skill。
      // pluginId 同理:失败事件要能和成功事件落在同一个插件维度。
      await emitToolCallError(
        deps,
        canonicalToolCall.id,
        traceContext,
        turnId,
        result.error,
        skillTelemetryMetadata,
        pluginId,
      );

      // 日志记录原始 error 而不是 result.error:
      // result.error 已经面向业务协议包装过,可能丢失 cause/stack;
      // telemetry 同理只接收原始异常做受控脱敏。
      deps.logger?.error(
        "Tool call failed",
        error instanceof Error ? error : new Error(String(error)),
        {
          ...traceContextToLogContext(traceContext),
          durationMs,
          event: "tool.call.failed",
          module: "core.tool.executor",
          status: "failed",
          toolCallId: canonicalToolCall.id,
          toolName: canonicalToolCall.name,
        },
      );

      if (options?.signal?.aborted || result.error?.type === CoreErrorType.ToolCancelled) {
        // 取消不是"失败":单独记 cancelled,避免错误率被 Stop 操作污染。
        // 两个判据都要看:handler 可能自己把 cancel 包装成普通错误。
        // failureStage 在这里不使用——取消不属于任何执行阶段的失败。
        telemetry?.finishCancelled("abort_signal");
      } else {
        // failureStage 游标在 serialize/post_hook 前更新，这里记录的是真实失败点：
        // handler 阶段失败 → "handler"，序列化失败 → "serialize"，post hook 失败 → "post_hook"。
        // 不更新就会把所有失败都归到 "handler"，无法区分"工具本身坏了"还是"结果处理坏了"。
        telemetry?.finishFailed(
          failureStage,
          errorCategoryForToolError(result.error?.type),
          // 原始异常只交给 Telemetry 做受控脱敏；result.error 是面向业务协议重新包装后的错误，
          // 不能覆盖 Trace 中用于定位根因的 source message/type/code。
          error,
        );
      }
      return result;
    } finally {
      // 解除 parent → 本次执行的 abort 转发:调用结束后 parent signal 再触发
      // 不应影响已完成的 controller(也防止监听器累积)。
      unlinkParentAbort();
    }
  } finally {
    // lifetime 释放必须最外层 finally:即使 retain 之后的任何环节抛错,
    // 也要把"实例独占"归还,否则后续调用会被永久阻塞。
    lifetime?.release();
  }
}

/**
 * 为"共享 MCP server 的单次调用"临时解析出带 CUA 内容保护的 entry。
 *
 * 背景:node_repl 同时承载 Browser Use 与 CUA,注册时不能把整个 server 标成 official,
 * 只有当本次 output 真的带 producer integrity metadata(hasOfficialCuaFrameAuthority)时,
 * 才在这一次序列化里开启帧保护:
 *   - 打开后 resultBudget 提升到 256 KiB,避免合法栅格被通用截断;
 *   - 策略固定为 truncate/head:帧内容不允许被 artifact 化(那会把 image_ref 打散)。
 * 未命中条件时原样返回 entry,不影响普通 MCP 输出。
 */
function resolveModelOutputEntry(entry: ToolEntry, output: unknown): ToolEntry {
  const isSharedNodeRepl =
    entry.metadata.name === "mcp__node_repl__js" ||
    entry.metadata.mcpPresentation?.serverName === "node_repl";
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
    !isSharedNodeRepl ||
    !hasOfficialCuaFrameAuthority(output)
  ) {
    return entry;
  }
  return {
    ...entry,
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    resultBudget: {
      ...entry.resultBudget,
      maxInlineBytes: Math.max(entry.resultBudget.maxInlineBytes, 256 * 1024),
      maxModelBytes: Math.max(entry.resultBudget.maxModelBytes, 256 * 1024),
      strategy: "truncate",
      preview: { direction: "head" },
    },
  };
}

function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}

/**
 * 把 CoreErrorType 映射成遥测的固定错误分类。
 * 映射是"多对一"的:遥测侧只关心 configuration/parse/permission/... 这些粗粒度桶,
 * 新增错误类型默认落 internal;不要在这里给每个类型单开一类,否则看板维度会失控。
 */
function errorCategoryForToolError(type: string | undefined): AgentTelemetryErrorCategory {
  switch (type) {
    case CoreErrorType.ConfigurationError:
    case CoreErrorType.ToolNotFound:
      return "configuration";
    case CoreErrorType.PermissionDenied:
    case CoreErrorType.PermissionEscalation:
    case CoreErrorType.PermissionTimeout:
      return "permission";
    case CoreErrorType.InvalidInput:
      return "parse";
    case CoreErrorType.ToolCancelled:
      return "cancelled";
    case CoreErrorType.ToolTimeout:
      return "timeout";
    default:
      return "internal";
  }
}

/**
 * 给"handler 之前的提前失败结果"追加 PreToolUse 提供的上下文。
 * 只处理失败结果:成功结果已经在 appendHookAdditionalContexts 里合并过两批上下文;
 * modelContent 非字符串时退回 error.message,保证拼出来的是字符串而不是 [object Object]。
 */
function appendPreToolAdditionalContextsToErrorResult(
  result: ToolExecutionResult,
  additionalContexts: string[],
): ToolExecutionResult {
  if (result.success || !result.error || additionalContexts.length === 0) return result;

  // PreToolUse deny 和权限拒绝会在 handler 前提前返回，旧逻辑只在 handler 的
  // 成功/异常路径追加 context，导致 Hook 明明返回了 additionalContext，模型却看不到。
  const baseModelContent =
    typeof result.modelContent === "string" ? result.modelContent : result.error.message;
  return {
    ...result,
    modelContent: [baseModelContent, formatHookAdditionalContexts(additionalContexts)].join("\n\n"),
  };
}
