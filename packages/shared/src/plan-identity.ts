// INV-01 无 provider 家族直接 unknown：守住位置 首个早退；改错故障 未登录时误报无套餐。
// INV-02 顺序固定 coding plan 优先：守住位置 两次 resolve 的先后；改错故障 双订阅时身份抖动。
// INV-03 只有 active 才产出身份：守住位置 kind === "active"；改错故障 none 状态被当成有效套餐。
// INV-04 coding 非 none 即 unknown：守住位置 第二个判断；改错故障 过期缓存被当成无套餐。
// INV-05 start 为 none 才落到 no_plan：守住位置 末尾判断；改错故障 未知状态被误判为无套餐。
// INV-06 缓存过期即 unknown：守住位置 now - generatedAt > TTL；改错故障 展示过期套餐。
// INV-07 未登录或不可用即 unknown：守住位置 authenticated/unavailableReason；改错故障 网络故障被说成无套餐。
// INV-08 not_authenticated 与 not_configured 归 unknown：守住位置 并列判断；改错故障 配置缺失被当成无套餐。
// INV-09 只有 no_plan 映射为 none：守住位置 单独分支；改错故障 其它不可用原因被吞成无套餐。
// INV-10 有配额或订阅或余量才算 active：守住位置 三元判断；改错故障 空快照被当成有效套餐。
// INV-11 产品 id 缺失降级为空串：守住位置 subscription?.details[0]?.productId ?? ""；改错故障 返回 undefined 破坏快照类型。
// INV-12 generatedAt 用快照时间而非 now：守住位置 active 分支；改错故障 缓存命中时间被当成凭证生成时间。
// INV-13 unknown 统一用 now 与空产品 id：守住位置 createPlanIdentitySnapshot 调用；改错故障 下游拿到无效时间戳。
// INV-14 纯函数无副作用：守住位置 全模块无 IO；改错故障 投影层意外触发网络请求。
//
// 模块职责：把 provider 家族与两份用量凭证投影成可展示的套餐身份快照。
// 阅读顺序：先看顶层优先级，再看 entitlement 三态判定，最后看快照字段来源。
import type { ProviderFamilyDomain } from "./model-provider-family.js";
import type {
  PlanIdentitySnapshot,
  PlanIdentityStatus,
  UsageEntitlementSnapshot,
} from "./usage-stats.js";

// provider 家族是身份判定的前提，缺失时不再看凭证。
// coding plan 命中即返回，避免与 start plan 叠加。
// 两边都不可判定时保持 unknown，不做猜测。
export function resolvePlanIdentitySnapshot(input: {
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
  codingPlanEntitlement: UsageEntitlementSnapshot | null | undefined;
  startPlanEntitlement: UsageEntitlementSnapshot | null | undefined;
  now: number;
  entitlementCacheTtlMs: number;
}): PlanIdentitySnapshot {
  const unknown = createPlanIdentitySnapshot(input.now, "unknown", "");
  if (!input.providerFamilyDomain) {
    return unknown;
  }

  const codingState = resolvePlanEntitlementState({
    snapshot: input.codingPlanEntitlement,
    now: input.now,
    entitlementCacheTtlMs: input.entitlementCacheTtlMs,
  });
  if (codingState.kind === "active") {
    return createPlanIdentitySnapshot(
      codingState.generatedAt,
      "coding_plan",
      codingState.planProductId,
    );
  }
  if (codingState.kind !== "none") {
    return unknown;
  }

  const startState = resolvePlanEntitlementState({
    snapshot: input.startPlanEntitlement,
    now: input.now,
    entitlementCacheTtlMs: input.entitlementCacheTtlMs,
  });
  if (startState.kind === "active") {
    return createPlanIdentitySnapshot(
      startState.generatedAt,
      "start_plan",
      startState.planProductId,
    );
  }
  if (startState.kind === "none") {
    return createPlanIdentitySnapshot(input.now, "no_plan", "");
  }

  return unknown;
}

// 三个字段即全部可展示信息，不再向下透传凭证对象。
// 状态名直接对应前端展示枚举，本层不做文案映射。
function createPlanIdentitySnapshot(
  generatedAt: number,
  planStatus: PlanIdentityStatus,
  planProductId: string,
): PlanIdentitySnapshot {
  return {
    generatedAt,
    planStatus,
    planProductId,
  };
}

// 无快照与缓存过期都归 unknown，调用方无需区分。
// 未认证或整体不可用优先于具体原因，避免误读。
// no_plan 是唯一能宣称确实没有套餐的状态。
// 三个载荷任一存在即视为 active，避免与套餐类型耦合。
function resolvePlanEntitlementState(input: {
  snapshot: UsageEntitlementSnapshot | null | undefined;
  now: number;
  entitlementCacheTtlMs: number;
}):
  | { kind: "active"; generatedAt: number; planProductId: string }
  | { kind: "none" }
  | { kind: "unknown" } {
  const snapshot = input.snapshot;
  if (!snapshot) {
    return { kind: "unknown" };
  }
  if (input.now - snapshot.generatedAt > input.entitlementCacheTtlMs) {
    return { kind: "unknown" };
  }
  if (!snapshot.authenticated || snapshot.unavailableReason === "unavailable") {
    return { kind: "unknown" };
  }
  if (
    snapshot.unavailableReason === "not_authenticated" ||
    snapshot.unavailableReason === "not_configured"
  ) {
    return { kind: "unknown" };
  }
  // 这里是 none 的唯一来源。
  // 其余 reason 一律向上落到 unknown。
  if (snapshot.unavailableReason === "no_plan") {
    return { kind: "none" };
  }
  if (snapshot.quota || snapshot.subscription || snapshot.remaining) {
    return {
      kind: "active",
      generatedAt: snapshot.generatedAt,
      // productId 只取首个订阅明细，缺失时用空串占位。
      // generatedAt 沿用快照时间，保证缓存命中不刷新时间戳。
      planProductId: snapshot.subscription?.details[0]?.productId ?? "",
    };
  }

  return { kind: "unknown" };
}
