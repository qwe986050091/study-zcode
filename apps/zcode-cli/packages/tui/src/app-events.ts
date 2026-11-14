// INV-01 单一归约入口：事件到状态的映射只存在于 applySessionEventToState；在组件里另写一份会让同一事件双写，状态在两侧来回跳。
// INV-02 只写状态：switch 内只允许调用 handlers 的 setter 或同目录 reducer；在此发起请求或落盘，事件重放会产生重复外部副作用。
// INV-03 payload 归一化：入口用 asRecord 统一转换一次；绕过它直接读原始 payload 字段，形状异常会抛错并中断整条事件流。
// INV-04 [权衡] default 静默忽略：该分支必须保持空；补日志或提示会让版本错配时每个未知事件都刷屏。
// INV-05 新事件必须显式登记：缺 case 的事件落进 default 被吞，如 DynamicWorkflowRunProgress 漏登记则运行态永不更新。
// INV-06 turnId 成对：TurnStarted 写入、TurnComplete 清空；漏清会让下一轮被判为进行中，输入被永久排队。
// INV-07 [失败路径] 排队输入清理：TurnComplete、TurnError、ModelError、SessionResumed 都要清 queuedInputs；漏清会残留幽灵待发计数。
// INV-08 压缩期错误分流：turnPhase 为 compact 时必须走 applyCompactTurnErrorEvent；错走普通分支会让压缩卡停在 running。
// INV-09 [失败路径] 可选 setter 一律带 ?.：setModifiedFiles、setQueuedInputs、setThoughtLevel、setWorkflowMirror 缺失时必须跳过而不是崩溃。
// INV-10 [并发] 跨事件 Map 就地更新：assistantMessageIdsByToolCallId 与 toolNamesById 只能 set 不能整体替换，换新 Map 会丢流式关联。
// INV-11 工具名兜底：toolLabel 的 payload 到缓存到 tool 三级顺序保证状态栏非空；删掉兜底会显示 undefined running。
// INV-12 先置完成态：applyToolResultEvent 在判 TodoWrite 之前先写 toolCompleted；提前返回会让状态栏永远停在 running。
// INV-13 [事务] todo 整批替换：仅当解析条数与原始条数相等才 setTodos；放宽会写入部分更新，列表增删跳动。
// INV-14 [并发] 文件统计去重：modifiedFileToolCallIds 记录已处理 toolCallId；去掉去重后重连重放会重复累加 diff。
// INV-15 空统计不写：stats 长度为 0 时直接返回；写入空数组会抹掉上一轮的修改文件列表。
// INV-16 错误不清空：成功事件不主动把 lastError 置空；新增清空会让错误提示瞬间消失，用户看不到失败原因。
// INV-17 文案取自 copy：状态栏文案统一走 copy.status，硬编码中文会同时破坏多语言与文案快照测试。
// INV-18 [权衡] todo 字段严格校验：parseTodoItem 校验 content、status、priority；放宽后渲染层会拿到非法枚举值。
//
// 模块职责：TUI 侧唯一的事件归约入口，把 SessionEvent 转成 React 状态更新，本身不发起 I/O、不落盘。
// 状态所有权：本模块不持有业务状态，全部写入通道由父层经 SessionEventHandlers 注入；仅两个跨事件 Map 就地共享。
// 阅读顺序：先看 SessionEventHandlers 的注入契约，再看 applySessionEventToState 的 switch，最后看各专用 reducer 的守卫。
// Session 事件 → TUI 状态的唯一归约入口（L2）。事件类型到状态更新的映射集中在此，
// 具体子逻辑（流式、工具卡、网络、turn 完成等）委托给同目录 app-*.ts 的专用 reducer。
// 不变量：只做 React 状态更新，不发请求、不落盘；未知事件类型走 default 静默忽略。
// 所有 payload 先 asRecord 归一化，字段缺失时由各 reducer 走"保持现状"路径。
import {
  SessionEventType,
  type ModelUsageSummary,
  type SessionEvent,
  type TodoItem,
  type TurnId,
} from "@zcode/contracts";
import type { TuiCopy } from "@zcode/i18n";
import type React from "react";
import type {
  CacheStats,
  ContextUsage,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
} from "./app-model.js";
import { contextWindowFromPayload, formatEventError, usageFromPayload } from "./app-event-data.js";
import { applyModelStreamingEvent } from "./app-model-streaming.js";
import {
  applyModifiedFileStats,
  modifiedFileStatsFromToolResultPayload,
} from "./app-modified-files.js";
import { applyModelNetworkEvent, applyNetworkRequestEvent } from "./app-network-events.js";
import { appendSystemErrorMessage } from "./app-transcript-errors.js";
import { applyTurnCompleteEvent, applyTurnCompleteFallbackResponse } from "./app-turn-complete.js";
import { applyToolTranscriptEvent } from "./app-tool-transcript.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { removeQueuedInputs, upsertQueuedInput } from "./app-queued-inputs.js";
import { applyCompactTimelineEvent, applyCompactTurnErrorEvent } from "./app-compact-timeline.js";
import { applyWorkflowProgressEvent, type WorkflowMirrorSetter } from "./app-workflow-events.js";
import { asRecord, formatNumber, numberField, stringField } from "./state.js";

