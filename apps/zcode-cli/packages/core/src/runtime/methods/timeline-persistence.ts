/**
 * ============================================================================
 * runtime/methods/timeline-persistence.ts —— 时间线 part(模型切换等分隔事件)
 * ============================================================================
 *
 * timeline 是一种"系统消息":对用户可见(作为 transcript 里的分隔卡),
 * 但不进入 provider 请求(providerVisibility=hidden)。
 * 它复用 assistant message + timeline part 的两层结构,这样投影、分页、
 * 编辑锚点等既有机制不需要为它单开一套。
 *
 * 【model_change 的合并语义】
 *   一次 turn 内模型可能被多次切换(降档/恢复/用户切换)。分隔卡表达的是
 *   "用户看到的模型从 A 变成 B",因此:
 *   - 同一 turn 内连续切换会合并成一条,fromModel 保留最早的值;
 *   - 若最终切回最初的模型(A→B→A),pending 直接被取消,不产生分隔卡。
 * ============================================================================
 */
import { createModelId, createModelProviderId } from "@zcode/contracts";
import { createMessageId, createPartId } from "../deps.js";
import type {
  MessageId,
  ModelSelection,
  PartId,
  SessionId,
  TimelinePart,
  TimelinePartDraft,
  TraceContext,
} from "../deps.js";
import { emptyTokenUsageInfo } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function recordPendingModelChange(
  this: AgentRuntimeInternal,
  input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  },
): void {
  const existing = this.pendingModelChangeTimeline;
  // 合并:from 保留最早一次切换的起点,to 总是最新目标。
  // requestId/createdAt 也沿用第一次的,保证最终只落一条消息/part。
  const fromModel = existing?.fromModel ?? input.fromModel;
  const fromModelLabel = existing?.fromModelLabel ?? input.fromModelLabel;
  if (fromModel && isSameModelSelection(fromModel, input.toModel)) {
    // A→B→A:用户视角没有发生模型变化,取消 pending 即可,不产生分隔卡。
    this.pendingModelChangeTimeline = undefined;
    return;
  }
  this.pendingModelChangeTimeline = {
    createdAt: existing?.createdAt ?? Date.now(),
    fromModel,
    fromModelLabel,
    requestId: existing?.requestId ?? String(createPartId()),
    toModel: input.toModel,
    toModelLabel: input.toModelLabel,
  };
}

export async function persistPendingModelChangeTimeline(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const pending = this.pendingModelChangeTimeline;
  if (!pending) return;
  // 先清空 pending 再落库:分隔卡只应该出现一次,即使写入失败也不能在下一轮重复尝试,
  // 否则会出现两条一模一样的"模型已切换"卡片。
  this.pendingModelChangeTimeline = undefined;

  const created = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: this.sessionId,
    // 消息/part id 都从 requestId 派生:同一 pending 重放时 id 稳定,
    // 便于幂等写入与排障关联。
    messageID: createMessageId(`${pending.requestId}_message`),
    partID: createPartId(`${pending.requestId}_timeline`),
    // parent 取 latest 会话消息：分隔卡要挂在当前时间线尾部；
    // latest 尚未初始化时 persistAssistantTimelinePartForSession 会回落自身 id，避免孤儿消息。
    parentID: this.latestConversationMessageId,
    created,
    completed: created,
    finish: "completed",
    timeline: {
      timelineType: "model_change",
      display: "separator",
      status: "completed",
      anchorMessageId: this.latestConversationMessageId,
      fromModel: pending.fromModel
        ? {
            providerId: pending.fromModel.providerId,
            modelId: pending.fromModel.modelId,
            ...(pending.fromModel.options ? { options: pending.fromModel.options } : {}),
            label: pending.fromModelLabel ?? formatModelSelectionLabel(pending.fromModel),
          }
        : undefined,
      toModel: {
        providerId: pending.toModel.providerId,
        modelId: pending.toModel.modelId,
        ...(pending.toModel.options ? { options: pending.toModel.options } : {}),
        label: pending.toModelLabel,
      },
      time: {
        start: created,
        end: created,
      },
    },
    traceContext,
  });
}

export async function persistAssistantTimelinePartForSession(
  this: AgentRuntimeInternal,
  options: {
    sessionId: SessionId;
    messageID?: MessageId;
    partID?: PartId;
    parentID?: MessageId;
    created?: number;
    completed?: number;
    finish?: string;
    timeline: TimelinePartDraft;
    traceContext: TraceContext;
  },
): Promise<{ messageID: MessageId; partID: PartId }> {
  if (!this.sessionStore) {
    // 纯内存模式:仍然返回一组 id,让调用方在 live 结构里挂上 timeline part;
    // 只是不落库(冷恢复看不到,这是内存模式的既定边界)。
    return {
      messageID: options.messageID ?? createMessageId(),
      partID: options.partID ?? createPartId(),
    };
  }

  const messageID = options.messageID ?? createMessageId();
  const partID = options.partID ?? createPartId();
  const created = options.created ?? options.timeline.time?.start ?? Date.now();
  // timeline 不是模型产物，记录的是"写卡时的 session selection"，只用于列表展示口径；
  // 不要用它反推内容属于哪个模型（那是 assistant message 的 modelId/providerId 的职责）。
  const selection = this.getSessionModelSelection();
  await this.persistMessage(
    {
      id: messageID,
      sessionID: options.sessionId,
      role: "assistant",
      time: {
        created,
        completed: options.completed ?? options.timeline.time?.end,
      },
      parentID: options.parentID ?? this.latestConversationMessageId ?? messageID,
      modelId: selection && createModelId(selection.modelId),
      providerId: selection && createModelProviderId(selection.providerId),
      mode: this.config.mode ?? "build",
      planEnabled: this.getPlanEnabled(),
      agent: this.config.agentName ?? "zcode-agent",
      path: {
        cwd: this.workingDirectory,
        root: this.workspaceRoot,
      },
      cost: 0,
      tokens: emptyTokenUsageInfo(),
      finish: options.finish ?? options.timeline.status,
      semantics: {
        // 时间线是"系统事实":UI 可见、transcript 可见,但**不发给模型**。
        // providerVisibility=hidden 是这条语义的唯一权威表达,
        // 后续请求投影按它过滤,避免把分隔卡塞进上下文。
        origin: "system",
        kind: "timeline_event",
        uiVisibility: "visible",
        providerVisibility: "hidden",
        transcriptVisibility: "visible",
      },
    },
    options.traceContext,
  );
  await this.persistPart(
    {
      ...options.timeline,
      id: partID,
      sessionID: options.sessionId,
      messageID,
      type: "timeline",
    } as TimelinePart,
    options.traceContext,
  );

  return { messageID, partID };
}

// 只比较 provider/model/reasoningLevel：其它 options（温度等）不构成"用户看到的模型变了"，
// 比较过宽会为无意义的参数抖动刷出分隔卡。
function isSameModelSelection(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

function formatModelSelectionLabel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}
