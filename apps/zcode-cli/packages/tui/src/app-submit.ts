// INV-01 只改传入 setter：守住位置 入参收敛；改错故障 模块直接写会话存储。
// INV-02 结果按种类分派：守住位置 种类分支；改错故障 排队结果被当成新一轮。
// INV-03 恢复优先于当前：守住位置 三元基底；改错故障 恢复历史与现存消息混在一起。
// INV-04 空响应不占位：守住位置 裁剪后长度判断；改错故障 界面出现未发送的回复。
// INV-05 重复响应不追加：守住位置 存在性判断；改错故障 同一回复渲染两次。
// INV-06 空片段被过滤：守住位置 类型收窄过滤；改错故障 渲染层收到空数组。
// INV-07 工具片段重建投影：守住位置 标题与详情重建；改错故障 恢复后工具行样式不同。
// INV-08 本地消息标识进程内唯一：守住位置 自增序号；改错故障 列表键冲突。
// INV-09 进行中提交先排队：守住位置 发送能力判断；改错故障 与当前回合并发起新轮。
// INV-10 无发送能力不动草稿：守住位置 提前返回；改错故障 用户输入丢失。
// INV-11 排队只进队列区：守住位置 排队分支；改错故障 排队输入混入流式回复。
// INV-12 其余结果回填草稿：守住位置 兜底分支；改错故障 失败后输入消失。
// INV-13 异常统一写错误态：守住位置 捕获分支；改错故障 失败没有任何提示。
// INV-14 空闲提交先清态：守住位置 发送前重置；改错故障 上一轮状态栏残留。
// INV-15 紧凑命令走时间线：守住位置 命令识别；改错故障 同一命令出现两种行样式。
// INV-16 取消不算失败：守住位置 中止判断；改错故障 用户取消后弹出错误。
// INV-17 只清理自己的控制器：守住位置 引用比较；改错故障 并发提交后新轮无法取消。
// INV-18 展示文本先脱敏：守住位置 脱敏函数；改错故障 密钥进入对话记录。
//
// 模块职责：appendAgentResult / submitIdleTurn —— 把提交结果合并进 transcript，并分派排队与新建两条路径。
// 状态所有权：状态全部来自调用方 setter，本模块不持久化任何数据。
// 阅读顺序：先看结果合并与恢复，再看进行中提交，最后看空闲提交与脱敏。
// 提交落地模块：把一次提交/恢复的结果合并进 transcript，并分派"进行中排队"与"空闲新建一轮"两条路径。
// 边界：只操作传入的 React 状态 setter 与 options 回调，不直接写 session 存储、不落盘。
// 口径：结果按 kind 分派（started_turn/command_result 落地、queued 进队列区、其余回填草稿并提示）。
// 失败语义：异常统一写 lastError、回填草稿并追加 system 错误消息；用户取消不算失败，不写错误。
import type { SessionEvent, TurnId } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared";
import type React from "react";
import type {
  DraftAttachment,
  Message,
  QueuedInput,
  SelectionState,
  SlashSelectionState,
  TranscriptPart,
  SubmitValueOptions,
} from "./app-model.js";
import { toPromptInput } from "./app-input.js";
import { upsertQueuedInput } from "./app-queued-inputs.js";
import {
  finalizeStreamProjectedMessages,
  projectedTranscriptHasResponse,
} from "./app-transcript-stream.js";
import { appendSystemErrorMessage } from "./app-transcript-errors.js";
import { formatFileDiffDisplay } from "./app-tool-diff-display.js";
import { buildToolTranscriptProjection } from "./app-tool-transcript.js";
import {
  compactCommandFromText,
  createLocalCompactTimelineMessage,
  failLatestStartedCompactTimeline,
  upsertCompactTimelineMessage,
} from "./app-compact-timeline.js";
import type {
  TuiOptions,
  TuiRequestPermission,
  TuiRestoredTranscriptPart,
  TuiSubmitPromptResult,
} from "./types.js";

// 本地 user 消息的 id 前缀与自增序号：用于在排队/插入场景下给尚未落地的用户消息一个稳定 key，
// 作用域为进程内，重启后不复用（仅用于 React key 与去重，不进入协议）。
const LOCAL_USER_MESSAGE_ID_PREFIX = "local-user";

