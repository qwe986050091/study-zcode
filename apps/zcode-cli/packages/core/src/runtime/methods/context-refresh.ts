/**
 * ============================================================================
 * runtime/methods/context-refresh.ts —— 重建上下文前缀（system + meta user）
 * ============================================================================
 *
 * 【定位】模型/输出风格/语言/工作区状态变化后，system 消息与 meta user 附件
 * 需要重建；它们位于消息历史的"前缀"，而真实对话在后。本文件负责：
 *   1) 用最新 snapshot 重建 contextBuilder；
 *   2) 把旧前缀整段替换为新前缀，保留对话正文；
 *   3) 若调用方提供了 turnRequestEntries（本轮请求视图），只替换其前缀部分。
 *
 * 【为什么用 countContextPrefixMessages 切片】
 *   前缀消息数量由契约 helper 计算，不能在多处各自数 system 消息：
 *   meta user attachment 也算前缀，数错会把用户真实消息一起丢掉。
 *
 * 【初始化前分支】contextInitialized=false 时只能刷新"同步预览"用的 builder，
 *   并且 persistEnvInfo=false：若此时把 config-only fallback 写进 config.envInfo，
 *   真正的 context source 会以为 envInfo 已被外部提供，跳过平台/git 探测。
 * ============================================================================
 */

import { countContextPrefixMessages } from "../deps.js";
import type { Model } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";

/**
 * 重建并替换历史前缀。
 *
 * 返回值的两种形态：
 *   - 无 turnRequestEntries：返回历史自身的只读视图（前缀已替换）；
 *   - 有 turnRequestEntries：返回"新前缀 + 该请求视图的非前缀部分"，
 *     用于本轮请求而不改动全局历史顺序。
 * 同时更新 latestContextBuildResult，供 UI 展示本步实际组装的上下文。
 */
export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryRoot,
        {
          memoryIndexContent: runtime.memoryIndexContent,
          model: options.model,
          persistEnvInfo: false,
        },
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  // contextSourceSnapshot 只在完整初始化后可用;初始化早期退回 config-only 快照,
  // 仍然产出可用的系统前缀,交给后续真正初始化时整体替换。
  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model: options.model },
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  const contextEntries = buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}
