/**
 * ============================================================================
 * runtime/methods/session-fork.ts —— 会话分叉的三条路径
 * ============================================================================
 *
 * 【三条路径,不要混用】
 *   1. legacy workspace/checkpoint fork(createForkedSession + copySessionMessagesForFork):
 *      逐条 createSession/saveMessage/savePart,允许在任意历史点复制;非原子,
 *      中途失败会留下半成品子会话。仅 legacy workspace fork 使用。
 *   2. stable atomic fork(commitAtomicConversationFork):
 *      V4 的 fork / compact-edit 入口。先建 identity map(消息/part/turn/target/
 *      verifier 全换新 id),再把 child + messages + entries + goal + commandFact
 *      放进同一个 commitForkBundle 事务;任何一步失败都不会留下子会话。
 *   3. selection side chat:只复制"模型可见的历史"(UI 从空白开始),
 *      不复制 goal/verifier/执行态,并用 boundary 消息隔开。
 *
 * 【复制源为什么不是模型恢复历史】
 *   fork 可能发生在编辑重发或 compact 之后:
 *   - forkSourceMessagesForSession 取 **UI transcript 语义** 的活动链,
 *     保留 fork 点前用户能看到的内容,同时排除 rewind/edit 后的旧分支;
 *   - 模型恢复语义(activeSessionMessages)会在 compact boundary 处截断旧 worklog,
 *     直接拿来 fork 会丢历史。
 *
 * 【严格引用】stable 路径给 clone* 传 strictLocalReferences:任何 parentID/turnId/
 *   verifierId 等引用若不在映射表里就直接报错,而不是留一个指向父会话的悬空 id。
 * ============================================================================
 */
// 文件头 · runtime/methods/session-fork.ts —— 会话分叉（fork）编排层
// 职责边界：决定「复制哪段历史 / 复制哪些事实」，并以一次事务写成 child。
// 不负责：文件级回退（rewind/file-rewind）、UI 分叉后的导航、会话状态持有。
// 事实源：runtime.sessionStore；本文件不缓存任何持久化状态。
//
// 不变式（INV）：断言 ｜ 守住它的位置 ｜ 改错后的故障
// INV-01 断言 stable fork 必须走 commitForkBundle 单事务 ｜ 位置 commitAtomicConversationFork 的 !store.commitForkBundle 分支 ｜ 改错 降级逐条写会重现 legacy 半成品子会话
// INV-02 断言 child 内消息/part/turn/target/verifier/toolCall 全部换新 id ｜ 位置 createForkIdentityMap 两遍分配 ｜ 改错 漏表会让 child 引用父事实，删除/编辑跨会话污染
// INV-03 断言 任何局部引用都能在映射表命中 ｜ 位置 mapForkIdentity 与 strictLocalReferences:true ｜ 改错 静默保留父 id 会产出可读但错的 child
// INV-04 断言 加速 Provider 不得成为 child 常驻选型 ｜ 位置 modelSelectionFromMessage / resolveForkModelSelection ｜ 改错 child 首轮以 ModelRequestAuthMissing 失败
// INV-05 断言 选型 entry id 由 childSessionId 派生 ｜ 位置 buildModelSelectionEntry ｜ 改错 同 child 出现两条选型 entry，冷恢复结果不确定
// INV-06 断言 权限取父会话创建时快照 ｜ 位置 buildForkedSessionInput 的 permission 字段 ｜ 改错 继承实时权限会让 child 审批记忆随父漂移失效
// INV-07 断言 executionState 取历史最后一条 assistant ｜ 位置 historicalInfo + resolveExecutionState ｜ 改错 用父当前状态会把 fork 后的权限变更带进 child
// INV-08 断言 side chat 不复制 goal/verifier ｜ 位置 referencedEntryIds 空集 + goalBoundary none ｜ 改错 副屏要求不存在的 child identity 而失败
// INV-09 断言 side chat 复制前移除 goalBoundary ｜ 位置 withoutSelectionSideChatGoalBoundary ｜ 改错 strict clone 直接抛错
// INV-10 断言 side chat 历史截断在 real-user 输入之后 ｜ 位置 selectionSideChatHistoryMessages ｜ 改错 把在途 assistant/tool 增量复制成半轮历史
// INV-11 断言 stable 边界非空、末位匹配、无重复、严格连续 ｜ 位置 stableForkHistoryMessages 四处校验 ｜ 改错 复制一段「看起来连续」的假历史
// INV-12 断言 分叉边界必须是完成且无 error 的 assistant ｜ 位置 stableForkHistoryMessages 的 boundary 校验 ｜ 改错 child 继承没有产出的半轮上下文
// INV-13 断言 fork 不读 checkpoint、不回退文件 ｜ 位置 forkStableConversationAtMessage + restoredFiles:[] ｜ 改错 与 rewind/file-rewind 职责冲突，擅自改动用户工作区
// INV-14 断言 before-input 切点必须是 user 消息 ｜ 位置 conversationHistoryBeforeInput ｜ 改错 child 缺少用户提问却保留回答
// INV-15 断言 boundary 引用的 verifier entry 必须全部存在 ｜ 位置 entries map 与 copyGoalVerificationEntries 的剩余集合 ｜ 改错 验证记录被静默丢弃，goal 状态无法证明
// INV-16 断言 goal 快照 sessionID 必须等于父会话 ｜ 位置 copyGoalStateForFork 的 snapshot 校验 ｜ 改错 把别的会话 goal 搬进本 child
// INV-17 断言 child goal 状态由复制来的验证重推 ｜ 位置 deriveForkedGoalStatusFromCopiedVerifications ｜ 改错 继承未经证明的完成态
// INV-18 断言 父会话 SessionForked 事件是提交后 best-effort ｜ 位置 commitAtomicConversationFork 的 try/catch ｜ 改错 事件失败让已 durable 的 fork 报错或回滚
// INV-19 断言 legacy 路径的事件失败必须上抛 ｜ 位置 forkConversationFromMessage 的 appendEvent ｜ 改错 父会话 UI 不知道 child 已存在
// INV-20 断言 copySources 是「新 id → 旧 id」 ｜ 位置 commitForkBundle 入参的 Object.fromEntries ｜ 改错 方向写反导致 child 消息体为空
// INV-21 断言 分叉通知 hidden/notice 成对出现 ｜ 位置 buildAtomicForkNotice ｜ 改错 模型知道是 fork 而 UI 不知道，或反之
// INV-22 断言 sourceCommandId 非空 ｜ 位置 createSelectionSideConversation / forkStableConversationAtMessage ｜ 改错 重试产生第二个 side chat，commandFact 对不上
import { randomUUID } from "node:crypto";
import { isHighspeedProviderId, resolveExecutionState, type ExecutionState } from "@zcode/shared";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";
import {
  createModelId,
  createModelProviderId,
  type CreateSessionInput,
  type ForkCommitBundle,
} from "@zcode/contracts";
import { systemReminderRuntimeMetadata } from "../../agent/message-history.js";
import {
  CoreErrorType,
  RewindStrategy,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createCoreError,
  createMessageId,
  createPartId,
  createSessionId,
  createToolCallId,
  createTurnId,
  selectActiveConversationBranch,
  traceContextToLogContext,
} from "../deps.js";
import type {
  GoalStatus,
  MessageId,
  PartId,
  SessionEntryInfo,
  SessionGoal,
  TargetCompletionVerificationPayload,
  MessageWithParts,
  SessionId,
  SessionInfo,
  SessionStorePort,
  TraceContext,
  TurnId,
} from "../deps.js";
import {
  cloneMessageForFork,
  clonePartForFork,
  emptyTokenUsageInfo,
  formatConversationForkNoticeBody,
  slugify,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildSyntheticUserNoticePartMetadata } from "./synthetic-notice-metadata.js";
import type {
  StableConversationForkChildMetadata,
  StableConversationForkGoalBoundary,
  StableConversationForkOptions,
  ConversationBeforeInputForkOptions,
  SelectionSideChatCreateOptions,
  StableConversationForkTarget,
  WorkspaceForkResult,
} from "../types.js";
import { cloneModelSelection } from "../model-selection.js";
import type { ModelSelection } from "@zcode/contracts";

function stableForkError(message: string, context: Record<string, unknown> = {}): Error {
  return createCoreError(CoreErrorType.InvalidStateTransition, message, {
    context,
    recoverable: true,
  });
}

// [契约] 后缀与 childSessionId 拼成稳定 entry id；改后缀会让既有 child 的选型 entry 变成无人读取的孤儿。
// [失败路径] 冷恢复按 entry type 取记录，id 不幂等就会出现两条互相覆盖，取到哪条不确定。
// [权衡] 不引入额外「来源」字段，用 id 派生换取同 child 天然只一条。
// [契约] 该常量只在本文件使用，不得被 adapter 复用来拼别的 entry id。
const MODEL_SELECTION_ENTRY_SUFFIX = ":runtime-model-selection";

// [契约] 只回答「这条消息能否作为 child 的常驻选型」，不做持久化与日志。
// [失败路径] 返回 undefined 是正常回落信号，不是错误；调用方继续向前找普通选型。
// [权衡] 加速卡 Selection 是单轮执行事实，继承会把 child 钉死在无凭据 Provider 上。
// [契约] user 消息有完整 modelSelection，assistant 只能靠持久化字段还原。
// [失败路径] 若在此回读 runtime 选型，历史优先级会被当前运行态偷偷覆盖。
function modelSelectionFromMessage(message: MessageWithParts): ModelSelection | undefined {
  const selection = persistedModelSelectionOfMessage(message);
  // 加速卡 Selection 是 `selectionScope=execution` 的单轮执行事实（highspeed-card-spec §5），
  // 只有与同一轮 requestAuth 成对才有效。child 继承它会常驻在无凭据的加速 Provider 上：
  // 用户看到「分叉后原模型没带过来」，子会话首轮还会以 ModelRequestAuthMissing 失败。
  // 因此跳过该消息，继续向前找最近一次普通选型，最终回落 runtime 常驻 Selection。
  return selection && isHighspeedProviderId(selection.providerId) ? undefined : selection;
}

// [契约] assistant 不持久化完整 Selection，只能从 modelId/providerId + reasoningLevel 还原。
// [失败路径] 缺任一 id 时返回 undefined：宁可回落 runtime，也不要拼半个 Selection。
// [契约] user 分支必须 clone，避免 child 与父共享同一 options 对象引用。
// [失败路径] reasoningLevel 只在存在时写入 options，否则会写出 undefined 键污染比较。
// [权衡] 还原精度低于原始对象，但足以让 child 冷启动选对模型。
function persistedModelSelectionOfMessage(message: MessageWithParts): ModelSelection | undefined {
  if (message.info.role === "user") {
    return message.info.modelSelection && cloneModelSelection(message.info.modelSelection);
  }
  // assistant 不存完整 modelSelection，只能从 modelId/providerId + reasoningLevel 还原；
  // 这也是为什么模型必须在 persistAssistantMessage 时由调用方显式传入。
  if (!message.info.modelId || !message.info.providerId) return undefined;
  return {
    modelId: message.info.modelId,
    providerId: message.info.providerId,
    ...(message.info.reasoningLevel
      ? { options: { reasoningLevel: message.info.reasoningLevel } }
      : {}),
  };
}

