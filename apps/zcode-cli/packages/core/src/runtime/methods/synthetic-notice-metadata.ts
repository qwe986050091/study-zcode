/**
 * ============================================================================
 * synthetic-notice-metadata.ts —— 合成 user notice 的元数据与语义
 * ============================================================================
 * 定位：链路 8 与后台通知等 runtime 注入消息的「身份层」，决定 part/message metadata
 *       以及 MessageSemantics（origin/kind/ui/provider/transcript 可见性）。
 * 输入/输出：输入 source + visibility；输出可持久化、可冷恢复的 metadata/semantics。
 * 关键不变量：model-only 的 runtime 注入只对 provider 可见，对 UI/transcript 隐藏，
 *       否则 V4 hydration 会把它误当真实用户 turn；所有 source 必须穷举 kind，
 *       缺失会让持久消息 kind=undefined、冷恢复后语义漂移。
 * ============================================================================
 */
import type { MessageSemantics, MessageVisibility, SyntheticUserMessageSource } from "../deps.js";
import { runtimeMetadataForSyntheticUserMessageSource } from "../helpers/index.js";

export function buildSyntheticUserNoticePartMetadata(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // part 级保留调用方已有的 runtimeMessage（可覆盖默认映射）；source/visibility 放最后，
  // 保证它们不会被外部 metadata 伪造。
  return {
    ...metadata,
    runtimeMessage:
      metadata?.runtimeMessage ?? runtimeMetadataForSyntheticUserMessageSource(source),
    source,
    visibility,
  };
}

export function buildSyntheticUserNoticeMessageMetadata(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next = { ...metadata };
  // message 级不携带 runtimeMessage：该标记只在 part 上表达，留在 messageInfo 会让整条消息
  // 在冷恢复时被误判为 runtime 注入。
  delete next.runtimeMessage;
  return {
    ...next,
    source,
    visibility,
  };
}

export function buildSyntheticUserNoticeSemantics(
  source: SyntheticUserMessageSource,
  visibility: MessageVisibility,
): MessageSemantics {
  if (source === "shared_context") {
    // shared_context 是用户显式导入的来源，所以 origin=import：UI 隐藏，但 provider/transcript
    // 都可见，与普通 runtime 注入的可见性方向相反。
    return {
      origin: "import",
      kind: "shared_context",
      source,
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    };
  }
  // 只有 model-only 才隐藏 UI/transcript；其余（含 user-visible）对 provider 隐藏、对用户可见。
  const providerVisible = visibility === "model-only";
  return {
    // origin=agent_runtime 标识非用户输入；kind 由 source 一一映射，供 UI/恢复识别。
    origin: "agent_runtime",
    kind: syntheticUserNoticeKind(source),
    source,
    // 两套可见性互斥：model-only → provider 可见/UI 隐藏；否则反过来（provider 不可见的注入无意义）。
    uiVisibility: providerVisible ? "hidden" : "visible",
    providerVisibility: providerVisible ? "visible" : "hidden",
    // provider-visible 的 user-role runtime context 不是用户 transcript。
    // fork/goal/background 等 synthetic notice 如果标成 transcript visible，
    // v4 hydration 会把它们误当作真实用户 turn。
    transcriptVisibility: providerVisible ? "hidden" : "visible",
  };
}

function syntheticUserNoticeKind(source: SyntheticUserMessageSource): MessageSemantics["kind"] {
  switch (source) {
    case "background_task":
      // 后台任务完成/失败通知：独立 kind，UI 用它决定卡片样式。
      return "background_notification";
    case "fork":
      // fork 通知是分支操作产生的系统消息。
      return "fork_notice";
    // goal_state_change 是 trajectory 分支新增的 runtime 注入源（target.ts 目标变更通知），
    // 与 goal-continuation 同属 system reminder 语义。
    case "goal_state_change":
      return "system_reminder";
    case "goal-continuation":
      // goal 续跑提示与目标状态变更同属 system reminder。
      return "system_reminder";
    case "agent_listing_delta":
    case "plugin_reference":
    case "bot_topic_context":
      // 三者都是 runtime 注入的上下文补丁，统一归 system_reminder。
      return "system_reminder";
    case "rewind":
      // rewind 有独立 kind，冷恢复后仍能识别为回退提示。
      return "rewind_notice";
    case "selection_side_chat":
      // 选区侧聊注入按 system reminder 处理。
      return "system_reminder";
    case "subagent":
      // 子代理完成通知。
      return "subagent_notification";
    case "subagent_message":
      // child -> parent 的 model-only runtime carrier，
      // 若这里未同步穷举，持久消息会产生 kind=undefined，冷恢复后无法保持语义等价。
      return "subagent_notification";
    case "todo_reminder":
      // todo 提醒有独立 kind，UI 可单独呈现。
      return "todo_reminder";
    // 直接启动的启动轮不走这条 synthetic-notice 铸造路（它要 origin=real_user、kind=user_prompt，
    // 由 message-persistence 的专用落盘直接给出）。这里只为穷举完备而登记同一个 kind。
    case "workflow_launch":
      return "user_prompt";
    case "shared_context":
      // 与上面的 import 分支保持同一 kind，保证语义映射从 source 到 kind 闭合。
      return "shared_context";
  }
  // switch 覆盖整个 source union 且不写 default：新增来源时 TS 会在此报缺返回值，
  // 防止静默产生 undefined kind。
}
