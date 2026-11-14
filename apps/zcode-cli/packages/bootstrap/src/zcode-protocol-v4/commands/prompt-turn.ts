import { OFF_PEAK_EXECUTION_TOOL_DENYLIST } from "@zcode/shared";
// 原生 prompt turn 运行器。
//
// Core admission 只负责接受输入并建立 session-scoped reservation；本文件不再拥有
// activeAbortController，也不等待 projection commit。这样 TurnStarted 之后的任意 Core
// starting/active 状态都会继续挡住同一 session 的第二次 start。
import { type TurnBackgroundAttribution, type TurnInputIntentMetadata } from "@zcode/contracts";
import type { TurnAttachment } from "@zcode/core";
import type { ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";
import type { SendInputOptions, SendInputResult } from "../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../session-execution/index.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

/**
 * 启动一轮 prompt 的入参（host 层）。
 * inputId 是 v4 锚点：inputId ≡ queryId ≡ commandId，用于与 sourceCommandId 对账；
 * requireQueue 表示必须留在队列（当前不得启动），requireIdle 表示只能占空闲位
 * （调用方已持有 promotion lease）；两者都由 Core admission 原子裁决，不在此层
 * 读取 busy 快照。
 */
export interface StartPromptTurnParamsBase {
  content: string;
  /** v4 锚点：inputId=queryId=commandId（权威数据 sourceCommandId 对账）。 */
  inputId: string;
  inputPresentation?: SendInputOptions["inputPresentation"];
  /** 附件命令面：AttachmentRef 已在 handler 层映射为 core TurnAttachment。 */
  attachments?: TurnAttachment[];
  browserAmbientContext?: SendInputOptions["browserAmbientContext"];
  intent?: TurnInputIntentMetadata;
  /** 标准 Selection 的单次执行约束；不会改写 Session Selection。 */
  modelExecution?: SendInputOptions["modelExecution"];
  sharedContextRefs?: SendInputOptions["sharedContextRefs"];
  toolDisallowlist?: readonly string[];
  /** 当前输入必须保留为未来独立 turn，不能因 admission 瞬间转为空闲而直接启动。 */
  requireQueue?: boolean;
  /** sendQueuedNow 已持有 Core promotion lease，要求这次 admission 只能占用空闲位。 */
  requireIdle?: boolean;
  /** Bot 入站 turn 的稳定回推地址；仅在本 turn 内暴露给 CronCreate。 */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

export type StartPromptTurnParams = StartPromptTurnParamsBase & TurnBackgroundAttribution;

/**
 * 启动结果：admission 是 Core 回执（started/queued），turnStarted 只是「已受理」
 * 的完成信号，不等待 TurnStarted 事件或 projection commit；
 * completion 仅用于生命周期清理（释放归因、恢复 record 状态），不属于 ACK 边界。
 */
export interface PromptTurnStartResult {
  /** Core admission 已完成；不等待 TurnStarted 或 projection commit。 */
  turnStarted: Promise<void>;
  /** Core 真实完成 promise，仅供生命周期清理使用，不属于 ACK 边界。 */
  completion?: Promise<unknown>;
  admission: SendInputResult;
  /** 兼容旧调用方；初始 ACK 不再依赖 messageId。 */
  messageId?: string;
}

/**
 * prompt 被拒绝的结构化错误（restoreWarning / activePrompt / modelUnavailable）。
 * turnStartUncertain 恒为 false：新的 Core admission 是原子的，拒绝即没有建立
 * reservation，不存在「可能已启动」的中间态，调用方可安全判定未启动。
 */
export class V4PromptRejectedError extends Error {
  readonly turnStartUncertain = false;

  constructor(
    readonly reasonCode: "restoreWarning" | "activePrompt" | "modelUnavailable",
    message: string,
  ) {
    super(message);
    this.name = "V4PromptRejectedError";
  }
}

/** 旧 queue promotion 兼容谓词：新的 Core admission 不再产生 projection authority 不确定态。 */
/**
 * 兼容谓词：旧 queue promotion 时代存在「prompt 可能已启动但无法确认」的窗口，
 * 新 Core admission 不再产生该状态，因此恒为 false（调用方不应据此做重试决策）。
 */
export function isPromptTurnStartUncertainFailure(_error: unknown): boolean {
  return false;
}

/**
 * 只执行 prompt 的模型准入检查，不接纳输入或修改 turn 生命周期。
 * edit/retry 在提交 branch cut 前复用此入口，避免破坏性操作与普通发送使用两套目录规则。
 */
/**
 * 只做「模型可用性」预检，不接纳输入、不改 record 生命周期。
 * 输入：record + 本轮参数（intent.modelSelection / modelExecution / requireQueue）。
 * 输出：无；通过则调用方可安全提交破坏性 branch cut 或开始 admission。
 * 副作用：可能清除过期的 record.restoreWarning（仅当宿主确认 registry 已有可用模型），
 * 这是唯一的状态修改；不换模型、不清持久选择。
 * 失败：restoreWarning / modelUnavailable 抛 V4PromptRejectedError；
 * 排队输入的 execution 不参与这里的选择校验（推迟到提升边界）。
 * 不变量：edit/retry 与普通发送共用同一套目录规则，避免破坏性操作走另一套预检。
 */
export async function preflightPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<void> {
  // 排队输入的 execution 只在提升边界应用，准入阶段一律按普通 Selection 预检，供卡失效后提升。
  const usesExecutionSelection =
    params.modelExecution?.selectionScope === "execution" && !params.requireQueue;
  if (!usesExecutionSelection && record.restoreWarning) {
    // app 重启后冷恢复可能跑在 provider registry 推送
    // 之前，record 创建时判「模型不可解析」挂上告警；registry 随后到达时 runtime
    // 早已可服务，但这个一次性标志没人回来清——发送被永久拒（用户只能手动切模型
    // 解锁）。闸前经宿主能力重评：已有可用目标则清除过期告警，随后仍由
    // ensureModelReady 校验当前选择；不能在这里兜底换模型或清空持久选择。
    // 仍无可用模型/宿主不支持 → 维持拒绝。
    if (host.hasUsableRuntimeModelTarget?.(record) === true) {
      host.logger?.info?.("v4 restoreWarning cleared by model catalog recovery", {
        sessionId: record.app.sessionId,
        warningType: record.restoreWarning.type,
      });
      record.restoreWarning = undefined;
    }
  }
  if (!usesExecutionSelection && record.restoreWarning) {
    throw new V4PromptRejectedError("restoreWarning", record.restoreWarning.message);
  }
  if (!usesExecutionSelection) {
    await host.ensureModelReady?.(record);
  }
  const requestedSelection = params.intent?.modelSelection;
  const selectionFallback = params.modelExecution?.selectionFallback;
  const defersSelectionValidationToCore =
    usesExecutionSelection &&
    requestedSelection !== undefined &&
    selectionFallback !== undefined &&
    selectionFallback.providerId === requestedSelection.providerId;
  const availableModels =
    typeof record.app.listModels === "function" ? record.app.listModels() : undefined;
  const isSelectionAvailable = (selection: typeof requestedSelection): boolean =>
    selection !== undefined &&
    availableModels?.some(
      (model) =>
        model.ref.providerId === selection.providerId && model.ref.modelId === selection.modelId,
    ) === true;
  if (defersSelectionValidationToCore && availableModels) {
    const fallbackTarget = params.modelExecution?.selectionFallback?.target;
    if (!isSelectionAvailable(requestedSelection) && !isSelectionAvailable(fallbackTarget)) {
      // Bug 根因：准入曾强制要求退回目标存在，即使 Highspeed 执行模型仍可用也拒绝编辑；
      // 正确门禁是至少保留一条可创建路径，只有执行模型和退回目标都缺失时才拒绝。
      const requestedLabel = requestedSelection
        ? `${requestedSelection.providerId}/${requestedSelection.modelId}`
        : "未声明";
      const fallbackLabel = fallbackTarget
        ? `${fallbackTarget.providerId}/${fallbackTarget.modelId}`
        : "未声明";
      throw new V4PromptRejectedError(
        "modelUnavailable",
        `Provider Registry 中不存在执行 Model (${requestedLabel}) 或退回目标 Model (${fallbackLabel})`,
      );
    }
  }
  if (
    !defersSelectionValidationToCore &&
    requestedSelection &&
    availableModels &&
    !isSelectionAvailable(requestedSelection)
  ) {
    // 普通 Selection 必须在 ACK 前拒绝，避免后台创建 Model 失败后静默丢输入。
    // Bug 原因：这里曾把带声明式退回的 execution Selection 也按普通 Selection 拒绝，
    // 导致 Highspeed 的 Provider/Model 缺失在 Core 执行 fallback 前直接失败。只有非排队、
    // 且退回声明与执行 Provider 一致时，才把解析延迟到 Core；其他输入仍保留原预检。
    throw new V4PromptRejectedError(
      "modelUnavailable",
      `Provider Registry 中不存在 Model: ${requestedSelection.providerId}/${requestedSelection.modelId}`,
    );
  }
}

/**
 * 入口只做模型/持久化前置校验，然后调用 app -> Core admission。Core 返回 started 时，
 * 后台生命周期等待 completion 清理 turn 归因和广播状态；RPC 本身立即返回 admission receipt。
 */
/**
 * 标准入口：预检 → Core admission。
 * Core 返回 started 后立即返回 admission receipt（不等待 TurnStarted/projection），
 * completion 交给后台 finally 释放 turn 归因并补发 legacy 状态广播。
 * 失败：预检拒绝或 Core rejected 抛错并回滚 activeAutomationId/offPeak/botDelivery
 * 等 turn 归因；绝不把 rejected 当 accepted。
 */
export async function startPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  await preflightPromptTurn(host, record, params);
  return startPromptTurnAfterPreflight(host, record, params);
}

/**
 * destructive edit/retry 已在 branch cut 前完成同一份准入检查；提交后必须直接消费该结果。
 * Bug 根因：再次读取可变 Registry 会在历史已截断后拒绝 replacement input。
 */
/**
 * 已预检入口：直接消费 preflight 结果，不再重读 Provider Registry。
 * 专供 destructive edit/retry：历史已截断后重新校验可能因 registry 波动拒绝
 * replacement input，造成「旧轮已删、新输入未发」的空档。
 */
export async function startPreflightedPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  return startPromptTurnAfterPreflight(host, record, params);
}