// [状态] 这里只声明依赖，不创建状态：所有 setter 由父层传入，本模块拿到的是写入通道而不是数据本身。
// 新增字段时必须同步父层注入点，漏注入会在第一个用到它的事件上读到 undefined。
// 带 ? 的 setter 表示宿主可降级：缺 setModifiedFiles 就不显示 diff，缺 setQueuedInputs 就不刷排队条。
// [并发] assistantMessageIdsByToolCallId 与 toolNamesById 是跨事件可变 Map，生命周期必须覆盖整个 session。
// 若每次事件新建 Map，流式与工具卡会丢关联，表现为同一工具出现重复气泡或状态栏丢工具名。
// workspaceDirectory 只用于结果路径归一化，缺失时统计走原始路径而跨平台分隔符可能对不上。
//
// 归约所需的全部 setter 与跨事件可变缓存。全部由父层注入，本模块不持有状态。
type SessionEventHandlers = {
  // 当前活跃 turnId；TurnStarted 写入、TurnComplete 清空。
  setActiveTurnId: (turnId: TurnId | undefined) => void;
  // 缓存命中统计；TurnComplete 时整体替换。
  setCacheStats: React.Dispatch<React.SetStateAction<CacheStats | undefined>>;
  // 上下文用量（已用/窗口），逐字段合并更新。
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage>>;
  // 全局错误文案；各失败事件写入，成功事件不主动清空。
  setLastError: (message: string | undefined) => void;
  // 流式中的实时模型文本（未落定到消息前）。
  setLiveModelText: React.Dispatch<React.SetStateAction<string>>;
  // 转录消息列表（agent/tool/timeline/system 等）。
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  // 状态栏展示的模型标识（通常 "provider/model"）。
  setModel: (model: string) => void;
  // 推理强度；可选，缺失时忽略 ModelSelected 的该字段。
  setThoughtLevel?: (level: string) => void;
  // 修改文件统计；可选，缺失则跳过 diff 展示。
  setModifiedFiles?: React.Dispatch<React.SetStateAction<ModifiedFileStat[]>>;
  // 网络请求列表。
  setNetworkRequests: React.Dispatch<React.SetStateAction<NetworkRequest[]>>;
  // 排队待发输入；可选，缺失则排队 UI 不更新。
  setQueuedInputs?: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  // 状态栏文案。
  setStatus: (status: string) => void;
  // todo 列表（仅 TodoWrite 工具结果更新）。
  setTodos: React.Dispatch<React.SetStateAction<TodoItem[]>>;
  // 模型用量汇总。
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>;
  // workflow 运行态镜像 setter；可选。
  setWorkflowMirror?: WorkflowMirrorSetter;
  // toolCallId → 助手消息 id 的映射，流式归约使用（跨事件共享、就地更新）。
  assistantMessageIdsByToolCallId: Map<string, string>;
  // 已处理过文件统计的 toolCallId 集合，用于去重；可选。
  modifiedFileToolCallIds?: Set<string>;
  // toolCallId → 工具名缓存，补偿后续事件只有 id 的情况（就地更新）。
  toolNamesById: Map<string, string>;
  // 工作区根目录，用于把工具结果路径归一化后再统计；可选。
  workspaceDirectory?: string;
};

