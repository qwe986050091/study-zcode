// 网络请求事件到侧栏记录的投影。
// 职责：校验事件字段，置顶去重地维护最近 8 条请求记录。
// 边界：只记录观测数据，不发起请求、不改请求本身。
// 副作用：写 React 状态，并在失败/重试/停滞时更新状态栏文案。
// 降级：关键字段缺失直接忽略；source 缺失记为 unknown；startedAt 缺失用当前时间兜底。

import type { TuiCopy } from "@zcode/i18n";
import type React from "react";
import type { NetworkRequest } from "./app-model.js";
import { modelNetworkRequestTargetFromPayload } from "./app-event-data.js";
import { formatDuration, numberField, stringField } from "./state.js";

const MAX_NETWORK_REQUESTS = 8;
const MODEL_HTTP_METHOD = "POST";
const MODEL_NETWORK_SOURCE = "model";
const UNKNOWN_NETWORK_SOURCE = "unknown";

// 处理通用网络请求事件：校验关键字段后写入请求列表。
// 输入：payload 需具备非空 requestId/method/url 且 status ∈ pending|complete|error，
// 任一缺失则直接返回（视为无效/不关心的事件，不报错也不记录）。
// 输出：无返回值；通过 setNetworkRequests 以“置顶去重 + 最多 8 条”方式更新。
// 口径：id 使用 requestId（同一请求的后续事件据此覆盖旧记录）；startedAt 缺失时以当前时间兜底；
// updatedAt 每次都取当前时间。source 缺失记作 "unknown"。
// 副作用：写 React 状态；无 IO/日志。
export function applyNetworkRequestEvent(
  payload: Record<string, unknown>,
  setNetworkRequests: React.Dispatch<React.SetStateAction<NetworkRequest[]>>,
): void {
  const requestId = stringField(payload, "requestId");
  const method = stringField(payload, "method");
  const url = stringField(payload, "url");
  const status = payload.status;
  if (
    !requestId ||
    !method ||
    !url ||
    (status !== "pending" && status !== "complete" && status !== "error")
  ) {
    return;
  }

  const now = new Date().toISOString();
  const request: NetworkRequest = {
    attempt: numberField(payload, "attempt"),
    completedAt: stringField(payload, "completedAt"),
    durationMs: numberField(payload, "durationMs"),
    error: stringField(payload, "error"),
    id: requestId,
    method,
    requestId,
    source: stringField(payload, "source") ?? UNKNOWN_NETWORK_SOURCE,
    startedAt: stringField(payload, "startedAt") ?? now,
    status,
    statusCode: numberField(payload, "statusCode"),
    updatedAt: now,
    url,
  };

  setNetworkRequests((current) => prependNetworkRequest(current, request));
}

// 处理模型专属网络事件（请求开始/完成/失败/流停滞/重试计划）。
// 输入：payload.type 与 requestId 必需，缺失则忽略；其余字段均可选。
// 输出：无返回值；更新网络记录列表，并在重试/失败/停滞时经 setStatus 展示文案。
// 状态映射：failed 与 stream_stalled → error；completed → complete；其余类型 → pending。
// 副作用：写 React 状态；文案取自传入的 copy（国际化），本函数不直接操作终端。
// 口径：pending 时 completedAt 为 undefined；startedAt/updatedAt 均为事件到达时间。
export function applyModelNetworkEvent(
  payload: Record<string, unknown>,
  setNetworkRequests: React.Dispatch<React.SetStateAction<NetworkRequest[]>>,
  setStatus: (status: string) => void,
  copy: TuiCopy,
): void {
  const type = stringField(payload, "type");
  const requestId = stringField(payload, "requestId");
  if (!type || !requestId) return;

  const target = modelNetworkRequestTargetFromPayload(payload);
  const now = new Date().toISOString();
  const status =
    type === "model_request_failed" || type === "model_stream_stalled"
      ? "error"
      : type === "model_request_completed"
        ? "complete"
        : "pending";
  const request: NetworkRequest = {
    attempt: numberField(payload, "attempt"),
    completedAt: status === "pending" ? undefined : now,
    durationMs: numberField(payload, "durationMs"),
    error: stringField(payload, "message") ?? stringField(payload, "reason"),
    id: requestId,
    method: MODEL_HTTP_METHOD,
    model: target.model,
    provider: target.provider,
    requestId,
    source: MODEL_NETWORK_SOURCE,
    startedAt: now,
    status,
    statusCode: numberField(payload, "statusCode"),
    updatedAt: now,
    url: target.url,
  };
  setNetworkRequests((current) => prependNetworkRequest(current, request));

  if (type === "model_retry_scheduled") {
    const attempt = numberField(payload, "attempt") ?? 1;
    const maxAttempts = numberField(payload, "maxAttempts") ?? attempt;
    const delayMs = numberField(payload, "delayMs");
    const reason = stringField(payload, "reason") ?? "retry";
    setStatus(
      copy.model.retryScheduled({
        attempt,
        delay: formatDuration(delayMs),
        maxAttempts,
        reason,
      }),
    );
  } else if (type === "model_request_failed") {
    const message = stringField(payload, "message") ?? "request failed";
    setStatus(copy.model.requestFailed(message));
  } else if (type === "model_stream_stalled") {
    setStatus(copy.model.streamStalled);
  }
}

// 置顶插入并去重：同 id 旧记录先移除再放到队首，最后截断到 MAX_NETWORK_REQUESTS。
// 截断放在去重之后，保证同一请求的多次更新不会因列表上限被提前挤掉。
function prependNetworkRequest(
  current: NetworkRequest[],
  request: NetworkRequest,
): NetworkRequest[] {
  return [request, ...current.filter((item) => item.id !== request.id)].slice(
    0,
    MAX_NETWORK_REQUESTS,
  );
}
