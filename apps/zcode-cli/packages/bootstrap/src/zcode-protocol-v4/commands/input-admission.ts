// V4 用户输入准入共用件：正文/附件非空校验、held 队列裁决、以及旧发送端的
// Selection/Mode 固定。这些原语被 session-flow / goal-compact / session-mgmt /
// queue / fork-edit-retry 五个命令组共同消费，属于 commands 层的横向能力，
// 因此与 prompt-turn.ts、record-access.ts 并列放在 commands/ 下，
// 而不是寄居在某一个 handler 文件里。
//
// session_input 账本生命周期（准入的 durable 事实，不是可恢复执行队列）：
//   admitted ──promote──> promoted   与 user message 持久化同一事务，二者原子关联；
//            ├─────────> cancelled  handler 明确拒绝/回滚（如首条输入失败）；
//            ├─────────> failed     执行失败，保留可查询的失败终态；
//            └─────────> discarded(session_resumed)  CLI 重启时把残留 admitted 明确丢弃。
// 关键约束：admitted 不会被重启后自动重放；是否重发由客户端查询后决定，
// 因此 stop / fork / 输入等有副作用命令禁止静默重发。
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import {
  isHighspeedProviderId,
  resolveExecutionState,
  type ModelSelection,
} from "@zcode/shared";
import type { TurnAttachment } from "@zcode/core";
import type { SteerTurnOptions } from "../../app/types.js";
import { parseProviderQualifiedModelSelection } from "../../app/provider-registry-selection.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

/**
 * 输入准入失败的结构化错误。reasonCode 进入 ACK 的 reasonCode 词表，
 * 客户端按词表分流（payloadTooLarge / invalidPayload / inputRejected），
 * 不依赖错误文本。抛出时尚未产生 durable 事实，可安全重试。
 */
export class V4InputAdmissionRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "V4InputAdmissionRejectedError";
  }
}

/**
 * 输入是否非空：正文去空白后非空，或附件数组非空即可。
 * 纯附件（attachment-only）发送是合法输入；调用方还需单独判断 conversationQuotes。
 * 纯判定，无副作用。
 */
/** V4 用户输入统一准入：正文或附件至少存在一个。 */
export function hasPromptInput(text: string, attachments: readonly unknown[] | undefined): boolean {
  return text.trim().length > 0 || Boolean(attachments && attachments.length > 0);
}

/**
 * held（inputRouting.mode=choice）下缺少 heldQueueDisposition 的拒绝。
 * 此时队列里已有未消费项，必须由用户显式裁决「清空后发送 / 保留后发送」，
 * 不能由 CLI 默认选择（默认会造成静默丢队列或错误排队）。
 */
/** held（inputRouting.mode=choice）下 sendText/sendGoalCommand 缺 disposition → 拒绝（10 §6.4）。 */
export class V4HeldQueueDispositionRequiredError extends Error {
  readonly reasonCode = "heldQueueDispositionRequired";
  constructor() {
    super("held queue requires heldQueueDisposition (clearQueueAndSend | keepQueueAndSend)");
    this.name = "V4HeldQueueDispositionRequiredError";
  }
}

/**
 * 确认框打开后队列被另一端增删 → 旧确认失效。
 * 校验 expectedQueueItemIds 与当前队列的集合/长度/成员完全一致；
 * 不一致即拒绝（不执行 clear/keep），避免按过期快照清空他人的输入。
 */
/** 确认框打开后队列被另一端增删：旧确认不能继续清空/保留并发送。 */
export class V4HeldQueueConfirmationStaleError extends Error {
  readonly reasonCode = "guard.heldQueueConfirmationStale";
  constructor() {
    super("paused queue changed after send confirmation opened");
    this.name = "V4HeldQueueConfirmationStaleError";
  }
}

/**
 * 把输入以「queue」投递给正在运行的 turn（deferred input）。
 * 输入：record + 文本 + 命令身份/附件/意图。输出：true 表示已真正入队。
 * 副作用：由 app.enqueueDeferredInput 写 runtime 队列，并在 Core admission 记账；
 * 这里不写 projection，queue 事件由 core 自发。
 * 失败：宿主无此能力 → false（调用方回落到 steerTurn）；入队被拒 → 抛结构化错误
 * （too large / empty / 其他一律 inputRejected），不吞错。
 */
