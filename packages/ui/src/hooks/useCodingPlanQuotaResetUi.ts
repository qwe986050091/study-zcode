/* eslint-disable max-lines -- 额度重置 hook 集中处理 scope 共享请求、轮询、幂等核销与服务端历史对账。 */
// ==========================================================================
// useCodingPlanQuotaResetUi —— 额度重置的 UI 投影、跨入口对账与轮询订阅
//
// 做：把 /status 快照对账成五小时与周额度两份 UI entry，并写入 store 供各入口订阅。
// 做：发起手动 /use，按固定延迟序列对账，处理幂等键与失败回写。
// 不做：不保存权威额度状态；权威在服务端与 store，本文件只做投影与对账。
// 不做：不自建定时器轮询；轮询与可见性统一交给 codingPlanQuotaResetCoordinator。
// 依赖：IUsageStatsService 的 status/use/history-read，以及 @zcode/shared 的 scope 类型。
// 依赖：store 的 codingPlanQuotaReset* 分片与 authSessionSeq；鉴权世代是所有缓存的隔离维度。
// 边界：五小时字段平铺在顶层、周额度走 week 子控制器，是为兼容既有调用方而定。
// 边界：跨窗口只共享 store 广播，手动轨迹与 in-flight 合并均为进程内状态。
// 并发：共享表全部以 service 为 WeakMap 键，避免组件卸载后反向持有服务实例。
// 权衡：宁可多一次 /opportunity 判断也不缓存资格结论，资格只能由服务端裁决。
//
// INV 不变量（格式：断言 / 守住它的位置 / 改错故障）
// INV-01 断言：/status 缓存键必须含 authSessionSeq —— 守住它的位置：requestCodingPlanResetStatus 的 scopeKey —— 改错故障：换账号后沿用上个会话的额度快照。
// INV-02 断言：STATUS_FRESHNESS_MS 内必须复用缓存 —— 守住它的位置：const STATUS_FRESHNESS_MS —— 改错故障：四个入口各自打 /status，直接放大成 429。
// INV-03 断言：in-flight 必须按 service 分表并在结束时删空表 —— 守住它的位置：statusInflightByService —— 改错故障：WeakMap 长期持有已销毁 service 的空表。
// INV-04 断言：history/read 去重键只按 usedAt —— 守住它的位置：markHistoryReadOnce —— 改错故障：按 scope 拆分后重复 POST，服务端游标反而清不掉。
// INV-05 断言：history/read 是全局共享游标、请求不带 target scope —— 守住它的位置：markHistoryReadOnce 的契约注释 —— 改错故障：误以为要按 scope 上报，其他窗口持续重复播放。
// INV-06 断言：标记已读必须早于 entitlement 刷新 —— 守住它的位置：applyStatusForType 的调用顺序 —— 改错故障：延迟清理游标，其他窗口重复播放自动完成提示。
// INV-07 断言：手动轨迹按 service + scope + 类型 隔离 —— 守住它的位置：buildManualAttemptKey —— 改错故障：五小时与周额度互相清除手动标记。
// INV-08 断言：共享轨迹只归属第一次 used_at 变化 —— 守住它的位置：resolveSharedManualResetStartedAt —— 改错故障：后续自动重置被误标为手动，动画类型错配。
// INV-09 断言：reset 放行必须用 hasUsableCodingPlanQuotaResetOpportunity —— 守住它的位置：reset 首段判定 —— 改错故障：completed 携带的余下机会点不动，弹框播放成功但实际没发 /use。
// INV-10 断言：跨入口防双核销必须先 refreshStatus(true) —— 守住它的位置：reset 的 priorAttempt 分支 —— 改错故障：第二次点击携带新幂等键重复核销。
// INV-11 断言：放行判定与 startedAt 必须共用同一时刻 —— 守住它的位置：reset 里的 Date.now() —— 改错故障：机会在两次取时之间到期，仍发起 /use。
// INV-12 断言：只有 useAccepted 之前失败才清共享轨迹 —— 守住它的位置：catch 里的 if (!useAccepted) —— 改错故障：已受理却清轨迹，跨入口再次核销。
// INV-13 断言：手动对账延迟序列固定 4 档 —— 守住它的位置：USE_STATUS_RETRY_DELAYS_MS —— 改错故障：与 /opportunity 抢发卡锁触发 429。
// INV-14 断言：手动核销进行中不得调 /opportunity —— 守住它的位置：refreshStatus 的 anyTypeResetInFlight —— 改错故障：与 /use 撞发卡锁，稳定触发 429。
// INV-15 断言：本轮刚完成不得调 /opportunity —— 守住它的位置：justCompleted 判定 —— 改错故障：被 next_try_at 拒绝后仍被记为失败。
// INV-16 断言：/status 之后必须再调 /opportunity —— 守住它的位置：refreshStatus 的发放段 —— 改错故障：只看到已发放机会，新资格永不评估。
// INV-17 断言：轮询身份不得依赖 onEntitlementRefresh —— 守住它的位置：onEntitlementRefreshRef —— 改错故障：父组件每次 render 重启轮询，形成 /opportunity 风暴。
// INV-18 断言：四个 UI 入口共享一个 Coordinator —— 守住它的位置：subscribeCodingPlanQuotaResetPolling —— 改错故障：各自 60s 计时器放大请求量。
// INV-19 断言：ticker 只在仍有可核销机会时启动 —— 守住它的位置：now 的 ticker effect —— 改错故障：常驻 1s 定时器空转重渲染。
// INV-20 断言：所有 setEntry 必须携带 authSessionSeq —— 守住它的位置：每个 setEntry 调用点 —— 改错故障：迟到的旧会话响应覆盖新会话状态。
// ==========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IUsageStatsService } from "@zcode/services";
import type {
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  requestCodingPlanResetOpportunityWhenDue,
  subscribeCodingPlanQuotaResetPolling,
} from "@/lib/codingPlanQuotaResetCoordinator.js";
import {
  CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
  CODING_PLAN_QUOTA_RESET_TYPES,
  applyCodingPlanQuotaResetStatus,
  completeCodingPlanQuotaResetEntitlementRefresh,
  failCodingPlanQuotaResetManualUse,
  hasUsableCodingPlanQuotaResetOpportunity,
  resolveCodingPlanQuotaResetStatusVisible,
  startCodingPlanQuotaResetManualUse,
  type CodingPlanQuotaResetUiEntries,
  type CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";
import type {
  CodingPlanQuotaResetAutomaticObservation,
  CodingPlanQuotaResetAutoPlayReservation,
  CodingPlanQuotaResetAutoPlayReservationAttempt,
  CodingPlanQuotaResetAutoPlayedSlot,
} from "@/store/codingPlanQuotaResetState.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

// [契约] 1.5s 只是同一 scope 的短新鲜度窗口，用来吸收四个 UI 入口的同步连发；
// 它不是轮询周期：所有轮询由 Coordinator 统一调度，本常量不参与定时器；
// 调大到秒级以上会让手动核销后的对账失去实时性（force 绕过它，但只有显式调用）；
// 调小到 0 会让每个入口各打一次 /status，直接放大成 429；
// 缓存键里必须带 authSessionSeq，否则本窗口会跨账号复用。
const STATUS_FRESHNESS_MS = 1_500;
// [并发] 手动 /use 后的 4 次对账是固定序列 0/250/750/1500ms，不能改成无限重试；
// 这几次连续 /status 期间不能插入 /opportunity，否则会撞发卡锁触发 429；
// 首档为 0 是有意的：先立即读一次，避免把已完成误判为处理中；
// 总时长必须小于 UI 的 processing 容忍窗口，否则用户看到长时间假处理中；
// 调整档位要同步核对后端发卡锁窗口，只改这里会稳定复现 429。
const USE_STATUS_RETRY_DELAYS_MS = [0, 250, 750, 1_500] as const;
const EMPTY_ENTRIES: Record<string, CodingPlanQuotaResetUiEntries> = {};
const EMPTY_PLAYED: Record<string, CodingPlanQuotaResetAutoPlayedSlot> = {};
const EMPTY_AUTOMATIC_OBSERVATIONS: Record<
  string,
  {
    fiveHour: CodingPlanQuotaResetAutomaticObservation | null;
    week: CodingPlanQuotaResetAutomaticObservation | null;
  }
> = {};
// [失败路径] 缺省 store 注入 no-op，hook 才能在没有 StoreProvider 的环境里安全渲染；
// no-op 必须静默：抛错会把退出登录瞬间的卸载渲染变成崩溃；
// NOOP_RESERVE_AUTO_PLAY 返回 blocked 而非 retry：无 store 时重试永远无意义；
// 四个 no-op 的签名必须与 store action 完全一致，否则类型断言会掩盖参数漂移；
// 不要把 no-op 换成日志上报：这条路径每次 render 都可能走到，会污染日志。
const NOOP_SET_ENTRY = (
  _sourceKey: string,
  _resetType: CodingPlanResetType,
  _entry: CodingPlanQuotaResetUiEntry | null,
) => {};
const NOOP_RESERVE_AUTO_PLAY = async (
  _sourceKey: string,
  _resetType: CodingPlanResetType,
  _completedAt: number,
): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> => ({
  status: "blocked",
});
const NOOP_COMMIT_AUTO_PLAY = (_reservation: CodingPlanQuotaResetAutoPlayReservation): boolean =>
  false;
const NOOP_RELEASE_AUTO_PLAY = async (
  _reservation: CodingPlanQuotaResetAutoPlayReservation,
): Promise<void> => {};

// [契约] 类型到槽位的映射只在这里存在：WEEK 归 week，其余一律 fiveHour；
// 后端目前只有两种重置类型，新增类型必须同时改 CODING_PLAN_QUOTA_RESET_TYPES；
// 写成三元而不是查表是刻意的：查表新增类型时会静默落到 undefined 槽位；
// 不要把 fiveHour 的兜底改成抛错：旧快照可能带未知类型，会在渲染期崩；
// 返回 keyof 保证后续 withEntry 的键收窄。
function entryKeyForType(resetType: CodingPlanResetType): keyof CodingPlanQuotaResetUiEntries {
  return resetType === "WEEK" ? "week" : "fiveHour";
}

// [契约] used_at 是判断一次重置是否真正生效的唯一服务端证据，必须按类型分读；
// 历史字段缺失时返回 null 而不是 0：0 会被误判成一次真实的 used_at 变化；
// 五小时与周历史独立记录，交叉读取会让另一类型的完成被误播；
// null 与 undefined 统一收敛成 null，供上层用 === null 比较；
// `latestUsedAtForType` 不格式化时间，所有比较都基于原始数字。
function latestUsedAtForType(
  snapshot: CodingPlanResetStatusSnapshot,
  resetType: CodingPlanResetType,
): number | null {
  return (
    (resetType === "WEEK"
      ? snapshot.latestWeekResetHistory?.usedAt
      : snapshot.latestFiveHourResetHistory?.usedAt) ?? null
  );
}

// 只替换目标类型的槽位，另一类型保持不变；显式分支避免 union 计算键的类型收窄问题。
// [契约] 只替换目标类型的槽位，另一类型必须原样保留；
// 显式三元分支是刻意的：用计算键会让 CodingPlanResetType 到 keyof 的收窄失败；
// 返回新对象，不得就地改 entriesRef.current：旧引用仍被其他入口的 render 持有；
// 两类型共用一个 entries 对象，合并写会让未变化的类型也触发订阅；
// 调用方必须把返回值同时写回 ref 与 store，漏一处就出现双份真相。
function withEntry(
  entries: CodingPlanQuotaResetUiEntries,
  resetType: CodingPlanResetType,
  entry: CodingPlanQuotaResetUiEntry | null,
): CodingPlanQuotaResetUiEntries {
  return resetType === "WEEK" ? { ...entries, week: entry } : { ...entries, fiveHour: entry };
}

// 不能用“组件挂载前 store 已有完成态”判断是否重新登录；设置页可能在同一鉴权会话
// 先写入状态，Composer 后挂载仍应展示。只有同一 used_at 的首次观察记录属于上一鉴权会话时
// 才静音。返回值由 useMemo 缓存，避免静音态每次 render 创建新对象并触发 effect/setNow 循环。
// [契约] 只在首次观察记录属于上一鉴权会话时静音，不能按组件挂载时机判断；
// 判定必须同时要求 startedAt 为 null 且 completedAt 与观察记录相等；
// 返回值由 useMemo 缓存，避免每次 render 造新对象触发 effect 与 setNow 循环；
// 置空的是 observedAt 而非整条 entry：完成态仍要驱动 100% 乐观覆盖；
// 不要复用本函数做跨窗口去重，那是 played 记录的职责，两者语义不同。
function suppressAutomaticAnimationFromPreviousAuthEpoch(
  entry: CodingPlanQuotaResetUiEntry | null,
  observation: CodingPlanQuotaResetAutomaticObservation | null,
  authSessionSeq: number,
): CodingPlanQuotaResetUiEntry | null {
  if (
    observation !== null &&
    observation.authSessionSeq !== authSessionSeq &&
    entry?.status === "completed" &&
    entry.startedAt === null &&
    entry.observedAt !== null &&
    entry.completedAt === observation.completedAt
  ) {
    return { ...entry, observedAt: null };
  }
  return entry;
}

interface CachedResetStatus {
  fetchedAt: number;
  snapshot: CodingPlanResetStatusSnapshot;
}

interface SharedManualResetAttempt {
  startedAt: number;
  baselineUsedAt: number | null;
  completedAt: number | null;
}

// [并发] 所有共享表都以 service 为 WeakMap 键，避免组件卸载后反向持有服务；
// 按 service 分表意味着不同实例之间不共享 in-flight，这是刻意的隔离；
// 表内 key 必须含 authSessionSeq 与 scope，否则换账号会复用旧请求；
// in-flight 结束后必须删空表项，否则 WeakMap 里会留下空 Map 长期驻留；
// 不要换成普通 Map：service 释放后无法回收，会泄漏整棵服务图。
const statusInflightByService = new WeakMap<
  IUsageStatsService,
  Map<string, Promise<CodingPlanResetStatusSnapshot>>
>();
const statusCacheByService = new WeakMap<IUsageStatsService, Map<string, CachedResetStatus>>();
const historyReadInflightByService = new WeakMap<IUsageStatsService, Map<string, Promise<void>>>();
const historyReadCompletedByService = new WeakMap<IUsageStatsService, Set<string>>();
const manualResetAttemptByService = new WeakMap<
  IUsageStatsService,
  Map<string, SharedManualResetAttempt>
>();

// [契约] scope 键用 JSON.stringify([providerId, accountAccess])，顺序与结构都不可变；
// 字段顺序变化会让同一 scope 算出不同 key，缓存与 in-flight 合并同时失效；
// accountAccess 必须先经 useStableAccountAccess 稳定，否则每个字面量都换 key；
// 不要把 sourceKey 拼进来：同一 scope 的多个入口必须共享同一份状态；
// key 仅供进程内比较，不要持久化或跨窗口传递。
function buildScopeKey(scope: CodingPlanResetScopeRequest): string {
  return JSON.stringify([scope.preferredProviderId, scope.accountAccess]);
}

// 手动核销轨迹按 scope + 重置类型隔离：五小时与周额度的手动重置互不干扰。
// [契约] 手动轨迹按 scope 与重置类型隔离，五小时与周额度互不干扰；
// 分隔符固定为双冒号，避免与 accountAccess JSON 内的字符混淆；
// 清轨迹必须复用同一个构造函数，手拼字符串会导致轨迹永远清不掉；
// scope 变化即视为新轨迹，不要跨 scope 复用；
// 该 key 不落盘：跨窗口并发只能由服务端按机会核销兜底。
function buildManualAttemptKey(
  scope: CodingPlanResetScopeRequest,
  resetType: CodingPlanResetType,
): string {
  return `${buildScopeKey(scope)}::${resetType}`;
}

// [并发] 懒建子 Map 是刻意的：只有真正发起过请求的 service 才会分配表；
// 已有表直接复用，保证同一 service 的 in-flight 合并生效；
// 写入用 owner.set 一次完成，避免查与建之间的并发窗口产生两张表；
// 调用方必须在表空时 delete，否则这张子 Map 会跟着 service 一直存活；
// 不要在这里加锁：同步段本身原子，额外同步只会引入复杂度。
function getServiceMap<T>(
  owner: WeakMap<IUsageStatsService, Map<string, T>>,
  service: IUsageStatsService,
): Map<string, T> {
  const existing = owner.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  owner.set(service, created);
  return created;
}

// [并发] 顺序是「缓存 → in-flight → 发请求」，写反会绕过合并产生重复请求；
// force 只跳过新鲜度缓存，不跳过 in-flight 合并：进行中的请求必须复用；
// 缓存写入在 then 里、清理在 finally 里：失败请求不得写缓存；
// finally 里顺带删空表项，防止 WeakMap 留下空 Map；
// 缓存的是 snapshot 引用，调用方不得就地修改，否则污染后续对账。
async function requestCodingPlanResetStatus(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  force: boolean;
  authSessionSeq: number;
}): Promise<CodingPlanResetStatusSnapshot> {
  const scopeKey = `${params.authSessionSeq}::${buildScopeKey(params.scope)}`;
  const cache = getServiceMap(statusCacheByService, params.service);
  const cached = cache.get(scopeKey);
  if (!params.force && cached && Date.now() - cached.fetchedAt < STATUS_FRESHNESS_MS) {
    return cached.snapshot;
  }

  const inflight = getServiceMap(statusInflightByService, params.service);
  const existing = inflight.get(scopeKey);
  if (existing) {
    return existing;
  }

  const request = params.service
    .getCodingPlanResetStatus(params.scope)
    .then((snapshot) => {
      cache.set(scopeKey, { fetchedAt: Date.now(), snapshot });
      return snapshot;
    })
    .finally(() => {
      inflight.delete(scopeKey);
      if (inflight.size === 0) {
        statusInflightByService.delete(params.service);
      }
    });
  inflight.set(scopeKey, request);
  return request;
}

