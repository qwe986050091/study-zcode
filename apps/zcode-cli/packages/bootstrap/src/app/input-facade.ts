/**
 * input-facade：宿主/UI 的输入入口面（send / steer / submit / 队列运维 / 历史 / 续跑）。
 * 定位：把 prompt 归一化、附件外化、自定义命令解析、用户执行边界准备与 runtime admission 串成一条路径；
 *   队列类方法只是 v4 queue 命令到 runtime pending-input API 的薄桥接。
 * 口径：sendInput 一律先 prepareUserExecutionBoundary 再问 admission；delivery 只表示意向，
 *   是否开轮/排队由 Core 在同一 session runtime 内决定，本层不读 activeTurn 做分叉。
 * 失败语义：输入历史写失败只 warn 并返回 null（历史不是事实源）；admission/prompt 失败原样抛；
 *   事件订阅在 started 时挂到 completion，queued 或异常时立即退订。
 * 副作用：附件外化到 artifact store、写 input history、可能触发 SessionStart Hook review。
 * 不变量：runtime / sessionId / traceContext 是唯一事实源，本文件不持有跨调用会话状态。
 */
// 职责：把 UI/宿主的输入意图（send / steer / submit / 队列运维）翻译为一次 runtime admission，不判定是否开轮。
//   本文件只做参数归一化、附件外化、历史旁路与事件订阅装配，不缓存跨调用的会话状态。
//   排队、串行化、turn 生命周期由 Core 在同一 session runtime 内裁决；本层改动只允许调整装配顺序。
// INV-01 先准备执行边界再走 admission；守住位置：sendInput 与 submitPrompt 的 try 块首行；改错故障：执行边界晚于首条消息落定，shell 与审批沿用旧选择
// INV-02 delivery 只表达意向，不读 activeTurn 做分叉；守住位置：sendInput 传给 admitPrompt 的入参；改错故障：UI 与 Core 对同一输入是否开轮判断不一致，出现双轮或丢输入
// INV-03 队列类成员只做 v4 命令到 pending-input 接口的桥接；守住位置：removeQueueItem 到 setFollowupMode 各成员；改错故障：同一队列出现两条写路径，顺序与投影错位
// INV-04 输入历史不是事实源，写失败只 warn 并返回 null；守住位置：recordAcceptedInputHistory 的 catch；改错故障：历史库抖动导致主输入被拒，用户消息发不出去
// INV-05 历史在 admission 之后才落，started 与 queued 记不同 kind；守住位置：sendInput 的 started 与 queued 分支；改错故障：被拒输入进入历史，↑ 重放发出从未执行的指令
// INV-06 附件先外化再进 runtime，历史只存 artifact 引用；守住位置：各 externalizePromptAttachments 调用点；改错故障：历史条目携带原始大对象，回放时内存与协议体膨胀
// INV-07 命令解析替换文本时必须回传 displayInput 为用户原文；守住位置：runPromptTurn 与 sendInput 的 displayInput 展开；改错故障：UI 回显解析后的长指令，用户看到自己没输入过的内容
// INV-08 事件订阅必须先于 boundary 建立；守住位置：continueActiveTarget 与 sendInput 的 subscribeEvents；改错故障：SessionStart Hook review 落在订阅窗口外，Dual ACK 拿不到 authority 而死锁
// INV-09 订阅生命周期绑定 completion，queued 或异常立即退订；守住位置：sendInput 的 started 分支、queued 分支与 catch；改错故障：已结束的会话仍持有监听器，事件错配到后续输入
// INV-10 traceContext 每次回落到构造注入的那一份，不在本层新建；守住位置：全部 runtime 调用的 traceContext 字段；改错故障：跨进程与队列任务无法归到同一 traceId，链路断点不可观测
// INV-11 门面不持有任何跨调用会话状态；守住位置：createInputFacade 闭包体；改错故障：多 session 复用同一门面时串台，A 会话输入写进 B 会话
// INV-12 cli-default 选择只影响本次执行绑定；守住位置：sendInput 与 enqueueDeferredInput 以及 steerTurn 的 prepareInput；改错故障：一次性选择被当成持久意图写回，后续输入被静默改写
// INV-13 取消信号原样透传，admission 前不得提前返回结果；守住位置：prepareRuntimePrompt 与 admitPrompt 的 abortSignal；改错故障：用户取消后仍排队一条输入，下一轮莫名开跑
// INV-14 队列项操作需要 reservationId 作为幂等护栏；守住位置：removeQueueItem 与 reserve、release 成员；改错故障：重试把同一项删两次或释放他人预留，队列出现空洞
// INV-15 编辑复用同一 pendingInputId 原地替换；守住位置：editQueueItem；改错故障：编辑被当成新增，队列出现重复项且顺序漂移
// INV-16 重排以 beforePendingInputId 为锚，null 表示队尾；守住位置：reorderQueueItem；改错故障：锚点失效时项被插到队首，自动 drain 顺序反转
// INV-17 清空队列要同时清理 active turn 内存项与 held 投影；守住位置：clearQueueItems；改错故障：只清一侧留下投影残留，UI 显示已删除的排队项
// INV-18 致命错误原样上抛，本层只负责退订与清理；守住位置：sendInput 与 submitPrompt 的 catch 与 finally；改错故障：错误被吞成返回值，UI 无提示且输入静默丢失
import type { AgentRuntime, TurnAttachment, TurnResult } from "@zcode/core";
import {
  SessionEventType,
  traceContextToLogContext,
  type InputHistoryEntry,
  type InputHistoryKind,
  type InputHistoryStorePort,
  type Logger,
  type SessionId,
  type ToolArtifactStorePort,
  type TraceContext,
} from "@zcode/contracts";
import {
  externalizePromptAttachments,
  materializeInputHistoryEntry,
  normalizePromptInput,
  projectInputHistoryAttachments,
} from "./prompt-input.js";
import type { PrepareUserExecutionBoundary, SubmitPromptOptions, ZCodeApp } from "./types.js";
import type { CliDefaultSelection } from "./cli-default-selection.js";

