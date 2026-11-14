// INV-01 环境来源与内置来源互斥：守住位置 构造分支；改错故障 两套源同时读盘。
// INV-02 远端同步只在文件源：守住位置 实例判断；改错故障 端点源也去拉远端。
// INV-03 旧配置导入仅在缺文件时触发：守住位置 注入函数；改错故障 已有配置被覆盖。
// INV-04 服务在构造期装配：守住位置 末次赋值；改错故障 调用方拿到未初始化服务。
// INV-05 启动只跑一次：守住位置 启动承诺缓存；改错故障 重复读配置。
// INV-06 启动失败可重试：守住位置 捕获清缓存；改错故障 一次失败永久卡死。
// INV-07 无下载配置不建周期任务：守住位置 条件判断；改错故障 Worker 空转定时器。
// INV-08 定时器不阻塞退出：守住位置 取消引用；改错故障 进程无法自然结束。
// INV-09 已销毁拒绝启动：守住位置 状态判断；改错故障 销毁后仍拉起轮询。
// INV-10 刷新在销毁后返回固定值：守住位置 早退分支；改错故障 销毁后仍访问网络。
// INV-11 刷新按来源分派：守住位置 实例判断；改错故障 端点源走到空同步器。
// INV-12 后台检查单飞：守住位置 在飞缓存；改错故障 定时器叠加并发检查。
// INV-13 检查结果逐个上报：守住位置 遍历判断；改错故障 首个错误后静默其余。
// INV-14 监听器可注销：守住位置 返回函数；改错故障 注销后仍被执行。
// INV-15 检查异常不外抛：守住位置 全量结算；改错故障 出现未捕获拒绝。
// INV-16 活动文件路径两源兼容：守住位置 实例分支；改错故障 端点源调用缺失方法。
// INV-17 销毁幂等：守住位置 状态判断；改错故障 二次销毁抛错。
// INV-18 销毁释放全部子资源：守住位置 依次调用；改错故障 定时器与监听泄漏。
//
// 模块职责：组装 Node 进程内共享的 Provider 配置运行边界。
// 状态所有权：配置快照由 #zcodeBuiltinSource 与 #personalRepository 持有，NodeProviderConfigRuntime 只编排启动与销毁的生命周期。
// 若把配置内容缓存在本类，两个来源自己的版本判断会因此脱节。
// 阅读顺序：先看构造装配，再看启动与刷新，最后看后台检查与销毁。
import {
  ProviderConfigService,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import {
  EndpointScopedZCodeBuiltinSource,
  type EndpointScopedZCodeBuiltinSourceOptions,
} from "./endpoint-scoped-zcode-builtin-source.js";
import {
  ZCodeBuiltinRemoteSynchronizer,
  type ZCodeBuiltinRemoteSynchronizerOptions,
  type ZCodeBuiltinRefreshResult,
} from "./zcode-builtin-remote-synchronizer.js";
import {
  NodePersonalProviderConfigRepository,
  type PersonalProviderConfigRecoveryEvent,
} from "./personal-provider-config-repository.js";

export interface NodeProviderConfigRuntimeOptions {
  readonly zcodeBuiltinFilePath: string;
  readonly zcodeBuiltinActiveFilePath?: string;
  readonly zcodeBuiltinRemote?: Omit<ZCodeBuiltinRemoteSynchronizerOptions, "source">;
  readonly zcodeBuiltinEnvironment?: Omit<
    EndpointScopedZCodeBuiltinSourceOptions,
    "bundledFilePath"
  >;
  readonly onZCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly importLegacy?: (
    zcodeBuiltin: ProviderConfigLayerSnapshot,
  ) => Promise<ProviderConfigLayerUpdate | null>;
  readonly watch?: boolean;
}

/** 组装一个 Node.js 进程内共享的 ZCode Built-in/Personal Config 运行边界。 */
export class NodeProviderConfigRuntime {
  readonly configService: ProviderConfigService;
  readonly #zcodeBuiltinSource:
    | NodeZCodeBuiltinProviderConfigSource
    | EndpointScopedZCodeBuiltinSource;
  readonly #personalRepository: NodePersonalProviderConfigRepository;
  readonly #remoteSynchronizer?: ZCodeBuiltinRemoteSynchronizer;
  readonly #onRemoteRefreshError?: (error: unknown) => void;
  #startPromise: Promise<void> | null = null;
  #disposed = false;
  readonly #checkListeners = new Set<() => Promise<void>>();
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #checkInFlight: Promise<void> | null = null;

  // 环境来源与文件来源二选一：传了 zcodeBuiltinEnvironment 就用 EndpointScopedZCodeBuiltinSource。
  // 远端同步只包在文件来源外；importLegacy 缺省时不注入；配置服务最后装配，所见即完整实例。
  // 构造期只做装配、不发起任何 IO：configService.read() 留到 start()，否则调用方无法在构造后同步调整选项。
  constructor(options: NodeProviderConfigRuntimeOptions) {
    // 传了 zcodeBuiltinEnvironment 时构造 EndpointScopedZCodeBuiltinSource，它按端点作用域读环境配置。
    // 否则用 NodeZCodeBuiltinProviderConfigSource 读本地文件，activeFilePath 与 watch 只对这个实现有意义。
    this.#zcodeBuiltinSource = options.zcodeBuiltinEnvironment
      ? new EndpointScopedZCodeBuiltinSource({
          bundledFilePath: options.zcodeBuiltinFilePath,
          ...options.zcodeBuiltinEnvironment,
        })
      : new NodeZCodeBuiltinProviderConfigSource({
          bundledFilePath: options.zcodeBuiltinFilePath,
          activeFilePath: options.zcodeBuiltinActiveFilePath,
          watch: options.watch,
        });
    // 远端同步只包在文件来源外：端点源自己就是远端事实，再包一层会把同一份配置拉两次。
    // 没给 zcodeBuiltinRemote 时保持 undefined，refreshZCodeBuiltin() 会返回 "skipped" 而不是抛错。
    this.#remoteSynchronizer =
      options.zcodeBuiltinRemote &&
      this.#zcodeBuiltinSource instanceof NodeZCodeBuiltinProviderConfigSource
        ? new ZCodeBuiltinRemoteSynchronizer({
            source: this.#zcodeBuiltinSource,
            ...options.zcodeBuiltinRemote,
          })
        : undefined;
    // 刷新错误回调只存引用，真正的调用点在 #checkBackground 的 allSettled 结果遍历里。
    this.#onRemoteRefreshError = options.onZCodeBuiltinRefreshError;
    // personalFilePath 是必填项：个人配置是本运行边界的第二个事实源，缺它就无法装配 ProviderConfigService。
    // onRecovery 与 onPollingError 原样透传给仓库，观测失败不影响读写主路径。
    this.#personalRepository = new NodePersonalProviderConfigRepository({
      filePath: options.personalFilePath,
      onRecovery: options.onPersonalConfigRecovery,
      onPollingError: options.onPersonalConfigPollingError,
      pollingIntervalMs: options.personalPollingIntervalMs,
      ...(options.importLegacy
        ? {
            importLegacy: async () => options.importLegacy!(await this.#zcodeBuiltinSource.read()),
          }
        : {}),
    });
    // importLegacy 包一层闭包：调用时才读内置源，把快照交给外部导入函数；不传就完全不注入该字段。
    // configService 最后装配，且只接收上面两个已完成初始化的来源，保证构造返回时实例可直接使用。
    this.configService = new ProviderConfigService({
      zcodeBuiltinSource: this.#zcodeBuiltinSource,
      personalRepository: this.#personalRepository,
    });
  }

  resolveZCodeBuiltinActiveFilePath(): Promise<string> {
    // 文件来源的 activeFilePath 是构造期就确定的字段，直接包成已完成的 Promise。
    // 端点源要先解析端点作用域才能得到路径，因此必须调用它的异步方法。
    return this.#zcodeBuiltinSource instanceof NodeZCodeBuiltinProviderConfigSource
      ? Promise.resolve(this.#zcodeBuiltinSource.activeFilePath)
      : this.#zcodeBuiltinSource.resolveActiveFilePath();
  }

  get personalRepository(): import("@zcode/provider").PersonalProviderConfigRepository {
    // 暴露接口类型而不是具体类：调用方只能读写个人配置，拿不到轮询与销毁的控制权。
    return this.#personalRepository;
  }

  /** Environment 同一周期检查中恢复未对齐依赖，不被下载 TTL 或失败挡住。 */
  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    // 监听器在每轮 #checkBackground 里与刷新并行执行，用于恢复未对齐的依赖。
    this.#checkListeners.add(listener);
    // 返回的注销函数只删自己这一项；重复注销是安全的空操作。
    return () => this.#checkListeners.delete(listener);
  }

  // start() 只跑一次：#startPromise 缓存启动承诺，已销毁则直接抛错，重复调用复用同一承诺。
  // 首次 configService.read() 完成后再触发 #checkBackground()；只有存在远端同步器、端点源或监听器时才建 60s 定时器，避免 Worker 空转。
  // 启动失败时清空 #startPromise，允许调用方重试而不是永久卡死。
  start(): Promise<void> {
    // 已销毁实例不允许再拉起轮询：这里抛错而不是返回 rejected Promise，调用方能立刻发现生命周期用错。
    if (this.#disposed) throw new Error("NodeProviderConfigRuntime 已 dispose");
    // 启动承诺只在首次创建；重复调用返回同一个 Promise，避免并发 start() 把配置读两遍。
    if (this.#startPromise) return this.#startPromise;
    // 先读一次配置再开定时器：read() 会完成导入与规范化，失败时不应留下空转的检查循环。
    const startPromise = this.configService.read().then(() => {
      // read() 期间可能被 dispose，这个早退防止销毁后重新挂上定时器。
      if (this.#disposed) return;
      void this.#checkBackground();
      // Managed Worker 无下载配置也无恢复 owner，不建立周期任务。
      // 只有远端同步器、端点源或已注册监听器三者之一存在时才需要周期检查，否则定时器会空转。
      if (
        this.#remoteSynchronizer ||
        this.#zcodeBuiltinSource instanceof EndpointScopedZCodeBuiltinSource ||
        this.#checkListeners.size > 0
      ) {
        // 60s 是恢复检查的固定节奏，具体刷新是否发生由 refreshZCodeBuiltin() 的下载 TTL 决定。
        this.#checkTimer = setInterval(() => {
          void this.#checkBackground();
        }, 60_000);
        // unref 让定时器不把进程钉在事件循环里，CLI 跑完可以自然退出。
        this.#checkTimer.unref?.();
      }
    });
    this.#startPromise = startPromise;
    // 失败时只清自己这次的承诺：并发调用可能已经换上新承诺，误清会把重试窗口关掉。
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  // refreshZCodeBuiltin() 按来源分派：已销毁返回 "disposed"，端点源走自身 refresh()，文件源走 #remoteSynchronizer。
  // 没有同步器时返回 "skipped"，异常不在这里吞掉，交给调用方或 #checkBackground 的 allSettled 处理。
  refreshZCodeBuiltin(options?: { readonly force?: boolean }): Promise<ZCodeBuiltinRefreshResult> {
    // 销毁后返回固定值而不是 reject：定时器收尾阶段仍可能调到这里，抛错会变成未捕获拒绝。
    if (this.#disposed) return Promise.resolve("disposed");
    // 端点源自己持有下载与缓存，刷新必须走它自己的 refresh()，这里不能代劳。
    if (this.#zcodeBuiltinSource instanceof EndpointScopedZCodeBuiltinSource) {
      return this.#zcodeBuiltinSource.refresh(options);
    }
    // 文件源通过远端同步器刷新；同步器缺席说明宿主没配置远端，返回 "skipped" 让调用方区分「没做」与「失败」。
    return this.#remoteSynchronizer?.refresh(options) ?? Promise.resolve("skipped");
  }

  // #checkBackground() 单飞：#checkInFlight 在飞时直接复用，避免定时器叠加出并发检查。
  // 刷新与各监听器用 Promise.allSettled() 并行跑，失败逐个交给 #onRemoteRefreshError，不让首个错误吞掉其余结果。
  // finally 里只清自己这次赋值的引用，防止误清新一轮。
  #checkBackground(): Promise<void> {
    // 销毁后不再发起任何网络与文件访问，直接给一个已完成的 Promise。
    if (this.#disposed) return Promise.resolve();
    // 在飞时复用同一个检查：定时器与 start() 可能同时触发，单飞避免两轮并发刷新互相覆盖缓存。
    if (this.#checkInFlight) return this.#checkInFlight;
    // 刷新与各监听器互不依赖，用 allSettled 并行跑；任一失败都不能阻断其余监听器的恢复动作。
    const check = Promise.allSettled([
      this.refreshZCodeBuiltin(),
      ...[...this.#checkListeners].map((listener) => Promise.resolve().then(listener)),
    ])
      .then((results) => {
        // 结果回来时 this.#disposed 可能已为 true，此时不再回调宿主，否则会发出销毁后的观测事件。
        if (this.#disposed) return;
        // 逐个上报 rejected 结果：首个失败就退出会让后面的监听器错误永久静默。
        for (const result of results)
          if (result.status === "rejected") this.#onRemoteRefreshError?.(result.reason);
      })
      .finally(() => {
        // 只清自己这次赋值的引用：并发中可能已有新一轮挂上，#checkInFlight 相等才允许置空。
        if (this.#checkInFlight === check) this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  // dispose() 幂等：已销毁直接返回；否则先清 #checkTimer、再清 #checkListeners，随后依次释放
  // #remoteSynchronizer、configService、#personalRepository、#zcodeBuiltinSource，顺序保证没有回调残留。
  dispose(): void {
    // 幂等：二次销毁直接返回，否则重复 clearInterval 与 dispose 子资源会抛错。
    if (this.#disposed) return;
    this.#disposed = true;
    // 先停定时器，防止释放过程中又有新一轮 #checkBackground 被排进来。
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#checkTimer = null;
    // 再清 #checkListeners，之后即使有残留回调也找不到订阅者。
    this.#checkListeners.clear();
    // 释放顺序按「消费者先于被依赖方」：同步器依赖 zcodeBuiltinSource，必须先停同步器。
    this.#remoteSynchronizer?.dispose();
    // configService 同时引用两个来源，必须早于它们释放，否则会拿到已销毁的仓库。
    this.configService.dispose();
    this.#personalRepository.dispose();
    // 内置源最后释放，它是远端同步器与配置服务的共同依赖。
    this.#zcodeBuiltinSource.dispose();
  }
}

export function createNodeProviderConfigRuntime(
  options: NodeProviderConfigRuntimeOptions,
): NodeProviderConfigRuntime {
  // 工厂只负责 new，不做额外校验或缓存：每个进程各自持有一份运行边界，共享会绕过来源的版本判断。
  return new NodeProviderConfigRuntime(options);
}
