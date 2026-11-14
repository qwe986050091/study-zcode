import type { HookRunResult, Model, TraceContext, TurnState } from "./deps.js";
import type { HookEventName } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../agent/message-history.js";

// 从 internal-methods.ts 拆出，避免该文件越过
// 400 行边界（runtime-module-boundary 测试），hooks 一组方法自成一段，单独成文件。
/**
 * ============================================================================
 * runtime/internal-hook-methods.ts —— hook 生命周期方法的内部契约
 * ============================================================================
 *
 * 【定位】AgentRuntime 的 hook 能力表面:真正实现在 runtime/methods/hooks.ts,
 * 由 installAgentRuntimeMethods 挂到 prototype;本文件只声明类型,让 internal.ts
 * 的交叉类型(AgentRuntimeInternal)能约束"runtime 上确实有这些方法"。
 *
 * 【四类 hook 的输入/输出口径】
 *   - SessionStart:每 runtime 只跑一次(实现侧用 sessionStartHookRan 门),
 *     先激活 workspace hook admission,再执行配置 hook;
 *   - UserPromptSubmit:每轮用户输入前跑,只带 prompt 与附件摘要;
 *   - Stop:每轮结束跑,带响应全文/预览与工具计数,可要求"继续"以追加提醒;
 *   - additionalContext 注入:只写内存 messageHistory(不作为 durable part),
 *     下一轮请求由 context 组装自然带上,冷恢复不会重放这些 hook 文本。
 *
 * 【失败与降级】runner 缺席时一律返回空结果(additionalContexts: []),
 * 不阻断 turn;hook 自身的执行/取消语义由 HookRunner 负责。
 * ============================================================================
 */
export interface AgentRuntimeHookMethods {
  /**
   * 触发 SessionStart hook;source 决定匹配的事件变体与 payload。
   * 输入:source / traceContext / 可选中止信号 / 可选模型身份(进 payload)。
   * 输出:HookRunResult(additionalContexts 由调用方决定是否注入历史)。
   * 副作用:首次调用会激活 workspace hook admission,并把 sessionStartHookRan
   * 置 true(后续调用直接返回空结果,不会重复执行)。失败:不吞 hook 错误,
   * 由 runner 的语义决定(取消走 signal)。
   */
  runSessionStartHooks(
    source: "startup" | "resume" | "clear" | "compact",
    traceContext: TraceContext,
    signal?: AbortSignal,
    model?: Pick<Model, "providerId" | "modelId">,
  ): Promise<HookRunResult>;
  /**
   * 触发 UserPromptSubmit hook(用户输入进入 turn 之前)。
   * 输入:prompt 原文 + attachments(仅摘要进 payload,不进全文)+ traceContext。
   * 输出:HookRunResult。副作用:执行外部命令/hook,可能新增 additionalContexts。
   * 降级:无 runner 时返回空结果;skipUserPromptSubmitHooks 的 turn(通知/子代理
   * 回传)不会调用到这里。
   */
  runUserPromptSubmitHooks(
    prompt: string,
    attachments: TurnState["attachments"] | undefined,
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  /**
   * 触发 Stop hook(模型本轮给出终态响应后)。
   * 输入:response 全文(预览会被截断)、toolCallCount、stopHookActive 防止递归。
   * 输出:HookRunResult;其中 stopShouldContinue + additionalContexts 会被
   * shouldContinueAfterStopHooks 消费,决定是否追加一次续跑。
   * 副作用:执行 hook;不改变 durable 历史,续跑所需的上下文由调用方注入。
   */
  runStopHooks(
    response: string,
    toolCallCount: number,
    traceContext: TraceContext,
    signal?: AbortSignal,
    stopHookActive?: boolean,
  ): Promise<HookRunResult>;
  /**
   * 把 hook 的 additionalContext 合并成一条 system reminder 写入内存历史。
   * 输入:产生上下文的 hook 事件名 + 文本数组;输出:新增的 entry 或 undefined
   * (空数组时什么都不做)。副作用:仅追加内存 messageHistory,不落库、不发事件;
   * 因此冷恢复不会重放这些 hook 文本,它们只影响"当轮之后"的请求。
   */
  injectHookAdditionalContextIntoMessageHistory(
    eventName: HookEventName,
    additionalContexts: readonly string[],
  ): RuntimeMessageEntry | undefined;
  /**
   * 判断 Stop hook 是否要求再续跑一轮。
   * 口径:必须同时满足 stopShouldContinue=true、确实带来了 additionalContexts,
   * 且未超过续跑上限(实现侧 MAX_STOP_HOOK_CONTINUATIONS=3),防止 hook 无限续跑。
   */
  shouldContinueAfterStopHooks(result: HookRunResult, continuationCount: number): boolean;
}
