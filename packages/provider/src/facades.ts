/* oxlint-disable eslint(max-lines) -- Settings/Selection Facade 共享同一套 Registry 投影与写入边界。 */
// 做：把 Provider Registry 快照投影成设置视图与模型选择视图，并串行化配置写入。
// 不做：不直接读写持久层、不解析模板、不缓存视图；所有事实都来自传入的快照。
// 依赖：ProviderRegistryService 的 snapshot/view/refresh、config-service 的写目标与成员快照。
// 边界：写操作必须携带 revision 与 membership，冲突只能抛错，不能就地合并或重试。
//
// 不变量（INV）：
// INV-01 断言：所有写操作只能经由 #mutations 执行，不能直接改 snapshot —— 守住它的位置：#mutate 与 #mutateWithResult —— 改错故障：UI 看到成功但持久层未变。
// INV-02 断言：写后必须 refresh 再生成 view —— 守住它的位置：各 mutate 的尾部 —— 改错故障：返回写前快照，界面回退。
// INV-03 断言：同一 provider 的写操作必须串行 —— 守住它的位置：#providerMutationTails —— 改错故障：重命名与删除交错，落到不存在的 model。
// INV-04 断言：队列必须处理前一个 promise 的 rejection —— 守住它的位置：#mutateProvider 的 previous.catch —— 改错故障：一次失败后该 provider 的后续写永久失败。
// INV-05 断言：队列项必须在完成且仍是队尾时清理 —— 守住它的位置：cleanup 的引用比较 —— 改错故障：Map 无限增长，或误删新队尾。
// INV-06 断言：waitForProviderOperations 必须等待当前队尾 —— 守住它的位置：直接 await Map 中的值 —— 改错故障：调用方在写完成前读到旧视图。
// INV-07 断言：savePersonalModelDraft 必须在写前比对 revision —— 守住它的位置：basedOnRevision 校验 —— 改错故障：覆盖其它窗口的并发编辑。
// INV-08 断言：personalRevision 必须取自同一份 snapshot —— 守住它的位置：#modelMembership 与 draft 调用 —— 改错故障：成员校验用旧 revision，写入被误拒或误放。
// INV-09 断言：assertCurrent 必须在同一 snapshot 身份下通过 —— 守住它的位置：#modelMembership 返回的闭包 —— 改错故障：跨快照的成员写入被静默接受。
// INV-10 断言：配置成员名单不能与可执行模型名单混用 —— 守住它的位置：#modelMembership 的 inheritedModelIds —— 改错故障：禁用或无权益的模型无法编辑。
// INV-11 断言：Account 名单必须原样使用，不能与内置模型取并集 —— 守住它的位置：同一处实现 —— 改错故障：无权益模型被当成继承模型。
// INV-12 断言：resolveModelConfig 必须区分继承配置与生效配置 —— 守住它的位置：两个返回字段 —— 改错故障：表单把继承值当成用户可编辑值。
// INV-13 断言：改名预览必须先 renameExactModel 再 setExact —— 守住它的位置：originalModelId 分支 —— 改错故障：改名后继承链断裂。
// INV-14 断言：预览固定模式必须显式清掉推荐标记 —— 守住它的位置：setExact 的第四个参数 —— 改错故障：重新开启智能配置仍沿用旧固定配置。
// INV-15 断言：getView 必须先 requireSnapshot —— 守住它的位置：getView 与 resolveModelConfig —— 改错故障：start 之前读取出现空指针或半初始化视图。
// INV-16 断言：ModelSelectionFacade 只在传入 input 时才要求快照 —— 守住它的位置：getView 的三元判断 —— 改错故障：仅查询默认偏好时因未 start 抛错。
// INV-17 断言：默认偏好归一化只改档位，不改账号身份或保存配置 —— 守住它的位置：normalizedDefault —— 改错故障：打开设置即写回用户配置。
// INV-18 断言：hidden provider 必须从设置与选择视图中过滤 —— 守住它的位置：两处 visibility 过滤 —— 改错故障：内部 provider 暴露给用户。
// INV-19 断言：executable 只由 registryProviders 决定 —— 守住它的位置：createProviderSettingsView 的 Set —— 改错故障：未进入 Registry 的 provider 被允许选择模型。
//
import type { ConfigValidationIssue } from "./config-overlay.js";
import type { ProviderModelMembership } from "./config-service.js";
import type {
  ModelConfig,
  ModelConfigObject,
  ModelId,
  ProviderConfig,
  ProviderConfigObject,
  ProviderId,
  ProviderTemplateId,
} from "./config/index.js";
import {
  ModelConfigRules,
  ProviderTemplateMap,
  type ProviderConfigRule,
  type ProviderTemplateNameMap,
  type ProviderTemplateLocale,
  parseModelConfig,
  parseProviderConfig,
} from "./config/index.js";
import type { ProviderRegistryView } from "./registry.js";
import {
  serializeRegistryModelConfig,
  serializeRegistryProviderConfig,
  type ProviderConfigResolution,
  type RegistryModelConfigObject,
} from "./resolver.js";
import { resolveInitialModelSelection } from "./model-selection-config.js";
import {
  resolveEffectiveModelSelection,
  type EffectiveModelSelectionResult,
  type ModelSelectionProviderClassifier,
} from "./effective-model-selection.js";
import type { ModelSelection } from "./registry.js";
import type {
  ProviderRegistryServiceChangedEvent,
  ProviderRegistryServiceSnapshot,
} from "./registry-service.js";

