import { zcodeProtocolMethods, zcodeRuntimeCapabilitiesSchema } from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

// 按 client 缓存探测结果：同一连接只探测一次，成功即长期有效；
// 用 WeakMap 让 client 被回收后缓存自动消失，不会跨连接复用结论。
const checks = new WeakMap<object, Promise<void>>();

/** Host 更新不代表远端 CLI 已更新；旧 CLI 会剥掉 Plan 字段，必须在发送前确认执行端。 */
export function ensureIndependentPlanSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
// 命中缓存直接返回同一个 Promise，并发调用不会重复发探测请求。
  const cached = checks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
// [失败路径] 只接受严格 true：字段缺失或为假都视为不支持，
// 防止旧 CLI 忽略该字段时被误判为已支持。
      if (result.independentPlanState !== true) throw new Error("proto.independentPlanUnsupported");
    })
    .catch((cause: unknown) => {
// 探测失败不写缓存，允许下次重试；失败结论可能是暂时性的。
      checks.delete(client);
      throw new Error("proto.independentPlanUnsupported", { cause });
    });
  checks.set(client, check);
  return check;
}

// historyFirst 与 independentPlan 分开缓存：前者导出布尔值而非抛错，
// 两者语义不同，不能共用同一个 Promise。
const historyChecks = new WeakMap<object, Promise<boolean>>();
/** 远端旧 CLI 的 strict subscribe 不接受新字段，能力确认后才转发。 */
export function supportsHistoryFirst(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<boolean> {
  const existing = historyChecks.get(client);
  if (existing) return existing;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
// 同样只认严格 true，其余一律视为不支持。
    .then((result) => result.historyFirst === true)
    .catch(() => {
      historyChecks.delete(client);
// [权衡] 探测异常降级为 false 而不是抛错：调用方据此走旧路径即可。
      return false;
    });
  historyChecks.set(client, check);
  return check;
}
