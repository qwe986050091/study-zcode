import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import {
  normalizeModelSelection,
  type ModelSelection,
  type Provider,
  type ProviderModel,
} from "@zcode/provider";
import type { ZCodeModelOption } from "@zcode/shared";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

// ============================================================
// Provider Registry 的选择绑定：provider/model 引用 → 已校验的执行绑定
// ============================================================
// Registry 是进程级模型事实源；这里只做“把选择解析到具体 Provider/Model”的纯查询，不写配置、
// 不触发刷新。`modelSelection` 可以是用户的保存意图，但只有经 validateSelection 并拿到
// provider+model 才算“执行绑定”；provider 不在 Registry 里时返回 undefined 表示“不拥有”，
// 而 provider 已拥有、model 缺失则必须抛协议错误，不允许回退到 Turn Overlay 的另一份快照。

/**
 * 一次成功解析的结果：Registry 里的 Provider / Model 对象 + 归一化后的选择。
 * `selection` 是副本（options 已浅拷贝），改它不会影响 Registry 快照。
 */
export interface ResolvedRegistrySelection {
  readonly provider: Provider;
  readonly model: ProviderModel;
  readonly selection: ModelSelection;
}

/**
 * Registry 是模型选择的正式候选来源。当前 Turn 临时携带的 Provider 属于执行输入，
 * 不进入模型选择列表。
 */
export function listRegistryBackedModels(
  registry: ProviderRegistryModelSource,
): ZCodeModelOption[] {
  const view = registry.getView();
  return view.providers.flatMap((provider) =>
    provider.models.map((model) => toModelOption(provider, model)),
  );
}

/**
 * 按已解析的选择取一个模型选项（`getView` 的只读投影）。
 *
 * provider 或 model 任一不在 Registry 时回 undefined——这是“当前 Registry 视图没有它”，
 * 调用方应据此提示模型不可用，而不是回退到 Turn 级临时 Provider。
 */
export function getRegistryBackedModel(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ZCodeModelOption | undefined {
  const provider = registry.getProvider(selection.providerId);
  const model = registry.getModel(selection.providerId, selection.modelId);
  return provider && model ? toModelOption(provider, model) : undefined;
}

/**
 * 为连通性等辅助调用补齐最低推理档位。Factory 只接受完整执行选择，
 * 因而必须在创建 Model 之前完成，不能等 Model 创建后再 bind。
 */
export function completeAuxiliaryRegistryModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ModelSelection {
  const model = registry.getModel(selection.providerId, selection.modelId);
  const reasoningLevel = model?.config.optionSpecs.reasoningLevel.values[0];
  if (!reasoningLevel) return selection;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    options: {
      ...selection.options,
      reasoningLevel,
    },
  };
}

/**
 * 把外部字符串（`"main"` 或 `provider/model`）解析成 Registry 执行绑定。
 *
 * `"main"` 走调用方给的 configuredDefault（配置里的默认意图）；其他串先按 provider/model
 * 切分，再用 `normalizeModelSelection` 对当前 Registry 视图做补全（例如补默认 reasoning）。
 * 解析不出合法选择时回 undefined；Provider 归 Registry 所有但 Model / 推理档位非法时由
 * {@link resolveRegistryOwnedModelSelection} 抛协议错误。`allowMissingReasoning` 只放宽
 * “必须显式推理档位”这一条，用于连通性等辅助调用，不放宽 provider/model 必须存在。
 */
export function resolveRegistryOwnedSelection(
  registry: ProviderRegistryModelSource,
  requested: string,
  configuredDefault?: ModelSelection,
  options?: { allowMissingReasoning?: boolean },
): ResolvedRegistrySelection | undefined {
  const parsed = parseRequestedModelSelection(requested, configuredDefault);
  const selection =
    parsed && requested.trim() !== "main"
      ? normalizeModelSelection(registry.getView(), parsed)
      : parsed;
  return selection ? resolveRegistryOwnedModelSelection(registry, selection, options) : undefined;
}

function parseRequestedModelSelection(
  requested: string,
  configuredDefault?: ModelSelection,
): ModelSelection | undefined {
  const normalized = requested.trim();
  if (normalized === "main") return configuredDefault;
  return parseProviderQualifiedModelSelection(normalized);
}

/**
 * 解析 `provider/model` 形式的裸串（第一段斜杠分隔，两侧 trim 后都必须非空）。
 *
 * 不做 Registry 校验，也不认识 `"main"`；它只负责语法，语义解析在
 * {@link resolveRegistryOwnedSelection}。斜杠在开头 / 结尾 / 缺席时回 undefined。
 */
