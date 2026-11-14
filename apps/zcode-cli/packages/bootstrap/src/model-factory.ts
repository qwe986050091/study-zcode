// Model factory - creates model adapter with config
//
// 工厂只做依赖拼装：把执行配置、进程级请求安全状态、IO 调试目录与日志/状态出口
// 交给 adapters 的 AiSdkModelAdapter。网络、鉴权与重试全在 adapter 内部，本层不重复实现。
// 进程内共享同一个 requestSecurityState，但每次 new adapter 都保留各自请求上下文。

import {
  createModelRequestSecurityState,
  AiSdkModelAdapter,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "@zcode/adapters/model";
import type { Logger, ModelStatusSink } from "@zcode/contracts";

interface CreateModelAdapterBaseOptions {
  /** 环境变量表；adapter 用于端点/代理/版本解析，缺省由 adapter 取 process.env。 */
  env?: EnvRecord;
  /** 模型链路日志出口（请求摘要、重试、错误），不记录明文凭据。 */
  logger?: Logger;
  /** 模型 IO 落盘目录（完整请求/响应调试）；仅显式配置时才写。 */
  modelIoDir?: string;
  /** 是否保留完整 IO（默认只存摘要）；可能含敏感内容，需用户显式开启。 */
  modelIoFullRetentionEnabled?: boolean;
  /** 流空闲超时；超时视为中断，防止半开连接无限挂起。 */
  streamIdleTimeoutMs?: number;
  /** 模型状态回调（连接/降级等），供 UI 展示。 */
  statusSink?: ModelStatusSink;
}

export type CreateModelAdapterOptions = CreateModelAdapterBaseOptions & {
  executionConfig: AiSdkModelExecutionConfig;
};

// 可复用资源由进程拥有，每个 execution 保留自己的请求状态。
const processRequestSecurityState = createModelRequestSecurityState();

// 缺少 executionConfig 属于装配期错误（不是用户输入问题），直接抛错让启动失败，
// 避免带着空配置进入首个请求时才崩溃。
export function createModelAdapter(options: CreateModelAdapterOptions): AiSdkModelAdapter {
  if (!options.executionConfig) {
    throw new Error("createModelAdapter requires executionConfig");
  }
  return new AiSdkModelAdapter({
    ...options.executionConfig,
    requestSecurityState: processRequestSecurityState,
    debugDir: options.modelIoDir,
    env: options.env,
    logger: options.logger,
    modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    statusSink: options.statusSink,
  });
}