/**
 * admission 的实际执行体：设置 turn 归因 → 调 Core sendInput → 区分回执。
 * started：登记后台 completion（await Core completion → 清理归因 → legacy 广播）；
 * queued：不启动后台任务，仅返回 receipt，归因立即还原；
 * rejected/异常：还原归因后抛错。
 * 副作用：record.persistence 从 deferred 提升为 immediate（首条输入即落库），
 * 以及 record 上的 automation/offPeak/botDelivery 临时字段。
 * 失败：不吞错；异常与 rejected 都保证归因字段恢复原值，不留下「假运行中」状态。
 */
async function startPromptTurnAfterPreflight(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  if (record.persistence === "deferred") record.persistence = "immediate";

  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolveTurnAutomationId(params);
  const activeOffPeakTaskId = resolveTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) record.activeAutomationId = activeAutomationId;
  if (activeOffPeakTaskId) {
    // 闲时派发轮同型标记，供 offpeak-port 在工具执行前拒绝递归 OffPeakCreate。
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;

  let admission: SendInputResult;
  try {
    admission = await record.app.sendInput(
      {
        text: params.content,
        ...(params.attachments ? { attachments: params.attachments } : {}),
      },
      {
        // Bootstrap controller 曾经被当成 Core busy 真相，并由 projection watchdog
        // 清理它；现在 Core admission 自己持有 reservation，Stop 也直接调用 Core execution。
        delivery: "start_turn",
        ...(params.intent?.requestedDelivery === "guide"
          ? { queueDelivery: "guide" as const }
          : {}),
        ...(params.browserAmbientContext
          ? { browserAmbientContext: params.browserAmbientContext }
          : {}),
        inputId: params.inputId,
        ...(params.inputPresentation ? { inputPresentation: params.inputPresentation } : {}),
        ...turnBackgroundAttributionOf({
          automationId: activeAutomationId,
          // 归因用解析后的 id：resume 段仅靠 inputId 前缀兜底时也要进 core loop state。
          offPeakTaskId: activeOffPeakTaskId,
          offPeakRunType: params.offPeakRunType,
        }),
        intent: params.intent,
        ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
        ...(params.sharedContextRefs ? { sharedContextRefs: params.sharedContextRefs } : {}),
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
        ...(params.requireQueue ? { requireQueue: true } : {}),
        ...(params.requireIdle ? { requireIdle: true } : {}),
        queryId: params.inputId as SendInputOptions["queryId"],
      },
    );
  } catch (error) {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    await host.afterLegacyStateMutation?.(record, "prompt_failed");
    throw error;
  }

  if (admission.kind === "rejected") {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    throw new V4PromptRejectedError(
      "activePrompt",
      `Core prompt admission rejected: ${admission.reason}`,
    );
  }

  if (admission.kind === "queued") {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    return { admission, turnStarted: Promise.resolve() };
  }

  const completion = runWithSessionResidencyFinalization(record, async () => {
    let mutationReason = "prompt_completed";
    try {
      await admission.completion;
    } catch (error) {
      mutationReason = "prompt_failed";
      host.logger?.warn?.("v4 background turn failed", {
        error: error instanceof Error ? error.message : String(error),
        inputId: params.inputId,
        sessionId: record.app.sessionId,
      });
    } finally {
      clearPromptRecordState(
        record,
        previousAutomationId,
        previousOffPeakTaskId,
        previousBotDeliveryTarget,
      );
      await host.afterLegacyStateMutation?.(record, mutationReason);
    }
  });
  void completion.catch(() => undefined);
  host.logger?.info?.("v4 prompt admitted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
  });
  return { admission, completion, turnStarted: Promise.resolve() };
}

