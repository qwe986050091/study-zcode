/**
 * ============================================================================
 * runtime/methods/steering.ts —— 运行中输入的排队、投递与丢弃
 * ============================================================================
 *
 * 【两种入口】
 *   steerTurn            有 activeTurn 且 steerable 时,把输入放进该 turn 的 pendingInputs;
 *   enqueueDeferredInput 没有 active turn(或不可 steer)时,记成"下一次会话轮"的排队输入。
 * 两者都先落 TurnSteerQueued 事件(内存态与冷恢复都靠事件重建队列),再返回 queued。
 *
 * 【两种投递语义】
 *   guide  在**当前** turn 内联注入:下一个模型请求前 drain,作为新 user 消息拼进上下文,
 *          并切换 queryId(steer 是一条新的真实 user query);
 *   queue  作为**独立轮**排队:由 bootstrap 在 session-ready + goal gate 之后提升,
 *          行内 drain 不会消费它。
 *   缺省是 queue;delivery 会写进持久 metadata,冷恢复据此还原同一切分。
 *
 * 【生命周期约束】
 *   - 同一 runtime 同时只能有一个 active turn(beginActiveTurn/reserveTurnStart 互斥);
 *   - 已被 sendQueuedNow 预留(reservation)的队首,行内 drain 必须让路,避免被消费两次;
 *   - 审批授权未发布(permissionFullAccessPending)时暂停 drain,防止用旧投影的授权目标;
 *   - turn 取消/失败时 pendingInputs 统一 discard 并发 TurnSteerDiscarded 事件;
 *   - 进程重启不保留队列:账本里 admitted 的输入统一 settle 为 discarded(留痕可查)。
 * ============================================================================
 */
