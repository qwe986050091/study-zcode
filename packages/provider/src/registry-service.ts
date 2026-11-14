// INV-01 三层来源各自带 revision：守住位置 快照结构；改错故障 无法判断哪层触发刷新。
// INV-02 密钥不进入本层：守住位置 快照字段；改错故障 token 随快照扩散到下游。
// INV-03 来源变化只累积原因：守住位置 监听回调；改错故障 每次变更都立即重算。
// INV-04 刷新按代际合并：守住位置 请求计数；改错故障 并发请求重复读源。
// INV-05 完成代际严格大于请求才发布：守住位置 循环条件；改错故障 旧结果覆盖新配置。
// INV-06 快照永远读已发布值：守住位置 取值方法；改错故障 调用方长期持有首启快照。
// INV-07 失败不伪装成功：守住位置 错误分支；改错故障 旧快照被当成新结果广播。
// INV-08 等待者按代际结算：守住位置 结算函数；改错故障 早请求拿到晚快照。
// INV-09 启动幂等：守住位置 started 标志；改错故障 重复 start 造成多份订阅。
// INV-10 未启动不许刷新：守住位置 显式刷新；改错故障 读到未装配的空来源。
// INV-11 销毁后拒绝新请求：守住位置 断言函数；改错故障 已销毁实例继续读源。
// INV-12 销毁要结算等待者：守住位置 清理分支；改错故障 调用方永久挂起。
// INV-13 内置与账号版本要对齐：守住位置 版本比较；改错故障 新旧事实拼出错误组合。
// INV-14 版本未变不重建：守住位置 早退分支；改错故障 无变化也发布新快照。
// INV-15 候选组合成功才替换：守住位置 try 块；改错故障 半成品进入注册表。
// INV-16 快照整体冻结：守住位置 构造处；改错故障 下游误改共享视图。
// INV-17 订阅返回退订函数：守住位置 注册方法；改错故障 监听集合无限增长。
// INV-18 失败事件带原因集合：守住位置 错误广播；改错故障 无法定位是哪层失败。
//
// 职责：把 Built-in / Personal / Account 三层 configuration 解析成一份 ProviderRegistryServiceSnapshot。
// 状态所有权：ProviderRegistryService 持有 requestedGeneration / completedGeneration、refreshWaiters 与已发布 snapshot。
// 阅读顺序：先看类字段与启动，再看请求合并，最后看刷新循环与结算。
/**
 * ============================================================================
 * provider/registry-service.ts —— Provider 配置的分层汇总与热刷新
 * ============================================================================
 *
 * 【三层配置】Built-in（产品内置）→ Personal（用户配置）→ Account（账号权益）。
 *   每层都有自己的 revision；ProviderRegistryService 把三者解析成统一视图，
 *   并对外发布不可变 snapshot。Token/API Key/账号身份不得进入这一层。
 *
 * 【刷新模型】
 *   - config/account source 变化只累积 reason，不立即重算；
 *   - #requestRefresh 做代际合并：同一代际的并发请求只跑一次；
 *   - 完成代际严格大于请求代际才发布，避免旧刷新覆盖新配置；
 *   - getSnapshot 永远读最新已发布快照，不允许调用方长期持有首启快照。
 *
 * 【失败语义】刷新失败通过 error listener 发布，不把旧 snapshot 伪装成新结果；
 *   waiters 会按代际 reject。订阅方必须处理"配置暂时不可用"的状态。
 * ============================================================================
 */
import type { ModelId, ProviderId } from "./config/index.js";
import {
  ProviderRegistry,
  type ModelSelection,
  type ModelSelectionValidation,
  type ProviderRegistryView,
} from "./registry.js";
import {
  ProviderConfigResolver,
  type ProviderConfigResolution,
  type Provider,
  type ProviderModel,
} from "./resolver.js";
import type {
  AccountProviderConfigSnapshot,
  ProviderConfigSnapshot,
  ProviderSource,
} from "./sources.js";

// 一份快照把三层来源的 revision、解析结果与 registry 视图钉在同一代际：
// 下游只能整体替换引用，不能跨快照拼字段，否则 config 与 account 会来自不同次读源。
export interface ProviderRegistryServiceSnapshot {
  readonly sourceRevisions: {
    readonly config: string;
    readonly account: string;
  };
  readonly config: ProviderConfigSnapshot;
  readonly account: AccountProviderConfigSnapshot;
  readonly resolution: ProviderConfigResolution;
  readonly registry: ProviderRegistryView;
}

export interface ProviderRegistryServiceChangedEvent {
  readonly snapshot: ProviderRegistryServiceSnapshot;
  readonly reasons: readonly string[];
}

