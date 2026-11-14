// ============================================================
// Subagent Tool Event Mirror
// ============================================================
// 把子会话内的工具/交互事件“镜像”到父会话事件流，使父 timeline 能看到子 agent 的活动。
// 只做纯事件转换：不写库、不发网络、不改变子会话自身事件；调用方负责把返回值重新发射。
// 关键不变量：镜像事件的 sessionId 恒为父会话，turnId 恒为父 turn，
// toolCallId 通过前缀重写为全局唯一，避免与父级 tool call 冲突。

import {
  SessionEventType,
  createSessionEvent,
  type SessionEvent,
  type ToolCallId,
} from "@zcode/contracts";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "./interaction-origin.js";

// 镜像 toolCallId 的前缀，保证 `<prefix>_<agentId>_<childToolCallId>` 可反解出归属。
const SUBAGENT_TOOL_CALL_ID_PREFIX = "tool_subagent";
// 事件 payload 中的来源标记，供父级投影区分“子 agent 活动”与本地工具调用。
const SUBAGENT_EVENT_SOURCE = "subagent";

// 需要镜像的工具活动事件白名单；未列入的事件类型不会被转发。
const MIRRORED_TOOL_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallProgress,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
]);

// 需要镜像的阻塞交互事件白名单（权限请求/结果/拒绝），必须进父会话才能被响应。
const MIRRORED_INTERACTION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
]);

// 镜像上下文在交互来源信息之上补充：
// - background：子 agent 是否后台运行，透传到 payload 供 UI 判断呈现方式；
// - toolNameByChildToolCallId：跨事件缓存 childToolCallId→toolName，因为 Progress/Result
//   等事件可能不再携带 toolName，需要沿用 Started 时记录的名称。
interface SubagentToolEventMirrorContext extends SubagentInteractionOriginContext {
  background: boolean;
  toolNameByChildToolCallId?: Map<string, string>;
}

// 镜像单条子会话事件到父会话：命中白名单且带 toolCallId 时返回新事件，否则返回 undefined。
// 输入 event 只读，不会被修改；context 中的 map 可能被写入（缓存 toolName），属于轻量副作用。
// 返回 undefined 语义：非镜像类型或缺 toolCallId，调用方应直接忽略，不要当失败处理。
export function mirrorSubagentToolEvent(
  event: SessionEvent,
  context: SubagentToolEventMirrorContext,
): SessionEvent | undefined {
  // 白名单外的生命周期事件（turn/message 等）不镜像，避免父 timeline 被噪音淹没。
  if (
    !MIRRORED_TOOL_EVENT_TYPES.has(event.type) &&
    !MIRRORED_INTERACTION_EVENT_TYPES.has(event.type)
  ) {
    return undefined;
  }

  const payload = asRecord(event.payload);
  // 无 toolCallId 的事件无法映射到父级调用，直接放弃镜像。
  const childToolCallId = stringField(payload, "toolCallId");
  if (!childToolCallId) return undefined;

  const toolCallId = mirroredToolCallId(context.agentId, childToolCallId);
  // 优先用事件自带名称，缺失时回退到缓存（后续事件可能省略字段）。
  const toolName =
    stringField(payload, "toolName") ?? context.toolNameByChildToolCallId?.get(childToolCallId);
  // 只在拿到名称时写缓存，避免用 undefined 覆盖已有值。
  if (toolName) {
    context.toolNameByChildToolCallId?.set(childToolCallId, toolName);
  }

  // 交互事件走独立装配逻辑（需要附带 origin，且不注入工具活动字段）。
  if (MIRRORED_INTERACTION_EVENT_TYPES.has(event.type)) {
    return mirrorInteraction(event, payload, toolCallId, toolName, context);
  }

  const mirroredPayload = {
    ...payload,
    toolCallId,
    ...(toolName ? { toolName } : {}),
    ...mirrorScheduleFields(payload, context.agentId),
    agentId: context.agentId,
    agentType: context.agentType,
    ...(context.background ? { background: true } : {}),
    childSessionId: context.childSessionId,
    childToolCallId,
    description: context.description,
    parentToolCallId: context.parentToolCallId,
    source: SUBAGENT_EVENT_SOURCE,
  };

  return createSessionEvent(event.type, context.parentSessionId, mirroredPayload, {
    traceId: event.traceId,
    turnId: context.parentTurnId,
  });
}