// 文件级不变量（INV）—— steering 的排队、投递与丢弃都围绕这些断言，改动前先确认不破坏任一条：
//
//   INV-01 同一 runtime 同时只有一个 active turn（beginActiveTurn 双检查 + reserveTurnStart 预占）——漏掉预占会让并发 admission 产生两个 active turn。
//   INV-02 pendingInputReservations 是单输入单消费者锁（drain 的 has 检查）——drain 与 sendQueuedNow 必须互斥，否则同一条输入被消费两次。
//   INV-03 reservation 的释放必须与 DispatchChanged 事件落盘绑定（releasePendingInputReservation 的 catch 回填）——提前释放会在崩溃窗口丢输入。
//   INV-04 steerTurn 的校验顺序固定：空→超长→无 active→expectedTurnId→不可 steer（五个 early return）——调整顺序会改变拒绝原因与事件语义。
//   INV-05 rejectTurnSteer 一律写 TurnSteerRejected 并返回 rejected，不抛错——热路径抛错会让调用方拿不到结构化 reason。
//   INV-06 空输入判定必须包含附件与引用（hasSteerInput）——只看正文会把已 accepted 的附件输入误拒。
//   INV-07 pendingInput.id 优先取 pendingInputId → intent.queueItemId → 现造——换顺序会破坏账本幂等与原子 promotion。
//   INV-08 先 append TurnSteerQueued，再 await selectionAccepted（steerTurn 尾部）——顺序颠倒会产生「已排队但事件未落」的中间态。
//   INV-09 排队长度必须来自事件投影（enqueueDeferredInput 的 rebuildProjection）——用内存计数会在冷恢复后从 0 开始。
//   INV-10 deferred 输入缺省 delivery 为 queue——缺省成 guide 会试图在没有 active turn 时做内联注入。
//   INV-11 行内 drain 只取 guide 子序列最早一项（firstInlineGuideIndex）——按数组队首取会让普通 queue 永久挡住后续 guide。
//   INV-12 guide 过滤跳过 sendGoalCommand 与 compact——放行会在命令执行中途插入正文并破坏命令语义。
//   INV-13 hasInlineGuidePendingInput 在 permissionFullAccessPending、queueExternalDrainActive 或 reservation 存在时返回 false——任一遗漏都会在错误授权下注入。
//   INV-14 fallbackPendingGuidesToQueue 先校验 activeTurn 身份——否则会把新 turn 的 guide 改道成旧 turn 的 queue。
//   INV-15 投递语义变更必须同时写事件与内存字段——只改一处会让冷热投影事实分叉。
//   INV-16 reservePendingInputById 在 await 之后必须复查锁与权限——await 期间状态可变，复查是唯一的正确性保证。
//   INV-17 reserve 的写事件失败必须回滚内存锁（catch 内 delete）——否则该输入永久无法被消费。
//   INV-18 release 的写事件失败必须恢复锁（catch 内 set）——「已释放但事件未落」会让输入静默丢失。
//   INV-19 removePendingInputById 必须校验 reservation 归属——不校验会允许非持有者删除别人预定的输入。
//   INV-20 内存未命中必须走 held 投影回落（discardHeldPendingInputById）——直接返回 false 会让 held 项永远删不掉。
//   INV-21 clearAllPendingInputs 先清内存再清投影，两段都计数——只清一处会留下可被 drain 的残留。
//   INV-22 edit/reorder 必须同步 sessionStore 与内存 intent——只改内存会让重启后回退到旧正文或旧顺序。
//   INV-23 setQueueAutoDrain 只有 false→true 才置 queueExternalDrainActive——无条件置位会让正常 drain 被误暂停。
//   INV-24 emitModelSelected 的 contextWindow 取本次 Active Model；previousModelSelection=null 必须保留——读 Runtime Config 或按 truthy 判断都会产出错误事件。
//   INV-25 drainPendingInput 在 recover 前后各检查一次权限与 activeTurn；pendingInputDrains 必须在 finally 递减——漏减会让后续 drain 永久被视为重入。
//   INV-26 drain 后必须切换 queryId；TurnSteerDrained 必须在 persistUserPrompt 之后 append——沿用原 query 会把后续请求归因到上一条用户消息。
//   INV-27 discardPendingInput 必须绑定 activeTurn 实例——否则旧 turn 的 catch 会误清新 turn 的队列。
//   INV-28 重启清扫只把 admitted 置为 discarded(session_resumed)，失败只记 warn——改成删除会失去「输入去哪了」的痕迹，抛错会让 session 起不来。
//
// 边界补充：本文件只维护内存队列与事件，不推进 turn 生命周期、不渲染 queue、不决定 inputRouting；
// held queue 的提升由 bootstrap 负责，这里只提供单项与全量的丢弃、编辑、重排原子操作；
// 事件写入失败一律向上抛出（reservation 相关除外，必须保住锁并重新抛出）。
//
import { parseRuntimeInputPresentation } from "@zcode/contracts";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "../permission-grant-recovery.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createMessageId,
  createQueryId,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CollaborationMode,
  MessageId,
  ModelSelection,
  ModelSelectionOrigin,
  PendingSteerInputInfo,
  PendingTurnInput,
  QueryId,
  SessionEvent,
  TraceContext,
  TurnSteerInput,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnSteerSource,
  TurnId,
} from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import { acceptSubmissionModelSelection, recordPublishedModelSelection } from "./turn-model.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  buildUserContentFromTurn,
  measureUtf8Bytes,
  MAX_TURN_STEER_INPUT_BYTES,
  previewInput,
  resolveTurnAttachments,
} from "../helpers/index.js";
import type {
  ActiveTurnKind,
  ActiveTurnSteeringState,
  DrainedPendingInputDiagnostics,
} from "../types.js";
import {
  createRuntimeUserEntry,
  realUserRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";

// hasSteerInput 会同时检查 input、attachments 与 conversationQuotes，任一为真则返回 true。
// 只看 input.trim 会把「仅附件」与「仅引用」的合法输入判成空。
// [契约] 该方法只做存在性判断，不做大小与权限校验。
// 三处任一为真即视为有效输入，顺序不影响结果。
function hasSteerInput(request: Pick<TurnSteerInput, "attachments" | "input" | "intent">): boolean {
  // 三个条件用短路或连接：正文非空就立刻为真，热路径上省掉两次属性访问。
  // 只判断存在性，不判断大小与权限：那两关各有独立出口，混进来会让拒绝原因归错档。
  return (
    request.input.trim().length > 0 ||
    Boolean(request.attachments?.length) ||
    Boolean(request.intent?.conversationQuotes?.length)
  );
}

// 活跃轮次内的 steer 入口：校验、构造 pendingInput、落事件、接受模型选择。
// 它不判断 delivery，也不推进 turn；投递语义由调用方与 drain 决定。
// [契约] 成功返回 queued 时，事件已经落盘，内存队列也已完成 push。
// [失败路径] 五个拒绝分支共享 rejectTurnSteer，保证拒绝也有持久事件。
export async function steerTurn(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const activeTurn = this.activeTurn;
  // 字节数按 UTF-8 计算，与远端限额保持一致。
  // inputSize 只按 measureUtf8Bytes(request.input) 统计正文，不含附件体积。
  // [契约] 该值同时写进事件与日志，便于事后核对拒绝原因。
  const inputSize = measureUtf8Bytes(request.input);
  // 预览只在这里算一次：五个拒绝分支与入队事件都要复用，重复遍历长正文代价高。
  const inputPreview = previewInput(request.input);

  // 校验顺序:空输入 → 超长 → 无活跃 turn → expectedTurnId 不匹配 → 不可 steer。
  // 每一步都走 rejectTurnSteer 产出统一的 rejected 结果(带 reason 与事件),
  // 不抛异常:steer 是高频热路径,失败必须是可解释的返回值。
  // 附件输入可以没有正文；旧校验只看 input，导致已 accepted 的附件无法进入权威 queue。
  // 第一道校验：空输入直接拒绝，不写队列。
  // [失败路径] 这里必须走 rejectTurnSteer 而不是 return，否则拒绝无事件、无法诊断。
  // 拒绝结果携带 inputSize 与预览，便于 UI 展示原因。
  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  // 第二道校验：超长输入拒绝，边界是严格大于。
  // [契约] 上限按字节而非字符，中文与 emoji 会更快触顶。
  // 超长不给截断而是整体拒绝，避免半截指令被执行。
  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  // 第三道校验：没有活跃 turn 时拒绝，提示调用方改走 deferred 入口。
  // 此处 deliberately 不自动降级为排队，避免调用方误判投递语义。
  // [失败路径] 拒绝结果不带 activeTurnId，因为确实没有。
  if (!activeTurn) {
    return await this.rejectTurnSteer("no_active_turn", {
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  // 第四道校验：乐观并发控制，调用方期望的 turn 已不是当前 turn。
  // [并发] 这是唯一防止「把输入投给已结束轮次」的检查。
  // 未提供 expectedTurnId 时跳过，兼容不关心轮次的调用方。
  if (request.expectedTurnId !== undefined && request.expectedTurnId !== activeTurn.turnId) {
    return await this.rejectTurnSteer("expected_turn_mismatch", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  // 第五道校验：该 turn 显式声明不可 steer（例如正在压缩或验证）。
  // [失败路径] 拒绝原因单独成类，UI 可据此提示「当前阶段请排队」。
  // steerable 由 beginActiveTurn 传入，运行期不会变动。
  if (!activeTurn.steerable) {
    return await this.rejectTurnSteer("turn_not_steerable", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  // queryId 决定了 drain 后新请求的归因，缺失时才新建。
  // 优先复用调用方传入的 id，保证 CLI 侧幂等重试不会产生两条 query。
  // [契约] 该 id 会写进事件与 pendingInput，两者必须一致。
  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery;
  const toolDisallowlist = request.toolDisallowlist;
  // 队列位置取 push 前的长度，即新元素的下标。
  // 它在事件落盘前就固定，后续重排由 reorder 单独维护。
  // [契约] 冷恢复时以 intent.queuePosition 为准，不重新推算。
  const queuePosition = activeTurn.pendingInputs.length;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: request.delivery ?? request.intent.admittedDelivery,
        queuePosition,
      }
    : undefined;
  // 内存队列项：id、正文、入队时间、queryId 与可选的语义字段。
  // 可选字段用条件展开，避免把 undefined 写进持久 metadata。
  // [契约] id 的三级回落顺序不可调整，账本幂等依赖它。
  // queuedAt 用新时间，drain 时据此计算等待时长。
  const pendingInput: PendingTurnInput = {
    id:
      // 优先用 CLI admission 分配的 pendingInputId / queueItemId:
      // 账本、事件与持久 message 必须使用同一个 id,才能做幂等与原子 promotion。
      // 都没有时才由 runtime 现造一个。
      request.pendingInputId ??
      request.intent?.queueItemId ??
      this.createPendingInputId(activeTurn.turnId),
    input: request.input,
    queuedAt: new Date(),
    traceId: activeTurn.traceContext.traceId,
    queryId,
    ...(commandKind ? { commandKind } : {}),
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    ...(delivery ? { delivery } : {}),
    ...(intent ? { intent } : {}),
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(toolDisallowlist ? { toolDisallowlist } : {}),
    turnId: activeTurn.turnId,
  };
  // 模型选择的接受是异步的，先拿到 Promise 但不立即 await。
  // [并发] 先发后等是为了让事件写入与 selection 落盘并行，缩短热路径。
  // [契约] 该 Promise 必须在返回 queued 之前 await，不能遗弃。
  const selectionAccepted = acceptSubmissionModelSelection(
    this,
    intent,
    activeTurn.traceContext,
    request.modelSelectionScope
      ? {
          selectionScope: request.modelSelectionScope,
          highspeedFallbackSelection: request.highspeedFallbackSelection,
        }
      : undefined,
  );
  // 先入内存队列，再构造事件，最后落盘。
  // [失败路径] 若事件写入失败，这条内存项会残留；调用方拿到异常需自行重试或取消。
  // [契约] push 之后长度即 queueLength，事件里写的是同一个值。
  activeTurn.pendingInputs.push(pendingInput);
  // 用户亲手 steer 进来的话（协调者 / 信箱 / 工具跟进也走这里，它们不算）：与 prompt 一样，给每个
  // 欠着决定的 run 一对新的提醒。
  // 只有用户亲手 steer 才重置阻塞提醒，可编程注入不算用户发声。
  // 协调者、信箱与工具跟进的输入会跳过这一步。
  // [契约] 提醒器是可选依赖，缺失时静默跳过。
  if (request.inputPresentation === "user_steer") this.workflowBlockedReminder?.userSpoke();
  const queueLength = activeTurn.pendingInputs.length;
  // TurnSteerQueued 是队列的持久事实，冷恢复完全依赖它重建队列。
  // 事件里的 queueLength 是本次入队后的长度，用于投影校验。
  // [契约] 可选字段必须与内存项一致，否则冷热投影会分叉。
  // traceId 与 turnId 都取自 activeTurn，保证事件挂在正确的轮次上。
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      inputId: request.inputId,
      queryId,
      pendingInputId: pendingInput.id,
      input: pendingInput.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      ...(delivery ? { delivery } : {}),
      ...(intent ? { intent } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId: activeTurn.turnId,
      queueLength,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  // 先落事件，再等待 selection，顺序不可交换。
  // [失败路径] 写事件失败会向上抛，调用方拿不到 queued；内存项残留需由上层清理。
  // [契约] 使用 activeTurn 的 traceContext，而不是请求携带的那份。
  // 用 activeTurn 的上下文而不是请求携带的那份：事件必须挂在当前那一轮上。
  await this.appendEvent(event, activeTurn.traceContext);
  // 事件是队列的持久事实,必须先落;selection 接受可以晚一步 await,
  // 但必须在返回 queued 之前完成,否则调用方会拿到"已排队但模型未选中"的中间态。
  // 返回前必须等到 selection 落定，避免「已排队但模型未选中」的中间态。
  // [失败路径] selection 失败同样向上抛，此时事件已经落盘。
  // 这一步之后再打日志与返回，保证日志反映最终结果。
  await selectionAccepted;
  this.logger?.debug("Turn steer queued", {
    ...traceContextToLogContext(activeTurn.traceContext),
    activeTurnKind: activeTurn.kind,
    activeTurnSteerable: activeTurn.steerable,
    inputId: request.inputId,
    queryId,
    event: "turn.steer.queued",
    expectedTurnId: request.expectedTurnId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId: pendingInput.id,
    queueLength,
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    status: "waiting",
    targetTurnId: activeTurn.turnId,
  });

  return {
    kind: "queued",
    pendingInputId: pendingInput.id,
    queueLength,
    turnId: activeTurn.turnId,
  };
}

// enqueueDeferredInput 是无活跃轮次时的排队入口，下一次真正开轮时再消费。
// 它与 steerTurn 共享校验，但没有 turn 相关字段。
// [契约] 缺省 delivery 是 queue，且必须写进事件与 metadata。
// [失败路径] 同一个 runtime 上可能同时存在活 turn 的 guide 与 deferred queue，二者靠 delivery 区分。
export async function enqueueDeferredInput(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);
  // deferred 输入可能没有显式 trace，回落到 runtime 根上下文。
  // [契约] 该上下文决定事件归属的 traceId，缺失会导致不可观测。
  // 它不用于 turn 归属，turnId 由后面的三级回落单独计算。
  const traceContext = request.traceContext ?? this.rootTraceContext;

  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  // targetTurnId 三级回落：当前活跃 turn → 最近 assistant turn → trace turn → deferred。
  // [契约] 最后的 deferred 是占位符，表示开轮时再归属，不能删。
  // 顺序保证恢复后的输入尽量挂回原轮次，便于 transcript 连续。
  const targetTurnId =
    // 没有活跃 turn 时,排队输入仍然要挂一个 turnId:
    // 优先"最近一条 assistant 的 turn"(恢复后继续那一轮),否则用当前 trace,
    // 最后兜底 "deferred" 表示"等下一次真正开轮时再归属"。
    this.activeTurn?.turnId ??
    this.latestAssistantTurnId ??
    traceContext.turnId ??
    ("deferred" as TurnId);
  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  // deferred 输入的缺省投递是 queue(独立轮):没有活跃 turn 时不存在"内联注入"的语义。
  // 没有活跃 turn 时不存在内联注入语义，因此缺省必须是 queue。
  // [契约] 该值会同时写进事件与 intent.admittedDelivery。
  // [失败路径] 若改成 guide，drain 会在没有 turn 的情况下尝试注入。
  const delivery = request.delivery ?? "queue";
  const toolDisallowlist = request.toolDisallowlist;
  // id 的三级回落与 steer 保持一致：同一笔输入在两个入口之间迁移时 id 不变。
  const pendingInputId =
    request.pendingInputId ??
    request.intent?.queueItemId ??
    this.createPendingInputId(targetTurnId);
  // queueLength 从 projection 取而不是内存计数:
  // 冷恢复后内存队列为空,只有事件投影知道真实排队长度。
  // 排队长度必须从事件投影读取，内存数组在冷恢复后是空的。
  // [并发] 这是一次 await，期间队列可能被其它路径改变，因此只用于展示长度。
  // [资源] 每次 deferred 入队都重建投影，成本随事件数增长。
  const projection = await this.rebuildProjection();
  const queueLength = projection.pendingSteerInputs.length + 1;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: delivery,
        queuePosition: queueLength - 1,
      }
    : undefined;
  // 事件里的 queueLength 来自投影而非内存：冷恢复后内存数组是空的。
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      ...(request.inputId ? { inputId: request.inputId } : {}),
      queryId,
      pendingInputId,
      input: request.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      delivery,
      ...(intent ? { intent } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId,
      queueLength,
    },
    {
      traceId: traceContext.traceId,
      turnId: targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  await acceptSubmissionModelSelection(
    this,
    intent,
    traceContext,
    request.modelSelectionScope
      ? {
          selectionScope: request.modelSelectionScope,
          highspeedFallbackSelection: request.highspeedFallbackSelection,
        }
      : undefined,
  );
  this.logger?.debug("Deferred input queued", {
    ...traceContextToLogContext(traceContext),
    delivery,
    event: "turn.deferred_input.queued",
    inputId: request.inputId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId,
    queueLength,
    status: "waiting",
    targetTurnId,
  });

  return {
    kind: "queued",
    pendingInputId,
    queueLength,
    turnId: targetTurnId,
  };
}

// 开启活跃 turn 的唯一入口，同时承担双互斥检查。
// activeTurn 已存在或 reservation 属于别的 turn 都视为冲突。
// [契约] 成功后清空 reservation，并返回可被后续 finish 比对的对象引用。
// [失败路径] 冲突抛 TurnInProgress，属于可恢复错误。
export function beginActiveTurn(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
  steerable: boolean,
  options?: { inputId?: string },
): ActiveTurnSteeringState {
  // 双互斥:
  //   activeTurn 已存在 → 已有 turn 在跑;
  //   reservation 属于别的 turnId → 另一个 turn 已"预定"但还没 begin。
  // reservation 的作用是关闭 admission 与 begin 之间的竞态窗口:
  // 两个输入同时通过 admission 时,只有一个能拿到 reservation。
  // 不变量 5：一个 runtime 同时只有一个 active turn；reservation 是这个不变量的
  // "预占位"机制——在真正 begin 之前就占据 slot，防止并发 admission 产生两个 active turn。
  // 已有活跃 turn 时直接抛错，绝不覆盖。
  // [并发] 覆盖会让旧 turn 的 pendingInputs 失去归属，drain 与 discard 全部错位。
  // 错误里同时带两个 turnId，便于定位并发来源。
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  // 读取预占位，用于关闭 admission 与 begin 之间的竞态窗口。
  // [并发] 两个输入同时通过 admission 时只有一个能拿到 reservation。
  // [契约] reservation 的 turnId 与本 turn 相同才允许继续。
  const reservation = this.activeTurnStartReservation;
  if (reservation && reservation.turnId !== turnId) {
    throw createTurnInProgressError(kind, reservation.turnId, turnId);
  }

  // 活跃态初始为空队列、不可变 kind 与 traceContext。
  // pendingInputs 用新数组，绝不复用上一个 turn 的数组。
  // [契约] goalStateChangeReminderDeferralOpen 初始为 false，提醒逻辑据此开门。
  // inputId 只在提供时写入，避免 undefined 字段进入结构。
  // 每次现造新对象：复用上一个轮次的结构会把残留字段泄漏进新轮。
  const activeTurn: ActiveTurnSteeringState = {
    goalStateChangeReminderDeferralOpen: false,
    kind,
    pendingInputs: [],
    steerable,
    traceContext,
    turnId,
    ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
  };
  this.activeTurnStartReservation = undefined;
  this.activeTurn = activeTurn;
  return activeTurn;
}

// 在真正 begin 之前预占 slot，挡住并发的第二个 turn。
// [并发] 它不创建 activeTurn，只写 reservation，因此不改变「最多一个活跃 turn」的判定。
// [失败路径] 已有 activeTurn 或已有 reservation 都抛 TurnInProgress。
export function reserveTurnStart(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
): void {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  // 预占位是 admission 与 begin 之间唯一的缝隙：两个输入同时通过校验时，这里只放行一个。
  // 已有预占就报它的 turnId，让并发的调用方知道该等谁，而不是只看到"有 turn 在跑"。
  if (this.activeTurnStartReservation) {
    throw createTurnInProgressError(kind, this.activeTurnStartReservation.turnId, turnId);
  }
  // 只写预占不建 activeTurn：此刻队列与 drain 仍看不到本轮，语义是"占坑未开桌"。
  this.activeTurnStartReservation = {
    kind,
    traceContext,
    turnId,
  };
}

export function releaseTurnStart(this: AgentRuntimeInternal, turnId: TurnId): void {
  // 只释放自己的预占：turnId 不符说明坑已被别的轮次接管，删掉会让那个轮次失去保护。
  if (this.activeTurnStartReservation?.turnId === turnId) {
    this.activeTurnStartReservation = undefined;
  }
}

// 结束活跃 turn：只有传入对象就是当前对象时才清空。
// [契约] 身份比较避免旧 turn 的收尾清掉新 turn。
// 它不清理 pendingInputs，丢弃由 discardPendingInput 单独负责。
export function finishActiveTurn(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  // 比引用而不是比 turnId：同 id 重建的新对象是另一个轮次，只比 id 会误清新轮。
  if (activeTurn !== undefined && this.activeTurn === activeTurn) {
    this.activeTurn = undefined;
  }
}

// 兜底 id：pending_ 前缀加 turnId 加单调序号。
// 序号在 runtime 上自增，重启后从 0 开始，因此不跨进程唯一。
// [契约] 只在调用方未提供 pendingInputId 与 queueItemId 时使用。
export function createPendingInputId(this: AgentRuntimeInternal, turnId: TurnId): string {
  this.pendingInputSequence += 1;
  return `pending_${turnId}_${this.pendingInputSequence}`;
}

// 统一构造并发冲突错误，标记为可恢复。
// [契约] 错误文本只含 kind，不含用户内容，避免日志泄漏。
// context 里带两个 turnId，供上层做重试或提示。
function createTurnInProgressError(
  kind: ActiveTurnKind,
  activeTurnId: TurnId,
  nextTurnId: TurnId,
): Error {
  // recoverable 为真：调用方可以等当前轮结束后重试，这不是致命错误。
  // 错误文本只含 kind，用户正文不进来，避免随日志外泄。
  return createCoreError(
    CoreErrorType.TurnInProgress,
    `Cannot start ${kind} turn while another turn is active`,
    {
      context: {
        activeTurnId,
        nextTurnId,
      },
      recoverable: true,
    },
  );
}

// 所有拒绝路径的公共出口：写 TurnSteerRejected 并返回结构化结果。
// [契约] 它不抛异常，保证热路径失败也有可解释返回值。
// [失败路径] 事件写入失败仍会抛出，此时属于存储故障而非业务拒绝。
// traceContext 优先取 activeTurn，保证拒绝事件挂在正确轮次。
export async function rejectTurnSteer(
  this: AgentRuntimeInternal,
  reason: TurnSteerRejectReason,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    expectedTurnId?: TurnId;
    inputPreview?: string;
    inputSize?: number;
    traceContext?: TraceContext;
  },
): Promise<TurnSteerResult> {
  // 三级回落：活跃轮的上下文最准，其次是调用方显式给的，最后才用根上下文兜底。
  const traceContext =
    options.activeTurn?.traceContext ?? options.traceContext ?? this.rootTraceContext;
  // 拒绝也必须有持久事实：没有事件的拒绝在冷恢复与排障时完全不可见。
  const event = createSessionEvent(
    SessionEventType.TurnSteerRejected,
    this.sessionId,
    {
      // activeTurnId 只在该轮仍存在时出现；no_active_turn 分支这里就该是 undefined。
      activeTurnId: options.activeTurn?.turnId,
      expectedTurnId: options.expectedTurnId,
      inputPreview: options.inputPreview,
      inputSize: options.inputSize,
      reason,
    },
    {
      traceId: traceContext.traceId,
      turnId: options.activeTurn?.turnId,
    },
  );
  // 这里不 try/catch：写盘失败属于存储故障，应向上冒泡，不能伪装成业务拒绝。
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Turn steer rejected", {
    ...traceContextToLogContext(traceContext),
    // 日志带队列长度与 steerable，便于区分"队列满"和"轮次不可 steer"两类拒绝。
    activeQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnSteerable: options.activeTurn?.steerable,
    event: "turn.steer.rejected",
    expectedTurnId: options.expectedTurnId,
    inputPreview: options.inputPreview,
    inputSize: options.inputSize,
    module: "core.runtime",
    reason,
    status: "completed",
  });
  // 返回值不带 queueLength：被拒绝的输入没入队，报长度会误导调用方。
  return {
    activeTurnId: options.activeTurn?.turnId,
    kind: "rejected",
    reason,
  };
}

export function hasPendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  return this.activeTurn === activeTurn && activeTurn.pendingInputs.length > 0;
}

// 投递语义的唯一解析点：显式 delivery 优先，其次 intent.admittedDelivery。
// [契约] 非法或缺省一律按 queue，避免意外内联注入。
// 两处字段必须同时维护，见 INV-15。
function pendingInputDelivery(pendingInput: PendingTurnInput | undefined): "guide" | "queue" {
  const delivery = pendingInput?.delivery ?? pendingInput?.intent?.admittedDelivery;
  return delivery === "guide" ? "guide" : "queue";
}

// 只在 guide 子序列里保持 FIFO，跳过命令类输入。
// [契约] 普通 queue 项留在原位，由 bootstrap 在 session-ready 后提升。
// 它返回下标而不是元素，便于调用方直接 splice。
// [失败路径] 若按数组下标 0 判断，先入队的普通消息会永久挡住 guide。
function firstInlineGuideIndex(activeTurn: ActiveTurnSteeringState): number {
  // pendingInputs 同时承载 future queue 与 current-turn guide，只检查
  // 数组队首，导致先入队的普通消息把后续显式 guide 永久挡住。delivery 才是消费车道；
  // 这里只在 guide 子序列内保持 admission FIFO，普通 queue 留在原位等待外层提升。
  return activeTurn.pendingInputs.findIndex(
    (pendingInput) =>
      pendingInput.commandKind !== "sendGoalCommand" &&
      pendingInput.commandKind !== "compact" &&
      pendingInputDelivery(pendingInput) === "guide",
  );
}

// 判断当前是否有可安全内联消费的 guide。
// 三重门：授权未发布、外部 drain 进行中、该项已被 reservation 占用。
// [契约] 任一为真都返回 false，宁可晚一轮也不能错误注入。
// 它还要求 commandKind 不是 sendGoalCommand 或 compact。
export function hasInlineGuidePendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  // 先定位 guide 子序列的头，再对这一个具体项做门禁，而不是对整条队列下结论。
  const guideIndex = firstInlineGuideIndex(activeTurn);
  const pendingInput = guideIndex >= 0 ? activeTurn.pendingInputs[guideIndex] : undefined;
  // 六个条件缺一不可：身份、授权、外部 drain、预占、两类命令、投递语义。
  // 没有 guide 时用空串查锁：空串不会命中任何真实 id，锁检查等于通过，最终由投递语义判否。
  return (
    this.activeTurn === activeTurn &&
    !this.permissionFullAccessPending &&
    !this.queueExternalDrainActive &&
    !this.pendingInputReservations.has(pendingInput?.id ?? "") &&
    pendingInput?.commandKind !== "sendGoalCommand" &&
    pendingInput?.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

/**
 * 当前 product turn 被 stop/interrupted，或 FIFO barrier 阻止安全 inline 时，把尚未消费的
 * guide 原地改投普通 queue。正常可消费的 text-only guide 仍在当前 active turn 内续跑。
 */
// 把未能消费的 guide 原地改投普通 queue，保留输入而不是丢弃。
// 逐项写 TurnSteerDeliveryChanged 事件并同步内存字段。
// [契约] 返回改道的条数，调用方据此判断是否需要额外提示。
// [失败路径] 事件写入失败会中断循环并抛出，已处理的项不会回滚。
export async function fallbackPendingGuidesToQueue(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reasonCode: "guide.noToolBoundary" | "guide.turnInterrupted";
    traceContext: TraceContext;
  },
): Promise<number> {
  // 身份不符直接返回 0，避免把新 turn 的 guide 改道。
  // [并发] 该检查必须在任何写操作之前。
  // 返回 0 而不是抛错，因为轮次切换是正常竞态。
  // 计数从 0 起：调用方拿到 0 表示"查过了但没有 guide"，与拿 undefined 的语义不同。
  if (this.activeTurn !== options.activeTurn) return 0;
  let changed = 0;
  // 遍历活的队列数组：改道只动 delivery，不摘元素，位置与 id 全部保持原样。
  for (const pendingInput of options.activeTurn.pendingInputs) {
    if (pendingInputDelivery(pendingInput) !== "guide") continue;
    // 有 intent 才扩写：凭空造一个会让冷恢复多出一条本不存在的结构化引用。
    const intent = pendingInput.intent
      ? {
          ...pendingInput.intent,
          admittedDelivery: "queue" as const,
          fallbackReasonCode: options.reasonCode,
        }
      : undefined;
    const event = this.createEvent(
      SessionEventType.TurnSteerDeliveryChanged,
      {
        admittedDelivery: "queue",
        fallbackReasonCode: options.reasonCode,
        ...(intent ? { intent } : {}),
        pendingInputId: pendingInput.id,
        requestedDelivery: "guide",
        targetTurnId: options.activeTurn.turnId,
      },
      options.traceContext,
    );
    await this.appendEvent(event, options.traceContext);
    // 同步推给调用方的事件收集器：本次请求的上下文里要立刻能看到这次改道。
    options.events?.push(event);
    // 内存字段必须与刚写的事件逐字一致；只改一处就是冷热投影事实分叉。
    pendingInput.delivery = "queue";
    if (intent) pendingInput.intent = intent;
    changed += 1;
    this.logger?.debug("Guide input fell back to ordinary queue", {
      ...traceContextToLogContext(options.traceContext),
      event: "turn.guide.fell_back",
      fallbackReasonCode: options.reasonCode,
      module: "core.runtime",
      pendingInputId: pendingInput.id,
      status: "completed",
      targetTurnId: options.activeTurn.turnId,
    });
  }
  return changed;
}

// 解析一条输入的归属 turn：先查内存，再查投影。
// [契约] 内存命中优先，因为 held 项在投影里才可见。
// 返回 undefined 表示该项已不存在，调用方应放弃本次操作。
async function pendingInputTargetTurnId(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
): Promise<TurnId | undefined> {
  // 内存优先：活跃轮的队列是实时事实，投影可能还停在上一次快照的旧序。
  const active = runtime.activeTurn?.pendingInputs.find((item) => item.id === pendingInputId);
  if (active) return active.turnId;
  // 内存没命中才重建投影：held 项只在事件日志里，这一步是有成本的兜底。
  // 投影也没有说明它已被消费或丢弃，返回 undefined 让调用方放弃，而不是猜一个轮次。
  const projection = await runtime.rebuildProjection();
  return projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId)
    ?.targetTurnId;
}

// 投递状态事件（queued/reserved/promoting）的唯一写入点。
// [契约] 三个状态对应 reservation 生命周期的三个节点。
// 它不复用 createEvent，保证事件形状集中可控。
// [失败路径] 写失败由调用方决定是否回滚内存状态。
async function appendPendingInputDispatch(
  runtime: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId?: string;
    state: "queued" | "reserved" | "promoting";
    targetTurnId: TurnId;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 不用 this.createEvent：三个状态的载荷要逐字对齐，集中在这里才不会被别处改歪。
  const event = createSessionEvent(
    SessionEventType.TurnSteerDispatchChanged,
    runtime.sessionId,
    {
      pendingInputId: options.pendingInputId,
      // reservationId 只在 reserved/promoting 出现：queued 状态没有持有者，不该带这个键。
      ...(options.reservationId ? { reservationId: options.reservationId } : {}),
      state: options.state,
      targetTurnId: options.targetTurnId,
    },
    { traceId: options.traceContext.traceId, turnId: options.targetTurnId },
  );
  // 只负责写，不负责回滚：内存锁的增删由调用方在自己的 catch 里决定，职责不跨界。
  await runtime.appendEvent(event, options.traceContext);
}

// 用户主动删除时，先把账本置为 cancelled 再删内存。
// [失败路径] 顺序颠倒会让 UI 队列先消失，而账本仍是 admitted，重启后被误报为 inputDiscardedOnRestart。
// [契约] 只有 user_removed 才落 cancelled，promoted 由消费路径自行结算。
// sessionStore 是可选依赖，缺失时静默跳过。
async function settleRemovedSessionInput(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  reason: "user_removed" | "promoted",
): Promise<void> {
  if (reason !== "user_removed") return;
  // 只删内存 queue/event 会留下 admitted 的 durable session_input。
  // LRU 淘汰后 commands/query 会退成 unknown，CLI restart 又会把用户主动删除误报为
  // inputDiscardedOnRestart。先写 cancelled 终态，失败时不允许 UI queue 先消失。
  await runtime.sessionStore?.settleSessionInput?.({
    id: pendingInputId,
    sessionID: runtime.sessionId,
    status: "cancelled",
    reason: "user_removed",
  });
}

async function persistSessionInputUpdates(
  runtime: AgentRuntimeInternal,
  updates: Array<{ id: string; text?: string; queuePosition?: number }>,
): Promise<void> {
  // 账本是可选依赖：没有 sessionStore 的测试桩与轻量 runtime 直接跳过，不当成错误。
  await runtime.sessionStore?.updateSessionInputs?.({
    sessionID: runtime.sessionId,
    updates,
  });
}

// 为一条输入加消费锁，供 sendQueuedNow 提升使用。
// [并发] 加锁前先恢复未发布的授权，避免用旧投影判断目标轮次。
// [契约] 成功后写 reserved 事件；失败时返回 false 而不是抛错。
// [失败路径] 事件写失败必须回滚内存锁并重新抛出。
export async function reservePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.permissionFullAccessPending || this.pendingInputReservations.has(options.pendingInputId))
    return false;
  // 先补发布再算目标轮次：旧投影可能把输入指向已被撤销授权的那个 turn。
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  // rebuildProjection 上方有 await；落锁前必须复查，避免两端同时读到未占用。
  // 不变量 5 的延伸：pendingInputReservations 是"单输入单消费者"的锁，
  // 防止 sendQueuedNow 的外层提升与 roundtrip drain 同时消费同一条输入。
  if (
    !targetTurnId ||
    this.permissionFullAccessPending ||
    this.pendingInputReservations.has(options.pendingInputId)
  )
    return false;
  this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
  try {
    await appendPendingInputDispatch(this, {
      ...options,
      state: "reserved",
      targetTurnId,
    });
    return true;
  } catch (error) {
    this.pendingInputReservations.delete(options.pendingInputId);
    throw error;
  }
}