// [事务] 起点时刻由发起入口传入，不能在这里重新取 Date.now()；
// baselineUsedAt 必须取发起前的缓存快照，用于区分新一次核销与历史重置；
// 缓存缺失时 baseline 记 null，仍建立轨迹——后续靠 used_at 变化判定；
// 轨迹按 service 分表，跨窗口不共享，服务端核销仍是最终并发兜底；
// 写入 completedAt 为 null 表示尚未拿到服务端证据。
function startSharedManualResetAttempt(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  startedAt: number;
  resetType: CodingPlanResetType;
  authSessionSeq: number;
}): void {
  const attemptKey = buildManualAttemptKey(params.scope, params.resetType);
  const cached = statusCacheByService
    .get(params.service)
    ?.get(`${params.authSessionSeq}::${buildScopeKey(params.scope)}`)?.snapshot;
  const baselineUsedAt = cached ? latestUsedAtForType(cached, params.resetType) : null;
  getServiceMap(manualResetAttemptByService, params.service).set(attemptKey, {
    startedAt: params.startedAt,
    baselineUsedAt,
    completedAt: null,
  });
}

// [事务] 清理必须与建立共用 buildManualAttemptKey，键不一致就永远清不掉；
// 清空表项后删子 Map，避免 WeakMap 长期挂在 service 上；
// 此函数不抛错：轨迹不存在是正常路径（可能已被另一入口清掉）；
// 只在 /use 未被受理或出现新的 used_at 时调用，别在成功路径上顺手清；
// 清理与 failed 回写必须同序执行，否则会出现轨迹没了但仍 processing。
function clearSharedManualResetAttempt(
  service: IUsageStatsService,
  scope: CodingPlanResetScopeRequest,
  resetType: CodingPlanResetType,
): void {
  const attempts = manualResetAttemptByService.get(service);
  if (!attempts) {
    return;
  }
  attempts.delete(buildManualAttemptKey(scope, resetType));
  if (attempts.size === 0) {
    manualResetAttemptByService.delete(service);
  }
}

