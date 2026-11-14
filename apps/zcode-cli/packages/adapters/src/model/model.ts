// ==== model/model.ts ====
// 定位：Model 抽象的执行外壳，把“模型能力/选项规格”与 executor 绑定为可调用对象。
// 输入：CreateModelOptions 提供 provider/model 标识、properties、optionSpecs 与 executor。
// 输出：Model 实例，generateText 返回 ModelResult，streamText 返回 ModelEvent 异步流。
// 副作用：纯内存构建；不发起网络，实际 IO 全部发生在 executor 内。
// 失败语义：构造/绑定/请求前的能力与选项校验抛 ModelProtocolError（不可重试、source=runtime）；
//           executor 自身的错误原样向上传递，不做归一化。
// 不变量：properties/optionSpecs/options 均被冻结；bind 返回新实例，不修改原实例。
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  type Model,
  type ModelEvent,
  type ModelOptionSpecs,
  type ModelOptions,
  type ModelProperties,
  type ModelPropertiesInput,
  type ModelId,
  type ModelProviderId,
  type ModelRequest,
  type ModelResult,
} from "@zcode/contracts";

/**
 * executor 真正收到的请求：在 ModelRequest 基础上把 options 收敛为必填。
 * 该类型只出现在本地，确保 executor 不必再处理 undefined 选项。
 */
export interface ModelExecutionRequest extends Omit<ModelRequest, "options"> {
  /** 已通过 optionSpecs 校验且字段齐全的模型选项（maxOutputTokens/reasoningLevel）。 */
  options: Required<ModelOptions>;
}

/**
 * 模型执行器契约。
 * generateText 必须一次性返回完整结果；streamText 返回可迭代事件流，
 * 两者都接收已校验的请求，错误直接抛给上层。
 */
export interface ModelExecutor {
  generateText(request: ModelExecutionRequest): Promise<ModelResult>;
  streamText(request: ModelExecutionRequest): AsyncIterable<ModelEvent>;
}

/**
 * 创建 Model 的输入口径：
 * - requestCapabilities：可选的请求能力声明，原样挂到实例上。
 * - providerId/modelId：提供方与模型 ID，必填。
 * - displayName：展示名，可选。
 * - properties：模型能力（工具调用/结构化输出/图片/PDF/视频），构造时浅拷贝并冻结。
 * - optionSpecs：选项取值范围（maxOutputTokens 上限、reasoningLevel 枚举）。
 * - options：可选的初始选项，会先做部分校验再冻结。
 * - executor：实际执行 generate/stream 的实现，必填。
 */
export interface CreateModelOptions {
  requestCapabilities?: Model["requestCapabilities"];
  providerId: ModelProviderId;
  modelId: ModelId;
  displayName?: string;
  properties: ModelPropertiesInput;
  optionSpecs: ModelOptionSpecs;
  options?: ModelOptions;
  executor: ModelExecutor;
}

/** 用给定依赖构造一个不可变的 ExecutableModel；不做 IO。 */
export function createModel(input: CreateModelOptions): Model {
  return new ExecutableModel(input);
}

/**
 * Model 的具体实现：持有标识、能力与冻结的选项规格，并把请求适配给 executor。
 * 所有 readonly 字段在构造后不再变化；请求级选项由 prepareRequest 与实例选项合并。
 */
class ExecutableModel implements Model {
  readonly requestCapabilities?: Model["requestCapabilities"];
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
  readonly displayName?: string;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options: ModelOptions;
  private readonly executor: ModelExecutor;

  constructor(input: CreateModelOptions) {
    this.requestCapabilities = input.requestCapabilities;
    this.providerId = input.providerId;
    this.modelId = input.modelId;
    this.displayName = input.displayName;
    this.properties = Object.freeze({ ...input.properties });
    this.optionSpecs = freezeOptionSpecs(input.optionSpecs);
    this.options = Object.freeze(validatePartialOptions(this.optionSpecs, input.options ?? {}));
    this.executor = input.executor;
  }

  /**
   * 派生一个绑定了额外选项的新 Model。
   * 空/未提供选项时直接返回 this（零分配）；否则合并实例选项并重新校验，
   * 返回的新实例与原实例共享 executor 与能力，原实例保持不变。
   */
  bind(options?: ModelOptions): Model {
    if (!options || Object.keys(options).length === 0) return this;
    return new ExecutableModel({
      requestCapabilities: this.requestCapabilities,
      providerId: this.providerId,
      modelId: this.modelId,
      displayName: this.displayName,
      properties: this.properties,
      optionSpecs: this.optionSpecs,
      options: { ...this.options, ...options },
      executor: this.executor,
    });
  }

  /** 单次生成：先做请求前校验并合并选项，再委托 executor。 */
  async generateText(request: ModelRequest): Promise<ModelResult> {
    return this.executor.generateText(this.prepareRequest(request));
  }

  /**
   * 流式生成：请求前校验/合并同步发生在返回迭代器之前，
   * 因此能力或选项不合法会在消费流之前直接抛错，而不是在迭代中途。
   */
  streamText(request: ModelRequest): AsyncIterable<ModelEvent> {
    const prepared = this.prepareRequest(request);
    return this.executor.streamText(prepared);
  }

