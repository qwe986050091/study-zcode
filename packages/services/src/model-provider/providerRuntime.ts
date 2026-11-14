import {
  NodeModelSelectionConfigRepository,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import {
  ProviderRegistryService,
  ProviderSettingsFacade,
  createFailClosedAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSettingsMutationTarget,
  type ProviderSource,
} from "@zcode/provider";
import {
  createProviderConfigRuntime,
  type ProviderConfigRuntime,
  type ProviderConfigRuntimeOptions,
} from "./providerConfigRuntime.js";
import {
  createModelSelectionService,
  createProviderSettingsService,
  type IModelSelectionService,
  type IProviderSettingsService,
  type ModelSelectionConfiguredDefaultSource,
  type ProviderSettingsConnectivityTester,
} from "./providerFacadeServices.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

// INV-01：一个进程只有一个 ProviderRuntime，configService/registryService/Facade 都由它派生；
// 并行创建第二个 Registry 会让两套快照各自刷新并互相覆盖。
// INV-02：start 至多执行一次、失败后可重试；dispose 之后任何 start 必须同步抛错。
// INV-03：账号能力缺失用 EmptyAccountProviderConfigSource 显式 fail-closed，
// 而不是让 Registry 跳过 Account 层——跳过会让普通 API Provider 失去账号 overlay 语义。
// INV-04：本类不缓存配置内容，只持有服务引用；任何快照都必须现场向 configService 读取。
const log = createServiceLogger("provider-runtime");

// 面向上层（CLI/Desktop）的平铺选项：内部会据此自行创建 ConfigRuntime。
export interface ProviderRuntimeOptions extends ProviderConfigRuntimeOptions {
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
}

// 面向测试与已有 ConfigRuntime 的调用方；dispose* 回调由创建方传入，本类只负责按序调用。
export interface ProviderRuntimeDependencies {
  readonly configRuntime: ProviderConfigRuntime;
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly disposeAccountSource?: () => void;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
  readonly modelSelectionConfiguredDefaultSource?: ModelSelectionConfiguredDefaultSource;
  readonly disposeModelSelectionConfiguredDefaultSource?: () => void;
}

// refresh 是可选能力：只读 Source 也满足 ProviderSource，
// 但账号恢复与设置刷新需要主动调用 refreshSources 重拉，装配层用它做能力探测。
interface RefreshableProviderSource<TSnapshot> extends ProviderSource<TSnapshot> {
  refresh?(reason: string): Promise<TSnapshot>;
}

/**
 * 普通 API Provider 可以在账号能力尚未装配时独立运行。
 * Account Provider 由当前 Built-in revision 对齐的 access.entitled=false Overlay 显式 fail-closed。
 */
// 未装配账号能力时的占位实现：读到的 Account 快照显式标记 access.entitled=false，
// 让账号 Provider 在 Registry 中处于「已知不可用」而不是「未知」。
// [权衡] 不返回 null 模拟加载失败：null 会被上层当成可重试错误并反复重试。
// onDidChange 返回空退订函数，调用方无需区分占位与真实 Source。
// 构造时接收 ProviderConfigSnapshot 源，只为让 fail-closed 快照对齐当前 Built-in revision。
export class EmptyAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  constructor(readonly configSource: ProviderSource<ProviderConfigSnapshot>) {}

// 每次 read 都重新包一层：Built-in revision 变化时 fail-closed 快照必须跟着变，
// 不能在构造时缓存。
  async read(): Promise<AccountProviderConfigSnapshot> {
    // 每次 read 都现场包一层：configSource 的 Built-in revision 可能已变，缓存快照会让 fail-closed 指向旧版本。
    return createFailClosedAccountProviderConfigSnapshot(await this.configSource.read());
  }

// 占位 Source 永不变化，退订是 no-op；保留该签名让调用方统一处理。
  onDidChange(): () => void {
    // 占位 Source 不产生变更事件；空函数让调用方统一处理退订，不必判空。
    return () => {};
  }
}