export function parseProviderQualifiedModelSelection(
  requested: string,
): ModelSelection | undefined {
  const normalized = requested.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) return undefined;
  const providerId = normalized.slice(0, separator).trim();
  const modelId = normalized.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/**
 * 解析由 Registry 已接管 Provider 的模型选择。
 *
 * 返回 undefined 表示进程 Registry 不拥有该 Provider。Registry 已拥有 Provider 时，
 * 缺失 Model 必须直接报错；调用方不能再回退 Turn Overlay 或临时 Provider 快照。
 */
export function resolveRegistryOwnedModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
  options?: { allowMissingReasoning?: boolean },
): ResolvedRegistrySelection | undefined {
  const validation = registry.validateSelection(selection);
  if (!validation.ok) {
    if (validation.code === "provider-not-found") return undefined;
    if (validation.code === "reasoning-level-missing" && options?.allowMissingReasoning) {
      return resolveRegistryModelSelection(registry, selection);
    }
    throw createRegistrySelectionProtocolError(validation);
  }
  const resolved = resolveRegistryModelSelection(registry, selection);
  if (!resolved) throw new Error("Registry Selection 校验与索引结果不一致");
  return resolved;
}

/** Registry 选择校验失败到稳定 Model 协议错误的唯一映射。 */
export function createRegistrySelectionProtocolError(
  validation: Exclude<ReturnType<ProviderRegistryModelSource["validateSelection"]>, { ok: true }>,
): ModelProtocolError {
  switch (validation.code) {
    case "provider-not-found":
      return new ModelProtocolError(
        ModelErrorCode.ProviderNotFound,
        `Provider Registry 中不存在 Provider: ${validation.providerId}`,
      );
    case "model-not-found":
      return new ModelProtocolError(
        ModelErrorCode.ModelNotFound,
        `Provider Registry 中不存在 Model: ${validation.providerId}/${validation.modelId}`,
      );
    case "reasoning-level-missing":
      return new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `Reasoning level is required for ${validation.providerId}/${validation.modelId}`,
      );
    case "reasoning-level-not-supported":
      return new ModelProtocolError(
        ModelErrorCode.InvalidModelRequest,
        `Reasoning effort "${validation.reasoningLevel}" is not supported by ${validation.providerId}/${validation.modelId}`,
      );
  }
}

/**
 * 在 Registry 当前视图里同时取 provider 与 model，命不中任一即回 undefined。
 *
 * 这是**不校验推理档位**的那条解析路径（validateSelection 之后才用），返回的 selection 是
 * 浅拷贝，调用方可以安全地再补 options。它不抛错：调用方已负责区分“不拥有”与“非法”。
 */
export function resolveRegistryModelSelection(
  registry: ProviderRegistryModelSource,
  selection: ModelSelection,
): ResolvedRegistrySelection | undefined {
  const provider = registry.getProvider(selection.providerId);
  const model = registry.getModel(selection.providerId, selection.modelId);
  if (!provider || !model) return undefined;
  return {
    provider,
    model,
    selection: {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.options ? { options: { ...selection.options } } : {}),
    },
  };
}

/**
 * 从已解析模型上取一个**合法**的推理档位：请求值在 `optionSpecs.reasoningLevel.values` 里才
 * 返回它，否则（含模型不支持推理）回 undefined。用于“用户可选值”的宽松读取，不抛错。
 */
export function resolveRegistryThoughtLevel(
  selection: ResolvedRegistrySelection | undefined,
  requested?: string,
): string | undefined {
  const spec = selection?.model.config.optionSpecs.reasoningLevel;
  if (!spec) return undefined;
  return requested && spec.values.includes(requested) ? requested : undefined;
}

/**
 * 严格版推理档位解析：请求值不在支持列表时抛 Error（调用方已承诺给定合法值）。
 * 与 {@link resolveRegistryThoughtLevel} 的区别只在失败语义——这里必须失败得响亮。
 */
export function requireRegistryThoughtLevel(
  selection: ResolvedRegistrySelection,
  requested: string,
): string {
  const spec = selection.model.config.optionSpecs.reasoningLevel;
  if (!spec.values.includes(requested)) {
    throw new Error(`Unsupported reasoning effort: ${requested}`);
  }
  return requested;
}

function toModelOption(provider: Provider, model: ProviderModel): ZCodeModelOption {
  const properties = model.config.properties;
  const optionSpecs = model.config.optionSpecs;
  const reasoning = optionSpecs.reasoningLevel;
  return {
    ref: { providerId: provider.providerId, modelId: model.modelId },
    label: model.modelId,
    providerLabel: provider.providerName ?? provider.providerId,
    contextWindow: properties.contextWindow,
    maxOutputTokens: optionSpecs.maxOutputTokens.max,
    reasoning: {
      levels: reasoning.values.map((level) => ({ value: level, label: level })),
      defaultLevel: reasoning.values.at(-1),
    },
    properties: {
      inputFormat: properties.inputFormat,
      outputFormat: properties.outputFormat,
    },
  };
}
