// INV-01 一个 coordinatorKey 全进程只对应一个协调器实例；守住位置：subscribeCodingPlanQuotaResetPolling 的取用或新建分支；改错故障：同 scope 的两个入口各持一套计时器与可见性监听，状态请求成倍放大。
// INV-02 subscribers 的 size 是订阅真值，只有 set 成功后才可能启动、只有 delete 成功后才可能停止；守住位置：subscribe 与退订闭包；改错故障：重复退订让仍有订阅者时轮询被停，或退订后计时器永不停。
// INV-03 退订函数幂等，第二次调用不得再递减计数、不得再次触发 stop；守住位置：闭包内对 delete 返回值的判断；改错故障：多个清理路径各调一次，把别的入口的订阅算作消失。
// INV-04 首个订阅者负责启动、最后一个退订者负责停止，中间增删不得重启轮询；守住位置：subscribe 的 size 等于 1 分支与闭包 size 等于 0 分支；改错故障：HoverCard 频繁开关时计时器反复重建，请求节奏抖动且翻倍。
// INV-05 visibilitychange 监听注册与注销一一配对，listening 是唯一事实来源；守住位置：start 与 stop；改错故障：重复注册后一次注销摘不干净，页面隐藏仍持续请求。
// INV-06 同一时刻至多存在一个轮询计时器，起表前必须先清表；守住位置：startVisiblePolling；改错故障：可见性来回切换后计时器叠加，轮询间隔被压缩。
// INV-07 run 单飞，running 非空时复用同一 Promise 而非再发一轮广播；守住位置：run 首行的 running 判断；改错故障：慢刷新期间每个 tick 都新起广播，回调与请求线性膨胀。
// INV-08 running 只在自身 Promise 落地的 finally 中、且仍指向自己时清空；守住位置：run 的 finally 比较；改错故障：迟到的旧轮询清掉新一轮的占用标记，单飞失效。
// INV-09 广播前对订阅回调做快照，等待期间不读实时集合；守住位置：run 中的 refreshCallbacks 拷贝；改错故障：刷新中退订或新增导致某项整轮漏通知或被重复投影。
// INV-10 无订阅者或页面隐藏时 run 立即给出已完成 Promise 且不占用 running；守住位置：run 的提前返回分支；改错故障：隐藏态占住 running，重新可见后的首轮刷新被吞，入口空白一轮。
// INV-11 单个刷新回调失败不得中断同批其它回调，也不得变成未处理拒绝；守住位置：Promise.allSettled 与结果遍历中的 warn；改错故障：一个 sourceKey 抛错后其余入口永久停在旧快照。
// INV-12 页面隐藏立即停表但保留协调器与调度状态；守住位置：handleVisibilityChange 的隐藏分支；改错故障：后台标签页继续每 5 分钟请求，用户无感知地消耗额度机会。
// INV-13 零订阅者时 stop 只停表并摘监听，不得从 WeakMap 删除协调器；守住位置：stop 与两个模块级 WeakMap 的取用；改错故障：重开 HoverCard 丢失 opportunity 冷却，立刻再请求并可能触发限流。
// INV-14 协调器键必须含会话序号，同一 service 上不同登录会话完全隔离；守住位置：buildCoordinatorKey；改错故障：切换账号后沿用上个会话的冷却与幂等 key，重置请求记到错误账号。
// INV-15 每个 service 的键表存放在 WeakMap，service 回收后条目随之释放；守住位置：coordinatorsByService 与 opportunitySchedulesByService 的声明；改错故障：换成普通 Map 后 service 与回调被长期持有，登出也无法回收。
// INV-16 scope 指纹固定按 [preferredProviderId, accountAccess] 顺序序列化；守住位置：buildScopeKey；改错故障：键序或字段变化让同一 scope 生成两个键，去重与冷却同时失效。
// INV-17 同一键上的 opportunity 请求共享同一个 inflight Promise；守住位置：requestCodingPlanResetOpportunityWhenDue 的 inflight 分支；改错故障：多个入口各发一次带不同幂等 key 的请求，后端重复判定。
// INV-18 inflight 只在 finally 中、且仍指向自身时清空；守住位置：finally 内的比较；改错故障：迟到的失败回调清掉后来者的占位，后续调用绕过去重。
// INV-19 未到 nextCheckAt 时直接返回 null，且不写任何调度字段；守住位置：冷却判定分支；改错故障：判定结果被自身写回覆盖，退避永不生效。
// INV-20 同一轮重试复用 retryIdempotencyKey，成功或判定为稳定错误后必须清空；守住位置：幂等 key 取值与 then 及 catch 中的赋值；改错故障：网络抖动重试换用新 key，后端把一次重置当成两次申请。
import type { IUsageStatsService } from "@zcode/services";
import type { CodingPlanResetOpportunityResult, CodingPlanResetScopeRequest } from "@zcode/shared";
import { logger } from "@/logger.js";

