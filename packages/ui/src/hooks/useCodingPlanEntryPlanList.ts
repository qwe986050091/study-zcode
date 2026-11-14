// INV-01 状态只有三档：守住位置 联合类型；改错故障 调用方需要判断更多分支。
// INV-02 团队数据必须绑定身份：守住位置 sameIdentity；改错故障 切换账号后显示他人套餐。
// INV-03 还要绑定刷新代次：守住位置 generation 比较；改错故障 重试后沿用旧结果。
// INV-04 团队来源必须全部可用：守住位置 every 判断；改错故障 部分失败仍标就绪。
// INV-05 刷新失败不等于未购买：守住位置 缓存复用条件；改错故障 网络抖动清空已购套餐。
// INV-06 缓存复用需三项一致：守住位置 用户、提供方与令牌；改错故障 串用他人的产品列表。
// INV-07 两个提供方并行读取：守住位置 Promise.all；改错故障 串行拖慢首屏。
// INV-08 令牌读取先裁剪：守住位置 trim；改错故障 空白令牌被当已登录。
// INV-09 无令牌返回空列表而非缺失：守住位置 早退分支；改错故障 后续判空逻辑分叉。
// INV-10 单提供方失败不拖垮整体：守住位置 try 包裹；改错故障 一个异常让整块不可用。
// INV-11 卸载后不再写状态：守住位置 cancelled 标记；改错故障 卸载告警与竞态。
// INV-12 重新挂载可重新请求：守住位置 依赖数组；改错故障 视图变化后不刷新。
// INV-13 重试只在错误态刷新视图：守住位置 status 判断；改错故障 就绪时重复请求。
// INV-14 重试一定推进代次：守住位置 setGeneration；改错故障 相同参数命中缓存不重算。
// INV-15 访问判定复用权益逻辑：守住位置 resolveAccountProviderInspectionAccess；改错故障 未选中套餐被过滤。
// INV-16 缺失判定保留历史成功：守住位置 missing 过滤；改错故障 成功确认未开通被当失败。
// INV-17 加载中合并多项来源：守住位置 pending 表达式；改错故障 提前展示空清单。
// INV-18 就绪才构建入口清单：守住位置 status 三元；改错故障 未就绪时传入空快照。
//
// 模块职责：汇总个人与团队套餐权益，产出可展示的入口套餐清单与加载状态。
// 状态所有权：团队快照与代次为本地状态，权益数据复用独立 hook。
// 阅读顺序：先看身份绑定，再看并行拉取与缓存复用，最后看状态合成。
import { useCallback, useEffect, useState } from "react";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { BUILTIN_MODEL_PROVIDER_IDS, type EnterpriseCodingPlanPricingProduct } from "@zcode/shared";
import { buildOwnedEntryPlanList } from "@/lib/codingPlanOwnedEntryPlans.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { logger } from "@/logger.js";

export interface CodingPlanEntryInventory {
  entryPlanList: string;
  status: "loading" | "error" | "ready";
  retry: () => void;
}

