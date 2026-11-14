// useCodingPlanProducts —— Coding Plan 套餐的读取与缓存层：静态套餐、远端试算、登录态回退、
// 失败快照选择与请求合并都收敛在这一个 hook 里。
//
// 职责边界
// 做：按 provider 判断支持性、合并并发请求、维护快照缓存与代数、在失败时挑可展示的快照。
// 不做：套餐卡片渲染、购买流程、支付回调、订阅状态轮询。
// 依赖：codingPlanSubscriptionService 的试算与静态配置接口，以及共享包里的 provider 标识。
// 被谁用：模型供应商设置页的套餐区块，以及测试用例直接调用的导出函数。
// 边界：缓存键是服务实例，跨连接不共享；hook 不感知界面，只返回状态与刷新函数。
//
// INV 不变量（违反任意一条都会让套餐价格与可购状态在错误的数据上计算）
// INV-01 请求缓存按服务实例分桶 —— 守住它的位置：WeakMap 分桶 —— 改错故障：切换连接后复用上一个连接的在途请求。
// INV-02 缓存 Promise 而不是结果 —— 守住它的位置：请求缓存的读写 —— 改错故障：并发第二个调用者拿不到同一次请求的结果。
// INV-03 强制刷新必须自增代数 —— 守住它的位置：代数计算 —— 改错故障：旧请求返回后覆盖新快照。
// INV-04 写入快照前必须校验代数 —— 守住它的位置：请求完成分支 —— 改错故障：快速切换 provider 后数据串台。
// INV-05 请求完成后只删除仍是当前的 Promise —— 守住它的位置：缓存清理 —— 改错故障：并发时误删后来者的在途挂账。
// INV-06 快照命中要求未强制、未过期、存在 —— 守住它的位置：命中判断 —— 改错故障：长时间挂机后价格停留在旧值。
// INV-07 首次加载必须清空快照 —— 守住它的位置：加载前置状态 —— 改错故障：先闪一帧空列表再出骨架。
// INV-08 强制刷新保留旧快照 —— 守住它的位置：同一处的另一分支 —— 改错故障：手动刷新时列表整体塌陷。
// INV-09 刷新失败不得用静态套餐覆盖有效 preview —— 守住它的位置：失败快照选择 —— 改错故障：已售罄套餐被误算成可订阅。
// INV-10 未开启远端预览时只读静态配置 —— 守住它的位置：开启判断分支 —— 改错故障：未登录用户触发付费试算。
// INV-11 未开启分支必须提前返回 —— 守住它的位置：静态加载后的收尾 —— 改错故障：继续执行远端请求并报未登录错误。
// INV-12 不支持 provider 的初始加载态必须为假 —— 守住它的位置：状态惰性初始化 —— 改错故障：永远停在骨架屏。
// INV-13 无服务时返回服务不可用错误而不是抛错 —— 守住它的位置：服务判空分支 —— 改错故障：可选套餐区块拖垮整个设置页。
// INV-14 静态列表远端为空时退回内置快照 —— 守住它的位置：静态列表读取 —— 改错故障：用户看到「没有套餐」。
// INV-15 静态列表去重保留首次出现 —— 守住它的位置：去重循环 —— 改错故障：同一套餐重复展示且购买按钮指向不同 id。
// INV-16 合并预览时以远端字段为准 —— 守住它的位置：合并函数 —— 改错故障：运营调价被代码常量压回旧值。
// INV-17 合并无预览时返回浅拷贝 —— 守住它的位置：合并函数的兜底 —— 改错故障：下游修改污染静态常量表。
// INV-18 旧运行时缺少静态配置方法时按空配置处理 —— 守住它的位置：方法存在性判断 —— 改错故障：整个套餐列表降级失败。
// INV-19 错误归一化必须有非空结果 —— 守住它的位置：归一化函数 —— 改错故障：界面出现空白错误提示。
// INV-20 登录态错误码必须用共享字面量 —— 守住它的位置：未登录常量与失败判定 —— 改错故障：服务端改码后静默失效。
//
// 三处看着可以简化、其实不能删的保护：
// 1) 代数校验，去掉后快速切换 provider 会让旧请求覆盖新快照。
// 2) 失败时保留上一轮 preview，去掉后已售罄套餐会被误标为可订阅。
// 3) Promise 身份比较后再清理缓存，去掉后并发调用会互相删掉在途请求。
/* eslint-disable max-lines -- Coding Plan 套餐需要集中处理静态套餐、远端试算、缓存与登录态回退，避免把共享状态拆散。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  CODING_PLAN_SYSTEM_BUSY,
  type CodingPlanBatchPreviewResponse,
  type CodingPlanProductPreviewPayment,
  type CodingPlanStaticProduct,
  type CodingPlanStaticProductsConfig,
  type StartPlanPreviewConfig,
  isZaiCodingPlanProviderId,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  normalizeCodingPlanCardCopyItems,
  type CodingPlanProductDisplay,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

// [契约] 三字段状态是快照、加载中、错误的完备组合，渲染层只依赖这三个值。
// [契约] 错误为空代表成功，非空字符串代表失败原因，不接受其他哨兵值。
// [权衡] 快照允许为空：静态套餐改为远端配置后，首次加载没有本地兜底。
// [失败路径] 若新增字段却不在两条成功分支里赋值，旧调用方会读到上一轮的残留。
interface CodingPlanProductsState {
  snapshot: CodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

type CodingPlanProductsSnapshot = Omit<CodingPlanBatchPreviewResponse, "productList"> & {
  productList: CodingPlanProductDisplay[];
};

// [契约] 未登录错误码是跨层契约，服务端与界面必须使用同一个字面量。
// [契约] 这个常量只用于失败快照判定，不参与请求参数构造。
// [失败路径] 若在别处硬编码字符串，服务端改码后这里会静默失效，用户看到原始错误。
// [权衡] `CODING_PLAN_OAUTH_REQUIRED_ERROR` 保持模块内可见即可，不必提升为共享常量表。
const CODING_PLAN_OAUTH_REQUIRED_ERROR = "coding_plan_oauth_required";
export const ZAI_START_FREE_PRODUCT_ID = "zai-start-free";
const ZAI_START_FREE_PRODUCT_IDS = {
  month: `${ZAI_START_FREE_PRODUCT_ID}-monthly`,
  quarter: `${ZAI_START_FREE_PRODUCT_ID}-quarterly`,
  year: `${ZAI_START_FREE_PRODUCT_ID}-yearly`,
} as const;
const CODING_PLAN_PRODUCTS_CACHE_TTL_MS = 30_000;
const CODING_PLAN_STATIC_PRODUCTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// [并发] 请求缓存按服务实例分桶，用 WeakMap 避免服务销毁后桶一直存活。
// [契约] 桶内按 provider 映射到进行中的 Promise，同一 provider 的并发调用共享一次请求。
// [契约] 缓存的是 Promise 而不是结果：晚到的第二个调用者也要能拿到同一次请求的完成值。
// [失败路径] 若缓存结果对象，请求失败后无法区分「正在失败」与「已经失败」，会反复重试。
// [权衡] WeakMap 键是服务对象，服务被替换后旧缓存自然回收，不需要手动清理。
// [契约] 重置测试缓存时必须整体换新的 WeakMap，而不是逐个删除。
let productRequestCache = new WeakMap<object, Map<string, Promise<CodingPlanProductsSnapshot>>>();
let productSnapshotCache = new WeakMap<
  object,
  Map<string, { snapshot: CodingPlanProductsSnapshot; expiresAt: number }>
>();
let productCacheGeneration = new WeakMap<object, Map<string, number>>();
let staticProductsConfigCache = new WeakMap<
  object,
  { config: CodingPlanStaticProductsConfig; expiresAt: number }
>();
let staticProductsConfigRequest = new WeakMap<object, Promise<CodingPlanStaticProductsConfig>>();

// [契约] 首次访问时按服务建桶，之后复用同一个 Map。
// [契约] 用服务实例作键，避免同一进程内多个连接共享缓存。
// [失败路径] 若按 provider 而非服务分桶，切换连接后会把上一个连接的在途请求当成自己的。
// [权衡] `getServiceCache` 的桶数以活跃服务数为上界（通常 1–2 个），不需要淘汰策略。
// [契约] 返回的是可变 Map，调用方只能读写自己的键，不要整体清空。
function getServiceCache<T>(
  cache: WeakMap<object, Map<string, T>>,
  service: object,
): Map<string, T> {
  const existing = cache.get(service);
  if (existing) return existing;
  const created = new Map<string, T>();
  cache.set(service, created);
  return created;
}

// [契约] hook 只在支持 Coding Plan 的 provider 上工作，其余 provider 直接给不支持错误。
// [契约] 服务从可选服务上下文读取，测试与预览环境下可能不存在，必须允许为空。
// [契约] 返回值展开状态并提供刷新函数，调用方不需要自己维护加载态。
// [失败路径] 若在无服务时抛错，整个模型设置页会因一个可选套餐区块而崩溃。
// [权衡] 状态初始化用惰性函数，避免每次渲染都构造一次初始对象。
export function useCodingPlanProducts(
  providerId: CodingPlanProviderId,
  options?: { remotePreviewEnabled?: boolean },
) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  // [契约] 支持的 provider 由内置标识与订阅制标识共同决定，两处判断缺一不可。
  // [契约] `supportedProvider` 只做能力判定、不发请求，所以可以在渲染期同步计算。
  // [失败路径] 若把前缀相似的 provider 也算进来，会向不支持的服务发试算请求。
  // [权衡] 不用集合查找，两个条件足够且更直观。
  const supportedProvider =
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    isZaiCodingPlanProviderId(providerId);
  // [契约] 远端预览开关默认开启，只有显式传假值才关闭。
  // [契约] 关闭时仍会加载静态套餐列表，而不是把整个套餐区块隐藏。
  // [失败路径] 若把「未开启」当成「不支持」，未登录用户会连静态套餐都看不到。
  // [权衡] 允许调用方按场景关闭远端请求，测试与离线预览都依赖这个开关。
  const enabled = supportedProvider && options?.remotePreviewEnabled !== false;
  const staticSnapshot = useMemo(() => buildStaticProductsSnapshot(providerId), [providerId]);
  // [状态] 初始加载态跟随支持判定：不支持的 provider 不应出现加载动画。
  // [契约] 初始快照为空，静态套餐在首次刷新时才写入，保证首帧不展示可能过期的本地数据。
  // [失败路径] 若初始加载态恒为真，不支持的 provider 会永远停在骨架屏。
  // [权衡] 用惰性初始化而不是模块常量，避免跨实例共享同一对象引用。
  const [state, setState] = useState<CodingPlanProductsState>(() => ({
    snapshot: null,
    loading: supportedProvider,
    error: null,
  }));

  // [并发] 刷新函数由多个分支组成，每个分支都必须自行收尾，不能依赖外层 finally。
  // [契约] 不支持、未开启、无服务三条提前返回路径都要写入完整状态，不能只改加载标志。
  // [契约] 依赖数组包含服务与静态快照，服务切换会重建回调并触发初始化 effect。
  // [失败路径] 若漏掉某个依赖，闭包会读到旧服务，刷新打到已经断开的连接。
  // [权衡] 不做节流，重复调用由请求缓存合并，按钮禁用另由界面层负责。
  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!supportedProvider) {
        setState({
          snapshot: staticSnapshot,
          loading: false,
          error: "unsupported",
        });
        return;
      }
      // [契约] 关闭远端预览时只读静态套餐配置，绝不调用付费试算接口。
      // [契约] 有服务时走远端静态列表，无服务时退回编译期内置快照，两条路径都要返回可展示数据。
      // [失败路径] 之前这里直接返回空快照并保持加载中，套餐列表会永久卡在骨架屏。
      // [契约] 错误置空表示这是正常降级而不是失败，界面不应展示重试提示。
      // [权衡] 静态列表读取失败会落到统一错误分支，此时仍保留内置快照兜底。
      // [契约] 这个分支必须提前返回，否则会继续走远端试算，未登录时必然报错。
      if (!enabled) {
        const loadedStaticSnapshot = service
          ? await loadCodingPlanStaticProductsSnapshotForTest(providerId, service)
          : staticSnapshot;
        setState({
          // 未登录/未连接时禁止打 paid batch-preview，但仍要展示静态套餐。
          // 之前这里返回空 snapshot + loading，导致套餐列表一直卡在加载态。
          snapshot: loadedStaticSnapshot,
          loading: false,
          error: null,
        });
        return;
      }
      if (!service) {
        setState({
          snapshot: staticSnapshot,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      // [契约] 手动刷新与首次加载的差别只在是否保留旧快照，其余字段一致。
      // [契约] 首次加载必须把快照清空，让外层展示整块加载态，而不是先闪一帧空列表。
      // [契约] 强制刷新保留旧快照，让用户在当前数据上看到刷新中的覆盖层。
      // [失败路径] 若不区分强制标志，手动刷新会让列表整体塌陷成骨架，视觉跳动明显。
      // [契约] 这里用函数式更新读取当前快照，避免闭包拿到过期值。
      // [权衡] 保留快照意味着失败时也能回退到上一轮有效数据，这是失败分支的前提。
      setState((current) => ({
        // 静态套餐改为远端配置后，首次查看套餐列表时没有本地数据可兜底；
        // 请求配置和试算期间必须保持空 snapshot，让外层展示整块加载态，而不是先闪空列表。
        snapshot: options?.force === true ? current.snapshot : null,
        loading: true,
        error: null,
      }));

      let loadedStaticSnapshot = staticSnapshot;
      try {
        const staticProducts = await loadCodingPlanStaticProductListForTest(providerId, service);
        loadedStaticSnapshot = buildStaticProductsSnapshotFromList(providerId, staticProducts);
        const snapshot = await loadCodingPlanProducts(
          providerId,
          service,
          options?.force === true,
          staticProducts,
        );
        setState({
          snapshot,
          loading: false,
          error: null,
        });
      // [失败路径] 失败时由失败快照函数决定保留上一轮 preview 还是回退静态套餐。
      // [契约] 手动刷新失败不能用静态套餐覆盖上一轮有效 preview：售罄与可购状态只存在于试算结果。
      // [契约] 日志只记录归一化后的消息与 provider，不打印原始错误对象，避免泄漏内部结构。
      // [失败路径] 若直接写入静态快照，周期列表会把已售罄套餐误算成可订阅。
      // [权衡] 错误字符串同时用于展示与判定登录态，保持单一来源。
      } catch (error) {
        const message = normalizeErrorMessage(error);
        logger.warn("[useCodingPlanProducts] 读取 Coding Plan 套餐失败", {
          providerId,
          error: message,
        });
        setState((current) => ({
          // 手动刷新失败不能用静态套餐覆盖上一轮有效 preview。
          // soldOut/canPurchase/forbidden 只存在于 batch-preview，覆盖后周期列表会把“已售罄”误算成可订阅。
          snapshot: resolveCodingPlanProductsFailureSnapshot(
            current.snapshot,
            loadedStaticSnapshot,
          ),
          loading: false,
          error: message,
        }));
      }
    },
    [enabled, providerId, service, staticSnapshot, supportedProvider],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    ...state,
    refresh,
  };
}

// [并发] 读取入口先取四个按服务分桶的缓存，再决定命中、复用还是新建请求。
// [契约] 快照缓存命中且未过期时直接返回，不触碰请求缓存。
// [契约] 进行中的请求优先复用，避免同一 provider 并发触发两次试算。
// [失败路径] 若先检查请求缓存再检查快照，已过期的快照会阻止新请求发出。
// [契约] 强制刷新先自增代数，再让所有后续写入按代数校验，避免旧结果覆盖新结果。
// [权衡] 函数名为测试入口但生产也在用，改名会影响大量调用点。
export async function loadCodingPlanProductsForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
  force: boolean,
  staticProducts?: CodingPlanStaticProduct[],
): Promise<CodingPlanProductsSnapshot> {
  const now = Date.now();
  const requestCache = getServiceCache(productRequestCache, service);
  const snapshotCache = getServiceCache(productSnapshotCache, service);
  const generationCache = getServiceCache(productCacheGeneration, service);
  // [并发] 代数用于识别「这次请求是否仍是最新一次」：强制刷新会无条件自增。
  // [契约] 非强制刷新沿用当前代数，保证并发的普通请求共享同一代号。
  // [失败路径] 若强制刷新不自增，旧请求返回后仍会被认为是当前结果并写入快照。
  // [契约] 代数按服务与 provider 分桶，不同 provider 互不干扰。
  // [权衡] 代数只增不减，数值溢出在实践规模内不会发生。
  const generation = force
    ? invalidateCodingPlanProductsCache(providerId, service)
    : (generationCache.get(providerId) ?? 0);
  const cachedSnapshot = snapshotCache.get(providerId);
  // [契约] 命中条件同时要求未强制刷新、快照存在、未过期，三者缺一不可。
  // [契约] 过期时间由快照自身携带，读取方不重新计算有效期。
  // [失败路径] 若只看快照存在不看过期，套餐价格会在长时间挂机后一直停在旧值。
  // [权衡] 过期后不立即清空缓存，保留给失败分支做兜底。
  if (!force && cachedSnapshot && cachedSnapshot.expiresAt > now) {
    return cachedSnapshot.snapshot;
  }

  const cachedPromise = requestCache.get(providerId);
  if (!force && cachedPromise) {
    return cachedPromise;
  }

  // React 严格模式和设置页状态刷新会短时间重复挂载套餐卡，
  // BigModel/Z.AI 套餐预览接口对连发请求会偶发返回“系统繁忙”；这里合并进行中请求，并只短缓存成功结果，
  // 手动刷新、登录/连接成功和购买完成都用 force 绕过缓存，避免交易状态长期陈旧。
  // 登录/连接成功还必须让旧的未登录试算请求失去写缓存资格，避免它晚返回后覆盖新的登录态试算结果。
  const promise = loadBatchPreviewWithStaticProducts(providerId, service, staticProducts ?? []);
  requestCache.set(providerId, promise);

  try {
    const snapshot = await promise;
    if ((generationCache.get(providerId) ?? 0) === generation) {
      snapshotCache.set(providerId, {
        snapshot,
        expiresAt: now + CODING_PLAN_PRODUCTS_CACHE_TTL_MS,
      });
    }
    return snapshot;
  } finally {
    // [并发] 请求完成后只有仍是当前 Promise 才删除缓存，防止删掉后来者的请求。
    // [契约] 用身份比较而不是键存在性判断，避免并发覆盖后误删。
    // [失败路径] 若无条件删除，两个并发调用中先完成的一个会清掉另一个的在途挂账。
    // [权衡] 无论成功失败都要清理，失败重试依赖这一点。
    if (requestCache.get(providerId) === promise) {
      requestCache.delete(providerId);
    }
  }
}

export async function loadCodingPlanStaticProductsSnapshotForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanProductsSnapshot> {
  const staticProducts = await loadCodingPlanStaticProductListForTest(providerId, service);
  return buildStaticProductsSnapshotFromList(providerId, staticProducts);
}

const loadCodingPlanProducts = loadCodingPlanProductsForTest;

export function resolveCodingPlanProductsFailureSnapshot(
  currentSnapshot: CodingPlanProductsSnapshot | null,
  fallbackSnapshot: CodingPlanProductsSnapshot,
): CodingPlanProductsSnapshot {
  return currentSnapshot ?? fallbackSnapshot;
}

export function clearCodingPlanProductsCacheForTest() {
  productRequestCache = new WeakMap();
  productSnapshotCache = new WeakMap();
  productCacheGeneration = new WeakMap();
  staticProductsConfigCache = new WeakMap();
  staticProductsConfigRequest = new WeakMap();
}

function invalidateCodingPlanProductsCache(providerId: CodingPlanProviderId, service: object) {
  const generationCache = getServiceCache(productCacheGeneration, service);
  const nextGeneration = (generationCache.get(providerId) ?? 0) + 1;
  generationCache.set(providerId, nextGeneration);
  getServiceCache(productRequestCache, service).delete(providerId);
  getServiceCache(productSnapshotCache, service).delete(providerId);
  return nextGeneration;
}

async function loadBatchPreviewWithStaticProducts(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
  staticProducts: CodingPlanStaticProduct[],
): Promise<CodingPlanProductsSnapshot> {
  const previewSnapshot = await service.batchPreview({ providerId });
  const previewByProductId = new Map(
    previewSnapshot.productList.map((product) => [product.productId, product]),
  );
  const productList =
    staticProducts.length > 0
      ? buildStaticProductDisplayList(staticProducts).map((product) =>
          mergeStaticProductWithPreview(product, previewByProductId.get(product.productId)),
        )
      : previewSnapshot.productList.map((product) => ({
          ...product,
          hasPreview: true,
        }));

  return {
    ...previewSnapshot,
    productList: filterCodingPlanPurchaseProducts(providerId, productList),
  };
}

function buildStaticProductsSnapshot(providerId: CodingPlanProviderId): CodingPlanProductsSnapshot {
  return buildStaticProductsSnapshotFromList(providerId, []);
}

function buildZaiStartStaticProducts(preview: StartPlanPreviewConfig): CodingPlanStaticProduct[] {
  const isChineseLocale =
    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
  const previewName = preview.name.trim() || "Z.ai Start";
  const equityList = preview.entitlements.map((entitlement) => ({
    productEquityTitle: entitlement.showName,
    productEquityDetails: formatStartPlanPreviewEntitlement(entitlement, isChineseLocale),
  }));

  return [
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.month,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for connected Z.ai users.",
      productEquityList: equityList,
      priceUnit: "month",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.quarter,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for signed-in Z.ai users.",
      productEquityList: equityList,
      priceUnit: "quarter",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.year,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for signed-in Z.ai users.",
      productEquityList: equityList,
      priceUnit: "year",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
  ];
}

function formatStartPlanPreviewEntitlement(
  entitlement: StartPlanPreviewConfig["entitlements"][number],
  isChineseLocale: boolean,
): string {
  const amount = new Intl.NumberFormat(isChineseLocale ? "zh-CN" : "en-US").format(
    entitlement.grantUnits,
  );
  const unit = entitlement.unitType.trim();
  const period = entitlement.period.trim();
  return [amount, unit, period].filter(Boolean).join(" ");
}

export function isZaiStartFreeProductId(productId: string | null | undefined) {
  if (!productId) {
    return false;
  }
  return (
    productId === ZAI_START_FREE_PRODUCT_ID || productId.startsWith(`${ZAI_START_FREE_PRODUCT_ID}-`)
  );
}

function buildStaticProductsSnapshotFromList(
  providerId: CodingPlanProviderId,
  staticProducts: CodingPlanStaticProduct[],
): CodingPlanProductsSnapshot {
  return {
    productList: filterCodingPlanPurchaseProducts(
      providerId,
      buildStaticProductDisplayList(staticProducts),
    ),
    isSubscribed: false,
    isAuthenticated: null,
  };
}

function buildStaticProductDisplayList(
  products: CodingPlanStaticProduct[],
): CodingPlanProductDisplay[] {
  return products.map((product) => {
    const descriptionItems = normalizeCodingPlanCardCopyItems(
      typeof product.description === "string"
        ? product.description.split(/\r?\n/)
        : product.description,
    );
    return {
      ...product,
      // 展示模型仍需要换行字符串供旧卡片逻辑读取，同时保留结构化条目，
      // 否则 client/configs 下发的单条 tooltip 会在归一化时丢失。
      productDescription:
        descriptionItems.length > 0
          ? descriptionItems.map((item) => item.text).join("\n")
          : typeof product.description === "string"
            ? product.description
            : undefined,
      descriptionItems,
      equity: normalizeCodingPlanCardCopyItems(product.equity ?? []),
      hasPreview: false,
    };
  });
}

// [契约] 静态列表读取优先走远端配置，配置不可用时退回内置快照。
// [契约] 远端列表要经过归一化、去重与预览合并后才变成展示快照。
// [契约] 内置快照的 provider 判定与 hook 的支持判定使用同一组标识。
// [失败路径] 若远端返回空数组时直接采用，用户会看到「没有套餐」而不是内置兜底。
// [契约] 去重保留首次出现的条目，顺序即远端配置顺序。
// [权衡] 远端失败只记录日志并降级，不向上抛错，避免整个套餐区块不可用。
export async function loadCodingPlanStaticProductListForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanStaticProduct[]> {
  try {
    const config = await loadCodingPlanStaticProductsConfig(service);
    // 套餐描述由远端 client/configs 统一维护，前端不能再按 Lite/Pro/Max 写死覆盖，
    // 否则远端更新后设置页仍展示旧文案。
    const remoteProducts = config[providerId] ?? [];
    if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
      return filterCodingPlanPurchaseProducts(providerId, remoteProducts);
    }
    if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
      return remoteProducts;
    }

    // [契约] 免费套餐与试用套餐的预览字段由本地常量补齐，不依赖远端返回。
    // [契约] 合并时以远端字段为准，本地只补缺失的可购状态与文案键。
    // [失败路径] 若本地字段覆盖远端，运营调整的价格会被代码常量压回旧值。
    // [契约] 这里的预览对象只是占位，最终展示仍以试算结果为准。
    // [权衡] 用对象字面量而不是构造函数，便于直接比对字段。
    const startPlanPreview =
      typeof service.getStartPlanPreview === "function"
        ? await service.getStartPlanPreview()
        : null;
    if (!startPlanPreview) {
      // 体验套餐是否存在由 client/configs.startPlanPreview 决定。
      // 后端缺字段时不能再用本地硬编码兜底，否则会展示已经被配置关闭的体验套餐。
      return remoteProducts;
    }

    // Start 免费档现在归属于独立的 Start Plan 入口，且必须由远端 preview 开关显式打开。
    // Z.AI - Coding Plan 的购买列表只展示付费升级项，避免把 Start 当成可购买套餐重复显示。
    const seen = new Set<string>();
    return [...buildZaiStartStaticProducts(startPlanPreview), ...remoteProducts].filter(
      (product) => {
        if (seen.has(product.productId)) {
          return false;
        }
        seen.add(product.productId);
        return true;
      },
    );
  } catch (error) {
    logger.warn("[useCodingPlanProducts] 读取远端 Coding Plan 静态套餐失败", {
      providerId,
      error: normalizeErrorMessage(error),
    });
    return [];
  }
}

function filterCodingPlanPurchaseProducts<
  TProduct extends { productId: string | null | undefined },
>(providerId: CodingPlanProviderId, products: TProduct[]): TProduct[] {
  if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
    return products;
  }
  return products.filter((product) => !isZaiStartFreeProductId(product.productId));
}

// [并发] 静态配置同样有内存缓存与在途请求合并，代数校验与套餐请求一致。
// [契约] 服务未提供该方法时直接返回空配置，兼容旧版本运行时。
// [契约] 请求结果按 provider 索引，缺失 provider 时返回空数组而不是抛错。
// [失败路径] 若把缺失方法当成错误，旧运行时会让整个套餐列表降级失败。
// [权衡] 配置缓存与套餐缓存分开存储，二者的失效时机不同。
async function loadCodingPlanStaticProductsConfig(
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanStaticProductsConfig> {
  const now = Date.now();
  const cached = staticProductsConfigCache.get(service);
  if (cached && cached.expiresAt > now) {
    return cached.config;
  }
  const cachedRequest = staticProductsConfigRequest.get(service);
  if (cachedRequest) {
    return cachedRequest;
  }

  if (typeof service.getStaticProducts !== "function") {
    return {};
  }

  // 静态套餐来自远端 client/configs，但只有用户真正查看套餐列表时才需要请求；
  // 这里做一天内存缓存和进行中请求合并，避免设置页重渲染或多个 provider 卡片重复拉配置。
  const request = service.getStaticProducts();
  staticProductsConfigRequest.set(service, request);
  try {
    const config = await request;
    staticProductsConfigCache.set(service, {
      config,
      expiresAt: now + CODING_PLAN_STATIC_PRODUCTS_CACHE_TTL_MS,
    });
    return config;
  } finally {
    if (staticProductsConfigRequest.get(service) === request) {
      staticProductsConfigRequest.delete(service);
    }
  }
}

// [契约] 合并只补缺失字段，已有字段一律保留远端值。
// [契约] 没有预览对象时返回静态条目的浅拷贝，避免调用方共享同一引用。
// [失败路径] 若返回原对象，下游修改会污染静态常量表。
// [权衡] 浅合并足够，嵌套字段在两侧结构一致。
function mergeStaticProductWithPreview(
  staticProduct: CodingPlanProductDisplay,
  previewProduct: CodingPlanProductPreviewPayment | undefined,
): CodingPlanProductDisplay {
  if (!previewProduct) {
    return {
      ...staticProduct,
      hasPreview: false,
    };
  }

  return {
    ...staticProduct,
    inCurrentPeriod: previewProduct.inCurrentPeriod,
    lastValid: previewProduct.lastValid,
    effectiveTime: previewProduct.effectiveTime,
    originalAmount: previewProduct.originalAmount,
    discountAmount: previewProduct.discountAmount,
    payAmount: previewProduct.payAmount,
    monthlyOriginalAmount: previewProduct.monthlyOriginalAmount,
    monthlyRenewAmount: previewProduct.monthlyRenewAmount,
    monthlyPayAmount: previewProduct.monthlyPayAmount,
    renewAmount: previewProduct.renewAmount,
    canPurchase: previewProduct.canPurchase,
    soldOut: previewProduct.soldOut,
    hasFirstTimeSubscriptionPromo: previewProduct.hasFirstTimeSubscriptionPromo,
    delay: previewProduct.delay,
    canRepurchase: previewProduct.canRepurchase,
    forbidden: previewProduct.forbidden,
    campaignDiscountDetails: previewProduct.campaignDiscountDetails,
    hasPreview: true,
  };
}

// [契约] 错误归一化优先取 Error 的消息，其次取字符串，最后回退固定文案。
// [契约] 空消息不能作为结果，否则界面会出现空白错误提示。
// [失败路径] 若直接返回未知值的字符串化结果，对象会变成无意义的类型标签。
// [权衡] `normalizeErrorMessage` 不过滤敏感信息，调用方只展示给开发者或已确认安全的场景。
// [契约] 归一化结果同时参与登录态判定，必须保持稳定字面量。
export function normalizeErrorMessage(error: unknown): string {
  const message = readErrorMessage(error);
  if (isCodingPlanSystemBusyMessage(message)) {
    // 支付接口可能返回 WAF HTML 或 JSON 解析错误。
    // 这类内容不能直接展示给用户，统一提示系统繁忙。
    return CODING_PLAN_SYSTEM_BUSY;
  }
  if (isCodingPlanOAuthRequiredMessage(message)) {
    // 套餐/支付接口仍依赖 OAuth 登录态。
    // token 过期、损坏或缺失时要引导用户重新登录/连接，不能直接展示后端原始 token 错误。
    return CODING_PLAN_OAUTH_REQUIRED_ERROR;
  }
  return message;
}

export function isCodingPlanOAuthRequiredError(error: string): boolean {
  return (
    error === CODING_PLAN_OAUTH_REQUIRED_ERROR ||
    error === "bigmodel_oauth_required" ||
    error === "zai_oauth_required" ||
    isCodingPlanOAuthRequiredMessage(error)
  );
}

export function isCodingPlanSystemBusyError(error: string): boolean {
  return error === CODING_PLAN_SYSTEM_BUSY || isCodingPlanSystemBusyMessage(error);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return String(error);
}

function isCodingPlanSystemBusyMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("<!doctype") ||
    /<\s*(html|head|body|script|style|title|meta)\b/.test(normalized) ||
    normalized.includes("errors.aliyun.com") ||
    normalized.includes("request has been blocked") ||
    normalized.includes("unexpected token '<'") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("invalid json response")
  );
}

function isCodingPlanOAuthRequiredMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized === "bigmodel_oauth_required" ||
    normalized === "zai_oauth_required" ||
    normalized.includes("oauth_required") ||
    /\b401\b|\b403\b/.test(normalized) ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("token expired") ||
    normalized.includes("expired or incorrect") ||
    normalized.includes("invalid token") ||
    normalized.includes("access token")
  );
}