// [入口] 分发函数无状态且无缓存：同一事件重复投递得到同一状态而重放安全的前提是不在这里做累加。
// payload 先经 asRecord 归一化，后面所有 reducer 都只面对 Record 形态，不需要各自判空。
// [失败路径] copy 缺省用 DEFAULT_TUI_COPY 兜底，保证文案键缺失不抛错，只会回退英文。
// 分支顺序本身无副作用，但同类事件必须相邻：TurnError 与 ModelError 共用一段，避免两处逻辑漂移。
// [权衡] 巨型 switch 比映射表更好读：每个 case 的写入序列要能被一次扫读确认。
// 新增分支只允许调用 setter 或同目录 reducer，禁止在此等待任何异步操作。
// 状态写入是有序的：setStatus 与 setActiveTurnId 的先后影响渲染帧，改动前先确认 UI 取值时机。
//
// 按 event.type 分发。每个分支的副作用仅限于调用 handlers 提供的 setter；
// 可选 setter（setQueuedInputs/setModifiedFiles/setThoughtLevel/setWorkflowMirror）缺失时跳过对应更新。
// copy 提供用户可见文案，缺省英文兜底；未识别的类型不改变任何状态。
export function applySessionEventToState(
  event: SessionEvent,
  handlers: SessionEventHandlers,
  copy: TuiCopy = DEFAULT_TUI_COPY,
): void {
  const payload = asRecord(event.payload);

  switch (event.type) {
    case SessionEventType.SessionCreated:
      applySessionCreatedEvent(payload, handlers.setContextUsage);
      break;
    case SessionEventType.TurnStarted:
      handlers.setActiveTurnId(event.turnId);
      handlers.setStatus(copy.status.thinking);
      break;
    case SessionEventType.TurnComplete:
      applyTurnCompleteEvent(payload, handlers.setUsage, handlers.setCacheStats);
      applyTurnCompleteFallbackResponse(payload, handlers.setMessages);
      handlers.setStatus(copy.status.ready);
      handlers.setActiveTurnId(undefined);
      handlers.setQueuedInputs?.([]);
      break;
    case SessionEventType.TurnError:
    case SessionEventType.ModelError:
      // [事务] 压缩期的 turn 错误必须同时落到压缩卡与全局错误，只写一半会让卡片停在 running。
      // turnPhase 是唯一的阶段判据：不要用文案或错误码猜阶段，压缩失败与普通轮次失败的用户处置不同。
      // 压缩分支里的 break 不能省：落到下面的普通分支会追加第二条错误气泡，转录出现重复。
      // [失败路径] 两条分支都清空排队输入：本轮已死，残留待发会在下一轮被误执行。
      // 压缩失败用 copy.status.compactFailed，普通失败用 turnFailed，混用会让用户误判可重试性。
      // 若后续新增压缩子阶段，判据仍收敛在 turnPhase，不要在别处再分叉。
      //
      if (stringField(payload, "turnPhase") === "compact") {
        // 压缩阶段的 turn 错误要落到压缩卡上，不能只追加普通错误气泡，否则卡会停在 running。
        applyCompactTurnErrorEvent(payload, handlers.setLastError, handlers.setMessages);
        handlers.setStatus(copy.status.compactFailed);
        handlers.setQueuedInputs?.([]);
        break;
      }
      applyTurnErrorEvent(payload, handlers.setLastError, handlers.setMessages);
      handlers.setStatus(copy.status.turnFailed);
      // 本轮已终止，排队输入不会再被执行，直接清空避免残留计数。
      handlers.setQueuedInputs?.([]);
      break;
    case SessionEventType.TurnSteerQueued:
      applyTurnSteerQueuedEvent(payload, handlers.setQueuedInputs);
      break;
    case SessionEventType.TurnSteerDrained:
    case SessionEventType.TurnSteerDiscarded:
      applyTurnSteerFinishedEvent(payload, handlers.setQueuedInputs);
      break;
    case SessionEventType.AssistantMessage:
      applyAssistantMessageEvent(payload, handlers.setMessages);
      break;
    case SessionEventType.ModelRequest:
      handlers.setStatus(copy.status.modelCalling);
      break;
    case SessionEventType.ModelSelected:
      applyModelSelectedEvent(payload, handlers.setModel, handlers.setThoughtLevel);
      break;
    case SessionEventType.ModelStreaming:
      applyModelStreamingEvent(payload, {
        assistantMessageIdsByToolCallId: handlers.assistantMessageIdsByToolCallId,
        setLiveModelText: handlers.setLiveModelText,
        setMessages: handlers.setMessages,
        setStatus: handlers.setStatus,
      });
      break;
    case SessionEventType.StreamRecoveryStarted:
      handlers.setStatus(copy.status.recoveringStream);
      break;
    case SessionEventType.StreamRecoveryTailDiscarded:
      applyStreamRecoveryTailDiscardedEvent(handlers.setStatus, handlers.setLiveModelText, copy);
      break;
    case SessionEventType.StreamRecoveryRetryStarted:
      handlers.setStatus(copy.status.retryingStream);
      break;
    case SessionEventType.ModelComplete:
      applyModelCompleteEvent(
        payload,
        handlers.setUsage,
        handlers.setStatus,
        handlers.setContextUsage,
        copy,
      );
      break;
    case SessionEventType.ToolCallScheduled:
      rememberToolName(payload, handlers.toolNamesById);
      applyToolTranscriptEvent(event, handlers);
      handlers.setStatus(copy.status.toolPending(toolLabel(payload, handlers.toolNamesById)));
      break;
    case SessionEventType.ToolCallStarted:
    case SessionEventType.ToolCallProgress:
      rememberToolName(payload, handlers.toolNamesById);
      applyToolTranscriptEvent(event, handlers);
      handlers.setStatus(copy.status.toolRunning(toolLabel(payload, handlers.toolNamesById)));
      break;
    case SessionEventType.ToolCallResult:
      applyToolTranscriptEvent(event, handlers);
      applyModifiedFileDisplayEvent(payload, handlers);
      applyToolResultEvent(
        payload,
        handlers.toolNamesById,
        handlers.setTodos,
        handlers.setStatus,
        copy,
      );
      break;
    case SessionEventType.ToolCallError:
      applyToolTranscriptEvent(event, handlers);
      handlers.setStatus(copy.status.toolFailed(toolLabel(payload, handlers.toolNamesById)));
      // 工具失败既更新状态栏也写全局错误，保证用户能直接在提示区看到原因。
      handlers.setLastError(formatEventError(payload));
      break;
    case SessionEventType.NetworkRequestStatus:
      applyNetworkRequestEvent(payload, handlers.setNetworkRequests);
      break;
    case SessionEventType.ModelNetworkStatus:
      applyModelNetworkEvent(payload, handlers.setNetworkRequests, handlers.setStatus, copy);
      break;
    case SessionEventType.PermissionRequested:
      handlers.setStatus(
        copy.status.permissionRequested(stringField(payload, "toolName") ?? "tool"),
      );
      break;
    case SessionEventType.PermissionResolved:
      handlers.setStatus(
        copy.status.permissionResolved(stringField(payload, "toolName") ?? "tool"),
      );
      break;
    case SessionEventType.SessionResumed:
      handlers.setStatus(copy.status.sessionResumed);
      handlers.setQueuedInputs?.([]);
      break;
    case SessionEventType.SessionCompacted:
      handlers.setStatus(copy.status.compacted);
      break;
    case SessionEventType.CompactStarted:
      applyCompactTimelineEvent(payload, handlers.setMessages);
      handlers.setStatus(
        stringField(payload, "status") === "retrying"
          ? copy.transcript.compact.retrying({
              attempt: numberField(payload, "attempt") ?? 0,
              maxAttempts: numberField(payload, "maxAttempts") ?? 0,
            })
          : copy.status.compacting,
      );
      break;
    case SessionEventType.CompactCompleted:
      applyCompactTimelineEvent(payload, handlers.setMessages);
      handlers.setStatus(
        stringField(payload, "status") === "skipped"
          ? copy.transcript.compact.skipped
          : copy.status.compacted,
      );
      break;
    case SessionEventType.CompactFailed:
      applyCompactTimelineEvent(payload, handlers.setMessages);
      handlers.setStatus(copy.status.compactFailed);
      // 压缩失败原因可能只存在于 payload.reason，缺失时不覆盖已有错误文案。
      handlers.setLastError(stringField(payload, "reason"));
      break;
    case SessionEventType.TargetChanged:
      handlers.setStatus(copy.status.targetChanged(stringField(payload, "action") ?? "changed"));
      break;
    // [并发] workflow 镜像走外部 setter，事件顺序由服务端保证；本模块只转发，不排序也不合并。
    // 这个 case 是显式登记的样板：新事件若只加协议不加 case，会被默认分支静默吞掉。
    // 兜底分支必须保持空实现：任何兜底日志或提示都会在版本错配时刷屏。
    // [权衡] 静默忽略换来向前兼容，代价是漏 case 只能靠新增事件时的检查清单发现。
    // 排查状态不更新时，先确认事件类型是否已在 switch 中登记，再怀疑 reducer 内部。
    // 分支末尾统一 break，避免 fallthrough 让两个事件类型互相污染状态。
    //
    // dwf 实时运行态：缺此 case 时事件落进 default 被静默丢弃。归约走共享 reducer。
    case SessionEventType.DynamicWorkflowRunProgress:
      applyWorkflowProgressEvent(event.payload, handlers.setWorkflowMirror);
      break;
    default:
      break;
  }
}