export async function enqueueDeferredInputForBusyWork(
  record: V4SessionRecordView,
  text: string,
  options: {
    commandKind?: SteerTurnOptions["commandKind"];
    inputId: string;
    queryId: SteerTurnOptions["queryId"];
    intent?: SteerTurnOptions["intent"];
    attachments?: TurnAttachment[];
    toolDisallowlist?: SteerTurnOptions["toolDisallowlist"];
  },
): Promise<boolean> {
  if (!record.app.enqueueDeferredInput) return false;
  const result = await record.app.enqueueDeferredInput(text, {
    ...(options.commandKind ? { commandKind: options.commandKind } : {}),
    delivery: "queue",
    inputId: options.inputId,
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {}),
    ...(options.toolDisallowlist ? { toolDisallowlist: options.toolDisallowlist } : {}),
    queryId: options.queryId,
  });
  if (result.kind === "queued") return true;
  throw new V4InputAdmissionRejectedError(
    result.reason === "input_too_large"
      ? "proto.payloadTooLarge"
      : result.reason === "empty_input"
        ? "proto.invalidPayload"
        : "fault.command.inputRejected",
    `deferred input rejected: ${result.reason}`,
  );
}

/**
 * held 队列裁决的唯一实现：仅在投影 inputRouting.mode=choice 时生效。
 * - 无 disposition → 拒绝（客户端必须显式选择，见上）；
 * - expectedQueueItemIds 存在 → 先做集合一致性校验，过期确认直接拒绝；
 * - clearQueueAndSend → 清空 core 队列并同步清掉内存中的加速执行包
 *   （凭据不能残留在已撤销的 queue 项后面）。
 * 副作用：可能删除队列项与暂存执行材料（不可回滚，因此校验顺序必须是
 * 「先校验、后清空」）；不发 ACK，由 handler 返回后 gateway 收口。
 */
/**
 * held choice 裁决共用件（catalog B06/B07，2026-07-05 裁决）：completed + queue>0 +
 * autoDrain=false（投影 inputRouting.mode=choice）时输入不静默入队——
 * clear → 先清空 queue 再 startNow；keep → 保留 queue 直接 startNow；缺省 → reject。
 */
export async function applyHeldQueueDisposition(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  disposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
  expectedQueueItemIds?: readonly string[],
): Promise<void> {
  const routing = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  if (routing !== "choice") return;
  if (!disposition) {
    throw new V4HeldQueueDispositionRequiredError();
  }
  if (expectedQueueItemIds) {
    const expected = new Set(expectedQueueItemIds);
    const sameItems =
      expected.size === expectedQueueItemIds.length &&
      host.getQueueLength?.(record.app.sessionId) === expected.size &&
      expectedQueueItemIds.every(
        (queueItemId) => host.getQueueItem?.(record.app.sessionId, queueItemId) !== null,
      );
    if (!sameItems) {
      throw new V4HeldQueueConfirmationStaleError();
    }
  }
  // 非 choice 模式无「暂停队列」语义，disposition 一律忽略，保持普通排队/立即发送。
  if (disposition === "clearQueueAndSend") {
    await record.app.clearQueueItems();
    host.clearQueuedTurnExecutions?.(record.app.sessionId);
  }
}

/**
 * 把「本次提交的执行状态」固定成 canonical intent 的三元组（Selection/Mode/Plan）。
 * 新客户端显式提交；旧客户端在 CLI 接收边界读取会话当前值固定一次，
 * 之后 Queue/Guide、queue 项与历史编辑都只认这份快照，不再读取可变 Session。
 * 输出口径：mode="auto" 归一为 "build"；planEnabled 与 mode 经 resolveExecutionState
 * 统一折算，避免出现 plan 与 build 自相矛盾的组合。
 * 失败：既无 runtime Selection 也无法从 entry model 解析出 provider-qualified 值时
 * 直接抛错（不允许写入不可复现的 Selection）。无副作用。
 */
/**
 * M3 兼容 admission：新发送端显式提交 Selection/Mode/Plan；旧发送端在 CLI 接收边界把
 * 当前 Session 值固定进 canonical intent。固定完成后 Queue/Guide 不再读取可变 Session。
 */
