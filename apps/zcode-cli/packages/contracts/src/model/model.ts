import type {
  JsonSchema,
  ModelInputMessage,
  ModelId,
  ModelProviderId,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolContract,
} from "./index.js";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import type { ModelPropertiesData, ModelOptionSpecsData } from "@zcode/shared/model-config";
import type { ToolSearchCapability } from "../tools/tool-search.js";

/**
 * 从共享 Schema 重导出的稀疏选择结构：`{ providerId, modelId, options? }`。
 *
 * 生产者：用户选模、会话持久化、执行作用域覆盖（如 Highspeed 加速卡）。
 * 消费者：parseModelSelectionValue、core 的 Effective Selection 解析、模型工厂。
 * 不变量：providerId/modelId 是 trim 后的普通字符串标识，不是显示名；
 * 结构化选择是唯一领域格式，Picker 的 `provider/model$level` 字符串只是 UI 边界，
 * 不能拿来持久化或跨进程传递。options 嵌套对象在复制时必须展开到该层。
 */
export type { ModelSelection } from "@zcode/shared/model-selection";

/**
 * 配置投影类型的公共别名：直接来自同一份 Provider 配置 Schema，不复制定义。
 *
 * 生产者：@zcode/shared/model-config 的 Data 类型（配置解析结果）。
 * 消费者：Model 句柄的 properties/optionSpecs 与设置页展示。
 * 不变量：这里只是类型重命名，字段口径与共享配置保持一致；不得在 CLI 侧
 * 另造一套“可执行/完整”变体，否则模型注册表与设置页会出现双口径。
 */
// 仅保留 CLI 公共类型名，字段来自同一数据 Schema，不复制 Provider 配置定义。
export type {
  ModelInputFormatData as ModelInputFormat,
  ModelOutputFormatData as ModelOutputFormat,
  EnumOptionSpecData as EnumOptionSpec,
  LimitOptionSpecData as LimitOptionSpec,
} from "@zcode/shared/model-config";
export type ModelOptionSpecs = ModelOptionSpecsData;
export type ModelProperties = ModelPropertiesData;
export type ModelPropertiesInput = ModelProperties;

/**
 * 模型选项（执行期可调）：只表达本次请求的推理档位与输出上限。
 *
 * 生产者：ModelSelection.options、Model.bind、CLI 参数解析与模型设置页。
 * 消费者：adapter 映射为 provider 具体字段；Model.options 是绑定后的当前值。
 * 不变量：这里不含 providerId/modelId——选项不构成身份；显示名也不在这里。
 * 字段缺省表示“未指定，由模型/适配层决定”，不能把缺省等同于某个具体档位。
 */
export interface ModelOptions {
  /** 思考档位标识；必须来自模型 optionSpecs 的枚举，adapter 只做映射不做猜测。 */
  reasoningLevel?: string;
  /** 本次请求的最大输出 token；属于请求预算而非模型容量。 */
  maxOutputTokens?: number;
}

/**
 * 面向 Adapter 的模型请求：只含消息/工具/响应约束与选项，不含身份与传输配置。
 *
 * 生产者：core 的 turn/tool/compact/title 等调用点在构造请求时填充。
 * 消费者：Model.generateText/streamText；然后由 adapter 翻译成 provider 请求。
 * 不变量：`options` 与身份无关，不能借此切换 provider/model；tools 的顺序与
 * 声明（schema/权限/预算）即 provider 看到的工具面；abortSignal 必须向下透传。
 */
export interface ModelRequest {
  toolSearchEnabled?: boolean;
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
}

/**
 * 结果/事件类型别名：沿用 Provider SDK 归一化后的字段口径，供 CLI 公共类型使用。
 *
 * 生产者：ModelTextResult/ModelStreamEvent（contracts 的模型协议层）。
 * 消费者：core 的结果处理、持久化与 UI 流式投影。
 * 不变量：旧名只保留在 Adapter 兼容边界，业务调用统一用 ModelResult/ModelEvent；
 * 别名不得改变字段结构，否则 adapter 与 core 的归一化会分叉。
 */
// 第一阶段沿用已经完成 Provider SDK 归一化的结果和流事件字段；
// 旧名字只保留在 Adapter 兼容边界，业务调用统一使用下面两个名字。
export type ModelResult = ModelTextResult;
export type ModelEvent = ModelStreamEvent;

/**
 * 已解析、可直接调用的模型句柄：把“选择”变成带配置与能力的执行对象。
 *
 * 生产者：Active Model 工厂（按 ModelSelection + provider/model 配置构造），
 * `bind` 产生带新选项的同身份句柄。
 * 消费者：core 的模型调用边界；adapter 负责实现 generateText/streamText。
 *
 * 身份不变量：providerId/modelId 是稳定标识（与持久化、用量主键、缓存键对齐），
 * 不得写成人类可读名称；displayName 仅用于 UI，不能用于相等判断或路由。
 * `requestCapabilities` 声明该句柄实际可用的能力（如 tool search），
 * 调用方不得用配置里的“可能支持”替代它。bind 只改选项，不改身份与能力。
 */
export interface Model {
  readonly requestCapabilities?: { readonly toolSearch?: ToolSearchCapability };
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
  readonly displayName?: string;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options: ModelOptions;

  bind(options?: ModelOptions): Model;
  generateText(request: ModelRequest): Promise<ModelResult>;
  streamText(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/** 校验当前 ModelSelection 值；旧数据库格式只在版本化 migration 转换，不在普通读取时兜底。 */
/**
 * 校验并返回持久化/恢复入口读到的 ModelSelection 值；不合法返回 undefined。
 *
 * 生产者：session store codec 在读取会话/消息上的选择字段时调用。
 * 消费者：core 的模型解析与回退链；UI 只展示已解析的选择。
 *
 * 稀疏语义：`options` 缺省表示“未指定思考档位，沿用模型默认”；显式给出
 * `options.reasoningLevel` 才构成覆盖。ModelSelection 本身不接受 `null` 作为
 * 选项值——事件层的 `null`（如 ModelSelected.contextWindow、
 * previousModelSelection）才是“显式清除”，两者不能混为一谈。
 * 不变量：旧数据库格式只在版本化 migration 转换，普通读取不做兜底猜测；
 * 校验失败必须返回 undefined 让上层按“选择缺失”处理，而不是抛出中断恢复。
 */
export function parseModelSelectionValue(value: unknown): ModelSelection | undefined {
  const parsed = modelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
