// INV-01：两个 Facade 服务只做「装配 + 前置检查」，不复制 Provider 包的解析逻辑；
// 视图、可用性、模型解析的唯一事实源是 ProviderSettingsFacade 与 ProviderConfigSnapshot。
// INV-02：所有方法先 await ensureReady()，调用方无需了解 Registry 是否已启动。
// INV-03：testModelConnectivity 以「已发布 + 已启用 + 可执行」三重门判定，
// 既不把未发布误报成配置丢失，也不绕过目标 Environment 的最终校验。
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  type ModelConfigObject,
  type ModelId,
  type ModelSelection,
  type ModelSelectionFacade,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderConfigObject,
  type ProviderId,
  type ProviderSettingsFacade,
  type ProviderSettingsCreationResult,
  type ModelConfigResolution,
  type ProviderSettingsView,
  type ResolveModelConfigInput,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { createServiceDescriptor } from "../descriptors.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

// 重新导出视图类型，让 UI 只依赖 Services 的公开入口，不直接引 @zcode/provider 内部模块。
export type {
  ProviderSettingsProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderSettingsView,
} from "@zcode/provider";

// 该接口是 RPC/UI 的稳定契约，参数一律使用领域类型（ProviderId/ModelId）。
// 具体实现由 ProviderSettingsFacade 提供，本层只补启动前置与能力探测。
// 方法顺序与设置页的写操作顺序一致，便于对照 UI 行为排查。
// 连通性测试单独标注：它是唯一会真正发起模型请求的方法。
export interface IProviderSettingsService {
  readonly onDidChange: Event<ProviderSettingsView>;
  getView(): Promise<ProviderSettingsView>;
  refresh(reason: string): Promise<ProviderSettingsView>;
  createPersonalProvider(
    input?: Parameters<ProviderSettingsFacade["createPersonalProvider"]>[0],
  ): Promise<ProviderSettingsCreationResult>;
  resolveModelConfig(input: ResolveModelConfigInput): Promise<ModelConfigResolution>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Parameters<ProviderSettingsFacade["savePersonalProviderOverlay"]>[2],
  ): Promise<ProviderSettingsView>;
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView>;
  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView>;
  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView>;
  /** 测试已经保存并进入目标 Environment Registry 的正式 Model。 */
  testModelConnectivity(
    input: ProviderSettingsConnectivityRequest,
  ): Promise<ModelConnectivityResult>;
}

// 频道常量与接口同名：Host 注册与客户端解析都依赖这一处，不得在别处复制字符串。
export const IProviderSettingsService = createServiceDescriptor<IProviderSettingsService>(
  ServiceChannels.ProviderSettings,
);

// 两个形状相同的接口保持分离：Request 是 RPC 入参（可跨进程），TestInput 是内部调用参数，
// 后续任一侧加字段都不会意外改变线上协议。
export interface ProviderSettingsConnectivityTestInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

// 与 TestInput 同形但独立声明：RPC 入参演进不应被动改变内部调用方，反之亦然。
export interface ProviderSettingsConnectivityRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

// 返回 ModelConnectivityResult 而不是抛错，便于 UI 直接渲染失败原因。
export type ProviderSettingsConnectivityTester = (
  input: ProviderSettingsConnectivityTestInput,
) => Promise<ModelConnectivityResult>;