const STATUS_POLL_INTERVAL_MS = 5 * 60_000;
const OPPORTUNITY_MIN_RETRY_MS = 5 * 60_000;
const OPPORTUNITY_DEFAULT_COOLDOWN_MS = 10 * 60_000;
const OPPORTUNITY_TRANSIENT_ERROR_RETRY_MS = 5 * 60_000;
const OPPORTUNITY_STABLE_ERROR_COOLDOWN_MS = 10 * 60_000;

type RefreshCallback = () => unknown | Promise<unknown>;

interface OpportunitySchedule {
  nextCheckAt: number;
  retryIdempotencyKey: string | null;
  inflight: Promise<CodingPlanResetOpportunityResult> | null;
}

interface CoordinatorParams {
  service: IUsageStatsService;
  authSessionSeq: number;
  scope: CodingPlanResetScopeRequest;
}

interface PollingSubscriptionParams extends CoordinatorParams {
  refresh: RefreshCallback;
}

const coordinatorsByService = new WeakMap<
  IUsageStatsService,
  Map<string, CodingPlanQuotaResetPollingCoordinator>
>();
const opportunitySchedulesByService = new WeakMap<
  IUsageStatsService,
  Map<string, OpportunitySchedule>
>();

function buildScopeKey(scope: CodingPlanResetScopeRequest): string {
  return JSON.stringify([scope.preferredProviderId, scope.accountAccess]);
}

function buildCoordinatorKey(authSessionSeq: number, scope: CodingPlanResetScopeRequest): string {
  return `${authSessionSeq}::${buildScopeKey(scope)}`;
}

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

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpportunityThrottleError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return (
    message.includes("coding_plan_reset_opportunity_throttled") ||
    message.includes("coding_plan_reset_api_error:429")
  );
}

function isOpportunityTransientError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  if (message.includes("coding_plan_reset_api_error:2007")) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return [
    "failed to fetch",
    "fetch failed",
    "network error",
    "network request failed",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "enotfound",
    "etimedout",
    "eai_again",
  ].some((fragment) => message.includes(fragment));
}

function resolveOpportunityNextCheckAt(
  result: CodingPlanResetOpportunityResult,
  now: number,
): number {
  if (result.granted) {
    return now + OPPORTUNITY_DEFAULT_COOLDOWN_MS;
  }
  if (Number.isFinite(result.nextTryAt) && (result.nextTryAt ?? 0) > 0) {
    return Math.max(result.nextTryAt ?? 0, now + OPPORTUNITY_MIN_RETRY_MS);
  }
  return now + OPPORTUNITY_DEFAULT_COOLDOWN_MS;
}

class CodingPlanQuotaResetPollingCoordinator {
  private readonly subscribers = new Map<number, RefreshCallback>();
  private nextSubscriberId = 1;
  private interval: number | null = null;
  private running: Promise<void> | null = null;
  private listening = false;

  constructor(private readonly key: string) {
    logger.debug("[coding-plan-reset] coordinator created", {
      coordinatorKey: key,
    });
  }