// 视图与加载态来自设置视图。
// credentials 与 subscriptionService 由 useZCodeServices 注入，不在 hook 内部新建。
// 权益 hook 关闭指纹自动刷新。
// 代次用于强制重算。
// 重试同时刷新视图与代次。
export function useCodingPlanEntryPlanList(): CodingPlanEntryInventory {
  const { state, reload } = useProviderSettingsView();
  const providerSettingsView = state.status === "ready" ? state.view : null;
  const loading = state.status === "loading";
  const { credentialService, codingPlanSubscriptionService } = useServices();
  const user = useZCodeStore((state) => state.user);
  // 不传当前选中的团队上下文，四种 Start/个人连接分别使用已有权益缓存。
  const { entitlements, refresh } = useCodingPlanEntitlements({
    providerSettingsView,
    suppressProviderFingerprintAutoRefresh: true,
  });
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => {
    if (state.status === "error") reload();
    setGeneration((value) => value + 1);
  }, [state.status, reload]);
  // 快照同时记录身份与代次。
  // 两个提供方各自保存令牌与产品。
  // 产品为 null 表示本次读取失败。
  // 身份字段用于命中判断。
  // 代次用于识别过期结果。
  const [teams, setTeams] = useState<{
    user: typeof user;
    view: typeof providerSettingsView;
    sources: { token: string | null; products: EnterpriseCodingPlanPricingProduct[] | null }[];
    generation: number;
  } | null>(null);
  useEffect(() => {
    if (!providerSettingsView) return;
    let cancelled = false;
    // 团队订阅以 authenticated pricing 为准，不用静态商品目录推断已购套餐。
    void Promise.all([
      refresh({ force: true, silent: true }),
      Promise.all(
        (["bigmodel", "zai"] as const).map(async (family) => {
          let token: string | null = null;
          try {
            token = (await credentialService.load(`oauth:${family}:access_token`))?.trim() || null;
            if (!token) return { token, products: [] };
            const result = await codingPlanSubscriptionService.getEnterprisePricing({
              authenticated: true,
              family,
            });
            return { token, products: result.productList };
          } catch (error) {
            logger.warn("[purchaseTelemetry] 读取团队套餐失败", { family, error });
            return { token, products: null };
          }
        }),
      ),
    ]).then(([, sources]) => {
      if (!cancelled)
        setTeams((previous) => ({
          user,
          view: providerSettingsView,
          generation,
          sources: sources.map((source, index) => {
            // 刷新失败不等于未购；仅在账号、family 和凭据一致时复用成功结果。
            const cached = previous?.sources[index];
            return source.products === null &&
              source.token &&
              previous?.user === user &&
              cached?.token === source.token
              ? { ...source, products: cached.products }
              : source;
          }),
        }));
    });
    return () => {
      cancelled = true;
    };
  }, [
    credentialService,
    codingPlanSubscriptionService,
    user,
    providerSettingsView,
    generation,
    loading,
    refresh,
  ]);
  const sameIdentity = teams?.user === user && teams.view === providerSettingsView;
  const current = sameIdentity && teams.generation === generation;
  const usableTeams = sameIdentity && teams.sources.every((source) => source.products !== null);
  const planIds: readonly string[] = [
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  ];
  // 账号模型没有 Personal API Key；沿用权益 hook 的只读 Access 判定，不能过滤未选中/禁用套餐。
  const required = planIds
    .filter((providerId) =>
      resolveAccountProviderInspectionAccess(providerSettingsView, providerId),
    )
    .map((providerId) => entitlements[providerId]);
  // 错误描述的是本次刷新，不能否定仍可用的历史快照（含成功确认未开通）。
  // snapshot 为 undefined 即判缺失，这是四类缺失里的第一类。
  // unavailableReason === "no_plan" 表示明确未开通，不进入 missing。
  // !authenticated 或存在其他 unavailableReason 时仍算缺失。
  // filter 后剩下的项即 required 中还需要等待权益到账的部分。
  const missing = required.filter((item) => {
    const snapshot = item?.snapshot;
    return (
      !snapshot ||
      (snapshot.unavailableReason !== "no_plan" &&
        (!snapshot.authenticated || snapshot.unavailableReason))
    );
  });
  const pending = loading || !current || missing.some((item) => item?.loading);
  const failed = !usableTeams || missing.length > 0;
  const status =
    state.status === "error" ? "error" : pending ? "loading" : failed ? "error" : "ready";
  useEffect(() => {
    logger.debug("[purchaseTelemetry] 套餐入口查询状态", {
      status,
      configuredSources: required.length,
      generation,
    });
  }, [status, required.length, generation]);
  return {
    status,
    retry,
    entryPlanList:
      status === "ready"
        ? buildOwnedEntryPlanList({
            snapshots: required.map((item) => item?.snapshot),
            teamProducts: teams?.sources.flatMap((source) => source.products ?? []) ?? [],
          })
        : "",
  };
}