function clearPromptRecordState(
  record: V4SessionRecordView,
  previousAutomationId: string | undefined,
  previousOffPeakTaskId: string | undefined,
  previousBotDeliveryTarget: V4SessionRecordView["activeBotDeliveryTarget"],
): void {
  record.activeAutomationId = previousAutomationId;
  // 闲时轮身份与 automation 同规则随 turn 还原，防止跨轮残留误拒 OffPeakCreate。
  record.activeOffPeakTaskId = previousOffPeakTaskId;
  record.activeBotDeliveryTarget = previousBotDeliveryTarget;
}

/**
 * 计算本轮的 tool 黑名单：automation 轮屏蔽 Cron 写工具（防止派发轮再改调度），
 * offPeak 轮屏蔽 OffPeak 变更工具（防止递归派生），两者来源不同、不可合并；
 * 与调用方显式传入的 toolDisallowlist 取并集。纯函数，无副作用。
 */
export function buildTurnToolDisallowlist(
  params: Pick<StartPromptTurnParams, "automationId" | "offPeakTaskId" | "toolDisallowlist">,
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDisallowlist ?? []);
  if (activeAutomationId) {
    // automation 派发漏传身份时，后续 model step 会重新暴露 Cron 写工具。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  if (activeOffPeakTaskId) {
    // 闲时派发轮隐藏 OffPeakCreate（防递归自我派生）；OffPeakList 只读保留。
    // automation 轮不加此项——cron 轮放行 OffPeakCreate（定时派生闲时任务）。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

/**
 * 解析本轮 automation 身份：显式参数优先，其次从 `automation-<id>[:...]` 形式的
 * inputId 前缀兜底（续跑/重放路径可能漏传显式 id）。前缀不含有效 id 时返回 undefined。
 */
export function resolveTurnAutomationId(
  params: Pick<StartPromptTurnParams, "automationId" | "inputId">,
): string | undefined {
  const explicit = params.automationId?.trim();
  if (explicit) return explicit;
  const inputId = params.inputId.trim();
  if (!inputId.startsWith(AUTOMATION_INPUT_ID_PREFIX)) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const automationId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return automationId.length > AUTOMATION_INPUT_ID_PREFIX.length ? automationId : undefined;
}

/**
 * 解析本轮 off-peak 任务身份：显式参数是主信号；只有 `offpeak-<uuid>...` 形式的
 * inputId 才做前缀兜底（首段派发没有固定前缀，不能凭文本猜任务 id）。
 */
export function resolveTurnOffPeakTaskId(
  params: Pick<StartPromptTurnParams, "offPeakTaskId" | "inputId">,
): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // 兜底：续跑派发的 inputId 形如 `offpeak-<uuid>:resume:<uuid>`；首段派发无固定前缀，
  // 主信号必须是显式 offPeakTaskId（host 派发一律显式传）。
  const inputId = params.inputId.trim();
  if (!inputId.startsWith(OFF_PEAK_INPUT_ID_PREFIX)) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > OFF_PEAK_INPUT_ID_PREFIX.length ? offPeakTaskId : undefined;
}

/**
 * 生成 Core 需要的 turn 背景归因：automation 与 offPeak 互斥（优先 automation），
 * 都不存在则返回空对象；纯函数，不写 record。
 */
export function turnBackgroundAttributionOf(params: {
  automationId?: string;
  offPeakTaskId?: string;
  offPeakRunType?: "init" | "resume";
}): TurnBackgroundAttribution {
  if (params.automationId) return { automationId: params.automationId };
  if (params.offPeakTaskId) {
    return {
      offPeakTaskId: params.offPeakTaskId,
      ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
    };
  }
  return {};
}

const AUTOMATION_INPUT_ID_PREFIX = "automation-";
const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
// 独立常量，绝不并入 AUTOMATION_MUTATION_TOOL_NAMES（cron 轮放行 OffPeakCreate）。
// 与 core turn-loop-state 同值——闲时轮同时隐藏 SendMessage / Workflow（两者会在本轮
// modelExecution 之外重启子 Agent）。
const OFF_PEAK_INPUT_ID_PREFIX = "offpeak-";
const OFF_PEAK_MUTATION_TOOL_NAMES = OFF_PEAK_EXECUTION_TOOL_DENYLIST;