// [契约] 优先级：显式传入 → 历史最近一次普通选型 → runtime 常驻 Selection。
// [失败路径] 三者皆无时返回 undefined，让 child 走自身默认，而不是伪造一个选型。
// [契约] explicit 也要过滤加速 Provider，调用方无法绕过 modelSelectionFromMessage 的规则。
// [并发] runtime.getSessionModelSelection 读当前运行态，父会话可能刚被切换，只作兜底。
// [契约] reasoningLevel 允许来自历史或 runtime 任一侧，最终合并进同一 options。
// [失败路径] 若整体展开合并两侧 options，历史里缺失的键会被 runtime 值悄悄补上。
function resolveForkModelSelection(
  runtime: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
  explicit?: ModelSelection,
): ModelSelection | undefined {
  // 加速 Provider 不能成为 child 的常驻 Selection（理由见 modelSelectionFromMessage），
  // 调用方显式传入时同样跳过，回落历史普通选型 / runtime 常驻 Selection。
  if (explicit && !isHighspeedProviderId(explicit.providerId)) return cloneModelSelection(explicit);
  const historical = [...messages].reverse().map(modelSelectionFromMessage).find(Boolean);
  const runtimeSelection = runtime.getSessionModelSelection();
  const identity = historical ?? runtimeSelection;
  if (!identity) return undefined;
  const historicalOptions = historical?.options;
  const reasoningLevel =
    historicalOptions?.reasoningLevel ?? runtimeSelection?.options?.reasoningLevel;
  return {
    modelId: identity.modelId,
    providerId: identity.providerId,
    ...(reasoningLevel !== undefined
      ? {
          options: {
            ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
          },
        }
      : {}),
  };
}

// [契约] touchSession:false —— 写选型 entry 不得刷新会话活跃时间。
// [事务] 该 entry 与 child/messages 同 bundle 提交，不允许随后单独补写。
// [失败路径] data 为 null 表示「显式无选型」，与「没有 entry」是不同语义，读取端不能混用。
// [契约] id 由 childSessionId 派生，重复写入是幂等覆盖而不是新增。
// [失败路径] 时间戳统一取同一个 now，避免 created/updated 微小差异引发无意义 diff。
function buildModelSelectionEntry(
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
): SessionEntryInfo {
  const timestamp = Date.now();
  // entry id 由 childSessionId 派生而非随机：同一 child 重复写入时是幂等覆盖，
  // 不会留下两条"选型"entry 让冷恢复取到哪条都不确定。
  return {
    id: `${childSessionId}${MODEL_SELECTION_ENTRY_SUFFIX}`,
    sessionID: childSessionId,
    type: SESSION_ENTRY_MODEL_SELECTION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: modelSelection ? cloneModelSelection(modelSelection) : null,
  };
}

/** stable/compact-edit fork 一次性预分配的完整 child-local 身份。 */
// [契约] 该接口是 child 内身份的唯一事实源，所有 clone* 只允许从这里取新 id。
// [失败路径] 漏一张子表（如 toolCallIds）会让 child 引用父事实，删除/编辑跨会话污染。
// [权衡] ForkIdentityMap 一次性预分配全部 id，换取第二遍改写 map 时无需回填。
// [契约] notice 的六个 id 必须成组分配，供 hidden/notice 两条消息共用同一 anchor。
// [失败路径] 若延迟到构建消息时才生成 notice id，anchor 里的 turnId 会与实际 part 不一致。
export interface ForkIdentityMap {
  parentSessionId: SessionId;
  childSessionId: SessionId;
  messageIds: Map<MessageId, MessageId>;
  partIds: Map<PartId, PartId>;
  turnIds: Map<string, string>;
  productTurnIds: Map<string, string>;
  targetIds: Map<string, string>;
  verifierEntryIds: Map<string, string>;
  verificationIds: Map<string, string>;
  toolCallIds: Map<string, string>;
  notice: {
    hiddenMessageId: MessageId;
    hiddenPartId: PartId;
    messageId: MessageId;
    partId: PartId;
    turnId: TurnId;
    productTurnId: string;
  };
}

// [契约] parentID 取 runtime.sessionId（实际父），不依赖入参 parentSession 的隐式推导。
// [契约] workspaceID/directory/path 直接继承父会话：child 与父同工作区。
// [失败路径] slug 截断 120 是存储层长度约束；去掉截断会让超长标题写库失败。
// [契约] title/titleSource 只用于展示，不参与任何 identity 计算。
// [契约] taskType 区分 fork 与 selection_side_chat，后续查询按它分流。
// [失败路径] version 继承父会话，child 不能借 fork 偷偷升级存储版本。
function buildForkedSessionInput(
  runtime: AgentRuntimeInternal,
  parentSession: SessionInfo,
  forkedSessionId: SessionId,
  kind: "fork" | "selection_side_chat" = "fork",
): CreateSessionInput {
  const now = Date.now();
  return {
    id: forkedSessionId,
    projectID: parentSession.projectID,
    workspaceID: parentSession.workspaceID,
    parentID: runtime.sessionId,
    traceID: runtime.rootTraceContext.traceId,
    taskType: kind,
    slug: `${slugify(parentSession.slug)}-${kind}-${now.toString(36)}`.slice(0, 120),
    directory: parentSession.directory,
    path: parentSession.path,
    title:
      kind === "selection_side_chat" ? "Selection side chat" : `Fork of ${parentSession.title}`,
    titleSource: "generated",
    version: parentSession.version,
    // 权限继承父会话创建时的快照，不是父会话**当前**值：fork 的权限基线
    // 不能随父会话后来的改动漂移，否则 child 的审批记忆会突然失效。
    permission: parentSession.permission,
    time: {
      created: now,
      updated: now,
    },
  };
}

// [契约] 按 targetID 去重，boundary 快照覆盖消息内的同 id 快照（后者更新）。
// [失败路径] 不去重会让同一 goal 在 child 出现两条 target 记录。
// [契约] 只认 kind=snapshot 的 goalBoundary，非 snapshot 表示该消息不是目标边界。
// [失败路径] 把非 snapshot 也当快照会让 goal 状态凭空多出一份。
function collectForkGoalSnapshots(
  messages: readonly MessageWithParts[],
  boundary: StableConversationForkGoalBoundary,
): SessionGoal[] {
  const byId = new Map<string, SessionGoal>();
  for (const message of messages) {
    const goalBoundary = message.info.anchor?.goalBoundary;
    if (goalBoundary?.kind === "snapshot") {
      byId.set(goalBoundary.target.targetID, goalBoundary.target);
    }
  }
  if (boundary.kind === "snapshot") byId.set(boundary.target.targetID, boundary.target);
  return [...byId.values()];
}

// [契约] 只收集 snapshot 形态 boundary 的 verificationEntryIds。
// [失败路径] 非 snapshot boundary 恒空，stable fork 才不会要求不存在的 child identity。
// [契约] 结果为 Set，调用方按「边界引用集合」一次性校验存在性。
// [失败路径] 用数组会重复校验同一条 entry，且剩余集合语义失效。
function collectVerifierEntryIds(
  messages: readonly MessageWithParts[],
  boundary: StableConversationForkGoalBoundary,
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const goalBoundary = message.info.anchor?.goalBoundary;
    if (goalBoundary?.kind === "snapshot") {
      for (const id of goalBoundary.verificationEntryIds) ids.add(id);
    }
  }
  if (boundary.kind === "snapshot") {
    for (const id of boundary.verificationEntryIds) ids.add(id);
  }
  return ids;
}

