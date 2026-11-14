/**
 * ============================================================================
 * runtime/methods/hooks.ts —— 生命周期 Hook 在 runtime 侧的适配层
 * ============================================================================
 *
 * 本文件的职责只有三段：把 runtime 状态装成 HookInput → 调 hookRunner.run →
 * 把结果按调用方的语义回灌（内存历史 / 续跑判定）。匹配、授权、事件发射都在
 * hooks/runner.ts 与 hooks/configured-runner.ts，这里不重复实现。
 *
 * 三个刻意约束：
 *   - SessionStart 每个 runtime 至多一次，且必须先激活工作区 hook 信任准入；
 *   - Stop hook 的续跑必须带来新的 additionalContext，否则不许重发请求；
 *   - 注入的 hook 上下文只进内存 messageHistory，不落 durable，冷恢复不重放。
 * ============================================================================
 */
import { HookEventName } from "../deps.js";
import type { HookRunResult, Model, TraceContext, TurnState } from "../deps.js";
import type { HookEventName as HookEventNameType } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

// 续跑硬上限：每次续跑都会带着 hook 的 additionalContext 重发一次模型请求，
// 没有上限时"要求继续"的 hook 与模型会互相触发，turn 永远收不了口。
const MAX_STOP_HOOK_CONTINUATIONS = 3;

// 所有降级路径共享同一个空结果对象：调用方只会读 additionalContexts，
// 复用可避免每次早退都新建对象，也防止某个调用方就地修改污染后续调用。
const EMPTY_HOOK_RESULT: HookRunResult = {
  additionalContexts: [],
};
// 两个预算口径不能混用：注入历史的 hook 上下文受上下文预算约束（24k 字符），
// Stop hook 的 responsePreview 只用于展示（4k）；全文另走 responseText。
const HOOK_CONTEXT_MAX_CHARS = 24_000;
const HOOK_PREVIEW_MAX_CHARS = 4_000;

// source 既是 payload 字段也是 matcher 值，启动/恢复/清理/压缩四种来源
// 要靠它分流，因此不能只当成日志标签。
type SessionStartSource = "startup" | "resume" | "clear" | "compact";

export async function runSessionStartHooks(
  this: AgentRuntimeInternal,
  source: SessionStartSource,
  traceContext: TraceContext,
  signal?: AbortSignal,
  model?: Pick<Model, "providerId" | "modelId">,
): Promise<HookRunResult> {
  // 每个 runtime 只跑一次：resume/compact 都会再次走到这里，
  // 重复触发会重复注入 additionalContext，并多发一条 SessionStart 事件。
  if (this.sessionStartHookRan) return EMPTY_HOOK_RESULT;
  // 工作区 hook 的信任准入必须先于任何配置 hook；准入端口未装配时只跑配置 hook，
  // 这是明确的降级路径，而不是绕过授权（不变量 #10 的激活侧）。
  await this.workspaceHookAdmission?.activate(source, signal);
  // 标记在 runner 执行之前置位：hook 抛错不会回滚该标记，
  // 因此 SessionStart 失败也不会在后续 turn 被"静默重放"并产生重复副作用。
  this.sessionStartHookRan = true;
  // 可选端口缺席时直接给空结果，调用方无需区分"没配置 hook"与"跑了但无输出"。
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  // 模型身份优先用调用方传入（fork/subagent 可能尚未写入 runtime 的 selection）；
  // 都取不到时不填 model 字段，避免把上一轮的模型归因到本次 SessionStart。
  const selectedModel = model ?? this.getSessionModelSelection();
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.SessionStart,
      mode: this.getMode(),
      model: selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : undefined,
      sessionId: this.sessionId,
      source,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    // matchValue 传 source 而不是事件名：hook 的 matcher 需要按
    // startup/resume/clear/compact 区分触发时机；signal 透传取消，避免阻塞 turn 收口。
    { matchValue: source, signal },
  );
}

export async function runUserPromptSubmitHooks(
  this: AgentRuntimeInternal,
  prompt: string,
  attachments: TurnState["attachments"] | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  // UserPromptSubmit 是增强能力：runner 未装配时返回空结果，
  // 不能因为 hook 缺席就拒绝用户输入（准入在 prompt-admission，不在此处）。
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      // 附件只给"类型 + 路径 / 内联字符数"摘要，不把正文塞进 payload，
      // 避免大附件内容进入 hook 进程与事件日志。
      attachmentsSummary: summarizeTurnAttachments(attachments),
      cwd: this.workingDirectory,
      hookEventName: HookEventName.UserPromptSubmit,
      mode: this.getMode(),
      prompt,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    // 每轮都要跑，故不传 matchValue（没有需要分流的子变体）。
    { signal },
  );
}