export interface ProviderRegistryServiceRefreshErrorEvent {
  readonly error: unknown;
  readonly reasons: readonly string[];
}

// resolver 可注入以便测试或定制解析策略；缺省时构造器会补一个默认 ProviderConfigResolver。
export interface ProviderRegistryServiceDependencies {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly accountSource: ProviderSource<AccountProviderConfigSnapshot>;
  readonly resolver?: ProviderConfigResolver;
}

interface RefreshWaiter {
  readonly generation: number;
  readonly resolve: (snapshot: ProviderRegistryServiceSnapshot) => void;
  readonly reject: (error: unknown) => void;
}

// configSource / accountSource / resolver 在构造时注入，registry 与监听集合随实例存续。
// requestedGeneration 只在请求时递增，completedGeneration 只在一轮刷新落定后追上；
// #refreshInFlight 保证同一时刻只有一个刷新循环，避免并发读源。
// snapshot 首次发布前为 null，getSnapshot 原样返回它，调用方不得假设非空。
export class ProviderRegistryService {
  readonly #configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly #accountSource: ProviderSource<AccountProviderConfigSnapshot>;
  readonly #resolver: ProviderConfigResolver;
  readonly #registry = new ProviderRegistry();
  readonly #changeListeners = new Set<(event: ProviderRegistryServiceChangedEvent) => void>();
  readonly #errorListeners = new Set<(event: ProviderRegistryServiceRefreshErrorEvent) => void>();
  readonly #sourceDisposers: Array<() => void> = [];
  readonly #pendingReasons = new Set<string>();
  readonly #refreshWaiters: RefreshWaiter[] = [];
  #snapshot: ProviderRegistryServiceSnapshot | null = null;
  #requestedGeneration = 0;
  #completedGeneration = 0;
  #refreshInFlight: Promise<void> | null = null;
  #started = false;
  #disposed = false;

  constructor(dependencies: ProviderRegistryServiceDependencies) {
    this.#configSource = dependencies.configSource;
    this.#accountSource = dependencies.accountSource;
    this.#resolver = dependencies.resolver ?? new ProviderConfigResolver();
  }

  // 首次 start 才订阅 configSource / accountSource，退订函数存入 sourceDisposers；
  // 重复 start 不会产生第二份订阅。首次启动 await 一次 requestRefresh("start")，
  // 因此返回时 snapshot 已可用；刷新失败经 error listener 上报，不会静默丢给调用方。
  async start(): Promise<void> {
    this.#assertNotDisposed();
    if (!this.#started) {
      this.#started = true;
      this.#sourceDisposers.push(
        this.#configSource.onDidChange((reason) => this.#refreshFromSource("config", reason)),
        this.#accountSource.onDidChange((reason) => this.#refreshFromSource("account", reason)),
      );
      await this.#requestRefresh("start");
      return;
    }
    // 启动只负责就绪；业务读取必须使用 getSnapshot，不能长期保留首次启动快照。
    if (!this.#snapshot) await this.#requestRefresh("start");
  }

