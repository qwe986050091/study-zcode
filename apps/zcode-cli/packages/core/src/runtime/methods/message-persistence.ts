/**
 * ============================================================================
 * runtime/methods/message-persistence.ts —— 会话消息/部件的持久化原语
 * ============================================================================
 *
 * 【分层】
 *   message  一次落库,记录 role/时间/模型/语义/渲染锚点等"消息级事实";
 *   part     多次落库,承载 text/reasoning/tool/file 等内容,流式期间会反复更新。
 * 两者分开是为了让流式内容可以增量写,而消息级元数据只写一次(开始/结束各一次)。
 *
 * 【三个"最新指针"】
 *   latestConversationMessageId / latestAssistantMessageId / latestAssistantTurnId
 *   是"编辑重试 / 分叉 / compact 边界"的锚点。它们必须在落库之前更新——
 *   即使 store 缺席(纯内存模式)也要更新,否则内存模式下的 fork/retry 找不到锚点。
 *
 * 【冷恢复靠什么】
 *   metadata 里刻意存了一批"只对恢复有用"的字段(turnSteerDelivery /
 *   inputPresentation / executionKind / epilogueStart / conversationInputIntent 等),
 *   它们不参与 live 执行,但冷恢复必须靠它们还原"这条 user 消息是怎么来的"。
 * ============================================================================
 */
import type { RuntimeInputPresentation } from "@zcode/contracts";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import { SessionEventType, createPartId, traceContextToLogContext } from "../deps.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import type {
  EnvInfo,
  MessageId,
  MessagePart,
  MessageVisibility,
  Model,
  SessionId,
  SessionProjection,
  SessionStorePort,
  TraceContext,
  SyntheticUserMessageSource,
  TurnInputIntentMetadata,
  TurnExecutionKind,
} from "../deps.js";
import { emptyTokenUsageInfo, toTokenUsageInfo } from "../helpers/index.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildSyntheticUserNoticeMessageMetadata,
  buildSyntheticUserNoticePartMetadata,
  buildSyntheticUserNoticeSemantics,
} from "./synthetic-notice-metadata.js";
import { buildPersistedConversationInputIntent } from "./input-intent-persistence.js";
import { buildProjectionAnchor, mapSyntheticSourceToAnchorOrigin } from "./projection-anchor.js";