// 把 reservation 推进到 promoting 状态，表示即将消费。
// [并发] 只有持有者能推进：reservation 值不匹配直接返回 false。
// [契约] 状态事件写失败会抛出，调用方需自行决定是否释放。
export async function markPendingInputPromoting(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  // 值比对就是持有者校验：换一个 reservationId 说明调用方没拿到锁，不能推进状态。
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  // 目标轮次解析不出来说明输入已在别处被删，停在 reserved 比谎报 promoting 安全。
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) return false;
  await appendPendingInputDispatch(this, {
    ...options,
    state: "promoting",
    targetTurnId,
  });
  return true;
}

// 释放消费锁，并把投递状态写回 queued。
// [并发] 先删内存锁再写事件；写失败必须把锁放回去。
// [失败路径] 否则「已释放但事件未落」会让另一消费者再次消费同一条输入。
// [契约] 目标轮次已不可解析时直接返回 true，不再发事件。
export async function releasePendingInputReservation(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  // 先删锁再写回 queued：先写事件会在中间窗口里让锁与事件互相矛盾。
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  this.pendingInputReservations.delete(options.pendingInputId);
  if (!targetTurnId) return true;
  try {
    await appendPendingInputDispatch(this, {
      pendingInputId: options.pendingInputId,
      state: "queued",
      targetTurnId,
      traceContext: options.traceContext,
    });
  } catch (error) {
    // 事件写失败时 reservation 仍必须保持，不能让第二端重复执行。
    // 不变量 5：reservation 是消费权的唯一凭证，释放必须与"事件落盘成功"绑定，
    // 否则 crash 在"已释放但事件未落"的窗口会导致输入被静默丢失。
    this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
    throw error;
  }
  return true;
}

