// ============================================================
// AI SDK model adapter errors
// 定位：adapter 层唯一的错误类型与归因来源枚举，向上（core/failure-classifier）提供稳定 code。
// 输入输出：构造时接收 ModelErrorCode + message + 可选 cause/context/usage；错误对象可自携 usage。
// 副作用：无（纯内存）。失败语义：构造本身不抛；Error#cause 保留原始底层错误。
// 不变量：本地 provider 配置错误必须先标记 runtime/retryable=false，不能靠 runner 事后归一化。
// ============================================================

import {
  ModelFailureReason,
  type ErrorAttribution,
  type ModelErrorCode,
  type ModelId,
  type ModelUsage,
} from "@zcode/contracts";

export const ModelErrorSource = {
  Network: "network",
  Provider: "provider",
  Runtime: "runtime",
} as const satisfies Record<string, NonNullable<ErrorAttribution["source"]>>;

export type ModelErrorSource = (typeof ModelErrorSource)[keyof typeof ModelErrorSource];

export type LocalProviderConfigurationErrorContext = Record<string, unknown> & {
  envKey?: string;
  modelId?: ModelId;
  providerId: string;
  reason: typeof ModelFailureReason.ProviderNotConfigured;
  retryable: false;
  source: typeof ModelErrorSource.Runtime;
};

/**
 * 构造"本地 provider 配置缺失/鉴权缺失"的归因上下文。
 * envKey/modelId 可缺省（无对应环境变量或模型时 undefined）；固定 reason=ProviderNotConfigured、
 * retryable=false、source=runtime，因为这类错误发生在请求创建前，runner 归一化不会经过。
 * 返回新对象，不修改入参；用于让监控把配置问题归到本地 runtime 而非上游 provider。
 */
export function createLocalProviderConfigurationErrorContext(
  context: Pick<LocalProviderConfigurationErrorContext, "envKey" | "modelId" | "providerId">,
): LocalProviderConfigurationErrorContext {
  // provider 缺失和鉴权配置错误发生在请求创建前，不会经过 runner 的错误归一化；
  // 必须在 Model Execution 装配边界直接保留 runtime 归因，避免监控把本地配置问题记到上游 provider。
  return {
    ...context,
    reason: ModelFailureReason.ProviderNotConfigured,
    retryable: false,
    source: ModelErrorSource.Runtime,
  };
}

/** Adapter 错误的可选载荷：cause 为底层原始错误；context 为结构化归因字段；usage 为已产生 token 用量。 */
export interface AiSdkModelAdapterErrorOptions {
  cause?: unknown;
  context?: Record<string, unknown>;
  usage?: ModelUsage;
}

/**
 * adapter 统一错误类型。code 是稳定判定依据（禁止上层按 message 文本分型）；
 * usage 允许错误路径携带已消耗 token，避免失败 turn 的用量丢失。
 */
export class AiSdkModelAdapterError extends Error {
  readonly code: ModelErrorCode;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
  readonly usage?: ModelUsage;

  constructor(code: ModelErrorCode, message: string, options?: AiSdkModelAdapterErrorOptions) {
    super(message);
    this.name = "AiSdkModelAdapterError";
    this.code = code;
    this.cause = options?.cause;
    this.context = options?.context;
    this.usage = options?.usage;
  }

  /**
   * 覆盖上下文（而非合并）后返回自身，便于 `throw new X().enrichContext(...)` 链式写法。
   * 注意会丢弃原有 context：调用点需自行保证已包含必要字段。
   */
  enrichContext(context: Record<string, unknown>): this {
    Object.assign(this, { context });
    return this;
  }
}
