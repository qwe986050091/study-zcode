/* eslint-disable max-lines -- entitlement hook 集中处理缓存、共享 in-flight、轮询和 Team Plan 上下文，后续拆分需保持刷新策略一致。 */
// 本文件是 Coding Plan / Team Plan 权益快照的读取编排层：负责合并 in-flight 请求、
// 跨组件共享快照、同步缓存回显、超时与失败降级，并把刷新语义收敛到一个 refresh 函数。
// 不负责：不解析 quota 响应、不做计费、不决定 UI 展示形态、不写入 provider 配置。
//
// 不变量（改动前必读；任意一条被破坏，线上症状通常是 quota RPC 放大或账号/团队串号）：
// INV-01 断言：同一服务实例 + 同一 requestKey 的并发读取必须复用一个进行中的 Promise —— 守住它的位置：entitlementInflightRequests 与 getSharedEntitlementSnapshot —— 改错故障：启动时侧栏、工具栏、设置页各发一次 quota，同一分钟十余个重复 RPC 拖慢 renderer。
// INV-02 断言：摘除 in-flight 条目之前必须先比较 Promise 引用 —— 守住它的位置：finally 里的 serviceRequests.get(requestKey) 与 request 的比较 —— 改错故障：后发请求被先完成者删掉，第三个调用方拿到已结束的 Promise 显示空额度。
// INV-03 断言：超时只放弃本 hook 的等待，不取消、不重试上游 RPC —— 守住它的位置：withUsageEntitlementTimeout —— 改错故障：超时后重复打真实接口，账单侧看到成倍 quota 调用。
// INV-04 断言：超时定时器必须在 finally 中清理 —— 守住它的位置：Promise.race 之后的 finally —— 改错故障：每个超时请求残留一个 20 秒计时器，单测进程无法退出。
// INV-05 断言：accountAccess 必须先经 useStableAccountAccess 稳定引用 —— 守住它的位置：useUsageEntitlementWithService 的 accountAccess 赋值 —— 改错故障：设置页 schema 每次解析产出等值新对象，依赖抖动导致每次渲染重启请求。
// INV-06 断言：身份 scope 必须由 user.id 与 authSessionSeq 组成 —— 守住它的位置：useZCodeStoreWithDefault 选择器 —— 改错故障：切换账号后沿用上一账号的共享快照，额度与套餐串号。
// INV-07 断言：空 cacheKey 必须保持空串（不落盘），账号前缀只加在非空 key 上 —— 守住它的位置：suppliedCacheKey、freshnessCacheKey、cacheKey 三行赋值 —— 改错故障：声明不缓存的入口把数据写进磁盘，或多账号共用一个缓存键读到别人的额度。
// INV-08 断言：RPC 参数只能来自白名单字段，必须逐项手工展开 —— 守住它的位置：requestOptions 与 getEntitlementSnapshot 调用 —— 改错故障：透传整个 options 让参数与 requestKey 不一致，in-flight 合流与共享快照同时失效。
// INV-09 断言：freshnessKey 必须包含 cacheKey 与全部请求维度 —— 守住它的位置：buildEntitlementFreshnessKey 调用 —— 改错故障：切换 provider 或订阅开关后仍命中旧共享快照，banner 显示上一家供应商的额度。
// INV-10 断言：回包归属必须同时校验 requestScope 对象身份与 requestVersion —— 守住它的位置：await 之后与 catch 开头的提前 return —— 改错故障：切换 workspace 后旧回包写回 state，新页面闪出上一个工作区的额度。
// INV-11 断言：freshnessKey 变化时必须递增 requestVersion、重置 active key 并清空快照 —— 守住它的位置：第二个 effect 的 freshnessKeyChanged 分支 —— 改错故障：旧团队快照让 initial refresh 被 defer 跳过，设置页长期显示上一个团队的用量。
// INV-12 断言：enabled 为 false 时必须同时清 state、activeFreshnessKeyRef、latestSnapshotRef —— 守住它的位置：第二个 effect 的 !enabled 分支 —— 改错故障：缺少 API Key 时 UI 仍显示旧套餐，无 key 入口被误判为可查询。
// INV-13 断言：只有通过归属校验的当前请求才能 publish 共享快照 —— 守住它的位置：try 块内 publishSharedEntitlementSnapshot 之前的 return —— 改错故障：被丢弃的旧请求把过期快照广播给所有订阅者，并污染 isCurrent 判定。
// INV-14 断言：命中共享快照或 defer 分支时不得写磁盘缓存 —— 守住它的位置：refresh 的两处提前 return —— 改错故障：把别人的或过期的快照写回磁盘，之后每次冷启动都错误回显。
// INV-15 断言：silent 刷新且已有快照时不得把 loading 置 true —— 守住它的位置：refresh 发起请求前的 setState —— 改错故障：Plan Card 从缓存态跳回 checking，每次进入设置都像重新加载。
// INV-16 断言：失败时是否保留旧快照由 silent 与 subscription.details 共同决定 —— 守住它的位置：catch 内的 setState 分支 —— 改错故障：网络抖动把可用套餐打回空态，或切换 provider 失败后继续显示上一家品牌。
// INV-17 断言：返回对象暴露的 snapshot 与 error 必须经 activeFreshnessKeyRef 守卫 —— 守住它的位置：hook 末尾的返回字面量 —— 改错故障：切换团队的首帧把上一团队的额度渲染给新团队，出现瞬时串号。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import {
  readCachedUsageEntitlementSnapshot,
  writeCachedUsageEntitlementSnapshot,
} from "@/lib/usageEntitlementCache.js";
import {
  hasSharedEntitlementFailure,
  buildEntitlementFreshnessKey,
  beginSharedEntitlementRequest,
  publishSharedEntitlementSnapshot,
  readSharedEntitlementSnapshot,
  recordSharedEntitlementAccess,
  recordSharedEntitlementFailure,
  shouldDeferSharedEntitlementRefresh,
  shouldDeferSharedEntitlementAccess,
  shouldUseSharedEntitlementSnapshot,
  subscribeSharedEntitlementSnapshot,
  USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
  type UsageEntitlementRefreshReason,
  type UsageEntitlementRequestOptions,
} from "@/lib/usageEntitlementRefreshPolicy.js";