let localUserMessageSequence = 0;

// 把一次提交/恢复的结果合并进 transcript 并返回新数组（不改入参）。
// 输入口径：restoredMessages 有值时以恢复的历史为基底（session 恢复场景）；否则 resetSessionProjection
// 为真则清空重来，都缺省时沿用 current。response 为空串表示本轮没有新增最终文本，直接返回基底，
// 避免渲染 agent 从未发送的占位回复；非恢复场景下若已存在相同响应也不重复追加。
// 副作用：无（纯函数），仅可能创建新数组；workspaceDirectory 用于还原工具标题路径。
export function appendAgentResult(
  current: Message[],
  result: TuiSubmitPromptResult,
  options: { workspaceDirectory?: string } = {},
): Message[] {
  // resume 回放以前只保留 content/role，导致已持久化的 reasoning/tool
  // part 被初始渲染丢掉；这里恢复成 TUI 结构化 parts，继续复用实时流式组件。
  const restored = result.restoredMessages
    ? result.restoredMessages.map((message) =>
        restoreTranscriptMessage(message, options.workspaceDirectory),
      )
    : result.resetSessionProjection
      ? []
      : current;
  const finalized = finalizeStreamProjectedMessages(restored);
  if (!result.restoredMessages && projectedTranscriptHasResponse(finalized, result.response)) {
    return finalized;
  }
  if (result.response.trim().length === 0) {
    // streaming and steering paths can complete with no additional final text;
    // rendering a placeholder makes the transcript show a reply the agent never sent.
    return finalized;
  }
  return [
    ...finalized,
    {
      content: result.response,
      role: "agent",
    },
  ];
}

// 还原单条历史消息：保留 id 与 role，content 原样，parts 逐一还原并丢弃空片段；
// 没有有效 parts 时只返回 content 形态，避免向渲染层传入空数组导致结构判断失效。
function restoreTranscriptMessage(
  message: NonNullable<TuiSubmitPromptResult["restoredMessages"]>[number],
  workspaceDirectory: string | undefined,
): Message {
  const parts = (message.parts ?? [])
    .map((part) => restoreTranscriptPart(part, workspaceDirectory))
    .filter((part): part is TranscriptPart => Boolean(part));

  return {
    ...(message.id ? { id: message.id } : {}),
    content: message.content,
    ...(parts.length > 0 ? { parts } : {}),
    role: message.role,
  };
}

// 还原单个历史片段：text/thought 空内容返回 undefined（由上层过滤掉）；
// 其余按工具片段处理——重建 detailLines/title 投影，file_diff 结果还原为结构化展示，
// 保留 error/output/status/toolCallId 等字段，使恢复后的渲染与实时流一致。
function restoreTranscriptPart(
  part: TuiRestoredTranscriptPart,
  workspaceDirectory: string | undefined,
): TranscriptPart | undefined {
  if (part.type === "text") {
    return part.text.trim().length > 0 ? { text: part.text, type: "text" } : undefined;
  }

  if (part.type === "thought") {
    return part.text.trim().length > 0
      ? {
          contentCharCount: part.text.length,
          status: "thought",
          text: part.text,
          type: "thought",
        }
      : undefined;
  }

  const projection = buildToolTranscriptProjection(part.toolName, part.input, workspaceDirectory);
  const resultDisplay =
    part.resultDisplay?.kind === "file_diff"
      ? formatFileDiffDisplay(part.resultDisplay as Record<string, unknown>)
      : undefined;
  return {
    detailLines: projection.detailLines,
    ...(part.error ? { error: part.error } : {}),
    ...(part.output ? { output: part.output } : {}),
    ...(resultDisplay ? { resultDisplay } : {}),
    status: part.status,
    title: projection.title ?? part.title,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    type: "tool",
  };
}

