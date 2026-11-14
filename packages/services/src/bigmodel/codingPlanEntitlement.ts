// 权益判定模块：把 BigModel 个人 / 团队 Coding Plan 的回包折叠成 available / unavailable / unknown 三态。
// 三态语义不可互换：available 才可放行；unavailable 是服务端明确拒绝；unknown 是结构/网络/枚举未知。
// INV-01：个人订阅必须同时满足商品命中、status=VALID、inCurrentPeriod=true 才算 available。
// INV-02：任何解析失败都落到 unknown，绝不降级成 unavailable（readSuccessfulData 与两个 fetch）。
// INV-03：商品识别只看 productId/productName 是否含 coding，与订阅状态解耦（isCodingPlanProduct）。
// INV-04：团队 hasSubscription=true 不等于有效，必须再经 status 与 memberGrantStatus 双重校验。
// 破坏后果：付费用户会因暂时性故障被判未开通，或过期套餐被判有效，直接影响计费与功能开关。
// [权衡] 宁可多给 unknown 也不猜：unknown 只会让调用方重试或降级，误判则无法从日志回溯。
import type { ApiClient } from "@zcode/shared";
import { z } from "zod";
import { readApiJson } from "#src/providers/api/apiJson.js";
import type { BigModelTeamPlanBizContext } from "#src/bigmodel/teamPlanApiKey.js";

// [权衡] 信封字段全部可选而不做严格收窄：真实服务不同版本会省略 code/success，
// 若改成 required，老版本回包会整批解析失败，把正常权益误判成 unknown。
const envelopeSchema = z.object({
  code: z.number().optional(),
  success: z.boolean().optional(),
  data: z.unknown().optional(),
});
// status 与 inCurrentPeriod 设为必填：缺任一项就无法证明当期有效，
// 宁可让该条目落入 unknown，也不能用默认值补出一个“有效”结论。
const personalSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().optional(),
  status: z.string(),
  inCurrentPeriod: z.boolean(),
  autoRenew: z.union([z.number(), z.boolean()]).optional(),
  nextRenewTime: z.string().optional(),
  valid: z.string().optional(),
  billingCycle: z.string().optional(),
});
// 团队回包字段统一用 nullish：未开通时服务端常显式返回 null，
// 用 optional 会在 null 上解析失败，反而掩盖 hasSubscription=false 这个确定结论。
const teamSchema = z.object({
  hasSubscription: z.boolean(),
  status: z.string().nullish(),
  memberGrantStatus: z.string().nullish(),
  productId: z.string().nullish(),
  productName: z.string().nullish(),
  subscribeEndTime: z.string().nullish(),
  subscribePeriod: z.string().nullish(),
});
export type PersonalCodingPlanSubscription = z.infer<typeof personalSchema>;
export type TeamCodingPlanSubscription = z.infer<typeof teamSchema>;
// [权衡] reason 只区分 expired / unassigned 两种可展示原因，其余情况不带 reason：
// 上层据此选文案，凭空新增原因会让 UI 落进未翻译的兜底分支。
export type CodingPlanEntitlement<T> =
  | { kind: "available"; subscription: T }
  | { kind: "unavailable"; reason?: "expired" | "unassigned" }
  | { kind: "unknown" };

// 先挡掉 null、原始值与数组：它们没有 productId 字段，直接解构会抛错，
// 让一次查询变成 500 而不是可处理的 unknown。
function isCodingPlanProduct(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { productId, productName } = value as Record<string, unknown>;
// 用 some 而非同时要求两个字段：不同接口版本只填其一，AND 会把真实商品漏判。
  return [productId, productName].some(
    (field) => typeof field === "string" && field.toLowerCase().includes("coding"),
  );
}

// [契约] 三个条件缺一不可：商品命中 + status=VALID + inCurrentPeriod=true。
// 只看 status 会把“已付款但不在当期”判成可用；只看商品会把过期套餐判成可用。
export function isActivePersonalCodingPlan(subscription: {
  productId?: string;
  productName?: string;
  status?: string;
  inCurrentPeriod?: boolean;
}): boolean {
  return (
    isCodingPlanProduct(subscription) &&
    subscription.status === "VALID" &&
// 必须恒等 true 而非 truthy：接口偶发返回字符串 "false" 时，truthy 判断会放行。
    subscription.inCurrentPeriod === true
  );
}