export async function persistUserPrompt(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  input: string,
  attachments: ResolvedTurnAttachment[] | undefined,
  traceContext: TraceContext,
  options?: {
    /**
     * drain 注入的输入把投递语义落到持久事实（metadata.turnSteerDelivery），
     * 冷恢复据此还原「queue=独立轮 / guide=内联当前轮」的切分，与 live 结构一致。
     */
    steerDelivery?: "guide" | "queue";
    inputPresentation?: RuntimeInputPresentation;
    /**
     * （promotion 原子性）：给定账本 id 且 store 支持时，账本置 promoted
     * 与 message/parts 持久化走同一事务——杜绝「queue 已消费但 transcript 无
     * user message」的孤儿窗口（旧 drain 跨 store 无事务）。
     */
    sessionInputId?: string;
    /** V4 command 幂等锚点；必须来自 CLI admission，不能在 drain 时换新 id。 */
    sourceCommandId?: string;
    clientId?: string;
    intent?: TurnInputIntentMetadata;
    /** 冷恢复所需的执行语义；不能只存在于 live TurnStarted。 */
    executionKind?: TurnExecutionKind;
    /** 引擎附加文本的起点；同样为冷恢复而存。 */
    epilogueStart?: number;
  },
): Promise<void> {
  // 指针必须先更新:即使后面 store 落库失败/不存在,内存态的 fork/retry 仍需要
  // 一个"最新会话消息"锚点。store 缺席(纯内存模式)时随后直接 return。
  this.latestConversationMessageId = messageID;
  if (!this.sessionStore) return;

  // created 只取一次并同时用于 message 与首个 text part：两者时间窗必须一致，
  // 否则冷恢复按时间排序时 part 可能落到 message 之前，投影出现"幽灵内容"。
  const created = Date.now();
  // tools 是"这条消息发生时可见的工具集合"的事实快照:
  // 冷恢复/审计需要知道当时的工具面,不能后来用 registry 现状反推。
  const tools = Object.fromEntries(this.getTools().map((tool) => [tool.name, true]));
  const conversationInputIntent = buildPersistedConversationInputIntent(
    input,
    options?.intent,
    "drained",
  );
  const message: Parameters<SessionStorePort["saveMessage"]>[0] = {
    id: messageID,
    sessionID: this.sessionId,
    role: "user",
    time: {
      created,
    },
    agent: this.config.agentName ?? "zcode-agent",
    modelSelection: this.getSessionModelSelection(),
    contextSnapshot: buildPersistedContextSnapshot(this.config.envInfo),
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
    // anchor 由 traceContext + sourceCommandId 生成：V4 投影靠 commandId 把 user row
    // 与命令幂等关联；这里若换新 id，重试/分叉会指向另一条命令事实。
    anchor: buildProjectionAnchor(
      traceContext,
      "realUser",
      options?.intent?.sourceCommandId ?? options?.sourceCommandId,
    ),
    system: this.config.systemPrompt,
    tools,
    ...(options?.inputPresentation ||
    options?.steerDelivery ||
    options?.clientId ||
    options?.intent ||
    options?.executionKind ||
    options?.epilogueStart !== undefined
      ? {
          // 仅在任一字段存在时才写 metadata:纯文本 user 消息不需要空对象,
          // 避免历史里出现大量 `metadata: {}` 的噪声。
          // 每个字段都有明确的恢复用途:
          //   turnSteerDelivery:queue(独立轮) vs guide(内联当前轮);
          //   inputPresentation:V4 投影如何渲染这条输入;
          //   executionKind:恢复后要不要按 compact/普通 turn 重放;
          //   epilogueStart:引擎附加文本的起点(拆分用户正文/系统尾巴);
          //   conversationInputIntent/inputClientId:命令幂等与去重;
          //   highspeed:该轮是否走加速 provider。
          metadata: {
            ...(options?.steerDelivery ? { turnSteerDelivery: options.steerDelivery } : {}),
            ...(options?.inputPresentation ? { inputPresentation: options.inputPresentation } : {}),
            ...(options?.intent ? { inputIntent: options.intent } : {}),
            ...(conversationInputIntent ? { conversationInputIntent } : {}),
            ...((options?.intent?.clientId ?? options?.clientId)
              ? { inputClientId: options?.intent?.clientId ?? options?.clientId }
              : {}),
            ...(options?.executionKind ? { executionKind: options.executionKind } : {}),
            ...(options?.intent?.highspeed ? { highspeed: options.intent.highspeed } : {}),
            ...(options?.epilogueStart === undefined
              ? {}
              : { epilogueStart: options.epilogueStart }),
          },
        }
      : {}),
  };
  const parts: MessagePart[] = [
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID,
      type: "text",
      // 引用块在**落库时**就展开成最终文本,而不是留到渲染时再拼:
      // 模型看到的就是展开后的版本,持久化必须与 provider 视角逐字一致,
      // 否则恢复后重新请求会出现"用户说过的话变了"。
      text: withConversationQuotes(
        input,
        options?.intent?.conversationQuotes,
        options?.intent?.botGroupSource,
      ),
      time: {
        start: created,
        end: created,
      },
    },
    ...(attachments ?? []).map(
      (attachment): MessagePart => ({
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "file",
        mime: attachment.mime,
        filename: attachment.filename,
        url: attachment.url,
        source: attachment.source,
        metadata: attachment.metadata,
      }),
    ),
  ];

  if (options?.sessionInputId && this.sessionStore.promoteSessionInput) {
    // 有账本 id 且 store 支持时,走事务化 promotion:账本置 promoted 与
    // message/parts 写入是一个原子动作,杜绝"queue 已消费但 transcript 无 user 消息"。
    await this.sessionStore.promoteSessionInput({
      id: options.sessionInputId,
      sessionID: this.sessionId,
      message,
      parts,
    });
    this.logger?.debug("Session input promoted", {
      ...traceContextToLogContext(traceContext),
      event: "session_input.promoted",
      messageId: messageID,
      module: "core.runtime",
      sessionInputId: options.sessionInputId,
      status: "completed",
    });
    const sourceCommandId =
      options.intent?.sourceCommandId ?? options.sourceCommandId ?? options.sessionInputId;
    // promotion 事务提交后再发事件：gateway 只能在此边界解除 live-input pin。
    // 若在 queue remove/TurnStarted 就解除，LRU churn 会在 transcript 尚未落盘时把
    // commands/query 退化成 unknown，重复执行同一输入。
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionInputPromoted,
        {
          pendingInputId: options.sessionInputId,
          sourceCommandId,
          messageId: messageID,
        },
        traceContext,
      ),
      traceContext,
    );
    return;
  }

  // 无事务能力的 store:只能顺序写"消息 → 各 part"。
  // 先写消息再写 part:投影按消息聚合,消息先存在时即使中途崩溃,
  // 恢复看到的是"缺 part 的消息",比"有 part 无消息"更容易容错。
  await this.persistMessage(message, traceContext);
  for (const part of parts) {
    await this.persistPart(part, traceContext);
  }
}