// 进行中（busy）提交走排队路径：尝试把输入挂到当前 turn 上，而不是新开一轮。
// 返回语义：options.sendInput 缺失时仅提示并放弃，不清空草稿；发送结果为 started_turn/command_result
// 时按普通提交落地（命令结果保留 preserveTurnState），为 queued 时只进输入框上方队列区、不插入 transcript，
// 其余情况把文本回填到输入框并提示原因。异常时写 lastError、回填草稿并追加 system 错误消息。
// 副作用：清空/回填草稿、更新消息与队列、写状态栏、发起 sendInput 请求；不直接修改 session。
export async function submitDuringActiveTurn(input: {
  activeTurnId?: TurnId;
  applyResult: (result: TuiSubmitPromptResult, preserveTurnState?: boolean) => void;
  applySessionEvent: (event: SessionEvent) => void;
  draftAttachments: DraftAttachment[];
  options: TuiOptions;
  requestPermission: TuiRequestPermission;
  messageInsertIndex: number;
  setDraftValue: (value: string) => void;
  setLastError: (message: string | undefined) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setQueuedInputs: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  setStatus: (status: string) => void;
  signal?: AbortSignal;
  text: string;
  modelSelection?: ModelSelection;
}): Promise<void> {
  if (!input.options.sendInput) {
    // 客户端不支持追加输入时保持草稿不变，避免用户内容丢失。
    input.setStatus("Agent is still responding.");
    return;
  }
  input.setDraftValue("");
  const compactCommand =
    input.draftAttachments.length === 0 ? compactCommandFromText(input.text) : undefined;
  const localUserMessage = createLocalUserMessage(redactSensitivePromptForTranscript(input.text));
  try {
    input.setStatus("Queueing input...");
    const result = await input.options.sendInput(
      toPromptInput(input.text, input.draftAttachments, input.modelSelection),
      {
        abortSignal: input.signal,
        delivery: "auto",
        expectedTurnId: input.activeTurnId,
        onEvent: input.applySessionEvent,
        requestPermission: input.requestPermission,
      },
    );
    if (result.kind === "started_turn" || result.kind === "command_result") {
      if (!compactCommand) {
        input.setMessages((current) =>
          insertLocalUserMessageAt(current, localUserMessage, input.messageInsertIndex),
        );
      }
      input.applyResult(
        compactCommand ? { ...result.result, response: "" } : result.result,
        result.kind === "command_result",
      );
      return;
    }
    if (result.kind !== "queued") {
      input.setDraftValue(input.text);
    } else {
      // 排队输入还没有被 runtime 注入模型上下文，直接追加到 transcript
      // 会和正在流式输出的回复混在一起；先放到输入框上方的队列区。
      input.setQueuedInputs((current) =>
        upsertQueuedInput(current, {
          id: result.pendingInputId,
          text: localUserMessage.content,
        }),
      );
    }
    input.setStatus(
      result.kind === "queued"
        ? result.queueLength > 1
          ? `Input queued (${result.queueLength} pending).`
          : "Input queued."
        : `Input not queued: ${result.reason}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.setLastError(message);
    input.setDraftValue(input.text);
    input.setMessages((current) => appendSystemErrorMessage(current, message));
    input.setStatus(`Input not queued: ${message}.`);
  }
}

// 空闲提交：清空草稿与附件、置 busy 后发起 submitPrompt，等待整轮结果。
// 输入：text 为已解析文本，draftAttachments 为待发附件，submitOptions 控制保留选择器/取消文案等行为。
// 成功：applyResult 落地结果（/compact 时清空 response，因为该命令只产生时间线行）。
// 取消：signal 已 abort 视为用户取消，清错误、写取消文案，不追加错误消息。
// 失败：写 lastError 与 "Turn failed."，按是否为 /compact 分别标记时间线失败或追加 system 错误。
// 副作用：替换 turnRef、清空草稿/附件、写消息与状态、发起请求；finally 中恢复 busy 并释放 turnRef。
export async function submitIdleTurn(input: {
  applyResult: (result: TuiSubmitPromptResult) => void;
  applySessionEvent: (event: SessionEvent) => void;
  draftAttachments: DraftAttachment[];
  options: TuiOptions;
  requestPermission: TuiRequestPermission;
  setBusy: (value: boolean) => void;
  setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setLastError: (message: string | undefined) => void;
  setLiveModelText: (value: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>;
  setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
  setStatus: (status: string) => void;
  setStatusDetails: React.Dispatch<React.SetStateAction<string[]>>;
  submitOptions?: SubmitValueOptions;
  text: string;
  modelSelection?: ModelSelection;
  turnRef: React.MutableRefObject<AbortController | undefined>;
}): Promise<void> {
  const promptInput = toPromptInput(input.text, input.draftAttachments, input.modelSelection);
  const compactCommand =
    input.draftAttachments.length === 0 ? compactCommandFromText(input.text) : undefined;
  const abortController = new AbortController();
  input.turnRef.current = abortController;
  input.setDraftValue("");
  input.setDraftAttachments([]);
  input.setBusy(true);
  input.setLastError(undefined);
  input.setStatus("Thinking...");
  input.setStatusDetails([]);
  input.setLiveModelText("");
  if (!input.submitOptions?.preserveSelection) input.setSelection(undefined);
  input.setSlashSelection(undefined);
  if (compactCommand) {
    // `/compact` 是控制命令，TUI 之前把它渲染成 user row；
    // app 侧又有专门的 compaction 横条，导致两端语义不一致。这里直接渲染同一类 timeline row。
    input.setMessages((current) =>
      upsertCompactTimelineMessage(
        current,
        createLocalCompactTimelineMessage({
          command: compactCommand,
          status: "started",
        }),
      ),
    );
  } else {
    input.setMessages((current) => [
      ...current,
      { content: redactSensitivePromptForTranscript(input.text), role: "user" },
    ]);
  }

  try {
    const result = await input.options.submitPrompt(promptInput, {
      abortSignal: abortController.signal,
      onEvent: input.applySessionEvent,
      requestPermission: input.requestPermission,
    });
    input.applyResult(compactCommand ? { ...result, response: "" } : result);
  } catch (error) {
    if (abortController.signal.aborted) {
      // 用户主动取消不是失败：不写 lastError，也不向 transcript 追加错误消息。
      input.setLastError(undefined);
      input.setStatus(input.submitOptions?.abortStatus ?? "Operation cancelled.");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    input.setLastError(message);
    input.setStatus("Turn failed.");
    input.setMessages((current) =>
      compactCommand
        ? failLatestStartedCompactTimeline(current, message)
        : appendSystemErrorMessage(current, message),
    );
  } finally {
    input.setBusy(false);
    // 只清理自己创建的 controller，防止并发提交时误清掉更新一轮的 turnRef。
    if (input.turnRef.current === abortController) {
      input.turnRef.current = undefined;
    }
  }
}

// 创建带 id 的本地 user 消息：id 由进程内自增序号生成，保证同一进程内唯一，
// 仅用于乐观渲染与列表 key，不参与服务端去重。
function createLocalUserMessage(content: string): Message & { id: string } {
  localUserMessageSequence += 1;
  return {
    content,
    id: `${LOCAL_USER_MESSAGE_ID_PREFIX}-${localUserMessageSequence}`,
    role: "user",
  };
}

// 对可能含密钥的提交文本做脱敏，仅处理 /login 后接 coding-plan key 的形态：
// 有密钥内容时替换为 <redacted>，无密钥或非该命令形态时原样返回（不匹配即不改写）。
// 仅用于 transcript 展示，不改写真正发送的文本；正则不匹配时保持原文，避免误伤普通输入。
export function redactSensitivePromptForTranscript(text: string): string {
  const trimmed = text.trim();
  const match =
    /^\/login\s+(zai-coding-plan-api-key|bigmodel-coding-plan-api-key)(?:\s+([\s\S]+))?$/u.exec(
      trimmed,
    );
  if (!match?.[2]?.trim()) return text;
  return `/login ${match[1]} <redacted>`;
}

// 在指定位置插入本地 user 消息：下标先收敛到 [0, length] 并取整，
// 防止调用方传入越界/小数索引导致 slice 行为异常。
function insertLocalUserMessageAt(
  messages: Message[],
  message: Message & { id: string },
  index: number,
): Message[] {
  const insertionIndex = Math.max(0, Math.min(messages.length, Math.floor(index)));
  return [...messages.slice(0, insertionIndex), message, ...messages.slice(insertionIndex)];
}
