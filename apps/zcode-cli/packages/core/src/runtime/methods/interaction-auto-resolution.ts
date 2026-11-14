/**
 * ============================================================================
 * runtime/methods/interaction-auto-resolution.ts —— AskUserQuestion 自动结束
 * ============================================================================
 *
 * 【定位】当交互请求不再需要用户作答时（超时、会话结束、上游取消），
 * 记录一条 UserInputAutoResolutionUpdated 事件。它不是 UI 本地状态：
 * Desktop continuous 与 Web remote replayable 两条链路都必须能从事件流恢复
 * 同一组"绝对时间 + 解决方式"，否则刷新后弹窗会复活或永远转圈。
 *
 * 【写入路径】必须走 runtime.appendEvent（durable append + sink），
 * 不能直接写 store：否则 live sink/恢复 merge 看不到该事件。
 * ============================================================================
 */

import {
  SessionEventType,
  type UserInputAutoResolutionUpdatedPayload,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 记录 AskUserQuestion 自动结束阶段。事件必须走 runtime 的 durable append/sink 链路，
 * 让 desktop continuous 与 web remote replayable 都恢复同一组绝对时间。
 */
export async function recordUserInputAutoResolutionUpdate(
  this: AgentRuntimeInternal,
  input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.UserInputAutoResolutionUpdated,
      {
        interactionId: input.interactionId,
        toolCallId: input.toolCallId,
        autoResolution: input.autoResolution,
      } satisfies UserInputAutoResolutionUpdatedPayload,
      traceContext,
    ),
    traceContext,
  );
}
