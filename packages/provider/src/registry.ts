// INV-01 视图整体冻结：守住位置 构造与替换；改错故障 下游误改共享数据。
// INV-02 替换即递增版本号：守住位置 replace；改错故障 订阅方无法判断是否更新。
// INV-03 索引与视图同时重建：守住位置 替换顺序；改错故障 查询命中旧对象。
// INV-04 重复供应商直接报错：守住位置 重建循环；改错故障 后者静默覆盖前者。
// INV-05 重复模型直接报错：守住位置 内层循环；改错故障 同标识模型互相覆盖。
// INV-06 查询按标识直达：守住位置 两张映射；改错故障 每次查询都要线性扫描。
// INV-07 选择校验先查供应商：守住位置 首个分支；改错故障 缺供应商时报模型不存在。
// INV-08 模型缺失单独编码：守住位置 第二分支；改错故障 调用方无法区分两种缺失。
// INV-09 选项校验复用同一函数：守住位置 末尾调用；改错故障 UI 与运行态各写一份。
// INV-10 缺思考档要报错：守住位置 未定义分支；改错故障 选择被当成合法。
// INV-11 档位必须在支持集合内：守住位置 包含判断；改错故障 非法档位下发到模型。
// INV-12 支持集合随错误冻结：守住位置 错误构造；改错故障 调用方改动诊断信息。
// INV-13 冻结时拷贝名称与模板：守住位置 映射函数；改错故障 视图丢失元数据。
// INV-14 冻结时逐层处理模型：守住位置 内层映射；改错故障 模型配置仍可被改写。
// INV-15 空注册表也合法：守住位置 默认参数；改错故障 首启前构造即报错。
// INV-16 订阅返回退订函数：守住位置 注册方法；改错故障 监听集合持续增长。
// INV-17 变更事件只带版本与原因：守住位置 事件构造；改错故障 事件携带整份视图造成放大。
// INV-18 校验只依赖已发布选项：守住位置 入参形状；改错故障 校验逻辑耦合领域类。
//
// 模块职责：维护供应商与模型的冻结视图，并提供选择校验。
// 状态所有权：视图与两张索引映射都归本类所有。
// 阅读顺序：先看数据形状，再看替换与索引，最后看选项校验与冻结。
import type { ModelId, ProviderId } from "./config/index.js";
import type { Provider, ProviderModel } from "./resolver.js";
import type { ModelSelection } from "@zcode/shared/model-selection";

export type { ModelSelection } from "@zcode/shared/model-selection";

export type ModelSelectionOptions = NonNullable<ModelSelection["options"]>;

export type ModelSelectionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "provider-not-found";
      readonly providerId: ProviderId;
    }
  | {
      readonly ok: false;
      readonly code: "model-not-found";
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly ok: false;
      readonly code: "reasoning-level-missing";
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly ok: false;
      readonly code: "reasoning-level-not-supported";
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
      readonly reasoningLevel: string;
      readonly supportedLevels: readonly string[];
    };

export interface ProviderRegistryView {
  readonly revision: number;
  readonly providers: readonly Provider[];
}

export interface ProviderRegistryChangedEvent {
  readonly revision: number;
  readonly reason: string;
}

// 读方只拿冻结视图，按标识查找走内部 Map 索引。
// 视图与索引在 constructor 和 replace() 里成对重建，避免出现新视图配旧索引。
// revision 只在 replace() 递增，订阅方据此判断快照新旧。
export class ProviderRegistry {
  #view: ProviderRegistryView;
  #providerById = new Map<ProviderId, Provider>();
  #modelByProviderId = new Map<ProviderId, Map<ModelId, ProviderModel>>();
  readonly #listeners = new Set<(event: ProviderRegistryChangedEvent) => void>();

  constructor(providers: readonly Provider[] = []) {
    this.#view = freezeView(0, providers);
    this.#rebuildIndexes();
  }

  getView(): ProviderRegistryView {
    return this.#view;
  }

  listProviders(): readonly Provider[] {
    return this.#view.providers;
  }

  getProvider(providerId: ProviderId): Provider | undefined {
    return this.#providerById.get(providerId);
  }

