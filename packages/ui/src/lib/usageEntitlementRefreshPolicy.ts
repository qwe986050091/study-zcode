// INV-01 同一 freshnessKey 的共享快照与失败退避必须挂在同一个 usageStatsService 实例下；守住位置：entitlementSharedSnapshots 与 entitlementFailureBackoff 两张表的取值路径；改错故障：切换账号后仍读到上一个账号的额度，两处数字互相矛盾。
// INV-02 购买与鉴权切换必须让同一身份的所有在途请求失效，不能只依赖单个 hook 自增版本；守住位置：entitlementGenerations 的代数自增；改错故障：购买成功后旧请求回包覆盖新快照，额度显示倒退。
// INV-03 未标记 invalidate 的请求不得推进代数，否则同一 freshnessKey 的并发只读请求会互相判为过期；守住位置：beginSharedEntitlementRequest 的加法项；改错故障：后台刷新被自己打断，额度长期停在加载态。
// INV-04 isCurrent 只回答该 key 的代数是否仍等于签发值，不得持有快照也不得读时钟；守住位置：返回对象的 isCurrent 闭包；改错故障：过期回包始终被判为有效，旧额度写回并覆盖新额度。
// INV-05 访问去重窗口固定 60 秒，且只有请求时间落在窗口内才推迟，恰好 60 秒必须放行；守住位置：shouldDeferSharedEntitlementAccess 的比较运算符；改错故障：轮询间隔与窗口等长时每次都被判推迟，设置页永不刷新。
// INV-06 时间判断只能读入参 now，不得直接读系统时钟；守住位置：shouldDeferSharedEntitlementAccess 与 recordSharedEntitlementAccess 的 now 入参；改错故障：单测无法推进时间，窗口判断在跨天与跨时区场景下漂移。
// INV-07 访问记录必须在请求发起时写入，不得等回包再补写；守住位置：recordSharedEntitlementAccess 的调用时序；改错故障：慢请求期间用户反复切页，每次切换都打出一次真实查询。
// INV-08 请求键必须覆盖所有影响服务端返回的选项，且 undefined 与 false 不得折叠成同一个键；守住位置：buildEntitlementRequestKey 的字段拼装；改错故障：开启与关闭环境变量 Key 共用一份缓存，用户看到另一套额度的结果。
// INV-09 请求键的字段顺序必须固定，同一组选项在任何调用路径上都产出同一字符串；守住位置：构建对象的字面量字段次序；改错故障：两个入口用同一份选项却分到不同缓存项，额度被重复拉取。
// INV-10 差异键由缓存键与请求键双层嵌套构成，外层不得把请求键当普通字符串拼接；守住位置：buildEntitlementFreshnessKey 的嵌套结构；改错故障：缓存键自带分隔符时两个不同请求拼出同一 key，互相覆盖额度。
// INV-11 成功发布必须同时把失败计数归零并清除退避项，两件事不可拆开；守住位置：publishSharedEntitlementSnapshot 的写快照与删退避；改错故障：余额已恢复但冷却仍在，用户锁在退避期里看不到新额度。
// INV-12 退避下标必须随失败次数递增并夹在表长之内，不允许越界读；守住位置：recordSharedEntitlementFailure 的 min 夹取；改错故障：第五次失败取到 undefined，冷却截止时间变成 NaN，所有刷新判断永久失真。
// INV-13 冷却截止时间在失败路径上只能单调推后，重置为 0 只允许发生在成功发布时；守住位置：退避表项的两次写入点；改错故障：连续失败算出的截止时间比上一次更早，退避窗口形同虚设。
// INV-14 发布快照与上报失败都必须同步广播给当前 key 的全部订阅者；守住位置：publishSharedEntitlementSnapshot 与 recordSharedEntitlementFailure 的监听器循环；改错故障：设置页已刷新而推荐入口仍是旧额度，两处数字长期不一致。
// INV-15 失败广播必须携带错误标记，不能只推 null 让订阅者自行猜测；守住位置：recordSharedEntitlementFailure 的监听器第二参；改错故障：订阅方把失败当成功空态渲染，用户看到额度为 0 而不是网络异常。
// INV-16 共享快照只在无失败记录且未超过给定间隔时可用，两个条件都是硬门；守住位置：shouldUseSharedEntitlementSnapshot 的两处早返回；改错故障：失败后仍复用旧快照，用户以为查询成功而实际是过期数据。
// INV-17 可用性判断不得读系统时钟，也不得顺手刷新记录的更新时间；守住位置：shouldUseSharedEntitlementSnapshot 的纯读路径；改错故障：一次判断改写了 updatedAt，缓存被无限续期永不过期。
// INV-18 订阅注销必须自底向上清空集合，否则空 Map 与空 Set 会随 key 数量增长；守住位置：subscribeSharedEntitlementSnapshot 返回的清理函数；改错故障：频繁切换 provider 后残留大量空集合，内存随会话时长线性增长。
// INV-19 计划状态判定必须让有权益与无套餐先行短路，其余不可用原因统一归为 unavailable；守住位置：getUsageEntitlementScheduleState 的分支顺序；改错故障：无套餐账号被显示为可用，点击后进入空白额度页。
import { isStartPlanModelProviderId } from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import type {
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";

export interface UsageEntitlementRequestOptions {
  invalidateBalanceCache?: boolean;
  includeSubscription: boolean;
  preferredProviderId?: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  allowDisabledPreferredProvider: boolean;
  requirePreferredProvider: boolean;
  allowEnvApiKey?: boolean;
}

export type UsageEntitlementRefreshReason = "initial" | "access" | "manual" | "purchase" | "auth";
export type UsageEntitlementScheduleState = "unknown" | "active" | "none" | "unavailable";

export const USAGE_ENTITLEMENT_ACCESS_REFRESH_MS = 60_000;

// [权衡] 退避按 30 秒、60 秒、120 秒、300 秒四档递增，而不是线性或指数增长：
// 现状的失败几乎都是短时网络抖动与后台重启，前两档足以覆盖；拉到 5 分钟是为了
// 避免鉴权彻底失效时，每次切页都去打一次注定返回 401 的接口，把限流一起打满。
// 固定四档并靠下标夹取，而不按次数换算成公式，是为了让最坏情况可预期：表长即上限。
// [失败路径] 该数组只读使用，任何调用方都不得就地修改，否则退避时长会跨账号串味。
// 数值单位是毫秒，且与 USAGE_ENTITLEMENT_ACCESS_REFRESH_MS 刻意分属两个量级：
// 那是分钟级的访问去重，这是秒级的失败冷却，混用会让刚失败就重试或正常访问被判冷却。
const USAGE_ENTITLEMENT_ERROR_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;

interface SharedUsageEntitlementRecord {
  failureCount: number;
  nextAllowedAt: number;
  snapshot: UsageEntitlementSnapshot;
  updatedAt: number;
}

const entitlementSharedSnapshots = new WeakMap<
  IUsageStatsService,
  Map<string, SharedUsageEntitlementRecord>
>();
const entitlementSubscribers = new WeakMap<
  IUsageStatsService,
  Map<string, Set<(snapshot: UsageEntitlementSnapshot | null, error?: string) => void>>
>();
const entitlementFailureBackoff = new WeakMap<
  IUsageStatsService,
  Map<string, { failureCount: number; nextAllowedAt: number }>
>();
const entitlementAccessRequests = new WeakMap<IUsageStatsService, Map<string, number>>();

// 购买使同一身份的所有旧请求失效，不能仅依赖单个 hook 的 requestVersion。
// [并发] 每个 usageStatsService 各持一张代数表，键是 freshnessKey；两个服务实例之间
// 互不可见，桌面端与内嵌 WebView 才不会用同一个 key 互相作废对方的在途请求。
// 计数只在购买与鉴权切换这类显式失效时自增而普通刷新沿用当前代，同一 key 上
// 先后发出的两个只读请求可以同时有效，后到的结果不会让先到的判为作废。
// [资源] 以服务实例为 WeakMap 键：实例被回收后整张表随之释放，无需注册清理钩子；
// 若换成模块级普通 Map，长驻进程里每次新建服务都会留下永不释放的代数表。
// [失败路径] 表项缺失一律按 0 处理而不抛错：首帧请求发生在任何失效动作之前，
// 缺失是正常起点，把它当异常处理会把首屏额度直接打空。
const entitlementGenerations = new WeakMap<IUsageStatsService, Map<string, number>>();

// [契约] 本函数只维护哪一代请求还有资格落盘，调用方拿 requestKey 带进请求后
// 再用 isCurrent 决定是否写回；它不碰网络，也不读快照，失败语义全在外部。
// [并发] 读代数与写代数之间没有 await 而单线程下这段是原子的；一旦将来改成异步，
// 两次调用可能读到同一代并各自加一，两个 isCurrent 会同时为真，需要比较并交换。
// requestKey 用数组序列化而不是模板字符串拼接，是为了让 freshnessKey 里出现的分隔符
// 无法伪造出另一个键；[失败路径] 两段被拼成同一字符串时，旧回包会写到新请求的缓存位。
// invalidate 为假时代数不变，返回的 isCurrent 与更早的只读请求共享同一代，这是有意为之。
export function beginSharedEntitlementRequest(params: {
  usageStatsService: IUsageStatsService;
  freshnessKey: string;
  invalidate: boolean;
}): { requestKey: string; isCurrent: () => boolean } {
  let generations = entitlementGenerations.get(params.usageStatsService);
  if (!generations) {
    generations = new Map();
    entitlementGenerations.set(params.usageStatsService, generations);
  }
  const generation = (generations.get(params.freshnessKey) ?? 0) + (params.invalidate ? 1 : 0);
  generations.set(params.freshnessKey, generation);
  return {
    requestKey: JSON.stringify([params.freshnessKey, generation]),
    isCurrent: () => generations.get(params.freshnessKey) === generation,
  };
}

function getAccessRequestMap(usageStatsService: IUsageStatsService): Map<string, number> {
  let requests = entitlementAccessRequests.get(usageStatsService);
  if (!requests) {
    requests = new Map();
    entitlementAccessRequests.set(usageStatsService, requests);
  }
  return requests;
}

// 用途是给同一身份下多个 useUsageStats 消费者的访问类刷新去重，因为设置页、侧栏、推荐入口可能同时挂载，
// 没有这层闸门，一次切页会并发发出三份完全相同的额度查询。
// 严格小于让窗口恰好在 60 秒整放行；[权衡] 若写成小于等于，等间隔轮询每次都落在边界，
// 全部被判为推迟，轮询会永久空转，用户看到的是永不更新的额度。
// [失败路径] requestedAt 缺失时返回假而不是真：从未请求过就必须放行，
// 把缺失当推迟会让首屏永远等不到第一次查询。
// 只读注入的 now，不读系统时钟也不写状态，[并发] 所以它是可重入的纯查询。
export function shouldDeferSharedEntitlementAccess(params: {
  freshnessKey: string;
  now: number;
  usageStatsService: IUsageStatsService;
}): boolean {
  const requestedAt = getAccessRequestMap(params.usageStatsService).get(params.freshnessKey);
  return (
    requestedAt !== undefined && params.now - requestedAt < USAGE_ENTITLEMENT_ACCESS_REFRESH_MS
  );
}

export function recordSharedEntitlementAccess(params: {
  freshnessKey: string;
  now: number;
  usageStatsService: IUsageStatsService;
}): void {
  getAccessRequestMap(params.usageStatsService).set(params.freshnessKey, params.now);
}

// 这个字符串是缓存分区的唯一依据，任何影响服务端返回的选项都必须出现在这里；
// 少一个字段，两个语义不同的请求就共用一份快照，用户会看到不属于当前身份的数据。
// [权衡] invalidateBalanceCache 为假时整键省略而不是写成 false：两者语义等价，
// 但省略能让旧调用方升级后不必换缓存键，已缓存的额度不会因为新增字段整体失效。
// allowEnvApiKey 却保留 null 与 true 的区分：环境变量 Key 会改变服务端认定的套餐来源，
// 折叠成布尔会把它与显式关闭混为一谈，缓存直接串区。
// [失败路径] accountAccess 允许为空，因此用 null 占位；直接透传会让 undefined 从 JSON 里消失，
// 结果是“无账号信息”与“账号信息为空对象”拼出同一个 requestKey。
export function buildEntitlementRequestKey(options: UsageEntitlementRequestOptions): string {
  return JSON.stringify({
    ...(options.invalidateBalanceCache ? { invalidateBalanceCache: true } : {}),
    includeSubscription: options.includeSubscription,
    preferredProviderId: options.preferredProviderId ?? "",
    accountAccess: options.accountAccess ?? null,
    allowDisabledPreferredProvider: options.allowDisabledPreferredProvider,
    requirePreferredProvider: options.requirePreferredProvider,
    allowEnvApiKey: options.allowEnvApiKey ?? null,
  });
}

export function buildEntitlementFreshnessKey(params: {
  cacheKey: string;
  options: UsageEntitlementRequestOptions;
}): string {
  return JSON.stringify({
    cacheKey: params.cacheKey,
    request: JSON.parse(buildEntitlementRequestKey(params.options)) as Record<string, unknown>,
  });
}

function getSharedSnapshotMap(
  usageStatsService: IUsageStatsService,
): Map<string, SharedUsageEntitlementRecord> {
  let snapshots = entitlementSharedSnapshots.get(usageStatsService);
  if (!snapshots) {
    snapshots = new Map();
    entitlementSharedSnapshots.set(usageStatsService, snapshots);
  }
  return snapshots;
}

function getFailureBackoffMap(
  usageStatsService: IUsageStatsService,
): Map<string, { failureCount: number; nextAllowedAt: number }> {
  let failures = entitlementFailureBackoff.get(usageStatsService);
  if (!failures) {
    failures = new Map();
    entitlementFailureBackoff.set(usageStatsService, failures);
  }
  return failures;
}

export function readSharedEntitlementSnapshot(params: {
  usageStatsService: IUsageStatsService;
  freshnessKey: string;
}): UsageEntitlementSnapshot | null {
  return getSharedSnapshotMap(params.usageStatsService).get(params.freshnessKey)?.snapshot ?? null;
}

// 发布是唯一能把失败计数清零的入口，成功路径必须走这里，不允许绕过它直写快照表；
// [失败路径] 只写快照不清退避，会出现余额已刷新成功、下次刷新仍被冷却挡住的状态。
// nextAllowedAt 归零而不是删字段，是为了让快照记录只有一种形状，读取方不必同时
// 区分 nextAllowedAt 字段缺失与值为 0 两种表示。
// [并发] 广播放在写表之后同步执行：订阅者 listener 回调里读到的必然是新快照；
// 反过来先广播再写表，回调中读到的还是旧 snapshot，等于推了一份过期数据。
// 监听器集合可能在遍历期间被注销（回调里触发组件卸载），Set 的遍历对此是安全的，
// [权衡] 因此不额外复制 listeners 数组，避免每次发布都多分配一次。
export function publishSharedEntitlementSnapshot(params: {
  usageStatsService: IUsageStatsService;
  freshnessKey: string;
  snapshot: UsageEntitlementSnapshot;
}): void {
  getSharedSnapshotMap(params.usageStatsService).set(params.freshnessKey, {
    failureCount: 0,
    nextAllowedAt: 0,
    snapshot: params.snapshot,
    updatedAt: Date.now(),
  });
  getFailureBackoffMap(params.usageStatsService).delete(params.freshnessKey);
  const listeners = entitlementSubscribers.get(params.usageStatsService)?.get(params.freshnessKey);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener(params.snapshot);
  }
}

