import type { IChannel } from "@zcode/rpc";
import { zcodeTopicResourceRelayRequestSchema } from "@zcode/shared";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import { readTrustedZCodeAgentV4Connection } from "./zcodeAgentConnectionScope.js";

// 每个已鉴权连接对应一个 Peer：channel 用于回取，
// routes 记录它登记过的复合路由，closed 用来阻止断连后继续登记。
interface Peer {
  channel: IChannel;
  routes: Map<string, string>;
  closed: boolean;
}

/** 共用 Server 只维护已鉴权连接的资源返回路由，不保存任务或队列状态。 */
export function createTopicResourcePeers() {
// 路由表的键是 identity+session 的组合串，路径只作为 identity 的兜底；
// 单用路径会让两个远端同名 workspace 互相覆盖。
  const owners = new Map<string, Peer>();
// JSON.stringify 生成无歧义组合键：分隔符不会与 identity 内容冲突，
// trim 与全局 identity 规则保持一致。
  const key = (identity: string, session: string) => JSON.stringify([identity.trim(), session]);
  return {
    getChannel(value: unknown): IChannel {
      const request = zcodeTopicResourceRelayRequestSchema.parse(value);
      const peer = owners.get(key(request.workspaceIdentity, request.remoteSessionId));
// 已关闭的连接不再作为资源来源：宁可报不可用，也不向死连接发起反向调用。
      if (!peer || peer.closed) throw new Error("Topic resource source peer unavailable");
      return peer.channel;
    },
    attach(channel: IChannel) {
// 每次 attach 都是独立 Peer，路由集合随连接生命周期创建与销毁。
      const peer: Peer = { channel, routes: new Map(), closed: false };
      const bind = (value: unknown) => {
        // 断连后只停止登记；旧 facade 仍需通过 base 完成 unsubscribe/flow cleanup。
// closed 是单向标志：一旦置位不再恢复，避免复用已释放的 channel；
        if (peer.closed) return;
        // 公共参数不能声明来源；只有连接 facade 写入的可信 carrier 可以登记返回路由。
// [事务] 只信任连接 facade 写入的 carrier 字段：
// 公共参数可以伪造 identity，不能据此登记返回路由。
        if (!readTrustedZCodeAgentV4Connection(value)) return;
        const request = value as Record<string, unknown>;
        if (request.remoteSessionId === undefined) return;
        if (
          typeof request.remoteSessionId !== "string" ||
          !request.remoteSessionId ||
          typeof request.workspaceIdentity !== "string" ||
          !request.workspaceIdentity.trim()
        )
// 空串或非字符串一律拒绝：路由键必须来自可信且非空的远端身份。
          throw new Error("Topic resource remote identity unavailable");
        const route = key(request.workspaceIdentity, request.remoteSessionId);
        const owner = owners.get(route);
// [并发] 同一条路由只能属于一个 Peer；被别的连接占用时报错，
// 否则资源会被错误地回传给另一个远端。
        if (owner && owner !== peer)
          throw new Error("Topic resource route belongs to another peer");
        const previous = peer.routes.get(request.remoteSessionId);
        if (previous && previous !== route && owners.get(previous) === peer)
          owners.delete(previous);
        owners.set(route, peer);
        peer.routes.set(request.remoteSessionId, route);
      };
      return {
        wrapAgent(base: IZCodeAgentService): IZCodeAgentService {
// 用 Proxy 包住 agent：每次方法调用都先尝试登记路由，再原样转发，
// 这样无需在每个业务方法里手写绑定逻辑。
          return new Proxy(base, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                bind(args[0]);
                return value.apply(target, args);
              };
            },
          });
        },
// [资源] 断连清理：先置 closed 阻止新登记，再只删除仍属于本 Peer 的路由。
        dispose() {
// closed 置位后，迟到的 bind 调用会直接返回，不会把死连接重新写回路由表。
          peer.closed = true;
          for (const route of peer.routes.values())
            if (owners.get(route) === peer) owners.delete(route);
          peer.routes.clear();
        },
      };
    },
  };
}
export type TopicResourcePeers = ReturnType<typeof createTopicResourcePeers>;