// [契约] Facade 只依赖这五个能力，便于测试替身与不同 Registry 实现复用。
// [契约] getSnapshot 可能返回 null，调用方必须经 requireSnapshot 统一处理。
// [失败路径] 把 refresh 与 onDidChange 合并会丢失变更通知语义。
// [权衡] 不在接口上暴露内部 service，避免 Facade 与实现细节耦合。
export interface ProviderRegistryFacadeSource {
  getSnapshot(): ProviderRegistryServiceSnapshot | null;
  getView(): ProviderRegistryView;
  refresh(reason: string): Promise<ProviderRegistryServiceSnapshot>;
  onDidChange(listener: (event: ProviderRegistryServiceChangedEvent) => void): () => void;
}

// [契约] 这是 Facade 允许触达的全部写操作面，新增能力必须先加在这里。
// [契约] 每个方法都接收 membership 或 metadata，写操作必须携带当前配置快照。
// [失败路径] 直接调用 config-service 会绕过 revision 与成员校验。
// [权衡] 方法较多但保持扁平，避免为单个操作引入命令对象。
// [资源] refreshSources 可选：没有上游事实的服务只需 refresh。
export interface ProviderSettingsMutationTarget {
  createPersonalProvider(input?: {
    readonly templateId?: ProviderTemplateId;
    readonly providerName?: string;
    readonly locale?: ProviderTemplateLocale;
    readonly initialConfig?: ProviderConfig;
  }): Promise<{ readonly providerId: ProviderId }>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfig,
    membership?: ProviderModelMembership,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<unknown>;
  deletePersonalProvider(providerId: ProviderId): Promise<unknown>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<unknown>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfig,
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<unknown>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  deletePersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  savePersonalModelDraft(
    providerId: ProviderId,
    originalModelId: ModelId,
    nextModelId: ModelId,
    config: ModelConfig,
    expectedPersonalRevision: string,
    useRecommendedConfig?: boolean,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
    membership?: ProviderModelMembership,
  ): Promise<unknown>;
  refresh(reason: string): Promise<ProviderRegistryServiceSnapshot>;
  /** 主动重读上游事实后再刷新 Registry。 */
  refreshSources?(reason: string): Promise<ProviderRegistryServiceSnapshot>;
}

// [契约] candidate 同时给出继承配置与个人配置，UI 据此区分继承值与被覆盖值。
// [契约] enabled、executable、selectable 是三个独立事实，不能互相推导。
// [失败路径] 用 enabled 代替 executable 会让禁用但可配置的模型从选择器消失。
// [权衡] issues 直接透传校验问题，Facade 不再二次解释。
export interface ProviderSettingsModelCandidateView {
  readonly kind: "candidate";
  readonly modelId: ModelId;
  readonly builtin: boolean;
  readonly effectiveBuiltinConfig: ModelConfigObject;
  readonly personalExactConfig?: ModelConfigObject;
  readonly useRecommendedConfig?: boolean;
  readonly effectiveConfig: RegistryModelConfigObject | ModelConfigObject;
  readonly enabled: boolean;
  readonly executable: boolean;
  readonly selectable: boolean;
  readonly issues: readonly ConfigValidationIssue[];
}

export type ProviderSettingsModelView = ProviderSettingsModelCandidateView;

// [契约] inheritedConfig 是模板与内置规则的结果，不含个人覆盖。
// [契约] effectiveConfig 是合并后的最终值，用于预览与保存。
// [失败路径] 两个字段取同一份值会让 UI 无法提示继承来源。
// [权衡] issues 只描述完整性，不描述可执行性。
export interface ModelConfigResolution {
  readonly inheritedConfig: ModelConfigObject;
  readonly effectiveConfig: ModelConfigObject;
  readonly issues: readonly ConfigValidationIssue[];
}

// [契约] 两种输入形态：已有模型直接解析，草稿则带 originalModelId 与个人配置。
// [契约] 改名场景必须提供 originalModelId，否则继承链无法迁移。
// [失败路径] 用 modelId 同时表达原名与新名会让 renameExactModel 找不到源。
// [权衡] 用联合类型而不是可选字段，保证调用方两选一。
export type ResolveModelConfigInput =
  | {
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly providerId: ProviderId;
      readonly originalModelId: ModelId;
      readonly modelId: ModelId;
      readonly personalConfig: ModelConfigObject;
    };

