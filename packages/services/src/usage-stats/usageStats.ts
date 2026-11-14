import type {
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanRegularTpsRequest,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@zcode/shared";
// 用量统计服务契约：App 用量、Coding Plan 用量与重置相关操作。
// 所有返回结构来自 @zcode/shared，services 只声明 RPC 形状，不做数据加工。
// 可选方法（如 getCodingPlanRegularTps）由实现按 provider 能力提供，调用前需判空。
// 本文件不含实现与网络请求。
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 读方法全部按请求参数返回快照；重置相关方法成对出现（查询状态、申请机会、使用）。
// 订阅类能力不在本契约内：用量变化由调用方按需轮询或在 UI 层合并。
export interface IUsageStatsService {
// App 维度的用量快照，与 Coding Plan 的额度体系相互独立。
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  getCodingPlanUsageSnapshot(request: CodingPlanUsageRequest): Promise<CodingPlanUsageSnapshot>;
  getCodingPlanRegularTps?(request: CodingPlanRegularTpsRequest): Promise<number | undefined>;
// 查询重置状态；scope 决定是个人还是 Team。
  getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot>;
// 申请重置机会与真正使用重置分开：前者可能失败且不改变状态。
  requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult>;
  useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult>;
  markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void>;
// 通用用量快照，供仪表盘汇总使用；与按需的 App/Coding Plan 快照并行存在。
// getEntitlementSnapshot 的请求参数可选：缺省表示查询当前登录身份的权益。
  getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot>;
  getEntitlementSnapshot(request?: UsageEntitlementRequest): Promise<UsageEntitlementSnapshot>;
}

// [契约] IUsageStatsService 用 ServiceChannels.UsageStats 绑描述符：频道名即协议面，改名须同步客户端桩。
export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