// 只读接口：模型选择由 ProviderSettingsFacade 写入，本服务不暴露 setter，避免两条写入路径。
export interface IModelSelectionService {
// 变化事件携带完整视图而非 patch：UI 侧无需重放增量，避免漏更新累积成状态漂移。
// 订阅者拿到的 revision 单调递增，可据此丢弃乱序到达的旧视图。
  readonly onDidChange: Event<ModelSelectionView>;
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

// configuredDefault 代表「配置里的默认选择」，与运行时当前选择分离；
// 读取失败由实现方降级为 undefined，本层不做兜底。
export interface ModelSelectionConfiguredDefaultSource {
  read(): Promise<ModelSelection | undefined>;
  onDidChange?(listener: () => void): () => void;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);

// 把 Facade 包装成 RPC 服务：每个方法都先 ensureReady 再委托，
// 使 ProviderRuntime 的启动时序对调用方完全透明。
// [权衡] 逐方法手写转发而不是 Proxy 动态代理：类型安全且可被静态检查工具识别。
// testConnectivity 可选：未装配能力的 Environment 应显式拒绝，而不是静默成功。
// 这里不缓存视图，每次调用现场取，避免与 Registry 的事件顺序竞争。
export function createProviderSettingsService(
  facade: ProviderSettingsFacade,
  ensureReady: () => Promise<void> = async () => {},
  testConnectivity?: ProviderSettingsConnectivityTester,
): IProviderSettingsService {
  return {
// Facade 的订阅返回退订函数，对外统一成 Event（返回 { dispose }），UI 只处理一种取消形态。
    onDidChange: toEvent((listener) => facade.onDidChange(listener)),
// getView 不推进 revision：读视图是纯查询，不应改变广播节奏。
    getView: async () => {
      await ensureReady();
      return facade.getView();
    },
// reason 会透传到 Registry，用于日志归因（例如 settings-refresh / builtin-recovery）。
    refresh: async (reason) => {
      await ensureReady();
      return facade.refresh(reason);
    },
    createPersonalProvider: async (input) => {
      await ensureReady();
      return facade.createPersonalProvider(input);
    },
// 解析结果含最终 headers/endpoint，UI 用它展示「这次请求实际会用哪套配置」。
    resolveModelConfig: async (input) => {
      await ensureReady();
      return facade.resolveModelConfig(input);
    },
    savePersonalProviderOverlay: async (providerId, config, metadata) => {
      await ensureReady();
      return facade.savePersonalProviderOverlay(providerId, config, metadata);
    },
    deletePersonalProvider: async (providerId) => {
      await ensureReady();
      return facade.deletePersonalProvider(providerId);
    },
    reorderPersonalProviders: async (providerIds) => {
      await ensureReady();
      return facade.reorderPersonalProviders(providerIds);
    },
    reorderPersonalModels: async (providerId, modelIds) => {
      await ensureReady();
      return facade.reorderPersonalModels(providerId, modelIds);
    },
    addPersonalModel: async (providerId, modelId, config, useRecommendedConfig) => {
      await ensureReady();
      return facade.addPersonalModel(providerId, modelId, config, useRecommendedConfig);
    },
    renamePersonalModel: async (providerId, currentModelId, nextModelId) => {
      await ensureReady();
      return facade.renamePersonalModel(providerId, currentModelId, nextModelId);
    },
    deletePersonalModel: async (providerId, modelId) => {
      await ensureReady();
      return facade.deletePersonalModel(providerId, modelId);
    },
// 草稿保存是唯一带 expectedPersonalRevision 的写操作，乐观并发由 configService 校验。
    savePersonalModelDraft: async (input) => {
      await ensureReady();
      return facade.savePersonalModelDraft(input);
    },
// 启停只影响可见性与可用性、不删除配置，因此走独立方法而不是 overlay 全量保存。
    setPersonalModelEnabled: async (providerId, modelId, enabled) => {
      await ensureReady();
      return facade.setPersonalModelEnabled(providerId, modelId, enabled);
    },
// [事务] 先 waitForProviderOperations：用户刚保存的修改可能仍在写盘/刷新中，
// 不等待就会用旧快照判定可用性。
// 三重门顺序（provider → model → executable）保证错误码稳定：
// 先判存在与开关，再判派生执行资格，避免把 disabled 报成 executable=false。
// 只读公共资格，不查 Key、不查权益：那是 Registry 的职责，重复实现会漂移。
    testModelConnectivity: async (input) => {
      await ensureReady();
// [失败路径] 未装配测试能力时抛错而非返回 success=false：这是装配错误，不是用户可修复状态。
      if (!testConnectivity) {
        throw new Error("当前 Environment 未装配模型连通性测试能力");
      }
      await facade.waitForProviderOperations(input.providerId);
      // 禁用对象仍存在于配置视图，但不进入执行 Registry；不能把未发布误报成配置丢失。
      // 只消费操作完成后的公共资格，不另查 Key、权益，也不替代目标 Environment 最终校验。
// 用一次 getView 的结果判 provider 与 model，保证两者出自同一快照，
// 不会出现 provider 来自新版本、model 来自旧版本的撕裂判定。
      const provider = facade
        .getView()
        .providers.find((item) => item.providerId === input.providerId);
// 在同一个 provider 视图里找 model：跨 provider 搜索会把同名模型误判成可测试。
      const model = provider?.models.find((item) => item.modelId === input.modelId);
// issues 非空说明模型配置有阻塞问题（例如缺少必填项），即使 executable 也不能测试。
// 嵌套三元而不是 if 链：四个判定是同一优先级的降级映射，表达式可直接得到错误码。
// [权衡] 只返回两个稳定错误码，不透出内部 issue 文本，避免 UI 依赖会变的诊断措辞。
      const unavailable =
        !provider || !provider.enabled
          ? "provider-unavailable"
          : !model || !model.enabled || model.issues.length > 0
            ? "model-unavailable"
            : !provider.executable
              ? "provider-unavailable"
              : !model.executable
                ? "model-unavailable"
                : undefined;
// 失败结果带 code 供 UI 分类展示；message 是固定英文文案，不参与本地化判断。
      if (unavailable) {
        return {
          success: false,
          error: {
            code: unavailable,
            message:
              unavailable === "provider-unavailable"
                ? "This provider is currently unavailable for connectivity testing."
                : "This model is currently unavailable for connectivity testing.",
          },
        };
      }
// 通过三门后原样转发 workspaceIdentity（存在时），让远端执行链能定位同一 workspace。
      return testConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        providerId: input.providerId,
        modelId: input.modelId,
      });
    },
  };
}