// [契约] basedOnRevision 是乐观并发控制的唯一依据，必须来自打开表单时的视图。
// [契约] personalConfig 是完整对象，不允许只传差量。
// [失败路径] 缺少 useRecommendedConfig 会让智能配置草稿丢失来源标记。
// [权衡] nextModelId 与 originalModelId 分开，支持保存时改名。
export interface SavePersonalModelDraftInput {
  readonly providerId: ProviderId;
  readonly originalModelId: ModelId;
  readonly nextModelId: ModelId;
  readonly personalConfig: ModelConfigObject;
  readonly useRecommendedConfig?: boolean;
  readonly basedOnRevision: number;
}

// [契约] 同时暴露内置模板配置与个人覆盖配置，UI 不需要再查 config-service。
// [契约] executable 表示已进入 Registry，可直接用于模型选择与创建。
// [失败路径] 用 issues 是否为空判断可执行，会漏掉未进入 Registry 的情况。
// [权衡] accountState 可选：未接入账号的 provider 不伪造状态。
export interface ProviderSettingsProviderView extends Pick<
  ProviderConfigRule,
  "providerName" | "templateId"
> {
  readonly enabled: boolean;
  readonly accountState?: import("./account-provider-state.js").AccountProviderState;
  readonly providerId: ProviderId;
  /** 当前 Effective Config 是否已经进入 Registry，可用于模型选择和创建。 */
  readonly executable: boolean;
  readonly effectiveBuiltinConfig?: ProviderConfigObject;
  readonly personalConfig?: ProviderConfigObject;
  readonly effectiveConfig: ProviderConfigObject;
  readonly issues: readonly ConfigValidationIssue[];
  readonly models: readonly ProviderSettingsModelView[];
}

// [契约] templateNameMap 原样透传，本地化由 UI 选择，不在 Facade 里做 locale 决策。
// [契约] config 是模板默认配置，不含任何个人覆盖。
// [失败路径] 在这里合并个人配置会让新建 provider 继承无关字段。
export interface ProviderSettingsTemplateView {
  readonly templateId: ProviderTemplateId;
  readonly templateNameMap: ProviderTemplateNameMap;
  readonly config: ProviderConfigObject;
}

// [契约] providerOrder 只包含可排序的标准个人 provider，内置项不参与排序。
// [契约] revision 来自 registry，用于 UI 判断视图是否过期。
// [失败路径] 漏掉 providerOrder 会让拖拽排序在刷新后回到旧顺序。
export interface ProviderSettingsView {
  readonly revision: number;
  readonly providerTemplates: readonly ProviderSettingsTemplateView[];
  readonly providerOrder: readonly ProviderId[];
  readonly providers: readonly ProviderSettingsProviderView[];
}

// [契约] 返回新建 id 与写后视图，调用方不需要再查一次。
// [失败路径] 只返回 id 会让 UI 在刷新前读到旧列表。
// [契约] view 与 getView 的结果等价，二者口径必须一致。
export interface ProviderSettingsCreationResult {
  readonly providerId: ProviderId;
  readonly view: ProviderSettingsView;
}

// [契约] 选择视图只需要 modelId 与序列化后的 config。
// [失败路径] 携带可执行性或 issues 会让选择器承担设置页的职责。
// [契约] 模型顺序沿用 Registry 顺序，不在投影层重排。
export interface ModelSelectionModelView {
  readonly modelId: ModelId;
  readonly config: RegistryModelConfigObject;
}

export interface ModelSelectionProviderView extends Pick<
  ProviderConfigRule,
  "providerName" | "templateId"
> {
  readonly providerId: ProviderId;
  readonly config: ProviderConfigObject;
  readonly models: readonly ModelSelectionModelView[];
}

export interface ModelSelectionViewInput {
  readonly selection: ModelSelection | null;
}

// [契约] 继承 EffectiveModelSelectionResult 的可选字段，只在传入 input 时填充。
// [契约] preferredSelection 只有在能解析出有效选择时才出现。
// [失败路径] 无选择时伪造 preferredSelection 会让 UI 自动选中错误模型。
export interface ModelSelectionView extends Partial<EffectiveModelSelectionResult> {
  readonly revision: number;
  readonly providers: readonly ModelSelectionProviderView[];
  readonly preferredSelection?: ModelSelection;
}

// [契约] Facade 持有 source 与可选 mutations，读操作不需要 mutations。
// [契约] #providerMutationTails 是每个 provider 的串行队列，跨 provider 可并行。
// [失败路径] 把队列做成全局串行会让无关 provider 的保存互相等待。
// [资源] 队列项在完成后删除，避免长生命周期进程里 Map 持续增长。
export class ProviderSettingsFacade {
  readonly #source: ProviderRegistryFacadeSource;
  readonly #mutations?: ProviderSettingsMutationTarget;
  readonly #providerMutationTails = new Map<ProviderId, Promise<unknown>>();

  // [契约] mutations 可选：只读场景（如仅展示）不要求配置写入目标。
  // [失败路径] 缺少 mutations 时写操作必须抛错，不能静默丢弃。
  // [契约] 构造期不做 IO，也不校验 source 是否已 start。
  constructor(source: ProviderRegistryFacadeSource, mutations?: ProviderSettingsMutationTarget) {
    this.#source = source;
    this.#mutations = mutations;
  }

