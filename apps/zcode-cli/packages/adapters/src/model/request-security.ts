// ============================================================
// 请求安全与观测端口（纯类型定义）
// 定位：model-execution 需要的"传输保护 + 观测读取"能力抽象，由 edition 目录实现。
// 输入输出：take(requestId) 返回该请求的观测记录，未记录时返回空数组（不是 null）。
// 副作用：由实现决定（protectTransport 可能包装 fetch、注入 header/证书）。
// 失败语义：take 不抛错；protectTransport 对非法配置的处理由实现保证 fail-closed。
// 不变量：进程级只共享可复用资源；每个执行器持有独立请求状态，禁止跨请求混用观测。
// ============================================================

import type { Logger, ModelRequestObservation } from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";

/** 观测读取口：按 requestId 取走记录（消费语义，取后即清，避免内存无界增长）。 */
export interface ModelRequestObservationSource {
  take(requestId: string): ModelRequestObservation[];
}

/**
 * 请求安全端口：既是观测源，也负责包装 transport。
 * protectTransport 输入中的 apiKey/headers 已由调用方选好，实现不得再从静态配置覆盖；
 * 返回新的 fetch，调用方后续必须只使用返回值。
 */
export interface ModelRequestSecurityPort extends ModelRequestObservationSource {
  protectTransport(input: {
    providerId: string;
    providerConfig: {
      access: RegistryProviderConfig["access"];
      baseURL: string;
      apiKey?: string;
      headers?: Record<string, string>;
    };
    transport: typeof globalThis.fetch;
  }): typeof globalThis.fetch;
}

/** 进程只共享可复用资源，每个模型执行器仍持有独立的请求状态。 */
export interface ModelRequestSecurityState {
  createExecution(options: { logger?: Logger }): ModelRequestSecurityPort;
}