/**
 * 只镜像交互事件（PermissionRequested / Resolved / Denied），不镜像工具活动。
 * 供 class 外构造的子 runtime（dwf actor）使用：它们的工具活动有自己的呈现面（run 卡片 /
 * 子会话 transcript），父 timeline 不该出现；但确认窗只从父会话的实时投影生成，交互必须过来
 * （docs/dynamic-workflow/launch.md「Permissions inside a run」）。
 */
export function mirrorSubagentInteractionEvent(
  event: SessionEvent,
  context: SubagentInteractionOriginContext,
): SessionEvent | undefined {
  if (!MIRRORED_INTERACTION_EVENT_TYPES.has(event.type)) return undefined;
  const payload = asRecord(event.payload);
  const childToolCallId = stringField(payload, "toolCallId");
  if (!childToolCallId) return undefined;
  return mirrorInteraction(
    event,
    payload,
    mirroredToolCallId(context.agentId, childToolCallId),
    stringField(payload, "toolName"),
    context,
  );
}

// 装配交互事件的镜像 payload：统一重写 toolCallId、补 childSessionId/background，
// 并仅在 PermissionRequested 上附加 origin（其余事件不需要来源用于确认窗路由）。
// traceId 沿用子事件，turnId 固定为父 turn；sessionId 指向父会话。
function mirrorInteraction(
  event: SessionEvent,
  payload: Record<string, unknown>,
  toolCallId: ToolCallId,
  toolName: string | undefined,
  context: SubagentInteractionOriginContext & { background?: boolean },
): SessionEvent {
  // 修复原因：V4 只从父 task 的实时投影生成阻塞交互；仅转发 broker request 会让
  // 子 agent 的 permission / AskUserQuestion 停留在子 session，父界面无法响应。
  const mirroredPayload = {
    ...payload,
    toolCallId,
    ...(toolName ? { toolName } : {}),
    childSessionId: context.childSessionId,
    ...(context.background ? { background: true } : {}),
    ...(event.type === SessionEventType.PermissionRequested
      ? { origin: buildSubagentInteractionOrigin(context, event.turnId) }
      : {}),
  };
  return createSessionEvent(event.type, context.parentSessionId, mirroredPayload, {
    traceId: event.traceId,
    turnId: context.parentTurnId,
  });
}

// 重写调度相关字段中的 id 引用：dependencies、schedule.executionOrder、
// schedule.parallelGroups 里的子 toolCallId 都需映射为镜像后的全局 id，
// 否则父级投影会指向不存在的调用。非字符串元素原样保留，缺失字段不产出。
function mirrorScheduleFields(
  payload: Record<string, unknown>,
  agentId: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (Array.isArray(payload.dependencies)) {
    fields.dependencies = payload.dependencies
      .filter((value): value is string => typeof value === "string")
      .map((id) => mirroredToolCallId(agentId, id));
  }

  const schedule = asRecord(payload.schedule);
  if (Object.keys(schedule).length > 0) {
    fields.schedule = {
      ...schedule,
      executionOrder: stringArrayField(schedule, "executionOrder").map((id) =>
        mirroredToolCallId(agentId, id),
      ),
      parallelGroups: arrayField(schedule, "parallelGroups").map((group) =>
        Array.isArray(group)
          ? group
              .filter((id): id is string => typeof id === "string")
              .map((id) => mirroredToolCallId(agentId, id))
          : group,
      ),
    };
  }

  return fields;
}

// 生成镜像 toolCallId：`tool_subagent_<agentId>_<childToolCallId>`，保证父级全局唯一。
// 拼接后强转为 ToolCallId（品牌类型），不校验字符集。
function mirroredToolCallId(agentId: string, childToolCallId: string): ToolCallId {
  return `${SUBAGENT_TOOL_CALL_ID_PREFIX}_${agentId}_${childToolCallId}` as ToolCallId;
}

// payload 归一：非对象/数组/空值统一为空对象，便于后续按键安全取值。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// 取字符串字段：类型不符（含 undefined/空值）时返回 undefined，不做隐式转换。
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

// 取数组字段：非数组一律返回空数组，调用方可安全 map/filter。
function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

// 取字符串数组字段：过滤掉非字符串元素，保证返回值可直接当作 id 列表使用。
function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return arrayField(record, key).filter((value): value is string => typeof value === "string");
}