/** 组装一个进程内共享的 Provider Config、Registry 与 Facade。 */
// [资源] dispose 关心释放顺序：监听 → 视图 → Registry → 注入资源 → Config，
// 保证任何回调都不会在依赖已释放后被触发。
// #startPromise 缓存启动结果：并发启动共用同一 Promise，失败后清空以便重试。
// 字段都是 readonly 或私有，外部只能通过 configService/registryService/Facade 访问。
// #modelSelectionRuntime 额外持有 dispose：ModelSelection 服务自身还有监听需要拆除。
export class ProviderRuntime {
  readonly configService: ProviderConfigRuntime["configService"];
  readonly registryService: ProviderRegistryService;
  readonly providerSettings: IProviderSettingsService;
  readonly modelSelection: IModelSelectionService;
  readonly #configRuntime: ProviderConfigRuntime;
  readonly #disposeAccountSource?: () => void;
  readonly #disposeBuiltinRecovery: () => void;
  readonly #modelSelectionRuntime: IModelSelectionService & { dispose(): void };
  readonly #disposeModelSelectionConfiguredDefaultSource?: () => void;
// 必须持有 Promise 而不是 boolean：并发调用要等待同一次启动完成，
// 否则 registry.start 会被执行两次。
  #startPromise: ReturnType<ProviderRegistryService["start"]> | null = null;
  #disposed = false;

// 装配顺序有依赖：先注册 Built-in 恢复监听，再建 Registry，最后包出 Facade，
// 这样 Facade 的任何调用都不可能在 Registry 未就绪时发生。
  constructor(dependencies: ProviderRuntimeDependencies) {
    // ConfigRuntime 由调用方创建并传入，本类只持引用，释放顺序统一在 dispose 里定义。
    this.#configRuntime = dependencies.configRuntime;
    // accountSource 的释放回调来自创建方；占位实现没有资源，这里允许为空。
    this.#disposeAccountSource = dependencies.disposeAccountSource;
    // configured-default 仓库同样由创建方持有，释放函数一并下传，避免仓库监听泄漏。
    this.#disposeModelSelectionConfiguredDefaultSource =
      dependencies.disposeModelSelectionConfiguredDefaultSource;
    // 对外只暴露 configService 引用而不暴露整个 ConfigRuntime，以限制可写面。
    this.configService = this.#configRuntime.configService;
    const accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot> =
      // 未注入账号能力时用 fail-closed 占位，普通 API Provider 仍可独立工作，账号 Provider 则被标为不可用。
      dependencies.accountSource ?? new EmptyAccountProviderConfigSource(this.configService);
// [并发] Built-in 检查与账号读取并行：两者互不依赖，串行只会放大启动延迟。
// 仅在 revision 不一致且未 dispose 时主动 refresh 账号层；
// dispose 后回调仍可能被晚到的检查触发，因此必须重新判活而不只依赖退订。
    this.#disposeBuiltinRecovery = this.#configRuntime.onDidCheckZCodeBuiltin(async () => {
      // 并行读两份快照：Built-in 读本地文件、账号读当前订阅，两者互不依赖，串行只会放大启动延迟。
      const [config, account] = await Promise.all([
        this.configService.read(),
        accountSource.read(),
      ]);
      // dispose 后仍可能收到晚到的检查回调，必须重新判活，不能只依赖退订。
      if (!this.#disposed && config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision) {
        await accountSource.refresh?.("builtin-account-recovery");
      }
    });
// 三层合并（Built-in → Account → Personal）由 Registry 统一负责，装配层不参与合并顺序。
    // Registry 只拿两个 Source，三层合并顺序与快照缓存都在 Registry 内部，装配层不参与。
    this.registryService = new ProviderRegistryService({
      configSource: this.configService,
      accountSource,
    });
    // 写入口在构造期一次性绑定，之后 Facade 的所有写操作都走同一份转发表。
    const mutations = createSettingsMutationTarget(
      this.#configRuntime,
      this.registryService,
      accountSource,
    );
