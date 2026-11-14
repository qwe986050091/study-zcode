import { SessionEventType, type SessionEvent, type ToolCallResultPayload } from "@zcode/contracts";
import {
  cuaPermissionObservationSchema,
  cuaRequestAccessStatusSchema,
  requiredCuaPermissionsForRequestAccessStatus,
  type CuaPermissionObservation,
} from "@zcode/shared/zcode-protocol-v4";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 将当前进程收到的可信 CUA ToolCallResult 投影为一次性权限观察。
 * 历史恢复没有 SessionEvent 输入，因此不能在这里补造权限 UI 副作用。
 */
export class CuaPermissionObservationNormalizer {
  /**
   * 只对“CUA request_access 成功返回且权限状态可识别”的 ToolCallResult 产出观察。
   * 输入：当前 live 事件的所属 sessionId + 原始 SessionEvent；输出：带 eventId/seq/
   * occurredAt 的快照对象，或 null（表示本条事件与权限无关）。本方法无副作用、不做去重，
   * 相同事件重复传入会得到相同结果；上层应按 eventId 幂等消费。
   * 降级：display 形状不符、permissionStatus 解析失败、所需权限集合为空时一律返回 null，
   * 不猜测、不补造 UI；冷恢复（hydrate 出来的事件）不应走这里。
   */
  normalize(sessionId: string, event: SessionEvent): CuaPermissionObservation | null {
    if (event.type !== SessionEventType.ToolCallResult) return null;

    const payload = event.payload as ToolCallResultPayload;
    const display = payload.result.display;
    if (
      !isRecord(display) ||
      display.kind !== "cua" ||
      display.toolName !== "request_access" ||
      display.status !== "success"
    ) {
      return null;
    }

    const parsedStatus = cuaRequestAccessStatusSchema.safeParse(
      (display as Record<string, unknown>).permissionStatus,
    );
    if (
      !parsedStatus.success ||
      requiredCuaPermissionsForRequestAccessStatus(parsedStatus.data).length === 0
    ) {
      return null;
    }

    const parsedObservation = cuaPermissionObservationSchema.safeParse({
      schemaVersion: 1,
      eventId: String(event.id),
      eventSeq: event.sequenceNumber,
      occurredAt: event.timestamp.getTime(),
      sessionId,
      ...(event.turnId ? { turnId: String(event.turnId) } : {}),
      toolCallId: payload.toolCallId,
      permissionStatus: parsedStatus.data,
    });
    return parsedObservation.success ? parsedObservation.data : null;
  }
}