export async function runStopHooks(
  this: AgentRuntimeInternal,
  response: string,
  toolCallCount: number,
  traceContext: TraceContext,
  signal?: AbortSignal,
  stopHookActive = false,
): Promise<HookRunResult> {
  // Stop 只是收尾增强：runner 缺席时必须直接放行，不能让 turn 终态被 hook 卡住。
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  // 预览与全文分开传：预览用于事件/日志展示并受 4k 预算约束，
  // 全文只在 hook 进程内可见；用预览替代全文会让依赖完整响应的 hook 误判。
  const responsePreview = truncateForHook(response, HOOK_PREVIEW_MAX_CHARS);

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.Stop,
      mode: this.getMode(),
      responsePreview,
      responseText: response,
      sessionId: this.sessionId,
      // stopHookActive 告诉 hook"本轮是 Stop hook 自己触发的续跑"，
      // 防止 hook 对自身续跑再返回 continue，形成无限递归。
      stopHookActive,
      timestamp: new Date().toISOString(),
      toolCallCount,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export function injectHookAdditionalContextIntoMessageHistory(
  this: AgentRuntimeInternal,
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): RuntimeMessageEntry | undefined {
  // 空数组不产生空 system reminder：否则每轮都会往历史里塞无内容的噪声条目，
  // 既浪费上下文预算，也会让后续历史重建出现空条目。
  if (additionalContexts.length === 0) return undefined;
  // 只写内存 messageHistory（不落 durable、不发事件），因此冷恢复不会重放 hook 文本；
  // 返回 entry 是给调用方在同轮内引用（例如撤回到注入前），避免它重建一份。
  const entry = systemReminderAttachmentEntry(
    "hook_context",
    formatLifecycleHookAdditionalContextBody(eventName, additionalContexts),
  );
  this.messageHistory.addEntries([entry]);
  return entry;
}

export function shouldContinueAfterStopHooks(
  result: HookRunResult,
  continuationCount: number,
): boolean {
  // 三个条件缺一不可：stopShouldContinue 是 hook 的显式意图；additionalContexts
  // 是续跑的唯一意义（没有新上下文等于让模型空转）；上限防 hook 与模型自激。
  return (
    result.stopShouldContinue === true &&
    result.additionalContexts.length > 0 &&
    continuationCount < MAX_STOP_HOOK_CONTINUATIONS
  );
}

function formatLifecycleHookAdditionalContextBody(
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): string {
  // 每条上下文带 #序号并用空行分隔：合并成一条 reminder 后仍能区分各 hook 的边界，
  // 否则多 hook 的文本会连成一段，无法定位来源。
  const body = additionalContexts.map((context, index) => `#${index + 1}\n${context}`).join("\n\n");
  // 截断放在拼装之后：单条都合规但多条合计仍可能超预算，按合计长度裁才覆盖得住。
  return truncateForHook(
    [`${eventName} hook additional context: `, body].join("\n"),
    HOOK_CONTEXT_MAX_CHARS,
  );
}

function summarizeTurnAttachments(
  attachments: TurnState["attachments"] | undefined,
): string | undefined {
  // 无附件时返回 undefined 而不是空串：payload 字段靠"缺省"表达没有附件，
  // 空串会被 hook 误读成"有附件摘要但内容为空"。
  if (!attachments || attachments.length === 0) return undefined;

  return attachments
    .map((attachment, index) => {
      // 三种形态按信息量递减：有路径给路径，内联内容只给字符数（不泄露正文），
      // 都没有时只留类型，保证每条附件至少能被 hook 数出来。
      if (attachment.path) return `${index + 1}:${attachment.type}:${attachment.path}`;
      if (attachment.content)
        return `${index + 1}:${attachment.type}:inline:${attachment.content.length} chars`;
      return `${index + 1}:${attachment.type}`;
    })
    .join("\n");
}

function truncateForHook(value: string, maxChars: number): string {
  // 未超限原样返回：避免无意义的 slice 拷贝，也避免给合规内容加上省略号误导 hook。
  if (value.length <= maxChars) return value;
  // 超限时保留尾部 "..." 作为可识别的截断标记，接收方无需再自行判断是否被裁。
  return `${value.slice(0, maxChars)}...`;
}