export function resolveSubmittedExecutionState(
  record: V4SessionRecordView,
  payload: {
    modelSelection?: ModelSelection;
    mode?: SubmissionMode;
    planEnabled?: boolean;
  },
): { modelSelection: ModelSelection; mode: SubmissionMode; planEnabled: boolean } {
  let modelSelection = payload.modelSelection;
  if (!modelSelection) {
    const runtimeSelection = record.app.runtime?.getSessionModelSelection?.();
    const entrySelection = runtimeSelection
      ? undefined
      : parseProviderQualifiedModelSelection(record.app.getModel());
    if (!runtimeSelection && !entrySelection) {
      throw new Error(`Session model must be provider-qualified: ${record.app.getModel()}`);
    }
    // 修复原因：getThoughtLevel() 是 Active Model 的 effective 展示事实。把它补回
    // canonical intent 会把 Config 默认值伪装成显式 pin；旧发送端只能固定 Session
    // 已经持有的稀疏 Selection，不能在 admission 时重新解释它。
    modelSelection = runtimeSelection
      ? {
          providerId: runtimeSelection.providerId,
          modelId: runtimeSelection.modelId,
          ...(runtimeSelection.options ? { options: { ...runtimeSelection.options } } : {}),
        }
      : {
          providerId: entrySelection!.providerId,
          modelId: entrySelection!.modelId,
          ...(entrySelection!.options ? { options: { ...entrySelection!.options } } : {}),
        };
  }
  const current = resolveExecutionState({
    mode: record.app.getMode?.(),
    planEnabled: record.app.runtime?.getPlanEnabled?.(),
  });
  const state = resolveExecutionState(payload, current);
  return {
    modelSelection,
    mode: state.mode === "auto" ? "build" : state.mode,
    planEnabled: state.planEnabled,
  };
}

/**
 * 退回会话常驻 Selection（只读，不改写 session 模型）。
 * 使用场景：retry / edit 重发 / 卡过期 / queue promotion 没有本轮执行材料时，
 * 必须把本金 highspeed 的 Selection 整体替换掉，禁止只删 execution 仍保留
 * 内部 Provider（会让 Core 以 ModelRequestAuthMissing 失败）。
 * 失败：会话既无 runtime Selection 也无 entry Selection → 抛错（fail-closed）。
 */
/**
 * Highspeed Selection 只有与同一轮 execution 材料成对出现才有效。retry、edit 重发、卡过期与
 * queue promotion 在没有本轮有效执行材料时，统一经这个 resolver 退回会话常驻 Selection；
 * 禁止只删 modelExecution 却保留 account:*-highspeed-card Selection（spec §3 规则 13）。
 * 只读会话当前值，不改写 session 常驻模型。
 */
export function resolveSessionFallbackModelSelection(record: V4SessionRecordView): ModelSelection {
  return resolveSubmittedExecutionState(record, {}).modelSelection;
}

/**
 * 计算「可持久化进 QueueItem」的普通提交模型。
 * 输入候选若不是 Highspeed Provider 直接采用，否则退回会话常驻 Selection；
 * 若连会话常驻值也被污染（仍指向 Highspeed Family）→ 拒绝入队（不扩散内部 Selection）。
 * 无副作用；失败 reasonCode 固定为 inputRejected。
 */
/**
 * 队列只能持久化普通提交模型。Bug 根因是协议允许任意 fallback target，旧写入点直接信任它，
 * 因此旧版本或异常载荷可把内部 Highspeed Provider 写回 QueueItem。两个队列写入路径统一在此
 * 按 Provider Family 过滤；会话常驻模型也被污染时拒绝入队，禁止继续扩散内部 Selection。
 */
export function resolveOrdinaryQueueModelSelection(
  record: V4SessionRecordView,
  candidate?: ModelSelection,
): ModelSelection {
  const selection =
    candidate && !isHighspeedProviderId(candidate.providerId)
      ? candidate
      : resolveSessionFallbackModelSelection(record);
  if (isHighspeedProviderId(selection.providerId)) {
    throw new V4InputAdmissionRejectedError(
      "fault.command.inputRejected",
      "ordinary queue model selection is unavailable",
    );
  }
  return selection;
}
