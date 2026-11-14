// bigmodel 订阅摘要 provider：把上游 coding plan 权益接口归一成统计侧需要的订阅信息，
// 用于展示当前套餐。调用方只关心 available 与 unknown 两种结果，
// 因此所有网络与解析异常都在本文件内消化并降级，不向上抛出。
import type { ApiClient, ProviderFamilyDomain } from "@zcode/shared";
import {
  fetchPersonalCodingPlanEntitlement,
  fetchTeamCodingPlanEntitlement,
  type CodingPlanEntitlement,
} from "#src/bigmodel/codingPlanEntitlement.js";
import { pickCurrentSubscriptionFromList } from "./bigmodelUsageQuotaMapper.js";

// 从订阅列表中挑出“当前生效”条目的结果类型；声明为非空，避免下游重复判空。
type SubscriptionSummary = NonNullable<ReturnType<typeof pickCurrentSubscriptionFromList>>;
// 拉取订阅摘要的统一入口：带 team 上下文走团队权益接口，否则走个人接口。
// quotaUrl 只取其 origin，路径被强制改写成订阅列表接口，避免调用方传入的查询串干扰；
// 返回 kind 恒定，未知或失败一律降级为 unknown。
// 返回类型固定为 CodingPlanEntitlement，便于上层按 kind 判别是否可用。
export async function fetchBigModelSubscriptionSummary(params: {
  apiClient: ApiClient;
  authorization: string;
  quotaUrl: string;
  teamContext?: {
    organizationId: string;
    projectId: string;
    family: ProviderFamilyDomain;
  } | null;
  businessToken?: string | null;
  timeoutMs: number;
}): Promise<CodingPlanEntitlement<SubscriptionSummary>> {
  try {
// 复用 quotaUrl 的 host 以保持与配额接口同一环境（生产与测试域名一致），
// 但同时清空 pathname 与 search，防止误用调用方传入的具体接口路径。
    const url = new URL(params.quotaUrl);
// 订阅摘要只认这一个上游路径，写死而非由调用方拼接，减少前后端接口漂移。
    url.pathname = "/api/biz/subscription/list";
    url.search = "";
// 团队模式必须有 business token，缺失说明未开通或未登录业务态，直接 unknown 且不发请求。
    if (params.teamContext) {
      const token = params.businessToken?.trim();
// 空 token 视为没有团队权益上下文，提前返回以省掉一次必然失败的请求。
      if (!token) return { kind: "unknown" };
      const result = await fetchTeamCodingPlanEntitlement({
        apiClient: params.apiClient,
        host: url.origin,
        timeoutMs: params.timeoutMs,
        authorization: params.teamContext.family === "zai" ? `Bearer ${token}` : token,
        teamContext: params.teamContext,
      });
      if (result.kind !== "available") return result;
// 团队接口返回的字段更全，这里只挑统计展示所需的四项，缺失值统一降级为空串或 null。
      const detail = result.subscription;
      return {
        kind: "available",
        subscription: {
          productId: detail.productId ?? "",
          productName: detail.productName ?? "",
          billingCycle: detail.subscribePeriod?.toLowerCase() ?? null,
          expireTime: detail.subscribeEndTime ?? null,
          renewTime: null,
        },
      };
    }
// 个人模式透传参数，仅把已规范化的 url 覆盖进去，保持其余超时与鉴权语义不变。
    const result = await fetchPersonalCodingPlanEntitlement({
      ...params,
      url: url.toString(),
    });
    if (result.kind !== "available") return result;
// 该选择器在列表为空时可能返回 null，此时同样归为 unknown，
// 避免把“无数据”误当成“可用但字段为空”。
    const subscription = pickCurrentSubscriptionFromList([result.subscription]);
    return subscription ? { kind: "available", subscription } : { kind: "unknown" };
// URL 非法、网络失败、响应结构异常等任意错误都降级为 unknown，保证统计链路不中断。
  } catch {
    return { kind: "unknown" };
  }
}