// [事务] 共享轨迹只归属第一次 used_at 变化，后续不同历史属于新的自动或运营重置；
// latestUsedAt 等于 baselineUsedAt 时返回 null：服务端还没反映本次核销；
// 第一次看到变化就写 completedAt 再返回 startedAt，保证后续轮询稳定命中；
// completedAt 与当前 used_at 不一致时必须清轨迹，避免把新重置误标为手动；
// 返回 null 而不是抛错，让上层继续走自动完成提示。
function resolveSharedManualResetStartedAt(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  snapshot: CodingPlanResetStatusSnapshot;
  resetType: CodingPlanResetType;
}): number | null {
  const attempts = manualResetAttemptByService.get(params.service);
  const attemptKey = buildManualAttemptKey(params.scope, params.resetType);
  const attempt = attempts?.get(attemptKey);
  if (!attempt) {
    return null;
  }

  const latestUsedAt = latestUsedAtForType(params.snapshot, params.resetType);
  if (latestUsedAt === null || latestUsedAt === attempt.baselineUsedAt) {
    return null;
  }
  if (attempt.completedAt === null) {
    attempt.completedAt = latestUsedAt;
    return attempt.startedAt;
  }
  if (attempt.completedAt === latestUsedAt) {
    return attempt.startedAt;
  }

  // 共享轨迹只归属第一次变化的 used_at。后续不同历史属于新的自动/运营重置，
  // 必须清除手动标记，保留原有自动 Tooltip 和触发器烟花。
  clearSharedManualResetAttempt(params.service, params.scope, params.resetType);
  return null;
}