  /**
   * 把外部 ModelRequest 规整为 executor 输入。
   * 先按模型能力校验工具/结构化输出/多模态输入，再用实例选项与请求选项合并结果做完整校验；
   * 只保留契约允许的字段，避免把调用方额外属性透传给 executor。
   */
  private prepareRequest(request: ModelRequest): ModelExecutionRequest {
    validateRequestProperties(this.properties, request);
    const requestOptions = request.options ?? {};
    return {
      toolSearchEnabled: request.toolSearchEnabled,
      messages: request.messages,
      tools: request.tools,
      responseJsonSchema: request.responseJsonSchema,
      abortSignal: request.abortSignal,
      options: {
        ...validateOptions(this.optionSpecs, { ...this.options, ...requestOptions }),
      },
    };
  }
}

/** 深冻结选项规格，防止调用方后续篡改 reasoningLevel.values 数组。 */
function freezeOptionSpecs(specs: ModelOptionSpecs): ModelOptionSpecs {
  return Object.freeze({
    maxOutputTokens: Object.freeze({ ...specs.maxOutputTokens }),
    reasoningLevel: Object.freeze({
      ...specs.reasoningLevel,
      values: Object.freeze([...specs.reasoningLevel.values]),
    }),
  });
}

/**
 * 完整选项校验：两个字段都必须存在且在规格范围内。
 * maxOutputTokens 必须是正整数的最大值约束，reasoningLevel 必须命中枚举；
 * 任一不满足抛 InvalidModelRequest，返回值的两个字段可直接赋给 Required<ModelOptions>。
 */
function validateOptions(specs: ModelOptionSpecs, options: ModelOptions): Required<ModelOptions> {
  const maxOutputTokens = options.maxOutputTokens;
  if (
    maxOutputTokens === undefined ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 ||
    maxOutputTokens > specs.maxOutputTokens.max
  ) {
    throw invalidRequest("maxOutputTokens is outside the model option range", {
      maxOutputTokens,
      spec: specs.maxOutputTokens,
    });
  }

  const reasoningLevel = options.reasoningLevel;
  const reasoningSpec = specs.reasoningLevel;
  if (reasoningLevel === undefined || !reasoningSpec.values.includes(reasoningLevel)) {
    throw invalidRequest("reasoningLevel is not supported by the model", {
      reasoningLevel,
      values: reasoningSpec.values,
    });
  }

  return { maxOutputTokens, reasoningLevel };
}

/**
 * 部分选项校验：undefined 合法（表示未指定），一旦提供就必须合规。
 * 用于构造与 bind 阶段，允许先只绑定 maxOutputTokens 或只绑定 reasoningLevel。
 */
function validatePartialOptions(specs: ModelOptionSpecs, options: ModelOptions): ModelOptions {
  const maxOutputTokens = options.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (!Number.isInteger(maxOutputTokens) ||
      maxOutputTokens <= 0 ||
      maxOutputTokens > specs.maxOutputTokens.max)
  ) {
    throw invalidRequest("maxOutputTokens is outside the model option range", {
      maxOutputTokens,
      spec: specs.maxOutputTokens,
    });
  }
  const reasoningLevel = options.reasoningLevel;
  if (reasoningLevel !== undefined && !specs.reasoningLevel.values.includes(reasoningLevel)) {
    throw invalidRequest("reasoningLevel is not supported by the model", {
      reasoningLevel,
      values: specs.reasoningLevel.values,
    });
  }
  return { ...options };
}

/**
 * 请求前的模型能力校验。
 * 工具、结构化输出、图片/PDF/视频输入只要模型未声明支持就立即拒绝，
 * 避免把必然失败的请求发到 provider 并消耗额度/重试预算。
 */
function validateRequestProperties(properties: ModelProperties, request: ModelRequest): void {
  if (request.tools && request.tools.length > 0 && !properties.supportsToolCall) {
    throw invalidRequest("Model does not support tool calls");
  }
  if (request.responseJsonSchema && !properties.supportsJsonSchemaOutput) {
    throw invalidRequest("Model does not support structured output");
  }

  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "image" && !properties.inputFormat.supportsImage) {
        throw invalidRequest("Model does not support image input");
      }
      if (
        block.type === "file" &&
        block.mediaType.toLowerCase() === "application/pdf" &&
        !properties.inputFormat.supportsPdf
      ) {
        throw invalidRequest("Model does not support PDF input");
      }
      if (
        block.type === "file" &&
        block.mediaType.toLowerCase().startsWith("video/") &&
        !properties.inputFormat.supportsVideo
      ) {
        throw invalidRequest("Model does not support video input");
      }
    }
  }
}

/**
 * 构造请求前本地校验失败的错误。
 * 固定携带 reason=InvalidRequest、retryable=false、source=runtime，
 * 让上层 TurnError 与冷恢复能识别这是未发出请求的本地失败而非 provider 失败。
 */
function invalidRequest(message: string, context?: Record<string, unknown>): ModelProtocolError {
  // capability / option 校验发生在 executor 之前，不会经过 runner 的失败归一化；
  // 若只保留 code/message，TurnError 和冷恢复都无法知道这是请求发出前的本地校验失败。
  return new ModelProtocolError(ModelErrorCode.InvalidModelRequest, message, {
    ...context,
    reason: ModelFailureReason.InvalidRequest,
    retryable: false,
    source: "runtime",
  });
}