// 返回 undefined 统一表示“信封层不可信”，调用方据此产出 unknown；
// 这里不抛异常，是因为鉴权与网络错误已由 readApiJson 抛出，此处只解释业务信封。
function readSuccessfulData(payload: unknown): unknown {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const envelope = parsed.data;
// success=false 是显式业务失败；code 存在且不在成功集合内同样是失败。
  // 沿用 availability 的可选 code 契约；省略成功码不能被解释为业务失败。
  if (
    envelope.success === false ||
    (envelope.code !== undefined && ![0, 200].includes(envelope.code))
  )
    return undefined;
// [权衡] 只取 data 而不替调用方解包：各接口 data 形状不同，统一解包会掩盖字段语义。
  return envelope.data;
}

// 个人权益入口：鉴权为空与回包结构异常都只能给 unknown，不能替用户断言“未开通”。
export async function fetchPersonalCodingPlanEntitlement(params: {
  apiClient: ApiClient;
  authorization: string;
  url: string;
  timeoutMs: number;
}): Promise<CodingPlanEntitlement<PersonalCodingPlanSubscription>> {
  if (!params.authorization.trim()) return { kind: "unknown" };
// [失败路径] 空 token 返回 unknown 而非抛错：调用方此时往往尚未登录，
// 抛错会把“未登录”升级成“鉴权失败”，触发不必要的登出流程。
  const payload = await readApiJson<unknown>(params.apiClient, params.url, {
    method: "GET",
    timeoutMs: params.timeoutMs,
    headers: { Authorization: params.authorization },
  });
// data 必须是数组：单条对象或 null 都算结构未知，不能用空数组冒充“无订阅”。
  const list = z.array(z.unknown()).safeParse(readSuccessfulData(payload));
  if (!list.success) return { kind: "unknown" };
// [权衡] 单独记录“疑似 Coding 但解析失败”的条目，而不是一见脏数据就整体 unknown：
// [边界] 列表混有无关商品：单条脏数据只跳过本条，不遮蔽后续 product 上的有效订阅。
  let malformedCodingEntry = false;
  // 订阅列表包含异构商品：只严格验证采用的 Coding 条目，无关条目不能遮蔽有效权益。
// 顺序扫描并在首个满足不变量的条目处返回：同一用户可能有多条记录，无需继续。
  for (const item of list.data) {
    const parsed = personalSchema.safeParse(item);
    if (parsed.success && isActivePersonalCodingPlan(parsed.data)) {
      return { kind: "available", subscription: parsed.data };
    }
// [失败路径] 只有“看着像 Coding”的脏条目才升级为 unknown，普通商品解析失败可安全忽略。
    if (!parsed.success && isCodingPlanProduct(item)) malformedCodingEntry = true;
  }
  // 没有有效条目时，疑似 Coding 的损坏数据不能被解释为明确未开通。
  return { kind: malformedCodingEntry ? "unknown" : "unavailable" };
}

export async function fetchTeamCodingPlanEntitlement(params: {
  apiClient: ApiClient;
  authorization: string;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
  timeoutMs: number;
}): Promise<CodingPlanEntitlement<TeamCodingPlanSubscription>> {
  if (!params.authorization.trim()) return { kind: "unknown" };
  const payload = await readApiJson<unknown>(
    params.apiClient,
    `${params.host.replace(/\/$/, "")}/api/biz/team/subscribe/product/querySubscribeDetail`,
    {
      method: "GET",
      timeoutMs: params.timeoutMs,
      headers: {
        Authorization: params.authorization,
        "bigmodel-organization": params.teamContext.organizationId,
        "bigmodel-project": params.teamContext.projectId,
      },
    },
  );
  const parsed = teamSchema.safeParse(readSuccessfulData(payload));
  if (!parsed.success) return { kind: "unknown" };
  const subscription = parsed.data;
  if (!subscription.hasSubscription) return { kind: "unavailable" };
  // 实际接口过期套餐仍返回 hasSubscription=true；存在订阅记录不等于当前有效。
  if (subscription.status === "EXPIRED") return { kind: "unavailable", reason: "expired" };
  if (subscription.status === "EFFECTIVE" && subscription.memberGrantStatus === "UNASSIGNED")
    return { kind: "unavailable", reason: "unassigned" };
  // 未验证的新枚举保持未知，不能擅自解释成无权益。
  if (subscription.status !== "EFFECTIVE" || subscription.memberGrantStatus !== "VALID") {
    return { kind: "unknown" };
  }
  return { kind: "available", subscription };
}
