/**
 * MCP 资源订阅登记表（纯内存，无 IO）。
 *
 * 输入输出：入参 serverName / uri / subscriberKey；add 返回是否首次订阅（0→1），
 * remove 返回是否最后一个（1→0）或 null（未登记），removeByPrefix 返回归零需退订的 uri。
 * 副作用：无 IO、无定时器；全部同步完成。
 * 失败语义：不抛错；未登记删除是幂等空操作。
 * 不变量：只有 0→1 / 1→0 会触发 adapter 向 server 发 subscribe/unsubscribe；
 * 多 session 共享连接时不重复订阅，前缀清理只影响匹配会话。
 * 键 = (serverName, uri) → subscriberKey 集合；同一连接被多个 session 共享时只向 server 订阅一次，
 * 所以 add 只在 0 → 1 时告诉调用方"该向 server 订阅"，remove 只在 1 → 0 时告诉调用方"该向 server 退订"。
 * 向 server 的实际请求、重连重放与日志都在 adapter；这里只管计数与快照。
 */
/**
 * 订阅计数表：serverName → uri → subscriberKey 集合。所有方法同步、无锁，依赖单线程。
 */
export class McpResourceSubscriptionRegistry {
  private readonly byServer = new Map<string, Map<string, Set<string>>>();

  /** 登记订阅者；first=true 表示该 (server, uri) 从 0→1，adapter 应向 server 发 subscribe。 */
  /** 登记一个订阅者；返回是否是该 (server, uri) 的第一个。 */
  add(serverName: string, uri: string, subscriberKey: string): { first: boolean } {
    const byUri = this.byServer.get(serverName) ?? new Map<string, Set<string>>();
    this.byServer.set(serverName, byUri);
    const subscribers = byUri.get(uri) ?? new Set<string>();
    const first = subscribers.size === 0;
    subscribers.add(subscriberKey);
    byUri.set(uri, subscribers);
    return { first };
  }

  /** 撤销订阅者；last=true 表示计数归零、uri 已删除，adapter 应向 server 发 unsubscribe。 */
  /** 撤销一个订阅者；未登记返回 null，否则返回它是不是最后一个（此时该 uri 已从表中移除）。 */
  remove(serverName: string, uri: string, subscriberKey: string): { last: boolean } | null {
    const byUri = this.byServer.get(serverName);
    const subscribers = byUri?.get(uri);
    if (!byUri || !subscribers || !subscribers.delete(subscriberKey)) return null;
    if (subscribers.size > 0) return { last: false };
    byUri.delete(uri);
    return { last: true };
  }

  /** 按前缀清理：只删匹配的 subscriberKey；仅当某 uri 归零时才加入需要退订的列表。 */
  /** 按 subscriberKey 前缀清理（会话关闭）；返回因此归零、需要向 server 退订的 (server, uri)。 */
  removeByPrefix(subscriberKeyPrefix: string): Array<{ serverName: string; uri: string }> {
    const released: Array<{ serverName: string; uri: string }> = [];
    for (const [serverName, byUri] of this.byServer) {
      for (const [uri, subscribers] of byUri) {
        for (const key of [...subscribers]) {
          if (key.startsWith(subscriberKeyPrefix)) subscribers.delete(key);
        }
        if (subscribers.size === 0) {
          byUri.delete(uri);
          released.push({ serverName, uri });
        }
      }
    }
    return released;
  }

  /** 某 uri 的订阅者（通知 resources/updated 时附上）。 */
  subscribers(serverName: string, uri: string): string[] {
    return [...(this.byServer.get(serverName)?.get(uri) ?? [])];
  }

  /** 某 server 全部订阅者去重（通知 resources/list_changed 时附上）。 */
  allSubscribers(serverName: string): string[] {
    const out = new Set<string>();
    for (const keys of this.byServer.get(serverName)?.values() ?? []) {
      for (const key of keys) out.add(key);
    }
    return [...out];
  }

  /** 某 server 登记过的 uri（重连后重放）。 */
  uris(serverName: string): string[] {
    return [...(this.byServer.get(serverName)?.keys() ?? [])];
  }

  /** 快照：serverName → uri → 订阅者数；只读，供测试/诊断，不参与业务判断。 */
  /** 快照（测试 / 诊断）：serverName → uri → 订阅者数。 */
  counts(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [serverName, byUri] of this.byServer) {
      out[serverName] = Object.fromEntries(
        [...byUri].map(([uri, subscribers]) => [uri, subscribers.size]),
      );
    }
    return out;
  }
}