  subscribe(refresh: RefreshCallback): () => void {
    // [并发] 订阅 id 单调递增且永不复用：退订后留下的空洞不会被后来者填补。
    // 若复用 id，重挂载的 HoverCard 会拿到旧回调的键，set 覆盖时静默替换掉另一个入口的刷新函数。
    // 不要在退订时压缩或重排 id，订阅集合的插入顺序不代表任何语义。
    // 新增订阅一律先 set 再走下面的启动分支，不可提前触发刷新，否则首个订阅者会收到两次投影。
    // [资源] 退订闭包必须捕获 subscriberId 而非 refresh 引用：前者只是整数，后者会让组件闭包在协调器存活期内一直被持有。
    // 协调器由模块级 WeakMap 持有，生命周期长于组件，这里不能出现对组件实例的反向引用。
    // 每次订阅都产生一个新闭包，调用方必须保存并调用它，否则订阅只能等协调器停止时被动清理。
    // 改错后果：组件卸载后其 refresh 仍在每个轮询周期被执行，读到已卸载组件的状态。
    const subscriberId = this.nextSubscriberId;
    this.nextSubscriberId += 1;
    this.subscribers.set(subscriberId, refresh);
    logger.debug("[coding-plan-reset] coordinator subscribed", {
      coordinatorKey: this.key,
      subscriberCount: this.subscribers.size,
    });
    // [并发] pollingWasRunning 必须在 start 之前采样：start 内部会立刻发起 run 并写入 running，
    // 之后再读 running 恒为真，无法区分「旧轮询在途」与「本轮刚发起」。
    // 该值只在 size 等于 1 的分支使用：首个订阅者恰好是异步刷新尚未结束时的重挂载。
    // [权衡] 这里再判一次 document.visibilityState 是否为隐藏，而不是信任 run 的内部提前返回：
    // 隐藏态下 run 会立刻返回已完成 Promise，补投影拿不到任何新状态，只会白白唤醒一次渲染。
    // 页面重新可见时 visibilitychange 会统一补一次，因此这里跳过不会让入口永久空白。
    // 补投影走 void 而不是等待，是为了不让 subscribe 变成异步：调用方需要同步拿到退订函数。
    // 失败只由 refreshSubscriber 记 warn，不向调用方冒泡，因为订阅建立本身已经成功。
    const pollingWasRunning = this.running !== null;
    if (this.subscribers.size === 1) {
      this.start();
      // HoverCard 可能在上一个入口的异步刷新尚未结束时卸载后重挂载。此时 run()
      // 会复用旧 Promise，但旧回调列表没有新入口；单独投影一次才能避免它空白等待下一轮轮询。
      if (pollingWasRunning && document.visibilityState !== "hidden") {
        void this.refreshSubscriber(refresh);
      }
    } else if (document.visibilityState !== "hidden") {
      // 后挂载入口需要立即把共享快照投影到自己的 sourceKey。底层请求会命中同 scope
      // 的 in-flight/cache/opportunity 冷却，因此不会因为 HoverCard 打开而放大网络请求。
      void this.refreshSubscriber(refresh);
    }

    return () => {
      // [资源] 用 delete 的返回值判定是否真的摘除，使退订函数天然幂等：
      // 组件可能被卸载路径与 effect 清理各调用一次，第二次必须直接返回。
      // 重复退订若继续递减，会把别人的订阅当成消失，提前停掉整组轮询。
      // 只有 size 归零才 stop：先删除再判断的顺序不能反，否则最后一个订阅者退订时仍会看到 1。
      // stop 放在日志之后，是为了日志如实记录归零后的订阅数，便于排查计数泄漏。
      // 退订不删除协调器，也不清空订阅集合之外的调度状态，重挂载才能接着用同一份冷却。
      // 不要在退订里顺手清空 subscribers：并发新增的条目会被一并抹掉，新入口收不到投影。
      // 改错后果：关闭一个 HoverCard 就停掉其它仍然打开入口的自动刷新。
      if (!this.subscribers.delete(subscriberId)) {
        return;
      }
      logger.debug("[coding-plan-reset] coordinator unsubscribed", {
        coordinatorKey: this.key,
        subscriberCount: this.subscribers.size,
      });
      if (this.subscribers.size === 0) {
        this.stop();
      }
    };
  }

  private async refreshSubscriber(refresh: RefreshCallback): Promise<void> {
    try {
      await refresh();
    } catch (error) {
      logger.warn("[coding-plan-reset] status refresh failed", {
        coordinatorKey: this.key,
        error: toErrorMessage(error),
      });
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.clearInterval();
      return;
    }
    this.startVisiblePolling();
  };

  // [并发] listening 标记是「监听已注册」的唯一事实来源，不能由调用次数推断：
  // start 只在订阅数从 0 变 1 时进入，但中间可能经历可见性切换，重复注册不报错却会重复触发。
  // start 与 stop 必须成对改写该标记，任何提前返回都要保证标记与真实注册状态一致。
  // [并发] 隐藏态下只注册监听、不启动计时器：后台标签页保留一个零开销的唤醒钩子，
  // 等 visibilitychange 到来再恢复轮询，避免后台每个周期都发一次状态请求。
  // 首次订阅若发生在隐藏页面却直接起计时器，用户看不到任何收益却要付出额度与流量。
  // 这里也不调用 run：run 自身会判隐藏并返回，调用只会多一次无意义的分支与日志。
  // 改错后果：后台标签页持续轮询，额度刷新机会在用户无感知时被消耗。
  private start(): void {
    if (!this.listening) {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      this.listening = true;
    }
    if (document.visibilityState !== "hidden") {
      this.startVisiblePolling();
    }
  }

