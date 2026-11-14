// INV-01 鉴权态不同不保留快照：守住位置 相等判断；改错故障 登出后仍显示组织套餐。
// INV-02 刷新失败可退回静态目录：守住位置 兜底构造；改错故障 首次失败显示空列表。
// INV-03 静态目录缺失才返回空：守住位置 数组判断；改错故障 无配置时误报有商品。
// INV-04 作用域标识包含会话序号：守住位置 选择器；改错故障 重新登录沿用旧目录。
// INV-05 作用域对象随依赖重建：守住位置 记忆函数；改错故障 身份变化不隔离状态。
// INV-06 渲染期即隔离：守住位置 相等比较；改错故障 登出暴露一帧旧组织。
// INV-07 已卸载不写状态：守住位置 挂载标志；改错故障 卸载后仍更新状态。
// INV-08 静态与实时并行请求：守住位置 全量结算；改错故障 静态失败阻断实时价格。
// INV-09 响应回写前校验身份：守住位置 三重判断；改错故障 旧响应复活旧身份。
// INV-10 静态目录按提供者取桶：守住位置 存在性判断；改错故障 读错家族的目录。
// INV-11 定价失败不覆盖已知身份：守住位置 兜底函数；改错故障 刷新失败清空已购套餐。
// INV-12 首次失败才展示禁用卡：守住位置 空快照判断；改错故障 已有数据被降级。
// INV-13 断连错误不告警：守住位置 判断函数；改错故障 初始化阶段刷错误日志。
// INV-14 未启用时只收尾：守住位置 早退分支；改错故障 未启用仍发请求。
// INV-15 无服务给固定错误码：守住位置 空值分支；改错故障 界面一直加载。
// INV-16 刷新中保留旧数据：守住位置 保留判断；改错故障 套餐区闪成骨架屏。
// INV-17 静态商品标识单独保存：守住位置 字段；改错故障 用实时价格补造缺失商品。
// INV-18 返回值含状态与刷新：守住位置 记忆返回；改错故障 调用方拿不到刷新入口。
//
// 模块职责：企业 Coding Plan 套餐目录与实时定价的加载编排。
// 状态所有权：快照按身份作用域存本地，服务结果不跨身份复用。
// 阅读顺序：先看待保留与失败兜底，再看 hook 作用域，最后看刷新流程。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getModelProviderFamilySpec,
  type CodingPlanStaticTeamProduct,
  type EnterpriseCodingPlanPricingResponse,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import {
  resolveEnterpriseCodingPlanProductList,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import { normalizeErrorMessage } from "@/settings/model-provider-section/useCodingPlanProducts.js";

interface EnterpriseCodingPlanProductsState {
  snapshot: EnterpriseCodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

export interface EnterpriseCodingPlanProductsSnapshot {
  productList: EnterpriseCodingPlanProductDisplay[];
  raw: EnterpriseCodingPlanPricingResponse;
  authenticated: boolean;
  /** 静态目录控制购买横幅，不能用实时 pricing 补造目录中缺失的商品。 */
  staticProductIds?: string[];
}

// snapshot 为 null 时 shouldRetainEnterprisePricingSnapshotForRefresh 直接返回 false。
// 只有 snapshot.authenticated 与当前 authenticated 相等时才保留旧快照。
// 鉴权态变化（换账号或重新登录）即返回 false，强制重新拉取定价。
// 判据只比较 authenticated 这一个维度，不比较 productList 的内容。
// 该函数不读取 raw.productList，因此套餐增删不会影响保留判定。
export function shouldRetainEnterprisePricingSnapshotForRefresh(
  snapshot: EnterpriseCodingPlanProductsSnapshot | null,
  authenticated: boolean,
): boolean {
  return snapshot?.authenticated === authenticated;
}

// 满足保留条件时直接返回 currentSnapshot，不重新构造对象。
// staticProducts 不是数组时返回 null，让调用方保持空态而不是造假目录。
// 否则以空 raw.productList 为空定价打底，再并入静态目录。
// productList 交给 tagEnterpriseProductsFamily 打上当前 family 标记。
// 返回对象的 authenticated 取当前入参，而不是旧快照里的值。
export function resolveEnterprisePricingFailureSnapshot({
  currentSnapshot,
  authenticated,
  staticProducts,
  family = "bigmodel",
}: {
  currentSnapshot: EnterpriseCodingPlanProductsSnapshot | null;
  authenticated: boolean;
  staticProducts: CodingPlanStaticTeamProduct[] | undefined;
  family?: ProviderFamilyDomain;
}): EnterpriseCodingPlanProductsSnapshot | null {
  if (shouldRetainEnterprisePricingSnapshotForRefresh(currentSnapshot, authenticated)) {
    return currentSnapshot;
  }
  if (!Array.isArray(staticProducts)) {
    return null;
  }
  const raw: EnterpriseCodingPlanPricingResponse = { productList: [] };
  return {
    raw,
    productList: tagEnterpriseProductsFamily(
      resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
      family,
    ),
    authenticated,
  };
}

/**
 * 给企业套餐展示列表打上 family 标记（zai / bigmodel）。
 * 下游可见性函数（appendSubscribedTeamPlanItems 等）需要按 family
 * 找到对应 codingPlanItem 和 team key 前缀；原列表无 family 字段，只能按
 * bigmodelCodingPlan 派生，导致 zai team plan 无法渲染。
 */
function tagEnterpriseProductsFamily(
  products: EnterpriseCodingPlanProductDisplay[],
  family: ProviderFamilyDomain,
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product) => ({ ...product, family }));
}