// [契约] history/read 是用户全 scope 共享游标，请求不带 target scope；
// 因此去重 key 只按 usedAt——按 scope 拆分反而造成重复 POST；
// 失败不写 completed，下一次轮询自然重试，这依赖 finally 只清 in-flight；
// completed 集合按 service 弱引用，不能跨 service 共享；
// 该调用必须早于 entitlement 刷新，延后会让其他窗口重复播放完成提示。
function markHistoryReadOnce(params: {
  service: IUsageStatsService;
  scope: CodingPlanResetScopeRequest;
  usedAt: number;
}): Promise<void> {
  // 契约（bigmodelUsageQuotaProvider）：
  // history/read 是用户全 scope 共享游标，请求不带 target scope；任一入口上报后
  // 服务端同时清除所有 scope 的 unread。因此 key 只按 usedAt——同 service 相同
  // usedAt 只发一次是符合契约的去重，按 scope 拆分反而造成重复 POST。
  const historyKey = String(params.usedAt);
  let completed = historyReadCompletedByService.get(params.service);
  if (!completed) {
    completed = new Set<string>();
    historyReadCompletedByService.set(params.service, completed);
  }
  if (completed.has(historyKey)) {
    return Promise.resolve();
  }

  const inflight = getServiceMap(historyReadInflightByService, params.service);
  const existing = inflight.get(historyKey);
  if (existing) {
    return existing;
  }

  const request = params.service
    .markCodingPlanResetHistoryRead(params.scope)
    .then(() => {
      completed?.add(historyKey);
    })
    .finally(() => {
      inflight.delete(historyKey);
      if (inflight.size === 0) {
        historyReadInflightByService.delete(params.service);
      }
    });
  inflight.set(historyKey, request);
  return request;
}