  // refresh 要求 started 为真：未 start 时来源尚未订阅，读到的会是未装配的空来源。
  // reason 并入 pendingReasons 后立即触发刷新循环；返回的 Promise 按发起时的 generation 结算，
  // 调用方不应缓存它。失败会同时 reject 该 Promise 并经 emitRefreshError 广播。
  refresh(reason = "explicit"): Promise<ProviderRegistryServiceSnapshot> {
    this.#assertNotDisposed();
    if (!this.#started) throw new Error("ProviderRegistryService 必须先 start() 再 refresh()");
    return this.#requestRefresh(reason);
  }

  // 返回已冻结的已发布快照本体，不做复制：调用方按引用比较即可判断配置是否换过。
  // 首轮刷新完成前为 null，这是合法状态，调用方必须处理“配置尚未可用”。
  getSnapshot(): ProviderRegistryServiceSnapshot | null {
    return this.#snapshot;
  }

  getView(): ProviderRegistryView {
    return this.#registry.getView();
  }

  // 以下查询方法全部转发 #registry：可见性、选择校验与列表顺序都由注册表决定，服务层不再二次过滤。
  // 这样过滤规则只保留一份，保证调用方无论走哪个方法都读到同一套口径。
  listProviders(): readonly Provider[] {
    return this.#registry.listProviders();
  }

  getProvider(providerId: ProviderId): Provider | undefined {
    return this.#registry.getProvider(providerId);
  }

  getModel(providerId: ProviderId, modelId: ModelId): ProviderModel | undefined {
    return this.#registry.getModel(providerId, modelId);
  }

  validateSelection(selection: ModelSelection): ModelSelectionValidation {
    return this.#registry.validateSelection(selection);
  }

  // 变更监听同步执行且未做 try/catch：任一监听器抛错会中断本轮其余监听器，
  // 并被 #runRefreshLoop 的 catch 当成刷新失败再广播一次 error，订阅方需要自行隔离异常。
  onDidChange(listener: (event: ProviderRegistryServiceChangedEvent) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  // 错误监听同样同步且未包裹 try：抛错会跳过本次 #rejectRefreshWaiters，
  // 最终由 #ensureRefreshLoop 的失败分支兜底，把剩余等待者统一 reject。
  onDidRefreshError(
    listener: (event: ProviderRegistryServiceRefreshErrorEvent) => void,
  ): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  // dispose 幂等：disposed 先置位，后续 start / refresh 会被 assertNotDisposed 直接拒绝。
  // sourceDisposers 用 splice(0) 逐个退订来源；refreshWaiters 全部 reject，
  // 否则等待者会永久挂起。change / error 监听集合清空，避免销毁后仍回调已释放的订阅方。
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#sourceDisposers.splice(0)) dispose();
    const error = new Error("ProviderRegistryService 已 dispose");
    for (const waiter of this.#refreshWaiters.splice(0)) waiter.reject(error);
    this.#changeListeners.clear();
    this.#errorListeners.clear();
  }

  // 来源回调只登记原因并触发合并刷新：这里不 await、不重试，失败统一经 onDidRefreshError 上报。
  // 晚到的变更会让本轮代际落后而作废重读，因此任何时刻仍只有一个刷新循环在读源。
  #refreshFromSource(source: "config" | "account", reason: string): void {
    if (this.#disposed) return;
    void this.#requestRefresh(`${source}:${reason || "changed"}`).catch(() => {
      // Source 驱动的后台刷新通过 onDidRefreshError 报告；调用栈没有 Promise 消费者。
    });
  }