// [边界] 只挑出 ZCodeApp 的输入面成员，避免门面反向依赖整个 app 契约；漏列会在编译期暴露，不做运行时兜底。
// [权衡] 用 Pick 而非另立接口，是为了让 app 实现与门面视图共用同一份签名，改动时两侧被迫同步。
type InputFacade = Pick<
  ZCodeApp,
  | "continueActiveTarget"
  | "enqueueDeferredInput"
  | "recordInputHistory"
  | "editQueueItem"
  | "recallPreviousInputHistory"
  | "removeQueueItem"
  | "reserveQueueItem"
  | "markQueueItemPromoting"
  | "releaseQueueItemReservation"
  | "clearQueueItems"
  | "completeExternalQueueDrain"
  | "reorderQueueItem"
  | "setQueueAutoDrain"
  | "setFollowupMode"
  | "sendInput"
  | "steerTurn"
  | "submitPrompt"
>;

// [边界] 依赖全部经构造注入：runtime 与 sessionId 必填，artifactStore、inputHistoryStore、resolver 可选以支持精简宿主。
// [失败路径] prepareUserExecutionBoundary 是必填项，缺失时构造期即失败，而不是把边界检查推迟到首条输入。
interface CreateInputFacadeDeps {
  cliDefaultSelection?: CliDefaultSelection;
  artifactStore?: ToolArtifactStorePort;
  customCommandPromptResolver?: (
    text: string,
    options?: Pick<SubmitPromptOptions, "abortSignal" | "traceContext">,
  ) => Promise<string | undefined>;
  inputHistoryStore?: InputHistoryStorePort;
  logger: Logger;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  runtime: AgentRuntime;
  sessionId: SessionId;
  traceContext: TraceContext;
}

/**
 * 造输入门面。同步构造；所有成员都是 runtime 与本地 store 的薄适配，不缓存会话状态。
 * 输入：见 CreateInputFacadeDeps；artifactStore / inputHistoryStore / customCommandPromptResolver 均可选。
 * 输出：InputFacade（ZCodeApp 输入相关成员的子集）。
 * 失败语义：历史与附件类失败降级（null 或 warn）；唯一致命前置是 prepareUserExecutionBoundary 抛错——
 *   它必须先于任何 admission 完成，否则 shell selection 等执行边界会晚于首条消息落定。
 */