interface UsageEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: UsageEntitlementState = {
  snapshot: null,
  loading: false,
  error: null,
};

// 超时口径是“本 hook 愿意等多久”，不是上游 RPC 的超时：上游完全不感知，前端只是放弃等待。
// 20 秒覆盖冷启动时 provider 探测加余额查询的尾延迟，缩短会把慢但成功的首次加载打成错误态。
// 测试需要更短超时只能显式传参，不要为了跑得快改这个默认值，它同时是生产兜底。
export const USAGE_ENTITLEMENT_REFRESH_TIMEOUT_MS = 20_000;

export interface UsageEntitlementRefreshOptions {
  silent?: boolean;
  force?: boolean;
  reason?: UsageEntitlementRefreshReason;
}

// 键是服务实例而不是 workspace 路径：同一 workspace 可能先后挂载不同实例，按路径复用会拿到别人的请求。
// 值是该实例下 requestKey 到 Promise 的映射，requestKey 已包含 provider、账户与请求维度。
// 用 WeakMap 是为了实例被回收时映射一起消失，避免反复创建服务的测试与热重载场景常驻内存。
const entitlementInflightRequests = new WeakMap<
  IUsageStatsService,
  Map<string, Promise<UsageEntitlementSnapshot>>
>();

function getSharedEntitlementSnapshot(params: {
  usageStatsService: IUsageStatsService;
  options: UsageEntitlementRequestOptions;
  requestKey: string;
}): Promise<UsageEntitlementSnapshot> {
  let serviceRequests = entitlementInflightRequests.get(params.usageStatsService);
  if (!serviceRequests) {
    serviceRequests = new Map();
    entitlementInflightRequests.set(params.usageStatsService, serviceRequests);
  }

  const requestKey = params.requestKey;
  const inflight = serviceRequests.get(requestKey);
  // [并发] 命中进行中的请求就直接返回同一个 Promise，调用者不感知自己被合流。
  // 不要在这里包一层 catch 做状态转换：各调用方对失败的 UI 语义不同，包起来会把 A 的错误喂给 B。
  // 也不要 clone 或加 then 映射返回值，那会让 finally 里的引用比较认不出原对象。
  if (inflight) {
    return inflight;
  }

  // 侧栏、工具栏、设置页和 Usage 页会在启动/打开设置时同时读取同一份
  // Coding Plan entitlement。生产日志里同一分钟出现 12 个相同 quota RPC，直接拖慢 renderer。
  // 这里按服务实例 + 请求参数合并 in-flight 请求，保留各组件自己的状态更新语义。
  // [契约] 逐字段展开而不是透传 params.options，是防止 UI 专用字段漏进 RPC 参数的唯一屏障。
  // 新增请求维度时三处必须同步：requestOptions、freshnessKey 构造、这里的手工展开。
  // invalidateBalanceCache 只在真正要穿透服务层余额缓存时传 true，条件位不能退化成常量。
  const upstreamRequest = params.usageStatsService.getEntitlementSnapshot({
    ...(params.options.invalidateBalanceCache ? { invalidateBalanceCache: true } : {}),
    includeSubscription: params.options.includeSubscription,
    preferredProviderId: params.options.preferredProviderId,
    accountAccess: params.options.accountAccess,
    allowDisabledPreferredProvider: params.options.allowDisabledPreferredProvider,
    requirePreferredProvider: params.options.requirePreferredProvider,
    allowEnvApiKey: params.options.allowEnvApiKey,
  });
  // [资源][并发] finally 负责把本请求从映射里摘除，成功、失败、超时三条路径都会经过这里。
  // 先比较 get(requestKey) 与新 Promise 再删除，是防止后发请求已覆盖同 key 时误删他人条目。
  // request 在自身 finally 中被比较，回调异步执行保证此时已赋值，不要在同步路径提前引用。
  const request = withUsageEntitlementTimeout(upstreamRequest).finally(() => {
    if (serviceRequests.get(requestKey) !== request) {
      return;
    }
    serviceRequests.delete(requestKey);
    if (serviceRequests.size === 0) {
      entitlementInflightRequests.delete(params.usageStatsService);
    }
  });
  serviceRequests.set(requestKey, request);
  return request;
}