// [事务] 该函数无 IO、无 await，整张 map 在同步段内构建完成，不存在半成品状态。
// [契约] notice.productTurnId 派生自 hiddenMessageId，保证与 UI 行归属一致。
// [失败路径] 若给 notice 随机 productTurnId，UI 会把分隔卡挂到错误行。
// [契约] 第一遍分配 id、第二遍建立引用映射，两遍顺序不可交换。
// [失败路径] 一遍完成会因 map 未填全而生成悬空的 turn/verifier 引用。
// [契约] 所有新 id 一经分配即固定，后续 clone 只读不写。
export function createForkIdentityMap(options: {
  childSessionId: SessionId;
  entries: readonly SessionEntryInfo[];
  goalSnapshots: readonly SessionGoal[];
  messages: readonly MessageWithParts[];
  parentSessionId: SessionId;
}): ForkIdentityMap {
  const messageIds = new Map<MessageId, MessageId>();
  const partIds = new Map<PartId, PartId>();
  const turnIds = new Map<string, string>();
  const productTurnIds = new Map<string, string>();
  const targetIds = new Map<string, string>();
  const verifierEntryIds = new Map<string, string>();
  const verificationIds = new Map<string, string>();
  const toolCallIds = new Map<string, string>();
  const noticeHiddenMessageId = createMessageId();
  const notice = {
    hiddenMessageId: noticeHiddenMessageId,
    hiddenPartId: createPartId(),
    messageId: createMessageId(),
    partId: createPartId(),
    turnId: createTurnId(),
    productTurnId: String(noticeHiddenMessageId),
  };
  const addTurn = (id: unknown) => {
    if (typeof id === "string" && id && !turnIds.has(id)) {
      turnIds.set(id, String(createTurnId()));
    }
  };
  // [契约] product turn 优先映射到已分配的 messageId，否则新生成。
  // [失败路径] 直接新生成会让 product turn 与消息归属脱钩，UI 分组错位。
  // [契约] 用 Map.has 去重：同一 productTurnId 只分配一次。
  // [权衡] productTurnId 与 turnId 可以不同源：前者是 UI 行，后者是运行时轮次。
  // [失败路径] 必须忽略空字符串 id，否则所有无 id 消息会共享同一映射。
  const addProductTurn = (id: unknown) => {
    if (typeof id !== "string" || !id || productTurnIds.has(id)) return;
    // 能映射到 message 就用新 messageId，否则新生成：保证 product turn 身份
    // 在 child 内唯一，且与 UI 行的归属一致。
    const messageId = messageIds.get(id as MessageId);
    productTurnIds.set(id, String(messageId ?? createTurnId()));
  };

  // 第一遍只分配新 id：必须先填满 message/part/toolCall/attachment 映射，
  // 第二遍再做引用改写；一遍完成会因 map 未填全而生成悬空的 turn/verifier 引用。
  // [事务] 第一遍只分配 message/part/toolCall/attachment 映射，不做任何引用改写。
  // [契约] 附件 id 也换新：与父共享 artifact 身份会让删除/去重/展示互相串。
  // [失败路径] 只换 part.id 不换 callID，会让工具调用与结果在 child 内对不上。
  // [契约] 只有 completed 状态的 tool part 才展开 attachments。
  // [失败路径] 对未完成 part 读 state.attachments 会读到不存在的字段。
  // [权衡] 两遍遍历是 O(n)，换来 partIds 与 messageIds 的映射顺序确定。
  for (const message of options.messages) {
    messageIds.set(message.info.id, createMessageId());
    for (const part of message.parts) {
      partIds.set(part.id, createPartId());
      if (part.type === "tool") {
        toolCallIds.set(part.callID, String(createToolCallId()));
        if (part.state.status === "completed") {
          // 工具结果附件也换新 id：否则 child 与 parent 共享同一 artifact 身份，
          // 删除/去重/展示会互相串。
          for (const attachment of part.state.attachments ?? []) {
            partIds.set(attachment.id, createPartId());
          }
        }
      }
    }
  }
  for (const message of options.messages) {
    addTurn(message.info.anchor?.turnId);
    addProductTurn(message.info.anchor?.productTurnId);
    for (const part of message.parts) {
      if (part.type === "timeline") {
        addTurn(part.anchorTurnId);
        // goal_verification 卡片的 targetId/verificationId 必须与 verifier entry
        // 用同一张映射表：否则 UI 找不到对应的验证记录，分隔线会消失。
        if (part.timelineType === "goal_verification") {
          if (!targetIds.has(part.targetId)) {
            targetIds.set(part.targetId, `fork_target_${randomUUID()}`);
          }
          if (!verificationIds.has(part.verificationId)) {
            verificationIds.set(part.verificationId, `fork_verify_${randomUUID()}`);
          }
        }
      }
      if (part.type === "compaction") addTurn(part.compactBoundary?.turnId);
    }
  }
  for (const goal of options.goalSnapshots) {
    if (!targetIds.has(goal.targetID)) {
      targetIds.set(goal.targetID, `fork_target_${randomUUID()}`);
    }
  }
  // verifier entry 也整体换 id：entry 是 goal iteration 的 durable 边界，
  // 共享父 id 会让 child 的验证历史与父会话互相覆盖。
  // [事务] verifier entry 整体换 id：entry 是 goal iteration 的 durable 边界。
  // [失败路径] 共享父 entry id 会让 child 的验证历史与父互相覆盖。
  // [契约] entry payload 里的 verificationId 进同一张映射表。
  // [失败路径] 漏掉 payload.anchorTurnId 的 addTurn，会让 verifier 卡片指向父轮次。
  // [契约] 只读 asRecord 的安全视图，不假设 payload 一定是合法对象。
  for (const entry of options.entries) {
    verifierEntryIds.set(entry.id, `fork_goal_verify_${randomUUID()}`);
    const payload = asRecord(asRecord(entry.data).payload);
    if (
      typeof payload.verificationId === "string" &&
      !verificationIds.has(payload.verificationId)
    ) {
      verificationIds.set(payload.verificationId, `fork_verify_${randomUUID()}`);
    }
    addTurn(payload.anchorTurnId);
  }
  return {
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    messageIds,
    partIds,
    turnIds,
    productTurnIds,
    targetIds,
    verifierEntryIds,
    verificationIds,
    toolCallIds,
    notice,
  };
}

// [失败路径] 映射缺失即抛 stableForkError，绝不静默保留父 id。
// [契约] field 只进入错误上下文，不参与查找。
// [权衡] strict 让 fork 在数据不一致时尽早失败，而不是产出可读但错的 child。
// [失败路径] 静默透传父 id 会让后续删除/编辑跨会话污染。
// [契约] 该函数是 strictLocalReferences 的本地等价实现。
function mapForkIdentity(map: ReadonlyMap<string, string>, id: string, field: string): string {
  const mapped = map.get(id);
  // 映射缺失即报错（strict 语义）：静默保留父 id 会让 child 引用父会话事实，
  // 后续删除/编辑会跨会话污染（大纲链路 6 的 strictLocalReferences）。
  if (!mapped) throw stableForkError(`Stable fork cannot remap ${field}`, { id });
  return mapped;
}

// [契约] activeRun* 三个字段必须清空：父会话的「正在跑」不属于 child。
// [失败路径] 保留 activeRun 会让 child 的续跑循环立刻退出或重复启动。
// [契约] sessionID 改写为 childSessionId，targetID 走映射表。
// [失败路径] 若保留父 targetID，child 的验证记录会与父共用同一条目标。
// [权衡] 只做身份重写，不改 status；状态由调用方按 boundary 决定。
function remapGoalForFork(goal: SessionGoal, identities: ForkIdentityMap): SessionGoal {
  return {
    ...goal,
    sessionID: identities.childSessionId,
    targetID: mapForkIdentity(identities.targetIds, goal.targetID, "goal target"),
    // 必须清空 activeRun*：父会话的"正在跑"标记不应让 child 认为
    // 该 goal 已被本轮驱动，否则续跑循环会立刻退出或重复启动。
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
  };
}

// [契约] payload.targetId/verificationId 必须都在映射表里，缺失即抛错。
// [契约] data.eventId 重新生成：event id 是幂等键，复制父值会撞车。
// [契约] forkOrigin 保留旧 entryId/eventId/verificationId 供溯源。
// [失败路径] anchorAssistantMessageId/anchorTurnId 按需重写，漏改会指向父消息。
// [契约] payload 先经 asRecord 校验，非对象一律当作身份非法。
// [失败路径] 直接展开 payload 而不校验，会让 undefined targetId 静默进映射查找。
function cloneVerifierEntryForAtomicFork(
  entry: SessionEntryInfo,
  identities: ForkIdentityMap,
): { entry: SessionEntryInfo; payload: TargetCompletionVerificationPayload } {
  const data = asRecord(entry.data);
  const payload = asRecord(data.payload);
  if (typeof payload.targetId !== "string" || typeof payload.verificationId !== "string") {
    throw stableForkError("Stable fork verifier entry has invalid identity", { entryId: entry.id });
  }
  const clonedPayload: Record<string, unknown> = {
    ...payload,
    targetId: mapForkIdentity(identities.targetIds, payload.targetId, "verifier target"),
    verificationId: mapForkIdentity(
      identities.verificationIds,
      payload.verificationId,
      "verification id",
    ),
  };
  if (typeof payload.anchorAssistantMessageId === "string") {
    clonedPayload.anchorAssistantMessageId = mapForkIdentity(
      identities.messageIds,
      payload.anchorAssistantMessageId,
      "verifier assistant anchor",
    );
  }
  if (typeof payload.anchorTurnId === "string") {
    clonedPayload.anchorTurnId = mapForkIdentity(
      identities.turnIds,
      payload.anchorTurnId,
      "verifier turn anchor",
    );
  }
  const nextEntryId = mapForkIdentity(identities.verifierEntryIds, entry.id, "verifier entry");
  const nextPayload = clonedPayload as unknown as TargetCompletionVerificationPayload;
  return {
    entry: {
      ...entry,
      id: nextEntryId,
      sessionID: identities.childSessionId,
      data: {
        ...data,
        eventId: randomUUID(),
        payload: nextPayload,
        forkOrigin: {
          entryId: entry.id,
          eventId: data.eventId,
          verificationId: payload.verificationId,
        },
      },
    },
    payload: nextPayload,
  };
}

