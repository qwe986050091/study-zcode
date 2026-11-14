// 高速卡服务契约：为「准备一轮对话」与卡片健康度查询提供统一注入面，UI 不接触执行细节。
// 边界：prepareTurn 只做卡片选择与预算校验，模型调用发生在 agent 运行时侧。
// INV：invalidateCard 返回 false 表示卡片已不可用，调用方必须重新取卡，不能复用旧卡。
import type {
  HighspeedCardUsage,
  HighspeedPrepareTurnParams,
  HighspeedPrepareTurnResult,
  HighspeedServiceSnapshot,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// healthy 是只读探针；不要用它做限流或准入判断，并发下结果可能立刻过期。
export interface IHighspeedCardService {
// prepareTurn 需幂等：同一 turn 重复调用应返回同一张卡，避免重复消耗预算。
  prepareTurn(params: HighspeedPrepareTurnParams): Promise<HighspeedPrepareTurnResult>;
  getSnapshot(): Promise<HighspeedServiceSnapshot>;
  invalidateCard(cardId: string): Promise<boolean>;
  healthy(cardId: string): Promise<HighspeedCardUsage>;
}

// 频道即身份：改频道名会同时断开 RPC 注册与既有调用方路由，属于破坏性变更。
export const IHighspeedCardService = createServiceDescriptor<IHighspeedCardService>(
  ServiceChannels.HighspeedCard,
);