// [契约] 幂等键只用于服务端去重，不承载鉴权语义，不要塞用户或会话信息；
// 优先 randomUUID，缺失时用 getRandomValues 手工拼 v4 格式；
// 极旧 WebView 无 Web Crypto 时退化为时间戳加随机数，仍保证同一次重试稳定；
// 键一旦写入 entry 就必须复用，重试不得重新生成，否则重复核销；
// 不要把 Math.random 当主路径：碰撞会让两次不同核销被服务端合并。
function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  if (bytes.some((value) => value !== 0)) {
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // 极旧 WebView 没有 Web Crypto 时仍需保证同一次失败重试稳定；该 key 只用于幂等，不承载鉴权。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// [失败路径] 0ms 直接 resolve，避免在首档重试与测试里浪费一个宏任务；
// 正延迟走 window.setTimeout，保证浏览器与 Electron renderer 都有定义；
// 这里不需要可取消：最长 1.5s，组件卸载后一次空转可接受；
// 不要改成忙等轮询：会阻塞整个对账循环；
// `wait` 只按 `delayMs` 等待，退避策略由调用方给定。
function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CodingPlanQuotaResetTypeController {
  entry: CodingPlanQuotaResetUiEntry | null;
  /** 仍有可核销的手动重置机会（available，或 completed 携带的同类型余下机会）。 */
  opportunityVisible: boolean;
  /** 手动 use + status 对账中。 */
  processing: boolean;
  /** 已拿到服务端 used_at。 */
  done: boolean;
  statusVisible: boolean;
  /** 发起手动核销；失败 reject 供 Action 恢复交互。 */
  reset: () => Promise<void>;
}

// 五小时字段平铺在顶层保持既有调用方兼容；周额度通过 week 子控制器暴露。
export interface CodingPlanQuotaResetUiController extends CodingPlanQuotaResetTypeController {
  enabled: boolean;
  week: CodingPlanQuotaResetTypeController;
  /** Composer 申请临时播放 reservation；此阶段不写 played。 */
  reserveAutomaticCompletion: (
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  /** 组件仍有效且即将展示时提交 played。 */
  commitAutomaticCompletion: (reservation: CodingPlanQuotaResetAutoPlayReservation) => boolean;
  /** 组件在 commit 前失效时释放 reservation。 */
  releaseAutomaticCompletion: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
}

// [契约] enabled 必须同时满足开关、sourceKey、service、scope，缺一即静默禁用；
// sourceKey 是状态分片键，scope 是请求作用域，两者不可合并；
// hook 只做投影与对账，不持有权威状态：权威在 store 与服务端；
// 返回对象每 render 新建，调用方不要把它放进深层依赖做记忆；
// week 与五小时共用同一 controller 形状，week 只是另一种 resetType。
export function useCodingPlanQuotaResetUi({
  sourceKey,
  preferredProviderId,
  accountAccess,
  enabled: requestedEnabled = true,
  onEntitlementRefresh,
}: {
  sourceKey: string | null | undefined;
  preferredProviderId?: string | null;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  enabled?: boolean;
  onEntitlementRefresh?: () => void | Promise<void>;
}): CodingPlanQuotaResetUiController {
  const { intl } = useZCodeIntl();
  const services = useOptionalBaseWorkspaceServices();
  const usageStatsService = services?.usageStatsService;
  const stableAccountAccess = useStableAccountAccess(accountAccess);
  const scope = useMemo<CodingPlanResetScopeRequest | null>(() => {
    const normalizedProviderId = preferredProviderId?.trim();
    if (!normalizedProviderId || !stableAccountAccess) {
      return null;
    }
    return {
      preferredProviderId: normalizedProviderId,
      accountAccess: stableAccountAccess,
    };
  }, [preferredProviderId, stableAccountAccess]);
  // [契约] 只有四项齐全才发请求：缺 scope 会 400，缺 sourceKey 无法落状态；
  // Boolean 的短路顺序固定，usageStatsService 缺失时不再计算 scope；
  // 空白 sourceKey 必须按 trim 后为空处理，不要只判 truthy；
  // enabled 变化会重启 Coordinator 订阅，因此它只能依赖原始输入；
  // 不要在 enabled 里加入 entry 状态，否则每轮对账都会重订阅。
  const enabled = Boolean(requestedEnabled && sourceKey?.trim() && usageStatsService && scope);
  const entriesBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetUiBySource,
    EMPTY_ENTRIES,
  );
  const setEntry = useZCodeStoreWithDefault(
    (state) => state.setCodingPlanQuotaResetUiEntry,
    NOOP_SET_ENTRY,
  );
  const reserveAutoPlay = useZCodeStoreWithDefault(
    (state) => state.reserveCodingPlanQuotaResetAutoPlay,
    NOOP_RESERVE_AUTO_PLAY,
  );
  const commitAutoPlay = useZCodeStoreWithDefault(
    (state) => state.commitCodingPlanQuotaResetAutoPlay,
    NOOP_COMMIT_AUTO_PLAY,
  );
  const releaseAutoPlay = useZCodeStoreWithDefault(
    (state) => state.releaseCodingPlanQuotaResetAutoPlay,
    NOOP_RELEASE_AUTO_PLAY,
  );
  const observationsBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetAutomaticObservationsBySource,
    EMPTY_AUTOMATIC_OBSERVATIONS,
  );
  const playedBySource = useZCodeStoreWithDefault(
    (state) => state.codingPlanQuotaResetAutoPlayedBySource,
    EMPTY_PLAYED,
  );
  const authSessionSeq = useZCodeStoreWithDefault((state) => state.authSessionSeq, 0);
  // [并发] ref 与 store 值必须同帧同步，异步回调才能读到最新鉴权世代；
  // 所有 await 之后都要用 ref 的当前值与闭包里的 authSessionSeq 比较；
  // 不要用 useRef 的初始值做判断：登录切换后闭包值已经过期；
  // 比较不一致时直接返回，不得回写 store——那是上一代会话；
  // ref 赋值放在 render 期而非 effect，避免一帧延迟窗口。
  const authSessionSeqRef = useRef(authSessionSeq);
  authSessionSeqRef.current = authSessionSeq;
  const storedEntries = sourceKey ? entriesBySource[sourceKey] : undefined;
  const storedObservations = sourceKey ? observationsBySource[sourceKey] : undefined;
  const fiveHourObservation = storedObservations?.fiveHour ?? null;
  const weekObservation = storedObservations?.week ?? null;
  // [契约] entry 必须先过 suppressAutomaticAnimationFromPreviousAuthEpoch 再暴露；
  // enabled 为 false 时强制 null，避免禁用状态仍渲染完成态；
  // 依赖里用 storedEntries?.fiveHour 而不是整个对象，减少无关重算；
  // 不要在 useMemo 里写 store：派生值必须保持纯粹；
  // weekEntry 用同构写法，两处逻辑分叉会导致一类不静音。
  const fiveHourEntry = useMemo(
    () =>
      suppressAutomaticAnimationFromPreviousAuthEpoch(
        enabled ? (storedEntries?.fiveHour ?? null) : null,
        fiveHourObservation,
        authSessionSeq,
      ),
    [authSessionSeq, enabled, fiveHourObservation, storedEntries?.fiveHour],
  );
  const weekEntry = useMemo(
    () =>
      suppressAutomaticAnimationFromPreviousAuthEpoch(
        enabled ? (storedEntries?.week ?? null) : null,
        weekObservation,
        authSessionSeq,
      ),
    [authSessionSeq, enabled, storedEntries?.week, weekObservation],
  );
  // [并发] 观察记录走 ref：对账函数只读最新值，不因观察更新重建回调身份；
  // 每次 render 必须整体覆盖两个槽位，增量赋值会让类型之间串值；
  // ref 里不得存 entry：entry 有瞬时乐观态，观察是持久事实；
  // 该 ref 只服务静音判定，不参与任何请求参数；
  // 读取时必须带 resetType 索引，取错类型会静音掉另一类的动画。
  const automaticObservationsRef = useRef({
    FIVE_HOUR: fiveHourObservation,
    WEEK: weekObservation,
  });
  automaticObservationsRef.current = {
    FIVE_HOUR: fiveHourObservation,
    WEEK: weekObservation,
  };
  // 跨窗口已播记录走 ref：applyStatusForType 只读最新值，不因 played 合并重建回调身份。
  const playedBySourceRef = useRef(playedBySource);
  playedBySourceRef.current = playedBySource;
  // [事务] entriesRef 是对账循环的即时真相，store 只是它的可订阅投影；
  // 每次 entry 变化都必须同时写 ref 与 setEntry，漏一处就出现双份真相；
  // ref 初值来自两个 useMemo，后续只允许由对账与 reset 写；
  // 不要在 render 期写 ref（初值除外），否则并发渲染会读到未提交值；
  // 对账返回值一律取 entriesRef.current，不要取 store 快照。
  const entriesRef = useRef<CodingPlanQuotaResetUiEntries>({
    fiveHour: fiveHourEntry,
    week: weekEntry,
  });
  const initialRefreshCompletedAt = (entry: CodingPlanQuotaResetUiEntry | null): number | null =>
    entry?.status === "completed" && !entry.quotaOverridePending ? entry.completedAt : null;
  // 五小时与周额度各自记录 entitlement 刷新去重键；已完成但仍处于乐观覆盖时，
  // 新挂载入口必须继续尝试刷新真实 entitlement。
  // [事务] 去重键是 sourceKey 与 completedAt，同一 used_at 只强刷一次 entitlement；
  // completedAt 为 null 时也要记录 sourceKey，避免切换入口后重复尝试；
  // 刷新失败不得提前写键，否则同一 used_at 后续轮询不再校正真实额度；
  // 五小时与周额度各占一个槽位，不能共用一个 completedAt；
  // 用 ref 而非 state：写它不应触发重渲染，否则会与轮询 effect 互相唤醒。
  const lastEntitlementRefreshRef = useRef<
    Record<CodingPlanResetType, { sourceKey: string | null; completedAt: number | null }>
  >({
    FIVE_HOUR: {
      sourceKey: sourceKey ?? null,
      completedAt: initialRefreshCompletedAt(fiveHourEntry),
    },
    WEEK: {
      sourceKey: sourceKey ?? null,
      completedAt: initialRefreshCompletedAt(weekEntry),
    },
  });
  const [now, setNow] = useState(() => Date.now());
  // onEntitlementRefresh 常被调用方以内联箭头传入（每次 render 都是新身份）。
  // 若把它留在 useCallback 依赖里，会连锁重建 refreshStatus 并让轮询 effect 随父组件
  // 每次 render 重启；设置页切换个人/团队套餐时的密集重渲染会对同一 scope 连发多次
  // /opportunity（status 有 1.5s 新鲜度缓存，opportunity 只有 in-flight 合并）。
  // 存入 ref 后轮询身份只随 enabled/scope/sourceKey/service 变化，执行时仍读取最新回调。
  // [并发] 回调常以内联箭头传入，直接进依赖会让 refreshStatus 每次 render 重建；
  // 重建会连锁重启轮询 effect，设置页密集重渲染时对同一 scope 连发 /opportunity；
  // 因此身份只随 enabled/scope/sourceKey/service 变化，执行时读取 ref 最新值；
  // ref 更新放在 effect 里，保证提交完成后才被异步回调读到；
  // 不要把 ref 读取提到 callback 外层，那会捕获 render 时的旧函数。
  const onEntitlementRefreshRef = useRef(onEntitlementRefresh);

  useEffect(() => {
    onEntitlementRefreshRef.current = onEntitlementRefresh;
  }, [onEntitlementRefresh]);

  useEffect(() => {
    entriesRef.current = { fiveHour: fiveHourEntry, week: weekEntry };
  }, [fiveHourEntry, weekEntry]);

  // [事务] 每次对账先解析共享手动轨迹，再套 applyCodingPlanQuotaResetStatus；
  // 顺序不能反：先算状态会丢掉手动 startedAt，完成提示会退化成自动动画；
  // 写 store 前必须先写 entriesRef，保证同一拍内的下一次读取看到新值；
  // 鉴权世代不一致时直接返回 null，不得回写任何状态；
  // entitlement 强刷失败只记日志，不把 entry 标成已刷新。
  const applyStatusForType = useCallback(
    async (
      snapshot: CodingPlanResetStatusSnapshot,
      resetType: CodingPlanResetType,
    ): Promise<CodingPlanQuotaResetUiEntry | null> => {
      if (
        !sourceKey ||
        !usageStatsService ||
        !scope ||
        authSessionSeqRef.current !== authSessionSeq
      ) {
        return null;
      }
      const key = entryKeyForType(resetType);
      const previous = entriesRef.current[key];
      const manualStartedAt = resolveSharedManualResetStartedAt({
        service: usageStatsService,
        scope,
        snapshot,
        resetType,
      });
      let next = applyCodingPlanQuotaResetStatus(
        previous,
        snapshot,
        Date.now(),
        manualStartedAt,
        resetType,
      );
      // 补水的旧完成态被粘滞规则保持为 completed 后，createCompletedEntry 会把 observedAt
      // 续期回 now；仅当首次观察记录属于上一鉴权 epoch 时再次置空。同会话其他入口后挂载不静音。
      next = suppressAutomaticAnimationFromPreviousAuthEpoch(
        next,
        automaticObservationsRef.current[resetType],
        authSessionSeq,
      );
      // 该 used_at 的自动完成提示已在其他窗口播放过（本窗口先收到跨窗口已播广播）。
      // 只抑制本窗口"新进入"的完成；粘滞保持的同一完成不抑制，否则本窗口自己播放时写入的
      // played 记录会在重复对账时把自己的 observedAt 清掉，误杀正常短提示。
      // 被抑制时保留完成态驱动 100% 乐观覆盖与 entitlement 刷新，只是不播 Tooltip/撒花。
      const playedUsedAt = playedBySourceRef.current[sourceKey]?.[key] ?? null;
      const isNewCompletionInWindow =
        previous?.status !== "completed" || previous.completedAt !== next?.completedAt;
      if (
        playedUsedAt !== null &&
        isNewCompletionInWindow &&
        next?.status === "completed" &&
        next.startedAt === null &&
        next.observedAt !== null &&
        next.completedAt === playedUsedAt
      ) {
        next = { ...next, observedAt: null };
      }
      entriesRef.current = withEntry(entriesRef.current, resetType, next);
      setEntry(sourceKey, resetType, next, authSessionSeq);

      const completedAt = next?.status === "completed" ? next.completedAt : null;
      const isNewCompletion = completedAt !== null && completedAt !== previous?.completedAt;
      // has_unread_history 是两类共享的单一游标；任一类型完成后标记已读即可清空，
      // used_at 按类型唯一，重复标记无副作用。
      // 必须先于 entitlement 刷新标记已读。等待刷新完成再上报会延迟清理服务端游标，
      // 其他窗口在此期间轮询可能重复播放自动完成提示。
      if (snapshot.hasUnreadHistory && completedAt !== null) {
        void markHistoryReadOnce({
          service: usageStatsService,
          scope,
          usedAt: completedAt,
        }).catch((error) => {
          logger.warn("[coding-plan-reset] history read failed", {
            sourceKey,
            resetType,
            error: toErrorMessage(error),
          });
        });
      }

      const refreshState = lastEntitlementRefreshRef.current[resetType];
      const entitlementAlreadyRefreshed =
        refreshState.sourceKey === sourceKey && refreshState.completedAt === completedAt;
      const refreshEntitlement = onEntitlementRefreshRef.current;
      if (completedAt !== null && !entitlementAlreadyRefreshed && refreshEntitlement) {
        try {
          await refreshEntitlement();
          // 刷新失败时不能提前记为已完成，否则同一 used_at 后续轮询不会再校正真实额度。
          if (authSessionSeqRef.current !== authSessionSeq) {
            return entriesRef.current[key];
          }
          lastEntitlementRefreshRef.current[resetType] = {
            sourceKey,
            completedAt,
          };
          next = completeCodingPlanQuotaResetEntitlementRefresh(next, completedAt);
          entriesRef.current = withEntry(entriesRef.current, resetType, next);
          setEntry(sourceKey, resetType, next, authSessionSeq);
        } catch (error) {
          logger.warn("[coding-plan-reset] entitlement refresh failed", {
            sourceKey,
            resetType,
            error: toErrorMessage(error),
          });
        }
      }

      if (isNewCompletion) {
        logger.info("[coding-plan-reset] completed", {
          sourceKey,
          resetType,
          completedAt,
        });
      }
      return next;
    },
    [authSessionSeq, scope, setEntry, sourceKey, usageStatsService],
  );

  const applyStatus = useCallback(
    async (snapshot: CodingPlanResetStatusSnapshot): Promise<CodingPlanQuotaResetUiEntries> => {
      // 一次 /status 快照同时对账五小时与周额度，避免重复轮询。
      for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
        await applyStatusForType(snapshot, resetType);
      }
      return entriesRef.current;
    },
    [applyStatusForType],
  );

  const refreshStatus = useCallback(
    async (force = false): Promise<CodingPlanQuotaResetUiEntries> => {
      if (!enabled || !usageStatsService || !scope) {
        return entriesRef.current;
      }
      const previous = entriesRef.current;
      const snapshot = await requestCodingPlanResetStatus({
        service: usageStatsService,
        scope,
        force,
        authSessionSeq,
      });
      const next = await applyStatus(snapshot);
      // /opportunity 是 scope 级发放接口,一次同时评估五小时与周两类资格。后端对「同一类型
      // 已持有未消费机会」有发放上限,重复调用不会叠加,因此"已有可用机会"不再阻塞本次调用——
      // 否则一类挂着机会会饿死另一类的发放(周机会可挂数天,期间五小时永远发不出来)。
      // 仍需跳过的两种情形与发放上限无关:
      // - 手动核销进行中:/use 对账循环里 250ms~1.5s 连发 4 次,插入 /opportunity 会撞发卡锁触发 429;
      // - 本轮刚完成:完成周期内已在做 history/read 与 entitlement 强刷,此刻发放必被 next_try_at 拒。
      const anyTypeResetInFlight = CODING_PLAN_QUOTA_RESET_TYPES.some((resetType) => {
        const key = entryKeyForType(resetType);
        const entry = next[key];
        const previousEntry = previous[key];
        const justCompleted =
          entry?.status === "completed" &&
          entry.completedAt !== null &&
          entry.completedAt !== previousEntry?.completedAt;
        return (
          entry?.status === "processing" || previousEntry?.status === "processing" || justCompleted
        );
      });
      if (anyTypeResetInFlight) {
        return next;
      }

      try {
        // /status 只查询已发放机会；必须再调 /opportunity，否则后端不会执行资格判断。
        // 资格仍完全由服务端决定,客户端在非核销/非刚完成时都触发判断,并按 service + scope
        // 合并并发请求。/opportunity 是 scope 级请求,一次即覆盖五小时与周两类机会。
        const result = await requestCodingPlanResetOpportunityWhenDue({
          service: usageStatsService,
          authSessionSeq,
          scope,
        });
        if (result === null) {
          return next;
        }
        if (!result.granted) {
          return next;
        }
        const confirmedSnapshot = await requestCodingPlanResetStatus({
          service: usageStatsService,
          scope,
          force: true,
          authSessionSeq,
        });
        return applyStatus(confirmedSnapshot);
      } catch (error) {
        logger.warn("[coding-plan-reset] opportunity request failed", {
          sourceKey,
          error: toErrorMessage(error),
        });
        return next;
      }
    },
    [applyStatus, authSessionSeq, enabled, scope, sourceKey, usageStatsService],
  );

  // 四个 UI 入口各自维护 60 秒计时器时，只能合并同一瞬间的 in-flight，
  // 错开的挂载与定时 tick 仍会放大 /status 和 /opportunity。改为 auth session + service + scope
  // 唯一 Coordinator；入口只订阅，共享一个可见性监听和一个轮询 owner。
  useEffect(() => {
    if (!enabled || !usageStatsService || !scope) {
      return;
    }
    return subscribeCodingPlanQuotaResetPolling({
      service: usageStatsService,
      authSessionSeq,
      scope,
      refresh: () => refreshStatus(false),
    });
  }, [authSessionSeq, enabled, refreshStatus, scope, usageStatsService]);

  // 可核销倒计时：任一类型仍有可核销机会（含 completed 携带的余下机会）时启动 1 秒 ticker；
  // 入口变化时刷新 now 保证倒计时/窗口基于最新时间。
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const nowMs = Date.now();
    setNow(nowMs);
    const anyUsable =
      hasUsableCodingPlanQuotaResetOpportunity(fiveHourEntry, nowMs) ||
      hasUsableCodingPlanQuotaResetOpportunity(weekEntry, nowMs);
    if (!anyUsable) {
      return;
    }
    const ticker = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(ticker);
  }, [enabled, fiveHourEntry, weekEntry]);

  // completed 短提示窗口：取两类中最近的未过期到期时刻定时刷新，逐个到期后自动停止。
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const completed = [fiveHourEntry, weekEntry].filter(
      (candidate): candidate is CodingPlanQuotaResetUiEntry =>
        candidate?.status === "completed" && candidate.observedAt !== null,
    );
    if (completed.length === 0) {
      return;
    }
    const nowMs = Date.now();
    const nextBoundary = completed
      .map((entry) => (entry.observedAt ?? 0) + CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS)
      .filter((boundary) => boundary > nowMs)
      .sort((left, right) => left - right)[0];
    if (nextBoundary === undefined) {
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), nextBoundary - nowMs);
    return () => window.clearTimeout(timer);
  }, [enabled, fiveHourEntry, weekEntry, now]);

  // [并发] 放行判定与 startedAt 必须共用同一时刻，避免机会在两次取时之间到期；
  // 顺序固定：可用性 → 跨入口轨迹对账 → 幂等键 → processing → 共享轨迹；
  // 必须先写 processing 再发 /use，失败时才回写 failed，不能反过来；
  // useAccepted 之前失败要清共享轨迹，之后失败保留轨迹等轮询确认；
  // 对账循环按 key 取值，取错键会永远等不到 completed。
  const reset = useCallback(
    async (resetType: CodingPlanResetType) => {
      if (!enabled || !sourceKey || !usageStatsService || !scope) {
        return;
      }
      const key = entryKeyForType(resetType);
      // Bugfix：放行条件曾是 status === "available"。completed 携带同类型余下机会时，
      // 弹框里再次点击会在这里被静默忽略（弹框仍播放成功反馈，实际没有 /use）。
      // 统一按「是否仍可核销」判定，与弹框行、徽标、标题旁「重置」同一口径。
      if (!hasUsableCodingPlanQuotaResetOpportunity(entriesRef.current[key], Date.now())) {
        return;
      }
      // 跨入口防双核销：同 scope + 类型已有手动核销轨迹（本窗口其他入口发起，或本入口刚核销
      // 完一张）时，本入口可能基于过期轮询仍显示可核销。先强制对账：对方 /use 仍在进行、或
      // 对账后本入口已无可核销机会（额度已被核销），都不得再次 /use——第二次点击会携带新
      // 幂等键重复核销。对账后仍可核销说明轨迹属于更早的核销，余下或新发放的机会放行为新的
      // 一次核销。多窗口 / remote 入口不共享该轨迹，跨窗口并发由服务端按机会核销兜底。
      const priorAttempt = manualResetAttemptByService
        .get(usageStatsService)
        ?.get(buildManualAttemptKey(scope, resetType));
      if (priorAttempt) {
        const reconciled = await refreshStatus(true);
        if (
          priorAttempt.completedAt === null ||
          !hasUsableCodingPlanQuotaResetOpportunity(reconciled[key], Date.now())
        ) {
          return;
        }
      }
      const current = entriesRef.current[key];
      // 放行判定与 processing 起点共用同一时刻，避免机会恰好在两次取时之间到期。
      const startedAt = Date.now();
      if (!current || !hasUsableCodingPlanQuotaResetOpportunity(current, startedAt)) {
        return;
      }
      const idempotencyKey = current.idempotencyKey ?? createIdempotencyKey();
      const processing = startCodingPlanQuotaResetManualUse(current, idempotencyKey, startedAt);
      if (!processing) {
        return;
      }
      // 手动重置的完成历史会被 Composer、设置页和 Usage 页分别轮询到。
      // 轨迹必须按 service + scope + 类型 共享，不能只依赖发起入口自己的 processing 状态。
      startSharedManualResetAttempt({
        service: usageStatsService,
        scope,
        startedAt,
        resetType,
        authSessionSeq,
      });
      entriesRef.current = withEntry(entriesRef.current, resetType, processing);
      setEntry(sourceKey, resetType, processing, authSessionSeq);

      let useAccepted = false;
      try {
        await usageStatsService.useCodingPlanReset({
          ...scope,
          idempotencyKey,
          resetType,
        });
        useAccepted = true;

        for (const delayMs of USE_STATUS_RETRY_DELAYS_MS) {
          await wait(delayMs);
          const confirmed = await refreshStatus(true);
          if (confirmed[key]?.status === "completed") {
            return;
          }
        }
        throw new Error("coding_plan_reset_status_not_confirmed");
      } catch (error) {
        if (!useAccepted) {
          clearSharedManualResetAttempt(usageStatsService, scope, resetType);
        }
        const message = toErrorMessage(error);
        const failed = failCodingPlanQuotaResetManualUse(entriesRef.current[key], message);
        entriesRef.current = withEntry(entriesRef.current, resetType, failed);
        setEntry(sourceKey, resetType, failed, authSessionSeq);
        logger.warn("[coding-plan-reset] manual reset failed", {
          sourceKey,
          resetType,
          error: message,
        });
        toast(intl.formatMessage({ id: "codingPlan.quotaReset.failed" }), {
          variant: "warning",
        });
        throw error;
      }
    },
    [authSessionSeq, enabled, intl, refreshStatus, scope, setEntry, sourceKey, usageStatsService],
  );

  const resetFiveHour = useCallback(() => reset("FIVE_HOUR"), [reset]);
  const resetWeek = useCallback(() => reset("WEEK"), [reset]);
  const reserveAutomaticCompletion = useCallback(
    async (
      resetType: CodingPlanResetType,
      completedAt: number,
    ): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> => {
      if (!enabled || !sourceKey) {
        return { status: "blocked" };
      }
      try {
        return await reserveAutoPlay(sourceKey, resetType, completedAt);
      } catch (error) {
        logger.warn("[coding-plan-reset] autoplay reservation failed", {
          sourceKey,
          resetType,
          completedAt,
          error: toErrorMessage(error),
        });
        return { status: "retry", retryAfterMs: 500 };
      }
    },
    [enabled, reserveAutoPlay, sourceKey],
  );

  const commitAutomaticCompletion = useCallback(
    (reservation: CodingPlanQuotaResetAutoPlayReservation): boolean => commitAutoPlay(reservation),
    [commitAutoPlay],
  );

  const releaseAutomaticCompletion = useCallback(
    async (reservation: CodingPlanQuotaResetAutoPlayReservation): Promise<void> => {
      try {
        await releaseAutoPlay(reservation);
      } catch (error) {
        logger.warn("[coding-plan-reset] autoplay reservation release failed", {
          sourceKey: reservation.sourceKey,
          resetType: reservation.resetType,
          completedAt: reservation.completedAt,
          error: toErrorMessage(error),
        });
      }
    },
    [releaseAutoPlay],
  );

  const buildTypeController = (
    entry: CodingPlanQuotaResetUiEntry | null,
    resetFn: () => Promise<void>,
  ): CodingPlanQuotaResetTypeController => ({
    entry,
    // Bugfix：曾只认 status === "available"，completed 携带的同类型余下机会不可见，
    // 徽标少计、标题显示「已重置」。改用与 reset() 放行同一判定。
    opportunityVisible: hasUsableCodingPlanQuotaResetOpportunity(entry, now),
    processing: entry?.status === "processing",
    done: entry?.status === "completed",
    statusVisible: enabled && resolveCodingPlanQuotaResetStatusVisible(entry, now),
    reset: resetFn,
  });

  return {
    enabled,
    ...buildTypeController(fiveHourEntry, resetFiveHour),
    week: buildTypeController(weekEntry, resetWeek),
    reserveAutomaticCompletion,
    commitAutomaticCompletion,
    releaseAutomaticCompletion,
  };
}