// [契约] 返回两条消息，共享同一 anchor：hidden 给 provider，notice 给 UI。
// [失败路径] 只写其一会出现「模型知道是 fork 而 UI 不知道」或反之。
// [契约] hidden 的 visibility=model-only、notice 的 providerVisibility=hidden，不可互换。
// [失败路径] executionState 必须与 child 持久化状态一致，否则首屏权限显示错。
// [契约] hidden 是 role=user，notice 是 role=assistant，parentID 指向 hidden。
// [失败路径] 顺序颠倒会让 UI 把交接说明当成模型回答。
export function buildAtomicForkNotice(
  runtime: AgentRuntimeInternal,
  options: {
    identities: ForkIdentityMap;
    modelSelection?: ModelSelection;
    executionState?: ExecutionState;
    sourceCommandId: string;
    targetMessageId: MessageId;
  },
): MessageWithParts[] {
  const created = Date.now();
  const {
    hiddenMessageId: hiddenId,
    hiddenPartId,
    messageId: noticeId,
    partId: noticePartId,
    turnId: noticeTurnId,
    productTurnId,
  } = options.identities.notice;
  const anchorMessageId = options.identities.messageIds.get(options.targetMessageId) ?? hiddenId;
  const anchor = {
    turnId: noticeTurnId,
    productTurnId,
    orderedMessageIds: [hiddenId, noticeId],
    boundaryMessageId: noticeId,
  };
  const forkOrigin = {
    parentSessionId: runtime.sessionId,
    targetMessageId: options.targetMessageId,
  };
  const runtimeSelection = runtime.getSessionModelSelection();
  const modelSelection = options.modelSelection ?? runtimeSelection;
  // 两条消息成对出现、共享同一 anchor：
  //   hidden = model-only 的交接说明（provider 可见、UI 不可见）；
  //   notice = assistant timeline 分隔卡（UI 可见、provider 不可见）。
  // 只写其中之一会让"模型知道这是 fork"或"UI 知道这是 fork"缺一半。
  return [
    {
      info: {
        id: hiddenId,
        sessionID: options.identities.childSessionId,
        role: "user",
        time: { created },
        agent: runtime.config.agentName ?? "zcode-agent",
        modelSelection: modelSelection && cloneModelSelection(modelSelection),
        synthetic: true,
        source: "fork",
        visibility: "model-only",
        semantics: {
          origin: "system",
          kind: "fork_notice",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        anchor,
        metadata: { forkOrigin },
      },
      parts: [
        {
          id: hiddenPartId,
          sessionID: options.identities.childSessionId,
          messageID: hiddenId,
          type: "text",
          text: formatConversationForkNoticeBody(forkOrigin),
          synthetic: true,
          time: { start: created, end: created },
          // hydrate 只读 part metadata；独立 source 保留 fork 边界且不改变 checkpoint 的 MCS 行为。
          metadata: buildSyntheticUserNoticePartMetadata("fork", "model-only", {
            forkOrigin,
            runtimeMessage: systemReminderRuntimeMetadata("conversation_fork"),
          }),
        },
      ],
    },
    {
      info: {
        id: noticeId,
        sessionID: options.identities.childSessionId,
        role: "assistant",
        time: { created, completed: created },
        parentID: hiddenId,
        modelId: modelSelection && createModelId(modelSelection.modelId),
        providerId: modelSelection && createModelProviderId(modelSelection.providerId),
        ...(modelSelection?.options?.reasoningLevel
          ? { reasoningLevel: modelSelection.options.reasoningLevel }
          : {}),
        // 分支提示本身也属于新分支历史，必须与分支的持久化状态保持一致。
        ...(options.executionState ?? readRuntimeExecutionState(runtime)),
        agent: runtime.config.agentName ?? "zcode-agent",
        path: { cwd: runtime.workingDirectory, root: runtime.workspaceRoot },
        cost: 0,
        tokens: emptyTokenUsageInfo(),
        finish: "completed",
        semantics: {
          origin: "system",
          kind: "timeline_event",
          uiVisibility: "visible",
          providerVisibility: "hidden",
          transcriptVisibility: "visible",
        },
        anchor,
        metadata: { forkOrigin },
      },
      parts: [
        {
          id: noticePartId,
          sessionID: options.identities.childSessionId,
          messageID: noticeId,
          type: "timeline",
          timelineType: "session_fork",
          display: "separator",
          status: "completed",
          anchorMessageId,
          anchorTurnId: noticeTurnId,
          sourceCommandId: options.sourceCommandId,
          parentSessionId: runtime.sessionId,
          targetMessageId: options.targetMessageId,
          restoredFileCount: 0,
          time: { start: created, end: created },
        },
      ],
    },
  ];
}

// [契约] 边界文案是模型侧契约，改动等于改变 side chat 的行为约定。
// [失败路径] 删掉「不要自动续跑」会让模型在副屏继续执行父任务。
// [权衡] 用静态文案而非模板：不引入变量，避免注入与首字差异。
// [契约] 三段用空格拼成单段，保持一条 user 文本。
// [失败路径] 改成多条消息会多出一个 UI 行，破坏「UI 从空白开始」的语义。
const SELECTION_SIDE_CHAT_BOUNDARY = [
  "The preceding conversation was inherited from the parent task for reference only.",
  "Do not continue the parent's active work automatically; answer only new questions sent in this side chat.",
  "Modify the workspace only when the user explicitly asks you to do so in this side chat.",
].join(" ");

// [契约] 该消息 model-only + transcript hidden：UI 从空白开始，模型看到交接说明。
// [失败路径] 只写 info.source 不写 part metadata，hydrate 后退化为普通 user 文本。
// [契约] anchor 的 boundaryMessageId 指向自身，作为历史结束标记。
// [失败路径] 缺 anchor 会让后续 stable 选择器找不到这条边界消息。
// [契约] source 固定 selection_side_chat，便于统计与过滤。
function buildSelectionSideChatBoundary(
  runtime: AgentRuntimeInternal,
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
): MessageWithParts {
  const created = Date.now();
  const messageId = createMessageId();
  const turnId = createTurnId();
  return {
    info: {
      id: messageId,
      sessionID: childSessionId,
      role: "user",
      time: { created },
      agent: runtime.config.agentName ?? "zcode-agent",
      modelSelection: modelSelection && cloneModelSelection(modelSelection),
      synthetic: true,
      source: "selection_side_chat",
      visibility: "model-only",
      semantics: {
        origin: "system",
        kind: "system_reminder",
        source: "selection_side_chat",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      anchor: {
        turnId,
        productTurnId: String(messageId),
        orderedMessageIds: [messageId],
        boundaryMessageId: messageId,
        origin: "synthetic",
      },
    },
    parts: [
      {
        id: createPartId(),
        sessionID: childSessionId,
        messageID: messageId,
        type: "text",
        text: SELECTION_SIDE_CHAT_BOUNDARY,
        synthetic: true,
        time: { start: created, end: created },
        // hydrate 读取 part metadata；只写 info.source 会退化为普通 user 文本。
        metadata: buildSyntheticUserNoticePartMetadata(
          "selection_side_chat",
          "model-only",
          undefined,
        ),
      },
    ],
  };
}

// [契约] 只删 goalBoundary，保留父对话正文作为模型上下文。
// [失败路径] 不删会让 strict clone 要求 child 不存在的 goal identity 而失败。
// [契约] 无 goalBoundary 时原样返回同一引用，避免无意义拷贝。
// [权衡] 浅拷贝 anchor 后 delete，不修改入参消息。
// [失败路径] 直接 delete 入参的 anchor.goalBoundary 会污染父历史对象。
function withoutSelectionSideChatGoalBoundary(message: MessageWithParts): MessageWithParts {
  const anchor = message.info.anchor;
  if (!anchor?.goalBoundary) return message;
  const anchorWithoutGoalBoundary = { ...anchor };
  delete anchorWithoutGoalBoundary.goalBoundary;
  return {
    ...message,
    info: {
      ...message.info,
      anchor: anchorWithoutGoalBoundary,
    },
  };
}

// [事务] 本函数是 stable/compact-edit 的唯一写入口：child + messages + entries + goal + commandFact 一次提交。
// [失败路径] 任一步失败父会话不受影响，也不留子会话——这是与 legacy 的核心差异。
// [契约] 调用方必须已确定 messages 切片，本函数不再二次裁剪历史。
// [并发] 提交后父会话事件是 best-effort，见函数尾部 try/catch。
// [契约] kind 决定是否收集 goal/verifier、是否写 fork notice。
// [失败路径] kind 必须默认 fork，否则 side chat 误走普通分支。
async function commitAtomicConversationFork(
  runtime: AgentRuntimeInternal,
  options: {
    commandFact?: ForkCommitBundle["commandFact"];
    modelSelection?: ModelSelection;
    forkedSessionId?: SessionId;
    goalBoundary: StableConversationForkGoalBoundary;
    initialInput?: ForkCommitBundle["initialInput"];
    messages: readonly MessageWithParts[];
    parentSession: SessionInfo;
    revisionAtDecision?: number;
    sourceCommandId: string;
    targetMessageId: MessageId;
    target?: StableConversationForkTarget;
    traceContext: TraceContext;
    kind?: "fork" | "selection_side_chat";
  },
): Promise<WorkspaceForkResult> {
  const store = runtime.sessionStore;
  // 没有单事务入口就拒绝：stable fork 的全部正确性依赖"child + 历史 + entries + goal
  // 一次提交"，降级成逐条写会把 legacy 的半成品窗口重新引进来。
  if (!store?.commitForkBundle) {
    throw stableForkError("Stable fork requires commitForkBundle");
  }
  const childSessionId = options.forkedSessionId ?? createSessionId();
  const kind = options.kind ?? "fork";
  const currentExecutionState = readRuntimeExecutionState(runtime);
  // 从历史尾部反向找最后一条 assistant:它的 executionState 才是"fork 点当时的权限/模式",
  // 不能用父会话**当前**的执行态(父会话可能在 fork 后切过权限)。
  // [契约] 从历史尾部反向找最后一条 assistant，取它当时的 executionState。
  // [失败路径] 用父会话当前执行态，会把 fork 之后用户改过的权限带进 child。
  // [契约] 先复制再 reverse，避免就地把入参数组反转。
  // [失败路径] 直接 options.messages.reverse() 会篡改调用方数组顺序。
  // [权衡] 找不到 assistant（空历史）时回落 currentExecutionState。
  const historicalInfo = [...options.messages]
    .reverse()
    .find((message) => message.info.role === "assistant")?.info;
  // 保留原 stable fork 的历史权限选择，不能让新增 entry 把它覆盖成父任务当前权限。
  const executionState =
    kind === "selection_side_chat" || historicalInfo?.role !== "assistant"
      ? currentExecutionState
      : resolveExecutionState(historicalInfo);
  // 辅助对话明确不复制 Goal target/verifier entries，不能仍将
  // 父消息的 goalBoundary 交给 strict fork clone，否则任意 Goal 状态都会要求不存在的
  // child-local identity。只移除用于 Goal 恢复的 boundary，保留父对话正文作为模型上下文。
  const sourceMessages =
    kind === "selection_side_chat"
      ? options.messages.map(withoutSelectionSideChatGoalBoundary)
      : options.messages;
  const modelSelection = resolveForkModelSelection(runtime, sourceMessages, options.modelSelection);
  // 只有普通 fork 才收集 verifier 边界；side chat 明确不复制 goal/verifier，
  // 若仍收集就会要求不存在的 child-local identity 而失败。
  // [契约] side chat 的引用集合恒为空：它明确不复制 goal/verifier。
  // [失败路径] 若仍收集，会让 side chat 要求不存在的 child-local identity 而失败。
  // [契约] 普通 fork 只收集 boundary 覆盖到的 entry id。
  // [失败路径] 全量收集父会话 entry 会把 fork 点之后的验证记录也带进 child。
  // [权衡] 空集合与「未加载」用 size 区分，不引入额外的 undefined 语义。
  const referencedEntryIds =
    kind === "selection_side_chat"
      ? new Set<string>()
      : collectVerifierEntryIds(sourceMessages, options.goalBoundary);
  // [失败路径] 边界非空但 adapter 返回 undefined 必须报错。
  // [契约] 不能把「枚举失败」当成「没有 verifier」继续提交。
  // [失败路径] 静默继续会让 child 丢失目标完成证据，goal 状态无法证明。
  // [契约] 边界为空时完全不调用 sessionEntries，避免不必要的 IO。
  const allEntries = referencedEntryIds.size
    ? await store.sessionEntries?.({
        sessionID: runtime.sessionId,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
      })
    : [];
  // 边界非空但 entry 枚举失败（adapter 未实现返回 undefined）必须报错：
  // 不能当成"没有 verifier"继续提交，否则 child 丢失目标完成证据。
  if (referencedEntryIds.size && !allEntries) {
    throw stableForkError("Stable fork verifier boundary cannot be loaded");
  }
  const entryById = new Map((allEntries ?? []).map((entry) => [entry.id, entry]));
  // 边界引用的 entry 必须全部存在：少一条就意味着 fork 点之后的验证记录
  // 会被静默丢弃，child 的 goal 状态将无法证明。
  const entries = [...referencedEntryIds].map((id) => {
    const entry = entryById.get(id);
    if (!entry) {
      throw stableForkError("Stable fork verifier boundary references missing entries", {
        verificationEntryId: id,
      });
    }
    return entry;
  });
  const goalSnapshots =
    kind === "selection_side_chat"
      ? []
      : collectForkGoalSnapshots(sourceMessages, options.goalBoundary);
  const identities = createForkIdentityMap({
    childSessionId,
    entries,
    goalSnapshots,
    messages: sourceMessages,
    parentSessionId: runtime.sessionId,
  });
  // 所有 clone 都从 identity map 取新 id,并开启 strictLocalReferences:
  // 引用不在 map 里就报错,避免子会话里出现"指向父会话"的脏引用。
  // [契约] 所有 clone 从 identity map 取新 id，并开启 strictLocalReferences。
  // [失败路径] 引用不在 map 里就报错，避免 child 出现指向父会话的脏引用。
  // [契约] side chat 的每条历史被改成 model-only + transcript hidden。
  // [失败路径] 不改 visibility 会让副屏把继承历史误认成普通 fork。
  // [契约] nextMessageId 用非空断言取，前提是第一遍已为所有消息分配。
  // [失败路径] 若 map 缺该消息，断言会抛 TypeError 而不是可读的 stableForkError。
  const copiedMessages = sourceMessages.map((message) => {
    const nextMessageId = identities.messageIds.get(message.info.id)!;
    const cloned = {
      info: cloneMessageForFork(message.info, {
        forkedSessionId: childSessionId,
        messageIdMap: identities.messageIds,
        nextMessageId,
        turnIdMap: identities.turnIds,
        productTurnIdMap: identities.productTurnIds,
        targetIdMap: identities.targetIds,
        verificationEntryIdMap: identities.verifierEntryIds,
        strictLocalReferences: true,
      }),
      parts: message.parts.map((part) =>
        clonePartForFork(part, {
          forkedSessionId: childSessionId,
          nextMessageId,
          nextPartId: identities.partIds.get(part.id),
          partIdMap: identities.partIds,
          messageIdMap: identities.messageIds,
          turnIdMap: identities.turnIds,
          targetIdMap: identities.targetIds,
          verificationIdMap: identities.verificationIds,
          toolCallIdMap: identities.toolCallIds,
          strictLocalReferences: true,
        }),
      ),
    };
    if (kind !== "selection_side_chat") return cloned;
    // 副屏继承历史仅供模型参考；UI 从空白副屏开始，避免把它误认成普通 fork。
    return {
      ...cloned,
      info: {
        ...cloned.info,
        visibility: "model-only" as const,
        semantics: {
          origin: cloned.info.semantics?.origin ?? "migration",
          kind: cloned.info.semantics?.kind ?? "system_reminder",
          ...(cloned.info.semantics?.source ? { source: cloned.info.semantics.source } : {}),
          uiVisibility: "hidden" as const,
          providerVisibility: "visible" as const,
          transcriptVisibility: "hidden" as const,
        },
      },
    };
  });
  const clonedEntries = entries.map((entry) => cloneVerifierEntryForAtomicFork(entry, identities));
  const modelSelectionEntry = buildModelSelectionEntry(childSessionId, modelSelection);
  if (kind === "selection_side_chat") {
    copiedMessages.push(buildSelectionSideChatBoundary(runtime, childSessionId, modelSelection));
  } else {
    copiedMessages.push(
      ...buildAtomicForkNotice(runtime, {
        identities,
        modelSelection,
        executionState,
        sourceCommandId: options.sourceCommandId,
        targetMessageId: options.targetMessageId,
      }),
    );
  }
  // [契约] ack.result.type 按 kind 分流：side chat 与 fork 是两种命令事实。
  // [契约] commandId 与 sourceCommandId 必须同一个，否则幂等对不上。
  // [失败路径] revisionAtDecision 缺省 0，调用方未提供版本基线时不要猜。
  // [契约] metadata.forkOrigin 与 notice 的 forkOrigin 保持同构。
  // [失败路径] 缺 metadata 会让回放端无法判断这次 fork 的来源消息。
  const commandFact = options.commandFact ?? {
    parentSessionId: String(runtime.sessionId),
    sourceCommandId: options.sourceCommandId,
    ack: {
      commandId: options.sourceCommandId,
      status: "accepted" as const,
      revisionAtDecision: options.revisionAtDecision ?? 0,
      result: {
        type: kind === "selection_side_chat" ? "createSelectionSideSession" : "forkAssistant",
        sessionId: String(childSessionId),
      },
    },
    metadata: {
      forkOrigin: {
        parentSessionId: String(runtime.sessionId),
        targetMessageId: String(options.targetMessageId),
      },
      ...(options.target ? { forkTarget: options.target } : {}),
    },
  };
  // [契约] 只有普通 fork 且 boundary 为 snapshot 才提交 goal。
  // [失败路径] side chat 提交 goal 会让副屏继承父目标与验证记录。
  // [契约] status 沿用快照 status，重推只在 legacy 路径做。
  // [失败路径] 在此重推会让 stable 路径多一次不必要的状态推导分歧。
  const goal =
    kind !== "selection_side_chat" && options.goalBoundary.kind === "snapshot"
      ? {
          source: remapGoalForFork(options.goalBoundary.target, identities),
          status: options.goalBoundary.target.status,
        }
      : undefined;
  // 唯一事务边界：child/messages/parts/entries/goal/commandFact 要么全成、要么全无；
  // 失败时父会话完全不受影响（这是 stable 与 legacy 的核心差异）。
  // [事务] 唯一事务边界：child/messages/parts/entries/goal/commandFact 全成或全无。
  // [契约] copySources 是「新 id → 旧 id」反向表，与 identity map 方向相反。
  // [失败路径] 写反会让 store 复制不到内容，child 消息体为空。
  // [契约] executionState entry 必须进同一 bundle，冷恢复首屏才有正确模式/权限。
  // [失败路径] 单独补写 executionState 会留下「已可见但无执行态」的窗口。
  // [契约] initialInput 仅在编辑重发场景透传，普通 fork 不提交。
  const committedChild = await store.commitForkBundle({
    child: buildForkedSessionInput(runtime, options.parentSession, childSessionId, kind),
    messages: copiedMessages,
    // copySources 是"新 id → 旧 id"的反向表(store 侧按它复制大字段/内容),
    // 与 identity map 的方向相反,不要写反。
    copySources: {
      messages: Object.fromEntries(
        [...identities.messageIds].map(([source, target]) => [target, source]),
      ),
      parts: Object.fromEntries(
        [...identities.partIds].map(([source, target]) => [target, source]),
      ),
    },
    // 选型 entry 与 child/message/verifier 同事务提交；否则 child 首次注册能读到
    // 运行态，冷恢复却会回到 workspace 默认 thought。entry 的磁盘包装由 adapter 负责。
    // Plan 必须与权限一并进入原子的 child bundle，不能只复制创建时的旧 permission。
    entries: [
      ...clonedEntries.map((item) => item.entry),
      modelSelectionEntry,
      buildExecutionStateEntry(childSessionId, executionState),
    ],
    ...(goal ? { goal } : {}),
    ...(options.initialInput ? { initialInput: options.initialInput } : {}),
    commandFact,
  });
  const forkedSessionId = committedChild.id;
  if (kind !== "selection_side_chat") {
    // 父会话的 SessionForked 事件是**提交后 best-effort**:
    // 子会话已经 durable,事件写失败只会让父会话少一条引用记录,
    // 不能让整个 fork 因为"通知失败"而回滚/报错。
    // [失败路径] 父会话 SessionForked 是提交后 best-effort：子会话已 durable。
    // [契约] 事件写失败只 warn，不能让整个 fork 回滚或报错。
    // [契约] forkPoint 用 options.messages.length（原始长度），与复制条数一致。
    // [失败路径] 用裁剪后的长度会让父会话的分叉点偏移。
    // [契约] strategy 固定 ForkRequired，与 file-rewind 策略区分。
    const forkedEvent = runtime.createEvent(
      SessionEventType.SessionForked,
      {
        originalSessionId: runtime.sessionId,
        forkedSessionId,
        forkPoint: options.messages.length,
        targetMessageId: options.targetMessageId,
        restoredFileCount: 0,
        strategy: RewindStrategy.ForkRequired,
      },
      options.traceContext,
    );
    try {
      await runtime.appendEvent(forkedEvent, options.traceContext);
    } catch (error) {
      runtime.logger?.warn("Parent fork event append failed after durable fork commit", {
        ...traceContextToLogContext(options.traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "session.fork.parent_event.failed_after_commit",
        forkedSessionId,
        module: "core.runtime",
        parentSessionId: runtime.sessionId,
      });
    }
  }
  return {
    copiedMessageCount: options.messages.length,
    forkedSessionId,
    parentSessionId: runtime.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles: [],
    response:
      kind === "selection_side_chat"
        ? `Created selection side chat ${forkedSessionId}.`
        : `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${options.messages.length} messages.`,
  };
}

/**
 * 副屏创建使用父 active transcript 的稳定落盘边界。正在生成时只保留已提交的本轮
 * real-user input，排除其后的 assistant/tool 增量；goal、queue 与阻塞运行态不复制。
 */
// [契约] sourceCommandId 非空是 V4 幂等身份，空值会让重试产生第二个 side chat。
// [失败路径] 缺 commitForkBundle 直接拒绝，不降级成逐条写。
// [契约] goalBoundary 固定 none：副屏不复制 goal/verifier。
// [失败路径] 传 snapshot 会让 side chat 意外继承父目标。
// [契约] 历史取 active transcript 的稳定落盘边界，不含在途增量。
export async function createSelectionSideConversation(
  this: AgentRuntimeInternal,
  options: SelectionSideChatCreateOptions,
): Promise<WorkspaceForkResult> {
  // sourceCommandId 是 V4 幂等身份：空值会让重试产生第二个 side chat，
  // 且 commandFact 无法与命令事实对上，所以直接拒绝。
  if (!options.sourceCommandId.trim()) {
    throw stableForkError("Selection side chat sourceCommandId must not be empty");
  }
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Selection side chat requires commitForkBundle");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const history = selectionSideChatHistoryMessages(activeMessages, this.activeTurn?.turnId);
  const targetMessageId = history.at(-1)?.info.id ?? createMessageId();
  return await commitAtomicConversationFork(this, {
    modelSelection: options.modelSelection,
    goalBoundary: { kind: "none" },
    kind: "selection_side_chat",
    messages: history,
    parentSession,
    revisionAtDecision: options.revisionAtDecision,
    sourceCommandId: options.sourceCommandId,
    targetMessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

// [契约] 无 active turn = 稳定态，整段 active transcript 可复制。
// [失败路径] 有 active turn 却不截断，会把未提交的 assistant/tool 增量复制成半轮历史。
// [契约] 优先停在 active turn 的 real-user 输入之后：本轮唯一已提交的用户事实。
// [失败路径] 找不到 real-user（steer/系统触发）时退回本轮起点之前。
// [契约] 返回新数组或切片，不修改入参。
// [失败路径] 用 findLastIndex 会受历史里旧 turn 的同 id 干扰。
export function selectionSideChatHistoryMessages(
  activeMessages: readonly MessageWithParts[],
  activeTurnId?: TurnId,
): MessageWithParts[] {
  // 无 active turn = 稳定态，整段 active transcript 均可参与；有 active turn 时必须截断，
  // 否则会把尚未提交的 assistant/tool 增量复制进 child，形成半轮历史。
  if (!activeTurnId) return [...activeMessages];
  // 优先停在 active turn 的 real-user 输入之后：这是本轮唯一已提交的用户事实；
  // 找不到 real-user（本轮由 steer/系统触发）则退回本轮起点之前，两种情况都不含在途增量。
  const activeUserIndex = activeMessages.findIndex(
    (message) =>
      message.info.role === "user" &&
      message.info.anchor?.turnId === activeTurnId &&
      message.info.anchor.origin === "realUser",
  );
  if (activeUserIndex >= 0) return activeMessages.slice(0, activeUserIndex + 1);
  const activeTurnStart = activeMessages.findIndex(
    (message) => message.info.anchor?.turnId === activeTurnId,
  );
  return activeTurnStart >= 0 ? activeMessages.slice(0, activeTurnStart) : [...activeMessages];
}

// [契约] 该函数只服务 legacy workspace/checkpoint fork，V4 stable 不得调用。
// [失败路径] stableForkMetadata 分支缺原子原语时抛错，而不是退回 createSession。
// [契约] 无 sessionStore 时抛 ConfigurationError，recoverable=true 供上层提示重试。
// [失败路径] 该入口不写 executionState 的事务版本，稳定路径必须绕开它。
// [权衡] 同时支持稳定元数据与普通创建，用入参是否带 metadata 分流。
export async function createForkedSession(
  runtime: AgentRuntimeInternal,
  options: {
    parentSession: SessionInfo;
    forkedSessionId?: SessionId;
    stableForkMetadata?: StableConversationForkChildMetadata;
  },
): Promise<SessionId> {
  if (!runtime.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
  }

  const forkedSessionId = options.forkedSessionId ?? createSessionId();
  const input = buildForkedSessionInput(runtime, options.parentSession, forkedSessionId);
  // legacy workspace fork 兼容分支。V4 stable/compact-edit 入口直接构建完整 bundle，
  // 不得经过这里的 child-only metadata 原语，否则会重新引入逐条补写窗口。
  if (options.stableForkMetadata) {
    if (!runtime.sessionStore.createForkedSessionWithMetadata) {
      throw stableForkError("Stable fork requires atomic child metadata persistence", {
        forkedSessionId,
        sourceCommandId: options.stableForkMetadata.sourceCommandId,
      });
    }
    const persisted = await runtime.sessionStore.createForkedSessionWithMetadata(
      input,
      options.stableForkMetadata,
    );
    return persisted.id;
  } else {
    await runtime.sessionStore.createSession(input);
  }

  // 执行态 entry 在 child 创建之后单独补写：此窗口内 child 已可见但执行态未落库，
  // 是 legacy 非原子路径的已知缺口；stable 路径必须由 commitForkBundle 一次提交。
  await runtime.sessionStore.saveSessionEntry?.(
    buildExecutionStateEntry(forkedSessionId, readRuntimeExecutionState(runtime)),
  );
  return forkedSessionId;
}

/** legacy workspace/checkpoint fork；V4 stable 与 compact-edit 禁止调用。 */
// [契约] legacy 入口：逐条写，允许任意历史点复制，非原子。
// [失败路径] 中途失败会留下半成品子会话，调用方必须按「可能已创建」处理。
// [契约] beforeTarget=true 表示编辑重发，只复制目标输入之前的前缀。
// [失败路径] 该入口不读 goal boundary，goal 复制走 copyGoalStateForFork 独立写入。
// [契约] 返回值 response 是给 UI 的文案，不参与幂等判断。
export async function forkConversationFromMessage(
  this: AgentRuntimeInternal,
  options: {
    forkedSessionId?: SessionId;
    targetMessageId: MessageId;
    traceContext: TraceContext;
    beforeTarget?: true;
  },
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
  }

  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: {
        sessionId: this.sessionId,
      },
      recoverable: true,
    });
  }

  const parentMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  // fork 会在编辑重发和压缩后发生，复制源必须是 UI transcript 语义。
  // activeSessionMessages 是模型恢复语义，会按 compact boundary 截掉旧 worklog；
  // fork child 需要保留 fork 点前可见历史，但仍要排除 rewind/edit 后的旧分支。
  const forkSourceMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const targetIndex = forkSourceMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    throw stableForkError(
      `Fork target message not found in session store: ${options.targetMessageId}`,
      { messageId: options.targetMessageId },
    );
  }

  // legacy 路径固定 expandAssistantTurn=true：按 parentID 向后扩张同回合 assistant，
  // 否则会把切点落在工具轮中间，child 首屏缺半轮。stable 路径改用 resolver 的
  // orderedMessageIds 严格连续片段，不再需要这套启发式。
  const legacyForkHistoryEndIndex = resolveForkHistoryEndIndex(
    forkSourceMessages,
    targetIndex,
    true,
  );
  // beforeTarget（编辑重发）只复制目标输入之前的前缀：目标输入本身由调用方以
  // initialInput 重新提交，若连它一起复制，child 会出现重复的用户气泡。
  // [契约] beforeTarget（编辑重发）只复制目标输入之前的前缀。
  // [失败路径] 连目标输入一起复制会让 child 出现重复用户气泡。
  // [契约] 非 beforeTarget 走 buildForkHistoryMessages，按 parentID 扩张回合。
  // [失败路径] 两条路径共用同一 endIndex 会让编辑重发多带半轮。
  const forkHistoryMessages = options.beforeTarget
    ? conversationHistoryBeforeInput(forkSourceMessages, options.targetMessageId)
    : buildForkHistoryMessages(
        parentMessages,
        forkSourceMessages,
        targetIndex,
        legacyForkHistoryEndIndex,
      );

  const forkedSessionId = await createForkedSession(this, {
    forkedSessionId: options.forkedSessionId,
    parentSession,
  });
  const { copiedMessageCount, messageIdMap } = await this.copySessionMessagesForFork({
    forkedSessionId,
    messages: forkHistoryMessages,
    traceContext: options.traceContext,
  });
  await copyGoalStateForFork.call(this, {
    forkedSessionId,
    messageIdMap,
    traceContext: options.traceContext,
  });
  // 纯对话 fork 没有 workspace checkpoint，但 UI 仍需要一条结构化 fork notice 渲染分割线。
  // 之前只复制历史消息，导致 forked session 首屏看不到来源边界。
  const copiedTargetMessageId = messageIdMap.get(options.targetMessageId);
  const forkTimelineCreated = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: forkedSessionId,
    messageID: createMessageId(),
    partID: createPartId(
      `fork_${String(this.sessionId)}_${String(options.targetMessageId)}_timeline`,
    ),
    parentID: copiedTargetMessageId,
    created: forkTimelineCreated,
    completed: forkTimelineCreated,
    finish: "completed",
    timeline: {
      timelineType: "session_fork",
      display: "separator",
      status: "completed",
      anchorMessageId: copiedTargetMessageId,
      parentSessionId: this.sessionId,
      targetMessageId: options.targetMessageId,
      restoredFileCount: 0,
      time: {
        start: forkTimelineCreated,
        end: forkTimelineCreated,
      },
    },
    traceContext: options.traceContext,
  });
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: forkedSessionId,
    source: "fork",
    text: formatConversationForkNoticeBody({
      parentSessionId: this.sessionId,
      targetMessageId: options.targetMessageId,
    }),
    metadata: {
      forkContext: {
        kind: "session_fork",
        parentSessionId: this.sessionId,
        targetMessageId: options.targetMessageId,
        restoredFileCount: 0,
      },
    },
    traceContext: options.traceContext,
  });
  this.logger?.debug("Conversation fork notice persisted", {
    ...traceContextToLogContext(options.traceContext),
    event: "session.fork.notice.persisted",
    forkedSessionId,
    module: "core.runtime",
    parentSessionId: this.sessionId,
    status: "completed",
    targetMessageId: options.targetMessageId,
  });

  const forkedEvent = this.createEvent(
    SessionEventType.SessionForked,
    {
      originalSessionId: this.sessionId,
      forkedSessionId,
      forkPoint: legacyForkHistoryEndIndex,
      targetMessageId: options.targetMessageId,
      restoredFileCount: 0,
      strategy: RewindStrategy.ForkRequired,
    },
    options.traceContext,
  );
  // legacy 在父会话发 SessionForked，失败直接抛给调用方：与 stable 路径的
  // 提交后 best-effort 不同，这里事件缺失会让父会话 UI 完全不知道 child 已存在。
  await this.appendEvent(forkedEvent, options.traceContext);

  return {
    copiedMessageCount,
    forkedSessionId,
    parentSessionId: this.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles: [],
    response: `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${copiedMessageCount} messages.`,
  };
}

