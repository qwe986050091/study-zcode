import { createHash } from "node:crypto";

export interface BuildAgentTelemetrySpawnEnvInput {
  telemetryEnv: Record<string, string>;
  deviceMid?: string;
  userId?: string;
  runtimeSurface: "desktop_local_host" | "remote_workspace_host";
}

// 只有宿主确实配置了 OTLP 端点时才注入遥测环境；否则子进程不应带任何遥测字段。
// 身份字段都在这里派生，调用方无法直接写入 subject 以外的账号信息。
export function buildAgentTelemetrySpawnEnv(
  input: BuildAgentTelemetrySpawnEnvInput,
): Record<string, string> {
  if (
    !input.telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT &&
    !input.telemetryEnv.OTEL_EXPORTER_OTLP_ENDPOINT
  ) {
// 无端点即无导出目标：返回空对象，避免把半套配置交给 Agent。
    return {};
  }
// 先 trim 再判空：空白字符串不应被当作有效设备标识。
  const deviceMid = input.deviceMid?.trim();
  const userId = input.userId?.trim();
  return {
    ...input.telemetryEnv,
// 设备标识按需展开：缺失时不下发空串，避免被下游当成真实 mid。
    ...(deviceMid ? { ZCODE_TELEMETRY_DEVICE_MID: deviceMid } : {}),
    ...(userId
      ? {
// [事务] 状态与 subject 必须成对出现：只有 authenticated 才携带哈希后的用户 subject，
// 反过来说，没有 subject 也不会声称已登录。
          ZCODE_TELEMETRY_IDENTITY_STATE: "authenticated",
          // Desktop 原始账号只在 Host 凭据边界可见；Agent 仅收到不可读的 subject，
          // Trace 可以按用户关联，但不会上传账号、邮箱或登录名。
          ZCODE_TELEMETRY_USER_SUBJECT_ID: createHash("sha256")
            .update(userId)
            .digest("hex"),
        }
      : {
// 未登录时区分 anonymous 与 unknown：有设备标识才算匿名，
// 两者都没有则如实标记为未知，便于后续归因。
          ZCODE_TELEMETRY_IDENTITY_STATE: deviceMid ? "anonymous" : "unknown",
        }),
    ZCODE_TELEMETRY_RUNTIME_SURFACE: input.runtimeSurface,
  };
}