export function createInputFacade(deps: CreateInputFacadeDeps): InputFacade {
  // [顺序] 这层薄包装的唯一价值是固定调用点：边界准备在代码里只有一个可审计入口。
  // [并发] 每次输入各自等待一次，不共享 promise，防止前一次定下的执行边界被后一次输入复用。
  // [失败路径] 边界准备抛错即中止本次输入，历史与附件都不会落，保证失败输入零副作用。
  const preparePromptBoundary = async (options?: SubmitPromptOptions): Promise<void> => {
    await deps.prepareUserExecutionBoundary(options);
  };

  // 历史是旁路事实：写失败只 warn 并返回 null，绝不能让主输入路径跟着失败。
  // [资源] 只写入调用方给定的 kind 与 trace，不做去重；重复提交由输入 id 在上层治理。
  // [失败路径] 捕获后统一降级：warn 带 event 与 status，返回 null 让主路径继续，调用方不得据此判定输入失败。
  // [权衡] 日志只带结构化字段，不写入完整用户文本，避免高敏内容进入生产日志。
  const recordAcceptedInputHistory = async (
    text: string,
    kind: InputHistoryKind,
    recordTraceContext: TraceContext,
    attachments?: TurnAttachment[],
  ): Promise<InputHistoryEntry | null> => {
    if (!deps.inputHistoryStore) return null;
    try {
      return await deps.inputHistoryStore.recordInputHistory({
        attachments: projectInputHistoryAttachments(attachments),
        kind,
        projectID: deps.runtime.getProjectId(),
        sessionID: deps.sessionId,
        text,
      });
    } catch (error) {
      deps.logger.warn("Input history write failed", {
        ...traceContextToLogContext(recordTraceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "input_history.record.failed",
        kind,
        module: "bootstrap",
        projectId: deps.runtime.getProjectId(),
        status: "failed",
      });
      return null;
    }
  };

  // [权衡] skip 由调用方推进，本层不维护游标：历史游标属于 TUI 交互态，不进入门面状态。
  // [资源] 附件引用在此处才实体化，历史库只存轻量引用，避免 ↑ 重放时反序列化大对象。
  const recallPreviousInputHistory = async (skip?: number): Promise<InputHistoryEntry | null> => {
    if (!deps.inputHistoryStore) return null;
    const entry = await deps.inputHistoryStore.recallPreviousInputHistory({
      projectID: deps.runtime.getProjectId(),
      skip,
    });
    return await materializeInputHistoryEntry(entry, deps.artifactStore);
  };

  // 直通执行路径（submitPrompt 专用）：附件外化 → 历史 → 命令解析 → executeTurn。
  // 解析出替换文本时仍带 displayInput=用户原文，避免 UI 回显解析后的长指令。
  // [边界] 直通路径不经 admission：submitPrompt 属于已决定开轮的入口，排队裁决由调用方前置完成。
  // [顺序] 附件外化先于历史写入，历史需要 artifact 引用；外化失败直接上抛，历史失败只降级。
  // [权衡] resolvedCommandPrompt 只在 runtime 侧生效，displayInput 仍回传用户原文，二者不可合并。
  const runPromptTurn = async (
    promptInput: ReturnType<typeof normalizePromptInput>,
    options?: SubmitPromptOptions,
  ): Promise<TurnResult> => {
    const storedAttachments = await externalizePromptAttachments(promptInput.attachments, {
      artifactStore: deps.artifactStore,
      sessionId: deps.sessionId,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    await recordAcceptedInputHistory(
      promptInput.text,
      "prompt",
      options?.traceContext ?? deps.traceContext,
      storedAttachments,
    );
    const resolvedCommandPrompt = await deps.customCommandPromptResolver?.(promptInput.text, {
      abortSignal: options?.abortSignal,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    const runtimePromptText = resolvedCommandPrompt ?? promptInput.text;
    const turnAttribution = options?.automationId
      ? { automationId: options.automationId }
      : options?.offPeakTaskId
        ? {
            offPeakTaskId: options.offPeakTaskId,
            ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
          }
        : {};
    return await deps.runtime.executeTurn(runtimePromptText, storedAttachments, {
      abortSignal: options?.abortSignal,
      browserAmbientContext: options?.browserAmbientContext,
      continueActiveTargetAfterTurn: true,
      ...(resolvedCommandPrompt !== undefined ? { displayInput: promptInput.text } : {}),
      inputId: options?.inputId,
      ...turnAttribution,
      intent: options?.intent,
      sharedContextRefs: options?.sharedContextRefs,
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext ?? deps.traceContext,
      modelExecution: options?.modelExecution,
    });
  };

  // 只准备不提交：admission 需要先拿到可派发的文本与已外化的附件，二者在这里定型。
  // [边界] 这里只定型文本与附件，不写历史也不触发 admission：被 admission 拒绝的输入不应留下历史痕迹。
  // [并发] 与 runPromptTurn 分开实现，是因为排队路径要先拿到可派发内容再决定是否开轮。
  // [权衡] 附件仅在存在时才展开字段，避免把 undefined 传下去被下游当成显式清空。
  const prepareRuntimePrompt = async (
    promptInput: ReturnType<typeof normalizePromptInput>,
    options?: SubmitPromptOptions,
  ): Promise<{ input: string; storedAttachments?: TurnAttachment[] }> => {
    const storedAttachments = await externalizePromptAttachments(promptInput.attachments, {
      artifactStore: deps.artifactStore,
      sessionId: deps.sessionId,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    const resolvedCommandPrompt = await deps.customCommandPromptResolver?.(promptInput.text, {
      abortSignal: options?.abortSignal,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    return {
      input: resolvedCommandPrompt ?? promptInput.text,
      ...(storedAttachments ? { storedAttachments } : {}),
    };
  };

  return {
    // [顺序] cold resume 会在 boundary 内触发 SessionStart Hook review，订阅必须先于 boundary 建立。
    // [资源] 退订放在 finally，续跑循环抛错或取消时都不遗留监听器。
    // [边界] verifyBeforeFirstContinue 固定为 false：续跑前的校验由 runtime 内部判定，门面不参与。
    continueActiveTarget: async (options) => {
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        // cold resume 会在 prepare boundary 内触发 SessionStart Hook review。必须先订阅，
        // 否则 ReviewRequested 发生在订阅窗口之前，Dual ACK 永远拿不到释放 authority。
        await preparePromptBoundary(options);
        return await deps.runtime.continueActiveTargetLoop({
          abortSignal: options?.abortSignal,
          inputId: options?.inputId,
          intent: options?.intent,
          traceContext: options?.traceContext ?? deps.traceContext,
          trigger: "manual",
          verifyBeforeFirstContinue: false,
        });
      } finally {
        unsubscribe?.();
      }
    },
    // [边界] 只做外化与写入，不经 admission：调用方已确认该输入无需开轮，本层不得擅自触发执行。
    // [权衡] kind 默认 slash_command，调用方按语义覆盖，避免同一字面量散落在各调用点。
    recordInputHistory: async (input, kind = "slash_command") => {
      const promptInput = normalizePromptInput(input);
      const attachments = await externalizePromptAttachments(promptInput.attachments, {
        artifactStore: deps.artifactStore,
        sessionId: deps.sessionId,
        traceContext: deps.traceContext,
      });
      return recordAcceptedInputHistory(promptInput.text, kind, deps.traceContext, attachments);
    },
    recallPreviousInputHistory,
    // [并发] 本层不持锁也不自建队列：同一 session 的串行化由 runtime admission 内部完成，重复加锁会与 Core 争序。
    // [顺序] 订阅、boundary、cli-default 选择、定型、admission 顺序固定；调换会让边界用到旧选择。
    // [失败路径] admission 抛错时先退订再原抛，异常输入不写历史，避免 ↑ 重放一条从未被接受的指令。
    // [边界] 返回值原样透传 started 与 queued 两类结果，本层不改写 kind，由 UI 决定渲染方式。
    sendInput: async (input, options) => {
      const promptInput = normalizePromptInput(input);
      const delivery = options?.delivery ?? "auto";
      const unsubscribe =
        options?.onEvent || options?.onTurnStartedObserved
          ? deps.runtime.subscribeEvents({
              onSessionEvent: async (event) => {
                await options?.onEvent?.(event);
                if (
                  event.type === SessionEventType.TurnStarted &&
                  (event.payload as { inputId?: unknown }).inputId === options?.inputId
                ) {
                  // TurnStarted 只用于后续关联；admission ACK 不等待 projection commit。
                  options?.onTurnStartedObserved?.(event);
                }
              },
            })
          : undefined;
      try {
        // resume review 属于本次 prompt 生命周期，订阅覆盖 prepare boundary；Core admission
        // 在同一个 session runtime 内完成 start/queue，不在这里读取 activeTurn 做分叉。
        await preparePromptBoundary(options);
        // 这里注入 cli-default 的最新选择：只影响本次输入的执行绑定；"保存意图"仍由 session-facade 维护。
        options = deps.cliDefaultSelection?.prepareInput(options) ?? options;
        const prepared = await prepareRuntimePrompt(promptInput, options);
        const result = await deps.runtime.admitPrompt(prepared.input, prepared.storedAttachments, {
          ...options,
          delivery,
          traceContext: options?.traceContext ?? deps.traceContext,
          ...(prepared.input !== promptInput.text ? { displayInput: promptInput.text } : {}),
        });
        // [资源] 只有 started 才把退订挂到 completion：排队态没有 turn 生命周期可挂，必须立即退订。
        // [顺序] 历史在 admission 成功之后写，保证历史里不出现被拒绝的输入。
        // [权衡] onTurnStartedObserved 不等待，ACK 不依赖 projection 提交，避免投影慢时阻塞开轮。
        if (result.kind === "started") {
          await recordAcceptedInputHistory(
            promptInput.text,
            "prompt",
            options?.traceContext ?? deps.traceContext,
            prepared.storedAttachments,
          );
          if (unsubscribe) void result.completion.then(unsubscribe, unsubscribe);
          return {
            completion: result.completion,
            kind: "started_turn",
            turnId: result.turnId,
          };
        }
        unsubscribe?.();
        // [失败路径] 非 started 一律先退订：排队输入不会在本轮产生事件，留着监听只会错配到后续 turn。
        // [事务] 排队态仍补一条 kind 为 steered_input 的历史，与真实开轮区分，便于回放时核对来源。
        if (result.kind === "queued") {
          await recordAcceptedInputHistory(
            promptInput.text,
            "steered_input",
            options?.traceContext ?? deps.traceContext,
            prepared.storedAttachments,
          );
        }
        return result;
      } catch (error) {
        unsubscribe?.();
        throw error;
      }
    },
    // [边界] 这是 UI 排队的旁路入口，inputPresentation 固定 user_steer，不经 boundary 与 admission。
    // [权衡] 只展开调用方给出的字段，undefined 不下传，防止下游把缺省当成显式覆盖。
    // [失败路径] 仅 queued 才补历史；runtime 拒绝时不提示，由返回值让调用方决定如何呈现。
    enqueueDeferredInput: async (input, options) => {
      options = deps.cliDefaultSelection?.prepareInput(options) ?? options;
      const result = await deps.runtime.enqueueDeferredInput({
        input,
        inputPresentation: "user_steer",
        ...(options?.commandKind ? { commandKind: options.commandKind } : {}),
        ...(options?.delivery ? { delivery: options.delivery } : {}),
        ...(options?.intent ? { intent: options.intent } : {}),
        ...(options?.attachments ? { attachments: options.attachments } : {}),
        ...(options?.toolDisallowlist ? { toolDisallowlist: options.toolDisallowlist } : {}),
        ...(options?.intent?.queueItemId ? { pendingInputId: options.intent.queueItemId } : {}),
        ...(options?.inputId ? { inputId: options.inputId } : {}),
        ...(options?.queryId ? { queryId: options.queryId } : {}),
        traceContext: options?.traceContext ?? deps.traceContext,
      });
      if (result.kind === "queued") {
        await recordAcceptedInputHistory(
          input,
          "steered_input",
          options?.traceContext ?? deps.traceContext,
        );
      }
      return result;
    },
    // [并发] expectedTurnId 用于拒绝过期导航：turn 已结束时不把输入注入新轮，防止串到错误上下文。
    // [资源] 订阅覆盖整个 steer 调用并在 finally 退订，确保取消与异常路径不泄漏监听器。
    // [边界] 与 sendInput 的差别是不做 boundary 与 admission，steer 直接注入进行中的 turn。
    steerTurn: async (input, options) => {
      options = deps.cliDefaultSelection?.prepareInput(options) ?? options;
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        const result = await deps.runtime.steerTurn({
          inputPresentation: "user_steer",
          commandKind: options?.commandKind,
          inputId: options?.inputId,
          queryId: options?.queryId,
          expectedTurnId: options?.expectedTurnId,
          delivery: options?.delivery,
          intent: options?.intent,
          attachments: options?.attachments,
          pendingInputId: options?.intent?.queueItemId,
          input,
          toolDisallowlist: options?.toolDisallowlist,
          traceContext: options?.traceContext ?? deps.traceContext,
        });
        if (result.kind === "queued") {
          await recordAcceptedInputHistory(
            input,
            "steered_input",
            options?.traceContext ?? deps.traceContext,
          );
        }
        return result;
      } finally {
        unsubscribe?.();
      }
    },
    // [事务] reason 缺省 user_removed，用于区分系统清理与用户主动删除，便于审计队列流失原因。
    // [并发] reservationId 透传做幂等护栏：删除已被预留的项时由 runtime 决定拒绝还是接管。
    removeQueueItem: async (pendingInputId, options) => {
      // v4 queue 单项删除：把 v4 命令桥到 runtime 单项 pending-input 移除。
      return deps.runtime.removePendingInputById({
        pendingInputId,
        reason: options?.reason ?? "user_removed",
        reservationId: options?.reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    // [并发] 预留把排队项锁定给某次 drain，未持 reservationId 的删除与提升应由 runtime 拒绝。
    // [边界] 本层不缓存预留状态，reservationId 由调用方生成并在整个 drain 周期内复用。
    reserveQueueItem: async (pendingInputId, reservationId, options) =>
      deps.runtime.reservePendingInputById({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    // [事务] promoting 是预留到执行的中间态，此态下禁止清空，否则投影与内存项会分叉。
    // [失败路径] 状态流转失败原样上抛，不做补偿：drain 由上层重试，本层没有会话状态可回滚。
    markQueueItemPromoting: async (pendingInputId, reservationId, options) =>
      deps.runtime.markPendingInputPromoting({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    // [资源] 释放必须在 drain 结束或放弃时调用，否则排队项长期处于预留态，无法再次被提升。
    // [事务] 释放只解绑不删除，项仍在队列中等待下一次 drain；删除是另一个显式动作。
    releaseQueueItemReservation: async (pendingInputId, reservationId, options) =>
      deps.runtime.releasePendingInputReservation({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    // [事务] 原地替换文本并保留同一个 pendingInputId，队列位置不因编辑而漂移。
    // [边界] 只改文本，不改 delivery 与 intent；要改语义应重新排队，避免一次操作两种副作用。
    editQueueItem: async (pendingInputId, newText, options) => {
      // v4 queue 单项编辑：替换排队输入文本（reducer 同 id 原地更新，保位）。
      return deps.runtime.editPendingInputById({
        pendingInputId,
        newText,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    // [顺序] beforePendingInputId 为 null 表示移到队尾，非 null 表示插到该锚点之前。
    // [失败路径] 锚点不在队列中时由 runtime 判定丢弃或回退，本层不做猜测性补齐。
    reorderQueueItem: async (pendingInputId, beforePendingInputId, options) => {
      // v4 queue 重排：移动排队项到锚点前（null=队尾）。
      return deps.runtime.reorderPendingInput({
        pendingInputId,
        beforePendingInputId,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    // [事务] 一次清空 active turn 内存项与 held 投影两侧，只清一侧会让 UI 残留已删除的排队项。
    // [边界] 不做逐项 release：清空是会话级重置，预留随项一起失效，由 runtime 统一收口。
    clearQueueItems: async (options) => {
      // v4 clearQueueAndSend：清空 active turn 内存项 + held 投影残留。
      return deps.runtime.clearAllPendingInputs(options?.traceContext ?? deps.traceContext);
    },
    // [并发] autoDrain 是会话级授权位，翻转后只影响后续 drain 决策，不追溯已在途的排队项。
    // [边界] 等到 runtime 落定才返回，保证 UI 开关与运行时状态不出现假同步。
    setQueueAutoDrain: async (autoDrain, options) => {
      // v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级配置事件）。
      await deps.runtime.setQueueAutoDrain({
        autoDrain,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    // [顺序] 外部 drain 结束需显式通知，runtime 据此解除外部持有标记并恢复自动 drain。
    // [边界] 同步调用且不带 trace：它只翻转完成标记，不产生可归属的输入事件。
    completeExternalQueueDrain: () => {
      deps.runtime.completeExternalQueueDrain();
    },
    // [权衡] followup 路由在 queue 与 guide 之间切换，只改后续输入的去向，不迁移已排队项。
    // [边界] 落定后由 session 侧广播，门面不维护模式副本，避免出现第二份事实。
    setFollowupMode: async (mode, options) => {
      // v4 setFollowupMode：翻转 followup 路由模式（queue/guide）。
      await deps.runtime.setFollowupMode({
        mode,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    // [边界] 这是不排队、不要 admission 的直通入口，调用方必须已决定本轮直接开轮。
    // [资源] 订阅在 finally 退订，直通执行抛错或取消都不遗留监听器。
    // [顺序] 先 boundary 再 cli-default 选择：选择可能依赖刚落定的执行边界。
    submitPrompt: async (prompt, options) => {
      const promptInput = normalizePromptInput(prompt);
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        await preparePromptBoundary(options);
        options = deps.cliDefaultSelection?.prepareInput(options) ?? options;
        return await runPromptTurn(promptInput, options);
      } finally {
        unsubscribe?.();
      }
    },
  };
}