/**
 * （v4 queue 单项管理）：按 id 从当前 active turn 的 pendingInputs 移除一条，
 * 发 TurnSteerDiscarded([id])。v4 ProductProjection 已消费该事件移除对应 queue row。
 * 旧架构 queue 是 renderer-local，无单项 op；v4 queue 移入 CLI 投影后需此原生能力。
 * 返回是否移除（未命中 id / 无 active turn → false）。
 */
// 按 id 删除一条排队输入，支持内存态与 held 态。
// [并发] 先校验 reservation 归属，非持有者一律拒绝。
// [契约] 删除前先结算账本，避免留下 admitted 幽灵记录。
// [失败路径] 内存未命中时走投影回落，而不是直接返回 false。
export async function removePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  // 非持有者一律拒绝：删除会连带清掉锁，不能让另一条路径替持有者抹掉输入。
  const reservationId = this.pendingInputReservations.get(options.pendingInputId);
  if (reservationId && reservationId !== options.reservationId) return false;
  // 先在内存队列定位：找不到不代表不存在，可能是轮次结束后留在投影里的 held 项。
  const activeTurn = this.activeTurn;
  const index =
    activeTurn?.pendingInputs.findIndex(
      (pendingInput) => pendingInput.id === options.pendingInputId,
    ) ?? -1;
  if (!activeTurn || index < 0) {
    // held 回落（stop/完成后 queue 保留成 held）：held 项只存在于
    // 事件日志/投影（active turn 已结束），按投影定位后补 TurnSteerDiscarded。
    return this.discardHeldPendingInputById(
      options.pendingInputId,
      options.traceContext,
      options.reservationId,
      options.reason,
    );
  }
  // 先结算账本再动内存：顺序反过来会出现 UI 队列已空、账本仍 admitted 的窗口。
  // 单下标 splice 保持其余项相对顺序，重排与 drain 都依赖这个顺序。
  await settleRemovedSessionInput(this, options.pendingInputId, options.reason);
  activeTurn.pendingInputs.splice(index, 1);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [options.pendingInputId],
      reason: options.reason,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  // 事件写成功后才清锁：先清锁再写失败，这条输入会变成可被再次领取的幽灵。
  this.pendingInputReservations.delete(options.pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(options.traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId: options.pendingInputId,
    status: "completed",
    targetTurnId: activeTurn.turnId,
  });
  return true;
}