  getModel(providerId: ProviderId, modelId: ModelId): ProviderModel | undefined {
    return this.#modelByProviderId.get(providerId)?.get(modelId);
  }

  // 顺序固定为 供应商 → 模型 → 选项：两级缺失各有独立 code。
  // 失败一律返回判别对象而不抛错，异常会打断调用方流程，处置权留给调用方。
  validateSelection(selection: ModelSelection): ModelSelectionValidation {
    if (!this.#providerById.has(selection.providerId)) {
      return {
        ok: false,
        code: "provider-not-found",
        providerId: selection.providerId,
      };
    }
    const model = this.getModel(selection.providerId, selection.modelId);
    if (!model) {
      return {
        ok: false,
        code: "model-not-found",
        providerId: selection.providerId,
        modelId: selection.modelId,
      };
    }
    return validateModelSelectionOptions(model, selection);
  }

  // 顺序固定：revision +1 → 重建索引 → 广播，监听器收到的 event.revision 与 getView() 一致。
  // 监听器抛错不会回滚视图，但会中断本轮剩余监听器——循环里没有逐项 try/catch。
  // 旧视图是冻结快照，仍对旧的持有者有效，不会被就地改写。
  replace(providers: readonly Provider[], reason: string): void {
    this.#view = freezeView(this.#view.revision + 1, providers);
    this.#rebuildIndexes();
    const event = Object.freeze({ revision: this.#view.revision, reason });
    for (const listener of this.#listeners) listener(event);
  }

  onDidChange(listener: (event: ProviderRegistryChangedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #rebuildIndexes(): void {
    const providerById = new Map<ProviderId, Provider>();
    const modelByProviderId = new Map<ProviderId, Map<ModelId, ProviderModel>>();
    for (const provider of this.#view.providers) {
      if (providerById.has(provider.providerId)) {
        throw new Error(`Registry 中存在重复 Provider: ${provider.providerId}`);
      }
      providerById.set(provider.providerId, provider);
      const models = new Map<ModelId, ProviderModel>();
      for (const model of provider.models) {
        if (models.has(model.modelId)) {
          throw new Error(`Registry 中存在重复 Model: ${provider.providerId}/${model.modelId}`);
        }
        models.set(model.modelId, model);
      }
      modelByProviderId.set(provider.providerId, models);
    }
    this.#providerById = providerById;
    this.#modelByProviderId = modelByProviderId;
  }
}

/** Registry 与默认选择初始化共用同一套通用 Model Option 校验。 */
// 两种失败分开编码：reasoningLevel 缺失 / 不在 optionSpecs 的取值集合内。
// supportedLevels 返回的是副本，调用方改它不会污染注册表里的冻结原数组。
export function validateModelSelectionOptions(
  // 只依赖发布给 Renderer 的 Option 事实，避免 UI 另写一份档位校验或构造领域类。
  model: {
    readonly config: {
      readonly optionSpecs: { readonly reasoningLevel: { readonly values: readonly string[] } };
    };
  },
  selection: ModelSelection,
): ModelSelectionValidation {
  const reasoningLevel = selection.options?.reasoningLevel;
  const reasoningSpec = model.config.optionSpecs.reasoningLevel;
  if (reasoningLevel === undefined) {
    return {
      ok: false,
      code: "reasoning-level-missing",
      providerId: selection.providerId,
      modelId: selection.modelId,
    };
  }
  if (!reasoningSpec.values.includes(reasoningLevel)) {
    return {
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoningLevel,
      supportedLevels: Object.freeze([...reasoningSpec.values]),
    };
  }
  return { ok: true };
}

function freezeView(revision: number, providers: readonly Provider[]): ProviderRegistryView {
  const frozenProviders = providers.map((provider) =>
    Object.freeze({
      providerId: provider.providerId,
      // 名称与模板已从 config 外移；冻结时漏拷贝会让所有 Selection View 丢失元数据。
      providerName: provider.providerName,
      templateId: provider.templateId,
      config: provider.config,
      models: Object.freeze(
        provider.models.map((model) =>
          Object.freeze({ modelId: model.modelId, config: model.config }),
        ),
      ),
    }),
  );
  return Object.freeze({ revision, providers: Object.freeze(frozenProviders) });
}