export async function persistSyntheticUserNotice(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "rewind",
    text,
    traceContext,
  });
}

export async function persistSyntheticUserNoticeForSession(
  this: AgentRuntimeInternal,
  options: {
    messageID: MessageId;
    sessionId: SessionId;
    source: SyntheticUserMessageSource;
    text: string;
    traceContext: TraceContext;
    /** 额外结构化 metadata，会与 `{ source }` 合并写到 part.metadata 上，供 UI 识别消息类型。 */
    metadata?: Record<string, unknown>;
    visibility?: MessageVisibility;
  },
): Promise<void> {
  // 只有写给本会话才推进指针：fork child 的 notice 由子会话自己的 runtime 持有，
  // 若在这里改父 runtime 的 latest，父会话的 rewind/fork 锚点会被子会话消息污染。
  if (options.sessionId === this.sessionId) {
    this.latestConversationMessageId = options.messageID;
  }
  if (!this.sessionStore) return;

  const created = Date.now();
  // 默认 model-only:rewind 提示等"系统对模型说的话"不该在 transcript 里
  // 伪装成用户输入;需要用户可见时必须由调用方显式传 visibility。
  const visibility = options.visibility ?? "model-only";
  // message/part 两处 metadata 都要写:投影可能只读到其中一处
  // (消息级用于列表渲染,part 级用于正文渲染),缺一处 UI 就识别不出类型。
  const messageMetadata = buildSyntheticUserNoticeMessageMetadata(
    options.source,
    visibility,
    options.metadata,
  );
  const partMetadata = buildSyntheticUserNoticePartMetadata(
    options.source,
    visibility,
    options.metadata,
  );
  await this.persistMessage(
    {
      id: options.messageID,
      sessionID: options.sessionId,
      role: "user",
      time: {
        created,
      },
      agent: this.config.agentName ?? "zcode-agent",
      metadata: messageMetadata,
      modelSelection: this.getSessionModelSelection(),
      semantics: buildSyntheticUserNoticeSemantics(options.source, visibility),
      anchor: buildProjectionAnchor(
        options.traceContext,
        mapSyntheticSourceToAnchorOrigin(options.source),
      ),
      source: options.source,
      system: this.config.systemPrompt,
      synthetic: true,
      tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      visibility,
    },
    options.traceContext,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: options.sessionId,
      messageID: options.messageID,
      type: "text",
      text: options.text,
      synthetic: true,
      time: {
        start: created,
        end: created,
      },
      metadata: partMetadata,
    },
    options.traceContext,
  );
}

/**
 * 持久化一条 assistant 消息(消息级元数据 + 语义标记)。
 *
 * 副作用:更新 runtime 的三个"最新指针"(latestConversationMessageId /
 * latestAssistantMessageId / latestAssistantTurnId)。这些指针是后续
 * "编辑重试/分叉/compact 边界"的锚点,所以必须在落库前先更新。
 *
 * model 必须由调用方显式传入模型请求路径的真实模型:Session Selection 可能在
 * 请求期间被切换,不能用它反推本条响应属于哪个模型。
 * 无 sessionStore(纯内存模式)时只更新指针,不落库。
 */
