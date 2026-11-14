import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerResult,
} from "../deps.js";

/**
 * 带"结果回填"能力的 broker 形状：除端口契约的 requestPermission 外，还能按
 * requestId / toolCallId 把外部（UI、V4 客户端、子代理）的决定写回等待中的 Promise。
 * 该接口只用于类型收窄，不构造、不修改 broker 本身。
 */
interface ResolvablePermissionBroker extends PermissionBrokerPort {
  resolvePermission(requestIdOrToolCallId: string, result: PermissionBrokerResult): boolean;
}

/**
 * 带"待决清单"能力的 broker 形状：可枚举尚未 resolve 的请求，供冷恢复/
 * 重连后补发确认窗与去重使用。listPendingRequests 必须是无副作用的只读快照。
 */
interface InspectablePermissionBroker extends PermissionBrokerPort {
  listPendingRequests(): PermissionBrokerRequest[];
}

/**
 * 判定 broker 是否支持 resolvePermission（结构判定，不依赖实现类）。
 * 输入/输出：任意 PermissionBrokerPort → 类型谓词；不抛错、无副作用。
 * 兼容语义：可选端口（本地内存 broker、旧宿主实现）可能只实现请求不实现回填，
 *   此时返回 false，调用方应走"无法主动 resolve"的降级路径而不是假定能力存在。
 */
export function isResolvablePermissionBroker(
  broker: PermissionBrokerPort,
): broker is ResolvablePermissionBroker {
  return typeof (broker as Partial<ResolvablePermissionBroker>).resolvePermission === "function";
}

/**
 * 判定 broker 是否支持 listPendingRequests。用于需要枚举在飞权限请求的场景
 * （如恢复后重放确认窗、断开连接时统一收口）。
 * 失败语义：能力缺席返回 false，调用方不得把 false 当作"没有待决请求"。
 */
export function isInspectablePermissionBroker(
  broker: PermissionBrokerPort,
): broker is InspectablePermissionBroker {
  return typeof (broker as Partial<InspectablePermissionBroker>).listPendingRequests === "function";
}
