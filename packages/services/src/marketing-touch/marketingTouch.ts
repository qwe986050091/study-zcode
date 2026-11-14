// 营销触达契约：定义客户端与宿主之间查询投放快照、回传确认或取消动作的 RPC 边界。
// INV：query 的返回值必须带上本次请求的 scope，上层依赖它做归属判定与幂等计数，缺失会导致投放重复统计。
// INV：actionType 仅允许 confirm 与 cancel 两个终态语义，扩展取值必须先改 shared 协议，否则宿主会丢弃未知动作且无提示。
// 维护提示：本文件只放类型声明与频道描述符，禁止引入实现依赖，以免把服务端逻辑打进客户端包。
import { ServiceChannels, type MarketingTouchSnapshot } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

export interface IMarketingTouchService {
  query(input: { locale: "zh-CN" | "en-US" }): Promise<MarketingTouchSnapshot & { scope: string }>;
  report(input: {
    locale: "zh-CN" | "en-US";
    scope: string;
    campaignId: string;
    actionType: "confirm" | "cancel";
  }): Promise<void>;
}
// 描述符的频道必须与 ServiceChannels.MarketingTouch 一致：改频道等同改线上协议，新旧版本将互相不可达。
export const IMarketingTouchService = createServiceDescriptor<IMarketingTouchService>(
  ServiceChannels.MarketingTouch,
);
