/**
 * ============================================================================
 * turn-model.ts —— 本轮 turn 的模型选择/创建/接纳
 * ============================================================================
 *
 * 【核心概念】
 *   Session Selection  会话级"默认用哪个模型";只决定未来创建的 Model,
 *                      不会修改已经被其他 Loop 持有的 Model。
 *   Model Execution    本轮临时执行配置(如加速卡):可能带 selectionFallback,
 *                      失败时退回会话模型。
 *   publishedSelection 只用于 ModelSelected 的前后展示边界,不参与选模/持久化。
 *
 * 【调用链】
 *   turn.ts executeTurnCommand → createTurnModel / applySubmissionExecutionState
 *   turn-model-step.ts        → 失败时 applyExecutionSelectionFallback(见 turn-execution-fallback)
 *   turn-guide-drain.ts       → guide 消费时按需重新应用执行配置
 * ============================================================================
 */
import {
  ModelRetryBudget,
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";
import { acceptOffPeakUserTakeover, selectionForPersistence } from "../off-peak/runtime.js";

const selectionAdmissions = new WeakMap<
  AgentRuntimeInternal,
  {
    sequence: number;
    commandId: string;
    persisted: Promise<void>;
  }
>();
// 只用于 ModelSelected 的前后展示边界，不参与选模、续跑或持久化。
const publishedSelections = new WeakMap<AgentRuntimeInternal, ModelSelection | undefined>();

/** 先固定旧会话候选，再接纳用户选择；声明目标失效时仍能退回原会话模型。 */
export function captureHighspeedFallbackSelection(
  runtime: AgentRuntimeInternal,
  execution: import("../types.js").ModelExecutionContext | undefined,
): import("../types.js").ModelExecutionContext | undefined {
  if (!execution?.selectionFallback) return execution;
  return {
    ...execution,
    highspeedFallbackSelection: structuredClone(runtime.getSessionModelSelection()),
  };
}

/** 记录"已发布"的选择快照,仅用于 ModelSelected 事件的 previous/next 展示。 */
export function recordPublishedModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): void {
  publishedSelections.set(runtime, cloneModelSelection(selection));
}

/** 串行接纳序号决定续跑选择；队列消费只能执行自己的快照，不能倒写较新的选择。 */
export function acceptSubmissionModelSelection(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  _traceContext: TraceContext,
  modelExecution?: Pick<
    import("../types.js").ModelExecutionContext,
    "selectionScope" | "selectionFallback"
  > & {
    highspeedFallbackSelection?: ModelSelection;
  },
): Promise<void> {
  const selection =
    modelExecution?.selectionScope === "execution"
      ? (modelExecution.selectionFallback?.target ?? modelExecution.highspeedFallbackSelection)
      : intent?.modelSelection;
  // 早退:无 selection 或无 intent 时不做任何写入,保持 session 既有选择不变。
  // 失败处理:直接 return Promise.resolve(),不抛错——选择缺失是正常分支(如 compact 轮)。
  if (!selection || !intent) return Promise.resolve();
  const previous = selectionAdmissions.get(runtime);
  // 去重:同一 commandId 或序号倒退/相等的选择不重复接纳,
  // 避免旧 turn 的选择覆盖新 turn 的选择。维护不变量#5:一个 runtime 同时只有一个
  // active turn,串行接纳序号保证选择不会被旧请求倒写。
  if (
    previous &&
    (previous.commandId === intent.sourceCommandId ||
      (Number.isFinite(intent.admissionSeq) && intent.admissionSeq <= previous.sequence))
  ) {
    return previous.persisted;
  }
  const previousSelection = runtime.getSessionModelSelection();
  if (!publishedSelections.has(runtime)) publishedSelections.set(runtime, previousSelection);
  const appliedSelection = cloneModelSelection(selection);
  runtime.setSessionModelSelection(appliedSelection);
  acceptOffPeakUserTakeover(runtime);
  // 保存串行化，防止旧异步写入在新选择之后落库；不引入另一份输入队列。
  const persisted = (previous?.persisted ?? Promise.resolve()).then(async () => {
    // 新 Session 的 entry 由 ensureSessionPersisted 创建时统一写入，避免先写外键失败。
    if (runtime.sessionPersisted !== false)
      await persistRuntimeModelSelection(runtime, appliedSelection);
  });
  selectionAdmissions.set(runtime, {
    sequence: Number.isFinite(intent.admissionSeq)
      ? intent.admissionSeq
      : (previous?.sequence ?? 0),
    commandId: intent.sourceCommandId,
    persisted,
  });
  return persisted;
}

/**
 * 带退回声明且 Selection 指向声明 provider 的执行句柄只允许一次物理请求：失败后由 core 退回会话模型
 * 继续本轮，适配层再按默认预算退避重试只会把降级拖到数分钟之后（spec §2.2「加速请求 0 次重试」）。
 * 其余句柄返回 undefined，沿用按 taskType 解析的默认预算。
 */
export function resolveExecutionModelRetryBudget(input: {
  selection: ModelSelection | undefined;
  selectionFallback: import("../types.js").ModelExecutionContext["selectionFallback"];
}): ModelRetryBudget | undefined {
  if (!input.selection || !input.selectionFallback) return undefined;
  return input.selection.providerId === input.selectionFallback.providerId
    ? ModelRetryBudget.SingleAttempt
    : undefined;
}

/**
 * 创建本轮可调用的 Model 句柄,并叠加"每次 attempt 前刷新运行时请求头"的能力。
 * requestDependencies/retryBudget 决定该句柄的鉴权与重试预算;
 * 不传 selection 时使用当前 Session Selection。
 */
export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
    retryBudget?: ModelRetryBudget;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const model = createRuntimeModel(runtime, {
    selection,
    requestDependencies: options.requestDependencies,
    retryBudget: options.retryBudget,
  });
  return withModelInvocationContext(model, (request) => ({
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

/**
 * 在 Submission 真正开始执行或 Guide 被下一次 model step 消费时应用其执行配置。
 * 选择只决定新创建的 Model；已经被其他 Loop 持有的 Model 不会被修改。
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  let model = preparedModel;

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
      requestDependencies: modelExecution?.requestDependencies,
      retryBudget: resolveExecutionModelRetryBudget({
        selection,
        selectionFallback: modelExecution?.selectionFallback,
      }),
    });
    await acceptSubmissionModelSelection(runtime, intent, traceContext, modelExecution);
    if (modelExecution?.selectionScope !== "execution") {
      // ModelSelected 展示实际 Loop 的切换；接纳只保存意图，不提前创建可调用 Model。
      // 失败处理:emitModelSelected 失败只影响 UI 展示,不阻断 turn(事件可由后续恢复重放)。
      const previousSelection = publishedSelections.get(runtime);
      publishedSelections.set(runtime, cloneModelSelection(selection));
      if (!sameModelSelection(previousSelection, selection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: selection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    // 执行态写入:mode/planEnabled 变化时同步到 runtime;
    // 失败处理:applyRuntimeExecutionState 内部处理权限互斥与持久化,失败会抛出(由调用方 catch)。
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

/** 比较两个选择是否等价(provider + model + reasoningLevel),用于判断是否需要发 ModelSelected。 */
export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

/**
 * 把会话模型选择写入 session store(SESSION_ENTRY_MODEL_SELECTION)。
 * 无 sessionStore 或无法持久化(如闲时临时选择)时直接跳过;
 * 写入失败只记 warn:选择持久化失败不应阻断当前 turn。
 */
export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const persistentSelection = selectionForPersistence(runtime, selection);
  if (!persistentSelection) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: persistentSelection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}
