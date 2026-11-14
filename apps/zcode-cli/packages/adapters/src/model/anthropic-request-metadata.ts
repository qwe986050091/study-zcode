// ============================================================
// Anthropic 请求 metadata.user_id 生成与脱敏
// 定位：官方 Anthropic 端点要求 metadata.user_id 携带设备与会话归因，但落盘/日志时不能泄露明文。
// 输入：设备 mid、sessionId、providerKind、env。输出：JSON 字符串 / undefined / 脱敏后的同形值。
// 副作用：resolve 会读取或初始化 CLI 设备 mid（可能写本地设备文件）。
// 失败语义：非 anthropic 返回 undefined（不生成）；脱敏解析失败时原样返回，不抛错。
// 不变量：user_id 结构固定为 {device_id, account_uuid:"", session_id}；redact 只替换 user_id 字段。
// ============================================================

import { ensureCliDeviceMid } from "../device/cli-device-mid.js";
import type { EnvRecord } from "./model-execution.js";
import { normalizeModelSessionIdForAttribution, type ModelStatusContext } from "./runner-status.js";

const REDACTED_METADATA_USER_ID = "[REDACTED]";

/**
 * 构造 metadata.user_id JSON。account_uuid 固定为空串（该字段不由 adapter 填充）；
 * sessionId 缺失时写 "" 而不是省略键，保证线上结构与服务端预期一致。
 */
export function createAnthropicRequestMetadataUserId(input: {
  deviceMid: string;
  sessionId?: ModelStatusContext["sessionId"];
}): string {
  return JSON.stringify({
    device_id: input.deviceMid,
    account_uuid: "",
    session_id: normalizeModelSessionIdForAttribution(input.sessionId) ?? "",
  });
}

/**
 * 按 providerKind 决定是否生成 user_id：仅 anthropic 需要，其它 provider 返回 undefined，
 * 避免把设备标识发给无关上游。生成前确保设备 mid 已存在（可能触发一次性落盘）。
 */
export async function resolveAnthropicRequestMetadataUserId(input: {
  env: EnvRecord;
  providerKind: string | undefined;
  sessionId?: ModelStatusContext["sessionId"];
}): Promise<string | undefined> {
  if (input.providerKind !== "anthropic") {
    return undefined;
  }

  const deviceMid = await ensureCliDeviceMid({ env: input.env });
  return createAnthropicRequestMetadataUserId({
    deviceMid,
    sessionId: input.sessionId,
  });
}

/**
 * 递归脱敏：JSON 字符串先解析再脱敏、有变化才重新 stringify（避免改变原始格式）；
 * 对象则把 wire 形态 `metadata.user_id` 与 SDK 形态 `providerOptions.anthropic.metadata.userId`
 * 统一替换为 [REDACTED]。非对象/解析失败原样返回，保证调用方永远拿到可用值。
 */
export function redactAnthropicRequestMetadata(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      const redacted = redactAnthropicRequestMetadata(parsed);
      return redacted === parsed ? value : JSON.stringify(redacted);
    } catch {
      return value;
    }
  }
  if (!isRecord(value)) {
    return value;
  }

  let result = value;
  const wireMetadata = isRecord(value.metadata) ? value.metadata : undefined;
  if (wireMetadata && wireMetadata.user_id !== undefined) {
    result = {
      ...result,
      metadata: {
        ...wireMetadata,
        user_id: REDACTED_METADATA_USER_ID,
      },
    };
  }

  const providerOptions = isRecord(value.providerOptions) ? value.providerOptions : undefined;
  const anthropicOptions = isRecord(providerOptions?.anthropic)
    ? providerOptions.anthropic
    : undefined;
  const providerMetadata = isRecord(anthropicOptions?.metadata)
    ? anthropicOptions.metadata
    : undefined;
  if (providerOptions && anthropicOptions && providerMetadata?.userId !== undefined) {
    result = {
      ...result,
      providerOptions: {
        ...providerOptions,
        anthropic: {
          ...anthropicOptions,
          metadata: {
            ...providerMetadata,
            userId: REDACTED_METADATA_USER_ID,
          },
        },
      },
    };
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