  // [资源] 释放顺序固定：先清计时器、再摘监听、最后把 listening 置回 false。
  // 先摘监听会让可见性变化失去兜底，若计时器还在，页面隐藏后仍会按周期触发。
  // 先清计时器再动监听，能保证不出现「监听已摘、计时器仍在」的孤儿周期。
  // stop 不重置 running：在途 Promise 的 finally 要靠它判断是否清空自己，提前置空会让单飞失效。
  // stop 也不清空 subscribers：退订闭包已删掉对应项，这里再清会抹掉并发新增的订阅。
  // 该函数可被重复调用，清除逻辑自身幂等，因此不需要额外的停止标记。
  // 改错后果：打乱 `stop()` 的清理顺序会导致页面隐藏后仍在后台刷新，重挂载时计时器与监听翻倍。
  private stop(): void {
    this.clearInterval();
    if (this.listening) {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      this.listening = false;
    }
    // HoverCard 关闭会短暂没有订阅者。只停止计时器、不删除 Coordinator，
    // 才能在重新打开后继续复用 opportunity 的 next_try_at，避免再次立即请求。
    logger.debug("[coding-plan-reset] coordinator stopped", {
      coordinatorKey: this.key,
    });
  }

  // [并发] `startVisiblePolling` 进入即先调 `clearInterval()`，使可见性来回切换收敛为最多一个计时器。
  // 若省掉这步，隐藏时遗留的 interval 不会被别处清掉，快速切换后就会叠加出两条轮询链。
  // [权衡] 立即发起一次刷新再挂 interval，而不是等满一个周期：首次可见必须尽快拿到状态，
  // 同时 run 的单飞保证这次立即刷新与在途广播不会并发。
  // 这里用 void 丢弃 Promise，异常已在 run 内部被 allSettled 与 warn 吸收，不会变成未处理拒绝。
  // 改错后果：漏掉 `clearInterval()` 会叠加计时器，把 `STATUS_POLL_INTERVAL_MS` 压到秒级并触发后端限流。
  private startVisiblePolling(): void {
    this.clearInterval();
    void this.run();
    this.interval = window.setInterval(() => void this.run(), STATUS_POLL_INTERVAL_MS);
  }

  private clearInterval(): void {
    if (this.interval === null) {
      return;
    }
    window.clearInterval(this.interval);
    this.interval = null;
  }

  // [并发] 单飞的判据是同一次调用的 Promise：running 非空即代表一轮广播还没落地，
  // 此时直接返回同一个 Promise，调用方拿到的是同一轮结果，而不是排队等下一轮。
  // [并发] 回调快照必须在任何等待之前完成：刷新过程中若有入口退订或新增，
  // 实时遍历集合会跳过被删项、或把新入口塞进本轮，导致某个 sourceKey 整轮收不到投影。
  // [失败路径] 空订阅或页面隐藏时返回已完成 Promise 且不写 running：
  // 若改成写占位，可见后的首轮刷新会误判已有在途任务而被吞掉，入口空白一轮。
  private run(): Promise<void> {
    if (this.running) {
      return this.running;
    }
    const refreshCallbacks = [...this.subscribers.values()];
    if (refreshCallbacks.length === 0 || document.visibilityState === "hidden") {
      return Promise.resolve();
    }

    logger.debug("[coding-plan-reset] coordinator refresh", {
      coordinatorKey: this.key,
      subscriberCount: refreshCallbacks.length,
    });
    // 一个 Coordinator tick 同时通知所有 source 做状态投影；底层 status/opportunity 仍通过
    // shared in-flight 与调度器只发一组网络请求，避免不同 sourceKey 的入口拿不到共享结果。
    const request = Promise.allSettled(
      refreshCallbacks.map((refresh) => Promise.resolve().then(refresh)),
    )
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            logger.warn("[coding-plan-reset] status refresh failed", {
              coordinatorKey: this.key,
              error: toErrorMessage(result.reason),
            });
          }
        }
      })
      .finally(() => {
        if (this.running === request) {
          this.running = null;
        }
      });
    this.running = request;
    return request;
  }
}