// 错误可能是 Error、带 message 的对象或任意值，统一收敛成字符串，避免 [object Object] 直接进 UI。
// 优先 message 而不是 name，超时错误靠 message 里的错误码被日志与断言识别。
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

function createUsageEntitlementTimeoutError(timeoutMs: number): Error {
  return new Error(`usage_entitlement_request_timeout:${timeoutMs}`);
}

// [失败路径] 超时用 race 实现：先完成者决定结果，上游请求继续跑完并在无人接收时被丢弃。
// 这里故意不做取消，取消需要服务层支持 AbortSignal，前端单方面 abort 只会制造半开连接。
// 返回类型保持原 Promise 的值类型，调用方不需要处理 undefined 分支。
export function withUsageEntitlementTimeout<T>(
  request: Promise<T>,
  timeoutMs = USAGE_ENTITLEMENT_REFRESH_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createUsageEntitlementTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  // [资源] finally 必须清定时器：超时先触发时 request 可能仍挂起，残留计时器会拖住测试进程退出。
  // 超时只拒绝 race，不会拒绝原始 request，所以不会产生未处理的 rejection。
  // 上游先完成时清理逻辑同样生效，重复 clearTimeout 没有副作用，不要加额外判断把它跳过。
  // 错误码里带毫秒数，日志可据此区分是按默认值超时还是测试传入了短超时。
  return Promise.race([request, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export interface UseUsageEntitlementOptions {
  enabled?: boolean;
  includeSubscription?: boolean;
  preferredProviderId?: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  allowDisabledPreferredProvider?: boolean;
  requirePreferredProvider?: boolean;
  allowEnvApiKey?: boolean;
  cacheKey?: string;
  refreshOnMount?: boolean;
  mountRefreshReason?: "initial" | "access";
}

export function useUsageEntitlement(options: UseUsageEntitlementOptions = {}) {
  const services = useOptionalBaseWorkspaceServices();
  return useUsageEntitlementWithService(services?.usageStatsService, options);
}

export function useUsageEntitlementWithService(
  usageStatsService: IUsageStatsService | undefined,
  options: UseUsageEntitlementOptions = {},
) {
  // 初始态是模块级共享对象，只作为首次渲染值；所有更新都用新对象整体替换，不能就地改字段。
  // 初始 loading 为 false：缓存回显发生在 effect 里，首帧不应该凭空出现加载态。
  const [state, setState] = useState<UsageEntitlementState>(INITIAL_STATE);
  // `requestVersionRef` 只在发起请求时递增：回包与当前代不一致即丢弃，避免旧响应覆盖新额度。
  // 回包被丢弃不等于取消上游，旧请求仍会跑完并尝试写共享快照，所以 publish 前也要校验 isCurrent。
  // 递增点有两处：refresh 发请求前、freshnessKey 变化时，少一处旧回包就能写回 state。
  const requestVersionRef = useRef(0);
  const activeFreshnessKeyRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<UsageEntitlementSnapshot | null>(null);
  // Web/SSR 场景可能只渲染侧栏或设置入口，没有挂载 ServiceProvider。
  // 这里降级为空快照，避免 Usage banner 因服务上下文缺失阻断整棵 UI。
  // 默认 false：多数入口只关心额度，开启订阅明细会改变 freshnessKey 与共享请求 key。
  // Web 与 SSR 可能没有 ServiceProvider，enabled 已兜住空服务，这里的默认值只负责语义一致。
  // 改动默认值会让同一份共享快照在不同入口间无法复用，直接放大 quota RPC。
  const includeSubscription = options.includeSubscription ?? false;
  const preferredProviderId = options.preferredProviderId;
  // Provider Settings schema 每次解析会产生等值新对象，不能因引用变化重启权益请求。
  // Provider Settings 每次解析 schema 都会产出等值新对象，这个 hook 把引用稳定下来。
  // 直接把 options.accountAccess 放进依赖数组，会让父组件每次渲染都换 freshnessKey 并重启请求。
  // 稳定化只解决引用，不解决语义：账号清空后仍要等 authScope 变化才会隔离缓存。
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const allowDisabledPreferredProvider = options.allowDisabledPreferredProvider === true;
  const requirePreferredProvider = options.requirePreferredProvider === true;
  const allowEnvApiKey = options.allowEnvApiKey;
  // 身份 scope 由用户 id 与会话序号拼成，登出或换号都会让它变化，进而换掉 cacheKey 与 freshnessKey。
  // 选择器必须返回字符串而不是对象，否则默认比较永远判不等，每个渲染都会重启刷新。
  // 未登录时返回 signed-out 而不是空串，enabled 依赖这个特定值显式关闭请求。
  const authScope = useZCodeStoreWithDefault(
    (store) => (store.user ? `${store.user.id}:${store.authSessionSeq}` : "signed-out"),
    "unscoped",
  );
  // 三个条件同时成立才允许请求：调用方开关、服务实例存在、身份可见。
  // enabled 变 false 时不清磁盘缓存，只清内存快照；同一账号重新登录仍可秒回显。
  // 不要把供应商可用性判断塞进这里，那属于服务层与快照字段的职责，混进来会让开关语义无法推理。
  const enabled =
    (options.enabled ?? true) && Boolean(usageStatsService) && authScope !== "signed-out";
  const suppliedCacheKey = options.cacheKey?.trim() ?? "";
  const freshnessCacheKey =
    authScope === "unscoped" ? suppliedCacheKey : `${suppliedCacheKey}:auth:${authScope}`;
  // 保留空 cacheKey 的不落盘合同；账号隔离仍适用于共享请求和快照。
  // [契约] 空 cacheKey 保持空串：调用方显式声明不落盘时，不能因为加了账号前缀就变成可写缓存。
  // 非空时才拼上 authScope，保证同一浏览器多账号各有一份磁盘缓存。
  // cacheKey 的变化同时作用于共享 freshness，改格式等于让历史共享快照全部失效，属破坏性变更。
  const cacheKey = suppliedCacheKey ? freshnessCacheKey : "";
  const refreshOnMount = options.refreshOnMount ?? false;
  const mountRefreshReason = options.mountRefreshReason ?? "initial";
  // satisfies 只做类型对齐，不会裁剪多余字段，真正裁剪靠调用处逐项展开。
  // 依赖数组必须覆盖每个参与请求的字段，漏一个就会在切换 provider 后继续用旧闭包请求。
  // 依赖稳定时保持同一引用，这是 freshnessKey 与共享请求 key 能一致的前提。
  const requestOptions = useMemo(
    () =>
      ({
        includeSubscription,
        preferredProviderId,
        accountAccess,
        allowDisabledPreferredProvider,
        requirePreferredProvider,
        allowEnvApiKey,
      }) satisfies UsageEntitlementRequestOptions,
    [
      allowDisabledPreferredProvider,
      accountAccess,
      allowEnvApiKey,
      includeSubscription,
      preferredProviderId,
      requirePreferredProvider,
    ],
  );
  // freshnessKey 是“这份快照属于哪个账号的哪份 provider 配置”的指纹，共享快照、缓存与 defer 判定都靠它。
  // cacheKey 用带账号前缀的版本，options 用稳定引用，任何一项变化都必须产生新指纹。
  // 不要把时间戳或随机数塞进 key，否则每次渲染都是新指纹，共享与缓存能力直接归零。
  const freshnessKey = useMemo(
    () =>
      buildEntitlementFreshnessKey({
        cacheKey: freshnessCacheKey,
        options: requestOptions,
      }),
    [freshnessCacheKey, requestOptions],
  );

  // 原因：effect 清理之前也可能收到旧回包；请求归属必须跟随渲染时的服务、身份和 enabled。
  // [并发] 刻意用空对象做身份标记：依赖变化时产生新引用，refresh 闭包据此判断自己是否已过期。
  // effect 清理只在引用仍相等时置 null，避免把新作用域误清；两者配合才构成完整的回包归属判定。
  // 若改成布尔值或字符串常量，切换 workspace 后旧请求会继续写 state，表现为新页面闪一下旧额度。
  const requestScope = useMemo(() => ({}), [usageStatsService, enabled, freshnessKey]);
  const currentRequestScope = useRef<object | null>(requestScope);
  currentRequestScope.current = requestScope;
  useEffect(() => {
    currentRequestScope.current = requestScope;
    return () => {
      if (currentRequestScope.current === requestScope) currentRequestScope.current = null;
    };
  }, [requestScope]);

  const refresh = useCallback(
    async (refreshOptions: UsageEntitlementRefreshOptions = {}) => {
      // refresh 可能被按钮、定时器或订阅在卸载后调用，这里用 enabled 与作用域双重兜底。
      // 返回 undefined 而不是抛错，所有调用方都按 fire-and-forget 使用。
      // 不要在这里 setState 提示已取消，卸载后的 setState 会触发 React 警告并掩盖真实错误。
      if (!enabled || !usageStatsService || currentRequestScope.current !== requestScope) {
        return;
      }
      const reason = refreshOptions.reason ?? "manual";
      // 四种 reason 的共享窗口不同：initial 允许无限期复用已有共享快照，access 只用一分钟窗口，manual 与 purchase 不共享。
      // force 为 true 时连 initial 的无限窗口也不认，供立即刷新按钮与购买后回查使用。
      // access 的一分钟窗口是 hover、套餐卡与 Usage 页短时间重复打开的主要止流阀，去掉它会成倍放大 quota RPC。
      // 不要把这串嵌套三元改写成查表对象：新增 reason 时必须显式决定窗口，落空时退化为不共享更安全。
      const sharedSnapshot =
        refreshOptions.force === true
          ? null
          : reason === "initial"
            ? shouldUseSharedEntitlementSnapshot({
                freshnessKey,
                intervalMs: Number.POSITIVE_INFINITY,
                now: Date.now(),
                usageStatsService,
              })
            : reason === "access"
              ? shouldUseSharedEntitlementSnapshot({
                  freshnessKey,
                  // Context hover、套餐卡和 Usage 页打开会在短时间内
                  // 读取同一份额度。访问刷新必须共享一分钟窗口，避免反复 hover 放大 quota RPC。
                  intervalMs: USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
                  now: Date.now(),
                  usageStatsService,
                })
              : null;
      if (sharedSnapshot) {
        setState({
          snapshot: sharedSnapshot,
          loading: false,
          error: null,
        });
        latestSnapshotRef.current = sharedSnapshot;
        return;
      }
      if (
        refreshOptions.force !== true &&
        reason === "access" &&
        shouldDeferSharedEntitlementAccess({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        })
      ) {
        setState((current) => ({ ...current, loading: false }));
        return;
      }
      if (
        refreshOptions.force !== true &&
        (reason === "initial" || reason === "access") &&
        shouldDeferSharedEntitlementRefresh({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        })
      ) {
        setState((current) => ({
          ...current,
          loading: false,
        }));
        return;
      }

      // 共享请求必须在真正发起前登记，否则并发调用者看不到 in-flight 条目，合流当场失效。
      // invalidate 只在 purchase 时为 true：购买后用新余额覆盖服务层缓存，其他 reason 必须继续复用余额。
      // requestKey 由策略层统一生成并同时用于本地 in-flight 映射，两处必须来自同一次调用。
      const sharedRequest = beginSharedEntitlementRequest({
        usageStatsService,
        freshnessKey,
        invalidate: reason === "purchase",
      });
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      if (reason === "access") {
        recordSharedEntitlementAccess({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        });
      }
      logger.debug("[useUsageEntitlement] 开始读取权益信息", {
        reason,
        includeSubscription,
        preferredProviderId,
        accountAccess,
        cacheKey,
        freshnessKey,
      });
      // [契约] silent 且已有快照时保持 loading 为 false，否则 Plan Card 会从缓存态跳回 checking。
      // 保留 current.snapshot 而不是清空：后台校正期间 UI 继续显示上一份可用数据。
      // error 在发起时清空，避免上一次失败提示与本次结果并存，用户会看到又失败又成功的矛盾状态。
      // 只有非 silent 或没有快照时才置 true，首次进入与切换 provider 需要明确的加载态。
      setState((current) => ({
        snapshot: current.snapshot,
        // Plan Card 已有短 TTL 缓存时，进入 provider 只需要后台校正权益。
        // 继续把 loading 置 true 会让卡片从缓存态跳回 checking，用户每次进入都像重新加载。
        loading: refreshOptions.silent && current.snapshot ? false : true,
        error: null,
      }));

      try {
        // purchase 用新对象叠加 invalidateBalanceCache，其余 reason 直接复用稳定引用，减少共享 key 抖动。
        // requestKey 与 requestOptions 必须同源：手工改这里会让映射键与实际参数不一致，合流悄悄失效。
        // 拿到的 Promise 已被超时包装，catch 里可能是超时错误而不是服务端错误，错误文案不要假定来源。
        const snapshot = await getSharedEntitlementSnapshot({
          usageStatsService,
          requestKey: sharedRequest.requestKey,
          options:
            reason === "purchase"
              ? { ...requestOptions, invalidateBalanceCache: true }
              : requestOptions,
        });
        if (
          currentRequestScope.current !== requestScope ||
          requestVersionRef.current !== requestVersion ||
          !sharedRequest.isCurrent()
        ) {
          return;
        }
        // 只有通过作用域、版本与 isCurrent 三重校验的请求才有资格广播，否则会把过期快照推给所有订阅者。
        // publish 与本地 setState 的顺序固定：先广播让其他入口尽快更新，再更新本入口。
        // 同时写 latestSnapshotRef 是为了让失败分支不依赖可能已被批处理延迟的 state。
        publishSharedEntitlementSnapshot({
          usageStatsService,
          freshnessKey,
          snapshot,
        });
        logger.debug("[useUsageEntitlement] 权益信息已更新", {
          reason,
          providerId: snapshot.provider?.id ?? null,
          scope: snapshot.context?.scope ?? null,
          organizationId: snapshot.context?.organizationId ?? null,
          projectId: snapshot.context?.projectId ?? null,
          cacheKey,
          freshnessKey,
        });
        latestSnapshotRef.current = snapshot;
        setState({
          snapshot,
          loading: false,
          error: null,
        });
        writeCachedUsageEntitlementSnapshot({ cacheKey, snapshot });
      } catch (error) {
        if (
          currentRequestScope.current !== requestScope ||
          requestVersionRef.current !== requestVersion ||
          !sharedRequest.isCurrent()
        ) {
          return;
        }
        recordSharedEntitlementFailure({
          usageStatsService,
          freshnessKey,
        });
        const message = getErrorMessage(error);
        logger.warn("[useUsageEntitlement] 读取权益信息失败", {
          includeSubscription,
          error: message,
        });
        if (
          !latestSnapshotRef.current?.subscription?.details.length &&
          !(refreshOptions.silent && latestSnapshotRef.current)
        ) {
          latestSnapshotRef.current = null;
        }
        // [失败路径] 已确认订阅或后台静默刷新失败时保留旧快照，只把错误挂到 error 上，避免可用状态被打回空态。
        // 其余情况清空快照：切换 provider 后新 provider 查询失败时，继续显示上一家品牌与额度比空态更误导。
        // 两个条件顺序不能反：先判 silent 的隐式保留，再判订阅明细的显式已付费。
        // 清空快照前 latestSnapshotRef 已被前面逻辑置 null，保证后续请求不再把旧数据当兜底。
        setState((current) => {
          if (
            current.snapshot &&
            (refreshOptions.silent || current.snapshot.subscription?.details.length)
          ) {
            return {
              // 后台刷新或已确认订阅的手动刷新失败时，保留上次成功结果。
              // 否则网络抖动会把 Plan Card 从可用状态打回空态/错误态。
              snapshot: current.snapshot,
              loading: false,
              error: message,
            };
          }
          return {
            // 切换 BigModel/Z.AI 后如果新 provider 查询失败，继续保留旧 snapshot 会让 banner/浮窗显示上一家供应商。
            // 出错时清空快照，避免用过期品牌和额度误导用户。
            snapshot: null,
            loading: false,
            error: message,
          };
        });
      }
    },
    [cacheKey, enabled, freshnessKey, requestOptions, usageStatsService, requestScope],
  );

  // 订阅共享快照让同 provider 的其他入口 publish 时立刻同步，不必各自再发请求。
  // 回调里必须校验 requestScope：旧作用域的订阅可能在新团队挂载之后才收到广播。
  // 订阅同时带来 error，原样写入 state 而不是在这里转字符串，保持与 refresh 分支一致的错误形态。
  useEffect(() => {
    if (!enabled || !usageStatsService) {
      return;
    }
    return subscribeSharedEntitlementSnapshot({
      usageStatsService,
      freshnessKey,
      listener: (snapshot, error) => {
        if (currentRequestScope.current !== requestScope) return;
        latestSnapshotRef.current = snapshot;
        setState({
          snapshot,
          loading: false,
          error: error ?? null,
        });
      },
    });
  }, [enabled, freshnessKey, usageStatsService, requestScope]);

  // enabled 变 false 时必须三处一起清：state、activeFreshnessKeyRef、latestSnapshotRef，缺一处就会漏出旧账号数据。
  // activeFreshnessKeyRef 置 null 后，返回对象里的守卫会把 snapshot 与 error 一起压成 null。
  // 这里不做任何请求副作用，只是状态收口，所以没有把 refresh 放进依赖。
  useEffect(() => {
    if (!enabled) {
      setState({
        // Coding Plan 缺少 API Key 或切换供应商时会临时禁用查询。
        // 保留上一轮 snapshot 会让 UI 继续显示旧账号的套餐状态，并诱发无 key 的入口被误判为可查。
        snapshot: null,
        loading: false,
        error: null,
      });
      activeFreshnessKeyRef.current = null;
      latestSnapshotRef.current = null;
      return;
    }

    // [并发] Team Plan 切换团队项目会换 freshnessKey，旧团队的 active 快照会让 initial refresh 被 defer 策略跳过。
    // 递增 requestVersion 是让飞行中的旧请求失效，同时清空最新快照，防止回包把数据填回来。
    // setState 用共享初始对象表达整体重置，不要改成保留 error 或部分字段。
    const freshnessKeyChanged = activeFreshnessKeyRef.current !== freshnessKey;
    if (freshnessKeyChanged) {
      // Team Plan 切换团队项目后，旧团队 active snapshot 会让 initial refresh
      // 被 freshness 策略跳过，设置页继续显示上一个团队的用量。freshness key 变化时必须
      // 先废掉旧请求和旧快照，再用新团队的缓存/共享快照启动刷新。
      requestVersionRef.current += 1;
      activeFreshnessKeyRef.current = freshnessKey;
      latestSnapshotRef.current = null;
      setState(INITIAL_STATE);
    }

    // 先读共享快照再读磁盘缓存：共享快照来自当前进程内其他入口，时间上不会旧于磁盘。
    // 两者都按 freshnessKey 隔离，命中即代表同 provider、同账号口径，可以直接回显。
    // 缓存读取放在 effect 而不是渲染期，避免每次渲染都同步触碰存储造成掉帧。
    const cachedSnapshot = readCachedUsageEntitlementSnapshot({ cacheKey });
    const sharedSnapshot = usageStatsService
      ? readSharedEntitlementSnapshot({ usageStatsService, freshnessKey })
      : null;
    const initialSnapshot = sharedSnapshot ?? cachedSnapshot;
    if (initialSnapshot) {
      // Coding Plan 状态打开设置页时不必等待 quota 接口返回才变绿。
      // 先用同 provider 指纹下的短 TTL 缓存回显，再由 refresh 后台校正真实权益。
      setState({
        snapshot: initialSnapshot,
        loading: false,
        error:
          usageStatsService && hasSharedEntitlementFailure({ usageStatsService, freshnessKey })
            ? "usage_entitlement_refresh_failed"
            : null,
      });
      latestSnapshotRef.current = initialSnapshot;
    }

    if (refreshOnMount) {
      void refresh({
        silent: Boolean(initialSnapshot),
        force: mountRefreshReason === "initial" && !initialSnapshot,
        reason: mountRefreshReason,
      });
    }
  }, [
    cacheKey,
    enabled,
    freshnessKey,
    refresh,
    refreshOnMount,
    mountRefreshReason,
    usageStatsService,
  ]);

  // 返回的 snapshot 与 error 都受 activeFreshnessKeyRef 守卫：切换窗口期先返回 null，避免把上一团队额度渲染给新团队。
  // loading 只受 enabled 影响，因为后台刷新期间保留旧快照比隐藏加载指示更重要。
  // refresh 直接透传，不要在返回对象里再包一层，否则函数身份每次渲染都变，下游 effect 会被反复触发。
  return {
    snapshot: enabled && activeFreshnessKeyRef.current === freshnessKey ? state.snapshot : null,
    loading: enabled && state.loading,
    error: enabled && activeFreshnessKeyRef.current === freshnessKey ? state.error : null,
    refresh,
  };
}