/**
 * held 项按 id 丢弃（heldQueueDisposition=clearQueueAndSend 的执行件）：
 * active turn 结束后 pendingInputs 内存态即消亡，held queue 的权威在事件日志——
 * 经投影反查该项仍未 drain/discard 后补 TurnSteerDiscarded(user_removed)。
 */
// held 项的删除实现：active turn 已结束，权威只剩事件投影。
// [契约] 投影里找不到即视为已被消费，返回 false 不重复写事件。
// 写 TurnSteerDiscarded 后删除内存锁，保证不会残留 reservation。
// [失败路径] 事件写入失败会抛出，此时账本已置 cancelled，需要上层重试。
export async function discardHeldPendingInputById(
  this: AgentRuntimeInternal,
  pendingInputId: string,
  traceContext: TraceContext,
  reservationId?: string,
  reason: "user_removed" | "promoted" = "user_removed",
): Promise<boolean> {
  // 与内存路径同一把锁：投影删除同样要先确认调用方就是持有者。
  const currentReservation = this.pendingInputReservations.get(pendingInputId);
  if (currentReservation && currentReservation !== reservationId) return false;
  // held 项的权威只剩事件日志，重建投影是拿到 targetTurnId 的唯一途径。
  const projection = await this.rebuildProjection();
  const held = projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId);
  // 投影里没有说明它已被 drain 或删过，重发事件会让投影再删一条不存在的输入。
  // 账本终态先写：失败就退出，避免事件已发而账本永远停在 admitted。
  if (!held) return false;
  await settleRemovedSessionInput(this, pendingInputId, reason);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [pendingInputId],
      reason,
      targetTurnId: held.targetTurnId,
    },
    {
      traceId: traceContext.traceId,
      turnId: held.targetTurnId,
    },
  );
  // 写失败直接抛：锁因此仍留在持有者名下，重试是同一次删除而不是两次。
  await this.appendEvent(event, traceContext);
  this.pendingInputReservations.delete(pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId,
    status: "completed",
    targetTurnId: held.targetTurnId,
  });
  return true;
}

/**
 * 清空全部排队输入（heldQueueDisposition=clearQueueAndSend 的执行件）：
 * 先摘 active turn 内存项（防后续 roundtrip drain），再按投影清扫 held 残留。
 * 返回丢弃条数。
 */
// 清空全部排队输入：先摘内存项，再按投影清扫 held 残留。
// [并发] 先清内存是为了让并发的 roundtrip drain 找不到可消费项。
// [契约] 两段都累加 cleared，返回值是真实的丢弃总数。
// [失败路径] 结算账本逐条进行，任一条失败会中断，已结算的不会回滚。
export async function clearAllPendingInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  // 计数跨两段累加：内存项与 held 项来自不同事实源，返回值必须是两者之和。
  let cleared = 0;
  const activeTurn = this.activeTurn;
  // 带长度判断：空队列不写空事件，避免投影收到一条没有 id 的丢弃。
  if (activeTurn && activeTurn.pendingInputs.length > 0) {
    // 逐条结算账本而非批量：settle 是单条接口，任一失败即中断，前面的不回滚。
    for (const item of activeTurn.pendingInputs) {
      await settleRemovedSessionInput(this, item.id, "user_removed");
    }
    // splice(0) 一次取走全部并保留顺序：事件里的 id 列表因此与入队顺序一致。
    const removed = activeTurn.pendingInputs.splice(0);
    cleared += removed.length;
    // 内存段只发一条事件：splice 已经保证原子取出，逐条发不增加任何信息。
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: removed.map((item) => item.id),
        reason: "user_removed",
        targetTurnId: activeTurn.turnId,
      },
      {
        traceId: activeTurn.traceContext.traceId,
        turnId: activeTurn.turnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  // 第二段必须重建投影：内存清空后仍可能有属于已结束轮次的 held 项留在事件日志里。
  const projection = await this.rebuildProjection();
  const heldByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const item of projection.pendingSteerInputs) {
    const group = heldByTurn.get(item.targetTurnId) ?? [];
    group.push(item);
    heldByTurn.set(item.targetTurnId, group);
  }
  // 按轮次分组发事件：事件契约要求一条 TurnSteerDiscarded 只挂一个 targetTurnId。
  for (const [targetTurnId, group] of heldByTurn) {
    for (const item of group) {
      await settleRemovedSessionInput(this, item.pendingInputId, "user_removed");
    }
    // 累加的是本组条数而不是事件条数：调用方要的是"一共丢了几条输入"。
    cleared += group.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: group.map((item) => item.pendingInputId),
        reason: "user_removed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  return cleared;
}

/**
 * （v4 queue 单项编辑）：按 id 替换某排队输入的文本，重发 TurnSteerQueued（同 id）。
 * v4 reducer 的 onTurnSteerQueued 对同 id 原地更新（保位）。未命中 / 无 active turn → false。
 */