// 失败次数优先取快照记录上的值，其次取退避表，最后落到 0：成功发布后快照计数被
// 清零而退避表可能尚未删除，两处不一致时必须让快照为准，否则计数会凭空跳高。
// [失败路径] 快照不存在时仍要写退避表，否则从未成功过的账号会无限重试，
// 这条分支是首屏额度查询失败时唯一能踩到刹车的路径。
// 下标夹取保证第五次及以后的失败都落在最后一档，不会读到数组长度之外。
// [权衡] 冷却按 key 累计而不按账号累计：同一账号在不同 provider 下的失败原因不同，
// 混成一条计数会让一次 401 拖慢另一条本来健康的查询线。
// 广播先于快照写回，监听器拿到的是失败前最后一次成功的快照加错误标记，正好用来保留旧值并提示失败。
export function recordSharedEntitlementFailure(params: {
  usageStatsService: IUsageStatsService;
  freshnessKey: string;
}): void {
  const snapshots = getSharedSnapshotMap(params.usageStatsService);
  const failures = getFailureBackoffMap(params.usageStatsService);
  const current = snapshots.get(params.freshnessKey);
  const previousFailureCount =
    current?.failureCount ?? failures.get(params.freshnessKey)?.failureCount ?? 0;
  const failureCount = previousFailureCount + 1;
  const backoffMs =
    USAGE_ENTITLEMENT_ERROR_BACKOFF_MS[
      Math.min(failureCount - 1, USAGE_ENTITLEMENT_ERROR_BACKOFF_MS.length - 1)
    ] ?? USAGE_ENTITLEMENT_ERROR_BACKOFF_MS[USAGE_ENTITLEMENT_ERROR_BACKOFF_MS.length - 1]!;
  const nextAllowedAt = Date.now() + backoffMs;
  failures.set(params.freshnessKey, {
    failureCount,
    nextAllowedAt,
  });
  // 查询失败也是共享事实；否则设置页失败后，推荐入口仍认为旧余额查询成功。
  for (const listener of entitlementSubscribers
    .get(params.usageStatsService)
    ?.get(params.freshnessKey) ?? []) {
    listener(current?.snapshot ?? null, "usage_entitlement_refresh_failed");
  }
  if (!current) {
    return;
  }
  snapshots.set(params.freshnessKey, {
    ...current,
    failureCount,
    nextAllowedAt,
  });
}