/**
 * 原 hook 只服务 bigmodel family，getStaticTeamProducts 硬编码
 * 读 bigmodelCodingPlan bucket、getEnterprisePricing 不传 family。
 * zai family 对称化后，hook 接受 family 参数：
 *   - 按 family 读 static bucket（zaiCodingPlan / bigmodelCodingPlan）
 *   - 传 family 给 service.getEnterprisePricing，service 据此路由到对应 provider
 * 缺省 family 时保持 bigmodel，向后兼容既有调用点。
 */
// useOptionalServices 允许 service 缺省，缺省时 hook 进入“无服务”错误分支。
// authScope 由 user.id 与 authSessionSeq 拼成，同账号重新登录也会换作用域。
// 渲染期先比较 owned.scope 与 scope：不一致时立即返回空 state，不等 effect 清理。
// setState 写入前校验 owner.current.scope 与 mounted，命中任一不符即丢弃更新。
// 默认家族为 bigmodel。
export function useEnterpriseCodingPlanProducts({
  enabled,
  authenticated,
  family = "bigmodel",
  staticOnly = false,
}: {
  enabled: boolean;
  /** 未登录购买横幅只读取公开静态目录，不请求实时 pricing。 */
  staticOnly?: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
}) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const authScope = useZCodeStoreWithDefault(
    (state) => (state.user ? state.user.id + ":" + state.authSessionSeq : "signed-out"),
    "unscoped",
  );
  // 原因：鉴权布尔值不能区分两个账号或同账号重新登录，旧目录必须按完整身份隔离。
  const scope = useMemo(() => ({}), [service, family, authenticated, authScope, staticOnly]);
  const owner = useRef({ scope, enabled, mounted: true });
  owner.current = { scope, enabled, mounted: true };
  const codingPlanProviderId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  const [owned, setOwned] = useState<{ scope: object; state: EnterpriseCodingPlanProductsState }>({
    scope,
    state: {
      snapshot: null,
      loading: enabled,
      error: null,
    },
  });
  // 渲染时立即隔离，不能等 effect 清理，否则登出仍会暴露一帧旧组织。
  const state =
    owned.scope === scope ? owned.state : { snapshot: null, loading: enabled, error: null };
  const setState = useCallback(
    (
      next:
        | EnterpriseCodingPlanProductsState
        | ((state: EnterpriseCodingPlanProductsState) => EnterpriseCodingPlanProductsState),
    ) => {
      if (owner.current.scope !== scope || !owner.current.mounted) return;
      setOwned((previous) => ({
        scope,
        state:
          typeof next === "function"
            ? next(
                previous.scope === scope
                  ? previous.state
                  : { snapshot: null, loading: enabled, error: null },
              )
            : next,
      }));
    },
    [scope, enabled],
  );

  // refresh 在 enabled 为 false 时只清 loading 并保留快照，不发起任何请求。
  // service 缺失时写入固定错误码而不是抛异常，让调用方统一走错误展示。
  // 刷新前用 shouldRetainEnterprisePricingSnapshotForRefresh 判断能否沿用同身份快照。
  // 静态目录与 pricing 两个请求并行发出，汇总后一次 setState 写回。
  // 回写前再比一次 owner.current.scope，身份已变则丢弃这批结果。
  const refresh = useCallback(
    async (_options?: { force?: boolean }) => {
      if (!enabled) {
        setState((current) => ({
          snapshot: current.snapshot,
          loading: false,
          error: null,
        }));
        return;
      }
      if (!service) {
        setState({
          snapshot: null,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      setState((current) => ({
        // 企业/个人切换和登录态刷新时不应把套餐区域替换成整块 loading；
        // 保留上一轮企业套餐数据，让刷新状态只体现在刷新按钮和卡片局部状态上。
        // 但公开 pricing 与登录态 pricing 的字段语义不同，切换鉴权来源时必须丢弃旧数据，
        // 否则升级 Coding Plan 列表页会继续展示未鉴权的套餐结果。
        snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
          ? current.snapshot
          : null,
        loading: true,
        error: null,
      }));

      try {
        // 静态目录是展示配置，pricing 是订阅身份与实时价格的权威来源。
        // 两者必须独立请求，避免灰度环境缺少新配置字段时阻断已购 Team Plan 的恢复。
        const [staticResult, pricingResult] = await Promise.allSettled([
          service.getStaticTeamProducts(),
          staticOnly
            ? Promise.resolve<EnterpriseCodingPlanPricingResponse>({ productList: [] })
            : service.getEnterprisePricing({ authenticated, family }),
        ]);
        // 原因：登出、family 或服务切换后，旧网络响应不能复活上一个身份的目录。
        if (owner.current.scope !== scope || !owner.current.enabled || !owner.current.mounted)
          return;
        const staticProducts =
          staticResult.status === "fulfilled"
            ? Object.prototype.hasOwnProperty.call(staticResult.value, codingPlanProviderId)
              ? staticResult.value[codingPlanProviderId]
              : undefined
            : undefined;
        const raw: EnterpriseCodingPlanPricingResponse =
          pricingResult.status === "fulfilled" ? pricingResult.value : { productList: [] };
        const pricingError = pricingResult.status === "rejected" ? pricingResult.reason : null;
        if (pricingError) {
          const message = normalizeErrorMessage(pricingError);
          setState((current) => ({
            // pricing 刷新失败代表实时状态未知，不能用静态目录或空列表覆盖
            // 同鉴权态下上一轮有效的订阅身份与价格；首次失败时才展示静态禁用卡片。
            snapshot: resolveEnterprisePricingFailureSnapshot({
              currentSnapshot: current.snapshot,
              authenticated,
              staticProducts,
              family,
            }),
            loading: false,
            error: message,
          }));
          if (!isRemoteWorkspaceDisconnectedError(pricingError)) {
            logger.warn("[useEnterpriseCodingPlanProducts] 读取企业实时定价失败", {
              authenticated,
              error: message,
            });
          }
          return;
        }
        setState({
          snapshot: {
            raw,
            staticProductIds: staticProducts?.map((product) => product.productId) ?? [],
            productList: tagEnterpriseProductsFamily(
              resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
              family,
            ),
            authenticated,
          },
          loading: false,
          error: pricingError ? normalizeErrorMessage(pricingError) : null,
        });
        if (
          staticResult.status === "rejected" &&
          !isRemoteWorkspaceDisconnectedError(staticResult.reason)
        ) {
          logger.warn("[useEnterpriseCodingPlanProducts] 读取团队静态配置失败，回退实时 pricing", {
            authenticated,
            error: normalizeErrorMessage(staticResult.reason),
          });
        }
      } catch (error) {
        const message = normalizeErrorMessage(error);
        // 远端 workspace 壳层会早于 attachment 绑定短暂渲染；此时断连代理报错是
        // 可预期的初始化等待态，不应伪装成 pricing 故障。真实 RPC 错误仍保留 warn。
        if (!isRemoteWorkspaceDisconnectedError(error)) {
          logger.warn("[useEnterpriseCodingPlanProducts] 读取企业 Coding Plan 套餐失败", {
            authenticated,
            error: message,
          });
        }
        setState((current) => ({
          // 企业定价接口失败时如果直接清空 snapshot，
          // 切换到团队套餐页会只剩“暂无可购买的编程套餐”，用户无法分辨是接口失败还是确实无商品。
          // 保留上一轮可见套餐并把错误显式抛给 UI，避免把可恢复的刷新失败伪装成空列表。
          snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
            ? current.snapshot
            : null,
          loading: false,
          error: message,
        }));
      }
    },
    [authenticated, codingPlanProviderId, enabled, family, service, staticOnly, scope, setState],
  );

  useEffect(() => {
    owner.current.mounted = true;
    void refresh();
    return () => {
      owner.current.mounted = false;
    };
  }, [refresh]);

  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