  // [契约] 视图完全由 snapshot 投影，不缓存、不合并本地状态。
  // [契约] revision 取 registry.revision，而不是 config 的 personalRevision。
  // [失败路径] 用错 revision 会让 UI 的冲突检测失效。
  // [权衡] 每次调用都重建视图，换来与快照严格一致。
  getView(): ProviderSettingsView {
    const snapshot = requireSnapshot(this.#source);
    return createProviderSettingsView({
      revision: snapshot.registry.revision,
      zcodeBuiltinProviders: snapshot.config.zcodeBuiltinProviders,
      zcodeBuiltinProviderTemplates: snapshot.config.zcodeBuiltinProviderTemplates,
      personalProviders: snapshot.config.personalProviders,
      personalModels: snapshot.config.personalModels,
      resolution: snapshot.resolution,
      accountStates: snapshot.account.states,
    });
  }

  // [契约] 有 refreshSources 时优先主动重读上游事实，再回到视图。
  // [契约] 没有该能力时退化为普通 refresh，语义仍是先刷新后读。
  // [失败路径] 刷新失败必须向上抛，不能返回旧视图假装成功。
  // [契约] reason 加 settings: 前缀用于区分触发来源，便于日志聚合。
  async refresh(reason: string): Promise<ProviderSettingsView> {
    if (this.#mutations?.refreshSources) {
      await this.#mutations.refreshSources(`settings:${reason}`);
    } else {
      await this.#source.refresh(reason);
    }
    return this.getView();
  }

  // [契约] 预览不做持久化，也不校验 revision。
  // [契约] 无 personalConfig 时只合并内置规则与个人模型规则。
  // [失败路径] 这里抛错会让表单无法展示错误，因此改用 issues 返回。
  // [权衡] 返回冻结对象，防止调用方修改后污染后续解析。
  // [契约] provider 不存在时 requireEffectiveProvider 抛错，属于调用方错误。
  resolveModelConfig(input: ResolveModelConfigInput): ModelConfigResolution {
    const snapshot = requireSnapshot(this.#source);
    const provider = requireEffectiveProvider(snapshot, input.providerId);
    if (!("personalConfig" in input)) {
      const modelRules = ModelConfigRules.composeEffective(
        snapshot.config.zcodeBuiltinModelRules,
        snapshot.config.personalModels,
      );
      const config = modelRules.resolve({
        providerId: input.providerId,
        templateId: provider.templateId,
        modelId: input.modelId,
        apiType: provider.config.api?.type,
        baseUrl: provider.config.api?.baseUrl,
      });
      return Object.freeze({
        inheritedConfig: config.toJSON(),
        effectiveConfig: config.toJSON(),
        issues: Object.freeze([
          ...config.validateComplete(["providers", input.providerId, "models", input.modelId]),
        ]),
      });
    }

    // [契约] 输入必须是 JSON 形态，先 parse 再参与规则合并。
    // [失败路径] parse 抛错直接终止预览，由调用方提示字段非法。
    // [契约] 草稿解析不改写 snapshot，只在本地构造临时规则。
    // [权衡] 解析一次而非每次 resolve 都解析，避免重复校验。
    const personalConfig = parseModelConfig(input.personalConfig);
    const inheritedConfig = snapshot.config.zcodeBuiltinModelRules.resolve({
      providerId: input.providerId,
      templateId: provider.templateId,
      modelId: input.modelId,
      apiType: provider.config.api?.type,
      baseUrl: provider.config.api?.baseUrl,
    });
    let personalRules = snapshot.config.personalModels;
    if (input.originalModelId !== input.modelId) {
      personalRules = personalRules.renameExactModel(
        input.providerId,
        input.originalModelId,
        input.modelId,
      );
    }
    // 此入口预览智能配置草稿；固定模式不请求推荐，重新开启时不能沿用旧固定标记。
    // [契约] 预览智能配置时传 true，表示仍处于推荐模式。
    // [契约] 固定模式必须显式传 false 或先清标记，不能沿用旧值。
    // [失败路径] 漏传会使用户重新开启智能配置后仍得到固定配置。
    personalRules = personalRules.setExact(input.providerId, input.modelId, personalConfig, true);
    const config = ModelConfigRules.composeEffective(
      snapshot.config.zcodeBuiltinModelRules,
      personalRules,
    ).resolve({
      providerId: input.providerId,
      templateId: provider.templateId,
      modelId: input.modelId,
      apiType: provider.config.api?.type,
      baseUrl: provider.config.api?.baseUrl,
    });
    return Object.freeze({
      inheritedConfig: inheritedConfig.toJSON(),
      effectiveConfig: config.toJSON(),
      issues: Object.freeze([
        ...config.validateComplete(["providers", input.providerId, "models", input.modelId]),
      ]),
    });
  }

  // [契约] 每次变更都重新 getView，而不是把事件负载当视图。
  // [失败路径] 事件负载可能不含完整解析结果，直接透传会读到半份数据。
  // [资源] 返回的取消函数必须原样透传，让调用方控制订阅生命周期。
  onDidChange(listener: (view: ProviderSettingsView) => void): () => void {
    return this.#source.onDidChange(() => listener(this.getView()));
  }

  // [契约] 输入先做可选字段裁剪，再交给 createPersonalProvider。
  // [契约] initialConfig 必须是完整 provider 配置，先 parse 再传。
  // [失败路径] 把 undefined 显式传给 RPC 会触发 schema 校验失败。
  // [契约] 返回结果里的 view 一定是写后刷新得到的视图。
  createPersonalProvider(input?: {
    readonly templateId?: ProviderTemplateId;
    readonly providerName?: string;
    readonly locale?: ProviderTemplateLocale;
    readonly initialConfig?: ProviderConfigObject;
  }): Promise<ProviderSettingsCreationResult> {
    return this.#mutateWithResult("create-provider", (target) =>
      target.createPersonalProvider({
        ...(input?.templateId ? { templateId: input.templateId } : {}),
        ...(input?.providerName ? { providerName: input.providerName } : {}),
        ...(input?.locale ? { locale: input.locale } : {}),
        ...(input?.initialConfig
          ? { initialConfig: parseProviderConfig(input.initialConfig) }
          : {}),
      }),
    ).then(({ result, view }) => ({ providerId: result.providerId, view }));
  }

  // [契约] 保存前先 parse 配置，并带上当前 provider 的成员快照。
  // [契约] metadata 只在需要改名或切换模板时传，不能省略 providerId。
  // [失败路径] 不带 membership 会让并发删除的模型被静默写回。
  // [契约] 写操作走 #mutateProvider，保证同一 provider 串行。
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "save-provider", (target) =>
      target.savePersonalProviderOverlay(
        providerId,
        parseProviderConfig(config),
        this.#modelMembership(providerId),
        metadata,
      ),
    );
  }

  // [契约] 删除同样走 provider 级队列，避免与保存交错。
  // [失败路径] 删除后必须刷新，不能继续返回缓存视图。
  // [契约] 删除不存在的 provider 由底层决定，Facade 不做预检。
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "delete-provider", (target) =>
      target.deletePersonalProvider(providerId),
    );
  }

  // [契约] 排序是跨 provider 操作，不进入单个 provider 的队列。
  // [失败路径] 放进 provider 队列会让排序与任意保存并发冲突。
  // [契约] 顺序由调用方给定，Facade 不做去重或补齐。
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView> {
    return this.#mutate("reorder-providers", (target) =>
      target.reorderPersonalProviders(providerIds),
    );
  }

  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "reorder-models", (target) =>
      target.reorderPersonalModels(providerId, modelIds, this.#modelMembership(providerId)),
    );
  }

  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "add-model", (target) =>
      target.addPersonalModel(
        providerId,
        modelId,
        parseModelConfig(config),
        this.#modelMembership(providerId),
        useRecommendedConfig,
      ),
    );
  }

  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "rename-model", (target) =>
      target.renamePersonalModel(
        providerId,
        currentModelId,
        nextModelId,
        this.#modelMembership(providerId),
      ),
    );
  }

  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "delete-personal-model", (target) =>
      target.deletePersonalModel(providerId, modelId, this.#modelMembership(providerId)),
    );
  }

  // [契约] 写前比对 registry.revision 与 basedOnRevision，冲突立即抛错。
  // [契约] personalRevision 取自同一 snapshot，保证成员校验与写入一致。
  // [失败路径] 只是在写后检查 revision 会让冲突写入已经落库。
  // [契约] 配置先 parse 再传，避免把 JSON 之外的形态交给服务。
  // [权衡] 冲突错误直接抛给 UI，由 UI 决定重新加载或覆盖。
  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView> {
    return this.#mutateProvider(input.providerId, "save-model-draft", async (target) => {
      const snapshot = requireSnapshot(this.#source);
      if (snapshot.registry.revision !== input.basedOnRevision) {
        throw new Error(
          `Provider Settings revision conflict: expected ${input.basedOnRevision}, current ${snapshot.registry.revision}`,
        );
      }
      const parsedConfig = parseModelConfig(input.personalConfig);
      await target.savePersonalModelDraft(
        input.providerId,
        input.originalModelId,
        input.nextModelId,
        parsedConfig,
        snapshot.config.personalRevision,
        input.useRecommendedConfig,
        this.#modelMembership(input.providerId, snapshot),
      );
    });
  }

  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView> {
    return this.#mutateProvider(providerId, "set-model-enabled", (target) =>
      target.setPersonalModelEnabled(
        providerId,
        modelId,
        enabled,
        this.#modelMembership(providerId),
      ),
    );
  }

  // [契约] 成员快照绑定当前 snapshot，assertCurrent 用对象身份判断是否过期。
  // [契约] inheritedModelIds 只取 builtin 来源，不含个人新增模型。
  // [失败路径] 把可执行名单当成员名单会让禁用模型无法编辑。
  // [契约] Account 的空名单或替换名单必须原样使用，不能与内置取并集。
  // [权衡] 冻结返回值，防止底层修改后影响 assertCurrent 的语义。
  #modelMembership(
    providerId: ProviderId,
    snapshot = requireSnapshot(this.#source),
  ): ProviderModelMembership {
    const provider = snapshot.resolution.resolvedProviders.find(
      (item) => item.providerId === providerId,
    );
    if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
    // 配置成员与可执行模型不是同一名单：禁用、无权益和不完整模型仍可编辑。
    // Account 的空/替换名单也必须原样使用，不能再与静态 Built-in 取并集。
    return Object.freeze({
      providerId,
      inheritedModelIds: Object.freeze(
        provider.models.filter((model) => model.source === "builtin").map((model) => model.modelId),
      ),
      personalRevision: snapshot.config.personalRevision,
      // [契约] 只比较 snapshot 对象身份，不做深比较：任何刷新都视为过期。
      // [失败路径] 深比较会让旧快照在字段未变时被误判为仍然有效。
      // [契约] 抛错发生在真正写入之前，保证失败时没有副作用。
      assertCurrent: () => {
        if (this.#source.getSnapshot() !== snapshot)
          throw new Error("Provider Settings snapshot revision conflict");
      },
    });
  }

  // [契约] 没有 mutations 时立即抛错，不进入任何写路径。
  // [契约] 顺序固定为写、刷新、读视图，不能并行刷新与读取。
  // [失败路径] 刷新失败时抛错，调用方不能把写当成已完成。
  // [契约] 返回值一定是刷新后的视图，不是写操作的原始结果。
  async #mutate(
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<unknown>,
  ): Promise<ProviderSettingsView> {
    if (!this.#mutations) throw new Error("ProviderSettingsFacade 未配置写入目标");
    await operation(this.#mutations);
    await this.#mutations.refresh(`settings:${reason}`);
    return this.getView();
  }

  // [契约] 每个 provider 一条串行链，前一项失败不阻断后一项。
  // [并发] waitForPrevious 吞掉前一项错误，避免一次失败毒化整条链。
  // [契约] 新任务必须排在当前队尾，不能插队。
  // [资源] cleanup 只在 #providerMutationTails 的队尾仍是当前项时才 delete，防止删掉后来者的队尾。
  // [失败路径] 队列本身不吞结果错误：调用方仍能收到本次写失败。
  #mutateProvider(
    providerId: ProviderId,
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<unknown>,
  ): Promise<ProviderSettingsView> {
    const previous = this.#providerMutationTails.get(providerId) ?? Promise.resolve();
    const waitForPrevious = previous.catch(() => undefined);
    const result = waitForPrevious.then(() => this.#mutate(reason, operation));
    this.#providerMutationTails.set(providerId, result);
    const cleanup = () => {
      if (this.#providerMutationTails.get(providerId) === result) {
        this.#providerMutationTails.delete(providerId);
      }
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  // [契约] waitForProviderOperations 只 await 当前队尾 Promise，不阻塞后续 #mutateProvider 入队。
  // [失败路径] provider 没有队列时立即返回，不抛错。
  // [权衡] 不返回视图：调用方需要视图时自行 getView。
  async waitForProviderOperations(providerId: ProviderId): Promise<void> {
    await this.#providerMutationTails.get(providerId);
  }

  // [契约] 与 #mutate 的区别是保留写操作原始返回值，例如新建的 providerId。
  // [契约] 仍然保证先刷新再读视图。
  // [失败路径] 写失败时不返回部分结果，直接抛出。
  async #mutateWithResult<TResult>(
    reason: string,
    operation: (target: ProviderSettingsMutationTarget) => Promise<TResult>,
  ): Promise<{ readonly result: TResult; readonly view: ProviderSettingsView }> {
    if (!this.#mutations) throw new Error("ProviderSettingsFacade 未配置写入目标");
    const result = await operation(this.#mutations);
    await this.#mutations.refresh(`settings:${reason}`);
    return { result, view: this.getView() };
  }
}

// [契约] 选择视图与设置视图共用同一 Registry 快照来源。
// [契约] classifyProvider 由调用方注入，Facade 不内置产品分类规则。
// [失败路径] 内置分类会让不同产品线的选择语义互相污染。
// [权衡] resolveLegacyReasoningLevel 可选：旧配置需要兼容时才注入。
export class ModelSelectionFacade {
  readonly #source: ProviderRegistryFacadeSource;
  readonly #classifyProvider: ModelSelectionProviderClassifier;
  readonly #resolveLegacyReasoningLevel?: (
    snapshot: ProviderRegistryServiceSnapshot,
    selection: ModelSelection,
  ) => string | undefined;

  constructor(
    source: ProviderRegistryFacadeSource,
    classifyProvider: ModelSelectionProviderClassifier = () => "ordinary",
    resolveLegacyReasoningLevel?: (
      snapshot: ProviderRegistryServiceSnapshot,
      selection: ModelSelection,
    ) => string | undefined,
  ) {
    this.#source = source;
    this.#classifyProvider = classifyProvider;
    this.#resolveLegacyReasoningLevel = resolveLegacyReasoningLevel;
  }

  // [契约] 传入 input 时必须用 requireSnapshot，未 start 直接抛错。
  // [契约] 未传 input 时允许 getSnapshot 为 null，退化为 registry 视图。
  // [失败路径] 两种模式混用会让账号事实来自不同快照。
  // [契约] 默认偏好归一化只影响档位，不改账号身份或持久配置。
  // [权衡] 产物整体冻结，避免调用方修改后影响其它窗口。
  getView(
    configuredDefault?: ModelSelection,
    revision?: number,
    input?: ModelSelectionViewInput,
  ): ModelSelectionView {
    // 账号事实与候选从同一已应用快照读取；不把最新 Settings 配给旧 Registry。
    // [契约] 有三元判断而非总是 requireSnapshot：纯查询不应要求服务已启动。
    // [失败路径] 把 null 快照当空对象会让 accountStates 读取抛错。
    // [契约] 之后的 accountStates 必须取自同一 snapshot。
    const snapshot = input ? requireSnapshot(this.#source) : this.#source.getSnapshot();
    const registry = snapshot?.registry ?? this.#source.getView();
    const resolveLegacyReasoningLevel =
      snapshot && this.#resolveLegacyReasoningLevel
        ? (selection: ModelSelection) => this.#resolveLegacyReasoningLevel!(snapshot, selection)
        : undefined;
    // 默认偏好只归一化档位，不借此改写账号身份或保存配置。
    // [契约] 只在有旧配置解析器时归一化，否则原样透传。
    // [契约] 归一化使用 ordinary 分类，不借用产品级 classifyProvider。
    // [失败路径] 归一化结果写回配置会造成隐式迁移。
    const normalizedDefault =
      configuredDefault && resolveLegacyReasoningLevel
        ? (resolveEffectiveModelSelection({
            selection: configuredDefault,
            registry,
            classifyProvider: () => "ordinary",
            resolveLegacyReasoningLevel,
          }).effectiveSelection ?? undefined)
        : configuredDefault;
    const initial = resolveInitialModelSelection({
      registry,
      configuredDefault: normalizedDefault,
    });
    return Object.freeze({
      revision: revision ?? registry.revision,
      providers: Object.freeze(
        registry.providers
          .filter((provider) => provider.config.visibility !== "hidden")
          .map(projectModelSelectionProviderView),
      ),
      ...(initial.source === "none" ? {} : { preferredSelection: initial.selection }),
      ...(input
        ? resolveEffectiveModelSelection({
            selection: input.selection,
            registry,
            accountStates: snapshot?.account.states,
            classifyProvider: this.#classifyProvider,
            resolveLegacyReasoningLevel,
          })
        : {}),
    });
  }

  onDidChange(listener: (view: ModelSelectionView) => void): () => void {
    return this.#source.onDidChange(() => listener(this.getView()));
  }
}

/** 把一个已进入 Registry 的 Provider 投影为标准模型选择候选。调用方负责产品作用域。 */
// [契约] 只处理已进入 Registry 的 provider，作用域由调用方负责。
// [契约] config 与 models 都序列化为纯对象，避免把类实例带出包。
// [失败路径] 直接透传 model.config 会让调用方拿到可变内部对象。
// [契约] hidden provider 的过滤不在这里做，由调用方统一处理。
export function projectModelSelectionProviderView(
  provider: ProviderRegistryView["providers"][number],
): ModelSelectionProviderView {
  return Object.freeze({
    providerId: provider.providerId,
    providerName: provider.providerName,
    templateId: provider.templateId,
    config: serializeRegistryProviderConfig(provider.config),
    models: Object.freeze(
      provider.models.map((model) =>
        Object.freeze({
          modelId: model.modelId,
          config: serializeRegistryModelConfig(model.config),
        }),
      ),
    ),
  });
}

// [契约] 未 start 是明确的调用顺序错误，必须抛错而不是返回空视图。
// [失败路径] 返回空快照会让 UI 把未启动误当成没有配置。
// [契约] 错误信息包含服务名，便于定位初始化顺序问题。
// [权衡] 不做自动 start：Facade 不拥有生命周期。
function requireSnapshot(source: ProviderRegistryFacadeSource): ProviderRegistryServiceSnapshot {
  const snapshot = source.getSnapshot();
  if (!snapshot) throw new Error("ProviderRegistryService 尚未 start()");
  return snapshot;
}

// [契约] 只从 effectiveProviders 读取，保证与当前 Registry 解析一致。
// [失败路径] 从原始配置读取会绕过模板合并，得到不完整规则。
// [契约] 找不到 provider 说明调用方传了无效 id，直接抛错。
// [权衡] 不做默认 provider 回退，避免静默写错目标。
function requireEffectiveProvider(
  snapshot: ProviderRegistryServiceSnapshot,
  providerId: ProviderId,
): ProviderConfigRule {
  const provider = snapshot.resolution.effectiveProviders.getRule(providerId);
  if (!provider) throw new Error(`Provider 不存在: ${providerId}`);
  return provider;
}

// [契约] 纯函数投影：输入快照片段，输出冻结视图，不做任何 IO。
// [契约] 同时保留内置配置、个人配置与生效配置，供 UI 对比展示。
// [失败路径] 任一处漏掉 toJSON 会把可变实例泄漏给 renderer。
// [契约] executable 由 registryProviders 单独计算，见下方 Set。
// [权衡] 视图字段较多但都是展示所需，避免 UI 再发第二次请求。
function createProviderSettingsView(input: {
  revision: number;
  zcodeBuiltinProviders: ProviderRegistryServiceSnapshot["config"]["zcodeBuiltinProviders"];
  zcodeBuiltinProviderTemplates: ProviderRegistryServiceSnapshot["config"]["zcodeBuiltinProviderTemplates"];
  personalProviders: ProviderRegistryServiceSnapshot["config"]["personalProviders"];
  personalModels: ProviderRegistryServiceSnapshot["config"]["personalModels"];
  resolution: ProviderConfigResolution;
  accountStates?: import("./account-provider-state.js").AccountProviderStates;
}): ProviderSettingsView {
  // [契约] 只有进入 Registry 的 provider 才算可执行。
  // [失败路径] 用 enabled 或 issues 为空来判断会让未注册 provider 被选中。
  // [契约] 该集合在视图构建时一次性求值，避免逐 provider 重复查找。
  const executableProviderIds = new Set(
    input.resolution.registryProviders.map((provider) => provider.providerId),
  );
  // [契约] 个人配置与个人模型规则分别从 personalProviders 与 personalModels 读取。
  // [契约] useRecommendedConfig 由规则类型推导，不能由 UI 传入。
  // [失败路径] 混用 getExact 与 getExactRule 会让配置与来源标记不一致。
  // [契约] 所有可选字段只在存在时展开，保持视图形状稳定。
  const projectProvider = (provider: (typeof input.resolution.resolvedProviders)[number]) => {
    const personalConfig = input.personalProviders.get(provider.providerId);
    return Object.freeze({
      providerId: provider.providerId,
      providerName: provider.providerName,
      templateId: provider.templateId,
      enabled: provider.enabled,
      ...(input.accountStates?.[provider.providerId]
        ? { accountState: input.accountStates[provider.providerId] }
        : {}),
      executable: executableProviderIds.has(provider.providerId),
      ...(provider.templateConfig ? { templateConfig: provider.templateConfig.toJSON() } : {}),
      ...(provider.effectiveBuiltinConfig
        ? { effectiveBuiltinConfig: provider.effectiveBuiltinConfig.toJSON() }
        : {}),
      ...(personalConfig ? { personalConfig: personalConfig.toJSON() } : {}),
      effectiveConfig: provider.config.toJSON(),
      issues: provider.providerIssues,
      models: Object.freeze(
        provider.models.map((model) => {
          const personalModelConfig = input.personalModels.getExact(
            provider.providerId,
            model.modelId,
          );
          const personalModelRule = input.personalModels.getExactRule(
            provider.providerId,
            model.modelId,
          );
          return Object.freeze({
            kind: model.kind,
            modelId: model.modelId,
            builtin: model.source === "builtin",
            effectiveBuiltinConfig: model.effectiveBuiltinConfig.toJSON(),
            ...(personalModelConfig ? { personalExactConfig: personalModelConfig.toJSON() } : {}),
            ...(personalModelRule
              ? { useRecommendedConfig: personalModelRule.type !== "manual-provider-model" }
              : {}),
            effectiveConfig: model.config.toJSON(),
            enabled: model.enabled,
            executable: model.executable,
            selectable: model.selectable,
            issues: model.issues,
          });
        }),
      ),
    });
  };
  // [契约] hidden provider 在设置视图中不可见，但仍可能存在于 Registry。
  // [失败路径] 在源头删除会让 registry 与视图不一致。
  // [契约] providerOrder 只从可见的标准个人 provider 中生成。
  const visibleProviders = input.resolution.resolvedProviders.filter(
    (provider) => provider.config.visibility !== "hidden",
  );
  const configuredProviders = visibleProviders;
  return Object.freeze({
    revision: input.revision,
    providerTemplates: Object.freeze(
      (input.zcodeBuiltinProviderTemplates ?? ProviderTemplateMap.empty())
        .entries()
        .map(([templateId, template]) =>
          Object.freeze({
            templateId,
            templateNameMap: template.templateNameMap,
            config: template.config.toJSON(),
          }),
        ),
    ),
    // [契约] 只有 group 为 standard-personal 的 provider 参与排序。
    // [契约] 顺序来自配置中的个人 provider 列表，不是按名称排序。
    // [失败路径] 把内置 provider 混入排序会让拖拽结果无法持久化。
    // [契约] 返回冻结数组，避免调用方就地 sort 后污染视图。
    providerOrder: Object.freeze(
      configuredProviders
        .filter((provider) => provider.config.group === "standard-personal")
        .map((provider) => provider.providerId),
    ),
    providers: Object.freeze(configuredProviders.map(projectProvider)),
  });
}