export function subscribeSharedEntitlementSnapshot(params: {
  usageStatsService: IUsageStatsService;
  freshnessKey: string;
  listener: (snapshot: UsageEntitlementSnapshot | null, error?: string) => void;
}): () => void {
  let serviceSubscribers = entitlementSubscribers.get(params.usageStatsService);
  if (!serviceSubscribers) {
    serviceSubscribers = new Map();
    entitlementSubscribers.set(params.usageStatsService, serviceSubscribers);
  }
  let listeners = serviceSubscribers.get(params.freshnessKey);
  if (!listeners) {
    listeners = new Set();
    serviceSubscribers.set(params.freshnessKey, listeners);
  }
  listeners.add(params.listener);
  return () => {
    listeners?.delete(params.listener);
    if (listeners?.size === 0) {
      serviceSubscribers?.delete(params.freshnessKey);
    }
    if (serviceSubscribers?.size === 0) {
      entitlementSubscribers.delete(params.usageStatsService);
    }
  };
}

// 这是缓存复用的唯一判据：无记录、有失败、超过间隔三种情况都必须放行去真实查询。
// [权衡] 失败计数大于 0 时直接判不可用而不是继续看时间窗口：失败后旧的更新时间仍在
// 窗口内，只比时间会让用户在两分钟内反复看到同一份过期额度。
// 间隔比较用小于等于 intervalMs，恰好等于间隔时仍复用缓存，因为上游轮询间隔就按这个值配置，
// 边界多打一次请求没有收益，异常路径已经由失败闸门挡住。
// 返回的是记录里存的对象引用，不做深拷贝：快照在发布时整体替换，读取方只读，
// 拷贝反而让同一份 snapshot 在每个调用点各有一份，失去共享与去重的意义。
export function shouldUseSharedEntitlementSnapshot(params: {
  freshnessKey: string;
  intervalMs: number;
  now: number;
  usageStatsService: IUsageStatsService;
}): UsageEntitlementSnapshot | null {
  const record = getSharedSnapshotMap(params.usageStatsService).get(params.freshnessKey);
  if (!record) {
    return null;
  }
  if (record.failureCount > 0) return null;
  if (params.now - record.updatedAt <= params.intervalMs) {
    return record.snapshot;
  }
  return null;
}

export function hasSharedEntitlementFailure(params: {
  freshnessKey: string;
  usageStatsService: IUsageStatsService;
}): boolean {
  return getFailureBackoffMap(params.usageStatsService).has(params.freshnessKey);
}

export function shouldDeferSharedEntitlementRefresh(params: {
  freshnessKey: string;
  now: number;
  usageStatsService: IUsageStatsService;
}): boolean {
  const failure = getFailureBackoffMap(params.usageStatsService).get(params.freshnessKey);
  return Boolean(failure && failure.nextAllowedAt > params.now);
}

export function getUsageEntitlementScheduleState(
  snapshot: UsageEntitlementSnapshot | null,
): UsageEntitlementScheduleState {
  if (!snapshot) {
    return "unknown";
  }
  const hasEntitlement = Boolean(
    snapshot.subscription?.details.length ||
    (isStartPlanModelProviderId(snapshot.provider?.id ?? "") && snapshot.remaining),
  );
  if (hasEntitlement && snapshot.unavailableReason !== "no_plan") {
    return "active";
  }
  if (snapshot.unavailableReason === "no_plan") {
    return "none";
  }
  if (snapshot.unavailableReason) {
    return "unavailable";
  }
  return "unknown";
}