// Facade 的每个方法都先 await ensureReady：UI/RPC 可能早于 start 发起读取，
// 让「启动」成为隐式前置条件而不是调用约定。
    const ensureReady = () => this.start();
    // Facade 只依赖 Registry 与 mutations，不感知 ConfigRuntime，便于测试替换。
    const settingsFacade = new ProviderSettingsFacade(this.registryService, mutations);
    // 设置服务持有 ensureReady 与连通性测试器，任何读操作都会隐式触发启动。
    this.providerSettings = createProviderSettingsService(
      settingsFacade,
      ensureReady,
      dependencies.testConnectivity,
    );
    // 单独保存 modelSelection 引用是为了 dispose：它自身还有监听要拆除。
    this.#modelSelectionRuntime = createModelSelectionService(
      createNodeModelSelectionFacade(this.registryService),
      ensureReady,
      dependencies.modelSelectionConfiguredDefaultSource,
    );
    this.modelSelection = this.#modelSelectionRuntime;
  }

// [并发] 先赋 Promise 再挂 catch：同步段内不会出现「已开始但未登记」的窗口。
// [失败路径] 失败时清空缓存但保留 rejection 给当前等待者，
// 下一次调用重新走完整启动，而不是永久卡在 rejected。
// Config 先启动、Registry 后启动：Registry 首次合并必须能读到已加载的 Personal 文件。
  start(): Promise<void> {
    // dispose 后同步抛错而不是返回 rejected：调用方在 await 之前就能发现生命周期错误。
    if (this.#disposed) throw new Error("ProviderRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    // Config 必须先于 Registry 启动：Registry 首次合并要读已加载的 Personal 文件。
    const startPromise = this.#configRuntime.start().then(() => this.registryService.start());
    this.#startPromise = startPromise;
    // catch 只负责清理缓存，必须吞掉 rejection，否则会多出一条 unhandled rejection。
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

// [资源] 顺序固定：先摘监听，再停视图/Registry，最后释放注入资源与 Config。
// Config 必须最后释放，因为前面的 dispose 可能仍在读它的快照。
// [并发] 重复 dispose 直接返回，保证窗口销毁与进程退出两条关闭路径不会二次释放。
// [失败路径] 任一 dispose 抛错会中断后续清理，因此各实现必须自行吞掉清理错误。
// 先置 #disposed 再释放：晚到的异步回调可以通过该标志提前退出。
  dispose(): void {
    if (this.#disposed) return;
    // 先置标志再释放：晚到的异步回调读到 true 会提前退出，不会碰已释放的服务。
    this.#disposed = true;
    // 先摘 Built-in 检查监听，避免释放过程中再触发一次账号 refresh。
    this.#disposeBuiltinRecovery();
    this.#modelSelectionRuntime.dispose();
    this.registryService.dispose();
    this.#disposeAccountSource?.();
    this.#disposeModelSelectionConfiguredDefaultSource?.();
    // Config 最后释放：前面的 dispose 仍可能读它的快照。
    this.#configRuntime.dispose();
  }
}

// [事务] 写操作直接转发 configService，Registry 的 refresh 由调用方显式触发，
// 避免「写完自动刷新」与批量写互相打断，因此 Registry.refresh 只能由调用方在批次结束后调用。
// 参数逐项转发给 configService 而非透传对象，让类型系统在每个入口校验签名。
function createSettingsMutationTarget(
  configRuntime: ProviderConfigRuntime,
  registryService: ProviderRegistryService,
  accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot>,
): ProviderSettingsMutationTarget {
  // configService 先取一次引用，后续方法全部绑定到同一实例，避免中途被替换后写错对象。
  const configService = configRuntime.configService;
  return {
    // 个人 Provider 的写操作全部直转 configService；Registry 的 refresh 留给显式调用，避免写完自动刷新互相打断。
    createPersonalProvider: (input) => configService.createPersonalProvider(input),
    savePersonalProviderOverlay: (providerId, config, membership, metadata) =>
      configService.savePersonalProviderOverlay(providerId, config, membership, metadata),
    deletePersonalProvider: (providerId) => configService.deletePersonalProvider(providerId),
    reorderPersonalProviders: (providerIds) => configService.reorderPersonalProviders(providerIds),
    reorderPersonalModels: (providerId, modelIds, membership) =>
      configService.reorderPersonalModels(providerId, modelIds, membership),
    // 手工四参数转发曾丢掉新增的配置模式；直接绑定完整签名，避免装配层截断写入意图。
    addPersonalModel: configService.addPersonalModel.bind(configService),
    renamePersonalModel: (providerId, currentModelId, nextModelId, membership) =>
      configService.renamePersonalModel(providerId, currentModelId, nextModelId, membership),
    // 删除模型必须带 membership：跨成员空间的 id 不能被当作本空间操作。
    deletePersonalModel: (providerId, modelId, membership) =>
      configService.deletePersonalModel(providerId, modelId, membership),
    setPersonalModelEnabled: (providerId, modelId, enabled, membership) =>
      configService.setPersonalModelEnabled(providerId, modelId, enabled, membership),
    // 草稿保存要带 expectedPersonalRevision 做乐观并发，漏传就无法发现覆盖写。
    savePersonalModelDraft: (
      providerId,
      originalModelId,
      nextModelId,
      config,
      expectedPersonalRevision,
      useRecommendedConfig,
      membership,
    ) =>
      configService.savePersonalModelDraft(
        providerId,
        originalModelId,
        nextModelId,
        config,
        expectedPersonalRevision,
        useRecommendedConfig,
        membership,
      ),
    // refresh 单独暴露：批量写完成后由调用方触发一次，不在每个写方法里各自刷新。
    refresh: (reason) => registryService.refresh(reason),
// [事务] Built-in 远端更新与账号刷新并行，最后用一次 registryService.refresh 提交新快照。
// [失败路径] Built-in 失败只降级为 warn：远端不可达不应阻断本地配置；
// 但账号失败必须抛出，否则套餐切换会在没有权益的情况下被判成功。
    refreshSources: async (reason) => {
      // 用 allSettled 而不是 all：远端失败不能连累账号刷新的结果判定。
      const [builtinResult, accountResult] = await Promise.allSettled([
        configRuntime.refreshZCodeBuiltin({ force: true }),
        accountSource.refresh?.(reason) ?? Promise.resolve(),
      ]);
      // 远端更新失败不代表本地配置不可用；此前统一抛错会让套餐切换回滚，
      // 并掩盖真正的账号失败。只降级远端更新，Config/Registry 和权益错误仍保留。
      // 远端失败只降级为 warn：阻断本地配置会让离线用户连已有 Provider 都用不了。
      if (builtinResult.status === "rejected") {
        log.warn(undefined, "Builtin 远端更新失败，继续使用本地配置", {
          reason,
          error: builtinResult.reason,
        });
      }
      const snapshot = await registryService.refresh(reason);
      // 账号失败放在 refresh 之后再抛：先提交本地快照再让调用方回滚，比留下不一致状态安全。
      if (accountResult.status === "rejected") throw accountResult.reason;
      return snapshot;
    },
  };
}

// 组合根：从平铺选项构造 ConfigRuntime，并建立 ModelSelection 的 configured-default 仓库。
// 只有这里会创建 NodeModelSelectionConfigRepository，其它入口必须走 FromConfigRuntime。
// [资源] 该仓库的生命周期跟随本 Runtime，dispose 回调一并下传。
export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  const { accountSource, testConnectivity, ...configRuntimeOptions } = options;
  // 先构造 ConfigRuntime；accountSource 等扁平字段已被剥离，不会传进 Config 层。
  const configRuntime = createProviderConfigRuntime(configRuntimeOptions);
  // 该仓库依赖 ConfigRuntime 的 personalRepository，必须在它之后创建。
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: configRuntime.personalRepository,
  });
  // 统一走 FromConfigRuntime 装配，避免两条构造路径产生行为差异。
  return createProviderRuntimeFromConfigRuntime({
    configRuntime,
    accountSource,
    testConnectivity,
    modelSelectionConfiguredDefaultSource,
    // 释放闭包持有仓库实例；Runtime dispose 后仓库才真正断开监听。
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
  });
}

// 供测试与已持有 ConfigRuntime 的调用方使用：不接管其创建，但接管其释放。
export function createProviderRuntimeFromConfigRuntime(
  dependencies: ProviderRuntimeDependencies,
): ProviderRuntime {
  return new ProviderRuntime(dependencies);
}