export function subscribeCodingPlanQuotaResetPolling(
  params: PollingSubscriptionParams,
): () => void {
  const coordinatorKey = buildCoordinatorKey(params.authSessionSeq, params.scope);
  const coordinators = getServiceMap(coordinatorsByService, params.service);
  let coordinator = coordinators.get(coordinatorKey);
  if (!coordinator) {
    coordinator = new CodingPlanQuotaResetPollingCoordinator(coordinatorKey);
    coordinators.set(coordinatorKey, coordinator);
  }
  return coordinator.subscribe(params.refresh);
}

export function requestCodingPlanResetOpportunityWhenDue(
  params: CoordinatorParams,
): Promise<CodingPlanResetOpportunityResult | null> {
  const coordinatorKey = buildCoordinatorKey(params.authSessionSeq, params.scope);
  const schedules = getServiceMap(opportunitySchedulesByService, params.service);
  let schedule = schedules.get(coordinatorKey);
  if (!schedule) {
    schedule = {
      nextCheckAt: 0,
      retryIdempotencyKey: null,
      inflight: null,
    };
    schedules.set(coordinatorKey, schedule);
  }

  // [事务] 冷却判定与 inflight 占位在同一同步片段内完成，中间没有等待：
  // JS 单线程保证这段不会被其它调用插入，因此不存在两次判断同时通过的竞态。
  // 若把异步链插到两者之间，两次并发调用会各自发出一个携带不同幂等 key 的请求。
  // 这里的 now 只采样一次，避免多次取时让 nextCheckAt 的边界判定抖动。
  // 初始 nextCheckAt 为 0，等价于首次调用立即放行，不需要额外的首次标记。
  // 改错后果：并发入口各发一次重置请求，后端把一次机会记成多次。
  const now = Date.now();
  if (schedule.inflight) {
    return schedule.inflight;
  }
  if (now < schedule.nextCheckAt) {
    logger.debug("[coding-plan-reset] opportunity skipped by coordinator", {
      coordinatorKey,
      nextCheckAt: schedule.nextCheckAt,
    });
    return Promise.resolve(null);
  }

  // [事务] 幂等 key 只在同一轮重试内复用，由 retryIdempotencyKey 承载跨调用记忆：
  // 瞬时错误下用它重发，后端才认得出这是同一次重置而不是新的一次机会申请。
  // 稳定错误与限流必须丢弃该 key，否则冷却结束后仍在重放一个已被判定的旧请求。
  // 成功路径在 then 中清空，保证下一次到期的判定是全新的机会申请。
  // key 的生成与保存必须同源：任何绕过该变量直接生成 key 的改动都会破坏去重。
  // 改错后果：`retryIdempotencyKey` 不稳定时，网络抖动会被后端计成多次重置，额度与界面显示不一致。
  const idempotencyKey = schedule.retryIdempotencyKey ?? createIdempotencyKey();
  logger.debug("[coding-plan-reset] opportunity request", {
    coordinatorKey,
    retrying: schedule.retryIdempotencyKey !== null,
  });
  const request = params.service
    .requestCodingPlanResetOpportunity({
      ...params.scope,
      idempotencyKey,
    })
    .then((result) => {
      schedule.nextCheckAt = resolveOpportunityNextCheckAt(result, Date.now());
      schedule.retryIdempotencyKey = null;
      return result;
    })
    .catch((error: unknown) => {
      const transient = !isOpportunityThrottleError(error) && isOpportunityTransientError(error);
      schedule.nextCheckAt =
        Date.now() +
        (transient ? OPPORTUNITY_TRANSIENT_ERROR_RETRY_MS : OPPORTUNITY_STABLE_ERROR_COOLDOWN_MS);
      // 鉴权、业务拒绝和协议错误不能当成瞬时依赖错误，否则每个轮询周期都会空转一次并刷 warn。
      // 只有 2007、网络中断和超时复用原幂等 key 在五分钟后重试；429 与稳定错误冷却后开启新判断。
      schedule.retryIdempotencyKey = transient ? idempotencyKey : null;
      throw error;
    })
    .finally(() => {
      if (schedule.inflight === request) {
        schedule.inflight = null;
      }
    });
  schedule.inflight = request;
  return request;
}
