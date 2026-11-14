// useUsageStats.ts —— 用量统计的三个 React 查询入口（通用 / 本地 App / Coding Plan）。
// 职责：把 usageStatsService 的快照查询包装成 hook 状态，维护 loading/error、请求代次、
// 跨 scope 的快照保留策略，以及 Coding Plan 按 service 实例共享的访问缓存。
// 不负责：权益与额度判定、订阅状态计算、缓存落盘、数据源鉴权与轮询定时器，这些都不在本文件。
//
// INV-01 断言：任一异步结果写 state 前必须比对 requestVersionRef —— 守住它的位置：refresh 成功与失败两处早退 —— 改错故障：旧请求覆盖新账号数据，切 provider 后额度串号。
// INV-02 断言：requestScope 必须覆盖所有参与请求的参数 —— 守住它的位置：useUsageStats 的 requestScope 拼接 —— 改错故障：切数据源或环境变量开关后仍显示旧快照。
// INV-03 断言：scope 变化时必须把 snapshot 置为 null —— 守住它的位置：refresh 的 setState 与 catch 分支 —— 改错故障：跨账号显示上一家的用量数字。
// INV-04 断言：同 scope 重刷必须保留旧快照 —— 守住它的位置：keepPreviousSnapshot 判断 —— 改错故障：手动刷新时整块面板闪空。
// INV-05 断言：requestVersion 必须在 await 之前完成自增 —— 守住它的位置：refresh 开头 —— 改错故障：并发刷新互相覆盖，最后一次点击的结果被丢弃。
// INV-06 断言：Coding Plan 缓存键必须包含 range 与两个自定义日期 —— 守住它的位置：requestScopeKey 定义 —— 改错故障：不同时间范围共用缓存，图表张冠李戴。
// INV-07 断言：快照保留判定只看 provider 与 accountAccess —— 守住它的位置：requestIdentityKey 定义 —— 改错故障：仅切换日期范围时面板被错误清空。
// INV-08 断言：requestedAt 只能写成功快照的生成时间 —— 守住它的位置：发请求后的 serviceCache 写入 —— 改错故障：在途状态被当作新鲜数据，重新打开页面不刷新。
// INV-09 断言：inFlight 必须保存原始 Promise 供同 scope 复用 —— 守住它的位置：发请求分支 —— 改错故障：同 scope 多实例重复请求且结果互相覆盖。
// INV-10 断言：写 cache 前必须确认 inFlight 仍是本次请求 —— 守住它的位置：成功分支的 serviceCache 判断 —— 改错故障：迟到的旧请求覆盖新请求的缓存。
// INV-11 断言：请求失败必须删除本次预写的 cache entry —— 守住它的位置：catch 分支的 delete —— 改错故障：TTL 内重开同一组织会跳过真实请求并静默吞掉错误。
// INV-12 断言：latestSnapshotRef 与 state.snapshot 必须同进同退 —— 守住它的位置：成功分支、失败分支、守卫分支 —— 改错故障：回调读到幽灵快照，或清空后被旧值回填。
// INV-13 断言：enabled、provider、accountAccess 缺一必须清空状态 —— 守住它的位置：refresh 开头的守卫 —— 改错故障：禁用态继续展示可点击的旧额度。
// INV-14 断言：错误文案不得携带凭据或内部地址 —— 守住它的位置：getErrorMessage 与各 logger 调用 —— 改错故障：token、账号 id 进入日志与界面。
// INV-15 断言：timeZone 必须每次刷新现取 —— 守住它的位置：三处 refresh 开头 —— 改错故障：用户改系统时区后需重启应用才生效。
// INV-16 断言：useCallback 依赖必须覆盖全部闭包变量 —— 守住它的位置：三个 refresh 的依赖数组 —— 改错故障：用过期 scope 发请求，参数与展示错位。
// INV-17 断言：enabled 为 false 时 effect 必须清空并返回 —— 守住它的位置：useUsageStats 的 useEffect —— 改错故障：关闭统计后仍保留上一个 provider 的数据。
// INV-18 断言：首帧状态必须复用缓存快照 —— 守住它的位置：useCodingPlanUsageStats 的 useState 初值 —— 改错故障：重挂载时骨架屏闪一下再出内容。
// INV-19 断言：WeakMap 外层键必须是 service 实例 —— 守住它的位置：codingPlanUsageAccessCache 定义 —— 改错故障：跨 service 串缓存，测试之间互相污染。
// INV-20 断言：展示过滤只能改 refresh 内部，不在调用方二次过滤 —— 守住它的位置：三个 hook 的返回值 —— 改错故障：出现第二份状态所有权，UI 与缓存不一致。
//
// 阅读顺序：先看三处 requestScope / requestIdentityKey 的定义，再看 refresh 内「读缓存，发请求，校验代次，
// 写回调缓存，写 React state」这五步；任何一步换序都会改变用户可见的中间态（闪空、串号、错误被吞），
// 因此正文注释按这五步标注。
// 状态所有权：snapshot 归本 hook 的 React state，跨实例共享的只有 Coding Plan 的 snapshot / requestedAt /
// inFlight 三元组；latestSnapshotRef 仅供同实例回调读取，不对外导出。
// 改动约定：新行为优先改 refresh 的分支条件，而不是新增一层包装或在调用方补兜底。
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppUsageRange,
  AppUsageSnapshot,
  CodingPlanUsageRange,
  CodingPlanUsageSnapshot,
  UsageStatsRange,
  UsageStatsSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { USAGE_ENTITLEMENT_ACCESS_REFRESH_MS } from "@/lib/usageEntitlementRefreshPolicy.js";