// ModelSelection 视图带 revision：只有 revision 前进时才重新广播，
// 防止 Registry 的重复事件把同一份视图推给 UI 多次。
// 服务自维护 revision 而非完全依赖 facade，是为了在 configuredDefault 变化时也能推进。
// dispose 是明确的取消边界：Host 关闭后不允许再读取已释放的仓库。
export function createModelSelectionService(
  facade: ModelSelectionFacade,
  ensureReady: () => Promise<void> = async () => {},
  configuredDefaultSource?: ModelSelectionConfiguredDefaultSource,
): IModelSelectionService & { dispose(): void } {
  const log = createServiceLogger("model-selection");
  let revision = 0;
  let disposed = false;
// 用 Set 而非数组：同一监听重复注册只保留一份，退订是幂等的 delete。
  const listeners = new Set<(view: ModelSelectionView) => void>();
// ensureReady → 读 configuredDefault → 取视图：三步都可能被 dispose 打断，
// 因此中间要重新判活，而不是只在入口判一次。
// revision 只前进不回退：facade 返回更旧的 revision 时不覆盖本地值。
  const getView = async (input?: ModelSelectionViewInput): Promise<ModelSelectionView> => {
    await ensureReady();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
// configuredDefault 读取失败按 undefined 处理：配置默认值只是偏好，
// 缺失时应回落到 Registry 的现有选择，而不是让整个视图读取失败。
    const configuredDefault = await configuredDefaultSource?.read();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
// 先取一次基准视图同步 revision 上界，再用同一 revision 取带 input 的视图，
// 避免两次调用之间 revision 被事件推进而返回过期视图。
    const base = facade.getView(configuredDefault);
    if (revision < base.revision) revision = base.revision;
    return facade.getView(configuredDefault, revision, input);
  };
// revision += 1 先于异步重建：等待期间到达的新事件会让重建带上更大的 revision，
// 从而在结果上互相覆盖而不是回退。
// [失败路径] 重建失败只记 warn：视图刷新失败不应打断 Provider 写入的成功语义。
// 每个 listener 单独调用、不做 try/catch：订阅方异常属于编程错误，应暴露出来。
  const emit = (): void => {
    if (disposed) return;
// 递增在异步重建之前：即使重建失败，下一次成功广播也不会复用旧 revision。
    revision += 1;
    void getView().then(
      (view) => {
        if (disposed) return;
        for (const listener of listeners) listener(view);
      },
      (error: unknown) => {
        // Registry 事件触发的异步 View 重建没有 owner；Host dispose 后它仍会继续
        // 读取已释放的配置仓库，并形成未处理 rejection。dispose 是明确的取消边界；仅在服务
        // 仍存活时记录真实读取失败。
        if (disposed) return;
        log.warn(undefined, `ModelSelection View 刷新失败: ${String(error)}`);
      },
    );
  };
// 订阅在创建时就登记退订函数，dispose 时统一调用，确保不会遗漏。
  const disposeFacade = facade.onDidChange(emit);
// configuredDefaultSource 的订阅是可选能力（onDidChange 为可选方法），
// 未实现时结果是 undefined，不能假设一定有退订函数。
  const disposeConfiguredDefault = configuredDefaultSource?.onDidChange?.(emit);

  return {
// 对外返回 Event 形态；内部仍保留 Set，便于一次性广播给所有订阅者。
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
// 直接暴露内部 getView：它已包含 ensureReady 与判活，无需再包一层。
    getView,
// [资源] 先置 disposed 再退订：退订期间可能触发同步回调，回调需看到已失效标记直接返回。
// listeners.clear() 之后不再持有任何外部引用，满足 GC 预期。
// 重复 dispose 直接返回，允许上层存在多条关闭路径。
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeFacade();
      disposeConfiguredDefault?.();
      listeners.clear();
    },
  };
}

// 统一适配函数：把「返回退订函数」的订阅风格转成 RPC Event 的 { dispose } 形态。
function toEvent<T>(subscribe: (listener: (event: T) => void) => () => void): Event<T> {
  return (listener) => {
    const dispose = subscribe(listener);
    return { dispose };
  };
}