export async function persistAssistantMessage(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  parentID: MessageId,
  created: number,
  update:
    | {
        completed?: number;
        error?: { name: string; data?: Record<string, unknown> };
        finish?: string;
        tokens?: ReturnType<typeof toTokenUsageInfo>;
      }
    | undefined,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  this.latestConversationMessageId = messageID;
  this.latestAssistantMessageId = messageID;
  // turnId 缺失（synthetic/fallback 路径）时保留旧值：写空会把上一轮锚点抹掉，
  // 冷恢复与 target 续跑就找不到"最后完成的 assistant 属于哪个 turn"。
  if (traceContext.turnId) {
    this.latestAssistantTurnId = traceContext.turnId;
  }
  if (!this.sessionStore) return;
  const selection = this.getSessionModelSelection();
  const providerId =
    model?.providerId ?? (selection && createModelProviderId(selection.providerId));
  const modelId = model?.modelId ?? (selection && createModelId(selection.modelId));

  await this.persistMessage(
    {
      id: messageID,
      sessionID: this.sessionId,
      role: "assistant",
      time: {
        created,
        completed: update?.completed,
      },
      error: update?.error,
      // parentID 指向触发本次响应的 user 消息:编辑重试/分叉按这条链回溯,
      // 缺失会让 assistant 变成"无父消息",无法定位要重放的输入。
      parentID,
      // 默认模型可能在请求进行中切换；模型请求路径必须显式传入生成这条
      // 消息的模型。默认值只保留给不经过模型结果的既有 synthetic/fallback 路径。
      modelId,
      providerId,
      mode: this.config.mode ?? "build",
      planEnabled: this.getPlanEnabled(),
      agent: this.config.agentName ?? "zcode-agent",
      path: {
        cwd: this.workingDirectory,
        // cwd 可随 Bash cd 变化，root 必须保留会话初始工作区身份。
        root: this.workspaceRoot,
      },
      cost: 0,
      tokens: update?.tokens ?? emptyTokenUsageInfo(),
      finish: update?.finish,
      semantics: {
        origin: "agent_runtime",
        kind: "assistant_response",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: buildProjectionAnchor(traceContext),
    },
    traceContext,
  );
}

export async function persistMessage(
  this: AgentRuntimeInternal,
  input: Parameters<SessionStorePort["saveMessage"]>[0],
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  // 纯内存模式的既定降级：不落库也不报假成功；失败必须向上抛，
  // 由调用方决定这轮 turn 是否还能继续（不变量 1/7 都依赖 durable 事实）。
  if (!this.sessionStore) return;
  await this.sessionStore.saveMessage(input, copyFrom);
  this.logger?.debug("Session message persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.message.persisted",
    messageId: input.id,
    module: "core.runtime",
    role: input.role,
    status: "completed",
  });
}

/**
 * 持久化一条消息 part(文本/推理/工具/step-finish)。
 * 与消息本体分开落库:流式期间 part 会多次更新,message 只在开始/结束时更新一次。
 * copyFrom 用于"从已有 part 复制",避免重复序列化大内容。
 */
export async function persistPart(
  this: AgentRuntimeInternal,
  input: MessagePart,
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  // part 是流式期间的反复写入点：这里不做去重/合并，调用方必须保证同一 partID
  // 覆盖写（而不是追加），否则 tool/text 会出现重复段。
  if (!this.sessionStore) return;
  await this.sessionStore.savePart(input, copyFrom);
  this.logger?.debug("Session part persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.part.persisted",
    messageId: input.messageID,
    module: "core.runtime",
    partId: input.id,
    partType: input.type,
    status: "completed",
  });
}

function buildPersistedContextSnapshot(envInfo: EnvInfo | undefined):
  | {
      envInfo: EnvInfo;
    }
  | undefined {
  if (!envInfo) {
    return undefined;
  }

  return { envInfo: { ...envInfo } };
}

export async function rebuildProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  // 投影是**事件溯源**的:从 eventStore 重放全部事件,而不是从 message 表直接拼装。
  // 因此任何影响 UI 的事实都必须先落成事件,只写 message/part 不会出现在投影里。
  const events = await this.eventStore.getEvents(this.sessionId);
  return this.eventReducer.reduce(events);
}
