// 服务注册中心：以 descriptor.channelName 为唯一键登记实例，并按暴露策略镜像到 ChannelServer。
// 边界：只负责注册与暴露，不构造实例、不做生命周期管理；鉴权必须在调用方完成，本层无权判定。
// INV：同一 channelName 重复 register 会静默覆盖，调用方须保证注册幂等且只注册一次。
// 改错后果：暴露策略放宽或漏配 overrides 会把内部服务直接暴露给对端，形成越权调用面。
import { ProxyChannel, type IChannelServer } from "@zcode/rpc";
import type { ServiceDescriptor } from "./descriptors.js";

export interface ServiceExposurePolicy {
  readonly allowedChannels: ReadonlySet<string>;
}

/**
 * ServiceCollection — 服务注册中心
 *
 * 服务端用来注册服务实例，并自动暴露到 ChannelServer。
 */
export class ServiceCollection {
  private readonly _services = new Map<string, unknown>();

  register<T>(descriptor: ServiceDescriptor<T>, instance: T): this {
    // 以 descriptor.channelName 为键写入 Map：重复 register 会静默覆盖旧实例，调用方必须保证只注册一次。
    this._services.set(descriptor.channelName, instance);
    // 返回 this 支持链式注册；但登记前不做存在性检查，链式重复注册同样会覆盖。
    return this;
  }

  get<T>(descriptor: ServiceDescriptor<T>): T {
    // 按 channelName 查实例；Map 不保存 descriptor 类型，取回时只能靠泛型断言还原调用方视角。
    const instance = this._services.get(descriptor.channelName);
    // 未注册必须抛错而不是返回 undefined：undefined 流到下游会变成更远的 TypeError，真实装配错误反而被掩盖。
    if (!instance) {
      throw new Error(`Service not registered: ${descriptor.channelName}`);
    }
    return instance as T;
  }

  getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined {
    // 可选查询供探活与测试使用；与 get 的唯一差别是缺省返回 undefined，不改变注册表本身。
    return this._services.get(descriptor.channelName) as T | undefined;
  }

  /** 将所有已注册的服务自动暴露为 channel */
// overrides 优先于已注册实例，用于替换测试桩或远端代理；循环内的注册表不在此方法内修改。
  exposeOnChannelServer(
    server: IChannelServer,
    overrides: ReadonlyMap<string, unknown> = new Map(),
    exposurePolicy?: ServiceExposurePolicy,
  ): void {
    // 直接迭代注册表：本方法只读不写，若在循环里 register 新服务，Map 迭代器会看到循环期间新增的条目。
    for (const [channelName, instance] of this._services) {
      // 配了 allowedChannels 就只暴露名单内服务：白名单漏写一项只会少暴露，写错条目才会越权。
      if (exposurePolicy && !exposurePolicy.allowedChannels.has(channelName)) continue;
      // overrides 优先于已注册实例，用于测试桩或远端代理替换；命中时不再读取原实例，也不会把桩写回注册表。
      const exposed = overrides.get(channelName) ?? instance;
      // ProxyChannel.fromService 把服务对象包成 channel；registerChannel 的键仍是 channelName，对端看到的地址与注册键一致。
      server.registerChannel(
        channelName,
        ProxyChannel.fromService(exposed as Record<string, unknown>),
      );
    }
  }
}