// 按 id 替换正文，重发同 id 的 TurnSteerQueued（投影原地更新、保位）。
// [契约] 必须同时更新内存 input 与 intent.text，否则结构化引用恢复时显示旧正文。
// [失败路径] 内存未命中时走 held 投影回落，按投影中的 commandKind 与 intent 重建事件。
// 编辑不改变队列位置，也不重新计算 queueLength。
export async function editPendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    newText: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  // 编辑分两条路：内存命中直接改，未命中按 held 处理，两条路的载荷必须同构。
  // 内存与投影二选一的判定点：命中内存就不必重建投影，未命中才付那份成本。
  const activeTurn = this.activeTurn;
  const pendingInput = activeTurn?.pendingInputs.find((item) => item.id === options.pendingInputId);
  if (!activeTurn || !pendingInput) {
    // held 回落：held 项只在事件日志/投影，经投影定位后
    // 重发同 id TurnSteerQueued（v4 reducer 原地更新，保位）。
    // 只有内存未命中才重建投影：正常编辑是纯内存操作，不该为它付投影成本。
    const projection = await this.rebuildProjection();
    const held = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === options.pendingInputId,
    );
    // 投影也没有说明它已被消费：返回 false 让前端撤回这一行，而不是继续显示旧正文。
    if (!held) return false;
    await persistSessionInputUpdates(this, [{ id: held.pendingInputId, text: options.newText }]);
    // 重发同 id 的 TurnSteerQueued：投影按键原地更新，队列位置因此不变。
    const event = createSessionEvent(
      SessionEventType.TurnSteerQueued,
      this.sessionId,
      {
        pendingInputId: held.pendingInputId,
        input: options.newText,
        inputPreview: previewInput(options.newText),
        inputSize: measureUtf8Bytes(options.newText),
        ...(held.commandKind ? { commandKind: held.commandKind } : {}),
        ...(held.intent ? { intent: { ...held.intent, text: options.newText } } : {}),
        ...(held.toolDisallowlist ? { toolDisallowlist: held.toolDisallowlist } : {}),
        queueLength: projection.pendingSteerInputs.length,
        targetTurnId: held.targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: held.targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  // 内存路径同样先落账本：顺序反过来会在两次写之间被重启，正文回退到旧值。
  // 正文与 intent.text 都要改：前者喂给模型，后者在冷恢复时重建结构化引用。
  await persistSessionInputUpdates(this, [{ id: pendingInput.id, text: options.newText }]);
  pendingInput.input = options.newText;
  // 编辑正文后必须同步 canonical text，否则结构化引用恢复时会显示旧正文。
  if (pendingInput.intent) pendingInput.intent = { ...pendingInput.intent, text: options.newText };
  // 复用的是 queued 事件而不是新事件类型：投影已有原地更新语义，不必新增一套。
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      pendingInputId: pendingInput.id,
      queryId: pendingInput.queryId,
      input: options.newText,
      inputPreview: previewInput(options.newText),
      inputSize: measureUtf8Bytes(options.newText),
      ...(pendingInput.commandKind ? { commandKind: pendingInput.commandKind } : {}),
      ...(pendingInput.delivery ? { delivery: pendingInput.delivery } : {}),
      ...(pendingInput.inputPresentation
        ? { inputPresentation: pendingInput.inputPresentation }
        : {}),
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
      queueLength: activeTurn.pendingInputs.length,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * （v4 queue 重排）：把 pendingInputId 移到 beforePendingInputId 之前（null = 移到队尾），
 * 发 TurnSteerReordered(新序)。v4 reducer 按新序重排 queue rows。未命中 → false。
 */
// 把目标项移到指定项之前，null 表示移到最后。
// [契约] beforePendingInputId 不存在时退回队尾，而不是丢项。
// [并发] 内存态与 held 态分别重排，二者不会同时存在。
// [失败路径] held 态取 targetTurnId 时以首项兜底，避免 undefined。
export async function reorderPendingInput(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  // 重排只在队列内部换位置，不增不删，id 集合必须逐字保持不变。
  const activeTurn = this.activeTurn;
  const fromIndexActive =
    activeTurn?.pendingInputs.findIndex((item) => item.id === options.pendingInputId) ?? -1;
  if (!activeTurn || fromIndexActive < 0) {
    // held 回落：在投影序上重排后发 TurnSteerReordered（v4 reducer 按新序重排）。
    // 没有活跃轮时可重排的只有投影里那条尚未消费的序列。
    // 只取 id 做重排，正文与 intent 留在原对象里，避免搬运时丢字段。
    const projection = await this.rebuildProjection();
    const heldIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
    const fromIndex = heldIds.indexOf(options.pendingInputId);
    if (fromIndex < 0) return false;
    // 先摘出再插入：不先摘会让"移到自己前面"这类输入算出错误下标。
    heldIds.splice(fromIndex, 1);
    if (options.beforePendingInputId === null) {
      heldIds.push(options.pendingInputId);
    } else {
      const beforeIndex = heldIds.indexOf(options.beforePendingInputId);
      if (beforeIndex < 0) {
        heldIds.push(options.pendingInputId);
      } else {
        heldIds.splice(beforeIndex, 0, options.pendingInputId);
      }
    }
    // held 路径把整条序列的位置一次性写回，账本据此与投影同序。
    await persistSessionInputUpdates(
      this,
      heldIds.map((id, queuePosition) => ({ id, queuePosition })),
    );
    // 目标项自己的轮次优先；它若刚被删就用首项兜底，保证事件总有 turnId 可挂。
    const targetTurnId =
      projection.pendingSteerInputs.find((item) => item.pendingInputId === options.pendingInputId)
        ?.targetTurnId ?? projection.pendingSteerInputs[0]!.targetTurnId;
    const event = createSessionEvent(
      SessionEventType.TurnSteerReordered,
      this.sessionId,
      {
        orderedPendingInputIds: heldIds,
        targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  // 先复制数组再操作：直接改原数组会在 await 期间被 drain 观察到半成品顺序。
  // 复制后重查下标：与前面的内存查找结果一致，但作用于独立副本。
  const items = [...activeTurn.pendingInputs];
  const fromIndex = items.findIndex((item) => item.id === options.pendingInputId);
  if (fromIndex < 0) return false;
  const [moved] = items.splice(fromIndex, 1);
  if (!moved) return false;
  if (options.beforePendingInputId === null) {
    items.push(moved);
  } else {
    const beforeIndex = items.findIndex((item) => item.id === options.beforePendingInputId);
    if (beforeIndex < 0) {
      // 目标锚点已消失 → 退回队尾，不丢项。
      items.push(moved);
    } else {
      items.splice(beforeIndex, 0, moved);
    }
  }
  // 只重排数组而不更新 intent.queuePosition，会让 live queue 顺序正确，
  // 但 drain 后 transcript 又写回 admission 时的旧位置，造成冷热投影事实分叉。
  const reorderedItems = items.map((item, index) =>
    item.intent ? { ...item, intent: { ...item.intent, queuePosition: index } } : item,
  );
  // 账本写的是重排后的下标而不是原数组位置：冷恢复按这个数字重建顺序。
  await persistSessionInputUpdates(
    this,
    reorderedItems.map((item, queuePosition) => ({ id: item.id, queuePosition })),
  );
  // 用 splice 原地替换而不是赋新数组：持有该数组引用的调用方仍能看到同一份队列。
  activeTurn.pendingInputs.splice(0, activeTurn.pendingInputs.length, ...reorderedItems);
  const event = createSessionEvent(
    SessionEventType.TurnSteerReordered,
    this.sessionId,
    {
      orderedPendingInputIds: reorderedItems.map((item) => item.id),
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * （v4 setAutoDrain）：翻转 queue autoDrain 授权位（会话级配置，与 active turn 无关）。
 * 仅追加 QueueAutoDrainChanged 事件供 v4 投影消费；held 派生（completed+queue>0+autoDrain=false
 * → choice 路由）与后续 heldQueueDisposition 命令闭合发送语义。
 */
// 翻转会话级 autoDrain 授权位，与活跃 turn 无关。
// [契约] 授权位同时写 runtime（drain 门）与事件（投影派生暂停队列）。
// [失败路径] 事件写失败会抛出，但 runtime 字段已被修改，需要调用方重试或回滚。
export async function setQueueAutoDrain(
  this: AgentRuntimeInternal,
  options: {
    autoDrain: boolean;
    traceContext: TraceContext;
  },
): Promise<void> {
  // false -> true 表示用户从暂停队列恢复。旧暂停项只存在于事件投影，不在新
  // activeTurn.pendingInputs 中；恢复期间改由 CLI 外层按完整投影 FIFO 逐项提升。
  if (options.autoDrain && !this.queueAutoDrain) {
    this.queueExternalDrainActive = true;
  } else if (!options.autoDrain) {
    this.queueExternalDrainActive = false;
  }
  // 授权位同时进 runtime（drain 门）与事件日志（投影派生暂停队列）。
  this.queueAutoDrain = options.autoDrain;
  const event = createSessionEvent(
    SessionEventType.QueueAutoDrainChanged,
    this.sessionId,
    { autoDrain: options.autoDrain },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/** CLI 投影确认恢复队列已空后，重新允许 core 在后续 tool batch 边界消费 guide。 */
// CLI 外层处理完恢复队列后调用，重新允许 core 在 tool batch 边界消费 guide。
// [并发] 与 setQueueAutoDrain 的置位成对：置位期间行内 drain 必须让路。
// [契约] 它只清运行时标志，不写事件，因为这是进程内的瞬时状态。
export function completeExternalQueueDrain(this: AgentRuntimeInternal): void {
  this.queueExternalDrainActive = false;
}

/**
 * （v4 setFollowupMode）：翻转 followup 路由模式（会话级配置）。
 * 仅追加 FollowupModeChanged 事件供 v4 投影消费；running 时 computeInputRouting 依此在
 * enqueue（queue）与 guide 之间选择。
 */
export async function setFollowupMode(
  this: AgentRuntimeInternal,
  options: {
    mode: "queue" | "guide";
    traceContext: TraceContext;
  },
): Promise<void> {
  // 只写事件不改内存：followup 模式的权威在投影，core 每次路由都重新读它。
  const event = createSessionEvent(
    SessionEventType.FollowupModeChanged,
    this.sessionId,
    { mode: options.mode },
    { traceId: options.traceContext.traceId },
  );
  // 写失败直接抛：模式没切成功却返回成功，下一次输入会按错误的语义投递。
  await this.appendEvent(event, options.traceContext);
}

/**
 * （v4 switchModelConfig）：模型选型变化后追加 ModelSelected 事件供投影消费。
 * v4 reducer 的 onModelSelected 依此更新 config.provider/model/thought 和实际 context window，
 * 并（中途切换时）产出 modelChange marker。实际 provider client 切换由 app.setModel 完成，
 * 此处把切换后的完整模型能力元组写入同一个事件。
 */
// 模型切换后补发 ModelSelected，供 v4 投影更新 config 与 context window。
// [契约] contextWindow 必须来自本次创建的 Active Model，不能复制 Runtime Config。
// [失败路径] previousModelSelection 为 null 是显式边界，按 truthy 判断会丢掉该字段。
// 模型实例可注入，缺省时才用 createRuntimeModel 现造。
export async function emitModelSelected(
  this: AgentRuntimeInternal,
  options: {
    modelSelection: ModelSelection;
    model?: import("../deps.js").Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext: TraceContext;
  },
): Promise<void> {
  // 允许注入模型实例：测试与已构造好的 Active Model 不必再走一次创建与凭据解析。
  const model = options.model ?? createRuntimeModel(this, { selection: options.modelSelection });
  // 事件里放的是切换后的模型与窗口，投影据此整体替换而不是增量合并。
  const event = createSessionEvent(
    SessionEventType.ModelSelected,
    this.sessionId,
    {
      // 模型切换事件必须从本次创建的 Active Model 读取窗口，不能再复制 Runtime Config。
      // 窗口取新建实例而不是配置副本：配置可能还是切换前的，窗口会偏小。
      contextWindow: model.properties.contextWindow,
      modelSelection: cloneModelSelection(options.modelSelection),
      ...(options.effectiveReasoningLevel
        ? { effectiveReasoningLevel: options.effectiveReasoningLevel }
        : {}),
      // previousModelSelection=null 是显式 ∅→X 模型边界，不能按 truthy 判断丢失。
      ...(options.previousModelSelection !== undefined
        ? {
            previousModelSelection: options.previousModelSelection
              ? cloneModelSelection(options.previousModelSelection)
              : null,
          }
        : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.supportedThoughtLevels
        ? { supportedThoughtLevels: [...options.supportedThoughtLevels] }
        : {}),
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
  // 事件写成功后才登记已发布选择：先登记会让下一次判断误以为模型已经生效。
  recordPublishedModelSelection(this, options.modelSelection);
}

/**
 * （v4 switchCollaborationMode）：命令面切换协作模式后追加 SessionModeChanged 事件。
 * app.setMode 只更新 runtime config + 持久化偏好、不产事件（session-mode-port 的
 * enterPlanMode/exitPlanMode 仅覆盖 plan 工具路径），v4 投影的 config.mode 更新靠这条补发。
 */
export async function emitModeChanged(
  this: AgentRuntimeInternal,
  options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  },
): Promise<void> {
  // mode 与 planEnabled 都现取 runtime 值：command 面已经改完，事件只负责广播结果。
  // previousMode 由调用方传入而不是从事件流反推：并发切换时反推会拿到别人的上一态。
  const event = createSessionEvent(
    SessionEventType.SessionModeChanged,
    this.sessionId,
    {
      mode: this.getMode(),
      planEnabled: this.getPlanEnabled(),
      previousMode: options.previousMode,
      // 来源固定为 command：投影据此区分命令切换与 plan 工具路径产生的切换。
      source: "command",
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

// 行内 drain 的带锁入口：权限门、授权恢复、重入计数。
// [并发] 授权未发布时不能 drain，否则会把输入注入旧授权状态。
// [契约] recover 是异步的，前后各检查一次 activeTurn 与权限。
// [资源] pendingInputDrains 在 finally 递减，异常路径也不会漏减。
export async function drainPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    traceContext: TraceContext;
  },
): Promise<DrainedPendingInputDiagnostics | undefined> {
  // 审批授权尚未发布时不能 drain:此时投影里的授权目标还是旧的,
  // 把 steer 输入注入进去会让下一请求基于错误的授权状态。
  // 这是不变量 3（权限只能收紧）的运行时体现：未发布的授权意味着权限状态
  // 还在变化中，此时 drain 可能让模型在旧权限下执行本应被拒绝的操作。
  // 第一道门：授权未发布或轮次已切换时直接放弃本次 drain。
  // [并发] 此时投影里的授权目标仍是旧的，注入会基于错误权限执行。
  // 返回 undefined 而不是空结果，调用方据此继续正常请求。
  // 这是不变量「权限只能收紧」在 drain 路径上的唯一落点。
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  // 先把"已发布但未落盘"的授权恢复出来,再重新检查一次:
  // recover 是异步的,期间 activeTurn/permission 状态都可能变化。
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  // Guide 出队先移除内存、后落事件；完整消费期间不能从旧投影捕获授权目标。
  // pendingInputDrains 是重入计数:嵌套 drain 只允许最外层真正消费,
  // 计数本身也让"是否有 drain 正在进行"可被其它逻辑观测。
  // 重入计数：嵌套调用只允许最外层真正消费。
  // [并发] 计数本身也让其它逻辑能观测「是否有 drain 正在进行」。
  // [契约] 必须与 finally 中的递减成对出现，异常路径也不例外。
  // [失败路径] 漏减会让后续所有 drain 被误判为重入而永久失效。
  this.pendingInputDrains = (this.pendingInputDrains ?? 0) + 1;
  try {
    return await drainPendingInputUnlocked.call(this, options);
  } finally {
    this.pendingInputDrains -= 1;
  }
}

// 真正的消费实现：取一条 guide，写 user 消息与 transcript，再发 drained 事件。
// [契约] 一次只消费一条，保持单步可解释且不会打乱队列。
// [失败路径] 事件在 persistUserPrompt 之后写，避免投影看到没有 transcript 的输入。
// 被 reservation 占用或没有 guide 时返回 undefined，让调用方继续正常请求。
async function drainPendingInputUnlocked(
  this: AgentRuntimeInternal,
  options: Parameters<typeof drainPendingInput>[0],
): Promise<DrainedPendingInputDiagnostics | undefined> {
  const guideIndex = firstInlineGuideIndex(options.activeTurn);
  // 行内 drain 只取 guide 子序列里最早的一项;没有 guide 就返回 undefined,
  // 让调用方继续正常请求(而不是误消费 queue 输入)。
  const pendingInput = guideIndex >= 0 ? options.activeTurn.pendingInputs[guideIndex] : undefined;
  if (!pendingInput) return undefined;
  // sendQueuedNow 已 reserve 的队首只能由 reservation owner 提升；普通 roundtrip drain
  // 必须暂停，避免 stop barrier 期间同一输入又被当前 turn 消费一次。
  // 不变量 5：reservation 持有期间，任何其他消费者都不能碰这条输入。
  if (this.pendingInputReservations.has(pendingInput.id)) return undefined;
  // 普通 queue 只能由 bootstrap 在 session-ready + goal gate 后提升；runtime 行内 drain
  // 从 guide 子序列取最早一项，不能让 future queue 偷跑，也不能让它阻塞当前轮引导。
  // 从内存队列摘除，保证同一项不会被下一轮再次取到。
  // [契约] 只删 guide 下标，不触碰其它 queue 项的位置。
  // [失败路径] 若在此之前抛错，该项仍在队列中，属于可重试的安全状态。
  options.activeTurn.pendingInputs.splice(guideIndex, 1);
  const pendingInputs = [pendingInput];
  const queryIds = pendingInput.queryId ? [pendingInput.queryId] : undefined;
  // steer 是新的真实用户 query。drain 后的下一次模型请求必须切到该 queryId，
  // 不能继续沿用原始 turn query，否则 tool 后续请求会被归因到上一条用户消息。
  // drain 后的请求必须切到该输入的 queryId。
  // [契约] 沿用原 turn query 会把后续 tool 请求归因到上一条用户消息。
  // 没有 queryId 时回落到原上下文，保持旧行为。
  const drainTraceContext = pendingInput.queryId
    ? { ...options.traceContext, queryId: pendingInput.queryId }
    : options.traceContext;

  const drainedAt = Date.now();
  const inputPreviews = pendingInputs.map((pendingInput) => previewInput(pendingInput.input));
  const inputSizes = pendingInputs.map((pendingInput) => measureUtf8Bytes(pendingInput.input));
  const queuedDurationsMs = pendingInputs.map(
    (pendingInput) => drainedAt - pendingInput.queuedAt.getTime(),
  );
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];
  const drainedInputs: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: "guide" | "queue";
    intent?: NonNullable<PendingTurnInput["intent"]>;
    toolDisallowlist?: readonly string[];
  }> = [];
  for (const pendingInput of pendingInputs) {
    const messageId = createMessageId();
    // 投递语义缺省按 queue（排队消费=独立轮）；guide 由 v4 命令面
    // 按 inputRouting 显式标注。落到持久 metadata 供冷恢复还原同一切分。
    // 落进 transcript 的 delivery 缺省为 queue，与入队侧保持一致。
    // [契约] 该值写进持久 metadata，冷恢复据此还原同一切分。
    // [失败路径] 两处缺省不一致会导致重启后 guide 变成 queue。
    const delivery = pendingInput.delivery ?? "queue";
    // 附件在这里才解析成运行时可用形态，入队阶段只存原始引用。
    // [资源] 解析失败会中断本条 drain，输入已从队列摘除，需要上层补偿。
    // [契约] 解析使用 drainTraceContext，保证附件读写挂在新的 queryId 下。
    // 产物写入 artifactStore，transcript 只保留引用。
    const resolvedAttachments = await resolveTurnAttachments(pendingInput.attachments, {
      artifactStore: this.artifactStore,
      fileSystemPort: this.fileSystemPort,
      imageProcessorPort: this.imageProcessorPort,
      sessionId: this.sessionId,
      traceContext: drainTraceContext,
      turnId: options.activeTurn.turnId,
      workingDirectory: this.workingDirectory,
    });
    // 只在实际 guide 消费且无附件时固化新标记；审批反馈仍走原合同。
    const inputPresentation =
      delivery === "guide" && !pendingInput.source && !pendingInput.attachments?.length
        ? parseRuntimeInputPresentation(pendingInput.inputPresentation)
        : undefined;
    const runtimeEntry = createRuntimeUserEntry(
      buildUserContentFromTurn(
        withConversationQuotes(
          pendingInput.input,
          pendingInput.intent?.conversationQuotes,
          pendingInput.intent?.botGroupSource,
        ),
        resolvedAttachments,
      ),
      runtimeInputMetadata(inputPresentation) ?? realUserRuntimeMetadata(),
    );
    this.messageHistory.addEntries([runtimeEntry]);
    runtimeEntries.push(runtimeEntry);
    // user 消息与账本 promotion 在同一事务里落盘。
    // [契约] sessionInputId 让「账本置 promoted + transcript 写入」原子化。
    // [失败路径] 缺少该参数会产生「输入已消费但 transcript 没有这条消息」的孤儿窗口。
    // sourceCommandId 优先取 intent，否则退回 queryId 或 pendingInputId。
    await this.persistUserPrompt(
      messageId,
      pendingInput.input,
      resolvedAttachments,
      drainTraceContext,
      {
        steerDelivery: delivery,
        inputPresentation,
        // sessionInputId 让"账本置 promoted + message/parts 落盘"走同一事务,
        // 避免出现"输入已消费但 transcript 没有这条 user 消息"的孤儿窗口。
        sessionInputId: pendingInput.id,
        sourceCommandId:
          pendingInput.intent?.sourceCommandId ?? String(pendingInput.queryId ?? pendingInput.id),
        clientId: pendingInput.intent?.clientId,
        intent: pendingInput.intent,
      },
    );
    messageIds.push(messageId);
    drainedInputs.push({
      pendingInputId: pendingInput.id,
      messageId,
      text: pendingInput.input,
      delivery,
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
    });
  }

  // id 列表先算一次：事件载荷与日志共用同一份，两个 .map 的顺序不会各自漂移。
  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);
  // 多条输入的禁用工具取并集，保证合并后不会放宽任何一条的限制。
  // [契约] 用 Set 去重后转数组，输出顺序按首次出现，便于稳定比对。
  // [失败路径] 若取交集或覆盖，会允许本应被禁止的工具被调用。
  const toolDisallowlist = [
    ...new Set(pendingInputs.flatMap((pendingInput) => pendingInput.toolDisallowlist ?? [])),
  ];
  const event = this.createEvent(
    SessionEventType.TurnSteerDrained,
    {
      injectedMessageIds: messageIds,
      pendingInputIds,
      drainedInputs,
      ...(queryIds ? { queryIds } : {}),
      targetTurnId: options.activeTurn.turnId,
    },
    drainTraceContext,
  );
  // TurnSteerDrained 在 transcript 落盘之后写入，顺序不可交换。
  // [契约] 事件里带 drainedInputs 与 injectedMessageIds，供投影对齐。
  // [失败路径] 写失败会抛出，此时消息已落盘，重试需要保证幂等。
  await this.appendEvent(event, drainTraceContext);
  // 同步推给调用方：本轮请求的上下文里要能立刻看到这条 drain 事件。
  options.events.push(event);
  this.logger?.debug("Turn steer drained", {
    ...traceContextToLogContext(drainTraceContext),
    drainedCount: pendingInputs.length,
    event: "turn.steer.drained",
    injectedMessageIds: messageIds,
    inputPreviews,
    inputSizes,
    module: "core.runtime",
    pendingInputIds,
    queryIds,
    queuedDurationsMs,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
  return {
    injectedMessageIds: messageIds,
    ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
    latestMessageId: messageIds.at(-1),
    pendingInputIds,
    queryIds,
    runtimeEntries,
    ...(toolDisallowlist.length > 0 ? { toolDisallowlist } : {}),
  };
}

// 轮次终结时作废全部 pendingInputs，一次性 splice 取出。
// [并发] 先校验 activeTurn 身份，避免清掉新 turn 的队列。
// [契约] 空队列直接返回，不写空事件。
// [失败路径] 事件写失败会抛出，但内存项已被取出，属于不可回滚的终结路径。
export async function discardPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  },
): Promise<void> {
  // 先校验 activeTurn 仍是同一个对象:避免把"新 turn 的队列"误清成"旧 turn 的残留"。
  // 不变量 5：activeTurn 是 turn 身份的锚点，discard 必须绑定到具体的 activeTurn 实例，
  // 否则 turn 结束后新 turn 已开始时，旧 turn 的 catch 会误清新 turn 的 pendingInputs。
  if (this.activeTurn !== options.activeTurn) return;
  // splice(0) 一次性取出全部:discard 是 turn 终结路径,语义是"这些输入全部作废",
  // 不存在部分保留;逐条删除会留下"半清空"的中间态。
  // 一次性取出全部，discard 的语义是「这些输入全部作废」。
  // [契约] 逐条删除会留下半清空的中间态，且可能被并发 drain 取走。
  // 取出顺序即入队顺序，事件里的 id 列表保持稳定。
  const pendingInputs = options.activeTurn.pendingInputs.splice(0);
  if (pendingInputs.length === 0) return;
  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);

  // 一条批量事件承载全部 id：逐条发会让投影多次重算整条队列。
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds,
      reason: options.reason,
      targetTurnId: options.activeTurn.turnId,
    },
    {
      traceId: options.activeTurn.traceContext.traceId,
      turnId: options.activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  options.events?.push(event);
  this.logger?.debug("Turn steer discarded", {
    ...traceContextToLogContext(options.traceContext),
    discardedCount: pendingInputs.length,
    event: "turn.steer.discarded",
    module: "core.runtime",
    pendingInputIds,
    reason: options.reason,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
}

// 重启清扫：把账本中 admitted 的输入统一置为 discarded(session_resumed)。
// [契约] 只把 admitted 结算成 discarded，不会删除账本，保留「这条输入去哪了」的痕迹。
// [失败路径] 清扫失败只记 warn 不抛出，避免 session 无法启动。
// 随后按目标 turn 分组补发 TurnSteerDiscarded，让投影与账本一致。
export async function discardPersistedPendingSteerInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  // （重启不保留队列）：先清扫账本残留 admitted——事件日志是
  // 内存的，崩溃后投影里什么都没有，账本是唯一痕迹（含 background wake：后台
  // 子进程随 CLI 重启已死，其未消费通知不可恢复）。留痕（discarded/session_resumed）
  // 不静默，用户/诊断可查「这条输入去哪了」。
  // 整段用 try 包住：清扫是启动期动作，失败不能让 session 起不来。
  // 只捞 admitted：已有终态的记录重复结算会覆盖真实原因。
  try {
    const admitted =
      (await this.sessionStore?.listSessionInputs?.({
        sessionID: this.sessionId,
        status: "admitted",
      })) ?? [];
    for (const record of admitted) {
      await this.sessionStore?.settleSessionInput?.({
        id: record.id,
        sessionID: this.sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to sweep admitted session inputs on resume", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.resume_sweep_failed",
      module: "core.runtime",
      status: "failed",
    });
  }

  // 账本清扫完再看投影：两者是不同事实源，账本管持久，投影管本次进程还能看到的残留。
  // 投影为空说明没有残留，直接返回 0，避免启动时刷出一串空事件。
  const projection = await this.rebuildProjection();
  const pendingInputs = projection.pendingSteerInputs;
  if (pendingInputs.length === 0) return 0;

  // 按 targetTurnId 分组，保证每个 turn 只发一条批量事件。
  // [契约] 分组顺序是投影顺序，事件按 turn 依次写入。
  // [资源] pendingByTurn 的构造是重启期一次性开销，数量与残留输入条数成正比。
  // 按 targetTurnId 分组：一条 TurnSteerDiscarded 只描述一个轮次，分组是事件契约的要求。
  const pendingByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const pendingInput of pendingInputs) {
    const group = pendingByTurn.get(pendingInput.targetTurnId) ?? [];
    group.push(pendingInput);
    pendingByTurn.set(pendingInput.targetTurnId, group);
  }

  for (const [targetTurnId, group] of pendingByTurn) {
    const pendingInputIds = group.map((item) => item.pendingInputId);
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds,
        reason: "session_resumed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
    this.logger?.debug("Turn steer discarded", {
      ...traceContextToLogContext(traceContext),
      discardedCount: group.length,
      event: "turn.steer.discarded",
      module: "core.runtime",
      pendingInputIds,
      reason: "session_resumed",
      status: "completed",
      targetTurnId,
    });
  }

  return pendingInputs.length;
}