/** V4 running stable fork 公共入口：纯 transcript copy，不读取/恢复 workspace checkpoint。 */
// [契约] 只复制 transcript，不读 workspace checkpoint、不回退文件。
// [失败路径] fork 顺手改用户工作区会与 rewind/file-rewind 职责冲突。
// [契约] sourceCommandId 非空校验与 side chat 同规则。
// [契约] targetMessageId 取 boundaryMessageId，必须已在 ordered 末位。
// [失败路径] 若取 ordered[0]，会把分叉点前移到 segment 开头。
export async function forkStableConversationAtMessage(
  this: AgentRuntimeInternal,
  options: StableConversationForkOptions,
): Promise<WorkspaceForkResult> {
  if (!options.sourceCommandId.trim()) {
    throw stableForkError("Stable fork sourceCommandId must not be empty");
  }
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Stable fork requires commitForkBundle");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  // stable fork 只复制 transcript，不读 workspace checkpoint、不回退文件：
  // 文件级回退由 rewind/file-rewind 独立承担，fork 不应顺手改动用户工作区。
  const history = stableForkHistoryMessages(activeMessages, options.target);
  return await commitAtomicConversationFork(this, {
    modelSelection: options.modelSelection,
    forkedSessionId: options.forkedSessionId,
    goalBoundary: options.goalBoundary,
    messages: history,
    parentSession,
    revisionAtDecision: options.revisionAtDecision,
    sourceCommandId: options.sourceCommandId,
    target: options.target,
    targetMessageId: options.target.boundaryMessageId as MessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

/** compact-covered edit：复制目标真实用户输入之前的 active conversation prefix。 */
export async function forkConversationBeforeMessage(
  this: AgentRuntimeInternal,
  options: ConversationBeforeInputForkOptions,
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Fork requires a session adapter");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const prefix = conversationHistoryBeforeInput(activeMessages, options.targetMessageId);
  return await commitAtomicConversationFork(this, {
    commandFact: options.commandFact,
    modelSelection: options.modelSelection,
    forkedSessionId: options.forkedSessionId,
    goalBoundary: options.goalBoundary,
    initialInput: options.initialInput,
    messages: prefix,
    parentSession,
    sourceCommandId: options.sourceCommandId,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

export function conversationHistoryBeforeInput(
  activeMessages: readonly MessageWithParts[],
  targetMessageId: MessageId,
): MessageWithParts[] {
  const targetIndex = activeMessages.findIndex((message) => message.info.id === targetMessageId);
  // 目标必须存在于 active branch：已被 rewind/edit 裁掉的消息不能再当切点，
  // 否则 prefix 会把已废弃分支一并带进 child。
  if (targetIndex < 0) {
    throw stableForkError(`Fork target input not found: ${targetMessageId}`, {
      targetMessageId,
    });
  }
  const target = activeMessages[targetIndex];
  // 只有 user 输入能做 before-input 切点：assistant/notice 之前的 "prefix" 语义不成立，
  // 强行切会让 child 缺少用户提问却保留回答。
  if (target?.info.role !== "user") {
    throw stableForkError("Fork-before-input target is not a user message", {
      targetMessageId,
    });
  }
  return activeMessages.slice(0, targetIndex);
}

/**
 * stable resolver 已给出目标 product turn 的唯一 segment。core 保留 segment 起点前
 * 的 active transcript 前缀，并要求 ordered ids 在 active branch 中严格连续；不再按
 * parentID 或“同一 assistant turn”向 boundary 后扩张。
 */
// [契约] boundary 必须非空且等于 ordered 最后一个 id。
// [失败路径] 校验失败说明调用方传了过期或被裁剪的 target。
// [契约] 去重校验：重复 id 会让同一 message 映射到两个新 id，出现重影。
// [失败路径] 逐位连续性校验失败即抛错，宁可失败也不复制「看起来连续」的假历史。
// [契约] 保留 segment 起点之前的 active 前缀，再拼上选中 segment。
// [失败路径] 只返回 segment 会丢掉 fork 点之前的上下文。
export function stableForkHistoryMessages(
  activeMessages: readonly MessageWithParts[],
  target: StableConversationForkTarget,
): MessageWithParts[] {
  // 边界必须非空且等于 ordered 的最后一个：resolver 用"最后一个 id"表达 segment 终点，
  // 不成立说明调用方传入了过期或被裁剪过的 target。
  if (
    target.orderedMessageIds.length === 0 ||
    target.orderedMessageIds.at(-1) !== target.boundaryMessageId
  ) {
    throw stableForkError("Stable fork target has an invalid boundary", {
      boundaryMessageId: target.boundaryMessageId,
    });
  }
  // 去重校验：重复 id 会让同一 message 在 clone 时被映射到两个新 id，
  // 复制结果出现重影且 part 归属错乱。
  if (new Set(target.orderedMessageIds).size !== target.orderedMessageIds.length) {
    throw stableForkError("Stable fork target contains duplicate message ids");
  }

  const indexById = new Map(
    activeMessages.map((message, index) => [String(message.info.id), index]),
  );
  const segmentStartIndex = indexById.get(target.orderedMessageIds[0]!);
  if (segmentStartIndex === undefined) {
    throw stableForkError("Stable fork target is not an active transcript segment", {
      messageId: target.orderedMessageIds[0],
    });
  }
  // 逐位比对 active branch 的严格连续性：中间若被 rewind/edit 插入别的消息，
  // 说明 segment 已被裁剪破坏；直接失败好过复制一段"看起来连续"的假历史。
  for (const [offset, messageId] of target.orderedMessageIds.entries()) {
    const actual = activeMessages[segmentStartIndex + offset];
    if (String(actual?.info.id) !== messageId) {
      throw stableForkError("Stable fork target is not a contiguous active transcript segment", {
        messageId,
      });
    }
  }
  const selectedSegment = activeMessages.slice(
    segmentStartIndex,
    segmentStartIndex + target.orderedMessageIds.length,
  );
  const boundary = selectedSegment.at(-1);
  // 边界必须是完成且无错误的 assistant：fork 点落在失败/中断的回复上，
  // child 会继承一条没有有效产出的半轮上下文，后续模型会误以为该轮已结束。
  if (boundary?.info.role !== "assistant" || boundary.info.error) {
    throw stableForkError("Stable fork boundary is not a completed assistant message", {
      boundaryMessageId: target.boundaryMessageId,
    });
  }
  return [...activeMessages.slice(0, segmentStartIndex), ...selectedSegment];
}

// [契约] store 不支持 cloneTargetForFork 时静默跳过：goal 复制是可选增强。
// [失败路径] 跳过时 child 没有 goal 事实，读取端必须按「无 target」处理。
// [契约] boundary=none 表示调用方明确不复制，不能回落读父 target。
// [失败路径] 回落会让 side chat 意外继承父会话目标与验证记录。
// [契约] snapshot 的 sessionID 必须等于当前父会话，跨会话快照直接抛错。
// [失败路径] 照抄跨会话快照会把别的会话 goal 搬进本 child。
export async function copyGoalStateForFork(
  this: AgentRuntimeInternal,
  options: {
    forkedSessionId: SessionId;
    goalBoundary?: StableConversationForkGoalBoundary;
    messageIdMap: Map<MessageId, MessageId>;
    traceContext: TraceContext;
  },
): Promise<void> {
  const sessionStore = this.sessionStore;
  // store 不支持 goal clone 时静默跳过：goal 复制是可选增强，缺它不应阻断 fork；
  // 但 child 此时没有任何 goal 事实，读取端必须按"无 target"处理。
  if (!sessionStore?.cloneTargetForFork) {
    return;
  }

  // none = 调用方明确声明不复制 goal（selection side chat）：跳过而不是回落读父 target，
  // 否则 side chat 会意外继承父会话的目标与验证记录。
  if (options.goalBoundary?.kind === "none") {
    return;
  }

  const parentTarget =
    options.goalBoundary?.kind === "snapshot"
      ? options.goalBoundary.target
      : await sessionStore.readTarget({ sessionID: this.sessionId });
  if (!parentTarget) return;
  // snapshot 自带 sessionID，必须与当前父会话一致：跨会话快照说明调用方拼错了历史，
  // 照抄会把这个会话的 goal 搬进另一个会话的 child。
  if (
    options.goalBoundary?.kind === "snapshot" &&
    String(parentTarget.sessionID) !== String(this.sessionId)
  ) {
    throw stableForkError("Stable fork goal snapshot belongs to another session", {
      goalSessionId: parentTarget.sessionID,
      parentSessionId: this.sessionId,
    });
  }

  // 先复制 verifier entries 再 cloneTarget：child 的 goal 状态要靠复制过来的验证记录
  // 推导，顺序反了会在推导时读不到刚写入的 entry（legacy 非事务路径的时序约束）。
  const copiedVerificationPayloads = await copyGoalVerificationEntriesForFork(sessionStore, {
    forkedSessionId: options.forkedSessionId,
    messageIdMap: options.messageIdMap,
    parentSessionId: this.sessionId,
    parentTargetId: parentTarget.targetID,
    ...(options.goalBoundary?.kind === "snapshot"
      ? {
          verificationEntryIds: new Set(options.goalBoundary.verificationEntryIds),
        }
      : {}),
  });
  // snapshot 场景直接沿用快照样本的 status；非 snapshot 必须按"实际复制过来的验证记录"
  // 重推，不能直接继承父会话当前 status（父会话可能已在此之后完成了目标）。
  const forkedStatus =
    options.goalBoundary?.kind === "snapshot"
      ? parentTarget.status
      : deriveForkedGoalStatusFromCopiedVerifications(
          parentTarget.status,
          copiedVerificationPayloads,
        );
  // cloneTargetForFork 是独立写入：失败时 child session 与消息已存在、目标却缺失。
  // 这是 legacy 路径的 best-effort 边界；stable 事务路径由 commitForkBundle 兜底。
  await sessionStore.cloneTargetForFork({
    sessionID: options.forkedSessionId,
    source: parentTarget,
    status: forkedStatus,
  });

  this.logger?.debug("Forked session goal state copied", {
    ...traceContextToLogContext(options.traceContext),
    copiedGoalVerificationCount: copiedVerificationPayloads.length,
    event: "session.fork.goal_state.copied",
    forkedSessionId: options.forkedSessionId,
    module: "core.runtime",
    parentSessionId: this.sessionId,
    targetId: parentTarget.targetID,
  });
}

// [失败路径] 无法枚举/写入 entry 时：无边界返回空；有边界必须报错。
// [契约] 静默返回空会让 boundary 引用的验证记录被无声丢弃。
// [失败路径] goal 状态随之归因到错误结论，且没有日志线索。
// [契约] remainingEntryIds 只有存在边界时才创建，legacy 路径走全量复制。
// [失败路径] legacy 全量复制时误用剩余集合会永远抛 missing entries。
async function copyGoalVerificationEntriesForFork(
  sessionStore: SessionStorePort,
  options: {
    forkedSessionId: SessionId;
    messageIdMap: Map<MessageId, MessageId>;
    parentSessionId: SessionId;
    parentTargetId: string;
    verificationEntryIds?: ReadonlySet<string>;
  },
): Promise<TargetCompletionVerificationPayload[]> {
  // 无法枚举/写入 entry 时：无边界要求（legacy）返回空即可；有边界要求（stable）
  // 必须报错，否则 boundary 引用的验证记录会被无声丢弃。
  if (!sessionStore.sessionEntries || !sessionStore.saveSessionEntry) {
    if (options.verificationEntryIds?.size) {
      throw stableForkError("Stable fork verifier boundary cannot be loaded", {
        verificationEntryIds: [...options.verificationEntryIds],
      });
    }
    return [];
  }

  const parentEntries = await sessionStore.sessionEntries({
    sessionID: options.parentSessionId,
    type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  });
  const copiedPayloads: TargetCompletionVerificationPayload[] = [];
  const remainingEntryIds = options.verificationEntryIds
    ? new Set(options.verificationEntryIds)
    : null;
  for (const parentEntry of parentEntries) {
    if (options.verificationEntryIds && !options.verificationEntryIds.has(parentEntry.id)) {
      continue;
    }
    remainingEntryIds?.delete(parentEntry.id);
    const cloned = cloneGoalVerificationEntryForFork(parentEntry, options);
    if (!cloned) {
      if (options.verificationEntryIds) {
        throw stableForkError("Stable fork verifier is outside the fixed transcript cut", {
          verificationEntryId: parentEntry.id,
        });
      }
      continue;
    }
    await sessionStore.saveSessionEntry(cloned.entry);
    copiedPayloads.push(cloned.payload);
  }
  // 走完父 entries 仍有剩余 = boundary 与 store 不一致（entry 被删或尚未落盘）。
  // 必须报错：静默容忍会让 child 缺失验证记录，goal 状态归因到错误结论。
  if (remainingEntryIds?.size) {
    throw stableForkError("Stable fork verifier boundary references missing entries", {
      verificationEntryIds: [...remainingEntryIds],
    });
  }
  return copiedPayloads;
}

// [契约] targetId 不匹配父 target 直接返回 null（不属于本次 goal）。
// [契约] anchor assistant 在 fork 点之后（未复制）时跳过：正确的历史边界过滤。
// [失败路径] 强行复制会生成指向不存在 child 消息的 anchor。
// [契约] anchorTurnId 恒降级为 originAnchorTurnId：child 不存在父轮次。
// [失败路径] 保留 anchorTurnId 会让读取端按父轮次定位而找不到。
// [契约] eventId 重新生成，避免与父 entry 的幂等键冲突。
function cloneGoalVerificationEntryForFork(
  entry: SessionEntryInfo,
  options: {
    forkedSessionId: SessionId;
    messageIdMap: Map<MessageId, MessageId>;
    parentTargetId: string;
  },
): { entry: SessionEntryInfo; payload: TargetCompletionVerificationPayload } | null {
  const data = asRecord(entry.data);
  const payload = asRecord(data.payload);
  if (payload.targetId !== options.parentTargetId) {
    return null;
  }
  const anchorAssistantMessageId =
    typeof payload.anchorAssistantMessageId === "string"
      ? (payload.anchorAssistantMessageId as MessageId)
      : null;
  // anchor 在场但不在 messageIdMap = 被验证的 assistant 在 fork 点之后（未复制）：
  // 这是 fork 历史边界过滤，正确跳过——child 只继承 fork 点前的 verifier timeline。
  if (anchorAssistantMessageId && !options.messageIdMap.has(anchorAssistantMessageId)) {
    return null;
  }
  const childAnchorAssistantMessageId = anchorAssistantMessageId
    ? options.messageIdMap.get(anchorAssistantMessageId)
    : undefined;

  // legacy entry 无 anchor 时不再整条静默跳过——verifier
  // 事实仍复制（无法按 anchor 判边界，宁可保留供溯源），本地 anchor 缺省、读取端
  // 按「无 anchor 落已知末尾」处理。anchorTurnId 指向父 runtime turn（child 不存在
  // 该轮），恒降级 originAnchorTurnId。
  const clonedPayloadRecord: Record<string, unknown> = { ...payload };
  if (childAnchorAssistantMessageId) {
    clonedPayloadRecord.anchorAssistantMessageId = childAnchorAssistantMessageId;
  }
  if (typeof payload.anchorTurnId === "string") {
    delete clonedPayloadRecord.anchorTurnId;
    clonedPayloadRecord.originAnchorTurnId = payload.anchorTurnId;
  }
  const clonedPayload = clonedPayloadRecord as unknown as TargetCompletionVerificationPayload;
  const eventId = randomUUID();
  return {
    entry: {
      ...entry,
      id: `fork_goal_verify_${eventId}`,
      sessionID: options.forkedSessionId,
      // verifier entry 是 goal iteration 的持久边界；fork 后必须复制到
      // child session，并把 anchor assistant 改写为 child message id，避免 UI 恢复时丢分割线。
      data: {
        ...data,
        eventId,
        payload: clonedPayload,
      },
    },
    payload: clonedPayload,
  };
}

// [契约] 最新一条 completed 且 passed 才算 complete。
// [失败路径] 父 complete 但 child 无通过验证 → 降级 active，要求重新验证。
// [契约] 其余情况沿用父 status；不能继承未经证明的完成态。
// [失败路径] 直接返回父 status 会让 child 凭空获得完成态。
// [契约] 只反向扫描一次，取第一条 completed；更旧记录不参与。
export function deriveForkedGoalStatusFromCopiedVerifications(
  parentStatus: GoalStatus,
  copiedVerificationPayloads: readonly TargetCompletionVerificationPayload[],
): GoalStatus {
  // 子会话的 goal 状态必须由"复制过来的验证记录"重新证明:
  //   - 最新一条 completed 且 passed → complete;
  //   - 父会话是 complete 但子会话没有通过的验证 → 降级 active,
  //     要求子会话重新验证(不能继承一个未经证明的完成态)。
  const latestCompleted = [...copiedVerificationPayloads]
    .reverse()
    .find((payload) => payload.status === "completed" && payload.verification);
  if (latestCompleted?.verification?.passed === true) {
    return "complete";
  }
  if (parentStatus === "complete") {
    return "active";
  }
  return parentStatus;
}

// [契约] 复制源是 UI transcript 语义，不是模型恢复语义。
// [失败路径] 用 activeSessionMessages 会按 compact boundary 截掉旧 worklog，fork 丢历史。
// [契约] revert 字段统一交给 selectActiveConversationBranch 处理。
// [失败路径] 在本地再写一套 rewind 过滤会与 resume/冷投影产生分歧。
// [契约] 同时排除 rewind/edit 后的旧分支，保留 fork 点前可见内容。
export function forkSourceMessagesForSession(
  parentMessages: MessageWithParts[],
  parentSession: SessionInfo,
): MessageWithParts[] {
  // session.revert 记录了编辑重发/rewind 留下的旧分支:
  // branchCutAfterMessageID 表示"此消息之后的分支已废弃",keptMessageIDs 是
  // rewind 时保留的部分。纯选择器统一处理,保证 fork 与 resume/冷投影看到同一条活动链。
  return activeForkTranscriptMessages(parentMessages, {
    branchCutAfterMessageId: parentSession.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: parentSession.revert?.createdMessageID,
    rewindKeptMessageIds: parentSession.revert?.keptMessageIDs,
    rewindTargetMessageId: parentSession.revert?.targetMessageID,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function activeForkTranscriptMessages(
  messages: MessageWithParts[],
  options: {
    branchCutAfterMessageId?: MessageId;
    rewindCreatedMessageId?: MessageId;
    rewindKeptMessageIds?: readonly MessageId[];
    rewindTargetMessageId?: MessageId;
  } = {},
): MessageWithParts[] {
  // fork 保留完整可见 transcript（不做 compact provider scope 裁剪），但 rewind
  // branch 与 runtime resume / cold projection 必须使用同一纯选择器。
  return selectActiveConversationBranch(messages, options);
}

export function resolveForkHistoryEndIndex(
  messages: MessageWithParts[],
  targetIndex: number,
  expandAssistantTurn: boolean,
): number {
  const target = messages[targetIndex];
  if (!expandAssistantTurn || target?.info.role !== "assistant") {
    return targetIndex + 1;
  }

  // legacy fork 默认 expandAssistantTurn=true:一个 user 输入可能对应多条
  // assistant 消息(工具轮/续写),它们共享同一个 parentID。fork 到其中一条时
  // 必须把同一 parent 的后续 assistant 一起带上,否则会切在回合中间。
  const parentId = target.info.parentID;
  let endIndex = targetIndex + 1;
  for (let index = targetIndex + 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.info.role !== "assistant" || message.info.parentID !== parentId) {
      break;
    }
    endIndex = index + 1;
  }
  return endIndex;
}

function isActiveCompactionBoundaryMessage(message: MessageWithParts): boolean {
  // 命中 compactBoundary 标记、或未带 timelineStatus 的 compaction part 才算"活跃边界"；
  // 已完成的 compact 只是历史卡片，拿它当 fork/恢复的截断点会丢掉真实上下文。
  return message.parts.some(
    (part) => part.type === "compaction" && (Boolean(part.compactBoundary) || !part.timelineStatus),
  );
}

// [契约] synthetic/model-only/带 source/带 summary 的 user 都不是用户说过的话。
// [失败路径] 用系统文本冒充用户历史会让 child 的模型上下文失真。
// [契约] 活跃 compaction boundary 消息同样被排除。
// [失败路径] 把 summary 当真实输入会让 fork 历史出现重复的压缩摘要。
function isRealVisibleUserMessage(message: MessageWithParts): boolean {
  // 只认真实可见的用户输入：synthetic（notice/reminder）、model-only、带 source 或
  // summary 的 user 都不是"用户说过的话"，拿它当 fork 父消息会把系统文本冒充成用户历史。
  return (
    message.info.role === "user" &&
    message.info.synthetic !== true &&
    message.info.visibility !== "model-only" &&
    !message.info.source &&
    !message.info.summary &&
    !isActiveCompactionBoundaryMessage(message)
  );
}

function findCompactedForkParentUserMessage(
  parentMessages: MessageWithParts[],
  forkHistoryMessages: MessageWithParts[],
  target: MessageWithParts | undefined,
): MessageWithParts | undefined {
  // 只在"目标 assistant 的真实 user 父消息被 compact 挤掉"时返回该 user 消息:
  //   - 目标不是 assistant / 没有 parentID → 不适用;
  //   - 父消息已经在 fork 历史里 → 不需要补;
  //   - fork 历史里没有 compaction boundary → 说明不是压缩场景,不乱插;
  //   - 父消息必须是真实可见的 user(synthetic/attachment/summary 都不算)。
  if (target?.info.role !== "assistant") {
    return undefined;
  }
  const parentMessageId = target.info.parentID;
  if (
    !parentMessageId ||
    forkHistoryMessages.some((message) => message.info.id === parentMessageId)
  ) {
    return undefined;
  }
  if (!forkHistoryMessages.some(isActiveCompactionBoundaryMessage)) {
    return undefined;
  }

  const parentUserMessage = parentMessages.find((message) => message.info.id === parentMessageId);
  return parentUserMessage && isRealVisibleUserMessage(parentUserMessage)
    ? parentUserMessage
    : undefined;
}

// [契约] compact 后 active branch 只剩 summary user + assistant，summary 会被 UI 过滤。
// [契约] 仅在「目标 assistant 的真实 user 父消息被 compact 挤掉」时补回该 user。
// [失败路径] 无条件补会把非压缩场景的历史顺序打乱。
// [契约] 补回后 resume 仍从最后一个 compact boundary 开始，模型上下文不变。
// [失败路径] 把补回的用户消息放在 boundary 之后会改变模型可见上下文。
// [契约] 补回位置固定在 compact boundary 之前。
export function buildForkHistoryMessages(
  parentMessages: MessageWithParts[],
  forkSourceMessages: MessageWithParts[],
  targetIndex: number,
  forkHistoryEndIndex: number,
): MessageWithParts[] {
  const forkHistoryMessages = forkSourceMessages.slice(0, forkHistoryEndIndex);
  const compactedParentUserMessage = findCompactedForkParentUserMessage(
    parentMessages,
    forkHistoryMessages,
    forkSourceMessages[targetIndex],
  );
  if (!compactedParentUserMessage) {
    return forkHistoryMessages;
  }

  // compact 后 active branch 只剩 summary user + assistant，summary 会被 UI 过滤。
  // fork 到该 assistant 时仍要把它 parentID 指向的真实用户输入放回 compact boundary 前，
  // 这样历史可见气泡不丢，同时 resume 仍从最后一个 compact boundary 开始，不改变模型上下文。
  return [compactedParentUserMessage, ...forkHistoryMessages];
}
