// 加速指标回填组：setHighspeedMetrics。
// 指标挂在**用户输入**行（userInput），由客户端本地测量后回填；
// 服务端只做行类型校验与持久化，不重算、不推断缺失值。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4RowTranslationError } from "./fork-edit-retry.js";

/**
 * setHighspeedMetrics：回填某一轮输入的加速统计（TPS、耗时拆分等）。
 * 输入：target（entityId/rowId）+ 指标；rowId 必须翻译为 userInput 行的 messageId，
 * 否则拒绝（避免把指标挂到助手行或错误轮次）。
 * 副作用：host.setHighspeedMetrics 持久化并推进投影；ACK 只表示「已接纳」。
 * 失败：宿主未注入 → highspeedMetricsUnsupported；持久化异常上抛，不吞错。
 * 幂等：同一行覆盖写；缺省的可选耗时字段不下发（undefined ≠ 0）。
 */
async function setHighspeedMetrics(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setHighspeedMetrics"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "setHighspeedMetrics",
  );
  if (!resolution?.ok || !resolution.messageId || resolution.row.kind !== "userInput") {
    throw new V4RowTranslationError("setHighspeedMetrics", payload.target.rowId);
  }
  if (!host.setHighspeedMetrics) throw new Error("fault.command.highspeedMetricsUnsupported");
  await host.setHighspeedMetrics(record.app.sessionId, {
    entityId: payload.target.entityId,
    messageId: resolution.messageId,
    metrics: {
      regularTps: payload.regularTps,
      outputTokens: payload.outputTokens,
      durationMs: payload.durationMs,
      highspeedTps: payload.highspeedTps,
      savedDurationMs: payload.savedDurationMs,
      ...(payload.modelDurationMs !== undefined
        ? { modelDurationMs: payload.modelDurationMs }
        : {}),
      ...(payload.toolDurationMs !== undefined ? { toolDurationMs: payload.toolDurationMs } : {}),
      ...(payload.otherDurationMs !== undefined
        ? { otherDurationMs: payload.otherDurationMs }
        : {}),
    },
  });
  return undefined;
}

/** 本组原生命令注册表（加速指标回填），供 handlers/index.ts 合并。 */
export const highspeedMetricsHandlers = { setHighspeedMetrics };
