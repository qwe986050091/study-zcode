// ============================================================
// Provider Registry → AgentRuntime 的 modelFactory
// ============================================================
// 位置：create-app 在 Provider Registry 就绪、构造 AgentRuntime 时注入。Registry 是进程级
// 模型事实源；这里只做「selection 校验 → 按 id 取 provider/model → 造 Model」的绑定，
// 不修补缺省、不缓存配置。每次调用都读当刻的 Registry，且必须 start() 之后才可造 Model。
// 失败语义：未 start、selection 校验失败、或 Registry 索引与校验不一致时同步抛错，由运行时报给用户。

import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { Model } from "@zcode/contracts";
import type { AgentRuntimeDeps } from "@zcode/core";
import {
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@zcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

/** AgentRuntimeDeps 里 modelFactory 的精确类型；调用方无需再写 NonNullable。 */
export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

/** 本模块只依赖 Registry 的这五个读/订阅面；传入整个注册表对象而不是一次性快照。 */
export interface ProviderRegistryModelSource {
  /** 当刻的完整视图；调用方应每次现读，不缓存。 */
  getView(): ProviderRegistryView;
  /** 按 id 精确取 provider；校验通过后仍可能缺席，属索引不一致。 */
  getProvider(providerId: string): Provider | undefined;
  /** 按 provider+model 精确取模型；同上。 */
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  /** 唯一的选择校验入口；失败结果被转成协议错误。 */
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  /** 订阅注册表变化；本类不订阅，留给上层决定是否需要重建。 */
  onDidChange(listener: () => void): () => void;
}

/** 适配器的最小切面：只需 createModel；测试可注入替身。 */
type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

interface ApiProviderModelRuntimeOptions {
  /** Registry 必须传整个对象：构造期快照会与后续热更新脱节。 */
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
}

/**
 * 从业务 Registry 精确查找一次完整事实，并直接创建冻结静态配置的 Model。
 *
 * 生命周期：`#started` 由 start/dispose 控制；start 前调用 factory 抛错，避免在 Registry
 * 尚未装载时造出一个半成品 Model。dispose 只翻标志，不持有资源。
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  /** 是否已允许造 Model；构造后默认 false，须显式 start。 */
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
  }

  /**
   * AgentRuntime 注入的工厂：校验 selection、按 id 精确取 provider/model，再交适配器造 Model。
   *
   * 不在此修补任何缺省（输出预算、reasoning 档位都由执行链在 selection 中给定）；校验与索引
   * 不一致属编程错误，直接抛错而不是静默换模型。返回的 Model 冻结注册表当刻的静态配置。
   */
  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    if (!validation.ok) throw createRegistrySelectionProtocolError(validation);
    const providerId = target.selection.providerId;
    const modelId = target.selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    return this.#createRegistryModel(provider, registryModel, target);
  };

  /** 允许造 Model；重复调用无副作用。 */
  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  /** 关掉造 Model 的许可；已在飞的 Model 不受影响，下一次 factory 调用会抛错。 */
  dispose(): void {
    this.#started = false;
  }

  /** 按 Registry 事实造 Model；requestAuth source 的透传规则见函数内注释。 */
  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const config = registryModel.config;
    // 输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定。
    // Selection 已在上面的 Registry 边界完成校验，Factory 不再承担任何缺省修复。
    const normalReasoningLevel = target.selection.options!.reasoningLevel!;
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      providerConfig: provider.config,
      modelConfig: config,
      // Off-Peak 与 Highspeed 都靠执行作用域的动态 requestAuth（JWT / 计划 Key / 卡 ID header）
      // 发送，必须把承载它的 source 透传给 adapter。此门禁与 runner.ts 的 requestAuthRequired
      // 门禁一一对应：漏掉 highspeed 会在这里丢掉 source，导致 runner 端 requestAuth 缺失、
      // 本轮在发送前抛 model_request_auth_missing。
      ...(provider.config.access.type === "zhipu-account" &&
      (provider.config.access.mode === "off-peak" ||
        provider.config.access.mode === "highspeed")
        ? {
            requestDependencies: {
              requestAuth: {
                source: target.requestDependencies?.requestAuth?.source,
              },
            },
          }
        : {}),
      options: {
        reasoningLevel: normalReasoningLevel,
      },
    });
  }
}
