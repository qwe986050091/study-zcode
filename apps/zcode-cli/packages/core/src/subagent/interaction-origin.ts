import type {
  InteractionRequestOrigin,
  SessionId,
  ToolCallId,
  TurnId,
} from "@zcode/contracts";

// 子 agent 交互来源的上下文：用于把子会话里的确认/提问挂回父会话。
// 所有 id 均为上游分配，本文件不生成、不校验格式。
export interface SubagentInteractionOriginContext {
  // 子 agent 实例 id，与 runtime task 注册表同源。
  agentId: string;
  // 子 agent 类型名（Explore / general-purpose / 自定义 profile 名）。
  agentType: string;
  // 子 agent 自己的会话 id；交互实际发生在该会话内。
  childSessionId: SessionId;
  // 任务描述，供父界面展示“哪个子 agent 在请求确认”。
  description: string;
  // 父会话 id，交互投影到该会话的实时视图。
  parentSessionId: SessionId;
  // 父级 tool call id，可为字符串或强类型 id；缺省时不写入字段。
  parentToolCallId?: ToolCallId | string;
  // 父级 turn id，缺省时不写入字段。
  parentTurnId?: TurnId;
}

// 构造 `kind: "subagent"` 的交互来源描述，供 PermissionRequested 等事件携带。
// childTurnId 为子会话内的 turn id（可选，缺省时省略字段，避免写入 undefined）。
// 纯对象构造：无 IO、无副作用；可选字段一律用条件展开，保持输出结构可序列化。
export function buildSubagentInteractionOrigin(
  context: SubagentInteractionOriginContext,
  childTurnId?: TurnId,
): InteractionRequestOrigin {
  return {
    kind: "subagent",
    agentId: context.agentId,
    agentType: context.agentType,
    childSessionId: context.childSessionId,
    ...(childTurnId ? { childTurnId } : {}),
    description: context.description,
    parentSessionId: context.parentSessionId,
    ...(context.parentToolCallId ? { parentToolCallId: context.parentToolCallId } : {}),
    ...(context.parentTurnId ? { parentTurnId: context.parentTurnId } : {}),
  };
}