interface UsageStatsState {
  snapshot: UsageStatsSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface AppUsageStatsState {
  snapshot: AppUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface CodingPlanUsageStatsState {
  snapshot: CodingPlanUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

// [契约] snapshot 是最近一次成功结果，允许与 inFlight 并存：请求进行中仍对外提供旧快照。
// requestedAt 只表示成功快照的生成时间，写请求开始时间会让 TTL 判定把在途当成新鲜。
// inFlight 保存同一 scope 的在途 Promise，后挂载的实例复用它而不是重新发起请求。
// 去掉 inFlight 或把它退化成布尔值，会同时失去同 scope 去重和失败时的精确清理能力。
interface CodingPlanUsageCacheEntry {
  snapshot: CodingPlanUsageSnapshot | null;
  requestedAt: number | null;
  inFlight?: Promise<CodingPlanUsageSnapshot>;
}

// [资源] 外层 WeakMap 以 usageStatsService 实例为键，service 被替换或销毁时缓存随之回收。
// 换成 Map 会让数据跨 service 实例泄漏，测试之间也无法自然失效。
// 内层 Map 只增不删，条目数上界是时间范围、provider、账号与日期范围的组合数。
const codingPlanUsageAccessCache = new WeakMap<object, Map<string, CodingPlanUsageCacheEntry>>();

// [契约] 导出给测试与调用方使用，语义只是缓存是否过期，不做任何 IO。
// lastUpdatedAt 为 null 表示从未成功刷新过，必须视为过期，否则首次访问会显示空快照。
// 比较用大于等于而非大于：正好落在边界时再刷新一次，避免临界抖动导致长期不刷新。
export function shouldRefreshCodingPlanUsageOnAccess(params: {
  lastUpdatedAt: number | null;
  now: number;
}): boolean {
  return (
    params.lastUpdatedAt === null ||
    params.now - params.lastUpdatedAt >= USAGE_ENTITLEMENT_ACCESS_REFRESH_MS
  );
}

// [失败路径] 依次取 message、name、String 结果，保证空消息时仍有可读文案。
// 非 Error 对象只接受非空字符串 message，避免把空对象或数字渲染成无意义的字符串。
// 返回值直接进入 logger 与 UI 的 error 字段，不要在这里拼接任何账号或凭据信息。
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

// [契约] 三处初始态语义对齐：不加载、无快照、无错误，首帧不闪加载态。
// 该对象被 useState 直接复用，任何分支都不要原地修改它的字段。
const INITIAL_STATE: UsageStatsState = {
  snapshot: null,
  loading: false,
  error: null,
};

// [契约] dataSource 决定查本地还是 monitor 数据，未传时由 service 自行选择默认来源。
// enabled 默认 true，但 refresh 内部仍二次判断，让关闭期间的手动触发安全空转。
// requirePreferredProvider 为 true 时只认 preferredProviderId，放宽才允许回退到其它 provider。
// allowEnvApiKey 仅在显式传 false 时关闭环境变量兜底，它进入 requestScope，改变时会丢弃旧快照。
export function useUsageStats(
  range: UsageStatsRange,
  options: {
    dataSource?: "local" | "monitor";
    enabled?: boolean;
    preferredProviderId?: string;
    accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
    requirePreferredProvider?: boolean;
    allowEnvApiKey?: boolean;
  } = {},
) {
  const { usageStatsService } = useServices();
  const [state, setState] = useState<UsageStatsState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const dataSource = options.dataSource;
  const enabled = options.enabled ?? true;
  const preferredProviderId = options.preferredProviderId;
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const requirePreferredProvider = options.requirePreferredProvider === true;
  const allowEnvApiKey = options.allowEnvApiKey;
  // [事务] 五元组用竖线拼接：任何参与请求的参数都必须加入，否则切换后仍显示旧数据。
  // JSON 序列化 accountAccess 让账号切换触发 scope 变化，字段顺序由 useStableAccountAccess 保证稳定。
  // 布尔项转成 strict/relaxed 与 env/no-env 字符串，避免 false 与 undefined 拼出同一个键。
  // 分隔符用可见字符，便于在日志里对比两个 scope，不要换成不可打印字符。
  const requestScope = [
    dataSource ?? "",
    preferredProviderId ?? "",
    JSON.stringify(accountAccess ?? null),
    requirePreferredProvider ? "strict" : "relaxed",
    allowEnvApiKey === false ? "no-env" : "env",
  ].join("|");
  const lastRequestScopeRef = useRef(requestScope);

  // [并发] 每次刷新先自增代次，旧请求返回时代次不等即丢弃，防止后发先至覆盖新数据。
  // keepPreviousSnapshot 只在 scope 未变时为真：同 scope 重刷保留旧快照，避免刷新闪空。
  // loading 先置 true 再发请求，保证按钮与骨架屏在 await 之前就切换，避免点击无反馈。
  // 不要改成串行执行：并发代次是唯一正确的仲裁手段，串行会让最后一次点击排队等待前一次网络。
  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }

    // [并发] 代次放 ref 而不是 state：自增不能触发重渲染，也不能被渲染批处理合并。
    // 读取与写回必须紧邻，中间不要插入 await，否则两次并发刷新可能拿到同一个代次。
    // 改用 state 保存代次会让旧请求的早退判断读到渲染快照值，产生重复写入。
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    // [事务] 先读旧值判断、再写新值，这两步顺序颠倒后判断永远为真。
    // 首次挂载时 ref 初值等于当前 scope，因此首帧被判为同 scope，保留的 null 快照无副作用。
    // scope 变化时必须清空快照，否则切账号后仍显示上一家的额度。
    const keepPreviousSnapshot = lastRequestScopeRef.current === requestScope;
    lastRequestScopeRef.current = requestScope;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // [失败路径] 走函数式更新读 current，并发刷新时不能拿闭包里的 state，否则会覆盖别处刚写入的快照。
    // 这里显式清空 error，让重试一开始就消掉上一次的红色提示，而不是等失败再覆盖。
    // 清空条件必须与下面 catch 分支的 scope 判断保持一致，否则成功与失败两条路径的保留语义不同。
    setState((current) => ({
      // App Usage 与 Coding Plan 共用同一个 hook 实例。
      // 切 tab 后如果继续保留旧 snapshot，Coding Plan 请求期间或失败后会显示本地 App Usage 数据。
      snapshot: keepPreviousSnapshot ? current.snapshot : null,
      loading: true,
      error: null,
    }));

    try {
      // [契约] 参数逐个透传而不是拼装 options 对象，方便 service 侧对 undefined 施加默认值。
      // timeZone 每次刷新现取，用户改系统时区后下一次刷新即生效，不要提到模块级缓存。
      // accountAccess 已由 useStableAccountAccess 稳定引用，直接传入；重新构造对象会让依赖抖动。
      const snapshot = await usageStatsService.getSnapshot({
        range,
        dataSource,
        preferredProviderId,
        accountAccess,
        requirePreferredProvider,
        allowEnvApiKey,
        timeZone,
      });
      // [并发] 成功分支的代次校验必须早于写 state，晚一步就会让旧 scope 的数据短暂覆盖新 scope。
      // 早退只 return，不把 loading 置 false：新请求仍在进行，加载态应继续保持。
      // 错误分支有同样的校验，两处缺一都会出现旧请求的错误弹给新账号。
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setState({
        snapshot,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      const message = getErrorMessage(error);
      logger.warn("[useUsageStats] 读取 usage 统计失败", {
        dataSource,
        range,
        preferredProviderId,
        timeZone,
        error: message,
      });
      setState((current) => ({
        snapshot: lastRequestScopeRef.current === requestScope ? current.snapshot : null,
        loading: false,
        error: message,
      }));
    }
  // [契约] 依赖列表必须与 refresh 实际读取的值一一对应，少一项就会用闭包里过期的 scope 发请求。
  // requestScope 已包含数据源、provider、账号与各布尔开关，但仍保留原始项以防后续拆分时遗漏。
  // enabled 必须进依赖：关闭后再打开要靠 effect 重新触发，而不是依赖调用方手动调用刷新。
  }, [
    accountAccess,
    allowEnvApiKey,
    dataSource,
    enabled,
    preferredProviderId,
    range,
    requestScope,
    requirePreferredProvider,
    usageStatsService,
  ]);

  // [契约] enabled 为 false 时清空状态并直接返回，不再触发刷新，避免禁用态仍然发请求。
  // 清理旧快照是刻意的：provider 被移除后设置页不能继续显示上一家账号的用量。
  // 依赖只有 enabled 与 refresh：scope 变化通过 refresh 重建触发，无需额外的 effect。
  useEffect(() => {
    if (!enabled) {
      setState({
        // Coding Plan provider 被移除或禁用后，使用统计查询会被关闭。
        // 这里清空旧快照，避免设置页继续显示上一家账号的用量数据。
        snapshot: null,
        loading: false,
        error: null,
      });
      return;
    }

    void refresh();
  }, [enabled, refresh]);

  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}

// [契约] 只查本地 App 用量，不接收 provider 与账号参数，因此没有跨账号串号的保留策略。
// 首帧即发起请求，没有 enabled 开关，调用方要靠卸载组件来停止；本地查询代价可控。
// 切 range 时保留 current.snapshot 并置 loading，符合换时间范围时先留旧图再替换的预期。
// 与 useUsageStats 不同，这里失败也保留旧快照，只提示 error，避免趋势图整块消失。
export function useAppUsageStats(range: AppUsageRange) {
  const { usageStatsService } = useServices();
  const [state, setState] = useState<AppUsageStatsState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setState((current) => ({
      snapshot: current.snapshot,
      loading: true,
      error: null,
    }));
    try {
      const snapshot = await usageStatsService.getAppUsageSnapshot({
        range,
        timeZone,
      });
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setState({ snapshot, loading: false, error: null });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      const message = getErrorMessage(error);
      logger.warn("[useAppUsageStats] 读取本地使用统计失败", {
        range,
        timeZone,
        error: message,
      });
      setState((current) => ({
        snapshot: current.snapshot,
        loading: false,
        error: message,
      }));
    }
  }, [range, usageStatsService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}

// [契约] enabled 默认 true；preferredProviderId 与 accountAccess 缺一就不查，直接清空。
// 自定义日期先 trim 再空串归 null，纯空白日期不能参与 scope 拼接。
// range 进 requestScopeKey 但不进 requestIdentityKey：换时间范围复用同一账号的身份判断。
// 身份只由 provider 与 accountAccess 组成并决定是否保留旧快照，这个区分是本文件最容易被改错的地方。
export function useCodingPlanUsageStats(
  range: CodingPlanUsageRange,
  options: {
    enabled?: boolean;
    preferredProviderId?: string;
    accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
    customStartDate?: string | null;
    customEndDate?: string | null;
  },
) {
  const { usageStatsService } = useServices();
  // [事务] 用 NUL 字符分隔而不是竖线：range 与日期是外部字符串，NUL 不可能出现在其中，无法伪造同一 scope。
  // 五个分量分别是时间范围、provider、账号、开始日、结束日，少写任一项都会让两个不同请求共用一个缓存条目。
  // 日期统一 trim 归一，避免带空格的日期与不带空格的日期被当成两个 scope 而重复请求。
  // 不要把 enabled 拼进 key：开关变化不改变网络请求语义，拼进去只会白白丢缓存。
  const requestScopeKey = [
    range,
    options.preferredProviderId ?? "",
    JSON.stringify(options.accountAccess ?? null),
    options.customStartDate?.trim() ?? "",
    options.customEndDate?.trim() ?? "",
  ].join("\0");
  // [契约] 首帧同步读缓存，让重新挂载的实例直接带着上次快照渲染，避免骨架屏闪一下。
  // 只在 useState 初始化时读一次，后续缓存变化由 refresh 写入 state，不要在这里订阅。
  // 缓存为空时快照落到 null，与确实没有数据不可区分，所以错误必须由 refresh 单独维护。
  const cachedUsage = codingPlanUsageAccessCache.get(usageStatsService)?.get(requestScopeKey);
  const [state, setState] = useState<CodingPlanUsageStatsState>({
    snapshot: cachedUsage?.snapshot ?? null,
    loading: false,
    error: null,
  });
  // [契约] 该 ref 与 state.snapshot 同步写入，供回调与事件读取当前值，避免闭包读到旧 state。
  // 用缓存快照做初值，保证首帧 ref 与 state 一致，否则首个回调可能读到 null 而误判为空。
  // 失败或条件不满足时把它置 null，与 state 的清空动作成对出现，防止后续读到幽灵快照。
  const latestSnapshotRef = useRef<CodingPlanUsageSnapshot | null>(cachedUsage?.snapshot ?? null);
  const requestVersionRef = useRef(0);
  const enabled = options.enabled ?? true;
  const preferredProviderId = options.preferredProviderId;
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const customStartDate = options.customStartDate?.trim() || null;
  const customEndDate = options.customEndDate?.trim() || null;
  const requestIdentityKey = [
    preferredProviderId ?? "",
    JSON.stringify(accountAccess ?? null),
  ].join("\0");
  const lastRequestScopeKeyRef = useRef(requestIdentityKey);

  const refresh = useCallback(
    async (refreshOptions: { force?: boolean } = {}) => {
      // [失败路径] 三个条件缺一即清空并返回，不发请求：没有账号时查询必然被判未授权，只是噪音。
      // 清空 latestSnapshotRef 与 state 必须同时进行，只清 state 会让后续回调把旧快照写回来。
      // 这里 return 而不是抛错：未登录或未选 provider 是正常状态，不是异常。
      // 不要在这里主动触发刷新：依赖变化会重建 useCallback，再由下面的 effect 驱动。
      if (!enabled || !preferredProviderId || !accountAccess) {
        latestSnapshotRef.current = null;
        setState({ snapshot: null, loading: false, error: null });
        return;
      }
      let serviceCache = codingPlanUsageAccessCache.get(usageStatsService);
      if (!serviceCache) {
        serviceCache = new Map();
        codingPlanUsageAccessCache.set(usageStatsService, serviceCache);
      }
      const cached = serviceCache.get(requestScopeKey);
      let request = cached?.inFlight;
      if (
        !request &&
        !refreshOptions.force &&
        cached?.snapshot &&
        !shouldRefreshCodingPlanUsageOnAccess({
          lastUpdatedAt: cached?.requestedAt ?? null,
          now: Date.now(),
        })
      ) {
        latestSnapshotRef.current = cached?.snapshot ?? null;
        setState({
          snapshot: cached?.snapshot ?? null,
          loading: false,
          error: null,
        });
        return;
      }
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const keepPreviousSnapshot = lastRequestScopeKeyRef.current === requestIdentityKey;
      lastRequestScopeKeyRef.current = requestIdentityKey;
      if (!request || refreshOptions.force) {
        request = usageStatsService.getCodingPlanUsageSnapshot({
          range,
          customStartDate,
          customEndDate,
          preferredProviderId,
          accountAccess,
          timeZone,
        });
        serviceCache.set(requestScopeKey, {
          // requestedAt 只能表示成功快照的生成时间。用请求开始时间预写空快照会
          // 导致同 scope 的后挂载实例把 pending 当成 fresh，并错过首个请求的成功或失败结果。
          snapshot: cached?.snapshot ?? null,
          requestedAt: cached?.inFlight ? null : (cached?.requestedAt ?? null),
          inFlight: request,
        });
      }
      setState((current) => ({
        // 切换 Z.AI/BigModel 时不能保留上一家 Coding Plan 的 monitor 快照；
        // 但同一 provider 切换 today/7d/30d 时保留旧快照，避免 Quota Remaining 和趋势区域闪空。
        snapshot: keepPreviousSnapshot ? current.snapshot : null,
        loading: true,
        error: null,
      }));
      try {
        const snapshot = await request;
        if (requestVersionRef.current !== requestVersion) {
          return;
        }
        if (serviceCache.get(requestScopeKey)?.inFlight === request) {
          serviceCache.set(requestScopeKey, {
            snapshot,
            requestedAt: Date.now(),
          });
        }
        latestSnapshotRef.current = snapshot;
        setState({ snapshot, loading: false, error: null });
      } catch (error) {
        if (requestVersionRef.current !== requestVersion) {
          return;
        }
        const message = getErrorMessage(error);
        logger.warn("[useCodingPlanUsageStats] 读取 Coding Plan 使用统计失败", {
          range,
          preferredProviderId,
          timeZone,
          error: message,
        });
        // 失败请求不能保留本次 access 预写入的 cache entry。
        // 否则 TTL 内重新打开同一组织会跳过真实请求，展示旧来源快照或静默空掉错误。
        if (serviceCache.get(requestScopeKey)?.inFlight === request) {
          serviceCache.delete(requestScopeKey);
        }
        latestSnapshotRef.current = null;
        setState({ snapshot: null, loading: false, error: message });
      }
    },
    [
      accountAccess,
      customEndDate,
      customStartDate,
      enabled,
      preferredProviderId,
      range,
      requestIdentityKey,
      requestScopeKey,
      usageStatsService,
    ],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