  // requestedGeneration 单调递增，每个调用方带自己的 generation 登记到 refreshWaiters。
  // reason 先入 pendingReasons 再启动循环，保证同一窗口内的多来源变更合并成一次读源。
  // 同代际请求共享同一份结果；本方法不重试，失败由 runRefreshLoop 统一 reject。
  #requestRefresh(reason: string): Promise<ProviderRegistryServiceSnapshot> {
    const generation = this.#requestedGeneration + 1;
    this.#requestedGeneration = generation;
    this.#pendingReasons.add(reason);
    const result = new Promise<ProviderRegistryServiceSnapshot>((resolve, reject) => {
      this.#refreshWaiters.push({ generation, resolve, reject });
    });
    this.#ensureRefreshLoop();
    return result;
  }

  // 同一时刻只允许一个刷新循环：已有 inFlight 或已销毁就直接返回，新请求只登记等待者。
  // 循环自然结束后由 #finishRefresh 检查代际差，需要时原地续跑，不依赖调用方再触发。
  #ensureRefreshLoop(): void {
    if (this.#refreshInFlight || this.#disposed) return;
    const refresh = this.#runRefreshLoop();
    this.#refreshInFlight = refresh;
    void refresh.then(
      () => this.#finishRefresh(refresh),
      (error: unknown) => {
        this.#rejectRefreshWaiters(this.#requestedGeneration, error);
        this.#finishRefresh(refresh);
      },
    );
  }

  // 身份比较防止旧循环误清新循环的 inFlight；只有确属本轮才允许置空并检查是否续跑。
  #finishRefresh(refresh: Promise<void>): void {
    if (this.#refreshInFlight !== refresh) return;
    this.#refreshInFlight = null;
    if (this.#completedGeneration < this.#requestedGeneration) this.#ensureRefreshLoop();
  }

  // 循环条件是 completedGeneration < requestedGeneration：每轮锁定当前 requestedGeneration，
  // 期间新到的请求不改写本轮读取的两份来源。pendingReasons 合并后立即 clear，
  // 避免下一轮重复上报同一原因。read 失败时若 generation 已落后就 continue，
  // 否则记录完成代际、广播错误并 reject 本代际等待者。版本失配时先服务上一份 snapshot。
  async #runRefreshLoop(): Promise<void> {
    const reasons = new Set<string>();
    while (this.#completedGeneration < this.#requestedGeneration) {
      const generation = this.#requestedGeneration;
      for (const reason of this.#pendingReasons) reasons.add(reason);
      this.#pendingReasons.clear();

      let config: ProviderConfigSnapshot;
      let account: AccountProviderConfigSnapshot;
      try {
        [config, account] = await Promise.all([
          this.#configSource.read(),
          this.#accountSource.read(),
        ]);
      } catch (error) {
        if (generation < this.#requestedGeneration) continue;
        this.#completedGeneration = generation;
        this.#emitRefreshError(error, reasons);
        this.#rejectRefreshWaiters(generation, error);
        return;
      }

      if (generation < this.#requestedGeneration) continue;
      this.#assertNotDisposed();

      if (account.basedOnZCodeBuiltinRevision !== config.zcodeBuiltinRevision) {
        // Built-in 已变化但 Account 仍基于旧事实时，继续服务上一份完整 Registry。
        // 当前 generation 结束；等待 Account Source 的后续 change 再一次性发布最终组合。
        this.#completedGeneration = generation;
        if (this.#snapshot) this.#resolveRefreshWaiters(generation, this.#snapshot);
        reasons.clear();
        continue;
      }

      if (this.#hasSameSourceRevisions(config, account)) {
        this.#completedGeneration = generation;
        this.#resolveRefreshWaiters(generation, this.#snapshot!);
        reasons.clear();
        continue;
      }

      try {
        const resolution = this.#resolver.resolve({
          zcodeBuiltinProviders: config.zcodeBuiltinProviders,
          zcodeBuiltinProviderTemplates: config.zcodeBuiltinProviderTemplates,
          personalProviders: config.personalProviders,
          zcodeBuiltinModelRules: config.zcodeBuiltinModelRules,
          personalModels: config.personalModels,
          accountProviders: account.providers,
          accountStates: account.states,
          personalProviderOrder: config.personalProviderOrder,
        });
        this.#registry.replace(resolution.registryProviders, [...reasons].join(","));
        const snapshot = Object.freeze({
          sourceRevisions: Object.freeze({
            config: config.revision,
            account: account.revision,
          }),
          config: Object.freeze({ ...config }),
          account: freezeAccountSnapshot(account),
          resolution,
          registry: this.#registry.getView(),
        });
        this.#snapshot = snapshot;
        this.#completedGeneration = generation;
        this.#resolveRefreshWaiters(generation, snapshot);
        this.#emitChanged(snapshot, reasons);
        reasons.clear();
      } catch (error) {
        this.#completedGeneration = generation;
        this.#emitRefreshError(error, reasons);
        this.#rejectRefreshWaiters(generation, error);
        return;
      }
    }
  }

  // 只结算 generation <= 目标代际的等待者：更晚的请求必须等自己那一轮完成，
  // 否则早请求会拿到晚快照。被结算者共享同一份 snapshot 引用。
  // 队列用 splice 原地重写，未结算的等待者按原顺序保留，防止跨代际泄漏。
  #resolveRefreshWaiters(generation: number, snapshot: ProviderRegistryServiceSnapshot): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.resolve(snapshot);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  // reject 与 resolve 同构，但失败只覆盖目标代际及更早的等待者：晚请求仍由自己那一轮决定成败。
  #rejectRefreshWaiters(generation: number, error: unknown): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.reject(error);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  // 两层 revision 都与已发布快照相同才短路：少读一层就判定无变化会让另一层的变更被永久吞掉（INV-14）。
  #hasSameSourceRevisions(
    config: ProviderConfigSnapshot,
    account: AccountProviderConfigSnapshot,
  ): boolean {
    return (
      this.#snapshot?.sourceRevisions.config === config.revision &&
      this.#snapshot.sourceRevisions.account === account.revision
    );
  }

  // 事件对象整体冻结、reasons 复制成数组：监听器只能读取，改不到下一轮共享的集合。
  #emitChanged(snapshot: ProviderRegistryServiceSnapshot, reasons: ReadonlySet<string>): void {
    const event = Object.freeze({
      snapshot,
      reasons: Object.freeze([...reasons]),
    });
    for (const listener of this.#changeListeners) listener(event);
  }

  // 失败事件与变更事件使用同一份 reasons 快照，便于把错误归因到具体来源（INV-18）。
  #emitRefreshError(error: unknown, reasons: ReadonlySet<string>): void {
    const event = Object.freeze({
      error,
      reasons: Object.freeze([...reasons]),
    });
    for (const listener of this.#errorListeners) listener(event);
  }

  // 销毁是终态：所有公开入口都在这里统一抛错，调用方据此区分“生命周期已结束”和“业务失败”。
  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("ProviderRegistryService 已 dispose");
  }
}

// account 快照逐字段复制并冻结，states 只在存在时展开：显式写入 undefined 键会让下游比较凭空多出一项。
function freezeAccountSnapshot(
  snapshot: AccountProviderConfigSnapshot,
): AccountProviderConfigSnapshot {
  return Object.freeze({
    revision: snapshot.revision,
    basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
    providers: snapshot.providers,
    ...(snapshot.states ? { states: snapshot.states } : {}),
  });
}
