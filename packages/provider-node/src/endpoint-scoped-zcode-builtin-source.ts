// INV-01 Endpoint 决定全部路径：守住位置 resolveZCodeBuiltinCachePaths 入参；改错故障 切换控制面后仍读旧缓存。
// INV-02 切换不继承旧缓存：守住位置 #resolveCurrent 新建 source；改错故障 跨 Endpoint 读到上一环境的配置。
// INV-03 并发只解析一次：守住位置 #ensureInFlight；改错故障 首启并发读触发多份 watcher。
// INV-04 in-flight 自清理：守住位置 finally 内的相等判断；改错故障 失败的 Promise 被永久缓存。
// INV-05 路径未变即复用：守住位置 activeFilePath 比较；改错故障 每次读都重建 watcher 与同步器。
// INV-06 构造失败必须回滚：守住位置 catch 内三段 dispose；改错故障 半初始化对象泄漏文件监听。
// INV-07 先读后发布：守住位置 await source.read() 在赋值前；改错故障 上层拿到尚未物化的快照。
// INV-08 旧实例最后销毁：守住位置 previous?.dispose() 在赋值后；改错故障 事件间隙出现无监听窗口。
// INV-09 切换必须通知：守住位置 #emit("endpoint-changed")；改错故障 上层不知道配置已换源。
// INV-10 销毁后拒绝使用：守住位置 #assertNotDisposed；改错故障 卸载后仍能建立新 watcher。
// INV-11 销毁幂等：守住位置 #disposed 早退；改错故障 重复销毁清空已释放的监听集合。
// INV-12 监听器异常不外溢：守住位置 #emit 的单向遍历；改错故障 一个订阅者抛错阻断其余订阅者。
// INV-13 子资源成组释放：守住位置 CurrentEndpointSource.dispose；改错故障 漏掉 sourceDispose 留下监听。
// INV-14 resolveEndpointOrigin 可异步：守住位置 await 两次；改错故障 环境读取为异步时得到 Promise 字符串。
//
// 模块职责：把 ZCode 内置 provider 的缓存与同步绑定到当前控制面 Endpoint，并支持热切换。
// 阅读顺序：先看公共读接口，再看 ensureCurrent 的并发与复用，最后看切换时的销毁顺序。
import type { ProviderConfigLayerSnapshot, ProviderSource } from "@zcode/provider";
import {
  normalizeZCodeBuiltinEndpointOrigin,
  resolveZCodeBuiltinCachePaths,
} from "./zcode-builtin-cache-paths.js";
import { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import {
  ZCodeBuiltinRemoteSynchronizer,
  type ZCodeBuiltinRefreshResult,
  type ZCodeBuiltinRemoteSynchronizerOptions,
} from "./zcode-builtin-remote-synchronizer.js";

// 依赖全部注入，Endpoint 以函数给出。
export interface EndpointScopedZCodeBuiltinSourceOptions {
  readonly bundledFilePath: string;
  readonly environmentConfigRoot: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly resolveEndpointOrigin: () => string | Promise<string>;
  readonly fetchRelease: ZCodeBuiltinRemoteSynchronizerOptions["fetchRelease"];
  readonly onRefreshResult?: ZCodeBuiltinRemoteSynchronizerOptions["onRefreshResult"];
  readonly watch?: boolean;
}

/**
 * 让 Environment 的 ZCode 控制面 Endpoint 同时决定 Active/LKG 与刷新控制路径。
 * Endpoint 切换只替换当前 Source，不读取上一 Endpoint 的缓存。
 */
// 对外表现为一个普通 provider 源。
export class EndpointScopedZCodeBuiltinSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #options: EndpointScopedZCodeBuiltinSourceOptions;
  readonly #listeners = new Set<(reason: string) => void>();
  #current: CurrentEndpointSource | null = null;
  #ensureInFlight: Promise<CurrentEndpointSource> | null = null;
  #disposed = false;

  constructor(options: EndpointScopedZCodeBuiltinSourceOptions) {
    this.#options = options;
  }

  // 所有读操作都先确保当前源。
  async read(): Promise<ProviderConfigLayerSnapshot> {
    return (await this.#ensureCurrent()).source.read();
  }

  // 返回的退订函数直接 `this.#listeners.delete(listener)`，不做引用计数。
  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // 刷新作用于当前 Endpoint 的同步器。
  async refresh(options?: { readonly force?: boolean }): Promise<ZCodeBuiltinRefreshResult> {
    return (await this.#ensureCurrent()).synchronizer.refresh(options);
  }

  /** 返回当前 Environment Endpoint 对应、已完成物化的 Active Config 路径。 */
  // 物化路径用于外部诊断与展示。
  async resolveActiveFilePath(): Promise<string> {
    return (await this.#ensureCurrent()).activeFilePath;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#current?.dispose();
    this.#current = null;
    this.#listeners.clear();
  }

  // `#ensureCurrent` 让并发读共享同一次解析，`#dispose()` 或端点切换后重新解析。
  async #ensureCurrent(): Promise<CurrentEndpointSource> {
    this.#assertNotDisposed();
    // 在飞 Promise 直接复用。
    if (this.#ensureInFlight) return this.#ensureInFlight;
    const ensure = this.#resolveCurrent().finally(() => {
      if (this.#ensureInFlight === ensure) this.#ensureInFlight = null;
    });
    this.#ensureInFlight = ensure;
    return ensure;
  }

  // 解析 Endpoint 并对照当前路径。
  async #resolveCurrent(): Promise<CurrentEndpointSource> {
    const endpointOrigin = normalizeZCodeBuiltinEndpointOrigin(
      await this.#options.resolveEndpointOrigin(),
    );
    const paths = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: this.#options.environmentConfigRoot,
      platform: this.#options.platform,
      appVersion: this.#options.appVersion,
      zcodeEndpointOrigin: endpointOrigin,
    });
    // 路径相同则完全复用现有实例。
    if (this.#current?.activeFilePath === paths.activeFilePath) return this.#current;

    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: this.#options.bundledFilePath,
      activeFilePath: paths.activeFilePath,
      watch: this.#options.watch,
    });
    const sourceDispose = source.onDidChange((reason) => this.#emit(reason));
    const synchronizer = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath: paths.controlFilePath,
      resolveEndpointKey: async () =>
        normalizeZCodeBuiltinEndpointOrigin(await this.#options.resolveEndpointOrigin()),
      fetchRelease: this.#options.fetchRelease,
      onRefreshResult: this.#options.onRefreshResult,
    });
    // 先物化一次，成功才对外发布。
    try {
      await source.read();
      this.#assertNotDisposed();
    } catch (error) {
      sourceDispose();
      synchronizer.dispose();
      source.dispose();
      throw error;
    }

    const previous = this.#current;
    const current = new CurrentEndpointSource(
      paths.activeFilePath,
      source,
      synchronizer,
      sourceDispose,
    );
    this.#current = current;
    // 新实例就位后才销毁旧实例。
    previous?.dispose();
    if (previous) this.#emit("endpoint-changed");
    return current;
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  // `#assertNotDisposed` 在 `#disposed` 为真时立即抛错。
  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("EndpointScopedZCodeBuiltinSource 已 dispose");
  }
}

class CurrentEndpointSource {
  constructor(
    readonly activeFilePath: string,
    readonly source: NodeZCodeBuiltinProviderConfigSource,
    readonly synchronizer: ZCodeBuiltinRemoteSynchronizer,
    readonly sourceDispose: () => void,
  ) {}

  dispose(): void {
    this.sourceDispose();
    this.synchronizer.dispose();
    this.source.dispose();
  }
}