// 排队输入入列：id 与文本任一缺失就忽略（事件可能只带预览字段）。
// preserveExistingText=true 表示后续事件不覆盖已存在的完整文本，避免预览覆盖正文。
function applyTurnSteerQueuedEvent(
  payload: Record<string, unknown>,
  setQueuedInputs?: React.Dispatch<React.SetStateAction<QueuedInput[]>>,
): void {
  if (!setQueuedInputs) return;

  const id = stringField(payload, "pendingInputId");
  const text = stringField(payload, "inputPreview") ?? stringField(payload, "input");
  if (!id || !text) return;

  setQueuedInputs((current) =>
    upsertQueuedInput(current, { id, text }, { preserveExistingText: true }),
  );
}

// drained/discarded 共用一个处理：按 pendingInputIds 批量移除；数组缺省为空则列表无变化。
function applyTurnSteerFinishedEvent(
  payload: Record<string, unknown>,
  setQueuedInputs?: React.Dispatch<React.SetStateAction<QueuedInput[]>>,
): void {
  if (!setQueuedInputs) return;
  setQueuedInputs((current) =>
    removeQueuedInputs(current, stringArrayField(payload, "pendingInputIds")),
  );
}

// 读取字符串数组字段：非数组或元素类型不符时直接返回空数组，调用方无需再做空值判断。
function stringArrayField(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

// 追加一条 agent 气泡；content 为空（纯工具调用消息）时忽略，不产生空气泡。
function applyAssistantMessageEvent(
  payload: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const content = stringField(payload, "content");
  if (!content) return;
  setMessages((current) => [
    ...current,
    {
      content,
      role: "agent",
    },
  ]);
}

// 记录全局错误并在转录中追加一条系统错误气泡（含可读文案）。
function applyTurnErrorEvent(
  payload: Record<string, unknown>,
  setLastError: (message: string | undefined) => void,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const message = formatEventError(payload);
  setLastError(message);
  setMessages((current) => appendSystemErrorMessage(current, message));
}

// 会话创建事件只补 contextWindow；字段缺失时保持原值，不重置已累计的 contextUsed。
function applySessionCreatedEvent(
  payload: Record<string, unknown>,
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage>>,
): void {
  const contextWindow = contextWindowFromPayload(payload);
  if (contextWindow === undefined) return;
  setContextUsage((current) => ({
    ...current,
    contextWindow,
  }));
}

// 模型选择事件：优先 modelSelection 的 providerId/modelId 拼成 "provider/model"；
// 缺少 modelId 时整体忽略（不写半截标识）；reasoningLevel 缺失写空串表示未知。
function applyModelSelectedEvent(
  payload: Record<string, unknown>,
  setModel: (model: string) => void,
  setThoughtLevel?: (level: string) => void,
): void {
  const modelSelection = asRecord(payload.modelSelection);
  const providerId = stringField(modelSelection, "providerId");
  const modelId =
    stringField(modelSelection, "modelId") ??
    stringField(modelSelection, "id") ??
    stringField(modelSelection, "model");
  if (!modelId) return;
  setModel(providerId ? `${providerId}/${modelId}` : modelId);
  setThoughtLevel?.(stringField(asRecord(modelSelection.options), "reasoningLevel") ?? "");
}

// 一次模型调用结束：更新 usage，并用 inputTokens 近似 contextUsed（仅 > 0 时更新）；
// 状态栏按是否有 usage 选择"带 token 数"或普通"已收到响应"文案。
function applyModelCompleteEvent(
  payload: Record<string, unknown>,
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>,
  setStatus: (status: string) => void,
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage>>,
  copy: TuiCopy,
): void {
  const nextUsage = usageFromPayload(payload);
  if (nextUsage) {
    setUsage(nextUsage);
    if (nextUsage.inputTokens > 0) {
      setContextUsage((current) => ({
        ...current,
        contextUsed: nextUsage.inputTokens,
      }));
    }
  }
  setStatus(
    nextUsage
      ? copy.model.responseReceivedWithTokens(formatNumber(nextUsage.totalTokens))
      : copy.model.responseReceived,
  );
}

// 流恢复丢弃尾部：清空实时文本，防止把半截内容继续拼到恢复后的流上。
function applyStreamRecoveryTailDiscardedEvent(
  setStatus: (status: string) => void,
  setLiveModelText: React.Dispatch<React.SetStateAction<string>>,
  copy: TuiCopy,
): void {
  setLiveModelText("");
  setStatus(copy.status.interruptedStreamDiscarded);
}

// 记住 toolCallId → toolName，供只带 id 的后续事件（progress/result/error）回显工具名。
// 就地写 Map（跨事件缓存），不是纯函数；调用方保证 Map 生命周期与 session 一致。
function rememberToolName(
  payload: Record<string, unknown>,
  toolNamesById: Map<string, string>,
): void {
  const toolCallId = stringField(payload, "toolCallId");
  const toolName = stringField(payload, "toolName");
  if (toolCallId && toolName) {
    toolNamesById.set(toolCallId, toolName);
  }
}

// 工具名展示口径：payload.toolName → 缓存表 → "tool" 兜底，保证状态栏永不为空。
function toolLabel(payload: Record<string, unknown>, toolNamesById: Map<string, string>): string {
  const toolCallId = stringField(payload, "toolCallId");
  return (
    stringField(payload, "toolName") ??
    (toolCallId ? toolNamesById.get(toolCallId) : undefined) ??
    "tool"
  );
}

// 工具结果：先统一写"已完成"状态；只有 TodoWrite 会尝试解析 result.content 里的 todos。
// 解析失败或结构不符时保持既有 todos（非 JSON 的工具输出是常态）。
function applyToolResultEvent(
  payload: Record<string, unknown>,
  toolNamesById: Map<string, string>,
  setTodos: React.Dispatch<React.SetStateAction<TodoItem[]>>,
  setStatus: (status: string) => void,
  copy: TuiCopy,
): void {
  const toolName = toolLabel(payload, toolNamesById);
  setStatus(copy.status.toolCompleted(toolName));
  // 其他工具的 content 不是 todo 结构，直接返回，避免无谓 JSON.parse。
  // [失败路径] 非 TodoWrite 直接返回：其他工具的输出不是 todo 结构，解析只会白费并可能抛错。
  // 完成态在返回前已写入，因此提前 return 不会让状态栏停在 running。
  // 只有 content 是非空字符串才尝试解析 JSON，缺失时保持既有 todos。
  // [权衡] 解析失败静默吞掉是刻意的：工具输出非 JSON 是常态，报错只会污染转录。
  // 整批校验通过才替换：部分更新会让列表增删跳动，用户无法判断是模型改的还是渲染错。
  // todos 的字段校验在 parseTodoItem，非法项被过滤后长度不等即整体放弃。
  // 若将来支持多工具写 todo，判据要改成能力标记而非工具名字面量。
  //
  if (toolName !== "TodoWrite") return;

  const result = asRecord(payload.result);
  const content = stringField(result, "content");
  if (!content) return;
  try {
    const parsed = JSON.parse(content) as { todos?: unknown[] };
    if (!Array.isArray(parsed.todos)) return;
    const todos = parsed.todos
      .map((item) => parseTodoItem(item))
      .filter((item): item is TodoItem => Boolean(item));
    // 任一条 todo 非法就整体丢弃，避免部分更新导致列表跳变。
    if (todos.length === parsed.todos.length) setTodos(todos);
  } catch {
    // Non-JSON tool content is normal for most tools.
  }
}

// 修改文件统计：每个 toolCallId 只处理一次（modifiedFileToolCallIds 去重，重放事件不会重复累加）；
// 空结果不写入；缺少 setter 时整体跳过。
function applyModifiedFileDisplayEvent(
  payload: Record<string, unknown>,
  handlers: SessionEventHandlers,
): void {
  if (!handlers.setModifiedFiles) return;

  const toolCallId = stringField(payload, "toolCallId");
  if (!toolCallId) return;
  // [并发] 去重集合记录已统计的 toolCallId：事件重放或断线重连会重复投递结果，不去重就重复累加。
  // 先查集合再算 stats，避免为已处理的事件做无谓的路径归一化。
  // [事务] 只有 stats 非空才写集合：空结果不入账，后续真正带 diff 的同 id 事件仍能被统计。
  // 缺少 setModifiedFiles 时整体跳过，连去重集合都不动，保证宿主降级后行为一致。
  // toolCallId 缺失直接返回：没有幂等键就无法去重，宁可少统计也不要重复统计。
  // 集合与 Map 一样由父层持有，生命周期必须与 session 对齐，否则重连后历史统计会翻倍。
  // 统计合并走 applyModifiedFileStats，本函数只负责闸门与去重，不碰合并规则。
  //
  if (handlers.modifiedFileToolCallIds?.has(toolCallId)) return;

  const stats = modifiedFileStatsFromToolResultPayload(payload, handlers.workspaceDirectory);
  if (stats.length === 0) return;

  handlers.modifiedFileToolCallIds?.add(toolCallId);
  handlers.setModifiedFiles((current) => applyModifiedFileStats(current, stats));
}

// 严格校验 todo 三字段；content 为空或 status/priority 越界返回 undefined，由调用方过滤。
function parseTodoItem(value: unknown): TodoItem | undefined {
  const item = asRecord(value);
  const content = stringField(item, "content");
  const status = item.status;
  const priority = item.priority;
  if (
    !content ||
    (status !== "pending" && status !== "in_progress" && status !== "completed") ||
    (priority !== "high" && priority !== "medium" && priority !== "low")
  ) {
    return undefined;
  }
  return {
    content,
    priority,
    status,
  };
}
