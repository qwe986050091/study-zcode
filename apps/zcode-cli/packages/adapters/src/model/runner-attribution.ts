/**
 * runner-status.ts 顶到 oxlint max-lines 上限（400 行），把「请求归因 header」一族
 * （header 常量、内部前缀剥离、session-type 推断）拆到本文件；公开面仍从 runner-status.ts 导出。
 *
 * 与 runner-status.ts 的依赖方向：本文件只 `import type` 它的 `ModelStatusContext`，运行时不成环。
 *
 * 定位：只生成跨网络边界的观测归因头；span 等细粒度信息留在事件/日志，不进 header。
 * 输入：ModelStatusContext（requestId/traceId/sessionId/queryId/querySource/baseURL 等）。
 * 输出：header 映射；缺省值按"能省则省"省略对应键。
 * 副作用：无（纯拼接）。失败语义：非法 querySource 只省略该头，绝不让请求因头校验失败。
 */

import type {
  ModelRequestSessionType as ModelRequestSessionTypeValue,
  ResolvedModelApiCallObservation,
} from "@zcode/contracts";
import { ModelApiActorKind, ModelApiOperation, ModelRequestSessionType } from "@zcode/contracts";
import { isOpenCodeGoBaseUrl } from "./opencode-session.js";
import { MODEL_QUERY_SOURCE_HEADER } from "./model-request-headers.js";
import type { ModelStatusContext } from "./runner-status.js";

const MODEL_TRACE_HEADER = "x-zcode-trace-id";
const MODEL_REQUEST_HEADER = "x-request-id";
const MODEL_SESSION_HEADER = "x-session-id";
const MODEL_QUERY_HEADER = "x-query-id";
// Coding Plan 服务端使用该请求级 Header 区分 main/subagent/side_chat/other 来源。
// 它不是 Provider 静态能力或鉴权材料，必须由调用上下文生成并覆盖同名静态 Header。
const MODEL_SESSION_TYPE_HEADER = "x-zcode-session-type";
const SESSION_ID_INTERNAL_PREFIX = "sess_";
const SESSION_ID_SUBAGENT_PREFIX = "subagent_agent_";
const QUERY_ID_INTERNAL_PREFIX = "query_";
const QUERY_SOURCE_HEADER_VALUE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

/**
 * 生成一次模型请求的归因头：request-id / trace-id 必带；session-type 非法值降级为 Other；
 * query/session/query-source 可选，opencode 网关额外补 x-opencode-session。
 * sessionId/queryId 会先剥离 CLI 内部前缀，避免实现细节泄露到上游。
 */
export function createModelRequestAttributionHeaders(
  statusContext: ModelStatusContext,
): Record<string, string> {
  const sessionHeaderValue = normalizeModelSessionIdForAttribution(statusContext.sessionId);
  const queryHeaderValue = modelQueryHeaderValue(statusContext.queryId);
  const querySource = statusContext.querySource?.trim();
  // querySource 是观测标识；非法字符或过长值只省略，避免 HTTP 头校验阻断模型请求。
  const querySourceHeaderValue =
    querySource && QUERY_SOURCE_HEADER_VALUE_PATTERN.test(querySource) ? querySource : undefined;
  const openCodeSessionHeaderValue = isOpenCodeGoBaseUrl(statusContext.baseURL)
    ? sessionHeaderValue
    : undefined;
  // 只把跨 provider 网络边界需要的观测归因字段写入 header，span 等细粒度信息仍留在事件和日志里。
  return {
    [MODEL_REQUEST_HEADER]: statusContext.requestId,
    [MODEL_SESSION_TYPE_HEADER]: isModelRequestSessionType(statusContext.modelRequestSessionType)
      ? statusContext.modelRequestSessionType
      : ModelRequestSessionType.Other,
    [MODEL_TRACE_HEADER]: statusContext.traceId,
    ...(queryHeaderValue ? { [MODEL_QUERY_HEADER]: queryHeaderValue } : {}),
    ...(querySourceHeaderValue ? { [MODEL_QUERY_SOURCE_HEADER]: querySourceHeaderValue } : {}),
    ...(sessionHeaderValue ? { [MODEL_SESSION_HEADER]: sessionHeaderValue } : {}),
    ...(openCodeSessionHeaderValue ? { "x-opencode-session": openCodeSessionHeaderValue } : {}),
  };
}

/**
 * 解析请求来源类型：显式合法值优先；否则仅当 operation 是 AgentStep 时，
 * 按 actorKind 判定 Main/Subagent，其余（含非 AgentStep 的旁路调用）一律 Other。
 */
export function resolveModelRequestSessionType(
  explicitType: unknown,
  modelCall: Pick<ResolvedModelApiCallObservation, "actorKind" | "operation">,
): ModelRequestSessionTypeValue {
  if (isModelRequestSessionType(explicitType)) return explicitType;
  if (modelCall.operation !== ModelApiOperation.AgentStep) {
    return ModelRequestSessionType.Other;
  }
  if (modelCall.actorKind === ModelApiActorKind.MainAgent) {
    return ModelRequestSessionType.Main;
  }
  if (modelCall.actorKind === ModelApiActorKind.Subagent) {
    return ModelRequestSessionType.Subagent;
  }
  return ModelRequestSessionType.Other;
}

function isModelRequestSessionType(value: unknown): value is ModelRequestSessionTypeValue {
  return (
    value === ModelRequestSessionType.Main ||
    value === ModelRequestSessionType.Subagent ||
    value === ModelRequestSessionType.SideChat ||
    value === ModelRequestSessionType.Other
  );
}

/**
 * sessionId 归一为可外发的 header 值：空/缺失返回 undefined（不写头）；
 * 否则剥离 sess_ 与 subagent_agent_ 前缀；若剥离后为空则回退原值，保证不产生空 header。
 */
export function normalizeModelSessionIdForAttribution(
  sessionId: ModelStatusContext["sessionId"],
): string | undefined {
  if (!sessionId) return undefined;
  // 内部 SessionId/QueryId 前缀只服务于 CLI 存储和事件归因；provider header
  // 是跨网络观测字段，不能把 query_/subagent_agent_ 这类实现前缀暴露给上游。
  return stripHeaderInternalPrefixes(sessionId, [
    SESSION_ID_INTERNAL_PREFIX,
    SESSION_ID_SUBAGENT_PREFIX,
  ]);
}

/** queryId 归一：缺失即 undefined；只剥离 query_ 前缀。 */
function modelQueryHeaderValue(queryId: ModelStatusContext["queryId"]): string | undefined {
  if (!queryId) return undefined;
  return stripHeaderInternalPrefixes(queryId, [QUERY_ID_INTERNAL_PREFIX]);
}

/**
 * 依次剥离前缀；仅当剥完仍有内容才接受，否则保留原值。
 * 目的：既隐藏内部实现前缀，又不把纯前缀字符串变成空 header。
 */
function stripHeaderInternalPrefixes(value: string, prefixes: string[]): string {
  let headerValue = value;
  for (const prefix of prefixes) {
    if (headerValue.startsWith(prefix) && headerValue.length > prefix.length) {
      headerValue = headerValue.slice(prefix.length);
    }
  }
  return headerValue || value;
}
